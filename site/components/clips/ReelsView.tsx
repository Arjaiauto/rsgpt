"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { moreClips, savedClipMarks } from "@/app/actions/clips";
import { IconBookmark, IconExternal, IconLink, IconPlay, IconX } from "@/components/Icons";
import { loadYouTubeApi, player } from "@/components/player/store";
import { markClipSaved, useClipSave } from "@/components/player/useClipSave";
import { clipQuery, type ClipCard, type ClipParams } from "@/lib/clip-types";
import { fmtTime, youtubeAt, type Clip } from "@/lib/player-types";
import { toast } from "@/lib/toast";
import { ReelCover } from "./ReelCover";

/** Reels mode (/clips/reels): the clips of the current filters as a full-screen vertical feed, one reel per screen with
    CSS scroll-snap. Only the current reel holds a playing YouTube player and the next one a cued one (two at most);
    every other reel is its cover. Each player plays its clip from start to end, cropped to fill 9:16 (or fitted, for
    two-person shots), then the feed moves on. Browsers allow sound only after a tap, so the first reel asks for one. */

type YTReel = {
  playVideo(): void; pauseVideo(): void; seekTo(s: number, ahead: boolean): void; getCurrentTime(): number;
  getPlayerState(): number; mute(): void; unMute(): void; destroy(): void;
};
type ReelApi = { playNow: () => void };
const PLAYING = 1, BUFFERING = 3;

/** One tap per page load is enough: after it, moving to another guest's feed keeps sound on. */
let tappedOnce = false;

const toClip = (c: ClipCard): Clip => ({
  key: `clip:${c.id}`, itemType: "clip", itemId: String(c.id), videoId: c.videoId, startS: c.startS, endS: c.endS,
  title: c.topic, guest: c.guest, episode: c.episode, date: c.date, sourcePath: null,
});

/* ---------- the video of one reel ---------- */

function ReelVideo({ card, mode, started, muted, paused, auto, onEnded, onBlocked, register }: {
  card: ClipCard; mode: "play" | "cue"; started: boolean; muted: boolean; paused: boolean; auto: boolean;
  onEnded: () => void; onBlocked: () => void; register: (api: ReelApi | null) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLSpanElement | null>(null);
  const yt = useRef<YTReel | null>(null);
  const [ready, setReady] = useState(false);
  const [state, setState] = useState<"loading" | "ready" | "playing" | "paused">("loading");
  const ended = useRef(false);
  const live = useRef({ mode, started, muted, paused, auto, onEnded });
  useEffect(() => { live.current = { mode, started, muted, paused, auto, onEnded }; });

  // One YouTube player for the life of this reel's "live" window; destroyed when the reel leaves it.
  useEffect(() => {
    let gone = false;
    const t0 = performance.now();
    loadYouTubeApi().then((YT) => {
      if (gone || !host.current) return;
      const mount = document.createElement("div");
      host.current.appendChild(mount);
      yt.current = new YT.Player(mount, {
        host: "https://www.youtube-nocookie.com",
        width: "100%",
        height: "100%",
        videoId: card.videoId,
        playerVars: {
          start: Math.floor(card.startS), end: Math.ceil(card.endS) + 1, autoplay: 0, mute: live.current.muted ? 1 : 0,
          controls: 0, disablekb: 1, iv_load_policy: 3, fs: 0, playsinline: 1, rel: 0, modestbranding: 1, origin: window.location.origin,
        },
        events: {
          onReady: () => {
            if (gone) return;
            wrap.current?.setAttribute("data-ready-ms", String(Math.round(performance.now() - t0)));
            yt.current!.seekTo(card.startS, true);
            if (live.current.mode !== "play" || !live.current.started) yt.current!.pauseVideo();
            setReady(true);
            setState("ready");
          },
          onStateChange: (e: { data: number }) => {
            if (gone) return;
            if (e.data === PLAYING) setState("playing");
            else if (e.data === 2) setState("paused");
          },
        },
      }) as unknown as YTReel;
    }).catch(() => toast("Couldn't load the YouTube player. Try again."));
    return () => {
      gone = true;
      try { yt.current?.destroy(); } catch {}
      yt.current = null;
    };
  }, [card.videoId, card.startS, card.endS]);

  // Play in the same call as the tap, so the browser lets sound through (the "Tap to start" overlay calls this).
  useEffect(() => {
    register({ playNow: () => { const p = yt.current; if (!p) return; p.seekTo(card.startS, true); if (!live.current.muted) p.unMute(); p.playVideo(); } });
    return () => register(null);
  }, [register, card.startS]);

  // Play, pause or stay cued as the feed moves.
  useEffect(() => {
    const p = yt.current;
    if (!ready || !p) return;
    if (mode === "play" && started && !paused) {
      const at = p.getCurrentTime();
      if (at < card.startS - 1 || at >= card.endS - 0.3) p.seekTo(card.startS, true);
      ended.current = false;
      p.playVideo();
      // Sound blocked (no tap counted for this frame, e.g. on iOS): play muted rather than not at all.
      const check = window.setTimeout(() => {
        const s = yt.current?.getPlayerState();
        if (live.current.mode === "play" && !live.current.paused && s !== PLAYING && s !== BUFFERING) {
          yt.current?.mute();
          yt.current?.playVideo();
          onBlocked();
        }
      }, 1800);
      return () => window.clearTimeout(check);
    }
    p.pauseVideo();
    if (mode === "cue") p.seekTo(card.startS, true);
  }, [ready, mode, started, paused, card.startS, card.endS, onBlocked]);

  useEffect(() => {
    const p = yt.current;
    if (!ready || !p) return;
    if (muted) p.mute(); else p.unMute();
  }, [ready, muted]);

  // Progress, and the end of the clip: the feed moves on, or the clip starts again when auto-advance is off.
  useEffect(() => {
    if (!ready || mode !== "play") return;
    const id = window.setInterval(() => {
      const p = yt.current;
      if (!p) return;
      const t = p.getCurrentTime();
      const frac = Math.max(0, Math.min(1, (t - card.startS) / (card.endS - card.startS)));
      if (bar.current) bar.current.style.width = `${frac * 100}%`;
      if (t >= card.endS - 0.25 && !ended.current) {
        ended.current = true;
        if (live.current.auto) { p.pauseVideo(); live.current.onEnded(); }
        else { p.seekTo(card.startS, true); ended.current = false; }
      }
    }, 200);
    return () => window.clearInterval(id);
  }, [ready, mode, card.startS, card.endS]);

  return (
    <>
      <div ref={wrap} className="rl-video" data-state={state}><div ref={host} className="rl-host" /></div>
      <span className="rl-prog" aria-hidden="true"><span ref={(el) => { bar.current = el; }} /></span>
    </>
  );
}

/* ---------- one reel ---------- */

const Reel = memo(function Reel({ card, index, total, mode, started, muted, paused, auto, fill, onEnded, onBlocked, register, onTap, onGuest }: {
  card: ClipCard; index: number; total: number; mode: "play" | "cue" | null; started: boolean; muted: boolean; paused: boolean; auto: boolean; fill: boolean;
  onEnded: (i: number) => void; onBlocked: () => void; register: (i: number, api: ReelApi | null) => void; onTap: () => void; onGuest: (slug: string) => void;
}) {
  const clip = toClip(card);
  const { saved, save } = useClipSave(clip);
  const ended = useCallback(() => onEnded(index), [onEnded, index]);
  const reg = useCallback((api: ReelApi | null) => register(index, api), [register, index]);
  const copy = async () => {
    try { await navigator.clipboard.writeText(youtubeAt(card.videoId, card.startS)); } catch {}
    toast("Timestamp link copied");
  };
  return (
    <article className={`rl-item${mode === "play" ? " on" : ""}`} data-index={index} data-clip={card.id} aria-label={`${index + 1} of ${total}: ${card.topic}`}>
      <div className="rl-bg"><ReelCover name={card.guest || card.topic} photo={card.photo} blur /></div>
      <div className={`rl-col${fill ? " fill" : " fit"}`}>
        <div className="rl-cover"><ReelCover name={card.guest || card.topic} photo={card.photo} eager={mode !== null} /></div>
        {mode && (
          <ReelVideo card={card} mode={mode} started={started} muted={muted} paused={paused} auto={auto} onEnded={ended} onBlocked={onBlocked} register={reg} />
        )}
        <button className="rl-tap" type="button" onClick={onTap} aria-label={paused ? "Play" : "Pause"} tabIndex={-1} />
        {mode === "play" && paused && started && <span className="rl-pausemark" aria-hidden="true"><IconPlay /></span>}
        <div className="rl-info">
          <p className="rl-who"><b>{card.guest || "Guest not listed"}</b> · {card.date} · <span className="num">{fmtTime(card.endS - card.startS)}</span></p>
          <p className="rl-topic">{card.topic}</p>
          <p className="rl-cap" lang={card.lang === "hi" ? "hi-Latn" : undefined}>“{card.opening}”</p>
          {card.guestSlug && <button className="rl-more" type="button" onClick={() => onGuest(card.guestSlug!)}>More from this guest</button>}
        </div>
        <div className="rl-rail">
          <button type="button" className="rl-act" onClick={() => void save()} aria-pressed={saved} disabled={saved}><IconBookmark /><span>{saved ? "Saved" : "Save"}</span></button>
          <button type="button" className="rl-act" onClick={() => void copy()}><IconLink /><span>Copy link</span></button>
          <a className="rl-act" href={youtubeAt(card.videoId, card.startS)} target="_blank" rel="noopener noreferrer"><IconExternal /><span>YouTube</span></a>
        </div>
      </div>
    </article>
  );
});

/* ---------- the feed ---------- */

export function ReelsView({ params, initial, next: nextIn, prev: prevIn, startId }: { params: ClipParams; initial: ClipCard[]; next: number | null; prev: number | null; startId: number | null }) {
  const router = useRouter();
  const feed = useRef<HTMLDivElement>(null);
  const [items, setItems] = useState(initial);
  const [next, setNext] = useState(nextIn);
  /** Offset of the page before the first one loaded (null: the top of the list is loaded). */
  const [prev, setPrev] = useState(prevIn);
  /** The clip that was showing when reels were added above it; the feed is put back on it before paint. */
  const anchor = useRef<number | null>(null);
  const itemsRef = useRef(initial);
  const loadingPrev = useRef(false);
  const [cur, setCur] = useState(() => Math.max(0, initial.findIndex((c) => c.id === startId)));
  const [started, setStarted] = useState(tappedOnce);
  const [muted, setMuted] = useState(false);
  const [paused, setPaused] = useState(false);
  const [fill, setFill] = useState(true);
  const [auto, setAuto] = useState(true);
  const apis = useRef(new Map<number, ReelApi>());
  const loading = useRef(false);
  const marks = useRef<Set<string> | null>(null);
  const back = `/clips${clipQuery(params)}`;

  // The site's own player stops here, and the page under the feed does not scroll.
  useEffect(() => {
    player.close();
    document.documentElement.classList.add("rl-lock");
    return () => document.documentElement.classList.remove("rl-lock");
  }, []);

  // Open at the clip the link asked for, without sliding there.
  useLayoutEffect(() => {
    const f = feed.current;
    if (f && cur > 0) f.scrollTop = cur * f.clientHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the first placement
  }, []);

  useEffect(() => {
    savedClipMarks().then((m) => { marks.current = new Set(m); }).catch(() => { marks.current = new Set(); });
  }, []);
  useEffect(() => {
    const m = marks.current;
    if (m) for (const c of items) if (m.has(`${c.videoId}@${Math.round(c.startS)}`)) markClipSaved(`clip:${c.id}`);
  }, [items, cur]);

  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const goTo = useCallback((i: number) => {
    const f = feed.current;
    if (!f) return;
    const to = Math.max(0, Math.min(items.length - 1, i));
    f.scrollTo({ top: to * f.clientHeight, behavior: reduced() ? "auto" : "smooth" });
  }, [items.length]);

  // A mouse wheel or trackpad gesture moves exactly one reel: a single big flick would otherwise fly past several
  // (scroll-snap-stop does not hold against one large wheel delta). Further wheel events wait until the move is done.
  const curRef = useRef(cur);
  useEffect(() => { curRef.current = cur; }, [cur]);
  useEffect(() => {
    const f = feed.current;
    if (!f) return;
    let lockedUntil = 0;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) return; // pinch zoom
      e.preventDefault();
      const now = performance.now();
      if (Math.abs(e.deltaY) < 6 || now < lockedUntil) { if (now < lockedUntil) lockedUntil = now + 220; return; }
      lockedUntil = now + 650;
      goTo(curRef.current + (e.deltaY > 0 ? 1 : -1));
    };
    f.addEventListener("wheel", onWheel, { passive: false });
    return () => f.removeEventListener("wheel", onWheel);
  }, [goTo]);

  // The current reel is the one the snapped feed shows.
  const onScroll = () => {
    const f = feed.current;
    if (!f) return;
    const i = Math.round(f.scrollTop / f.clientHeight);
    if (i !== cur && i >= 0 && i < items.length) { setCur(i); setPaused(false); }
  };

  // Clips added above the current one push everything down: put the feed back on the same reel (before paint, so nothing
  // jumps). The position is set from where that clip now is, not nudged by an amount, because the browser may already
  // have moved it a little to keep its snap point.
  useLayoutEffect(() => {
    itemsRef.current = items;
    const f = feed.current;
    if (anchor.current == null) return;
    const i = items.findIndex((c) => c.id === anchor.current);
    anchor.current = null;
    if (f && i >= 0) {
      f.scrollTop = i * f.clientHeight;
      if (i !== curRef.current) { curRef.current = i; setCur(i); }
    }
  }, [items]);

  // The page before the first one loaded (when Reels opened deep in the list), a few reels before the top.
  useEffect(() => {
    if (prev == null || loadingPrev.current || cur > 5) return;
    loadingPrev.current = true;
    moreClips(params, prev).then((page) => {
      anchor.current = itemsRef.current[curRef.current]?.id ?? null;
      setItems((all) => [...page.items.filter((c) => !all.some((x) => x.id === c.id)), ...all]);
      setPrev(prev > 0 ? Math.max(0, prev - Math.max(1, page.items.length)) : null);
    }).catch(() => toast("Couldn't load more clips.")).finally(() => { loadingPrev.current = false; });
  }, [cur, prev, params, items]);

  // The next page of clips, a few reels before the end.
  useEffect(() => {
    if (next == null || loading.current || cur < items.length - 4) return;
    loading.current = true;
    moreClips(params, next).then((page) => {
      setItems((all) => [...all, ...page.items.filter((c) => !all.some((x) => x.id === c.id))]);
      setNext(page.next);
    }).catch(() => toast("Couldn't load more clips.")).finally(() => { loading.current = false; });
  }, [cur, items.length, next, params]);

  const start = useCallback(() => {
    tappedOnce = true;
    setStarted(true);
    setPaused(false);
    apis.current.get(cur)?.playNow();
  }, [cur]);
  const onTap = useCallback(() => {
    if (!started) start();
    else setPaused((p) => !p);
  }, [started, start]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement | null)?.closest?.("input, textarea, select")) return;
      const k = e.key.toLowerCase();
      if (k === "arrowdown" || k === "j" || k === "pagedown") goTo(cur + 1);
      else if (k === "arrowup" || k === "k" || k === "pageup") goTo(cur - 1);
      else if (k === " ") { if (!started) start(); else setPaused((p) => !p); }
      else if (k === "m") setMuted((m) => !m);
      else if (k === "escape") router.push(back);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cur, goTo, started, start, router, back]);

  const onEnded = useCallback((i: number) => { if (i + 1 < items.length) goTo(i + 1); }, [goTo, items.length]);
  const onBlocked = useCallback(() => setMuted(true), []);
  const register = useCallback((i: number, api: ReelApi | null) => { if (api) apis.current.set(i, api); else apis.current.delete(i); }, []);
  const onGuest = useCallback((slug: string) => router.push(`/clips/reels${clipQuery({ guest: slug, sort: params.sort })}`), [router, params.sort]);

  if (!items.length) {
    return (
      <div className="rl-empty">
        <p>No clips match these filters.</p>
        <Link className="pill pill--primary pill--sm" href={back}>Back to clips</Link>
      </div>
    );
  }

  return (
    <div className="rl-root">
      <div className="rl-feed" ref={feed} onScroll={onScroll} data-current={cur} role="region" aria-label="Reels" aria-roledescription="reel feed">
        {items.map((c, i) => (
          <Reel
            key={c.id}
            card={c}
            index={i}
            total={items.length}
            mode={i === cur ? "play" : i === cur + 1 ? "cue" : null}
            started={started}
            muted={muted}
            paused={paused}
            auto={auto}
            fill={fill}
            onEnded={onEnded}
            onBlocked={onBlocked}
            register={register}
            onTap={onTap}
            onGuest={onGuest}
          />
        ))}
      </div>

      <div className="rl-top">
        <Link className="rl-btn" href={back} aria-label="Close reels and go back to clips"><IconX /></Link>
        <span className="rl-count num" aria-hidden="true">{cur + 1} / {items.length}{next != null ? "+" : ""}</span>
        <button className="rl-btn rl-pill" type="button" onClick={() => setFill((f) => !f)} aria-pressed={!fill} title="Fit shows the whole frame, for two-person shots">{fill ? "Fill" : "Fit"}</button>
        <button className="rl-btn rl-pill" type="button" onClick={() => setAuto((a) => !a)} aria-pressed={auto}>Auto {auto ? "on" : "off"}</button>
        <button className="rl-btn" type="button" onClick={() => setMuted((m) => !m)} aria-label={muted ? "Unmute" : "Mute"} aria-pressed={muted}>
          {muted ? <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" /><path d="M17 9l5 5M22 9l-5 5" /></svg>
            : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" /><path d="M17 8a5 5 0 0 1 0 8M19.5 5.5a8.5 8.5 0 0 1 0 13" /></svg>}
        </button>
      </div>
      <div className="rl-nav" aria-hidden="true">
        <button className="rl-btn" type="button" tabIndex={-1} aria-label="Previous clip" onClick={() => goTo(cur - 1)} disabled={cur === 0}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 15l6-6 6 6" /></svg></button>
        <button className="rl-btn" type="button" tabIndex={-1} aria-label="Next clip" onClick={() => goTo(cur + 1)} disabled={cur >= items.length - 1}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg></button>
      </div>

      {!started && (
        <button className="rl-start" type="button" onClick={start} autoFocus>
          <span className="rl-startpl"><IconPlay /></span>
          <b>Tap to start</b>
          <span>Sound plays after this tap. Swipe or scroll for the next reel.</span>
        </button>
      )}
      {started && paused && <span className="sr" role="status">Paused</span>}
      <p className="sr" role="status" aria-live="polite">Reel {cur + 1} of {items.length}: {items[cur]?.topic}</p>
    </div>
  );
}
