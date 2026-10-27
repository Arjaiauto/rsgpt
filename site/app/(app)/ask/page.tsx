import type { Metadata } from "next";
import { Suspense } from "react";
import { Placeholder } from "@/components/app/Placeholder";
import { IconEpisode } from "@/components/Icons";
import { ClipPlayer } from "@/components/player/ClipPlayer";
import { EmptyState, PageSkeleton } from "@/components/states";
import { topClip } from "@/lib/archive";
import { requireSession } from "@/lib/auth";

export const metadata: Metadata = { title: "Ask · Cuepoint" };

async function Greeting() {
  const { firstName } = await requireSession();
  return <>Hi {firstName}</>;
}

async function Question({ searchParams }: { searchParams: Promise<{ q?: string | string[] }> }) {
  const raw = (await searchParams).q;
  const q = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return q ? <p className="coming">Your question: “{q.slice(0, 300)}”. Answers arrive in a later ticket.</p> : null;
}

/* Test block for the shared player (ticket 19b). Remove in ticket 21. */
async function TestClip() {
  await requireSession();
  const clip = await topClip("/ask");
  if (!clip) {
    return <EmptyState icon={<IconEpisode />} title="No verified clips yet" text="Clips appear here once they pass the checks." />;
  }
  return <ClipPlayer clip={clip} />;
}

export default function AskPage({ searchParams }: PageProps<"/ask">) {
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
    >
      <Suspense fallback={null}>
        <Question searchParams={searchParams} />
      </Suspense>
      <section className="test-block" aria-label="Player test">
        <Suspense fallback={<PageSkeleton kind="player" />}>
          <TestClip />
        </Suspense>
      </section>
    </Placeholder>
  );
}
