import { describe, expect, it } from "vitest";
import { DIFFICULTY } from "../src/core/config";
import type { Difficulty } from "../src/core/config";
import { Game } from "../src/core/game";
import { MAP_SIZES, MAX_BOTS } from "../src/core/protocol";

function make(difficulty: Difficulty, bots = 4): Game {
  const g = new Game(7, 192, 112, { difficulty });
  g.addPlayer("Human", false);
  for (let i = 0; i < bots; i++) g.addPlayer("Bot" + i, true);
  g.spawnAll();
  g.spawnTicks = 0;
  return g;
}

describe("difficulty", () => {
  it("defaults to easy and survives a snapshot", () => {
    expect(new Game(1, 64, 48).difficulty).toBe("easy");
    const g = make("hard");
    expect(Game.restore(JSON.parse(JSON.stringify(g.exportState()))).difficulty).toBe("hard");
  });

  it("makes bot land costlier for humans on harder levels, and never changes neutral land", () => {
    const cost = (d: Difficulty) => {
      const g = make(d);
      const bot = g.players[2];
      const botTile = bot.capital + 3;
      g.setOwner(botTile, 2);
      return { player: g.tileCost(1, botTile), neutral: g.tileCost(1, g.owner.findIndex((o, i) => o === 0 && g.terrain[i] === 1)) };
    };
    const easy = cost("easy"), hard = cost("hard"), imp = cost("impossible");
    expect(hard.player).toBeGreaterThan(easy.player * 1.5);
    expect(imp.player).toBeGreaterThan(hard.player);
    expect(hard.neutral).toBe(easy.neutral);
  });

  it("bot economies grow faster on harder levels, human economy does not", () => {
    const run = (d: Difficulty) => {
      const g = make(d);
      for (let i = 0; i < 200; i++) g.tick();
      return { bot: g.players[2].gold, human: g.players[1].gold };
    };
    const e = run("easy"), i = run("impossible");
    expect(i.bot).toBeGreaterThan(e.bot * 1.5);
    expect(i.human).toBeCloseTo(e.human, 5);
  });

  it("has a full table for every level", () => {
    for (const d of Object.values(DIFFICULTY)) expect(d.ratioPlayer).toBeGreaterThan(0);
  });

  it("fits a crowded huge world (hundreds of nations)", () => {
    const [w, h] = MAP_SIZES.huge;
    const g = new Game(3, w, h, { difficulty: "hard" });
    g.addPlayer("Human", false);
    for (let i = 0; i < MAX_BOTS.huge; i++) g.addPlayer("B" + i, true);
    g.spawnAll();
    g.spawnTicks = 0;
    for (let i = 0; i < 300; i++) g.tick();
    expect(g.players.filter((p) => p && p.alive).length).toBe(MAX_BOTS.huge + 1);
  });
});
