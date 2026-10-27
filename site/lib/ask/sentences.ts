/** Rule 2 on Ask answers, sentence by sentence (CLAUDE.md: every claim shown must point to the transcript).
    Claude's answer arrives as text blocks, some carrying citations; a sentence can span several blocks and a block
    several sentences. The gate rebuilds whole sentences and shows only those that carry a citation, plus a short
    connective opener ("Two guests spoke about this.") when a cited sentence follows it. Verbatim copies of the
    transcript are dropped; when one directly follows an uncited claim, the claim is shown with its citation (Claude
    often writes the claim, then the line behind it); likewise an uncited sentence naming someone is shown together
    with the cited sentence after it when that person speaks in its cited lines. A sentence naming the host or a
    guest is dropped when none of its cited lines is spoken by them. A cited sentence that
    opens with a pronoun right after a drop is dropped too unless it cites the same episode as the sentence shown
    before it, so "He said…" never points at the wrong person. Shown sentences are held
    back until `minCited` cited ones are in hand, so a thin answer is never shown and can be retried. */

const ABBREVIATION = /(?:^|[\s(.])(?:dr|mr|mrs|ms|prof|col|lt|gen|capt|maj|st|sr|jr|vs|rs|etc|inc|ltd|co|no|\p{Lu})\.$/iu;
const ENDS = /[.!?।]["”'’)]*$/;

/** Splits after sentence ends (end punctuation followed by whitespace, or any paragraph break), keeping that
    whitespace with the sentence before it. "Dr.", "Rs." and initials ("T.V.") don't end a sentence. The last part
    may be unfinished. */
export function splitSentences(text: string): string[] {
  const parts: string[] = [];
  const re = /[.!?।]["”'’)]*(\s+)|\S(\s*\n\s*\n\s*)/g;
  let start = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const end = m.index + m[0].length;
    const space = m[1] ?? m[2];
    if (m[1] !== undefined && !space.includes("\n\n") && ABBREVIATION.test(text.slice(start, end - space.length))) continue;
    parts.push(text.slice(start, end));
    start = end;
  }
  if (start < text.length) parts.push(text.slice(start));
  return parts;
}

const complete = (part: string) => {
  if (/\S\s*\n\s*\n\s*$/.test(part)) return true;
  const body = part.trimEnd();
  return ENDS.test(body) && !ABBREVIATION.test(body);
};

const norm = (s: string) => s.toLowerCase().normalize("NFKC").replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();

/** Words in a row a sentence may share with the transcript it cites ("do not quote more than a few words"). */
const MAX_QUOTED_RUN = 9;

/** A sentence (3+ words) that is a verbatim copy of the transcript it cites, or quotes 10+ words of it in a row. */
export function isCopy(sentence: string, citedTexts: string[]): boolean {
  const n = norm(sentence);
  const source = norm(citedTexts.join(" "));
  const words = n.split(" ");
  if (words.length >= 3 && source.includes(n)) return true;
  const padded = ` ${source} `;
  for (let i = 0; i + MAX_QUOTED_RUN < words.length; i++) {
    if (padded.includes(` ${words.slice(i, i + MAX_QUOTED_RUN + 1).join(" ")} `)) return true;
  }
  return false;
}

/** Under 12 words, no digits and no names: no capitalised word after the first, no word of a known name
    (guests, the host). Devanagari has no capitals, so a Hindi connective must also be short (6 words). */
export function isConnective(sentence: string, nameWords: Set<string>): boolean {
  const words = sentence.trim().split(/\s+/);
  if (words.length >= 12 || /\p{N}/u.test(sentence)) return false;
  if (words.some((w) => nameWords.has(norm(w)))) return false;
  if (words.slice(1).some((w) => /^\p{Lu}/u.test(w.replace(/^[^\p{L}]+/u, "")))) return false;
  if (/[ऀ-ॿ]/.test(sentence) && words.length > 6) return false;
  return true;
}

/** The words of the names that make a sentence a claim about someone (3+ letters, lower case). */
export function nameWordsOf(names: string[]): Set<string> {
  return new Set(names.flatMap((n) => norm(n).split(" ")).filter((w) => w.length >= 3));
}

/** A sentence opening with a pronoun ("He said…", "Unhone bataya…") leans on the sentence before it. */
const PRONOUN_START = /^(?:he|she|they|his|her|their|him|them|unhone|unhonne|unka|unke|unki|unko|unhe|unhein|woh|wo|ve|inhone|inka|inke|उन्होंने|उनका|उनके|उनकी|उन्हें|वह|वे|इन्होंने)(?=[\s,.'’]|$)/iu;

/** Titles and placeholders that are not part of what identifies a person in a sentence. */
const NOT_NAME_WORDS = new Set(["guest", "guests", "the", "and", "mrs", "prof", "col", "capt", "maj", "gen", "sir", "adv", "founder", "ceo"]);

/** Someone an answer sentence can name: the words of their name, and whether a cited passage has a line by them. */
export type Person<C> = { name: string; words: Set<string>; spokeIn: (cite: C) => boolean };

export function personWords(name: string): Set<string> {
  return new Set(norm(name).split(" ").filter((w) => w.length >= 3 && !NOT_NAME_WORDS.has(w)));
}

/** A sentence that names people (the host, a guest) must cite at least one line spoken by one of them; a sentence
    naming no one passes. ("Raj ne Mohandas Pai ke episode mein bataya…" names both, and a cited line by the host
    is enough.) */
export function speakerCheck<C>(people: Person<C>[]): (sentence: string, cites: C[]) => boolean {
  return (sentence, cites) => {
    const words = new Set(norm(sentence).split(" "));
    const named = people.filter((p) => [...p.words].some((w) => words.has(w)));
    return !named.length || named.some((p) => cites.some((c) => p.spokeIn(c)));
  };
}

type Building<C> ={ text: string; cites: C[]; citedTexts: string[] };
const empty = <C>(): Building<C> => ({ text: "", cites: [], citedTexts: [] });

export class SentenceGate<C> {
  /** Sentences shown, cited sentences among them, uncited sentences dropped, copies of the transcript dropped,
      cited sentences dropped because their pronoun would point at the wrong person (orphans) or because the person
      they name speaks in none of the cited lines (speaker_mismatch), uncited introductions shown together with
      the cited sentence after them (paired), connectives kept. */
  readonly counts = { shown: 0, cited: 0, dropped: 0, copies: 0, orphans: 0, speaker_mismatch: 0, paired: 0, connectives: 0 };
  /** Every decision, for the development debug output. */
  readonly log: string[] = [];
  private cur: Building<C> = empty();
  private connectives: { body: string; trailing: string }[] = [];
  private held: { text: string; cites: C[] }[] = [];
  /** Whitespace owed before the next shown sentence (" ", or "\n\n" to start a paragraph). */
  private gap = "";
  private started = false;
  /** Whether a sentence was dropped since the last one shown, and the episode the last shown one cites. */
  private droppedSince = false;
  private lastEpisode: string | null = null;
  /** Episodes whose guest (or the host) a shown sentence has named. */
  private readonly named = new Set<string>();

  private readonly send: (text: string, cites: C[]) => void;
  private readonly nameWords: Set<string>;
  private readonly episodeOf: (cite: C) => string;
  private readonly speakerOk: (sentence: string, cites: C[]) => boolean;
  private readonly minCited: number;

  constructor(o: {
    /** Shows one sentence, followed by its citations. */
    send: (text: string, cites: C[]) => void;
    /** Words of the host's and guests' names (nameWordsOf). */
    nameWords: Set<string>;
    episodeOf: (cite: C) => string;
    /** False when the sentence names someone who speaks in none of its cited lines (speakerCheck). */
    speakerOk: (sentence: string, cites: C[]) => boolean;
    minCited: number;
  }) {
    this.send = o.send;
    this.nameWords = o.nameWords;
    this.episodeOf = o.episodeOf;
    this.speakerOk = o.speakerOk;
    this.minCited = o.minCited;
  }

  /** One finished text block of the answer, with the citations Claude attached to it. Every sentence the block
      touches carries its citations. */
  block(text: string, cites: C[], citedTexts: string[]): void {
    // A block that starts a new paragraph also ends the sentence before it.
    if (/^\s*\n\s*\n/.test(text) && this.cur.text.trim()) this.finish();
    for (const part of splitSentences(text)) {
      this.cur.text += part;
      for (const c of cites) if (!this.cur.cites.includes(c)) this.cur.cites.push(c);
      this.cur.citedTexts.push(...citedTexts);
      if (complete(part)) this.finish();
    }
  }

  /** The answer is complete. Returns false when it has fewer than `minCited` cited sentences (nothing was shown). */
  end(): boolean {
    this.finish();
    this.dropParaphrase();
    this.drop("opener at the end", this.connectives);
    return this.counts.cited >= this.minCited;
  }

  /** Drops openers with nothing cited after them, or leading into a dropped sentence. */
  private drop(why: string, openers: { body: string }[]): void {
    for (const c of openers.splice(0)) { this.counts.dropped += 1; this.log.push(`- ${why}: ${c.body}`); }
  }

  /** The last uncited sentence, kept for one more sentence: Claude often writes a claim in its own words and then
      the transcript line behind it as a separate cited sentence. If a verbatim copy follows, the claim takes the
      copy's citation and the copy goes (see finish). */
  private paraphrase: { body: string; trailing: string } | null = null;

  private dropParaphrase(): void {
    if (!this.paraphrase) return;
    this.drop("opener before a dropped sentence", this.connectives);
    this.counts.dropped += 1;
    this.log.push(`- no citation: ${this.paraphrase.body}`);
    this.skip(this.paraphrase.trailing);
    this.paraphrase = null;
  }

  private finish(): void {
    const s = this.cur;
    this.cur = empty();
    const body = s.text.trim();
    const trailing = s.text.slice(s.text.trimEnd().length);
    // A paragraph break can also come before the sentence (it starts a new text block).
    if (s.text.slice(0, s.text.length - s.text.trimStart().length).includes("\n\n")) this.gap = "\n\n";
    // Punctuation alone (a "." left between two blocks) is not a sentence.
    if (!/[\p{L}\p{N}]/u.test(body)) {
      if (trailing.includes("\n\n")) this.gap = "\n\n";
      return;
    }
    if (!s.cites.length) {
      // A connective may open the answer or a paragraph; anywhere else an uncited sentence is a claim or filler.
      const opens = !this.started || this.gap === "\n\n" || this.connectives.length > 0;
      if (!this.paraphrase && opens && !PRONOUN_START.test(body) && isConnective(body, this.nameWords)) {
        this.connectives.push({ body, trailing });
        return;
      }
      this.dropParaphrase();
      if (body.split(/\s+/).length < 3) {
        this.counts.dropped += 1;
        this.log.push(`- no citation: ${body}`);
        return this.skip(trailing);
      }
      this.paraphrase = { body, trailing };
      return;
    }
    // A copy of the transcript is never shown. Right after an uncited claim it is the evidence for that claim:
    // the claim is shown with the copy's citation.
    const para = this.paraphrase;
    this.paraphrase = null;
    if (isCopy(body, s.citedTexts)) {
      this.counts.copies += 1;
      if (para) {
        this.log.push(`- copy of the transcript, its citation moved to the claim before it: ${body}`);
        return this.accept(para.body, s.cites, trailing);
      }
      this.log.push(`- copy of the transcript: ${body}`);
      return this.skip(trailing);
    }
    if (para) {
      // "Ryan Fernando cited a study on sleep. Unhone kaha…": an uncited sentence introducing someone, then the cited
      // detail. When the person it names speaks in that citation, the two are shown as one, with the citation.
      if (para.body.split(/\s+/).some((w) => this.nameWords.has(norm(w))) && this.speakerOk(para.body, s.cites)) {
        this.counts.paired += 1;
        this.log.push(`~ introduction paired with the cited sentence after it: ${para.body}`);
        return this.accept(`${para.body} ${body}`, s.cites, trailing);
      }
      this.paraphrase = para;
      this.dropParaphrase();
    }
    this.accept(body, s.cites, trailing);
  }

  /** A cited sentence: shown, unless the person it names speaks in none of the cited lines, or it opens with a
      pronoun that would point at the wrong person. */
  private accept(body: string, cites: C[], trailing: string): void {
    if (!this.speakerOk(body, cites)) {
      this.drop("opener before a dropped sentence", this.connectives);
      this.counts.speaker_mismatch += 1;
      this.log.push(`- named person not speaking in the cited lines: ${body}`);
      return this.skip(trailing);
    }
    // "He said…" must follow a shown sentence from the same episode, and someone from that episode must have been
    // named; otherwise it points at the wrong person or at no one.
    const episode = this.episodeOf(cites[0]);
    if (PRONOUN_START.test(body) && (this.droppedSince || episode !== this.lastEpisode || !this.named.has(episode))) {
      this.counts.orphans += 1;
      this.log.push(`- pronoun with no one to point at: ${body}`);
      return this.skip(trailing);
    }
    for (const c of this.connectives.splice(0)) {
      this.counts.connectives += 1;
      this.log.push(`+ connective: ${c.body}`);
      this.show(c.body, [], c.trailing);
    }
    this.counts.cited += 1;
    this.log.push(`+ cited: ${body}`);
    this.show(body, cites, trailing);
    this.lastEpisode = episode;
    if (body.split(/\s+/).some((w) => this.nameWords.has(norm(w)))) this.named.add(episode);
  }

  private skip(trailing: string): void {
    this.droppedSince = true;
    if (trailing.includes("\n\n")) this.gap = "\n\n";
  }

  private show(body: string, cites: C[], trailing: string): void {
    const text = (this.started ? this.gap || " " : "") + body;
    this.started = true;
    this.droppedSince = false;
    this.gap = trailing.includes("\n\n") ? "\n\n" : " ";
    this.counts.shown += 1;
    if (this.counts.cited < this.minCited) { this.held.push({ text, cites }); return; }
    for (const h of this.held.splice(0)) this.send(h.text, h.cites);
    this.send(text, cites);
  }
}
