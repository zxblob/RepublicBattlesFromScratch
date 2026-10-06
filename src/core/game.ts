import { CFG, MISSILES, MissileKind, StructType, TECH, TechId } from "./config";
import { rasterizePolygon } from "./geometry";
import { generateMap, Terrain } from "./mapgen";
import { mulberry32, Rng } from "./rng";
import { botThink } from "./bots";
import { rle, unrle } from "./protocol";

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
  team: number; // 0 = none
  allies: number[];
  embargo: number[];
  nextMilitary?: number;
  rp: number;
  tech: string[];
  skin?: string;
  nextBoat?: number;
  /** bounding box of owned tiles [x0,y0,x1,y1] (only grows); speeds up border scans on big maps */
  bb?: [number, number, number, number];
}

export type GameMode = "ffa" | "team" | "ww" | "wow";
export type Phase = "play" | "expand" | "cold" | "war" | "space";

export interface GameOptions {
  mode?: GameMode;
  teams?: number;
  terrain?: Uint8Array;
  islands?: boolean;
  /** planets: set by the War of the Worlds transition */
  planet?: string;
  /** dominance countdown victory (default on) */
  dominance?: boolean;
}

export interface Structure {
  id: number;
  type: StructType;
  owner: number;
  tile: number;
  x: number;
  y: number;
  /** silo cooldown ticks */
  cd?: number;
}

export type UnitKind = "t" | "f" | "b" | "x" | "w" | "r"; // tank, fighter, bomber, transport, warship, trade ship

export interface Unit {
  id: number;
  kind: UnitKind;
  owner: number;
  ammo: number;
  cd: number;
  /** troops carried by a transport */
  cargo: number;
  /** trade ship: destination structure id, and the owner's origin port id */
  dest?: number;
  from?: number;
  x: number;
  y: number;
  hp: number;
  /** remaining waypoints in tile coordinates */
  path: [number, number][];
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

export interface Train {
  id: number;
  key: string;
  /** owners of the two stations (equal for a private line) */
  a: number;
  b: number;
  pts: [number, number][];
  cum: number[];
  /** distance travelled along the line, and direction (1 = towards b) */
  d: number;
  dir: 1 | -1;
}

export interface Missile {
  id: number;
  owner: number;
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  total: number;
  left: number;
  kind: MissileKind;
  radius: number;
  share: number;
}

export type GameEvent =
  | { k: "attack"; id: number; by: number; on: number }
  | { k: "attackEnd"; id: number; by: number }
  | { k: "elim"; id: number; by: number }
  | { k: "win"; id: number }
  | { k: "text"; text: string };

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

export interface GameSnapshot {
  v: number;
  seed: number; w: number; h: number; mode: GameMode; teams: number; planet: string;
  terrain: number[]; owner: number[]; wall: number[]; rail?: number[];
  dominance?: boolean; domLeader?: number; domTicks?: number;
  players: Player[]; structures: Structure[];
  attacks: (Omit<Attack, "tiles"> & { tiles: number[] })[];
  units: Unit[]; missiles: Missile[];
  tickNo: number; spawnTicks: number; phase: Phase; phaseTicks: number; hold: number;
  over: boolean; winner: number; winnerTeam: number;
  allyReq: [number, number[]][];
  rng: number;
  ids: [number, number, number, number];
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
  readonly units: Unit[] = [];
  /** wall hit points per tile; 0 = no wall. Walls cannot be conquered until broken. */
  readonly wall: Uint8Array;
  readonly missiles: Missile[] = [];
  readonly rng: Rng;
  readonly landTiles: number;
  readonly mode: GameMode;
  teams: number;
  readonly planet: string;
  readonly dominance: boolean;
  /** trains shuttling between the buildings a rail network links; every arrival pays gold */
  trains: Train[] = [];
  /** gold earned from trains so far, per player (statistics) */
  railEarned = new Map<number, number>();
  private nextTrainId = 1;
  railDirty: number[] = [];
  private railStale = true;
  domLeader = 0;
  domTicks = 0;
  readonly rail: Uint8Array;
  readonly research: boolean;
  /** pending alliance proposals: target -> proposers */
  allyReq = new Map<number, number[]>();
  phase: Phase = "play";
  phaseTicks = 0;
  private hold = 0;
  /** bots think every N ticks; larger maps think less often to keep the server fast */
  readonly thinkEvery: number;
  winnerTeam = 0;

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
  skinDirty: number[] = [];
  wallDirty: number[] = [];
  events: GameEvent[] = [];

  nextAttackId = 1;
  nextStructId = 1;
  nextUnitId = 1;
  nextMissileId = 1;

  constructor(seed: number, w = 192, h = 112, opts: GameOptions = {}) {
    this.seed = seed;
    this.w = w;
    this.h = h;
    this.mode = opts.mode ?? "ffa";
    this.teams = this.mode === "team" ? Math.max(2, Math.min(6, opts.teams ?? 2)) : 0;
    this.planet = opts.planet ?? "";
    this.dominance = opts.dominance !== false;
    this.research = this.mode === "ww" || this.mode === "wow";
    this.thinkEvery = w * h > 400_000 ? 30 : w * h > 150_000 ? 20 : 10;
    this.phase = this.planet ? "war" : this.research ? "expand" : "play";
    this.rng = mulberry32(seed ^ 0xabcdef);
    this.terrain = opts.terrain ?? generateMap(seed, w, h, opts.islands ? 0.4 : this.planet === "volcanic" ? 0.55 : 0.5, !!opts.islands);
    this.owner = new Uint16Array(w * h);
    this.wall = new Uint8Array(w * h);
    this.rail = new Uint8Array(w * h);
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
      team: 0,
      allies: [],
      embargo: [],
      rp: 0,
      tech: [],
    };
    if (this.teams) {
      p.team = ((id - 1) % this.teams) + 1;
      const idx = Math.floor((id - 1) / this.teams);
      p.color = hslToRgb(((p.team - 1) * 360) / this.teams + 10, 0.72, Math.min(0.7, 0.38 + idx * 0.07));
    }
    this.players.push(p);
    return p;
  }

  /**
   * Co-op: every human player joins one team (team 1), so they cannot attack each other and cannot split up.
   * Bots stay opponents (in team mode they fill the other teams).
   */
  setCoop(): void {
    const humans = this.players.slice(1).filter((p) => !p.isBot);
    const bots = this.players.slice(1).filter((p) => p.isBot);
    if (!humans.length) return;
    humans.forEach((p, i) => {
      p.team = 1;
      p.allies = [];
      p.color = hslToRgb(205 + (i % 3) * 8, 0.75, Math.min(0.72, 0.42 + Math.floor(i / 3) * 0.1 + (i % 3) * 0.04));
    });
    if (this.teams >= 2) {
      bots.forEach((b, i) => {
        b.team = 2 + (i % (this.teams - 1));
        b.color = hslToRgb(((b.team - 1) * 360) / this.teams + 10, 0.72, Math.min(0.7, 0.38 + Math.floor(i / (this.teams - 1)) * 0.07));
      });
    } else for (const b of bots) b.team = 0;
    this.railStale = true;
  }

  // ---- diplomacy ------------------------------------------------------------------------------

  friendly(a: number, b: number): boolean {
    if (a === b) return true;
    const pa = this.players[a], pb = this.players[b];
    if (!pa || !pb) return false;
    return (pa.team !== 0 && pa.team === pb.team) || pa.allies.includes(b);
  }

  proposeAlliance(a: number, b: number): Result<{ formed: boolean }> {
    const pa = this.players[a], pb = this.players[b];
    if (!pa || !pb || a === b || !pa.alive || !pb.alive) return { ok: false, error: "no such nation" };
    if (this.mode === "team") return { ok: false, error: "teams are fixed in team mode" };
    if (this.friendly(a, b)) return { ok: false, error: "already allied" };
    const mine = this.allyReq.get(a) ?? [];
    if (mine.includes(b)) {
      this.allyReq.set(a, mine.filter((x) => x !== b));
      pa.allies.push(b);
      pb.allies.push(a);
      this.railStale = true;
      this.events.push({ k: "text", text: `${pa.name} and ${pb.name} are now allies` });
      return { ok: true, data: { formed: true } };
    }
    if (pb.isBot) {
      if (pb.aggression < 1.0 || this.rng() < 0.25) {
        pa.allies.push(b);
        pb.allies.push(a);
        this.railStale = true;
        this.events.push({ k: "text", text: `${pa.name} and ${pb.name} are now allies` });
        return { ok: true, data: { formed: true } };
      }
      return { ok: false, error: `${pb.name} declined` };
    }
    const reqs = this.allyReq.get(b) ?? [];
    if (!reqs.includes(a)) reqs.push(a);
    this.allyReq.set(b, reqs);
    this.events.push({ k: "text", text: `${pa.name} proposes an alliance to ${pb.name}` });
    return { ok: true, data: { formed: false } };
  }

  breakAlliance(a: number, b: number): Result {
    const pa = this.players[a], pb = this.players[b];
    if (!pa || !pb) return { ok: false, error: "no such nation" };
    if (!pa.allies.includes(b)) return { ok: false, error: "not allied" };
    pa.allies = pa.allies.filter((x) => x !== b);
    pb.allies = pb.allies.filter((x) => x !== a);
    this.railStale = true;
    this.events.push({ k: "text", text: `${pa.name} broke the alliance with ${pb.name}` });
    return { ok: true };
  }

  // ---- research -------------------------------------------------------------------------------

  has(p: Player, id: TechId): boolean {
    return p.tech.includes(id);
  }

  doResearch(pid: number, id: string): Result {
    const p = this.players[pid];
    if (!p || !p.alive) return { ok: false, error: "not in game" };
    if (!this.research) return { ok: false, error: "research is only in World War modes" };
    const t = (TECH as Record<string, { cost: number; req: string }>)[id];
    if (!t) return { ok: false, error: "unknown technology" };
    if (this.phase === "expand") return { ok: false, error: "research opens in the Cold War" };
    if (p.tech.includes(id)) return { ok: false, error: "already researched" };
    if (id.startsWith("space") && this.mode !== "wow") return { ok: false, error: "needs War of the Worlds" };
    if (t.req && !p.tech.includes(t.req)) return { ok: false, error: "needs " + (TECH as Record<string, { label: string }>)[t.req].label };
    if (p.rp < t.cost) return { ok: false, error: "not enough research points" };
    p.rp -= t.cost;
    p.tech.push(id);
    return { ok: true };
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

  ownedCount(pid: number, type: StructType): number {
    let n = 0;
    for (const s of this.structures) if (s.owner === pid && s.type === type) n++;
    return n;
  }

  maxTroops(p: Player): number {
    let mult = 1;
    if (p.tech.length) mult += (this.has(p, "mil1") ? 0.2 : 0) + (this.has(p, "econ3") ? 0.25 : 0);
    return (CFG.baseCap + p.tiles * CFG.capPerTile + this.ownedCount(p.id, "city") * CFG.cityCap) * mult;
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
    if (id) {
      const pl = this.players[id];
      pl.tiles++;
      const x = tile % this.w, y = (tile / this.w) | 0;
      if (!pl.bb) pl.bb = [x, y, x, y];
      else {
        if (x < pl.bb[0]) pl.bb[0] = x;
        if (y < pl.bb[1]) pl.bb[1] = y;
        if (x > pl.bb[2]) pl.bb[2] = x;
        if (y > pl.bb[3]) pl.bb[3] = y;
      }
    }
    this.owner[tile] = id;
    this.dirty.push(tile);
    const s = this.structAt.get(tile);
    if (s) this.removeStructure(s);
    if (this.rail[tile]) { this.rail[tile] = 0; this.railDirty.push(tile); this.railStale = true; }
  }

  private removeStructure(s: Structure): void {
    this.railStale = true;
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
      if (d.tech.length && this.has(d, "def1")) cost *= 1.15;
      if (this.planet && this.has(d, "space3")) cost *= 1.3;
      if (d.capital >= 0) {
        const dx = (d.capital % this.w) - tx, dy = ((d.capital / this.w) | 0) - ty;
        if (dx * dx + dy * dy <= CFG.capitalRadius * CFG.capitalRadius) cost *= CFG.capitalMult;
      }
      if (this.inRange(o, "bunker", tx, ty)) cost *= this.has(d, "def2") ? 2.2 : CFG.structures.bunker.mult;
    }
    if (this.inRange(attacker, "barracks", tx, ty)) cost *= CFG.structures.barracks.mult;
    const ap = this.players[attacker];
    if (ap.tech.length) {
      if (this.has(ap, "mil2")) cost *= 0.9;
      if (this.planet && this.has(ap, "space2")) cost *= 0.8;
    }
    for (const k of this.units) {
      if (k.owner !== attacker || k.kind !== "t") continue;
      const dx = k.x - tx, dy = k.y - ty;
      if (dx * dx + dy * dy <= CFG.tankRange * CFG.tankRange) { cost *= CFG.tankMult; break; }
    }
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

  launchAttackTiles(pid: number, rawTiles: number[], ratio: number, poolOverride?: number): Result<{ id: number }> {
    const p = this.players[pid];
    if (!p || !p.alive || this.over) return { ok: false, error: "not in game" };
    if (this.spawnTicks > 0) return { ok: false, error: "choose your start first" };
    if (!Number.isFinite(ratio)) return { ok: false, error: "bad ratio" };
    ratio = Math.max(0.02, Math.min(1, ratio));
    if (poolOverride === undefined && this.attacksOf(pid).length >= CFG.maxAttacksPerPlayer) return { ok: false, error: "too many attacks" };
    const tiles = new Set<number>();
    for (const t of rawTiles) if (this.terrain[t] !== Terrain.Water && !this.friendly(pid, this.owner[t])) tiles.add(t);
    if (tiles.size === 0) return { ok: false, error: "nothing to attack" };
    if (tiles.size > CFG.maxRegionTiles) return { ok: false, error: "area too large" };
    let touches = false;
    for (const t of tiles) if (this.touches(t, pid)) { touches = true; break; }
    if (!touches) return { ok: false, error: "area must touch your territory" };
    const pool = poolOverride ?? p.troops * ratio;
    if (pool < 5) return { ok: false, error: "not enough troops" };
    if (poolOverride === undefined) p.troops -= pool;
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
      if (this.friendly(a.by, this.owner[t])) { a.tiles.delete(t); continue; }
      sx += t % this.w;
      sy += (t / this.w) | 0;
      if (!this.wall[t] && this.touches(t, a.by)) frontier.push(t);
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
    for (let i = this.units.length - 1; i >= 0; i--) if (this.units[i].owner === p.id) this.units.splice(i, 1);
    for (let i = 0; i < this.wall.length; i++) if (this.wall[i] && this.owner[i] === 0) { this.wall[i] = 0; this.wallDirty.push(i); }
    this.events.push({ k: "elim", id: p.id, by });
  }

  isCoastal(tile: number): boolean {
    const x = tile % this.w, y = (tile / this.w) | 0;
    return (
      (x > 0 && this.terrain[tile - 1] === Terrain.Water) ||
      (x < this.w - 1 && this.terrain[tile + 1] === Terrain.Water) ||
      (y > 0 && this.terrain[tile - this.w] === Terrain.Water) ||
      (y < this.h - 1 && this.terrain[tile + this.w] === Terrain.Water)
    );
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
    if (this.wall[tile]) return { ok: false, error: "tile occupied" };
    if (type === "port" && !this.isCoastal(tile)) return { ok: false, error: "ports go on the coast" };
    if (type === "lab" && !this.research) return { ok: false, error: "labs are for World War modes" };
    if (type === "spaceport" && !(this.phase === "space" && this.has(p, "space1"))) {
      return { ok: false, error: "spaceports need the Space phase and Rocketry" };
    }
    const cost = this.structureCost(pid, type);
    if (p.gold < cost) return { ok: false, error: "not enough gold" };
    p.gold -= cost;
    const s: Structure = { id: this.nextStructId++, type, owner: pid, tile, x, y };
    this.structures.push(s);
    this.structAt.set(tile, s);
    this.structDirty = true;
    this.railStale = true;
    return { ok: true, data: { id: s.id } };
  }

  // ---- walls and tanks ------------------------------------------------------------------------

  /** Draw a wall along a polyline (tile coordinates). Charges per new tile; stops when gold runs out. */
  buildWall(pid: number, pts: ArrayLike<number>): Result<{ placed: number }> {
    const p = this.players[pid];
    if (!p || !p.alive || this.over) return { ok: false, error: "not in game" };
    if (this.spawnTicks > 0) return { ok: false, error: "choose your start first" };
    if (pts.length < 4 || pts.length > CFG.maxPolyPoints * 2) return { ok: false, error: "bad shape" };
    for (let i = 0; i < pts.length; i++) if (!Number.isFinite(pts[i])) return { ok: false, error: "bad shape" };
    const seen = new Set<number>();
    const tiles: number[] = [];
    const add = (x: number, y: number) => {
      if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
      const t = y * this.w + x;
      if (!seen.has(t)) { seen.add(t); tiles.push(t); }
    };
    for (let i = 0; i + 3 < pts.length; i += 2) {
      let x0 = Math.floor(pts[i]), y0 = Math.floor(pts[i + 1]);
      const x1 = Math.floor(pts[i + 2]), y1 = Math.floor(pts[i + 3]);
      const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
      let err = dx + dy;
      for (let guard = 0; guard < 1000; guard++) {
        add(x0, y0);
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
      }
    }
    let placed = 0;
    for (const t of tiles) {
      if (placed >= CFG.maxWallTilesPerDraw) break;
      if (this.owner[t] !== pid || this.terrain[t] !== Terrain.Land || this.structAt.has(t) || this.wall[t]) continue;
      if (p.gold < CFG.wallTileCost) break;
      p.gold -= CFG.wallTileCost;
      this.wall[t] = CFG.wallHp;
      this.wallDirty.push(t);
      placed++;
    }
    if (!placed) return { ok: false, error: p.gold < CFG.wallTileCost ? "not enough gold" : "walls go on your own flat land" };
    return { ok: true, data: { placed } };
  }

  trainUnit(pid: number, kind: UnitKind): Result<{ id: number }> {
    const p = this.players[pid];
    if (!p || !p.alive || this.over) return { ok: false, error: "not in game" };
    if (this.spawnTicks > 0) return { ok: false, error: "choose your start first" };
    if (!["t", "f", "b", "x", "w"].includes(kind)) return { ok: false, error: "unknown unit" };
    const building = kind === "t" ? "tankfactory" : kind === "x" || kind === "w" ? "port" : "airbase";
    const bases = this.structures.filter((s) => s.owner === pid && s.type === building);
    if (!bases.length) {
      return { ok: false, error: kind === "t" ? "build a Tank Factory first" : building === "port" ? "build a Port first" : "build an Airbase first" };
    }
    const mine = this.units.filter((k) => k.owner === pid && k.kind === kind).length;
    const per = kind === "t" ? CFG.tanksPerFactory : kind === "x" || kind === "w" ? CFG.boatsPerPort : CFG.planesPerBase;
    if (mine >= bases.length * per) return { ok: false, error: "unit limit reached" };
    const cost = { t: CFG.tankCost, f: CFG.fighterCost, b: CFG.bomberCost, x: CFG.transportCost, w: CFG.warshipCost, r: 0 }[kind];
    if (p.gold < cost) return { ok: false, error: "not enough gold" };
    const b = bases[mine % bases.length];
    let sx = b.x + 0.5, sy = b.y + 0.5;
    if (kind === "x" || kind === "w") {
      let found = false;
      for (let dy = -1; dy <= 1 && !found; dy++) {
        for (let dx = -1; dx <= 1 && !found; dx++) {
          const nx = b.x + dx, ny = b.y + dy;
          if (nx < 0 || ny < 0 || nx >= this.w || ny >= this.h) continue;
          if (this.terrain[ny * this.w + nx] === Terrain.Water) { sx = nx + 0.5; sy = ny + 0.5; found = true; }
        }
      }
      if (!found) return { ok: false, error: "no open water next to the port" };
    }
    p.gold -= cost;
    const hp = { t: CFG.tankHp, f: CFG.fighterHp, b: CFG.bomberHp, x: CFG.transportHp, w: CFG.warshipHp, r: CFG.tradeHp }[kind];
    const k: Unit = {
      id: this.nextUnitId++, kind, owner: pid, x: sx, y: sy, path: [], hp,
      ammo: kind === "b" ? CFG.bomberAmmo : 0, cd: 0, cargo: 0,
    };
    this.units.push(k);
    return { ok: true, data: { id: k.id } };
  }

  /** Move a unit along waypoints. Boats given a single destination get a water route; transports may load troops. */
  moveUnit(pid: number, id: number, pts: ArrayLike<number>, ratio = 0): Result {
    const k = this.units.find((x) => x.id === id && x.owner === pid);
    if (!k) return { ok: false, error: "unit not found" };
    const n = Math.min((pts.length / 2) | 0, CFG.maxTankPathPoints);
    let path: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const x = pts[i * 2], y = pts[i * 2 + 1];
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { ok: false, error: "bad path" };
      path.push([Math.max(0, Math.min(this.w - 0.01, x)), Math.max(0, Math.min(this.h - 0.01, y))]);
    }
    if (k.kind === "r") return { ok: false, error: "trade ships sail on their own" };
    if ((k.kind === "x" || k.kind === "w") && path.length) {
      const dest = path[path.length - 1];
      const route = this.waterRoute(k.x, k.y, dest[0], dest[1]);
      if (!route) return { ok: false, error: "no sea route there" };
      path = route;
    }
    if (k.kind === "x" && k.cargo === 0 && ratio > 0) {
      const p = this.players[pid];
      const load = p.troops * Math.max(0.05, Math.min(1, ratio));
      if (load < 5) return { ok: false, error: "not enough troops to load" };
      p.troops -= load;
      k.cargo = load;
    }
    k.path = path;
    return { ok: true };
  }

  /** BFS over water; returns decimated waypoints, or null. Destination may be on land next to water (nearest water used). */
  waterRoute(x0: number, y0: number, x1: number, y1: number): [number, number][] | null {
    const { w, h, terrain } = this;
    const start = Math.floor(y0) * w + Math.floor(x0);
    let goal = Math.floor(y1) * w + Math.floor(x1);
    if (terrain[goal] !== Terrain.Water) {
      // nearest water tile within 4 tiles of the target
      let best = -1, bd = 1e9;
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const nx = Math.floor(x1) + dx, ny = Math.floor(y1) + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h || terrain[ny * w + nx] !== Terrain.Water) continue;
        const d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = ny * w + nx; }
      }
      if (best < 0) return null;
      goal = best;
    }
    if (terrain[start] !== Terrain.Water) return null;
    const prev = new Map<number, number>([[start, -1]]);
    const queue = [start];
    let found = start === goal;
    for (let qi = 0; qi < queue.length && !found && queue.length < 400000; qi++) {
      const t = queue[qi];
      const x = t % w, y = (t / w) | 0;
      for (const n of [x > 0 ? t - 1 : -1, x < w - 1 ? t + 1 : -1, y > 0 ? t - w : -1, y < h - 1 ? t + w : -1]) {
        if (n < 0 || prev.has(n) || terrain[n] !== Terrain.Water) continue;
        prev.set(n, t);
        if (n === goal) { found = true; break; }
        queue.push(n);
      }
    }
    if (!found) return null;
    const tiles: number[] = [];
    for (let t = goal; t !== -1; t = prev.get(t)!) tiles.push(t);
    tiles.reverse();
    // keep every 4th tile plus the end
    const out: [number, number][] = [];
    for (let i = 3; i < tiles.length; i += 4) out.push([(tiles[i] % w) + 0.5, ((tiles[i] / w) | 0) + 0.5]);
    out.push([(goal % w) + 0.5, ((goal / w) | 0) + 0.5]);
    return out.slice(0, 200);
  }

  /** exposed for tests */
  stepUnitsForTest(): void { this.stepUnits(); }

  private stepUnits(): void {
    for (let i = this.units.length - 1; i >= 0; i--) {
      const k = this.units[i];
      const air = k.kind === "f" || k.kind === "b";
      const speed = { t: CFG.tankSpeed, f: CFG.fighterSpeed, b: CFG.bomberSpeed, x: CFG.transportSpeed, w: CFG.warshipSpeed, r: CFG.tradeSpeed }[k.kind];
      const target = k.path[0];
      let arrived = false;
      if (target) {
        const dx = target[0] - k.x, dy = target[1] - k.y;
        const dist = Math.hypot(dx, dy);
        const nx = dist <= speed ? target[0] : k.x + (dx / dist) * speed;
        const ny = dist <= speed ? target[1] : k.y + (dy / dist) * speed;
        const t = this.terrain[Math.floor(ny) * this.w + Math.floor(nx)];
        const naval = k.kind === "x" || k.kind === "w" || k.kind === "r";
        if ((!air && !naval && (t === Terrain.Water || t === Terrain.Mountain)) || (naval && t !== Terrain.Water)) k.path = [];
        else {
          k.x = nx;
          k.y = ny;
          if (dist <= speed) { k.path.shift(); if (!k.path.length) arrived = true; }
        }
      }
      const tx = Math.floor(k.x), ty = Math.floor(k.y);
      if (k.kind === "t") this.tankActions(k, tx, ty, i);
      else if (k.kind === "b") this.bomberActions(k, tx, ty);
      else if (k.kind === "x" && arrived && k.cargo > 0) this.land(k);
      else if (k.kind === "r" && (arrived || !k.path.length)) this.tradeArrive(k);
    }
    // combat: SAMs, fighters, warships
    for (const k of this.units) {
      if (k.kind === "f" || k.kind === "b") {
        for (const s of this.structures) {
          if (s.type !== "sam" || this.friendly(s.owner, k.owner)) continue;
          const r = CFG.structures.sam.range;
          if ((s.x + 0.5 - k.x) ** 2 + (s.y + 0.5 - k.y) ** 2 <= r * r) {
            const so = this.players[s.owner];
            k.hp -= CFG.samDmg * (so.tech.length && this.has(so, "def3") ? 1.6 : 1);
          }
        }
      }
      if (k.kind === "f") {
        for (const q of this.units) {
          if (q.kind === "t" || this.friendly(q.owner, k.owner)) continue;
          if ((q.x - k.x) ** 2 + (q.y - k.y) ** 2 <= CFG.fighterRange ** 2) q.hp -= CFG.fighterDmg;
        }
      }
      if (k.kind === "w") {
        for (const q of this.units) {
          if ((q.kind !== "x" && q.kind !== "w" && q.kind !== "r") || this.friendly(q.owner, k.owner)) continue;
          if ((q.x - k.x) ** 2 + (q.y - k.y) ** 2 <= CFG.warshipRange ** 2) q.hp -= CFG.warshipDmg;
        }
      }
    }
    for (let i = this.units.length - 1; i >= 0; i--) if (this.units[i].hp <= 0) this.units.splice(i, 1);
  }

  /** A transport reached its destination: take a beachhead and push inland with the cargo. */
  private land(k: Unit): void {
    const cx = Math.floor(k.x), cy = Math.floor(k.y);
    const R = CFG.landingRadius;
    let best = -1, bd = 1e9;
    for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= this.w || ny >= this.h) continue;
      const t = ny * this.w + nx;
      if (this.terrain[t] === Terrain.Water || this.wall[t]) continue;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = t; }
    }
    if (best < 0) return; // nothing to land on; stay and wait for new orders
    const p = this.players[k.owner];
    const idx = this.units.indexOf(k);
    if (idx >= 0) this.units.splice(idx, 1);
    let pool = k.cargo;
    k.cargo = 0;
    const o = this.owner[best];
    if (this.friendly(k.owner, o)) { p.troops += pool; return; }
    const cost = this.tileCost(k.owner, best);
    if (pool < cost) { p.troops += pool; this.events.push({ k: "text", text: `${p.name}'s landing failed` }); return; }
    pool -= cost;
    if (o) {
      const d = this.players[o];
      d.troops -= Math.min(d.troops, (d.troops / Math.max(d.tiles, 1)) * CFG.defenderLossShare);
    }
    this.setOwner(best, k.owner);
    if (o && this.players[o].tiles === 0) this.eliminate(this.players[o], k.owner);
    const region = this.grow(best, (t) => !this.friendly(k.owner, this.owner[t]), 160);
    if (pool < 5 || !this.launchAttackTiles(k.owner, region, 1, pool).ok) p.troops += pool;
  }

  private tankActions(k: Unit, tx: number, ty: number, idx: number): void {
    // break the nearest enemy wall tile next to us
    let bestWall = -1, bestD = 1e9;
    for (let yy = ty - 1; yy <= ty + 1; yy++) {
      for (let xx = tx - 1; xx <= tx + 1; xx++) {
        if (xx < 0 || yy < 0 || xx >= this.w || yy >= this.h) continue;
        const t = yy * this.w + xx;
        if (!this.wall[t] || this.owner[t] === k.owner) continue;
        const d = (xx + 0.5 - k.x) ** 2 + (yy + 0.5 - k.y) ** 2;
        if (d < bestD) { bestD = d; bestWall = t; }
      }
    }
    if (bestWall >= 0) {
      this.wall[bestWall] = Math.max(0, this.wall[bestWall] - CFG.tankWallDmg);
      this.wallDirty.push(bestWall);
    }
    const o = this.owner[ty * this.w + tx];
    if (o !== 0 && o !== k.owner) k.hp -= CFG.tankOverrunDmg;
    void idx;
  }

  private bomberActions(k: Unit, tx: number, ty: number): void {
    if (k.cd > 0) k.cd--;
    // rearm at an own airbase
    if (k.ammo < CFG.bomberAmmo) {
      for (const s of this.structures) {
        if (s.owner === k.owner && s.type === "airbase" && (s.x + 0.5 - k.x) ** 2 + (s.y + 0.5 - k.y) ** 2 <= 1.5 * 1.5) {
          k.ammo = CFG.bomberAmmo;
          break;
        }
      }
    }
    const o = this.owner[ty * this.w + tx];
    if (o === 0 || o === k.owner || k.ammo <= 0 || k.cd > 0) return;
    k.ammo--;
    k.cd = CFG.bombCooldown;
    const r = CFG.bombRadius;
    for (const s of [...this.structures]) {
      if (s.owner === k.owner) continue;
      if ((s.x + 0.5 - k.x) ** 2 + (s.y + 0.5 - k.y) ** 2 <= r * r) this.removeStructure(s);
    }
    for (let yy = ty - r; yy <= ty + r; yy++) {
      for (let xx = tx - r; xx <= tx + r; xx++) {
        if (xx < 0 || yy < 0 || xx >= this.w || yy >= this.h) continue;
        const t = yy * this.w + xx;
        if (this.wall[t] && this.owner[t] !== k.owner && (xx + 0.5 - k.x) ** 2 + (yy + 0.5 - k.y) ** 2 <= r * r) {
          this.wall[t] = 0;
          this.wallDirty.push(t);
        }
      }
    }
    const d = this.players[o];
    d.troops -= d.troops * CFG.bombTroopShare;
    if (k.ammo === 0) {
      // fly home to rearm
      let best: Structure | null = null, bd = 1e9;
      for (const s of this.structures) {
        if (s.owner !== k.owner || s.type !== "airbase") continue;
        const dd = (s.x - k.x) ** 2 + (s.y - k.y) ** 2;
        if (dd < bd) { bd = dd; best = s; }
      }
      if (best) k.path = [[best.x + 0.5, best.y + 0.5]];
    }
  }

  // ---- trade, rails, diplomacy extras --------------------------------------------------------

  setEmbargo(pid: number, target: number, on: boolean): Result {
    const p = this.players[pid], t = this.players[target];
    if (!p || !t || pid === target) return { ok: false, error: "no such nation" };
    const has = p.embargo.includes(target);
    if (on && !has) {
      p.embargo.push(target);
      this.events.push({ k: "text", text: `${p.name} embargoed ${t.name}` });
    } else if (!on && has) p.embargo = p.embargo.filter((x) => x !== target);
    return { ok: true };
  }

  /** Give a quarter of your troops or gold to an ally or teammate. */
  donate(pid: number, to: number, what: "troops" | "gold"): Result {
    const p = this.players[pid], t = this.players[to];
    if (!p || !t || !p.alive || !t.alive || pid === to) return { ok: false, error: "no such nation" };
    if (!this.friendly(pid, to)) return { ok: false, error: "you can only donate to allies" };
    if (what === "troops") {
      const room = Math.max(0, this.maxTroops(t) - t.troops);
      const amt = Math.min(p.troops * 0.25, room);
      if (amt < 3) return { ok: false, error: "nothing to give" };
      p.troops -= amt;
      t.troops += amt;
    } else {
      const amt = p.gold * 0.25;
      if (amt < 3) return { ok: false, error: "nothing to give" };
      p.gold -= amt;
      t.gold += amt;
    }
    this.events.push({ k: "text", text: `${p.name} donated ${what} to ${t.name}` });
    return { ok: true };
  }

  /** Ports periodically send trade ships to ports of other nations (unless embargoed). */
  private stepTrade(): void {
    for (const port of this.structures) {
      if (port.type !== "port" || (this.tickNo + port.id * 37) % CFG.tradeEvery !== 0) continue;
      if (this.units.filter((u) => u.kind === "r" && u.owner === port.owner).length >= CFG.maxTradeShips) continue;
      const me = this.players[port.owner];
      let best: Structure | null = null, bd = 1e9;
      for (const o of this.structures) {
        if (o.type !== "port" || o.owner === port.owner) continue;
        const op = this.players[o.owner];
        if (me.embargo.includes(o.owner) || op.embargo.includes(port.owner)) continue;
        const d = (o.x - port.x) ** 2 + (o.y - port.y) ** 2;
        if (d < bd && d < 220 * 220 && this.rng() < 0.7) { bd = d; best = o; }
      }
      if (!best) continue;
      const start = this.adjacentWater(port);
      const end = this.adjacentWater(best);
      if (!start || !end) continue;
      const route = this.waterRoute(start[0], start[1], end[0], end[1]);
      if (!route) continue;
      this.units.push({
        id: this.nextUnitId++, kind: "r", owner: port.owner, x: start[0], y: start[1], path: route, hp: CFG.tradeHp,
        ammo: 0, cd: 0, cargo: 0, dest: best.id, from: port.id,
      });
    }
  }

  private adjacentWater(s: Structure): [number, number] | null {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = s.x + dx, ny = s.y + dy;
        if (nx < 0 || ny < 0 || nx >= this.w || ny >= this.h) continue;
        if (this.terrain[ny * this.w + nx] === Terrain.Water) return [nx + 0.5, ny + 0.5];
      }
    }
    return null;
  }

  private tradeArrive(k: Unit): void {
    const i = this.units.indexOf(k);
    if (i >= 0) this.units.splice(i, 1);
    const dest = this.structures.find((s) => s.id === k.dest);
    const from = this.structures.find((s) => s.id === k.from);
    if (!dest || !from) return;
    const gold = CFG.tradeBase + Math.hypot(dest.x - from.x, dest.y - from.y) * CFG.tradePerTile;
    this.players[k.owner].gold += gold;
    this.players[dest.owner].gold += gold * 0.5;
  }

  /** Draw a rail line along a polyline (like walls, but for income): connect Cities, Factories and Ports. */
  buildRail(pid: number, pts: ArrayLike<number>): Result<{ placed: number }> {
    const p = this.players[pid];
    if (!p || !p.alive || this.over) return { ok: false, error: "not in game" };
    if (this.spawnTicks > 0) return { ok: false, error: "choose your start first" };
    if (pts.length < 4 || pts.length > CFG.maxPolyPoints * 2) return { ok: false, error: "bad shape" };
    for (let i = 0; i < pts.length; i++) if (!Number.isFinite(pts[i])) return { ok: false, error: "bad shape" };
    const tiles = this.lineTiles(this.snapToBuildings(pid, pts));
    let placed = 0;
    for (const t of tiles) {
      if (placed >= CFG.maxRailTilesPerDraw) break;
      const o = this.owner[t];
      if (o === 0 || !this.friendly(pid, o) || this.terrain[t] !== Terrain.Land || this.rail[t] || this.wall[t]) continue;
      if (p.gold < CFG.railTileCost) break;
      p.gold -= CFG.railTileCost;
      this.rail[t] = 1;
      this.railDirty.push(t);
      placed++;
    }
    if (!placed) return { ok: false, error: p.gold < CFG.railTileCost ? "not enough gold" : "rails go on your own or allied flat land" };
    this.railStale = true;
    return { ok: true, data: { placed } };
  }

  /** If a line starts or ends within 3 tiles of a City, Factory or Port (yours or an ally's), extend it onto that building. */
  private snapToBuildings(pid: number, pts: ArrayLike<number>): number[] {
    const out = Array.from(pts);
    const snap = (ix: number): void => {
      const x = out[ix], y = out[ix + 1];
      let best: Structure | null = null, bd = 9.5;
      for (const st of this.structures) {
        if ((st.type !== "city" && st.type !== "factory" && st.type !== "port") || !this.friendly(pid, st.owner)) continue;
        const d = (st.x + 0.5 - x) ** 2 + (st.y + 0.5 - y) ** 2;
        if (d < bd) { bd = d; best = st; }
      }
      if (best) { out[ix] = best.x + 0.5; out[ix + 1] = best.y + 0.5; }
    };
    snap(0);
    snap(out.length - 2);
    return out;
  }

  private lineTiles(pts: ArrayLike<number>): number[] {
    const seen = new Set<number>();
    const tiles: number[] = [];
    const add = (x: number, y: number) => {
      if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
      const t = y * this.w + x;
      if (!seen.has(t)) { seen.add(t); tiles.push(t); }
    };
    for (let i = 0; i + 3 < pts.length; i += 2) {
      let x0 = Math.floor(pts[i]), y0 = Math.floor(pts[i + 1]);
      const x1 = Math.floor(pts[i + 2]), y1 = Math.floor(pts[i + 3]);
      const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
      let err = dx + dy;
      for (let guard = 0; guard < 2000; guard++) {
        add(x0, y0);
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
      }
    }
    return tiles;
  }

  /**
   * Rail networks and trains. A network is a set of rail tiles touching each other (8-neighbourhood) across
   * land of the same side (own land or an ally's). For each pair of neighbouring City / Factory / Port stations
   * on a network (up to maxTrainsPerNetwork) a train shuttles along the shortest track; every arrival pays
   * trainFarePerTile * length (+50% when the stations belong to different nations), shared between the two owners.
   */
  private recomputeRails(): void {
    this.railStale = false;
    const { w, h, rail } = this;
    const seen = new Set<number>();
    const nodes = this.structures.filter((s) => s.type === "city" || s.type === "factory" || s.type === "port");
    const routes: { key: string; a: number; b: number; pts: [number, number][]; cum: number[] }[] = [];
    for (let start = 0; start < rail.length; start++) {
      if (!rail[start] || seen.has(start)) continue;
      const anchor = this.owner[start];
      const stack = [start];
      seen.add(start);
      const net = new Set<number>([start]);
      while (stack.length) {
        const t = stack.pop()!;
        const x = t % w, y = (t / w) | 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const n = ny * w + nx;
            if (rail[n] && !seen.has(n) && this.friendly(anchor, this.owner[n])) { seen.add(n); net.add(n); stack.push(n); }
          }
        }
      }
      const touching = (s: Structure): number[] => {
        const r: number[] = [];
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const nx = s.x + dx, ny = s.y + dy;
          if (nx >= 0 && ny >= 0 && nx < w && ny < h && net.has(ny * w + nx)) r.push(ny * w + nx);
        }
        return r;
      };
      const linked = nodes.filter((s) => this.friendly(anchor, s.owner) && touching(s).length).sort((p, q) => p.x - q.x || p.y - q.y);
      for (let i = 0; i + 1 < linked.length && i < CFG.maxTrainsPerNetwork; i++) {
        const A = linked[i], B = linked[i + 1];
        const goal = new Set(touching(B));
        const prev = new Map<number, number>();
        const q = touching(A);
        for (const t of q) prev.set(t, -1);
        let end = -1;
        for (let qi = 0; qi < q.length && end < 0; qi++) {
          const t = q[qi];
          if (goal.has(t)) { end = t; break; }
          const x = t % w, y = (t / w) | 0;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const n = ny * w + nx;
            if (net.has(n) && !prev.has(n)) { prev.set(n, t); q.push(n); }
          }
        }
        if (end < 0) continue;
        const tiles: number[] = [];
        for (let t = end; t !== -1; t = prev.get(t)!) tiles.push(t);
        tiles.reverse();
        const pts: [number, number][] = [[A.x + 0.5, A.y + 0.5], ...tiles.map((t): [number, number] => [(t % w) + 0.5, Math.floor(t / w) + 0.5]), [B.x + 0.5, B.y + 0.5]];
        const cum = [0];
        for (let k = 1; k < pts.length; k++) cum.push(cum[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
        if (cum[cum.length - 1] < 1.5) continue;
        routes.push({ key: `${A.id}-${B.id}`, a: A.owner, b: B.owner, pts, cum });
      }
    }
    // keep trains whose line did not change so their progress is not reset
    const old = new Map(this.trains.map((t) => [t.key, t]));
    this.trains = routes.map((r, i) => {
      const prevT = old.get(r.key);
      const L = r.cum[r.cum.length - 1];
      if (prevT && Math.abs(prevT.cum[prevT.cum.length - 1] - L) < 1e-6) return { ...prevT, a: r.a, b: r.b, pts: r.pts, cum: r.cum };
      return { id: this.nextTrainId++, key: r.key, a: r.a, b: r.b, pts: r.pts, cum: r.cum, d: ((i * 0.37) % 1) * L, dir: 1 as const };
    });
  }

  private stepTrains(): void {
    for (const t of this.trains) {
      const L = t.cum[t.cum.length - 1];
      t.d += t.dir * CFG.trainSpeed;
      if (t.d >= L || t.d <= 0) {
        t.d = t.d >= L ? L : 0;
        t.dir = t.dir === 1 ? -1 : 1;
        const pa = this.players[t.a], pb = this.players[t.b];
        if (!pa?.alive || !pb?.alive) continue;
        const fare = CFG.trainFarePerTile * L * (t.a !== t.b ? 1.5 : 1);
        const half = t.a !== t.b ? fare / 2 : fare;
        pa.gold += half;
        this.railEarned.set(t.a, (this.railEarned.get(t.a) ?? 0) + half);
        if (t.a !== t.b) { pb.gold += half; this.railEarned.set(t.b, (this.railEarned.get(t.b) ?? 0) + half); }
      }
    }
  }

  /** Current position and heading of a train. */
  trainPose(t: Train): { x: number; y: number; a: number } {
    let i = 1;
    while (i < t.cum.length - 1 && t.cum[i] < t.d) i++;
    const f = (t.d - t.cum[i - 1]) / Math.max(1e-6, t.cum[i] - t.cum[i - 1]);
    const [x0, y0] = t.pts[i - 1], [x1, y1] = t.pts[i];
    let a = Math.atan2(y1 - y0, x1 - x0) + Math.PI / 2;
    if (t.dir === -1) a += Math.PI;
    return { x: x0 + (x1 - x0) * f, y: y0 + (y1 - y0) * f, a };
  }

  // ---- tick -----------------------------------------------------------------------------------

  tick(): void {
    if (this.over) return;
    this.tickNo++;
    if (this.spawnTicks > 0) { this.spawnTicks--; return; }
    for (const a of [...this.attacks]) this.stepAttack(a);
    this.stepUnits();

    this.stepMissiles();
    this.stepTrade();
    if (this.railStale && this.tickNo % 10 === 0) this.recomputeRails();
    this.stepTrains();
    const counts = new Map<number, Record<string, number>>();
    for (const st of this.structures) {
      const c = counts.get(st.owner) ?? {};
      c[st.type] = (c[st.type] ?? 0) + 1;
      counts.set(st.owner, c);
    }
    const researching = this.research && this.phase !== "expand";
    for (let id = 1; id < this.players.length; id++) {
      const p = this.players[id];
      if (!p.alive) continue;
      const c = counts.get(id) ?? {};
      const cap = this.maxTroops(p);
      if (p.troops < cap) {
        let regen = CFG.regenBase + p.tiles * CFG.regenPerTile + CFG.regenGrowth * p.troops * (1 - p.troops / cap);
        if (p.tiles < CFG.lastStandTiles && p.capital >= 0) {
          regen += CFG.lastStandRegen * (1 - p.tiles / CFG.lastStandTiles);
        }
        regen += (c.farm ?? 0) * CFG.farmRegen;
        if (this.has(p, "mil3")) regen *= 1.25;
        if (this.planet === "frozen") regen *= 0.6;
        p.troops = Math.min(cap, p.troops + regen);
      }
      let gold = CFG.goldBase + p.tiles * CFG.goldPerTile + (c.bank ?? 0) * CFG.bankGold * (this.has(p, "econ2") ? 2 : 1);
      gold += (c.port ?? 0) * CFG.portGold + (c.city ?? 0) * CFG.cityGold + (c.factory ?? 0) * CFG.factoryGold;
      if (p.tech.length) gold *= 1 + (this.has(p, "econ1") ? 0.15 : 0) + (this.has(p, "econ2") ? 0.25 : 0);
      if (this.planet === "desert") gold *= 0.6;
      p.gold += gold;
      if (researching) p.rp += p.tiles * CFG.rpPerTile + (c.lab ?? 0) * CFG.labRp;
      if (p.isBot && (this.tickNo + id) % this.thinkEvery === 0) botThink(this, p);
    }
    this.stepPhase();
    this.checkWin();
  }

  /** Group id used for victory: team members win together, allies share a group. */
  private groupOf(id: number): number {
    const p = this.players[id];
    return p.team ? 1000 + p.team : id;
  }

  private checkWin(): void {
    const alive: Player[] = [];
    let humansAlive = 0;
    for (let id = 1; id < this.players.length; id++) {
      const p = this.players[id];
      if (!p.alive) continue;
      alive.push(p);
      if (!p.isBot) humansAlive++;
    }
    if (!alive.length) return this.finish(0);
    // everyone left is on the same side (team or alliance)?
    if (alive.every((x) => alive.every((y) => this.friendly(x.id, y.id)))) {
      const top = alive.reduce((m, x) => (x.tiles > m.tiles ? x : m), alive[0]);
      this.winnerTeam = top.team;
      return this.finish(top.id);
    }
    if (this.phase === "cold") return;
    const byGroup = new Map<number, number>();
    for (const p of alive) byGroup.set(this.groupOf(p.id), (byGroup.get(this.groupOf(p.id)) ?? 0) + p.tiles);
    if (this.dominance && byGroup.size >= 2 && !(this.mode === "wow" && this.phase === "war" && !this.planet)) {
      const sorted = [...byGroup.entries()].sort((a, b) => b[1] - a[1]);
      const [lead, leadTiles] = sorted[0];
      if (leadTiles >= this.landTiles * CFG.domShare && leadTiles >= sorted[1][1] * CFG.domRatio) {
        if (this.domLeader !== lead) {
          this.domLeader = lead;
          this.domTicks = CFG.domTicks;
          const who = alive.filter((x) => this.groupOf(x.id) === lead).reduce((m, x) => (x.tiles > m.tiles ? x : m));
          this.events.push({ k: "text", text: `${who.name}${who.team ? "'s team" : ""} dominates the map: victory in ${Math.round(CFG.domTicks / 600)} min unless challenged` });
        } else if (--this.domTicks <= 0) {
          const top = alive.filter((x) => this.groupOf(x.id) === lead).reduce((m, x) => (x.tiles > m.tiles ? x : m));
          this.winnerTeam = top.team;
          return this.finish(top.id);
        }
      } else if (this.domLeader) {
        this.domLeader = 0;
        this.domTicks = 0;
        this.events.push({ k: "text", text: "The dominance countdown was broken" });
      }
    }
    if (this.tickNo >= CFG.maxTicks) {
      const top = alive.reduce((m, x) => (x.tiles > m.tiles ? x : m), alive[0]);
      this.winnerTeam = top.team;
      return this.finish(top.id);
    }
    const limit = this.mode === "wow" && this.phase === "war" && !this.planet ? 2 : this.planet ? 0.6 : 0.7; // wow: the space race triggers first
    if (limit < 1) {
      for (const [g, tiles] of byGroup) {
        if (tiles >= this.landTiles * limit) {
          const top = alive.filter((x) => this.groupOf(x.id) === g).reduce((m, x) => (x.tiles > m.tiles ? x : m));
          this.winnerTeam = top.team;
          return this.finish(top.id);
        }
      }
    }
    if (humansAlive === 0 && this.players.some((p) => p && !p.isBot)) {
      const top = alive.reduce((m, x) => (x.tiles > m.tiles ? x : m), alive[0]);
      this.finish(top.id);
    }
  }

  private finish(id: number): void {
    this.over = true;
    this.winner = id;
    this.events.push({ k: "win", id });
  }

  /** World War / War of the Worlds phase machine. */
  private stepPhase(): void {
    if (!this.research || this.over) return;
    const alive = this.players.filter((p) => p && p.alive);
    if (this.phase === "expand" && this.tickNo % 10 === 0) {
      const sorted = alive.map((p) => p.tiles).sort((a, b) => b - a);
      let hit = alive.length <= 4;
      for (let n = 3; n <= 6 && !hit; n++) {
        if (alive.length > n && sorted.slice(0, n).reduce((a, b) => a + b, 0) >= this.landTiles * CFG.coldShare) hit = true;
      }
      this.hold = hit ? this.hold + 1 : 0;
      if (this.hold >= CFG.coldHold) {
        this.phase = "cold";
        this.phaseTicks = CFG.coldTicks;
        this.events.push({ k: "text", text: "The great powers stand off. Cold War begins: research now." });
      }
    } else if (this.phase === "cold") {
      if (--this.phaseTicks <= 0) {
        this.phase = "war";
        this.events.push({ k: "text", text: "The Cold War is over. War resumes!" });
      }
    } else if (this.phase === "war" && this.mode === "wow" && !this.planet && this.tickNo % 10 === 0) {
      const byGroup = new Map<number, number>();
      for (const p of alive) byGroup.set(this.groupOf(p.id), (byGroup.get(this.groupOf(p.id)) ?? 0) + p.tiles);
      for (const tiles of byGroup.values()) {
        if (tiles >= this.landTiles * CFG.spaceShare) {
          this.phase = "space";
          this.events.push({ k: "text", text: "A superpower dominates Earth. The Space Race begins: research Rocketry, build a Spaceport." });
          break;
        }
      }
    }
  }

  /** Which group (team id or player id) can launch from here, if any. */
  canLaunch(pid: number): boolean {
    const p = this.players[pid];
    return !!p && p.alive && this.mode === "wow" && this.phase === "space" && this.ownedCount(pid, "spaceport") > 0;
  }

  /** Members of the launching group that are still alive. */
  launchGroup(pid: number): Player[] {
    const g = this.groupOf(pid);
    return this.players.filter((p) => p && p.alive && this.groupOf(p.id) === g);
  }

  // ---- missiles ---------------------------------------------------------------------------------

  launchMissile(pid: number, x: number, y: number, kind: MissileKind = "atom"): Result {
    const p = this.players[pid];
    if (!p || !p.alive || this.over) return { ok: false, error: "not in game" };
    if (this.spawnTicks > 0) return { ok: false, error: "choose your start first" };
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= this.w || y >= this.h) return { ok: false, error: "bad target" };
    const silo = this.structures.find((s) => s.owner === pid && s.type === "silo" && (s.cd ?? 0) <= 0);
    if (!this.ownedCount(pid, "silo")) return { ok: false, error: "build a Missile Silo first" };
    if (!silo) return { ok: false, error: "silo is reloading" };
    const def = MISSILES[kind];
    if (!def) return { ok: false, error: "unknown missile" };
    if (p.gold < def.cost) return { ok: false, error: "not enough gold" };
    const tile = Math.floor(y) * this.w + Math.floor(x);
    if (this.friendly(pid, this.owner[tile])) return { ok: false, error: "that is your side's land" };
    p.gold -= def.cost;
    silo.cd = def.cd;
    const dist = Math.hypot(x - silo.x, y - silo.y);
    const total = Math.round(30 + dist * 0.6);
    const warheads = kind === "mirv" ? 6 : 1;
    for (let i = 0; i < warheads; i++) {
      const spread = kind === "mirv" ? 9 : 0;
      const tx = Math.max(0, Math.min(this.w - 1, x + (this.rng() - 0.5) * 2 * spread));
      const ty = Math.max(0, Math.min(this.h - 1, y + (this.rng() - 0.5) * 2 * spread));
      this.missiles.push({
        id: this.nextMissileId++, owner: pid, sx: silo.x + 0.5, sy: silo.y + 0.5, tx, ty, total, left: total,
        kind, radius: def.radius, share: def.share,
      });
    }
    return { ok: true };
  }

  private stepMissiles(): void {
    for (const s of this.structures) if (s.cd && s.cd > 0) s.cd--;
    for (let i = this.missiles.length - 1; i >= 0; i--) {
      const m = this.missiles[i];
      if (--m.left > 0) continue;
      this.missiles.splice(i, 1);
      // interception
      let shot = false;
      for (const s of this.structures) {
        if (s.type !== "sam" || this.friendly(s.owner, m.owner)) continue;
        const r = CFG.structures.sam.range;
        if ((s.x + 0.5 - m.tx) ** 2 + (s.y + 0.5 - m.ty) ** 2 <= r * r && this.rng() < CFG.samIntercept) { shot = true; break; }
      }
      if (shot) { this.events.push({ k: "text", text: "A missile was shot down by a SAM" }); continue; }
      this.detonate(m);
    }
  }

  private detonate(m: Missile): void {
    const r = m.radius;
    const hitOwners = new Set<number>();
    for (let yy = Math.floor(m.ty) - r; yy <= Math.floor(m.ty) + r; yy++) {
      for (let xx = Math.floor(m.tx) - r; xx <= Math.floor(m.tx) + r; xx++) {
        if (xx < 0 || yy < 0 || xx >= this.w || yy >= this.h) continue;
        if ((xx + 0.5 - m.tx) ** 2 + (yy + 0.5 - m.ty) ** 2 > r * r) continue;
        const t = yy * this.w + xx;
        const o = this.owner[t];
        if (this.wall[t]) { this.wall[t] = 0; this.wallDirty.push(t); }
        if (o === 0 || this.friendly(o, m.owner)) continue;
        hitOwners.add(o);
        this.setOwner(t, 0);
      }
    }
    for (const k of this.units) {
      if (!this.friendly(k.owner, m.owner) && (k.x - m.tx) ** 2 + (k.y - m.ty) ** 2 <= r * r) k.hp = 0;
    }
    for (const o of hitOwners) {
      const d = this.players[o];
      d.troops -= d.troops * m.share;
      if (d.alive && d.tiles === 0) this.eliminate(d, m.owner);
    }
    if (hitOwners.size) this.events.push({ k: "text", text: `${this.players[m.owner].name} hit ${[...hitOwners].map((x) => this.players[x].name).join(", ")} with ${MISSILES[m.kind].label}` });
  }

  /** A random tile owned by `pid` that satisfies `pred`, or -1 (bounded random probing). */
  randomOwnedTile(pid: number, pred: (t: number) => boolean = () => true, tries = 400): number {
    for (let i = 0; i < tries; i++) {
      const t = Math.floor(this.rng() * this.owner.length);
      if (this.owner[t] === pid && pred(t)) return t;
    }
    return -1;
  }

  // ---- helpers for bots -----------------------------------------------------------------------

  /** Border scan: neutral and enemy tiles adjacent to `pid`, plus own tiles that face enemies. */
  scanBorder(pid: number): { neutral: number[]; enemies: Map<number, number[]>; ownFront: number[] } {
    const { w, h, owner, terrain } = this;
    const neutral: number[] = [];
    const enemies = new Map<number, number[]>();
    const ownFront: number[] = [];
    const bb = this.players[pid].bb ?? [0, 0, w - 1, h - 1];
    let front = false;
    const visit = (n: number): void => {
      if (terrain[n] === Terrain.Water || owner[n] === pid) return;
      const o = owner[n];
      if (o === 0) neutral.push(n);
      else {
        front = true;
        const list = enemies.get(o);
        if (list) list.push(n);
        else enemies.set(o, [n]);
      }
    };
    for (let y = bb[1]; y <= bb[3]; y++) {
      for (let x = bb[0]; x <= bb[2]; x++) {
        const i = y * w + x;
        if (owner[i] !== pid) continue;
        front = false;
        if (x > 0) visit(i - 1);
        if (x < w - 1) visit(i + 1);
        if (y > 0) visit(i - w);
        if (y < h - 1) visit(i + w);
        if (front) ownFront.push(i);
      }
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

  // ---- snapshots (save games / restart-resume) ------------------------------------------------

  exportState(): GameSnapshot {
    return {
      v: 1,
      seed: this.seed, w: this.w, h: this.h, mode: this.mode, teams: this.teams, planet: this.planet,
      terrain: rle(this.terrain), owner: rle(this.owner), wall: rle(this.wall), rail: rle(this.rail),
      dominance: this.dominance, domLeader: this.domLeader, domTicks: this.domTicks,
      players: this.players.slice(1),
      structures: this.structures,
      attacks: this.attacks.map((a) => ({ ...a, tiles: [...a.tiles] })),
      units: this.units, missiles: this.missiles,
      tickNo: this.tickNo, spawnTicks: this.spawnTicks, phase: this.phase, phaseTicks: this.phaseTicks, hold: this.hold,
      over: this.over, winner: this.winner, winnerTeam: this.winnerTeam,
      allyReq: [...this.allyReq.entries()],
      rng: this.rng.getState(),
      ids: [this.nextAttackId, this.nextStructId, this.nextUnitId, this.nextMissileId],
    };
  }

  static restore(s: GameSnapshot): Game {
    const terrain = new Uint8Array(s.w * s.h);
    unrle(s.terrain, terrain);
    const g = new Game(s.seed, s.w, s.h, { mode: s.mode, teams: s.teams, planet: s.planet, terrain, dominance: s.dominance });
    (g as { teams: number }).teams = s.teams;
    unrle(s.owner, g.owner);
    unrle(s.wall, g.wall);
    if (s.rail) unrle(s.rail, g.rail);
    g.domLeader = s.domLeader ?? 0;
    g.domTicks = s.domTicks ?? 0;
    for (const pl of s.players) { pl.embargo ??= []; }
    g.players.push(...s.players);
    g.structures.push(...s.structures);
    for (const st of g.structures) g.structAt.set(st.tile, st);
    for (const a of s.attacks) g.attacks.push({ ...a, tiles: new Set(a.tiles) });
    g.units.push(...s.units);
    g.missiles.push(...s.missiles);
    g.tickNo = s.tickNo; g.spawnTicks = s.spawnTicks; g.phase = s.phase; g.phaseTicks = s.phaseTicks; g.hold = s.hold;
    g.over = s.over; g.winner = s.winner; g.winnerTeam = s.winnerTeam;
    g.allyReq = new Map(s.allyReq);
    g.rng.setState(s.rng);
    [g.nextAttackId, g.nextStructId, g.nextUnitId, g.nextMissileId] = s.ids;
    return g;
  }
}
