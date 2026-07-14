# Build: a two-player HRI reference-game platform ("the Fetch Games")

## 1. What we're doing and why

We're an HRI research group extending Tellex et al., *"Asking for Help Using Inverse
Semantics"* (RSS 2014). We need a **web-based, two-player experiment platform** to
collect human data.

The structure is the **advisor–advisee** setup from the *asymmetric* condition of
Potts's Cards Corpus:

> One player **sees everything but cannot act**. The other **can act but doesn't know
> what they're looking at**. A single utterance is the only bridge.

That's our problem exactly: a **robot** that knows what it needs but has failed, and a
**human** who can act but lacks the robot's knowledge.

**The research question:** how does a listener's *familiarity* change which utterance
actually works? So **the event log is the real deliverable.** The game is the
instrument that produces it. Prioritize accordingly.

---

## 2. The central abstraction: familiarity = "do you have the KEY?"

This is the most important idea in the codebase. **Every familiarity axis is the same
primitive — a lookup table the listener either has or doesn't.** Build it once,
generically, and the four axes fall out as configuration.

| Axis | The key | Novice | Expert |
|---|---|---|---|
| **Scene** | room label → name | sees labels of **nearby rooms only** | sees **all** room labels |
| **Robot** | object symbol → part name (★ = charger, ○ = lidar, …) | **no key.** Sees the symbols, can't name them. | **full key panel** |
| **Task** | keystroke → direction (Z = up, G = down, R = right, N = left) | **no key.** Must discover the mapping by pressing keys — *and each press costs budget.* | **full key panel** |
| **Viewpoint** | *(not a key — a transform)* | listener's map is **rotated** relative to the speaker's | frames aligned |

The speaker **always has every key**. The listener's keys are set by the condition.

Design this as one `KeyPanel` concept with a `visible: boolean` (or a partial-visibility
predicate, for the scene case), not as three unrelated features.

---

## 3. Core rules (unusual — read carefully)

- **Two players**, paired over the network: **Speaker** (H1) and **Listener** (H2).
- **The Speaker sees the full world, the target, and every key. The Speaker cannot move.**
- **The Speaker gets exactly ONE utterance.** One message, one send, then the input is
  **locked forever**. This is the central constraint of the entire design.
- **The Speaker is briefed about who they're talking to.** Configurable via
  `speakerBriefing`. **Default for now: they are told they are speaking to a NOVICE**
  (*"Your partner is unfamiliar with this environment"*). This must be trivially
  changeable to `expert` or `unknown` — we will likely run the other conditions later,
  and `unknown` (hedging under uncertainty) is the one that matches our algorithm.
  **Make it a config string, not a hardcoded copy string buried in a component.**
- **The Listener has fog of war**: they see **objects in their current room only**. The
  room *layout* (walls, doors) is always visible; the *contents* are not.
- **The Listener has a capped action budget.** This is essential — it converts search
  cost into success/failure. Without it, everyone eventually succeeds and our primary
  outcome collapses to ceiling.
- **The trial ends** when the Listener commits (picks up an object / clicks a component /
  reaches the goal), or the budget is exhausted, or a timeout fires.
- **Follow-up questions:** `allowFollowups` config, **default `false`** (matching our
  current design). When enabled, the Listener may ask, but **the Speaker can never
  answer** — the system replies with a fixed canned line, and the question is **logged as
  a dependent variable**. Never let a follow-up carry information; that would destroy the
  one-utterance design.

---

## 4. Task 1 — `retrieval` (Object Retrieval)

**Probes: SCENE familiarity and ROBOT familiarity** (as two separate conditions), plus viewpoint.

**World:** a grid of ~6 rooms (`A E D` / `B Z R`) connected by doors. Objects are
**robot parts**, drawn as symbols:

| symbol | part |
|---|---|
| ★ | charger |
| Δ | camera |
| ● | wire |
| ⬤ | control |
| ○ | lidar |

Multiple instances of each part are scattered across rooms. **One is the target.**

**Speaker view:** full map, all room labels, **all objects in all rooms**, the parts key,
target highlighted, and a message box → `[type message here] [Send]`.

**Listener view:** the map layout, their own position, **objects in their current room
only**. Moves room to room. Picks up **one** object → trial ends.

**Conditions:**
- **I — Scene:** *novice* sees labels of **nearby rooms only**; *expert* sees **all** room labels.
- **II — Robot:** *novice* has **no parts key** (sees ○ but doesn't know it's a lidar);
  *expert* has the **full key panel**.
- **Viewpoint:** the listener's map is rendered **rotated** relative to the speaker's, so
  left/right and up/down descriptions invert.

Scene and Robot conditions must be independently settable (including both-novice), even
if we don't run every cell.

---

## 5. Task 2 — `repair` (Resolve a Hardware Issue)

**Probes: ROBOT familiarity.** Not a grid — a **click-target** task.

A 2-D diagram of a **TurtleBot** with labeled-in-the-key components (LiDAR, charging
port, camera, wire, control board, e-stop, caster). The Listener **clicks one component**.

- **Speaker view:** the diagram, the parts key (visual → name), the target component
  highlighted. Example utterance from our whiteboard:
  *"The LiDAR module is unplugged, plug it back in."*
- **Listener novice:** **no parts key.** Must infer the referent from the Speaker's words
  alone.
- **Listener expert:** **gets the key** (visual → name).
- **Include a deliberate trap:** at least two visually similar components, so a bare
  description ("the black cylinder") is not uniquely identifying.
- **Viewpoint:** render the robot **from behind**, making *"the port on its left"*
  ambiguous between the robot's left and the listener's.

---

## 6. Task 3 — `teleop` (Teleoperate the Robot)

**Probes: TASK familiarity.** This one is subtle — read closely.

**A grid with a start `S` and a goal `E`.**

- **The Speaker sees BOTH `S` and `E`.**
- **The Listener sees ONLY `S`.** They do **not** know where the goal is.
- The Listener drives the robot with **keystrokes mapped to arbitrary letters**:
  `Z = up`, `G = down`, `R = right`, `N = left`. **(Randomize this mapping per session.)**
- **Listener expert:** has the **control key** showing which letter maps to which direction.
- **Listener novice:** **no key.** They may discover the mapping by **trial and error —
  but every keypress costs budget.** So the key is a *cost advantage*, not a hard gate,
  and the Speaker can choose to spend their one utterance partly on the mapping
  (*"press Z to go up"*) instead of purely on the route.

That tradeoff — **spend the utterance on the procedure, or on the goal?** — is the whole
point of this task. Make sure both are expressible.

- **Viewpoint:** **egocentric camera** — the Listener sees what the *robot* sees, so
  directions are relative to the robot's heading, not the screen.

---

## 7. The condition object (this *is* the experiment)

```ts
type Familiarity = 'novice' | 'expert';

interface Condition {
  taskId: 'retrieval' | 'repair' | 'teleop';

  keys: {                        // which keys the LISTENER has
    sceneLabels: 'nearby' | 'all';
    partsKey:    boolean;
    controlKey:  boolean;
  };
  viewpoint: 'aligned' | 'rotated';   // rotated == inverted / egocentric, per task

  budget:    number;             // capped actions. REQUIRED.
  timeoutMs: number;

  speakerBriefing: 'novice' | 'expert' | 'unknown';   // default: 'novice'

  // Where the utterance comes from. See §8 (deployment) — this is load-bearing.
  speakerMode: 'human' | 'replay' | 'scripted';
  utteranceSource?: {
    text: string;
    speakerSessionId?: string;   // set when mode === 'replay'; traces back to the human who wrote it
  };

  allowFollowups: boolean;       // default false
  followupReply: string;         // canned; never informative

  seed: number;                  // same seed + condition ⇒ identical world. Non-negotiable.
}
```

**On `speakerMode` — three sources, one engine:**
- `human` — a live participant writes it (used in the **Speaker study**).
- `replay` — a **previously recorded human utterance** is served to this listener. *This is
  our main production path* (see §8).
- `scripted` — an utterance from a pre-generated feature grid (experimental control, for
  model fitting).

**All three must produce identical log formats.** Build this seam on day one; retrofitting
it means writing the thing twice.

---

## 8. Deployment: Prolific, and why this is NOT a synchronous app

**Read this before designing the networking layer. It will save you weeks.**

The game *looks* two-player, but **it is not synchronous.** The Speaker sends exactly one
utterance and is then locked out. The Listener acts afterward. Even with follow-ups
enabled, **the Speaker never replies.** There is no back-and-forth at any point.

**Therefore the two players never need to be online at the same time**, and we deploy as
**two decoupled single-player studies**:

| | **Study 1 — Speakers** | **Study 2 — Listeners** |
|---|---|---|
| N | ~60 | ~200 |
| Duration | ~10 min | ~20 min |
| Flow | See the scene + target + all keys → write **one** utterance → next scene | Receive a **replayed** utterance from the Study 1 pool → play under an assigned condition |
| `speakerMode` | `human` | `replay` |

This means **no waiting room, no matchmaking, no stranded-partner handling, and no 2×
participant burn from dropout.** Do not build a matchmaker.

**It is also a better experimental design.** The *same* utterance is served to a novice
*and* an expert listener, giving a **within-utterance comparison** — far more powerful
than comparing across independent dyads, where speaker variance swamps the effect.

### What this requires of you

1. **Two entry flows, one engine.** `/speaker` and `/listener` routes. They share the task
   plugins, the world generation, and the log format. They are not separate apps.
2. **An utterance pool.** Study 1 writes utterances to a store, keyed by
   `(taskId, seed, scene)`. Study 2 draws from it. Every listener session logs the
   `speakerSessionId` it replayed, so we can trace any outcome back to its author.
3. **A pool-assignment policy** (config-driven): each utterance should be served to
   multiple listeners across **different familiarity conditions**. Don't let one utterance
   get consumed by a single condition.

### Prolific integration (both studies)

- Participants arrive with query params: `PROLIFIC_PID`, `STUDY_ID`, `SESSION_ID`.
  **Capture these at entry and stamp them onto every log line.** If they're missing, show a
  clear error — do not silently proceed with a null participant.
- On completion, redirect to `https://app.prolific.com/submissions/complete?cc=<code>`.
  Separate completion codes for **complete** vs **screened-out**. Codes go in config.
- **Desktop only.** These are keyboard tasks. Detect and block mobile at entry with an
  explanatory screen, before consent.
- **Bonus payments for speakers.** Speakers must be told upfront that they earn a bonus
  based on how well *real listeners later perform* with their utterance. Without a
  performance incentive, speakers write lazy utterances and the entire dataset is
  worthless. Export a bonus CSV (`PROLIFIC_PID, amount`) from the listener outcomes.
- Standard consent screen + attention checks, both config-driven.

### Not now, but don't foreclose it
If we later want a **free-dialogue** corpus (unconstrained back-and-forth), that is a
genuinely synchronous study — and we will use **Empirica v2** for it rather than building a
matchmaker. Keep the engine free of assumptions that would prevent a future live mode, but
**do not build one now.**

---

## 9. Architecture requirements

### Non-negotiables

1. **Config-driven, not code-driven.** Adding a map, a condition, or an utterance set must
   not require touching engine code. Non-engineers will do this.
2. **Tasks are plugins** behind one interface. A 4th task = one new file + a registration.
3. **The event log is the product.** Versioned schema, append-only, **written to a database
   as it happens** (see §12). Timestamps on everything. Exportable as JSONL/CSV at any time.
4. **Headless engine.** The game must run **without a browser**, driven by scripted bots.
   This is how we test it *and* how `scripted` speaker mode works. Build it early — do not
   bolt it on.
5. **Deterministic given a seed.**
6. **All view filtering happens on the SERVER.** Treat the listener's view as a security
   boundary. If fog of war or a hidden key is enforced in CSS or client state, one
   participant with devtools voids the manipulation and we won't find out until analysis.

### The task interface (intent, not literal)

```ts
interface Task<State, Action> {
  id: TaskId;
  init(seed: number, cond: Condition): State;
  speakerView(s: State): SpeakerView;                     // everything
  listenerView(s: State, cond: Condition): ListenerView;  // fog of war + keys + viewpoint applied
  legalActions(s: State): Action[];
  apply(s: State, a: Action): State;                      // decrements budget
  isTerminal(s: State): boolean;
  outcome(s: State): { correct: boolean; cost: number; targetId: string; chosenId: string | null };
}
```

### Suggested stack (push back if you disagree)
- **TypeScript throughout**, one repo, shared types.
- **Client:** Vite + React + Tailwind. **No canvas/WebGL** — the grid is a grid of divs.
  These are 6-room maps, not Skyrim. Framer Motion is fine for transitions.
- **Server:** serverless API routes (no long-lived socket server — the game is async).
- **Persistence: a real database.** See §12. *Not* flat files — our hosting has an
  ephemeral filesystem, so anything written to disk is destroyed on redeploy. Losing a
  participant's data because it was written to `/tmp` would be unrecoverable and expensive.

### Maps as data
ASCII + JSON legend, authorable in a text editor:

```
###################
#..A....#...E..#.D#
#...c...+...w..+..#
####+####...#..#..#
#..B....#.Z.#..R..#
###################
```
```json
{ "rooms": { "A": "supply room", "B": "workshop", "E": "hallway" },
  "objects": [ {"id":"c1","symbol":"★","part":"charger","room":"A","pos":[4,2]} ],
  "target": "c1",
  "listenerStart": [1,1],
  "controlMap": { "Z":"up", "G":"down", "R":"right", "N":"left" }
}
```

---

## 10. Event log schema (sketch — tighten it, then ask me before finalizing)

**Every line carries the Prolific identity.** `pid` = PROLIFIC_PID, plus study/session ids.

```jsonl
{"v":1,"t":...,"ev":"session_start","sid":"...","pid":"5f2a...","prolific":{"studyId":"...","sessionId":"..."},"role":"listener","cond":{...}}
{"v":1,"t":...,"ev":"speaker_briefed","sid":"...","briefing":"novice"}
{"v":1,"t":...,"ev":"utterance_sent","sid":"...","text":"...","composeMs":14200}
{"v":1,"t":...,"ev":"utterance_replayed","sid":"...","text":"...","speakerSessionId":"...","speakerPid":"..."}
{"v":1,"t":...,"ev":"listener_action","sid":"...","action":"KEY_Z","resolved":"up","budgetLeft":33,"pos":[4,2],"room":"A"}
{"v":1,"t":...,"ev":"room_entered","sid":"...","room":"E","objectsRevealed":["w1","w2"]}
{"v":1,"t":...,"ev":"followup_asked","sid":"...","text":"which shelf?"}
{"v":1,"t":...,"ev":"trial_end","sid":"...","correct":false,"cost":40,"chosen":"c2","target":"c1","reason":"wrong_object"}
```

Log the **full listener path** and **every keypress** (including failed exploratory
presses in `teleop` — those are the cost of not having the control key, and they are a
primary measure).

---

## 11. UI: make it a *game*, not a form

**This must be genuinely pleasant to look at and satisfying to play.** Not a grey academic
questionnaire. Aim for the feel of a well-made puzzle game — think *Baba Is You*, *Mini
Metro*, *Untitled Goose Game* menus: **minimal, confident, characterful.**

This is not vanity. **Engagement is a data-quality issue.** Bored participants satisfice,
rush, and drop out — and on Prolific we pay for them anyway. A game people *want* to
finish gives us better data and lower attrition. Treat visual craft as part of the
methodology.

### Direction
- **A cohesive identity.** One tight palette (a warm neutral base, one accent, one alert
  colour). Two fonts max: a clean geometric sans for UI, a good mono for the grid. Pick
  actual colours and commit — no default Bootstrap grey.
- **Give the robot a character.** It has failed and is asking for help. A small, expressive
  robot avatar with a couple of states (waiting, hopeful, thanking you) costs almost
  nothing and transforms how the task feels.
- **Frame trials as missions.** A run of trials should feel like a sequence with progress
  ("Mission 3 of 12"), not a survey with pages.
- **Motion: fast, purposeful, ~150–200ms.** Rooms reveal with a quick fade as you enter.
  The budget counter ticks. Picking up an object lands with a satisfying snap. **No juice
  for its own sake** — nothing bouncy, nothing that delays input, nothing that makes a
  participant wait.
- **Sound: off by default**, with a mute toggle if you add any. Many participants are in
  shared spaces.
- **Chunky, legible grid.** Rooms with real presence, clear doors, readable symbols. The
  key panel is a nice-looking **legend card**, not a table.
- Fits a laptop screen without scrolling. Keyboard-first.

### Guardrails — polish must NEVER leak information
This is where pretty UIs quietly destroy experiments. Non-negotiable:
- **Nothing visual may reveal what the condition hides.** No glow on the target, no hover
  hint on an unknown part, no minimap that shows unvisited rooms, no colour-coding that
  encodes an object's identity to a listener who has no parts key.
- When the listener **lacks a key, the panel is absent** — not greyed, not blurred, not
  locked-with-a-padlock. **Absent.** A visible-but-disabled panel tells them a key exists,
  which is itself information.
- **No animation that previews a room before entry.** Reveal happens on arrival, not on
  approach.
- If in doubt about whether an effect leaks: **it leaks. Cut it.**

### Two moments worth extra care
- **The Speaker's send.** They get **one** utterance. The compose box should feel weighty —
  a clear "you get one shot" framing, a confirm step, and an unmistakable **locked** state
  after sending. If this reads as a bug, participants will email us about it.
- **The end-of-trial screen.** Show the outcome with some warmth (the robot reacts). But
  see the config flag below — whether we reveal *correctness* is a scientific decision, not
  a design one.

```ts
showTrialFeedback: boolean;  // default: true, BUT SEE BELOW
```
**Flag this to me when you build it.** Per-trial correctness feedback is great for
engagement but risks teaching participants across trials (especially the control mapping
and room layouts). Our mitigation is to **re-randomize the map and the control mapping
every trial** — do that regardless. If we can't guarantee no cross-trial learning, we turn
feedback off and show a summary only at the end.

---

## 12. Backend, persistence, and getting the data out

**The backend is not an afterthought — it is the thing that holds our only copy of the
data.** Design it before the UI.

### Persistence: a real database, not files
Free hosting has an **ephemeral filesystem**. Anything written to disk vanishes on redeploy
or container recycle. **Every event must be committed to a database as it happens** —
never buffered in memory and flushed at the end, because a participant who closes the tab
mid-trial must still leave us their partial data (that's a dropout signal we need).

**Schema (start here, then tighten and ask me before finalizing):**

| table | contents |
|---|---|
| `participants` | `prolific_pid`, `study_id`, `session_id`, `role`, `consented_at`, `completed_at`, `user_agent` |
| `sessions` | one per participant-run: assigned conditions, seeds, start/end, completion status |
| `trials` | one per trial: condition, task, seed, utterance (+`speaker_session_id` if replayed), outcome, cost, time |
| `events` | the append-only firehose — every keypress, move, room entry, follow-up, with timestamps |
| `utterances` | the speaker pool: text, task, seed/scene, author session, times served, aggregate listener success |

`events` is the scientific record. **Never overwrite, never delete.** Everything else can be
recomputed from it.

### Data export — build this early, not at the end
A **password-protected admin route** (`/admin`, single shared secret from an env var — no
user accounts) that provides:
- **Export all data** as CSV *and* JSONL. One click. Must work while the study is running.
- **A live dashboard:** sessions started / completed / abandoned, counts per condition cell
  (so we can see which cells are underfilled), mean success rate per condition, median
  completion time, dropout points.
- **Prolific bonus CSV** export (`PROLIFIC_PID, amount`) computed from speakers' downstream
  listener success.
- **A session replay viewer** — step through any participant's trial event-by-event. This
  will save enormous debugging time and is how we'll spot participants who gamed the task.

We must be able to pull the full dataset at any moment **without redeploying or SSHing
anywhere.**

---

## 13. Hosting — free, and it must not cold-start

Deploy so that **hosting costs nothing** at our scale (a few hundred participants, tiny
payloads).

**Recommended: Vercel (frontend + API routes) + Neon or Supabase (Postgres).** Both have
genuinely free tiers that comfortably cover this. Cloudflare Pages + Workers + D1 is an
equally good alternative — pick one and justify it.

**The one hard constraint: NO COLD STARTS during a participant session.** Several free
tiers (notably Render's) **spin down after inactivity** and take 30–60s to wake. A Prolific
participant who hits a dead page will abandon — **and we still pay them.** Do not use a
host that sleeps. If the database tier pauses on inactivity (Supabase does after a week),
add a scheduled ping to keep it warm and say so in the README.

Also required:
- **One-command local dev** (`npm run dev`) with a local DB, so we can iterate without touching prod.
- **Config-driven completion codes and study params** via env vars — we must be able to
  spin up a new Prolific study without a code change.
- **A README** covering: deploy, set env vars, launch a study, monitor it, export the data.
  Written for a researcher, not for you.

---

## 14. Build order — milestones, and stop after each

1. **Skeleton:** types, config loader, **database schema + event writer**. No UI. Prove a
   condition loads and a session persists.
2. **Headless engine + `retrieval` + a scripted bot listener.** CLI-runnable. Tests:
   determinism from seed; fog of war never leaks distant objects; a novice's view never
   contains key data; budget exhaustion terminates.
3. **The `/listener` flow + full game UI**, driven by `speakerMode: 'scripted'`. Playable
   end-to-end by one human against a canned utterance. **This is the critical path** — it
   is the whole of Study 2. Get the *feel* right here; the other tasks inherit it.
4. **The `/speaker` flow + the utterance pool.** Now `replay` works end-to-end: Study 1
   writes, Study 2 reads.
5. **`repair` and `teleop`** as plugins. If the task interface is right, this is mostly
   additive.
6. **Prolific integration:** param capture, consent, mobile block, completion redirects.
7. **The `/admin` dashboard + exports** (CSV/JSONL, condition-cell counts, bonus CSV,
   replay viewer).
8. **Deploy to the free tier**, run a 5-person pilot end-to-end, and **export the data** —
   before we spend a cent on real participants.

---

## 15. Do not

- **Build a matchmaker, waiting room, or live pairing.** See §8 — the game is asynchronous.
  This is the single biggest way to waste weeks on this project.
- **Write data to the filesystem.** Ephemeral. It will be lost. Database only.
- **Buffer events in memory** and flush at the end. A participant who closes the tab must
  still leave us their partial data.
- **Deploy on a host that cold-starts.** A sleeping free tier costs us real money in
  abandoned participants.
- Use a game engine. This is divs in a grid — the polish comes from CSS and restraint.
- Filter the listener's view on the client. Ever.
- Ship any visual effect that reveals what the condition hides (see §11 guardrails).
- Fail silently. A malformed condition file, or a missing `PROLIFIC_PID`, should **fail
  loudly.**
- Make follow-up replies informative.

---

## 16. Ask me before assuming

Stop and ask on anything hard to reverse — **the log schema above all**, plus the utterance
pool store and the task interface. A wrong log schema is the one mistake we won't discover
until after we've paid participants.

**Open items I already know we need to settle — raise them when you get there:**
- Whether object positions get **re-randomized within a room** between trials (our board
  says *"rearrange objects inside the room"* — probably yes, to prevent memorization).
- Exact **budget values** per task (we'll tune these from pilot data — make them config).
- Whether **scene-novice** "nearby rooms" means adjacent-only, or within-N-rooms.
- The **pool-assignment policy**: how many listeners per utterance, and how they're spread
  across familiarity conditions.
- **Bonus formula** for speakers (a function of their utterance's later listener success).
