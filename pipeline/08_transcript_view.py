"""Build data/transcript_view.html, a local page for checking test-set transcripts.

Pick an episode from the dropdown; every segment is a row with a timestamp that
opens the YouTube video at that second, the speaker (when known), the original
caption text, the Roman text and the English translation side by side. Rows
whose romanization was flagged by the 20% word-count check (Roman column kept in
Devanagari) and translation lines still off after the length-check retry are
marked.

Reads the local transcript files in data/transcripts/, which are what
05_captions.py writes to Supabase. Everything is embedded in the one HTML file,
so it opens straight from disk with no server. Safe to rerun: the page is
rebuilt from the current files each time.

Usage:
    .venv\\Scripts\\python.exe pipeline\\08_transcript_view.py
"""

import csv
import json
import logging
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
TRANSCRIPTS_DIR = DATA_DIR / "transcripts"
CANDIDATES_CSV = DATA_DIR / "candidates.csv"
HTML_PATH = DATA_DIR / "transcript_view.html"

DISCLAIMER = "Unofficial project, not affiliated with Figuring Out."

log = logging.getLogger("transcript_view")


def test_set() -> list[dict]:
    with CANDIDATES_CSV.open(newline="", encoding="utf-8") as f:
        return [r for r in csv.DictReader(f) if r["test_set"] == "yes"]


def episode_data(row: dict) -> dict | None:
    path = TRANSCRIPTS_DIR / f"{row['video_id']}.json"
    if not path.exists():
        log.warning("%s: no transcript file yet, skipping", row["video_id"])
        return None
    state = json.loads(path.read_text(encoding="utf-8"))
    if not state.get("segments"):
        log.warning("%s: no segments yet, skipping", row["video_id"])
        return None
    vid = state["video_id"]
    english = {t["seq"]: t["text"] for t in state.get("translation_segments") or []}
    still_off = {int(i.rsplit("-L", 1)[1]) for i in state.get("translation_still_flagged") or []}
    rows = [[s["seq"], s["start"], s["end"], s.get("speaker") or "",
             s["text_original"], s.get("text_roman") or "", english.get(s["seq"], "")]
            for s in state["segments"]]
    return {
        "video_id": vid,
        "title": row["title"],
        "published": row["published_at"][:10],
        "language": state["language"],
        "source": state["source"],
        "coverage": state.get("coverage"),
        "fallback_reason": state.get("fallback_reason") or "",
        "translation": state.get("translation"),
        "roman_flagged": state.get("flagged_seqs") or [],
        "translation_still_off": sorted(still_off),
        "rows": rows,
    }


def script_json(value) -> str:
    """JSON that is safe inside a <script> element."""
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")


PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Transcript Check</title>
<style>
:root {
  --bg: #f7f7f5; --panel: #ffffff; --text: #1d1d1b; --muted: #6b6b66; --line: #e3e3de;
  --accent: #1f5fbf; --row-alt: #fbfbf9; --flag-bg: #fff4d6; --flag-text: #7a5300;
  --off-bg: #fde8e6; --off-text: #9b2a1f; --chip: #eeeeea;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #141413; --panel: #1c1c1a; --text: #ecece8; --muted: #9c9c95; --line: #2f2f2c;
    --accent: #7aa7ee; --row-alt: #20201e; --flag-bg: #3a2f12; --flag-text: #f0c766;
    --off-bg: #3d1d1a; --off-text: #f2a097; --chip: #2a2a27;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 14px/1.45 system-ui, -apple-system, "Segoe UI", "Nirmala UI", "Noto Sans Devanagari", sans-serif; }
header { position: sticky; top: 0; z-index: 3; background: var(--panel); border-bottom: 1px solid var(--line);
  padding: 12px 16px; }
.bar { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; }
h1 { font-size: 16px; margin: 0 12px 0 0; }
select, input { font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--line);
  border-radius: 6px; padding: 6px 8px; }
select { flex: 1 1 420px; min-width: 0; max-width: 100%; }
input { flex: 0 1 240px; min-width: 0; }
.notice { font-size: 12px; color: var(--muted); margin-top: 6px; }
.meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; font-size: 12px; }
.chip { background: var(--chip); border-radius: 999px; padding: 2px 9px; }
.chip.flag { background: var(--flag-bg); color: var(--flag-text); }
.chip.off { background: var(--off-bg); color: var(--off-text); }
main { padding: 0 16px 24px; }
.wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; background: var(--panel); table-layout: fixed; min-width: 880px; }
th, td { text-align: left; vertical-align: top; padding: 6px 8px; border-bottom: 1px solid var(--line);
  white-space: pre-wrap; overflow-wrap: anywhere; }
th { font-size: 12px; color: var(--muted); font-weight: 600; background: var(--panel); }
tbody tr:nth-child(even) { background: var(--row-alt); }
col.t { width: 84px; } col.s { width: 80px; } col.n { width: 52px; }
td.time a { color: var(--accent); text-decoration: none; font-variant-numeric: tabular-nums; }
td.time a:hover { text-decoration: underline; }
td.seq, td.spk { color: var(--muted); font-size: 12px; }
.muted { color: var(--muted); font-style: italic; }
tr.flag td.roman { background: var(--flag-bg); color: var(--flag-text); }
tr.off td.english { background: var(--off-bg); color: var(--off-text); }
footer { padding: 16px; color: var(--muted); font-size: 12px; text-align: center; }
@media (max-width: 600px) { h1 { width: 100%; } input { flex-basis: 100%; } }
</style>
</head>
<body>
<header>
  <div class="bar">
    <h1>Transcript check</h1>
    <select id="episode" aria-label="Episode"></select>
    <input id="filter" type="search" placeholder="Filter lines" aria-label="Filter lines">
  </div>
  <div class="notice">__DISCLAIMER__ Local checking page, test set only.</div>
  <div class="meta" id="meta"></div>
</header>
<main>
  <div class="wrap">
    <table>
      <colgroup><col class="n"><col class="t"><col class="s"><col><col><col></colgroup>
      <thead><tr><th>#</th><th>Time</th><th>Speaker</th><th>Original</th><th>Roman</th><th>English</th></tr></thead>
      <tbody id="rows"></tbody>
    </table>
  </div>
</main>
<footer>__DISCLAIMER__ Built __BUILT__ from data/transcripts.</footer>
<script type="application/json" id="index">__INDEX__</script>
__EPISODES__
<script>
const index = JSON.parse(document.getElementById("index").textContent);
const select = document.getElementById("episode"), filter = document.getElementById("filter");
const tbody = document.getElementById("rows"), meta = document.getElementById("meta");
const cache = {};

function load(vid) {
  if (!cache[vid]) cache[vid] = JSON.parse(document.getElementById("ep-" + vid).textContent);
  return cache[vid];
}
function clock(sec) {
  const s = Math.floor(sec), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), r = s % 60;
  const mm = String(m).padStart(h ? 2 : 1, "0"), ss = String(r).padStart(2, "0");
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
function cell(tr, cls, text, note) {
  const td = document.createElement("td");
  td.className = cls;
  if (text) td.textContent = text;
  else { td.textContent = note; td.classList.add("muted"); }
  tr.appendChild(td);
  return td;
}
function chip(text, cls) {
  const span = document.createElement("span");
  span.className = "chip" + (cls ? " " + cls : "");
  span.textContent = text;
  meta.appendChild(span);
}
const LANG = {hi: "Hindi", en: "English"};
const SOURCE = {youtube_auto: "YouTube auto-captions", sarvam: "Sarvam (audio)", groq: "Groq Whisper (audio)"};

function render() {
  const ep = load(select.value);
  const q = filter.value.trim().toLowerCase();
  const flagged = new Set(ep.roman_flagged), off = new Set(ep.translation_still_off);
  const english = ep.language === "en", romanSource = ep.source !== "youtube_auto";
  meta.replaceChildren();
  chip(LANG[ep.language] || ep.language);
  chip(SOURCE[ep.source] || ep.source);
  chip(ep.rows.length.toLocaleString() + " segments");
  if (ep.coverage != null) chip("caption coverage " + Math.round(ep.coverage * 100) + "%");
  if (ep.fallback_reason) chip("fallback: " + ep.fallback_reason);
  if (flagged.size) chip(flagged.size + " romanization flags (kept in Devanagari)", "flag");
  if (off.size) chip(off.size + " translation lines still off length check", "off");
  chip("published " + ep.published);

  const frag = document.createDocumentFragment();
  let shown = 0;
  for (const [seq, start, end, speaker, orig, roman, en] of ep.rows) {
    if (q && !(orig + "\\n" + roman + "\\n" + en).toLowerCase().includes(q)) continue;
    shown++;
    const tr = document.createElement("tr");
    if (flagged.has(seq)) tr.classList.add("flag");
    if (off.has(seq)) tr.classList.add("off");
    cell(tr, "seq", String(seq), "");
    const t = cell(tr, "time", "", "");
    t.classList.remove("muted");
    const a = document.createElement("a");
    a.href = `https://www.youtube.com/watch?v=${encodeURIComponent(ep.video_id)}&t=${Math.floor(start)}s`;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = clock(start);
    a.title = `${clock(start)} to ${clock(end)}: open on YouTube`;
    t.textContent = "";
    t.appendChild(a);
    cell(tr, "spk", speaker && speaker !== "unknown" ? speaker : "", "unknown");
    cell(tr, "orig", orig, "");
    if (english || (romanSource && roman === orig)) cell(tr, "roman", "", "same as original");
    else cell(tr, "roman", roman, "not romanized yet");
    if (english) cell(tr, "english", "", "already English");
    else cell(tr, "english", en, "not translated yet");
    frag.appendChild(tr);
  }
  tbody.replaceChildren(frag);
  if (q) chip(shown.toLocaleString() + " matching");
}

for (const ep of index) {
  const opt = document.createElement("option");
  opt.value = ep.video_id;
  opt.textContent = `${ep.language === "hi" ? "HI" : "EN"} · ${ep.title}`;
  select.appendChild(opt);
}
const fromHash = decodeURIComponent(location.hash.slice(1));
if (index.some(ep => ep.video_id === fromHash)) select.value = fromHash;
select.addEventListener("change", () => { history.replaceState(null, "", "#" + select.value); render(); window.scrollTo(0, 0); });
let timer;
filter.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(render, 200); });
render();
</script>
</body>
</html>
"""


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    from datetime import datetime

    episodes = [ep for row in test_set() if (ep := episode_data(row))]
    episodes.sort(key=lambda ep: (ep["language"] != "hi", ep["title"].lower()))
    index = [{k: ep[k] for k in ("video_id", "title", "language")} for ep in episodes]
    blocks = "\n".join(f'<script type="application/json" id="ep-{ep["video_id"]}">{script_json(ep)}</script>'
                       for ep in episodes)
    html = (PAGE.replace("__DISCLAIMER__", DISCLAIMER)
            .replace("__BUILT__", datetime.now().strftime("%Y-%m-%d %H:%M"))
            .replace("__INDEX__", script_json(index))
            .replace("__EPISODES__", blocks))
    tmp = HTML_PATH.with_suffix(".html.tmp")
    tmp.write_text(html, encoding="utf-8")
    tmp.replace(HTML_PATH)
    print(f"{len(episodes)} episodes, {sum(len(ep['rows']) for ep in episodes):,} segments, "
          f"{HTML_PATH.stat().st_size / 1e6:.1f} MB")
    print(f"Open in Chrome: {HTML_PATH.as_uri()}")


if __name__ == "__main__":
    main()
