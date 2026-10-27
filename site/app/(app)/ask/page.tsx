import type { Metadata } from "next";
import { Suspense } from "react";
import { AskClient } from "@/components/ask/AskClient";
import { PageSkeleton } from "@/components/states";
import "./ask.css";

export const metadata: Metadata = { title: "Ask · Cuepoint" };

export default function AskPage() {
  return (
    <div className="askpage">
      <Suspense fallback={<PageSkeleton kind="player" />}>
        <AskClient />
      </Suspense>
    </div>
  );
}
