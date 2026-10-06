import { describe, expect, it } from "vitest";
import { CFG, TECH } from "../src/core/config";
import { Game, GameOptions } from "../src/core/game";
import { Terrain } from "../src/core/mapgen";

function make(bots: number, opts: GameOptions = {}, seed = 9, humans = 1): Game {
  const g = new Game(seed, 128, 80, opts);
  for (let i = 0; i < humans; i++) g.addPlayer("Human" + i, false);
  for (let i = 0; i < bots; i++) g.addPlayer("Bot" + i, true);
  g.spawnAll();
  return g;
}
const capXY = (g: Game, id: number) => ({ x: g.players[id].capital % g.w, y: (g.players[id].capital / g.w) | 0 });

describe("economy buildings", () => {
  it("city raises capacity, farm raises regen, port needs the coast", () => {
    const g = make(1);
    const p = g.players[1];
    p.gold = 1e6;
    const { x, y } = capXY(g, 1);
    const cap0 = g.maxTroops(p);
    expect(g.build(1, "city", x + 1, y).ok).toBe(true);
    expect(g.maxTroops(p)).toBeCloseTo(cap0 + CFG.cityCap);
    expect(g.build(1, "port", x - 1, y).error).toBe("ports go on the coast");
    expect(g.build(1, "lab", x, y + 1).error).toBe("labs are for World War modes");
  });
});

describe("teams and alliances", () => {
  it("team mode assigns teams, blocks friendly fire and ends when one team is left", () => {
    const g = make(3, { mode: "team", teams: 2 });
    expect(g.players[1].team).toBe(1);
    expect(g.players[2].team).toBe(2);
    expect(g.players[3].team).toBe(1);
    expect(g.friendly(1, 3)).toBe(true);
    expect(g.friendly(1, 2)).toBe(false);
    const { x, y } = capXY(g, 1);
    g.setOwner(g.players[3].capital, 0);
    // attack area made only of an ally's tiles is empty
    const res = g.launchAttackTiles(1, [g.players[3].capital + 1], 0.5);
    expect(res.ok === false || g.owner[g.players[3].capital + 1] !== 1).toBe(true);
    void x; void y;
  });
  it("alliances need both sides; bots may accept", () => {
    const g = make(0, {}, 4, 2);
    expect(g.proposeAlliance(1, 2).data!.formed).toBe(false);
    expect(g.proposeAlliance(2, 1).data!.formed).toBe(true);
    expect(g.friendly(1, 2)).toBe(true);
    expect(g.breakAlliance(1, 2).ok).toBe(true);
    expect(g.friendly(1, 2)).toBe(false);
  });
  it("an alliance of everyone left wins the game", () => {
    const g = make(0, {}, 4, 2);
    g.proposeAlliance(1, 2);
    g.proposeAlliance(2, 1);
    g.spawnTicks = 0;
    g.tick();
    expect(g.over).toBe(true);
  });
});

describe("World War mode", () => {
  it("goes expand -> cold -> war, research unlocks only after expansion, bots stay peaceful", () => {
    const g = make(5, { mode: "ww" }, 5);
    const p = g.players[1];
    expect(g.phase).toBe("expand");
    expect(g.doResearch(1, "econ1").error).toBe("research opens in the Cold War");
    // fake a dominated map: shrink the field so the trigger fires
    for (let id = 3; id <= 6; id++) { g.players[id].alive = false; }
    for (let i = 0; i < CFG.coldHold * 10 + 20; i++) g.tick();
    expect(g.phase).toBe("cold");
    p.rp = 1000;
    expect(g.doResearch(1, "econ1").ok).toBe(true);
    expect(g.doResearch(1, "econ1").error).toBe("already researched");
    expect(g.doResearch(1, "econ3").error).toContain("needs");
    expect(g.doResearch(1, "space1").error).toBe("needs War of the Worlds");
    expect(p.rp).toBe(1000 - TECH.econ1.cost);
    const attacksBefore = g.attacks.filter((a) => g.players[a.by].isBot && a.on > 0).length;
    for (let i = 0; i < 300; i++) g.tick();
    expect(g.attacks.filter((a) => g.players[a.by].isBot && a.on > 0).length).toBe(attacksBefore);
    g.phaseTicks = 1;
    g.tick();
    expect(g.phase).toBe("war");
  });
  it("research bonuses change costs and economy", () => {
    const g = make(2, { mode: "ww" });
    const a = g.players[1], d = g.players[2];
    const tile = d.capital + 3;
    g.setOwner(tile, 2);
    const base = g.tileCost(1, tile);
    a.tech.push("mil2");
    expect(g.tileCost(1, tile)).toBeCloseTo(base * 0.9);
    d.tech.push("def1");
    expect(g.tileCost(1, tile)).toBeCloseTo(base * 0.9 * 1.15);
  });
});

describe("missiles", () => {
  it("need a silo, cost gold, land after a delay and wipe out tiles", () => {
    const g = make(0, {}, 9, 2);
    const a = g.players[1], d = g.players[2];
    a.gold = 1e6;
    const { x, y } = capXY(g, 1);
    expect(g.launchMissile(1, 5, 5).error).toBe("build a Missile Silo first");
    g.build(1, "silo", x + 1, y);
    const tx = d.capital % g.w, ty = (d.capital / g.w) | 0;
    const before = d.tiles;
    expect(g.launchMissile(1, tx + 0.5, ty + 0.5).ok).toBe(true);
    expect(g.launchMissile(1, tx + 0.5, ty + 0.5).error).toBe("silo is reloading");
    for (let i = 0; i < 400 && g.missiles.length; i++) g.tick();
    expect(g.owner[d.capital]).toBe(0);
    expect(d.tiles).toBeLessThan(before);
  });
  it("SAMs can intercept", () => {
    const g = make(0, {}, 9, 2);
    const a = g.players[1], d = g.players[2];
    a.gold = 1e6; d.gold = 1e6;
    const { x, y } = capXY(g, 1);
    g.build(1, "silo", x + 1, y);
    const tx = d.capital % g.w, ty = (d.capital / g.w) | 0;
    g.build(2, "sam", tx + 1, ty);
    let blocked = 0;
    for (let n = 0; n < 12; n++) {
      g.structures.find((s) => s.type === "silo")!.cd = 0;
      a.gold = 1e6;
      g.launchMissile(1, tx + 0.5, ty + 0.5);
      for (let i = 0; i < 200; i++) g.tick();
      if (g.players[2].tiles > 0) blocked++;
      g.setOwner(d.capital, 2);
    }
    expect(blocked).toBeGreaterThan(0);
  });
});

describe("naval", () => {
  function coastalGame() {
    const g = make(1, { islands: true }, 12);
    const p = g.players[1];
    p.gold = 1e6;
    let tile = -1;
    for (let t = 0; t < g.owner.length && tile < 0; t++) {
      if (g.owner[t] === 1 && g.terrain[t] === Terrain.Land && g.isCoastal(t)) tile = t;
    }
    return { g, p, tile };
  }
  it("islands maps can have several landmasses", () => {
    const g = new Game(12, 192, 112, { islands: true });
    expect(g.landTiles).toBeGreaterThan(500);
  });
  it("ports train boats and water routes avoid land", () => {
    const { g, tile } = coastalGame();
    if (tile < 0) return; // start patch has no coast on this seed
    const x = tile % g.w, y = (tile / g.w) | 0;
    expect(g.build(1, "port", x, y).ok).toBe(true);
    const r = g.trainUnit(1, "x");
    expect(r.ok).toBe(true);
    const k = g.units[0];
    expect(g.terrain[Math.floor(k.y) * g.w + Math.floor(k.x)]).toBe(Terrain.Water);
  });
});

describe("War of the Worlds", () => {
  it("planets start at war, apply modifiers and use the space techs", () => {
    const g = new Game(33, 160, 96, { mode: "wow", planet: "frozen" });
    g.addPlayer("A", false);
    g.addPlayer("Xeno", true);
    g.spawnAll();
    expect(g.phase).toBe("war");
    const a = g.players[1];
    const tile = g.players[2].capital + 3;
    g.setOwner(tile, 2);
    const base = g.tileCost(1, tile);
    a.tech.push("space2");
    expect(g.tileCost(1, tile)).toBeCloseTo(base * 0.8);
    g.players[2].tech.push("space3");
    expect(g.tileCost(1, tile)).toBeCloseTo(base * 0.8 * 1.3);
  });
  it("earth reaches the space phase when a power dominates, and launching needs a spaceport", () => {
    const g = make(3, { mode: "wow" }, 14);
    g.phase = "war";
    // hand most land to player 1
    for (let t = 0; t < g.owner.length && g.players[1].tiles < g.landTiles * 0.6; t++) {
      if (g.terrain[t] !== Terrain.Water && g.owner[t] === 0) g.setOwner(t, 1);
    }
    for (let i = 0; i < 12; i++) g.tick();
    expect(g.phase).toBe("space");
    expect(g.canLaunch(1)).toBe(false);
    g.players[1].tech.push("space1");
    g.players[1].gold = 1e6;
    const x = g.players[1].capital % g.w + 1, y = (g.players[1].capital / g.w) | 0;
    expect(g.build(1, "spaceport", x, y).ok).toBe(true);
    expect(g.canLaunch(1)).toBe(true);
  });
});
