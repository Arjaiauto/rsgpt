import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";

/** Server-only timing logs, to read in Vercel's runtime logs. Nothing else is logged: no keys, no URLs, no user data.

    - A cached loader logs only when it really runs, that is on a cache miss: "[data] getDirectory 412 ms, 12 Supabase
      calls". No line for a loader means its data came from the cache.
    - A page logs every request: "[data] page /clips 8 ms, 0 Supabase calls". Its count is the requests made outside
      any cache (a cached loader runs in its own context, so its requests are counted on its own line, not the page's).
      0 calls and a few milliseconds means the page was served entirely from the cache. */

type Counter = { calls: number };
const scope = new AsyncLocalStorage<Counter[]>();

/** Called by the Supabase client (lib/db.ts) for every request: counts it for every timed() block it runs in. */
export function countSupabaseCall(): void {
  for (const c of scope.getStore() ?? []) c.calls++;
}

/** Next.js stops a render with internal errors that carry a digest (the static shell reaching cookies(), redirect,
    notFound). They are not failures, and the render that matters logs its own line. */
const isNextSignal = (e: unknown) => typeof e === "object" && e !== null && "digest" in e;

/** Runs fn and logs how long it took and how many Supabase requests it made. */
export async function timed<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const mine: Counter = { calls: 0 };
  const t0 = performance.now();
  const line = (extra = "") =>
    console.log(`[data] ${name} ${Math.round(performance.now() - t0)} ms, ${mine.calls} Supabase call${mine.calls === 1 ? "" : "s"}${extra}`);
  try {
    const out = await scope.run([...(scope.getStore() ?? []), mine], fn);
    line();
    return out;
  } catch (e) {
    if (!isNextSignal(e)) line(", failed");
    throw e;
  }
}
