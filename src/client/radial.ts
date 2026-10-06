/** A tap-anywhere radial menu: a ring of round buttons around the tap point, with optional sub-rings. */
export interface RItem {
  label: string;
  /** second line, e.g. a cost */
  sub?: string;
  /** image URL (data URL of a pixel sprite) or a short text glyph */
  icon?: string;
  glyph?: string;
  disabled?: boolean;
  danger?: boolean;
  onClick?: () => void;
  children?: RItem[];
}

export class Radial {
  private root = document.createElement("div");
  private stack: RItem[][] = [];
  private cx = 0;
  private cy = 0;
  isOpen = false;

  constructor(parent: HTMLElement) {
    this.root.id = "radial";
    this.root.className = "hidden";
    parent.appendChild(this.root);
    window.addEventListener("keydown", (e) => { if (e.key === "Escape") this.close(); });
  }

  /** `x`,`y` are viewport pixels of the tap. */
  open(x: number, y: number, items: RItem[]): void {
    const pad = 110;
    this.cx = Math.max(pad, Math.min(window.innerWidth - pad, x));
    this.cy = Math.max(pad, Math.min(window.innerHeight - pad, y));
    this.stack = [items];
    this.isOpen = true;
    this.root.classList.remove("hidden");
    this.render();
  }

  close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.stack = [];
    this.root.classList.add("hidden");
    this.root.innerHTML = "";
  }

  private render(): void {
    const items = this.stack[this.stack.length - 1];
    const n = items.length;
    const R = n <= 4 ? 78 : n <= 7 ? 92 : 108;
    this.root.innerHTML = "";
    this.root.style.left = this.cx + "px";
    this.root.style.top = this.cy + "px";
    const ring = document.createElement("div");
    ring.className = "r-ring";
    ring.style.width = ring.style.height = R * 2 + "px";
    this.root.appendChild(ring);

    const mk = (cls: string, x: number, y: number): HTMLButtonElement => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "r-btn " + cls;
      b.style.transform = `translate(${x}px, ${y}px)`;
      b.addEventListener("pointerdown", (e) => e.stopPropagation());
      this.root.appendChild(b);
      return b;
    };

    // centre: back or close
    const c = mk("r-center", 0, 0);
    c.textContent = this.stack.length > 1 ? "‹" : "✕";
    c.onclick = () => { if (this.stack.length > 1) { this.stack.pop(); this.render(); } else this.close(); };

    items.forEach((it, i) => {
      const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
      const b = mk("r-item" + (it.disabled ? " off" : "") + (it.danger ? " danger" : ""), Math.cos(a) * R, Math.sin(a) * R);
      b.style.animationDelay = i * 18 + "ms";
      if (it.icon) {
        const im = document.createElement("img");
        im.src = it.icon;
        b.appendChild(im);
      } else if (it.glyph) {
        const g = document.createElement("span");
        g.className = "g";
        g.textContent = it.glyph;
        b.appendChild(g);
      }
      const l = document.createElement("span");
      l.className = "l";
      l.textContent = it.label;
      b.appendChild(l);
      if (it.sub) {
        const s = document.createElement("span");
        s.className = "s";
        s.textContent = it.sub;
        b.appendChild(s);
      }
      b.onclick = () => {
        if (it.disabled) return;
        if (it.children) { this.stack.push(it.children); this.render(); return; }
        this.close();
        it.onClick?.();
      };
    });
  }
}
