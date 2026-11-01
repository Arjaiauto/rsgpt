# RSGPT (Cuepoint)

A private, unofficial research tool over the Figuring Out podcast archive, built as a demo for the Figuring Out team. It answers questions from the transcripts, with every claim traced to a timestamped source, and includes guest profiles, clips and an insights page.

Live site: https://cuepoint-two.vercel.app

> Unofficial project, not affiliated with Figuring Out. Every answer links to its source.

## Layout

| Folder      | Purpose                                                              |
|-------------|----------------------------------------------------------------------|
| `site/`     | Next.js app (the website). See `site/README.md`.                     |
| `pipeline/` | Python data pipeline that builds the database. SQL files in `pipeline/sql/`. |
| `design/`   | Page designs (`FRONTEND_DESIGN.md` wins where they disagree).         |
| `data/`     | Working data (not committed)                                         |
| `audio/`    | Downloaded audio (not committed)                                     |

Environment variables are listed in `.env.example`.

## Setup (Windows / PowerShell)

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r pipeline\requirements.txt
Copy-Item .env.example .env   # then fill in the keys
```

Run a script:

```powershell
.\.venv\Scripts\Activate.ps1
python pipeline\some_script.py
```

## Ask page to-do

- **Ticket 21: route questions that chunk search cannot answer well.** Questions about how
  Raj's opinions changed over time (for example "How has Raj's view on investing changed
  over the years?") should be answered from the verified `raj_opinion` insights, which carry
  the episode date. Questions about what Raj asks at the start of an episode should use the
  verified `raj_question` insights and the first chunks of each episode. In the search test
  (`pipeline/11_search_test.py`, `data/search_test.md`) plain hybrid search did poorly on both.
