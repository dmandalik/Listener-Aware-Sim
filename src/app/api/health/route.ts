import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { ensureMigrated, getDb } from "@/lib/db/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Liveness + keep-warm. A cheap DB round-trip that (a) confirms the app can reach
// Postgres, and (b) wakes a suspended Neon instance so the next real participant
// doesn't eat a cold start. Point a cron / uptime pinger at this every few minutes
// (see docs/deploy.md). No secrets, no participant data — safe to call publicly.
export async function GET() {
  try {
    await ensureMigrated();
    const db = await getDb();
    await (db as unknown as { execute: (q: unknown) => Promise<unknown> }).execute(sql`select 1`);
    return NextResponse.json({ ok: true, db: "up" });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message }, { status: 503 });
  }
}
