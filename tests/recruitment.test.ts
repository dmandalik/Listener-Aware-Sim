// Completion-based recruitment: keep assigning a role until that many of that role
// have FINISHED, then advance — robust to abandonment/purging. Pure-function tests.

import { describe, expect, it } from "vitest";
import { roleForCompletions } from "@/lib/config";

const R = { batches: [
  { role: "speaker" as const, count: 5 },
  { role: "novice" as const, count: 5 },
  { role: "expert" as const, count: 5 },
] };
const pick = (s: number, n: number, e: number) =>
  roleForCompletions(R, { speaker: s, novice: n, expert: e });

describe("roleForCompletions", () => {
  it("fills speakers first, then novices, then experts (cycle 1)", () => {
    expect(pick(0, 0, 0)).toBe("speaker");
    expect(pick(3, 0, 0)).toBe("speaker");
    expect(pick(5, 0, 0)).toBe("novice");
    expect(pick(5, 3, 0)).toBe("novice");
    expect(pick(5, 5, 0)).toBe("expert");
    expect(pick(5, 5, 3)).toBe("expert");
  });

  it("repeats the cycle once every role's quota is met", () => {
    expect(pick(5, 5, 5)).toBe("speaker"); // cycle 2 begins
    expect(pick(10, 5, 5)).toBe("novice");
    expect(pick(10, 10, 5)).toBe("expert");
    expect(pick(10, 10, 10)).toBe("speaker");
  });

  it("keeps recruiting a role until it is truly COMPLETE, ignoring abandonment", () => {
    // The exact shape of the live data: an incomplete speaker was removed, leaving 4.
    // It must go back to recruiting speakers, not advance.
    expect(pick(4, 6, 3)).toBe("speaker");
    // Once the 5th speaker completes, novices are already over-filled (6≥5) so skip to experts.
    expect(pick(5, 6, 3)).toBe("expert");
  });

  it("does not get stuck when a role is over-recruited (burst)", () => {
    // 6 speakers finished in cycle 1 (over by 1) — must still advance to novices.
    expect(pick(6, 0, 0)).toBe("novice");
    expect(pick(7, 5, 0)).toBe("expert");
  });
});
