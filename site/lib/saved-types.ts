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
