// Regression test for the reported bug: a HARD_EXCLUDED_PIDS row was still visible in
// the deployed anonymized export and in the dashboard's headline counts, apparently
// because the DB-level purge (see hard-exclude.test.ts) hadn't landed yet in that
// environment. The fix must not depend on the physical delete having happened — the
// analysis/export layer has to exclude the pid on its own, unconditionally.
//
// This test deliberately does NOT call purgeHardExcludedPids, to simulate exactly that
// "still physically in the DB" state and prove the export/summary layer hides it anyway.

import { beforeAll, describe, expect, it } from "vitest";

process.env.DB_DRIVER = "pglite";
process.env.PGLITE_DATA_DIR = "memory://hard-exclude-export-test";

import { ensureMigrated, getDb } from "@/lib/db/client";
import { participants, sessions } from "@/lib/db/schema";
import { HARD_EXCLUDED_PIDS } from "@/lib/test-participant";
import { exportTable, getSummary } from "@/lib/server/admin";

const HARD_PID = HARD_EXCLUDED_PIDS[0]!;
const REAL_PID = "REAL_KEEP";

beforeAll(async () => {
  await ensureMigrated(); // creates tables; also runs the (harmless, no-op) DB purge once

  const db = await getDb();
  // Re-seed the hard-excluded pid AFTER the boot-time purge already ran, so it sits in
  // the DB un-purged for the rest of this test — the exact "still there" scenario.
  await db.insert(participants).values([
    { prolificPid: HARD_PID, studyId: "DEV_STUDY", sessionId: "DEV_037a779d", firstName: "Dhruv", lastName: "Mandalik", role: "listener" },
    { prolificPid: REAL_PID, studyId: "S", sessionId: "ps-real", firstName: "Real", lastName: "Person", role: "listener" },
  ]);
  await db.insert(sessions).values([
    { id: "hx-sess", prolificPid: HARD_PID, role: "listener", assignment: "novice", plan: {}, status: "completed" },
    { id: "real-sess", prolificPid: REAL_PID, role: "listener", assignment: "novice", plan: {}, status: "completed" },
  ]);
});

describe("export/analysis layer excludes HARD_EXCLUDED_PIDS even if the DB row still physically exists", () => {
  it("anonymized participants export never includes it", async () => {
    const text = await exportTable("participants", "jsonl", { anonymize: true });
    const rows = text ? text.split("\n").map((l) => JSON.parse(l)) : [];
    expect(rows.some((r) => r.prolificPid === HARD_PID)).toBe(false);
    expect(rows.some((r) => r.prolificPid === REAL_PID)).toBe(true);
  });

  it("dashboard summary counts exclude it from totals and byAssignment", async () => {
    const summary = await getSummary();
    expect(summary.sessions.byAssignment.novice).toBe(1); // only REAL_PID, not the hard-excluded one
    expect(summary.sessions.completed).toBe(1);
  });
});
