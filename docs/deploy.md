# Deploying Fetch Games

The app runs on Vercel with a Neon database. Local runs use a small built in database
called PGlite. Production uses Neon. You flip one setting to switch, and nothing else in
the code changes.

## 1. Make the database on Neon

Sign up at [neon.tech](https://neon.tech) and make a project. Pick a region near your
players. Copy the connection string from the dashboard. It looks like
`postgres://user:pass@ep-xxx.neon.tech/neondb?sslmode=require`. That is your
`DATABASE_URL`.

The tables are created on the first request, so you do not run anything by hand. The
migrations live in the `drizzle` folder and apply themselves.

## 2. Put the app on Vercel

Push this repo to GitHub. In [vercel.com](https://vercel.com) pick Add New, then Project,
and import it. Vercel detects Next.js on its own.

Set the variables below under Project, Settings, Environment Variables. Then click Deploy.
After that, every push to your main branch deploys on its own.

| Variable | Value | Notes |
|---|---|---|
| `DB_DRIVER` | `neon` | Switches from PGlite to Neon. |
| `DATABASE_URL` | your Neon string | Needed when `DB_DRIVER` is `neon`. |
| `ADMIN_SECRET` | a long random string | Full admin access. Change it from the default. |
| `ADMIN_VIEW_SECRET` | a password you pick | Optional. View only access for teammates. |

The app stops with a clear error if a required variable is missing, so a bad setup fails
loudly instead of half working.

## 3. Keep it warm (optional)

Neon's free tier goes to sleep after a quiet spell, which adds about half a second to the
first request. The app has a health check at `/api/health` that wakes it. Point a free
pinger like [UptimeRobot](https://uptimerobot.com) or
[cron-job.org](https://cron-job.org) at `https://your-app.vercel.app/api/health` every
five minutes if you want to skip that small wait.

## 4. Sharing the study

People just open your Vercel link. The app gives each person a role on arrival. Speakers
fill first so the message pool is ready before any Listener plays, then Novices and
Experts. The counts live in `src/config/recruitment.json`. Change them to change the mix.

To stop new people from joining, stop sharing the link.

## 5. The layout toggle

`src/config/study-plan.json` has a setting called `layoutsPerTask`. Set it to `1` for one
layout per game, or `2` for two layouts per game. Change the number, push, and it
redeploys in a minute or two. Each run is tagged so the two settings never blur in the
data.

## 6. Getting your data

From any machine:

```
BASE=https://your-app.vercel.app
KEY=your-admin-secret
curl -H "x-admin-key: $KEY" "$BASE/api/admin/export?table=dataset&format=csv" -o dataset.csv
curl -H "x-admin-key: $KEY" "$BASE/api/admin/summary" | jq
```

Or open `/admin` and use the download buttons. You can also run SQL in the Neon console
anytime.

## 7. Changing things after launch

Config changes (studies, conditions, layouts, recruitment counts, consent text, the
toggle) are just JSON edits. Push and it redeploys, no code needed.

Code changes deploy on push. Vercel keeps every past deploy, so you can roll back with
one click.

Schema changes go through Drizzle. Run `npm run db:generate`, push, and the new columns
apply on the next request. Adding columns is safe. Dropping or renaming needs care and a
Neon backup first.

If people are playing right now, hold off on big changes. Wait for a quiet moment. Every
trial saves a full copy of its settings and every session carries a tag, so old and new
data never mix.

## 8. Rough costs

Vercel's free tier is enough for this. Neon's free tier fits the data with room to spare.
The real cost is paying participants, which is far larger than hosting.

## Before you launch

- `DB_DRIVER` is `neon` and `DATABASE_URL` is set on Vercel.
- `ADMIN_SECRET` is a long random value, not the default.
- `layoutsPerTask` is set to the run you want.
- `recruitment.json` counts match your target.
- Consent text in `src/config/prolific.json` is reviewed with your IRB.
- `/api/health` returns ok on the live URL.
- A full test run works end to end.
