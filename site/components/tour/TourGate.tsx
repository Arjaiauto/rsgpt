import { cookies } from "next/headers";
import { requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { tourHash } from "@/lib/session";
import { TOUR_COOKIE } from "@/lib/tour";
import { TourHost } from "./TourHost";

/** Decides whether this person's tour opens by itself: only when they have never closed it. The device cookie answers
    first (no database read); without it, visitors.tour_seen_at (by name) says whether another device already showed it.
    If that lookup fails the tour stays closed. The "? Tour" button works either way. */
export async function TourGate() {
  const { firstName } = await requireSession();
  let open = false;
  if ((await cookies()).get(TOUR_COOKIE)?.value !== tourHash(firstName)) {
    try {
      const { data, error } = await db().from("visitors").select("tour_seen_at").eq("name_key", firstName.trim().toLowerCase()).maybeSingle();
      open = !error && !data?.tour_seen_at;
    } catch {
      open = false;
    }
  }
  return <TourHost autoOpen={open} />;
}
