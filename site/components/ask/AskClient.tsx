"use client";

import dynamic from "next/dynamic";
import { PageSkeleton } from "@/components/states";

/** The thread lives in this browser tab (sessionStorage), so the Ask view renders on the client only. */
export const AskClient = dynamic(() => import("./AskView").then((m) => m.AskView), {
  ssr: false,
  loading: () => <PageSkeleton kind="player" />,
});
