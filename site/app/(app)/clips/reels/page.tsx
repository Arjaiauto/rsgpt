import type { Metadata } from "next";
import { Suspense } from "react";
import { ReelsView } from "@/components/clips/ReelsView";
import { requireSession } from "@/lib/auth";
import { clipQuery, parseClipParams } from "@/lib/clip-types";
import { queryClipsAround } from "@/lib/clips";
import "./reels.css";
import { timed } from "@/lib/data-log";

export const metadata: Metadata = { title: "Reels" };

/** /clips/reels takes the same query string as /clips (filters, search, sort), plus start=<clip id> to open at one clip
    (a guest group's "Watch as reels"). The first screen is built here, at the start clip if there is one (even when it is
    deep in the list); the feed loads the pages after it, and before it, as it nears either end. */
async function Loader({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  await requireSession();
  const sp = await searchParams;
  const params = parseClipParams(sp);
  const startRaw = Number(Array.isArray(sp.start) ? sp.start[0] : sp.start);
  const startId = Number.isInteger(startRaw) ? startRaw : null;
  const page = await timed("page /clips/reels", () => queryClipsAround(params, startId));
  return <ReelsView key={`${clipQuery(params)}|${startRaw}`} params={params} initial={page.items} next={page.next} prev={page.prev} startId={startId} />;
}

export default function Page({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  return (
    <Suspense fallback={<div className="rl-root rl-loading" aria-busy="true" aria-label="Loading reels" />}>
      <Loader searchParams={searchParams} />
    </Suspense>
  );
}
