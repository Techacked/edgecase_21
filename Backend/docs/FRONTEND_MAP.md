# Frontend map (Step 1) — Next 16.3.3 / React 19 / TS 5.7

**Structure:** one client component file, `app/page.tsx` (~144 long lines), + `globals.css`, `components/ui/button.tsx`.
No service layer, no fetch/axios, no shared state store. Page state is `useState` in `Page`:
`page`, `policy` (a display-name string union), `mobileNav`, `chatOpen`. Typecheck: clean. Build: passes (types are skipped: `ignoreBuildErrors: true`).

## Screens → data they need → backend source
| Screen | Hard-coded today | Backend source |
|---|---|---|
| Overview | 100,000 cases, 9,284 edge cases, "07" cliffs, "13" conflicts, "+12.8% from prior run", "2 unresolved", Policy-health rows (81.4%, 94.2%, 9.3%, 76/100, "Medium"), insight "₹1 boundary excludes 4,821", "LIVE ENGINE", "LAST RUN 14:32" | latest completed simulation for the active policy: counts, edgeCaseCounts.total, cliffs.length, conflicts.length, top cliff `affectedCases`, `/health` |
| Policy Lab | `policies` map (rules, variables), "DEMO_POLICY_2026.TXT", "OCR CONFIDENCE 99.1%", "AI ENGINE READY", "3 VERIFIED", rule confidence `96+i`, 3rd rule always NEEDS REVIEW, formal-constraint text (scholarship's, shown for every policy), paste modal + PDF input only store text/filename | GET policies, versions, rules; POST extract-text / extract-pdf; verify/reject |
| Simulation | `setTimeout(900)`, population 100,000, mode cycler, 6 metric cards, donut (81.4%, "Needs review 2,106"), rejection-reason bars, anomaly text | POST simulations → poll status → results |
| Edge Cases tab | 4 fake rows (`EDGE-00421`…), search + filter cycler (all/rejected/eligible/edge), row click sets `selected` but **no detail UI exists** | GET simulations/:id/edge-cases (page, pageSize, search, type, result), GET edge-cases/:id |
| Cliffs tab | one fake cliff | `cliffs[]` |
| Conflicts tab | one fake conflict ("R12/R18") | `conflicts[]` |
| Fairness tab | 6 income bands 0–1L…5L+, 35-cell heatmap from `(i*7)%5`, "76 / 100" | `fairness.bands`, `fairness.groups`, `rejectionConcentration` |
| What-If | slider 0–100 with fake `extra=(t-50)*401.75`, label only ever ₹5L/₹6L, range ₹4L–₹7L for all policies, NL input static + dead button, AI explanation text static | POST what-if, `policy.parameters` |
| Explainer chat | canned replies | POST chat (needs AI) |
| Reports | `.txt` blob named report, "28 SEP 2026", 06 rules / 09,284 / 76 stats, 3 secondary cards | POST reports, GET reports/:id/pdf |

## Mismatches with the spec that need a decision
1. **Population size:** UI says 100,000; spec's `.env.example` says `MAX_POPULATION_SIZE=10000`. 100k runs in ~1.9 s in the engine, so `.env.example` now uses 100000. UI default stays 100,000.
2. **Policy identity:** UI keys on display name; API needs slug/id. A small name→policy lookup from GET /policies is required.
3. **No "current run" concept in the API spec.** Overview/Simulation/What-If/Reports all assume a latest run. Suggest `GET /simulations?policyVersionId=&status=COMPLETED&limit=1` (not in the spec).
4. **Rule verification UI is missing.** "Confirm Rules & Continue" must gate on verified rules; there are no verify/reject controls. A minimal per-rule pair of buttons is required.
5. **Edge-case detail:** row click needs a small detail panel.
6. **Cases table:** "all / eligible / rejected" implies non-edge cases, but the spec's endpoint returns edge cases only. Plan: map to the `result` filter over edge cases and relabel "All simulation cases" → "Edge cases".
7. **Zero conflicts is the real seeded result.** Cliffs/Conflicts tabs need list + empty states, not one fixed card.
8. **Metrics with no defined derivation** (must be derived, relabelled, or removed rather than invented): "76/100 fairness indicator", "94.2% rule consistency", "Budget sensitivity: Medium", "2 unresolved", "+12.8% from prior run", "OCR confidence", the 35-cell heatmap, "Policy Version Comparison" and "Rule Extraction Log" report cards.
9. **What-If slider bounds:** parameter min/max in the engine are validity bounds (0–5M), not sensible slider ranges. Needs a UI range per parameter.
10. **AI states:** NL what-if, explanation panel and chat must show an explicit AI_PROVIDER_UNAVAILABLE state when no key is set.
11. **Type labels:** UI tags are POLICY CLIFF / BOUNDARY CASE / RULE CONFLICT / EXCLUSION RULE; engine types are BOUNDARY_VALUE, JUST_BELOW/ABOVE_THRESHOLD, HIGH_IMPACT_COMBINATION, etc. A display map is needed. Result tag `REVIEW` ↔ enum `NEEDS_REVIEW`.
12. **Currency formatting:** use `toLocaleString('en-IN')` to keep ₹5,00,000 style.
13. `package.json` says pnpm, both lockfiles present; `ignoreBuildErrors: true` should be turned off once wired. No frontend tests exist.

## Backend policy definitions were aligned to this UI
Ration and Lakshmi previously used rules I had invented (residency years, age). They now use the UI's own variables/rules
(vehicle, government employment, income-tax status, electricity load, property status; electricity ≤ 2,400 units, Delhi residency, voter status).
