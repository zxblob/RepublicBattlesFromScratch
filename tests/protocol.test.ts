import { describe, expect, it } from "vitest";
import { rle, unrle } from "../src/core/protocol";

describe("rle", () => {
  it("round-trips an owner grid", () => {
    const grid = Uint16Array.from([0, 0, 0, 1, 1, 2, 0, 0, 3, 3, 3, 3]);
    const out = new Uint16Array(grid.length);
    unrle(rle(grid), out);
    expect([...out]).toEqual([...grid]);
  });
});
