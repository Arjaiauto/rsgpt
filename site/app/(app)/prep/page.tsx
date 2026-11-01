import type { Metadata } from "next";
import { Suspense } from "react";
import { listBriefs } from "@/app/actions/briefs";
import { PrepView } from "@/components/prep/PrepView";
import { PageSkeleton } from "@/components/states";
import { getDirectory } from "@/lib/guests";
import "./prep.css";
import { timed } from "@/lib/data-log";

export const metadata: Metadata = { title: "Prep brief" };

/** Sector chips on the form: the sectors most guests have (all from verified guest rows). */
const CHIPS = 8;

async function Loader({ searchParams }: { searchParams: Promise<{ [key: string]: string | string[] | undefined }> }) {
  const open = Number((await searchParams).brief);
  const [dir, past] = await timed("page /prep", () => Promise.all([getDirectory(), listBriefs()]));
  return <PrepView sectors={dir.sectors.slice(0, CHIPS)} past={past} openId={Number.isInteger(open) && open > 0 ? open : null} />;
}

export default function Page({ searchParams }: PageProps<"/prep">) {
  return (
    <div className="prep-page">
      <Suspense fallback={<PageSkeleton kind="doc" />}>
        <Loader searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
