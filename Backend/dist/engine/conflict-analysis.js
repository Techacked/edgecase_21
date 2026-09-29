"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.detectConflicts = exports.negate = void 0;
const constraint_evaluator_1 = require("./constraint-evaluator");
const NEG = {
    '<': '>=', '<=': '>', '>': '<=', '>=': '<', '==': '!=', '!=': '==', in: 'notIn', notIn: 'in',
};
const negate = (c) => ({ ...c, operator: NEG[c.operator] });
exports.negate = negate;
const nonEmpty = (i) => i.lo < i.hi || (i.lo === i.hi && i.loInc && i.hiInc);
function intersectIntervals(a, b) {
    const out = [];
    for (const x of a)
        for (const y of b) {
            const lo = Math.max(x.lo, y.lo);
            const loInc = x.lo === y.lo ? x.loInc && y.loInc : x.lo > y.lo ? x.loInc : y.loInc;
            const hi = Math.min(x.hi, y.hi);
            const hiInc = x.hi === y.hi ? x.hiInc && y.hiInc : x.hi < y.hi ? x.hiInc : y.hiInc;
            const iv = { lo, hi, loInc, hiInc };
            if (nonEmpty(iv))
                out.push(iv);
        }
    return out;
}
const universe = (v) => v.type === 'boolean' ? ['true', 'false'] : (v.categories ?? []).map((c) => c.value);
function fullDomain(v) {
    if (v.type === 'number') {
        return { kind: 'numeric', intervals: [{ lo: v.min ?? -Infinity, hi: v.max ?? Infinity, loInc: true, hiInc: true }] };
    }
    return { kind: 'discrete', values: new Set(universe(v)) };
}
function constraintDomain(c, v) {
    if (v.type !== 'number') {
        const vals = (Array.isArray(c.value) ? c.value : [c.value]).map(String);
        const all = universe(v);
        let keep;
        if (c.operator === '==' || c.operator === 'in')
            keep = all.filter((x) => vals.includes(x));
        else
            keep = all.filter((x) => !vals.includes(x));
        return { kind: 'discrete', values: new Set(keep) };
    }
    const n = typeof c.value === 'number' ? c.value : NaN;
    const pts = (Array.isArray(c.value) ? c.value : []).map(Number).sort((a, b) => a - b);
    let ivs;
    switch (c.operator) {
        case '<':
            ivs = [{ lo: -Infinity, hi: n, loInc: true, hiInc: false }];
            break;
        case '<=':
            ivs = [{ lo: -Infinity, hi: n, loInc: true, hiInc: true }];
            break;
        case '>':
            ivs = [{ lo: n, hi: Infinity, loInc: false, hiInc: true }];
            break;
        case '>=':
            ivs = [{ lo: n, hi: Infinity, loInc: true, hiInc: true }];
            break;
        case '==':
            ivs = [{ lo: n, hi: n, loInc: true, hiInc: true }];
            break;
        case '!=':
            ivs = [{ lo: -Infinity, hi: n, loInc: true, hiInc: false }, { lo: n, hi: Infinity, loInc: false, hiInc: true }];
            break;
        case 'in':
            ivs = pts.map((p) => ({ lo: p, hi: p, loInc: true, hiInc: true }));
            break;
        default: {
            ivs = [];
            let prev = -Infinity;
            let prevInc = true;
            for (const p of pts) {
                ivs.push({ lo: prev, hi: p, loInc: prevInc, hiInc: false });
                prev = p;
                prevInc = false;
            }
            ivs.push({ lo: prev, hi: Infinity, loInc: prevInc, hiInc: true });
        }
    }
    const full = fullDomain(v);
    return { kind: 'numeric', intervals: intersectIntervals(ivs.filter(nonEmpty), full.intervals) };
}
function intersect(a, b) {
    if (a.kind === 'numeric' && b.kind === 'numeric')
        return { kind: 'numeric', intervals: intersectIntervals(a.intervals, b.intervals) };
    if (a.kind === 'discrete' && b.kind === 'discrete')
        return { kind: 'discrete', values: new Set([...a.values].filter((x) => b.values.has(x))) };
    return { kind: 'discrete', values: new Set() };
}
const isEmpty = (d) => (d.kind === 'numeric' ? d.intervals.length === 0 : d.values.size === 0);
function severityFromFraction(f) {
    if (f >= 0.05)
        return 'HIGH';
    if (f >= 0.01)
        return 'MEDIUM';
    return 'LOW';
}
const SEV_RANK = { CRITICAL: 3, HIGH: 2, MEDIUM: 1, LOW: 0 };
/**
 * Static interval/set analysis of active rules on shared variables, with empirical impact counted on the
 * synthetic population. Rules on different variables are independent, so they cannot logically conflict.
 */
function detectConflicts(policy, rules, cases) {
    const act = (0, constraint_evaluator_1.activeRules)(rules);
    const out = [];
    const varOf = (r) => policy.variables.find((v) => v.name === r.constraint.variable);
    const dom = (r) => constraintDomain(r.constraint, varOf(r));
    const n = Math.max(cases.length, 1);
    const notRejectedWithout = (skip, pred) => {
        const rest = act.filter((r) => !skip.includes(r.ruleCode));
        let count = 0;
        for (const c of cases)
            if (pred(c.attributes) && (0, constraint_evaluator_1.evaluateCase)(c.caseId, c.attributes, rest).outcome !== 'REJECTED')
                count++;
        return count;
    };
    const empty = new Set();
    for (const r of act) {
        if (!isEmpty(dom(r)))
            continue;
        empty.add(r.ruleCode);
        const elig = r.type === 'ELIGIBILITY';
        out.push({
            ruleA: r.ruleCode, ruleB: null, conflictType: 'UNREACHABLE_RULE',
            description: `${r.ruleCode} can never be satisfied within the domain of "${r.constraint.variable}"` +
                (elig ? ', so no case can ever be eligible.' : ', so it never has any effect.'),
            affectedCases: elig ? cases.length : 0, severity: elig ? 'CRITICAL' : 'MEDIUM',
        });
    }
    for (let i = 0; i < act.length; i++) {
        for (let j = i + 1; j < act.length; j++) {
            const a = act[i];
            const b = act[j];
            if (a.constraint.variable !== b.constraint.variable || empty.has(a.ruleCode) || empty.has(b.ruleCode))
                continue;
            const v = varOf(a);
            const overlapEmpty = isEmpty(intersect(dom(a), dom(b)));
            const [x, y] = [a, b].sort((p, q) => p.ruleCode.localeCompare(q.ruleCode));
            if (a.type === 'ELIGIBILITY' && b.type === 'ELIGIBILITY') {
                if (!overlapEmpty)
                    continue;
                const affected = notRejectedWithout([a.ruleCode, b.ruleCode], () => true);
                out.push({
                    ruleA: x.ruleCode, ruleB: y.ruleCode,
                    conflictType: v.type === 'number' ? 'CONTRADICTORY_RULES' : 'MUTUALLY_EXCLUSIVE_CONDITIONS',
                    description: `${a.ruleCode} and ${b.ruleCode} both must hold for "${v.name}" but no value satisfies both, so nobody can be eligible.`,
                    affectedCases: affected, severity: 'CRITICAL',
                });
                continue;
            }
            const elig = a.type === 'ELIGIBILITY' ? a : b.type === 'ELIGIBILITY' ? b : null;
            const excl = a.type === 'EXCLUSION' ? a : b.type === 'EXCLUSION' ? b : null;
            const review = a.type === 'REVIEW_TRIGGER' ? a : b.type === 'REVIEW_TRIGGER' ? b : null;
            if (elig && excl) {
                if (overlapEmpty)
                    continue;
                const swallowed = isEmpty(intersect(dom(elig), constraintDomain((0, exports.negate)(excl.constraint), v)));
                const affected = notRejectedWithout([elig.ruleCode, excl.ruleCode], (at) => (0, constraint_evaluator_1.evaluateConstraint)(elig.constraint, at) && (0, constraint_evaluator_1.evaluateConstraint)(excl.constraint, at));
                out.push({
                    ruleA: elig.ruleCode, ruleB: excl.ruleCode, conflictType: 'CONFLICTING_OUTCOMES',
                    description: swallowed
                        ? `${excl.ruleCode} excludes every value that ${elig.ruleCode} makes eligible, so nobody can be eligible.`
                        : `${elig.ruleCode} grants eligibility and ${excl.ruleCode} excludes on "${v.name}" for overlapping values; the exclusion silently overrides.`,
                    affectedCases: affected, severity: swallowed ? 'CRITICAL' : severityFromFraction(affected / n),
                });
            }
            else if (review) {
                const other = review === a ? b : a;
                const masking = other.type === 'ELIGIBILITY'
                    ? overlapEmpty
                    : isEmpty(intersect(dom(review), constraintDomain((0, exports.negate)(other.constraint), v)));
                if (!masking)
                    continue;
                const affected = cases.filter((c) => (0, constraint_evaluator_1.evaluateConstraint)(review.constraint, c.attributes)).length;
                out.push({
                    ruleA: review.ruleCode, ruleB: other.ruleCode, conflictType: 'UNREACHABLE_RULE',
                    description: `${review.ruleCode} can only fire where ${other.ruleCode} already decides the outcome, so review is never reached.`,
                    affectedCases: affected, severity: 'MEDIUM',
                });
            }
        }
    }
    return out.sort((p, q) => SEV_RANK[q.severity] - SEV_RANK[p.severity] || p.ruleA.localeCompare(q.ruleA) || (p.ruleB ?? '').localeCompare(q.ruleB ?? ''));
}
exports.detectConflicts = detectConflicts;
