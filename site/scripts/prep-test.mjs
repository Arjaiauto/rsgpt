// Builds Prep briefs from a script, with the real search, Supabase and Haiku, and checks them against the database.
//   node --import ./scripts/register.mjs scripts/prep-test.mjs [--log] [--out <folder>]
// Without --log nothing is written to qa_log. --log also writes one qa_log row per brief (first_name "test-script").
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.loadEnvFile(path.resolve(root, "..", ".env"));

const args = process.argv.slice(2);
const log = args.includes("--log");
const out = args.includes("--out") ? path.resolve(args[args.indexOf("--out") + 1]) : null;
if (out) mkdirSync(out, { recursive: true });

const { buildBrief } = await import("../lib/prep/build.ts");
const { Timings } = await import("../lib/ask/timing.ts");
const { briefToText, briefExport, sectionOrder, sectionHeading, sectionCounts, FIRST_APPEARANCE } = await import("../lib/prep/export.ts");
const { briefDocx } = await import("../lib/prep/docx.ts");
const { cleanBrief } = await import("../lib/prep/clean.ts");
const { logQuestion } = await import("../lib/ask/answer.ts");
const { db } = await import("../lib/db.ts");
const { getDirectory } = await import("../lib/guests.ts");

const dir = await getDirectory();
const health = dir.sectors.find((s) => s.key === "health") ?? dir.sectors[0];
// `returning`: the guest has been on the show (the guest sections are checked); false: a made-up first-time guest.
//   --only 1,2 runs just those briefs.
const INPUTS = [
  { label: "returning guest", returning: true, input: { name: "Vaibhav Sisinty", description: "Founder of growth school", sector: null } },
  { label: "new guest (made up)", returning: false, input: { name: "Ira Venkataraman", description: "founder of a D2C skincare brand for Indian skin", sector: null } },
  { label: "name + one line", returning: false, input: { name: "Nikhil Kamath", description: "Co-founder of Zerodha, investor", sector: null } },
  { label: `sector chip (${health.label})`, returning: null, input: { name: "", description: "", sector: health.key } },
];
const only = args.includes("--only") ? args[args.indexOf("--only") + 1].split(",").map(Number) : null;

let failed = 0;
const check = (ok, what) => { if (!ok) { failed += 1; console.log(`  FAIL  ${what}`); } else console.log(`  ok    ${what}`); };

for (const [n, { label, input, returning }] of INPUTS.entries()) {
  if (only && !only.includes(n + 1)) continue;
  console.log(`\n${"=".repeat(78)}\nBRIEF ${n + 1}: ${label}\n${"=".repeat(78)}`);
  const t = new Timings();
  const steps = [];
  const r = await buildBrief(input, { firstName: "Arjun" }, (e) => steps.push(`${e.type}${e.step ? ` ${e.step}` : ""}@${t.since()}ms`), t);
  console.log(`events: ${steps.join(", ")}`);
  console.log(`time: ${(t.since() / 1000).toFixed(1)} s   tokens: ${JSON.stringify(t.tokens)}   stages: ${Object.entries(t.stages).map(([k, v]) => `${k} ${v}ms`).join(", ")}`);
  if ("notFound" in r) { check(false, `brief built (${r.notFound})`); continue; }
  const b = r.brief;
  console.log(`\n${briefToText(b)}\n`);
  const counts = sectionCounts(b);
  console.log(`sections: ${sectionOrder(b).map((k, i) => `${i + 1}. ${sectionHeading(k, b)} (${counts[k]})`).join(" | ")}`);
  if (b.returning) console.log(`already asked, per episode: ${b.returning.asked.map((e) => `${e.date} ${e.questions.length}`).join(", ")}`);
  console.log(`banner: ${briefExport(b).already || "(none)"}\n`);

  console.log("checks:");
  check(b.similar.length === 5, `5 similar guests (${b.similar.length})`);
  check(!input.description || b.description === input.description.charAt(0).toUpperCase() + input.description.slice(1), `description kept as typed, first letter capital ("${b.description}")`);
  const self = b.already?.slug;
  check(!self || (b.similar.every((g) => g.slug !== self) && b.asked.every((q) => q.slug !== self)), "the guest is not among similar guests or their questions");
  const exportHeads = briefExport(b).sections.map((s) => s.heading.replace(/^\d+\. /, ""));
  check(JSON.stringify(exportHeads) === JSON.stringify(sectionOrder(b).map((k) => sectionHeading(k, b))), "exports have the page's sections in the page's order");
  check(b.similar.every((g) => g.why.cites.length > 0 && /^[a-z0-9-]+$/.test(g.slug)), "every similar guest has a cited line and a profile link");
  check(b.asked.length >= 1, `past questions present (${b.asked.length})`);
  check(b.asked.every((q) => q.segmentIds.length > 0 && q.startS >= 0), "every past question has segment ids and a timestamp");
  check(b.verify.every((v) => v.cites.length > 0), `every point to verify is cited (${b.verify.length})`);
  check(b.suggestions.every((s) => s.text.endsWith("?")), `suggestions are questions (${b.suggestions.length})`);
  check(b.topics.length > 0 && b.topics.every((tp) => tp.episodes > 0), `topics have episode counts (${b.topics.length})`);
  check(new Set(b.asked.map((q) => q.guest)).size <= b.similar.length && b.asked.every((q) => b.similar.some((g) => g.slug === q.slug)), "questions are from the guests shown in section 1");

  // Every past question is a verified raj_question row with the same text and time.
  const sameRows = async (list, type) => {
    const ids = list.map((q) => q.insightId);
    if (!ids.length) return true;
    const { data } = await db().from("insights").select("id,video_id,text,start_s,type,verified").in("id", ids);
    return data?.length === ids.length && data.every((row) => {
      const q = list.find((a) => a.insightId === row.id);
      return row.type === type && row.verified && q.text === row.text.trim() && q.videoId === row.video_id && q.startS === row.start_s && q.segmentIds.length > 0;
    });
  };
  check(await sameRows(b.asked, "raj_question"), "past questions match verified raj_question rows exactly");

  if (returning === true) {
    const rt = b.returning;
    check(!!b.already && !!rt && !b.firstAppearance, `returning guest has the guest sections (${b.already?.episodes} episodes)`);
    if (rt) {
      const { getGuestScope } = await import("../lib/guests.ts");
      const own = new Set((await getGuestScope(b.already.slug)).videoIds);
      const asked = rt.asked.flatMap((e) => e.questions);
      check(rt.about.length >= 3 && rt.about.length <= 5 && rt.about.every((l) => l.cites.length > 0 && l.cites.every((c) => own.has(c.videoId))), `About: 3 to 5 sentences, each cited from their own episodes (${rt.about.length})`);
      check(asked.length > 0 && rt.asked.every((e) => e.questions.length <= 5 && own.has(e.videoId) && e.questions.every((q) => q.videoId === e.videoId)), `Already asked: grouped by their episodes, at most 5 each (${asked.length} in ${rt.asked.length} episodes)`);
      check(await sameRows(asked, "raj_question"), "Already asked: verified raj_question rows exactly");
      check(rt.opportunities.every((o) => own.has(o.videoId) && o.category), `Opportunities: from their episodes, with a category (${rt.opportunities.length})`);
      check(await sameRows(rt.opportunities, "opportunity"), "Opportunities: verified opportunity rows exactly");
    }
  } else if (returning === false) {
    check(!b.already && !b.returning && b.firstAppearance && briefExport(b).already === FIRST_APPEARANCE, "new guest: no guest sections, first-appearance line");
  }

  // Every cited moment points at real transcript lines of that episode, at the stated time.
  const cites = [...b.similar.flatMap((g) => g.why.cites), ...b.verify.flatMap((v) => v.cites), ...(b.returning?.about.flatMap((l) => l.cites) ?? [])];
  const segIds = [...new Set(cites.flatMap((c) => c.segmentIds))];
  const { data: segs } = await db().from("segments").select("id,video_id,start_s,end_s").in("id", segIds);
  const seg = new Map((segs ?? []).map((s) => [s.id, s]));
  check(cites.every((c) => c.segmentIds.length > 0 && c.segmentIds.every((id) => {
    const s = seg.get(id);
    return s && s.video_id === c.videoId && s.start_s >= c.startS - 0.6 && s.end_s <= c.endS + 0.6;
  })), `all ${cites.length} citations point at real segments of their episode, inside the stated times`);

  // Save-side checks: the sanitizer keeps a brief whole, and the exports build.
  const round = cleanBrief(JSON.parse(JSON.stringify(b)));
  check(round && JSON.stringify(round) === JSON.stringify(b), "cleanBrief keeps the brief unchanged");
  const ownQ = b.returning?.asked[0]?.questions[0];
  const struck = { ...b, removed: [b.similar[0].id, b.asked[0].id, ...(ownQ ? [ownQ.id, b.returning.about[0]?.id].filter(Boolean) : [])] };
  const text = briefToText(struck);
  check(!text.includes(b.asked[0].text) && !text.includes(b.similar[0].name + (b.similar[0].org ? `, ${b.similar[0].org}` : "") + ":"), "struck-out lines are left out of Copy as text");
  check(!ownQ || (!text.includes(ownQ.text) && (!b.returning.about[0] || !text.includes(b.returning.about[0].text))), "struck-out guest-section lines are left out too");
  check(briefExport(b).sections.length >= 3, "export has its sections");
  const docx = briefDocx(b);
  check(docx.length > 1000 && docx[0] === 0x50 && docx[1] === 0x4b, `docx is a zip (${docx.length} bytes)`);

  if (out) {
    writeFileSync(path.join(out, `brief-${n + 1}.json`), JSON.stringify(b, null, 2));
    writeFileSync(path.join(out, `brief-${n + 1}.txt`), briefToText(b));
    writeFileSync(path.join(out, `brief-${n + 1}.docx`), docx);
    writeFileSync(path.join(out, `brief-${n + 1}-struck.docx`), briefDocx(struck));
  }
  if (log) {
    const id = await logQuestion({ question: `[script] ${b.title}`, language: "en", answer: briefToText(b), citedChunkIds: r.citedChunkIds, found: true, firstName: "test-script", visitorId: null, latencyMs: t.since(), timings: t, kind: "brief" });
    console.log(`qa_log row: ${id}`);
  }
}

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
