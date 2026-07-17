import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { startListenerSession } from "@/lib/server/listener";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// DEV ONLY. Starts an anonymous session under an arbitrary study AND lets the caller
// force their own novice/expert assignment — which would void the manipulation (§9.6)
// if reachable by a participant. Real participants are routed through /play (balanced
// assignment, consent, entry form) and resume by `sid`, so this stays off in prod.
export async function POST(req: Request) {
  try {
    if (process.env.NODE_ENV === "production") {
      return NextResponse.json(
        { error: "Direct session start is disabled. Open the study from the front page." },
        { status: 403 },
      );
    }
    const body = await req.json().catch(() => ({}));
    const studyName: string = body.studyName ?? "listener_pilot";

    // Prolific identity (§8). Enforced hard in M6; for now a dev fallback keeps the
    // flow playable locally. A real participant always arrives with these params.
    const p = body.prolific ?? {};
    const prolific = {
      pid: p.pid ?? `DEV_${randomUUID().slice(0, 8)}`,
      studyId: p.studyId ?? "DEV_STUDY",
      sessionId: p.sessionId ?? `DEV_${randomUUID().slice(0, 8)}`,
    };

    // Dev convenience: allow forcing the novice/expert assignment. In production
    // participants always arrive via /play, which sets this from the recruitment.
    const assignment =
      body.assignment === "novice" || body.assignment === "expert" ? body.assignment : null;

    const payload = await startListenerSession({
      studyName,
      prolific,
      assignment,
      userAgent: req.headers.get("user-agent") ?? undefined,
    });
    return NextResponse.json(payload);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
