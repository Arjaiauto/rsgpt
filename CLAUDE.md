# RSGPT — project rules

Follow these rules in every session.

1. **Scope and identity.** RSGPT is a private, unofficial research tool over the Figuring Out podcast archive, built as a demo for the Figuring Out team. It must never speak as Raj Shamani in the first person, never use his photos, logos or branding, and must always show "Unofficial project, not affiliated with Figuring Out."
2. **Traceability.** Every claim shown on the site must point to transcript segment IDs and timestamps. Only rows marked verified are shown. If something cannot be traced to the transcript, drop it.
3. **Guest contact data.** Limited to verified LinkedIn and YouTube channel links. Never store phone numbers or emails.
4. **Secrets.** Secrets live only in `.env`. Never print, log or commit API keys.
5. **Claude models.** Use `claude-haiku-5-5` for bulk extraction and answers, `claude-sonnet-5-5` only for test-set comparison. Use the Batch API for bulk work.
6. **Resumable scripts.** Every script must be resumable: skip work already done, log progress, retry on network errors.
7. **Windows.** This is Windows. Use PowerShell-friendly commands and `pathlib` for paths.

## Layout

- `pipeline/` — Python data scripts (deps in `pipeline/requirements.txt`, venv in `.venv`)
- `site/` — website (built later)
- `data/`, `audio/` — local working files, git-ignored
