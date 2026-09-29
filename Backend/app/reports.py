"""PDF report generation (ReportLab). Standard PDF fonts lack ₹/≤/≥, so text is transliterated."""
from __future__ import annotations

import datetime as dt
from io import BytesIO

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

SAGE, INK = colors.HexColor("#7c8c5e"), colors.HexColor("#252525")
TITLES = {
    "AUDIT_REPORT": ("Policy Audit Report", "Rules, synthetic outcomes, edge cases, cliffs and counterfactual impact"),
    "SIMULATION_REPORT": ("Simulation Report", "Crash-test results"),
    "VERSION_COMPARISON": ("Policy Version Comparison", "Baseline policy versus tested scenarios"),
    "RULE_EXTRACTION_LOG": ("Rule Extraction Log", "AI reasoning and confidence trail"),
}


def safe(text) -> str:
    t = str(text)
    for a, b in (("₹", "Rs "), ("≤", "<="), ("≥", ">="), ("→", "->"), ("—", "-"), ("•", "-")):
        t = t.replace(a, b)
    return t.encode("latin-1", "replace").decode("latin-1")


def _table(rows, widths=None, head=True):
    t = Table([[Paragraph(safe(c), CELL) if isinstance(c, str) else c for c in r] for r in rows], colWidths=widths, repeatRows=1 if head else 0)
    style = [("GRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#d9d0c3")), ("VALIGN", (0, 0), (-1, -1), "TOP"),
             ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4)]
    if head:
        style += [("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#efe9df"))]
    t.setStyle(TableStyle(style))
    return t


_ss = getSampleStyleSheet()
H1 = ParagraphStyle("h1", parent=_ss["Title"], fontName="Helvetica-Bold", fontSize=24, textColor=INK, alignment=0)
H2 = ParagraphStyle("h2", parent=_ss["Heading2"], fontName="Helvetica-Bold", fontSize=13, textColor=SAGE, spaceBefore=14)
BODY = ParagraphStyle("b", parent=_ss["BodyText"], fontSize=9.5, leading=13)
CELL = ParagraphStyle("c", parent=BODY, fontSize=8, leading=10)


def build_pdf(kind: str, policy: dict, sim: dict, whatifs: list[dict], policy_name: str) -> bytes:
    title, subtitle = TITLES[kind]
    r = sim["results"]
    buf = BytesIO()
    doc = SimpleDocTemplate(buf, pagesize=A4, leftMargin=18 * mm, rightMargin=18 * mm, topMargin=16 * mm, bottomMargin=16 * mm,
                            title=f"EDGECASE - {title}", author="EDGECASE")
    s = [Paragraph("EDGECASE / POLICY AUDIT", ParagraphStyle("e", parent=BODY, textColor=SAGE, fontSize=8)),
         Paragraph(safe(f"{policy_name}"), H1), Paragraph(safe(f"{title} - {subtitle}"), BODY),
         Paragraph(f"Generated {dt.datetime.now().strftime('%d %b %Y, %H:%M')} - Mode {sim['mode']} - Seed {sim['seed']}", BODY),
         Spacer(1, 6)]
    if kind in ("AUDIT_REPORT", "SIMULATION_REPORT"):
        s += [Paragraph("Summary", H2), _table([
            ["Metric", "Value"], ["Synthetic cases tested", f"{r['totalTested']:,}"],
            ["Eligible", f"{r['eligibleCount']:,} ({r['eligibleRate']}%)"], ["Rejected", f"{r['rejectedCount']:,} ({r['rejectedRate']}%)"],
            ["Needs review", f"{r['needsReviewCount']:,} ({r['needsReviewRate']}%)"], ["Edge cases", f"{r['edgeCaseCount']:,} ({r['edgeCaseRate']}%)"],
            ["Policy cliffs", str(r["cliffCount"])], ["Rule conflicts", str(r["conflictCount"])],
            ["Fairness signal", f"{r['fairnessScore']} / 100"], ["Budget sensitivity", r["budgetSensitivity"]]], [70 * mm, 90 * mm])]
        s += [Paragraph("Rejection reasons", H2), _table([["Reason", "Cases", "Share"]] + [[x["reason"], f"{x['count']:,}", f"{x['percentage']}%"] for x in r["rejectionReasons"]], [90 * mm, 35 * mm, 35 * mm])]
        s += [Paragraph("Coverage by band", H2), _table([["Band", "Eligible %", "Cases"]] + [[b["band"], f"{b['height']}%", f"{b['count']:,}"] for b in r["fairnessBands"]], [70 * mm, 45 * mm, 45 * mm])]
    if kind == "AUDIT_REPORT":
        if sim["cliffs"]:
            s += [Paragraph("Policy cliffs", H2), _table([["Variable", "Threshold", "Critical change", "Affected", "Severity"]] + [[c["variable"], c["thresholdValue"], c["criticalChange"], f"{c['affectedCases']:,}", c["severity"]] for c in sim["cliffs"]])]
        if sim["conflicts"]:
            s += [Paragraph("Rule conflicts", H2), _table([["Code", "Title", "Affected", "Status"]] + [[c["conflictCode"], c["title"], f"{c['affectedCases']:,}", c["status"]] for c in sim["conflicts"]])]
    if kind in ("AUDIT_REPORT", "RULE_EXTRACTION_LOG", "VERSION_COMPARISON"):
        s += [Paragraph("Rules", H2), _table([["Code", "Rule", "Constraint", "Type", "Conf.", "Status"]] + [
            [x["code"], x["description"], f"{x['var']} {x['op']} {x['value']}", x["type"], f"{x['confidence']:.0f}%", x["verificationStatus"]] for x in sim["policySnapshot"]["rules"]],
            [12 * mm, 62 * mm, 38 * mm, 22 * mm, 12 * mm, 24 * mm])]
    if kind == "RULE_EXTRACTION_LOG":
        s += [Paragraph("Source", H2), Paragraph(safe(f"Source type: {policy['sourceType']}. OCR confidence: {policy.get('ocrConfidence') or 'n/a (text layer)'}"), BODY)]
        s += [Paragraph("Source excerpts", H2)] + [Paragraph(safe(f"<b>{x['code']}</b> - {x.get('sourceText') or x['description']}"), BODY) for x in policy["rules"]]
    if kind == "VERSION_COMPARISON":
        rows = [["Scenario", "Old -> New", "Eligible change", "Cases affected", "Budget change"]]
        rows += [[w["parameterLabel"], f"{w['oldFormatted']} -> {w['newFormatted']}", f"{w['eligibleDelta']:+,}", f"{w['affectedCases']:,}", w["budgetFormatted"]] for w in whatifs]
        s += [Paragraph("Scenarios tested", H2), _table(rows) if whatifs else Paragraph("No what-if scenarios have been run for this simulation yet.", BODY)]
    if kind in ("AUDIT_REPORT", "SIMULATION_REPORT"):
        edge = sim["edgeCases"][:15]
        s += [Paragraph("Top edge cases", H2), _table([["Case", "Attributes", "Result", "Type", "Reason"]] + [[c["caseIdentifier"], c["attributeSummary"], c["result"], c["type"], c["reason"]] for c in edge],
                                                       [22 * mm, 44 * mm, 20 * mm, 30 * mm, 50 * mm])]
    s += [Spacer(1, 12), Paragraph("Methodology & disclaimer", H2),
          Paragraph("All figures come from a seeded synthetic population. Edge cases are cases within 2% of a numeric threshold, excluded by a single rule, "
                    "or caught between conflicting rules. This report contains synthetic demo data and is not for real-world decision making.", BODY)]
    doc.build(s)
    return buf.getvalue()
