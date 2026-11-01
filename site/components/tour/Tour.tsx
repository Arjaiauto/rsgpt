"use client";

import { useCallback, useEffect, useRef, useState, type TouchEvent } from "react";
import { useRouter } from "next/navigation";
import { player } from "@/components/player/store";
import { TOUR_OPENED_EVENT, TOUR_SLIDES } from "@/lib/tour";
import pinData from "@/public/tour/pins.json";
import "./tour.css";

type Pins = Record<string, Partial<Record<"d" | "p", { width: number; height: number; pins: { n: number; x: number; y: number }[] }>>>;
const PINS = pinData as unknown as Pins;
const N = TOUR_SLIDES.length;

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
                    <p className="tr-k"><b>{i + 1}</b>{i === 0 ? "Quick tour" : `Page ${i} of ${N - 1}`}</p>
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
                  {d && p && (
                    <div className="tr-shot" style={{ "--ard": `${d.width} / ${d.height}`, "--arp": `${p.width} / ${p.height}` } as React.CSSProperties}>
                      <picture>
                        <source media="(max-width: 700px)" srcSet={`/tour/${s.id}-p.webp`} width={p.width} height={p.height} />
                        <img src={`/tour/${s.id}-d.webp`} width={d.width} height={d.height} alt={s.alt} loading={i <= 1 ? "eager" : "lazy"} decoding="async" draggable={false} />
                      </picture>
                      <span className="tr-pins tr-pins--d" aria-hidden="true">
                        {d.pins.map((x) => <i key={x.n} style={{ left: `${x.x * 100}%`, top: `${x.y * 100}%` }}>{x.n}</i>)}
                      </span>
                      <span className="tr-pins tr-pins--p" aria-hidden="true">
                        {p.pins.map((x) => <i key={x.n} style={{ left: `${x.x * 100}%`, top: `${x.y * 100}%` }}>{x.n}</i>)}
                      </span>
                    </div>
                  )}
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
