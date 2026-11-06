"use client";

import { useEffect, useRef, useState } from "react";
import { fmtTime, youtubeAt, type Clip } from "@/lib/player-types";
import { toast } from "@/lib/toast";
import { IconBookmark, IconExternal, IconLink, IconPause, IconPlay } from "@/components/Icons";
import { ReportButton } from "@/components/report/ReportButton";
import { loadYouTubeApi, player, registerSlot, usePlayer } from "./store";
import { useClipSave } from "./useClipSave";

const thumb = (videoId: string, size: "maxresdefault" | "hqdefault") =>
  `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/${size}.jpg`;

/** The episode's YouTube thumbnail as the poster of a playable player (CLAUDE.md rule 1 exception: posters of
    playable players only, never as photos, avatars, logos or decoration). maxresdefault when it exists; YouTube
    answers a missing one with a 120x90 placeholder, so that falls back to hqdefault. */
function Poster({ videoId }: { videoId: string }) {
  const [src, setSrc] = useState(thumb(videoId, "maxresdefault"));
  const fallback = () => setSrc((s) => (s.includes("maxresdefault") ? thumb(videoId, "hqdefault") : s));
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a lazy poster from i.ytimg.com; no resizing needed
    <img
      className="slot__img"
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      onLoad={(e) => { if (e.currentTarget.naturalWidth <= 120) fallback(); }}
      onError={fallback}
    />
  );
}

/** A 16:9 placeholder with the episode poster, a round play button and the teal start time. When its clip is the
    current one, the fixed player layer sits over it. `caption` is shown over the poster (top left). */
export function PlayerSlot({ clip, caption }: { clip: Clip; caption?: string }) {
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
      aria-label={`Play from ${fmtTime(clip.startS)}: ${clip.title}`}
      onClick={() => player.toggle(clip)}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); player.toggle(clip); } }}
    >
      <Poster key={clip.videoId} videoId={clip.videoId} />
      {caption && <span className="slot__lab">{caption}</span>}
      <span className="slot__badge num">{fmtTime(clip.startS)}</span>
      <div className="slot__big" aria-hidden="true">{isCurrent && playing ? <IconPause /> : <IconPlay />}</div>
    </div>
  );
}

/** Big player card: slot, title, guest, episode, start time, progress, actions. */
export function ClipPlayer({ clip, label, report = true, canSave = true, snippet }: {
  clip: Clip; label?: string; report?: boolean; canSave?: boolean;
  /** The line of the moment to quote under the title (a line in the transcript's language). "" reserves the room with nothing in it. */
  snippet?: string;
}) {
  const { clip: current, pos } = usePlayer();
  const isCurrent = current?.key === clip.key;
  const len = clip.endS - clip.startS;
  const at = isCurrent ? pos : clip.startS;
  const frac = Math.max(0, Math.min(1, (at - clip.startS) / len));

  const { saved, save } = useClipSave(clip);

  const copyLink = async () => {
    // Always the clip's start, wherever playback is, so a shared link opens the clip as it was saved or cited.
    try { await navigator.clipboard.writeText(youtubeAt(clip.videoId, clip.startS)); } catch {}
    toast("Timestamp link copied");
  };

  return (
    <div className="card player">
      {/* The episode title appears once: as the bold line when there is no label, else over the poster. */}
      <PlayerSlot clip={clip} caption={label || clip.title !== clip.episode ? clip.episode : undefined} />
      <div className="pmeta">
        <div>
          <div className="pmeta__t">{label ?? clip.title}</div>
          <div className="pmeta__g">
            {[clip.guest, clip.date].filter(Boolean).join(" · ")} · starts <span className="ts">{fmtTime(clip.startS)}</span>
          </div>
          {snippet !== undefined && <p className="pmeta__q">{snippet ? `“${snippet}”` : null}</p>}
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
          {canSave && (
            <button className="pill pill--ghost" type="button" onClick={save} aria-pressed={saved}>
              <IconBookmark />{saved ? "Saved" : "Save"}
            </button>
          )}
          <button className="pill pill--ghost" type="button" onClick={copyLink}><IconLink />Copy link</button>
          <a className="pill pill--ghost" href={youtubeAt(clip.videoId, at)} target="_blank" rel="noopener noreferrer">
            <IconExternal />Open on YouTube
          </a>
          {report && (
            <ReportButton
              item={{ itemType: clip.itemType, itemId: clip.itemId, videoId: clip.videoId, startS: clip.startS, episode: clip.episode, title: clip.title }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
