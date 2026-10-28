"""Hand-picked guest photos from the folder data/Guest Images.

For every guest_key with NO photo_url yet (the Wikimedia Commons photos from 13_guest_photos.py are kept as they are), the
image file whose name matches the guest's name (case, extension, spaces, underscores and hyphens ignored) is
centre-cropped to a square, resized to 400 px, saved as webp, uploaded to the public Supabase Storage bucket
guest-photos, and written to every guests row of the guest_key: photo_url, photo_source = 'manual' (no credit and no
licence; the site shows no credit line for these).

Then data/manual_photos_review.html is written (every manual photo with its name) and the files that matched no guest and
the guests that still have no photo are listed.

Resumable: guests that already have a photo_url are skipped; a failed upload is logged and retried on the next run.
Run pipeline/14_apply_corrections.py first so merged guests (for example Vaibhav Sisinty) have one guest_key.

Usage:
    .venv\\Scripts\\python.exe pipeline\\16_manual_photos.py --dry-run
    .venv\\Scripts\\python.exe pipeline\\16_manual_photos.py
"""

import argparse
import html
import io
import logging
import re
import sys
from pathlib import Path

from dotenv import load_dotenv
from PIL import Image, ImageOps

sys.path.insert(0, str(Path(__file__).resolve().parent))
import db_lib  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
FOLDER = DATA / "Guest Images"
REVIEW = DATA / "manual_photos_review.html"
RUN_ID_PATH = DATA / "extractions" / "haiku" / "v5" / "run_id.txt"
BUCKET = "guest-photos"
SIZE = 400
WEBP_QUALITY = 85
IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".jfif", ".bmp", ".tif", ".tiff"}

log = logging.getLogger("manual_photos")


def norm(text: str) -> str:
    """Name for matching: lower case, no spaces, underscores or hyphens."""
    return re.sub(r"[\s_\-]+", "", text.lower())


def storage_name(key: str) -> str:
    return re.sub(r"-{2,}", "-", re.sub(r"[^a-z0-9]+", "-", key.lower())).strip("-")


def to_webp(raw: bytes) -> bytes:
    img = ImageOps.exif_transpose(Image.open(io.BytesIO(raw)))
    img = ImageOps.fit(img.convert("RGB"), (SIZE, SIZE), Image.LANCZOS, centering=(0.5, 0.4))  # centre, a little high for faces
    buf = io.BytesIO()
    img.save(buf, "WEBP", quality=WEBP_QUALITY, method=6)
    return buf.getvalue()


def fetch_guests(db, run_id: str) -> list[dict]:
    rows, start = [], 0
    while True:
        page = db_lib.call("guests select", lambda: db.table("guests").select("id,name,guest_key,verified,photo_url,photo_source")
                           .eq("run_id", run_id).order("id").range(start, start + 999).execute(), db).data
        rows += page
        if len(page) < 1000:
            return rows
        start += 1000


def write_review(entries: list[tuple[str, str]]) -> None:
    cards = "\n".join(f'<figure><img src="{html.escape(url)}" alt="{html.escape(name)}"><figcaption>{html.escape(name)}</figcaption></figure>'
                      for name, url in sorted(entries))
    REVIEW.write_text(f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Manual guest photos</title>
<style>
body{{font:16px system-ui,sans-serif;margin:24px;background:#fafafa;color:#111}}
h1{{font-size:20px}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:16px}}
figure{{margin:0;background:#fff;border:1px solid #ddd;border-radius:8px;overflow:hidden}}
img{{display:block;width:100%;aspect-ratio:1;object-fit:cover}}
figcaption{{padding:8px 10px;font-size:14px}}
</style></head><body>
<h1>Manual guest photos ({len(entries)})</h1>
<div class="grid">
{cards}
</div></body></html>
""", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true", help="print the matches; upload and write nothing")
    args = parser.parse_args()
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    for noisy in ("httpx", "httpcore"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    load_dotenv(ROOT / ".env")
    db = db_lib.client()
    run_id = RUN_ID_PATH.read_text(encoding="utf-8").strip()

    rows = fetch_guests(db, run_id)
    by_key: dict[str, list[dict]] = {}
    for r in rows:
        if r["verified"] and r["guest_key"]:
            by_key.setdefault(r["guest_key"], []).append(r)
    by_name: dict[str, list[str]] = {}
    for key, group in by_key.items():
        by_name.setdefault(norm(group[0]["name"]), []).append(key)

    files = sorted(f for f in FOLDER.iterdir() if f.is_file() and f.suffix.lower() in IMAGE_EXTS)
    unmatched, uploaded, skipped = [], [], 0
    ensure = not args.dry_run
    if ensure:
        buckets = {b.name for b in db_lib.call("list buckets", lambda: db.storage.list_buckets(), db)}
        if BUCKET not in buckets:
            db_lib.call("create bucket", lambda: db.storage.create_bucket(BUCKET, options={"public": True}), db)
    for f in files:
        keys = by_name.get(norm(f.stem), [])
        if not keys:
            unmatched.append(f.name)
            continue
        for key in keys:
            group = by_key[key]
            name = group[0]["name"]
            if any(g["photo_url"] for g in group):
                skipped += 1
                log.info("%s: already has a photo, skipped", name)
                continue
            if args.dry_run:
                log.info("%s: would use %s", name, f.name)
                continue
            try:
                webp = to_webp(f.read_bytes())
                path = f"{storage_name(key)}.webp"
                db_lib.call("upload", lambda: db.storage.from_(BUCKET).upload(
                    path, webp, {"content-type": "image/webp", "upsert": "true"}), db)
                public = db.storage.from_(BUCKET).get_public_url(path).rstrip("?")
                ids = [g["id"] for g in group]
                values = {"photo_url": public, "photo_credit": None, "photo_license": None, "photo_source": "manual"}
                db_lib.call("guests update", lambda: db.table("guests").update(values).in_("id", ids).execute(), db)
                for g in group:
                    g["photo_url"], g["photo_source"] = public, "manual"
                log.info("%s: photo uploaded (%s rows)", name, len(ids))
            except Exception as exc:  # network errors were retried by db_lib; the guest is retried next run
                log.error("%s: failed (%s); will be retried next run", name, exc)

    if not args.dry_run:
        manual = [(g[0]["name"], g[0]["photo_url"]) for g in by_key.values() if g[0]["photo_source"] == "manual" and g[0]["photo_url"]]
        write_review(manual)
        log.info("review page written: %s", REVIEW.relative_to(ROOT))
    no_photo = sorted(g[0]["name"] for g in by_key.values() if not any(x["photo_url"] for x in g))
    print(f"\n{'Dry run: ' if args.dry_run else ''}{len(files)} files, {skipped} guests already had a photo")
    print(f"\nFiles that matched no guest ({len(unmatched)}):")
    for n in unmatched:
        print("  " + n)
    print(f"\nGuests that still have no photo ({len(no_photo)} of {len(by_key)}):")
    for n in no_photo:
        print("  " + n)


if __name__ == "__main__":
    main()
