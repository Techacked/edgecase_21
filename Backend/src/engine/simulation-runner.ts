import { AppError } from '../utils/errors';
import { hashObject } from '../utils/hash';
import { detectCliffs, detectEdgeCases } from './boundary-analysis';
import { detectConflicts } from './conflict-analysis';
import { activeRules, evaluateCase, isActiveRule, validateRules } from './constraint-evaluator';
import { analyzeFairness } from './fairness-analysis';
import { generatePopulation } from './synthetic-population';
import type {
  CaseEvaluation, Counts, EngineRule, PolicyModel, SimulationParams, SimulationResult, SyntheticCase,
} from './types';

export type ProgressStage =
  | 'GENERATING_POPULATION' | 'EVALUATING_RULES' | 'DETECTING_EDGE_CASES'
  | 'DETECTING_CLIFFS' | 'DETECTING_CONFLICTS' | 'ANALYZING_FAIRNESS';
const STAGES: ProgressStage[] = [
  'GENERATING_POPULATION', 'EVALUATING_RULES', 'DETECTING_EDGE_CASES', 'DETECTING_CLIFFS', 'DETECTING_CONFLICTS', 'ANALYZING_FAIRNESS',
];
export type ProgressCallback = (stage: ProgressStage, fraction: number) => void;

export interface EngineOptions { maxPopulationSize?: number; onProgress?: ProgressCallback }

export function validateSimulationParams(p: SimulationParams, maxPopulationSize = 100_000): void {
  if (!Number.isInteger(p.populationSize) || p.populationSize < 1) throw new AppError('VALIDATION_ERROR', 'populationSize must be a positive integer');
  if (p.populationSize > maxPopulationSize) throw new AppError('SIMULATION_LIMIT_EXCEEDED', `populationSize ${p.populationSize} exceeds the maximum of ${maxPopulationSize}`);
  if (!Number.isInteger(p.seed)) throw new AppError('VALIDATION_ERROR', 'seed must be an integer');
  if (!['STRESS_TEST', 'BOUNDARY_SCAN', 'FAIRNESS_AUDIT'].includes(p.mode)) throw new AppError('VALIDATION_ERROR', `Unknown mode ${String(p.mode)}`);
}

export function countOutcomes(evals: CaseEvaluation[]): Counts {
  const c: Counts = { eligible: 0, rejected: 0, needsReview: 0, total: evals.length };
  for (const e of evals) {
    if (e.outcome === 'ELIGIBLE') c.eligible++; else if (e.outcome === 'REJECTED') c.rejected++; else c.needsReview++;
  }
  return c;
}

/** Validates rules and returns the executable subset; throws if the rules cannot be simulated. */
export function prepareRules(policy: PolicyModel, rules: EngineRule[]): EngineRule[] {
  const problems = validateRules(rules.filter(isActiveRule), policy);
  if (problems.length) throw new AppError('VALIDATION_ERROR', 'Rules are invalid for this policy', problems);
  const active = activeRules(rules);
  if (!active.some((r) => r.type === 'ELIGIBILITY')) {
    throw new AppError('VALIDATION_ERROR', 'At least one VERIFIED, enabled ELIGIBILITY rule is required to simulate');
  }
  return active;
}

export function evaluatePopulation(cases: SyntheticCase[], rules: EngineRule[]): CaseEvaluation[] {
  return cases.map((c) => evaluateCase(c.caseId, c.attributes, rules));
}

export interface SimulationRun {
  result: SimulationResult;
  cases: SyntheticCase[];
  evaluations: CaseEvaluation[];
}

/** Pure, deterministic, Express-free. Same policy + rules + params => identical result and resultHash. */
export function runSimulation(
  policy: PolicyModel, allRules: EngineRule[], params: SimulationParams, options: EngineOptions = {},
): SimulationRun {
  validateSimulationParams(params, options.maxPopulationSize);
  const rules = prepareRules(policy, allRules);
  const step = (s: ProgressStage) => options.onProgress?.(s, STAGES.indexOf(s) / STAGES.length);

  step('GENERATING_POPULATION');
  const cases = generatePopulation(policy, { size: params.populationSize, seed: params.seed, mode: params.mode, rules });
  step('EVALUATING_RULES');
  const evaluations = evaluatePopulation(cases, rules);
  const counts = countOutcomes(evaluations);

  const reasonCounts = new Map<string, number>();
  for (const e of evaluations) if (e.outcome === 'REJECTED') {
    for (const code of [...e.violatedRules, ...e.exclusionRules]) reasonCounts.set(code, (reasonCounts.get(code) ?? 0) + 1);
  }
  const rejectionReasons = [...reasonCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([ruleCode, count]) => ({ ruleCode, count, share: counts.rejected ? Math.round((count / counts.rejected) * 10000) / 10000 : 0 }));

  step('DETECTING_EDGE_CASES');
  const { edgeCases, counts: edgeCaseCounts } = detectEdgeCases(policy, rules, cases, evaluations);
  step('DETECTING_CLIFFS');
  const cliffs = detectCliffs(policy, rules, cases);
  step('DETECTING_CONFLICTS');
  const conflicts = detectConflicts(policy, rules, cases);
  step('ANALYZING_FAIRNESS');
  const fairness = analyzeFairness(policy, cases, evaluations);
  options.onProgress?.('ANALYZING_FAIRNESS', 1);

  const ignoredRules = allRules.filter((r) => !isActiveRule(r)).map((r) => ({
    ruleCode: r.ruleCode, reason: !r.enabled ? 'disabled' : `verificationStatus=${r.verificationStatus}`,
  }));
  const pct = (n: number) => (counts.total ? Math.round((n / counts.total) * 10000) / 10000 : 0);
  const configHash = hashObject({ policy, rules: rules.map((r) => [r.ruleCode, r.type, r.constraint]), params });
  const resultHash = hashObject({ configHash, outcomes: evaluations.map((e) => [e.caseId, e.outcome]) });

  return {
    cases, evaluations,
    result: {
      meta: {
        dataType: 'SYNTHETIC', synthetic: true, policySlug: policy.slug, ...params,
        activeRuleCodes: rules.map((r) => r.ruleCode), ignoredRules, configHash, resultHash,
      },
      summary: { counts, rates: { eligible: pct(counts.eligible), rejected: pct(counts.rejected), review: pct(counts.needsReview) }, rejectionReasons },
      edgeCases, edgeCaseCounts, cliffs, conflicts, fairness,
    },
  };
}
