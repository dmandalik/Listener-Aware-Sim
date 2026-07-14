// ─────────────────────────────────────────────────────────────────────────────
// Fetch Games — shared domain types
//
// This file is the single source of truth for the concepts in the prompt:
//   - the Condition object (§7) — "this IS the experiment"
//   - the KeyPanel primitive (§2) — familiarity = "do you have the KEY?"
//   - the Task<State, Action> interface (§9)
//
// Runtime validation of anything loaded from disk lives in config.ts (zod).
// These are the types the engine and UI program against.
// ─────────────────────────────────────────────────────────────────────────────

export type Familiarity = "novice" | "expert";

export type TaskId = "retrieval" | "repair" | "teleop";

/**
 * §2 — the central abstraction. Every familiarity axis is the same primitive: a
 * lookup table the listener either HAS or DOESN'T. Scene, robot-parts, and control
 * mappings are all KeyPanels; only the visibility rule differs.
 *
 *   - visible: true   → listener sees the whole table (expert)
 *   - visible: false  → the panel is ABSENT (novice; §11 guardrail: not greyed, absent)
 *   - visible: predicate → partial visibility (the scene case: "nearby rooms only")
 */
export type KeyVisibility = "all" | "none" | { partial: true };

export interface KeyPanel<K extends string = string, V extends string = string> {
  /** Stable id, e.g. "parts", "scene", "control". */
  id: string;
  /** Human label for the legend card, e.g. "Robot Parts". */
  label: string;
  /** The full lookup table. The SPEAKER always has all of it (§3). */
  entries: Record<K, V>;
  /** What the LISTENER can see of it, set by the condition. */
  visibility: KeyVisibility;
}

/**
 * §7 — The condition object. Same seed + condition ⇒ identical world (non-negotiable).
 * The listener's keys are set here; the speaker always has every key.
 */
export interface Condition {
  taskId: TaskId;

  /** Which keys the LISTENER has. */
  keys: {
    sceneLabels: "nearby" | "all";
    partsKey: boolean;
    controlKey: boolean;
  };

  /** "rotated" == inverted / egocentric, interpreted per task (§4–§6). */
  viewpoint: "aligned" | "rotated";

  /** Capped actions — REQUIRED (§3). Converts search cost into success/failure. */
  budget: number;
  timeoutMs: number;

  /** Who the speaker is told they're addressing (§3). Config, never hardcoded copy. */
  speakerBriefing: Familiarity | "unknown";

  /** Where the utterance comes from (§7). All three modes ⇒ identical log format. */
  speakerMode: "human" | "replay" | "scripted";
  utteranceSource?: {
    text: string;
    /** Set when mode === "replay"; traces back to the human who wrote it. */
    speakerSessionId?: string;
  };

  allowFollowups: boolean;
  /** Canned reply — NEVER informative (§3, §15). */
  followupReply: string;

  seed: number;
}

// ── Views (§9) ──────────────────────────────────────────────────────────────
// Server-authoritative. The listener view is a SECURITY BOUNDARY (§9.6): fog of
// war and hidden keys are applied on the server, never filtered on the client.

/** A KeyPanel as it should be SENT to the listener: absent when not visible. */
export interface RenderedKeyPanel {
  id: string;
  label: string;
  /** Present iff the listener may see (some of) this key. Absent = novice. */
  entries?: Record<string, string>;
}

export interface SpeakerView<TWorld = unknown> {
  taskId: TaskId;
  world: TWorld; // everything: full map, all objects, target highlighted
  keys: KeyPanel[]; // all keys, fully visible
  targetId: string;
  briefing: Familiarity | "unknown";
}

export interface ListenerView<TWorld = unknown> {
  taskId: TaskId;
  world: TWorld; // fog-of-war filtered
  keys: RenderedKeyPanel[]; // hidden keys are ABSENT, not disabled
  viewpoint: "aligned" | "rotated";
  budgetLeft: number;
}

export interface Outcome {
  correct: boolean;
  cost: number;
  targetId: string;
  chosenId: string | null;
  /** e.g. "wrong_object", "budget_exhausted", "timeout", "correct". */
  reason: string;
}

/**
 * §9 — The task interface. Intent, not literal: State and Action are per-task.
 * Every task is a plugin behind this one interface (§9.2).
 */
export interface Task<State, Action> {
  id: TaskId;
  init(seed: number, cond: Condition): State;
  speakerView(s: State): SpeakerView;
  listenerView(s: State, cond: Condition): ListenerView;
  legalActions(s: State): Action[];
  /** Applies an action and decrements budget. Pure: returns the next state. */
  apply(s: State, a: Action): State;
  isTerminal(s: State): boolean;
  outcome(s: State): Outcome;
}
