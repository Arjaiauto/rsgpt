"""Count the home page numbers once and store them in public.site_stats (one row, id = 1).

The site reads that row (site/lib/site-stats.ts) instead of counting 1M+ transcript lines itself, which ran into
Supabase's 8 s statement limit. Run this after any pipeline change that alters these numbers:

    .venv\\Scripts\\python pipeline\\site_stats.py            count and write the row
    .venv\\Scripts\\python pipeline\\site_stats.py --dry-run  count and print only

Counts (final extraction run, verified = true where the table has it):
  episodesListed / episodesTranscribed / episodesSkipped   episodes and their status
  transcriptLines        segments of transcribed episodes (counted per 25 episodes; one count over all hits the limit)
  speakerLabelledPct     share of those lines labelled host or guest
  hindiLines             translation_segments (one per Hindi line, romanised and translated)
  extracted / verified   insights + clips + guests rows in the final run, all vs verified
  verifiedClips, verifiedHostQuestions (verified raj_question insights), guests (distinct guest_key, after the
  guest_keys merges in pipeline/corrections.json),
  passages (chunks), opportunityCategories (categories with a verified opportunity)

Safe to rerun at any time: it only counts and replaces the one row. Network errors are retried by db_lib.
"""

import argparse
import json
import logging
import sys
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
RUN_ID_PATH = ROOT / "data" / "extractions" / "haiku" / "v5" / "run_id.txt"
BATCH = 25

sys.path.insert(0, str(Path(__file__).resolve().parent))
import corrections_lib  # noqa: E402
import db_lib  # noqa: E402

log = logging.getLogger("site_stats")


def count(db, what: str, table: str, **filters) -> int:
    def run():
        q = db.table(table).select("*", count="exact", head=True)
        for key, value in filters.items():
            if key == "in_":
                q = q.in_(*value)
            else:
                q = q.eq(key, value)
        return q.execute()
    return db_lib.call(what, run, db).count


def pages(db, what: str, build) -> list[dict]:
    out, start = [], 0
    while True:
        rows = db_lib.call(what, lambda: build().range(start, start + 999).execute(), db).data
        out += rows
        start += 1000
        if len(rows) < 1000:
            return out


def compute(db, run_id: str) -> dict:
    episodes = pages(db, "episodes", lambda: db.table("episodes").select("video_id,status").order("video_id"))
    transcribed = [e["video_id"] for e in episodes if e["status"] == "transcribed"]
    log.info("episodes: %s listed, %s transcribed", len(episodes), len(transcribed))

    lines = unknown = 0
    for i in range(0, len(transcribed), BATCH):
        ids = transcribed[i:i + BATCH]
        lines += count(db, "segments", "segments", in_=("video_id", ids))
        unknown += count(db, "unknown speakers", "segments", in_=("video_id", ids), speaker="unknown")
        log.info("transcript lines: %s of %s episodes counted (%s lines so far)", min(i + BATCH, len(transcribed)),
                 len(transcribed), f"{lines:,}")

    run = {"run_id": run_id}
    verified = {"run_id": run_id, "verified": True}
    totals = {t: count(db, t, t, **run) for t in ("insights", "clips", "guests")}
    ok = {t: count(db, f"verified {t}", t, **verified) for t in ("insights", "clips", "guests")}
    host_questions = count(db, "verified host questions", "insights", **verified, type="raj_question")

    corrections = corrections_lib.load()
    keys = pages(db, "guest keys", lambda: db.table("guests").select("guest_key").eq("run_id", run_id)
                 .eq("verified", True).order("id"))
    categories = pages(db, "opportunity categories", lambda: db.table("insights").select("category")
                       .eq("run_id", run_id).eq("verified", True).eq("type", "opportunity")
                       .not_.is_("category", "null").order("id"))

    pct = lambda n, d: round(1000 * n / d) / 10 if d else 0  # noqa: E731  one decimal
    extracted, passed = sum(totals.values()), sum(ok.values())
    return {
        "episodesListed": len(episodes),
        "episodesTranscribed": len(transcribed),
        "episodesSkipped": sum(1 for e in episodes if e["status"] == "skipped"),
        "transcriptLines": lines,
        "hindiLines": count(db, "translations", "translation_segments"),
        "speakerLabelledPct": pct(lines - unknown, lines),
        "extracted": extracted,
        "verified": passed,
        "verifiedPct": pct(passed, extracted),
        "verifiedClips": ok["clips"],
        "verifiedHostQuestions": host_questions,
        # corrections.json can merge two guest_keys into one (the same person under a misheard organisation)
        "guests": len({corrections.guest_key(k["guest_key"]) for k in keys if k["guest_key"]}),
        "passages": count(db, "chunks", "chunks"),
        "opportunityCategories": len({c["category"] for c in categories}),
        "countedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true", help="count and print, don't write site_stats")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    load_dotenv(ROOT / ".env")
    db = db_lib.client()
    stats = compute(db, RUN_ID_PATH.read_text(encoding="utf-8").strip())
    print(json.dumps(stats, indent=2))
    if args.dry_run:
        log.info("dry run: site_stats not written")
        return
    db_lib.call("site_stats upsert", lambda: db.table("site_stats").upsert(
        {"id": 1, "stats": stats, "counted_at": stats["countedAt"]}).execute(), db)
    log.info("site_stats written (counted at %s)", stats["countedAt"])


if __name__ == "__main__":
    main()
