import { NextResponse } from "next/server";
import { checkViewKey, exportTable, ANON_EXPORT_NAMES, EXPORT_NAMES, type ExportName } from "@/lib/server/admin";

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
  const anonymize = u.searchParams.get("anon") === "1";
  if (!table || !EXPORT_NAMES.includes(table)) {
    return NextResponse.json({ error: `table must be one of ${EXPORT_NAMES.join(", ")}` }, { status: 400 });
  }
  if (anonymize && !ANON_EXPORT_NAMES.includes(table)) {
    return NextResponse.json({ error: `table "${table}" has no anonymized version (it's PII-only, e.g. contacts)` }, { status: 400 });
  }
  try {
    const data = await exportTable(table, format, { anonymize });
    const ext = format === "csv" ? "csv" : "jsonl";
    const mime = format === "csv" ? "text/csv" : "application/x-ndjson";
    const base = anonymize ? `${table}_anonymized` : table;
    return new Response(data, {
      headers: {
        "Content-Type": `${mime}; charset=utf-8`,
        "Content-Disposition": `attachment; filename="${base}.${ext}"`,
      },
    });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
