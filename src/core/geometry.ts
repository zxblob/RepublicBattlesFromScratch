/**
 * Fill a polygon (flat [x0,y0,x1,y1,...] in tile coordinates, tile i covers [x, x+1)) using the
 * even-odd rule, sampling at tile centres. Returns the covered tile indices, clipped to the map.
 */
export function rasterizePolygon(pts: ArrayLike<number>, w: number, h: number): number[] {
  const n = (pts.length / 2) | 0;
  if (n < 3) return [];
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    const y = pts[i * 2 + 1];
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(h - 1, Math.ceil(maxY));
  const out: number[] = [];
  const xs: number[] = [];
  for (let y = y0; y <= y1; y++) {
    const cy = y + 0.5;
    xs.length = 0;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ax = pts[i * 2], ay = pts[i * 2 + 1];
      const bx = pts[j * 2], by = pts[j * 2 + 1];
      if ((ay <= cy && by > cy) || (by <= cy && ay > cy)) {
        xs.push(ax + ((cy - ay) / (by - ay)) * (bx - ax));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil(xs[k] - 0.5));
      const xb = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = xa; x <= xb; x++) out.push(y * w + x);
    }
  }
  return out;
}
