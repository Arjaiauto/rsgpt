// "From the web" for three people, with the real Tavily and Groq, checked line by line. Nothing is written to qa_log.
//   node --import ./scripts/register.mjs scripts/prep-web-test.mjs [--only 1,3]
// About 4 Tavily searches (5 to 6 credits) and one Groq call per person.
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.loadEnvFile(path.resolve(root, "..", ".env"));
const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",").map(Number) : null;

const { webResearch } = await import("../lib/prep/web.ts");
const { sameGuest } = await import("../lib/prep/build.ts");
const { getDirectory } = await import("../lib/guests.ts");
const { cleanBrief } = await import("../lib/prep/clean.ts");
const { briefToText, briefExport, webGroups, sectionOrder, NOT_IDENTIFIED } = await import("../lib/prep/export.ts");
const { briefDocx } = await import("../lib/prep/docx.ts");

const dir = await getDirectory();
// `expect`: "returning" (in the archive), "public" (a real person not in the archive), "none" (made up).
const PEOPLE = [
  { name: "Vaibhav Sisinty", description: "Founder of GrowthSchool", expect: "returning" },
  { name: "Sridhar Vembu", description: "Founder of Zoho", expect: "public" },
  { name: "Zorvath Kelmindar", description: "Founder of a D2C skincare brand", expect: "none" },
];

let failed = 0;
const check = (ok, what) => { if (!ok) { failed += 1; console.log(`  FAIL  ${what}`); } else console.log(`  ok    ${what}`); };
const PERSONAL = /\b(wife|husband|married|daughter|son|children|family|health|address|phone|email|net worth)\b/i;
// A brief with only a title and the web section, for the export and save checks.
const shell = (name, description, web) => ({
  version: 1, title: name, description, sector: null, builtAt: new Date().toISOString(), preparedFor: "Arjun", archiveEpisodes: 0,
  already: null, firstAppearance: false, returning: null, web, similar: [{ id: "g-x", slug: "x", name: "X", org: null, photoUrl: null, tags: [],
    why: { id: "w-x", text: "X said something.", cites: [{ chunkId: 1, videoId: "abc", startS: 1, endS: 2, segmentIds: [1], speaker: "X", date: "", episode: "", guest: "X" }] } }],
  asked: [], topics: [], suggestions: [], verify: [], removed: [],
});

for (const [i, p] of PEOPLE.entries()) {
  if (only && !only.includes(i + 1)) continue;
  const same = sameGuest(p.name, dir.guests);
  console.log(`\n${"=".repeat(78)}\n${i + 1}. ${p.name} (${p.description}) — in archive: ${same ? `yes, latest episode ${same.latest.slice(0, 10)}` : "no"}\n${"=".repeat(78)}`);
  let results = [];
  const t0 = Date.now();
  const w = await webResearch({ name: p.name, description: p.description, lastEpisode: same?.latest ?? null }, (urls) => { results = urls; });
  console.log(`time ${((Date.now() - t0) / 1000).toFixed(1)} s, ${results.length} search results`);
  console.log(`Matched: ${w.matched ?? NOT_IDENTIFIED}`);
  for (const g of webGroups(w)) {
    console.log(`  ${g.heading}: ${g.lines.length}${g.lines.length ? "" : ` (${g.empty})`}`);
    for (const l of g.lines.slice(0, 2)) console.log(`    - ${l.text}${l.date ? ` [${l.date}]` : ""}\n      ${l.url}`);
  }
  const all = [...w.background, ...w.news, ...w.appearances, ...w.since];

  console.log("checks:");
  check((p.expect === "returning") === !!same, `archive check: ${p.expect === "returning" ? "is" : "is not"} a past guest`);
  if (p.expect === "none") check(!w.matched && all.length === 0, "made-up name: not identified, no facts");
  else check(!!w.matched && w.background.length > 0, "identified, with a background");
  check(all.every((l) => results.includes(l.url)), `every line's URL came back from this request's search results (${all.length} lines)`);
  check(all.every((l) => !/raj\s*shamani|figuring\s*out/i.test(`${l.url} ${l.text}`)), "no Figuring Out / Raj Shamani appearances");
  check(all.every((l) => !PERSONAL.test(l.text)), "no personal-life lines");
  check(w.news.every((l, j) => l.date && (j === 0 || w.news[j - 1].date >= l.date)), "news is dated, newest first");
  if (p.expect === "returning") check(w.lastEpisode && w.since.every((l) => l.date > w.lastEpisode.slice(0, 10)), `since-last-episode items are after ${w.lastEpisode?.slice(0, 10)} (${w.since.length})`);
  else check(!w.lastEpisode && w.since.length === 0, "no since-last-episode sub-section");

  // Export and save: the section is first, carries its URLs, survives cleanBrief, and struck lines leave the exports.
  const b = shell(p.name, p.description, w);
  check(sectionOrder(b)[0] === "web" && briefExport(b).sections[0].heading === "1. From the web", "From the web is section 1 on the page and in the exports");
  const text = briefToText(b);
  check(all.every((l) => text.includes(l.url)) && (w.matched ? text.includes(`Matched: ${w.matched}`) : text.includes(NOT_IDENTIFIED)), "Copy as text has the Matched line and every URL");
  const docx = new TextDecoder().decode(briefDocx(b));
  check(all.every((l) => docx.includes(l.url.replace(/&/g, "&amp;"))), "Word file shows every URL");
  check(JSON.stringify(cleanBrief(JSON.parse(JSON.stringify(b)))) === JSON.stringify(b), "Save keeps the section unchanged");
  if (all.length) check(!briefToText({ ...b, removed: [all[0].id] }).includes(`- ${all[0].text}`), "a removed web line is left out of Copy as text");
}

// A brief saved before this change (no `web` field) still opens, without the section.
const old = { version: 1, title: "Old brief", description: "", sector: null, builtAt: "2026-10-30T00:00:00Z", preparedFor: "A", archiveEpisodes: 1, already: null,
  similar: [{ id: "g-x", slug: "x", name: "X", org: null, photoUrl: null, tags: [], why: { id: "w-x", text: "X said something.", cites: [{ chunkId: 1, videoId: "abc", startS: 1, endS: 2, segmentIds: [1], speaker: "X", date: "", episode: "", guest: "X" }] } }],
  asked: [], topics: [], suggestions: [], verify: [], removed: [] };
const reopened = cleanBrief(old);
console.log("\nold briefs:");
check(reopened && reopened.web === null && sectionOrder(reopened)[0] === "similar", "a brief saved before this change opens without the web section");

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
