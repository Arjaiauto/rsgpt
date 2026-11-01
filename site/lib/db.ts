import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { countSupabaseCall } from "./data-log";

export { ARCHIVE_RUN_ID } from "./archive-run";

let client: SupabaseClient | null = null;

/** Service-role client for server code only (the "server-only" import makes a client-side import a build error).
    Every request it makes is counted for the [data] timing logs (lib/data-log.ts); nothing about it is logged. */
export function db(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in .env");
  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => { countSupabaseCall(); return fetch(input, init); } },
  });
  return client;
}

const PAGE = 1000;
/** Pages fetched at once after the first one. */
const PARALLEL_PAGES = 4;

type Page<T> = (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

/** All rows of a query (Supabase returns at most 1,000 rows per request). The first page is read alone; when it is
    full, the next pages are read PARALLEL_PAGES at a time, so a table of 3,000-4,000 rows costs two round trips
    instead of four. The query must have a stable order, so pages never overlap. */
export async function allRows<T>(page: Page<T>): Promise<T[]> {
  const read = async (n: number) => {
    const { data, error } = await page(n * PAGE, n * PAGE + PAGE - 1);
    if (error) throw new Error(error.message);
    return data ?? [];
  };
  const rows = await read(0);
  if (rows.length < PAGE) return rows;
  for (let n = 1; ; n += PARALLEL_PAGES) {
    const pages = await Promise.all(Array.from({ length: PARALLEL_PAGES }, (_, i) => read(n + i)));
    for (const p of pages) {
      rows.push(...p);
      if (p.length < PAGE) return rows;
    }
  }
}
