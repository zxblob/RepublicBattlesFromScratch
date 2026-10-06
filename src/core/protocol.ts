import type { StructType } from "./config";

export interface UnitInfo {
  id: number;
  owner: number;
  x: number;
  y: number;
  hp: number;
  /** final waypoint, or -1 when idle */
  tx: number;
  ty: number;
}

export interface PlayerInfo {
  id: number;
  name: string;
  color: number;
  isBot: boolean;
  /** capital tile index at game start */
  cap: number;
}

export interface StructInfo {
  id: number;
  type: StructType;
  owner: number;
  x: number;
  y: number;
}

/** Per-tick stats: [id, troops, gold, tiles, alive(0/1)] */
export type PlayerStat = [number, number, number, number, number];

export interface AttackInfo {
  id: number;
  by: number;
  on: number;
  /** front centroid + committed troops, only when the viewer is allowed to see details */
  x?: number;
  y?: number;
  pool?: number;
  left?: number;
}

export interface LobbyMember {
  name: string;
  host: boolean;
  connected: boolean;
}

// ---- client -> server ----
export type ClientMsg =
  | { t: "solo"; name: string; bots: number; token?: string }
  | { t: "create"; name: string; token?: string }
  | { t: "join"; code: string; name: string; token?: string }
  | { t: "rejoin"; code: string; token: string }
  | { t: "start"; bots: number }
  | { t: "attack"; poly: number[]; ratio: number }
  | { t: "build"; type: StructType; x: number; y: number }
  | { t: "cancel"; id: number }
  | { t: "spawn"; x: number; y: number }
  | { t: "wall"; pts: number[] }
  | { t: "train" }
  | { t: "move"; id: number; pts: number[] }
  | { t: "ready" }
  | { t: "reinforce"; id: number; ratio: number }
  | { t: "pause" }
  | { t: "leave" };

// ---- server -> client ----
export type ServerMsg =
  | { t: "joined"; code: string; token: string; host: boolean }
  | { t: "lobby"; code: string; members: LobbyMember[]; host: boolean }
  | {
      t: "start";
      you: number;
      seed: number;
      w: number;
      h: number;
      players: PlayerInfo[];
      /** run-length encoded owner grid: [owner, count, owner, count, ...] */
      owners: number[];
      structs: StructInfo[];
      tick: number;
      paused: boolean;
      /** spawn-phase ticks remaining */
      sp: number;
      walls: [number, number][];
      units: UnitInfo[];
    }
  | {
      t: "tick";
      n: number;
      /** flattened [tile, owner, tile, owner, ...] */
      d: number[];
      p: PlayerStat[];
      a: AttackInfo[];
      s?: StructInfo[];
      ev?: string[];
      sp: number;
      caps?: [number, number][];
      u: UnitInfo[];
      w?: [number, number][];
    }
  | { t: "paused"; paused: boolean }
  | { t: "over"; winner: number }
  | { t: "error"; msg: string };

export function rle(owner: ArrayLike<number>): number[] {
  const out: number[] = [];
  let cur = owner[0], n = 0;
  for (let i = 0; i < owner.length; i++) {
    if (owner[i] === cur) n++;
    else { out.push(cur, n); cur = owner[i]; n = 1; }
  }
  out.push(cur, n);
  return out;
}

export function unrle(runs: number[], out: Uint16Array): void {
  let i = 0;
  for (let r = 0; r < runs.length; r += 2) {
    const v = runs[r], n = runs[r + 1];
    out.fill(v, i, i + n);
    i += n;
  }
}
