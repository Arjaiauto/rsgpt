"""Shared Haiku romanization of Devanagari caption lines, used by 05_captions.py and 06_romanize.py.

Lines go to claude-haiku-5-5 through the Message Batches API in chunks, as
{"id", "text"} pairs, and come back by ID. Each chunk's answer is saved to its
own JSON file as soon as it arrives, so a rerun only sends chunks that are
missing or came back incomplete. A converted line is checked in code: if its
word count is more than WORD_TOLERANCE away from the original, it is flagged.
"""

import json
import logging
import re
import time
from pathlib import Path

import anthropic
from anthropic.types.message_create_params import MessageCreateParamsNonStreaming
from anthropic.types.messages.batch_create_params import Request

MODEL = "claude-haiku-5-5"
MAX_TOKENS = 16000
WORD_TOLERANCE = 0.20
POLL_SECONDS = 30

# Prices checked 2026-10-21 (claude-haiku-5-5, prompts up to 100K tokens), USD per
# million tokens; the Batch API bills half.
PRICE_INPUT = 0.10
PRICE_OUTPUT = 0.50
BATCH_DISCOUNT = 0.5

SYSTEM_PROMPT = """You convert YouTube automatic captions of a Hindi/Hinglish podcast from Devanagari into Roman script, line by line.

Rules:
1. Hindi words: transliterate them into natural Roman-script Hinglish, the way people type Hindi on WhatsApp (for example "nahi", "hai", "kya", "bahut", "zyada", "kar rahe hain", "matlab"). No diacritics and no academic transliteration.
2. English words written in Devanagari: restore their normal English spelling (for example "क्रिएटर" -> "creator", "इनडिस्पेंसिबल" -> "indispensable", "गाइस" -> "guys", "यूजुअल क्वेश्चन" -> "usual question").
3. Never translate, summarise, add or drop words. Keep every word in its order, including repetitions, fillers, mistakes and words cut off at the end of a line. Hyphenated pairs stay hyphenated (कभी-कभी -> kabhi-kabhi).
4. For names of people, places, companies and brands, use the episode title and guest name given with the lines as spelling hints.
5. Keep punctuation; "।" becomes ".".
6. Lines are fragments of running speech and often break mid-sentence. Convert each line on its own and never move words from one line to another.

Return every input line exactly once, with its id unchanged."""

# Translation into English, as tested on the bake-off (07_translate.py). {script_note}
# says what script the lines are in: DEVANAGARI_NOTE for YouTube captions,
# ROMAN_NOTE for Sarvam's Roman-script Hinglish.
TRANSLATION_EFFORT = "medium"
DEVANAGARI_NOTE = "The captions are in Devanagari; English words in them are also written in Devanagari."
ROMAN_NOTE = ("The captions are in Roman-script Hinglish (Hindi typed in Latin letters, mixed with English); "
              "English words in them are written normally.")
TRANSLATION_PROMPT = """You translate YouTube automatic captions of a Hindi/Hinglish podcast into English, line by line. {script_note}

Rules:
1. Faithful meaning: translate what is said, including hedges, repetitions and unfinished thoughts. Do not summarise, shorten, explain or add commentary.
2. Natural spoken English, the way the speaker would say it in English. Keep the conversational tone; do not make it formal.
3. Keep names of people, places, companies and brands, and all numbers, amounts and dates exactly as said. Use the episode title and guest name given with the lines as spelling hints for names.
4. English words written in {english_script} stay as those English words.
5. Lines are fragments of running speech and often break mid-sentence. Read the neighbouring lines for context, but each output line must carry only the meaning of its own line's words; never move content from one line to another. If a line is only part of a sentence, translate that part as a fragment, and leave a line that is only a filler or a sound as a short equivalent.

Return every input line exactly once, with its id unchanged."""


def translation_prompt(roman: bool = False) -> str:
    if roman:
        return TRANSLATION_PROMPT.format(script_note=ROMAN_NOTE, english_script="the lines")
    return TRANSLATION_PROMPT.format(script_note=DEVANAGARI_NOTE, english_script="Devanagari")


OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "lines": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"id": {"type": "string"}, "text": {"type": "string"}},
                "required": ["id", "text"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["lines"],
    "additionalProperties": False,
}

log = logging.getLogger("romanize")


def guess_guest(title: str) -> str:
    """A spelling hint only: the part of an episode title that looks like the guest's name."""
    parts = [p.strip(" -–|") for p in re.split(r"\s*\|\s*|\s+[-–]\s+", title)]
    parts = [p for p in parts if p and not re.search(r"\bF[O0]\s?\d+|Raj Shamani", p)]
    names = [p for p in parts[1:] if len(p.split()) <= 4]
    if names:
        return names[-1]
    if parts and re.search(r"\s[Oo]n\s", parts[0]):
        return re.split(r"\s[Oo]n\s", parts[0])[0].strip()
    return "unknown (see title)"


def build_request(chunk_id: str, lines: list[dict], title: str, guest: str,
                  system: str = SYSTEM_PROMPT, effort: str = "low") -> Request:
    """One batch request for a chunk of lines; system and effort default to romanization's."""
    body = "\n".join(json.dumps({"id": l["id"], "text": l["text"]}, ensure_ascii=False) for l in lines)
    prompt = (f"Episode title: {title}\nGuest: {guest}\n\n"
              f"Caption lines ({len(lines)}), one JSON object per line:\n{body}")
    return Request(
        custom_id=chunk_id,
        params=MessageCreateParamsNonStreaming(
            model=MODEL,
            max_tokens=MAX_TOKENS,
            system=system,
            output_config={"effort": effort, "format": {"type": "json_schema", "schema": OUTPUT_SCHEMA}},
            messages=[{"role": "user", "content": prompt}],
        ),
    )


def cost_of(usage: dict) -> float:
    return (usage["input_tokens"] * PRICE_INPUT + usage["output_tokens"] * PRICE_OUTPUT) / 1e6 * BATCH_DISCOUNT


def word_count(text: str) -> int:
    return len(text.split())


def is_flagged(source_text: str, text: str) -> bool:
    src_words = word_count(source_text)
    return abs(word_count(text) - src_words) > WORD_TOLERANCE * src_words


def chunk_done(path: Path) -> bool:
    return path.exists() and json.loads(path.read_text(encoding="utf-8"))["complete"]


def chunk_lines(path: Path) -> dict[str, str]:
    return json.loads(path.read_text(encoding="utf-8"))["lines"]


def chunk_cost(path: Path) -> float:
    if not path.exists():
        return 0.0
    record = json.loads(path.read_text(encoding="utf-8"))
    return sum(cost_of(u) for u in [*record.get("earlier_usage", []), record["usage"]])


def save_chunk(path: Path, chunk_id: str, expected_ids: list[str], result) -> None:
    """Save one batch result. Usage is recorded even when the answer is unusable, since it was paid for."""
    record = {"chunk_id": chunk_id, "result_type": result.type, "complete": False,
              "usage": {"input_tokens": 0, "output_tokens": 0}, "lines": {}, "error": ""}
    if result.type == "succeeded":
        msg = result.message
        record["usage"] = {"input_tokens": msg.usage.input_tokens, "output_tokens": msg.usage.output_tokens}
        record["stop_reason"] = msg.stop_reason
        text = next((b.text for b in msg.content if b.type == "text"), "")
        if msg.stop_reason != "end_turn":
            record["error"] = f"stop_reason {msg.stop_reason}"
        else:
            try:
                lines = json.loads(text)["lines"]
                record["lines"] = {l["id"]: l["text"] for l in lines if l["id"] in expected_ids}
                missing = [i for i in expected_ids if i not in record["lines"]]
                if missing:
                    record["error"] = f"{len(missing)} lines missing: {missing[:5]}"
                else:
                    record["complete"] = True
            except (json.JSONDecodeError, KeyError, TypeError) as exc:
                record["error"] = f"bad JSON: {exc}"
            record["raw_text"] = text
    elif result.type == "errored":
        record["error"] = str(result.error)[:500]
    if path.exists():
        # Keep the spend of earlier failed attempts in the total.
        old = json.loads(path.read_text(encoding="utf-8"))
        record["earlier_usage"] = [*old.get("earlier_usage", []), old["usage"]]
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)
    if record["complete"]:
        log.info("%s: ok (%s in / %s out tokens)", chunk_id, record["usage"]["input_tokens"],
                 record["usage"]["output_tokens"])
    else:
        log.error("%s: %s; will be sent again", chunk_id, record["error"] or result.type)


def run_batch(client: anthropic.Anthropic, requests: dict[str, Request], expected: dict[str, list[str]],
              job_path: Path, chunk_dir: Path) -> None:
    """Send the requests as one batch (or resume the saved one), wait, and save each chunk's answer."""
    job = json.loads(job_path.read_text(encoding="utf-8")) if job_path.exists() else None
    if job and not job.get("collected") and set(requests) <= set(job["custom_ids"]):
        log.info("Resuming batch %s", job["batch_id"])
    else:
        batch = client.messages.batches.create(requests=list(requests.values()))
        job = {"batch_id": batch.id, "custom_ids": sorted(requests), "collected": False}
        job_path.write_text(json.dumps(job, indent=2), encoding="utf-8")
        log.info("Batch %s created with %s requests", batch.id, len(requests))

    last = None
    while True:
        batch = client.messages.batches.retrieve(job["batch_id"])
        counts = batch.request_counts
        state = (batch.processing_status, counts.processing, counts.succeeded, counts.errored)
        if state != last:
            log.info("Batch %s: %s (processing %s, succeeded %s, errored %s)", batch.id, *state)
            last = state
        if batch.processing_status == "ended":
            break
        time.sleep(POLL_SECONDS)

    for result in client.messages.batches.results(job["batch_id"]):
        path = chunk_dir / f"{result.custom_id}.json"
        if result.custom_id in expected and not chunk_done(path):
            save_chunk(path, result.custom_id, expected[result.custom_id], result.result)
    job["collected"] = True
    job_path.write_text(json.dumps(job, indent=2), encoding="utf-8")
