"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runSimulation = exports.evaluatePopulation = exports.prepareRules = exports.countOutcomes = exports.validateSimulationParams = void 0;
const errors_1 = require("../utils/errors");
const hash_1 = require("../utils/hash");
const boundary_analysis_1 = require("./boundary-analysis");
const conflict_analysis_1 = require("./conflict-analysis");
const constraint_evaluator_1 = require("./constraint-evaluator");
const fairness_analysis_1 = require("./fairness-analysis");
const synthetic_population_1 = require("./synthetic-population");
const STAGES = [
    'GENERATING_POPULATION', 'EVALUATING_RULES', 'DETECTING_EDGE_CASES', 'DETECTING_CLIFFS', 'DETECTING_CONFLICTS', 'ANALYZING_FAIRNESS',
];
function validateSimulationParams(p, maxPopulationSize = 100000) {
    if (!Number.isInteger(p.populationSize) || p.populationSize < 1)
        throw new errors_1.AppError('VALIDATION_ERROR', 'populationSize must be a positive integer');
    if (p.populationSize > maxPopulationSize)
        throw new errors_1.AppError('SIMULATION_LIMIT_EXCEEDED', `populationSize ${p.populationSize} exceeds the maximum of ${maxPopulationSize}`);
    if (!Number.isInteger(p.seed))
        throw new errors_1.AppError('VALIDATION_ERROR', 'seed must be an integer');
    if (!['STRESS_TEST', 'BOUNDARY_SCAN', 'FAIRNESS_AUDIT'].includes(p.mode))
        throw new errors_1.AppError('VALIDATION_ERROR', `Unknown mode ${String(p.mode)}`);
}
exports.validateSimulationParams = validateSimulationParams;
function countOutcomes(evals) {
    const c = { eligible: 0, rejected: 0, needsReview: 0, total: evals.length };
    for (const e of evals) {
        if (e.outcome === 'ELIGIBLE')
            c.eligible++;
        else if (e.outcome === 'REJECTED')
            c.rejected++;
        else
            c.needsReview++;
    }
    return c;
}
exports.countOutcomes = countOutcomes;
/** Validates rules and returns the executable subset; throws if the rules cannot be simulated. */
function prepareRules(policy, rules) {
    const problems = (0, constraint_evaluator_1.validateRules)(rules.filter(constraint_evaluator_1.isActiveRule), policy);
    if (problems.length)
        throw new errors_1.AppError('VALIDATION_ERROR', 'Rules are invalid for this policy', problems);
    const active = (0, constraint_evaluator_1.activeRules)(rules);
    if (!active.some((r) => r.type === 'ELIGIBILITY')) {
        throw new errors_1.AppError('VALIDATION_ERROR', 'At least one VERIFIED, enabled ELIGIBILITY rule is required to simulate');
    }
    return active;
}
exports.prepareRules = prepareRules;
function evaluatePopulation(cases, rules) {
    return cases.map((c) => (0, constraint_evaluator_1.evaluateCase)(c.caseId, c.attributes, rules));
}
exports.evaluatePopulation = evaluatePopulation;
/** Pure, deterministic, Express-free. Same policy + rules + params => identical result and resultHash. */
function runSimulation(policy, allRules, params, options = {}) {
    validateSimulationParams(params, options.maxPopulationSize);
    const rules = prepareRules(policy, allRules);
    const step = (s) => options.onProgress?.(s, STAGES.indexOf(s) / STAGES.length);
    step('GENERATING_POPULATION');
    const cases = (0, synthetic_population_1.generatePopulation)(policy, { size: params.populationSize, seed: params.seed, mode: params.mode, rules });
    step('EVALUATING_RULES');
    const evaluations = evaluatePopulation(cases, rules);
    const counts = countOutcomes(evaluations);
    const reasonCounts = new Map();
    for (const e of evaluations)
        if (e.outcome === 'REJECTED') {
            for (const code of [...e.violatedRules, ...e.exclusionRules])
                reasonCounts.set(code, (reasonCounts.get(code) ?? 0) + 1);
        }
    const rejectionReasons = [...reasonCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([ruleCode, count]) => ({ ruleCode, count, share: counts.rejected ? Math.round((count / counts.rejected) * 10000) / 10000 : 0 }));
    step('DETECTING_EDGE_CASES');
    const { edgeCases, counts: edgeCaseCounts } = (0, boundary_analysis_1.detectEdgeCases)(policy, rules, cases, evaluations);
    step('DETECTING_CLIFFS');
    const cliffs = (0, boundary_analysis_1.detectCliffs)(policy, rules, cases);
    step('DETECTING_CONFLICTS');
    const conflicts = (0, conflict_analysis_1.detectConflicts)(policy, rules, cases);
    step('ANALYZING_FAIRNESS');
    const fairness = (0, fairness_analysis_1.analyzeFairness)(policy, cases, evaluations);
    options.onProgress?.('ANALYZING_FAIRNESS', 1);
    const ignoredRules = allRules.filter((r) => !(0, constraint_evaluator_1.isActiveRule)(r)).map((r) => ({
        ruleCode: r.ruleCode, reason: !r.enabled ? 'disabled' : `verificationStatus=${r.verificationStatus}`,
    }));
    const pct = (n) => (counts.total ? Math.round((n / counts.total) * 10000) / 10000 : 0);
    const configHash = (0, hash_1.hashObject)({ policy, rules: rules.map((r) => [r.ruleCode, r.type, r.constraint]), params });
    const resultHash = (0, hash_1.hashObject)({ configHash, outcomes: evaluations.map((e) => [e.caseId, e.outcome]) });
    return {
        cases, evaluations,
        result: {
            meta: {
                dataType: 'SYNTHETIC', synthetic: true, policySlug: policy.slug, ...params,
                activeRuleCodes: rules.map((r) => r.ruleCode), ignoredRules, configHash, resultHash,
            },
            summary: { counts, rates: { eligible: pct(counts.eligible), rejected: pct(counts.rejected), review: pct(counts.needsReview) }, rejectionReasons },
            edgeCases, edgeCaseCounts, cliffs, conflicts, fairness,
        },
    };
}
exports.runSimulation = runSimulation;
