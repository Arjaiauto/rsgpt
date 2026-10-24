"""Fix romanized lines that contain non-Latin characters, in place in the segments table.

Some text_roman lines of Hindi episodes came back from Haiku with characters of
another script: whole chunks echoed back in Devanagari, or stray Telugu, Tamil,
Cyrillic and other letters (romanize_lib.non_latin). This script:

1. Finds them: Hindi episodes' segments whose text_roman has non-Latin characters,
   leaving out lines already flagged (kept in Devanagari on purpose).
2. Backs up the current text_roman of every affected row to
   data/backups/roman_fix_<timestamp>.csv before anything is sent or changed.
3. Romanizes the affected lines again by the same path as 05_captions.py: Batch API
   chunks with the non-Latin check, retries, then sub-chunks of 10; a line still
   failing keeps its Devanagari and is flagged. Stops before a batch that could
   take the cost past --max-usd.
4. Updates text_roman by segment id (UPDATE only: no row is deleted or inserted,
   so segment IDs stay the same), and the episode state files to match
   (text_roman, flagged_seqs, roman_fix_cost_usd).
5. Checks that the segments row count is unchanged and scans again.

Resumable: the list of affected rows and the backup are fixed on the first run in
data/transcripts/roman_fix/plan.json; each chunk answer is saved as it arrives,
and rows already updated are recorded, so a rerun continues where it stopped.

Usage:
    .venv\\Scripts\\python.exe pipeline\\10_roman_fix.py [--dry-run] [--max-usd 2]
"""

import argparse
import collections
import csv
import importlib.util
import json
import logging
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import anthropic
from dotenv import load_dotenv

import romanize_lib

ROOT = Path(__file__).resolve().parent.parent
FIX_DIR = ROOT / "data" / "transcripts" / "roman_fix"
PLAN_PATH = FIX_DIR / "plan.json"
CHUNK_DIR = FIX_DIR / "chunks"
JOB_PATH = FIX_DIR / "job.json"
BACKUP_DIR = ROOT / "data" / "backups"
CHUNK_LINES = 60
MAX_USD = 2.0
# Cost estimate of one request before it is sent, from the earlier romanization chunks:
# about 70 input and 50 output tokens a line, plus the system prompt.
EST_PROMPT_TOKENS, EST_IN_PER_LINE, EST_OUT_PER_LINE = 700, 70, 50
NON_ASCII = "[^\\x01-\\x7f]"  # server-side prefilter; romanize_lib.non_latin decides
PAGE = 1000
UPDATE_THREADS = 8

log = logging.getLogger("roman_fix")


class CostCapReached(Exception):
    pass


def load_module(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cap = load_module("captions", "05_captions.py")


def hindi_episodes(db) -> list[str]:
    rows = cap.db_call("episodes", lambda: db.table("episodes").select("video_id")
                       .eq("caption_language", "hi").eq("status", "transcribed").execute().data)
    return sorted(r["video_id"] for r in rows)


def load_state(vid: str) -> dict:
    return json.loads(cap.state_path(vid).read_text(encoding="utf-8"))


def find_rows(db, episodes: list[str]) -> list[dict]:
    """Segments of these episodes whose text_roman has non-Latin characters and is not a flagged line."""
    flagged = {v: set(load_state(v).get("flagged_seqs") or []) for v in episodes}
    found, last = [], 0
    while True:
        page = cap.db_call("segments scan", lambda: db.table("segments")
                           .select("id,video_id,seq,source,text_original,text_roman")
                           .filter("text_roman", "match", NON_ASCII).gt("id", last).order("id").limit(PAGE)
                           .execute().data)
        if not page:
            break
        last = page[-1]["id"]
        found += [r for r in page if r["video_id"] in flagged and r["seq"] not in flagged[r["video_id"]]
                  and romanize_lib.non_latin(r["text_roman"])]
    return found


def segment_count(db) -> int:
    return cap.db_call("segments count", lambda: db.table("segments").select("id", count="exact")
                       .limit(1).execute().count)


def scripts_of(rows: list[dict]) -> collections.Counter:
    counts = collections.Counter()
    for r in rows:
        for script in set(romanize_lib.non_latin(r["text_roman"]).values()):
            counts[script if script in ("DEVANAGARI", "TELUGU", "TAMIL") else "other"] += 1
    return counts


def new_plan(db) -> dict:
    episodes = hindi_episodes(db)
    rows = find_rows(db, episodes)
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    backup = BACKUP_DIR / f"roman_fix_{time.strftime('%Y%m%d-%H%M%S')}.csv"
    with backup.open("w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["id", "video_id", "seq", "text_original", "text_roman"])
        for r in rows:
            writer.writerow([r["id"], r["video_id"], r["seq"], r["text_original"], r["text_roman"]])
    log.info("Backed up text_roman of %s rows to %s", len(rows), backup)
    chunks: dict[str, list[int]] = {}
    by_episode = collections.defaultdict(list)
    for r in rows:
        by_episode[r["video_id"]].append(r)
    for vid, ep_rows in sorted(by_episode.items()):
        ep_rows.sort(key=lambda r: r["seq"])
        for n, i in enumerate(range(0, len(ep_rows), CHUNK_LINES)):
            chunks[f"{vid}-fix{n:03d}"] = [r["id"] for r in ep_rows[i:i + CHUNK_LINES]]
    plan = {"created_at": time.strftime("%Y-%m-%d %H:%M:%S"), "backup": str(backup.relative_to(ROOT)),
            "segments_before": segment_count(db), "rows": {str(r["id"]): r for r in rows}, "chunks": chunks,
            "results": {}, "written": [], "states_updated": False, "done": False}
    save_plan(plan)
    return plan


def save_plan(plan: dict) -> None:
    FIX_DIR.mkdir(parents=True, exist_ok=True)
    tmp = PLAN_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(plan, indent=1, ensure_ascii=False), encoding="utf-8")
    tmp.replace(PLAN_PATH)


def request_estimate(requests: dict) -> float:
    usd = 0.0
    for request in requests.values():
        lines = request["params"]["messages"][0]["content"].count('{"id"')
        usd += romanize_lib.cost_of({"input_tokens": EST_PROMPT_TOKENS + EST_IN_PER_LINE * lines,
                                     "output_tokens": EST_OUT_PER_LINE * lines})
    return usd


def chunk_paths(plan: dict) -> list[Path]:
    ids = [*plan["chunks"], *(f"{c}-s{n:02d}" for c, row_ids in plan["chunks"].items()
                              for n in range((len(row_ids) + cap.ROMAN_SUB_CHUNK_LINES - 1) // cap.ROMAN_SUB_CHUNK_LINES))]
    return [CHUNK_DIR / f"{c}.json" for c in ids]


def spent(plan: dict) -> float:
    return sum(romanize_lib.chunk_cost(p) for p in chunk_paths(plan))


def romanize(plan: dict, max_usd: float) -> bool:
    """Send the plan's chunks (then sub-chunks) and fill plan["results"]. False if not finished."""
    cap.ROMAN_CHUNK_DIR, cap.ROMAN_JOB_PATH = CHUNK_DIR, JOB_PATH
    CHUNK_DIR.mkdir(parents=True, exist_ok=True)
    rows = plan["rows"]
    titles = {vid: load_state(vid)["title"] for vid in {r["video_id"] for r in rows.values()}}
    line = lambda r: {"id": f"{r['video_id']}-L{r['seq']:05d}", "text": r["text_original"]}
    chunks = {c: [line(rows[str(i)]) for i in ids] for c, ids in plan["chunks"].items()}
    owner = {c: {"video_id": rows[str(ids[0])]["video_id"], "title": titles[rows[str(ids[0])]["video_id"]]}
             for c, ids in plan["chunks"].items()}

    def guard(requests):
        so_far, next_batch = spent(plan), request_estimate(requests)
        log.info("Cost so far $%.4f; next batch of %s requests about $%.4f (cap $%.2f)", so_far, len(requests),
                 next_batch, max_usd)
        if so_far + next_batch > max_usd:
            raise CostCapReached(f"cost ${so_far:.4f} + next batch ${next_batch:.4f} would pass ${max_usd:.2f}")

    client = anthropic.Anthropic(max_retries=cap.MAX_RETRIES + 2)
    cap.send_roman_rounds(client, {c: (lines, owner[c]) for c, lines in chunks.items()}, before_round=guard)
    subs = {c: cap.roman_sub_chunks(c, lines) for c, lines in chunks.items()}
    incomplete = [c for c in chunks if not romanize_lib.chunk_done(cap.roman_chunk_path(c))]
    if incomplete:
        log.info("%s chunks still incomplete, sent again in sub-chunks of %s lines: %s", len(incomplete),
                 cap.ROMAN_SUB_CHUNK_LINES, ", ".join(incomplete))
        cap.send_roman_rounds(client, {s: (lines, owner[c]) for c in incomplete for s, lines in subs[c].items()},
                              before_round=guard)

    for c, ids in plan["chunks"].items():
        sub_ids = list(subs[c]) if c in incomplete else []
        if any(not cap.roman_chunk_path(s).exists() for s in sub_ids):
            log.error("%s: some sub-chunks were never answered (rate limits); rerun to resend them", c)
            return False
        converted = {}
        for chunk_id in [c, *sub_ids]:
            converted |= romanize_lib.usable_lines(cap.roman_chunk_path(chunk_id))
        for i in ids:
            r = rows[str(i)]
            text, flagged = cap.roman_line(r["video_id"], r, converted.get(f"{r['video_id']}-L{r['seq']:05d}", ""))
            plan["results"][str(i)] = {"text_roman": text, "flagged": flagged}
    save_plan(plan)
    return True


def write_rows(plan: dict) -> None:
    """UPDATE text_roman by segment id, for rows not yet written."""
    written = set(plan["written"])
    todo = [i for i in plan["results"] if i not in written]
    log.info("Updating text_roman of %s rows (%s already done)", len(todo), len(written))

    local = threading.local()  # one client per thread: the HTTP/2 connection is not safe to share

    def update(i: str) -> str:
        if not hasattr(local, "db"):
            local.db = cap.supabase_client()
        text = plan["results"][i]["text_roman"]
        cap.db_call("segment update", lambda: local.db.table("segments").update({"text_roman": text})
                    .eq("id", int(i)).execute())
        return i

    with ThreadPoolExecutor(UPDATE_THREADS) as pool:
        for n, i in enumerate(pool.map(update, todo), 1):
            plan["written"].append(i)
            if n % 500 == 0:
                save_plan(plan)
                log.info("  %s/%s rows updated", n, len(todo))
    save_plan(plan)


def update_states(plan: dict) -> None:
    by_episode = collections.defaultdict(list)
    for i, result in plan["results"].items():
        by_episode[plan["rows"][i]["video_id"]].append((plan["rows"][i]["seq"], result))
    cost_by_episode = collections.Counter()
    for path in chunk_paths(plan):
        cost_by_episode[path.stem.split("-fix")[0]] += romanize_lib.chunk_cost(path)
    for vid, results in by_episode.items():
        state = load_state(vid)
        segs = {s["seq"]: s for s in state["segments"]}
        flagged = set(state.get("flagged_seqs") or [])
        for seq, result in results:
            segs[seq]["text_roman"] = result["text_roman"]
            if result["flagged"]:
                flagged.add(seq)
        state["flagged_seqs"] = sorted(flagged)
        state["roman_fix_cost_usd"] = round(cost_by_episode[vid], 6)
        cap.save_state(state)
    plan["states_updated"] = True
    save_plan(plan)
    log.info("Updated %s episode state files", len(by_episode))


def report(db, plan: dict) -> None:
    episodes = hindi_episodes(db)
    still = find_rows(db, episodes)
    count = segment_count(db)
    results = plan["results"].values()
    flagged_total = sum(len(load_state(v).get("flagged_seqs") or []) for v in episodes)
    print(f"\nRows in the plan:              {len(plan['rows']):,}")
    print(f"Lines fixed (now Roman):       {sum(not r['flagged'] for r in results):,}")
    print(f"Lines kept in Devanagari, flagged by this fix: {sum(r['flagged'] for r in results):,}")
    print(f"Lines still non-Latin and not flagged: {len(still):,} {dict(scripts_of(still)) if still else ''}")
    print(f"Flagged lines, all Hindi episodes: {flagged_total:,}")
    print(f"Cost:                          ${spent(plan):.4f}")
    print(f"Segments rows: before {plan['segments_before']:,}, after {count:,} "
          f"({'unchanged' if count == plan['segments_before'] else 'CHANGED'})")
    print(f"Backup:                        {plan['backup']}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--dry-run", action="store_true", help="find and count the rows; send and change nothing")
    parser.add_argument("--max-usd", type=float, default=MAX_USD, help="stop before the cost could pass this")
    args = parser.parse_args()
    load_dotenv(ROOT / ".env")
    cap.LOGS_DIR.mkdir(parents=True, exist_ok=True)
    log_path = cap.LOGS_DIR / f"roman_fix_{time.strftime('%Y%m%d-%H%M%S')}.log"
    log_file = log_path.open("a", encoding="utf-8")
    sys.stdout, sys.stderr = cap.Tee(sys.stdout, log_file), cap.Tee(sys.stderr, log_file)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    log.info("Console output is also written to %s", log_path)
    db = cap.supabase_client()

    if args.dry_run:
        rows = find_rows(db, hindi_episodes(db))
        per_episode = collections.Counter(r["video_id"] for r in rows)
        chunks = sum((n + CHUNK_LINES - 1) // CHUNK_LINES for n in per_episode.values())
        est = romanize_lib.cost_of({"input_tokens": EST_PROMPT_TOKENS * chunks + EST_IN_PER_LINE * len(rows),
                                    "output_tokens": EST_OUT_PER_LINE * len(rows)})
        print(f"DRY RUN: {len(rows):,} rows in {len(per_episode)} episodes, {chunks} chunks; "
              f"scripts {dict(scripts_of(rows))}; one pass about ${est:.3f} (cap ${args.max_usd:.2f})")
        if PLAN_PATH.exists():
            print(f"A plan already exists at {PLAN_PATH}; a real run continues it.")
        return

    plan = json.loads(PLAN_PATH.read_text(encoding="utf-8")) if PLAN_PATH.exists() else None
    if plan and plan["done"]:
        log.info("The plan at %s is finished; move it away to start a new fix", PLAN_PATH)
        report(db, plan)
        return
    if plan is None:
        plan = new_plan(db)
    else:
        log.info("Continuing the plan of %s (%s rows)", plan["created_at"], len(plan["rows"]))
    if len(plan["results"]) < len(plan["rows"]):
        try:
            if not romanize(plan, args.max_usd):
                sys.exit("Not finished; rerun to continue")
        except CostCapReached as exc:
            sys.exit(f"Stopped: {exc}. Nothing was written to the database; rerun with a higher --max-usd")
    write_rows(plan)
    if not plan["states_updated"]:
        update_states(plan)
    plan["done"] = True
    save_plan(plan)
    report(db, plan)


if __name__ == "__main__":
    main()
