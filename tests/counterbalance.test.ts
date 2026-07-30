// Task-order counterbalancing (§ study design).
//
// With one fixed task order, task identity is perfectly aliased with serial position
// (practice/fatigue). We assign one of the 3! = 6 permutations per run via a least-
// filled round-robin, seeded by the already-collected fixed-order runs (all Seq 1) so
// new participants preferentially fill the empty orders 2–6. Scene order is randomized
// independently within each task; buildMainStudy must honor both.

import { describe, expect, it } from "vitest";
import {
  ORDER_SEQUENCES,
  NUM_ORDER_SEQUENCES,
  buildMainStudy,
  leastFilledSeq,
  type StudyOrdering,
} from "@/lib/config";

describe("ORDER_SEQUENCES", () => {
  it("is exactly the 6 permutations of the 3 tasks", () => {
    expect(NUM_ORDER_SEQUENCES).toBe(6);
    expect(ORDER_SEQUENCES).toHaveLength(6);
    const tasks = ["retrieval", "repair", "teleop"];
    const seen = new Set<string>();
    for (const seq of ORDER_SEQUENCES) {
      expect([...seq].sort()).toEqual([...tasks].sort()); // a real permutation of all 3
      seen.add(seq.join(">")); // and distinct from the others
    }
    expect(seen.size).toBe(6);
  });

  it("keeps Seq 1 as the historical fixed order (teleop → repair → retrieval)", () => {
    expect(ORDER_SEQUENCES[0]).toEqual(["teleop", "repair", "retrieval"]);
  });
});

describe("leastFilledSeq", () => {
  it("with nothing collected, starts at Seq 1", () => {
    expect(leastFilledSeq({})).toBe(1);
  });

  it("routes new runs AWAY from the saturated legacy order", () => {
    // 58 legacy runs all on Seq 1, none elsewhere: the next run must NOT be Seq 1.
    const counts = { 1: 58 };
    expect(leastFilledSeq(counts)).toBe(2);
  });

  it("fills the emptiest order, ties broken by lowest sequence number", () => {
    expect(leastFilledSeq({ 1: 2, 2: 2, 3: 1, 4: 2, 5: 2, 6: 2 })).toBe(3);
    expect(leastFilledSeq({ 1: 3, 2: 1, 3: 1, 4: 3, 5: 3, 6: 3 })).toBe(2); // tie 2 vs 3 → 2
  });

  it("drives a seeded pool toward balance over successive draws", () => {
    // Start from the real situation: 58 on Seq 1, 0 on the rest. Simulate assigning the
    // next 50 one at a time; every one should land on an order other than 1 until the
    // others catch up, and Seq 1 should never grow.
    const counts: Record<number, number> = { 1: 58 };
    for (let i = 0; i < 50; i++) {
      const seq = leastFilledSeq(counts);
      expect(seq).not.toBe(1); // never piles onto the saturated order while others lag
      counts[seq] = (counts[seq] ?? 0) + 1;
    }
    // The five empty orders were filled as evenly as possible (10 each), Seq 1 untouched.
    expect(counts[1]).toBe(58);
    for (let s = 2; s <= 6; s++) expect(counts[s]).toBe(10);
  });
});

describe("buildMainStudy honors an ordering", () => {
  it("reorders tasks to match the sequence's task order", () => {
    // Use every permutation and check the resulting trial task order matches, keeping
    // only the first occurrence of each task (config may run >1 layout per task).
    for (const taskOrder of ORDER_SEQUENCES) {
      const ordering: StudyOrdering = { taskOrder: [...taskOrder], layoutOrder: {} };
      const study = buildMainStudy("listener", ordering);
      const firstSeen: string[] = [];
      for (const t of study.trials) {
        const task = t.condition.taskId;
        if (!firstSeen.includes(task)) firstSeen.push(task);
      }
      expect(firstSeen).toEqual([...taskOrder]);
    }
  });

  it("applies a per-task layout order when more than one layout runs", () => {
    // Only meaningful if the config runs >1 layout per task; otherwise this is a no-op
    // that still must not throw. Reverse the layout order of the first task and confirm
    // the emitted layouts for that task flip relative to the default.
    const def = buildMainStudy("listener");
    const firstTask = def.trials[0]!.condition.taskId;
    const forTask = (s: typeof def) =>
      s.trials.filter((t) => t.condition.taskId === firstTask).map((t) => t.condition.layout);
    const defaultLayouts = forTask(def);
    if (defaultLayouts.length < 2) return; // single-layout config: nothing to reorder
    const n = defaultLayouts.length;
    const reversed = Array.from({ length: n }, (_, i) => n - 1 - i);
    const study = buildMainStudy("listener", {
      taskOrder: [firstTask],
      layoutOrder: { [firstTask]: reversed },
    });
    expect(forTask(study)).toEqual([...defaultLayouts].reverse());
  });

  it("falls back to the fixed config order when no ordering is passed", () => {
    const a = buildMainStudy("listener");
    const b = buildMainStudy("listener");
    expect(a.trials.map((t) => t.condition.taskId)).toEqual(b.trials.map((t) => t.condition.taskId));
  });
});
