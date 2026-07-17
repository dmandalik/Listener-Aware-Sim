import { NextResponse } from "next/server";
import { ensureMigrated } from "@/lib/db/client";
import { deleteSessionsByPid } from "@/lib/db/writer";
import { checkAdminKey } from "@/lib/server/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Admin-only: surgically remove test/dev participants by Prolific PID, rolling back
// any pool serves/outcomes their runs contributed (so real utterances' counters stay
// honest). Gated by ADMIN_SECRET. Intended for clearing junk rows without a full DB
// reset — never for real participants.
export async function POST(req: Request) {
  const key = req.headers.get("x-admin-key") ?? new URL(req.url).searchParams.get("key");
  if (!checkAdminKey(key)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const body = await req.json().catch(() => ({}));
    const pids: unknown = body.pids;
    if (!Array.isArray(pids) || pids.some((p) => typeof p !== "string") || pids.length === 0) {
      return NextResponse.json({ error: "pids (non-empty string[]) is required" }, { status: 400 });
    }
    await ensureMigrated();
    const result = await deleteSessionsByPid(pids as string[]);
    return NextResponse.json({ ok: true, deletedPids: pids, ...result });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
