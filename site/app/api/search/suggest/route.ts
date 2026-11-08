import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { takeSearch, tooMany } from "@/lib/search/limit";
import { suggest } from "@/lib/search/suggest";
import { SESSION_COOKIE, readSessionToken } from "@/lib/session";

/** GET /api/search/suggest?q=
    The top 8 suggestions for what is being typed, from the in-memory index: { q, items: [{ kind, label, sub, href, ref }], ms }.
    kind is guest | topic | episode | clip | term; label is the text to show, sub the small line under it, href where
    choosing it goes. An empty or 1-character q returns popular items. Never logged. Errors: 401 {error}, 429 {error,
    retryAfter} with a Retry-After header, 500 {error}. */

export async function GET(request: Request) {
  const jar = await cookies();
  const session = readSessionToken(jar.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "Not logged in" }, { status: 401 });

  const wait = takeSearch("suggest", session.firstName);
  if (wait) return NextResponse.json(tooMany("suggest", wait), { status: 429, headers: { "Retry-After": String(wait) } });

  try {
    const result = await suggest(new URL(request.url).searchParams.get("q") ?? "");
    return NextResponse.json(result, { headers: { "Cache-Control": "private, max-age=30" } });
  } catch (e) {
    console.error("suggest failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Suggestions aren't available right now." }, { status: 500 });
  }
}
