/** Shapes of the Insights page (/insights), built on the server by lib/insights.ts. Only aggregates reach the browser;
    every number is counted from verified rows (CLAUDE.md rule 9) and every takeaway sentence is written from them. */

/** Middle, average and middle half of a group of episodes' numbers. */
export type Spread = { n: number; median: number; mean: number; p25: number; p75: number };

/** One bar of a "views by group" chart. */
export type Group = Spread & { key: string; label: string };

export type Overview = {
  episodes: number;
  guests: number;
  hours: number;
  clips: number;
  /** First and latest episode dates (ISO). */
  first: string;
  last: string;
  langs: { code: "hi" | "en"; label: string; n: number }[];
};

/** A guest sector tag, as the Clips page's Topic filter knows it (key = lower case). */
export type TopicRow = { key: string; label: string; episodes: number; clips: number };

export type TopicMix = {
  years: number[];
  /** Episodes per year. */
  totals: number[];
  /** "2026 runs to Oct 2026" when the latest year is not complete. */
  partial: string | null;
  rows: { key: string; label: string; counts: number[] }[];
};

export type GuestStat = { slug: string; name: string; episodes: number; views: number; avgViews: number };

export type MonthPoint = { key: string; label: string; n: number; views: Spread; likes: Spread };

export type BestClip = {
  id: number; videoId: string; startS: number; endS: number; topic: string; guest: string; episode: string; date: string; score: number;
};

export type Insights = {
  overview: Overview;
  topics: { rows: TopicRow[]; mix: TopicMix; takeaway: string; mixTakeaway: string };
  guests: {
    total: number; repeat: number; most: GuestStat[]; topAvg: GuestStat[]; returning: Group[]; hidden: string[];
    takeaway: string; avgTakeaway: string; returningTakeaway: string;
  };
  performance: {
    months: MonthPoint[]; length: Group[]; lang: Group[]; hidden: string[];
    viewsTakeaway: string; likesTakeaway: string; lengthTakeaway: string; langTakeaway: string;
  };
  best: { topics: { key: string; label: string; clips: BestClip[] }[]; takeaway: string };
  /** When the numbers were counted (ISO). */
  countedAt: string;
};

export type Usage = {
  questions: number;
  briefs: number;
  /** "From the web" research calls on the Prep brief, counted on their own. */
  web: number;
  saved: { clip: number; answer: number; brief: number };
  /** Questions that cited a guest with this sector tag. */
  topics: { key: string; label: string; n: number }[];
  /** Asked questions whose answer cited at least one passage. */
  cited: number;
  since: string | null;
  takeaway: string;
  countedAt: string;
};

/** Groups with fewer episodes than this are hidden (FRONTEND_DESIGN.md page 8). */
export const MIN_GROUP = 20;

/** One thumbnail feature: episodes with it against episodes without it. Values are year-relative views: an episode's
    views divided by the median views of all episodes published the same year, so older episodes' extra time to collect
    views does not count. */
export type ThumbPattern = {
  key: string;
  label: string;
  with: Group;
  without: Group;
  /** Median year-relative views with the feature over without it, all years together. */
  ratio: number;
  /** The years below disagree (some above 1.0x, some below): no consistent effect is claimed. */
  mixed: boolean;
  /** Years with at least MIN_GROUP episodes on each side, compared on plain views. */
  years: { year: number; ratio: number; nWith: number; nWithout: number; medWith: number; medWithout: number }[];
  /** Share of each year's analysed episodes that have the feature. */
  share: { year: number; n: number; pct: number }[];
  takeaway: string;
};

export type ThumbInsights = {
  analysed: number;
  episodes: number;
  patterns: ThumbPattern[];
  /** Features left out for having fewer than MIN_GROUP episodes on one side. */
  hidden: string[];
  /** Style shifts: features whose share of thumbnails moved 10 points or more from the first to the latest year,
      biggest first. Facts about the thumbnails, not about views. */
  shifts: { key: string; text: string; from: number; to: number; fromYear: number; toYear: number }[];
  headline: string;
  /** The archive medians used to split "brighter" and "higher contrast". */
  brightness: number;
  contrast: number;
  countedAt: string;
};
