// Builds the premade real-world maps from Natural Earth 1:50m land polygons (public domain).
// Usage: node scripts/make-maps.mjs path/to/ne_50m_land.geojson
// Output: maps/premade/<id>.json  { name, w, h, rle, names }
// Terrain: 0 water, 1 land, 2 mountain. Mountains are synthetic (noise inland), not real elevation.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const src = process.argv[2] ?? "ne_50m_land.geojson";
const geo = JSON.parse(readFileSync(src, "utf8"));

const MAPS = [
  { id: "WORLD", name: "Earth", lon: [-180, 180], lat: [84, -58], w: 640, equirect: true,
    names: ["USA", "Canada", "Mexico", "Brazil", "Argentina", "Colombia", "UK", "France", "Germany", "Spain", "Italy", "Poland", "Russia", "Turkey", "Egypt", "Nigeria", "Kenya", "South Africa", "Saudi Arabia", "Iran", "India", "Pakistan", "China", "Japan", "Korea", "Indonesia", "Australia", "Peru", "Chile", "Ukraine", "Sweden", "Algeria", "Ethiopia", "Thailand", "Vietnam", "Philippines", "Kazakhstan", "Mongolia", "Norway", "Congo"] },
  { id: "EUROPE", name: "Europe", lon: [-12, 50], lat: [34, 71], w: 384,
    names: ["France", "Germany", "Spain", "Italy", "UK", "Poland", "Ukraine", "Sweden", "Norway", "Finland", "Turkey", "Romania", "Greece", "Portugal", "Austria", "Belgium", "Netherlands", "Ireland", "Hungary", "Serbia", "Bulgaria", "Denmark", "Czechia", "Belarus", "Russia", "Croatia", "Switzerland", "Lithuania", "Latvia", "Estonia"] },
  { id: "NAMERICA", name: "North America", lon: [-170, -50], lat: [7, 75], w: 480,
    names: ["USA", "Canada", "Mexico", "Cuba", "Guatemala", "Honduras", "Panama", "Costa Rica", "Nicaragua", "Haiti", "Jamaica", "Alaska", "Quebec", "Texas", "California", "Ontario", "Alberta", "Florida", "Yucatan", "Greenland"] },
  { id: "SAMERICA", name: "South America", lon: [-83, -34], lat: [13, -57], w: 300,
    names: ["Brazil", "Argentina", "Chile", "Peru", "Colombia", "Venezuela", "Bolivia", "Ecuador", "Paraguay", "Uruguay", "Guyana", "Suriname", "Patagonia", "Amazonia", "Andes"] },
  { id: "AFRICA", name: "Africa", lon: [-20, 52], lat: [38, -36], w: 380,
    names: ["Egypt", "Nigeria", "Ethiopia", "Kenya", "South Africa", "Algeria", "Morocco", "Sudan", "Congo", "Tanzania", "Angola", "Ghana", "Mali", "Niger", "Libya", "Chad", "Zambia", "Namibia", "Uganda", "Somalia", "Madagascar", "Cameroon", "Senegal", "Mozambique"] },
  { id: "ASIA", name: "Asia", lon: [25, 180], lat: [78, -11], w: 520,
    names: ["China", "India", "Russia", "Japan", "Korea", "Indonesia", "Pakistan", "Iran", "Turkey", "Saudi Arabia", "Kazakhstan", "Mongolia", "Thailand", "Vietnam", "Philippines", "Myanmar", "Iraq", "Afghanistan", "Nepal", "Bangladesh", "Malaysia", "Siberia", "Tibet", "Manchuria"] },
  { id: "AUSTRALIA", name: "Australia & Oceania", lon: [112, 179], lat: [-9, -48], w: 400,
    names: ["Queensland", "Victoria", "New South Wales", "Tasmania", "Western Australia", "South Australia", "Northern Territory", "New Zealand", "Papua", "Canterbury", "Otago", "Perth", "Sydney", "Melbourne"] },
];

function hash(ix, iy, seed) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const sm = (t) => t * t * (3 - 2 * t);
function vnoise(x, y, seed) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = sm(x - ix), fy = sm(y - iy);
  const a = hash(ix, iy, seed), b = hash(ix + 1, iy, seed), c = hash(ix, iy + 1, seed), d = hash(ix + 1, iy + 1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
function fbm(x, y, seed) {
  let s = 0, n = 0, a = 1, f = 1;
  for (let o = 0; o < 4; o++) { s += a * vnoise(x * f, y * f, seed + o * 31); n += a; a *= 0.5; f *= 2; }
  return s / n;
}

/** toggle (even-odd) the tiles covered by one ring */
function fillRing(ring, toX, toY, w, h, grid) {
  const pts = ring.map(([lon, lat]) => [toX(lon), toY(lat)]);
  let minY = Infinity, maxY = -Infinity;
  for (const p of pts) { if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1]; }
  const y0 = Math.max(0, Math.floor(minY)), y1 = Math.min(h - 1, Math.ceil(maxY));
  const xs = [];
  for (let y = y0; y <= y1; y++) {
    const cy = y + 0.5;
    xs.length = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[j];
      if ((ay <= cy && by > cy) || (by <= cy && ay > cy)) xs.push(ax + ((cy - ay) / (by - ay)) * (bx - ax));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil(xs[k] - 0.5)), xb = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = xa; x <= xb; x++) grid[y * w + x] ^= 1;
    }
  }
}

function rle(arr) {
  const out = [];
  let cur = arr[0], n = 0;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] === cur) n++;
    else { out.push(cur, n); cur = arr[i]; n = 1; }
  }
  out.push(cur, n);
  return out;
}

mkdirSync("maps/premade", { recursive: true });
for (const m of MAPS) {
  const [lon0, lon1] = m.lon, [latTop, latBot] = m.lat;
  const midLat = (latTop + latBot) / 2;
  const k = m.equirect ? 1 : Math.cos((midLat * Math.PI) / 180);
  const wDeg = (lon1 - lon0) * k, hDeg = Math.abs(latTop - latBot);
  const w = m.w, h = Math.round((w * hDeg) / wDeg);
  const toX = (lon) => ((lon - lon0) / (lon1 - lon0)) * w;
  const toY = (lat) => ((latTop - lat) / (latTop - latBot)) * h;
  const grid = new Uint8Array(w * h);
  for (const f of geo.features) {
    const g = f.geometry;
    const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
    for (const poly of polys) for (const ring of poly) fillRing(ring, toX, toY, w, h, grid);
  }
  // drop specks (< 6 tiles) so the map is not full of single-tile islands
  const comp = new Int32Array(w * h).fill(-1);
  const stack = [];
  for (let s = 0; s < grid.length; s++) {
    if (!grid[s] || comp[s] !== -1) continue;
    const members = [];
    stack.push(s); comp[s] = s;
    while (stack.length) {
      const i = stack.pop(); members.push(i);
      const x = i % w, y = (i / w) | 0;
      for (const n of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (n >= 0 && grid[n] && comp[n] === -1) { comp[n] = s; stack.push(n); }
      }
    }
    if (members.length < 6) for (const i of members) grid[i] = 0;
  }
  // distance from coast, then synthetic mountains inland
  const dist = new Int16Array(w * h).fill(-1);
  let q = [];
  for (let i = 0; i < grid.length; i++) if (!grid[i]) { dist[i] = 0; q.push(i); }
  for (let qi = 0; qi < q.length; qi++) {
    const i = q[qi], x = i % w, y = (i / w) | 0;
    for (const n of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
      if (n >= 0 && dist[n] === -1) { dist[n] = dist[i] + 1; q.push(n); }
    }
  }
  const t = new Uint8Array(w * h);
  let land = 0, mtn = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!grid[i]) continue;
      land++;
      const inland = Math.min(1, dist[i] / 10);
      t[i] = fbm(x / 14, y / 14, m.id.length * 77) * (0.55 + 0.45 * inland) > 0.62 && dist[i] > 3 ? 2 : 1;
      if (t[i] === 2) mtn++;
    }
  }
  writeFileSync(`maps/premade/${m.id}.json`, JSON.stringify({ name: m.name, w, h, rle: rle(t), names: m.names }));
  console.log(m.id, `${w}x${h}`, "land", land, "mountain", mtn, "runs", rle(t).length / 2);
}
