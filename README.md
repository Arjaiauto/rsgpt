# RSGPT

A private, unofficial research tool over the Figuring Out podcast archive, built as a demo for the Figuring Out team.

> Unofficial project, not affiliated with Figuring Out.

## Layout

| Folder      | Purpose                                   |
|-------------|-------------------------------------------|
| `pipeline/` | Python data scripts                       |
| `site/`     | Website (built later)                     |
| `data/`     | Working data (not committed)              |
| `audio/`    | Downloaded audio (not committed)          |

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
