export type Rect = { x: number; y: number; w: number; h: number };

export type LabelIn = {
  id: string;
  /** anchor point (object position) */
  ax: number;
  ay: number;
  w: number;
  h: number;
  /** higher is placed first and never moved by lower ones */
  priority: number;
  /** preferred centre offset from the anchor */
  px?: number;
  py?: number;
  /** last accepted offset, tried right after the preferred one so labels do not jump while the camera moves */
  prev?: [number, number];
};

export type LabelOut = { dx: number; dy: number; moved: boolean };

function overlap(a: Rect, b: Rect) {
  const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return ox > 0 && oy > 0 ? ox * oy : 0;
}

function outside(r: Rect, b: Rect) {
  const dx = Math.max(0, b.x - r.x) + Math.max(0, r.x + r.w - (b.x + b.w));
  const dy = Math.max(0, b.y - r.y) + Math.max(0, r.y + r.h - (b.y + b.h));
  return (dx * r.h + dy * r.w) * 2;
}

/**
 * Greedy label placement: each label tries its preferred spot, then rings of
 * candidate spots around its anchor, and takes the first one that overlaps no
 * placed label and no obstacle (or the least overlapping one).
 */
export function declutter(items: LabelIn[], obstacles: Rect[] = [], bounds?: Rect, gap = 4): Map<string, LabelOut> {
  const placed: Rect[] = [...obstacles];
  const out = new Map<string, LabelOut>();
  const order = [...items].sort((a, b) => b.priority - a.priority);
  for (const it of order) {
    const px = it.px ?? 0;
    const py = it.py ?? 0;
    const cands: [number, number][] = [[px, py]];
    if (it.prev) cands.push(it.prev);
    const sx = it.w / 2 + 10;
    const sy = it.h + gap;
    for (let r = 1; r <= 5; r++) {
      cands.push(
        [px, py - sy * r], [px, py + sy * r],
        [px + sx * r, py], [px - sx * r, py],
        [px + sx * r, py - sy * r], [px - sx * r, py - sy * r],
        [px + sx * r, py + sy * r], [px - sx * r, py + sy * r],
      );
    }
    let best: [number, number] = [px, py];
    let bestCost = Infinity;
    for (const [dx, dy] of cands) {
      const r: Rect = { x: it.ax + dx - it.w / 2 - gap / 2, y: it.ay + dy - it.h / 2 - gap / 2, w: it.w + gap, h: it.h + gap };
      let cost = bounds ? outside(r, bounds) : 0;
      for (const p of placed) {
        cost += overlap(r, p);
        if (cost >= bestCost) break;
      }
      // prefer short displacement when several spots are free
      cost += Math.hypot(dx - px, dy - py) * 0.01;
      if (cost < bestCost) {
        bestCost = cost;
        best = [dx, dy];
        if (cost < 1) break;
      }
    }
    placed.push({ x: it.ax + best[0] - it.w / 2, y: it.ay + best[1] - it.h / 2, w: it.w, h: it.h });
    out.set(it.id, { dx: best[0], dy: best[1], moved: Math.hypot(best[0] - px, best[1] - py) > 2 });
  }
  return out;
}
