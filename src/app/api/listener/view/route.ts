import { NextResponse } from "next/server";
import { viewListenerTrial } from "@/lib/server/listener";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Re-render the current trial's view under an optional dev-only novice/expert
// override. Applies nothing, logs nothing. The override is server-gated to
// non-production in the session layer.
export async function POST(req: Request) {
  try {
    const { sessionId, trialIndex, viewAs } = await req.json();
    if (typeof sessionId !== "string" || typeof trialIndex !== "number") {
      return NextResponse.json(
        { error: "sessionId (string) and trialIndex (number) are required" },
        { status: 400 },
      );
    }
    const payload = await viewListenerTrial({ sessionId, trialIndex, viewAs });
    return NextResponse.json(payload);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
