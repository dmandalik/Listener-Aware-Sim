import { NextResponse } from "next/server";
import { ensureMigrated } from "@/lib/db/client";
import { purgeIncompleteSessions } from "@/lib/db/writer";
import { checkAdminKey } from "@/lib/server/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Admin-only: force a sweep of abandoned runs (unfinished AND idle) right now, instead
// of waiting for the next participant to arrive. `minIdleMinutes` (default 120) is the
// safety guard — a session that emitted an event more recently than that is left alone,
// so an active participant is never removed. Only pass a small value when you know no
// one is currently playing (e.g. tidying up after a lab session).
export async function POST(req: Request) {
  const key = req.headers.get("x-admin-key") ?? new URL(req.url).searchParams.get("key");
  if (!checkAdminKey(key)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const body = await req.json().catch(() => ({}) as any);
    const raw = body?.minIdleMinutes ?? new URL(req.url).searchParams.get("minIdleMinutes");
    const minIdle = raw == null || raw === "" ? 120 : Number(raw);
    if (!Number.isFinite(minIdle) || minIdle < 0) {
      return NextResponse.json({ error: "minIdleMinutes must be a non-negative number" }, { status: 400 });
    }
    await ensureMigrated();
    const result = await purgeIncompleteSessions(minIdle);
    return NextResponse.json({ ok: true, minIdleMinutes: minIdle, ...result });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
