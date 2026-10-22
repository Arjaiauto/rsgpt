"""Extract guests, insights, clips and speakers from transcripts with Claude, through the Message Batches API.

Two steps, each with one fixed JSON schema for every request (so the API compiles
each schema once):

1. Speakers (always claude-haiku-5-5). Each episode's lines go in chunks of
   SPEAKER_CHUNK_LINES, with a few lines of context either side, and come back as
   one letter per line in a single string: r = Raj, g = guest, u = unknown. The
   length must match the number of lines. A chunk whose answer is all one letter or
   more than half u is asked again, and the best answer kept.

2. Extraction (--model haiku or sonnet). One request per episode, or per part for
   long episodes. The input is the episode title and date, then every segment as
   [S<segment id> R|G|U | mm:ss] text_roman with step 1's speaker letter and, for
   Hindi episodes, the English translation of each line as [T<translation id> | mm:ss]
   text right under it. The answer holds guest, topics, items (takeaways,
   opportunities with one of the 13 categories in schema.sql, quotes, disagreements,
   Raj's questions and Raj's opinions) and clips (first and last line ID). Every item
   points to S segment IDs; an item that rests only on T lines is marked translated.
   A part with no items at all, or no Raj questions while Raj speaks in many turns,
   is asked once more and the fuller answer kept.

Checks in code: item IDs must be S IDs from the request (unknown IDs are removed,
an item left with none is dropped); quotes must appear word for word in the cited
S lines and be under 25 words, otherwise check_notes says so; clips outside 30-90
seconds are dropped.

An episode over MAX_INPUT_TOKENS (counted with the token-counting endpoint) is
split into parts that overlap by OVERLAP_SEGMENTS lines. Each part owns the lines
up to the middle of each overlap, and items come from the part that owns their
first segment, so nothing is counted twice.

Results:
  data/extractions/speakers/<video_id>.json         speaker letters per segment (chunk answers in chunks/)
  data/extractions/<model>/<VERSION>/<video_id>.json  merged extraction (part answers in parts/)
  guests, insights, clips   rows with verified = false, model and run_id; rerunning replaces only the
                            rows of the same run_id, so earlier runs stay for comparison
  segments.speaker          from step 1, written by the haiku run

Resumable: speaker answers, split plans, part answers, merged files, the run ID and
the batch IDs are saved as they are made, so a rerun only sends what is missing and
only writes what has not been written. Results refused for a rate limit are not
counted as attempts and are sent again after a pause (romanize_lib.run_batch).

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
SPEAKER_DIR = EXTRACT_DIR / "speakers"
# Prompt version of the extraction step. Results of each version live in their own folder,
# so an earlier version's files are kept for comparison (v1 sits directly in <model>/).
VERSION = "v2"

MODELS = {"haiku": "claude-haiku-5-5", "sonnet": "claude-sonnet-5-5"}
SPEAKER_MODEL = "haiku"
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
QUOTES = (5, 10)
CLIPS = (4, 8)
QUOTE_MAX_WORDS = 25
CLIP_SECONDS = (30, 90)
RAJ_TURNS_FOR_QUESTIONS = 5  # a part where Raj speaks in this many turns should have some of his questions

SPEAKER_CHUNK_LINES = 400
SPEAKER_CONTEXT = (8, 4)  # unlabelled lines shown before and after a chunk
SPEAKER_ATTEMPTS = 3
SPEAKER_MAX_TOKENS = 16000
SPEAKER_MAX_UNKNOWN = 0.5
SPEAKER_MIN_LINES_FOR_ONE_LABEL = 50  # a chunk this long that is all one letter is suspicious
LETTERS = {"r": "raj", "g": "guest", "u": "unknown"}

DB_PAGE = 1000
DB_BATCH = 500
SPEAKER_UPDATE_IDS = 400
MAX_RETRIES = 5

CATEGORIES = ["growing_sectors", "business_ideas", "market_gaps", "underrated_skills", "career_paths",
              "investment_themes", "hiring_signals", "policy_shifts", "geographic_opportunities",
              "tools_and_tech", "contrarian_takes", "resources", "warnings"]
QUESTION_TYPES = ["opening", "follow-up", "challenge", "personal", "deep-dive"]

SPEAKER_PROMPT = """You label who speaks each line of a transcript of the Figuring Out podcast. Raj Shamani is the host: he introduces the episode and the guest, asks the questions, reacts and pushes back. The guest answers, tells their story and explains. Sponsor reads and the intro are Raj.

For every line under "Lines to label", give one letter, in order:
r = Raj, g = the guest, u = unknown (only when you really cannot tell, for example a line split between both speakers).

Lines are fragments of running speech: a speaker usually keeps talking for several lines, and a question from Raj is usually followed by the guest's answer. Use the context lines to follow the conversation, but do not label them.

Return "labels": exactly one letter per line to label, written in groups of 10 separated by a space (for example "rrrrgggggg gggggggggg ggrrr")."""

SYSTEM_PROMPT = f"""You read the transcript of one episode of the Figuring Out podcast and extract structured research notes from it. Raj Shamani is the host: he asks the questions. The guest answers them.

The transcript lines come in two kinds:
- [S<id> <speaker> | mm:ss] lines are the transcript itself, in Roman script (Hinglish for Hindi episodes). The speaker letter is R for Raj, G for the guest or U for unknown; the letters were added by a machine and can be wrong now and then.
- [T<id> | mm:ss] lines are machine English translations of the S line just above them. They are only there to help you understand Hindi; they are not the source.

Ground rules:
1. Only use what is said in the transcript. If you are unsure about something, leave it out. Never invent names, numbers, facts, organisations, questions or opinions, and never fill gaps from your own knowledge.
2. Every item must point to the S line IDs (numbers only, without the "S") where it is said. Cite the lines that actually contain it, not whole stretches.
3. If an item rests only on what the T lines say, because you could not confirm it from the S lines, also list those T IDs and set translated to true. Otherwise translated is false and translation_line_ids may be empty.
4. Write takeaways, opportunities, disagreements, opinions, questions and topics in the third person in English ("Raj argues...", "The guest says..."). Never write as Raj in the first person.
5. Never include phone numbers, email addresses or other contact details.

What to return. Takeaways, opportunities, quotes, disagreements, Raj's questions and Raj's opinions all go in the one "items" list, each with its kind; category is "none" except for opportunities, and question_type is "none" except for Raj's questions.
- guest: the main guest's name, organisation, role at the time of the episode, sector tags, and a bio of 2-3 lines using only what was said in the episode. Use empty strings and lists for anything not said.
- topics: short tags for what the episode covers.
- takeaway: the key takeaways (the request says how many).
- opportunity: every concrete opportunity mentioned (a sector, business idea, market gap, skill, career path, investment theme, hiring signal, policy shift, place, tool, contrarian take, resource or warning), each with one category: {", ".join(CATEGORIES)}.
- quote: short, striking quotes (the request says how many), under {QUOTE_MAX_WORDS} words each, copied exactly as written in the cited S lines: same words, same spelling, same fillers and repetitions, never from T lines and never translated, corrected or tidied.
- disagreement: every real disagreement between Raj and the guest, saying what each one holds.
- raj_question: every distinct question Raj asks the guest, written in English, each with a type: {", ".join(QUESTION_TYPES)}. A long episode usually has dozens.
- raj_opinion: every opinion Raj states himself (not his questions, not the guest's views).
- clips: stretches of {CLIP_SECONDS[0]}-{CLIP_SECONDS[1]} seconds that make sense on their own (the request says how many), each as the S ID of its first and last line, with a short topic and a score from 0 to 1 for how strong a standalone clip it is. Check the timestamps: the last line should start {CLIP_SECONDS[0]}-{CLIP_SECONDS[1]} seconds after the first.

A list is empty only if the episode truly has nothing of that kind."""


def _ids() -> dict:
    return {"type": "array", "items": {"type": "integer"}}


KINDS = {"takeaways": "takeaway", "opportunities": "opportunity", "quotes": "quote",
         "disagreements": "disagreement", "raj_questions": "raj_question", "raj_opinions": "raj_opinion"}

SPEAKER_SCHEMA = {"type": "object", "properties": {"labels": {"type": "string"}}, "required": ["labels"],
                  "additionalProperties": False}

# One fixed schema for every extraction request. Every property is required: the API
# allows only 24 optional ones, and required properties come back in schema order. The
# six kinds of insight share one "items" list with a kind field, because a separate
# list per kind compiles to a grammar the API rejects as too large.
OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
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
            "properties": {"first_id": {"type": "integer"}, "last_id": {"type": "integer"},
                           "topic": {"type": "string"}, "score": {"type": "number"}},
            "required": ["first_id", "last_id", "topic", "score"],
            "additionalProperties": False}},
    },
    "required": ["guest", "topics", "items", "clips"],
    "additionalProperties": False,
}
ITEM_LISTS = [*KINDS, "clips"]

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
    return EXTRACT_DIR / key / VERSION


def merged_path(key: str, vid: str) -> Path:
    return model_dir(key) / f"{vid}.json"


def plan_path(key: str, vid: str) -> Path:
    return model_dir(key) / "plans" / f"{vid}.json"


def part_dir(key: str) -> Path:
    return model_dir(key) / "parts"


def speaker_path(vid: str) -> Path:
    return SPEAKER_DIR / f"{vid}.json"


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
    """Tokens of every attempt at one request, failed ones included."""
    if not path.exists():
        return {"input_tokens": 0, "output_tokens": 0}
    record = read_json(path)
    usages = [*record.get("earlier_usage", []), record["usage"]]
    return {k: sum(u[k] for u in usages) for k in ("input_tokens", "output_tokens")}


def add_usage(paths) -> dict:
    usages = [part_usage(p) for p in paths]
    return {k: sum(u[k] for u in usages) for k in ("input_tokens", "output_tokens")}


def normalise(text: str) -> str:
    return " ".join(re.sub(r"[^\w\s]", " ", text.lower()).split())


def run_id_for(key: str) -> str:
    """One run ID per model and version, kept on disk so an interrupted run keeps its ID."""
    path = model_dir(key) / "run_id.txt"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"extract-{key}-{VERSION}-{datetime.now().strftime('%Y%m%d-%H%M%S')}", encoding="utf-8")
    return path.read_text(encoding="utf-8").strip()


def answer_from(msg, record: dict) -> dict | None:
    """The parsed JSON answer of a succeeded result, or None with record["error"] set."""
    record["usage"] = {"input_tokens": msg.usage.input_tokens, "output_tokens": msg.usage.output_tokens}
    record["stop_reason"] = msg.stop_reason
    record["raw_text"] = next((b.text for b in msg.content if b.type == "text"), "")
    if msg.stop_reason != "end_turn":
        record["error"] = f"stop_reason {msg.stop_reason}"
        return None
    try:
        return json.loads(record["raw_text"])
    except json.JSONDecodeError as exc:
        record["error"] = f"bad JSON: {exc}"
        return None


def save_record(path: Path, record: dict, old: dict | None) -> None:
    """Write a request's record, keeping the usage and errors of earlier attempts."""
    if old:
        record["earlier_usage"] = [*old.get("earlier_usage", []), old["usage"]]
        record["earlier_errors"] = [*old.get("earlier_errors", []), old.get("error", "")]
    write_json(path, record)
    if record["complete"]:
        log.info("%s: ok (%s in / %s out tokens)%s", record["custom_id"], record["usage"]["input_tokens"],
                 record["usage"]["output_tokens"], f"; {record['note']}" if record.get("note") else "")
    else:
        log.warning("%s: %s", record["custom_id"], record["error"])


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


# ---------- step 1: speakers ----------

def speaker_chunks(lines: list[dict]) -> list[tuple[int, int]]:
    return [(i, min(len(lines), i + SPEAKER_CHUNK_LINES)) for i in range(0, len(lines), SPEAKER_CHUNK_LINES)]


def speaker_request(custom_id: str, ep: dict, lines: list[dict], lo: int, hi: int) -> Request:
    before, after = lines[max(0, lo - SPEAKER_CONTEXT[0]):lo], lines[hi:hi + SPEAKER_CONTEXT[1]]
    fmt = lambda ls: "\n".join(f"[S{l['id']} | {clock(l['start'])}] {l['text']}" for l in ls)
    prompt = (f"Episode title: {ep['title']}\nGuest (from the title, a hint only): "
              f"{romanize_lib.guess_guest(ep['title'])}\n\n")
    if before:
        prompt += f"Context before (do not label):\n{fmt(before)}\n\n"
    prompt += f"Lines to label ({hi - lo}):\n{fmt(lines[lo:hi])}\n"
    if after:
        prompt += f"\nContext after (do not label):\n{fmt(after)}\n"
    prompt += f"\nReturn exactly {hi - lo} letters, one per line to label, in groups of 10."
    return Request(custom_id=custom_id, params=MessageCreateParamsNonStreaming(
        model=MODELS[SPEAKER_MODEL], max_tokens=SPEAKER_MAX_TOKENS, system=SPEAKER_PROMPT,
        output_config={"effort": EFFORT, "format": {"type": "json_schema", "schema": SPEAKER_SCHEMA}},
        messages=[{"role": "user", "content": prompt}]))


def labels_problem(letters: str) -> str:
    """Why a full-length answer looks wrong, or "" if it looks fine."""
    if len(letters) >= SPEAKER_MIN_LINES_FOR_ONE_LABEL and len(set(letters)) == 1:
        return f"all lines '{letters[0]}'"
    if letters.count("u") > SPEAKER_MAX_UNKNOWN * len(letters):
        return f"{letters.count('u')} of {len(letters)} lines unknown"
    return ""


def save_speakers(path: Path, custom_id: str, expected: int, result) -> None:
    """Keep a speaker answer; one with the wrong length is rejected, a suspicious one asked again."""
    old = read_json(path) if path.exists() else None
    record = {"custom_id": custom_id, "result_type": result.type, "complete": False,
              "usage": {"input_tokens": 0, "output_tokens": 0}, "error": "",
              "candidates": old.get("candidates", []) if old else []}
    if result.type == "succeeded":
        answer = answer_from(result.message, record)
        if answer is not None:
            letters = re.sub(r"\s", "", str(answer.get("labels", ""))).lower()
            if len(letters) != expected or set(letters) - set(LETTERS):
                record["error"] = f"{len(letters)} letters for {expected} lines" if len(letters) != expected \
                    else f"unexpected letters {sorted(set(letters) - set(LETTERS))}"
            else:
                problem = labels_problem(letters)
                record["candidates"].append(letters)
                if problem:
                    record["error"] = f"suspicious: {problem}"
    else:
        record["error"] = str(getattr(result, "error", "") or result.type)[:500]
    tries = 1 + (len(old.get("earlier_usage", [])) + 1 if old else 0)
    if record["candidates"] and (not record["error"] or tries >= SPEAKER_ATTEMPTS):
        # The best answer so far: fewest unknown lines, and not all one letter if possible.
        best = min(record["candidates"], key=lambda l: (bool(labels_problem(l)), l.count("u")))
        record |= {"complete": True, "labels": best, "note": labels_problem(best)}
        record["error"] = ""
    save_record(path, record, old)


def speaker_step(client, episodes: list[dict], lines_of: dict) -> dict[str, dict]:
    """Speaker letters for each episode, {video_id: {segment id: raj|guest|unknown}}."""
    chunk_dir, job_path = SPEAKER_DIR / "chunks", SPEAKER_DIR / "batch_job.json"
    chunk_dir.mkdir(parents=True, exist_ok=True)
    todo = [ep for ep in episodes if ep["video_id"] in lines_of and not speaker_path(ep["video_id"]).exists()]
    for round_no in range(1, MAX_ROUNDS + 1):
        requests, expected = {}, {}
        for ep in todo:
            vid, lines = ep["video_id"], lines_of[ep["video_id"]]
            for n, (lo, hi) in enumerate(speaker_chunks(lines)):
                cid, path = f"{vid}-s{n:03d}", chunk_dir / f"{vid}-s{n:03d}.json"
                if not romanize_lib.chunk_done(path) and romanize_lib.attempts(path) < SPEAKER_ATTEMPTS:
                    requests[cid], expected[cid] = speaker_request(cid, ep, lines, lo, hi), hi - lo
        if not requests:
            break
        log.info("Speaker round %s: %s chunks", round_no, len(requests))
        romanize_lib.wait_after_rate_limit(romanize_lib.run_batch(client, requests, expected, job_path, chunk_dir,
                                                                  save=save_speakers))
    for ep in todo:
        vid, lines = ep["video_id"], lines_of[ep["video_id"]]
        paths = [chunk_dir / f"{vid}-s{n:03d}.json" for n in range(len(speaker_chunks(lines)))]
        letters, notes = "", []
        for path, (lo, hi) in zip(paths, speaker_chunks(lines)):
            record = read_json(path) if path.exists() else {}
            if record.get("complete"):
                letters += record["labels"]
                if record.get("note"):
                    notes.append(f"{path.stem}: {record['note']}")
            else:
                letters += "u" * (hi - lo)
                notes.append(f"{path.stem}: no usable answer, lines left unknown")
        usage = add_usage(paths)
        write_json(speaker_path(vid), {
            "video_id": vid, "model": MODELS[SPEAKER_MODEL], "chunks": len(paths), "notes": notes,
            "usage": usage, "cost_usd": round(cost(SPEAKER_MODEL, usage), 6),
            "speakers": {str(l["id"]): LETTERS[c] for l, c in zip(lines, letters)}})
    return {ep["video_id"]: read_json(speaker_path(ep["video_id"]))["speakers"]
            for ep in episodes if speaker_path(ep["video_id"]).exists()}


def raj_turns(lines: list[dict], speakers: dict[str, str]) -> int:
    who = [speakers.get(str(l["id"]), "unknown") for l in lines]
    return sum(1 for i, w in enumerate(who) if w == "raj" and (i == 0 or who[i - 1] != "raj"))


# ---------- step 2: extraction requests ----------

def format_lines(lines: list[dict], speakers: dict[str, str]) -> str:
    out = []
    for l in lines:
        letter = speakers.get(str(l["id"]), "unknown")[0].upper()
        out.append(f"[S{l['id']} {letter} | {clock(l['start'])}] {l['text']}")
        if l["t_id"] is not None:
            out.append(f"[T{l['t_id']} | {clock(l['start'])}] {l['t_text']}")
    return "\n".join(out)


def share(lo: int, hi: int, parts: int) -> str:
    """How many of something one part should give, for an episode-wide range lo-hi."""
    if parts == 1:
        return f"{lo}-{hi}"
    a, b = max(1, math.ceil(lo / parts)), max(1, math.ceil(hi / parts))
    return f"{a}-{b}" if a < b else str(a)


def user_prompt(ep: dict, lines: list[dict], speakers: dict[str, str], part: int, parts: int) -> str:
    head = f"Episode title: {ep['title']}\nPublished: {ep['published_at'][:10]}\n"
    scope = "for the whole episode"
    if parts > 1:
        head += (f"This is part {part} of {parts} of the transcript (it overlaps a little with its neighbours); "
                 f"extract only from the lines shown.\n")
        scope = "from this part"
    head += (f"Give {share(5, MAX_TAKEAWAYS, parts)} takeaways, {share(*QUOTES, parts)} quotes and "
             f"{share(*CLIPS, parts)} clips {scope}, and every opportunity, disagreement, question Raj asks "
             f"and opinion Raj states {'in it' if parts > 1 else 'in the episode'}.\n\nTranscript:\n")
    return head + format_lines(lines, speakers)


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


def make_plan(client, key: str, ep: dict, lines: list[dict], speakers: dict[str, str]) -> dict:
    """Split the episode into parts under MAX_INPUT_TOKENS, saved so a rerun uses the same parts."""
    path = plan_path(key, ep["video_id"])
    if path.exists():
        return read_json(path)
    model, budget = MODELS[key], MAX_INPUT_TOKENS - TOKEN_MARGIN
    total = count_tokens(client, model, user_prompt(ep, lines, speakers, 1, 1))
    n = 1 if total <= budget else math.ceil(total / (budget * 0.9))
    while True:
        size = math.ceil(len(lines) / n)
        cores = [(i * size, min(len(lines), (i + 1) * size)) for i in range(n)]
        parts = [{"core": [lo, hi], "span": [max(0, lo - OVERLAP_SEGMENTS // 2 if i else lo),
                                             min(len(lines), hi + OVERLAP_SEGMENTS // 2 if i < n - 1 else hi)]}
                 for i, (lo, hi) in enumerate(cores)]
        for i, p in enumerate(parts):
            p["tokens"] = total if n == 1 else count_tokens(
                client, model, user_prompt(ep, lines[p["span"][0]:p["span"][1]], speakers, i + 1, n))
        if all(p["tokens"] <= budget for p in parts):
            break
        n += 1
    plan = {"video_id": ep["video_id"], "segments": len(lines), "total_tokens": total, "parts": parts}
    write_json(path, plan)
    log.info("%s: %s tokens, %s part(s): %s", ep["video_id"], total, len(parts),
             ", ".join(str(p["tokens"]) for p in parts))
    return plan


def suspicious(answer: dict, turns: int) -> str:
    """Why an extraction answer looks too thin, or "" if it looks fine."""
    if not answer["items"]:
        return "no items"
    if turns >= RAJ_TURNS_FOR_QUESTIONS and not any(i["kind"].lower() == "raj_question" for i in answer["items"]):
        return f"no Raj questions although Raj speaks in {turns} turns"
    return ""


def fullness(answer: dict) -> tuple[int, int]:
    return (sum(1 for i in answer["items"] if i["kind"].lower() == "raj_question"), len(answer["items"]))


def save_part(path: Path, custom_id: str, info: dict, result) -> None:
    """Keep an extraction answer. A thin one (see suspicious) is asked once more and the fuller one kept."""
    old = read_json(path) if path.exists() else None
    record = {"custom_id": custom_id, "result_type": result.type, "complete": False,
              "usage": {"input_tokens": 0, "output_tokens": 0}, "error": "",
              "retried_thin": bool(old and old.get("retried_thin")),
              "held_answer": old.get("held_answer") if old else None}
    answer = None
    if result.type == "succeeded":
        answer = answer_from(result.message, record)
        if answer is not None and [k for k in OUTPUT_SCHEMA["required"] if k not in answer]:
            record["error"] = f"bad JSON: missing keys {[k for k in OUTPUT_SCHEMA['required'] if k not in answer]}"
            answer = None
    else:
        record["error"] = str(getattr(result, "error", "") or result.type)[:500]
    held = record["held_answer"]
    if answer is not None:
        thin = suspicious(answer, info["raj_turns"])
        if thin and not record["retried_thin"]:
            record |= {"error": f"suspicious: {thin}", "held_answer": answer, "retried_thin": True}
        else:
            if held and fullness(held) > fullness(answer):
                answer, record["note"] = held, "kept the first answer, which was fuller"
            elif thin:
                record["note"] = f"still thin after a retry: {thin}"
            record |= {"answer": answer, "complete": True, "held_answer": None}
    elif held:
        # The retry of a thin answer failed outright: keep the thin answer.
        record |= {"answer": held, "complete": True, "held_answer": None, "error": "",
                   "note": "retry failed, kept the first (thin) answer"}
    save_record(path, record, old)


# ---------- merging and checking ----------

def clean_ids(item: dict, s_ids: set[int], t_ids: set[int], stats: dict) -> dict | None:
    ids = [i for i in item.get("source_segment_ids", []) if i in s_ids]
    stats["unknown_ids_removed"] += len(item.get("source_segment_ids", [])) - len(ids)
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
    return lists


def spread(items: list, limit: int, parts: int) -> list:
    """At most limit items, taken evenly from the parts they came from."""
    if len(items) <= limit:
        return items
    keep = sorted(range(len(items)), key=lambda i: (i % max(1, parts), i))[:limit]
    return [items[i] for i in sorted(keep)]


def merge(ep: dict, lines: list[dict], plan: dict, answers: list[dict]) -> dict:
    by_id = {l["id"]: l for l in lines}
    order = {l["id"]: i for i, l in enumerate(lines)}
    t_ids = {l["t_id"] for l in lines if l["t_id"] is not None}
    stats = {"unknown_ids_removed": 0, "dropped_no_ids": 0, "quotes_not_verbatim": 0, "quotes_too_long": 0,
             "clips_bad_ids": 0, "clips_dropped_off_length": 0, "takeaways_trimmed": 0, "quotes_trimmed": 0,
             "clips_trimmed": 0, "opportunities_without_category": 0}
    merged = {k: [] for k in ITEM_LISTS}
    topics, guests = [], []

    for part, answer in zip(plan["parts"], answers):
        lo, hi = part["core"]
        span_ids = {lines[i]["id"] for i in range(*part["span"])}
        core_ids = {lines[i]["id"] for i in range(lo, hi)}
        lists = by_kind(answer, stats)
        for name in KINDS:
            for item in lists[name]:
                item = clean_ids(item, span_ids, t_ids, stats)
                if item and item["source_segment_ids"][0] in core_ids:
                    merged[name].append(item)
        for clip in answer["clips"]:
            a, b = clip["first_id"], clip["last_id"]
            if a in span_ids and a not in core_ids:
                continue  # the neighbouring part owns it
            if a not in span_ids or b not in order or order[a] > order[b]:
                stats["clips_bad_ids"] += 1
                continue
            ids = [lines[i]["id"] for i in range(order[a], order[b] + 1)]
            start, end = by_id[a]["start"], by_id[b]["end"]
            if not CLIP_SECONDS[0] <= end - start <= CLIP_SECONDS[1]:
                stats["clips_dropped_off_length"] += 1
                continue
            merged["clips"].append({"source_segment_ids": ids, "start_s": start, "end_s": end,
                                    "opening_line": by_id[a]["text"], "topic": clip["topic"],
                                    "score": min(1.0, max(0.0, float(clip["score"]))), "translated": False})
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

    parts = len(plan["parts"])
    for name, limit in (("takeaways", MAX_TAKEAWAYS), ("quotes", QUOTES[1]), ("clips", CLIPS[1])):
        stats[f"{name}_trimmed"] = max(0, len(merged[name]) - limit)
        merged[name] = spread(merged[name], limit, parts)

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

    return {"guest": guest, "topics": unique_topics, **merged, "checks": stats}


# ---------- database ----------

def span(ids: list[int], by_id: dict) -> tuple[float, float]:
    return min(by_id[i]["start"] for i in ids), max(by_id[i]["end"] for i in ids)


def write_rows(db, key: str, ep: dict, lines: list[dict], result: dict) -> dict:
    """Replace this run's rows for the episode; rows of other runs are left alone."""
    vid, model, run_id = ep["video_id"], MODELS[key], result["run_id"]
    by_id = {l["id"]: l for l in lines}
    for table in ("insights", "clips", "guests"):
        db_call(f"{table} delete", lambda: db.table(table).delete().eq("video_id", vid).eq("run_id", run_id)
                .execute())
    guest_id = None
    g = result["guest"]
    if g:
        row = {"name": g["name"], "organisation": g["organisation"] or None,
               "role_at_episode": g["role_at_episode"] or None, "sector_tags": g["sector_tags"],
               "bio": g["bio"] or None, "video_id": vid, "model": model, "run_id": run_id}
        guest_id = db_call("guests insert", lambda: db.table("guests").insert(row).execute()).data[0]["id"]
    rows = []
    for name, type_ in KINDS.items():
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
    run_id = run_id_for(key)
    job_path = model_dir(key) / "batch_job.json"
    episodes = read_episodes(which)
    log.info("%s episodes in set %s, model %s, run %s", len(episodes), which, model, run_id)

    lines_of, skipped = {}, []
    for ep in episodes:
        vid = ep["video_id"]
        needs_db = merged_path(key, vid).exists() and not read_json(merged_path(key, vid)).get("db_written")
        if merged_path(key, vid).exists() and speaker_path(vid).exists() and not needs_db:
            continue
        lines = episode_lines(db, ep)
        if lines:
            lines_of[vid] = lines
        else:
            skipped.append(vid)
    if skipped:
        log.info("%s episodes have no transcript in the database yet, skipped", len(skipped))

    speakers = speaker_step(client, episodes, lines_of)
    todo, plans = [], {}
    for ep in episodes:
        vid = ep["video_id"]
        if vid in lines_of and vid in speakers and not merged_path(key, vid).exists():
            plans[vid] = make_plan(client, key, ep, lines_of[vid], speakers[vid])
            todo.append(ep)

    def part_ids(ep):
        return [f"{ep['video_id']}-p{i + 1}" for i in range(len(plans[ep["video_id"]]["parts"]))]

    for round_no in range(1, MAX_ROUNDS + 1):
        requests, info = {}, {}
        for ep in todo:
            vid, plan = ep["video_id"], plans[ep["video_id"]]
            for i, cid in enumerate(part_ids(ep)):
                path = part_dir(key) / f"{cid}.json"
                if romanize_lib.chunk_done(path) or romanize_lib.attempts(path) >= MAX_ATTEMPTS:
                    continue
                lo, hi = plan["parts"][i]["span"]
                part_lines = lines_of[vid][lo:hi]
                requests[cid] = build_request(cid, model, user_prompt(ep, part_lines, speakers[vid], i + 1,
                                                                       len(plan["parts"])))
                info[cid] = {"raj_turns": raj_turns(part_lines, speakers[vid])}
        if not requests:
            break
        log.info("Extraction round %s: %s requests", round_no, len(requests))
        romanize_lib.wait_after_rate_limit(romanize_lib.run_batch(client, requests, info, job_path, part_dir(key),
                                                                  save=save_part))

    for ep in todo:
        vid = ep["video_id"]
        paths = [part_dir(key) / f"{c}.json" for c in part_ids(ep)]
        if not all(romanize_lib.chunk_done(p) for p in paths):
            continue
        result = merge(ep, lines_of[vid], plans[vid], [read_json(p)["answer"] for p in paths])
        usage = add_usage(paths)
        result |= {"video_id": vid, "model": model, "version": VERSION, "run_id": run_id, "parts": len(paths),
                   "notes": [f"{p.stem}: {read_json(p)['note']}" for p in paths if read_json(p).get("note")],
                   "speakers": speakers[vid], "usage": usage, "cost_usd": round(cost(key, usage), 6),
                   "db_written": False}
        write_json(merged_path(key, vid), result)

    # Write to the database whatever is merged and not yet written (also from earlier runs).
    for ep in episodes:
        vid, path = ep["video_id"], merged_path(key, ep["video_id"])
        if not path.exists():
            continue
        result = read_json(path)
        if result["db_written"] and (key != SPEAKER_MODEL or result.get("speakers_written")):
            continue
        if not result["db_written"]:
            lines = lines_of.get(vid) or episode_lines(db, ep)
            result["db_rows"] = write_rows(db, key, ep, lines, result)
            result["db_written"] = True
            write_json(path, result)
            log.info("%s: wrote %s", vid, result["db_rows"])
        if key == SPEAKER_MODEL and not result.get("speakers_written"):
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
        else:
            failed.append(f"{vid}: no speakers or plan")
    vids = {ep["video_id"] for ep in episodes}
    usage = add_usage(p for p in part_dir(key).glob("*.json")
                      if (m := re.fullmatch(r"(.+)-p\d+", p.stem)) and m.group(1) in vids)
    speaker_files = [read_json(speaker_path(v)) for v in vids if speaker_path(v).exists()]
    speaker_usage = {k: sum(s["usage"][k] for s in speaker_files) for k in ("input_tokens", "output_tokens")}
    print()
    print(f"=== {MODELS[key]} (Batch API, effort {EFFORT}, prompt {VERSION}, run {run_id}) ===")
    print(f"Episodes done: {len(done)} of {len(episodes)} ({sum(r['parts'] > 1 for r in done)} split into parts)")
    counts = {"guest": sum(1 for r in done if r["guest"]), "topics": sum(len(r["topics"]) for r in done)}
    counts |= {name: sum(len(r[name]) for r in done) for name in ITEM_LISTS}
    print("Items: " + ", ".join(f"{k} {v}" for k, v in counts.items()))
    who: dict[str, int] = {}
    for s in speaker_files:
        for w in s["speakers"].values():
            who[w] = who.get(w, 0) + 1
    print("Speakers: " + ", ".join(f"{k} {v:,}" for k, v in sorted(who.items())))
    for s in speaker_files:
        for note in s["notes"]:
            print(f"    speakers {note}")
    checks: dict[str, int] = {}
    for r in done:
        for k, v in r["checks"].items():
            checks[k] = checks.get(k, 0) + v
    print("Checks: " + ", ".join(f"{k} {v}" for k, v in checks.items()))
    for r in done:
        for note in r.get("notes", []):
            print(f"    {note}")
    print(f"Translated-only items: {sum(1 for r in done for n in KINDS for i in r[n] if i['translated'])}")
    print(f"Failures: {len(failed)}")
    for f in failed:
        print(f"    {f}")
    print(f"Speaker step ({MODELS[SPEAKER_MODEL]}): {speaker_usage['input_tokens']:,} in, "
          f"{speaker_usage['output_tokens']:,} out, USD {cost(SPEAKER_MODEL, speaker_usage):.4f}")
    print(f"Extraction, all attempts: {usage['input_tokens']:,} in, {usage['output_tokens']:,} out, "
          f"USD {cost(key, usage):.4f} (USD {BATCH_PRICES[key][0]}/{BATCH_PRICES[key][1]} per million tokens in/out)")


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
