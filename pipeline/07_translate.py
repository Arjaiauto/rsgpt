"""Translate YouTube's Devanagari auto-captions into English with Claude Haiku, line by line.

A test of Haiku as a replacement for YouTube's automatic English translation
track, which YouTube keeps refusing with HTTP 429. For the Hindi bake-off
episodes, the YouTube automatic captions (hi-orig) for 10:00-20:00, from
data/bakeoff/<video_id>_youtube_auto_orig.json, are translated by
claude-haiku-5-5 through the Message Batches API. Each caption line keeps an ID
(<video_id>-L<index in the window>, the same IDs 06_romanize.py uses) and its
timing. Translation runs through romanize_lib.translate_episodes: at most 40
lines per request with a JSON schema allowing exactly their IDs, retries and
halving for answers with missing, extra or duplicated IDs, and a length check
whose flagged lines are translated again one at a time.

Results: data/bakeoff/<video_id>_haiku_translation.json, in the same shape as
the other bake-off results plus per-line id and source_text. Then
data/bakeoff.html is rebuilt by 04_bakeoff.py's build_html, with the column
"Haiku translation" next to "YouTube auto (English translation)".

Safe to rerun: an episode whose result file exists is skipped. Each answer
is saved to data/bakeoff/haiku_translation_units/<unit id>.json as it arrives,
and the batch ID to data/bakeoff/haiku_translation_units_job.json, so an
interrupted run picks up where it stopped.

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

from romanize_lib import MODEL, TRANSLATION_EFFORT, chunk_cost, translate_episodes

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
BAKEOFF_DIR = DATA_DIR / "bakeoff"
UNIT_DIR = BAKEOFF_DIR / "haiku_translation_units"
JOB_PATH = BAKEOFF_DIR / "haiku_translation_units_job.json"
CANDIDATES_CSV = DATA_DIR / "candidates.csv"

SOURCE_SERVICE = "youtube_auto_orig"
YOUTUBE_EN_SERVICE = "youtube_auto_en"
SERVICE = "haiku_translation"
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

log = logging.getLogger("translate")


def read_titles() -> dict[str, str]:
    with CANDIDATES_CSV.open(newline="", encoding="utf-8") as f:
        return {r["video_id"]: r["title"] for r in csv.DictReader(f)}


def result_path(video_id: str, service: str) -> Path:
    return BAKEOFF_DIR / f"{video_id}_{service}.json"


def source_lines(video_id: str) -> tuple[dict, list[dict]]:
    source = json.loads(result_path(video_id, SOURCE_SERVICE).read_text(encoding="utf-8"))
    if not source.get("caption_lang", "").startswith("hi"):
        raise RuntimeError(f"{video_id}: {SOURCE_SERVICE} is {source.get('caption_lang')}, not Hindi")
    lines = [{"id": f"{video_id}-L{i:04d}", **seg} for i, seg in enumerate(source["segments"])]
    return source, lines


def write_result(video_id: str, source: dict, lines: list[dict], translated: dict) -> dict:
    segments = [{"id": l["id"], "start": l["start"], "end": l["end"], "text": translated["lines"][l["id"]],
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
        "cost": round(translated["cost"], 6),
        "currency": "USD",
        "length_flagged": translated["flagged"],
        "length_fixed": translated["fixed"],
        "length_still_flagged": translated["still_flagged"],
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
    titles = read_titles()
    client = anthropic.Anthropic(max_retries=MAX_RETRIES)

    todo = {}  # video_id -> (source, lines)
    for vid in EPISODES:
        if result_path(vid, SERVICE).exists():
            log.info("%s: already translated, skipping", vid)
            continue
        if not result_path(vid, SOURCE_SERVICE).exists():
            log.error("%s: no %s result; run 05_captions.py download-auto first", vid, SOURCE_SERVICE)
            continue
        todo[vid] = source_lines(vid)

    spent_before = sum(chunk_cost(p) for p in UNIT_DIR.glob("*.json"))
    results = translate_episodes(
        client, [{"key": vid, "title": titles[vid], "guest": EPISODES[vid], "roman": False,
                  "lines": [{"id": l["id"], "text": l["text"]} for l in lines]} for vid, (_, lines) in todo.items()],
        UNIT_DIR, JOB_PATH) if todo else {}
    spent_now = sum(chunk_cost(p) for p in UNIT_DIR.glob("*.json")) - spent_before

    print()
    incomplete = []
    for vid, (source, lines) in todo.items():
        translated = results[vid]
        if not translated["complete"]:
            incomplete.append(vid)
            continue
        result = write_result(vid, source, lines, translated)
        segs = result["segments"]
        print(f"{vid}: {len(segs)} lines, {sum(len(s['source_text'].split()) for s in segs):,} Hindi words -> "
              f"{sum(len(s['text'].split()) for s in segs):,} English words; length check flagged "
              f"{len(translated['flagged'])}, {len(translated['fixed'])} fixed; USD {result['cost']:.4f}")

    bakeoff = load_bakeoff_module()
    episodes = bakeoff.read_episodes()
    write_placeholders([ep["video_id"] for ep in episodes])
    bakeoff.build_html(episodes)

    print()
    print(f"Cost of this run ({MODEL}, effort {EFFORT}, Batch API): USD {spent_now:.4f}")
    if incomplete:
        print(f"Incomplete, rerun to try the missing lines again: {', '.join(incomplete)}")
    print(f"Page: {bakeoff.HTML_PATH}")


if __name__ == "__main__":
    main()
