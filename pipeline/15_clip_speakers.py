"""Who speaks in each clip: clips.guest_share for every verified clip of the final extraction run.

guest_share is the share (0 to 1) of the clip's spoken time that the speaker labels (segments.speaker) mark as the
guest, over the lines that start inside the clip. The site shows a clip on a guest's page, and counts it on their
card, only when the guest is the main speaker (guest_share of at least 0.5); clips where the host talks most of the
time are left out. A clip whose lines have no labels gets 0.

Run pipeline/sql/clip_speakers.sql in the Supabase SQL Editor first (not needed for --dry-run). Resumable: clips that
already have a value are skipped (--redo recomputes them); progress is logged per 25 episodes and network errors are
retried by db_lib. Run it again after a new extraction adds clips.

Usage:
    .venv\\Scripts\\python.exe pipeline\\15_clip_speakers.py --dry-run   compute and print, write nothing
    .venv\\Scripts\\python.exe pipeline\\15_clip_speakers.py             compute and write guest_share
"""

import argparse
import logging
import sys
from collections import defaultdict
from pathlib import Path

from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parent))
import db_lib  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
RUN_ID_PATH = ROOT / "data" / "extractions" / "haiku" / "v5" / "run_id.txt"
THRESHOLD = 0.5  # what the site uses; only reported here
PAGE = 1000
WRITE_BATCH = 500  # clips per set_clip_guest_share call

log = logging.getLogger("clip_speakers")


def flush(db, updates: list[tuple[int, float]]) -> int:
    """Writes guest_share for existing clips through the set_clip_guest_share SQL function. Never an insert or upsert:
    clips.id is an identity column. Returns the number of rows the function changed."""
    changed = 0
    for i in range(0, len(updates), WRITE_BATCH):
        batch = updates[i:i + WRITE_BATCH]
        ids, shares = [c for c, _ in batch], [s for _, s in batch]
        changed += db_lib.call("set_clip_guest_share",
                               lambda: db.rpc("set_clip_guest_share", {"ids": ids, "shares": shares}).execute(), db).data
    return changed


def pages(db, what: str, build) -> list[dict]:
    rows, start = [], 0
    while True:
        page = db_lib.call(what, lambda: build().range(start, start + PAGE - 1).execute(), db).data
        rows += page
        if len(page) < PAGE:
            return rows
        start += PAGE


def share_of(clip: dict, lines: list[dict]) -> float:
    total = guest = 0.0
    for line in lines:
        if clip["start_s"] <= line["start_s"] < clip["end_s"]:
            length = line["end_s"] - line["start_s"]
            total += length
            if line["speaker"] == "guest":
                guest += length
    return round(guest / total, 4) if total > 0 else 0.0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true", help="compute and print, write nothing")
    parser.add_argument("--redo", action="store_true", help="recompute clips that already have a value")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    load_dotenv(ROOT / ".env")
    db = db_lib.client()
    run_id = RUN_ID_PATH.read_text(encoding="utf-8").strip()

    base = lambda cols: db.table("clips").select(cols).eq("run_id", run_id).eq("verified", True).order("id")  # noqa: E731
    have_column = True
    try:
        clips = pages(db, "clips select", lambda: base("id,video_id,start_s,end_s,guest_share"))
    except Exception as exc:  # postgrest APIError 42703: the SQL has not been run
        if "guest_share" not in str(exc):
            raise
        if not args.dry_run:
            sys.exit("clips.guest_share does not exist: run pipeline/sql/clip_speakers.sql in the Supabase SQL Editor")
        have_column = False
        clips = pages(db, "clips select", lambda: base("id,video_id,start_s,end_s"))

    todo = [c for c in clips if args.redo or not have_column or c.get("guest_share") is None]
    by_video = defaultdict(list)
    for c in todo:
        by_video[c["video_id"]].append(c)
    log.info("%s verified clips, %s to compute in %s episodes", len(clips), len(todo), len(by_video))

    results: dict[int, float] = {}
    pending: list[tuple[int, float]] = []
    written = 0
    for n, (vid, group) in enumerate(sorted(by_video.items()), 1):
        lines = pages(db, "segments select", lambda: db.table("segments").select("id,start_s,end_s,speaker")
                      .eq("video_id", vid).order("id"))
        for c in group:
            results[c["id"]] = share_of(c, lines)
            pending.append((c["id"], results[c["id"]]))
        # Written as it goes, so an interrupted run keeps what it did: a clip with a value is skipped next time.
        if not args.dry_run and len(pending) >= WRITE_BATCH:
            written += flush(db, pending)
            pending = []
        if n % 25 == 0:
            log.info("%s of %s episodes done (%s clips computed, %s written)", n, len(by_video), len(results), written)
    if not args.dry_run and pending:
        written += flush(db, pending)
    if not args.dry_run:
        log.info("%s clips written with guest_share", written)

    shares = list(results.values())
    print(f"\n{'Dry run: ' if args.dry_run else ''}{len(shares)} clips computed")
    if shares:
        for th in (0.5, 0.6, 0.7, 0.8):
            print(f"  guest share >= {th}: {sum(1 for s in shares if s >= th):5} ({sum(1 for s in shares if s >= th) / len(shares):.0%})")
        left_out = sum(1 for s in shares if s < THRESHOLD)
        print(f"  left out by the site (share < {THRESHOLD}): {left_out} ({left_out / len(shares):.0%}); {sum(1 for s in shares if s == 0)} have no guest lines at all")


if __name__ == "__main__":
    main()
