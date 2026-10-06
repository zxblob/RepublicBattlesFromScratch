import { CFG, MISSILES, MissileKind, StructType } from "../core/config";
import { fmt } from "./format";

export interface Info {
  title: string;
  /** one-line category, e.g. "Economy" */
  tag?: string;
  lines: string[];
  /** e.g. "Cost 20K gold" */
  cost?: string;
  /** warning shown in red, e.g. a missing requirement */
  warn?: string;
}

const pct = (x: number) => Math.round(x * 100) + "%";
const perSec = (perTick: number) => fmt(perTick * 10);
const secs = (ticks: number) => Math.round(ticks / 10) + "s";

export function structInfo(type: StructType, cost?: number, owned?: number): Info {
  const S = CFG.structures[type];
  const base: Record<StructType, { tag: string; lines: string[] }> = {
    bunker: { tag: "Defence", lines: [
      `Enemy attacks on your tiles within ${S.range} tiles cost ${pct(CFG.structures.bunker.mult - 1)} more troops.`,
      "The Deep bunkers research raises this to +120%.",
    ] },
    barracks: { tag: "Offence", lines: [`Your attacks on tiles within ${S.range} tiles cost ${pct(1 - CFG.structures.barracks.mult)} less.`] },
    bank: { tag: "Economy", lines: [`+${perSec(CFG.bankGold)} gold per second.`, "Doubles with the Banking research."] },
    radar: { tag: "Intel", lines: [
      `Shows enemy attack fronts and their troop counts within ${S.range} tiles.`,
      "Without a Radar you only see who is invading you, not how strong they are.",
    ] },
    tankfactory: { tag: "Production", lines: [
      `Trains Tanks (${fmt(CFG.tankCost)} gold each, max ${CFG.tanksPerFactory} per factory).`,
      `Tanks make your attacks within ${CFG.tankRange} tiles ${pct(1 - CFG.tankMult)} cheaper and break enemy walls.`,
    ] },
    airbase: { tag: "Production", lines: [
      `Trains Fighters (${fmt(CFG.fighterCost)}) and Bombers (${fmt(CFG.bomberCost)}), max ${CFG.planesPerBase} of each per base.`,
      "Fighters shoot down enemy aircraft. Bombers wreck enemy buildings, then fly home here to rearm.",
    ] },
    sam: { tag: "Defence", lines: [
      `Range ${S.range} tiles: damages enemy aircraft there.`,
      `Each missile aimed inside the range has a ${pct(CFG.samIntercept)} chance to be shot down.`,
    ] },
    factory: { tag: "Economy · rail station", lines: [
      `+${perSec(CFG.factoryGold)} gold per second.`,
      "Link Factories, Cities and Ports with Rails: trains shuttle between them and pay gold on every arrival.",
    ] },
    port: { tag: "Economy · coast only", lines: [
      `+${perSec(CFG.portGold)} gold per second.`,
      "Trains Transports (land troops from the sea) and Warships, and sends Trade ships to other ports for gold.",
      "Also a rail station.",
    ] },
    city: { tag: "Economy · rail station", lines: [
      `+${fmt(CFG.cityCap)} max troops and +${perSec(CFG.cityGold)} gold per second.`,
      "Link it to other stations with Rails.",
    ] },
    farm: { tag: "Economy", lines: [`+${perSec(CFG.farmRegen)} troops per second of regeneration.`] },
    lab: { tag: "Research · World War modes", lines: [`+${(CFG.labRp * 10).toFixed(1)} research points per second.`, "Spend points in the 🔬 Research panel once the Cold War begins."] },
    silo: { tag: "Strategic", lines: [
      "Launches missiles at any tile. Pick the type on the toolbar or in the radial menu.",
      `Atom: radius ${MISSILES.atom.radius}, reload ${secs(MISSILES.atom.cd)}. Hydrogen: radius ${MISSILES.hydrogen.radius}, reload ${secs(MISSILES.hydrogen.cd)}. MIRV: 6 warheads, reload ${secs(MISSILES.mirv.cd)}.`,
    ] },
    spaceport: { tag: "Space Race", lines: ["Needs the Rocketry research during the Space Race.", "Launches your whole team to a planet."] },
  };
  const b = base[type];
  const lines = [...b.lines];
  if (owned) lines.push(`You own ${owned}. Each extra costs ${pct(CFG.structCostGrowth - 1)} more.`);
  return { title: S.label, tag: b.tag, lines, cost: cost !== undefined ? `Cost ${fmt(cost)} gold` : undefined };
}

export function unitInfo(kind: "t" | "f" | "b" | "x" | "w"): Info {
  const m = {
    t: { title: "Tank", cost: CFG.tankCost, tag: "Needs a Tank Factory", lines: [
      "Select it, then draw a route or tap a spot.",
      `Your attacks within ${CFG.tankRange} tiles cost ${pct(1 - CFG.tankMult)} less. Breaks enemy walls.`,
      "Can't cross water or mountains; takes damage on enemy land.",
    ] },
    f: { title: "Fighter", cost: CFG.fighterCost, tag: "Needs an Airbase", lines: [
      "Fast aircraft: draw a route; it flies over anything.",
      `Damages enemy aircraft within ${CFG.fighterRange} tiles.`,
    ] },
    b: { title: "Bomber", cost: CFG.bomberCost, tag: "Needs an Airbase", lines: [
      `${CFG.bomberAmmo} bombs, dropped automatically over enemy land.`,
      `Each bomb destroys enemy buildings and walls within ${CFG.bombRadius} tiles and cuts the defender's troops by ${pct(CFG.bombTroopShare)}.`,
      "Flies home to an Airbase to rearm.",
    ] },
    x: { title: "Transport", cost: CFG.transportCost, tag: "Needs a Port", lines: [
      "Select it and tap a coast. The troop slider sets how many it carries.",
      "It lands them and attacks inland. Can be sunk by warships.",
    ] },
    w: { title: "Warship", cost: CFG.warshipCost, tag: "Needs a Port", lines: [`Sinks enemy boats within ${CFG.warshipRange} tiles.`, "Select it and tap the sea to sail."] },
  }[kind];
  return { title: m.title, tag: m.tag, lines: m.lines, cost: `Cost ${fmt(m.cost)} gold (max ${kind === "t" ? CFG.tanksPerFactory : CFG.planesPerBase} per building)` };
}

export function missileInfo(k: MissileKind): Info {
  const M = MISSILES[k];
  return {
    title: M.label,
    tag: "Needs a Missile Silo",
    lines: [
      k === "mirv" ? "Splits into 6 warheads that land within 9 tiles of the target." : `Blast radius ${M.radius} tiles.`,
      `Hit land becomes neutral; the defender loses ${pct(M.share)} of their troops; units and walls in the blast are destroyed.`,
      `SAM Launchers near the target can shoot it down. Silo reload ${secs(M.cd)}.`,
    ],
    cost: `Cost ${fmt(M.cost)} gold`,
  };
}

export function toolInfo(name: "draw" | "wall" | "rail" | "home" | "cancel"): Info {
  switch (name) {
    case "draw": return { title: "Draw mode", tag: "Attack", lines: ["Drag with a finger to draw the area you want to invade (it must touch your land).", "Pencil and mouse always draw. The slider sets how many troops you commit."] };
    case "wall": return { title: "Wall", tag: "Defence", lines: [
      `Draw a line on your own flat land. Each tile costs ${fmt(CFG.wallTileCost)} gold and has ${CFG.wallHp} hit points.`,
      "Enemies can't capture wall tiles until Tanks, bombers or missiles break them.",
    ] };
    case "rail": return { title: "Rail", tag: "Economy", lines: [
      "Draw a line from one City, Factory or Port to another. The ends snap onto nearby buildings.",
      "Trains shuttle along connected lines and pay gold on every arrival:",
      `${fmt(CFG.trainFarePerTile)} per tile of track, +50% when the two stations belong to different nations.`,
      "Rails can run across an ally's land to link your bases with theirs.",
    ], cost: `${fmt(CFG.railTileCost)} gold per tile` };
    case "home": return { title: "Centre on capital", lines: ["Jump the camera back to your capital."] };
    case "cancel": return { title: "Cancel attacks", lines: ["Retreat from every running attack; unspent troops come back."] };
  }
}

export function actionInfo(name: string): Info | null {
  const m: Record<string, Info> = {
    Economy: { title: "Economy", lines: ["Banks, Cities, Farms, Ports, Factories and Labs."] },
    Military: { title: "Military", lines: ["Bunkers, Barracks, SAMs, Tank Factories, Airbases and Silos."] },
    Space: { title: "Space", lines: ["Spaceport for the Space Race."] },
    Expand: { title: "Expand", lines: ["Quick attack: sends troops from your nearest border to this spot.", "Uses the troop slider."] },
    Attack: { title: "Attack", lines: ["Quick attack on this nation from your nearest border.", "Uses the troop slider; for precise attacks draw an area instead."] },
    Missile: { title: "Missile", lines: ["Choose a missile type to fire at this spot. Needs a Missile Silo."] },
    Ally: { title: "Ally", lines: ["Propose an alliance. Both sides must agree (bots sometimes accept).", "Allies can't attack each other, share rails and can donate."] },
    Accept: { title: "Accept alliance", lines: ["They proposed an alliance to you."] },
    Embargo: { title: "Embargo", lines: ["Stops trade ships between you and this nation."] },
    "Lift embargo": { title: "Lift embargo", lines: ["Allow trade with this nation again."] },
    "Give troops": { title: "Give troops", lines: ["Gives 25% of your troops to this ally (up to their capacity)."] },
    "Give gold": { title: "Give gold", lines: ["Gives 25% of your gold to this ally."] },
    Break: { title: "Break alliance", lines: ["Ends the alliance. Shared rail lines stop working."] },
    Wall: toolInfo("wall"),
    Rail: toolInfo("rail"),
  };
  return m[name] ?? null;
}
