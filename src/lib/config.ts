// ─────────────────────────────────────────────────────────────────────────────
// Fetch Games — config loader (§9.1: config-driven, not code-driven)
//
// Conditions and maps are DATA on disk, authorable by non-engineers. This module
// loads and VALIDATES them. A malformed condition or map file fails loudly (§15)
// with a path-qualified error, never a silent default.
// ─────────────────────────────────────────────────────────────────────────────

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Condition } from "@/lib/types";

const CONFIG_ROOT = join(process.cwd(), "src", "config");
const CONDITIONS_DIR = join(CONFIG_ROOT, "conditions");
const MAPS_DIR = join(CONFIG_ROOT, "maps");

// ── Condition schema (mirrors types.ts Condition) ────────────────────────────

export const zCondition = z
  .object({
    taskId: z.enum(["retrieval", "repair", "teleop"]),
    scene: z.string().optional(),
    target: z.string().optional(),
    keys: z.object({
      sceneLabels: z.enum(["none", "current", "nearby", "all"]),
      partsKey: z.boolean(),
      controlKey: z.boolean(),
    }),
    viewpoint: z.enum(["aligned", "rotated"]),
    budget: z.number().int().positive(), // REQUIRED and > 0 (§3)
    timeoutMs: z.number().int().positive(),
    speakerBriefing: z.enum(["novice", "expert", "unknown"]).default("novice"),
    speakerMode: z.enum(["human", "replay", "scripted"]),
    utteranceSource: z
      .object({
        text: z.string(),
        speakerSessionId: z.string().optional(),
      })
      .optional(),
    allowFollowups: z.boolean().default(false),
    followupReply: z
      .string()
      .default("Sorry — I can't answer that. Do your best with what I told you."),
    seed: z.number().int(),
  })
  .superRefine((c, ctx) => {
    // scripted must carry a fixed utterance. replay draws from the pool at runtime
    // (optionally pinned via utteranceSource). human is authored live.
    if (c.speakerMode === "scripted" && !c.utteranceSource?.text) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["utteranceSource", "text"],
        message: `speakerMode "scripted" requires utteranceSource.text`,
      });
    }
  });

export function parseCondition(raw: unknown, sourceLabel: string): Condition {
  const parsed = zCondition.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid condition (${sourceLabel}):\n` +
        parsed.error.issues
          .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("\n"),
    );
  }
  return parsed.data as Condition;
}

export function loadCondition(name: string): Condition {
  const file = join(CONDITIONS_DIR, name.endsWith(".json") ? name : `${name}.json`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`Cannot read condition file "${file}": ${(err as Error).message}`);
  }
  return parseCondition(raw, name);
}

export function listConditions(): string[] {
  return readdirSync(CONDITIONS_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
}

// ── Map schema (§9: ASCII grid + JSON legend) ────────────────────────────────

export const zObject = z.object({
  id: z.string(),
  symbol: z.string(),
  part: z.string(),
  room: z.string(),
  pos: z.tuple([z.number().int(), z.number().int()]),
});

export const zMapLegend = z.object({
  /** map/scene identifier, used as the utterance-pool key (§8). */
  scene: z.string(),
  /** ASCII grid; rows are equal length. `#` wall, `.` floor, `+` door, letters = room anchors. */
  grid: z.array(z.string()).min(1),
  rooms: z.record(z.string(), z.string()), // room label → name
  objects: z.array(zObject),
  target: z.string(),
  listenerStart: z.tuple([z.number().int(), z.number().int()]),
  controlMap: z.record(z.string(), z.enum(["up", "down", "left", "right"])).optional(),
  /**
   * When true, objects stay at their authored positions — no per-seed shuffle.
   * Use for a fixed scenario that is byte-identical for every participant.
   */
  fixedLayout: z.boolean().default(false),
});

export type MapLegend = z.infer<typeof zMapLegend>;

export function parseMap(raw: unknown, sourceLabel: string): MapLegend {
  const parsed = zMapLegend.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid map (${sourceLabel}):\n` +
        parsed.error.issues
          .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("\n"),
    );
  }
  const map = parsed.data;
  // Structural checks the schema can't express.
  if (!map.objects.some((o) => o.id === map.target)) {
    throw new Error(`Invalid map (${sourceLabel}): target "${map.target}" is not among objects`);
  }
  const width = map.grid[0]!.length;
  if (map.grid.some((r) => r.length !== width)) {
    throw new Error(`Invalid map (${sourceLabel}): grid rows are not equal length`);
  }
  return map;
}

export function loadMap(name: string): MapLegend {
  const file = join(MAPS_DIR, name.endsWith(".json") ? name : `${name}.json`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`Cannot read map file "${file}": ${(err as Error).message}`);
  }
  return parseMap(raw, name);
}

// ── Teleop map (§6) ──────────────────────────────────────────────────────────
// A grid with a start and goal, plus a control map (letter → direction) that the
// novice must discover. The control map is AUTHORED (fixed) — like retrieval's
// fixedLayout, the scenario is identical for everyone; nothing is randomized.

export const zTeleopMap = z.object({
  scene: z.string(),
  grid: z.array(z.string()).min(1), // '#' wall, '.' floor (open yard: borders only)
  start: z.tuple([z.number().int(), z.number().int()]),
  goal: z.tuple([z.number().int(), z.number().int()]),
  /** Letter → direction. The listener presses letters; expert holds this key. */
  controlMap: z.record(z.string(), z.enum(["up", "down", "left", "right"])),
  /** Every pressable letter (mapped letters + optional decoys). */
  keypad: z.array(z.string()).min(1),
  /**
   * Landmarks scattered across the yard (icon = emoji). They give the speaker a
   * shared reference frame ("drive to the duck") and are visible to EVERY listener.
   * Fixed positions ⇒ identical scenario for everyone.
   */
  landmarks: z
    .array(
      z.object({
        name: z.string(),
        icon: z.string(),
        pos: z.tuple([z.number().int(), z.number().int()]),
      }),
    )
    .default([]),
});

export type TeleopMap = z.infer<typeof zTeleopMap>;

export function parseTeleopMap(raw: unknown, sourceLabel: string): TeleopMap {
  const parsed = zTeleopMap.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid teleop map (${sourceLabel}):\n` +
        parsed.error.issues
          .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("\n"),
    );
  }
  const m = parsed.data;
  const w = m.grid[0]!.length;
  if (m.grid.some((r) => r.length !== w)) {
    throw new Error(`Invalid teleop map (${sourceLabel}): grid rows are not equal length`);
  }
  const at = ([c, r]: [number, number]) => m.grid[r]?.[c];
  if (at(m.start) !== ".") {
    throw new Error(`Invalid teleop map (${sourceLabel}): start ${m.start} is not on floor`);
  }
  if (at(m.goal) !== ".") {
    throw new Error(`Invalid teleop map (${sourceLabel}): goal ${m.goal} is not on floor`);
  }
  for (const k of Object.keys(m.controlMap)) {
    if (!m.keypad.includes(k)) {
      throw new Error(
        `Invalid teleop map (${sourceLabel}): controlMap key "${k}" is not in the keypad`,
      );
    }
  }
  return m;
}

export function loadTeleopMap(name: string): TeleopMap {
  const file = join(MAPS_DIR, name.endsWith(".json") ? name : `${name}.json`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`Cannot read teleop map file "${file}": ${(err as Error).message}`);
  }
  return parseTeleopMap(raw, name);
}

// ── Recruitment policy (which role the next participant gets) ─────────────────
// Ordered batches; the Kth arrival (within a cycle) gets the covering batch's
// role, then the pattern repeats. Editing src/config/recruitment.json is the ONE
// place to change how speakers/novices/experts are recruited.

export const zRecruitment = z.object({
  batches: z
    .array(
      z.object({
        role: z.enum(["speaker", "novice", "expert"]),
        count: z.number().int().positive(),
      }),
    )
    .min(1),
});

export type Recruitment = z.infer<typeof zRecruitment>;

export function loadRecruitment(): Recruitment {
  const file = join(CONFIG_ROOT, "recruitment.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`Cannot read recruitment.json: ${(err as Error).message}`);
  }
  const parsed = zRecruitment.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid recruitment.json:\n` +
        parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n"),
    );
  }
  return parsed.data;
}

/**
 * Which role the next participant should get, given how many have been assigned
 * so far. Pure & deterministic: role is decided by arrival position within the
 * repeating batch cycle.
 */
export function roleForArrival(
  recruitment: Recruitment,
  totalAssigned: number,
): "speaker" | "novice" | "expert" {
  const cycle = recruitment.batches.reduce((n, b) => n + b.count, 0);
  let pos = totalAssigned % cycle;
  for (const b of recruitment.batches) {
    if (pos < b.count) return b.role;
    pos -= b.count;
  }
  return recruitment.batches[0]!.role; // unreachable
}

// ── Repair diagram (§5) ──────────────────────────────────────────────────────
// A 2-D robot diagram: components at fixed positions the listener clicks. Two (or
// more) components deliberately share a `shape` (the visual trap) so a bare visual
// description isn't uniquely identifying.

// Technical-looking parts (sockets, chips, gauges …) drawn as SVG. They carry
// MADE-UP names, and several look alike — so the manipulation is name familiarity,
// and disambiguating a look-alike forces spatial language.
export const REPAIR_SHAPES = [
  "socket",
  "chip",
  "gauge",
  "cap",
  "knob",
  "coil",
  "led",
  "relay",
] as const;

export const zRepairDiagram = z.object({
  scene: z.string(),
  viewBox: z.tuple([z.number(), z.number()]), // [width, height]
  components: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(), // a made-up name (e.g. "Kessel")
        shape: z.enum(REPAIR_SHAPES),
        color: z.string(), // hex accent colour
        pos: z.tuple([z.number(), z.number()]),
      }),
    )
    .min(2),
  /**
   * The correct connection: the listener must DRAG one part onto the other. Which
   * pair connects is NOT visually obvious — it comes from the speaker's words.
   */
  connect: z.tuple([z.string(), z.string()]),
});

export type RepairDiagram = z.infer<typeof zRepairDiagram>;

export function parseRepairDiagram(raw: unknown, sourceLabel: string): RepairDiagram {
  const parsed = zRepairDiagram.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid repair diagram (${sourceLabel}):\n` +
        parsed.error.issues
          .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("\n"),
    );
  }
  const d = parsed.data;
  const ids = new Set(d.components.map((c) => c.id));
  for (const id of d.connect) {
    if (!ids.has(id)) {
      throw new Error(`Invalid repair diagram (${sourceLabel}): connect id "${id}" is not a component`);
    }
  }
  if (d.connect[0] === d.connect[1]) {
    throw new Error(`Invalid repair diagram (${sourceLabel}): a part cannot connect to itself`);
  }
  return d;
}

export function loadRepairDiagram(name: string): RepairDiagram {
  const file = join(MAPS_DIR, name.endsWith(".json") ? name : `${name}.json`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`Cannot read repair diagram "${file}": ${(err as Error).message}`);
  }
  return parseRepairDiagram(raw, name);
}

// ── Study plan (§9.1, §8) ────────────────────────────────────────────────────
// A study is an ordered list of trials. Each trial names a condition file + seed,
// optionally overriding the utterance. Non-engineers author these as data.

const STUDIES_DIR = join(CONFIG_ROOT, "studies");

export const zStudy = z.object({
  id: z.string(),
  role: z.enum(["listener", "speaker"]),
  /** §11: per-trial correctness feedback. Default on; see the §11 caveat. */
  showTrialFeedback: z.boolean().default(true),
  trials: z
    .array(
      z.object({
        condition: z.string(), // condition file name
        seed: z.number().int(),
        utterance: z.string().optional(), // overrides utteranceSource.text
        target: z.string().optional(), // per-mission target (object id)
      }),
    )
    .min(1),
});

export interface ResolvedTrial {
  condition: Condition;
  utterance: string;
}

export interface ResolvedStudy {
  id: string;
  role: "listener" | "speaker";
  showTrialFeedback: boolean;
  trials: ResolvedTrial[];
}

export function loadStudy(name: string): ResolvedStudy {
  const file = join(STUDIES_DIR, name.endsWith(".json") ? name : `${name}.json`);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`Cannot read study file "${file}": ${(err as Error).message}`);
  }
  const parsed = zStudy.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Invalid study (${name}):\n` +
        parsed.error.issues
          .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("\n"),
    );
  }
  const study = parsed.data;
  const trials: ResolvedTrial[] = study.trials.map((t, i) => {
    const base = loadCondition(t.condition);
    const text = t.utterance ?? base.utteranceSource?.text;
    // replay draws its utterance from the pool at runtime, and human authors it
    // live — both optional here. scripted is the only mode that needs config text.
    if (!text && base.speakerMode === "scripted") {
      throw new Error(
        `Invalid study (${name}): trial ${i} (condition "${t.condition}") has no utterance ` +
          `and the condition file provides none.`,
      );
    }
    const condition: Condition = {
      ...base,
      seed: t.seed,
      target: t.target ?? base.target,
      utteranceSource: text ? { ...base.utteranceSource, text } : base.utteranceSource,
    };
    return { condition, utterance: text ?? "" };
  });
  return {
    id: study.id,
    role: study.role,
    showTrialFeedback: study.showTrialFeedback,
    trials,
  };
}
