// Completion-based recruitment with a burst cap:
//  - the first batch (speakers, the pool producer) is filled to COMPLETION before any
//    listener, robust to abandonment/purging;
//  - novices and experts are then kept balanced by provisioning (completed + in-flight)
//    so a burst can't push one past the other.

import { describe, expect, it } from "vitest";
import { roleForCompletions } from "@/lib/config";

const R = { batches: [
  { role: "speaker" as const, count: 5 },
  { role: "novice" as const, count: 5 },
  { role: "expert" as const, count: 5 },
] };
type C = { speaker: number; novice: number; expert: number };
const pick = (completed: C, active?: C) => roleForCompletions(R, completed, active);
const c = (speaker: number, novice: number, expert: number): C => ({ speaker, novice, expert });

describe("roleForCompletions", () => {
  it("fills speakers to completion before any listener", () => {
    expect(pick(c(0, 0, 0))).toBe("speaker");
    expect(pick(c(4, 0, 0))).toBe("speaker");
    // Even with 5 speakers IN-FLIGHT but not yet complete, keep assigning speakers —
    // a listener must never meet an empty pool.
    expect(pick(c(0, 0, 0), c(5, 0, 0))).toBe("speaker");
    expect(pick(c(4, 0, 0), c(1, 0, 0))).toBe("speaker");
  });

  it("balances novices and experts once speakers are complete", () => {
    expect(pick(c(5, 0, 0))).toBe("novice"); // first listener
    expect(pick(c(5, 1, 0))).toBe("expert"); // expert is behind → assign expert
    expect(pick(c(5, 1, 1))).toBe("novice"); // tied → first (novice)
    expect(pick(c(5, 3, 2))).toBe("expert"); // expert behind
    expect(pick(c(5, 5, 3))).toBe("expert"); // novices full, experts remain
  });

  it("counts in-flight so a burst can't over-recruit one listener cell", () => {
    // 5 novices already in-flight (none complete yet) → don't pile on; go to experts.
    expect(pick(c(5, 0, 0), c(0, 5, 0))).toBe("expert");
    // novice + its in-flight already meets the quota → assign expert instead.
    expect(pick(c(5, 3, 0), c(0, 2, 0))).toBe("expert");
    // an in-flight novice abandons (drops out) → the cell reopens and refills.
    expect(pick(c(5, 3, 5), c(0, 0, 0))).toBe("novice");
  });

  it("keeps recruiting a role until it truly COMPLETES, ignoring abandonment", () => {
    // The exact live shape: an incomplete speaker was removed, leaving 4 → back to speakers.
    expect(pick(c(4, 6, 3))).toBe("speaker");
    // 5th speaker done; novices over-full (legacy) so only experts remain.
    expect(pick(c(5, 6, 3))).toBe("expert");
  });

  it("repeats the cycle once every quota is met", () => {
    expect(pick(c(5, 5, 5))).toBe("speaker"); // cycle 2
    expect(pick(c(10, 5, 5))).toBe("novice");
    expect(pick(c(10, 10, 10))).toBe("speaker");
  });

  it("never under-fills: if listeners are all in-flight but not complete, keep filling", () => {
    // Both listener cells fully in-flight, none complete → assign the first incomplete
    // (covers any that abandon), never advances leaving a quota short.
    const r = pick(c(5, 0, 0), c(0, 5, 5));
    expect(["novice", "expert"]).toContain(r);
  });
});
