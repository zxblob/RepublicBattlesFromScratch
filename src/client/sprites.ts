/** Loads the pixel-art PNGs and tints their team-colour pixels per owner. Falls back to null until loaded. */
export const SPRITE_NAMES = [
  "bunker", "barracks", "bank", "radar", "tankfactory", "airbase", "sam", "factory", "port", "city", "farm", "lab",
  "silo", "spaceport", "tank", "fighter", "bomber", "transport", "warship", "trade", "missile", "capital",
] as const;
export type SpriteName = (typeof SPRITE_NAMES)[number];

export class Sprites {
  private img = new Map<string, HTMLImageElement>();
  private tinted = new Map<string, HTMLCanvasElement>();
  ready = false;
  onload: () => void = () => {};

  load(base: string): void {
    let left = SPRITE_NAMES.length;
    for (const n of SPRITE_NAMES) {
      const im = new Image();
      im.onload = () => {
        this.img.set(n, im);
        if (--left === 0) { this.ready = true; this.onload(); }
      };
      im.onerror = () => { if (--left === 0) { this.ready = this.img.size > 0; this.onload(); } };
      im.src = `${base}${n}.png`;
    }
  }

  /** Sprite with magenta team pixels replaced by `color` (0xRRGGBB); null if that sprite is not available. */
  get(name: string, color: number): HTMLCanvasElement | null {
    const key = name + color;
    const hit = this.tinted.get(key);
    if (hit) return hit;
    const im = this.img.get(name);
    if (!im) return null;
    const c = document.createElement("canvas");
    c.width = c.height = 32;
    const x = c.getContext("2d")!;
    x.drawImage(im, 0, 0);
    const d = x.getImageData(0, 0, 32, 32);
    const r = (color >> 16) & 255, g = (color >> 8) & 255, b = color & 255;
    const dark = [r * 0.62, g * 0.62, b * 0.62], light = [r + (255 - r) * 0.45, g + (255 - g) * 0.45, b + (255 - b) * 0.45];
    for (let i = 0; i < d.data.length; i += 4) {
      const pr = d.data[i], pg = d.data[i + 1], pb = d.data[i + 2];
      if (d.data[i + 3] === 0) continue;
      let t: number[] | null = null;
      if (pr === 255 && pg === 0 && pb === 255) t = [r, g, b];
      else if (pr === 170 && pg === 0 && pb === 170) t = dark;
      else if (pr === 255 && pg === 170 && pb === 255) t = light;
      if (t) { d.data[i] = t[0]; d.data[i + 1] = t[1]; d.data[i + 2] = t[2]; }
    }
    x.putImageData(d, 0, 0);
    this.tinted.set(key, c);
    return c;
  }
}
