"""Guest photos from Wikimedia Commons.

For each merged guest (guest_key) with a verified Wikipedia page, the page's main image is found with the
official APIs (en.wikipedia.org pageimages, then commons.wikimedia.org imageinfo with extmetadata). The
image is kept ONLY when its licence is CC0, public domain, CC BY or CC BY-SA (any version). Skipped:
non-Commons (local, fair-use) files, svg / logos / non-photos, tiny images, and anything whose file name,
description, credit or categories mention the host or the show. YouTube thumbnails and news photos are
never used.

A kept image is centre-cropped to a square, resized to 400 px, saved as webp and uploaded to the public
Supabase Storage bucket guest-photos; guests.photo_url (and photo_credit, photo_license, photo_source =
the Commons file page URL) are written on every row of the guest_key.

Name check: the file name, title or description must contain a part of the guest name. A credit that is
only a URL is shown as the site name (the full file page URL stays in photo_source).

Resumable: guests that already have a photo_url are skipped, API answers are cached in
data/cache/guest_photos/api.json, images in data/cache/guest_photos/. One request per second, with a
User-Agent naming the project and a contact address, as the Wikimedia API policy asks.

Run pipeline/sql/guest_photos.sql in the Supabase SQL Editor first (not needed for --dry-run).

Usage:
    .venv\\Scripts\\python.exe pipeline\\13_guest_photos.py --dry-run --limit 20
    .venv\\Scripts\\python.exe pipeline\\13_guest_photos.py            # all guests
"""

import argparse
import hashlib
import html
import io
import json
import logging
import re
import sys
import time
import unicodedata
from collections import defaultdict
from pathlib import Path
from urllib.parse import quote, unquote

import requests
from dotenv import load_dotenv
from PIL import Image, ImageOps

sys.path.insert(0, str(Path(__file__).resolve().parent))
import db_lib  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
RUN_ID_PATH = DATA_DIR / "extractions" / "haiku" / "v5" / "run_id.txt"
CACHE_DIR = DATA_DIR / "cache" / "guest_photos"
API_CACHE = CACHE_DIR / "api.json"
WIKI_API = "https://en.wikipedia.org/w/api.php"
COMMONS_API = "https://commons.wikimedia.org/w/api.php"
USER_AGENT = ("RSGPT/0.1 (private, unofficial research project on the Figuring Out podcast archive; "
              "https://github.com/Arjaiauto/rsgpt; asood1749@gmail.com) python-requests")
PAUSE_SECONDS = 1.0
RETRIES = 3
BUCKET = "guest-photos"
SIZE = 400
THUMB_WIDTH = 800        # Commons thumbnail asked for, big enough to crop and resize from
MIN_SIDE = 300           # a smaller original is skipped (it would be upscaled)
WEBP_QUALITY = 85
DB_PAGE = 1000
# Licence short names (Commons extmetadata LicenseShortName) that are allowed.
LICENSE_OK = re.compile(r"^(CC0(\b.*)?|Public domain|PD([- ].*)?|CC[- ]BY([- ]SA)?[- ]\d(\.\d)?(\s.*)?)$", re.I)
LICENSE_NO = re.compile(r"\b(NC|ND|GFDL|fair use|all rights reserved)\b", re.I)
BRANDING = re.compile(r"raj\s*shamani|shamani|figuring\s*out|rajshamani", re.I)
NOT_PHOTO = re.compile(r"logo|icon|symbol|coat[_ ]of[_ ]arms|signature|wordmark|banner", re.I)
PHOTO_MIMES = {"image/jpeg", "image/png", "image/webp"}
# Left out of a guest's name before it is looked for in the file name, title and description.
NAME_TITLES = {"dr", "prof", "professor", "mr", "mrs", "ms", "shri", "smt", "sri", "adv", "ca", "sir", "major", "maj",
               "col", "colonel", "lt", "gen", "general", "capt", "captain", "brig", "justice"}
# A credit that is only a web address is shown as the site's name.
SITE_NAMES = {"bollywoodhungama.com": "Bollywood Hungama"}

log = logging.getLogger("photos")


class Api:
    """Wikipedia / Commons API: one request at a time with a pause, answers cached on disk."""

    def __init__(self):
        self.session = requests.Session()
        self.session.headers["User-Agent"] = USER_AGENT
        self.cache = json.loads(API_CACHE.read_text(encoding="utf-8")) if API_CACHE.exists() else {}
        self.last = 0.0
        self.requests = 0

    def pause(self) -> None:
        time.sleep(max(0.0, self.last + PAUSE_SECONDS - time.monotonic()))
        self.last = time.monotonic()
        self.requests += 1

    def request(self, url: str, **kw) -> requests.Response:
        for attempt in range(1, RETRIES + 1):
            self.pause()
            try:
                r = self.session.get(url, timeout=30, **kw)
                if r.status_code in (429, 500, 502, 503, 504) and attempt < RETRIES:
                    log.warning("%s: HTTP %s, retrying in %ss", url[:60], r.status_code, 10 * attempt)
                    time.sleep(10 * attempt)
                    continue
                r.raise_for_status()
                return r
            except (requests.ConnectionError, requests.Timeout) as exc:
                if attempt == RETRIES:
                    raise
                log.warning("%s: %s, retrying in %ss", url[:60], type(exc).__name__, 10 * attempt)
                time.sleep(10 * attempt)
        raise AssertionError("unreachable")

    def get(self, endpoint: str, params: dict) -> dict:
        params = {**params, "format": "json", "formatversion": 2}
        key = endpoint + json.dumps(params, sort_keys=True)
        if key not in self.cache:
            self.cache[key] = self.request(endpoint, params=params).json()
            CACHE_DIR.mkdir(parents=True, exist_ok=True)
            tmp = API_CACHE.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(self.cache, ensure_ascii=False), encoding="utf-8")
            tmp.replace(API_CACHE)
        return self.cache[key]

    def image_bytes(self, url: str) -> bytes:
        path = CACHE_DIR / (hashlib.sha256(url.encode()).hexdigest()[:24] + ".bin")
        if not path.exists():
            CACHE_DIR.mkdir(parents=True, exist_ok=True)
            path.write_bytes(self.request(url).content)
        return path.read_bytes()


def plain_text(value: str | None) -> str:
    """Commons metadata values are HTML; this is the text."""
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", str(value if value is not None else "")))).strip()


def ascii_lower(text: str) -> str:
    return unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower()


def name_in_text(name: str, text: str) -> bool:
    """True when at least one part of the guest's name (titles such as Dr or Sir and one-letter initials
    left out) is a word of the text, case and accents ignored."""
    parts = [w for w in re.findall(r"[a-z0-9]+", ascii_lower(name)) if w not in NAME_TITLES and len(w) > 1]
    words = set(re.findall(r"[a-z0-9]+", ascii_lower(text)))
    return any(p in words for p in parts)


def credit_text(credit: str) -> str:
    """The credit, or the site's name when the credit is a bare web address."""
    if not re.fullmatch(r"https?://\S+", credit.strip()):
        return credit
    host = re.sub(r"^www\.", "", re.sub(r"^https?://", "", credit.strip()).split("/")[0].lower())
    return SITE_NAMES.get(host, host.rsplit(".", 1)[0].replace("-", " ").title() if "." in host else host)


def clean_credit(credit: str) -> str:
    """The credit for display: "Copyright", "Photo by", bracketed or bare URLs and the site's own
    "(www.site.org)" notes are removed, and the names are joined with " / ". For example
    "Copyright World Economic Forum (www.weforum.org)/Photo by Dana Smillie" becomes
    "World Economic Forum / Dana Smillie"."""
    text = re.sub(r"[(\[]\s*(https?://|www\.)[^)\]]*[)\]]", " ", credit)
    text = re.sub(r"https?://\S+|www\.\S+", " ", text)
    text = re.sub(r"\bcopyright\b|©", " ", text, flags=re.I)
    text = re.sub(r"\bphoto\s+by\b", " ", text, flags=re.I)
    parts = [" ".join(p.strip(" .,;:-").split()) for p in re.split(r"\s*/\s*", text)]
    return " / ".join(p for p in parts if p)


def slug(key: str) -> str:
    return re.sub(r"-{2,}", "-", re.sub(r"[^a-z0-9]+", "-", key.lower())).strip("-")


def judge(api: Api, wikipedia_url: str, guest_name: str) -> dict:
    """The decision for one Wikipedia page: {"keep": bool, "why": str, "file": ..., "license": ...,
    "credit": ..., "source": file page URL, "image_url": thumbnail URL}."""
    title = unquote(wikipedia_url.split("/wiki/", 1)[1]).replace("_", " ")
    out = {"keep": False, "file": "", "license": "", "credit": "", "source": "", "image_url": "", "why": ""}
    page = (api.get(WIKI_API, {"action": "query", "prop": "pageimages", "piprop": "name", "titles": title,
                               "redirects": 1}).get("query", {}).get("pages") or [{}])[0]
    name = page.get("pageimage")
    if not name:
        return out | {"why": "page has no main image"}
    out["file"] = name
    if NOT_PHOTO.search(name) or name.lower().endswith(".svg"):
        return out | {"why": "logo / not a photo (file name)"}
    if BRANDING.search(name):
        return out | {"why": "file name mentions host or show"}
    file_title = "File:" + name.replace("_", " ")
    cpage = (api.get(COMMONS_API, {
        "action": "query", "titles": file_title, "prop": "imageinfo|categories", "cllimit": 100,
        "iiprop": "url|extmetadata|mime|size", "iiurlwidth": THUMB_WIDTH,
    }).get("query", {}).get("pages") or [{}])[0]
    info = (cpage.get("imageinfo") or [None])[0]
    if cpage.get("missing") or not info:
        return out | {"why": "not on Commons (local or fair-use file)"}
    out["source"] = info.get("descriptionurl") or "https://commons.wikimedia.org/wiki/" + quote(file_title.replace(" ", "_"))
    meta = {k: plain_text(v.get("value")) for k, v in (info.get("extmetadata") or {}).items()}
    licence = meta.get("LicenseShortName", "")
    out["license"] = licence
    out["credit"] = meta.get("Artist") or meta.get("Credit") or ""
    if not licence:
        return out | {"why": "no licence in metadata"}
    if LICENSE_NO.search(licence) or not LICENSE_OK.match(licence):
        return out | {"why": f"licence not allowed ({licence})"}
    if info.get("mime") not in PHOTO_MIMES:
        return out | {"why": f"not a photo ({info.get('mime')})"}
    if min(info.get("width") or 0, info.get("height") or 0) < MIN_SIDE:
        return out | {"why": f"too small ({info.get('width')}x{info.get('height')})"}
    categories = " ".join(c["title"] for c in cpage.get("categories") or [])
    haystack = " ".join([name, meta.get("ImageDescription", ""), out["credit"], meta.get("ObjectName", ""),
                         categories])
    if BRANDING.search(haystack):
        return out | {"why": "mentions host or show (description, credit or category)"}
    out["credit"] = clean_credit(credit_text(out["credit"]))
    if not out["credit"]:
        return out | {"why": "no author / credit"}
    if not name_in_text(guest_name, " ".join([name.replace("_", " "), meta.get("ObjectName", ""),
                                              meta.get("ImageDescription", "")])):
        return out | {"why": "name not in file"}
    return out | {"keep": True, "why": "ok", "image_url": info.get("thumburl") or info["url"]}


def to_webp(raw: bytes) -> bytes:
    img = ImageOps.exif_transpose(Image.open(io.BytesIO(raw)))
    img = ImageOps.fit(img.convert("RGB"), (SIZE, SIZE), Image.LANCZOS, centering=(0.5, 0.4))  # centre, a little high for faces
    buf = io.BytesIO()
    img.save(buf, "WEBP", quality=WEBP_QUALITY, method=6)
    return buf.getvalue()


def fetch_all(db, columns: str, **eq) -> list[dict]:
    rows, start = [], 0
    while True:
        def query():
            q = db.table("guests").select(columns)
            for k, v in eq.items():
                q = q.eq(k, v)
            return q.order("id").range(start, start + DB_PAGE - 1).execute()
        page = db_lib.call("guests select", query).data
        rows += page
        if len(page) < DB_PAGE:
            return rows
        start += DB_PAGE


def ensure_bucket(db) -> None:
    buckets = {b.name for b in db_lib.call("list buckets", lambda: db.storage.list_buckets())}
    if BUCKET not in buckets:
        db_lib.call("create bucket", lambda: db.storage.create_bucket(BUCKET, options={"public": True}))
        log.info("Created public bucket %s", BUCKET)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true", help="print what would be kept; change nothing")
    parser.add_argument("--limit", type=int, help="only the first N guests, ranked by episode views")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    for noisy in ("httpx", "httpcore"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    load_dotenv(ROOT / ".env")
    db = db_lib.client()

    run_id = RUN_ID_PATH.read_text(encoding="utf-8").strip()
    columns = "id,video_id,name,guest_key,wikipedia_url,verified,wikipedia_verified"
    have_columns = True
    try:
        rows = fetch_all(db, columns + ",photo_url", run_id=run_id)
    except Exception as exc:  # postgrest APIError 42703: the SQL has not been run
        if "photo_url" not in str(exc):
            raise
        if not args.dry_run:
            sys.exit("guests.photo_url does not exist: run pipeline/sql/guest_photos.sql in the Supabase SQL Editor")
        have_columns = False
        rows = fetch_all(db, columns, run_id=run_id)

    by_key = defaultdict(list)
    for r in rows:
        if r["verified"] and r["wikipedia_verified"] and r["wikipedia_url"] and r["guest_key"]:
            by_key[r["guest_key"]].append(r)
    episodes = {e["video_id"]: e.get("view_count") or 0 for e in db_lib.call(
        "episodes select", lambda: db.table("episodes").select("video_id,view_count").limit(5000).execute()).data}
    keys = sorted(by_key, key=lambda k: (-sum(episodes.get(r["video_id"], 0) for r in {r["video_id"]: r for r in by_key[k]}.values()), k))
    if args.limit:
        keys = keys[:args.limit]
    log.info("%s guests with a verified Wikipedia page%s", len(by_key), f" (first {len(keys)} by views)" if args.limit else "")

    api = Api()
    if not args.dry_run:
        ensure_bucket(db)
    kept = skipped = done = 0
    print(f"\n{'guest':30} {'file':44} {'licence':16} {'credit':28} result")
    for key in keys:
        guests = by_key[key]
        name = guests[0]["name"]
        if have_columns and any(g.get("photo_url") for g in guests):
            done += 1
            log.info("%s: already has a photo, skipped", name)
            continue
        try:
            d = judge(api, guests[0]["wikipedia_url"], name)
        except requests.RequestException as exc:
            log.error("%s: Wikipedia/Commons request failed (%s); will be retried next run", name, exc)
            continue
        verdict = "KEPT" if d["keep"] else f"skipped: {d['why']}"
        print(f"{name[:29]:30} {d['file'][:43]:44} {d['license'][:15]:16} {d['credit'][:27]:28} {verdict}", flush=True)
        if not d["keep"]:
            skipped += 1
            continue
        kept += 1
        if args.dry_run:
            continue
        try:
            webp = to_webp(api.image_bytes(d["image_url"]))
            path = f"{slug(key)}.webp"
            db_lib.call("upload", lambda: db.storage.from_(BUCKET).upload(
                path, webp, {"content-type": "image/webp", "upsert": "true"}))
            public = db.storage.from_(BUCKET).get_public_url(path).rstrip("?")
            values = {"photo_url": public, "photo_credit": d["credit"], "photo_license": d["license"],
                      "photo_source": d["source"]}
            ids = [g["id"] for g in guests]
            db_lib.call("guests update", lambda: db.table("guests").update(values).in_("id", ids).execute())
        except (requests.RequestException, OSError) as exc:
            kept -= 1
            log.error("%s: image step failed (%s); will be retried next run", name, exc)
    print(f"\n{'Dry run: ' if args.dry_run else ''}{kept} kept, {skipped} skipped, {done} already done, "
          f"of {len(keys)} guests; {api.requests} requests this run (cached answers cost none)")


if __name__ == "__main__":
    main()
