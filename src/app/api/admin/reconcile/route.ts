import { NextResponse } from "next/server";
import { ensureMigrated } from "@/lib/db/client";
import { reconcileUtteranceCounters } from "@/lib/db/writer";
import { checkAdminKey } from "@/lib/server/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Admin-only: recompute every utterance's pool counters (served/completed/
// listenerTrials/successRate) from the actual trials. Heals any drift left by
// sessions removed before counter-rollback existed. Read-only w.r.t. trials/events;
// only the aggregate columns on `utterances` change. Gated by ADMIN_SECRET.
export async function POST(req: Request) {
  const key = req.headers.get("x-admin-key") ?? new URL(req.url).searchParams.get("key");
  if (!checkAdminKey(key)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    await ensureMigrated();
    const result = await reconcileUtteranceCounters();
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
