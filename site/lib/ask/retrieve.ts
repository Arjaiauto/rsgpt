import "server-only";
import { ARCHIVE_RUN_ID, db } from "@/lib/db";
import { guestDisplayName } from "@/lib/guest-name";
import { claude } from "./anthropic";
import { ASK } from "./config";
import type { AskLanguage, Source } from "./types";
import type { Timings } from "./timing";
import { cosine, embedQueries } from "./voyage";

/* ---------- 1. Rewrite: one question, three phrasings ---------- */

export type Rewritten = {
  language: AskLanguage;
  english: string;
  hinglish: string;
  hindi: string;
  /** The question asks for the host's own views (recency weighting applies). */
  hostView: boolean;
};

const REWRITE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["language", "english", "hinglish", "hindi", "host_view"],
  properties: {
    language: { type: "string", enum: ["en", "hi", "hinglish"] },
    english: { type: "string" },
    hinglish: { type: "string" },
    hindi: { type: "string" },
    host_view: { type: "boolean" },
  },
};

const REWRITE_SYSTEM = `You prepare search queries for an archive of transcripts from the Figuring Out podcast, hosted by Raj Shamani. The transcripts mix English, Hindi written in Roman script (Hinglish) and Devanagari Hindi.

Given the user's latest question (and earlier questions in the same conversation, for context), return:
- language: the language the latest question is written in: "en" (English), "hi" (Hindi in Devanagari) or "hinglish" (Hindi or Hindi-English written in Roman script).
- english: the latest question as one standalone English question (resolve "he", "that", "them" from the earlier questions).
- hinglish: the same question in natural Roman-script Hinglish, the way it would be spoken.
- hindi: the same question in Devanagari Hindi.
- host_view: true only if the question asks for the host's (Raj's) own opinion, view or advice; false for questions about guests or topics.

Keep names, brands and numbers as they are.`;

export async function rewrite(question: string, earlier: string[]): Promise<Rewritten> {
  const context = earlier.length ? `Earlier questions:\n${earlier.map((q) => `- ${q}`).join("\n")}\n\n` : "";
  const msg = await claude().messages.create({
    model: ASK.model,
    max_tokens: 1024,
    thinking: { type: "disabled" },
    output_config: { effort: "low", format: { type: "json_schema", schema: REWRITE_SCHEMA } },
    system: REWRITE_SYSTEM,
    messages: [{ role: "user", content: `${context}Latest question:\n${question}` }],
  });
  const text = msg.content.find((b) => b.type === "text")?.text ?? "{}";
  const r = JSON.parse(text) as { language: AskLanguage; english: string; hinglish: string; hindi: string; host_view: boolean };
  return {
    language: r.language,
    english: r.english || question,
    hinglish: r.hinglish || question,
    hindi: r.hindi || question,
    hostView: !!r.host_view,
  };
}

/* ---------- 2. Search: the existing hybrid_search, once per phrasing, then merge ---------- */

type Hit = { id: number; video_id: string; start_s: number; end_s: number; text: string; published_at: string | null; score: number };

export type Candidate = {
  id: number;
  videoId: string;
  startS: number;
  endS: number;
  publishedAt: string | null;
  /** Sum of the fused search scores across phrasings (found by more phrasings ranks higher). */
  score: number;
  /** Best cosine similarity between a phrasing and this chunk. */
  similarity: number;
};

export type Episode = { videoId: string; title: string; publishedAt: string | null; durationS: number | null; hindi: boolean; guests: string[] };

export type Retrieved = {
  rewritten: Rewritten;
  found: boolean;
  bestSimilarity: number;
  chunks: Candidate[];
  episodes: Map<string, Episode>;
  /** Transcript turns of the first ASK.toModel picked chunks, by chunk id. */
  turns: Map<number, Turn[]>;
};

const parseVector = (v: unknown): number[] => (Array.isArray(v) ? (v as number[]) : JSON.parse(String(v)));
const DAY_MS = 86_400_000;

async function search(t: Timings, name: string, text: string, vector: number[], count: number = ASK.perPhrasing): Promise<Hit[]> {
  return t.time(name, async () => {
    const { data, error } = await db().rpc("hybrid_search", { query_embedding: vector, query_text: text, match_count: count });
    if (error) throw new Error(`hybrid_search: ${error.message}`);
    return (data ?? []) as Hit[];
  });
}

/** hybrid_search for plain texts (no question rewrite), merged like retrieve() does: a chunk found by more of the
    texts ranks higher. Used by the Prep brief, which searches for a kind of guest rather than answering a question. */
export async function searchTexts(texts: string[], count: number, t: Timings): Promise<{ chunks: Candidate[]; vectors: number[][] }> {
  const vectors = await t.time("embed", () => embedQueries(texts));
  const results = await Promise.all(texts.map((text, i) => search(t, `search_${i}`, text, vectors[i], count)));
  const byId = new Map<number, Candidate>();
  for (const hits of results) {
    for (const h of hits) {
      const c = byId.get(h.id);
      if (c) c.score += h.score;
      else byId.set(h.id, { id: h.id, videoId: h.video_id, startS: h.start_s, endS: h.end_s, publishedAt: h.published_at, score: h.score, similarity: 0 });
    }
  }
  return { chunks: [...byId.values()].sort((a, b) => b.score - a.score || a.id - b.id), vectors };
}

/** For each group of episodes (a guest's), the chunks closest to any of the vectors: the same scoped search as Ask
    from a guest page, for several guests with one read of their chunks. Scored like hybrid_search (1 / (60 + rank)). */
export async function closestChunks(groups: Map<string, string[]>, vectors: number[][], count: number): Promise<Map<string, Candidate[]>> {
  const all = await loadScoped([...new Set([...groups.values()].flat())]);
  const out = new Map<string, Candidate[]>();
  for (const [key, videoIds] of groups) {
    const mine = new Set(videoIds);
    out.set(key, all.filter((c) => mine.has(c.video_id))
      .map((c) => ({ c, sim: Math.max(...vectors.map((q) => cosine(q, c.vector))) }))
      .sort((a, b) => b.sim - a.sim || a.c.id - b.c.id)
      .slice(0, count)
      .map(({ c, sim }, i) => ({ id: c.id, videoId: c.video_id, startS: c.start_s, endS: c.end_s, publishedAt: c.published_at, score: 1 / (60 + i + 1), similarity: sim })));
  }
  return out;
}

/* ---------- 2b. Search limited to some episodes (a guest's), without the hybrid_search function ---------- */

type ScopedChunk = { id: number; video_id: string; start_s: number; end_s: number; published_at: string | null; vector: number[] };

/** Every chunk of the given episodes with its embedding. A guest has a handful of episodes (a few hundred chunks),
    so comparing a question with all of them is cheap and needs no database function. */
async function loadScoped(videoIds: string[]): Promise<ScopedChunk[]> {
  const out: ScopedChunk[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db().from("chunks").select("id,video_id,start_s,end_s,published_at,embedding")
      .in("video_id", videoIds).order("id").range(from, from + 999);
    if (error) throw new Error(`chunks: ${error.message}`);
    for (const r of data ?? []) {
      out.push({ id: r.id, video_id: r.video_id, start_s: r.start_s, end_s: r.end_s, published_at: r.published_at, vector: parseVector(r.embedding) });
    }
    if ((data?.length ?? 0) < 1000) return out;
  }
}

/** The closest chunks to one phrasing, scored like hybrid_search's rank fusion (1 / (60 + rank)). */
function rankScoped(chunks: ScopedChunk[], vector: number[], count: number): Hit[] {
  return chunks
    .map((c) => ({ c, sim: cosine(vector, c.vector) }))
    .sort((a, b) => b.sim - a.sim || a.c.id - b.c.id)
    .slice(0, count)
    .map(({ c }, i) => ({ id: c.id, video_id: c.video_id, start_s: c.start_s, end_s: c.end_s, text: "", published_at: c.published_at, score: 1 / (60 + i + 1) }));
}

/** `scopeIds` limits the search to those episodes (Ask from a guest page); without it the whole archive is searched.
    `toModel`: how many of the best chunks get their transcript lines loaded (the answer length mode). */
export async function retrieve(question: string, earlier: string[], t: Timings, scopeIds?: string[], toModel: number = ASK.toModel): Promise<Retrieved> {
  const scoped = scopeIds ? loadScoped(scopeIds) : null;
  scoped?.catch(() => {}); // a failure is reported where the chunks are used, not as an unhandled rejection
  // A first question is embedded and searched as asked straight away, while Haiku rewrites it. A follow-up
  // ("what did he say next?") only makes sense once the rewrite has resolved it, so it waits.
  const asAsked = earlier.length || scoped
    ? null
    : t.time("embed_question", () => embedQueries([question]))
        .then(async ([vector]) => ({ vector, hits: await search(t, "search_question", question, vector) }));
  // The lines of its best chunks are fetched at once too: most of them end up among the picked chunks, and
  // reading an episode's lines from cold storage is the slow part of loading them.
  const prefetch = asAsked?.then(({ hits }) => {
    const top = hits.slice(0, toModel).map((h) => ({ id: h.id, videoId: h.video_id, startS: h.start_s, endS: h.end_s }));
    return { ids: new Set(top.map((c) => c.id)), turns: loadTurns(top) };
  });
  // If the rewrite fails first, the request fails as before; this keeps the early work from unhandled rejections.
  prefetch?.then((p) => p.turns).catch(() => {});

  const rewritten = await t.time("rewrite", () => rewrite(question, earlier));
  // The other phrasings, embedded in one Voyage request. The phrasing in the question's own language is close to
  // the question as asked, so it is skipped when the question was searched as asked.
  const all = [
    { lang: "en", text: rewritten.english },
    { lang: "hinglish", text: rewritten.hinglish },
    { lang: "hi", text: rewritten.hindi },
  ];
  const phrasings = asAsked ? all.filter((p) => p.lang !== rewritten.language) : all;
  const vectors = await t.time("embed", () => embedQueries(phrasings.map((p) => p.text)));
  const [first, ...results] = await Promise.all([
    asAsked,
    ...phrasings.map((p, i) => scoped
      ? t.time(`search_${p.lang}`, async () => rankScoped(await scoped, vectors[i], ASK.perPhrasing))
      : search(t, `search_${p.lang}`, p.text, vectors[i])),
  ]);
  if (first) { results.push(first.hits); vectors.push(first.vector); }

  const byId = new Map<number, Candidate>();
  for (const hits of results) {
    for (const h of hits) {
      const c = byId.get(h.id);
      if (c) c.score += h.score;
      else byId.set(h.id, { id: h.id, videoId: h.video_id, startS: h.start_s, endS: h.end_s, publishedAt: h.published_at, score: h.score, similarity: 0 });
    }
  }
  t.mark("searched");
  if (!byId.size) return { rewritten, found: false, bestSimilarity: 0, chunks: [], episodes: new Map(), turns: new Map() };

  // Host-view questions favour recent episodes.
  const now = Date.now();
  const weight = (c: Candidate) => {
    if (!rewritten.hostView || !c.publishedAt) return 1;
    const ageDays = Math.max(0, (now - Date.parse(c.publishedAt)) / DAY_MS);
    return Math.pow(0.5, ageDays / ASK.hostViewHalfLifeDays);
  };
  const ranked = [...byId.values()]
    .map((c) => ({ ...c, score: c.score * weight(c) }))
    .sort((a, b) => b.score - a.score || a.id - b.id);
  // Limited to a few episodes, the best chunks may all come from one of them, so more per episode are kept.
  const maxPerEpisode = scoped ? ASK.toModel : ASK.maxPerEpisode;
  const perEpisode = new Map<string, number>();
  const picked: Candidate[] = [];
  for (const c of ranked) {
    const n = perEpisode.get(c.videoId) ?? 0;
    if (n >= maxPerEpisode) continue;
    perEpisode.set(c.videoId, n + 1);
    picked.push(c);
    if (picked.length >= ASK.merged) break;
  }

  // At the same time: absolute relevance (cosine similarity of each stored chunk embedding to the closest
  // phrasing), the episodes with their verified guests (final run), and the transcript lines of the chunks
  // that go to the model.
  const videoIds = [...new Set(picked.map((c) => c.videoId))];
  const [embs, eps, gs, turns] = await Promise.all([
    t.time("similarity", async () => db().from("chunks").select("id,embedding").in("id", picked.map((c) => c.id))),
    t.time("episodes", async () => db().from("episodes").select("video_id,title,published_at,duration_seconds,caption_language,status").in("video_id", videoIds)),
    t.time("guests", async () => db().from("guests").select("video_id,name").in("video_id", videoIds).eq("verified", true).eq("run_id", ARCHIVE_RUN_ID)),
    t.time("lines", async () => {
      const early = await prefetch;
      const [pre, rest] = await Promise.all([
        early?.turns ?? new Map<number, Turn[]>(),
        loadTurns(picked.slice(0, toModel).filter((c) => !early?.ids.has(c.id))),
      ]);
      return new Map([...pre, ...rest]);
    }),
  ]);
  if (embs.error) throw new Error(`chunk embeddings: ${embs.error.message}`);
  if (eps.error) throw new Error(`episodes: ${eps.error.message}`);
  const byPicked = new Map(picked.map((c) => [c.id, c]));
  for (const row of embs.data ?? []) {
    const v = parseVector(row.embedding);
    byPicked.get(row.id as number)!.similarity = Math.max(...vectors.map((q) => cosine(q, v)));
  }
  const guestsOf = new Map<string, string[]>();
  for (const g of gs.data ?? []) {
    const list = guestsOf.get(g.video_id as string) ?? [];
    if (!list.includes(g.name as string)) list.push(g.name as string);
    guestsOf.set(g.video_id as string, list);
  }
  // Transcribed episodes only.
  const episodes = new Map<string, Episode>();
  for (const e of eps.data ?? []) {
    if (e.status !== "transcribed") continue;
    episodes.set(e.video_id, {
      videoId: e.video_id, title: e.title, publishedAt: e.published_at, durationS: e.duration_seconds,
      hindi: e.caption_language === "hi", guests: guestsOf.get(e.video_id) ?? [],
    });
  }

  const chunks = picked.filter((c) => episodes.has(c.videoId));
  const bestSimilarity = chunks.reduce((m, c) => Math.max(m, c.similarity), 0);
  return { rewritten, found: bestSimilarity >= ASK.minSimilarity, bestSimilarity, chunks, episodes, turns };
}

/* ---------- 3. The transcript lines behind the chunks, grouped into citable turns ---------- */

export type Turn = {
  speaker: "raj" | "guest" | "unknown";
  startS: number;
  endS: number;
  segmentIds: number[];
  roman: string;
  english: string;
};

/** The lines of all the chunks in one query (and their English translations, for Hindi episodes, in one more),
    grouped into turns per chunk. A chunk is about 90 seconds (about 40 lines), so this stays far under the
    1,000-row limit of a Supabase query. */
export async function loadTurns(chunks: Pick<Candidate, "id" | "videoId" | "startS" | "endS">[]): Promise<Map<number, Turn[]>> {
  const out = new Map<number, Turn[]>();
  if (!chunks.length) return out;
  const within = chunks.map((c) => `and(video_id.eq.${c.videoId},start_s.gte.${c.startS},start_s.lt.${c.endS})`).join(",");
  const [seg, tr] = await Promise.all([
    db().from("segments").select("id,video_id,seq,start_s,end_s,speaker,text_roman").or(within).order("video_id").order("seq"),
    db().from("translation_segments").select("video_id,start_s,text").or(within),
  ]);
  if (seg.error) throw new Error(`segments: ${seg.error.message}`);
  if (tr.error) throw new Error(`translations: ${tr.error.message}`);
  const english = new Map<string, string>();
  for (const x of tr.data ?? []) english.set(`${x.video_id}@${(x.start_s as number).toFixed(2)}`, x.text as string);

  for (const chunk of chunks) {
    const turns: Turn[] = [];
    for (const s of seg.data ?? []) {
      if (s.video_id !== chunk.videoId || s.start_s < chunk.startS || s.start_s >= chunk.endS) continue;
      const last = turns[turns.length - 1];
      const en = english.get(`${s.video_id}@${(s.start_s as number).toFixed(2)}`) ?? "";
      if (last && last.speaker === s.speaker && s.start_s - last.startS < ASK.maxTurnSeconds) {
        last.endS = s.end_s; last.segmentIds.push(s.id); last.roman += " " + s.text_roman;
        if (en) last.english += (last.english ? " " : "") + en;
      } else {
        turns.push({ speaker: s.speaker, startS: s.start_s, endS: s.end_s, segmentIds: [s.id], roman: s.text_roman, english: en });
      }
    }
    out.set(chunk.id, turns);
  }
  return out;
}

/* ---------- display helpers ---------- */

export const monthYear = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "Asia/Kolkata" }) : "";

export const guestLabel = (ep: Episode) => guestDisplayName(ep.guests, ep.title);

export function sourceOf(ep: Episode, startS: number, endS: number): Source {
  return { videoId: ep.videoId, episode: ep.title, guest: guestLabel(ep), date: monthYear(ep.publishedAt), durationS: ep.durationS, startS, endS };
}
