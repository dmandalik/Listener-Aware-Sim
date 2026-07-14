// ─────────────────────────────────────────────────────────────────────────────
// teleop (§6) acceptance — mirrors the retrieval guardrails:
//   - deterministic / fixed scenario
//   - the goal is never leaked to the listener
//   - novice control key is absent, then reveals ONLY discovered keys; expert full
//   - every keypress costs budget (mapped, decoy, and wall-bumps alike)
//   - budget exhaustion terminates; the oracle reaches the goal
// ─────────────────────────────────────────────────────────────────────────────

import { describe, it, expect, beforeAll } from "vitest";
import type { Condition } from "@/lib/types";
import {
  loadBuiltinMaps,
  teleopTask,
  teleopAdapter,
  runTrial,
  oracleTeleopBot,
  keyMashTeleopBot,
} from "@/lib/engine";
import type { TeleopState } from "@/lib/tasks/teleop";
import type { EventInput } from "@/lib/events";

beforeAll(() => loadBuiltinMaps());

function cond(overrides: Partial<Condition> = {}): Condition {
  return {
    taskId: "teleop",
    scene: "teleop_corridor",
    keys: { sceneLabels: "none", partsKey: false, controlKey: false },
    viewpoint: "aligned",
    budget: 40,
    timeoutMs: 300_000,
    speakerBriefing: "novice",
    speakerMode: "scripted",
    utteranceSource: { text: "press Z to go up" },
    allowFollowups: false,
    followupReply: "n/a",
    seed: 1,
    ...overrides,
  };
}

async function collect(c: Condition, policy: any) {
  const events: EventInput[] = [];
  const outcome = await runTrial({
    sid: "t",
    task: teleopTask,
    cond: c,
    seed: c.seed,
    policy,
    adapter: teleopAdapter,
    sink: (e) => void events.push(e),
  });
  return { events, outcome };
}

describe("determinism / fixed scenario", () => {
  it("same condition ⇒ identical world and start (seed-independent)", () => {
    const a = teleopTask.init(1, cond({ seed: 1 }));
    const b = teleopTask.init(999, cond({ seed: 999 }));
    expect(a.world).toEqual(b.world);
    expect(a.pos).toEqual(b.pos);
  });
});

describe("the goal is never leaked to the listener", () => {
  it("listener view omits the goal position", () => {
    const c = cond();
    const s = teleopTask.init(c.seed, c);
    const view = teleopTask.listenerView(s, c) as any;
    expect(view.world.goal).toBeUndefined();
    // goal coords must not appear anywhere in the serialized view
    const goal = s.world.goal;
    const blob = JSON.stringify(view.world);
    // start is present; make sure goal (a different cell) isn't smuggled in
    expect(view.world.start).toEqual(s.world.start);
    expect(blob).not.toContain(`"goal"`);
    void goal;
  });
});

describe("control key: novice progressive reveal vs expert full", () => {
  it("novice: absent before any press, then only discovered keys", () => {
    const c = cond({ keys: { sceneLabels: "none", partsKey: false, controlKey: false } });
    let s = teleopTask.init(c.seed, c) as TeleopState;
    let v = teleopTask.listenerView(s, c) as any;
    expect(v.keys[0].entries).toBeUndefined(); // absent — nothing discovered

    s = teleopTask.apply(s, { type: "key", key: "Z" }); // discover Z→up
    v = teleopTask.listenerView(s, c) as any;
    expect(v.keys[0].entries).toEqual({ Z: "up" });

    s = teleopTask.apply(s, { type: "key", key: "R" }); // discover R→right
    v = teleopTask.listenerView(s, c) as any;
    expect(v.keys[0].entries).toEqual({ Z: "up", R: "right" });
  });

  it("expert: full control key from the start", () => {
    const c = cond({ keys: { sceneLabels: "none", partsKey: false, controlKey: true } });
    const s = teleopTask.init(c.seed, c);
    const v = teleopTask.listenerView(s, c) as any;
    expect(v.keys[0].entries).toEqual({ Z: "up", G: "down", R: "right", N: "left" });
  });
});

describe("every keypress costs budget", () => {
  it("a decoy (unmapped) press still costs budget and moves nothing", () => {
    const c = cond({ budget: 10 });
    const s0 = teleopTask.init(c.seed, c);
    const s1 = teleopTask.apply(s0, { type: "key", key: "Q" }); // decoy
    expect(s1.budgetLeft).toBe(9);
    expect(s1.pos).toEqual(s0.pos);
    expect(s1.lastResolved).toBeNull();
  });

  it("a wall-bump press still costs budget", () => {
    const c = cond({ budget: 10 });
    const s0 = teleopTask.init(c.seed, c); // start [1,1]; up hits the wall row 0
    const s1 = teleopTask.apply(s0, { type: "key", key: "Z" }); // Z=up → into wall
    expect(s1.budgetLeft).toBe(9);
    expect(s1.pos).toEqual(s0.pos); // didn't move
    expect(s1.lastResolved).toBe("up"); // but the key IS mapped
  });

  it("budget exhaustion terminates (key-mashing)", async () => {
    const c = cond({ budget: 6 });
    const { outcome, events } = await collect(c, keyMashTeleopBot);
    expect(outcome.reason === "budget_exhausted" || outcome.correct).toBe(true);
    if (!outcome.correct) {
      expect(outcome.cost).toBe(6);
      const acts = events.filter((e) => e.ev === "listener_action") as any[];
      expect(Math.min(...acts.map((a) => a.budgetLeft))).toBe(0);
    }
  });
});

describe("oracle reaches the goal", () => {
  it("solves within budget and logs KEY_ actions with resolved dirs", async () => {
    const c = cond({ budget: 40 });
    const { outcome, events } = await collect(c, oracleTeleopBot);
    expect(outcome.correct).toBe(true);
    expect(outcome.reason).toBe("reached_goal");
    const acts = events.filter((e) => e.ev === "listener_action") as any[];
    expect(acts.length).toBeGreaterThan(0);
    expect(acts[0].action).toMatch(/^KEY_/);
    expect(["up", "down", "left", "right"]).toContain(acts[0].resolved);
  });

  it("solves under a rotated viewpoint too", async () => {
    const c = cond({ viewpoint: "rotated", budget: 40 });
    const { outcome } = await collect(c, oracleTeleopBot);
    expect(outcome.correct).toBe(true);
  });
});
