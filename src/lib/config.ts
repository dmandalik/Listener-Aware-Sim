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
    keys: z.object({
      sceneLabels: z.enum(["nearby", "all"]),
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
    // scripted/replay must carry an utterance; human must not (it's authored live).
    if (c.speakerMode !== "human" && !c.utteranceSource?.text) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["utteranceSource", "text"],
        message: `speakerMode "${c.speakerMode}" requires utteranceSource.text`,
      });
    }
    if (c.speakerMode === "replay" && !c.utteranceSource?.speakerSessionId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["utteranceSource", "speakerSessionId"],
        message: `speakerMode "replay" requires utteranceSource.speakerSessionId for traceability`,
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
