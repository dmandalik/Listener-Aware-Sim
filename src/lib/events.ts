// ─────────────────────────────────────────────────────────────────────────────
// Fetch Games — event log schema (§10)
//
// "The event log is the product." Versioned, append-only, one row per event.
// This is the scientific record — `events` is never overwritten, never deleted.
//
// ⚠️  PENDING SIGN-OFF (§16): the prompt says to tighten this and confirm before
//     finalizing. This is v1. Do not run paid participants until it's approved.
//
// Design rules encoded here:
//   - Every event carries { v, t, ev, sid }. session_start additionally carries
//     the full Prolific identity; downstream events reference it by `sid`.
//   - Discriminated union on `ev`, validated with zod so a malformed event fails
//     loudly at the write boundary rather than silently corrupting the record.
//   - Timestamps (`t`) are epoch milliseconds, stamped by the writer.
// ─────────────────────────────────────────────────────────────────────────────

import { z } from "zod";

/** Bump when the shape changes in a non-additive way. */
export const EVENT_SCHEMA_VERSION = 1 as const;

const zRole = z.enum(["speaker", "listener"]);

const zProlific = z.object({
  studyId: z.string(),
  sessionId: z.string(),
});

// The condition is logged verbatim on session_start (see types.ts / config.ts).
// Kept as a passthrough object here so the event schema doesn't have to be bumped
// every time a task adds a condition field; the canonical validator is in config.ts.
const zConditionSnapshot = z.record(z.string(), z.unknown());

/** Fields on EVERY event. */
const zEventBase = z.object({
  v: z.literal(EVENT_SCHEMA_VERSION),
  /** epoch ms, stamped by the writer. */
  t: z.number().int().nonnegative(),
  /** session id — the join key for everything after session_start. */
  sid: z.string().min(1),
  /**
   * 0-based trial within the session. Present on trial-scoped events so the
   * firehose segments cleanly per trial in a multi-trial session. Absent on
   * session-level events (session_start). (Additive to v1.)
   */
  trialIndex: z.number().int().nonnegative().optional(),
});

// ── The events ───────────────────────────────────────────────────────────────

export const zSessionStart = zEventBase.extend({
  ev: z.literal("session_start"),
  /** PROLIFIC_PID. Required — a null participant must fail loudly (§8, §15). */
  pid: z.string().min(1),
  prolific: zProlific,
  role: zRole,
  cond: zConditionSnapshot,
});

export const zTrialStart = zEventBase.extend({
  ev: z.literal("trial_start"),
  taskId: z.enum(["retrieval", "repair", "teleop"]),
  seed: z.number().int(),
  cond: zConditionSnapshot,
  /** The utterance shown to this listener for this trial. */
  utterance: z.string(),
});

export const zSpeakerBriefed = zEventBase.extend({
  ev: z.literal("speaker_briefed"),
  briefing: z.enum(["novice", "expert", "unknown"]),
});

export const zUtteranceSent = zEventBase.extend({
  ev: z.literal("utterance_sent"),
  text: z.string(),
  /** ms from scene shown to send — a speaker-effort measure. */
  composeMs: z.number().int().nonnegative(),
});

export const zUtteranceReplayed = zEventBase.extend({
  ev: z.literal("utterance_replayed"),
  text: z.string(),
  /** Traceability: which speaker authored the replayed utterance (§8). */
  speakerSessionId: z.string(),
  speakerPid: z.string().optional(),
});

export const zListenerAction = zEventBase.extend({
  ev: z.literal("listener_action"),
  /** Raw action as issued, e.g. "KEY_Z", "MOVE_N", "PICK:c2", "CLICK:lidar". */
  action: z.string(),
  /** What it resolved to AFTER the control map, e.g. "up". null if unmapped. */
  resolved: z.string().nullable(),
  budgetLeft: z.number().int(),
  /** Grid position, when the task has one. */
  pos: z.tuple([z.number().int(), z.number().int()]).optional(),
  room: z.string().optional(),
});

export const zRoomEntered = zEventBase.extend({
  ev: z.literal("room_entered"),
  room: z.string(),
  /** Object ids revealed on arrival (fog of war lifts on ENTRY, not approach). */
  objectsRevealed: z.array(z.string()),
});

export const zFollowupAsked = zEventBase.extend({
  ev: z.literal("followup_asked"),
  text: z.string(),
  // Note: no reply field. The canned reply is a constant (Condition.followupReply)
  // and is NEVER informative (§3). We log the question as a dependent variable only.
});

export const zTrialEnd = zEventBase.extend({
  ev: z.literal("trial_end"),
  correct: z.boolean(),
  cost: z.number().int().nonnegative(),
  chosen: z.string().nullable(),
  target: z.string(),
  reason: z.string(),
});

export const zEvent = z.discriminatedUnion("ev", [
  zSessionStart,
  zTrialStart,
  zSpeakerBriefed,
  zUtteranceSent,
  zUtteranceReplayed,
  zListenerAction,
  zRoomEntered,
  zFollowupAsked,
  zTrialEnd,
]);

export type Event = z.infer<typeof zEvent>;
export type EventType = Event["ev"];

/** An event as authored by callers — `v` and `t` are filled in by the writer. */
export type EventInput =
  | Omit<z.infer<typeof zSessionStart>, "v" | "t">
  | Omit<z.infer<typeof zTrialStart>, "v" | "t">
  | Omit<z.infer<typeof zSpeakerBriefed>, "v" | "t">
  | Omit<z.infer<typeof zUtteranceSent>, "v" | "t">
  | Omit<z.infer<typeof zUtteranceReplayed>, "v" | "t">
  | Omit<z.infer<typeof zListenerAction>, "v" | "t">
  | Omit<z.infer<typeof zRoomEntered>, "v" | "t">
  | Omit<z.infer<typeof zFollowupAsked>, "v" | "t">
  | Omit<z.infer<typeof zTrialEnd>, "v" | "t">;
