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
import { and, eq } from "drizzle-orm";
import type { Condition, ListenerView, TaskId } from "@/lib/types";
import type { EventInput } from "@/lib/events";
import { loadStudy, type ResolvedTrial } from "@/lib/config";
import { ensureMigrated, getDb } from "@/lib/db/client";
import { trials, sessions } from "@/lib/db/schema";
import {
  closeTrial,
  endSession,
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

export type ViewAs = "novice" | "expert";

// Dev-only representation toggle. HONORED ONLY OUTSIDE PRODUCTION so a real
// participant can never flip themselves from novice to expert (which would void
// the manipulation, §9.6). In prod builds NODE_ENV === "production" → ignored.
const DEV_TOGGLE_ALLOWED = process.env.NODE_ENV !== "production";

/** Override the LISTENER's keys for view rendering only. Gameplay is unaffected
 *  (legality/apply depend on position + viewpoint, never on familiarity). */
function withViewAs(cond: Condition, viewAs?: ViewAs): Condition {
  if (!viewAs || !DEV_TOGGLE_ALLOWED) return cond;
  const keys =
    viewAs === "expert"
      ? { ...cond.keys, sceneLabels: "all" as const, partsKey: true }
      : { ...cond.keys, sceneLabels: "none" as const, partsKey: false };
  return { ...cond, keys };
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

/** Re-render the current trial view without applying anything (used by the dev
 *  novice/expert toggle to preview a representation). */
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
  return buildPayload(args.sessionId, args.trialIndex, plan, row.state as any, rt.condition, {
    viewAs: args.viewAs,
  });
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
