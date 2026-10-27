import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { searchArchive } from "@/lib/archive";
import { SESSION_COOKIE, readSessionToken } from "@/lib/session";

/** Quick search for the command palette: verified guests and episode titles. */
export async function GET(request: NextRequest) {
  if (!readSessionToken((await cookies()).get(SESSION_COOKIE)?.value)) {
    return NextResponse.json({ error: "Not logged in" }, { status: 401 });
  }
  const q = request.nextUrl.searchParams.get("q") ?? "";
  try {
    return NextResponse.json(await searchArchive(q), { headers: { "Cache-Control": "private, no-store" } });
  } catch (e) {
    console.error("search failed", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Couldn't reach the archive" }, { status: 502 });
  }
}
