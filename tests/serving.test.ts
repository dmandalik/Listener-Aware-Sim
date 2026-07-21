// Utterance serving guarantees (the "one novice + one expert per message" rule).
//
// The pool must:
//   - serve ONLY messages from speakers who finished the game and aren't test runs
//   - give each incoming listener a FRESH message their role hasn't seen
//   - never hand the same message to two novices (or two experts)
//   - only count a message "seen" once the listener FINISHES (hits submit); an
//     in-progress draw is a soft hold that frees up if they abandon
//   - prefer a message the other role already saw, so novice + expert land on the
//     SAME message and form a pair
//   - ignore test-user listeners entirely (their play never consumes a message)
//
// Everything is derived from the trials on each draw, so it can't drift.

import { beforeEach, describe, expect, it } from "vitest";

process.env.DB_DRIVER = "pglite";
process.env.PGLITE_DATA_DIR = "memory://serving-test";

import { eq } from "drizzle-orm";
import { ensureMigrated, getDb } from "@/lib/db/client";
import { events, participants, sessions, surveys, trials, utterances } from "@/lib/db/schema";
import {
  deleteSessionsByPid,
  drawUtterance,
  insertUtterance,
  openTrial,
  reconcileUtteranceCounters,
  startSession,
  upsertParticipant,
} from "@/lib/db/writer";

// The one pool cell every test draws from.
const CELL = { taskId: "retrieval" as const, seed: 1, scene: "s1" };

let seq = 0; // stable unique ids (no Date.now/random needed for identity)

async function reset() {
  const db = await getDb();
  for (const t of [events, trials, surveys, utterances, sessions, participants]) await db.delete(t);
  seq = 0;
}

/** A speaker who authored ONE message in the cell. Completed + real unless `test`. */
async function addMessage(opts: { test?: boolean } = {}): Promise<number> {
  const db = await getDb();
  const n = ++seq;
  const pid = `SPK${n}`;
  const sid = `spk-${n}`;
  await upsertParticipant({
    prolificPid: pid, studyId: "S", sessionId: `${pid}-ps`, role: "speaker",
    firstName: opts.test ? "Test" : "Real", lastName: opts.test ? "User" : pid,
  });
  await startSession({ id: sid, prolificPid: pid, role: "speaker", plan: {}, assignment: "speaker" });
  await db.update(sessions).set({ status: "completed" }).where(eq(sessions.id, sid));
  return insertUtterance({ ...CELL, text: `msg-${n}`, authorSessionId: sid, authorPid: pid });
}

/** A listener who draws one message from the cell and plays it. `finish` marks the
 *  whole game done (status completed → the message is "seen"); otherwise the session
 *  stays in progress (the message is only "reserved"). Returns the drawn message id. */
async function listen(
  role: "novice" | "expert",
  opts: { finish?: boolean; test?: boolean } = {},
): Promise<{ pid: string; sid: string; drew: number | null }> {
  const db = await getDb();
  const n = ++seq;
  const pid = `LIS${n}`;
  const sid = `lis-${n}`;
  await upsertParticipant({
    prolificPid: pid, studyId: "S", sessionId: `${pid}-ps`, role: "listener",
    firstName: opts.test ? "Test" : "Real", lastName: opts.test ? "User" : pid,
  });
  await startSession({ id: sid, prolificPid: pid, role: "listener", plan: {}, assignment: role });
  // Mirror the real flow: a test/dev draw is untracked so it can't move the counters.
  const drawn = await drawUtterance(CELL.taskId, CELL.seed, CELL.scene, role, !(opts.test ?? false));
  if (drawn) {
    await openTrial({
      sessionId: sid, trialIndex: 0, taskId: CELL.taskId, seed: CELL.seed, condition: {},
      assignment: role, utteranceId: drawn.id,
    });
    if (opts.finish ?? true) {
      await db.update(trials).set({ endedAt: new Date(), correct: true }).where(eq(trials.sessionId, sid));
      await db.update(sessions).set({ status: "completed" }).where(eq(sessions.id, sid));
    }
  }
  return { pid, sid, drew: drawn?.id ?? null };
}

describe("drawUtterance serving rules", () => {
  beforeEach(async () => {
    await ensureMigrated();
    await reset();
  });

  it("serves nothing until a real speaker has FINISHED", async () => {
    // No messages at all.
    expect(await drawUtterance(CELL.taskId, CELL.seed, CELL.scene, "novice")).toBeNull();

    // A message from a TEST-named speaker is never servable.
    await addMessage({ test: true });
    expect(await drawUtterance(CELL.taskId, CELL.seed, CELL.scene, "novice")).toBeNull();

    // An in-progress (not finished) real speaker is not servable either.
    const db = await getDb();
    const wip = await addMessage(); // completed by default...
    await db.update(sessions).set({ status: "started" }).where(eq(sessions.id, "spk-2")); // ...force in-progress
    void wip;
    expect(await drawUtterance(CELL.taskId, CELL.seed, CELL.scene, "novice")).toBeNull();

    // Add one finished, real speaker → now it serves that message.
    const good = await addMessage();
    const drawn = await drawUtterance(CELL.taskId, CELL.seed, CELL.scene, "novice");
    expect(drawn?.id).toBe(good);
  });

  it("gives each novice a distinct fresh message; never two novices on one message", async () => {
    const ids = new Set<number>();
    for (let i = 0; i < 5; i++) ids.add(await addMessage());

    const drew: number[] = [];
    for (let i = 0; i < 5; i++) drew.push((await listen("novice", { finish: true })).drew!);

    // All five novices got different messages, covering the whole pool exactly once.
    expect(new Set(drew).size).toBe(5);
    expect(new Set(drew)).toEqual(ids);
  });

  it("re-serves gracefully when a role is over-recruited past the pool size", async () => {
    await addMessage();
    await addMessage(); // pool of 2
    const drew: number[] = [];
    for (let i = 0; i < 4; i++) drew.push((await listen("novice", { finish: true })).drew!);
    // First two are the two distinct messages; the extra novices still get served
    // (last resort re-serve) rather than an error/null.
    expect(new Set(drew.slice(0, 2)).size).toBe(2);
    expect(drew.every((x) => x != null)).toBe(true);
  });

  it("reserves an in-flight message so a concurrent same-role listener avoids it", async () => {
    const a = await addMessage();
    const b = await addMessage();

    const first = await listen("novice", { finish: false }); // holds one, still playing
    const second = await listen("novice", { finish: false }); // must take the other

    expect([a, b]).toContain(first.drew);
    expect([a, b]).toContain(second.drew);
    expect(first.drew).not.toBe(second.drew); // no collision while one is in flight
  });

  it("frees a reserved message when the holder abandons (nothing marked until finish)", async () => {
    const only = await addMessage(); // single-message cell

    const ghost = await listen("novice", { finish: false }); // reserves `only`
    expect(ghost.drew).toBe(only);

    // The ghost abandons and is purged away.
    await deleteSessionsByPid([ghost.pid]);

    // A fresh novice now gets `only` as brand-new (the ghost's draw left no mark).
    const real = await listen("novice", { finish: true });
    expect(real.drew).toBe(only);

    // And it is now seen by exactly one (real) novice trial.
    const db = await getDb();
    const novTrials = ((await db.select().from(trials)) as any[]).filter(
      (t) => t.utteranceId === only && t.assignment === "novice",
    );
    expect(novTrials).toHaveLength(1);
  });

  it("pairs: an expert prefers a message a novice already heard", async () => {
    await addMessage();
    await addMessage();
    const target = await addMessage(); // three messages

    // Force the situation: exactly one message has a finished novice.
    const db = await getDb();
    const pid = "NOVX";
    const sid = "nov-x";
    await upsertParticipant({ prolificPid: pid, studyId: "S", sessionId: pid + "-ps", role: "listener", firstName: "Real", lastName: pid });
    await startSession({ id: sid, prolificPid: pid, role: "listener", plan: {}, assignment: "novice" });
    await openTrial({ sessionId: sid, trialIndex: 0, taskId: CELL.taskId, seed: CELL.seed, condition: {}, assignment: "novice", utteranceId: target });
    await db.update(trials).set({ endedAt: new Date(), correct: true }).where(eq(trials.sessionId, sid));
    await db.update(sessions).set({ status: "completed" }).where(eq(sessions.id, sid));

    // The next expert should land on exactly that message, forming the pair.
    for (let i = 0; i < 5; i++) {
      const drawn = await drawUtterance(CELL.taskId, CELL.seed, CELL.scene, "expert");
      expect(drawn?.id).toBe(target);
    }
  });

  it("runs a full wave to one-novice-one-expert on every message", async () => {
    const ids = new Set<number>();
    for (let i = 0; i < 4; i++) ids.add(await addMessage());

    for (let i = 0; i < 4; i++) await listen("novice", { finish: true });
    for (let i = 0; i < 4; i++) await listen("expert", { finish: true });

    // Every message ends up heard by exactly one novice AND one expert.
    const db = await getDb();
    const ts = (await db.select().from(trials)) as any[];
    for (const id of ids) {
      const nov = ts.filter((t) => t.utteranceId === id && t.assignment === "novice");
      const exp = ts.filter((t) => t.utteranceId === id && t.assignment === "expert");
      expect(nov).toHaveLength(1);
      expect(exp).toHaveLength(1);
    }
  });

  it("a test listener never touches the pool counters, before OR after reconcile", async () => {
    const u = await addMessage();
    await listen("novice", { finish: true });            // a real novice — counts
    await listen("novice", { finish: true, test: true }); // a test novice — must NOT count

    const db = await getDb();
    const read = async () => ((await db.select().from(utterances).where(eq(utterances.id, u))) as any[])[0];

    // Live guard: the test draw was untracked, so the counters already exclude it —
    // there is no "window" in which the test run is counted.
    let row = await read();
    expect(row.timesServed).toBe(1);
    expect(row.servedNovice).toBe(1);

    // The authoritative recompute also drops the test trial.
    await reconcileUtteranceCounters();
    row = await read();
    expect(row.timesServed).toBe(1);
    expect(row.servedNovice).toBe(1);
    expect(row.completedNovice).toBe(1);
    expect(row.listenerTrials).toBe(1);
    expect(row.listenerSuccesses).toBe(1);
    expect(row.successRate).toBe(1);
  });

  it("ignores test-user listeners: their play never consumes a message", async () => {
    const a = await addMessage();
    const b = await addMessage();

    // A test-named novice plays and finishes one of the two messages.
    await listen("novice", { finish: true, test: true });

    // Two REAL novices then draw. If the test run had consumed a slot, one of these
    // would be forced to re-serve and collide; because it's ignored, both get fresh.
    const r1 = (await listen("novice", { finish: true })).drew!;
    const r2 = (await listen("novice", { finish: true })).drew!;
    expect(new Set([r1, r2])).toEqual(new Set([a, b]));
  });
});
