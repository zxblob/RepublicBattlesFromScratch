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
    factory: { cost: 250, range: 0, label: "Factory", desc: "Gold income; link it to Cities and Ports with Rails", mult: 1 },
    port: { cost: 150, range: 0, label: "Port", desc: "Coastal gold income; trains boats", mult: 1 },
    city: { cost: 220, range: 0, label: "City", desc: "More troop capacity and gold", mult: 1 },
    farm: { cost: 120, range: 0, label: "Farm", desc: "Faster troop regeneration", mult: 1 },
    lab: { cost: 200, range: 0, label: "Research Lab", desc: "Research points (World War modes)", mult: 1 },
    silo: { cost: 400, range: 0, label: "Missile Silo", desc: "Launch missiles at any tile", mult: 1 },
    spaceport: { cost: 800, range: 0, label: "Spaceport", desc: "Launch to the planets (War of the Worlds)", mult: 1 },
    radar: { cost: 120, range: 14, label: "Radar", desc: "Reveals enemy attack fronts and troop counts", mult: 1 },
  },
  structCostGrowth: 1.25,

  // missiles (kinds in MISSILES below)
  missileCost: 250,
  siloCooldown: 600,
  missileRadius: 3,
  missileTroopShare: 0.25,
  samIntercept: 0.7,

  // factory, rails, trade
  factoryGold: 0.1,
  railTileCost: 1.5,
  railGold: 0.08, // per link (node-1) per tick on a connected rail network
  maxRailTilesPerDraw: 120,
  tradeEvery: 600,
  tradeBase: 0.6,
  tradePerTile: 0.012,
  maxTradeShips: 4,
  tradeSpeed: 0.55,
  tradeHp: 40,

  // victory timers
  domShare: 0.35,
  domRatio: 1.5,
  domTicks: 3000,
  maxTicks: 72000,

  // World War modes
  coldShare: 0.7,
  coldHold: 30, // checks of 10 ticks (30 s)
  coldTicks: 3000, // 5 minutes
  spaceShare: 0.55,

  // naval
  transportCost: 40,
  warshipCost: 120,
  boatsPerPort: 3,
  transportSpeed: 0.5,
  warshipSpeed: 0.45,
  transportHp: 50,
  warshipHp: 150,
  warshipDmg: 4,
  warshipRange: 3.5,
  landingRadius: 3,

  // economy buildings
  cityCap: 25,
  cityGold: 0.04,
  farmRegen: 0.08,
  portGold: 0.12,
  labRp: 0.05,
  rpPerTile: 0.0004,

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

/** Research tree for World War modes. Costs are research points. */
export const TECH = {
  econ1: { branch: "Economy", label: "Trade routes", cost: 80, req: "", desc: "+15% gold" },
  econ2: { branch: "Economy", label: "Banking", cost: 200, req: "econ1", desc: "+25% gold, banks pay double" },
  econ3: { branch: "Economy", label: "Megacities", cost: 400, req: "econ2", desc: "+25% max troops" },
  mil1: { branch: "Military", label: "Conscription", cost: 80, req: "", desc: "+20% max troops" },
  mil2: { branch: "Military", label: "Combined arms", cost: 200, req: "mil1", desc: "Your attacks cost 10% less" },
  mil3: { branch: "Military", label: "Blitz doctrine", cost: 400, req: "mil2", desc: "+25% troop regeneration" },
  def1: { branch: "Defence", label: "Fortification", cost: 80, req: "", desc: "Your land costs 15% more to take" },
  def2: { branch: "Defence", label: "Deep bunkers", cost: 200, req: "def1", desc: "Bunkers are much stronger" },
  def3: { branch: "Defence", label: "Air defence", cost: 400, req: "def2", desc: "SAMs deal 60% more damage" },
  space1: { branch: "Space", label: "Rocketry", cost: 600, req: "mil3", desc: "Unlocks the Spaceport" },
  space2: { branch: "Space", label: "Orbital lasers", cost: 900, req: "space1", desc: "On planets: your attacks cost 20% less" },
  space3: { branch: "Space", label: "Planetary shields", cost: 900, req: "space1", desc: "On planets: your land costs 30% more to take" },
} as const;
export type TechId = keyof typeof TECH;
export const TECH_IDS = Object.keys(TECH) as TechId[];

export const MISSILES = {
  atom: { label: "Atom bomb", cost: 250, radius: 3, share: 0.25, cd: 600 },
  hydrogen: { label: "Hydrogen bomb", cost: 700, radius: 6, share: 0.45, cd: 1500 },
  mirv: { label: "MIRV", cost: 1400, radius: 3, share: 0.25, cd: 2400 },
} as const;
export type MissileKind = keyof typeof MISSILES;
