import { DIFFICULTY, MISSILES, MissileKind, TECH, TECH_IDS } from "./config";
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
  const dif = DIFFICULTY[g.difficulty];
  botResearch(g, p);
  const scan = g.scanBorder(p.id);
  tryBuild(g, p, scan.ownFront);
  botMilitary(g, p, scan);
  botNaval(g, p, scan.neutral.length === 0 && scan.enemies.size === 0);
  if (g.attacksOf(p.id).length >= 2) return;
  if (p.troops < g.maxTroops(p) * 0.35) return;

  for (const id of [...scan.enemies.keys()]) if (g.friendly(p.id, id)) scan.enemies.delete(id);
  const peace = g.phase === "cold";
  const wantNeutral = scan.neutral.length > 0 && (peace || g.rng() < 0.7 || scan.enemies.size === 0);
  if (wantNeutral) {
    const start = pick(g, scan.neutral);
    const region = g.grow(start, (t) => g.owner[t] === 0, 160);
    g.launchAttackTiles(p.id, region, dif.expandRatio);
    return;
  }
  if (peace || g.tickNo < p.nextAggression || scan.enemies.size === 0) return;

  let target = 0;
  for (const id of scan.enemies.keys()) {
    const e = g.players[id];
    if (g.attackersOn(id) >= dif.attackers) continue;
    if (p.troops < e.troops * dif.threshold) continue;
    if (target === 0 || e.troops < g.players[target].troops) target = id;
  }
  // retaliation: whoever is invading us right now gets hit back first
  if (dif.smart) {
    const hitMe = g.attacks.find((a) => a.on === p.id && scan.enemies.has(a.by) && p.troops >= g.players[a.by].troops * 0.5);
    if (hitMe) target = hitMe.by;
  }
  if (!target) return;
  const e = g.players[target];
  const ratio =
    (e.tiles < 120 ? dif.ratioSmall : dif.ratioPlayer) * Math.min(1.2, p.aggression);
  const start = pick(g, scan.enemies.get(target)!);
  const region = g.grow(start, (t) => g.owner[t] === target, 140);
  if (g.launchAttackTiles(p.id, region, ratio).ok) {
    p.nextAggression = g.tickNo + Math.round(dif.cooldown / p.aggression);
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

function tryBuild(g: Game, p: Player, front: number[]): void {
  const options: StructType[] = ["bunker", "bank", "radar", "sam", "city", "farm", "port", "factory", "tankfactory", "airbase", "silo"];
  if (g.research) options.push("lab");
  const type = DIFFICULTY[g.difficulty].smart ? smartPick(g, p, front, options) : pick(g, options);
  if (p.gold < g.structureCost(p.id, type) + 50) return;
  let tile = -1;
  if (type === "bunker" || type === "sam") {
    if (!front.length) return;
    tile = pick(g, front);
  } else if (type === "port") {
    tile = g.randomOwnedTile(p.id, (t) => g.isCoastal(t) && g.terrain[t] === Terrain.Land);
  } else if (DIFFICULTY[g.difficulty].smart) {
    tile = g.randomOwnedTile(p.id, (t) => g.terrain[t] === Terrain.Land);
  } else {
    if (p.capital < 0) return;
    const cx = p.capital % g.w, cy = (p.capital / g.w) | 0;
    tile = (cy + Math.floor(g.rng() * 9) - 4) * g.w + cx + Math.floor(g.rng() * 9) - 4;
  }
  if (tile < 0 || tile >= g.owner.length) return;
  g.build(p.id, type, tile % g.w, (tile / g.w) | 0);
}

/** Economy first (cities, farms, banks, a port), defence where we are being hit, then the heavy hitters. */
function smartPick(g: Game, p: Player, front: number[], options: StructType[]): StructType {
  const n = (t: StructType) => g.ownedCount(p.id, t);
  const underAttack = g.attackersOn(p.id) > 0;
  const want: StructType[] = [];
  if (n("city") < 1 + p.tiles / 120) want.push("city", "city");
  if (n("farm") < 1 + p.tiles / 200) want.push("farm");
  if (n("bank") < 1 + p.tiles / 250) want.push("bank");
  if (!n("port")) want.push("port");
  if (underAttack && front.length) want.push("bunker", "bunker", "bunker");
  if (g.structures.some((s) => s.owner !== p.id && (s.type === "airbase") && !g.friendly(p.id, s.owner))) want.push("sam");
  if (p.gold > 1500) want.push("tankfactory", "airbase", "silo");
  if (g.research && !n("lab")) want.push("lab");
  const ok = want.filter((t) => options.includes(t));
  return ok.length ? pick(g, ok) : pick(g, options);
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

type Scan = ReturnType<Game["scanBorder"]>;

/** Bots with a Tank Factory, Airbase or Silo actually use them. */
function botMilitary(g: Game, p: Player, scan: Scan): void {
  if (g.phase === "cold" || g.tickNo < (p.nextMilitary ?? 0)) return;
  p.nextMilitary = g.tickNo + Math.round(150 / p.aggression);
  const enemyIds = [...scan.enemies.keys()].filter((id) => !g.friendly(p.id, id));
  const mine = g.units.filter((u) => u.owner === p.id);

  // tanks: follow the biggest running attack, otherwise sit on the front
  if (g.ownedCount(p.id, "tankfactory")) {
    if (mine.filter((u) => u.kind === "t").length < 3) g.trainUnit(p.id, "t");
    const atk = g.attacks.filter((a) => a.by === p.id).sort((a, b) => b.pool - a.pool)[0];
    for (const t of mine.filter((u) => u.kind === "t" && u.path.length === 0)) {
      if (atk) g.moveUnit(p.id, t.id, [atk.cx, atk.cy]);
      else if (scan.ownFront.length) {
        const f = scan.ownFront[Math.floor(g.rng() * scan.ownFront.length)];
        g.moveUnit(p.id, t.id, [(f % g.w) + 0.5, Math.floor(f / g.w) + 0.5]);
      }
    }
  }

  // aircraft: bombers hunt enemy buildings, one fighter guards the capital
  if (g.ownedCount(p.id, "airbase")) {
    if (mine.filter((u) => u.kind === "b").length < 2) g.trainUnit(p.id, "b");
    else if (mine.filter((u) => u.kind === "f").length < 1) g.trainUnit(p.id, "f");
    const targets = g.structures.filter((s) => s.owner !== p.id && !g.friendly(p.id, s.owner) && enemyIds.includes(s.owner));
    for (const b of mine.filter((u) => u.kind === "b" && u.path.length === 0 && u.ammo > 0)) {
      if (!targets.length) break;
      const t = targets[Math.floor(g.rng() * targets.length)];
      g.moveUnit(p.id, b.id, [t.x + 0.5, t.y + 0.5]);
    }
    for (const f of mine.filter((u) => u.kind === "f" && u.path.length === 0)) {
      if (p.capital >= 0) g.moveUnit(p.id, f.id, [(p.capital % g.w) + 0.5 + (g.rng() - 0.5) * 6, Math.floor(p.capital / g.w) + 0.5]);
    }
  }

  // missiles at the strongest hostile neighbour's capital
  if (g.ownedCount(p.id, "silo") && enemyIds.length && g.rng() < 0.4) {
    const target = enemyIds.map((id) => g.players[id]).sort((a, b) => b.tiles - a.tiles)[0];
    if (target && target.capital >= 0) {
      const kinds: MissileKind[] = ["mirv", "hydrogen", "atom"];
      const kind = kinds.find((k) => p.gold >= MISSILES[k].cost * 1.2) ?? "atom";
      g.launchMissile(p.id, (target.capital % g.w) + 0.5, Math.floor(target.capital / g.w) + 0.5, kind);
    }
  }
}
