"use client";

import { useEffect, useRef } from "react";
import { fmtTime, youtubeAt, type Clip } from "@/lib/player-types";
import { toast } from "@/lib/toast";
import { IconBookmark, IconExternal, IconLink, IconPause, IconPlay } from "@/components/Icons";
import { ReportButton } from "@/components/report/ReportButton";
import { loadYouTubeApi, player, registerSlot, usePlayer } from "./store";

const BARS = Array.from({ length: 64 }, (_, i) => 18 + Math.abs(Math.sin(i * 1.7) * 60 + Math.sin(i * 0.5) * 22));

/** An empty 16:9 placeholder. When its clip is the current one, the fixed player layer sits over it. */
export function PlayerSlot({ clip }: { clip: Clip }) {
  const ref = useRef<HTMLDivElement>(null);
  const { clip: current, playing } = usePlayer();
  const isCurrent = current?.key === clip.key;

  useEffect(() => {
    // Load the API early so a click can start playback straight away.
    loadYouTubeApi().catch(() => {});
    return registerSlot(clip.key, ref.current!);
  }, [clip.key]);

  return (
    <div
      ref={ref}
      className="slot"
      role="button"
      tabIndex={0}
      aria-label={`Play ${clip.title}`}
      onClick={() => player.toggle(clip)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); player.toggle(clip); } }}
    >
      <span className="slot__lab">{clip.episode}</span>
      <div className="slot__wave" aria-hidden="true">
        {BARS.map((h, i) => <i key={i} style={{ height: `${h}%` }} />)}
      </div>
      <div className="slot__big" aria-hidden="true">{isCurrent && playing ? <IconPause /> : <IconPlay />}</div>
    </div>
  );
}

/** Big player card: slot, title, guest, episode, start time, progress, actions. */
export function ClipPlayer({ clip }: { clip: Clip }) {
  const { clip: current, pos } = usePlayer();
  const isCurrent = current?.key === clip.key;
  const len = clip.endS - clip.startS;
  const at = isCurrent ? pos : clip.startS;
  const frac = Math.max(0, Math.min(1, (at - clip.startS) / len));

  const copyLink = async () => {
    try { await navigator.clipboard.writeText(youtubeAt(clip.videoId, at)); } catch {}
    toast("Timestamp link copied");
  };

  return (
    <div className="card player">
      <PlayerSlot clip={clip} />
      <div className="pmeta">
        <div>
          <div className="pmeta__t">{clip.title}</div>
          <div className="pmeta__g">
            {clip.guest} · {clip.episode} · starts <span className="ts">{fmtTime(clip.startS)}</span>
          </div>
        </div>
        <div
          className="track"
          role="slider"
          tabIndex={0}
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(len)}
          aria-valuenow={Math.round(at - clip.startS)}
          aria-valuetext={`${fmtTime(at - clip.startS)} of ${fmtTime(len)}`}
          onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); player.seekFraction((e.clientX - r.left) / r.width, clip); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight") player.seekFraction(frac + 5 / len, clip);
            else if (e.key === "ArrowLeft") player.seekFraction(frac - 5 / len, clip);
          }}
        >
          <span style={{ width: `${frac * 100}%` }} />
        </div>
        <div className="prow">
          <span className="ptime num">{fmtTime(at - clip.startS)} / {fmtTime(len)}</span>
          <button className="pill pill--ghost" type="button" onClick={() => toast("Saved to Watch later", { undo: () => {} })}>
            <IconBookmark />Save
          </button>
          <button className="pill pill--ghost" type="button" onClick={copyLink}><IconLink />Copy link</button>
          <a className="pill pill--ghost" href={youtubeAt(clip.videoId, at)} target="_blank" rel="noopener noreferrer">
            <IconExternal />Open on YouTube
          </a>
          <ReportButton
            item={{ itemType: clip.itemType, itemId: clip.itemId, videoId: clip.videoId, startS: clip.startS, episode: clip.episode, title: clip.title }}
          />
        </div>
      </div>
    </div>
  );
}
