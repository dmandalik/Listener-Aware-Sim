# PDDL models of participants

This turns the study's collected data into **PDDL models of each human participant**,
one per trial. It follows the same design as
[MARLHospital](https://github.com/portal-cornell) (the *Skill-Aligned Fairness in
Multi-Agent Learning* paper): a **PDDL planner layer** for the symbolic task, plus a
separate **state/skill layer** for expertise, effort, and workload. We keep that split
exactly.

## The three pieces

| Piece | What it is | Where |
|---|---|---|
| **Domain** | The "physics" of a task: predicates + STRIPS actions. Fixed, authored once. | `domains/<task>.pddl` |
| **Problem** | One scenario: `:objects`, `:init`, `:goal`. Generated per trial from the scene. | `out/<task>/<pid>/<layout>/problem.pddl` |
| **Profile** | The skill / observability layer: role, novice/expert, message, success, moves vs optimal, effort, subjective ratings. | `out/<task>/<pid>/<layout>/profile.json` |

A PDDL model of one human = **domain + problem + profile**, the analog of
MARLHospital's (domain, problem, wrapper-config).

### Why the split (kept identical to MARLHospital)

- **Faithfulness:** clean *symbolic* domains, not an exact mirror of the game engine —
  the same altitude as `hospital_robotouille.pddl`.
- **Skills live outside the PDDL:** skill level, effort/energy, and subjective ratings
  go in `profile.json`, not in numeric PDDL fluents. MARLHospital does the same (skills
  are in the MARL state layer, not the planner).

## Novice vs expert = a capability predicate

The only PDDL-level lever for role/skill is a capability predicate in `:init`, exactly
like MARLHospital's `(cancompresschest robotN)`:

| Task | Expert holds | Novice lacks it |
|---|---|---|
| teleop | `(knows-controls listener)` — the key→direction map | must use the abstract `move` |
| retrieval | `(knows-part-names listener)`, `(knows-room-labels listener)` | sees only shapes + current room |
| repair | `(knows-part-names listener)` | sees only shapes + positions |

Speakers are modeled as full-observability agents (all capability predicates on) whose
authored message is recorded in the profile.

## Run it

The generator reads the study's own scene configs (`src/config/maps`) plus a data
snapshot you download from the admin page:

```bash
# 1. Drop the exported tables into pddl/data/ (JSONL):
#    trials.jsonl, sessions.jsonl, participants.jsonl, trialSurveys.jsonl
#    from  /api/admin/export?table=<name>&format=jsonl
# 2. Generate:
npx tsx pddl/generate.ts
```

It writes one `problem.pddl` + `profile.json` per **completed, non-test** trial under
`pddl/out/`. Test/dev runs and unfinished sessions are skipped — the same rule the rest
of the pipeline uses.

## Access it any time

Everything here is a **pure function of the event log + the scene configs**, both of
which are versioned. So the whole PDDL corpus is regenerable at any moment and is
deterministic: the same data snapshot always yields the same PDDL. To refresh, re-export
the tables and re-run — nothing is hand-edited. (A `/api/admin/pddl` endpoint that streams
a zip of the same output is a small follow-on if you want it served rather than scripted.)

## Data → PDDL mapping

| Study field | PDDL construct | Layer |
|---|---|---|
| `taskId` | which domain | domain |
| `scene` / map | `:objects` + `:init` (grid, parts, layout) | problem |
| `targetId` / `connect` / `goal` | `:goal` | problem |
| `assignment` (novice/expert/speaker) | capability predicate(s) | problem `:init` |
| `utteranceText` | the instruction | profile + problem header comment |
| `cost` (moves) vs BFS optimal | `skill.level` = optimal / moves | profile |
| `durationMs` | `effortMs` (energy/fatigue proxy) | profile |
| `correct` | `outcome.success` | profile |
| `comprehension` / `usefulness` / `confidence` | `subjective` | profile |

## Notes

- `pddl/data/` and `pddl/out/` are git-ignored — they contain participant messages and
  ids. Only the generator + domains + this README are tracked.
- The generator is standalone (run with `tsx`); it is not part of the app build.
