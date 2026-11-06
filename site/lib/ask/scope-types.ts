import { LANGS } from "@/lib/clip-types";

/** Ask within a scope (Ticket 28d): the chips under the Ask box. Shared by the server (which resolves a scope to episodes
    itself and never trusts ids from the browser) and the Ask page (which shows counts from the same index).
    The words mean what they mean on the Clips page: a topic is a sector of the episode's verified guests, the language
    is the episode's (English or Hindi), the year is when it was published. */
export type AskScope = { guest?: string; topic?: string; year?: number; lang?: keyof typeof LANGS };

/** One transcribed episode: v = video id, y = year, l = language, g / t = indexes into guests / topics, m = minutes. */
export type ScopeEpisode = { v: string; y: number | null; l: keyof typeof LANGS | null; g: number[]; t: number[]; m: number };

/** Everything the chips need, small enough to send to the browser (about 40 KB). */
export type ScopeIndex = {
  guests: { slug: string; name: string }[];
  topics: { key: string; label: string }[];
  years: number[];
  episodes: ScopeEpisode[];
};

export const SCOPE_LANGS = LANGS;
export type ScopeFacet = "guest" | "topic" | "year" | "lang";

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TOPIC = /^[\p{L}\p{N} &/+.,'-]{1,60}$/u;

/** A scope from anywhere (request body, URL, sessionStorage), with anything malformed dropped. */
export function parseScope(raw: unknown): AskScope {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: AskScope = {};
  if (typeof r.guest === "string" && r.guest.length <= 120 && SLUG.test(r.guest)) out.guest = r.guest;
  if (typeof r.topic === "string") { const t = r.topic.toLowerCase().trim(); if (TOPIC.test(t)) out.topic = t; }
  const y = typeof r.year === "string" ? Number(r.year) : r.year;
  if (typeof y === "number" && Number.isInteger(y) && y >= 2000 && y <= 2100) out.year = y;
  if (typeof r.lang === "string" && r.lang in LANGS) out.lang = r.lang as keyof typeof LANGS;
  return out;
}

export const scopeIsEmpty = (s: AskScope) => !s.guest && !s.topic && !s.year && !s.lang;
export const scopeKey = (s: AskScope) => [s.guest ?? "", s.topic ?? "", s.year ?? "", s.lang ?? ""].join("|");

/** The episodes a scope covers. An unknown guest or topic matches nothing. `skip` leaves one facet out (for the counts
    the chips show next to each choice). */
export function matchEpisodes(ix: ScopeIndex, s: AskScope, skip?: ScopeFacet): ScopeEpisode[] {
  const gi = s.guest && skip !== "guest" ? ix.guests.findIndex((g) => g.slug === s.guest) : -2;
  const ti = s.topic && skip !== "topic" ? ix.topics.findIndex((t) => t.key === s.topic) : -2;
  if (gi === -1 || ti === -1) return [];
  return ix.episodes.filter((e) =>
    (!s.year || skip === "year" || e.y === s.year)
    && (!s.lang || skip === "lang" || e.l === s.lang)
    && (gi < 0 || e.g.includes(gi))
    && (ti < 0 || e.t.includes(ti)));
}

/** For each choice of each chip, how many episodes the scope would cover with that choice (the other chips as they are). */
export function facetCounts(ix: ScopeIndex, s: AskScope) {
  const count = (facet: ScopeFacet, keys: (e: ScopeEpisode) => (string | number)[]) => {
    const n = new Map<string | number, number>();
    for (const e of matchEpisodes(ix, s, facet)) for (const k of keys(e)) n.set(k, (n.get(k) ?? 0) + 1);
    return n;
  };
  return {
    guest: count("guest", (e) => e.g),
    topic: count("topic", (e) => e.t),
    year: count("year", (e) => (e.y ? [e.y] : [])),
    lang: count("lang", (e) => (e.l ? [e.l] : [])),
  };
}

/** "Health · 2025 · Hindi", "Vaibhav Sisinty". Empty for the whole archive. */
export function scopeLabel(ix: ScopeIndex | null, s: AskScope): string {
  const guest = s.guest ? ix?.guests.find((g) => g.slug === s.guest)?.name ?? s.guest : null;
  const topic = s.topic ? ix?.topics.find((t) => t.key === s.topic)?.label ?? s.topic : null;
  return [guest, topic, s.year ? String(s.year) : null, s.lang ? SCOPE_LANGS[s.lang] : null].filter(Boolean).join(" · ");
}
