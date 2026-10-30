import type { Cite } from "@/lib/ask/types";
import type { Brief, BriefEpisodeQuestions, BriefGuest, BriefLine, BriefOpportunity, BriefQuestion, BriefReturning, BriefSuggestion, BriefTopic } from "./types";

/** Cuts a brief that came from the browser down to the fields the site shows, each limited in size, before it is
    saved. Nothing is stored as it arrived. Rule 2: a line that points at no transcript moment is dropped, and a brief
    with no cited similar guest is not saved at all. Pure, so the save action and the tests can both use it. */

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const list = (v: unknown, max: number): Record<string, unknown>[] =>
  (Array.isArray(v) ? v : []).slice(0, max).filter((x): x is Record<string, unknown> => !!x && typeof x === "object");
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function cleanCite(c: Record<string, unknown>): Cite | null {
  const videoId = str(c.videoId, 32);
  if (!videoId) return null;
  return {
    chunkId: num(c.chunkId), videoId, startS: num(c.startS), endS: num(c.endS),
    segmentIds: (Array.isArray(c.segmentIds) ? c.segmentIds : []).slice(0, 200).map(num),
    speaker: str(c.speaker, 200), date: str(c.date, 40), episode: str(c.episode, 300), guest: str(c.guest, 200),
  };
}

function cleanLine(v: unknown): BriefLine | null {
  const r = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const text = str(r.text, 600).trim();
  const cites = list(r.cites, 12).map(cleanCite).filter((c): c is Cite => !!c);
  const id = str(r.id, 60);
  return text && cites.length && id ? { id, text, cites } : null;
}

/** A past question or opportunity: a verified insight row with its episode and time. */
function cleanMoment(q: Record<string, unknown>): BriefQuestion | null {
  const text = str(q.text, 600).trim();
  const videoId = str(q.videoId, 32);
  const id = str(q.id, 60);
  if (!text || !videoId || !id) return null;
  return {
    id, insightId: num(q.insightId), text, guest: str(q.guest, 160), slug: SLUG.test(str(q.slug, 120)) ? str(q.slug, 120) : null,
    videoId, episode: str(q.episode, 300), date: str(q.date, 40), startS: num(q.startS), endS: num(q.endS),
    segmentIds: (Array.isArray(q.segmentIds) ? q.segmentIds : []).slice(0, 200).map(num),
  };
}

function cleanReturning(v: unknown): BriefReturning | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const name = str(r.name, 160).trim();
  if (!name) return null;
  const about = list(r.about, 6).map(cleanLine).filter((l): l is BriefLine => !!l);
  const asked: BriefEpisodeQuestions[] = list(r.asked, 30).map((e) => ({
    videoId: str(e.videoId, 32), episode: str(e.episode, 300), date: str(e.date, 40),
    questions: list(e.questions, 8).map(cleanMoment).filter((q): q is BriefQuestion => !!q),
  })).filter((e) => e.videoId && e.questions.length);
  const opportunities: BriefOpportunity[] = list(r.opportunities, 12).flatMap((o) => {
    const m = cleanMoment(o);
    return m ? [{ ...m, category: str(o.category, 40) }] : [];
  });
  return { name, about, asked, opportunities };
}

export function cleanBrief(input: unknown): Brief | null {
  const b = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const similar: BriefGuest[] = [];
  for (const g of list(b.similar, 8)) {
    const why = cleanLine(g.why);
    const slug = str(g.slug, 120);
    const name = str(g.name, 120).trim();
    const id = str(g.id, 140);
    if (!why || !SLUG.test(slug) || !name || !id) continue;
    const photo = str(g.photoUrl, 500);
    similar.push({
      id, slug, name, org: str(g.org, 160) || null, photoUrl: photo.startsWith("https://") ? photo : null,
      tags: (Array.isArray(g.tags) ? g.tags : []).slice(0, 5).map((t) => str(t, 40)).filter(Boolean), why,
    });
  }
  if (!similar.length) return null;

  const asked = list(b.asked, 12).map(cleanMoment).filter((q): q is BriefQuestion => !!q);
  const topics: BriefTopic[] = list(b.topics, 12).map((t) => ({
    id: str(t.id, 80), tag: str(t.tag, 60), episodes: Math.max(0, Math.round(num(t.episodes))),
    examples: (Array.isArray(t.examples) ? t.examples : []).slice(0, 3).map((e) => str(e, 120)).filter(Boolean),
  })).filter((t) => t.id && t.tag);
  const suggestions: BriefSuggestion[] = list(b.suggestions, 8)
    .map((s) => ({ id: str(s.id, 60), text: str(s.text, 400).trim() })).filter((s) => s.id && s.text);
  const verify = list(b.verify, 8).map(cleanLine).filter((l): l is BriefLine => !!l);

  const a = b.already && typeof b.already === "object" ? (b.already as Record<string, unknown>) : null;
  const already = a && SLUG.test(str(a.slug, 120)) ? { name: str(a.name, 160), slug: str(a.slug, 120), episodes: Math.max(0, Math.round(num(a.episodes))) } : null;
  const title = str(b.title, 120).trim();
  if (!title) return null;
  // Briefs saved before the guest sections existed have neither field: they open as they were.
  return {
    version: 1, title, description: str(b.description, 300), sector: str(b.sector, 80) || null,
    builtAt: str(b.builtAt, 40), preparedFor: str(b.preparedFor, 80), archiveEpisodes: Math.max(0, Math.round(num(b.archiveEpisodes))),
    already, firstAppearance: b.firstAppearance === true, returning: already ? cleanReturning(b.returning) : null, similar, asked, topics, suggestions, verify,
    removed: (Array.isArray(b.removed) ? b.removed : []).slice(0, 200).map((r) => str(r, 140)).filter(Boolean),
  };
}
