"""Translate YouTube's Devanagari auto-captions into English with Claude Haiku, line by line.

A test of Haiku as a replacement for YouTube's automatic English translation
track, which YouTube keeps refusing with HTTP 429. For the Hindi bake-off
episodes, the YouTube automatic captions (hi-orig) for 10:00-20:00, from
data/bakeoff/<video_id>_youtube_auto_orig.json, are translated by
claude-haiku-5-5 through the Message Batches API. Each caption line keeps an ID
(<video_id>-L<index in the window>, the same IDs 06_romanize.py uses) and its
timing; the model sees and returns lines by ID, in chunks of CHUNK_LINES.

Results: data/bakeoff/<video_id>_haiku_translation.json, in the same shape as
the other bake-off results plus per-line id and source_text. Then
data/bakeoff.html is rebuilt by 04_bakeoff.py's build_html, with the column
"Haiku translation" next to "YouTube auto (English translation)".

Safe to rerun: an episode whose result file exists is skipped. Each chunk's
answer is saved to data/bakeoff/haiku_translation/<chunk id>.json as it
arrives, and the batch ID to data/bakeoff/haiku_translation_job.json, so an
interrupted run picks up the same batch; chunks that failed or came back
incomplete are sent again (up to ROUNDS batches per run).

Usage:
    .venv\\Scripts\\python.exe pipeline\\07_translate.py
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

from romanize_lib import (MODEL, TRANSLATION_EFFORT, build_request, chunk_cost, chunk_done, chunk_lines,
                          run_batch, translation_prompt)

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
BAKEOFF_DIR = DATA_DIR / "bakeoff"
CHUNK_DIR = BAKEOFF_DIR / "haiku_translation"
JOB_PATH = BAKEOFF_DIR / "haiku_translation_job.json"
CANDIDATES_CSV = DATA_DIR / "candidates.csv"

SOURCE_SERVICE = "youtube_auto_orig"
YOUTUBE_EN_SERVICE = "youtube_auto_en"
SERVICE = "haiku_translation"
CHUNK_LINES = 60
ROUNDS = 3
MAX_RETRIES = 5
# Translation needs more judgement than transliteration, so it runs one effort level up.
EFFORT = TRANSLATION_EFFORT

# Hindi bake-off episodes. Guest names are taken from the episode titles and are
# only spelling hints for the model.
EPISODES = {
    "sX6gEwH-SA4": "Khan Sir",
    "Ys4WqB6KZlU": "Lt Col Narender",
    "Nr75yJ_nXnQ": "@FlyingBeast320 (Flying Beast)",
}

SYSTEM_PROMPT = translation_prompt()

log = logging.getLogger("translate")


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
    return {f"{video_id}-t{n:02d}": lines[i:i + CHUNK_LINES]
            for n, i in enumerate(range(0, len(lines), CHUNK_LINES))}


def write_result(video_id: str, source: dict, lines: list[dict], chunk_ids: list[str]) -> dict:
    converted = {}
    for chunk_id in chunk_ids:
        converted |= chunk_lines(chunk_path(chunk_id))
    segments = [{"id": l["id"], "start": l["start"], "end": l["end"], "text": converted[l["id"]].strip(),
                 "source_text": l["text"]} for l in lines]
    result = {
        "video_id": video_id,
        "service": SERVICE,
        "model": MODEL,
        "effort": EFFORT,
        "source": f"{SOURCE_SERVICE} ({source.get('caption_lang')})",
        "audio_file": source["audio_file"],
        "offset_seconds": source["offset_seconds"],
        "duration_seconds": source["duration_seconds"],
        "cost": round(sum(chunk_cost(chunk_path(c)) for c in chunk_ids), 6),
        "currency": "USD",
        "segments": segments,
    }
    path = result_path(video_id, SERVICE)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)
    return result


def write_placeholders(bakeoff_ids: list[str]) -> None:
    """Notes for cells with nothing to show, so the page does not just say "not run"."""
    for vid in bakeoff_ids:
        if vid not in EPISODES and not result_path(vid, SERVICE).exists():
            result_path(vid, SERVICE).write_text(json.dumps(
                {"video_id": vid, "service": SERVICE, "model": MODEL, "cost": 0.0, "currency": "USD",
                 "not_applicable": "not needed (already English)", "segments": []}, indent=2), encoding="utf-8")
        if vid in EPISODES and not result_path(vid, YOUTUBE_EN_SERVICE).exists():
            # 05_captions.py writes this result if YouTube ever serves the track; it replaces this note.
            result_path(vid, YOUTUBE_EN_SERVICE).write_text(json.dumps(
                {"video_id": vid, "service": YOUTUBE_EN_SERVICE, "model": "YouTube automatic English translation",
                 "cost": 0.0, "currency": "USD", "not_applicable": "not available (YouTube answered HTTP 429)",
                 "segments": []}, indent=2), encoding="utf-8")


def load_bakeoff_module():
    spec = importlib.util.spec_from_file_location("bakeoff", Path(__file__).with_name("04_bakeoff.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    load_dotenv(ROOT / ".env")
    if not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit("ANTHROPIC_API_KEY must be set in .env")
    CHUNK_DIR.mkdir(parents=True, exist_ok=True)
    titles = read_titles()
    client = anthropic.Anthropic(max_retries=MAX_RETRIES)

    todo = {}  # video_id -> (source, lines, chunks)
    for vid in EPISODES:
        if result_path(vid, SERVICE).exists():
            log.info("%s: already translated, skipping", vid)
            continue
        if not result_path(vid, SOURCE_SERVICE).exists():
            log.error("%s: no %s result; run 05_captions.py download-auto first", vid, SOURCE_SERVICE)
            continue
        source, lines = source_lines(vid)
        todo[vid] = (source, lines, chunks_of(vid, lines))

    all_paths = [chunk_path(c) for _, _, chunks in todo.values() for c in chunks]
    spent_before = sum(chunk_cost(p) for p in all_paths)
    for round_no in range(1, ROUNDS + 1):
        requests, expected = {}, {}
        for vid, (_, _, chunks) in todo.items():
            for chunk_id, chunk in chunks.items():
                if not chunk_done(chunk_path(chunk_id)):
                    requests[chunk_id] = build_request(chunk_id, chunk, titles[vid], EPISODES[vid],
                                                       system=SYSTEM_PROMPT, effort=EFFORT)
                    expected[chunk_id] = [l["id"] for l in chunk]
        if not requests:
            break
        log.info("Round %s: %s chunks for %s episodes", round_no, len(requests), len(todo))
        run_batch(client, requests, expected, JOB_PATH, CHUNK_DIR)
    spent_now = sum(chunk_cost(p) for p in all_paths) - spent_before

    print()
    incomplete = []
    for vid, (source, lines, chunks) in todo.items():
        if not all(chunk_done(chunk_path(c)) for c in chunks):
            incomplete.append(vid)
            continue
        result = write_result(vid, source, lines, list(chunks))
        segs = result["segments"]
        print(f"{vid}: {len(segs)} lines, {sum(len(s['source_text'].split()) for s in segs):,} Hindi words -> "
              f"{sum(len(s['text'].split()) for s in segs):,} English words, USD {result['cost']:.4f}")
        empty = [s["id"] for s in segs if not s["text"]]
        if empty:
            print(f"  empty lines: {', '.join(empty)}")

    bakeoff = load_bakeoff_module()
    episodes = bakeoff.read_episodes()
    write_placeholders([ep["video_id"] for ep in episodes])
    bakeoff.build_html(episodes)

    print()
    print(f"Cost of this run ({MODEL}, effort {EFFORT}, Batch API): USD {spent_now:.4f}")
    if incomplete:
        print(f"Incomplete, rerun to send failed chunks again: {', '.join(incomplete)}")
    print(f"Page: {bakeoff.HTML_PATH}")


if __name__ == "__main__":
    main()
