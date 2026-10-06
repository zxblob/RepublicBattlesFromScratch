import type { ClientGame } from "./state";

export interface Train {
  /** tile-centre points the train rides along, end to end */
  pts: [number, number][];
  /** cumulative length at each point */
  cum: number[];
  owner: number;
  /** phase offset so trains on one line are spread out */
  offset: number;
}

const NODE = new Set(["city", "factory", "port"]);

/**
 * Cosmetic trains: for every connected rail network, a few trains shuttle between the buildings it links.
 * Recomputed only when rails or structures change.
 */
export function buildTrains(g: ClientGame): Train[] {
  const { w, h, rails } = g;
  const seen = new Set<number>();
  const nodes = g.structs.filter((s) => NODE.has(s.type));
  const out: Train[] = [];
  for (let start = 0; start < rails.length; start++) {
    if (!rails[start] || seen.has(start)) continue;
    const net = new Set<number>([start]);
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const t = stack.pop()!;
      const x = t % w, y = (t / w) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const n = ny * w + nx;
        if (rails[n] && !seen.has(n)) { seen.add(n); net.add(n); stack.push(n); }
      }
    }
    const touching = (s: { x: number; y: number }): number[] => {
      const r: number[] = [];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = s.x + dx, ny = s.y + dy;
        if (nx >= 0 && ny >= 0 && nx < w && ny < h && net.has(ny * w + nx)) r.push(ny * w + nx);
      }
      return r;
    };
    const linked = nodes.filter((s) => touching(s).length).sort((a, b) => a.x - b.x || a.y - b.y);
    for (let i = 0; i + 1 < linked.length && i < 3; i++) {
      const a = linked[i], b = linked[i + 1];
      const goal = new Set(touching(b));
      const prev = new Map<number, number>();
      const q = touching(a);
      for (const t of q) prev.set(t, -1);
      let end = -1;
      for (let qi = 0; qi < q.length && end < 0; qi++) {
        const t = q[qi];
        if (goal.has(t)) { end = t; break; }
        const x = t % w, y = (t / w) | 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const n = ny * w + nx;
          if (net.has(n) && !prev.has(n)) { prev.set(n, t); q.push(n); }
        }
      }
      if (end < 0) continue;
      const tiles: number[] = [];
      for (let t = end; t !== -1; t = prev.get(t)!) tiles.push(t);
      tiles.reverse();
      const pts: [number, number][] = [[a.x + 0.5, a.y + 0.5], ...tiles.map((t): [number, number] => [(t % w) + 0.5, Math.floor(t / w) + 0.5]), [b.x + 0.5, b.y + 0.5]];
      const cum = [0];
      for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
      if (cum[cum.length - 1] < 1.5) continue;
      out.push({ pts, cum, owner: a.owner, offset: (out.length * 0.37) % 1 });
    }
  }
  return out;
}

/** Position and heading of a train at time `sec` (ping-pong along its line). */
export function trainPose(t: Train, sec: number, speed = 4): { x: number; y: number; angle: number } {
  const L = t.cum[t.cum.length - 1];
  const period = 2 * L;
  let d = (sec * speed + t.offset * period) % period;
  const forward = d <= L;
  if (!forward) d = period - d;
  let i = 1;
  while (i < t.cum.length - 1 && t.cum[i] < d) i++;
  const f = (d - t.cum[i - 1]) / Math.max(1e-6, t.cum[i] - t.cum[i - 1]);
  const [x0, y0] = t.pts[i - 1], [x1, y1] = t.pts[i];
  let angle = Math.atan2(y1 - y0, x1 - x0) + Math.PI / 2;
  if (!forward) angle += Math.PI;
  return { x: x0 + (x1 - x0) * f, y: y0 + (y1 - y0) * f, angle };
}
