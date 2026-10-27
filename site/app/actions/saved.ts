"use server";

import { cookies } from "next/headers";
import { requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import type { SaveInput } from "@/lib/saved-types";
import { VISITOR_COOKIE } from "@/lib/session";

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Only the fields the site shows are stored, cut to size; nothing from the browser goes into the table as it came. */
function clean(input: SaveInput): { kind: "clip" | "answer"; item_ref: Record<string, unknown> } | null {
  if (input.kind === "clip") {
    const r = input.ref;
    if (!r || !str(r.videoId, 32)) return null;
    return {
      kind: "clip",
      item_ref: {
        videoId: str(r.videoId, 32), startS: num(r.startS), endS: num(r.endS), title: str(r.title, 300),
        guest: str(r.guest, 200), episode: str(r.episode, 300), date: str(r.date, 40),
      },
    };
  }
  if (input.kind === "answer") {
    const r = input.ref;
    const answer = str(r?.answer, 6000).trim();
    if (!answer || !Array.isArray(r.citations) || !r.citations.length) return null; // rule 2: no citations, nothing to save
    return {
      kind: "answer",
      item_ref: {
        question: str(r.question, 400),
        answer,
        citations: r.citations.slice(0, 40).map((c) => ({
          chunkId: num(c.chunkId), videoId: str(c.videoId, 32), startS: num(c.startS), endS: num(c.endS),
          segmentIds: Array.isArray(c.segmentIds) ? c.segmentIds.slice(0, 200).map(num) : [],
          speaker: str(c.speaker, 200), date: str(c.date, 40), episode: str(c.episode, 300), guest: str(c.guest, 200),
        })),
      },
    };
  }
  return null;
}

/** Saves a clip or an answer for this visitor (server only; the table has RLS on and no policies). */
export async function saveItem(input: SaveInput): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  const { firstName } = await requireSession();
  const row = clean(input);
  if (!row) return { ok: false, error: "Nothing to save." };
  const visitorId = (await cookies()).get(VISITOR_COOKIE)?.value ?? null;
  const { data, error } = await db().from("saved_items").insert({ ...row, first_name: firstName, visitor_id: visitorId }).select("id").single();
  if (error) {
    console.error("saved_items insert failed", error.message);
    return { ok: false, error: "Couldn't save. Try again." };
  }
  return { ok: true, id: data.id as number };
}

/** Undo: removes a row this visitor saved. */
export async function unsaveItem(id: number): Promise<{ ok: boolean }> {
  const { firstName } = await requireSession();
  const visitorId = (await cookies()).get(VISITOR_COOKIE)?.value ?? null;
  let q = db().from("saved_items").delete().eq("id", id).eq("first_name", firstName);
  q = visitorId ? q.eq("visitor_id", visitorId) : q.is("visitor_id", null);
  const { error } = await q;
  if (error) console.error("saved_items delete failed", error.message);
  return { ok: !error };
}
