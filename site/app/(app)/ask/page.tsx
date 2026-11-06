import type { Metadata } from "next";
import { Suspense } from "react";
import { AskClient } from "@/components/ask/AskClient";
import { PageSkeleton } from "@/components/states";
import { getScopeIndex } from "@/lib/ask/scope";
import { getSiteStats } from "@/lib/site-stats";
import "./ask.css";

export const metadata: Metadata = { title: "Ask" };

/** The number of searchable episodes comes from the same cached site stats as the home page (24 hours). The scope index
    (28d: the chips' episodes, guests and topics, about 40 KB) is cached too; without it the chips are simply not shown. */
async function Ask() {
  const [{ episodesTranscribed }, scopeIndex] = await Promise.all([
    getSiteStats(),
    getScopeIndex().catch((e: unknown) => { console.error("scope index failed:", e instanceof Error ? e.message : e); return null; }),
  ]);
  return <AskClient episodes={episodesTranscribed} scopeIndex={scopeIndex} />;
}

export default function AskPage() {
  return (
    <div className="askpage">
      <Suspense fallback={<PageSkeleton kind="player" />}>
        <Ask />
      </Suspense>
    </div>
  );
}
