"""EDGECASE simulation engine (NumPy, vectorised, seeded => fully reproducible)."""
from __future__ import annotations

import copy
import datetime as dt
import math
import uuid

import numpy as np

from .catalog import primary_rule
from .fmt import compact_inr, fmt_value, inr, pct, tidy

OPS = {"<=": np.less_equal, ">=": np.greater_equal, "<": np.less, ">": np.greater,
       "==": np.equal, "!=": np.not_equal}
HARD = ("ELIGIBILITY", "EXCLUSION")
MARGIN = 0.02            # "near a threshold" = within 2% of it
MAX_STORED_EDGE = 12000  # edge-case rows kept for browsing (counts are always exact)
SAMPLE_CASES = 600       # ordinary (non-edge) rows kept so the table can show all/eligible/rejected
REJECTED, ELIGIBLE, REVIEW = 0, 1, 2
RESULT_NAMES = {REJECTED: "REJECTED", ELIGIBLE: "ELIGIBLE", REVIEW: "REVIEW"}
EDGE_TYPES = {1: "POLICY_CLIFF", 2: "BOUNDARY_CASE", 3: "RULE_CONFLICT", 4: "EXCLUSION_RULE"}
EDGE_SEVERITY = {1: "HIGH", 2: "MEDIUM", 3: "HIGH", 4: "MEDIUM"}


# ───────────────────────── helpers ─────────────────────────
def is_num(rule: dict) -> bool:
    return isinstance(rule["value"], (int, float)) and not isinstance(rule["value"], bool)


def constraint_str(rule: dict) -> str:
    v = rule["value"]
    if isinstance(v, bool):
        v = "true" if v else "false"
    return f'{rule["var"]} {rule["op"]} {v}'


def vmap(policy: dict) -> dict[str, dict]:
    return {v["key"]: v for v in policy["variables"]}


def _decimals(step: float) -> int:
    s = f"{step:.6f}".rstrip("0")
    return len(s.split(".")[1]) if "." in s else 0


def _snap(value: float, var: dict):
    step = var.get("step", 1)
    return round(value / step) * step if step >= 1 else round(value, _decimals(step))


def _shape(x: np.ndarray, g: dict) -> np.ndarray:
    if "min" in g or "max" in g:
        x = np.clip(x, g.get("min", -np.inf), g.get("max", np.inf))
    if g.get("step", 0) >= 1:
        x = np.round(x / g["step"]) * g["step"]
    elif "decimals" in g:
        x = np.round(x, g["decimals"])
    return x


def _gen_column(g: dict, n: int, rng: np.random.Generator, cols: dict) -> np.ndarray:
    d = g.get("dist", "normal")
    if d == "lognormal":
        x = rng.lognormal(math.log(g["median"]), g["sigma"], n)
    elif d == "lognormal_corr":
        med = g["base"] * (np.maximum(cols[g["on"]], 1) / g["ref"]) ** g["exp"]
        x = med * rng.lognormal(0, g["sigma"], n)
    elif d == "normal":
        x = rng.normal(g.get("mean", 0), g.get("sd", 1), n)
    elif d == "int":
        w = np.array(g["weights"], float)
        return rng.choice(np.arange(g.get("low", 1), g.get("low", 1) + len(w)), n, p=w / w.sum()).astype(float)
    elif d == "bool":
        p = np.full(n, g.get("p", 0.5))
        c = g.get("cond")
        if c:
            p = np.where(OPS[c["op"]](cols[c["var"]], c["value"]), c["p_true"], c["p_false"])
        return rng.random(n) < p
    elif d == "choice":
        w = np.array(g["weights"], float)
        return rng.choice(np.array(g["options"], dtype=object), n, p=w / w.sum())
    else:
        raise ValueError(f"unknown distribution {d}")
    return _shape(x, g)


def canonical_case(policy: dict) -> dict:
    """One applicant that comfortably satisfies every enabled rule."""
    vm, out = vmap(policy), {}
    for r in policy["rules"]:
        if not r.get("enabled", True):
            continue
        v = vm[r["var"]]
        if is_num(r):
            out[r["var"]] = _snap(r["value"] * (0.6 if r["op"] in ("<=", "<") else 1.25), v)
        else:
            out[r["var"]] = (not r["value"]) if r["op"] == "!=" else r["value"]
    return out


def build_population(policy: dict, n: int, seed: int, mode: str) -> dict[str, np.ndarray]:
    rng = np.random.default_rng(seed)
    cols: dict[str, np.ndarray] = {}
    for v in policy["variables"]:
        cols[v["key"]] = _gen_column(v["gen"], n, rng, cols)
    vm = vmap(policy)
    nums = [r for r in policy["rules"] if r.get("enabled", True) and is_num(r)]

    if mode == "BOUNDARY_SCAN" and nums:          # crowd half the population around thresholds
        pick, sel = rng.integers(0, len(nums), n), rng.random(n) < 0.5
        for i, r in enumerate(nums):
            m = sel & (pick == i)
            g = dict(vm[r["var"]]["gen"])
            cols[r["var"]][m] = _shape(r["value"] * (1 + rng.uniform(-0.1, 0.1, int(m.sum()))), g)
    if mode == "FAIRNESS_AUDIT":                   # equal representation across bands
        f = policy["fairness"]
        top = [e for e in f["edges"] if math.isfinite(e)][-1]
        cols[f["variable"]] = _shape(rng.uniform(0, top * 1.4, n), vm[f["variable"]]["gen"])

    canon, row = canonical_case(policy), 0        # deterministic boundary probes (T-step, T, T+step)
    for r in nums:
        s = vm[r["var"]].get("step", 1)
        for delta in (-s, 0, s):
            for k, val in canon.items():
                cols[k][row] = val
            cols[r["var"]][row] = _snap(r["value"] + delta, vm[r["var"]])
            row += 1
    return cols


def evaluate(rules: list[dict], cols: dict, n: int) -> np.ndarray:
    P = np.ones((len(rules), n), bool)
    for i, r in enumerate(rules):
        if r.get("enabled", True):
            P[i] = OPS[r["op"]](cols[r["var"]], r["value"])
    return P


def classify(rules: list[dict], P: np.ndarray):
    n = P.shape[1]
    en = np.array([r.get("enabled", True) for r in rules])
    hard = np.array([r["type"] in HARD for r in rules]) & en
    soft = np.array([r["type"] == "CONDITIONAL" for r in rules]) & en
    fail = ~P & en[:, None]
    hard_fail = fail[hard].any(0) if hard.any() else np.zeros(n, bool)
    soft_fail = fail[soft].any(0) if soft.any() else np.zeros(n, bool)
    res = np.where(hard_fail, REJECTED, np.where(soft_fail, REVIEW, ELIGIBLE))
    return res, fail, hard


def _others_ok(fail: np.ndarray, skip: tuple[int, ...]) -> np.ndarray:
    keep = [i for i in range(fail.shape[0]) if i not in skip]
    return ~fail[keep].any(0) if keep else np.ones(fail.shape[1], bool)


def _severity(rate: float, hi: float = 3, mid: float = 1) -> str:
    return "HIGH" if rate >= hi else "MEDIUM" if rate >= mid else "LOW"


def _row(cols: dict, i: int) -> dict:
    out = {}
    for k, arr in cols.items():
        x = arr[i]
        out[k] = bool(x) if isinstance(x, (np.bool_, bool)) else str(x) if isinstance(x, str) else tidy(x)
    return out


def summary_text(policy: dict, attrs: dict) -> str:
    vm = vmap(policy)
    keys = policy.get("summary") or list(dict.fromkeys(r["var"] for r in policy["rules"]))[:3]
    return " · ".join(fmt_value(vm[k], attrs[k]) for k in keys if k in attrs)


def _reason(policy: dict, rules, attrs, res, fails, etype) -> str:
    vm = vmap(policy)
    if res == ELIGIBLE:
        return "Passes all rules by narrow margin."
    if res == REVIEW:
        r = rules[fails[0]]
        return f"{r['short']} not met while other criteria pass; referred for manual review."
    r = next((rules[j] for j in fails if rules[j]["type"] in HARD), rules[fails[0]])
    if is_num(r):
        gap = abs(attrs[r["var"]] - r["value"])
        unit = inr(gap) if vm[r["var"]].get("fmt") == "inr" else f"{tidy(gap)}"
        if r["op"] in ("<=", "<"):
            return f"{vm[r['var']]['name']} exceeds threshold by {unit}."
        return f"{vm[r['var']]['name']} is below the minimum by {unit}."
    return f"Fails rule: {r['description']}."


# ───────────────────────── main entry ─────────────────────────
def run_simulation(policy: dict, mode: str, n: int, seed: int, policy_slug: str) -> dict:
    t0 = dt.datetime.now(dt.timezone.utc)
    policy = copy.deepcopy(policy)
    rules = policy["rules"]
    vm = vmap(policy)
    cols = build_population(policy, n, seed, mode)
    P = evaluate(rules, cols, n)
    res, fail, hard = classify(rules, P)
    nfail = fail.sum(0)
    eligible, rejected, review = res == ELIGIBLE, res == REJECTED, res == REVIEW
    E, Rj, Rv = int(eligible.sum()), int(rejected.sum()), int(review.sum())

    # ── edge-case classification ──
    num_idx = [i for i, r in enumerate(rules) if r.get("enabled", True) and is_num(r)]
    near = np.zeros((len(rules), n), bool)
    for i in num_idx:
        r = rules[i]
        band = max(MARGIN * abs(r["value"]), vm[r["var"]].get("step", 1))
        near[i] = np.abs(cols[r["var"]] - r["value"]) <= band
    near_any = near.any(0)
    single = rejected & (nfail == 1)
    first_fail = np.argmax(fail, axis=0)
    first_hard = np.argmax(fail & hard[:, None], axis=0)
    numeric_flag = np.array([is_num(r) for r in rules])
    excl_flag = np.array([r["type"] == "EXCLUSION" for r in rules])
    etype = np.zeros(n, np.int8)
    etype[eligible & near_any] = 2
    etype[single & excl_flag[first_fail]] = 4
    etype[single & numeric_flag[first_fail] & near[first_fail, np.arange(n)]] = 1
    etype[review] = 3
    edge_mask = etype > 0
    edge_count = int(edge_mask.sum())

    # ── cliffs ──
    canon = canonical_case(policy)
    cliffs = []
    for i in num_idx:
        r, v = rules[i], vm[rules[i]["var"]]
        step, t = v.get("step", 1), r["value"]
        # "affected" = applicants rejected ONLY by this rule and within 10% of its threshold (near-miss exclusions)
        near10 = np.abs(cols[r["var"]] - t) <= 0.10 * abs(t)
        affected = int((fail[i] & _others_ok(fail, (i,)) & near10).sum())
        le = r["op"] in ("<=", "<")
        o1, o2 = (0.004 * t, 0.002 * t) if v.get("fmt") == "inr" else (2 * step, step)
        seq = [t - o1, t - o2, t, t + step] if le else [t + o1, t + o2, t, t - step]
        pts = []
        for val in seq:
            val = _snap(val, v)
            pts.append({"label": fmt_value(v, val), "value": tidy(val),
                        "outcome": "ELIGIBLE" if OPS[r["op"]](val, t) else "REJECTED"})
        rate = pct(affected, n)
        cliffs.append({
            "id": str(uuid.uuid4()), "ruleCode": r["code"], "variable": v["name"],
            "thresholdValue": fmt_value(v, t), "criticalChange": fmt_value(v, step) if v.get("fmt") == "inr" else str(tidy(step)),
            "beforeValue": pts[2]["label"], "afterValue": pts[3]["label"], "outcomeBefore": "ELIGIBLE", "outcomeAfter": "REJECTED",
            "affectedCases": affected, "affectedRate": rate, "severity": _severity(rate, 1.5, 0.5),
            "description": f"Eligibility changes at the exact {v['name'].lower()} boundary. Every other attribute remains constant.",
            "dataPoints": pts,
        })
    cliffs.sort(key=lambda c: (c["ruleCode"] != policy.get("primary"), -c["affectedCases"]))  # primary rule first

    # ── conflicts ──
    conflicts = []
    bool_idx = [i for i, r in enumerate(rules) if r.get("enabled", True) and not is_num(r)]
    for a in num_idx:
        for b in bool_idx:
            aff = int((P[a] & fail[b] & _others_ok(fail, (a, b))).sum())
            if pct(aff, n) < 0.5:
                continue
            ra, rb = rules[a], rules[b]
            conflicts.append(_conflict(ra, rb, aff, n, "CONTRADICTORY",
                                       f"{aff:,} synthetic cases satisfy “{ra['description']}” but fail “{rb['description']}”, producing contradictory eligibility signals."))
    for x, i in enumerate(num_idx):                # same-variable contradictions
        for j in num_idx[x + 1:]:
            ri, rj = rules[i], rules[j]
            if ri["var"] != rj["var"]:
                continue
            lo_r, hi_r = (ri, rj) if ri["op"] in (">=", ">") else (rj, ri)
            if lo_r["op"] in (">=", ">") and hi_r["op"] in ("<=", "<") and lo_r["value"] > hi_r["value"]:
                conflicts.append(_conflict(ri, rj, n, "MUTUALLY_EXCLUSIVE",
                                           "No applicant can satisfy both rules; the policy is unreachable."))
    conflicts.sort(key=lambda c: -c["affectedCases"])
    for k, c in enumerate(conflicts, 1):
        c["conflictCode"] = f"CONFLICT #{k:02d}"

    # ── rejection reasons ──
    reasons: dict[str, int] = {}
    for i, r in enumerate(rules):
        c = int((rejected & (first_hard == i) & fail[i]).sum())
        if c:
            reasons[r["short"]] = reasons.get(r["short"], 0) + c
    if Rv:
        reasons["Rule conflict / manual review"] = Rv
    ordered = sorted(reasons.items(), key=lambda kv: -kv[1])
    top, rest = ordered[:4], sum(c for _, c in ordered[4:])
    if rest:
        top.append(("Other", rest))
    denom = max(Rj + Rv, 1)
    rejection_reasons = [{"reason": k, "count": c, "percentage": round(100 * c / denom)} for k, c in top]

    # ── fairness ──
    fairness = _fairness(policy, cols, eligible, rejected | review, n, edge_count)

    # ── budget sensitivity + anomaly ──
    prim = primary_rule(policy)
    sensitivity, anomaly = "Medium", (None, None)
    if prim:
        bumped = copy.deepcopy(policy["rules"])
        for r in bumped:
            if r["code"] == prim["code"]:
                r["value"] = prim["value"] * 1.10
        E2 = int((classify(bumped, evaluate(bumped, cols, n))[0] == ELIGIBLE).sum())
        rel = abs(E2 - E) / max(E, 1) * 100
        sensitivity = "Low" if rel < 3 else "Medium" if rel < 8 else "High"
        pi = next(i for i, r in enumerate(rules) if r["code"] == prim["code"])
        pool = rejected & (first_hard == pi) & fail[pi]
        if pool.sum():
            close = np.abs(cols[prim["var"]][pool] - prim["value"]) <= 0.10 * abs(prim["value"])
            share = round(100 * close.sum() / pool.sum())
            v = vm[prim["var"]]
            gap = compact_inr(0.10 * prim["value"]) if v.get("fmt") == "inr" else f"{tidy(0.10 * prim['value'])}"
            lead = "Most" if share >= 50 else f"{share}% of"
            anomaly = (f"{lead} {prim_short(prim).lower()} rejections happen within {gap} of the threshold.",
                       f"This clustering suggests the policy is sensitive to small changes in declared {v['name'].lower()}.")

    # ── stored case rows ──
    idx = np.nonzero(edge_mask)[0]
    sev_rank = {"HIGH": 0, "MEDIUM": 1, "LOW": 2}
    edge_rows = []
    for k, i in enumerate(idx, 1):
        if k > MAX_STORED_EDGE:
            break
        et = int(etype[i]); attrs = _row(cols, i)
        fl = [j for j in range(len(rules)) if fail[j, i]]
        rrule = rules[fl[0]] if fl else None
        edge_rows.append({
            "id": str(uuid.uuid4()), "caseIdentifier": f"EDGE-{k:05d}", "type": EDGE_TYPES[et],
            "severity": EDGE_SEVERITY[et], "attributes": attrs, "attributeSummary": summary_text(policy, attrs),
            "result": RESULT_NAMES[int(res[i])], "reason": _reason(policy, rules, attrs, int(res[i]), fl, et),
            "triggeredRules": [rules[j]["code"] for j in np.nonzero(near[:, i])[0]],
            "violatedRules": [rules[j]["code"] for j in fl],
            "explanation": _explain_case(policy, rules, attrs, int(res[i]), fl, et, rrule),
            "isEdgeCase": True, "synthetic": True,
        })
    edge_rows.sort(key=lambda c: (sev_rank[c["severity"]], c["caseIdentifier"]))
    rng = np.random.default_rng(seed + 1)
    normal_idx = np.nonzero(~edge_mask)[0]
    sample = rng.choice(normal_idx, size=min(SAMPLE_CASES, len(normal_idx)), replace=False) if len(normal_idx) else []
    sample_rows = []
    for k, i in enumerate(sorted(sample), 1):
        attrs = _row(cols, i); fl = [j for j in range(len(rules)) if fail[j, i]]
        sample_rows.append({
            "id": str(uuid.uuid4()), "caseIdentifier": f"CASE-{int(i) + 1:06d}", "type": "STANDARD", "severity": "LOW",
            "attributes": attrs, "attributeSummary": summary_text(policy, attrs), "result": RESULT_NAMES[int(res[i])],
            "reason": _reason(policy, rules, attrs, int(res[i]), fl, 0) if res[i] != ELIGIBLE else "Passes all rules.",
            "triggeredRules": [], "violatedRules": [rules[j]["code"] for j in fl],
            "explanation": None, "isEdgeCase": False, "synthetic": True,
        })

    results = {
        "totalTested": n,
        "eligibleCount": E, "eligibleRate": pct(E, n), "rejectedCount": Rj, "rejectedRate": pct(Rj, n),
        "needsReviewCount": Rv, "needsReviewRate": pct(Rv, n),
        "edgeCaseCount": edge_count, "edgeCaseRate": pct(edge_count, n),
        "cliffCount": len(cliffs), "cliffHighCount": sum(c["severity"] == "HIGH" for c in cliffs),
        "conflictCount": len(conflicts), "conflictUnresolved": sum(c["status"] == "NEEDS_REVIEW" for c in conflicts),
        "ruleConsistencyRate": round(100 - pct(Rv, n), 1),
        "fairnessScore": fairness["score"], "budgetSensitivity": sensitivity,
        "rejectionReasons": rejection_reasons, "fairnessBands": fairness["bands"],
        "fairnessHeatmap": fairness["heatmap"],
        "anomalyHeadline": anomaly[0], "anomalyDescription": anomaly[1],
    }
    now = dt.datetime.now(dt.timezone.utc)
    return {
        "id": str(uuid.uuid4()), "policySlug": policy_slug, "policyVersionId": policy.get("versionId"),
        "status": "COMPLETED", "mode": mode, "populationSize": n, "seed": seed,
        "startedAt": t0.isoformat(), "completedAt": now.isoformat(), "createdAt": t0.isoformat(),
        "durationMs": int((now - t0).total_seconds() * 1000),
        "results": results, "cliffs": cliffs, "conflicts": conflicts, "fairness": fairness,
        "edgeCases": edge_rows, "sampleCases": sample_rows, "whatIfRuns": [],
        "policySnapshot": policy,
    }


def prim_short(rule: dict) -> str:
    return rule.get("short", rule["var"])


def _conflict(ra, rb, affected, n, ctype, desc) -> dict:
    rate = pct(affected, n)
    return {
        "id": str(uuid.uuid4()), "conflictCode": "", "title": f"{ra['short']} & {rb['short'].lower()} contradiction",
        "ruleACode": ra["code"], "ruleADescription": ra["description"],
        "ruleBCode": rb["code"], "ruleBDescription": rb["description"],
        "conflictType": ctype, "description": desc, "affectedCases": affected,
        "severity": _severity(rate), "status": "NEEDS_REVIEW",
    }


def _explain_case(policy, rules, attrs, res, fails, etype, rrule) -> str:
    kind = {1: "sits just past a hard eligibility cliff", 2: "passes only by a narrow margin",
            3: "is caught between conflicting rules", 4: "is excluded by a single exclusion rule"}[etype]
    tail = f" It fails {rrule['code']} ({rrule['description']})." if rrule else ""
    return f"This synthetic applicant {kind}.{tail} Small changes in declared values could flip the outcome."


def _fairness(policy, cols, eligible, not_elig, n, edge_count) -> dict:
    f = policy["fairness"]
    var = f["variable"]
    x = cols[var].astype(float)
    edges = np.array(f["edges"], float)
    band = np.clip(np.digitize(x, edges[1:-1]), 0, len(f["labels"]) - 1)
    bands, rates = [], []
    for b, label in enumerate(f["labels"]):
        m = band == b
        cnt = int(m.sum())
        rate = pct(int((eligible & m).sum()), cnt, 0) if cnt else 0
        bands.append({"band": label, "height": int(rate), "count": cnt})
        rates.append(rate)
    top = [e for e in f["edges"] if math.isfinite(e)][-1]
    below = [r for r, lo in zip(rates, f["edges"][:-1]) if lo < top and r > 0]
    cv = (np.std(below) / np.mean(below)) if below and np.mean(below) else 0
    score = int(max(0, min(100, round(100 - 100 * cv - 0.5 * pct(edge_count, n)))))
    # heatmap: 5 secondary-variable quantile rows × 7 primary-variable columns → exclusion level 0-4
    sec = cols[f.get("secondary", var)].astype(float)
    cols7 = np.clip(np.digitize(x, np.linspace(0, top * 1.4, 8)[1:-1]), 0, 6)
    rows5 = np.clip(np.digitize(sec, np.quantile(sec, [.2, .4, .6, .8])), 0, 4)
    grid = np.zeros((5, 7))
    for r in range(5):
        for c in range(7):
            m = (rows5 == r) & (cols7 == c)
            grid[r, c] = (not_elig & m).sum() / m.sum() if m.sum() >= 20 else 0
    cuts = np.quantile(grid[grid > 0], [.2, .4, .6, .8]) if (grid > 0).any() else [0, 0, 0, 0]
    heat = [int(np.digitize(v, cuts)) for v in grid.flatten()]
    lead = "Coverage is fairly even across the income bands below the threshold." if score >= 85 else "Coverage is uneven across bands."
    return {"variable": var, "bands": bands, "heatmap": heat, "score": score,
            "note": lead + " This is a simulation signal for policy review, not a demographic claim."}


# ───────────────────────── what-if ─────────────────────────
_pop_cache: dict[str, tuple] = {}


def what_if(sim: dict, rule_code: str | None, new_value: float, budget: dict) -> dict:
    policy = sim["policySnapshot"]
    n = sim["populationSize"]
    key = sim["id"]
    if key not in _pop_cache:
        if len(_pop_cache) > 6:
            _pop_cache.clear()
        _pop_cache[key] = build_population(policy, n, sim["seed"], sim["mode"])
    cols = _pop_cache[key]
    rules = policy["rules"]
    target = next((r for r in rules if r["code"] == rule_code), None) or primary_rule(policy)
    if target is None or not is_num(target):
        raise ValueError("This policy has no numeric rule to adjust.")
    changed = copy.deepcopy(rules)
    for r in changed:
        if r["code"] == target["code"]:
            r["value"] = new_value
    base = classify(rules, evaluate(rules, cols, n))[0]
    alt = classify(changed, evaluate(changed, cols, n))[0]
    b = {k: int((base == c).sum()) for k, c in (("eligible", ELIGIBLE), ("rejected", REJECTED), ("review", REVIEW))}
    a = {k: int((alt == c).sum()) for k, c in (("eligible", ELIGIBLE), ("rejected", REJECTED), ("review", REVIEW))}
    cost = budget["costPerEligibleCase"] * budget.get("unitMultiplier", 1)
    delta_budget = (a["eligible"] - b["eligible"]) * cost
    v = vmap(policy)[target["var"]]
    return {
        "simulationId": sim["id"], "parameter": target["code"], "parameterLabel": v["name"],
        "variable": target["var"], "oldValue": target["value"], "newValue": new_value, "seed": sim["seed"],
        "baseline": {"eligible": b["eligible"], "rejected": b["rejected"], "review": b["review"]},
        "changed": {"eligible": a["eligible"], "rejected": a["rejected"], "review": a["review"]},
        "eligibleDelta": a["eligible"] - b["eligible"], "rejectedDelta": a["rejected"] - b["rejected"],
        "reviewDelta": a["review"] - b["review"], "affectedCases": int((base != alt).sum()),
        "budgetBefore": b["eligible"] * cost, "budgetAfter": a["eligible"] * cost, "budgetDelta": delta_budget,
        "budgetFormatted": ("+" if delta_budget >= 0 else "-") + compact_inr(abs(delta_budget)),
        "oldFormatted": fmt_value(v, target["value"]), "newFormatted": fmt_value(v, new_value),
        "methodology": "Same seeded synthetic population re-evaluated with the modified rule; budget = eligible cases × illustrative unit cost.",
    }
