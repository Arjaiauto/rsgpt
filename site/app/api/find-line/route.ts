import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { ASK, FIND_LINE } from "@/lib/ask/config";
import { findLine } from "@/lib/ask/findline";
import { logEvent } from "@/lib/activity";
import { ipKey, takeTry } from "@/lib/rate-limit";
import { SESSION_COOKIE, VISITOR_COOKIE, readSessionToken } from "@/lib/session";

/** POST /api/find-line {query} -> FindLineResult. Database only: no Claude call. */
export async function POST(request: Request) {
  // A server running an older copy of lib/ask/config.ts (dev server started before FIND_LINE was added) has no
  // FIND_LINE: say so in the log instead of an unexplained 502.
  if (!FIND_LINE || ["exact", "closest", "context", "clipSeconds", "minChars", "maxChars"].some((k) => typeof FIND_LINE[k as keyof typeof FIND_LINE] !== "number")) {
    console.error("find-line: FIND_LINE is missing or incomplete in lib/ask/config.ts; restart the server so it loads the current file");
    return NextResponse.json({ error: "Find a line isn't configured on this server." }, { status: 500 });
  }
  const jar = await cookies();
  const session = readSessionToken(jar.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "Not logged in" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { query?: unknown };
  const query = typeof body.query === "string" ? body.query.trim().slice(0, ASK.maxQuestionChars) : "";
  if (!query) return NextResponse.json({ error: "Empty line" }, { status: 400 });

  const h = await headers();
  const deviceId = jar.get(VISITOR_COOKIE)?.value ?? null;
  const who = deviceId ?? ipKey(h);
  if (!(await takeTry(`line:${who}`, ASK.rateLimit.max, ASK.rateLimit.windowMs))) {
    return NextResponse.json({ error: "Too many searches. Wait a few minutes and try again." }, { status: 429 });
  }
  logEvent(session.firstName, deviceId, "find_line", { q: query.slice(0, 200) });

  try {
    return NextResponse.json(await findLine(query), { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("find-line failed:", e instanceof Error ? e.message : e);
    return NextResponse.json({ error: "Couldn't reach the archive. Try again." }, { status: 502 });
  }
}
