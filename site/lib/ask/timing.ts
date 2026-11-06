/** Per-question timings for the Ask pipeline: how long each stage took, and when key moments happened
    (milliseconds since the request started). Logged as one line per question and saved in qa_log.timings. */
export class Timings {
  private readonly t0 = performance.now();
  /** Stage durations in ms, e.g. rewrite, embed, search_en, lines, claude_total. */
  readonly stages: Record<string, number> = {};
  /** Moments in ms since the request started, e.g. first_sentence, done. */
  readonly at: Record<string, number> = {};
  /** Token counts from the answer call. */
  tokens: Record<string, number> = {};
  /** Sentences of the (last) answer: shown, cited, dropped (no citation), copies (verbatim transcript), connectives. */
  counts: Record<string, number> = {};

  /** Answer length mode of the request (short / medium / detailed); saved in the timings JSON. */
  mode?: string;

  since(): number {
    return Math.round(performance.now() - this.t0);
  }

  /** Records a moment (once; later calls keep the first value). */
  mark(name: string): void {
    if (!(name in this.at)) this.at[name] = this.since();
  }

  /** Runs a stage and records its duration, even if it throws. */
  async time<T>(name: string, run: () => Promise<T>): Promise<T> {
    const s = performance.now();
    try {
      return await run();
    } finally {
      this.stages[name] = Math.round(performance.now() - s);
    }
  }

  toJSON() {
    return { stages: this.stages, at: this.at, tokens: this.tokens, sentences: this.counts, ...(this.mode ? { mode: this.mode } : {}) };
  }

  /** One log line, e.g. "ask 9.8s first 4.1s | rewrite 1.2s · embed 0.3s · …". */
  line(question: string): string {
    const s = (ms: number | undefined) => (ms === undefined ? "-" : (ms / 1000).toFixed(1) + "s");
    const stages = Object.entries(this.stages).map(([k, v]) => `${k} ${s(v)}`).join(" · ");
    const toks = Object.entries(this.tokens).map(([k, v]) => `${k} ${v}`).join(" ");
    const sents = Object.entries(this.counts).map(([k, v]) => `${k} ${v}`).join(" ");
    return `ask ${s(this.at.done)} first ${s(this.at.first_sentence)} | ${stages}${toks ? ` | ${toks}` : ""}${sents ? ` | sentences: ${sents}` : ""} | ${JSON.stringify(question.slice(0, 80))}`;
  }
}
