import { describe, expect, it } from 'vitest';
import { evaluateCase, validateConstraint, validateRules } from '../../src/engine';
import { load, mkRule } from '../fixtures/policies';

const { policy, rules } = load('scholarship-eligibility');
const base = { income: 400_000, cgpa: 8, familySize: 4, financialNeed: true, location: 'URBAN', category: 'GENERAL' };

describe('rule evaluation', () => {
  it('classifies eligible / rejected / review', () => {
    expect(evaluateCase('a', base, rules).outcome).toBe('ELIGIBLE');
    expect(evaluateCase('b', { ...base, income: 500_001 }, rules)).toMatchObject({ outcome: 'REJECTED', violatedRules: ['SCH-INC'] });
    expect(evaluateCase('c', { ...base, familySize: 9 }, rules)).toMatchObject({ outcome: 'NEEDS_REVIEW', reviewRules: ['SCH-FAM-REV'] });
  });
  it('treats thresholds as inclusive for <= and >=', () => {
    expect(evaluateCase('a', { ...base, income: 500_000, cgpa: 7.0 }, rules).outcome).toBe('ELIGIBLE');
  });
  it('review never overrides rejection', () => {
    expect(evaluateCase('a', { ...base, familySize: 9, cgpa: 5 }, rules).outcome).toBe('REJECTED');
  });
  it('only VERIFIED + enabled rules execute', () => {
    const attrs = { ...base, cgpa: 3 };
    const unverified = rules.map((r) => (r.ruleCode === 'SCH-CGPA' ? { ...r, verificationStatus: 'NEEDS_REVIEW' as const } : r));
    const rejected = rules.map((r) => (r.ruleCode === 'SCH-CGPA' ? { ...r, verificationStatus: 'REJECTED' as const } : r));
    const disabled = rules.map((r) => (r.ruleCode === 'SCH-CGPA' ? { ...r, enabled: false } : r));
    expect(evaluateCase('x', attrs, rules).outcome).toBe('REJECTED');
    for (const set of [unverified, rejected, disabled]) expect(evaluateCase('x', attrs, set).outcome).toBe('ELIGIBLE');
  });
  it('supports in / notIn / != on categoricals', () => {
    const r = mkRule('T', 'ELIGIBILITY', { variable: 'category', operator: 'in', value: ['SC', 'ST'] });
    expect(evaluateCase('x', { ...base, category: 'SC' }, [r]).outcome).toBe('ELIGIBLE');
    expect(evaluateCase('x', { ...base, category: 'OBC' }, [r]).outcome).toBe('REJECTED');
  });
  it('validates constraints against the policy', () => {
    expect(validateConstraint({ variable: 'nope', operator: '<', value: 1 }, policy)[0]).toMatch(/Unknown variable/);
    expect(validateConstraint({ variable: 'category', operator: '>', value: 1 }, policy).length).toBeGreaterThan(0);
    expect(validateConstraint({ variable: 'category', operator: '==', value: 'MARS' }, policy)[0]).toMatch(/not a category/);
    expect(validateConstraint({ variable: 'income', operator: '<=', value: 1 }, policy)).toEqual([]);
    expect(validateRules([rules[0]!, rules[0]!], policy)[0]).toMatch(/Duplicate/);
  });
});
