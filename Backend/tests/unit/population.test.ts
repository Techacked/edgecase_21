import { describe, expect, it } from 'vitest';
import { generatePopulation } from '../../src/engine';
import { load, SLUGS } from '../fixtures/policies';

const gen = (slug: string, size: number, seed: number, mode: 'STRESS_TEST' | 'BOUNDARY_SCAN' | 'FAIRNESS_AUDIT' = 'STRESS_TEST') => {
  const { policy, rules } = load(slug);
  return generatePopulation(policy, { size, seed, mode, rules });
};

describe('synthetic population', () => {
  it('is deterministic for the same seed', () => {
    expect(gen(SLUGS[0]!, 500, 12345)).toEqual(gen(SLUGS[0]!, 500, 12345));
  });
  it('differs for a different seed', () => {
    expect(gen(SLUGS[0]!, 500, 1)).not.toEqual(gen(SLUGS[0]!, 500, 2));
  });
  it('case i is independent of population size', () => {
    expect(gen(SLUGS[0]!, 100, 7)).toEqual(gen(SLUGS[0]!, 300, 7).slice(0, 100));
  });
  it('marks every case synthetic and only carries policy variables', () => {
    for (const slug of SLUGS) {
      const { policy } = load(slug);
      for (const c of gen(slug, 200, 3)) {
        expect(c.synthetic).toBe(true);
        expect(Object.keys(c.attributes).sort()).toEqual(policy.variables.map((v) => v.name).sort());
      }
    }
  });
  it('respects variable domains', () => {
    for (const slug of SLUGS) {
      const { policy } = load(slug);
      for (const c of gen(slug, 500, 9)) for (const v of policy.variables) {
        const x = c.attributes[v.name];
        if (v.type === 'number') { expect(x as number).toBeGreaterThanOrEqual(v.min!); expect(x as number).toBeLessThanOrEqual(v.max!); }
      }
    }
  });
  it('BOUNDARY_SCAN concentrates cases at thresholds', () => {
    const near = (cs: ReturnType<typeof gen>) => cs.filter((c) => Math.abs((c.attributes.income as number) - 500_000) <= 3).length;
    expect(near(gen(SLUGS[0]!, 2000, 5, 'BOUNDARY_SCAN'))).toBeGreaterThan(near(gen(SLUGS[0]!, 2000, 5)) + 20);
  });
  it('FAIRNESS_AUDIT stratifies across income bands', () => {
    const cs = gen(SLUGS[0]!, 600, 5, 'FAIRNESS_AUDIT');
    const top = cs.filter((c) => (c.attributes.income as number) >= 1_000_000).length;
    expect(top).toBeGreaterThanOrEqual(90);
  });
});
