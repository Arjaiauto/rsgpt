"""List YouTube caption tracks per episode and download the creator-uploaded ones.

Two steps:
  list      For each episode, ask YouTube (through yt-dlp, no downloading) which
            caption tracks exist. "Uploaded" tracks are the creator's own
            subtitles; "automatic" tracks are YouTube's speech recognition (the
            original language shows up as <lang>-orig, the rest are machine
            translations of it). One row per episode goes to
            data/captions/subs_index.csv.
  download  For the bake-off episodes, download only the uploaded tracks (json3,
            which has timings) to data/captions/<video_id>.<lang>.json3, and write
            the 10:00-20:00 window to data/bakeoff/<video_id>_youtube_captions.json
            in the same shape as the other bake-off results, so
            04_bakeoff.py can show it as a column.
  download-auto  For the bake-off episodes, download YouTube's automatic tracks:
            the original-language one (<lang>-orig) for every episode, and the
            automatic English translation ("en") where the original is not
            English. Written as youtube_auto_orig and youtube_auto_en results.
  transcribe  The main transcript step for a set of episodes (--set test_set|all):
            1. Download the original-language automatic track (<lang>-orig, json3).
               The episode's language comes from that track (hi-orig = Hindi,
               en-orig = English) and is written to episodes.caption_language.
            2. (YouTube's automatic English translation track is no longer used:
               YouTube kept refusing it with HTTP 429. See step 4b.)
            3. Each caption phrase becomes a segment. Its start is when its first
               word is spoken; its end is when the next phrase starts (capped at
               the phrase's display time), not the rolling-display end in json3.
            4. Hindi lines are romanized by claude-haiku-5-5 through the Batch API
               with the rules in romanize_lib.py. A line whose word count is more
               than 20% off keeps its Devanagari original and is logged. English
               episodes keep text_roman = text_original.
            4b. Every line of a Hindi episode is translated into English by
               claude-haiku-5-5 through the Batch API, line by line with its
               timing, with the rules tested in 07_translate.py (romanize_lib.py).
               At most 40 lines per request, each numbered with its ID, and a
               JSON schema that allows exactly those IDs; answers with missing,
               extra or duplicated IDs are retried, then split in half. Lines
               whose English length is far off (length check) are translated
               again one at a time. The Sarvam fallback episodes are translated
               from their Roman text.
            5. Segments and translation lines are written to Supabase with
               source = youtube_auto, and episodes.status becomes 'transcribed'.
            Fallback: with no automatic track, an original track that is neither
            Hindi nor English, or captions covering under 80% of the episode, the
            episode is transcribed from audio (03_download_audio.py) instead:
            Groq whisper-large-v3 for English, Sarvam saaras:v4 translit for Hindi
            (source groq / sarvam), using the bake-off code in 04_bakeoff.py.
            An en-orig track that covers under 80% or has "foreign" markers (lines
            YouTube could not follow, in practice Hindi) is treated as Hindi and goes
            to Sarvam: Groq asked for English translates Hindi speech instead of
            transcribing it. Tracks in other languages (ar, de...) go to Groq English.
            English-track episodes averaging under 100 words per minute are listed
            as suspect (Hindi speech may have been heard as English); they are not
            reprocessed.
            Full run (--set all): episodes already marked transcribed in Supabase
            are skipped (unless their own state says a translation is still to be
            written). The rest go through steps 1-5 in groups of GROUP_SIZE (the
            test-set size), so finished episodes reach the database group by group.
            After each episode's captions and after each finished episode, a line
            goes to data/progress.log: episodes done / remaining, source, lines
            romanized and rejected this run, this run's cost (USD and INR at 88) and
            the estimated time left. Cost guard: before each step the run checks
            what it has spent plus COST_MARGIN x the step's estimate, and stops
            cleanly with a message once that would pass --max-inr (default INR 2,500).
            --dry-run changes nothing and prints the episodes left, Hindi vs English
            by caption_language, the estimated Haiku cost and the estimated hours;
            episodes already started are listed one by one with the service each will use.
            Episodes with status skipped are left out (reasons in data/skipped_episodes.json).
            Sarvam audio goes out in jobs of at most SARVAM_MAX_PIECES pieces; each job's
            ID, status and errors are kept in data/transcripts/sarvam_jobs/<job_id>.json.
  reset-to-sarvam  Delete episodes' segments and translation_segments rows and redo them with
            Sarvam (Hindi) plus the Haiku translation (e.g. Groq English that was translated Hindi).
  skip      Mark episodes skipped, with a note.

Every command copies its console output to data/logs/captions_<timestamp>.log.

Safe to rerun: episodes already in subs_index.csv are skipped, as are tracks
already downloaded. Network errors are retried; episodes that still fail are
recorded with an error and retried on the next run. For transcribe, each
episode's progress is kept in data/transcripts/<video_id>.json, batch and
Sarvam job IDs are saved, and each step is skipped once done (a rerun only
processes what is missing). YouTube gets a 20-40 second pause between
episodes; on HTTP 429 the script backs off, and if YouTube keeps refusing it
stops asking for the rest of the run (rerun later).

Usage:
    .venv\\Scripts\\python.exe pipeline\\05_captions.py list [--set bakeoff|test_set|all]
    .venv\\Scripts\\python.exe pipeline\\05_captions.py download
    .venv\\Scripts\\python.exe pipeline\\05_captions.py download-auto
    .venv\\Scripts\\python.exe pipeline\\05_captions.py transcribe --set test_set|all [--redo-translations]
                                      [--dry-run] [--max-inr 2500]
    .venv\\Scripts\\python.exe pipeline\\05_captions.py reset-to-sarvam VIDEO_ID [VIDEO_ID ...] --reason "..."
    .venv\\Scripts\\python.exe pipeline\\05_captions.py skip VIDEO_ID [VIDEO_ID ...] --note "..."
"""

import argparse
import csv
import functools
import importlib.util
import json
import logging
import os
import random
import re
import sys
import time
from pathlib import Path

import anthropic
import httpx
import yt_dlp
from dotenv import load_dotenv
from supabase import create_client

import romanize_lib

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
AUDIO_DIR = ROOT / "audio"
CAPTIONS_DIR = DATA_DIR / "captions"
BAKEOFF_DIR = DATA_DIR / "bakeoff"
CANDIDATES_CSV = DATA_DIR / "candidates.csv"
INDEX_CSV = CAPTIONS_DIR / "subs_index.csv"

SETS = ["bakeoff", "test_set", "all"]
PIECE_FILE = "part_001.mp3"
MAX_RETRIES = 3
PAUSE_SECONDS = 1.0  # between episodes, to stay polite with YouTube
# YouTube answers 429 to automatic-translation tracks when asked too often.
SUBTITLE_RETRY_SECONDS = 180  # wait before retry n is n times this

INDEX_FIELDS = ["video_id", "title", "uploaded_langs", "uploaded_names", "auto_original_langs",
                "auto_track_count", "error"]

log = logging.getLogger("captions")


def read_episodes(which: str) -> list[dict]:
    with CANDIDATES_CSV.open(newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    if which == "all":
        return rows
    return [r for r in rows if r[which] == "yes"]


def read_index() -> dict[str, dict]:
    if not INDEX_CSV.exists():
        return {}
    with INDEX_CSV.open(newline="", encoding="utf-8") as f:
        return {r["video_id"]: r for r in csv.DictReader(f)}


def write_index(index: dict[str, dict]) -> None:
    tmp = INDEX_CSV.with_suffix(".csv.tmp")
    with tmp.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=INDEX_FIELDS)
        writer.writeheader()
        writer.writerows(index.values())
    tmp.replace(INDEX_CSV)


def extract(url: str) -> dict:
    options = {"quiet": True, "no_warnings": True, "skip_download": True}
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            with yt_dlp.YoutubeDL(options) as ydl:
                return ydl.extract_info(url, download=False)
        except yt_dlp.utils.DownloadError:
            if attempt == MAX_RETRIES:
                raise
            wait = 10 * attempt
            log.warning("%s: lookup failed, retrying in %ss (attempt %s/%s)", url, wait, attempt, MAX_RETRIES)
            time.sleep(wait)
    raise AssertionError("unreachable")


def track_row(episode: dict, info: dict) -> dict:
    uploaded = {k: v for k, v in (info.get("subtitles") or {}).items() if k != "live_chat"}
    auto = info.get("automatic_captions") or {}
    originals = sorted(k[: -len("-orig")] for k in auto if k.endswith("-orig"))
    names = [(tracks[0].get("name") or "") if tracks else "" for tracks in uploaded.values()]
    return {
        "video_id": episode["video_id"],
        "title": episode["title"],
        "uploaded_langs": ";".join(uploaded),
        "uploaded_names": ";".join(names),
        "auto_original_langs": ";".join(originals),
        "auto_track_count": len(auto),
        "error": "",
    }


def cmd_list(which: str) -> None:
    CAPTIONS_DIR.mkdir(parents=True, exist_ok=True)
    episodes = read_episodes(which)
    index = read_index()
    todo = [ep for ep in episodes if ep["video_id"] not in index or index[ep["video_id"]]["error"]]
    log.info("%s episodes in set %s, %s to look up", len(episodes), which, len(todo))
    for i, ep in enumerate(todo, 1):
        try:
            row = track_row(ep, extract(ep["url"]))
        except Exception as exc:
            row = {f: "" for f in INDEX_FIELDS} | {"video_id": ep["video_id"], "title": ep["title"],
                                                   "error": str(exc).strip()[:300]}
            log.error("%s: %s", ep["video_id"], row["error"])
        index[ep["video_id"]] = row
        write_index(index)
        if i % 25 == 0 or i == len(todo):
            log.info("[%s/%s] looked up", i, len(todo))
        time.sleep(PAUSE_SECONDS)
    print_list_summary([index[ep["video_id"]] for ep in episodes if ep["video_id"] in index])


def print_list_summary(rows: list[dict]) -> None:
    ok = [r for r in rows if not r["error"]]
    with_uploaded = [r for r in ok if r["uploaded_langs"]]
    by_lang: dict[str, int] = {}
    for r in with_uploaded:
        for lang in r["uploaded_langs"].split(";"):
            by_lang[lang] = by_lang.get(lang, 0) + 1
    auto_by_lang: dict[str, int] = {}
    for r in ok:
        key = r["auto_original_langs"] or "(none)"
        auto_by_lang[key] = auto_by_lang.get(key, 0) + 1
    print()
    print(f"Episodes looked up:       {len(ok)} ({len(rows) - len(ok)} failed)")
    print(f"With uploaded captions:   {len(with_uploaded)}")
    for lang, n in sorted(by_lang.items(), key=lambda kv: -kv[1]):
        print(f"    {lang:<12} {n}")
    print("Automatic captions, original language:")
    for lang, n in sorted(auto_by_lang.items(), key=lambda kv: -kv[1]):
        print(f"    {lang:<12} {n}")
    print(f"Index: {INDEX_CSV}")


def json3_segments(path: Path) -> list[dict]:
    data = json.loads(path.read_text(encoding="utf-8"))
    segments = []
    for event in data.get("events", []):
        text = "".join(s.get("utf8", "") for s in event.get("segs") or []).replace("\n", " ").strip()
        if not text:
            continue
        start = event["tStartMs"] / 1000
        segments.append({"start": start, "end": start + event.get("dDurationMs", 0) / 1000, "text": text})
    return segments


def cmd_download() -> None:
    CAPTIONS_DIR.mkdir(parents=True, exist_ok=True)
    index = read_index()
    for ep in read_episodes("bakeoff"):
        vid = ep["video_id"]
        row = index.get(vid)
        if not row or row["error"]:
            log.warning("%s: not in %s yet; run the list step first", vid, INDEX_CSV.name)
            continue
        langs = [lang for lang in row["uploaded_langs"].split(";") if lang]
        if not langs:
            log.info("%s: no uploaded captions, nothing to download", vid)
            continue
        missing = [lang for lang in langs if not (CAPTIONS_DIR / f"{vid}.{lang}.json3").exists()]
        if missing:
            options = {
                "quiet": True, "no_warnings": True, "skip_download": True,
                "writesubtitles": True, "writeautomaticsub": False,
                "subtitleslangs": missing, "subtitlesformat": "json3",
                "outtmpl": str(CAPTIONS_DIR / f"{vid}.%(ext)s"),
            }
            for attempt in range(1, MAX_RETRIES + 1):
                try:
                    with yt_dlp.YoutubeDL(options) as ydl:
                        ydl.download([ep["url"]])
                    break
                except yt_dlp.utils.DownloadError:
                    if attempt == MAX_RETRIES:
                        raise
                    time.sleep(10 * attempt)
            log.info("%s: downloaded %s", vid, ", ".join(missing))
        write_bakeoff_result(vid, langs)


def write_bakeoff_result(vid: str, langs: list[str]) -> None:
    # One uploaded track per episode is shown; if there are several, the first listed wins.
    lang = langs[0]
    write_window(vid, "youtube_captions", f"YouTube uploaded captions ({lang})", CAPTIONS_DIR / f"{vid}.{lang}.json3",
                 {"caption_lang": lang, "other_uploaded_langs": langs[1:]})


def piece_window(vid: str) -> dict:
    manifest = json.loads((AUDIO_DIR / vid / "manifest.json").read_text(encoding="utf-8"))
    return next(p for p in manifest["pieces"] if p["file"] == PIECE_FILE)


def write_window(vid: str, service: str, model: str, track: Path | None, extra: dict) -> None:
    """Write the 10:00-20:00 window of a json3 track as a bake-off result.

    With track=None, writes a placeholder whose not_applicable text the page shows instead.
    """
    piece = piece_window(vid)
    start, end = piece["start_seconds"], piece["start_seconds"] + piece["duration_seconds"]
    segments = [s for s in json3_segments(track) if start <= s["start"] < end] if track else []
    result = {
        "video_id": vid,
        "service": service,
        "model": model,
        **extra,
        "audio_file": PIECE_FILE,
        "offset_seconds": start,
        "duration_seconds": piece["duration_seconds"],
        "cost": 0.0,
        "currency": "USD",
        "segments": [{"start": round(s["start"], 2), "end": round(s["end"], 2), "text": s["text"]} for s in segments],
    }
    path = BAKEOFF_DIR / f"{vid}_{service}.json"
    path.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    if track:
        log.info("%s: %s caption lines in %s-%ss -> %s", vid, len(segments), int(start), int(end), path.name)


def download_auto_tracks(episode: dict, langs: list[str]) -> dict:
    """Download the given automatic caption tracks as json3; returns yt-dlp's requested_subtitles."""
    options = {
        "quiet": True, "no_warnings": True, "noprogress": True, "skip_download": True,
        "writesubtitles": False, "writeautomaticsub": True,
        "subtitleslangs": langs, "subtitlesformat": "json3",
        "outtmpl": str(CAPTIONS_DIR / f"{episode['video_id']}.%(ext)s"),
        "sleep_interval_subtitles": 5,
    }
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            with yt_dlp.YoutubeDL(options) as ydl:
                info = ydl.extract_info(episode["url"], download=True)
            requested = info.get("requested_subtitles") or {}
            missing = [lang for lang in langs if not (CAPTIONS_DIR / f"{episode['video_id']}.{lang}.json3").exists()]
            if missing:
                raise yt_dlp.utils.DownloadError(f"no file written for {missing}")
            return requested
        except yt_dlp.utils.DownloadError as exc:
            if attempt == MAX_RETRIES:
                raise
            wait = SUBTITLE_RETRY_SECONDS * attempt
            log.warning("%s: caption download failed (%s), retrying in %ss", episode["video_id"], exc, wait)
            time.sleep(wait)
    raise AssertionError("unreachable")


def cmd_download_auto() -> None:
    """Automatic captions for the bake-off: the original-language track for every episode,
    plus YouTube's English translation for episodes whose original track is not English."""
    CAPTIONS_DIR.mkdir(parents=True, exist_ok=True)
    index = read_index()
    failed = []
    translations_refused = False
    for ep in read_episodes("bakeoff"):
        vid = ep["video_id"]
        row = index.get(vid)
        if not row or row["error"] or not row["auto_original_langs"]:
            log.error("%s: no automatic original track in %s; run the list step first", vid, INDEX_CSV.name)
            failed.append(vid)
            continue
        orig = row["auto_original_langs"].split(";")[0]
        wanted = [f"{orig}-orig"] + (["en"] if orig != "en" else [])
        # One track per request, so a failed translation does not hold back the original.
        for lang in wanted:
            if (CAPTIONS_DIR / f"{vid}.{lang}.json3").exists():
                continue
            if lang == "en" and translations_refused:
                log.info("%s: skipping en, YouTube refused an earlier translation after all retries", vid)
                failed.append(f"{vid} {lang} (skipped)")
                continue
            try:
                requested = download_auto_tracks(ep, [lang])
            except Exception as exc:
                log.error("%s: %s download failed: %s", vid, lang, str(exc).strip()[:300])
                failed.append(f"{vid} {lang}")
                if lang == "en" and "429" in str(exc):
                    translations_refused = True
                continue
            if lang == "en" and "tlang=en" not in (requested.get(lang) or {}).get("url", ""):
                log.warning("%s: 'en' track URL has no tlang=en; it may not be a translation", vid)
            log.info("%s: downloaded %s", vid, lang)
            time.sleep(PAUSE_SECONDS)

        orig_track = CAPTIONS_DIR / f"{vid}.{orig}-orig.json3"
        if orig_track.exists():
            write_window(vid, "youtube_auto_orig", f"YouTube automatic captions ({orig}-orig)",
                         orig_track, {"caption_lang": f"{orig}-orig"})
        en_track = CAPTIONS_DIR / f"{vid}.en.json3"
        if orig == "en":
            write_window(vid, "youtube_auto_en", "YouTube automatic English translation", None,
                         {"not_applicable": "not needed (already English)"})
        elif en_track.exists():
            write_window(vid, "youtube_auto_en", f"YouTube automatic English translation (from {orig})",
                         en_track, {"caption_lang": "en", "translated_from": orig})
    if failed:
        print(f"Failed: {', '.join(failed)}")


# ---------- transcribe ----------

TRANSCRIPTS_DIR = DATA_DIR / "transcripts"
ROMAN_CHUNK_DIR = TRANSCRIPTS_DIR / "roman_chunks"
ROMAN_JOB_PATH = TRANSCRIPTS_DIR / "roman_job.json"
TRANSLATION_UNIT_DIR = TRANSCRIPTS_DIR / "translation_units"
TRANSLATION_JOB_PATH = TRANSCRIPTS_DIR / "translation_units_job.json"
SARVAM_JOBS_DIR = TRANSCRIPTS_DIR / "sarvam_jobs"  # one file per Sarvam job, named by its job ID
LOGS_DIR = DATA_DIR / "logs"
SKIPPED_PATH = DATA_DIR / "skipped_episodes.json"  # why an episode has status skipped
STATE_BACKUP_DIR = TRANSCRIPTS_DIR / "replaced"
AUDIO_RESULTS_DIR = TRANSCRIPTS_DIR / "audio"

MIN_COVERAGE = 0.80
# YouTube's English recognizer writes a caption line reading just "foreign" (sometimes "[Foreign]")
# where it hears speech it cannot follow, in practice Hindi.
FOREIGN_MARKER = re.compile(r"\[?foreign\]?", re.I)
MIN_FOREIGN_MARKERS = 1  # an en-orig track with this many is treated as Hindi
SUSPECT_WORDS_PER_MINUTE = 100
EPISODE_PAUSE_SECONDS = (20, 40)
YOUTUBE_RETRIES = 3
BACKOFF_429_SECONDS = 180  # wait before retry n is n times this
ROMAN_CHUNK_LINES = 60
ROMAN_ROUNDS = 3  # tries per chunk per run; later rounds resend only chunks that failed
ROMAN_MAX_ROUNDS = 12  # batches per run, counting rounds whose chunks were refused for a rate limit
ROMAN_SUB_CHUNK_LINES = 10  # a chunk still incomplete after its tries is resent in sub-chunks this size
DB_BATCH = 500

FALLBACK = {"en": "groq", "hi": "sarvam"}
GROQ_MODEL = "whisper-large-v3"
# language_code is set per job from SARVAM_LANGUAGES, so Sarvam skips its automatic language identification
# (its batch LID failed whole files with "Audio chunks and segments must be aligned for batch LID").
SARVAM_PARAMS = {"model": "saaras:v4", "mode": "translit", "with_timestamps": True}
SARVAM_LANGUAGES = {"hi": "hi-IN"}
SARVAM_MAX_PIECES = 20  # audio pieces per Sarvam job
SARVAM_POLL_SECONDS = 20
SARVAM_TIMEOUT_SECONDS = 3 * 3600
SARVAM_JOB_MINUTES = (10, 30)  # assumed wait per Sarvam job, for the dry run

PROGRESS_LOG = DATA_DIR / "progress.log"
GROUP_SIZE = 25  # episodes taken through every step together: the size proven on the test set
INR_PER_USD = 88
MAX_RUN_INR = 2500  # cost guard: this run stops once its cost would pass this
COST_MARGIN = 1.5  # a step is started only if spent + COST_MARGIN x its estimate stays under the cap
BATCH_MINUTES = (2, 4)  # one Haiku batch at test-set size
BATCHES_PER_GROUP = 4  # romanization, translation, its retries, the length-check redo
FALLBACK_MINUTES = (3, 6)  # audio download plus Groq or Sarvam, per fallback episode
SECONDS_PER_EPISODE = 35 + BATCHES_PER_GROUP * 3 * 60 / GROUP_SIZE  # ETA before the first episode is finished
DEFAULT_LINE_USD = {"roman": 2e-5, "translation": 3e-5}  # used only if no Hindi episode is done yet


class YouTubeRefused(RuntimeError):
    """YouTube kept answering 429 after every back-off."""


def load_module(filename: str):
    spec = importlib.util.spec_from_file_location(Path(filename).stem, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def state_path(vid: str) -> Path:
    return TRANSCRIPTS_DIR / f"{vid}.json"


def load_state(vid: str) -> dict | None:
    path = state_path(vid)
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None


def save_state(state: dict) -> None:
    path = state_path(state["video_id"])
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(state, indent=1, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def fetch_auto_track(episode: dict, langs: list[str]) -> dict:
    """Download automatic caption tracks matching langs (yt-dlp patterns); returns the video info.

    Backs off on HTTP 429 and raises YouTubeRefused if YouTube still refuses after every retry.
    """
    options = {
        "quiet": True, "no_warnings": True, "noprogress": True, "skip_download": True,
        "writesubtitles": False, "writeautomaticsub": True,
        "subtitleslangs": langs, "subtitlesformat": "json3",
        "outtmpl": str(CAPTIONS_DIR / f"{episode['video_id']}.%(ext)s"),
        "sleep_interval_subtitles": 5,
    }
    for attempt in range(1, YOUTUBE_RETRIES + 1):
        try:
            with yt_dlp.YoutubeDL(options) as ydl:
                return ydl.extract_info(episode["url"], download=True)
        except yt_dlp.utils.DownloadError as exc:
            refused = "429" in str(exc)
            if attempt == YOUTUBE_RETRIES:
                if refused:
                    raise YouTubeRefused(str(exc).strip()[:300]) from exc
                raise
            wait = BACKOFF_429_SECONDS * attempt if refused else 15 * attempt
            log.warning("%s: %s, retrying in %ss", episode["video_id"],
                        "YouTube answered 429" if refused else str(exc).strip()[:200], wait)
            time.sleep(wait)
    raise AssertionError("unreachable")


def phrase_segments(path: Path) -> list[dict]:
    """Caption phrases with when they are spoken.

    json3 automatic tracks show phrases in a rolling two-line window, so an event's
    dDurationMs runs until the line scrolls away, well after it was said. A phrase
    starts at its first word and ends when the next phrase starts, capped at its
    display end. Newline-only "aAppend" events are skipped.
    """
    data = json.loads(path.read_text(encoding="utf-8"))
    phrases = []
    for event in data.get("events", []):
        segs = event.get("segs") or []
        if event.get("aAppend") or not segs:
            continue
        text = " ".join("".join(s.get("utf8", "") for s in segs).split())
        if not text:
            continue
        start = (event["tStartMs"] + segs[0].get("tOffsetMs", 0)) / 1000
        phrases.append({"start": start, "shown_until": (event["tStartMs"] + event.get("dDurationMs", 0)) / 1000,
                        "text": text})
    segments = []
    for i, p in enumerate(phrases):
        next_start = phrases[i + 1]["start"] if i + 1 < len(phrases) else p["shown_until"]
        end = max(p["start"], min(next_start, p["shown_until"]))
        segments.append({"start": round(p["start"], 2), "end": round(end, 2), "text": p["text"]})
    return segments


def coverage(segments: list[dict], duration: float) -> float:
    """Share of the episode inside at least one segment."""
    covered, reach = 0.0, 0.0
    for s in sorted(segments, key=lambda s: s["start"]):
        start, end = max(s["start"], reach), min(s["end"], duration)
        if end > start:
            covered += end - start
        reach = max(reach, s["end"])
    return covered / duration if duration else 0.0


def orig_track_file(vid: str) -> Path | None:
    found = sorted(CAPTIONS_DIR.glob(f"{vid}.*-orig.json3"))
    return found[0] if found else None


def csv_language(episode: dict) -> str | None:
    lang = episode.get("default_audio_language", "").lower().split("-")[0]
    return lang if lang in ("en", "hi") else None


def new_state(episode: dict) -> dict:
    return {"video_id": episode["video_id"], "title": episode["title"],
            "duration_seconds": float(episode["duration_seconds"]),
            "track": None, "language": None, "source": None, "coverage": None, "fallback_reason": "",
            "words_per_minute": None, "suspect": False, "segments": None,
            "romanized": False, "flagged_seqs": [], "roman_cost_usd": 0.0,
            "translation": "n/a", "translation_segments": None, "translation_cost_usd": 0.0,
            "audio_cost": None, "db_segments": False, "db_translation": False}


def foreign_markers(path: Path) -> int:
    """Caption lines that are only a "foreign" marker."""
    data = json.loads(path.read_text(encoding="utf-8"))
    return sum(1 for event in data.get("events", [])
               if FOREIGN_MARKER.fullmatch(" ".join("".join(s.get("utf8", "") for s in event.get("segs") or []).split())))


def decide_from_track(state: dict, episode: dict, track: Path | None) -> None:
    """Sets language, source and (for caption episodes) segments from the downloaded original track.

    An en-orig track covering under MIN_COVERAGE of the episode, or with "foreign" markers, is
    treated as Hindi: Groq asked for English would translate the Hindi speech, so it goes to Sarvam.
    """
    vid = state["video_id"]
    lang = track.name[len(vid) + 1:-len("-orig.json3")].split("-")[0] if track else None
    state["track"] = track.name if track else None
    if lang in ("en", "hi"):
        state["language"] = lang
        segments = phrase_segments(track)
        state["coverage"] = round(coverage(segments, state["duration_seconds"]), 3)
        markers = foreign_markers(track) if lang == "en" else 0
        state["foreign_markers"] = markers
        if state["coverage"] >= MIN_COVERAGE and markers < MIN_FOREIGN_MARKERS:
            state["source"] = "youtube_auto"
            state["segments"] = [{"seq": i, "start": s["start"], "end": s["end"], "text_original": s["text"],
                                  "text_roman": s["text"] if lang == "en" else None}
                                 for i, s in enumerate(segments)]
            if lang == "en":
                words = sum(len(s["text"].split()) for s in segments)
                state["words_per_minute"] = round(words / (state["duration_seconds"] / 60), 1)
                state["suspect"] = state["words_per_minute"] < SUSPECT_WORDS_PER_MINUTE
            else:
                state["translation"] = "pending"
            return
        state["fallback_reason"] = f"captions cover {state['coverage']:.0%} of the episode"
        if lang == "en":
            state["language"] = "hi"
            state["fallback_reason"] = (f"English track covers {state['coverage']:.0%} of the episode and has "
                                        f"{markers} 'foreign' markers; treated as Hindi")
    elif track:
        # A track in another language (ar, de...) is YouTube mishearing; these episodes have been English.
        state["language"] = "en"
        state["fallback_reason"] = f"original track is {track.name}, not Hindi or English"
    else:
        # No track: guess the language for the audio model from the episode metadata.
        state["language"] = csv_language(episode) or "en"
        state["fallback_reason"] = "no automatic captions"
    state["source"] = FALLBACK[state["language"]]
    log.warning("%s: %s; falling back to %s (%s)", vid, state["fallback_reason"], state["source"],
                state["language"])


def youtube_step(episodes: list[dict], states: dict[str, dict], failed: list[str], on_episode=None) -> bool:
    """Steps 1-3: original track, language and segments. Returns True if YouTube kept refusing (stop asking)."""
    contacted = False
    for ep in episodes:
        vid = ep["video_id"]
        if vid in states:
            continue
        state = new_state(ep)
        track = orig_track_file(vid)
        if track is None:
            if contacted:
                time.sleep(random.uniform(*EPISODE_PAUSE_SECONDS))
            contacted = True
            try:
                fetch_auto_track(ep, [r".*-orig"])
            except YouTubeRefused as exc:
                log.error("%s: YouTube keeps answering 429 (%s); stopping YouTube downloads for this run", vid, exc)
                failed.append(f"{vid}: YouTube 429, rerun later")
                return True
            except Exception as exc:
                log.error("%s: caption lookup failed: %s", vid, str(exc).strip()[:300])
                failed.append(f"{vid}: caption lookup failed")
                continue
            track = orig_track_file(vid)
        decide_from_track(state, ep, track)
        states[vid] = state
        save_state(state)
        log.info("%s: %s, %s, coverage %s, %s segments", vid, state["track"] or "no track", state["language"],
                 state["coverage"], len(state["segments"] or []))
        if on_episode:
            on_episode(state, "captions")
    return False


# ----- audio fallback -----

def groq_cost(seconds: float, bakeoff) -> float:
    return max(seconds, bakeoff.GROQ_MIN_BILLED_SECONDS) / 3600 * bakeoff.SERVICES["groq_large"]["price_per_hour"]


def transcribe_groq_episode(state: dict, bakeoff, client) -> None:
    vid = state["video_id"]
    manifest = json.loads((AUDIO_DIR / vid / "manifest.json").read_text(encoding="utf-8"))
    out_dir = AUDIO_RESULTS_DIR / vid
    out_dir.mkdir(parents=True, exist_ok=True)
    segments, cost = [], 0.0
    for piece in manifest["pieces"]:
        out = out_dir / f"{piece['file']}.groq.json"
        if not out.exists():
            log.info("%s: Groq %s %s", vid, GROQ_MODEL, piece["file"])
            response = client.audio.transcriptions.create(
                file=(f"{vid}_{piece['file']}", (AUDIO_DIR / vid / piece["file"]).read_bytes()),
                model=GROQ_MODEL, language="en", response_format="verbose_json",
                timestamp_granularities=["segment"], temperature=0.0)
            raw = response.model_dump() if hasattr(response, "model_dump") else dict(response)
            out.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
        raw = json.loads(out.read_text(encoding="utf-8"))
        offset = piece["start_seconds"]
        segments += [{"start": s["start"] + offset, "end": s["end"] + offset, "text": s["text"].strip()}
                     for s in raw.get("segments") or [] if s["text"].strip()]
        cost += groq_cost(piece["duration_seconds"], bakeoff)
    finish_audio_state(state, segments, {"currency": "USD", "amount": round(cost, 6)})


def finish_audio_state(state: dict, segments: list[dict], cost: dict) -> None:
    state["segments"] = [{"seq": i, "start": round(s["start"], 2), "end": round(s["end"], 2),
                          "text_original": s["text"], "text_roman": s["text"]} for i, s in enumerate(segments)]
    state["audio_cost"] = cost
    state["translation"] = "pending" if state["language"] == "hi" else "n/a"
    save_state(state)
    log.info("%s: %s segments from %s", state["video_id"], len(segments), state["source"])


def sarvam_job_files(pieces: dict[str, tuple[dict, dict]]) -> list[list[str]]:
    """The pieces' file names in jobs of at most SARVAM_MAX_PIECES, keeping an episode's pieces together when it fits."""
    by_episode: dict[str, list[str]] = {}
    for name, (state, _) in pieces.items():
        by_episode.setdefault(state["video_id"], []).append(name)
    jobs, current = [], []
    for names in by_episode.values():
        if current and len(current) + len(names) > SARVAM_MAX_PIECES:
            jobs.append(current)
            current = []
        for name in names:
            if len(current) == SARVAM_MAX_PIECES:
                jobs.append(current)
                current = []
            current.append(name)
    return jobs + ([current] if current else [])


def save_sarvam_job(job: dict) -> None:
    """Each job has its own file, named by its job ID, so no job's record is overwritten by another's."""
    SARVAM_JOBS_DIR.mkdir(parents=True, exist_ok=True)
    job["updated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
    path = SARVAM_JOBS_DIR / f"{job['job_id']}.json"
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(job, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def open_sarvam_job(files: list[str]) -> dict | None:
    """An unfinished job for exactly these files, to resume; failed and collected jobs are not reused."""
    for path in sorted(SARVAM_JOBS_DIR.glob("*.json")) if SARVAM_JOBS_DIR.exists() else []:
        job = json.loads(path.read_text(encoding="utf-8"))
        if job["files"] == files and job["status"] not in ("failed", "collected"):
            return job
    return None


def run_sarvam_job(files: list[str], pieces: dict[str, tuple[dict, dict]], bakeoff, key: str) -> None:
    """Create (or resume), upload, start and wait for one Sarvam job, then download its results.

    The job file records its status (created, uploaded, started, collected or failed), Sarvam's job
    state and any error, including the errors of single files. A job still running after
    SARVAM_TIMEOUT_SECONDS keeps status started, so a rerun waits for it again.
    """
    job = open_sarvam_job(files)
    if job is None:
        languages = {SARVAM_LANGUAGES.get(pieces[name][0]["language"], "unknown") for name in files}
        params = SARVAM_PARAMS | {"language_code": languages.pop() if len(languages) == 1 else "unknown"}
        created = bakeoff.sarvam_request("POST", bakeoff.SARVAM_BASE, key, json={"job_parameters": params})
        job = {"job_id": created["job_id"], "files": files, "status": "created", "sarvam_state": None, "error": "",
               "file_errors": {}, "job_parameters": params, "created_at": time.strftime("%Y-%m-%d %H:%M:%S")}
        save_sarvam_job(job)
        log.info("Sarvam job %s created for %s pieces, language_code %s", job["job_id"], len(files),
                 params["language_code"])
    else:
        log.info("Resuming Sarvam job %s (%s, %s pieces)", job["job_id"], job["status"], len(files))
    try:
        if job["status"] == "created":
            resp = bakeoff.sarvam_request("POST", f"{bakeoff.SARVAM_BASE}/upload-files", key,
                                          json={"job_id": job["job_id"], "files": files})
            azure = resp.get("storage_container_type", "").startswith("Azure")
            for name in files:
                state, piece = pieces[name]
                headers = {"Content-Type": "audio/mpeg"} | ({"x-ms-blob-type": "BlockBlob"} if azure else {})
                data = (AUDIO_DIR / state["video_id"] / piece["file"]).read_bytes()
                bakeoff.storage_request("PUT", resp["upload_urls"][name]["file_url"], data=data, headers=headers)
            job["status"] = "uploaded"
            save_sarvam_job(job)
        if job["status"] == "uploaded":
            bakeoff.sarvam_request("POST", f"{bakeoff.SARVAM_BASE}/{job['job_id']}/start", key)
            job["status"] = "started"
            save_sarvam_job(job)
        deadline = time.monotonic() + SARVAM_TIMEOUT_SECONDS
        while True:
            status = bakeoff.sarvam_request("GET", f"{bakeoff.SARVAM_BASE}/{job['job_id']}/status", key)
            if status["job_state"] != job["sarvam_state"]:
                job["sarvam_state"] = status["job_state"]
                save_sarvam_job(job)
                log.info("Sarvam job %s: %s (%s/%s files done)", job["job_id"], status["job_state"],
                         status.get("successful_files_count", 0), status.get("total_files", 0))
            if status["job_state"] == "Completed":
                break
            if status["job_state"] == "Failed":
                raise RuntimeError(f"Sarvam job failed: {status.get('error_message') or status}")
            if time.monotonic() > deadline:
                job["error"] = f"still {status['job_state']} after {SARVAM_TIMEOUT_SECONDS}s; rerun to keep waiting"
                save_sarvam_job(job)
                raise TimeoutError(job["error"])
            time.sleep(SARVAM_POLL_SECONDS)
        details = status.get("job_details") or []
        outputs = {d["inputs"][0]["file_name"]: d["outputs"][0]["file_name"]
                   for d in details if d.get("state") == "Success"}
        job["file_errors"] = {d["inputs"][0]["file_name"]: d.get("error_message") or d.get("state")
                              for d in details if d.get("state") != "Success" and d.get("inputs")}
        for name, error in job["file_errors"].items():
            log.error("Sarvam job %s, %s: %s", job["job_id"], name, error)
        if not outputs:
            raise RuntimeError(f"no file succeeded ({len(job['file_errors'])} failed); nothing to download")
        links = bakeoff.sarvam_request("POST", f"{bakeoff.SARVAM_BASE}/download-files", key,
                                       json={"job_id": job["job_id"], "files": list(outputs.values())})
        for name, out_name in outputs.items():
            state, piece = pieces[name]
            out = AUDIO_RESULTS_DIR / state["video_id"] / f"{piece['file']}.sarvam.json"
            out.parent.mkdir(parents=True, exist_ok=True)
            if not out.exists():
                raw = bakeoff.storage_request("GET", links["download_urls"][out_name]["file_url"]).json()
                out.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
        job["status"] = "collected"
        save_sarvam_job(job)
        if job["file_errors"]:
            log.error("Sarvam job %s: %s of %s files failed", job["job_id"], len(job["file_errors"]), len(files))
    except TimeoutError:
        raise
    except Exception as exc:
        job["status"], job["error"] = "failed", str(exc)[:2000]
        save_sarvam_job(job)
        raise


def transcribe_sarvam_episodes(states: list[dict], bakeoff, key: str, failed: list[str]) -> None:
    """Sarvam jobs of at most SARVAM_MAX_PIECES pieces for the Hindi fallback episodes' pieces without a result yet."""
    pieces = {}  # Sarvam file name -> (state, piece)
    for state in states:
        manifest = json.loads((AUDIO_DIR / state["video_id"] / "manifest.json").read_text(encoding="utf-8"))
        for piece in manifest["pieces"]:
            if not (AUDIO_RESULTS_DIR / state["video_id"] / f"{piece['file']}.sarvam.json").exists():
                pieces[f"{state['video_id']}__{piece['file']}"] = (state, piece)
    jobs = sarvam_job_files(pieces)
    log.info("Sarvam: %s pieces of %s episodes in %s jobs", len(pieces), len(states), len(jobs))
    for files in jobs:
        try:
            run_sarvam_job(files, pieces, bakeoff, key)
        except Exception as exc:
            log.error("Sarvam job for %s pieces (%s ...) failed: %s", len(files), files[0], exc)
            failed.append(f"Sarvam job ({files[0]} ...): {str(exc)[:300]}")

    price = bakeoff.SERVICES["sarvam_translit"]["price_per_hour"]
    for state in states:
        manifest = json.loads((AUDIO_DIR / state["video_id"] / "manifest.json").read_text(encoding="utf-8"))
        outs = [AUDIO_RESULTS_DIR / state["video_id"] / f"{p['file']}.sarvam.json" for p in manifest["pieces"]]
        if not all(o.exists() for o in outs):
            log.error("%s: Sarvam returned no result for some pieces; rerun to retry", state["video_id"])
            continue
        segments = []
        for piece, out in zip(manifest["pieces"], outs):
            for s in bakeoff.sarvam_segments(json.loads(out.read_text(encoding="utf-8"))):
                if s["text"].strip():
                    segments.append({"start": s["start"] + piece["start_seconds"],
                                     "end": s["end"] + piece["start_seconds"], "text": s["text"].strip()})
        seconds = sum(p["duration_seconds"] for p in manifest["pieces"])
        finish_audio_state(state, segments, {"currency": "INR", "amount": round(seconds / 3600 * price, 4)})


def audio_step(episodes: list[dict], states: dict[str, dict], failed: list[str]) -> None:
    todo = [states[ep["video_id"]] for ep in episodes
            if ep["video_id"] in states and states[ep["video_id"]]["source"] in ("groq", "sarvam")
            and states[ep["video_id"]]["segments"] is None]
    if not todo:
        return
    log.info("%s episodes need audio transcription", len(todo))
    download_audio = load_module("03_download_audio.py")
    bakeoff = load_module("04_bakeoff.py")
    by_id = {ep["video_id"]: ep for ep in episodes}
    ready = []
    for state in todo:
        try:
            download_audio.process(by_id[state["video_id"]])
            ready.append(state)
        except Exception as exc:
            log.error("%s: audio download failed: %s", state["video_id"], str(exc).strip()[:300])
            failed.append(f"{state['video_id']}: audio download failed")
    groq_states = [s for s in ready if s["source"] == "groq"]
    sarvam_states = [s for s in ready if s["source"] == "sarvam"]
    if groq_states:
        if not os.environ.get("GROQ_API_KEY"):
            sys.exit("GROQ_API_KEY must be set in .env for the Groq fallback")
        client = bakeoff.Groq(api_key=os.environ["GROQ_API_KEY"], max_retries=MAX_RETRIES + 2, timeout=600)
        for state in groq_states:
            try:
                transcribe_groq_episode(state, bakeoff, client)
            except Exception as exc:
                log.error("%s: Groq failed: %s", state["video_id"], exc)
                failed.append(f"{state['video_id']}: Groq failed")
    if sarvam_states:
        if not os.environ.get("SARVAM_API_KEY"):
            sys.exit("SARVAM_API_KEY must be set in .env for the Sarvam fallback")
        try:
            transcribe_sarvam_episodes(sarvam_states, bakeoff, os.environ["SARVAM_API_KEY"], failed)
        except Exception as exc:
            log.error("Sarvam failed: %s", exc)
            failed.append(f"Sarvam: {exc}")


# ----- romanization -----

def roman_chunks(state: dict) -> dict[str, list[dict]]:
    vid = state["video_id"]
    lines = [{"id": f"{vid}-L{s['seq']:05d}", "text": s["text_original"]} for s in state["segments"]]
    return {f"{vid}-c{n:03d}": lines[i:i + ROMAN_CHUNK_LINES]
            for n, i in enumerate(range(0, len(lines), ROMAN_CHUNK_LINES))}


def roman_chunk_path(chunk_id: str) -> Path:
    return ROMAN_CHUNK_DIR / f"{chunk_id}.json"


def roman_sub_chunks(chunk_id: str, lines: list[dict]) -> dict[str, list[dict]]:
    return {f"{chunk_id}-s{n:02d}": lines[i:i + ROMAN_SUB_CHUNK_LINES]
            for n, i in enumerate(range(0, len(lines), ROMAN_SUB_CHUNK_LINES))}


def send_roman_rounds(client: anthropic.Anthropic, wanted: dict[str, tuple[list[dict], dict]]) -> None:
    """Send chunks (chunk ID -> (lines, state)) not yet complete, up to ROMAN_ROUNDS tries each this run."""
    tries: dict[str, int] = {}  # this run's tries per chunk; a rate-limit refusal is not a try
    for round_no in range(1, ROMAN_MAX_ROUNDS + 1):
        requests, expected = {}, {}
        for chunk_id, (lines, state) in wanted.items():
            if not romanize_lib.chunk_done(roman_chunk_path(chunk_id)) and tries.get(chunk_id, 0) < ROMAN_ROUNDS:
                requests[chunk_id] = romanize_lib.build_request(chunk_id, lines, state["title"],
                                                                romanize_lib.guess_guest(state["title"]))
                expected[chunk_id] = [l["id"] for l in lines]
        if not requests:
            break
        log.info("Romanization round %s: %s chunks for %s episodes", round_no, len(requests),
                 len({wanted[c][1]["video_id"] for c in requests}))
        limited = romanize_lib.run_batch(client, requests, expected, ROMAN_JOB_PATH, ROMAN_CHUNK_DIR,
                                         save=functools.partial(romanize_lib.save_chunk, reject_non_latin=True))
        for chunk_id in requests:
            if chunk_id not in limited:
                tries[chunk_id] = tries.get(chunk_id, 0) + 1
        romanize_lib.wait_after_rate_limit(limited)


def romanize_step(states: dict[str, dict]) -> float:
    """Step 4 for Hindi caption episodes. Returns what this run spent.

    A chunk still incomplete after its tries is sent again in sub-chunks of ROMAN_SUB_CHUNK_LINES.
    All its lines go, not only the missing ones: an incomplete answer cannot be trusted for the lines
    it did return (Haiku has shifted lines by one or two IDs, or stopped after one garbled line).
    A line with no complete sub-chunk answer after that keeps its Devanagari text and is flagged.
    A line containing characters of another script (romanize_lib.non_latin: stray Telugu, or
    Devanagari echoed back) counts as a failed line: it is retried the same way, then kept and flagged.
    """
    todo = [s for s in states.values()
            if s["language"] == "hi" and s["source"] == "youtube_auto" and s["segments"] and not s["romanized"]]
    if not todo:
        return 0.0
    if not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit("ANTHROPIC_API_KEY must be set in .env for romanization")
    ROMAN_CHUNK_DIR.mkdir(parents=True, exist_ok=True)
    chunks = {s["video_id"]: roman_chunks(s) for s in todo}
    subs = {c: roman_sub_chunks(c, lines) for cs in chunks.values() for c, lines in cs.items()}
    all_paths = [roman_chunk_path(c) for c in [*subs, *(s for ss in subs.values() for s in ss)]]
    spent_before = sum(romanize_lib.chunk_cost(p) for p in all_paths)
    client = anthropic.Anthropic(max_retries=MAX_RETRIES + 2)
    send_roman_rounds(client, {c: (lines, s) for s in todo for c, lines in chunks[s["video_id"]].items()})

    incomplete = [(c, s) for s in todo for c in chunks[s["video_id"]]
                  if not romanize_lib.chunk_done(roman_chunk_path(c))]
    if incomplete:
        log.info("Romanization: %s chunks still incomplete, sent again in sub-chunks of %s lines: %s",
                 len(incomplete), ROMAN_SUB_CHUNK_LINES, ", ".join(c for c, _ in incomplete))
        send_roman_rounds(client, {sub: (lines, s) for c, s in incomplete for sub, lines in subs[c].items()})

    for state in todo:
        vid, ids = state["video_id"], list(chunks[state["video_id"]])
        sub_ids = [sub for c in ids if not romanize_lib.chunk_done(roman_chunk_path(c)) for sub in subs[c]]
        if any(not roman_chunk_path(sub).exists() for sub in sub_ids):
            log.error("%s: some romanization sub-chunks were never answered (rate limits); rerun to resend them", vid)
            continue
        converted = {}
        for c in [*ids, *sub_ids]:
            converted |= romanize_lib.usable_lines(roman_chunk_path(c))
        flagged = []
        for seg in state["segments"]:
            text = converted.get(f"{vid}-L{seg['seq']:05d}", "").strip()
            if text and romanize_lib.non_latin(text):  # an answer saved before the check existed
                flagged.append(seg["seq"])
                log.warning("%s seq %s has non-Latin characters %s, keeping original: %s | %s", vid, seg["seq"],
                            "".join(romanize_lib.non_latin(text)), seg["text_original"], text)
                seg["text_roman"] = seg["text_original"]
            elif not text:
                flagged.append(seg["seq"])
                log.warning("%s seq %s not romanized after sub-chunks, keeping original: %s", vid, seg["seq"],
                            seg["text_original"])
                seg["text_roman"] = seg["text_original"]
            elif romanize_lib.is_flagged(seg["text_original"], text):
                flagged.append(seg["seq"])
                log.warning("%s seq %s flagged (%s -> %s words), keeping original: %s | %s", vid, seg["seq"],
                            romanize_lib.word_count(seg["text_original"]), romanize_lib.word_count(text),
                            seg["text_original"], text)
                seg["text_roman"] = seg["text_original"]
            else:
                seg["text_roman"] = text
        state["flagged_seqs"] = flagged
        state["roman_cost_usd"] = round(sum(romanize_lib.chunk_cost(roman_chunk_path(c))
                                            for c in [*ids, *(sub for c in ids for sub in subs[c])]), 6)
        state["romanized"] = True
        save_state(state)
        log.info("%s: romanized %s lines, %s flagged", vid, len(state["segments"]), len(flagged))
    return sum(romanize_lib.chunk_cost(p) for p in all_paths) - spent_before


# ----- translation -----

def line_id(vid: str, seq: int) -> str:
    return f"{vid}-L{seq:05d}"


def redo_translations(states: dict[str, dict]) -> None:
    """Throw away the set's translations: delete their translation_segments rows and mark them pending.

    Their saved answers are moved to TRANSLATION_UNIT_DIR/replaced, so they are kept but not reused.
    """
    db = supabase_client()
    replaced = TRANSLATION_UNIT_DIR / "replaced"
    for state in states.values():
        if state["language"] != "hi" or not state["segments"]:
            continue
        vid = state["video_id"]
        db_call("translation delete", lambda: db.table("translation_segments").delete().eq("video_id", vid).execute())
        for path in TRANSLATION_UNIT_DIR.glob(f"{vid}-*.json"):
            replaced.mkdir(parents=True, exist_ok=True)
            path.replace(replaced / f"{time.strftime('%Y%m%d-%H%M%S')}-{path.name}")
        state["earlier_translation_cost_usd"] = (state.get("earlier_translation_cost_usd", 0.0)
                                                 + state.get("translation_cost_usd", 0.0))
        state.update({"translation": "pending", "translation_segments": None, "translation_cost_usd": 0.0,
                      "db_translation": False, "translation_flagged": [], "translation_fixed": [],
                      "translation_still_flagged": []})
        save_state(state)
        log.info("%s: translation rows deleted, to be translated again", vid)


def translate_step(states: dict[str, dict], failed: list[str]) -> dict:
    """Step 4b: English translation of every line of the Hindi episodes. Returns counts for the summary."""
    todo = [s for s in states.values() if s["language"] == "hi" and s["segments"] and s["translation"] != "ok"]
    report = {"episodes": 0, "lines": 0, "flagged": 0, "fixed": 0, "still_flagged": [], "failed_lines": []}
    if not todo:
        return report
    if not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit("ANTHROPIC_API_KEY must be set in .env for translation")
    episodes = [{"key": s["video_id"], "title": s["title"], "guest": romanize_lib.guess_guest(s["title"]),
                 # YouTube captions are Devanagari; Sarvam's fallback text is already Roman Hinglish.
                 "roman": s["source"] == "sarvam",
                 "lines": [{"id": line_id(s["video_id"], seg["seq"]), "text": seg["text_original"]}
                           for seg in s["segments"]]}
                for s in todo]
    client = anthropic.Anthropic(max_retries=MAX_RETRIES + 2)
    results = romanize_lib.translate_episodes(client, episodes, TRANSLATION_UNIT_DIR, TRANSLATION_JOB_PATH)

    for state in todo:
        vid, result = state["video_id"], results[state["video_id"]]
        report["flagged"] += len(result["flagged"])
        report["fixed"] += len(result["fixed"])
        report["still_flagged"] += result["still_flagged"]
        report["failed_lines"] += result["failed"]
        if not result["complete"]:
            missing = [line_id(vid, seg["seq"]) for seg in state["segments"]
                       if line_id(vid, seg["seq"]) not in result["lines"]]
            log.error("%s: %s lines have no translation; rerun to retry", vid, len(missing))
            failed.append(f"{vid}: translation incomplete ({len(missing)} lines)")
            continue
        state["translation_segments"] = [
            {"seq": seg["seq"], "start": seg["start"], "end": seg["end"],
             "text": result["lines"][line_id(vid, seg["seq"])]} for seg in state["segments"]]
        state["translation"] = "ok"
        state["db_translation"] = False
        state["translation_cost_usd"] = round(result["cost"], 6)
        state["translation_flagged"] = result["flagged"]
        state["translation_fixed"] = result["fixed"]
        state["translation_still_flagged"] = result["still_flagged"]
        save_state(state)
        report["episodes"] += 1
        report["lines"] += len(state["translation_segments"])
        log.info("%s: translated %s lines; length check flagged %s, %s fixed on retry", vid,
                 len(state["translation_segments"]), len(result["flagged"]), len(result["fixed"]))
    return report


# ----- database -----

def db_call(what: str, fn):
    for attempt in range(1, MAX_RETRIES + 3):
        try:
            return fn()
        except httpx.TransportError as exc:
            if attempt == MAX_RETRIES + 2:
                raise
            log.warning("%s: network error (%s), retrying in %ss", what, exc, 5 * attempt)
            time.sleep(5 * attempt)
    raise AssertionError("unreachable")


def replace_rows(db, table: str, vid: str, rows: list[dict]) -> None:
    """Delete an episode's rows and insert them again, so a half-finished earlier write is redone."""
    db_call(f"{table} delete", lambda: db.table(table).delete().eq("video_id", vid).execute())
    for i in range(0, len(rows), DB_BATCH):
        batch = rows[i:i + DB_BATCH]
        db_call(f"{table} insert", lambda: db.table(table).insert(batch).execute())


def supabase_client():
    url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        sys.exit("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in .env")
    return create_client(url, key)


def finished(state: dict) -> bool:
    """Segments written and, for a Hindi episode, its translation too."""
    return bool(state["db_segments"]) and (state["language"] != "hi" or bool(state["db_translation"]))


def db_step(states: dict[str, dict], on_episode=None) -> None:
    """Step 5: segments and translation lines into Supabase, then episodes.status = 'transcribed'."""
    db = supabase_client()
    for state in states.values():
        vid = state["video_id"]
        was_finished = finished(state)
        ready = state["segments"] and (state["romanized"] or state["language"] != "hi"
                                       or state["source"] != "youtube_auto")
        if ready and not state["db_segments"]:
            rows = [{"video_id": vid, "seq": s["seq"], "start_s": s["start"], "end_s": s["end"], "speaker": "unknown",
                     "text_original": s["text_original"], "text_roman": s["text_roman"], "source": state["source"]}
                    for s in state["segments"]]
            replace_rows(db, "segments", vid, rows)
            db_call("episodes update", lambda: db.table("episodes").update(
                {"caption_language": state["language"], "status": "transcribed"}).eq("video_id", vid).execute())
            state["db_segments"] = True
            save_state(state)
            log.info("%s: %s segments written, status transcribed", vid, len(rows))
        if state["translation"] == "ok" and not state["db_translation"]:
            rows = [{"video_id": vid, "start_s": s["start"], "end_s": s["end"], "text": s["text"]}
                    for s in state["translation_segments"]]
            replace_rows(db, "translation_segments", vid, rows)
            state["db_translation"] = True
            save_state(state)
            log.info("%s: %s translation lines written", vid, len(rows))
        if on_episode and finished(state) and not was_finished:
            on_episode(state, "done")


# ----- summary -----

def costs(states: list[dict]) -> dict[str, float]:
    totals = {"Haiku romanization (USD)": sum(s["roman_cost_usd"] for s in states),
              "Haiku translation (USD)": sum(s.get("translation_cost_usd", 0.0)
                                             + s.get("earlier_translation_cost_usd", 0.0) for s in states),
              "Groq (USD)": 0.0, "Sarvam (INR)": 0.0}
    for s in states:
        if s["audio_cost"]:
            label = "Groq (USD)" if s["source"] == "groq" else "Sarvam (INR)"
            totals[label] += s["audio_cost"]["amount"]
    return totals


def print_transcribe_summary(which: str, episodes: list[dict], states: dict[str, dict], before: dict[str, float],
                             failed: list[str], translated: dict) -> None:
    done = [states[ep["video_id"]] for ep in episodes if ep["video_id"] in states]

    def tally(key: str) -> str:
        counts: dict[str, int] = {}
        for s in done:
            counts[s[key] or "?"] = counts.get(s[key] or "?", 0) + 1
        return ", ".join(f"{k} {v}" for k, v in sorted(counts.items()))

    romanized = [s for s in done if s["romanized"]]
    print()
    print(f"Set {which}: {len(episodes)} episodes, {len(done)} looked at, "
          f"{sum(s['db_segments'] for s in done)} written to the database")
    print(f"Episodes per language: {tally('language')}")
    print(f"Episodes per source:   {tally('source')}")
    for s in done:
        if s["fallback_reason"]:
            print(f"    {s['video_id']} -> {s['source']}: {s['fallback_reason']}")
    suspects = [s for s in done if s["suspect"]]
    print(f"Suspect (English track under {SUSPECT_WORDS_PER_MINUTE} words/min): {len(suspects)}")
    for s in suspects:
        print(f"    {s['video_id']}  {s['words_per_minute']} words/min  {s['title'][:80]}")
    print(f"Lines romanized:       {sum(len(s['segments']) for s in romanized):,} in {len(romanized)} Hindi episodes")
    print(f"Flagged lines (kept in Devanagari): {sum(len(s['flagged_seqs']) for s in romanized)}")
    for s in romanized:
        if s["flagged_seqs"]:
            print(f"    {s['video_id']}: seq {', '.join(map(str, s['flagged_seqs']))}")
    translations = {}
    for s in done:
        if s["language"] == "hi":
            translations[s["translation"]] = translations.get(s["translation"], 0) + 1
    print(f"English translations (Hindi episodes, all runs): "
          + (", ".join(f"{k} {v}" for k, v in sorted(translations.items())) or "none"))
    print(f"Translated this run:   {translated['lines']:,} lines in {translated['episodes']} episodes")
    print(f"Length check: {translated['flagged']} lines flagged, {translated['fixed']} fixed on their own retry, "
          f"{len(translated['still_flagged'])} still off")
    for failed_id in translated["still_flagged"]:
        print(f"    still off: {failed_id}")
    print(f"Lines with no translation: {len(translated['failed_lines'])}")
    for failed_id in translated["failed_lines"]:
        print(f"    {failed_id}")
    after = costs(done)
    print("Cost, these episodes (all runs):  " + ", ".join(f"{k} {v:.4f}" for k, v in after.items()))
    print("Cost, this run:                   " + ", ".join(f"{k} {after[k] - before.get(k, 0.0):.4f}" for k in after))
    not_done = [ep["video_id"] for ep in episodes if not (states.get(ep["video_id"]) or {}).get("db_segments")]
    if not_done:
        print(f"Not finished, rerun to continue: {', '.join(not_done)}")
    if failed:
        print("Problems:")
        for f in failed:
            print(f"    {f}")


# ----- full-run support: skipping, progress, cost guard, dry run -----

class CostCapReached(RuntimeError):
    """This run's cost would pass the cap."""


def episode_status() -> dict[str, dict]:
    """episodes.status and caption_language per video_id (read only)."""
    db, rows, start = supabase_client(), [], 0
    while True:
        page = db_call("episodes select", lambda: db.table("episodes").select(
            "video_id,status,caption_language").order("video_id").range(start, start + 999).execute()).data
        rows += page
        if len(page) < 1000:
            return {r["video_id"]: r for r in rows}
        start += 1000


def not_skipped(episodes: list[dict], status: dict[str, dict]) -> list[dict]:
    """Episodes without status skipped (see SKIPPED_PATH for why an episode was skipped)."""
    return [ep for ep in episodes if (status.get(ep["video_id"]) or {}).get("status") != "skipped"]


def already_done(episode: dict, status: dict[str, dict], state: dict | None) -> bool:
    """Marked transcribed in the database, unless its own state says a translation is still to be written."""
    if (status.get(episode["video_id"]) or {}).get("status") != "transcribed":
        return False
    return state is None or finished(state)


def haiku_line_rates(states: list[dict]) -> dict[str, float]:
    """USD per Hindi caption line for romanization and translation, from episodes already done."""
    rom = [s for s in states if s["language"] == "hi" and s["source"] == "youtube_auto" and s["romanized"]]
    tra = [s for s in states if s["language"] == "hi" and s.get("translation") == "ok"]
    rom_lines, tra_lines = sum(len(s["segments"]) for s in rom), sum(len(s["segments"]) for s in tra)
    # Sarvam lines are far longer than caption lines, so their translation is priced per hour.
    sarvam = [s for s in tra if s["source"] == "sarvam"]
    sarvam_hours = sum(s["duration_seconds"] for s in sarvam) / 3600
    caption_hours = sum(s["duration_seconds"] for s in tra if s["source"] == "youtube_auto") / 3600
    caption_per_hour = (sum(s.get("translation_cost_usd") or 0.0 for s in tra if s["source"] == "youtube_auto")
                        / caption_hours if caption_hours else 0.03)
    return {"roman": sum(s["roman_cost_usd"] for s in rom) / rom_lines if rom_lines else DEFAULT_LINE_USD["roman"],
            "translation": (sum(s.get("translation_cost_usd") or 0.0 for s in tra) / tra_lines
                            if tra_lines else DEFAULT_LINE_USD["translation"]),
            "sarvam_translation_hour": (sum(s.get("translation_cost_usd") or 0.0 for s in sarvam) / sarvam_hours
                                        if sarvam_hours else caption_per_hour)}


def translation_estimate(states: list[dict], rates: dict[str, float]) -> float:
    """USD for the translations still to do: per line for caption episodes, per hour for audio-fallback ones."""
    usd = 0.0
    for s in states:
        if s["language"] == "hi" and s["translation"] != "ok":
            if s["source"] == "youtube_auto":
                usd += len(s["segments"] or []) * rates["translation"]
            else:
                usd += s["duration_seconds"] / 3600 * rates["sarvam_translation_hour"]
    return usd


def run_cost(states: dict[str, dict], before: dict[str, float]) -> tuple[float, float]:
    """This run's cost so far, as (USD, INR) with INR_PER_USD."""
    after = costs(list(states.values()))
    spent = {k: after[k] - before.get(k, 0.0) for k in after}
    inr = sum(v * INR_PER_USD for k, v in spent.items() if "(USD)" in k) + spent["Sarvam (INR)"]
    return inr / INR_PER_USD, inr


class Progress:
    """One line per episode event in PROGRESS_LOG, and the cost guard."""

    def __init__(self, which: str, total: int, done_before: int, states: dict[str, dict], before: dict[str, float],
                 max_inr: float):
        self.which, self.total, self.done_before = which, total, done_before
        self.states, self.before, self.max_inr = states, before, max_inr
        self.finished_now, self.start = 0, time.time()
        self.romanized_before = {vid for vid, s in states.items() if s["romanized"]}
        PROGRESS_LOG.parent.mkdir(parents=True, exist_ok=True)

    def write(self, text: str) -> None:
        line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} | {text}"
        with PROGRESS_LOG.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
        log.info("progress: %s", text)

    def status(self) -> str:
        done = self.done_before + self.finished_now
        left = self.total - done
        romanized = [s for vid, s in self.states.items() if s["romanized"] and vid not in self.romanized_before]
        usd, inr = run_cost(self.states, self.before)
        per_episode = (time.time() - self.start) / self.finished_now if self.finished_now else SECONDS_PER_EPISODE
        return (f"done {done}/{self.total}, remaining {left} | romanized {sum(len(s['segments']) for s in romanized):,} "
                f"lines, rejected {sum(len(s['flagged_seqs']) for s in romanized)} | cost this run ${usd:.2f} = "
                f"INR {inr:,.0f} | est. left {left * per_episode / 3600:.1f} h")

    def episode(self, state: dict, event: str) -> None:
        if event == "done":
            self.finished_now += 1
        self.write(f"{state['video_id']} {event}: {state['source']} {state['language']} | {self.status()}")

    def check(self, step: str, estimate_usd: float = 0.0, estimate_inr: float = 0.0) -> None:
        """Raise CostCapReached if spent so far, plus COST_MARGIN x the next step's estimate, passes the cap."""
        _, spent = run_cost(self.states, self.before)
        projected = spent + COST_MARGIN * (estimate_usd * INR_PER_USD + estimate_inr)
        if spent > self.max_inr or projected > self.max_inr:
            message = (f"COST GUARD: stopped before {step}. This run has spent INR {spent:,.0f}"
                       + (f"; {step} is estimated at INR {estimate_usd * INR_PER_USD + estimate_inr:,.0f} "
                          f"(x{COST_MARGIN} margin)" if projected > spent else "")
                       + f", over the cap of INR {self.max_inr:,.0f}. Finished episodes are saved; rerun the same "
                         f"command to continue (the cap counts per run), or pass --max-inr to raise it.")
            self.write(message + " | " + self.status())
            raise CostCapReached(message)


def audio_estimate(states: list[dict]) -> tuple[float, float]:
    """(USD, INR) for the fallback episodes still to transcribe from audio."""
    todo = [s for s in states if s["source"] in ("groq", "sarvam") and s["segments"] is None]
    if not todo:
        return 0.0, 0.0
    services = load_module("04_bakeoff.py").SERVICES
    hours = {src: sum(s["duration_seconds"] for s in todo if s["source"] == src) / 3600 for src in ("groq", "sarvam")}
    return (hours["groq"] * services["groq_large"]["price_per_hour"],
            hours["sarvam"] * services["sarvam_translit"]["price_per_hour"])


def merge_reports(total: dict | None, part: dict) -> dict:
    if total is None:
        return part
    return {k: total[k] + part[k] for k in total}


def plan_episode(state: dict, rates: dict[str, float], services: dict) -> dict:
    """What a run will do for an episode that already has a state, with its estimated cost."""
    vid, hours = state["video_id"], state["duration_seconds"] / 3600
    plan = {"steps": [], "usd": 0.0, "inr": 0.0, "sarvam_pieces": 0, "download": False}
    if state["source"] in ("groq", "sarvam") and state["segments"] is None:
        manifest = AUDIO_DIR / vid / "manifest.json"
        if manifest.exists():
            names = [p["file"] for p in json.loads(manifest.read_text(encoding="utf-8"))["pieces"]]
        else:
            plan["download"] = True
            plan["steps"].append("audio download")
            names = [str(n) for n in range(-(-int(state["duration_seconds"]) // 600))]
        if state["source"] == "sarvam":
            pending = [n for n in names if not (AUDIO_RESULTS_DIR / vid / f"{n}.sarvam.json").exists()]
            plan["sarvam_pieces"] = len(pending)
            plan["steps"].append(f"Sarvam hi ({len(pending)} pieces)")
            plan["inr"] += hours * services["sarvam_translit"]["price_per_hour"]
        else:
            plan["steps"].append("Groq en")
            plan["usd"] += hours * services["groq_large"]["price_per_hour"]
    if state["language"] == "hi" and state["source"] == "youtube_auto" and state["segments"] and not state["romanized"]:
        chunks = roman_chunks(state)
        todo = [c for c in chunks if not romanize_lib.chunk_done(roman_chunk_path(c))]
        plan["steps"].append(f"Haiku romanization ({len(todo)} of {len(chunks)} chunks)")
        plan["usd"] += sum(len(chunks[c]) for c in todo) * rates["roman"]
    if state["language"] == "hi" and state["translation"] != "ok":
        plan["steps"].append("Haiku translation")
        plan["usd"] += translation_estimate([{**state, "translation": "pending"}], rates)
    if not finished(state):
        plan["steps"].append("database write")
    return plan


def dry_run(which: str, max_inr: float) -> None:
    """Prints what a run would do. Reads the episode list, local state files and episodes in Supabase; writes nothing."""
    status = episode_status()
    all_episodes = read_episodes(which)
    episodes = not_skipped(all_episodes, status)
    known = {ep["video_id"]: s for ep in episodes if (s := load_state(ep["video_id"]))}
    left_all = [ep for ep in episodes if not already_done(ep, status, known.get(ep["video_id"]))]
    services = load_module("04_bakeoff.py").SERVICES
    rates = haiku_line_rates([s for s in known.values() if finished(s)])

    print(f"DRY RUN, set {which}: nothing is downloaded, sent or written (except this run's log in {LOGS_DIR}).")
    print(f"Episodes in set:        {len(all_episodes)}")
    print(f"Skipped (status):       {len(all_episodes) - len(episodes)}"
          + "".join(f"\n    {ep['video_id']}: {skipped_note(ep['video_id'])}" for ep in all_episodes
                    if ep not in episodes))
    print(f"Already transcribed:    {len(episodes) - len(left_all)}")
    print(f"Left to do:             {len(left_all)}")

    started = [ep for ep in left_all if ep["video_id"] in known]
    if started:
        plans = {ep["video_id"]: plan_episode(known[ep["video_id"]], rates, services) for ep in started}
        print(f"\nEpisodes already started ({len(started)}), and what the run does for each:")
        print(f"  {'video_id':12} {'min':>5}  {'language/source':16} {'est. USD':>8} {'est. INR':>8}  steps")
        for ep in started:
            s, pl = known[ep["video_id"]], plans[ep["video_id"]]
            print(f"  {ep['video_id']:12} {s['duration_seconds'] / 60:5.1f}  {s['language'] + ' ' + s['source']:16} "
                  f"{pl['usd']:8.3f} {pl['inr']:8.1f}  {', '.join(pl['steps'])}")
        usd = sum(pl["usd"] for pl in plans.values())
        inr = sum(pl["inr"] for pl in plans.values())
        pieces = sum(pl["sarvam_pieces"] for pl in plans.values())
        jobs = -(-pieces // SARVAM_MAX_PIECES)
        downloads = sum(pl["download"] for pl in plans.values())
        print(f"  Cost: Haiku and Groq ${usd:.2f} = INR {usd * INR_PER_USD:,.0f}; Sarvam INR {inr:,.0f}; "
              f"total INR {usd * INR_PER_USD + inr:,.0f} (${usd + inr / INR_PER_USD:.2f}); cost guard INR {max_inr:,.0f}")
        sarvam_t = [jobs * m / 60 for m in SARVAM_JOB_MINUTES]
        dl_t = [downloads * m / 60 for m in FALLBACK_MINUTES]
        groups = -(-len(left_all) // GROUP_SIZE)
        batch_t = [groups * BATCHES_PER_GROUP * m / 60 for m in BATCH_MINUTES]
        print(f"  Time: Sarvam {pieces} pieces in {jobs} jobs of at most {SARVAM_MAX_PIECES}, "
              f"{sarvam_t[0]:.1f}-{sarvam_t[1]:.1f} h (assumed {SARVAM_JOB_MINUTES[0]}-{SARVAM_JOB_MINUTES[1]} min a job); "
              f"audio downloads {downloads}, {dl_t[0]:.1f}-{dl_t[1]:.1f} h; Haiku batches {batch_t[0]:.1f}-{batch_t[1]:.1f} h; "
              f"total about {sarvam_t[0] + dl_t[0] + batch_t[0]:.1f}-{sarvam_t[1] + dl_t[1] + batch_t[1]:.1f} h")
    left = [ep for ep in left_all if ep["video_id"] not in known]
    if not left:
        return
    print(f"\nEpisodes not started yet ({len(left)}): their captions decide the language and service.")
    by_lang: dict[str, list[dict]] = {"hi": [], "en": [], "unknown": []}
    for ep in left:
        lang = (status.get(ep["video_id"]) or {}).get("caption_language")
        by_lang[lang if lang in ("hi", "en") else "unknown"].append(ep)
    hours = {k: sum(float(ep["duration_seconds"]) for ep in v) / 3600 for k, v in by_lang.items()}

    # Rates and the language check from the episodes already done.
    done = [s for s in known.values() if finished(s)]
    hindi = [s for s in done if s["language"] == "hi" and s["source"] == "youtube_auto"]
    hindi_hours = sum(s["duration_seconds"] for s in hindi) / 3600
    roman_per_hour = sum(s["roman_cost_usd"] for s in hindi) / hindi_hours if hindi_hours else 0.0
    trans_per_hour = sum(s.get("translation_cost_usd") or 0.0 for s in hindi) / hindi_hours if hindi_hours else 0.0
    csv_tag = {ep["video_id"]: csv_language(ep) or "unknown" for ep in episodes}
    hi_share = {}
    for tag in by_lang:
        tagged = [s for s in done if csv_tag[s["video_id"]] == tag]
        hi_share[tag] = (sum(s["language"] == "hi" for s in tagged) / len(tagged)) if tagged else None
    fallback_share = sum(s["source"] in ("groq", "sarvam") for s in done) / len(done) if done else 0.0
    sarvam_inr_h = services["sarvam_translit"]["price_per_hour"]

    def haiku(hi_hours: float) -> float:
        return hi_hours * (roman_per_hour + trans_per_hour)

    as_tagged = hours["hi"]
    calibrated = sum(hours[t] * (hi_share[t] if hi_share[t] is not None else (1.0 if t == "hi" else 0.5))
                     for t in by_lang)
    fallback_n = len(left) * fallback_share
    fallback_inr = fallback_share * sum(hours.values()) * sarvam_inr_h  # priced as Sarvam, the dearer one
    groups = -(-len(left) // GROUP_SIZE)
    yt = [len(left) * s / 3600 for s in EPISODE_PAUSE_SECONDS]
    batch = [groups * BATCHES_PER_GROUP * m / 60 for m in BATCH_MINUTES]
    audio = [fallback_n * m / 60 for m in FALLBACK_MINUTES]

    print(f"Not started:            {len(left)}, {sum(hours.values()):.1f} hours of video")
    print(f"By caption_language:    Hindi {len(by_lang['hi'])} ({hours['hi']:.1f} h), English {len(by_lang['en'])} "
          f"({hours['en']:.1f} h), not set {len(by_lang['unknown'])} ({hours['unknown']:.1f} h)")
    print("  caption_language is YouTube's metadata until an episode is transcribed. On the done episodes it was:")
    for tag in by_lang:
        tagged = [s for s in done if csv_tag[s["video_id"]] == tag]
        if tagged:
            print(f"    tagged {tag}: {len(tagged)} episodes, {sum(s['language'] == 'hi' for s in tagged)} actually Hindi")
    print(f"Haiku rates (done episodes): romanization ${roman_per_hour:.4f}, translation ${trans_per_hour:.4f} "
          f"per Hindi hour")
    for label, hi_h in (("if caption_language is right", as_tagged),
                        ("corrected by the done episodes (not set: half Hindi)", calibrated)):
        usd = haiku(hi_h)
        print(f"Estimated Haiku cost, {label}: {hi_h:.0f} Hindi hours -> ${usd:.2f} = INR {usd * INR_PER_USD:,.0f}")
    print(f"Audio fallback: about {fallback_n:.0f} episodes ({fallback_share:.0%} of the done ones), "
          f"up to INR {fallback_inr:,.0f}")
    worst = haiku(calibrated) * INR_PER_USD + fallback_inr
    print(f"Estimated total this run: up to INR {worst:,.0f} (${worst / INR_PER_USD:.2f}); cost guard at "
          f"INR {max_inr:,.0f}")
    if worst > max_inr:
        print(f"  The estimate is above the guard: expect the run to stop partway; rerun to continue, "
              f"or pass --max-inr.")
    print(f"Estimated time: YouTube {yt[0]:.1f}-{yt[1]:.1f} h ({len(left)} episodes at "
          f"{EPISODE_PAUSE_SECONDS[0]}-{EPISODE_PAUSE_SECONDS[1]} s), batch waiting {batch[0]:.1f}-{batch[1]:.1f} h "
          f"({groups} groups of {GROUP_SIZE} x {BATCHES_PER_GROUP} batches at {BATCH_MINUTES[0]}-{BATCH_MINUTES[1]} "
          f"min), audio fallback {audio[0]:.1f}-{audio[1]:.1f} h")
    print(f"  Total: about {yt[0] + batch[0] + audio[0]:.0f}-{yt[1] + batch[1] + audio[1]:.0f} h, more if YouTube "
          f"answers 429 and the run has to be restarted later.")


def read_skipped() -> dict[str, dict]:
    return json.loads(SKIPPED_PATH.read_text(encoding="utf-8")) if SKIPPED_PATH.exists() else {}


def skipped_note(vid: str) -> str:
    return (read_skipped().get(vid) or {}).get("note", "no note")


def backup_state(vid: str) -> Path:
    STATE_BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    backup = STATE_BACKUP_DIR / f"{time.strftime('%Y%m%d-%H%M%S')}-{vid}.json"
    backup.write_text(state_path(vid).read_text(encoding="utf-8"), encoding="utf-8")
    return backup


def cmd_reset_to_sarvam(video_ids: list[str], reason: str) -> None:
    """Redo episodes with Sarvam (Hindi) plus the normal Haiku translation.

    Prints each episode's segments and translation_segments rows, deletes them, saves a copy of
    its state file in STATE_BACKUP_DIR and resets the state to a pending Sarvam episode, and sets
    episodes.caption_language = 'hi' and status = 'listed' so the next transcribe run picks it up.
    """
    load_dotenv(ROOT / ".env")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    db = supabase_client()
    states = {}
    for vid in video_ids:
        state = load_state(vid)
        if state is None:
            sys.exit(f"{vid}: no state file; nothing to reset")
        states[vid] = state

    def count(table: str, vid: str) -> int:
        return db_call(f"{table} count", lambda: db.table(table).select("id", count="exact").eq(
            "video_id", vid).limit(1).execute()).count

    print(f"{'video_id':12} {'source':12} {'language':8} {'segments':>8} {'translation_segments':>20}")
    before = {vid: (count("segments", vid), count("translation_segments", vid)) for vid in video_ids}
    for vid in video_ids:
        print(f"{vid:12} {states[vid]['source']:12} {states[vid]['language']:8} {before[vid][0]:8,} {before[vid][1]:20,}")
    for vid, state in states.items():
        backup = backup_state(vid)
        db_call("segments delete", lambda: db.table("segments").delete().eq("video_id", vid).execute())
        db_call("translation delete",
                lambda: db.table("translation_segments").delete().eq("video_id", vid).execute())
        earlier = [c for c in [*state.get("earlier_audio_costs", []), state["audio_cost"]] if c]
        state.update({"language": "hi", "source": "sarvam", "fallback_reason": reason, "suspect": False,
                      "words_per_minute": None, "segments": None, "romanized": False, "flagged_seqs": [],
                      "roman_cost_usd": 0.0, "translation": "n/a", "translation_segments": None,
                      "translation_cost_usd": 0.0, "audio_cost": None, "earlier_audio_costs": earlier,
                      "db_segments": False, "db_translation": False})
        save_state(state)
        db_call("episodes update", lambda: db.table("episodes").update(
            {"caption_language": "hi", "status": "listed"}).eq("video_id", vid).execute())
        after = (count("segments", vid), count("translation_segments", vid))
        log.info("%s: deleted %s segments and %s translation rows (now %s and %s); state reset to sarvam hi, "
                 "old state kept in %s", vid, before[vid][0], before[vid][1], after[0], after[1], backup.name)


def cmd_skip(video_ids: list[str], note: str) -> None:
    """Set episodes.status = 'skipped' (transcribe --set all then leaves them out) and record why in SKIPPED_PATH."""
    load_dotenv(ROOT / ".env")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    db = supabase_client()
    skipped = read_skipped()
    for vid in video_ids:
        db_call("episodes update", lambda: db.table("episodes").update({"status": "skipped"}).eq(
            "video_id", vid).execute())
        skipped[vid] = {"note": note, "date": time.strftime("%Y-%m-%d")}
        log.info("%s: status skipped (%s)", vid, note)
    SKIPPED_PATH.write_text(json.dumps(skipped, indent=2, ensure_ascii=False), encoding="utf-8")


def cmd_transcribe(which: str, redo_translations_first: bool = False, dry: bool = False,
                   max_inr: float = MAX_RUN_INR) -> None:
    load_dotenv(ROOT / ".env")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    if dry:
        dry_run(which, max_inr)
        return
    CAPTIONS_DIR.mkdir(parents=True, exist_ok=True)
    TRANSCRIPTS_DIR.mkdir(parents=True, exist_ok=True)
    status = episode_status()
    episodes = not_skipped(read_episodes(which), status)
    known = {ep["video_id"]: s for ep in episodes if (s := load_state(ep["video_id"]))}
    rates = haiku_line_rates([s for s in known.values() if finished(s)])
    if redo_translations_first:
        todo_eps = episodes
    else:
        todo_eps = [ep for ep in episodes if not already_done(ep, status, known.get(ep["video_id"]))]
    states = {ep["video_id"]: known[ep["video_id"]] for ep in todo_eps if ep["video_id"] in known}
    before = costs(list(states.values()))
    failed: list[str] = []
    log.info("%s episodes in set %s, %s already transcribed (skipped), %s to do, %s already started",
             len(episodes), which, len(episodes) - len(todo_eps), len(todo_eps), len(states))
    progress = Progress(which, len(episodes), len(episodes) - len(todo_eps), states, before, max_inr)
    progress.write(f"run started: set {which}, {len(todo_eps)} episodes to do, cost guard INR {max_inr:,.0f} | "
                   + progress.status())

    if redo_translations_first:
        redo_translations(states)
    translated, stopped = None, None
    try:
        for n in range(0, len(todo_eps), GROUP_SIZE):
            group = todo_eps[n:n + GROUP_SIZE]
            progress.check(f"group {n // GROUP_SIZE + 1}")
            log.info("Group %s of %s: %s episodes", n // GROUP_SIZE + 1, -(-len(todo_eps) // GROUP_SIZE), len(group))
            refused = youtube_step(group, states, failed, progress.episode)
            group_states = {ep["video_id"]: states[ep["video_id"]] for ep in group if ep["video_id"] in states}
            usd, inr = audio_estimate(list(group_states.values()))
            progress.check("the audio fallback", usd, inr)
            audio_step(group, states, failed)
            lines = sum(len(s["segments"]) for s in group_states.values() if s["language"] == "hi"
                        and s["source"] == "youtube_auto" and s["segments"] and not s["romanized"])
            progress.check("romanization", lines * rates["roman"])
            romanize_step(group_states)
            progress.check("translation", translation_estimate(list(group_states.values()), rates))
            translated = merge_reports(translated, translate_step(group_states, failed))
            db_step(group_states, progress.episode)
            if refused:
                stopped = "YouTube kept answering 429; rerun later to continue"
                progress.write(f"stopped: {stopped} | {progress.status()}")
                break
        else:
            progress.write("run finished | " + progress.status())
    except CostCapReached as exc:
        stopped = str(exc)
    translated = translated or {"episodes": 0, "lines": 0, "flagged": 0, "fixed": 0, "still_flagged": [],
                                "failed_lines": []}
    print_transcribe_summary(which, todo_eps, states, before, failed, translated)
    if stopped:
        sys.exit(f"\n{stopped}")


class Tee:
    """Writes to the console and to the run's log file."""

    def __init__(self, stream, log_file):
        self.stream, self.log_file = stream, log_file

    def write(self, text: str) -> int:
        self.log_file.write(text)
        self.log_file.flush()
        return self.stream.write(text)

    def flush(self) -> None:
        self.stream.flush()
        self.log_file.flush()

    def __getattr__(self, name):
        return getattr(self.stream, name)


def log_console() -> Path:
    """Copies all console output (prints, log lines, tracebacks) to LOGS_DIR/captions_<timestamp>.log."""
    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    path = LOGS_DIR / f"captions_{time.strftime('%Y%m%d-%H%M%S')}.log"
    log_file = path.open("a", encoding="utf-8")
    sys.stdout = Tee(sys.stdout, log_file)
    sys.stderr = Tee(sys.stderr, log_file)
    return path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    p_list = sub.add_parser("list", help="list caption tracks per episode (no downloading)")
    p_list.add_argument("--set", choices=SETS, default="bakeoff")
    sub.add_parser("download", help="download uploaded captions for the bake-off episodes")
    sub.add_parser("download-auto", help="download automatic captions (original + English) for the bake-off")
    p_tr = sub.add_parser("transcribe", help="main transcript step: captions, romanization, fallback, database")
    p_tr.add_argument("--set", choices=["test_set", "all"], required=True)
    p_tr.add_argument("--redo-translations", action="store_true",
                      help="delete the set's translation_segments rows and translate again (once; rerun without "
                           "it to resume)")
    p_tr.add_argument("--dry-run", action="store_true",
                      help="change nothing; print episodes left, Hindi vs English, estimated Haiku cost and hours")
    p_tr.add_argument("--max-inr", type=float, default=MAX_RUN_INR,
                      help=f"cost guard: stop once this run's cost would pass this many INR (default {MAX_RUN_INR})")
    p_reset = sub.add_parser("reset-to-sarvam", help="delete episodes' rows and redo them with Sarvam (Hindi)")
    p_reset.add_argument("video_ids", nargs="+")
    p_reset.add_argument("--reason", required=True, help="why, kept in the state file as fallback_reason")
    p_skip = sub.add_parser("skip", help="mark episodes skipped, so transcribe leaves them out")
    p_skip.add_argument("video_ids", nargs="+")
    p_skip.add_argument("--note", required=True, help="why, kept in data/skipped_episodes.json")
    args = parser.parse_args()

    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")  # log lines carry Devanagari
    log_path = log_console()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    log.info("Console output is also written to %s", log_path)

    if args.command == "list":
        cmd_list(args.set)
    elif args.command == "download":
        cmd_download()
    elif args.command == "download-auto":
        cmd_download_auto()
    elif args.command == "reset-to-sarvam":
        cmd_reset_to_sarvam(args.video_ids, args.reason)
    elif args.command == "skip":
        cmd_skip(args.video_ids, args.note)
    else:
        cmd_transcribe(args.set, args.redo_translations, args.dry_run, args.max_inr)


if __name__ == "__main__":
    main()
