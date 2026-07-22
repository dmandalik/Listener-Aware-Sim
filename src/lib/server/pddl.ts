// ─────────────────────────────────────────────────────────────────────────────
// PDDL models, served from the live DB for the admin page.
//
// Same generation as the CLI script (both call buildModel in lib/pddl-core), but the
// data comes straight from the database instead of an exported snapshot, so the admin
// page can view/download the models with no manual export step.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ensureMigrated, getDb } from "@/lib/db/client";
import { participants, sessions, trials, trialSurveys } from "@/lib/db/schema";
import { isTestParticipant } from "@/lib/test-participant";
import { buildModel, DOMAINS, type Model, type TrialRecord } from "@/lib/pddl-core";

// Load every scene map once (keyed by its `scene` id) — same files the game uses.
let MAPS: Record<string, any> | null = null;
function maps(): Record<string, any> {
  if (MAPS) return MAPS;
  const dir = join(process.cwd(), "src", "config", "maps");
  const out: Record<string, any> = {};
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const m = JSON.parse(readFileSync(join(dir, f), "utf8"));
    if (m.scene) out[m.scene] = m;
  }
  return (MAPS = out);
}

const keyOf = (task: string, pid: string, layout: string | null, scene: string) =>
  `${task}:${pid}:${layout ?? scene}`;

interface Built { key: string; participant: string; role: string; model: Model; }

/** Build every model (completed, non-test trials only) from the current DB state. */
async function buildAll(): Promise<Built[]> {
  await ensureMigrated();
  const db = await getDb();
  const [ts, ss, parts, svs] = (await Promise.all([
    db.select().from(trials), db.select().from(sessions),
    db.select().from(participants), db.select().from(trialSurveys),
  ])) as [any[], any[], any[], any[]];

  const testPid = new Set(parts.filter((p) => isTestParticipant(p.firstName, p.lastName)).map((p) => p.prolificPid));
  const sess = new Map(ss.map((s) => [s.id, s]));
  const survey = new Map(svs.map((s) => [`${s.sessionId}:${s.trialIndex}`, s]));
  const M = maps();

  const out: Built[] = [];
  for (const t of ts) {
    const s = sess.get(t.sessionId);
    if (!s || s.status !== "completed" || testPid.has(s.prolificPid)) continue; // completed, non-test only
    const role = t.assignment;
    if (role !== "speaker" && role !== "novice" && role !== "expert") continue;
    const map = M[t.scene];
    if (!map) continue;
    const trial: TrialRecord = {
      taskId: t.taskId, scene: t.scene, layout: t.layout, seed: t.seed, assignment: role,
      utteranceText: t.utteranceText, speakerPid: t.speakerPid, cost: t.cost,
      durationMs: t.durationMs == null ? null : Number(t.durationMs), correct: t.correct,
      targetId: t.targetId, chosenId: t.chosenId, reason: t.reason,
    };
    const sv = survey.get(`${t.sessionId}:${t.trialIndex}`);
    const model = buildModel({ pid: s.prolificPid, role, map, trial, survey: sv });
    if (model) out.push({ key: keyOf(t.taskId, s.prolificPid, t.layout, t.scene), participant: s.prolificPid, role, model });
  }
  return out;
}

/** Small index for the admin list (no big PDDL text). */
export async function pddlIndex() {
  const all = await buildAll();
  return all.map((b) => ({
    key: b.key, participant: b.participant, role: b.role,
    task: b.model.profile.task, scene: b.model.profile.scene, layout: b.model.profile.layout,
    success: b.model.profile.outcome.success, moves: b.model.profile.outcome.moves,
    optimalMoves: b.model.profile.outcome.optimalMoves, skill: b.model.profile.skill.level,
  })).sort((a, b) => a.task.localeCompare(b.task) || a.participant.localeCompare(b.participant));
}

/** One model's PDDL problem + profile + its domain, for inline viewing. */
export async function pddlOne(key: string) {
  const all = await buildAll();
  const hit = all.find((b) => b.key === key);
  if (!hit) return null;
  return { problem: hit.model.problem, profile: hit.model.profile, domain: DOMAINS[hit.model.profile.task] ?? "" };
}

/** All models as JSONL (one line per model, problem text + profile) for "download all". */
export async function pddlBundleJsonl(): Promise<string> {
  const all = await buildAll();
  return all.map((b) => JSON.stringify({
    key: b.key, participant: b.participant, role: b.role,
    task: b.model.profile.task, scene: b.model.profile.scene, layout: b.model.profile.layout,
    problem: b.model.problem, profile: b.model.profile,
  })).join("\n");
}
