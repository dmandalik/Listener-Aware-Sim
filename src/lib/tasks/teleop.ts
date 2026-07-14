// ─────────────────────────────────────────────────────────────────────────────
// Task 3 — `teleop` (§6). Probes TASK familiarity.
//
// A grid with a start and a goal. The SPEAKER sees both; the LISTENER sees only
// the start and does NOT know where the goal is. The listener drives the robot
// with keystrokes mapped to arbitrary letters (the control map). EVERY keypress
// costs budget — so the control key is a cost advantage, not a hard gate, and the
// speaker can spend their utterance on the mapping or on the route.
//
// Learnings carried over from retrieval:
//  - view filtering is server-side (§9.6): the goal and the hidden control map
//    never reach a novice's client.
//  - progressive reveal: a novice's control key fills in only for letters they've
//    pressed (parallel to the novice room-label reveal). Expert has it from the start.
//  - the control map is AUTHORED/fixed (nothing randomized; identical for everyone).
//  - deterministic; action(raw key) + resolved(direction) are both logged.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  Condition,
  ListenerView,
  Outcome,
  RenderedKeyPanel,
  SpeakerView,
  Task,
} from "@/lib/types";
import type { TeleopMap } from "@/lib/config";
import type { EventInput } from "@/lib/events";
import type { TaskEventAdapter } from "@/lib/engine/runner";
import { DELTA, resolveDir, type Dir } from "@/lib/engine/viewpoint";

const DEFAULT_SCENE = "teleop_corridor";

const MAPS = new Map<string, TeleopMap>();
export function registerTeleopMap(m: TeleopMap): void {
  MAPS.set(m.scene, m);
}

type CellType = "wall" | "floor";

export interface TeleopWorld {
  scene: string;
  cells: CellType[][];
  width: number;
  height: number;
  start: [number, number];
  goal: [number, number];
  controlMap: Record<string, Dir>;
  keypad: string[];
}

export interface TeleopState {
  world: TeleopWorld;
  cond: Condition;
  pos: [number, number];
  budgetLeft: number;
  cost: number;
  discovered: string[]; // keys the listener has pressed (progressive reveal)
  terminal: boolean;
  reason: string;
  success: boolean;
  lastKey: string | null;
  lastResolved: Dir | null; // direction the last key mapped to (null if unmapped)
  path: Array<[number, number]>;
}

export type TeleopAction = { type: "key"; key: string };

function classify(ch: string): CellType {
  return ch === "#" ? "wall" : "floor";
}

function parseCells(map: TeleopMap): CellType[][] {
  return map.grid.map((row) => Array.from(row, classify));
}

export const teleopTask: Task<TeleopState, TeleopAction> = {
  id: "teleop",

  init(seed: number, cond: Condition): TeleopState {
    void seed; // teleop is authored/fixed — no per-seed randomization
    const scene = cond.scene ?? DEFAULT_SCENE;
    const map = MAPS.get(scene);
    if (!map) {
      throw new Error(
        `teleop.init: no map registered for scene "${scene}". Registered: [${[...MAPS.keys()].join(", ") || "none"}].`,
      );
    }
    const cells = parseCells(map);
    const world: TeleopWorld = {
      scene,
      cells,
      width: map.grid[0]!.length,
      height: map.grid.length,
      start: map.start,
      goal: map.goal,
      controlMap: map.controlMap as Record<string, Dir>,
      keypad: map.keypad,
    };
    return {
      world,
      cond,
      pos: [...map.start] as [number, number],
      budgetLeft: cond.budget,
      cost: 0,
      discovered: [],
      terminal: false,
      reason: "",
      success: false,
      lastKey: null,
      lastResolved: null,
      path: [[...map.start] as [number, number]],
    };
  },

  speakerView(s: TeleopState): SpeakerView<TeleopWorld> {
    // Everything: full grid, start AND goal, the complete control key.
    return {
      taskId: "teleop",
      world: s.world,
      keys: [
        {
          id: "control",
          label: "Controls",
          entries: s.world.controlMap,
          visibility: "all",
        },
      ],
      targetId: "goal",
      briefing: s.cond.speakerBriefing,
    };
  },

  listenerView(s: TeleopState, cond: Condition): ListenerView {
    const world = s.world;

    // Control key: expert sees the whole map; novice sees only what they've
    // discovered by pressing (progressive reveal). Absent entirely if empty.
    let controlPanel: RenderedKeyPanel;
    if (cond.keys.controlKey) {
      controlPanel = { id: "control", label: "Controls", entries: world.controlMap };
    } else if (s.discovered.length > 0) {
      const entries: Record<string, string> = {};
      for (const k of s.discovered) {
        if (world.controlMap[k]) entries[k] = world.controlMap[k]!;
      }
      controlPanel = { id: "control", label: "Controls", entries };
    } else {
      controlPanel = { id: "control", label: "Controls" }; // absent (nothing discovered yet)
    }

    const listenerWorld = {
      scene: world.scene,
      cells: world.cells,
      width: world.width,
      height: world.height,
      start: world.start,
      // GOAL WITHHELD (§6): the listener never receives the goal position.
      pos: s.pos,
      keypad: world.keypad,
      // Which keypad letters the listener has learned (for UI hinting only).
      discovered: s.discovered,
    };

    return {
      taskId: "teleop",
      world: listenerWorld,
      keys: [controlPanel],
      viewpoint: cond.viewpoint,
      budgetLeft: s.budgetLeft,
    };
  },

  legalActions(s: TeleopState): TeleopAction[] {
    if (s.terminal) return [];
    // Every keypad letter is pressable — pressing an unmapped one is a real
    // (wasted) exploratory action, not an illegal move.
    return s.world.keypad.map((key) => ({ type: "key", key }));
  },

  apply(s: TeleopState, a: TeleopAction): TeleopState {
    if (s.terminal) throw new Error("teleop.apply: trial already terminal");
    if (!s.world.keypad.includes(a.key)) {
      throw new Error(`teleop.apply: "${a.key}" is not on the keypad`);
    }

    const budgetLeft = s.budgetLeft - 1; // EVERY keypress costs (§6)
    const discovered = s.discovered.includes(a.key)
      ? s.discovered
      : [...s.discovered, a.key];

    const mapped = s.world.controlMap[a.key] as Dir | undefined;
    let pos = s.pos;
    let resolved: Dir | null = null;
    if (mapped) {
      resolved = mapped;
      const worldDir = resolveDir(mapped, s.cond.viewpoint);
      const [dx, dy] = DELTA[worldDir];
      const nc = s.pos[0] + dx;
      const nr = s.pos[1] + dy;
      const { cells, width, height } = s.world;
      const blocked = nr < 0 || nr >= height || nc < 0 || nc >= width || cells[nr]![nc] === "wall";
      if (!blocked) pos = [nc, nr]; // bumping a wall still cost the press
    }

    const next: TeleopState = {
      ...s,
      pos,
      budgetLeft,
      cost: s.cost + 1,
      discovered,
      lastKey: a.key,
      lastResolved: resolved,
      path: pos === s.pos ? s.path : [...s.path, pos],
    };

    if (pos[0] === s.world.goal[0] && pos[1] === s.world.goal[1]) {
      next.terminal = true;
      next.success = true;
      next.reason = "reached_goal";
    } else if (budgetLeft <= 0) {
      next.terminal = true;
      next.success = false;
      next.reason = "budget_exhausted";
    }
    return next;
  },

  isTerminal(s: TeleopState): boolean {
    return s.terminal;
  },

  outcome(s: TeleopState): Outcome {
    return {
      correct: s.success,
      cost: s.cost,
      targetId: "goal",
      chosenId: s.success ? "goal" : null,
      reason: s.reason || (s.terminal ? "ended" : "in_progress"),
    };
  },
};

/** Derives §10 events from teleop transitions. */
export const teleopAdapter: TaskEventAdapter<TeleopState, TeleopAction> = {
  onInit() {
    return []; // no start-of-trial reveal for teleop
  },
  onAction(a, before, after, sid) {
    void before;
    const evs: EventInput[] = [
      {
        ev: "listener_action",
        sid,
        action: `KEY_${a.key}`,
        resolved: after.lastResolved, // direction the key mapped to, or null if unmapped
        budgetLeft: after.budgetLeft,
        pos: after.pos,
      },
    ];
    return evs;
  },
};
