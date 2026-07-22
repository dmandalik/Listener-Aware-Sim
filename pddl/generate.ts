// ─────────────────────────────────────────────────────────────────────────────
// PDDL generator (CLI) for the Listener-Aware study.
//
// Modelled on MARLHospital's env_generator: it compiles the study's scene configs +
// a data snapshot into PDDL. The generation logic itself lives in src/lib/pddl-core
// (shared with the admin endpoint, so both produce identical models). This file only
// does the file I/O: read the snapshot, write the tree.
//
// For every completed, non-test trial it writes:
//   pddl/out/<task>/<participant>/<layout>/problem.pddl   ← the scenario (objects/init/goal)
//   pddl/out/<task>/<participant>/<layout>/profile.json   ← the skill / observability layer
//
// Run:  npx tsx pddl/generate.ts
//   Reads pddl/data/{trials,sessions,participants,trialSurveys}.jsonl
//   (download those from /api/admin/export?table=...&format=jsonl).
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildModel, type TrialRecord } from "../src/lib/pddl-core";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const MAPS = join(ROOT, "src", "config", "maps");
const DATA = join(HERE, "data");
const OUT = join(HERE, "out");

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));
function readJsonl(name: string): any[] {
  const p = join(DATA, name);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}
function isTest(first: string | null, last: string | null): boolean {
  const f = (first ?? "").trim().toLowerCase(), l = (last ?? "").trim().toLowerCase();
  return (!f && !l) || f === "test" || l === "user";
}
const sanitize = (s: string) => s.replace(/[^A-Za-z0-9_]/g, "_");

// Load every scene map once, keyed by its `scene` id.
const mapsByScene: Record<string, any> = {};
for (const f of readdirSync(MAPS).filter((f) => f.endsWith(".json"))) {
  const m = readJson(join(MAPS, f));
  if (m.scene) mapsByScene[m.scene] = m;
}

function main() {
  const trials = readJsonl("trials.jsonl");
  const sessions = readJsonl("sessions.jsonl");
  const participants = readJsonl("participants.jsonl");
  const surveys = readJsonl("trialSurveys.jsonl");
  if (!trials.length) { console.error("No pddl/data/trials.jsonl — export the tables first."); process.exit(1); }

  const partByPid = new Map(participants.map((p) => [p.prolificPid, p]));
  const sessById = new Map(sessions.map((s) => [s.id, s]));
  const surveyByKey = new Map(surveys.map((s) => [`${s.sessionId}:${s.trialIndex}`, s]));

  let made = 0, skipped = 0;
  for (const t of trials) {
    const sess = sessById.get(t.sessionId);
    if (!sess || sess.status !== "completed") { skipped++; continue; }
    const part = partByPid.get(sess.prolificPid);
    if (part && isTest(part.firstName, part.lastName)) { skipped++; continue; }
    const role = t.assignment;
    if (role !== "speaker" && role !== "novice" && role !== "expert") { skipped++; continue; }
    const map = mapsByScene[t.scene];
    if (!map) { skipped++; continue; }

    const trial: TrialRecord = {
      taskId: t.taskId, scene: t.scene, layout: t.layout, seed: t.seed, assignment: role,
      utteranceText: t.utteranceText, speakerPid: t.speakerPid, cost: t.cost,
      durationMs: t.durationMs == null ? null : Number(t.durationMs), correct: t.correct,
      targetId: t.targetId, chosenId: t.chosenId, reason: t.reason,
    };
    const model = buildModel({ pid: sess.prolificPid, role, map, trial, survey: surveyByKey.get(`${t.sessionId}:${t.trialIndex}`) });
    if (!model) { skipped++; continue; }

    const dir = join(OUT, t.taskId, sanitize(sess.prolificPid), sanitize(t.layout ?? t.scene));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "problem.pddl"), model.problem);
    writeFileSync(join(dir, "profile.json"), JSON.stringify(model.profile, null, 2));
    made++;
  }
  console.log(`Generated ${made} PDDL model(s) under pddl/out/ (${skipped} trials skipped).`);
}

main();
