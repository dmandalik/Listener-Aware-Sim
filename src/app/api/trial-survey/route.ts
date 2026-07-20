import { NextResponse } from "next/server";
import { saveTrialSurvey } from "@/lib/server/listener";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TLX = ["tlxMental", "tlxPhysical", "tlxTemporal", "tlxPerformance", "tlxEffort", "tlxFrustration"] as const;

// Save one trial's NASA-TLX rating (six 0–100 items). `feedback` is optional and only
// sent with the final trial.
export async function POST(req: Request) {
  try {
    const b = await req.json();
    if (typeof b?.sessionId !== "string" || !Number.isInteger(b?.trialIndex)) {
      return NextResponse.json({ error: "sessionId (string) and trialIndex (int) required" }, { status: 400 });
    }
    const tlx: Record<string, number> = {};
    for (const k of TLX) {
      const v = Number(b[k]);
      if (!Number.isFinite(v) || v < 0 || v > 100) {
        return NextResponse.json({ error: `${k} must be a number 0–100` }, { status: 400 });
      }
      tlx[k] = Math.round(v);
    }
    await saveTrialSurvey({
      sessionId: b.sessionId,
      trialIndex: b.trialIndex,
      feedback: typeof b.feedback === "string" ? b.feedback.slice(0, 2000) : null,
      tlxMental: tlx.tlxMental!,
      tlxPhysical: tlx.tlxPhysical!,
      tlxTemporal: tlx.tlxTemporal!,
      tlxPerformance: tlx.tlxPerformance!,
      tlxEffort: tlx.tlxEffort!,
      tlxFrustration: tlx.tlxFrustration!,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
