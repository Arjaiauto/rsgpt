"""Transcription bake-off: Groq Whisper (turbo and large-v3) vs Sarvam on the same audio.

For each bake-off episode (from data/candidates.csv) the second 10-minute piece,
audio/<video_id>/part_001.mp3, is transcribed by five services:
  1. groq_turbo       Groq whisper-large-v3-turbo, language auto-detected
  2. groq_large       Groq whisper-large-v3, language auto-detected
  3. sarvam           Sarvam saaras:v4 in codemix mode (English words in Latin script,
                      Hindi words in Devanagari)
  4. groq_large_hi    Groq whisper-large-v3 with language forced to "hi"
  5. sarvam_translit  Sarvam saaras:v4 in translit mode (everything in Roman script)
A sixth column, YouTube's automatic captions (original-language track), comes
from 05_captions.py download-auto and is only displayed here.
Groq returns segment timestamps, Sarvam chunk timestamps. Sarvam's REST endpoint
only takes clips up to 30 s, so Sarvam uses its Batch API: one job per Sarvam
service covering all episodes, created, uploaded, started, polled, downloaded.

Each result goes to data/bakeoff/<video_id>_<service>.json with segments in
episode time (seconds from the start of the episode) plus the raw API response.
Then data/bakeoff.html shows one section per episode: a YouTube link starting at
the piece offset, the word count of each service, and the transcripts side by
side in 30-second rows.

Safe to rerun: a result file that exists is skipped. Each Sarvam job ID is saved
to data/bakeoff/<service>_job.json, so an interrupted run picks up the same job
instead of paying for a new one. Network errors are retried.

Usage:
    .venv\\Scripts\\python.exe pipeline\\04_bakeoff.py
"""

import csv
import html
import json
import logging
import os
import sys
import time
from pathlib import Path

import requests
from dotenv import load_dotenv
from groq import Groq

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
AUDIO_DIR = ROOT / "audio"
OUT_DIR = DATA_DIR / "bakeoff"
CANDIDATES_CSV = DATA_DIR / "candidates.csv"
HTML_PATH = DATA_DIR / "bakeoff.html"

PIECE_FILE = "part_001.mp3"
ROW_SECONDS = 30
MAX_RETRIES = 5

# Prices checked 2026-10-21: console.groq.com/docs/speech-to-text and
# docs.sarvam.ai/api-reference-docs/pricing.
GROQ_MIN_BILLED_SECONDS = 10
SERVICES = {
    "groq_turbo": {"label": "Groq whisper-large-v3-turbo", "model": "whisper-large-v3-turbo",
                   "price_per_hour": 0.04, "currency": "USD"},
    "groq_large": {"label": "Groq whisper-large-v3", "model": "whisper-large-v3",
                   "price_per_hour": 0.111, "currency": "USD"},
    "sarvam": {"label": "Sarvam saaras:v4 (codemix)", "model": "saaras:v4", "mode": "codemix",
               "price_per_hour": 30.0, "currency": "INR"},
    "groq_large_hi": {"label": "Groq whisper-large-v3, language hi", "model": "whisper-large-v3",
                      "language": "hi", "price_per_hour": 0.111, "currency": "USD"},
    "sarvam_translit": {"label": "Sarvam saaras:v4 (translit)", "model": "saaras:v4", "mode": "translit",
                        "price_per_hour": 30.0, "currency": "INR"},
    # Made by 06_romanize.py from youtube_auto_orig; shown here, never run here.
    "youtube_haiku_roman": {"label": "YouTube + Haiku romanized", "external": True},
    # Made by 05_captions.py download-auto; shown here, never run here.
    "youtube_auto_orig": {"label": "YouTube auto (original)", "external": True},
    # YouTube has answered 429 to every translation request since 2026-10-21; for the
    # Hindi episodes 07_translate.py writes a note saying so instead.
    "youtube_auto_en": {"label": "YouTube auto (English translation)", "external": True},
    # Made by 07_translate.py from youtube_auto_orig; shown here, never run here.
    "haiku_translation": {"label": "Haiku translation", "external": True},
}
GROQ_SERVICES = [s for s in SERVICES if s.startswith("groq")]
SARVAM_SERVICES = [s for s in SERVICES if s.startswith("sarvam")]

SARVAM_BASE = "https://api.sarvam.ai/speech-to-text/job/v1"
SARVAM_POLL_SECONDS = 15
SARVAM_TIMEOUT_SECONDS = 60 * 60

log = logging.getLogger("bakeoff")


def read_episodes() -> list[dict]:
    with CANDIDATES_CSV.open(newline="", encoding="utf-8") as f:
        return [r for r in csv.DictReader(f) if r["bakeoff"] == "yes"]


def piece_info(video_id: str) -> dict:
    manifest = json.loads((AUDIO_DIR / video_id / "manifest.json").read_text(encoding="utf-8"))
    for piece in manifest["pieces"]:
        if piece["file"] == PIECE_FILE:
            return piece
    raise RuntimeError(f"{video_id}: {PIECE_FILE} not in manifest")


def result_path(video_id: str, service: str) -> Path:
    return OUT_DIR / f"{video_id}_{service}.json"


def cost_of(service: str, seconds: float) -> float:
    if service.startswith("groq"):
        seconds = max(seconds, GROQ_MIN_BILLED_SECONDS)
    return seconds / 3600 * SERVICES[service]["price_per_hour"]


def save_result(video_id: str, service: str, piece: dict, segments: list[dict], raw: dict) -> None:
    offset = piece["start_seconds"]
    result = {
        "video_id": video_id,
        "service": service,
        "model": SERVICES[service]["model"],
        "audio_file": PIECE_FILE,
        "offset_seconds": offset,
        "duration_seconds": piece["duration_seconds"],
        "cost": round(cost_of(service, piece["duration_seconds"]), 6),
        "currency": SERVICES[service]["currency"],
        # start/end are episode time, so they line up with YouTube timestamps
        "segments": [
            {"start": round(s["start"] + offset, 2), "end": round(s["end"] + offset, 2), "text": s["text"].strip()}
            for s in segments if s["text"].strip()
        ],
        "raw": raw,
    }
    path = result_path(video_id, service)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
    tmp.replace(path)


# ---------- Groq ----------

def transcribe_groq(client: Groq, episode: dict, service: str) -> None:
    video_id = episode["video_id"]
    piece = piece_info(video_id)
    audio = (AUDIO_DIR / video_id / PIECE_FILE).read_bytes()
    log.info("%s: %s transcribing", video_id, service)
    started = time.monotonic()
    extra = {"language": SERVICES[service]["language"]} if "language" in SERVICES[service] else {}
    response = client.audio.transcriptions.create(
        file=(f"{video_id}.mp3", audio),
        model=SERVICES[service]["model"],
        response_format="verbose_json",
        timestamp_granularities=["segment"],
        temperature=0.0,
        **extra,
    )
    raw = response.model_dump() if hasattr(response, "model_dump") else dict(response)
    segments = [{"start": s["start"], "end": s["end"], "text": s["text"]} for s in raw.get("segments") or []]
    if not segments:
        raise RuntimeError(f"{service} returned no segments")
    save_result(video_id, service, piece, segments, raw)
    log.info("%s: %s done, %s segments in %.0fs", video_id, service, len(segments), time.monotonic() - started)


# ---------- Sarvam batch ----------

def sarvam_request(method: str, url: str, key: str, **kwargs) -> dict:
    headers = {"api-subscription-key": key}
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = requests.request(method, url, headers=headers, timeout=60, **kwargs)
            if resp.status_code in (429, 500, 502, 503, 504):
                raise requests.HTTPError(f"{resp.status_code}: {resp.text[:300]}")
            if resp.status_code >= 400:
                raise RuntimeError(f"Sarvam {method} {url} -> {resp.status_code}: {resp.text[:500]}")
            return resp.json()
        except (requests.ConnectionError, requests.Timeout, requests.HTTPError) as exc:
            if attempt == MAX_RETRIES:
                raise
            wait = 5 * attempt
            log.warning("Sarvam %s failed (%s), retrying in %ss", url.rsplit("/", 1)[-1], exc, wait)
            time.sleep(wait)
    raise AssertionError("unreachable")


def storage_request(method: str, url: str, **kwargs) -> requests.Response:
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = requests.request(method, url, timeout=300, **kwargs)
            resp.raise_for_status()
            return resp
        except (requests.ConnectionError, requests.Timeout, requests.HTTPError) as exc:
            if attempt == MAX_RETRIES:
                raise
            wait = 5 * attempt
            log.warning("storage %s failed (%s), retrying in %ss", method, exc, wait)
            time.sleep(wait)
    raise AssertionError("unreachable")


def sarvam_job_path(service: str) -> Path:
    return OUT_DIR / f"{service}_job.json"


def load_sarvam_job(service: str) -> dict | None:
    path = sarvam_job_path(service)
    if path.exists():
        job = json.loads(path.read_text(encoding="utf-8"))
        job.setdefault("service", service)
        return job
    return None


def save_sarvam_job(job: dict) -> None:
    sarvam_job_path(job["service"]).write_text(json.dumps(job, indent=2), encoding="utf-8")


def create_sarvam_job(key: str, service: str, video_ids: list[str]) -> dict:
    params = {
        "model": SERVICES[service]["model"],
        "mode": SERVICES[service]["mode"],
        "language_code": "unknown",
        "with_timestamps": True,
    }
    created = sarvam_request("POST", SARVAM_BASE, key, json={"job_parameters": params})
    job = {"job_id": created["job_id"], "service": service, "video_ids": video_ids,
           "uploaded": False, "started": False}
    save_sarvam_job(job)
    log.info("Sarvam %s job %s created for %s files", service, job["job_id"], len(video_ids))
    return job


def upload_sarvam_files(key: str, job: dict) -> None:
    names = [f"{vid}.mp3" for vid in job["video_ids"]]
    resp = sarvam_request("POST", f"{SARVAM_BASE}/upload-files", key,
                          json={"job_id": job["job_id"], "files": names})
    azure = resp.get("storage_container_type", "").startswith("Azure")
    for name in names:
        url = resp["upload_urls"][name]["file_url"]
        headers = {"Content-Type": "audio/mpeg"}
        if azure:
            headers["x-ms-blob-type"] = "BlockBlob"
        data = (AUDIO_DIR / name[:-4] / PIECE_FILE).read_bytes()
        storage_request("PUT", url, data=data, headers=headers)
        log.info("Sarvam uploaded %s (%.1f MB)", name, len(data) / 1e6)
    job["uploaded"] = True
    save_sarvam_job(job)


def wait_for_sarvam(key: str, job: dict) -> dict:
    deadline = time.monotonic() + SARVAM_TIMEOUT_SECONDS
    last_state = None
    while True:
        status = sarvam_request("GET", f"{SARVAM_BASE}/{job['job_id']}/status", key)
        state = status["job_state"]
        if state != last_state:
            log.info("Sarvam job %s: %s (%s/%s files done)", job["job_id"], state,
                     status.get("successful_files_count", 0), status.get("total_files", 0))
            last_state = state
        if state == "Completed":
            return status
        if state == "Failed":
            raise RuntimeError(f"Sarvam job failed: {status.get('error_message') or status}")
        if time.monotonic() > deadline:
            raise RuntimeError(f"Sarvam job still {state} after {SARVAM_TIMEOUT_SECONDS}s; rerun to keep waiting")
        time.sleep(SARVAM_POLL_SECONDS)


def sarvam_segments(raw: dict) -> list[dict]:
    ts = raw.get("timestamps") or {}
    texts = ts.get("chunks") or ts.get("words") or []
    starts = ts.get("start_time_seconds") or []
    ends = ts.get("end_time_seconds") or []
    segments = [{"start": s, "end": e, "text": t} for t, s, e in zip(texts, starts, ends)]
    if not segments and raw.get("transcript"):
        log.warning("Sarvam result has no timestamps; using the whole transcript as one segment")
        segments = [{"start": 0.0, "end": 0.0, "text": raw["transcript"]}]
    return segments


def run_sarvam(key: str, service: str, episodes: list[dict]) -> int:
    pending = [ep["video_id"] for ep in episodes if not result_path(ep["video_id"], service).exists()]
    if not pending:
        return 0
    job = load_sarvam_job(service)
    if job and not set(pending) <= set(job["video_ids"]):
        log.info("Saved Sarvam job does not cover %s; starting a new job", sorted(set(pending) - set(job["video_ids"])))
        job = None
    if job is None:
        job = create_sarvam_job(key, service, pending)
    else:
        log.info("Resuming Sarvam %s job %s", service, job["job_id"])
    if not job["uploaded"]:
        upload_sarvam_files(key, job)
    if not job["started"]:
        sarvam_request("POST", f"{SARVAM_BASE}/{job['job_id']}/start", key)
        job["started"] = True
        save_sarvam_job(job)
        log.info("Sarvam job %s started", job["job_id"])

    status = wait_for_sarvam(key, job)
    outputs = {}  # video_id -> output file name
    for detail in status.get("job_details") or []:
        if detail.get("state") != "Success":
            log.error("Sarvam file failed: %s %s", detail.get("inputs"), detail.get("error_message"))
            continue
        vid = detail["inputs"][0]["file_name"].rsplit(".", 1)[0]
        outputs[vid] = detail["outputs"][0]["file_name"]
    wanted = {vid: name for vid, name in outputs.items() if vid in pending}
    if not wanted:
        raise RuntimeError("Sarvam job completed but returned no usable outputs")
    links = sarvam_request("POST", f"{SARVAM_BASE}/download-files", key,
                           json={"job_id": job["job_id"], "files": list(wanted.values())})
    done = 0
    for vid, name in wanted.items():
        raw = storage_request("GET", links["download_urls"][name]["file_url"]).json()
        raw["sarvam_job_id"] = job["job_id"]
        segments = sarvam_segments(raw)
        save_result(vid, service, piece_info(vid), segments, raw)
        log.info("%s: %s done, %s segments", vid, service, len(segments))
        done += 1
    return done


# ---------- HTML ----------

def clock(seconds: float) -> str:
    seconds = int(seconds)
    return f"{seconds // 3600}:{seconds % 3600 // 60:02d}:{seconds % 60:02d}" if seconds >= 3600 \
        else f"{seconds // 60}:{seconds % 60:02d}"


def build_html(episodes: list[dict]) -> None:
    sections = []
    for ep in episodes:
        vid = ep["video_id"]
        piece = piece_info(vid)
        start = piece["start_seconds"]
        end = start + piece["duration_seconds"]
        results = {}
        for service in SERVICES:
            path = result_path(vid, service)
            if path.exists():
                results[service] = json.loads(path.read_text(encoding="utf-8"))

        # One row per 30-second window; each segment goes in the row where it starts.
        n_rows = int((end - start) // ROW_SECONDS) + 1
        # Cells hold escaped HTML; segments flagged by a word-count check are highlighted.
        cells = {service: [[] for _ in range(n_rows)] for service in SERVICES}
        for service, result in results.items():
            for seg in result["segments"]:
                row = min(max(int((seg["start"] - start) // ROW_SECONDS), 0), n_rows - 1)
                text = html.escape(seg["text"])
                if seg.get("flagged"):
                    tip = html.escape(f"{seg['id']}: {seg['source_words']} -> {seg['words']} words. "
                                      f"Original: {seg['source_text']}", quote=True)
                    text = f'<mark title="{tip}">{text}</mark>'
                cells[service][row].append(text)

        url = f"https://www.youtube.com/watch?v={vid}&t={int(start)}s"
        head = "".join(f"<th>{html.escape(SERVICES[s]['label'])}</th>" for s in SERVICES)
        not_applicable = {s: r["not_applicable"] for s, r in results.items() if r.get("not_applicable")}
        counts = {s: sum(len(seg["text"].split()) for seg in r["segments"])
                  for s, r in results.items() if s not in not_applicable}
        top = max(counts.values(), default=0)

        def placeholder(s: str) -> str:
            return f"<td class=missing>{html.escape(not_applicable.get(s, 'not run'))}</td>"

        count_cells = "".join(
            (f"<td class='count{' low' if top and counts[s] < 0.8 * top else ''}'>{counts[s]:,} words"
             + (f" ({counts[s] / top:.0%} of most)" if top and counts[s] < 0.8 * top else "")
             + "</td>") if s in counts else placeholder(s)
            for s in SERVICES)
        rows = []
        for i in range(n_rows):
            t = start + i * ROW_SECONDS
            if t >= end:
                break
            stamp = f'<a href="https://www.youtube.com/watch?v={vid}&t={int(t)}s" target="_blank">{clock(t)}</a>'
            tds = "".join(
                f"<td>{' '.join(cells[s][i])}</td>" if s in counts else placeholder(s)
                for s in SERVICES)
            rows.append(f"<tr><th class=ts>{stamp}</th>{tds}</tr>")
        sections.append(
            f'<section><h2>{html.escape(ep["title"])}</h2>'
            f'<p><a href="{url}" target="_blank">Open on YouTube at {clock(start)}</a> &middot; '
            f'piece {PIECE_FILE}, {clock(start)}&ndash;{clock(end)}</p>'
            f'<table><thead><tr><th class=ts>Time</th>{head}</tr>'
            f'<tr><th class=ts>Words</th>{count_cells}</tr></thead><tbody>{"".join(rows)}</tbody></table>'
            f'</section>')

    page = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Transcription bake-off</title>
<style>
body {{ font-family: system-ui, sans-serif; margin: 24px; color: #222; background: #fff; }}
.note {{ background: #fff4d6; padding: 8px 12px; border-radius: 4px; display: inline-block; }}
section {{ margin-top: 40px; }}
table {{ border-collapse: collapse; width: 100%; table-layout: fixed; }}
th, td {{ border: 1px solid #ddd; padding: 6px 8px; vertical-align: top; text-align: left; font-size: 14px; line-height: 1.45; }}
thead th {{ background: #f3f3f3; position: sticky; top: 0; }}
th.ts {{ width: 70px; font-weight: normal; white-space: nowrap; }}
td.missing {{ color: #999; font-style: italic; }}
td.count {{ background: #f3f3f3; font-weight: 600; }}
td.count.low {{ color: #b00020; background: #fde7ea; }}
</style></head><body>
<h1>Transcription bake-off</h1>
<p class="note">Unofficial project, not affiliated with Figuring Out.</p>
<p>Second 10-minute piece of each bake-off episode. Rows are 30-second windows in episode time;
each segment sits in the row where it starts. Click a timestamp to jump there on YouTube.
Word counts are space-separated words; red marks a column under 80% of the episode's highest count.
In the romanized column, <mark>highlighted</mark> lines have a word count more than 20% away from the
Devanagari caption line they came from; hover for the original.</p>
{"".join(sections)}
</body></html>
"""
    HTML_PATH.write_text(page, encoding="utf-8")
    log.info("Wrote %s", HTML_PATH)


# ---------- main ----------

def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    load_dotenv(ROOT / ".env")
    groq_key = os.environ.get("GROQ_API_KEY")
    sarvam_key = os.environ.get("SARVAM_API_KEY")
    if not groq_key or not sarvam_key:
        sys.exit("GROQ_API_KEY and SARVAM_API_KEY must be set in .env")

    episodes = read_episodes()
    if not episodes:
        sys.exit(f"No episodes marked bakeoff in {CANDIDATES_CSV}")
    missing = [ep["video_id"] for ep in episodes if not (AUDIO_DIR / ep["video_id"] / PIECE_FILE).exists()]
    if missing:
        sys.exit(f"Audio missing for {missing}; run 03_download_audio.py first")
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    ran = {service: [] for service in SERVICES}  # video_ids transcribed in this run
    failed = []

    client = Groq(api_key=groq_key, max_retries=MAX_RETRIES, timeout=600)
    for ep in episodes:
        for service in GROQ_SERVICES:
            if result_path(ep["video_id"], service).exists():
                continue
            try:
                transcribe_groq(client, ep, service)
                ran[service].append(ep["video_id"])
            except Exception as exc:
                log.error("%s: %s failed: %s", ep["video_id"], service, exc)
                failed.append(f"{ep['video_id']} {service}")

    for service in SARVAM_SERVICES:
        before = {ep["video_id"] for ep in episodes if result_path(ep["video_id"], service).exists()}
        try:
            run_sarvam(sarvam_key, service, episodes)
        except Exception as exc:
            log.error("%s failed: %s", service, exc)
            failed.append(f"{service}: {exc}")
        ran[service] = [ep["video_id"] for ep in episodes
                        if ep["video_id"] not in before and result_path(ep["video_id"], service).exists()]

    build_html(episodes)

    print()
    print("Cost of this run (list prices, by audio length):")
    totals: dict[str, float] = {}
    for service, info in SERVICES.items():
        if info.get("external"):
            continue
        if not ran[service]:
            print(f"  {info['label']:<36} skipped, all {len(episodes)} already done earlier")
            continue
        seconds = sum(piece_info(vid)["duration_seconds"] for vid in ran[service])
        cost = sum(cost_of(service, piece_info(vid)["duration_seconds"]) for vid in ran[service])
        totals[info["currency"]] = totals.get(info["currency"], 0.0) + cost
        print(f"  {info['label']:<36} {len(ran[service])} files, {seconds / 60:5.1f} min  "
              f"{info['currency']} {cost:.4f}")
    if totals:
        print("  Total: " + ", ".join(f"{cur} {amount:.4f}" for cur, amount in totals.items()))
    if failed:
        print("Failures:")
        for f in failed:
            print(f"  {f}")
    print(f"Results: {OUT_DIR}")
    print(f"Page:    {HTML_PATH}")


if __name__ == "__main__":
    main()
