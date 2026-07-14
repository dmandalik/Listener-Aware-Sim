import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { startSpeakerSession } from "@/lib/server/listener";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
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
