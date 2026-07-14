# The Fetch Games

A web-based, **asynchronous** two-player reference-game platform for HRI research
(extending Tellex et al., *"Asking for Help Using Inverse Semantics"*, RSS 2014).

A **robot** knows what it needs but has failed; a **human** can act but lacks the
robot's knowledge. One utterance is the only bridge. We measure how a listener's
**familiarity** changes which utterance actually works.

> **The event log is the deliverable.** The game is the instrument that produces it.

## Why it is not a synchronous app

The speaker sends **exactly one** utterance and is then locked out; the listener
acts afterward. The two never need to be online together. So we ship **two
decoupled single-player Prolific studies** — Study 1 (speakers) writes utterances
to a pool; Study 2 (listeners) replays them. **No matchmaker, no waiting room.**

## Stack

- **Next.js (App Router)** — client + serverless API in one Vercel deployable, shared TS types.
- **Postgres via Drizzle** — one schema for local and prod.
  - **Local/dev/tests:** [PGlite](https://pglite.dev) — embedded in-process Postgres. No Docker, no server.
  - **Prod:** [Neon](https://neon.tech) serverless Postgres (free tier, no cold-start).
- **zod** — every config file and every event is validated at the boundary; malformed input fails loudly.

> Local dev uses PGlite instead of a Docker Postgres because it needs no external
> service and gives the headless engine a real Postgres to test against. The same
> Drizzle schema migrates unchanged to Neon — set `DB_DRIVER=neon` + `DATABASE_URL`.

## Quick start

```bash
npm install
cp .env.example .env.local        # PGlite defaults work out of the box
npm run db:generate               # SQL migrations from the schema
npm run verify:skeleton           # end-to-end: config loads + a session persists
```

## Scripts

| command | what it does |
|---|---|
| `npm run dev` | Next dev server (UI arrives in Milestone 3) |
| `npm run db:generate` | generate SQL migrations from `src/lib/db/schema.ts` |
| `npm run db:migrate` | apply migrations to the configured DB |
| `npm run verify:skeleton` | Milestone 1 acceptance — condition loads, events round-trip the DB |
| `npm run verify:replay` | Milestone 4 acceptance — speaker writes → pool → replay serves novice+expert |
| `npm run headless -- --bot oracle` | run a `retrieval` trial headlessly with a scripted bot (`oracle`/`random`/`move-only`); add `--viewpoint rotated`, `--budget N`, `--persist` |
| `npm run test` | unit tests (vitest) |
| `npm run typecheck` | `tsc --noEmit` |

## Layout

```
src/
  app/            # Next.js App Router
    page.tsx      # landing
    listener/     # /listener — the Study 2 game flow (client)
    api/listener/ # start | action | timeout | next  (server, node runtime)
  components/      # RobotAvatar, GameBoard (view-only, fog already applied server-side)
  config/
    conditions/   # experiment cells as JSON (validated) — non-engineers author these
    maps/         # ASCII grid + JSON legend
    studies/      # ordered trial plans (which conditions, seeds, feedback flag)
  lib/
    server/
      listener.ts # session orchestration: start/apply/advance/timeout (§8, §9.6)
    types.ts      # Condition, KeyPanel, Task<State,Action> — shared source of truth (§7, §9)
    events.ts     # versioned event-log schema — the scientific record (§10)
    config.ts     # condition + map loaders, fail-loud validation (§9.1)
    env.ts        # validated environment
    db/
      schema.ts   # participants / sessions / trials / events / utterances (§12)
      client.ts   # dual driver (pglite | neon)
      writer.ts   # commits each event immediately — never buffered (§15)
    engine/
      rng.ts      # seeded deterministic RNG (mulberry32)
      viewpoint.ts# server-side direction transform (aligned | rotated)
      registry.ts # task plugin registry (§9.2)
      runner.ts   # headless trial loop, driven by bots (§9.4)
      bots.ts     # scripted listeners: oracle / random / move-only
      index.ts    # barrel: registers tasks, loads built-in maps
    tasks/
      retrieval.ts# Task 1 — the whole task in one file + its event adapter (§4)
scripts/
  migrate.ts          # apply migrations
  verify-skeleton.ts  # Milestone 1 acceptance
  run-headless.ts     # Milestone 2 — run a trial with a bot (CLI)
```

## Build status

- [x] **M1 — Skeleton:** types, config loader, DB schema + event writer. Verified.
- [x] **M2 — Headless engine + `retrieval` + scripted bot listener.** Deterministic
      engine, task-plugin registry, viewpoint transform (server-side), fog of war,
      absent-not-disabled keys, seeded RNG. Bots: oracle / random / move-only.
      Tests green (determinism, fog-of-war no leak, novice view no key data, budget
      exhaustion). Run: `npm run headless -- --bot oracle`.
- [x] **M3 — `/listener` flow + full game UI (Study 2, critical path).** Playable
      end-to-end against scripted utterances. Server-authoritative state
      (`trials.state`), fog-filtered `listenerView` over `/api/listener/*`, keyboard
      + click control, timeout countdown, budget meter, per-condition trial plan
      (`src/config/studies`), and a crafted game UI (warm identity, expressive robot,
      mission progress, trial-end reactions). Bigger varied **facility** map (large +
      medium rooms, 16 objects). **Fog of war visual** — rooms haze until entered,
      reveal on entry, re-fog on exit. **Novice** = no room labels + no parts key;
      **Expert** = all labels + parts key (symbol→name). Dev-only
      **Speaker/Novice/Expert toggle** at `/listener?dev=1` (server-gated OFF in
      production). The **Speaker** view shows the full map + highlighted target +
      parts key + a brief, with a compose box that **saves utterances to the
      `utterances` pool** (`/api/listener/utterance`) — the seed of the M4 speaker
      flow. Run `npm run dev` → open `/listener?dev=1`.
- [x] **M4 — `/speaker` flow + utterance pool (replay end-to-end).** Standalone
      `/speaker` study: see the full scene → write ONE utterance → saved to the
      `utterances` pool. Replay listener studies **draw from the pool** (least-served,
      §8.3) and serve the *same* utterance to a novice AND an expert listener
      (within-utterance comparison), logging `utterance_replayed` traced to the author
      and folding outcomes into per-utterance success (bonus, §12). Configs:
      `speaker_pilot` (Study 1), `listener_replay` (Study 2). Verify:
      `npm run verify:replay`.
- [x] **M5 — `repair` and `teleop` task plugins.**
      - **`teleop`** (§6): open **landmark yard** (scattered emoji reference points),
        hidden goal, control map the novice must infer (no key hints; every press
        costs budget); expert holds the control key. Dev: `/listener?study=teleop_pilot`.
      - **`repair`** (§5): click-target TurtleBot diagram; novice sees **shapes only**,
        expert gets the **labels** (visual→name key); deliberate **trap** (two black
        cylinders, three wheels); target withheld from the listener, ringed for the
        speaker. Dev: `/listener?study=repair_pilot`.
      - Both slot into the shared engine, headless runner, task-aware `/listener` UI,
        and the task-aware speaker view. 33 tests; browser-verified.
- [ ] M6 — Prolific integration (params, consent, mobile block, redirects)
- [ ] M7 — `/admin` dashboard + exports (CSV/JSONL, bonus CSV, replay viewer)
- [ ] M8 — Deploy to free tier + 5-person pilot

## Participant entry & assignment

Participants enter at **`/play`**. On start they are **randomly assigned** (balanced —
always the least-filled cell, random tie-break) to **speaker**, **novice**, or
**expert**, and that assignment is **fixed for all 3 missions** and stored on the
session (`sessions.assignment`). Counts stay equal — after every 3 participants
it's exactly 1/1/1. `/play` routes to the matching flow (`/speaker` or `/listener`)
with the started session.

- **Novice** — fog + no parts key; a room's **label appears as you enter it** (only
  the room you're standing in) and updates as you move.
- **Expert** — fog + all room labels + the parts key.
- **Speaker** — full map (no fog), target highlighted, writes one utterance per mission.

The scenario is **fixed and identical for everyone**: `retrieval_facility` uses
`fixedLayout: true`, so objects stay at authored positions — nothing about the
environment is randomized per participant. The 3 missions differ only in the target.

Direct `/listener` / `/speaker` (no `?sid=`) still start a dev session; add `?dev=1`
for the Speaker/Novice/Expert view toggle.

## ⚠️ Pending sign-off (§16)

The **event-log schema** (`src/lib/events.ts`) is **v1, not final**. Per the
prompt, this must be confirmed before running paid participants. See the open
questions at the bottom of the build notes.
