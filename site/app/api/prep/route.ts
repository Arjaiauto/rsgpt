import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { logQuestion } from "@/lib/ask/answer";
import { Timings } from "@/lib/ask/timing";
import { getDirectory } from "@/lib/guests";
import { buildBrief } from "@/lib/prep/build";
import { briefToText } from "@/lib/prep/export";
import { PREP_LIMITS, type PrepEvent } from "@/lib/prep/types";
import { takeTry } from "@/lib/rate-limit";
import { SESSION_COOKIE, VISITOR_COOKIE, readSessionToken } from "@/lib/session";

/** Briefs per visitor (falls back to IP) in the window; one brief is one Haiku call plus a search. */
const RATE_LIMIT = { max: 12, windowMs: 10 * 60 * 1000 };

const tidy = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");

/** POST /api/prep {name, description, sector?} -> NDJSON stream of PrepEvent (one JSON object per line). */
export async function POST(request: Request) {
  const jar = await cookies();
  const session = readSessionToken(jar.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "Not logged in" }, { status: 401 });
  const visitorId = jar.get(VISITOR_COOKIE)?.value ?? null;

  const body = (await request.json().catch(() => ({}))) as { name?: unknown; description?: unknown; sector?: unknown };
  const name = tidy(body.name, PREP_LIMITS.name);
  const description = tidy(body.description, PREP_LIMITS.description);
  let sector: string | null = null;
  if (body.sector != null) {
    sector = typeof body.sector === "string" ? body.sector : "";
    if (!(await getDirectory()).sectors.some((s) => s.key === sector)) return NextResponse.json({ error: "Unknown sector" }, { status: 400 });
  }
  if (!name && !sector) return NextResponse.json({ error: "Add a name or pick a sector" }, { status: 400 });

  const h = await headers();
  const who = visitorId ?? h.get("x-forwarded-for")?.split(",")[0].trim() ?? "local";
  if (!takeTry(`prep:${who}`, RATE_LIMIT.max, RATE_LIMIT.windowMs)) {
    return NextResponse.json({ error: "Too many briefs. Wait a few minutes and try again." }, { status: 429 });
  }

  const t = new Timings();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (e: PrepEvent) => controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
      const question = sector ? `Sector: ${sector}${description ? ` - ${description}` : ""}` : `${name}${description ? ` - ${description}` : ""}`;
      const log = (answer: string, citedChunkIds: number[], found: boolean) => {
        t.mark("done");
        console.log(t.line(`prep ${question}`));
        return logQuestion({ question, language: "en", answer, citedChunkIds, found, firstName: session.firstName, visitorId, latencyMs: t.at.done, timings: t, kind: "brief" });
      };
      try {
        const r = await buildBrief({ name, description, sector }, { firstName: session.firstName }, emit, t);
        if ("notFound" in r) {
          emit({ type: "notfound", message: r.notFound });
          emit({ type: "done", logId: await log("", [], false) });
        } else {
          emit({ type: "brief", brief: r.brief });
          emit({ type: "done", logId: await log(briefToText(r.brief), r.citedChunkIds, true) });
        }
      } catch (e) {
        console.error("prep failed:", e instanceof Error ? e.message : e);
        emit({ type: "error", message: "Couldn't build the brief. Try again." });
        await log("", [], false).catch(() => null);
      }
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
  });
}
