"""Guest data for the extraction v5 run: diagnose, recover profiles, merge duplicates, and the
LinkedIn / YouTube link list (export for manual checking, import of checked links).

Commands:

  diagnose  How many of the transcribed episodes have a verified guest, a guest row that failed
            07_check.py (rows grouped by check_notes reason), or no guest row; 10 sample titles of
            the episodes with no guest row.
  recover   Guest rows whose only failure is "number not in the cited lines", with every unverified
            number in the bio (none in name, organisation or role, which stay checked as they are):
            the bio sentences holding an unverified number are removed and the row is checked again
            with 07_check.check_guest. A row that then passes, and keeps at least one bio sentence,
            is written with the shorter bio and verified = true. The old bios are backed up to
            data/backups/guest_bio_recover_<timestamp>.csv first.
  merge     The same person across episodes: rows whose normalised name (no titles such as Dr)
            and normalised organisation (no Pvt / Ltd etc., spaces ignored) are equal get one guest_key.
            A row with no organisation also joins a guest of the same full name (2+ words) when that
            name has exactly one organisation; one-word names are never merged this way (no row is deleted). Keys are saved to
            data/guest_keys.json and written to guests.guest_key when that column exists.
  export    Merged guests with at least one verified row, ranked by the total views of their
            episodes; the top EXPORT_TOP go to data/guest_links.csv with search URLs to check by
            hand (Google, LinkedIn through Google, YouTube) and a suggested Wikipedia page.
            Values already typed in an existing CSV (linkedin_url, youtube_channel_url, verified,
            wikipedia_url, wikipedia_verified) are kept.
            The Wikipedia suggestion comes only from the official API (en.wikipedia.org/w/api.php):
            list=search for the name and organisation, then the top page's short description
            (prop=description), with a User-Agent naming the project and WIKI_PAUSE_SECONDS between
            requests. When the top title is not a full-name match, the name alone is searched too
            and the better match is kept (match_type name-only, to check more carefully);
            disambiguation pages are skipped. A title matches when, with titles
            such as Dr, Col or Major left out of the name, it contains every word of the name
            (name_match full) or the name's last word (name_match last name); a guest written as
            a single word with no title ("Vaibhav") never matches. Otherwise the suggestion is blank.
            Answers are cached in data/wikipedia_cache.json, so a re-export asks again only for new
            guests.
  import    From data/guest_links.csv, for rows where verified is "yes": sets linkedin_url and
            linkedin_verified = true when linkedin_url is a linkedin.com/in/ profile, and
            youtube_channel_url and youtube_verified = true when it is a youtube.com/@ or
            youtube.com/channel/ link; for rows where wikipedia_verified is "yes": sets
            wikipedia_url, wikipedia_description and wikipedia_verified = true when wikipedia_url is
            an en.wikipedia.org/wiki/ link. Written on every row of that guest_key.
  check     Runs 07_check.check_guest again on this run's guest rows only and writes verified and
            check_notes where they change (a "bio trimmed" note from recover is kept).

Nothing here fetches LinkedIn, YouTube or Google pages: those URLs are searches for a person to
open. The only site asked anything is the Wikipedia API.
Contact data stays limited to verified LinkedIn and YouTube channel links (no phone or email).

Usage:
    .venv\\Scripts\\python.exe pipeline\\12_guest_links.py diagnose|recover|merge|export|import|check
"""

import argparse
import csv
import importlib.util
import json
import logging
import random
import re
import sys
import time
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path
from urllib.parse import quote, quote_plus

import requests
from dotenv import load_dotenv
from postgrest.exceptions import APIError

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
RUN_ID_PATH = DATA_DIR / "extractions" / "haiku" / "v5" / "run_id.txt"
KEYS_PATH = DATA_DIR / "guest_keys.json"
LINKS_CSV = DATA_DIR / "guest_links.csv"
BACKUP_DIR = DATA_DIR / "backups"
EXPORT_TOP = 50
SAMPLE_TITLES = 10
SAMPLE_SEED = 1
NUMBER_REASON = "number not in the cited lines"
CSV_FIELDS = ["guest_key", "name", "organisation", "episode_title", "google_search_url", "linkedin_search_url",
              "youtube_search_url", "linkedin_url", "youtube_channel_url", "verified",
              "wikipedia_url_suggested", "match_type", "name_match", "wikipedia_description", "wikipedia_url",
              "wikipedia_verified"]
TYPED_FIELDS = ["linkedin_url", "youtube_channel_url", "verified", "wikipedia_url", "wikipedia_verified"]
WIKI_API = "https://en.wikipedia.org/w/api.php"
WIKI_USER_AGENT = ("RSGPT/0.1 (private, unofficial research project on the Figuring Out podcast archive; "
                   "https://github.com/Arjaiauto/rsgpt) python-requests")
WIKI_PAUSE_SECONDS = 1.0
WIKI_CACHE = DATA_DIR / "wikipedia_cache.json"
WIKI_RETRIES = 3
DISAMBIGUATION = "Topics referred to by the same term"  # Wikipedia's short description of a disambiguation page
TITLES = {"dr", "prof", "professor", "mr", "mrs", "ms", "shri", "smt", "sri", "adv", "ca"}
# Left out of a name before it is compared with a Wikipedia title (TITLES plus ranks).
NAME_PREFIXES = TITLES | {"major", "maj", "col", "colonel", "lt", "gen", "general", "capt", "captain", "brig",
                          "brigadier", "cdr", "commander", "sqn", "ldr", "wg", "air", "marshal", "admiral", "justice",
                          "sir"}
ORG_SUFFIXES = {"pvt", "private", "ltd", "limited", "inc", "llp", "the", "co", "company", "corp", "corporation"}
LINKEDIN_PROFILE = re.compile(r"^https?://([a-z]{2,3}\.)?(www\.)?linkedin\.com/in/[^/?#\s]+/?(\?.*)?$", re.I)
YOUTUBE_CHANNEL = re.compile(r"^https?://(www\.|m\.)?youtube\.com/(@[^/?#\s]+|channel/[^/?#\s]+)/?(\?.*)?$", re.I)
WIKIPEDIA_PAGE = re.compile(r"^https?://en\.wikipedia\.org/wiki/[^\s?#]+$", re.I)
GUEST_KEY_SQL = ("alter table public.guests add column if not exists guest_key text;\n"
                 "create index if not exists guests_guest_key_idx on public.guests (guest_key);")

log = logging.getLogger("guests")


def load_module(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


check = load_module("check", "07_check.py")
db_call, fetch = check.db_call, check.fetch


def run_id() -> str:
    return RUN_ID_PATH.read_text(encoding="utf-8").strip()


def reasons(notes: str | None) -> list[str]:
    """The check reasons in a check_notes value, without their details."""
    found = []
    for part in (notes or "").split("; "):
        part = part.strip()
        if part.startswith("check: "):
            part = part[len("check: "):]
        if part and not part.startswith("question_type:"):
            found.append(re.sub(r" \(.*$", "", part))
    return found


# ---------- diagnose ----------

def diagnose(db) -> None:
    rid = run_id()
    episodes = fetch(db, "episodes", "video_id,title,status", order="video_id")
    transcribed = {e["video_id"]: e for e in episodes if e["status"] == "transcribed"}
    guests = fetch(db, "guests", "id,video_id,name,verified,check_notes", run_id=rid)
    by_ep = defaultdict(list)
    for g in guests:
        by_ep[g["video_id"]].append(g)
    verified = [v for v in transcribed if any(g["verified"] for g in by_ep[v])]
    failed_only = [v for v in transcribed if by_ep[v] and not any(g["verified"] for g in by_ep[v])]
    none = [v for v in transcribed if not by_ep[v]]
    failed_rows = [g for g in guests if not g["verified"]]
    reason_rows = Counter(r for g in failed_rows for r in set(reasons(g["check_notes"])))
    only_reason = Counter(reasons(g["check_notes"])[0] for g in failed_rows if len(set(reasons(g["check_notes"]))) == 1)

    print(f"\nGuests of run {rid}: {len(guests)} rows ({sum(g['verified'] for g in guests)} verified, "
          f"{len(failed_rows)} failed) for {len(transcribed)} transcribed episodes")
    print(f"  (a) episodes with a verified guest:                 {len(verified)}")
    print(f"  (b) episodes with guest rows, none verified:        {len(failed_only)}")
    print(f"      episodes with a failed row (verified or not):  "
          f"{sum(1 for v in transcribed if any(not g['verified'] for g in by_ep[v]))}")
    print(f"  (c) episodes with no guest row:                     {len(none)}")
    print(f"\nFailed guest rows by check_notes reason (a row can have several; 'only' = its single reason):")
    for reason, n in reason_rows.most_common():
        print(f"  {n:4}  (only {only_reason.get(reason, 0):3})  {reason}")
    rng = random.Random(SAMPLE_SEED)
    print(f"\n{min(SAMPLE_TITLES, len(none))} of the {len(none)} episodes with no guest row (random, seed {SAMPLE_SEED}):")
    for vid in sorted(rng.sample(none, min(SAMPLE_TITLES, len(none)))):
        print(f"  {vid}  {transcribed[vid]['title']}")


# ---------- recover ----------

def sentences(bio: str) -> list[str]:
    return [s.strip() for line in (bio or "").splitlines() for s in re.split(r"(?<=[.!?])\s+", line) if s.strip()]


def cited_sources(ep, merged: dict | None) -> list[dict]:
    ids = ((merged or {}).get("guest") or {}).get("source_segment_ids", [])
    return [ep.segments[i] for i in ids if i in ep.segments]


def source_texts(ep, cited: list[dict]) -> list[str]:
    # The same texts as Episode.check_numbers compares with.
    return ([s["text_roman"] for s in cited] + [s["text_original"] for s in cited]
            + [ep.translation_text(s["start_s"], s["end_s"]) for s in cited])


def recover(db) -> None:
    rid = run_id()
    rows = [g for g in fetch(db, "guests", "*", run_id=rid)
            if not g["verified"] and reasons(g["check_notes"]) == [NUMBER_REASON]]
    log.info("%s failed guest rows have the number check as their only reason", len(rows))
    if not rows:
        return
    merged = check.merged_results(rid)
    meta = {e["video_id"]: e for e in fetch(db, "episodes", "video_id,duration_seconds,caption_language",
                                            order="video_id")}
    outcome, fixes = Counter(), []
    for vid in sorted({g["video_id"] for g in rows}):
        ep = check.Episode(db, vid, meta[vid]["duration_seconds"], meta[vid]["caption_language"])
        for g in (g for g in rows if g["video_id"] == vid):
            sources = source_texts(ep, cited_sources(ep, merged.get(vid)))
            if check.missing_numbers([t for t in (g["name"], g["organisation"], g["role_at_episode"]) if t], sources):
                outcome["number in name, organisation or role: left failed"] += 1
                continue
            kept = [s for s in sentences(g["bio"]) if not check.missing_numbers([s], sources)]
            dropped = len(sentences(g["bio"])) - len(kept)
            if not kept:
                outcome["every bio sentence has an unverified number: left failed"] += 1
                continue
            trimmed = {**g, "bio": "\n".join(kept)}
            failures = check.check_guest(trimmed, ep, merged.get(vid))
            if failures:
                outcome["still fails after trimming: left failed"] += 1
                log.info("%s #%s still fails: %s", vid, g["id"], failures)
                continue
            outcome["recovered"] += 1
            fixes.append((g, trimmed["bio"], dropped))
    if fixes:
        BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        backup = BACKUP_DIR / f"guest_bio_recover_{time.strftime('%Y%m%d-%H%M%S')}.csv"
        with backup.open("w", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            w.writerow(["id", "video_id", "name", "old_bio", "new_bio", "old_check_notes"])
            for g, bio, _ in fixes:
                w.writerow([g["id"], g["video_id"], g["name"], g["bio"], bio, g["check_notes"]])
        log.info("Backed up %s bios to %s", len(fixes), backup)
        for g, bio, dropped in fixes:
            values = {"bio": bio, "verified": True,
                      "check_notes": f"bio trimmed: {dropped} sentence(s) with a number not in the cited lines removed"}
            db_call("guests update", lambda: db.table("guests").update(values).eq("id", g["id"]).execute())
    print(f"\nRecovery of {len(rows)} guest rows that failed only on numbers:")
    for k, n in outcome.most_common():
        print(f"  {n:4}  {k}")
    print(f"  sentences removed: {sum(d for _, _, d in fixes)} from {len(fixes)} bios")


# ---------- merge ----------

def plain(text: str | None) -> list[str]:
    text = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", " ", text).split()


def norm_name(name: str | None) -> str:
    words = plain(name)
    while words and words[0] in TITLES:
        words = words[1:]
    return " ".join(words)


def norm_org(org: str | None) -> str:
    return " ".join(w for w in plain(org) if w not in ORG_SUFFIXES)


def key_of(g: dict) -> str:
    # The organisation is compared without spaces: "Jio Star" and "JioStar" are one organisation.
    return "-".join(norm_name(g["name"]).split()) + "--" + "".join(norm_org(g["organisation"]).split())


def has_guest_key(db) -> bool:
    try:
        db.table("guests").select("guest_key").limit(1).execute()
        return True
    except APIError as exc:
        if exc.code == "42703":  # undefined column
            return False
        raise


def merge(db) -> dict[int, str]:
    guests = fetch(db, "guests", "id,video_id,name,organisation,verified", run_id=run_id())
    keys = {g["id"]: key_of(g) for g in guests if norm_name(g["name"])}
    orgs_of = defaultdict(set)
    for k in set(keys.values()):
        name_part, org_part = k.split("--")
        if org_part:
            orgs_of[name_part].add(k)
    aliases, base = {}, dict(keys)
    for i, k in base.items():
        name_part, org_part = k.split("--")
        if not org_part and len(name_part.split("-")) >= 2 and len(orgs_of[name_part]) == 1:
            aliases[k] = keys[i] = next(iter(orgs_of[name_part]))
    groups = defaultdict(list)
    for g in guests:
        if g["id"] in keys:
            groups[keys[g["id"]]].append(g)
    multi = {k: v for k, v in groups.items() if len({g["video_id"] for g in v}) > 1}
    if KEYS_PATH.exists():  # keep earlier aliases, so typed values under an older key are still found
        aliases = {**json.loads(KEYS_PATH.read_text(encoding="utf-8")).get("aliases", {}), **aliases}
    KEYS_PATH.write_text(json.dumps({"run_id": run_id(), "keys": {str(i): k for i, k in keys.items()},
                                     "aliases": aliases}, indent=1), encoding="utf-8")
    print(f"\nMerge of {len(guests)} guest rows: {len(groups)} guest_keys; {len(multi)} keys span more than one "
          f"episode ({sum(len(v) for v in multi.values())} rows)")
    for k, v in sorted(multi.items(), key=lambda kv: -len(kv[1]))[:15]:
        print(f"  {len({g['video_id'] for g in v})} episodes  {k}")
    by_name = defaultdict(set)
    for k in groups:
        by_name[k.split("--")[0]].add(k)
    split = {n: ks for n, ks in by_name.items() if len(ks) > 1}
    print(f"  rows with no organisation joined to the one organisation of the same full name: "
          f"{sum(1 for i in keys if keys[i] != base[i])} "
          f"({', '.join(sorted({keys[i] for i in keys if keys[i] != base[i]}))})")
    print(f"  same normalised name but a different organisation (not merged): {len(split)} names")
    for n, ks in sorted(split.items())[:10]:
        print(f"    {n}: {', '.join(sorted(k.split('--')[1] or '(none)' for k in ks))}")
    print(f"  keys saved to {KEYS_PATH.relative_to(ROOT)}")
    if has_guest_key(db):
        by_key = defaultdict(list)
        for i, k in keys.items():
            by_key[k].append(i)
        for k, ids in by_key.items():
            db_call("guests update", lambda: db.table("guests").update({"guest_key": k}).in_("id", ids).execute())
        print(f"  guest_key written to {len(keys)} rows")
    else:
        print("  guests.guest_key does not exist yet; run this in the Supabase SQL Editor, then merge again:\n\n"
              + GUEST_KEY_SQL + "\n")
    return keys


def saved_aliases() -> dict[str, str]:
    """Earlier guest_key -> the key it was merged into."""
    return json.loads(KEYS_PATH.read_text(encoding="utf-8")).get("aliases", {}) if KEYS_PATH.exists() else {}


def saved_keys() -> dict[int, str]:
    if not KEYS_PATH.exists():
        sys.exit("run the merge command first")
    return {int(i): k for i, k in json.loads(KEYS_PATH.read_text(encoding="utf-8"))["keys"].items()}


# ---------- export / import ----------

class Wikipedia:
    """The official Wikipedia API, one request at a time with a pause, answers cached on disk."""

    def __init__(self):
        self.session = requests.Session()
        self.session.headers["User-Agent"] = WIKI_USER_AGENT
        self.cache = json.loads(WIKI_CACHE.read_text(encoding="utf-8")) if WIKI_CACHE.exists() else {}
        self.last = 0.0
        self.requests = 0

    def get(self, params: dict) -> dict:
        key = json.dumps(params, sort_keys=True)
        if key in self.cache:
            return self.cache[key]
        for attempt in range(1, WIKI_RETRIES + 1):
            time.sleep(max(0.0, self.last + WIKI_PAUSE_SECONDS - time.monotonic()))
            self.last = time.monotonic()
            self.requests += 1
            try:
                r = self.session.get(WIKI_API, params={**params, "format": "json", "formatversion": 2}, timeout=30)
                if r.status_code in (429, 500, 502, 503, 504) and attempt < WIKI_RETRIES:
                    time.sleep(10 * attempt)
                    continue
                r.raise_for_status()
                break
            except requests.ConnectionError:
                if attempt == WIKI_RETRIES:
                    raise
                time.sleep(10 * attempt)
        self.cache[key] = r.json()
        tmp = WIKI_CACHE.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(self.cache, ensure_ascii=False), encoding="utf-8")
        tmp.replace(WIKI_CACHE)
        return self.cache[key]

    def top_title(self, query: str) -> str:
        found = self.get({"action": "query", "list": "search", "srsearch": query, "srlimit": 1})
        hits = found.get("query", {}).get("search", [])
        return hits[0]["title"] if hits else ""

    def description(self, title: str) -> str:
        pages = self.get({"action": "query", "prop": "description", "titles": title}).get("query", {}).get("pages", [])
        return (pages[0].get("description") or "") if pages else ""

    def suggest(self, name: str, org: str) -> dict:
        """The best of the top search results for name + organisation and for the name alone:
        wikipedia_url_suggested, match_type, name_match, wikipedia_description (all blank when neither
        matches). A full-name match beats a last-name match, and name + organisation beats name only
        within each; disambiguation pages are skipped. The name-only search is sent only when the
        name + organisation result is not a full-name match."""
        tries = [(f"{name} {org}", "name+org"), (name, "name-only")] if org.strip() else [(name, "name-only")]
        found = []
        for query, match_type in tries:
            title = self.top_title(query.strip())
            name_match = title_match(title, name) if title else ""
            if name_match:
                description = self.description(title)
                if description != DISAMBIGUATION:
                    found.append((name_match != "full", len(found), title, match_type, name_match, description))
            if found and not found[0][0]:  # a full-name match from name + organisation: no need for more
                break
        if not found:
            return {"wikipedia_url_suggested": "", "match_type": "", "name_match": "", "wikipedia_description": ""}
        _, _, title, match_type, name_match, description = min(found)
        return {"wikipedia_url_suggested": "https://en.wikipedia.org/wiki/" + quote(title.replace(" ", "_")),
                "match_type": match_type, "name_match": name_match, "wikipedia_description": description}


def title_match(title: str, name: str) -> str:
    """How the page title matches the guest's name, with titles and ranks (Dr, Col, Major, Prof, Sir ...)
    left out of the name: "full" when every word of the name is a word of the title, "last name" when
    only its last word is, "" otherwise. A name written as one word with no title never matches."""
    written = plain(name)
    words = list(written)
    while words and words[0] in NAME_PREFIXES:
        words = words[1:]
    if not words or len(written) < 2:
        return ""
    title_words = set(plain(re.sub(r"\(.*?\)", " ", title)))
    if set(words) <= title_words:
        return "full"
    return "last name" if words[-1] in title_words else ""


def read_links_csv() -> dict[str, dict]:
    """The existing sheet by guest_key, read as UTF-8 (with or without BOM) or, if saved by Excel
    in the Windows code page, as cp1252."""
    if not LINKS_CSV.exists():
        return {}
    for encoding in ("utf-8-sig", "cp1252"):
        try:
            with LINKS_CSV.open(newline="", encoding=encoding) as f:
                return {r["guest_key"]: r for r in csv.DictReader(f) if r.get("guest_key")}
        except UnicodeDecodeError:
            continue
    sys.exit(f"cannot read {LINKS_CSV}: save it as CSV UTF-8")


def export(db) -> None:
    keys = saved_keys()
    guests = [g for g in fetch(db, "guests", "id,video_id,name,organisation,verified,linkedin_url,"
                                             "youtube_channel_url,wikipedia_url,wikipedia_description",
                               run_id=run_id())
              if g["verified"] and g["id"] in keys]
    episodes = {e["video_id"]: e for e in fetch(db, "episodes", "video_id,title,view_count", order="video_id")}
    groups = defaultdict(list)
    for g in guests:
        groups[keys[g["id"]]].append(g)

    def views(rows):
        return sum(episodes[v]["view_count"] or 0 for v in {g["video_id"] for g in rows})

    ranked = sorted(groups.items(), key=lambda kv: (-views(kv[1]), kv[0]))[:EXPORT_TOP]
    old = read_links_csv()
    aliases = saved_aliases()
    wiki = Wikipedia()
    out = []
    for n, (key, rows) in enumerate(ranked, 1):
        name = Counter(g["name"] for g in rows).most_common(1)[0][0]
        org = Counter(g["organisation"] or "" for g in rows).most_common(1)[0][0]
        vids = sorted({g["video_id"] for g in rows}, key=lambda v: -(episodes[v]["view_count"] or 0))
        prev = old.get(key) or next((old[k] for k, new in aliases.items() if new == key and k in old), {})
        suggestion = wiki.suggest(name, org)
        if n % 10 == 0:
            log.info("Wikipedia: %s of %s guests looked up (%s API requests this run)", n, len(ranked), wiki.requests)

        def from_db(field):
            return next((g[field] for g in rows if g[field]), "")

        out.append({
            "guest_key": key, "name": name, "organisation": org,
            "episode_title": " | ".join(episodes[v]["title"] for v in vids),
            "google_search_url": "https://www.google.com/search?q=" + quote_plus(f"{name} {org}".strip()),
            "linkedin_search_url": "https://www.google.com/search?q=" + quote_plus(f"{name} {org} LinkedIn".strip()),
            "youtube_search_url": "https://www.youtube.com/results?search_query=" + quote_plus(name),
            **suggestion,
            # An earlier description is kept (it may have been edited) while it still belongs to the same
            # page: the suggestion is unchanged, or a wikipedia_url was typed.
            "wikipedia_description": ((prev.get("wikipedia_description") if prev.get("wikipedia_url") or
                                       prev.get("wikipedia_url_suggested") == suggestion["wikipedia_url_suggested"]
                                       else "") or from_db("wikipedia_description")
                                      or suggestion["wikipedia_description"]),
            **{f: prev.get(f) or (from_db(f) if f in ("linkedin_url", "youtube_channel_url", "wikipedia_url") else "")
               for f in TYPED_FIELDS},
        })
    tmp = LINKS_CSV.with_suffix(".csv.tmp")
    with tmp.open("w", newline="", encoding="utf-8-sig") as f:  # BOM so Excel reads UTF-8
        w = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        w.writeheader()
        w.writerows(out)
    tmp.replace(LINKS_CSV)
    kept = sum(1 for r in out if any(old.get(r["guest_key"], {}).get(f) for f in TYPED_FIELDS))
    print(f"\nExport: {len(groups)} merged guests with a verified row; top {len(out)} by total episode views "
          f"written to {LINKS_CSV.relative_to(ROOT)}; {kept} kept values typed in the earlier sheet")
    print(f"  Wikipedia suggestion for {sum(1 for r in out if r['wikipedia_url_suggested'])} of {len(out)}: "
          f"{sum(1 for r in out if r['match_type'] == 'name+org')} name+org, "
          f"{sum(1 for r in out if r['match_type'] == 'name-only')} name-only; "
          f"{sum(1 for r in out if r['name_match'] == 'last name')} on the last name only "
          f"({wiki.requests} API requests this run, the rest from {WIKI_CACHE.relative_to(ROOT)})")
    for n, (key, rows) in enumerate(ranked[:10], 1):
        print(f"  {n:2}. {views(rows):>12,} views  {out[n - 1]['name']} ({out[n - 1]['organisation']}), "
              f"{len({g['video_id'] for g in rows})} episode(s)")


def import_links(db) -> None:
    keys = saved_keys()
    if not LINKS_CSV.exists():
        sys.exit(f"missing {LINKS_CSV}; run export first")
    ids_of = defaultdict(list)
    for i, k in keys.items():
        ids_of[k].append(i)
    rows = list(read_links_csv().values())
    counts = Counter()
    for r in rows:
        values = {}
        if (r.get("wikipedia_verified") or "").strip().lower() == "yes":
            url = (r.get("wikipedia_url") or "").strip()
            if WIKIPEDIA_PAGE.match(url):
                values |= {"wikipedia_url": url, "wikipedia_verified": True,
                           "wikipedia_description": (r.get("wikipedia_description") or "").strip() or None}
                counts["wikipedia_verified set"] += 1
            else:
                log.warning("%s: %r is not an en.wikipedia.org/wiki/ link, skipped", r["guest_key"], url)
                counts["wikipedia_url skipped (not an en.wikipedia.org/wiki/ link)"] += 1
        if (r.get("verified") or "").strip().lower() != "yes":
            counts["links not marked yes"] += 1
        for field, flag, pattern, label in (("linkedin_url", "linkedin_verified", LINKEDIN_PROFILE, "linkedin.com/in/"),
                                            ("youtube_channel_url", "youtube_verified", YOUTUBE_CHANNEL,
                                             "youtube.com/@ or youtube.com/channel/")):
            url = (r[field] or "").strip()
            if not url or (r.get("verified") or "").strip().lower() != "yes":
                continue
            if pattern.match(url):
                values |= {field: url, flag: True}
                counts[f"{flag} set"] += 1
            else:
                log.warning("%s: %r is not a %s link, skipped", r["guest_key"], url, label)
                counts[f"{field} skipped (not a {label} link)"] += 1
        ids = ids_of.get(r["guest_key"], [])
        if values and ids:
            db_call("guests update", lambda: db.table("guests").update(values).in_("id", ids).execute())
    print(f"\nImport from {LINKS_CSV.relative_to(ROOT)}:")
    for k, n in sorted(counts.items()):
        print(f"  {n:4}  {k}")


def check_guests(db) -> None:
    rid = run_id()
    guests = fetch(db, "guests", "*", run_id=rid)
    merged = check.merged_results(rid)
    meta = {e["video_id"]: e for e in fetch(db, "episodes", "video_id,duration_seconds,caption_language",
                                            order="video_id")}
    changes, reasons_seen = {}, Counter()
    for vid in sorted({g["video_id"] for g in guests}):
        ep = check.Episode(db, vid, meta[vid]["duration_seconds"], meta[vid]["caption_language"])
        for g in (g for g in guests if g["video_id"] == vid):
            failures = check.check_guest(g, ep, merged.get(vid))
            reasons_seen.update(r for r, _ in failures)
            kept = [n.strip() for n in (g["check_notes"] or "").split(";") if n.strip().startswith("bio trimmed:")]
            notes = check.notes_for(None, failures)
            values = {"verified": not failures, "check_notes": "; ".join(kept + ([notes] if notes else [])) or None}
            if any(g.get(k) != v for k, v in values.items()):
                changes[g["id"]] = values
    if changes:
        check.write_updates(db, "guests", changes)
    passed = sum(1 for g in guests if changes.get(g["id"], g)["verified"])
    print(f"\nGuest check of run {rid}: {len(guests)} rows, {passed} verified, {len(guests) - passed} failed; "
          f"{len(changes)} rows changed")
    for reason, n in reasons_seen.most_common():
        print(f"  {n:4}  {reason}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["diagnose", "recover", "merge", "export", "import", "check"])
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    load_dotenv(ROOT / ".env")
    db = check.captions.supabase_client()
    {"diagnose": diagnose, "recover": recover, "merge": merge, "export": export, "import": import_links,
     "check": check_guests}[args.command](db)


if __name__ == "__main__":
    main()
