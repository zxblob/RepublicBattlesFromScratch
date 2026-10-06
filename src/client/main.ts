import { CFG, MISSILES, MissileKind, STRUCT_TYPES, StructType, TECH, TECH_IDS } from "../core/config";
import type { GameSetup, ServerMsg, UnitK } from "../core/protocol";
import { fmt } from "./format";
import { actionInfo, missileInfo, structInfo, toolInfo, unitInfo } from "./info";
import { attachTip } from "./tooltip";
import { Input } from "./input";
import { loadSession, Net, saveSession } from "./net";
import { Radial, RItem } from "./radial";
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
let panel: "" | "dip" | "res" | "set" | "chat" = "";
let toolLine: "" | "wall" | "rail" = "";
let missileKind: MissileKind = "atom";

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
    <div class="opt"><label>Map</label>${seg("pre", [["", "Random"], ["WORLD", "Earth"], ["EUROPE", "Europe"], ["NAMERICA", "N. America"], ["SAMERICA", "S. America"], ["AFRICA", "Africa"], ["ASIA", "Asia"], ["AUSTRALIA", "Oceania"]], "")}</div>
    <div class="opt" id="${prefix}-size-row"><label>Random map size</label>${seg("size", [["small", "Small"], ["medium", "Medium"], ["large", "Large"], ["huge", "Huge"]], "small")}
      <small class="muted" id="${prefix}-size-desc"></small></div>
    <div class="opt check" id="${prefix}-islands-row"><input id="${prefix}-islands" type="checkbox"><label for="${prefix}-islands">Islands (needs ports and boats)</label></div>
    <div class="opt"><label>Rival nations: <b id="${prefix}-bots-n">10</b></label><input id="${prefix}-bots" type="range" min="0" max="20" value="10"></div>
    <div class="opt check"><input id="${prefix}-coop" type="checkbox"><label for="${prefix}-coop">Co-op: all human players are one team against the bots</label></div>
    <div class="opt check"><input id="${prefix}-dom" type="checkbox" checked><label for="${prefix}-dom">Dominance victory (a clear leader wins after a 5 min countdown)</label></div>
    <div class="opt"><label>Or a custom map code (from the map editor)</label><input id="${prefix}-map" maxlength="10" placeholder="optional" autocapitalize="characters"></div>`;
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
    const premade = val("pre") !== "";
    g("size-row").classList.toggle("hidden", premade);
    g("islands-row").classList.toggle("hidden", premade);
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
    map: g<HTMLInputElement>("map").value.trim().toUpperCase() || val("pre"),
    dominance: g<HTMLInputElement>("dom").checked,
    coop: g<HTMLInputElement>("coop").checked,
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
renderer.onSprites = () => { forceDraw = true; iconify(); };
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
$("btn-set").onclick = () => togglePanel("set");
$("btn-chat").onclick = () => togglePanel("chat");
$("panel-close").onclick = () => togglePanel("");
function lineTool(kind: "wall" | "rail", hint: string): void {
  const was = toolLine === kind;
  clearTools();
  if (was) return;
  toolLine = kind;
  ov.wallDraft = true;
  $(kind).classList.add("on");
  toast(hint);
}
$("wall").onclick = () => lineTool("wall", "Draw a line on your own land to build a wall");
$("rail").onclick = () => lineTool("rail", "Draw rails from a City, Factory or Port to another (yours or an ally's). Ends snap to nearby buildings.");

attachTip($("draw"), () => toolInfo("draw"));
attachTip($("wall"), () => toolInfo("wall"));
attachTip($("rail"), () => toolInfo("rail"));
attachTip($("home"), () => toolInfo("home"));
attachTip($("cancel"), () => toolInfo("cancel"));

const missileBtns = new Map<MissileKind, HTMLButtonElement>();
for (const k of Object.keys(MISSILES) as MissileKind[]) {
  const b = document.createElement("button");
  b.className = "hidden";
  b.textContent = `🚀 ${MISSILES[k].label} · ${fmt(MISSILES[k].cost)}`;
  attachTip(b, () => missileInfo(k));
  b.onclick = () => {
    const on = !(ov.missileAim && missileKind === k);
    clearTools();
    if (on) { ov.missileAim = true; missileKind = k; b.classList.add("on"); toast(`Tap the target for your ${MISSILES[k].label}`); }
  };
  missileBtns.set(k, b);
  $("missiles").appendChild(b);
}
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
  toolLine = "";
  $("wall").classList.remove("on");
  $("rail").classList.remove("on");
  for (const b of missileBtns.values()) b.classList.remove("on");
  refreshBuilds();
}

// build buttons
const buildsEl = $("builds");
const buildBtns = new Map<StructType, HTMLButtonElement>();
for (const type of STRUCT_TYPES) {
  const b = document.createElement("button");
  b.innerHTML = `${CFG.structures[type].label}<small></small>`;
  attachTip(b, () => structInfo(type, game?.structCost(type), game ? game.structs.filter((x) => x.owner === game!.you && x.type === type).length : 0));
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
  attachTip(b, () => unitInfo(u.k as "t"));
  b.onclick = () => net.send({ t: "train", kind: u.k });
  $("trains").appendChild(b);
  trainBtns.push(b);
}

// pixel icons on the build / unit buttons once the sprites are loaded
function iconify(): void {
  const put = (b: HTMLElement, name: string) => {
    const c = renderer.sprites.get(name, 0x4aa3ff);
    if (!c || b.querySelector("img.ic")) return;
    const im = document.createElement("img");
    im.className = "ic";
    im.src = c.toDataURL();
    b.prepend(im);
  };
  for (const [type, b] of buildBtns) put(b, type);
  UNITS.forEach((u, i) => put(trainBtns[i], { t: "tank", f: "fighter", b: "bomber", x: "transport", w: "warship" }[u.k as "t"]));
}

// panels
function togglePanel(which: "" | "dip" | "res" | "set" | "chat"): void {
  panel = panel === which ? "" : which;
  $("panel").classList.toggle("hidden", !panel);
  renderPanel(true);
}
let panelHtml = "";
const CHAT = ["👍", "👎", "😂", "😡", "🤝", "🏳️", "🔥", "💀", "Let's ally!", "Thanks!", "Help me!", "Attack them!", "Peace?", "Good game", "Nukes incoming!", "Retreat!"];
const QUALITY: [string, string][] = [["auto", "Auto"], ["high", "High"], ["medium", "Medium"], ["low", "Low"]];
let quality = store.get("rb.quality") || "auto";
let showPerf = store.get("rb.perf") === "1";
function applyQuality(): void {
  renderer.scale = quality === "high" ? 1 : quality === "medium" ? 0.75 : quality === "low" ? 0.5 : renderer.scale;
  if (game) { renderer.resize(); forceDraw = true; }
}

function renderPanel(force = false): void {
  if (!panel || !game) return;
  let html = "";
  if (panel === "dip") {
    $("panel-title").textContent = game.mode === "team" || (game.players.get(game.you)?.team ?? 0) !== 0 ? "Teams & diplomacy" : "Diplomacy";
    for (const [id, p] of game.players) {
      if (id === game.you || !game.stats.get(id)?.alive) continue;
      const me = game.me_;
      const friendly = game.friendly(id);
      const acts: string[] = [];
      const myTeam = game.players.get(game.you)?.team ?? 0;
      const sameTeam = myTeam !== 0 && p.team === myTeam;
      if (sameTeam) acts.push("<small>your team</small>");
      else if (game.mode === "team") { /* fixed teams: nothing to negotiate */ }
      else if (me.allies.includes(id)) acts.push(`<button data-unally="${id}">Break</button>`);
      else if (me.reqs.includes(id)) acts.push(`<button data-ally="${id}">Accept</button>`);
      else acts.push(`<button data-ally="${id}">Ally</button>`);
      if (friendly) {
        acts.push(`<button data-donate="${id}" data-what="troops">Give troops</button>`, `<button data-donate="${id}" data-what="gold">Give gold</button>`);
      } else {
        const on = me.embargo.includes(id);
        acts.push(`<button data-embargo="${id}" data-on="${on ? 0 : 1}">${on ? "Lift embargo" : "Embargo"}</button>`);
      }
      if (isHost && p.skin) acts.push(`<button data-clearskin="${id}">Remove image</button>`);
      html += `<div class="prow"><div><i style="background:#${p.color.toString(16).padStart(6, "0")}"></i>${esc(p.name)}${p.team ? ` · team ${p.team}` : ""}<small>${fmt(game.stats.get(id)!.troops)} troops</small></div><div class="acts">${acts.join("")}</div></div>`;
    }
  } else if (panel === "chat") {
    $("panel-title").textContent = "Quick chat";
    html = `<div class="emoji-grid">${CHAT.map((c, i) => `<button data-chat="${i}" class="${i >= 8 ? "txt" : ""}">${esc(c)}</button>`).join("")}</div>`;
  } else if (panel === "set") {
    $("panel-title").textContent = "Settings";
    html = `<div class="branch">Graphics quality</div><div class="seg">${QUALITY.map(([v, l]) => `<button data-q="${v}" class="${quality === v ? "on" : ""}">${l}</button>`).join("")}</div>
      <p class="tag">Auto lowers the resolution if the game stutters. Low renders at half resolution and redraws less often.</p>
      <div class="branch">Performance</div><button data-perf="1" class="${showPerf ? "on" : ""}">${showPerf ? "Hide" : "Show"} FPS and timings</button>
      <p class="tag">If it still lags in an embedded browser, open the game in your normal browser.</p>`;
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
      const d = b.dataset;
      if (d.ally) net.send({ t: "ally", with: Number(d.ally) });
      if (d.unally) net.send({ t: "unally", with: Number(d.unally) });
      if (d.res) net.send({ t: "research", id: d.res });
      if (d.donate) net.send({ t: "donate", to: Number(d.donate), what: d.what === "gold" ? "gold" : "troops" });
      if (d.embargo) net.send({ t: "embargo", with: Number(d.embargo), on: d.on === "1" });
      if (d.clearskin) net.send({ t: "clearskin", id: Number(d.clearskin) });
      if (d.chat) { net.send({ t: "chat", id: Number(d.chat) }); togglePanel(""); }
      if (d.q) { quality = d.q; store.set("rb.quality", quality); applyQuality(); renderPanel(true); }
      if (d.perf) { showPerf = !showPerf; store.set("rb.perf", showPerf ? "1" : "0"); renderPanel(true); }
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

// ---- radial menu ---------------------------------------------------------------------------------
const radial = new Radial(document.body);
canvas.addEventListener("pointerdown", () => radial.close());
canvas.addEventListener("wheel", () => radial.close(), { passive: true });

const icon = (name: string): string | undefined => renderer.sprites.get(name, 0x4aa3ff)?.toDataURL();

function hull(pts: [number, number][]): [number, number][] {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: [number, number][] = [], up: [number, number][] = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of [...p].reverse()) { while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

/** Quick attack: a capsule-shaped area from your nearest border tile out to the tapped tile. */
function quickAttack(tx: number, ty: number): void {
  if (!game) return;
  let best = -1, bd = 1e9;
  const R = 60;
  for (let y = Math.max(0, ty - R); y <= Math.min(game.h - 1, ty + R); y++) {
    for (let x = Math.max(0, tx - R); x <= Math.min(game.w - 1, tx + R); x++) {
      if (game.owner[y * game.w + x] !== game.you) continue;
      const d = (x - tx) ** 2 + (y - ty) ** 2;
      if (d < bd) { bd = d; best = y * game.w + x; }
    }
  }
  if (best < 0) { toast("No border of yours near there"); return; }
  const bx = (best % game.w) + 0.5, by = Math.floor(best / game.w) + 0.5;
  const r = 6;
  const pts: [number, number][] = [];
  for (let i = 0; i < 14; i++) {
    const a = (i / 14) * Math.PI * 2;
    pts.push([tx + 0.5 + Math.cos(a) * r, ty + 0.5 + Math.sin(a) * r], [bx + Math.cos(a) * 2.5, by + Math.sin(a) * 2.5]);
  }
  const poly = hull(pts).flat().map((n) => Math.round(n * 100) / 100);
  net.send({ t: "attack", poly, ratio: Number(ratioEl.value) / 100 });
  ov.ghosts.push({ pts: poly, born: performance.now() });
}

function buildItem(type: StructType, tx: number, ty: number): RItem {
  const cost = game!.structCost(type);
  const coastal = type === "port";
  return {
    label: CFG.structures[type].label.replace(" Launcher", ""),
    sub: fmt(cost),
    icon: icon(type),
    disabled: game!.me().gold < cost || (coastal && !game!.terrain[ty * game!.w + tx + 1] && false),
    info: () => structInfo(type, game?.structCost(type), game ? game.structs.filter((x) => x.owner === game!.you && x.type === type).length : 0),
    onClick: () => net.send({ t: "build", type, x: tx, y: ty }),
  };
}

function nukeItems(wx: number, wy: number): RItem[] {
  return (Object.keys(MISSILES) as MissileKind[]).map((k) => ({
    label: MISSILES[k].label.replace(" bomb", ""),
    sub: fmt(MISSILES[k].cost),
    glyph: "🚀",
    disabled: game!.me().gold < MISSILES[k].cost,
    danger: true,
    info: () => missileInfo(k),
    onClick: () => net.send({ t: "missile", x: wx, y: wy, kind: k }),
  }));
}

function radialFor(wx: number, wy: number): RItem[] | null {
  if (!game || !game.me().alive) return null;
  const tx = Math.floor(wx), ty = Math.floor(wy);
  if (tx < 0 || ty < 0 || tx >= game.w || ty >= game.h) return null;
  const i = ty * game.w + tx;
  if (game.terrain[i] === 0) return null; // water
  const owner = game.owner[i];
  const silo = game.has("silo");

  if (owner === game.you) {
    if (game.structs.some((s) => s.x === tx && s.y === ty)) return null;
    if (game.terrain[i] !== 1) { toast("Build on flat land (not mountains)"); return null; }
    const eco: StructType[] = ["bank", "city", "farm", "port", "factory", ...(game.research ? (["lab"] as StructType[]) : [])];
    const mil: StructType[] = ["bunker", "barracks", "sam", "tankfactory", "airbase", "silo"];
    const items: RItem[] = [
      { label: "Economy", glyph: "💰", children: eco.map((t) => buildItem(t, tx, ty)) },
      { label: "Military", glyph: "🛡", children: mil.map((t) => buildItem(t, tx, ty)) },
      { label: "Wall", glyph: "▬", onClick: () => lineTool("wall", "Draw a line on your own land to build a wall") },
      { label: "Rail", glyph: "⌇", onClick: () => lineTool("rail", "Draw rails from a City, Factory or Port to another (yours or an ally's). Ends snap to nearby buildings.") },
    ];
    if (game.mode === "wow" && (game.phase === "space" || game.planet)) items.splice(2, 0, { label: "Space", glyph: "★", children: [buildItem("spaceport", tx, ty)] });
    return items;
  }

  if (owner === 0) {
    const items: RItem[] = [{ label: "Expand", glyph: "⚑", onClick: () => quickAttack(tx, ty) }];
    if (silo) items.push({ label: "Missile", glyph: "🚀", danger: true, children: nukeItems(wx, wy) });
    return items;
  }

  const p = game.players.get(owner);
  if (!p) return null;
  const me = game.me_;
  const items: RItem[] = [];
  if (game.friendly(owner)) {
    items.push({ label: "Give troops", glyph: "⚔", onClick: () => net.send({ t: "donate", to: owner, what: "troops" }) });
    items.push({ label: "Give gold", glyph: "💰", onClick: () => net.send({ t: "donate", to: owner, what: "gold" }) });
    if (me.allies.includes(owner)) items.push({ label: "Break", glyph: "✂", danger: true, onClick: () => net.send({ t: "unally", with: owner }) });
  } else {
    items.push({ label: "Attack", sub: p.name, glyph: "⚔", danger: true, onClick: () => quickAttack(tx, ty) });
    if (silo) items.push({ label: "Missile", glyph: "🚀", danger: true, children: nukeItems(wx, wy) });
    if (game.mode !== "team" && !(game.players.get(owner)?.team)) {
      items.push({ label: me.reqs.includes(owner) ? "Accept" : "Ally", glyph: "🤝", onClick: () => net.send({ t: "ally", with: owner }) });
    }
    const on = me.embargo.includes(owner);
    items.push({ label: on ? "Lift embargo" : "Embargo", glyph: "⛔", onClick: () => net.send({ t: "embargo", with: owner, on: !on }) });
  }
  return items;
}

function addInfo(items: RItem[]): void {
  for (const it of items) {
    if (!it.info) { const i = actionInfo(it.label); if (i) it.info = () => i; }
    if (it.children) addInfo(it.children);
  }
}

function openRadial(wx: number, wy: number): boolean {
  const items = radialFor(wx, wy);
  if (!items) return false;
  addInfo(items);
  const b = canvas.getBoundingClientRect();
  radial.open(b.left + renderer.cw / 2 + (wx - renderer.cam.x) * renderer.cam.zoom, b.top + renderer.ch / 2 + (wy - renderer.cam.y) * renderer.cam.zoom, items);
  return true;
}

const input = new Input(canvas, renderer, {
  drawMode: () => drawMode,
  onLasso(poly, pressure) {
    if (!game || !game.me().alive) return;
    const rounded = poly.map((n) => Math.round(n * 100) / 100);
    if (ov.wallDraft) { net.send({ t: toolLine === "rail" ? "rail" : "wall", pts: rounded }); clearTools(); return; }
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
    if (ov.missileAim) { net.send({ t: "missile", x: wx, y: wy, kind: missileKind }); clearTools(); return; }
    // units: tap one of yours to select, tap elsewhere to send it there
    const near = game.units.find((u) => u.owner === game!.you && u.k !== "r" && Math.hypot(u.x - wx, u.y - wy) * renderer.cam.zoom < 22);
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
    if (!buildType) { openRadial(wx, wy); return; }
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

function domText(g: ClientGame): string {
  if (!g.dm) return "";
  const s = Math.ceil(g.dm / 10);
  return `${g.players.get(g.dl)?.name ?? "Leader"} wins in ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function phaseText(g: ClientGame): string {
  const dom = domText(g);
  const base = phaseBase(g);
  return dom ? (base ? base + " · " : "") + dom : base;
}

function phaseBase(g: ClientGame): string {
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
  for (const b of missileBtns.values()) b.classList.toggle("hidden", !game.has("silo"));
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
  if (d <= 0 || d > 200) return; // throttled or hidden page (not a slow renderer): do not lower quality
  frameEma = frameEma * 0.92 + d * 0.08;
  slowFor = frameEma > 48 ? slowFor + 1 : 0;
  if (quality === "auto" && slowFor > 45 && renderer.scale > 0.5) {
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
  perfFrames++;
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
  if (ov.missileAim && h) ov.ringAt = { x: hx, y: hy, r: MISSILES[missileKind].radius };
  // only redraw when something visible changed (idle ~10 fps on each server tick; 30+ fps while animating)
  const cam = renderer.cam;
  const sig = `${cam.x.toFixed(2)},${cam.y.toFixed(2)},${cam.zoom.toFixed(3)},${renderer.cw},${renderer.ch}`;
  const ring = ov.ringAt ? `${ov.ringAt.x},${ov.ringAt.y},${ov.ringAt.r}` : "";
  const animating = input.lasso.length > 0 || ov.ghosts.length > 0 || game.missiles.length > 0 || game.attacks.some((a) => a.x !== undefined);
  const changed = sig !== lastSig || game.tick !== lastTick || ring !== lastRing || game.dirty.length > 0 || game.skinChanged.length > 0 || forceDraw;
  if (changed || (animating && now - lastDraw > (quality === "low" ? 70 : 45))) {
    lastSig = sig; lastTick = game.tick; lastRing = ring; lastDraw = now; forceDraw = false;
    const t0 = performance.now();
    renderer.draw(now, ov);
    perfDraws++;
    perfDrawMs += performance.now() - t0;
  }
}
let perfFrames = 0, perfDraws = 0, perfDrawMs = 0, perfTicks = 0, perfAt = performance.now();
setInterval(() => {
  const el = $("perf");
  el.classList.toggle("hidden", !showPerf || !game);
  if (!showPerf || !game) return;
  const dt = (performance.now() - perfAt) / 1000;
  el.textContent = `fps ${(perfFrames / dt).toFixed(0)}  draws ${(perfDraws / dt).toFixed(0)}/s  draw ${(perfDrawMs / Math.max(1, perfDraws)).toFixed(1)}ms\nserver ${(perfTicks / dt).toFixed(1)} ticks/s  scale ${renderer.scale}  q:${quality}\nmap ${game.w}x${game.h}  structs ${game.structs.length}  units ${game.units.length}`;
  perfFrames = perfDraws = perfDrawMs = perfTicks = 0;
  perfAt = performance.now();
}, 1000);
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
      applyQuality();
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
        perfTicks++;
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
    case "chat":
      if (game) {
        const p = game.players.get(m.from);
        const text = CHAT[m.id] ?? "";
        if (p && text) {
          if (m.id < 8) game.emojis.push({ id: m.from, text, born: performance.now() });
          else toast(`${p.name}: ${text}`);
        }
      }
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
