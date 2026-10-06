/** All gameplay tunables live here so balance can change without touching logic. */
export const CFG = {
  tickMs: 100,
  /** UI-only multiplier so numbers read in thousands like the original game */
  displayScale: 100,

  // economy
  startTroops: 120,
  baseCap: 100,
  capPerTile: 12,
  regenBase: 0.1,
  regenPerTile: 0.005,
  regenGrowth: 0.002,
  goldBase: 0.03,
  goldPerTile: 0.002,
  bankGold: 0.15,

  // combat
  neutralCost: 0.8,
  /** multiplier on the cost of taking player-owned tiles (lower = troops capture more) */
  playerCostMult: 0.65,
  tilesPerTickShare: 0.3,
  maxTilesPerTick: 24,
  mountainMult: 2.2,
  minDensity: 1,
  defenderLossShare: 0.6,
  maxAttacksPerPlayer: 4,
  maxRegionTiles: 8000,
  maxPolyPoints: 400,
  stallTicks: 25,

  // anti-snowball: the smaller you are, the harder each of your tiles is to take
  smallTiles: 120,
  smallBonusMax: 2, // up to +200% cost at 0 tiles
  // last stand: tiles near the capital are extremely costly to take
  capitalRadius: 2,
  capitalMult: 5,
  lastStandTiles: 80,
  lastStandRegen: 0.3,

  // bot pile-on limits
  botMaxAttackersPerTarget: 2,
  botPlayerCooldown: 200, // ticks between a bot's attacks on players
  botMaxRatioVsPlayer: 0.4,
  botMaxRatioVsSmall: 0.2,

  // spawn
  spawnRadius2: 10,

  structures: {
    bunker: { cost: 100, range: 7, label: "Bunker", desc: "Tiles in range cost 60% more to take", mult: 1.6 },
    barracks: { cost: 150, range: 9, label: "Barracks", desc: "Your attacks in range cost 25% less", mult: 0.75 },
    bank: { cost: 200, range: 0, label: "Bank", desc: "Extra gold income", mult: 1 },
    tankfactory: { cost: 150, range: 0, label: "Tank Factory", desc: "Lets you train tanks (max 3 per factory)", mult: 1 },
    airbase: { cost: 200, range: 0, label: "Airbase", desc: "Trains Fighters and Bombers (max 3 of each per base)", mult: 1 },
    sam: { cost: 180, range: 9, label: "SAM Launcher", desc: "Shoots down enemy aircraft in range", mult: 1 },
    radar: { cost: 120, range: 14, label: "Radar", desc: "Reveals enemy attack fronts and troop counts", mult: 1 },
  },
  structCostGrowth: 1.25,

  // tanks and walls
  tankCost: 60,
  tanksPerFactory: 3,
  tankSpeed: 0.35, // tiles per tick
  tankHp: 100,
  tankOverrunDmg: 3, // hp lost per tick while standing on enemy land
  tankWallDmg: 3, // wall hp removed per tick while adjacent
  tankRange: 6, // tiles around a tank where your attacks are cheaper
  tankMult: 0.8,
  wallTileCost: 3,
  wallHp: 150,
  maxWallTilesPerDraw: 80,
  maxTankPathPoints: 60,

  // aircraft
  fighterCost: 50,
  bomberCost: 80,
  planesPerBase: 3,
  fighterSpeed: 0.8,
  bomberSpeed: 0.5,
  fighterHp: 100,
  bomberHp: 60,
  fighterDmg: 4, // hp per tick to enemy aircraft within fighterRange
  fighterRange: 2.5,
  samDmg: 2.5, // hp per tick to enemy aircraft inside a SAM's range
  bomberAmmo: 3,
  bombCooldown: 12,
  bombRadius: 2,
  bombTroopShare: 0.04,
} as const;

export type StructType = keyof typeof CFG.structures;
export const STRUCT_TYPES = Object.keys(CFG.structures) as StructType[];
