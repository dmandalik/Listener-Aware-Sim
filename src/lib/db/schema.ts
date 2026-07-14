// ─────────────────────────────────────────────────────────────────────────────
// Fetch Games — database schema (§12)
//
// Postgres via Drizzle. Identical schema for local (PGlite) and prod (Neon).
//
//   participants — one per Prolific person
//   sessions     — one per participant-run (assigned conditions, seeds, status)
//   trials       — one per trial (condition, task, seed, utterance, outcome)
//   events       — the append-only firehose. THE scientific record. Never mutated.
//   utterances   — the speaker pool (Study 1 writes, Study 2 replays)
//
// `events` is the source of truth; everything else can be recomputed from it.
// ─────────────────────────────────────────────────────────────────────────────

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const participants = pgTable(
  "participants",
  {
    prolificPid: text("prolific_pid").primaryKey(),
    studyId: text("study_id").notNull(),
    sessionId: text("session_id").notNull(), // Prolific's own SESSION_ID
    role: text("role", { enum: ["speaker", "listener"] }).notNull(),
    consentedAt: timestamp("consented_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
);

export const sessions = pgTable(
  "sessions",
  {
    // Our internal session id (the `sid` on every event).
    id: text("id").primaryKey(),
    prolificPid: text("prolific_pid")
      .notNull()
      .references(() => participants.prolificPid),
    role: text("role", { enum: ["speaker", "listener"] }).notNull(),
    // Assigned experiment plan for this run: ordered conditions + seeds.
    plan: jsonb("plan").notNull(),
    status: text("status", {
      enum: ["started", "completed", "abandoned", "screened_out"],
    })
      .notNull()
      .default("started"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [index("sessions_pid_idx").on(t.prolificPid)],
);

export const trials = pgTable(
  "trials",
  {
    id: serial("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id),
    trialIndex: integer("trial_index").notNull(), // 0-based order within the session
    taskId: text("task_id", {
      enum: ["retrieval", "repair", "teleop"],
    }).notNull(),
    seed: integer("seed").notNull(),
    condition: jsonb("condition").notNull(), // the full Condition snapshot
    utteranceText: text("utterance_text"),
    speakerSessionId: text("speaker_session_id"), // set when the utterance was replayed
    // Server-authoritative engine state between actions. A recomputable cache of
    // the event log (§12): the client NEVER sees this — it holds the full world,
    // target, and all objects. Only the fog-filtered listenerView is sent out.
    state: jsonb("state"),
    // Outcome (null until the trial ends).
    correct: boolean("correct"),
    cost: integer("cost"),
    targetId: text("target_id"),
    chosenId: text("chosen_id"),
    reason: text("reason"),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("trials_session_index_uq").on(t.sessionId, t.trialIndex),
    index("trials_session_idx").on(t.sessionId),
  ],
);

export const events = pgTable(
  "events",
  {
    id: serial("id").primaryKey(),
    // Application timestamp (epoch ms) from the event `t`. bigint because epoch-ms
    // overflows int32. Kept alongside the DB insert time so we retain the moment
    // the event actually occurred.
    t: bigint("t", { mode: "number" }).notNull(),
    sessionId: text("session_id").notNull(),
    ev: text("ev").notNull(),
    // Denormalized from the payload for per-trial querying (replay viewer, §12).
    trialIndex: integer("trial_index"),
    // The full validated event object, verbatim. This is the record.
    payload: jsonb("payload").notNull(),
    insertedAt: timestamp("inserted_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    index("events_session_idx").on(t.sessionId),
    index("events_ev_idx").on(t.ev),
  ],
);

export const utterances = pgTable(
  "utterances",
  {
    id: serial("id").primaryKey(),
    // Pool key (§8): utterances are drawn by (taskId, seed, scene).
    taskId: text("task_id", {
      enum: ["retrieval", "repair", "teleop"],
    }).notNull(),
    seed: integer("seed").notNull(),
    scene: text("scene").notNull(), // map/scene identifier
    text: text("text").notNull(),
    // Authorship / traceability.
    authorSessionId: text("author_session_id").notNull(),
    authorPid: text("author_pid"),
    // Pool-assignment bookkeeping (§8.3).
    timesServed: integer("times_served").notNull().default(0),
    // Running aggregate of downstream listener success (for the speaker bonus, §12).
    listenerSuccesses: integer("listener_successes").notNull().default(0),
    listenerTrials: integer("listener_trials").notNull().default(0),
    successRate: doublePrecision("success_rate"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [index("utterances_pool_idx").on(t.taskId, t.seed, t.scene)],
);

export type ParticipantRow = typeof participants.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type TrialRow = typeof trials.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type UtteranceRow = typeof utterances.$inferSelect;
