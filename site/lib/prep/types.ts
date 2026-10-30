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

/** An opportunity the returning guest named (insights.type = 'opportunity', verified, mostly spoken by the guest),
    shown as it was extracted. `category` is its label ("Business idea"). */
export type BriefOpportunity = BriefQuestion & { category: string };

/** The host's questions to the returning guest in one of their past episodes. */
export type BriefEpisodeQuestions = { videoId: string; episode: string; date: string; questions: BriefQuestion[] };

/** The sections about a guest who has been on the show before, all from their own past episodes. */
export type BriefReturning = {
  name: string;
  /** 3 to 5 cited sentences on who they are and what they built or said. */
  about: BriefLine[];
  /** Newest episode first. */
  asked: BriefEpisodeQuestions[];
  opportunities: BriefOpportunity[];
};

/** One line of "From the web": written from one public web page found for this request, with that page's address.
    Not from the archive; the page labels the whole section so. `date` (YYYY-MM-DD) is the page's publish date as the
    search service gave it, when it gave one. */
export type WebLine = { id: string; text: string; url: string; date: string | null };

/** "From the web": public, professional facts about the upcoming guest, added on request after the brief is built. */
export type BriefWeb = {
  /** ISO time of the search. */
  checkedAt: string;
  /** "Name, role at company" as the sources describe them; null when the person could not be identified with
      confidence (then every list is empty). */
  matched: string | null;
  /** A returning guest: the date (ISO) of their latest episode in the archive, for "Since their last episode". */
  lastEpisode: string | null;
  background: WebLine[];
  /** Newest first. */
  news: WebLine[];
  appearances: WebLine[];
  /** Returning guest only: dated items after their last episode, newest first. */
  since: WebLine[];
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
  /** A named guest who is not in the archive (the page says it is their first appearance). */
  firstAppearance: boolean;
  /** Set when `already` is: the sections from the guest's own episodes, shown first. */
  returning: BriefReturning | null;
  /** "From the web", once the reader asked for it (shown above everything else). */
  web: BriefWeb | null;
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
