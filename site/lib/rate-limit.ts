// In-memory sliding window per key. Resets when the server restarts and is per server process,
// which is enough for one small Node server; a multi-instance host would need a shared store.
const WINDOW_MS = 10 * 60 * 1000;
const MAX_TRIES = 10;

const store: Map<string, number[]> = ((globalThis as { __cpRateLimit?: Map<string, number[]> }).__cpRateLimit ??=
  new Map());

/** Records one try for this key and says whether it is allowed. */
export function takeTry(key: string, max = MAX_TRIES, windowMs = WINDOW_MS): boolean {
  const now = Date.now();
  const recent = (store.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) {
    store.set(key, recent);
    return false;
  }
  recent.push(now);
  store.set(key, recent);
  if (store.size > 5000) for (const [k, ts] of store) if (ts.every((t) => now - t >= WINDOW_MS)) store.delete(k);
  return true;
}
