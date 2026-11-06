// The search library (lib/search/search.ts, Ticket 27) against the LIVE database, read-only: nothing is written.
//   node --import ./scripts/register.mjs scripts/search-test.mjs [query ...]
// Prints, per query: mode, correction, vague, chips, the top 3 of each group and the time taken, then checks the
// acceptance rules. Exit code 1 if any check fails.
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.loadEnvFile(path.resolve(root, "..", ".env"));
const { runSearch } = await import("../lib/search/search.ts");

const QUERIES = ["aghori", "ai", "startup", "fundraising", "fundrasing", "raj shamani", "अघोरी", "crypto", "mental health", "how to raise money"];
const queries = process.argv.slice(2).length ? process.argv.slice(2) : QUERIES;

const cut = (s, n = 70) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const results = new Map();
for (const q of queries) {
  const t0 = performance.now();
  const r = await runSearch(q);
  const ms = Math.round(performance.now() - t0);
  results.set(q, r);
  const g = r.groups;
  console.log(`\n=== ${JSON.stringify(q)}  ${ms} ms  mode=${r.mode}  vague=${r.vague}${r.corrected ? `  corrected: ${r.corrected.from} -> ${r.corrected.to}` : ""}`);
  console.log(`  chips: ${r.chips.map((c) => `[${c.kind}] ${c.label}`).join(" · ") || "(none)"}`);
  console.log(`  guests:   ${g.guests.slice(0, 3).map((x) => `${x.name}${x.matched ? " (name)" : ` (${x.hits})`}`).join(" · ") || "-"}`);
  console.log(`  episodes: ${g.episodes.slice(0, 3).map((x) => `${cut(x.title, 50)}${x.matched ? " (title)" : ` (${x.hits})`}`).join(" · ") || "-"}`);
  console.log(`  clips:    ${g.clips.slice(0, 3).map((x) => `${cut(x.title, 45)}${x.matched ? " (title)" : ""}`).join(" · ") || "-"}`);
  console.log(`  topics:   ${g.topics.slice(0, 3).map((x) => `${x.label}${x.matched ? " (name)" : ` (${x.hits})`}`).join(" · ") || "-"}`);
  for (const m of g.moments.slice(0, 3)) {
    console.log(`  moment:   ${m.keyword ? "[kw]" : "[sem]"} sim=${m.similarity?.toFixed(3) ?? "-"} ${cut(m.episode, 40)} @${Math.round(m.startS)}s: ${cut(m.snippet, 110)}`);
  }
  console.log(`  stages:   ${Object.entries(r.ms ?? {}).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
}

// ---------- acceptance ----------
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`); if (!ok) failed++; };
const nonEmpty = (r) => Object.values(r.groups).some((list) => list.length > 0);
const sayAghori = (r) => r.groups.moments.some((m) => /aghor/i.test(m.snippet));
console.log("\n=== checks");
for (const [q, r] of results) check(nonEmpty(r), `${JSON.stringify(q)} returns something`);
for (const q of ["ai", "startup"]) {
  const r = results.get(q);
  if (r) check(r.vague && r.chips.length >= 3 && r.chips.length <= 5, `${q}: vague with 3-5 chips (${r.chips.length}: ${r.chips.map((c) => c.label).join(", ")})`);
}
for (const q of ["aghori", "अघोरी"]) { const r = results.get(q); if (r) check(sayAghori(r), `${q}: the moments include the aghori passages`); }
{ const r = results.get("fundrasing"); if (r) check(r.corrected?.to === "fundraising", `fundrasing corrected to fundraising (${r.corrected ? r.corrected.to : "no correction"})`); }
{
  const r = results.get("raj shamani");
  if (r) check(!r.groups.episodes.some((e) => e.matched) && !r.groups.clips.some((c) => c.matched), "raj shamani: no episode or clip matched by title");
}
{ const r = results.get("how to raise money"); if (r) check(!r.vague, "how to raise money: a question, never vague"); }
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
