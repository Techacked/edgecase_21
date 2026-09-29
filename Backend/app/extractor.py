"""Turns policy language into executable rules.

The deterministic parser below works offline (no API key). When an AI provider is
configured, ai.extract_rules_ai() is tried first and this parser is the fallback."""
from __future__ import annotations

import datetime as dt
import re
import uuid

from .catalog import INF, R, V, cond
from .fmt import compact_inr

# key, display name, type, unit, fmt, step, keyword regex
KNOWN = [
    ("cgpa", "CGPA", "NUMBER", "", "CGPA {}", 0.1, r"\bcgpa\b|\bgpa\b|grade point"),
    ("electricity_units", "Electricity Consumption", "NUMBER", "units/yr", "{:,} units", 1, r"electricity|power consumption"),
    ("family_size", "Family Size", "NUMBER", "", "Family {}", 1, r"family size|household size|number of (family )?members"),
    ("age", "Age", "NUMBER", "years", "Age {}", 1, r"\bage\b|years old|years of age"),
    ("income_annual", "Annual Family Income", "NUMBER", "₹", "inr", 1, r"income|earning"),
    ("delhi_resident", "Delhi Residency", "BOOLEAN", "", ["Delhi resident", "Non-resident"], 1, r"resident|reside|domicile"),
    ("owns_four_wheeler", "Vehicle Ownership", "BOOLEAN", "", ["Owns car", "No car"], 1, r"four[- ]?wheeler|\bcar\b|vehicle"),
    ("govt_employee", "Government Employment", "BOOLEAN", "", ["Govt employee", "Non-govt"], 1, r"government (employ|servant|job)|govt\.? employ"),
    ("income_tax_payer", "Income Tax Status", "BOOLEAN", "", ["Taxpayer", "Non-taxpayer"], 1, r"income[- ]tax|taxpayer"),
    ("financial_need", "Financial Need", "BOOLEAN", "", ["Needs support", "No stated need"], 1, r"financial need|economically weak|need[- ]based|demonstrate need"),
    ("owns_property", "Property Status", "BOOLEAN", "", ["Owns property", "No property"], 1, r"propert"),
    ("voter_registered", "Voter Status", "BOOLEAN", "", ["Registered voter", "Not registered"], 1, r"voter"),
]
SHORT = {"cgpa": "Academic performance", "electricity_units": "Electricity consumption", "family_size": "Family size",
         "age": "Age criterion", "income_annual": "Income threshold", "delhi_resident": "Delhi residency",
         "owns_four_wheeler": "Vehicle ownership", "govt_employee": "Government employment",
         "income_tax_payer": "Income tax status", "financial_need": "Financial need",
         "owns_property": "Property status", "voter_registered": "Voter status"}
RULE_TYPE = {"owns_four_wheeler": "EXCLUSION", "govt_employee": "EXCLUSION", "income_tax_payer": "EXCLUSION",
             "owns_property": "EXCLUSION", "financial_need": "CONDITIONAL"}

GE_STRONG = r"≥|>=|not less than|no less than|at least|minimum|not below|not under"
LE = r"≤|<=|not exceed|not more than|no more than|not greater than|at most|up to|less than|below|under|maximum|within"
GE_WEAK = r"above|greater than|more than|over|exceeds?"
AMOUNT = re.compile(r"(?:₹|rs\.?|inr)?\s*(\d[\d,]*(?:\.\d+)?)\s*(lakhs?|lacs?|crores?|cr\b|thousand|k\b)?", re.I)
MULT = {"lakh": 1e5, "lakhs": 1e5, "lac": 1e5, "lacs": 1e5, "crore": 1e7, "crores": 1e7, "cr": 1e7, "thousand": 1e3, "k": 1e3}
NEG = re.compile(r"\b(no|not|without|neither|nor|never|cannot|shall not|must not|should not)\b", re.I)


def parse_amount(text: str) -> float | None:
    m = AMOUNT.search(text)
    if not m:
        return None
    val = float(m.group(1).replace(",", ""))
    return val * MULT.get((m.group(2) or "").lower(), 1)


def _norm(key: str, value):
    """450000.0 -> 450000, but keep 7.0 for decimal variables such as CGPA."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return value
    meta = _meta(key)
    if meta and meta[5] < 1:
        return float(value)
    return int(value) if float(value).is_integer() else float(value)


def _meta(key: str):
    return next((k for k in KNOWN if k[0] == key), None)


def _split(text: str) -> list[str]:
    text = re.sub(r"\b(Rs|Inr)\.", r"\1", text, flags=re.I)
    parts = re.split(r"[\n;]|(?<=[a-z0-9\)])\.\s+(?=[A-Z0-9])", text)
    return [re.sub(r"^\s*(\d+[.)]|[-•*])\s*", "", p).strip() for p in parts if len(p.strip()) > 8]


def _parse_sentence(s: str) -> list[dict]:
    low = s.lower()
    for key, name, typ, unit, fmt, step, pat in KNOWN:
        if not re.search(pat, low):
            continue
        if typ == "NUMBER":
            btw = re.search(r"between\s+(.+?)\s+and\s+(.+)", s, re.I)
            if btw:
                lo, hi = parse_amount(btw.group(1)), parse_amount(btw.group(2))
                if lo is not None and hi is not None:
                    return [_rule(key, ">=", lo, s, 96), _rule(key, "<=", hi, s, 96)]
            for pat_op, op in ((GE_STRONG, ">="), (LE, "<="), (GE_WEAK, ">=")):
                m = re.search(pat_op, low)
                if m:
                    amt = parse_amount(s[m.end():])
                    if amt is not None:
                        return [_rule(key, op, amt, s, 97)]
            continue
        value = not NEG.search(low)
        return [_rule(key, "==", value, s, 94 if NEG.search(low) else 95)]
    return []


def _rule(var: str, op: str, value, source: str, conf: float) -> dict:
    return {"var": var, "op": op, "value": value, "sourceText": source, "confidence": conf}


def deterministic_extract(text: str) -> list[dict]:
    seen, out = set(), []
    for sentence in _split(text):
        for r in _parse_sentence(sentence):
            if (r["var"], r["op"]) not in seen:
                seen.add((r["var"], r["op"]))
                out.append(r)
    return out


def _describe(r: dict, meta) -> str:
    name = meta[1] if meta else r["var"]
    if isinstance(r["value"], bool):
        return f"{name}: {'required' if r['value'] else 'not permitted'}"
    val = r["value"]
    txt = f"₹{int(val):,}" if meta and meta[4] == "inr" else f"{val:g}"
    word = {"<=": "must be ≤", "<": "must be <", ">=": "must be ≥", ">": "must be >"}.get(r["op"], "must be")
    return f"{name} {word} {txt}"


def build_custom_policy(title: str, text: str, raw_rules: list[dict], source_type: str,
                        ocr: float | None, deterministic: bool) -> dict:
    slug = f"custom-{uuid.uuid4().hex[:8]}"
    rules, variables, seen = [], [], set()
    for i, r in enumerate(raw_rules, 1):
        meta = _meta(r["var"])
        key = r["var"]
        r["value"] = _norm(key, r["value"])
        if key not in seen:
            seen.add(key)
            variables.append(_variable(key, r, meta))
        typ = RULE_TYPE.get(key, "ELIGIBILITY")
        rule = R(f"R{i:02d}", r.get("description") or _describe(r, meta), SHORT.get(key, (meta[1] if meta else key)),
                 typ, key, r["op"], r["value"], r["confidence"], r["confidence"] >= 96)
        rule["sourceText"] = r.get("sourceText")
        rules.append(rule)
    nums = [r for r in rules if isinstance(r["value"], (int, float)) and not isinstance(r["value"], bool)]
    if nums:
        p = next((r for r in nums if r["var"] == "income_annual"), nums[0])
        t = p["value"]
        fmt_edge = (lambda v: compact_inr(v).replace(" L", "L")) if _meta(p["var"]) and _meta(p["var"])[4] == "inr" else (lambda v: f"{v:g}")
        edges = [0, 0.2 * t, 0.4 * t, 0.6 * t, 0.8 * t, t, INF]
        labels = [f"{fmt_edge(edges[i])}–{fmt_edge(edges[i + 1])}" for i in range(5)] + [f"{fmt_edge(t)}+"]
        others = [v["key"] for v in variables if v["key"] != p["var"] and v["type"] == "NUMBER"]
        fairness = {"variable": p["var"], "edges": edges, "labels": labels, "secondary": others[0] if others else p["var"]}
        primary = p["code"]
    else:
        v0 = rules[0]["var"]
        fairness = {"variable": v0, "edges": [0, 0.5, INF], "labels": ["No", "Yes"], "secondary": v0}
        primary = rules[0]["code"]
    now = dt.datetime.now(dt.timezone.utc).isoformat()
    return {
        "slug": slug, "name": title, "description": "Custom policy extracted from user-supplied text.",
        "department": None, "category": "Custom", "authority": "User-supplied policy document",
        "variables": variables, "rules": rules, "primary": primary,
        "summary": list(dict.fromkeys(r["var"] for r in rules))[:3], "fairness": fairness,
        "budget": {"costPerEligibleCase": 5000, "currency": "INR", "unitMultiplier": 1,
                   "assumptionDescription": "Default illustrative unit cost (₹5,000). Edit to model real budgets."},
        "versionNumber": 1, "versionId": f"{slug}-v1", "sourceType": source_type, "ocrConfidence": ocr,
        "documentText": text, "createdAt": now, "isDeterministicDemo": deterministic,
    }


def _variable(key: str, r: dict, meta) -> dict:
    if isinstance(r["value"], bool):
        p_true = 0.6 if r["value"] else 0.4
        fmt = meta[4] if meta else ["Yes", "No"]
        return V(key, meta[1] if meta else key.replace("_", " ").title(), "BOOLEAN", "", fmt, 1,
                 {"dist": "bool", "p": p_true})
    t = float(r["value"])
    step = meta[5] if meta else 1
    gen = {"dist": "normal", "mean": t, "sd": 0.35 * abs(t or 1), "min": 0, "max": 3 * abs(t or 1)}
    if step < 1:
        gen["decimals"] = 1
    elif t >= 1000:
        gen["step"] = 100
    else:
        gen["decimals"] = 0
    return V(key, meta[1] if meta else key.replace("_", " ").title(), "NUMBER", meta[3] if meta else "",
             meta[4] if meta else None, step, gen)
