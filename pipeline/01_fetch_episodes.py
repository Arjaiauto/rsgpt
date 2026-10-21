"""Fetch the latest full-length episodes from the @rajshamani YouTube channel.

Lists the channel's uploads playlist newest first (playlistItems, 1 unit/page),
looks up each page of 50 videos with videos.list (1 unit/call), keeps only full
episodes (no Shorts, no live streams, at least 20 minutes) and stops as soon as
it has 500. Writes data/episodes.csv.

Safe to rerun: every API response is cached under data/cache/youtube/, so a
rerun costs no quota. Pass --refresh to ignore the cache and fetch fresh data
(for example, to update view counts).

Usage:
    .venv\\Scripts\\python.exe pipeline\\01_fetch_episodes.py [--refresh] [--limit 500]
"""

import argparse
import csv
import hashlib
import json
import logging
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path

import requests
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
CACHE_DIR = DATA_DIR / "cache" / "youtube"
OUT_CSV = DATA_DIR / "episodes.csv"

API_BASE = "https://www.googleapis.com/youtube/v3"
CHANNEL_HANDLE = "@rajshamani"
MIN_DURATION_SECONDS = 20 * 60
DEFAULT_LIMIT = 500
MAX_RETRIES = 5

FIELDS = [
    "video_id",
    "title",
    "published_at",
    "duration_seconds",
    "view_count",
    "like_count",
    "comment_count",
    "url",
]

log = logging.getLogger("fetch_episodes")


class QuotaError(RuntimeError):
    pass


class YouTube:
    """Minimal YouTube Data API client with on-disk caching and retries."""

    def __init__(self, api_key: str, refresh: bool):
        self.api_key = api_key
        self.refresh = refresh
        self.session = requests.Session()
        self.units_used = 0
        CACHE_DIR.mkdir(parents=True, exist_ok=True)

    def get(self, endpoint: str, params: dict, cache_key: str) -> dict | None:
        """GET an endpoint. Returns None on 404 (e.g. a playlist that does not exist)."""
        cache_file = CACHE_DIR / f"{cache_key}.json"
        if cache_file.exists() and not self.refresh:
            return json.loads(cache_file.read_text(encoding="utf-8"))

        for attempt in range(1, MAX_RETRIES + 1):
            try:
                resp = self.session.get(
                    f"{API_BASE}/{endpoint}",
                    params={**params, "key": self.api_key},
                    timeout=30,
                )
            except requests.RequestException as exc:
                # Log only the exception type: the message can contain the request URL, which holds the key.
                self._backoff(attempt, f"network error ({type(exc).__name__})")
                continue

            self.units_used += 1
            if resp.status_code == 200:
                data = resp.json()
                tmp = cache_file.with_suffix(".tmp")
                tmp.write_text(json.dumps(data), encoding="utf-8")
                tmp.replace(cache_file)
                return data
            if resp.status_code == 404:
                return None

            reason, message = _error_details(resp)
            if resp.status_code == 403 and reason in ("quotaExceeded", "dailyLimitExceeded"):
                raise QuotaError("YouTube API daily quota exceeded. Rerun tomorrow; cached pages will be reused.")
            if resp.status_code in (429, 500, 502, 503, 504):
                self._backoff(attempt, f"HTTP {resp.status_code} {reason}")
                continue
            raise RuntimeError(f"{endpoint} failed: HTTP {resp.status_code} {reason}: {message}")

        raise RuntimeError(f"{endpoint} failed after {MAX_RETRIES} attempts")

    @staticmethod
    def _backoff(attempt: int, why: str) -> None:
        if attempt == MAX_RETRIES:
            return
        wait = 2**attempt
        log.warning("%s, retrying in %ss (attempt %s/%s)", why, wait, attempt, MAX_RETRIES)
        time.sleep(wait)


def _error_details(resp: requests.Response) -> tuple[str, str]:
    try:
        err = resp.json()["error"]
        return err["errors"][0].get("reason", ""), err.get("message", "")
    except (ValueError, KeyError, IndexError):
        return "", resp.text[:200]


def parse_duration(iso: str) -> int:
    """Convert an ISO 8601 duration like 'PT1H2M3S' or 'P1DT2H' to seconds."""
    m = re.fullmatch(r"P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?", iso or "")
    if not m:
        return 0
    days, hours, minutes, seconds = (int(g or 0) for g in m.groups())
    return days * 86400 + hours * 3600 + minutes * 60 + seconds


def get_uploads_playlist(yt: YouTube) -> tuple[str, str]:
    data = yt.get(
        "channels",
        {"part": "contentDetails", "forHandle": CHANNEL_HANDLE},
        cache_key="channel_" + CHANNEL_HANDLE.lstrip("@"),
    )
    if not data or not data.get("items"):
        sys.exit(f"Channel {CHANNEL_HANDLE} not found")
    item = data["items"][0]
    return item["id"], item["contentDetails"]["relatedPlaylists"]["uploads"]


def iter_playlist_pages(yt: YouTube, playlist_id: str):
    """Yield lists of video IDs, one page (up to 50) at a time, in playlist order."""
    token = None
    page = 0
    while True:
        page += 1
        params = {"part": "contentDetails", "playlistId": playlist_id, "maxResults": 50}
        if token:
            params["pageToken"] = token
        data = yt.get("playlistItems", params, cache_key=f"playlist_{playlist_id}_{token or 'first'}")
        if data is None:
            return
        yield page, [it["contentDetails"]["videoId"] for it in data.get("items", [])]
        token = data.get("nextPageToken")
        if not token:
            return


def get_live_ids(yt: YouTube, channel_id: str) -> set[str]:
    """IDs of past live streams, from the channel's live-uploads playlist (UULV...).

    This playlist is undocumented, so if it is missing we fall back to the
    liveBroadcastContent check alone.
    """
    live_playlist = "UULV" + channel_id[2:]
    ids: set[str] = set()
    for _, page_ids in iter_playlist_pages(yt, live_playlist):
        ids.update(page_ids)
    if not ids:
        log.info("No live-streams playlist found; relying on liveBroadcastContent only")
    return ids


def fetch_videos(yt: YouTube, ids: list[str]) -> list[dict]:
    digest = hashlib.sha1(",".join(ids).encode()).hexdigest()[:16]
    data = yt.get(
        "videos",
        {"part": "snippet,contentDetails,statistics", "id": ",".join(ids), "maxResults": 50},
        cache_key=f"videos_{digest}",
    )
    return data.get("items", []) if data else []


def skip_reason(video: dict, live_ids: set[str]) -> str | None:
    snippet = video["snippet"]
    if video["id"] in live_ids or snippet.get("liveBroadcastContent", "none") != "none":
        return "live"
    duration = parse_duration(video["contentDetails"].get("duration", ""))
    # The API has no Shorts flag. Shorts are at most 3 minutes, so the 20-minute
    # floor removes every one of them; the split is only for the progress log.
    if duration <= 180:
        return "short"
    if duration < MIN_DURATION_SECONDS:
        return "under_20_min"
    return None


def to_row(video: dict) -> dict:
    stats = video.get("statistics", {})
    return {
        "video_id": video["id"],
        "title": video["snippet"]["title"],
        "published_at": video["snippet"]["publishedAt"],
        "duration_seconds": parse_duration(video["contentDetails"]["duration"]),
        "view_count": stats.get("viewCount", ""),
        "like_count": stats.get("likeCount", ""),
        "comment_count": stats.get("commentCount", ""),
        "url": f"https://www.youtube.com/watch?v={video['id']}",
    }


def write_csv(rows: list[dict]) -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = OUT_CSV.with_suffix(".csv.tmp")
    with tmp.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(rows)
    tmp.replace(OUT_CSV)


def fmt_minutes(seconds: int) -> str:
    return f"{seconds / 60:.0f} min"


def print_summary(rows: list[dict]) -> None:
    durations = [r["duration_seconds"] for r in rows]
    dates = [datetime.fromisoformat(r["published_at"].replace("Z", "+00:00")) for r in rows]
    print()
    print(f"Episodes:         {len(rows)}")
    print(f"Total audio:      {sum(durations) / 3600:.1f} hours")
    print(f"Average length:   {sum(durations) / len(durations) / 60:.1f} minutes")
    print(f"Date range:       {min(dates):%Y-%m-%d} to {max(dates):%Y-%m-%d}")
    by_length = sorted(rows, key=lambda r: r["duration_seconds"], reverse=True)
    print("\n5 longest:")
    for r in by_length[:5]:
        print(f"  {fmt_minutes(r['duration_seconds']):>8}  {r['title']}")
    print("\n5 shortest:")
    for r in reversed(by_length[-5:]):
        print(f"  {fmt_minutes(r['duration_seconds']):>8}  {r['title']}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--refresh", action="store_true", help="ignore cached API responses")
    parser.add_argument("--limit", type=int, default=DEFAULT_LIMIT, help="number of episodes to keep")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    # Windows consoles default to a legacy code page; titles contain emoji and Devanagari.
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    load_dotenv(ROOT / ".env")
    api_key = os.getenv("YOUTUBE_API_KEY")
    if not api_key:
        sys.exit("YOUTUBE_API_KEY is not set in .env")

    yt = YouTube(api_key, refresh=args.refresh)
    try:
        channel_id, uploads = get_uploads_playlist(yt)
        log.info("Channel %s -> uploads playlist %s", channel_id, uploads)
        live_ids = get_live_ids(yt, channel_id)
        log.info("Found %s past live streams", len(live_ids))

        kept: list[dict] = []
        skipped = {"live": 0, "short": 0, "under_20_min": 0}
        for page, ids in iter_playlist_pages(yt, uploads):
            for video in fetch_videos(yt, ids):
                reason = skip_reason(video, live_ids)
                if reason:
                    skipped[reason] += 1
                else:
                    kept.append(to_row(video))
            log.info("Page %s: %s episodes kept so far (skipped %s)", page, len(kept), skipped)
            if len(kept) >= args.limit:
                break
    except QuotaError as exc:
        sys.exit(str(exc))

    if not kept:
        sys.exit("No episodes found")

    kept.sort(key=lambda r: r["published_at"], reverse=True)
    rows = kept[: args.limit]
    write_csv(rows)
    log.info("Wrote %s rows to %s (API quota used this run: %s units)", len(rows), OUT_CSV, yt.units_used)
    print_summary(rows)


if __name__ == "__main__":
    main()
