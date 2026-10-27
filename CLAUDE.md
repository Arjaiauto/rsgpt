# RSGPT — project rules

Follow these rules in every session.

1. **Scope and identity.** RSGPT is a private, unofficial research tool over the Figuring Out podcast archive, built as a demo for the Figuring Out team. It must never speak as Raj Shamani in the first person, never use his photos, logos or branding, and must always show "Unofficial project, not affiliated with Figuring Out. Every answer links to its source."
2. **Traceability.** Every claim shown on the site must point to transcript segment IDs and timestamps. Only rows marked verified are shown. If something cannot be traced to the transcript, drop it.
3. **Guest contact data.** Guest contact data is limited to LinkedIn, YouTube channel and Wikipedia links. A link is shown only when it is verified, either checked by hand (link_source = 'manual') or matched automatically under strict rules (link_source = 'auto'); the site labels auto links as 'Matched automatically'. LinkedIn is never scraped: without a hand-checked profile, show only a 'Search on LinkedIn' button. Never store phone numbers or emails.
4. **Secrets.** Secrets live only in `.env`. Never print, log or commit API keys.
5. **Claude models.** Use `claude-haiku-5-5` for bulk extraction and answers, `claude-sonnet-5-5` only for test-set comparison. Use the Batch API for bulk work.
6. **Resumable scripts.** Every script must be resumable: skip work already done, log progress, retry on network errors.
7. **Windows.** This is Windows. Use PowerShell-friendly commands and `pathlib` for paths.
8. Frontend: build site/ to match design/FRONTEND_DESIGN.md and the mockups in design/. If they disagree, FRONTEND_DESIGN.md wins. Mockup data is sample data; the site uses only verified Supabase rows.
9. Numbers shown on the site always come from verified rows in the database, never from hard-coded figures in the spec.

## Layout

- `pipeline/` — Python data scripts (deps in `pipeline/requirements.txt`, venv in `.venv`)
- `site/` — website (built later)
- `data/`, `audio/` — local working files, git-ignored
