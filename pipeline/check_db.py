"""Check that the Supabase database has every table from schema.sql.

Connects with SUPABASE_URL and SUPABASE_SERVICE_KEY from .env and, for each
table, asks for zero rows of its expected columns. That confirms the table
exists and has those columns (including chunks.embedding, which only exists
if the vector extension is on) without reading or changing any data. Prints
one line per table and exits with status 1 if anything is missing.

Read-only, so safe to rerun at any time. Network errors are retried.

Usage:
    .venv\\Scripts\\python.exe pipeline\\check_db.py
"""

import logging
import os
import sys
import time
from pathlib import Path

import httpx
from dotenv import load_dotenv
from postgrest.exceptions import APIError
from supabase import create_client

ROOT = Path(__file__).resolve().parent.parent
MAX_RETRIES = 3

# Must match schema.sql.
TABLES = {
    "episodes": ["video_id", "title", "published_at", "duration_seconds", "view_count", "like_count",
                 "comment_count", "url", "caption_language", "in_test_set", "status"],
    "segments": ["id", "video_id", "seq", "start_s", "end_s", "speaker", "text_original", "text_roman", "source"],
    "translation_segments": ["id", "video_id", "start_s", "end_s", "text"],
    "chunks": ["id", "video_id", "start_s", "end_s", "text", "published_at", "embedding", "text_search"],
    "guests": ["id", "name", "organisation", "role_at_episode", "sector_tags", "bio", "linkedin_url",
               "linkedin_verified", "youtube_channel_url", "video_id", "model", "run_id", "verified", "check_notes"],
    "insights": ["id", "video_id", "guest_id", "type", "category", "text", "start_s", "end_s",
                 "source_segment_ids", "translated", "verified", "check_notes", "model", "run_id"],
    "clips": ["id", "video_id", "start_s", "end_s", "opening_line", "topic", "score", "verified", "model", "run_id",
              "check_notes"],
    "reviews": ["id", "item_table", "item_id", "verdict", "note", "created_at"],
    "feedback": ["id", "page", "item_id", "note", "visitor_id", "created_at"],
    "qa_log": ["id", "question", "answer", "cited_chunk_ids", "visitor_id", "created_at"],
}

log = logging.getLogger("check_db")


def check_table(client, table: str, columns: list[str]) -> str | None:
    """Returns None if the table and columns are there, otherwise the problem."""
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            client.table(table).select(",".join(columns)).limit(0).execute()
            return None
        except APIError as exc:
            return f"{exc.code}: {exc.message}"
        except httpx.TransportError as exc:
            if attempt == MAX_RETRIES:
                return f"network error: {exc}"
            wait = 5 * attempt
            log.warning("%s: network error (%s), retrying in %ss", table, exc, wait)
            time.sleep(wait)
    raise AssertionError("unreachable")


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    load_dotenv(ROOT / ".env")
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        sys.exit("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in .env")

    client = create_client(url, key)
    problems = {}
    for table, columns in TABLES.items():
        problem = check_table(client, table, columns)
        print(f"  {'OK     ' if problem is None else 'MISSING'} {table}" + (f"  ({problem})" if problem else ""))
        if problem:
            problems[table] = problem

    print()
    if problems:
        print(f"{len(problems)} of {len(TABLES)} tables missing or incomplete; run pipeline/schema.sql in Supabase.")
        sys.exit(1)
    print(f"All {len(TABLES)} tables exist with the expected columns.")


if __name__ == "__main__":
    main()
