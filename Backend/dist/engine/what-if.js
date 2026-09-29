"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runWhatIf = exports.applyParameterChange = void 0;
const errors_1 = require("../utils/errors");
const constraint_evaluator_1 = require("./constraint-evaluator");
const simulation_runner_1 = require("./simulation-runner");
const synthetic_population_1 = require("./synthetic-population");
function applyParameterChange(policy, rules, parameter, newValue) {
    const def = policy.parameters.find((p) => p.key === parameter);
    if (!def)
        throw new errors_1.AppError('VALIDATION_ERROR', `Unknown parameter "${parameter}" for policy ${policy.slug}`, [{ available: policy.parameters.map((p) => p.key) }]);
    if (typeof newValue !== 'number' || !Number.isFinite(newValue))
        throw new errors_1.AppError('VALIDATION_ERROR', 'newValue must be a finite number');
    if ((def.min !== undefined && newValue < def.min) || (def.max !== undefined && newValue > def.max)) {
        throw new errors_1.AppError('VALIDATION_ERROR', `newValue for ${parameter} must be between ${def.min ?? '-∞'} and ${def.max ?? '∞'}`);
    }
    const target = (0, constraint_evaluator_1.activeRules)(rules).find((r) => r.ruleCode === def.ruleCode);
    if (!target || typeof target.constraint.value !== 'number') {
        throw new errors_1.AppError('VALIDATION_ERROR', `Parameter "${parameter}" is bound to rule ${def.ruleCode}, which is not an active numeric rule`);
    }
    const oldValue = target.constraint.value;
    return { oldValue, rules: rules.map((r) => (r.id === target.id ? { ...r, constraint: { ...r.constraint, value: newValue } } : r)) };
}
exports.applyParameterChange = applyParameterChange;
/**
 * Runs the real engine twice over ONE synthetic population (generated once from the baseline rules with the
 * given seed). Only the requested parameter differs between the two evaluations.
 */
function runWhatIf(policy, baselineRules, req, params, options = {}) {
    (0, simulation_runner_1.validateSimulationParams)(params, options.maxPopulationSize);
    const base = (0, simulation_runner_1.prepareRules)(policy, baselineRules);
    const { rules: changedAll, oldValue } = applyParameterChange(policy, base, req.parameter, req.newValue);
    const changed = (0, simulation_runner_1.prepareRules)(policy, changedAll);
    const cases = (0, synthetic_population_1.generatePopulation)(policy, { size: params.populationSize, seed: params.seed, mode: params.mode, rules: base });
    const before = (0, simulation_runner_1.evaluatePopulation)(cases, base);
    const after = (0, simulation_runner_1.evaluatePopulation)(cases, changed);
    const cb = (0, simulation_runner_1.countOutcomes)(before);
    const ca = (0, simulation_runner_1.countOutcomes)(after);
    const transitions = new Map();
    const sample = [];
    let count = 0;
    before.forEach((b, i) => {
        const a = after[i];
        if (a.outcome === b.outcome)
            return;
        count++;
        const k = `${b.outcome}>${a.outcome}`;
        transitions.set(k, (transitions.get(k) ?? 0) + 1);
        if (sample.length < 100)
            sample.push({ caseId: b.caseId, before: b.outcome, after: a.outcome });
    });
    const rate = (n) => (cb.total ? Math.round((n / cb.total) * 10000) / 10000 : 0);
    const cost = policy.budget.costPerEligibleCase;
    return {
        dataType: 'SYNTHETIC', parameter: req.parameter, oldValue, newValue: req.newValue,
        seed: params.seed, populationSize: params.populationSize,
        baseline: { ...cb, eligibleRate: rate(cb.eligible) }, changed: { ...ca, eligibleRate: rate(ca.eligible) },
        eligibleDelta: ca.eligible - cb.eligible, rejectedDelta: ca.rejected - cb.rejected, reviewDelta: ca.needsReview - cb.needsReview,
        affectedCases: {
            count,
            transitions: [...transitions].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).map(([k, c]) => {
                const [from, to] = k.split('>');
                return { from, to, count: c };
            }),
            sample,
        },
        budgetImpact: {
            label: 'SIMULATED ESTIMATE', currency: policy.budget.currency, costPerEligibleCase: cost,
            assumptionDescription: policy.budget.assumptionDescription,
            estimatedCostBefore: cb.eligible * cost, estimatedCostAfter: ca.eligible * cost, delta: (ca.eligible - cb.eligible) * cost,
        },
        methodology: `Baseline and changed scenarios evaluate the same ${params.populationSize} synthetic cases (seed ${params.seed}, mode ${params.mode}) ` +
            `with the same policy version. Only ${req.parameter} (rule ${policy.parameters.find((p) => p.key === req.parameter)?.ruleCode}) changes from ${oldValue} to ${req.newValue}. ` +
            `Cost = eligible cases × costPerEligibleCase over the synthetic population; it is a simulated estimate, not real budget data.`,
    };
}
exports.runWhatIf = runWhatIf;
