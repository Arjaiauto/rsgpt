import "server-only";
import { cacheLife } from "next/cache";
import { allRows as all, db } from "@/lib/db";
import { yearOf } from "@/lib/guest-format";
import { LENGTH_BANDS, spread } from "@/lib/insights";
import { MIN_GROUP } from "@/lib/insights-types";

/** The home page's "Explore the patterns" chart, from the same verified episodes as the Insights page (views by
    episode length). One number throughout: an episode's views divided by the median views of the episodes published
    the same year, so 1.0x is a typical episode of the same age and older episodes' extra time to collect views does
    not count. A year gets a point only when the group has MIN_GROUP episodes that year (the Insights rule). Not
    traffic-based, so there is nothing to exclude. Kept for a few hours; on failure it returns null (the home page
    then shows no chart) and looks again in a few minutes. */
export type ExplorerGroup = {
  label: string;
  episodes: number;
  /** Median of the group's year-relative views, all years together. */
  typical: number;
  /** The same figure per year, for the years with enough episodes. */
  byYear: { year: number; value: number; n: number }[];
};
export type ExplorerData = { years: number[]; sets: { key: string; label: string; groups: ExplorerGroup[] }[] };

export async function getHomeExplorer(): Promise<ExplorerData | null> {
  "use cache: remote";
  cacheLife("hours");
  try {
    const data = await read();
    if (data) return data;
  } catch (e) {
    console.warn("home explorer unavailable:", e instanceof Error ? e.message : "unknown");
  }
  cacheLife({ stale: 60, revalidate: 300, expire: 900 });
  return null;
}

async function read(): Promise<ExplorerData | null> {
  const rows = await all<{ published_at: string | null; duration_seconds: number | null; view_count: number | null }>((a, b) =>
    db().from("episodes").select("published_at,duration_seconds,view_count").eq("status", "transcribed").order("video_id").range(a, b));
  const eps = rows.filter((e) => e.published_at).map((e) => ({
    year: yearOf(e.published_at)!, minutes: (e.duration_seconds ?? 0) / 60, views: Number(e.view_count ?? 0),
  }));
  const years = [...new Set(eps.map((e) => e.year))].sort((a, b) => a - b);
  const yearMedian = new Map(years.map((y) => [y, spread(eps.filter((e) => e.year === y).map((e) => e.views)).median]));
  const rel = eps.map((e) => ({ ...e, rel: yearMedian.get(e.year) ? e.views / yearMedian.get(e.year)! : 0 }));

  const groups: ExplorerGroup[] = [];
  for (const band of LENGTH_BANDS) {
    const inBand = rel.filter(band.test);
    if (inBand.length < MIN_GROUP) continue;
    const byYear = years.map((year) => {
      const g = inBand.filter((e) => e.year === year);
      return g.length >= MIN_GROUP ? { year, value: spread(g.map((e) => e.rel)).median, n: g.length } : null;
    }).filter((x): x is NonNullable<typeof x> => !!x);
    groups.push({ label: band.label, episodes: inBand.length, typical: spread(inBand.map((e) => e.rel)).median, byYear });
  }
  if (groups.length < 2) return null;
  return { years, sets: [{ key: "length", label: "Episode length", groups }] };
}
