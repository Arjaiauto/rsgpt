import type { Metadata } from "next";
import { Suspense } from "react";
import { ReelsView } from "@/components/clips/ReelsView";
import { requireSession } from "@/lib/auth";
import { clipQuery, parseClipParams } from "@/lib/clip-types";
import { queryClips } from "@/lib/clips";
import "./reels.css";
import { timed } from "@/lib/data-log";

export const metadata: Metadata = { title: "Reels · Cuepoint" };

/** /clips/reels takes the same query string as /clips (filters, search, sort), plus start=<clip id> to open at one clip
    (a guest group's "Watch as reels"). The first page of clips is built here; the feed loads the rest as it nears the end. */
async function Loader({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  await requireSession();
  const sp = await searchParams;
  const params = parseClipParams(sp);
  const startRaw = Number(Array.isArray(sp.start) ? sp.start[0] : sp.start);
  const page = await timed("page /clips/reels", () => queryClips(params, 0));
  return <ReelsView key={`${clipQuery(params)}|${startRaw}`} params={params} initial={page.items} next={page.next} startId={Number.isInteger(startRaw) ? startRaw : null} />;
}

export default function Page({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  return (
    <Suspense fallback={<div className="rl-root rl-loading" aria-busy="true" aria-label="Loading reels" />}>
      <Loader searchParams={searchParams} />
    </Suspense>
  );
}
