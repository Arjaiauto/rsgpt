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
            and normalised organisation (no Pvt / Ltd etc., spaces ignored) are equal get one guest_key (no row is deleted). Keys are saved to
            data/guest_keys.json and written to guests.guest_key when that column exists.
  export    Merged guests with at least one verified row, ranked by the total views of their
            episodes; the top EXPORT_TOP go to data/guest_links.csv with search URLs to check by
            hand. Values already filled in an existing CSV (links, verified) are kept.
  import    From data/guest_links.csv, sets linkedin_url and linkedin_verified = true on the
            guest's rows only where verified is "yes" and linkedin_url is a linkedin.com/in/ profile.

Nothing here fetches LinkedIn or YouTube pages: the URLs are searches for a person to open.
Contact data stays limited to verified LinkedIn and YouTube channel links (no phone or email).

Usage:
    .venv\\Scripts\\python.exe pipeline\\12_guest_links.py diagnose|recover|merge|export|import
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
from urllib.parse import quote_plus

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
CSV_FIELDS = ["guest_key", "name", "organisation", "episode_title", "linkedin_search_url", "youtube_search_url",
              "linkedin_url", "youtube_channel_url", "verified"]
TITLES = {"dr", "prof", "professor", "mr", "mrs", "ms", "shri", "smt", "sri", "adv", "ca"}
ORG_SUFFIXES = {"pvt", "private", "ltd", "limited", "inc", "llp", "the", "co", "company", "corp", "corporation"}
LINKEDIN_PROFILE = re.compile(r"^https?://([a-z]{2,3}\.)?(www\.)?linkedin\.com/in/[^/?#\s]+/?(\?.*)?$", re.I)
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
    groups = defaultdict(list)
    for g in guests:
        if g["id"] in keys:
            groups[keys[g["id"]]].append(g)
    multi = {k: v for k, v in groups.items() if len({g["video_id"] for g in v}) > 1}
    KEYS_PATH.write_text(json.dumps({"run_id": run_id(), "keys": {str(i): k for i, k in keys.items()}}, indent=1),
                         encoding="utf-8")
    print(f"\nMerge of {len(guests)} guest rows: {len(groups)} guest_keys; {len(multi)} keys span more than one "
          f"episode ({sum(len(v) for v in multi.values())} rows)")
    for k, v in sorted(multi.items(), key=lambda kv: -len(kv[1]))[:15]:
        print(f"  {len({g['video_id'] for g in v})} episodes  {k}")
    by_name = defaultdict(set)
    for k in groups:
        by_name[k.split("--")[0]].add(k)
    split = {n: ks for n, ks in by_name.items() if len(ks) > 1}
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


def saved_keys() -> dict[int, str]:
    if not KEYS_PATH.exists():
        sys.exit("run the merge command first")
    return {int(i): k for i, k in json.loads(KEYS_PATH.read_text(encoding="utf-8"))["keys"].items()}


# ---------- export / import ----------

def export(db) -> None:
    keys = saved_keys()
    guests = [g for g in fetch(db, "guests", "id,video_id,name,organisation,verified,linkedin_url,"
                                             "youtube_channel_url", run_id=run_id())
              if g["verified"] and g["id"] in keys]
    episodes = {e["video_id"]: e for e in fetch(db, "episodes", "video_id,title,view_count", order="video_id")}
    groups = defaultdict(list)
    for g in guests:
        groups[keys[g["id"]]].append(g)

    def views(rows):
        return sum(episodes[v]["view_count"] or 0 for v in {g["video_id"] for g in rows})

    ranked = sorted(groups.items(), key=lambda kv: (-views(kv[1]), kv[0]))[:EXPORT_TOP]
    old = {}
    if LINKS_CSV.exists():
        with LINKS_CSV.open(newline="", encoding="utf-8") as f:
            old = {r["guest_key"]: r for r in csv.DictReader(f)}
    out = []
    for key, rows in ranked:
        name = Counter(g["name"] for g in rows).most_common(1)[0][0]
        org = Counter(g["organisation"] or "" for g in rows).most_common(1)[0][0]
        vids = sorted({g["video_id"] for g in rows}, key=lambda v: -(episodes[v]["view_count"] or 0))
        prev = old.get(key, {})
        out.append({
            "guest_key": key, "name": name, "organisation": org,
            "episode_title": " | ".join(episodes[v]["title"] for v in vids),
            "linkedin_search_url": "https://www.google.com/search?q=" + quote_plus(f"{name} {org} LinkedIn".strip()),
            "youtube_search_url": "https://www.youtube.com/results?search_query=" + quote_plus(name),
            "linkedin_url": prev.get("linkedin_url") or next((g["linkedin_url"] for g in rows if g["linkedin_url"]), ""),
            "youtube_channel_url": prev.get("youtube_channel_url")
                                   or next((g["youtube_channel_url"] for g in rows if g["youtube_channel_url"]), ""),
            "verified": prev.get("verified", ""),
        })
    tmp = LINKS_CSV.with_suffix(".csv.tmp")
    with tmp.open("w", newline="", encoding="utf-8-sig") as f:  # BOM so Excel reads UTF-8
        w = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        w.writeheader()
        w.writerows(out)
    tmp.replace(LINKS_CSV)
    print(f"\nExport: {len(groups)} merged guests with a verified row; top {len(out)} by total episode views "
          f"written to {LINKS_CSV.relative_to(ROOT)} ({sum(1 for r in out if r['verified'])} keep an earlier verified value)")
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
    with LINKS_CSV.open(newline="", encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    done = skipped = 0
    for r in rows:
        url = (r["linkedin_url"] or "").strip()
        if r["verified"].strip().lower() != "yes":
            continue
        if not LINKEDIN_PROFILE.match(url):
            log.warning("%s: verified yes but %r is not a linkedin.com/in/ profile link, skipped", r["guest_key"], url)
            skipped += 1
            continue
        ids = ids_of.get(r["guest_key"], [])
        db_call("guests update", lambda: db.table("guests").update({"linkedin_url": url, "linkedin_verified": True})
                .in_("id", ids).execute())
        done += 1
    print(f"\nImport: linkedin_verified set for {done} guests; {skipped} skipped (not a linkedin.com/in/ link); "
          f"{sum(1 for r in rows if r['verified'].strip().lower() != 'yes')} not marked yes")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["diagnose", "recover", "merge", "export", "import"])
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    load_dotenv(ROOT / ".env")
    db = check.captions.supabase_client()
    {"diagnose": diagnose, "recover": recover, "merge": merge, "export": export, "import": import_links}[args.command](db)


if __name__ == "__main__":
    main()
