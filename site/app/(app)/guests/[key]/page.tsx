import type { Metadata } from "next";
import { Suspense } from "react";
import { Placeholder } from "@/components/app/Placeholder";

export const metadata: Metadata = { title: "Guest profile · Cuepoint" };

async function GuestKey({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  return <span className="soft">{decodeURIComponent(key)}</span>;
}

export default function GuestProfilePage({ params }: PageProps<"/guests/[key]">) {
  return (
    <Placeholder
      title={
        <>
          Guest profile
          <Suspense fallback={null}>
            <GuestKey params={params} />
          </Suspense>
        </>
      }
    />
  );
}
