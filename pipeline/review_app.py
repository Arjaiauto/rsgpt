"""Local review tool for verified extraction rows: mark each one Correct, Wrong or Unsure.

Two modes, chosen in the sidebar:

- Per episode: pick a run (default: the extract-haiku-v3 run) and an episode, and
  review its verified rows: the guest profile, then insights and clips in time order.
- Gate 1 sample: a fixed sample of one Haiku run's verified rows across the test
  episodes (gate1_lib.py): every guest profile, and per episode up to
  SAMPLE_PER_EPISODE of each type (fewer when an episode has fewer). It is drawn
  once, at random with a fixed seed, and saved to data/review/, so it stays the
  same between sessions. Runs that have a saved sample can be picked; the newest
  is the default.
  Progress is out of the sample total; accuracy is shown overall and per type.
- Fast review: the Gate 1 sample after the AI pre-check (08_ai_precheck.py). Set 1
  holds every item Sonnet marked not_supported or unsure; set 2 a fixed random 100
  of the items it marked supported (both saved in data/review/fast_review_<run>.json).
  Set 1 shows the riskiest types first (FAST_RISK_ORDER). Ten items a page, each
  with Sonnet's verdict and reason right above the cited lines. Nothing is
  preselected: every item needs Correct, Wrong or Unsure (or "Sonnet is right",
  which marks it Wrong) before "Save page" writes the page to reviews. The report
  shows your accuracy on both sets and how often you agreed with Sonnet.
- Gate 2 sample: 250 verified items of the extraction v5 run from 50 random episodes
  outside the test set, 5 from each, English and Hindi episodes in their real
  proportion and at least 20 of every type (gate2_lib.py). Drawn once with a fixed
  seed and saved to data/gate2_sample.json. Progress is out of 250; accuracy is shown
  overall, per type and per language.

For each item you see its type and text ("(translated)" when it rests on the
English translation), the cited transcript lines with their speaker and Roman
text, and links that open the YouTube video at those times. Correct / Wrong /
Unsure (keys 1, 2, 3) save a row in the reviews table, with the note, and move to
the next item that has no verdict yet. Accuracy is correct / (correct + wrong),
using each item's latest verdict.

Only the episodes of the current item or page are held in memory. Guest profiles have no cited IDs in
the database, so theirs come from the run's result file in data/extractions/.

Usage:
    .venv\\Scripts\\streamlit.exe run pipeline\\review_app.py
"""

import json
import os
import re
from pathlib import Path

import streamlit as st
from dotenv import load_dotenv
from supabase import create_client

import gate1_lib
import gate2_lib

ROOT = Path(__file__).resolve().parent.parent
EXTRACT_DIR = ROOT / "data" / "extractions"
REVIEW_DIR = gate1_lib.REVIEW_DIR
DEFAULT_RUN_PREFIX = "extract-haiku-v3"
GATE1_RUN_PREFIX = "extract-haiku-v"
PAGE = 1000
DISCLAIMER = "Unofficial project, not affiliated with Figuring Out."
TYPE_LABELS = {"guest": "Guest profile", "quote": "Quote", "disagreement": "Disagreement",
               "raj_opinion": "Raj opinion", "raj_question": "Raj question", "opportunity": "Opportunity",
               "takeaway": "Takeaway", "clip": "Clip"}
SPEAKER_LETTERS = {"raj": "R", "guest": "G", "unknown": "U"}
VERDICTS = [("Correct", "correct", "1"), ("Wrong", "wrong", "2"), ("Unsure", "unsure", "3")]
FAST_PAGE = 10
FAST_RISK_ORDER = ["disagreement", "guest", "clip", "raj_opinion", "opportunity", "takeaway", "raj_question", "quote"]
SONNET_LABELS = {"supported": "supported", "not_supported": "not supported", "unsure": "unsure"}

load_dotenv(ROOT / ".env")


@st.cache_resource
def db():
    url, key = os.environ.get("SUPABASE_URL"), os.environ.get("SUPABASE_SERVICE_KEY")
    if not url or not key:
        st.error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in .env")
        st.stop()
    return create_client(url, key)


def fetch(table: str, columns: str, order: str = "id", in_: tuple | None = None, **eq) -> list[dict]:
    rows, start = [], 0
    while True:
        q = db().table(table).select(columns)
        for k, v in eq.items():
            q = q.eq(k, v)
        if in_:
            q = q.in_(*in_)
        page = q.order(order).range(start, start + PAGE - 1).execute().data
        rows += page
        if len(page) < PAGE:
            return rows
        start += PAGE


# ---------- data ----------

@st.cache_data(ttl=600)
def run_ids() -> list[str]:
    return sorted({r["run_id"] for r in fetch("insights", "run_id") if r["run_id"]})


@st.cache_data(ttl=600)
def titles(vids: tuple[str, ...]) -> dict[str, str]:
    return {e["video_id"]: e["title"] for e in fetch("episodes", "video_id,title", order="video_id",
                                                    in_=("video_id", list(vids)))} if vids else {}


@st.cache_data(ttl=600)
def run_episodes(run_id: str) -> list[str]:
    return sorted({r["video_id"] for r in fetch("insights", "video_id", run_id=run_id, verified=True)}
                  | {r["video_id"] for r in fetch("guests", "video_id", run_id=run_id, verified=True)})


@st.cache_data(ttl=600)
def run_item_keys(run_id: str) -> list[tuple[str, int]]:
    """(table, id) of every verified row in the run, for the run-wide accuracy."""
    return sorted((t, r["id"]) for t in ("insights", "clips", "guests")
                  for r in fetch(t, "id", run_id=run_id, verified=True))


def guest_segment_ids(run_id: str, vid: str) -> list[int]:
    for path in EXTRACT_DIR.rglob(f"{vid}.json"):
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            continue
        if record.get("run_id") == run_id and record.get("guest"):
            return record["guest"].get("source_segment_ids", [])
    return []


@st.cache_data(max_entries=FAST_PAGE, show_spinner="Loading episode...")
def load_episode(run_id: str, vid: str) -> dict:
    """One episode's segments and verified rows; at most one Fast review page's worth of episodes stays cached."""
    segments = fetch("segments", "id,seq,start_s,end_s,speaker,text_roman", order="seq", video_id=vid)
    items = []
    for g in fetch("guests", "*", run_id=run_id, video_id=vid, verified=True):
        bio = "\n".join(x for x in [g["name"], ", ".join(filter(None, [g["role_at_episode"], g["organisation"]])),
                                    g["bio"], "Sectors: " + ", ".join(g["sector_tags"] or [])] if x)
        items.append({"table": "guests", "id": g["id"], "type": "guest", "text": bio, "translated": False,
                      "segment_ids": guest_segment_ids(run_id, vid), "start_s": None, "end_s": None, "extra": ""})
    for r in sorted(fetch("insights", "*", run_id=run_id, video_id=vid, verified=True), key=lambda r: r["start_s"]):
        extra = r["category"] or ""
        qtype = re.search(r"question_type: ([\w-]+)", r["check_notes"] or "")
        if qtype:
            extra = qtype.group(1)
        items.append({"table": "insights", "id": r["id"], "type": r["type"], "text": r["text"],
                      "translated": r["translated"], "segment_ids": r["source_segment_ids"] or [],
                      "start_s": r["start_s"], "end_s": r["end_s"], "extra": extra.replace("_", " ")})
    for c in sorted(fetch("clips", "*", run_id=run_id, video_id=vid, verified=True), key=lambda c: c["start_s"]):
        ids = [s["id"] for s in segments if s["start_s"] >= c["start_s"] - 0.05 and s["end_s"] <= c["end_s"] + 0.05]
        items.append({"table": "clips", "id": c["id"], "type": "clip",
                      "text": f"{c['topic']}\nOpening line: {c['opening_line']}", "translated": False,
                      "segment_ids": ids, "start_s": c["start_s"], "end_s": c["end_s"],
                      "extra": f"{c['end_s'] - c['start_s']:.0f} s, score {c['score']:.2f}"})
    return {"segments": {s["id"]: s for s in segments}, "items": {(i["table"], i["id"]): i for i in items},
            "order": [(i["table"], i["id"]) for i in items]}


sample_path = gate1_lib.sample_path


def gate1_sample(run_id: str) -> list[dict]:
    """The saved Gate 1 sample for the run, drawn and saved on first use."""
    return gate1_lib.gate1_sample(run_id, lambda table, columns, **eq: fetch(table, columns, **eq))


def gate1_run(runs: list[str], label: str) -> str | None:
    """Pick a Haiku run in the sidebar: those with a saved sample, newest first (or the newest run if none has one)."""
    haiku = [r for r in runs if r.startswith(GATE1_RUN_PREFIX)]
    choices = sorted((r for r in haiku if sample_path(r).exists()), reverse=True) or sorted(haiku, reverse=True)[:1]
    if not choices:
        st.error(f"No run starting with {GATE1_RUN_PREFIX}.")
        return None
    return st.sidebar.selectbox(label, choices)


def latest_verdicts(keys: list[tuple[str, int]]) -> dict[tuple[str, int], str]:
    """The latest verdict per (table, id), for the given rows."""
    verdicts = {}
    by_table: dict[str, list[int]] = {}
    for t, i in keys:
        by_table.setdefault(t, []).append(i)
    for table, ids in by_table.items():
        for n in range(0, len(ids), 300):
            for r in fetch("reviews", "item_table,item_id,verdict,created_at", order="created_at",
                           in_=("item_id", ids[n:n + 300]), item_table=table):
                verdicts[(table, r["item_id"])] = r["verdict"]  # ordered by time, so the last one wins
    return verdicts


# ---------- display ----------

def accuracy(verdicts) -> str:
    values = list(verdicts)
    correct, wrong = values.count("correct"), values.count("wrong")
    return f"{100 * correct / (correct + wrong):.0f}% ({correct} of {correct + wrong})" if correct + wrong else "–"


def clock(seconds: float) -> str:
    s = int(seconds)
    return f"{s // 3600}:{s % 3600 // 60:02d}:{s % 60:02d}" if s >= 3600 else f"{s // 60}:{s % 60:02d}"


def youtube(vid: str, seconds: float) -> str:
    return f"https://www.youtube.com/watch?v={vid}&t={int(seconds)}s"


def escape(text: str) -> str:
    return re.sub(r"([\\`*_{}\[\]<>()#+\-.!|~$])", r"\\\1", text)


def show_item(run_id: str, vid: str, key: tuple[str, int], prefix: str = "", link_button: bool = True,
              sonnet: dict | None = None) -> dict | None:
    """Show one item: its type and text, Sonnet's verdict if given, a YouTube link and the cited lines."""
    episode = load_episode(run_id, vid)
    item = episode["items"].get(key)
    if item is None:
        st.warning(f"{key[0]} #{key[1]} is no longer a verified row in this run.")
        return None
    head = TYPE_LABELS[item["type"]] + (f" · {item['extra']}" if item["extra"] else "")
    if item["translated"]:
        head += " (translated)"
    st.markdown(f"#### {prefix}{escape(head)}")
    st.markdown(escape(item["text"]).replace("\n", "  \n"))
    cited = sorted((episode["segments"][i] for i in item["segment_ids"] if i in episode["segments"]),
                   key=lambda s: s["seq"])
    start = item["start_s"] if item["start_s"] is not None else (cited[0]["start_s"] if cited else None)
    if start is not None:
        if link_button:
            st.link_button(f"Open on YouTube at {clock(start)}", youtube(vid, start))
        else:
            st.markdown(f"[Open on YouTube at {clock(start)}]({youtube(vid, start)})")
    if sonnet:
        # Right above the lines, so the reason can be checked against them.
        text = f"**Sonnet: {SONNET_LABELS[sonnet['verdict']]}**  \n**{escape(sonnet['reason'])}**"
        {"supported": st.success, "not_supported": st.error}.get(sonnet["verdict"], st.warning)(text)
    st.markdown("**Cited transcript lines**")
    if cited:
        shown = []
        for n, s in enumerate(cited):
            if n and s["seq"] > cited[n - 1]["seq"] + 1:
                shown.append("\\[…\\]")  # lines left out between two cited passages
            shown.append(f"[{clock(s['start_s'])}]({youtube(vid, s['start_s'])}) &nbsp; "
                         f"**{SPEAKER_LETTERS.get(s['speaker'], 'U')}** &nbsp; {escape(s['text_roman'])}")
        st.markdown("  \n".join(shown))
    else:
        st.caption("No cited lines found for this item.")
    return item


def review(keys: list[tuple[str, int]], videos: list[str], run_id: str, verdicts: dict, pos_key: str,
           episode_titles: dict[str, str]) -> None:
    """Show one item of the list and the verdict buttons. videos[i] is the episode of keys[i]."""
    if pos_key not in st.session_state:
        st.session_state[pos_key] = next((i for i, k in enumerate(keys) if k not in verdicts), 0)
    pos = min(st.session_state[pos_key], len(keys) - 1)
    if all(k in verdicts for k in keys):
        st.success("Every item here has a verdict. Step back to change one.")

    key, vid = keys[pos], videos[pos]
    st.caption(f"{vid} · {episode_titles.get(vid, '')}")
    item = show_item(run_id, vid, key, f"{pos + 1} / {len(keys)} · ")
    if item is not None and key in verdicts:
        st.caption(f"Current verdict: {verdicts[key]}")

    note = st.text_area("Note (optional)", key=f"note::{key[0]}::{key[1]}", height=80)
    cols = st.columns(5)
    for col, (label, verdict, shortcut) in zip(cols, VERDICTS):
        if col.button(f"{label} ({shortcut})", key=f"{verdict}::{key}", shortcut=shortcut, width="stretch",
                      type="primary" if verdict == "correct" else "secondary", disabled=item is None):
            db().table("reviews").insert({"item_table": key[0], "item_id": key[1], "verdict": verdict,
                                          "note": note.strip() or None}).execute()
            verdicts[key] = verdict
            later = [i for i in range(pos + 1, len(keys)) if keys[i] not in verdicts]
            earlier = [i for i in range(0, pos) if keys[i] not in verdicts]
            st.session_state[pos_key] = (later or earlier or [min(pos + 1, len(keys) - 1)])[0]
            st.rerun()
    if cols[3].button("← Back", key=f"back::{key}", shortcut="Left", width="stretch", disabled=pos == 0):
        st.session_state[pos_key] = pos - 1
        st.rerun()
    if cols[4].button("Skip →", key=f"skip::{key}", shortcut="Right", width="stretch",
                      disabled=pos == len(keys) - 1):
        st.session_state[pos_key] = pos + 1
        st.rerun()


def episode_mode(runs: list[str]) -> None:
    default = next((i for i, r in enumerate(runs) if r.startswith(DEFAULT_RUN_PREFIX)), 0)
    run_id = st.sidebar.selectbox("Run", runs, index=default)
    vids = run_episodes(run_id)
    if not vids:
        st.info("This run has no verified rows.")
        return
    names = titles(tuple(vids))
    vid = st.sidebar.selectbox("Episode", vids, format_func=lambda v: f"{v} · {names.get(v, '')[:70]}")
    keys = load_episode(run_id, vid)["order"]
    verdicts = latest_verdicts(keys)
    run_verdicts = latest_verdicts(run_item_keys(run_id))
    reviewed = sum(k in verdicts for k in keys)
    st.sidebar.progress(reviewed / len(keys) if keys else 1.0, text=f"Episode: {reviewed} of {len(keys)} reviewed")
    st.sidebar.metric("Accuracy, this episode", accuracy(verdicts.values()))
    st.sidebar.metric("Accuracy, whole run", accuracy(run_verdicts.values()))
    st.sidebar.caption(f"{len(run_verdicts)} verdicts in this run so far")
    if keys:
        review(keys, [vid] * len(keys), run_id, verdicts, f"pos::{run_id}::{vid}", names)


def sample_mode(runs: list[str]) -> None:
    run_id = gate1_run(runs, "Sample of run")
    if run_id is None:
        return
    sample = gate1_sample(run_id)
    keys = [(s["table"], s["id"]) for s in sample]
    types = {(s["table"], s["id"]): s["type"] for s in sample}
    verdicts = latest_verdicts(keys)
    reviewed = sum(k in verdicts for k in keys)
    st.sidebar.markdown(f"**Gate 1 sample** · `{run_id}`")
    st.sidebar.progress(reviewed / len(keys), text=f"{reviewed} of {len(keys)} reviewed")
    st.sidebar.metric("Accuracy, whole sample", accuracy(verdicts.values()))
    rows = []
    for kind, label in TYPE_LABELS.items():
        kind_keys = [k for k in keys if types[k] == kind]
        got = [verdicts[k] for k in kind_keys if k in verdicts]
        rows.append({"Type": label, "Done": f"{len(got)}/{len(kind_keys)}", "Accuracy": accuracy(got),
                     "Unsure": got.count("unsure")})
    st.sidebar.dataframe(rows, hide_index=True, width="stretch")
    st.sidebar.caption(f"Sample saved in {sample_path(run_id).relative_to(ROOT)}")
    vids = [s["video_id"] for s in sample]
    review(keys, vids, run_id, verdicts, f"gate1::{run_id}", titles(tuple(sorted(set(vids)))))


def gate2_mode() -> None:
    sample = gate2_lib.gate2_sample(lambda table, columns, **eq: fetch(
        table, columns, order="video_id" if table == "episodes" else "id", **eq))
    run_id, items = sample["run_id"], sample["items"]
    keys = [(s["table"], s["id"]) for s in items]
    types = {(s["table"], s["id"]): s["type"] for s in items}
    langs = {(s["table"], s["id"]): s["language"] for s in items}
    verdicts = latest_verdicts(keys)
    reviewed = sum(k in verdicts for k in keys)
    st.sidebar.markdown(f"**Gate 2 sample** · `{run_id}`")
    st.sidebar.progress(reviewed / len(keys), text=f"{reviewed} of {len(keys)} reviewed")
    st.sidebar.metric("Accuracy, whole sample", accuracy(verdicts.values()))
    rows = []
    for kind in gate2_lib.TYPES:
        kind_keys = [k for k in keys if types[k] == kind]
        got = [verdicts[k] for k in kind_keys if k in verdicts]
        rows.append({"Type": TYPE_LABELS[kind], "Done": f"{len(got)}/{len(kind_keys)}", "Accuracy": accuracy(got),
                     "Unsure": got.count("unsure")})
    for lang in sorted(set(langs.values())):
        lang_keys = [k for k in keys if langs[k] == lang]
        got = [verdicts[k] for k in lang_keys if k in verdicts]
        rows.append({"Type": {"en": "English episodes", "hi": "Hindi episodes"}.get(lang, lang),
                     "Done": f"{len(got)}/{len(lang_keys)}", "Accuracy": accuracy(got), "Unsure": got.count("unsure")})
    # A Markdown table, not st.dataframe: that needs pyarrow, whose DLL Windows Application Control blocks here.
    st.sidebar.markdown("\n".join(["| | Done | Accuracy | Unsure |", "|---|---|---|---|"]
                                  + [f"| {r['Type']} | {r['Done']} | {r['Accuracy']} | {r['Unsure']} |"
                                     for r in rows]))
    if sample["short_of_minimum"]:
        st.sidebar.warning("Fewer than the minimum of some types in the drawn episodes: "
                           + ", ".join(f"{TYPE_LABELS[t]} short by {n}" for t, n in sample["short_of_minimum"].items()))
    st.sidebar.caption(f"Sample saved in {gate2_lib.SAMPLE_PATH.relative_to(ROOT)}")
    vids = [s["video_id"] for s in items]
    review(keys, vids, run_id, verdicts, f"gate2::{run_id}", titles(tuple(sorted(set(vids)))))


def fast_files(run_id: str) -> tuple[dict, dict] | None:
    pre, fast = REVIEW_DIR / f"ai_precheck_{run_id}.json", REVIEW_DIR / f"fast_review_{run_id}.json"
    if not (pre.exists() and fast.exists()):
        return None
    return json.loads(pre.read_text(encoding="utf-8")), json.loads(fast.read_text(encoding="utf-8"))


def share(verdicts: list[str], agree: str) -> str:
    """How often the verdict was `agree`, out of the Correct and Wrong ones."""
    decided = [v for v in verdicts if v in ("correct", "wrong")]
    n = decided.count(agree)
    return f"{100 * n / len(decided):.0f}% ({n} of {len(decided)})" if decided else "–"


def fast_report(flagged: list, random_keys: list, supported_total: int, verdicts: dict) -> None:
    got_f = [verdicts[k] for k in flagged if k in verdicts]
    got_r = [verdicts[k] for k in random_keys if k in verdicts]
    st.dataframe([
        {"Set": "1 · Sonnet: not supported or unsure", "Done": f"{len(got_f)}/{len(flagged)}",
         "My accuracy": accuracy(got_f), "Agreed with Sonnet": share(got_f, "wrong"),
         "Unsure": got_f.count("unsure")},
        {"Set": f"2 · Sonnet: supported, random {len(random_keys)}", "Done": f"{len(got_r)}/{len(random_keys)}",
         "My accuracy": accuracy(got_r), "Agreed with Sonnet": share(got_r, "correct"),
         "Unsure": got_r.count("unsure")},
    ], hide_index=True, width="stretch")
    c_f, w_f = got_f.count("correct"), got_f.count("wrong")
    c_r, w_r = got_r.count("correct"), got_r.count("wrong")
    if c_r + w_r:
        # Set 1 counts as reviewed; every supported item is taken at set 2's accuracy.
        estimate = c_f + supported_total * c_r / (c_r + w_r)
        st.metric("Estimated accuracy, whole Gate 1 sample", f"{100 * estimate / (c_f + w_f + supported_total):.0f}%",
                  help=f"Set 1 as reviewed ({c_f} correct of {c_f + w_f}) plus all {supported_total} items Sonnet "
                       f"marked supported, taken at set 2's accuracy. Unsure verdicts are left out.")
    st.caption("Accuracy is correct / (correct + wrong), using each item's latest verdict; Unsure is left out. "
               "Agreeing with Sonnet means marking a set 2 item Correct, or a set 1 item Wrong.")


def fast_mode(runs: list[str]) -> None:
    run_id = gate1_run(runs, "Sample of run")
    files = fast_files(run_id) if run_id else None
    if files is None:
        st.info("No AI pre-check results for this run yet. Run: .venv\\Scripts\\python.exe "
                f"pipeline\\08_ai_precheck.py --run-id {run_id}")
        return
    pre, fast = files
    sample = gate1_sample(run_id)
    order = {(s["table"], s["id"]): n for n, s in enumerate(sample)}
    video = {(s["table"], s["id"]): s["video_id"] for s in sample}
    sonnet = {(r["table"], r["id"]): r for r in pre["items"]}
    flagged = sorted(((k["table"], k["id"]) for k in fast["flagged"]), key=order.get)
    random_keys = sorted(((k["table"], k["id"]) for k in fast["random_supported"]), key=order.get)
    verdicts = latest_verdicts(flagged + random_keys)

    st.sidebar.markdown(f"**Fast review** · `{run_id}`")
    view = st.sidebar.radio("Show", [f"1 · Not supported or unsure ({len(flagged)})",
                                     f"2 · Random supported ({len(random_keys)})", "Report"])
    total = len(flagged) + len(random_keys)
    done = sum(k in verdicts for k in flagged + random_keys)
    st.sidebar.progress(done / max(1, total), text=f"{done} of {total} reviewed")
    st.sidebar.caption(f"Sonnet pre-check: {len(pre['items'])} items, ${pre['cost_usd']:.2f}")
    if view == "Report":
        st.markdown("### Fast review report")
        fast_report(flagged, random_keys, fast["supported_total"], verdicts)
        return

    keys = flagged if view.startswith("1") else random_keys
    if not keys:
        st.info("Nothing in this set.")
        return
    if view.startswith("1"):
        # Riskiest types first, each in sample order.
        rank = {t: n for n, t in enumerate(FAST_RISK_ORDER)}
        types = {(s["table"], s["id"]): s["type"] for s in sample}
        keys = sorted(keys, key=lambda k: (rank.get(types[k], len(rank)), order[k]))
    pages = [keys[n:n + FAST_PAGE] for n in range(0, len(keys), FAST_PAGE)]
    page_key = f"fastpage::{run_id}::{view[0]}"
    if page_key not in st.session_state:
        st.session_state[page_key] = next((n for n, p in enumerate(pages) if any(k not in verdicts for k in p)), 0)
    labels = [f"Page {n + 1}" + (" ✓" if all(k in verdicts for k in p) else "") for n, p in enumerate(pages)]
    page_no = st.sidebar.selectbox("Page", range(len(pages)), format_func=labels.__getitem__, key=page_key)
    page = pages[page_no]
    names = titles(tuple(sorted({video[k] for k in page})))

    options = [label for label, _, _ in VERDICTS]
    values = {label: verdict for label, verdict, _ in VERDICTS}
    labels_of = {verdict: label for label, verdict, _ in VERDICTS}
    st.markdown(f"### Set {view[0]}, page {page_no + 1} of {len(pages)}")
    st.caption("Nothing is preselected: choose Correct, Wrong or Unsure for every item (an item you saved before "
               "shows your saved verdict). Save page works once all items on the page have one.")
    shown = []
    for n, key in enumerate(page):
        st.divider()
        st.caption(f"{video[key]} · {names.get(video[key], '')}")
        item = show_item(run_id, video[key], key, f"{page_no * FAST_PAGE + n + 1}. ", link_button=False,
                         sonnet=sonnet.get(key))
        if item is None:
            continue
        radio_key = f"fv::{key}"
        if radio_key not in st.session_state and key in verdicts:
            st.session_state[radio_key] = labels_of[verdicts[key]]
        cols = st.columns([2, 1, 3])
        # Blank unless chosen (or saved before); no index when Session State already holds the value.
        blank = {} if radio_key in st.session_state else {"index": None}
        choice = cols[0].radio("My verdict", options, horizontal=True, key=radio_key, **blank)
        if sonnet.get(key, {}).get("verdict") != "supported":
            cols[1].button("Sonnet is right", key=f"sr::{key}", help="Agree with Sonnet's reason: marks this item Wrong",
                           on_click=st.session_state.__setitem__, args=(radio_key, labels_of["wrong"]))
        note = cols[2].text_input("Note (optional)", key=f"fn::{key}")
        shown.append((key, choice, note))

    st.divider()
    missing = [n for n, (_, choice, _) in enumerate(shown) if choice is None]
    if missing:
        st.caption(f"{len(shown) - len(missing)} of {len(shown)} items have a verdict; "
                   f"choose one for every item to save the page.")
    if st.button(f"Save page ({len(shown)} items)", type="primary", disabled=bool(missing)):
        # Items already saved with the same verdict and no new note are not written again.
        rows = [{"item_table": key[0], "item_id": key[1], "verdict": values[choice],
                 "note": note.strip() or None} for key, choice, note in shown
                if verdicts.get(key) != values[choice] or note.strip()]
        if rows:
            db().table("reviews").insert(rows).execute()
        for key, choice, _ in shown:
            verdicts[key] = values[choice]
        later = [n for n in range(page_no + 1, len(pages)) if any(k not in verdicts for k in pages[n])]
        st.session_state.pop(page_key)
        st.session_state[page_key] = later[0] if later else page_no
        st.session_state["fast_saved"] = f"Saved page {page_no + 1}: {len(rows)} verdicts written."
        st.rerun()
    if "fast_saved" in st.session_state:
        st.toast(st.session_state.pop("fast_saved"))


def main() -> None:
    st.set_page_config(page_title="RSGPT review", layout="wide")
    st.caption(DISCLAIMER)
    mode = st.sidebar.radio("Mode", ["Gate 2 sample", "Gate 1 sample", "Fast review", "Per episode"],
                            horizontal=True)
    if mode == "Gate 2 sample":
        gate2_mode()
        return
    runs = run_ids()
    if mode == "Gate 1 sample":
        sample_mode(runs)
    elif mode == "Fast review":
        fast_mode(runs)
    else:
        episode_mode(runs)


main()
