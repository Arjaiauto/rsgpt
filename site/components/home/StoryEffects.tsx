"use client";

import { useEffect } from "react";

const fmt = (v: number, dec: number, suf: string) => (dec ? v.toFixed(dec) : Math.round(v).toLocaleString("en-US")) + suf;

/** Scroll animations for the story sections: the pipeline lights up stage by stage, numbers count up,
    bars grow and the sample answer types in. The server-rendered markup already shows final values. */
export function StoryEffects() {
  useEffect(() => {
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timers: number[] = [];

    function countUp(el: HTMLElement | null) {
      if (!el) return;
      const to = parseFloat(el.dataset.count!), dec = +(el.dataset.dec || 0), suf = el.dataset.suffix || "";
      if (reduce) { el.textContent = fmt(to, dec, suf); return; }
      const t0 = performance.now(), dur = 1100;
      const tick = (now: number) => {
        const k = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - k, 3);
        el.textContent = fmt(to * e, dec, suf);
        if (k < 1) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      timers.push(window.setTimeout(() => { el.textContent = fmt(to, dec, suf); }, dur + 120));
    }

    const seen = new WeakSet<Element>();
    const io = new IntersectionObserver(
      (es) => es.forEach((en) => {
        if (!en.isIntersecting || seen.has(en.target)) return;
        seen.add(en.target);
        const t = en.target as HTMLElement;
        if (t.dataset.count) countUp(t);
        if (t.id === "bars" || t.id === "ins") t.classList.add("play");
      }),
      { threshold: 0.35 },
    );
    document.querySelectorAll("#accuracy [data-count], #inside [data-count], #bars, #ins").forEach((el) => io.observe(el));

    /* scroll-driven pipeline */
    const pipe = document.getElementById("pipe")!, fill = document.getElementById("pipefill")!;
    const stages = [...pipe.querySelectorAll<HTMLElement>(".stage")];
    const lit = new WeakSet<Element>();
    function onScroll() {
      const r = pipe.getBoundingClientRect(), vh = innerHeight;
      const p = reduce ? 1 : Math.max(0, Math.min(1, (vh * 0.78 - r.top) / (r.height + vh * 0.2)));
      fill.style.setProperty("--p", p.toFixed(3));
      stages.forEach((s, i) => {
        const on = p >= i / (stages.length - 1) - 0.001;
        s.classList.toggle("on", on);
        if (on && !lit.has(s)) { lit.add(s); countUp(s.querySelector<HTMLElement>("[data-count]")); }
      });
    }
    let ticking = false;
    const onScrollRaf = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => { ticking = false; onScroll(); });
    };
    addEventListener("scroll", onScrollRaf, { passive: true });
    addEventListener("resize", onScroll);
    onScroll();

    return () => {
      io.disconnect();
      removeEventListener("scroll", onScrollRaf);
      removeEventListener("resize", onScroll);
      timers.forEach(clearTimeout);
    };
  }, []);
  return null;
}
