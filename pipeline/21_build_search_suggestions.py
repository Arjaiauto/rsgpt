"""Fill public.search_suggestions: what the search box suggests while someone types (Ticket 27).

Kinds (one row each, identified by kind + ref):
  guest    each verified guest (merged guest_key, as the Guests page): ref = guest slug, weight = views of their episodes.
           Aliases: the other names the guest was extracted under, the name without Dr./Prof./Lt Col ..., and a
           Devanagari spelling.
  topic    sector tags that three or more guests have: ref = lower-case tag, weight = number of guests.
  episode  transcribed episodes: ref = video_id, weight = views. Aliases: the FO number ("fo547", "fo 547").
  clip     verified clips of the archive run: ref = clip id, text = the clip's title, weight = its score.
  term     the curated vocabulary below (words people search for that are not a guest, topic or title), weighted by how
           many passages contain them (public.chunk_terms).
Devanagari aliases for guests, topics and terms come from a rule-based Roman-to-Devanagari converter (approximate, so
people who type in Devanagari find them). --aliases adds a one-off Haiku batch that writes better ones, and Hinglish
spellings, for the top terms: all terms and topics and the 300 guests with the most views.

Reads through Supabase REST; writes only to public.search_suggestions (create it first: pipeline/sql/search_v2.sql).

    .venv\\Scripts\\python pipeline\\21_build_search_suggestions.py --dry-run              counts and samples, writes nothing
    .venv\\Scripts\\python pipeline\\21_build_search_suggestions.py                        write what changed (and remove what is gone)
    .venv\\Scripts\\python pipeline\\21_build_search_suggestions.py --aliases --dry-run    also print the Haiku batch's estimated cost
    .venv\\Scripts\\python pipeline\\21_build_search_suggestions.py --aliases              send the batch (Batch API), collect, write

Safe to rerun at any time: rows that did not change are skipped, nothing is duplicated (kind + ref is unique), and rows
whose guest, topic, episode or clip no longer exists are removed (--no-prune keeps them). The Haiku answers are saved
under data/search_suggestions/aliases/ as they arrive and merged into every later run, so a batch is paid for once; an
interrupted batch is resumed from data/search_suggestions/aliases_job.json. Network errors are retried (db_lib, and the
Anthropic client's own retries).
"""

import argparse
import hashlib
import json
import logging
import re
import sys
import time
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
import corrections_lib  # noqa: E402
import db_lib  # noqa: E402

log = logging.getLogger("suggestions")

RUN_ID_PATH = ROOT / "data" / "extractions" / "haiku" / "v5" / "run_id.txt"
OUT_DIR = ROOT / "data" / "search_suggestions"
ALIAS_DIR = OUT_DIR / "aliases"
JOB_PATH = OUT_DIR / "aliases_job.json"
TABLE = "search_suggestions"
KINDS = ("guest", "topic", "episode", "clip", "term")
WRITE_BATCH = 500
MIN_GUESTS_PER_TOPIC = 3

# Haiku alias batch
MODEL = "claude-haiku-5-5"
PRICE_IN, PRICE_OUT = 0.05, 0.25      # USD per million tokens, Batch API (same as 06_extract.py)
ITEMS_PER_REQUEST = 80
TOP_GUESTS = 300
MAX_TOKENS = 8000
POLL_SECONDS = 30
EST_CHARS_PER_TOKEN = 3.5             # Latin text; the prompt and the item list
EST_OUT_TOKENS_PER_ITEM = 70          # 1-3 Devanagari spellings (about 4 tokens a character group) + 0-3 Latin ones, as JSON
DEFAULT_MAX_USD = 1.0

SYSTEM_PROMPT = """You help the search box of a podcast archive (a Hindi, Hinglish and English interview show about Indian business, startups, careers and culture). For each item, say how people would TYPE it.
- devanagari: 1 to 3 spellings in Devanagari script as a Hindi speaker would type the item: an English word in its usual Hindi spelling (startup -> स्टार्टअप), a person's or company's name as it is pronounced.
- roman: 0 to 3 other Latin spellings, Hinglish forms or very common misspellings, different from the text you are given.
Give only spellings you are confident real people use. Never invent words. Return every id exactly as given."""
OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {"items": {"type": "array", "items": {
        "type": "object",
        "properties": {"id": {"type": "string"}, "devanagari": {"type": "array", "items": {"type": "string"}},
                       "roman": {"type": "array", "items": {"type": "string"}}},
        "required": ["id", "devanagari", "roman"], "additionalProperties": False}}},
    "required": ["items"], "additionalProperties": False,
}

# ---------- curated vocabulary: (term, other spellings) ----------
CURATED_TERMS: list[tuple[str, list[str]]] = [
    ("startup", ["startups"]), ("funding", ["fundraising", "raise money"]), ("venture capital", ["VC", "vc funding"]),
    ("IPO", ["initial public offering"]), ("stock market", ["share market", "stocks"]), ("mutual funds", ["SIP"]),
    ("investing", ["investment", "investor"]), ("real estate", ["property"]), ("personal finance", ["money management"]),
    ("cricket", ["IPL"]), ("bollywood", ["hindi cinema", "film industry"]), ("mental health", ["anxiety", "depression"]),
    ("artificial intelligence", ["AI", "machine learning"]), ("ChatGPT", ["OpenAI"]), ("D2C", ["direct to consumer"]),
    ("ecommerce", ["e-commerce", "online shopping"]), ("marketing", ["advertising"]), ("branding", ["brand building"]),
    ("content creation", ["creator economy", "content creator"]), ("YouTube", ["youtuber"]), ("podcast", ["podcasting"]),
    ("social media", ["instagram"]), ("leadership", ["leader"]), ("productivity", ["time management"]),
    ("habits", ["discipline"]), ("fitness", ["gym", "workout"]), ("nutrition", ["diet"]), ("meditation", ["mindfulness"]),
    ("spirituality", ["spiritual"]), ("relationships", ["dating"]), ("marriage", ["shaadi"]), ("parenting", ["parents"]),
    ("education", ["school", "college"]), ("UPSC", ["civil services", "IAS"]), ("IIT", ["JEE"]), ("MBA", []),
    ("career", ["jobs"]), ("layoffs", ["job loss"]), ("salary", ["income"]), ("negotiation", []), ("failure", ["failing"]),
    ("success", []), ("motivation", ["inspiration"]), ("crypto", ["bitcoin", "cryptocurrency"]), ("gold", []),
    ("tax", ["income tax"]), ("GST", []), ("UPI", ["digital payments"]), ("banking", ["bank"]), ("insurance", []),
    ("FMCG", ["consumer goods"]), ("manufacturing", ["factory"]), ("exports", ["export"]), ("geopolitics", ["foreign policy"]),
    ("history", []), ("philosophy", []), ("politics", ["elections"]), ("defence", ["army", "military"]),
    ("music", ["singer"]), ("travel", ["tourism"]), ("food", ["restaurant"]), ("sports", ["olympics"]),
    ("law", ["lawyer", "court"]), ("medicine", ["doctor", "healthcare"]), ("space", ["ISRO"]), ("electric vehicles", ["EV"]),
    ("hiring", ["recruitment"]), ("sales", ["selling"]), ("pricing", []), ("negotiating", []), ("remote work", ["work from home"]),
    ("side hustle", ["freelancing"]), ("first job", []), ("first salary", []), ("burnout", []), ("failure story", []),
]

# ---------- text helpers ----------
HONORIFIC = re.compile(r"^(dr|prof|professor|mr|mrs|ms|shri|smt|sri|ca|adv|advocate|lt|col|capt|captain|major|maj|gen|general)\.?\s+", re.I)
DEVANAGARI = re.compile(r"[ऀ-ॿ]")


def fold(text: str) -> str:
    """Lower case, Latin accents out, punctuation and symbols to spaces (letters, marks and digits of every script stay, so
    Devanagari keeps its vowel signs), one space between words. The site's search folds the same way."""
    text = unicodedata.normalize("NFKD", text)
    text = "".join(c for c in text if not 0x300 <= ord(c) <= 0x36F).lower()
    text = "".join(c if unicodedata.category(c)[0] in "LMN" else " " for c in text)
    return " ".join(text.split())


def tag_label(raw: str) -> str:
    """A sector tag for display, as site/lib/guest-format.ts tagLabel: first letter up unless a name like iPhone."""
    return raw if re.match(r"^[a-z]\S*[A-Z]", raw) else raw[:1].upper() + raw[1:]


def guest_slug(key: str) -> str:
    """site/lib/guest-slug.ts guestSlug: lower case, repeated dashes collapsed, leading and trailing dashes trimmed."""
    return re.sub(r"^-+|-+$", "", re.sub(r"-{2,}", "-", key.lower()))


def strip_honorific(name: str) -> str:
    while True:
        new = HONORIFIC.sub("", name, count=1).strip()
        if new == name or not new:
            return name
        name = new


_CONS = [("ksh", "क्ष"), ("chh", "छ"), ("kh", "ख"), ("gh", "घ"), ("ch", "च"), ("jh", "झ"), ("th", "थ"), ("dh", "ध"), ("ph", "फ"),
         ("bh", "भ"), ("sh", "श"), ("k", "क"), ("g", "ग"), ("c", "क"), ("j", "ज"), ("t", "ट"), ("d", "ड"), ("n", "न"), ("p", "प"),
         ("b", "ब"), ("m", "म"), ("y", "य"), ("r", "र"), ("l", "ल"), ("v", "व"), ("w", "व"), ("s", "स"), ("h", "ह"), ("f", "फ़"),
         ("z", "ज़"), ("q", "क"), ("x", "क्स")]
# (independent letter, vowel sign after a consonant); a plain "a" after a consonant is the long ā: राज, राहुल, मार्केट
_VOWELS = [("aa", "आ", "ा"), ("ai", "ऐ", "ै"), ("au", "औ", "ौ"), ("ou", "औ", "ौ"), ("ow", "औ", "ौ"), ("ee", "ई", "ी"),
           ("ii", "ई", "ी"), ("oo", "ऊ", "ू"), ("uu", "ऊ", "ू"), ("a", "अ", "ा"), ("e", "ए", "े"), ("i", "इ", "ि"),
           ("o", "ओ", "ो"), ("u", "उ", "ु")]


def _word_to_devanagari(w: str) -> str:
    w = w.replace("tion", "shan").replace("ck", "k")   # English spellings: -tion, ck, and double consonants (ss, tt, ll)
    w = "".join(ch for i, ch in enumerate(w) if not (i and ch == w[i - 1] and ch not in "aeiou"))
    out, i, after_consonant = [], 0, False
    while i < len(w):
        for pat, independent, sign in _VOWELS:
            if w.startswith(pat, i):
                out.append(sign if after_consonant else independent)
                i, after_consonant = i + len(pat), False
                break
        else:
            if w[i] == "y" and after_consonant and i == len(w) - 1:   # a final y after a consonant: tally -> टाली
                out.append("ी")
                i, after_consonant = i + 1, False
                continue
            for pat, dev in _CONS:
                if w.startswith(pat, i):
                    if pat == "c" and w[i + 1:i + 2] in ("e", "i", "y"):
                        dev = "स"
                    out.append(("्" if after_consonant else "") + dev)   # no vowel between two consonants: join them
                    i, after_consonant = i + len(pat), True
                    break
    return "".join(out)


def roman_to_devanagari(text: str) -> str:
    """Approximate Devanagari spelling of Latin text, by rules (no dictionary): consonant clusters joined, a after a
    consonant long, final consonant bare. Right for most names and loanwords, wrong for some (startup -> स्टार्टुप); the
    Haiku batch (--aliases) replaces it for the top terms."""
    return re.sub(r"[A-Za-z]+", lambda m: _word_to_devanagari(m.group(0).lower()), text)


def uniq_aliases(text: str, candidates: list[str]) -> list[str]:
    """Candidates without repeats and without the text itself (compared folded), in order."""
    seen, out = {fold(text)}, []
    for c in candidates:
        c = " ".join(c.split())
        f = fold(c)
        if c and f and f not in seen:
            seen.add(f)
            out.append(c)
    return out


# ---------- reading the database ----------
def pages(db, what: str, build) -> list[dict]:
    out, start = [], 0
    while True:
        rows = db_lib.call(what, lambda: build().range(start, start + 999).execute(), db).data
        out += rows
        start += 1000
        if len(rows) < 1000:
            return out


def row(kind: str, ref: str, text: str, aliases: list[str], weight: float) -> dict:
    text = " ".join(text.split())
    aliases = uniq_aliases(text, aliases)
    return {"kind": kind, "ref": ref, "text": text, "folded": fold(text), "aliases": aliases, "aliases_ai": [],
            "aliases_folded": [], "weight": round(float(weight), 4)}


def devanagari_alias(text: str) -> list[str]:
    d = roman_to_devanagari(text)
    return [d] if DEVANAGARI.search(d) else []


def build_rows(db) -> dict[tuple[str, str], dict]:
    run_id = RUN_ID_PATH.read_text(encoding="utf-8").strip()
    log.info("reading the archive run %s", run_id)
    corrections = corrections_lib.load()
    episodes = pages(db, "episodes", lambda: db.table("episodes").select("video_id,title,status,view_count").order("video_id"))
    transcribed = {e["video_id"]: e for e in episodes if e["status"] == "transcribed"}
    log.info("episodes: %s, transcribed %s", len(episodes), len(transcribed))
    guest_rows = pages(db, "guests", lambda: db.table("guests").select("id,video_id,name,sector_tags,guest_key")
                       .eq("run_id", run_id).eq("verified", True).order("id"))
    clips = pages(db, "clips", lambda: db.table("clips").select("id,topic,score").eq("run_id", run_id).eq("verified", True).order("id"))
    log.info("verified guest rows: %s, verified clips: %s", len(guest_rows), len(clips))

    rows: dict[tuple[str, str], dict] = {}

    def add(r: dict) -> None:
        if r["folded"]:
            rows.setdefault((r["kind"], r["ref"]), r)

    # guests: one per merged guest_key whose episode is transcribed (the Guests directory's rule)
    by_key: dict[str, list[dict]] = defaultdict(list)
    for g in guest_rows:
        key = corrections.guest_key(g["guest_key"]) if g["guest_key"] else None
        if key and g["video_id"] in transcribed:
            by_key[key].append(g)
    tag_guests: dict[str, set[str]] = defaultdict(set)
    tag_forms: dict[str, Counter] = defaultdict(Counter)
    for key, group in by_key.items():
        names = Counter(g["name"].strip() for g in group if g["name"] and g["name"].strip())
        if not names:
            continue
        name = names.most_common(1)[0][0]
        videos = {g["video_id"] for g in group}
        views = sum(int(transcribed[v]["view_count"] or 0) for v in videos)
        others = [n for n in names if n != name]
        variants = [strip_honorific(name)] + others + [strip_honorific(n) for n in others]
        dev = devanagari_alias(strip_honorific(name)) + devanagari_alias(name)
        add(row("guest", guest_slug(key), name, variants + dev, views))
        for g in group:
            for t in g["sector_tags"] or []:
                t = t.strip()
                if t:
                    tag_guests[t.lower()].add(key)
                    tag_forms[t.lower()][t] += 1
    for tag, keys in tag_guests.items():
        if len(keys) >= MIN_GUESTS_PER_TOPIC:
            label = tag_label(tag_forms[tag].most_common(1)[0][0])
            add(row("topic", tag, label, devanagari_alias(label), len(keys)))

    for vid, e in transcribed.items():
        title = (e["title"] or "").strip()
        if len(title) < 3:
            continue
        fo = re.search(r"\bFO\s?(\d+)\b", title, re.I)
        add(row("episode", vid, title, [f"FO{fo.group(1)}", f"FO {fo.group(1)}"] if fo else [], int(e["view_count"] or 0)))

    for c in clips:
        title = (c["topic"] or "").strip()
        if len(title) >= 3 and title.lower() != "clip":
            add(row("clip", str(c["id"]), title, [], float(c["score"] or 0)))

    # curated vocabulary, weighted by how many passages contain the word (chunk_terms), when that table is readable
    words = sorted({w for term, _ in CURATED_TERMS for w in fold(term).split() if w.isascii()})
    counts: dict[str, int] = {}
    try:
        for i in range(0, len(words), 100):
            part = words[i:i + 100]
            for r in db_lib.call("chunk_terms", lambda: db.table("chunk_terms").select("word,chunk_count").in_("word", part).execute(), db).data:
                counts[r["word"]] = r["chunk_count"]
    except Exception as exc:  # noqa: BLE001 - the weights are a nicety; the terms themselves do not depend on them
        log.warning("chunk_terms not readable (%s): curated terms get weight 0", str(exc)[:120])
    taken = {r["folded"] for r in rows.values() if r["kind"] in ("topic", "guest")}
    for term, extra in CURATED_TERMS:
        f = fold(term)
        if f in taken:
            continue   # already a topic or a guest name
        parts = [counts.get(w, 0) for w in f.split()]
        add(row("term", f, term, extra + devanagari_alias(term), min(parts) if parts else 0))
    return rows


def apply_ai_aliases(rows: dict[tuple[str, str], dict]) -> int:
    """Merge the saved Haiku answers into the rows (aliases_ai) and fold every alias."""
    ai: dict[str, dict] = {}
    for path in sorted(ALIAS_DIR.glob("*.json")):
        for item in json.loads(path.read_text(encoding="utf-8")).get("items", []):
            ai[item["id"]] = item
    n = 0
    for r in rows.values():
        item = ai.get(f"{r['kind']}:{r['ref']}")
        spellings = (item["devanagari"] + item["roman"]) if item else []
        r["aliases_ai"] = uniq_aliases(r["text"], [a for a in spellings if a not in r["aliases"]][:6])
        n += bool(r["aliases_ai"])
        r["aliases_folded"] = sorted({fold(a) for a in r["aliases"] + r["aliases_ai"]} - {"", r["folded"]})
    return n


# ---------- comparing with the table ----------
COLUMNS = "id,kind,ref,text,folded,aliases,aliases_ai,aliases_folded,weight"


def fetch_existing(db) -> dict[tuple[str, str], dict] | None:
    """The rows in the table, or None when the table does not exist yet."""
    try:
        rows = pages(db, "existing suggestions", lambda: db.table(TABLE).select(COLUMNS).order("id"))
    except Exception as exc:  # noqa: BLE001
        msg = str(exc)
        if TABLE in msg or "PGRST205" in msg or "42P01" in msg:
            return None
        raise
    return {(r["kind"], r["ref"]): r for r in rows}


def same(a: dict, b: dict) -> bool:
    return (a["text"], a["folded"], a["aliases"], a["aliases_ai"], a["aliases_folded"], round(float(a["weight"]), 4)) == \
           (b["text"], b["folded"], b["aliases"], b["aliases_ai"], b["aliases_folded"], round(float(b["weight"]), 4))


def samples(items: list[dict], n: int = 10) -> list[dict]:
    """The top 5 by weight and 5 spread over the rest, so a sample shows both ends."""
    items = sorted(items, key=lambda r: (-r["weight"], r["text"]))
    if len(items) <= n:
        return items
    rest = items[5:]
    step = max(1, len(rest) // 5)
    return items[:5] + [rest[i * step] for i in range(5)]


def report(rows: dict, existing: dict | None) -> tuple[list[dict], list[int]]:
    todo, prune = [], []
    for key, r in rows.items():
        old = existing.get(key) if existing else None
        if old is None or not same(r, old):
            todo.append(r)
    if existing:
        prune = [old["id"] for key, old in existing.items() if key not in rows]
    by_kind = defaultdict(list)
    for r in rows.values():
        by_kind[r["kind"]].append(r)
    print("\n=== search_suggestions: what the builder produces ===")
    for kind in KINDS:
        items = by_kind.get(kind, [])
        with_alias = sum(1 for r in items if r["aliases"] or r["aliases_ai"])
        dev = sum(1 for r in items if any(DEVANAGARI.search(a) for a in r["aliases"] + r["aliases_ai"]))
        print(f"\n{kind}: {len(items)} rows, {with_alias} with aliases, {dev} with a Devanagari alias")
        for r in samples(items):
            shown = ", ".join(r["aliases"][:3] + ["+AI: " + a for a in r["aliases_ai"][:2]])
            print(f"  [{r['weight']:>12,.1f}] {r['ref'][:40]:<40} {r['text'][:70]!r}" + (f"  aliases: {shown}" if shown else ""))
    if existing is None:
        print(f"\nTable public.{TABLE} does not exist yet (run pipeline/sql/search_v2.sql): every row would be inserted.")
        print(f"Would insert {len(rows)}, update 0, leave 0, remove 0.")
    else:
        new = sum(1 for r in todo if (r["kind"], r["ref"]) not in existing)
        print(f"\nAgainst the {len(existing)} rows in the table: insert {new}, update {len(todo) - new}, "
              f"leave {len(rows) - len(todo)}, remove {len(prune)}.")
    print(f"Total {len(rows)} rows.")
    return todo, prune


# ---------- the Haiku alias batch ----------
def alias_candidates(rows: dict) -> list[dict]:
    top_guests = sorted((r for r in rows.values() if r["kind"] == "guest"), key=lambda r: -r["weight"])[:TOP_GUESTS]
    items = [r for r in rows.values() if r["kind"] in ("term", "topic")] + top_guests
    return sorted(items, key=lambda r: (r["kind"], r["ref"]))


def alias_groups(rows: dict) -> dict[str, list[dict]]:
    items = alias_candidates(rows)
    groups = {}
    for i in range(0, len(items), ITEMS_PER_REQUEST):
        part = items[i:i + ITEMS_PER_REQUEST]
        cid = "alias-" + hashlib.sha1("|".join(f"{r['kind']}:{r['ref']}" for r in part).encode()).hexdigest()[:12]
        groups[cid] = part
    return groups


def prompt_for(part: list[dict]) -> str:
    lines = "\n".join(json.dumps({"id": f"{r['kind']}:{r['ref']}", "kind": r["kind"], "text": r["text"]}, ensure_ascii=False) for r in part)
    return f"Items ({len(part)}), one JSON object per line:\n{lines}"


def estimate(groups: dict[str, list[dict]]) -> tuple[int, int, float]:
    tin = sum((len(SYSTEM_PROMPT) + len(prompt_for(p)) + len(json.dumps(OUTPUT_SCHEMA))) / EST_CHARS_PER_TOKEN for p in groups.values())
    tout = sum(len(p) * EST_OUT_TOKENS_PER_ITEM for p in groups.values())
    return int(tin), int(tout), (tin * PRICE_IN + tout * PRICE_OUT) / 1e6


def alias_run(rows: dict, dry: bool, max_usd: float) -> None:
    groups = alias_groups(rows)
    todo = {c: p for c, p in groups.items() if not (ALIAS_DIR / f"{c}.json").exists()}
    tin, tout, usd = estimate(todo)
    print(f"\n=== Haiku aliases ({MODEL}, Batch API) ===")
    print(f"{sum(len(p) for p in groups.values())} items in {len(groups)} requests of up to {ITEMS_PER_REQUEST}; "
          f"{len(groups) - len(todo)} already answered, {len(todo)} to send.")
    print(f"Estimated cost of what is left: about {tin:,} input + {tout:,} output tokens = USD {usd:.4f} "
          f"(USD {PRICE_IN}/{PRICE_OUT} per million tokens in/out); the limit is USD {max_usd:.2f}.")
    if not todo:
        print("Nothing to send.")
        return
    if dry:
        print("Dry run: nothing is sent.")
        return
    if usd > max_usd:
        sys.exit(f"Estimated cost USD {usd:.4f} is over --max-usd {max_usd}; nothing was sent.")
    import anthropic
    from anthropic.types.message_create_params import MessageCreateParamsNonStreaming
    from anthropic.types.messages.batch_create_params import Request

    client = anthropic.Anthropic(max_retries=5)
    ALIAS_DIR.mkdir(parents=True, exist_ok=True)
    job = json.loads(JOB_PATH.read_text(encoding="utf-8")) if JOB_PATH.exists() else None
    if job and not job.get("collected") and set(todo) & set(job["custom_ids"]):
        batch_id = job["batch_id"]
        log.info("Resuming batch %s", batch_id)
    else:
        requests = [Request(custom_id=c, params=MessageCreateParamsNonStreaming(
            model=MODEL, max_tokens=MAX_TOKENS, system=SYSTEM_PROMPT,
            output_config={"effort": "low", "format": {"type": "json_schema", "schema": OUTPUT_SCHEMA}},
            messages=[{"role": "user", "content": prompt_for(p)}])) for c, p in todo.items()]
        batch = client.messages.batches.create(requests=requests)
        batch_id = batch.id
        job = {"batch_id": batch_id, "custom_ids": sorted(todo), "collected": False}
        JOB_PATH.write_text(json.dumps(job, indent=2), encoding="utf-8")
        log.info("Batch %s created with %s requests", batch_id, len(requests))
    last = None
    while True:
        batch = client.messages.batches.retrieve(batch_id)
        c = batch.request_counts
        state = (batch.processing_status, c.processing, c.succeeded, c.errored)
        if state != last:
            log.info("Batch %s: %s (processing %s, succeeded %s, errored %s)", batch_id, *state)
            last = state
        if batch.processing_status == "ended":
            break
        time.sleep(POLL_SECONDS)
    used_in = used_out = saved = 0
    for result in client.messages.batches.results(batch_id):
        part = groups.get(result.custom_id)
        if part is None or result.result.type != "succeeded":
            log.warning("request %s: %s (it is sent again by the next run)", result.custom_id, result.result.type)
            continue
        msg = result.result.message
        used_in += msg.usage.input_tokens
        used_out += msg.usage.output_tokens
        try:
            text = "".join(b.text for b in msg.content if b.type == "text")
            items = json.loads(text)["items"]
        except (ValueError, KeyError, TypeError):
            log.warning("request %s: the answer was not the expected JSON (it is sent again by the next run)", result.custom_id)
            continue
        wanted = {f"{r['kind']}:{r['ref']}" for r in part}
        clean = []
        for it in items:
            if it.get("id") not in wanted:
                continue
            dev = [a.strip() for a in it.get("devanagari", []) if isinstance(a, str) and DEVANAGARI.search(a)][:3]
            lat = [a.strip() for a in it.get("roman", []) if isinstance(a, str) and a.strip() and not DEVANAGARI.search(a)][:3]
            clean.append({"id": it["id"], "devanagari": dev, "roman": lat})
        (ALIAS_DIR / f"{result.custom_id}.json").write_text(
            json.dumps({"items": clean, "model": MODEL, "usage": {"input_tokens": msg.usage.input_tokens, "output_tokens": msg.usage.output_tokens}},
                       ensure_ascii=False, indent=1), encoding="utf-8")
        saved += 1
    job["collected"] = True
    JOB_PATH.write_text(json.dumps(job, indent=2), encoding="utf-8")
    print(f"Saved {saved} of {len(todo)} answers. Actual cost: USD {(used_in * PRICE_IN + used_out * PRICE_OUT) / 1e6:.4f} "
          f"({used_in:,} in, {used_out:,} out tokens).")


# ---------- writing ----------
def write(db, todo: list[dict], prune: list[int]) -> None:
    payload = [{k: r[k] for k in ("kind", "ref", "text", "folded", "aliases", "aliases_ai", "aliases_folded", "weight")} for r in todo]
    for i in range(0, len(payload), WRITE_BATCH):
        part = payload[i:i + WRITE_BATCH]
        db_lib.call("upsert suggestions", lambda: db.table(TABLE).upsert(part, on_conflict="kind,ref").execute(), db)
        log.info("written %s of %s", min(i + WRITE_BATCH, len(payload)), len(payload))
    for i in range(0, len(prune), 200):
        ids = prune[i:i + 200]
        db_lib.call("remove stale suggestions", lambda: db.table(TABLE).delete().in_("id", ids).execute(), db)
        log.info("removed %s of %s stale rows", min(i + 200, len(prune)), len(prune))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true", help="read and print counts and samples; write and send nothing")
    parser.add_argument("--aliases", action="store_true", help="also run the Haiku alias batch for the top terms (Batch API)")
    parser.add_argument("--max-usd", type=float, default=DEFAULT_MAX_USD, help="refuse to send a batch estimated above this")
    parser.add_argument("--no-prune", action="store_true", help="keep rows whose guest, topic, episode or clip is gone")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")   # the Windows console is cp1252; Devanagari must print
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    load_dotenv(ROOT / ".env")
    db = db_lib.client()

    rows = build_rows(db)
    if args.aliases:
        alias_run(rows, args.dry_run, args.max_usd)
    merged = apply_ai_aliases(rows)
    log.info("Haiku aliases merged into %s rows", merged)
    existing = fetch_existing(db)
    todo, prune = report(rows, existing)
    if args.dry_run:
        log.info("dry run: nothing written")
        return
    if existing is None:
        sys.exit(f"public.{TABLE} does not exist: run pipeline/sql/search_v2.sql in the Supabase SQL Editor first.")
    write(db, todo, [] if args.no_prune else prune)
    log.info("done: %s written, %s removed", len(todo), 0 if args.no_prune else len(prune))


if __name__ == "__main__":
    main()
