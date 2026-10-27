import "server-only";
import { ARCHIVE_RUN_ID, db } from "@/lib/db";
import { FIND_LINE, HOST_NAME } from "./config";
import { guestLabel, monthYear, type Episode } from "./retrieve";
import { unquote } from "./quote";
import type { FindLineResult, LineRow } from "./types";

type Hit = { segment_id: number; video_id: string; seq: number; start_s: number; end_s: number; similarity: number };

/** The best matching transcript line (pg_trgm, see pipeline/sql/find_line.sql) and the lines around it.
    No Claude or Voyage call: this is the database only. */
export async function findLine(query: string): Promise<FindLineResult> {
  const q = unquote(query).slice(0, FIND_LINE.maxChars);
  if (q.length < FIND_LINE.minChars) return { status: "none" };

  const { data, error } = await db().rpc("find_line", { query_text: q, match_count: 8 });
  if (error) throw new Error(`find_line: ${error.message}`);
  const hits = (data ?? []) as Hit[];

  // Best first; a line must come from a transcribed episode. The same words said in several episodes (an ad read,
  // a catchphrase) tie: the earliest-loaded line wins, as the function orders ties by id.
  const videoIds = [...new Set(hits.map((h) => h.video_id))];
  if (!videoIds.length) return { status: "none" };
  const [eps, gs] = await Promise.all([
    db().from("episodes").select("video_id,title,published_at,duration_seconds,caption_language,status").in("video_id", videoIds),
    db().from("guests").select("video_id,name").in("video_id", videoIds).eq("verified", true).eq("run_id", ARCHIVE_RUN_ID),
  ]);
  if (eps.error) throw new Error(`episodes: ${eps.error.message}`);
  const guestsOf = new Map<string, string[]>();
  for (const g of gs.data ?? []) {
    const list = guestsOf.get(g.video_id as string) ?? [];
    if (!list.includes(g.name as string)) list.push(g.name as string);
    guestsOf.set(g.video_id as string, list);
  }
  const episodes = new Map<string, Episode>();
  for (const e of eps.data ?? []) {
    if (e.status !== "transcribed") continue;
    episodes.set(e.video_id, {
      videoId: e.video_id, title: e.title, publishedAt: e.published_at, durationS: e.duration_seconds,
      hindi: e.caption_language === "hi", guests: guestsOf.get(e.video_id) ?? [],
    });
  }
  const best = hits.find((h) => episodes.has(h.video_id));
  if (!best || best.similarity < FIND_LINE.closest) return { status: "none" };
  const ep = episodes.get(best.video_id)!;

  const { data: rows, error: rowsError } = await db()
    .from("segments")
    .select("id,seq,start_s,end_s,speaker,text_roman")
    .eq("video_id", best.video_id)
    .gte("seq", best.seq - FIND_LINE.context)
    .lte("seq", best.seq + FIND_LINE.context)
    .order("seq");
  if (rowsError) throw new Error(`segments: ${rowsError.message}`);
  const guest = guestLabel(ep);
  const lines: LineRow[] = (rows ?? []).map((r) => ({
    segmentId: r.id as number,
    seq: r.seq as number,
    startS: r.start_s as number,
    endS: r.end_s as number,
    speaker: r.speaker === "raj" ? HOST_NAME : r.speaker === "guest" ? guest : "",
    text: String(r.text_roman).trim(),
  }));

  return {
    status: "found",
    match: {
      similarity: best.similarity,
      exact: best.similarity >= FIND_LINE.exact,
      videoId: ep.videoId, episode: ep.title, guest, date: monthYear(ep.publishedAt), durationS: ep.durationS,
      hitId: best.segment_id,
      lines,
    },
  };
}
