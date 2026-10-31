"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode, type TouchEvent } from "react";
import { player } from "@/components/player/store";
import { CLOSING, CONTEXT_MOMENT, FEATURES, LIVE_TODAY, SLIDES, type Feature, type Glyph } from "@/lib/future-deck";
import { fmtTime, youtubeAt, type Clip } from "@/lib/player-types";

/** Inner SVG of each flow icon (24 x 24, stroked). */
const GLYPHS: Record<Glyph, ReactNode> = {
  upload: <><path d="M12 16V4M7 9l5-5 5 5" /><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" /></>,
  wave: <path d="M4 12h2M8 8v8M12 5v14M16 8v8M20 12h-2" />,
  brain: <><path d="M9 4a3 3 0 0 0-3 3v1a3 3 0 0 0-2 5 3 3 0 0 0 3 5h2V4z" /><path d="M15 4a3 3 0 0 1 3 3v1a3 3 0 0 1 2 5 3 3 0 0 1-3 5h-2V4z" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4-4" /></>,
  doc: <><rect x="5" y="4" width="14" height="16" rx="2" /><path d="M9 9h6M9 13h6M9 17h3" /></>,
  globe: <><circle cx="12" cy="12" r="8" /><path d="M4 12h16M12 4a12 12 0 0 1 0 16M12 4a12 12 0 0 0 0 16" /></>,
  flag: <path d="M5 21V4M5 4h11l-2 4 2 4H5" />,
  clip: <><rect x="3.5" y="6" width="17" height="12" rx="2" /><path d="M10.5 9.5v5l4-2.5z" /></>,
  mic: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M6 11a6 6 0 0 0 12 0M12 17v4" /></>,
  tablet: <><rect x="5" y="3" width="14" height="18" rx="2" /><path d="M11 18h2" /></>,
  pen: <><path d="M4 20l4-1 11-11-3-3L5 16z" /><path d="M14 6l3 3" /></>,
  check: <path d="M5 12l4 4L19 7" />,
  map: <><path d="M4 6l5-2 6 2 5-2v14l-5 2-6-2-5 2z" /><path d="M9 4v14M15 6v14" /></>,
  user: <><circle cx="12" cy="8.5" r="3.5" /><path d="M5 20a7 7 0 0 1 14 0" /></>,
  chat: <path d="M5 5h14v10H9l-4 4z" />,
  chart: <path d="M5 19V9M12 19V5M19 19v-7" />,
  lang: <><path d="M4 6h9M8.5 4v2M6 6c1 4 4 7 7 8M11 6c-1 4-4 7-7 8" /><path d="M14 20l3.5-8 3.5 8M15.3 17h4.4" /></>,
  tag: <><path d="M4 12V4h8l8 8-8 8z" /><circle cx="8.5" cy="8.5" r="1.5" /></>,
  shield: <><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" /><path d="M9 12l2 2 4-4" /></>,
};

const Svg = ({ children }: { children: ReactNode }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
);

const N = SLIDES.length;
const HASH = /^#slide-(\d{1,3})$/;
const fromHash = (hash: string): number | null => {
  const m = HASH.exec(hash);
  const n = m ? Number(m[1]) : NaN;
  return n >= 1 && n <= N ? n - 1 : null;
};
const contextClip: Clip = {
  key: CONTEXT_MOMENT.key, itemType: "episode", itemId: CONTEXT_MOMENT.videoId, videoId: CONTEXT_MOMENT.videoId, startS: CONTEXT_MOMENT.startS,
  endS: CONTEXT_MOMENT.endS, title: CONTEXT_MOMENT.episode, guest: CONTEXT_MOMENT.guest, episode: CONTEXT_MOMENT.episode, date: CONTEXT_MOMENT.date, sourcePath: "/future",
};

function FeatureSlide({ f, n }: { f: Feature; n: number }) {
  return (
    <div className="fu-in">
      <div>
        <p className="fu-k"><b>{n}</b>Future update</p>
        <h2 className="fu-t">{f.title}</h2>
        <p className="fu-tag">{f.tag}</p>
        <div className="fu-facts">
          <div className="fu-f"><span>Problem</span><div>{f.problem}</div></div>
          <div className="fu-f"><span>How</span><div>{f.how}</div></div>
        </div>
        <div className="fu-chips">
          <span className="fu-chip">{f.who}</span>
          <span className="fu-chip fu-chip--time">About {f.time} to build</span>
        </div>
      </div>
      <div className="fu-viz">
        <ol className="fu-flow">
          {f.steps.map((s) => (
            <li className="fu-step" key={s.title}>
              <span className="fu-ic"><Svg>{GLYPHS[s.icon]}</Svg></span>
              <div><b>{s.title}</b><small>{s.note}</small></div>
            </li>
          ))}
        </ol>
        {f.compare && (
          <table className="fu-table">
            <thead>
              <tr><td /><th scope="col" className="fu-th-demo">In this demo</th><th scope="col" className="fu-th-team">With raw files</th></tr>
            </thead>
            <tbody>
              {f.compare.map((c) => (
                <tr key={c.label}>
                  <th scope="row">{c.label}</th>
                  <td>{c.demo}</td>
                  <td>{c.team}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {f.illustration && (
          <>
            <div className="fu-cmp">
              <div className="fu-bad"><i>Illustration: the reposted clip</i>{f.illustration.clip}</div>
              <div className="fu-good"><i>Illustration: the full moment</i>{f.illustration.full}</div>
            </div>
            <p className="fu-fine">An invented example, not a real quote.</p>
            <div className="fu-note">
              This worry is in the archive: a guest raises it and the host agrees it is a valid fear.{" "}
              <a
                className="fu-cite"
                href={youtubeAt(contextClip.videoId, contextClip.startS)}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => {
                  if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
                  e.preventDefault();
                  player.play(contextClip);
                }}
              >
                {CONTEXT_MOMENT.guest} · {CONTEXT_MOMENT.date} · {fmtTime(CONTEXT_MOMENT.startS)}
              </a>
            </div>
          </>
        )}
        {f.note && <div className="fu-note">{f.note}</div>}
        {f.built && (
          <div className="fu-built">
            <p className="fu-builtk"><Svg><path d="M5 12l4 4L19 7" /></Svg>Already in this demo</p>
            <div className="fu-builtbody">
              <p>{f.built.text}</p>
              <div className="fu-links">
                {f.built.links.map((l) => <Link key={l.label} href={l.href}>{l.label}</Link>)}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function FutureDeck() {
  const [cur, setCur] = useState(0);
  // The first placement from the URL hash happens without sliding.
  const [still, setStill] = useState(true);
  const slideRefs = useRef<(HTMLElement | null)[]>([]);
  const touch = useRef<{ x: number; y: number } | null>(null);

  const go = useCallback((to: number) => {
    const i = Math.max(0, Math.min(N - 1, to));
    setCur(i);
    try { window.history.replaceState(null, "", `#slide-${i + 1}`); } catch {}
  }, []);

  // A link to #slide-N opens that slide; editing the hash by hand moves the deck too.
  useEffect(() => {
    const apply = () => { const i = fromHash(window.location.hash); if (i !== null) setCur(i); };
    apply();
    const raf = requestAnimationFrame(() => setStill(false));
    window.addEventListener("hashchange", apply);
    return () => { cancelAnimationFrame(raf); window.removeEventListener("hashchange", apply); };
  }, []);

  useEffect(() => { slideRefs.current[cur]?.scrollTo({ top: 0 }); }, [cur]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // Leave arrow keys to typing, the players' seek bars and any open dialog.
      if ((e.target as HTMLElement | null)?.closest?.("input, textarea, select, [contenteditable], [role=slider], dialog")) return;
      if (e.key === "ArrowRight") go(cur + 1);
      else if (e.key === "ArrowLeft") go(cur - 1);
      else if (e.key === "Home") go(0);
      else if (e.key === "End") go(N - 1);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cur, go]);

  const onTouchStart = (e: TouchEvent) => { touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; };
  const onTouchEnd = (e: TouchEvent) => {
    const s = touch.current;
    touch.current = null;
    if (!s) return;
    const dx = e.changedTouches[0].clientX - s.x, dy = e.changedTouches[0].clientY - s.y;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.3) go(cur + (dx < 0 ? 1 : -1));
  };

  return (
    <div
      className={`fu-deck${still ? " fu-still" : ""}`}
      role="region"
      aria-roledescription="carousel"
      aria-label="Future updates"
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      <div className="fu-stage">
      <div className="fu-prog" style={{ width: `${((cur + 1) / N) * 100}%` }} aria-hidden="true" />
      <div className="fu-track" style={{ transform: `translateX(${-cur * 100}%)` }}>
        {SLIDES.map((s, i) => (
          <section
            key={s.title}
            ref={(el) => { slideRefs.current[i] = el; }}
            // Not an id: an element called slide-4 would make the browser scroll to it when the URL says #slide-4,
            // sliding the stage sideways and the page down. The deck places itself from the hash instead.
            data-slide={i + 1}
            className={`fu-slide${i === cur ? " on" : ""}${s.kind === "feature" ? "" : ` fu-slide--${s.kind}`}`}
            role="group"
            aria-roledescription="slide"
            aria-label={`${i + 1} of ${N}: ${s.title}`}
            inert={i !== cur}
          >
            {s.kind === "intro" && (
              <div className="fu-in">
                <div>
                  <p className="fu-k">Future updates</p>
                  <h1 className="fu-big">What Cuepoint<span>could do next</span></h1>
                  <p className="fu-tag fu-tag--wide">
                    {FEATURES.length} ideas for a team version, each starting from a real problem. Pick any one to see how it would work and how long it would take.
                  </p>
                  <div className="fu-live" aria-label="Already working in this demo">
                    <p className="fu-livek"><Svg><path d="M5 12l4 4L19 7" /></Svg>Already working in this demo</p>
                    <div className="fu-links">
                      {LIVE_TODAY.map((l) => <Link key={l.label} href={l.href}>{l.label}</Link>)}
                    </div>
                  </div>
                  <p className="fu-sub">Ideas for a team version</p>
                  <div className="fu-grid">
                    {FEATURES.map((f, k) => (
                      <button className="fu-tile" type="button" key={f.title} onClick={() => go(k + 1)}>
                        <b>{String(k + 1).padStart(2, "0")}</b>{f.title}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
            {s.kind === "feature" && s.feature && <FeatureSlide f={s.feature} n={s.n!} />}
            {s.kind === "close" && (
              <div className="fu-in">
                <div>
                  <p className="fu-k">Next step</p>
                  <h2 className="fu-big">{CLOSING.title}<span>{CLOSING.soft}</span></h2>
                  <div className="fu-offer">
                    {CLOSING.offer.map((p) => <p key={p}>{p}</p>)}
                    <p className="fu-fine">{CLOSING.disclaimer}</p>
                  </div>
                </div>
              </div>
            )}
          </section>
        ))}
      </div>
      </div>

      <div className="fu-ctrl">
        <button className="fu-nav" type="button" onClick={() => go(cur - 1)} disabled={cur === 0} aria-label="Previous slide">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>
        </button>
        <div className="fu-dots" role="group" aria-label="Slides">
          {SLIDES.map((s, i) => (
            <button key={s.title} className="fu-dot" type="button" aria-current={i === cur} aria-label={`Go to slide ${i + 1}: ${s.title}`} onClick={() => go(i)} />
          ))}
        </div>
        <p className="fu-count num" aria-hidden="true">{cur + 1} / {N}</p>
        <button className="fu-nav" type="button" onClick={() => go(cur + 1)} disabled={cur === N - 1} aria-label="Next slide">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M9 5l7 7-7 7" /></svg>
        </button>
        <p className="fu-num num" aria-hidden="true">{cur + 1} / {N}</p>
      </div>
      <p className="sr" role="status" aria-live="polite">Slide {cur + 1} of {N}: {SLIDES[cur].title}</p>
    </div>
  );
}
