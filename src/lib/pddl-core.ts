// ─────────────────────────────────────────────────────────────────────────────
// PDDL generation core (pure functions, no fs / no DB).
//
// Shared by the CLI script (pddl/generate.ts) and the admin endpoint
// (src/lib/server/pddl.ts) so both produce byte-identical models. Given a scene map
// + one trial record (+ its per-trial survey), buildModel returns the PDDL problem
// text and the side profile — the same split MARLHospital uses (symbolic PDDL +
// a separate skill/state layer).
// ─────────────────────────────────────────────────────────────────────────────

export type Grid = string[];
export interface TrialRecord {
  taskId: string; scene: string; layout: string | null; seed: number | null;
  assignment: "speaker" | "novice" | "expert" | null;
  utteranceText: string | null; speakerPid: string | null;
  cost: number | null; durationMs: number | null; correct: boolean | null;
  targetId: string | null; chosenId: string | null; reason: string | null;
}
export interface SurveyRecord { comprehension: number | null; usefulness: number | null; confidence: number | null; }
export interface Model { problem: string; profile: any; optimal: number | null; }

const cellName = (x: number, y: number) => `c_${x}_${y}`;
const sanitize = (s: string) => s.replace(/[^A-Za-z0-9_]/g, "_");
const DIRS: Record<string, [number, number]> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

const walkable = (g: Grid, x: number, y: number) => {
  const row = g[y];
  return row !== undefined && x >= 0 && x < row.length && row[x] !== "#";
};
function floorCells(g: Grid): [number, number][] {
  const out: [number, number][] = [];
  for (let y = 0; y < g.length; y++) {
    const row = g[y];
    if (row === undefined) continue;
    for (let x = 0; x < row.length; x++) if (walkable(g, x, y)) out.push([x, y]);
  }
  return out;
}
/** Shortest number of grid steps between two cells (BFS). null if unreachable. */
function bfs(g: Grid, from: [number, number], to: [number, number]): number | null {
  const key = (x: number, y: number) => `${x},${y}`;
  const seen = new Set([key(from[0], from[1])]);
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

interface Ctx { pid: string; role: "speaker" | "novice" | "expert"; expert: boolean; trial: TrialRecord; survey?: SurveyRecord; }

function problemFile(domain: string, c: Ctx, objs: string[], init: string[], goal: string): string {
  const name = sanitize(`${domain}_${c.pid}_${c.trial.layout ?? c.trial.scene}`);
  const header =
    `; role=${c.role}  expertise=${c.role === "speaker" ? "full" : c.role}  scene=${c.trial.scene}\n` +
    `; message: ${(c.trial.utteranceText ?? "(none)").replace(/\n/g, " ")}\n`;
  return header + `(define (problem ${name})\n(:domain ${domain})\n(:objects\n${objs.join("\n")}\n)\n` +
    `(:init\n${init.join("\n")}\n)\n(:goal ${goal})\n)\n`;
}

function buildProfile(c: Ctx, optimal: number | null) {
  const t = c.trial;
  const moves = typeof t.cost === "number" ? t.cost : null;
  const efficiency = moves && optimal ? Math.round((optimal / Math.max(moves, 1)) * 1000) / 1000 : null;
  return {
    participant: c.pid, role: c.role, expertise: c.role === "speaker" ? "full" : c.role,
    task: t.taskId, scene: t.scene, layout: t.layout, seed: t.seed,
    message: t.utteranceText ?? null, authoredByPid: t.speakerPid ?? null,
    observed: {
      knowsControls: t.taskId === "teleop" ? c.expert : undefined,
      knowsPartNames: t.taskId !== "teleop" ? c.expert : undefined,
      knowsRoomLabels: t.taskId === "retrieval" ? c.expert : undefined,
    },
    outcome: {
      success: t.correct ?? null, moves, optimalMoves: optimal, efficiency,
      durationMs: t.durationMs ?? null, targetId: t.targetId ?? null, chosenId: t.chosenId ?? null, reason: t.reason ?? null,
    },
    skill: { level: efficiency }, effortMs: t.durationMs ?? null,
    subjective: {
      comprehension: c.survey?.comprehension ?? null,
      usefulness: c.survey?.usefulness ?? null,
      confidence: c.survey?.confidence ?? null,
    },
  };
}

// ── per-task problem emitters ──────────────────────────────────────────────────
function teleop(c: Ctx, m: any): { pddl: string; optimal: number | null } {
  const g: Grid = m.grid, cells = floorCells(g), objs: string[] = [], init: string[] = [];
  for (const [x, y] of cells) objs.push(`    ${cellName(x, y)} - cell`);
  objs.push("    up down left right - direction");
  for (const k of Object.keys(m.controlMap)) objs.push(`    key_${k} - key`);
  objs.push("    listener - player");
  init.push(`    (at listener ${cellName(m.start[0], m.start[1])})`);
  init.push(`    (goal-cell ${cellName(m.goal[0], m.goal[1])})`);
  for (const [x, y] of cells) for (const [d, [dx, dy]] of Object.entries(DIRS))
    if (walkable(g, x + dx, y + dy)) init.push(`    (adjacent ${cellName(x, y)} ${cellName(x + dx, y + dy)} ${d})`);
  for (const [k, d] of Object.entries(m.controlMap)) init.push(`    (maps-to key_${k} ${d})`);
  if (c.expert || c.role === "speaker") init.push(`    (knows-controls listener)`);
  return { pddl: problemFile("teleop", c, objs, init, `(at listener ${cellName(m.goal[0], m.goal[1])})`), optimal: bfs(g, m.start, m.goal) };
}
function retrieval(c: Ctx, m: any): { pddl: string; optimal: number | null } {
  const g: Grid = m.grid, cells = floorCells(g), objs: string[] = [], init: string[] = [];
  for (const [x, y] of cells) objs.push(`    ${cellName(x, y)} - cell`);
  for (const r of Object.keys(m.rooms ?? {})) objs.push(`    room_${r} - room`);
  const syms = new Set<string>(), parts = new Set<string>();
  for (const o of m.objects ?? []) { syms.add(sanitize(o.symbol)); parts.add(sanitize(o.part)); }
  for (const s of syms) objs.push(`    sym_${s} - symbol`);
  for (const p of parts) objs.push(`    part_${p} - part`);
  for (const o of m.objects ?? []) objs.push(`    ${o.id} - item`);
  objs.push("    listener - player");
  const start = m.listenerStart ?? m.start ?? [1, 1];
  init.push(`    (at listener ${cellName(start[0], start[1])})`);
  init.push(`    (hand-empty listener)`);
  for (const [x, y] of cells) for (const [dx, dy] of Object.values(DIRS))
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
  const optimal = targetObj ? bfs(g, start, targetObj.pos) : null;
  return { pddl: problemFile("retrieval", c, objs, init, target ? `(holding listener ${target})` : `(hand-empty listener)`), optimal };
}
function repair(c: Ctx, m: any): { pddl: string; optimal: number | null } {
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
  return { pddl: problemFile("repair", c, objs, init, `(connected ${a} ${b})`), optimal: 1 };
}

const EMITTERS: Record<string, (c: Ctx, m: any) => { pddl: string; optimal: number | null }> = { teleop, retrieval, repair };

// The three task domains (physics + capability predicates), inlined so the server can
// serve them without reading files at runtime. Kept in sync with pddl/domains/*.pddl.
export const DOMAINS: Record<string, string> = {
  teleop: `(define (domain teleop)
  (:requirements :strips :typing :disjunctive-preconditions)
  (:types cell direction key player - object)
  (:predicates
    (at ?p - player ?c - cell)
    (adjacent ?from - cell ?to - cell ?d - direction)
    (goal-cell ?c - cell)
    (knows-controls ?p - player)
    (maps-to ?k - key ?d - direction))
  (:action move
    :parameters (?p - player ?from - cell ?to - cell ?d - direction)
    :precondition (and (at ?p ?from) (adjacent ?from ?to ?d))
    :effect (and (not (at ?p ?from)) (at ?p ?to)))
  (:action press-key
    :parameters (?p - player ?k - key ?d - direction ?from - cell ?to - cell)
    :precondition (and (knows-controls ?p) (maps-to ?k ?d) (at ?p ?from) (adjacent ?from ?to ?d))
    :effect (and (not (at ?p ?from)) (at ?p ?to))))
`,
  retrieval: `(define (domain retrieval)
  (:requirements :strips :typing :disjunctive-preconditions)
  (:types cell room item symbol part player - object)
  (:predicates
    (at ?p - player ?c - cell)
    (adjacent ?a - cell ?b - cell)
    (in-room ?c - cell ?r - room)
    (obj-at ?o - item ?c - cell)
    (holding ?p - player ?o - item)
    (hand-empty ?p - player)
    (is-target ?o - item)
    (has-symbol ?o - item ?s - symbol)
    (has-part ?o - item ?pt - part)
    (knows-part-names ?p - player)
    (knows-room-labels ?p - player))
  (:action move
    :parameters (?p - player ?from - cell ?to - cell)
    :precondition (and (at ?p ?from) (adjacent ?from ?to))
    :effect (and (not (at ?p ?from)) (at ?p ?to)))
  (:action pick
    :parameters (?p - player ?o - item ?c - cell)
    :precondition (and (at ?p ?c) (obj-at ?o ?c) (hand-empty ?p))
    :effect (and (holding ?p ?o) (not (hand-empty ?p)))))
`,
  repair: `(define (domain repair)
  (:requirements :strips :typing :disjunctive-preconditions)
  (:types component shape name player - object)
  (:predicates
    (has-shape ?c - component ?s - shape)
    (has-name ?c - component ?n - name)
    (should-connect ?a - component ?b - component)
    (connected ?a - component ?b - component)
    (knows-part-names ?p - player))
  (:action connect
    :parameters (?p - player ?a - component ?b - component)
    :precondition (should-connect ?a ?b)
    :effect (connected ?a ?b)))
`,
};

/** Build one participant model (problem + profile) from a scene map and a trial. */
export function buildModel(args: { pid: string; role: "speaker" | "novice" | "expert"; map: any; trial: TrialRecord; survey?: SurveyRecord }): Model | null {
  const emit = EMITTERS[args.trial.taskId];
  if (!emit || !args.map) return null;
  const c: Ctx = { pid: args.pid, role: args.role, expert: args.role === "expert", trial: args.trial, survey: args.survey };
  const { pddl, optimal } = emit(c, args.map);
  return { problem: pddl, profile: buildProfile(c, optimal), optimal };
}
