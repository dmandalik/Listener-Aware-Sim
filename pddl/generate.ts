// ─────────────────────────────────────────────────────────────────────────────
// PDDL generator for the Listener-Aware study.
//
// Modelled on MARLHospital's env_generator (which compiles JSON scene files into
// PDDL problems). Here the inputs are (a) the study's own scene configs, already on
// disk under src/config/maps, and (b) a data snapshot exported from the admin page
// (the JSONL tables). For every completed, non-test trial it writes:
//
//   pddl/out/<task>/<participant>/<layout>/problem.pddl   ← the scenario (objects/init/goal)
//   pddl/out/<task>/<participant>/<layout>/profile.json   ← the skill / observability layer
//
// The domain is fixed per task (pddl/domains/<task>.pddl). Novice vs expert is a
// capability predicate in the problem's :init (exactly MARLHospital's approach), and
// skill/effort/message live in profile.json, NOT in the PDDL — the same split the
// paper uses (PDDL planner + a separate MARL state/skill layer).
//
// Run:  npx tsx pddl/generate.ts
//   Reads snapshot from pddl/data/{trials,sessions,participants,trialSurveys}.jsonl
//   (download those from /api/admin/export?table=...&format=jsonl).
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const MAPS = join(ROOT, "src", "config", "maps");
const DATA = join(HERE, "data");
const OUT = join(HERE, "out");

// ── tiny helpers ──────────────────────────────────────────────────────────────
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
const cellName = (x: number, y: number) => `c_${x}_${y}`;
const sanitize = (s: string) => s.replace(/[^A-Za-z0-9_]/g, "_");

// Load every scene map once, keyed by its `scene` id.
const mapsByScene: Record<string, any> = {};
for (const f of readdirSync(MAPS).filter((f) => f.endsWith(".json"))) {
  const m = readJson(join(MAPS, f));
  if (m.scene) mapsByScene[m.scene] = m;
}

// ── grid helpers (teleop + retrieval share a walls/floor grid) ─────────────────
type Grid = string[];
const walkable = (g: Grid, x: number, y: number) =>
  y >= 0 && y < g.length && x >= 0 && x < g[y].length && g[y][x] !== "#";
function floorCells(g: Grid): [number, number][] {
  const out: [number, number][] = [];
  for (let y = 0; y < g.length; y++) for (let x = 0; x < g[y].length; x++) if (walkable(g, x, y)) out.push([x, y]);
  return out;
}
const DIRS: Record<string, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
// Shortest number of steps between two cells on the walkable grid (BFS). null if unreachable.
function bfs(g: Grid, from: [number, number], to: [number, number]): number | null {
  const key = (x: number, y: number) => `${x},${y}`;
  const seen = new Set([key(...from)]);
  let frontier: [number, number][] = [from], d = 0;
  while (frontier.length) {
    const next: [number, number][] = [];
    for (const [x, y] of frontier) {
      if (x === to[0] && y === to[1]) return d;
      for (const [dx, dy] of Object.values(DIRS)) {
        const nx = x + dx, ny = y + dy;
        if (walkable(g, nx, ny) && !seen.has(key(nx, ny))) { seen.add(key(nx, ny)); next.push([nx, ny]); }
      }
    }
    frontier = next; d++;
  }
  return null;
}

// ── profile (the skill / observability layer — MARLHospital's wrapper analog) ──
interface Ctx {
  pid: string; role: "speaker" | "novice" | "expert"; expert: boolean;
  trial: any; survey: any; map: any;
}
function writeProfile(dir: string, c: Ctx, optimal: number | null) {
  const moves = typeof c.trial.cost === "number" ? c.trial.cost : null;
  const efficiency = moves && optimal ? Math.round((optimal / Math.max(moves, 1)) * 1000) / 1000 : null;
  const profile = {
    participant: c.pid,
    role: c.role,
    expertise: c.role === "speaker" ? "full" : c.role,
    task: c.trial.taskId,
    scene: c.trial.scene,
    layout: c.trial.layout,
    seed: c.trial.seed,
    message: c.trial.utteranceText ?? null, // instruction this listener acted on (authored, for speakers)
    authoredByPid: c.trial.speakerPid ?? null,
    // What this agent could observe (the novice/expert manipulation), mirrored from the game keys.
    observed: {
      knowsControls: c.trial.taskId === "teleop" ? c.expert : undefined,
      knowsPartNames: c.trial.taskId !== "teleop" ? c.expert : undefined,
      knowsRoomLabels: c.trial.taskId === "retrieval" ? c.expert : undefined,
    },
    // Outcome + a skill estimate fit from THIS participant's own trajectory.
    outcome: {
      success: c.trial.correct ?? null,
      moves,
      optimalMoves: optimal,
      efficiency,           // optimal / moves; 1.0 = played it perfectly
      durationMs: c.trial.durationMs ?? null,
      targetId: c.trial.targetId ?? null,
      chosenId: c.trial.chosenId ?? null,
      reason: c.trial.reason ?? null,
    },
    skill: { level: efficiency }, // discrete-skill analog (higher = more efficient)
    effortMs: c.trial.durationMs ?? null, // energy/fatigue proxy
    subjective: {
      comprehension: c.survey?.comprehension ?? null,
      usefulness: c.survey?.usefulness ?? null,
      confidence: c.survey?.confidence ?? null,
    },
  };
  writeFileSync(join(dir, "profile.json"), JSON.stringify(profile, null, 2));
}

// ── per-task PROBLEM emitters ──────────────────────────────────────────────────
function teleopProblem(c: Ctx): { pddl: string; optimal: number | null } {
  const m = c.map, g: Grid = m.grid;
  const cells = floorCells(g);
  const objs: string[] = [];
  const init: string[] = [];
  for (const [x, y] of cells) objs.push(`    ${cellName(x, y)} - cell`);
  objs.push("    up down left right - direction");
  const keys = Object.keys(m.controlMap);
  for (const k of keys) objs.push(`    key_${k} - key`);
  objs.push("    listener - player");

  init.push(`    (at listener ${cellName(m.start[0], m.start[1])})`);
  init.push(`    (goal-cell ${cellName(m.goal[0], m.goal[1])})`);
  for (const [x, y] of cells)
    for (const [d, [dx, dy]] of Object.entries(DIRS))
      if (walkable(g, x + dx, y + dy)) init.push(`    (adjacent ${cellName(x, y)} ${cellName(x + dx, y + dy)} ${d})`);
  for (const [k, d] of Object.entries(m.controlMap)) init.push(`    (maps-to key_${k} ${d})`);
  if (c.expert || c.role === "speaker") init.push(`    (knows-controls listener)`);

  const pddl = problemFile("teleop", c, objs, init, `(at listener ${cellName(m.goal[0], m.goal[1])})`);
  return { pddl, optimal: bfs(g, m.start, m.goal) };
}

function retrievalProblem(c: Ctx): { pddl: string; optimal: number | null } {
  const m = c.map, g: Grid = m.grid;
  const cells = floorCells(g);
  const objs: string[] = [], init: string[] = [];
  for (const [x, y] of cells) objs.push(`    ${cellName(x, y)} - cell`);
  const rooms = Object.keys(m.rooms ?? {});
  for (const r of rooms) objs.push(`    room_${r} - room`);
  const symbols = new Set<string>(), parts = new Set<string>();
  for (const o of m.objects ?? []) { symbols.add(sanitize(o.symbol)); parts.add(sanitize(o.part)); }
  for (const s of symbols) objs.push(`    sym_${s} - symbol`);
  for (const p of parts) objs.push(`    part_${p} - part`);
  for (const o of m.objects ?? []) objs.push(`    ${o.id} - item`);
  objs.push("    listener - player");

  const start = m.listenerStart ?? m.start ?? [1, 1];
  init.push(`    (at listener ${cellName(start[0], start[1])})`);
  init.push(`    (hand-empty listener)`);
  for (const [x, y] of cells)
    for (const [dx, dy] of Object.values(DIRS))
      if (walkable(g, x + dx, y + dy)) init.push(`    (adjacent ${cellName(x, y)} ${cellName(x + dx, y + dy)})`);
  const target = c.trial.targetId;
  for (const o of m.objects ?? []) {
    init.push(`    (obj-at ${o.id} ${cellName(o.pos[0], o.pos[1])})`);
    init.push(`    (has-symbol ${o.id} sym_${sanitize(o.symbol)})`);
    init.push(`    (has-part ${o.id} part_${sanitize(o.part)})`);
    if (o.id === target) init.push(`    (is-target ${o.id})`);
  }
  if (c.expert || c.role === "speaker") { init.push(`    (knows-part-names listener)`); init.push(`    (knows-room-labels listener)`); }

  const targetObj = (m.objects ?? []).find((o: any) => o.id === target);
  const optimal = targetObj ? bfs(g, start as [number, number], targetObj.pos) : null;
  const pddl = problemFile("retrieval", c, objs, init, target ? `(holding listener ${target})` : `(hand-empty listener)`);
  return { pddl, optimal };
}

function repairProblem(c: Ctx): { pddl: string; optimal: number | null } {
  const m = c.map;
  const objs: string[] = [], init: string[] = [];
  const shapes = new Set<string>(), names = new Set<string>();
  for (const comp of m.components) { shapes.add(sanitize(comp.shape)); names.add(sanitize(comp.name)); }
  for (const comp of m.components) objs.push(`    ${comp.id} - component`);
  for (const s of shapes) objs.push(`    shape_${s} - shape`);
  for (const n of names) objs.push(`    name_${n} - name`);
  objs.push("    listener - player");
  for (const comp of m.components) {
    init.push(`    (has-shape ${comp.id} shape_${sanitize(comp.shape)})`);
    init.push(`    (has-name ${comp.id} name_${sanitize(comp.name)})`);
  }
  const [a, b] = m.connect;
  init.push(`    (should-connect ${a} ${b})`);
  init.push(`    (should-connect ${b} ${a})`);
  if (c.expert || c.role === "speaker") init.push(`    (knows-part-names listener)`);
  const pddl = problemFile("repair", c, objs, init, `(connected ${a} ${b})`);
  return { pddl, optimal: 1 };
}

// Assemble a full PDDL problem file with a header comment carrying the message.
function problemFile(domain: string, c: Ctx, objs: string[], init: string[], goal: string): string {
  const name = sanitize(`${domain}_${c.pid}_${c.trial.layout ?? c.trial.scene}`);
  const header =
    `; role=${c.role}  expertise=${c.role === "speaker" ? "full" : c.role}  scene=${c.trial.scene}\n` +
    `; message: ${(c.trial.utteranceText ?? "(none)").replace(/\n/g, " ")}\n`;
  return (
    header +
    `(define (problem ${name})\n(:domain ${domain})\n(:objects\n${objs.join("\n")}\n)\n` +
    `(:init\n${init.join("\n")}\n)\n(:goal ${goal})\n)\n`
  );
}

const EMITTERS: Record<string, (c: Ctx) => { pddl: string; optimal: number | null }> = {
  teleop: teleopProblem, retrieval: retrievalProblem, repair: repairProblem,
};

// ── main ────────────────────────────────────────────────────────────────────
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
    if (!sess || sess.status !== "completed") { skipped++; continue; }        // completed sessions only
    const part = partByPid.get(sess.prolificPid);
    if (part && isTest(part.firstName, part.lastName)) { skipped++; continue; } // never test/dev runs
    const role: "speaker" | "novice" | "expert" | null = t.assignment ?? null;
    if (role !== "speaker" && role !== "novice" && role !== "expert") { skipped++; continue; }
    const emit = EMITTERS[t.taskId as string];
    const map = mapsByScene[t.scene as string];
    if (!emit || !map) { skipped++; continue; }

    const c: Ctx = {
      pid: sess.prolificPid, role, expert: role === "expert",
      trial: t, survey: surveyByKey.get(`${t.sessionId}:${t.trialIndex}`), map,
    };
    const { pddl, optimal } = emit(c);
    const dir = join(OUT, t.taskId, sanitize(c.pid), sanitize(t.layout ?? t.scene));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "problem.pddl"), pddl);
    writeProfile(dir, c, optimal);
    made++;
  }
  console.log(`Generated ${made} PDDL model(s) under pddl/out/ (${skipped} trials skipped).`);
}

main();
