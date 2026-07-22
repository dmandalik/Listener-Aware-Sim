import { NextResponse } from "next/server";
import { checkViewKey } from "@/lib/server/admin";
import { pddlIndex, pddlOne, pddlBundleJsonl } from "@/lib/server/pddl";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authed(req: Request): boolean {
  const key = req.headers.get("x-admin-key") ?? new URL(req.url).searchParams.get("key");
  return checkViewKey(key);
}

// GET /api/admin/pddl               → { models: [...index...] }
// GET /api/admin/pddl?one=<key>     → { problem, profile, domain }
// GET /api/admin/pddl?download=1    → all models as a downloadable .jsonl bundle
export async function GET(req: Request) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const u = new URL(req.url);
  try {
    if (u.searchParams.get("download")) {
      const body = await pddlBundleJsonl();
      return new Response(body, {
        headers: {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Content-Disposition": `attachment; filename="pddl_models.jsonl"`,
        },
      });
    }
    const one = u.searchParams.get("one");
    if (one) {
      const model = await pddlOne(one);
      if (!model) return NextResponse.json({ error: "not found" }, { status: 404 });
      return NextResponse.json(model);
    }
    return NextResponse.json({ models: await pddlIndex() });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
