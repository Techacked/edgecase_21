import { describe, expect, it } from 'vitest';
import { runSimulation, runWhatIf, applyParameterChange } from '../../src/engine';
import { AppError } from '../../src/utils/errors';
import { load, mkRule, SLUGS } from '../fixtures/policies';

const P = { populationSize: 3000, seed: 12345, mode: 'STRESS_TEST' as const };

describe('runSimulation', () => {
  it('is reproducible: same policy + config + seed => identical hashes and results', () => {
    const { policy, rules } = load(SLUGS[0]!);
    const a = runSimulation(policy, rules, P).result;
    const b = runSimulation(policy, rules, P).result;
    expect(a).toEqual(b);
    expect(a.meta.resultHash).toBe(b.meta.resultHash);
  });
  it('different seed produces different results', () => {
    const { policy, rules } = load(SLUGS[0]!);
    const a = runSimulation(policy, rules, P).result;
    const b = runSimulation(policy, rules, { ...P, seed: 999 }).result;
    expect(a.meta.resultHash).not.toBe(b.meta.resultHash);
  });
  it('carries synthetic markers and meta', () => {
    const { policy, rules } = load(SLUGS[0]!);
    const r = runSimulation(policy, rules, P).result;
    expect(r.meta).toMatchObject({ dataType: 'SYNTHETIC', synthetic: true, seed: 12345, populationSize: 3000, mode: 'STRESS_TEST' });
    expect(r.summary.counts.total).toBe(3000);
    expect(r.summary.counts.eligible + r.summary.counts.rejected + r.summary.counts.needsReview).toBe(3000);
  });
  it('unverified rules do not execute and are reported as ignored', () => {
    const { policy, rules } = load(SLUGS[0]!);
    const modified = rules.map((r) => (r.ruleCode === 'SCH-CGPA' ? { ...r, verificationStatus: 'NEEDS_REVIEW' as const } : r));
    const withAll = runSimulation(policy, rules, P).result;
    const without = runSimulation(policy, modified, P).result;
    expect(without.meta.activeRuleCodes).not.toContain('SCH-CGPA');
    expect(without.meta.ignoredRules).toEqual([{ ruleCode: 'SCH-CGPA', reason: 'verificationStatus=NEEDS_REVIEW' }]);
    expect(without.summary.counts.eligible).toBeGreaterThan(withAll.summary.counts.eligible);
  });
  it('rejection reasons are computed and sorted', () => {
    const { policy, rules } = load(SLUGS[0]!);
    const r = runSimulation(policy, rules, P).result.summary.rejectionReasons;
    expect(r.length).toBeGreaterThan(0);
    for (let i = 1; i < r.length; i++) expect(r[i - 1]!.count).toBeGreaterThanOrEqual(r[i]!.count);
  });
  it('enforces population limit and validates params', () => {
    const { policy, rules } = load(SLUGS[0]!);
    expect(() => runSimulation(policy, rules, { ...P, populationSize: 101 }, { maxPopulationSize: 100 })).toThrow(expect.objectContaining({ code: 'SIMULATION_LIMIT_EXCEEDED' }));
    expect(() => runSimulation(policy, rules, { ...P, populationSize: 0 })).toThrow(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(() => runSimulation(policy, rules, { ...P, seed: 1.5 })).toThrow(AppError);
    expect(() => runSimulation(policy, rules, { ...P, mode: 'NOPE' as never })).toThrow(AppError);
  });
  it('refuses to run with no active eligibility rule or invalid rules', () => {
    const { policy, rules } = load(SLUGS[0]!);
    expect(() => runSimulation(policy, rules.map((r) => ({ ...r, verificationStatus: 'NEEDS_REVIEW' as const })), P)).toThrow(/ELIGIBILITY/);
    expect(() => runSimulation(policy, [...rules, mkRule('BAD', 'ELIGIBILITY', { variable: 'ghost', operator: '<', value: 1 })], P)).toThrow(/invalid/);
  });
  it('reports progress through every stage', () => {
    const { policy, rules } = load(SLUGS[0]!);
    const stages: string[] = [];
    runSimulation(policy, rules, { ...P, populationSize: 100 }, { onProgress: (s) => stages.push(s) });
    expect(new Set(stages).size).toBe(6);
  });
  it('all three policies run with their own rules and distinct results', () => {
    const codes = new Set<string>();
    const rates: number[] = [];
    for (const slug of SLUGS) {
      const { policy, rules } = load(slug);
      const r = runSimulation(policy, rules, P).result;
      r.meta.activeRuleCodes.forEach((c) => codes.add(c));
      rates.push(r.summary.rates.eligible);
      expect(r.meta.policySlug).toBe(slug);
      expect(r.summary.counts.eligible).toBeGreaterThan(0);
    }
    expect(codes.size).toBe(13);
    expect(new Set(rates).size).toBe(3);
  });
});

describe('what-if', () => {
  const { policy, rules } = load(SLUGS[0]!);
  it('baseline equals a plain simulation on the same seed (same population)', () => {
    const w = runWhatIf(policy, rules, { parameter: 'incomeThreshold', newValue: 600_000 }, P);
    const plain = runSimulation(policy, rules, P).result.summary.counts;
    expect(w.baseline).toMatchObject({ eligible: plain.eligible, rejected: plain.rejected, needsReview: plain.needsReview });
    expect(w.oldValue).toBe(500_000);
  });
  it('relaxing the threshold only adds eligible cases; deltas reconcile', () => {
    const w = runWhatIf(policy, rules, { parameter: 'incomeThreshold', newValue: 600_000 }, P);
    expect(w.eligibleDelta).toBeGreaterThan(0);
    expect(w.eligibleDelta + w.rejectedDelta + w.reviewDelta).toBe(0);
    expect(w.affectedCases.count).toBe(w.affectedCases.transitions.reduce((s, t) => s + t.count, 0));
    expect(w.affectedCases.transitions.every((t) => t.from === 'REJECTED')).toBe(true);
    expect(w.budgetImpact).toMatchObject({ label: 'SIMULATED ESTIMATE', delta: w.eligibleDelta * 50_000 });
    expect(w.budgetImpact.estimatedCostAfter - w.budgetImpact.estimatedCostBefore).toBe(w.budgetImpact.delta);
  });
  it('tightening reduces eligibility; no-op change has zero deltas; deterministic', () => {
    expect(runWhatIf(policy, rules, { parameter: 'minCgpa', newValue: 8 }, P).eligibleDelta).toBeLessThan(0);
    const same = runWhatIf(policy, rules, { parameter: 'incomeThreshold', newValue: 500_000 }, P);
    expect([same.eligibleDelta, same.affectedCases.count]).toEqual([0, 0]);
    expect(runWhatIf(policy, rules, { parameter: 'minCgpa', newValue: 8 }, P)).toEqual(runWhatIf(policy, rules, { parameter: 'minCgpa', newValue: 8 }, P));
  });
  it('uses the same population in BOUNDARY_SCAN mode too', () => {
    const p = { ...P, mode: 'BOUNDARY_SCAN' as const };
    const w = runWhatIf(policy, rules, { parameter: 'incomeThreshold', newValue: 500_010 }, p);
    expect(w.baseline.eligible).toBe(runSimulation(policy, rules, p).result.summary.counts.eligible);
    expect(w.eligibleDelta).toBeGreaterThan(0);
  });
  it('rejects unknown params, out-of-range values and inactive target rules', () => {
    expect(() => runWhatIf(policy, rules, { parameter: 'nope', newValue: 1 }, P)).toThrow(/Unknown parameter/);
    expect(() => runWhatIf(policy, rules, { parameter: 'minCgpa', newValue: 11 }, P)).toThrow(/between/);
    expect(() => runWhatIf(policy, rules, { parameter: 'minCgpa', newValue: NaN }, P)).toThrow(AppError);
    const off = rules.map((r) => (r.ruleCode === 'SCH-CGPA' ? { ...r, verificationStatus: 'NEEDS_REVIEW' as const } : r));
    expect(() => applyParameterChange(policy, off, 'minCgpa', 8)).toThrow(/not an active numeric rule/);
  });
  it('each policy exposes its own parameters', () => {
    expect(load(SLUGS[2]!).policy.parameters.map((p) => p.key)).toContain('maxElectricityUnits');
    const l = load(SLUGS[2]!);
    const w = runWhatIf(l.policy, l.rules, { parameter: 'maxElectricityUnits', newValue: 3000 }, P);
    expect(w.eligibleDelta).toBeGreaterThan(0);
  });
});
