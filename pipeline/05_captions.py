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
            English-track episodes averaging under 100 words per minute are listed
            as suspect (Hindi speech may have been heard as English); they are not
            reprocessed.

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
"""

import argparse
import csv
import importlib.util
import json
import logging
import os
import random
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
SARVAM_JOB_PATH = TRANSCRIPTS_DIR / "sarvam_job.json"
AUDIO_RESULTS_DIR = TRANSCRIPTS_DIR / "audio"

MIN_COVERAGE = 0.80
SUSPECT_WORDS_PER_MINUTE = 100
EPISODE_PAUSE_SECONDS = (20, 40)
YOUTUBE_RETRIES = 3
BACKOFF_429_SECONDS = 180  # wait before retry n is n times this
ROMAN_CHUNK_LINES = 60
ROMAN_ROUNDS = 3  # batches per run; later rounds resend only chunks that failed
DB_BATCH = 500

FALLBACK = {"en": "groq", "hi": "sarvam"}
GROQ_MODEL = "whisper-large-v3"
SARVAM_PARAMS = {"model": "saaras:v4", "mode": "translit", "language_code": "unknown", "with_timestamps": True}


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


def decide_from_track(state: dict, episode: dict, track: Path | None) -> None:
    """Sets language, source and (for caption episodes) segments from the downloaded original track."""
    vid = state["video_id"]
    lang = track.name[len(vid) + 1:-len("-orig.json3")].split("-")[0] if track else None
    state["track"] = track.name if track else None
    if lang in ("en", "hi"):
        state["language"] = lang
        segments = phrase_segments(track)
        state["coverage"] = round(coverage(segments, state["duration_seconds"]), 3)
        if state["coverage"] >= MIN_COVERAGE:
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
    else:
        # No usable track: guess the language for the audio model from the episode metadata.
        state["language"] = csv_language(episode) or "en"
        state["fallback_reason"] = (f"original track is {track.name}, not Hindi or English" if track
                                    else "no automatic captions")
    state["source"] = FALLBACK[state["language"]]
    log.warning("%s: %s; falling back to %s (%s)", vid, state["fallback_reason"], state["source"],
                state["language"])


def youtube_step(episodes: list[dict], states: dict[str, dict], failed: list[str]) -> None:
    """Steps 1-3: original track, language and segments."""
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
                return
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


def transcribe_sarvam_episodes(states: list[dict], bakeoff, key: str) -> None:
    """One Sarvam batch job for every piece of every Hindi fallback episode."""
    pieces = {}  # Sarvam file name -> (state, piece)
    for state in states:
        manifest = json.loads((AUDIO_DIR / state["video_id"] / "manifest.json").read_text(encoding="utf-8"))
        for piece in manifest["pieces"]:
            pieces[f"{state['video_id']}__{piece['file']}"] = (state, piece)
    job = json.loads(SARVAM_JOB_PATH.read_text(encoding="utf-8")) if SARVAM_JOB_PATH.exists() else None
    if job and (job.get("collected") or not set(pieces) <= set(job["files"])):
        job = None
    if job is None:
        created = bakeoff.sarvam_request("POST", bakeoff.SARVAM_BASE, key, json={"job_parameters": SARVAM_PARAMS})
        job = {"job_id": created["job_id"], "files": sorted(pieces), "uploaded": False, "started": False}
        SARVAM_JOB_PATH.write_text(json.dumps(job, indent=2), encoding="utf-8")
        log.info("Sarvam job %s created for %s pieces", job["job_id"], len(pieces))
    if not job["uploaded"]:
        resp = bakeoff.sarvam_request("POST", f"{bakeoff.SARVAM_BASE}/upload-files", key,
                                      json={"job_id": job["job_id"], "files": job["files"]})
        azure = resp.get("storage_container_type", "").startswith("Azure")
        for name in job["files"]:
            state, piece = pieces[name]
            headers = {"Content-Type": "audio/mpeg"} | ({"x-ms-blob-type": "BlockBlob"} if azure else {})
            data = (AUDIO_DIR / state["video_id"] / piece["file"]).read_bytes()
            bakeoff.storage_request("PUT", resp["upload_urls"][name]["file_url"], data=data, headers=headers)
        job["uploaded"] = True
        SARVAM_JOB_PATH.write_text(json.dumps(job, indent=2), encoding="utf-8")
    if not job["started"]:
        bakeoff.sarvam_request("POST", f"{bakeoff.SARVAM_BASE}/{job['job_id']}/start", key)
        job["started"] = True
        SARVAM_JOB_PATH.write_text(json.dumps(job, indent=2), encoding="utf-8")
    status = bakeoff.wait_for_sarvam(key, job)
    outputs = {d["inputs"][0]["file_name"]: d["outputs"][0]["file_name"]
               for d in status.get("job_details") or [] if d.get("state") == "Success"}
    links = bakeoff.sarvam_request("POST", f"{bakeoff.SARVAM_BASE}/download-files", key,
                                   json={"job_id": job["job_id"], "files": list(outputs.values())})
    for name, out_name in outputs.items():
        state, piece = pieces[name]
        out = AUDIO_RESULTS_DIR / state["video_id"] / f"{piece['file']}.sarvam.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        if not out.exists():
            raw = bakeoff.storage_request("GET", links["download_urls"][out_name]["file_url"]).json()
            out.write_text(json.dumps(raw, ensure_ascii=False), encoding="utf-8")
    job["collected"] = True
    SARVAM_JOB_PATH.write_text(json.dumps(job, indent=2), encoding="utf-8")

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
            transcribe_sarvam_episodes(sarvam_states, bakeoff, os.environ["SARVAM_API_KEY"])
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


def romanize_step(states: dict[str, dict]) -> float:
    """Step 4 for Hindi caption episodes. Returns what this run spent."""
    todo = [s for s in states.values()
            if s["language"] == "hi" and s["source"] == "youtube_auto" and s["segments"] and not s["romanized"]]
    if not todo:
        return 0.0
    if not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit("ANTHROPIC_API_KEY must be set in .env for romanization")
    ROMAN_CHUNK_DIR.mkdir(parents=True, exist_ok=True)
    chunks = {s["video_id"]: roman_chunks(s) for s in todo}
    all_paths = [roman_chunk_path(c) for cs in chunks.values() for c in cs]
    spent_before = sum(romanize_lib.chunk_cost(p) for p in all_paths)
    client = anthropic.Anthropic(max_retries=MAX_RETRIES + 2)
    for round_no in range(1, ROMAN_ROUNDS + 1):
        requests, expected = {}, {}
        for state in todo:
            guest = romanize_lib.guess_guest(state["title"])
            for chunk_id, lines in chunks[state["video_id"]].items():
                if not romanize_lib.chunk_done(roman_chunk_path(chunk_id)):
                    requests[chunk_id] = romanize_lib.build_request(chunk_id, lines, state["title"], guest)
                    expected[chunk_id] = [l["id"] for l in lines]
        if not requests:
            break
        log.info("Romanization round %s: %s chunks for %s episodes", round_no, len(requests), len(todo))
        romanize_lib.run_batch(client, requests, expected, ROMAN_JOB_PATH, ROMAN_CHUNK_DIR)

    for state in todo:
        vid, ids = state["video_id"], list(chunks[state["video_id"]])
        if not all(romanize_lib.chunk_done(roman_chunk_path(c)) for c in ids):
            log.error("%s: some romanization chunks still incomplete; rerun to resend them", vid)
            continue
        converted = {}
        for c in ids:
            converted |= romanize_lib.chunk_lines(roman_chunk_path(c))
        flagged = []
        for seg in state["segments"]:
            text = converted[f"{vid}-L{seg['seq']:05d}"].strip()
            if romanize_lib.is_flagged(seg["text_original"], text):
                flagged.append(seg["seq"])
                log.warning("%s seq %s flagged (%s -> %s words), keeping original: %s | %s", vid, seg["seq"],
                            romanize_lib.word_count(seg["text_original"]), romanize_lib.word_count(text),
                            seg["text_original"], text)
                seg["text_roman"] = seg["text_original"]
            else:
                seg["text_roman"] = text
        state["flagged_seqs"] = flagged
        state["roman_cost_usd"] = round(sum(romanize_lib.chunk_cost(roman_chunk_path(c)) for c in ids), 6)
        state["romanized"] = True
        save_state(state)
        log.info("%s: romanized %s lines, %s flagged", vid, len(state["segments"]), len(flagged))
    return sum(romanize_lib.chunk_cost(p) for p in all_paths) - spent_before


# ----- translation -----

def line_id(vid: str, seq: int) -> str:
    return f"{vid}-L{seq:05d}"


def redo_translations(states: dict[str, dict]) -> None:
    """Throw away the set's translations: delete their translation_segments rows and mark them pending.

    The old answers stay on disk but are not reused: the new step keeps its answers in
    TRANSLATION_UNIT_DIR under different names.
    """
    db = supabase_client()
    for state in states.values():
        if state["language"] != "hi" or not state["segments"]:
            continue
        vid = state["video_id"]
        db_call("translation delete", lambda: db.table("translation_segments").delete().eq("video_id", vid).execute())
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


def db_step(states: dict[str, dict]) -> None:
    """Step 5: segments and translation lines into Supabase, then episodes.status = 'transcribed'."""
    db = supabase_client()
    for state in states.values():
        vid = state["video_id"]
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


def cmd_transcribe(which: str, redo_translations_first: bool = False) -> None:
    load_dotenv(ROOT / ".env")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    CAPTIONS_DIR.mkdir(parents=True, exist_ok=True)
    TRANSCRIPTS_DIR.mkdir(parents=True, exist_ok=True)
    episodes = read_episodes(which)
    states = {ep["video_id"]: s for ep in episodes if (s := load_state(ep["video_id"]))}
    before = costs(list(states.values()))
    failed: list[str] = []
    log.info("%s episodes in set %s, %s already started", len(episodes), which, len(states))

    if redo_translations_first:
        redo_translations(states)
    youtube_step(episodes, states, failed)
    audio_step(episodes, states, failed)
    romanize_step(states)
    translated = translate_step(states, failed)
    db_step(states)
    print_transcribe_summary(which, episodes, states, before, failed, translated)


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
    args = parser.parse_args()

    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")  # log lines carry Devanagari
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")

    if args.command == "list":
        cmd_list(args.set)
    elif args.command == "download":
        cmd_download()
    elif args.command == "download-auto":
        cmd_download_auto()
    else:
        cmd_transcribe(args.set, args.redo_translations)


if __name__ == "__main__":
    main()
