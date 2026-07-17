import { NextResponse } from "next/server";
import { checkViewKey, exportTable, EXPORT_NAMES, type ExportName } from "@/lib/server/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authed(req: Request): boolean {
  const key = req.headers.get("x-admin-key") ?? new URL(req.url).searchParams.get("key");
  return checkViewKey(key);
}

export async function GET(req: Request) {
  if (!authed(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const u = new URL(req.url);
  const table = u.searchParams.get("table") as ExportName | null;
  const format = (u.searchParams.get("format") ?? "csv") === "jsonl" ? "jsonl" : "csv";
  if (!table || !EXPORT_NAMES.includes(table)) {
    return NextResponse.json({ error: `table must be one of ${EXPORT_NAMES.join(", ")}` }, { status: 400 });
  }
  try {
    const data = await exportTable(table, format);
    const ext = format === "csv" ? "csv" : "jsonl";
    const mime = format === "csv" ? "text/csv" : "application/x-ndjson";
    return new Response(data, {
      headers: {
        "Content-Type": `${mime}; charset=utf-8`,
        "Content-Disposition": `attachment; filename="${table}.${ext}"`,
      },
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
