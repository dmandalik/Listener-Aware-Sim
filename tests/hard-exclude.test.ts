// A specific known-bad dev pid (the project's first-ever test run, kept by ID only —
// never by name) must be purged automatically the moment this code boots against ANY
// database, with no manual script and no admin action required.

import { describe, expect, it } from "vitest";

process.env.DB_DRIVER = "pglite";
process.env.PGLITE_DATA_DIR = "memory://hard-exclude-test";

import { getDb, ensureMigrated } from "@/lib/db/client";
import { participants, sessions } from "@/lib/db/schema";
import { purgeHardExcludedPids } from "@/lib/db/writer";

const HARD_EXCLUDED_PID = "DEV_436edb01";

describe("automatic hard-exclusion purge", () => {
  it("removes the known-bad pid's participant + session rows", async () => {
    await ensureMigrated(); // sets up tables (also runs the purge once, harmlessly — nothing to remove yet)
    const db = await getDb();

    // Seed a stand-in row under the known-bad id, the same way it already exists in a
    // real database that's about to be upgraded to this code.
    await db.insert(participants).values({
      prolificPid: HARD_EXCLUDED_PID, studyId: "DEV_STUDY", sessionId: "DEV_037a779d",
      firstName: "Dev", lastName: "Runner", role: "listener",
    });
    await db.insert(sessions).values({
      id: "hard-exclude-sess", prolificPid: HARD_EXCLUDED_PID, role: "listener",
      assignment: "novice", plan: {}, status: "started",
    });

    await purgeHardExcludedPids(); // what ensureMigrated() calls on every real boot

    const parts = await db.select().from(participants);
    const sess = await db.select().from(sessions);
    expect(parts.some((p: any) => p.prolificPid === HARD_EXCLUDED_PID)).toBe(false);
    expect(sess.some((s: any) => s.prolificPid === HARD_EXCLUDED_PID)).toBe(false);
  });

  it("is a no-op (does not error) when the pid is already absent", async () => {
    await expect(purgeHardExcludedPids()).resolves.toBeUndefined();
  });
});
