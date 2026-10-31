"use server";

import { cookies } from "next/headers";
import { HOST_NAME } from "@/lib/ask/config";
import { requireSession } from "@/lib/auth";
import { parseClipParams, type ClipLine, type ClipPage, type ClipParams } from "@/lib/clip-types";
import { getClipIndex, queryClips } from "@/lib/clips";
import { db } from "@/lib/db";
import { VISITOR_COOKIE } from "@/lib/session";

/** The next page of clips for the same filters ("Load more" and infinite scroll). The params are read again the way
    the page reads the URL, so nothing else gets through. */
export async function moreClips(params: ClipParams, offset: number): Promise<ClipPage> {
  await requireSession();
  const p = parseClipParams(params as unknown as Record<string, string>);
  return queryClips(p, Number.isFinite(offset) ? offset : 0);
}

/** A clip's transcript lines, for the live transcript in the player panel: the episode's lines from the clip's start
    to its end, with the English translation of a Hindi episode's lines. */
export async function clipTranscript(id: number): Promise<ClipLine[] | null> {
  await requireSession();
  if (!Number.isInteger(id)) return null;
  const clip = (await getClipIndex()).clips.find((c) => c.id === id);
  if (!clip) return null;
  const from = clip.startS - 1, to = clip.endS;
  const [seg, tr] = await Promise.all([
    db().from("segments").select("start_s,end_s,speaker,text_roman").eq("video_id", clip.videoId).gte("start_s", from).lt("start_s", to).order("seq"),
    db().from("translation_segments").select("start_s,text").eq("video_id", clip.videoId).gte("start_s", from).lt("start_s", to),
  ]);
  if (seg.error) throw new Error(`segments: ${seg.error.message}`);
  const english = new Map((tr.data ?? []).map((t) => [(t.start_s as number).toFixed(2), t.text as string]));
  const guest = clip.guestSlugs.length === 1 ? clip.guest : "Guest";
  return (seg.data ?? []).map((s) => ({
    start: s.start_s as number, end: s.end_s as number,
    speaker: s.speaker === "raj" ? HOST_NAME : s.speaker === "guest" ? guest : "",
    text: String(s.text_roman).trim(),
    english: english.get((s.start_s as number).toFixed(2)) ?? "",
  }));
}

/** The clips this visitor already saved (same scoping as saving), as "videoId@start", so the player can say "Saved". */
export async function savedClipMarks(): Promise<string[]> {
  const { firstName } = await requireSession();
  const visitorId = (await cookies()).get(VISITOR_COOKIE)?.value ?? null;
  let q = db().from("saved_items").select("v:item_ref->>videoId,s:item_ref->>startS").eq("kind", "clip").eq("first_name", firstName);
  q = visitorId ? q.eq("visitor_id", visitorId) : q.is("visitor_id", null);
  const { data, error } = await q.limit(1000);
  if (error) { console.error("saved_items marks failed", error.message); return []; }
  return (data ?? []).map((r) => `${r.v}@${Math.round(Number(r.s))}`);
}
