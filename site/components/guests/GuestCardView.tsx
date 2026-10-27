"use client";

import type { CSSProperties } from "react";
import Link from "next/link";
import { fmtLength, fmtMonth, fmtViews } from "@/lib/guest-format";
import type { GuestCard } from "@/lib/guest-types";
import { fmtTime, type Clip } from "@/lib/player-types";
import { player } from "@/components/player/store";
import { Portrait } from "./Portrait";

/** The takeaway's moment as a clip for the shared player (mini player: a card has no player slot). */
function takeClip(g: GuestCard): Clip | null {
  const t = g.take;
  if (!t) return null;
  return {
    key: `gcard:${g.slug}`, itemType: "insight", itemId: String(t.id), videoId: t.videoId, startS: t.startS,
    endS: Math.max(t.endS, t.startS + 30), title: t.text, guest: g.name, episode: t.episode, sourcePath: null,
  };
}

/**
 * A guest card (design/03-guests.html). Hover or keyboard focus (a first tap on touch screens) expands it to show
 * the top takeaway with its teal timestamp chip and views / episode length / clips. The name is the link to the
 * profile; its ::after covers the card, and the chip sits above it.
 */
export function GuestCardView({ g, index = 0, open, onToggle }: { g: GuestCard; index?: number; open: boolean; onToggle: () => void }) {
  const clip = takeClip(g);
  return (
    <article className={`gx-card${open ? " open" : ""}`} style={{ "--i": Math.min(index, 11) } as CSSProperties}>
      <div className="gx-ph">
        <Portrait name={g.name} photoUrl={g.photoUrl} />
        <span className="gx-yr">{fmtMonth(g.latest)}</span>
        {g.photoUrl && g.photoLicense && <span className="gx-lic">{g.photoLicense}</span>}
      </div>
      <div className="gx-body">
        <h3 className="gx-name">
          <Link
            className="gx-link"
            href={`/guests/${g.slug}`}
            onClick={(e) => {
              // On touch screens the first tap opens the card; the second opens the profile.
              if (!open && window.matchMedia("(hover: none)").matches) { e.preventDefault(); onToggle(); }
            }}
          >
            {g.name}
          </Link>
        </h3>
        {g.org && <span className="gx-org">{g.org}</span>}
        {g.tags.length > 0 && <span className="gx-tags">{g.tags.slice(0, 2).map((t) => <span className="gx-tag" key={t}>{t}</span>)}</span>}
      </div>
      <div className="gx-more">
        <div>
          <div className="gx-more__in">
            {g.take && clip && (
              <p className="gx-tk">
                {g.take.text}
                <button className="gx-ts" type="button" onClick={() => player.play(clip)} aria-label={`Play from ${fmtTime(clip.startS)}`}>
                  {fmtTime(clip.startS)}
                </button>
              </p>
            )}
            <div className="gx-stats">
              <div className="gx-stat"><b>{g.views ? fmtViews(g.views) : "–"}</b><span>views</span></div>
              <div className="gx-stat"><b>{fmtLength(g.lengthS)}</b><span>episode</span></div>
              <div className="gx-stat"><b>{g.clips}</b><span>clips</span></div>
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}
