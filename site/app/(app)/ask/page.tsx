import type { Metadata } from "next";
import { Suspense } from "react";
import { AskClient } from "@/components/ask/AskClient";
import { PageSkeleton } from "@/components/states";
import { getSiteStats } from "@/lib/site-stats";
import "./ask.css";

export const metadata: Metadata = { title: "Ask" };

/** The number of searchable episodes comes from the same cached site stats as the home page (24 hours). */
async function Ask() {
  const { episodesTranscribed } = await getSiteStats();
  return <AskClient episodes={episodesTranscribed} />;
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
