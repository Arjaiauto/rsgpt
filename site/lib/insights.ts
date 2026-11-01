import "server-only";
import { cacheLife } from "next/cache";
import { getClipIndex } from "@/lib/clips";
import { timed } from "@/lib/data-log";
import { allRows as all, db } from "@/lib/db";
import { fmtMonth, fmtViews, yearOf } from "@/lib/guest-format";
import { getDirectory, getGuestVideos } from "@/lib/guests";
import {
  MIN_GROUP, type BestClip, type Group, type GuestStat, type Insights, type MonthPoint, type Spread, type ThumbInsights, type ThumbPattern,
  type TopicRow, type Usage,
} from "@/lib/insights-types";

/** The Insights page counts everything here on the server, from the same cached rows as the Guests and Clips pages plus
    the transcribed episodes, and keeps the result for an hour (usage for ten minutes). Only the aggregates go to the
    browser. Takeaway sentences are written from the numbers; a group under MIN_GROUP episodes is left out of them. */

type EpisodeRow = {
  video_id: string; title: string; published_at: string | null; duration_seconds: number | null;
  view_count: number | null; like_count: number | null; caption_language: string | null;
};

/* ---------- statistics ---------- */

const quantile = (sorted: number[], p: number) => {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
};

export function spread(values: number[]): Spread {
  const s = [...values].sort((a, b) => a - b);
  return { n: s.length, median: quantile(s, 0.5), mean: s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0, p25: quantile(s, 0.25), p75: quantile(s, 0.75) };
}

/** "a Film guest", "an Education guest" */
const aGuest = (label: string) => `${/^[aeiou]/i.test(label) ? "an" : "a"} ${label} guest`;
const num = (v: number) => v.toLocaleString("en-IN");
const pct = (n: number, of: number) => (of ? Math.round((100 * n) / of) : 0);
const IST_OFFSET_MS = 5.5 * 3600_000;
/** "2025-03", the month an episode came out in India time. */
const monthKey = (iso: string) => new Date(Date.parse(iso) + IST_OFFSET_MS).toISOString().slice(0, 7);

/** "Episodes over 2 hours get a 1.4x higher median view count than episodes under 1 hour (1.2M vs 860K)." */
function compare(a: { phrase: string; median: number }, b: { phrase: string; median: number }, unit = "view count", fmt = fmtViews): string {
  const r = b.median ? a.median / b.median : 0;
  const both = `${fmt(a.median)} vs ${fmt(b.median)}`;
  const A = a.phrase[0].toUpperCase() + a.phrase.slice(1);
  if (r >= 1.05) return `${A} get a ${r.toFixed(1)}x higher median ${unit} than ${b.phrase} (${both}).`;
  if (r > 0 && r <= 0.95) return `${A} get a lower median ${unit} than ${b.phrase}: ${both}, or ${r.toFixed(1)}x.`;
  return `${A} and ${b.phrase} get about the same median ${unit} (${both}).`;
}

/** The episode-length groups of the Insights page, also the groups of the home page's chart (lib/home-explorer.ts). */
export const LENGTH_BANDS: { key: string; label: string; phrase: string; test: (e: { minutes: number }) => boolean }[] = [
  { key: "u60", label: "Under 1 hour", phrase: "episodes under 1 hour", test: (e) => e.minutes < 60 },
  { key: "60-90", label: "1 to 1.5 hours", phrase: "episodes of 1 to 1.5 hours", test: (e) => e.minutes >= 60 && e.minutes < 90 },
  { key: "90-120", label: "1.5 to 2 hours", phrase: "episodes of 1.5 to 2 hours", test: (e) => e.minutes >= 90 && e.minutes < 120 },
  { key: "o120", label: "Over 2 hours", phrase: "episodes over 2 hours", test: (e) => e.minutes >= 120 },
];

type Banded = Group & { phrase: string };
/** Groups of episodes with their views spread; groups under MIN_GROUP are returned as hidden labels. */
function groups<E>(eps: E[], defs: { key: string; label: string; phrase: string; test: (e: E) => boolean }[], value: (e: E) => number) {
  const shown: Banded[] = [], hidden: string[] = [];
  for (const d of defs) {
    const vals = eps.filter(d.test).map(value);
    if (vals.length >= MIN_GROUP) shown.push({ key: d.key, label: d.label, phrase: d.phrase, ...spread(vals) });
    else if (vals.length) hidden.push(`${d.label} (${vals.length} episodes)`);
  }
  return { shown, hidden };
}
const bare = (g: Banded): Group => ({ key: g.key, label: g.label, n: g.n, median: g.median, mean: g.mean, p25: g.p25, p75: g.p75 });

/* ---------- the archive ---------- */

export async function getInsights(): Promise<Insights> {
  "use cache: remote";
  cacheLife({ stale: 300, revalidate: 3600, expire: 86400 });
  return timed("getInsights", () => readInsights());
}

async function readInsights(): Promise<Insights> {
  const [dir, guestVideos, { clips, options }, rows] = await Promise.all([
    getDirectory(),
    getGuestVideos(),
    getClipIndex(),
    all<EpisodeRow>((a, b) => db().from("episodes").select("video_id,title,published_at,duration_seconds,view_count,like_count,caption_language")
      .eq("status", "transcribed").order("video_id").range(a, b)),
  ]);
  const eps = rows.filter((e) => e.published_at).map((e) => ({
    id: e.video_id, at: e.published_at!, year: yearOf(e.published_at)!, month: monthKey(e.published_at!),
    minutes: (e.duration_seconds ?? 0) / 60, views: Number(e.view_count ?? 0), likes: Number(e.like_count ?? 0),
    lang: e.caption_language === "hi" ? ("hi" as const) : ("en" as const),
  })).sort((a, b) => a.at.localeCompare(b.at));

  // Guests of each episode (verified rows on the directory) and the episode's topics: its guests' sector tags.
  const guestBySlug = new Map(dir.guests.map((g) => [g.slug, g]));
  const slugsOf = new Map<string, string[]>();
  for (const r of guestVideos) {
    if (!guestBySlug.has(r.slug)) continue;
    const list = slugsOf.get(r.videoId) ?? slugsOf.set(r.videoId, []).get(r.videoId)!;
    if (!list.includes(r.slug)) list.push(r.slug);
  }
  const sectorKeys = new Set(dir.sectors.map((s) => s.key));
  const topicsOf = (videoId: string) =>
    new Set((slugsOf.get(videoId) ?? []).flatMap((s) => guestBySlug.get(s)!.tags.map((t) => t.toLowerCase())).filter((t) => sectorKeys.has(t)));

  /* overview */
  const langN = { hi: eps.filter((e) => e.lang === "hi").length, en: eps.filter((e) => e.lang === "en").length };
  const overview: Insights["overview"] = {
    episodes: eps.length, guests: dir.guests.length, hours: Math.round(eps.reduce((n, e) => n + e.minutes, 0) / 60), clips: clips.length,
    first: eps[0]?.at ?? "", last: eps.at(-1)?.at ?? "",
    langs: (["hi", "en"] as const).map((code) => ({ code, label: code === "hi" ? "Hindi" : "English", n: langN[code] })).filter((l) => l.n > 0),
  };

  /* topics */
  const epTopics = new Map(eps.map((e) => [e.id, topicsOf(e.id)]));
  const clipN = new Map(options.topics.map((t) => [t.key, t.n]));
  const topicRows: TopicRow[] = dir.sectors.map((s) => ({
    key: s.key, label: s.label, episodes: eps.filter((e) => epTopics.get(e.id)!.has(s.key)).length, clips: clipN.get(s.key) ?? 0,
  })).filter((t) => t.episodes > 0).sort((a, b) => b.episodes - a.episodes || a.label.localeCompare(b.label));
  const top = topicRows[0];
  const topicsTakeaway = top
    ? `${top.label} is the most common guest topic: ${num(top.episodes)} of ${num(eps.length)} episodes (${pct(top.episodes, eps.length)}%) have ${aGuest(top.label)}.`
    : "";

  const years = [...new Set(eps.map((e) => e.year))].sort((a, b) => a - b);
  const totals = years.map((y) => eps.filter((e) => e.year === y).length);
  const mixRows = topicRows.slice(0, 8).map((t) => ({
    key: t.key, label: t.label, counts: years.map((y) => eps.filter((e) => e.year === y && epTopics.get(e.id)!.has(t.key)).length),
  }));
  const lastAt = eps.at(-1)?.at;
  const partial = lastAt && monthKey(lastAt).slice(5) !== "12" ? `${years.at(-1)} runs to ${fmtMonth(lastAt)}` : null;
  // The topic whose share moved most between the first and the latest year (both with MIN_GROUP episodes or more).
  let mixTakeaway = "";
  const yi = years.map((_, i) => i).filter((i) => totals[i] >= MIN_GROUP);
  if (yi.length >= 2) {
    const [a, b] = [yi[0], yi.at(-1)!];
    const moved = mixRows.map((r) => ({ r, from: pct(r.counts[a], totals[a]), to: pct(r.counts[b], totals[b]) }))
      .sort((x, y) => Math.abs(y.to - y.from) - Math.abs(x.to - x.from))[0];
    if (moved) {
      mixTakeaway = moved.to === moved.from
        ? `The topic mix barely moved: ${moved.r.label}, the biggest change, stayed at ${moved.to}% of episodes from ${years[a]} to ${years[b]}.`
        : `${moved.r.label} ${moved.to > moved.from ? "rose" : "fell"} from ${moved.from}% of ${years[a]} episodes to ${moved.to}% in ${years[b]}, the biggest change in the mix.`;
    }
  }

  /* guests */
  const gstats: GuestStat[] = dir.guests.map((g) => ({ slug: g.slug, name: g.name, episodes: g.episodes, views: g.views, avgViews: g.episodes ? g.views / g.episodes : 0 }));
  const most = [...gstats].filter((g) => g.episodes >= 2).sort((a, b) => b.episodes - a.episodes || b.views - a.views).slice(0, 8);
  const topAvg = [...gstats].sort((a, b) => b.avgViews - a.avgViews).slice(0, 8);
  const repeat = gstats.filter((g) => g.episodes >= 2).length;
  // An episode has a returning guest when one of its guests was on an earlier episode.
  const seen = new Set<string>();
  const withGuest = eps.filter((e) => slugsOf.has(e.id)).map((e) => {
    const s = slugsOf.get(e.id)!;
    const returning = s.some((x) => seen.has(x));
    s.forEach((x) => seen.add(x));
    return { ...e, returning };
  });
  const ret = groups(withGuest, [
    { key: "first", label: "First appearance", phrase: "first appearances", test: (e) => !e.returning },
    { key: "returning", label: "Returning guest", phrase: "episodes with a returning guest", test: (e) => e.returning },
  ], (e) => e.views);
  const returningTakeaway = ret.shown.length === 2 ? compare(ret.shown[1], ret.shown[0]) : "";

  /* performance */
  const byMonth = new Map<string, typeof eps>();
  for (const e of eps) (byMonth.get(e.month) ?? byMonth.set(e.month, []).get(e.month)!).push(e);
  const months: MonthPoint[] = [...byMonth].map(([key, list]) => ({
    key, label: fmtMonth(list[0].at), n: list.length, views: spread(list.map((e) => e.views)), likes: spread(list.map((e) => e.likes)),
  }));
  // The latest 12 months against the 12 before them.
  const keys = months.map((m) => m.key);
  const recent = new Set(keys.slice(-12)), before = new Set(keys.slice(-24, -12));
  const inR = eps.filter((e) => recent.has(e.month)), inB = eps.filter((e) => before.has(e.month));
  const span = (s: Set<string>) => { const k = [...s].sort(); return `${fmtMonth(`${k[0]}-15`)} to ${fmtMonth(`${k.at(-1)}-15`)}`; };
  let viewsTakeaway = "", likesTakeaway = "";
  if (inR.length >= MIN_GROUP && inB.length >= MIN_GROUP) {
    viewsTakeaway = compare(
      { phrase: `episodes from ${span(recent)}`, median: spread(inR.map((e) => e.views)).median },
      { phrase: `the 12 months before`, median: spread(inB.map((e) => e.views)).median },
    ) + " Newer episodes have had less time to collect views.";
    const rate = (l: typeof eps) => spread(l.filter((e) => e.views > 0).map((e) => (1000 * e.likes) / e.views)).median;
    const [r1, r0] = [rate(inR), rate(inB)];
    likesTakeaway = `Episodes from ${span(recent)} get a median of ${r1.toFixed(1)} likes per 1,000 views, against ${r0.toFixed(1)} in the 12 months before.`;
  }

  const len = groups(eps, LENGTH_BANDS, (e) => e.views);
  const lengthTakeaway = len.shown.length >= 2 ? compare(len.shown.at(-1)!, len.shown[0]) : "";
  const lang = groups(eps, [
    { key: "hi", label: "Hindi", phrase: "Hindi episodes", test: (e) => e.lang === "hi" },
    { key: "en", label: "English", phrase: "English episodes", test: (e) => e.lang === "en" },
  ], (e) => e.views);
  const langTakeaway = lang.shown.length === 2 ? compare(lang.shown[0], lang.shown[1]) : "";

  /* best clips: the topics with the most clips, their three best clips (by score, then the episode's views), no clip twice */
  const shownIds = new Set<number>();
  const bestTopics = [...options.topics].sort((a, b) => b.n - a.n).slice(0, 6).map((t) => {
    const pick = clips.filter((c) => c.topics.includes(t.key) && !shownIds.has(c.id))
      .sort((a, b) => b.score - a.score || b.views - a.views || a.id - b.id).slice(0, 3);
    pick.forEach((c) => shownIds.add(c.id));
    return {
      key: t.key, label: t.label,
      clips: pick.map((c): BestClip => ({ id: c.id, videoId: c.videoId, startS: c.startS, endS: c.endS, topic: c.topic, guest: c.guest, episode: c.episode, date: c.date, score: c.score })),
    };
  }).filter((t) => t.clips.length);
  const maxScore = Math.max(0, ...clips.map((c) => c.score));
  const atMax = clips.filter((c) => c.score === maxScore);
  const maxBy = options.topics.map((t) => ({ t, n: atMax.filter((c) => c.topics.includes(t.key)).length })).sort((a, b) => b.n - a.n)[0];
  const bestTakeaway = atMax.length && maxBy?.n
    ? `${num(atMax.length)} of ${num(clips.length)} clips have the top score of ${maxScore.toFixed(2)}; ${maxBy.n} of them have ${aGuest(maxBy.t.label)}, more than any other topic.`
    : "";

  return {
    overview,
    topics: { rows: topicRows, mix: { years, totals, partial, rows: mixRows }, takeaway: topicsTakeaway, mixTakeaway },
    guests: {
      total: gstats.length, repeat, most, topAvg, returning: ret.shown.map(bare), hidden: ret.hidden,
      takeaway: most[0]
        ? `${num(repeat)} of ${num(gstats.length)} guests (${pct(repeat, gstats.length)}%) came back for more than one episode; ${most[0].name} appeared most, in ${most[0].episodes}.`
        : `None of the ${gstats.length} guests appeared more than once.`,
      avgTakeaway: topAvg[0] ? `${topAvg[0].name}'s episodes average ${fmtViews(Math.round(topAvg[0].avgViews))} views, the most of any guest.` : "",
      returningTakeaway,
    },
    performance: {
      months, length: len.shown.map(bare), lang: lang.shown.map(bare), hidden: [...len.hidden, ...lang.hidden],
      viewsTakeaway, likesTakeaway, lengthTakeaway, langTakeaway,
    },
    best: { topics: bestTopics, takeaway: bestTakeaway },
    countedAt: new Date().toISOString(),
  };
}

/* ---------- use of Cuepoint ---------- */

/** Test runs are not use: rows from people flagged is_test in public.visitors (the owner and test names) and rows with
    no first name (early test visits before login asked for one) are left out of every usage count. If that lookup
    fails, EXCLUDED_NAMES is the fallback. Web research calls of the Prep brief are logged as kind 'brief' with the
    question "[web] name - line"; they are counted on their own. */
export const EXCLUDED_NAMES = ["test-script", "tester"];

async function testNames(): Promise<Set<string>> {
  try {
    const rows = await all<{ name_key: string }>((a, b) => db().from("visitors").select("name_key").eq("is_test", true).order("id").range(a, b));
    return new Set(rows.map((r) => r.name_key.toLowerCase()));
  } catch (e) {
    console.warn("insights: visitors.is_test unavailable, using EXCLUDED_NAMES:", e instanceof Error ? e.message : e);
    return new Set(EXCLUDED_NAMES.map((n) => n.toLowerCase()));
  }
}
const realUse = (test: Set<string>) => (r: { first_name: string | null }) => !!r.first_name?.trim() && !test.has(r.first_name.trim().toLowerCase());
export const isWebRow = (r: { kind: string | null; question: string | null }) => r.kind === "brief" && (r.question ?? "").startsWith("[web]");

export async function getUsage(): Promise<Usage> {
  "use cache";
  cacheLife({ stale: 60, revalidate: 600, expire: 86400 });
  return timed("getUsage", () => readUsage());
}

async function readUsage(): Promise<Usage> {
  const [log, saved, dir, guestVideos, test] = await Promise.all([
    all<{ kind: string | null; question: string | null; first_name: string | null; cited_chunk_ids: number[] | null; created_at: string }>((a, b) =>
      db().from("qa_log").select("kind,question,first_name,cited_chunk_ids,created_at").order("id").range(a, b)),
    all<{ kind: string; first_name: string | null }>((a, b) => db().from("saved_items").select("kind,first_name").order("id").range(a, b)),
    getDirectory(),
    getGuestVideos(),
    testNames(),
  ]);
  const isRealUse = realUse(test);
  const real = log.filter(isRealUse);
  const asks = real.filter((r) => r.kind === "ask");
  const keep = saved.filter(isRealUse);

  // A question's topics: the sector tags of the guests whose episodes its answer cited.
  const ids = [...new Set(asks.flatMap((r) => r.cited_chunk_ids ?? []))];
  const videoOf = new Map<number, string>();
  for (let i = 0; i < ids.length; i += 300) {
    const { data, error } = await db().from("chunks").select("id,video_id").in("id", ids.slice(i, i + 300));
    if (error) throw new Error(`chunks: ${error.message}`);
    for (const c of data ?? []) videoOf.set(c.id, c.video_id);
  }
  const guestBySlug = new Map(dir.guests.map((g) => [g.slug, g]));
  const sectors = new Map(dir.sectors.map((s) => [s.key, s.label]));
  const tagsOfVideo = new Map<string, Set<string>>();
  for (const r of guestVideos) {
    const g = guestBySlug.get(r.slug);
    if (!g) continue;
    const set = tagsOfVideo.get(r.videoId) ?? tagsOfVideo.set(r.videoId, new Set()).get(r.videoId)!;
    for (const t of g.tags) if (sectors.has(t.toLowerCase())) set.add(t.toLowerCase());
  }
  const n = new Map<string, number>();
  let cited = 0;
  for (const r of asks) {
    const vids = new Set((r.cited_chunk_ids ?? []).map((id) => videoOf.get(id)).filter((v): v is string => !!v));
    if (vids.size) cited++;
    const tags = new Set([...vids].flatMap((v) => [...(tagsOfVideo.get(v) ?? [])]));
    for (const t of tags) n.set(t, (n.get(t) ?? 0) + 1);
  }
  const topics = [...n].map(([key, v]) => ({ key, label: sectors.get(key)!, n: v })).sort((a, b) => b.n - a.n || a.label.localeCompare(b.label)).slice(0, 6);
  const since = real.map((r) => r.created_at).sort()[0] ?? null;
  return {
    questions: asks.length,
    briefs: real.filter((r) => r.kind === "brief" && !isWebRow(r)).length,
    web: real.filter(isWebRow).length,
    saved: {
      clip: keep.filter((r) => r.kind === "clip").length, answer: keep.filter((r) => r.kind === "answer").length, brief: keep.filter((r) => r.kind === "brief").length,
    },
    topics, cited, since,
    takeaway: topics[0] ? `${topics[0].label} comes up most: ${num(topics[0].n)} of ${num(cited)} answered questions cited an episode with ${aGuest(topics[0].label)}.` : "",
    countedAt: new Date().toISOString(),
  };
}

/* ---------- thumbnails ---------- */

/** What pipeline/17_thumbnail_features.py measured on each thumbnail (public.thumbnail_features.features). */
type ThumbFeatures = {
  faces: number; largest_face: number; framing: "close-up" | "wide" | "none"; text_present: boolean; word_count: number;
  has_number: boolean; has_question: boolean; text_langs: string[]; show_logo: boolean; brightness: number; contrast: number;
};
type Cut = { brightness: number; contrast: number };

/** The features compared. The view-count badge the channel stamps on thumbnails is never one: it is the views. */
const THUMB_FEATURES: { key: string; label: string; short: string; subject: string; phrase: string; test: (f: ThumbFeatures, cut: Cut) => boolean }[] = [
  { key: "number", label: "A number in the text", short: "Number in the text", subject: "A number in the text", phrase: "thumbnails with a number", test: (f) => f.has_number },
  { key: "question", label: "A question mark", short: "Question mark", subject: "A question mark", phrase: "thumbnails with a question mark", test: (f) => f.has_question },
  { key: "short", label: "Five words or fewer", short: "5 words or fewer", subject: "Text of five words or fewer", phrase: "thumbnails with five words or fewer", test: (f) => f.text_present && f.word_count <= 5 },
  { key: "text", label: "Any headline text", short: "Headline text", subject: "Headline text", phrase: "thumbnails with headline text", test: (f) => f.text_present },
  { key: "hindi", label: "Hindi text", short: "Hindi text", subject: "Hindi text", phrase: "thumbnails with Hindi text", test: (f) => f.text_langs.includes("hi") },
  { key: "closeup", label: "Close-up face", short: "Close-up face", subject: "A close-up face", phrase: "thumbnails with a close-up face", test: (f) => f.framing === "close-up" },
  { key: "faces3", label: "Three or more faces", short: "3+ faces", subject: "Three or more faces", phrase: "thumbnails with three or more faces", test: (f) => f.faces >= 3 },
  { key: "logo", label: "Show logo on it", short: "Show logo", subject: "The show's logo", phrase: "thumbnails with the show's logo", test: (f) => f.show_logo },
  { key: "bright", label: "Brighter than most", short: "Brighter than the archive median", subject: "Brighter-than-median images", phrase: "brighter thumbnails", test: (f, cut) => f.brightness > cut.brightness },
  { key: "contrast", label: "Higher contrast", short: "Higher contrast than the archive median", subject: "Higher-contrast images", phrase: "higher-contrast thumbnails", test: (f, cut) => f.contrast > cut.contrast },
];

/** A style shift counts when a feature's share moved this many points from the first to the latest year. */
const SHIFT_POINTS = 10;

const times = (r: number) => `${r.toFixed(1)}x`;

/** Thumbnail features against views, compared within the same year so older episodes' extra time to collect views
    does not count. Null when public.thumbnail_features is missing or empty. */
export async function getThumbnailInsights(): Promise<ThumbInsights | null> {
  "use cache: remote";
  cacheLife({ stale: 300, revalidate: 3600, expire: 86400 });
  return timed("getThumbnailInsights", () => readThumbnailInsights());
}

async function readThumbnailInsights(): Promise<ThumbInsights | null> {
  let rows: { episode_id: string; features: ThumbFeatures }[];
  try {
    rows = await all((a, b) => db().from("thumbnail_features").select("episode_id,features").order("episode_id").range(a, b));
  } catch (e) {
    console.warn("insights: thumbnail_features unavailable:", e instanceof Error ? e.message : e);
    cacheLife({ stale: 60, revalidate: 300, expire: 3600 }); // look again soon once the table exists
    return null;
  }
  if (!rows.length) return null;
  const eps = (await all<{ video_id: string; published_at: string | null; view_count: number | null }>((a, b) =>
    db().from("episodes").select("video_id,published_at,view_count").eq("status", "transcribed").order("video_id").range(a, b)))
    .filter((e) => e.published_at).map((e) => ({ id: e.video_id, year: yearOf(e.published_at)!, views: Number(e.view_count ?? 0) }));

  // Year-relative views: an episode's views over the median of every transcribed episode from the same year.
  const yearMedian = new Map<number, number>();
  for (const y of new Set(eps.map((e) => e.year))) yearMedian.set(y, spread(eps.filter((e) => e.year === y).map((e) => e.views)).median);
  const featOf = new Map(rows.map((r) => [r.episode_id, r.features]));
  const list = eps.filter((e) => featOf.has(e.id))
    .map((e) => ({ ...e, f: featOf.get(e.id)!, rel: yearMedian.get(e.year) ? e.views / yearMedian.get(e.year)! : 0 }));
  const cut: Cut = { brightness: spread(list.map((e) => e.f.brightness)).median, contrast: spread(list.map((e) => e.f.contrast)).median };
  const years = [...new Set(list.map((e) => e.year))].sort((a, b) => a - b);

  const patterns: ThumbPattern[] = [], hidden: string[] = [], shifts: (ThumbInsights["shifts"][number] & { sentence: string })[] = [];
  for (const d of THUMB_FEATURES) {
    const yes = list.filter((e) => d.test(e.f, cut)), no = list.filter((e) => !d.test(e.f, cut));
    const share = years.map((y) => {
      const inY = list.filter((e) => e.year === y);
      return { year: y, n: inY.length, pct: pct(inY.filter((e) => d.test(e.f, cut)).length, inY.length) };
    });
    // A style shift: the share moved SHIFT_POINTS or more, up or down, from the first to the latest year with
    // MIN_GROUP analysed episodes. A fact about the thumbnails, not about views.
    const big = share.filter((s) => s.n >= MIN_GROUP);
    if (big.length >= 2 && Math.abs(big.at(-1)!.pct - big[0].pct) >= SHIFT_POINTS) {
      const [a, b] = [big[0], big.at(-1)!];
      shifts.push({
        key: d.key, from: a.pct, to: b.pct, fromYear: a.year, toYear: b.year,
        text: `${d.short}: ${a.pct}% of ${a.year} thumbnails, ${b.pct}% in ${b.year}`,
        sentence: d.key === "bright" || d.key === "contrast"
          ? `Thumbnails got ${d.key === "bright" ? (b.pct > a.pct ? "brighter" : "darker") : (b.pct > a.pct ? "higher in contrast" : "lower in contrast")}: ${a.pct}% of ${a.year} thumbnails were above the archive's median ${d.key === "bright" ? "lightness" : "contrast"}, ${b.pct}% in ${b.year}. The biggest change in style.`
          : `${d.subject} went from ${a.pct}% of ${a.year} thumbnails to ${b.pct}% in ${b.year}, the biggest change in style.`,
      });
    }
    if (yes.length < MIN_GROUP || no.length < MIN_GROUP) {
      hidden.push(`${d.label} (${yes.length} with, ${no.length} without)`);
      continue;
    }
    const w = spread(yes.map((e) => e.rel)), wo = spread(no.map((e) => e.rel));
    const perYear = years.map((y) => {
      const a = yes.filter((e) => e.year === y), b = no.filter((e) => e.year === y);
      if (a.length < MIN_GROUP || b.length < MIN_GROUP) return null;
      const ma = spread(a.map((e) => e.views)).median, mb = spread(b.map((e) => e.views)).median;
      return { year: y, ratio: mb ? ma / mb : 0, nWith: a.length, nWithout: b.length, medWith: ma, medWithout: mb };
    }).filter((x): x is NonNullable<typeof x> => !!x);
    const ratio = wo.median ? w.median / wo.median : 0;
    const both = `${w.median.toFixed(2)}x vs ${wo.median.toFixed(2)}x their year's median`;
    // Mixed: the years with 20 episodes on each side, and all years together, disagree: some above 1.0x, some below.
    const dirs = [ratio, ...perYear.map((y) => y.ratio)];
    const mixed = dirs.some((r) => r > 1) && dirs.some((r) => r < 1);
    const takeaway = mixed ? `Mixed: no consistent effect on views. All years together: ${both}.`
      : ratio >= 1.05 ? `Compared within the same year, ${d.phrase} get ${times(ratio)} the median views of those without (${both}).`
        : ratio <= 0.95 ? `Compared within the same year, ${d.phrase} get fewer views than those without: ${both}, or ${times(ratio)}.`
          : `Compared within the same year, ${d.phrase} get about the same views as those without (${both}).`;
    patterns.push({
      key: d.key, label: d.label, ratio, mixed, years: perYear, share, takeaway,
      with: { key: "with", label: "With", ...w }, without: { key: "without", label: "Without", ...wo },
    });
  }
  // Consistent patterns first, strongest gap first; mixed ones after.
  patterns.sort((a, b) => Number(a.mixed) - Number(b.mixed) || Math.abs(Math.log(b.ratio || 1)) - Math.abs(Math.log(a.ratio || 1)));
  shifts.sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from));
  const span = years.length ? `${years[0]} to ${years.at(-1)}` : "";
  return {
    analysed: list.length, episodes: eps.length, patterns, hidden, brightness: cut.brightness, contrast: cut.contrast,
    shifts: shifts.map((x) => ({ key: x.key, text: x.text, from: x.from, to: x.to, fromYear: x.fromYear, toYear: x.toYear })),
    headline: shifts[0]?.sentence ?? `Thumbnail styles stayed steady from ${span}: no feature's share moved ${SHIFT_POINTS} points.`,
    countedAt: new Date().toISOString(),
  };
}
