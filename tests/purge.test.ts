// Auto-purge of abandoned runs (§ "only complete data"). A session is abandoned
// when it never submitted the end survey (no NASA-TLX). purgeIncompleteSessions
// deletes those — but ONLY once they've sat untouched past the age guard, so a
// participant still playing is never removed.

import { beforeAll, describe, expect, it } from "vitest";

// In-memory PGlite so the test never touches dev data.
process.env.DB_DRIVER = "pglite";
process.env.PGLITE_DATA_DIR = "memory://purge-test";

import { eq } from "drizzle-orm";
import { ensureMigrated, getDb } from "@/lib/db/client";
import { participants, sessions, surveys, trials } from "@/lib/db/schema";
import {
  openTrial,
  purgeIncompleteSessions,
  startSession,
  upsertParticipant,
  upsertSurvey,
} from "@/lib/db/writer";

const HOURS_AGO = (h: number) => new Date(Date.now() - h * 3_600_000);

async function makeRun(pid: string, opts: { complete: boolean; startedHoursAgo: number }) {
  await upsertParticipant({ prolificPid: pid, studyId: "S", sessionId: `${pid}-ps`, role: "speaker" });
  const sid = `${pid}-sess`;
  await startSession({ id: sid, prolificPid: pid, role: "speaker", plan: {}, assignment: "speaker" });
  await openTrial({ sessionId: sid, trialIndex: 0, taskId: "retrieval", seed: 1, condition: {} });
  if (opts.complete) await upsertSurvey({ sessionId: sid, tlxMental: 40 });
  // Backdate so the age guard can be exercised deterministically.
  const db = await getDb();
  await db.update(sessions).set({ startedAt: HOURS_AGO(opts.startedHoursAgo) }).where(eq(sessions.id, sid));
  return sid;
}

describe("purgeIncompleteSessions", () => {
  beforeAll(async () => {
    await ensureMigrated();
  });

  it("deletes abandoned old runs but keeps completed and still-active ones", async () => {
    const done = await makeRun("DONE", { complete: true, startedHoursAgo: 3 }); // completed → keep
    const quit = await makeRun("QUIT", { complete: false, startedHoursAgo: 3 }); // abandoned, old → purge
    const active = await makeRun("ACTIVE", { complete: false, startedHoursAgo: 0 }); // in-progress → keep

    const res = await purgeIncompleteSessions(60);
    expect(res.sessions).toBe(1); // only QUIT
    expect(res.participants).toBe(1); // QUIT's participant orphaned

    const db = await getDb();
    const remainingSessions = (await db.select().from(sessions)) as any[];
    const ids = remainingSessions.map((s) => s.id).sort();
    expect(ids).toEqual([active, done].sort());

    // QUIT's children and participant are gone; nothing else touched.
    const quitTrials = (await db.select().from(trials).where(eq(trials.sessionId, quit))) as any[];
    expect(quitTrials).toHaveLength(0);
    const quitPart = (await db.select().from(participants).where(eq(participants.prolificPid, "QUIT"))) as any[];
    expect(quitPart).toHaveLength(0);
    const donePart = (await db.select().from(participants).where(eq(participants.prolificPid, "DONE"))) as any[];
    expect(donePart).toHaveLength(1);
    // DONE's survey (completion marker) survives.
    const doneSurvey = (await db.select().from(surveys).where(eq(surveys.sessionId, done))) as any[];
    expect(doneSurvey).toHaveLength(1);
  });
});
