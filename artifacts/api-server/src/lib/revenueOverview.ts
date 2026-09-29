/**
 * Pure aggregation/assembly logic for the unified Revenue Overview.
 *
 * Streams:
 *  - ecommerce: orders + order_payment (recognized revenue in USD, refunds
 *    from cumulative refunded_amount_usd). Orders linked to a CMC sale
 *    (cmc_sales.order_id) are attributed to the CMC stream and excluded here.
 *  - retail: workshop sales (order value at creation, non-draft/non-cancelled)
 *    plus POS cash-desk quick-entry sales that are NOT mirrors of a workshop
 *    sale payment or a CMC sale (deduplicated by cash_transactions.reference_type).
 *  - cmc: cmc_sales with status='paid'; refunds are sales moved to
 *    status='refunded'. CMC cash-ledger mirrors (type='cash_sale',
 *    reference_type='cmc_sale') are excluded from retail.
 *
 * All figures are reported in USD. Non-USD retail amounts are converted with
 * the stored exchange rate; rows without a stored rate are excluded and the
 * stream is flagged partial.
 */

export type StreamKey = "ecommerce" | "retail" | "cmc" | "toters";

export const STREAM_KEYS: readonly StreamKey[] = ["ecommerce", "retail", "cmc", "toters"];

export type Granularity = "hour" | "day" | "week" | "month";

/** Range-appropriate series granularity. */
export function granularityFor(range: { from: Date; to: Date }): Granularity {
  const days = (range.to.getTime() - range.from.getTime()) / 86_400_000;
  if (days <= 2) return "hour";
  if (days <= 31) return "day";
  if (days <= 180) return "week";
  return "month";
}

/** One aggregated bucket for a stream (all monetary values in USD). */
export type StreamBucket = {
  /** ISO timestamp of the bucket start (date_trunc result). */
  bucket: string;
  revenue: number;
  orders: number;
  refunds: number;
};

export type StreamTotals = {
  revenue: number;
  orders: number;
  refunds: number;
  /** Latest activity timestamp observed for the stream (ISO) or null. */
  lastActivityAt: string | null;
  /** True when some source rows could not be included (e.g. missing FX rate). */
  partial: boolean;
  /** Human-readable reason when partial or unavailable. */
  partialReason: string | null;
  /** False when the source could not be queried at all. */
  available: boolean;
};

export function emptyStreamTotals(): StreamTotals {
  return {
    revenue: 0,
    orders: 0,
    refunds: 0,
    lastActivityAt: null,
    partial: false,
    partialReason: null,
    available: true,
  };
}

export type StreamData = {
  totals: StreamTotals;
  series: StreamBucket[];
};

/** Round to cents to avoid float drift; keeps totals === sum(streams). */
export function roundMoney(v: number): number {
  return Math.round(v * 100) / 100;
}

export function pctChange(current: number, baseline: number | null): number | null {
  if (baseline === null || baseline === 0) return null;
  return ((current - baseline) / Math.abs(baseline)) * 100;
}

// ---------------------------------------------------------------------------
// Channel pulse
// ---------------------------------------------------------------------------

/** Documented thresholds: change >= -5% on track, >= -20% at risk, else off track. */
export const PULSE_THRESHOLDS = { atRiskBelowPct: -5, offTrackBelowPct: -20 } as const;

export type PulseStatus = "on_track" | "at_risk" | "off_track" | "no_data";

export function computePulse(
  current: number,
  baseline: number | null,
): { status: PulseStatus; changePct: number | null; reason: string } {
  const changePct = pctChange(current, baseline);
  if (baseline === null || baseline === 0) {
    if (current > 0) {
      return {
        status: "on_track",
        changePct: null,
        reason: "Revenue recorded this period with no baseline activity to compare against.",
      };
    }
    return {
      status: "no_data",
      changePct: null,
      reason: "No revenue in the current or baseline period.",
    };
  }
  const pct = changePct as number;
  const rounded = Math.round(pct * 10) / 10;
  if (pct >= PULSE_THRESHOLDS.atRiskBelowPct) {
    return {
      status: "on_track",
      changePct: pct,
      reason: `Revenue changed ${rounded}% vs the baseline period (on track: change >= ${PULSE_THRESHOLDS.atRiskBelowPct}%).`,
    };
  }
  if (pct >= PULSE_THRESHOLDS.offTrackBelowPct) {
    return {
      status: "at_risk",
      changePct: pct,
      reason: `Revenue fell ${rounded}% vs the baseline period (at risk: below ${PULSE_THRESHOLDS.atRiskBelowPct}%, above ${PULSE_THRESHOLDS.offTrackBelowPct}%).`,
    };
  }
  return {
    status: "off_track",
    changePct: pct,
    reason: `Revenue fell ${rounded}% vs the baseline period (off track: below ${PULSE_THRESHOLDS.offTrackBelowPct}%).`,
  };
}

// ---------------------------------------------------------------------------
// Series assembly
// ---------------------------------------------------------------------------

/** Enumerate bucket starts covering [from, to) in UTC for the granularity. */
export function enumerateBuckets(
  range: { from: Date; to: Date },
  granularity: Granularity,
): string[] {
  const out: string[] = [];
  const d = new Date(range.from);
  // Align to bucket start (UTC, matching Postgres date_trunc at UTC).
  if (granularity === "hour") {
    d.setUTCMinutes(0, 0, 0);
  } else {
    d.setUTCHours(0, 0, 0, 0);
    if (granularity === "week") {
      const dow = (d.getUTCDay() + 6) % 7; // Monday-based, matching date_trunc('week')
      d.setUTCDate(d.getUTCDate() - dow);
    } else if (granularity === "month") {
      d.setUTCDate(1);
    }
  }
  const limit = 1000; // safety cap
  while (d < range.to && out.length < limit) {
    out.push(d.toISOString());
    if (granularity === "hour") d.setUTCHours(d.getUTCHours() + 1);
    else if (granularity === "day") d.setUTCDate(d.getUTCDate() + 1);
    else if (granularity === "week") d.setUTCDate(d.getUTCDate() + 7);
    else d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}

export type SeriesPoint = {
  bucket: string;
  /** Per-stream revenue; null = no source rows in the bucket (a gap, not zero). */
  ecommerce: number | null;
  retail: number | null;
  cmc: number | null;
  toters: number | null;
  total: number;
};

/** Merge per-stream bucket rows onto the full bucket axis; missing = null. */
export function assembleSeries(
  buckets: string[],
  streams: Record<StreamKey, StreamBucket[]>,
): SeriesPoint[] {
  const maps: Record<StreamKey, Map<string, number>> = {
    ecommerce: new Map(),
    retail: new Map(),
    cmc: new Map(),
    toters: new Map(),
  };
  for (const key of STREAM_KEYS) {
    for (const row of streams[key]) {
      const iso = new Date(row.bucket).toISOString();
      maps[key].set(iso, roundMoney((maps[key].get(iso) ?? 0) + row.revenue));
    }
  }
  return buckets.map((bucket) => {
    const e = maps.ecommerce.get(bucket) ?? null;
    const r = maps.retail.get(bucket) ?? null;
    const c = maps.cmc.get(bucket) ?? null;
    const t = maps.toters.get(bucket) ?? null;
    return {
      bucket,
      ecommerce: e,
      retail: r,
      cmc: c,
      toters: t,
      total: roundMoney((e ?? 0) + (r ?? 0) + (c ?? 0) + (t ?? 0)),
    };
  });
}

// ---------------------------------------------------------------------------
// Operating snapshot
// ---------------------------------------------------------------------------

export type SnapshotMetric = {
  value: number | null;
  available: boolean;
  reason: string | null;
};

export function computeSnapshot(
  totals: Record<StreamKey, StreamTotals>,
  cogs: { cogsUsd: number; costedRevenueUsd: number },
): {
  orders: SnapshotMetric;
  aov: SnapshotMetric;
  grossMargin: SnapshotMetric & { coveragePct: number };
  refundRate: SnapshotMetric;
} {
  const revenue = roundMoney(
    totals.ecommerce.revenue + totals.retail.revenue + totals.cmc.revenue + totals.toters.revenue,
  );
  const orders =
    totals.ecommerce.orders + totals.retail.orders + totals.cmc.orders + totals.toters.orders;
  const refunds = roundMoney(
    totals.ecommerce.refunds + totals.retail.refunds + totals.cmc.refunds + totals.toters.refunds,
  );

  const aov: SnapshotMetric =
    orders > 0
      ? { value: roundMoney(revenue / orders), available: true, reason: null }
      : { value: null, available: false, reason: "No orders in the selected period." };

  // Gross margin is only shown when COGS coverage of revenue is high enough
  // to be trustworthy (>= 95% of recognized revenue has recorded COGS).
  const coverage = revenue > 0 ? cogs.costedRevenueUsd / revenue : 0;
  const coveragePct = Math.round(coverage * 1000) / 10;
  let grossMargin: SnapshotMetric & { coveragePct: number };
  if (revenue > 0 && coverage >= 0.95) {
    grossMargin = {
      value: roundMoney(((cogs.costedRevenueUsd - cogs.cogsUsd) / cogs.costedRevenueUsd) * 100),
      available: true,
      reason: null,
      coveragePct,
    };
  } else {
    grossMargin = {
      value: null,
      available: false,
      reason:
        revenue > 0
          ? `COGS is recorded for only ${coveragePct}% of revenue in this period (needs >= 95%). E-Commerce and CMC sales do not carry per-sale COGS.`
          : "No revenue in the selected period.",
      coveragePct,
    };
  }

  const gross = revenue + refunds;
  const refundRate: SnapshotMetric =
    gross > 0
      ? { value: roundMoney((refunds / gross) * 100), available: true, reason: null }
      : { value: null, available: false, reason: "No revenue or refunds in the selected period." };

  return {
    orders: { value: orders, available: true, reason: null },
    aov,
    grossMargin,
    refundRate,
  };
}

// ---------------------------------------------------------------------------
// Definitions block (documented rules surfaced in tooltips)
// ---------------------------------------------------------------------------

export const REVENUE_DEFINITIONS = {
  currency:
    "All figures are reported in USD. E-Commerce uses the USD-equivalent of captured payments (or the order's stored USD total). CMC sales are recorded in USD. Non-USD retail amounts are converted with the stored exchange rate; rows without a stored rate are excluded and flagged.",
  timezone: "Buckets are computed in UTC.",
  ecommerce:
    "Orders excluding cancelled, refunded, failed and trashed orders, dated by order date (fallback: creation date). Revenue prefers the summed USD payment amount, falling back to the order's stored USD total. Orders linked to a CMC sale are counted under CMC, not here.",
  retail:
    "Workshop sales (excluding drafts and cancellations, at full sale value dated by creation) plus POS cash-desk quick-entry sales. Cash-ledger rows that mirror a workshop sale payment or a CMC sale are excluded so nothing is counted twice.",
  cmc: "CMC POS sales with status 'paid', dated by sale creation. Sales moved to 'refunded' count as refunds. Their cash-ledger mirrors are excluded from Retail.",
  toters:
    "Toters marketplace orders imported from CSV. Only orders with status 'arrived' contribute revenue, dated by arrival (fallback: order time). Revenue is each order's Items Total × 1,500 ÷ 89,700, treated as USD with no further conversion; stored at full precision and rounded only for display.",
  refunds:
    "E-Commerce: cumulative refunded payment amounts (USD). Retail: outgoing cash refund transactions. CMC: full value of sales moved to status 'refunded'.",
  taxesAndFees:
    "Revenue is the recognized sale total as stored per stream: it includes taxes, delivery fees and discounts as captured at sale time. No additional adjustments are applied.",
  testOrders:
    "There is no test-order marker in the data model; all workspace orders are included.",
  comparison:
    "Comparison values use the selected baseline (previous period, previous year, or a custom window). Channel Pulse always compares against the previous period of equal length when no comparison is selected.",
  pulse: `On track: revenue change >= ${PULSE_THRESHOLDS.atRiskBelowPct}% vs baseline. At risk: below ${PULSE_THRESHOLDS.atRiskBelowPct}% but >= ${PULSE_THRESHOLDS.offTrackBelowPct}%. Off track: below ${PULSE_THRESHOLDS.offTrackBelowPct}%.`,
} as const;
