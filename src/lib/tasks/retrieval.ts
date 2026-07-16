// ─────────────────────────────────────────────────────────────────────────────
// Task 1 — `retrieval` (§4). Probes SCENE and ROBOT familiarity + viewpoint.
//
// A grid of ~6 rooms connected by doors. Objects are robot parts drawn as symbols.
// The listener moves room to room under fog of war and picks up ONE object.
//
// ALL view filtering is server-side (§9.6): the listener view is built here with
// fog of war, hidden keys, and the viewpoint transform already applied. Nothing
// the condition hides is ever placed in the listener view for the client to leak.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  Condition,
  KeyPanel,
  ListenerView,
  Outcome,
  RenderedKeyPanel,
  SpeakerView,
  Task,
} from "@/lib/types";
import type { MapLegend } from "@/lib/config";
import type { EventInput } from "@/lib/events";
import type { TaskEventAdapter } from "@/lib/engine/runner";
import { makeRng, shuffle } from "@/lib/engine/rng";
import { DELTA, resolveDir, type Dir } from "@/lib/engine/viewpoint";

const DEFAULT_SCENE = "retrieval_6room";

// You collect an object by CLICKING it (it must be in your current room). Clicking
// the target wins; clicking a wrong object spends one attempt. After this many wrong
// attempts, the trial fails.
const MAX_ATTEMPTS = 3;

// ── In-memory map registry ───────────────────────────────────────────────────
// Maps are config data loaded once (engine barrel loads them from disk; tests can
// register directly). init() looks them up by scene id and fails loud if absent.
const MAPS = new Map<string, MapLegend>();
export function registerRetrievalMap(m: MapLegend): void {
  MAPS.set(m.scene, m);
}

// ── Parsed geometry ──────────────────────────────────────────────────────────

type CellType = "wall" | "floor" | "door";

interface ParsedGeometry {
  width: number;
  height: number;
  cells: CellType[][]; // [row][col]
  roomOf: (string | null)[][]; // room label per cell; null for wall/door
  adjacency: Record<string, string[]>; // room → door-connected rooms
  floorCellsByRoom: Record<string, Array<[number, number]>>; // [col,row]
}

function classify(ch: string): CellType {
  if (ch === "#") return "wall";
  if (ch === "+") return "door";
  return "floor";
}

function parseGeometry(map: MapLegend): ParsedGeometry {
  const grid = map.grid;
  const height = grid.length;
  const width = grid[0]!.length;
  const cells: CellType[][] = grid.map((row) =>
    Array.from(row, (ch) => classify(ch)),
  );
  const roomOf: (string | null)[][] = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => null as string | null),
  );

  // Flood-fill each room from its anchor letter, NOT crossing walls or doors, so
  // doors remain thresholds that separate room interiors.
  const roomLabels = new Set(Object.keys(map.rooms));
  const anchors: Array<{ label: string; col: number; row: number }> = [];
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const ch = grid[r]![c]!;
      if (roomLabels.has(ch)) anchors.push({ label: ch, col: c, row: r });
    }
  }

  for (const a of anchors) {
    if (roomOf[a.row]![a.col] !== null) continue;
    const stack: Array<[number, number]> = [[a.col, a.row]];
    while (stack.length) {
      const [c, r] = stack.pop()!;
      if (r < 0 || r >= height || c < 0 || c >= width) continue;
      if (cells[r]![c] !== "floor") continue; // walls and doors bound the room
      if (roomOf[r]![c] !== null) continue;
      roomOf[r]![c] = a.label;
      stack.push([c + 1, r], [c - 1, r], [c, r + 1], [c, r - 1]);
    }
  }

  // Adjacency: for each door, the distinct rooms of its orthogonal floor
  // neighbours are mutually connected through that door.
  const adjacency: Record<string, Set<string>> = {};
  for (const label of roomLabels) adjacency[label] = new Set();
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      if (cells[r]![c] !== "door") continue;
      const nbrRooms = new Set<string>();
      for (const [dx, dy] of Object.values(DELTA)) {
        const nc = c + dx;
        const nr = r + dy;
        if (nr < 0 || nr >= height || nc < 0 || nc >= width) continue;
        const room = roomOf[nr]![nc];
        if (room) nbrRooms.add(room);
      }
      for (const a of nbrRooms) {
        for (const b of nbrRooms) if (a !== b) adjacency[a]!.add(b);
      }
    }
  }

  const floorCellsByRoom: Record<string, Array<[number, number]>> = {};
  for (const label of roomLabels) floorCellsByRoom[label] = [];
  for (let r = 0; r < height; r++) {
    for (let c = 0; c < width; c++) {
      const room = roomOf[r]![c];
      if (room) floorCellsByRoom[room]!.push([c, r]);
    }
  }

  return {
    width,
    height,
    cells,
    roomOf,
    adjacency: Object.fromEntries(
      Object.entries(adjacency).map(([k, v]) => [k, [...v].sort()]),
    ),
    floorCellsByRoom,
  };
}

// ── State / Action ───────────────────────────────────────────────────────────

export interface PlacedObject {
  id: string;
  symbol: string;
  part: string;
  room: string;
  pos: [number, number];
}

export interface RetrievalWorld {
  scene: string;
  geom: ParsedGeometry;
  rooms: Record<string, string>; // label → name
  objects: PlacedObject[];
  target: string;
}

export interface RetrievalState {
  world: RetrievalWorld;
  cond: Condition;
  pos: [number, number];
  room: string; // current room (persists while crossing a door threshold)
  visited: string[];
  revealed: string[]; // object ids ever seen (logged; never surfaces distant objects)
  budgetLeft: number;
  cost: number; // actions spent (moves)
  mistakes: number; // wrong objects stepped on (§4: up to MAX_ATTEMPTS)
  lastWrong: string | null; // id of the most recent wrong object stepped on
  terminal: boolean;
  chosenId: string | null;
  reason: string;
  lastResolved: Dir | null; // world dir of the last move (for the event log)
}

export type RetrievalAction =
  | { type: "move"; dir: Dir } // dir is in the LISTENER frame
  | { type: "pick"; objectId: string }; // click an object in the current room

// ── Helpers ──────────────────────────────────────────────────────────────────

export function objectsInRoom(world: RetrievalWorld, room: string): PlacedObject[] {
  return world.objects.filter((o) => o.room === room);
}

function partsKeyEntries(world: RetrievalWorld): Record<string, string> {
  const e: Record<string, string> = {};
  for (const o of world.objects) e[o.symbol] = o.part;
  return e;
}

/** Rooms whose labels a scene-NOVICE may see: current + door-adjacent (§4-I). */
function nearbyRooms(world: RetrievalWorld, room: string): Set<string> {
  return new Set<string>([room, ...(world.geom.adjacency[room] ?? [])]);
}

// ── The task ─────────────────────────────────────────────────────────────────

export const retrievalTask: Task<RetrievalState, RetrievalAction> = {
  id: "retrieval",

  init(seed: number, cond: Condition): RetrievalState {
    const scene = cond.scene ?? DEFAULT_SCENE;
    const map = MAPS.get(scene);
    if (!map) {
      throw new Error(
        `retrieval.init: no map registered for scene "${scene}". ` +
          `Registered: [${[...MAPS.keys()].join(", ") || "none"}].`,
      );
    }
    const geom = parseGeometry(map);
    const rng = makeRng(seed);

    // Object placement. fixedLayout → authored positions (identical for everyone,
    // nothing changes). Otherwise seeded within-room shuffle (deterministic per seed).
    const usedByRoom: Record<string, Set<string>> = {};
    const objects: PlacedObject[] = map.objects.map((o) => {
      if (map.fixedLayout) {
        return { id: o.id, symbol: o.symbol, part: o.part, room: o.room, pos: o.pos };
      }
      const cells = geom.floorCellsByRoom[o.room] ?? [];
      if (cells.length === 0) {
        throw new Error(
          `retrieval.init: object ${o.id} references room "${o.room}" which has no floor cells in scene "${scene}".`,
        );
      }
      const used = (usedByRoom[o.room] ??= new Set());
      const shuffled = shuffle(rng, cells);
      const free = shuffled.find(([c, r]) => !used.has(`${c},${r}`)) ?? shuffled[0]!;
      used.add(`${free[0]},${free[1]}`);
      return { id: o.id, symbol: o.symbol, part: o.part, room: o.room, pos: free };
    });

    // Target: condition override (per-mission) falls back to the map's target.
    const target = cond.target ?? map.target;
    if (!objects.some((o) => o.id === target)) {
      throw new Error(
        `retrieval.init: target "${target}" is not an object in scene "${scene}".`,
      );
    }

    const world: RetrievalWorld = {
      scene,
      geom,
      rooms: map.rooms,
      objects,
      target,
    };

    const [sc, sr] = map.listenerStart;
    const startRoom = geom.roomOf[sr]?.[sc];
    if (!startRoom) {
      throw new Error(
        `retrieval.init: listenerStart [${sc},${sr}] is not inside a room in scene "${scene}".`,
      );
    }

    return {
      world,
      cond,
      pos: [sc, sr],
      room: startRoom,
      visited: [startRoom],
      revealed: objectsInRoom(world, startRoom).map((o) => o.id),
      budgetLeft: cond.budget,
      cost: 0,
      mistakes: 0,
      lastWrong: null,
      terminal: false,
      chosenId: null,
      reason: "",
      lastResolved: null,
    };
  },

  speakerView(s: RetrievalState): SpeakerView<RetrievalWorld> {
    // Everything. All rooms, all objects, all keys, target highlighted.
    const keys: KeyPanel[] = [
      {
        id: "parts",
        label: "Robot Parts",
        entries: partsKeyEntries(s.world),
        visibility: "all",
      },
      {
        id: "scene",
        label: "Rooms",
        entries: s.world.rooms,
        visibility: "all",
      },
    ];
    return {
      taskId: "retrieval",
      world: s.world,
      keys,
      targetId: s.world.target,
      briefing: s.cond.speakerBriefing,
    };
  },

  listenerView(s: RetrievalState, cond: Condition): ListenerView {
    const world = s.world;

    // Rooms the listener may see LABELS for (geometry is always visible; labels
    // are gated by the scene key).
    const visibleLabels: Record<string, string> = {};
    if (cond.keys.sceneLabels === "all") {
      Object.assign(visibleLabels, world.rooms);
    } else if (cond.keys.sceneLabels === "nearby") {
      for (const label of nearbyRooms(world, s.room)) {
        if (world.rooms[label]) visibleLabels[label] = world.rooms[label]!;
      }
    } else if (cond.keys.sceneLabels === "current") {
      // Novice: learn only the room you're standing in, revealed as the fog clears.
      if (world.rooms[s.room]) visibleLabels[s.room] = world.rooms[s.room]!;
    }
    // 'none' leaves visibleLabels empty.

    // FOG OF WAR: only the current room's objects, and only their SYMBOL + pos.
    // The part NAME is never attached here — it is knowable only via the parts
    // key panel, which is absent for a novice. This is the §2/§11 guardrail.
    const visibleObjects = objectsInRoom(world, s.room).map((o) => ({
      id: o.id,
      symbol: o.symbol,
      pos: o.pos,
    }));

    // Keys: present iff the listener has them, ABSENT otherwise (never disabled).
    const keys: RenderedKeyPanel[] = [];
    keys.push(
      cond.keys.partsKey
        ? { id: "parts", label: "Robot Parts", entries: partsKeyEntries(world) }
        : { id: "parts", label: "Robot Parts" }, // no entries ⇒ client renders nothing
    );
    // Scene panel (a reference legend of room names): only for listeners who have
    // a real scene key. Novice modes ('none'/'current') get no panel — a novice
    // learns room names only by walking in, shown on the board.
    keys.push(
      cond.keys.sceneLabels === "none" || cond.keys.sceneLabels === "current"
        ? { id: "scene", label: "Rooms" } // absent
        : { id: "scene", label: "Rooms", entries: visibleLabels },
    );

    const listenerWorld = {
      scene: world.scene,
      // Geometry only — walls/doors/room shapes. No object identities.
      cells: world.geom.cells,
      roomOf: world.geom.roomOf,
      width: world.geom.width,
      height: world.geom.height,
      rooms: visibleLabels, // filtered labels
      objects: visibleObjects, // current room only
      pos: s.pos,
      room: s.room,
      attemptsLeft: MAX_ATTEMPTS - s.mistakes,
      lastWrong: s.lastWrong, // set on the move you just stepped on a wrong object
    };

    return {
      taskId: "retrieval",
      world: listenerWorld,
      keys,
      viewpoint: cond.viewpoint,
      budgetLeft: s.budgetLeft,
    };
  },

  legalActions(s: RetrievalState): RetrievalAction[] {
    if (s.terminal) return [];
    const actions: RetrievalAction[] = [];
    const { geom } = s.world;
    // Moves: any listener-frame dir that resolves to a passable neighbour cell.
    for (const dir of ["up", "down", "left", "right"] as Dir[]) {
      const world = resolveDir(dir, s.cond.viewpoint);
      const [dx, dy] = DELTA[world];
      const nc = s.pos[0] + dx;
      const nr = s.pos[1] + dy;
      if (nr < 0 || nr >= geom.height || nc < 0 || nc >= geom.width) continue;
      if (geom.cells[nr]![nc] === "wall") continue;
      actions.push({ type: "move", dir });
    }
    // Picks: any object in the current room (click to collect).
    for (const o of objectsInRoom(s.world, s.room)) {
      actions.push({ type: "pick", objectId: o.id });
    }
    return actions;
  },

  apply(s: RetrievalState, a: RetrievalAction): RetrievalState {
    if (s.terminal) throw new Error("retrieval.apply: trial already terminal");

    if (a.type === "pick") {
      const inRoom = objectsInRoom(s.world, s.room).some((o) => o.id === a.objectId);
      if (!inRoom) {
        throw new Error(
          `retrieval.apply: cannot pick "${a.objectId}" — not in current room "${s.room}"`,
        );
      }
      if (a.objectId === s.world.target) {
        return { ...s, terminal: true, chosenId: a.objectId, reason: "correct", lastWrong: null, lastResolved: null };
      }
      // Wrong object → one attempt spent. Out of attempts ends the trial.
      const mistakes = s.mistakes + 1;
      const out = mistakes >= MAX_ATTEMPTS;
      return {
        ...s,
        mistakes,
        lastWrong: a.objectId,
        terminal: out,
        chosenId: out ? a.objectId : s.chosenId,
        reason: out ? "out_of_attempts" : s.reason,
        lastResolved: null,
      };
    }

    // move
    const world = resolveDir(a.dir, s.cond.viewpoint);
    const [dx, dy] = DELTA[world];
    const nc = s.pos[0] + dx;
    const nr = s.pos[1] + dy;
    const { geom } = s.world;
    if (
      nr < 0 ||
      nr >= geom.height ||
      nc < 0 ||
      nc >= geom.width ||
      geom.cells[nr]![nc] === "wall"
    ) {
      throw new Error(`retrieval.apply: illegal move ${a.dir} → blocked`);
    }

    const cellRoom = geom.roomOf[nr]![nc];
    const nextRoom = cellRoom ?? s.room; // stay in prior room while on a door
    const budgetLeft = s.budgetLeft - 1;
    const enteredNew = cellRoom !== null && cellRoom !== s.room;

    const next: RetrievalState = {
      ...s,
      pos: [nc, nr],
      room: nextRoom,
      budgetLeft,
      cost: s.cost + 1,
      lastWrong: null, // reset each move; set again below if we step on a wrong object
      lastResolved: world,
      visited: enteredNew ? [...s.visited, cellRoom!] : s.visited,
      revealed: enteredNew
        ? Array.from(new Set([...s.revealed, ...objectsInRoom(s.world, cellRoom!).map((o) => o.id)]))
        : s.revealed,
    };

    if (budgetLeft <= 0) {
      next.terminal = true;
      next.reason = "budget_exhausted";
      next.chosenId = null;
    }
    return next;
  },

  isTerminal(s: RetrievalState): boolean {
    return s.terminal;
  },

  outcome(s: RetrievalState): Outcome {
    return {
      correct: s.chosenId === s.world.target,
      cost: s.cost,
      targetId: s.world.target,
      chosenId: s.chosenId,
      reason: s.reason || (s.terminal ? "ended" : "in_progress"),
    };
  },
};

/** Derives §10 events from retrieval transitions. Owned by the task (§9.2). */
export const retrievalAdapter: TaskEventAdapter<RetrievalState, RetrievalAction> = {
  onInit(s, sid) {
    // Fog lifts on the starting room immediately.
    return [
      {
        ev: "room_entered",
        sid,
        room: s.room,
        objectsRevealed: objectsInRoom(s.world, s.room).map((o) => o.id),
      },
    ];
  },
  onAction(a, before, after, sid) {
    const evs: EventInput[] = [];
    if (a.type === "move") {
      evs.push({
        ev: "listener_action",
        sid,
        action: `MOVE_${a.dir.toUpperCase()}`,
        resolved: after.lastResolved, // world dir after the viewpoint transform
        budgetLeft: after.budgetLeft,
        pos: after.pos,
        room: after.room,
      });
      if (after.room !== before.room) {
        evs.push({
          ev: "room_entered",
          sid,
          room: after.room,
          objectsRevealed: objectsInRoom(after.world, after.room).map((o) => o.id),
        });
      }
    } else {
      // pick: mark whether it collected the target or spent an attempt on a wrong one.
      const result = after.reason === "correct" ? "COLLECT" : "WRONG";
      evs.push({
        ev: "listener_action",
        sid,
        action: `${result}:${a.objectId}`,
        resolved: null,
        budgetLeft: after.budgetLeft,
        pos: after.pos,
        room: after.room,
      });
    }
    return evs;
  },
};
