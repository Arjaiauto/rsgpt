import "server-only";
import { cacheLife } from "next/cache";
import { ARCHIVE_RUN_ID, db } from "./db";

/** Every number on the public home page, counted from verified rows in Supabase (CLAUDE.md rule 9). */
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

/** Last good numbers, counted from the database on 2026-10-27. Used only if the database can't be reached
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
  guests: 429,
  passages: 35_234,
  opportunityCategories: 13,
  countedAt: "2026-10-27T00:00:00.000Z",
};

let lastGood: SiteStats | null = null;

const DAY = 60 * 60 * 24;

/** Cached for 24 hours, so the public home page never queries the database on a visit. */
export async function getSiteStats(): Promise<SiteStats> {
  "use cache";
  try {
    const stats = await countStats();
    lastGood = stats;
    cacheLife({ revalidate: DAY });
    return stats;
  } catch (e) {
    console.error("site stats: database not reachable, using last good numbers:", e instanceof Error ? e.message : e);
    // Try again within the hour instead of keeping the fallback for a whole day.
    cacheLife({ revalidate: 60 * 60 });
    return lastGood ?? SNAPSHOT;
  }
}

/* ---------- counting ---------- */

type Result = { data?: unknown; count?: number | null; error: unknown };
// Supabase's query builder types are deeply generic; the helpers below only chain filters, so they take it loosely.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Query = any;

/** One query with up to 3 tries. */
async function attempt(what: string, fn: () => PromiseLike<Result>): Promise<Result> {
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    const res = await fn();
    if (!res.error) return res;
    last = res.error;
    await new Promise((r) => setTimeout(r, 500 * (i + 1)));
  }
  throw new Error(`${what}: ${JSON.stringify(last)}`);
}

/** Exact row count of a table, with optional filters. */
async function count(what: string, table: string, filters: (q: Query) => Query = (q) => q): Promise<number> {
  const res = await attempt(what, () => filters(db().from(table).select("*", { count: "exact", head: true })));
  if (typeof res.count !== "number") throw new Error(`${what}: no count`);
  return res.count;
}

/** Runs tasks with at most `limit` in flight (Supabase stops any one query after 8 s). */
async function pool<T>(tasks: (() => Promise<T>)[], limit = 4): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) { const i = next++; out[i] = await tasks[i](); }
  }));
  return out;
}

async function countStats(): Promise<SiteStats> {
  const eps = await attempt("episodes", () => db().from("episodes").select("video_id,status"));
  const episodes = eps.data as { video_id: string; status: string | null }[];
  const transcribed = episodes.filter((e) => e.status === "transcribed").map((e) => e.video_id);

  // Segment counts go by batches of 25 episodes, 3 at a time (the video_id index keeps each query fast); one count over
  // all 1M+ lines hits the database's 8 s statement limit.
  const batches: string[][] = [];
  for (let i = 0; i < transcribed.length; i += 25) batches.push(transcribed.slice(i, i + 25));
  const perBatch = await pool(batches.map((ids, b) => async () => {
    const all = await count(`segments batch ${b}`, "segments", (q) => q.in("video_id", ids));
    const unknown = await count(`unknown speakers batch ${b}`, "segments", (q) => q.in("video_id", ids).eq("speaker", "unknown"));
    return { all, unknown };
  }), 3);
  const transcriptLines = perBatch.reduce((s, x) => s + x.all, 0);
  const unknownLines = perBatch.reduce((s, x) => s + x.unknown, 0);

  const run = (q: Query) => q.eq("run_id", ARCHIVE_RUN_ID);
  const runVerified = (q: Query) => q.eq("run_id", ARCHIVE_RUN_ID).eq("verified", true);

  const [hindiLines, passages, insightsAll, insightsVerified, clipsAll, clipsVerified, guestsAll, guestsVerified, hostQuestions] =
    await pool([
      () => count("translations", "translation_segments"),
      () => count("chunks", "chunks"),
      () => count("insights", "insights", run),
      () => count("verified insights", "insights", runVerified),
      () => count("clips", "clips", run),
      () => count("verified clips", "clips", runVerified),
      () => count("guests", "guests", run),
      () => count("verified guests", "guests", runVerified),
      () => count("verified host questions", "insights", (q) => runVerified(q).eq("type", "raj_question")),
    ]);

  const keys = await attempt("guest keys", () =>
    db().from("guests").select("guest_key").eq("run_id", ARCHIVE_RUN_ID).eq("verified", true).limit(5000));
  const guests = new Set((keys.data as { guest_key: string | null }[]).map((g) => g.guest_key).filter(Boolean)).size;

  const categories = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const page = await attempt("opportunity categories", () =>
      db().from("insights").select("category").eq("run_id", ARCHIVE_RUN_ID).eq("verified", true).eq("type", "opportunity")
        .not("category", "is", null).order("id").range(from, from + 999));
    const rows = page.data as { category: string }[];
    rows.forEach((r) => categories.add(r.category));
    if (rows.length < 1000) break;
  }

  const extracted = insightsAll + clipsAll + guestsAll;
  const verified = insightsVerified + clipsVerified + guestsVerified;
  const pct1 = (n: number, d: number) => (d ? Math.round((1000 * n) / d) / 10 : 0);
  return {
    episodesListed: episodes.length,
    episodesTranscribed: transcribed.length,
    episodesSkipped: episodes.filter((e) => e.status === "skipped").length,
    transcriptLines,
    hindiLines,
    speakerLabelledPct: pct1(transcriptLines - unknownLines, transcriptLines),
    extracted,
    verified,
    verifiedPct: pct1(verified, extracted),
    verifiedClips: clipsVerified,
    verifiedHostQuestions: hostQuestions,
    guests,
    passages,
    opportunityCategories: categories.size,
    countedAt: new Date().toISOString(),
  };
}
