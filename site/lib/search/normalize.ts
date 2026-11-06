/** Text normalisation for the search box (Ticket 27). Pure: no database, safe on the server and in the browser.

    fold() is the same fold pipeline/21_build_search_suggestions.py stores in search_suggestions.folded, so a typed query
    and the stored suggestions compare like for like. */

/** Lower case, Latin accents out, punctuation and symbols to spaces (letters, marks and digits of every script stay, so
    Devanagari keeps its vowel signs), one space between words. */
export function fold(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export const hasDevanagari = (text: string) => /\p{Script=Devanagari}/u.test(text);

/** Words that say nothing about what is searched for: English and Hinglish function words, question words, and words
    every passage has (the show, the host). The same list hybrid_search drops (pipeline/sql/search_v3.sql), plus the
    host's surname: every episode is "with Raj Shamani", so his name never picks out an episode or a passage. */
export const STOPWORDS = new Set((
  "a an the is are was were be been being do does did have has had what which who whom whose when where why how " +
  "you he she it we they me him her us them my your his its our their this that these those of in on at to for from by " +
  "with about as into over after before and or but not no so if then than there here can could would should will shall " +
  "may might must just also very more most some any all each every other such only own same too up down out off again " +
  "once say says said talk talks talked usually ever i am im " +
  "ka ke ki ko kya hai hain tha thi mein pe par se ne aur ya bhi toh kaun kaunse kaise kab kyun kahan ye yeh woh wo " +
  "baare baat ji ek koi kuch jo " +
  "raj shamani guest guests episode episodes show podcast figuring"
).split(" "));

/** The host's name: not a stopword for a guest called Raj, but never a reason to match an episode title. */
export const HOST_WORDS = new Set(["raj", "shamani"]);

/** Words of a folded text that carry meaning (stopwords out). */
export const contentWords = (folded: string): string[] => folded.split(" ").filter((w) => w && !STOPWORDS.has(w));

const QUESTION_START = /^(how|what|why|when|who|which|where|whom|whose|is|are|can|should|does|do|did|kya|kaise|kyun|kyon|kab|kaun|kahan|kitna|kitne)\b/;

/** A question ("how to raise money", "what is an ipo?", "kaise start kare") is answered, never treated as vague. */
export const isQuestion = (raw: string): boolean => /[?？]\s*$/.test(raw.trim()) || QUESTION_START.test(fold(raw));

/* ---------- Devanagari -> Roman, for looking words up in the (Roman) vocabulary only ---------- */

const CONSONANTS: Record<string, string> = {
  "क": "k", "ख": "kh", "ग": "g", "घ": "gh", "ङ": "n", "च": "ch", "छ": "chh", "ज": "j", "झ": "jh", "ञ": "n",
  "ट": "t", "ठ": "th", "ड": "d", "ढ": "dh", "ण": "n", "त": "t", "थ": "th", "द": "d", "ध": "dh", "न": "n",
  "प": "p", "फ": "ph", "ब": "b", "भ": "bh", "म": "m", "य": "y", "र": "r", "ल": "l", "व": "v", "श": "sh",
  "ष": "sh", "स": "s", "ह": "h", "ळ": "l",
};
/** Nukta forms, written precomposed or as consonant + ़. */
const NUKTA: Record<string, string> = { "क": "q", "ख": "kh", "ग": "g", "ज": "z", "ड": "d", "ढ": "rh", "फ": "f", "य": "y" };
const PRECOMPOSED: Record<string, string> = { "क़": "q", "ख़": "kh", "ग़": "g", "ज़": "z", "ड़": "d", "ढ़": "rh", "फ़": "f", "य़": "y" };
const VOWELS: Record<string, string> = {
  "अ": "a", "आ": "a", "इ": "i", "ई": "i", "उ": "u", "ऊ": "u", "ऋ": "ri", "ए": "e", "ऐ": "ai", "ओ": "o", "औ": "au", "ऑ": "o",
};
const SIGNS: Record<string, string> = {
  "ा": "a", "ि": "i", "ी": "i", "ु": "u", "ू": "u", "ृ": "ri", "े": "e", "ै": "ai", "ो": "o", "ौ": "au", "ॉ": "o", "ॅ": "e",
};
const VIRAMA = "्", NUKTA_SIGN = "़";

/** A Roman spelling of Devanagari text, by rules: the way Hinglish is typed (अघोरी -> aghori, राज शमानी -> raj shamani,
    स्टार्टअप -> startap). Long and short vowels are written alike and a word-final inherent "a" is dropped. Only to look a
    Devanagari query up in the Roman vocabulary (chunk_terms, the suggestions); never shown. Other text passes through. */
export function devanagariToRoman(text: string): string {
  const chars = [...text.normalize("NFC")];
  let out = "";
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const pre = PRECOMPOSED[c];
    const base = pre ?? CONSONANTS[c];
    if (base !== undefined) {
      let roman = base;
      let j = i + 1;
      if (!pre && chars[j] === NUKTA_SIGN) { roman = NUKTA[c] ?? base; j++; }
      const next = chars[j];
      if (next === VIRAMA) { out += roman; i = j; continue; }
      if (next !== undefined && SIGNS[next] !== undefined) { out += roman + SIGNS[next]; i = j; continue; }
      // The inherent vowel: kept inside a word, dropped at its end (कमल -> kamal, राम -> ram) and before a vowel letter
      // (स्टार्टअप -> startap).
      const bare = next === undefined || !/\p{Script=Devanagari}/u.test(next) || next === "ः" || VOWELS[next] !== undefined;
      out += bare ? roman : roman + "a";
      i = j - 1;
      continue;
    }
    if (VOWELS[c] !== undefined) { out += VOWELS[c]; continue; }
    if (c === "ं" || c === "ँ") { out += "n"; continue; }
    if (c === "ः") { out += "h"; continue; }
    if (c === VIRAMA || c === NUKTA_SIGN || c === "।" || c === "॥") { out += c === "।" || c === "॥" ? " " : ""; continue; }
    if (/[०-९]/.test(c)) { out += String(c.charCodeAt(0) - 0x0966); continue; }
    out += c;
  }
  return out;
}

/** The query as the Roman vocabulary sees it: folded, with any Devanagari spelled in Roman letters. */
export const romanFold = (text: string): string => fold(hasDevanagari(text) ? devanagariToRoman(text) : text);

/* ---------- small string measures, for the in-memory suggestion index ---------- */

/** Trigrams of a word with padding, as pg_trgm makes them ("  w", " wo", "wor", "ord", "rd "). */
export function trigrams(word: string): Set<string> {
  const s = `  ${word} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= s.length; i++) out.add(s.slice(i, i + 3));
  return out;
}

/** Trigram similarity of two sets, as pg_trgm's similarity(): shared / (all distinct). */
export function trigramSimilarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const g of a) if (b.has(g)) shared++;
  return shared / (a.size + b.size - shared);
}

/** Levenshtein distance, stopping early once it is over `max` (returns max + 1 then). */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}
