import { describe, expect, it } from "vitest";
import { Game } from "../src/core/game";

describe("snapshots", () => {
  it("restore + continue equals uninterrupted play", () => {
    const build = () => {
      const g = new Game(21, 128, 80, { mode: "ww" });
      for (let i = 0; i < 6; i++) g.addPlayer("B" + i, true);
      g.spawnAll();
      return g;
    };
    const a = build();
    for (let i = 0; i < 600; i++) a.tick();
    const snap = JSON.parse(JSON.stringify(a.exportState()));
    const b = Game.restore(snap);
    for (let i = 0; i < 400; i++) { a.tick(); b.tick(); }
    expect(Buffer.from(b.owner.buffer).equals(Buffer.from(a.owner.buffer))).toBe(true);
    expect(b.players.slice(1).map((p) => Math.round(p.troops))).toEqual(a.players.slice(1).map((p) => Math.round(p.troops)));
    expect(b.tickNo).toBe(a.tickNo);
  });
});
