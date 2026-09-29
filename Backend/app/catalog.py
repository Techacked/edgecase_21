"""Built-in demo policies. Everything the engine needs lives in these dicts:
variables (+ how to synthesise them), rules, fairness bands and budget assumptions.
Custom policies extracted from text/PDF use the same shape (see extractor.py)."""
from __future__ import annotations

import copy
import datetime as dt

from .fmt import compact_inr, inr

INF = float("inf")


def V(key, name, typ, unit="", fmt=None, step=1, gen=None):
    return {"key": key, "name": name, "type": typ, "unit": unit, "fmt": fmt, "step": step, "gen": gen or {}}


def R(code, description, short, typ, var, op, value, confidence, verified=True):
    return {
        "code": code, "description": description, "short": short, "type": typ,
        "var": var, "op": op, "value": value, "confidence": confidence,
        "verificationStatus": "VERIFIED" if verified else "NEEDS_REVIEW",
        "enabled": True, "sourceText": description,
    }


def cond(var, op, value, p_true, p_false):
    return {"var": var, "op": op, "value": value, "p_true": p_true, "p_false": p_false}


_SCHOLARSHIP = {
    "slug": "scholarship-eligibility",
    "name": "Scholarship Eligibility",
    "description": "Merit-cum-means scholarship for students from lower-income families.",
    "department": "Higher Education", "category": "Education",
    "authority": "Government of NCT of Delhi · Draft guidelines",
    "variables": [
        V("income_annual", "Annual Family Income", "NUMBER", "₹", "inr", 1,
          {"dist": "lognormal", "median": 320000, "sigma": 0.6, "min": 0, "max": 2500000, "step": 100}),
        V("cgpa", "CGPA", "NUMBER", "", "CGPA {}", 0.1,
          {"dist": "normal", "mean": 7.9, "sd": 0.95, "min": 4.0, "max": 10.0, "decimals": 1}),
        V("family_size", "Family Size", "NUMBER", "", "Family {}", 1,
          {"dist": "int", "low": 1, "weights": [3, 10, 20, 28, 20, 10, 6, 3]}),
        V("financial_need", "Financial Need", "BOOLEAN", "", ["Needs support", "No stated need"], 1,
          {"dist": "bool", "p": 0.2, "cond": cond("income_annual", "<=", 600000, 0.96, 0.2)}),
        V("category", "Category", "STRING", gen={"dist": "choice", "options": ["General", "OBC", "SC", "ST", "EWS"],
                                                 "weights": [.35, .30, .15, .05, .15]}),
        V("location", "Location", "STRING", gen={"dist": "choice", "options": ["Urban", "Semi-urban", "Rural"],
                                                 "weights": [.60, .25, .15]}),
    ],
    "rules": [
        R("R01", "Family income must be ≤ ₹5,00,000", "Income threshold", "ELIGIBILITY", "income_annual", "<=", 500000, 98.0),
        R("R02", "CGPA must be ≥ 7.0", "Academic performance", "ELIGIBILITY", "cgpa", ">=", 7.0, 97.0),
        R("R03", "Applicant must demonstrate financial need", "Financial need", "CONDITIONAL", "financial_need", "==", True, 93.0, False),
    ],
    "primary": "R01",
    "summary": ["income_annual", "cgpa", "family_size"],
    "fairness": {"variable": "income_annual", "edges": [0, 100000, 200000, 300000, 400000, 500000, INF],
                 "labels": ["0–1L", "1–2L", "2–3L", "3–4L", "4–5L", "5L+"], "secondary": "cgpa"},
    "budget": {"costPerEligibleCase": 4400, "currency": "INR", "unitMultiplier": 1,
               "assumptionDescription": "Illustrative annual benefit per eligible synthetic case (₹4,400). Edit to model real budgets."},
}

_RATION = {
    "slug": "delhi-ration-food-security",
    "name": "Delhi Ration / Food Security",
    "description": "Subsidised food-grain entitlement for low-income Delhi households.",
    "department": "Food & Supplies", "category": "Food Security",
    "authority": "Government of NCT of Delhi · Draft guidelines",
    "variables": [
        V("income_annual", "Annual Family Income", "NUMBER", "₹", "inr", 1,
          {"dist": "lognormal", "median": 120000, "sigma": 0.75, "min": 0, "max": 2000000, "step": 100}),
        V("owns_four_wheeler", "Vehicle Ownership", "BOOLEAN", "", ["Owns car", "No car"], 1,
          {"dist": "bool", "p": 0.05, "cond": cond("income_annual", ">", 300000, 0.35, 0.04)}),
        V("govt_employee", "Government Employment", "BOOLEAN", "", ["Govt employee", "Non-govt"], 1,
          {"dist": "bool", "p": 0.07, "cond": cond("income_annual", "<=", 100000, 0.02, 0.10)}),
        V("income_tax_payer", "Income Tax Status", "BOOLEAN", "", ["Taxpayer", "Non-taxpayer"], 1,
          {"dist": "bool", "p": 0.05, "cond": cond("income_annual", ">", 300000, 0.25, 0.01)}),
        V("electricity_load_kw", "Electricity Load", "NUMBER", "kW", "{} kW", 0.1,
          {"dist": "normal", "mean": 2.5, "sd": 1.2, "min": 0.5, "max": 12, "decimals": 1}),
        V("owns_property", "Property Status", "BOOLEAN", "", ["Owns property", "No property"], 1,
          {"dist": "bool", "p": 0.3}),
    ],
    "rules": [
        R("R01", "Annual household income must be ≤ ₹1,00,000", "Income threshold", "ELIGIBILITY", "income_annual", "<=", 100000, 98.0),
        R("R02", "No four-wheeler ownership", "Vehicle ownership", "EXCLUSION", "owns_four_wheeler", "==", False, 96.0),
        R("R03", "No government employment", "Government employment", "EXCLUSION", "govt_employee", "==", False, 95.0, False),
    ],
    "primary": "R01",
    "summary": ["income_annual", "owns_four_wheeler", "govt_employee"],
    "fairness": {"variable": "income_annual", "edges": [0, 25000, 50000, 75000, 100000, 150000, INF],
                 "labels": ["0–25K", "25–50K", "50–75K", "75K–1L", "1–1.5L", "1.5L+"], "secondary": "electricity_load_kw"},
    "budget": {"costPerEligibleCase": 3600, "currency": "INR", "unitMultiplier": 1,
               "assumptionDescription": "Illustrative annual subsidy per eligible synthetic household (₹3,600)."},
}

_LAKSHMI = {
    "slug": "delhi-lakshmi-yojana",
    "name": "Delhi Lakshmi Yojana",
    "description": "Direct cash assistance for women in low-income Delhi households.",
    "department": "Women & Child Development", "category": "Social Welfare",
    "authority": "Government of NCT of Delhi · Draft guidelines",
    "variables": [
        V("age", "Age", "NUMBER", "years", "Age {}", 1,
          {"dist": "normal", "mean": 38, "sd": 12, "min": 18, "max": 80, "decimals": 0}),
        V("income_annual", "Family Income", "NUMBER", "₹", "inr", 1,
          {"dist": "lognormal", "median": 220000, "sigma": 0.7, "min": 0, "max": 2500000, "step": 100}),
        V("delhi_resident", "Delhi Residency", "BOOLEAN", "", ["Delhi resident", "Non-resident"], 1,
          {"dist": "bool", "p": 0.9}),
        V("voter_registered", "Voter Status", "BOOLEAN", "", ["Registered voter", "Not registered"], 1,
          {"dist": "bool", "p": 0.85, "cond": cond("delhi_resident", "==", True, 0.92, 0.3)}),
        V("electricity_units", "Electricity Consumption", "NUMBER", "units/yr", "{:,} units", 1,
          {"dist": "lognormal_corr", "on": "income_annual", "base": 1800, "ref": 220000, "exp": 0.55,
           "sigma": 0.35, "min": 100, "max": 12000, "step": 10}),
        V("govt_employee", "Government Employment", "BOOLEAN", "", ["Govt employee", "Non-govt"], 1,
          {"dist": "bool", "p": 0.05}),
    ],
    "rules": [
        R("R01", "Family income must be ≤ ₹2,50,000", "Income threshold", "ELIGIBILITY", "income_annual", "<=", 250000, 98.0),
        R("R02", "Annual electricity consumption must be ≤ 2,400 units", "Electricity consumption", "ELIGIBILITY", "electricity_units", "<=", 2400, 96.0),
        R("R03", "Applicant must be a Delhi resident", "Delhi residency", "ELIGIBILITY", "delhi_resident", "==", True, 97.0, False),
    ],
    "primary": "R01",
    "summary": ["income_annual", "electricity_units", "delhi_resident"],
    "fairness": {"variable": "income_annual", "edges": [0, 50000, 100000, 150000, 200000, 250000, INF],
                 "labels": ["0–50K", "50K–1L", "1–1.5L", "1.5–2L", "2–2.5L", "2.5L+"], "secondary": "age"},
    "budget": {"costPerEligibleCase": 12000, "currency": "INR", "unitMultiplier": 1,
               "assumptionDescription": "Illustrative annual transfer per eligible synthetic applicant (₹12,000)."},
}


def _finish(p: dict) -> dict:
    p["versionNumber"] = 1
    p["versionId"] = f"{p['slug']}-v1"
    p["sourceType"] = "DEMO"
    p["ocrConfidence"] = 99.1
    p["createdAt"] = dt.datetime.now(dt.timezone.utc).isoformat()
    intro = ("Applicants seeking assistance under this scheme must satisfy the following conditions. "
             "The benefit shall be made available to eligible families meeting the specified criteria.")
    body = "\n".join(f"{i + 1}. {r['description']}. The applicant shall provide valid documentation at the time of submission."
                     for i, r in enumerate(p["rules"]))
    outro = "Applications will be reviewed against the criteria above. Incomplete or contradictory applications may be referred for manual review."
    p["documentText"] = f"{p['name']}\n{p['authority']}\n\n{intro}\n{body}\n{outro}"
    return p


CATALOG: dict[str, dict] = {p["slug"]: _finish(p) for p in (_SCHOLARSHIP, _RATION, _LAKSHMI)}
DEFAULT_SLUG = "delhi-ration-food-security"


def fresh_catalog() -> dict[str, dict]:
    return copy.deepcopy(CATALOG)


def primary_rule(policy: dict) -> dict | None:
    for r in policy["rules"]:
        if r["code"] == policy.get("primary") and isinstance(r["value"], (int, float)) and not isinstance(r["value"], bool):
            return r
    for r in policy["rules"]:
        if isinstance(r["value"], (int, float)) and not isinstance(r["value"], bool):
            return r
    return None


__all__ = ["CATALOG", "DEFAULT_SLUG", "fresh_catalog", "primary_rule", "compact_inr", "inr"]
