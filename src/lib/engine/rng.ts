// ─────────────────────────────────────────────────────────────────────────────
// Deterministic RNG (§9.5: deterministic given a seed).
//
// mulberry32 — small, fast, seedable. The whole point is reproducibility: the
// same seed yields the same stream, so `same seed + condition ⇒ identical world`.
// (Note: JS `Math.random()` is deliberately NOT used anywhere in the engine.)
// ─────────────────────────────────────────────────────────────────────────────

export type Rng = () => number;

export function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Integer in [0, n). */
export function intBelow(rng: Rng, n: number): number {
  return Math.floor(rng() * n);
}

/** Fisher–Yates, returns a new shuffled array (does not mutate input). */
export function shuffle<T>(rng: Rng, arr: readonly T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = intBelow(rng, i + 1);
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}
