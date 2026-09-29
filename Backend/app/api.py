"""REST API (/api/v1). Every response uses the envelope {success, data, meta?, error?}."""
from __future__ import annotations

import csv
import datetime as dt
import json
import math
import re
import uuid
import zipfile
from io import BytesIO, StringIO
from typing import Literal, Optional
import xml.etree.ElementTree as ET

import numpy as np
from fastapi import APIRouter, File, Query, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from . import ai
from .catalog import primary_rule
from .config import settings
from .engine import _snap, build_population, constraint_str, is_num, run_simulation, vmap, what_if
from .extractor import build_custom_policy, deterministic_extract, parse_amount
from .fmt import compact_inr, fmt_value, inr, tidy
from .reports import TITLES, build_pdf
from .store import AppError, not_found, store

router = APIRouter(prefix="/api/v1")
MODES = ("STRESS_TEST", "BOUNDARY_SCAN", "FAIRNESS_AUDIT")
REPORT_TYPES = tuple(TITLES)


def ok(data, **meta):
    return {"success": True, "data": data, **({"meta": meta} if meta else {})}


# ───────────────────────── request models ─────────────────────────
class SimBody(BaseModel):
    policySlug: Optional[str] = None
    policyId: Optional[str] = None
    datasetId: Optional[str] = None
    mode: Literal["STRESS_TEST", "BOUNDARY_SCAN", "FAIRNESS_AUDIT"] = "STRESS_TEST"
    populationSize: int = Field(100000, ge=1)
    seed: int = 12345


class SyntheticDatasetBody(BaseModel):
    populationSize: int = Field(10000, ge=1)
    seed: int = 12345


class ExtractBody(BaseModel):
    text: str = Field(..., min_length=20, max_length=60000)
    title: Optional[str] = Field(None, max_length=120)
    sourceFileName: Optional[str] = Field(None, max_length=255)


class RulePatch(BaseModel):
    verificationStatus: Optional[Literal["NEEDS_REVIEW", "VERIFIED", "REJECTED"]] = None
    enabled: Optional[bool] = None
    normalizedConstraint: Optional[str] = None


class WhatIfBody(BaseModel):
    simulationId: Optional[str] = None
    policySlug: Optional[str] = None
    parameter: Optional[str] = None
    newValue: Optional[float] = None
    scenario: Optional[str] = Field(None, max_length=500)
    explain: Optional[bool] = None


class ChatBody(BaseModel):
    message: str = Field(..., min_length=1, max_length=2000)
    simulationId: Optional[str] = None
    policySlug: Optional[str] = None


class ReportBody(BaseModel):
    simulationId: Optional[str] = None
    policySlug: Optional[str] = None
    reportType: Literal["AUDIT_REPORT", "SIMULATION_REPORT", "VERSION_COMPARISON", "RULE_EXTRACTION_LOG"] = "AUDIT_REPORT"


# ───────────────────────── DTO builders ─────────────────────────
def rule_dto(policy: dict, r: dict) -> dict:
    return {
        "id": r["id"], "policyVersionId": policy["versionId"], "ruleCode": r["code"], "description": r["description"],
        "shortLabel": r["short"], "type": r["type"], "variable": r["var"], "operator": r["op"], "value": r["value"],
        "normalizedConstraint": constraint_str(r), "confidence": r["confidence"], "sourceText": r.get("sourceText"),
        "verificationStatus": r["verificationStatus"], "enabled": r.get("enabled", True), "orderIndex": r["orderIndex"],
        "createdAt": policy["createdAt"], "updatedAt": policy["updatedAt"],
    }


def _readable(v: dict, x: float) -> str:
    if v.get("fmt") == "inr":
        return f"₹{x / 1e5:g} lakh" if x >= 1e5 else inr(x)
    return str(tidy(x))


def whatif_config(policy: dict) -> dict | None:
    prim = primary_rule(policy)
    if not prim:
        return None
    v = vmap(policy)[prim["var"]]
    t = prim["value"]
    round_to = max(v.get("step", 1), 10 ** (int(math.log10(abs(t))) - 1) / 2) if t else v.get("step", 1)
    snap = lambda x: round(x / round_to) * round_to if round_to >= 1 else round(round(x / round_to) * round_to, 4)
    lo, hi, dflt = snap(t * 0.8), snap(t * 1.4), snap(t * 1.2)
    return {
        "ruleCode": prim["code"], "variable": prim["var"], "label": v["name"], "shortLabel": prim["short"],
        "current": t, "min": lo, "max": hi, "default": dflt, "roundTo": round_to,
        "currentFormatted": fmt_value(v, t), "minFormatted": fmt_value(v, lo), "maxFormatted": fmt_value(v, hi),
        "defaultFormatted": fmt_value(v, dflt),
        "prompt": f"What happens if the {prim['short'].lower()} increases to {_readable(v, dflt)}?",
    }


def policy_dto(p: dict) -> dict:
    return {
        "id": p["slug"], "slug": p["slug"], "name": p["name"], "description": p["description"],
        "policyId": p["slug"], "policyName": p["name"], "policyDescription": p.get("policyDescription", p["description"]),
        "policyVersion": p.get("policyVersion", str(p["versionNumber"])), "policyStatus": p.get("policyStatus", "DEMO"),
        "effectiveDate": p.get("effectiveDate"), "policyDomain": p.get("policyDomain", p.get("category")),
        "sourceFileName": p.get("sourceFileName"), "uploadedAt": p.get("uploadedAt"), "policyHash": p.get("policyHash"),
        "benefits": p.get("benefits", []), "exceptions": p.get("exceptions", []), "ambiguousTerms": p.get("ambiguousTerms", []),
        "department": p.get("department"), "category": p.get("category"), "authority": p.get("authority"),
        "createdAt": p["createdAt"], "updatedAt": p["updatedAt"], "whatIf": whatif_config(p),
        "currentVersion": {
            "id": p["versionId"], "policyId": p["slug"], "versionNumber": p["versionNumber"], "title": p["name"],
            "documentText": p["documentText"], "sourceType": p["sourceType"], "ocrConfidence": p.get("ocrConfidence"),
            "variables": [{"name": v["name"], "key": v["key"], "type": v["type"], "unit": v.get("unit") or None} for v in p["variables"]],
            "thresholds": {r["code"]: r["value"] for r in p["rules"] if is_num(r)},
            "budgetAssumptions": p["budget"], "createdAt": p["createdAt"],
            "rules": [rule_dto(p, r) for r in p["rules"]],
        },
    }


def sim_dto(sim: dict) -> dict:
    keys = ("id", "policySlug", "policyVersionId", "status", "mode", "populationSize", "seed", "startedAt",
            "completedAt", "createdAt", "durationMs", "results")
    return {**{k: sim[k] for k in keys}, "policyName": sim["policySnapshot"]["name"],
        "policyVersion": sim["policySnapshot"].get("policyVersion", str(sim["policySnapshot"].get("versionNumber", 1))),
            "datasetId": sim.get("datasetId"), "dataSource": sim.get("dataSource", "DEMO_SYNTHETIC")}


def report_dto(rep: dict) -> dict:
    return {**{k: v for k, v in rep.items() if k != "pdfPath"}, "downloadUrl": f"/api/v1/reports/{rep['id']}/download"}


# ───────────────────────── simulation helpers ─────────────────────────
def _run(slug: str, mode: str, n: int, seed: int, dataset: dict | None = None) -> dict:
    if n > settings.max_population:
        raise AppError(f"populationSize exceeds the maximum of {settings.max_population:,}", "SIMULATION_LIMIT_EXCEEDED", 400)
    policy = store.policy(slug)
    try:
        population = None
        if dataset:
            n = dataset["recordCount"]
            population = {key: np.asarray(values) for key, values in dataset["columns"].items()}
        sim = run_simulation(policy, mode, n, seed, slug, population)
    except Exception as exc:
        raise AppError(f"Simulation failed: {exc}", "SIMULATION_FAILED", 500) from exc
    sim["datasetId"] = dataset["id"] if dataset else None
    sim["dataSource"] = dataset["dataSource"] if dataset else "DEMO_SYNTHETIC"
    store.add_sim(sim)
    return sim


def ensure_baseline(slug: str) -> dict:
    with store.lock:
        sim = store.latest_sim(slug)
        if sim is None:
            sim = _run(slug, "STRESS_TEST", min(100000, settings.max_population), 12345)
    return sim


def resolve_sim(sim_id: str | None, slug: str | None) -> dict:
    return store.sim(sim_id) if sim_id else ensure_baseline(slug or store.policy(None)["slug"])


def overview_dto(sim: dict) -> dict:
    r, p = sim["results"], sim["policySnapshot"]
    cliff = sim["cliffs"][0] if sim["cliffs"] else None  # primary rule first
    state = lambda good, watch: "Strong" if good else "Watch" if watch else "Review"
    sens_w = {"Low": 35, "Medium": 62, "High": 85}[r["budgetSensitivity"]]
    health = [
        {"name": "Coverage", "value": f"{r['eligibleRate']}%", "state": state(r["eligibleRate"] >= 75, r["eligibleRate"] >= 50), "width": r["eligibleRate"]},
        {"name": "Rule consistency", "value": f"{r['ruleConsistencyRate']}%", "state": state(r["ruleConsistencyRate"] >= 94, r["ruleConsistencyRate"] >= 85), "width": r["ruleConsistencyRate"]},
        {"name": "Edge-case density", "value": f"{r['edgeCaseRate']}%", "state": state(r["edgeCaseRate"] < 5, r["edgeCaseRate"] < 15), "width": min(100, r["edgeCaseRate"] * 6)},
        {"name": "Fairness indicator", "value": f"{r['fairnessScore']:.0f} / 100", "state": state(r["fairnessScore"] >= 85, r["fairnessScore"] >= 70), "width": r["fairnessScore"]},
        {"name": "Budget sensitivity", "value": r["budgetSensitivity"], "state": "Stable" if r["budgetSensitivity"] != "High" else "Review", "width": sens_w},
    ]
    if cliff:
        insight = {
            "code": f"SYSTEM INSIGHT / {int(sim['id'][:4], 16) % 10000:04d}",
            "headline": f"A {cliff['criticalChange']} boundary excludes {cliff['affectedCases']:,} otherwise eligible applicants.",
            "body": f"The current {cliff['variable'].lower()} threshold ({cliff['thresholdValue']}) creates a sharp eligibility cliff. Explore the impact of changing this rule in What-If Lab.",
        }
    else:
        insight = {"code": "SYSTEM INSIGHT", "headline": "No sharp numeric cliffs were detected.", "body": "This policy has no numeric thresholds to stress-test."}
    return {
        "simulation": sim_dto(sim), "policy": {"slug": sim["policySlug"], "name": p["name"]},
        "health": health, "insight": insight, "lastRun": dt.datetime.fromisoformat(sim["completedAt"]).astimezone().strftime("%H:%M"),
        "rulesCount": len(p["rules"]), "topCliff": cliff, "topConflict": sim["conflicts"][0] if sim["conflicts"] else None,
        "aiProvider": ai.provider(),
    }


def parse_scenario(text: str, policy: dict) -> tuple[str, float]:
    low, vm = text.lower(), vmap(policy)
    nums = [r for r in policy["rules"] if is_num(r)]
    if not nums:
        raise AppError("This policy has no numeric rule to adjust.", "NEEDS_CLARIFICATION", 422)
    stop = {"annual", "family", "status", "must", "be", "the", "of", "criterion", "threshold"}

    def score(r):
        words = set(re.findall(r"[a-z]+", f"{vm[r['var']]['name']} {r['short']} {r['var'].replace('_', ' ')}".lower())) - stop
        return sum(w in low for w in words)

    target = max(nums, key=score) if max(score(r) for r in nums) > 0 else (primary_rule(policy) or nums[0])
    m = re.search(r"(\d+(?:\.\d+)?)\s*%", low)
    if m:
        sign = -1 if any(k in low for k in ("decrease", "lower", "reduce", "cut", "drop")) else 1
        return target["code"], target["value"] * (1 + sign * float(m.group(1)) / 100)
    tail = low.rsplit(" to ", 1)[1] if " to " in low else low
    amt = parse_amount(tail)
    if amt is None:
        raise AppError("Couldn't find a target value in that scenario. Try “…increases to ₹6 lakh”.", "NEEDS_CLARIFICATION", 422)
    return target["code"], amt


# ───────────────────────── policies ─────────────────────────
@router.get("/policies")
def list_policies():
    return ok([policy_dto(p) for p in store.policies.values()])


@router.get("/policies/{slug}")
def get_policy(slug: str):
    return ok(policy_dto(store.policy(slug)))


def _extract(text: str, title: str | None, source_type: str, ocr: float | None,
             source_file_name: str | None = None) -> dict:
    raw = ai.extract_rules_ai(text)
    deterministic = raw is None
    raw = raw or deterministic_extract(text)
    if not raw:
        raise AppError("Unable to extract executable rules. Please review the uploaded policy and use clearer wording such as “Family income must be ≤ ₹5,00,000”.",
                       "NEEDS_CLARIFICATION", 422)
    first = next((ln.strip() for ln in text.splitlines() if ln.strip()), "")
    file_title = re.sub(r"\.[^.]+$", "", source_file_name or "").replace("_", " ").replace("-", " ").strip()
    name = (title or (first if len(first) <= 80 and not re.search(r"[≤≥<>]|must|shall", first, re.I) else file_title or "Custom Policy")).strip()
    policy = build_custom_policy(name, text, raw, source_type, ocr, deterministic, source_file_name)
    previous = [p for p in store.policies.values() if p.get("sourceType") != "DEMO" and p["name"].casefold() == name.casefold()]
    if previous:
        version = max(int(p.get("versionNumber", 1)) for p in previous) + 1
        policy["versionNumber"] = version
        policy["policyVersion"] = f"{version}.0"
        policy["versionId"] = f"{policy['slug']}-v{version}"
    store.add_policy(policy)
    return {"policy": policy_dto(policy), "extraction": {
        "policyTitle": name, "extractedText": text, "ocrConfidence": ocr,
        "rules": [rule_dto(policy, r) for r in policy["rules"]], "isDeterministicDemo": deterministic}}


@router.post("/policies/extract-text")
async def extract_text(body: ExtractBody):
    return ok(await run_in_threadpool(_extract, body.text, body.title, "TEXT", None, body.sourceFileName))


@router.post("/policies/extract-pdf")
async def extract_pdf(file: UploadFile = File(...)):
    data = await file.read()
    if len(data) > settings.max_upload_bytes:
        raise AppError("PDF is too large.", "UPLOAD_TOO_LARGE", 413)
    return ok(await run_in_threadpool(_extract_policy_file_bytes, data, file.filename))


@router.post("/policies/upload")
async def upload_policy(file: UploadFile = File(...)):
    data = await file.read()
    if len(data) > settings.max_upload_bytes:
        raise AppError("Uploaded policy is too large.", "UPLOAD_TOO_LARGE", 413)
    return ok(await run_in_threadpool(_extract_policy_file_bytes, data, file.filename))


@router.post("/policies/{slug}/generate-data")
def generate_policy_data(slug: str, body: SyntheticDatasetBody):
    return generate_dataset(slug, body)


@router.post("/policies/{slug}/simulate")
def simulate_policy(slug: str, body: SimBody):
    body.policySlug = body.policySlug or slug
    body.policyId = body.policyId or slug
    return create_simulation(body)


api_router = APIRouter(prefix="/api")


@api_router.post("/policies/upload")
async def upload_policy_api_alias(file: UploadFile = File(...)):
    return await upload_policy(file)


@api_router.post("/policies/{slug}/generate-data")
def generate_policy_data_api_alias(slug: str, body: SyntheticDatasetBody):
    return generate_dataset(slug, body)


@api_router.post("/policies/{slug}/simulate")
def simulate_policy_api_alias(slug: str, body: SimBody):
    body.policySlug = body.policySlug or slug
    body.policyId = body.policyId or slug
    return create_simulation(body)


def _token(value: str) -> str:
    return re.sub(r"[^a-z0-9]+", "_", value.strip().lower()).strip("_")


def _title_from_filename(filename: Optional[str]) -> str:
    return (filename or "Uploaded Policy").rsplit(".", 1)[0].replace("_", " ").replace("-", " ").strip().title()


def _title_from_text(text: str, fallback: Optional[str] = None) -> str:
    for line in text.splitlines():
        candidate = line.strip()
        if not candidate:
            continue
        if len(candidate) > 80:
            continue
        if re.search(r"[≤≥<>]|must|shall|if|then|where", candidate, re.I):
            continue
        return candidate.strip()
    return fallback or "Custom Policy"


def _extract_text_from_docx(data: bytes) -> str:
    try:
        with zipfile.ZipFile(BytesIO(data)) as zf:
            if "word/document.xml" not in zf.namelist():
                raise AppError("This DOCX file is missing a document body.", "UPLOAD_INVALID", 400)
            root = ET.fromstring(zf.read("word/document.xml"))
            ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
            paragraphs = []
            for par in root.findall(".//w:p", ns):
                words = []
                for node in par.findall(".//w:t", ns):
                    if node.text:
                        words.append(node.text)
                if words:
                    paragraphs.append(" ".join(words))
            text = "\n".join(paragraphs)
    except AppError:
        raise
    except Exception as exc:
        raise AppError(f"Could not read this DOCX policy: {exc}", "UPLOAD_INVALID", 400) from exc
    if not text.strip():
        raise AppError("This DOCX file has no readable text.", "UPLOAD_INVALID", 422)
    return text


def _extract_policy_file_bytes(data: bytes, filename: str | None, *, title: str | None = None):
    ext = (filename or "").lower().rsplit(".", 1)[-1] if "." in (filename or "") else ""
    fallback_title = title or _title_from_filename(filename)
    if ext == "pdf":
        if not data.startswith(b"%PDF"):
            raise AppError("Only PDF, DOCX, and TXT policy files are supported.", "UPLOAD_INVALID", 400)
        try:
            from pypdf import PdfReader
            text = "\n".join((pg.extract_text() or "") for pg in PdfReader(BytesIO(data)).pages)
        except Exception as exc:
            raise AppError(f"Could not read this PDF: {exc}", "UPLOAD_INVALID", 400) from exc
        if len(text.strip()) < 20:
            raise AppError("This PDF has no extractable text layer (scanned image?). OCR is not enabled.", "UPLOAD_INVALID", 422)
        return _extract(text, title or _title_from_text(text, fallback_title), "PDF", None, filename)
    if ext in {"txt", "text"}:
        text = data.decode("utf-8-sig", errors="replace")
        if len(text.strip()) < 20:
            raise AppError("This TXT policy is too short to extract executable rules.", "UPLOAD_INVALID", 422)
        return _extract(text, title or _title_from_text(text, fallback_title), "TXT", None, filename)
    if ext == "docx":
        text = _extract_text_from_docx(data)
        return _extract(text, title or _title_from_text(text, fallback_title), "DOCX", None, filename)
    raise AppError("Only PDF, DOCX, and TXT policy files are supported.", "UPLOAD_INVALID", 400)


def _dataset_rows(filename: str, contents: bytes) -> list[dict]:
    ext = filename.lower().rsplit(".", 1)[-1] if "." in filename else ""
    try:
        if ext == "csv":
            rows = list(csv.DictReader(StringIO(contents.decode("utf-8-sig"))))
        elif ext == "json":
            value = json.loads(contents.decode("utf-8-sig"))
            rows = value if isinstance(value, list) else value.get("records", value.get("data"))
        elif ext == "xlsx":
            from openpyxl import load_workbook
            sheet = load_workbook(BytesIO(contents), read_only=True, data_only=True).active
            values = sheet.iter_rows(values_only=True)
            headers = [str(value).strip() for value in next(values)]
            rows = [dict(zip(headers, row)) for row in values]
        else:
            raise AppError("Upload a CSV, JSON, or XLSX dataset.", "DATASET_FORMAT_UNSUPPORTED", 415)
    except AppError:
        raise
    except Exception as exc:
        raise AppError("Could not parse the uploaded dataset.", "DATASET_INVALID", 400) from exc
    if not isinstance(rows, list) or not rows or not all(isinstance(row, dict) for row in rows):
        raise AppError("Dataset must contain a non-empty array of records with column headers.", "DATASET_INVALID", 400)
    return rows


def _dataset_columns(policy: dict, rows: list[dict]) -> tuple[dict[str, list], list[str]]:
    aliases = {
        "income_annual": {"income", "annual_income", "family_income", "annual_family_income", "household_income"},
        "family_size": {"household_size", "number_of_household_members"},
        "delhi_resident": {"residency", "resident", "residence", "is_delhi_resident", "is_delhi_residency", "delhi_residency"},
        "govt_employee": {"government_employee", "is_government_employee", "is_govt_employee", "govt_employee"},
        "cgpa": {"gpa", "grade_point"},
        "age": {"applicant_age"},
    }
    headers = {_token(str(header)): header for header in rows[0]}
    columns, missing = {}, []
    for variable in policy["variables"]:
        key = variable["key"]
        candidates = {_token(key), _token(variable["name"]), *aliases.get(key, set())}
        source = next((headers[name] for name in candidates if name in headers), None)
        if source is None:
            missing.append(variable["name"])
            continue
        values = [row.get(source) for row in rows]
        if variable["type"] == "BOOLEAN":
            parsed = []
            for value in values:
                if isinstance(value, bool):
                    parsed.append(value)
                elif str(value).strip().lower() in {"true", "1", "yes", "y"}:
                    parsed.append(True)
                elif str(value).strip().lower() in {"false", "0", "no", "n"}:
                    parsed.append(False)
                else:
                    raise AppError(f"Invalid boolean value for {variable['name']}.", "DATASET_INVALID", 400)
            columns[key] = parsed
        elif variable["type"] == "NUMBER":
            try:
                parsed = [float(value) for value in values]
            except (TypeError, ValueError) as exc:
                raise AppError(f"Invalid number in dataset column {variable['name']}.", "DATASET_INVALID", 400) from exc
            if not np.isfinite(parsed).all():
                raise AppError(f"Dataset column {variable['name']} contains a non-finite number.", "DATASET_INVALID", 400)
            columns[key] = parsed
        else:
            if any(value is None or not str(value).strip() for value in values):
                raise AppError(f"Dataset column {variable['name']} contains empty values.", "DATASET_INVALID", 400)
            columns[key] = [str(value) for value in values]
    return columns, missing


def dataset_dto(dataset: dict) -> dict:
    fields = ("id", "policySlug", "policyName", "sourceFileName", "dataSource", "recordCount", "variables", "createdAt")
    return {key: dataset[key] for key in fields}


@router.post("/policies/{slug}/datasets")
async def upload_dataset(slug: str, file: UploadFile = File(...)):
    policy = store.policy(slug)
    contents = await file.read()
    if len(contents) > settings.max_upload_bytes:
        raise AppError("Dataset is too large.", "UPLOAD_TOO_LARGE", 413)
    rows = _dataset_rows(file.filename or "dataset", contents)
    if len(rows) > settings.max_population:
        raise AppError(f"Dataset exceeds the maximum of {settings.max_population:,} records.", "SIMULATION_LIMIT_EXCEEDED", 400)
    columns, missing = _dataset_columns(policy, rows)
    if missing:
        raise AppError("Dataset is missing required policy variables.", "DATASET_MISSING_VARIABLES", 422,
                       {"missingVariables": missing})
    dataset = {"id": str(uuid.uuid4()), "policySlug": slug, "policyName": policy["name"],
               "sourceFileName": file.filename or "dataset", "dataSource": "UPLOADED",
               "recordCount": len(rows), "variables": list(columns), "columns": columns,
               "createdAt": dt.datetime.now(dt.timezone.utc).isoformat()}
    store.add_dataset(dataset)
    return ok(dataset_dto(dataset))


@router.post("/policies/{slug}/datasets/synthetic")
def generate_dataset(slug: str, body: SyntheticDatasetBody):
    policy = store.policy(slug)
    if body.populationSize > settings.max_population:
        raise AppError(f"populationSize exceeds the maximum of {settings.max_population:,}", "SIMULATION_LIMIT_EXCEEDED", 400)
    generated = build_population(policy, body.populationSize, body.seed, "STRESS_TEST")
    columns = {key: [value.item() if isinstance(value, np.generic) else value for value in values]
               for key, values in generated.items()}
    dataset = {"id": str(uuid.uuid4()), "policySlug": slug, "policyName": policy["name"],
               "sourceFileName": None, "dataSource": "SYNTHETIC", "recordCount": body.populationSize,
               "variables": list(columns), "columns": columns, "createdAt": dt.datetime.now(dt.timezone.utc).isoformat()}
    store.add_dataset(dataset)
    return ok(dataset_dto(dataset))


@router.get("/policies/{slug}/datasets")
def list_datasets(slug: str):
    store.policy(slug)
    return ok([dataset_dto(d) for d in store.datasets.values() if d["policySlug"] == slug])


@router.patch("/policies/{slug}/rules/{rule_id}")
def patch_rule(slug: str, rule_id: str, body: RulePatch):
    p = store.policy(slug)
    r = next((x for x in p["rules"] if x["id"] == rule_id or x["code"] == rule_id), None)
    if not r:
        raise not_found("Rule")
    vm = vmap(p)
    if body.normalizedConstraint:
        m = re.match(r"^\s*(\w+)\s*(<=|>=|==|!=|<|>)\s*(.+?)\s*$", body.normalizedConstraint)
        if not m or m.group(1) not in vm:
            raise AppError("Constraint must look like `income_annual <= 500000` and use a known variable.", "VALIDATION_ERROR", 400)
        raw = m.group(3).lower()
        try:
            val = True if raw == "true" else False if raw == "false" else float(raw.replace(",", ""))
        except ValueError:
            raise AppError("Constraint value must be a number or true/false.", "VALIDATION_ERROR", 400)
        if isinstance(val, float) and val.is_integer() and "." not in raw:
            val = int(val)
        if (vm[m.group(1)]["type"] == "BOOLEAN") != isinstance(val, bool):
            raise AppError("Value type does not match the variable type.", "VALIDATION_ERROR", 400)
        r.update(var=m.group(1), op=m.group(2), value=val)
        if body.verificationStatus is None:
            r["verificationStatus"] = "NEEDS_REVIEW"
    if body.verificationStatus:
        r["verificationStatus"] = body.verificationStatus
    if body.enabled is not None:
        r["enabled"] = body.enabled
    p["updatedAt"] = dt.datetime.now(dt.timezone.utc).isoformat()
    store.latest.pop(slug, None)  # rules changed -> next overview re-runs the baseline
    return ok(rule_dto(p, r))


@router.post("/policies/{slug}/confirm-rules")
def confirm_rules(slug: str):
    p = store.policy(slug)
    for r in p["rules"]:
        if r["verificationStatus"] == "NEEDS_REVIEW":
            r["verificationStatus"] = "VERIFIED"
    return ok(policy_dto(p))


# ───────────────────────── simulations ─────────────────────────
@router.post("/simulations")
def create_simulation(body: SimBody):
    policy_slug = body.policySlug or body.policyId
    if not policy_slug:
        raise AppError("Provide a policySlug or policyId to run a simulation.", "VALIDATION_ERROR", 400)
    slug = store.policy(policy_slug)["slug"]
    dataset = None
    if body.datasetId:
        dataset = store.datasets.get(body.datasetId)
        if dataset is None:
            raise not_found("Dataset")
        if dataset["policySlug"] != slug:
            raise AppError("Dataset belongs to a different policy.", "DATASET_POLICY_MISMATCH", 400)
    return ok(sim_dto(_run(slug, body.mode, body.populationSize, body.seed, dataset)))


@router.get("/simulations")
def list_simulations(policySlug: Optional[str] = None):
    simulations = [sim for sim in store.sims.values() if not policySlug or sim["policySlug"] == policySlug]
    simulations.sort(key=lambda sim: sim["createdAt"], reverse=True)
    return ok([sim_dto(sim) for sim in simulations])


@router.get("/simulations/latest")
def latest_simulation(policySlug: Optional[str] = None):
    return ok(sim_dto(ensure_baseline(store.policy(policySlug)["slug"])))


@router.get("/simulations/{sim_id}")
def get_simulation(sim_id: str):
    return ok(sim_dto(store.sim(sim_id)))


@router.get("/simulations/{sim_id}/cases")
def list_cases(sim_id: str, filter: Literal["all", "eligible", "rejected", "edge"] = "all", q: str = "",
               page: int = Query(1, ge=1), pageSize: int = Query(50, ge=1, le=200)):
    sim = store.sim(sim_id)
    rows = sim["edgeCases"] if filter == "edge" else sim["edgeCases"] + sim["sampleCases"]
    if filter in ("eligible", "rejected"):
        rows = [c for c in rows if c["result"] == filter.upper()]
    if q.strip():
        needle = q.strip().lower()
        rows = [c for c in rows if needle in " ".join(str(c[k]) for k in ("caseIdentifier", "attributeSummary", "result", "reason", "type")).lower()]
    total = len(rows)
    return ok(rows[(page - 1) * pageSize: page * pageSize], total=total, page=page, pageSize=pageSize,
              totalPages=max(1, math.ceil(total / pageSize)), edgeCaseCount=sim["results"]["edgeCaseCount"],
              truncated=sim["results"]["edgeCaseCount"] > len(sim["edgeCases"]))


@router.get("/simulations/{sim_id}/cliffs")
def list_cliffs(sim_id: str):
    return ok(store.sim(sim_id)["cliffs"])


@router.get("/simulations/{sim_id}/conflicts")
def list_conflicts(sim_id: str):
    sim = store.sim(sim_id)
    rules = {r["code"]: r for r in sim["policySnapshot"]["rules"]}
    used = {c["ruleACode"] for c in sim["conflicts"][:1]} | {c["ruleBCode"] for c in sim["conflicts"][:1]}
    third = next((r for r in rules.values() if r["code"] not in used), None)
    return ok(sim["conflicts"], thirdRule={"code": third["code"], "short": third["short"]} if third else None,
              rules={c: r["short"] for c, r in rules.items()})


@router.get("/simulations/{sim_id}/fairness")
def get_fairness(sim_id: str):
    sim = store.sim(sim_id)
    return ok({**sim["fairness"], "score": sim["results"]["fairnessScore"]})


# ───────────────────────── what-if / chat / dashboard ─────────────────────────
@router.post("/what-if")
def run_what_if(body: WhatIfBody):
    sim = resolve_sim(body.simulationId, body.policySlug)
    policy = sim["policySnapshot"]
    code, value = body.parameter, body.newValue
    if value is None:
        if not body.scenario:
            raise AppError("Provide newValue or a natural-language scenario.", "VALIDATION_ERROR", 400)
        found_code, value = parse_scenario(body.scenario, policy)
        code = code or found_code
    try:
        w = what_if(sim, code, float(value), policy["budget"])
    except ValueError as exc:
        raise AppError(str(exc), "VALIDATION_ERROR", 400) from exc
    explain = True if body.explain is None else body.explain
    w["aiExplanation"] = ai.explain_whatif(w, policy["name"]) if explain else None
    w["scenario"] = body.scenario
    sim["whatIfRuns"] = (sim["whatIfRuns"] + [w])[-20:]
    return ok(w)


def chat_context(sim: dict) -> dict:
    policy = sim["policySnapshot"]
    rules = [{"code": r["code"], "description": r["description"], "constraint": constraint_str(r),
              "type": r["type"], "enabled": r.get("enabled", True)} for r in policy["rules"]]
    active_policy = {
        "policyId": policy["slug"], "policyName": policy["name"],
        "policyDescription": policy.get("policyDescription", policy.get("description", "")),
        "policyVersion": policy.get("policyVersion", str(policy.get("versionNumber", 1))),
        "policyRules": rules, "benefits": policy.get("benefits", []), "exceptions": policy.get("exceptions", []),
        "ambiguousTerms": policy.get("ambiguousTerms", []),
    }
    cliffs = [{k: c[k] for k in ("variable", "thresholdValue", "criticalChange", "affectedCases", "severity")}
              for c in sim["cliffs"][:3]]
    conflicts = [{k: c[k] for k in ("conflictCode", "title", "description", "affectedCases")}
                 for c in sim["conflicts"][:3]]
    decision_cases = [{"caseIdentifier": row["caseIdentifier"], "type": row["type"],
                       "attributes": row["attributes"], "reason": row["reason"],
                       "triggeredRules": row["triggeredRules"], "violatedRules": row["violatedRules"]}
                      for row in sim["edgeCases"][:8]]
    return {
        "activePolicy": active_policy,
        "currentSimulation": {"simulationId": sim["id"], "policyId": sim["policySlug"],
                              "policyVersionId": sim["policyVersionId"], "mode": sim["mode"],
                              "populationSize": sim["populationSize"], "results": sim["results"]},
        "decisionTrace": {"edgeCases": decision_cases, "cliffs": cliffs, "conflicts": conflicts},
        "policyName": policy["name"], "policyDescription": active_policy["policyDescription"],
        "policyVersion": active_policy["policyVersion"], "policyRules": rules,
        "benefits": active_policy["benefits"], "exceptions": active_policy["exceptions"],
        "ambiguousTerms": active_policy["ambiguousTerms"], "results": sim["results"], "rulesCount": len(rules),
        "cliffs": cliffs, "conflicts": conflicts,
        "lastWhatIf": sim["whatIfRuns"][-1] if sim["whatIfRuns"] else None,
    }


def advisory_for(sim: dict) -> dict:
    policy = sim["policySnapshot"]
    findings = []
    for cliff in sim["cliffs"]:
        if cliff["affectedCases"] <= 0:
            continue
        findings.append({
            "category": "Threshold cliff", "severity": cliff["severity"],
            "problem": f"Eligibility changes abruptly at {cliff['thresholdValue']} for {cliff['variable']}.",
            "currentPolicyRule": next((constraint_str(rule) for rule in policy["rules"] if rule["code"] == cliff["ruleCode"]), ""),
            "evidence": f"{cliff['affectedCases']:,} simulated cases fall within the tested boundary band; the critical step is {cliff['criticalChange']}.",
            "affectedPopulation": f"{cliff['affectedCases']:,} of {sim['populationSize']:,} simulated records near this threshold.",
            "risk": "Small measurement differences can produce different eligibility outcomes.",
            "suggestedChange": "Review whether a transition band or graduated benefit is appropriate; do not apply automatically.",
            "expectedEffect": "A gradual transition could reduce abrupt outcome changes around this threshold.",
            "confidence": "High", "policyOwnerDecision": "REVIEW",
        })
    for conflict in sim["conflicts"]:
        findings.append({
            "category": "Rule interaction", "severity": "HIGH",
            "problem": conflict["title"], "currentPolicyRule": f"{conflict['ruleACode']} + {conflict['ruleBCode']}",
            "evidence": conflict["description"],
            "affectedPopulation": f"{conflict['affectedCases']:,} simulated cases",
            "risk": "Overlapping or contradictory rules may lead to inconsistent decisions.",
            "suggestedChange": "Clarify rule precedence and document the intended outcome for the affected combination.",
            "expectedEffect": "Explicit precedence makes the combined rule outcome deterministic.",
            "confidence": "High", "policyOwnerDecision": "REVIEW",
        })
    text = policy.get("policyDescription", policy.get("description", ""))
    for term in policy.get("ambiguousTerms", []):
        findings.append({
            "category": "Ambiguous wording", "severity": "MEDIUM",
            "problem": f"The policy uses the undefined phrase “{term}”.", "currentPolicyRule": term,
            "evidence": f"The phrase appears in the uploaded policy text: {term}.",
            "affectedPopulation": "Not measurable from the current policy wording.",
            "risk": "Different reviewers may interpret this phrase differently.",
            "suggestedChange": "Define an objective criterion, decision owner, and required evidence for this phrase.",
            "expectedEffect": "A measurable definition improves consistent implementation.",
            "confidence": "Medium", "policyOwnerDecision": "REVIEW",
        })
    if policy.get("benefits") and not re.search(r"\b(cap|capped|maximum|not exceed|up to)\b", text, re.I):
        findings.append({
            "category": "Benefit limit", "severity": "LOW",
            "problem": "Benefit language was detected, but no explicit cap wording was found.",
            "currentPolicyRule": "; ".join(policy["benefits"][:3]),
            "evidence": "The uploaded policy mentions a benefit but the extracted text does not contain a clear maximum/cap term.",
            "affectedPopulation": "Not measurable from the current policy wording.",
            "risk": "Stacking or maximum exposure may be unclear to implementers.",
            "suggestedChange": "Confirm whether benefits may stack and state a total cap if one applies.",
            "expectedEffect": "An explicit cap or stacking rule clarifies maximum benefit exposure.",
            "confidence": "Low", "policyOwnerDecision": "REVIEW",
        })
    counts = {category: sum(item["category"] == category for item in findings)
              for category in ("Threshold cliff", "Rule interaction", "Ambiguous wording", "Benefit limit")}
    findings = ai.policy_advisory(policy, sim, findings)
    return {"policyId": policy["slug"], "policyName": policy["name"],
            "policyVersion": policy.get("policyVersion", str(policy.get("versionNumber", 1))),
            "simulationId": sim["id"], "dataSource": sim.get("dataSource", "DEMO_SYNTHETIC"),
            "populationSize": sim["populationSize"], "summary": {
                "issuesDetected": len(findings), "thresholdCliffs": counts["Threshold cliff"],
                "ruleInteractions": counts["Rule interaction"], "ambiguousConditions": counts["Ambiguous wording"],
                "fairnessScore": sim["results"]["fairnessScore"],
            }, "findings": findings}


@router.post("/chat")
async def chat(body: ChatBody):
    sim = await run_in_threadpool(resolve_sim, body.simulationId, body.policySlug)
    reply = await run_in_threadpool(ai.chat_reply, body.message, chat_context(sim))
    return ok({"reply": reply, "simulationId": sim["id"]}, provider=ai.provider())


@router.get("/policies/{slug}/advisory")
def get_policy_advisory(slug: str, simulationId: Optional[str] = None):
    policy = store.policy(slug)
    sim = store.sim(simulationId) if simulationId else ensure_baseline(policy["slug"])
    if sim["policySlug"] != slug:
        raise AppError("Simulation belongs to a different policy.", "SIMULATION_POLICY_MISMATCH", 400)
    return ok(advisory_for(sim))


@router.post("/policies/{slug}/advisory")
def generate_policy_advisory(slug: str, simulationId: Optional[str] = None):
    return get_policy_advisory(slug, simulationId)


@router.get("/dashboard/overview")
def dashboard(policySlug: Optional[str] = None, simulationId: Optional[str] = None):
    sim = store.sim(simulationId) if simulationId else ensure_baseline(store.policy(policySlug)["slug"])
    return ok(overview_dto(sim))


# ───────────────────────── reports ─────────────────────────
@router.post("/reports")
def create_report(body: ReportBody):
    sim = resolve_sim(body.simulationId, body.policySlug)
    policy = store.policies.get(sim["policySlug"]) or sim["policySnapshot"]
    name = sim["policySnapshot"]["name"]
    pdf = build_pdf(body.reportType, policy, sim, sim["whatIfRuns"], name)
    rid = str(uuid.uuid4())
    folder = settings.storage_dir / "reports"
    folder.mkdir(exist_ok=True)
    path = folder / f"{rid}.pdf"
    path.write_bytes(pdf)
    title, subtitle = TITLES[body.reportType]
    r = sim["results"]
    rep = {"id": rid, "simulationId": sim["id"], "policySlug": sim["policySlug"], "title": title, "subtitle": subtitle,
           "reportType": body.reportType, "policyName": name, "policyVersionNumber": policy["versionNumber"],
           "rulesExtractedCount": len(sim["policySnapshot"]["rules"]), "edgeCasesCount": r["edgeCaseCount"],
           "fairnessSignal": r["fairnessScore"], "summaryData": {"eligibleRate": r["eligibleRate"], "totalTested": r["totalTested"]},
           "status": "GENERATED", "createdAt": dt.datetime.now(dt.timezone.utc).isoformat(), "pdfPath": str(path)}
    store.reports[rid] = rep
    return ok(report_dto(rep))


@router.get("/reports")
def list_reports(policySlug: Optional[str] = None):
    reps = [r for r in store.reports.values() if not policySlug or r["policySlug"] == policySlug]
    return ok([report_dto(r) for r in sorted(reps, key=lambda r: r["createdAt"], reverse=True)])


@router.get("/reports/{rid}")
def get_report(rid: str):
    if rid not in store.reports:
        raise not_found("Report")
    return ok(report_dto(store.reports[rid]))


@router.get("/reports/{rid}/download")
def download_report(rid: str, inline: bool = False):
    rep = store.reports.get(rid)
    if not rep:
        raise not_found("Report")
    fname = f"edgecase-{rep['reportType'].lower().replace('_', '-')}-{rep['policySlug']}.pdf"
    return FileResponse(rep["pdfPath"], media_type="application/pdf", filename=fname,
                        content_disposition_type="inline" if inline else "attachment")
