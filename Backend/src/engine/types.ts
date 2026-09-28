export type SimulationMode = 'STRESS_TEST' | 'BOUNDARY_SCAN' | 'FAIRNESS_AUDIT';
export type Outcome = 'ELIGIBLE' | 'REJECTED' | 'NEEDS_REVIEW';
export type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type RuleType = 'ELIGIBILITY' | 'EXCLUSION' | 'REVIEW_TRIGGER';
export type VerificationStatus = 'NEEDS_REVIEW' | 'VERIFIED' | 'REJECTED';
export type Operator = '<' | '<=' | '>' | '>=' | '==' | '!=' | 'in' | 'notIn';
export type AttributeValue = number | boolean | string;
export type CaseAttributes = Record<string, AttributeValue>;

export interface Constraint {
  variable: string;
  operator: Operator;
  value: AttributeValue | Array<number | string>;
}

export interface EngineRule {
  id: string;
  ruleCode: string;
  description: string;
  type: RuleType;
  constraint: Constraint;
  enabled: boolean;
  verificationStatus: VerificationStatus;
}

export type Distribution =
  | { kind: 'uniform' }
  | { kind: 'normal'; mean: number; sd: number }
  | { kind: 'lognormal'; median: number; sigma: number };

export interface VariableDef {
  name: string;
  label: string;
  type: 'number' | 'boolean' | 'categorical';
  unit?: string;
  min?: number;
  max?: number;
  decimals?: number;
  step?: number;
  distribution?: Distribution;
  trueProbability?: number;
  categories?: Array<{ value: string; weight: number }>;
}

export interface ParameterDef {
  key: string;
  label: string;
  ruleCode: string;
  min?: number;
  max?: number;
}

export interface BudgetAssumptions {
  costPerEligibleCase: number;
  currency: string;
  assumptionDescription: string;
}

export interface FairnessConfig {
  bandVariable: string;
  bandEdges: number[];
  groupVariables: string[];
}

/** Everything policy-specific and data-driven. Stored as JSON on PolicyVersion. */
export interface PolicyModel {
  slug: string;
  name: string;
  variables: VariableDef[];
  parameters: ParameterDef[];
  budget: BudgetAssumptions;
  fairness: FairnessConfig;
  simulation: { nearThresholdBand: number; maxEdgeCases: number; defaultPopulationSize: number };
}

export interface SyntheticCase {
  caseId: string;
  index: number;
  synthetic: true;
  attributes: CaseAttributes;
}

export interface CaseEvaluation {
  caseId: string;
  outcome: Outcome;
  passedRules: string[];
  violatedRules: string[];
  exclusionRules: string[];
  reviewRules: string[];
}

export type EdgeCaseType =
  | 'HIGH_IMPACT_COMBINATION' | 'CONTRADICTORY_CONDITIONS' | 'BOUNDARY_VALUE'
  | 'JUST_BELOW_THRESHOLD' | 'JUST_ABOVE_THRESHOLD' | 'MULTI_RULE_INTERACTION' | 'REVIEW_TRIGGERED';

export interface NearThreshold {
  ruleCode: string; variable: string; value: number; threshold: number; distance: number; pivotal: boolean;
}

export interface EdgeCase {
  caseId: string;
  type: EdgeCaseType;
  types: EdgeCaseType[];
  severity: Severity;
  attributes: CaseAttributes;
  result: Outcome;
  reason: string;
  triggeredRules: string[];
  violatedRules: string[];
  nearThresholds: NearThreshold[];
  synthetic: true;
}

export interface Cliff {
  ruleCode: string;
  variable: string;
  threshold: number;
  beforeValue: number;
  afterValue: number;
  outcomeBefore: Outcome;
  outcomeAfter: Outcome;
  delta: number;
  relativeDelta: number;
  /** Cases in the population within the proximity band that flip across the threshold. */
  affectedCases: number;
  /** Cases in the whole population that would flip if this variable crossed the threshold. */
  exposedCases: number;
  severity: Severity;
}

export type ConflictType =
  | 'CONTRADICTORY_RULES' | 'MUTUALLY_EXCLUSIVE_CONDITIONS' | 'UNREACHABLE_RULE' | 'CONFLICTING_OUTCOMES';

export interface RuleConflict {
  ruleA: string;
  ruleB: string | null;
  conflictType: ConflictType;
  description: string;
  affectedCases: number;
  severity: Severity;
}

export interface Counts { eligible: number; rejected: number; needsReview: number; total: number }

export interface BandStat {
  label: string; lower: number; upper: number | null; cases: number; populationShare: number;
  eligible: number; rejected: number; needsReview: number;
  eligibilityRate: number; reviewRate: number;
  coverageShare: number; coverageRatio: number | null; rejectionShare: number;
}

export interface FairnessAnalysis {
  dataType: 'SYNTHETIC';
  disclaimer: string;
  outcomeDistribution: Counts & { eligibleRate: number; rejectedRate: number; reviewRate: number };
  bandVariable: string;
  bands: BandStat[];
  rejectionConcentration: { hhi: number; topBand: string | null; topBandShare: number };
  eligibilityRateSpread: number;
  groups: Array<{
    variable: string;
    groups: Array<{ value: string; cases: number; eligible: number; eligibilityRate: number; reviewRate: number }>;
  }>;
}

export interface SimulationParams { populationSize: number; seed: number; mode: SimulationMode }

export interface SimulationResult {
  meta: {
    dataType: 'SYNTHETIC'; synthetic: true; policySlug: string;
    seed: number; populationSize: number; mode: SimulationMode;
    activeRuleCodes: string[]; ignoredRules: Array<{ ruleCode: string; reason: string }>;
    configHash: string; resultHash: string;
  };
  summary: {
    counts: Counts; rates: { eligible: number; rejected: number; review: number };
    rejectionReasons: Array<{ ruleCode: string; count: number; share: number }>;
  };
  edgeCases: EdgeCase[];
  edgeCaseCounts: { total: number; byType: Record<string, number>; bySeverity: Record<string, number> };
  cliffs: Cliff[];
  conflicts: RuleConflict[];
  fairness: FairnessAnalysis;
}
