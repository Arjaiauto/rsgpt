import { ARCHIVE_RUN_ID } from "./archive-run";
import { guestSlug } from "./guest-slug";

/** Is this clean slug a guest? Used by proxy.ts so an unknown guest address gets a real 404 status (the page itself
    streams, so by the time it finds out the status 200 has been sent). The slugs of all verified guest rows are read
    once per server instance and kept for an hour. Plain fetch, no secrets logged. If the list can't be read the answer
    is "yes" (the page then shows its own not-found message), so a database hiccup never turns real guests into 404s. */
const TTL_MS = 60 * 60 * 1000;
let cache: { at: number; slugs: Set<string> } | null = null;
let loading: Promise<Set<string> | null> | null = null;

async function load(): Promise<Set<string> | null> {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  const slugs = new Set<string>();
  try {
    for (let from = 0; ; from += 1000) {
      const res = await fetch(
        `${url}/rest/v1/guests?select=guest_key&run_id=eq.${encodeURIComponent(ARCHIVE_RUN_ID)}&verified=eq.true&guest_key=not.is.null&order=id&limit=1000&offset=${from}`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(5000), cache: "no-store" },
      );
      if (!res.ok) return null;
      const rows = (await res.json()) as { guest_key: string }[];
      for (const r of rows) slugs.add(guestSlug(r.guest_key));
      if (rows.length < 1000) return slugs;
    }
  } catch {
    return null;
  }
}

export async function guestExists(slug: string): Promise<boolean> {
  if (!cache || Date.now() - cache.at > TTL_MS) {
    loading ??= load().finally(() => { loading = null; });
    const slugs = await loading;
    if (slugs) cache = { at: Date.now(), slugs };
    else if (!cache) return true;
  }
  return cache!.slugs.has(slug);
}
