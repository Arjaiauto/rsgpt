/** Is a query too broad to answer with one list (Ticket 27; shared with the Ask page's 28e)? Pure.

    Vague when all of:
      - at most 2 content words ("ai", "startup", "mental health"),
      - it is not exactly the name of a guest, episode or clip (a topic or a common term does not count),
      - and it is common: a word of it is in at least VAGUE.minShare of all passages (chunk_terms), or the best passages
        are all about as close as each other (nothing stands out).
    A question ("how to raise money", "kya hai ipo?") is never vague: it is answered as asked. */

import { isQuestion } from "./normalize";

export const VAGUE = {
  maxContentWords: 2,
  /** Share of passages containing the word. "startup" and "ai" are far above it, "aghori" far below. */
  minShare: 0.015,
  /** "Flat": the top passages' similarities lie within this of each other... */
  flatSpread: 0.03,
  /** ...or even the best one is no closer than this. */
  weakBest: 0.45,
  flatOver: 10,
} as const;

export type VagueInput = {
  raw: string;
  contentWords: string[];
  /** The query is exactly a guest's name or an episode or clip title. */
  exactEntity: boolean;
  /** chunk_terms count of each content word (missing: not in the transcripts). */
  wordCounts: Map<string, number>;
  totalChunks: number;
  /** Cosine similarities of the top passages, best first (may be empty). */
  topSimilarities: number[];
};

export function isFlat(similarities: number[]): boolean {
  if (!similarities.length) return false;
  const top = similarities.slice(0, VAGUE.flatOver);
  return top[0] < VAGUE.weakBest || (top.length >= 5 && top[0] - top[top.length - 1] < VAGUE.flatSpread);
}

export function isVague(v: VagueInput): boolean {
  if (isQuestion(v.raw)) return false;
  if (v.contentWords.length > VAGUE.maxContentWords) return false;
  if (v.exactEntity) return false;
  const common = v.totalChunks > 0 && v.contentWords.some((w) => (v.wordCounts.get(w) ?? 0) / v.totalChunks >= VAGUE.minShare);
  return common || isFlat(v.topSimilarities);
}
