/** The chips that narrow a broad search (Ticket 27). Pure. From the top results: the 2 topics and the 2 guests with the
    most passages, and 1 or 2 sub-themes: words common in the titles of the clips among those results but rare in the
    archive as a whole (chunk_terms), so "ai" gets "jobs" or "agents", not "people". 3 to 5 chips in all. */

import { STOPWORDS, contentWords, fold } from "./normalize";
import type { Chip } from "./types";

export const CHIPS = { min: 3, max: 5, topics: 2, guests: 2, refine: 2, minRefineTitles: 2, minWordLength: 4 } as const;

/** Words of the clip titles (content words, at least 4 letters, not the query's own), with how many titles have each. */
export function refineCandidates(titles: string[], queryWords: string[]): Map<string, number> {
  const skip = new Set(queryWords);
  const out = new Map<string, number>();
  for (const title of titles) {
    const seen = new Set<string>();
    for (const w of contentWords(fold(title))) {
      if (w.length < CHIPS.minWordLength || !/^[a-z]+$/.test(w) || STOPWORDS.has(w)) continue;
      // Plurals and the query's own word ("startups" for "startup") are the query again.
      if ([...skip].some((q) => w.startsWith(q) || q.startsWith(w))) continue;
      if (!seen.has(w)) { seen.add(w); out.set(w, (out.get(w) ?? 0) + 1); }
    }
  }
  return out;
}

export type ChipInput = {
  query: string;
  queryWords: string[];
  topics: { key: string; label: string; hits: number }[];
  guests: { slug: string; name: string; hits: number }[];
  /** refineCandidates(...) */
  refine: Map<string, number>;
  /** chunk_terms counts of the refine candidates. */
  counts: Map<string, number>;
  totalChunks: number;
};

const echoes = (label: string, queryWords: string[]) => {
  const f = fold(label);
  return queryWords.some((q) => f.split(" ").some((w) => w.startsWith(q) || q.startsWith(w)));
};

export function buildChips(c: ChipInput): Chip[] {
  const topics = c.topics.filter((t) => t.hits > 0 && !echoes(t.label, c.queryWords));
  const guests = c.guests.filter((g) => g.hits > 0 && !echoes(g.name, c.queryWords));
  const total = Math.max(1, c.totalChunks);
  const refine = [...c.refine.entries()]
    .filter(([, n]) => n >= CHIPS.minRefineTitles)
    .map(([w, n]) => ({ w, score: n * Math.log(total / (1 + (c.counts.get(w) ?? 0))) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.w.localeCompare(b.w));

  const base = c.query.trim();
  const chip = {
    topic: (t: (typeof topics)[number]): Chip => ({ label: t.label, kind: "topic", value: t.key }),
    guest: (g: (typeof guests)[number]): Chip => ({ label: g.name, kind: "guest", value: g.slug }),
    refine: (r: (typeof refine)[number]): Chip => ({ label: r.w.charAt(0).toUpperCase() + r.w.slice(1), kind: "refine", value: `${base} ${r.w}` }),
  };
  const out: Chip[] = [
    ...topics.slice(0, CHIPS.topics).map(chip.topic),
    ...guests.slice(0, CHIPS.guests).map(chip.guest),
    ...refine.slice(0, CHIPS.refine).map(chip.refine),
  ];
  // Fewer than 3: more of whatever there is (topics, then sub-themes, then guests).
  const extra = [...topics.slice(CHIPS.topics).map(chip.topic), ...refine.slice(CHIPS.refine).map(chip.refine), ...guests.slice(CHIPS.guests).map(chip.guest)];
  while (out.length < CHIPS.min && extra.length) out.push(extra.shift()!);
  // More than 5: the second sub-theme goes first, then the second guest.
  while (out.length > CHIPS.max) {
    const kinds = out.map((x) => x.kind);
    const twoRefines = kinds.filter((k) => k === "refine").length > 1;
    const i = kinds.lastIndexOf(twoRefines ? "refine" : "guest");
    out.splice(i >= 0 ? i : out.length - 1, 1);
  }
  const seen = new Set<string>();
  return out.filter((x) => { const k = fold(x.label); if (seen.has(k)) return false; seen.add(k); return true; });
}
