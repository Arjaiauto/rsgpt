/** Where the numbered badges of a tour screenshot go. Each callout points at a box (a target) in the picture; its badge sits
    just outside that box, at a corner of its outline, so it never covers the target. A badge that would leave the picture,
    cover another target or touch another badge moves to the next corner or side. Sizes are in pixels of the rendered picture. */

export type Target = { n: number; x: number; y: number; w: number; h: number };
export type Badge = { n: number; left: number; top: number };

/** Space the outline takes around a target (2px line + 2px gap). */
const RING = 4;
/** Space kept between a badge and the outline it belongs to, and between two badges. */
const GAP = 2;

const hits = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }, pad = 0) =>
  a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y;

export function placeBadges(targets: Target[], width: number, height: number, size: number): Badge[] {
  const rings = targets.map((t) => ({ n: t.n, x: t.x - RING, y: t.y - RING, w: t.w + 2 * RING, h: t.h + 2 * RING }));
  const placed: { n: number; x: number; y: number; w: number; h: number }[] = [];
  const out: Badge[] = [];
  for (const r of rings) {
    // Corners of the outline first (top-left, top-right, bottom-left, bottom-right), then the sides.
    const options: [number, number][] = [
      [r.x, r.y - size - GAP], [r.x + r.w - size, r.y - size - GAP],
      [r.x, r.y + r.h + GAP], [r.x + r.w - size, r.y + r.h + GAP],
      [r.x - size - GAP, r.y], [r.x + r.w + GAP, r.y],
      [r.x - size - GAP, r.y + r.h - size], [r.x + r.w + GAP, r.y + r.h - size],
    ];
    let best: { left: number; top: number; cost: number } | null = null;
    for (const [rawLeft, rawTop] of options) {
      // A target at the edge of the picture: slide the badge along the edge rather than drop the corner.
      const left = Math.max(0, Math.min(width - size, rawLeft)), top = Math.max(0, Math.min(height - size, rawTop));
      const box = { x: left, y: top, w: size, h: size };
      let cost = 0;
      if (hits(box, r)) cost += 3; // never over its own target
      for (const o of rings) if (o.n !== r.n && hits(box, o)) cost += 2; // never over another target
      for (const p of placed) if (hits(box, p, GAP)) cost += 1; // never touching another badge
      if (!best || cost < best.cost) best = { left, top, cost };
      if (cost === 0) break;
    }
    const { left, top } = best!;
    placed.push({ n: r.n, x: left, y: top, w: size, h: size });
    out.push({ n: r.n, left, top });
  }
  return out;
}
