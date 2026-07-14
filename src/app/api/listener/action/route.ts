import { NextResponse } from "next/server";
import { applyListenerAction } from "@/lib/server/listener";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { sessionId, trialIndex, action, viewAs } = body ?? {};
    if (typeof sessionId !== "string" || typeof trialIndex !== "number") {
      return NextResponse.json(
        { error: "sessionId (string) and trialIndex (number) are required" },
        { status: 400 },
      );
    }
    const payload = await applyListenerAction({ sessionId, trialIndex, action, viewAs });
    return NextResponse.json(payload);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
