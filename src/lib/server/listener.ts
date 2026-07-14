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
  endSession,
  insertUtterance,
  markParticipantCompleted,
  openTrial,
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

export interface SpeakerData {
  world: SpeakerBoard;
  partsKey: Record<string, string>;
  description: string;
  prompt: string;
  savedUtterance: string | null;
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

type AnyAction = { type: "move"; dir: string } | { type: "pick"; objectId: string };

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
  throw new Error(`Malformed action for task "${taskId}": ${JSON.stringify(raw)}`);
}

function sameAction(a: any, b: AnyAction): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "move") return a.dir === (b as any).dir;
  return a.objectId === (b as any).objectId;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function ready() {
  await ensureMigrated();
  loadBuiltinMaps();
}

async function loadPlan(sessionId: string): Promise<{ plan: SessionPlan; pid: string }> {
  const db = await getDb();
  const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId));
  if (!row) throw new Error(`Unknown session "${sessionId}"`);
  return { plan: row.plan as SessionPlan, pid: row.prolificPid };
}

export type ViewAs = "novice" | "expert" | "speaker";

// The speaker's brief. Config-driven per task later; a constant for retrieval now.
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
};

// Dev-only representation toggle. HONORED ONLY OUTSIDE PRODUCTION so a real
// participant can never flip themselves from novice to expert (which would void
// the manipulation, §9.6). In prod builds NODE_ENV === "production" → ignored.
const DEV_TOGGLE_ALLOWED = process.env.NODE_ENV !== "production";

/** Override the LISTENER's keys for view rendering only. Gameplay is unaffected
 *  (legality/apply depend on position + viewpoint, never on familiarity). */
function withViewAs(cond: Condition, viewAs?: ViewAs): Condition {
  if (!viewAs || !DEV_TOGGLE_ALLOWED) return cond;
  if (viewAs === "expert") return { ...cond, keys: { ...cond.keys, sceneLabels: "all", partsKey: true } };
  if (viewAs === "novice") return { ...cond, keys: { ...cond.keys, sceneLabels: "none", partsKey: false } };
  return cond; // "speaker" doesn't override listener keys
}

function buildPayload(
  sessionId: string,
  index: number,
  plan: SessionPlan,
  state: any,
  cond: Condition,
  opts: { rejected?: boolean; viewAs?: ViewAs } = {},
): TrialPayload {
  const task = getTask(cond.taskId);
  const terminal = task.isTerminal(state);
  const outcome =
    terminal && plan.showTrialFeedback
      ? { correct: task.outcome(state).correct, reason: task.outcome(state).reason }
      : null;
  return {
    sessionId,
    done: false,
    trialIndex: index,
    taskId: cond.taskId,
    missionNumber: index + 1,
    missionTotal: plan.trials.length,
    utterance: plan.trials[index]!.utterance,
    timeoutMs: cond.timeoutMs,
    // View rendered under the (optionally dev-overridden) familiarity.
    view: task.listenerView(state, withViewAs(cond, opts.viewAs)),
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

  const trialId = await openTrial({
    sessionId,
    trialIndex: index,
    taskId: cond.taskId,
    seed: cond.seed,
    condition: cond,
    utteranceText: rt.utterance,
    // scripted source: no speaker session yet. Study 2 replay (M4) fills this in.
    speakerSessionId: cond.speakerMode === "replay" ? cond.utteranceSource?.speakerSessionId ?? null : null,
    targetId: target,
    state,
  });
  void trialId;

  // Trial-scoped events, all tagged with trialIndex.
  await writeEvent({
    ev: "trial_start",
    sid: sessionId,
    trialIndex: index,
    taskId: cond.taskId,
    seed: cond.seed,
    cond: cond as unknown as Record<string, unknown>,
    utterance: rt.utterance,
  });
  // Identical log format across scripted/replay (§7): utterance_replayed.
  await writeEvent({
    ev: "utterance_replayed",
    sid: sessionId,
    trialIndex: index,
    text: rt.utterance,
    speakerSessionId:
      cond.speakerMode === "replay"
        ? cond.utteranceSource?.speakerSessionId ?? "unknown"
        : "scripted",
  });
  for (const e of adapter.onInit(state, sessionId)) {
    await writeEvent({ ...(e as EventInput), trialIndex: index } as EventInput);
  }

  return buildPayload(sessionId, index, plan, state, cond);
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function startListenerSession(args: {
  studyName: string;
  prolific: ProlificIdentity;
  userAgent?: string;
}): Promise<TrialPayload> {
  await ready();
  const study = loadStudy(args.studyName);
  if (study.role !== "listener") {
    throw new Error(`Study "${args.studyName}" is not a listener study (role=${study.role}).`);
  }

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
  await startSession({ id: sid, prolificPid: args.prolific.pid, role: "listener", plan });

  await writeEvent({
    ev: "session_start",
    sid,
    pid: args.prolific.pid,
    prolific: { studyId: args.prolific.studyId, sessionId: args.prolific.sessionId },
    role: "listener",
    cond: plan.trials[0]!.condition as unknown as Record<string, unknown>,
  });

  return openTrialAt(sid, 0, plan, args.prolific.pid);
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
  const partsPanel = (sv.keys as any[]).find((k) => k.id === "parts");
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

  return {
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
    description: brief.description,
    prompt: brief.prompt,
    savedUtterance: (prior[0] as any)?.text ?? null,
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
  const { plan } = await loadPlan(args.sessionId);
  const rt = plan.trials[args.trialIndex];
  if (!rt) throw new Error(`No trial ${args.trialIndex}`);
  const row = await loadTrialRow(args.sessionId, args.trialIndex);
  if (!row) throw new Error(`Trial ${args.trialIndex} not open`);

  const payload = buildPayload(args.sessionId, args.trialIndex, plan, row.state as any, rt.condition, {
    viewAs: args.viewAs,
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
  const { plan } = await loadPlan(args.sessionId);
  const rt = plan.trials[args.trialIndex];
  if (!rt) throw new Error(`No trial ${args.trialIndex} in session ${args.sessionId}`);
  const cond = rt.condition;
  const task = getTask(cond.taskId);
  const adapter = getAdapter(cond.taskId);

  const row = await loadTrialRow(args.sessionId, args.trialIndex);
  if (!row) throw new Error(`Trial ${args.trialIndex} not open`);
  const state = row.state as any;

  // Already terminal (or ended) → return current view, no change.
  if (row.endedAt || task.isTerminal(state)) {
    return buildPayload(args.sessionId, args.trialIndex, plan, state, cond, { viewAs: args.viewAs });
  }

  const action = decodeAction(cond.taskId, args.action);
  const legal = task.legalActions(state);
  if (!legal.some((a: any) => sameAction(a, action))) {
    // Illegal (e.g. walked into a wall, picked an object not in the room). No
    // budget spent, no event logged — matches "bumping a wall does nothing".
    return buildPayload(args.sessionId, args.trialIndex, plan, state, cond, {
      rejected: true,
      viewAs: args.viewAs,
    });
  }

  const next = task.apply(state, action);
  for (const e of adapter.onAction(action, state, next, args.sessionId)) {
    await writeEvent({ ...(e as EventInput), trialIndex: args.trialIndex } as EventInput);
  }
  await setTrialState(row.id, next);

  if (task.isTerminal(next)) {
    const o = task.outcome(next);
    await writeEvent({
      ev: "trial_end",
      sid: args.sessionId,
      trialIndex: args.trialIndex,
      correct: o.correct,
      cost: o.cost,
      chosen: o.chosenId,
      target: o.targetId,
      reason: o.reason,
    });
    await closeTrial({
      trialId: row.id,
      correct: o.correct,
      cost: o.cost,
      chosenId: o.chosenId,
      reason: o.reason,
    });
  }

  return buildPayload(args.sessionId, args.trialIndex, plan, next, cond, { viewAs: args.viewAs });
}

export async function timeoutListenerTrial(args: {
  sessionId: string;
  trialIndex: number;
}): Promise<TrialPayload> {
  await ready();
  const { plan } = await loadPlan(args.sessionId);
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
    await writeEvent({
      ev: "trial_end",
      sid: args.sessionId,
      trialIndex: args.trialIndex,
      correct: false,
      cost,
      chosen: null,
      target,
      reason: "timeout",
    });
    await closeTrial({
      trialId: row.id,
      correct: false,
      cost,
      chosenId: null,
      reason: "timeout",
    });
    // Reflect terminality in the stored state too.
    await setTrialState(row.id, { ...state, terminal: true, reason: "timeout" });
    return buildPayload(args.sessionId, args.trialIndex, plan, { ...state, terminal: true, reason: "timeout" }, cond);
  }
  return buildPayload(args.sessionId, args.trialIndex, plan, state, cond);
}

export async function advanceListenerTrial(sessionId: string): Promise<TrialPayload> {
  await ready();
  const { plan, pid } = await loadPlan(sessionId);
  // Next index = number of trial rows already opened.
  const db = await getDb();
  const rows = await db.select().from(trials).where(eq(trials.sessionId, sessionId));
  const nextIndex = rows.length;
  return openTrialAt(sessionId, nextIndex, plan, pid);
}
