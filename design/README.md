# Cuepoint design pack

Approved frontend design for the Cuepoint site (27 Oct 2026). Build the site in `site/` to match these files.

- `FRONTEND_DESIGN.md`: the spec. Decisions, data steps and rules for every page. If the spec and a mockup disagree, the spec wins.
- `01-…10-*.html`: working mockups. Open them in a browser. They are the visual and interaction reference: copy the exact colours, spacing, type, motion and behaviour. All their data is sample data.

| File | Page | Route in the real site |
| --- | --- | --- |
| 01-home-and-login.html | Public home (cloth hero, build story) + login view | `/` and `/login` |
| 02-ask.html | Ask (chat thread, reference player, Find a line) | `/ask` |
| 03-guests.html | Guest directory | `/guests` |
| 04-guest-profile.html | Guest profile | `/guests/[key]` |
| 05-prep-brief.html | Prep brief | `/prep` |
| 06-clips.html | Clip finder | `/clips` |
| 07-saved.html | Saved (clips, answers, briefs, folders, notes) | `/saved` |
| 08-insights.html | Insights story scroll | `/insights` |
| 09-future-updates.html | Future updates deck | `/future` |
| 10-global-components.html | Top bar, quick search, mini player, report popup, toasts, loading/empty/error states | shared layout |

## Fake in the mockups, real in the site

- Video: the mockups draw a fake player. The site uses one `youtube-nocookie.com/embed` iframe, plus an "Open on YouTube" button at the same second.
- Data: replace every sample guest, clip, answer and chart number with real verified rows from Supabase (`verified = true` only).
- Login: the mockup password is "demo". The site checks `SITE_PASSWORD` on the server and stores only the first name.
- The "Mockup controls" strip in 10-global-components.html is for review only. Do not build it.
- Downloads and saved items in the mockups only show toasts. The site saves to Supabase and downloads real files.

## Fixed rules

- No photos, logos or branding of Raj Shamani or Figuring Out. Guest photos come from Wikimedia Commons only, with a credit line.
- Every page shows "Unofficial project, not affiliated with Figuring Out. Every answer links to its source."
- Describe what the host or a guest said in the third person. Never speak as the host.
- Teal `#4fe3c1` is used only for timestamps and citations.
- Respect `prefers-reduced-motion` everywhere.
