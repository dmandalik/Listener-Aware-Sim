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
import { loadStudy, type ResolvedTrial } from "@/lib/config";
import { ensureMigrated, getDb } from "@/lib/db/client";
import { trials, sessions, utterances } from "@/lib/db/schema";
import {
  closeTrial,
  countAssignments,
  drawUtterance,
  endSession,
  insertUtterance,
  markParticipantCompleted,
  openTrial,
  recordUtteranceOutcome,
  setTrialState,
  startSession,
  upsertParticipant,
  writeEvent,
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
      "A helper robot has broken down inside this building and needs one part retrieved. " +
      "A person will go in to fetch it — but they can only see the room they are standing in, " +
      "they don't know the building's layout, and they don't know what any of the parts are. " +
      "You can see everything: the full map and the target part (highlighted). ",
    prompt:
      "Write ONE message that tells a completely new helper exactly how to find and pick up " +
      "the highlighted part. You get a single message — make it count.",
  },
  teleop: {
    description:
      "A person will drive this robot to the goal (marked below). But they CANNOT see the goal, " +
      "and the drive keys are mapped to arbitrary letters they don't know. You can see everything: " +
      "the full track, the goal, and which letter moves the robot which way. ",
    prompt:
      "Write ONE message that gets a new driver to the goal. You can spend it on the route, on the " +
      "key mapping, or both — but you only get a single message.",
  },
  repair: {
    description:
      "This robot has a fault: two parts must be connected. A technician will DRAG one part onto the " +
      "other — but they may not know what any part is called, and several parts look identical. You " +
      "can see the whole board with every part labelled, and the two parts to connect are wired together. ",
    prompt:
      "Write ONE message telling the technician exactly which two parts to connect. Watch out — several " +
      "parts look the same, so “the socket” won’t be enough; say which one.",
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
      const drawn = await drawUtterance(cond.taskId, cond.seed, cond.scene ?? "");
      if (!drawn) {
        // Fail loud (§15): a replay study with an empty pool is a setup error.
        throw new Error(
          `Utterance pool empty for (${cond.taskId}, seed ${cond.seed}, scene "${cond.scene ?? ""}"). ` +
            `Run the speaker study to populate it before serving replay listeners.`,
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
    seed: cond.seed,
    condition: cond,
    utteranceText,
    speakerSessionId,
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
  studyName: string;
  prolific: ProlificIdentity;
  userAgent?: string;
  assignment?: Assignment | null; // 'novice' | 'expert' when routed from /play
}): Promise<TrialPayload> {
  await ready();
  const study = loadStudy(args.studyName);
  if (study.role !== "listener") {
    throw new Error(`Study "${args.studyName}" is not a listener study (role=${study.role}).`);
  }
  const assignment = args.assignment ?? null;

  const sid = randomUUID();
  await upsertParticipant({
    prolificPid: args.prolific.pid,
    studyId: args.prolific.studyId,
    sessionId: args.prolific.sessionId,
    role: "listener",
    userAgent: args.userAgent,
    consentedAt: new Date(),
  });

  const plan: SessionPlan = {
    studyId: study.id,
    showTrialFeedback: study.showTrialFeedback,
    trials: study.trials,
  };
  await startSession({ id: sid, prolificPid: args.prolific.pid, role: "listener", plan, assignment });

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

  // Any utterance this session already saved for this (task, seed) trial.
  const db = await getDb();
  const prior = await db
    .select()
    .from(utterances)
    .where(
      and(
        eq(utterances.authorSessionId, sessionId),
        eq(utterances.taskId, cond.taskId),
        eq(utterances.seed, cond.seed),
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

  await insertUtterance({
    taskId: cond.taskId,
    seed: cond.seed,
    scene: cond.scene ?? "",
    text,
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
    });
    // Fold this outcome into the replayed utterance's aggregate success (§12 bonus).
    if (row.utteranceId != null) {
      await recordUtteranceOutcome(row.utteranceId, o.correct);
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
    });
    if (row.utteranceId != null) await recordUtteranceOutcome(row.utteranceId, false);
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
  studyName: string;
  prolific: ProlificIdentity;
  userAgent?: string;
  assignment?: Assignment | null;
}): Promise<SpeakerTrialPayload> {
  await ready();
  const study = loadStudy(args.studyName);
  if (study.role !== "speaker") {
    throw new Error(`Study "${args.studyName}" is not a speaker study (role=${study.role}).`);
  }
  const sid = randomUUID();
  await upsertParticipant({
    prolificPid: args.prolific.pid,
    studyId: args.prolific.studyId,
    sessionId: args.prolific.sessionId,
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

// ── Balanced role assignment (single entry: /play) ────────────────────────────

/**
 * Balanced randomization: assign to the least-filled cell, breaking ties at
 * random. Guarantees equal speaker/novice/expert counts once participants arrive
 * in multiples of three, while staying as random as balance allows.
 */
async function pickBalancedAssignment(): Promise<Assignment> {
  const counts = await countAssignments();
  const cells: Assignment[] = ["speaker", "novice", "expert"];
  const min = Math.min(...cells.map((c) => counts[c]));
  const candidates = cells.filter((c) => counts[c] === min);
  return candidates[Math.floor(Math.random() * candidates.length)]!;
}

export interface AssignResult {
  kind: "speaker" | "listener";
  assignment: Assignment;
  sessionId: string;
}

export async function assignAndStart(args: {
  prolific: ProlificIdentity;
  userAgent?: string;
}): Promise<AssignResult> {
  await ready();
  const assignment = await pickBalancedAssignment();
  if (assignment === "speaker") {
    const p = await startSpeakerSession({
      studyName: "main_speaker",
      prolific: args.prolific,
      userAgent: args.userAgent,
      assignment: "speaker",
    });
    return { kind: "speaker", assignment, sessionId: p.sessionId };
  }
  const p = await startListenerSession({
    studyName: "main_listener",
    prolific: args.prolific,
    userAgent: args.userAgent,
    assignment,
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
