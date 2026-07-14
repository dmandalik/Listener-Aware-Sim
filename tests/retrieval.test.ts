// ─────────────────────────────────────────────────────────────────────────────
// Milestone 2 acceptance tests (§14.2):
//   - determinism from seed
//   - fog of war never leaks distant objects
//   - a novice's view never contains key data
//   - budget exhaustion terminates
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeAll } from "vitest";
import type { Condition } from "@/lib/types";
import {
  loadBuiltinMaps,
  retrievalTask,
  retrievalAdapter,
  runTrial,
  oracleRetrievalBot,
  moveOnlyBot,
} from "@/lib/engine";
import type { RetrievalState } from "@/lib/tasks/retrieval";
import type { EventInput } from "@/lib/events";

beforeAll(() => loadBuiltinMaps());

function cond(overrides: Partial<Condition> = {}): Condition {
  return {
    taskId: "retrieval",
    scene: "retrieval_6room",
    keys: { sceneLabels: "all", partsKey: true, controlKey: false },
    viewpoint: "aligned",
    budget: 40,
    timeoutMs: 300_000,
    speakerBriefing: "novice",
    speakerMode: "scripted",
    utteranceSource: { text: "test" },
    allowFollowups: false,
    followupReply: "n/a",
    seed: 1234,
    ...overrides,
  };
}

async function collect(c: Condition, policy: any, seed = c.seed) {
  const events: EventInput[] = [];
  const outcome = await runTrial({
    sid: "test",
    task: retrievalTask,
    cond: c,
    seed,
    policy,
    adapter: retrievalAdapter,
    sink: (e) => void events.push(e),
  });
  return { events, outcome };
}

describe("determinism from seed", () => {
  it("init produces identical worlds for the same seed", () => {
    const a = retrievalTask.init(777, cond({ seed: 777 }));
    const b = retrievalTask.init(777, cond({ seed: 777 }));
    expect(a.world.objects).toEqual(b.world.objects);
    expect(a.pos).toEqual(b.pos);
  });

  it("different seeds place objects differently", () => {
    const a = retrievalTask.init(1, cond({ seed: 1 }));
    const b = retrievalTask.init(2, cond({ seed: 2 }));
    const posA = a.world.objects.map((o) => o.pos.join(","));
    const posB = b.world.objects.map((o) => o.pos.join(","));
    expect(posA).not.toEqual(posB);
  });

  it("a full trial replays identically under the same seed", async () => {
    const c = cond({ seed: 42 });
    const r1 = await collect(c, oracleRetrievalBot);
    const r2 = await collect(c, oracleRetrievalBot);
    expect(r1.events).toEqual(r2.events);
    expect(r1.outcome).toEqual(r2.outcome);
  });
});

describe("fog of war never leaks distant objects", () => {
  it("listener view shows only current-room objects", () => {
    const c = cond();
    const s = retrievalTask.init(c.seed, c);
    const view = retrievalTask.listenerView(s, c) as any;
    const currentRoomIds = s.world.objects
      .filter((o) => o.room === s.room)
      .map((o) => o.id)
      .sort();
    const viewIds = view.world.objects.map((o: any) => o.id).sort();
    expect(viewIds).toEqual(currentRoomIds);

    // No object from any OTHER room appears anywhere in the serialized view.
    const distant = s.world.objects.filter((o) => o.room !== s.room);
    const blob = JSON.stringify(view);
    for (const o of distant) {
      expect(blob).not.toContain(`"${o.id}"`);
    }
  });

  it("the target is not revealed while the listener is elsewhere", () => {
    const c = cond();
    const s = retrievalTask.init(c.seed, c);
    // target c1 lives in room A; listener starts in room B.
    const target = s.world.objects.find((o) => o.id === s.world.target)!;
    expect(s.room).not.toEqual(target.room);
    const view = retrievalTask.listenerView(s, c) as any;
    expect(JSON.stringify(view)).not.toContain(`"${target.id}"`);
  });
});

describe("a novice's view never contains key data", () => {
  it("robot-novice: parts key is ABSENT and no part names leak", () => {
    const c = cond({ keys: { sceneLabels: "all", partsKey: false, controlKey: false } });
    const s = retrievalTask.init(c.seed, c);
    const view = retrievalTask.listenerView(s, c) as any;

    const parts = view.keys.find((k: any) => k.id === "parts");
    expect(parts).toBeDefined();
    expect(parts.entries).toBeUndefined(); // absent, not empty-but-present

    // No part NAME (charger/lidar/…) appears anywhere in the view.
    const partNames = [...new Set(s.world.objects.map((o) => o.part))];
    const blob = JSON.stringify(view);
    for (const name of partNames) expect(blob).not.toContain(name);

    // Current-room objects are still present, but only as symbols.
    for (const o of s.world.objects.filter((o) => o.room === s.room)) {
      expect(blob).toContain(`"${o.symbol}"`);
    }
  });

  it("scene-novice: only nearby room labels are visible", () => {
    const c = cond({ keys: { sceneLabels: "nearby", partsKey: true, controlKey: false } });
    const s = retrievalTask.init(c.seed, c);
    const view = retrievalTask.listenerView(s, c) as any;
    const scene = view.keys.find((k: any) => k.id === "scene");
    const shownLabels = Object.keys(scene.entries);

    const adjacency = s.world.geom.adjacency[s.room] ?? [];
    const expected = new Set([s.room, ...adjacency]);
    expect(new Set(shownLabels)).toEqual(expected);

    // A non-nearby room's NAME must not leak.
    const distantLabel = Object.keys(s.world.rooms).find((l) => !expected.has(l))!;
    const distantName = s.world.rooms[distantLabel]!;
    expect(JSON.stringify(view.world.rooms)).not.toContain(distantName);
  });

  it("expert view DOES contain the keys (sanity)", () => {
    const c = cond({ keys: { sceneLabels: "all", partsKey: true, controlKey: false } });
    const s = retrievalTask.init(c.seed, c);
    const view = retrievalTask.listenerView(s, c) as any;
    const parts = view.keys.find((k: any) => k.id === "parts");
    expect(Object.keys(parts.entries).length).toBeGreaterThan(0);
  });
});

describe("budget exhaustion terminates", () => {
  it("a move-only bot runs the budget to zero and fails", async () => {
    const c = cond({ budget: 5 });
    const { events, outcome } = await collect(c, moveOnlyBot);
    expect(outcome.correct).toBe(false);
    expect(outcome.reason).toBe("budget_exhausted");
    expect(outcome.cost).toBe(5);
    const end = events.find((e) => e.ev === "trial_end") as any;
    expect(end.reason).toBe("budget_exhausted");
    // Never went below zero.
    const actions = events.filter((e) => e.ev === "listener_action") as any[];
    expect(Math.min(...actions.map((a) => a.budgetLeft))).toBe(0);
  });

  it("the oracle succeeds within budget", async () => {
    const c = cond({ budget: 60 });
    const { outcome } = await collect(c, oracleRetrievalBot);
    expect(outcome.correct).toBe(true);
    expect(outcome.reason).toBe("correct");
    expect(outcome.chosenId).toBe("c1");
  });
});

describe("viewpoint transform", () => {
  it("rotated inverts the world direction of a move", async () => {
    const c = cond({ viewpoint: "rotated", budget: 60 });
    const s0 = retrievalTask.init(c.seed, c) as RetrievalState;
    // A screen "up" must resolve to world "down".
    const legalUp = retrievalTask
      .legalActions(s0)
      .find((a) => a.type === "move" && a.dir === "up");
    // If "up" isn't legal at start, pick any legal move and just assert inversion.
    const s1 = retrievalTask.apply(s0, legalUp ?? { type: "move", dir: "down" });
    const moved = (legalUp ? "up" : "down") as "up" | "down";
    expect(s1.lastResolved).toBe(moved === "up" ? "down" : "up");
  });
});
