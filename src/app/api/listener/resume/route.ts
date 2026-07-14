import { NextResponse } from "next/server";
import { resumeListenerSession } from "@/lib/server/listener";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const { sessionId } = await req.json();
    if (typeof sessionId !== "string") {
      return NextResponse.json({ error: "sessionId (string) is required" }, { status: 400 });
    }
    return NextResponse.json(await resumeListenerSession(sessionId));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
