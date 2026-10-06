import { CFG, StructType } from "../core/config";
import { Terrain } from "../core/mapgen";
import type { ClientGame } from "./state";

export interface Camera { x: number; y: number; zoom: number }

const GLYPH: Record<StructType, string> = { bunker: "B", barracks: "K", bank: "$", radar: "R" };

function mix(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (Math.round(ar + (br - ar) * t) << 16) | (Math.round(ag + (bg - ag) * t) << 8) | Math.round(ab + (bb - ab) * t);
}
const css = (c: number) => "#" + c.toString(16).padStart(6, "0");

export interface Overlay {
  lasso: number[];
  ghosts: { pts: number[]; born: number }[];
  hover: { x: number; y: number } | null;
  buildType: StructType | null;
  ringAt: { x: number; y: number; r: number } | null;
}

export class Renderer {
  readonly cam: Camera = { x: 0, y: 0, zoom: 4 };
  private mapCanvas = document.createElement("canvas");
  private mctx = this.mapCanvas.getContext("2d")!;
  private img!: ImageData;
  private px!: Uint32Array;
  private g!: ClientGame;
  private labels: { id: number; x: number; y: number }[] = [];
  private labelsAt = 0;
  private mapDirty = false;
  cw = 0;
  ch = 0;
  private dpr = 1;

  constructor(private canvas: HTMLCanvasElement) {}

  attach(g: ClientGame): void {
    this.g = g;
    this.mapCanvas.width = g.w;
    this.mapCanvas.height = g.h;
    this.img = this.mctx.createImageData(g.w, g.h);
    this.px = new Uint32Array(this.img.data.buffer);
    this.resize();
    this.fit();
    this.labelsAt = 0;
  }

  fit(): void {
    const g = this.g;
    this.cam.zoom = Math.min(this.cw / g.w, this.ch / g.h) * 0.96;
    this.cam.x = g.w / 2;
    this.cam.y = g.h / 2;
  }

  centerOn(tile: number, zoom?: number): void {
    this.cam.x = (tile % this.g.w) + 0.5;
    this.cam.y = Math.floor(tile / this.g.w) + 0.5;
    if (zoom) this.cam.zoom = Math.max(this.cam.zoom, zoom);
  }

  minZoom(): number {
    return Math.min(this.cw / this.g.w, this.ch / this.g.h) * 0.7;
  }

  resize(): void {
    this.dpr = Math.min(window.devicePixelRatio || 1, 3);
    this.cw = this.canvas.clientWidth;
    this.ch = this.canvas.clientHeight;
    this.canvas.width = Math.round(this.cw * this.dpr);
    this.canvas.height = Math.round(this.ch * this.dpr);
  }

  toWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: this.cam.x + (sx - this.cw / 2) / this.cam.zoom, y: this.cam.y + (sy - this.ch / 2) / this.cam.zoom };
  }

  private tileColor(i: number): number {
    const g = this.g;
    const t = g.terrain[i];
    const x = i % g.w, y = (i / g.w) | 0;
    const n = ((x * 7 + y * 13) % 5) / 5;
    let base = t === Terrain.Water ? mix(0x16395c, 0x1d4a73, n) : t === Terrain.Mountain ? mix(0x77756d, 0x8a877d, n) : mix(0x4d7a4b, 0x5c8a55, n);
    const o = g.owner[i];
    if (!o) return base;
    const p = g.players.get(o);
    if (!p) return base;
    let edge = false;
    if (x > 0 && g.owner[i - 1] !== o) edge = true;
    else if (x < g.w - 1 && g.owner[i + 1] !== o) edge = true;
    else if (y > 0 && g.owner[i - g.w] !== o) edge = true;
    else if (y < g.h - 1 && g.owner[i + g.w] !== o) edge = true;
    if (edge) return mix(p.color, 0xffffff, 0.15);
    return mix(base, p.color, 0.55);
  }

  private paint(i: number): void {
    const c = this.tileColor(i);
    this.px[i] = 0xff000000 | ((c & 255) << 16) | (c & 0xff00) | ((c >> 16) & 255);
  }

  private flushDirty(): void {
    const g = this.g;
    if (!g.dirty.length) return;
    for (const i of g.dirty) {
      this.paint(i);
      const x = i % g.w;
      if (x > 0) this.paint(i - 1);
      if (x < g.w - 1) this.paint(i + 1);
      if (i >= g.w) this.paint(i - g.w);
      if (i + g.w < g.owner.length) this.paint(i + g.w);
    }
    g.dirty = [];
    this.mapDirty = true;
  }

  private updateLabels(now: number): void {
    if (now - this.labelsAt < 700) return;
    this.labelsAt = now;
    const g = this.g;
    const sx = new Map<number, number>(), sy = new Map<number, number>(), n = new Map<number, number>();
    for (let i = 0; i < g.owner.length; i++) {
      const o = g.owner[i];
      if (!o) continue;
      sx.set(o, (sx.get(o) ?? 0) + (i % g.w));
      sy.set(o, (sy.get(o) ?? 0) + ((i / g.w) | 0));
      n.set(o, (n.get(o) ?? 0) + 1);
    }
    this.labels = [];
    for (const [id, c] of n) this.labels.push({ id, x: sx.get(id)! / c + 0.5, y: sy.get(id)! / c + 0.5 });
  }

  draw(now: number, ov: Overlay): void {
    const g = this.g;
    this.flushDirty();
    if (this.mapDirty) { this.mctx.putImageData(this.img, 0, 0); this.mapDirty = false; }
    this.updateLabels(now);
    const ctx = this.canvas.getContext("2d")!;
    const { cam, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#0b1a2b";
    ctx.fillRect(0, 0, this.cw, this.ch);
    ctx.save();
    ctx.translate(this.cw / 2 - cam.x * cam.zoom, this.ch / 2 - cam.y * cam.zoom);
    ctx.scale(cam.zoom, cam.zoom);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.mapCanvas, 0, 0);

    // capitals
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const p of g.players.values()) {
      if (g.owner[p.cap] !== p.id) continue;
      ctx.font = `${Math.max(1.6, 12 / cam.zoom)}px sans-serif`;
      ctx.fillStyle = "#fff";
      ctx.fillText("★", (p.cap % g.w) + 0.5, Math.floor(p.cap / g.w) + 0.5);
    }

    // structures
    const rr = Math.max(0.9, 8 / cam.zoom);
    for (const s of g.structs) {
      const p = g.players.get(s.owner);
      ctx.beginPath();
      ctx.arc(s.x + 0.5, s.y + 0.5, rr, 0, Math.PI * 2);
      ctx.fillStyle = p ? css(mix(p.color, 0x000000, 0.35)) : "#333";
      ctx.fill();
      ctx.lineWidth = Math.max(0.12, 1.5 / cam.zoom);
      ctx.strokeStyle = "#fff";
      ctx.stroke();
      ctx.fillStyle = "#fff";
      ctx.font = `bold ${rr * 1.3}px sans-serif`;
      ctx.fillText(GLYPH[s.type], s.x + 0.5, s.y + 0.55);
    }

    // range ring
    if (ov.ringAt) {
      const r = ov.ringAt;
      ctx.beginPath();
      ctx.arc(r.x + 0.5, r.y + 0.5, r.r, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255,255,255,0.10)";
      ctx.fill();
      ctx.setLineDash([6 / cam.zoom, 4 / cam.zoom]);
      ctx.lineWidth = Math.max(0.1, 2 / cam.zoom);
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // fading ghosts of recent lassos
    for (const gh of ov.ghosts) {
      const a = 1 - (now - gh.born) / 2200;
      if (a <= 0) continue;
      this.path(ctx, gh.pts, true);
      ctx.fillStyle = `rgba(255,255,255,${0.14 * a})`;
      ctx.fill();
      ctx.lineWidth = Math.max(0.1, 2 / cam.zoom);
      ctx.strokeStyle = `rgba(255,255,255,${0.7 * a})`;
      ctx.stroke();
    }

    // live lasso
    if (ov.lasso.length >= 4) {
      this.path(ctx, ov.lasso, true);
      ctx.fillStyle = "rgba(255,230,120,0.18)";
      ctx.fill();
      ctx.lineWidth = Math.max(0.12, 2.5 / cam.zoom);
      ctx.strokeStyle = "#ffe678";
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      this.path(ctx, ov.lasso, false);
      ctx.stroke();
    }

    // attack markers
    for (const a of g.attacks) {
      if (a.x === undefined || a.y === undefined) continue;
      const mine = a.by === g.you;
      const pulse = 0.6 + 0.4 * Math.sin(now / 220 + a.id);
      ctx.beginPath();
      ctx.arc(a.x, a.y, Math.max(0.8, 7 / cam.zoom) * (0.9 + 0.2 * pulse), 0, Math.PI * 2);
      ctx.fillStyle = mine ? "rgba(255,230,120,0.85)" : "rgba(255,80,80,0.85)";
      ctx.fill();
      ctx.fillStyle = "#111";
      ctx.font = `bold ${Math.max(1.2, 9 / cam.zoom)}px sans-serif`;
      ctx.fillText(String(a.pool ?? ""), a.x, a.y + 0.05);
    }
    ctx.restore();

    // names + troop counts
    for (const l of this.labels) {
      const p = g.players.get(l.id);
      const st = g.stats.get(l.id);
      if (!p || !st || !st.alive) continue;
      const size = Math.min(22, Math.sqrt(st.tiles) * cam.zoom * 0.42);
      if (size < 8) continue;
      const sx = this.cw / 2 + (l.x - cam.x) * cam.zoom;
      const sy = this.ch / 2 + (l.y - cam.y) * cam.zoom;
      if (sx < -80 || sy < -40 || sx > this.cw + 80 || sy > this.ch + 40) continue;
      ctx.font = `600 ${size}px system-ui, sans-serif`;
      ctx.lineWidth = Math.max(2, size / 6);
      ctx.strokeStyle = "rgba(0,0,0,0.7)";
      ctx.fillStyle = "#fff";
      ctx.strokeText(p.name, sx, sy - size * 0.55);
      ctx.fillText(p.name, sx, sy - size * 0.55);
      ctx.font = `${size * 0.85}px system-ui, sans-serif`;
      const t = String(Math.floor(st.troops));
      ctx.strokeText(t, sx, sy + size * 0.5);
      ctx.fillText(t, sx, sy + size * 0.5);
    }
  }

  private path(ctx: CanvasRenderingContext2D, pts: number[], close: boolean): void {
    ctx.beginPath();
    ctx.moveTo(pts[0], pts[1]);
    for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i], pts[i + 1]);
    if (close) ctx.closePath();
  }
}

export { CFG };
