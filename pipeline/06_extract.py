"""Extract guests, insights, clips and speakers from transcripts with Claude, through the Message Batches API.

One request per episode (or per part, for long episodes). The input is the episode
title and date, then every segment as [S<segment id> | mm:ss] text_roman and, for
Hindi episodes, the English translation of each line as [T<translation id> | mm:ss]
text right under it. Every request uses the same fixed JSON schema (OUTPUT_SCHEMA),
so the API compiles it once.

The answer holds speakers (raj / guest / unknown for every S line, given as runs
of consecutive lines), guest, topics, takeaways, opportunities (one of the 13
categories in schema.sql), quotes, disagreements, Raj's questions and opinions,
and clips. Every item except speakers points to S segment IDs; an item that rests
only on T lines is marked translated. Checks in code:
  - item IDs must be S IDs from the request; unknown IDs are removed, and an item
    left with none is dropped;
  - quotes must appear word for word in the cited S lines and be under 25 words,
    otherwise the row's check_notes says so;
  - clips must be 30-90 seconds long, otherwise check_notes says so;
  - speaker runs must cover every S line; lines left out are 'unknown'.

An episode over MAX_INPUT_TOKENS (counted with the token-counting endpoint) is
split into parts that overlap by OVERLAP_SEGMENTS lines. Each part owns the lines
up to the middle of each overlap: speakers and items come from the part that owns
the item's first segment, so nothing is counted twice.

Results:
  data/extractions/<model>/<video_id>.json  merged result (raw answers in parts/)
  guests, insights, clips                   rows with verified = false, model and run_id;
                                            an episode's earlier rows for the same model are replaced
  segments.speaker                          from the haiku run only

Resumable: the split plan, each part's answer and the merged file are saved as
they are made, and the batch ID is saved, so a rerun only sends what is missing
and only writes what has not been written. Results refused for a rate limit are
not counted as attempts and are sent again after a pause (romanize_lib.run_batch).

Usage:
    .venv\\Scripts\\python.exe pipeline\\06_extract.py --model haiku|sonnet --set test_set|all
"""

import argparse
import csv
import importlib.util
import json
import logging
import math
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path

import anthropic
from anthropic.types.message_create_params import MessageCreateParamsNonStreaming
from anthropic.types.messages.batch_create_params import Request
from dotenv import load_dotenv

import romanize_lib

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
CANDIDATES_CSV = DATA_DIR / "candidates.csv"
EXTRACT_DIR = DATA_DIR / "extractions"

MODELS = {"haiku": "claude-haiku-5-5", "sonnet": "claude-sonnet-5-5"}
# Batch API prices, USD per million tokens (input, output), checked 2026-10-22 on
# platform.claude.com/docs (batch-processing). Haiku's applies to prompts up to 100K tokens.
BATCH_PRICES = {"haiku": (0.05, 0.25), "sonnet": (1.00, 5.00)}
EFFORT = "medium"
MAX_TOKENS = 64000
MAX_INPUT_TOKENS = 90000
TOKEN_MARGIN = 4000  # room for the system prompt the API adds for the JSON format, which counting leaves out
OVERLAP_SEGMENTS = 40
MAX_ATTEMPTS = 3
MAX_ROUNDS = 12
MAX_TAKEAWAYS = 7
QUOTE_MAX_WORDS = 25
CLIP_SECONDS = (30, 90)
DB_PAGE = 1000
DB_BATCH = 500
SPEAKER_UPDATE_IDS = 400
MAX_RETRIES = 5

CATEGORIES = ["growing_sectors", "business_ideas", "market_gaps", "underrated_skills", "career_paths",
              "investment_themes", "hiring_signals", "policy_shifts", "geographic_opportunities",
              "tools_and_tech", "contrarian_takes", "resources", "warnings"]
QUESTION_TYPES = ["opening", "follow-up", "challenge", "personal", "deep-dive"]
SPEAKERS = ["raj", "guest", "unknown"]

SYSTEM_PROMPT = f"""You read the transcript of one episode of the Figuring Out podcast and extract structured research notes from it. Raj Shamani is the host: he asks the questions. The guest answers them.

The transcript lines come in two kinds:
- [S<id> | mm:ss] lines are the transcript itself, in Roman script (Hinglish for Hindi episodes).
- [T<id> | mm:ss] lines are machine English translations of the S line just above them. They are only there to help you understand Hindi; they are not the source.

Ground rules:
1. Only use what is said in the transcript. If you are unsure about something, leave it out. Never invent names, numbers, facts, organisations or opinions, and never fill gaps from your own knowledge.
2. Every item must point to the S line IDs (numbers only, without the "S") where it is said. Cite the lines that actually contain it, not whole stretches.
3. If an item rests only on what the T lines say, because you could not confirm it from the S lines, also list those T IDs and set translated to true. Otherwise translated is false and translation_line_ids may be empty.
4. Write takeaways, opportunities, disagreements, opinions and topics in the third person in English ("Raj argues...", "The guest says..."). Never write as Raj in the first person.
5. Never include phone numbers, email addresses or other contact details.

What to return (takeaways, opportunities, quotes, disagreements, Raj's questions and Raj's opinions all go in the one "items" list, each with its kind; category is "none" except for opportunities, question_type is "none" except for Raj's questions):
- speakers: runs of consecutive S lines with the same speaker, as from_id and to_id (inclusive, in transcript order) with raj, guest or unknown. Together the runs must cover every S line exactly once. Use unknown when the speaker is not clear.
- guest: the main guest's name, organisation, role at the time of the episode, sector tags, and a bio of 2-3 lines using only what was said in the episode. Use empty strings and lists for anything not said.
- topics: short tags for what the episode covers.
- takeaways: the key takeaways (the request says how many).
- opportunities: concrete opportunities mentioned, each with one category: {", ".join(CATEGORIES)}.
- quotes: short, striking quotes copied character for character from the S lines (not from T lines, not translated), under {QUOTE_MAX_WORDS} words each.
- disagreements: moments where Raj and the guest disagree, saying what each one holds.
- raj_questions: Raj's questions to the guest, in English, each with a type: {", ".join(QUESTION_TYPES)}.
- raj_opinions: opinions Raj states himself (not questions, not the guest's views).
- clips: {CLIP_SECONDS[0]}-{CLIP_SECONDS[1]} second stretches that make sense on their own, with a short topic, a score from 0 to 1 for how strong a standalone clip it is, and opening_line copied from the first S line of the clip. source_segment_ids lists every S line in the clip, first to last.

Lists may be empty when the transcript has nothing that fits."""


def _ids() -> dict:
    return {"type": "array", "items": {"type": "integer"}}


KINDS = {"takeaways": "takeaway", "opportunities": "opportunity", "quotes": "quote",
         "disagreements": "disagreement", "raj_questions": "raj_question", "raj_opinions": "raj_opinion"}

# One fixed schema for every request. Every property is required: the API allows
# only 24 optional ones, and required properties come back in schema order. The six
# kinds of insight share one "items" list with a kind field, because a separate
# list per kind compiles to a grammar the API rejects as too large.
OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "speakers": {"type": "array", "items": {
            "type": "object",
            "properties": {"from_id": {"type": "integer"}, "to_id": {"type": "integer"},
                           "speaker": {"type": "string", "enum": SPEAKERS}},
            "required": ["from_id", "to_id", "speaker"], "additionalProperties": False}},
        "guest": {
            "type": "object",
            "properties": {"name": {"type": "string"}, "organisation": {"type": "string"},
                           "role_at_episode": {"type": "string"},
                           "sector_tags": {"type": "array", "items": {"type": "string"}},
                           "bio": {"type": "string"}, "source_segment_ids": _ids(), "translation_line_ids": _ids(),
                           "translated": {"type": "boolean"}},
            "required": ["name", "organisation", "role_at_episode", "sector_tags", "bio", "source_segment_ids",
                         "translation_line_ids", "translated"],
            "additionalProperties": False},
        "topics": {"type": "array", "items": {
            "type": "object",
            "properties": {"tag": {"type": "string"}, "source_segment_ids": _ids(), "translation_line_ids": _ids(),
                           "translated": {"type": "boolean"}},
            "required": ["tag", "source_segment_ids", "translation_line_ids", "translated"],
            "additionalProperties": False}},
        "items": {"type": "array", "items": {
            "type": "object",
            "properties": {"kind": {"type": "string", "enum": list(KINDS.values())}, "text": {"type": "string"},
                           "category": {"type": "string", "enum": [*CATEGORIES, "none"]},
                           "question_type": {"type": "string", "enum": [*QUESTION_TYPES, "none"]},
                           "source_segment_ids": _ids(), "translation_line_ids": _ids(),
                           "translated": {"type": "boolean"}},
            "required": ["kind", "text", "category", "question_type", "source_segment_ids", "translation_line_ids",
                         "translated"],
            "additionalProperties": False}},
        "clips": {"type": "array", "items": {
            "type": "object",
            "properties": {"opening_line": {"type": "string"}, "topic": {"type": "string"},
                           "score": {"type": "number"}, "source_segment_ids": _ids(),
                           "translation_line_ids": _ids(), "translated": {"type": "boolean"}},
            "required": ["opening_line", "topic", "score", "source_segment_ids", "translation_line_ids",
                         "translated"],
            "additionalProperties": False}},
    },
    "required": ["speakers", "guest", "topics", "items", "clips"],
    "additionalProperties": False,
}
ITEM_LISTS = [*KINDS, "clips"]
INSIGHT_TYPES = KINDS

log = logging.getLogger("extract")


def load_captions_module():
    spec = importlib.util.spec_from_file_location("captions", Path(__file__).with_name("05_captions.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


captions = load_captions_module()
db_call = captions.db_call


# ---------- paths and small helpers ----------

def model_dir(key: str) -> Path:
    return EXTRACT_DIR / key


def merged_path(key: str, vid: str) -> Path:
    return model_dir(key) / f"{vid}.json"


def plan_path(key: str, vid: str) -> Path:
    return model_dir(key) / "plans" / f"{vid}.json"


def part_dir(key: str) -> Path:
    return model_dir(key) / "parts"


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(value, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def clock(seconds: float) -> str:
    s = int(seconds)
    return f"{s // 60:02d}:{s % 60:02d}"


def cost(key: str, usage: dict) -> float:
    price_in, price_out = BATCH_PRICES[key]
    return (usage["input_tokens"] * price_in + usage["output_tokens"] * price_out) / 1e6


def part_usage(path: Path) -> dict:
    """Tokens of every attempt at one part, failed ones included."""
    if not path.exists():
        return {"input_tokens": 0, "output_tokens": 0}
    record = read_json(path)
    usages = [*record.get("earlier_usage", []), record["usage"]]
    return {k: sum(u[k] for u in usages) for k in ("input_tokens", "output_tokens")}


def normalise(text: str) -> str:
    return " ".join(re.sub(r"[^\w\s]", " ", text.lower()).split())


# ---------- input ----------

def read_episodes(which: str) -> list[dict]:
    with CANDIDATES_CSV.open(newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    return [r for r in rows if which == "all" or r["test_set"] == "yes"]


def fetch_all(db, table: str, columns: str, vid: str, order: str) -> list[dict]:
    rows, start = [], 0
    while True:
        page = db_call(f"{table} select", lambda: db.table(table).select(columns).eq("video_id", vid)
                       .order(order).range(start, start + DB_PAGE - 1).execute()).data
        rows += page
        if len(page) < DB_PAGE:
            return rows
        start += DB_PAGE


def episode_lines(db, ep: dict) -> list[dict] | None:
    """The episode's S lines from the database, each with its T line when the episode is Hindi."""
    vid = ep["video_id"]
    segments = fetch_all(db, "segments", "id,seq,start_s,end_s,text_roman", vid, "seq")
    if not segments:
        return None
    translations = fetch_all(db, "translation_segments", "id,start_s,end_s,text", vid, "id")
    if translations and len(translations) != len(segments):
        log.warning("%s: %s translation lines for %s segments; matching them by start time", vid,
                    len(translations), len(segments))
    by_start = {round(t["start_s"], 2): t for t in translations}
    lines = []
    for i, s in enumerate(segments):
        t = translations[i] if len(translations) == len(segments) else by_start.get(round(s["start_s"], 2))
        lines.append({"id": s["id"], "seq": s["seq"], "start": s["start_s"], "end": s["end_s"],
                      "text": s["text_roman"], "t_id": t["id"] if t else None, "t_text": t["text"] if t else ""})
    return lines


def format_lines(lines: list[dict]) -> str:
    out = []
    for l in lines:
        out.append(f"[S{l['id']} | {clock(l['start'])}] {l['text']}")
        if l["t_id"] is not None:
            out.append(f"[T{l['t_id']} | {clock(l['start'])}] {l['t_text']}")
    return "\n".join(out)


def takeaway_count(parts: int) -> str:
    if parts == 1:
        return "5-7 takeaways for the whole episode"
    n = max(2, round(6 / parts))
    return f"about {n} takeaways from this part"


def user_prompt(ep: dict, lines: list[dict], part: int, parts: int) -> str:
    head = f"Episode title: {ep['title']}\nPublished: {ep['published_at'][:10]}\n"
    if parts > 1:
        head += (f"This is part {part} of {parts} of the transcript (it overlaps a little with its neighbours); "
                 f"extract only from the lines shown.\n")
    head += f"Give {takeaway_count(parts)}.\n\nTranscript:\n"
    return head + format_lines(lines)


def build_request(custom_id: str, model: str, prompt: str) -> Request:
    return Request(custom_id=custom_id, params=MessageCreateParamsNonStreaming(
        model=model, max_tokens=MAX_TOKENS, system=SYSTEM_PROMPT,
        output_config={"effort": EFFORT, "format": {"type": "json_schema", "schema": OUTPUT_SCHEMA}},
        messages=[{"role": "user", "content": prompt}]))


def count_tokens(client, model: str, prompt: str) -> int:
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            return client.messages.count_tokens(model=model, system=SYSTEM_PROMPT,
                                                messages=[{"role": "user", "content": prompt}]).input_tokens
        except anthropic.RateLimitError:
            log.info("token counting rate limited, waiting %ss", 10 * attempt)
            time.sleep(10 * attempt)
    raise RuntimeError("token counting kept hitting the rate limit")


def make_plan(client, key: str, ep: dict, lines: list[dict]) -> dict:
    """Split the episode into parts under MAX_INPUT_TOKENS, saved so a rerun uses the same parts."""
    path = plan_path(key, ep["video_id"])
    if path.exists():
        return read_json(path)
    model, budget = MODELS[key], MAX_INPUT_TOKENS - TOKEN_MARGIN
    total = count_tokens(client, model, user_prompt(ep, lines, 1, 1))
    n = 1 if total <= budget else math.ceil(total / (budget * 0.9))
    while True:
        size = math.ceil(len(lines) / n)
        cores = [(i * size, min(len(lines), (i + 1) * size)) for i in range(n)]
        parts = [{"core": [lo, hi], "span": [max(0, lo - OVERLAP_SEGMENTS // 2 if i else lo),
                                             min(len(lines), hi + OVERLAP_SEGMENTS // 2 if i < n - 1 else hi)]}
                 for i, (lo, hi) in enumerate(cores)]
        for i, p in enumerate(parts):
            p["tokens"] = total if n == 1 else count_tokens(
                client, model, user_prompt(ep, lines[p["span"][0]:p["span"][1]], i + 1, n))
        if all(p["tokens"] <= budget for p in parts):
            break
        n += 1
    plan = {"video_id": ep["video_id"], "segments": len(lines), "total_tokens": total, "parts": parts}
    write_json(path, plan)
    log.info("%s: %s tokens, %s part(s): %s", ep["video_id"], total, len(parts),
             ", ".join(str(p["tokens"]) for p in parts))
    return plan


# ---------- one part's answer ----------

def save_part(path: Path, custom_id: str, _expected, result) -> None:
    record = {"custom_id": custom_id, "result_type": result.type, "complete": False,
              "usage": {"input_tokens": 0, "output_tokens": 0}, "error": ""}
    if result.type == "succeeded":
        msg = result.message
        record["usage"] = {"input_tokens": msg.usage.input_tokens, "output_tokens": msg.usage.output_tokens}
        record["stop_reason"] = msg.stop_reason
        record["raw_text"] = next((b.text for b in msg.content if b.type == "text"), "")
        if msg.stop_reason != "end_turn":
            record["error"] = f"stop_reason {msg.stop_reason}"
        else:
            try:
                answer = json.loads(record["raw_text"])
                missing = [k for k in OUTPUT_SCHEMA["required"] if k not in answer]
                if missing:
                    raise ValueError(f"missing keys {missing}")
                record["answer"] = answer
                record["complete"] = True
            except (json.JSONDecodeError, ValueError, TypeError) as exc:
                record["error"] = f"bad JSON: {exc}"
    else:
        record["error"] = str(getattr(result, "error", "") or result.type)[:500]
    if path.exists():
        old = read_json(path)
        record["earlier_usage"] = [*old.get("earlier_usage", []), old["usage"]]
        record["earlier_errors"] = [*old.get("earlier_errors", []), old.get("error", "")]
    write_json(path, record)
    if record["complete"]:
        log.info("%s: ok (%s in / %s out tokens)", custom_id, record["usage"]["input_tokens"],
                 record["usage"]["output_tokens"])
    else:
        log.warning("%s: %s", custom_id, record["error"])


def attempts(path: Path) -> int:
    return romanize_lib.attempts(path)


# ---------- merging and checking ----------

def clean_ids(item: dict, s_ids: set[int], t_ids: set[int], stats: dict) -> dict | None:
    ids = [i for i in item.get("source_segment_ids", []) if i in s_ids]
    bad = len(item.get("source_segment_ids", [])) - len(ids)
    stats["unknown_ids_removed"] += bad
    if not ids:
        stats["dropped_no_ids"] += 1
        return None
    out = dict(item)
    out["source_segment_ids"] = sorted(set(ids))
    out["translation_line_ids"] = sorted({i for i in item.get("translation_line_ids", []) if i in t_ids})
    return out


def by_kind(answer: dict, stats: dict) -> dict[str, list[dict]]:
    """The answer's shared items list sorted into one list per kind, with checked category and question type.

    Enum values may come back with different capitals, so they are compared in lower case.
    """
    lists = {name: [] for name in KINDS}
    names = {kind: name for name, kind in KINDS.items()}
    for item in answer["items"]:
        name = names.get(item["kind"].lower())
        if not name:
            continue
        item = dict(item)
        category, qtype = item.pop("category").lower(), item.pop("question_type").lower()
        item["check_notes"] = ""
        if name == "opportunities":
            item["category"] = category if category in CATEGORIES else None
            if not item["category"]:
                item["check_notes"] = "no category"
                stats["opportunities_without_category"] += 1
        if name == "raj_questions":
            item["question_type"] = qtype if qtype in QUESTION_TYPES else "none"
        lists[name].append(item)
    return lists | {"clips": answer["clips"]}


def merge(ep: dict, lines: list[dict], plan: dict, answers: list[dict]) -> dict:
    by_id = {l["id"]: l for l in lines}
    order = {l["id"]: i for i, l in enumerate(lines)}
    t_ids = {l["t_id"] for l in lines if l["t_id"] is not None}
    stats = {"unknown_ids_removed": 0, "dropped_no_ids": 0, "speaker_lines_unassigned": 0,
             "speaker_lines_conflicting": 0, "quotes_not_verbatim": 0, "quotes_too_long": 0,
             "clips_off_length": 0, "takeaways_trimmed": 0, "opportunities_without_category": 0}
    speakers: dict[int, str] = {}
    merged = {k: [] for k in ITEM_LISTS}
    topics, guests = [], []

    for part, answer in zip(plan["parts"], answers):
        lo, hi = part["core"]
        span_ids = {lines[i]["id"] for i in range(*part["span"])}
        core_ids = {lines[i]["id"] for i in range(lo, hi)}
        part_speakers: dict[int, str] = {}
        for run in answer["speakers"]:
            a, b = run["from_id"], run["to_id"]
            if a not in order or b not in order:
                continue
            for i in range(min(order[a], order[b]), max(order[a], order[b]) + 1):
                sid = lines[i]["id"]
                if sid in span_ids:
                    if sid in part_speakers and part_speakers[sid] != run["speaker"].lower():
                        stats["speaker_lines_conflicting"] += 1
                    part_speakers[sid] = run["speaker"].lower()
        for sid in core_ids:
            if sid not in part_speakers:
                stats["speaker_lines_unassigned"] += 1
            speakers[sid] = part_speakers.get(sid, "unknown")
        lists = by_kind(answer, stats)
        for name in ITEM_LISTS:
            for item in lists[name]:
                item = clean_ids(item, span_ids, t_ids, stats)
                if item and item["source_segment_ids"][0] in core_ids:
                    merged[name].append(item)
        for topic in answer["topics"]:
            topic = clean_ids(topic, span_ids, t_ids, stats)
            if topic:
                topics.append(topic)
        guest = clean_ids(answer["guest"], span_ids, t_ids, stats) if answer["guest"]["name"].strip() else None
        if guest:
            guests.append(guest)

    for quote in merged["quotes"]:
        notes = []
        cited = " ".join(by_id[i]["text"] for i in quote["source_segment_ids"])
        if normalise(quote["text"]) not in normalise(cited):
            notes.append("quote not found word for word in the cited S lines")
            stats["quotes_not_verbatim"] += 1
        if len(quote["text"].split()) >= QUOTE_MAX_WORDS:
            notes.append(f"quote has {len(quote['text'].split())} words")
            stats["quotes_too_long"] += 1
        quote["check_notes"] = "; ".join(notes)
    for clip in merged["clips"]:
        ids = clip["source_segment_ids"]
        clip["start_s"], clip["end_s"] = by_id[ids[0]]["start"], by_id[ids[-1]]["end"]
        length = clip["end_s"] - clip["start_s"]
        clip["check_notes"] = ""
        if not CLIP_SECONDS[0] <= length <= CLIP_SECONDS[1]:
            clip["check_notes"] = f"clip is {length:.0f} seconds"
            stats["clips_off_length"] += 1
        clip["score"] = min(1.0, max(0.0, float(clip["score"])))

    if len(merged["takeaways"]) > MAX_TAKEAWAYS:
        # Several parts each gave some: keep a spread over the episode.
        keep = sorted(range(len(merged["takeaways"])),
                      key=lambda i: (i % max(1, len(plan["parts"])), i))[:MAX_TAKEAWAYS]
        stats["takeaways_trimmed"] = len(merged["takeaways"]) - MAX_TAKEAWAYS
        merged["takeaways"] = [merged["takeaways"][i] for i in sorted(keep)]

    guest = None
    if guests:
        guest = dict(guests[0])
        for other in guests[1:]:
            for field in ("organisation", "role_at_episode", "bio"):
                guest[field] = guest[field] or other[field]
            guest["sector_tags"] = guest["sector_tags"] + [t for t in other["sector_tags"]
                                                           if t.lower() not in {x.lower() for x in guest["sector_tags"]}]
            guest["source_segment_ids"] = sorted({*guest["source_segment_ids"], *other["source_segment_ids"]})
    seen, unique_topics = set(), []
    for topic in topics:
        if topic["tag"].strip().lower() not in seen:
            seen.add(topic["tag"].strip().lower())
            unique_topics.append(topic)

    return {"speakers": {str(k): v for k, v in speakers.items()}, "guest": guest, "topics": unique_topics,
            **merged, "checks": stats}


# ---------- database ----------

def span(ids: list[int], by_id: dict) -> tuple[float, float]:
    return min(by_id[i]["start"] for i in ids), max(by_id[i]["end"] for i in ids)


def write_rows(db, key: str, ep: dict, lines: list[dict], result: dict) -> dict:
    vid, model, run_id = ep["video_id"], MODELS[key], result["run_id"]
    by_id = {l["id"]: l for l in lines}
    for table in ("insights", "clips", "guests"):
        db_call(f"{table} delete", lambda: db.table(table).delete().eq("video_id", vid).eq("model", model).execute())
    guest_id = None
    g = result["guest"]
    if g:
        row = {"name": g["name"], "organisation": g["organisation"] or None,
               "role_at_episode": g["role_at_episode"] or None, "sector_tags": g["sector_tags"],
               "bio": g["bio"] or None, "video_id": vid, "model": model, "run_id": run_id}
        guest_id = db_call("guests insert", lambda: db.table("guests").insert(row).execute()).data[0]["id"]
    rows = []
    for name, type_ in INSIGHT_TYPES.items():
        for item in result[name]:
            start, end = span(item["source_segment_ids"], by_id)
            notes = [item.get("check_notes", "")]
            if name == "raj_questions":
                notes.insert(0, f"question_type: {item['question_type']}")
            rows.append({"video_id": vid, "guest_id": guest_id, "type": type_,
                         "category": item.get("category"), "text": item["text"], "start_s": start, "end_s": end,
                         "source_segment_ids": item["source_segment_ids"], "translated": bool(item["translated"]),
                         "verified": False, "check_notes": "; ".join(n for n in notes if n) or None,
                         "model": model, "run_id": run_id})
    for i in range(0, len(rows), DB_BATCH):
        chunk = rows[i:i + DB_BATCH]
        db_call("insights insert", lambda: db.table("insights").insert(chunk).execute())
    clips = [{"video_id": vid, "start_s": c["start_s"], "end_s": c["end_s"], "opening_line": c["opening_line"],
              "topic": c["topic"], "score": c["score"], "verified": False, "model": model, "run_id": run_id}
             for c in result["clips"]]
    if clips:
        db_call("clips insert", lambda: db.table("clips").insert(clips).execute())
    return {"guests": 1 if guest_id else 0, "insights": len(rows), "clips": len(clips)}


def write_speakers(db, vid: str, speakers: dict[str, str]) -> None:
    groups: dict[str, list[int]] = {}
    for sid, who in speakers.items():
        groups.setdefault(who, []).append(int(sid))
    for who, ids in groups.items():
        for i in range(0, len(ids), SPEAKER_UPDATE_IDS):
            chunk = ids[i:i + SPEAKER_UPDATE_IDS]
            db_call("segments speaker update", lambda: db.table("segments").update({"speaker": who})
                    .eq("video_id", vid).in_("id", chunk).execute())


# ---------- run ----------

def run(key: str, which: str) -> None:
    model = MODELS[key]
    client = anthropic.Anthropic(max_retries=MAX_RETRIES)
    db = captions.supabase_client()
    part_dir(key).mkdir(parents=True, exist_ok=True)
    run_id = f"extract-{key}-{datetime.now().strftime('%Y%m%d-%H%M%S')}"
    job_path = model_dir(key) / "batch_job.json"
    episodes = read_episodes(which)
    log.info("%s episodes in set %s, model %s, run %s", len(episodes), which, model, run_id)

    todo, lines_of, plans, skipped = [], {}, {}, []
    for ep in episodes:
        vid = ep["video_id"]
        if merged_path(key, vid).exists():
            continue
        lines = episode_lines(db, ep)
        if not lines:
            skipped.append(vid)
            continue
        lines_of[vid], plans[vid] = lines, make_plan(client, key, ep, lines)
        todo.append(ep)
    if skipped:
        log.info("%s episodes have no transcript in the database yet, skipped", len(skipped))

    def part_ids(ep):
        n = len(plans[ep["video_id"]]["parts"])
        return [f"{ep['video_id']}-p{i + 1}" for i in range(n)]

    for round_no in range(1, MAX_ROUNDS + 1):
        requests = {}
        for ep in todo:
            vid, plan = ep["video_id"], plans[ep["video_id"]]
            for i, cid in enumerate(part_ids(ep)):
                path = part_dir(key) / f"{cid}.json"
                if romanize_lib.chunk_done(path) or attempts(path) >= MAX_ATTEMPTS:
                    continue
                lo, hi = plan["parts"][i]["span"]
                requests[cid] = build_request(cid, model, user_prompt(ep, lines_of[vid][lo:hi], i + 1,
                                                                       len(plan["parts"])))
        if not requests:
            break
        log.info("Round %s: %s requests", round_no, len(requests))
        limited = romanize_lib.run_batch(client, requests, {c: [] for c in requests}, job_path, part_dir(key),
                                         save=save_part)
        romanize_lib.wait_after_rate_limit(limited)

    for ep in todo:
        vid = ep["video_id"]
        paths = [part_dir(key) / f"{c}.json" for c in part_ids(ep)]
        if not all(romanize_lib.chunk_done(p) for p in paths):
            continue
        result = merge(ep, lines_of[vid], plans[vid], [read_json(p)["answer"] for p in paths])
        usage = [part_usage(p) for p in paths]
        result |= {"video_id": vid, "model": model, "run_id": run_id, "parts": len(paths),
                   "usage": {k: sum(u[k] for u in usage) for k in ("input_tokens", "output_tokens")}}
        result["cost_usd"] = round(cost(key, result["usage"]), 6)
        result["db_written"] = False
        write_json(merged_path(key, vid), result)

    # Write to the database whatever is merged and not yet written (also from earlier runs).
    for ep in episodes:
        vid, path = ep["video_id"], merged_path(key, ep["video_id"])
        if not path.exists():
            continue
        result = read_json(path)
        if result["db_written"] and (key != "haiku" or result.get("speakers_written")):
            continue
        lines = lines_of.get(vid) or episode_lines(db, ep)
        if not result["db_written"]:
            result["db_rows"] = write_rows(db, key, ep, lines, result)
            result["db_written"] = True
            write_json(path, result)
            log.info("%s: wrote %s", vid, result["db_rows"])
        if key == "haiku" and not result.get("speakers_written"):
            write_speakers(db, vid, result["speakers"])
            result["speakers_written"] = True
            write_json(path, result)
            log.info("%s: speakers written for %s segments", vid, len(result["speakers"]))

    print_summary(key, episodes, run_id)


def print_summary(key: str, episodes: list[dict], run_id: str) -> None:
    done, failed = [], []
    for ep in episodes:
        vid = ep["video_id"]
        if merged_path(key, vid).exists():
            done.append(read_json(merged_path(key, vid)))
            continue
        plan = plan_path(key, vid)
        if plan.exists():
            n = len(read_json(plan)["parts"])
            errors = [f"{vid}-p{i + 1}: {read_json(p).get('error')}" for i in range(n)
                      if (p := part_dir(key) / f"{vid}-p{i + 1}.json").exists() and not romanize_lib.chunk_done(p)]
            failed.append(f"{vid}: " + ("; ".join(errors) or "not finished"))
    usage = {"input_tokens": 0, "output_tokens": 0}
    vids = {ep["video_id"] for ep in episodes}
    for p in part_dir(key).glob("*.json"):
        if (m := re.fullmatch(r"(.+)-p\d+", p.stem)) and m.group(1) in vids:
            u = part_usage(p)
            usage = {k: usage[k] + u[k] for k in usage}
    this_run = [r for r in done if r["run_id"] == run_id]
    print()
    print(f"=== {MODELS[key]} (Batch API, effort {EFFORT}) ===")
    print(f"Episodes done: {len(done)} of {len(episodes)} ({len(this_run)} extracted in this run, "
          f"{sum(r['parts'] > 1 for r in done)} split into parts)")
    counts = {"guest": sum(1 for r in done if r["guest"]), "topics": sum(len(r["topics"]) for r in done)}
    counts |= {name: sum(len(r[name]) for r in done) for name in ITEM_LISTS}
    print("Items: " + ", ".join(f"{k} {v}" for k, v in counts.items()))
    speakers: dict[str, int] = {}
    for r in done:
        for who in r["speakers"].values():
            speakers[who] = speakers.get(who, 0) + 1
    print("Speakers: " + ", ".join(f"{k} {v:,}" for k, v in sorted(speakers.items())))
    checks: dict[str, int] = {}
    for r in done:
        for k, v in r["checks"].items():
            checks[k] = checks.get(k, 0) + v
    print("Checks: " + ", ".join(f"{k} {v}" for k, v in checks.items()))
    print(f"Translated-only items: {sum(1 for r in done for n in ITEM_LISTS for i in r[n] if i['translated'])}")
    print(f"Failures: {len(failed)}")
    for f in failed:
        print(f"    {f}")
    print(f"Tokens, all attempts: {usage['input_tokens']:,} in, {usage['output_tokens']:,} out")
    print(f"Cost, all attempts: USD {cost(key, usage):.4f} "
          f"(USD {BATCH_PRICES[key][0]}/{BATCH_PRICES[key][1]} per million tokens in/out)")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--model", choices=MODELS, required=True)
    parser.add_argument("--set", choices=["test_set", "all"], required=True)
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    load_dotenv(ROOT / ".env")
    if not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit("ANTHROPIC_API_KEY must be set in .env")
    run(args.model, args.set)


if __name__ == "__main__":
    main()
