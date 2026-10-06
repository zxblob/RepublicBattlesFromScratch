import { CFG, STRUCT_TYPES, StructType } from "./config";
import type { Game, Player } from "./game";

function pick<T>(g: Game, arr: T[]): T {
  return arr[Math.floor(g.rng() * arr.length)];
}

/**
 * Nation AI. Bots use exactly the same attack/build API as humans and are held back by the
 * anti-pile-on rules: a target can only be hit by a few bots at once, bots wait between attacks
 * on players, and they commit fewer troops against players who are already small.
 */
export function botThink(g: Game, p: Player): void {
  if (!p.alive || g.over) return;
  tryBuild(g, p);
  if (g.attacksOf(p.id).length >= 2) return;
  if (p.troops < g.maxTroops(p) * 0.35) return;

  const scan = g.scanBorder(p.id);
  const wantNeutral = scan.neutral.length > 0 && (g.rng() < 0.7 || scan.enemies.size === 0);
  if (wantNeutral) {
    const start = pick(g, scan.neutral);
    const region = g.grow(start, (t) => g.owner[t] === 0, 160);
    g.launchAttackTiles(p.id, region, 0.3);
    return;
  }
  if (g.tickNo < p.nextAggression || scan.enemies.size === 0) return;

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

function tryBuild(g: Game, p: Player): void {
  const type: StructType = pick(g, STRUCT_TYPES.filter((t) => t !== "tankfactory"));
  if (p.gold < g.structureCost(p.id, type) + 50) return;
  let tile = -1;
  if (type === "bank" || type === "radar") {
    if (p.capital < 0) return;
    const cx = p.capital % g.w, cy = (p.capital / g.w) | 0;
    tile = (cy + Math.floor(g.rng() * 7) - 3) * g.w + cx + Math.floor(g.rng() * 7) - 3;
  } else {
    const front = g.scanBorder(p.id).ownFront;
    if (!front.length) return;
    tile = pick(g, front);
  }
  if (tile < 0 || tile >= g.owner.length) return;
  g.build(p.id, type, tile % g.w, (tile / g.w) | 0);
}
