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

/** chunk_terms counts for these words (a missing word is in no passage). */
export async function wordCounts(words: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const unique = [...new Set(words.filter(Boolean))];
  if (!unique.length) return out;
  const { data, error } = await db().from("chunk_terms").select("word,chunk_count").in("word", unique);
  if (error) throw new Error(`chunk_terms: ${error.message}`);
  for (const r of data ?? []) out.set(r.word as string, r.chunk_count as number);
  return out;
}

async function nearest(word: string): Promise<{ word: string; similarity: number } | null> {
  const { data, error } = await db().rpc("near_words", { p_word: word, p_limit: 3, p_min_similarity: CORRECT.minSimilarity });
  if (error) throw new Error(`near_words: ${error.message}`);
  const top = (data ?? [])[0] as { word: string; similarity: number } | undefined;
  return top && top.similarity >= CORRECT.minSimilarity ? { word: top.word, similarity: top.similarity } : null;
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
