import "server-only";
import { cacheLife } from "next/cache";
import { allRows as all, ARCHIVE_RUN_ID, db } from "@/lib/db";
import { yearOf } from "@/lib/guest-format";
import { getDirectory, getGuestVideos } from "@/lib/guests";
import { LENGTH_BANDS, spread } from "@/lib/insights";

/** The home page's "Explore the patterns" chart, from the verified episodes. One number throughout: an episode's views
    divided by the median views of the episodes published the same year, so 1.0x is a typical episode of the same age
    and older episodes' extra time to collect views does not count. Four ways to group episodes (tabs): length, title
    style, topic and guest type. Computed at query time from the episodes and guests tables (no extra columns or
    tables) and kept for a few hours. Not traffic-based, so there is nothing to exclude. On failure it returns null
    (the home page then shows no chart) and looks again in a few minutes. */

/** A group with fewer episodes than this in total is not shown. */
export const MIN_TOTAL = 10;
/** A year gets a point on the line only with at least this many of the group's episodes in it. */
export const MIN_POINT = 10;
/** A point with fewer episodes than this is a small sample: drawn hollow and labelled so. */
export const SMALL_BELOW = 20;
/** The Topic tab shows this many topics, the ones with the most episodes. */
export const TOP_TOPICS = 8;

/* ---------- the derived groupings: simple rules, kept in one place ---------- */

/** Episode titles end with "| FO 118 Raj Shamani" (episode number and host). That tail says nothing about the title's
    style (every title would "have a number"), so it is cut before the rules below look at the title. */
export function stripTitleTail(title: string): string {
  return title.replace(/\|?\s*FO\s?\d+.*$/i, "").replace(/raj shamani/gi, "").trim();
}

const MONEY = /₹|\brs\.?\s?\d|\bcrores?\b|\blakhs?\b|\bcr\b|\$\s?\d|\b\d+\s?(?:million|billion|lakh|crore|cr|k)\b|\bmillion|\bbillion/i;

/** The title styles an episode title has, from the title text only. An episode can have more than one (a money amount is
    also a number); "No hook" is a title with none of the three. */
export function titleStyles(title: string): string[] {
  const t = stripTitleTail(title);
  const out: string[] = [];
  if (MONEY.test(t)) out.push("Money amount");
  if (/\d/.test(t)) out.push("Has a number");
  if (/\?/.test(t)) out.push("Asks a question");
  return out.length ? out : ["No hook"];
}
export const TITLE_STYLE_ORDER = ["Money amount", "Has a number", "Asks a question", "No hook"];

/** Guest types, from the guest's role description (guests.role_at_episode, as extracted for that episode) by keyword.
    A role can match more than one; one that matches none leaves its episode out of the Guest type tab. */
export const ROLE_BUCKETS: [label: string, test: RegExp][] = [
  ["Founder / CEO / investor", /founder|ceo|entrepreneur|investor|co-founder|chairman|managing director|businessman|business/i],
  ["Doctor / health expert", /doctor|dr\.|physician|surgeon|dermatolog|psychiatr|psycholog|nutrition|dietitian|neuro|medicine|health|therap/i],
  ["Actor / singer / comedian / creator", /actor|actress|singer|comedian|musician|artist|filmmaker|director|youtuber|creator|influencer|rapper|composer|podcaster|storyteller/i],
  ["Politician / official", /politician|minister|\bmp\b|mla|bureaucrat|\bias\b|\bips\b|diplomat|ambassador|government|general|officer|commander|army|military|police/i],
  ["Athlete / sportsperson", /athlete|cricketer|olympi|player|swimmer|wrestler|boxer|sportsperson|coach|footballer|shooter|runner/i],
  ["Author / educator / speaker", /author|writer|professor|teacher|educator|speaker|coach|historian|journalist|scientist|researcher/i],
];
export function roleBuckets(role: string | null | undefined): string[] {
  const r = role ?? "";
  return ROLE_BUCKETS.filter(([, rx]) => rx.test(r)).map(([label]) => label);
}

/* ---------- shapes ---------- */

export type ExplorerPoint = { year: number; value: number; n: number; small: boolean };
export type ExplorerGroup = {
  label: string;
  episodes: number;
  /** Median of the group's year-relative views, all years together. */
  typical: number;
  /** The same figure per year, for the years with enough episodes. */
  byYear: ExplorerPoint[];
};
export type ExplorerSet = { key: string; label: string; groups: ExplorerGroup[]; note?: string };
export type ExplorerData = { years: number[]; sets: ExplorerSet[] };

/* ---------- the loader ---------- */

export async function getHomeExplorer(): Promise<ExplorerData | null> {
  "use cache: remote";
  cacheLife("hours");
  try {
    const data = await read();
    if (data) return data;
  } catch (e) {
    console.warn("home explorer unavailable:", e instanceof Error ? e.message : "unknown");
  }
  cacheLife({ stale: 60, revalidate: 300, expire: 900 });
  return null;
}

type Ep = { id: string; title: string; year: number; minutes: number; rel: number };

/** Groups from (label, episodes) pairs: hides small groups, adds the per-year points. */
function build(groups: { label: string; eps: Ep[] }[], years: number[]): ExplorerGroup[] {
  return groups.filter((g) => g.eps.length >= MIN_TOTAL).map(({ label, eps }) => ({
    label, episodes: eps.length, typical: spread(eps.map((e) => e.rel)).median,
    byYear: years.map((year) => {
      const g = eps.filter((e) => e.year === year);
      return g.length >= MIN_POINT ? { year, value: spread(g.map((e) => e.rel)).median, n: g.length, small: g.length < SMALL_BELOW } : null;
    }).filter((x): x is ExplorerPoint => !!x),
  }));
}

async function read(): Promise<ExplorerData | null> {
  // One round of queries: the transcribed episodes and the verified guest rows (the directory and guest-video lists
  // are the shared cached loaders of the Guests page).
  const [rows, guestRows, dir, guestVideos] = await Promise.all([
    all<{ video_id: string; title: string; published_at: string | null; duration_seconds: number | null; view_count: number | null }>((a, b) =>
      db().from("episodes").select("video_id,title,published_at,duration_seconds,view_count").eq("status", "transcribed").order("video_id").range(a, b)),
    all<{ video_id: string; role_at_episode: string | null }>((a, b) =>
      db().from("guests").select("video_id,role_at_episode").eq("run_id", ARCHIVE_RUN_ID).eq("verified", true).order("id").range(a, b)),
    getDirectory(),
    getGuestVideos(),
  ]);
  const base = rows.filter((e) => e.published_at).map((e) => ({
    id: e.video_id, title: e.title, year: yearOf(e.published_at)!, minutes: (e.duration_seconds ?? 0) / 60, views: Number(e.view_count ?? 0),
  }));
  const years = [...new Set(base.map((e) => e.year))].sort((a, b) => a - b);
  const yearMedian = new Map(years.map((y) => [y, spread(base.filter((e) => e.year === y).map((e) => e.views)).median]));
  const eps: Ep[] = base.map((e) => ({ id: e.id, title: e.title, year: e.year, minutes: e.minutes, rel: yearMedian.get(e.year) ? e.views / yearMedian.get(e.year)! : 0 }));

  // Length
  const length = build(LENGTH_BANDS.map((b) => ({ label: b.label, eps: eps.filter(b.test) })), years);

  // Title style
  const style = build(TITLE_STYLE_ORDER.map((label) => ({ label, eps: eps.filter((e) => titleStyles(e.title).includes(label)) })), years);

  // Topic: the sector tags of an episode's guests, as the site's filters know them; the 8 with the most episodes.
  const guestBySlug = new Map(dir.guests.map((g) => [g.slug, g]));
  const slugsOf = new Map<string, Set<string>>();
  for (const r of guestVideos) if (guestBySlug.has(r.slug)) (slugsOf.get(r.videoId) ?? slugsOf.set(r.videoId, new Set()).get(r.videoId)!).add(r.slug);
  const topicsOf = (id: string) => new Set([...(slugsOf.get(id) ?? [])].flatMap((s) => guestBySlug.get(s)!.tags.map((t) => t.toLowerCase())));
  const topic = build(dir.sectors.map((s) => ({ label: s.label, eps: eps.filter((e) => topicsOf(e.id).has(s.key)) })), years)
    .sort((a, b) => b.episodes - a.episodes || a.label.localeCompare(b.label)).slice(0, TOP_TOPICS);

  // Guest type: from the guests' role descriptions.
  const bucketsOf = new Map<string, Set<string>>();
  for (const r of guestRows) for (const label of roleBuckets(r.role_at_episode)) (bucketsOf.get(r.video_id) ?? bucketsOf.set(r.video_id, new Set()).get(r.video_id)!).add(label);
  const guestType = build(ROLE_BUCKETS.map(([label]) => ({ label, eps: eps.filter((e) => bucketsOf.get(e.id)?.has(label)) })), years);

  const sets: ExplorerSet[] = [
    { key: "length", label: "Episode length", groups: length },
    { key: "style", label: "Title style", groups: style, note: "Grouped by simple rules on the episode title, so a few episodes may sit in the wrong group." },
    { key: "topic", label: "Topic", groups: topic },
    { key: "guest", label: "Guest type", groups: guestType, note: "Grouped by simple rules on the guest's role description, so a few episodes may sit in the wrong group." },
  ].filter((s) => s.groups.length >= 2);
  return sets.length ? { years, sets } : null;
}
