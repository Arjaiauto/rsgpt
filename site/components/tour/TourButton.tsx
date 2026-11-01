"use client";

import { IconHelp } from "@/components/Icons";
import { TOUR_OPEN_EVENT } from "@/lib/tour";

/** The "? Tour" pill in the top bar (desktop and tablet; on a phone the same thing is in the menu). */
export function TourButton() {
  return (
    <button className="pill pill--ghost tour-btn" type="button" aria-label="Take the tour" onClick={() => window.dispatchEvent(new Event(TOUR_OPEN_EVENT))}>
      <IconHelp />
      <span>Tour</span>
    </button>
  );
}
