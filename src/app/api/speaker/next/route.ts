import { NextResponse } from "next/server";
import { advanceSpeakerTrial } from "@/lib/server/listener";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const { sessionId } = await req.json();
    if (typeof sessionId !== "string") {
      return NextResponse.json({ error: "sessionId (string) is required" }, { status: 400 });
    }
    const payload = await advanceSpeakerTrial(sessionId);
    return NextResponse.json(payload);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
