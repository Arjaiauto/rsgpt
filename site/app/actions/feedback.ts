"use server";

import { cookies } from "next/headers";
import { requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { takeUser, USER_LIMITS } from "@/lib/rate-limit";
import { VISITOR_COOKIE } from "@/lib/session";

export type Rating = "up" | "down";

/** Saves (or changes) the signed-in person's thumbs up/down on one answer or brief: a qa_log row.
    pipeline/sql/answer_feedback.sql: one vote per person per row, set_answer_feedback upserts. The note
    (the one-line "what was wrong") is kept only with a thumbs-down. */
export async function sendFeedback(input: { qaLogId: number; rating: Rating; note?: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  const { firstName } = await requireSession();
  if (!Number.isSafeInteger(input.qaLogId) || input.qaLogId <= 0 || (input.rating !== "up" && input.rating !== "down")) return { ok: false, error: "Couldn't save that." };
  if (!(await takeUser("feedback", firstName, USER_LIMITS.feedback.max, USER_LIMITS.feedback.windowMs))) {
    return { ok: false, error: "Too many votes. Wait a few minutes and try again." };
  }
  const note = typeof input.note === "string" ? input.note.replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) : "";
  const visitorId = (await cookies()).get(VISITOR_COOKIE)?.value ?? null;
  const { data, error } = await db().rpc("set_answer_feedback", {
    p_qa_log_id: input.qaLogId, p_first_name: firstName, p_visitor_id: visitorId, p_rating: input.rating, p_note: note || null,
  });
  if (error) {
    console.error("feedback failed:", error.message);
    return { ok: false, error: "Couldn't save your feedback. Try again." };
  }
  if (data === false) return { ok: false, error: "That answer is no longer available." };
  return { ok: true };
}
