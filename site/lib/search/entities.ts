import "server-only";
import { allRows, db } from "@/lib/db";
import { timed } from "@/lib/data-log";
import { VAGUE } from "./vague";
import { totalChunks } from "./stats";
import { HOST_WORDS, STOPWORDS, editDistance, fold, romanFold, trigramSimilarity, trigrams } from "./normalize";
import type { EntityMatch, MatchHow, Suggestion, SuggestionKind } from "./types";

/** The search box's suggestions (public.search_suggestions, about 3,800 rows filled by
    pipeline/21_build_search_suggestions.py) in this server's memory, read once and kept for an hour. Matching is done
    here, not in the database: prefix, whole-word and typo-tolerant (edit distance, trigrams) on the text, its folded form
    and its aliases (Devanagari ones too). Used by autocomplete and by the search's first tier. */

/** `alias`: a spelling other than the suggestion's own text (a Devanagari spelling, a Hinglish or typo form, a variant name). */
type Form = { s: string; words: string[]; grams: Set<string>; alias: boolean };
type Entry = { sug: Suggestion; forms: Form[]; boost: number };
export type EntityIndex = { entries: Entry[]; vocabulary: Set<string>; at: number };
type Index = EntityIndex;

const TTL_MS = 60 * 60 * 1000;
const holder = globalThis as { __searchIndex?: { index: Index | null; loading: Promise<Index> | null } };
holder.__searchIndex ??= { index: null, loading: null };

/** Episode and clip titles: the host's name and the episode number ("FO547") are in nearly every title, so they never
    count as a match ("raj shamani" must not find every episode). */
const titleWord = (kind: SuggestionKind) => (w: string) =>
  !(kind === "episode" || kind === "clip") || (!HOST_WORDS.has(w) && !/^fo\d+$/.test(w));

async function load(): Promise<Index> {
  const rows = await timed("search suggestions", () => allRows<{ kind: SuggestionKind; ref: string; text: string; folded: string; aliases: string[] | null; aliases_ai: string[] | null; aliases_folded: string[] | null; weight: number }>((a, b) =>
    db().from("search_suggestions").select("kind,ref,text,folded,aliases,aliases_ai,aliases_folded,weight").order("id").range(a, b)));
  // A small boost for the heavier rows of each kind (views, guests per topic...), on a log scale: it only breaks ties.
  const maxLog = new Map<SuggestionKind, number>();
  for (const r of rows) maxLog.set(r.kind, Math.max(maxLog.get(r.kind) ?? 0, Math.log1p(Math.max(0, r.weight))));
  const vocabulary = new Set<string>();
  const entries = rows.map((r): Entry => {
    const keep = titleWord(r.kind);
    const strings = [...new Set([r.folded, ...(r.aliases_folded ?? [])].filter(Boolean))];
    const forms = strings.map((s) => {
      const words = s.split(" ").filter(keep);
      for (const w of words) if (!/^\d+$/.test(w)) vocabulary.add(w);
      return { s: words.join(" "), words, grams: trigrams(words.join(" ")), alias: s !== r.folded };
    }).filter((f) => f.s);
    const top = maxLog.get(r.kind) || 1;
    return {
      sug: { kind: r.kind, ref: r.ref, text: r.text, folded: r.folded, aliases: [...(r.aliases ?? []), ...(r.aliases_ai ?? [])], weight: r.weight },
      forms, boost: 0.05 * (Math.log1p(Math.max(0, r.weight)) / top),
    };
  });
  return { entries, vocabulary, at: Date.now() };
}

/** The index, loaded once per server and again after an hour (the old one is kept if a reload fails). */
export async function getEntityIndex(): Promise<Index> {
  const h = holder.__searchIndex!;
  if (h.index && Date.now() - h.index.at < TTL_MS) return h.index;
  h.loading ??= load()
    .then((ix) => { h.index = ix; return ix; })
    .catch((e) => { if (h.index) { console.error("search suggestions reload failed:", e instanceof Error ? e.message : e); return h.index; } throw e; })
    .finally(() => { h.loading = null; });
  return h.index && Date.now() - h.index.at < TTL_MS * 2 ? h.index : h.loading;
}

/* ---------- rare-word vocabulary: words of the transcripts as low-weight "term" suggestions ---------- */

/** Words people may type that no guest, topic or title is called ("aghori", "kumbh"): the words of public.chunk_terms that are
    4 or more letters, letters only, not stopwords, in at least 2 passages and in fewer than the common-word share (1.5%) of
    all passages. Kept sorted for prefix search, with each word's passage count; loaded a little after the suggestion index
    (about 55,000 rows are read, 4 requests at a time) and kept an hour. */
export type Vocabulary = { words: string[]; counts: number[]; at: number };
const vocabHolder = globalThis as { __searchVocab?: { vocab: Vocabulary | null; loading: Promise<Vocabulary | null> | null } };
vocabHolder.__searchVocab ??= { vocab: null, loading: null };
export const VOCAB = { minLength: 4, minChunks: 2, minPrefix: 3 } as const;

async function loadVocabulary(): Promise<Vocabulary> {
  const total = await totalChunks();
  const cutoff = Math.max(3, Math.floor(total * VAGUE.minShare));
  const rows = await timed("search vocabulary", () => allRows<{ word: string; chunk_count: number }>((a, b) =>
    db().from("chunk_terms").select("word,chunk_count").gte("chunk_count", VOCAB.minChunks).lt("chunk_count", cutoff).order("word").range(a, b)));
  const kept = rows.filter((r) => r.word.length >= VOCAB.minLength && /^[a-z]+$/.test(r.word) && !STOPWORDS.has(r.word) && !HOST_WORDS.has(r.word));
  kept.sort((x, y) => (x.word < y.word ? -1 : x.word > y.word ? 1 : 0));
  return { words: kept.map((r) => r.word), counts: kept.map((r) => r.chunk_count), at: Date.now() };
}

/** The vocabulary if it is loaded (the first call starts loading it and returns null; suggestions go without it until then). */
export function peekVocabulary(): Vocabulary | null {
  const h = vocabHolder.__searchVocab!;
  const fresh = h.vocab && Date.now() - h.vocab.at < TTL_MS;
  if (!fresh && !h.loading) {
    h.loading = loadVocabulary()
      .then((v) => { h.vocab = v; return v; })
      .catch((e) => { console.error("search vocabulary load failed:", e instanceof Error ? e.message : e); return h.vocab; })
      .finally(() => { h.loading = null; });
  }
  return h.vocab;
}

/** The loading vocabulary, waited for (the test script and warm-up). */
export async function getVocabulary(): Promise<Vocabulary | null> {
  peekVocabulary();
  return vocabHolder.__searchVocab!.loading ?? vocabHolder.__searchVocab!.vocab;
}

/** Words starting with the prefix, the ones in the most passages first. */
export function vocabularyMatches(v: Vocabulary, prefix: string, limit: number): { word: string; count: number }[] {
  if (prefix.length < VOCAB.minPrefix) return [];
  let lo = 0, hi = v.words.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (v.words[mid] < prefix) lo = mid + 1; else hi = mid; }
  const found: { word: string; count: number }[] = [];
  for (let i = lo; i < v.words.length && v.words[i].startsWith(prefix); i++) found.push({ word: v.words[i], count: v.counts[i] });
  return found.sort((a, b) => b.count - a.count || a.word.localeCompare(b.word)).slice(0, limit);
}

const titleMaps = new WeakMap<Index, Map<string, string>>();
/** Episode titles by video id, from the episode suggestions (every transcribed episode has one). */
export function episodeTitles(ix: Index): Map<string, string> {
  let m = titleMaps.get(ix);
  if (!m) {
    m = new Map(ix.entries.filter((e) => e.sug.kind === "episode").map((e) => [e.sug.ref, e.sug.text]));
    titleMaps.set(ix, m);
  }
  return m;
}

const topicMaps = new WeakMap<Index, Map<string, string>>();
/** Topic labels by key (lower-case sector tag), from the topic suggestions. */
export function topicLabels(ix: Index): Map<string, string> {
  let m = topicMaps.get(ix);
  if (!m) {
    m = new Map(ix.entries.filter((e) => e.sug.kind === "topic").map((e) => [e.sug.ref, e.sug.text]));
    topicMaps.set(ix, m);
  }
  return m;
}

/** Is this word in a suggestion's text or alias (a guest, topic, title or curated term)? */
export const inVocabulary = (ix: Index, word: string) => ix.vocabulary.has(word);

/** Typo allowance for a word of this length: none under 5 letters, where one letter apart is usually another word
    ("nikh" is not "nike"); words that short are corrected by correct.ts against the transcripts instead. */
const maxEdits = (len: number) => (len >= 9 ? 2 : len >= 5 ? 1 : 0);

type Scored = { score: number; how: MatchHow };

/** How well one stored form matches the query (folded), or null. */
function scoreForm(f: Form, q: string, qWords: string[], kind: SuggestionKind, qGrams: Set<string>): Scored | null {
  if (f.s === q) return { score: 1, how: "exact" };
  // A spelling under 3 characters ("ai", "a i") is only ever matched whole, and a query under 3 characters only finds a
  // suggestion by its own text or an alias that is exactly it: "ai" must not pull in a guest through a longer alias such
  // as "Madhav Seth AI Plus".
  if (f.alias && (f.s.length < 3 || q.length < 3)) return null;
  if (q.length >= 2 && f.s.startsWith(q) && (q.length >= 3 || f.s.startsWith(q + " "))) {
    return { score: 0.85 + 0.1 * (q.length / f.s.length), how: "prefix" };
  }
  if (!qWords.length) return null;
  // Every content word of the query is a word of the form (the last one may be the start of a word while typing).
  let exactWords = 0, fuzzyWords = 0;
  for (let i = 0; i < qWords.length; i++) {
    const w = qWords[i], last = i === qWords.length - 1;
    if (f.words.includes(w) || (last && w.length >= 3 && f.words.some((x) => x.startsWith(w)))) { exactWords++; continue; }
    const k = maxEdits(w.length);
    if (k && f.words.some((x) => x.length >= 3 && editDistance(w, x, k) <= k)) { fuzzyWords++; continue; }
    // Titles must contain every word; a name or topic may miss a short filler word.
    if (kind === "episode" || kind === "clip" || w.length > 3) return null;
  }
  const matched = exactWords + fuzzyWords;
  if (!matched) return null;
  if (!fuzzyWords) return { score: 0.7 + 0.1 * Math.min(1, qWords.join(" ").length / f.s.length), how: "word" };
  // With a typo: also the whole-string trigram similarity, so a misspelt name still ranks by how close it is overall.
  const sim = trigramSimilarity(qGrams, f.grams);
  return { score: 0.5 + 0.15 * (matched / qWords.length) + 0.1 * sim, how: "fuzzy" };
}

export type MatchOptions = { kinds?: SuggestionKind[]; perKind?: number; minScore?: number };

/** Suggestions matching the query, best first: the typed text and, for Devanagari, its Roman spelling too. */
export function matchEntities(ix: Index, query: string, opts: MatchOptions = {}): EntityMatch[] {
  const perKind = opts.perKind ?? 8, minScore = opts.minScore ?? 0.5;
  const variants = [...new Set([fold(query), romanFold(query)])].filter(Boolean);
  if (!variants.length) return [];
  const prepared = variants.map((q) => ({ q, words: q.split(" ").filter((w) => w && !STOPWORDS.has(w)), grams: trigrams(q) }));
  const best: EntityMatch[] = [];
  for (const e of ix.entries) {
    if (opts.kinds && !opts.kinds.includes(e.sug.kind)) continue;
    const keep = titleWord(e.sug.kind);
    let top: Scored | null = null;
    for (const p of prepared) {
      const words = p.words.filter(keep);
      for (const f of e.forms) {
        const s = scoreForm(f, p.q, words, e.sug.kind, p.grams);
        if (s && (!top || s.score > top.score)) top = s;
      }
    }
    if (top && top.score >= minScore) best.push({ s: e.sug, score: Math.min(1, top.score) + e.boost, how: top.how });
  }
  best.sort((a, b) => b.score - a.score || b.s.weight - a.s.weight);
  const count = new Map<SuggestionKind, number>();
  return best.filter((m) => {
    const n = count.get(m.s.kind) ?? 0;
    count.set(m.s.kind, n + 1);
    return n < perKind;
  });
}
