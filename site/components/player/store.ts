// One player for the whole app: the current clip, its position and whether it is playing, plus the single
// YouTube iframe (youtube-nocookie.com, IFrame Player API). The iframe is created once inside the fixed
// layer (PlayerLayer) and never moved; pages only register empty "slots" the layer can sit over.
import { useSyncExternalStore } from "react";
import { toast } from "@/lib/toast";
import type { Clip } from "@/lib/player-types";

export type PlayerState = {
  clip: Clip | null;
  /** Current time in the video, in seconds. */
  pos: number;
  playing: boolean;
  /** Bumped whenever a slot mounts or unmounts, so the layer re-checks where to sit. */
  slots: number;
  muted: boolean;
  /** Captions shown (YouTube's captions module, switched with the IFrame API). */
  captions: boolean;
};

const initial: PlayerState = { clip: null, pos: 0, playing: false, slots: 0, muted: false, captions: false };
let state = initial;
const listeners = new Set<() => void>();
function set(patch: Partial<PlayerState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export function usePlayer(): PlayerState {
  return useSyncExternalStore(subscribe, () => state, () => initial);
}
export const getPlayer = () => state;

/** Only the current clip: pages with many items use this so they re-render when the clip changes, not on every
    position tick of the playing video. */
export function usePlayerClip(): Clip | null {
  return useSyncExternalStore(subscribe, () => state.clip, () => null);
}

/* ---------- slots: page placeholders the fixed layer sits over ---------- */
const slotEls = new Map<string, HTMLElement>();
export function registerSlot(key: string, el: HTMLElement) {
  slotEls.set(key, el);
  set({ slots: state.slots + 1 });
  return () => {
    if (slotEls.get(key) === el) slotEls.delete(key);
    set({ slots: state.slots + 1 });
  };
}
export const slotFor = (key: string | undefined) => (key ? slotEls.get(key) ?? null : null);

/* ---------- YouTube IFrame Player API ---------- */
type YTPlayer = {
  loadVideoById(o: { videoId: string; startSeconds: number }): void;
  cueVideoById(o: { videoId: string; startSeconds: number }): void;
  playVideo(): void;
  pauseVideo(): void;
  stopVideo(): void;
  seekTo(s: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  mute(): void;
  unMute(): void;
  isMuted(): boolean;
  /** Captions module (loadModule / unloadModule / getOption are undocumented but work on embeds). */
  loadModule?(name: string): void;
  unloadModule?(name: string): void;
  getOption?(module: string, option: string): unknown;
};
type YTNamespace = {
  Player: new (el: HTMLElement, opts: Record<string, unknown>) => YTPlayer;
  PlayerState: { PLAYING: number; PAUSED: number; ENDED: number; BUFFERING: number };
};
declare global {
  interface Window { YT?: YTNamespace; onYouTubeIframeAPIReady?: () => void }
}

let apiPromise: Promise<YTNamespace> | null = null;
export function loadYouTubeApi(): Promise<YTNamespace> {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    if (window.YT?.Player) return resolve(window.YT);
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(window.YT!); };
    const s = document.createElement("script");
    s.src = "https://www.youtube.com/iframe_api";
    s.async = true;
    s.onerror = () => { apiPromise = null; reject(new Error("Could not load the YouTube player")); };
    document.head.appendChild(s);
  });
  return apiPromise;
}

let host: HTMLElement | null = null;
let yt: YTPlayer | null = null;
let ytReady = false;
let pending: (() => void) | null = null;
let poll = 0;

/** Called once by PlayerLayer with the element the iframe lives in. */
export function setPlayerHost(el: HTMLElement | null) { host = el; }

function startPoll() {
  if (poll) return;
  poll = window.setInterval(() => {
    const c = state.clip;
    if (!yt || !ytReady || !c) return;
    const t = yt.getCurrentTime();
    if (t >= c.endS - 0.05) {
      // Clips stop at end_s.
      yt.pauseVideo();
      set({ pos: c.endS, playing: false });
      stopPoll();
      toast("Clip ended");
      return;
    }
    if (Math.abs(t - state.pos) > 0.05) set({ pos: t });
  }, 200);
}
function stopPoll() { clearInterval(poll); poll = 0; }

async function withPlayer(clip: Clip, autoplay: boolean, then?: () => void) {
  const YT = await loadYouTubeApi();
  if (!host) return;
  if (!yt) {
    const mount = document.createElement("div");
    host.appendChild(mount);
    pending = then ?? null;
    yt = new YT.Player(mount, {
      host: "https://www.youtube-nocookie.com",
      width: "100%",
      height: "100%",
      videoId: clip.videoId,
      playerVars: {
        start: Math.floor(clip.startS),
        autoplay: autoplay ? 1 : 0,
        // YouTube's own controls and overlays are off; Cuepoint draws its own (PlayerControls). The watermark stays.
        controls: 0,
        disablekb: 1,
        iv_load_policy: 3,
        fs: 0,
        playsinline: 1,
        rel: 0,
        modestbranding: 1,
        origin: window.location.origin,
      },
      events: {
        onReady: () => {
          ytReady = true;
          set({ muted: yt!.isMuted() });
          yt!.seekTo(clip.startS, true);
          if (autoplay) yt!.playVideo();
          const p = pending; pending = null; p?.();
        },
        onStateChange: (e: { data: number }) => {
          if (e.data === YT.PlayerState.PLAYING) { set({ playing: true }); startPoll(); }
          else if (e.data === YT.PlayerState.PAUSED || e.data === YT.PlayerState.ENDED) {
            set({ playing: false, pos: yt!.getCurrentTime() });
            stopPoll();
          }
        },
      },
    });
    return;
  }
  if (!ytReady) { pending = then ?? null; return; }
  if (autoplay) yt.loadVideoById({ videoId: clip.videoId, startSeconds: clip.startS });
  else yt.cueVideoById({ videoId: clip.videoId, startSeconds: clip.startS });
  then?.();
}

/** Captions belong to the loaded video, so they are switched off when another video is played. */
function resetCaptions(nextVideoId: string) {
  if (!state.captions || state.clip?.videoId === nextVideoId) return;
  try { yt?.unloadModule?.("captions"); } catch {}
  set({ captions: false });
}

/* ---------- actions ---------- */
export const player = {
  /** Plays a clip (or resumes it if it is already the current one). */
  play(clip?: Clip) {
    const c = clip ?? state.clip;
    if (!c) return;
    if (state.clip?.key === c.key && yt && ytReady) {
      if (state.pos >= c.endS - 0.3 || state.pos < c.startS - 1) yt.seekTo(c.startS, true);
      yt.playVideo();
      return;
    }
    stopPoll();
    resetCaptions(c.videoId);
    set({ clip: c, pos: c.startS, playing: false });
    void withPlayer(c, true).catch(() => toast("Couldn't load the YouTube player. Try again."));
  },
  pause() { if (yt && ytReady) yt.pauseVideo(); },
  toggle(clip?: Clip) {
    if (state.playing && (!clip || clip.key === state.clip?.key)) player.pause();
    else player.play(clip);
  },
  /** Seek to a fraction (0..1) of the current clip. */
  seekFraction(f: number, clip?: Clip) {
    const c = clip ?? state.clip;
    if (!c) return;
    const t = c.startS + Math.max(0, Math.min(1, f)) * (c.endS - c.startS);
    if (state.clip?.key !== c.key) {
      stopPoll();
      resetCaptions(c.videoId);
      set({ clip: c, pos: t, playing: false });
      void withPlayer(c, true, () => yt?.seekTo(t, true)).catch(() => toast("Couldn't load the YouTube player. Try again."));
      return;
    }
    set({ pos: t });
    if (yt && ytReady) yt.seekTo(t, true);
  },
  toggleMute() {
    if (!yt || !ytReady) return;
    if (yt.isMuted()) yt.unMute(); else yt.mute();
    set({ muted: yt.isMuted() });
  },
  /** Captions on or off. If the video turns out to have none, they go back off with a toast. */
  toggleCaptions() {
    if (!yt || !ytReady) return;
    const on = !state.captions;
    set({ captions: on });
    try {
      if (!on) { yt.unloadModule?.("captions"); return; }
      yt.loadModule?.("captions");
      window.setTimeout(() => {
        const tracks = yt?.getOption?.("captions", "tracklist");
        // The track list is only reliable while the video plays; a paused video is left with captions on.
        if (state.captions && state.playing && Array.isArray(tracks) && tracks.length === 0) {
          yt?.unloadModule?.("captions");
          set({ captions: false });
          toast("This video has no captions");
        }
      }, 4000); // the captions module can take a few seconds to list the tracks
    } catch {
      set({ captions: false });
    }
  },
  close() {
    stopPoll();
    if (yt && ytReady) yt.stopVideo();
    set({ clip: null, pos: 0, playing: false });
  },
};
