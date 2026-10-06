import { CFG, StructType } from "../core/config";
import { generateMap, Terrain } from "../core/mapgen";
import { unrle } from "../core/protocol";
import type { AttackInfo, PlayerInfo, PlayerStat, ServerMsg, StructInfo } from "../core/protocol";

export interface Stat { troops: number; gold: number; tiles: number; alive: boolean }

export class ClientGame {
  w: number;
  h: number;
  you: number;
  terrain: Uint8Array;
  owner: Uint16Array;
  players = new Map<number, PlayerInfo>();
  stats = new Map<number, Stat>();
  attacks: AttackInfo[] = [];
  structs: StructInfo[] = [];
  paused = false;
  over = false;
  winner = 0;
  tick = 0;
  /** tiles changed since the renderer last repainted */
  dirty: number[] = [];
  landTiles = 0;

  constructor(m: Extract<ServerMsg, { t: "start" }>) {
    this.w = m.w;
    this.h = m.h;
    this.you = m.you;
    this.terrain = generateMap(m.seed, m.w, m.h);
    this.owner = new Uint16Array(m.w * m.h);
    unrle(m.owners, this.owner);
    for (const p of m.players) this.players.set(p.id, p);
    this.structs = m.structs;
    this.paused = m.paused;
    this.tick = m.tick;
    for (let i = 0; i < this.terrain.length; i++) if (this.terrain[i] !== Terrain.Water) this.landTiles++;
    for (const p of m.players) this.stats.set(p.id, { troops: 0, gold: 0, tiles: 0, alive: true });
    for (let i = 0; i < this.owner.length; i++) {
      const o = this.owner[i];
      if (o) this.stats.get(o)!.tiles++;
    }
    for (let i = 0; i < this.owner.length; i++) this.dirty.push(i);
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
    if (m.s) this.structs = m.s;
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

  hasRadar(): boolean {
    return this.structs.some((s) => s.owner === this.you && s.type === "radar");
  }
}
