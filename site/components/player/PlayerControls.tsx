"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { fmtTime, youtubeAt, type Clip } from "@/lib/player-types";
import { toast } from "@/lib/toast";
import { IconCaptions, IconExternal, IconFullscreen, IconPause, IconPlay, IconVolume, IconVolumeOff } from "@/components/Icons";
import { player } from "./store";

/** The controls fade out this long after the pointer leaves, or after a tap while the video is playing. */
const HIDE_MS = 2500;

/**
 * Cuepoint's own controls over the YouTube iframe (whose controls, title bar and end screen are switched off).
 * A transparent layer covers the video and catches every click, so YouTube's overlays never get the pointer; a click
 * plays or pauses. The control bar shows on hover or tap, fades out HIDE_MS after the pointer leaves or after a tap
 * while playing, and stays up while the video is paused or a control has keyboard focus. YouTube's watermark is not
 * hidden: the bar leaves its corner free.
 */
export function PlayerControls({ clip, pos, playing, muted, captions, stageRef }: {
  clip: Clip; pos: number; playing: boolean; muted: boolean; captions: boolean; stageRef: RefObject<HTMLDivElement | null>;
}) {
  const [active, setActive] = useState(false);
  const canFullscreen = useSyncExternalStore(() => () => {}, () => !!document.fullscreenEnabled, () => false);
  const [fullscreen, setFullscreen] = useState(false);
  const timer = useRef(0);
  const lastPointer = useRef("mouse");

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === stageRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => { document.removeEventListener("fullscreenchange", onChange); clearTimeout(timer.current); };
  }, [stageRef]);

  const show = () => { clearTimeout(timer.current); setActive(true); };
  const hideSoon = () => { clearTimeout(timer.current); timer.current = window.setTimeout(() => setActive(false), HIDE_MS); };

  const len = clip.endS - clip.startS;
  const frac = len > 0 ? Math.max(0, Math.min(1, (pos - clip.startS) / len)) : 0;

  const onClickVideo = () => {
    const touch = lastPointer.current === "touch";
    // On a touch screen the first tap only brings the controls up; the next one plays or pauses.
    if (touch && playing && !active) { show(); hideSoon(); return; }
    player.toggle();
    if (touch) { show(); hideSoon(); }
  };

  const toggleFullscreen = () => {
    const el = stageRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen().catch(() => toast("Fullscreen isn't available here"));
  };

  const seekKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowRight") player.seekFraction(frac + 5 / len);
    else if (e.key === "ArrowLeft") player.seekFraction(frac - 5 / len);
  };

  return (
    <div
      className={`pc${active ? " on" : ""}${playing ? "" : " idle"}`}
      onPointerDown={(e: PointerEvent) => { lastPointer.current = e.pointerType; }}
      onPointerEnter={(e: PointerEvent) => { if (e.pointerType === "mouse") show(); }}
      onPointerMove={(e: PointerEvent) => { if (e.pointerType === "mouse" && !active) show(); }}
      onPointerLeave={(e: PointerEvent) => { if (e.pointerType !== "touch") hideSoon(); }}
      onClick={onClickVideo}
    >
      <div
        className="pc__bar"
        onClick={(e) => e.stopPropagation()}
        onPointerUp={(e: PointerEvent) => { if (e.pointerType === "touch") { show(); hideSoon(); } }}
      >
        <button className="pc__b pc__b--play" type="button" onClick={() => player.toggle()} aria-label={playing ? "Pause" : "Play"}>
          {playing ? <IconPause /> : <IconPlay />}
        </button>
        <div
          className="track pc__track"
          role="slider"
          tabIndex={0}
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(len)}
          aria-valuenow={Math.round(pos - clip.startS)}
          aria-valuetext={`${fmtTime(pos - clip.startS)} of ${fmtTime(len)}`}
          onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); player.seekFraction((e.clientX - r.left) / r.width); }}
          onKeyDown={seekKey}
        >
          <span style={{ width: `${frac * 100}%` }} />
        </div>
        <span className="pc__time num"><span className="ts">{fmtTime(pos)}</span><span className="pc__dur"> / {fmtTime(clip.endS)}</span></span>
        <button className="pc__b" type="button" onClick={() => player.toggleMute()} aria-pressed={muted} aria-label={muted ? "Unmute" : "Mute"}>
          {muted ? <IconVolumeOff /> : <IconVolume />}
        </button>
        <button className="pc__b" type="button" onClick={() => player.toggleCaptions()} aria-pressed={captions} aria-label={captions ? "Hide captions" : "Show captions"}>
          <IconCaptions />
        </button>
        {canFullscreen && (
          <button className="pc__b" type="button" onClick={toggleFullscreen} aria-pressed={fullscreen} aria-label={fullscreen ? "Exit full screen" : "Full screen"}>
            <IconFullscreen />
          </button>
        )}
        <a className="pc__b pc__yt" href={youtubeAt(clip.videoId, pos)} target="_blank" rel="noopener noreferrer" aria-label="Open on YouTube">
          <IconExternal />
        </a>
      </div>
    </div>
  );
}
