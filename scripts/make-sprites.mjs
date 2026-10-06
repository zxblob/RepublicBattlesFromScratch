// Generates the game's pixel-art sprites (original art, 32x32 PNG, top-down, forward = up).
// Each sprite is authored as the LEFT HALF (8 columns x 16 rows) and mirrored; use "full:" for asymmetric art.
// Team colour keys: M = team colour, D = team dark, L = team light (replaced at runtime per owner).
// Usage: node scripts/make-sprites.mjs [outDir]
import { mkdirSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const PAL = {
  ".": null,
  k: [20, 20, 28], K: [59, 63, 75], G: [85, 90, 102], g: [111, 116, 130], l: [170, 176, 189], w: [242, 244, 248],
  M: [255, 0, 255], D: [170, 0, 170], L: [255, 170, 255],
  y: [242, 194, 48], o: [224, 138, 30], r: [210, 59, 59], R: [140, 30, 30], b: [58, 120, 209], B: [140, 196, 255],
  n: [122, 79, 42], N: [176, 122, 69], e: [63, 154, 74], E: [42, 106, 52], s: [216, 197, 138], c: [111, 224, 230],
};

const S = {};
const half = (name, rows) => (S[name] = { rows, mirror: true });
const full = (name, rows) => (S[name] = { rows, mirror: false });

// ---- structures ----
half("bunker", [
  "........",
  "........",
  "......kk",
  "....kkKg",
  "...kKggl",
  "..kKglMM",
  "..kKgMMM",
  ".kKglMMk",
  ".kKgMMkK",
  ".kKgMMkK",
  ".kKglMMM",
  "..kKglMM",
  "...kKggl",
  "....kkKg",
  "......kk",
  "........",
]);
half("barracks", [
  "........",
  "........",
  "..kkkkkk",
  ".kMMMMMM",
  ".kMLLLLL",
  ".kMMMMMM",
  ".kDDDDDD",
  ".kggggkk",
  ".kgllgkK",
  ".kgllgkw",
  ".kggggkK",
  ".kggkkkK",
  ".kggkKKK",
  ".kkkkkkk",
  "........",
  "........",
]);
half("bank", [
  "........",
  ".......k",
  "......ky",
  ".....kyy",
  "....kyyo",
  "...kyyoo",
  "..kyyyoo",
  "..kkkkkk",
  "..klklkl",
  "..klklkl",
  "..klklkl",
  "..klklkl",
  "..kkkkkk",
  ".kMMMMMM",
  ".kkkkkkk",
  "........",
]);
half("radar", [
  "........",
  "....kkkk",
  "...kllll",
  "..klwwww",
  "..klwwll",
  "..kllwll",
  "...kllll",
  "....kkkk",
  ".......k",
  ".......k",
  "......kK",
  ".....kKK",
  "....kMMM",
  "...kMMMM",
  "...kkkkk",
  "........",
]);
half("tankfactory", [
  "........",
  "....kk..",
  "....kK..",
  "....kK.k",
  "..kkkkkk",
  ".kggggll",
  ".kgMMggl",
  ".kgMMggl",
  ".kggggll",
  ".kKKKKKK",
  ".kKggKgK",
  ".kKggKgK",
  ".kKKKKKK",
  ".kkkkkkk",
  "........",
  "........",
]);
half("airbase", [
  ".......k",
  ".......K",
  ".......k",
  "......kg",
  "......kg",
  "....kkgg",
  "...kllgg",
  "..kllMgg",
  ".kkkkkgg",
  ".kgwgwgg",
  "...kllgg",
  "....kkgg",
  "......kg",
  "......kg",
  ".......K",
  ".......k",
]);
half("sam", [
  "........",
  "......kk",
  "......kw",
  ".....kkr",
  ".....kKr",
  "..kk.kKr",
  "..kw.kKl",
  "..kr.kKl",
  ".kkrkkKg",
  ".kMrkMgg",
  ".kMMMMgg",
  ".kDDDDDD",
  ".kKggKKK",
  ".kkkkkkk",
  "........",
  "........",
]);
half("factory", [
  "........",
  ".....kk.",
  ".....kK.",
  "...kkkK.",
  "...kKkgk",
  "...kKkgk",
  ".kkkKkkk",
  ".kMMkMMk",
  ".kMLkMLk",
  ".kMMkMMk",
  ".kggggGg",
  ".kgllgGg",
  ".kggggGg",
  ".kkkkkkk",
  "........",
  "........",
]);
half("port", [
  "........",
  ".......k",
  "......kg",
  ".......k",
  ".....kkk",
  ".......k",
  ".......k",
  "..k....k",
  ".kk....k",
  "kkkk...k",
  "kMMk...k",
  ".kMkkkkk",
  "..kMMMMM",
  "...kkkkk",
  "........",
  "........",
]);
half("city", [
  "........",
  "......kk",
  "....kkwk",
  "....klwk",
  "..kkklwk",
  "..klklwk",
  "..klkllk",
  "..klklwk",
  "kkklkllk",
  "klklklwk",
  "klklkllk",
  "klMlklwk",
  "klMlklwk",
  "kkkkkkkk",
  "........",
  "........",
]);
half("farm", [
  "........",
  "........",
  "...kkkkk",
  "..kNNNNN",
  ".kRRRRRR",
  ".kRwwwRR",
  ".kNNNNNN",
  ".knnnnkn",
  ".knnnnkn",
  ".kkkkkkk",
  ".eEeEeEe",
  ".EeEeEeE",
  ".eEeEeEe",
  ".EeEeEeE",
  "........",
  "........",
]);
half("lab", [
  "........",
  "......kk",
  "......kw",
  "......kw",
  ".....kkk",
  ".....kcc",
  "....kcBB",
  "...kcBBB",
  "..kcBBMM",
  "..kcBMMM",
  "..kcBBMM",
  "..kcBBBB",
  "...kcBBB",
  "....kkkk",
  "........",
  "........",
]);
half("silo", [
  "........",
  "....kkkk",
  "...kKKgg",
  "..kKggll",
  ".kKglllw",
  ".kKgllkk",
  ".kKglkrr",
  ".kKglkrw",
  ".kKglkrr",
  ".kKgllkk",
  ".kKglllw",
  "..kKggll",
  "...kKKgg",
  "....kkkk",
  "........",
  "........",
]);
half("spaceport", [
  ".......k",
  ".......w",
  "......kw",
  "......kl",
  ".....kMl",
  ".....kMl",
  ".....kMg",
  ".....kMg",
  "....kkkg",
  "....krrg",
  "...kllgg",
  "..kllMgg",
  ".kkkkkkk",
  ".kggggkK",
  ".kkkkkkk",
  "........",
]);

// ---- units ----
half("tank", [
  ".......k",
  ".......K",
  ".......K",
  ".kk....K",
  ".kK..kkK",
  ".kKkkkMM",
  ".kKkMMMM",
  ".kKkMLLM",
  ".kKkMMMM",
  ".kKkkkMM",
  ".kK..kkK",
  ".kk....k",
  "........",
  "........",
  "........",
  "........",
]);
half("fighter", [
  ".......k",
  ".......w",
  "......kw",
  "......kl",
  "......kM",
  ".....kMM",
  "....kkMM",
  "...kllMg",
  "..kllggg",
  ".kllMMgg",
  "kkkkkkMg",
  "....kMMM",
  ".....kMg",
  "......kk",
  "........",
  "........",
]);
half("bomber", [
  ".......k",
  ".......w",
  "......kl",
  "......kl",
  "...kkkkM",
  "..kllgMM",
  ".kllggMM",
  "kllggggM",
  "kkkkkkkM",
  "..kllggg",
  "...kggMM",
  "...kllMM",
  "....kkkM",
  "......kg",
  ".......k",
  "........",
]);
half("transport", [
  "........",
  ".......k",
  "......kg",
  ".....kgl",
  "....kggl",
  "...kMMMM",
  "...kMLMM",
  "...kggnn",
  "...kggnN",
  "...kggnn",
  "...kMMMM",
  "...kMMMM",
  "....kkkk",
  "........",
  "........",
  "........",
]);
half("warship", [
  ".......k",
  "......kg",
  ".....kgl",
  ".....kKl",
  "....kKMM",
  "...kkKMM",
  "...kgkkk",
  "...kgKKw",
  "...kgkkk",
  "...kMKMM",
  "...kMKMM",
  "...kKkkk",
  "....kKgg",
  ".....kKg",
  "......kk",
  "........",
]);
half("trade", [
  "........",
  "........",
  ".......k",
  "......kg",
  ".....kyg",
  "....kyNg",
  "....kNnn",
  "....kNNn",
  "....kNnn",
  "....kyNg",
  ".....kgg",
  "......kk",
  "........",
  "........",
  "........",
  "........",
]);

// ---- misc ----
half("missile", [
  ".......k",
  ".......r",
  "......kr",
  "......kw",
  "......kl",
  "......kl",
  "......kg",
  "......kg",
  "......kg",
  ".....kMg",
  "....kMMg",
  "...kkkkk",
  "......ko",
  "......ky",
  ".......o",
  "........",
]);
half("capital", [
  ".......k",
  ".......y",
  "......ky",
  "......ky",
  "kkkkkkyy",
  ".kyyyyyy",
  "..kyyyyw",
  "...kyyyy",
  "...kyyyy",
  "..kyyykk",
  "..kyykoo",
  ".kyykook",
  ".kykkook",
  ".kk....k",
  "........",
  "........",
]);

// ---- png writer ----
const crcT = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = ~0; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return ~c >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}
function png(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

function render(name, def) {
  const grid = [];
  for (const row of def.rows) {
    if (def.mirror ? row.length !== 8 : row.length !== 16) throw new Error(`${name}: bad row width "${row}"`);
    grid.push(def.mirror ? row + [...row].reverse().join("") : row);
  }
  if (grid.length !== 16) throw new Error(`${name}: needs 16 rows, has ${grid.length}`);
  const out = Buffer.alloc(32 * 32 * 4);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const ch = grid[y][x];
    if (!(ch in PAL)) throw new Error(`${name}: unknown colour ${ch}`);
    const c = PAL[ch];
    if (!c) continue;
    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const i = ((y * 2 + dy) * 32 + x * 2 + dx) * 4;
      out[i] = c[0]; out[i + 1] = c[1]; out[i + 2] = c[2]; out[i + 3] = 255;
    }
  }
  return out;
}

const dir = process.argv[2] ?? "resources/sprites";
mkdirSync(dir, { recursive: true });
const names = Object.keys(S);
for (const n of names) writeFileSync(`${dir}/${n}.png`, png(render(n, S[n]), 32, 32));
// contact sheet (4x upscale, magenta shown as team blue) for quick review
const cols = 6, rows = Math.ceil(names.length / cols), cell = 40, scale = 3;
const sw = cols * cell * scale, sh = rows * cell * scale;
const sheet = Buffer.alloc(sw * sh * 4);
for (let i = 0; i < sw * sh; i++) { sheet[i * 4] = 40; sheet[i * 4 + 1] = 90; sheet[i * 4 + 2] = 60; sheet[i * 4 + 3] = 255; }
names.forEach((n, idx) => {
  const px = render(n, S[n]);
  const ox = (idx % cols) * cell * scale + 4 * scale, oy = Math.floor(idx / cols) * cell * scale + 4 * scale;
  for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) {
    let [r, g, b, a] = [px[(y * 32 + x) * 4], px[(y * 32 + x) * 4 + 1], px[(y * 32 + x) * 4 + 2], px[(y * 32 + x) * 4 + 3]];
    if (!a) continue;
    if (r === 255 && g === 0 && b === 255) [r, g, b] = [60, 140, 255];
    else if (r === 170 && g === 0 && b === 170) [r, g, b] = [30, 80, 180];
    else if (r === 255 && g === 170 && b === 255) [r, g, b] = [130, 190, 255];
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const i = ((oy + y * scale + dy) * sw + ox + x * scale + dx) * 4;
      sheet[i] = r; sheet[i + 1] = g; sheet[i + 2] = b; sheet[i + 3] = 255;
    }
  }
});
writeFileSync(process.argv[3] ?? "/tmp/sprite-sheet.png", png(sheet, sw, sh));
console.log("wrote", names.length, "sprites:", names.join(", "));
