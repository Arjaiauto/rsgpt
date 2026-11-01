import "server-only";
import { db } from "@/lib/db";
import { EXCLUDED_NAMES } from "@/lib/insights";

export type RunKind = "ask" | "prep" | "web";

/** Runs that count: the last 20 successful ones of this kind. Fewer than 3 and there is no estimate. */
const LAST = 20;
const MIN = 3;
const excluded = new Set(EXCLUDED_NAMES.map((n) => n.toLowerCase()));

/** The median duration in ms of the last 20 runs of this kind, from qa_log (latency_ms of rows that found something),
    leaving out test traffic (EXCLUDED_NAMES and rows with no first name, as on /insights). null when there are too few
    runs or the log can't be read; the page then shows the stages without a countdown. Never throws. */
export async function etaMs(kind: RunKind): Promise<number | null> {
  try {
    const rows = await recent(kind);
    const ms = rows
      .filter((r) => r.first_name && !excluded.has(r.first_name.trim().toLowerCase()) && r.latency_ms != null && r.latency_ms > 0)
      .slice(0, LAST)
      .map((r) => r.latency_ms as number)
      .sort((a, b) => a - b);
    if (ms.length < MIN) return null;
    const mid = Math.floor(ms.length / 2);
    return Math.round(ms.length % 2 ? ms[mid] : (ms[mid - 1] + ms[mid]) / 2);
  } catch {
    return null;
  }
}

type Row = { first_name: string | null; latency_ms: number | null };

/** Newest first, with margin for rows that the name filter removes. A web research row is "[web] name"; a brief has
    kind 'brief'; an Ask question has neither (before the kind column existed, briefs were prefixed "[brief] "). */
async function recent(kind: RunKind): Promise<Row[]> {
  const base = () => db().from("qa_log").select("first_name,latency_ms").eq("found", true).not("latency_ms", "is", null)
    .order("created_at", { ascending: false }).limit(150);
  const q = kind === "web" ? base().like("question", "[web] %")
    : kind === "prep" ? base().eq("kind", "brief").not("question", "like", "[web] %")
    : base().eq("kind", "ask").not("question", "like", "[%");
  const { data, error } = await q;
  if (!error) return (data ?? []) as Row[];
  if (kind === "prep") return [];
  // No kind column yet: an Ask row is any row whose question isn't prefixed.
  if (kind === "web") return [];
  const retry = await base().not("question", "like", "[%");
  return (retry.data ?? []) as Row[];
}
