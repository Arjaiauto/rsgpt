"use client";

import { useCallback, useSyncExternalStore } from "react";
import type { Clip } from "@/lib/player-types";
import { saveWithUndo } from "@/lib/save-client";
import { clipRefOf } from "@/lib/saved-types";

/** Save for a playing clip, shared by the big player card and the mini player: the clip at its start and end with its
    guest, episode and date (what /saved shows), through the same saveItem action and Undo toast. Which clips were saved
    in this tab is kept in one place, so a clip saved from the card reads "Saved" in the mini player too. The key is the
    clip's own (a player slot's), so the same moment reached from another place can still be saved again. */
const savedKeys = new Set<string>();
const listeners = new Set<() => void>();
const mark = (key: string, on: boolean) => {
  if (on) savedKeys.add(key); else savedKeys.delete(key);
  listeners.forEach((l) => l());
};
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export function useClipSave(clip: Clip | null): { saved: boolean; save: () => Promise<void> } {
  const saved = useSyncExternalStore(subscribe, () => !!clip && savedKeys.has(clip.key), () => false);
  const save = useCallback(async () => {
    if (!clip || savedKeys.has(clip.key)) return;
    const key = clip.key;
    mark(key, true);
    const ok = await saveWithUndo(
      { kind: "clip", ref: clipRefOf(clip) },
      "Clip saved",
      () => mark(key, false),
    );
    if (!ok) mark(key, false);
  }, [clip]);
  return { saved, save };
}
