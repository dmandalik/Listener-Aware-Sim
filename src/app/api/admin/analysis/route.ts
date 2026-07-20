import { NextResponse } from "next/server";
import { checkViewKey, getAnalysis } from "@/lib/server/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authed(req: Request): boolean {
  const key = req.headers.get("x-admin-key") ?? new URL(req.url).searchParams.get("key");
  return checkViewKey(key);
}

export async function GET(req: Request) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const analysis = await getAnalysis();
    return NextResponse.json({ ...analysis, generatedAt: new Date().toISOString() });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
