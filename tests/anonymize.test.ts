// Anonymized exports must do two things, independently of the raw export:
//   1. DROP every row tied to a test/dev participant or a secondary (duplicate)
//      submission — entirely, regardless of session status (started/completed/etc).
//   2. STRIP name/email columns, keeping only Prolific ID as identifier.
// The raw side must be completely unaffected by either rule.

import { beforeAll, describe, expect, it } from "vitest";

// In-memory PGlite so this test never touches dev data.
process.env.DB_DRIVER = "pglite";
process.env.PGLITE_DATA_DIR = "memory://anonymize-test";

import { ensureMigrated, getDb } from "@/lib/db/client";
import { events, participants, sessions, trials } from "@/lib/db/schema";
import { exportTable } from "@/lib/server/admin";

const REAL_PID = "REAL_1";
const DUP_PID = "REAL_2"; // same name as REAL_1, submitted later → secondary submission
const DEV_PID = "DEV_037a779d"; // "Test User" — a dev/admin playing through as a listener

async function jsonl(table: Parameters<typeof exportTable>[0], anonymize: boolean) {
  const text = await exportTable(table, "jsonl", { anonymize });
  return text ? text.split("\n").map((l) => JSON.parse(l)) : [];
}

beforeAll(async () => {
  await ensureMigrated();
  const db = await getDb();

  await db.insert(participants).values([
    {
      prolificPid: REAL_PID, studyId: "S", sessionId: "ps1", role: "listener",
      firstName: "Johnny", lastName: "Appleseed", email: "123@gmail.com",
      createdAt: new Date("2026-01-01T00:00:00Z"),
    },
    {
      // Same person resubmitting under a new Prolific account — secondary submission.
      prolificPid: DUP_PID, studyId: "S", sessionId: "ps2", role: "listener",
      firstName: "Johnny", lastName: "Appleseed", email: "345@gmail.com",
      createdAt: new Date("2026-01-02T00:00:00Z"),
    },
    {
      // A dev testing the listener flow — never finished, still shows up in raw tables today.
      prolificPid: DEV_PID, studyId: "S", sessionId: "ps3", role: "listener",
      firstName: "Test", lastName: "User", email: null,
      createdAt: new Date("2026-01-03T00:00:00Z"),
    },
  ]);

  await db.insert(sessions).values([
    { id: "sess-real", prolificPid: REAL_PID, role: "listener", assignment: "novice", plan: {}, status: "completed" },
    { id: "sess-dup", prolificPid: DUP_PID, role: "listener", assignment: "novice", plan: {}, status: "completed" },
    // Dev run left mid-play (status "started", never completed) — must still be excluded.
    { id: "sess-dev", prolificPid: DEV_PID, role: "listener", assignment: "novice", plan: {}, status: "started" },
  ]);

  await db.insert(trials).values([
    { sessionId: "sess-real", trialIndex: 0, taskId: "retrieval", seed: 1, condition: {} },
    { sessionId: "sess-dup", trialIndex: 0, taskId: "retrieval", seed: 1, condition: {} },
    { sessionId: "sess-dev", trialIndex: 0, taskId: "retrieval", seed: 1, condition: {} },
  ]);

  await db.insert(events).values([
    { t: Date.now(), sessionId: "sess-real", ev: "trial_start", payload: {} },
    { t: Date.now(), sessionId: "sess-dup", ev: "trial_start", payload: {} },
    { t: Date.now(), sessionId: "sess-dev", ev: "trial_start", payload: {} },
  ]);
});

describe("anonymized exports drop test/dev and duplicate rows entirely", () => {
  it("participants: raw keeps everyone, anonymized keeps only the first real submission", async () => {
    const raw = await jsonl("participants", false);
    expect(raw.map((r) => r.prolificPid).sort()).toEqual([DEV_PID, DUP_PID, REAL_PID].sort());

    const anon = await jsonl("participants", true);
    expect(anon.map((r) => r.prolificPid)).toEqual([REAL_PID]);
    expect(anon[0].name).toBeUndefined();
    expect(anon[0].firstName).toBeUndefined();
    expect(anon[0].email).toBeUndefined();
  });

  it("sessions: anonymized drops the dev session even though it never completed", async () => {
    const raw = await jsonl("sessions", false);
    expect(raw.map((r) => r.id).sort()).toEqual(["sess-dev", "sess-dup", "sess-real"].sort());

    const anon = await jsonl("sessions", true);
    expect(anon.map((r) => r.id)).toEqual(["sess-real"]);
  });

  it("trials: anonymized drops rows belonging to excluded sessions", async () => {
    const anon = await jsonl("trials", true);
    expect(anon.map((r) => r.sessionId)).toEqual(["sess-real"]);
  });

  it("events: anonymized drops rows belonging to excluded sessions", async () => {
    const anon = await jsonl("events", true);
    expect(anon.map((r) => r.sessionId)).toEqual(["sess-real"]);
  });

  it("roster: anonymized drops test/dev and duplicate participants, raw still lists them", async () => {
    const raw = await jsonl("roster", false);
    expect(raw.map((r) => r.prolificPid).sort()).toEqual([DEV_PID, DUP_PID, REAL_PID].sort());

    const anon = await jsonl("roster", true);
    expect(anon.map((r) => r.prolificPid)).toEqual([REAL_PID]);
    expect(anon[0].name).toBeUndefined();
    expect(anon[0].email).toBeUndefined();
  });
});
