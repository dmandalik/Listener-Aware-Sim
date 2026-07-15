// ─────────────────────────────────────────────────────────────────────────────
// repair (§5) acceptance — drag-to-connect:
//   - deterministic panel; a real look-alike group (≥2 parts share shape+colour)
//   - the target connection is never leaked to the listener
//   - novice sees shapes only; expert additionally gets the labels
//   - a wrong connection costs a try (not the trial); out of tries fails
//   - connecting the right pair (either drag direction) succeeds
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeAll } from "vitest";
import type { Condition } from "@/lib/types";
import { loadBuiltinMaps, repairTask, repairAdapter, runTrial, oracleRepairBot } from "@/lib/engine";
import type { RepairState } from "@/lib/tasks/repair";

beforeAll(() => loadBuiltinMaps());

function cond(overrides: Partial<Condition> = {}): Condition {
  return {
    taskId: "repair",
    scene: "repair_board",
    keys: { sceneLabels: "none", partsKey: false, controlKey: false },
    viewpoint: "aligned",
    budget: 4,
    timeoutMs: 300_000,
    speakerBriefing: "novice",
    speakerMode: "scripted",
    utteranceSource: { text: "connect the middle socket to the gauge" },
    allowFollowups: false,
    followupReply: "n/a",
    seed: 1,
    ...overrides,
  };
}

describe("deterministic panel + look-alike group", () => {
  it("same condition ⇒ identical parts", () => {
    expect(repairTask.init(1, cond({ seed: 1 })).world).toEqual(repairTask.init(9, cond({ seed: 9 })).world);
  });
  it("has a look-alike group (≥2 parts share shape+colour)", () => {
    const s = repairTask.init(1, cond());
    const byLook: Record<string, number> = {};
    for (const c of s.world.components) byLook[`${c.shape}|${c.color}`] = (byLook[`${c.shape}|${c.color}`] ?? 0) + 1;
    expect(Object.values(byLook).some((n) => n >= 2)).toBe(true);
  });
});

describe("the target connection is never leaked", () => {
  it("listener view omits `connect`", () => {
    const c = cond();
    const v = repairTask.listenerView(repairTask.init(c.seed, c), c) as any;
    expect(v.world.connect).toBeUndefined();
    expect(JSON.stringify(v)).not.toContain(`"connect"`);
  });
});

describe("novice shapes-only vs expert labelled", () => {
  it("novice: parts carry NO names", () => {
    const c = cond();
    const s = repairTask.init(c.seed, c);
    const v = repairTask.listenerView(s, c) as any;
    expect(v.world.labelled).toBe(false);
    const blob = JSON.stringify(v);
    for (const comp of s.world.components) expect(blob).not.toContain(comp.name);
  });
  it("expert: parts carry their made-up names", () => {
    const c = cond({ keys: { sceneLabels: "all", partsKey: true, controlKey: false } });
    const v = repairTask.listenerView(repairTask.init(c.seed, c), c) as any;
    expect(v.world.components.find((x: any) => x.id === "w6").name).toBe("Marno");
  });
});

describe("connect + a few tries", () => {
  it("connecting the correct pair succeeds", async () => {
    const c = cond();
    const events: any[] = [];
    const outcome = await runTrial({
      sid: "r", task: repairTask, cond: c, seed: c.seed,
      policy: oracleRepairBot, adapter: repairAdapter, sink: (e) => void events.push(e),
    });
    expect(outcome.correct).toBe(true);
    expect(outcome.reason).toBe("connected");
    const act = events.find((e) => e.ev === "listener_action");
    expect(act.action).toMatch(/^CONNECT:/);
    expect(act.resolved).toBe("correct");
  });

  it("either drag direction connects the pair", () => {
    const c = cond();
    const s = repairTask.init(c.seed, c) as RepairState;
    const [a, b] = s.world.connect;
    const s1 = repairTask.apply(s, { type: "connect", from: b, to: a }); // reversed
    expect(s1.correct).toBe(true);
  });

  it("a wrong connection costs a try but does NOT end the trial", () => {
    const c = cond();
    const s0 = repairTask.init(c.seed, c) as RepairState;
    const ids = s0.world.components.map((x) => x.id);
    const wrong = ids.filter((x) => x !== s0.world.connect[0] && x !== s0.world.connect[1]).slice(0, 2) as [string, string];
    const s1 = repairTask.apply(s0, { type: "connect", from: wrong[0], to: wrong[1] });
    expect(s1.terminal).toBe(false);
    expect(s1.mistakes).toBe(1);
    const s2 = repairTask.apply(s1, { type: "connect", from: s0.world.connect[0], to: s0.world.connect[1] });
    expect(s2.terminal).toBe(true);
    expect(s2.correct).toBe(true);
  });

  it("running out of tries fails", () => {
    const c = cond({ budget: 2 });
    let s = repairTask.init(c.seed, c) as RepairState;
    const ids = s.world.components.map((x) => x.id);
    const w = ids.filter((x) => x !== s.world.connect[0] && x !== s.world.connect[1]).slice(0, 2) as [string, string];
    s = repairTask.apply(s, { type: "connect", from: w[0], to: w[1] });
    expect(s.terminal).toBe(false);
    s = repairTask.apply(s, { type: "connect", from: w[0], to: w[1] });
    expect(s.terminal).toBe(true);
    expect(s.reason).toBe("too_many_mistakes");
  });
});
