import { AppError } from '../utils/errors';
import { activeRules } from './constraint-evaluator';
import { countOutcomes, evaluatePopulation, prepareRules, validateSimulationParams, type EngineOptions } from './simulation-runner';
import { generatePopulation } from './synthetic-population';
import type { Counts, EngineRule, Outcome, PolicyModel, SimulationParams } from './types';

export interface WhatIfRequest { parameter: string; newValue: number }

export interface WhatIfResult {
  dataType: 'SYNTHETIC';
  parameter: string;
  oldValue: number;
  newValue: number;
  seed: number;
  populationSize: number;
  baseline: Counts & { eligibleRate: number };
  changed: Counts & { eligibleRate: number };
  eligibleDelta: number;
  rejectedDelta: number;
  reviewDelta: number;
  affectedCases: {
    count: number;
    transitions: Array<{ from: Outcome; to: Outcome; count: number }>;
    sample: Array<{ caseId: string; before: Outcome; after: Outcome }>;
  };
  budgetImpact: {
    label: 'SIMULATED ESTIMATE';
    currency: string; costPerEligibleCase: number; assumptionDescription: string;
    estimatedCostBefore: number; estimatedCostAfter: number; delta: number;
  };
  methodology: string;
}

export function applyParameterChange(policy: PolicyModel, rules: EngineRule[], parameter: string, newValue: number): { rules: EngineRule[]; oldValue: number } {
  const def = policy.parameters.find((p) => p.key === parameter);
  if (!def) throw new AppError('VALIDATION_ERROR', `Unknown parameter "${parameter}" for policy ${policy.slug}`, [{ available: policy.parameters.map((p) => p.key) }]);
  if (typeof newValue !== 'number' || !Number.isFinite(newValue)) throw new AppError('VALIDATION_ERROR', 'newValue must be a finite number');
  if ((def.min !== undefined && newValue < def.min) || (def.max !== undefined && newValue > def.max)) {
    throw new AppError('VALIDATION_ERROR', `newValue for ${parameter} must be between ${def.min ?? '-∞'} and ${def.max ?? '∞'}`);
  }
  const target = activeRules(rules).find((r) => r.ruleCode === def.ruleCode);
  if (!target || typeof target.constraint.value !== 'number') {
    throw new AppError('VALIDATION_ERROR', `Parameter "${parameter}" is bound to rule ${def.ruleCode}, which is not an active numeric rule`);
  }
  const oldValue = target.constraint.value;
  return { oldValue, rules: rules.map((r) => (r.id === target.id ? { ...r, constraint: { ...r.constraint, value: newValue } } : r)) };
}

/**
 * Runs the real engine twice over ONE synthetic population (generated once from the baseline rules with the
 * given seed). Only the requested parameter differs between the two evaluations.
 */
export function runWhatIf(
  policy: PolicyModel, baselineRules: EngineRule[], req: WhatIfRequest, params: SimulationParams, options: EngineOptions = {},
): WhatIfResult {
  validateSimulationParams(params, options.maxPopulationSize);
  const base = prepareRules(policy, baselineRules);
  const { rules: changedAll, oldValue } = applyParameterChange(policy, base, req.parameter, req.newValue);
  const changed = prepareRules(policy, changedAll);

  const cases = generatePopulation(policy, { size: params.populationSize, seed: params.seed, mode: params.mode, rules: base });
  const before = evaluatePopulation(cases, base);
  const after = evaluatePopulation(cases, changed);
  const cb = countOutcomes(before);
  const ca = countOutcomes(after);

  const transitions = new Map<string, number>();
  const sample: WhatIfResult['affectedCases']['sample'] = [];
  let count = 0;
  before.forEach((b, i) => {
    const a = after[i]!;
    if (a.outcome === b.outcome) return;
    count++;
    const k = `${b.outcome}>${a.outcome}`;
    transitions.set(k, (transitions.get(k) ?? 0) + 1);
    if (sample.length < 100) sample.push({ caseId: b.caseId, before: b.outcome, after: a.outcome });
  });

  const rate = (n: number) => (cb.total ? Math.round((n / cb.total) * 10000) / 10000 : 0);
  const cost = policy.budget.costPerEligibleCase;
  return {
    dataType: 'SYNTHETIC', parameter: req.parameter, oldValue, newValue: req.newValue,
    seed: params.seed, populationSize: params.populationSize,
    baseline: { ...cb, eligibleRate: rate(cb.eligible) }, changed: { ...ca, eligibleRate: rate(ca.eligible) },
    eligibleDelta: ca.eligible - cb.eligible, rejectedDelta: ca.rejected - cb.rejected, reviewDelta: ca.needsReview - cb.needsReview,
    affectedCases: {
      count,
      transitions: [...transitions].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).map(([k, c]) => {
        const [from, to] = k.split('>') as [Outcome, Outcome];
        return { from, to, count: c };
      }),
      sample,
    },
    budgetImpact: {
      label: 'SIMULATED ESTIMATE', currency: policy.budget.currency, costPerEligibleCase: cost,
      assumptionDescription: policy.budget.assumptionDescription,
      estimatedCostBefore: cb.eligible * cost, estimatedCostAfter: ca.eligible * cost, delta: (ca.eligible - cb.eligible) * cost,
    },
    methodology:
      `Baseline and changed scenarios evaluate the same ${params.populationSize} synthetic cases (seed ${params.seed}, mode ${params.mode}) ` +
      `with the same policy version. Only ${req.parameter} (rule ${policy.parameters.find((p) => p.key === req.parameter)?.ruleCode}) changes from ${oldValue} to ${req.newValue}. ` +
      `Cost = eligible cases × costPerEligibleCase over the synthetic population; it is a simulated estimate, not real budget data.`,
  };
}
