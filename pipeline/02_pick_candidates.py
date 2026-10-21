"""Build data/candidates.csv from data/episodes.csv and print a shortlist to pick from.

Adds to every episode:
  year           year of publication
  language_mix   english / hinglish / hindi, guessed from the title only
  default_audio_language, default_language
                 as reported by the YouTube API (videos.list, snippet part)
  flag         why the title may not be a full podcast episode (empty if none)
  bakeoff        empty until you mark it
  test_set       empty until you mark it

Then prints a numbered shortlist of 40 episodes, spread evenly across 2023-2026
and across language_mix within each year. The shortlist is saved to
data/shortlist.csv so the numbers stay stable between runs.

Safe to rerun: existing bakeoff/test_set marks in data/candidates.csv are kept,
an existing data/shortlist.csv is reused (pass --reshuffle to rebuild it), and
API responses are cached under data/cache/youtube/ like 01_fetch_episodes.py.

Usage:
    .venv\\Scripts\\python.exe pipeline\\02_pick_candidates.py
    .venv\\Scripts\\python.exe pipeline\\02_pick_candidates.py --bakeoff 1,5,9 --test-set 2,6,10
    .venv\\Scripts\\python.exe pipeline\\02_pick_candidates.py --test-set-file data\\test_set_proposal.csv
"""

import argparse
import csv
import hashlib
import importlib
import logging
import os
import re
import sys
from pathlib import Path

from dotenv import load_dotenv

# Module names starting with a digit cannot be imported with a plain import statement.
fetch_episodes = importlib.import_module("01_fetch_episodes")

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
EPISODES_CSV = DATA_DIR / "episodes.csv"
OUT_CSV = DATA_DIR / "candidates.csv"
SHORTLIST_CSV = DATA_DIR / "shortlist.csv"

YEARS = ["2023", "2024", "2025", "2026"]
LANGUAGES = ["english", "hinglish", "hindi"]
SHORTLIST_SIZE = 40

LANGUAGE_FIELDS = ["default_audio_language", "default_language"]
EXTRA_FIELDS = ["year", "language_mix", *LANGUAGE_FIELDS, "flag", "bakeoff", "test_set"]
MARK_FIELDS = ["bakeoff", "test_set"]
SHORTLIST_FIELDS = ["number", "video_id"]

DEVANAGARI = re.compile(r"[ऀ-ॿ]")
LATIN = re.compile(r"[A-Za-z]")
# Romanised Hindi words that rarely appear in English titles. "wala" is left out
# because it is part of names (Sidhu Moose Wala).
HINDI_WORDS = re.compile(
    r"\b(hai|hain|kya|kaise|kaisa|kyun|kyu|kyon|nahi|nahin|aur|mein|ka|ki|ke|se|ko|bhi|"
    r"paisa|paise|sach|zindagi|kab|kaun|kitna|kitne|karo|kare|karein|karna|banaye|bano|"
    r"hota|hoti|apna|apne|apni|sabse|yeh|woh|jab|tak|baat|bhai|duniya|"
    r"gareeb|ameer|sapne|dil|pyaar|jeet|kamao|kamaye|sikho|ghar|desh|log|logon)\b",
    re.IGNORECASE,
)
NOT_FULL_EPISODE = {
    "trailer": re.compile(r"\btrailer\b|\bteaser\b", re.IGNORECASE),
    "compilation": re.compile(r"\bcompilation\b|\bhighlights?\b|\bmontage\b", re.IGNORECASE),
    "best-of": re.compile(r"\bbest of\b|\btop moments\b|\bbest moments\b", re.IGNORECASE),
    # Bare "live" is too common in titles ("Live Longer", "Live-In Relationship").
    "livestream": re.compile(r"\blive ?stream\b|\blive (?:session|q ?& ?a|now)\b|\bAMA\b|\bstreamed\b", re.IGNORECASE),
    "clip": re.compile(r"\bclip\b|\bshorts?\b|\bpromo\b", re.IGNORECASE),
}

log = logging.getLogger("pick_candidates")


def guess_language(title: str) -> str:
    devanagari = len(DEVANAGARI.findall(title))
    if devanagari > len(LATIN.findall(title)):
        return "hindi"
    if devanagari or HINDI_WORDS.search(title):
        return "hinglish"
    return "english"


def flag_title(title: str) -> str:
    return ",".join(name for name, pattern in NOT_FULL_EPISODE.items() if pattern.search(title))


def read_csv(path: Path) -> list[dict]:
    with path.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def write_csv(path: Path, fields: list[str], rows: list[dict]) -> None:
    tmp = path.with_suffix(".csv.tmp")
    with tmp.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)
    tmp.replace(path)


def fetch_languages(video_ids: list[str]) -> dict[str, dict]:
    """defaultAudioLanguage and defaultLanguage per video, 50 IDs per videos.list call."""
    load_dotenv(ROOT / ".env")
    api_key = os.getenv("YOUTUBE_API_KEY")
    if not api_key:
        sys.exit("YOUTUBE_API_KEY is not set in .env")
    yt = fetch_episodes.YouTube(api_key, refresh=False)
    languages = {}
    try:
        for start in range(0, len(video_ids), 50):
            ids = video_ids[start : start + 50]
            digest = hashlib.sha1(",".join(ids).encode()).hexdigest()[:16]
            data = yt.get(
                "videos",
                {"part": "snippet", "id": ",".join(ids), "maxResults": 50},
                cache_key=f"snippet_{digest}",
            )
            for item in (data or {}).get("items", []):
                snippet = item["snippet"]
                languages[item["id"]] = {
                    "default_audio_language": snippet.get("defaultAudioLanguage", ""),
                    "default_language": snippet.get("defaultLanguage", ""),
                }
            log.info("Languages: %s of %s videos looked up", min(start + 50, len(video_ids)), len(video_ids))
    except fetch_episodes.QuotaError as exc:
        sys.exit(str(exc))
    log.info("API quota used for languages this run: %s units", yt.units_used)
    return languages


def build_candidates(episodes: list[dict]) -> list[dict]:
    old_marks = {}
    if OUT_CSV.exists():
        old_marks = {r["video_id"]: r for r in read_csv(OUT_CSV)}
        log.info("Keeping existing marks from %s", OUT_CSV)
    languages = fetch_languages([ep["video_id"] for ep in episodes])
    rows = []
    for ep in episodes:
        row = dict(ep)
        row["year"] = ep["published_at"][:4]
        row["language_mix"] = guess_language(ep["title"])
        row.update(languages.get(ep["video_id"], dict.fromkeys(LANGUAGE_FIELDS, "")))
        row["flag"] = flag_title(ep["title"])
        for field in MARK_FIELDS:
            row[field] = old_marks.get(ep["video_id"], {}).get(field, "")
        rows.append(row)
    return rows


def spread(rows: list[dict], n: int) -> list[dict]:
    """Pick n rows evenly spaced through rows (already sorted by date)."""
    if n >= len(rows):
        return list(rows)
    step = len(rows) / n
    return [rows[int(step * i + step / 2)] for i in range(n)]


def build_shortlist(rows: list[dict]) -> list[dict]:
    per_year = SHORTLIST_SIZE // len(YEARS)
    picked = []
    for year in YEARS:
        buckets = {
            lang: sorted((r for r in rows if r["year"] == year and r["language_mix"] == lang),
                         key=lambda r: r["published_at"])
            for lang in LANGUAGES
        }
        # Share the year's slots equally between languages, handing slots a
        # language cannot fill to the others.
        quota = {lang: 0 for lang in LANGUAGES}
        for _ in range(per_year):
            open_langs = [l for l in LANGUAGES if quota[l] < len(buckets[l])]
            if not open_langs:
                break
            quota[min(open_langs, key=lambda l: quota[l])] += 1
        year_rows = [r for lang in LANGUAGES for r in spread(buckets[lang], quota[lang])]
        picked.extend(sorted(year_rows, key=lambda r: r["published_at"]))
    return [{"number": i, "video_id": r["video_id"]} for i, r in enumerate(picked, 1)]


def parse_numbers(text: str | None) -> set[int]:
    if not text:
        return set()
    return {int(x) for x in re.split(r"[,\s]+", text.strip()) if x}


def mark(rows: list[dict], shortlist: list[dict], field: str, numbers: set[int]) -> None:
    by_number = {int(s["number"]): s["video_id"] for s in shortlist}
    unknown = sorted(numbers - by_number.keys())
    if unknown:
        sys.exit(f"Not on the shortlist: {unknown}")
    ids = {by_number[n] for n in numbers}
    for row in rows:
        row[field] = "yes" if row["video_id"] in ids else ""
    log.info("Marked %s episodes as %s", len(ids), field)


def mark_ids(rows: list[dict], field: str, path: Path) -> None:
    ids = {r["video_id"] for r in read_csv(path)}
    unknown = ids - {r["video_id"] for r in rows}
    if unknown:
        sys.exit(f"Not in {EPISODES_CSV.name}: {sorted(unknown)}")
    for row in rows:
        row[field] = "yes" if row["video_id"] in ids else ""
    log.info("Marked %s episodes as %s from %s", len(ids), field, path)


def print_shortlist(rows: list[dict], shortlist: list[dict]) -> None:
    by_id = {r["video_id"]: r for r in rows}
    print()
    print(f"{'#':>3}  {'date':<10}  {'min':>4}  {'lang':<8}  {'views':>10}  title")
    for s in shortlist:
        r = by_id[s["video_id"]]
        marks = " ".join(f"[{f}]" for f in MARK_FIELDS if r[f])
        flag = f"  <-- FLAG: {r['flag']}" if r["flag"] else ""
        print(f"{s['number']:>3}  {r['published_at'][:10]}  {int(r['duration_seconds']) / 60:>4.0f}  "
              f"{r['language_mix']:<8}  {int(r['view_count'] or 0):>10,}  {r['title']}{flag} {marks}".rstrip())


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--bakeoff", help="shortlist numbers to mark for the bake-off, e.g. 1,5,9")
    parser.add_argument("--test-set", help="shortlist numbers to mark for the test set")
    parser.add_argument("--test-set-file", type=Path,
                        help="CSV with a video_id column; marks exactly those episodes as test_set")
    parser.add_argument("--reshuffle", action="store_true", help="rebuild data/shortlist.csv")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    if not EPISODES_CSV.exists():
        sys.exit(f"{EPISODES_CSV} not found; run 01_fetch_episodes.py first")
    episodes = read_csv(EPISODES_CSV)
    rows = build_candidates(episodes)

    if SHORTLIST_CSV.exists() and not args.reshuffle:
        shortlist = read_csv(SHORTLIST_CSV)
        log.info("Reusing shortlist from %s", SHORTLIST_CSV)
    else:
        shortlist = build_shortlist(rows)
        write_csv(SHORTLIST_CSV, SHORTLIST_FIELDS, shortlist)
        log.info("Wrote shortlist of %s to %s", len(shortlist), SHORTLIST_CSV)

    if args.bakeoff is not None:
        mark(rows, shortlist, "bakeoff", parse_numbers(args.bakeoff))
    if args.test_set is not None:
        mark(rows, shortlist, "test_set", parse_numbers(args.test_set))
    if args.test_set_file is not None:
        mark_ids(rows, "test_set", args.test_set_file)

    write_csv(OUT_CSV, list(episodes[0].keys()) + EXTRA_FIELDS, rows)
    log.info("Wrote %s rows to %s", len(rows), OUT_CSV)

    counts = {(y, l): 0 for y in YEARS for l in LANGUAGES}
    for r in rows:
        if (r["year"], r["language_mix"]) in counts:
            counts[(r["year"], r["language_mix"])] += 1
    print("\nAll episodes by year and language guess:")
    print(f"  {'':<6}" + "".join(f"{l:>10}" for l in LANGUAGES))
    for y in YEARS:
        print(f"  {y:<6}" + "".join(f"{counts[(y, l)]:>10}" for l in LANGUAGES))
    for field in LANGUAGE_FIELDS:
        values: dict[str, int] = {}
        for r in rows:
            value = r[field] or "(not set)"
            values[value] = values.get(value, 0) + 1
        print(f"\n{field} from the YouTube API:")
        for value, n in sorted(values.items(), key=lambda kv: -kv[1]):
            print(f"  {value:<12}{n:>5}")
    flagged = [r for r in rows if r["flag"]]
    print(f"\nFlagged as possibly not a full episode: {len(flagged)} of {len(rows)}")
    for r in flagged:
        print(f"  {r['flag']:<12} {r['published_at'][:10]}  {r['title']}")

    print_shortlist(rows, shortlist)


if __name__ == "__main__":
    main()
