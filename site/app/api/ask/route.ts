import { cookies, headers } from "next/headers";
import { NextResponse } from "next/server";
import { etaMs } from "@/lib/eta";
import { followups, logQuestion, sourceCards, streamAnswer } from "@/lib/ask/answer";
import { ASK, COVERED_QUESTIONS } from "@/lib/ask/config";
import { retrieve, sourceOf } from "@/lib/ask/retrieve";
import { getGuestScope } from "@/lib/guests";
import { Timings } from "@/lib/ask/timing";
import type { AskEvent, AskLanguage } from "@/lib/ask/types";
import { takeTry } from "@/lib/rate-limit";
import { SESSION_COOKIE, VISITOR_COOKIE, readSessionToken } from "@/lib/session";

/** POST /api/ask {question, earlier?: string[], guest?: slug} -> NDJSON stream of AskEvent (one JSON object per line). */
export async function POST(request: Request) {
  const jar = await cookies();
  const session = readSessionToken(jar.get(SESSION_COOKIE)?.value);
  if (!session) return NextResponse.json({ error: "Not logged in" }, { status: 401 });
  const visitorId = jar.get(VISITOR_COOKIE)?.value ?? null;

  const body = (await request.json().catch(() => ({}))) as { question?: unknown; earlier?: unknown; guest?: unknown };
  const question = typeof body.question === "string" ? body.question.trim().slice(0, ASK.maxQuestionChars) : "";
  if (!question) return NextResponse.json({ error: "Empty question" }, { status: 400 });
  const earlier = Array.isArray(body.earlier)
    ? body.earlier.filter((q): q is string => typeof q === "string").slice(-3).map((q) => q.slice(0, ASK.maxQuestionChars))
    : [];

  // Asked from a guest page: only that guest's episodes are searched.
  let scope: { name: string; videoIds: string[] } | null = null;
  if (body.guest != null) {
    const slug = typeof body.guest === "string" ? body.guest : "";
    scope = /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) && slug.length <= 120 ? await getGuestScope(slug) : null;
    if (!scope) return NextResponse.json({ error: "Unknown guest" }, { status: 400 });
  }

  const h = await headers();
  const who = visitorId ?? h.get("x-forwarded-for")?.split(",")[0].trim() ?? "local";
  if (!takeTry(`ask:${who}`, ASK.rateLimit.max, ASK.rateLimit.windowMs)) {
    return NextResponse.json({ error: "Too many questions. Wait a few minutes and try again." }, { status: 429 });
  }

  const t = new Timings();
  const debug = process.env.NODE_ENV !== "production" && request.headers.get("x-ask-debug") === "1";
  const encoder = new TextEncoder();
  /** The reader pressed Cancel (or left): nothing more is sent, and no more of the work is started. */
  let aborted = request.signal.aborted;
  request.signal.addEventListener("abort", () => { aborted = true; });
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (e: AskEvent) => {
        if (aborted) return;
        try { controller.enqueue(encoder.encode(JSON.stringify(e) + "\n")); } catch { aborted = true; }
      };
      // The time estimate (median of recent runs) goes out as soon as it is read; it never delays the work.
      void etaMs("ask").then((ms) => { if (ms != null) emit({ type: "eta", ms }); });
      let language: AskLanguage | null = null;
      /** Logs the timing line and the qa_log row. */
      const finish = (answer: string, citedChunkIds: number[], found: boolean) => {
        t.mark("done");
        console.log(t.line(question));
        return logQuestion({ question, language, answer, citedChunkIds, found, firstName: session.firstName, visitorId, latencyMs: t.at.done, timings: t });
      };
      try {
        emit({ type: "step", step: 1 });
        const r = await retrieve(question, earlier, t, scope?.videoIds);
        language = r.rewritten.language;
        const episodes = new Set(r.chunks.map((c) => c.videoId)).size;
        emit({ type: "step", step: 2, moments: r.chunks.length, episodes });
        if (debug) emit({ type: "debug", data: {
          rewritten: r.rewritten, bestSimilarity: r.bestSimilarity,
          top: r.chunks.slice(0, 12).map((c) => ({ id: c.id, sim: +c.similarity.toFixed(3), score: +c.score.toFixed(4), ep: r.episodes.get(c.videoId)?.title.slice(0, 60), guests: r.episodes.get(c.videoId)?.guests })),
        } });

        const suggestions = COVERED_QUESTIONS.filter((q) => q.toLowerCase() !== question.toLowerCase()).slice(0, 3);
        if (!r.found) {
          emit({ type: "notfound", suggestions, language });
          await finish("", [], false);
          if (debug) emit({ type: "debug", data: { timings: t } });
          emit({ type: "done", answerId: null, followups: [], cited: 0 });
          controller.close();
          return;
        }

        // The page fills in while the answer is written: source cards and the best-matching moment now (the
        // reference player moves to the first cited moment once the answer cites one), follow-ups in parallel.
        emit({ type: "found", sources: sourceCards(r, []), language });
        const best = r.chunks[0];
        emit({ type: "ref", ref: { ...sourceOf(r.episodes.get(best.videoId)!, best.startS, best.endS), chunkId: best.id } });
        t.mark("found");
        emit({ type: "step", step: 3 });
        if (aborted) { controller.close(); return; }
        const next = t.time("followups", () => followups(question, r));
        let a = await streamAnswer(question, r, emit, t);
        if ((a.notFound || a.thin) && r.bestSimilarity >= ASK.retrySimilarity) {
          // The archive clearly has close matches, so NOT_FOUND (or an answer with fewer than two cited sentences)
          // is more likely a misjudgement: try once more, thinking harder. Nothing of the first attempt was shown.
          t.mark("retry");
          a = await streamAnswer(question, r, emit, t, "medium");
        }

        if (aborted) { controller.close(); return; }
        emit({ type: "step", step: 4 });
        if (a.notFound || a.thin) {
          // Rule 2: nothing shown without citations.
          emit({ type: "notfound", suggestions, language, thin: a.thin });
          const answerId = await finish(a.text, [], false);
          if (debug) emit({ type: "debug", data: { timings: t, notFound: a.notFound, gate: a.gateLog } });
          emit({ type: "done", answerId, followups: [], cited: 0 });
        } else {
          emit({ type: "sources", sources: sourceCards(r, a.cited) });
          const followupList = await next;
          const answerId = await finish(a.text, a.citedChunkIds, true);
          if (debug) emit({ type: "debug", data: { timings: t, gate: a.gateLog } });
          emit({ type: "done", answerId, followups: followupList, cited: a.cited.length });
        }
      } catch (e) {
        if (aborted) { try { controller.close(); } catch {} return; }
        console.error("ask failed:", e instanceof Error ? e.message : e);
        emit({ type: "error", message: "Couldn't reach the archive. Try again." });
        await finish("", [], false).catch(() => null);
      }
      try { controller.close(); } catch {}
    },
  });

  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
  });
}
