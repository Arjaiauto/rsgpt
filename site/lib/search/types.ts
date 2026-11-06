/** Shapes of the search box's results (Ticket 27). Shared by the server (lib/search/search.ts) and, later, the page. */

export type SuggestionKind = "guest" | "topic" | "episode" | "clip" | "term";

/** One row of public.search_suggestions as the in-memory index keeps it. */
export type Suggestion = {
  kind: SuggestionKind;
  ref: string;
  text: string;
  folded: string;
  aliases: string[];
  weight: number;
};

/** How a suggestion matched what was typed, best first. */
export type MatchHow = "exact" | "prefix" | "word" | "fuzzy";
export type EntityMatch = { s: Suggestion; score: number; how: MatchHow };

export type Correction = { corrected: string; from: string; to: string };

/** `matched`: found by its name or title (tier a); otherwise it comes from the passages (tier b / c). */
export type GuestHit = { slug: string; name: string; hits: number; matched: boolean };
export type EpisodeHit = { videoId: string; title: string; year: number | null; guests: string[]; hits: number; matched: boolean };
export type ClipHit = { id: number; videoId: string; startS: number; endS: number; title: string; guest: string; matched: boolean };
export type TopicHit = { key: string; label: string; hits: number; matched: boolean };
export type MomentHit = {
  chunkId: number;
  videoId: string;
  startS: number;
  endS: number;
  /** About 200 characters of the passage, around the first searched word when it has one. */
  snippet: string;
  episode: string;
  guests: string[];
  year: number | null;
  /** hybrid_search's fused score (relative: for ordering only). */
  score: number;
  /** Cosine similarity of the passage to the query, when measured (the top few). */
  similarity: number | null;
  /** The passage contains one of the searched words (a keyword hit, not only a semantic one). */
  keyword: boolean;
};

export type Chip = { label: string; kind: "topic" | "guest" | "refine"; value: string };

export type SearchGroups = { guests: GuestHit[]; episodes: EpisodeHit[]; clips: ClipHit[]; moments: MomentHit[]; topics: TopicHit[] };

export type SearchResult = {
  /** fast: the names and titles only (no embedding, no passage search); full: everything. The page asks for fast first. */
  phase?: "fast" | "full";
  query: string;
  corrected?: Correction;
  /** exact: something matched the words typed (a name, a title or a passage); closest: only the nearest in meaning. */
  mode: "exact" | "closest";
  groups: SearchGroups;
  /** Too broad to show as one list: the page offers the chips to narrow it. */
  vague: boolean;
  chips: Chip[];
  /** Stage timings in ms (server logs and the test script). */
  ms?: Record<string, number>;
};
