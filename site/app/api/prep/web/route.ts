import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { Timings } from "@/lib/ask/timing";
import { db } from "@/lib/db";
import { etaMs } from "@/lib/eta";
import { getDirectory } from "@/lib/guests";
import { sameGuest } from "@/lib/prep/build";
import { briefToText } from "@/lib/prep/export";
import { PREP_LIMITS, type Brief, type BriefWeb, type WebEvent } from "@/lib/prep/types";
import { WEB, WebError, webResearch } from "@/lib/prep/web";
import { takeTry } from "@/lib/rate-limit";
import { SESSION_COOKIE, VISITOR_COOKIE, readSessionToken } from "@/lib/session";

/** Two searches' timeouts plus the model's, with room to spare (Vercel). */
export const maxDuration = 60;

const tidy = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");

/** POST /api/prep/web {name, description} -> NDJSON stream of WebEvent (or JSON {error} with a status before it starts). "From the web" for a brief already built:
    a separate request, so the brief itself never waits for the web. Every call is a qa_log row (question
    "[web] name - line"), which is also how the daily limits are counted, across server instances: WEB.perDay per first
    name and WEB.siteDay for everyone. The row is written BEFORE any search is called and then counted, so requests
    that arrive together each see the others and can't slip past the cap; a request over a cap deletes its own row. */
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
  if (!(await takeTry(`prepweb:${session.firstName.toLowerCase()}`, 5, 60_000))) return NextResponse.json({ error: "limit" }, { status: 429 });
  const questionText = `[web] ${name}${description ? ` - ${description}` : ""}`;
  const { data: row, error: rowError } = await db().from("qa_log").insert({
    question: questionText, language: "en", answer: "", cited_chunk_ids: [], found: false,
    first_name: session.firstName, visitor_id: visitorId, kind: "brief",
  }).select("id").single();
  if (rowError || !row) {
    // Without the row the caps can't be enforced, so nothing is searched.
    console.error("prep web log insert failed:", rowError?.message);
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
  const logId = row.id as number;
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const webRows = () => db().from("qa_log").select("id", { count: "exact", head: true }).like("question", "[web] %").gte("created_at", since);
  // A first name is the same person whatever the case or the browser; the name has only letters and . ' - in it.
  const [mine, site] = await Promise.all([webRows().ilike("first_name", session.firstName), webRows()]);
  const over = mine.error || site.error ? "unavailable"
    : (mine.count ?? 0) > WEB.perDay ? "limit"
    : (site.count ?? 0) > WEB.siteDay ? "site-limit" : null;
  if (over) {
    await db().from("qa_log").delete().eq("id", logId);
    if (over === "unavailable") console.error("prep web count failed:", (mine.error ?? site.error)?.message);
    return NextResponse.json({ error: over }, { status: over === "unavailable" ? 503 : 429 });
  }

  const t = new Timings();
  const encoder = new TextEncoder();
  /** The reader pressed Cancel (or left): nothing more is sent. The search still finishes and is logged, because it
      was paid for and counts toward the daily limit. */
  let aborted = request.signal.aborted;
  request.signal.addEventListener("abort", () => { aborted = true; });
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (e: WebEvent) => {
        if (aborted) return;
        try { controller.enqueue(encoder.encode(JSON.stringify(e) + "\n")); } catch { aborted = true; }
      };
      void etaMs("web").then((ms) => { if (ms != null) emit({ type: "eta", ms }); });
      let web: BriefWeb | null = null;
      try {
        // A guest who has been on the show: "Since their last episode" counts from their newest episode in the archive.
        const same = sameGuest(name, (await getDirectory()).guests);
        web = await t.time("web", () => webResearch({ name, description, lastEpisode: same?.latest ?? null }, undefined, (step) => emit({ type: "step", step })));
        emit({ type: "web", web });
      } catch (e) {
        console.error("prep web failed:", e instanceof WebError || e instanceof Error ? e.message : "unknown");
        emit({ type: "error", error: "unavailable" });
      } finally {
        t.mark("done");
        console.log(t.line(`prep web ${name}`));
        // The row the limit counts, with the section as text (no keys or raw pages).
        const asText = web ? briefToText({ ...EMPTY, title: name, description, web }).split("\n\n").slice(1, 2).join("") : "";
        // Fills in the row written before the search (answer, whether it matched, how long it took).
        const done = { answer: asText, found: !!web?.matched, latency_ms: t.at.done };
        const up = await db().from("qa_log").update({ ...done, timings: t.toJSON() }).eq("id", logId);
        if (up.error) await db().from("qa_log").update(done).eq("id", logId);
        try { controller.close(); } catch {}
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
  });
}

/** A brief with nothing in it but the web section, to write that section as text with the shared exporter. */
const EMPTY: Brief = {
  version: 1, title: "", description: "", sector: null, builtAt: new Date(0).toISOString(), preparedFor: "", archiveEpisodes: 0,
  already: null, firstAppearance: false, returning: null, web: null, similar: [], asked: [], topics: [], suggestions: [], verify: [], removed: [],
};
