"use server";

import { cookies } from "next/headers";
import { requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { takeUser, USER_LIMITS } from "@/lib/rate-limit";
import { VISITOR_COOKIE } from "@/lib/session";
import { REPORT_ITEM_TYPES, REPORT_REASONS, type ReportInput } from "@/lib/report-types";

/** Saves one error report to the reports table (server only; the table has RLS on and no policies). */
export async function sendReport(input: ReportInput): Promise<{ ok: true } | { ok: false; error: string }> {
  const { firstName } = await requireSession();
  if (!(await takeUser("report", firstName, USER_LIMITS.report.max, USER_LIMITS.report.windowMs))) return { ok: false, error: "Too many reports. Wait a few minutes and try again." };
  const reason = REPORT_REASONS.find((r) => r.label === input.reason)?.label;
  if (!reason) return { ok: false, error: "Pick a reason." };
  if (!REPORT_ITEM_TYPES.includes(input.itemType)) return { ok: false, error: "Unknown item." };
  const note = (input.note ?? "").trim().slice(0, 280) || null;
  const visitorId = (await cookies()).get(VISITOR_COOKIE)?.value ?? null;
  const { error } = await db().from("reports").insert({
    item_type: input.itemType,
    item_id: String(input.itemId).slice(0, 100),
    video_id: input.videoId ? String(input.videoId).slice(0, 32) : null,
    start_s: Number.isFinite(input.startS) ? input.startS : null,
    reason,
    note,
    first_name: firstName,
    visitor_id: visitorId,
    page: String(input.page ?? "").slice(0, 200) || null,
  });
  if (error) {
    console.error("report insert failed", error.message);
    return { ok: false, error: "Couldn't send the report. Try again." };
  }
  return { ok: true };
}
