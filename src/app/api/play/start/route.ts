import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { assignAndStart, saveSurvey } from "@/lib/server/listener";
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
    const clean = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 80) || null : null);
    const firstName = clean(body.firstName);
    const lastName = clean(body.lastName);
    const combined = [firstName, lastName].filter(Boolean).join(" ") || clean(body.name);
    const result = await assignAndStart({
      prolific,
      name: combined,
      firstName,
      lastName,
      // Sharing de-identified data is stated in the consent form and implied by
      // agreeing to proceed — there is no separate opt-in, so record it as given.
      dataSharingConsent: true,
      userAgent: req.headers.get("user-agent") ?? undefined,
    });

    // Demographics are collected up front (with the name). Save them onto this
    // session's survey row now; NASA-TLX + feedback merge into the same row at the end.
    const race = Array.isArray(body.race)
      ? (body.race as unknown[]).filter((x) => typeof x === "string").slice(0, 12)
      : null;
    const demo = {
      ageRange: clean(body.ageRange),
      gender: clean(body.gender),
      genderOther: clean(body.genderOther),
      race: race as string[] | null,
      raceOther: clean(body.raceOther),
    };
    if (demo.ageRange || demo.gender || demo.genderOther || (race && race.length) || demo.raceOther) {
      await saveSurvey({ sessionId: result.sessionId, ...demo });
    }
    return NextResponse.json(result);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
