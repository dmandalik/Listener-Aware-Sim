// ─────────────────────────────────────────────────────────────────────────────
// Listener session orchestration (server-side; §8 Study 2, §9.6 boundary).
//
// The server holds authoritative engine state (trials.state) and only ever emits
// the fog-filtered listenerView. It:
//   - starts a session from a study plan, opens trial 0
//   - applies a listener action (validate legality → apply → log events → persist)
//   - advances to the next trial, or completes the session
//   - ends a trial on timeout
//
// Every state transition is committed as it happens (§15). The full world/target
// live only in trials.state and never cross the wire.
// ─────────────────────────────────────────────────────────────────────────────

import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { Condition, ListenerView, TaskId } from "@/lib/types";
import type { EventInput } from "@/lib/events";
import {
  buildMainStudy,
  loadRecruitment,
  loadStudy,
  loadStudyPlan,
  roleForCompletions,
  type ResolvedStudy,
  type ResolvedTrial,
} from "@/lib/config";
import { ensureMigrated, getDb } from "@/lib/db/client";
import { trials, sessions, utterances } from "@/lib/db/schema";
import {
  closeTrial,
  countCompletedAssignments,
  countActiveAssignments,
  countUtterances,
  drawUtterance,
  endSession,
  upsertAuthorUtterance,
  markParticipantCompleted,
  openTrial,
  purgeIncompleteSessions,
  recordUtteranceOutcome,
  setTrialState,
  startSession,
  upsertParticipant,
  upsertSurvey,
  upsertTrialSurvey,
  writeEvent,
  type SurveyArgs,
} from "@/lib/db/writer";
import { getAdapter, getTask, loadBuiltinMaps } from "@/lib/engine";

export interface ProlificIdentity {
  pid: string;
  studyId: string;
  sessionId: string;
}

interface SessionPlan {
  studyId: string;
  showTrialFeedback: boolean;
  trials: ResolvedTrial[];
}

/** The speaker's board: the FULL world (no fog), target flagged. Speaker only. */
export interface SpeakerBoard {
  scene: string;
  cells: ("wall" | "floor" | "door")[][];
  roomOf: (string | null)[][];
  width: number;
  height: number;
  rooms: Record<string, string>;
  // Where the listener/helper will START on this map — shown to the speaker so they
  // can orient their directions ("from the entrance, go left…"). Listeners never
  // receive this field (it's on the speaker board only).
  startPos: [number, number];
  objects: Array<{
    id: string;
    symbol: string;
    pos: [number, number];
    part: string;
    isTarget: boolean;
  }>;
}

/** The speaker's teleop track: full grid WITH the goal (which the driver can't see). */
export interface TeleopSpeakerBoard {
  scene: string;
  cells: ("wall" | "floor")[][];
  width: number;
  height: number;
  start: [number, number];
  goal: [number, number];
  keypad: string[];
  landmarks: Array<{ name: string; icon: string; pos: [number, number] }>;
}

/** The speaker's repair board: every part labelled, the target connection flagged. */
export interface RepairSpeakerBoard {
  scene: string;
  viewBox: [number, number];
  connect: [string, string];
  components: Array<{ id: string; name: string; shape: string; color: string; pos: [number, number] }>;
}

export interface SpeakerData {
  taskId: TaskId;
  description: string;
  prompt: string;
  savedUtterance: string | null;
  // Exactly one of the following is populated, per task.
  retrieval?: { world: SpeakerBoard; partsKey: Record<string, string> };
  teleop?: { world: TeleopSpeakerBoard; controlMap: Record<string, string> };
  repair?: { world: RepairSpeakerBoard };
}

export interface TrialPayload {
  sessionId: string;
  done: boolean; // whole session finished
  trialIndex: number;
  taskId: TaskId;
  missionNumber: number; // 1-based
  missionTotal: number;
  utterance: string;
  timeoutMs: number;
  view: ListenerView | null;
  terminal: boolean;
  rejected?: boolean; // last action was illegal; view unchanged
  outcome: { correct: boolean; reason: string } | null; // only if terminal && feedback on
  speaker?: SpeakerData; // present only under the dev "Speaker" view
}

// ── Action decoding (task-specific) ──────────────────────────────────────────

type AnyAction =
  | { type: "move"; dir: string }
  | { type: "pick"; objectId: string }
  | { type: "key"; key: string }
  | { type: "connect"; from: string; to: string };

function decodeAction(taskId: TaskId, raw: unknown): AnyAction {
  const r = raw as any;
  if (taskId === "retrieval") {
    if (r?.type === "move" && ["up", "down", "left", "right"].includes(r.dir)) {
      return { type: "move", dir: r.dir };
    }
    if (r?.type === "pick" && typeof r.objectId === "string") {
      return { type: "pick", objectId: r.objectId };
    }
  }
  if (taskId === "teleop") {
    if (r?.type === "key" && typeof r.key === "string") {
      return { type: "key", key: r.key.toUpperCase() };
    }
  }
  if (taskId === "repair") {
    if (r?.type === "connect" && typeof r.from === "string" && typeof r.to === "string") {
      return { type: "connect", from: r.from, to: r.to };
    }
  }
  throw new Error(`Malformed action for task "${taskId}": ${JSON.stringify(raw)}`);
}

function sameAction(a: any, b: AnyAction): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "move") return a.dir === (b as any).dir;
  if (a.type === "key") return a.key === (b as any).key;
  if (a.type === "connect") return a.from === (b as any).from && a.to === (b as any).to;
  return a.objectId === (b as any).objectId;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function ready() {
  await ensureMigrated();
  loadBuiltinMaps();
}

/** Resolve a study by name. "main_speaker"/"main_listener" are assembled live from
 *  the layout registry (study-plan.json) so the toggle applies everywhere they're
 *  referenced; any other name is a static study file. */
function studyByName(name: string): ResolvedStudy {
  if (name === "main_speaker") return buildMainStudy("speaker");
  if (name === "main_listener") return buildMainStudy("listener");
  return loadStudy(name);
}

export type Assignment = "speaker" | "novice" | "expert";

async function loadPlan(
  sessionId: string,
): Promise<{ plan: SessionPlan; pid: string; assignment: Assignment | null }> {
  const db = await getDb();
  const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
  if (!row) throw new Error(`Unknown session "${sessionId}"`);
  return {
    plan: row.plan as SessionPlan,
    pid: row.prolificPid,
    assignment: (row.assignment as Assignment | null) ?? null,
  };
}

/** Lock the listener's familiarity to their assignment (ALWAYS applied, not dev). */
function withAssignment(cond: Condition, assignment: Assignment | null): Condition {
  if (assignment === "expert") return { ...cond, keys: { ...cond.keys, ...EXPERT_KEYS } };
  if (assignment === "novice") return { ...cond, keys: { ...cond.keys, ...NOVICE_KEYS } };
  return cond; // speaker / unassigned → condition's own keys
}

export type ViewAs = "novice" | "expert" | "speaker";

// The speaker's brief per task. Same STRUCTURE everywhere (description + prompt +
// compose box); the words and what's shown differ by task.
const SPEAKER_BRIEF: Record<string, { description: string; prompt: string }> = {
  retrieval: {
    description:
      "A helper robot has broken down in this building and needs one part brought to it. " +
      "The person who fetches it can only see the room they are standing in — they don't know " +
      "the layout, and they don't know what any part is. They move one tile at a time using the " +
      "arrow keys or WASD, and click a part to pick it up. You can see everything: the full map, " +
      "with the target part highlighted.",
    prompt:
      "Write ONE message telling this helper how to find and pick up the highlighted part. " +
      "You get a single message — make it count.",
  },
  teleop: {
    description:
      "Someone will drive this robot to the goal (highlighted below). They drive by pressing keys on " +
      "their keyboard — one step per press — but they cannot see the goal, and the drive keys are random " +
      "letters they don't know. You can see everything: the whole grid, the goal, and which letter moves " +
      "the robot which way.",
    prompt:
      "Write ONE message that gets the driver to the goal. Let your instructions contain the route, the keys, or both " +
      "— but you only get a single message.",
  },
  repair: {
    description:
      "This robot has a fault: two of its parts must be connected. A technician will connect them by " +
      "dragging one part on top of the other with the mouse, but several parts look identical and they " +
      "may not know the names. You can see the whole board with every part labelled, and the two to " +
      "connect are highlighted.",
    prompt:
      "Write ONE message telling the technician exactly which two parts to connect. Several parts look alike, " +
      "so be specific.",
  },
};

// Dev-only representation toggle. HONORED ONLY OUTSIDE PRODUCTION so a real
// participant can never flip themselves from novice to expert (which would void
// the manipulation, §9.6). In prod builds NODE_ENV === "production" → ignored.
const DEV_TOGGLE_ALLOWED = process.env.NODE_ENV !== "production";

/** Override the LISTENER's keys for view rendering only. Gameplay is unaffected
 *  (legality/apply depend on position + viewpoint, never on familiarity). */
// novice/expert familiarity spans all three key types (scene labels, parts key,
// control key) so the distinction is meaningful for every task.
const EXPERT_KEYS = { sceneLabels: "all", partsKey: true, controlKey: true } as const;
const NOVICE_KEYS = { sceneLabels: "current", partsKey: false, controlKey: false } as const;

function withViewAs(cond: Condition, viewAs?: ViewAs): Condition {
  if (!viewAs || !DEV_TOGGLE_ALLOWED) return cond;
  if (viewAs === "expert") return { ...cond, keys: { ...cond.keys, ...EXPERT_KEYS } };
  if (viewAs === "novice") return { ...cond, keys: { ...cond.keys, ...NOVICE_KEYS } };
  return cond; // "speaker" doesn't override listener keys
}

function buildPayload(
  sessionId: string,
  index: number,
  plan: SessionPlan,
  state: any,
  cond: Condition,
  opts: {
    rejected?: boolean;
    viewAs?: ViewAs;
    utterance?: string;
    assignment?: Assignment | null;
  } = {},
): TrialPayload {
  const task = getTask(cond.taskId);
  const terminal = task.isTerminal(state);
  const outcome =
    terminal && plan.showTrialFeedback
      ? { correct: task.outcome(state).correct, reason: task.outcome(state).reason }
      : null;
  // Assignment locks familiarity; the dev viewAs toggle overrides on top (dev only).
  const viewCond = withViewAs(withAssignment(cond, opts.assignment ?? null), opts.viewAs);
  return {
    sessionId,
    done: false,
    trialIndex: index,
    taskId: cond.taskId,
    missionNumber: index + 1,
    missionTotal: plan.trials.length,
    // The served utterance (pool-drawn for replay), falling back to the plan text.
    utterance: opts.utterance ?? plan.trials[index]!.utterance,
    timeoutMs: cond.timeoutMs,
    // View rendered under the assignment-locked (and optionally dev-overridden) keys.
    view: task.listenerView(state, viewCond),
    terminal,
    rejected: opts.rejected,
    outcome,
  };
}

/** Open trial `index`, log its start events, persist state, return the payload. */
async function openTrialAt(
  sessionId: string,
  index: number,
  plan: SessionPlan,
  pid: string,
  assignment: Assignment | null,
): Promise<TrialPayload> {
  const rt = plan.trials[index];
  if (!rt) {
    // No more trials — session complete.
    await endSession(sessionId, "completed");
    await markParticipantCompleted(pid);
    return {
      sessionId,
      done: true,
      trialIndex: index,
      taskId: "retrieval",
      missionNumber: index,
      missionTotal: plan.trials.length,
      utterance: "",
      timeoutMs: 0,
      view: null,
      terminal: true,
      outcome: null,
    };
  }

  const cond = rt.condition;
  const task = getTask(cond.taskId);
  const adapter = getAdapter(cond.taskId);
  const state = task.init(cond.seed, cond);
  const target = (state as any).world?.target ?? null;

  // Resolve the utterance served to this listener.
  //   scripted → the fixed config text
  //   replay   → pinned text if given, else DRAW from the speaker pool (§8)
  let utteranceText = rt.utterance;
  let speakerSessionId: string | null = null;
  let speakerPid: string | undefined;
  let utteranceId: number | null = null;

  if (cond.speakerMode === "replay") {
    if (cond.utteranceSource?.text) {
      utteranceText = cond.utteranceSource.text;
      speakerSessionId = cond.utteranceSource.speakerSessionId ?? "pinned";
    } else {
      // Which listener condition is drawing (for the distinct-per-condition pool).
      // The assignment is authoritative; fall back to the condition's own keys.
      const drawCond: "novice" | "expert" =
        assignment === "expert" || assignment === "novice"
          ? assignment
          : cond.keys.partsKey
            ? "expert"
            : "novice";
      const drawn = await drawUtterance(cond.taskId, cond.seed, cond.scene ?? "", drawCond);
      if (!drawn) {
        // Fail loud (§15): a replay study with an empty pool is a setup error.
        throw new Error(
          `Utterance pool empty for (${cond.taskId}, seed ${cond.seed}, scene "${cond.scene ?? ""}"). ` +
            `Recruit speakers to populate it before serving replay listeners.`,
        );
      }
      utteranceText = drawn.text;
      speakerSessionId = drawn.authorSessionId;
      speakerPid = drawn.authorPid ?? undefined;
      utteranceId = drawn.id;
    }
  }

  await openTrial({
    sessionId,
    trialIndex: index,
    taskId: cond.taskId,
    scene: cond.scene ?? null,
    layout: cond.layout ?? null,
    assignment,
    seed: cond.seed,
    condition: cond,
    utteranceText,
    speakerSessionId,
    speakerPid: speakerPid ?? null,
    utteranceId,
    targetId: target,
    state,
  });

  await writeEvent({
    ev: "trial_start",
    sid: sessionId,
    trialIndex: index,
    taskId: cond.taskId,
    seed: cond.seed,
    cond: cond as unknown as Record<string, unknown>,
    utterance: utteranceText,
  });
  // Identical log format across scripted/replay (§7): utterance_replayed. Replay
  // carries the real authoring session (traceability, §8); scripted marks its source.
  await writeEvent({
    ev: "utterance_replayed",
    sid: sessionId,
    trialIndex: index,
    text: utteranceText,
    speakerSessionId: speakerSessionId ?? "scripted",
    ...(speakerPid ? { speakerPid } : {}),
  });
  for (const e of adapter.onInit(state, sessionId)) {
    await writeEvent({ ...(e as EventInput), trialIndex: index } as EventInput);
  }

  return buildPayload(sessionId, index, plan, state, cond, { utterance: utteranceText, assignment });
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function startListenerSession(args: {
  studyName?: string;
  study?: ResolvedStudy; // pre-assembled plan (e.g. from buildMainStudy) — wins over studyName
  prolific: ProlificIdentity;
  userAgent?: string;
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  dataSharingConsent?: boolean | null;
  assignment?: Assignment | null; // 'novice' | 'expert' when routed from /play
  variant?: "single" | "multi" | null;
}): Promise<TrialPayload> {
  await ready();
  const study = args.study ?? studyByName(args.studyName ?? "listener_pilot");
  if (study.role !== "listener") {
    throw new Error(`Study "${study.id}" is not a listener study (role=${study.role}).`);
  }
  const assignment = args.assignment ?? null;

  // A listener may only play a task that already has speaker utterances to replay
  // (§8: speakers are recruited first). Drop any replay task whose pool is still
  // empty, so each listener does exactly the tasks that are ready — one trial each,
  // never the same task repeated.
  const eligible: ResolvedTrial[] = [];
  for (const rt of study.trials) {
    const c = rt.condition;
    const needsPool = c.speakerMode === "replay" && !c.utteranceSource?.text;
    if (needsPool && (await countUtterances(c.taskId, c.seed, c.scene ?? "")) === 0) continue;
    eligible.push(rt);
  }
  if (eligible.length === 0) {
    throw new Error(
      "No tasks are ready yet: the speaker utterance pool is empty for every task. " +
        "Recruit speakers to author utterances before serving listeners.",
    );
  }

  const sid = randomUUID();
  await upsertParticipant({
    prolificPid: args.prolific.pid,
    studyId: args.prolific.studyId,
    sessionId: args.prolific.sessionId,
    name: args.name,
    firstName: args.firstName,
    lastName: args.lastName,
    email: args.email,
    dataSharingConsent: args.dataSharingConsent,
    role: "listener",
    userAgent: args.userAgent,
    consentedAt: new Date(),
  });

  const plan: SessionPlan = {
    studyId: study.id,
    showTrialFeedback: study.showTrialFeedback,
    trials: eligible,
  };
  await startSession({ id: sid, prolificPid: args.prolific.pid, role: "listener", plan, assignment, variant: args.variant ?? null });

  await writeEvent({
    ev: "session_start",
    sid,
    pid: args.prolific.pid,
    prolific: { studyId: args.prolific.studyId, sessionId: args.prolific.sessionId },
    role: "listener",
    cond: plan.trials[0]!.condition as unknown as Record<string, unknown>,
  });

  return openTrialAt(sid, 0, plan, args.prolific.pid, assignment);
}

async function loadTrialRow(sessionId: string, index: number) {
  const db = await getDb();
  const [row] = await db
    .select()
    .from(trials)
    .where(and(eq(trials.sessionId, sessionId), eq(trials.trialIndex, index)));
  return row;
}

/** Build the speaker's full-world board for a trial (dev speaker view / M4 seed). */
async function buildSpeakerData(
  sessionId: string,
  cond: Condition,
  state: any,
): Promise<SpeakerData> {
  const task = getTask(cond.taskId);
  const sv = task.speakerView(state) as any;
  const w = sv.world;
  const brief = SPEAKER_BRIEF[cond.taskId] ?? { description: "", prompt: "" };

  // Any utterance this session already saved for THIS exact layout. Scoped by
  // scene as well as (task, seed): sibling layouts of the same task can share a
  // seed (e.g. all repair layouts use seed 1), so without scene the box would
  // prefill with the previous layout's text instead of starting blank.
  const db = await getDb();
  const prior = await db
    .select()
    .from(utterances)
    .where(
      and(
        eq(utterances.authorSessionId, sessionId),
        eq(utterances.taskId, cond.taskId),
        eq(utterances.seed, cond.seed),
        eq(utterances.scene, cond.scene ?? ""),
      ),
    )
    .orderBy(desc(utterances.id));

  const base = {
    taskId: cond.taskId,
    description: brief.description,
    prompt: brief.prompt,
    savedUtterance: (prior[0] as any)?.text ?? null,
  };

  if (cond.taskId === "repair") {
    return {
      ...base,
      repair: {
        world: {
          scene: w.scene,
          viewBox: w.viewBox,
          connect: w.connect,
          components: (w.components as any[]).map((c) => ({
            id: c.id,
            name: c.name,
            shape: c.shape,
            color: c.color,
            pos: c.pos,
          })),
        },
      },
    };
  }

  if (cond.taskId === "teleop") {
    return {
      ...base,
      teleop: {
        world: {
          scene: w.scene,
          cells: w.cells,
          width: w.width,
          height: w.height,
          start: w.start,
          goal: w.goal, // speaker CAN see the goal
          keypad: w.keypad,
          landmarks: w.landmarks,
        },
        controlMap: w.controlMap,
      },
    };
  }

  // retrieval (default)
  const partsPanel = (sv.keys as any[]).find((k) => k.id === "parts");
  return {
    ...base,
    retrieval: {
      world: {
        scene: w.scene,
        cells: w.geom.cells,
        roomOf: w.geom.roomOf,
        width: w.geom.width,
        height: w.geom.height,
        rooms: w.rooms,
        // The speaker's board is built from a fresh init state (they never move),
        // so state.pos is exactly the helper's starting cell.
        startPos: (state as any).pos as [number, number],
        objects: (w.objects as any[]).map((o) => ({
          id: o.id,
          symbol: o.symbol,
          pos: o.pos,
          part: o.part,
          isTarget: o.id === w.target,
        })),
      },
      partsKey: partsPanel?.entries ?? {},
    },
  };
}

/** Re-render the current trial view without applying anything (used by the dev
 *  novice/expert/speaker toggle to preview a representation). */
export async function viewListenerTrial(args: {
  sessionId: string;
  trialIndex: number;
  viewAs?: ViewAs;
}): Promise<TrialPayload> {
  await ready();
  const { plan, assignment } = await loadPlan(args.sessionId);
  const rt = plan.trials[args.trialIndex];
  if (!rt) throw new Error(`No trial ${args.trialIndex}`);
  const row = await loadTrialRow(args.sessionId, args.trialIndex);
  if (!row) throw new Error(`Trial ${args.trialIndex} not open`);

  const payload = buildPayload(args.sessionId, args.trialIndex, plan, row.state as any, rt.condition, {
    viewAs: args.viewAs,
    utterance: row.utteranceText ?? undefined,
    assignment,
  });

  // The Speaker view reveals the full world — dev-gated (off in production, §9.6).
  if (args.viewAs === "speaker" && DEV_TOGGLE_ALLOWED) {
    payload.speaker = await buildSpeakerData(args.sessionId, rt.condition, row.state as any);
  }
  return payload;
}

/** Persist a speaker's utterance to the pool (§8, §12). */
export async function saveSpeakerUtterance(args: {
  sessionId: string;
  trialIndex: number;
  text: string;
  composeMs?: number;
}): Promise<{ savedUtterance: string }> {
  await ready();
  const text = (args.text ?? "").trim();
  if (!text) throw new Error("Utterance is empty");
  const { plan, pid } = await loadPlan(args.sessionId);
  const rt = plan.trials[args.trialIndex];
  if (!rt) throw new Error(`No trial ${args.trialIndex}`);
  const cond = rt.condition;

  await upsertAuthorUtterance({
    taskId: cond.taskId,
    seed: cond.seed,
    scene: cond.scene ?? "",
    layout: cond.layout ?? null,
    text,
    composeMs: typeof args.composeMs === "number" ? Math.max(0, Math.round(args.composeMs)) : null,
    authorSessionId: args.sessionId,
    authorPid: pid,
  });
  await writeEvent({
    ev: "utterance_sent",
    sid: args.sessionId,
    trialIndex: args.trialIndex,
    text,
    composeMs: args.composeMs ?? 0,
  });
  return { savedUtterance: text };
}

export async function applyListenerAction(args: {
  sessionId: string;
  trialIndex: number;
  action: unknown;
  viewAs?: ViewAs;
}): Promise<TrialPayload> {
  await ready();
  const { plan, assignment } = await loadPlan(args.sessionId);
  const rt = plan.trials[args.trialIndex];
  if (!rt) throw new Error(`No trial ${args.trialIndex} in session ${args.sessionId}`);
  const cond = rt.condition;
  const task = getTask(cond.taskId);
  const adapter = getAdapter(cond.taskId);

  const row = await loadTrialRow(args.sessionId, args.trialIndex);
  if (!row) throw new Error(`Trial ${args.trialIndex} not open`);
  const state = row.state as any;

  const utterance = row.utteranceText ?? undefined;

  // Already terminal (or ended) → return current view, no change.
  if (row.endedAt || task.isTerminal(state)) {
    return buildPayload(args.sessionId, args.trialIndex, plan, state, cond, { viewAs: args.viewAs, utterance, assignment });
  }

  const action = decodeAction(cond.taskId, args.action);
  const legal = task.legalActions(state);
  if (!legal.some((a: any) => sameAction(a, action))) {
    // Illegal (e.g. walked into a wall, picked an object not in the room). No
    // budget spent, no event logged — matches "bumping a wall does nothing".
    return buildPayload(args.sessionId, args.trialIndex, plan, state, cond, {
      rejected: true,
      viewAs: args.viewAs,
      utterance,
      assignment,
    });
  }

  const next = task.apply(state, action);
  for (const e of adapter.onAction(action, state, next, args.sessionId)) {
    await writeEvent({ ...(e as EventInput), trialIndex: args.trialIndex } as EventInput);
  }
  await setTrialState(row.id, next);

  if (task.isTerminal(next)) {
    const o = task.outcome(next);
    const durationMs = row.startedAt ? Date.now() - new Date(row.startedAt).getTime() : undefined;
    await writeEvent({
      ev: "trial_end",
      sid: args.sessionId,
      trialIndex: args.trialIndex,
      correct: o.correct,
      cost: o.cost,
      chosen: o.chosenId,
      target: o.targetId,
      reason: o.reason,
      ...(durationMs != null ? { durationMs } : {}),
    });
    await closeTrial({
      trialId: row.id,
      correct: o.correct,
      cost: o.cost,
      chosenId: o.chosenId,
      reason: o.reason,
      durationMs,
    });
    // Fold this outcome into the replayed utterance's aggregates (§12 bonus, and
    // the per-condition completed count that balances the pool).
    if (row.utteranceId != null) {
      await recordUtteranceOutcome(row.utteranceId, o.correct, assignment === "speaker" ? null : assignment);
    }
  }

  return buildPayload(args.sessionId, args.trialIndex, plan, next, cond, { viewAs: args.viewAs, utterance, assignment });
}

export async function timeoutListenerTrial(args: {
  sessionId: string;
  trialIndex: number;
}): Promise<TrialPayload> {
  await ready();
  const { plan, assignment } = await loadPlan(args.sessionId);
  const rt = plan.trials[args.trialIndex];
  if (!rt) throw new Error(`No trial ${args.trialIndex}`);
  const cond = rt.condition;
  const task = getTask(cond.taskId);

  const row = await loadTrialRow(args.sessionId, args.trialIndex);
  if (!row) throw new Error(`Trial ${args.trialIndex} not open`);
  const state = row.state as any;

  if (!row.endedAt && !task.isTerminal(state)) {
    const cost = state.cost ?? 0;
    const target = state.world?.target ?? "";
    const durationMs = row.startedAt ? Date.now() - new Date(row.startedAt).getTime() : undefined;
    await writeEvent({
      ev: "trial_end",
      sid: args.sessionId,
      trialIndex: args.trialIndex,
      correct: false,
      cost,
      chosen: null,
      target,
      reason: "timeout",
      ...(durationMs != null ? { durationMs } : {}),
    });
    await closeTrial({
      trialId: row.id,
      correct: false,
      cost,
      chosenId: null,
      reason: "timeout",
      durationMs,
    });
    if (row.utteranceId != null) {
      await recordUtteranceOutcome(row.utteranceId, false, assignment === "speaker" ? null : assignment);
    }
    // Reflect terminality in the stored state too.
    await setTrialState(row.id, { ...state, terminal: true, reason: "timeout" });
    return buildPayload(args.sessionId, args.trialIndex, plan, { ...state, terminal: true, reason: "timeout" }, cond, {
      utterance: row.utteranceText ?? undefined,
      assignment,
    });
  }
  return buildPayload(args.sessionId, args.trialIndex, plan, state, cond, {
    utterance: row.utteranceText ?? undefined,
    assignment,
  });
}

export async function advanceListenerTrial(sessionId: string): Promise<TrialPayload> {
  await ready();
  const { plan, pid, assignment } = await loadPlan(sessionId);
  // Next index = number of trial rows already opened.
  const db = await getDb();
  const rows = await db.select().from(trials).where(eq(trials.sessionId, sessionId));
  const nextIndex = rows.length;
  return openTrialAt(sessionId, nextIndex, plan, pid, assignment);
}

// ── Speaker study (§8 Study 1: write utterances to the pool) ──────────────────

export interface SpeakerTrialPayload {
  sessionId: string;
  done: boolean;
  trialIndex: number;
  missionNumber: number;
  missionTotal: number;
  speaker: SpeakerData | null;
}

async function openSpeakerTrialAt(
  sessionId: string,
  index: number,
  plan: SessionPlan,
  pid: string,
): Promise<SpeakerTrialPayload> {
  const rt = plan.trials[index];
  if (!rt) {
    await endSession(sessionId, "completed");
    await markParticipantCompleted(pid);
    return {
      sessionId,
      done: true,
      trialIndex: index,
      missionNumber: index,
      missionTotal: plan.trials.length,
      speaker: null,
    };
  }
  const cond = rt.condition;
  const task = getTask(cond.taskId);
  const state = task.init(cond.seed, cond);

  await openTrial({
    sessionId,
    trialIndex: index,
    taskId: cond.taskId,
    scene: cond.scene ?? null,
    layout: cond.layout ?? null,
    assignment: "speaker",
    seed: cond.seed,
    condition: cond,
    targetId: (state as any).world?.target ?? null,
    state,
  });
  await writeEvent({
    ev: "trial_start",
    sid: sessionId,
    trialIndex: index,
    taskId: cond.taskId,
    seed: cond.seed,
    cond: cond as unknown as Record<string, unknown>,
    utterance: "", // authored below by the speaker
  });
  await writeEvent({
    ev: "speaker_briefed",
    sid: sessionId,
    trialIndex: index,
    briefing: cond.speakerBriefing,
  });

  return {
    sessionId,
    done: false,
    trialIndex: index,
    missionNumber: index + 1,
    missionTotal: plan.trials.length,
    speaker: await buildSpeakerData(sessionId, cond, state),
  };
}

export async function startSpeakerSession(args: {
  studyName?: string;
  study?: ResolvedStudy; // pre-assembled plan (e.g. from buildMainStudy) — wins over studyName
  prolific: ProlificIdentity;
  userAgent?: string;
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  dataSharingConsent?: boolean | null;
  assignment?: Assignment | null;
  variant?: "single" | "multi" | null;
}): Promise<SpeakerTrialPayload> {
  await ready();
  const study = args.study ?? studyByName(args.studyName ?? "speaker_pilot");
  if (study.role !== "speaker") {
    throw new Error(`Study "${study.id}" is not a speaker study (role=${study.role}).`);
  }
  const sid = randomUUID();
  await upsertParticipant({
    prolificPid: args.prolific.pid,
    studyId: args.prolific.studyId,
    sessionId: args.prolific.sessionId,
    name: args.name,
    firstName: args.firstName,
    lastName: args.lastName,
    email: args.email,
    dataSharingConsent: args.dataSharingConsent,
    role: "speaker",
    userAgent: args.userAgent,
    consentedAt: new Date(),
  });
  const plan: SessionPlan = {
    studyId: study.id,
    showTrialFeedback: study.showTrialFeedback,
    trials: study.trials,
  };
  await startSession({
    id: sid,
    prolificPid: args.prolific.pid,
    role: "speaker",
    plan,
    assignment: args.assignment ?? "speaker",
    variant: args.variant ?? null,
  });
  await writeEvent({
    ev: "session_start",
    sid,
    pid: args.prolific.pid,
    prolific: { studyId: args.prolific.studyId, sessionId: args.prolific.sessionId },
    role: "speaker",
    cond: plan.trials[0]!.condition as unknown as Record<string, unknown>,
  });
  return openSpeakerTrialAt(sid, 0, plan, args.prolific.pid);
}

export async function advanceSpeakerTrial(sessionId: string): Promise<SpeakerTrialPayload> {
  await ready();
  const { plan, pid } = await loadPlan(sessionId);
  const db = await getDb();
  const rows = await db.select().from(trials).where(eq(trials.sessionId, sessionId));
  return openSpeakerTrialAt(sessionId, rows.length, plan, pid);
}

/** Navigate the speaker to a specific scene index — forwards to the next scene OR
 *  BACK to an earlier one so they can review/edit an utterance they already wrote.
 *  A scene already opened is re-rendered from its stored state (no second insert —
 *  the unique (session, index) index would reject one — and no duplicate trial_start
 *  event); a brand-new index is opened normally. Going past the last scene finishes
 *  the session. The speaker's saved text for the scene prefills the compose box (it
 *  lives in the utterance pool, scoped by scene). */
export async function goToSpeakerTrial(
  sessionId: string,
  index: number,
): Promise<SpeakerTrialPayload> {
  await ready();
  const { plan, pid } = await loadPlan(sessionId);
  if (index >= plan.trials.length) {
    // Past the end → finish (openSpeakerTrialAt returns the done payload + ends it).
    return openSpeakerTrialAt(sessionId, index, plan, pid);
  }
  const idx = Math.max(0, index);
  const existing = await loadTrialRow(sessionId, idx);
  if (!existing) {
    // Never opened (advancing into new territory) — open it for the first time.
    return openSpeakerTrialAt(sessionId, idx, plan, pid);
  }
  // Revisiting a scene already opened — rebuild its payload from stored state.
  const cond = plan.trials[idx]!.condition;
  return {
    sessionId,
    done: false,
    trialIndex: idx,
    missionNumber: idx + 1,
    missionTotal: plan.trials.length,
    speaker: await buildSpeakerData(sessionId, cond, existing.state),
  };
}

// ── Balanced role assignment (single entry: /play) ────────────────────────────

/**
 * The next role, per the recruitment policy (src/config/recruitment.json). Based on
 * how many of each role have actually COMPLETED, so the study keeps recruiting a role
 * until its quota is genuinely filled — robust to abandonment and purging. With the
 * default batches this recruits all speakers to completion before any listener.
 */
async function pickAssignment(): Promise<Assignment> {
  const [completed, active] = await Promise.all([
    countCompletedAssignments(),
    countActiveAssignments(),
  ]);
  return roleForCompletions(loadRecruitment(), completed, active);
}

export interface AssignResult {
  kind: "speaker" | "listener";
  assignment: Assignment;
  sessionId: string;
}

export async function assignAndStart(args: {
  prolific: ProlificIdentity;
  userAgent?: string;
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  dataSharingConsent?: boolean | null;
}): Promise<AssignResult> {
  await ready();
  // Keep the database complete-only: before assigning, sweep away runs that were
  // abandoned before finishing their games AND have been idle for 2h. Idleness is
  // measured from the last event, so a slow-but-active participant is never touched,
  // and their freed slot is refilled by this very assignment. Best-effort — a purge
  // failure must never block a new participant from starting.
  try {
    await purgeIncompleteSessions(120);
  } catch {
    /* non-fatal: proceed with assignment */
  }
  const assignment = await pickAssignment();
  // The main study is assembled from the layout registry (study-plan.json), so the
  // single `layoutsPerTask` toggle switches everyone between the 3-trial and the
  // N-layout flow — speakers and listeners always from the same registry. The run's
  // variant is tagged on the session so the two modes stay separable in the data.
  const variant: "single" | "multi" = loadStudyPlan().layoutsPerTask > 1 ? "multi" : "single";
  const common = {
    userAgent: args.userAgent,
    name: args.name,
    firstName: args.firstName,
    lastName: args.lastName,
    email: args.email,
    dataSharingConsent: args.dataSharingConsent,
    variant,
  };
  if (assignment === "speaker") {
    const p = await startSpeakerSession({
      study: buildMainStudy("speaker"),
      prolific: args.prolific,
      assignment: "speaker",
      ...common,
    });
    return { kind: "speaker", assignment, sessionId: p.sessionId };
  }
  const p = await startListenerSession({
    study: buildMainStudy("listener"),
    prolific: args.prolific,
    assignment,
    ...common,
  });
  return { kind: "listener", assignment, sessionId: p.sessionId };
}

/** Resume a listener session at its active (open) trial — refresh-safe. */
export async function resumeListenerSession(sessionId: string): Promise<TrialPayload> {
  await ready();
  const { plan, assignment } = await loadPlan(sessionId);
  const db = await getDb();
  const rows = (await db.select().from(trials).where(eq(trials.sessionId, sessionId))) as any[];
  const active = rows.find((r) => !r.endedAt);
  if (!active) return advanceListenerTrial(sessionId); // opens next, or returns done
  return buildPayload(sessionId, active.trialIndex, plan, active.state, plan.trials[active.trialIndex]!.condition, {
    utterance: active.utteranceText ?? undefined,
    assignment,
  });
}

/** Resume a speaker session at its latest opened scene. */
export async function resumeSpeakerSession(sessionId: string): Promise<SpeakerTrialPayload> {
  await ready();
  const { plan } = await loadPlan(sessionId);
  const db = await getDb();
  const rows = (await db.select().from(trials).where(eq(trials.sessionId, sessionId))) as any[];
  if (!rows.length) throw new Error(`Speaker session ${sessionId} has no open scene`);
  const row = rows.reduce((a, b) => (b.trialIndex > a.trialIndex ? b : a));
  const cond = plan.trials[row.trialIndex]!.condition;
  return {
    sessionId,
    done: false,
    trialIndex: row.trialIndex,
    missionNumber: row.trialIndex + 1,
    missionTotal: plan.trials.length,
    speaker: await buildSpeakerData(sessionId, cond, row.state),
  };
}

// ── End-of-study survey ───────────────────────────────────────────────────────

/** Save a session's end-of-study survey. Fills in pid + role from the session so
 *  the client only sends the answers. */
export async function saveSurvey(
  args: { sessionId: string } & Omit<SurveyArgs, "sessionId" | "prolificPid" | "role">,
): Promise<void> {
  await ready();
  const db = await getDb();
  const [sess] = await db.select().from(sessions).where(eq(sessions.id, args.sessionId));
  if (!sess) throw new Error(`Unknown session "${args.sessionId}"`);
  const role = (sess.assignment as "speaker" | "novice" | "expert" | null) ?? null;
  await upsertSurvey({ ...args, prolificPid: sess.prolificPid, role });
}

/** Save the NASA-TLX workload rating for ONE trial. Denormalizes the trial's task /
 *  layout / scene / utterance from the trial row so the TLX export is analyzable on
 *  its own. `feedback` is only sent with the final trial and lands on the session's
 *  survey row. */
export async function saveTrialSurvey(args: {
  sessionId: string;
  trialIndex: number;
  tlxMental: number;
  tlxPhysical: number;
  tlxTemporal: number;
  tlxPerformance: number;
  tlxEffort: number;
  tlxFrustration: number;
  feedback?: string | null;
}): Promise<void> {
  await ready();
  const db = await getDb();
  const [sess] = await db.select().from(sessions).where(eq(sessions.id, args.sessionId));
  if (!sess) throw new Error(`Unknown session "${args.sessionId}"`);
  const row = await loadTrialRow(args.sessionId, args.trialIndex);
  await upsertTrialSurvey({
    sessionId: args.sessionId,
    trialIndex: args.trialIndex,
    prolificPid: sess.prolificPid,
    assignment: (sess.assignment as "speaker" | "novice" | "expert" | null) ?? null,
    taskId: (row?.taskId as "retrieval" | "repair" | "teleop" | undefined) ?? null,
    layout: row?.layout ?? null,
    scene: row?.scene ?? null,
    utteranceId: row?.utteranceId ?? null,
    speakerPid: row?.speakerPid ?? null,
    tlxMental: args.tlxMental,
    tlxPhysical: args.tlxPhysical,
    tlxTemporal: args.tlxTemporal,
    tlxPerformance: args.tlxPerformance,
    tlxEffort: args.tlxEffort,
    tlxFrustration: args.tlxFrustration,
  });
  // Open-ended feedback is asked once, on the final trial → session survey row.
  if (args.feedback != null && args.feedback !== "") {
    await upsertSurvey({
      sessionId: args.sessionId,
      prolificPid: sess.prolificPid,
      role: (sess.assignment as "speaker" | "novice" | "expert" | null) ?? null,
      feedback: args.feedback,
    });
  }
}
