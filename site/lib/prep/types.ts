/** Shapes of a Prep brief, shared by the server (lib/prep/build.ts), the API route, saved_items and the page.
    Everything a brief states as fact points at the transcript (CLAUDE.md rule 2): a cited line carries `cites`, a
    past question carries its segment ids and time. Only suggestions carry no source. */
import type { Cite } from "@/lib/ask/types";

/** One sentence written from the archive, with the transcript moments it rests on (at least one). */
export type BriefLine = { id: string; text: string; cites: Cite[] };

export type BriefGuest = {
  id: string;
  slug: string;
  name: string;
  org: string | null;
  photoUrl: string | null;
  tags: string[];
  /** One line on why this guest is similar, cited. */
  why: BriefLine;
};

/** A real question the host asked (insights.type = 'raj_question', verified), shown as it was extracted. */
export type BriefQuestion = {
  id: string;
  insightId: number;
  text: string;
  /** The guest it was asked to. */
  guest: string;
  slug: string | null;
  videoId: string;
  episode: string;
  /** e.g. "Mar 2025" */
  date: string;
  startS: number;
  endS: number;
  segmentIds: number[];
};

/** A sector tag of the similar guests and how many archive episodes have a guest with it. */
export type BriefTopic = { id: string; tag: string; episodes: number; examples: string[] };

/** An idea for a new question. The only lines of a brief with no source; the page labels them "Suggestion". */
export type BriefSuggestion = { id: string; text: string };

export type Brief = {
  version: 1;
  /** The guest's name, or the sector label for a brief built from a sector chip. */
  title: string;
  description: string;
  /** Sector key when the brief was built from a sector chip. */
  sector: string | null;
  /** ISO time the brief was built. */
  builtAt: string;
  preparedFor: string;
  /** Transcribed episodes in the archive when it was built. */
  archiveEpisodes: number;
  /** The upcoming guest already appeared on the show. */
  already: { name: string; slug: string; episodes: number } | null;
  similar: BriefGuest[];
  asked: BriefQuestion[];
  topics: BriefTopic[];
  suggestions: BriefSuggestion[];
  verify: BriefLine[];
  /** Ids of lines struck out by the editor. Struck lines stay in the brief (Undo) but are left out of every export. */
  removed: string[];
};

export type PrepInput = { name: string; description: string; sector: string | null };

/** Events on the NDJSON stream from POST /api/prep, one JSON object per line. */
export type PrepEvent =
  | { type: "step"; step: 1 | 2 | 3 }
  | { type: "brief"; brief: Brief }
  | { type: "notfound"; message: string }
  | { type: "error"; message: string }
  | { type: "done"; logId: number | null };

/** A row of the Past briefs list. */
export type PastBrief = { id: number; title: string; description: string; createdAt: string };

export const PREP_LIMITS = { name: 80, description: 200 } as const;
