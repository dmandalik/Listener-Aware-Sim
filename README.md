# Listener-Aware Inverse Semantics — Data Collection Game

> **AIRLab, Cornell Tech** · Summer 2026

A web-based, asymmetric multiplayer experiment platform for collecting human–human communication data. This is Stage 1 of a human-robot collaboration research project aimed at developing an algorithm for robots to generate help requests that work for the least-informed human listener.

---

## Table of Contents

1. [Project Background](#1-project-background)
2. [The Data Collection Game](#2-the-data-collection-game)
3. [The Three Tasks](#3-the-three-tasks)
4. [What We Collect](#4-what-we-collect)
5. [How a Session Works](#5-how-a-session-works)
6. [Tech Stack](#6-tech-stack)
7. [Running Locally](#7-running-locally)
8. [Admin Dashboard](#8-admin-dashboard)
9. [Downloading the Data](#9-downloading-the-data)
10. [Deploying to Production](#10-deploying-to-production)
11. [Tests](#11-tests)
12. [Key References](#12-key-references)

---

## 1. Project Background

When a robot fails, it needs a human's help to recover — but the same message lands very differently depending on who receives it. A novice asked to "fetch the LiDAR from drawer 3" has no idea what a LiDAR is, and an expert would already be moving before the robot finishes the sentence. The goal of this project is to build a robot communication system that works for the *worst-case* or *least-informed* listener, not just the average one.

This game is **Stage 1** of a five-stage pipeline:

```
Stage 1 ──► Stage 2 ──► Stage 3 ──► Stage 4 ──► Stage 5
Human–Human   Synthetic    Train the    Integrate    In-Person
Comms Dataset   Data       Utterance    with Robot   HRI Studies
(THIS REPO)   Expansion   Generator    Algorithm
```

We need real human communication data before we can train our utterance generating model. The game collects that data by putting a Speaker (who sees everything) and a Listener (who sees only what a real human collaborator would see) in the same scenario. We then compare how Novice and Expert Listeners perform on the same message.

---

## 2. The Data Collection Game

The game recreates a robot-failure scenario in a browser, modeled on the advisor–advisee setup from [Potts's Cards Corpus](https://web.stanford.edu/~cgpotts/papers/potts-wccfl30-cards.pdf). There are three roles.

### Speaker (robot equivalent)

Sees the full scene — the goal, the layout, the part names, the controls. Writes **one message** that a future Listener will read. That is their only move.

### Expert Listener

Can act but has restricted, localized knowledge. Receives one message from a Speaker and tries to complete the task. Gets extra context: part names labeled on screen, room names visible, or a key-to-direction legend. Represents a user with relevant familiarity.

### Novice Listener

Same restricted scene view as the Expert but gets **none** of the extra context — no labels, no legend, no room names. Must rely almost entirely on the Speaker's message. Represents the hardest-to-help or least-informed user.

The same message goes to one Novice and one Expert, enabling a direct within-utterance comparison of how much the message's wording determines success.

---

## 3. The Three Tasks

Every participant plays all three tasks, two rounds each (six rounds total). After each round they fill in a short survey based on the NASA-TLX workload assessment tool.

### Task 1 — Robot Teleoperation

A robot needs to be driven from a start position to a goal on a grid using keyboard keys (for example: G=down, N=left, R=right, Z=up). The Speaker sees the full grid, the goal location, and the key legend. They write one message describing the route.

- **Expert Listener** sees the key-binding legend, so letter-to-direction mappings are visible.
- **Novice Listener** sees only unlabeled letter keys and must work out directions from the message alone.

*Potential Speaker message example:* "Go down 8 times. Go right 9 times."

*Novice-targeted message example:* "Move down 8 times (press G). Move right 9 times (press R)."

### Task 2 — Hardware Failure

The robot has a maintenance board with several parts that need connecting. The Speaker sees all parts labelled with fictional names (e.g., "Vornak", "Torvin") and knows exactly which two to connect.

- **Expert Listener** sees all parts labelled by name and drags one onto the other.
- **Novice Listener** sees only unlabelled shapes and must identify the right two from the Speaker's spatial description.

*Potential Speaker message example:* "Connect the Vornak part to the Torvin part."

*Novice-targeted message example:* "Connect the black rectangle object in the bottom row to the blue/white clock object on the top row."

### Task 3 — Object Retrieval

The robot needs a part fetched from another room in a building. The Speaker sees the full building layout with room names and a labelled parts key. Listeners can only see the room they are currently in; room names are revealed only once a room is entered.

- **Expert Listener** sees room names and the parts legend.
- **Novice Listener** sees only object shapes with no labels and no map.

*Potential Speaker message example:* "Pick up the star charger part in the 'storage bay' room. The storage bay is the leftmost room on the board."

*Novice-targeted message example:* "Move to the room farthest on the left using the arrow keys, then click on the star-shaped object."

---

## 4. What We Collect

### Per Participant (once at registration)

- Name and email
- Self-rated robot familiarity (5-point Likert)
- Optional demographics: age, gender, race
- Open-ended feedback at the end of the study

### Per Trial — Speaker

- The utterance(s) they wrote
- Self-confidence the message will succeed

### Per Trial — Listener

- Usefulness and clarity ratings for the utterance (5-pt Likert)
- Time taken to complete the task
- Number of moves / tries used
- Whether they succeeded

### After Each Trial — Everyone

- NASA-TLX workload survey (6 items, 0–100 each)

---

## 5. How a Session Works

1. A participant accesses the study via a link and provide their name and email. All personal identifying information is anonymized and recorded separately from response data.
2. The app assigns a role automatically.
3. A Speaker completes all three tasks (6 rounds) and is done.
4. A Listener is assigned one already-completed Speaker's messages and plays against them.
5. The same Speaker message goes to exactly one Novice and one Expert for matched comparison.
6. The app saves the full trail: who wrote each message, who read it, and what happened.

### Role Assignment Logic

The system targets 5 Speakers → 5 Novices → 5 Experts per batch, based on participants who *complete* the study. If someone drops out mid-session their slot reopens for the next arrival. Anyone named "Test" or "User", or with a blank name, is treated as a test run and excluded from analysis.

---

## 6. Tech Stack

| Layer | Technology |
|---|---|
| Framework | Next.js (App Router) |
| Hosting | Vercel |
| Database (local) | PGlite — runs inside the app, zero setup |
| Database (production) | Neon (serverless Postgres) |
| ORM | Drizzle |
| Validation | zod — validates every config file and every saved event |

---

## 7. Running Locally

```bash
npm install
cp .env.example .env.local
npm run dev
```

Open http://localhost:3000. Local runs use a throwaway in-process database (PGlite) and cannot reach the live site or its data.

### For Developers: Testing the Interfaces

Add `dev=1` to skip the queue and jump straight into any role:

```
# Listener views
http://localhost:3000/listener?study=teleop_pilot&dev=1
http://localhost:3000/listener?study=repair_pilot&dev=1
http://localhost:3000/listener?study=listener_pilot&dev=1

# Speaker view
http://localhost:3000/speaker?study=main_speaker
```

### Resetting the Local Database

The local database lives in a `.pglite` folder. To wipe it and start clean:

```bash
rm -rf .pglite
```

---

## 8. Admin Dashboard

Navigate to `/admin` and enter the admin password.

**Dashboard tab** — Live counts of finished Speakers, Novices, and Experts; per-game results.

**Analysis tab** — Updates automatically as data arrives. Shows success rates by novice vs. expert, NASA-TLX workload per task, within-utterance message comparisons, and clarity ratings.

**Download** — Every database table available as CSV.

A second, view-only password is available for administrators who only need to read the data.

---

## 9. Downloading the Data
 
All tables are downloadable as CSV from the admin page.
 
| Table | Contents |
|---|---|
| `dataset` | The primary analysis file. All utterances mapped from Speaker to Listener — who wrote each message, which novice and expert received it, and whether each succeeded. |
| `results` | Raw per-trial outcome metrics for each Listener: task success, number of moves, time taken, and other behavioral measures. |
| `authored` | Utterance-level statistics aggregated across all Listeners who received each message: `timesServed`, `completedNovice`, `completedExpert`, `listenerSuccesses`, `listenerTrials`, `successRate`, and more. Useful for identifying which messages worked broadly vs. only for experts. |
| `tlx` | Compiled NASA-TLX workload responses for every scene for every participant (6 items × 6 rounds per person). |
| `survey` | All demographic information collected. |
| `roster` | All participants and their assigned roles (Speaker, Novice, Expert). |
| `utterances` | List of all Speaker utterances with metadata: study, scene, speaker ID, and submission timestamp. |
| `trialSurveys` | Listener responses to the post-trial survey items (usefulness and clarity ratings per round). |
| `trials` | Game events sorted by trial and scene — a structured view of what happened within each round. |
| `sessions` | Each game session recorded as a single row with start time, end time, role, and completion status. |
| `participants` | Participant details. |
| `events` | Every action taken by every user at full granularity. Used primarily for session replay and debugging. |
 
---

## 10. Deploying to Production

See [docs/deploy.md](docs/deploy.md) for step-by-step instructions for Vercel + Neon.

---

## 11. Tests

```bash
npm test
```

---

## 12. Key References

- **Tellex et al. (2014).** "Asking for Help Using Inverse Semantics." *RSS.* — The foundational inverse-semantics framework this project extends.
- **Potts (2012).** Cards Corpus — Inspiration for the asymmetric advisor–advisee game design.