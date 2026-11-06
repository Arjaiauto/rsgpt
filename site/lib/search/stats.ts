import "server-only";
import { db } from "@/lib/db";

/** About how many passages there are (the planner's estimate, read once an hour): what chunk_terms counts are shares of. */
const holder = globalThis as { __searchChunks?: { at: number; n: number } };

export async function totalChunks(): Promise<number> {
  const c = holder.__searchChunks;
  if (c && Date.now() - c.at < 3600_000) return c.n;
  const { count, error } = await db().from("chunks").select("id", { count: "estimated", head: true });
  if (error) throw new Error(`chunks count: ${error.message}`);
  holder.__searchChunks = { at: Date.now(), n: count ?? 0 };
  return holder.__searchChunks.n;
}
