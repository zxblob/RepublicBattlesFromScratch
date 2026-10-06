import { CFG, TECH, TECH_IDS } from "./config";
import type { StructType } from "./config";
import type { Game, Player } from "./game";
import { Terrain } from "./mapgen";

function pick<T>(g: Game, arr: T[]): T {
  return arr[Math.floor(g.rng() * arr.length)];
}

/**
 * Nation AI. Bots use exactly the same attack/build/research API as humans and are held back by the
 * anti-pile-on rules: a target can only be hit by a few bots at once, bots wait between attacks
 * on players, they commit fewer troops against small players, and they never attack allies or the
 * other players of their own team. During a Cold War they only expand into neutral land.
 */
export function botThink(g: Game, p: Player): void {
  if (!p.alive || g.over) return;
  botResearch(g, p);
  tryBuild(g, p);
  const scan = g.scanBorder(p.id);
  botNaval(g, p, scan.neutral.length === 0 && scan.enemies.size === 0);
  if (g.attacksOf(p.id).length >= 2) return;
  if (p.troops < g.maxTroops(p) * 0.35) return;

  for (const id of [...scan.enemies.keys()]) if (g.friendly(p.id, id)) scan.enemies.delete(id);
  const peace = g.phase === "cold";
  const wantNeutral = scan.neutral.length > 0 && (peace || g.rng() < 0.7 || scan.enemies.size === 0);
  if (wantNeutral) {
    const start = pick(g, scan.neutral);
    const region = g.grow(start, (t) => g.owner[t] === 0, 160);
    g.launchAttackTiles(p.id, region, 0.3);
    return;
  }
  if (peace || g.tickNo < p.nextAggression || scan.enemies.size === 0) return;

  let target = 0;
  for (const id of scan.enemies.keys()) {
    const e = g.players[id];
    if (g.attackersOn(id) >= CFG.botMaxAttackersPerTarget) continue;
    if (p.troops < e.troops * 1.2) continue;
    if (target === 0 || e.troops < g.players[target].troops) target = id;
  }
  if (!target) return;
  const e = g.players[target];
  const ratio =
    (e.tiles < CFG.smallTiles ? CFG.botMaxRatioVsSmall : CFG.botMaxRatioVsPlayer) * Math.min(1.2, p.aggression);
  const start = pick(g, scan.enemies.get(target)!);
  const region = g.grow(start, (t) => g.owner[t] === target, 140);
  if (g.launchAttackTiles(p.id, region, ratio).ok) {
    p.nextAggression = g.tickNo + Math.round(CFG.botPlayerCooldown / p.aggression);
  }
}

function botResearch(g: Game, p: Player): void {
  if (!g.research || g.phase === "expand") return;
  for (const id of TECH_IDS) {
    if (id.startsWith("space")) continue;
    const t = TECH[id];
    if (p.tech.includes(id) || (t.req && !p.tech.includes(t.req)) || p.rp < t.cost) continue;
    g.doResearch(p.id, id);
    return;
  }
}

function tryBuild(g: Game, p: Player): void {
  const options: StructType[] = ["bunker", "bank", "radar", "sam", "city", "farm", "port"];
  if (g.research) options.push("lab");
  const type = pick(g, options);
  if (p.gold < g.structureCost(p.id, type) + 50) return;
  let tile = -1;
  if (type === "bunker" || type === "sam") {
    const front = g.scanBorder(p.id).ownFront;
    if (!front.length) return;
    tile = pick(g, front);
  } else if (type === "port") {
    tile = g.randomOwnedTile(p.id, (t) => g.isCoastal(t) && g.terrain[t] === Terrain.Land);
  } else {
    if (p.capital < 0) return;
    const cx = p.capital % g.w, cy = (p.capital / g.w) | 0;
    tile = (cy + Math.floor(g.rng() * 9) - 4) * g.w + cx + Math.floor(g.rng() * 9) - 4;
  }
  if (tile < 0 || tile >= g.owner.length) return;
  g.build(p.id, type, tile % g.w, (tile / g.w) | 0);
}

/** Bots with a Port ferry troops to foreign or neutral coasts when they have nobody to reach by land. */
function botNaval(g: Game, p: Player, landLocked: boolean): void {
  if (!g.ownedCount(p.id, "port") || g.tickNo < (p.nextBoat ?? 0)) return;
  if (!landLocked && g.rng() > 0.05) return;
  if (p.troops < g.maxTroops(p) * 0.5) return;
  let boat = g.units.find((u) => u.owner === p.id && u.kind === "x" && u.path.length === 0 && u.cargo === 0);
  if (!boat) {
    if (!g.trainUnit(p.id, "x").ok) { p.nextBoat = g.tickNo + 300; return; }
    boat = g.units[g.units.length - 1];
  }
  for (let i = 0; i < 80; i++) {
    const t = Math.floor(g.rng() * g.owner.length);
    if (g.terrain[t] === Terrain.Water || g.friendly(p.id, g.owner[t]) || !g.isCoastal(t)) continue;
    if (g.moveUnit(p.id, boat.id, [(t % g.w) + 0.5, Math.floor(t / g.w) + 0.5], 0.4).ok) {
      p.nextBoat = g.tickNo + 900;
      return;
    }
  }
  p.nextBoat = g.tickNo + 300;
}
