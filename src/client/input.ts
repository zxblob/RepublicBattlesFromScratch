import type { Renderer } from "./render";

interface Ptr {
  x: number; y: number; sx: number; sy: number; t: number; type: string; button: number;
}

export interface InputHooks {
  /** true when a one-finger drag should draw instead of pan */
  drawMode(): boolean;
  /** polygon in tile coords + mean pen pressure (null for non-pen input) */
  onLasso(poly: number[], pressure: number | null): void;
  onTap(wx: number, wy: number): void;
}

const MAX_POINTS = 300;

/**
 * Unified pointer handling for mouse, touch and Apple Pencil.
 *  - pen: always draws (palm rejection: touches are ignored while the pen is down); pressure scales troops
 *  - mouse: left-drag draws, right/middle/shift-drag pans, wheel zooms
 *  - touch: one finger pans (or draws in draw mode / after a long-press), two fingers pan + pinch-zoom
 */
export class Input {
  lasso: number[] = [];
  hover: { x: number; y: number } | null = null;
  private ptrs = new Map<number, Ptr>();
  private mode: "none" | "pending" | "pan" | "lasso" | "pinch" = "none";
  private pressures: number[] = [];
  private lassoPtr = -1;
  private longPress = 0;
  private pinch = { dist: 0, cx: 0, cy: 0, zoom: 1 };
  private penDown = false;
  private spaceDown = false;

  constructor(private canvas: HTMLCanvasElement, private r: Renderer, private hooks: InputHooks) {
    canvas.style.touchAction = "none";
    canvas.addEventListener("pointerdown", this.down);
    canvas.addEventListener("pointermove", this.move);
    canvas.addEventListener("pointerup", this.up);
    canvas.addEventListener("pointercancel", this.cancel);
    canvas.addEventListener("pointerleave", () => { if (!this.ptrs.size) this.hover = null; });
    canvas.addEventListener("wheel", this.wheel, { passive: false });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    for (const ev of ["gesturestart", "gesturechange", "gestureend"]) {
      document.addEventListener(ev, (e) => e.preventDefault());
    }
    window.addEventListener("keydown", (e) => { if (e.code === "Space" && !(e.target instanceof HTMLInputElement)) this.spaceDown = true; });
    window.addEventListener("keyup", (e) => { if (e.code === "Space") this.spaceDown = false; });
  }

  private pos(e: PointerEvent): { x: number; y: number } {
    const b = this.canvas.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  }

  private down = (e: PointerEvent): void => {
    if (e.pointerType === "touch" && this.penDown) return; // palm rejection
    e.preventDefault();
    try { this.canvas.setPointerCapture(e.pointerId); } catch { /* synthetic or already released */ }
    const { x, y } = this.pos(e);
    this.ptrs.set(e.pointerId, { x, y, sx: x, sy: y, t: performance.now(), type: e.pointerType, button: e.button });
    if (e.pointerType === "pen") {
      this.penDown = true;
      this.cancelGesture();
      this.beginLasso(e.pointerId, x, y, e.pressure);
      return;
    }
    const touches = [...this.ptrs.values()].filter((p) => p.type === "touch");
    if (e.pointerType === "touch" && touches.length >= 2) {
      this.cancelLasso();
      this.startPinch(touches);
      return;
    }
    if (e.pointerType === "mouse") {
      if (e.button === 1 || e.button === 2 || e.shiftKey || this.spaceDown) this.mode = "pan";
      else this.mode = "pending";
      return;
    }
    // single finger
    if (this.hooks.drawMode()) this.beginLasso(e.pointerId, x, y, 0);
    else {
      this.mode = "pending";
      window.clearTimeout(this.longPress);
      this.longPress = window.setTimeout(() => {
        const p = this.ptrs.get(e.pointerId);
        if (p && this.mode === "pending" && Math.hypot(p.x - p.sx, p.y - p.sy) < 8) {
          navigator.vibrate?.(12);
          this.beginLasso(e.pointerId, p.x, p.y, 0);
        }
      }, 420);
    }
  };

  private move = (e: PointerEvent): void => {
    const p = this.ptrs.get(e.pointerId);
    const { x, y } = this.pos(e);
    if (!p) {
      if (e.pointerType !== "touch") this.hover = this.r.toWorld(x, y);
      return;
    }
    e.preventDefault();
    const dx = x - p.x, dy = y - p.y;
    p.x = x;
    p.y = y;
    if (e.pointerType !== "touch") this.hover = this.r.toWorld(x, y);

    if (this.mode === "pinch") return this.updatePinch();
    if (this.mode === "pan") {
      this.r.cam.x -= dx / this.r.cam.zoom;
      this.r.cam.y -= dy / this.r.cam.zoom;
      return;
    }
    if (this.mode === "pending") {
      const moved = Math.hypot(x - p.sx, y - p.sy);
      if (p.type === "mouse" && moved > 4) this.beginLasso(e.pointerId, p.sx, p.sy, 0, true);
      else if (p.type === "touch" && moved > 8) { window.clearTimeout(this.longPress); this.mode = "pan"; }
    }
    if (this.mode === "lasso" && e.pointerId === this.lassoPtr) {
      const evs = e.getCoalescedEvents?.() ?? [e];
      for (const ce of evs.length ? evs : [e]) {
        const q = this.pos(ce);
        this.addPoint(q.x, q.y);
        if (e.pointerType === "pen" && ce.pressure > 0) this.pressures.push(ce.pressure);
      }
    }
  };

  private up = (e: PointerEvent): void => {
    const p = this.ptrs.get(e.pointerId);
    if (!p) return;
    window.clearTimeout(this.longPress);
    this.ptrs.delete(e.pointerId);
    if (e.pointerType === "pen") this.penDown = false;
    if (this.mode === "lasso" && e.pointerId === this.lassoPtr) {
      this.finishLasso(e.pointerType === "pen");
    } else if (this.mode === "pending" && Math.hypot(p.x - p.sx, p.y - p.sy) < 10) {
      const w = this.r.toWorld(p.x, p.y);
      this.hooks.onTap(w.x, w.y);
    }
    if (this.mode === "pinch" && [...this.ptrs.values()].filter((q) => q.type === "touch").length < 2) {
      this.mode = "none";
      // keep remaining finger from jumping the map
      for (const q of this.ptrs.values()) { q.sx = q.x; q.sy = q.y; }
      return;
    }
    if (this.ptrs.size === 0) { this.mode = "none"; if (e.pointerType === "touch") this.hover = null; }
  };

  private cancel = (e: PointerEvent): void => {
    this.ptrs.delete(e.pointerId);
    if (e.pointerType === "pen") this.penDown = false;
    if (e.pointerId === this.lassoPtr) this.cancelLasso();
    window.clearTimeout(this.longPress);
    if (this.ptrs.size === 0) this.mode = "none";
  };

  private wheel = (e: WheelEvent): void => {
    e.preventDefault();
    const b = this.canvas.getBoundingClientRect();
    this.zoomAt(e.clientX - b.left, e.clientY - b.top, Math.exp(-e.deltaY * 0.0015));
  };

  private zoomAt(sx: number, sy: number, f: number): void {
    const before = this.r.toWorld(sx, sy);
    this.r.cam.zoom = Math.max(this.r.minZoom(), Math.min(48, this.r.cam.zoom * f));
    const after = this.r.toWorld(sx, sy);
    this.r.cam.x += before.x - after.x;
    this.r.cam.y += before.y - after.y;
  }

  private startPinch(touches: Ptr[]): void {
    this.mode = "pinch";
    window.clearTimeout(this.longPress);
    const [a, b] = touches;
    this.pinch = {
      dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, zoom: this.r.cam.zoom,
    };
  }

  private updatePinch(): void {
    const t = [...this.ptrs.values()].filter((p) => p.type === "touch");
    if (t.length < 2) return;
    const [a, b] = t;
    const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
    // pan with the midpoint
    this.r.cam.x -= (cx - this.pinch.cx) / this.r.cam.zoom;
    this.r.cam.y -= (cy - this.pinch.cy) / this.r.cam.zoom;
    const target = this.pinch.zoom * (dist / this.pinch.dist);
    this.zoomAt(cx, cy, target / this.r.cam.zoom);
    this.pinch.cx = cx;
    this.pinch.cy = cy;
  }

  private cancelGesture(): void {
    this.mode = "none";
    window.clearTimeout(this.longPress);
    for (const [id, p] of this.ptrs) if (p.type === "touch") this.ptrs.delete(id);
  }

  private beginLasso(id: number, sx: number, sy: number, pressure: number, _fromMouse = false): void {
    this.mode = "lasso";
    this.lassoPtr = id;
    this.lasso = [];
    this.pressures = pressure > 0 ? [pressure] : [];
    this.addPoint(sx, sy, true);
  }

  private addPoint(sx: number, sy: number, force = false): void {
    const w = this.r.toWorld(sx, sy);
    const n = this.lasso.length;
    if (!force && n >= 2) {
      const lx = this.lasso[n - 2], ly = this.lasso[n - 1];
      if (Math.hypot(w.x - lx, w.y - ly) * this.r.cam.zoom < 3) return;
    }
    this.lasso.push(w.x, w.y);
  }

  private cancelLasso(): void {
    this.lasso = [];
    this.lassoPtr = -1;
    this.mode = "none";
  }

  private finishLasso(isPen: boolean): void {
    let pts = this.lasso;
    this.lasso = [];
    this.lassoPtr = -1;
    this.mode = "none";
    if (pts.length < 4) return; // walls and tank routes may be a simple 2-point line
    const n = pts.length / 2;
    if (n > MAX_POINTS) {
      const out: number[] = [];
      for (let i = 0; i < MAX_POINTS; i++) {
        const j = Math.floor((i * n) / MAX_POINTS);
        out.push(pts[j * 2], pts[j * 2 + 1]);
      }
      pts = out;
    }
    const avg = this.pressures.length ? this.pressures.reduce((a, b) => a + b, 0) / this.pressures.length : null;
    this.hooks.onLasso(pts, isPen ? avg : null);
  }
}
