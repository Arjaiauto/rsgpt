import "server-only";
import { allRows, db } from "@/lib/db";
import { timed } from "@/lib/data-log";
import { HOST_WORDS, STOPWORDS, editDistance, fold, romanFold, trigramSimilarity, trigrams } from "./normalize";
import type { EntityMatch, MatchHow, Suggestion, SuggestionKind } from "./types";

/** The search box's suggestions (public.search_suggestions, about 3,800 rows filled by
    pipeline/21_build_search_suggestions.py) in this server's memory, read once and kept for an hour. Matching is done
    here, not in the database: prefix, whole-word and typo-tolerant (edit distance, trigrams) on the text, its folded form
    and its aliases (Devanagari ones too). Used by autocomplete and by the search's first tier. */

type Form = { s: string; words: string[]; grams: Set<string> };
type Entry = { sug: Suggestion; forms: Form[]; boost: number };
type Index = { entries: Entry[]; vocabulary: Set<string>; at: number };

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
      return { s: words.join(" "), words, grams: trigrams(words.join(" ")) };
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

/** Typo allowance for a word of this length. */
const maxEdits = (len: number) => (len >= 8 ? 2 : len >= 4 ? 1 : 0);

type Scored = { score: number; how: MatchHow };

/** How well one stored form matches the query (folded), or null. */
function scoreForm(f: Form, q: string, qWords: string[], kind: SuggestionKind, qGrams: Set<string>): Scored | null {
  if (f.s === q) return { score: 1, how: "exact" };
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
