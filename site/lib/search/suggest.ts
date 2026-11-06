import "server-only";
import { getEntityIndex, matchEntities, type EntityIndex } from "./entities";
import { fold } from "./normalize";
import { peekMeta } from "./search";
import type { SuggestionKind } from "./types";

/** The suggestions under the search box (Ticket 27): the top 8 from the in-memory index, by prefix, whole word and typo
    (Devanagari spellings included). Nothing here waits for the database once the index is loaded, and the archive lookups
    for the sub-labels are used only if they are already built (peekMeta), so a keystroke is never slowed by them. */

export type SuggestItem = { kind: SuggestionKind; label: string; sub: string; href: string; ref: string };

export const SUGGEST = { max: 8, perKind: 4, minScore: 0.62 } as const;

const enc = encodeURIComponent;
/** Where choosing a suggestion goes. Guests, topics and clips have pages; an episode or a plain term runs a search. */
function hrefOf(kind: SuggestionKind, ref: string, text: string): string {
  switch (kind) {
    case "guest": return `/guests/${ref}`;
    case "topic": return `/clips?topic=${enc(ref)}`;
    case "clip": return `/clips/reels?start=${ref}`;
    default: return `/search?q=${enc(text)}`;
  }
}

const popular = new WeakMap<EntityIndex, SuggestItem[]>();

/** What shows before anything is typed: the guests with the most views, the biggest topics and a few terms. */
function popularItems(ix: EntityIndex): SuggestItem[] {
  let items = popular.get(ix);
  if (!items) {
    const top = (kind: SuggestionKind, n: number) =>
      ix.entries.filter((e) => e.sug.kind === kind).sort((a, b) => b.sug.weight - a.sug.weight).slice(0, n);
    items = [...top("guest", 3), ...top("topic", 2), ...top("term", 3)].map((e) => ({
      kind: e.sug.kind, label: e.sug.text, sub: e.sug.kind === "term" ? "Search" : e.sug.kind === "guest" ? "Guest" : "Topic",
      href: hrefOf(e.sug.kind, e.sug.ref, e.sug.text), ref: e.sug.ref,
    }));
    popular.set(ix, items);
  }
  return items;
}

export async function suggest(raw: string): Promise<{ q: string; items: SuggestItem[]; ms: number }> {
  const t0 = performance.now();
  const q = raw.replace(/[\u0000-\u001F\u007F]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
  const ix = await getEntityIndex();
  if (fold(q).length < 2) return { q, items: popularItems(ix), ms: Math.round(performance.now() - t0) };
  const meta = peekMeta(ix);
  const items = matchEntities(ix, q, { perKind: SUGGEST.perKind, minScore: SUGGEST.minScore }).slice(0, SUGGEST.max).map((m): SuggestItem => {
    const { kind, ref, text } = m.s;
    let sub = kind === "guest" ? "Guest" : kind === "topic" ? "Topic" : kind === "term" ? "Search" : kind === "episode" ? "Episode" : "Clip";
    if (meta && kind === "episode") {
      const year = meta.episodeYear(ref);
      sub = ["Episode", year, meta.guestsOf(ref).map((g) => g.name).slice(0, 2).join(" & ")].filter(Boolean).join(" · ");
    } else if (meta && kind === "clip") {
      const guest = meta.clipById(Number(ref))?.guest;
      sub = guest ? `Clip · ${guest}` : "Clip";
    }
    return { kind, label: text, sub, href: hrefOf(kind, ref, text), ref };
  });
  return { q, items, ms: Math.round(performance.now() - t0) };
}
