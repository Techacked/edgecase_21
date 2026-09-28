import { POLICY_DEFINITIONS } from '../../src/config/policy-definitions';
import type { EngineRule, PolicyModel } from '../../src/engine/types';

export function load(slug: string): { policy: PolicyModel; rules: EngineRule[] } {
  const def = POLICY_DEFINITIONS.find((p) => p.slug === slug)!;
  return {
    policy: def.model,
    rules: def.rules.map((r, i) => ({ id: `${slug}-${i}`, ruleCode: r.ruleCode, description: r.description, type: r.type, constraint: r.constraint, enabled: true, verificationStatus: 'VERIFIED' as const })),
  };
}
export const SLUGS = ['scholarship-eligibility', 'delhi-ration-food-security', 'delhi-lakshmi-yojana'];
export const mkRule = (ruleCode: string, type: EngineRule['type'], constraint: EngineRule['constraint'], over: Partial<EngineRule> = {}): EngineRule =>
  ({ id: ruleCode, ruleCode, description: ruleCode, type, constraint, enabled: true, verificationStatus: 'VERIFIED', ...over });
