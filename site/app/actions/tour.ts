"use server";

import { cookies } from "next/headers";
import { after } from "next/server";
import { requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { cookieOptions, tourHash } from "@/lib/session";
import { TOUR_COOKIE } from "@/lib/tour";

/** The person closed the welcome tour (finished, skipped or Esc): remember it on this device at once, and in
    visitors.tour_seen_at after the response is sent, so another device doesn't show it again. Never fails the page. */
export async function markTourSeen(): Promise<void> {
  const { firstName } = await requireSession();
  (await cookies()).set(TOUR_COOKIE, tourHash(firstName), { ...cookieOptions, maxAge: 60 * 60 * 24 * 365 });
  after(async () => {
    try {
      const { error } = await db().rpc("mark_tour_seen", { p_name: firstName }).abortSignal(AbortSignal.timeout(3000));
      if (error) throw new Error(error.message);
    } catch (e) {
      console.error("mark_tour_seen failed:", e instanceof Error ? e.message : "unknown");
    }
  });
}
