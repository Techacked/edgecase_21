"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SeededRandom = exports.mixSeed = void 0;
/** Mixes a simulation seed with a case index so each case has an independent, size-invariant stream. */
function mixSeed(seed, index) {
    let h = (seed >>> 0) ^ Math.imul(index + 0x9e3779b9, 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return (h ^ (h >>> 16)) >>> 0;
}
exports.mixSeed = mixSeed;
/** mulberry32 PRNG. Deterministic across platforms. */
class SeededRandom {
    state;
    constructor(seed) { this.state = seed >>> 0; }
    next() {
        this.state = (this.state + 0x6d2b79f5) >>> 0;
        let t = this.state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    uniform(min, max) { return min + (max - min) * this.next(); }
    int(min, max) { return Math.floor(this.uniform(min, max + 1)); }
    chance(p) { return this.next() < p; }
    normal(mean, sd) {
        const u1 = Math.max(this.next(), 1e-12);
        const u2 = this.next();
        return mean + sd * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    }
    lognormal(median, sigma) { return Math.exp(this.normal(Math.log(median), sigma)); }
    weighted(items) {
        const total = items.reduce((s, i) => s + i.weight, 0);
        let r = this.next() * total;
        for (const item of items) {
            r -= item.weight;
            if (r < 0)
                return item;
        }
        return items[items.length - 1];
    }
}
exports.SeededRandom = SeededRandom;
