// ─────────────────────────────────────────────────────────────────────────────
// Listener Aware Simulation — persistence writer (§12)
//
// Every event is committed to the database AS IT HAPPENS (§15: never buffered in
// memory and flushed at the end — a participant who closes the tab mid-trial must
// still leave us their partial data). Events are validated before insert so a
// malformed event fails loudly at the boundary instead of corrupting the record.
// ─────────────────────────────────────────────────────────────────────────────

import { and, count, eq, inArray } from "drizzle-orm";
import { getDb } from "./client";
import {
  events,
  participants,
  sessions,
  surveys,
  trials,
  utterances,
  type ParticipantRow,
  type SessionRow,
  type TrialRow,
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
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  dataSharingConsent?: boolean | null;
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
      firstName: a.firstName ?? null,
      lastName: a.lastName ?? null,
      email: a.email ?? null,
      dataSharingConsent: a.dataSharingConsent ?? null,
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
        ...(a.firstName ? { firstName: a.firstName } : {}),
        ...(a.lastName ? { lastName: a.lastName } : {}),
        ...(a.email ? { email: a.email } : {}),
        ...(a.dataSharingConsent != null ? { dataSharingConsent: a.dataSharingConsent } : {}),
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
  variant?: "single" | "multi" | null;
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
      variant: a.variant ?? null,
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

/**
 * Physically delete every trace of ABANDONED runs, so only real data survives.
 *
 * "Complete" means the participant FINISHED EVERY GAME (sessions.status becomes
 * "completed" when they pass the last trial). The end survey is deliberately NOT
 * the bar: throwing away a whole gameplay run because someone closed the tab on
 * the survey is far more costly than a missing NASA-TLX row.
 *
 * Abandoned means: not completed AND idle for `minIdleMinutes`. Idleness is measured
 * from the session's LAST EVENT (every action writes one), not from when it started —
 * a participant who is simply slow keeps emitting events, so an active session can
 * never be purged out from under them.
 *
 * Pool bookkeeping is rolled back BEFORE the trials are deleted: a purged listener's
 * draws and outcomes must not linger on the utterances they touched, or the draw
 * balance and the speaker bonus keep counting data that no longer exists.
 *
 * Deletes children before parents to respect FKs (trials/surveys/events/utterances
 * → sessions → participants). A participant is removed only when they have no
 * remaining session at all.
 */
export async function purgeIncompleteSessions(
  minIdleMinutes = 120,
): Promise<{ sessions: number; participants: number; utterancesAdjusted: number }> {
  const db = await getDb();
  const cutoff = now() - minIdleMinutes * 60_000;
  const none = { sessions: 0, participants: 0, utterancesAdjusted: 0 };

  const all = (await db.select().from(sessions)) as SessionRow[];
  const candidates = all.filter((s) => s.status !== "completed");
  if (candidates.length === 0) return none;
  const candIds = candidates.map((s) => s.id);

  // Last activity per candidate session: newest event, else when it started.
  const evs = (await db
    .select({ sessionId: events.sessionId, t: events.t })
    .from(events)
    .where(inArray(events.sessionId, candIds))) as Array<{ sessionId: string; t: number }>;
  const lastEvent = new Map<string, number>();
  for (const e of evs) {
    const t = Number(e.t);
    if (t > (lastEvent.get(e.sessionId) ?? 0)) lastEvent.set(e.sessionId, t);
  }
  const targets = candidates.filter((s) => {
    const started = new Date(s.startedAt as unknown as string).getTime();
    return Math.max(started, lastEvent.get(s.id) ?? 0) < cutoff;
  });
  if (targets.length === 0) return none;
  const ids = targets.map((s) => s.id);
  const pids = new Set(targets.map((s) => s.prolificPid));

  // Give back every serve/outcome these runs contributed to the pool.
  const doomed = (await db.select().from(trials).where(inArray(trials.sessionId, ids))) as TrialRow[];
  let utterancesAdjusted = 0;
  for (const t of doomed) {
    if (t.utteranceId == null) continue;
    const [u] = (await db
      .select()
      .from(utterances)
      .where(eq(utterances.id, t.utteranceId))) as UtteranceRow[];
    if (!u) continue;
    const cond = t.assignment === "novice" || t.assignment === "expert" ? t.assignment : null;
    const ended = !!t.endedAt; // only terminated trials ever incremented the outcome counts
    const listenerTrials = Math.max(0, u.listenerTrials - (ended ? 1 : 0));
    const listenerSuccesses = Math.max(0, u.listenerSuccesses - (ended && t.correct ? 1 : 0));
    await db
      .update(utterances)
      .set({
        timesServed: Math.max(0, u.timesServed - 1),
        ...(cond === "novice"
          ? {
              servedNovice: Math.max(0, u.servedNovice - 1),
              completedNovice: Math.max(0, u.completedNovice - (ended ? 1 : 0)),
            }
          : cond === "expert"
            ? {
                servedExpert: Math.max(0, u.servedExpert - 1),
                completedExpert: Math.max(0, u.completedExpert - (ended ? 1 : 0)),
              }
            : {}),
        listenerTrials,
        listenerSuccesses,
        successRate: listenerTrials ? listenerSuccesses / listenerTrials : null,
      })
      .where(eq(utterances.id, u.id));
    utterancesAdjusted += 1;
  }

  // Children first, then the session rows themselves.
  await db.delete(events).where(inArray(events.sessionId, ids));
  await db.delete(trials).where(inArray(trials.sessionId, ids));
  await db.delete(surveys).where(inArray(surveys.sessionId, ids));
  await db.delete(utterances).where(inArray(utterances.authorSessionId, ids));
  await db.delete(sessions).where(inArray(sessions.id, ids));

  // Orphan participants: those whose every session was just purged.
  const remaining = (await db.select({ pid: sessions.prolificPid }).from(sessions)) as Array<{ pid: string }>;
  const stillHasSession = new Set(remaining.map((r) => r.pid));
  const orphanPids = [...pids].filter((p) => !stillHasSession.has(p));
  if (orphanPids.length) {
    await db.delete(participants).where(inArray(participants.prolificPid, orphanPids));
  }
  return { sessions: ids.length, participants: orphanPids.length, utterancesAdjusted };
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
  layout?: string | null;
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
      layout: a.layout ?? null,
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
  layout?: string | null;
  text: string;
  composeMs?: number | null;
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
      layout: a.layout ?? null,
      text: a.text,
      composeMs: a.composeMs ?? null,
      authorSessionId: a.authorSessionId,
      authorPid: a.authorPid ?? null,
    })
    .returning({ id: utterances.id });
  return row.id;
}

/** Save an author's utterance for one layout, REPLACING their previous text for the
 *  same (author, task, seed, scene) instead of adding a duplicate pool row — so a
 *  speaker who edits and re-saves keeps exactly one utterance per layout. Serve /
 *  outcome counts are left intact (speakers author before listeners are served). */
export async function upsertAuthorUtterance(a: InsertUtteranceArgs): Promise<number> {
  const db = await getDb();
  const [existing] = (await db
    .select()
    .from(utterances)
    .where(
      and(
        eq(utterances.authorSessionId, a.authorSessionId),
        eq(utterances.taskId, a.taskId),
        eq(utterances.seed, a.seed),
        eq(utterances.scene, a.scene),
      ),
    )) as UtteranceRow[];
  if (existing) {
    await db
      .update(utterances)
      .set({
        text: a.text,
        layout: a.layout ?? existing.layout,
        // Keep the FIRST compose time — "how long to come up with it". The client's
        // timer restarts whenever the scene re-mounts (Back, refresh, resume), so a
        // later re-save reports a few seconds and would otherwise clobber the real
        // measurement with an artifact.
        composeMs: existing.composeMs ?? a.composeMs ?? null,
      })
      .where(eq(utterances.id, existing.id));
    return existing.id;
  }
  return insertUtterance(a);
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

  // Balance on COMPLETED trials, not draws: an utterance served to a listener who
  // then abandons never gets a completed++, so it stays least-completed and is
  // re-served ("reserved" per §8.3) until a real listener finishes it. `served`
  // (draw count) is a secondary tie-break to spread concurrent in-flight draws;
  // random breaks the rest. This keeps completed novices == completed experts and
  // each speaker's utterances used equally.
  const completedOf = (r: UtteranceRow) =>
    condition === "novice" ? r.completedNovice : r.completedExpert;
  const servedOf = (r: UtteranceRow) => (condition === "novice" ? r.servedNovice : r.servedExpert);
  const minC = Math.min(...rows.map(completedOf));
  let pool = rows.filter((r) => completedOf(r) === minC);
  const minS = Math.min(...pool.map(servedOf));
  pool = pool.filter((r) => servedOf(r) === minS);
  const pick = pool[Math.floor(Math.random() * pool.length)]!;

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

/** How many speaker utterances the pool holds for a (task, seed, scene) — a
 *  non-mutating check used to decide whether a listener may play that task. */
export async function countUtterances(
  taskId: "retrieval" | "repair" | "teleop",
  seed: number,
  scene: string,
): Promise<number> {
  const db = await getDb();
  const [row] = (await db
    .select({ n: count() })
    .from(utterances)
    .where(
      and(eq(utterances.taskId, taskId), eq(utterances.seed, seed), eq(utterances.scene, scene)),
    )) as Array<{ n: number }>;
  return Number(row?.n ?? 0);
}

/** Fold a TERMINATED listener trial into an utterance's aggregates. Increments the
 *  per-condition completed count (the "reserved" balance target) and the success
 *  aggregate (for the bonus). Only called when a trial actually ends — abandoned
 *  trials never reach here, so their serve is released for re-use. */
export async function recordUtteranceOutcome(
  utteranceId: number,
  correct: boolean,
  condition?: "novice" | "expert" | null,
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
      ...(condition === "novice"
        ? { completedNovice: row.completedNovice + 1 }
        : condition === "expert"
          ? { completedExpert: row.completedExpert + 1 }
          : {}),
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

// ── End-of-study survey (§ demographics + NASA-TLX + feedback) ────────────────

export interface SurveyArgs {
  sessionId: string;
  prolificPid?: string | null;
  role?: "speaker" | "novice" | "expert" | null;
  ageRange?: string | null;
  gender?: string | null;
  genderOther?: string | null;
  race?: string[] | null;
  raceOther?: string | null;
  tlxMental?: number | null;
  tlxPhysical?: number | null;
  tlxTemporal?: number | null;
  tlxPerformance?: number | null;
  tlxEffort?: number | null;
  tlxFrustration?: number | null;
  feedback?: string | null;
}

/** Save (or replace) a session's end-of-study survey. One row per session. */
export async function upsertSurvey(a: SurveyArgs): Promise<void> {
  const db = await getDb();
  // Only write the fields actually PROVIDED (defined). Demographics are saved at
  // session start and NASA-TLX + feedback at the end — two disjoint upserts to the
  // same row, so a later write must not null out the earlier one.
  const all: Record<string, unknown> = {
    prolificPid: a.prolificPid,
    role: a.role,
    ageRange: a.ageRange,
    gender: a.gender,
    genderOther: a.genderOther,
    race: a.race,
    raceOther: a.raceOther,
    tlxMental: a.tlxMental,
    tlxPhysical: a.tlxPhysical,
    tlxTemporal: a.tlxTemporal,
    tlxPerformance: a.tlxPerformance,
    tlxEffort: a.tlxEffort,
    tlxFrustration: a.tlxFrustration,
    feedback: a.feedback,
  };
  const provided: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(all)) if (v !== undefined) provided[k] = v;
  await db
    .insert(surveys)
    .values({ sessionId: a.sessionId, ...provided })
    .onConflictDoUpdate({ target: surveys.sessionId, set: provided });
}
