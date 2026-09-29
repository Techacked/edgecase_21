# EDGECASE (Frontend + FastAPI backend)

## Run the backend (port 8000)
```bash
cd Backend
python -m venv venv
# Windows: venv\Scripts\activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000     # or: python run.py
```
- Interactive API docs: http://localhost:8000/docs
- Health check: http://localhost:8000/health
- No database needed (in-memory store, demo policies re-seed on every start).
- Works fully offline (`AI_PROVIDER=mock`). For real LLM rule-extraction/explanations set
  `AI_PROVIDER=anthropic` + `ANTHROPIC_API_KEY`, or `AI_PROVIDER=gemini` + `GEMINI_API_KEY` in `Backend/.env`.
- Tests: `pytest -q`

## Run the frontend (port 3000)
```bash
cd Frontend
cp .env.local.example .env.local     # NEXT_PUBLIC_API_URL=http://localhost:8000
npm install
npm run dev
```
Open http://localhost:3000 (start the backend first).

## API map (all under /api/v1, envelope: {success, data, meta?, error?})
| UI area | Endpoint |
|---|---|
| Policy dropdown / Policy Lab | GET /policies, GET /policies/{slug} |
| Paste text / Upload policy | POST /policies/extract-text, POST /policies/upload (PDF, DOCX, TXT) |
| Confirm rules / edit rule | POST /policies/{slug}/confirm-rules, PATCH /policies/{slug}/rules/{id} |
| Overview + Simulation header | GET /dashboard/overview |
| Generate policy-specific demo data | POST /policies/{slug}/generate-data |
| Run uploaded policy simulation | POST /policies/{slug}/simulate (mode: STRESS_TEST / BOUNDARY_SCAN / FAIRNESS_AUDIT) |
| Simulation history | GET /simulations |
| Edge Cases table (filter + search) | GET /simulations/{id}/cases?filter=all\|eligible\|rejected\|edge&q= |
| Cliffs / Conflicts / Fairness tabs | GET /simulations/{id}/cliffs, /conflicts, /fairness |
| What-If Lab (slider + natural language) | POST /what-if |
| Explain chat / policy advisory | POST /chat, GET /policies/{slug}/advisory?simulationId= |
| Reports | POST /reports, GET /reports, GET /reports/{id}/download |

The primary workflow is upload policy → extract and confirm rules → generate policy-specific demo data → simulate. Synthetic populations include threshold probes, extremes, and missing-data cases; missing required values are sent to manual review. Custom CSV/JSON/XLSX datasets remain available as an advanced option. All generated data is synthetic and seeded (same seed gives reproducible results).
