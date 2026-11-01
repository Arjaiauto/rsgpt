"use client";

import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { markTourSeen } from "@/app/actions/tour";
import { TOUR_OPEN_EVENT } from "@/lib/tour";

/** The tour's code (slides, styles, pins) is only fetched when the tour is first shown. */
const Tour = lazy(() => import("./Tour"));

/** Opens the tour by itself the first time (autoOpen), and whenever the "? Tour" button or the phone menu asks. The
    first close is remembered (markTourSeen); reopening it later changes nothing. */
export function TourHost({ autoOpen }: { autoOpen: boolean }) {
  const [shown, setShown] = useState(false);
  const mark = useRef(autoOpen);

  // A beat after the page has painted, so the first view isn't held up by the tour.
  useEffect(() => {
    if (!autoOpen) return;
    const t = window.setTimeout(() => setShown(true), 400);
    return () => window.clearTimeout(t);
  }, [autoOpen]);

  useEffect(() => {
    const open = () => setShown(true);
    window.addEventListener(TOUR_OPEN_EVENT, open);
    return () => window.removeEventListener(TOUR_OPEN_EVENT, open);
  }, []);

  if (!shown) return null;
  return (
    <Suspense fallback={null}>
      <Tour
        onClose={() => {
          setShown(false);
          if (mark.current) {
            mark.current = false;
            void markTourSeen().catch(() => {});
          }
        }}
      />
    </Suspense>
  );
}
