// ─────────────────────────────────────────────────────────────────────────────
// Scripted bot listeners (§9.4 / §14.2). Deterministic controllers used to test
// the engine and to demo a full trial headlessly.
//
//   randomBot   — seeded uniform-random legal action. Exercises arbitrary paths.
//   moveOnlyBot — never commits; forces the budget to deplete (terminates in
//                 budget_exhausted). Used to test the budget boundary.
//   oracleRetrievalBot — navigates to the target and picks it (success path).
//                 Uses full state, i.e. it is a scripted controller, not a
//                 fog-of-war listener.
// ─────────────────────────────────────────────────────────────────────────────

import { intBelow } from "./rng";
import { DELTA, resolveDir, type Dir } from "./viewpoint";
import type { BotPolicy } from "./runner";
import type { RetrievalAction, RetrievalState } from "@/lib/tasks/retrieval";
import type { TeleopAction, TeleopState } from "@/lib/tasks/teleop";
import type { RepairAction, RepairState } from "@/lib/tasks/repair";

export const randomBot: BotPolicy<RetrievalState, RetrievalAction> = ({
  legal,
  rng,
}) => legal[intBelow(rng, legal.length)]!;

export const moveOnlyBot: BotPolicy<RetrievalState, RetrievalAction> = ({
  legal,
  rng,
}) => {
  const moves = legal.filter((a) => a.type === "move");
  const pool = moves.length ? moves : legal;
  return pool[intBelow(rng, pool.length)]!;
};

/**
 * BFS over passable cells from the listener's position to the nearest cell of the
 * target's room; returns the world-frame direction of the first step.
 */
function stepTowardRoom(s: RetrievalState, targetRoom: string): Dir | null {
  const { geom } = s.world;
  const start: [number, number] = s.pos;
  const key = (c: number, r: number) => `${c},${r}`;
  const seen = new Set<string>([key(start[0], start[1])]);
  // queue holds [col, row, firstDir]
  const queue: Array<[number, number, Dir | null]> = [[start[0], start[1], null]];
  while (queue.length) {
    const [c, r, firstDir] = queue.shift()!;
    if (geom.roomOf[r]?.[c] === targetRoom && firstDir) return firstDir;
    for (const dir of ["up", "down", "left", "right"] as Dir[]) {
      const [dx, dy] = DELTA[dir];
      const nc = c + dx;
      const nr = r + dy;
      if (nr < 0 || nr >= geom.height || nc < 0 || nc >= geom.width) continue;
      if (geom.cells[nr]![nc] === "wall") continue;
      if (seen.has(key(nc, nr))) continue;
      seen.add(key(nc, nr));
      queue.push([nc, nr, firstDir ?? dir]);
    }
  }
  return null;
}

export const oracleRetrievalBot: BotPolicy<RetrievalState, RetrievalAction> = ({
  state,
}) => {
  const target = state.world.objects.find((o) => o.id === state.world.target)!;
  if (state.room === target.room) {
    return { type: "pick", objectId: target.id };
  }
  const worldDir = stepTowardRoom(state, target.room);
  if (!worldDir) {
    // Unreachable (shouldn't happen on a valid map) — commit to end the trial.
    const here = state.world.objects.find((o) => o.room === state.room);
    return here
      ? { type: "pick", objectId: here.id }
      : { type: "move", dir: "up" };
  }
  // The listener issues screen-frame dirs; resolveDir is an involution for 180°,
  // so emitting resolveDir(worldDir) makes apply() resolve back to worldDir.
  return { type: "move", dir: resolveDir(worldDir, state.cond.viewpoint) };
};

// ── teleop ───────────────────────────────────────────────────────────────────

function teleopStepTowardGoal(s: TeleopState): Dir | null {
  const { cells, width, height, goal } = s.world;
  const key = (c: number, r: number) => `${c},${r}`;
  const seen = new Set<string>([key(s.pos[0], s.pos[1])]);
  const queue: Array<[number, number, Dir | null]> = [[s.pos[0], s.pos[1], null]];
  while (queue.length) {
    const [c, r, firstDir] = queue.shift()!;
    if (c === goal[0] && r === goal[1] && firstDir) return firstDir;
    for (const dir of ["up", "down", "left", "right"] as Dir[]) {
      const [dx, dy] = DELTA[dir];
      const nc = c + dx;
      const nr = r + dy;
      if (nr < 0 || nr >= height || nc < 0 || nc >= width) continue;
      if (cells[nr]![nc] === "wall") continue;
      if (seen.has(key(nc, nr))) continue;
      seen.add(key(nc, nr));
      queue.push([nc, nr, firstDir ?? dir]);
    }
  }
  return null;
}

/** Knows the control map + path; presses the correct key each step (success path). */
export const oracleTeleopBot: BotPolicy<TeleopState, TeleopAction> = ({ state }) => {
  const worldDir = teleopStepTowardGoal(state);
  if (!worldDir) return { type: "key", key: state.world.keypad[0]! };
  // Find the key whose control-map direction resolves (under viewpoint) to worldDir.
  const wantMapped = resolveDir(worldDir, state.cond.viewpoint);
  const key = Object.keys(state.world.controlMap).find(
    (k) => state.world.controlMap[k] === wantMapped,
  );
  return { type: "key", key: key ?? state.world.keypad[0]! };
};

/** Presses random keypad letters — simulates a novice mashing to discover / to
 *  exhaust the budget. */
export const keyMashTeleopBot: BotPolicy<TeleopState, TeleopAction> = ({ state, rng }) => ({
  type: "key",
  key: state.world.keypad[intBelow(rng, state.world.keypad.length)]!,
});

// ── repair ───────────────────────────────────────────────────────────────────

/** Connects the correct pair (success path; uses full state). */
export const oracleRepairBot: BotPolicy<RepairState, RepairAction> = ({ state }) => ({
  type: "connect",
  from: state.world.connect[0],
  to: state.world.connect[1],
});
