"use client";

import { useEffect } from "react";
import { ErrorState } from "@/components/states";

export default function Error({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => { console.error(error); }, [error]);
  return <ErrorState onRetry={retry} />;
}
