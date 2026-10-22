"""Romanize YouTube's Devanagari auto-captions with Claude Haiku, line by line.

For the Hindi bake-off episodes, the YouTube automatic captions (hi-orig) for
10:00-20:00, as written by 05_captions.py download-auto to
data/bakeoff/<video_id>_youtube_auto_orig.json, are converted to Roman-script
Hinglish by claude-haiku-5-5 through the Message Batches API. Each caption line
gets an ID (<video_id>-L<index in the window>) and keeps its timing; the model
sees and returns lines by ID, in chunks of CHUNK_LINES.

Then each line's word count is checked in code against the original: a line
whose count differs by more than 20% is flagged. Flags go in the result file
and are highlighted on data/bakeoff.html, which is rebuilt by 04_bakeoff.py's
build_html in the column "YouTube + Haiku romanized".

Results: data/bakeoff/<video_id>_youtube_haiku_roman.json, in the same shape as
the other bake-off results plus per-line id, source_text and word counts.

Safe to rerun: an episode whose result file exists is skipped. Each chunk's
answer is saved to data/bakeoff/haiku_roman/<chunk id>.json as it arrives, and
the batch ID to data/bakeoff/haiku_roman_job.json, so an interrupted run picks
up the same batch instead of paying again; chunks that failed or came back
incomplete are sent again on the next run. Network errors are retried by the SDK.

Usage:
    .venv\\Scripts\\python.exe pipeline\\06_romanize.py
"""

import csv
import importlib.util
import json
import logging
import os
import sys
from pathlib import Path

import anthropic
from dotenv import load_dotenv

from romanize_lib import (MODEL, WORD_TOLERANCE, build_request, chunk_cost, chunk_done, chunk_lines,
                          run_batch, word_count)

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
BAKEOFF_DIR = DATA_DIR / "bakeoff"
CHUNK_DIR = BAKEOFF_DIR / "haiku_roman"
JOB_PATH = BAKEOFF_DIR / "haiku_roman_job.json"
CANDIDATES_CSV = DATA_DIR / "candidates.csv"

SOURCE_SERVICE = "youtube_auto_orig"
SERVICE = "youtube_haiku_roman"
CHUNK_LINES = 60
MAX_RETRIES = 5

# Hindi bake-off episodes. Guest names are taken from the episode titles and are
# only spelling hints for the model.
EPISODES = {
    "sX6gEwH-SA4": "Khan Sir",
    "Ys4WqB6KZlU": "Lt Col Narender",
    "Nr75yJ_nXnQ": "@FlyingBeast320 (Flying Beast)",
}

log = logging.getLogger("romanize")


def read_titles() -> dict[str, str]:
    with CANDIDATES_CSV.open(newline="", encoding="utf-8") as f:
        return {r["video_id"]: r["title"] for r in csv.DictReader(f)}


def result_path(video_id: str, service: str) -> Path:
    return BAKEOFF_DIR / f"{video_id}_{service}.json"


def chunk_path(chunk_id: str) -> Path:
    return CHUNK_DIR / f"{chunk_id}.json"


def source_lines(video_id: str) -> tuple[dict, list[dict]]:
    source = json.loads(result_path(video_id, SOURCE_SERVICE).read_text(encoding="utf-8"))
    if not source.get("caption_lang", "").startswith("hi"):
        raise RuntimeError(f"{video_id}: {SOURCE_SERVICE} is {source.get('caption_lang')}, not Hindi")
    lines = [{"id": f"{video_id}-L{i:04d}", **seg} for i, seg in enumerate(source["segments"])]
    return source, lines


def chunks_of(video_id: str, lines: list[dict]) -> dict[str, list[dict]]:
    return {f"{video_id}-c{n:02d}": lines[i:i + CHUNK_LINES]
            for n, i in enumerate(range(0, len(lines), CHUNK_LINES))}


def write_result(video_id: str, source: dict, lines: list[dict], chunk_ids: list[str]) -> dict:
    converted = {}
    for chunk_id in chunk_ids:
        converted |= chunk_lines(chunk_path(chunk_id))
    segments, flagged = [], []
    for line in lines:
        text = converted[line["id"]].strip()
        src_words, words = word_count(line["text"]), word_count(text)
        off = abs(words - src_words) > WORD_TOLERANCE * src_words
        segments.append({"id": line["id"], "start": line["start"], "end": line["end"], "text": text,
                         "source_text": line["text"], "source_words": src_words, "words": words,
                         "flagged": off})
        if off:
            flagged.append(line["id"])
    result = {
        "video_id": video_id,
        "service": SERVICE,
        "model": MODEL,
        "source": f"{SOURCE_SERVICE} ({source.get('caption_lang')})",
        "audio_file": source["audio_file"],
        "offset_seconds": source["offset_seconds"],
        "duration_seconds": source["duration_seconds"],
        "cost": round(sum(chunk_cost(chunk_path(c)) for c in chunk_ids), 6),
        "currency": "USD",
        "word_tolerance": WORD_TOLERANCE,
        "flagged_ids": flagged,
        "segments": segments,
    }
    path = result_path(video_id, SERVICE)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)
    return result


def write_placeholders(titles_in_bakeoff: list[str]) -> None:
    """The page shows this column for every bake-off episode; the English ones get a note."""
    for vid in titles_in_bakeoff:
        if vid in EPISODES or result_path(vid, SERVICE).exists():
            continue
        result_path(vid, SERVICE).write_text(json.dumps(
            {"video_id": vid, "service": SERVICE, "model": MODEL, "cost": 0.0, "currency": "USD",
             "not_applicable": "not run (captions not in Devanagari)", "segments": []}, indent=2), encoding="utf-8")


def load_bakeoff_module():
    spec = importlib.util.spec_from_file_location("bakeoff", Path(__file__).with_name("04_bakeoff.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    load_dotenv(ROOT / ".env")
    if not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit("ANTHROPIC_API_KEY must be set in .env")
    CHUNK_DIR.mkdir(parents=True, exist_ok=True)
    titles = read_titles()
    client = anthropic.Anthropic(max_retries=MAX_RETRIES)

    todo = {}  # video_id -> (source, lines, chunks)
    for vid in EPISODES:
        if result_path(vid, SERVICE).exists():
            log.info("%s: already romanized, skipping", vid)
            continue
        if not result_path(vid, SOURCE_SERVICE).exists():
            log.error("%s: no %s result; run 05_captions.py download-auto first", vid, SOURCE_SERVICE)
            continue
        source, lines = source_lines(vid)
        todo[vid] = (source, lines, chunks_of(vid, lines))

    spent_before = sum(chunk_cost(chunk_path(c)) for _, _, chunks in todo.values() for c in chunks)
    requests, expected = {}, {}
    for vid, (_, _, chunks) in todo.items():
        for chunk_id, chunk in chunks.items():
            if not chunk_done(chunk_path(chunk_id)):
                requests[chunk_id] = build_request(chunk_id, chunk, titles[vid], EPISODES[vid])
                expected[chunk_id] = [l["id"] for l in chunk]
    if requests:
        log.info("%s chunks to send for %s episodes", len(requests), len(todo))
        run_batch(client, requests, expected, JOB_PATH, CHUNK_DIR)
    spent_now = sum(chunk_cost(chunk_path(c)) for _, _, chunks in todo.values() for c in chunks) - spent_before

    print()
    print(f"Word-count check: a line is flagged when its word count is more than "
          f"{WORD_TOLERANCE:.0%} away from the Devanagari original.")
    incomplete = []
    for vid, (source, lines, chunks) in todo.items():
        if not all(chunk_done(chunk_path(c)) for c in chunks):
            incomplete.append(vid)
            continue
        result = write_result(vid, source, lines, list(chunks))
        segs = result["segments"]
        print(f"\n{vid}: {len(segs)} lines, {sum(s['source_words'] for s in segs):,} -> "
              f"{sum(s['words'] for s in segs):,} words, {len(result['flagged_ids'])} flagged, "
              f"USD {result['cost']:.4f}")
        for s in segs:
            if s["flagged"]:
                print(f"  {s['id']} {s['start']:.2f}s  {s['source_words']} -> {s['words']} words")
                print(f"      {s['source_text']}")
                print(f"      {s['text']}")

    bakeoff = load_bakeoff_module()
    episodes = bakeoff.read_episodes()
    write_placeholders([ep["video_id"] for ep in episodes])
    bakeoff.build_html(episodes)

    print()
    print(f"Cost of this run ({MODEL}, Batch API): USD {spent_now:.4f}")
    if incomplete:
        print(f"Incomplete, rerun to send failed chunks again: {', '.join(incomplete)}")
    print(f"Page: {bakeoff.HTML_PATH}")


if __name__ == "__main__":
    main()
