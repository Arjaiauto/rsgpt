import "server-only";
import type Anthropic from "@anthropic-ai/sdk";
import { db } from "@/lib/db";
import { fmtTime } from "@/lib/player-types";
import { claude } from "./anthropic";
import { ANSWER_LENGTHS, ASK, HOST_NAME, type AnswerEffort, type AnswerLength } from "./config";
import { guestLabel, monthYear, sourceOf, type Candidate, type Episode, type Retrieved, type Turn } from "./retrieve";
import { SentenceGate, nameWordsOf, personWords, speakerCheck, type Person } from "./sentences";
import type { Timings } from "./timing";
import type { AskEvent, AskLanguage, Cite, Source } from "./types";

const LANGUAGE_NAME: Record<AskLanguage, string> = {
  en: "English",
  hi: "Hindi, in Devanagari script",
  hinglish: "Hinglish (Hindi and English mixed, in Roman script)",
};

const NOT_FOUND = "NOT_FOUND";

/** Added to the user turn of a retry (not the system prompt, which stays cached): the first attempt left too few cited
    sentences, so the retry is told to cite every sentence or leave the point out. The citation gate itself is unchanged. */
const CITE_EVERY_SENTENCE = "Every sentence must end with a citation to the search result it comes from. If a point can't be cited, leave it out instead of writing it uncited.";

/** Whether the first attempt gets a retry. A thin result (the model did cite something, but fewer than
    ASK.minCitedSentences sentences survived the gate) is always retried: it shows the archive has the topic. NOT_FOUND is
    retried only when the best chunk is similar enough (ASK.retrySimilarity) that it is more likely a misjudgement. */
export const shouldRetry = (a: { notFound: boolean; thin: boolean }, bestSimilarity: number) =>
  a.thin || (a.notFound && bestSimilarity >= ASK.retrySimilarity);

function systemPrompt(language: AskLanguage, hostView: boolean) {
  return `You answer questions about the Figuring Out podcast, hosted by Raj Shamani, using only the search results provided. Each search result is a stretch of one episode's transcript; its title is "episode title | guest names | month". Each block is one turn, starting with its time and speaker ("Host" is Raj Shamani). Hindi turns come with an English translation.

How to answer:
- Answer from the search results that are about the question, even if they cover it only in part. Leave out results that are not about the question, without mentioning them.
- Reply with exactly ${NOT_FOUND} and nothing else only when none of the search results is about the question.
- Say in your own words what was said. Do not paste transcript text, and do not quote more than a few words.
- Describe what the host or a guest said in the third person ("Raj said…", "the host argued…", "Nikhil Kamath said…"). Never write as the host and never use "I" or "we" for anyone on the show.
- Name the guest when the search result's title gives a name. For "which guests" questions, name each guest.
- Name the person in each sentence instead of starting it with "he", "she" or "they", so every sentence stands on its own with its citation.${hostView ? `
- The question asks for the host's own views: answer from the turns where the Host speaks.` : ""}
- Reply in ${LANGUAGE_NAME[language]}.
- Write 3 to 6 short sentences, each about one moment from the episodes. No headings, no lists, no introduction, no closing remarks.
- Every sentence must state something from a provided search result and carry its citation. No framing, summary or filler sentences without a source. Do not add facts, numbers or opinions that are not in the search results.
- Do not write times, timestamps or episode titles in the text; they are shown next to each sentence.

Think briefly: pick the relevant search results, then write.`;
}

type Prepared = { chunk: Candidate; ep: Episode; turns: Turn[] };

function blockText(t: Turn, ep: Episode): string {
  const who = t.speaker === "raj" ? "Host" : t.speaker === "guest" ? `Guest (${guestLabel(ep)})` : "Speaker";
  return `[${fmtTime(t.startS)}] ${who}: ${t.roman}${t.english ? `\nEnglish: ${t.english}` : ""}`;
}

/** Streams the answer for a retrieved set of chunks, emitting text and citations as they arrive. */
export async function streamAnswer(
  question: string,
  r: Retrieved,
  emit: (e: AskEvent) => void,
  t: Timings,
  length: AnswerLength = "medium",
  effort: AnswerEffort = ASK.answerEffort,
  /** A retry: the user turn also tells the model to cite every sentence. */
  strictCitations = false,
): Promise<{ text: string; citedChunkIds: number[]; cited: Cite[]; notFound: boolean; thin: boolean; gateLog: string[] }> {
  const mode = ANSWER_LENGTHS[length];
  const top = r.chunks.slice(0, mode.toModel);
  const prepared: Prepared[] = top
    .map((chunk) => ({ chunk, ep: r.episodes.get(chunk.videoId)!, turns: r.turns.get(chunk.id) ?? [] }))
    .filter((p) => p.turns.length > 0);

  const searchResults: Anthropic.SearchResultBlockParam[] = prepared.map((p) => ({
    type: "search_result",
    source: `cuepoint:chunk/${p.chunk.id}`,
    title: `${p.ep.title} | ${guestLabel(p.ep)} | ${monthYear(p.ep.publishedAt)}`,
    content: p.turns.map((t) => ({ type: "text", text: blockText(t, p.ep) })),
    citations: { enabled: true },
  }));

  // The length instruction follows the question in the user turn (the system prompt, and its cache, is the same for every mode).
  const userText = [question, mode.instruction, strictCitations ? CITE_EVERY_SENTENCE : null].filter(Boolean).join("\n\n");

  const claudeStart = performance.now();
  const sinceClaude = () => Math.round(performance.now() - claudeStart);
  const stream = claude().messages.stream({
    model: ASK.model,
    max_tokens: 4096,
    // Thinking stays on: without it (or with search results it is sometimes used anyway) Haiku cites about half as
    // many sentences. Low effort plus "think briefly" cites as many as medium, about 2 s sooner (tested 2026-10-27).
    thinking: { type: "adaptive" },
    output_config: { effort },
    // Cached per language and host-view variant (about 1,250 tokens); the search results change every time.
    system: [{ type: "text", text: systemPrompt(r.rewritten.language, r.rewritten.hostView), cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: [...searchResults, { type: "text", text: userText }] }],
  });
  // Each answer block is held until it is complete, so a NOT_FOUND reply never shows. Then the gate applies rule 2
  // sentence by sentence (lib/ask/sentences.ts): uncited sentences and verbatim copies of the transcript are
  // dropped, and nothing is sent until two cited sentences are in hand, so a thin answer never appears and can be
  // retried. Each shown sentence is sent as one block, followed by its citations.
  let notFound = false, first = true;
  let text = ""; // sent to the client
  const cited: Cite[] = [];
  let out = -1; // last answer block sent to the client
  let cur: { text: string; cites: Cite[]; citedTexts: string[] } | null = null;

  const names = ["Raj", "Shamani", ...prepared.flatMap((p) => [...p.ep.guests, guestLabel(p.ep)])];
  // Who speaks in each citation's lines, for the speaker check: the host, or this episode's guest(s) (verified
  // names, else the name in the title).
  const spokenBy = new Map<Cite, Set<Turn["speaker"]>>();
  const people: Person<Cite>[] = [
    { name: "Raj Shamani", words: new Set(["raj", "shamani", "host", "राज"]), spokeIn: (c: Cite) => !!spokenBy.get(c)?.has("raj") },
    ...[...new Map(prepared.map((p) => [p.ep.videoId, p.ep])).values()].flatMap((ep) =>
      (ep.guests.length ? ep.guests : [guestLabel(ep)]).map((name) => ({
        name, words: personWords(name),
        spokeIn: (c: Cite) => c.videoId === ep.videoId && !!spokenBy.get(c)?.has("guest"),
      }))),
  ].filter((p) => p.words.size > 0);

  const gate = new SentenceGate<Cite>({ nameWords: nameWordsOf(names), episodeOf: (cite) => cite.videoId, speakerOk: speakerCheck(people), minCited: ASK.minCitedSentences, send: (sentence, cites) => {
    if (out < 0) {
      t.stages.claude_first_sentence ??= sinceClaude();
      t.mark("first_sentence");
    }
    out += 1;
    emit({ type: "text", block: out, text: sentence });
    text += sentence;
    for (const cite of cites) {
      if (!cited.length) {
        const ep = r.episodes.get(cite.videoId)!;
        emit({ type: "ref", ref: { ...sourceOf(ep, cite.startS, Math.max(cite.endS, cite.startS + 45)), chunkId: cite.chunkId } });
      }
      cited.push(cite);
      emit({ type: "cite", block: out, cite });
    }
  } });

  const flush = () => {
    if (!cur) return;
    const blk = cur;
    cur = null;
    if (first && blk.text.trim()) {
      first = false;
      if (blk.text.trim().startsWith(NOT_FOUND)) { notFound = true; return; }
    }
    gate.block(blk.text, blk.cites, blk.citedTexts);
  };

  for await (const event of stream) {
    if (event.type === "content_block_start" && event.content_block.type === "text") {
      cur = { text: "", cites: [], citedTexts: [] };
    } else if (event.type === "content_block_stop") {
      flush();
      if (notFound) break;
    } else if (event.type === "content_block_delta" && cur) {
      if (event.delta.type === "text_delta") {
        t.stages.claude_ttft ??= sinceClaude();
        cur.text += event.delta.text;
      } else if (event.delta.type === "citations_delta" && event.delta.citation.type === "search_result_location") {
        const c = event.delta.citation;
        const p = prepared[c.search_result_index];
        const turns = p?.turns.slice(c.start_block_index, c.end_block_index) ?? [];
        if (!p || !turns.length) continue;
        const speakers = new Set(turns.map((t) => t.speaker));
        const cite: Cite = {
          chunkId: p.chunk.id,
          videoId: p.chunk.videoId,
          startS: turns[0].startS,
          endS: turns[turns.length - 1].endS,
          segmentIds: turns.flatMap((t) => t.segmentIds),
          speaker: speakers.size === 1 && speakers.has("raj") ? HOST_NAME : guestLabel(p.ep),
          date: monthYear(p.ep.publishedAt),
          episode: p.ep.title,
          guest: guestLabel(p.ep),
        };
        spokenBy.set(cite, speakers);
        cur.cites.push(cite);
        cur.citedTexts.push(c.cited_text);
      }
    }
  }
  flush();
  const enough = !notFound && gate.end();
  t.counts = { ...gate.counts };
  if (notFound) stream.abort();
  else {
    const final = await stream.finalMessage().catch(() => null);
    if (final) {
      const u = final.usage;
      t.tokens = {
        in: u.input_tokens, out: u.output_tokens,
        cache_read: u.cache_read_input_tokens ?? 0, cache_write: u.cache_creation_input_tokens ?? 0,
      };
    }
  }
  t.stages.claude_total = sinceClaude();
  t.at.answer_done = t.since(); // the last attempt, if retried
  if (first) notFound = true; // no text at all
  t.attempts.push({ effort, strict: strictCitations, result: notFound ? "not_found" : !enough ? "thin" : "ok", counts: { ...gate.counts } });

  // thin: Claude answered, but fewer than two sentences survived the gate; nothing was sent.
  return { text, citedChunkIds: [...new Set(cited.map((c) => c.chunkId))], cited, notFound, thin: !notFound && !enough, gateLog: gate.log };
}

/** Source episode cards: cited episodes first, then the next best matches, 3 to 5 in all. */
export function sourceCards(r: Retrieved, cited: Cite[]): Source[] {
  const out: Source[] = [];
  const seen = new Set<string>();
  for (const c of cited) {
    if (seen.has(c.videoId)) continue;
    seen.add(c.videoId);
    out.push(sourceOf(r.episodes.get(c.videoId)!, c.startS, c.endS));
  }
  for (const ch of r.chunks) {
    if (out.length >= 5) break;
    if (out.length >= 3 && cited.length) break;
    if (seen.has(ch.videoId)) continue;
    seen.add(ch.videoId);
    out.push(sourceOf(r.episodes.get(ch.videoId)!, ch.startS, ch.endS));
  }
  return out.slice(0, 5);
}

/* ---------- follow-up questions ---------- */

const FOLLOWUP_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["questions"],
  properties: { questions: { type: "array", items: { type: "string" } } },
};

/** Written from the question and the matched episodes (not the answer), so it runs while the answer streams. */
export async function followups(question: string, r: Retrieved): Promise<string[]> {
  const titles = [...new Set(r.chunks.slice(0, 8).map((c) => r.episodes.get(c.videoId)?.title).filter(Boolean))];
  try {
    const msg = await claude().messages.create({
      model: ASK.model,
      max_tokens: 512,
      thinking: { type: "disabled" },
      output_config: { effort: "low", format: { type: "json_schema", schema: FOLLOWUP_SCHEMA } },
      system: `Suggest 3 short follow-up questions a podcast researcher could ask next about the Figuring Out podcast archive. Each must be answerable from the listed episodes. Write them in ${LANGUAGE_NAME[r.rewritten.language]}, at most 12 words each. Refer to the host in the third person.`,
      messages: [{ role: "user", content: `Question: ${question}\n\nEpisodes:\n${titles.map((t) => `- ${t}`).join("\n")}` }],
    });
    const text = msg.content.find((b) => b.type === "text")?.text ?? "{}";
    return ((JSON.parse(text) as { questions: string[] }).questions ?? []).filter(Boolean).slice(0, 3);
  } catch (e) {
    console.error("follow-ups failed:", e instanceof Error ? e.message : e);
    return [];
  }
}

/* ---------- qa_log ---------- */

export async function logQuestion(row: {
  question: string; language: AskLanguage | null; answer: string; citedChunkIds: number[]; found: boolean;
  firstName: string; visitorId: string | null; latencyMs: number; timings: Timings;
  /** 'brief' for a Prep brief (default: an Ask question, which needs no column). */
  kind?: "brief";
}): Promise<number | null> {
  const original = { question: row.question, answer: row.answer, cited_chunk_ids: row.citedChunkIds, visitor_id: row.visitorId };
  const v2 = { ...original, language: row.language, found: row.found, first_name: row.firstName, latency_ms: row.latencyMs };
  // Newest columns first; until pipeline/sql/qa_log_timings.sql, qa_log_v2.sql and qa_log_kind.sql have run, fall back
  // to fewer. A brief without the kind column is logged as an ordinary row whose question says what it is.
  const attempts = row.kind
    ? [{ ...v2, kind: row.kind, timings: row.timings.toJSON() }, { ...v2, kind: row.kind },
        { ...v2, question: `[${row.kind}] ${row.question}`, timings: row.timings.toJSON() }, { ...v2, question: `[${row.kind}] ${row.question}` },
        { ...original, question: `[${row.kind}] ${row.question}` }]
    : [{ ...v2, timings: row.timings.toJSON() }, v2, original];
  for (const [i, insert] of attempts.entries()) {
    const { data, error } = await db().from("qa_log").insert(insert).select("id").single();
    if (!error) return data.id as number;
    console.error(`qa_log insert failed${i < attempts.length - 1 ? ", retrying with fewer columns" : ""}:`, error.message);
  }
  return null;
}
