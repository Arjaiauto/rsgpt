import type { Metadata } from "next";
import { Suspense } from "react";
import { listSaved } from "@/app/actions/saved";
import { SavedView } from "@/components/saved/SavedView";
import { PageSkeleton } from "@/components/states";
import "./saved.css";
import { timed } from "@/lib/data-log";

export const metadata: Metadata = { title: "Saved" };

async function Loader() {
  return <SavedView initial={await timed("page /saved", () => listSaved())} />;
}

export default function Page() {
  return (
    <div className="sv-page">
      <Suspense fallback={<PageSkeleton kind="list" />}>
        <Loader />
      </Suspense>
    </div>
  );
}
