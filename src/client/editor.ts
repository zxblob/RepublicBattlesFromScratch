import { generateMap, Terrain } from "../core/mapgen";
import { rle } from "../core/protocol";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const cv = $<HTMLCanvasElement>("cv");
const ctx = cv.getContext("2d")!;
let w = 192, h = 112;
let t: Uint8Array = new Uint8Array(w * h).fill(Terrain.Water);
let brush = 1;
const undo: Uint8Array[] = [];
const COLORS = [[0x1d, 0x4a, 0x73], [0x5c, 0x8a, 0x55], [0x8a, 0x87, 0x7d]];

function resize(nw: number, nh: number): void {
  w = nw; h = nh;
  t = new Uint8Array(w * h).fill(Terrain.Water);
  cv.width = w; cv.height = h;
  undo.length = 0;
  draw();
}

function draw(): void {
  const img = ctx.createImageData(w, h);
  let land = 0;
  for (let i = 0; i < t.length; i++) {
    const c = COLORS[t[i]];
    img.data[i * 4] = c[0]; img.data[i * 4 + 1] = c[1]; img.data[i * 4 + 2] = c[2]; img.data[i * 4 + 3] = 255;
    if (t[i] !== Terrain.Water) land++;
  }
  ctx.putImageData(img, 0, 0);
  $("land").textContent = String(land);
}

function paint(px: number, py: number, pressure: number): void {
  const r = Math.max(1, Math.round(Number($<HTMLInputElement>("rad").value) * (pressure > 0 && pressure < 1 ? 0.4 + pressure * 1.2 : 1)));
  const b = cv.getBoundingClientRect();
  const cx = Math.floor(((px - b.left) / b.width) * w), cy = Math.floor(((py - b.top) / b.height) * h);
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      if (x < 0 || y < 0 || x >= w || y >= h || (x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
      t[y * w + x] = brush;
    }
  }
  draw();
}

let drawing = false;
cv.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  cv.setPointerCapture(e.pointerId);
  undo.push(t.slice());
  if (undo.length > 15) undo.shift();
  drawing = true;
  paint(e.clientX, e.clientY, e.pointerType === "pen" ? e.pressure : 0);
});
cv.addEventListener("pointermove", (e) => {
  if (!drawing) return;
  for (const ce of e.getCoalescedEvents?.() ?? [e]) paint(ce.clientX, ce.clientY, e.pointerType === "pen" ? ce.pressure : 0);
});
const stop = () => { drawing = false; };
cv.addEventListener("pointerup", stop);
cv.addEventListener("pointercancel", stop);

for (let i = 0; i < 3; i++) {
  $("b" + i).onclick = () => {
    brush = i;
    for (let j = 0; j < 3; j++) $("b" + j).classList.toggle("on", j === i);
  };
}
$<HTMLSelectElement>("size").onchange = (e) => {
  const [nw, nh] = (e.target as HTMLSelectElement).value.split("x").map(Number);
  resize(nw, nh);
};
$("new").onclick = () => { undo.push(t.slice()); t.fill(Terrain.Water); draw(); };
$("rand").onclick = () => { undo.push(t.slice()); t = generateMap((Math.random() * 2 ** 31) | 0, w, h); draw(); };
$("undo").onclick = () => { const p = undo.pop(); if (p) { t = p; draw(); } };
$("pub").onclick = async () => {
  $("msg").textContent = "";
  $("result").textContent = "";
  try {
    const res = await fetch("api/maps", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: $<HTMLInputElement>("name").value, w, h, rle: rle(t) }),
    });
    if (!res.ok) { $("msg").textContent = await res.text(); return; }
    $("result").textContent = (await res.json()).code;
  } catch {
    $("msg").textContent = "Could not reach the server";
  }
};

resize(w, h);
$("rand").click();
