"""Download episode audio and split it into 10-minute mono 16 kHz MP3 pieces.

For each episode in the chosen set (from data/candidates.csv):
  1. yt-dlp downloads the best audio-only stream to audio/<video_id>/source.<ext>
  2. ffmpeg converts it to mono 16 kHz MP3 and splits it into part_000.mp3,
     part_001.mp3, ... of 10 minutes each (every piece must be under 25 MB)
  3. audio/<video_id>/manifest.json lists each piece with its start offset
  4. the original download is deleted

Safe to rerun: an episode whose manifest.json exists and whose pieces are all
present is skipped. A half-finished episode is redone from its download (kept
until the split succeeds). Failures go to data/download_errors.csv and the
script moves on to the next episode.

Usage:
    .venv\\Scripts\\python.exe pipeline\\03_download_audio.py [--set bakeoff|test_set|all]
"""

import argparse
import csv
import json
import logging
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import yt_dlp

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
AUDIO_DIR = ROOT / "audio"
CANDIDATES_CSV = DATA_DIR / "candidates.csv"
ERRORS_CSV = DATA_DIR / "download_errors.csv"

SETS = ["bakeoff", "test_set", "all"]
PIECE_SECONDS = 10 * 60
SAMPLE_RATE = 16000
# 64 kbps mono is about 4.8 MB per 10-minute piece, far below the 25 MB cap.
BITRATE = "64k"
MAX_PIECE_BYTES = 25 * 1024 * 1024
MAX_RETRIES = 3

ERROR_FIELDS = ["time", "video_id", "title", "stage", "error"]

log = logging.getLogger("download_audio")


class StageError(RuntimeError):
    def __init__(self, stage: str, message: str):
        super().__init__(message)
        self.stage = stage


def read_episodes(which: str) -> list[dict]:
    with CANDIDATES_CSV.open(newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    if which == "all":
        return rows
    return [r for r in rows if r[which] == "yes"]


def is_done(episode_dir: Path) -> bool:
    manifest = episode_dir / "manifest.json"
    if not manifest.exists():
        return False
    pieces = json.loads(manifest.read_text(encoding="utf-8"))["pieces"]
    return all((episode_dir / p["file"]).exists() for p in pieces)


def find_source(episode_dir: Path) -> Path | None:
    for path in episode_dir.glob("source.*"):
        if path.suffix not in (".part", ".ytdl", ".tmp"):
            return path
    return None


def download(episode: dict, episode_dir: Path) -> Path:
    source = find_source(episode_dir)
    if source:
        log.info("%s: reusing earlier download %s", episode["video_id"], source.name)
        return source
    options = {
        "format": "bestaudio/best",
        "outtmpl": str(episode_dir / "source.%(ext)s"),
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "retries": 10,
        "fragment_retries": 10,
        "continuedl": True,
    }
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            with yt_dlp.YoutubeDL(options) as ydl:
                ydl.download([episode["url"]])
            break
        except yt_dlp.utils.DownloadError as exc:
            if attempt == MAX_RETRIES:
                raise StageError("download", str(exc).strip()) from exc
            wait = 5 * attempt
            log.warning("%s: download failed, retrying in %ss (attempt %s/%s)",
                        episode["video_id"], wait, attempt, MAX_RETRIES)
            time.sleep(wait)
    source = find_source(episode_dir)
    if not source:
        raise StageError("download", "yt-dlp finished but no audio file was written")
    return source


def split(source: Path, episode_dir: Path) -> list[dict]:
    for old in episode_dir.glob("part_*.mp3"):
        old.unlink()
    segment_list = episode_dir / "segments.csv"
    cmd = [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
        "-i", str(source),
        "-vn", "-ac", "1", "-ar", str(SAMPLE_RATE), "-c:a", "libmp3lame", "-b:a", BITRATE,
        "-f", "segment", "-segment_time", str(PIECE_SECONDS), "-reset_timestamps", "1",
        "-segment_list", str(segment_list), "-segment_list_type", "csv",
        str(episode_dir / "part_%03d.mp3"),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if result.returncode != 0:
        raise StageError("convert", result.stderr.strip()[-500:] or f"ffmpeg exited {result.returncode}")

    pieces = []
    with segment_list.open(newline="", encoding="utf-8") as f:
        for name, start, end in csv.reader(f):
            size = (episode_dir / name).stat().st_size
            if size >= MAX_PIECE_BYTES:
                raise StageError("convert", f"{name} is {size / 1e6:.1f} MB, over the 25 MB limit")
            pieces.append({
                "file": name,
                "start_seconds": round(float(start), 3),
                "duration_seconds": round(float(end) - float(start), 3),
                "bytes": size,
            })
    segment_list.unlink()
    if not pieces:
        raise StageError("convert", "ffmpeg produced no pieces")
    return pieces


def write_manifest(episode: dict, episode_dir: Path, pieces: list[dict]) -> None:
    manifest = {
        "video_id": episode["video_id"],
        "title": episode["title"],
        "url": episode["url"],
        "sample_rate": SAMPLE_RATE,
        "channels": 1,
        "bitrate": BITRATE,
        "piece_seconds": PIECE_SECONDS,
        "total_seconds": round(sum(p["duration_seconds"] for p in pieces), 3),
        "pieces": pieces,
    }
    tmp = episode_dir / "manifest.json.tmp"
    tmp.write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(episode_dir / "manifest.json")


def log_error(episode: dict, stage: str, message: str) -> None:
    new_file = not ERRORS_CSV.exists()
    with ERRORS_CSV.open("a", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=ERROR_FIELDS)
        if new_file:
            writer.writeheader()
        writer.writerow({
            "time": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "video_id": episode["video_id"],
            "title": episode["title"],
            "stage": stage,
            "error": message.replace("\n", " ")[:1000],
        })


def process(episode: dict) -> str:
    episode_dir = AUDIO_DIR / episode["video_id"]
    if is_done(episode_dir):
        return "skipped"
    episode_dir.mkdir(parents=True, exist_ok=True)
    source = download(episode, episode_dir)
    pieces = split(source, episode_dir)
    write_manifest(episode, episode_dir, pieces)
    source.unlink()
    log.info("%s: %s pieces, %.1f min", episode["video_id"], len(pieces),
             sum(p["duration_seconds"] for p in pieces) / 60)
    return "done"


def print_summary(episodes: list[dict], results: dict[str, int]) -> None:
    pieces = 0
    seconds = 0.0
    used = 0
    for ep in episodes:
        episode_dir = AUDIO_DIR / ep["video_id"]
        manifest = episode_dir / "manifest.json"
        if manifest.exists():
            data = json.loads(manifest.read_text(encoding="utf-8"))
            pieces += len(data["pieces"])
            seconds += data["total_seconds"]
        if episode_dir.exists():
            used += sum(p.stat().st_size for p in episode_dir.rglob("*") if p.is_file())
    print()
    print(f"Episodes:     {len(episodes)} ({results['done']} done now, {results['skipped']} already done, "
          f"{results['failed']} failed)")
    print(f"Total pieces: {pieces}")
    print(f"Total audio:  {seconds / 60:.1f} minutes")
    print(f"Disk used:    {used / 1024 / 1024:.1f} MB")
    if results["failed"]:
        print(f"Failures logged to {ERRORS_CSV}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--set", choices=SETS, default="bakeoff", help="which episodes to download")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    if not shutil.which("ffmpeg"):
        sys.exit("ffmpeg not found on PATH")
    if not CANDIDATES_CSV.exists():
        sys.exit(f"{CANDIDATES_CSV} not found; run 02_pick_candidates.py first")
    episodes = read_episodes(args.set)
    if not episodes:
        sys.exit(f"No episodes marked {args.set} in {CANDIDATES_CSV}")
    log.info("%s episodes in set %s", len(episodes), args.set)

    results = {"done": 0, "skipped": 0, "failed": 0}
    for i, ep in enumerate(episodes, 1):
        log.info("[%s/%s] %s %s", i, len(episodes), ep["video_id"], ep["title"][:70])
        try:
            results[process(ep)] += 1
        except StageError as exc:
            results["failed"] += 1
            log.error("%s: %s failed: %s", ep["video_id"], exc.stage, str(exc)[:300])
            log_error(ep, exc.stage, str(exc))
        except Exception as exc:  # keep going on anything unexpected, but record it
            results["failed"] += 1
            log.exception("%s: unexpected error", ep["video_id"])
            log_error(ep, "unexpected", f"{type(exc).__name__}: {exc}")

    print_summary(episodes, results)


if __name__ == "__main__":
    main()
