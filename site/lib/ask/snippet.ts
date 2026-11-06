import type { Turn } from "./retrieve";

/** The one line of a passage the "Best matching moment" card quotes: the sentence with the strongest query-term match,
    about 120 characters, in the transcript's own language (Roman script for Hindi, as the transcript stores it).
    It works on transcript turns (the lines of the passage), never on the chunk text, whose first line is the
    "Episode: ... | Guest:" header. No model call and no embeddings: a plain match of the question's words. */

const SNIPPET_CHARS = 120;
/** A sentence up to this long is quoted whole. */
const WHOLE_UP_TO = 135;
const MIN_FALLBACK_CHARS = 30;

/** Words that say nothing about the topic (English question words, Hinglish function words, show words). */
const STOP = new Set((
  "a an the is are was were be been being do does did have has had what which who whom whose when where why how you he she it we they me him her us them my your his its our their this that these those " +
  "of in on at to for from by with about as into over after before and or but not no so if then than there here can could would should will shall may might must just also very more most some any all each every " +
  "other such only own same too up down out off again once say says said tell tells told talk talks talked think thinks usually ever guest guests episode episodes show podcast host raj shamani " +
  "ka ke ki ko kya hai hain tha thi the mein me pe par se ne aur ya bhi to toh kaun kaunse kaise kab kyun kahan ye yeh woh wo baare baat ji ek koi kuch jo kehte kehta kahte"
).split(" "));

const WORD = /[\p{L}\p{N}]+/gu;

/** The question's content words (from the question and its English and Hinglish rewrites; the Hindi one is in Devanagari,
    the transcript is not). */
export function queryTerms(question: string, rewritten?: { english: string; hinglish: string }): string[] {
  const out = new Set<string>();
  for (const text of [question, rewritten?.english, rewritten?.hinglish]) {
    for (const w of (text ?? "").toLowerCase().match(WORD) ?? []) {
      if (w.length >= 3 && !STOP.has(w) && !/\p{Script=Devanagari}/u.test(w)) out.add(w);
    }
  }
  return [...out];
}

/** "discipline" also finds "disciplined" and "discipline-based": a long term matches on its first letters. */
const stemOf = (term: string) => (term.length > 6 ? term.slice(0, term.length - 2) : term);

type Candidate = { text: string; startS: number; score: number; first: number };

/** Sentences of a turn. A transcript often has little punctuation, so long runs are cut again by the window below. */
const sentencesOf = (text: string) =>
  text.replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim().split(/(?<=[.?!।])\s+/).filter(Boolean);

/** Score of a sentence: for each distinct query term it contains, the term's length (a longer word is rarer and says
    more), a little more for repeats. `first` is where the first match starts, for the window. */
function scoreOf(sentence: string, stems: { stem: string; weight: number }[]): { score: number; first: number } {
  let score = 0, first = -1;
  const counts = new Map<string, number>();
  for (const m of sentence.toLowerCase().matchAll(WORD)) {
    for (const s of stems) {
      if (m[0].startsWith(s.stem)) {
        counts.set(s.stem, (counts.get(s.stem) ?? 0) + 1);
        if (first < 0 || (m.index ?? 0) < first) first = m.index ?? 0;
      }
    }
  }
  for (const s of stems) {
    const n = counts.get(s.stem) ?? 0;
    if (n) score += s.weight * (1 + 0.25 * Math.min(n - 1, 2));
  }
  return { score, first };
}

/** About SNIPPET_CHARS characters of the sentence around its first match, cut at word boundaries, with "…" where cut. */
function windowed(sentence: string, first: number): string {
  if (sentence.length <= WHOLE_UP_TO) return sentence;
  let start = first > 0 ? Math.max(0, first - 45) : 0;
  if (start > 0) { const sp = sentence.indexOf(" ", start); if (sp >= 0 && sp < first) start = sp + 1; }
  let end = Math.min(sentence.length, start + SNIPPET_CHARS);
  if (end < sentence.length) { const sp = sentence.lastIndexOf(" ", end); if (sp > Math.max(start, first)) end = sp; }
  return `${start > 0 ? "…" : ""}${sentence.slice(start, end).trim()}${end < sentence.length ? "…" : ""}`;
}

/** The best line of these turns for the query terms, and the start of the turn it is in (seconds), or null with no text. */
export function pickSnippet(turns: Pick<Turn, "roman" | "startS">[], terms: string[]): { text: string; startS: number } | null {
  const stems = terms.map((t) => ({ stem: stemOf(t), weight: Math.min(t.length, 12) }));
  let best: Candidate | null = null;
  let fallback: Candidate | null = null;
  for (const turn of turns) {
    for (const sentence of sentencesOf(turn.roman)) {
      const { score, first } = scoreOf(sentence, stems);
      const c = { text: sentence, startS: turn.startS, score, first };
      if (score > 0 && (!best || score > best.score)) best = c;
      // With no match anywhere: the first sentence that is more than a few words.
      if (!fallback && sentence.length >= MIN_FALLBACK_CHARS) fallback = c;
    }
  }
  const pick = best ?? fallback;
  if (!pick) return null;
  return { text: windowed(pick.text, pick.first), startS: pick.startS };
}
