"""Extract guests, insights, clips and speakers from transcripts with Claude, through the Message Batches API.

Two steps, each with one fixed JSON schema for every request (so the API compiles
each schema once):

1. Speakers (always claude-haiku-5-5, low effort). Each episode's lines go in chunks
   of SPEAKER_CHUNK_LINES, with a few lines of context either side, shown in groups of
   SPEAKER_GROUP_LINES headed by the S ID of each group's first line. Each group comes
   back as {"from_id", "letters"} with one letter per line: r = Raj, g = guest,
   u = unknown. Every group is checked on its own: good groups are kept, and only
   missing or wrong-length ones are asked again (with the rest of the chunk shown as
   context). A group that is mostly u is asked again while it has tries left and its
   best answer kept; one with no usable answer after SPEAKER_ATTEMPTS tries is left
   unknown. The labels are written to segments.speaker.

2. Extraction (--model haiku or sonnet). One request per episode, or per part for
   long episodes. The input is the episode title and date, then every segment as
   [S<segment id> R|G|U | mm:ss] text_roman with step 1's speaker letter and, for
   Hindi episodes, the English translation of each line as [T<translation id> | mm:ss]
   text right under it. The answer holds guest, topics, items (takeaways,
   opportunities with one of the 13 categories in schema.sql, quotes, disagreements,
   Raj's questions and Raj's opinions) and clips (first and last line ID). Every item
   gives the S IDs of the first and last line of the whole passage that supports it
   (at most MAX_SPAN_SECONDS long), and its source_segment_ids are every line in
   between; a disagreement may cite a second passage (Raj's side and the guest's
   side apart). The guest's bio is a list of facts, each with its own passage. Items
   are written only from what their passage says, with no added details. An item
   that rests only on T lines is marked translated. A part with no items at all, or
   no Raj questions while Raj speaks in many turns, is asked once more and the
   fuller answer kept.

Checks in code: start and end IDs (of each passage) must be S IDs from the request,
in order, and at most MAX_SPAN_SECONDS apart, otherwise the item (or guest fact) is dropped; quotes
must appear word for word in the cited S lines and be under 25 words, otherwise
check_notes says so; clips outside 30-90 seconds are dropped.

An episode over MAX_INPUT_TOKENS (counted with the token-counting endpoint) is
split into parts that overlap by OVERLAP_SEGMENTS lines. Each part owns the lines
up to the middle of each overlap, and items come from the part that owns their
first segment, so nothing is counted twice.

Results:
  data/extractions/speakers/v2/<video_id>.json      speaker letters per segment (chunk answers in chunks/)
  data/extractions/<model>/<VERSION>/<video_id>.json  merged extraction (part answers in parts/)
  guests, insights, clips   rows with verified = false, model and run_id; rerunning replaces only the
                            rows of the same run_id, so earlier runs stay for comparison
  segments.speaker          from step 1

Resumable: speaker answers, split plans, part answers, merged files, the run ID and
the batch IDs are saved as they are made, so a rerun only sends what is missing and
only writes what has not been written. Results refused for a rate limit are not
counted as attempts and are sent again after a pause (romanize_lib.run_batch).

Full run (Ticket 15), around the extraction logic above, which is unchanged:
- Only episodes with status transcribed are taken; an episode whose merged result is
  written is skipped.
- Episodes go in groups of GROUP_SIZE: speakers, extraction and database writes for
  one group finish before the next starts, so a stop never loses finished episodes.
- Cost guard: before each batch, this run's spend so far plus an estimate of the batch
  is compared with --max-usd; past it, the run writes what is finished and stops.
- stop_reason is saved for every attempt. A part whose answer is a refusal, cut off
  (max_tokens) or invalid JSON is sent once more (HARD_ATTEMPTS), and every such
  request is listed at the end.
- Console output goes to data/logs/extract_<timestamp>.log, and a line per group to
  data/progress_extract.log (episodes done, cost so far, estimated time left).
- When the run finishes, 07_check.py runs on it, and pass rates per item type are
  printed for the new episodes next to the test set's (saved before the run's
  checks in <model>/<VERSION>/testset_pass_rates.json), flagging any type more than
  PASS_RATE_DROP points lower.
- --dry-run prints the episodes to do and the estimated tokens, cost and time.

Usage:
    .venv\\Scripts\\python.exe pipeline\\06_extract.py --model haiku|sonnet --set test_set|all [--speakers-only]
                                     [--max-usd 25] [--dry-run]
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

import corrections_lib
import romanize_lib

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
CANDIDATES_CSV = DATA_DIR / "candidates.csv"
EXTRACT_DIR = DATA_DIR / "extractions"
# Speaker labels in groups of 10 (the first try, one string per chunk, is kept in speakers/).
SPEAKER_DIR = EXTRACT_DIR / "speakers" / "v2"
# Prompt version of the extraction step. Results of each version live in their own folder,
# so an earlier version's files are kept for comparison (v1 sits directly in <model>/).
# v2 used the first speaker labels (one string per chunk); v3 the grouped ones in speakers/v2.
# v4 cites each item as a start-to-end passage, gives the guest's bio as cited facts, and
# asks for clips that start and end on complete thoughts. v5 keeps v4's passages and writes
# each item only from what its passage says; a disagreement may cite two passages.
# LOCKED: v5 passed Gate 1 on 2026-10-23 and is the version for the full 500-episode run.
# The full run reuses v5's run ID (haiku/v5/run_id.txt), so the test episodes already done
# are skipped and every episode's rows share one run_id. Do not change the prompt, schema
# or merge rules without a new VERSION and a new Gate 1.
VERSION = "v5"

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
MAX_SPAN_SECONDS = 180  # longest passage an item or guest fact may cite
RAJ_TURNS_FOR_QUESTIONS = 5  # a part where Raj speaks in this many turns should have some of his questions

SPEAKER_CHUNK_LINES = 150
SPEAKER_GROUP_LINES = 10
SPEAKER_CONTEXT = (8, 4)  # unlabelled lines shown before and after a chunk
SPEAKER_ATTEMPTS = 3  # tries per group
SPEAKER_EFFORT = "low"
SPEAKER_MAX_TOKENS = 16000
SPEAKER_MAX_UNKNOWN = 0.5  # a group with more unknown lines than this is asked again while it has tries left
LETTERS = {"r": "raj", "g": "guest", "u": "unknown"}

DB_PAGE = 1000
DB_BATCH = 500
SPEAKER_UPDATE_IDS = 400
MAX_RETRIES = 5

# Full run (Ticket 15)
GROUP_SIZE = 50  # episodes per group; each group is written to the database before the next starts
MAX_RUN_USD = 25.0
LOGS_DIR = DATA_DIR / "logs"
PROGRESS_LOG = DATA_DIR / "progress_extract.log"
HARD_ERRORS = {"refusal": "stop_reason refusal", "max_tokens": "stop_reason max_tokens", "invalid JSON": "bad JSON"}
HARD_ATTEMPTS = 2  # a part answered with a refusal, a cut-off or invalid JSON is sent once more
PASS_RATE_DROP = 10  # points; a type whose pass rate on the new episodes is this much under the test set's is flagged
# Estimates for the cost guard and --dry-run, measured on the v5 test set (25 episodes):
# extraction 662,077 output tokens for 42 part answers, speakers 947,305 for 430 chunk answers.
EST_CHARS_PER_TOKEN = 3.0  # Roman-script lines and JSON run nearer 4; 3 keeps the estimate on the high side
EST_EXTRACTION_OUTPUT_TOKENS = 16000  # per part answer
EST_SPEAKER_OUTPUT_TOKENS = 2500  # per chunk answer
EST_HIGH = 1.3
BATCH_MINUTES = (3, 10)  # one Batch API round; the test set's rounds took 2.5-4 minutes
SPEAKER_ROUNDS, EXTRACTION_ROUNDS = 3, 2  # rounds a group usually needs
GROUP_OVERHEAD_MINUTES = (2, 6)  # loading 50 episodes' lines, counting tokens, writing rows

CATEGORIES = ["growing_sectors", "business_ideas", "market_gaps", "underrated_skills", "career_paths",
              "investment_themes", "hiring_signals", "policy_shifts", "geographic_opportunities",
              "tools_and_tech", "contrarian_takes", "resources", "warnings"]
QUESTION_TYPES = ["opening", "follow-up", "challenge", "personal", "deep-dive"]

SPEAKER_PROMPT = """You label who speaks each line of a transcript of the Figuring Out podcast. Raj Shamani is the host: he introduces the episode and the guest, asks the questions, reacts and pushes back. The guest answers, tells their story and explains. Sponsor reads and the intro are Raj.

For every line under "Lines to label", give one letter, in order:
r = Raj, g = the guest, u = unknown (only when you really cannot tell, for example a line split between both speakers).

The lines come in groups headed "--- Group S<id> ... ---", where <id> is the S ID of the group's first line. For every line of a group marked "label", give one letter, in order:
r = Raj, g = the guest, u = unknown (only when you really cannot tell, for example a line split between both speakers).

Lines are fragments of running speech: a speaker usually keeps talking for several lines, and a question from Raj is usually followed by the guest's answer. Use the context lines and the groups marked "context only" to follow the conversation, but do not label them.

Return "groups": one entry per group marked "label", with from_id (the S ID in its heading, as a number) and letters (exactly one letter per line of that group, for example "rrrrgggggg")."""

SYSTEM_PROMPT = f"""You read the transcript of one episode of the Figuring Out podcast and extract structured research notes from it. Raj Shamani is the host: he asks the questions. The guest answers them.

The transcript lines come in two kinds:
- [S<id> <speaker> | mm:ss] lines are the transcript itself, in Roman script (Hinglish for Hindi episodes). The speaker letter is R for Raj, G for the guest or U for unknown; the letters were added by a machine and can be wrong now and then.
- [T<id> | mm:ss] lines are machine English translations of the S line just above them. They are only there to help you understand Hindi; they are not the source.

Ground rules:
1. Only use what is said in the transcript. If you are unsure about something, leave it out. Never invent names, numbers, facts, organisations, questions or opinions, and never fill gaps from your own knowledge.
2. Every item gives start_id and end_id: the S IDs (numbers only, without the "S") of the first and last line of the whole passage that supports it. Someone who reads only the lines from start_id to end_id must be able to check the item: include the question that leads into an answer, the complete explanation and, for an exchange, both sides. Do not cut a passage off mid-sentence. A passage is at most {MAX_SPAN_SECONDS // 60} minutes long (check the timestamps); if the support is spread wider than that, leave the item out.
3. Write every item using only what is said in its cited lines. Do not add numbers, years, amounts, names, durations or causes that are not in those lines; if a detail is not there, leave it out. Prefer the speaker's own phrasing over your interpretation. The same goes for each fact in the guest profile.
4. If an item rests only on what the T lines say, because you could not confirm it from the S lines, also list those T IDs and set translated to true. Otherwise translated is false and translation_line_ids may be empty.
5. Write takeaways, opportunities, disagreements, opinions, questions and topics in the third person in English ("Raj argues...", "The guest says..."). Never write as Raj in the first person.
6. Never include phone numbers, email addresses or other contact details.
7. second_start_id and second_end_id are only for disagreements (see below); set both to 0 for every other item.

What to return. Takeaways, opportunities, quotes, disagreements, Raj's questions and Raj's opinions all go in the one "items" list, each with its kind; category is "none" except for opportunities, and question_type is "none" except for Raj's questions.
- guest: the main guest's name, organisation, role at the time of the episode and sector tags, and facts: a short list of facts about the guest (3-6), each one sentence with its own start_id and end_id. Only facts actually said in the episode, and the name, organisation and role must each be backed by one of the facts. Use empty strings and lists for anything not said.
- topics: short tags for what the episode covers.
- takeaway: the key takeaways (the request says how many); the passage holds the full explanation.
- opportunity: every concrete opportunity mentioned (a sector, business idea, market gap, skill, career path, investment theme, hiring signal, policy shift, place, tool, contrarian take, resource or warning), each with one category: {", ".join(CATEGORIES)}. The passage holds the full explanation.
- quote: short, striking quotes (the request says how many), under {QUOTE_MAX_WORDS} words each, copied exactly as written in the cited S lines: same words, same spelling, same fillers and repetitions, never from T lines and never translated, corrected or tidied. Its passage is just the line or lines that hold it.
- disagreement: every real disagreement between Raj and the guest, saying what each one holds. It must cite both Raj's side and the guest's side in their own words: either one passage holding both, or two separate passages, start_id/end_id for Raj's side and second_start_id/second_end_id for the guest's side, each at most {MAX_SPAN_SECONDS // 60} minutes long. If both sides cannot be cited, leave the disagreement out.
- raj_question: every distinct question Raj asks the guest, written in English as the full question, each with a type: {", ".join(QUESTION_TYPES)}. The passage starts where Raj starts asking and holds the whole question, not only a closing phrase like "what do you think". A long episode usually has dozens.
- raj_opinion: every opinion Raj states himself (not his questions, not the guest's views); the passage holds his full statement.
- clips: stretches of {CLIP_SECONDS[0]}-{CLIP_SECONDS[1]} seconds that make sense on their own (the request says how many), each as the S ID of its first and last line, with a short topic and a score from 0 to 1 for how strong a standalone clip it is. Start at the beginning of a sentence or of Raj's question, never mid-sentence or with a reference to something said before, and end where a complete thought ends (the answer finished), so a viewer who sees only the clip follows it. Check the timestamps: the last line should start {CLIP_SECONDS[0]}-{CLIP_SECONDS[1]} seconds after the first.

A list is empty only if the episode truly has nothing of that kind."""


def _ids() -> dict:
    return {"type": "array", "items": {"type": "integer"}}


def _passage(**props) -> dict:
    """An object citing a passage by its first and last S ID."""
    props |= {"start_id": {"type": "integer"}, "end_id": {"type": "integer"}}
    return {"type": "object", "properties": props, "required": list(props), "additionalProperties": False}


KINDS = {"takeaways": "takeaway", "opportunities": "opportunity", "quotes": "quote",
         "disagreements": "disagreement", "raj_questions": "raj_question", "raj_opinions": "raj_opinion"}

SPEAKER_SCHEMA = {
    "type": "object",
    "properties": {"groups": {"type": "array", "items": {
        "type": "object",
        "properties": {"from_id": {"type": "integer"}, "letters": {"type": "string"}},
        "required": ["from_id", "letters"], "additionalProperties": False}}},
    "required": ["groups"],
    "additionalProperties": False,
}

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
                           "facts": {"type": "array", "items": _passage(text={"type": "string"})},
                           "translation_line_ids": _ids(), "translated": {"type": "boolean"}},
            "required": ["name", "organisation", "role_at_episode", "sector_tags", "facts",
                         "translation_line_ids", "translated"],
            "additionalProperties": False},
        "topics": {"type": "array", "items": {
            "type": "object",
            "properties": {"tag": {"type": "string"}, "source_segment_ids": _ids(), "translation_line_ids": _ids(),
                           "translated": {"type": "boolean"}},
            "required": ["tag", "source_segment_ids", "translation_line_ids", "translated"],
            "additionalProperties": False}},
        "items": {"type": "array", "items": _passage(
            kind={"type": "string", "enum": list(KINDS.values())}, text={"type": "string"},
            category={"type": "string", "enum": [*CATEGORIES, "none"]},
            question_type={"type": "string", "enum": [*QUESTION_TYPES, "none"]},
            second_start_id={"type": "integer"}, second_end_id={"type": "integer"},
            translation_line_ids=_ids(), translated={"type": "boolean"})},
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
        record["earlier_stop_reasons"] = [*old.get("earlier_stop_reasons", []), old.get("stop_reason")]
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


def speaker_groups(lines: list[dict], lo: int, hi: int) -> dict[int, list[dict]]:
    """The chunk's lines in groups of SPEAKER_GROUP_LINES, keyed by the S ID of each group's first line."""
    return {lines[i]["id"]: lines[i:min(hi, i + SPEAKER_GROUP_LINES)] for i in range(lo, hi, SPEAKER_GROUP_LINES)}


def speaker_request(custom_id: str, ep: dict, lines: list[dict], lo: int, hi: int, wanted: list[int]) -> Request:
    """Ask for the letters of the wanted groups; the chunk's other groups are shown as context."""
    fmt = lambda ls: "\n".join(f"[S{l['id']} | {clock(l['start'])}] {l['text']}" for l in ls)
    before, after = lines[max(0, lo - SPEAKER_CONTEXT[0]):lo], lines[hi:hi + SPEAKER_CONTEXT[1]]
    prompt = (f"Episode title: {ep['title']}\nGuest (from the title, a hint only): "
              f"{romanize_lib.guess_guest(ep['title'])}\n\n")
    if before:
        prompt += f"Context before (do not label):\n{fmt(before)}\n\n"
    for first, group in speaker_groups(lines, lo, hi).items():
        label = f"label, {len(group)} lines" if first in wanted else "context only, do not label"
        prompt += f"--- Group S{first} ({label}) ---\n{fmt(group)}\n"
    if after:
        prompt += f"\nContext after (do not label):\n{fmt(after)}\n"
    prompt += (f"\nReturn {len(wanted)} groups, one for each group marked \"label\": from_id is the S ID in the "
               f"group's heading and letters has exactly one letter per line of that group.")
    return Request(custom_id=custom_id, params=MessageCreateParamsNonStreaming(
        model=MODELS[SPEAKER_MODEL], max_tokens=SPEAKER_MAX_TOKENS, system=SPEAKER_PROMPT,
        output_config={"effort": SPEAKER_EFFORT, "format": {"type": "json_schema", "schema": SPEAKER_SCHEMA}},
        messages=[{"role": "user", "content": prompt}]))


def weak(letters: str) -> bool:
    return letters.count("u") > SPEAKER_MAX_UNKNOWN * len(letters)


def save_speakers(path: Path, custom_id: str, info: dict, result) -> None:
    """Check each requested group on its own: keep the good ones, leave the rest for the next round.

    info has sizes ({first S ID: lines in the group}) and wanted (the groups asked for). A group
    whose letters are mostly u is asked again while it has tries left, and its best answer kept.
    A group that never gets a usable answer in SPEAKER_ATTEMPTS tries is left unknown.
    """
    old = read_json(path) if path.exists() else None
    record = {"custom_id": custom_id, "result_type": result.type, "complete": False,
              "usage": {"input_tokens": 0, "output_tokens": 0}, "error": "",
              "done": dict(old["done"]) if old else {}, "failed": list(old["failed"]) if old else [],
              "tries": dict(old["tries"]) if old else {}, "weak": dict(old["weak"]) if old else {}}
    answers: dict[str, str] = {}
    if result.type == "succeeded":
        answer = answer_from(result.message, record)
        if answer is not None:
            for g in answer.get("groups", []):
                key = str(g.get("from_id"))
                letters = re.sub(r"\s", "", str(g.get("letters", ""))).lower()
                answers.setdefault(key, letters)  # a group answered twice: the first answer counts
    else:
        record["error"] = str(getattr(result, "error", "") or result.type)[:500]
    problems = []
    for first in info["wanted"]:
        key, size = str(first), info["sizes"][str(first)]
        record["tries"][key] = record["tries"].get(key, 0) + 1
        letters = answers.get(key)
        if letters is None:
            problems.append(f"S{key} missing")
        elif len(letters) != size:
            problems.append(f"S{key} {len(letters)} letters for {size} lines")
        elif set(letters) - set(LETTERS):
            problems.append(f"S{key} unexpected letters {''.join(sorted(set(letters) - set(LETTERS)))}")
        else:
            best = min([letters, *([record["weak"][key]] if key in record["weak"] else [])], key=lambda l: l.count("u"))
            if weak(best) and record["tries"][key] < SPEAKER_ATTEMPTS:
                record["weak"][key] = best
                problems.append(f"S{key} mostly unknown")
            else:
                record["done"][key] = best
                record["weak"].pop(key, None)
                continue
        if record["tries"][key] >= SPEAKER_ATTEMPTS:
            if key in record["weak"]:
                record["done"][key] = record["weak"].pop(key)
            else:
                record["failed"].append(key)
    if problems and not record["error"]:
        record["error"] = "; ".join(problems[:6]) + (f" (+{len(problems) - 6} more)" if len(problems) > 6 else "")
    record["complete"] = all(k in record["done"] or k in record["failed"] for k in info["sizes"])
    if record["complete"] and record["failed"]:
        record["note"] = f"groups left unknown: {', '.join('S' + k for k in record['failed'])}"
    save_record(path, record, old)


def speaker_step(client, db, episodes: list[dict], lines_of: dict, guard=None) -> dict[str, dict]:
    """Speaker letters for each episode, {video_id: {segment id: raj|guest|unknown}}, also written to segments.

    guard(requests), if given, is called before each batch and may raise to stop (the cost guard).
    """
    chunk_dir, job_path = SPEAKER_DIR / "chunks", SPEAKER_DIR / "batch_job.json"
    chunk_dir.mkdir(parents=True, exist_ok=True)
    todo = [ep for ep in episodes if ep["video_id"] in lines_of and not speaker_path(ep["video_id"]).exists()]
    for round_no in range(1, MAX_ROUNDS + 1):
        requests, info = {}, {}
        for ep in todo:
            vid, lines = ep["video_id"], lines_of[ep["video_id"]]
            for n, (lo, hi) in enumerate(speaker_chunks(lines)):
                cid, path = f"{vid}-c{n:03d}", chunk_dir / f"{vid}-c{n:03d}.json"
                if romanize_lib.chunk_done(path):
                    continue
                record = read_json(path) if path.exists() else {"done": {}, "failed": []}
                sizes = {str(k): len(g) for k, g in speaker_groups(lines, lo, hi).items()}
                wanted = [int(k) for k in sizes if k not in record["done"] and k not in record["failed"]]
                requests[cid] = speaker_request(cid, ep, lines, lo, hi, wanted)
                info[cid] = {"sizes": sizes, "wanted": wanted}
        if not requests:
            break
        if guard:
            guard(requests)
        log.info("Speaker round %s: %s chunks, %s groups", round_no, len(requests),
                 sum(len(i["wanted"]) for i in info.values()))
        romanize_lib.wait_after_rate_limit(romanize_lib.run_batch(client, requests, info, job_path, chunk_dir,
                                                                  save=save_speakers))
    for ep in todo:
        vid, lines = ep["video_id"], lines_of[ep["video_id"]]
        paths = [chunk_dir / f"{vid}-c{n:03d}.json" for n in range(len(speaker_chunks(lines)))]
        if not all(romanize_lib.chunk_done(p) for p in paths):
            log.error("%s: speaker chunks unfinished after %s rounds; rerun to continue", vid, MAX_ROUNDS)
            continue
        letters, failed = {}, []
        for path, (lo, hi) in zip(paths, speaker_chunks(lines)):
            record = read_json(path)
            failed += [f"{path.stem}/S{k}" for k in record["failed"]]
            for first, group in speaker_groups(lines, lo, hi).items():
                for l, c in zip(group, record["done"].get(str(first), "u" * len(group))):
                    letters[str(l["id"])] = LETTERS[c]
        usage = add_usage(paths)
        write_json(speaker_path(vid), {
            "video_id": vid, "model": MODELS[SPEAKER_MODEL], "effort": SPEAKER_EFFORT, "chunks": len(paths),
            "failed_groups": failed, "usage": usage, "cost_usd": round(cost(SPEAKER_MODEL, usage), 6),
            "db_written": False, "speakers": letters})

    # Write labels to segments (also any left unwritten by an earlier run).
    result = {}
    for ep in episodes:
        path = speaker_path(ep["video_id"])
        if not path.exists():
            continue
        record = read_json(path)
        if not record["db_written"]:
            write_speakers(db, ep["video_id"], record["speakers"])
            record["db_written"] = True
            write_json(path, record)
            log.info("%s: speakers written for %s segments", ep["video_id"], len(record["speakers"]))
        result[ep["video_id"]] = record["speakers"]
    return result


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

def passage_ids(item: dict, lines: list[dict], order: dict[int, int], s_ids: set[int], stats: dict) -> dict | None:
    """The item with source_segment_ids set to every line of its passage(s), or None if a passage is bad.

    The first passage is start_id-end_id; a disagreement may add second_start_id-second_end_id (0 for none).
    """
    passages = [(item["start_id"], item["end_id"])]
    if item.get("kind", "").lower() == "disagreement" and (item.get("second_start_id") or item.get("second_end_id")):
        passages.append((item["second_start_id"], item["second_end_id"]))
    ids = set()
    for a, b in passages:
        if a not in s_ids or b not in s_ids or order[a] > order[b]:
            stats["bad_passages_dropped"] += 1
            return None
        if lines[order[b]]["end"] - lines[order[a]]["start"] > MAX_SPAN_SECONDS:
            stats["long_passages_dropped"] += 1
            return None
        ids.update(lines[i]["id"] for i in range(order[a], order[b] + 1))
    if len(passages) > 1:
        stats["disagreements_two_passages"] += 1
    out = {k: v for k, v in item.items() if k not in ("start_id", "end_id", "second_start_id", "second_end_id")}
    out["source_segment_ids"] = sorted(ids, key=order.get)
    return out


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
    stats = {"bad_passages_dropped": 0, "long_passages_dropped": 0, "guest_facts_dropped": 0,
             "disagreements_two_passages": 0,
             "unknown_ids_removed": 0, "dropped_no_ids": 0, "quotes_not_verbatim": 0, "quotes_too_long": 0,
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
                item = passage_ids(item, lines, order, span_ids, stats)
                item = item and clean_ids(item, span_ids, t_ids, stats)
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
        if answer["guest"]["name"].strip():
            guest = dict(answer["guest"])
            facts = [passage_ids(f, lines, order, span_ids, stats) for f in guest["facts"]]
            stats["guest_facts_dropped"] += sum(f is None for f in facts)
            guest["facts"] = [f for f in facts if f and f["text"].strip()]
            guest["source_segment_ids"] = sorted({i for f in guest["facts"] for i in f["source_segment_ids"]})
            guest = clean_ids(guest, span_ids, t_ids, stats)
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
            for field in ("organisation", "role_at_episode"):
                guest[field] = guest[field] or other[field]
            known = {normalise(f["text"]) for f in guest["facts"]}
            guest["facts"] = guest["facts"] + [f for f in other["facts"] if normalise(f["text"]) not in known]
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
    corr = corrections_lib.load()  # pipeline/corrections.json: facts the captions got wrong, fixed before rows are written
    guest_id = None
    g = result["guest"]
    if g:
        row = {"name": g["name"], "organisation": g["organisation"] or None,
               "role_at_episode": g["role_at_episode"] or None, "sector_tags": g["sector_tags"],
               "bio": "\n".join(f["text"] for f in g["facts"]) or None, "video_id": vid, "model": model, "run_id": run_id}
        row.update(corr.fix_fields(row, ("organisation", "role_at_episode", "bio")))
        guest_id = db_call("guests insert", lambda: db.table("guests").insert(row).execute()).data[0]["id"]
    rows = []
    for name, type_ in KINDS.items():
        for item in result[name]:
            start, end = span(item["source_segment_ids"], by_id)
            notes = [item.get("check_notes", "")]
            if name == "raj_questions":
                notes.insert(0, f"question_type: {item['question_type']}")
            rows.append({"video_id": vid, "guest_id": guest_id, "type": type_,
                         "category": item.get("category"), "text": corr.fix_text(item["text"], vid, field="text"), "start_s": start, "end_s": end,
                         "source_segment_ids": item["source_segment_ids"], "translated": bool(item["translated"]),
                         "verified": False, "check_notes": "; ".join(n for n in notes if n) or None,
                         "model": model, "run_id": run_id})
    for i in range(0, len(rows), DB_BATCH):
        chunk = rows[i:i + DB_BATCH]
        db_call("insights insert", lambda: db.table("insights").insert(chunk).execute())
    clips = [{"video_id": vid, "start_s": c["start_s"], "end_s": c["end_s"], "opening_line": corr.fix_text(c["opening_line"], vid, field="opening_line"),
              "topic": corr.fix_text(c["topic"], vid, field="topic"), "score": c["score"], "verified": False, "model": model, "run_id": run_id}
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


# ---------- full run: groups, cost guard, progress ----------

class CostCapReached(Exception):
    pass


def request_files(key: str, vid: str) -> list[Path]:
    """Every saved request answer of one episode: speaker chunks and extraction parts."""
    return [*(SPEAKER_DIR / "chunks").glob(f"{vid}-c*.json"), *part_dir(key).glob(f"{vid}-p*.json")]


def files_usd(key: str, vids: list[str]) -> float:
    return sum(cost(SPEAKER_MODEL, add_usage((SPEAKER_DIR / "chunks").glob(f"{v}-c*.json")))
               + cost(key, add_usage(part_dir(key).glob(f"{v}-p*.json"))) for v in vids)


def estimate_usd(model_key: str, requests: dict, output_tokens: int) -> float:
    """Cost of a batch before it is sent: input from the request's length, output a measured average."""
    chars = sum(len(r["params"]["system"]) + len(r["params"]["messages"][0]["content"]) for r in requests.values())
    return cost(model_key, {"input_tokens": chars / EST_CHARS_PER_TOKEN, "output_tokens": output_tokens * len(requests)})


class RunCost:
    """What this run has spent (usage saved in the request files of the episodes it works on), with a cap."""

    def __init__(self, key: str, max_usd: float):
        self.key, self.max_usd, self.done_usd, self.vids, self.base = key, max_usd, 0.0, [], 0.0

    def start_group(self, vids: list[str]) -> None:
        self.vids, self.base = vids, files_usd(self.key, vids)

    def end_group(self) -> None:
        self.done_usd += files_usd(self.key, self.vids) - self.base
        self.vids, self.base = [], 0.0

    def spent(self) -> float:
        return self.done_usd + (files_usd(self.key, self.vids) - self.base if self.vids else 0.0)

    def check(self, model_key: str, requests: dict, output_tokens: int) -> None:
        so_far, next_batch = self.spent(), estimate_usd(model_key, requests, output_tokens)
        log.info("Cost this run $%.2f; next batch of %s requests about $%.2f (cap $%.2f)", so_far, len(requests),
                 next_batch, self.max_usd)
        if so_far + next_batch > self.max_usd:
            raise CostCapReached(f"this run has spent ${so_far:.2f}; the next batch (about ${next_batch:.2f}) "
                                 f"could take it past ${self.max_usd:.2f}")


class Progress:
    """One line per event in PROGRESS_LOG: episodes done, cost so far, estimated time left."""

    def __init__(self, key: str, episodes: list[dict], run_cost: RunCost, groups: int):
        self.key, self.episodes, self.run_cost, self.groups = key, episodes, run_cost, groups
        self.started, self.groups_done = time.monotonic(), 0

    def write(self, event: str) -> None:
        done = sum(episode_done(self.key, ep["video_id"]) for ep in self.episodes)
        left = self.groups - self.groups_done
        if self.groups_done:
            hours = (time.monotonic() - self.started) / self.groups_done * left / 3600
        else:
            hours = left * group_minutes()[1] / 60
        line = (f"{time.strftime('%Y-%m-%d %H:%M:%S')} {event} | done {done}/{len(self.episodes)} episodes, "
                f"remaining {len(self.episodes) - done} | cost this run ${self.run_cost.spent():.2f} "
                f"(cap ${self.run_cost.max_usd:.2f}) | est. left {hours:.1f} h")
        PROGRESS_LOG.parent.mkdir(parents=True, exist_ok=True)
        with PROGRESS_LOG.open("a", encoding="utf-8") as f:
            f.write(line + "\n")
        log.info("progress: %s", line)


def group_minutes() -> tuple[float, float]:
    """Minutes per group of GROUP_SIZE episodes: its Batch API rounds plus loading lines and counting tokens."""
    rounds = SPEAKER_ROUNDS + EXTRACTION_ROUNDS
    return rounds * BATCH_MINUTES[0] + GROUP_OVERHEAD_MINUTES[0], rounds * BATCH_MINUTES[1] + GROUP_OVERHEAD_MINUTES[1]


def episode_done(key: str, vid: str) -> bool:
    return merged_path(key, vid).exists() and read_json(merged_path(key, vid))["db_written"]


def transcribed(db, episodes: list[dict]) -> list[dict]:
    """The episodes whose transcript is in the database (status transcribed), with their caption language."""
    rows, start = [], 0
    while True:
        page = db_call("episodes select", lambda: db.table("episodes").select("video_id,status,caption_language")
                       .order("video_id").range(start, start + DB_PAGE - 1).execute()).data
        rows += page
        if len(page) < DB_PAGE:
            break
        start += DB_PAGE
    meta = {r["video_id"]: r for r in rows}
    left_out = [ep["video_id"] for ep in episodes if meta.get(ep["video_id"], {}).get("status") != "transcribed"]
    if left_out:
        log.info("%s episodes are not transcribed, left out: %s", len(left_out), ", ".join(left_out))
    return [ep | {"language": meta[ep["video_id"]]["caption_language"]} for ep in episodes
            if ep["video_id"] not in left_out]


def hard_failures(path: Path) -> list[str]:
    """The refusal, cut-off (max_tokens) and invalid-JSON answers among a request's attempts."""
    if not path.exists():
        return []
    record = read_json(path)
    return [kind for error in [*record.get("earlier_errors", []), record.get("error", "")]
            for kind, prefix in HARD_ERRORS.items() if error.startswith(prefix)]


def run_group(client, db, key: str, run_id: str, group: list[dict], speakers_only: bool, run_cost: RunCost) -> None:
    """Speakers, extraction and database writes for one group of episodes.

    The cost guard is checked before each batch. When it stops the run, the group's episodes
    that are already complete are still merged and written before the stop is passed on.
    """
    model = MODELS[key]
    job_path = model_dir(key) / "batch_job.json"
    lines_of, skipped = {}, []
    for ep in group:
        lines = episode_lines(db, ep)
        if lines:
            lines_of[ep["video_id"]] = lines
        else:
            skipped.append(ep["video_id"])
    if skipped:
        log.info("%s episodes have no transcript in the database yet, skipped: %s", len(skipped), ", ".join(skipped))

    speakers = speaker_step(client, db, group, lines_of,
                            guard=lambda reqs: run_cost.check(SPEAKER_MODEL, reqs, EST_SPEAKER_OUTPUT_TOKENS))
    if speakers_only:
        return
    todo, plans = [], {}
    for ep in group:
        vid = ep["video_id"]
        if vid in lines_of and vid in speakers and not merged_path(key, vid).exists():
            plans[vid] = make_plan(client, key, ep, lines_of[vid], speakers[vid])
            todo.append(ep)

    def part_ids(ep):
        return [f"{ep['video_id']}-p{i + 1}" for i in range(len(plans[ep["video_id"]]["parts"]))]

    stop = None
    try:
        for round_no in range(1, MAX_ROUNDS + 1):
            requests, info = {}, {}
            for ep in todo:
                vid, plan = ep["video_id"], plans[ep["video_id"]]
                for i, cid in enumerate(part_ids(ep)):
                    path = part_dir(key) / f"{cid}.json"
                    if (romanize_lib.chunk_done(path) or romanize_lib.attempts(path) >= MAX_ATTEMPTS
                            or len(hard_failures(path)) >= HARD_ATTEMPTS):
                        continue
                    lo, hi = plan["parts"][i]["span"]
                    part_lines = lines_of[vid][lo:hi]
                    requests[cid] = build_request(cid, model, user_prompt(ep, part_lines, speakers[vid], i + 1,
                                                                           len(plan["parts"])))
                    info[cid] = {"raj_turns": raj_turns(part_lines, speakers[vid])}
            if not requests:
                break
            run_cost.check(key, requests, EST_EXTRACTION_OUTPUT_TOKENS)
            log.info("Extraction round %s: %s requests", round_no, len(requests))
            romanize_lib.wait_after_rate_limit(romanize_lib.run_batch(client, requests, info, job_path,
                                                                      part_dir(key), save=save_part))
    except CostCapReached as exc:
        stop = exc

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
    for ep in group:
        vid, path = ep["video_id"], merged_path(key, ep["video_id"])
        if not path.exists():
            continue
        result = read_json(path)
        if result["db_written"]:
            continue
        lines = lines_of.get(vid) or episode_lines(db, ep)
        result["db_rows"] = write_rows(db, key, ep, lines, result)
        result["db_written"] = True
        write_json(path, result)
        log.info("%s: wrote %s", vid, result["db_rows"])
    if stop:
        raise stop


def run(key: str, which: str, speakers_only: bool = False, max_usd: float = MAX_RUN_USD,
        dry_run: bool = False) -> None:
    db = captions.supabase_client()
    episodes = transcribed(db, read_episodes(which))
    todo = [ep for ep in episodes if not episode_done(key, ep["video_id"])]
    if dry_run:
        print_dry_run(key, episodes, todo, max_usd)
        return
    run_id = run_id_for(key)
    part_dir(key).mkdir(parents=True, exist_ok=True)
    log.info("%s transcribed episodes in set %s, %s to do, model %s, run %s, groups of %s, cost cap $%.2f",
             len(episodes), which, len(todo), MODELS[key], run_id, GROUP_SIZE, max_usd)
    if not speakers_only:
        save_baseline(db, key, run_id)
    client = anthropic.Anthropic(max_retries=MAX_RETRIES)
    groups = [todo[i:i + GROUP_SIZE] for i in range(0, len(todo), GROUP_SIZE)]
    run_cost = RunCost(key, max_usd)
    progress = Progress(key, episodes, run_cost, len(groups))
    progress.write(f"run started: {len(todo)} episodes to do in {len(groups)} groups")
    stopped = None
    for n, group in enumerate(groups, 1):
        log.info("=== Group %s of %s: %s episodes ===", n, len(groups), len(group))
        run_cost.start_group([ep["video_id"] for ep in group])
        try:
            run_group(client, db, key, run_id, group, speakers_only, run_cost)
        except CostCapReached as exc:
            stopped = str(exc)
        finally:
            run_cost.end_group()
        progress.groups_done += 1
        progress.write(f"group {n}/{len(groups)} " + ("stopped by the cost guard" if stopped else "finished"))
        if stopped:
            break

    if speakers_only:
        print_speaker_summary(episodes)
    else:
        print_summary(key, episodes, run_id)
    print_failures(key, episodes)
    print(f"\nCost this run: ${run_cost.spent():.2f} (cap ${max_usd:.2f})")
    if stopped:
        print(f"Stopped by the cost guard: {stopped}. Finished episodes are written; rerun "
              f"(with a higher --max-usd if needed) to continue.")
        progress.write("run stopped by the cost guard")
        return
    progress.write("run finished")
    if speakers_only:
        return
    left = [ep["video_id"] for ep in episodes if not episode_done(key, ep["video_id"])]
    if left:
        print(f"\n{len(left)} episodes are not finished ({', '.join(left[:10])}{' ...' if len(left) > 10 else ''}); "
              "the checks run on what is written.")
    check_and_compare(db, key, run_id)


def print_failures(key: str, episodes: list[dict]) -> None:
    """Every request whose answer was a refusal, cut off (max_tokens) or invalid JSON, and how it ended."""
    print("\n=== Refusals, cut-offs and invalid JSON (stop_reason is saved for every request) ===")
    found = 0
    for ep in episodes:
        for path in sorted(request_files(key, ep["video_id"])):
            kinds = hard_failures(path)
            if not kinds:
                continue
            found += 1
            if romanize_lib.chunk_done(path):
                status = "complete after the retry"
            elif len(kinds) >= HARD_ATTEMPTS:
                status = "failed again after one retry; left out"
            else:
                status = "not retried yet; a rerun retries it"
            print(f"    {ep['video_id']} {path.stem}: {', '.join(kinds)}; {status}")
    if not found:
        print("    none")


def print_dry_run(key: str, episodes: list[dict], todo: list[dict], max_usd: float) -> None:
    """Episodes to do, and tokens, cost and time estimated from the episodes already done (per minute of audio)."""
    minutes = {ep["video_id"]: float(ep["duration_seconds"] or 0) / 60 for ep in episodes}
    rates: dict[str, dict] = {}
    for ep in episodes:
        vid = ep["video_id"]
        if not episode_done(key, vid) or not speaker_path(vid).exists():
            continue
        merged, spk = read_json(merged_path(key, vid)), read_json(speaker_path(vid))
        for lang in (ep["language"], "all"):
            r = rates.setdefault(lang, {"minutes": 0.0, "episodes": 0, "ex_in": 0, "ex_out": 0, "sp_in": 0, "sp_out": 0})
            r["minutes"] += minutes[vid]
            r["episodes"] += 1
            r["ex_in"] += merged["usage"]["input_tokens"]
            r["ex_out"] += merged["usage"]["output_tokens"]
            r["sp_in"] += spk["usage"]["input_tokens"]
            r["sp_out"] += spk["usage"]["output_tokens"]
    by_lang = {}
    for ep in todo:
        r = rates.get(ep["language"]) or rates["all"]
        t = by_lang.setdefault(ep["language"], {"episodes": 0, "minutes": 0.0, "ex_in": 0.0, "ex_out": 0.0,
                                                "sp_in": 0.0, "sp_out": 0.0})
        t["episodes"] += 1
        t["minutes"] += minutes[ep["video_id"]]
        for k in ("ex_in", "ex_out", "sp_in", "sp_out"):
            t[k] += r[k] / r["minutes"] * minutes[ep["video_id"]]
    groups = math.ceil(len(todo) / GROUP_SIZE)
    run_file = model_dir(key) / "run_id.txt"
    run_id = run_file.read_text(encoding="utf-8").strip() if run_file.exists() else "(new)"
    print(f"DRY RUN, {MODELS[key]}, prompt {VERSION}, run {run_id}: nothing is sent or written.")
    print(f"Transcribed episodes in set: {len(episodes)}")
    print(f"Already extracted with {VERSION}: {len(episodes) - len(todo)}")
    print(f"To do:                       {len(todo)} in {groups} groups of up to {GROUP_SIZE}")
    started = [ep["video_id"] for ep in todo if plan_path(key, ep["video_id"]).exists()
               or speaker_path(ep["video_id"]).exists()]
    if started:
        print(f"    already started (speakers or plan saved): {len(started)}")
    print(f"\nRates measured on the {rates.get('all', {}).get('episodes', 0)} episodes already done "
          f"(tokens per minute of audio, all attempts):")
    for lang, r in sorted(rates.items()):
        print(f"    {lang:<4} {r['episodes']:>3} episodes, {r['minutes']:6.0f} min: speakers "
              f"{r['sp_in'] / r['minutes']:,.0f} in / {r['sp_out'] / r['minutes']:,.0f} out, extraction "
              f"{r['ex_in'] / r['minutes']:,.0f} in / {r['ex_out'] / r['minutes']:,.0f} out")
    print(f"\n  {'language':<9} {'episodes':>8} {'hours':>6} {'speakers in':>12} {'out':>11} "
          f"{'extract in':>12} {'out':>11} {'USD':>7}")
    total = {"ex_in": 0.0, "ex_out": 0.0, "sp_in": 0.0, "sp_out": 0.0}
    for lang, t in sorted(by_lang.items()):
        usd = (cost(SPEAKER_MODEL, {"input_tokens": t["sp_in"], "output_tokens": t["sp_out"]})
               + cost(key, {"input_tokens": t["ex_in"], "output_tokens": t["ex_out"]}))
        for k in total:
            total[k] += t[k]
        print(f"  {lang:<9} {t['episodes']:>8} {t['minutes'] / 60:>6.0f} {t['sp_in']:>12,.0f} {t['sp_out']:>11,.0f} "
              f"{t['ex_in']:>12,.0f} {t['ex_out']:>11,.0f} {usd:>7.2f}")
    usd = (cost(SPEAKER_MODEL, {"input_tokens": total["sp_in"], "output_tokens": total["sp_out"]})
           + cost(key, {"input_tokens": total["ex_in"], "output_tokens": total["ex_out"]}))
    print(f"  {'total':<9} {len(todo):>8} {sum(t['minutes'] for t in by_lang.values()) / 60:>6.0f} "
          f"{total['sp_in']:>12,.0f} {total['sp_out']:>11,.0f} {total['ex_in']:>12,.0f} {total['ex_out']:>11,.0f} "
          f"{usd:>7.2f}")
    print(f"\nEstimated cost: ${usd:.2f} likely, ${usd * EST_HIGH:.2f} high (+{EST_HIGH - 1:.0%} for more retries); "
          f"cost guard ${max_usd:.2f}")
    lo, hi = group_minutes()
    print(f"Estimated time: {groups} groups x {lo:.0f}-{hi:.0f} min = {groups * lo / 60:.1f}-{groups * hi / 60:.1f} h "
          f"({SPEAKER_ROUNDS} speaker and {EXTRACTION_ROUNDS} extraction Batch API rounds a group at "
          f"{BATCH_MINUTES[0]}-{BATCH_MINUTES[1]} min each, plus {GROUP_OVERHEAD_MINUTES[0]}-"
          f"{GROUP_OVERHEAD_MINUTES[1]} min loading lines and counting tokens)")
    print("Afterwards: 07_check.py on the run, and pass rates per type compared with the test set.")


# ---------- checks after the run ----------

TYPES = ["takeaway", "opportunity", "quote", "disagreement", "raj_question", "raj_opinion", "clip", "guest"]


def pass_rates(db, run_id: str) -> dict[str, dict[str, list[int]]]:
    """{"test": {type: [passed, total]}, "new": {...}}: verified rows of the run, test-set episodes apart."""
    test = {ep["video_id"] for ep in read_episodes("test_set")}
    out = {"test": {}, "new": {}}
    for table, columns in (("insights", "video_id,type,verified"), ("clips", "video_id,verified"),
                           ("guests", "video_id,verified")):
        start = 0
        while True:
            page = db_call(f"{table} select", lambda: db.table(table).select(columns).eq("run_id", run_id)
                           .order("id").range(start, start + DB_PAGE - 1).execute()).data
            for row in page:
                kind = row.get("type") or table.rstrip("s")
                counts = out["test" if row["video_id"] in test else "new"].setdefault(kind, [0, 0])
                counts[0] += bool(row["verified"])
                counts[1] += 1
            if len(page) < DB_PAGE:
                break
            start += DB_PAGE
    return out


def save_baseline(db, key: str, run_id: str) -> None:
    """The test set's pass rates as they stand before this run's checks, saved once."""
    path = model_dir(key) / "testset_pass_rates.json"
    if not path.exists():
        write_json(path, {"run_id": run_id, "saved_at": time.strftime("%Y-%m-%d %H:%M:%S"),
                          "rates": pass_rates(db, run_id)["test"]})


def check_and_compare(db, key: str, run_id: str) -> None:
    """Run 07_check.py on the run, then print pass rates per type: test set (before and now) and new episodes."""
    log.info("Running 07_check.py on %s", run_id)
    spec = importlib.util.spec_from_file_location("check", Path(__file__).with_name("07_check.py"))
    checker = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(checker)
    checker.run(run_id)
    baseline = read_json(model_dir(key) / "testset_pass_rates.json")["rates"]
    now = pass_rates(db, run_id)
    pct = lambda c: 100 * c[0] / c[1] if c and c[1] else None
    fmt = lambda c: f"{c[0]}/{c[1]} {pct(c):5.1f}%" if c and c[1] else "-"
    print(f"\n=== Pass rates per type, run {run_id} (verified / rows) ===")
    print(f"  {'type':<14} {'test set (Gate 1)':>19} {'test set now':>19} {'new episodes':>19} {'change':>8}")
    flagged = []
    for kind in TYPES:
        base, test_now, new = baseline.get(kind), now["test"].get(kind), now["new"].get(kind)
        change = pct(new) - pct(base) if pct(new) is not None and pct(base) is not None else None
        flag = change is not None and change < -PASS_RATE_DROP
        if flag:
            flagged.append(kind)
        print(f"  {kind:<14} {fmt(base):>19} {fmt(test_now):>19} {fmt(new):>19} "
              f"{'' if change is None else f'{change:+.1f}':>8}{'  <-- drop over ' + str(PASS_RATE_DROP) + ' points' if flag else ''}")
    print("Types that dropped by more than %s points: %s" % (PASS_RATE_DROP, ", ".join(flagged) or "none"))


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
    print_speaker_summary(episodes)
    print()
    print(f"=== {MODELS[key]} (Batch API, effort {EFFORT}, prompt {VERSION}, run {run_id}) ===")
    print(f"Episodes done: {len(done)} of {len(episodes)} ({sum(r['parts'] > 1 for r in done)} split into parts)")
    counts = {"guest": sum(1 for r in done if r["guest"]), "topics": sum(len(r["topics"]) for r in done)}
    counts |= {name: sum(len(r[name]) for r in done) for name in ITEM_LISTS}
    print("Items: " + ", ".join(f"{k} {v}" for k, v in counts.items()))
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
    print(f"Extraction, all attempts: {usage['input_tokens']:,} in, {usage['output_tokens']:,} out, "
          f"USD {cost(key, usage):.4f} (USD {BATCH_PRICES[key][0]}/{BATCH_PRICES[key][1]} per million tokens in/out)")


def print_speaker_summary(episodes: list[dict]) -> None:
    files = {ep["video_id"]: read_json(speaker_path(ep["video_id"])) for ep in episodes
             if speaker_path(ep["video_id"]).exists()}
    usage = {k: sum(s["usage"][k] for s in files.values()) for k in ("input_tokens", "output_tokens")}
    who: dict[str, int] = {}
    print()
    print(f"=== Speakers ({MODELS[SPEAKER_MODEL]}, effort {SPEAKER_EFFORT}, groups of {SPEAKER_GROUP_LINES}) ===")
    print(f"Episodes labelled: {len(files)} of {len(episodes)}, "
          f"written to segments: {sum(s['db_written'] for s in files.values())}")
    for vid, s in files.items():
        letters = list(s["speakers"].values())
        for w in letters:
            who[w] = who.get(w, 0) + 1
        print(f"    {vid}: {100 * letters.count('unknown') / len(letters):.0f}% unknown"
              + (f"; groups left unknown: {', '.join(s['failed_groups'])}" if s["failed_groups"] else ""))
    total = sum(who.values()) or 1
    print("Speakers: " + ", ".join(f"{k} {v:,} ({100 * v / total:.0f}%)" for k, v in sorted(who.items())))
    print(f"Groups left unknown: {sum(len(s['failed_groups']) for s in files.values())}")
    print(f"Speaker step, all attempts: {usage['input_tokens']:,} in, {usage['output_tokens']:,} out, "
          f"USD {cost(SPEAKER_MODEL, usage):.4f}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--model", choices=MODELS, required=True)
    parser.add_argument("--set", choices=["test_set", "all"], required=True)
    parser.add_argument("--speakers-only", action="store_true",
                        help="only label speakers and write them to segments; no extraction")
    parser.add_argument("--max-usd", type=float, default=MAX_RUN_USD,
                        help=f"stop before this run could spend more (default {MAX_RUN_USD})")
    parser.add_argument("--dry-run", action="store_true",
                        help="print the episodes to do and the estimated tokens, cost and time; send nothing")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    log_path = LOGS_DIR / f"extract_{time.strftime('%Y%m%d-%H%M%S')}.log"
    log_file = log_path.open("a", encoding="utf-8")
    sys.stdout, sys.stderr = captions.Tee(sys.stdout, log_file), captions.Tee(sys.stderr, log_file)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    log.info("Console output is also written to %s", log_path)
    load_dotenv(ROOT / ".env")
    if not os.environ.get("ANTHROPIC_API_KEY") and not args.dry_run:
        sys.exit("ANTHROPIC_API_KEY must be set in .env")
    run(args.model, args.set, args.speakers_only, args.max_usd, args.dry_run)


if __name__ == "__main__":
    main()
