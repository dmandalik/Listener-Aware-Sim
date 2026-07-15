import { NextResponse } from "next/server";
import { getPublicStudyConfig } from "@/lib/server/study-config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(getPublicStudyConfig());
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
