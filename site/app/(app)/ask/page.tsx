import type { Metadata } from "next";
import { Suspense } from "react";
import { Placeholder } from "@/components/app/Placeholder";
import { requireSession } from "@/lib/auth";

export const metadata: Metadata = { title: "Ask · Cuepoint" };

async function Greeting() {
  const { firstName } = await requireSession();
  return <>Hi {firstName}</>;
}

export default function AskPage() {
  return (
    <Placeholder
      title={
        <>
          <Suspense fallback="Hi">
            <Greeting />
          </Suspense>
          , ask anything from 500 episodes
          <span className="soft">in English, Hindi or Hinglish</span>
        </>
      }
    />
  );
}
