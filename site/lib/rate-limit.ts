import "server-only";
import { db } from "@/lib/db";
import { hashIp } from "@/lib/session";

/** Rate limits kept in the database (pipeline/sql/rate_limits.sql: table rate_limits and the function
    take_rate_limit, one atomic increment), so they hold across every server instance and restart.
    A fixed window per key. If the database can't be reached the limit falls back to a per-process sliding window, so a
    database hiccup never locks everyone out and never leaves a route unguarded. */

/** Records one try for this key and says whether it is allowed. */
export async function takeTry(key: string, max: number, windowMs: number): Promise<boolean> {
  try {
    const { data, error } = await db().rpc("take_rate_limit", { p_key: key, p_max: max, p_window_s: Math.max(1, Math.round(windowMs / 1000)) });
    if (!error && typeof data === "boolean") return data;
    console.error("rate limit rpc failed:", error?.message ?? "unexpected reply");
  } catch (e) {
    console.error("rate limit rpc failed:", e instanceof Error ? e.message : "unknown");
  }
  return memoryTry(key, max, windowMs);
}

/** A per-person limit for a signed-in action (first name, any letter case). */
export const takeUser = (action: string, firstName: string, max: number, windowMs: number) =>
  takeTry(`${action}:${firstName.trim().toLowerCase()}`, max, windowMs);

/** The caller's address from the proxy headers, as a hashed key (never the raw IP, which must not reach the database). */
export function ipKey(h: { get(name: string): string | null }): string {
  const ip = h.get("x-forwarded-for")?.split(",")[0].trim() || h.get("x-real-ip");
  return ip ? hashIp(ip) : "local";
}

/** The limits of the actions that have no route of their own, in one place (tries per window per person). */
export const USER_LIMITS = {
  events: { max: 300, windowMs: 10 * 60 * 1000 },
  saved: { max: 120, windowMs: 10 * 60 * 1000 },
  report: { max: 10, windowMs: 10 * 60 * 1000 },
  /** Thumbs up/down on answers and briefs: its own count, separate from Ask's 30 questions. */
  feedback: { max: 60, windowMs: 10 * 60 * 1000 },
  clips: { max: 200, windowMs: 10 * 60 * 1000 },
} as const;
export const LOGIN_LIMIT = { max: 10, windowMs: 15 * 60 * 1000 } as const;

/* ---------- fallback ---------- */
const store: Map<string, number[]> = ((globalThis as { __cpRateLimit?: Map<string, number[]> }).__cpRateLimit ??= new Map());
function memoryTry(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const recent = (store.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) { store.set(key, recent); return false; }
  recent.push(now);
  store.set(key, recent);
  if (store.size > 5000) for (const [k, ts] of store) if (ts.every((t) => now - t >= windowMs)) store.delete(k);
  return true;
}
