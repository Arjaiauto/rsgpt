/** Adaptive-thinking effort for the answer. (Haiku 5.5 has no fixed thinking budget: budget_tokens is a 400.) */
export type AnswerEffort = "low" | "medium";

/** Every tunable number of the Ask page in one place. */
export const ASK = {
  /** CLAUDE.md rule 5: claude-haiku-5-5 for answers. */
  model: "claude-haiku-5-5",
  answerEffort: "low" as AnswerEffort,
  /** Rule 2: uncited sentences are dropped; an answer left with fewer cited sentences than this is not shown. */
  minCitedSentences: 2,
  /** A NOT_FOUND reply (or one left with too few cited sentences) is retried once, at medium effort, when the best chunk is at
      least this similar. Real questions measured 0.52-0.62, "capital of Australia" 0.44 (2026-10-27). */
  retrySimilarity: 0.5,

  voyage: { url: "https://ai.mongodb.com/v1/embeddings", model: "voyage-4", dimensions: 512 },

  /** hybrid_search match_count for each of the 3 phrasings (English, Hinglish, Hindi). */
  perPhrasing: 20,
  /** Chunks kept after merging the 3 searches, at most maxPerEpisode per episode. */
  merged: 20,
  maxPerEpisode: 2,
  /** Chunks sent to the model as search results (each about 90 seconds, split into timed turns). */
  toModel: 10,

  /** Questions about the host's own views favour recent episodes: weight 0.5^(age_days / halfLifeDays). */
  hostViewHalfLifeDays: 730,

  /** Cosine similarity (question vs chunk embedding) the best chunk needs, or the answer is "not found".
      Rank-fusion scores are relative, so they can't say "nothing matches"; this is absolute. */
  minSimilarity: 0.4,

  /** A turn of the transcript becomes one citable block; long turns are split so a citation stays precise. */
  maxTurnSeconds: 40,

  maxQuestionChars: 400,
  /** Questions per visitor (falls back to IP) in the window. */
  rateLimit: { max: 30, windowMs: 10 * 60 * 1000 },
} as const;

/** How timestamp chips and transcript lines name the host (third person, like the answers). */
export const HOST_NAME = "Raj Shamani";

/** Find a line: similarity of the best matching transcript line (pg_trgm, 0 to 1). */
export const FIND_LINE = {
  /** At or above: "Exact line found". */
  exact: 0.55,
  /** At or above (below exact): "Closest line". Below: not found. */
  closest: 0.32,
  /** Lines shown on each side of the matched one. */
  context: 6,
  /** The clip plays this long from the matched line. */
  clipSeconds: 45,
  minChars: 6,
  maxChars: 200,
} as const;

/** Questions the archive covers well (shown when a question isn't found). Checked against the archive on 2026-10-27. */
export const COVERED_QUESTIONS = [
  "What have founders said about raising their first round?",
  "Which guests talked about building a D2C brand in India?",
  "Health aur sleep pe guests ne kya kaha?",
  "What do guests say about failure and starting again?",
  "Which guests talked about investing in the stock market?",
];

export const EXAMPLE_QUESTIONS = [
  "What have founders said about raising their first round?",
  "Raj ka AI ke baare mein kya opinion hai?",
  "स्वास्थ्य और नींद पर गेस्ट्स ने क्या कहा?",
  "Which guests built D2C brands in India?",
];
