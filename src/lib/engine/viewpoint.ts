// ─────────────────────────────────────────────────────────────────────────────
// Viewpoint transform (§4/§5/§6 "rotated" == inverted / egocentric).
//
// The listener issues directions in THEIR frame (what they see / press). The
// engine resolves them into WORLD directions. Under `rotated`, the listener's
// map is 180°-turned relative to the speaker's, so up↔down and left↔right invert
// — exactly the manipulation where "the port on its left" becomes ambiguous.
//
// This resolution happens on the SERVER (§9.6), never in the client — it is the
// manipulation, and a client that could see the untransformed frame would void it.
//
// 180° rotation is an involution, so `resolveDir` is its own inverse: a solver
// that knows the desired world dir can emit `resolveDir(worldDir, vp)` and get it.
// ─────────────────────────────────────────────────────────────────────────────

export type Dir = "up" | "down" | "left" | "right";

const INVERT: Record<Dir, Dir> = {
  up: "down",
  down: "up",
  left: "right",
  right: "left",
};

export const DELTA: Record<Dir, readonly [number, number]> = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
};

export function resolveDir(dir: Dir, viewpoint: "aligned" | "rotated"): Dir {
  return viewpoint === "rotated" ? INVERT[dir] : dir;
}
