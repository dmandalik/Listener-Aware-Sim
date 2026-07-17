// Auto-purge of abandoned runs (§ "only complete data").
//
// A run is COMPLETE once every game is finished (sessions.status === "completed").
// The end survey is deliberately not the bar — a finished gameplay run is the data.
// Abandoned = not completed AND idle past the window, measured from the last event
// so an active participant can never be purged mid-play. Purging must also hand back
// any pool serves/outcomes the run contributed, or the draw balance and speaker bonus
// keep counting data that no longer exists.

import { beforeEach, describe, expect, it } from "vitest";

// In-memory PGlite so the test never touches dev data.
process.env.DB_DRIVER = "pglite";
process.env.PGLITE_DATA_DIR = "memory://purge-test";

import { eq } from "drizzle-orm";
import { ensureMigrated, getDb } from "@/lib/db/client";
import { events, participants, sessions, surveys, trials, utterances } from "@/lib/db/schema";
import {
  insertUtterance,
  openTrial,
  purgeIncompleteSessions,
  startSession,
  upsertParticipant,
  upsertSurvey,
} from "@/lib/db/writer";

const MIN_AGO = (m: number) => Date.now() - m * 60_000;

async function makeRun(
  pid: string,
  opts: {
    finishedGames: boolean;
    idleMinutes: number;
    withSurvey?: boolean;
    role?: "speaker" | "listener";
    assignment?: "speaker" | "novice" | "expert";
  },
) {
  const db = await getDb();
  const role = opts.role ?? "speaker";
  await upsertParticipant({ prolificPid: pid, studyId: "S", sessionId: `${pid}-ps`, role });
  const sid = `${pid}-sess`;
  await startSession({
    id: sid,
    prolificPid: pid,
    role,
    plan: {},
    assignment: opts.assignment ?? "speaker",
  });
  // Stamp the run's activity: an event `idleMinutes` ago is its last sign of life.
  await db.insert(events).values({
    t: MIN_AGO(opts.idleMinutes),
    sessionId: sid,
    ev: "session_start",
    payload: {},
  });
  await db
    .update(sessions)
    .set({
      startedAt: new Date(MIN_AGO(opts.idleMinutes)),
      ...(opts.finishedGames ? { status: "completed" as const } : {}),
    })
    .where(eq(sessions.id, sid));
  if (opts.withSurvey) await upsertSurvey({ sessionId: sid, tlxMental: 40 });
  return sid;
}

async function reset() {
  const db = await getDb();
  for (const t of [events, trials, surveys, utterances, sessions, participants]) {
    await db.delete(t);
  }
}

describe("purgeIncompleteSessions", () => {
  beforeEach(async () => {
    await ensureMigrated();
    await reset();
  });

  it("keeps finished runs (even with no survey) and purges only idle unfinished ones", async () => {
    const finishedNoSurvey = await makeRun("FINISHED_NO_SURVEY", { finishedGames: true, idleMinutes: 300 });
    const finishedSurvey = await makeRun("FINISHED_SURVEY", { finishedGames: true, idleMinutes: 300, withSurvey: true });
    const abandoned = await makeRun("ABANDONED", { finishedGames: false, idleMinutes: 300 });
    const active = await makeRun("ACTIVE", { finishedGames: false, idleMinutes: 1 });

    const res = await purgeIncompleteSessions(120);
    expect(res.sessions).toBe(1); // only ABANDONED
    expect(res.participants).toBe(1);

    const db = await getDb();
    const left = ((await db.select().from(sessions)) as any[]).map((s) => s.id).sort();
    // The survey-skipper who finished MUST survive — that is the whole point.
    expect(left).toEqual([active, finishedNoSurvey, finishedSurvey].sort());
    expect(left).not.toContain(abandoned);
  });

  it("never purges a slow-but-active participant, however long they've been going", async () => {
    // Started 5h ago but acted a minute ago — still playing.
    const db = await getDb();
    const sid = await makeRun("SLOW", { finishedGames: false, idleMinutes: 300 });
    await db.insert(events).values({ t: MIN_AGO(1), sessionId: sid, ev: "listener_action", payload: {} });

    const res = await purgeIncompleteSessions(120);
    expect(res.sessions).toBe(0);
    const left = ((await db.select().from(sessions)) as any[]).map((s) => s.id);
    expect(left).toContain(sid);
  });

  it("hands back pool serves and outcomes when a listener run is purged", async () => {
    const db = await getDb();
    // A completed speaker authored an utterance; two listeners drew it — one novice
    // (who finished the study) and one expert (who abandoned mid-way).
    const speaker = await makeRun("SPK", { finishedGames: true, idleMinutes: 300 });
    const uid = await insertUtterance({
      taskId: "retrieval",
      seed: 1,
      scene: "s1",
      text: "go left",
      authorSessionId: speaker,
      authorPid: "SPK",
    });
    // Simulate both draws + both outcomes having been recorded on the pool row.
    await db
      .update(utterances)
      .set({
        timesServed: 2,
        servedNovice: 1,
        servedExpert: 1,
        completedNovice: 1,
        completedExpert: 1,
        listenerTrials: 2,
        listenerSuccesses: 2,
        successRate: 1,
      })
      .where(eq(utterances.id, uid));

    const keeper = await makeRun("NOV", {
      finishedGames: true, idleMinutes: 300, role: "listener", assignment: "novice",
    });
    await openTrial({
      sessionId: keeper, trialIndex: 0, taskId: "retrieval", seed: 1, condition: {},
      assignment: "novice", utteranceId: uid,
    });
    const doomed = await makeRun("EXP", {
      finishedGames: false, idleMinutes: 300, role: "listener", assignment: "expert",
    });
    const doomedTrial = await openTrial({
      sessionId: doomed, trialIndex: 0, taskId: "retrieval", seed: 1, condition: {},
      assignment: "expert", utteranceId: uid,
    });
    // The expert's trial DID terminate successfully before they abandoned the study.
    await db.update(trials).set({ endedAt: new Date(), correct: true }).where(eq(trials.id, doomedTrial));

    const res = await purgeIncompleteSessions(120);
    expect(res.sessions).toBe(1); // the expert
    expect(res.utterancesAdjusted).toBe(1);

    const [u] = (await db.select().from(utterances).where(eq(utterances.id, uid))) as any[];
    // The expert's serve AND outcome are given back; the novice's are untouched.
    expect(u.timesServed).toBe(1);
    expect(u.servedExpert).toBe(0);
    expect(u.completedExpert).toBe(0);
    expect(u.servedNovice).toBe(1);
    expect(u.completedNovice).toBe(1);
    expect(u.listenerTrials).toBe(1);
    expect(u.listenerSuccesses).toBe(1);
    expect(u.successRate).toBe(1);
  });

  it("does not roll back outcomes for a trial that never terminated", async () => {
    const db = await getDb();
    const speaker = await makeRun("SPK2", { finishedGames: true, idleMinutes: 300 });
    const uid = await insertUtterance({
      taskId: "teleop", seed: 2, scene: "s2", text: "drive", authorSessionId: speaker, authorPid: "SPK2",
    });
    // Drawn (served++) but the listener quit mid-trial, so no outcome was ever recorded.
    await db.update(utterances).set({ timesServed: 1, servedNovice: 1 }).where(eq(utterances.id, uid));
    const doomed = await makeRun("NOV2", {
      finishedGames: false, idleMinutes: 300, role: "listener", assignment: "novice",
    });
    await openTrial({
      sessionId: doomed, trialIndex: 0, taskId: "teleop", seed: 2, condition: {},
      assignment: "novice", utteranceId: uid,
    });

    await purgeIncompleteSessions(120);
    const [u] = (await db.select().from(utterances).where(eq(utterances.id, uid))) as any[];
    expect(u.timesServed).toBe(0); // the draw is released
    expect(u.servedNovice).toBe(0);
    expect(u.completedNovice).toBe(0); // never incremented, must not go negative
    expect(u.listenerTrials).toBe(0);
  });
});
