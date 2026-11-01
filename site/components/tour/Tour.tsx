"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type TouchEvent } from "react";
import { useRouter } from "next/navigation";
import { player } from "@/components/player/store";
import { TOUR_OPENED_EVENT, TOUR_SLIDES } from "@/lib/tour";
import pinData from "@/public/tour/pins.json";
import { placeBadges } from "./place";
import "./tour.css";

/** A screenshot and the boxes the callouts point at, as fractions of the picture (public/tour/pins.json). */
type ShotData = { width: number; height: number; pins: { n: number; x: number; y: number; w: number; h: number }[] };
type Pins = Record<string, Partial<Record<"d" | "p", ShotData>>>;
const PINS = pinData as unknown as Pins;
const N = TOUR_SLIDES.length;

/** Phones get the phone screenshots; the same query switches the pictures in CSS. */
const PHONE = "(max-width: 700px)";
const subscribePhone = (cb: () => void) => { const m = window.matchMedia(PHONE); m.addEventListener("change", cb); return () => m.removeEventListener("change", cb); };
const isPhone = () => window.matchMedia(PHONE).matches;

/** One screenshot: the picture, an outline around each target and its number just outside the outline. */
function Shot({ id, alt, d, p, phone, eager }: { id: string; alt: string; d: ShotData; p: ShotData; phone: boolean; eager: boolean }) {
  const frame = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const v = phone ? p : d;
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ w: e.contentRect.width, h: e.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const badges = useMemo(
    () => (size.w > 0 ? placeBadges(v.pins.map((t) => ({ n: t.n, x: t.x * size.w, y: t.y * size.h, w: t.w * size.w, h: t.h * size.h })), size.w, size.h, phone ? 20 : 24) : []),
    [v, size, phone],
  );
  return (
    <div ref={frame} className="tr-shot" style={{ "--ard": d.width / d.height, "--arp": p.width / p.height } as CSSProperties}>
      <picture>
        <source media={PHONE} srcSet={`/tour/${id}-p.webp`} width={p.width} height={p.height} />
        <img src={`/tour/${id}-d.webp`} width={d.width} height={d.height} alt={alt} loading={eager ? "eager" : "lazy"} decoding="async" draggable={false} />
      </picture>
      <span className="tr-marks" aria-hidden="true">
        {v.pins.map((t) => (
          <i key={t.n} className="tr-box" style={{ left: `${t.x * 100}%`, top: `${t.y * 100}%`, width: `${t.w * 100}%`, height: `${t.h * 100}%` }} />
        ))}
        {badges.map((b) => <b key={b.n} className="tr-badge" style={{ left: b.left, top: b.top }}>{b.n}</b>)}
      </span>
    </div>
  );
}

/** The welcome tour: a full-screen modal over any page. A native <dialog>, so the browser keeps focus inside it, makes
    the page behind it inert and closes it on Esc. Loaded on demand by TourHost. */
export default function Tour({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const dialog = useRef<HTMLDialogElement>(null);
  const slideEls = useRef<(HTMLElement | null)[]>([]);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const closed = useRef(false);
  const doneBtn = useRef<HTMLButtonElement>(null);
  const [cur, setCur] = useState(0);
  const phone = useSyncExternalStore(subscribePhone, isPhone, () => false);

  const go = useCallback((to: number) => setCur(Math.max(0, Math.min(N - 1, to))), []);
  const close = useCallback(() => dialog.current?.close(), []);
  // Fires for every way out: Done, Skip, Try it and Esc.
  const finished = useCallback(() => {
    if (closed.current) return;
    closed.current = true;
    onClose();
  }, [onClose]);

  // Opens as a modal; whatever is playing stops, and a page that plays on its own (Reels) is told to pause.
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    player.pause();
    if (!d.open) d.showModal();
    window.dispatchEvent(new Event(TOUR_OPENED_EVENT));
    return () => {
      closed.current = true;
      if (d.open) d.close();
    };
  }, []);

  // Keys belong to the tour while it is open: nothing behind it (Reels, quick search) sees them.
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey && !e.ctrlKey && !e.altKey) {
        if (e.key === "ArrowRight") { go(cur + 1); e.preventDefault(); }
        else if (e.key === "ArrowLeft") { go(cur - 1); e.preventDefault(); }
        else if (e.key === "Home") { go(0); e.preventDefault(); }
        else if (e.key === "End") { go(N - 1); e.preventDefault(); }
      }
      e.stopPropagation();
    };
    d.addEventListener("keydown", onKey);
    return () => d.removeEventListener("keydown", onKey);
  }, [cur, go]);

  useEffect(() => { slideEls.current[cur]?.scrollTo({ top: 0 }); }, [cur]);
  // The Next button turns into Done on the last slide; keep the keyboard focus on the button that is there.
  useEffect(() => { if (cur === N - 1) doneBtn.current?.focus(); }, [cur]);

  const onTouchStart = (e: TouchEvent) => { touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; };
  const onTouchEnd = (e: TouchEvent) => {
    const s = touch.current;
    touch.current = null;
    if (!s) return;
    const dx = e.changedTouches[0].clientX - s.x, dy = e.changedTouches[0].clientY - s.y;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.3) go(cur + (dx < 0 ? 1 : -1));
  };

  const tryIt = (href: string) => { close(); router.push(href); };
  const last = cur === N - 1;

  return (
    <dialog
      ref={dialog}
      className="tr"
      aria-label="Welcome tour"
      aria-modal="true"
      onClose={finished}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      <div className="tr-top">
        <p className="tr-count num" aria-hidden="true">{cur + 1} / {N}</p>
        <button className="tr-skip" type="button" onClick={close}>Skip tour</button>
      </div>
      <div className="tr-stage">
        <div className="tr-prog" style={{ width: `${((cur + 1) / N) * 100}%` }} aria-hidden="true" />
        <div className="tr-track" style={{ transform: `translateX(${-cur * 100}%)` }}>
          {TOUR_SLIDES.map((s, i) => {
            const d = PINS[s.id]?.d, p = PINS[s.id]?.p;
            return (
              <section
                key={s.id}
                ref={(el) => { slideEls.current[i] = el; }}
                className={`tr-slide${i === cur ? " on" : ""}`}
                role="group"
                aria-roledescription="slide"
                aria-label={`${i + 1} of ${N}: ${s.title}`}
                inert={i !== cur}
              >
                <div className="tr-in">
                  <div className="tr-text">
                    <p className="tr-k">{s.kicker}</p>
                    <h2 className="tr-t">{s.title}</h2>
                    <p className="tr-tag">{s.purpose}</p>
                    <ol className="tr-calls">
                      {s.callouts.map((c, k) => (
                        <li key={c}><b aria-hidden="true">{k + 1}</b><span>{c}</span></li>
                      ))}
                    </ol>
                    <div className="tr-act">
                      <button className="pill pill--primary" type="button" onClick={() => tryIt(s.tryIt.href)}>{s.tryIt.label}</button>
                    </div>
                    {i === 0 && <p className="tr-fine">Unofficial project, not affiliated with Figuring Out. Every answer links to its source.</p>}
                    {i === N - 1 && <p className="tr-fine">Reopen anytime from ? Tour.</p>}
                  </div>
                  {d && p && <Shot id={s.id} alt={s.alt} d={d} p={p} phone={phone} eager={i <= 1} />}
                </div>
              </section>
            );
          })}
        </div>
      </div>

      <div className="tr-ctrl">
        <button className="tr-nav" type="button" onClick={() => go(cur - 1)} disabled={cur === 0} aria-label="Previous slide">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
        </button>
        <div className="tr-dots" role="group" aria-label="Slides">
          {TOUR_SLIDES.map((s, i) => (
            <button key={s.id} className="tr-dot" type="button" aria-current={i === cur} aria-label={`Go to slide ${i + 1}: ${s.title}`} onClick={() => go(i)} />
          ))}
        </div>
        {last ? (
          <button ref={doneBtn} className="pill pill--primary tr-done" type="button" onClick={close}>Done</button>
        ) : (
          <button className="tr-nav" type="button" onClick={() => go(cur + 1)} aria-label="Next slide" autoFocus>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7" /></svg>
          </button>
        )}
      </div>
      <p className="sr" role="status" aria-live="polite">Slide {cur + 1} of {N}: {TOUR_SLIDES[cur].title}</p>
    </dialog>
  );
}
