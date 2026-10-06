import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ServerMsg } from "../src/core/protocol";

const tmp = mkdtempSync(join(tmpdir(), "rb-test-"));
process.env.SAVE_DIR = join(tmp, "saves");
process.env.MAPS_DIR = join(tmp, "maps");
process.env.PREMADE_DIR = join(process.cwd(), "maps/premade");

const { Room, RoomManager, defaultSetup } = await import("../src/server/rooms");
const { validateMap, saveMap, loadMap } = await import("../src/server/maps");

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function mockWs() {
  const sent: ServerMsg[] = [];
  const ws = { readyState: 1, send: (s: string) => sent.push(JSON.parse(s)), close() { ws.readyState = 3; } };
  return { ws: ws as never, sent };
}
const last = <T extends ServerMsg["t"]>(sent: ServerMsg[], t: T) =>
  [...sent].reverse().find((m) => m.t === t) as Extract<ServerMsg, { t: T }> | undefined;

describe("rooms", () => {
  it("only the host can start; start sends the map and a spawn phase", async () => {
    const r = new Room("TEST1");
    const a = mockWs(), b = mockWs();
    const ca = r.addClient(a.ws, "Alice");
    const cb = r.addClient(b.ws, "Bob");
    r.handle(cb, { t: "start", setup: defaultSetup() });
    await new Promise((x) => setTimeout(x, 20));
    expect(last(b.sent, "error")?.msg).toBe("only the host can start");
    expect(await r.start({ ...defaultSetup(), bots: 3 })).toBeNull();
    const st = last(a.sent, "start")!;
    expect(st.w).toBe(192);
    expect(st.players.length).toBe(5);
    expect(st.sp).toBeGreaterThan(0);
    expect(st.you).toBe(ca.playerId);
    expect(last(b.sent, "start")!.you).toBe(cb.playerId);
    r.stop();
  });

  it("validates attack input and rate limits chat", async () => {
    const r = new Room("TEST2");
    const a = mockWs();
    const c = r.addClient(a.ws, "Alice");
    await r.start({ ...defaultSetup(), bots: 2 });
    r.game!.spawnTicks = 0;
    r.handle(c, { t: "attack", poly: [0, 0, 1, 1] as number[], ratio: 0.5 });
    expect(last(a.sent, "error")?.msg).toBe("bad shape");
    r.handle(c, { t: "chat", id: 3 });
    r.handle(c, { t: "chat", id: 4 });
    expect(a.sent.filter((m) => m.t === "chat").length).toBe(1);
    r.handle(c, { t: "chat", id: 999 });
    r.stop();
  });

  it("saves a running game and restores it paused with the same members", async () => {
    const mgr = new RoomManager();
    const r = mgr.create();
    const a = mockWs();
    const c = r.addClient(a.ws, "Alice");
    await r.start({ ...defaultSetup(), mode: "ww", bots: 4 });
    for (let i = 0; i < 50; i++) r.game!.tick();
    const tick = r.game!.tickNo;
    await r.save();
    r.stop();
    mgr.rooms.delete(r.code);
    const back = await mgr.get(r.code);
    expect(back).toBeDefined();
    expect(back!.paused).toBe(true);
    expect(back!.game!.tickNo).toBe(tick);
    expect(back!.game!.mode).toBe("ww");
    expect(back!.clients.get(c.token)?.name).toBe("Alice");
    expect(back!.hostToken).toBe(c.token);
    back!.stop();
  });

  it("rejects unknown map codes and starts premade maps with country names", async () => {
    const r = new Room("TEST4");
    r.addClient(mockWs().ws, "Alice");
    expect(await r.start({ ...defaultSetup(), map: "NOSUCHMAP" })).toBe("unknown map code");
    const r2 = new Room("TEST5");
    const m = mockWs();
    r2.addClient(m.ws, "Alice");
    expect(await r2.start({ ...defaultSetup(), map: "EUROPE", bots: 4 })).toBeNull();
    const names = last(m.sent, "start")!.players.map((p) => p.name);
    expect(names).toContain("France");
    r2.stop();
  });
});

describe("custom maps", () => {
  const good = { name: "T", w: 96, h: 64, rle: [0, 96 * 20, 1, 96 * 30, 2, 96 * 4, 0, 96 * 10] };
  it("validates size, run totals and land amount", () => {
    expect(typeof validateMap(good)).toBe("object");
    expect(validateMap({ ...good, w: 10 })).toMatch(/between/);
    expect(validateMap({ ...good, rle: [0, 5] })).toMatch(/does not match/);
    expect(validateMap({ ...good, rle: [0, 96 * 64] })).toMatch(/400 land/);
    expect(validateMap({ ...good, rle: [9, 96 * 64] })).toMatch(/bad map data/);
  });
  it("round-trips through disk", async () => {
    const v = validateMap(good);
    if (typeof v === "string") throw new Error(v);
    const code = await saveMap(v.map);
    const back = await loadMap(code);
    expect(back?.map.w).toBe(96);
    expect(await loadMap("ZZZZZZ")).toBeNull();
  });
});
