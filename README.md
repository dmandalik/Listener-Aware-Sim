# Fetch Games

A web game for a research study at the Cornell Tech AIRLab. It looks at how people give
instructions to each other when one of them can see everything and the other cannot.

The idea comes from robotics. A robot knows what it needs but cannot act. A person can
act but does not know what the robot knows. A single written message is the only link
between them.

## The two roles

The **Speaker** sees the whole scene and writes one message. That is their only move.

The **Listener** reads only that message and tries to do the task. Listeners come in two
kinds. Experts get extra context, like the names of parts or which key does what.
Novices get none of that, so they lean on the message much more. The point of the study
is to find messages that work even for the person who knows the least.

## The games

Everyone plays three short games, two rounds each, so six rounds in all.

- **Driving:** steer a robot across a grid to a goal using keys.
- **Repair:** connect the two correct parts on a board.
- **Retrieval:** walk through a building and pick up the right part.

After each round the player answers a few quick workload questions (the NASA TLX). That
gives six workload answers per person, one per round.

## How a session works

Everyone opens the same link. The app picks a role for each person on its own. It fills
every Speaker slot first, so a full set of messages exists before any Listener plays.
Then it fills Novices and Experts.

A Speaker writes a message and it goes into a shared pool. Later a Listener is handed one
message from a Speaker who finished, and plays against it. The same message goes to one
Novice and one Expert, so the two can be compared directly. The app saves the whole
trail: who wrote the message, who read it, and how they did.

## How roles get filled

Five Speakers, then five Novices, then five Experts. The count is based on people who
actually finish. If someone quits partway, their slot opens again and the next person
takes it. Anyone named Test or User, or with a blank name, counts as a test run and is
left out. This keeps the three groups even no matter who shows up or drops out.

## Tech

- **Next.js** with the App Router. The site and the API ship together on Vercel.
- **Postgres** through Drizzle. Local runs use PGlite, which runs inside the app with no
  setup. Production uses Neon.
- **zod** checks every config file and every saved event, so bad input fails right away
  instead of quietly corrupting data.

## Run it locally

```
npm install
cp .env.example .env.local
npm run dev
```

Open http://localhost:3000. Local runs use a throwaway database on your machine. They
cannot reach the live site or its data.

To try the games and switch between the Speaker, Novice, and Expert views, add `dev=1`:

```
http://localhost:3000/listener?study=teleop_pilot&dev=1
http://localhost:3000/listener?study=repair_pilot&dev=1
http://localhost:3000/listener?study=listener_pilot&dev=1
http://localhost:3000/speaker?study=main_speaker
```

The local database is just a file on your machine, in a `.pglite` folder. It never
touches the live site or its data. To wipe it and start clean, delete the folder:

```
rm -rf .pglite
```

## The admin page

Go to `/admin` and enter the admin password. You get:

- A **dashboard** with the number of finished Speakers, Novices, and Experts, plus
  results for each game.
- An **Analysis** tab that compares Novices and Experts as more people play. It shows
  success rates, effort, the message by message comparison, and workload. It updates on
  its own.
- A **download** button for every table as CSV.

There is a second password that is view only. Share it with people who only need to look
at the data. It cannot delete anything.

## Getting the data

Every table can be downloaded as CSV from the admin page. The main file for analysis is
`dataset`. It has one row per Listener response with the message, who wrote it, who read
it, and the result. The `tlx` file has the workload answers. The `survey` file has
demographics and open feedback.

## Deploying

See [docs/deploy.md](docs/deploy.md) for how to put this on Vercel with Neon.

## Tests

```
npm test
```
