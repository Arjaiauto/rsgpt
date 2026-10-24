"""Try the hybrid search over chunks on a fixed set of test questions.

For each question: embed it with Voyage voyage-4 (512 dimensions, input_type query, the
same Atlas endpoint as 09_build_chunks.py), call public.hybrid_search (pipeline/sql/
hybrid_search.sql) through .rpc, and print the top TOP_N chunks with the episode title,
date, start time, a YouTube link at that second, the RRF score and the first
PREVIEW_CHARS characters of the chunk's transcript (after its header line, which only
repeats the title, date and guest shown above it). No Claude calls.

The output is also saved to data/search_test.md. Read-only on the database. Every
question is embedded in one Voyage request; network errors, rate limits and server
errors are retried.

Usage:
    .venv\\Scripts\\python.exe pipeline\\11_search_test.py
"""

import importlib.util
import logging
import sys
import time
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "data" / "search_test.md"
TOP_N = 5
PREVIEW_CHARS = 150
QUERY_INPUT_TYPE = "query"
QUESTIONS = [
    "What have founders on the show said about raising their first round?",
    "Raj ka AI ke baare mein kya opinion hai?",
    "Which guests talked about building a D2C brand in India?",
    "What did guests say about mistakes in their twenties?",
    "What is the capital of Australia?",
    "How has Raj's view on investing changed over the years?",
    "kaun se guests ne health aur sleep pe baat ki?",
    "What do guests recommend reading?",
    "Which episode talks about quantum computing in agriculture?",
    "What does Raj usually ask at the start of an episode?",
]

log = logging.getLogger("search_test")


def load_module(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


chunks = load_module("build_chunks", "09_build_chunks.py")
cap = chunks.cap


def mm_ss(seconds: float) -> str:
    s = int(seconds)
    return f"{s // 60}:{s % 60:02d}"


def preview(text: str) -> str:
    body = text.split("\n", 1)[1] if "\n" in text else text
    body = " ".join(body.split())
    return body if len(body) <= PREVIEW_CHARS else body[:PREVIEW_CHARS] + "…"


def search(db, embedding: list[float], question: str) -> list[dict]:
    return cap.db_call("hybrid_search", lambda: db.rpc("hybrid_search", {
        "query_embedding": embedding, "query_text": question, "match_count": TOP_N}).execute()).data


def titles(db, vids: set[str]) -> dict[str, str]:
    rows = cap.db_call("episodes select", lambda: db.table("episodes").select("video_id,title")
                       .in_("video_id", sorted(vids)).execute()).data
    return {r["video_id"]: r["title"] for r in rows}


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    load_dotenv(ROOT / ".env")
    db = cap.supabase_client()
    vo = chunks.voyage_client()
    result = chunks.embed(vo, QUESTIONS, input_type=QUERY_INPUT_TYPE)
    log.info("Embedded %s questions: %s tokens, $%.6f at list price", len(QUESTIONS), result.total_tokens,
             chunks.usd(result.total_tokens))

    hits = []
    for question, embedding in zip(QUESTIONS, result.embeddings):
        started = time.monotonic()
        rows = search(db, embedding, question)
        hits.append((question, rows, time.monotonic() - started))
    names = titles(db, {r["video_id"] for _, rows, _ in hits for r in rows})

    out = ["# Search test", "",
           "*RSGPT. Unofficial project, not affiliated with Figuring Out.*",
           f"Written {time.strftime('%Y-%m-%d %H:%M')} by `pipeline/11_search_test.py`: public.hybrid_search "
           f"(vector + full text, RRF k = 60), top {TOP_N} per question. Score = sum of 1 / (60 + rank) over the "
           "two sides, so about 0.033 is first on both and 0.016 first on one only.", ""]
    for n, (question, rows, seconds) in enumerate(hits, 1):
        out += [f"## {n}. {question}", "", f"*{len(rows)} results, {seconds:.2f} s*", ""]
        if not rows:
            out += ["No results.", ""]
        for rank, r in enumerate(rows, 1):
            date = (r["published_at"] or "")[:10]
            link = f"https://youtu.be/{r['video_id']}?t={int(r['start_s'])}"
            out += [f"{rank}. **{names.get(r['video_id'], r['video_id'])}** ({date}) at {mm_ss(r['start_s'])}, "
                    f"score {r['score']:.4f}  ", f"   {link}  ", f"   {preview(r['text'])}", ""]
    text = "\n".join(out) + "\n"
    print(text)
    OUTPUT.write_text(text, encoding="utf-8")
    log.info("Saved %s", OUTPUT)


if __name__ == "__main__":
    main()
