# Deploying The Fetch Games (Vercel + Neon)

This app runs on **Vercel** (Next.js) with **Neon** (serverless Postgres). Local dev
uses an embedded PGlite database; production flips one env var to Neon. Nothing else
in the code changes between the two.

---

## 1. Create the database (Neon)

1. Sign up at [neon.tech](https://neon.tech) and create a **project**. Pick a region
   close to your participants (e.g. `us-east`). Keep the Vercel region (step 2) the
   same for low latency.
2. From the project dashboard, copy the **connection string** (it looks like
   `postgres://user:pass@ep-xxx.us-east-2.aws.neon.tech/neondb?sslmode=require`).
   This is your `DATABASE_URL`.

The schema is created automatically on first request — migrations live in `drizzle/`
and `ensureMigrated()` applies them idempotently. You do **not** need to run anything
by hand. (If you prefer to migrate ahead of traffic, run locally with
`DB_DRIVER=neon DATABASE_URL=... npm run db:migrate`.)

---

## 2. Deploy the app (Vercel)

1. Push this repo to GitHub, then in [vercel.com](https://vercel.com) **Add New →
   Project** and import it. Framework auto-detects as Next.js.
2. Set the **Environment Variables** below (Project → Settings → Environment
   Variables), then **Deploy**. Every later `git push` to your main branch
   auto-deploys; each branch/PR gets a preview URL.

### Environment variables (production)

| Variable | Value | Notes |
|---|---|---|
| `DB_DRIVER` | `neon` | Switches from PGlite to Neon. |
| `DATABASE_URL` | *(Neon string)* | Required when `DB_DRIVER=neon`. |
| `ADMIN_SECRET` | *(long random string)* | Gates all `/api/admin/*`. **Change from the default.** |
| `PROLIFIC_COMPLETION_CODE` | *(from Prolific)* | Sent as `?cc=` on finish. |
| `PROLIFIC_SCREENOUT_CODE` | *(from Prolific)* | Sent as `?cc=` on screen-out / decline. |
| `PROLIFIC_COMPLETE_BASE` | `https://app.prolific.com/submissions/complete` | Default is correct. |

The app **fails loud** on a missing/invalid var (see `src/lib/env.ts`), so a
misconfigured deploy errors clearly instead of running half-broken. `PGLITE_DATA_DIR`
is dev-only and ignored in production.

---

## 3. Keep-warm (optional but recommended)

Neon's free tier **autosuspends** after inactivity, adding a ~0.5 s cold start to the
first request. A health endpoint at **`/api/health`** does a cheap DB round-trip to
wake it. Two ways to ping it every ~5 minutes:

- **Vercel Cron** (needs Vercel **Pro** for sub-daily schedules): already wired in
  `vercel.json` (`*/5 * * * *` → `/api/health`). On the **Hobby** tier remove the
  `crons` block (Hobby only runs crons once/day) and use the option below.
- **Free external pinger** (any tier): point [UptimeRobot](https://uptimerobot.com)
  or [cron-job.org](https://cron-job.org) at `https://<your-app>.vercel.app/api/health`
  every 5 minutes.

Skipping keep-warm is fine — participants just occasionally wait ~0.5 s on first load.

---

## 4. Wire up Prolific

1. In your Prolific study, set the study URL to your deployed site and let Prolific
   append its identifiers:
   `https://<your-app>.vercel.app/?PROLIFIC_PID={{%PROLIFIC_PID%}}&STUDY_ID={{%STUDY_ID%}}&SESSION_ID={{%SESSION_ID%}}`
2. Set the study's **completion URL** to
   `https://app.prolific.com/submissions/complete?cc=<PROLIFIC_COMPLETION_CODE>`
   (the app also redirects there itself on finish).
3. Roles (speaker / novice / expert) are **auto-assigned** by arrival order per
   `src/config/recruitment.json` — speakers first so the utterance pool fills before
   any listener runs. Edit those counts to change the mix. You can run it as one
   combined study, or stage it: recruit the speaker batch first, then open listener
   slots.

Participants who arrive **without** Prolific params are shown a "start from Prolific"
screen in production (`requireProlificParams`).

---

## 5. The 3-vs-9 trial toggle

`src/config/study-plan.json` → **`layoutsPerTask`**: `1` = the 3-trial study, `3` =
the 9-trial (3 layouts/task) study. Change the number, commit, push — it redeploys in
~1–2 min. Runs are tagged `single`/`multi` on the session so the two never blur in
analysis.

---

## 6. Getting your data

- **Admin API** (formatted exports; from any machine):
  ```bash
  BASE=https://<your-app>.vercel.app ; KEY=<ADMIN_SECRET>
  curl -H "x-admin-key: $KEY" "$BASE/api/admin/export?table=trials&format=csv" -o trials.csv
  curl -H "x-admin-key: $KEY" "$BASE/api/admin/summary" | jq
  curl -H "x-admin-key: $KEY" "$BASE/api/admin/bonus?format=csv" -o bonus.csv
  ```
  Tables: `participants`, `sessions`, `trials`, `events`, `utterances`. Prefer the
  `x-admin-key` header over `?key=` (query strings can land in logs).
- **Neon console / psql**: raw SQL anytime via the Neon SQL Editor or
  `psql "$DATABASE_URL"`. Treat the connection string like a password.

---

## 7. Changing things after launch

- **Config** (studies, conditions, layouts, `recruitment.json`, consent text, the
  toggle) — edit JSON, push, auto-deploy. No code.
- **Code** — push, auto-deploy; preview URLs per branch; **one-click rollback** to any
  prior deployment in the Vercel dashboard.
- **Schema** — add columns via Drizzle (`npm run db:generate`), push; `ensureMigrated`
  applies them. *Additive* changes are zero-downtime; destructive ones (drop/rename)
  need care and a Neon backup/branch first.
- **Mid-study caution** — if participants are actively running, **pause recruitment on
  Prolific → deploy → resume.** Two safeguards keep old data unambiguous: every trial
  stores a full snapshot of its condition (`trials.condition`), and each session
  carries its `variant` tag.

---

## 8. Rough costs

- **Vercel**: free (Hobby) is capacity-sufficient; budget **~$20/mo Pro** if you want
  sub-daily cron and to stay clear of Hobby's non-commercial terms for funded research.
- **Neon**: free tier fits this data (well under 0.5 GB); **~$19/mo** (Launch) removes
  autosuspend and adds branching/restore.
- **Prolific dominates** — participant payments + ~33% fee are orders of magnitude
  above infra. Hosting is effectively a rounding error.

---

## Pre-launch checklist

- [ ] `DB_DRIVER=neon` and `DATABASE_URL` set in Vercel
- [ ] `ADMIN_SECRET` changed to a long random value
- [ ] `PROLIFIC_COMPLETION_CODE` / `PROLIFIC_SCREENOUT_CODE` set from Prolific
- [ ] `layoutsPerTask` set to the run you intend (1 or 3)
- [ ] `recruitment.json` counts set for your target sample
- [ ] Keep-warm configured (Vercel cron on Pro, or a free external pinger)
- [ ] Consent text in `src/config/prolific.json` reviewed with your IRB
- [ ] `/api/health` returns `{ ok: true }` on the deployed URL
- [ ] A test Prolific submission runs end-to-end and returns to Prolific
