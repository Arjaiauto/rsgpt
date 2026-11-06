import type { Clip } from "@/lib/player-types";
import type { Cite } from "./types";

/** "Play the answer": the cited moments of an answer as a queue of clips. */
export const PLAY_ALL = {
  /** A clip is at least this long, and at most this long (from its first cited line). */
  floorS: 20,
  capS: 45,
  /** Cites of the same episode this close together (seconds, gap between them) become one clip. */
  mergeGapS: 10,
} as const;

/** Clips in answer order from the cites (flattened in the order the answer shows them): the same (episode, start) once,
    cites of one episode within PLAY_ALL.mergeGapS of each other merged into one clip, then each clip stretched to the
    floor or cut to the cap. Queue clips have no page slot (sourcePath null), so they always play in the mini player. */
export function buildPlaylist(turnId: string, cites: Cite[]): Clip[] {
  type Span = Pick<Cite, "videoId" | "startS" | "endS" | "episode" | "guest" | "date">;
  const spans: Span[] = [];
  const seen = new Set<string>();
  for (const c of cites) {
    const k = `${c.videoId}@${c.startS}`;
    if (seen.has(k)) continue;
    seen.add(k);
    // Compared with the clip's real extent (stretched to the floor), so two clips never overlap.
    const near = spans.find((s) => s.videoId === c.videoId && c.startS <= Math.max(s.endS, s.startS + PLAY_ALL.floorS) + PLAY_ALL.mergeGapS && c.endS >= s.startS - PLAY_ALL.mergeGapS);
    if (near) {
      near.startS = Math.min(near.startS, c.startS);
      near.endS = Math.max(near.endS, c.endS);
    } else {
      spans.push({ videoId: c.videoId, startS: c.startS, endS: c.endS, episode: c.episode, guest: c.guest, date: c.date });
    }
  }
  return spans.map((s, i) => {
    const key = `ask:${turnId}:play:${i}`;
    return {
      key, itemType: "answer", itemId: key, videoId: s.videoId, startS: s.startS,
      endS: Math.min(Math.max(s.endS, s.startS + PLAY_ALL.floorS), s.startS + PLAY_ALL.capS),
      title: s.episode, guest: s.guest, episode: s.episode, date: s.date, sourcePath: null,
    } satisfies Clip;
  });
}
