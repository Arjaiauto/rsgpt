"use server";

import { cookies } from "next/headers";
import { requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { getDirectory } from "@/lib/guests";
import type { Cite } from "@/lib/ask/types";
import { cleanBrief } from "@/lib/prep/clean";
import { sectionOrder } from "@/lib/prep/export";
import { folderName } from "@/lib/saved-folder";
import { SAVED_LIMITS, type SaveInput, type SavedList, type SavedRow } from "@/lib/saved-types";
import { takeUser, USER_LIMITS } from "@/lib/rate-limit";
import { VISITOR_COOKIE } from "@/lib/session";

/** Writes to the saved list (save, move, note, undo) are limited per person. */
const savedOk = (firstName: string) => takeUser("saved", firstName, USER_LIMITS.saved.max, USER_LIMITS.saved.windowMs);

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Only the fields the site shows are stored, cut to size; nothing from the browser goes into the table as it came. */
function clean(input: SaveInput): { kind: "clip" | "answer" | "brief"; item_ref: Record<string, unknown> } | null {
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
  if (input.kind === "brief") {
    const brief = cleanBrief(input.ref);
    return brief ? { kind: "brief", item_ref: brief } : null; // rule 2: a brief with no cited guest is not saved
  }
  return null;
}

/** Saves a clip, an answer or a brief for this visitor (server only; the table has RLS on and no policies). */
export async function saveItem(input: SaveInput): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  const { firstName } = await requireSession();
  if (!(await savedOk(firstName))) return { ok: false, error: "Too many saves. Wait a few minutes and try again." };
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


/* ---------- the Saved page (Ticket 23a) ----------
   Every action below is scoped like saveItem and unsaveItem: the signed-in first name and this browser's visitor_id
   cookie (a row saved without the cookie belongs to the cookie-less visitor). */

async function owner() {
  const { firstName } = await requireSession();
  const visitorId = (await cookies()).get(VISITOR_COOKIE)?.value ?? null;
  return { firstName, visitorId };
}

const noteText = (v: unknown): string | null => {
  const n = typeof v === "string" ? v.replace(/\u0000/g, "").trim().slice(0, SAVED_LIMITS.note) : "";
  return n || null;
};

/** First sentence of an answer, at most 240 characters. */
function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const m = /^.*?[.!?।](?=\s|$)/.exec(flat);
  const s = m ? m[0] : flat;
  return s.length > 240 ? `${s.slice(0, 237).trimEnd()}...` : s;
}

type Row = { id: number; created_at: string; folder: string | null; note: string | null; item_ref: Record<string, unknown> };
const SELECT = "id,created_at,folder,note,item_ref";

/** Everything this visitor saved, newest first. Answers come as a preview and briefs as a summary; the whole thing is
    read when it is opened. */
export async function listSaved(): Promise<SavedList> {
  const { firstName, visitorId } = await owner();
  const read = async (kind: "clip" | "answer" | "brief", limit: number) => {
    let q = db().from("saved_items").select(SELECT).eq("kind", kind).eq("first_name", firstName);
    q = visitorId ? q.eq("visitor_id", visitorId) : q.is("visitor_id", null);
    const { data, error } = await q.order("created_at", { ascending: false }).order("id", { ascending: false }).limit(limit);
    if (error) throw new Error(`saved_items: ${error.message}`);
    return (data ?? []) as Row[];
  };
  const LIM = { clip: 1000, answer: 500, brief: 200 };
  const [clips, answers, briefs, dir] = await Promise.all([read("clip", LIM.clip), read("answer", LIM.answer), read("brief", LIM.brief), getDirectory()]);
  // A saved clip keeps its guest's name; the cover shows that guest's photo (the first guest of "A & B").
  const photoOf = new Map(dir.guests.filter((g) => g.photoUrl).map((g) => [g.name.toLowerCase(), g.photoUrl!]));
  const meta = (r: Row) => ({ id: r.id, createdAt: r.created_at, folder: r.folder, note: r.note ?? "" });
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    firstName,
    clips: clips.filter((r) => s(r.item_ref.videoId)).map((r) => ({
      ...meta(r), kind: "clip" as const, videoId: s(r.item_ref.videoId), startS: n(r.item_ref.startS), endS: n(r.item_ref.endS),
      title: s(r.item_ref.title), guest: s(r.item_ref.guest), episode: s(r.item_ref.episode), date: s(r.item_ref.date),
      photo: photoOf.get(s(r.item_ref.guest).split(" & ")[0].trim().toLowerCase()) ?? null,
    })),
    answers: answers.map((r) => {
      const cites = Array.isArray(r.item_ref.citations) ? (r.item_ref.citations as { videoId?: unknown }[]) : [];
      return {
        ...meta(r), kind: "answer" as const, question: s(r.item_ref.question), preview: firstSentence(s(r.item_ref.answer)),
        sources: new Set(cites.map((c) => s(c.videoId)).filter(Boolean)).size,
      };
    }),
    briefs: briefs.map((r) => {
      const b = cleanBrief(r.item_ref);
      return {
        ...meta(r), kind: "brief" as const, title: s(r.item_ref.title) || "Brief", description: s(r.item_ref.description),
        builtAt: s(r.item_ref.builtAt) || r.created_at, sections: b ? sectionOrder(b).length : 0,
      };
    }),
    capped: clips.length >= LIM.clip || answers.length >= LIM.answer || briefs.length >= LIM.brief,
  };
}

/** The whole saved answer, for re-opening it in Ask. */
export async function loadSavedAnswer(id: number): Promise<{ question: string; answer: string; citations: Cite[] } | null> {
  if (!Number.isInteger(id)) return null;
  const { firstName, visitorId } = await owner();
  let q = db().from("saved_items").select("item_ref").eq("id", id).eq("kind", "answer").eq("first_name", firstName);
  q = visitorId ? q.eq("visitor_id", visitorId) : q.is("visitor_id", null);
  const { data, error } = await q.maybeSingle();
  if (error) console.error("saved_items read failed", error.message);
  if (!data) return null;
  // The same cutting-down as when it was saved, so nothing odd in an old row reaches the page.
  const row = clean({ kind: "answer", ref: data.item_ref } as SaveInput);
  if (!row) return null;
  const ref = row.item_ref as { question: string; answer: string; citations: Cite[] };
  return { question: ref.question, answer: ref.answer, citations: ref.citations };
}

/** Puts an item in a folder (null: no folder). A folder is just the name on its items, so it exists while it holds
    one. A name that matches a folder in use apart from capitals takes that folder's spelling. */
export async function moveSaved(id: number, folder: string | null): Promise<{ ok: boolean; folder: string | null }> {
  if (!Number.isInteger(id)) return { ok: false, folder: null };
  const { firstName, visitorId } = await owner();
  if (!(await savedOk(firstName))) return { ok: false, folder: null };
  let name = folderName(folder);
  if (name) {
    let inUse = db().from("saved_items").select("folder").eq("first_name", firstName).not("folder", "is", null);
    inUse = visitorId ? inUse.eq("visitor_id", visitorId) : inUse.is("visitor_id", null);
    const { data } = await inUse.limit(1000);
    const same = (data ?? []).map((r) => r.folder as string).find((f) => f.toLowerCase() === name!.toLowerCase());
    if (same) name = same;
  }
  let q = db().from("saved_items").update({ folder: name }).eq("id", id).eq("first_name", firstName);
  q = visitorId ? q.eq("visitor_id", visitorId) : q.is("visitor_id", null);
  const { data, error } = await q.select("id");
  if (error) console.error("saved_items move failed", error.message);
  return { ok: !error && (data?.length ?? 0) > 0, folder: name };
}

/** Saves the note on an item (at most 500 characters; empty clears it). */
export async function noteSaved(id: number, note: string): Promise<{ ok: boolean }> {
  if (!Number.isInteger(id)) return { ok: false };
  const { firstName, visitorId } = await owner();
  if (!(await savedOk(firstName))) return { ok: false };
  let q = db().from("saved_items").update({ note: noteText(note) }).eq("id", id).eq("first_name", firstName);
  q = visitorId ? q.eq("visitor_id", visitorId) : q.is("visitor_id", null);
  const { data, error } = await q.select("id");
  if (error) console.error("saved_items note failed", error.message);
  return { ok: !error && (data?.length ?? 0) > 0 };
}

/** Removes an item and hands the row back, so the page can offer Undo (restoreSaved). */
export async function removeSaved(id: number): Promise<{ ok: true; row: SavedRow } | { ok: false }> {
  if (!Number.isInteger(id)) return { ok: false };
  const { firstName, visitorId } = await owner();
  let q = db().from("saved_items").delete().eq("id", id).eq("first_name", firstName);
  q = visitorId ? q.eq("visitor_id", visitorId) : q.is("visitor_id", null);
  const { data, error } = await q.select("kind,item_ref,folder,note,created_at");
  if (error) console.error("saved_items remove failed", error.message);
  const r = data?.[0];
  if (error || !r) return { ok: false };
  return { ok: true, row: { kind: r.kind as SavedRow["kind"], itemRef: r.item_ref as Record<string, unknown>, folder: r.folder, note: r.note ?? "", createdAt: r.created_at } };
}

/** Undo of removeSaved: puts the row back with its date, folder and note. The content goes through the same
    cutting-down as a new save, so a tampered row cannot put anything else in the table. */
export async function restoreSaved(row: SavedRow): Promise<{ ok: true; id: number } | { ok: false }> {
  const { firstName, visitorId } = await owner();
  if (!(await savedOk(firstName))) return { ok: false };
  if (!row || !["clip", "answer", "brief"].includes(row.kind)) return { ok: false };
  const kept = clean({ kind: row.kind, ref: row.itemRef } as SaveInput);
  if (!kept) return { ok: false };
  const when = new Date(row.createdAt);
  const created = Number.isNaN(when.getTime()) || when.getTime() > Date.now() ? new Date() : when;
  const { data, error } = await db().from("saved_items")
    .insert({ ...kept, first_name: firstName, visitor_id: visitorId, folder: folderName(row.folder), note: noteText(row.note), created_at: created.toISOString() })
    .select("id").single();
  if (error) {
    console.error("saved_items restore failed", error.message);
    return { ok: false };
  }
  return { ok: true, id: data.id as number };
}
