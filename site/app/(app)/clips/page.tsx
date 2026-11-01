import type { Metadata } from "next";
import { Suspense } from "react";
import { ClipsView } from "@/components/clips/ClipsView";
import { PageSkeleton } from "@/components/states";
import { requireSession } from "@/lib/auth";
import { parseClipParams } from "@/lib/clip-types";
import { getClipIndex, queryClips } from "@/lib/clips";
import "./clips.css";
import { timed } from "@/lib/data-log";

export const metadata: Metadata = { title: "Clips" };

/** Filters, sort and search live in the URL (/clips?q=&topic=&guest=&len=&year=&lang=&sort=), so a view can be shared
    or reloaded; the first page of results is built here, the rest with "Load more". */
async function Loader({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  await requireSession();
  const params = parseClipParams(await searchParams);
  const [{ options }, first] = await timed("page /clips", () => Promise.all([getClipIndex(), queryClips(params, 0)]));
  return <ClipsView params={params} initial={first} options={options} />;
}

export default function Page({ searchParams }: PageProps<"/clips">) {
  return (
    <div className="cl-page">
      <Suspense fallback={<PageSkeleton kind="grid" />}>
        <Loader searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
