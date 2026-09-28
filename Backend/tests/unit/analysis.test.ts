import { describe, expect, it } from 'vitest';
import { analyzeFairness, detectCliffs, detectConflicts, detectEdgeCases, evaluatePopulation, generatePopulation, runSimulation } from '../../src/engine';
import { load, mkRule, SLUGS } from '../fixtures/policies';

const setup = (slug: string, size = 3000, mode: 'STRESS_TEST' | 'BOUNDARY_SCAN' = 'STRESS_TEST') => {
  const { policy, rules } = load(slug);
  const cases = generatePopulation(policy, { size, seed: 42, mode, rules });
  return { policy, rules, cases, evals: evaluatePopulation(cases, rules) };
};

describe('cliff detection', () => {
  it('finds the income cliff 500000 -> 500001 from actual evaluation', () => {
    const { policy, rules, cases } = setup(SLUGS[0]!);
    const c = detectCliffs(policy, rules, cases).find((x) => x.ruleCode === 'SCH-INC')!;
    expect(c).toMatchObject({ variable: 'income', beforeValue: 500_000, afterValue: 500_001, outcomeBefore: 'ELIGIBLE', outcomeAfter: 'REJECTED', delta: 1 });
    expect(c.exposedCases).toBeGreaterThan(0);
  });
  it('cliff for >= rules steps downward', () => {
    const { policy, rules, cases } = setup(SLUGS[0]!);
    const c = detectCliffs(policy, rules, cases).find((x) => x.ruleCode === 'SCH-CGPA')!;
    expect(c).toMatchObject({ beforeValue: 7, afterValue: 6.9 });
  });
  it('cliff count is computed, not fixed: removing a rule removes its cliff', () => {
    const { policy, rules, cases } = setup(SLUGS[0]!);
    const all = detectCliffs(policy, rules, cases);
    const fewer = detectCliffs(policy, rules.map((r) => (r.ruleCode === 'SCH-CGPA' ? { ...r, enabled: false } : r)), cases);
    expect(fewer.length).toBe(all.length - 1);
    expect(fewer.some((c) => c.ruleCode === 'SCH-CGPA')).toBe(false);
  });
  it('each policy yields cliffs only for its own numeric thresholds', () => {
    for (const [slug, codes] of [[SLUGS[2]!, ['LAK-INC', 'LAK-ELEC']], [SLUGS[1]!, ['RAT-INC', 'RAT-LOAD-REV']]] as const) {
      const { policy, rules, cases } = setup(slug);
      expect(detectCliffs(policy, rules, cases).map((c) => c.ruleCode).sort()).toEqual([...codes].sort());
    }
  });
  it('reports no cliff when the threshold lies outside the variable domain', () => {
    const { policy, cases } = setup(SLUGS[0]!, 200);
    const rules = [mkRule('X', 'ELIGIBILITY', { variable: 'income', operator: '<=', value: 9_000_000 }, {})];
    expect(detectCliffs(policy, rules, cases)).toEqual([]);
  });
});

describe('conflict detection', () => {
  const s = setup(SLUGS[0]!, 1500);
  it('seeded policies are conflict-free', () => {
    for (const slug of SLUGS) { const x = setup(slug, 1000); expect(detectConflicts(x.policy, x.rules, x.cases)).toEqual([]); }
  });
  it('detects contradictory numeric rules', () => {
    const rules = [...s.rules, mkRule('SCH-INC-LOW', 'ELIGIBILITY', { variable: 'income', operator: '>=', value: 700_000 })];
    const c = detectConflicts(s.policy, rules, s.cases);
    expect(c[0]).toMatchObject({ conflictType: 'CONTRADICTORY_RULES', severity: 'CRITICAL', ruleA: 'SCH-INC', ruleB: 'SCH-INC-LOW' });
  });
  it('detects mutually exclusive categorical conditions', () => {
    const rules = [mkRule('A', 'ELIGIBILITY', { variable: 'category', operator: '==', value: 'SC' }), mkRule('B', 'ELIGIBILITY', { variable: 'category', operator: '==', value: 'ST' })];
    expect(detectConflicts(s.policy, rules, s.cases)[0]).toMatchObject({ conflictType: 'MUTUALLY_EXCLUSIVE_CONDITIONS' });
  });
  it('detects partially overlapping eligibility/exclusion with measured impact', () => {
    const rules = [...s.rules, mkRule('SCH-EX', 'EXCLUSION', { variable: 'income', operator: '>=', value: 450_000 })];
    const c = detectConflicts(s.policy, rules, s.cases).find((x) => x.ruleB === 'SCH-EX')!;
    expect(c.conflictType).toBe('CONFLICTING_OUTCOMES');
    expect(c.severity).not.toBe('CRITICAL');
    expect(c.affectedCases).toBeGreaterThan(0);
  });
  it('detects an exclusion that swallows the whole eligibility region', () => {
    const rules = [...s.rules, mkRule('SCH-EX', 'EXCLUSION', { variable: 'income', operator: '<=', value: 600_000 })];
    expect(detectConflicts(s.policy, rules, s.cases).find((x) => x.ruleB === 'SCH-EX')).toMatchObject({ severity: 'CRITICAL' });
  });
  it('detects unreachable rules (empty domain, and masked review)', () => {
    const empty = [...s.rules, mkRule('SCH-BAD', 'ELIGIBILITY', { variable: 'cgpa', operator: '>=', value: 11 })];
    expect(detectConflicts(s.policy, empty, s.cases).find((x) => x.ruleA === 'SCH-BAD')).toMatchObject({ conflictType: 'UNREACHABLE_RULE', severity: 'CRITICAL' });
    const masked = [...s.rules, mkRule('SCH-REV2', 'REVIEW_TRIGGER', { variable: 'income', operator: '>', value: 800_000 })];
    expect(detectConflicts(s.policy, masked, s.cases).find((x) => x.ruleA === 'SCH-REV2')).toMatchObject({ conflictType: 'UNREACHABLE_RULE', ruleB: 'SCH-INC' });
  });
  it('ignores unverified rules', () => {
    const rules = [...s.rules, mkRule('SCH-INC-LOW', 'ELIGIBILITY', { variable: 'income', operator: '>=', value: 700_000 }, { verificationStatus: 'NEEDS_REVIEW' })];
    expect(detectConflicts(s.policy, rules, s.cases)).toEqual([]);
  });
});

describe('fairness aggregation', () => {
  it('bands partition the population and rates are consistent', () => {
    for (const slug of SLUGS) {
      const { policy, cases, evals } = setup(slug, 2000);
      const f = analyzeFairness(policy, cases, evals);
      expect(f.dataType).toBe('SYNTHETIC');
      expect(f.disclaimer).toContain('not a real-world fairness claim');
      expect(f.bands.reduce((s, b) => s + b.cases, 0)).toBe(2000);
      expect(f.bands.reduce((s, b) => s + b.eligible, 0)).toBe(f.outcomeDistribution.eligible);
      expect(f.bands.reduce((s, b) => s + b.rejectionShare, 0)).toBeCloseTo(1, 2);
      for (const b of f.bands) { expect(b.eligibilityRate).toBeGreaterThanOrEqual(0); expect(b.eligibilityRate).toBeLessThanOrEqual(1); }
      expect(f.groups.map((g) => g.variable)).toEqual(policy.fairness.groupVariables);
    }
  });
  it('eligibility falls with income for an income-capped policy', () => {
    const { policy, cases, evals } = setup(SLUGS[0]!, 4000);
    const f = analyzeFairness(policy, cases, evals);
    expect(f.bands[0]!.eligibilityRate).toBeGreaterThan(f.bands[f.bands.length - 1]!.eligibilityRate);
    expect(f.bands[f.bands.length - 1]!.eligibilityRate).toBe(0);
  });
});

describe('edge cases', () => {
  it('BOUNDARY_SCAN yields boundary cases with full explanations', () => {
    const { policy, rules, cases, evals } = setup(SLUGS[0]!, 3000, 'BOUNDARY_SCAN');
    const { edgeCases, counts } = detectEdgeCases(policy, rules, cases, evals);
    expect(counts.byType.BOUNDARY_VALUE).toBeGreaterThan(0);
    expect(counts.total).toBeGreaterThanOrEqual(edgeCases.length);
    for (const e of edgeCases.slice(0, 50)) {
      expect(e).toMatchObject({ synthetic: true });
      expect(e.reason.length).toBeGreaterThan(10);
      expect(['ELIGIBLE', 'REJECTED', 'NEEDS_REVIEW']).toContain(e.result);
    }
    const b = edgeCases.find((e) => e.type === 'BOUNDARY_VALUE' && e.nearThresholds.some((n) => n.pivotal))!;
    expect(b.severity).toBe('HIGH');
  });
  it('flags contradictory conditions at case level', () => {
    const { policy, cases } = setup(SLUGS[0]!, 500);
    const rules = [mkRule('E1', 'ELIGIBILITY', { variable: 'income', operator: '<=', value: 500_000 }), mkRule('X1', 'EXCLUSION', { variable: 'income', operator: '>=', value: 450_000 })];
    const evals = evaluatePopulation(cases, rules);
    expect(detectEdgeCases(policy, rules, cases, evals).counts.byType.CONTRADICTORY_CONDITIONS).toBeGreaterThan(0);
  });
  it('caps stored edge cases but reports uncapped totals', () => {
    const { policy, rules, cases, evals } = setup(SLUGS[0]!, 3000, 'BOUNDARY_SCAN');
    const small = { ...policy, simulation: { ...policy.simulation, maxEdgeCases: 10 } };
    const d = detectEdgeCases(small, rules, cases, evals);
    expect(d.edgeCases.length).toBe(10);
    expect(d.counts.total).toBeGreaterThan(10);
  });
});
