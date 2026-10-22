"""The Gate 1 sample of one extraction run, shared by review_app.py and 08_ai_precheck.py.

Every verified guest profile, and per episode up to SAMPLE_PER_EPISODE verified
items of each type (fewer when an episode has fewer), drawn once at random with a
fixed seed and saved to data/review/gate1_sample_<run_id>.json, so it stays the
same between sessions.
"""

import json
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REVIEW_DIR = ROOT / "data" / "review"
SAMPLE_PER_EPISODE = {"quote": 4, "disagreement": 3, "raj_opinion": 3, "raj_question": 3, "opportunity": 3,
                      "takeaway": 2, "clip": 2}
SAMPLE_SEED = 1


def sample_path(run_id: str) -> Path:
    return REVIEW_DIR / f"gate1_sample_{run_id}.json"


def gate1_sample(run_id: str, fetch) -> list[dict]:
    """The saved sample for the run, drawn and saved on first use. fetch(table, columns, **eq) returns all rows."""
    path = sample_path(run_id)
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))["items"]
    rng = random.Random(SAMPLE_SEED)
    rows = ([{"table": "guests", "id": r["id"], "type": "guest", "video_id": r["video_id"]}
             for r in fetch("guests", "id,video_id", run_id=run_id, verified=True)]
            + [{"table": "insights", "id": r["id"], "type": r["type"], "video_id": r["video_id"]}
               for r in fetch("insights", "id,video_id,type", run_id=run_id, verified=True)]
            + [{"table": "clips", "id": r["id"], "type": "clip", "video_id": r["video_id"]}
               for r in fetch("clips", "id,video_id", run_id=run_id, verified=True)])
    sample = []
    for vid in sorted({r["video_id"] for r in rows}):
        sample += [r for r in rows if r["video_id"] == vid and r["type"] == "guest"]
        for kind, n in SAMPLE_PER_EPISODE.items():
            pool = sorted((r for r in rows if r["video_id"] == vid and r["type"] == kind), key=lambda r: r["id"])
            sample += sorted(rng.sample(pool, min(n, len(pool))), key=lambda r: r["id"])
    REVIEW_DIR.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps({"run_id": run_id, "seed": SAMPLE_SEED, "per_episode": SAMPLE_PER_EPISODE,
                               "items": sample}, indent=1), encoding="utf-8")
    tmp.replace(path)
    return sample
