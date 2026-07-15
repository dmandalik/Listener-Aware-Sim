// Populate the LOCAL dev database (./.pglite) with a realistic demo dataset so the
// /admin dashboard has something to show: 5 speakers (author + complete), 5 novices
// and 5 experts (most completed, a couple abandoned for dropout data).
//
// Run with the dev server stopped:  npm run seed:demo

import "dotenv/config";
process.env.DB_DRIVER = "pglite";
process.env.PGLITE_DATA_DIR = process.env.PGLITE_DATA_DIR ?? "./.pglite";

async function main() {
  const {
    startSpeakerSession, saveSpeakerUtterance, advanceSpeakerTrial,
    startListenerSession, advanceListenerTrial, applyListenerAction,
  } = await import("@/lib/server/listener");
  const { oracleRetrievalBot } = await import("@/lib/engine");
  const { getDb } = await import("@/lib/db/client");
  const { trials } = await import("@/lib/db/schema");
  const { and, eq } = await import("drizzle-orm");
  const db = await getDb();

  const drive = async (sid: string, idx: number) => {
    for (;;) {
      const [row] = await db.select().from(trials).where(and(eq(trials.sessionId, sid), eq(trials.trialIndex, idx)));
      if (!row || row.endedAt) break;
      const action = oracleRetrievalBot({ state: row.state } as any);
      const p = await applyListenerAction({ sessionId: sid, trialIndex: idx, action });
      if (p.terminal) break;
    }
  };

  // Speakers author + complete.
  const samples = [
    "Grab the charger in the far top-left storage bay.",
    "Head to the top-right loading dock for the camera part.",
    "The control board is in the tall middle lab room.",
  ];
  for (let i = 0; i < 5; i++) {
    const p = await startSpeakerSession({ studyName: "main_speaker", prolific: { pid: `SPEAK_${i}`, studyId: "demo", sessionId: `sp${i}` } });
    let cur = p;
    for (let t = 0; t < 3 && !cur.done; t++) {
      await saveSpeakerUtterance({ sessionId: cur.sessionId, trialIndex: t, text: `[${i}] ${samples[t]}` });
      cur = await advanceSpeakerTrial(cur.sessionId);
    }
  }
  console.log("✓ 5 speakers authored + completed");

  // Listeners: novices then experts. Complete most; abandon a couple.
  const runListener = async (assignment: "novice" | "expert", i: number, complete: boolean) => {
    const p = await startListenerSession({
      studyName: "main_listener",
      prolific: { pid: `${assignment.toUpperCase()}_${i}`, studyId: "demo", sessionId: `${assignment}${i}` },
      assignment,
    });
    if (!complete) {
      await drive(p.sessionId, 0); // finish just the first mission, then drop
      return;
    }
    let idx = 0;
    for (;;) {
      await drive(p.sessionId, idx);
      const next = await advanceListenerTrial(p.sessionId);
      if (next.done) break;
      idx += 1;
    }
  };
  for (let i = 0; i < 5; i++) await runListener("novice", i, i < 4); // 4 complete, 1 abandon
  for (let i = 0; i < 5; i++) await runListener("expert", i, i < 4);
  console.log("✓ 5 novices + 5 experts (8 completed, 2 abandoned)");
  console.log("\nDone. Start the dev server and open /admin.\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
