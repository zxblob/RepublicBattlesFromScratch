import { CFG, StructType } from "../core/config";
import { Terrain } from "../core/mapgen";
import { unrle } from "../core/protocol";
import type {
  AttackInfo, MeInfo, MissileInfo, PlayerInfo, PlayerStat, ServerMsg, StructInfo, TrainInfo, UnitInfo,
} from "../core/protocol";

export interface Stat { troops: number; gold: number; tiles: number; alive: boolean }

export class ClientGame {
  w: number;
  h: number;
  you: number;
  mode: string;
  teams: number;
  planet: string;
  phase: string;
  /** phase countdown (cold war), ticks */
  pt = 0;
  terrain: Uint8Array;
  owner: Uint16Array;
  players = new Map<number, PlayerInfo>();
  stats = new Map<number, Stat>();
  attacks: AttackInfo[] = [];
  structs: StructInfo[] = [];
  units: UnitInfo[] = [];
  missiles: MissileInfo[] = [];
  trains: TrainInfo[] = [];
  walls = new Map<number, number>();
  rails = new Uint8Array(0);
  /** bumped whenever rails or structures change, so the renderer can rebuild its trains */
  railVersion = 0;
  /** dominance countdown ticks and leader id */
  dm = 0;
  dl = 0;
  /** floating emoji above a nation: [player id, text, born ms] */
  emojis: { id: number; text: string; born: number }[] = [];
  skins = new Map<number, Uint8ClampedArray>();
  me_: MeInfo = { rp: 0, tech: [], allies: [], reqs: [], canLaunch: false, embargo: [] };
  paused = false;
  over = false;
  winner = 0;
  winnerTeam = 0;
  tick = 0;
  /** spawn-phase ticks remaining */
  sp = 0;
  /** tiles changed since the renderer last repainted */
  dirty: number[] = [];
  landTiles = 0;
  /** set when a skin finishes decoding so the renderer repaints that nation */
  skinChanged: number[] = [];

  constructor(m: Extract<ServerMsg, { t: "start" }>) {
    this.w = m.w;
    this.h = m.h;
    this.you = m.you;
    this.mode = m.mode;
    this.teams = m.teams;
    this.planet = m.planet;
    this.phase = m.phase;
    this.pt = m.pt;
    this.terrain = new Uint8Array(m.w * m.h);
    unrle(m.terrain, this.terrain);
    this.owner = new Uint16Array(m.w * m.h);
    unrle(m.owners, this.owner);
    this.rails = new Uint8Array(m.w * m.h);
    for (const t of m.rails) this.rails[t] = 1;
    this.railVersion++;
    for (const p of m.players) { this.players.set(p.id, p); if (p.skin) this.loadSkin(p.id, p.skin); }
    this.structs = m.structs;
    this.units = m.units;
    for (const [t, hp] of m.walls) this.walls.set(t, hp);
    this.paused = m.paused;
    this.tick = m.tick;
    this.sp = m.sp;
    for (let i = 0; i < this.terrain.length; i++) if (this.terrain[i] !== Terrain.Water) this.landTiles++;
    for (const p of m.players) this.stats.set(p.id, { troops: 0, gold: 0, tiles: 0, alive: true });
    for (let i = 0; i < this.owner.length; i++) {
      const o = this.owner[i];
      if (o) this.stats.get(o)!.tiles++;
    }
    for (let i = 0; i < this.owner.length; i++) this.dirty.push(i);
  }

  /** Decode a data-URL image into a small RGBA tile that is repeated across the nation's land. */
  loadSkin(id: number, data: string): void {
    if (!data) { this.skins.delete(id); this.skinChanged.push(id); return; }
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = c.height = 64;
      const cx = c.getContext("2d")!;
      cx.drawImage(img, 0, 0, 64, 64);
      this.skins.set(id, cx.getImageData(0, 0, 64, 64).data);
      this.skinChanged.push(id);
    };
    img.src = data;
  }

  applyTick(m: Extract<ServerMsg, { t: "tick" }>): string[] {
    this.tick = m.n;
    for (let i = 0; i < m.d.length; i += 2) {
      this.owner[m.d[i]] = m.d[i + 1];
      this.dirty.push(m.d[i]);
    }
    for (const [id, troops, gold, tiles, alive] of m.p as PlayerStat[]) {
      const s = this.stats.get(id);
      if (s) { s.troops = troops; s.gold = gold; s.tiles = tiles; s.alive = !!alive; }
    }
    this.attacks = m.a;
    this.units = m.u;
    this.missiles = m.ms;
    this.trains = m.tr;
    this.phase = m.ph;
    this.pt = m.pt;
    this.me_ = m.me;
    this.dm = m.dm;
    this.dl = m.dl;
    if (m.rl) { for (const [t, v] of m.rl) { this.rails[t] = v; this.dirty.push(t); } this.railVersion++; }
    if (m.sk) for (const [id, data] of m.sk) { const p = this.players.get(id); if (p) p.skin = data; this.loadSkin(id, data); }
    if (m.w) for (const [t, hp] of m.w) { if (hp > 0) this.walls.set(t, hp); else this.walls.delete(t); this.dirty.push(t); }
    this.sp = m.sp;
    if (m.caps) for (const [id, cap] of m.caps) { const p = this.players.get(id); if (p) p.cap = cap; }
    if (m.s) { this.structs = m.s; this.railVersion++; }
    return m.ev ?? [];
  }

  me(): Stat {
    return this.stats.get(this.you) ?? { troops: 0, gold: 0, tiles: 0, alive: false };
  }

  structCost(type: StructType): number {
    let n = 0;
    for (const s of this.structs) if (s.owner === this.you && s.type === type) n++;
    return Math.round(CFG.structures[type].cost * Math.pow(CFG.structCostGrowth, n));
  }

  has(type: StructType): boolean {
    return this.structs.some((s) => s.owner === this.you && s.type === type);
  }

  get research(): boolean {
    return this.mode === "ww" || this.mode === "wow";
  }

  friendly(id: number): boolean {
    if (id === this.you) return true;
    const a = this.players.get(this.you), b = this.players.get(id);
    return !!a && !!b && ((a.team !== 0 && a.team === b.team) || this.me_.allies.includes(id));
  }
}
