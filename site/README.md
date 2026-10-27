# Cuepoint site

Next.js (App Router, TypeScript). Built to match `../design/FRONTEND_DESIGN.md` and the mockups in `../design/`.

Secrets are read from the project's single `../.env` (see `../.env.example`): `SITE_PASSWORD` is the shared login password and `SESSION_SECRET` signs the session cookie. Nothing from `.env` is sent to the browser.

```powershell
cd site
npm install
npm run dev      # http://localhost:3000
npm run build; npm run start   # production build
```

## Vercel

Root Directory `site`, framework Next.js, default build (`npm ci`, `next build`), Node 24 (`engines` in `package.json`). There is no `.env` on Vercel; set these in the project's Environment Variables (all server-only, none `NEXT_PUBLIC_`): `SITE_PASSWORD`, `SESSION_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`.

- `app/globals.css`: all design tokens (colours, fonts, radii, easing).
- `proxy.ts`: every route except `/`, `/login`, static files and `/robots.txt` needs the session cookie.
- `app/login/actions.ts`: password check, cookies, rate limit (10 tries per IP per 10 minutes, in memory).
