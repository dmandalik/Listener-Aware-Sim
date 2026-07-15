// ─────────────────────────────────────────────────────────────────────────────
// Data-pipeline acceptance: recruitment phasing + per-condition utterance draw +
// a complete, accurate trials record.
//
//   1. Speakers are recruited FIRST (5), each authors 3 utterances (pool fills).
//   2. Then novices + experts draw from the pool: each utterance is used, spread
//      EVENLY per condition (novices distinct while any remain unused), and the
//      SAME utterance can go to one novice AND one expert (within-utterance §8).
//   3. A completed trial records moves (cost), time (durationMs), assignment,
//      scene, and the exact pooled utterance (+ its author) — all accurate.
//
// Run: npm run verify:recruitment
// ─────────────────────────────────────────────────────────────────────────────

import "dotenv/config";
import { rmSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.cwd(), ".pglite-recruit");
process.env.DB_DRIVER = "pglite";
process.env.PGLITE_DATA_DIR = DIR;

const N_SPEAK = 5;
const N_NOV = 10;
const N_EXP = 10;

function line(l: string, v: string) {
  console.log(`  ${l.padEnd(28)} ${v}`);
}

async function main() {
  rmSync(DIR, { recursive: true, force: true });
  console.log("\n▶ recruitment + pool draw + data completeness\n");

  const {
    assignAndStart,
    saveSpeakerUtterance,
    advanceListenerTrial,
    applyListenerAction,
  } = await import("@/lib/server/listener");
  const { oracleRetrievalBot } = await import("@/lib/engine");
  const { getDb } = await import("@/lib/db/client");
  const { trials, utterances, sessions } = await import("@/lib/db/schema");
  const { and, eq, asc } = await import("drizzle-orm");
  const db = await getDb();

  const problems: string[] = [];
  const ok = (cond: boolean, msg: string) => { if (!cond) problems.push(msg); };

  // ── Phase 1: speakers first ────────────────────────────────────────────────
  const speakers: string[] = [];
  for (let i = 0; i < N_SPEAK; i++) {
    const r = await assignAndStart({ prolific: { pid: `SPK${i}`, studyId: "s", sessionId: `s${i}` } });
    ok(r.assignment === "speaker", `arrival ${i} should be speaker, got ${r.assignment}`);
    speakers.push(r.sessionId);
  }
  // each speaker authors 3 utterances (one per scene/mission)
  for (const sid of speakers) {
    for (let t = 0; t < 3; t++) {
      await saveSpeakerUtterance({ sessionId: sid, trialIndex: t, text: `utt:${sid.slice(0, 4)}:m${t}` });
    }
  }
  line("speakers recruited first", String(speakers.length));

  // ── Phase 2: listeners draw from the pool ──────────────────────────────────
  const novices: string[] = [];
  const experts: string[] = [];
  for (let i = 0; i < N_NOV + N_EXP; i++) {
    const r = await assignAndStart({ prolific: { pid: `LIS${i}`, studyId: "s", sessionId: `l${i}` } });
    (r.assignment === "novice" ? novices : experts).push(r.sessionId);
  }
  ok(novices.length === N_NOV, `expected ${N_NOV} novices, got ${novices.length}`);
  ok(experts.length === N_EXP, `expected ${N_EXP} experts, got ${experts.length}`);
  line("novices / experts", `${novices.length} / ${experts.length}`);

  // Drive the first novice's trial 0 to completion (real play) to check the record.
  const drive = async (sid: string) => {
    for (;;) {
      const [row] = await db.select().from(trials).where(and(eq(trials.sessionId, sid), eq(trials.trialIndex, 0)));
      if (!row || row.endedAt) break;
      const action = oracleRetrievalBot({ state: row.state } as any);
      const p = await applyListenerAction({ sessionId: sid, trialIndex: 0, action });
      if (p.terminal) break;
    }
  };
  await drive(novices[0]!);

  // Everyone advances through their remaining trials so every scene is drawn.
  for (const sid of [...novices, ...experts]) {
    await advanceListenerTrial(sid);
    await advanceListenerTrial(sid);
  }

  // ── Checks: pool distribution ──────────────────────────────────────────────
  const pool = (await db.select().from(utterances)) as any[];
  line("pool size", `${pool.length} (expect ${N_SPEAK * 3})`);
  ok(pool.length === N_SPEAK * 3, `expected ${N_SPEAK * 3} utterances`);
  ok(pool.every((u) => u.servedNovice >= 1 && u.servedExpert >= 1), "every utterance must be used by a novice AND an expert");
  // even spread per condition: N_NOV listeners over N_SPEAK utterances per scene
  const perScene = N_NOV / N_SPEAK;
  ok(pool.every((u) => u.servedNovice === perScene), `each utterance should be served to exactly ${perScene} novices`);
  ok(pool.every((u) => u.servedExpert === N_EXP / N_SPEAK), `each utterance should be served to exactly ${N_EXP / N_SPEAK} experts`);
  line("served per utterance", `novice=${pool[0].servedNovice} expert=${pool[0].servedExpert} (even)`);

  // distinctness: the first 5 novices (arrival order) each got a DIFFERENT utterance for scene 5001
  const novTrials = (await db
    .select()
    .from(trials)
    .where(and(eq(trials.assignment, "novice"), eq(trials.seed, 5001)))
    .orderBy(asc(trials.id))) as any[];
  const firstFive = novTrials.slice(0, N_SPEAK).map((t) => t.utteranceId);
  ok(new Set(firstFive).size === N_SPEAK, "first 5 novices should each get a distinct utterance");
  line("first-5 novices distinct", `${new Set(firstFive).size} unique of ${N_SPEAK}`);

  // ── Checks: completed-trial record is complete + accurate ──────────────────
  const [rec] = (await db.select().from(trials).where(and(eq(trials.sessionId, novices[0]!), eq(trials.trialIndex, 0)))) as any[];
  const fields = {
    assignment: rec.assignment, scene: rec.scene, seed: rec.seed,
    cost: rec.cost, durationMs: rec.durationMs, correct: rec.correct,
    chosenId: rec.chosenId, reason: rec.reason,
    utteranceId: rec.utteranceId, speakerPid: rec.speakerPid, utteranceText: rec.utteranceText,
    endedAt: rec.endedAt != null,
  };
  console.log("\n  completed novice trial 0 record:");
  console.log("   ", JSON.stringify(fields));
  ok(rec.assignment === "novice", "trial.assignment missing");
  ok(rec.scene === "retrieval_facility", "trial.scene missing");
  ok(typeof rec.cost === "number" && rec.cost >= 0, "trial.cost (moves) missing");
  ok(typeof rec.durationMs === "number" && rec.durationMs >= 0, "trial.durationMs (time) missing");
  ok(rec.utteranceId != null && rec.speakerPid != null && rec.utteranceText != null, "replay provenance (utteranceId/speakerPid/text) missing");
  ok(rec.reason != null && rec.endedAt != null, "outcome (reason/endedAt) missing");

  // session carries the assignment too
  const [novSess] = (await db.select().from(sessions).where(eq(sessions.id, novices[0]!))) as any[];
  ok(novSess.assignment === "novice", "session.assignment missing");

  console.log("");
  if (problems.length) {
    console.error("✗ FAILED:\n" + problems.map((p) => `  - ${p}`).join("\n"));
    rmSync(DIR, { recursive: true, force: true });
    process.exit(1);
  }
  console.log("✓ verified: speakers-first recruitment, even distinct-per-condition draw,");
  console.log("  every utterance used, and a complete + accurate trial record.\n");
  rmSync(DIR, { recursive: true, force: true });
}

main().catch((e) => {
  console.error(e);
  rmSync(DIR, { recursive: true, force: true });
  process.exit(1);
});
