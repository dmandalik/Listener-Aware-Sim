import { NextResponse } from "next/server";
import { verifyAttention } from "@/lib/server/study-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const { answer } = await req.json();
    return NextResponse.json({ pass: verifyAttention(answer) });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
