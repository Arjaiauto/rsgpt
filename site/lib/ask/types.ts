/** Shapes shared by the /api/ask stream (server) and the Ask page (client). */

export type AskLanguage = "en" | "hi" | "hinglish";

/** One citation, mapped from Claude's search_result_location to the transcript lines it points at. */
export type Cite = {
  chunkId: number;
  videoId: string;
  /** Start of the first cited line and end of the last one, in seconds. */
  startS: number;
  endS: number;
  segmentIds: number[];
  /** "Raj Shamani" (third person, as in the answers) or the guest's name. */
  speaker: string;
  /** e.g. "Mar 2025" */
  date: string;
  episode: string;
  guest: string;
};

export type Source = {
  videoId: string;
  episode: string;
  guest: string;
  date: string;
  durationS: number | null;
  /** The moment to play when the card is clicked. */
  startS: number;
  endS: number;
};

export type RefMoment = Source & { chunkId: number };

/** Events on the NDJSON stream from POST /api/ask, one JSON object per line. */
export type AskEvent =
  | { type: "step"; step: 1 | 2 | 3; moments?: number; episodes?: number }
  | { type: "found"; sources: Source[]; language: AskLanguage }
  /** The reference player: the first moment the answer cites. */
  | { type: "ref"; ref: RefMoment }
  | { type: "text"; block: number; text: string }
  | { type: "cite"; block: number; cite: Cite }
  | { type: "sources"; sources: Source[] }
  /** thin: the episodes matched, but too little of the answer could be cited to show it. */
  | { type: "notfound"; suggestions: string[]; language: AskLanguage; thin?: boolean }
  | { type: "done"; answerId: number | null; followups: string[]; cited: number }
  | { type: "error"; message: string }
  /** Development only (x-ask-debug header, not in production): timings and what was retrieved. */
  | { type: "debug"; data: unknown };

/* ---------- Find a line (POST /api/find-line) ---------- */

export type LineRow = {
  segmentId: number;
  seq: number;
  startS: number;
  endS: number;
  /** "Raj Shamani", the guest's name, or "" when the speaker isn't known. */
  speaker: string;
  text: string;
};

export type LineMatch = {
  /** 0 to 1: pg_trgm similarity of the best line. */
  similarity: number;
  /** At or above FIND_LINE.exact. */
  exact: boolean;
  videoId: string;
  episode: string;
  guest: string;
  date: string;
  durationS: number | null;
  /** segmentId of the matched line; it is one of `lines`. */
  hitId: number;
  /** About FIND_LINE.context lines either side of the match, in order. */
  lines: LineRow[];
};

export type FindLineResult = { status: "found"; match: LineMatch } | { status: "none" };
