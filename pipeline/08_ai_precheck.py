"""AI pre-check of the Gate 1 sample: does each item's cited transcript support it?

For every item in the saved Gate 1 sample (data/review/gate1_sample_<run_id>.json,
drawn by review_app.py), claude-sonnet-5-5 gets the item and the transcript lines
it cites, with their speaker letters and Roman text and, for Hindi episodes, the
English translation lines over the same times. It answers with one fixed JSON
schema: verdict (supported / not_supported / unsure) and a one-line reason.

Requests go through the Message Batches API, one per item. Each answer is saved to
data/review/ai_precheck/<run_id>/<table>-<id>.json as it arrives, so a rerun only
sends items still missing; results refused for a rate limit are not counted as
attempts and are sent again after a pause (romanize_lib.run_batch). Unusable
answers are retried up to MAX_ATTEMPTS times.

When every item has an answer, the results go to data/review/ai_precheck_<run_id>.json,
separate from the reviews table, and the fast-review set is drawn once and saved to
data/review/fast_review_<run_id>.json: every item not marked supported, plus a fixed
random FAST_RANDOM_SIZE of the supported ones. review_app.py's "Fast review" mode
reads both files.

Usage:
    .venv\\Scripts\\python.exe pipeline\\08_ai_precheck.py
    .venv\\Scripts\\python.exe pipeline\\08_ai_precheck.py --run-id extract-haiku-v3-20261022-215258
"""

import argparse
import importlib.util
import json
import logging
import random
import sys
from collections import Counter
from pathlib import Path

import anthropic
from anthropic.types.message_create_params import MessageCreateParamsNonStreaming
from anthropic.types.messages.batch_create_params import Request
from dotenv import load_dotenv

import romanize_lib

ROOT = Path(__file__).resolve().parent.parent
REVIEW_DIR = ROOT / "data" / "review"
DEFAULT_RUN_ID = "extract-haiku-v3-20261022-215258"

MODEL = "claude-sonnet-5-5"
EFFORT = "medium"
MAX_TOKENS = 8000
MAX_ATTEMPTS = 3
MAX_ROUNDS = 12
# Batch API prices for claude-sonnet-5-5, USD per million tokens (input, output), as in 06_extract.py.
BATCH_PRICES = (1.00, 5.00)
FAST_RANDOM_SIZE = 100
FAST_SEED = 1
VERDICTS = ["supported", "not_supported", "unsure"]
SPEAKER_LETTERS = {"raj": "R", "guest": "G", "unknown": "U"}

OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {"verdict": {"type": "string", "enum": VERDICTS}, "reason": {"type": "string"}},
    "required": ["verdict", "reason"],
    "additionalProperties": False,
}

SYSTEM_PROMPT = """You check research notes that another model extracted from one episode of the Figuring Out podcast. Raj Shamani is the host: he asks the questions. The guest answers them.

You get one item and the transcript lines it cites. Decide whether those cited lines support the item:
- supported: everything the item says is said in the cited lines, by the right person, and the item is the kind it claims to be.
- not_supported: something in the item is not in the cited lines, is contradicted by them, is given to the wrong person, or the item is not the kind it claims to be (for example a "Raj question" that is not a question Raj asks).
- unsure: the lines are too garbled, cut off or ambiguous to tell either way.

Judge only against the cited lines, never from your own knowledge. The lines are YouTube automatic captions in Roman script (Hinglish for Hindi episodes): expect misspellings, missing punctuation and words split across lines. English translation lines, when given, are machine translations of the same stretch; use them to understand the Hindi. Each line's speaker letter (R Raj, G guest, U unknown) was added by a machine and is sometimes wrong; when the content makes clear who is speaking, go by the content.

Give the reason in one short line: what is missing or wrong, or what supports the item."""

TYPE_RULES = {
    "guest": "A guest profile. Every fact in it (name, organisation, role, bio) must be stated or clearly implied "
             "in the cited lines; sector tags may be broad labels for what is discussed.",
    "quote": "A quote. It must appear in the cited lines with the same words (small caption differences in "
             "spelling are fine) and keep its meaning in context.",
    "takeaway": "A key takeaway of the episode. It must be a fair summary of what is said in the cited lines.",
    "opportunity": "An opportunity, with a category. It must be mentioned in the cited lines as described, and "
                   "the category must fit.",
    "disagreement": "A disagreement between Raj and the guest. They must actually disagree in the cited lines, "
                    "and each side's position must be stated correctly.",
    "raj_question": "A question Raj asks the guest, in English, with a question type (opening, follow-up, "
                    "challenge, personal, deep-dive). Raj must ask this question in the cited lines (the English "
                    "may paraphrase him), and the type must roughly fit.",
    "raj_opinion": "An opinion Raj states himself. Raj must state it in the cited lines; not a question he asks "
                   "and not the guest's view.",
    "clip": "A candidate short video clip from the first to the last cited line, with a topic and its opening "
            "line. The lines must be about the topic, start with the opening line, and make sense on their own "
            "as a clip (not starting or stopping mid-thought).",
}

log = logging.getLogger("ai_precheck")


def load_module(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


check = load_module("check", "07_check.py")


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, indent=1, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def clock(seconds: float) -> str:
    s = int(seconds)
    return f"{s // 3600}:{s % 3600 // 60:02d}:{s % 60:02d}" if s >= 3600 else f"{s // 60}:{s % 60:02d}"


def custom_id(item: dict) -> str:
    return f"{item['table']}-{item['id']}"


# ---------- items and their cited lines ----------

def by_id(db, table: str, ids: list[int]) -> dict[int, dict]:
    rows = {}
    for n in range(0, len(ids), 300):
        chunk = ids[n:n + 300]
        rows |= {r["id"]: r for r in check.db_call(f"{table} select", lambda: db.table(table).select("*").in_(
            "id", chunk).execute()).data}
    return rows


def describe(item: dict, row: dict) -> tuple[str, str]:
    """The item's text as shown to the model, and its label line."""
    kind = item["type"]
    if kind == "guest":
        text = "\n".join(x for x in [f"Name: {row['name']}", f"Organisation: {row['organisation'] or ''}",
                                     f"Role: {row['role_at_episode'] or ''}", f"Bio: {row['bio'] or ''}",
                                     "Sectors: " + ", ".join(row["sector_tags"] or [])])
        return text, "Guest profile"
    if kind == "clip":
        return (f"Topic: {row['topic']}\nOpening line: {row['opening_line']}\n"
                f"Length: {row['end_s'] - row['start_s']:.0f} s"), "Clip"
    label = kind.replace("_", " ")
    if kind == "opportunity":
        label += f" (category: {(row['category'] or '').replace('_', ' ')})"
    if kind == "raj_question":
        qtype = next((p.split(":", 1)[1].strip() for p in (row["check_notes"] or "").split(";")
                      if p.strip().startswith("question_type:")), "")
        label += f" (type: {qtype})" if qtype else ""
    if row["translated"]:
        label += " (an English rendering: it matches the English translation, not the Roman text)"
    return row["text"], label


def cited_ids(item: dict, row: dict, segments: list[dict], merged: dict | None) -> list[int]:
    if item["type"] == "guest":
        return ((merged or {}).get("guest") or {}).get("source_segment_ids", [])
    if item["type"] == "clip":
        return [s["id"] for s in segments if s["start_s"] >= row["start_s"] - 0.05 and s["end_s"] <= row["end_s"] + 0.05]
    return row["source_segment_ids"] or []


def build_prompt(item: dict, row: dict, episode: dict, segments: dict[int, dict], translations: list[dict],
                 merged: dict | None) -> tuple[str, list[int]]:
    ids = cited_ids(item, row, list(segments.values()), merged)
    cited = sorted((segments[i] for i in ids if i in segments), key=lambda s: s["seq"])
    text, label = describe(item, row)
    prompt = (f"Episode: {episode['title']}\n\nWhat this kind of item must be: {TYPE_RULES[item['type']]}\n\n"
              f"Item ({label}):\n{text}\n\nCited transcript lines:\n")
    prompt += "\n".join(f"[S{s['id']} {SPEAKER_LETTERS.get(s['speaker'], 'U')} | {clock(s['start_s'])}] "
                        f"{s['text_roman']}" for s in cited) or "(none)"
    if episode.get("caption_language") == "hi" and cited:
        english = [t for t in translations if any(t["end_s"] > s["start_s"] + 0.05 and t["start_s"] < s["end_s"] - 0.05
                                                  for s in cited)]
        if english:
            prompt += "\n\nEnglish translation of the same times (machine translation):\n"
            prompt += "\n".join(f"[{clock(t['start_s'])}] {t['text']}" for t in english)
    return prompt, [s["id"] for s in cited]


def build_request(cid: str, prompt: str) -> Request:
    return Request(custom_id=cid, params=MessageCreateParamsNonStreaming(
        model=MODEL, max_tokens=MAX_TOKENS, system=SYSTEM_PROMPT,
        output_config={"effort": EFFORT, "format": {"type": "json_schema", "schema": OUTPUT_SCHEMA}},
        messages=[{"role": "user", "content": prompt}]))


def save_answer(path: Path, cid: str, expected, result) -> None:
    """Save one batch result. Usage is kept even when the answer is unusable, since it was paid for."""
    record = {"custom_id": cid, "result_type": result.type, "complete": False,
              "usage": {"input_tokens": 0, "output_tokens": 0}, "error": ""}
    if result.type == "succeeded":
        msg = result.message
        record["usage"] = {"input_tokens": msg.usage.input_tokens, "output_tokens": msg.usage.output_tokens}
        text = next((b.text for b in msg.content if b.type == "text"), "")
        if msg.stop_reason != "end_turn":
            record["error"] = f"stop_reason {msg.stop_reason}"
        else:
            try:
                answer = json.loads(text)
                verdict = answer["verdict"].strip().lower()
                if verdict not in VERDICTS or not answer["reason"].strip():
                    raise ValueError(f"verdict {verdict!r} or empty reason")
                record |= {"verdict": verdict, "reason": answer["reason"].strip(), "complete": True}
            except (json.JSONDecodeError, KeyError, TypeError, ValueError, AttributeError) as exc:
                record["error"] = f"bad answer: {exc}"
                record["raw_text"] = text
    elif result.type == "errored":
        record["error"] = str(result.error)[:500]
    if path.exists():
        old = read_json(path)
        record["earlier_usage"] = [*old.get("earlier_usage", []), old["usage"]]
    write_json(path, record)
    if not record["complete"]:
        log.error("%s: %s; will be sent again", cid, record["error"] or result.type)


def cost(usages: list[dict]) -> float:
    return sum(u["input_tokens"] * BATCH_PRICES[0] + u["output_tokens"] * BATCH_PRICES[1] for u in usages) / 1e6


# ---------- run ----------

def run(run_id: str) -> None:
    sample_path = REVIEW_DIR / f"gate1_sample_{run_id}.json"
    if not sample_path.exists():
        sys.exit(f"{sample_path.relative_to(ROOT)} not found: open the Gate 1 sample mode in review_app.py first")
    sample = read_json(sample_path)["items"]
    answer_dir = REVIEW_DIR / "ai_precheck" / run_id
    job_path = answer_dir / "batch_job.json"

    todo = [s for s in sample if not romanize_lib.chunk_done(answer_dir / f"{custom_id(s)}.json")]
    log.info("%s items in the sample, %s still to check", len(sample), len(todo))
    prompts, cited = {}, {}
    if todo:
        db = check.captions.supabase_client()
        rows = {}
        for table in ("guests", "insights", "clips"):
            rows |= {(table, i): r for i, r in by_id(db, table, [s["id"] for s in sample if s["table"] == table]).items()}
        vids = sorted({s["video_id"] for s in todo})
        episodes = {e["video_id"]: e for e in check.fetch(db, "episodes", "video_id,title,caption_language",
                                                          order="video_id")}
        merged = check.merged_results(run_id)
        for vid in vids:
            segments = {s["id"]: s for s in check.fetch(db, "segments", "id,seq,start_s,end_s,speaker,text_roman",
                                                        order="seq", video_id=vid)}
            translations = (sorted(check.fetch(db, "translation_segments", "id,start_s,end_s,text", video_id=vid),
                                   key=lambda t: t["start_s"]) if episodes[vid].get("caption_language") == "hi" else [])
            for item in (s for s in todo if s["video_id"] == vid):
                row = rows.get((item["table"], item["id"]))
                if row is None:
                    log.warning("%s no longer exists; skipped", custom_id(item))
                    continue
                prompts[custom_id(item)], cited[custom_id(item)] = build_prompt(
                    item, row, episodes[vid], segments, translations, merged.get(vid))
            log.info("%s: prompts ready", vid)
        (answer_dir / "prompts").mkdir(parents=True, exist_ok=True)
        for cid, prompt in prompts.items():
            (answer_dir / "prompts" / f"{cid}.txt").write_text(prompt, encoding="utf-8")

        client = anthropic.Anthropic(max_retries=5)
        for round_no in range(1, MAX_ROUNDS + 1):
            requests = {cid: build_request(cid, p) for cid, p in prompts.items()
                        if not romanize_lib.chunk_done(answer_dir / f"{cid}.json")
                        and romanize_lib.attempts(answer_dir / f"{cid}.json") < MAX_ATTEMPTS}
            if not requests:
                break
            log.info("Pre-check round %s: %s requests", round_no, len(requests))
            romanize_lib.wait_after_rate_limit(romanize_lib.run_batch(
                client, requests, {c: [] for c in requests}, job_path, answer_dir, save=save_answer))

    results, usages, missing = [], [], []
    for s in sample:
        path = answer_dir / f"{custom_id(s)}.json"
        record = read_json(path) if path.exists() else None
        if record:
            usages += [*record.get("earlier_usage", []), record["usage"]]
        if not record or not record["complete"]:
            missing.append(custom_id(s))
            continue
        results.append(s | {"verdict": record["verdict"], "reason": record["reason"]})
    report(sample, results, usages, missing)
    if missing:
        log.error("%s items have no usable answer yet (%s); rerun to retry", len(missing), ", ".join(missing[:5]))
        return

    write_json(REVIEW_DIR / f"ai_precheck_{run_id}.json",
               {"run_id": run_id, "model": MODEL, "effort": EFFORT, "items": results,
                "usage": {k: sum(u[k] for u in usages) for k in ("input_tokens", "output_tokens")},
                "cost_usd": round(cost(usages), 4)})
    fast_path = REVIEW_DIR / f"fast_review_{run_id}.json"
    if fast_path.exists():
        fast = read_json(fast_path)
        log.info("Fast-review set already drawn; kept as it is (%s)", fast_path.relative_to(ROOT))
    else:
        flagged = [{"table": r["table"], "id": r["id"]} for r in results if r["verdict"] != "supported"]
        supported = [{"table": r["table"], "id": r["id"]} for r in results if r["verdict"] == "supported"]
        picked = random.Random(FAST_SEED).sample(supported, min(FAST_RANDOM_SIZE, len(supported)))
        fast = {"run_id": run_id, "seed": FAST_SEED, "flagged": flagged,
                "random_supported": sorted(picked, key=lambda k: (k["table"], k["id"])),
                "supported_total": len(supported)}
        write_json(fast_path, fast)
    print(f"\nItems to review in Fast review: {len(fast['flagged'])} flagged + "
          f"{len(fast['random_supported'])} random supported = "
          f"{len(fast['flagged']) + len(fast['random_supported'])} (of {len(sample)} in the sample)")


def report(sample: list[dict], results: list[dict], usages: list[dict], missing: list[str]) -> None:
    print(f"\n=== AI pre-check ({MODEL}, effort {EFFORT}, Batch API) ===")
    print(f"Answered: {len(results)} of {len(sample)}" + (f" ({len(missing)} missing)" if missing else ""))
    total = Counter(r["verdict"] for r in results)
    print("Overall: " + ", ".join(f"{v} {total[v]}" for v in VERDICTS))
    print(f"\n{'Type':<14}" + "".join(f"{v:>15}" for v in VERDICTS))
    for kind in dict.fromkeys(s["type"] for s in sample):
        counts = Counter(r["verdict"] for r in results if r["type"] == kind)
        print(f"{kind:<14}" + "".join(f"{counts[v]:>15}" for v in VERDICTS))
    tokens = {k: sum(u[k] for u in usages) for k in ("input_tokens", "output_tokens")}
    print(f"\nTokens: {tokens['input_tokens']:,} in / {tokens['output_tokens']:,} out "
          f"({len(usages)} paid requests); cost ${cost(usages):.2f}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--run-id", default=DEFAULT_RUN_ID)
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    load_dotenv(ROOT / ".env")
    run(args.run_id)


if __name__ == "__main__":
    main()
