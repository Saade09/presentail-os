import { Router, type IRouter, type Request, type Response } from "express";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import {
  resolveRange,
  parseComparison,
  previousRange,
  num,
  NON_REVENUE_STATUSES,
  type AnalyticsRange,
} from "../lib/storeAnalytics";
import { getStoredRate } from "../lib/exchangeRateService";
import {
  granularityFor,
  enumerateBuckets,
  assembleSeries,
  computePulse,
  computeSnapshot,
  emptyStreamTotals,
  pctChange,
  roundMoney,
  PULSE_THRESHOLDS,
  REVENUE_DEFINITIONS,
  STREAM_KEYS,
  type Granularity,
  type StreamBucket,
  type StreamData,
  type StreamKey,
  type StreamTotals,
} from "../lib/revenueOverview";

const router: IRouter = Router();

router.use(requireAuth, resolveWorkspace);

const NON_REVENUE_SQL = NON_REVENUE_STATUSES.map((s) => `'${s}'`).join(", ");

/** Cash-ledger rows that mirror another stream's sale (dedup targets). */
const MIRROR_REFERENCE_TYPES = "'workshop_sale_payment', 'cmc_sale'";
const LBP_TO_USD_MIN = 1 / 1_000_000;
const LBP_TO_USD_MAX = 1 / 10_000;

const STREAM_LABELS: Record<StreamKey, string> = {
  ecommerce: "E-Commerce",
  retail: "Retail",
  cmc: "CMC",
  toters: "Toters",
};

function truncExpr(granularity: Granularity, col: string): string {
  // granularity is a server-controlled whitelist value, safe to interpolate.
  return `date_trunc('${granularity}', ${col} AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
}

// ---------------------------------------------------------------------------
// Per-stream fetchers. Each returns bucketed rows in USD plus totals.
// ---------------------------------------------------------------------------

async function fetchEcommerce(
  ownerId: string,
  range: AnalyticsRange,
  granularity: Granularity,
): Promise<StreamData> {
  const { rows } = await db.query<{
    bucket: string;
    orders: string;
    revenue: string;
    refunds: string;
    last_activity: string | null;
  }>(
    `
    SELECT
      ${truncExpr(granularity, "COALESCE(o.ordered_at, o.created_at)")} AS bucket,
      COUNT(*) FILTER (WHERE o.status NOT IN (${NON_REVENUE_SQL})) AS orders,
      COALESCE(SUM(
        CASE WHEN o.status NOT IN (${NON_REVENUE_SQL})
          THEN COALESCE(pay.paid_usd, NULLIF(o.totals->>'total', '')::numeric, 0)
          ELSE 0 END
      ), 0) AS revenue,
      COALESCE(SUM(pay.refunded_usd), 0) AS refunds,
      MAX(o.created_at) AS last_activity
    FROM orders o
    LEFT JOIN (
      SELECT order_id,
             SUM(amount_usd) AS paid_usd,
             SUM(COALESCE(refunded_amount_usd, 0)) AS refunded_usd
      FROM order_payment
      GROUP BY order_id
    ) pay ON pay.order_id = o.id
    WHERE o.workspace_owner_id = $1
      AND COALESCE(o.ordered_at, o.created_at) >= $2
      AND COALESCE(o.ordered_at, o.created_at) < $3
      AND NOT EXISTS (SELECT 1 FROM cmc_sales cs WHERE cs.order_id = o.id)
    GROUP BY 1
    ORDER BY 1
    `,
    [ownerId, range.from, range.to],
  );

  const totals = emptyStreamTotals();
  const series: StreamBucket[] = [];
  for (const r of rows) {
    const revenue = roundMoney(num(r.revenue));
    const refunds = roundMoney(num(r.refunds));
    const orders = num(r.orders);
    series.push({ bucket: new Date(r.bucket).toISOString(), revenue, orders, refunds });
    totals.revenue = roundMoney(totals.revenue + revenue);
    totals.refunds = roundMoney(totals.refunds + refunds);
    totals.orders += orders;
    if (r.last_activity) {
      const iso = new Date(r.last_activity).toISOString();
      if (!totals.lastActivityAt || iso > totals.lastActivityAt) totals.lastActivityAt = iso;
    }
  }
  return { totals, series };
}

type CurrencyConverter = (currency: string | null) => Promise<number | null>;

/** Retail = workshop sales + non-mirrored POS cash-desk sales, minus cash refunds. */
async function fetchRetail(
  ownerId: string,
  range: AnalyticsRange,
  granularity: Granularity,
  toUsd: CurrencyConverter,
): Promise<StreamData & { cogs: { cogsUsd: number; costedRevenueUsd: number } }> {
  const [workshop, cash, cashRefunds] = await Promise.all([
    db.query<{
      bucket: string;
      currency: string | null;
      orders: string;
      revenue: string;
      cogs: string | null;
      costed_revenue: string | null;
      last_activity: string | null;
    }>(
      `
      SELECT
        ${truncExpr(granularity, "ws.created_at")} AS bucket,
        ws.currency AS currency,
        COUNT(*) AS orders,
        COALESCE(SUM(ws.total), 0) AS revenue,
        SUM(ws.cogs_amount) FILTER (WHERE ws.cogs_amount IS NOT NULL) AS cogs,
        SUM(ws.total) FILTER (WHERE ws.cogs_amount IS NOT NULL) AS costed_revenue,
        MAX(ws.created_at) AS last_activity
      FROM workshop_sales ws
      WHERE ws.workspace_owner_id = $1
        AND ws.created_at >= $2
        AND ws.created_at < $3
        AND ws.status NOT IN ('draft', 'cancelled')
      GROUP BY 1, 2
      ORDER BY 1
      `,
      [ownerId, range.from, range.to],
    ),
    db.query<{
      bucket: string;
      currency: string | null;
      orders: string;
      revenue: string;
      last_activity: string | null;
    }>(
      `
      SELECT
        ${truncExpr(granularity, "COALESCE(ct.transaction_date, ct.created_at)")} AS bucket,
        COALESCE(ct.transaction_currency, ct.currency) AS currency,
        COUNT(*) AS orders,
        COALESCE(SUM(ct.amount), 0) AS revenue,
        MAX(ct.created_at) AS last_activity
      FROM cash_transactions ct
      WHERE ct.workspace_owner_id = $1
        AND COALESCE(ct.transaction_date, ct.created_at) >= $2
        AND COALESCE(ct.transaction_date, ct.created_at) < $3
        AND ct.direction = 'in'
        AND ct.type = 'sale'
        AND ct.status = 'confirmed'
        AND COALESCE(ct.is_reversed, false) = false
        AND COALESCE(ct.reference_type, '') NOT IN (${MIRROR_REFERENCE_TYPES})
      GROUP BY 1, 2
      ORDER BY 1
      `,
      [ownerId, range.from, range.to],
    ),
    db.query<{ currency: string | null; refunds: string }>(
      `
      SELECT COALESCE(ct.transaction_currency, ct.currency) AS currency,
             COALESCE(SUM(ct.amount), 0) AS refunds
      FROM cash_transactions ct
      WHERE ct.workspace_owner_id = $1
        AND COALESCE(ct.transaction_date, ct.created_at) >= $2
        AND COALESCE(ct.transaction_date, ct.created_at) < $3
        AND ct.direction = 'out'
        AND ct.type = 'refund'
        AND ct.status = 'confirmed'
        AND COALESCE(ct.is_reversed, false) = false
      GROUP BY 1
      `,
      [ownerId, range.from, range.to],
    ),
  ]);

  const totals = emptyStreamTotals();
  const byBucket = new Map<string, StreamBucket>();
  const cogs = { cogsUsd: 0, costedRevenueUsd: 0 };
  let excluded: { currency: string; amount: number } | null = null;

  const add = async (
    bucket: string,
    currency: string | null,
    revenue: number,
    orders: number,
  ) => {
    const rate = await toUsd(currency);
    if (rate === null) {
      const cur = (currency ?? "unknown").toUpperCase();
      excluded = {
        currency: cur,
        amount: roundMoney((excluded?.amount ?? 0) + revenue),
      };
      return;
    }
    const usd = roundMoney(revenue * rate);
    const iso = new Date(bucket).toISOString();
    const row = byBucket.get(iso) ?? { bucket: iso, revenue: 0, orders: 0, refunds: 0 };
    row.revenue = roundMoney(row.revenue + usd);
    row.orders += orders;
    byBucket.set(iso, row);
    totals.revenue = roundMoney(totals.revenue + usd);
    totals.orders += orders;
    return rate;
  };

  for (const r of workshop.rows) {
    const rate = await add(r.bucket, r.currency, num(r.revenue), num(r.orders));
    if (typeof rate === "number") {
      cogs.cogsUsd = roundMoney(cogs.cogsUsd + num(r.cogs) * rate);
      cogs.costedRevenueUsd = roundMoney(cogs.costedRevenueUsd + num(r.costed_revenue) * rate);
    }
    if (r.last_activity) {
      const iso = new Date(r.last_activity).toISOString();
      if (!totals.lastActivityAt || iso > totals.lastActivityAt) totals.lastActivityAt = iso;
    }
  }
  for (const r of cash.rows) {
    await add(r.bucket, r.currency, num(r.revenue), num(r.orders));
    if (r.last_activity) {
      const iso = new Date(r.last_activity).toISOString();
      if (!totals.lastActivityAt || iso > totals.lastActivityAt) totals.lastActivityAt = iso;
    }
  }
  for (const r of cashRefunds.rows) {
    const rate = await toUsd(r.currency);
    if (rate === null) {
      // Unconvertible refunds are excluded and flagged, same as sales rows.
      const cur = (r.currency ?? "unknown").toUpperCase();
      const prev = excluded as { currency: string; amount: number } | null;
      excluded = {
        currency: cur,
        amount: roundMoney((prev?.amount ?? 0) + num(r.refunds)),
      };
      continue;
    }
    totals.refunds = roundMoney(totals.refunds + num(r.refunds) * rate);
  }

  if (excluded !== null) {
    const ex = excluded as { currency: string; amount: number };
    totals.partial = true;
    totals.partialReason = `Some retail amounts (${ex.amount} ${ex.currency}) were excluded because no USD exchange rate is stored for that currency.`;
  }

  const series = Array.from(byBucket.values()).sort((a, b) =>
    a.bucket.localeCompare(b.bucket),
  );
  return { totals, series, cogs };
}

async function fetchCmc(
  ownerId: string,
  range: AnalyticsRange,
  granularity: Granularity,
): Promise<StreamData> {
  const { rows } = await db.query<{
    bucket: string;
    orders: string;
    revenue: string;
    refunds: string;
    last_activity: string | null;
  }>(
    `
    SELECT
      ${truncExpr(granularity, "cs.created_at")} AS bucket,
      COUNT(*) FILTER (WHERE cs.status = 'paid') AS orders,
      COALESCE(SUM(cs.total) FILTER (WHERE cs.status = 'paid'), 0) AS revenue,
      COALESCE(SUM(cs.total) FILTER (WHERE cs.status = 'refunded'), 0) AS refunds,
      MAX(cs.created_at) AS last_activity
    FROM cmc_sales cs
    WHERE cs.workspace_owner_id = $1
      AND cs.created_at >= $2
      AND cs.created_at < $3
      AND cs.status IN ('paid', 'refunded')
    GROUP BY 1
    ORDER BY 1
    `,
    [ownerId, range.from, range.to],
  );

  const totals = emptyStreamTotals();
  const series: StreamBucket[] = [];
  for (const r of rows) {
    const revenue = roundMoney(num(r.revenue));
    const refunds = roundMoney(num(r.refunds));
    series.push({
      bucket: new Date(r.bucket).toISOString(),
      revenue,
      orders: num(r.orders),
      refunds,
    });
    totals.revenue = roundMoney(totals.revenue + revenue);
    totals.refunds = roundMoney(totals.refunds + refunds);
    totals.orders += num(r.orders);
    if (r.last_activity) {
      const iso = new Date(r.last_activity).toISOString();
      if (!totals.lastActivityAt || iso > totals.lastActivityAt) totals.lastActivityAt = iso;
    }
  }
  return { totals, series };
}

export type TotersStoreBreakdown = { store: string; revenue: number; orders: number };

/**
 * Toters = imported marketplace orders with status 'arrived', valued at each
 * order's stored calculated revenue (Items Total × 1,500 ÷ 89,700, USD).
 * The stream total sums the unrounded stored values and rounds once; series
 * buckets are rounded independently for display.
 */
async function fetchToters(
  ownerId: string,
  range: AnalyticsRange,
  granularity: Granularity,
  options: { includeStores?: boolean } = {},
): Promise<StreamData & { byStore?: TotersStoreBreakdown[] }> {
  const dateExpr = "COALESCE(t.arrived_time, t.order_time, t.created_at)";
  const baseWhere = `
      t.workspace_owner_id = $1
      AND t.status = 'arrived'
      AND ${dateExpr} >= $2
      AND ${dateExpr} < $3`;

  const [bucketed, stores] = await Promise.all([
    db.query<{
      bucket: string;
      orders: string;
      revenue: string;
      last_activity: string | null;
    }>(
      `
      SELECT
        ${truncExpr(granularity, dateExpr)} AS bucket,
        COUNT(*) AS orders,
        COALESCE(SUM(t.calculated_revenue), 0) AS revenue,
        MAX(t.created_at) AS last_activity
      FROM toters_orders t
      WHERE ${baseWhere}
      GROUP BY 1
      ORDER BY 1
      `,
      [ownerId, range.from, range.to],
    ),
    options.includeStores
      ? db.query<{ store: string | null; orders: string; revenue: string }>(
          `
          SELECT t.store AS store,
                 COUNT(*) AS orders,
                 COALESCE(SUM(t.calculated_revenue), 0) AS revenue
          FROM toters_orders t
          WHERE ${baseWhere}
          GROUP BY 1
          ORDER BY 3 DESC
          `,
          [ownerId, range.from, range.to],
        )
      : Promise.resolve(null),
  ]);

  const totals = emptyStreamTotals();
  const series: StreamBucket[] = [];
  let rawRevenue = 0;
  for (const r of bucketed.rows) {
    const raw = num(r.revenue);
    rawRevenue += raw;
    series.push({
      bucket: new Date(r.bucket).toISOString(),
      revenue: roundMoney(raw),
      orders: num(r.orders),
      refunds: 0,
    });
    totals.orders += num(r.orders);
    if (r.last_activity) {
      const iso = new Date(r.last_activity).toISOString();
      if (!totals.lastActivityAt || iso > totals.lastActivityAt) totals.lastActivityAt = iso;
    }
  }
  // Sum unrounded stored values, round once.
  totals.revenue = roundMoney(rawRevenue);

  const byStore = stores
    ? stores.rows.map((r) => ({
        store: r.store ?? "Unknown",
        revenue: roundMoney(num(r.revenue)),
        orders: num(r.orders),
      }))
    : undefined;

  return { totals, series, ...(byStore ? { byStore } : {}) };
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

router.get("/revenue-overview", async (req: Request, res: Response) => {
  const ownerId = workspace(req).workspaceOwnerId;
  const range = resolveRange(req.query.from, req.query.to);
  const comparison = parseComparison(req, range);
  const granularity = granularityFor(range);

  // Baseline for Channel Pulse: the selected comparison window, or (when no
  // comparison is selected) the previous period of equal length.
  const pulseRange = comparison.baseline ?? previousRange(range);

  // Memoized USD conversion via stored exchange rates.
  const rateCache = new Map<string, number | null>();
  const toUsd = async (currency: string | null): Promise<number | null> => {
    const cur = (currency ?? "USD").toUpperCase();
    if (cur === "USD" || cur === "") return 1;
    if (rateCache.has(cur)) return rateCache.get(cur) as number | null;
    let rate: number | null = null;
    try {
      // Exchange rates are stored globally, including owner-entered manual
      // rates and the seeded LBP rate.
      const stored = await getStoredRate(cur, "USD", "__global__");
      const candidate = stored?.rate;
      const plausibleLbpRate =
        cur !== "LBP" ||
        (candidate !== undefined &&
          candidate >= LBP_TO_USD_MIN &&
          candidate <= LBP_TO_USD_MAX);
      rate =
        candidate !== undefined &&
        Number.isFinite(candidate) &&
        candidate > 0 &&
        plausibleLbpRate
          ? candidate
          : null;
    } catch {
      rate = null;
    }
    rateCache.set(cur, rate);
    return rate;
  };

  const fetchStream = async (
    key: StreamKey,
    r: AnalyticsRange,
    g: Granularity,
    opts: { includeStores?: boolean } = {},
  ): Promise<
    StreamData & {
      cogs?: { cogsUsd: number; costedRevenueUsd: number };
      byStore?: TotersStoreBreakdown[];
    }
  > => {
    try {
      if (key === "ecommerce") return await fetchEcommerce(ownerId, r, g);
      if (key === "retail") return await fetchRetail(ownerId, r, g, toUsd);
      if (key === "toters") return await fetchToters(ownerId, r, g, opts);
      return await fetchCmc(ownerId, r, g);
    } catch (err) {
      req.log?.error?.({ err, stream: key }, "revenue-overview stream query failed");
      const totals = emptyStreamTotals();
      totals.available = false;
      totals.partialReason = `${STREAM_LABELS[key]} data is currently unavailable.`;
      return { totals, series: [] };
    }
  };

  try {
    // The baseline fetch serves both the selected comparison (when any) and
    // Channel Pulse (which falls back to the previous period).
    const [current, baseline] = await Promise.all([
      Promise.all(
        STREAM_KEYS.map((k) => fetchStream(k, range, granularity, { includeStores: true })),
      ),
      Promise.all(STREAM_KEYS.map((k) => fetchStream(k, pulseRange, granularity))),
    ]);

    const totalsByStream = {} as Record<StreamKey, StreamTotals>;
    const seriesByStream = {} as Record<StreamKey, StreamBucket[]>;
    const baselineByStream = {} as Record<StreamKey, StreamTotals>;
    let cogs = { cogsUsd: 0, costedRevenueUsd: 0 };
    let totersByStore: TotersStoreBreakdown[] = [];
    STREAM_KEYS.forEach((key, i) => {
      totalsByStream[key] = current[i].totals;
      seriesByStream[key] = current[i].series;
      baselineByStream[key] = baseline[i].totals;
      if (current[i].cogs) cogs = current[i].cogs as typeof cogs;
      if (key === "toters" && current[i].byStore) {
        totersByStore = current[i].byStore as TotersStoreBreakdown[];
      }
    });

    // Every stream contributed to the failure => hard error with retry.
    if (STREAM_KEYS.every((k) => !totalsByStream[k].available)) {
      return res.status(500).json({ error: "Failed to load revenue overview" });
    }

    const totalRevenue = roundMoney(
      STREAM_KEYS.reduce((s, k) => s + totalsByStream[k].revenue, 0),
    );
    const comparisonSelected = comparison.mode !== "none" && comparison.baseline !== null;
    const comparisonTotal = comparisonSelected
      ? roundMoney(STREAM_KEYS.reduce((s, k) => s + baselineByStream[k].revenue, 0))
      : null;

    const streams = STREAM_KEYS.map((key) => {
      const t = totalsByStream[key];
      const comparisonRevenue = comparisonSelected ? baselineByStream[key].revenue : null;
      return {
        key,
        label: STREAM_LABELS[key],
        revenue: t.revenue,
        orders: t.orders,
        refunds: t.refunds,
        shareOfTotal:
          totalRevenue > 0 ? Math.round((t.revenue / totalRevenue) * 1000) / 10 : 0,
        comparisonRevenue,
        changePct: comparisonSelected ? pctChange(t.revenue, comparisonRevenue) : null,
      };
    });

    const buckets = enumerateBuckets(range, granularity);
    const series = assembleSeries(buckets, seriesByStream);
    const snapshot = computeSnapshot(totalsByStream, cogs);

    const pulse = STREAM_KEYS.map((key) => {
      const base = baselineByStream[key];
      const p = computePulse(
        totalsByStream[key].revenue,
        base.available ? base.revenue : null,
      );
      return {
        stream: key,
        label: STREAM_LABELS[key],
        status: p.status,
        changePct: p.changePct,
        reason: p.reason,
        thresholds: {
          atRiskBelowPct: PULSE_THRESHOLDS.atRiskBelowPct,
          offTrackBelowPct: PULSE_THRESHOLDS.offTrackBelowPct,
        },
      };
    });

    const availability = STREAM_KEYS.map((key) => {
      const t = totalsByStream[key];
      return {
        stream: key,
        label: STREAM_LABELS[key],
        available: t.available,
        partial: t.partial,
        reason: t.partialReason,
        lastActivityAt: t.lastActivityAt,
      };
    });

    return res.json({
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      comparison: comparisonSelected
        ? {
            mode: comparison.mode,
            from: (comparison.baseline as AnalyticsRange).from.toISOString(),
            to: (comparison.baseline as AnalyticsRange).to.toISOString(),
          }
        : null,
      granularity,
      currency: "USD",
      generatedAt: new Date().toISOString(),
      totals: {
        totalRevenue,
        comparisonTotal,
        totalChangePct: comparisonSelected ? pctChange(totalRevenue, comparisonTotal) : null,
        streams,
      },
      series,
      snapshot,
      pulse,
      availability,
      totersByStore,
      definitions: REVENUE_DEFINITIONS,
    });
  } catch (err) {
    req.log?.error?.({ err }, "revenue-overview failed");
    return res.status(500).json({ error: "Failed to load revenue overview" });
  }
});

export default router;
