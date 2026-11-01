import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { GuestProfile } from "@/components/guests/GuestProfile";
import { PageSkeleton } from "@/components/states";
import { getProfile } from "@/lib/guests";
import { timed } from "@/lib/data-log";

type Props = PageProps<"/guests/[slug]">;

/** Clean slugs only; anything else is not a guest (and never reaches the cache). Old guest_key URLs are redirected
    to the clean slug by proxy.ts before they get here. */
const VALID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const profileOf = async (params: Props["params"]) => {
  const { slug } = await params;
  return VALID.test(slug) && slug.length <= 120 ? getProfile(slug) : null;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const profile = await profileOf(params);
  return { title: profile ? profile.name : "Guest" };
}

async function Profile({ params }: { params: Props["params"] }) {
  const profile = await timed("page /guests/[slug]", () => profileOf(params));
  if (!profile) notFound();
  return <GuestProfile profile={profile} />;
}

export default function GuestProfilePage({ params }: Props) {
  return (
    <Suspense fallback={<PageSkeleton kind="player-list" />}>
      <Profile params={params} />
    </Suspense>
  );
}
