/** Mixes a simulation seed with a case index so each case has an independent, size-invariant stream. */
export function mixSeed(seed: number, index: number): number {
  let h = (seed >>> 0) ^ Math.imul(index + 0x9e3779b9, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** mulberry32 PRNG. Deterministic across platforms. */
export class SeededRandom {
  private state: number;
  constructor(seed: number) { this.state = seed >>> 0; }
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  uniform(min: number, max: number): number { return min + (max - min) * this.next(); }
  int(min: number, max: number): number { return Math.floor(this.uniform(min, max + 1)); }
  chance(p: number): boolean { return this.next() < p; }
  normal(mean: number, sd: number): number {
    const u1 = Math.max(this.next(), 1e-12);
    const u2 = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
  lognormal(median: number, sigma: number): number { return Math.exp(this.normal(Math.log(median), sigma)); }
  weighted<T extends { weight: number }>(items: T[]): T {
    const total = items.reduce((s, i) => s + i.weight, 0);
    let r = this.next() * total;
    for (const item of items) { r -= item.weight; if (r < 0) return item; }
    return items[items.length - 1] as T;
  }
}
