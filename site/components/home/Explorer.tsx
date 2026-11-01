"use client";

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

import type { ExplorerData } from "@/lib/home-explorer";

/** The numbers come from the server (lib/home-explorer.ts): views by group (episode length, title style, topic, guest
    type), as a multiple of a typical episode of the same year. */
const MAXV = 2.5;
const x2 = (v: number) => v.toFixed(1) + "×";

export function Explorer({ data }: { data: ExplorerData }) {
  const YEARS = data.years;
  const [set, setSet] = useState<string>(data.sets[0].key);
  const [sel, setSel] = useState(0);
  const [width, setWidth] = useState(440);
  const [grow, setGrow] = useState(0); // bumps to replay the bar animation
  const [draw, setDraw] = useState(0); // bumps to replay the line animation
  const cardRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const vbRef = useRef<HTMLDivElement>(null);
  /** How the bar labels are laid out: one row, two staggered rows (when each label fits in two columns), or tilted. */
  const [mode, setMode] = useState<"row" | "stagger" | "tilt">("row");
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

  // Lays the bar labels out: on one row if the longest short name fits in a column, else staggered over two rows if it
  // fits in two columns, else tilted. Measured, so it follows the width of the screen and the number of bars.
  useLayoutEffect(() => {
    const vb = vbRef.current;
    if (!vb) return;
    const measure = () => {
      const n = vb.querySelectorAll(".vbar").length;
      const gap = parseFloat(getComputedStyle(vb).columnGap) || 0;
      const col = (vb.clientWidth - gap * (n - 1)) / n;
      const need = Math.max(0, ...[...vb.querySelectorAll<HTMLElement>(".vbar__t")].map((e) => e.offsetWidth));
      setMode(need <= col + 4 ? "row" : need <= 2 * col + gap - 6 ? "stagger" : "tilt");
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(vb);
    return () => ro.disconnect();
  }, [set, grow]);

  const active = data.sets.find((x) => x.key === set) ?? data.sets[0];
  const rows = active.groups;
  const group = rows[Math.min(sel, rows.length - 1)];
  const name = group.label, episodes = group.episodes, v = group.typical;
  const series = group.byYear; // only the years with enough episodes

  const W = width, H = Math.round(W * 0.52), L = 34, R = 18, T = 18, B = 28, lo = 0.5, hi = 2.5;
  const X = (i: number) => L + (i * (W - L - R)) / Math.max(1, YEARS.length - 1);
  const Y = (val: number) => T + ((hi - Math.min(hi, Math.max(lo, val))) / (hi - lo)) * (H - T - B);
  const pts = series.map((p) => [X(YEARS.indexOf(p.year)), Y(p.value)]);
  const d = pts.length < 2 ? "" : pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");

  return (
    <div className="card explorer" ref={cardRef}>
      <div className="ex__head">
        <h3>Explore the patterns</h3>
        {data.sets.length > 1 && <div className="tabs" role="tablist" aria-label="Group episodes by">
          {data.sets.map(({ key, label }) => (
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
        </div>}
      </div>
      <p className="sub">Views compared with a typical episode of the same age; the dashed line is typical (1.0×). Tap a bar to see how it changed by year.</p>
      <div className="ex__body">
        <div className="ex__bars">
          <div key={`${set}-${grow}`} ref={vbRef} className={`vb${grow ? " grow" : ""}${mode !== "row" ? ` vb--${mode}` : ""}`} style={{ "--n": rows.length } as CSSProperties} role="group" aria-label="Average performance by group">
            <div className="vb__ref" style={{ "--r": 1 / MAXV } as CSSProperties} />
            {rows.map((r, i) => {
              const val = r.typical;
              return (
                <button
                  key={r.label}
                  className="vbar"
                  type="button"
                  aria-pressed={i === sel}
                  aria-label={`${r.label}: ${x2(val)} typical, ${r.episodes} episodes`}
                  onClick={() => { setSel(i); setDraw((n) => n + 1); }}
                >
                  <span className="vbar__col" style={{ "--h": (val / MAXV).toFixed(3) } as CSSProperties}>
                    <span className="vbar__val num">{x2(val)}</span>
                  </span>
                  <span className="vbar__lab" title={r.label}><span className="vbar__t">{r.short}</span><span className="vbar__n">n = {r.episodes}</span></span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="ex__line">
          <div className="ex__sel"><span>{name}</span><b className="num">{x2(v)}</b></div>
          <p className="ex__meta">{episodes} episodes · {series.length >= 2 ? `range ${x2(Math.min(...series.map((p) => p.value)))} to ${x2(Math.max(...series.map((p) => p.value)))} by year` : "too few episodes in a year to show a by-year line"}{series.some((p) => p.small) ? " · hollow points: small sample (10 to 19 episodes)" : ""}</p>
          <svg
            className="lc"
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            role="img"
            aria-label={`${name} by year: ` + (series.length ? series.map((p) => `${p.year} ${x2(p.value)} (n = ${p.n}${p.small ? ", small sample" : ""})`).join(", ") : "not enough episodes in any year")}
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
            <path className="area" d={d ? `${d} L${pts[pts.length - 1][0].toFixed(1)} ${Y(lo)} L${pts[0][0].toFixed(1)} ${Y(lo)} Z` : ""} />
            <path className="ln" d={d} />
            {pts.map((p, i) => (
              <g key={i}>
                <circle className={`pt${series[i].small ? " small" : ""}${i === pts.length - 1 ? " last" : ""}`} cx={p[0]} cy={p[1]} r={4}>
                  <title>{series[i].small ? `${series[i].year}: ${x2(series[i].value)}, small sample (n = ${series[i].n})` : `${series[i].year}: ${x2(series[i].value)} (n = ${series[i].n})`}</title>
                </circle>
                {/* First label starts at its point and last one ends at it, so neither reaches the axis labels or the edge. */}
                <text
                  className="lbl"
                  x={p[0] < W * 0.25 ? p[0] + 9 : p[0] > W * 0.75 ? p[0] + 3 : p[0]}
                  y={p[1] - 11}
                  textAnchor={p[0] < W * 0.25 ? "start" : p[0] > W * 0.75 ? "end" : "middle"}
                >
                  {x2(series[i].value)}
                </text>
              </g>
            ))}
          </svg>
        </div>
      </div>
      {active.note && <p className="ex__note">{active.note}</p>}
    </div>
  );
}
