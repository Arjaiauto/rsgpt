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

  /** Ask within a scope (28d): a scope of at most this many chunks is searched exactly (every chunk in it compared with
      the question); a bigger one through the HNSW index (the 200 nearest of the archive, then those in scope). See
      pipeline/sql/hybrid_search_scoped.sql. Lowered only if timing shows the exact search is too slow for big scopes. */
  scopeExactMaxChunks: Number.POSITIVE_INFINITY,

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

/** Answer length (the Short / Medium / Detailed toggle on the Ask page). The choice is remembered in the cookie below.
    The instruction goes in the user turn after the question, not in the system prompt, so the cached system prompt is
    the same for every mode. Medium adds nothing: it is the system prompt's own "3 to 6 short sentences". */
export type AnswerLength = "short" | "medium" | "detailed";
export const ANSWER_LENGTH_COOKIE = "answer_length";
export const ANSWER_LENGTHS: Record<AnswerLength, { label: string; toModel: number; instruction: string | null }> = {
  short: {
    label: "Short",
    toModel: 5,
    instruction: "Length for this answer (this replaces the sentence count in your instructions): write 2 to 3 sentences, each citing a different moment, and nothing else. Keep only the strongest points.",
  },
  medium: { label: "Medium", toModel: ASK.toModel, instruction: null },
  detailed: {
    label: "Detailed",
    toModel: 12,
    instruction: "Length for this answer (this replaces the sentence count in your instructions): write 5 to 8 sentences. Group them by guest: finish what one guest said before moving to the next, and name the guest at the start of their group. Every sentence still carries its own citation.",
  },
};
export const parseAnswerLength = (v: unknown): AnswerLength | null => (v === "short" || v === "medium" || v === "detailed" ? v : null);
