import "server-only";
import { cacheLife } from "next/cache";
import { timed } from "@/lib/data-log";
import { allRows, db } from "@/lib/db";
import { yearOf } from "@/lib/guest-format";
import { getDirectory, getGuestVideos } from "@/lib/guests";
import { ASK } from "./config";
import { matchEpisodes, scopeIsEmpty, scopeLabel, type AskScope, type ScopeEpisode, type ScopeIndex } from "./scope-types";

/** The scope index (lib/ask/scope-types.ts) from verified rows: transcribed episodes with their year and language, the
    verified guests in each, and the guests' sectors. Guests and topics are the Guests directory's (the same 14 topics as
    the Clips page). Cached like the directory it is built from. */
export async function getScopeIndex(): Promise<ScopeIndex> {
  "use cache: remote";
  cacheLife({ stale: 300, revalidate: 3600, expire: 86400 });
  return timed("getScopeIndex", () => readScopeIndex());
}

async function readScopeIndex(): Promise<ScopeIndex> {
  const [dir, guestVideos, eps] = await Promise.all([
    getDirectory(),
    getGuestVideos(),
    allRows<{ video_id: string; published_at: string | null; caption_language: string | null; duration_seconds: number | null }>((a, b) =>
      db().from("episodes").select("video_id,published_at,caption_language,duration_seconds").eq("status", "transcribed").order("video_id").range(a, b)),
  ]);
  const guests = dir.guests.map((g) => ({ slug: g.slug, name: g.name }));
  const guestAt = new Map(guests.map((g, i) => [g.slug, i]));
  const topics = dir.sectors.map((s) => ({ key: s.key, label: s.label }));
  const topicAt = new Map(topics.map((t, i) => [t.key, i]));
  // A guest's topics: the directory's sectors among their tags.
  const topicsOf = new Map(dir.guests.map((g) => [g.slug, g.tags.map((t) => topicAt.get(t.toLowerCase())).filter((i): i is number => i != null)]));
  const guestsIn = new Map<string, Set<number>>();
  for (const r of guestVideos) {
    const i = guestAt.get(r.slug);
    if (i == null) continue;
    guestsIn.set(r.videoId, (guestsIn.get(r.videoId) ?? new Set()).add(i));
  }
  const episodes: ScopeEpisode[] = eps.map((e) => {
    const g = [...(guestsIn.get(e.video_id) ?? [])].sort((a, b) => a - b);
    const t = [...new Set(g.flatMap((i) => topicsOf.get(guests[i].slug) ?? []))].sort((a, b) => a - b);
    return {
      v: e.video_id, y: yearOf(e.published_at), l: e.caption_language === "hi" ? "hi" : e.caption_language === "en" ? "en" : null,
      g, t, m: Math.round((e.duration_seconds ?? 0) / 60),
    };
  });
  const years = [...new Set(episodes.map((e) => e.y).filter((y): y is number => y != null))].sort((a, b) => b - a);
  return { guests, topics, years, episodes };
}

/** What retrieval needs for a scope: the episode ids, how many chunks each episode may give, and which search path. */
export type ResolvedScope = {
  scope: AskScope;
  label: string;
  videoIds: string[];
  /** Rough chunks in scope (a chunk is about 90 seconds), to choose the exact or the index search. */
  estChunks: number;
  search: { videoIds: string[]; perEpisode: number; exact: boolean };
};

/** The episodes a scope covers, resolved on the server from the cached index (the browser's ids are never used). Null for
    an empty scope (the whole archive). `videoIds` is empty when nothing matches. */
export async function resolveScope(scope: AskScope): Promise<ResolvedScope | null> {
  if (scopeIsEmpty(scope)) return null;
  const ix = await getScopeIndex();
  const eps = matchEpisodes(ix, scope);
  const videoIds = eps.map((e) => e.v);
  const estChunks = eps.reduce((n, e) => n + (e.m > 0 ? Math.ceil((e.m * 60) / 90) : 71), 0);
  // A guest has a handful of episodes, so the best moments may all be in one of them: as the old guest scope did, an
  // episode may give as many chunks as go to the model. Other small scopes too; bigger ones keep 2 per episode.
  const perEpisode = scope.guest || eps.length <= 5 ? ASK.toModel : ASK.maxPerEpisode;
  return {
    scope, label: scopeLabel(ix, scope), videoIds, estChunks,
    search: { videoIds, perEpisode, exact: estChunks <= ASK.scopeExactMaxChunks },
  };
}
