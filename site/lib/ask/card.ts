import "server-only";
import { sourceOf, type Retrieved } from "./retrieve";
import { pickSnippet, queryTerms } from "./snippet";
import type { Cite, RefMoment } from "./types";

/** The "Best matching moment" card, in its two stages. Neither changes retrieval or ranking: they only read what
    retrieve() and the answer already produced. */

/** Stage 1, sent as soon as the search is done so the card appears fast: the top-ranked passage, starting at the line the
    card quotes (the passage itself is about 90 seconds). */
export function matchRef(question: string, r: Retrieved): RefMoment {
  const best = r.chunks[0];
  const snippet = pickSnippet(r.turns.get(best.id) ?? [], queryTerms(question, r.rewritten));
  const startS = snippet?.startS ?? best.startS;
  return { ...sourceOf(r.episodes.get(best.videoId)!, startS, best.endS), chunkId: best.id, snippet: snippet?.text };
}

/** Stage 2, sent when the answer is complete: of the passages the answer cites, the one most similar to the question
    (cosine, already computed for every candidate), shown from the first cited line of it. On a tie the earlier
    citation wins. Null when the answer cites nothing. */
export function answerRef(question: string, r: Retrieved, cited: Cite[]): RefMoment | null {
  if (!cited.length) return null;
  const similarity = new Map(r.chunks.map((c) => [c.id, c.similarity]));
  let best = cited[0];
  for (const c of cited) if ((similarity.get(c.chunkId) ?? 0) > (similarity.get(best.chunkId) ?? 0)) best = c;
  // The lines the answer cited, not the whole passage.
  const turns = (r.turns.get(best.chunkId) ?? []).filter((t) => t.startS >= best.startS - 0.01 && t.endS <= best.endS + 0.01);
  const snippet = pickSnippet(turns, queryTerms(question, r.rewritten));
  return {
    ...sourceOf(r.episodes.get(best.videoId)!, best.startS, Math.max(best.endS, best.startS + 45)),
    chunkId: best.chunkId,
    snippet: snippet?.text,
  };
}
