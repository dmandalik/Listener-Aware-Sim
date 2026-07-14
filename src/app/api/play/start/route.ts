import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { assignAndStart } from "@/lib/server/listener";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Single entry point: balanced-random assignment to speaker / novice / expert,
// then start the matching session. Returns where to route the participant.
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const p = body.prolific ?? {};
    const prolific = {
      pid: p.pid ?? `DEV_${randomUUID().slice(0, 8)}`,
      studyId: p.studyId ?? "DEV_STUDY",
      sessionId: p.sessionId ?? `DEV_${randomUUID().slice(0, 8)}`,
    };
    const result = await assignAndStart({
      prolific,
      userAgent: req.headers.get("user-agent") ?? undefined,
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
