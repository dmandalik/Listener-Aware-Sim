import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { startSpeakerSession } from "@/lib/server/listener";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// DEV ONLY. This starts an anonymous session under an arbitrary study, bypassing
// consent, the entry form, and balanced assignment — real participants are routed
// through /play and resume by `sid`. Left open in production it silently pollutes
// the study data with nameless DEV_ sessions that also consume recruitment slots.
export async function POST(req: Request) {
  try {
    if (process.env.NODE_ENV === "production") {
      return NextResponse.json(
        { error: "Direct session start is disabled. Open the study from the front page." },
        { status: 403 },
      );
    }
    const body = await req.json().catch(() => ({}));
    const studyName: string = body.studyName ?? "speaker_pilot";
    const p = body.prolific ?? {};
    const prolific = {
      pid: p.pid ?? `DEV_${randomUUID().slice(0, 8)}`,
      studyId: p.studyId ?? "DEV_STUDY",
      sessionId: p.sessionId ?? `DEV_${randomUUID().slice(0, 8)}`,
    };
    const payload = await startSpeakerSession({
      studyName,
      prolific,
      userAgent: req.headers.get("user-agent") ?? undefined,
    });
    return NextResponse.json(payload);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
