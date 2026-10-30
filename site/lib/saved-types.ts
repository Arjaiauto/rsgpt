/** What the site saves (public.saved_items; see pipeline/sql/saved_items.sql). */
import type { Cite } from "@/lib/ask/types";
import type { Brief } from "@/lib/prep/types";

export type ClipRef = { videoId: string; startS: number; endS: number; title: string; guest: string; episode: string; date?: string };
export type AnswerRef = { question: string; answer: string; citations: Cite[] };

/** A Prep brief as saved: the whole brief with the editor's changes in its texts and struck lines in `removed`. */
export type BriefRef = Brief;

export type SaveInput =
  | { kind: "clip"; ref: ClipRef }
  | { kind: "answer"; ref: AnswerRef }
  | { kind: "brief"; ref: BriefRef };

/* ---------- the Saved page (Ticket 23a) ---------- */

/** What every saved item carries, whatever its kind. */
export type SavedMeta = { id: number; createdAt: string; folder: string | null; note: string };
export type SavedClip = SavedMeta & {
  kind: "clip"; videoId: string; startS: number; endS: number; title: string; guest: string; episode: string; date: string;
};
/** The list holds a preview and a count; the whole answer is read when it is opened (loadSavedAnswer). */
export type SavedAnswer = SavedMeta & { kind: "answer"; question: string; preview: string; sources: number };
export type SavedBrief = SavedMeta & { kind: "brief"; title: string; description: string; builtAt: string; sections: number };

export type SavedList = {
  firstName: string;
  clips: SavedClip[];
  answers: SavedAnswer[];
  briefs: SavedBrief[];
  /** A list hit its cap (1,000 clips, 500 answers, 200 briefs): older items are not shown. */
  capped: boolean;
};

/** A row as it was removed, kept in the browser for Undo and sent back to restoreSaved. */
export type SavedRow = { kind: "clip" | "answer" | "brief"; itemRef: Record<string, unknown>; folder: string | null; note: string; createdAt: string };

export const SAVED_LIMITS = { folder: 40, note: 500 } as const;
