import "server-only";
import { cacheLife } from "next/cache";
import { resolveScope, getScopeIndex } from "@/lib/ask/scope";
import { scopeIsEmpty, scopeKey, type AskScope } from "@/lib/ask/scope-types";
import { Timings } from "@/lib/ask/timing";
import { cosine, embedQueries } from "@/lib/ask/voyage";
import { getClipIndex } from "@/lib/clips";
import { getDirectory } from "@/lib/guests";
import { db } from "@/lib/db";
import { buildChips, refineCandidates } from "./chips";
import { correctQuery, wordCounts } from "./correct";
import { episodeTitles, getEntityIndex, inVocabulary, matchEntities, topicLabels } from "./entities";
import { HOST_WORDS, contentWords, fold, romanFold } from "./normalize";
import { RANK, assemble, isEmpty, toMoments, type ArchiveMeta, type ClipLite, type RawHit } from "./rank";
import type { SearchResult } from "./types";
import { isVague } from "./vague";

/** The search box (Ticket 27): runSearch(q, scope?) puts the tiers together.

    1. The query is folded; Devanagari is also spelled in Roman letters to look it up in the (Roman) vocabulary.
    2. Words in no passage and no suggestion are corrected to the nearest transcript word (correct.ts).
    3. Tier (a): suggestions matching the words (entities.ts). Tier (b): hybrid_search (or hybrid_search_scoped within a
       scope) with the content words as its keyword text and no similarity floor. Tier (c): if (b) returns nothing, the
       semantic nearest passages alone (hybrid_search with no keyword text).
    4. Groups, mode, vague and chips (rank.ts, vague.ts, chips.ts).
    One Voyage embedding per query not seen before (this server's memory, then the shared remote cache); whole results
    are kept 15 minutes. */

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
let metaMemo: { at: number; titles: Map<string, string>; meta: Promise<ArchiveMeta> } | null = null;
function archiveMeta(titles: Map<string, string>, topicLabels: Map<string, string>): Promise<ArchiveMeta> {
  if (metaMemo && metaMemo.titles === titles && Date.now() - metaMemo.at < 600_000) return metaMemo.meta;
  const meta = readArchiveMeta(titles, topicLabels);
  metaMemo = { at: Date.now(), titles, meta };
  meta.catch(() => { if (metaMemo?.meta === meta) metaMemo = null; });
  return meta;
}

async function readArchiveMeta(titles: Map<string, string>, topicLabels: Map<string, string>): Promise<ArchiveMeta> {
  const [ix, clipIndex, dir] = await Promise.all([getScopeIndex(), getClipIndex(), getDirectory()]);
  const byVideo = new Map(ix.episodes.map((e) => [e.v, e]));
  // Topics of an episode: its guests' sector tags that are topic suggestions (three or more guests have them).
  const tagsOf = new Map(dir.guests.map((g) => [g.slug, [...new Set(g.tags.map((t) => t.toLowerCase()).filter((t) => topicLabels.has(t)))]]));
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
    topicsOf: (v) => (topicsByVideo.get(v) ?? []).map((k) => ({ key: k, label: topicLabels.get(k)! })),
    topicShare: (k) => (perTopic.get(k) ?? 0) / episodes,
    clipsOf: (v) => clipsOf.get(v) ?? [],
    clipById: (id) => clipById.get(id),
  };
}

export async function runSearch(raw: string, scopeIn?: AskScope | null): Promise<SearchResult> {
  const query = raw.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_CHARS);
  const scopeArg = scopeIn && !scopeIsEmpty(scopeIn) ? scopeIn : null;
  const key = `${fold(query)}|${scopeArg ? scopeKey(scopeArg) : ""}`;
  const cached = store.results.get(key);
  if (cached && Date.now() - cached.at < RESULT_TTL_MS) return cached.value;

  const t = new Timings();
  // The Roman spelling of the query: what the vocabulary, chunk_terms and the keyword side understand.
  const roman = romanFold(query);
  const words = contentWords(roman);
  const [ix, counts, total, resolved] = await Promise.all([
    t.time("index", () => getEntityIndex()),
    t.time("terms", () => wordCounts(words)),
    t.time("chunks", () => totalChunks()),
    scopeArg ? t.time("scope", () => resolveScope(scopeArg)) : Promise.resolve(null),
  ]);

  const corrected = await t.time("correct", () => correctQuery(roman, words, counts, (w) => inVocabulary(ix, w)));
  const effective = corrected ? corrected.corrected : roman;
  const kw = contentWords(effective).filter((w) => !HOST_WORDS.has(w));
  if (corrected) for (const [w, n] of await wordCounts(kw.filter((w) => !counts.has(w)))) counts.set(w, n);

  // What is embedded: the corrected text, or the query as typed (Voyage reads Devanagari itself).
  const toEmbed = corrected ? corrected.corrected : query;
  const scope = resolved ? resolved.search : null;
  const [vector, meta] = await Promise.all([
    t.time("embed", () => embedding(toEmbed)),
    t.time("meta", () => archiveMeta(episodeTitles(ix), topicLabels(ix))),
  ]);

  let matches = matchEntities(ix, corrected ? corrected.corrected : query, { kinds: ["guest", "episode", "clip", "topic", "term"] });
  if (scope) {
    const inScope = new Set(scope.videoIds);
    matches = matches.filter((m) => (m.s.kind === "episode" ? inScope.has(m.s.ref) : m.s.kind === "clip" ? inScope.has(meta.clipById(Number(m.s.ref))?.videoId ?? "") : true));
  }

  // Tier (b), then (c) if it found nothing (or failed): the meaning alone.
  let hits = await t.time("search", () => passages(vector, kw.join(" "), scope)).catch((e) => {
    console.error("search tier b failed:", e instanceof Error ? e.message : e);
    return [] as RawHit[];
  });
  if (!hits.length) hits = await t.time("semantic", () => passages(vector, "", scope)).catch(() => [] as RawHit[]);
  await t.time("similarity", () => measure(hits, vector));

  const moments = toMoments(hits, kw, meta);
  const { groups, mode, exactEntity, pool } = assemble(matches, moments, meta);
  const vague = isVague({
    raw: query, contentWords: kw, exactEntity, wordCounts: counts, totalChunks: total,
    topSimilarities: hits.map((h) => h.similarity).filter((s): s is number => s != null).sort((a, b) => b - a),
  });

  // Chips' sub-themes: the other words in the titles of clips about the query (matched by title) and of the clips the
  // top passages fall in.
  const clipTitles = matchEntities(ix, corrected ? corrected.corrected : query, { kinds: ["clip"], perKind: 40, minScore: 0.7 }).map((m) => m.s.text);
  const overlapping = pool.flatMap((p) => meta.clipsOf(p.videoId).filter((c) => c.startS < p.endS && c.endS > p.startS).map((c) => c.title));
  const titles = [...new Set([...clipTitles, ...overlapping])];
  const refine = refineCandidates(titles, kw);
  const refineCounts = await t.time("chip_terms", () => wordCounts([...refine.keys()].slice(0, 200))).catch(() => new Map<string, number>());
  const chips = buildChips({
    query: corrected ? corrected.corrected : query, queryWords: kw,
    topics: groups.topics.filter((x) => x.hits > 0), guests: groups.guests.filter((x) => x.hits > 0),
    refine, counts: refineCounts, totalChunks: total,
  });

  t.mark("done");
  const result: SearchResult = {
    query, ...(corrected ? { corrected } : {}), mode, groups, vague, chips,
    ms: { ...t.stages, total: t.at.done },
  };
  if (isEmpty(groups)) console.error("search returned nothing for", JSON.stringify(query));
  store.results.set(key, { at: Date.now(), value: result });
  if (store.results.size > RESULT_MAX) store.results.delete(store.results.keys().next().value!);
  return result;
}
