/** The search's three tiers put together (Ticket 27). Pure: search.ts fetches, this ranks.

    (a) Lexical entity matches: guests, episodes, clips and topics whose name, title or alias matches the words typed
        (lib/search/entities.ts).
    (b) Passages: hybrid_search / hybrid_search_scoped (keyword + semantic, fused), with no similarity floor.
    (c) If (b) gives nothing, the semantic nearest passages alone: there is always something to show.
    Guests, episodes, clips and topics found in the passages are added after the ones matched by name.
    mode is "exact" when (a) or the keyword side found something, "closest" when only meaning did. */

import { fold } from "./normalize";
import type { ClipHit, EntityMatch, EpisodeHit, GuestHit, MomentHit, SearchGroups, TopicHit } from "./types";

export const RANK = {
  /** Entity matches shown in a group: whole-word or better, or a close typo. */
  minEntityScore: 0.6,
  /** Passages the groups and chips are counted over, and how many are shown. */
  pool: 30,
  moments: 12,
  guests: 6,
  episodes: 6,
  clips: 8,
  topics: 6,
  snippetChars: 200,
} as const;

/** A passage as hybrid_search returns it. */
export type RawHit = { id: number; video_id: string; start_s: number; end_s: number; text: string; score: number; similarity?: number | null };

export type ClipLite = { id: number; videoId: string; startS: number; endS: number; title: string; guest: string };

/** What ranking needs to know about the archive (cached indexes, read by search.ts). */
export type ArchiveMeta = {
  episodeTitle: (videoId: string) => string;
  episodeYear: (videoId: string) => number | null;
  guestsOf: (videoId: string) => { slug: string; name: string }[];
  /** The topics (sector tags of three or more guests, as the suggestions) of the episode's guests. */
  topicsOf: (videoId: string) => { key: string; label: string }[];
  /** Share of all episodes that have this topic: what "often" means for it (Education is everywhere, Fintech is not). */
  topicShare: (key: string) => number;
  clipsOf: (videoId: string) => ClipLite[];
  clipById: (id: number) => ClipLite | undefined;
};

/** The transcript part of a passage: its first line is the "Episode: ... | date" header. */
export const passageBody = (text: string) => text.replace(/^Episode:[^\n]*\n/, "");

/** Does the passage say one of the words (whole word; a longer word may also start a longer one: startup, startups)? */
export function hasKeyword(foldedBody: string, words: string[]): boolean {
  if (!words.length) return false;
  const tokens = foldedBody.split(" ");
  return words.some((w) => tokens.some((t) => t === w || (w.length >= 4 && t.startsWith(w))));
}

/** About RANK.snippetChars characters of the passage around the first searched word, cut at spaces. */
export function snippetOf(body: string, words: string[]): string {
  const text = body.replace(/\s+/g, " ").trim();
  const lower = text.toLowerCase();
  let at = -1;
  for (const w of words) {
    const m = new RegExp(`(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "u").exec(lower);
    if (m && (at < 0 || m.index < at)) at = m.index + m[1].length;
  }
  const n = RANK.snippetChars;
  if (text.length <= n) return text;
  let start = at > 60 ? at - 60 : 0;
  if (start > 0) { const sp = text.indexOf(" ", start); start = sp >= 0 && sp < (at < 0 ? start + 20 : at) ? sp + 1 : start; }
  let end = Math.min(text.length, start + n);
  if (end < text.length) { const sp = text.lastIndexOf(" ", end); if (sp > start + n / 2) end = sp; }
  return `${start > 0 ? "…" : ""}${text.slice(start, end).trim()}${end < text.length ? "…" : ""}`;
}

export function toMoments(hits: RawHit[], words: string[], meta: ArchiveMeta): MomentHit[] {
  return hits.map((h) => {
    const body = passageBody(h.text);
    return {
      chunkId: h.id, videoId: h.video_id, startS: h.start_s, endS: h.end_s,
      snippet: snippetOf(body, words), episode: meta.episodeTitle(h.video_id), guests: meta.guestsOf(h.video_id).map((g) => g.name),
      year: meta.episodeYear(h.video_id), score: h.score, similarity: h.similarity ?? null, keyword: hasKeyword(fold(body), words),
    };
  });
}

export type Assembled = { groups: SearchGroups; mode: "exact" | "closest"; exactEntity: boolean; pool: MomentHit[] };

export function assemble(matches: EntityMatch[], moments: MomentHit[], meta: ArchiveMeta): Assembled {
  const shown = matches.filter((m) => m.score >= RANK.minEntityScore && m.s.kind !== "term");
  const pool = moments.slice(0, RANK.pool);

  // Guests: by name first, then by how many of the passages are theirs.
  const guests = new Map<string, GuestHit>();
  for (const m of shown) if (m.s.kind === "guest") guests.set(m.s.ref, { slug: m.s.ref, name: m.s.text, hits: 0, matched: true });
  // At most 2 passages come from one episode, so hit counts tie often: the passages' summed score breaks the tie.
  const fromMoments = new Map<string, GuestHit & { sum: number }>();
  for (const p of pool) for (const g of meta.guestsOf(p.videoId)) {
    if (guests.has(g.slug)) { guests.get(g.slug)!.hits++; continue; }
    const cur = fromMoments.get(g.slug) ?? fromMoments.set(g.slug, { slug: g.slug, name: g.name, hits: 0, matched: false, sum: 0 }).get(g.slug)!;
    cur.hits++; cur.sum += p.score;
  }
  const byPassages = [...fromMoments.values()].sort((a, b) => b.hits - a.hits || b.sum - a.sum || a.name.localeCompare(b.name)).map((g): GuestHit => ({ slug: g.slug, name: g.name, hits: g.hits, matched: g.matched }));
  const guestList = [...guests.values(), ...byPassages].slice(0, RANK.guests);

  // Episodes: by title, then by the passages (summed score).
  const episodes = new Map<string, EpisodeHit & { sum: number }>();
  const episodeOf = (v: string, matched: boolean) => ({ videoId: v, title: meta.episodeTitle(v), year: meta.episodeYear(v), guests: meta.guestsOf(v).map((g) => g.name), hits: 0, matched, sum: 0 });
  for (const m of shown) if (m.s.kind === "episode") episodes.set(m.s.ref, episodeOf(m.s.ref, true));
  for (const p of pool) {
    const e = episodes.get(p.videoId) ?? episodes.set(p.videoId, episodeOf(p.videoId, false)).get(p.videoId)!;
    e.hits++; e.sum += p.score;
  }
  const episodeList = [...episodes.values()]
    .sort((a, b) => Number(b.matched) - Number(a.matched) || b.sum - a.sum)
    .slice(0, RANK.episodes)
    .map((e): EpisodeHit => ({ videoId: e.videoId, title: e.title, year: e.year, guests: e.guests, hits: e.hits, matched: e.matched }));

  // Clips: by title, then the clips the passages fall in (time overlap), best passage first.
  const clips = new Map<number, ClipHit>();
  for (const m of shown) if (m.s.kind === "clip") {
    const c = meta.clipById(Number(m.s.ref));
    if (c) clips.set(c.id, { ...c, matched: true });
  }
  for (const p of pool) for (const c of meta.clipsOf(p.videoId)) {
    if (!clips.has(c.id) && c.startS < p.endS && c.endS > p.startS) clips.set(c.id, { ...c, matched: false });
  }
  const clipList = [...clips.values()].slice(0, RANK.clips);

  // Topics: by name, then the topics of the passages' guests, by how much more often they come up here than across the
  // archive (lift), so a topic every other guest has does not crowd out the ones this search is really about.
  const topics = new Map<string, TopicHit>();
  for (const m of shown) if (m.s.kind === "topic") topics.set(m.s.ref, { key: m.s.ref, label: m.s.text, hits: 0, matched: true });
  const topicsFromMoments = new Map<string, TopicHit>();
  for (const p of pool) for (const t of meta.topicsOf(p.videoId)) {
    if (topics.has(t.key)) topics.get(t.key)!.hits++;
    else if (topicsFromMoments.has(t.key)) topicsFromMoments.get(t.key)!.hits++;
    else topicsFromMoments.set(t.key, { key: t.key, label: t.label, hits: 1, matched: false });
  }
  const lift = (x: TopicHit) => { const expected = Math.max(1e-6, pool.length * meta.topicShare(x.key)); return x.hits * Math.log(x.hits / expected); };
  const ranked = [...topicsFromMoments.values()].filter((x) => x.hits >= 2 && lift(x) > 0).sort((a, b) => lift(b) - lift(a) || a.label.localeCompare(b.label));
  const topicList = [...topics.values(), ...ranked].slice(0, RANK.topics);

  const lexical = shown.length > 0 || moments.some((m) => m.keyword);
  const exactEntity = matches.some((m) => m.how === "exact" && (m.s.kind === "guest" || m.s.kind === "episode" || m.s.kind === "clip"));
  return {
    groups: { guests: guestList, episodes: episodeList, clips: clipList, moments: moments.slice(0, RANK.moments), topics: topicList },
    mode: lexical ? "exact" : "closest",
    exactEntity,
    pool,
  };
}

export const isEmpty = (g: SearchGroups) => !g.guests.length && !g.episodes.length && !g.clips.length && !g.moments.length && !g.topics.length;
