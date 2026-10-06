import { CFG, StructType } from "./config";
import { rasterizePolygon } from "./geometry";
import { generateMap, Terrain } from "./mapgen";
import { mulberry32, Rng } from "./rng";
import { botThink } from "./bots";

export interface Player {
  id: number;
  name: string;
  color: number; // 0xRRGGBB
  isBot: boolean;
  troops: number;
  gold: number;
  tiles: number;
  alive: boolean;
  capital: number; // tile index or -1
  nextAggression: number;
  aggression: number; // bot personality 0.6..1.4
}

export interface Structure {
  id: number;
  type: StructType;
  owner: number;
  tile: number;
  x: number;
  y: number;
}

export interface Attack {
  id: number;
  by: number;
  on: number; // dominant defender at launch (0 = neutral land)
  tiles: Set<number>;
  pool: number;
  stall: number;
  cx: number;
  cy: number;
}

export type GameEvent =
  | { k: "attack"; id: number; by: number; on: number }
  | { k: "attackEnd"; id: number; by: number }
  | { k: "elim"; id: number; by: number }
  | { k: "win"; id: number };

export interface Result<T = {}> {
  ok: boolean;
  error?: string;
  data?: T;
}

export function hslToRgb(h: number, s: number, l: number): number {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255);
}

export class Game {
  readonly w: number;
  readonly h: number;
  readonly seed: number;
  readonly terrain: Uint8Array;
  readonly owner: Uint16Array;
  readonly players: Player[] = [null as unknown as Player]; // index = id, slot 0 = neutral
  readonly structures: Structure[] = [];
  readonly structAt = new Map<number, Structure>();
  readonly attacks: Attack[] = [];
  readonly rng: Rng;
  readonly landTiles: number;

  tickNo = 0;
  /** while > 0 the match is in the spawn-selection phase: no economy, no attacks, players may move their start */
  spawnTicks = 0;
  /** [playerId, tile] capital moves since the server last drained them */
  capDirty: [number, number][] = [];
  over = false;
  winner = 0;
  /** tile indices whose owner changed since the server last drained them */
  dirty: number[] = [];
  structDirty = false;
  events: GameEvent[] = [];

  private nextAttackId = 1;
  private nextStructId = 1;

  constructor(seed: number, w = 192, h = 112) {
    this.seed = seed;
    this.w = w;
    this.h = h;
    this.rng = mulberry32(seed ^ 0xabcdef);
    this.terrain = generateMap(seed, w, h);
    this.owner = new Uint16Array(w * h);
    let land = 0;
    for (let i = 0; i < this.terrain.length; i++) if (this.terrain[i] !== Terrain.Water) land++;
    this.landTiles = land;
  }

  addPlayer(name: string, isBot: boolean): Player {
    const id = this.players.length;
    const p: Player = {
      id,
      name,
      color: hslToRgb((id * 137.508) % 360, 0.65, 0.55),
      isBot,
      troops: CFG.startTroops,
      gold: 0,
      tiles: 0,
      alive: true,
      capital: -1,
      nextAggression: 0,
      aggression: 0.6 + this.rng() * 0.8,
    };
    this.players.push(p);
    return p;
  }

  /** Place every added player on a well-separated patch of flat land. Call once after adding all players. */
  spawnAll(): void {
    const { w, h, terrain } = this;
    const r = Math.ceil(Math.sqrt(CFG.spawnRadius2));
    const candidates: number[] = [];
    for (let y = r; y < h - r; y++) {
      for (let x = r; x < w - r; x++) {
        if (this.discIsFlatLand(x, y)) candidates.push(y * w + x);
      }
    }
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    const count = this.players.length - 1;
    let minDist = Math.sqrt(this.landTiles / Math.max(count, 1)) * 1.1;
    let chosen: number[] = [];
    for (let attempt = 0; attempt < 30; attempt++) {
      chosen = [];
      for (const c of candidates) {
        const cx = c % w, cy = (c / w) | 0;
        let ok = true;
        for (const o of chosen) {
          const dx = (o % w) - cx, dy = ((o / w) | 0) - cy;
          if (dx * dx + dy * dy < minDist * minDist) { ok = false; break; }
        }
        if (ok) { chosen.push(c); if (chosen.length === count) break; }
      }
      if (chosen.length === count) break;
      minDist *= 0.85;
    }
    if (chosen.length < count) throw new Error("map too small for players");
    for (let id = 1; id <= count; id++) {
      const c = chosen[id - 1];
      const cx = c % w, cy = (c / w) | 0;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy <= CFG.spawnRadius2) this.setOwner(cy * w + cx + dy * w + dx, id);
        }
      }
      this.players[id].capital = c;
    }
  }

  /** Move a player's starting patch during the spawn phase. */
  respawn(pid: number, x: number, y: number): Result {
    const p = this.players[pid];
    if (!p || !p.alive) return { ok: false, error: "not in game" };
    if (this.spawnTicks <= 0) return { ok: false, error: "spawn phase is over" };
    const r = Math.ceil(Math.sqrt(CFG.spawnRadius2));
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < r || y < r || x >= this.w - r || y >= this.h - r) {
      return { ok: false, error: "too close to the edge" };
    }
    if (!this.discIsFlatLand(x, y)) return { ok: false, error: "needs flat land" };
    for (let dy = -r - 1; dy <= r + 1; dy++) {
      for (let dx = -r - 1; dx <= r + 1; dx++) {
        const o = this.owner[(y + dy) * this.w + x + dx];
        if (o && o !== pid) return { ok: false, error: "too close to another nation" };
      }
    }
    for (let id = 1; id < this.players.length; id++) {
      const o = this.players[id];
      if (id === pid || o.capital < 0) continue;
      if (Math.hypot((o.capital % this.w) - x, ((o.capital / this.w) | 0) - y) < 12) {
        return { ok: false, error: "too close to another nation" };
      }
    }
    for (let i = 0; i < this.owner.length; i++) if (this.owner[i] === pid) this.setOwner(i, 0);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy <= CFG.spawnRadius2) this.setOwner((y + dy) * this.w + x + dx, pid);
      }
    }
    p.capital = y * this.w + x;
    this.capDirty.push([pid, p.capital]);
    return { ok: true };
  }

  private discIsFlatLand(cx: number, cy: number): boolean {
    const r = Math.ceil(Math.sqrt(CFG.spawnRadius2));
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > CFG.spawnRadius2) continue;
        if (this.terrain[(cy + dy) * this.w + cx + dx] !== Terrain.Land) return false;
      }
    }
    return true;
  }

  maxTroops(p: Player): number {
    return CFG.baseCap + p.tiles * CFG.capPerTile;
  }

  structureCost(pid: number, type: StructType): number {
    let n = 0;
    for (const s of this.structures) if (s.owner === pid && s.type === type) n++;
    return Math.round(CFG.structures[type].cost * Math.pow(CFG.structCostGrowth, n));
  }

  hasStructure(pid: number, type: StructType): boolean {
    for (const s of this.structures) if (s.owner === pid && s.type === type) return true;
    return false;
  }

  attacksOf(pid: number): Attack[] {
    return this.attacks.filter((a) => a.by === pid);
  }

  /** number of active attacks aimed mostly at this player */
  attackersOn(pid: number): number {
    let n = 0;
    for (const a of this.attacks) if (a.on === pid) n++;
    return n;
  }

  setOwner(tile: number, id: number): void {
    const prev = this.owner[tile];
    if (prev === id) return;
    if (prev) this.players[prev].tiles--;
    if (id) this.players[id].tiles++;
    this.owner[tile] = id;
    this.dirty.push(tile);
    const s = this.structAt.get(tile);
    if (s) this.removeStructure(s);
  }

  private removeStructure(s: Structure): void {
    this.structAt.delete(s.tile);
    const i = this.structures.indexOf(s);
    if (i >= 0) this.structures.splice(i, 1);
    this.structDirty = true;
  }

  // ---- combat ---------------------------------------------------------------------------------

  /** Troops it costs `attacker` to take `tile` right now. */
  tileCost(attacker: number, tile: number): number {
    const t = this.terrain[tile];
    const o = this.owner[tile];
    const tx = tile % this.w, ty = (tile / this.w) | 0;
    let cost: number;
    if (o === 0) {
      cost = CFG.neutralCost * (t === Terrain.Mountain ? CFG.mountainMult : 1);
    } else {
      const d = this.players[o];
      const density = Math.max(d.troops / Math.max(d.tiles, 1), CFG.minDensity);
      const small = 1 + CFG.smallBonusMax * Math.max(0, Math.min(1, (CFG.smallTiles - d.tiles) / CFG.smallTiles));
      cost = density * small * CFG.playerCostMult * (t === Terrain.Mountain ? CFG.mountainMult : 1);
      if (d.capital >= 0) {
        const dx = (d.capital % this.w) - tx, dy = ((d.capital / this.w) | 0) - ty;
        if (dx * dx + dy * dy <= CFG.capitalRadius * CFG.capitalRadius) cost *= CFG.capitalMult;
      }
      if (this.inRange(o, "bunker", tx, ty)) cost *= CFG.structures.bunker.mult;
    }
    if (this.inRange(attacker, "barracks", tx, ty)) cost *= CFG.structures.barracks.mult;
    return cost;
  }

  private inRange(pid: number, type: StructType, x: number, y: number): boolean {
    const r = CFG.structures[type].range;
    for (const s of this.structures) {
      if (s.owner !== pid || s.type !== type) continue;
      const dx = s.x - x, dy = s.y - y;
      if (dx * dx + dy * dy <= r * r) return true;
    }
    return false;
  }

  launchAttack(pid: number, poly: ArrayLike<number>, ratio: number): Result<{ id: number }> {
    if (poly.length < 6 || poly.length > CFG.maxPolyPoints * 2) return { ok: false, error: "bad shape" };
    for (let i = 0; i < poly.length; i++) if (!Number.isFinite(poly[i])) return { ok: false, error: "bad shape" };
    return this.launchAttackTiles(pid, rasterizePolygon(poly, this.w, this.h), ratio);
  }

  launchAttackTiles(pid: number, rawTiles: number[], ratio: number): Result<{ id: number }> {
    const p = this.players[pid];
    if (!p || !p.alive || this.over) return { ok: false, error: "not in game" };
    if (this.spawnTicks > 0) return { ok: false, error: "choose your start first" };
    if (!Number.isFinite(ratio)) return { ok: false, error: "bad ratio" };
    ratio = Math.max(0.02, Math.min(1, ratio));
    if (this.attacksOf(pid).length >= CFG.maxAttacksPerPlayer) return { ok: false, error: "too many attacks" };
    const tiles = new Set<number>();
    for (const t of rawTiles) if (this.terrain[t] !== Terrain.Water && this.owner[t] !== pid) tiles.add(t);
    if (tiles.size === 0) return { ok: false, error: "nothing to attack" };
    if (tiles.size > CFG.maxRegionTiles) return { ok: false, error: "area too large" };
    let touches = false;
    for (const t of tiles) if (this.touches(t, pid)) { touches = true; break; }
    if (!touches) return { ok: false, error: "area must touch your territory" };
    const pool = p.troops * ratio;
    if (pool < 5) return { ok: false, error: "not enough troops" };
    p.troops -= pool;
    const votes = new Map<number, number>();
    for (const t of tiles) {
      const o = this.owner[t];
      if (o) votes.set(o, (votes.get(o) ?? 0) + 1);
    }
    let on = 0, best = 0;
    for (const [o, n] of votes) if (n > best) { best = n; on = o; }
    const a: Attack = { id: this.nextAttackId++, by: pid, on, tiles, pool, stall: 0, cx: 0, cy: 0 };
    this.attacks.push(a);
    this.events.push({ k: "attack", id: a.id, by: pid, on });
    return { ok: true, data: { id: a.id } };
  }

  cancelAttack(pid: number, id: number): boolean {
    const a = this.attacks.find((x) => x.id === id && x.by === pid);
    if (!a) return false;
    this.endAttack(a);
    return true;
  }

  /** Add `ratio` of the owner's current troops to a running attack. */
  reinforceAttack(pid: number, id: number, ratio: number): Result {
    const a = this.attacks.find((x) => x.id === id && x.by === pid);
    const p = this.players[pid];
    if (!a || !p?.alive) return { ok: false, error: "attack not found" };
    if (!Number.isFinite(ratio)) return { ok: false, error: "bad ratio" };
    const add = p.troops * Math.max(0.02, Math.min(1, ratio));
    if (add < 5) return { ok: false, error: "not enough troops" };
    p.troops -= add;
    a.pool += add;
    a.stall = 0;
    return { ok: true };
  }

  private touches(tile: number, pid: number): boolean {
    const { w, owner } = this;
    const x = tile % w;
    const y = (tile / w) | 0;
    return (
      (x > 0 && owner[tile - 1] === pid) ||
      (x < w - 1 && owner[tile + 1] === pid) ||
      (y > 0 && owner[tile - w] === pid) ||
      (y < this.h - 1 && owner[tile + w] === pid)
    );
  }

  private endAttack(a: Attack): void {
    const p = this.players[a.by];
    if (p.alive) p.troops += a.pool;
    const i = this.attacks.indexOf(a);
    if (i >= 0) this.attacks.splice(i, 1);
    this.events.push({ k: "attackEnd", id: a.id, by: a.by });
  }

  private stepAttack(a: Attack): void {
    const p = this.players[a.by];
    if (!p.alive) return this.endAttack(a);
    const frontier: number[] = [];
    let sx = 0, sy = 0;
    for (const t of a.tiles) {
      if (this.owner[t] === a.by) { a.tiles.delete(t); continue; }
      sx += t % this.w;
      sy += (t / this.w) | 0;
      if (this.touches(t, a.by)) frontier.push(t);
    }
    if (a.tiles.size === 0) return this.endAttack(a);
    a.cx = sx / a.tiles.size + 0.5;
    a.cy = sy / a.tiles.size + 0.5;
    let progress = false;
    if (frontier.length) {
      const k = Math.max(1, Math.min(CFG.maxTilesPerTick, Math.ceil(frontier.length * CFG.tilesPerTickShare)));
      for (let n = 0; n < k && frontier.length; n++) {
        const j = Math.floor(this.rng() * frontier.length);
        const tile = frontier[j];
        frontier[j] = frontier[frontier.length - 1];
        frontier.pop();
        const cost = this.tileCost(a.by, tile);
        if (a.pool < cost) continue;
        a.pool -= cost;
        const o = this.owner[tile];
        if (o) {
          const d = this.players[o];
          d.troops -= Math.min(d.troops, (d.troops / Math.max(d.tiles, 1)) * CFG.defenderLossShare);
        }
        a.tiles.delete(tile);
        this.setOwner(tile, a.by);
        if (o && this.players[o].tiles === 0) this.eliminate(this.players[o], a.by);
        progress = true;
      }
    }
    a.stall = progress ? 0 : a.stall + 1;
    if (a.stall > CFG.stallTicks || a.pool < 1) this.endAttack(a);
  }

  private eliminate(p: Player, by: number): void {
    p.alive = false;
    p.troops = 0;
    p.capital = -1;
    for (const s of this.structures.filter((x) => x.owner === p.id)) this.removeStructure(s);
    for (const a of this.attacks.filter((x) => x.by === p.id)) this.endAttack(a);
    this.events.push({ k: "elim", id: p.id, by });
  }

  // ---- structures -----------------------------------------------------------------------------

  build(pid: number, type: StructType, x: number, y: number): Result<{ id: number }> {
    const p = this.players[pid];
    if (!p || !p.alive || this.over) return { ok: false, error: "not in game" };
    if (this.spawnTicks > 0) return { ok: false, error: "choose your start first" };
    if (!(type in CFG.structures)) return { ok: false, error: "unknown structure" };
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= this.w || y >= this.h) {
      return { ok: false, error: "bad position" };
    }
    const tile = y * this.w + x;
    if (this.owner[tile] !== pid) return { ok: false, error: "must build on your land" };
    if (this.terrain[tile] !== Terrain.Land) return { ok: false, error: "needs flat land" };
    if (this.structAt.has(tile)) return { ok: false, error: "tile occupied" };
    const cost = this.structureCost(pid, type);
    if (p.gold < cost) return { ok: false, error: "not enough gold" };
    p.gold -= cost;
    const s: Structure = { id: this.nextStructId++, type, owner: pid, tile, x, y };
    this.structures.push(s);
    this.structAt.set(tile, s);
    this.structDirty = true;
    return { ok: true, data: { id: s.id } };
  }

  // ---- tick -----------------------------------------------------------------------------------

  tick(): void {
    if (this.over) return;
    this.tickNo++;
    if (this.spawnTicks > 0) { this.spawnTicks--; return; }
    for (const a of [...this.attacks]) this.stepAttack(a);

    const banks = new Map<number, number>();
    for (const s of this.structures) if (s.type === "bank") banks.set(s.owner, (banks.get(s.owner) ?? 0) + 1);

    for (let id = 1; id < this.players.length; id++) {
      const p = this.players[id];
      if (!p.alive) continue;
      const cap = this.maxTroops(p);
      if (p.troops < cap) {
        let regen = CFG.regenBase + p.tiles * CFG.regenPerTile + CFG.regenGrowth * p.troops * (1 - p.troops / cap);
        if (p.tiles < CFG.lastStandTiles && p.capital >= 0) {
          regen += CFG.lastStandRegen * (1 - p.tiles / CFG.lastStandTiles);
        }
        p.troops = Math.min(cap, p.troops + regen);
      }
      p.gold += CFG.goldBase + p.tiles * CFG.goldPerTile + (banks.get(id) ?? 0) * CFG.bankGold;
      if (p.isBot && (this.tickNo + id) % 10 === 0) botThink(this, p);
    }
    this.checkWin();
  }

  private checkWin(): void {
    let alive = 0, last = 0, humansAlive = 0;
    for (let id = 1; id < this.players.length; id++) {
      const p = this.players[id];
      if (!p.alive) continue;
      alive++;
      last = id;
      if (!p.isBot) humansAlive++;
      if (p.tiles >= this.landTiles * 0.7) { this.finish(id); return; }
    }
    if (alive <= 1) this.finish(last);
    else if (humansAlive === 0 && this.players.some((p) => p && !p.isBot)) {
      let top = 0;
      for (let id = 1; id < this.players.length; id++) {
        const p = this.players[id];
        if (p.alive && (top === 0 || p.tiles > this.players[top].tiles)) top = id;
      }
      this.finish(top);
    }
  }

  private finish(id: number): void {
    this.over = true;
    this.winner = id;
    this.events.push({ k: "win", id });
  }

  // ---- helpers for bots -----------------------------------------------------------------------

  /** Border scan: neutral and enemy tiles adjacent to `pid`, plus own tiles that face enemies. */
  scanBorder(pid: number): { neutral: number[]; enemies: Map<number, number[]>; ownFront: number[] } {
    const { w, h, owner, terrain } = this;
    const neutral: number[] = [];
    const enemies = new Map<number, number[]>();
    const ownFront: number[] = [];
    for (let i = 0; i < owner.length; i++) {
      if (owner[i] !== pid) continue;
      const x = i % w, y = (i / w) | 0;
      const ns = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
      let front = false;
      for (const n of ns) {
        if (n < 0 || terrain[n] === Terrain.Water || owner[n] === pid) continue;
        if (owner[n] === 0) neutral.push(n);
        else {
          front = true;
          const list = enemies.get(owner[n]);
          if (list) list.push(n);
          else enemies.set(owner[n], [n]);
        }
      }
      if (front) ownFront.push(i);
    }
    return { neutral, enemies, ownFront };
  }

  /** BFS flood from `start` over 4-connected tiles matching `pred`, up to `max` tiles. */
  grow(start: number, pred: (t: number) => boolean, max: number): number[] {
    const seen = new Set<number>([start]);
    const queue = [start];
    for (let qi = 0; qi < queue.length && queue.length < max; qi++) {
      const t = queue[qi];
      const x = t % this.w, y = (t / this.w) | 0;
      const ns = [x > 0 ? t - 1 : -1, x < this.w - 1 ? t + 1 : -1, y > 0 ? t - this.w : -1, y < this.h - 1 ? t + this.w : -1];
      for (const n of ns) {
        if (n < 0 || seen.has(n) || this.terrain[n] === Terrain.Water || !pred(n)) continue;
        seen.add(n);
        queue.push(n);
        if (queue.length >= max) break;
      }
    }
    return queue;
  }
}
