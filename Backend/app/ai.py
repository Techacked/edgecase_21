"""Optional LLM layer. Everything degrades to deterministic offline answers, so the
backend works with zero API keys (AI_PROVIDER=mock)."""
from __future__ import annotations

import json
import logging
import re

import httpx

from .config import settings

log = logging.getLogger("edgecase.ai")
SYSTEM = ("You are EDGECASE, a policy crash-testing assistant. All data is synthetic demo data and must not be "
          "used for real-world decisions. Answer briefly, in plain language, using only the numbers provided.")


def provider() -> str:
    if settings.demo_mode:
        return "mock"
    if settings.ai_provider == "anthropic" and settings.anthropic_key:
        return "anthropic"
    if settings.ai_provider == "gemini" and settings.gemini_key:
        return "gemini"
    return "mock"


def complete(system: str, user: str, max_tokens: int = 700) -> str | None:
    p = provider()
    try:
        if p == "anthropic":
            r = httpx.post(
                "https://api.anthropic.com/v1/messages", timeout=45,
                headers={"x-api-key": settings.anthropic_key, "anthropic-version": "2023-06-01",
                         "content-type": "application/json"},
                json={"model": settings.anthropic_model, "max_tokens": max_tokens, "system": system,
                      "messages": [{"role": "user", "content": user}]})
            r.raise_for_status()
            return "".join(b.get("text", "") for b in r.json()["content"] if b.get("type") == "text").strip() or None
        if p == "gemini":
            r = httpx.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/{settings.gemini_model}:generateContent",
                params={"key": settings.gemini_key}, timeout=45,
                json={"systemInstruction": {"parts": [{"text": system}]},
                      "contents": [{"role": "user", "parts": [{"text": user}]}],
                      "generationConfig": {"maxOutputTokens": max_tokens}})
            r.raise_for_status()
            return r.json()["candidates"][0]["content"]["parts"][0]["text"].strip() or None
    except Exception as exc:  # network/key/quota problems must never break the API
        log.warning("AI provider %s failed (%s); using offline fallback", p, exc)
    return None


def extract_rules_ai(text: str) -> list[dict] | None:
    """Ask the model for rules as JSON; returns None on any problem (caller falls back)."""
    if provider() == "mock":
        return None
    prompt = ("Extract the eligibility rules from this policy as a JSON array. Each item: "
              '{"variable": snake_case_key, "operator": one of <=,>=,<,>,==,!=, "value": number or true/false, '
              '"description": short rule text, "confidence": 0-100}. Return ONLY the JSON.\n\n' + text[:12000])
    out = complete("You convert policy text into formal constraints.", prompt, 1500)
    if not out:
        return None
    try:
        items = json.loads(re.search(r"\[.*\]", out, re.S).group(0))
        rules = []
        for it in items:
            if it["operator"] not in {"<=", ">=", "<", ">", "==", "!="}:
                continue
            v = it["value"]
            if not isinstance(v, (bool, int, float)):
                continue
            rules.append({"var": re.sub(r"\W+", "_", str(it["variable"]).lower()).strip("_"), "op": it["operator"],
                          "value": v, "description": it.get("description"),
                          "confidence": float(it.get("confidence", 90)), "sourceText": it.get("description")})
        return rules or None
    except Exception:
        return None


def explain_whatif(w: dict, policy_name: str) -> str:
    text = None
    if provider() != "mock":
        text = complete(SYSTEM, f"Policy: {policy_name}. Explain this what-if result in 2-3 sentences:\n{json.dumps(w)}", 300)
    if text:
        return text
    d = w["eligibleDelta"]
    if d == 0:
        return (f"Changing {w['parameterLabel'].lower()} from {w['oldFormatted']} to {w['newFormatted']} does not "
                "change any synthetic outcomes, so the current rule set is not sensitive to this parameter in that range.")
    verb, prep = ("brings", "into") if d > 0 else ("pushes", "out of")
    return (f"Moving {w['parameterLabel'].lower()} from {w['oldFormatted']} to {w['newFormatted']} {verb} {abs(d):,} "
            f"synthetic cases {prep} scope ({w['changed']['eligible']:,} eligible vs {w['baseline']['eligible']:,} before). "
            f"The largest movement is among applicants whose {w['parameterLabel'].lower()} sits between the two values. "
            f"Estimated simulated budget impact: {w['budgetFormatted']}.")


def chat_reply(message: str, ctx: dict) -> str:
    if provider() != "mock":
        out = complete(SYSTEM, f"Context (synthetic simulation summary): {json.dumps(ctx)[:6000]}\n\nQuestion: {message}", 500)
        if out:
            return out
    m = message.lower()
    r, name = ctx["results"], ctx["policyName"]
    cliff = (ctx.get("cliffs") or [None])[0]
    conflict = (ctx.get("conflicts") or [None])[0]
    if any(k in m for k in ("cliff", "boundary", "threshold")) and cliff:
        return (f"The sharpest cliff in {name} is on {cliff['variable'].lower()}: eligibility flips at {cliff['thresholdValue']} "
                f"(a change of just {cliff['criticalChange']}). About {cliff['affectedCases']:,} otherwise-eligible synthetic cases "
                f"are excluded by that boundary alone ({cliff['severity']} severity).")
    if any(k in m for k in ("conflict", "contradict")):
        if conflict:
            return (f"{conflict['conflictCode']}: {conflict['title']}. {conflict['description']} "
                    f"{r['conflictCount']} conflicts were found in total, {r['conflictUnresolved']} unresolved.")
        return "No rule conflicts were detected in the latest run."
    if any(k in m for k in ("fair", "bias", "equity", "band")):
        bands = sorted(r["fairnessBands"], key=lambda b: b["height"])
        return (f"The fairness signal is {r['fairnessScore']}/100. Coverage ranges from {bands[0]['height']}% "
                f"({bands[0]['band']}) to {bands[-1]['height']}% ({bands[-1]['band']}) across bands. "
                "This is a simulation signal for policy review, not a demographic claim.")
    if "edge" in m:
        return (f"{r['edgeCaseCount']:,} of {r['totalTested']:,} synthetic cases ({r['edgeCaseRate']}%) are edge cases: "
                "near a threshold, excluded by a single rule, or caught between conflicting rules.")
    if any(k in m for k in ("budget", "cost", "impact")):
        w = ctx.get("lastWhatIf")
        extra = f" Your last what-if changes the budget by {w['budgetFormatted']}." if w else ""
        return f"Budget sensitivity for {name} is {r['budgetSensitivity']}.{extra}"
    if "report" in m:
        return (f"This report summarises {ctx['rulesCount']} extracted rules, {r['edgeCaseCount']:,} synthetic edge cases, "
                f"and a fairness signal of {r['fairnessScore']}/100. It is a simulated audit and must not be used for real-world decisions.")
    if any(k in m for k in ("what if", "change", "explain")) and ctx.get("lastWhatIf"):
        return explain_whatif(ctx["lastWhatIf"], name)
    if any(k in m for k in ("eligible", "cover", "reject")):
        return (f"Of {r['totalTested']:,} synthetic cases, {r['eligibleCount']:,} ({r['eligibleRate']}%) are eligible, "
                f"{r['rejectedCount']:,} ({r['rejectedRate']}%) rejected and {r['needsReviewCount']:,} need manual review.")
    return (f"EDGECASE converts policy text into rules, tests them against {r['totalTested']:,} synthetic cases, and highlights "
            "boundaries, conflicts and fairness signals for review. Ask about cliffs, conflicts, fairness, edge cases or budget.")
