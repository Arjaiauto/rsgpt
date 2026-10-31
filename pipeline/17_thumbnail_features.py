"""What each episode's YouTube thumbnail contains, for the Thumbnails section of /insights (Ticket 23e).

For every transcribed episode the thumbnail (maxres, else hq) is downloaded into data/thumbnails/tmp, measured, and
deleted again; no image is kept or shown anywhere (CLAUDE.md rule 1). Measured locally with OpenCV:
  - faces: count and the largest face's share of the frame (YuNet face detector), close-up vs wide framing
  - the top 3 colours (k-means), brightness (mean CIELAB lightness) and contrast (spread of grey levels)
Measured with Claude Haiku vision (strict JSON), because no local OCR here reads stylised Hindi and English
thumbnail text reliably (Tesseract is not installed and needs a system installer; EasyOCR needs PyTorch):
  - the words on the thumbnail, line by line, and their languages; word count, number and question mark from them
Who is in the picture (host or guest) is not measured: there are reference photos for only some guests, none of the
host are used, and there is no face-recognition model here. Faces are only counted.

Results go to data/thumbnails/features.jsonl first (one line per episode), then into public.thumbnail_features with
--load (run pipeline/sql/thumbnail_features.sql in the Supabase SQL Editor before that). Resumable: episodes already in
features.jsonl with this MODEL_VERSION are skipped, a submitted Haiku batch is remembered in batch_state.json and
collected on the next run, downloads and database calls are retried. Haiku runs through the Batch API (rule 5).

Usage:
    .venv\\Scripts\\python.exe pipeline\\17_thumbnail_features.py --dry-run          episodes to do, estimated cost
    .venv\\Scripts\\python.exe pipeline\\17_thumbnail_features.py --limit 20         analyse 20 (spread over the dates)
    .venv\\Scripts\\python.exe pipeline\\17_thumbnail_features.py                    analyse every episode left
    .venv\\Scripts\\python.exe pipeline\\17_thumbnail_features.py --sample 20        print features next to titles
    .venv\\Scripts\\python.exe pipeline\\17_thumbnail_features.py --load             upsert features into the table
"""

import argparse
import base64
import json
import logging
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import anthropic
import cv2
import numpy as np
import requests
from anthropic.types.message_create_params import MessageCreateParamsNonStreaming
from anthropic.types.messages.batch_create_params import Request
from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parent))
import db_lib  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "data" / "thumbnails"
TMP_DIR = OUT_DIR / "tmp" / str(os.getpid())  # one folder per run, so two runs never touch each other's files
FEATURES_PATH = OUT_DIR / "features.jsonl"
BATCH_STATE_PATH = OUT_DIR / "batch_state.json"
PROGRESS_LOG = OUT_DIR / "progress.log"
FACE_MODEL = ROOT / "data" / "models" / "face_detection_yunet_2023mar.onnx"
FACE_MODEL_URL = "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx"

MODEL = "claude-haiku-5-5"
MODEL_VERSION = "thumbs-v1: yunet-2023mar + claude-haiku-5-5 text"
# Batch API prices, USD per million tokens (input, output), as in 06_extract.py (half the standard $0.10 / $0.50).
BATCH_PRICE = (0.05, 0.25)
# Estimate for --dry-run until a run has measured it: a 768x432 image (~440 tokens) + the prompt, and a short answer.
EST_TOKENS = (620, 60)

FACE_SCORE = 0.75
FACE_MIN_HEIGHT = 0.04   # a face box under 4% of the frame height is background, not a face on the thumbnail
CLOSE_UP_AREA = 0.12     # close-up: the largest face box covers at least 12% of the frame (two-shots sit near 9-12%)
HAIKU_WIDTH = 768
ATTEMPTS = 4
POLL_SECONDS = 20
PAGE = 1000

PROMPT = (
    "This is a YouTube video thumbnail. List every piece of text printed on it, one entry per line of text, exactly "
    "as written: keep Hindi in Devanagari and English as is, and keep numbers, currency signs and punctuation such as "
    "? and !. Leave out text that is part of a small logo or channel watermark, and text on clothing or on objects in "
    "the background. If there is no text, return an empty list. In languages, list the languages of that text: en for "
    "English (also English written in Roman letters), hi for Hindi in Devanagari, other for anything else."
)
SCHEMA = {
    "type": "object",
    "properties": {
        "lines": {"type": "array", "items": {"type": "string"}},
        "languages": {"type": "array", "items": {"type": "string", "enum": ["en", "hi", "other"]}},
    },
    "required": ["lines", "languages"],
    "additionalProperties": False,
}

log = logging.getLogger("thumbnails")


# ---------- episodes and the local cache ----------

def episodes(db) -> list[dict]:
    rows, start = [], 0
    while True:
        page = db_lib.call("episodes", lambda: db.table("episodes").select("video_id,title,published_at")
                           .eq("status", "transcribed").order("video_id").range(start, start + PAGE - 1).execute(), db).data
        rows += page
        if len(page) < PAGE:
            return sorted(rows, key=lambda r: r["published_at"] or "")
        start += PAGE


def read_cache() -> dict[str, dict]:
    done = {}
    if FEATURES_PATH.exists():
        for line in FEATURES_PATH.read_text(encoding="utf-8").splitlines():
            if line.strip():
                row = json.loads(line)
                if row["model_version"] == MODEL_VERSION:
                    done[row["episode_id"]] = {**row, "features": derive(row["features"])}
    return done


def append_cache(rows: list[dict]) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with FEATURES_PATH.open("a", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")


def progress(msg: str) -> None:
    log.info(msg)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    with PROGRESS_LOG.open("a", encoding="utf-8") as f:
        f.write(f"{datetime.now().isoformat(timespec='seconds')} {msg}\n")


def spread(items: list, n: int) -> list:
    """n items evenly spaced over the list (all of them when n is at least its length)."""
    if n >= len(items):
        return items
    if n == 1:
        return items[:1]
    return [items[round(i * (len(items) - 1) / (n - 1))] for i in range(n)]


# ---------- download ----------

def download(video_id: str) -> tuple[bytes, str]:
    """The maxres thumbnail, or hq when there is none (YouTube then answers 404 or a 120x90 placeholder)."""
    for size, name in (("maxres", "maxresdefault.jpg"), ("hq", "hqdefault.jpg")):
        url = f"https://i.ytimg.com/vi/{video_id}/{name}"
        for attempt in range(1, ATTEMPTS + 1):
            try:
                r = requests.get(url, timeout=20)
                break
            except requests.RequestException as exc:
                if attempt == ATTEMPTS:
                    raise
                log.warning("download %s: %s, retrying", video_id, exc)
                time.sleep(3 * attempt)
        if r.status_code == 200 and len(r.content) > 2000:
            return r.content, size
    raise RuntimeError(f"no thumbnail for {video_id}")


def read_image(video_id: str) -> tuple[np.ndarray, str]:
    """Downloads into the temp folder, reads it and deletes the file again."""
    data, size = download(video_id)
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    path = TMP_DIR / f"{video_id}.jpg"
    try:
        path.write_bytes(data)
        img = cv2.imdecode(np.fromfile(str(path), dtype=np.uint8), cv2.IMREAD_COLOR)
    finally:
        path.unlink(missing_ok=True)
    if img is None:
        raise RuntimeError(f"could not read the thumbnail of {video_id}")
    h, w = img.shape[:2]
    if abs(h / w - 0.75) < 0.01:  # hq is 4:3 with black bars around the 16:9 picture
        bar = round((h - w * 9 / 16) / 2)
        img = img[bar:h - bar]
    return img, size


# ---------- local features ----------

_detector = None


def detector(w: int, h: int):
    global _detector
    if not FACE_MODEL.exists():
        FACE_MODEL.parent.mkdir(parents=True, exist_ok=True)
        FACE_MODEL.write_bytes(requests.get(FACE_MODEL_URL, timeout=60).content)
    if _detector is None:
        _detector = cv2.FaceDetectorYN.create(str(FACE_MODEL), "", (w, h), FACE_SCORE, 0.3, 50)
    _detector.setInputSize((w, h))
    return _detector


def local_features(img: np.ndarray, size: str) -> dict:
    h, w = img.shape[:2]
    _, found = detector(w, h).detect(img)
    boxes = [] if found is None else [(float(f[2]), float(f[3])) for f in found if f[3] >= FACE_MIN_HEIGHT * h]
    largest = max(boxes, key=lambda b: b[0] * b[1], default=None)
    framing = "none" if not largest else ("close-up" if largest[0] * largest[1] >= CLOSE_UP_AREA * w * h else "wide")

    small = cv2.resize(img, (160, 90), interpolation=cv2.INTER_AREA)
    pixels = cv2.cvtColor(small, cv2.COLOR_BGR2RGB).reshape(-1, 3).astype(np.float32)
    cv2.setRNGSeed(17)
    _, labels, centres = cv2.kmeans(pixels, 5, None, (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 0.5), 3,
                                    cv2.KMEANS_PP_CENTERS)
    counts = np.bincount(labels.ravel(), minlength=5)
    order = np.argsort(-counts)[:3]
    colours = [{"hex": "#%02x%02x%02x" % tuple(int(round(c)) for c in centres[i]), "share": round(float(counts[i] / counts.sum()), 3)}
               for i in order]
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
    grey = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    return {
        "source": size, "width": int(w), "height": int(h),
        "faces": len(boxes),
        "largest_face": round(largest[0] * largest[1] / (w * h), 4) if largest else 0.0,
        "framing": framing,
        "colours": colours,
        "brightness": round(float(lab[:, :, 0].mean()) * 100 / 255, 1),
        "contrast": round(float(grey.std()), 1),
    }


def haiku_image(img: np.ndarray) -> str:
    h, w = img.shape[:2]
    small = cv2.resize(img, (HAIKU_WIDTH, round(h * HAIKU_WIDTH / w)), interpolation=cv2.INTER_AREA) if w > HAIKU_WIDTH else img
    ok, buf = cv2.imencode(".jpg", small, [cv2.IMWRITE_JPEG_QUALITY, 85])
    if not ok:
        raise RuntimeError("could not encode the image")
    return base64.standard_b64encode(buf.tobytes()).decode("ascii")


# ---------- text (Haiku) ----------

WORD = re.compile(r"[\wऀ-ॿ]", re.UNICODE)


# Text the channel puts on every thumbnail, which says nothing about the headline: the show's logo and the view-count
# badge ("600K+ VIEWS") added once an episode has views. The badge must never count as a feature, or "has a number"
# would measure the views themselves.
BADGE = re.compile(r"^[\d.,]+\s*[KMB]?\+?\s*VIEWS?$", re.IGNORECASE)
LOGO = re.compile(r"^(FIGURING OUT|WITH RAJ SHAMANI|FIGURING OUT WITH RAJ SHAMANI)$", re.IGNORECASE)


def text_features(answer: dict) -> dict:
    raw = [s.strip() for s in answer.get("lines", []) if s and s.strip()]
    return derive({"text_raw": raw, "text_langs_raw": sorted(set(answer.get("languages", [])))})


def derive(f: dict) -> dict:
    """The text fields, from Haiku's raw lines (text_raw), and the framing from the face measurements. Run on every
    cache read, so a change to these rules applies without asking Haiku again."""
    raw = f.get("text_raw", f.get("text", []))
    lines = [s for s in raw if not BADGE.match(s) and not LOGO.match(s)]
    words = [w for line in lines for w in line.split() if WORD.search(w)]
    joined = " ".join(lines)
    langs = f.get("text_langs_raw", f.get("text_langs", []))
    return {
        **f,
        "text_raw": raw,
        "text_langs_raw": langs,
        "text": lines,
        "views_badge": any(BADGE.match(s) for s in raw),
        "show_logo": any(LOGO.match(s) for s in raw),
        "text_present": bool(words),
        "word_count": len(words),
        "has_number": bool(re.search(r"[0-9०-९]", joined)),
        "has_question": "?" in joined,
        "text_langs": langs if words else [],
        "framing": "none" if not f.get("faces") else ("close-up" if f.get("largest_face", 0) >= CLOSE_UP_AREA else "wide"),
    }


def request_for(video_id: str, image_b64: str) -> Request:
    return Request(custom_id=video_id, params=MessageCreateParamsNonStreaming(
        model=MODEL,
        max_tokens=1024,
        thinking={"type": "disabled"},
        output_config={"effort": "low", "format": {"type": "json_schema", "schema": SCHEMA}},
        messages=[{"role": "user", "content": [
            {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": image_b64}},
            {"type": "text", "text": PROMPT},
        ]}],
    ))


def cost(usage: dict) -> float:
    return (usage["input_tokens"] * BATCH_PRICE[0] + usage["output_tokens"] * BATCH_PRICE[1]) / 1e6


def collect(client, state: dict) -> None:
    """Waits for the batch in state, merges the text into the local features and appends them to the cache.
    Episodes whose request failed are left out, so the next run does them again."""
    batch_id = state["batch_id"]
    while True:
        batch = client.messages.batches.retrieve(batch_id)
        if batch.processing_status == "ended":
            break
        c = batch.request_counts
        progress(f"batch {batch_id}: {c.succeeded} done, {c.processing} processing, {c.errored} errored")
        time.sleep(POLL_SECONDS)
    rows, usage, failed = [], {"input_tokens": 0, "output_tokens": 0}, []
    now = datetime.now(timezone.utc).isoformat()
    for res in client.messages.batches.results(batch_id):
        vid = res.custom_id
        if res.result.type != "succeeded":
            failed.append(f"{vid} ({res.result.type})")
            continue
        msg = res.result.message
        usage["input_tokens"] += msg.usage.input_tokens
        usage["output_tokens"] += msg.usage.output_tokens
        text = next((b.text for b in msg.content if b.type == "text"), "")
        if msg.stop_reason != "end_turn" or not text:
            failed.append(f"{vid} (stop {msg.stop_reason})")
            continue
        try:
            answer = json.loads(text)
        except json.JSONDecodeError:
            failed.append(f"{vid} (bad JSON)")
            continue
        rows.append({"episode_id": vid, "features": {**state["local"][vid], **text_features(answer)},
                     "model_version": MODEL_VERSION, "analysed_at": now})
    append_cache(rows)
    n = max(1, len(rows))
    progress(f"batch {batch_id}: {len(rows)} episodes saved, {len(failed)} failed{': ' + ', '.join(failed) if failed else ''}; "
             f"tokens in {usage['input_tokens']} out {usage['output_tokens']} (per episode {usage['input_tokens'] // n} / "
             f"{usage['output_tokens'] // n}); cost ${cost(usage):.4f}")
    BATCH_STATE_PATH.unlink(missing_ok=True)


def analyse(db, limit: int | None) -> None:
    client = anthropic.Anthropic()
    if BATCH_STATE_PATH.exists():  # a batch from an earlier run: collect it first
        collect(client, json.loads(BATCH_STATE_PATH.read_text(encoding="utf-8")))
    done = read_cache()
    todo = [e for e in episodes(db) if e["video_id"] not in done]
    if limit is not None:
        todo = spread(todo, limit)
    if not todo:
        progress("nothing to do: every episode has features")
        return
    progress(f"analysing {len(todo)} thumbnails ({len(done)} done before)")
    local, reqs, skipped = {}, [], []
    for i, ep in enumerate(todo, 1):
        vid = ep["video_id"]
        try:
            img, size = read_image(vid)
        except Exception as exc:  # noqa: BLE001 - one bad thumbnail must not stop the run
            skipped.append(vid)
            log.warning("%s: %s", vid, exc)
            continue
        local[vid] = local_features(img, size)
        reqs.append(request_for(vid, haiku_image(img)))
        if i % 25 == 0:
            progress(f"measured {i} of {len(todo)} locally")
    if not reqs:
        return
    batch = client.messages.batches.create(requests=reqs)
    state = {"batch_id": batch.id, "local": local}
    BATCH_STATE_PATH.write_text(json.dumps(state), encoding="utf-8")
    progress(f"submitted batch {batch.id} with {len(reqs)} thumbnails; skipped {len(skipped)}: {', '.join(skipped)}")
    collect(client, state)


# ---------- report and load ----------

def sample(db, n: int) -> None:
    done = read_cache()
    eps = [e for e in episodes(db) if e["video_id"] in done]
    for e in spread(eps, n):
        f = done[e["video_id"]]["features"]
        cols = " ".join(c["hex"] for c in f["colours"])
        print(f"{(e['published_at'] or '')[:10]}  {e['title'][:70]}")
        print(f"    faces {f['faces']} ({f['framing']}, largest {f['largest_face']:.0%})  words {f['word_count']} "
              f"{'#' if f['has_number'] else '-'}{'?' if f['has_question'] else '-'} {','.join(f['text_langs']) or '-'}  "
              f"bright {f['brightness']} contrast {f['contrast']}  {cols}  [{f['source']}]")
        print(f"    text: {' / '.join(f['text']) or '(none)'}")
    print(f"\n{len(done)} episodes have features ({MODEL_VERSION})")


def load(db) -> None:
    rows = list(read_cache().values())
    try:
        have = {}
        start = 0
        while True:
            page = db_lib.call("thumbnail_features", lambda: db.table("thumbnail_features").select("episode_id,model_version")
                               .order("episode_id").range(start, start + PAGE - 1).execute(), db).data
            have.update({r["episode_id"]: r["model_version"] for r in page})
            if len(page) < PAGE:
                break
            start += PAGE
    except Exception as exc:  # noqa: BLE001
        if "thumbnail_features" in str(exc):
            sys.exit("public.thumbnail_features does not exist yet: run pipeline/sql/thumbnail_features.sql in the Supabase SQL Editor")
        raise
    todo = [r for r in rows if have.get(r["episode_id"]) != MODEL_VERSION]
    for i in range(0, len(todo), 100):
        part = todo[i:i + 100]
        db_lib.call("upsert thumbnail_features", lambda: db.table("thumbnail_features").upsert(part, on_conflict="episode_id").execute(), db)
    progress(f"loaded {len(todo)} rows into thumbnail_features ({len(rows) - len(todo)} already there)")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true", help="list what is left and the estimated cost; change nothing")
    parser.add_argument("--limit", type=int, help="analyse at most this many episodes, spread over the dates")
    parser.add_argument("--sample", type=int, help="print the features of this many analysed episodes next to their titles")
    parser.add_argument("--load", action="store_true", help="upsert the analysed features into public.thumbnail_features")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    for name in ("httpx", "httpx2", "anthropic"):
        logging.getLogger(name).setLevel(logging.WARNING)
    load_dotenv(ROOT / ".env")
    db = db_lib.client()
    if args.sample:
        sample(db, args.sample)
    elif args.load:
        load(db)
    elif args.dry_run:
        done = read_cache()
        left = [e for e in episodes(db) if e["video_id"] not in done]
        n = len(left) if args.limit is None else min(args.limit, len(left))
        est = cost({"input_tokens": EST_TOKENS[0] * n, "output_tokens": EST_TOKENS[1] * n})
        print(f"{len(done)} done, {len(left)} left; this run: {n} thumbnails, Haiku batch about ${est:.3f}")
    else:
        analyse(db, args.limit)


if __name__ == "__main__":
    main()
