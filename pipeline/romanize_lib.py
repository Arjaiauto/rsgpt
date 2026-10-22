"""Shared Haiku romanization of Devanagari caption lines, used by 05_captions.py and 06_romanize.py.

Lines go to claude-haiku-5-5 through the Message Batches API in chunks, as
{"id", "text"} pairs, and come back by ID. Each chunk's answer is saved to its
own JSON file as soon as it arrives, so a rerun only sends chunks that are
missing or came back incomplete. A converted line is checked in code: if its
word count is more than WORD_TOLERANCE away from the original, it is flagged.

Every request uses the same JSON schema (OUTPUT_SCHEMA), so the API compiles it
once rather than once per request; it allows only so many new schemas a minute.
A result refused for a rate limit is not saved, so it does not count as an
attempt, and is sent again in a later round.
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
# Safety net for the API's limit on new JSON schemas (50 a minute): batches are
# created so that at most this many schemas not sent before in this run go out per minute.
NEW_SCHEMAS_PER_MINUTE = 40
RATE_LIMIT_WAIT_SECONDS = 60  # pause before resending results refused for a rate limit
# One batch may hold at most 100,000 requests and 256 MB; stay well under both.
MAX_BATCH_REQUESTS = 50000
MAX_BATCH_BYTES = 100_000_000

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

_schemas_sent: set[str] = set()  # schemas already sent in this run, which the API has compiled


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


def rate_limited(result) -> bool:
    """A result refused for a rate limit (including the JSON-schema compilation limit): try again later."""
    if result.type != "errored":
        return False
    error = getattr(result.error, "error", None)
    return getattr(error, "type", "") == "rate_limit_error" or "rate limit" in str(result.error).lower()


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


def schema_key(request: Request) -> str:
    fmt = request["params"].get("output_config", {}).get("format")
    return json.dumps(fmt, sort_keys=True) if fmt else ""


def paced_groups(requests: dict[str, Request]) -> list[dict[str, Request]]:
    """Split requests so that each group brings at most NEW_SCHEMAS_PER_MINUTE schemas not sent before,
    and stays under MAX_BATCH_REQUESTS requests and MAX_BATCH_BYTES of JSON."""
    groups, current, new_here, planned, size = [], {}, set(), set(_schemas_sent), 0
    for custom_id, request in requests.items():
        key = schema_key(request)
        request_bytes = len(json.dumps(request, ensure_ascii=False).encode("utf-8"))
        new_schema = key and key not in planned
        if current and ((new_schema and len(new_here) >= NEW_SCHEMAS_PER_MINUTE)
                        or len(current) >= MAX_BATCH_REQUESTS or size + request_bytes > MAX_BATCH_BYTES):
            groups.append(current)
            current, new_here, size = {}, set(), 0
        if new_schema:
            new_here.add(key)
            planned.add(key)
        current[custom_id] = request
        size += request_bytes
    if current:
        groups.append(current)
    return groups


def run_batch(client: anthropic.Anthropic, requests: dict[str, Request], expected: dict[str, list[str]],
              job_path: Path, chunk_dir: Path, save=None) -> list[str]:
    """Send the requests (or resume the saved, uncollected job), wait, and save each chunk's answer.

    Requests go out as one batch, or as several a minute apart when they bring more than
    NEW_SCHEMAS_PER_MINUTE new JSON schemas or exceed the batch size limits. save(path, chunk_id, expected_ids, result) stores
    one result; save_chunk by default. Results refused for a rate limit are not saved, so they
    do not count as attempts; their IDs are returned so the caller can wait and send them again.
    """
    save = save or save_chunk
    job = json.loads(job_path.read_text(encoding="utf-8")) if job_path.exists() else None
    if job and not job.get("collected") and set(requests) & set(job["custom_ids"]):
        job.setdefault("batch_ids", [job.pop("batch_id")] if "batch_id" in job else [])
        log.info("Resuming batches %s", ", ".join(job["batch_ids"]))
    else:
        job = {"batch_ids": [], "custom_ids": [], "collected": False}
    to_send = {c: r for c, r in requests.items() if c not in job["custom_ids"]}
    for n, group in enumerate(paced_groups(to_send)):
        if n:
            log.info("Waiting 60s before the next batch, to keep new JSON schemas under %s a minute",
                     NEW_SCHEMAS_PER_MINUTE)
            time.sleep(60)
        batch = client.messages.batches.create(requests=list(group.values()))
        _schemas_sent.update(schema_key(r) for r in group.values())
        job["batch_ids"].append(batch.id)
        job["custom_ids"] = sorted({*job["custom_ids"], *group})
        job_path.write_text(json.dumps(job, indent=2), encoding="utf-8")
        log.info("Batch %s created with %s requests", batch.id, len(group))

    for batch_id in job["batch_ids"]:
        last = None
        while True:
            batch = client.messages.batches.retrieve(batch_id)
            counts = batch.request_counts
            state = (batch.processing_status, counts.processing, counts.succeeded, counts.errored)
            if state != last:
                log.info("Batch %s: %s (processing %s, succeeded %s, errored %s)", batch.id, *state)
                last = state
            if batch.processing_status == "ended":
                break
            time.sleep(POLL_SECONDS)

    limited = []
    for batch_id in job["batch_ids"]:
        for result in client.messages.batches.results(batch_id):
            path = chunk_dir / f"{result.custom_id}.json"
            if result.custom_id not in expected or chunk_done(path):
                continue
            if rate_limited(result.result):
                limited.append(result.custom_id)
                continue
            save(path, result.custom_id, expected[result.custom_id], result.result)
    if limited:
        log.warning("%s requests refused for a rate limit, not counted as attempts; they will be sent again: %s",
                    len(limited), ", ".join(limited[:5]))
    job["collected"] = True
    job_path.write_text(json.dumps(job, indent=2), encoding="utf-8")
    return limited


def wait_after_rate_limit(limited: list[str]) -> None:
    if limited:
        log.info("Waiting %ss before sending them again", RATE_LIMIT_WAIT_SECONDS)
        time.sleep(RATE_LIMIT_WAIT_SECONDS)


# ---------- translation with exact line IDs ----------
#
# Each request carries at most TRANSLATION_UNIT_LINES lines, each prefixed with its ID,
# and asks for them back as {"lines": [{"id", "text"}]} under the shared OUTPUT_SCHEMA.
# The IDs are checked in code: missing, extra, duplicated or empty IDs reject the
# answer. A unit that fails TRANSLATION_ATTEMPTS times is split in half and each
# half retried; a single line gets SINGLE_LINE_ATTEMPTS tries.
#
# Then a length check: within an episode, the median English/source word ratio says
# how long a translation should be. A line of at least LENGTH_MIN_WORDS source words
# whose English is more than LENGTH_FACTOR times, or under 1/LENGTH_FACTOR of, that
# expected length is flagged (a sign that text slid onto the wrong line) and
# translated again on its own, with its neighbours shown as context only.
#
# Every answer is saved to <unit id>.json as it arrives and the work left to do is
# worked out from those files, so an interrupted run carries on where it stopped.

TRANSLATION_UNIT_LINES = 40
TRANSLATION_ATTEMPTS = 2
SINGLE_LINE_ATTEMPTS = 3
TRANSLATION_MAX_ROUNDS = 12
LENGTH_FACTOR = 3.0
LENGTH_MIN_WORDS = 4
CONTEXT_LINES = 2


def translation_request(unit_id: str, lines: list[dict], title: str, guest: str, system: str,
                        before: list[dict] | None = None, after: list[dict] | None = None) -> Request:
    numbered = "\n".join(f"[{l['id']}] {l['text']}" for l in lines)
    prompt = f"Episode title: {title}\nGuest: {guest}\n\n"
    if before:
        prompt += "Context before (do not translate):\n" + "\n".join(l["text"] for l in before) + "\n\n"
    prompt += f"Lines to translate ({len(lines)}), each numbered with its id:\n{numbered}\n"
    if after:
        prompt += "\nContext after (do not translate):\n" + "\n".join(l["text"] for l in after) + "\n"
    prompt += ("\nReturn every one of these ids exactly once, in order, each with the English "
               "translation of that line only.")
    return Request(
        custom_id=unit_id,
        params=MessageCreateParamsNonStreaming(
            model=MODEL,
            max_tokens=MAX_TOKENS,
            system=system,
            output_config={"effort": TRANSLATION_EFFORT,
                           "format": {"type": "json_schema", "schema": OUTPUT_SCHEMA}},
            messages=[{"role": "user", "content": prompt}],
        ),
    )


def save_translation(path: Path, unit_id: str, expected_ids: list[str], result) -> None:
    """Like save_chunk, but rejects answers with missing, extra, duplicated or empty ids."""
    record = {"chunk_id": unit_id, "result_type": result.type, "complete": False,
              "usage": {"input_tokens": 0, "output_tokens": 0}, "lines": {}, "error": ""}
    if result.type == "succeeded":
        msg = result.message
        record["usage"] = {"input_tokens": msg.usage.input_tokens, "output_tokens": msg.usage.output_tokens}
        record["stop_reason"] = msg.stop_reason
        text = next((b.text for b in msg.content if b.type == "text"), "")
        record["raw_text"] = text
        if msg.stop_reason != "end_turn":
            record["error"] = f"stop_reason {msg.stop_reason}"
        else:
            try:
                items = json.loads(text)["lines"]
                if not all(isinstance(l, dict) and isinstance(l.get("id"), str) for l in items):
                    raise ValueError("lines are not objects with an id")
                ids = [l["id"] for l in items]
                answer = {l["id"]: l.get("text", "") for l in items}
                missing = [i for i in expected_ids if i not in answer]
                extra = sorted({i for i in ids if i not in expected_ids})
                duplicated = sorted({i for i in ids if ids.count(i) > 1})
                empty = [i for i in expected_ids if i in answer and not str(answer[i]).strip()]
                problems = [f"{name} {found[:5]}" for name, found in
                            (("missing", missing), ("extra", extra), ("duplicated", duplicated),
                             ("empty", empty)) if found]
                if problems:
                    record["error"] = "; ".join(problems)
                else:
                    record["lines"] = {i: str(answer[i]).strip() for i in expected_ids}
                    record["complete"] = True
            except (json.JSONDecodeError, KeyError, TypeError, ValueError) as exc:
                record["error"] = f"rejected: {exc}"
    elif result.type == "errored":
        record["error"] = str(result.error)[:500]
    if path.exists():
        # Keep the spend and errors of earlier attempts; the attempt count comes from them.
        old = json.loads(path.read_text(encoding="utf-8"))
        record["earlier_usage"] = [*old.get("earlier_usage", []), old["usage"]]
        record["earlier_errors"] = [*old.get("earlier_errors", []), old.get("error", "")]
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(record, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)
    if record["complete"]:
        log.info("%s: ok (%s in / %s out tokens)", unit_id, record["usage"]["input_tokens"],
                 record["usage"]["output_tokens"])
    else:
        log.warning("%s: %s", unit_id, record["error"] or result.type)


def attempts(path: Path) -> int:
    if not path.exists():
        return 0
    return 1 + len(json.loads(path.read_text(encoding="utf-8")).get("earlier_usage", []))


def _resolve(unit_id: str, lines: list[dict], unit_dir: Path, pending: dict, failed: list[str]) -> dict:
    """Translations for a unit from saved answers, splitting it in half once it has failed enough.

    Adds units still to send to pending (unit_id -> lines) and lines that ran out of tries to
    failed. Returns {id: text} for the lines that are done.
    """
    path = unit_dir / f"{unit_id}.json"
    if chunk_done(path):
        return chunk_lines(path)
    tries = attempts(path)
    if len(lines) > 1 and tries >= TRANSLATION_ATTEMPTS:
        half = (len(lines) + 1) // 2
        done = {}
        for suffix, part in (("a", lines[:half]), ("b", lines[half:])):
            done |= _resolve(f"{unit_id}{suffix}", part, unit_dir, pending, failed)
        return done
    if len(lines) == 1 and tries >= SINGLE_LINE_ATTEMPTS:
        failed.append(lines[0]["id"])
        return {}
    pending[unit_id] = lines
    return {}


def episode_ratio(lines: list[dict], english: dict[str, str]) -> float | None:
    """Median English/source word ratio over lines long enough to judge."""
    ratios = sorted(word_count(english[l["id"]]) / word_count(l["text"]) for l in lines
                    if l["id"] in english and word_count(l["text"]) >= LENGTH_MIN_WORDS)
    return ratios[len(ratios) // 2] if ratios else None


def length_off(source: str, english: str, ratio: float | None) -> bool:
    src = word_count(source)
    if ratio is None or src < LENGTH_MIN_WORDS:
        return False
    expected = src * ratio
    return not expected / LENGTH_FACTOR <= word_count(english) <= expected * LENGTH_FACTOR


def translate_episodes(client: anthropic.Anthropic, episodes: list[dict], unit_dir: Path, job_path: Path) -> dict:
    """Translate episodes line by line.

    Each episode is a dict with key (unique, safe in a batch custom_id), title, guest, roman (True
    when the lines are Roman Hinglish rather than Devanagari) and lines ([{id, text}]).
    Returns, per key: lines ({id: English}), flagged (by the length check), fixed (flagged lines
    that passed after their own retry), still_flagged, failed (lines with no translation at
    all), cost (USD, every attempt) and complete (every line has a translation).
    """
    unit_dir.mkdir(parents=True, exist_ok=True)
    systems = {ep["key"]: translation_prompt(roman=ep["roman"]) for ep in episodes}

    def plan_units():
        pending, done, failed = {}, {}, {}
        for ep in episodes:
            key = ep["key"]
            done[key], failed[key] = {}, []
            for n, i in enumerate(range(0, len(ep["lines"]), TRANSLATION_UNIT_LINES)):
                unit_pending = {}
                done[key] |= _resolve(f"{key}-u{n:03d}", ep["lines"][i:i + TRANSLATION_UNIT_LINES],
                                      unit_dir, unit_pending, failed[key])
                pending |= {u: (ep, lines) for u, lines in unit_pending.items()}
        return pending, done, failed

    for round_no in range(1, TRANSLATION_MAX_ROUNDS + 1):
        pending, _, _ = plan_units()
        if not pending:
            break
        log.info("Translation round %s: %s requests, %s lines", round_no, len(pending),
                 sum(len(lines) for _, lines in pending.values()))
        requests = {u: translation_request(u, lines, ep["title"], ep["guest"], systems[ep["key"]])
                    for u, (ep, lines) in pending.items()}
        expected = {u: [l["id"] for l in lines] for u, (_, lines) in pending.items()}
        wait_after_rate_limit(run_batch(client, requests, expected, job_path, unit_dir, save=save_translation))
    pending, done, failed = plan_units()
    for u, (ep, _) in pending.items():
        log.error("%s: still unfinished after %s rounds", u, TRANSLATION_MAX_ROUNDS)

    ratios = {ep["key"]: episode_ratio(ep["lines"], done[ep["key"]]) for ep in episodes}
    flags = {ep["key"]: [l["id"] for l in ep["lines"]
                         if l["id"] in done[ep["key"]] and length_off(l["text"], done[ep["key"]][l["id"]],
                                                                      ratios[ep["key"]])]
             for ep in episodes}

    def plan_retries():
        pending, retried = {}, {}
        for ep in episodes:
            key = ep["key"]
            retried[key] = {}
            index = {l["id"]: i for i, l in enumerate(ep["lines"])}
            for line_id in flags[key]:
                path = unit_dir / f"{line_id}-r.json"
                if chunk_done(path):
                    retried[key][line_id] = chunk_lines(path)[line_id]
                elif attempts(path) < SINGLE_LINE_ATTEMPTS:
                    pending[f"{line_id}-r"] = (ep, index[line_id])
        return pending, retried

    # Rounds refused for a rate limit do not use up a line's attempts, so allow more rounds than attempts.
    for round_no in range(1, TRANSLATION_MAX_ROUNDS + 1):
        pending, _ = plan_retries()
        if not pending:
            break
        log.info("Length-check retry round %s: %s lines", round_no, len(pending))
        requests, expected = {}, {}
        for u, (ep, i) in pending.items():
            line = ep["lines"][i]
            requests[u] = translation_request(u, [line], ep["title"], ep["guest"], systems[ep["key"]],
                                              before=ep["lines"][max(0, i - CONTEXT_LINES):i],
                                              after=ep["lines"][i + 1:i + 1 + CONTEXT_LINES])
            expected[u] = [line["id"]]
        wait_after_rate_limit(run_batch(client, requests, expected, job_path, unit_dir, save=save_translation))
    _, retried = plan_retries()

    report = {}
    for ep in episodes:
        key = ep["key"]
        lines = dict(done[key])
        source = {l["id"]: l["text"] for l in ep["lines"]}
        fixed, still = [], []
        for line_id in flags[key]:
            if line_id in retried[key]:
                # A one-line retry cannot have slid onto a neighbour, so it replaces the first answer.
                lines[line_id] = retried[key][line_id]
                (still if length_off(source[line_id], lines[line_id], ratios[key]) else fixed).append(line_id)
            else:
                still.append(line_id)
        cost = sum(chunk_cost(p) for p in unit_dir.glob(f"{key}-*.json"))
        report[key] = {"lines": lines, "flagged": flags[key], "fixed": fixed, "still_flagged": still,
                       "failed": failed[key], "cost": cost,
                       "complete": all(l["id"] in lines for l in ep["lines"])}
    return report
