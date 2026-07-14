import { NextResponse } from "next/server";
import { timeoutListenerTrial } from "@/lib/server/listener";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const { sessionId, trialIndex } = await req.json();
    if (typeof sessionId !== "string" || typeof trialIndex !== "number") {
      return NextResponse.json(
        { error: "sessionId (string) and trialIndex (number) are required" },
        { status: 400 },
      );
    }
    const payload = await timeoutListenerTrial({ sessionId, trialIndex });
    return NextResponse.json(payload);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
