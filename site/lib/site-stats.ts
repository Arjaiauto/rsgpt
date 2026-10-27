import "server-only";
import { cacheLife } from "next/cache";
import { db } from "./db";

/** Every number on the public home page, counted from verified rows in Supabase (CLAUDE.md rule 9) by
    pipeline/site_stats.py and stored in public.site_stats. */
export type SiteStats = {
  episodesListed: number;
  episodesTranscribed: number;
  episodesSkipped: number;
  /** Timed transcript lines across all transcribed episodes. */
  transcriptLines: number;
  /** Lines from Hindi-caption episodes, each written in Roman Hinglish and translated to English. */
  hindiLines: number;
  /** Share of transcript lines labelled host or guest (0-100). */
  speakerLabelledPct: number;
  /** Items the extraction step produced in the final run (insights, clips, guest profiles). */
  extracted: number;
  /** Of those, how many passed the code checks (verified = true). */
  verified: number;
  verifiedPct: number;
  verifiedClips: number;
  verifiedHostQuestions: number;
  /** Unique guest_key among verified guest rows. */
  guests: number;
  /** Searchable passages (chunks). */
  passages: number;
  /** Opportunity categories that have at least one verified opportunity. */
  opportunityCategories: number;
  /** When these numbers were counted (ISO). */
  countedAt: string;
};

/** Last good numbers, counted from the database on 2026-10-27 (guests: 2026-10-28, after pipeline/corrections.json). Used only if the database can't be reached
    at build or revalidation time and this server has no newer result in memory. */
const SNAPSHOT: SiteStats = {
  episodesListed: 500,
  episodesTranscribed: 499,
  episodesSkipped: 1,
  transcriptLines: 1_047_059,
  hindiLines: 732_026,
  speakerLabelledPct: 99.8,
  extracted: 36_797,
  verified: 36_197,
  verifiedPct: 98.4,
  verifiedClips: 2_705,
  verifiedHostQuestions: 18_533,
  guests: 428,
  passages: 35_234,
  opportunityCategories: 13,
  countedAt: "2026-10-27T00:00:00.000Z",
};

let lastGood: SiteStats | null = null;

const DAY = 60 * 60 * 24;

/** The counts pipeline/site_stats.py stored in public.site_stats (one row). Cached for 24 hours, so the public
    home page never queries the database on a visit; if the row can't be read, the last good numbers are used. */
export async function getSiteStats(): Promise<SiteStats> {
  "use cache";
  try {
    const { data, error } = await db().from("site_stats").select("stats").eq("id", 1).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error("site_stats has no row yet; run pipeline/site_stats.py");
    const stats = { ...SNAPSHOT, ...(data.stats as Partial<SiteStats>) };
    lastGood = stats;
    cacheLife({ revalidate: DAY });
    return stats;
  } catch (e) {
    console.warn("site stats: using last good numbers:", e instanceof Error ? e.message : e);
    // Try again within the hour instead of keeping the fallback for a whole day.
    cacheLife({ revalidate: 60 * 60 });
    return lastGood ?? SNAPSHOT;
  }
}
