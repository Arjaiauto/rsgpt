"""Build retrieval chunks of every transcribed episode, embed them with Voyage AI and write them to chunks.

Chunks: an episode's segments, in order, grouped into chunks of about CHUNK_SECONDS
with OVERLAP_SECONDS of overlap. A segment is never split: a chunk takes every segment
that starts within CHUNK_SECONDS of its first one, and the next chunk starts at the
latest segment that repeats at least OVERLAP_SECONDS of it. A tail shorter than
MIN_TAIL_SECONDS is added to the last chunk instead of becoming a chunk of its own.

Chunk text, so a chunk can be found by English, Hinglish or Hindi questions:
    Episode: <title> | <date> | Guest: <verified guest names, if any>
    Raj: <text_roman of a turn>       (flagged lines keep their Devanagari)
    Guest: <text_roman of a turn>
    English:                          (Hindi episodes only)
    Raj: <the matching translation lines of the turn>
    ...
A turn is a run of consecutive segments with the same segments.speaker (raj / guest),
joined into one line; a turn whose speaker is unknown has no label. Guest names are the verified guests of the extraction v5 run.

Embeddings: voyage-4, output_dimension 512, input_type document, through the Atlas
Embedding and Reranking API (https://ai.mongodb.com/v1, the endpoint for a model API
key from MongoDB Atlas), in requests of at most BATCH_MAX_TEXTS texts and
BATCH_MAX_TOKENS tokens. Tokens are counted locally with the voyage-4 tokenizer for
the estimate and the cost guard; the cost actually charged is from each answer's usage.

Resumable: each episode's chunks and embeddings are saved to data/chunks/<video_id>.json
as answers arrive, and an episode whose rows are written is skipped. An embedding is
reused while its chunk text is unchanged. An episode's rows are replaced as a whole
(delete, then insert), so a half-finished write is redone. Network errors, rate limits
and server errors are retried.

Cost guard: before each request, this run's cost so far plus the request's is compared
with --max-usd; past it, the run writes the finished episodes and stops.

Writing: rows go in INSERT_ROWS at a time. A batch cancelled by the statement timeout
(57014) is retried split in half, down to single rows, before the run fails.
Before writing, every real run checks the rows already in the database against the
saved files: an episode whose rows are not exactly its saved chunks (count, times,
text, an embedding on each), or that has rows but is not marked written (a write cut
off part way), has its rows deleted and is written again. --clean-only does just that.

--bulk, for loading many episodes: updating the HNSW index on every insert is what
makes inserts time out. The run prints the SQL to drop the index and waits for Enter
while you run it in the Supabase SQL Editor; once every episode is written it prints
the SQL to build the index again (same definition as schema.sql).

Usage:
    .venv\\Scripts\\python.exe pipeline\\09_build_chunks.py [--dry-run] [--max-usd 5] [--bulk]
    .venv\\Scripts\\python.exe pipeline\\09_build_chunks.py --clean-only
"""

import argparse
import hashlib
import importlib.util
import json
import logging
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import voyageai
import voyageai.error
from dotenv import load_dotenv
from postgrest.exceptions import APIError
from postgrest.types import ReturnMethod

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
CHUNKS_DIR = DATA_DIR / "chunks"
LOGS_DIR = DATA_DIR / "logs"
RUN_ID_PATH = DATA_DIR / "extractions" / "haiku" / "v5" / "run_id.txt"  # guests come from this run

CHUNK_SECONDS = 90
OVERLAP_SECONDS = 15
MIN_TAIL_SECONDS = 30
SPEAKER_LABELS = {"raj": "Raj", "guest": "Guest"}

VOYAGE_BASE_URL = "https://ai.mongodb.com/v1"  # Atlas Embedding and Reranking API
VOYAGE_MODEL = "voyage-4"
OUTPUT_DIMENSION = 512
INPUT_TYPE = "document"
DOCUMENT_PROMPT = "Represent the document for retrieval: "  # prepended by the API for input_type document
USD_PER_MTOK = 0.06  # voyage-4 list price (MongoDB Atlas model pricing, checked 2026-10-25); 200M free tokens
MAX_USD = 5.0
BATCH_MAX_TEXTS = 128  # API limit 1,000
BATCH_MAX_TOKENS = 100_000  # API limit 320,000 for voyage-4; local counts can differ slightly from the API's
VOYAGE_RETRIES = 6

DB_PAGE = 1000
INSERT_ROWS = 50  # a row carries a 512-float vector and updates two indexes, so keep inserts small
STATEMENT_TIMEOUT = "57014"
HNSW_INDEX = "chunks_embedding_idx"  # as named in schema.sql
INDEX_QUERY_SQL = ("select indexname, indexdef from pg_indexes\n"
                   "where schemaname = 'public' and tablename = 'chunks';")
DROP_INDEX_SQL = f"drop index if exists public.{HNSW_INDEX};"
CREATE_INDEX_SQL = ("set maintenance_work_mem = '256MB';\n"
                    "set statement_timeout = '30min';\n"
                    f"create index if not exists {HNSW_INDEX} on public.chunks\n"
                    "    using hnsw (embedding extensions.vector_cosine_ops);")
LOAD_THREADS = 8
# Database size estimate per chunk row: a vector(512) is 4 bytes x 512 + 8, stored uncompressed;
# the HNSW index holds a copy of each vector plus its graph links; plus row and b-tree overhead.
# The text, its tsvector and the tsvector's GIN index are taken as these multiples of the
# text's bytes, (low, high): low if Postgres compresses the text and tsvector well, high if not.
VECTOR_BYTES = 4 * OUTPUT_DIMENSION + 8
HNSW_LINK_BYTES = 2 * 16 * 8
ROW_OVERHEAD_BYTES = 120
TEXT_FACTORS = (0.5 + 0.6 + 0.3, 1.0 + 1.2 + 0.6)

log = logging.getLogger("chunks")


class CostCapReached(Exception):
    pass


def load_module(name: str, filename: str):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


cap = load_module("captions", "05_captions.py")


# ---------- reading ----------

def fetch_all(db, table: str, columns: str, query=None, order: str = "id") -> list[dict]:
    rows, start = [], 0
    while True:
        q = db.table(table).select(columns)
        if query:
            q = query(q)
        page = cap.db_call(f"{table} select", lambda: q.order(order).range(start, start + DB_PAGE - 1)
                           .execute()).data
        rows += page
        if len(page) < DB_PAGE:
            return rows
        start += DB_PAGE


def transcribed_episodes(db) -> list[dict]:
    return fetch_all(db, "episodes", "video_id,title,published_at,caption_language",
                     lambda q: q.eq("status", "transcribed"), order="video_id")


def verified_guests(db) -> dict[str, list[str]]:
    """Verified guest names per episode from the extraction v5 run, in table order, without repeats."""
    run_id = RUN_ID_PATH.read_text(encoding="utf-8").strip()
    names: dict[str, list[str]] = {}
    for g in fetch_all(db, "guests", "video_id,name", lambda q: q.eq("run_id", run_id).eq("verified", True)):
        if g["name"].strip() and g["name"].strip() not in names.setdefault(g["video_id"], []):
            names[g["video_id"]].append(g["name"].strip())
    return names


def episode_lines(db, ep: dict) -> list[dict]:
    """The episode's segments in order, each with its English translation line when the episode is Hindi."""
    vid = ep["video_id"]
    segments = fetch_all(db, "segments", "id,seq,start_s,end_s,speaker,text_roman", lambda q: q.eq("video_id", vid),
                         order="seq")
    translations = []
    if ep["caption_language"] == "hi":
        translations = fetch_all(db, "translation_segments", "id,start_s,end_s,text", lambda q: q.eq("video_id", vid))
        if not translations:
            log.warning("%s: Hindi episode with no translation lines", vid)
        elif len(translations) != len(segments):
            log.warning("%s: %s translation lines for %s segments; matching them by start time", vid,
                        len(translations), len(segments))
    by_start = {round(t["start_s"], 2): t for t in translations}
    lines = []
    for i, s in enumerate(segments):
        t = translations[i] if len(translations) == len(segments) else by_start.get(round(s["start_s"], 2))
        lines.append({"start": s["start_s"], "end": s["end_s"], "speaker": s["speaker"],
                      "text": s["text_roman"].strip(), "english": t["text"].strip() if t else ""})
    return lines


# ---------- chunks ----------

def chunk_spans(lines: list[dict]) -> list[tuple[int, int]]:
    """(first, last) line indexes of each chunk, inclusive."""
    spans, i, n = [], 0, len(lines)
    while i < n:
        e = i
        while e + 1 < n and lines[e + 1]["start"] < lines[i]["start"] + CHUNK_SECONDS:
            e += 1
        if e + 1 < n and lines[-1]["end"] - lines[e + 1]["start"] < MIN_TAIL_SECONDS:
            e = n - 1  # a short tail joins this chunk
        spans.append((i, e))
        if e == n - 1:
            break
        # The next chunk starts at the latest segment that gives at least OVERLAP_SECONDS of overlap.
        starts = [k for k in range(i + 1, e + 1) if lines[k]["start"] <= lines[e]["end"] - OVERLAP_SECONDS]
        i = starts[-1] if starts else i + 1
    return spans


def turns(lines: list[dict], field: str) -> list[str]:
    """One line per speaker turn: consecutive lines of the same speaker joined, labelled Raj or Guest."""
    out, prev = [], None
    for l in lines:
        if not l[field]:
            continue
        if out and l["speaker"] == prev:
            out[-1] += " " + l[field]
        else:
            label = SPEAKER_LABELS.get(l["speaker"])
            out.append(f"{label}: {l[field]}" if label else l[field])
            prev = l["speaker"]
    return out


def header(ep: dict, guests: list[str]) -> str:
    parts = [f"Episode: {ep['title']}"]
    if ep.get("published_at"):
        parts.append(ep["published_at"][:10])
    if guests:
        parts.append("Guest: " + ", ".join(guests))
    return " | ".join(parts)


def build_chunks(ep: dict, lines: list[dict], guests: list[str]) -> list[dict]:
    head = header(ep, guests)
    chunks = []
    for lo, hi in chunk_spans(lines):
        part = lines[lo:hi + 1]
        body, english = turns(part, "text"), turns(part, "english")
        text = "\n".join([head, *body, *(["English:", *english] if english else [])])
        chunks.append({"start_s": part[0]["start"], "end_s": part[-1]["end"], "text": text,
                       "sha": hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]})
    return chunks


# ---------- saved state ----------

def chunk_file(vid: str) -> Path:
    return CHUNKS_DIR / f"{vid}.json"


def load_saved(vid: str) -> dict | None:
    path = chunk_file(vid)
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else None


def save(record: dict) -> None:
    path = chunk_file(record["video_id"])
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


def episode_record(ep: dict, chunks: list[dict], saved: dict | None) -> dict:
    """A fresh record for the episode's chunks, keeping embeddings of chunks whose text is unchanged."""
    old = {c["sha"]: c["embedding"] for c in (saved or {}).get("chunks", []) if c.get("embedding")}
    for c in chunks:
        if c["sha"] in old:
            c["embedding"] = old[c["sha"]]
    return {"video_id": ep["video_id"], "published_at": ep.get("published_at"), "chunks": chunks,
            "usage_tokens": (saved or {}).get("usage_tokens", 0), "db_written": False}


# ---------- Voyage ----------

def voyage_client() -> voyageai.Client:
    key = os.environ.get("VOYAGE_API_KEY")
    if not key:
        sys.exit("VOYAGE_API_KEY must be set in .env")
    return voyageai.Client(api_key=key, base_url=VOYAGE_BASE_URL, max_retries=0, timeout=120)


def count_tokens(texts: list[str]) -> list[int]:
    """voyage-4 tokens per text, counted locally, including the input_type document prompt."""
    from tokenizers import Tokenizer  # installed with voyageai; the tokenizer is fetched from Hugging Face once
    tok = Tokenizer.from_pretrained(f"voyageai/{VOYAGE_MODEL}")
    tok.no_truncation()
    return [len(e.ids) for e in tok.encode_batch([DOCUMENT_PROMPT + t for t in texts])]


def embed(vo: voyageai.Client, texts: list[str]):
    for attempt in range(1, VOYAGE_RETRIES + 1):
        try:
            return vo.embed(texts, model=VOYAGE_MODEL, input_type=INPUT_TYPE, truncation=False,
                            output_dimension=OUTPUT_DIMENSION)
        except (voyageai.error.RateLimitError, voyageai.error.ServiceUnavailableError, voyageai.error.ServerError,
                voyageai.error.APIConnectionError, voyageai.error.Timeout, voyageai.error.TryAgain) as exc:
            if attempt == VOYAGE_RETRIES:
                raise
            wait = 10 * 2 ** (attempt - 1)
            log.warning("Voyage %s, retrying in %ss (attempt %s of %s)", type(exc).__name__, wait, attempt,
                        VOYAGE_RETRIES)
            time.sleep(wait)
    raise AssertionError("unreachable")


def batches(pending: list[tuple[dict, dict]]) -> list[list[tuple[dict, dict]]]:
    """Requests of at most BATCH_MAX_TEXTS chunks and BATCH_MAX_TOKENS tokens, in order."""
    out, cur, cur_tokens = [], [], 0
    for item in pending:
        tokens = item[1]["tokens"]
        if cur and (len(cur) == BATCH_MAX_TEXTS or cur_tokens + tokens > BATCH_MAX_TOKENS):
            out.append(cur)
            cur, cur_tokens = [], 0
        cur.append(item)
        cur_tokens += tokens
    return out + ([cur] if cur else [])


def usd(tokens: int) -> float:
    return tokens * USD_PER_MTOK / 1e6


# ---------- writing ----------

def insert_rows(db, rows: list[dict]) -> None:
    """Insert rows; a batch cancelled by the statement timeout is retried in halves, down to single rows.
    A cancelled statement is rolled back, so nothing of it is left behind."""
    try:
        cap.db_call("chunks insert", lambda: db.table("chunks").insert(rows, returning=ReturnMethod.minimal).execute())
    except APIError as exc:
        if exc.code != STATEMENT_TIMEOUT or len(rows) == 1:
            raise
        half = len(rows) // 2
        log.warning("%s: statement timeout inserting %s rows, retrying as %s + %s", rows[0]["video_id"], len(rows),
                    half, len(rows) - half)
        insert_rows(db, rows[:half])
        insert_rows(db, rows[half:])


def write_rows(db, record: dict) -> None:
    rows = [{"video_id": record["video_id"], "start_s": c["start_s"], "end_s": c["end_s"], "text": c["text"],
             "published_at": record["published_at"], "embedding": c["embedding"]} for c in record["chunks"]]
    vid = record["video_id"]
    cap.db_call("chunks delete", lambda: db.table("chunks").delete().eq("video_id", vid).execute())
    for i in range(0, len(rows), INSERT_ROWS):
        insert_rows(db, rows[i:i + INSERT_ROWS])
    record["db_written"] = True
    save(record)


def row_key(start_s: float, end_s: float, text: str) -> tuple:
    return round(start_s, 3), round(end_s, 3), text


def clean_partial(db, vids: list[str]) -> tuple[int, int]:
    """Delete the rows of every episode whose rows are not exactly its saved, written chunks, and mark it
    not written so it is written again. Returns (episodes cleaned, rows deleted)."""
    rows = fetch_all(db, "chunks", "id,video_id,start_s,end_s,text")
    no_embedding = {r["id"] for r in fetch_all(db, "chunks", "id", lambda q: q.is_("embedding", "null"))}
    in_db: dict[str, list] = {}
    for r in rows:
        in_db.setdefault(r["video_id"], []).append(r)
    cleaned = deleted = 0
    for vid in sorted(in_db):
        saved = load_saved(vid) if vid in vids else None
        have = sorted(row_key(r["start_s"], r["end_s"], r["text"]) for r in in_db[vid])
        want = sorted(row_key(c["start_s"], c["end_s"], c["text"]) for c in saved["chunks"]) if saved else None
        if saved and saved["db_written"] and have == want and not any(r["id"] in no_embedding for r in in_db[vid]):
            continue
        why = ("not a transcribed episode with a saved file" if not saved else "not marked written" if
               not saved["db_written"] else f"{len(have)} rows for {len(want)} saved chunks" if len(have) != len(want)
               else "rows without an embedding" if any(r["id"] in no_embedding for r in in_db[vid])
               else "times or text differ from the saved chunks")
        log.info("%s: %s, deleting its %s rows", vid, why, len(in_db[vid]))
        cap.db_call("chunks delete", lambda: db.table("chunks").delete().eq("video_id", vid).execute())
        if saved:
            saved["db_written"] = False
            save(saved)
        cleaned += 1
        deleted += len(in_db[vid])
    for vid in vids:  # marked written but no rows at all
        saved = load_saved(vid)
        if saved and saved["db_written"] and vid not in in_db:
            log.info("%s: marked written but has no rows; it will be written again", vid)
            saved["db_written"] = False
            save(saved)
            cleaned += 1
    log.info("Check of rows already written: %s rows in %s episodes; cleaned %s episodes, deleted %s rows",
             len(rows), len(in_db), cleaned, deleted)
    return cleaned, deleted


def wait_for_drop() -> None:
    print("\n--bulk: before inserting, drop the HNSW index in the Supabase SQL Editor.")
    print("Check its name and definition first:\n\n" + INDEX_QUERY_SQL + "\n\nThen drop it:\n\n" + DROP_INDEX_SQL)
    print("\nIf the index has another name, drop that one instead. Press Enter once it is dropped.")
    input()


def print_create_index() -> None:
    print("\nEvery episode is written. Build the HNSW index again in the Supabase SQL Editor:\n\n"
          + CREATE_INDEX_SQL + "\n\nThen check it with:\n\n" + INDEX_QUERY_SQL + "\n")


# ---------- run ----------

def load_all(episodes: list[dict]) -> dict[str, list[dict]]:
    """Lines of each episode, read with LOAD_THREADS threads, each with its own database client."""
    local = threading.local()

    def one(ep):
        if not hasattr(local, "db"):
            local.db = cap.supabase_client()
        return ep["video_id"], episode_lines(local.db, ep)

    lines_of, done = {}, 0
    with ThreadPoolExecutor(LOAD_THREADS) as pool:
        for vid, lines in pool.map(one, episodes):
            lines_of[vid] = lines
            done += 1
            if done % 50 == 0 or done == len(episodes):
                log.info("Read segments of %s/%s episodes", done, len(episodes))
    return lines_of


def db_size_bytes(chunks: list[dict]) -> tuple[float, float]:
    """(low, high) estimate of the database space the chunks take, indexes included."""
    fixed = len(chunks) * (VECTOR_BYTES * 2 + HNSW_LINK_BYTES + ROW_OVERHEAD_BYTES)
    text_bytes = sum(len(c["text"].encode("utf-8")) for c in chunks)
    return fixed + text_bytes * TEXT_FACTORS[0], fixed + text_bytes * TEXT_FACTORS[1]


def run(max_usd: float, dry_run: bool, bulk: bool = False, clean_only: bool = False) -> None:
    db = cap.supabase_client()
    episodes = transcribed_episodes(db)
    if not dry_run:
        clean_partial(db, [ep["video_id"] for ep in episodes])
        if clean_only:
            return
    saved = {ep["video_id"]: load_saved(ep["video_id"]) for ep in episodes}
    todo = [ep for ep in episodes if not (saved[ep["video_id"]] or {}).get("db_written")]
    log.info("%s transcribed episodes, %s with chunks written, %s to do", len(episodes), len(episodes) - len(todo),
             len(todo))
    if not todo:
        if bulk:
            print_create_index()
        return
    guests = verified_guests(db)
    lines_of = load_all(todo)
    records = {}
    for ep in todo:
        vid = ep["video_id"]
        if not lines_of[vid]:
            log.warning("%s: no segments, skipped", vid)
            continue
        records[vid] = episode_record(ep, build_chunks(ep, lines_of[vid], guests.get(vid, [])), saved[vid])
    all_chunks = [c for r in records.values() for c in r["chunks"]]
    for c, n in zip(all_chunks, count_tokens([c["text"] for c in all_chunks])):
        c["tokens"] = n
    pending = [(r, c) for r in records.values() for c in r["chunks"] if not c.get("embedding")]
    if dry_run:
        print_dry_run(episodes, todo, records, guests, pending, max_usd)
        return

    CHUNKS_DIR.mkdir(parents=True, exist_ok=True)
    for r in records.values():
        save(r)
    if bulk:
        wait_for_drop()
    vo = voyage_client()
    spent_tokens, written, started = 0, 0, time.monotonic()

    def write_finished():
        nonlocal written
        for r in records.values():
            if not r["db_written"] and all(c.get("embedding") for c in r["chunks"]):
                write_rows(db, r)
                written += 1

    reqs = batches(pending)
    log.info("%s chunks to embed in %s requests (%s tokens counted locally, about $%.4f)", len(pending), len(reqs),
             f"{sum(c['tokens'] for _, c in pending):,}", usd(sum(c["tokens"] for _, c in pending)))
    try:
        for n, req in enumerate(reqs, 1):
            req_tokens = sum(c["tokens"] for _, c in req)
            if usd(spent_tokens + req_tokens) > max_usd:
                raise CostCapReached(f"request {n} would take this run to ${usd(spent_tokens + req_tokens):.4f}, "
                                     f"past the cap of ${max_usd:.2f}")
            result = embed(vo, [c["text"] for _, c in req])
            if len(result.embeddings) != len(req) or any(len(e) != OUTPUT_DIMENSION for e in result.embeddings):
                raise RuntimeError(f"request {n}: unexpected answer shape ({len(result.embeddings)} embeddings "
                                   f"for {len(req)} texts)")
            spent_tokens += result.total_tokens
            touched = {}
            for (r, c), emb in zip(req, result.embeddings):
                c["embedding"] = emb
                touched[r["video_id"]] = r
            share = result.total_tokens / len(touched)
            for r in touched.values():
                r["usage_tokens"] += share
                save(r)
            write_finished()
            elapsed = time.monotonic() - started
            log.info("Request %s/%s: %s chunks, %s tokens | run %s tokens, $%.4f | episodes written %s/%s | "
                     "est. left %.1f min", n, len(reqs), len(req), result.total_tokens, f"{spent_tokens:,}",
                     usd(spent_tokens), written, len(records), elapsed / n * (len(reqs) - n) / 60)
        write_finished()  # episodes whose embeddings were all saved by an earlier run
    except CostCapReached as exc:
        write_finished()
        log.error("Cost guard: %s. Stopped; %s episodes written. Rerun with a higher --max-usd to continue.",
                  exc, written)
        if bulk:
            log.error("The HNSW index is still dropped: finish the run with --bulk, then build it again.")
        return
    total_rows = sum(len(r["chunks"]) for r in records.values() if r["db_written"])
    log.info("Done: %s episodes, %s chunk rows written; this run %s tokens, $%.4f at list price", written,
             total_rows, f"{spent_tokens:,}", usd(spent_tokens))
    if bulk and all(r["db_written"] for r in records.values()):
        print_create_index()


def print_dry_run(episodes, todo, records, guests, pending, max_usd) -> None:
    chunks = [c for r in records.values() for c in r["chunks"]]
    tokens = [c["tokens"] for c in chunks]
    pend_tokens = sum(c["tokens"] for _, c in pending)
    seconds = [c["end_s"] - c["start_s"] for c in chunks]
    hindi = [r for r in records.values() if any("\nEnglish:\n" in c["text"] for c in r["chunks"])]
    low, high = db_size_bytes(chunks)
    print()
    print("Dry run: nothing is sent to Voyage and nothing is written.")
    print(f"  Episodes: {len(episodes)} transcribed, {len(todo)} to do, {len(records)} with segments "
          f"({len(hindi)} with English lines), {sum(1 for v in records if guests.get(v))} with a verified guest")
    print(f"  Chunks: {len(chunks):,} (about {CHUNK_SECONDS}s with {OVERLAP_SECONDS}s overlap); "
          f"length {min(seconds):.0f}-{max(seconds):.0f}s, mean {sum(seconds) / len(seconds):.0f}s")
    print(f"  Tokens (voyage-4 tokenizer, with the document prompt): {sum(tokens):,} in all, "
          f"{pend_tokens:,} still to embed; per chunk mean {sum(tokens) / len(tokens):.0f}, max {max(tokens):,}")
    print(f"  Requests: {len(batches(pending))} (at most {BATCH_MAX_TEXTS} chunks and {BATCH_MAX_TOKENS:,} tokens each)")
    print(f"  Estimated cost: ${usd(pend_tokens):.4f} at ${USD_PER_MTOK}/M tokens (list price; voyage-4 has "
          f"200M free tokens, so likely $0 if unused); cost guard ${max_usd:.2f}")
    print(f"  Estimated database size added: about {low / 1e6:.0f}-{high / 1e6:.0f} MB (rows with text, vector and "
          f"tsvector, plus HNSW, GIN and b-tree indexes; text {sum(len(c['text'].encode('utf-8')) for c in chunks) / 1e6:.0f}"
          f" MB, vectors {len(chunks) * VECTOR_BYTES / 1e6:.0f} MB before indexes)")
    longest = max(chunks, key=lambda c: c["tokens"])
    print("\nSample chunk (first of the first episode to do):")
    print(next(iter(records.values()))["chunks"][0]["text"][:1500])
    print(f"\nLongest chunk: {longest['tokens']:,} tokens, {longest['end_s'] - longest['start_s']:.0f}s")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--max-usd", type=float, default=MAX_USD,
                        help=f"stop before this run could spend more (default {MAX_USD})")
    parser.add_argument("--bulk", action="store_true",
                        help="bulk load: wait while you drop the HNSW index, print the SQL to build it at the end")
    parser.add_argument("--clean-only", action="store_true",
                        help="only delete the rows of episodes whose rows do not match their saved chunks")
    parser.add_argument("--dry-run", action="store_true",
                        help="print the chunk count, tokens, estimated cost and database size; send and write nothing")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    LOGS_DIR.mkdir(parents=True, exist_ok=True)
    log_path = LOGS_DIR / f"chunks_{time.strftime('%Y%m%d-%H%M%S')}.log"
    log_file = log_path.open("a", encoding="utf-8")
    sys.stdout, sys.stderr = cap.Tee(sys.stdout, log_file), cap.Tee(sys.stderr, log_file)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
    log.info("Console output is also written to %s", log_path)
    load_dotenv(ROOT / ".env")
    run(args.max_usd, args.dry_run, args.bulk, args.clean_only)


if __name__ == "__main__":
    main()
