// ─────────────────────────────────────────────────────────────────────────────
// Milestone 4 acceptance (§14.4): "replay works end-to-end: Study 1 writes,
// Study 2 reads."
//
// Speaker study saves an utterance → the pool. A replay listener study then
// draws it and serves the SAME utterance to a novice AND an expert listener
// (the within-utterance comparison, §8), with the event log tracing each replay
// back to the authoring speaker session.
//
// Run: npm run verify:replay
// ─────────────────────────────────────────────────────────────────────────────

import "dotenv/config";
import { rmSync } from "node:fs";
import { join } from "node:path";

const DIR = join(process.cwd(), ".pglite-replay");
process.env.DB_DRIVER = "pglite";
process.env.PGLITE_DATA_DIR = DIR;

function line(l: string, v: string) {
  console.log(`  ${l.padEnd(24)} ${v}`);
}

async function main() {
  rmSync(DIR, { recursive: true, force: true });
  console.log("\n▶ Milestone 4 — speaker pool → replay\n");

  const { startSpeakerSession, saveSpeakerUtterance, startListenerSession, advanceListenerTrial } =
    await import("@/lib/server/listener");

  // Study 1 — speaker authors an utterance for seed 5001.
  const sp = await startSpeakerSession({
    studyName: "speaker_pilot",
    prolific: { pid: "SPK1", studyId: "s1", sessionId: "spk" },
  });
  const speakerSid = sp.sessionId;
  const text = "Go up into the top-right room, then left across the top to the far corner; grab the star.";
  await saveSpeakerUtterance({ sessionId: speakerSid, trialIndex: 0, text });
  line("speaker session", speakerSid.slice(0, 8));
  line("saved utterance", `"${text.slice(0, 40)}…"`);

  // Study 2 — replay listeners draw from the pool.
  const li = await startListenerSession({
    studyName: "listener_replay",
    prolific: { pid: "LIS1", studyId: "s2", sessionId: "lis" },
  });
  line("listener t0 (novice)", `"${li.utterance.slice(0, 40)}…"`);
  const li1 = await advanceListenerTrial(li.sessionId);
  line("listener t1 (expert)", `"${li1.utterance.slice(0, 40)}…"`);

  // Traceability + pool bookkeeping.
  const { getDb } = await import("@/lib/db/client");
  const { events, utterances } = await import("@/lib/db/schema");
  const { eq } = await import("drizzle-orm");
  const db = await getDb();

  const evs = (await db.select().from(events).where(eq(events.sessionId, li.sessionId))) as any[];
  const replays = evs.filter((e) => e.ev === "utterance_replayed");
  const traced = replays.every((r) => r.payload.speakerSessionId === speakerSid);

  const pool = (await db.select().from(utterances)) as any[];
  const served5001 = pool.find((u) => u.seed === 5001);

  console.log("");
  line("replay events", String(replays.length));
  line("traced to speaker", String(traced));
  line("pool timesServed", `${served5001?.timesServed} (seed 5001)`);

  const problems: string[] = [];
  if (li.utterance !== text) problems.push("novice replay did not serve the speaker's utterance");
  if (li1.utterance !== text) problems.push("expert replay did not serve the speaker's utterance");
  if (!traced) problems.push("utterance_replayed events not traced to the speaker session");
  if (served5001?.timesServed !== 2) problems.push(`timesServed expected 2, got ${served5001?.timesServed}`);

  console.log("");
  if (problems.length) {
    console.error("✗ FAILED:\n" + problems.map((p) => `  - ${p}`).join("\n"));
    rmSync(DIR, { recursive: true, force: true });
    process.exit(1);
  }
  console.log("✓ M4 verified: same speaker utterance replayed to novice + expert, traced to author.\n");
  rmSync(DIR, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  rmSync(DIR, { recursive: true, force: true });
  process.exit(1);
});
