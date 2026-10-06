import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { WebSocket } from "ws";
import { CFG } from "../core/config";
import { Game, GameSnapshot } from "../core/game";
import type {
  AttackInfo, ClientMsg, GameSetup, LobbyMember, MeInfo, PlayerStat, ServerMsg, StructInfo, UnitInfo,
} from "../core/protocol";
import { MAP_SIZES, rle } from "../core/protocol";
import { loadMap } from "./maps";

const BOT_NAMES = [
  "Aurelia", "Borealis", "Cascadia", "Dravenia", "Eldoria", "Falkren", "Galdor", "Helvetia",
  "Ironhold", "Jadeport", "Kestrel", "Lumeria", "Marenth", "Novaria", "Ostrava", "Pelagia",
  "Quillon", "Rivenia", "Solmere", "Tarsus", "Umbria", "Valtara", "Westmark", "Xanthe",
];

export const SAVE_DIR = resolve(process.env.SAVE_DIR ?? "data/saves");
const SPAWN_TICKS = 200; // 20 s to pick a start
const MAX_BOTS = { small: 20, medium: 30, large: 40, huge: 60 } as const;
const MAX_SKIN = 14_000;

interface Client {
  token: string;
  name: string;
  ws: WebSocket | null;
  playerId: number;
  attackBudget: number;
  ready: boolean;
  skin: string;
}

interface SaveFile {
  v: 1;
  code: string;
  hostToken: string;
  paused: boolean;
  setup: GameSetup;
  clients: { token: string; name: string; playerId: number; skin: string }[];
  game: GameSnapshot;
  savedAt: number;
}

export function defaultSetup(): GameSetup {
  return { mode: "ffa", teams: 2, bots: 10, size: "small", islands: false, map: "" };
}

function cleanSetup(s: Partial<GameSetup> | undefined): GameSetup {
  const d = defaultSetup();
  const o = s ?? {};
  const mode = (["ffa", "team", "ww", "wow"] as const).includes(o.mode as never) ? (o.mode as GameSetup["mode"]) : d.mode;
  const size = (["small", "medium", "large", "huge"] as const).includes(o.size as never) ? (o.size as GameSetup["size"]) : d.size;
  return {
    mode, size,
    teams: Math.max(2, Math.min(6, Math.floor(Number(o.teams)) || 2)),
    bots: Math.max(0, Math.min(MAX_BOTS[size], Math.floor(Number(o.bots)) || 0)),
    islands: !!o.islands,
    map: String(o.map ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10),
  };
}

export class Room {
  readonly clients = new Map<string, Client>();
  hostToken = "";
  game: Game | null = null;
  paused = false;
  setup: GameSetup = defaultSetup();
  private timer: NodeJS.Timeout | null = null;
  emptySince = Date.now();
  dirtySave = false;

  constructor(readonly code: string) {}

  get empty(): boolean {
    return [...this.clients.values()].every((c) => !c.ws);
  }

  addClient(ws: WebSocket, name: string, token?: string): Client {
    const existing = token ? this.clients.get(token) : undefined;
    if (existing) {
      existing.ws?.close();
      existing.ws = ws;
      return existing;
    }
    const c: Client = { token: randomBytes(12).toString("hex"), name: cleanName(name), ws, playerId: 0, attackBudget: 5, ready: false, skin: "" };
    this.clients.set(c.token, c);
    if (!this.hostToken) this.hostToken = c.token;
    return c;
  }

  detach(token: string): void {
    const c = this.clients.get(token);
    if (!c) return;
    c.ws = null;
    if (this.empty) this.emptySince = Date.now();
    if (!this.game) {
      this.clients.delete(token);
      if (this.hostToken === token) this.hostToken = [...this.clients.keys()][0] ?? "";
      this.broadcastLobby();
    }
  }

  send(c: Client, msg: ServerMsg): void {
    if (c.ws && c.ws.readyState === 1) c.ws.send(JSON.stringify(msg));
  }

  broadcast(msg: ServerMsg): void {
    const s = JSON.stringify(msg);
    for (const c of this.clients.values()) if (c.ws && c.ws.readyState === 1) c.ws.send(s);
  }

  members(): LobbyMember[] {
    return [...this.clients.values()].map((c) => ({
      name: c.name, host: c.token === this.hostToken, connected: !!c.ws,
    }));
  }

  broadcastLobby(): void {
    if (this.game) return;
    for (const c of this.clients.values()) {
      this.send(c, { t: "lobby", code: this.code, members: this.members(), host: c.token === this.hostToken });
    }
  }

  async start(setupIn: Partial<GameSetup> | undefined): Promise<string | null> {
    if (this.game) return "already started";
    const setup = cleanSetup(setupIn);
    const humans = [...this.clients.values()];
    let w: number, h: number, terrain: Uint8Array | undefined;
    if (setup.map) {
      const m = await loadMap(setup.map);
      if (!m) return "unknown custom map code";
      [w, h, terrain] = [m.map.w, m.map.h, m.terrain];
    } else [w, h] = MAP_SIZES[setup.size];
    if (humans.length + setup.bots < 2) return "need at least 2 players";
    if (this.game) return "already started";
    const seed = (Math.random() * 2 ** 31) | 0;
    const game = new Game(seed, w, h, { mode: setup.mode, teams: setup.teams, islands: setup.islands, terrain });
    for (const c of humans) {
      const p = game.addPlayer(c.name, false);
      c.playerId = p.id;
      if (c.skin) p.skin = c.skin;
    }
    for (let i = 0; i < setup.bots; i++) {
      game.addPlayer(BOT_NAMES[i % BOT_NAMES.length] + (i >= BOT_NAMES.length ? ` ${Math.floor(i / BOT_NAMES.length) + 1}` : ""), true);
    }
    try {
      game.spawnAll();
    } catch {
      return "that map is too small for this many nations";
    }
    const startGold = Number(process.env.RB_START_GOLD ?? 0);
    if (startGold > 0) for (const pl of game.players.slice(1)) pl.gold = startGold;
    this.setup = setup;
    this.game = game;
    game.dirty = [];
    game.spawnTicks = SPAWN_TICKS;
    for (const c of humans) this.sendStart(c);
    this.run();
    return null;
  }

  private run(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), CFG.tickMs);
  }

  sendStart(c: Client): void {
    const g = this.game!;
    this.send(c, {
      t: "start", you: c.playerId, w: g.w, h: g.h, mode: g.mode, teams: g.teams, planet: g.planet,
      phase: g.phase, pt: g.phaseTicks,
      players: g.players.slice(1).map((p) => ({
        id: p.id, name: p.name, color: p.color, isBot: p.isBot, cap: p.capital, team: p.team, skin: p.skin,
      })),
      terrain: rle(g.terrain), owners: rle(g.owner), structs: this.structInfos(), tick: g.tickNo, paused: this.paused,
      sp: g.spawnTicks, walls: this.wallList(), units: this.unitInfos(),
    });
  }

  private wallList(): [number, number][] {
    const g = this.game!;
    const out: [number, number][] = [];
    for (let i = 0; i < g.wall.length; i++) if (g.wall[i]) out.push([i, g.wall[i]]);
    return out;
  }

  private unitInfos(): UnitInfo[] {
    return this.game!.units.map((k) => {
      const last = k.path[k.path.length - 1];
      return {
        id: k.id, owner: k.owner, x: Math.round(k.x * 100) / 100, y: Math.round(k.y * 100) / 100, hp: k.hp, k: k.kind,
        ammo: k.ammo, cargo: Math.floor(k.cargo), tx: last ? last[0] : -1, ty: last ? last[1] : -1,
      };
    });
  }

  private structInfos(): StructInfo[] {
    return this.game!.structures.map((s) => ({ id: s.id, type: s.type, owner: s.owner, x: s.x, y: s.y }));
  }

  private err(c: Client, msg: string | undefined, fallback = "failed"): void {
    this.send(c, { t: "error", msg: msg ?? fallback });
  }

  handle(c: Client, msg: ClientMsg): void {
    const g = this.game;
    const pid = c.playerId;
    switch (msg.t) {
      case "start": {
        if (c.token !== this.hostToken) return this.err(c, "only the host can start");
        void this.start(msg.setup).then((e) => e && this.err(c, e));
        return;
      }
      case "skin": {
        const d = String(msg.data ?? "");
        if (d.length > MAX_SKIN || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(d)) return this.err(c, "bad image");
        c.skin = d;
        if (g && pid) { g.players[pid].skin = d; g.skinDirty.push(pid); }
        return;
      }
      case "save":
        if (c.token !== this.hostToken || !g) return;
        this.dirtySave = true;
        void this.save().then(() => this.send(c, { t: "saved" }));
        return;
      case "spawn": {
        if (!g || !pid) return;
        const r = g.respawn(pid, Math.floor(Number(msg.x)), Math.floor(Number(msg.y)));
        if (!r.ok) this.err(c, r.error, "can't spawn there");
        return;
      }
      case "ready": {
        if (!g || !pid) return;
        c.ready = true;
        if ([...this.clients.values()].filter((x) => x.ws).every((x) => x.ready)) g.spawnTicks = Math.min(g.spawnTicks, 10);
        return;
      }
      case "pause":
        if (c.token !== this.hostToken || !g) return;
        this.paused = !this.paused;
        this.broadcast({ t: "paused", paused: this.paused });
        this.dirtySave = true;
        return;
      case "cancel":
        if (g && pid) g.cancelAttack(pid, Number(msg.id));
        return;
      case "launch":
        if (g && pid && !this.paused) this.enterPlanet(c);
        return;
    }
    if (!g || this.paused || !pid) return;
    let r: { ok: boolean; error?: string } | undefined;
    switch (msg.t) {
      case "attack":
        if (c.attackBudget < 1 || !Array.isArray(msg.poly)) return;
        c.attackBudget--;
        r = g.launchAttack(pid, msg.poly, Number(msg.ratio));
        break;
      case "reinforce": r = g.reinforceAttack(pid, Number(msg.id), Number(msg.ratio)); break;
      case "build": r = g.build(pid, msg.type, msg.x, msg.y); break;
      case "wall": if (Array.isArray(msg.pts)) r = g.buildWall(pid, msg.pts); break;
      case "train": r = g.trainUnit(pid, msg.kind); break;
      case "move": if (Array.isArray(msg.pts)) r = g.moveUnit(pid, Number(msg.id), msg.pts, Number(msg.ratio) || 0); break;
      case "missile": r = g.launchMissile(pid, Number(msg.x), Number(msg.y)); break;
      case "ally": r = g.proposeAlliance(pid, Number(msg.with)); break;
      case "unally": r = g.breakAlliance(pid, Number(msg.with)); break;
      case "research": r = g.doResearch(pid, String(msg.id)); break;
    }
    if (r && !r.ok) this.err(c, r.error);
  }

  /** War of the Worlds: the launching side moves to a fresh planet; everyone else spectates. */
  private enterPlanet(c: Client): void {
    const g = this.game!;
    if (!g.canLaunch(c.playerId)) return this.err(c, "you need a Spaceport during the Space Race");
    const group = g.launchGroup(c.playerId);
    const mods = ["frozen", "volcanic", "desert"];
    const planet = mods[Math.floor(Math.random() * mods.length)];
    const seed = (Math.random() * 2 ** 31) | 0;
    const ng = new Game(seed, 160, 96, { mode: "wow", planet });
    const map = new Map<number, number>();
    for (const old of group) {
      const p = ng.addPlayer(old.name, old.isBot);
      map.set(old.id, p.id);
      p.team = 1;
      p.tech = [...old.tech];
      p.rp = old.rp;
      p.skin = old.skin;
      p.color = old.color;
      p.troops = Math.max(CFG.startTroops, old.troops * 0.5);
      p.gold = old.gold * 0.5;
    }
    for (let i = 0; i < 6; i++) {
      const a = ng.addPlayer("Xeno " + (i + 1), true);
      a.troops = CFG.startTroops * 2;
      a.color = 0x9b59b6 + i * 0x050a00;
    }
    ng.teams = 0;
    try { ng.spawnAll(); } catch { return this.err(c, "no landing site found"); }
    ng.spawnTicks = SPAWN_TICKS;
    this.game = ng;
    for (const cl of this.clients.values()) {
      cl.ready = false;
      cl.playerId = map.get(cl.playerId) ?? 0;
      this.send(cl, { t: "error", msg: `Landing on a ${planet} planet!` });
      this.sendStart(cl);
    }
    this.dirtySave = true;
  }

  private tick(): void {
    const g = this.game!;
    for (const c of this.clients.values()) c.attackBudget = Math.min(5, c.attackBudget + 0.5);
    if (this.paused) return;
    g.tick();
    const d: number[] = new Array(g.dirty.length * 2);
    for (let i = 0; i < g.dirty.length; i++) { d[i * 2] = g.dirty[i]; d[i * 2 + 1] = g.owner[g.dirty[i]]; }
    g.dirty = [];
    const p: PlayerStat[] = [];
    for (let id = 1; id < g.players.length; id++) {
      const pl = g.players[id];
      p.push([id, Math.floor(pl.troops), Math.floor(pl.gold), pl.tiles, pl.alive ? 1 : 0]);
    }
    const wallTiles = [...new Set(g.wallDirty)];
    g.wallDirty = [];
    const w: [number, number][] | undefined = wallTiles.length ? wallTiles.map((t) => [t, g.wall[t]] as [number, number]) : undefined;
    const u = this.unitInfos();
    const caps = g.capDirty.length ? g.capDirty : undefined;
    g.capDirty = [];
    const sk: [number, string][] | undefined = g.skinDirty.length
      ? [...new Set(g.skinDirty)].map((id) => [id, g.players[id].skin ?? ""] as [number, string])
      : undefined;
    g.skinDirty = [];
    const structs = g.structDirty ? this.structInfos() : undefined;
    g.structDirty = false;
    const ms = g.missiles.map((m) => ({ id: m.id, owner: m.owner, sx: m.sx, sy: m.sy, tx: m.tx, ty: m.ty, total: m.total, left: m.left }));
    const ev = g.events.map((e) => {
      switch (e.k) {
        case "elim": return `${g.players[e.id].name} was eliminated${e.by ? " by " + g.players[e.by].name : ""}`;
        case "win": return e.id ? `${g.players[e.id].name}${g.winnerTeam ? "'s team" : ""} wins!` : "Game over";
        case "attack": return e.on && !g.players[e.by].isBot ? `${g.players[e.by].name} attacks ${g.players[e.on].name}` : "";
        case "text": return e.text;
        default: return "";
      }
    }).filter(Boolean);
    g.events = [];

    for (const c of this.clients.values()) {
      if (!c.ws) continue;
      const me = c.playerId ? g.players[c.playerId] : null;
      const radar = me ? g.hasStructure(c.playerId, "radar") : false;
      const a: AttackInfo[] = [];
      for (const at of g.attacks) {
        const full = { id: at.id, by: at.by, on: at.on, x: at.cx, y: at.cy, pool: Math.floor(at.pool), left: at.tiles.size };
        if (at.by === c.playerId) a.push(full);
        else if (at.on === c.playerId) a.push(radar ? full : { id: at.id, by: at.by, on: at.on });
        else if (radar) {
          const near = g.structures.some((s) => s.owner === c.playerId && s.type === "radar" &&
            (s.x - at.cx) ** 2 + (s.y - at.cy) ** 2 <= CFG.structures.radar.range ** 2);
          if (near) a.push(full);
        }
      }
      const meInfo: MeInfo = {
        rp: me ? Math.floor(me.rp) : 0,
        tech: me ? me.tech : [],
        allies: me ? me.allies : [],
        reqs: c.playerId ? g.allyReq.get(c.playerId) ?? [] : [],
        canLaunch: c.playerId ? g.canLaunch(c.playerId) : false,
      };
      this.send(c, {
        t: "tick", n: g.tickNo, d, p, a, s: structs, ev: ev.length ? ev : undefined, sp: g.spawnTicks, caps, u, w,
        ph: g.phase, pt: g.phaseTicks, me: meInfo, ms, sk,
      });
    }
    if (g.over) {
      this.broadcast({ t: "over", winner: g.winner, team: g.winnerTeam });
      this.stop();
      void unlink(join(SAVE_DIR, this.code + ".json")).catch(() => {});
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ---- persistence -----------------------------------------------------------------------------

  async save(): Promise<void> {
    if (!this.game || this.game.over) return;
    const data: SaveFile = {
      v: 1, code: this.code, hostToken: this.hostToken, paused: this.paused, setup: this.setup,
      clients: [...this.clients.values()].map((c) => ({ token: c.token, name: c.name, playerId: c.playerId, skin: c.skin })),
      game: this.game.exportState(), savedAt: Date.now(),
    };
    await mkdir(SAVE_DIR, { recursive: true });
    const file = join(SAVE_DIR, this.code + ".json");
    await writeFile(file + ".tmp", JSON.stringify(data));
    await rename(file + ".tmp", file);
    this.dirtySave = false;
  }

  static fromSave(d: SaveFile): Room {
    const r = new Room(d.code);
    r.hostToken = d.hostToken;
    r.paused = true; // resume paused; the host presses play
    r.setup = d.setup;
    for (const c of d.clients) {
      r.clients.set(c.token, { token: c.token, name: c.name, ws: null, playerId: c.playerId, attackBudget: 5, ready: true, skin: c.skin });
    }
    r.game = Game.restore(d.game);
    r.game.spawnTicks = 0;
    r.run();
    return r;
  }
}

function cleanName(n: unknown): string {
  const s = String(n ?? "").replace(/[^\p{L}\p{N} _.-]/gu, "").trim().slice(0, 16);
  return s || "Player" + Math.floor(Math.random() * 900 + 100);
}

export class RoomManager {
  readonly rooms = new Map<string, Room>();
  private timers: NodeJS.Timeout[] = [];

  constructor() {
    // autosave running games; unload long-empty rooms (their save stays on disk and is reloaded on demand)
    this.timers.push(setInterval(() => void this.autosave(), 30_000));
    this.timers.push(setInterval(() => {
      for (const [code, r] of this.rooms) {
        if (!r.empty) continue;
        const idle = Date.now() - r.emptySince;
        if (!r.game && idle > 120_000) { r.stop(); this.rooms.delete(code); }
        else if (r.game && idle > 600_000) { void r.save().finally(() => { r.stop(); this.rooms.delete(code); }); }
      }
    }, 30_000));
    for (const t of this.timers) t.unref();
  }

  async autosave(): Promise<void> {
    for (const r of this.rooms.values()) {
      if (r.game && !r.game.over && (r.dirtySave || !r.paused)) await r.save().catch((e) => console.error("save failed", e));
    }
  }

  async saveAll(): Promise<void> {
    for (const r of this.rooms.values()) if (r.game && !r.game.over) await r.save().catch(() => {});
  }

  create(): Room {
    let code = "";
    do code = Array.from({ length: 5 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("");
    while (this.rooms.has(code));
    const r = new Room(code);
    this.rooms.set(code, r);
    return r;
  }

  /** Find a room in memory, or restore it from a save file. */
  async get(codeIn: string): Promise<Room | undefined> {
    const code = String(codeIn).toUpperCase().trim();
    const live = this.rooms.get(code);
    if (live) return live;
    if (!/^[A-Z0-9]{4,8}$/.test(code)) return undefined;
    try {
      const d = JSON.parse(await readFile(join(SAVE_DIR, code + ".json"), "utf8")) as SaveFile;
      const again = this.rooms.get(code);
      if (again) return again;
      const r = Room.fromSave(d);
      this.rooms.set(code, r);
      return r;
    } catch {
      return undefined;
    }
  }

  async loadAll(): Promise<number> {
    let n = 0;
    try {
      for (const f of await readdir(SAVE_DIR)) {
        if (f.endsWith(".json") && (await this.get(f.slice(0, -5)))) n++;
      }
    } catch { /* no saves yet */ }
    return n;
  }
}
