"use server";

import { cookies } from "next/headers";
import { requireSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { cleanBrief } from "@/lib/prep/clean";
import type { Brief, PastBrief } from "@/lib/prep/types";
import { VISITOR_COOKIE } from "@/lib/session";

/** Past briefs: the 'brief' rows of saved_items that this visitor saved (same ownership as unsaveItem: first name
    and the visitor_id cookie). New briefs are saved with saveItem; this file lists, reopens and updates them. */

async function owner() {
  const { firstName } = await requireSession();
  const visitorId = (await cookies()).get(VISITOR_COOKIE)?.value ?? null;
  return { firstName, visitorId };
}

export async function listBriefs(): Promise<PastBrief[]> {
  const { firstName, visitorId } = await owner();
  let q = db().from("saved_items").select("id,created_at,title:item_ref->>title,description:item_ref->>description")
    .eq("kind", "brief").eq("first_name", firstName);
  q = visitorId ? q.eq("visitor_id", visitorId) : q.is("visitor_id", null);
  const { data, error } = await q.order("created_at", { ascending: false }).limit(30);
  if (error) {
    console.error("saved_items list failed", error.message);
    return [];
  }
  return (data ?? []).map((r) => ({ id: r.id as number, title: String(r.title ?? "Brief"), description: String(r.description ?? ""), createdAt: r.created_at as string }));
}

export async function loadBrief(id: number): Promise<Brief | null> {
  if (!Number.isInteger(id)) return null;
  const { firstName, visitorId } = await owner();
  let q = db().from("saved_items").select("item_ref").eq("id", id).eq("kind", "brief").eq("first_name", firstName);
  q = visitorId ? q.eq("visitor_id", visitorId) : q.is("visitor_id", null);
  const { data, error } = await q.maybeSingle();
  if (error) console.error("saved_items read failed", error.message);
  return data ? cleanBrief(data.item_ref) : null;
}

/** Saving an opened brief again after more edits updates its row instead of adding a second one. */
export async function updateBrief(id: number, brief: Brief): Promise<{ ok: boolean }> {
  const row = cleanBrief(brief);
  if (!row || !Number.isInteger(id)) return { ok: false };
  const { firstName, visitorId } = await owner();
  let q = db().from("saved_items").update({ item_ref: row }).eq("id", id).eq("kind", "brief").eq("first_name", firstName);
  q = visitorId ? q.eq("visitor_id", visitorId) : q.is("visitor_id", null);
  const { error } = await q;
  if (error) console.error("saved_items update failed", error.message);
  return { ok: !error };
}
