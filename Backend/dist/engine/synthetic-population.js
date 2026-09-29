"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generatePopulation = exports.thresholdTargets = exports.variableStep = void 0;
const seed_random_1 = require("../utils/seed-random");
const constraint_evaluator_1 = require("./constraint-evaluator");
const variableStep = (v) => v.step ?? Math.pow(10, -(v.decimals ?? 0));
exports.variableStep = variableStep;
function shape(v, raw) {
    const f = Math.pow(10, v.decimals ?? 0);
    let x = Math.round(raw * f) / f;
    if (v.min !== undefined)
        x = Math.max(v.min, x);
    if (v.max !== undefined)
        x = Math.min(v.max, x);
    return x;
}
function sample(v, rng) {
    if (v.type === 'boolean')
        return rng.chance(v.trueProbability ?? 0.5);
    if (v.type === 'categorical')
        return rng.weighted(v.categories ?? []).value;
    const d = v.distribution ?? { kind: 'uniform' };
    let raw;
    if (d.kind === 'normal')
        raw = rng.normal(d.mean, d.sd);
    else if (d.kind === 'lognormal')
        raw = rng.lognormal(d.median, d.sigma);
    else
        raw = rng.uniform(v.min ?? 0, v.max ?? 100);
    return shape(v, raw);
}
/** Numeric threshold constraints of active rules, used to concentrate cases near boundaries. */
function thresholdTargets(policy, rules) {
    const out = [];
    for (const r of (0, constraint_evaluator_1.activeRules)(rules)) {
        const v = policy.variables.find((x) => x.name === r.constraint.variable);
        if (v?.type === 'number' && typeof r.constraint.value === 'number' && ['<', '<=', '>', '>='].includes(r.constraint.operator)) {
            out.push({ variable: v, threshold: r.constraint.value });
        }
    }
    return out;
}
exports.thresholdTargets = thresholdTargets;
/**
 * Deterministic synthetic population. Each case draws from its own stream mixSeed(seed, index),
 * so case i is identical regardless of population size.
 *  - STRESS_TEST:    natural distributions
 *  - BOUNDARY_SCAN:  ~30% of cases are pulled to within +-3 steps of an active numeric threshold
 *  - FAIRNESS_AUDIT: cases stratified evenly across the policy's income bands
 */
function generatePopulation(policy, opts) {
    const targets = opts.mode === 'BOUNDARY_SCAN' ? thresholdTargets(policy, opts.rules) : [];
    const edges = policy.fairness.bandEdges;
    const bandVar = policy.variables.find((v) => v.name === policy.fairness.bandVariable);
    const cases = [];
    for (let i = 0; i < opts.size; i++) {
        const rng = new seed_random_1.SeededRandom((0, seed_random_1.mixSeed)(opts.seed, i));
        const attributes = {};
        for (const v of policy.variables)
            attributes[v.name] = sample(v, rng);
        if (opts.mode === 'BOUNDARY_SCAN' && targets.length) {
            const pick = rng.next();
            const offset = rng.int(-3, 3);
            if (pick < 0.3) {
                const t = targets[Math.floor(rng.next() * targets.length)];
                attributes[t.variable.name] = shape(t.variable, t.threshold + offset * (0, exports.variableStep)(t.variable));
            }
        }
        if (opts.mode === 'FAIRNESS_AUDIT' && bandVar && edges.length) {
            const b = i % edges.length;
            const lo = edges[b];
            const hi = edges[b + 1] ?? bandVar.max ?? lo * 2;
            attributes[bandVar.name] = shape(bandVar, rng.uniform(lo, hi));
        }
        cases.push({ caseId: `SYN-${String(i + 1).padStart(6, '0')}`, index: i, synthetic: true, attributes });
    }
    return cases;
}
exports.generatePopulation = generatePopulation;
