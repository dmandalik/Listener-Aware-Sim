// ─────────────────────────────────────────────────────────────────────────────
// Fetch Games — persistence writer (§12)
//
// Every event is committed to the database AS IT HAPPENS (§15: never buffered in
// memory and flushed at the end — a participant who closes the tab mid-trial must
// still leave us their partial data). Events are validated before insert so a
// malformed event fails loudly at the boundary instead of corrupting the record.
// ─────────────────────────────────────────────────────────────────────────────

import { and, count, eq } from "drizzle-orm";
import { getDb } from "./client";
import {
  events,
  participants,
  sessions,
  trials,
  utterances,
  type ParticipantRow,
  type SessionRow,
  type UtteranceRow,
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
  name?: string | null;
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
      name: a.name ?? null,
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
        ...(a.name ? { name: a.name } : {}),
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
  assignment?: "speaker" | "novice" | "expert" | null;
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
      assignment: a.assignment ?? null,
    })
    .returning();
  return row;
}

/** Current counts per assignment cell — the basis for balanced assignment. */
export async function countAssignments(): Promise<Record<"speaker" | "novice" | "expert", number>> {
  const db = await getDb();
  const rows = (await db
    .select({ assignment: sessions.assignment, n: count() })
    .from(sessions)
    .groupBy(sessions.assignment)) as Array<{ assignment: string | null; n: number }>;
  const out = { speaker: 0, novice: 0, expert: 0 };
  for (const r of rows) {
    if (r.assignment && r.assignment in out) out[r.assignment as keyof typeof out] = Number(r.n);
  }
  return out;
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
  scene?: string | null;
  assignment?: "speaker" | "novice" | "expert" | null;
  seed: number;
  condition: unknown;
  utteranceText?: string | null;
  speakerSessionId?: string | null;
  speakerPid?: string | null;
  utteranceId?: number | null;
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
      scene: a.scene ?? null,
      assignment: a.assignment ?? null,
      seed: a.seed,
      condition: a.condition,
      utteranceText: a.utteranceText ?? null,
      speakerSessionId: a.speakerSessionId ?? null,
      speakerPid: a.speakerPid ?? null,
      utteranceId: a.utteranceId ?? null,
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

/**
 * Pool draw for a (task, seed, scene) cell, PER CONDITION (§8.3). Picks the
 * utterance least-served-to-this-condition, breaking ties at random. Result: each
 * novice gets a distinct utterance while any remain unused, then the pool spreads
 * evenly (each utterance served to the same number of novices) — and every
 * utterance is used. Experts are tracked independently, so the same utterance can
 * go to one novice AND one expert (the within-utterance comparison, §8).
 */
export async function drawUtterance(
  taskId: "retrieval" | "repair" | "teleop",
  seed: number,
  scene: string,
  condition: "novice" | "expert",
): Promise<UtteranceRow | null> {
  const db = await getDb();
  const rows = (await db
    .select()
    .from(utterances)
    .where(
      and(eq(utterances.taskId, taskId), eq(utterances.seed, seed), eq(utterances.scene, scene)),
    )) as UtteranceRow[];
  if (rows.length === 0) return null;

  const servedOf = (r: UtteranceRow) => (condition === "novice" ? r.servedNovice : r.servedExpert);
  const min = Math.min(...rows.map(servedOf));
  const candidates = rows.filter((r) => servedOf(r) === min);
  const pick = candidates[Math.floor(Math.random() * candidates.length)]!;

  await db
    .update(utterances)
    .set({
      timesServed: pick.timesServed + 1,
      ...(condition === "novice"
        ? { servedNovice: pick.servedNovice + 1 }
        : { servedExpert: pick.servedExpert + 1 }),
    })
    .where(eq(utterances.id, pick.id));
  return pick;
}

/** Fold a listener outcome into an utterance's aggregate success (for the bonus). */
export async function recordUtteranceOutcome(
  utteranceId: number,
  correct: boolean,
): Promise<void> {
  const db = await getDb();
  const [row] = await db.select().from(utterances).where(eq(utterances.id, utteranceId));
  if (!row) return;
  const listenerTrials = row.listenerTrials + 1;
  const listenerSuccesses = row.listenerSuccesses + (correct ? 1 : 0);
  await db
    .update(utterances)
    .set({
      listenerTrials,
      listenerSuccesses,
      successRate: listenerSuccesses / listenerTrials,
    })
    .where(eq(utterances.id, utteranceId));
}

export interface CloseTrialArgs {
  trialId: number;
  correct: boolean;
  cost: number;
  chosenId: string | null;
  reason: string;
  durationMs?: number | null;
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
      durationMs: a.durationMs ?? null,
      endedAt: new Date(),
    })
    .where(eq(trials.id, a.trialId));
}
