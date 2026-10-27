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
  /** "Host" or the guest's name. */
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
