"use client";

import { IconPause, IconPlay } from "@/components/Icons";
import { player, usePlayer } from "@/components/player/store";
import type { BestClip } from "@/lib/insights-types";
import type { Clip } from "@/lib/player-types";

/** Plays a best clip in the shared player (the mini player; Insights has no big player of its own). */
export function PlayClip({ c }: { c: BestClip }) {
  const { clip, playing } = usePlayer();
  const on = clip?.key === `clip:${c.id}` && playing;
  const toClip = (): Clip => ({
    key: `clip:${c.id}`, itemType: "clip", itemId: String(c.id), videoId: c.videoId, startS: c.startS, endS: c.endS,
    title: c.topic, guest: c.guest, episode: c.episode, date: c.date, sourcePath: null,
  });
  return (
    <button className="in-play" type="button" aria-label={`${on ? "Pause" : "Play"} clip: ${c.topic}`} aria-pressed={on} onClick={() => player.toggle(toClip())}>
      {on ? <IconPause /> : <IconPlay />}
    </button>
  );
}
