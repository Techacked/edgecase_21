"""Run:  pytest -q      (offline; uses FastAPI's TestClient)"""
from io import BytesIO
import zipfile

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


def test_root_and_api_base_routes():
    root = data(client.get("/"))
    assert root["data"]["service"] == "EDGECASE API"
    assert data(client.get("/api/v1"))["data"]["service"] == "EDGECASE API"


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
    overview = data(client.get(f"{P}/dashboard/overview", params={"policySlug": slug}))["data"]
    assert overview["policy"]["slug"] == slug and overview["rulesCount"] == len(rules)
    cliffs = data(client.get(f"{P}/simulations/{overview['simulation']['id']}/cliffs"))["data"]
    assert any(c["variable"] == "Annual Family Income" and c["thresholdValue"] == "₹4,50,000" for c in cliffs)
    sim = data(client.post(f"{P}/simulations", json={"policySlug": slug, "populationSize": 10000}))["data"]
    assert sim["policyName"] == out["policy"]["name"]
    assert sim["results"]["totalTested"] == 10000 and sim["results"]["eligibleCount"] > 0
    run_overview = data(client.get(f"{P}/dashboard/overview", params={"policySlug": slug, "simulationId": sim["id"]}))["data"]
    assert run_overview["simulation"]["id"] == sim["id"] and run_overview["simulation"]["results"]["totalTested"] == 10000
    assert run_overview["policy"]["slug"] == slug
    assert data(client.post(f"{P}/policies/{slug}/confirm-rules"))["data"]["currentVersion"]["rules"][0]["verificationStatus"] == "VERIFIED"
    rid = rules[1]["id"]
    patched = data(client.patch(f"{P}/policies/{slug}/rules/{rid}", json={"normalizedConstraint": "cgpa >= 7.5"}))["data"]
    assert patched["value"] == 7.5 and patched["verificationStatus"] == "NEEDS_REVIEW"
    assert client.patch(f"{P}/policies/{slug}/rules/{rid}", json={"normalizedConstraint": "bogus >= 1"}).status_code == 400
    failed = client.post(f"{P}/policies/extract-text", json={"text": "Nothing machine readable lives in this sentence at all."})
    assert failed.status_code == 422 and "Unable to extract executable rules" in failed.json()["error"]["message"]


def test_upload_dataset_validation_and_run():
    policy = data(client.post(f"{P}/policies/extract-text", json={"text": TEXT})) ["data"]["policy"]
    assert policy["policyName"] == "Merit Support Scheme" and policy["policyHash"]
    partial = client.post(f"{P}/policies/{policy['slug']}/datasets", files={
        "file": ("partial.csv", b"annual_income,cgpa\n200000,7.0\n", "text/csv")})
    assert partial.status_code == 422
    assert set(partial.json()["error"]["details"]["missingVariables"]) == {"Delhi Residency", "Government Employment"}
    content = b"annual_income,cgpa,delhi_resident,govt_employee\n200000,7.0,true,false\n600000,6.0,false,true\n"
    dataset = data(client.post(f"{P}/policies/{policy['slug']}/datasets", files={
        "file": ("applicants.csv", content, "text/csv")}))["data"]
    assert dataset["recordCount"] == 2 and dataset["dataSource"] == "UPLOADED"
    sim = data(client.post(f"{P}/simulations", json={
        "policySlug": policy["slug"], "datasetId": dataset["id"], "populationSize": 1000})) ["data"]
    assert sim["dataSource"] == "UPLOADED" and sim["datasetId"] == dataset["id"]
    assert sim["results"]["totalTested"] == 2


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


def _docx_bytes(text: str) -> bytes:
    parts = ''.join(f'<w:p><w:r><w:t>{part}</w:t></w:r></w:p>' for part in text.splitlines())
    xml = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>{parts}</w:body></w:document>'''
    buf = BytesIO()
    with zipfile.ZipFile(buf, mode='w', compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
        zf.writestr('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
        zf.writestr('word/document.xml', xml)
    return buf.getvalue()


def test_extract_docx_upload_and_policy_flow_aliases():
    content = _docx_bytes("Ration Distribution Policy\nAnnual income must not exceed Rs. 1,50,000.\nIf household size is above 5, extra support applies.")
    upload = data(client.post(f"{P}/policies/upload", files={"file": ("Ration_Policy.docx", content, "application/vnd.openxmlformats-officedocument.wordprocessingml.document")}))["data"]
    policy = upload["policy"]
    assert policy["policyName"] == "Ration Distribution Policy"
    policy_id = policy["policyId"]
    generated = data(client.post(f"{P}/policies/{policy_id}/generate-data", json={"populationSize": 500, "seed": 11}))["data"]
    assert generated["recordCount"] == 500 and generated["dataSource"] == "SYNTHETIC"
    sim = data(client.post(f"{P}/policies/{policy_id}/simulate", json={"mode": "STRESS_TEST", "populationSize": 500, "seed": 11}))["data"]
    assert sim["policyName"] == policy["policyName"] and sim["results"]["totalTested"] == 500


def test_validation_envelope():
    r = client.post(f"{P}/policies/extract-text", json={"text": "short"})
    assert r.status_code == 400 and r.json()["error"]["code"] == "VALIDATION_ERROR"


def test_policy_domain_variables_generate_and_simulate():
    simulation_ids = set()
    examples = [
        ("Ration Distribution & Subsidy Policy", """Ration Distribution & Subsidy Policy
Annual income must not exceed Rs. 500000.
Household size must be at least 2.
Age must be at least 18.
Number of children must be at least 2.
Applicant must have a disability.
Applicant residency must be verified.
Applicant must have a valid ration card.""", {"income_annual", "family_size", "age", "children_count", "disability_status", "residency", "ration_card_status"}),
        ("Voter Registration Policy", """Voter Registration Policy
Age must be at least 18.
Citizenship must be verified.
Identity must be verified.
Address must be verified.
Jurisdiction must match.
Duplicate flag must be false.
Applicant must not be deceased.""", {"age", "citizenship_verified", "identity_verified", "address_verified", "jurisdiction_match", "duplicate_flag", "deceased_flag"}),
        ("Scholarship Eligibility Policy", """Scholarship Eligibility Policy
Family income must not exceed Rs. 500000.
CGPA must be at least 7.
Attendance must be at least 80%.
Student year must be at least 2.""", {"income_annual", "cgpa", "attendance", "student_year"}),
    ]
    for name, text, expected_variables in examples:
        policy = data(client.post(f"{P}/policies/extract-text", json={"text": text})) ["data"]["policy"]
        assert policy["name"] == name
        actual_variables = {variable["key"] for variable in policy["currentVersion"]["variables"]}
        assert actual_variables == expected_variables

        dataset = data(client.post(f"{P}/policies/{policy['slug']}/generate-data", json={
            "populationSize": 500, "seed": 11,
        })) ["data"]
        assert set(dataset["variables"]) == expected_variables
        sim = data(client.post(f"{P}/policies/{policy['slug']}/simulate", json={
            "policyId": policy["id"], "populationSize": 500, "seed": 11,
        })) ["data"]
        assert sim["policyName"] == name
        assert sim["results"]["totalTested"] == 500
        simulation_ids.add(sim["id"])
        cases = data(client.get(f"{P}/simulations/{sim['id']}/cases", params={"filter": "edge"}))["data"]
        missing_cases = [case for case in cases if case["type"] == "MISSING_DATA"]
        assert missing_cases and all(case["result"] == "REVIEW" for case in missing_cases)
        if "income_annual" in expected_variables:
            boundary_values = {case["attributes"].get("income_annual") for case in cases}
            assert {499998, 499999, 500000, 500001, 500002} <= boundary_values
    history = data(client.get(f"{P}/simulations"))["data"]
    assert simulation_ids <= {sim["id"] for sim in history}


def test_ration_pdf_advisory_chat_and_history_use_active_policy(monkeypatch):
    from app import ai

    prompts = []
    chat_contexts = []
    monkeypatch.setattr(ai, "extract_rules_ai", lambda _: None)
    monkeypatch.setattr(ai, "provider", lambda: "gemini")

    def complete(system, user, max_tokens=700):
        prompts.append(user)
        return '{"recommendations":[{"category":"Threshold cliff","what":"Review a transition band.","why":"The simulated boundary is abrupt.","evidence":"Boundary cases change eligibility.","affectedPopulation":"Synthetic cases near the threshold.","tradeoff":"A transition band may increase benefit cost."}]}'

    def chat_reply(message, context):
        chat_contexts.append(context)
        return context["activePolicy"]["policyName"]

    monkeypatch.setattr(ai, "complete", complete)
    monkeypatch.setattr(ai, "chat_reply", chat_reply)
    text = """Ration Distribution & Subsidy Policy
Annual income must not exceed Rs. 500000.
Applicant must have a valid ration card."""
    upload = data(client.post(f"{P}/policies/upload", files={
        "file": ("Ration Distribution & Subsidy Policy.pdf", _pdf(text), "application/pdf"),
    })) ["data"]
    policy = upload["policy"]
    assert policy["name"] == "Ration Distribution & Subsidy Policy"
    sim = data(client.post(f"{P}/policies/{policy['slug']}/simulate", json={
        "policyId": policy["id"], "populationSize": 1000, "seed": 21,
    })) ["data"]

    advisory = data(client.get(f"{P}/policies/{policy['slug']}/advisory", params={
        "simulationId": sim["id"],
    })) ["data"]
    assert advisory["policyId"] == policy["id"] and advisory["simulationId"] == sim["id"]
    cliff = next(item for item in advisory["findings"] if item["category"] == "Threshold cliff")
    assert cliff["suggestedChange"] == "Review a transition band."
    assert cliff["why"] and cliff["tradeoff"]
    prompt = prompts[-1].lower()
    assert "ration distribution & subsidy policy" in prompt
    assert all(key in prompt for key in ("extractedrules", "syntheticpopulationstatistics", "edgecases", "fairnesssignals"))

    chat = data(client.post(f"{P}/chat", json={"message": "Explain this change", "simulationId": sim["id"]})) ["data"]
    assert chat["reply"] == policy["name"]
    assert chat_contexts[-1]["currentSimulation"]["policyId"] == policy["id"]
    assert chat_contexts[-1]["decisionTrace"]["edgeCases"]
    history = data(client.get(f"{P}/simulations"))["data"]
    assert any(item["id"] == sim["id"] and item["policyName"] == policy["name"] for item in history)
