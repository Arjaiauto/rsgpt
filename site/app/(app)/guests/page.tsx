import type { Metadata } from "next";
import { Suspense } from "react";
import { GuestDirectory } from "@/components/guests/GuestDirectory";
import { PageSkeleton } from "@/components/states";
import { getDirectory } from "@/lib/guests";
import { timed } from "@/lib/data-log";

export const metadata: Metadata = { title: "Guests" };

/** The list comes from a cached read of the verified guests, so a visit does not query the database. */
async function Directory() {
  return <GuestDirectory directory={await timed("page /guests", () => getDirectory())} />;
}

export default function GuestsPage() {
  return (
    <Suspense fallback={<PageSkeleton kind="grid" />}>
      <Directory />
    </Suspense>
  );
}
