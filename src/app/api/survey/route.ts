import { NextResponse } from "next/server";
import { saveSurvey } from "@/lib/server/listener";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const str = (v: unknown, max = 200): string | null =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;
const tlx = (v: unknown): number | null =>
  typeof v === "number" && isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : null;

// End-of-study survey: demographics + NASA-TLX + open feedback. One per session.
export async function POST(req: Request) {
  try {
    const b = await req.json().catch(() => ({}));
    if (typeof b.sessionId !== "string") {
      return NextResponse.json({ error: "sessionId is required" }, { status: 400 });
    }
    const race = Array.isArray(b.race)
      ? (b.race as unknown[]).filter((x) => typeof x === "string").slice(0, 12)
      : null;
    await saveSurvey({
      sessionId: b.sessionId,
      ageRange: str(b.ageRange, 40),
      gender: str(b.gender, 60),
      genderOther: str(b.genderOther, 120),
      race: race as string[] | null,
      raceOther: str(b.raceOther, 120),
      tlxMental: tlx(b.tlxMental),
      tlxPhysical: tlx(b.tlxPhysical),
      tlxTemporal: tlx(b.tlxTemporal),
      tlxPerformance: tlx(b.tlxPerformance),
      tlxEffort: tlx(b.tlxEffort),
      tlxFrustration: tlx(b.tlxFrustration),
      feedback: str(b.feedback, 2000),
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
