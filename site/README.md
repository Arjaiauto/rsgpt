# Cuepoint site

Unofficial project, not affiliated with Figuring Out. Every answer links to its source.

A private research site over the Figuring Out podcast archive. Each answer, quote and clip is traced to verified transcript segments with timestamps, and only verified rows are shown. It is a demo for the Figuring Out team.

## Pages

- **Ask**: questions answered from the transcripts, with links to the exact moment.
- **Prep**: a briefing for an upcoming guest, built from past episodes and web research.
- **Guests**: the guest directory and each guest's profile.
- **Clips**: searchable short clips, plus **Reels** (full-screen vertical feed; `?start=<clip id>` opens at one clip).
- **Saved**: items the signed-in person has saved, with folders.
- **Insights**: charts over the archive.
- **Future updates**: a deck page (`components/future/FutureDeck.tsx`).

Login is one shared password; the signed-in person's first name is kept in a signed cookie.

## Tech stack

- Next.js 16 (App Router, TypeScript), React 19, Node 24.
- Supabase (Postgres) through the service-role client, server side only.
- Anthropic and Voyage AI for answers and search; Groq and Tavily for Prep web research.
- Rate limits are kept in the `rate_limits` table (the function `take_rate_limit`).
- Pipeline (not in this folder): Python scripts in `../pipeline/` that build the database.

## Environment variables

All variables and their Vercel settings are in `../.env.example` (the site reads the root `.env`; `site/.env.example` lists the same names). Copy it to `../.env` and fill it in. Never commit `.env`.

## Deploying

- Vercel project: Root Directory `site`, framework Next.js, default build (`npm ci`, `next build`).
- Push to `main` = production deploy (https://cuepoint-two.vercel.app).
- Push a branch = Vercel preview deploy. Open the branch's deployment from the Vercel dashboard.
- AI keys are set for Production only, so previews cannot spend API credit. Login and data variables are set for Production and Preview.

## Working on this machine

- **Never run `next build` or `next start` locally.** Local builds exhaust the RAM on this PC. Let Vercel build.
- Before pushing, check with `npx tsc --noEmit` and `npm run lint` (from `site/`).
- `npm run dev` runs the dev server at http://localhost:3000 for quick checks.
- SQL files live in `../pipeline/sql/`. Run them in the Supabase SQL Editor; `rate_limits.sql` creates the rate-limit table and function.

## Code map

- `app/globals.css`: design tokens (colours, fonts, radii, easing).
- `proxy.ts`: every route except `/`, `/login`, static files and `/robots.txt` needs the session cookie.
- `app/login/actions.ts`: password check, session cookie, login rate limit (10 tries per IP per 15 minutes, in the database).
- `lib/rate-limit.ts`: the rate limiter. It falls back to a per-process window only if the database call fails.
