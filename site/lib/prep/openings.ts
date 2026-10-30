import "server-only";
import { db } from "@/lib/db";

/** Most episodes open with a teaser: clips from later in the conversation, played before the host's introduction.
    A line cited (or a question extracted) from the teaser points at 0:00 to 1:00 though the moment really happens an
    hour in. For a moment in an episode's opening minutes, this finds the same words later in that episode and points
    the moment there: its time and its segment ids (rule 2 still holds, the segments are the ones saying it). When the
    words are not said again later, the opening was the conversation itself and the moment is left as it is. */

/** Moments starting before this may be teaser clips. */
const OPENING_S = 240;
/** Words in a row that make a match (3: Hinglish transcripts of the same audio differ in a word here and there). */
const GRAM = 3;
/** A later stretch is the same moment when it shares a run of RUN word triples in a row (5 identical words) and at
    least MIN_SHARE of the moment's triples, but never fewer than 3 or more than MAX_NEEDED: a teaser is a montage, so
    one cited stretch of it holds several clips and only one of them is found in any one place later. */
const RUN = 3;
const MIN_SHARE = 0.2;
const MAX_NEEDED = 5;

export type Moment = { videoId: string; startS: number; endS: number; segmentIds: number[] };
type Seg = { id: number; video_id: string; start_s: number; end_s: number; text_roman: string };

const norm = (s: string) => s.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
const grams = (w: string[]) => w.slice(0, Math.max(0, w.length - GRAM + 1)).map((_, i) => w.slice(i, i + GRAM).join(" "));

/** Moves every moment that sits in an episode's teaser to where it is said in the conversation (in place). Moments
    that are the same object are moved once. Failures leave the moments as they were. */
export async function relocateOpenings(all: Moment[]): Promise<number> {
  const moments = [...new Set(all)].filter((m) => m.startS < OPENING_S && m.segmentIds.length > 0);
  if (!moments.length) return 0;
  try {
    const ids = [...new Set(moments.flatMap((m) => m.segmentIds))];
    const { data: own, error } = await db().from("segments").select("id,video_id,start_s,end_s,text_roman").in("id", ids);
    if (error) throw new Error(error.message);
    const byId = new Map((own as Seg[]).map((s) => [s.id, s]));
    const videos = [...new Set(moments.map((m) => m.videoId))];
    const later = new Map(await Promise.all(videos.map(async (v) => [v, await segmentsAfter(v, Math.min(...moments.filter((m) => m.videoId === v).map((m) => m.endS)))] as const)));
    let moved = 0;
    for (const m of moments) {
      const words = m.segmentIds.map((id) => byId.get(id)).filter((s): s is Seg => !!s && s.video_id === m.videoId)
        .sort((a, b) => a.start_s - b.start_s).flatMap((s) => norm(s.text_roman));
      const hit = bestMatch(words, (later.get(m.videoId) ?? []).filter((s) => s.start_s > m.endS + 20));
      if (!hit) continue;
      const span = m.endS - m.startS;
      m.startS = hit[0].start_s;
      m.endS = Math.max(hit[hit.length - 1].end_s, m.startS + span);
      m.segmentIds = hit.map((s) => s.id);
      moved += 1;
    }
    return moved;
  } catch (e) {
    console.error("prep openings failed:", e instanceof Error ? e.message : e);
    return 0;
  }
}

/** The episode's lines from `fromS` on, a page at a time (an episode has a few thousand). */
async function segmentsAfter(videoId: string, fromS: number): Promise<Seg[]> {
  const out: Seg[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db().from("segments").select("id,video_id,start_s,end_s,text_roman")
      .eq("video_id", videoId).gt("start_s", fromS).order("seq").range(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as Seg[]));
    if ((data?.length ?? 0) < 1000) return out;
  }
}

/** The stretch of later lines that shares most of the moment's word triples (within a stretch not much longer than
    the moment) and holds a run of RUN shared triples in a row, or null when none does. */
function bestMatch(words: string[], segs: Seg[]): Seg[] | null {
  const mine = new Set(grams(words));
  const needed = Math.min(MAX_NEEDED, Math.max(RUN, Math.ceil(mine.size * MIN_SHARE)));
  if (mine.size < RUN) return null;
  const flat: { w: string; seg: number }[] = segs.flatMap((s, i) => norm(s.text_roman).map((w) => ({ w, seg: i })));
  const hits: number[] = [];
  for (let i = 0; i + GRAM <= flat.length; i++) {
    if (mine.has(flat.slice(i, i + GRAM).map((x) => x.w).join(" "))) hits.push(i);
  }
  const reach = Math.round(words.length * 1.5) + 20;
  let best: { from: number; to: number; n: number } | null = null;
  for (let a = 0, b = 0; b < hits.length; b++) {
    while (hits[b] - hits[a] > reach) a++;
    let run = 1, longest = 1;
    for (let k = a + 1; k <= b; k++) { run = hits[k] === hits[k - 1] + 1 ? run + 1 : 1; longest = Math.max(longest, run); }
    if (longest >= RUN && (!best || b - a + 1 > best.n)) best = { from: hits[a], to: hits[b] + GRAM - 1, n: b - a + 1 };
  }
  if (!best || best.n < needed) return null;
  return segs.slice(flat[best.from].seg, flat[best.to].seg + 1);
}
