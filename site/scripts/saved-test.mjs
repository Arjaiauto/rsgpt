// Exercises the Saved page's server actions against the real database as first name "test-script", then deletes every
// row it made.
//   node --import ./scripts/register.mjs scripts/saved-test.mjs
// Rows are made under two throwaway visitor ids (test-saved-23a, test-saved-other) and removed by those ids at the end.
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.loadEnvFile(path.resolve(root, "..", ".env"));

const { createSessionToken, SESSION_COOKIE, VISITOR_COOKIE } = await import("../lib/session.ts");
const A = await import("../app/actions/saved.ts");
const { savedClipsCsv } = await import("../lib/saved-csv.ts");
const { stashAnswerForAsk } = await import("../lib/ask/reopen.ts");
const { db } = await import("../lib/db.ts");

const NAME = "test-script";
const V1 = "test-saved-23a";
const V2 = "test-saved-other";
const as = (firstName, visitor) => { globalThis.__testCookies = { [SESSION_COOKIE]: createSessionToken(firstName), ...(visitor ? { [VISITOR_COOKIE]: visitor } : {}) }; };

let failed = 0;
const check = (ok, what) => { if (!ok) { failed += 1; console.log(`  FAIL  ${what}`); } else console.log(`  ok    ${what}`); };
const cite = (videoId, startS, speaker = "Guest A") => ({ chunkId: 1, videoId, startS, endS: startS + 40, segmentIds: [1, 2], speaker, date: "Mar 2025", episode: "Episode one", guest: "Guest A" });
const clip = (n) => ({ kind: "clip", ref: { videoId: `vid${n}`, startS: 60 * n, endS: 60 * n + 45, title: `Clip title ${n}`, guest: `Guest ${n}`, episode: `Episode ${n}`, date: "Mar 2025" } });
const answer = (n) => ({ kind: "answer", ref: { question: `Question ${n}?`, answer: `First sentence ${n}. Second sentence ${n}.\n\nSecond paragraph ${n}.`, citations: [cite("vidA", 10), cite("vidA", 90), cite(`vidB${n}`, 30, "Raj Shamani")] } });
const brief = (n) => ({ kind: "brief", ref: {
  version: 1, title: `Brief guest ${n}`, description: `Founder ${n}`, sector: null, builtAt: new Date().toISOString(), preparedFor: "T", archiveEpisodes: 5, already: null, firstAppearance: true, returning: null, web: null,
  similar: [{ id: "g-x", slug: "guest-x", name: "Guest X", org: null, photoUrl: null, tags: [], why: { id: "w-x", text: "Guest X said something.", cites: [cite("vidA", 5)] } }],
  asked: [], topics: [{ id: "t-ai", tag: "AI", episodes: 3, examples: [] }], suggestions: [{ id: "u1", text: "Why?" }], verify: [], removed: [] } });

const made = [];
const seed = async (input) => { const r = await A.saveItem(input); if (!r.ok) throw new Error(`seed failed: ${r.error}`); made.push(r.id); return r.id; };

try {
  console.log("\nSeeding 3 clips, 3 answers, 3 briefs as test-script");
  as(NAME, V1);
  const ids = { clip: [], answer: [], brief: [] };
  for (const n of [1, 2, 3]) { ids.clip.push(await seed(clip(n))); ids.answer.push(await seed(answer(n))); ids.brief.push(await seed(brief(n))); }

  console.log("\nlist");
  let list = await A.listSaved();
  check(list.firstName === NAME, `label name is the signed-in first name (${list.firstName})`);
  check(list.clips.length === 3 && list.answers.length === 3 && list.briefs.length === 3, `3 / 3 / 3 per tab (${list.clips.length}/${list.answers.length}/${list.briefs.length})`);
  check(list.clips[0].id === ids.clip[2] && list.clips[2].id === ids.clip[0], "newest first");
  const a1 = list.answers.find((a) => a.id === ids.answer[0]);
  check(a1.preview === "First sentence 1." && a1.sources === 2, `answer preview is the first sentence, sources counted by episode (${a1.sources})`);
  const b1 = list.briefs.find((b) => b.id === ids.brief[0]);
  check(b1.title === "Brief guest 1" && b1.sections >= 3, `brief summary has title and section count (${b1.sections})`);
  check(list.clips.every((c) => c.folder === null && c.note === "") && !list.capped, "no folders or notes yet; not capped");

  console.log("\nscoping (same exact rule as saving: first name and visitor cookie)");
  as(NAME, V2); let other = await A.listSaved();
  check(other.clips.length + other.answers.length + other.briefs.length === 0, "same first name, other browser: sees nothing");
  as("test-other", V1); other = await A.listSaved();
  check(other.clips.length + other.answers.length + other.briefs.length === 0, "other first name, same browser: sees nothing");
  as("test-other", V1);
  check(!(await A.moveSaved(ids.clip[0], "Hack")).ok && !(await A.noteSaved(ids.clip[0], "x")).ok && !(await A.removeSaved(ids.clip[0])).ok, "move / note / remove on someone else's item all fail");
  check((await A.loadSavedAnswer(ids.answer[0])) === null, "someone else's answer cannot be opened");
  as(NAME, V1);

  console.log("\nfolders");
  let r = await A.moveSaved(ids.clip[0], "Reel ideas");
  check(r.ok && r.folder === "Reel ideas", "move into a new folder");
  r = await A.moveSaved(ids.clip[1], "  reel   IDEAS ");
  check(r.ok && r.folder === "Reel ideas", `same name apart from capitals and spaces joins the existing folder (${r.folder})`);
  r = await A.moveSaved(ids.answer[0], "x".repeat(60) + "\u0000\u0007");
  check(r.ok && r.folder.length <= 40 && !/[\u0000-\u001F]/.test(r.folder), `long name cut to 40, control characters out (${r.folder.length})`);
  r = await A.moveSaved(ids.brief[0], "Guest prep");
  list = await A.listSaved();
  const inUse = [...new Set([...list.clips, ...list.answers, ...list.briefs].map((i) => i.folder).filter(Boolean))];
  check(inUse.length === 3 && list.clips.filter((c) => c.folder === "Reel ideas").length === 2, `folders in use come from the items (${inUse.length}): ${inUse.map((f) => f.slice(0, 12)).join(", ")}`);
  await A.moveSaved(ids.brief[0], null);
  list = await A.listSaved();
  check(!list.briefs.some((b) => b.folder === "Guest prep") && ![...list.clips, ...list.answers, ...list.briefs].some((i) => i.folder === "Guest prep"), "a folder disappears when its last item leaves");
  check(!(await A.moveSaved(999999999, "X")).ok, "moving an item that does not exist fails");

  console.log("\nnotes (autosave target)");
  check((await A.noteSaved(ids.clip[0], "use for Monday reel")).ok, "note saved");
  await A.noteSaved(ids.clip[1], "n".repeat(700));
  await A.noteSaved(ids.clip[2], "   ");
  list = await A.listSaved();
  const note = (id) => list.clips.find((c) => c.id === id).note;
  check(note(ids.clip[0]) === "use for Monday reel", "note comes back in the list");
  check(note(ids.clip[1]).length === 500, `note cut to 500 (${note(ids.clip[1]).length})`);
  check(note(ids.clip[2]) === "", "blank note clears it");

  console.log("\nremove + undo");
  const removed = await A.removeSaved(ids.clip[0]);
  check(removed.ok && removed.row.kind === "clip" && removed.row.note === "use for Monday reel" && removed.row.folder === "Reel ideas", "remove returns the row with its folder and note");
  list = await A.listSaved();
  check(list.clips.length === 2 && !list.clips.some((c) => c.id === ids.clip[0]), "item is gone from the list");
  const back = await A.restoreSaved(removed.row);
  check(back.ok, "restore works");
  if (back.ok) made.push(back.id);
  list = await A.listSaved();
  const again = list.clips.find((c) => c.id === back.id);
  check(list.clips.length === 3 && again && again.folder === "Reel ideas" && again.note === "use for Monday reel" && again.createdAt === list.clips.find((c) => c.id === back.id).createdAt, "restored with its folder and note");
  check(Math.abs(new Date(again.createdAt) - new Date(removed.row.createdAt)) < 1000 && list.clips[2].id === back.id, "restored with its original date, so it sits in its old place");
  check(!(await A.restoreSaved({ ...removed.row, kind: "weird" })).ok, "restore refuses an unknown kind");
  check(!(await A.restoreSaved({ kind: "answer", itemRef: { question: "q", answer: "no sources", citations: [] }, folder: null, note: "", createdAt: new Date().toISOString() })).ok, "restore refuses an answer with no citations");
  const sneaky = await A.restoreSaved({ kind: "clip", itemRef: { videoId: "vidZ", startS: 1, endS: 2, title: "T", guest: "G", episode: "E", evil: "<script>", admin: true }, folder: "F", note: "N", createdAt: "2999-01-01T00:00:00Z" });
  if (sneaky.ok) made.push(sneaky.id);
  const { data: raw } = await db().from("saved_items").select("item_ref,created_at").eq("id", sneaky.id).single();
  check(sneaky.ok && !("evil" in raw.item_ref) && !("admin" in raw.item_ref) && new Date(raw.created_at) < new Date(Date.now() + 5000), "restore cuts the content down like a new save and refuses a future date");
  await A.removeSaved(sneaky.id);
  made.splice(made.indexOf(sneaky.id), 1);

  console.log("\nopen answer in Ask");
  const full = await A.loadSavedAnswer(ids.answer[1]);
  check(full && full.question === "Question 2?" && full.answer.includes("\n\n") && full.citations.length === 3, "whole answer and its citations are read when opened");
  const store = new Map();
  globalThis.sessionStorage = { setItem: (k, v) => store.set(k, v), getItem: (k) => store.get(k) ?? null, removeItem: (k) => store.delete(k) };
  check(stashAnswerForAsk(full), "answer is put in the Ask thread");
  const turns = JSON.parse(store.get("cp-ask-thread"));
  check(turns.length === 1 && turns[0].status === "done" && turns[0].q === "Question 2?" && turns[0].blocks[0].cites.length === 3 && turns[0].sources.length === 2, "thread has one finished turn with every citation and 2 source episodes");
  check(turns[0].blocks[0].cites.every((c) => c.speaker !== "Host") && !store.has("cp-ask-scope"), "no stale guest scope; citations keep their speakers");

  console.log("\nCSV export");
  list = await A.listSaved();
  await A.noteSaved(ids.clip[2], '=HYPERLINK("http://x","hi"), "quoted"\nsecond line, नमस्ते');
  list = await A.listSaved();
  const csv = savedClipsCsv(list.clips);
  const lines = csv.replace(/^﻿/, "").split("\r\n").filter(Boolean);
  check(csv.startsWith("﻿Title,Guest,Episode,Date,Start (s),End (s),YouTube link,Folder,Note\r\n"), "header row and byte-order mark");
  check(csv.includes("https://www.youtube.com/watch?v=vid1&t=60s") && csv.includes("Reel ideas"), "YouTube link with the start time, and the folder");
  check(csv.includes("'=HYPERLINK") && !csv.includes(",=HYPERLINK") && csv.includes('""quoted""') && csv.includes("नमस्ते"), "formula cell neutralised, quotes escaped, Hindi kept");
  console.log(`  (${lines.length - 1} clip rows in the file besides the header; the multi-line note stays inside one quoted cell)`);
  check(savedClipsCsv([]) === "﻿Title,Guest,Episode,Date,Start (s),End (s),YouTube link,Folder,Note\r\n", "no clips: header only");

  console.log("\nspeed with 250 extra clips");
  const bulk = Array.from({ length: 250 }, (_, i) => ({ first_name: NAME, visitor_id: V1, kind: "clip", item_ref: clip(100 + i).ref, folder: i % 7 ? `Folder ${i % 7}` : null, note: i % 3 ? `note ${i}` : null }));
  const { data: ins, error } = await db().from("saved_items").insert(bulk).select("id");
  if (error) throw new Error(error.message);
  made.push(...ins.map((x) => x.id));
  const t0 = Date.now();
  list = await A.listSaved();
  const ms = Date.now() - t0;
  const bytes = JSON.stringify(list).length;
  check(list.clips.length === 253, `all 253 clips come back (${list.clips.length})`);
  console.log(`  listSaved: ${ms} ms, ${(bytes / 1024).toFixed(0)} KB of JSON to the page`);
  check(ms < 3000 && bytes < 600_000, "fast enough and small enough");
} finally {
  // Everything made here goes: by the ids kept, and by the two throwaway visitor ids as a sweep.
  const a = await db().from("saved_items").delete().in("id", made.length ? made : [-1]);
  const b = await db().from("saved_items").delete().eq("first_name", NAME).in("visitor_id", [V1, V2]);
  const c = await db().from("saved_items").delete().eq("first_name", "test-other").eq("visitor_id", V1);
  const { count } = await db().from("saved_items").select("id", { count: "exact", head: true }).in("visitor_id", [V1, V2]);
  const { count: total } = await db().from("saved_items").select("id", { count: "exact", head: true });
  console.log(`\ncleanup: ${[a, b, c].some((x) => x.error) ? "ERROR " + [a, b, c].map((x) => x.error?.message).join(" ") : "ok"}; test rows left: ${count}; saved_items rows in total: ${total}`);
  if (count !== 0) failed += 1;
}

console.log(failed ? `\n${failed} check(s) FAILED` : "\nall checks passed");
process.exit(failed ? 1 : 0);
