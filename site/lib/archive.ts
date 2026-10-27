import "server-only";
import { ARCHIVE_RUN_ID, db } from "./db";

/** Strips characters that have meaning in PostgREST filters, so typed text is only ever matched as text. */
function cleanQuery(q: string): string {
  return q.replace(/[%_,()*\\"]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

export type GuestHit = { key: string; name: string; organisation: string | null; episodes: number };
export type EpisodeHit = { videoId: string; title: string; publishedAt: string | null; durationS: number | null };

/** Quick search: verified guests (one row per guest_key) and episode titles. */
export async function searchArchive(raw: string): Promise<{ guests: GuestHit[]; episodes: EpisodeHit[] }> {
  const q = cleanQuery(raw);
  if (q.length < 2) return { guests: [], episodes: [] };
  const like = `%${q}%`;
  const [g, e] = await Promise.all([
    db()
      .from("guests")
      .select("guest_key,name,organisation,video_id")
      .eq("verified", true)
      .eq("run_id", ARCHIVE_RUN_ID)
      .or(`name.ilike.${like},organisation.ilike.${like}`)
      .limit(60),
    db()
      .from("episodes")
      .select("video_id,title,published_at,duration_seconds")
      .eq("status", "transcribed")
      .ilike("title", like)
      .order("published_at", { ascending: false })
      .limit(6),
  ]);
  if (g.error) throw g.error;
  if (e.error) throw e.error;
  const byKey = new Map<string, GuestHit>();
  for (const r of g.data ?? []) {
    const key = r.guest_key as string | null;
    if (!key) continue;
    const hit = byKey.get(key);
    if (hit) hit.episodes += 1;
    else byKey.set(key, { key, name: r.name, organisation: r.organisation, episodes: 1 });
  }
  return {
    guests: [...byKey.values()].slice(0, 6),
    episodes: (e.data ?? []).map((r) => ({
      videoId: r.video_id,
      title: r.title,
      publishedAt: r.published_at,
      durationS: r.duration_seconds,
    })),
  };
}
