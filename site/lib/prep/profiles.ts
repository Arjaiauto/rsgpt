import "server-only";
import { embedQueries } from "@/lib/ask/voyage";
import { getGuestProfiles } from "@/lib/guests";

/** An embedding of every past guest's profile text, made once per server process (about 430 short texts, a second or
    two) and kept, so a brief can rank guests by how close their profile is to the upcoming guest's description. */
let cache: Promise<Map<string, number[]>> | null = null;

const BATCH = 96;

export function profileVectors(): Promise<Map<string, number[]>> {
  cache ??= (async () => {
    const profiles = await getGuestProfiles();
    const batches: { slug: string; text: string }[][] = [];
    for (let i = 0; i < profiles.length; i += BATCH) batches.push(profiles.slice(i, i + BATCH));
    const vectors = await Promise.all(batches.map((b) => embedQueries(b.map((p) => p.text))));
    return new Map(batches.flatMap((b, i) => b.map((p, j) => [p.slug, vectors[i][j]] as const)));
  })().catch((e) => {
    cache = null; // a failed attempt is not kept
    throw e;
  });
  return cache;
}
