import "server-only";
import { cacheLife } from "next/cache";
import { resolveScope, getScopeIndex, type ResolvedScope } from "@/lib/ask/scope";
import { scopeIsEmpty, scopeKey, type AskScope } from "@/lib/ask/scope-types";
import { Timings } from "@/lib/ask/timing";
import { cosine, embedQueries } from "@/lib/ask/voyage";
import { getClipIndex } from "@/lib/clips";
import { db } from "@/lib/db";
import { getDirectory } from "@/lib/guests";
import { buildChips, refineCandidates } from "./chips";
import { correctQuery, wordCounts } from "./correct";
import { episodeTitles, getEntityIndex, inVocabulary, matchEntities, topicLabels, type EntityIndex } from "./entities";
import { HOST_WORDS, contentWords, fold, romanFold } from "./normalize";
import { RANK, assemble, isEmpty, toMoments, type ArchiveMeta, type ClipLite, type RawHit } from "./rank";
import type { Correction, EntityMatch, SearchResult } from "./types";
import { VAGUE, isVague } from "./vague";

/** The search box (Ticket 27): runFastSearch and runSearch.

    Both start the same way (prepare): fold the query (Devanagari is also spelled in Roman letters to look it up in the Roman
    vocabulary), correct words that are in no passage and no suggestion to the nearest transcript word (correct.ts), and
    match the words against the suggestions (entities.ts, tier a).

    runFastSearch stops there: names and titles, the correction and a vague flag, with no embedding and no passage search
    (about 100 ms once the indexes are warm). runSearch goes on: tier (b) hybrid_search (or hybrid_search_scoped within a
    scope) with the keyword part limited to words that are not common (a word in 1.5% of passages or more only slows the
    keyword side down and says little; the meaning side covers it), no similarity floor; tier (c), if (b) finds nothing,
    the semantic nearest passages alone. Then groups, mode, vague and, only for a vague query, chips.
    One Voyage embedding per query not seen before (this server's memory, then the shared remote cache); whole results are
    kept 15 minutes. */

const RESULT_TTL_MS = 15 * 60 * 1000;
const RESULT_MAX = 500;
const MAX_QUERY_CHARS = 200;
/** Passages with a measured similarity (for "flat" in vague.ts and the moments' similarity). */
const MEASURED = 10;

type Store = { results: Map<string, { at: number; value: SearchResult }>; vectors: Map<string, number[]>; chunks: { at: number; n: number } | null };
const store = ((globalThis as { __search?: Store }).__search ??= { results: new Map(), vectors: new Map(), chunks: null });

/** The query's embedding, kept across servers in the remote cache (a query vector never changes). */
async function remoteEmbedding(text: string): Promise<number[]> {
  "use cache: remote";
  cacheLife({ stale: 86400, revalidate: 30 * 86400, expire: 90 * 86400 });
  const [v] = await embedQueries([text]);
  return v;
}

async function embedding(text: string): Promise<number[]> {
  const hit = store.vectors.get(text);
  if (hit) return hit;
  const v = await remoteEmbedding(text);
  store.vectors.set(text, v);
  if (store.vectors.size > 2000) store.vectors.delete(store.vectors.keys().next().value!);
  return v;
}

/** About how many passages there are (planner estimate, read once an hour), for chunk_terms shares. */
async function totalChunks(): Promise<number> {
  if (store.chunks && Date.now() - store.chunks.at < 3600_000) return store.chunks.n;
  const { count, error } = await db().from("chunks").select("id", { count: "estimated", head: true });
  if (error) throw new Error(`chunks count: ${error.message}`);
  store.chunks = { at: Date.now(), n: count ?? 0 };
  return store.chunks.n;
}

type Scope = { videoIds: string[]; perEpisode: number; exact: boolean };

async function passages(vector: number[], text: string, scope: Scope | null): Promise<RawHit[]> {
  const { data, error } = scope
    ? await db().rpc("hybrid_search_scoped", {
        query_embedding: vector, query_text: text, match_count: RANK.pool,
        video_ids: scope.videoIds, per_episode: scope.perEpisode, exact_scan: scope.exact,
      })
    : await db().rpc("hybrid_search", { query_embedding: vector, query_text: text, match_count: RANK.pool });
  if (error) throw new Error(`${scope ? "hybrid_search_scoped" : "hybrid_search"}: ${error.message}`);
  return (data ?? []) as RawHit[];
}

/** Cosine similarity of the first few passages to the query (their stored embeddings, one read). */
async function measure(hits: RawHit[], vector: number[]): Promise<void> {
  const top = hits.slice(0, MEASURED);
  if (!top.length) return;
  const { data, error } = await db().from("chunks").select("id,embedding").in("id", top.map((h) => h.id));
  if (error) return;
  const sim = new Map((data ?? []).map((r) => {
    const v: number[] = Array.isArray(r.embedding) ? r.embedding : JSON.parse(String(r.embedding));
    return [r.id as number, cosine(vector, v)] as const;
  }));
  for (const h of top) h.similarity = sim.get(h.id) ?? null;
}

/** The lookups ranking needs, built from the cached scope and clip indexes and kept 10 minutes (building the maps from
    2,700 clips and 500 episodes on every search would be wasted work). */
type MetaMemo = { at: number; titles: Map<string, string>; meta: Promise<ArchiveMeta>; ready: ArchiveMeta | null };
let metaMemo: MetaMemo | null = null;
function archiveMeta(titles: Map<string, string>, labels: Map<string, string>): Promise<ArchiveMeta> {
  if (metaMemo && metaMemo.titles === titles && Date.now() - metaMemo.at < 600_000) return metaMemo.meta;
  const memo: MetaMemo = { at: Date.now(), titles, meta: readArchiveMeta(titles, labels), ready: null };
  metaMemo = memo;
  memo.meta.then((m) => { memo.ready = m; }, () => { if (metaMemo === memo) metaMemo = null; });
  return memo.meta;
}

/** The archive lookups if they are already built, else null (and they start building): for the suggestions, which must
    never wait for them. */
export function peekMeta(ix: EntityIndex): ArchiveMeta | null {
  const ready = metaMemo && metaMemo.titles === episodeTitles(ix) && Date.now() - metaMemo.at < 600_000 ? metaMemo.ready : null;
  if (!ready) void archiveMeta(episodeTitles(ix), topicLabels(ix)).catch(() => {});
  return ready;
}

async function readArchiveMeta(titles: Map<string, string>, labels: Map<string, string>): Promise<ArchiveMeta> {
  const [ix, clipIndex, dir] = await Promise.all([getScopeIndex(), getClipIndex(), getDirectory()]);
  const byVideo = new Map(ix.episodes.map((e) => [e.v, e]));
  // Topics of an episode: its guests' sector tags that are topic suggestions (three or more guests have them).
  const tagsOf = new Map(dir.guests.map((g) => [g.slug, [...new Set(g.tags.map((t) => t.toLowerCase()).filter((t) => labels.has(t)))]]));
  const topicsByVideo = new Map(ix.episodes.map((e) => [e.v, [...new Set(e.g.flatMap((i) => tagsOf.get(ix.guests[i].slug) ?? []))]]));
  const perTopic = new Map<string, number>();
  for (const keys of topicsByVideo.values()) for (const k of keys) perTopic.set(k, (perTopic.get(k) ?? 0) + 1);
  const episodes = Math.max(1, ix.episodes.length);
  const clipsOf = new Map<string, ClipLite[]>();
  const clipById = new Map<number, ClipLite>();
  for (const c of clipIndex.clips) {
    const lite = { id: c.id, videoId: c.videoId, startS: c.startS, endS: c.endS, title: c.topic, guest: c.guest };
    clipById.set(c.id, lite);
    (clipsOf.get(c.videoId) ?? clipsOf.set(c.videoId, []).get(c.videoId)!).push(lite);
  }
  return {
    episodeTitle: (v) => titles.get(v) ?? "",
    episodeYear: (v) => byVideo.get(v)?.y ?? null,
    guestsOf: (v) => (byVideo.get(v)?.g ?? []).map((i) => ix.guests[i]),
    topicsOf: (v) => (topicsByVideo.get(v) ?? []).map((k) => ({ key: k, label: labels.get(k)! })),
    topicShare: (k) => (perTopic.get(k) ?? 0) / episodes,
    clipsOf: (v) => clipsOf.get(v) ?? [],
    clipById: (id) => clipById.get(id),
  };
}

/* ---------- the start both phases share ---------- */

type Prepared = {
  query: string;
  scopeArg: AskScope | null;
  resolved: ResolvedScope | null;
  ix: EntityIndex;
  meta: ArchiveMeta;
  counts: Map<string, number>;
  total: number;
  corrected: Correction | null;
  /** The content words after correction, without the host's name. */
  kw: string[];
  /** The query to search and match with: corrected, or as typed. */
  effective: string;
  matches: EntityMatch[];
};

const cleanQuery = (raw: string) => raw.replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_CHARS);

async function prepare(raw: string, scopeIn: AskScope | null | undefined, t: Timings): Promise<Prepared> {
  const query = cleanQuery(raw);
  const scopeArg = scopeIn && !scopeIsEmpty(scopeIn) ? scopeIn : null;
  // The Roman spelling of the query: what the vocabulary, chunk_terms and the keyword side understand.
  const roman = romanFold(query);
  const words = contentWords(roman);
  const [ix, counts, total, resolved] = await Promise.all([
    t.time("index", () => getEntityIndex()),
    t.time("terms", () => wordCounts(words)),
    t.time("chunks", () => totalChunks()),
    scopeArg ? t.time("scope", () => resolveScope(scopeArg)) : Promise.resolve(null),
  ]);
  const [corrected, meta] = await Promise.all([
    t.time("correct", () => correctQuery(roman, words, counts, (w) => inVocabulary(ix, w))),
    t.time("meta", () => archiveMeta(episodeTitles(ix), topicLabels(ix))),
  ]);
  const effective = corrected ? corrected.corrected : query;
  const kw = contentWords(corrected ? corrected.corrected : roman).filter((w) => !HOST_WORDS.has(w));
  if (corrected) for (const [w, n] of await wordCounts(kw.filter((w) => !counts.has(w)))) counts.set(w, n);

  let matches = matchEntities(ix, effective, { kinds: ["guest", "episode", "clip", "topic", "term"] });
  if (resolved) {
    const inScope = new Set(resolved.search.videoIds);
    matches = matches.filter((m) => (m.s.kind === "episode" ? inScope.has(m.s.ref) : m.s.kind === "clip" ? inScope.has(meta.clipById(Number(m.s.ref))?.videoId ?? "") : true));
  }
  return { query, scopeArg, resolved, ix, meta, counts, total, corrected, kw, effective, matches };
}

const share = (p: Prepared, w: string) => (p.total > 0 ? (p.counts.get(w) ?? 0) / p.total : 0);

/* ---------- phase 1: names and titles ---------- */

/** Tier (a) alone: no embedding and no passage search. The vague flag here can only see the words (a common word, a
    short query), not whether the best passages are all alike; the full search settles that. */
export async function runFastSearch(raw: string, scopeIn?: AskScope | null): Promise<SearchResult> {
  const t = new Timings();
  const p = await prepare(raw, scopeIn, t);
  const { groups, mode, exactEntity } = assemble(p.matches, [], p.meta);
  const vague = isVague({ raw: p.query, contentWords: p.kw, exactEntity, wordCounts: p.counts, totalChunks: p.total, topSimilarities: [] });
  t.mark("done");
  return { phase: "fast", query: p.query, ...(p.corrected ? { corrected: p.corrected } : {}), mode, groups, vague, chips: [], ms: { ...t.stages, total: t.at.done } };
}

/* ---------- phase 2: everything ---------- */

export async function runSearch(raw: string, scopeIn?: AskScope | null, opts: { fresh?: boolean } = {}): Promise<SearchResult> {
  const query = cleanQuery(raw);
  const scopeArg = scopeIn && !scopeIsEmpty(scopeIn) ? scopeIn : null;
  const key = `${fold(query)}|${scopeArg ? scopeKey(scopeArg) : ""}`;
  const cached = opts.fresh ? undefined : store.results.get(key);
  if (cached && Date.now() - cached.at < RESULT_TTL_MS) return cached.value;

  const t = new Timings();
  // The query as typed is embedded while the words are looked up; a correction (rare) embeds the corrected text instead.
  const early = t.time("embed", () => embedding(query));
  early.catch(() => {});
  const p = await prepare(raw, scopeArg, t);
  const vector = await (p.corrected ? t.time("embed_corrected", () => embedding(p.effective)) : early);

  // Only words that are not common go to the keyword side; with none left it is the meaning alone.
  const keywordWords = p.kw.filter((w) => share(p, w) < VAGUE.minShare);
  const scope = p.resolved ? p.resolved.search : null;
  let hits = await t.time("search", () => passages(vector, keywordWords.join(" "), scope)).catch((e) => {
    console.error("search tier b failed:", e instanceof Error ? e.message : e);
    return [] as RawHit[];
  });
  if (!hits.length && keywordWords.length) hits = await t.time("semantic", () => passages(vector, "", scope)).catch(() => [] as RawHit[]);
  await t.time("similarity", () => measure(hits, vector));

  const moments = toMoments(hits, p.kw, p.meta);
  const { groups, mode, exactEntity, pool } = assemble(p.matches, moments, p.meta);
  const vague = isVague({
    raw: p.query, contentWords: p.kw, exactEntity, wordCounts: p.counts, totalChunks: p.total,
    topSimilarities: hits.map((h) => h.similarity).filter((s): s is number => s != null).sort((a, b) => b - a),
  });

  // Chips only narrow a vague search. Sub-themes: the other words in the titles of clips about the query (matched by
  // title) and of the clips the top passages fall in.
  let chips: SearchResult["chips"] = [];
  if (vague) {
    const clipTitles = matchEntities(p.ix, p.effective, { kinds: ["clip"], perKind: 40, minScore: 0.7 }).map((m) => m.s.text);
    const overlapping = pool.flatMap((x) => p.meta.clipsOf(x.videoId).filter((c) => c.startS < x.endS && c.endS > x.startS).map((c) => c.title));
    const refine = refineCandidates([...new Set([...clipTitles, ...overlapping])], p.kw);
    const refineCounts = await t.time("chip_terms", () => wordCounts([...refine.keys()].slice(0, 200))).catch(() => new Map<string, number>());
    chips = buildChips({
      query: p.effective, queryWords: p.kw,
      topics: groups.topics.filter((x) => x.hits > 0).map((x) => ({ key: x.key, label: x.label, hits: x.hits, baseline: p.meta.topicShare(x.key) })),
      poolSize: pool.length,
      guests: groups.guests.filter((x) => x.hits > 0), refine, counts: refineCounts, totalChunks: p.total,
    });
  }

  t.mark("done");
  const result: SearchResult = {
    phase: "full", query: p.query, ...(p.corrected ? { corrected: p.corrected } : {}), mode, groups, vague, chips,
    ms: { ...t.stages, total: t.at.done },
  };
  if (isEmpty(groups)) console.error("search returned nothing for", JSON.stringify(p.query));
  store.results.set(key, { at: Date.now(), value: result });
  if (store.results.size > RESULT_MAX) store.results.delete(store.results.keys().next().value!);
  return result;
}
