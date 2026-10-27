import type { Metadata } from "next";
import { Suspense } from "react";
import { GuestDirectory } from "@/components/guests/GuestDirectory";
import { PageSkeleton } from "@/components/states";
import { getDirectory } from "@/lib/guests";

export const metadata: Metadata = { title: "Guests · Cuepoint" };

/** The list comes from a cached read of the verified guests, so a visit does not query the database. */
async function Directory() {
  return <GuestDirectory directory={await getDirectory()} />;
}

export default function GuestsPage() {
  return (
    <Suspense fallback={<PageSkeleton kind="grid" />}>
      <Directory />
    </Suspense>
  );
}
