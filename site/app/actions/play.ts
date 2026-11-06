"use server";

import { cookies } from "next/headers";
import { logEvent } from "@/lib/activity";
import { requireSession } from "@/lib/auth";
import { takeUser, USER_LIMITS } from "@/lib/rate-limit";
import { VISITOR_COOKIE } from "@/lib/session";

/** The "Play all" button on an Ask answer was pressed: one play_all event (pipeline/sql/events_play_all.sql) with the
    answer's qa_log id and the number of clips. Logging only; it never fails the click. */
export async function recordPlayAll(input: { answerId: number | null; clips: number }): Promise<void> {
  const { firstName } = await requireSession();
  if (!Number.isSafeInteger(input.clips) || input.clips < 1 || input.clips > 50) return;
  if (!(await takeUser("event", firstName, USER_LIMITS.events.max, USER_LIMITS.events.windowMs))) return;
  const detail: Record<string, string> = { clips: String(input.clips) };
  if (input.answerId != null && Number.isSafeInteger(input.answerId) && input.answerId > 0) detail.answer = String(input.answerId);
  logEvent(firstName, (await cookies()).get(VISITOR_COOKIE)?.value ?? null, "play_all", detail);
}
