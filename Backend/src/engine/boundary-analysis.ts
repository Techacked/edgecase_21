import { activeRules, evaluateCase, evaluateConstraint } from './constraint-evaluator';
import { variableStep } from './synthetic-population';
import type {
  CaseEvaluation, Cliff, EdgeCase, EdgeCaseType, EngineRule, NearThreshold, Outcome, PolicyModel,
  Severity, SyntheticCase, VariableDef,
} from './types';

export interface ThresholdRule { rule: EngineRule; variable: VariableDef; threshold: number; step: number }

export function getThresholdRules(policy: PolicyModel, rules: EngineRule[]): ThresholdRule[] {
  const out: ThresholdRule[] = [];
  for (const rule of activeRules(rules)) {
    const variable = policy.variables.find((v) => v.name === rule.constraint.variable);
    const t = rule.constraint.value;
    if (variable?.type === 'number' && typeof t === 'number' && ['<', '<=', '>', '>='].includes(rule.constraint.operator)) {
      out.push({ rule, variable, threshold: t, step: variableStep(variable) });
    }
  }
  return out;
}

/** The nearest representable values on the satisfied / unsatisfied side of a threshold. */
export function boundaryValues(tr: ThresholdRule): { satisfied: number; unsatisfied: number } {
  const { threshold: t, step: s } = tr;
  const f = Math.pow(10, tr.variable.decimals ?? 0);
  const r = (x: number) => Math.round(x * f) / f;
  switch (tr.rule.constraint.operator) {
    case '<=': return { satisfied: t, unsatisfied: r(t + s) };
    case '<': return { satisfied: r(t - s), unsatisfied: t };
    case '>=': return { satisfied: t, unsatisfied: r(t - s) };
    default: return { satisfied: r(t + s), unsatisfied: t };
  }
}

const proximity = (policy: PolicyModel, tr: ThresholdRule): number =>
  Math.max(tr.step, policy.simulation.nearThresholdBand * Math.abs(tr.threshold));

function severityFromFraction(f: number): Severity {
  if (f >= 0.02) return 'CRITICAL';
  if (f >= 0.005) return 'HIGH';
  if (f >= 0.001) return 'MEDIUM';
  return 'LOW';
}

/**
 * A cliff exists where moving a single input by one step across a rule's threshold changes a case's outcome.
 * Nothing is fixed: cliffs are found by re-evaluating every synthetic case at both sides of every threshold.
 */
export function detectCliffs(policy: PolicyModel, rules: EngineRule[], cases: SyntheticCase[]): Cliff[] {
  const cliffs: Cliff[] = [];
  for (const tr of getThresholdRules(policy, rules)) {
    const { satisfied, unsatisfied } = boundaryValues(tr);
    const { min = -Infinity, max = Infinity } = tr.variable;
    // A boundary outside the variable's domain can never be crossed by a real case.
    if ([satisfied, unsatisfied].some((x) => x < min || x > max)) continue;
    const band = proximity(policy, tr);
    const name = tr.variable.name;
    const transitions = new Map<string, number>();
    let exposed = 0;
    let affected = 0;
    for (const c of cases) {
      const probe = { ...c.attributes };
      probe[name] = satisfied;
      const before = evaluateCase(c.caseId, probe, rules).outcome;
      probe[name] = unsatisfied;
      const after = evaluateCase(c.caseId, probe, rules).outcome;
      if (before === after) continue;
      exposed++;
      const key = `${before}>${after}`;
      transitions.set(key, (transitions.get(key) ?? 0) + 1);
      if (Math.abs((c.attributes[name] as number) - tr.threshold) <= band) affected++;
    }
    if (exposed === 0) continue;
    const dominant = [...transitions.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0] as [string, number];
    const [outcomeBefore, outcomeAfter] = dominant[0].split('>') as [Outcome, Outcome];
    const delta = Math.round((unsatisfied - satisfied) * 1e9) / 1e9;
    let severity = severityFromFraction(affected / Math.max(cases.length, 1));
    const relativeDelta = tr.threshold === 0 ? 0 : Math.abs(delta / tr.threshold);
    if (outcomeBefore === 'ELIGIBLE' && outcomeAfter === 'REJECTED' && relativeDelta < 0.001 && severity === 'LOW') severity = 'MEDIUM';
    cliffs.push({
      ruleCode: tr.rule.ruleCode, variable: name, threshold: tr.threshold,
      beforeValue: satisfied, afterValue: unsatisfied, outcomeBefore, outcomeAfter,
      delta, relativeDelta, affectedCases: affected, exposedCases: exposed, severity,
    });
  }
  return cliffs;
}

const TYPE_PRIORITY: EdgeCaseType[] = [
  'HIGH_IMPACT_COMBINATION', 'CONTRADICTORY_CONDITIONS', 'BOUNDARY_VALUE', 'JUST_BELOW_THRESHOLD',
  'JUST_ABOVE_THRESHOLD', 'MULTI_RULE_INTERACTION', 'REVIEW_TRIGGERED',
];
const SEV_RANK: Record<Severity, number> = { CRITICAL: 3, HIGH: 2, MEDIUM: 1, LOW: 0 };

export interface EdgeCaseDetection {
  edgeCases: EdgeCase[];
  counts: { total: number; byType: Record<string, number>; bySeverity: Record<string, number> };
}

/** Same-variable (eligibility, exclusion) rule pairs whose conditions can both hold for one case. */
function contradictoryPairs(rules: EngineRule[]): Array<[EngineRule, EngineRule]> {
  const act = activeRules(rules);
  const pairs: Array<[EngineRule, EngineRule]> = [];
  for (const e of act.filter((r) => r.type === 'ELIGIBILITY')) {
    for (const x of act.filter((r) => r.type === 'EXCLUSION' && r.constraint.variable === e.constraint.variable)) pairs.push([e, x]);
  }
  return pairs;
}

export function detectEdgeCases(
  policy: PolicyModel, rules: EngineRule[], cases: SyntheticCase[], evals: CaseEvaluation[],
): EdgeCaseDetection {
  const trs = getThresholdRules(policy, rules);
  const pairs = contradictoryPairs(rules);
  const found: EdgeCase[] = [];

  cases.forEach((c, i) => {
    const ev = evals[i] as CaseEvaluation;
    const near: NearThreshold[] = [];
    for (const tr of trs) {
      const x = c.attributes[tr.variable.name] as number;
      const distance = Math.round((x - tr.threshold) * 1e9) / 1e9;
      if (Math.abs(distance) > proximity(policy, tr)) continue;
      const sat = evaluateConstraint(tr.rule.constraint, c.attributes);
      const { satisfied, unsatisfied } = boundaryValues(tr);
      const probe = { ...c.attributes, [tr.variable.name]: sat ? unsatisfied : satisfied };
      const pivotal = evaluateCase(c.caseId, probe, rules).outcome !== ev.outcome;
      near.push({ ruleCode: tr.rule.ruleCode, variable: tr.variable.name, value: x, threshold: tr.threshold, distance, pivotal });
    }
    const types = new Set<EdgeCaseType>();
    const nearVars = new Set(near.map((n) => n.variable));
    if (nearVars.size >= 2) types.add('HIGH_IMPACT_COMBINATION');
    const contradiction = pairs.find(([a, b]) => evaluateConstraint(a.constraint, c.attributes) && evaluateConstraint(b.constraint, c.attributes));
    if (contradiction) types.add('CONTRADICTORY_CONDITIONS');
    for (const n of near) types.add(n.distance === 0 ? 'BOUNDARY_VALUE' : n.distance < 0 ? 'JUST_BELOW_THRESHOLD' : 'JUST_ABOVE_THRESHOLD');
    const blocking = ev.violatedRules.length + ev.exclusionRules.length;
    if (blocking >= 2) types.add('MULTI_RULE_INTERACTION');
    if (ev.outcome === 'NEEDS_REVIEW') types.add('REVIEW_TRIGGERED');
    if (types.size === 0) return;

    const ordered = TYPE_PRIORITY.filter((t) => types.has(t));
    const type = ordered[0] as EdgeCaseType;
    const pivotal = near.some((n) => n.pivotal);
    let severity: Severity;
    if (type === 'HIGH_IMPACT_COMBINATION' || type === 'CONTRADICTORY_CONDITIONS') severity = 'HIGH';
    else if (type === 'BOUNDARY_VALUE') severity = pivotal ? 'HIGH' : 'MEDIUM';
    else if (type === 'JUST_BELOW_THRESHOLD' || type === 'JUST_ABOVE_THRESHOLD') severity = pivotal ? 'MEDIUM' : 'LOW';
    else if (type === 'MULTI_RULE_INTERACTION') severity = blocking >= 3 ? 'MEDIUM' : 'LOW';
    else severity = 'LOW';

    const parts: string[] = [];
    for (const n of near) {
      const rel = n.distance === 0 ? 'exactly at' : `${Math.abs(n.distance)} ${n.distance < 0 ? 'below' : 'above'}`;
      parts.push(`${n.variable}=${n.value} is ${rel} the ${n.ruleCode} threshold (${n.threshold})${n.pivotal ? ', which alone decides the outcome' : ''}`);
    }
    if (contradiction) parts.push(`${contradiction[0].ruleCode} and ${contradiction[1].ruleCode} both apply to ${contradiction[0].constraint.variable}; the exclusion overrides eligibility`);
    if (blocking >= 2) parts.push(`${blocking} rules block eligibility (${[...ev.violatedRules, ...ev.exclusionRules].join(', ')})`);
    if (ev.outcome === 'NEEDS_REVIEW') parts.push(`review triggered by ${ev.reviewRules.join(', ')}`);

    found.push({
      caseId: c.caseId, type, types: ordered, severity, attributes: c.attributes, result: ev.outcome,
      reason: `${parts.join('; ')}.`, triggeredRules: [...ev.exclusionRules, ...ev.reviewRules],
      violatedRules: ev.violatedRules, nearThresholds: near, synthetic: true,
    });
  });

  const byType: Record<string, number> = {};
  const bySeverity: Record<string, number> = {};
  for (const e of found) {
    byType[e.type] = (byType[e.type] ?? 0) + 1;
    bySeverity[e.severity] = (bySeverity[e.severity] ?? 0) + 1;
  }
  found.sort((a, b) =>
    SEV_RANK[b.severity] - SEV_RANK[a.severity]
    || TYPE_PRIORITY.indexOf(a.type) - TYPE_PRIORITY.indexOf(b.type)
    || a.caseId.localeCompare(b.caseId));
  return { edgeCases: found.slice(0, policy.simulation.maxEdgeCases), counts: { total: found.length, byType, bySeverity } };
}
