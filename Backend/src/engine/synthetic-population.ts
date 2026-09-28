import { mixSeed, SeededRandom } from '../utils/seed-random';
import { activeRules } from './constraint-evaluator';
import type {
  AttributeValue, CaseAttributes, EngineRule, PolicyModel, SimulationMode, SyntheticCase, VariableDef,
} from './types';

export const variableStep = (v: VariableDef): number => v.step ?? Math.pow(10, -(v.decimals ?? 0));

function shape(v: VariableDef, raw: number): number {
  const f = Math.pow(10, v.decimals ?? 0);
  let x = Math.round(raw * f) / f;
  if (v.min !== undefined) x = Math.max(v.min, x);
  if (v.max !== undefined) x = Math.min(v.max, x);
  return x;
}

function sample(v: VariableDef, rng: SeededRandom): AttributeValue {
  if (v.type === 'boolean') return rng.chance(v.trueProbability ?? 0.5);
  if (v.type === 'categorical') return rng.weighted(v.categories ?? []).value;
  const d = v.distribution ?? { kind: 'uniform' as const };
  let raw: number;
  if (d.kind === 'normal') raw = rng.normal(d.mean, d.sd);
  else if (d.kind === 'lognormal') raw = rng.lognormal(d.median, d.sigma);
  else raw = rng.uniform(v.min ?? 0, v.max ?? 100);
  return shape(v, raw);
}

export interface ThresholdTarget { variable: VariableDef; threshold: number }

/** Numeric threshold constraints of active rules, used to concentrate cases near boundaries. */
export function thresholdTargets(policy: PolicyModel, rules: EngineRule[]): ThresholdTarget[] {
  const out: ThresholdTarget[] = [];
  for (const r of activeRules(rules)) {
    const v = policy.variables.find((x) => x.name === r.constraint.variable);
    if (v?.type === 'number' && typeof r.constraint.value === 'number' && ['<', '<=', '>', '>='].includes(r.constraint.operator)) {
      out.push({ variable: v, threshold: r.constraint.value });
    }
  }
  return out;
}

export interface PopulationOptions { size: number; seed: number; mode: SimulationMode; rules: EngineRule[] }

/**
 * Deterministic synthetic population. Each case draws from its own stream mixSeed(seed, index),
 * so case i is identical regardless of population size.
 *  - STRESS_TEST:    natural distributions
 *  - BOUNDARY_SCAN:  ~30% of cases are pulled to within +-3 steps of an active numeric threshold
 *  - FAIRNESS_AUDIT: cases stratified evenly across the policy's income bands
 */
export function generatePopulation(policy: PolicyModel, opts: PopulationOptions): SyntheticCase[] {
  const targets = opts.mode === 'BOUNDARY_SCAN' ? thresholdTargets(policy, opts.rules) : [];
  const edges = policy.fairness.bandEdges;
  const bandVar = policy.variables.find((v) => v.name === policy.fairness.bandVariable);
  const cases: SyntheticCase[] = [];
  for (let i = 0; i < opts.size; i++) {
    const rng = new SeededRandom(mixSeed(opts.seed, i));
    const attributes: CaseAttributes = {};
    for (const v of policy.variables) attributes[v.name] = sample(v, rng);
    if (opts.mode === 'BOUNDARY_SCAN' && targets.length) {
      const pick = rng.next();
      const offset = rng.int(-3, 3);
      if (pick < 0.3) {
        const t = targets[Math.floor(rng.next() * targets.length)] as ThresholdTarget;
        attributes[t.variable.name] = shape(t.variable, t.threshold + offset * variableStep(t.variable));
      }
    }
    if (opts.mode === 'FAIRNESS_AUDIT' && bandVar && edges.length) {
      const b = i % edges.length;
      const lo = edges[b] as number;
      const hi = edges[b + 1] ?? bandVar.max ?? lo * 2;
      attributes[bandVar.name] = shape(bandVar, rng.uniform(lo, hi));
    }
    cases.push({ caseId: `SYN-${String(i + 1).padStart(6, '0')}`, index: i, synthetic: true, attributes });
  }
  return cases;
}
