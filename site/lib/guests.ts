import "server-only";
import { cacheLife } from "next/cache";
import { ARCHIVE_RUN_ID, db } from "./db";
import { fmtMonth, splitDisagreement, tagLabel, yearOf } from "./guest-format";
import { guestSlug } from "./guest-slug";
import type {
  CardTakeaway, ClipItem, Directory, DisagreementItem, EpisodeInfo, GuestCard, OpportunityItem, Profile, ProfileItem,
} from "./guest-types";

/** Guests directory and profiles. Everything here is read from verified rows of the archive run
    (CLAUDE.md rules 2 and 9) and cached, so a visit does not query the database. */

const PAGE = 1000;

/** All rows of a query, a page at a time (Supabase returns at most 1,000 rows per request). */
async function all<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    rows.push(...(data ?? []));
    if ((data?.length ?? 0) < PAGE) return rows;
  }
}

type GuestRow = {
  id: number; video_id: string; name: string; organisation: string | null; role_at_episode: string | null;
  sector_tags: string[] | null; bio: string | null; guest_key: string | null;
  photo_url: string | null; photo_credit: string | null; photo_license: string | null; photo_source: string | null;
  linkedin_url: string | null; linkedin_verified: boolean; linkedin_search_url: string | null;
  youtube_channel_url: string | null; youtube_verified: boolean;
  wikipedia_url: string | null; wikipedia_verified: boolean; link_source: string | null;
};
type EpisodeRow = {
  video_id: string; title: string; published_at: string | null; duration_seconds: number | null;
  view_count: number | null; caption_language: string | null;
};

/** The columns the directory reads (the select string below decides the row type). */
type CardRow = Pick<GuestRow, "id" | "video_id" | "name" | "organisation" | "sector_tags" | "guest_key" | "photo_url" | "photo_license">;
const CARD_COLUMNS = "id,video_id,name,organisation,sector_tags,guest_key,photo_url,photo_license";
const EPISODE_COLUMNS = "video_id,title,published_at,duration_seconds,view_count,caption_language";

const toEpisode = (e: EpisodeRow): EpisodeInfo => ({
  videoId: e.video_id, title: e.title, publishedAt: e.published_at, durationS: e.duration_seconds,
  views: Number(e.view_count ?? 0), lang: e.caption_language,
});

const mostCommon = <T,>(values: T[]): T | undefined => {
  const n = new Map<T, number>();
  for (const v of values) n.set(v, (n.get(v) ?? 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
};

/** Tags of a guest's rows in order of how often they appear, one per lower-case form. */
function tagsOf(rows: Pick<GuestRow, "sector_tags">[]): string[] {
  const forms = new Map<string, string[]>();
  for (const r of rows) for (const t of r.sector_tags ?? []) {
    const k = t.trim().toLowerCase();
    if (k) forms.set(k, [...(forms.get(k) ?? []), t.trim()]);
  }
  return [...forms.entries()].sort((a, b) => b[1].length - a[1].length).map(([, raw]) => tagLabel(mostCommon(raw)!));
}

const TAKEAWAY_FIT = { min: 50, max: 220 };

/** Whose clip is it? The speaker labels (segments.speaker) decide. pipeline/15_clip_speakers.py stores, for every
    verified clip, the share of its spoken time that is labelled guest (clips.guest_share). A clip is the guest's when
    that share is at least this; clips where the host talks most of the time are left out. A clip with no value yet
    (the script has not run) is shown as before. */
const CLIP_GUEST_SHARE = 0.5;

type ClipRow = { id: number; video_id: string; start_s: number; end_s: number; topic: string | null; guest_share: number | null };
type Rows<T> = PromiseLike<{ data: T[] | null; error: { message: string } | null }>;

/** Verified clips of the archive run (of some episodes), with guest_share. Before pipeline/sql/clip_speakers.sql has
    been run the column does not exist; then every clip comes back with no value. */
async function verifiedClips(videoIds?: string[]): Promise<ClipRow[]> {
  const read = (columns: string) => all<ClipRow>((a, b) => {
    let q = db().from("clips").select(columns).eq("run_id", ARCHIVE_RUN_ID).eq("verified", true);
    if (videoIds) q = q.in("video_id", videoIds);
    return q.order("id").range(a, b) as unknown as Rows<ClipRow>;
  });
  try {
    return await read("id,video_id,start_s,end_s,topic,guest_share");
  } catch (e) {
    if (!(e instanceof Error && e.message.includes("guest_share"))) throw e;
    console.warn("guests: clips.guest_share is missing; run pipeline/sql/clip_speakers.sql and pipeline/15_clip_speakers.py");
    return (await read("id,video_id,start_s,end_s,topic")).map((c) => ({ ...c, guest_share: null }));
  }
}
const isGuestsClip = (c: ClipRow) => c.guest_share == null || c.guest_share >= CLIP_GUEST_SHARE;

/**
 * The directory: one card per guest_key, sorted by total views. A guest's top takeaway is a verified takeaway of
 * theirs (guest_id is theirs, or empty in an episode with a single verified guest), preferring one of card length from
 * their most viewed episode.
 */
export async function getDirectory(): Promise<Directory> {
  "use cache";
  cacheLife({ stale: 300, revalidate: 3600, expire: 86400 });

  const [rows, eps, clipRows, takes] = await Promise.all([
    all<CardRow>((a, b) => db().from("guests").select(CARD_COLUMNS).eq("run_id", ARCHIVE_RUN_ID).eq("verified", true).order("id").range(a, b)),
    all<EpisodeRow>((a, b) => db().from("episodes").select(EPISODE_COLUMNS).eq("status", "transcribed").order("video_id").range(a, b)),
    verifiedClips(),
    all<{ id: number; video_id: string; guest_id: number | null; text: string; start_s: number; end_s: number }>((a, b) =>
      db().from("insights").select("id,video_id,guest_id,text,start_s,end_s").eq("run_id", ARCHIVE_RUN_ID).eq("verified", true)
        .eq("type", "takeaway").not("start_s", "is", null).order("id").range(a, b)),
  ]);

  const episodes = new Map(eps.map((e) => [e.video_id, toEpisode(e)]));
  const clipCount = new Map<string, number>();
  for (const c of clipRows) if (isGuestsClip(c)) clipCount.set(c.video_id, (clipCount.get(c.video_id) ?? 0) + 1);
  const guestsIn = new Map<string, number>();
  for (const r of rows) guestsIn.set(r.video_id, (guestsIn.get(r.video_id) ?? 0) + 1);
  const takesOf = new Map<string, typeof takes>();
  for (const t of takes) takesOf.set(t.video_id, [...(takesOf.get(t.video_id) ?? []), t]);

  const byKey = new Map<string, CardRow[]>();
  for (const r of rows) if (r.guest_key && episodes.has(r.video_id)) byKey.set(r.guest_key, [...(byKey.get(r.guest_key) ?? []), r]);

  const guests: GuestCard[] = [];
  for (const [key, group] of byKey) {
    const vids = [...new Set(group.map((r) => r.video_id))];
    const eps = vids.map((v) => episodes.get(v)!).sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
    const ids = new Set(group.map((r) => r.id));
    const mine = vids.flatMap((v) => (takesOf.get(v) ?? []).filter((t) => (t.guest_id != null ? ids.has(t.guest_id) : guestsIn.get(v) === 1)));
    const fits = (t: { text: string }) => t.text.length >= TAKEAWAY_FIT.min && t.text.length <= TAKEAWAY_FIT.max;
    const best = [...mine].sort((a, b) =>
      Number(fits(b)) - Number(fits(a)) || episodes.get(b.video_id)!.views - episodes.get(a.video_id)!.views || a.id - b.id)[0];
    const photo = group.find((r) => r.photo_url);
    const take: CardTakeaway | null = best
      ? { id: best.id, text: best.text, videoId: best.video_id, startS: best.start_s, endS: best.end_s, episode: episodes.get(best.video_id)!.title }
      : null;
    guests.push({
      key, slug: guestSlug(key), name: mostCommon(group.map((r) => r.name))!, org: mostCommon(group.map((r) => r.organisation).filter(Boolean)) ?? null,
      tags: tagsOf(group), photoUrl: photo?.photo_url ?? null, photoLicense: photo?.photo_license ?? null,
      latest: eps[0].publishedAt ?? "", views: eps.reduce((n, e) => n + e.views, 0), lengthS: eps[0].durationS,
      clips: vids.reduce((n, v) => n + (clipCount.get(v) ?? 0), 0), episodes: vids.length,
      years: [...new Set(eps.map((e) => yearOf(e.publishedAt)).filter((y): y is number => y != null))],
      langs: [...new Set(eps.map((e) => e.lang ?? "en"))], take,
    });
  }
  guests.sort((a, b) => b.views - a.views || a.name.localeCompare(b.name));
  if (new Set(guests.map((g) => g.slug)).size !== guests.length) console.error("guests: two guest_keys share one clean slug");

  // Sector chips: the tags most guests have, written the way most guests wrote them.
  const sectorGuests = new Map<string, { n: number; label: string }>();
  for (const g of guests) for (const t of g.tags) {
    const k = t.toLowerCase();
    sectorGuests.set(k, { n: (sectorGuests.get(k)?.n ?? 0) + 1, label: sectorGuests.get(k)?.label ?? t });
  }
  const sectors = [...sectorGuests.entries()].filter(([, v]) => v.n >= 5).sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]))
    .slice(0, 14).map(([key, v]) => ({ key, label: v.label, n: v.n }));
  const years = [...new Set(guests.flatMap((g) => g.years))].sort((a, b) => b - a);
  return { guests, sectors, years };
}

/** The guest's page: header, episodes, everything they said (insights and clips) and similar guests. */
export async function getProfile(slug: string): Promise<Profile | null> {
  "use cache";
  cacheLife({ stale: 300, revalidate: 3600, expire: 86400 });

  const dir = await getDirectory();
  const card = dir.guests.find((g) => g.slug === slug);
  if (!card) return null;

  const rows = await all<GuestRow>((a, b) =>
    db().from("guests").select("*").eq("run_id", ARCHIVE_RUN_ID).eq("verified", true).eq("guest_key", card.key).order("id").range(a, b));
  const vids = [...new Set(rows.map((r) => r.video_id))];
  const [epRows, sameEpisode, insights, clipRows] = await Promise.all([
    all<EpisodeRow>((a, b) => db().from("episodes").select(EPISODE_COLUMNS).in("video_id", vids).order("video_id").range(a, b)),
    all<{ id: number; video_id: string }>((a, b) =>
      db().from("guests").select("id,video_id").eq("run_id", ARCHIVE_RUN_ID).eq("verified", true).in("video_id", vids).order("id").range(a, b)),
    all<{ id: number; video_id: string; guest_id: number | null; type: string; category: string | null; text: string; start_s: number; end_s: number }>((a, b) =>
      db().from("insights").select("id,video_id,guest_id,type,category,text,start_s,end_s").eq("run_id", ARCHIVE_RUN_ID).eq("verified", true)
        .in("type", ["takeaway", "opportunity", "quote", "disagreement"]).in("video_id", vids).not("start_s", "is", null).order("id").range(a, b)),
    verifiedClips(vids),
  ]);

  const episodes = epRows.map(toEpisode).sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
  const date = new Map(episodes.map((e) => [e.videoId, e.publishedAt ?? ""]));
  const guestsIn = new Map<string, number>();
  for (const r of sameEpisode) guestsIn.set(r.video_id, (guestsIn.get(r.video_id) ?? 0) + 1);
  const ids = new Set(rows.map((r) => r.id));
  // An insight is this guest's when its guest_id is theirs, or has none in an episode with a single verified guest.
  const mine = insights.filter((i) => (i.guest_id != null ? ids.has(i.guest_id) : guestsIn.get(i.video_id) === 1));
  const inOrder = <T extends { video_id: string; start_s: number; id: number }>(list: T[]) =>
    [...list].sort((a, b) => (date.get(b.video_id) ?? "").localeCompare(date.get(a.video_id) ?? "") || a.start_s - b.start_s || a.id - b.id);
  const item = (i: { id: number; video_id: string; text: string; start_s: number; end_s: number }): ProfileItem =>
    ({ id: i.id, videoId: i.video_id, text: i.text, startS: i.start_s, endS: i.end_s });
  const of = (type: string) => inOrder(mine.filter((i) => i.type === type));

  // The latest episode's row gives the role and bio; earlier rows fill in what it lacks.
  const newest = [...rows].sort((a, b) => (date.get(b.video_id) ?? "").localeCompare(date.get(a.video_id) ?? ""));
  const roleRow = newest.find((r) => r.role_at_episode);
  const bioRow = newest.find((r) => r.bio?.trim());
  const first = <K extends keyof GuestRow>(k: K) => newest.find((r) => r[k])?.[k] ?? null;
  const photoRow = newest.find((r) => r.photo_url);
  const mineTags = new Set(card.tags.map((t) => t.toLowerCase()));
  const similar = dir.guests
    .filter((g) => g.slug !== slug)
    .map((g) => ({ g, shared: g.tags.filter((t) => mineTags.has(t.toLowerCase())).length }))
    .filter((x) => x.shared > 0)
    .sort((a, b) => b.shared - a.shared || b.g.views - a.g.views)
    .slice(0, 4).map((x) => x.g);

  const opportunities: OpportunityItem[] = of("opportunity").map((i) => ({ ...item(i), category: i.category }));
  const disagreements: DisagreementItem[] = of("disagreement").map((i) => {
    const sides = splitDisagreement(i.text);
    return { ...item(i), host: sides?.host ?? null, guest: sides?.guest ?? null };
  });
  // Clips where this guest is the speaker (guest_share, from the speaker labels). In an episode with several guests the
  // labels only say "guest", so a clip also has to overlap this guest's own insights more than the other guests' ones.
  const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
  const isMine = (c: { video_id: string; start_s: number; end_s: number }) => {
    if ((guestsIn.get(c.video_id) ?? 1) <= 1) return true;
    let own = 0, others = 0;
    for (const i of insights) {
      if (i.video_id !== c.video_id || i.guest_id == null) continue;
      const o = overlap(c.start_s, c.end_s, i.start_s, i.end_s);
      if (ids.has(i.guest_id)) own += o; else others += o;
    }
    return own > others;
  };
  const clips: ClipItem[] = inOrder(clipRows).filter((c) => c.topic?.trim() && isGuestsClip(c) && isMine(c))
    .map((c) => ({ id: c.id, videoId: c.video_id, startS: c.start_s, endS: c.end_s, topic: c.topic!.trim() }));

  return {
    slug, name: card.name, org: card.org, role: roleRow?.role_at_episode ?? null,
    asOf: fmtMonth(roleRow ? date.get(roleRow.video_id) ?? null : null), tags: card.tags,
    bio: (bioRow?.bio ?? "").split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 3),
    photo: photoRow ? { url: photoRow.photo_url!, credit: photoRow.photo_credit, license: photoRow.photo_license, source: photoRow.photo_source } : null,
    links: {
      linkedinProfile: newest.find((r) => r.linkedin_verified && r.linkedin_url)?.linkedin_url ?? null,
      linkedinSearch: first("linkedin_search_url"),
      youtube: newest.find((r) => r.youtube_verified && r.youtube_channel_url)?.youtube_channel_url ?? null,
      wikipedia: newest.find((r) => r.wikipedia_verified && r.wikipedia_url)?.wikipedia_url ?? null,
      auto: rows.some((r) => r.link_source === "auto"),
    },
    episodes, takeaways: of("takeaway").map(item), opportunities, quotes: of("quote").map(item), disagreements, clips, similar,
  };
}

/** The episodes of one guest, for limiting an Ask question to them (null when the slug is not a guest). */
export async function getGuestScope(slug: string): Promise<{ name: string; videoIds: string[] } | null> {
  "use cache";
  cacheLife({ stale: 300, revalidate: 3600, expire: 86400 });
  const card = (await getDirectory()).guests.find((g) => g.slug === slug);
  if (!card) return null;
  const rows = await all<{ id: number; video_id: string }>((a, b) =>
    db().from("guests").select("id,video_id").eq("run_id", ARCHIVE_RUN_ID).eq("verified", true).eq("guest_key", card.key).order("id").range(a, b));
  return { name: card.name, videoIds: [...new Set(rows.map((r) => r.video_id))] };
}

/** Which guest (clean slug) has which verified row in which episode. The Prep brief maps search hits (episodes) to
    guests with it, and a question's guest_id to the guest it was asked to. */
export async function getGuestVideos(): Promise<{ id: number; videoId: string; slug: string }[]> {
  "use cache";
  cacheLife({ stale: 300, revalidate: 3600, expire: 86400 });
  const rows = await all<{ id: number; video_id: string; guest_key: string | null }>((a, b) =>
    db().from("guests").select("id,video_id,guest_key").eq("run_id", ARCHIVE_RUN_ID).eq("verified", true).order("id").range(a, b));
  return rows.filter((r) => r.guest_key).map((r) => ({ id: r.id, videoId: r.video_id, slug: guestSlug(r.guest_key!) }));
}

/** One short text per guest (name, organisation, role, sectors, bio) for matching an upcoming guest against past
    guests by profile. From the newest verified rows, like the profile page. */
export async function getGuestProfiles(): Promise<{ slug: string; text: string }[]> {
  "use cache";
  cacheLife({ stale: 300, revalidate: 3600, expire: 86400 });
  const [dir, rows] = await Promise.all([
    getDirectory(),
    all<{ guest_key: string | null; role_at_episode: string | null; bio: string | null }>((a, b) =>
      db().from("guests").select("guest_key,role_at_episode,bio").eq("run_id", ARCHIVE_RUN_ID).eq("verified", true).order("id").range(a, b)),
  ]);
  const extra = new Map<string, { role: string; bio: string }>();
  for (const r of rows) {
    if (!r.guest_key) continue;
    const slug = guestSlug(r.guest_key);
    const prev = extra.get(slug);
    const bio = (r.bio ?? "").replace(/\s+/g, " ").trim();
    if (!prev || bio.length > prev.bio.length) extra.set(slug, { role: (r.role_at_episode ?? prev?.role ?? "").trim(), bio });
  }
  return dir.guests.map((g) => {
    const e = extra.get(g.slug);
    return { slug: g.slug, text: [`${g.name}${g.org ? `, ${g.org}` : ""}.`, e?.role ? `${e.role}.` : "", g.tags.length ? `Sectors: ${g.tags.join(", ")}.` : "", e?.bio.slice(0, 400) ?? ""].filter(Boolean).join(" ") };
  });
}
