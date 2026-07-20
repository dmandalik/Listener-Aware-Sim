// ─────────────────────────────────────────────────────────────────────────────
// Listener Aware Simulation — database schema (§12)
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
    name: text("name"), // full name (first + last), collected at entry
    firstName: text("first_name"),
    lastName: text("last_name"),
    email: text("email"), // collected at entry (required in the UI)
    // Consent choice: may de-identified data be shared in a public dataset?
    dataSharingConsent: boolean("data_sharing_consent"),
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
    // Between-subjects assignment, fixed for the whole session. Balanced across
    // participants (§ equal cell counts). Null for sessions started outside the
    // assigned entry (e.g. direct /listener dev access).
    assignment: text("assignment", { enum: ["speaker", "novice", "expert"] }),
    // Which layout regime this run belongs to: "single" = 1 layout/task (3 trials),
    // "multi" = N layouts/task. Lets the two toggle states be analyzed separately.
    variant: text("variant", { enum: ["single", "multi"] }),
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
    // Denormalized for easy flat export / grouping (all also derivable elsewhere).
    scene: text("scene"),
    layout: text("layout"), // stable layout id, e.g. "teleop/2" (multi-layout runs)
    assignment: text("assignment", { enum: ["speaker", "novice", "expert"] }),
    seed: integer("seed").notNull(),
    condition: jsonb("condition").notNull(), // the full Condition snapshot
    utteranceText: text("utterance_text"),
    speakerSessionId: text("speaker_session_id"), // author session (replay)
    speakerPid: text("speaker_pid"), // author Prolific pid (replay)
    utteranceId: integer("utterance_id"), // pool row served to this trial (replay)
    // Server-authoritative engine state between actions. A recomputable cache of
    // the event log (§12): the client NEVER sees this — it holds the full world,
    // target, and all objects. Only the fog-filtered listenerView is sent out.
    state: jsonb("state"),
    // Outcome (null until the trial ends).
    correct: boolean("correct"),
    cost: integer("cost"), // moves/keypresses/clicks taken
    durationMs: bigint("duration_ms", { mode: "number" }), // time to finish
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
    layout: text("layout"), // stable layout id, e.g. "teleop/2" (multi-layout runs)
    text: text("text").notNull(),
    // How long the speaker took to compose this utterance (ms from the scene opening
    // to the save; reflects the final save if they edited).
    composeMs: integer("compose_ms"),
    // Authorship / traceability.
    authorSessionId: text("author_session_id").notNull(),
    authorPid: text("author_pid"),
    // Pool-assignment bookkeeping (§8.3). `served*` counts every draw (incl. ones a
    // listener later abandoned); `completed*` counts only trials that TERMINATED and
    // drives the draw, so an abandoned serve is "reserved" — re-served until a real
    // listener completes it. Kept per-condition so novices and experts see each
    // utterance an equal number of times.
    timesServed: integer("times_served").notNull().default(0),
    servedNovice: integer("served_novice").notNull().default(0),
    servedExpert: integer("served_expert").notNull().default(0),
    completedNovice: integer("completed_novice").notNull().default(0),
    completedExpert: integer("completed_expert").notNull().default(0),
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

// Session-level survey: demographics (collected up front) + one open-ended feedback
// field (collected with the FINAL trial's NASA-TLX). One row per session. NASA-TLX
// now lives per-trial in `trialSurveys`; the tlx* columns here are retained for older
// data but are no longer written.
export const surveys = pgTable(
  "surveys",
  {
    id: serial("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    prolificPid: text("prolific_pid"),
    role: text("role", { enum: ["speaker", "novice", "expert"] }),
    // Demographics (all optional; "prefer not to say" allowed).
    ageRange: text("age_range"),
    gender: text("gender"),
    genderOther: text("gender_other"),
    race: jsonb("race"), // string[] — select all that apply
    raceOther: text("race_other"),
    // Self-reported familiarity with robots, asked once at intake (required). 0 = none
    // at all … 4 = works with robots frequently as part of their profession.
    robotFamiliarity: integer("robot_familiarity"),
    // Legacy end-of-study NASA-TLX (superseded by per-trial trialSurveys).
    tlxMental: integer("tlx_mental"),
    tlxPhysical: integer("tlx_physical"),
    tlxTemporal: integer("tlx_temporal"),
    tlxPerformance: integer("tlx_performance"),
    tlxEffort: integer("tlx_effort"),
    tlxFrustration: integer("tlx_frustration"),
    // Open-ended game feedback (asked once, with the last trial).
    feedback: text("feedback"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [uniqueIndex("surveys_session_uq").on(t.sessionId)],
);

// Per-trial NASA-TLX: one row after EACH trial, so workload can be compared across
// tasks, layouts, and (for listeners) the specific utterance received. Six rows per
// completed participant. Denormalized task/utterance fields make it analyzable on its
// own; join to `trials` on (sessionId, trialIndex) for full outcome context.
export const trialSurveys = pgTable(
  "trial_surveys",
  {
    id: serial("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    trialIndex: integer("trial_index").notNull(),
    prolificPid: text("prolific_pid"),
    assignment: text("assignment", { enum: ["speaker", "novice", "expert"] }),
    taskId: text("task_id", { enum: ["retrieval", "repair", "teleop"] }),
    layout: text("layout"),
    scene: text("scene"),
    // The utterance this workload rating pertains to (listener trials; null for speakers).
    utteranceId: integer("utterance_id"),
    speakerPid: text("speaker_pid"),
    // NASA-TLX, raw 0–100 per dimension.
    tlxMental: integer("tlx_mental"),
    tlxPhysical: integer("tlx_physical"),
    tlxTemporal: integer("tlx_temporal"),
    tlxPerformance: integer("tlx_performance"),
    tlxEffort: integer("tlx_effort"),
    tlxFrustration: integer("tlx_frustration"),
    // Extra per-trial self-reports, 0–100. LISTENER trials record how well they
    // understood the message (comprehension) and how useful it was (usefulness);
    // SPEAKER trials record how confident they are a listener could follow it
    // (confidence). Each is null on the role it doesn't apply to.
    comprehension: integer("comprehension"),
    usefulness: integer("usefulness"),
    confidence: integer("confidence"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [uniqueIndex("trial_surveys_session_trial_uq").on(t.sessionId, t.trialIndex)],
);

export type ParticipantRow = typeof participants.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
export type TrialRow = typeof trials.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type UtteranceRow = typeof utterances.$inferSelect;
export type SurveyRow = typeof surveys.$inferSelect;
export type TrialSurveyRow = typeof trialSurveys.$inferSelect;
