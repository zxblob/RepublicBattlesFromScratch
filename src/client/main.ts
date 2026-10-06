import { CFG, STRUCT_TYPES, StructType, TECH, TECH_IDS } from "../core/config";
import type { GameSetup, ServerMsg, UnitK } from "../core/protocol";
import { fmt } from "./format";
import { Input } from "./input";
import { loadSession, Net, saveSession } from "./net";
import { Overlay, Renderer } from "./render";
import { ClientGame } from "./state";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const net = new Net();
let game: ClientGame | null = null;
let isHost = false;
let drawMode = false;
let buildType: StructType | null = null;
let hoverBuildBtn: StructType | null = null;
let started = false;
let panel: "" | "dip" | "res" = "";

const store = {
  get(k: string): string { try { return localStorage.getItem(k) ?? ""; } catch { return ""; } },
  set(k: string, v: string): void { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

const nameEl = $<HTMLInputElement>("name");
nameEl.value = store.get("rb.name");
const myName = () => {
  const n = nameEl.value.trim();
  store.set("rb.name", n);
  return n;
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function show(screen: "menu" | "lobby" | "game"): void {
  $("menu").classList.toggle("hidden", screen !== "menu");
  $("lobby").classList.toggle("hidden", screen !== "lobby");
  $("game").classList.toggle("hidden", screen !== "game");
  if (screen === "game") renderer.resize();
}

function toast(text: string, ms = 3200): void {
  if (!text) return;
  const el = document.createElement("div");
  el.textContent = text;
  $("toast").appendChild(el);
  setTimeout(() => el.remove(), ms);
}

// ---- game options (shared by the solo menu and the lobby host) ----------------------------------
function mountOptions(root: HTMLElement, prefix: string): () => GameSetup {
  // button groups instead of <select>: native dropdowns do not open in some embedded browsers and are awkward with a pen
  const seg = (id: string, items: [string, string][], def: string) =>
    `<div class="seg" id="${prefix}-${id}" data-v="${def}">${items.map(([v, l]) => `<button type="button" data-v="${v}" class="${v === def ? "on" : ""}">${l}</button>`).join("")}</div>`;
  root.innerHTML = `
    <div class="opt"><label>Mode</label>${seg("mode", [["ffa", "Free for all"], ["team", "Teams"], ["ww", "World War"], ["wow", "War of the Worlds"]], "ffa")}
      <small class="muted" id="${prefix}-mode-desc"></small></div>
    <div class="opt" id="${prefix}-teams-row"><label>Teams: <b id="${prefix}-teams-n">2</b></label><input id="${prefix}-teams" type="range" min="2" max="6" value="2"></div>
    <div class="opt"><label>Map size</label>${seg("size", [["small", "Small"], ["medium", "Medium"], ["large", "Large"], ["huge", "Huge"]], "small")}
      <small class="muted" id="${prefix}-size-desc"></small></div>
    <div class="opt check"><input id="${prefix}-islands" type="checkbox"><label for="${prefix}-islands">Islands (needs ports and boats)</label></div>
    <div class="opt"><label>Rival nations: <b id="${prefix}-bots-n">10</b></label><input id="${prefix}-bots" type="range" min="0" max="20" value="10"></div>
    <div class="opt"><label>Custom map code (from the map editor)</label><input id="${prefix}-map" maxlength="10" placeholder="optional" autocapitalize="characters"></div>`;
  const g = <T extends HTMLElement>(id: string) => root.querySelector<T>("#" + prefix + "-" + id)!;
  const MODE_DESC: Record<string, string> = {
    ffa: "Everyone for themselves. Alliances are possible.",
    team: "Fixed teams. Last team standing wins.",
    ww: "Expand, then a Cold War with research, then total war.",
    wow: "World War, then a space race to other planets.",
  };
  const SIZE_DESC: Record<string, string> = {
    small: "192×112", medium: "320×192", large: "512×320", huge: "1024×640 (needs a strong server)",
  };
  const val = (id: string) => g<HTMLElement>(id).dataset.v!;
  const sync = () => {
    g("teams-row").classList.toggle("hidden", val("mode") !== "team");
    g("teams-n").textContent = g<HTMLInputElement>("teams").value;
    g("bots-n").textContent = g<HTMLInputElement>("bots").value;
    g("mode-desc").textContent = MODE_DESC[val("mode")];
    g("size-desc").textContent = SIZE_DESC[val("size")];
    const max = { small: 20, medium: 30, large: 40, huge: 60 }[val("size") as "small"];
    const bots = g<HTMLInputElement>("bots");
    bots.max = String(max);
    if (Number(bots.value) > max) bots.value = String(max);
  };
  root.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>(".seg button");
    if (!b) return;
    const group = b.parentElement as HTMLElement;
    group.dataset.v = b.dataset.v;
    group.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    sync();
  });
  root.addEventListener("input", sync);
  sync();
  return () => ({
    mode: val("mode") as GameSetup["mode"],
    teams: Number(g<HTMLInputElement>("teams").value),
    bots: Number(g<HTMLInputElement>("bots").value),
    size: val("size") as GameSetup["size"],
    islands: g<HTMLInputElement>("islands").checked,
    map: g<HTMLInputElement>("map").value.trim().toUpperCase(),
  });
}
const menuSetup = mountOptions($("menu-opts"), "mo");
const lobbySetup = mountOptions($("lobby-opts"), "lo");

// ---- country image ------------------------------------------------------------------------------
let skinData = store.get("rb.skin");
$("skin").addEventListener("change", (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (!f) return;
  const url = URL.createObjectURL(f);
  const img = new Image();
  img.onload = () => {
    const c = document.createElement("canvas");
    c.width = c.height = 64;
    const cx = c.getContext("2d")!;
    const s = Math.min(img.width, img.height);
    cx.drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, 64, 64);
    skinData = c.toDataURL("image/jpeg", 0.7);
    store.set("rb.skin", skinData);
    URL.revokeObjectURL(url);
    net.send({ t: "skin", data: skinData });
    toast("Country image set");
  };
  img.src = url;
});

// ---- menu ----------------------------------------------------------------------------------------
$("solo").onclick = () => { $("menu-msg").textContent = ""; net.send({ t: "solo", name: myName(), setup: menuSetup() }); };
$("create").onclick = () => { $("menu-msg").textContent = ""; net.send({ t: "create", name: myName() }); };
$("join").onclick = () => {
  const code = $<HTMLInputElement>("code").value.trim();
  if (code.length < 4) { $("menu-msg").textContent = "Enter the lobby code"; return; }
  net.send({ t: "join", code, name: myName() });
};
$("code").addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") $("join").click(); });

// ---- lobby ---------------------------------------------------------------------------------------
$("start").onclick = () => net.send({ t: "start", setup: lobbySetup() });
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

// ---- game UI -------------------------------------------------------------------------------------
const canvas = $<HTMLCanvasElement>("c");
const renderer = new Renderer(canvas);
const ov: Overlay = { lasso: [], ghosts: [], hover: null, buildType: null, ringAt: null, selTank: 0, wallDraft: false, missileAim: false };

const ratioEl = $<HTMLInputElement>("ratio");
ratioEl.oninput = () => ($("ratio-val").textContent = ratioEl.value + "%");
$("draw").onclick = () => { drawMode = !drawMode; $("draw").classList.toggle("on", drawMode); };
$("home").onclick = () => { const p = game?.players.get(game.you); if (p && game) renderer.centerOn(p.cap, 7); };
$("pause").onclick = () => net.send({ t: "pause" });
$("ready").onclick = () => { net.send({ t: "ready" }); $("ready").textContent = "Waiting…"; };
$("cancel").onclick = () => { for (const a of game?.attacks ?? []) if (a.by === game!.you) net.send({ t: "cancel", id: a.id }); };
$("btn-save").onclick = () => net.send({ t: "save" });
$("btn-dip").onclick = () => togglePanel("dip");
$("btn-res").onclick = () => togglePanel("res");
$("panel-close").onclick = () => togglePanel("");
$("wall").onclick = () => {
  clearTools();
  ov.wallDraft = true;
  $("wall").classList.add("on");
  toast("Draw a line on your own land to build a wall");
};
$("missile").onclick = () => {
  const on = !ov.missileAim;
  clearTools();
  ov.missileAim = on;
  $("missile").classList.toggle("on", on);
  if (on) toast("Tap the target for your missile");
};
let launchArmed = 0;
$("launch").onclick = () => {
  if (launchArmed && Date.now() - launchArmed < 3000) { launchArmed = 0; net.send({ t: "launch" }); return; }
  launchArmed = Date.now();
  toast("Tap again to launch your team to the planets");
};

function clearTools(): void {
  ov.wallDraft = false;
  ov.missileAim = false;
  ov.selTank = 0;
  buildType = null;
  $("wall").classList.remove("on");
  $("missile").classList.remove("on");
  refreshBuilds();
}

// build buttons
const buildsEl = $("builds");
const buildBtns = new Map<StructType, HTMLButtonElement>();
for (const type of STRUCT_TYPES) {
  const b = document.createElement("button");
  b.innerHTML = `${CFG.structures[type].label}<small></small>`;
  b.title = CFG.structures[type].desc;
  b.onclick = () => {
    const was = buildType === type;
    clearTools();
    buildType = was ? null : type;
    refreshBuilds();
    if (buildType) toast(`${CFG.structures[type].label}: ${CFG.structures[type].desc}. Tap your land to place.`);
  };
  b.onpointerenter = (e) => { if (e.pointerType === "mouse") hoverBuildBtn = type; };
  b.onpointerleave = () => (hoverBuildBtn = null);
  buildBtns.set(type, b);
  buildsEl.appendChild(b);
}
function structAvailable(type: StructType): boolean {
  if (!game) return true;
  if (type === "lab") return game.research;
  if (type === "spaceport") return game.mode === "wow" && (game.phase === "space" || game.planet !== "");
  return true;
}
function refreshBuilds(): void {
  for (const [type, b] of buildBtns) {
    b.classList.toggle("hidden", !structAvailable(type));
    b.classList.toggle("on", buildType === type);
    const cost = game?.structCost(type) ?? 0;
    setText(b.querySelector("small") as HTMLElement, `${fmt(cost)} gold`);
    b.classList.toggle("poor", !!game && game.me().gold < cost);
  }
}

// unit buttons
const UNITS: { k: UnitK; label: string; cost: number; need: StructType }[] = [
  { k: "t", label: "Tank", cost: CFG.tankCost, need: "tankfactory" },
  { k: "f", label: "Fighter", cost: CFG.fighterCost, need: "airbase" },
  { k: "b", label: "Bomber", cost: CFG.bomberCost, need: "airbase" },
  { k: "x", label: "Transport", cost: CFG.transportCost, need: "port" },
  { k: "w", label: "Warship", cost: CFG.warshipCost, need: "port" },
];
const trainBtns: HTMLButtonElement[] = [];
for (const u of UNITS) {
  const b = document.createElement("button");
  b.className = "hidden";
  b.textContent = `${u.label} · ${fmt(u.cost)}`;
  b.title = `Train a ${u.label.toLowerCase()}`;
  b.onclick = () => net.send({ t: "train", kind: u.k });
  $("trains").appendChild(b);
  trainBtns.push(b);
}

// panels
function togglePanel(which: "" | "dip" | "res"): void {
  panel = panel === which ? "" : which;
  $("panel").classList.toggle("hidden", !panel);
  renderPanel(true);
}
let panelHtml = "";
function renderPanel(force = false): void {
  if (!panel || !game) return;
  let html = "";
  if (panel === "dip") {
    $("panel-title").textContent = game.mode === "team" ? "Teams" : "Diplomacy";
    for (const [id, p] of game.players) {
      if (id === game.you || !game.stats.get(id)?.alive) continue;
      const me = game.me_;
      let action = "";
      if (game.mode === "team") action = p.team === game.players.get(game.you)?.team ? "<small>your team</small>" : "";
      else if (me.allies.includes(id)) action = `<button data-unally="${id}">Break</button>`;
      else if (me.reqs.includes(id)) action = `<button data-ally="${id}">Accept</button>`;
      else action = `<button data-ally="${id}">Ally</button>`;
      html += `<div class="prow"><div><i style="background:#${p.color.toString(16).padStart(6, "0")}"></i>${esc(p.name)}${p.team ? ` · team ${p.team}` : ""}<small>${fmt(game.stats.get(id)!.troops)} troops</small></div>${action}</div>`;
    }
  } else {
    $("panel-title").textContent = `Research · ${game.me_.rp} points`;
    let branch = "";
    for (const id of TECH_IDS) {
      const t = TECH[id];
      if (t.branch === "Space" && game.mode !== "wow") continue;
      if (t.branch !== branch) { branch = t.branch; html += `<div class="branch">${branch}</div>`; }
      const done = game.me_.tech.includes(id);
      const locked = !!t.req && !game.me_.tech.includes(t.req);
      const can = !done && !locked && game.me_.rp >= t.cost && game.phase !== "expand";
      html += `<div class="prow"><div>${t.label}<small>${t.desc}${locked ? ` · needs ${TECH[t.req as keyof typeof TECH].label}` : ""}</small></div>${done ? "<small>✓</small>" : `<button data-res="${id}" ${can ? "" : "disabled"}>${t.cost}</button>`}</div>`;
    }
    if (game.phase === "expand") html = `<p class="tag">Research opens when the great powers stand off (Cold War).</p>` + html;
  }
  if (!force && html === panelHtml) return;
  panelHtml = html;
  $("panel-body").innerHTML = html;
  for (const b of $("panel-body").querySelectorAll<HTMLButtonElement>("button")) {
    b.onclick = () => {
      if (b.dataset.ally) net.send({ t: "ally", with: Number(b.dataset.ally) });
      if (b.dataset.unally) net.send({ t: "unally", with: Number(b.dataset.unally) });
      if (b.dataset.res) net.send({ t: "research", id: b.dataset.res });
    };
  }
}

// attack marker menu: reinforce or retreat
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

const input = new Input(canvas, renderer, {
  drawMode: () => drawMode,
  onLasso(poly, pressure) {
    if (!game || !game.me().alive) return;
    const rounded = poly.map((n) => Math.round(n * 100) / 100);
    if (ov.wallDraft) { net.send({ t: "wall", pts: rounded }); clearTools(); return; }
    if (ov.selTank) { net.send({ t: "move", id: ov.selTank, pts: rounded, ratio: Number(ratioEl.value) / 100 }); return; }
    if (poly.length < 6) return; // an attack area needs at least 3 points
    let ratio = Number(ratioEl.value) / 100;
    if (pressure !== null) ratio = Math.min(1, ratio * Math.max(0.3, Math.min(1.6, 0.4 + 1.2 * pressure)));
    net.send({ t: "attack", poly: rounded, ratio });
    ov.ghosts.push({ pts: poly, born: performance.now() });
    if (ov.ghosts.length > 6) ov.ghosts.shift();
  },
  onTap(wx, wy) {
    if (!game) return;
    if (game.sp > 0) { net.send({ t: "spawn", x: Math.floor(wx), y: Math.floor(wy) }); return; }
    if (ov.missileAim) { net.send({ t: "missile", x: wx, y: wy }); clearTools(); return; }
    // units: tap one of yours to select, tap elsewhere to send it there
    const near = game.units.find((u) => u.owner === game!.you && Math.hypot(u.x - wx, u.y - wy) * renderer.cam.zoom < 22);
    if (near) {
      const id = ov.selTank === near.id ? 0 : near.id;
      clearTools();
      ov.selTank = id;
      if (id) toast(near.k === "x" ? "Transport selected: tap a coast to land troops (slider sets how many)" : "Unit selected: draw its route, or tap a spot");
      return;
    }
    if (ov.selTank && !buildType) { net.send({ t: "move", id: ov.selTank, pts: [wx, wy], ratio: Number(ratioEl.value) / 100 }); return; }
    if (!buildType && openAttackMenu(wx, wy)) return;
    closeAttackMenu();
    if (!buildType) return;
    net.send({ t: "build", type: buildType, x: Math.floor(wx), y: Math.floor(wy) });
    buildType = null;
    refreshBuilds();
  },
});

window.addEventListener("resize", () => { if (game) { renderer.resize(); forceDraw = true; } });

const lastText = new WeakMap<HTMLElement, string>();
function setText(el: HTMLElement, s: string): void {
  if (lastText.get(el) !== s) { lastText.set(el, s); el.textContent = s; }
}
const lastHtml = new WeakMap<HTMLElement, string>();
function setHtml(el: HTMLElement, s: string): void {
  if (lastHtml.get(el) !== s) { lastHtml.set(el, s); el.innerHTML = s; }
}

function phaseText(g: ClientGame): string {
  if (g.planet) return `${g.planet} planet`;
  if (!g.research) return "";
  if (g.phase === "expand") return "Expansion";
  if (g.phase === "cold") { const s = Math.ceil(g.pt / 10); return `Cold War ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }
  if (g.phase === "space") return "Space Race";
  return "War";
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
  $("cancel").classList.toggle("hidden", !game.attacks.some((a) => a.by === game!.you));
  $("pause").classList.toggle("hidden", !isHost);
  $("btn-save").classList.toggle("hidden", !isHost);
  $("btn-res").classList.toggle("hidden", !game.research);
  setText($("pause"), game.paused ? "▶" : "⏸");
  const pt = phaseText(game);
  $("phase").classList.toggle("hidden", !pt);
  setText($("phase-txt"), pt);
  UNITS.forEach((u, i) => trainBtns[i].classList.toggle("hidden", !game!.has(u.need)));
  $("missile").classList.toggle("hidden", !game.has("silo"));
  $("launch").classList.toggle("hidden", !game.me_.canLaunch);
  if (ov.selTank && !game.units.some((u) => u.id === ov.selTank)) ov.selTank = 0;
  const spawning = game.sp > 0;
  $("spawn-bar").classList.toggle("hidden", !spawning);
  $("bottom").classList.toggle("hidden", spawning);
  if (spawning) setText($("spawn-count"), Math.ceil(game.sp / 10) + "s");
  const banner = $("banner");
  if (game.paused) { setText(banner, isHost ? "Paused — press ▶ to resume" : "Paused by the host"); banner.classList.remove("hidden"); }
  else if (!me.alive && !game.over) { setText(banner, game.you ? "You were eliminated — spectating" : "Spectating"); banner.classList.remove("hidden"); }
  else banner.classList.add("hidden");
  refreshBuilds();
  renderPanel();
}

// adaptive resolution: if frames keep taking too long (software rendering, weak phone), render at lower resolution
let lastFrameAt = 0, frameEma = 16, slowFor = 0;
function adapt(now: number): void {
  const d = now - lastFrameAt;
  lastFrameAt = now;
  if (d <= 0 || d > 500) return; // tab was hidden
  frameEma = frameEma * 0.92 + d * 0.08;
  slowFor = frameEma > 48 ? slowFor + 1 : 0;
  if (slowFor > 45 && renderer.scale > 0.5) {
    renderer.scale = Math.max(0.5, renderer.scale - 0.25);
    renderer.resize();
    forceDraw = true;
    slowFor = 0;
    frameEma = 16;
    toast("Lowered render quality for smoother play");
  }
}

function frame(now: number): void {
  requestAnimationFrame(frame);
  if (!game) return;
  adapt(now);
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
  if (ov.missileAim && h) ov.ringAt = { x: hx, y: hy, r: CFG.missileRadius };
  // only redraw when something visible changed (idle ~10 fps on each server tick; 30+ fps while animating)
  const cam = renderer.cam;
  const sig = `${cam.x.toFixed(2)},${cam.y.toFixed(2)},${cam.zoom.toFixed(3)},${renderer.cw},${renderer.ch}`;
  const ring = ov.ringAt ? `${ov.ringAt.x},${ov.ringAt.y},${ov.ringAt.r}` : "";
  const animating = input.lasso.length > 0 || ov.ghosts.length > 0 || game.missiles.length > 0 || game.attacks.some((a) => a.x !== undefined);
  const changed = sig !== lastSig || game.tick !== lastTick || ring !== lastRing || game.dirty.length > 0 || game.skinChanged.length > 0 || forceDraw;
  if (changed || (animating && now - lastDraw > 45)) {
    lastSig = sig; lastTick = game.tick; lastRing = ring; lastDraw = now; forceDraw = false;
    renderer.draw(now, ov);
  }
}
let lastSig = "", lastRing = "", lastTick = -1, lastDraw = 0, forceDraw = true;
requestAnimationFrame(frame);
setInterval(hud, 250);

// ---- network -------------------------------------------------------------------------------------
net.onstatus = (online) => $("offline").classList.toggle("hidden", online || !started);
net.onreconnect = () => { const s = loadSession(); if (s) net.send({ t: "rejoin", code: s.code, token: s.token }); };
net.onmsg = (m: ServerMsg) => {
  switch (m.t) {
    case "joined":
      isHost = m.host;
      saveSession({ code: m.code, token: m.token });
      if (skinData) net.send({ t: "skin", data: skinData });
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
      $("ready").textContent = "Ready";
      clearTools();
      panel = "";
      $("panel").classList.add("hidden");
      forceDraw = true;
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
    case "saved":
      toast("Game saved. Rejoin it later with the lobby code.");
      break;
    case "over":
      if (game) {
        game.over = true;
        game.winner = m.winner;
        const w = game.players.get(m.winner);
        const mine = m.winner === game.you || game.friendly(m.winner);
        $("over-title").textContent = mine ? "Victory! 🏆" : w ? `${w.name}${m.team ? "'s team" : ""} wins` : "Game over";
        $("over").classList.remove("hidden");
        saveSession(null);
      }
      break;
    case "error":
      if (m.msg === "session expired") { saveSession(null); show("menu"); started = false; break; }
      toast(m.msg);
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
