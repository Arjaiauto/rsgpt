import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { logQuestion } from "@/lib/ask/answer";
import { Timings } from "@/lib/ask/timing";
import { db } from "@/lib/db";
import { getDirectory } from "@/lib/guests";
import { sameGuest } from "@/lib/prep/build";
import { briefToText } from "@/lib/prep/export";
import { PREP_LIMITS, type Brief, type BriefWeb } from "@/lib/prep/types";
import { WEB, WebError, webResearch } from "@/lib/prep/web";
import { takeTry } from "@/lib/rate-limit";
import { SESSION_COOKIE, VISITOR_COOKIE, readSessionToken } from "@/lib/session";

/** Two searches' timeouts plus the model's, with room to spare (Vercel). */
export const maxDuration = 60;

const tidy = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");

/** POST /api/prep/web {name, description} -> {web: BriefWeb} or {error}. "From the web" for a brief already built:
    a separate request, so the brief itself never waits for the web. Every call is a qa_log row (question
    "[web] name - line"), which is also how the daily limit per session is counted, across server instances. */
export async function POST(request: Request) {
  const jar = await cookies();
  const session = readSessionToken(jar.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "Not logged in" }, { status: 401 });
  const visitorId = jar.get(VISITOR_COOKIE)?.value ?? null;

  const body = (await request.json().catch(() => ({}))) as { name?: unknown; description?: unknown };
  const name = tidy(body.name, PREP_LIMITS.name);
  const description = tidy(body.description, PREP_LIMITS.description);
  if (!name) return NextResponse.json({ error: "Add a name" }, { status: 400 });

  // A quick burst guard per server, then the real limit: this session's web calls in the last 24 hours.
  if (!takeTry(`prepweb:${session.firstName}:${visitorId ?? "-"}`, 5, 60_000)) return NextResponse.json({ error: "limit" }, { status: 429 });
  let q = db().from("qa_log").select("id", { count: "exact", head: true })
    .eq("first_name", session.firstName).like("question", "%[web] %").gte("created_at", new Date(Date.now() - 86_400_000).toISOString());
  q = visitorId ? q.eq("visitor_id", visitorId) : q.is("visitor_id", null);
  const { count, error: countError } = await q;
  if (countError) console.error("prep web count failed:", countError.message);
  if ((count ?? 0) >= WEB.perDay) return NextResponse.json({ error: "limit" }, { status: 429 });

  const t = new Timings();
  // A guest who has been on the show: "Since their last episode" counts from their newest episode in the archive.
  const same = sameGuest(name, (await getDirectory()).guests);
  let web: BriefWeb | null = null;
  try {
    web = await t.time("web", () => webResearch({ name, description, lastEpisode: same?.latest ?? null }));
    return NextResponse.json({ web });
  } catch (e) {
    console.error("prep web failed:", e instanceof WebError || e instanceof Error ? e.message : "unknown");
    return NextResponse.json({ error: "unavailable" }, { status: 502 });
  } finally {
    t.mark("done");
    console.log(t.line(`prep web ${name}`));
    // The row the limit counts, with the section as text (no keys or raw pages).
    const asText = web ? briefToText({ ...EMPTY, title: name, description, web }).split("\n\n").slice(1, 2).join("") : "";
    await logQuestion({
      question: `[web] ${name}${description ? ` - ${description}` : ""}`, language: "en", answer: asText, citedChunkIds: [], found: !!web?.matched,
      firstName: session.firstName, visitorId, latencyMs: t.at.done, timings: t, kind: "brief",
    }).catch(() => null);
  }
}

/** A brief with nothing in it but the web section, to write that section as text with the shared exporter. */
const EMPTY: Brief = {
  version: 1, title: "", description: "", sector: null, builtAt: new Date(0).toISOString(), preparedFor: "", archiveEpisodes: 0,
  already: null, firstAppearance: false, returning: null, web: null, similar: [], asked: [], topics: [], suggestions: [], verify: [], removed: [],
};
