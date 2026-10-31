import "server-only";
import { cacheLife } from "next/cache";
import { ASK } from "@/lib/ask/config";
import { monthYear, searchTexts } from "@/lib/ask/retrieve";
import { Timings } from "@/lib/ask/timing";
import { cosine } from "@/lib/ask/voyage";
import {
  PAGE_SIZE, cleanOpening, effectiveSort, lengthOf, type ClipCard, type ClipLength, type ClipOptions, type ClipPage, type ClipParams,
} from "@/lib/clip-types";
import { ARCHIVE_RUN_ID, db } from "@/lib/db";
import { fold } from "@/lib/guest-format";
import { getDirectory, getGuestVideos } from "@/lib/guests";

/** The Clips page reads every verified clip once (about 2,700 rows) with its episode and guests, keeps that for an hour
    like the guest directory, and filters, sorts and pages it in memory for each request. A search runs the same hybrid
    search as Ask over the transcript passages and ranks the clips those passages fall in. */

type IndexClip = ClipCard & { topics: string[]; guestSlugs: string[]; year: string; len: ClipLength };
type ClipIndex = { clips: IndexClip[]; options: ClipOptions };

async function all<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await page(from, from + 999);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if ((data?.length ?? 0) < 1000) return rows;
  }
}

export async function getClipIndex(): Promise<ClipIndex> {
  "use cache";
  cacheLife({ stale: 300, revalidate: 3600, expire: 86400 });
  const [dir, guestVideos, rows] = await Promise.all([
    getDirectory(),
    getGuestVideos(),
    all<{ id: number; video_id: string; start_s: number; end_s: number; opening_line: string | null; topic: string | null; score: number | null }>((a, b) =>
      db().from("clips").select("id,video_id,start_s,end_s,opening_line,topic,score").eq("run_id", ARCHIVE_RUN_ID).eq("verified", true).order("id").range(a, b)),
  ]);
  const vids = [...new Set(rows.map((r) => r.video_id))];
  const eps = await all<{ video_id: string; title: string; published_at: string | null; view_count: number | null; caption_language: string | null }>((a, b) =>
    db().from("episodes").select("video_id,title,published_at,view_count,caption_language").in("video_id", vids).order("video_id").range(a, b));
  const epOf = new Map(eps.map((e) => [e.video_id, e]));
  const guestBySlug = new Map(dir.guests.map((g) => [g.slug, g]));
  const slugsOf = new Map<string, string[]>();
  for (const r of guestVideos) {
    if (!guestBySlug.has(r.slug)) continue;
    const list = slugsOf.get(r.videoId) ?? [];
    if (!list.includes(r.slug)) list.push(r.slug);
    slugsOf.set(r.videoId, list);
  }
  // A repeat guest: their clips come from more than one episode.
  const episodesWithClips = new Map<string, Set<string>>();
  for (const r of rows) for (const s of slugsOf.get(r.video_id) ?? []) (episodesWithClips.get(s) ?? episodesWithClips.set(s, new Set()).get(s)!).add(r.video_id);

  const clips: IndexClip[] = [];
  for (const r of rows) {
    const ep = epOf.get(r.video_id);
    if (!ep) continue;
    const slugs = slugsOf.get(r.video_id) ?? [];
    const guests = slugs.map((s) => guestBySlug.get(s)!);
    clips.push({
      id: r.id, videoId: r.video_id, startS: r.start_s, endS: r.end_s, topic: (r.topic ?? "").trim() || "Clip", opening: cleanOpening(r.opening_line ?? ""),
      score: r.score ?? 0, guest: guests.map((g) => g.name).join(" & "), guestSlug: slugs[0] ?? null,
      repeat: (episodesWithClips.get(slugs[0] ?? "")?.size ?? 0) > 1,
      episode: ep.title, date: monthYear(ep.published_at), publishedAt: ep.published_at ?? "", views: Number(ep.view_count ?? 0),
      lang: ep.caption_language === "hi" ? "hi" : ep.caption_language === "en" ? "en" : null,
      topics: [...new Set(guests.flatMap((g) => g.tags.map((t) => t.toLowerCase())))], guestSlugs: slugs,
      year: (ep.published_at ?? "").slice(0, 4), len: lengthOf(r.end_s - r.start_s),
    });
  }

  // Filter choices, with counts over all clips. Topics are the guests' sectors (the free-text clip topic is one per clip,
  // so it names the card instead); a choice with no clips is left out.
  const count = <K extends string>(key: (c: IndexClip) => K[]) => {
    const m = new Map<K, number>();
    for (const c of clips) for (const k of key(c)) m.set(k, (m.get(k) ?? 0) + 1);
    return m;
  };
  const topicN = count((c) => c.topics);
  const guestN = count((c) => c.guestSlugs);
  const yearN = count((c) => (c.year ? [c.year] : []));
  const lenN = count((c) => [c.len]);
  const langN = count((c) => (c.lang ? [c.lang] : []));
  const options: ClipOptions = {
    total: clips.length,
    topics: dir.sectors.map((s) => ({ key: s.key, label: s.label, n: topicN.get(s.key) ?? 0 })).filter((t) => t.n > 0),
    guests: [...guestN].map(([slug, n]) => ({ slug, name: guestBySlug.get(slug)!.name, n })).sort((a, b) => a.name.localeCompare(b.name)),
    years: [...yearN].map(([year, n]) => ({ year, n })).sort((a, b) => b.year.localeCompare(a.year)),
    lengths: (["short", "mid", "long"] as const).map((key) => ({ key, n: lenN.get(key) ?? 0 })).filter((l) => l.n > 0),
    langs: (["en", "hi"] as const).map((key) => ({ key, n: langN.get(key) ?? 0 })).filter((l) => l.n > 0),
  };
  return { clips, options };
}

/* ---------- search ---------- */

/** Recent searches per server, so "Load more" and a change of filter do not search again (15 minutes, 100 searches). */
const searches = ((globalThis as { __cpClipSearch?: Map<string, { at: number; rel: Map<number, number> }> }).__cpClipSearch ??= new Map());
const SEARCH_TTL = 15 * 60 * 1000;
const words = (s: string) => fold(s).split(/[^a-z0-9ऀ-ॿ]+/).filter((w) => w.length >= 3);
const STOP = new Set("the and for with that this what when where which who how why are was were you your about from have has had did does not but its into".split(" "));

/** How well each clip matches the search: the hybrid search's passages that overlap the clip (by how much of the clip
    they cover), plus the search words found in the clip's title and opening line. The vector half of the search always
    returns its nearest passages, even for nonsense, so a passage only counts when it is really similar to the search,
    by the same absolute test Ask uses before it answers (cosine similarity of the stored embedding, ASK.minSimilarity). */
async function relevance(q: string, clips: IndexClip[]): Promise<Map<number, number>> {
  const key = q.toLowerCase();
  const hit = searches.get(key);
  if (hit && Date.now() - hit.at < SEARCH_TTL) return hit.rel;
  const { chunks: found, vectors } = await searchTexts([q], 60, new Timings());
  const { data: emb, error } = await db().from("chunks").select("id,embedding").in("id", found.map((c) => c.id));
  if (error) throw new Error(`chunks: ${error.message}`);
  const simOf = new Map((emb ?? []).map((r) => {
    const v: number[] = Array.isArray(r.embedding) ? r.embedding : JSON.parse(String(r.embedding));
    return [r.id as number, Math.max(...vectors.map((q) => cosine(q, v)))] as const;
  }));
  const chunks = found.filter((c) => (simOf.get(c.id) ?? 0) >= ASK.minSimilarity);
  const byVideo = new Map<string, IndexClip[]>();
  for (const c of clips) (byVideo.get(c.videoId) ?? byVideo.set(c.videoId, []).get(c.videoId)!).push(c);
  const rel = new Map<number, number>();
  for (const ch of chunks) {
    for (const c of byVideo.get(ch.videoId) ?? []) {
      const overlap = Math.min(c.endS, ch.endS) - Math.max(c.startS, ch.startS);
      if (overlap > 0) rel.set(c.id, (rel.get(c.id) ?? 0) + ch.score * Math.min(1, overlap / (c.endS - c.startS)));
    }
  }
  const qw = words(q).filter((w) => !STOP.has(w));
  if (qw.length) {
    const texts = clips.map((c) => new Set(words(`${c.topic} ${c.opening}`)));
    // A word in more than 2% of the clips' titles and openings ("first", "life") says little on its own: it counts only
    // next to a rarer search word, or when every search word is there.
    const rare = new Set(qw.filter((w) => texts.filter((t) => t.has(w)).length <= clips.length * 0.02));
    clips.forEach((c, i) => {
      const found = qw.filter((w) => texts[i].has(w));
      if (found.length && (found.some((w) => rare.has(w)) || found.length === qw.length)) rel.set(c.id, (rel.get(c.id) ?? 0) + 0.012 * found.length);
    });
  }
  searches.set(key, { at: Date.now(), rel });
  if (searches.size > 100) searches.delete(searches.keys().next().value!);
  return rel;
}

/* ---------- query ---------- */

/** The card without the fields only the filters use. */
const strip = (c: IndexClip): ClipCard => ({
  id: c.id, videoId: c.videoId, startS: c.startS, endS: c.endS, topic: c.topic, opening: c.opening, score: c.score, guest: c.guest,
  guestSlug: c.guestSlug, repeat: c.repeat, episode: c.episode, date: c.date, publishedAt: c.publishedAt, views: c.views, lang: c.lang,
});

/** One page of the clips these params ask for. In a guest's view, all their clips, grouped by episode. */
export async function queryClips(p: ClipParams, offset: number, limit = PAGE_SIZE): Promise<ClipPage> {
  const { clips, options } = await getClipIndex();
  let list = clips.filter((c) =>
    (!p.topic || c.topics.includes(p.topic)) && (!p.guest || c.guestSlugs.includes(p.guest)) && (!p.len || c.len === p.len)
    && (!p.year || c.year === p.year) && (!p.lang || c.lang === p.lang));
  let rel: Map<number, number> | null = null;
  if (p.q) {
    rel = await relevance(p.q, clips);
    list = list.filter((c) => (rel!.get(c.id) ?? 0) > 0);
  }
  const sort = effectiveSort(p);
  const tie = (a: IndexClip, b: IndexClip) => b.views - a.views || a.id - b.id;
  list.sort(
    sort === "match" ? (a, b) => (rel!.get(b.id) ?? 0) - (rel!.get(a.id) ?? 0) || b.score - a.score || tie(a, b)
      : sort === "new" ? (a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.startS - b.startS || a.id - b.id
        : sort === "views" ? (a, b) => b.views - a.views || a.startS - b.startS || a.id - b.id
          : (a, b) => b.score - a.score || tie(a, b));

  if (p.guest) {
    const g = options.guests.find((x) => x.slug === p.guest);
    const groups: NonNullable<ClipPage["guestView"]>["groups"] = [];
    for (const c of list) {
      let grp = groups.find((x) => x.videoId === c.videoId);
      if (!grp) groups.push(grp = { videoId: c.videoId, episode: c.episode, date: c.date, clips: [] });
      grp.clips.push(strip(c));
    }
    return {
      items: list.map(strip), total: list.length, next: null,
      guestView: g ? { slug: g.slug, name: g.name, episodes: groups.length, clips: list.length, groups } : null,
    };
  }
  const start = Math.max(0, Math.floor(offset));
  const page = list.slice(start, start + limit).map(strip);
  return { items: page, total: list.length, next: start + limit < list.length ? start + limit : null, guestView: null };
}

