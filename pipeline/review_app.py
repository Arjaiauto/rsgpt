"""Local review tool for verified extraction rows: mark each one Correct, Wrong or Unsure.

Pick a run (default: the extract-haiku-v3 run) and an episode. Only rows with
verified = true are shown: the guest profile, then insights and clips in time
order. For each one you see its type and text ("(translated)" when it rests on
the English translation), the cited transcript lines with their speaker and Roman
text, and links that open the YouTube video at those times. Correct / Wrong /
Unsure (keys 1, 2, 3) save a row in the reviews table, with the note, and move to
the next item that has no verdict yet. Progress is per episode; accuracy is
correct / (correct + wrong), for the episode and for the whole run, using each
item's latest verdict.

Only one episode's data is held at a time. Guest profiles have no cited IDs in
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

ROOT = Path(__file__).resolve().parent.parent
EXTRACT_DIR = ROOT / "data" / "extractions"
DEFAULT_RUN_PREFIX = "extract-haiku-v3"
PAGE = 1000
DISCLAIMER = "Unofficial project, not affiliated with Figuring Out."
TYPE_LABELS = {"takeaway": "Takeaway", "opportunity": "Opportunity", "quote": "Quote",
               "disagreement": "Disagreement", "raj_question": "Raj question", "raj_opinion": "Raj opinion",
               "clip": "Clip", "guest": "Guest profile"}
SPEAKER_LETTERS = {"raj": "R", "guest": "G", "unknown": "U"}
VERDICTS = [("Correct", "correct", "1"), ("Wrong", "wrong", "2"), ("Unsure", "unsure", "3")]

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


@st.cache_data(ttl=600)
def run_ids() -> list[str]:
    return sorted({r["run_id"] for r in fetch("insights", "run_id") if r["run_id"]})


@st.cache_data(ttl=600)
def run_episodes(run_id: str) -> list[dict]:
    vids = sorted({r["video_id"] for r in fetch("insights", "video_id", run_id=run_id, verified=True)}
                  | {r["video_id"] for r in fetch("guests", "video_id", run_id=run_id, verified=True)})
    titles = {e["video_id"]: e["title"] for e in fetch("episodes", "video_id,title", order="video_id",
                                                      in_=("video_id", vids))} if vids else {}
    return [{"video_id": v, "title": titles.get(v, v)} for v in vids]


@st.cache_data(ttl=600)
def run_item_keys(run_id: str) -> set[tuple[str, int]]:
    """(table, id) of every verified row in the run, for the run-wide accuracy."""
    return {(t, r["id"]) for t in ("insights", "clips", "guests")
            for r in fetch(t, "id", run_id=run_id, verified=True)}


def guest_segment_ids(run_id: str, vid: str) -> list[int]:
    for path in EXTRACT_DIR.rglob(f"{vid}.json"):
        try:
            record = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            continue
        if record.get("run_id") == run_id and record.get("guest"):
            return record["guest"].get("source_segment_ids", [])
    return []


@st.cache_data(max_entries=1, show_spinner="Loading episode...")
def load_episode(run_id: str, vid: str) -> dict:
    """One episode's segments and verified rows; only the latest episode stays cached."""
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
    return {"segments": {s["id"]: s for s in segments}, "items": items}


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


def main() -> None:
    st.set_page_config(page_title="RSGPT review", layout="wide")
    st.caption(DISCLAIMER)

    runs = run_ids()
    default = next((i for i, r in enumerate(runs) if r.startswith(DEFAULT_RUN_PREFIX)), 0)
    run_id = st.sidebar.selectbox("Run", runs, index=default)
    episodes = run_episodes(run_id)
    if not episodes:
        st.info("This run has no verified rows.")
        return
    labels = {e["video_id"]: f"{e['video_id']} · {e['title'][:70]}" for e in episodes}
    vid = st.sidebar.selectbox("Episode", list(labels), format_func=labels.get)

    episode = load_episode(run_id, vid)
    items = episode["items"]
    keys = [(it["table"], it["id"]) for it in items]
    verdicts = latest_verdicts(keys)
    run_verdicts = latest_verdicts(sorted(run_item_keys(run_id)))

    reviewed = sum(k in verdicts for k in keys)
    st.sidebar.progress(reviewed / len(items) if items else 1.0, text=f"Episode: {reviewed} of {len(items)} reviewed")
    st.sidebar.metric("Accuracy, this episode", accuracy(verdicts.values()))
    st.sidebar.metric("Accuracy, whole run", accuracy(run_verdicts.values()))
    st.sidebar.caption(f"{len(run_verdicts)} verdicts in this run so far")

    # Position: the first item without a verdict, unless the reviewer moved elsewhere.
    pos_key = f"pos::{run_id}::{vid}"
    if pos_key not in st.session_state:
        st.session_state[pos_key] = next((i for i, k in enumerate(keys) if k not in verdicts), 0)
    pos = min(st.session_state[pos_key], len(items) - 1)

    if reviewed == len(items):
        st.success("Every item in this episode has a verdict. Pick another episode, or step back to change one.")

    item = items[pos]
    key = keys[pos]
    head = TYPE_LABELS[item["type"]] + (f" · {item['extra']}" if item["extra"] else "")
    if item["translated"]:
        head += " (translated)"
    st.markdown(f"#### {pos + 1} / {len(items)} · {escape(head)}")
    if key in verdicts:
        st.caption(f"Current verdict: {verdicts[key]}")
    st.markdown(escape(item["text"]).replace("\n", "  \n"))

    cited = sorted((episode["segments"][i] for i in item["segment_ids"] if i in episode["segments"]),
                   key=lambda s: s["seq"])
    start = item["start_s"] if item["start_s"] is not None else (cited[0]["start_s"] if cited else None)
    if start is not None:
        st.link_button(f"Open on YouTube at {clock(start)}", youtube(vid, start))
    st.markdown("**Cited transcript lines**")
    if cited:
        st.markdown("  \n".join(
            f"[{clock(s['start_s'])}]({youtube(vid, s['start_s'])}) &nbsp; **{SPEAKER_LETTERS.get(s['speaker'], 'U')}** "
            f"&nbsp; {escape(s['text_roman'])}" for s in cited))
    else:
        st.caption("No cited lines found for this item.")

    note = st.text_area("Note (optional)", key=f"note::{key[0]}::{key[1]}", height=80)
    cols = st.columns([1, 1, 1, 1, 1])
    for col, (label, verdict, shortcut) in zip(cols, VERDICTS):
        if col.button(f"{label} ({shortcut})", key=f"{verdict}::{key}", shortcut=shortcut, use_container_width=True,
                      type="primary" if verdict == "correct" else "secondary"):
            db().table("reviews").insert({"item_table": key[0], "item_id": key[1], "verdict": verdict,
                                          "note": note.strip() or None}).execute()
            verdicts[key] = verdict
            later = [i for i in range(pos + 1, len(items)) if keys[i] not in verdicts]
            earlier = [i for i in range(0, pos) if keys[i] not in verdicts]
            st.session_state[pos_key] = (later or earlier or [min(pos + 1, len(items) - 1)])[0]
            st.rerun()
    if cols[3].button("← Back", key=f"back::{key}", shortcut="Left", use_container_width=True, disabled=pos == 0):
        st.session_state[pos_key] = pos - 1
        st.rerun()
    if cols[4].button("Skip →", key=f"skip::{key}", shortcut="Right", use_container_width=True,
                      disabled=pos == len(items) - 1):
        st.session_state[pos_key] = pos + 1
        st.rerun()


main()
