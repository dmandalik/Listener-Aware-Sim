import { NextResponse } from "next/server";
import { checkViewKey, getBonus, toCsv } from "@/lib/server/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authed(req: Request): boolean {
  const key = req.headers.get("x-admin-key") ?? new URL(req.url).searchParams.get("key");
  return checkViewKey(key);
}

export async function GET(req: Request) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const format = new URL(req.url).searchParams.get("format");
  try {
    const rows = await getBonus();
    if (format === "csv") {
      // Prolific wants exactly PROLIFIC_PID, amount.
      const csv = toCsv(rows.map((r) => ({ PROLIFIC_PID: r.PROLIFIC_PID, amount: r.amount })));
      return new Response(csv, {
        headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="bonus.csv"' },
      });
    }
    return NextResponse.json(rows);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
