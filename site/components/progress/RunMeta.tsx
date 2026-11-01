"use client";

import { useEffect, useState } from "react";
import "./progress.css";

/** The live part of a slow generation: the current stage (read out politely when it changes), the time left and a
    Cancel button. The countdown comes from `etaMs`, the median of recent runs, and counts down each second from
    `startedAt`. At 0 it says "Almost done…" until the run ends; it never goes negative. The stage names themselves are
    drawn by the page; `label` shows the current one here when no list is on screen. */
export function RunMeta({ etaMs, startedAt, stage, label, onCancel }: {
  etaMs: number | null; startedAt: number; stage: string; label?: boolean; onCancel: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const left = etaMs == null ? null : Math.ceil((etaMs - (now - startedAt)) / 1000);
  return (
    <div className="rm">
      <span className="rm-sr" aria-live="polite">{stage}</span>
      {label && <span className="rm-stage" aria-hidden="true">{stage}</span>}
      {left != null && <span className="rm-eta" aria-hidden="true">{left > 0 ? `About ${left} s left` : "Almost done…"}</span>}
      <button className="rm-cancel" type="button" onClick={onCancel}>Cancel</button>
    </div>
  );
}
