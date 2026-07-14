// ─────────────────────────────────────────────────────────────────────────────
// Fetch Games — persistence writer (§12)
//
// Every event is committed to the database AS IT HAPPENS (§15: never buffered in
// memory and flushed at the end — a participant who closes the tab mid-trial must
// still leave us their partial data). Events are validated before insert so a
// malformed event fails loudly at the boundary instead of corrupting the record.
// ─────────────────────────────────────────────────────────────────────────────

import { eq } from "drizzle-orm";
import { getDb } from "./client";
import {
  events,
  participants,
  sessions,
  trials,
  utterances,
  type ParticipantRow,
  type SessionRow,
} from "./schema";
import {
  EVENT_SCHEMA_VERSION,
  zEvent,
  type Event,
  type EventInput,
} from "@/lib/events";

/** Wall-clock stamp for events. Isolated so tests can inject a clock if needed. */
export function now(): number {
  return Date.now();
}

// ── Participants ─────────────────────────────────────────────────────────────

export interface UpsertParticipantArgs {
  prolificPid: string;
  studyId: string;
  sessionId: string;
  role: "speaker" | "listener";
  userAgent?: string;
  consentedAt?: Date;
}

export async function upsertParticipant(
  a: UpsertParticipantArgs,
): Promise<ParticipantRow> {
  const db = await getDb();
  const [row] = await db
    .insert(participants)
    .values({
      prolificPid: a.prolificPid,
      studyId: a.studyId,
      sessionId: a.sessionId,
      role: a.role,
      userAgent: a.userAgent ?? null,
      consentedAt: a.consentedAt ?? null,
    })
    .onConflictDoUpdate({
      target: participants.prolificPid,
      set: {
        studyId: a.studyId,
        sessionId: a.sessionId,
        role: a.role,
        userAgent: a.userAgent ?? null,
        ...(a.consentedAt ? { consentedAt: a.consentedAt } : {}),
      },
    })
    .returning();
  return row;
}

export async function markParticipantCompleted(
  prolificPid: string,
): Promise<void> {
  const db = await getDb();
  await db
    .update(participants)
    .set({ completedAt: new Date() })
    .where(eq(participants.prolificPid, prolificPid));
}

// ── Sessions ─────────────────────────────────────────────────────────────────

export interface StartSessionArgs {
  id: string; // our internal session id (the `sid` on events)
  prolificPid: string;
  role: "speaker" | "listener";
  plan: unknown; // ordered conditions + seeds for this run
}

export async function startSession(a: StartSessionArgs): Promise<SessionRow> {
  const db = await getDb();
  const [row] = await db
    .insert(sessions)
    .values({
      id: a.id,
      prolificPid: a.prolificPid,
      role: a.role,
      plan: a.plan,
    })
    .returning();
  return row;
}

export async function endSession(
  id: string,
  status: "completed" | "abandoned" | "screened_out",
): Promise<void> {
  const db = await getDb();
  await db
    .update(sessions)
    .set({ status, endedAt: new Date() })
    .where(eq(sessions.id, id));
}

// ── Events (the firehose) ────────────────────────────────────────────────────

/**
 * Validate, stamp (v + t), and immediately persist one event.
 * Returns the fully-formed event that was written.
 */
export async function writeEvent(input: EventInput): Promise<Event> {
  const stamped = {
    ...input,
    v: EVENT_SCHEMA_VERSION,
    t: now(),
  };
  // Fail loudly on a malformed event rather than storing garbage in the record.
  const parsed = zEvent.parse(stamped);

  const db = await getDb();
  await db.insert(events).values({
    t: parsed.t,
    sessionId: parsed.sid,
    ev: parsed.ev,
    trialIndex: parsed.trialIndex ?? null,
    payload: parsed,
  });
  return parsed;
}

// ── Trials ───────────────────────────────────────────────────────────────────

export interface OpenTrialArgs {
  sessionId: string;
  trialIndex: number;
  taskId: "retrieval" | "repair" | "teleop";
  seed: number;
  condition: unknown;
  utteranceText?: string | null;
  speakerSessionId?: string | null;
  targetId?: string | null;
  state?: unknown; // server-authoritative engine state
}

export async function openTrial(a: OpenTrialArgs): Promise<number> {
  const db = await getDb();
  const [row] = await db
    .insert(trials)
    .values({
      sessionId: a.sessionId,
      trialIndex: a.trialIndex,
      taskId: a.taskId,
      seed: a.seed,
      condition: a.condition,
      utteranceText: a.utteranceText ?? null,
      speakerSessionId: a.speakerSessionId ?? null,
      targetId: a.targetId ?? null,
      state: a.state ?? null,
    })
    .returning({ id: trials.id });
  return row.id;
}

export async function setTrialState(trialId: number, state: unknown): Promise<void> {
  const db = await getDb();
  await db.update(trials).set({ state }).where(eq(trials.id, trialId));
}

// ── Utterances (the speaker pool, §8) ────────────────────────────────────────

export interface InsertUtteranceArgs {
  taskId: "retrieval" | "repair" | "teleop";
  seed: number;
  scene: string;
  text: string;
  authorSessionId: string;
  authorPid?: string | null;
}

export async function insertUtterance(a: InsertUtteranceArgs): Promise<number> {
  const db = await getDb();
  const [row] = await db
    .insert(utterances)
    .values({
      taskId: a.taskId,
      seed: a.seed,
      scene: a.scene,
      text: a.text,
      authorSessionId: a.authorSessionId,
      authorPid: a.authorPid ?? null,
    })
    .returning({ id: utterances.id });
  return row.id;
}

export interface CloseTrialArgs {
  trialId: number;
  correct: boolean;
  cost: number;
  chosenId: string | null;
  reason: string;
}

export async function closeTrial(a: CloseTrialArgs): Promise<void> {
  const db = await getDb();
  await db
    .update(trials)
    .set({
      correct: a.correct,
      cost: a.cost,
      chosenId: a.chosenId,
      reason: a.reason,
      endedAt: new Date(),
    })
    .where(eq(trials.id, a.trialId));
}
