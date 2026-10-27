"use client";

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

/* SAMPLE DATA: the real numbers need the analysis step (fair score) and arrive in a later ticket. */
const YEARS = [2022, 2023, 2024, 2025, 2026];
type Row = [name: string, episodes: number, byYear: number[]];
const DATA: Record<"title" | "topic" | "guest", Row[]> = {
  title: [["Money amount", 84, [1.3, 1.5, 1.7, 2.0, 2.1]], ["Has a number", 141, [1.4, 1.5, 1.6, 1.7, 1.6]], ["Guest name first", 203, [1.6, 1.5, 1.4, 1.3, 1.3]], ["Asks a question", 96, [0.9, 1.0, 1.1, 1.2, 1.2]], ["No hook", 58, [0.9, 0.8, 0.8, 0.7, 0.8]]],
  topic: [["Geopolitics", 47, [1.1, 1.3, 1.6, 2.0, 2.2]], ["Money", 122, [1.5, 1.6, 1.5, 1.4, 1.5]], ["Health", 88, [1.0, 1.2, 1.3, 1.4, 1.5]], ["Spirituality", 39, [1.4, 1.3, 1.2, 1.1, 1.1]], ["Careers", 76, [1.1, 1.0, 1.0, 0.9, 1.0]]],
  guest: [["Celebrity", 44, [1.8, 2.0, 2.1, 2.3, 2.2]], ["Politician", 31, [1.2, 1.4, 1.6, 1.8, 1.9]], ["Expert", 112, [1.0, 1.1, 1.3, 1.4, 1.6]], ["Founder", 181, [1.1, 1.2, 1.2, 1.3, 1.2]], ["Athlete", 23, [1.0, 0.9, 1.1, 1.0, 1.1]]],
};
const TABS: [keyof typeof DATA, string][] = [["title", "Title style"], ["topic", "Topic"], ["guest", "Guest type"]];
const MAXV = 2.5;
const avg = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
const x2 = (v: number) => v.toFixed(1) + "×";

export function Explorer() {
  const [set, setSet] = useState<keyof typeof DATA>("title");
  const [sel, setSel] = useState(0);
  const [width, setWidth] = useState(440);
  const [grow, setGrow] = useState(0); // bumps to replay the bar animation
  const [draw, setDraw] = useState(0); // bumps to replay the line animation
  const cardRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const reduceRef = useRef(false);

  useEffect(() => {
    reduceRef.current = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const svg = svgRef.current!;
    let lastW = 0;
    const ro = new ResizeObserver(() => {
      const w = Math.round(svg.getBoundingClientRect().width);
      if (w && Math.abs(w - lastW) > 8) { lastW = w; setWidth(Math.round(Math.max(300, Math.min(440, w)))); }
    });
    ro.observe(svg);
    const io = new IntersectionObserver((es, ob) => {
      if (es[0].isIntersecting) { setGrow((g) => g + 1); setDraw((d) => d + 1); ob.disconnect(); }
    }, { threshold: 0.3 });
    io.observe(cardRef.current!);
    return () => { ro.disconnect(); io.disconnect(); };
  }, []);

  // Line draws left to right, then points and labels fade in (skipped under reduced motion).
  useLayoutEffect(() => {
    if (!draw || reduceRef.current) return;
    const svg = svgRef.current!, path = svg.querySelector<SVGPathElement>(".ln")!;
    const len = path.getTotalLength();
    const extras = [...svg.querySelectorAll<SVGElement>(".pt,.lbl,.area")];
    path.style.transition = "none";
    path.style.strokeDasharray = String(len);
    path.style.strokeDashoffset = String(len);
    extras.forEach((el, k) => { el.style.transition = "none"; el.style.opacity = "0"; el.dataset.delay = String(0.15 + k * 0.03); });
    let r2 = 0;
    const r1 = requestAnimationFrame(() => {
      r2 = requestAnimationFrame(() => {
        path.style.transition = "stroke-dashoffset .9s cubic-bezier(.2,.8,.2,1)";
        path.style.strokeDashoffset = "0";
        extras.forEach((el) => { el.style.transition = `opacity .3s ${el.dataset.delay}s`; el.style.opacity = "1"; });
      });
    });
    const t = window.setTimeout(() => { path.style.strokeDasharray = ""; path.style.strokeDashoffset = ""; }, 1100);
    return () => { cancelAnimationFrame(r1); cancelAnimationFrame(r2); clearTimeout(t); };
  }, [draw]);

  const rows = DATA[set];
  const [name, episodes, series] = rows[sel];
  const v = avg(series);

  const W = width, H = Math.round(W * 0.52), L = 34, R = 18, T = 18, B = 28, lo = 0.5, hi = 2.5;
  const X = (i: number) => L + (i * (W - L - R)) / (YEARS.length - 1);
  const Y = (val: number) => T + ((hi - val) / (hi - lo)) * (H - T - B);
  const pts = series.map((val, i) => [X(i), Y(val)]);
  const d = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");

  return (
    <div className="card explorer" ref={cardRef}>
      <div className="ex__head">
        <h3>Explore the patterns<span className="tag">SAMPLE DATA</span></h3>
        <div className="tabs" role="tablist" aria-label="Group episodes by">
          {TABS.map(([key, label]) => (
            <button
              key={key}
              className="tab"
              role="tab"
              type="button"
              aria-selected={set === key}
              onClick={() => { setSet(key); setSel(0); setGrow((g) => g + 1); setDraw((n) => n + 1); }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <p className="sub">Views compared with a typical episode of the same age; the dashed line is typical (1.0×). Tap a bar to see how it changed by year.</p>
      <div className="ex__body">
        <div className="ex__bars">
          <div key={`${set}-${grow}`} className={`vb${grow ? " grow" : ""}`} role="group" aria-label="Average performance by group">
            <div className="vb__ref" style={{ "--r": 1 / MAXV } as CSSProperties} />
            {rows.map((r, i) => {
              const val = avg(r[2]);
              return (
                <button
                  key={r[0]}
                  className="vbar"
                  type="button"
                  aria-pressed={i === sel}
                  aria-label={`${r[0]}: ${x2(val)} typical, ${r[1]} episodes`}
                  onClick={() => { setSel(i); setDraw((n) => n + 1); }}
                >
                  <span className="vbar__col" style={{ "--h": (val / MAXV).toFixed(3) } as CSSProperties}>
                    <span className="vbar__val num">{x2(val)}</span>
                  </span>
                  <span className="vbar__lab">{r[0]}</span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="ex__line">
          <div className="ex__sel"><span>{name}</span><b className="num">{x2(v)}</b></div>
          <p className="ex__meta">{episodes} episodes · range {x2(Math.min(...series))} to {x2(Math.max(...series))} by year</p>
          <svg
            className="lc"
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            role="img"
            aria-label={`${name} by year: ` + series.map((val, i) => `${YEARS[i]} ${x2(val)}`).join(", ")}
          >
            <defs>
              <linearGradient id="lc-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" stopColor="#4fe3c1" stopOpacity=".22" />
                <stop offset="1" stopColor="#4fe3c1" stopOpacity="0" />
              </linearGradient>
            </defs>
            <g className="grid">
              {[0.5, 1, 1.5, 2, 2.5].map((tk) => (
                <g key={tk}>
                  <line x1={L} x2={W - R} y1={Y(tk)} y2={Y(tk)} />
                  <text x={L - 8} y={Y(tk) + 4} textAnchor="end">{tk.toFixed(1)}×</text>
                </g>
              ))}
            </g>
            {YEARS.map((yr, i) => <text key={yr} x={X(i)} y={H - 6} textAnchor="middle">{yr}</text>)}
            <line className="ref" x1={L} x2={W - R} y1={Y(1)} y2={Y(1)} />
            <path className="area" d={`${d} L${X(series.length - 1)} ${Y(lo)} L${X(0)} ${Y(lo)} Z`} />
            <path className="ln" d={d} />
            {pts.map((p, i) => (
              <g key={i}>
                <circle className={`pt${i === pts.length - 1 ? " last" : ""}`} cx={p[0]} cy={p[1]} r={4}>
                  <title>{`${YEARS[i]}: ${x2(series[i])}`}</title>
                </circle>
                {/* First label starts at its point and last one ends at it, so neither reaches the axis labels or the edge. */}
                <text
                  className="lbl"
                  x={i === 0 ? p[0] - 4 : i === pts.length - 1 ? p[0] + 4 : p[0]}
                  y={p[1] - 11}
                  textAnchor={i === 0 ? "start" : i === pts.length - 1 ? "end" : "middle"}
                >
                  {x2(series[i])}
                </text>
              </g>
            ))}
          </svg>
        </div>
      </div>
    </div>
  );
}
