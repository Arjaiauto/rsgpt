/** What the site saves (public.saved_items; see pipeline/sql/saved_items.sql). */
import type { Cite } from "@/lib/ask/types";

export type ClipRef = { videoId: string; startS: number; endS: number; title: string; guest: string; episode: string; date?: string };
export type AnswerRef = { question: string; answer: string; citations: Cite[] };

export type SaveInput =
  | { kind: "clip"; ref: ClipRef }
  | { kind: "answer"; ref: AnswerRef };
