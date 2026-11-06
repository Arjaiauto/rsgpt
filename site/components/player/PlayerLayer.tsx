"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { fmtTime, youtubeAt } from "@/lib/player-types";
import { IconBookmark, IconExternal, IconLink, IconNext, IconPause, IconPlay, IconPrev, IconX } from "@/components/Icons";
import { toast } from "@/lib/toast";
import { PlayerControls } from "./PlayerControls";
import { player, setPlayerHost, slotFor, usePlayer } from "./store";
import { useClipSave } from "./useClipSave";

/** The one fixed layer that holds the YouTube iframe. Over the clip's slot on its source page; otherwise
    the mini player at the bottom right (full width under 820px). The iframe's DOM node never moves. */
export function PlayerLayer() {
  const router = useRouter();
  const { clip, pos, playing, slots, muted, captions, queue, switching } = usePlayer();
  const layerRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const { saved, save } = useClipSave(clip);
  const slot = clip ? slotFor(clip.key) : null;
  const mode = !clip ? "off" : slot ? "slot" : "mini";

  useEffect(() => { setPlayerHost(hostRef.current); return () => setPlayerHost(null); }, []);

  useEffect(() => {
    document.body.classList.toggle("has-mini", mode === "mini");
    return () => document.body.classList.remove("has-mini");
  }, [mode]);

  // The mini player is taller while it shows the queue row; pages that clear it (the Ask dock) use this class.
  const queued = mode === "mini" && !!queue;
  useEffect(() => {
    document.body.classList.toggle("has-queue", queued);
    return () => document.body.classList.remove("has-queue");
  }, [queued]);

  // Sit exactly over the slot: follow it every frame while it is on the page (scroll, resize, layout shifts).
  useLayoutEffect(() => {
    const layer = layerRef.current!;
    if (mode !== "slot" || !slot) {
      layer.style.top = layer.style.left = layer.style.width = layer.style.height = layer.style.clipPath = "";
      return;
    }
    let raf = 0, last = "";
    const follow = () => {
      // Full screen is the stage on its own: leave the layer position and clipping alone until it is over.
      if (document.fullscreenElement) { layer.style.clipPath = ""; last = ""; raf = requestAnimationFrame(follow); return; }
      const r = slot.getBoundingClientRect();
      // Clip whatever part of the video has scrolled up under the sticky top bar, so it scrolls under the bar
      // like normal content (clip-path also stops clicks on the hidden part).
      const barBottom = document.querySelector(".bar-top")?.getBoundingClientRect().bottom ?? 0;
      const hidden = Math.max(0, Math.min(r.height, barBottom - r.top));
      const key = `${r.top}|${r.left}|${r.width}|${r.height}|${hidden}`;
      if (key !== last) {
        last = key;
        layer.style.top = `${r.top}px`;
        layer.style.left = `${r.left}px`;
        layer.style.width = `${r.width}px`;
        layer.style.height = `${r.height}px`;
        layer.style.clipPath = hidden > 0 ? `inset(${hidden}px 0 0 0)` : "";
      }
      raf = requestAnimationFrame(follow);
    };
    follow();
    return () => cancelAnimationFrame(raf);
  }, [mode, slot, slots]);

  const len = clip ? clip.endS - clip.startS : 0;
  const frac = clip && len > 0 ? Math.max(0, Math.min(1, (pos - clip.startS) / len)) : 0;

  const backToSource = () => {
    if (!clip?.sourcePath) return;
    router.push(clip.sourcePath);
    // Once the source page has drawn its slot, bring it into view.
    let tries = 0;
    const find = () => {
      const el = slotFor(clip.key);
      if (el) el.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      else if (tries++ < 40) window.setTimeout(find, 100);
    };
    window.setTimeout(find, 50);
  };

  return (
    <div ref={layerRef} className={`pl pl--${mode}`} role={mode === "mini" ? "region" : undefined} aria-label={mode === "mini" ? "Now playing" : undefined}>
      <div className="pl__stage" ref={stageRef}>
        <div className="pl__video" ref={hostRef} />
        {clip && mode !== "off" && <PlayerControls clip={clip} pos={pos} playing={playing} muted={muted} captions={captions} stageRef={stageRef} />}
      </div>
      {mode === "mini" && clip && (
        <div className="pl__mini">
          <button className="pl__pp" type="button" onClick={() => player.toggle()} aria-label={playing ? "Pause" : "Play"}>
            {playing ? <IconPause /> : <IconPlay />}
          </button>
          <div className="pl__tx">
            <div className="pl__title">{clip.title}</div>
            <div className="pl__sub"><span className="ts">{fmtTime(pos)}</span> · {clip.episode}</div>
            <div className="pl__links">
              {clip.sourcePath && <button type="button" className="pl__back" onClick={backToSource}>Back to source ↗</button>}
              <a className="pl__yt" href={youtubeAt(clip.videoId, pos)} target="_blank" rel="noopener noreferrer">
                Open on YouTube <IconExternal />
              </a>
              <button
                type="button"
                className="pl__save"
                onClick={async () => {
                  // The clip's start, like the big player's Copy link.
                  try { await navigator.clipboard.writeText(youtubeAt(clip.videoId, clip.startS)); } catch {}
                  toast("Timestamp link copied");
                }}
              >
                <IconLink />Copy link
              </button>
              <button type="button" className="pl__save" onClick={save} aria-pressed={saved} disabled={saved}>
                <IconBookmark />{saved ? "Saved" : "Save"}
              </button>
            </div>
          </div>
          <button className="ib" type="button" onClick={() => player.close()} aria-label="Close player"><IconX /></button>
          {queue && (
            <div className="pl__q">
              <button className="pl__qbtn" type="button" onClick={() => player.prev()} aria-label="Previous moment"><IconPrev /></button>
              <span className="pl__qtx">
                {switching ? `Next: ${switching}…` : `${queue.index + 1} of ${queue.clips.length} · ${clip.guest}`}
              </span>
              <button className="pl__qbtn" type="button" onClick={() => player.next()} disabled={queue.index >= queue.clips.length - 1} aria-label="Next moment"><IconNext /></button>
              <span className="sr" role="status" aria-live="polite">{`Playing ${queue.index + 1} of ${queue.clips.length}, ${clip.guest}`}</span>
            </div>
          )}
          <div
            className="track pl__track"
            role="slider"
            tabIndex={0}
            aria-label="Seek"
            aria-valuemin={0}
            aria-valuemax={Math.round(len)}
            aria-valuenow={Math.round(pos - clip.startS)}
            aria-valuetext={`${fmtTime(pos - clip.startS)} of ${fmtTime(len)}`}
            onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); player.seekFraction((e.clientX - r.left) / r.width); }}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight") player.seekFraction(frac + 5 / len);
              else if (e.key === "ArrowLeft") player.seekFraction(frac - 5 / len);
            }}
          >
            <span style={{ width: `${frac * 100}%` }} />
          </div>
        </div>
      )}
    </div>
  );
}
