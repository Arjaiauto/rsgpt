import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { logEvent } from "@/lib/activity";
import { takeUser, USER_LIMITS } from "@/lib/rate-limit";
import { SESSION_COOKIE, VISITOR_COOKIE, readSessionToken } from "@/lib/session";

/** POST /api/event {path, params?}: one page view from the browser beacon (components/app/PageViewBeacon.tsx).
    Answers 204 with no body whatever happens, so the beacon never waits for or reacts to anything. Only the app's own
    pages and a short list of query keys are kept; everything else in the body is ignored. */

const PATH = /^\/(ask|prep|saved|insights|future|clips|clips\/reels|guests|guests\/[a-z0-9]+(-[a-z0-9]+)*)$/;
/** The query keys kept, with the longest value each (the search text may be longer than a filter). */
const KEYS = { q: 120, topic: 60, guest: 120, len: 12, year: 4, lang: 4, sort: 12, start: 12 } as const;

const quiet = () => new NextResponse(null, { status: 204 });

export async function POST(request: Request) {
  const jar = await cookies();
  const session = readSessionToken(jar.get(SESSION_COOKIE)?.value);
  if (!session) return quiet(); // logged out: nothing is recorded

  let body: { path?: unknown; params?: unknown } = {};
  try { body = JSON.parse((await request.text()).slice(0, 2000)); } catch { return quiet(); }
  const path = typeof body.path === "string" ? body.path.split(/[?#]/)[0].replace(/\/+$/, "") : "";
  if (!PATH.test(path)) return quiet();

  const detail: Record<string, string> = { path };
  if (body.params && typeof body.params === "object") {
    for (const [key, max] of Object.entries(KEYS)) {
      const v = (body.params as Record<string, unknown>)[key];
      const text = typeof v === "string" ? v.replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
      if (text) detail[key] = text;
    }
  }

  if (!(await takeUser("event", session.firstName, USER_LIMITS.events.max, USER_LIMITS.events.windowMs))) return quiet();
  logEvent(session.firstName, jar.get(VISITOR_COOKIE)?.value ?? null, "page_view", detail);
  return quiet();
}
