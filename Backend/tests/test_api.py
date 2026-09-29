"""Run:  pytest -q      (offline; uses FastAPI's TestClient)"""
from io import BytesIO

import pytest
from fastapi.testclient import TestClient
from reportlab.pdfgen import canvas

from app.main import app

client = TestClient(app)
P = "/api/v1"


def data(r):
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["success"] is True
    return body


def test_health():
    assert data(client.get("/health"))["data"]["status"] == "ok"


def test_policies_and_detail():
    items = data(client.get(f"{P}/policies"))["data"]
    assert {p["slug"] for p in items} >= {"scholarship-eligibility", "delhi-ration-food-security", "delhi-lakshmi-yojana"}
    d = data(client.get(f"{P}/policies/scholarship-eligibility"))["data"]
    rules = d["currentVersion"]["rules"]
    assert [r["normalizedConstraint"] for r in rules] == ["income_annual <= 500000", "cgpa >= 7.0", "financial_need == true"]
    assert d["whatIf"]["defaultFormatted"] == "₹6,00,000"


def test_overview_simulation_and_cases():
    ov = data(client.get(f"{P}/dashboard/overview", params={"policySlug": "scholarship-eligibility"}))["data"]
    sim = ov["simulation"]
    r = sim["results"]
    assert r["totalTested"] == 100000 and r["eligibleCount"] + r["rejectedCount"] + r["needsReviewCount"] == 100000
    assert len(ov["health"]) == 5 and ov["insight"]["headline"]
    sid = sim["id"]
    edge = data(client.get(f"{P}/simulations/{sid}/cases", params={"filter": "edge"}))
    assert edge["meta"]["total"] > 0 and all(c["isEdgeCase"] for c in edge["data"])
    rej = data(client.get(f"{P}/simulations/{sid}/cases", params={"filter": "rejected", "q": "5,00,001"}))["data"]
    assert rej and all(c["result"] == "REJECTED" for c in rej)
    cliffs = data(client.get(f"{P}/simulations/{sid}/cliffs"))["data"]
    assert cliffs[0]["thresholdValue"] == "₹5,00,000" and cliffs[0]["dataPoints"][-1]["outcome"] == "REJECTED"
    assert data(client.get(f"{P}/simulations/{sid}/conflicts"))["data"]
    assert len(data(client.get(f"{P}/simulations/{sid}/fairness"))["data"]["heatmap"]) == 35


def test_simulation_modes_reproducible_and_limits():
    body = {"policySlug": "delhi-lakshmi-yojana", "populationSize": 20000, "seed": 7}
    a = data(client.post(f"{P}/simulations", json={**body, "mode": "BOUNDARY_SCAN"}))["data"]["results"]
    b = data(client.post(f"{P}/simulations", json={**body, "mode": "BOUNDARY_SCAN"}))["data"]["results"]
    base = data(client.post(f"{P}/simulations", json={**body, "mode": "STRESS_TEST"}))["data"]["results"]
    assert a == b                                            # same seed => identical results
    assert a["edgeCaseCount"] > base["edgeCaseCount"]        # boundary scan crowds thresholds
    assert client.post(f"{P}/simulations", json={"populationSize": 10**9}).status_code == 400
    assert client.post(f"{P}/simulations", json={"policySlug": "nope"}).status_code == 404


def test_what_if_numeric_and_natural_language():
    sid = data(client.get(f"{P}/simulations/latest", params={"policySlug": "scholarship-eligibility"}))["data"]["id"]
    up = data(client.post(f"{P}/what-if", json={"simulationId": sid, "newValue": 600000}))["data"]
    assert up["eligibleDelta"] > 0 and up["budgetFormatted"].startswith("+") and up["aiExplanation"]
    assert up["changed"]["eligible"] == up["baseline"]["eligible"] + up["eligibleDelta"]
    down = data(client.post(f"{P}/what-if", json={"simulationId": sid, "scenario": "What if the income threshold drops to ₹4 lakh?"}))["data"]
    assert down["newValue"] == 400000 and down["eligibleDelta"] < 0
    cg = data(client.post(f"{P}/what-if", json={"simulationId": sid, "scenario": "lower the CGPA cutoff to 6.5"}))["data"]
    assert cg["parameter"] == "R02" and cg["eligibleDelta"] > 0
    assert client.post(f"{P}/what-if", json={"simulationId": sid}).status_code == 400


def test_chat_and_reports():
    reply = data(client.post(f"{P}/chat", json={"message": "Explain the policy cliff", "policySlug": "scholarship-eligibility"}))["data"]["reply"]
    assert "₹5,00,000" in reply
    rep = data(client.post(f"{P}/reports", json={"policySlug": "scholarship-eligibility", "reportType": "AUDIT_REPORT"}))["data"]
    pdf = client.get(rep["downloadUrl"])
    assert pdf.status_code == 200 and pdf.content.startswith(b"%PDF") and "attachment" in pdf.headers["content-disposition"]
    for kind in ("SIMULATION_REPORT", "VERSION_COMPARISON", "RULE_EXTRACTION_LOG"):
        r = data(client.post(f"{P}/reports", json={"policySlug": "scholarship-eligibility", "reportType": kind}))["data"]
        assert client.get(r["downloadUrl"], params={"inline": True}).content.startswith(b"%PDF")
    assert len(data(client.get(f"{P}/reports", params={"policySlug": "scholarship-eligibility"}))["data"]) >= 4


TEXT = """Merit Support Scheme
1. Annual family income must not exceed Rs. 4,50,000.
2. Applicant must have a CGPA of at least 6.5.
3. Applicant must be a Delhi resident.
4. Applicant must not be a government employee."""


def test_extract_text_then_simulate():
    out = data(client.post(f"{P}/policies/extract-text", json={"text": TEXT}))["data"]
    rules = out["extraction"]["rules"]
    assert out["policy"]["name"] == "Merit Support Scheme"
    assert [r["normalizedConstraint"] for r in rules] == ["income_annual <= 450000", "cgpa >= 6.5", "delhi_resident == true", "govt_employee == false"]
    slug = out["policy"]["slug"]
    sim = data(client.post(f"{P}/simulations", json={"policySlug": slug, "populationSize": 10000}))["data"]
    assert sim["results"]["totalTested"] == 10000 and sim["results"]["eligibleCount"] > 0
    assert data(client.post(f"{P}/policies/{slug}/confirm-rules"))["data"]["currentVersion"]["rules"][0]["verificationStatus"] == "VERIFIED"
    rid = rules[1]["id"]
    patched = data(client.patch(f"{P}/policies/{slug}/rules/{rid}", json={"normalizedConstraint": "cgpa >= 7.5"}))["data"]
    assert patched["value"] == 7.5 and patched["verificationStatus"] == "NEEDS_REVIEW"
    assert client.patch(f"{P}/policies/{slug}/rules/{rid}", json={"normalizedConstraint": "bogus >= 1"}).status_code == 400
    assert client.post(f"{P}/policies/extract-text", json={"text": "Nothing machine readable lives in this sentence at all."}).status_code == 422


def _pdf(text: str) -> bytes:
    buf = BytesIO()
    c = canvas.Canvas(buf)
    y = 800
    for line in text.splitlines():
        c.drawString(50, y, line)
        y -= 18
    c.save()
    return buf.getvalue()


def test_extract_pdf():
    ok = client.post(f"{P}/policies/extract-pdf", files={"file": ("Ration_Policy.pdf", _pdf("Ration Policy\nAnnual income must be at most Rs 1,20,000.\nNo four-wheeler ownership."), "application/pdf")})
    d = data(ok)["data"]
    assert d["policy"]["currentVersion"]["sourceType"] == "PDF" and len(d["extraction"]["rules"]) == 2
    assert client.post(f"{P}/policies/extract-pdf", files={"file": ("x.pdf", b"not a pdf", "application/pdf")}).status_code == 400


def test_validation_envelope():
    r = client.post(f"{P}/policies/extract-text", json={"text": "short"})
    assert r.status_code == 400 and r.json()["error"]["code"] == "VALIDATION_ERROR"
