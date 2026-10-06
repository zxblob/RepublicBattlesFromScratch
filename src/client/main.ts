import { CFG, STRUCT_TYPES, StructType } from "../core/config";
import type { ServerMsg } from "../core/protocol";
import { Input } from "./input";
import { loadSession, Net, saveSession } from "./net";
import { Overlay, Renderer } from "./render";
import { fmt } from "./format";
import { ClientGame } from "./state";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const net = new Net();
let game: ClientGame | null = null;
let isHost = false;
let drawMode = false;
let buildType: StructType | null = null;
let hoverBuildBtn: StructType | null = null;
let lastToast = "";
let started = false;

const nameEl = $<HTMLInputElement>("name");
nameEl.value = (() => { try { return localStorage.getItem("rb.name") ?? ""; } catch { return ""; } })();
const myName = () => {
  const n = nameEl.value.trim();
  try { localStorage.setItem("rb.name", n); } catch { /* ignore */ }
  return n;
};

function show(screen: "menu" | "lobby" | "game"): void {
  $("menu").classList.toggle("hidden", screen !== "menu");
  $("lobby").classList.toggle("hidden", screen !== "lobby");
  $("game").classList.toggle("hidden", screen !== "game");
  if (screen === "game") { renderer.resize(); }
}

function toast(text: string, ms = 3200): void {
  if (!text) return;
  const el = document.createElement("div");
  el.textContent = text;
  $("toast").appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// ---- menu --------------------------------------------------------------------------------------
const botsEl = $<HTMLInputElement>("bots");
botsEl.oninput = () => ($("bot-count").textContent = botsEl.value);
$("solo").onclick = () => { $("menu-msg").textContent = ""; net.send({ t: "solo", name: myName(), bots: Number(botsEl.value) }); };
$("create").onclick = () => { $("menu-msg").textContent = ""; net.send({ t: "create", name: myName() }); };
$("join").onclick = () => {
  const code = $<HTMLInputElement>("code").value.trim();
  if (code.length < 4) { $("menu-msg").textContent = "Enter the lobby code"; return; }
  net.send({ t: "join", code, name: myName() });
};
$("code").addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") $("join").click(); });

// ---- lobby -------------------------------------------------------------------------------------
const lobbyBots = $<HTMLInputElement>("lobby-bots");
lobbyBots.oninput = () => ($("lobby-bot-count").textContent = lobbyBots.value);
$("start").onclick = () => net.send({ t: "start", bots: Number(lobbyBots.value) });
function leave(): void {
  net.send({ t: "leave" });
  saveSession(null);
  game = null;
  started = false;
  show("menu");
}
$("lobby-leave").onclick = leave;
// two-tap confirm (window.confirm is blocked in embedded browsers and some mobile webviews)
let quitArmed = 0;
$("quit").onclick = () => {
  if (quitArmed && Date.now() - quitArmed < 3000) { quitArmed = 0; $("quit").textContent = "✕"; leave(); return; }
  quitArmed = Date.now();
  $("quit").textContent = "Leave?";
  setTimeout(() => { if (quitArmed && Date.now() - quitArmed >= 3000) { quitArmed = 0; $("quit").textContent = "✕"; } }, 3100);
};
$("over-ok").onclick = () => { $("over").classList.add("hidden"); leave(); };

// ---- game UI -----------------------------------------------------------------------------------
const canvas = $<HTMLCanvasElement>("c");
const renderer = new Renderer(canvas);
const ov: Overlay = { lasso: [], ghosts: [], hover: null, buildType: null, ringAt: null, selTank: 0, wallDraft: false };

const ratioEl = $<HTMLInputElement>("ratio");
ratioEl.oninput = () => ($("ratio-val").textContent = ratioEl.value + "%");
$("draw").onclick = () => { drawMode = !drawMode; $("draw").classList.toggle("on", drawMode); };
$("home").onclick = () => { const p = game?.players.get(game.you); if (p && game) renderer.centerOn(p.cap, 7); };
$("ready").onclick = () => { net.send({ t: "ready" }); $("ready").textContent = "Waiting…"; };
$("wall").onclick = () => {
  ov.wallDraft = !ov.wallDraft;
  ov.selTank = 0;
  buildType = null;
  $("wall").classList.toggle("on", ov.wallDraft);
  if (ov.wallDraft) toast("Draw a line on your own land to build a wall");
};
$("train").onclick = () => net.send({ t: "train" });
$("pause").onclick = () => net.send({ t: "pause" });
$("cancel").onclick = () => { for (const a of game?.attacks ?? []) if (a.by === game!.you) net.send({ t: "cancel", id: a.id }); };

const buildsEl = $("builds");
const buildBtns = new Map<StructType, HTMLButtonElement>();
for (const type of STRUCT_TYPES) {
  const b = document.createElement("button");
  b.innerHTML = `${CFG.structures[type].label}<small></small>`;
  b.title = CFG.structures[type].desc;
  b.onclick = () => {
    buildType = buildType === type ? null : type;
    ov.wallDraft = false;
    $("wall").classList.remove("on");
    ov.selTank = 0;
    refreshBuilds();
    if (buildType) toast(`${CFG.structures[type].label}: ${CFG.structures[type].desc}. Tap your land to place.`);
  };
  b.onpointerenter = (e) => { if (e.pointerType === "mouse") hoverBuildBtn = type; };
  b.onpointerleave = () => (hoverBuildBtn = null);
  buildBtns.set(type, b);
  buildsEl.appendChild(b);
}
function refreshBuilds(): void {
  for (const [type, b] of buildBtns) {
    b.classList.toggle("on", buildType === type);
    const cost = game?.structCost(type) ?? 0;
    setText(b.querySelector("small") as HTMLElement, `${fmt(cost)} gold`);
    b.classList.toggle("poor", !!game && game.me().gold < cost);
  }
}

const input = new Input(canvas, renderer, {
  drawMode: () => drawMode,
  onLasso(poly, pressure) {
    if (!game || !game.me().alive) return;
    const rounded = poly.map((n) => Math.round(n * 100) / 100);
    if (ov.wallDraft) { net.send({ t: "wall", pts: rounded }); ov.wallDraft = false; $("wall").classList.remove("on"); return; }
    if (ov.selTank) { net.send({ t: "move", id: ov.selTank, pts: rounded }); return; }
    if (poly.length < 6) return; // an attack area needs at least 3 points
    let ratio = Number(ratioEl.value) / 100;
    if (pressure !== null) ratio = Math.min(1, ratio * Math.max(0.3, Math.min(1.6, 0.4 + 1.2 * pressure)));
    net.send({ t: "attack", poly: poly.map((n) => Math.round(n * 100) / 100), ratio });
    ov.ghosts.push({ pts: poly, born: performance.now() });
    if (ov.ghosts.length > 6) ov.ghosts.shift();
  },
  onTap(wx, wy) {
    if (!game) return;
    if (game.sp > 0) { net.send({ t: "spawn", x: Math.floor(wx), y: Math.floor(wy) }); return; }
    // tanks: tap one of yours to select, tap elsewhere to send it there
    const near = game.units.find((u) => u.owner === game!.you && Math.hypot(u.x - wx, u.y - wy) * renderer.cam.zoom < 22);
    if (near) { ov.selTank = ov.selTank === near.id ? 0 : near.id; if (ov.selTank) toast("Tank selected: draw its route, or tap a spot"); return; }
    if (ov.selTank && !buildType) { net.send({ t: "move", id: ov.selTank, pts: [wx, wy] }); return; }
    if (!buildType && openAttackMenu(wx, wy)) return;
    closeAttackMenu();
    if (!buildType) return;
    net.send({ t: "build", type: buildType, x: Math.floor(wx), y: Math.floor(wy) });
    buildType = null;
    refreshBuilds();
  },
});

// ---- attack marker menu: reinforce or retreat ----
let menuAttack = 0;
function closeAttackMenu(): void { menuAttack = 0; $("attack-menu").classList.add("hidden"); }
function openAttackMenu(wx: number, wy: number): boolean {
  if (!game) return false;
  const z = renderer.cam.zoom;
  let best: (typeof game.attacks)[number] | null = null, bd = 28 / z;
  for (const a of game.attacks) {
    if (a.by !== game.you || a.x === undefined || a.y === undefined) continue;
    const d = Math.hypot(a.x - wx, a.y - wy);
    if (d < bd) { bd = d; best = a; }
  }
  if (!best) return false;
  menuAttack = best.id;
  const m = $("attack-menu");
  const sx = renderer.cw / 2 + (best.x! - renderer.cam.x) * z;
  const sy = renderer.ch / 2 + (best.y! - renderer.cam.y) * z;
  m.style.left = Math.max(120, Math.min(renderer.cw - 120, sx)) + "px";
  m.style.top = Math.max(60, Math.min(renderer.ch - 190, sy)) + "px";
  $("am-title").textContent = `Attack · ${fmt(best.pool ?? 0)} troops`;
  m.classList.remove("hidden");
  return true;
}
for (const b of document.querySelectorAll<HTMLButtonElement>("#attack-menu [data-r]")) {
  b.onclick = () => { net.send({ t: "reinforce", id: menuAttack, ratio: Number(b.dataset.r) }); closeAttackMenu(); };
}
$("am-retreat").onclick = () => { net.send({ t: "cancel", id: menuAttack }); closeAttackMenu(); };
$("am-close").onclick = closeAttackMenu;

window.addEventListener("resize", () => { if (game) { renderer.resize(); forceDraw = true; } });

const lastText = new WeakMap<HTMLElement, string>();
function setText(el: HTMLElement, s: string): void {
  if (lastText.get(el) !== s) { lastText.set(el, s); el.textContent = s; }
}
const lastHtml = new WeakMap<HTMLElement, string>();
function setHtml(el: HTMLElement, s: string): void {
  if (lastHtml.get(el) !== s) { lastHtml.set(el, s); el.innerHTML = s; }
}

function hud(): void {
  if (!game) return;
  const me = game.me();
  setText($("s-troops"), fmt(me.troops) + " / " + fmt(CFG.baseCap + me.tiles * CFG.capPerTile));
  setText($("s-gold"), fmt(me.gold));
  setText($("s-land"), ((me.tiles / game.landTiles) * 100).toFixed(1) + "%");
  const rows = [...game.stats.entries()].filter(([, s]) => s.alive).sort((a, b) => b[1].tiles - a[1].tiles).slice(0, 6);
  setHtml($("board"), rows.map(([id, s]) => {
    const p = game!.players.get(id)!;
    return `<li class="${id === game!.you ? "me" : ""}"><i style="background:#${p.color.toString(16).padStart(6, "0")}"></i>${esc(p.name)} ${((s.tiles / game!.landTiles) * 100).toFixed(1)}%</li>`;
  }).join(""));
  const incoming = game.attacks.filter((a) => a.on === game!.you && a.by !== game!.you);
  setHtml($("alerts"), incoming.map((a) => `<div>⚠ ${esc(game!.players.get(a.by)?.name ?? "?")} is invading you${a.pool !== undefined ? ` (${fmt(a.pool)})` : ""}</div>`).join(""));
  const hasFactory = game.structs.some((s) => s.owner === game!.you && s.type === "tankfactory");
  $("train").classList.toggle("hidden", !hasFactory);
  setText($("train"), `Tank · ${fmt(CFG.tankCost)}`);
  if (ov.selTank && !game.units.some((u) => u.id === ov.selTank)) ov.selTank = 0;
  $("cancel").classList.toggle("hidden", !game.attacks.some((a) => a.by === game!.you));
  $("pause").classList.toggle("hidden", !isHost);
  setText($("pause"), game.paused ? "▶" : "⏸");
  const spawning = game.sp > 0;
  $("spawn-bar").classList.toggle("hidden", !spawning);
  $("bottom").classList.toggle("hidden", spawning);
  if (spawning) setText($("spawn-count"), Math.ceil(game.sp / 10) + "s");
  const banner = $("banner");
  if (game.paused) { setText(banner, "Paused"); banner.classList.remove("hidden"); }
  else if (!me.alive && !game.over) { setText(banner, "You were eliminated — spectating"); banner.classList.remove("hidden"); }
  else banner.classList.add("hidden");
  refreshBuilds();
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function frame(now: number): void {
  requestAnimationFrame(frame);
  if (!game) return;
  ov.lasso = input.lasso;
  ov.ghosts = ov.ghosts.filter((g) => now - g.born < 2200);
  // range ring: hovering the map while placing, hovering an own structure, or hovering a build button
  ov.ringAt = null;
  const h = input.hover;
  const hx = h ? Math.floor(h.x) : -1, hy = h ? Math.floor(h.y) : -1;
  if (buildType && h && CFG.structures[buildType].range) ov.ringAt = { x: hx, y: hy, r: CFG.structures[buildType].range };
  else if (h) {
    const s = game.structs.find((s) => s.x === hx && s.y === hy && CFG.structures[s.type].range);
    if (s) ov.ringAt = { x: s.x, y: s.y, r: CFG.structures[s.type].range };
  }
  if (!ov.ringAt && hoverBuildBtn && CFG.structures[hoverBuildBtn].range) {
    const p = game.players.get(game.you);
    if (p) ov.ringAt = { x: p.cap % game.w, y: Math.floor(p.cap / game.w), r: CFG.structures[hoverBuildBtn].range };
  }
  // only redraw when something visible changed (idle ~10 fps on each server tick; 30+ fps while animating)
  const cam = renderer.cam;
  const sig = `${cam.x.toFixed(2)},${cam.y.toFixed(2)},${cam.zoom.toFixed(3)},${renderer.cw},${renderer.ch}`;
  const ring = ov.ringAt ? `${ov.ringAt.x},${ov.ringAt.y},${ov.ringAt.r}` : "";
  const animating = input.lasso.length > 0 || ov.ghosts.length > 0 || game.attacks.length > 0;
  const changed = sig !== lastSig || game.tick !== lastTick || ring !== lastRing || game.dirty.length > 0 || forceDraw;
  if (changed || (animating && now - lastDraw > 33)) {
    lastSig = sig; lastTick = game.tick; lastRing = ring; lastDraw = now; forceDraw = false;
    renderer.draw(now, ov);
  }
}
let lastSig = "", lastRing = "", lastTick = -1, lastDraw = 0, forceDraw = true;
requestAnimationFrame(frame);
setInterval(hud, 250);

// ---- network -----------------------------------------------------------------------------------
net.onstatus = (online) => $("offline").classList.toggle("hidden", online || !started);
net.onreconnect = () => { const s = loadSession(); if (s) net.send({ t: "rejoin", code: s.code, token: s.token }); };
net.onmsg = (m: ServerMsg) => {
  switch (m.t) {
    case "joined":
      isHost = m.host;
      saveSession({ code: m.code, token: m.token });
      break;
    case "lobby":
      isHost = m.host;
      started = true;
      show("lobby");
      $("lobby-code").textContent = m.code;
      $("members").innerHTML = m.members.map((x) => `<li><span>${esc(x.name)}${x.host ? " (host)" : ""}</span><span>${x.connected ? "●" : "○"}</span></li>`).join("");
      $("host-controls").classList.toggle("hidden", !m.host);
      $("wait").classList.toggle("hidden", m.host);
      break;
    case "start": {
      started = true;
      game = new ClientGame(m);
      show("game"); // the canvas needs layout before the camera can fit the map
      renderer.attach(game);
      const me = game.players.get(game.you);
      if (me && game.sp === 0) renderer.centerOn(me.cap, Math.max(renderer.cam.zoom, window.innerWidth < 700 ? 6 : 9));
      $("over").classList.add("hidden");
      buildType = null;
      show("game");
      hud();
      break;
    }
    case "tick":
      if (game) {
        const was = game.sp;
        for (const e of game.applyTick(m)) toast(e);
        if (was > 0 && game.sp === 0) {
          const me = game.players.get(game.you);
          if (me) renderer.centerOn(me.cap, Math.max(renderer.cam.zoom, window.innerWidth < 700 ? 6 : 9));
        }
      }
      break;
    case "paused":
      if (game) game.paused = m.paused;
      break;
    case "over":
      if (game) {
        game.over = true;
        game.winner = m.winner;
        const w = game.players.get(m.winner);
        $("over-title").textContent = m.winner === game.you ? "Victory! 🏆" : w ? `${w.name} wins` : "Game over";
        $("over").classList.remove("hidden");
        saveSession(null);
      }
      break;
    case "error":
      if (m.msg === "session expired") { saveSession(null); show("menu"); started = false; break; }
      if (m.msg !== lastToast || true) toast(m.msg);
      lastToast = m.msg;
      $("menu-msg").textContent = $("menu").classList.contains("hidden") ? "" : m.msg;
      $("lobby-msg").textContent = $("lobby").classList.contains("hidden") ? "" : m.msg;
      break;
  }
};

const saved = loadSession();
if (saved) {
  net.connect();
  net.send({ t: "rejoin", code: saved.code, token: saved.token });
}
refreshBuilds();

// debugging handle (harmless in production)
(window as unknown as { __rb: unknown }).__rb = { get game() { return game; }, input, renderer, net };
