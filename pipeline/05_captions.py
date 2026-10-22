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

Safe to rerun: episodes already in subs_index.csv are skipped, as are tracks
already downloaded. Network errors are retried; episodes that still fail are
recorded with an error and retried on the next run.

Usage:
    .venv\\Scripts\\python.exe pipeline\\05_captions.py list [--set bakeoff|test_set|all]
    .venv\\Scripts\\python.exe pipeline\\05_captions.py download
    .venv\\Scripts\\python.exe pipeline\\05_captions.py download-auto
"""

import argparse
import csv
import json
import logging
import sys
import time
from pathlib import Path

import yt_dlp

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


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    p_list = sub.add_parser("list", help="list caption tracks per episode (no downloading)")
    p_list.add_argument("--set", choices=SETS, default="bakeoff")
    sub.add_parser("download", help="download uploaded captions for the bake-off episodes")
    sub.add_parser("download-auto", help="download automatic captions (original + English) for the bake-off")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    if args.command == "list":
        cmd_list(args.set)
    elif args.command == "download":
        cmd_download()
    else:
        cmd_download_auto()


if __name__ == "__main__":
    main()
