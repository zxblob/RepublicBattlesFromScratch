import { mulberry32 } from "./rng";

export const Terrain = { Water: 0, Land: 1, Mountain: 2 } as const;

function hash2(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = smooth(x - ix);
  const fy = smooth(y - iy);
  const a = hash2(ix, iy, seed);
  const b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed);
  const d = hash2(ix + 1, iy + 1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

function fbm(x: number, y: number, seed: number): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < 5; o++) {
    sum += amp * valueNoise(x * freq, y * freq, seed + o * 101);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/** Procedural landmass. Only the largest connected landmass is kept so every spawn can reach every other. */
export function generateMap(seed: number, w: number, h: number, landFraction = 0.5): Uint8Array {
  const rng = mulberry32(seed ^ 0x9e3779b9);
  const ox = rng() * 1000;
  const oy = rng() * 1000;
  const heights = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = (x / w) * 2 - 1;
      const ny = (y / h) * 2 - 1;
      const d = Math.sqrt(nx * nx * 0.7 + ny * ny);
      heights[y * w + x] = fbm((x + ox) / 30, (y + oy) / 30, seed) - d * d * 0.5;
    }
  }
  const sorted = Float32Array.from(heights).sort();
  const sea = sorted[Math.floor(sorted.length * (1 - landFraction))];
  const mtn = sorted[Math.floor(sorted.length * (1 - landFraction * 0.12))];

  const t = new Uint8Array(w * h);
  for (let i = 0; i < t.length; i++) {
    t[i] = heights[i] > mtn ? Terrain.Mountain : heights[i] > sea ? Terrain.Land : Terrain.Water;
  }
  keepLargestLandmass(t, w, h);
  return t;
}

function keepLargestLandmass(t: Uint8Array, w: number, h: number): void {
  const comp = new Int32Array(w * h).fill(-1);
  let best = -1;
  let bestSize = 0;
  let id = 0;
  const stack: number[] = [];
  for (let s = 0; s < t.length; s++) {
    if (t[s] === Terrain.Water || comp[s] !== -1) continue;
    let size = 0;
    stack.push(s);
    comp[s] = id;
    while (stack.length) {
      const i = stack.pop()!;
      size++;
      const x = i % w;
      const y = (i / w) | 0;
      if (x > 0 && t[i - 1] !== Terrain.Water && comp[i - 1] === -1) { comp[i - 1] = id; stack.push(i - 1); }
      if (x < w - 1 && t[i + 1] !== Terrain.Water && comp[i + 1] === -1) { comp[i + 1] = id; stack.push(i + 1); }
      if (y > 0 && t[i - w] !== Terrain.Water && comp[i - w] === -1) { comp[i - w] = id; stack.push(i - w); }
      if (y < h - 1 && t[i + w] !== Terrain.Water && comp[i + w] === -1) { comp[i + w] = id; stack.push(i + w); }
    }
    if (size > bestSize) { bestSize = size; best = id; }
    id++;
  }
  for (let i = 0; i < t.length; i++) if (t[i] !== Terrain.Water && comp[i] !== best) t[i] = Terrain.Water;
}
