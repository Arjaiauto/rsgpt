import type { Metadata } from "next";
import { Suspense } from "react";
import { listSaved } from "@/app/actions/saved";
import { SavedView } from "@/components/saved/SavedView";
import { PageSkeleton } from "@/components/states";
import "./saved.css";

export const metadata: Metadata = { title: "Saved · Cuepoint" };

async function Loader() {
  return <SavedView initial={await listSaved()} />;
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
