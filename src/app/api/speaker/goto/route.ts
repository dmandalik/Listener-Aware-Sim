import { NextResponse } from "next/server";
import { goToSpeakerTrial } from "@/lib/server/listener";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Move the speaker to a specific scene index — used by both "Next scene" and the
// "Back" button so a participant can review/edit an earlier utterance.
export async function POST(req: Request) {
  try {
    const { sessionId, index } = await req.json();
    if (typeof sessionId !== "string") {
      return NextResponse.json({ error: "sessionId (string) is required" }, { status: 400 });
    }
    if (typeof index !== "number" || !Number.isInteger(index)) {
      return NextResponse.json({ error: "index (integer) is required" }, { status: 400 });
    }
    const payload = await goToSpeakerTrial(sessionId, index);
    return NextResponse.json(payload);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
