// ─────────────────────────────────────────────────────────────────────────────
// Headless trial runner (§9.4: the game runs without a browser, driven by bots).
//
// This is how we TEST the engine and how `scripted` speaker mode plays out. It is
// deterministic: given (seed, condition, policy) the event stream is identical.
//
// The loop is task-agnostic. Per-task event derivation is delegated to a
// TaskEventAdapter, so adding a task never touches the runner.
// ─────────────────────────────────────────────────────────────────────────────

import type { Condition, ListenerView, Outcome, Task } from "@/lib/types";
import type { EventInput } from "@/lib/events";
import { makeRng, type Rng } from "./rng";

export interface BotContext<S, A> {
  state: S; // full state — bots may be scripted controllers, not just listeners
  view: ListenerView; // what a real listener would see (fog of war applied)
  legal: A[];
  rng: Rng;
}

export type BotPolicy<S, A> = (ctx: BotContext<S, A>) => A;

/** Turns state transitions into log events. One per task; owns the §10 shapes. */
export interface TaskEventAdapter<S, A> {
  onInit(s: S, sid: string): EventInput[];
  onAction(a: A, before: S, after: S, sid: string): EventInput[];
}

export type EventSink = (e: EventInput) => void | Promise<void>;

export interface RunTrialArgs<S, A> {
  sid: string;
  task: Task<S, A>;
  cond: Condition;
  seed: number;
  policy: BotPolicy<S, A>;
  adapter: TaskEventAdapter<S, A>;
  sink: EventSink;
  /** Safety cap so a broken policy can't loop forever. */
  maxSteps?: number;
}

export async function runTrial<S, A>(args: RunTrialArgs<S, A>): Promise<Outcome> {
  const { sid, task, cond, seed, policy, adapter, sink, maxSteps = 10_000 } = args;

  // Policy RNG is derived from but distinct from the world seed, so a random bot
  // stays reproducible without correlating with world generation.
  const rng = makeRng((seed ^ 0x9e3779b9) >>> 0);

  let s = task.init(seed, cond);
  for (const e of adapter.onInit(s, sid)) await sink(e);

  let steps = 0;
  while (!task.isTerminal(s) && steps++ < maxSteps) {
    const legal = task.legalActions(s);
    if (legal.length === 0) break;
    const view = task.listenerView(s, cond);
    const action = policy({ state: s, view, legal, rng });
    const before = s;
    s = task.apply(s, action);
    for (const e of adapter.onAction(action, before, s, sid)) await sink(e);
  }

  const o = task.outcome(s);
  await sink({
    ev: "trial_end",
    sid,
    correct: o.correct,
    cost: o.cost,
    chosen: o.chosenId,
    target: o.targetId,
    reason: o.reason,
  });
  return o;
}
