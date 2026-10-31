import Link from "next/link";
import type { ReactNode } from "react";
import { fmtViews } from "@/lib/guest-format";
import type { Group, MonthPoint, Spread, TopicMix } from "@/lib/insights-types";

/** Charts of the Insights page, rendered on the server: HTML bars (text stays readable at phone width) and one SVG
    column chart. Each chart has a text label for screen readers and a "Show as a table" fallback. */

const fmt = (n: number) => fmtViews(Math.round(n));

/** A round top for an axis: 1, 2 or 5 times a power of ten, at or above max. */
function niceMax(max: number): number {
  if (max <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(max));
  return ([1, 2, 2.5, 5, 10].map((m) => m * p).find((v) => v >= max) ?? 10 * p);
}

export function TableToggle({ children }: { children: ReactNode }) {
  return (
    <details className="in-tbl">
      <summary>Show as a table</summary>
      <div className="in-tw">{children}</div>
    </details>
  );
}

/** Bars of the median with the middle half of episodes as a whisker and the average as a tick. A row links to the
    filtered Clips page when href gives one. */
export function SpreadBars({ groups, label, unit = "views", href }: { groups: Group[]; label: string; unit?: string; href?: (key: string) => string }) {
  const top = niceMax(Math.max(...groups.map((g) => Math.max(g.p75, g.mean))));
  const x = (v: number) => `${(100 * v) / top}%`;
  return (
    <figure className="in-fig">
      <ul className="in-sb" aria-label={label}>
        {groups.map((g) => {
          const body = (
            <>
              <span className="in-sb-lab">{g.label}<small>{g.n} episodes</small></span>
              <span className="in-sb-track" aria-hidden="true">
                <i className="in-sb-bar" style={{ width: x(g.median) }} />
                <i className="in-sb-wh" style={{ left: x(g.p25), width: `calc(${x(g.p75)} - ${x(g.p25)})` }} />
                <i className="in-sb-avg" style={{ left: x(g.mean) }} />
              </span>
              <span className="in-sb-val">{fmt(g.median)}<span className="sr"> median {unit}, average {fmt(g.mean)}, middle half {fmt(g.p25)} to {fmt(g.p75)}</span></span>
            </>
          );
          return <li key={g.key}>{href ? <Link className="in-sb-row" href={href(g.key)} prefetch={false}>{body}</Link> : <span className="in-sb-row">{body}</span>}</li>;
        })}
      </ul>
      <figcaption className="in-legend">
        <span><i className="sq" /> median {unit}</span><span><i className="wh" /> middle half of episodes</span><span><i className="avg" /> average</span>
      </figcaption>
      <TableToggle>
        <table className="in-dt">
          <thead><tr><th scope="col">Group</th><th scope="col">Episodes</th><th scope="col">Median</th><th scope="col">Average</th><th scope="col">Middle half</th></tr></thead>
          <tbody>{groups.map((g) => (
            <tr key={g.key}><th scope="row">{g.label}</th><td>{g.n}</td><td>{fmt(g.median)}</td><td>{fmt(g.mean)}</td><td>{fmt(g.p25)} to {fmt(g.p75)}</td></tr>
          ))}</tbody>
        </table>
      </TableToggle>
    </figure>
  );
}

/** Plain bars with a count; each row can be a link. */
export function CountBars({ rows, label }: { rows: { key: string; label: string; n: number; note?: string; href?: string }[]; label: string }) {
  const top = Math.max(1, ...rows.map((r) => r.n));
  return (
    <ul className="in-cb" aria-label={label}>
      {rows.map((r) => {
        const body = (
          <>
            <span className="in-cb-lab">{r.label}</span>
            <span className="in-cb-track" aria-hidden="true"><i style={{ width: `${(100 * r.n) / top}%` }} /></span>
            <span className="in-cb-val">{r.n}{r.note ? <small> {r.note}</small> : null}</span>
          </>
        );
        return <li key={r.key}>{r.href ? <Link className="in-cb-row" href={r.href} prefetch={false}>{body}</Link> : <span className="in-cb-row">{body}</span>}</li>;
      })}
    </ul>
  );
}

/** Topic share per year: a table whose cells are shaded by share. */
export function MixTable({ mix, href }: { mix: TopicMix; href: (key: string) => string }) {
  const shares = mix.rows.map((r) => r.counts.map((c, i) => (mix.totals[i] ? c / mix.totals[i] : 0)));
  const max = Math.max(0.01, ...shares.flat());
  return (
    <div className="in-tw">
      <table className="in-mix">
        <caption className="sr">Share of each year&apos;s episodes with a guest tagged with the topic</caption>
        <thead><tr><th scope="col">Topic</th>{mix.years.map((y, i) => <th scope="col" key={y}>{y}<small>{mix.totals[i]} eps</small></th>)}</tr></thead>
        <tbody>{mix.rows.map((r, ri) => (
          <tr key={r.key}>
            <th scope="row"><Link href={href(r.key)} prefetch={false}>{r.label}</Link></th>
            {r.counts.map((c, i) => (
              <td key={i} style={{ background: `rgba(139, 92, 255, ${(0.08 + 0.72 * (shares[ri][i] / max)).toFixed(2)})` }} title={`${c} of ${mix.totals[i]} episodes`}>
                {Math.round(100 * shares[ri][i])}%
              </td>
            ))}
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

/** Median per month as columns, the average as a line. Axis labels are HTML so they keep their size on a phone. */
export function MonthChart({ points, pick, label, unit }: { points: MonthPoint[]; pick: (p: MonthPoint) => Spread; label: string; unit: string }) {
  const W = 600, H = 200;
  const top = niceMax(Math.max(...points.map((p) => Math.max(pick(p).median, pick(p).mean))));
  const bw = W / points.length;
  const y = (v: number) => H - (H * v) / top;
  const ticks = [0, 0.5, 1].map((f) => f * top);
  const years = points.map((p, i) => ({ i, y: p.key.slice(0, 4), first: i === 0 || points[i - 1].key.slice(0, 4) !== p.key.slice(0, 4) })).filter((p) => p.first);
  const peak = points.reduce((a, b) => (pick(b).median > pick(a).median ? b : a), points[0]);
  return (
    <figure className="in-fig">
      <div className="in-mc">
        <div className="in-mc-y" aria-hidden="true">{ticks.map((t) => <span key={t} style={{ bottom: `${(100 * t) / top}%` }}>{fmt(t)}</span>)}</div>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img"
          aria-label={`${label}, ${points.length} months from ${points[0].label} to ${points.at(-1)!.label}. Highest median: ${peak.label}, ${fmt(pick(peak).median)} ${unit}.`}>
          {ticks.map((t) => <line key={t} className="gl" x1="0" x2={W} y1={y(t)} y2={y(t)} vectorEffect="non-scaling-stroke" />)}
          {points.map((p, i) => (
            <rect key={p.key} className="col" x={i * bw + bw * 0.14} width={bw * 0.72} y={y(pick(p).median)} height={H - y(pick(p).median)}>
              <title>{`${p.label}: median ${fmt(pick(p).median)}, average ${fmt(pick(p).mean)} ${unit}, ${p.n} episode${p.n === 1 ? "" : "s"}`}</title>
            </rect>
          ))}
          <polyline className="avg" fill="none" vectorEffect="non-scaling-stroke"
            points={points.map((p, i) => `${(i + 0.5) * bw},${Math.max(0, y(pick(p).mean))}`).join(" ")} />
        </svg>
        <div className="in-mc-x" aria-hidden="true">{years.map((p) => <span key={p.y} style={{ left: `${(100 * p.i) / points.length}%` }}>{p.y}</span>)}</div>
      </div>
      <figcaption className="in-legend"><span><i className="sq" /> median {unit} per episode</span><span><i className="line" /> average</span></figcaption>
      <TableToggle>
        <table className="in-dt">
          <thead><tr><th scope="col">Month</th><th scope="col">Episodes</th><th scope="col">Median</th><th scope="col">Average</th></tr></thead>
          <tbody>{points.map((p) => <tr key={p.key}><th scope="row">{p.label}</th><td>{p.n}</td><td>{fmt(pick(p).median)}</td><td>{fmt(pick(p).mean)}</td></tr>)}</tbody>
        </table>
      </TableToggle>
    </figure>
  );
}
