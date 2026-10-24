"""Write data/gate1_report.md from the reviews table and the Fast review files of one run.

Reads, for the run:

- data/review/gate1_sample_<run_id>.json: the Gate 1 sample (item type and episode).
- data/review/ai_precheck_<run_id>.json: Sonnet's verdict and reason per sample item.
- data/review/fast_review_<run_id>.json: set 1 (every item Sonnet did not mark
  supported) and set 2 (a fixed random 100 of the supported ones).
- the reviews table: the latest verdict per item, and its note.

and writes the review sections of the report:

1. Your accuracy per item type on set 1 and set 2, and the estimated accuracy of
   the whole Gate 1 sample: set 1 as reviewed, plus every item Sonnet marked
   supported taken at set 2's accuracy (per type where set 2 has decided items of
   that type, else set 2's overall accuracy). Accuracy is correct / (correct +
   wrong); Unsure is left out.
2. The Wrong items grouped by type, with their text and your notes (and the Unsure ones).
3. How often Sonnet's flags were right per item type, and what it missed in set 2.

The sections after them (checker pass rates, costs, readiness, full-run estimate)
are kept from the existing report as they are, renumbered. Only reads the
database; rerunning it rewrites the report from the current reviews.

With --sample, writes data/gate2_report.md instead, from the Gate 2 sample
(data/gate2_sample.json, gate2_lib.py) and the reviews table: accuracy per item type
and per episode language, the 10 most common notes on Wrong items (notes compared
ignoring case, spacing and end punctuation), and the Wrong items with their notes.

Usage:
    .venv\\Scripts\\python.exe pipeline\\09_gate1_report.py --run-id extract-haiku-v5-20261023-011718
    .venv\\Scripts\\python.exe pipeline\\09_gate1_report.py --sample
"""

import argparse
import importlib.util
import json
import logging
import re
import sys
from collections import Counter
from datetime import datetime, timedelta, timezone
from pathlib import Path

from dotenv import load_dotenv

import gate1_lib
import gate2_lib

ROOT = Path(__file__).resolve().parent.parent
REVIEW_DIR = gate1_lib.REVIEW_DIR
REPORT = ROOT / "data" / "gate1_report.md"
GATE2_REPORT = ROOT / "data" / "gate2_report.md"
LANGUAGE_LABELS = {"en": "English", "hi": "Hindi"}
TOP_NOTES = 10
KEEP_FROM = "Checker pass rates"  # the first kept section of the existing report
TYPE_LABELS = {"guest": "Guest profile", "quote": "Quote", "disagreement": "Disagreement",
               "raj_opinion": "Raj opinion", "raj_question": "Raj question", "opportunity": "Opportunity",
               "takeaway": "Takeaway", "clip": "Clip"}
TYPE_ORDER = ["disagreement", "guest", "clip", "raj_opinion", "opportunity", "takeaway", "raj_question", "quote"]
IST = timezone(timedelta(hours=5, minutes=30))
IN_CHUNK = 200
TEXT_LIMIT = 400

log = logging.getLogger("gate1_report")


def load_module(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


check = load_module("check", "07_check.py")


def read_json(path: Path):
    if not path.exists():
        sys.exit(f"missing {path}; run 08_ai_precheck.py for this run first")
    return json.loads(path.read_text(encoding="utf-8"))


def fetch_ids(db, table: str, columns: str, ids: list[int]) -> list[dict]:
    rows = []
    for n in range(0, len(ids), IN_CHUNK):
        chunk = ids[n:n + IN_CHUNK]
        rows += check.db_call(f"{table} select", lambda: db.table(table).select(columns)
                              .in_("id" if table != "reviews" else "item_id", chunk).execute()).data
    return rows


def latest_reviews(db, keys: list[tuple[str, int]]) -> dict[tuple[str, int], dict]:
    """The latest review row per item, with the latest non-empty note on it."""
    rows = []
    for table in {t for t, _ in keys}:
        ids = sorted(i for t, i in keys if t == table)
        rows += [r for r in fetch_ids(db, "reviews", "*", ids) if r["item_table"] == table]
    latest = {}
    for r in sorted(rows, key=lambda r: (r["created_at"], r["id"])):
        key = (r["item_table"], r["item_id"])
        note = r["note"] or (latest[key]["note"] if key in latest else None)
        latest[key] = {**r, "note": note}
    return latest


def item_texts(db, keys: list[tuple[str, int]]) -> dict[tuple[str, int], str]:
    texts = {}
    for table, columns in (("insights", "id,text"), ("clips", "id,topic,opening_line"),
                           ("guests", "id,name,role_at_episode,organisation,bio")):
        ids = sorted(i for t, i in keys if t == table)
        for r in fetch_ids(db, table, columns, ids) if ids else []:
            if table == "insights":
                text = r["text"]
            elif table == "clips":
                text = f"{r['topic']} (opening line: {r['opening_line']})"
            else:
                text = ", ".join(filter(None, [r["name"], r["role_at_episode"], r["organisation"]])) + ". " + (r["bio"] or "")
            texts[(table, r["id"])] = text
    return texts


def one_line(text: str, limit: int = TEXT_LIMIT) -> str:
    text = re.sub(r"\s+", " ", text or "").strip()
    return text if len(text) <= limit else text[:limit - 1].rstrip() + "…"


def pct(n: float, d: float) -> str:
    return f"{100 * n / d:.0f}%" if d else "–"


def acc_cell(verdicts: list[str]) -> str:
    c, w = verdicts.count("correct"), verdicts.count("wrong")
    return f"{pct(c, c + w)} ({c}/{c + w})" if c + w else "–"


def renumber_kept(text: str, first: int) -> str:
    """The existing report from its KEEP_FROM section on, with its sections renumbered from `first`."""
    match = re.search(rf"^## \d+\. {re.escape(KEEP_FROM)}", text, re.M)
    if not match:
        sys.exit(f"{REPORT} has no '## n. {KEEP_FROM}' section to keep")
    kept, counter = text[match.start():], iter(range(first, 100))
    return re.sub(r"^## \d+\. ", lambda m: f"## {next(counter)}. ", kept, flags=re.M)


def build(run_id: str, sample, pre, fast, reviews, texts, total_rows: int) -> str:
    kind = {(s["table"], s["id"]): s["type"] for s in sample}
    video = {(s["table"], s["id"]): s["video_id"] for s in sample}
    sonnet = {(r["table"], r["id"]): r for r in pre["items"]}
    set1 = [(k["table"], k["id"]) for k in fast["flagged"]]
    set2 = [(k["table"], k["id"]) for k in fast["random_supported"]]
    supported = Counter(kind[k] for k, r in sonnet.items() if r["verdict"] == "supported")
    verdict = {k: r["verdict"] for k, r in reviews.items()}
    v1 = {t: [verdict[k] for k in set1 if kind[k] == t and k in verdict] for t in TYPE_ORDER}
    v2 = {t: [verdict[k] for k in set2 if kind[k] == t and k in verdict] for t in TYPE_ORDER}
    all1 = [verdict[k] for k in set1 if k in verdict]
    all2 = [verdict[k] for k in set2 if k in verdict]
    c2, w2 = all2.count("correct"), all2.count("wrong")
    acc2 = c2 / (c2 + w2) if c2 + w2 else 0.0
    times = sorted(datetime.fromisoformat(reviews[k]["created_at"]).astimezone(IST) for k in set1 + set2 if k in reviews)

    out = [f"# Gate 1 report: extraction {run_id.split('-')[2]}", "",
           "*RSGPT. Unofficial project, not affiliated with Figuring Out.*",
           f"Written {datetime.now(IST):%Y-%m-%d} by `pipeline/09_gate1_report.py` from the reviews table.", "",
           f"**Decision:** Gate 1 passed. Extraction **v5** (`pipeline/06_extract.py`, VERSION = \"v5\"), together with "
           "the\n`pipeline/07_check.py` rules 1-8 including the number check, is locked for the full 500-episode run.",
           f"Run ID: `{run_id}`; the full run reuses it, so the 25 test episodes are skipped.", "",
           "## 1. Your review of the v5 fast-review set", "",
           f"Source: the `reviews` table, latest verdict per item, for the {len(set1) + len(set2)} items of",
           f"`data/review/fast_review_{run_id}.json`:", "",
           f"- **Set 1** is every item Sonnet marked not_supported or unsure: {len(set1)} items.",
           f"- **Set 2** is a fixed random {len(set2)} of the {fast['supported_total']} items Sonnet marked supported.", "",
           f"Reviewed: {len(all1)} of {len(set1)} in set 1 and {len(all2)} of {len(set2)} in set 2"
           + (f", saved between {times[0]:%Y-%m-%d %H:%M} and {times[-1]:%Y-%m-%d %H:%M} IST." if times else ".")
           + f" The `reviews` table holds {total_rows} rows; the rest are verdicts on other runs and are not counted.",
           "An earlier set of 224 v5 verdicts, saved without reading each item, was removed and kept in",
           "`data/review/backup_v5_fastreview.json`; it is not used here.", "",
           "Accuracy is correct / (correct + wrong); Unsure is left out. The estimate for the whole sample counts set 1",
           "as reviewed and takes each type's supported items at set 2's accuracy for that type (marked * where set 2",
           "has no decided item of the type, which uses set 2's overall accuracy instead).", "",
           "| Item type | Set 1 accuracy | Set 1 unsure | Set 2 accuracy | Set 2 unsure | In sample | Estimated whole-sample accuracy |",
           "|---|---|---|---|---|---|---|"]
    est_correct = est_total = 0.0
    for t in TYPE_ORDER:
        c1, w1 = v1[t].count("correct"), v1[t].count("wrong")
        ct, wt = v2[t].count("correct"), v2[t].count("wrong")
        rate, mark = (ct / (ct + wt), "") if ct + wt else (acc2, "*")
        good, total = c1 + supported[t] * rate, c1 + w1 + supported[t]
        est_correct, est_total = est_correct + good, est_total + total
        n_sample = sum(1 for s in sample if s["type"] == t)
        out.append(f"| {TYPE_LABELS[t]} | {acc_cell(v1[t])} | {v1[t].count('unsure')} | {acc_cell(v2[t])} | "
                   f"{v2[t].count('unsure')} | {n_sample} | {pct(good, total)}{mark} |")
    c1, w1 = all1.count("correct"), all1.count("wrong")
    whole = (c1 + fast["supported_total"] * acc2) / (c1 + w1 + fast["supported_total"]) if c1 + w1 + fast["supported_total"] else 0
    out += [f"| **All** | **{acc_cell(all1)}** | **{all1.count('unsure')}** | **{acc_cell(all2)}** | "
            f"**{all2.count('unsure')}** | **{len(sample)}** | **{100 * whole:.0f}%** |", "",
            f"The All row's estimate takes all {fast['supported_total']} supported items at set 2's overall accuracy, as "
            f"the app's Fast review report does. Summing the per-type estimates instead gives {pct(est_correct, est_total)}.",
            "Set 2 has only a few items of some types (it is a random draw from the supported items), so the per-type",
            "estimates for those types are rough.", ""]

    out += ["## 2. Wrong items", ""]
    wrong = [k for k in set1 + set2 if verdict.get(k) == "wrong"]
    if not wrong:
        out += ["No item is marked Wrong.", ""]
    for t in TYPE_ORDER:
        keys = [k for k in wrong if kind[k] == t]
        if not keys:
            continue
        out += [f"### {TYPE_LABELS[t]} ({len(keys)})", ""]
        for k in keys:
            where = "set 1" if k in set1 else "set 2"
            note = one_line(reviews[k]["note"]) if reviews[k]["note"] else "*no note*"
            out += [f"- **{k[0]} {k[1]}** ({video[k]}, {where}, Sonnet: {sonnet[k]['verdict']}): {one_line(texts.get(k, ''))}",
                    f"  - Your note: {note}"]
        out.append("")
    unsure = [k for k in set1 + set2 if verdict.get(k) == "unsure"]
    if unsure:
        out += [f"Marked Unsure ({len(unsure)}):", ""]
        out += [f"- **{k[0]} {k[1]}** ({TYPE_LABELS[kind[k]]}, {video[k]}): {one_line(texts.get(k, ''), 200)}"
                + (f" Note: {one_line(reviews[k]['note'])}" if reviews[k]["note"] else "") for k in unsure]
        out.append("")

    out += ["## 3. How often Sonnet was right", "",
            "Set 1 is what Sonnet flagged. A flag was right when you marked the item Wrong. Set 2 shows what it missed:",
            "items it marked supported that you marked Wrong.", "",
            "| Item type | Flagged (set 1) | Flag right (Wrong) | Flag wrong (Correct) | Unsure | Flags right | "
            "Set 2 reviewed | Missed (Wrong in set 2) |",
            "|---|---|---|---|---|---|---|---|"]
    for t in TYPE_ORDER:
        f = v1[t]
        n_flagged = sum(1 for k in set1 if kind[k] == t)
        out.append(f"| {TYPE_LABELS[t]} | {n_flagged} | {f.count('wrong')} | {f.count('correct')} | {f.count('unsure')} | "
                   f"{pct(f.count('wrong'), f.count('wrong') + f.count('correct'))} | {len(v2[t])} | {v2[t].count('wrong')} |")
    out.append(f"| **All** | **{len(set1)}** | **{w1}** | **{c1}** | **{all1.count('unsure')}** | **{pct(w1, w1 + c1)}** | "
               f"**{len(all2)}** | **{w2}** |")
    by_label = []
    for label in ("not_supported", "unsure"):
        got = [verdict[k] for k in set1 if k in verdict and sonnet[k]["verdict"] == label]
        by_label.append(f"{label} {pct(got.count('wrong'), got.count('wrong') + got.count('correct'))} "
                        f"({got.count('wrong')} of {got.count('wrong') + got.count('correct')})")
    missed = fast["supported_total"] * (w2 / (c2 + w2)) if c2 + w2 else 0
    out += ["", f"By Sonnet's verdict, the share of flags that were right: {by_label[0]}; {by_label[1]}.", "",
            f"Across the whole sample, about {w1 + missed:.0f} items are estimated Wrong: {w1} in set 1 and about "
            f"{missed:.0f} among the {fast['supported_total']} supported items (set 2's rate). Sonnet's flags catch about "
            f"{pct(w1, w1 + missed)} of them.", "",
            f"**Sonnet over-flags, so it is not used as an automatic filter.** {pct(c1, c1 + w1)} of its flags were "
            "items you judged Correct, so dropping flagged items would throw away mostly good items, and it still "
            "misses most of the Wrong ones. Its pre-check stays a review aid only: it orders what to read first and "
            "puts its reason next to the cited lines.", ""]
    return "\n".join(out)


def note_key(note: str) -> str:
    return re.sub(r"\s+", " ", note).strip().rstrip(".!?;:,").strip().lower()


def build_gate2(sample: dict, reviews: dict, texts: dict) -> str:
    items = sample["items"]
    keys = [(s["table"], s["id"]) for s in items]
    kind = {(s["table"], s["id"]): s["type"] for s in items}
    lang = {(s["table"], s["id"]): s["language"] for s in items}
    video = {(s["table"], s["id"]): s["video_id"] for s in items}
    verdict = {k: r["verdict"] for k, r in reviews.items()}
    done = [verdict[k] for k in keys if k in verdict]

    def row(label: str, group: list) -> str:
        got = [verdict[k] for k in group if k in verdict]
        return (f"| {label} | {len(group)} | {len(got)} | {got.count('correct')} | {got.count('wrong')} | "
                f"{got.count('unsure')} | {acc_cell(got)} |")

    head = ["| | Items | Reviewed | Correct | Wrong | Unsure | Accuracy |", "|---|---|---|---|---|---|---|"]
    languages = ", ".join(f"{n} {LANGUAGE_LABELS.get(l, l)}" for l, n in sorted(sample["episodes_by_language"].items()))
    out = ["# Gate 2 report: extraction v5 on episodes outside the test set", "",
           "*RSGPT. Unofficial project, not affiliated with Figuring Out.*",
           f"Written {datetime.now(IST):%Y-%m-%d %H:%M} IST by `pipeline/09_gate1_report.py --sample` from the "
           "reviews table.", "",
           f"Sample: `data/gate2_sample.json`, run `{sample['run_id']}`, seed {sample['seed']}: {len(items)} verified "
           f"items, {sample['per_episode']} from each of {sample['episodes']} random episodes outside the test set "
           f"({languages}), at least {sample['min_per_type']} of every type.", "",
           f"Reviewed: {len(done)} of {len(items)}. Accuracy is correct / (correct + wrong), using each item's latest "
           "verdict; Unsure is left out.", "",
           "## 1. Accuracy per item type", "", *head]
    out += [row(TYPE_LABELS[t], [k for k in keys if kind[k] == t]) for t in gate2_lib.TYPES]
    out += [row("**All**", keys), "", "## 2. Accuracy per episode language", "", *head]
    out += [row(LANGUAGE_LABELS.get(l, l), [k for k in keys if lang[k] == l]) for l in sorted(set(lang.values()))]
    out += [row("**All**", keys), ""]

    wrong = [k for k in keys if verdict.get(k) == "wrong"]
    notes: Counter = Counter()
    first: dict[str, str] = {}
    for k in wrong:
        key = note_key(reviews[k]["note"] or "")
        if key:
            notes[key] += 1
            first.setdefault(key, one_line(reviews[k]["note"]))
    out += [f"## 3. The {TOP_NOTES} most common notes on Wrong items", "",
            f"{len(wrong)} items are marked Wrong, {sum(notes.values())} of them with a note. "
            "Notes are compared ignoring case, spacing and end punctuation.", ""]
    if notes:
        out += ["| # | Note | Wrong items |", "|---|---|---|"]
        out += [f"| {n} | {first[key].replace('|', '/')} | {count} |"
                for n, (key, count) in enumerate(notes.most_common(TOP_NOTES), 1)]
    else:
        out.append("No notes on Wrong items yet.")
    out += ["", "## 4. Wrong items", ""]
    if not wrong:
        out.append("No item is marked Wrong.")
    for t in gate2_lib.TYPES:
        group = [k for k in wrong if kind[k] == t]
        if group:
            out += [f"### {TYPE_LABELS[t]} ({len(group)})", ""]
            for k in group:
                note = one_line(reviews[k]["note"]) if reviews[k]["note"] else "*no note*"
                out += [f"- **{k[0]} {k[1]}** ({video[k]}, {LANGUAGE_LABELS.get(lang[k], lang[k])}): "
                        f"{one_line(texts.get(k, ''))}", f"  - Note: {note}"]
            out.append("")
    return "\n".join(out) + "\n"


def write_gate2() -> None:
    sample = gate2_lib.load_sample()
    if not sample:
        sys.exit(f"missing {gate2_lib.SAMPLE_PATH}; open the Gate 2 sample in review_app.py first")
    db = check.captions.supabase_client()
    keys = [(s["table"], s["id"]) for s in sample["items"]]
    reviews = latest_reviews(db, keys)
    log.info("reviews: %d of %d Gate 2 items have a verdict", len(reviews), len(keys))
    texts = item_texts(db, [k for k, r in reviews.items() if r["verdict"] == "wrong"])
    tmp = GATE2_REPORT.with_suffix(".md.tmp")
    tmp.write_text(build_gate2(sample, reviews, texts), encoding="utf-8")
    tmp.replace(GATE2_REPORT)
    log.info("wrote %s", GATE2_REPORT)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--run-id", help="write the Gate 1 report for this run")
    group.add_argument("--sample", action="store_true", help="write data/gate2_report.md from the Gate 2 sample")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    load_dotenv(ROOT / ".env")
    if args.sample:
        write_gate2()
        return

    sample = read_json(gate1_lib.sample_path(args.run_id))["items"]
    pre = read_json(REVIEW_DIR / f"ai_precheck_{args.run_id}.json")
    fast = read_json(REVIEW_DIR / f"fast_review_{args.run_id}.json")
    if not REPORT.exists():
        sys.exit(f"missing {REPORT}; its sections from '{KEEP_FROM}' on are kept, so it must exist")
    db = check.captions.supabase_client()
    keys = [(k["table"], k["id"]) for k in fast["flagged"] + fast["random_supported"]]
    reviews = latest_reviews(db, keys)
    log.info("reviews: %d of %d fast-review items have a verdict", len(reviews), len(keys))
    texts = item_texts(db, [k for k, r in reviews.items() if r["verdict"] in ("wrong", "unsure")])
    total_rows = len(check.fetch(db, "reviews", "id"))

    report = build(args.run_id, sample, pre, fast, reviews, texts, total_rows)
    report += "\n" + renumber_kept(REPORT.read_text(encoding="utf-8"), 4)
    tmp = REPORT.with_suffix(".md.tmp")
    tmp.write_text(report, encoding="utf-8")
    tmp.replace(REPORT)
    log.info("wrote %s", REPORT)


if __name__ == "__main__":
    main()
