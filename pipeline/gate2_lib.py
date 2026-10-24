"""The Gate 2 sample, shared by review_app.py and 09_gate1_report.py --sample.

A fixed random sample of the extraction v5 run's verified items outside the test set:

1. EPISODES episodes that are not in the test set and have at least PER_EPISODE
   verified items, drawn per caption language in the languages' real proportion
   among those episodes (largest remainder).
2. PER_EPISODE items from each, EPISODES x PER_EPISODE in all. Every type gets at
   least MIN_PER_TYPE (or all it has in the drawn episodes, if fewer); the rest are
   spread over the types in proportion to how many verified items each has in the
   drawn episodes. A max flow (types -> episodes, each episode taking PER_EPISODE)
   decides how many of each type come from each episode: one item at a time, with
   episodes tried in a seeded random order and as few of one type from one episode
   as will do. The items themselves are then drawn at random.

Drawn once with SEED and saved to data/gate2_sample.json, so it stays the same
between sessions.
"""

import json
import random
from collections import Counter, deque
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SAMPLE_PATH = ROOT / "data" / "gate2_sample.json"
RUN_ID_PATH = ROOT / "data" / "extractions" / "haiku" / "v5" / "run_id.txt"
EPISODES = 50
PER_EPISODE = 5
MIN_PER_TYPE = 20
SEED = 2
TYPES = ["takeaway", "opportunity", "quote", "disagreement", "raj_opinion", "raj_question", "clip", "guest"]


def run_id() -> str:
    return RUN_ID_PATH.read_text(encoding="utf-8").strip()


def load_sample() -> dict | None:
    return json.loads(SAMPLE_PATH.read_text(encoding="utf-8")) if SAMPLE_PATH.exists() else None


def proportional(total: int, weights: dict, caps: dict | None = None) -> dict:
    """Split total over the keys in proportion to weights (largest remainder), each at most caps[key]."""
    caps = caps or {k: total for k in weights}
    out = {k: 0 for k in weights}
    left = total
    while left > 0:
        open_keys = [k for k in weights if out[k] < caps[k] and weights[k] > 0]
        if not open_keys:
            break
        w = sum(weights[k] for k in open_keys)
        exact = {k: left * weights[k] / w for k in open_keys}
        add = {k: min(int(exact[k]), caps[k] - out[k]) for k in open_keys}
        if not any(add.values()):  # hand out the remainders one at a time, largest first
            k = max(open_keys, key=lambda k: (exact[k] - int(exact[k]), weights[k]))
            add = {k: 1}
        for k, n in add.items():
            out[k] += n
            left -= n
    return out


class Flow:
    """Max flow from the types to the episodes. Each augmenting path carries one item, and the
    episodes are tried in a fresh random order each time, so a type is spread over episodes.
    Raising a capacity and augmenting again never takes flow away from a type."""

    def __init__(self, types: list[str], episodes: list[str], avail: dict[tuple[str, str], int], rng):
        self.rng, self.avail = rng, avail
        self.cap: dict[tuple, int] = {}
        self.adj: dict = {}
        for t in types:
            self.edge("S", ("t", t))
            for e in episodes:
                if avail.get((t, e)):
                    self.edge(("t", t), ("e", e))
        for e in episodes:
            self.edge(("e", e), "T")
            self.set_cap(("e", e), "T", PER_EPISODE)

    def edge(self, a, b) -> None:
        self.adj.setdefault(a, []).append(b)
        self.adj.setdefault(b, []).append(a)
        self.cap[(a, b)] = self.cap[(b, a)] = 0

    def flow(self, a, b) -> int:
        return self.cap[(b, a)]  # every edge starts with no capacity backwards, so this is its flow

    def set_cap(self, a, b, c: int) -> None:
        self.cap[(a, b)] = c - self.flow(a, b)

    def augment(self, type_caps: dict[str, int], per_pair: int) -> None:
        """Augment with each type taking at most type_caps[t] items, and at most per_pair from one episode."""
        for t, c in type_caps.items():
            self.set_cap("S", ("t", t), c)
            for e in self.adj[("t", t)]:
                if e != "S":
                    self.set_cap(("t", t), e, min(self.avail[(t, e[1])], per_pair))
        while True:
            for node, nbrs in self.adj.items():
                if isinstance(node, tuple) and node[0] == "t":
                    self.rng.shuffle(nbrs)
            prev = {"S": None}
            queue = deque(["S"])
            while queue and "T" not in prev:
                a = queue.popleft()
                for b in self.adj[a]:
                    if b not in prev and self.cap[(a, b)] > 0:
                        prev[b] = a
                        queue.append(b)
            if "T" not in prev:
                return
            b = "T"
            while prev[b] is not None:
                self.cap[(prev[b], b)] -= 1
                self.cap[(b, prev[b])] += 1
                b = prev[b]

    def type_episode(self, t: str, e: str) -> int:
        return self.flow(("t", t), ("e", e)) if (("t", t), ("e", e)) in self.cap else 0


def draw(episodes: list[dict], items: list[dict]) -> dict:
    """The sample from episodes (video_id, caption_language, in_test_set) and the run's verified
    items (table, id, type, video_id)."""
    rng = random.Random(SEED)
    count = Counter(i["video_id"] for i in items)
    eligible = sorted((e for e in episodes if not e["in_test_set"] and count[e["video_id"]] >= PER_EPISODE),
                      key=lambda e: e["video_id"])
    by_lang: dict[str, list[dict]] = {}
    for e in eligible:
        by_lang.setdefault(e["caption_language"], []).append(e)
    per_lang = proportional(EPISODES, {lang: len(eps) for lang, eps in sorted(by_lang.items())},
                            {lang: len(eps) for lang, eps in by_lang.items()})
    chosen = []
    for lang in sorted(by_lang):
        chosen += rng.sample(by_lang[lang], per_lang[lang])
    rng.shuffle(chosen)
    vids = [e["video_id"] for e in chosen]
    language = {e["video_id"]: e["caption_language"] for e in chosen}

    pool: dict[tuple[str, str], list[dict]] = {}
    for i in sorted(items, key=lambda i: (i["table"], i["id"])):
        if i["video_id"] in language:
            pool.setdefault((i["type"], i["video_id"]), []).append(i)
    avail = {k: len(v) for k, v in pool.items()}
    in_drawn = {t: sum(n for (tt, _), n in avail.items() if tt == t) for t in TYPES}
    total = EPISODES * PER_EPISODE
    floor = {t: min(MIN_PER_TYPE, in_drawn[t]) for t in TYPES}
    target = {t: floor[t] + n for t, n in proportional(total - sum(floor.values()), in_drawn,
                                                       {t: in_drawn[t] - floor[t] for t in TYPES}).items()}

    flow = Flow(TYPES, vids, avail, rng)
    for caps in (floor, target, in_drawn):  # the minimum per type first, then the proportional fill, then anything
        for per_pair in range(1, PER_EPISODE + 1):  # as few of one type from one episode as will do
            flow.augment(caps, per_pair)
    sample = []
    for vid in vids:
        for t in TYPES:
            n = flow.type_episode(t, vid)
            if n:
                picked = sorted(rng.sample(pool[(t, vid)], n), key=lambda i: i["id"])
                sample += [{**i, "language": language[vid]} for i in picked]
    got = Counter(i["type"] for i in sample)
    return {"run_id": None, "seed": SEED, "episodes": EPISODES, "per_episode": PER_EPISODE,
            "min_per_type": MIN_PER_TYPE, "episodes_by_language": dict(Counter(language.values())),
            "eligible_by_language": {lang: len(eps) for lang, eps in sorted(by_lang.items())},
            "target_per_type": target, "per_type": {t: got[t] for t in TYPES},
            "short_of_minimum": {t: MIN_PER_TYPE - got[t] for t in TYPES if got[t] < MIN_PER_TYPE},
            "items": sample}


def gate2_sample(fetch) -> dict:
    """The saved sample, drawn and saved on first use. fetch(table, columns, **eq) returns all rows."""
    saved = load_sample()
    if saved:
        return saved
    rid = run_id()
    episodes = fetch("episodes", "video_id,caption_language,in_test_set", status="transcribed")
    items = ([{"table": "guests", "id": r["id"], "type": "guest", "video_id": r["video_id"]}
              for r in fetch("guests", "id,video_id", run_id=rid, verified=True)]
             + [{"table": "insights", "id": r["id"], "type": r["type"], "video_id": r["video_id"]}
                for r in fetch("insights", "id,video_id,type", run_id=rid, verified=True)]
             + [{"table": "clips", "id": r["id"], "type": "clip", "video_id": r["video_id"]}
                for r in fetch("clips", "id,video_id", run_id=rid, verified=True)])
    sample = draw(episodes, items) | {"run_id": rid}
    SAMPLE_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = SAMPLE_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(sample, indent=1), encoding="utf-8")
    tmp.replace(SAMPLE_PATH)
    return sample
