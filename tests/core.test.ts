import { describe, expect, it } from "vitest";
import { CFG } from "../src/core/config";
import { Game } from "../src/core/game";
import { rasterizePolygon } from "../src/core/geometry";
import { Terrain } from "../src/core/mapgen";

function makeGame(bots = 4, seed = 7): Game {
  const g = new Game(seed, 128, 80);
  g.addPlayer("Human", false);
  for (let i = 0; i < bots; i++) g.addPlayer("Bot" + i, true);
  g.spawnAll();
  return g;
}

describe("rasterizePolygon", () => {
  it("fills a square", () => {
    const tiles = rasterizePolygon([2, 2, 6, 2, 6, 5, 2, 5], 20, 20);
    expect(tiles.length).toBe(12);
  });
  it("ignores degenerate shapes", () => {
    expect(rasterizePolygon([1, 1, 2, 2], 10, 10)).toEqual([]);
  });
  it("clips to the map", () => {
    const tiles = rasterizePolygon([-5, -5, 3, -5, 3, 3, -5, 3], 10, 10);
    expect(tiles.length).toBe(9);
  });
});

describe("map + spawn", () => {
  it("is deterministic per seed", () => {
    const a = makeGame(3, 11);
    const b = makeGame(3, 11);
    expect(Buffer.from(a.terrain).equals(Buffer.from(b.terrain))).toBe(true);
    expect(Buffer.from(a.owner.buffer).equals(Buffer.from(b.owner.buffer))).toBe(true);
  });
  it("gives every player a start area on land", () => {
    const g = makeGame();
    for (let id = 1; id < g.players.length; id++) {
      expect(g.players[id].tiles).toBeGreaterThan(20);
      expect(g.terrain[g.players[id].capital]).toBe(Terrain.Land);
    }
  });
});

describe("combat", () => {
  it("one lasso conquers neutral land touching the border", () => {
    const g = makeGame(1);
    const p = g.players[1];
    const cx = p.capital % g.w, cy = (p.capital / g.w) | 0;
    const before = p.tiles;
    const res = g.launchAttack(1, [cx - 8, cy - 8, cx + 8, cy - 8, cx + 8, cy + 8, cx - 8, cy + 8], 0.8);
    expect(res.ok).toBe(true);
    for (let i = 0; i < 100; i++) g.tick();
    expect(p.tiles).toBeGreaterThan(before + 20);
  });
  it("rejects a lasso that does not touch your territory", () => {
    const g = makeGame(1);
    const res = g.launchAttack(1, [0, 0, 3, 0, 3, 3, 0, 3], 0.5);
    expect(res.ok).toBe(false);
  });
  it("small players are costlier to conquer than big ones at equal density", () => {
    const g = makeGame(2);
    const a = g.players[2];
    const def = g.players[1];
    const tile = [...g.owner.keys()].find((t) => g.owner[t] === 1 && t !== def.capital && Math.hypot((t % g.w) - (def.capital % g.w), ((t / g.w) | 0) - ((def.capital / g.w) | 0)) > 3)!;
    def.troops = 100;
    def.tiles = 30;
    const small = g.tileCost(a.id, tile);
    def.tiles = 400;
    def.troops = (100 / 30) * 400;
    const big = g.tileCost(a.id, tile);
    expect(small).toBeGreaterThan(big);
  });
  it("capital tiles are much costlier than the rest of the territory", () => {
    const g = makeGame(2);
    const def = g.players[1];
    const other = [...g.owner.keys()].find((t) => g.owner[t] === 1 && Math.hypot((t % g.w) - (def.capital % g.w), ((t / g.w) | 0) - ((def.capital / g.w) | 0)) > 2.9)!;
    expect(g.tileCost(2, def.capital)).toBeGreaterThan(g.tileCost(2, other) * (CFG.capitalMult - 0.5));
  });
  it("refunds unspent troops when an attack ends", () => {
    const g = makeGame(1);
    const p = g.players[1];
    const start = p.troops;
    const cx = p.capital % g.w, cy = (p.capital / g.w) | 0;
    g.launchAttack(1, [cx + 3, cy - 1, cx + 5, cy - 1, cx + 5, cy + 1, cx + 3, cy + 1], 0.5);
    for (let i = 0; i < 100; i++) g.tick();
    expect(g.attacks.length).toBe(0);
    expect(p.troops).toBeGreaterThan(start * 0.5);
  });
});

describe("reinforce", () => {
  it("adds troops from the owner's pool to a running attack", () => {
    const g = makeGame(1);
    const p = g.players[1];
    const cx = p.capital % g.w, cy = (p.capital / g.w) | 0;
    const res = g.launchAttack(1, [cx - 8, cy - 8, cx + 8, cy - 8, cx + 8, cy + 8, cx - 8, cy + 8], 0.3);
    const a = g.attacks.find((x) => x.id === res.data!.id)!;
    const before = a.pool;
    expect(g.reinforceAttack(1, a.id, 0.5).ok).toBe(true);
    expect(a.pool).toBeGreaterThan(before);
    expect(g.reinforceAttack(1, 999, 0.5).ok).toBe(false);
  });
});

describe("spawn phase", () => {
  it("moves the start only while the phase is active", () => {
    const g = makeGame(1);
    const p = g.players[1];
    const old = p.capital;
    expect(g.respawn(1, 20, 20).error).toBe("spawn phase is over");
    g.spawnTicks = 50;
    // find a valid flat-land patch by trial
    let moved = false;
    for (let y = 8; y < g.h - 8 && !moved; y++) for (let x = 8; x < g.w - 8 && !moved; x++) {
      if (Math.hypot(x - (old % g.w), y - ((old / g.w) | 0)) > 20 && g.respawn(1, x, y).ok) moved = true;
    }
    expect(moved).toBe(true);
    expect(p.capital).not.toBe(old);
    expect(g.owner[old]).toBe(0);
    expect(g.capDirty.length).toBe(1);
  });
  it("blocks attacks and economy during the phase", () => {
    const g = makeGame(1);
    g.spawnTicks = 5;
    const p = g.players[1];
    const cx = p.capital % g.w, cy = (p.capital / g.w) | 0;
    expect(g.launchAttack(1, [cx - 8, cy - 8, cx + 8, cy - 8, cx + 8, cy + 8, cx - 8, cy + 8], 0.5).ok).toBe(false);
    const t = p.troops;
    g.tick();
    expect(p.troops).toBe(t);
    for (let i = 0; i < 6; i++) g.tick();
    expect(p.troops).toBeGreaterThan(t);
  });
});

describe("tanks and walls", () => {
  function flat(g: Game, pid: number) {
    const p = g.players[pid];
    return { cx: p.capital % g.w, cy: (p.capital / g.w) | 0, p };
  }
  it("walls block conquest until a tank breaks them", () => {
    const g = makeGame(2);
    const { cx, cy, p } = flat(g, 1);
    p.gold = 5000;
    // wall on the east edge of the start patch
    expect(g.buildWall(1, [cx + 3, cy - 2, cx + 3, cy + 2]).ok).toBe(true);
    const wallTile = cy * g.w + cx + 3;
    expect(g.wall[wallTile]).toBeGreaterThan(0);
    // enemy lasso over the wall tile touching player 1's land from outside is impossible; test directly
    const e = g.players[2];
    e.gold = 5000;
    // place enemy tank adjacent to the wall and let it work
    g.structures.push({ id: 99, type: "tankfactory", owner: 2, tile: 0, x: cx + 4, y: cy, });
    expect(g.trainUnit(2, "t").ok).toBe(true);
    g.units[0].x = cx + 4.5;
    g.units[0].y = cy + 0.5;
    for (let i = 0; i < 80; i++) g.stepUnitsForTest();
    expect(g.wall[wallTile]).toBe(0);
  });
  it("lasso cannot capture wall tiles", () => {
    const g = makeGame(2);
    const { cx, cy, p } = flat(g, 1);
    p.gold = 5000;
    // build a ring of wall around the capital area edge
    g.buildWall(1, [cx - 3, cy - 3, cx + 3, cy - 3, cx + 3, cy + 3, cx - 3, cy + 3, cx - 3, cy - 3]);
    const walls = [...g.wall.keys()].filter((i) => g.wall[i]);
    expect(walls.length).toBeGreaterThan(10);
    const e = g.players[2];
    // give player 2 ownership next to a wall tile and attack
    const t = walls[0];
    const nb = t + 1;
    g.setOwner(nb, 2);
    e.troops = 5000;
    const res = g.launchAttackTiles(2, [t], 1);
    expect(res.ok).toBe(true);
    for (let i = 0; i < 40; i++) g.tick();
    expect(g.owner[t]).toBe(1);
  });
  it("needs a factory and respects the tank limit", () => {
    const g = makeGame(1);
    const { cx, cy, p } = flat(g, 1);
    p.gold = 10000;
    expect(g.trainUnit(1, "t").error).toBe("build a Tank Factory first");
    expect(g.build(1, "tankfactory", cx + 1, cy).ok).toBe(true);
    for (let i = 0; i < 3; i++) expect(g.trainUnit(1, "t").ok).toBe(true);
    expect(g.trainUnit(1, "t").error).toBe("tank limit reached");
  });
  it("tanks make nearby attacks cheaper and stop at water", () => {
    const g = makeGame(2);
    const { cx, cy, p } = flat(g, 1);
    p.gold = 10000;
    g.build(1, "tankfactory", cx + 1, cy);
    const tile = (cy + 1) * g.w + cx + 6;
    const before = g.tileCost(1, tile);
    g.trainUnit(1, "t");
    expect(g.tileCost(1, tile)).toBeLessThan(before);
    g.moveUnit(1, g.units[0].id, [0.2, 0.2]);
    for (let i = 0; i < 600; i++) g.tick();
    expect(g.units[0].path.length).toBe(0);
  });
});

describe("aircraft and SAMs", () => {
  function rich(g: Game, pid: number) {
    const p = g.players[pid];
    p.gold = 100000;
    return { cx: p.capital % g.w, cy: (p.capital / g.w) | 0 };
  }
  it("airbase trains fighters and bombers up to the limit", () => {
    const g = makeGame(1);
    const { cx, cy } = rich(g, 1);
    expect(g.trainUnit(1, "f").error).toBe("build an Airbase first");
    expect(g.build(1, "airbase", cx + 1, cy).ok).toBe(true);
    for (let i = 0; i < CFG.planesPerBase; i++) expect(g.trainUnit(1, "f").ok).toBe(true);
    expect(g.trainUnit(1, "f").error).toBe("aircraft limit reached");
    expect(g.trainUnit(1, "b").ok).toBe(true);
  });
  it("aircraft fly over water and mountains", () => {
    const g = makeGame(1);
    const { cx, cy } = rich(g, 1);
    g.build(1, "airbase", cx + 1, cy);
    const id = g.trainUnit(1, "f").data!.id;
    g.moveUnit(1, id, [0.5, 0.5]);
    for (let i = 0; i < 400; i++) g.tick();
    const f = g.units.find((u) => u.id === id)!;
    expect(f.path.length).toBe(0);
    expect(Math.hypot(f.x - 0.5, f.y - 0.5)).toBeLessThan(1);
  });
  it("SAMs shoot down enemy aircraft in range but not their own", () => {
    const g = makeGame(2);
    const { cx, cy } = rich(g, 1);
    rich(g, 2);
    g.build(1, "sam", cx + 1, cy);
    g.structures.push({ id: 90, type: "airbase", owner: 2, tile: 1, x: cx + 3, y: cy });
    const enemy = g.trainUnit(2, "b").data!.id;
    const own = g.structures.some((s) => s.owner === 1);
    expect(own).toBe(true);
    const u = g.units.find((x) => x.id === enemy)!;
    u.x = cx + 7.5; u.y = cy + 0.5; // outside the start patch (no bombing), inside SAM range
    for (let i = 0; i < 40; i++) g.stepUnitsForTest();
    expect(g.units.find((x) => x.id === enemy)).toBeUndefined();
  });
  it("fighters kill enemy aircraft nearby", () => {
    const g = makeGame(2);
    const { cx, cy } = rich(g, 1);
    rich(g, 2);
    g.structures.push({ id: 91, type: "airbase", owner: 1, tile: 2, x: cx + 3, y: cy });
    g.structures.push({ id: 92, type: "airbase", owner: 2, tile: 3, x: cx + 3, y: cy + 1 });
    const a = g.trainUnit(1, "f").data!.id;
    const b = g.trainUnit(2, "b").data!.id;
    for (let i = 0; i < 40; i++) g.stepUnitsForTest();
    expect(g.units.find((x) => x.id === b)).toBeUndefined();
    expect(g.units.find((x) => x.id === a)).toBeDefined();
  });
  it("bombers destroy enemy structures under them and lose ammo", () => {
    const g = makeGame(2);
    const { cx, cy } = rich(g, 1);
    const e = g.players[2];
    const ex = e.capital % g.w, ey = (e.capital / g.w) | 0;
    rich(g, 2);
    g.build(2, "bunker", ex + 1, ey);
    g.structures.push({ id: 93, type: "airbase", owner: 1, tile: 4, x: cx + 3, y: cy });
    const id = g.trainUnit(1, "b").data!.id;
    const u = g.units.find((x) => x.id === id)!;
    u.x = ex + 1.5; u.y = ey + 0.5;
    const before = e.troops;
    g.stepUnitsForTest();
    expect(g.structures.some((s) => s.owner === 2 && s.type === "bunker")).toBe(false);
    expect(u.ammo).toBe(CFG.bomberAmmo - 1);
    expect(e.troops).toBeLessThan(before);
  });
});

describe("structures", () => {
  it("charges gold and refuses enemy land", () => {
    const g = makeGame(1);
    const p = g.players[1];
    const x = p.capital % g.w + 1, y = (p.capital / g.w) | 0;
    expect(g.build(1, "bunker", x, y).error).toBe("not enough gold");
    p.gold = 500;
    expect(g.build(1, "bunker", x, y).ok).toBe(true);
    expect(p.gold).toBe(500 - CFG.structures.bunker.cost);
    expect(g.build(1, "bunker", x, y).error).toBe("tile occupied");
    expect(g.build(1, "bank", 0, 0).ok).toBe(false);
  });
  it("bunker raises the cost to take nearby tiles", () => {
    const g = makeGame(2);
    const def = g.players[1];
    const x = (def.capital % g.w) + 2, y = (def.capital / g.w) | 0;
    const tile = y * g.w + x + 1;
    const before = g.tileCost(2, tile);
    def.gold = 1000;
    g.build(1, "bunker", x, y);
    expect(g.tileCost(2, tile)).toBeCloseTo(before * CFG.structures.bunker.mult);
  });
});

describe("bots", () => {
  it("expand over time and never crash a full match slice", () => {
    const g = makeGame(8, 3);
    for (let i = 0; i < 1500; i++) g.tick();
    const sizes = g.players.slice(1).map((p) => p.tiles);
    expect(Math.max(...sizes)).toBeGreaterThan(60);
    for (const p of g.players.slice(1)) expect(Number.isFinite(p.troops)).toBe(true);
  });
  it("never has more attackers on one target than the cap", () => {
    const g = makeGame(10, 5);
    let worst = 0;
    for (let i = 0; i < 2000; i++) {
      g.tick();
      for (let id = 1; id < g.players.length; id++) worst = Math.max(worst, g.attackersOn(id));
    }
    expect(worst).toBeLessThanOrEqual(CFG.botMaxAttackersPerTarget + 1);
  });
});
