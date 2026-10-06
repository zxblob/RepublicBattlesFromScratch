import { CFG } from "../core/config";

/** Simulation numbers are small; show them x displayScale and abbreviated (12,400 -> "12.4K"). */
export function fmt(n: number): string {
  const v = Math.floor(n * CFG.displayScale);
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(v >= 10_000_000 ? 1 : 2).replace(/\.?0+$/, "") + "M";
  if (v >= 10_000) return (v / 1000).toFixed(v >= 100_000 ? 0 : 1).replace(/\.0$/, "") + "K";
  return v.toLocaleString();
}
