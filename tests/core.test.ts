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
