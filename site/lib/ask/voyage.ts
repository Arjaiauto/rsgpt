import "server-only";
import { ASK } from "./config";

/** Query embeddings from Voyage voyage-4 (512 dimensions, input_type "query") through the Atlas endpoint,
    the same model and endpoint the pipeline used for the chunk embeddings (pipeline/09_build_chunks.py). */
export async function embedQueries(texts: string[]): Promise<number[][]> {
  const key = process.env.VOYAGE_API_KEY;
  if (!key) throw new Error("VOYAGE_API_KEY is not set");
  let last = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(ASK.voyage.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        input: texts,
        model: ASK.voyage.model,
        input_type: "query",
        output_dimension: ASK.voyage.dimensions,
      }),
      signal: AbortSignal.timeout(15_000),
    }).catch((e: unknown) => ({ ok: false, status: 0, text: async () => String(e) }) as const);
    if (res.ok) {
      const json = (await (res as Response).json()) as { data: { embedding: number[]; index: number }[] };
      return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    }
    last = `${res.status} ${(await res.text()).slice(0, 200)}`;
    if (res.status && res.status < 500 && res.status !== 429) break;
    await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
  }
  throw new Error(`Voyage embedding failed: ${last}`);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
