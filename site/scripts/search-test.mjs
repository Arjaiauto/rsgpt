// The search library and routes (lib/search, app/api/search, Ticket 27) against the LIVE database, read-only: nothing is
// written (the routes' after() callbacks are collected, not run).
//   node --import ./scripts/register.mjs scripts/search-test.mjs [query ...]
// Prints, per query: mode, correction, vague, chips, the top 3 of each group and the time taken; then a timing table
// (fast phase, suggest, full search, each cold and warm), the route checks and the acceptance checks. Exit code 1 if any fails.
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.loadEnvFile(path.resolve(root, "..", ".env"));
const { runSearch, runFastSearch } = await import("../lib/search/search.ts");
const { suggest } = await import("../lib/search/suggest.ts");
const { createSessionToken, SESSION_COOKIE } = await import("../lib/session.ts");

const QUERIES = ["aghori", "ai", "startup", "fundraising", "fundrasing", "raj shamani", "अघोरी", "crypto", "mental health", "how to raise money"];
const TIMED = ["ai", "aghori", "fund", "nikh", "अघो", "raj"];
const queries = process.argv.slice(2).length ? process.argv.slice(2) : QUERIES;

const cut = (s, n = 70) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const ms = async (fn) => { const t0 = performance.now(); const value = await fn(); return { value, ms: Math.round(performance.now() - t0) }; };

// ---------- full search, printed ----------
const results = new Map();
const full = new Map(); // query -> { cold, warm } ms
for (const q of queries) {
  const cold = await ms(() => runSearch(q, null, { fresh: true }));
  // warm: the median of three more runs (the embedding is cached by then; a single run is at the mercy of one slow database call)
  const warmRuns = [];
  for (let i = 0; i < 3; i++) warmRuns.push((await ms(() => runSearch(q, null, { fresh: true }))).ms);
  const warm = { ms: warmRuns.sort((x, y) => x - y)[1] };
  const r = cold.value;
  results.set(q, r);
  full.set(q, { cold: cold.ms, warm: warm.ms });
  const g = r.groups;
  console.log(`\n=== ${JSON.stringify(q)}  cold ${cold.ms} ms / warm ${warm.ms} ms  mode=${r.mode}  vague=${r.vague}${r.corrected ? `  corrected: ${r.corrected.from} -> ${r.corrected.to}` : ""}`);
  console.log(`  chips: ${r.chips.map((c) => `[${c.kind}] ${c.label}`).join(" · ") || "(none)"}`);
  console.log(`  guests:   ${g.guests.slice(0, 3).map((x) => `${x.name}${x.matched ? " (name)" : ` (${x.hits})`}`).join(" · ") || "-"}`);
  console.log(`  episodes: ${g.episodes.slice(0, 3).map((x) => `${cut(x.title, 50)}${x.matched ? " (title)" : ` (${x.hits})`}`).join(" · ") || "-"}`);
  console.log(`  clips:    ${g.clips.slice(0, 3).map((x) => `${cut(x.title, 45)}${x.matched ? " (title)" : ""}`).join(" · ") || "-"}`);
  console.log(`  topics:   ${g.topics.slice(0, 3).map((x) => `${x.label}${x.matched ? " (name)" : ` (${x.hits})`}`).join(" · ") || "-"}`);
  for (const m of g.moments.slice(0, 3)) {
    console.log(`  moment:   ${m.keyword ? "[kw]" : "[sem]"} sim=${m.similarity?.toFixed(3) ?? "-"} ${cut(m.episode, 40)} @${Math.round(m.startS)}s: ${cut(m.snippet, 110)}`);
  }
  console.log(`  stages (cold): ${Object.entries(r.ms ?? {}).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
}

// ---------- fast phase and suggest: cold = the first time this text is seen, warm = the best of the next three ----------
await runFastSearch("warm up the index"); // loads the suggestion index and the archive lookups (a server has them already)
const timing = [];
for (const q of TIMED) {
  const fastCold = await ms(() => runFastSearch(q));
  const fastWarm = Math.min(...[await ms(() => runFastSearch(q)), await ms(() => runFastSearch(q)), await ms(() => runFastSearch(q))].map((x) => x.ms));
  const sugCold = await ms(() => suggest(q));
  const sugWarm = Math.min(...[await ms(() => suggest(q)), await ms(() => suggest(q)), await ms(() => suggest(q))].map((x) => x.ms));
  timing.push({ q, fastCold: fastCold.ms, fastWarm, sugCold: sugCold.ms, sugWarm, fast: fastCold.value, sug: sugCold.value });
}
console.log("\n=== timings (ms)");
console.log("query".padEnd(14) + "fast cold".padStart(10) + "fast warm".padStart(10) + "suggest cold".padStart(14) + "suggest warm".padStart(14) + "  full cold".padStart(12) + "full warm".padStart(11));
for (const t of timing) {
  const f = full.get(t.q);
  console.log(t.q.padEnd(14) + String(t.fastCold).padStart(10) + String(t.fastWarm).padStart(10) + String(t.sugCold).padStart(14) + String(t.sugWarm).padStart(14) + String(f?.cold ?? "").padStart(12) + String(f?.warm ?? "").padStart(11));
}
for (const q of ["startup"]) if (full.has(q)) console.log(q.padEnd(14) + " ".repeat(48) + String(full.get(q).cold).padStart(12) + String(full.get(q).warm).padStart(11));
console.log("\n=== suggest output");
for (const t of timing) console.log(`  ${t.q.padEnd(8)} ${t.sug.items.map((i) => `[${i.kind}] ${cut(i.label, 34)} (${cut(i.sub, 30)})`).join(" · ") || "(nothing)"}`);
for (const q of ["", "a"]) { const s = await suggest(q); console.log(`  ${JSON.stringify(q).padEnd(8)} popular: ${s.items.map((i) => `[${i.kind}] ${i.label}`).join(" · ")}`); }
console.log("\n=== fast phase output");
for (const t of timing) {
  const g = t.fast.groups;
  console.log(`  ${t.q.padEnd(8)} mode=${t.fast.mode} vague=${t.fast.vague}${t.fast.corrected ? ` corrected ${t.fast.corrected.from}->${t.fast.corrected.to}` : ""} guests=${g.guests.length} episodes=${g.episodes.length} clips=${g.clips.length} topics=${g.topics.length} moments=${g.moments.length} chips=${t.fast.chips.length}`);
}

// ---------- routes ----------
const { GET: searchRoute } = await import("../app/api/search/route.ts");
const { GET: suggestRoute } = await import("../app/api/search/suggest/route.ts");
const as = (name) => { globalThis.__testCookies = name ? { [SESSION_COOKIE]: createSessionToken(name) } : {}; };
const call = async (route, url) => { globalThis.__afterCallbacks = []; const res = await route(new Request(`http://localhost${url}`)); return { status: res.status, body: await res.json(), headers: res.headers, logged: globalThis.__afterCallbacks.length }; };

let failed = 0;
const check = (ok, what) => { console.log(`${ok ? "  ok  " : "  FAIL"}  ${what}`); if (!ok) failed++; };
const nonEmpty = (r) => Object.values(r.groups).some((list) => list.length > 0);
const sayAghori = (r) => r.groups.moments.some((m) => /aghor/i.test(m.snippet));

console.log("\n=== route checks");
as(null);
check((await call(searchRoute, "/api/search?q=ai")).status === 401, "/api/search without a session: 401");
check((await call(suggestRoute, "/api/search/suggest?q=ai")).status === 401, "/api/search/suggest without a session: 401");
as("test-script");
check((await call(searchRoute, "/api/search?q=")).status === 400, "/api/search with no q: 400");
{
  const r = await call(searchRoute, "/api/search?phase=quick&q=khan");
  check(r.status === 200 && Array.isArray(r.body.guests) && Array.isArray(r.body.episodes) && r.body.guests.length > 0, `phase=quick (the command palette): ${r.body.guests?.length} guests, ${r.body.episodes?.length} episodes`);
  check(r.logged === 0, "phase=quick is not logged");
}
{
  const r = await call(suggestRoute, "/api/search/suggest?q=fund");
  check(r.status === 200 && r.body.items.length > 0 && r.body.items.length <= 8 && r.body.items.every((i) => i.kind && i.label && i.sub && i.href), `suggest fund: ${r.body.items?.length} items with kind, label, sub, href`);
  check(r.body.items.some((i) => i.kind === "term" && /fund/i.test(i.label)), "suggest fund: includes the term funding");
  check(r.logged === 0, "suggest is never logged");
}
for (const q of ["", "a"]) { const r = await call(suggestRoute, `/api/search/suggest?q=${encodeURIComponent(q)}`); check(r.status === 200 && r.body.items.length === 8, `suggest ${JSON.stringify(q)}: 8 popular items`); }
{
  const r = await call(searchRoute, "/api/search?q=startup&phase=fast");
  check(r.status === 200 && r.body.phase === "fast" && r.body.groups.moments.length === 0 && r.body.chips.length === 0, "phase=fast: names and titles only, no moments, no chips");
  check(r.logged === 0, "phase=fast is not logged");
}
{
  const r = await call(searchRoute, `/api/search?q=${encodeURIComponent("mental health")}`);
  check(r.status === 200 && r.body.phase === "full" && r.body.groups.moments.length > 0, "phase=full (default): the whole result");
  check(r.logged === 1, "phase=full registers exactly one search event");
  check(r.body.vague ? r.body.chips.length >= 3 : r.body.chips.length === 0, "chips only when vague");
}
{
  const r = await call(searchRoute, `/api/search?q=aghori&scope=${encodeURIComponent(JSON.stringify({ year: 2025 }))}`);
  check(r.status === 200 && nonEmpty(r.body), `scope {year: 2025}: ${r.status}, non-empty`);
}
as("test-limit");
{
  let last = null;
  for (let i = 0; i < 121; i++) last = await call(suggestRoute, "/api/search/suggest?q=ai");
  check(last.status === 429 && last.body.retryAfter >= 1 && last.headers.get("retry-after") && /wait/i.test(last.body.error), `suggest: the 121st request in a minute is 429 (${last.body.error}, retry in ${last.body.retryAfter}s)`);
  for (let i = 0; i < 30; i++) last = await call(searchRoute, "/api/search?q=ai");
  check(last.status === 200, "full search: 30 per minute are allowed");
  last = await call(searchRoute, "/api/search?q=ai");
  check(last.status === 429 && last.body.retryAfter >= 1, `full search: the 31st request in a minute is 429 (${last.body.error})`);
  last = await call(searchRoute, "/api/search?q=ai&phase=fast");
  check(last.status === 200, "the fast phase has its own limit (still allowed)");
}

// ---------- acceptance ----------
console.log("\n=== checks");
for (const [q, r] of results) check(nonEmpty(r), `${JSON.stringify(q)} returns something`);
for (const q of ["ai", "startup"]) {
  const r = results.get(q);
  if (r) check(r.vague && r.chips.length >= 3 && r.chips.length <= 5, `${q}: vague with 3-5 chips (${r.chips.length}: ${r.chips.map((c) => c.label).join(", ")})`);
  const f = full.get(q);
  if (f) check(f.warm < 1500, `${q}: warm full search under 1.5 s (${f.warm} ms)`);
}
for (const [q, r] of results) if (!r.vague) check(r.chips.length === 0, `${JSON.stringify(q)}: not vague, so no chips`);
for (const q of ["aghori", "अघोरी"]) { const r = results.get(q); if (r) check(sayAghori(r), `${q}: the moments include the aghori passages`); }
{ const r = results.get("fundrasing"); if (r) check(r.corrected?.to === "fundraising", `fundrasing corrected to fundraising (${r.corrected ? r.corrected.to : "no correction"})`); }
{
  const r = results.get("raj shamani");
  if (r) check(!r.groups.episodes.some((e) => e.matched) && !r.groups.clips.some((c) => c.matched), "raj shamani: no episode or clip matched by title");
}
{ const r = results.get("how to raise money"); if (r) check(!r.vague, "how to raise money: a question, never vague"); }
{
  const r = results.get("ai");
  if (r) check(!r.groups.guests.some((g) => g.matched && /madhav seth/i.test(g.name)), "ai: no guest attached through a longer alias (Madhav Seth)");
}
for (const t of timing) {
  check(t.fastWarm < 150, `fast phase warm under 150 ms for ${JSON.stringify(t.q)} (${t.fastWarm} ms)`);
  check(t.sugWarm < 100, `suggest warm under 100 ms for ${JSON.stringify(t.q)} (${t.sugWarm} ms)`);
}
{
  const nikh = timing.find((t) => t.q === "nikh");
  if (nikh) check(!nikh.sug.items.some((i) => /nike/i.test(i.label)), "suggest nikh: no fuzzy match to Nike");
}
console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
