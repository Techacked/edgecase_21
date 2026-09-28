/**
 * DEMO SEED CONFIGURATION — illustrative, developer-authored policy definitions.
 * Thresholds are examples for exercising the engine, not statements of current law.
 * No simulation results live here; every result comes from the engine.
 */
import type { PolicyModel, RuleType, Constraint } from '../engine/types';

export interface SeedRule { ruleCode: string; description: string; type: RuleType; constraint: Constraint; sourceText: string }
export interface PolicyDefinition {
  slug: string; name: string; description: string; model: PolicyModel; rules: SeedRule[];
}
const SRC = 'DEMO SEED CONFIGURATION — illustrative threshold';

const scholarship: PolicyDefinition = {
  slug: 'scholarship-eligibility',
  name: 'Scholarship Eligibility',
  description: 'Merit-and-need scholarship for students (demo seed configuration).',
  model: {
    slug: 'scholarship-eligibility', name: 'Scholarship Eligibility',
    variables: [
      { name: 'income', label: 'Annual Family Income', type: 'number', unit: 'INR', min: 0, max: 5_000_000, step: 1, decimals: 0, distribution: { kind: 'lognormal', median: 400_000, sigma: 0.7 } },
      { name: 'cgpa', label: 'CGPA', type: 'number', min: 0, max: 10, step: 0.1, decimals: 1, distribution: { kind: 'normal', mean: 7.2, sd: 1.1 } },
      { name: 'familySize', label: 'Family size', type: 'number', min: 1, max: 12, step: 1, decimals: 0, distribution: { kind: 'normal', mean: 4.5, sd: 1.8 } },
      { name: 'financialNeed', label: 'Financial Need', type: 'boolean', trueProbability: 0.55 },
      { name: 'location', label: 'Location', type: 'categorical', categories: [{ value: 'URBAN', weight: 0.5 }, { value: 'SEMI_URBAN', weight: 0.25 }, { value: 'RURAL', weight: 0.25 }] },
      { name: 'category', label: 'Category', type: 'categorical', categories: [{ value: 'GENERAL', weight: 0.45 }, { value: 'OBC', weight: 0.3 }, { value: 'SC', weight: 0.15 }, { value: 'ST', weight: 0.05 }, { value: 'EWS', weight: 0.05 }] },
    ],
    parameters: [
      { key: 'incomeThreshold', label: 'Income threshold', ruleCode: 'SCH-INC', min: 0, max: 5_000_000 },
      { key: 'minCgpa', label: 'Minimum CGPA', ruleCode: 'SCH-CGPA', min: 0, max: 10 },
    ],
    budget: { costPerEligibleCase: 50_000, currency: 'INR', assumptionDescription: 'Assumed flat annual scholarship of INR 50,000 per eligible synthetic case.' },
    fairness: { bandVariable: 'income', bandEdges: [0, 200_000, 400_000, 600_000, 800_000, 1_000_000], groupVariables: ['category', 'location'] },
    simulation: { nearThresholdBand: 0.02, maxEdgeCases: 500, defaultPopulationSize: 10_000 },
  },
  rules: [
    { ruleCode: 'SCH-INC', description: 'Annual family income must not exceed the threshold', type: 'ELIGIBILITY', constraint: { variable: 'income', operator: '<=', value: 500_000 }, sourceText: SRC },
    { ruleCode: 'SCH-CGPA', description: 'CGPA must meet the minimum', type: 'ELIGIBILITY', constraint: { variable: 'cgpa', operator: '>=', value: 7.0 }, sourceText: SRC },
    { ruleCode: 'SCH-NEED', description: 'Applicant must declare financial need', type: 'ELIGIBILITY', constraint: { variable: 'financialNeed', operator: '==', value: true }, sourceText: SRC },
    { ruleCode: 'SCH-FAM-REV', description: 'Very large households are routed to manual review', type: 'REVIEW_TRIGGER', constraint: { variable: 'familySize', operator: '>=', value: 9 }, sourceText: SRC },
  ],
};

const ration: PolicyDefinition = {
  slug: 'delhi-ration-food-security',
  name: 'Delhi Ration / Food Security',
  description: 'Household-level subsidised ration entitlement (demo seed configuration).',
  model: {
    slug: 'delhi-ration-food-security', name: 'Delhi Ration / Food Security',
    variables: [
      { name: 'householdIncome', label: 'Annual Family Income', type: 'number', unit: 'INR', min: 0, max: 2_000_000, step: 1, decimals: 0, distribution: { kind: 'lognormal', median: 180_000, sigma: 0.6 } },
      { name: 'ownsFourWheeler', label: 'Vehicle Ownership (four-wheeler)', type: 'boolean', trueProbability: 0.06 },
      { name: 'hasGovtEmployee', label: 'Government Employment', type: 'boolean', trueProbability: 0.08 },
      { name: 'isIncomeTaxPayer', label: 'Income Tax Status', type: 'boolean', trueProbability: 0.05 },
      { name: 'electricityLoadKw', label: 'Electricity Load', type: 'number', unit: 'kW', min: 0.5, max: 15, step: 0.1, decimals: 1, distribution: { kind: 'normal', mean: 2.5, sd: 1.5 } },
      { name: 'propertyStatus', label: 'Property Status', type: 'categorical', categories: [{ value: 'OWNED', weight: 0.35 }, { value: 'RENTED', weight: 0.4 }, { value: 'SLUM_CLUSTER', weight: 0.2 }, { value: 'HOMELESS', weight: 0.05 }] },
      { name: 'familyMembers', label: 'Household members', type: 'number', min: 1, max: 15, step: 1, decimals: 0, distribution: { kind: 'normal', mean: 4.6, sd: 2 } },
    ],
    parameters: [
      { key: 'incomeThreshold', label: 'Income threshold', ruleCode: 'RAT-INC', min: 0, max: 2_000_000 },
      { key: 'reviewElectricityLoadKw', label: 'Electricity load review trigger (kW)', ruleCode: 'RAT-LOAD-REV', min: 0.5, max: 15 },
    ],
    budget: { costPerEligibleCase: 9_000, currency: 'INR', assumptionDescription: 'Assumed annual subsidy value of INR 9,000 per eligible synthetic household.' },
    fairness: { bandVariable: 'householdIncome', bandEdges: [0, 50_000, 100_000, 150_000, 250_000, 500_000], groupVariables: ['propertyStatus'] },
    simulation: { nearThresholdBand: 0.02, maxEdgeCases: 500, defaultPopulationSize: 10_000 },
  },
  rules: [
    { ruleCode: 'RAT-INC', description: 'Annual household income must be ≤ the threshold', type: 'ELIGIBILITY', constraint: { variable: 'householdIncome', operator: '<=', value: 100_000 }, sourceText: SRC },
    { ruleCode: 'RAT-VEH', description: 'No four-wheeler ownership', type: 'EXCLUSION', constraint: { variable: 'ownsFourWheeler', operator: '==', value: true }, sourceText: SRC },
    { ruleCode: 'RAT-GOVT', description: 'No government employment', type: 'EXCLUSION', constraint: { variable: 'hasGovtEmployee', operator: '==', value: true }, sourceText: SRC },
    { ruleCode: 'RAT-LOAD-REV', description: 'High sanctioned electricity load is routed to manual review', type: 'REVIEW_TRIGGER', constraint: { variable: 'electricityLoadKw', operator: '>=', value: 6 }, sourceText: SRC },
  ],
};

const lakshmi: PolicyDefinition = {
  slug: 'delhi-lakshmi-yojana',
  name: 'Delhi Lakshmi Yojana',
  description: 'Monthly cash support for adult women beneficiaries (demo seed configuration).',
  model: {
    slug: 'delhi-lakshmi-yojana', name: 'Delhi Lakshmi Yojana',
    variables: [
      { name: 'age', label: 'Age', type: 'number', unit: 'years', min: 18, max: 90, step: 1, decimals: 0, distribution: { kind: 'normal', mean: 42, sd: 15 } },
      { name: 'familyIncome', label: 'Family Income', type: 'number', unit: 'INR', min: 0, max: 3_000_000, step: 1, decimals: 0, distribution: { kind: 'lognormal', median: 250_000, sigma: 0.65 } },
      { name: 'isDelhiResident', label: 'Delhi Residency', type: 'boolean', trueProbability: 0.92 },
      { name: 'isRegisteredVoter', label: 'Voter Status', type: 'boolean', trueProbability: 0.85 },
      { name: 'annualElectricityUnits', label: 'Electricity Consumption', type: 'number', unit: 'units/year', min: 0, max: 10_000, step: 1, decimals: 0, distribution: { kind: 'lognormal', median: 1800, sigma: 0.5 } },
      { name: 'hasGovtEmployee', label: 'Government Employment', type: 'boolean', trueProbability: 0.07 },
    ],
    parameters: [
      { key: 'incomeThreshold', label: 'Income threshold', ruleCode: 'LAK-INC', min: 0, max: 3_000_000 },
      { key: 'maxElectricityUnits', label: 'Maximum annual electricity units', ruleCode: 'LAK-ELEC', min: 0, max: 10_000 },
    ],
    budget: { costPerEligibleCase: 12_000, currency: 'INR', assumptionDescription: 'Assumed INR 1,000 per month (INR 12,000 per year) per eligible synthetic beneficiary.' },
    fairness: { bandVariable: 'familyIncome', bandEdges: [0, 100_000, 200_000, 300_000, 500_000, 1_000_000], groupVariables: ['isDelhiResident'] },
    simulation: { nearThresholdBand: 0.02, maxEdgeCases: 500, defaultPopulationSize: 10_000 },
  },
  rules: [
    { ruleCode: 'LAK-INC', description: 'Family income must be ≤ the threshold', type: 'ELIGIBILITY', constraint: { variable: 'familyIncome', operator: '<=', value: 250_000 }, sourceText: SRC },
    { ruleCode: 'LAK-ELEC', description: 'Annual electricity consumption must be ≤ 2,400 units', type: 'ELIGIBILITY', constraint: { variable: 'annualElectricityUnits', operator: '<=', value: 2_400 }, sourceText: SRC },
    { ruleCode: 'LAK-RES', description: 'Applicant must be a Delhi resident', type: 'ELIGIBILITY', constraint: { variable: 'isDelhiResident', operator: '==', value: true }, sourceText: SRC },
    { ruleCode: 'LAK-GOVT', description: 'Government employees are excluded', type: 'EXCLUSION', constraint: { variable: 'hasGovtEmployee', operator: '==', value: true }, sourceText: SRC },
    { ruleCode: 'LAK-VOTER-REV', description: 'Applicants not on the electoral roll are routed to manual review', type: 'REVIEW_TRIGGER', constraint: { variable: 'isRegisteredVoter', operator: '==', value: false }, sourceText: SRC },
  ],
};

export const POLICY_DEFINITIONS: PolicyDefinition[] = [scholarship, ration, lakshmi];
export const getPolicyDefinition = (slug: string): PolicyDefinition => {
  const d = POLICY_DEFINITIONS.find((p) => p.slug === slug);
  if (!d) throw new Error(`Unknown policy slug ${slug}`);
  return d;
};
