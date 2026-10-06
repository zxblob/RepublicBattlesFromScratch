import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import type { ClientMsg } from "../core/protocol";
import { Room, RoomManager } from "./rooms";

const PORT = Number(process.env.PORT ?? 3000);
const HERE = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC = resolve(process.env.PUBLIC_DIR ?? join(HERE, "public"));

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".ico": "image/x-icon",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/healthz") { res.writeHead(200); res.end("ok"); return; }
  let rel = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, "");
  if (rel === "" || rel.endsWith("/")) rel += "index.html";
  const file = resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); res.end(); return; }
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "cache-control": [".html", ".js", ".css"].includes(extname(file)) ? "no-cache" : "public, max-age=3600",
    });
    res.end(data);
  } catch {
    res.writeHead(404); res.end("not found");
  }
});

const rooms = new RoomManager();
const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

server.on("upgrade", (req, socket, head) => {
  const path = new URL(req.url ?? "/", "http://x").pathname;
  if (!path.endsWith("/ws")) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws));
});

function onConnection(ws: WebSocket): void {
  let room: Room | null = null;
  let token = "";
  (ws as WebSocket & { alive?: boolean }).alive = true;
  ws.on("pong", () => ((ws as WebSocket & { alive?: boolean }).alive = true));

  const err = (msg: string) => ws.send(JSON.stringify({ t: "error", msg }));
  const enter = (r: Room, name: string, tok?: string) => {
    room = r;
    const c = r.addClient(ws, name, tok);
    token = c.token;
    ws.send(JSON.stringify({ t: "joined", code: r.code, token: c.token, host: c.token === r.hostToken }));
    if (r.game) r.sendStart(c);
    else r.broadcastLobby();
  };

  ws.on("message", (raw) => {
    let msg: ClientMsg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (!msg || typeof msg.t !== "string") return;
    try {
      switch (msg.t) {
        case "solo": {
          const r = rooms.create();
          enter(r, msg.name);
          const e = r.start(msg.bots);
          if (e) err(e);
          return;
        }
        case "create": enter(rooms.create(), msg.name); return;
        case "join": {
          const r = rooms.get(msg.code);
          if (!r) return err("no such lobby");
          if (r.game && !(msg.token && r.clients.has(msg.token))) return err("game already started");
          enter(r, msg.name, msg.token);
          return;
        }
        case "rejoin": {
          const r = rooms.get(msg.code);
          if (!r || !r.clients.has(msg.token)) return err("session expired");
          enter(r, "", msg.token);
          return;
        }
        case "leave":
          if (room) room.detach(token);
          room = null;
          return;
        default: {
          const c = room?.clients.get(token);
          if (room && c) room.handle(c, msg);
        }
      }
    } catch (e) {
      console.error("handler error", e);
    }
  });
  ws.on("close", () => { if (room) room.detach(token); });
}

setInterval(() => {
  for (const ws of wss.clients as Set<WebSocket & { alive?: boolean }>) {
    if (ws.alive === false) { ws.terminate(); continue; }
    ws.alive = false;
    ws.ping();
  }
}, 20_000).unref();

server.listen(PORT, () => console.log(`Republic Battles listening on :${PORT}`));
