import { fmtTime, youtubeAt } from "@/lib/player-types";

/** Shapes and pure helpers of the Clips page (/clips), shared by the server (lib/clips.ts), its actions and the page.
    Every clip is a verified row of public.clips; its guest, date, views and language come from verified guest rows
    and the episode. */

/** One reel card. */
export type ClipCard = {
  id: number;
  videoId: string;
  startS: number;
  endS: number;
  /** Short title the extraction gave the clip, e.g. "The cost of ambition". */
  topic: string;
  /** First words of the clip, cleaned of caption marks. */
  opening: string;
  score: number;
  /** Guest names of the episode, joined ("A & B"); empty when the episode has no verified guest. */
  guest: string;
  /** The first guest's profile slug, for "More from this guest". */
  guestSlug: string | null;
  /** That guest has clips in more than one episode. */
  repeat: boolean;
  episode: string;
  /** "Mar 2025" */
  date: string;
  publishedAt: string;
  views: number;
  lang: "en" | "hi" | null;
};

export const SORTS = { score: "Best clips", new: "Newest", views: "Most viewed episode", match: "Best match" } as const;
export type ClipSort = keyof typeof SORTS;
export const LENGTHS = { short: "Under 45 s", mid: "45-90 s", long: "Over 90 s" } as const;
export type ClipLength = keyof typeof LENGTHS;
export const LANGS = { en: "English", hi: "Hindi" } as const;

/** What the URL says (/clips?q=&topic=&guest=&len=&year=&lang=&sort=). Everything else is ignored. */
export type ClipParams = {
  q: string;
  topic: string;
  guest: string;
  len: ClipLength | "";
  year: string;
  lang: keyof typeof LANGS | "";
  /** Empty: the default (best match when searching, else best clips). */
  sort: ClipSort | "";
};

export const PAGE_SIZE = 24;
/** In a guest's view, each episode shows this many clips before "Show all". */
export const GROUP_PREVIEW = 4;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function parseClipParams(sp: Record<string, string | string[] | undefined>): ClipParams {
  const q = one(sp.q).replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  const topic = one(sp.topic).toLowerCase().slice(0, 60);
  const guest = one(sp.guest).slice(0, 120);
  const len = one(sp.len);
  const year = one(sp.year);
  const lang = one(sp.lang);
  const sort = one(sp.sort);
  return {
    q,
    topic: /^[\p{L}\p{N} &/+.,'-]{1,60}$/u.test(topic) ? topic : "",
    guest: SLUG.test(guest) ? guest : "",
    len: len in LENGTHS ? (len as ClipLength) : "",
    year: /^20\d\d$/.test(year) ? year : "",
    lang: lang in LANGS ? (lang as ClipParams["lang"]) : "",
    sort: sort in SORTS && (sort !== "match" || q) ? (sort as ClipSort) : "",
  };
}

/** The order the list is in: what the URL asks, else best match for a search and best clips otherwise. */
export const effectiveSort = (p: ClipParams): ClipSort => p.sort || (p.q ? "match" : "score");

/** The query string for these params, without empty ones (and without the default sort). */
export function clipQuery(p: Partial<ClipParams>): string {
  const sp = new URLSearchParams();
  for (const k of ["q", "topic", "guest", "len", "year", "lang", "sort"] as const) if (p[k]) sp.set(k, p[k]!);
  const s = sp.toString();
  return s ? `?${s}` : "";
}

export const lengthOf = (s: number): ClipLength => (s < 45 ? "short" : s <= 90 ? "mid" : "long");

/** Caption marks (">>", "[Music]") out, spaces tidied, and a trailing "…" because the line is cut mid-sentence. */
export function cleanOpening(text: string): string {
  const t = text.replace(/>>+/g, " ").replace(/\[[^\]]{1,20}\]/g, " ").replace(/\s+/g, " ").trim();
  return t ? `${t.replace(/[\s,;:-]+$/, "")}…` : "";
}

/** The "Download clip details" file: plain text a teammate can paste anywhere. */
export function clipDetailsText(c: ClipCard): string {
  return [
    `Title: ${c.topic}`,
    `Guest: ${c.guest || "Not listed"}`,
    `Episode: ${c.episode}`,
    `Date: ${c.date}${c.publishedAt ? ` (published ${c.publishedAt.slice(0, 10)})` : ""}`,
    `Start: ${fmtTime(c.startS)}`,
    `End: ${fmtTime(c.endS)}`,
    `Length: ${fmtTime(c.endS - c.startS)}`,
    `YouTube: ${youtubeAt(c.videoId, c.startS)}`,
    `Opening line: "${c.opening.replace(/…$/, "")}…"`,
    "",
    "Unofficial project, not affiliated with Figuring Out. Every answer links to its source.",
    "",
  ].join("\r\n");
}

export const clipDetailsFilename = (c: ClipCard) =>
  `clip-${c.topic.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "details"}-${c.videoId}-${Math.floor(c.startS)}.txt`;

/** Filter choices with how many clips each has (all clips, before filtering). */
export type ClipOptions = {
  total: number;
  topics: { key: string; label: string; n: number }[];
  guests: { slug: string; name: string; n: number }[];
  years: { year: string; n: number }[];
  lengths: { key: ClipLength; n: number }[];
  langs: { key: keyof typeof LANGS; n: number }[];
};

/** One page of results. In a guest's view the clips come grouped by episode (all of them, no paging). */
export type ClipPage = {
  items: ClipCard[];
  total: number;
  /** Offset of the next page, or null at the end. */
  next: number | null;
  guestView: null | {
    slug: string;
    name: string;
    episodes: number;
    clips: number;
    groups: { videoId: string; episode: string; date: string; clips: ClipCard[] }[];
  };
};

/** A line of a clip's transcript for the live transcript. */
export type ClipLine = { start: number; end: number; speaker: string; text: string; english: string };
