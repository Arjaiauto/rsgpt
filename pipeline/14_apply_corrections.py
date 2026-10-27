"""Apply pipeline/corrections.json to the rows already in the database.

For the scoped episodes of the final extraction run it corrects:
  guests    organisation, role_at_episode, bio; linkedin_search_url is written again when the organisation changes;
            guest_key moves to the key in corrections.json "guest_keys" (and a merged guest keeps the links the
            other row had: YouTube / Wikipedia link and link_source, where its own are empty)
  insights  text (takeaways, quotes, opportunities, disagreements and the host's opinions and questions)
  clips     topic, opening_line
and in the working files data/guest_keys.json (key and alias) and data/guest_links.csv (the sheet row).

Every changed field is printed with its old and new value, and the old values are saved to
data/backups/corrections_<timestamp>.csv first. Safe to run again: rows already correct are left alone.
06_extract.py and site_stats.py apply the same file themselves, so a re-run of either keeps the corrections.

Usage:
    .venv\\Scripts\\python.exe pipeline\\14_apply_corrections.py --dry-run   print the changes only
    .venv\\Scripts\\python.exe pipeline\\14_apply_corrections.py             apply them
"""

import argparse
import csv
import json
import logging
import shutil
import sys
import time
from pathlib import Path
from urllib.parse import quote_plus

from dotenv import load_dotenv

sys.path.insert(0, str(Path(__file__).resolve().parent))
import corrections_lib  # noqa: E402
import db_lib  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
RUN_ID_PATH = DATA / "extractions" / "haiku" / "v5" / "run_id.txt"
KEYS_PATH = DATA / "guest_keys.json"
LINKS_CSV = DATA / "guest_links.csv"
BACKUPS = DATA / "backups"
LINK_FIELDS = ("youtube_channel_url", "youtube_verified", "wikipedia_url", "wikipedia_description", "wikipedia_verified", "link_source")

log = logging.getLogger("corrections")


def pages(db, table: str, columns: str, run_id: str, video_ids: list[str]) -> list[dict]:
    rows, start = [], 0
    while True:
        page = db_lib.call(f"{table} select", lambda: db.table(table).select(columns).eq("run_id", run_id)
                           .in_("video_id", video_ids).order("id").range(start, start + 999).execute(), db).data
        rows += page
        if len(page) < 1000:
            return rows
        start += 1000


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true", help="print the changes, write nothing")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    load_dotenv(ROOT / ".env")
    db = db_lib.client()
    corr = corrections_lib.load()
    run_id = RUN_ID_PATH.read_text(encoding="utf-8").strip()
    video_ids = sorted({v for r in corr.rules for v in r["videos"]})
    if not video_ids:
        sys.exit("corrections.json has no scoped episodes")

    guest_cols = ("id,video_id,guest_key,name,organisation,role_at_episode,bio,linkedin_search_url,verified,"
                  + ",".join(LINK_FIELDS))
    guests = pages(db, "guests", guest_cols, run_id, video_ids)
    insights = pages(db, "insights", "id,video_id,type,text,verified", run_id, video_ids)
    clips = pages(db, "clips", "id,video_id,topic,opening_line,verified", run_id, video_ids)
    log.info("scanning %s guest rows, %s insights, %s clips in %s episodes", len(guests), len(insights), len(clips), len(video_ids))

    changes: list[tuple[str, dict, dict]] = []  # (table, row, {field: new value})
    for g in guests:
        new = corr.fix_fields(g, ("organisation", "role_at_episode", "bio"))
        if "organisation" in new:
            new["linkedin_search_url"] = corrections_lib.linkedin_search_url(g["name"], new["organisation"])
        key = corr.guest_key(g["guest_key"])
        if key != g["guest_key"]:
            new["guest_key"] = key
        if new:
            changes.append(("guests", g, new))
    # A merged guest keeps the links the other row had (the link fields are written on every row of a guest_key).
    final_key = {g["id"]: corr.guest_key(g["guest_key"]) for g in guests}
    moved_keys = {final_key[g["id"]] for g in guests if final_key[g["id"]] != g["guest_key"]}
    for key in moved_keys:
        group = [g for g in guests if final_key[g["id"]] == key]
        donor = next((g for g in group if g["youtube_channel_url"] or g["wikipedia_url"]), None)
        for g in group:
            if donor and donor is not g and not (g["youtube_channel_url"] or g["wikipedia_url"]):
                extra = {f: donor[f] for f in LINK_FIELDS if donor[f] != g[f]}
                existing = next((c for c in changes if c[0] == "guests" and c[1]["id"] == g["id"]), None)
                if existing:
                    existing[2].update(extra)
                elif extra:
                    changes.append(("guests", g, extra))
    for i in insights:
        new = corr.fix_fields(i, ("text",))
        if new:
            changes.append(("insights", i, new))
    for c in clips:
        new = corr.fix_fields(c, ("topic", "opening_line"))
        if new:
            changes.append(("clips", c, new))

    print(f"\n{len(changes)} rows to change ({sum(len(n) for _, _, n in changes)} fields):")
    for table, row, new in changes:
        state = "verified" if row.get("verified") else "NOT verified"
        label = row.get("name") or row.get("type") or row.get("topic") or ""
        print(f"\n[{table}] id {row['id']}  episode {row['video_id']}  {state}  {label}")
        for field, value in new.items():
            print(f"  {field}:")
            print("    before: " + str(row.get(field)).replace("\n", "\n            "))
            print("    after:  " + str(value).replace("\n", "\n            "))
    if not changes:
        print("Nothing to change: every row already has the corrections.")
    if args.dry_run or not changes:
        log.info("dry run: nothing written" if args.dry_run else "nothing to write")
    else:
        BACKUPS.mkdir(parents=True, exist_ok=True)
        stamp = time.strftime("%Y%m%d-%H%M%S")
        backup = BACKUPS / f"corrections_{stamp}.csv"
        with backup.open("w", newline="", encoding="utf-8-sig") as f:
            w = csv.writer(f)
            w.writerow(["table", "id", "video_id", "field", "before", "after"])
            for table, row, new in changes:
                for field, value in new.items():
                    w.writerow([table, row["id"], row["video_id"], field, row.get(field), value])
        log.info("old values saved to %s", backup.relative_to(ROOT))
        for table, row, new in changes:
            db_lib.call(f"{table} update", lambda: db.table(table).update(new).eq("id", row["id"]).execute(), db)
        log.info("%s rows written", len(changes))

    # Working files: the guest_key map (with the old key as an alias) and the links sheet.
    renamed = {g["id"]: final_key[g["id"]] for g in guests if final_key[g["id"]] != g["guest_key"]}
    if renamed and not args.dry_run and KEYS_PATH.exists():
        data = json.loads(KEYS_PATH.read_text(encoding="utf-8"))
        for i, key in renamed.items():
            data["keys"][str(i)] = key
        data.setdefault("aliases", {}).update({old: new for old, new in corr.keys.items()})
        KEYS_PATH.write_text(json.dumps(data, indent=1), encoding="utf-8")
        log.info("data/guest_keys.json: %s ids moved, alias saved", len(renamed))
    if corr.keys and LINKS_CSV.exists() and not args.dry_run:
        with LINKS_CSV.open(newline="", encoding="utf-8-sig") as f:
            reader = csv.DictReader(f)
            fields, sheet = reader.fieldnames, list(reader)
        have = {r["guest_key"] for r in sheet}
        touched = 0
        for r in sheet:
            new_key = corr.keys.get(r["guest_key"])
            if not new_key:
                continue
            if new_key in have:
                log.warning("links sheet already has %s; its %s row is left as it is", new_key, r["guest_key"])
                continue
            old_key, r["guest_key"] = r["guest_key"], new_key
            r["organisation"] = corr.fix_text(r["organisation"], guest_key=old_key, field="organisation") or r["organisation"]
            r["google_search_url"] = "https://www.google.com/search?q=" + quote_plus(f"{r['name']} {r['organisation']}".strip())
            r["linkedin_search_url"] = corrections_lib.linkedin_search_url(r["name"], r["organisation"])
            touched += 1
        if touched:
            shutil.copy(LINKS_CSV, BACKUPS / f"guest_links_{time.strftime('%Y%m%d-%H%M%S')}.csv")
            with LINKS_CSV.open("w", newline="", encoding="utf-8-sig") as f:
                w = csv.DictWriter(f, fieldnames=fields)
                w.writeheader()
                w.writerows(sheet)
            log.info("data/guest_links.csv: %s row moved to its new guest_key", touched)


if __name__ == "__main__":
    main()
