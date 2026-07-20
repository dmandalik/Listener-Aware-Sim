// ─────────────────────────────────────────────────────────────────────────────
// Admin data layer (§12): dashboard stats, exports, session replay.
// Gated by a single shared secret (ADMIN_SECRET) — no user accounts.
//
// The dataset is small (hundreds of rows), so stats are computed in JS for clarity
// rather than in SQL. `events` is never mutated — everything here is read-only.
// ─────────────────────────────────────────────────────────────────────────────

import { asc, eq } from "drizzle-orm";
import { env } from "@/lib/env";
import { ensureMigrated, getDb } from "@/lib/db/client";
import { events, participants, sessions, surveys, trials, trialSurveys, utterances } from "@/lib/db/schema";
import { isTestParticipant } from "@/lib/test-participant";

/** Full admin: required for destructive actions (purge, delete-session). */
export function checkAdminKey(key: string | null | undefined): boolean {
  return !!key && key === env().ADMIN_SECRET;
}

/** Read/view access: the full admin key OR the optional read-only viewer password.
 *  Gates the dashboard + every data export, but never a destructive endpoint. */
export function checkViewKey(key: string | null | undefined): boolean {
  if (!key) return false;
  const e = env();
  return key === e.ADMIN_SECRET || (!!e.ADMIN_VIEW_SECRET && key === e.ADMIN_VIEW_SECRET);
}

const TABLES = { events, trials, sessions, participants, utterances, surveys, trialSurveys } as const;
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

// Stable multi-key sort so each analysis export reads in a human-checkable order —
// crucially, every participant's rows are CONTIGUOUS (grouped by author, then task +
// layout), so "did this speaker give all 6 utterances?" is answerable at a glance.
// Without this the rows scatter by insertion id and completeness is easy to misread.
function orderBy(...keys: string[]) {
  return (a: any, b: any) => {
    for (const k of keys) {
      const av = a[k] ?? "";
      const bv = b[k] ?? "";
      if (av < bv) return -1;
      if (av > bv) return 1;
    }
    return 0;
  };
}

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

// ── Clean joined "views" for analysis (no state/condition blobs) ──────────────
// These flatten just the useful columns across tables so you get one tidy CSV per
// concern instead of raw dumps. Exposed through the same export endpoint.
//
// COMPLETE-ONLY: a session counts as complete once the participant FINISHED EVERY
// GAME (sessions.status flips to "completed" when they pass the last trial). The end
// survey is NOT the bar — a full gameplay run is the data, and discarding it because
// someone closed the tab on the NASA-TLX loses far more than it protects. Every
// analysis view below (results/authored/dataset) includes ONLY complete sessions, so
// abandoned part-runs never enter analysis. `roster` keeps everyone but flags who
// completed; `survey` naturally covers only those who actually submitted one.

/** Session ids that count for analysis: finished every game AND authored by a real
 *  participant (not a Test/User/blank-named admin/dev run). */
async function completeSessionIds(db: any): Promise<Set<string>> {
  const [ss, parts] = (await Promise.all([
    db.select().from(sessions),
    db.select().from(participants),
  ])) as [any[], any[]];
  const testPid = new Set(
    parts.filter((p: any) => isTestParticipant(p.firstName, p.lastName)).map((p: any) => p.prolificPid),
  );
  return new Set<string>(
    ss
      .filter((s: any) => s.status === "completed" && !testPid.has(s.prolificPid))
      .map((s: any) => s.id),
  );
}

/** One row per participant: who they are, their role, and how far they got. */
async function getRoster(): Promise<any[]> {
  const db = await getDb();
  const [parts, ss, ts] = (await Promise.all([
    db.select().from(participants),
    db.select().from(sessions),
    db.select().from(trials),
  ])) as [any[], any[], any[]];
  const complete = await completeSessionIds(db);
  const sessByPid = new Map<string, any>(ss.map((s: any) => [s.prolificPid, s]));
  const pidBySession = new Map<string, string>(ss.map((s: any) => [s.id, s.prolificPid]));
  const nTrials = new Map<string, number>();
  const nDone = new Map<string, number>();
  for (const t of ts) {
    const pid = pidBySession.get(t.sessionId);
    if (!pid) continue;
    nTrials.set(pid, (nTrials.get(pid) ?? 0) + 1);
    if (t.endedAt) nDone.set(pid, (nDone.get(pid) ?? 0) + 1);
  }
  return parts.map((p) => {
    const s = sessByPid.get(p.prolificPid);
    return {
      prolificPid: p.prolificPid,
      name: p.name,
      firstName: p.firstName,
      lastName: p.lastName,
      email: p.email,
      role: (s?.assignment ?? p.role) as string | null, // novice | expert | speaker
      variant: s?.variant ?? null,
      // Test/dev run (Test/User/blank name): excluded from recruitment AND analysis.
      isTest: isTestParticipant(p.firstName, p.lastName),
      // Did they finish the WHOLE study? Only complete, non-test rows feed the exports.
      completed: s ? complete.has(s.id) : false,
      status: s?.status ?? null,
      trials: nTrials.get(p.prolificPid) ?? 0,
      trialsCompleted: nDone.get(p.prolificPid) ?? 0,
      consentedAt: p.consentedAt,
      completedAt: p.completedAt,
    };
  }).sort(orderBy("role", "name", "prolificPid"));
}

/** One row per LISTENER trial — the core training/analysis record: who listened,
 *  their role, the utterance they got + who authored it, and their outcome
 *  (success, moves, time). Empty until listeners actually play. */
async function getResults(): Promise<any[]> {
  const db = await getDb();
  const [ts, ss, parts] = (await Promise.all([
    db.select().from(trials),
    db.select().from(sessions),
    db.select().from(participants),
  ])) as [any[], any[], any[]];
  const complete = await completeSessionIds(db);
  const pidBySession = new Map<string, string>(ss.map((s: any) => [s.id, s.prolificPid]));
  const nameByPid = new Map<string, any>(parts.map((p: any) => [p.prolificPid, p.name]));
  return ts
    .filter((t: any) => (t.assignment === "novice" || t.assignment === "expert") && complete.has(t.sessionId))
    .map((t: any) => {
      const pid = pidBySession.get(t.sessionId) ?? null;
      return {
        trialId: t.id,
        listenerPid: pid,
        listenerName: pid ? nameByPid.get(pid) ?? null : null,
        role: t.assignment, // novice | expert
        taskId: t.taskId,
        layout: t.layout,
        scene: t.scene,
        utterance: t.utteranceText,
        authorPid: t.speakerPid,
        authorName: t.speakerPid ? nameByPid.get(t.speakerPid) ?? null : null,
        correct: t.correct,
        moves: t.cost,
        durationMs: t.durationMs,
        targetId: t.targetId,
        chosenId: t.chosenId,
        reason: t.reason,
        startedAt: t.startedAt,
        endedAt: t.endedAt,
      };
    })
    .sort(orderBy("listenerName", "listenerPid", "taskId", "layout"));
}

/** One row per authored utterance (speaker side) with the author's name and pool
 *  stats — same as the raw `utterances` table but with `authorName` joined in. */
async function getAuthored(): Promise<any[]> {
  const db = await getDb();
  const [us, parts] = (await Promise.all([
    db.select().from(utterances),
    db.select().from(participants),
  ])) as [any[], any[]];
  const complete = await completeSessionIds(db);
  const nameByPid = new Map<string, any>(parts.map((p: any) => [p.prolificPid, p.name]));
  return us
    .filter((u: any) => complete.has(u.authorSessionId))
    .map((u: any) => ({
    id: u.id,
    taskId: u.taskId,
    layout: u.layout,
    scene: u.scene,
    seed: u.seed,
    text: u.text,
    composeMs: u.composeMs,
    authorPid: u.authorPid,
    authorName: u.authorPid ? nameByPid.get(u.authorPid) ?? null : null,
    timesServed: u.timesServed,
    completedNovice: u.completedNovice,
    completedExpert: u.completedExpert,
    listenerSuccesses: u.listenerSuccesses,
    listenerTrials: u.listenerTrials,
    successRate: u.successRate,
    createdAt: u.createdAt,
  }))
    .sort(orderBy("authorName", "authorPid", "taskId", "layout"));
}

/** THE single training file: one denormalized row per listener response, joining
 *  the utterance + its context (task/layout/scene/target) + author (name) + the
 *  listener (name/role) + outcome (correct/moves/time). Every authored utterance
 *  appears at least once — with blank listener/outcome fields until someone acts
 *  on it — so nothing relevant is ever split across files. */
async function getDataset(): Promise<any[]> {
  const db = await getDb();
  const [us, ts, ss, parts] = (await Promise.all([
    db.select().from(utterances),
    db.select().from(trials),
    db.select().from(sessions),
    db.select().from(participants),
  ])) as [any[], any[], any[], any[]];
  const complete = await completeSessionIds(db);
  const nameByPid = new Map<string, any>(parts.map((p: any) => [p.prolificPid, p.name]));
  const pidBySession = new Map<string, string>(ss.map((s: any) => [s.id, s.prolificPid]));
  // listener trials grouped by the utterance they replayed (complete listeners only)
  const byUtterance = new Map<number, any[]>();
  for (const t of ts) {
    if ((t.assignment === "novice" || t.assignment === "expert") && t.utteranceId != null && complete.has(t.sessionId)) {
      const arr = byUtterance.get(t.utteranceId) ?? [];
      arr.push(t);
      byUtterance.set(t.utteranceId, arr);
    }
  }
  const rows: any[] = [];
  for (const u of us) {
    // Only utterances from speakers who finished the whole study.
    if (!complete.has(u.authorSessionId)) continue;
    const base = {
      utteranceId: u.id,
      taskId: u.taskId,
      layout: u.layout,
      scene: u.scene,
      seed: u.seed,
      utterance: u.text,
      composeMs: u.composeMs,
      authorPid: u.authorPid,
      authorName: u.authorPid ? nameByPid.get(u.authorPid) ?? null : null,
      timesServed: u.timesServed,
      completedNovice: u.completedNovice,
      completedExpert: u.completedExpert,
      listenerSuccesses: u.listenerSuccesses,
      listenerTrials: u.listenerTrials,
      successRate: u.successRate,
      authoredAt: u.createdAt,
    };
    const lts = byUtterance.get(u.id) ?? [];
    if (lts.length === 0) {
      rows.push({
        ...base,
        listenerTrialId: null, listenerPid: null, listenerName: null, listenerRole: null,
        targetId: null, correct: null, moves: null, durationMs: null, chosenId: null,
        reason: null, listenedAt: null,
      });
    } else {
      for (const t of lts) {
        const pid = pidBySession.get(t.sessionId) ?? null;
        rows.push({
          ...base,
          listenerTrialId: t.id,
          listenerPid: pid,
          listenerName: pid ? nameByPid.get(pid) ?? null : null,
          listenerRole: t.assignment,
          targetId: t.targetId,
          correct: t.correct,
          moves: t.cost,
          durationMs: t.durationMs,
          chosenId: t.chosenId,
          reason: t.reason,
          listenedAt: t.endedAt,
        });
      }
    }
  }
  // Group every author's rows together (then task/layout, then each listener), so a
  // speaker's full set is contiguous and easy to eyeball for completeness.
  return rows.sort(orderBy("authorName", "authorPid", "taskId", "layout", "listenerRole", "listenerName"));
}

/** One row per participant: demographics + their open-ended feedback. (NASA-TLX is now
 *  per-trial — see the `tlx` view.) Complete, non-test sessions only. */
async function getSurvey(): Promise<any[]> {
  const db = await getDb();
  const [svs, parts] = (await Promise.all([
    db.select().from(surveys),
    db.select().from(participants),
  ])) as [any[], any[]];
  const complete = await completeSessionIds(db);
  const nameByPid = new Map<string, any>(parts.map((p: any) => [p.prolificPid, p.name]));
  return svs
    .filter((s: any) => complete.has(s.sessionId))
    .map((s: any) => ({
      sessionId: s.sessionId,
      prolificPid: s.prolificPid,
      name: s.prolificPid ? nameByPid.get(s.prolificPid) ?? null : null,
      role: s.role,
      ageRange: s.ageRange,
      gender: s.gender === "Prefer to self-describe" && s.genderOther ? s.genderOther : s.gender,
      race: Array.isArray(s.race) ? s.race.join("; ") : s.race,
      raceOther: s.raceOther,
      feedback: s.feedback,
      createdAt: s.createdAt,
    }))
    .sort(orderBy("role", "name", "prolificPid"));
}

/** One row per trial's NASA-TLX rating: workload (+ raw average) joined to the task,
 *  layout, utterance, and participant. This is the workload dataset — 6 rows per
 *  complete, non-test participant. Sorted so each person's six are contiguous. */
async function getTlx(): Promise<any[]> {
  const db = await getDb();
  const [ts, parts] = (await Promise.all([
    db.select().from(trialSurveys),
    db.select().from(participants),
  ])) as [any[], any[]];
  const complete = await completeSessionIds(db);
  const nameByPid = new Map<string, any>(parts.map((p: any) => [p.prolificPid, p.name]));
  return ts
    .filter((s: any) => complete.has(s.sessionId))
    .map((s: any) => {
      const vals = [s.tlxMental, s.tlxPhysical, s.tlxTemporal, s.tlxPerformance, s.tlxEffort, s.tlxFrustration].filter(
        (v) => v != null,
      ) as number[];
      return {
        prolificPid: s.prolificPid,
        name: s.prolificPid ? nameByPid.get(s.prolificPid) ?? null : null,
        role: s.assignment,
        trialIndex: s.trialIndex,
        taskId: s.taskId,
        layout: s.layout,
        scene: s.scene,
        utteranceId: s.utteranceId,
        authorPid: s.speakerPid,
        authorName: s.speakerPid ? nameByPid.get(s.speakerPid) ?? null : null,
        tlxMental: s.tlxMental,
        tlxPhysical: s.tlxPhysical,
        tlxTemporal: s.tlxTemporal,
        tlxPerformance: s.tlxPerformance,
        tlxEffort: s.tlxEffort,
        tlxFrustration: s.tlxFrustration,
        tlxRaw: vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null,
        createdAt: s.createdAt,
      };
    })
    .sort(orderBy("role", "name", "prolificPid", "trialIndex"));
}

const VIEWS: Record<string, () => Promise<any[]>> = {
  dataset: getDataset,
  roster: getRoster,
  results: getResults,
  authored: getAuthored,
  survey: getSurvey,
  tlx: getTlx,
};

export type ExportName = TableName | keyof typeof VIEWS;
export const EXPORT_NAMES: ExportName[] = [
  "dataset",
  "results",
  "roster",
  "authored",
  "survey",
  "tlx",
  "events",
  "trials",
  "sessions",
  "participants",
  "utterances",
  "trialSurveys",
];

export async function exportTable(table: ExportName, format: "csv" | "jsonl"): Promise<string> {
  await ensureMigrated();
  const rows = table in VIEWS ? await VIEWS[table]!() : await all(table as TableName);
  return format === "csv" ? toCsv(rows) : toJsonl(rows);
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
      trialIndex: t.trialIndex, taskId: t.taskId, scene: t.scene, layout: t.layout, seed: t.seed,
      assignment: t.assignment, utteranceText: t.utteranceText, speakerPid: t.speakerPid,
      correct: t.correct, cost: t.cost, durationMs: t.durationMs, targetId: t.targetId,
      chosenId: t.chosenId, reason: t.reason,
    })),
    timeline,
  };
}
