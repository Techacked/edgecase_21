"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectEdgeCases = exports.detectCliffs = exports.boundaryValues = exports.getThresholdRules = void 0;
const constraint_evaluator_1 = require("./constraint-evaluator");
const synthetic_population_1 = require("./synthetic-population");
function getThresholdRules(policy, rules) {
    const out = [];
    for (const rule of (0, constraint_evaluator_1.activeRules)(rules)) {
        const variable = policy.variables.find((v) => v.name === rule.constraint.variable);
        const t = rule.constraint.value;
        if (variable?.type === 'number' && typeof t === 'number' && ['<', '<=', '>', '>='].includes(rule.constraint.operator)) {
            out.push({ rule, variable, threshold: t, step: (0, synthetic_population_1.variableStep)(variable) });
        }
    }
    return out;
}
exports.getThresholdRules = getThresholdRules;
/** The nearest representable values on the satisfied / unsatisfied side of a threshold. */
function boundaryValues(tr) {
    const { threshold: t, step: s } = tr;
    const f = Math.pow(10, tr.variable.decimals ?? 0);
    const r = (x) => Math.round(x * f) / f;
    switch (tr.rule.constraint.operator) {
        case '<=': return { satisfied: t, unsatisfied: r(t + s) };
        case '<': return { satisfied: r(t - s), unsatisfied: t };
        case '>=': return { satisfied: t, unsatisfied: r(t - s) };
        default: return { satisfied: r(t + s), unsatisfied: t };
    }
}
exports.boundaryValues = boundaryValues;
const proximity = (policy, tr) => Math.max(tr.step, policy.simulation.nearThresholdBand * Math.abs(tr.threshold));
function severityFromFraction(f) {
    if (f >= 0.02)
        return 'CRITICAL';
    if (f >= 0.005)
        return 'HIGH';
    if (f >= 0.001)
        return 'MEDIUM';
    return 'LOW';
}
/**
 * A cliff exists where moving a single input by one step across a rule's threshold changes a case's outcome.
 * Nothing is fixed: cliffs are found by re-evaluating every synthetic case at both sides of every threshold.
 */
function detectCliffs(policy, rules, cases) {
    const cliffs = [];
    for (const tr of getThresholdRules(policy, rules)) {
        const { satisfied, unsatisfied } = boundaryValues(tr);
        const { min = -Infinity, max = Infinity } = tr.variable;
        // A boundary outside the variable's domain can never be crossed by a real case.
        if ([satisfied, unsatisfied].some((x) => x < min || x > max))
            continue;
        const band = proximity(policy, tr);
        const name = tr.variable.name;
        const transitions = new Map();
        let exposed = 0;
        let affected = 0;
        for (const c of cases) {
            const probe = { ...c.attributes };
            probe[name] = satisfied;
            const before = (0, constraint_evaluator_1.evaluateCase)(c.caseId, probe, rules).outcome;
            probe[name] = unsatisfied;
            const after = (0, constraint_evaluator_1.evaluateCase)(c.caseId, probe, rules).outcome;
            if (before === after)
                continue;
            exposed++;
            const key = `${before}>${after}`;
            transitions.set(key, (transitions.get(key) ?? 0) + 1);
            if (Math.abs(c.attributes[name] - tr.threshold) <= band)
                affected++;
        }
        if (exposed === 0)
            continue;
        const dominant = [...transitions.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
        const [outcomeBefore, outcomeAfter] = dominant[0].split('>');
        const delta = Math.round((unsatisfied - satisfied) * 1e9) / 1e9;
        let severity = severityFromFraction(affected / Math.max(cases.length, 1));
        const relativeDelta = tr.threshold === 0 ? 0 : Math.abs(delta / tr.threshold);
        if (outcomeBefore === 'ELIGIBLE' && outcomeAfter === 'REJECTED' && relativeDelta < 0.001 && severity === 'LOW')
            severity = 'MEDIUM';
        cliffs.push({
            ruleCode: tr.rule.ruleCode, variable: name, threshold: tr.threshold,
            beforeValue: satisfied, afterValue: unsatisfied, outcomeBefore, outcomeAfter,
            delta, relativeDelta, affectedCases: affected, exposedCases: exposed, severity,
        });
    }
    return cliffs;
}
exports.detectCliffs = detectCliffs;
const TYPE_PRIORITY = [
    'HIGH_IMPACT_COMBINATION', 'CONTRADICTORY_CONDITIONS', 'BOUNDARY_VALUE', 'JUST_BELOW_THRESHOLD',
    'JUST_ABOVE_THRESHOLD', 'MULTI_RULE_INTERACTION', 'REVIEW_TRIGGERED',
];
const SEV_RANK = { CRITICAL: 3, HIGH: 2, MEDIUM: 1, LOW: 0 };
/** Same-variable (eligibility, exclusion) rule pairs whose conditions can both hold for one case. */
function contradictoryPairs(rules) {
    const act = (0, constraint_evaluator_1.activeRules)(rules);
    const pairs = [];
    for (const e of act.filter((r) => r.type === 'ELIGIBILITY')) {
        for (const x of act.filter((r) => r.type === 'EXCLUSION' && r.constraint.variable === e.constraint.variable))
            pairs.push([e, x]);
    }
    return pairs;
}
function detectEdgeCases(policy, rules, cases, evals) {
    const trs = getThresholdRules(policy, rules);
    const pairs = contradictoryPairs(rules);
    const found = [];
    cases.forEach((c, i) => {
        const ev = evals[i];
        const near = [];
        for (const tr of trs) {
            const x = c.attributes[tr.variable.name];
            const distance = Math.round((x - tr.threshold) * 1e9) / 1e9;
            if (Math.abs(distance) > proximity(policy, tr))
                continue;
            const sat = (0, constraint_evaluator_1.evaluateConstraint)(tr.rule.constraint, c.attributes);
            const { satisfied, unsatisfied } = boundaryValues(tr);
            const probe = { ...c.attributes, [tr.variable.name]: sat ? unsatisfied : satisfied };
            const pivotal = (0, constraint_evaluator_1.evaluateCase)(c.caseId, probe, rules).outcome !== ev.outcome;
            near.push({ ruleCode: tr.rule.ruleCode, variable: tr.variable.name, value: x, threshold: tr.threshold, distance, pivotal });
        }
        const types = new Set();
        const nearVars = new Set(near.map((n) => n.variable));
        if (nearVars.size >= 2)
            types.add('HIGH_IMPACT_COMBINATION');
        const contradiction = pairs.find(([a, b]) => (0, constraint_evaluator_1.evaluateConstraint)(a.constraint, c.attributes) && (0, constraint_evaluator_1.evaluateConstraint)(b.constraint, c.attributes));
        if (contradiction)
            types.add('CONTRADICTORY_CONDITIONS');
        for (const n of near)
            types.add(n.distance === 0 ? 'BOUNDARY_VALUE' : n.distance < 0 ? 'JUST_BELOW_THRESHOLD' : 'JUST_ABOVE_THRESHOLD');
        const blocking = ev.violatedRules.length + ev.exclusionRules.length;
        if (blocking >= 2)
            types.add('MULTI_RULE_INTERACTION');
        if (ev.outcome === 'NEEDS_REVIEW')
            types.add('REVIEW_TRIGGERED');
        if (types.size === 0)
            return;
        const ordered = TYPE_PRIORITY.filter((t) => types.has(t));
        const type = ordered[0];
        const pivotal = near.some((n) => n.pivotal);
        let severity;
        if (type === 'HIGH_IMPACT_COMBINATION' || type === 'CONTRADICTORY_CONDITIONS')
            severity = 'HIGH';
        else if (type === 'BOUNDARY_VALUE')
            severity = pivotal ? 'HIGH' : 'MEDIUM';
        else if (type === 'JUST_BELOW_THRESHOLD' || type === 'JUST_ABOVE_THRESHOLD')
            severity = pivotal ? 'MEDIUM' : 'LOW';
        else if (type === 'MULTI_RULE_INTERACTION')
            severity = blocking >= 3 ? 'MEDIUM' : 'LOW';
        else
            severity = 'LOW';
        const parts = [];
        for (const n of near) {
            const rel = n.distance === 0 ? 'exactly at' : `${Math.abs(n.distance)} ${n.distance < 0 ? 'below' : 'above'}`;
            parts.push(`${n.variable}=${n.value} is ${rel} the ${n.ruleCode} threshold (${n.threshold})${n.pivotal ? ', which alone decides the outcome' : ''}`);
        }
        if (contradiction)
            parts.push(`${contradiction[0].ruleCode} and ${contradiction[1].ruleCode} both apply to ${contradiction[0].constraint.variable}; the exclusion overrides eligibility`);
        if (blocking >= 2)
            parts.push(`${blocking} rules block eligibility (${[...ev.violatedRules, ...ev.exclusionRules].join(', ')})`);
        if (ev.outcome === 'NEEDS_REVIEW')
            parts.push(`review triggered by ${ev.reviewRules.join(', ')}`);
        found.push({
            caseId: c.caseId, type, types: ordered, severity, attributes: c.attributes, result: ev.outcome,
            reason: `${parts.join('; ')}.`, triggeredRules: [...ev.exclusionRules, ...ev.reviewRules],
            violatedRules: ev.violatedRules, nearThresholds: near, synthetic: true,
        });
    });
    const byType = {};
    const bySeverity = {};
    for (const e of found) {
        byType[e.type] = (byType[e.type] ?? 0) + 1;
        bySeverity[e.severity] = (bySeverity[e.severity] ?? 0) + 1;
    }
    found.sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity]
        || TYPE_PRIORITY.indexOf(a.type) - TYPE_PRIORITY.indexOf(b.type)
        || a.caseId.localeCompare(b.caseId));
    return { edgeCases: found.slice(0, policy.simulation.maxEdgeCases), counts: { total: found.length, byType, bySeverity } };
}
exports.detectEdgeCases = detectEdgeCases;
