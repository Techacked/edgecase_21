# EDGECASE Backend — Phase 1: Engine + Schema

Status: the deterministic simulation engine, data-driven policy definitions, Prisma schema and seed are
implemented and tested. The Express API, job runner, AI providers, PDF extraction/reports and frontend wiring
are **not built yet** (see "Not yet implemented").

## Layout
```
src/engine/        pure, Express-free, deterministic engine
  types.ts  constraint-evaluator.ts  synthetic-population.ts
  boundary-analysis.ts (edge cases + cliffs)  conflict-analysis.ts  fairness-analysis.ts
  simulation-runner.ts (runSimulation)  what-if.ts (runWhatIf)
src/config/policy-definitions.ts   the 3 seeded policies (DEMO SEED CONFIGURATION)
src/utils/                          seeded RNG, hashing, AppError codes
prisma/schema.prisma  prisma/seed.ts
tests/unit/                         45 tests
```

## Commands
```
npm install
npx prisma generate
npx prisma migrate dev --name init     # needs DATABASE_URL, see .env.example
npm run db:seed
npm test
npm run typecheck
npm run build
```

## Engine semantics
- Rule types: `ELIGIBILITY` (must hold), `EXCLUSION` (rejects if it holds), `REVIEW_TRIGGER` (NEEDS_REVIEW if it holds and nothing rejects).
- Only `VERIFIED` + `enabled` rules ever execute; others are reported in `meta.ignoredRules`.
- Case `i` draws from `mixSeed(seed, i)`, so results are reproducible and independent of population size.
- Modes: `STRESS_TEST` natural distributions; `BOUNDARY_SCAN` ~30% of cases pulled within ±3 steps of active thresholds; `FAIRNESS_AUDIT` stratified across the policy's income bands.
- Cliffs: every case is re-evaluated one step either side of every numeric threshold. Nothing is fixed; thresholds outside the variable domain are skipped.
- Conflicts: interval/set analysis on same-variable active rules + empirical impact on the synthetic population.
- What-If: one population, baseline vs changed rules, only the named parameter differs.
- All output is `dataType: "SYNTHETIC"`. Budget figures are labelled `SIMULATED ESTIMATE`.

## Not yet implemented
Express app/routes/controllers/repositories, async job worker, Gemini provider, PDF text extraction, PDF reports,
NL what-if, chat, integration tests, frontend wiring. Seeded thresholds are illustrative, not current law.
