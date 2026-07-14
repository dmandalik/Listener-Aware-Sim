// ─────────────────────────────────────────────────────────────────────────────
// Run a retrieval trial headlessly with a scripted bot (§14.2). CLI-runnable.
//
//   npm run headless -- --bot oracle
//   npm run headless -- --bot move-only --seed 7
//   npm run headless -- --condition retrieval_robot_novice --bot oracle
//   npm run headless -- --bot oracle --persist     (also writes to a throwaway DB)
//
// Prints the event stream and the outcome. With --persist, it migrates a fresh
// PGlite database and commits the events through the real writer, proving the
// engine → event log → database path end-to-end.
// ─────────────────────────────────────────────────────────────────────────────

import "dotenv/config";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Condition } from "@/lib/types";

function arg(name: string, dflt?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  return dflt;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

async function main() {
  const {
    loadBuiltinMaps,
    retrievalTask,
    retrievalAdapter,
    runTrial,
    oracleRetrievalBot,
    randomBot,
    moveOnlyBot,
  } = await import("@/lib/engine");
  loadBuiltinMaps();

  const botName = arg("bot", "oracle")!;
  const policy =
    botName === "random" ? randomBot : botName === "move-only" ? moveOnlyBot : oracleRetrievalBot;

  const { loadCondition } = await import("@/lib/config");
  let cond: Condition;
  const condName = arg("condition");
  if (condName) {
    cond = loadCondition(condName);
  } else {
    cond = {
      taskId: "retrieval",
      scene: "retrieval_6room",
      keys: { sceneLabels: "all", partsKey: false, controlKey: false },
      viewpoint: (arg("viewpoint", "aligned") as "aligned" | "rotated") ?? "aligned",
      budget: Number(arg("budget", "40")),
      timeoutMs: 300_000,
      speakerBriefing: "novice",
      speakerMode: "scripted",
      utteranceSource: { text: "Grab the charger in the supply room." },
      allowFollowups: false,
      followupReply: "n/a",
      seed: Number(arg("seed", "1234")),
    };
  }
  const seed = Number(arg("seed")) || cond.seed;

  console.log(`\n▶ retrieval — bot=${botName} seed=${seed} viewpoint=${cond.viewpoint} budget=${cond.budget}`);
  console.log(`  keys: partsKey=${cond.keys.partsKey} sceneLabels=${cond.keys.sceneLabels}\n`);

  const sid = randomUUID();

  // Optional persistence path.
  let persist: ((e: any) => Promise<void>) | null = null;
  const VERIFY_DIR = join(process.cwd(), ".pglite-headless");
  if (flag("persist")) {
    process.env.DB_DRIVER = "pglite";
    process.env.PGLITE_DATA_DIR = VERIFY_DIR;
    rmSync(VERIFY_DIR, { recursive: true, force: true });
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    const schema = await import("@/lib/db/schema");
    const pg = new PGlite(VERIFY_DIR);
    await migrate(drizzle(pg, { schema }), { migrationsFolder: join(process.cwd(), "drizzle") });
    await pg.close();
    const { upsertParticipant, startSession, openTrial, writeEvent, closeTrial, endSession } =
      await import("@/lib/db/writer");
    const pid = `BOT_${botName}`;
    await upsertParticipant({
      prolificPid: pid,
      studyId: "headless",
      sessionId: "headless",
      role: "listener",
    });
    await startSession({ id: sid, prolificPid: pid, role: "listener", plan: [cond] });
    await openTrial({
      sessionId: sid,
      trialIndex: 0,
      taskId: cond.taskId,
      seed,
      condition: cond,
      utteranceText: cond.utteranceSource?.text ?? null,
      targetId: retrievalTask.init(seed, cond).world.target,
    });
    persist = async (e) => void (await writeEvent(e));
    // Close over trial/session at the end.
    (globalThis as any).__finish = async (o: any) => {
      // there is exactly one trial (index 0)
      const { getDb } = await import("@/lib/db/client");
      const { trials } = await import("@/lib/db/schema");
      const { eq } = await import("drizzle-orm");
      const db = await getDb();
      const [tr] = await db.select().from(trials).where(eq(trials.sessionId, sid));
      await closeTrial({
        trialId: tr.id,
        correct: o.correct,
        cost: o.cost,
        chosenId: o.chosenId,
        reason: o.reason,
      });
      await endSession(sid, "completed");
    };
  }

  let n = 0;
  const outcome = await runTrial({
    sid,
    task: retrievalTask,
    cond,
    seed,
    policy,
    adapter: retrievalAdapter,
    sink: async (e) => {
      n++;
      const brief =
        e.ev === "listener_action"
          ? `${(e as any).action} → ${(e as any).resolved ?? "-"}  [budget ${(e as any).budgetLeft}] room=${(e as any).room}`
          : e.ev === "room_entered"
            ? `room=${(e as any).room} revealed=[${(e as any).objectsRevealed.join(",")}]`
            : e.ev === "trial_end"
              ? `correct=${(e as any).correct} cost=${(e as any).cost} chosen=${(e as any).chosen} reason=${(e as any).reason}`
              : "";
      console.log(`  ${String(n).padStart(2)}  ${e.ev.padEnd(16)} ${brief}`);
      if (persist) await persist(e);
    },
  });

  if (flag("persist")) {
    await (globalThis as any).__finish(outcome);
    console.log("\n  ✓ persisted to a throwaway PGlite DB (events committed through the writer)");
    rmSync(VERIFY_DIR, { recursive: true, force: true });
  }

  console.log(
    `\n${outcome.correct ? "✓" : "✗"} outcome: correct=${outcome.correct} cost=${outcome.cost} reason=${outcome.reason}\n`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
