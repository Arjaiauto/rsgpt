/** Per-person rate limits for the search routes (Ticket 27). In this server's memory, on purpose: suggestions are asked
    for on almost every keystroke, so a database round trip per request (lib/rate-limit.ts) would cost more than the
    search it protects. A sliding window per person and bucket; a restarted or second server starts its own count, which
    is fine for a limit whose job is to stop a runaway page, not to meter use. */

export const SEARCH_LIMITS = {
  suggest: { max: 120, windowMs: 60_000 },
  fast: { max: 120, windowMs: 60_000 },
  /** The full search is the costly one (an embedding and a database search). */
  full: { max: 30, windowMs: 60_000 },
} as const;
export type SearchBucket = keyof typeof SEARCH_LIMITS;

const store: Map<string, number[]> = ((globalThis as { __searchLimit?: Map<string, number[]> }).__searchLimit ??= new Map());

/** Counts one request. Returns 0 when it is allowed, else the seconds until the oldest counted request leaves the window. */
export function takeSearch(bucket: SearchBucket, who: string, now = Date.now()): number {
  const { max, windowMs } = SEARCH_LIMITS[bucket];
  const key = `${bucket}:${who.trim().toLowerCase()}`;
  const recent = (store.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    store.set(key, recent);
    return Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1000));
  }
  recent.push(now);
  store.set(key, recent);
  if (store.size > 5000) for (const [k, ts] of store) if (ts.every((t) => now - t >= windowMs)) store.delete(k);
  return 0;
}

export const tooMany = (bucket: SearchBucket, retryAfter: number) => ({
  error: bucket === "suggest" ? "Too many suggestions. Wait a moment and keep typing." : "Too many searches. Wait a few seconds and try again.",
  retryAfter,
});
