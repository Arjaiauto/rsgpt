"""Load the 500 candidate episodes from data/candidates.csv into the episodes table.

Each row is upserted on video_id with title, published_at, duration and counts,
url, caption_language (default_audio_language mapped to "en" or "hi", empty if
unknown, e.g. "zxx") and in_test_set (test_set == "yes"). New rows get
status = 'listed'; rows already in the table keep their status, so a rerun
never moves an episode back to 'listed' after a later step has advanced it.

Safe to rerun: metadata is refreshed from the CSV, nothing is duplicated.
Network errors are retried. Prints the row count and test-set count at the end.

Usage:
    .venv\\Scripts\\python.exe pipeline\\load_episodes.py
"""

import csv
import logging
import os
import sys
import time
from pathlib import Path

import httpx
from dotenv import load_dotenv
from supabase import create_client

ROOT = Path(__file__).resolve().parent.parent
CANDIDATES_CSV = ROOT / "data" / "candidates.csv"
TABLE = "episodes"
BATCH_SIZE = 100
MAX_RETRIES = 5

log = logging.getLogger("load_episodes")


def caption_language(default_audio_language: str) -> str | None:
    lang = default_audio_language.strip().lower().split("-")[0]
    return lang if lang in ("en", "hi") else None


def to_row(r: dict) -> dict:
    return {
        "video_id": r["video_id"],
        "title": r["title"],
        "published_at": r["published_at"] or None,
        "duration_seconds": int(r["duration_seconds"]) if r["duration_seconds"] else None,
        "view_count": int(r["view_count"]) if r["view_count"] else None,
        "like_count": int(r["like_count"]) if r["like_count"] else None,
        "comment_count": int(r["comment_count"]) if r["comment_count"] else None,
        "url": r["url"],
        "caption_language": caption_language(r["default_audio_language"]),
        "in_test_set": r["test_set"] == "yes",
    }


def with_retries(what: str, fn):
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            return fn()
        except httpx.TransportError as exc:
            if attempt == MAX_RETRIES:
                raise
            wait = 5 * attempt
            log.warning("%s: network error (%s), retrying in %ss", what, exc, wait)
            time.sleep(wait)
    raise AssertionError("unreachable")


def existing_ids(client) -> set[str]:
    ids, start = set(), 0
    while True:
        page = with_retries("read ids", lambda: client.table(TABLE).select("video_id")
                            .order("video_id").range(start, start + 999).execute())
        ids |= {r["video_id"] for r in page.data}
        if len(page.data) < 1000:
            return ids
        start += 1000


def upsert(client, rows: list[dict], label: str) -> None:
    for i in range(0, len(rows), BATCH_SIZE):
        batch = rows[i:i + BATCH_SIZE]
        with_retries(label, lambda: client.table(TABLE).upsert(batch, on_conflict="video_id").execute())
        log.info("%s: %s/%s", label, min(i + BATCH_SIZE, len(rows)), len(rows))


def count(client, test_set_only: bool = False) -> int:
    query = client.table(TABLE).select("video_id", count="exact").limit(0)
    if test_set_only:
        query = query.eq("in_test_set", True)
    return with_retries("count", query.execute).count


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    load_dotenv(ROOT / ".env")
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        sys.exit("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in .env")

    with CANDIDATES_CSV.open(newline="", encoding="utf-8") as f:
        rows = [to_row(r) for r in csv.DictReader(f)]
    log.info("%s episodes in %s", len(rows), CANDIDATES_CSV.name)

    client = create_client(url, key)
    known = existing_ids(client)
    new = [r | {"status": "listed"} for r in rows if r["video_id"] not in known]
    old = [r for r in rows if r["video_id"] in known]
    log.info("%s new, %s already in the table (status kept)", len(new), len(old))
    upsert(client, new, "insert new")
    upsert(client, old, "refresh existing")

    langs: dict[str, int] = {}
    for r in rows:
        langs[r["caption_language"] or "(empty)"] = langs.get(r["caption_language"] or "(empty)", 0) + 1
    print()
    print("caption_language from the CSV: " + ", ".join(f"{k} {v}" for k, v in sorted(langs.items())))
    print(f"Rows in {TABLE}:  {count(client)}")
    print(f"In test set:       {count(client, test_set_only=True)}")


if __name__ == "__main__":
    main()
