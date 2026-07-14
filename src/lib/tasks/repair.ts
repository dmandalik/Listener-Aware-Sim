// ─────────────────────────────────────────────────────────────────────────────
// Task 2 — `repair` (§5). Probes ROBOT/part familiarity. A drag-to-CONNECT task.
//
// A board of technical-looking parts with MADE-UP names (Kessel, Marno, …). The
// listener must DRAG one part onto another to connect them. Which pair connects is
// NOT visually obvious — it comes from the speaker's words. Several parts look
// alike (three identical sockets), so disambiguating forces spatial language.
//
// Novice sees the parts (shapes) only; expert additionally gets the labels (the
// visual → name key). A wrong connection costs a try (logged), not the trial.
//
// Learnings carried over: server-side filtering (the target connection + labels are
// gated), fixed/authored layout, deterministic, action(CONNECT:a>b)+resolved logged.
// ─────────────────────────────────────────────────────────────────────────────

import type { Condition, ListenerView, Outcome, SpeakerView, Task } from "@/lib/types";
import type { RepairDiagram } from "@/lib/config";
import type { EventInput } from "@/lib/events";
import type { TaskEventAdapter } from "@/lib/engine/runner";

const DEFAULT_SCENE = "repair_board";

const DIAGRAMS = new Map<string, RepairDiagram>();
export function registerRepairDiagram(d: RepairDiagram): void {
  DIAGRAMS.set(d.scene, d);
}

export interface RepairComponent {
  id: string;
  name: string;
  shape: string;
  color: string;
  pos: [number, number];
}

export interface RepairWorld {
  scene: string;
  viewBox: [number, number];
  components: RepairComponent[];
  connect: [string, string]; // the correct pair
}

export interface RepairState {
  world: RepairWorld;
  cond: Condition;
  mistakes: number;
  maxMistakes: number;
  attempts: Array<[string, string]>;
  lastAttempt: { from: string; to: string; correct: boolean } | null;
  terminal: boolean;
  correct: boolean;
  reason: string;
}

export type RepairAction = { type: "connect"; from: string; to: string };

/** Unordered pair equality — connecting A→B is the same as B→A. */
function samePair(a: readonly [string, string], b: readonly [string, string]): boolean {
  return (a[0] === b[0] && a[1] === b[1]) || (a[0] === b[1] && a[1] === b[0]);
}

export const repairTask: Task<RepairState, RepairAction> = {
  id: "repair",

  init(seed: number, cond: Condition): RepairState {
    void seed;
    const scene = cond.scene ?? DEFAULT_SCENE;
    const diagram = DIAGRAMS.get(scene);
    if (!diagram) {
      throw new Error(
        `repair.init: no diagram registered for scene "${scene}". Registered: [${[...DIAGRAMS.keys()].join(", ") || "none"}].`,
      );
    }
    return {
      world: {
        scene,
        viewBox: diagram.viewBox,
        components: diagram.components.map((c) => ({ ...c, pos: [...c.pos] as [number, number] })),
        connect: [...diagram.connect] as [string, string],
      },
      cond,
      mistakes: 0,
      maxMistakes: cond.budget, // budget = allowed wrong connections (a few tries)
      attempts: [],
      lastAttempt: null,
      terminal: false,
      correct: false,
      reason: "",
    };
  },

  speakerView(s: RepairState): SpeakerView<RepairWorld> {
    const entries: Record<string, string> = {};
    for (const c of s.world.components) entries[c.id] = c.name;
    return {
      taskId: "repair",
      world: s.world, // includes the target connection
      keys: [{ id: "parts", label: "Parts", entries, visibility: "all" }],
      targetId: s.world.connect.join(">"),
      briefing: s.cond.speakerBriefing,
    };
  },

  listenerView(s: RepairState, cond: Condition): ListenerView {
    const components = s.world.components.map((c) => ({
      id: c.id,
      shape: c.shape,
      color: c.color,
      pos: c.pos,
      ...(cond.keys.partsKey ? { name: c.name } : {}),
    }));
    return {
      taskId: "repair",
      world: {
        scene: s.world.scene,
        viewBox: s.world.viewBox,
        components,
        labelled: cond.keys.partsKey,
        triesLeft: Math.max(0, s.maxMistakes - s.mistakes),
        attemptCount: s.attempts.length,
        lastAttempt: s.lastAttempt,
        // Once correctly connected, expose the wire so the client can draw it.
        connected: s.correct ? s.world.connect : null,
      },
      keys: [{ id: "parts", label: "Parts" }],
      viewpoint: cond.viewpoint,
      budgetLeft: Math.max(0, s.maxMistakes - s.mistakes),
    };
  },

  legalActions(s: RepairState): RepairAction[] {
    if (s.terminal) return [];
    // Any ordered pair of distinct parts is a droppable connection attempt.
    const out: RepairAction[] = [];
    for (const a of s.world.components) {
      for (const b of s.world.components) {
        if (a.id !== b.id) out.push({ type: "connect", from: a.id, to: b.id });
      }
    }
    return out;
  },

  apply(s: RepairState, a: RepairAction): RepairState {
    if (s.terminal) throw new Error("repair.apply: trial already terminal");
    const ids = new Set(s.world.components.map((c) => c.id));
    if (!ids.has(a.from) || !ids.has(a.to) || a.from === a.to) {
      throw new Error(`repair.apply: bad connection ${a.from}→${a.to}`);
    }
    const isCorrect = samePair([a.from, a.to], s.world.connect);
    const next: RepairState = {
      ...s,
      attempts: [...s.attempts, [a.from, a.to]],
      lastAttempt: { from: a.from, to: a.to, correct: isCorrect },
    };
    if (isCorrect) {
      next.terminal = true;
      next.correct = true;
      next.reason = "connected";
    } else {
      next.mistakes = s.mistakes + 1;
      if (next.mistakes >= s.maxMistakes) {
        next.terminal = true;
        next.correct = false;
        next.reason = "too_many_mistakes";
      }
    }
    return next;
  },

  isTerminal(s: RepairState): boolean {
    return s.terminal;
  },

  outcome(s: RepairState): Outcome {
    return {
      correct: s.correct,
      cost: s.attempts.length,
      targetId: s.world.connect.join(">"),
      chosenId: s.attempts.length ? s.attempts[s.attempts.length - 1]!.join(">") : null,
      reason: s.reason || (s.terminal ? "ended" : "in_progress"),
    };
  },
};

export const repairAdapter: TaskEventAdapter<RepairState, RepairAction> = {
  onInit() {
    return [];
  },
  onAction(a, before, after, sid) {
    void before;
    const evs: EventInput[] = [
      {
        ev: "listener_action",
        sid,
        action: `CONNECT:${a.from}>${a.to}`,
        resolved: after.lastAttempt?.correct ? "correct" : "wrong",
        budgetLeft: Math.max(0, after.maxMistakes - after.mistakes),
      },
    ];
    return evs;
  },
};
