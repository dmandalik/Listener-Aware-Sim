import { NextResponse } from "next/server";
import { checkAdminKey, getSessionDetail, listSessions } from "@/lib/server/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authed(req: Request): boolean {
  const key = req.headers.get("x-admin-key") ?? new URL(req.url).searchParams.get("key");
  return checkAdminKey(key);
}

export async function GET(req: Request) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const sid = new URL(req.url).searchParams.get("sid");
  try {
    if (sid) return NextResponse.json(await getSessionDetail(sid));
    return NextResponse.json(await listSessions());
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
