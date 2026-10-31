import type { Metadata } from "next";
import { Suspense } from "react";
import { InsightsView, ThumbnailsView, UsageView } from "@/components/insights/InsightsView";
import { IconPage } from "@/components/Icons";
import { EmptyState, PageSkeleton, Skeleton } from "@/components/states";
import { requireSession } from "@/lib/auth";
import { fmtDay } from "@/lib/guest-format";
import { getInsights, getThumbnailInsights, getUsage } from "@/lib/insights";
import { MIN_GROUP } from "@/lib/insights-types";
import "./insights.css";

export const metadata: Metadata = { title: "Insights · Cuepoint" };

async function Archive() {
  await requireSession();
  const data = await getInsights();
  if (!data.overview.episodes) {
    return <EmptyState icon={<IconPage />} title="No episodes to count yet" text="Insights appear once episodes are transcribed." actions={[{ label: "Browse clips", href: "/clips" }]} />;
  }
  return (
    <>
      <p className="in-how">
        Bars show the <b>median</b>, the middle episode, so a few viral episodes don&apos;t set the picture; the thin line shows where the middle half of
        episodes fall and the tick the average. Groups with fewer than {MIN_GROUP} episodes are hidden. Counted {fmtDay(data.countedAt)}, updated hourly.
      </p>
      <InsightsView data={data} />
    </>
  );
}

/** Shown once pipeline/17_thumbnail_features.py has loaded public.thumbnail_features; until then, nothing. */
async function ThumbnailSection() {
  await requireSession();
  const t = await getThumbnailInsights();
  return t ? <ThumbnailsView t={t} /> : null;
}

async function UsageSection() {
  await requireSession();
  return <UsageView u={await getUsage()} />;
}

export default function Page() {
  return (
    <div className="in-page">
      <h1 className="page-title rise">Insights<span className="soft">what the archive shows</span></h1>
      <div className="in-proof"><b>Patterns, not proof.</b><span>Guest fame, news cycles and the YouTube algorithm move views too. Use these to ask better questions, not as rules.</span></div>
      <Suspense fallback={<PageSkeleton kind="stats" />}>
        <Archive />
      </Suspense>
      <Suspense fallback={null}>
        <ThumbnailSection />
      </Suspense>
      <Suspense fallback={<div className="in-sec"><Skeleton w="40%" h={24} /></div>}>
        <UsageSection />
      </Suspense>
    </div>
  );
}
