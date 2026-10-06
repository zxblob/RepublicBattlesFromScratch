import type { StructType } from "./config";

export type Mode = "ffa" | "team" | "ww" | "wow";
export type MapSize = "small" | "medium" | "large" | "huge";
export type UnitK = "t" | "f" | "b" | "x" | "w" | "r";

export const MAP_SIZES: Record<MapSize, [number, number]> = {
  small: [192, 112],
  medium: [320, 192],
  large: [512, 320],
  huge: [1024, 640],
};

export interface GameSetup {
  mode: Mode;
  teams: number;
  bots: number;
  size: MapSize;
  islands: boolean;
  /** premade map id (WORLD, EUROPE...), custom map code from the editor, or "" for a random map */
  map: string;
  /** dominance countdown victory */
  dominance: boolean;
  /** co-op: all human players share one team against the bots */
  coop: boolean;
}

export interface UnitInfo {
  id: number;
  owner: number;
  x: number;
  y: number;
  hp: number;
  /** t = tank, f = fighter, b = bomber, x = transport, w = warship */
  k: UnitK;
  ammo: number;
  cargo: number;
  /** final waypoint, or -1 when idle */
  tx: number;
  ty: number;
}

export interface TrainInfo {
  id: number;
  owner: number;
  x: number;
  y: number;
  /** heading in radians (sprite faces up at 0) */
  a: number;
}

export interface MissileInfo {
  id: number;
  owner: number;
  sx: number;
  sy: number;
  tx: number;
  ty: number;
  total: number;
  left: number;
  k: "atom" | "hydrogen" | "mirv";
  radius: number;
}

export interface PlayerInfo {
  id: number;
  name: string;
  color: number;
  isBot: boolean;
  /** capital tile index at game start */
  cap: number;
  team: number;
  skin?: string;
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

/** Private per-viewer state */
export interface MeInfo {
  rp: number;
  tech: string[];
  allies: number[];
  /** players who proposed an alliance to you */
  reqs: number[];
  canLaunch: boolean;
  embargo: number[];
}

export interface LobbyMember {
  name: string;
  host: boolean;
  connected: boolean;
}

// ---- client -> server ----
export type ClientMsg =
  | { t: "solo"; name: string; setup: GameSetup }
  | { t: "create"; name: string }
  | { t: "join"; code: string; name: string; token?: string }
  | { t: "rejoin"; code: string; token: string }
  | { t: "start"; setup: GameSetup }
  | { t: "attack"; poly: number[]; ratio: number }
  | { t: "build"; type: StructType; x: number; y: number }
  | { t: "cancel"; id: number }
  | { t: "reinforce"; id: number; ratio: number }
  | { t: "spawn"; x: number; y: number }
  | { t: "wall"; pts: number[] }
  | { t: "train"; kind: UnitK }
  | { t: "move"; id: number; pts: number[]; ratio?: number }
  | { t: "missile"; x: number; y: number; kind?: "atom" | "hydrogen" | "mirv" }
  | { t: "rail"; pts: number[] }
  | { t: "donate"; to: number; what: "troops" | "gold" }
  | { t: "embargo"; with: number; on: boolean }
  | { t: "chat"; id: number }
  | { t: "clearskin"; id: number }
  | { t: "ally"; with: number }
  | { t: "unally"; with: number }
  | { t: "research"; id: string }
  | { t: "launch" }
  | { t: "skin"; data: string }
  | { t: "save" }
  | { t: "ready" }
  | { t: "pause" }
  | { t: "leave" };

// ---- server -> client ----
export type ServerMsg =
  | { t: "joined"; code: string; token: string; host: boolean }
  | { t: "lobby"; code: string; members: LobbyMember[]; host: boolean }
  | {
      t: "start";
      you: number;
      w: number;
      h: number;
      mode: Mode;
      teams: number;
      planet: string;
      phase: string;
      pt: number;
      players: PlayerInfo[];
      /** run-length encoded terrain and owner grids: [value, count, value, count, ...] */
      terrain: number[];
      owners: number[];
      structs: StructInfo[];
      tick: number;
      paused: boolean;
      /** spawn-phase ticks remaining */
      sp: number;
      walls: [number, number][];
      units: UnitInfo[];
      rails: number[];
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
      /** rail tile changes: [tile, 0/1] */
      rl?: [number, number][];
      ph: string;
      pt: number;
      me: MeInfo;
      ms: MissileInfo[];
      tr: TrainInfo[];
      /** dominance countdown: ticks left (0 = none) and the leading player's id */
      dm: number;
      dl: number;
      sk?: [number, string][];
    }
  | { t: "paused"; paused: boolean }
  | { t: "over"; winner: number; team: number }
  | { t: "saved" }
  | { t: "chat"; from: number; id: number }
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

export function unrle(runs: number[], out: Uint16Array | Uint8Array): void {
  let i = 0;
  for (let r = 0; r < runs.length; r += 2) {
    const v = runs[r], n = runs[r + 1];
    out.fill(v, i, i + n);
    i += n;
  }
}
