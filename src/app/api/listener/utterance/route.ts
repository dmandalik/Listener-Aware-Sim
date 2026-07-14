import { NextResponse } from "next/server";
import { saveSpeakerUtterance } from "@/lib/server/listener";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Save a speaker's utterance to the pool. (Dev speaker view / seed of the M4
// speaker study — the real /speaker flow will reuse saveSpeakerUtterance.)
export async function POST(req: Request) {
  try {
    const { sessionId, trialIndex, text, composeMs } = await req.json();
    if (typeof sessionId !== "string" || typeof trialIndex !== "number") {
      return NextResponse.json(
        { error: "sessionId (string) and trialIndex (number) are required" },
        { status: 400 },
      );
    }
    const result = await saveSpeakerUtterance({ sessionId, trialIndex, text, composeMs });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
