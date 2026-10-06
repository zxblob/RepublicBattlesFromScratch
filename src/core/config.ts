/** All gameplay tunables live here so balance can change without touching logic. */
export const CFG = {
  tickMs: 100,

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
  neutralCost: 2,
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
    radar: { cost: 120, range: 14, label: "Radar", desc: "Reveals enemy attack fronts and troop counts", mult: 1 },
  },
  structCostGrowth: 1.25,
} as const;

export type StructType = keyof typeof CFG.structures;
export const STRUCT_TYPES = Object.keys(CFG.structures) as StructType[];
