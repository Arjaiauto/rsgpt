import "server-only";
import { db } from "@/lib/db";
import type { Correction } from "./types";

/** Typo correction for the search box (Ticket 27): a word that is in neither the transcripts' vocabulary
    (public.chunk_terms) nor the suggestions, and whose nearest transcript word (public.near_words, trigram similarity)
    is at least CORRECT.minSimilarity alike, is replaced by that word. "fundrasing" -> "fundraising". */

export const CORRECT = {
  minSimilarity: 0.5,
  /** Shorter words are left alone: too many real words are one letter apart. */
  minLength: 4,
} as const;

/** What this server already knows about words (chunk_terms changes only when the chunks are reloaded): counts and
    nearest words are kept an hour, so the fast search phase usually has no database call at all. */
const TTL_MS = 60 * 60 * 1000;
const MAX_CACHED = 20_000;
type Memo = { counts: Map<string, { at: number; n: number }>; near: Map<string, { at: number; to: { word: string; similarity: number } | null }> };
const memo = ((globalThis as { __searchWords?: Memo }).__searchWords ??= { counts: new Map(), near: new Map() });
const fresh = (at: number) => Date.now() - at < TTL_MS;
function remember<V>(map: Map<string, V>, key: string, value: V) {
  map.set(key, value);
  if (map.size > MAX_CACHED) map.delete(map.keys().next().value!);
}

/** chunk_terms counts for these words (a missing word is in no passage and is not in the result). */
export async function wordCounts(words: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const need: string[] = [];
  for (const w of new Set(words.filter(Boolean))) {
    const c = memo.counts.get(w);
    if (c && fresh(c.at)) { if (c.n > 0) out.set(w, c.n); } else need.push(w);
  }
  if (!need.length) return out;
  const { data, error } = await db().from("chunk_terms").select("word,chunk_count").in("word", need);
  if (error) throw new Error(`chunk_terms: ${error.message}`);
  const found = new Map((data ?? []).map((r) => [r.word as string, r.chunk_count as number]));
  for (const w of need) {
    remember(memo.counts, w, { at: Date.now(), n: found.get(w) ?? 0 });
    if (found.has(w)) out.set(w, found.get(w)!);
  }
  return out;
}

async function nearest(word: string): Promise<{ word: string; similarity: number } | null> {
  const hit = memo.near.get(word);
  if (hit && fresh(hit.at)) return hit.to;
  const { data, error } = await db().rpc("near_words", { p_word: word, p_limit: 3, p_min_similarity: CORRECT.minSimilarity });
  if (error) throw new Error(`near_words: ${error.message}`);
  const top = (data ?? [])[0] as { word: string; similarity: number } | undefined;
  const to = top && top.similarity >= CORRECT.minSimilarity ? { word: top.word, similarity: top.similarity } : null;
  remember(memo.near, word, { at: Date.now(), to });
  return to;
}

/** The query with its misspelt words corrected, or null when nothing changed. `known(word)` says whether a word is a
    suggestion's (guest, topic, title, term); `counts` holds the chunk_terms counts already read for these words. Only
    Roman words are checked (Devanagari is never in chunk_terms). */
export async function correctQuery(folded: string, words: string[], counts: Map<string, number>, known: (w: string) => boolean): Promise<Correction | null> {
  const suspects = words.filter((w) => w.length >= CORRECT.minLength && /^[a-z]+$/.test(w) && !counts.has(w) && !known(w));
  if (!suspects.length) return null;
  const fixes = new Map<string, string>();
  await Promise.all(suspects.map(async (w) => {
    const near = await nearest(w).catch(() => null);
    if (near) fixes.set(w, near.word);
  }));
  if (!fixes.size) return null;
  const corrected = folded.split(" ").map((w) => fixes.get(w) ?? w).join(" ");
  return { corrected, from: [...fixes.keys()].join(" "), to: [...fixes.values()].join(" ") };
}
