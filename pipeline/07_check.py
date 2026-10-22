"""Check one extraction run's insights, clips and guests against the transcript, without any model.

For a run_id, every row in insights, clips and guests is checked against the
episode's segments (and, for Hindi episodes, translation_segments):

  1. source_segment_ids exist and belong to the row's episode. guests and clips
     have no such column, so their IDs come from the run's merged result file in
     data/extractions/ (clips matched by start and end time).
  2. start_s and end_s lie inside the episode (0 to duration_seconds) and match
     the cited segments: the first segment's start and the last segment's end.
  3. Quotes: rapidfuzz partial_ratio of the quote against the cited segments'
     text_roman, then text_original; QUOTE_MIN_SCORE or higher passes. If both fail
     and the episode is Hindi, the quote is compared with the English translation
     lines over the same time span; a pass there sets translated = true. A quote
     longer than the text it is compared with is scored with the plain ratio, so a
     long quote cannot pass by containing a short line.
  4. Clips are CLIP_SECONDS long.
  5. No phone number or email address appears in any text field.
  6. Raj questions and Raj opinions cite at least one segment whose speaker is raj.
  7. Disagreements cite at least one segment labelled raj and one labelled guest
     (both sides of the exchange).
  8. Every number in the text (digits, a percentage, a year, an amount, or English
     number words such as "twelve" or "five million") must appear in the cited lines:
     their text_roman, text_original or English translation, as digits or as
     English or Hindi number words ("50 hazaar" matches 50,000; "5 million" matches
     "50 lakh"). A bare "one" is not counted, since it is mostly not a number. For
     guests the fields are checked against the cited lines of all facts, and for
     clips the topic against the clip's lines.

Rules 1-8 are locked with extraction v5 (Gate 1, 2026-10-23) for the full run.

A row gets verified = true only when every check passes; otherwise check_notes
lists the reasons ("check: ..."). Notes that are not check results (the question
type of Raj's questions) are kept. The same goes for clips and guests (their
verified and check_notes columns were added later; see schema.sql). Safe to rerun: each run recomputes every row
and only rows whose values change are written.

Usage:
    .venv\\Scripts\\python.exe pipeline\\07_check.py --run-id extract-haiku-v3-20261022-215258
"""

import argparse
import importlib.util
import json
import logging
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

from dotenv import load_dotenv
from rapidfuzz import fuzz

ROOT = Path(__file__).resolve().parent.parent
EXTRACT_DIR = ROOT / "data" / "extractions"

QUOTE_MIN_SCORE = 90
OPENING_LINE_MIN_SCORE = 90
CLIP_SECONDS = (30, 90)
TIME_TOLERANCE = 0.05  # seconds; stored times are rounded floats
DB_PAGE = 1000
UPDATE_IDS = 300

EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
# Indian mobile numbers (with or without +91 / 0) and other international numbers written with a +.
PHONE = re.compile(r"(?<!\d)(?:(?:\+91|0)[\s-]?)?[6-9]\d{4}[\s-]?\d{5}(?!\d)|\+\d{1,3}[\s-]?\d{2,4}[\s-]?\d{3,4}[\s-]?\d{3,4}")

log = logging.getLogger("check")

# ---------- numbers ----------

UNITS = {"zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8,
         "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15,
         "sixteen": 16, "seventeen": 17, "eighteen": 18, "nineteen": 19, "twenty": 20, "thirty": 30, "forty": 40,
         "fifty": 50, "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90, "dozen": 12}
# Hindi number words in Roman script; only read in the transcript, never in the item text.
HINDI_UNITS = {"ek": 1, "do": 2, "teen": 3, "char": 4, "chaar": 4, "paanch": 5, "panch": 5, "chhe": 6, "chheh": 6,
               "saat": 7, "aath": 8, "nau": 9, "das": 10, "gyarah": 11, "barah": 12, "baarah": 12, "pandrah": 15,
               "bees": 20, "pachchees": 25, "pachees": 25, "tees": 30, "chalis": 40, "chaalis": 40,
               "pachaas": 50, "pachas": 50, "saath": 60, "sattar": 70, "assi": 80, "nabbe": 90, "sau": 100}
SCALES = {"hundred": 100, "thousand": 1e3, "k": 1e3, "lakh": 1e5, "lakhs": 1e5, "laakh": 1e5, "million": 1e6,
          "crore": 1e7, "crores": 1e7, "karod": 1e7, "karor": 1e7, "billion": 1e9, "trillion": 1e12,
          "hazaar": 1e3, "hazar": 1e3, "hajar": 1e3, "hazaron": 1e3, "arab": 1e9}
DEVANAGARI_DIGITS = str.maketrans("०१२३४५६७८९", "0123456789")
# A digit right after a letter is part of a name ("B2C", "A320"), not a number.
NUMBER_TOKEN = re.compile(r"(?<![a-z\d])\d[\d,]*(?:\.\d+)?|[a-z]+")


def numbers_in(text: str, transcript: bool) -> list[tuple[str, float]]:
    """(as written, value) for each number in the text. In the transcript Hindi words count too; in an item
    a bare "one" does not, since it is mostly "one of", "the one who" and so on."""
    tokens = NUMBER_TOKEN.findall(re.sub(r"(\d)k\b", r"\1 k", (text or "").lower().translate(DEVANAGARI_DIGITS)))
    words = UNITS | (HINDI_UNITS if transcript else {})
    found, i = [], 0
    while i < len(tokens):
        tok, start = tokens[i], i
        if tok[0].isdigit():
            value = float(tok.replace(",", "")) if tok.replace(",", "").replace(".", "", 1).isdigit() else None
            i += 1
        elif tok in words:
            value = words[tok]
            i += 1
            if value >= 20 and value % 10 == 0 and i < len(tokens) and tokens[i] in words and words[tokens[i]] < 10:
                value += words[tokens[i]]  # "twenty five"
                i += 1
        elif tok in SCALES and tok != "k" and not tok.endswith("s"):
            value = 1.0  # "a million", "hundred"
        else:
            i += 1
            continue
        if value is None:
            continue
        while i < len(tokens) and tokens[i] in SCALES:
            value *= SCALES[tokens[i]]
            i += 1
        if tokens[start] in SCALES and i == start:
            i += 1
        written = " ".join(tokens[start:i]).strip(",")
        if transcript or written != "one":
            found.append((written, value))
            if transcript and i - start > 1 and tokens[start][0].isdigit():
                found.append((tokens[start], float(tokens[start].replace(",", ""))))  # "5" of "5 million"
    return found


def missing_numbers(texts: list[str], cited_texts: list[str]) -> list[str]:
    have = {round(v, 6) for t in cited_texts for _, v in numbers_in(t, transcript=True)}
    missing = []
    for text in texts:
        for written, value in numbers_in(text, transcript=False):
            if round(value, 6) not in have and written not in missing:
                missing.append(written)
    return missing


def load_captions_module():
    spec = importlib.util.spec_from_file_location("captions", Path(__file__).with_name("05_captions.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


captions = load_captions_module()
db_call = captions.db_call


def fetch(db, table: str, columns: str, order: str = "id", **eq) -> list[dict]:
    rows, start = [], 0
    while True:
        def page_query():
            q = db.table(table).select(columns)
            for k, v in eq.items():
                q = q.eq(k, v)
            return q.order(order).range(start, start + DB_PAGE - 1).execute()
        page = db_call(f"{table} select", page_query).data
        rows += page
        if len(page) < DB_PAGE:
            return rows
        start += DB_PAGE


def merged_results(run_id: str) -> dict[str, dict]:
    """The run's merged result files by video_id (the source of guest and clip segment IDs)."""
    found = {}
    for path in EXTRACT_DIR.rglob("*.json"):
        if path.parent.name in ("parts", "plans", "chunks") or path.stem == "batch_job":
            continue
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            continue
        if isinstance(record, dict) and record.get("run_id") == run_id and "video_id" in record:
            found[record["video_id"]] = record
    return found


def normalise(text: str) -> str:
    return " ".join(re.sub(r"[^\w\s]", " ", text.lower()).split())


def match_score(quote: str, text: str) -> float:
    q, t = normalise(quote), normalise(text)
    if not q or not t:
        return 0.0
    return fuzz.partial_ratio(q, t) if len(q) <= len(t) else fuzz.ratio(q, t)


def contact_details(*texts) -> list[str]:
    found = []
    for text in texts:
        for value in (text if isinstance(text, list) else [text]):
            if not value:
                continue
            if EMAIL.search(value):
                found.append("contains an email address")
            if PHONE.search(value):
                found.append("contains a phone number")
    return sorted(set(found))


class Episode:
    def __init__(self, db, vid: str, duration: float | None, language: str | None):
        self.vid, self.language = vid, language
        self.segments = {s["id"]: s for s in fetch(db, "segments",
                                                   "id,seq,start_s,end_s,text_roman,text_original,speaker",
                                                   video_id=vid)}
        self.translations = sorted(fetch(db, "translation_segments", "id,start_s,end_s,text", video_id=vid),
                                   key=lambda t: t["start_s"])
        last_end = max((s["end_s"] for s in self.segments.values()), default=0)
        self.duration = float(duration) if duration else last_end
        self.starts = {round(s["start_s"], 2): s for s in self.segments.values()}

    def check_ids(self, ids: list[int], failures: list) -> list[dict]:
        if not ids:
            failures.append(("no source segment IDs", ""))
            return []
        missing = [i for i in ids if i not in self.segments]
        if missing:
            failures.append(("cites segments not in this episode", f"{missing[:5]}"))
        return [self.segments[i] for i in ids if i in self.segments]

    def check_times(self, start, end, cited: list[dict], failures: list) -> None:
        if start is None or end is None:
            failures.append(("no start or end time", ""))
            return
        if not (-TIME_TOLERANCE <= start <= end <= self.duration + 1):
            failures.append(("time outside the episode", f"{start}-{end} of {self.duration:.0f}s"))
        if cited:
            first = min(s["start_s"] for s in cited)
            last = max(s["end_s"] for s in cited)
            if abs(start - first) > TIME_TOLERANCE or abs(end - last) > TIME_TOLERANCE:
                failures.append(("times do not match the cited segments",
                                 f"{start}-{end} vs {first}-{last}"))

    def translation_text(self, start: float, end: float) -> str:
        return " ".join(t["text"] for t in self.translations
                        if t["end_s"] > start + TIME_TOLERANCE and t["start_s"] < end - TIME_TOLERANCE)

    def check_numbers(self, texts: list, cited: list[dict], failures: list) -> None:
        """Every number in the texts must appear in the cited lines' Roman, original or translation text."""
        if not cited:
            return
        sources = [s["text_roman"] for s in cited] + [s["text_original"] for s in cited]
        sources += [self.translation_text(s["start_s"], s["end_s"]) for s in cited]
        flat = [t for x in texts for t in (x if isinstance(x, list) else [x]) if t]
        missing = missing_numbers(flat, sources)
        if missing:
            failures.append(("number not in the cited lines", ", ".join(missing)))


def check_insight(row: dict, ep: Episode) -> tuple[list, bool]:
    """Failures as (reason, detail), and whether a quote passed only through the translation."""
    failures, translated = [], False
    cited = ep.check_ids(row["source_segment_ids"] or [], failures)
    ep.check_times(row["start_s"], row["end_s"], cited, failures)
    if not (row["text"] or "").strip():
        failures.append(("empty text", ""))
    if row["type"] == "quote" and cited:
        cited = sorted(cited, key=lambda s: s["seq"])
        roman = " ".join(s["text_roman"] for s in cited)
        original = " ".join(s["text_original"] for s in cited)
        best = max(match_score(row["text"], roman), match_score(row["text"], original))
        if best < QUOTE_MIN_SCORE:
            english = ep.translation_text(cited[0]["start_s"], cited[-1]["end_s"]) if ep.language == "hi" else ""
            english_score = match_score(row["text"], english) if english else 0.0
            if english_score >= QUOTE_MIN_SCORE:
                translated = True
            else:
                failures.append(("quote does not match the cited lines",
                                 f"best {best:.0f}%" + (f", translation {english_score:.0f}%" if english else "")))
    if row["type"] in ("raj_question", "raj_opinion") and cited:
        if not any(s["speaker"] == "raj" for s in cited):
            who = Counter(s["speaker"] for s in cited)
            failures.append(("cites no line labelled Raj", ", ".join(f"{k} {v}" for k, v in who.items())))
    if row["type"] == "disagreement" and cited:
        missing = [w for w in ("raj", "guest") if not any(s["speaker"] == w for s in cited)]
        if missing:
            failures.append(("disagreement lacks a side", "no line labelled " + " or ".join(missing)))
    ep.check_numbers([row["text"]], cited, failures)
    failures += [(r, "") for r in contact_details(row["text"])]
    return failures, translated


def clip_ids(row: dict, merged: dict | None) -> list[int] | None:
    for clip in (merged or {}).get("clips", []):
        if abs(clip["start_s"] - row["start_s"]) <= TIME_TOLERANCE and abs(clip["end_s"] - row["end_s"]) <= TIME_TOLERANCE:
            return clip["source_segment_ids"]
    return None


def check_clip(row: dict, ep: Episode, merged: dict | None) -> list:
    failures = []
    ids = clip_ids(row, merged)
    if ids is None:
        failures.append(("no source segment IDs found for the clip in the run's result file", ""))
        cited = []
    else:
        cited = ep.check_ids(ids, failures)
    ep.check_times(row["start_s"], row["end_s"], cited, failures)
    length = (row["end_s"] or 0) - (row["start_s"] or 0)
    if not CLIP_SECONDS[0] <= length <= CLIP_SECONDS[1]:
        failures.append((f"clip not {CLIP_SECONDS[0]}-{CLIP_SECONDS[1]} seconds", f"{length:.0f}s"))
    first = ep.starts.get(round(row["start_s"] or -1, 2))
    if first is None:
        failures.append(("clip does not start at a segment", ""))
    elif match_score(row["opening_line"] or "", first["text_roman"]) < OPENING_LINE_MIN_SCORE:
        failures.append(("opening line does not match the first segment", ""))
    ep.check_numbers([row["topic"]], cited, failures)
    failures += [(r, "") for r in contact_details(row["opening_line"], row["topic"])]
    return failures


def check_guest(row: dict, ep: Episode, merged: dict | None) -> list:
    failures = []
    if not (row["name"] or "").strip():
        failures.append(("no name", ""))
    guest = (merged or {}).get("guest")
    if not guest:
        failures.append(("no source segment IDs found for the guest in the run's result file", ""))
    else:
        cited = ep.check_ids(guest.get("source_segment_ids", []), failures)
        ep.check_numbers([row["name"], row["organisation"], row["role_at_episode"], row["bio"]], cited, failures)
    failures += [(r, "") for r in contact_details(row["name"], row["organisation"], row["role_at_episode"],
                                                  row["bio"], row["sector_tags"] or [])]
    if row.get("linkedin_url") or row.get("youtube_channel_url"):
        failures.append(("has a contact link before it was verified", ""))
    return failures


def notes_for(old: str | None, failures: list) -> str | None:
    """Keep the non-check notes (the question type) and replace the check results."""
    kept = [n.strip() for n in (old or "").split(";") if n.strip().startswith("question_type:")]
    if failures:
        kept.append("check: " + "; ".join(f"{r} ({d})" if d else r for r, d in failures))
    return "; ".join(kept) or None


def write_updates(db, table: str, updates: dict[int, dict]) -> None:
    """Write changed rows, grouping rows that get the same values into one request."""
    groups = defaultdict(list)
    for row_id, values in updates.items():
        groups[json.dumps(values, sort_keys=True)].append(row_id)
    for key, ids in groups.items():
        values = json.loads(key)
        for i in range(0, len(ids), UPDATE_IDS):
            chunk = ids[i:i + UPDATE_IDS]
            db_call(f"{table} update", lambda: db.table(table).update(values).in_("id", chunk).execute())
    log.info("%s: %s rows changed in %s requests", table, len(updates), len(groups))


def run(run_id: str) -> None:
    db = captions.supabase_client()
    insights = fetch(db, "insights", "*", run_id=run_id)
    clips = fetch(db, "clips", "*", run_id=run_id)
    guests = fetch(db, "guests", "*", run_id=run_id)
    if not (insights or clips or guests):
        sys.exit(f"No rows with run_id {run_id}")
    if (clips and "check_notes" not in clips[0]) or (guests and not {"verified", "check_notes"} <= set(guests[0])):
        sys.exit("guests.verified, guests.check_notes or clips.check_notes is missing: run the alter table "
                 "statements from pipeline/schema.sql in the Supabase SQL Editor first")
    merged = merged_results(run_id)
    vids = sorted({r["video_id"] for r in [*insights, *clips, *guests]})
    log.info("run %s: %s insights, %s clips, %s guests in %s episodes; %s result files found", run_id,
             len(insights), len(clips), len(guests), len(vids), len(merged))
    meta = {e["video_id"]: e for e in fetch(db, "episodes", "video_id,duration_seconds,caption_language",
                                                     order="video_id")}

    report = defaultdict(lambda: {"total": 0, "passed": 0, "translated": 0, "reasons": defaultdict(list)})
    changes = {"insights": {}, "clips": {}, "guests": {}}

    def record(table: str, kind: str, row: dict, failures: list, translated: bool = False) -> None:
        r = report[kind]
        r["total"] += 1
        r["passed"] += not failures
        r["translated"] += translated and not failures
        for reason, detail in failures:
            r["reasons"][reason].append((row, detail))
        values = {"verified": not failures, "check_notes": notes_for(row["check_notes"], failures)}
        if translated:
            values["translated"] = True
        if any(row.get(k) != v for k, v in values.items()):
            changes[table][row["id"]] = values

    # One episode's segments in memory at a time.
    for n, vid in enumerate(vids, 1):
        ep = Episode(db, vid, meta.get(vid, {}).get("duration_seconds"), meta.get(vid, {}).get("caption_language"))
        for row in (r for r in insights if r["video_id"] == vid):
            failures, translated = check_insight(row, ep)
            record("insights", row["type"], row, failures, translated)
        for row in (r for r in clips if r["video_id"] == vid):
            record("clips", "clip", row, check_clip(row, ep, merged.get(vid)))
        for row in (r for r in guests if r["video_id"] == vid):
            record("guests", "guest", row, check_guest(row, ep, merged.get(vid)))
        if n % 25 == 0:
            log.info("checked %s of %s episodes", n, len(vids))

    for table in ("insights", "clips", "guests"):
        if changes[table]:
            write_updates(db, table, changes[table])

    print()
    print(f"=== Checks for {run_id} ===")
    print(f"{'type':14} {'total':>6} {'passed':>7} {'failed':>7}  passed as translated")
    for kind in ["takeaway", "opportunity", "quote", "disagreement", "raj_question", "raj_opinion", "clip", "guest"]:
        if kind not in report:
            continue
        r = report[kind]
        extra = str(r["translated"]) if kind == "quote" else ""
        print(f"{kind:14} {r['total']:>6} {r['passed']:>7} {r['total'] - r['passed']:>7}  {extra}")
    total = sum(r["total"] for r in report.values())
    print(f"{'all':14} {total:>6} {sum(r['passed'] for r in report.values()):>7} "
          f"{total - sum(r['passed'] for r in report.values()):>7}")
    print()
    print("Most common failure reasons:")
    for kind, r in report.items():
        for reason, hits in sorted(r["reasons"].items(), key=lambda x: -len(x[1])):
            print(f"  [{kind}] {reason}: {len(hits)}")
            for row, detail in hits[:3]:
                text = row.get("text") or row.get("opening_line") or row.get("name") or ""
                print(f"      {row['video_id']} #{row['id']}: {text[:100]!r}" + (f"  ({detail})" if detail else ""))
    print()
    print("Rows changed in this run: " + ", ".join(f"{t} {len(c)}" for t, c in changes.items()))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--run-id", required=True)
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    load_dotenv(ROOT / ".env")
    run(args.run_id)


if __name__ == "__main__":
    main()
