import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { assignAndStart } from "@/lib/server/listener";
import { getPublicStudyConfig } from "@/lib/server/study-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Single entry point: assign per the recruitment policy, start the matching
// session, return where to route the participant. In production the real Prolific
// identity is REQUIRED — never a null/dev participant (§8, §15).
export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}));
    const p = body.prolific ?? {};
    const requireProlific = getPublicStudyConfig().requireProlific;

    if (requireProlific && (!p.pid || !p.studyId || !p.sessionId)) {
      return NextResponse.json(
        { error: "Missing Prolific identity — open this study from Prolific." },
        { status: 400 },
      );
    }
    const prolific = {
      pid: p.pid ?? `DEV_${randomUUID().slice(0, 8)}`,
      studyId: p.studyId ?? "DEV_STUDY",
      sessionId: p.sessionId ?? `DEV_${randomUUID().slice(0, 8)}`,
    };
    const result = await assignAndStart({
      prolific,
      name: typeof body.name === "string" ? body.name.trim().slice(0, 120) || null : null,
      dataSharingConsent: typeof body.dataSharingConsent === "boolean" ? body.dataSharingConsent : null,
      userAgent: req.headers.get("user-agent") ?? undefined,
    });
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
