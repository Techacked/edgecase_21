"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.analyzeFairness = exports.bandLabel = exports.SYNTHETIC_DISCLAIMER = void 0;
exports.SYNTHETIC_DISCLAIMER = 'Synthetic analysis signal — not a real-world fairness claim.';
const r4 = (x) => Math.round(x * 10000) / 10000;
const rate = (a, b) => (b === 0 ? 0 : r4(a / b));
function bandLabel(edges, i) {
    const lo = edges[i];
    const hi = edges[i + 1];
    return hi === undefined ? `${lo}+` : `${lo}–${hi - 1}`;
}
exports.bandLabel = bandLabel;
/** Aggregates on synthetic data only. Bands and groups come from the policy's own configuration. */
function analyzeFairness(policy, cases, evals) {
    const edges = policy.fairness.bandEdges;
    const bandVar = policy.fairness.bandVariable;
    const bands = edges.map((lo, i) => ({ label: bandLabel(edges, i), lower: lo, upper: edges[i + 1] ?? null, cases: 0, eligible: 0, rejected: 0, needsReview: 0 }));
    const groupAcc = new Map();
    for (const g of policy.fairness.groupVariables)
        groupAcc.set(g, new Map());
    let eligible = 0;
    let rejected = 0;
    let review = 0;
    cases.forEach((c, i) => {
        const ev = evals[i];
        if (ev.outcome === 'ELIGIBLE')
            eligible++;
        else if (ev.outcome === 'REJECTED')
            rejected++;
        else
            review++;
        const x = c.attributes[bandVar];
        let b = 0;
        for (let k = 0; k < edges.length; k++)
            if (x >= edges[k])
                b = k;
        const band = bands[b];
        if (band) {
            band.cases++;
            if (ev.outcome === 'ELIGIBLE')
                band.eligible++;
            else if (ev.outcome === 'REJECTED')
                band.rejected++;
            else
                band.needsReview++;
        }
        for (const [g, m] of groupAcc) {
            const key = String(c.attributes[g]);
            const cur = m.get(key) ?? { cases: 0, eligible: 0, review: 0 };
            cur.cases++;
            if (ev.outcome === 'ELIGIBLE')
                cur.eligible++;
            if (ev.outcome === 'NEEDS_REVIEW')
                cur.review++;
            m.set(key, cur);
        }
    });
    const total = cases.length;
    const bandStats = bands.map((b) => {
        const populationShare = rate(b.cases, total);
        const coverageShare = rate(b.eligible, eligible);
        return {
            ...b, populationShare,
            eligibilityRate: rate(b.eligible, b.cases), reviewRate: rate(b.needsReview, b.cases),
            coverageShare, coverageRatio: populationShare === 0 ? null : r4(coverageShare / populationShare),
            rejectionShare: rate(b.rejected, rejected),
        };
    });
    const top = [...bandStats].sort((a, b) => b.rejectionShare - a.rejectionShare)[0];
    const populated = bandStats.filter((b) => b.cases > 0).map((b) => b.eligibilityRate);
    return {
        dataType: 'SYNTHETIC',
        disclaimer: exports.SYNTHETIC_DISCLAIMER,
        outcomeDistribution: {
            eligible, rejected, needsReview: review, total,
            eligibleRate: rate(eligible, total), rejectedRate: rate(rejected, total), reviewRate: rate(review, total),
        },
        bandVariable: bandVar,
        bands: bandStats,
        rejectionConcentration: {
            hhi: r4(bandStats.reduce((s, b) => s + b.rejectionShare ** 2, 0)),
            topBand: top && top.rejectionShare > 0 ? top.label : null,
            topBandShare: top?.rejectionShare ?? 0,
        },
        eligibilityRateSpread: populated.length ? r4(Math.max(...populated) - Math.min(...populated)) : 0,
        groups: [...groupAcc].map(([variable, m]) => ({
            variable,
            groups: [...m.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([value, g]) => ({
                value, cases: g.cases, eligible: g.eligible, eligibilityRate: rate(g.eligible, g.cases), reviewRate: rate(g.review, g.cases),
            })),
        })),
    };
}
exports.analyzeFairness = analyzeFairness;
