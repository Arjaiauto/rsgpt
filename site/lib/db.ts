import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** The extraction run the site shows. Older test runs also have verified rows; they are never shown. */
export const ARCHIVE_RUN_ID = "extract-haiku-v5-20261023-011718";

let client: SupabaseClient | null = null;

/** Service-role client for server code only (the "server-only" import makes a client-side import a build error). */
export function db(): SupabaseClient {
  if (client) return client;
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_KEY must be set in .env");
  client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}
