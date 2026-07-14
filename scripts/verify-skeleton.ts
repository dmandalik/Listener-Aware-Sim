// ─────────────────────────────────────────────────────────────────────────────
// Milestone 1 acceptance (§14.1):
//   "Prove a condition loads and a session persists."
//
// End-to-end, no UI: migrate a fresh DB → load a condition + map from config →
// open a participant/session/trial → write the event firehose → read it back and
// verify it round-trips through the database.
//
// Run: npm run verify:skeleton
// ─────────────────────────────────────────────────────────────────────────────

import "dotenv/config";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// Use an isolated, throwaway DB dir so the verify run never touches dev data.
const VERIFY_DIR = join(process.cwd(), ".pglite-verify");
process.env.DB_DRIVER = "pglite";
process.env.PGLITE_DATA_DIR = VERIFY_DIR;

function line(label: string, val: string) {
  console.log(`  ${label.padEnd(22)} ${val}`);
}

async function migrateFresh() {
  rmSync(VERIFY_DIR, { recursive: true, force: true });
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { migrate } = await import("drizzle-orm/pglite/migrator");
  const schema = await import("@/lib/db/schema");
  const pg = new PGlite(VERIFY_DIR);
  const db = drizzle(pg, { schema });
  await migrate(db, { migrationsFolder: join(process.cwd(), "drizzle") });
  await pg.close(); // release the dir; the writer singleton re-opens it
}

async function main() {
  console.log("\n▶ Milestone 1 — condition loads + session persists\n");

  // 1) migrate a clean database
  await migrateFresh();
  line("database", "migrated (pglite, fresh)");

  // 2) load config from disk (validated)
  const { loadCondition, loadMap } = await import("@/lib/config");
  const cond = loadCondition("retrieval_robot_novice");
  const map = loadMap("retrieval_6room");
  line("condition", `${cond.taskId} / briefing=${cond.speakerBriefing} / budget=${cond.budget}`);
  line("map", `${map.scene} / target=${map.target} / ${map.objects.length} objects`);

  // 3) open participant → session → trial
  const {
    upsertParticipant,
    startSession,
    openTrial,
    writeEvent,
    closeTrial,
    endSession,
  } = await import("@/lib/db/writer");

  const pid = `PILOT_${randomUUID().slice(0, 8)}`;
  const sid = randomUUID();
  await upsertParticipant({
    prolificPid: pid,
    studyId: "study_listener_pilot",
    sessionId: `prolific_${randomUUID().slice(0, 8)}`,
    role: "listener",
    userAgent: "verify-skeleton/node",
    consentedAt: new Date(),
  });
  await startSession({ id: sid, prolificPid: pid, role: "listener", plan: [cond] });
  const trialId = await openTrial({
    sessionId: sid,
    trialIndex: 0,
    taskId: cond.taskId,
    seed: cond.seed,
    condition: cond,
    utteranceText: cond.utteranceSource?.text ?? null,
    targetId: map.target,
  });
  line("participant", pid);
  line("session", sid);

  // 4) write the firehose — exactly the §10 event shapes
  await writeEvent({
    ev: "session_start",
    sid,
    pid,
    prolific: { studyId: "study_listener_pilot", sessionId: "prolific_abc" },
    role: "listener",
    cond: cond as unknown as Record<string, unknown>,
  });
  await writeEvent({ ev: "speaker_briefed", sid, briefing: cond.speakerBriefing });
  await writeEvent({
    ev: "utterance_sent",
    sid,
    text: cond.utteranceSource!.text,
    composeMs: 8200,
  });
  await writeEvent({
    ev: "listener_action",
    sid,
    action: "MOVE_N",
    resolved: "up",
    budgetLeft: cond.budget - 1,
    pos: [4, 3],
    room: "B",
  });
  await writeEvent({
    ev: "room_entered",
    sid,
    room: "A",
    objectsRevealed: ["c1"],
  });
  await writeEvent({
    ev: "trial_end",
    sid,
    correct: true,
    cost: 3,
    chosen: "c1",
    target: map.target,
    reason: "correct",
  });

  await closeTrial({ trialId, correct: true, cost: 3, chosenId: "c1", reason: "correct" });
  await endSession(sid, "completed");

  // 5) read it back out of the database
  const { getDb } = await import("@/lib/db/client");
  const { events, trials, sessions } = await import("@/lib/db/schema");
  const { eq } = await import("drizzle-orm");
  const db = await getDb();

  const rows = await db.select().from(events).where(eq(events.sessionId, sid));
  const trialRows = await db.select().from(trials).where(eq(trials.sessionId, sid));
  const sessRows = await db.select().from(sessions).where(eq(sessions.id, sid));

  console.log("");
  line("events persisted", String(rows.length));
  line("event types", rows.map((r: any) => r.ev).join(", "));
  line("trial outcome", `correct=${trialRows[0]?.correct} cost=${trialRows[0]?.cost}`);
  line("session status", String(sessRows[0]?.status));

  // 6) assert
  const problems: string[] = [];
  if (rows.length !== 6) problems.push(`expected 6 events, got ${rows.length}`);
  if (sessRows[0]?.status !== "completed") problems.push("session not marked completed");
  if (trialRows[0]?.correct !== true) problems.push("trial outcome not persisted");
  // every payload must re-validate against the event schema
  const { zEvent } = await import("@/lib/events");
  for (const r of rows as any[]) {
    const check = zEvent.safeParse(r.payload);
    if (!check.success) problems.push(`event ${r.ev} failed re-validation`);
  }

  console.log("");
  if (problems.length) {
    console.error("✗ FAILED:\n" + problems.map((p) => `  - ${p}`).join("\n"));
    rmSync(VERIFY_DIR, { recursive: true, force: true });
    process.exit(1);
  }
  console.log("✓ Milestone 1 verified: config loads, events round-trip through the DB.\n");
  rmSync(VERIFY_DIR, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  rmSync(VERIFY_DIR, { recursive: true, force: true });
  process.exit(1);
});
