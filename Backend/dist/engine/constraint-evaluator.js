"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateRules = exports.validateConstraint = exports.evaluateCase = exports.evaluateConstraint = exports.activeRules = exports.isActiveRule = void 0;
const errors_1 = require("../utils/errors");
const EPS = 1e-9;
/** Only VERIFIED + enabled rules may ever execute. */
const isActiveRule = (r) => r.enabled && r.verificationStatus === 'VERIFIED';
exports.isActiveRule = isActiveRule;
function activeRules(rules) {
    return rules.filter(exports.isActiveRule).sort((a, b) => a.ruleCode.localeCompare(b.ruleCode));
}
exports.activeRules = activeRules;
function equals(a, b) {
    if (typeof a === 'number' && typeof b === 'number')
        return Math.abs(a - b) < EPS;
    return a === b;
}
function evaluateConstraint(c, attrs) {
    const actual = attrs[c.variable];
    if (actual === undefined)
        throw new errors_1.AppError('VALIDATION_ERROR', `Case is missing attribute "${c.variable}"`);
    const { value } = c;
    switch (c.operator) {
        case '==': return equals(actual, value);
        case '!=': return !equals(actual, value);
        case 'in': return Array.isArray(value) && value.some((v) => equals(actual, v));
        case 'notIn': return Array.isArray(value) && !value.some((v) => equals(actual, v));
        default: {
            if (typeof actual !== 'number' || typeof value !== 'number') {
                throw new errors_1.AppError('VALIDATION_ERROR', `Operator ${c.operator} requires numeric operands for "${c.variable}"`);
            }
            if (c.operator === '<')
                return actual < value - EPS;
            if (c.operator === '<=')
                return actual <= value + EPS;
            if (c.operator === '>')
                return actual > value + EPS;
            return actual >= value - EPS;
        }
    }
}
exports.evaluateConstraint = evaluateConstraint;
/**
 * Semantics:
 *  ELIGIBILITY    - constraint must hold, otherwise the case is REJECTED
 *  EXCLUSION      - if constraint holds, the case is REJECTED
 *  REVIEW_TRIGGER - if constraint holds (and nothing rejects), the case NEEDS_REVIEW
 */
function evaluateCase(caseId, attrs, rules) {
    const passedRules = [];
    const violatedRules = [];
    const exclusionRules = [];
    const reviewRules = [];
    for (const rule of rules) {
        if (!(0, exports.isActiveRule)(rule))
            continue;
        const sat = evaluateConstraint(rule.constraint, attrs);
        if (rule.type === 'ELIGIBILITY')
            (sat ? passedRules : violatedRules).push(rule.ruleCode);
        else if (rule.type === 'EXCLUSION') {
            if (sat)
                exclusionRules.push(rule.ruleCode);
        }
        else if (sat)
            reviewRules.push(rule.ruleCode);
    }
    const outcome = violatedRules.length || exclusionRules.length ? 'REJECTED' : reviewRules.length ? 'NEEDS_REVIEW' : 'ELIGIBLE';
    return { caseId, outcome, passedRules, violatedRules, exclusionRules, reviewRules };
}
exports.evaluateCase = evaluateCase;
const ORDERING = ['<', '<=', '>', '>='];
/** Returns human-readable problems; empty array means the constraint is valid for the policy. */
function validateConstraint(c, policy) {
    const v = policy.variables.find((x) => x.name === c.variable);
    if (!v)
        return [`Unknown variable "${c.variable}"`];
    const errs = [];
    const isSet = c.operator === 'in' || c.operator === 'notIn';
    if (v.type !== 'number' && ORDERING.includes(c.operator))
        errs.push(`Operator ${c.operator} is not valid for ${v.type} variable "${v.name}"`);
    if (isSet && !Array.isArray(c.value))
        errs.push(`Operator ${c.operator} requires an array value`);
    if (!isSet && Array.isArray(c.value))
        errs.push(`Operator ${c.operator} requires a scalar value`);
    const values = Array.isArray(c.value) ? c.value : [c.value];
    for (const x of values) {
        if (v.type === 'number' && (typeof x !== 'number' || !Number.isFinite(x)))
            errs.push(`Value for "${v.name}" must be a finite number`);
        if (v.type === 'boolean' && typeof x !== 'boolean')
            errs.push(`Value for "${v.name}" must be a boolean`);
        if (v.type === 'categorical' && !(v.categories ?? []).some((cat) => cat.value === x))
            errs.push(`"${String(x)}" is not a category of "${v.name}"`);
    }
    return errs;
}
exports.validateConstraint = validateConstraint;
function validateRules(rules, policy) {
    const errs = [];
    const seen = new Set();
    for (const r of rules) {
        if (seen.has(r.ruleCode))
            errs.push(`Duplicate ruleCode ${r.ruleCode}`);
        seen.add(r.ruleCode);
        for (const e of validateConstraint(r.constraint, policy))
            errs.push(`${r.ruleCode}: ${e}`);
    }
    return errs;
}
exports.validateRules = validateRules;
