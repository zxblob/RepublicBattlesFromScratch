import { randomBytes } from "node:crypto";
import type { WebSocket } from "ws";
import { CFG } from "../core/config";
import { Game } from "../core/game";
import type {
  AttackInfo, ClientMsg, LobbyMember, PlayerStat, ServerMsg, StructInfo,
} from "../core/protocol";
import { rle } from "../core/protocol";

const BOT_NAMES = [
  "Aurelia", "Borealis", "Cascadia", "Dravenia", "Eldoria", "Falkren", "Galdor", "Helvetia",
  "Ironhold", "Jadeport", "Kestrel", "Lumeria", "Marenth", "Novaria", "Ostrava", "Pelagia",
  "Quillon", "Rivenia", "Solmere", "Tarsus", "Umbria", "Valtara", "Westmark", "Xanthe",
];

interface Client {
  token: string;
  name: string;
  ws: WebSocket | null;
  playerId: number;
  attackBudget: number;
}

export class Room {
  readonly clients = new Map<string, Client>();
  hostToken = "";
  game: Game | null = null;
  paused = false;
  private timer: NodeJS.Timeout | null = null;
  private emptySince = Date.now();

  constructor(readonly code: string) {}

  get empty(): boolean {
    return [...this.clients.values()].every((c) => !c.ws);
  }

  get stale(): boolean {
    return this.empty && Date.now() - this.emptySince > 120_000;
  }

  addClient(ws: WebSocket, name: string, token?: string): Client {
    const existing = token ? this.clients.get(token) : undefined;
    if (existing) {
      existing.ws?.close();
      existing.ws = ws;
      return existing;
    }
    const c: Client = { token: randomBytes(12).toString("hex"), name: cleanName(name), ws, playerId: 0, attackBudget: 5 };
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

  start(bots: number): string | null {
    if (this.game) return "already started";
    bots = Math.max(0, Math.min(20, Math.floor(bots) || 0));
    const humans = [...this.clients.values()];
    if (humans.length + bots < 2) return "need at least 2 players";
    const seed = (Math.random() * 2 ** 31) | 0;
    const game = new Game(seed, 192, 112);
    for (const c of humans) c.playerId = game.addPlayer(c.name, false).id;
    for (let i = 0; i < bots; i++) game.addPlayer(BOT_NAMES[i % BOT_NAMES.length] + (i >= BOT_NAMES.length ? ` ${Math.floor(i / BOT_NAMES.length) + 1}` : ""), true);
    game.spawnAll();
    this.game = game;
    game.dirty = [];
    for (const c of humans) this.sendStart(c);
    this.timer = setInterval(() => this.tick(), CFG.tickMs);
    return null;
  }

  sendStart(c: Client): void {
    const g = this.game!;
    this.send(c, {
      t: "start", you: c.playerId, seed: g.seed, w: g.w, h: g.h,
      players: g.players.slice(1).map((p) => ({ id: p.id, name: p.name, color: p.color, isBot: p.isBot, cap: p.capital })),
      owners: rle(g.owner), structs: this.structInfos(), tick: g.tickNo, paused: this.paused,
    });
  }

  private structInfos(): StructInfo[] {
    return this.game!.structures.map((s) => ({ id: s.id, type: s.type, owner: s.owner, x: s.x, y: s.y }));
  }

  handle(c: Client, msg: ClientMsg): void {
    const g = this.game;
    switch (msg.t) {
      case "start": {
        if (c.token !== this.hostToken) return this.send(c, { t: "error", msg: "only the host can start" });
        const err = this.start(msg.bots);
        if (err) this.send(c, { t: "error", msg: err });
        return;
      }
      case "pause":
        if (c.token !== this.hostToken || !g) return;
        this.paused = !this.paused;
        this.broadcast({ t: "paused", paused: this.paused });
        return;
      case "attack": {
        if (!g || this.paused || !c.playerId) return;
        if (c.attackBudget < 1) return;
        c.attackBudget--;
        if (!Array.isArray(msg.poly)) return;
        const r = g.launchAttack(c.playerId, msg.poly, Number(msg.ratio));
        if (!r.ok) this.send(c, { t: "error", msg: r.error ?? "attack failed" });
        return;
      }
      case "build": {
        if (!g || this.paused || !c.playerId) return;
        const r = g.build(c.playerId, msg.type, msg.x, msg.y);
        if (!r.ok) this.send(c, { t: "error", msg: r.error ?? "build failed" });
        return;
      }
      case "cancel":
        if (g && c.playerId) g.cancelAttack(c.playerId, Number(msg.id));
        return;
    }
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
    const structs = g.structDirty ? this.structInfos() : undefined;
    g.structDirty = false;
    const ev = g.events.map((e) => {
      switch (e.k) {
        case "elim": return `${g.players[e.id].name} was eliminated${e.by ? " by " + g.players[e.by].name : ""}`;
        case "win": return e.id ? `${g.players[e.id].name} wins!` : "Game over";
        case "attack": return e.on && !g.players[e.by].isBot ? `${g.players[e.by].name} attacks ${g.players[e.on].name}` : "";
        default: return "";
      }
    }).filter(Boolean);
    g.events = [];

    for (const c of this.clients.values()) {
      if (!c.ws) continue;
      const radar = c.playerId ? g.hasStructure(c.playerId, "radar") : false;
      const a: AttackInfo[] = [];
      for (const at of g.attacks) {
        if (at.by === c.playerId) a.push({ id: at.id, by: at.by, on: at.on, x: at.cx, y: at.cy, pool: Math.floor(at.pool), left: at.tiles.size });
        else if (at.on === c.playerId) {
          a.push(radar
            ? { id: at.id, by: at.by, on: at.on, x: at.cx, y: at.cy, pool: Math.floor(at.pool), left: at.tiles.size }
            : { id: at.id, by: at.by, on: at.on });
        } else if (radar) {
          const near = g.structures.some((s) => s.owner === c.playerId && s.type === "radar" &&
            (s.x - at.cx) ** 2 + (s.y - at.cy) ** 2 <= CFG.structures.radar.range ** 2);
          if (near) a.push({ id: at.id, by: at.by, on: at.on, x: at.cx, y: at.cy, pool: Math.floor(at.pool), left: at.tiles.size });
        }
      }
      this.send(c, { t: "tick", n: g.tickNo, d, p, a, s: structs, ev: ev.length ? ev : undefined });
    }
    if (g.over) {
      this.broadcast({ t: "over", winner: g.winner });
      this.stop();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

function cleanName(n: unknown): string {
  const s = String(n ?? "").replace(/[^\p{L}\p{N} _.-]/gu, "").trim().slice(0, 16);
  return s || "Player" + Math.floor(Math.random() * 900 + 100);
}

export class RoomManager {
  readonly rooms = new Map<string, Room>();

  constructor() {
    setInterval(() => {
      for (const [code, r] of this.rooms) {
        if (r.stale) { r.stop(); this.rooms.delete(code); }
      }
    }, 30_000).unref();
  }

  create(): Room {
    let code = "";
    do code = Array.from({ length: 5 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("");
    while (this.rooms.has(code));
    const r = new Room(code);
    this.rooms.set(code, r);
    return r;
  }

  get(code: string): Room | undefined {
    return this.rooms.get(String(code).toUpperCase().trim());
  }
}
