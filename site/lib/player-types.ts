/** A playable moment. Shared by server code (which builds it from verified rows) and the client player. */
export type Clip = {
  /** Unique per playable item, e.g. "clip:872"; a page's player slot shows this clip when keys match. */
  key: string;
  itemType: "clip" | "episode" | "answer" | "insight";
  itemId: string;
  videoId: string;
  startS: number;
  endS: number;
  title: string;
  guest: string;
  episode: string;
  /** Episode month, e.g. "Mar 2025" (optional). */
  date?: string;
  /** The page that owns the big player for this clip; null when there is none (mini player only). */
  sourcePath: string | null;
};

export const fmtTime = (s: number) => {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(x).padStart(2, "0");
};

export const youtubeAt = (videoId: string, s: number) =>
  `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&t=${Math.max(0, Math.floor(s))}s`;
