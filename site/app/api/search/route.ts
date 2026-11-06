import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { logEvent } from "@/lib/activity";
import { searchArchive } from "@/lib/archive";
import { parseScope } from "@/lib/ask/scope-types";
import { takeSearch, tooMany } from "@/lib/search/limit";
import { runFastSearch, runSearch } from "@/lib/search/search";
import type { SearchResult } from "@/lib/search/types";
import { SESSION_COOKIE, VISITOR_COOKIE, readSessionToken } from "@/lib/session";

/** GET /api/search?q=&scope=&phase=fast|full|quick
    phase=fast: names and titles only, the correction and the vague flag (no embedding, no passage search).
    phase=full (default): the whole result. The page asks for fast first, then full, and merges.
    scope: JSON like {"guest":"khan-sir","topic":"startups","year":2025,"lang":"hi"} (any part; anything malformed is dropped).
    phase=quick: the top bar's command palette (components/app/QuickSearch.tsx), as before this route grew the search: {guests, episodes}
    of verified guests and episode titles (lib/archive.ts), not rate limited or logged.
    Response: a SearchResult (lib/search/types.ts) with phase and ms. Errors: 400 {error}, 401 {error}, 429 {error, retryAfter}
    with a Retry-After header, 500 {error}. */

export const maxDuration = 30;

const clean = (v: string | null) => (v ?? "").replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);

function scopeOf(raw: string | null) {
  if (!raw) return null;
  try { return parseScope(JSON.parse(raw.slice(0, 500))); } catch { return null; }
}

/** What the search event keeps: the typed text, how many things were found, mode, vague and the correction. */
function eventDetail(r: SearchResult): Record<string, string> {
  const g = r.groups;
  const detail: Record<string, string> = {
    q: r.query.slice(0, 120),
    n: String(g.guests.length + g.episodes.length + g.clips.length + g.moments.length + g.topics.length),
    mode: r.mode,
    vague: r.vague ? "1" : "0",
  };
  if (r.corrected) detail.corrected = `${r.corrected.from}>${r.corrected.to}`.slice(0, 120);
  return detail;
}

export async function GET(request: Request) {
  const jar = await cookies();
  const session = readSessionToken(jar.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "Not logged in" }, { status: 401 });

  const params = new URL(request.url).searchParams;
  if (params.get("phase") === "quick") {
    try {
      return NextResponse.json(await searchArchive(params.get("q") ?? ""), { headers: { "Cache-Control": "private, no-store" } });
    } catch (e) {
      console.error("search failed", e instanceof Error ? e.message : e);
      return NextResponse.json({ error: "Couldn't reach the archive" }, { status: 502 });
    }
  }
  const q = clean(params.get("q"));
  if (!q) return NextResponse.json({ error: "Type something to search" }, { status: 400 });
  const phase = params.get("phase") === "fast" ? "fast" : "full";

  const wait = takeSearch(phase, session.firstName);
  if (wait) return NextResponse.json(tooMany(phase, wait), { status: 429, headers: { "Retry-After": String(wait) } });

  try {
    const scope = scopeOf(params.get("scope"));
    const result = phase === "fast" ? await runFastSearch(q, scope) : await runSearch(q, scope);
    // Logged after the response is sent, for the full phase only (the fast one is the same typing, asked for earlier).
    if (phase === "full") logEvent(session.firstName, jar.get(VISITOR_COOKIE)?.value ?? null, "search", eventDetail(result));
    return NextResponse.json(result, { headers: { "Cache-Control": "private, max-age=60" } });
  } catch (e) {
    console.error(`search ${phase} failed:`, e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Search isn't available right now. Try again." }, { status: 500 });
  }
}
