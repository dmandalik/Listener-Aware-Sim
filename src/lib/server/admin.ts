// ─────────────────────────────────────────────────────────────────────────────
// Admin data layer (§12): dashboard stats, exports, speaker-bonus, session replay.
// Gated by a single shared secret (ADMIN_SECRET) — no user accounts.
//
// The dataset is small (hundreds of rows), so stats are computed in JS for clarity
// rather than in SQL. `events` is never mutated — everything here is read-only.
// ─────────────────────────────────────────────────────────────────────────────

import { asc, eq } from "drizzle-orm";
import { env } from "@/lib/env";
import { ensureMigrated, getDb } from "@/lib/db/client";
import { events, participants, sessions, trials, utterances } from "@/lib/db/schema";

// §16 open item — tune this, then confirm. A speaker earns this per successful
// downstream listener trial across the utterances they authored.
const BONUS_PER_SUCCESS_USD = 0.05;
const BONUS_CAP_USD = 4.0;

export function checkAdminKey(key: string | null | undefined): boolean {
  return !!key && key === env().ADMIN_SECRET;
}

const TABLES = { events, trials, sessions, participants, utterances } as const;
export type TableName = keyof typeof TABLES;

async function all<T = any>(table: TableName): Promise<T[]> {
  const db = await getDb();
  return (await db.select().from(TABLES[table])) as T[];
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}

// ── Dashboard ────────────────────────────────────────────────────────────────

export interface Summary {
  sessions: { total: number; byStatus: Record<string, number>; byAssignment: Record<string, number> };
  cells: Array<{
    taskId: string;
    assignment: string;
    trials: number;
    completed: number;
    successRate: number | null;
    medianDurationMs: number | null;
    medianCost: number | null;
  }>;
  dropout: { abandoned: number; byTrialsCompleted: Record<string, number> };
  pool: { utterances: number; totalServed: number; avgSuccessRate: number | null };
}

export async function getSummary(): Promise<Summary> {
  await ensureMigrated();
  const [ss, ts, us] = await Promise.all([all("sessions"), all("trials"), all("utterances")]);

  const byStatus: Record<string, number> = {};
  const byAssignment: Record<string, number> = {};
  for (const s of ss) {
    byStatus[s.status] = (byStatus[s.status] ?? 0) + 1;
    const a = s.assignment ?? "unassigned";
    byAssignment[a] = (byAssignment[a] ?? 0) + 1;
  }

  // per (task, assignment) cell
  const cellMap = new Map<string, { taskId: string; assignment: string; correct: number[]; dur: number[]; cost: number[]; done: number; n: number }>();
  for (const t of ts) {
    const key = `${t.taskId}|${t.assignment ?? "?"}`;
    const c = cellMap.get(key) ?? { taskId: t.taskId, assignment: t.assignment ?? "?", correct: [] as number[], dur: [] as number[], cost: [] as number[], done: 0, n: 0 };
    c.n += 1;
    if (t.endedAt) c.done += 1;
    if (t.correct != null) c.correct.push(t.correct ? 1 : 0);
    if (t.durationMs != null) c.dur.push(Number(t.durationMs));
    if (t.cost != null) c.cost.push(t.cost);
    cellMap.set(key, c);
  }
  const cells = [...cellMap.values()]
    .map((c) => ({
      taskId: c.taskId,
      assignment: c.assignment,
      trials: c.n,
      completed: c.done,
      successRate: c.correct.length ? c.correct.reduce((a, b) => a + b, 0) / c.correct.length : null,
      medianDurationMs: median(c.dur),
      medianCost: median(c.cost),
    }))
    .sort((a, b) => a.taskId.localeCompare(b.taskId) || a.assignment.localeCompare(b.assignment));

  // dropout: non-completed sessions, and how far they got
  const trialsBySession = new Map<string, number>();
  for (const t of ts) trialsBySession.set(t.sessionId, (trialsBySession.get(t.sessionId) ?? 0) + 1);
  const byTrialsCompleted: Record<string, number> = {};
  let abandoned = 0;
  for (const s of ss) {
    if (s.status === "completed") continue;
    abandoned += 1;
    const got = trialsBySession.get(s.id) ?? 0;
    byTrialsCompleted[String(got)] = (byTrialsCompleted[String(got)] ?? 0) + 1;
  }

  const totalServed = us.reduce((a, u) => a + (u.timesServed ?? 0), 0);
  const rates = us.filter((u) => u.successRate != null).map((u) => u.successRate as number);
  return {
    sessions: { total: ss.length, byStatus, byAssignment },
    cells,
    dropout: { abandoned, byTrialsCompleted },
    pool: {
      utterances: us.length,
      totalServed,
      avgSuccessRate: rates.length ? rates.reduce((a, b) => a + b, 0) / rates.length : null,
    },
  };
}

// ── Export ───────────────────────────────────────────────────────────────────

function csvCell(v: unknown): string {
  if (v == null) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: any[]): string {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const head = cols.join(",");
  const body = rows.map((r) => cols.map((c) => csvCell(r[c])).join(",")).join("\n");
  return `${head}\n${body}`;
}

export function toJsonl(rows: any[]): string {
  return rows.map((r) => JSON.stringify(r)).join("\n");
}

export async function exportTable(table: TableName, format: "csv" | "jsonl"): Promise<string> {
  await ensureMigrated();
  const rows = await all(table);
  return format === "csv" ? toCsv(rows) : toJsonl(rows);
}

// ── Speaker bonus (§12) ──────────────────────────────────────────────────────

export interface BonusRow {
  PROLIFIC_PID: string;
  amount: number;
  successes: number;
  listenerTrials: number;
  utterances: number;
}

export async function getBonus(): Promise<BonusRow[]> {
  await ensureMigrated();
  const us = await all("utterances");
  const byPid = new Map<string, { successes: number; trials: number; utts: number }>();
  for (const u of us) {
    if (!u.authorPid) continue;
    const b = byPid.get(u.authorPid) ?? { successes: 0, trials: 0, utts: 0 };
    b.successes += u.listenerSuccesses ?? 0;
    b.trials += u.listenerTrials ?? 0;
    b.utts += 1;
    byPid.set(u.authorPid, b);
  }
  return [...byPid.entries()]
    .map(([pid, b]) => ({
      PROLIFIC_PID: pid,
      amount: Math.min(BONUS_CAP_USD, Math.round(b.successes * BONUS_PER_SUCCESS_USD * 100) / 100),
      successes: b.successes,
      listenerTrials: b.trials,
      utterances: b.utts,
    }))
    .sort((a, b) => b.amount - a.amount);
}

// ── Session replay ───────────────────────────────────────────────────────────

export async function listSessions() {
  await ensureMigrated();
  const [ss, ts] = await Promise.all([all("sessions"), all("trials")]);
  const trialCount = new Map<string, number>();
  for (const t of ts) trialCount.set(t.sessionId, (trialCount.get(t.sessionId) ?? 0) + 1);
  return ss
    .map((s) => ({
      id: s.id,
      pid: s.prolificPid,
      role: s.role,
      assignment: s.assignment,
      status: s.status,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      trials: trialCount.get(s.id) ?? 0,
    }))
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

export async function getSessionDetail(sid: string) {
  await ensureMigrated();
  const db = await getDb();
  const [sess] = await db.select().from(sessions).where(eq(sessions.id, sid));
  if (!sess) throw new Error(`Unknown session "${sid}"`);
  const [part] = await db.select().from(participants).where(eq(participants.prolificPid, sess.prolificPid));
  const trs = await db.select().from(trials).where(eq(trials.sessionId, sid)).orderBy(asc(trials.trialIndex));
  const evs = await db.select().from(events).where(eq(events.sessionId, sid)).orderBy(asc(events.id));
  // Only the fields useful for the stepper (the full payload is in `payload`).
  const timeline = (evs as any[]).map((e) => ({ t: e.t, ev: e.ev, trialIndex: e.trialIndex, payload: e.payload }));
  return {
    session: {
      id: sess.id, pid: sess.prolificPid, role: sess.role, assignment: sess.assignment,
      status: sess.status, startedAt: sess.startedAt, endedAt: sess.endedAt,
    },
    participant: part
      ? { name: part.name, dataSharingConsent: part.dataSharingConsent, studyId: part.studyId, sessionId: part.sessionId, userAgent: part.userAgent }
      : null,
    trials: (trs as any[]).map((t) => ({
      trialIndex: t.trialIndex, taskId: t.taskId, scene: t.scene, seed: t.seed,
      assignment: t.assignment, utteranceText: t.utteranceText, speakerPid: t.speakerPid,
      correct: t.correct, cost: t.cost, durationMs: t.durationMs, targetId: t.targetId,
      chosenId: t.chosenId, reason: t.reason,
    })),
    timeline,
  };
}
