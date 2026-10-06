/** Deterministic PRNG (mulberry32). The simulation must never touch Math.random. */
export interface Rng {
  (): number;
  getState(): number;
  setState(n: number): void;
}

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  const fn = (() => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }) as Rng;
  fn.getState = () => a;
  fn.setState = (n: number) => { a = n >>> 0; };
  return fn;
}
