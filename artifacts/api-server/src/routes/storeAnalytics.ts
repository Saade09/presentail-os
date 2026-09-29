import { Router, type IRouter } from "express";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import { findCountryByCode, phoneCountrySql } from "../lib/defaults";
import {
  resolveRange,
  previousRange,
  parseComparison,
  buildPerformanceSummary,
  bucketFor,
  periodTypeFor,
  parseAnalyticsFilters,
  buildFilterConditions,
  cityMatchSql,
  prettifyCitySlug,
  num,
  NON_REVENUE_STATUSES,
  FUNNEL_STEPS,
  PRESENTAIL_FUNNEL_EVENTS,
  buildFunnelQuery,
  eventTypeInList,
  sqlQuote,
  buildTimeSlotBreakdown,
  classifyPunctuality,
  type TimeSlotRow,
  type AnalyticsRange,
  type AnalyticsFilters,
  type PeriodType,
} from "../lib/storeAnalytics";
import { getStoredRate } from "../lib/exchangeRateService";

const router: IRouter = Router();

router.use(requireAuth, resolveWorkspace);

// Comma-separated, single-quoted status list for SQL NOT IN clauses.
const NON_REVENUE_SQL = NON_REVENUE_STATUSES.map((s) => `'${s}'`).join(", ");

// Max punctuality drill-down rows returned to the client (summary counts are
// always computed over the full filtered set).
const PUNCTUALITY_LIST_LIMIT = 2000;

/**
 * Revenue for a single order in USD: prefer the summed payment `amount_usd`
 * (the USD equivalent of what the customer actually paid, incl. paid-currency
 * orders), else fall back to the order's stored USD total.
 */
const ORDER_REVENUE_USD = `COALESCE(pay.paid_usd, NULLIF(o.totals->>'total', '')::numeric, 0)`;

/**
 * Shared FROM/JOIN + WHERE for the filtered order set. Callers append their own
 * SELECT/aggregation. `pay` exposes `paid_usd` per order and the
 * ${ORDER_REVENUE_USD} expression is available as a computed revenue column.
 */
function filteredOrdersCte(
  ownerId: string,
  filters: AnalyticsFilters,
): { sql: string; params: unknown[] } {
  const { sql: filterSql, params: filterParams } = buildFilterConditions(
    filters,
    ownerId,
    4,
  );
  const sql = `
    WITH filtered AS (
      SELECT
        o.id,
        o.status,
        o.channel,
        o.ordered_at,
        o.delivery_address,
        ${ORDER_REVENUE_USD} AS revenue_usd
      FROM orders o
      LEFT JOIN (
        SELECT order_id, SUM(amount_usd) AS paid_usd
        FROM order_payment
        WHERE amount_usd IS NOT NULL
        GROUP BY order_id
      ) pay ON pay.order_id = o.id
      WHERE o.workspace_owner_id = $1
        AND o.ordered_at >= $2
        AND o.ordered_at < $3
        ${filterSql}
    )
  `;
  return { sql, params: filterParams };
}

type KpiRow = {
  total_all: string;
  valid_orders: string;
  total_revenue: string;
  cancelled_refunded: string;
  completed: string;
  concluded: string;
  total_cogs: string | null;
  total_line_revenue: string | null;
  costed_line_revenue: string | null;
};

export async function computeKpis(
  ownerId: string,
  range: AnalyticsRange,
  filters: AnalyticsFilters,
) {
  const { sql: cte, params: filterParams } = filteredOrdersCte(ownerId, filters);
  const params = [ownerId, range.from, range.to, ...filterParams];

  // COGS: per valid order, sum(quantity * product cogs) where the recipe yields
  // a fully-priced USD cost. One product is matched per line item to avoid
  // fan-out from name collisions.
  const sql = `
    ${cte},
    line_costs AS (
      SELECT
        SUM(li.quantity::numeric * cogs.cogs_usd)
          FILTER (WHERE cogs.cogs_usd IS NOT NULL) AS total_cost,
        SUM(li.line_total::numeric) AS total_line_revenue,
        SUM(li.line_total::numeric)
          FILTER (WHERE cogs.cogs_usd IS NOT NULL) AS costed_line_revenue
      FROM order_line_items li
      JOIN filtered f ON f.id = li.order_id AND f.status NOT IN (${NON_REVENUE_SQL})
      LEFT JOIN LATERAL (
        SELECT p.id, p.workspace_owner_id
        FROM products p
        WHERE p.workspace_owner_id = $1
          AND (
            lower(COALESCE(li.name, '')) = lower(p.name)
            OR (li.product_id IS NOT NULL AND li.product_id = p.id)
          )
        ORDER BY (li.product_id IS NOT NULL AND li.product_id = p.id) DESC
        LIMIT 1
      ) p ON true
      LEFT JOIN LATERAL (
        SELECT
          CASE
            WHEN COUNT(pr.base_item_id) = 0 THEN NULL
            WHEN COUNT(pr.base_item_id) FILTER (
              WHERE bis.price IS NOT NULL AND bis.currency = 'USD'
            ) = COUNT(pr.base_item_id)
            THEN SUM(pr.quantity::numeric * bis.price::numeric)
            ELSE NULL
          END AS cogs_usd
        FROM product_recipes pr
        LEFT JOIN base_item_suppliers bis
          ON bis.base_item_id = pr.base_item_id
         AND bis.workspace_owner_id = pr.workspace_owner_id
         AND bis.is_preferred = true
        WHERE pr.product_id = p.id
          AND pr.workspace_owner_id = p.workspace_owner_id
      ) cogs ON true
    )
    SELECT
      COUNT(*) AS total_all,
      COUNT(*) FILTER (WHERE status NOT IN (${NON_REVENUE_SQL})) AS valid_orders,
      COALESCE(SUM(revenue_usd) FILTER (WHERE status NOT IN (${NON_REVENUE_SQL})), 0) AS total_revenue,
      COUNT(*) FILTER (WHERE status IN ('cancelled', 'refunded')) AS cancelled_refunded,
      COUNT(*) FILTER (WHERE status = 'completed') AS completed,
      COUNT(*) FILTER (WHERE status IN ('completed', 'cancelled', 'refunded')) AS concluded,
      (SELECT total_cost FROM line_costs) AS total_cogs,
      (SELECT total_line_revenue FROM line_costs) AS total_line_revenue,
      (SELECT costed_line_revenue FROM line_costs) AS costed_line_revenue
    FROM filtered
  `;

  const result = await db.query<KpiRow>(sql, params);
  const r = result.rows[0];
  const totalRevenue = num(r?.total_revenue);
  const orders = parseInt(r?.valid_orders ?? "0", 10);
  const totalAll = parseInt(r?.total_all ?? "0", 10);
  const cancelledRefunded = parseInt(r?.cancelled_refunded ?? "0", 10);
  const completed = parseInt(r?.completed ?? "0", 10);
  const concluded = parseInt(r?.concluded ?? "0", 10);
  const totalCogs = r?.total_cogs != null ? num(r.total_cogs) : null;
  const totalLineRevenue = r?.total_line_revenue != null ? num(r.total_line_revenue) : 0;
  const costedLineRevenue =
    r?.costed_line_revenue != null ? num(r.costed_line_revenue) : 0;
  // Share of line-item revenue that has a fully-costed recipe behind it. Null
  // when no line revenue exists (nothing to cover).
  const cogsCoveragePct =
    totalLineRevenue > 0 ? (costedLineRevenue / totalLineRevenue) * 100 : null;

  const aov = orders > 0 ? totalRevenue / orders : 0;
  const grossMarginUsd = totalCogs != null ? totalRevenue - totalCogs : null;
  const grossMarginPct =
    grossMarginUsd != null && totalRevenue > 0
      ? (grossMarginUsd / totalRevenue) * 100
      : null;
  const cancellationRate = totalAll > 0 ? (cancelledRefunded / totalAll) * 100 : 0;
  const deliverySuccessRate = concluded > 0 ? (completed / concluded) * 100 : 0;

  return {
    totalRevenue,
    orders,
    aov,
    grossMarginUsd,
    grossMarginPct,
    cancellationRate,
    deliverySuccessRate,
    cogsCoveragePct,
  };
}

/**
 * Distinct storefront sessions in a window (honoring the shared web-event
 * filters). Used for the conversion-rate KPI; 0 means tracking is unavailable.
 */
async function countSessions(
  ownerId: string,
  range: AnalyticsRange,
  filters: AnalyticsFilters,
): Promise<number> {
  const we = webEventFilter(filters);
  const result = await db.query<{ sessions: string }>(
    `SELECT COUNT(DISTINCT session_id) AS sessions
     FROM web_events we
     WHERE we.workspace_owner_id = $1
       AND we.occurred_at >= $2
       AND we.occurred_at < $3
       AND we.session_id IS NOT NULL
       ${we.sql}`,
    [ownerId, range.from, range.to, ...we.params],
  );
  return parseInt(result.rows[0]?.sessions ?? "0", 10);
}

/**
 * Revenue broken down by natural period slots (hour/dow/dom/month) selected
 * automatically based on the range length. All slots are always emitted (filled
 * with 0) so the bar chart has a fixed-width axis.
 */
async function buildRevenueByPeriod(
  ownerId: string,
  range: AnalyticsRange,
  filters: AnalyticsFilters,
): Promise<{
  periodType: PeriodType;
  revenueByPeriod: { label: string; revenue: number; orders: number }[];
}> {
  const periodType = periodTypeFor(range);
  const { sql: cte, params: filterParams } = filteredOrdersCte(ownerId, filters);
  const baseParams = [ownerId, range.from, range.to, ...filterParams];

  const extractExpr =
    periodType === "hour"
      ? `EXTRACT(HOUR FROM ordered_at AT TIME ZONE 'UTC')`
      : periodType === "dow"
        ? `EXTRACT(DOW FROM ordered_at AT TIME ZONE 'UTC')`
        : periodType === "dom"
          ? `EXTRACT(DAY FROM ordered_at AT TIME ZONE 'UTC')`
          : `EXTRACT(MONTH FROM ordered_at AT TIME ZONE 'UTC')`;

  const result = await db.query<{ slot: string; revenue: string; orders: string }>(
    `${cte}
     SELECT
       ${extractExpr}::int AS slot,
       COALESCE(SUM(revenue_usd), 0) AS revenue,
       COUNT(*) AS orders
     FROM filtered
     WHERE status NOT IN (${NON_REVENUE_SQL})
     GROUP BY 1
     ORDER BY 1 ASC`,
    baseParams,
  );

  const bySlot = new Map(result.rows.map((r) => [parseInt(r.slot, 10), r]));

  const slots =
    periodType === "hour"
      ? Array.from({ length: 24 }, (_, i) => i)      // 0-23
      : periodType === "dow"
        ? Array.from({ length: 7 }, (_, i) => i)      // 0-6 (Sun=0)
        : periodType === "dom"
          ? Array.from({ length: 31 }, (_, i) => i + 1) // 1-31
          : Array.from({ length: 12 }, (_, i) => i + 1); // 1-12

  return {
    periodType,
    revenueByPeriod: slots.map((s) => ({
      label: String(s),
      revenue: num(bySlot.get(s)?.revenue),
      orders: parseInt(bySlot.get(s)?.orders ?? "0", 10),
    })),
  };
}

/**
 * GET /analytics/devices
 *
 * Lightweight endpoint that returns only the connected-device list and the
 * offline-alert threshold for the workspace. This is polled every 30 seconds
 * by the Analytics page device monitor; separating it from the full analytics
 * aggregation avoids running expensive multi-table order aggregations on each
 * poll.
 *
 * Response shape mirrors the `devices` + `offline_alert_threshold_minutes`
 * subset of `GET /analytics` so the frontend can switch without changing its
 * data-access types.
 */
router.get("/analytics/devices", async (req, res) => {
  const wreq = workspace(req);
  const ownerId = wreq.workspaceOwnerId;

  try {
    const [settingsResult, devicesResult] = await Promise.all([
      db.query<{ offline_alert_threshold_minutes: number }>(
        `SELECT offline_alert_threshold_minutes
           FROM workspace_settings
          WHERE workspace_owner_id = $1`,
        [ownerId],
      ),
      db.query<{ id: number; name: string; last_seen_at: string | null }>(
        `SELECT id, name, last_seen_at
           FROM devices
          WHERE user_id = $1
          ORDER BY last_seen_at DESC NULLS LAST`,
        [ownerId],
      ),
    ]);

    const thresholdMinutes: number =
      settingsResult.rowCount && settingsResult.rowCount > 0
        ? settingsResult.rows[0].offline_alert_threshold_minutes
        : 5;

    const thresholdMs = thresholdMinutes * 60 * 1000;
    const cutoff = new Date(Date.now() - thresholdMs);

    const devices = devicesResult.rows.map((d) => ({
      id: d.id,
      name: d.name,
      last_seen_at: d.last_seen_at,
      online: d.last_seen_at != null && new Date(d.last_seen_at) >= cutoff,
    }));

    res.json({ devices, offline_alert_threshold_minutes: thresholdMinutes });
  } catch (err) {
    req.log.error({ err }, "analytics/devices failed");
    res.status(500).json({ error: "Failed to fetch device status" });
  }
});

/**
 * GET /store-analytics/executive-overview
 *
 * Section 1 of the E-commerce Analytics page. Returns headline KPIs (with
 * previous-period figures for deltas when `compare=true`) plus the chart series
 * that make up the executive overview. All money is USD.
 */
router.get("/store-analytics/executive-overview", async (req, res) => {
  const wreq = workspace(req);
  const ownerId = wreq.workspaceOwnerId;

  const range = resolveRange(req.query.from, req.query.to);
  const comparison = parseComparison(req, range);
  const baseline = comparison.baseline;
  const filters = parseAnalyticsFilters(req);
  const bucket = bucketFor(range);

  const { sql: cte, params: filterParams } = filteredOrdersCte(ownerId, filters);
  const baseParams = [ownerId, range.from, range.to, ...filterParams];
  const baselineParams = baseline
    ? [ownerId, baseline.from, baseline.to, ...filterParams]
    : null;

  // Per-bucket revenue/orders trend for a window (shared by current + baseline).
  const overTimeSql = `${cte}
     SELECT
       date_trunc('${bucket}', ordered_at AT TIME ZONE 'UTC')::date::text AS bucket_date,
       COALESCE(SUM(revenue_usd), 0) AS revenue,
       COUNT(*) AS orders
     FROM filtered
     WHERE status NOT IN (${NON_REVENUE_SQL})
     GROUP BY 1
     ORDER BY 1 ASC`;

  // Per-bucket COGS (fully-costed recipes only) so gross-profit sparklines can
  // be derived per bucket. Mirrors the computeKpis line_costs join.
  const cogsOverTimeSql = `${cte}
     SELECT
       date_trunc('${bucket}', f.ordered_at AT TIME ZONE 'UTC')::date::text AS bucket_date,
       SUM(li.quantity::numeric * cogs.cogs_usd)
         FILTER (WHERE cogs.cogs_usd IS NOT NULL) AS cogs
     FROM order_line_items li
     JOIN filtered f ON f.id = li.order_id AND f.status NOT IN (${NON_REVENUE_SQL})
     LEFT JOIN LATERAL (
       SELECT p.id, p.workspace_owner_id
       FROM products p
       WHERE p.workspace_owner_id = $1
         AND (
           lower(COALESCE(li.name, '')) = lower(p.name)
           OR (li.product_id IS NOT NULL AND li.product_id = p.id)
         )
       ORDER BY (li.product_id IS NOT NULL AND li.product_id = p.id) DESC
       LIMIT 1
     ) p ON true
     LEFT JOIN LATERAL (
       SELECT
         CASE
           WHEN COUNT(pr.base_item_id) = 0 THEN NULL
           WHEN COUNT(pr.base_item_id) FILTER (
             WHERE bis.price IS NOT NULL AND bis.currency = 'USD'
           ) = COUNT(pr.base_item_id)
           THEN SUM(pr.quantity::numeric * bis.price::numeric)
           ELSE NULL
         END AS cogs_usd
       FROM product_recipes pr
       LEFT JOIN base_item_suppliers bis
         ON bis.base_item_id = pr.base_item_id
        AND bis.workspace_owner_id = pr.workspace_owner_id
        AND bis.is_preferred = true
       WHERE pr.product_id = p.id
         AND pr.workspace_owner_id = p.workspace_owner_id
     ) cogs ON true
     GROUP BY 1
     ORDER BY 1 ASC`;

  const we = webEventFilter(filters);

  try {
    const [
      kpisRaw,
      previousKpisRaw,
      curSessions,
      baseSessions,
      comparisonOverTimeResult,
      cogsOverTimeResult,
      overTimeResult,
      periodBreakdown,
      byChannelResult,
      byCityResult,
      byCountryResult,
      occasionsResult,
      newReturningResult,
      deviceResult,
      sessionsByCountryResult,
    ] = await Promise.all([
      computeKpis(ownerId, range, filters),
      baseline ? computeKpis(ownerId, baseline, filters) : Promise.resolve(null),
      countSessions(ownerId, range, filters),
      baseline ? countSessions(ownerId, baseline, filters) : Promise.resolve(0),

      // Baseline revenue over time (comparison series)
      baselineParams
        ? db.query<{ bucket_date: string; revenue: string; orders: string }>(
            overTimeSql,
            baselineParams,
          )
        : Promise.resolve(null),

      // Per-bucket COGS for gross-profit sparklines
      db.query<{ bucket_date: string; cogs: string | null }>(
        cogsOverTimeSql,
        baseParams,
      ),

      // Revenue over time
      db.query<{ bucket_date: string; revenue: string; orders: string }>(
        overTimeSql,
        baseParams,
      ),

      // Revenue by period (hour/dow/dom/month breakdown)
      buildRevenueByPeriod(ownerId, range, filters),

      // Revenue by channel
      db.query<{ channel: string | null; revenue: string; orders: string }>(
        `${cte}
         SELECT
           COALESCE(NULLIF(channel, ''), 'Unknown') AS channel,
           COALESCE(SUM(revenue_usd), 0) AS revenue,
           COUNT(*) AS orders
         FROM filtered
         WHERE status NOT IN (${NON_REVENUE_SQL})
         GROUP BY 1
         ORDER BY 2 DESC`,
        baseParams,
      ),

      // Revenue by city (resolve city name via delivery_cities)
      db.query<{ city_id: string | null; name: string | null; revenue: string; orders: string }>(
        `${cte}
         SELECT
           COALESCE(dc.id::text, f.delivery_address->>'cityId') AS city_id,
           dc.name AS name,
           COALESCE(SUM(f.revenue_usd), 0) AS revenue,
           COUNT(*) AS orders
         FROM filtered f
         LEFT JOIN delivery_cities dc
           ON dc.workspace_owner_id = $1
          AND ${cityMatchSql(`f.delivery_address->>'cityId'`)}
         WHERE f.status NOT IN (${NON_REVENUE_SQL})
         GROUP BY 1, 2
         ORDER BY 3 DESC`,
        baseParams,
      ),

      // Revenue by country — grouped by buyer's phone country (dial-code-derived)
      db.query<{ country_code: string | null; revenue: string; orders: string }>(
        `${cte}
         SELECT
           ${phoneCountrySql("cust.phone")} AS country_code,
           COALESCE(SUM(f.revenue_usd), 0) AS revenue,
           COUNT(*) AS orders
         FROM filtered f
         LEFT JOIN LATERAL (
           SELECT ct.phone
             FROM order_contacts oc
             JOIN contacts ct ON ct.id = oc.contact_id
            WHERE oc.order_id = f.id AND oc.role = 'customer'
            ORDER BY oc.contact_id ASC
            LIMIT 1
         ) cust ON true
         WHERE f.status NOT IN (${NON_REVENUE_SQL})
         GROUP BY 1
         ORDER BY 2 DESC`,
        baseParams,
      ),

      // Top occasions (line-item revenue attributed via product occasions)
      db.query<{ name: string; revenue: string; orders: string }>(
        `${cte}
         SELECT
           occ.name AS name,
           COALESCE(SUM(li.line_total::numeric), 0) AS revenue,
           COUNT(DISTINCT li.order_id) AS orders
         FROM order_line_items li
         JOIN filtered f ON f.id = li.order_id AND f.status NOT IN (${NON_REVENUE_SQL})
         JOIN LATERAL (
           SELECT p.id
           FROM products p
           WHERE p.workspace_owner_id = $1
             AND (
               lower(COALESCE(li.name, '')) = lower(p.name)
               OR (li.product_id IS NOT NULL AND li.product_id = p.id)
             )
           ORDER BY (li.product_id IS NOT NULL AND li.product_id = p.id) DESC
           LIMIT 1
         ) p ON true
         JOIN product_occasions po ON po.product_id = p.id
         JOIN occasions occ ON occ.id = po.attribute_id
         GROUP BY occ.name
         ORDER BY 2 DESC
         LIMIT 10`,
        baseParams,
      ),

      // New vs returning customers (based on the buyer contact's prior orders)
      db.query<{ new_count: string; returning_count: string }>(
        `${cte}
         SELECT
           COUNT(*) FILTER (WHERE NOT is_returning) AS new_count,
           COUNT(*) FILTER (WHERE is_returning) AS returning_count
         FROM (
           SELECT DISTINCT ON (f.id)
             f.id,
             EXISTS (
               SELECT 1
               FROM order_contacts oc2
               JOIN orders o2 ON o2.id = oc2.order_id
               WHERE oc2.contact_id = oc.contact_id
                 AND oc2.role = 'customer'
                 AND o2.workspace_owner_id = $1
                 AND o2.ordered_at < f.ordered_at
             ) AS is_returning
           FROM filtered f
           JOIN order_contacts oc ON oc.order_id = f.id AND oc.role = 'customer'
           WHERE f.status NOT IN (${NON_REVENUE_SQL})
           ORDER BY f.id
         ) x`,
        baseParams,
      ),

      // Orders by device — counts purchase-type web events grouped by device_type.
      // Only brand filter applies (country/city/channel are order-side dimensions
      // not recorded on web events).
      db.query<{ device_type: string; cnt: string }>(
        `SELECT we.device_type, COUNT(*) AS cnt
         FROM web_events we
         WHERE we.workspace_owner_id = $1
           AND we.occurred_at >= $2
           AND we.occurred_at < $3
           AND we.event_type IN ('payment_completed', 'order_created', 'purchase')
           AND we.device_type IS NOT NULL
           ${we.sql}
         GROUP BY we.device_type
         ORDER BY cnt DESC`,
        [ownerId, range.from, range.to, ...we.params],
      ),

      // Per-visitor-country session counts for per-country conversion rate
      db.query<{ country_code: string; sessions: string }>(
        `SELECT
           LOWER(we.country) AS country_code,
           COUNT(DISTINCT we.session_id) AS sessions
         FROM web_events we
         WHERE we.workspace_owner_id = $1
           AND we.occurred_at >= $2
           AND we.occurred_at < $3
           AND we.session_id IS NOT NULL
           AND we.country IS NOT NULL
           AND we.country <> ''
           ${we.sql}
         GROUP BY 1`,
        [ownerId, range.from, range.to, ...we.params],
      ),
    ]);

    // Build a Map from visitor-country string (lowercased) → session count.
    const sessionsByCountry = new Map<string, number>();
    for (const row of sessionsByCountryResult.rows) {
      if (row.country_code) {
        sessionsByCountry.set(row.country_code, parseInt(row.sessions, 10));
      }
    }

    const revenueByCountry = byCountryResult.rows.map((r) => {
      const orders = parseInt(r.orders, 10);
      const revenue = num(r.revenue);
      const countryName = r.country_code
        ? findCountryByCode(r.country_code)?.name ?? r.country_code
        : "Unknown";
      const codeKey = r.country_code?.toLowerCase() ?? "";
      const nameKey = countryName.toLowerCase();
      const sessions =
        (codeKey ? sessionsByCountry.get(codeKey) : undefined) ??
        sessionsByCountry.get(nameKey) ??
        null;
      const conversionRatePct =
        sessions != null && sessions > 0
          ? Math.round((orders / sessions) * 10000) / 100
          : null;
      return {
        code: r.country_code,
        name: countryName,
        revenue,
        orders,
        aov: orders > 0 ? Math.round((revenue / orders) * 100) / 100 : 0,
        conversionRatePct,
      };
    });

    const nrRow = newReturningResult.rows[0];

    // Conversion rate = orders / distinct storefront sessions, when tracked.
    const kpis = {
      ...kpisRaw,
      conversionRate: curSessions > 0 ? (kpisRaw.orders / curSessions) * 100 : null,
    };
    const previousKpis = previousKpisRaw
      ? {
          ...previousKpisRaw,
          conversionRate:
            baseSessions > 0 ? (previousKpisRaw.orders / baseSessions) * 100 : null,
        }
      : null;

    const cogsByBucket = new Map(
      cogsOverTimeResult.rows.map((r) => [
        r.bucket_date,
        r.cogs != null ? num(r.cogs) : null,
      ]),
    );

    res.json({
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      comparison: baseline
        ? { from: baseline.from.toISOString(), to: baseline.to.toISOString() }
        : null,
      comparisonMode: comparison.mode,
      bucket,
      kpis,
      previousKpis,
      revenueOverTime: overTimeResult.rows.map((r) => ({
        date: r.bucket_date,
        revenue: num(r.revenue),
        orders: parseInt(r.orders, 10),
        cogs: cogsByBucket.get(r.bucket_date) ?? null,
      })),
      comparisonRevenueOverTime: comparisonOverTimeResult
        ? comparisonOverTimeResult.rows.map((r) => ({
            date: r.bucket_date,
            revenue: num(r.revenue),
            orders: parseInt(r.orders, 10),
          }))
        : null,
      revenueByChannel: byChannelResult.rows.map((r) => ({
        name: r.channel ?? "Unknown",
        revenue: num(r.revenue),
        orders: parseInt(r.orders, 10),
      })),
      revenueByCity: byCityResult.rows.map((r) => ({
        name: r.name ?? prettifyCitySlug(r.city_id) ?? "Unknown",
        revenue: num(r.revenue),
        orders: parseInt(r.orders, 10),
      })),
      revenueByCountry,
      topOccasions: occasionsResult.rows.map((r) => ({
        name: r.name,
        revenue: num(r.revenue),
        orders: parseInt(r.orders, 10),
      })),
      newVsReturning: {
        new: parseInt(nrRow?.new_count ?? "0", 10),
        returning: parseInt(nrRow?.returning_count ?? "0", 10),
      },
      ordersByDevice: (() => {
        const items = deviceResult.rows.map((r) => ({
          name:
            r.device_type === "mobile"
              ? "Mobile"
              : r.device_type === "desktop"
                ? "Desktop"
                : r.device_type === "tablet"
                  ? "Tablet"
                  : r.device_type.charAt(0).toUpperCase() + r.device_type.slice(1).toLowerCase(),
          orders: parseInt(r.cnt, 10),
        }));
        return { tracked: items.length > 0, items };
      })(),
      revenueByPeriod: periodBreakdown.revenueByPeriod,
      periodType: periodBreakdown.periodType,
      conversionRateTracked: curSessions > 0,
      insights: [] as { level: string; message: string }[],
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    req.log.error({ err }, "store-analytics executive-overview failed");
    res.status(500).json({ error: "Failed to compute analytics" });
  }
});

/**
 * Per-order delivery fee in USD. Prefer the explicitly-USD `feeUsd` recorded on
 * the delivery address; missing/blank means a free (zero-fee) delivery.
 */
const ORDER_DELIVERY_FEE_USD = `COALESCE(NULLIF(o.delivery_address->>'feeUsd', '')::numeric, 0)`;

/**
 * WHERE fragment + params for website-event queries. Web events only carry a
 * `brand` dimension that maps to the shared filters; country/city/channel are
 * order-side dimensions that web events don't record, so they intentionally
 * apply to order/payment metrics only. Placeholders start at $4.
 */
function webEventFilter(filters: AnalyticsFilters): {
  sql: string;
  params: unknown[];
} {
  if (filters.brand) {
    return { sql: `AND lower(we.brand) = lower($4)`, params: [filters.brand] };
  }
  return { sql: "", params: [] };
}

/**
 * Net-revenue components for one window. Net revenue is SUM(revenue_usd) over
 * the exact same filtered order set as the headline KPI, so the breakdown
 * reconciles to the headline by construction:
 *   netRevenue = grossProductSales + deliveryFees − discounts − refunds
 * (grossProductSales is derived as netRevenue − deliveryFees + discounts;
 * refunds are always 0 because refunded/cancelled orders are excluded from
 * net revenue entirely — surfaced as refundsAvailable=false).
 */
async function computeNetRevenueBreakdown(
  ownerId: string,
  range: AnalyticsRange,
  filters: AnalyticsFilters,
) {
  const { sql: cte, params: filterParams } = filteredOrdersCte(ownerId, filters);
  // Re-join orders to read delivery fee + discount off the raw row.
  const result = await db.query<{
    net_revenue: string;
    delivery_fees: string;
    discounts: string;
    orders: string;
  }>(
    `${cte}
     SELECT
       COALESCE(SUM(f.revenue_usd), 0) AS net_revenue,
       COALESCE(SUM(${ORDER_DELIVERY_FEE_USD}), 0) AS delivery_fees,
       COALESCE(SUM(COALESCE(NULLIF(o.totals->>'discount', '')::numeric, 0)), 0) AS discounts,
       COUNT(*) AS orders
     FROM filtered f
     JOIN orders o ON o.id = f.id
     WHERE f.status NOT IN (${NON_REVENUE_SQL})`,
    [ownerId, range.from, range.to, ...filterParams],
  );
  const row = result.rows[0];
  const netRevenue = num(row?.net_revenue ?? 0);
  const deliveryFees = num(row?.delivery_fees ?? 0);
  const discounts = num(row?.discounts ?? 0);
  return {
    netRevenue,
    deliveryFees,
    discounts,
    refunds: 0,
    grossProductSales: netRevenue - deliveryFees + discounts,
    orders: parseInt(row?.orders ?? "0", 10),
  };
}

/**
 * GET /store-analytics/net-revenue-breakdown
 *
 * Reconciliation drawer behind the Net revenue KPI. Components sum exactly to
 * the headline net revenue for the same window/filters/basis.
 */
router.get("/store-analytics/net-revenue-breakdown", async (req, res) => {
  const wreq = workspace(req);
  const ownerId = wreq.workspaceOwnerId;

  const range = resolveRange(req.query.from, req.query.to);
  const comparison = parseComparison(req, range);
  const filters = parseAnalyticsFilters(req);

  try {
    const [components, baselineComponents] = await Promise.all([
      computeNetRevenueBreakdown(ownerId, range, filters),
      comparison.baseline
        ? computeNetRevenueBreakdown(ownerId, comparison.baseline, filters)
        : Promise.resolve(null),
    ]);
    res.json({
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      comparison: comparison.baseline
        ? {
            from: comparison.baseline.from.toISOString(),
            to: comparison.baseline.to.toISOString(),
          }
        : null,
      comparisonMode: comparison.mode,
      currency: "USD",
      // Refunds after completion are not captured as a separate money flow;
      // cancelled/refunded orders are excluded from net revenue entirely.
      refundsAvailable: false,
      excludedStatuses: [...NON_REVENUE_STATUSES],
      components,
      baselineComponents,
    });
  } catch (err) {
    req.log.error({ err }, "store-analytics net-revenue-breakdown failed");
    res.status(500).json({ error: "Failed to compute analytics" });
  }
});

/**
 * GET /store-analytics/performance-summary
 *
 * Deterministic executive summary. All figures are computed from the same KPI
 * aggregates as the overview (no generated/invented numbers); the response
 * carries structured codes + values and the frontend renders localized copy.
 */
router.get("/store-analytics/performance-summary", async (req, res) => {
  const wreq = workspace(req);
  const ownerId = wreq.workspaceOwnerId;

  const range = resolveRange(req.query.from, req.query.to);
  const comparison = parseComparison(req, range);
  const filters = parseAnalyticsFilters(req);

  try {
    const [current, baseline] = await Promise.all([
      computeKpis(ownerId, range, filters),
      comparison.baseline
        ? computeKpis(ownerId, comparison.baseline, filters)
        : Promise.resolve(null),
    ]);
    const summary = buildPerformanceSummary(current, baseline);
    res.json({
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      comparison: comparison.baseline
        ? {
            from: comparison.baseline.from.toISOString(),
            to: comparison.baseline.to.toISOString(),
          }
        : null,
      comparisonMode: comparison.mode,
      ...summary,
    });
  } catch (err) {
    req.log.error({ err }, "store-analytics performance-summary failed");
    res.status(500).json({ error: "Failed to compute analytics" });
  }
});

/**
 * GET /store-analytics/cart-checkout
 *
 * Section 6 of the E-commerce Analytics page. Combines website-event behaviour
 * (cart/checkout funnel, abandonment, promo events, free-delivery bar,
 * drop-off by city/slot, delivery-fee→conversion) — gated behind
 * `eventsTracked` — with order/payment-derived metrics (payment failures by
 * provider, delivery-fee impact, AOV by free delivery, payment-link orders)
 * that are always available. All money is USD.
 */
router.get("/store-analytics/cart-checkout", async (req, res) => {
  const wreq = workspace(req);
  const ownerId = wreq.workspaceOwnerId;

  const range = resolveRange(req.query.from, req.query.to);
  const compare = req.query.compare === "true" || req.query.compare === "1";
  const filters = parseAnalyticsFilters(req);
  const bucket = bucketFor(range);

  const { sql: cte, params: filterParams } = filteredOrdersCte(ownerId, filters);
  const baseParams = [ownerId, range.from, range.to, ...filterParams];

  const { sql: weFilterSql, params: weFilterParams } = webEventFilter(filters);
  const weBase = [ownerId, range.from, range.to, ...weFilterParams];

  try {
    // Free-delivery threshold (USD). Prefer the global setting; 0/absent means
    // the free-delivery bar behaviour cannot be inferred.
    const thresholdRow = await db.query<{ threshold: string | null }>(
      `SELECT global_free_delivery_threshold AS threshold
         FROM delivery_settings
        WHERE workspace_owner_id = $1
        LIMIT 1`,
      [ownerId],
    );
    const thresholdUsd = num(thresholdRow.rows[0]?.threshold);
    const thresholdParam = thresholdUsd > 0 ? thresholdUsd : 0;

    // Cart values (add_to_cart `value`) may arrive in the customer's own
    // currency. Convert each to USD via the workspace's stored FX rates so the
    // free-delivery-bar (compared against the USD threshold) and average-cart
    // figures stay consistent. Only these two website-event charts depend on
    // the amount; the delivery-fee→conversion chart only buckets free vs paid,
    // so it is currency-agnostic and needs no conversion.
    const cartCurrencies = await db.query<{ cur: string }>(
      `SELECT DISTINCT upper(COALESCE(NULLIF(we.currency, ''), 'USD')) AS cur
         FROM web_events we
        WHERE we.workspace_owner_id = $1
          AND we.occurred_at >= $2
          AND we.occurred_at < $3
          AND we.event_type = 'add_to_cart'
          AND we.value IS NOT NULL`,
      [ownerId, range.from, range.to],
    );
    const fxPairs: Array<[string, number]> = [];
    for (const { cur } of cartCurrencies.rows) {
      // Only ISO-style 3-letter codes are accepted, both to guard the literal
      // SQL interpolation below and because FX rates are keyed by such codes.
      if (!/^[A-Z]{3}$/.test(cur)) continue;
      if (cur === "USD") {
        fxPairs.push(["USD", 1]);
        continue;
      }
      const rate = await getStoredRate(cur, "USD", ownerId);
      if (rate && Number.isFinite(rate.rate) && rate.rate > 0) {
        fxPairs.push([cur, rate.rate]);
      }
    }
    if (!fxPairs.some(([c]) => c === "USD")) fxPairs.push(["USD", 1]);
    // (currency → rate-to-USD) lookup. Unknown/unconvertible currencies fall
    // back to a rate of 1 via COALESCE at the join (best-effort). `rate` is a
    // server-derived number; `cur` is validated to [A-Z]{3} above.
    const fxCte = `fx(cur, rate) AS (VALUES ${fxPairs
      .map(([c, r]) => `('${c}', '${r}'::numeric)`)
      .join(", ")})`;

    const [
      funnelResult,
      avgCartResult,
      promoEventsResult,
      promoOrdersResult,
      promoTopResult,
      dropoffCityResult,
      dropoffSlotResult,
      conversionFeeResult,
      paymentFailureResult,
      deliveryFeeResult,
      aovResult,
      paymentLinksResult,
    ] = await Promise.all([
      // Session funnel + free-delivery-bar behaviour (website events).
      db.query<{
        sessions: string;
        product_views: string;
        added_to_cart: string;
        reached_checkout: string;
        payment_completed: string;
        below_threshold: string;
        added_after_bar: string;
      }>(
        `WITH ${fxCte},
         sess AS (
           SELECT
             we.session_id,
             bool_or(we.event_type = 'product_view') AS viewed,
             bool_or(we.event_type = 'add_to_cart') AS added,
             bool_or(we.event_type IN ('checkout_step', 'payment_started')) AS reached,
             bool_or(we.event_type = 'payment_completed') AS completed,
             max(we.value * COALESCE(fx.rate, 1)) FILTER (WHERE we.event_type = 'add_to_cart') AS max_cart,
             count(*) FILTER (WHERE we.event_type = 'add_to_cart') AS add_count
           FROM web_events we
           LEFT JOIN fx ON fx.cur = upper(COALESCE(NULLIF(we.currency, ''), 'USD'))
           WHERE we.workspace_owner_id = $1
             AND we.occurred_at >= $2
             AND we.occurred_at < $3
             AND we.session_id IS NOT NULL
             ${weFilterSql}
           GROUP BY we.session_id
         )
         SELECT
           COUNT(*) AS sessions,
           COUNT(*) FILTER (WHERE viewed) AS product_views,
           COUNT(*) FILTER (WHERE added) AS added_to_cart,
           COUNT(*) FILTER (WHERE reached) AS reached_checkout,
           COUNT(*) FILTER (WHERE completed) AS payment_completed,
           COUNT(*) FILTER (
             WHERE ${thresholdParam} > 0 AND max_cart IS NOT NULL AND max_cart < ${thresholdParam}
           ) AS below_threshold,
           COUNT(*) FILTER (
             WHERE ${thresholdParam} > 0 AND add_count >= 2 AND max_cart IS NOT NULL AND max_cart < ${thresholdParam}
           ) AS added_after_bar
         FROM sess`,
        weBase,
      ),

      // Average add-to-cart event value (website events).
      db.query<{ avg_cart: string | null }>(
        `WITH ${fxCte}
         SELECT AVG(we.value * COALESCE(fx.rate, 1)) AS avg_cart
           FROM web_events we
           LEFT JOIN fx ON fx.cur = upper(COALESCE(NULLIF(we.currency, ''), 'USD'))
          WHERE we.workspace_owner_id = $1
            AND we.occurred_at >= $2
            AND we.occurred_at < $3
            AND we.event_type = 'add_to_cart'
            AND we.value IS NOT NULL
            ${weFilterSql}`,
        weBase,
      ),

      // Promo apply/fail event counts (website events).
      db.query<{ applied: string; failed: string }>(
        `SELECT
           COUNT(*) FILTER (WHERE we.event_type = 'promo_applied') AS applied,
           COUNT(*) FILTER (WHERE we.event_type = 'promo_failed') AS failed
         FROM web_events we
         WHERE we.workspace_owner_id = $1
           AND we.occurred_at >= $2
           AND we.occurred_at < $3
           AND we.event_type IN ('promo_applied', 'promo_failed')
           ${weFilterSql}`,
        weBase,
      ),

      // Coupon redemptions on orders (order-derived).
      db.query<{ redeemed: string; discount: string }>(
        `${cte}
         SELECT
           COUNT(*) AS redeemed,
           COALESCE(SUM(cr.discount_amount_usd), 0) AS discount
         FROM coupon_redemptions cr
         JOIN filtered f ON f.id = cr.order_id`,
        baseParams,
      ),

      // Top redeemed coupon codes (order-derived).
      db.query<{ name: string; count: string }>(
        `${cte}
         SELECT c.code AS name, COUNT(*) AS count
         FROM coupon_redemptions cr
         JOIN filtered f ON f.id = cr.order_id
         JOIN coupons c ON c.id = cr.coupon_id
         GROUP BY c.code
         ORDER BY 2 DESC
         LIMIT 10`,
        baseParams,
      ),

      // Checkout drop-off by city (website events).
      db.query<{ name: string; reached: string; completed: string }>(
        `WITH sess AS (
           SELECT
             we.session_id,
             max(we.city) AS city,
             bool_or(we.event_type IN ('checkout_step', 'payment_started')) AS reached,
             bool_or(we.event_type = 'payment_completed') AS completed
           FROM web_events we
           WHERE we.workspace_owner_id = $1
             AND we.occurred_at >= $2
             AND we.occurred_at < $3
             AND we.session_id IS NOT NULL
             ${weFilterSql}
           GROUP BY we.session_id
         )
         SELECT
           COALESCE(NULLIF(city, ''), 'Unknown') AS name,
           COUNT(*) FILTER (WHERE reached) AS reached,
           COUNT(*) FILTER (WHERE completed) AS completed
         FROM sess
         WHERE reached
         GROUP BY 1
         ORDER BY 2 DESC
         LIMIT 10`,
        weBase,
      ),

      // Checkout drop-off by delivery slot (website events; from properties.slot).
      db.query<{ name: string; reached: string; completed: string }>(
        `WITH sess AS (
           SELECT
             we.session_id,
             max(we.properties->>'slot') AS slot,
             bool_or(we.event_type IN ('checkout_step', 'payment_started')) AS reached,
             bool_or(we.event_type = 'payment_completed') AS completed
           FROM web_events we
           WHERE we.workspace_owner_id = $1
             AND we.occurred_at >= $2
             AND we.occurred_at < $3
             AND we.session_id IS NOT NULL
             ${weFilterSql}
           GROUP BY we.session_id
         )
         SELECT
           COALESCE(NULLIF(slot, ''), 'Unknown') AS name,
           COUNT(*) FILTER (WHERE reached) AS reached,
           COUNT(*) FILTER (WHERE completed) AS completed
         FROM sess
         WHERE reached
         GROUP BY 1
         ORDER BY 2 DESC
         LIMIT 10`,
        weBase,
      ),

      // Delivery-fee → conversion (website events; from properties.deliveryFee).
      db.query<{ bucket: string; sessions: string; completed: string }>(
        `WITH sess AS (
           SELECT
             we.session_id,
             max(
               CASE WHEN we.properties->>'deliveryFee' ~ '^[0-9]+(\\.[0-9]+)?$'
                 THEN (we.properties->>'deliveryFee')::numeric END
             ) AS fee,
             bool_or(we.event_type IN ('checkout_step', 'payment_started')) AS reached,
             bool_or(we.event_type = 'payment_completed') AS completed
           FROM web_events we
           WHERE we.workspace_owner_id = $1
             AND we.occurred_at >= $2
             AND we.occurred_at < $3
             AND we.session_id IS NOT NULL
             ${weFilterSql}
           GROUP BY we.session_id
         )
         SELECT
           CASE WHEN COALESCE(fee, 0) = 0 THEN 'free' ELSE 'paid' END AS bucket,
           COUNT(*) AS sessions,
           COUNT(*) FILTER (WHERE completed) AS completed
         FROM sess
         WHERE reached
         GROUP BY 1`,
        weBase,
      ),

      // Payment failures by provider (order-derived).
      db.query<{
        provider: string;
        failed: string;
        paid: string;
        lost: string;
      }>(
        `${cte}
         SELECT
           COALESCE(NULLIF(op.provider, ''), 'unknown') AS provider,
           COUNT(*) FILTER (WHERE op.status = 'failed') AS failed,
           COUNT(*) FILTER (WHERE op.status = 'paid') AS paid,
           COALESCE(SUM(op.amount_usd) FILTER (WHERE op.status = 'failed'), 0) AS lost
         FROM order_payment op
         JOIN filtered f ON f.id = op.order_id
         WHERE op.status IN ('failed', 'paid')
         GROUP BY 1
         ORDER BY 2 DESC`,
        baseParams,
      ),

      // Delivery-fee stats over valid orders (order-derived).
      db.query<{
        valid_orders: string;
        free_orders: string;
        paid_orders: string;
        avg_fee: string | null;
      }>(
        `${cte},
         d AS (
           SELECT
             ${ORDER_DELIVERY_FEE_USD} AS fee
           FROM orders o
           JOIN filtered f ON f.id = o.id AND f.status NOT IN (${NON_REVENUE_SQL})
         )
         SELECT
           COUNT(*) AS valid_orders,
           COUNT(*) FILTER (WHERE fee = 0) AS free_orders,
           COUNT(*) FILTER (WHERE fee > 0) AS paid_orders,
           AVG(fee) FILTER (WHERE fee > 0) AS avg_fee
         FROM d`,
        baseParams,
      ),

      // AOV by free vs paid delivery (order-derived).
      db.query<{
        free_orders: string;
        free_rev: string;
        paid_orders: string;
        paid_rev: string;
      }>(
        `${cte},
         d AS (
           SELECT
             f.revenue_usd,
             ${ORDER_DELIVERY_FEE_USD} AS fee
           FROM orders o
           JOIN filtered f ON f.id = o.id AND f.status NOT IN (${NON_REVENUE_SQL})
         )
         SELECT
           COUNT(*) FILTER (WHERE fee = 0) AS free_orders,
           COALESCE(SUM(revenue_usd) FILTER (WHERE fee = 0), 0) AS free_rev,
           COUNT(*) FILTER (WHERE fee > 0) AS paid_orders,
           COALESCE(SUM(revenue_usd) FILTER (WHERE fee > 0), 0) AS paid_rev
         FROM d`,
        baseParams,
      ),

      // Payment-link orders (created in window; paid revenue in USD only).
      db.query<{ created: string; paid: string; paid_rev: string }>(
        `SELECT
           COUNT(*) AS created,
           COUNT(*) FILTER (WHERE status = 'paid') AS paid,
           COALESCE(
             SUM(amount) FILTER (WHERE status = 'paid' AND upper(currency) = 'USD'),
             0
           ) / 100.0 AS paid_rev
         FROM payment_links
         WHERE workspace_owner_id = $1
           AND created_at >= $2
           AND created_at < $3`,
        [ownerId, range.from, range.to],
      ),
    ]);

    const fr = funnelResult.rows[0];
    const addedToCart = parseInt(fr?.added_to_cart ?? "0", 10);
    const reachedCheckout = parseInt(fr?.reached_checkout ?? "0", 10);
    const paymentCompleted = parseInt(fr?.payment_completed ?? "0", 10);
    const sessions = parseInt(fr?.sessions ?? "0", 10);
    const eventsTracked = sessions > 0;

    const cartAbandonmentRate =
      addedToCart > 0 ? ((addedToCart - reachedCheckout) / addedToCart) * 100 : 0;
    const checkoutAbandonmentRate =
      reachedCheckout > 0
        ? ((reachedCheckout - paymentCompleted) / reachedCheckout) * 100
        : 0;

    const pf = paymentFailureResult.rows;
    const totalFailed = pf.reduce((s, r) => s + parseInt(r.failed, 10), 0);
    const totalPaid = pf.reduce((s, r) => s + parseInt(r.paid, 10), 0);
    const paymentFailureRate =
      totalFailed + totalPaid > 0
        ? (totalFailed / (totalFailed + totalPaid)) * 100
        : 0;
    const revenueLostToPaymentFailureUsd = pf.reduce(
      (s, r) => s + num(r.lost),
      0,
    );

    const df = deliveryFeeResult.rows[0];
    const validOrders = parseInt(df?.valid_orders ?? "0", 10);
    const freeDeliveryOrders = parseInt(df?.free_orders ?? "0", 10);
    const paidDeliveryOrders = parseInt(df?.paid_orders ?? "0", 10);

    const av = aovResult.rows[0];
    const aovFreeOrders = parseInt(av?.free_orders ?? "0", 10);
    const aovPaidOrders = parseInt(av?.paid_orders ?? "0", 10);

    const pl = paymentLinksResult.rows[0];

    const dropoff = (r: { name: string; reached: string; completed: string }) => {
      const reached = parseInt(r.reached, 10);
      const completed = parseInt(r.completed, 10);
      return {
        name: r.name,
        reached,
        completed,
        dropoffRate: reached > 0 ? ((reached - completed) / reached) * 100 : 0,
      };
    };

    res.json({
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      comparison: compare
        ? (() => {
            const p = previousRange(range);
            return { from: p.from.toISOString(), to: p.to.toISOString() };
          })()
        : null,
      bucket,
      eventsTracked,
      funnel: {
        sessions,
        productViews: parseInt(fr?.product_views ?? "0", 10),
        addedToCart,
        reachedCheckout,
        paymentCompleted,
      },
      rates: {
        cartAbandonmentRate,
        checkoutAbandonmentRate,
        averageCartValueUsd: num(avgCartResult.rows[0]?.avg_cart),
      },
      promoUsage: {
        applied: parseInt(promoEventsResult.rows[0]?.applied ?? "0", 10),
        failed: parseInt(promoEventsResult.rows[0]?.failed ?? "0", 10),
        redeemedOrders: parseInt(promoOrdersResult.rows[0]?.redeemed ?? "0", 10),
        discountUsd: num(promoOrdersResult.rows[0]?.discount),
        topCodes: promoTopResult.rows.map((r) => ({
          name: r.name,
          count: parseInt(r.count, 10),
        })),
      },
      freeDeliveryBar: {
        thresholdUsd: thresholdUsd > 0 ? thresholdUsd : null,
        belowThresholdSessions: parseInt(fr?.below_threshold ?? "0", 10),
        addedAfterBarSessions: parseInt(fr?.added_after_bar ?? "0", 10),
      },
      checkoutDropoffByCity: dropoffCityResult.rows.map((r) => {
        const reached = parseInt(r.reached, 10);
        const completed = parseInt(r.completed, 10);
        return {
          name: prettifyCitySlug(r.name) ?? r.name,
          reached,
          completed,
          dropoffRate: reached > 0 ? ((reached - completed) / reached) * 100 : 0,
        };
      }),
      checkoutDropoffBySlot: dropoffSlotResult.rows.map(dropoff),
      conversionByDeliveryFee: conversionFeeResult.rows.map((r) => {
        const s = parseInt(r.sessions, 10);
        const c = parseInt(r.completed, 10);
        return {
          bucket: r.bucket,
          sessions: s,
          completed: c,
          conversionRate: s > 0 ? (c / s) * 100 : 0,
        };
      }),
      paymentFailureRate,
      revenueLostToPaymentFailureUsd,
      failedByProvider: pf.map((r) => {
        const failed = parseInt(r.failed, 10);
        const paid = parseInt(r.paid, 10);
        return {
          provider: r.provider,
          failed,
          paid,
          failureRate: failed + paid > 0 ? (failed / (failed + paid)) * 100 : 0,
          lostRevenueUsd: num(r.lost),
        };
      }),
      deliveryFee: {
        validOrders,
        freeDeliveryOrders,
        paidDeliveryOrders,
        freeDeliveryShare:
          validOrders > 0 ? (freeDeliveryOrders / validOrders) * 100 : 0,
        avgDeliveryFeeUsd: num(df?.avg_fee),
      },
      aovByFreeDelivery: {
        freeDelivery: {
          orders: aovFreeOrders,
          aovUsd: aovFreeOrders > 0 ? num(av?.free_rev) / aovFreeOrders : 0,
        },
        paidDelivery: {
          orders: aovPaidOrders,
          aovUsd: aovPaidOrders > 0 ? num(av?.paid_rev) / aovPaidOrders : 0,
        },
      },
      paymentLinks: {
        created: parseInt(pl?.created ?? "0", 10),
        paid: parseInt(pl?.paid ?? "0", 10),
        paidRevenueUsd: num(pl?.paid_rev),
      },
    });
  } catch (err) {
    req.log.error({ err }, "store-analytics cart-checkout failed");
    res.status(500).json({ error: "Failed to compute analytics" });
  }
});

/**
 * Build the WHERE conditions (and params) that apply the shared analytics
 * filter bar to the `web_events` table (aliased `we`). Params are appended after
 * the caller's leading params (ownerId=$1, from=$2, to=$3).
 *
 * Note on mapping: web_events carry free-text website context, so:
 *  - country: matches `we.country` case-insensitively against the ISO code AND
 *    the resolved country name (the website may send either).
 *  - city: the filter passes a delivery-city id; we resolve it to that city's
 *    name and match `we.city` case-insensitively.
 *  - brand: matches `we.brand` case-insensitively.
 *  - channel is intentionally NOT applied — it is an order-level dimension with
 *    no website-event equivalent (web events use traffic source instead).
 */
function buildWebEventFilters(
  filters: AnalyticsFilters,
  startIndex: number,
): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  let idx = startIndex;

  if (filters.countryCode) {
    const name = findCountryByCode(filters.countryCode)?.name ?? null;
    if (name) {
      parts.push(
        `AND (lower(we.country) = lower($${idx}) OR lower(we.country) = lower($${idx + 1}))`,
      );
      params.push(filters.countryCode, name);
      idx += 2;
    } else {
      parts.push(`AND lower(we.country) = lower($${idx})`);
      params.push(filters.countryCode);
      idx += 1;
    }
  }
  if (filters.cityId !== null) {
    // $1 is always the workspace owner id in the funnel queries.
    parts.push(
      `AND lower(we.city) = lower((SELECT name FROM delivery_cities WHERE workspace_owner_id = $1 AND id = $${idx}))`,
    );
    params.push(filters.cityId);
    idx += 1;
  }
  if (filters.brand) {
    parts.push(`AND lower(we.brand) = lower($${idx})`);
    params.push(filters.brand);
    idx += 1;
  }

  return { sql: parts.join("\n"), params };
}

type StepCountsRow = { total_sessions: number } & Record<string, number>;
type BreakdownRow = { value: string; sessions: string | number; conversions: string | number };

function toBreakdownItems(rows: BreakdownRow[] | null) {
  return (rows ?? []).map((r) => {
    const sessions = num(r.sessions);
    const conversions = num(r.conversions);
    return {
      value: r.value,
      sessions,
      conversions,
      conversionRate: sessions > 0 ? (conversions / sessions) * 100 : 0,
    };
  });
}

/** Map a raw step-counts row into per-step user counts (ordered). */
function stepUsers(row: StepCountsRow | null | undefined): number[] {
  return FUNNEL_STEPS.map((_, i) => Math.round(num(row?.[`s${i}`])));
}

/**
 * GET /store-analytics/funnel
 *
 * Section 5 of the E-commerce Analytics page. Returns the full conversion funnel
 * (homepage visit → order created) built from website behavioral events, with
 * per-step user counts, drop-off and conversion rates, breakdowns by device /
 * country / city / language / traffic source, and Presentail-specific event
 * counts. Honors the shared analytics filter bar (date range, country, city,
 * brand; channel is not applicable to web events).
 */
router.get("/store-analytics/funnel", async (req, res) => {
  const wreq = workspace(req);
  const ownerId = wreq.workspaceOwnerId;

  const range = resolveRange(req.query.from, req.query.to);
  const compare = req.query.compare === "true" || req.query.compare === "1";
  const filters = parseAnalyticsFilters(req);

  const { sql: filterSql, params: filterParams } = buildWebEventFilters(filters, 4);
  const baseParams = [ownerId, range.from, range.to, ...filterParams];

  try {
    const presentailEventTypes = Array.from(
      new Set(PRESENTAIL_FUNNEL_EVENTS.flatMap((e) => e.eventTypes)),
    );

    const [mainResult, presentailResult, trackedResult, previousResult] =
      await Promise.all([
        db.query<{
          steps: StepCountsRow | null;
          by_device: BreakdownRow[] | null;
          by_country: BreakdownRow[] | null;
          by_city: BreakdownRow[] | null;
          by_language: BreakdownRow[] | null;
          by_traffic: BreakdownRow[] | null;
        }>(buildFunnelQuery(filterSql, true), baseParams),

        db.query<{ key: string; events: string; sessions: string }>(
          `SELECT CASE
                    ${PRESENTAIL_FUNNEL_EVENTS.map(
                      (e) => `WHEN ${eventTypeInList(e.eventTypes)} THEN ${sqlQuote(e.key)}`,
                    ).join("\n                    ")}
                  END AS key,
                  count(*) AS events,
                  count(DISTINCT session_id) AS sessions
           FROM web_events we
           WHERE we.workspace_owner_id = $1
             AND we.occurred_at >= $2
             AND we.occurred_at < $3
             AND event_type IN (${presentailEventTypes.map((_, i) => `$${baseParams.length + i + 1}`).join(", ")})
             ${filterSql}
           GROUP BY 1`,
          [...baseParams, ...presentailEventTypes],
        ),

        db.query<{ exists: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM web_events WHERE workspace_owner_id = $1) AS exists`,
          [ownerId],
        ),

        compare
          ? (() => {
              const prev = previousRange(range);
              return db.query<{ steps: StepCountsRow | null }>(
                buildFunnelQuery(filterSql, false),
                [ownerId, prev.from, prev.to, ...filterParams],
              );
            })()
          : Promise.resolve(null),
      ]);

    const mainRow = mainResult.rows[0];
    const users = stepUsers(mainRow?.steps);
    const totalSessions = Math.round(num(mainRow?.steps?.total_sessions));
    const base = users[0] ?? 0;

    const steps = FUNNEL_STEPS.map((step, i) => {
      const current = users[i] ?? 0;
      const prevUsers = i > 0 ? users[i - 1] ?? 0 : current;
      const dropOff = i > 0 ? Math.max(prevUsers - current, 0) : 0;
      return {
        key: step.key,
        users: current,
        dropOff,
        dropOffRate: i > 0 && prevUsers > 0 ? (dropOff / prevUsers) * 100 : 0,
        stepConversionRate:
          i === 0 ? 100 : prevUsers > 0 ? Math.min((current / prevUsers) * 100, 100) : 0,
        overallConversionRate: base > 0 ? Math.min((current / base) * 100, 100) : 0,
      };
    });

    let previousSteps: { key: string; users: number }[] | null = null;
    if (previousResult) {
      const prevUsers = stepUsers(previousResult.rows[0]?.steps);
      previousSteps = FUNNEL_STEPS.map((step, i) => ({
        key: step.key,
        users: prevUsers[i] ?? 0,
      }));
    }

    // Counts are grouped by logical key in SQL, so sessions are DISTINCT per
    // key (no double-counting when a key maps to multiple synonym event types).
    const byKey = new Map(
      presentailResult.rows.map((r) => [
        r.key,
        { events: parseInt(r.events, 10), sessions: parseInt(r.sessions, 10) },
      ]),
    );
    const presentailEvents = PRESENTAIL_FUNNEL_EVENTS.map((e) => {
      const hit = byKey.get(e.key);
      return { key: e.key, events: hit?.events ?? 0, sessions: hit?.sessions ?? 0 };
    });

    res.json({
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      comparison: compare
        ? (() => {
            const p = previousRange(range);
            return { from: p.from.toISOString(), to: p.to.toISOString() };
          })()
        : null,
      tracked: trackedResult.rows[0]?.exists === true,
      totalSessions,
      steps,
      previousSteps,
      breakdowns: {
        device: toBreakdownItems(mainRow?.by_device ?? null),
        country: toBreakdownItems(mainRow?.by_country ?? null),
        city: (mainRow?.by_city ?? []).map((r) => {
          const sessions = num(r.sessions);
          const conversions = num(r.conversions);
          return {
            value: prettifyCitySlug(r.value) ?? r.value,
            sessions,
            conversions,
            conversionRate: sessions > 0 ? (conversions / sessions) * 100 : 0,
          };
        }),
        language: toBreakdownItems(mainRow?.by_language ?? null),
        trafficSource: toBreakdownItems(mainRow?.by_traffic ?? null),
      },
      presentailEvents,
    });
  } catch (err) {
    req.log.error({ err }, "store-analytics funnel failed");
    res.status(500).json({ error: "Failed to compute funnel analytics" });
  }
});

/**
 * SQL CASE classifying an order into one of four attribution buckets
 * (organic / ads / direct / referral) from `orders.marketing_attribution`.
 * Always resolves to exactly one bucket (defaulting to 'direct').
 */
const SOURCE_SQL = `
  CASE
    WHEN o.marketing_attribution IS NULL THEN 'direct'
    WHEN lower(coalesce(o.marketing_attribution->>'source', '')) IN ('ads', 'paid')
      OR (o.marketing_attribution->'last_touch'->>'gclid') IS NOT NULL
      OR (o.marketing_attribution->'last_touch'->>'gbraid') IS NOT NULL
      OR (o.marketing_attribution->'last_touch'->>'wbraid') IS NOT NULL
      OR lower(coalesce(o.marketing_attribution->'last_touch'->>'utm_medium', ''))
         IN ('cpc', 'ppc', 'paid', 'paidsearch', 'paid_search', 'ads', 'display', 'paid_social', 'paidsocial')
      THEN 'ads'
    WHEN lower(coalesce(o.marketing_attribution->>'source', '')) = 'referral'
      OR lower(coalesce(o.marketing_attribution->'last_touch'->>'utm_medium', '')) = 'referral'
      OR (coalesce(o.marketing_attribution->'last_touch'->>'utm_source', '') = ''
          AND coalesce(o.marketing_attribution->'last_touch'->>'referrer', '') <> '')
      THEN 'referral'
    WHEN lower(coalesce(o.marketing_attribution->>'source', '')) = 'organic'
      OR lower(coalesce(o.marketing_attribution->'last_touch'->>'utm_medium', '')) IN ('organic', 'organic_search')
      OR coalesce(o.marketing_attribution->'last_touch'->>'utm_source', '') <> ''
      THEN 'organic'
    ELSE 'direct'
  END
`;

/**
 * GET /store-analytics/sales
 *
 * Section 2 of the E-commerce Analytics page. Revenue and order breakdowns
 * across every meaningful dimension: over time, best-selling hours, an hourly
 * heatmap, and by country / city / brand / channel / payment method / currency
 * / occasion, plus orders by attribution source. All money is USD (the paid
 * amounts converted to their USD equivalent). Honors the shared date range and
 * filters. All timestamp buckets use UTC (matching Section 1).
 */
router.get("/store-analytics/sales", async (req, res) => {
  const wreq = workspace(req);
  const ownerId = wreq.workspaceOwnerId;

  const range = resolveRange(req.query.from, req.query.to);
  const filters = parseAnalyticsFilters(req);
  const bucket = bucketFor(range);

  const { sql: cte, params: filterParams } = filteredOrdersCte(ownerId, filters);
  const baseParams = [ownerId, range.from, range.to, ...filterParams];

  try {
    const prev = previousRange(range);
    const prevBaseParams = [ownerId, prev.from, prev.to, ...filterParams];

    const [
      overTimeResult,
      byHourResult,
      heatmapResult,
      byCountryResult,
      byCityResult,
      byBrandResult,
      byChannelResult,
      byPaymentMethodResult,
      byCurrencyResult,
      byOccasionResult,
      bySourceResult,
      totalSessions,
      sessionsByCountryResult,
      prevSessionsByCountryResult,
      prevOrdersByCountryResult,
    ] = await Promise.all([
      // Revenue + orders over time
      db.query<{ bucket_date: string; revenue: string; orders: string }>(
        `${cte}
         SELECT
           date_trunc('${bucket}', ordered_at AT TIME ZONE 'UTC')::date::text AS bucket_date,
           COALESCE(SUM(revenue_usd), 0) AS revenue,
           COUNT(*) AS orders
         FROM filtered
         WHERE status NOT IN (${NON_REVENUE_SQL})
         GROUP BY 1
         ORDER BY 1 ASC`,
        baseParams,
      ),

      // Revenue by hour (best-selling hours), 0-23 UTC
      db.query<{ hour: number; revenue: string; orders: string }>(
        `${cte}
         SELECT
           EXTRACT(HOUR FROM ordered_at AT TIME ZONE 'UTC')::int AS hour,
           COALESCE(SUM(revenue_usd), 0) AS revenue,
           COUNT(*) AS orders
         FROM filtered
         WHERE status NOT IN (${NON_REVENUE_SQL})
         GROUP BY 1
         ORDER BY 1 ASC`,
        baseParams,
      ),

      // Hourly heatmap: day-of-week (0=Sun) x hour, order counts + revenue
      db.query<{ dow: number; hour: number; orders: string; revenue: string }>(
        `${cte}
         SELECT
           EXTRACT(DOW FROM ordered_at AT TIME ZONE 'UTC')::int AS dow,
           EXTRACT(HOUR FROM ordered_at AT TIME ZONE 'UTC')::int AS hour,
           COUNT(*) AS orders,
           COALESCE(SUM(revenue_usd), 0) AS revenue
         FROM filtered
         WHERE status NOT IN (${NON_REVENUE_SQL})
         GROUP BY 1, 2`,
        baseParams,
      ),

      // Revenue by country — grouped by buyer's phone country (dial-code-derived)
      db.query<{ country_code: string | null; revenue: string; orders: string }>(
        `${cte}
         SELECT
           ${phoneCountrySql("cust.phone")} AS country_code,
           COALESCE(SUM(f.revenue_usd), 0) AS revenue,
           COUNT(*) AS orders
         FROM filtered f
         LEFT JOIN LATERAL (
           SELECT ct.phone
             FROM order_contacts oc
             JOIN contacts ct ON ct.id = oc.contact_id
            WHERE oc.order_id = f.id AND oc.role = 'customer'
            ORDER BY oc.contact_id ASC
            LIMIT 1
         ) cust ON true
         WHERE f.status NOT IN (${NON_REVENUE_SQL})
         GROUP BY 1
         ORDER BY 2 DESC`,
        baseParams,
      ),

      // Revenue by city (resolve name via delivery_cities)
      db.query<{ city_id: string | null; name: string | null; revenue: string; orders: string }>(
        `${cte}
         SELECT
           COALESCE(dc.id::text, f.delivery_address->>'cityId') AS city_id,
           dc.name AS name,
           COALESCE(SUM(f.revenue_usd), 0) AS revenue,
           COUNT(*) AS orders
         FROM filtered f
         LEFT JOIN delivery_cities dc
           ON dc.workspace_owner_id = $1
          AND ${cityMatchSql(`f.delivery_address->>'cityId'`)}
         WHERE f.status NOT IN (${NON_REVENUE_SQL})
         GROUP BY 1, 2
         ORDER BY 3 DESC`,
        baseParams,
      ),

      // Revenue by brand (line-item revenue attributed via matched product brand)
      db.query<{ name: string; revenue: string; orders: string }>(
        `${cte}
         SELECT
           COALESCE(NULLIF(p.brand, ''), 'Unknown') AS name,
           COALESCE(SUM(li.line_total::numeric), 0) AS revenue,
           COUNT(DISTINCT li.order_id) AS orders
         FROM order_line_items li
         JOIN filtered f ON f.id = li.order_id AND f.status NOT IN (${NON_REVENUE_SQL})
         JOIN LATERAL (
           SELECT p.id, p.brand
           FROM products p
           WHERE p.workspace_owner_id = $1
             AND (
               lower(COALESCE(li.name, '')) = lower(p.name)
               OR (li.product_id IS NOT NULL AND li.product_id = p.id)
             )
           ORDER BY (li.product_id IS NOT NULL AND li.product_id = p.id) DESC
           LIMIT 1
         ) p ON true
         GROUP BY 1
         ORDER BY 2 DESC
         LIMIT 12`,
        baseParams,
      ),

      // Revenue by channel
      db.query<{ channel: string | null; revenue: string; orders: string }>(
        `${cte}
         SELECT
           COALESCE(NULLIF(channel, ''), 'Unknown') AS channel,
           COALESCE(SUM(revenue_usd), 0) AS revenue,
           COUNT(*) AS orders
         FROM filtered
         WHERE status NOT IN (${NON_REVENUE_SQL})
         GROUP BY 1
         ORDER BY 2 DESC`,
        baseParams,
      ),

      // Revenue by payment method (USD equivalent of amount paid)
      db.query<{ name: string; revenue: string; orders: string }>(
        `${cte}
         SELECT
           COALESCE(NULLIF(pay2.method, ''), 'Unknown') AS name,
           COALESCE(SUM(pay2.amount_usd), 0) AS revenue,
           COUNT(DISTINCT pay2.order_id) AS orders
         FROM order_payment pay2
         JOIN filtered f ON f.id = pay2.order_id AND f.status NOT IN (${NON_REVENUE_SQL})
         WHERE pay2.amount_usd IS NOT NULL
         GROUP BY 1
         ORDER BY 2 DESC`,
        baseParams,
      ),

      // Revenue by currency the customer paid in (reported as USD equivalent)
      db.query<{ name: string; revenue: string; orders: string }>(
        `${cte}
         SELECT
           COALESCE(NULLIF(pay2.currency, ''), 'USD') AS name,
           COALESCE(SUM(pay2.amount_usd), 0) AS revenue,
           COUNT(DISTINCT pay2.order_id) AS orders
         FROM order_payment pay2
         JOIN filtered f ON f.id = pay2.order_id AND f.status NOT IN (${NON_REVENUE_SQL})
         WHERE pay2.amount_usd IS NOT NULL
         GROUP BY 1
         ORDER BY 2 DESC`,
        baseParams,
      ),

      // Revenue by occasion (line-item revenue attributed via product occasions)
      db.query<{ name: string; revenue: string; orders: string }>(
        `${cte}
         SELECT
           occ.name AS name,
           COALESCE(SUM(li.line_total::numeric), 0) AS revenue,
           COUNT(DISTINCT li.order_id) AS orders
         FROM order_line_items li
         JOIN filtered f ON f.id = li.order_id AND f.status NOT IN (${NON_REVENUE_SQL})
         JOIN LATERAL (
           SELECT p.id
           FROM products p
           WHERE p.workspace_owner_id = $1
             AND (
               lower(COALESCE(li.name, '')) = lower(p.name)
               OR (li.product_id IS NOT NULL AND li.product_id = p.id)
             )
           ORDER BY (li.product_id IS NOT NULL AND li.product_id = p.id) DESC
           LIMIT 1
         ) p ON true
         JOIN product_occasions po ON po.product_id = p.id
         JOIN occasions occ ON occ.id = po.attribute_id
         GROUP BY occ.name
         ORDER BY 2 DESC
         LIMIT 12`,
        baseParams,
      ),

      // Orders by attribution source (organic/ads/direct/referral)
      db.query<{ source: string; orders: string; revenue: string }>(
        `${cte}
         SELECT
           ${SOURCE_SQL} AS source,
           COUNT(*) AS orders,
           COALESCE(SUM(f.revenue_usd), 0) AS revenue
         FROM filtered f
         JOIN orders o ON o.id = f.id
         WHERE f.status NOT IN (${NON_REVENUE_SQL})
         GROUP BY 1
         ORDER BY 2 DESC`,
        baseParams,
      ),

      // Total sessions for conversion-rate computation
      countSessions(ownerId, range, filters),

      // Per-visitor-country session counts for per-country conversion rate
      (() => {
        const we = webEventFilter(filters);
        return db.query<{ country_code: string; sessions: string }>(
          `SELECT
             LOWER(we.country) AS country_code,
             COUNT(DISTINCT we.session_id) AS sessions
           FROM web_events we
           WHERE we.workspace_owner_id = $1
             AND we.occurred_at >= $2
             AND we.occurred_at < $3
             AND we.session_id IS NOT NULL
             AND we.country IS NOT NULL
             AND we.country <> ''
             ${we.sql}
           GROUP BY 1`,
          [ownerId, range.from, range.to, ...we.params],
        );
      })(),

      // Previous-period per-country sessions (for conversion trend)
      (() => {
        const we = webEventFilter(filters);
        return db.query<{ country_code: string; sessions: string }>(
          `SELECT
             LOWER(we.country) AS country_code,
             COUNT(DISTINCT we.session_id) AS sessions
           FROM web_events we
           WHERE we.workspace_owner_id = $1
             AND we.occurred_at >= $2
             AND we.occurred_at < $3
             AND we.session_id IS NOT NULL
             AND we.country IS NOT NULL
             AND we.country <> ''
             ${we.sql}
           GROUP BY 1`,
          [ownerId, prev.from, prev.to, ...we.params],
        );
      })(),

      // Previous-period per-country order counts (for conversion trend; phone-derived)
      db.query<{ country_code: string | null; orders: string }>(
        `${cte}
         SELECT
           ${phoneCountrySql("cust.phone")} AS country_code,
           COUNT(*) AS orders
         FROM filtered f
         LEFT JOIN LATERAL (
           SELECT ct.phone
             FROM order_contacts oc
             JOIN contacts ct ON ct.id = oc.contact_id
            WHERE oc.order_id = f.id AND oc.role = 'customer'
            ORDER BY oc.contact_id ASC
            LIMIT 1
         ) cust ON true
         WHERE f.status NOT IN (${NON_REVENUE_SQL})
         GROUP BY 1`,
        prevBaseParams,
      ),
    ]);

    const revenueByHour = Array.from({ length: 24 }, (_, hour) => {
      const row = byHourResult.rows.find((r) => Number(r.hour) === hour);
      return {
        hour,
        revenue: row ? num(row.revenue) : 0,
        orders: row ? parseInt(row.orders, 10) : 0,
      };
    });

    const hourlyHeatmap = heatmapResult.rows.map((r) => ({
      dow: Number(r.dow),
      hour: Number(r.hour),
      orders: parseInt(r.orders, 10),
      revenue: num(r.revenue),
    }));

    // Build a Map from visitor-country string (lowercased) → session count.
    // web_events.country may be stored as an ISO code ("lb") or a full name
    // ("lebanon"), so we index by the raw lowercased value and try both the
    // delivery countryCode and the resolved country name when looking up.
    const sessionsByCountry = new Map<string, number>();
    for (const row of sessionsByCountryResult.rows) {
      if (row.country_code) {
        sessionsByCountry.set(row.country_code, parseInt(row.sessions, 10));
      }
    }

    // Build previous-period lookup maps for trend computation.
    const prevSessionsByCountry = new Map<string, number>();
    for (const row of prevSessionsByCountryResult.rows) {
      if (row.country_code) {
        prevSessionsByCountry.set(row.country_code, parseInt(row.sessions, 10));
      }
    }
    const prevOrdersByCountry = new Map<string, number>();
    for (const row of prevOrdersByCountryResult.rows) {
      const key = row.country_code?.toLowerCase() ?? "";
      if (key) {
        prevOrdersByCountry.set(key, parseInt(row.orders, 10));
      }
    }

    /**
     * Compute the conversion-rate trend direction vs the previous period.
     * Returns "up" if improved ≥0.5pp, "down" if declined ≥0.5pp,
     * "flat" if <0.5pp change, or null when comparison is unavailable.
     */
    function conversionTrend(
      curr: number | null,
      prevPct: number | null,
    ): "up" | "down" | "flat" | null {
      if (curr == null || prevPct == null) return null;
      const diff = curr - prevPct;
      if (Math.abs(diff) < 0.5) return "flat";
      return diff > 0 ? "up" : "down";
    }

    const revenueByCountry = byCountryResult.rows.map((r) => {
      const orders = parseInt(r.orders, 10);
      const revenue = num(r.revenue);
      const countryName = r.country_code
        ? findCountryByCode(r.country_code)?.name ?? r.country_code
        : "Unknown";
      const codeKey = r.country_code?.toLowerCase() ?? "";
      const nameKey = countryName.toLowerCase();
      const sessions =
        (codeKey ? sessionsByCountry.get(codeKey) : undefined) ??
        sessionsByCountry.get(nameKey) ??
        null;
      const currConvPct =
        sessions != null && sessions > 0
          ? Math.round((orders / sessions) * 10000) / 100
          : null;

      // Previous period
      const prevSessions =
        (codeKey ? prevSessionsByCountry.get(codeKey) : undefined) ??
        prevSessionsByCountry.get(nameKey) ??
        null;
      const prevOrders =
        (codeKey ? prevOrdersByCountry.get(codeKey) : undefined) ??
        prevOrdersByCountry.get(nameKey) ??
        null;
      const prevConvPct =
        prevSessions != null && prevSessions > 0 && prevOrders != null
          ? Math.round((prevOrders / prevSessions) * 10000) / 100
          : null;

      return {
        code: r.country_code,
        name: countryName,
        revenue,
        orders,
        aov: orders > 0 ? Math.round((revenue / orders) * 100) / 100 : 0,
        sessions,
        conversionRatePct: currConvPct,
        conversionRatePrevPct: prevConvPct,
        conversionTrend: conversionTrend(currConvPct, prevConvPct),
      };
    });

    const conversionRateByCountry = revenueByCountry.map((c) => ({
      code: c.code,
      name: c.name,
      orders: c.orders,
      sessions: c.sessions,
      conversionRatePct: c.conversionRatePct,
      conversionRatePrevPct: c.conversionRatePrevPct,
      conversionTrend: c.conversionTrend,
    }));

    res.json({
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      bucket,
      revenueOverTime: overTimeResult.rows.map((r) => ({
        date: r.bucket_date,
        revenue: num(r.revenue),
        orders: parseInt(r.orders, 10),
      })),
      revenueByHour,
      hourlyHeatmap,
      revenueByCountry,
      revenueByCity: byCityResult.rows.map((r) => ({
        name: r.name ?? prettifyCitySlug(r.city_id) ?? "Unknown",
        revenue: num(r.revenue),
        orders: parseInt(r.orders, 10),
      })),
      revenueByBrand: byBrandResult.rows.map((r) => ({
        name: r.name,
        revenue: num(r.revenue),
        orders: parseInt(r.orders, 10),
      })),
      revenueByChannel: byChannelResult.rows.map((r) => ({
        name: r.channel ?? "Unknown",
        revenue: num(r.revenue),
        orders: parseInt(r.orders, 10),
      })),
      revenueByPaymentMethod: byPaymentMethodResult.rows.map((r) => ({
        name: r.name,
        revenue: num(r.revenue),
        orders: parseInt(r.orders, 10),
      })),
      revenueByCurrency: byCurrencyResult.rows.map((r) => ({
        name: r.name,
        revenue: num(r.revenue),
        orders: parseInt(r.orders, 10),
      })),
      revenueByOccasion: byOccasionResult.rows.map((r) => ({
        name: r.name,
        revenue: num(r.revenue),
        orders: parseInt(r.orders, 10),
      })),
      ordersBySource: bySourceResult.rows.map((r) => ({
        source: r.source,
        orders: parseInt(r.orders, 10),
        revenue: num(r.revenue),
      })),
      conversionRateByCountry,
    });
  } catch (err) {
    req.log.error({ err }, "store-analytics sales failed");
    res.status(500).json({ error: "Failed to compute analytics" });
  }
});


/**
 * Normalized payment-method label for a payment row. Generic/blank methods
 * (e.g. "card", "online") defer to the provider (e.g. "whish", "stripe") when
 * one is recorded; otherwise the method itself is used, falling back to
 * "unknown". Lower-cased for stable grouping.
 */
const PAYMENT_METHOD_LABEL_SQL = `
  lower(
    COALESCE(
      NULLIF(
        CASE
          WHEN lower(COALESCE(pay2.method, '')) IN ('', 'card', 'online', 'other', 'unknown', 'payment')
          THEN COALESCE(NULLIF(pay2.provider, ''), pay2.method)
          ELSE pay2.method
        END,
      ''),
      NULLIF(pay2.provider, ''),
      'unknown'
    )
  )
`;

/**
 * GET /store-analytics/time-slots
 *
 * Sales-by-time-slot breakdown for the Sales tab. Buckets orders by their
 * delivery window (orders.window_start/window_end, UTC "HH:MM–HH:MM" labels;
 * orders with no window land in a null "no time slot" bucket so totals
 * reconcile). Per slot: orders, revenue (USD), express vs standard split,
 * express surcharge totals and slot fee-override totals (both from the
 * delivery details stored on the order at ingest). Also returns overall
 * express totals for KPI cards. Honors the shared date range and filters.
 */
router.get("/store-analytics/time-slots", async (req, res) => {
  const wreq = workspace(req);
  const ownerId = wreq.workspaceOwnerId;

  const range = resolveRange(req.query.from, req.query.to);
  const filters = parseAnalyticsFilters(req);

  const { sql: cte, params: filterParams } = filteredOrdersCte(ownerId, filters);
  const baseParams = [ownerId, range.from, range.to, ...filterParams];

  const IS_EXPRESS = `COALESCE(o.delivery_address->>'isExpress', '') = 'true'`;

  try {
    const result = await db.query<TimeSlotRow>(
      `${cte}
       SELECT
         CASE
           WHEN o.window_start IS NOT NULL AND o.window_end IS NOT NULL
           THEN to_char(o.window_start AT TIME ZONE 'UTC', 'HH24:MI') || '–' ||
                to_char(o.window_end AT TIME ZONE 'UTC', 'HH24:MI')
         END AS slot,
         to_char(MIN(o.window_start AT TIME ZONE 'UTC'), 'HH24:MI') AS sort_start,
         COUNT(*) AS orders,
         COALESCE(SUM(f.revenue_usd), 0) AS revenue,
         COUNT(*) FILTER (WHERE ${IS_EXPRESS}) AS express_orders,
         COALESCE(SUM(f.revenue_usd) FILTER (WHERE ${IS_EXPRESS}), 0) AS express_revenue,
         COALESCE(SUM(
           CASE WHEN o.delivery_address->>'expressSurchargeUsd' ~ '^[0-9]+(\\.[0-9]+)?$'
                THEN (o.delivery_address->>'expressSurchargeUsd')::numeric END
         ), 0) AS express_surcharge_usd,
         COALESCE(SUM(
           CASE WHEN o.delivery_address->>'slotFeeUsd' ~ '^[0-9]+(\\.[0-9]+)?$'
                THEN (o.delivery_address->>'slotFeeUsd')::numeric END
         ), 0) AS slot_fee_usd
       FROM filtered f
       JOIN orders o ON o.id = f.id
       WHERE f.status NOT IN (${NON_REVENUE_SQL})
       GROUP BY 1`,
      baseParams,
    );

    const { timeSlots, totals } = buildTimeSlotBreakdown(result.rows);

    res.json({
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      timeSlots,
      totals,
    });
  } catch (err) {
    req.log.error({ err }, "store-analytics: time-slots query failed");
    res.status(500).json({ error: "Failed to load time slot analytics" });
  }
});

/**
 * GET /store-analytics/payment-methods
 *
 * Payment Methods section of the E-commerce Analytics page. Aggregates from
 * order payment records (method/provider + amount_usd) over the shared
 * filtered order set: per-method revenue, order counts, AOV and share of
 * total, a revenue-over-time series per method, and the per-method currency
 * mix. All money is USD. Honors the shared date range and filters.
 */
router.get("/store-analytics/payment-methods", async (req, res) => {
  const wreq = workspace(req);
  const ownerId = wreq.workspaceOwnerId;

  const range = resolveRange(req.query.from, req.query.to);
  const filters = parseAnalyticsFilters(req);
  const bucket = bucketFor(range);

  const { sql: cte, params: filterParams } = filteredOrdersCte(ownerId, filters);
  const baseParams = [ownerId, range.from, range.to, ...filterParams];

  try {
    const [totalsResult, overTimeResult, currencyResult] = await Promise.all([
      // Per-method totals: revenue (USD), distinct orders.
      db.query<{ method: string; revenue: string; orders: string }>(
        `${cte}
         SELECT
           ${PAYMENT_METHOD_LABEL_SQL} AS method,
           COALESCE(SUM(pay2.amount_usd), 0) AS revenue,
           COUNT(DISTINCT pay2.order_id) AS orders
         FROM order_payment pay2
         JOIN filtered f ON f.id = pay2.order_id AND f.status NOT IN (${NON_REVENUE_SQL})
         WHERE pay2.amount_usd IS NOT NULL
         GROUP BY 1
         ORDER BY 2 DESC`,
        baseParams,
      ),

      // Revenue over time per method (flat cells; the client pivots).
      db.query<{ bucket_date: string; method: string; revenue: string; orders: string }>(
        `${cte}
         SELECT
           date_trunc('${bucket}', f.ordered_at AT TIME ZONE 'UTC')::date::text AS bucket_date,
           ${PAYMENT_METHOD_LABEL_SQL} AS method,
           COALESCE(SUM(pay2.amount_usd), 0) AS revenue,
           COUNT(DISTINCT pay2.order_id) AS orders
         FROM order_payment pay2
         JOIN filtered f ON f.id = pay2.order_id AND f.status NOT IN (${NON_REVENUE_SQL})
         WHERE pay2.amount_usd IS NOT NULL
         GROUP BY 1, 2
         ORDER BY 1 ASC`,
        baseParams,
      ),

      // Currency mix per method (revenue reported as USD equivalent).
      db.query<{ method: string; currency: string; revenue: string; orders: string }>(
        `${cte}
         SELECT
           ${PAYMENT_METHOD_LABEL_SQL} AS method,
           upper(COALESCE(NULLIF(pay2.currency, ''), 'USD')) AS currency,
           COALESCE(SUM(pay2.amount_usd), 0) AS revenue,
           COUNT(DISTINCT pay2.order_id) AS orders
         FROM order_payment pay2
         JOIN filtered f ON f.id = pay2.order_id AND f.status NOT IN (${NON_REVENUE_SQL})
         WHERE pay2.amount_usd IS NOT NULL
         GROUP BY 1, 2
         ORDER BY 1, 3 DESC`,
        baseParams,
      ),
    ]);

    const totalRevenue = totalsResult.rows.reduce((s, r) => s + num(r.revenue), 0);
    const totalOrders = totalsResult.rows.reduce(
      (s, r) => s + parseInt(r.orders, 10),
      0,
    );

    const currenciesByMethod = new Map<
      string,
      { currency: string; revenue: number; orders: number }[]
    >();
    for (const r of currencyResult.rows) {
      const list = currenciesByMethod.get(r.method) ?? [];
      list.push({
        currency: r.currency,
        revenue: num(r.revenue),
        orders: parseInt(r.orders, 10),
      });
      currenciesByMethod.set(r.method, list);
    }

    res.json({
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      bucket,
      totalRevenue,
      totalOrders,
      methods: totalsResult.rows.map((r) => {
        const revenue = num(r.revenue);
        const orders = parseInt(r.orders, 10);
        return {
          method: r.method,
          revenue,
          orders,
          aov: orders > 0 ? revenue / orders : 0,
          sharePct: totalRevenue > 0 ? (revenue / totalRevenue) * 100 : 0,
          currencies: currenciesByMethod.get(r.method) ?? [],
        };
      }),
      revenueOverTime: overTimeResult.rows.map((r) => ({
        date: r.bucket_date,
        method: r.method,
        revenue: num(r.revenue),
        orders: parseInt(r.orders, 10),
      })),
    });
  } catch (err) {
    req.log.error({ err }, "store-analytics payment-methods failed");
    res.status(500).json({ error: "Failed to compute analytics" });
  }
});

type CustomerKpiRow = {
  unique_customers: string;
  total_orders: string;
  total_revenue: string;
  new_customers: string;
  returning_customers: string;
  repeat_customers: string;
};

/**
 * Customer-level KPIs over the filtered order set (role = 'customer' buyers):
 * unique customers, new vs returning (had any order before the window start),
 * repeat-purchase rate (2+ orders in-window), average orders per customer, and
 * average revenue per customer (CLV within the window). All money is USD.
 */
async function computeCustomerKpis(
  ownerId: string,
  range: AnalyticsRange,
  filters: AnalyticsFilters,
) {
  const { sql: cte, params: filterParams } = filteredOrdersCte(ownerId, filters);
  const params = [ownerId, range.from, range.to, ...filterParams];

  const sql = `
    ${cte},
    cust_orders AS (
      SELECT f.id, f.revenue_usd, oc.contact_id
      FROM filtered f
      JOIN order_contacts oc ON oc.order_id = f.id AND oc.role = 'customer'
      WHERE f.status NOT IN (${NON_REVENUE_SQL})
    ),
    cust_level AS (
      SELECT
        co.contact_id,
        COUNT(*)::int AS orders_in_window,
        COALESCE(SUM(co.revenue_usd), 0) AS revenue_in_window,
        EXISTS (
          SELECT 1 FROM order_contacts oc2
          JOIN orders o2 ON o2.id = oc2.order_id
          WHERE oc2.contact_id = co.contact_id
            AND oc2.role = 'customer'
            AND o2.workspace_owner_id = $1
            AND o2.ordered_at < $2
        ) AS had_prior
      FROM cust_orders co
      GROUP BY co.contact_id
    )
    SELECT
      COUNT(*)::int AS unique_customers,
      COALESCE(SUM(orders_in_window), 0)::int AS total_orders,
      COALESCE(SUM(revenue_in_window), 0) AS total_revenue,
      COUNT(*) FILTER (WHERE NOT had_prior)::int AS new_customers,
      COUNT(*) FILTER (WHERE had_prior)::int AS returning_customers,
      COUNT(*) FILTER (WHERE orders_in_window >= 2)::int AS repeat_customers
    FROM cust_level
  `;

  const result = await db.query<CustomerKpiRow>(sql, params);
  const r = result.rows[0];
  const uniqueCustomers = parseInt(r?.unique_customers ?? "0", 10);
  const totalOrders = parseInt(r?.total_orders ?? "0", 10);
  const totalRevenue = num(r?.total_revenue);
  const newCustomers = parseInt(r?.new_customers ?? "0", 10);
  const returningCustomers = parseInt(r?.returning_customers ?? "0", 10);
  const repeatCustomers = parseInt(r?.repeat_customers ?? "0", 10);

  return {
    uniqueCustomers,
    newCustomers,
    returningCustomers,
    repeatPurchaseRate: uniqueCustomers > 0 ? (repeatCustomers / uniqueCustomers) * 100 : 0,
    avgOrdersPerCustomer: uniqueCustomers > 0 ? totalOrders / uniqueCustomers : 0,
    clv: uniqueCustomers > 0 ? totalRevenue / uniqueCustomers : 0,
  };
}

/**
 * GET /store-analytics/customer-insights
 *
 * Section 4 of the E-commerce Analytics page. Understand who is buying,
 * retention, and — critical for a gifting business — the sender vs recipient
 * relationship. Honors the shared analytics filter bar; all money is USD.
 */
router.get("/store-analytics/customer-insights", async (req, res) => {
  const wreq = workspace(req);
  const ownerId = wreq.workspaceOwnerId;

  const range = resolveRange(req.query.from, req.query.to);
  const compare = req.query.compare === "true" || req.query.compare === "1";
  const filters = parseAnalyticsFilters(req);

  const { sql: cte, params: filterParams } = filteredOrdersCte(ownerId, filters);
  const baseParams = [ownerId, range.from, range.to, ...filterParams];

  try {
    const [
      kpis,
      previousKpis,
      aovByTypeResult,
      topCustomersResult,
      byCountryResult,
      byCityResult,
      giftingResult,
      multiRecipientResult,
      relationshipsResult,
    ] = await Promise.all([
      computeCustomerKpis(ownerId, range, filters),
      compare
        ? computeCustomerKpis(ownerId, previousRange(range), filters)
        : Promise.resolve(null),

      // AOV by customer type (per-order: returning if the buyer had an earlier order)
      db.query<{ is_returning: boolean; orders: string; revenue: string }>(
        `${cte}
         SELECT is_returning,
           COUNT(*) AS orders,
           COALESCE(SUM(revenue_usd), 0) AS revenue
         FROM (
           SELECT DISTINCT ON (f.id)
             f.id,
             f.revenue_usd,
             EXISTS (
               SELECT 1 FROM order_contacts oc2
               JOIN orders o2 ON o2.id = oc2.order_id
               WHERE oc2.contact_id = oc.contact_id
                 AND oc2.role = 'customer'
                 AND o2.workspace_owner_id = $1
                 AND o2.ordered_at < f.ordered_at
             ) AS is_returning
           FROM filtered f
           JOIN order_contacts oc ON oc.order_id = f.id AND oc.role = 'customer'
           WHERE f.status NOT IN (${NON_REVENUE_SQL})
           ORDER BY f.id
         ) x
         GROUP BY is_returning`,
        baseParams,
      ),

      // Top customers (VIPs) by revenue
      db.query<{
        id: string;
        name: string | null;
        orders: string;
        revenue: string;
        is_vip: boolean;
      }>(
        `${cte}
         SELECT
           oc.contact_id AS id,
           COALESCE(
             NULLIF(TRIM(COALESCE(c.display_name, '')), ''),
             NULLIF(TRIM(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')), ''),
             c.email, c.phone
           ) AS name,
           COUNT(DISTINCT f.id) AS orders,
           COALESCE(SUM(f.revenue_usd), 0) AS revenue,
           EXISTS (SELECT 1 FROM unnest(c.tags) tg WHERE lower(tg) = 'vip') AS is_vip
         FROM filtered f
         JOIN order_contacts oc ON oc.order_id = f.id AND oc.role = 'customer'
         JOIN contacts c ON c.id = oc.contact_id
         WHERE f.status NOT IN (${NON_REVENUE_SQL})
         GROUP BY oc.contact_id, c.display_name, c.first_name, c.last_name,
                  c.email, c.phone, c.tags
         ORDER BY revenue DESC, orders DESC
         LIMIT 10`,
        baseParams,
      ),

      // Customers by country (country code; name resolved in JS)
      db.query<{ country_code: string | null; customers: string }>(
        `${cte}
         SELECT
           f.delivery_address->>'countryCode' AS country_code,
           COUNT(DISTINCT oc.contact_id) AS customers
         FROM filtered f
         JOIN order_contacts oc ON oc.order_id = f.id AND oc.role = 'customer'
         WHERE f.status NOT IN (${NON_REVENUE_SQL})
         GROUP BY 1
         ORDER BY 2 DESC`,
        baseParams,
      ),

      // Customers by city (resolve city name via delivery_cities)
      db.query<{ city_id: string | null; name: string | null; customers: string }>(
        `${cte}
         SELECT
           COALESCE(dc.id::text, f.delivery_address->>'cityId') AS city_id,
           dc.name AS name,
           COUNT(DISTINCT oc.contact_id) AS customers
         FROM filtered f
         JOIN order_contacts oc ON oc.order_id = f.id AND oc.role = 'customer'
         LEFT JOIN delivery_cities dc
           ON dc.workspace_owner_id = $1
          AND ${cityMatchSql(`f.delivery_address->>'cityId'`)}
         WHERE f.status NOT IN (${NON_REVENUE_SQL})
         GROUP BY 1, 2
         ORDER BY 3 DESC`,
        baseParams,
      ),

      // Unique senders vs recipients
      db.query<{ senders: string; recipients: string }>(
        `${cte}
         SELECT
           COUNT(DISTINCT oc.contact_id) FILTER (WHERE oc.role = 'customer') AS senders,
           COUNT(DISTINCT oc.contact_id) FILTER (WHERE oc.role = 'recipient') AS recipients
         FROM filtered f
         JOIN order_contacts oc ON oc.order_id = f.id
         WHERE f.status NOT IN (${NON_REVENUE_SQL})`,
        baseParams,
      ),

      // Customers (senders) who gifted to 2+ distinct recipients
      db.query<{ cnt: string }>(
        `${cte}
         SELECT COUNT(*) AS cnt FROM (
           SELECT cust.contact_id
           FROM filtered f
           JOIN order_contacts cust ON cust.order_id = f.id AND cust.role = 'customer'
           JOIN order_contacts rec ON rec.order_id = f.id AND rec.role = 'recipient'
           WHERE f.status NOT IN (${NON_REVENUE_SQL})
           GROUP BY cust.contact_id
           HAVING COUNT(DISTINCT rec.contact_id) >= 2
         ) x`,
        baseParams,
      ),

      // Most common recipient relationships (recipients catalog attribute on
      // the ordered products, attributed via line items — mirrors topOccasions)
      db.query<{ name: string; revenue: string; orders: string }>(
        `${cte}
         SELECT
           rc.name AS name,
           COALESCE(SUM(li.line_total::numeric), 0) AS revenue,
           COUNT(DISTINCT li.order_id) AS orders
         FROM order_line_items li
         JOIN filtered f ON f.id = li.order_id AND f.status NOT IN (${NON_REVENUE_SQL})
         JOIN LATERAL (
           SELECT p.id
           FROM products p
           WHERE p.workspace_owner_id = $1
             AND (
               lower(COALESCE(li.name, '')) = lower(p.name)
               OR (li.product_id IS NOT NULL AND li.product_id = p.id)
             )
           ORDER BY (li.product_id IS NOT NULL AND li.product_id = p.id) DESC
           LIMIT 1
         ) p ON true
         JOIN product_recipients pr ON pr.product_id = p.id
         JOIN recipients rc ON rc.id = pr.attribute_id
         GROUP BY rc.name
         ORDER BY 3 DESC, 2 DESC
         LIMIT 10`,
        baseParams,
      ),
    ]);

    const newRow = aovByTypeResult.rows.find((r) => r.is_returning === false);
    const returningRow = aovByTypeResult.rows.find((r) => r.is_returning === true);
    const aovBucket = (row: typeof newRow) => {
      const orders = parseInt(row?.orders ?? "0", 10);
      const revenue = num(row?.revenue);
      return { orders, aov: orders > 0 ? revenue / orders : 0 };
    };

    const customersByCountry = byCountryResult.rows.map((r) => ({
      code: r.country_code,
      name: r.country_code
        ? findCountryByCode(r.country_code)?.name ?? r.country_code
        : "Unknown",
      customers: parseInt(r.customers, 10),
    }));

    const giftingRow = giftingResult.rows[0];

    res.json({
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      comparison: compare
        ? (() => {
            const p = previousRange(range);
            return { from: p.from.toISOString(), to: p.to.toISOString() };
          })()
        : null,
      kpis,
      previousKpis,
      aovByType: {
        new: aovBucket(newRow),
        returning: aovBucket(returningRow),
      },
      topCustomers: topCustomersResult.rows.map((r) => ({
        id: r.id,
        name: r.name ?? "Unknown",
        orders: parseInt(r.orders, 10),
        revenue: num(r.revenue),
        isVip: r.is_vip,
      })),
      customersByCountry,
      customersByCity: byCityResult.rows.map((r) => ({
        name: r.name ?? prettifyCitySlug(r.city_id) ?? "Unknown",
        customers: parseInt(r.customers, 10),
      })),
      gifting: {
        uniqueSenders: parseInt(giftingRow?.senders ?? "0", 10),
        uniqueRecipients: parseInt(giftingRow?.recipients ?? "0", 10),
        customersWithMultipleRecipients: parseInt(
          multiRecipientResult.rows[0]?.cnt ?? "0",
          10,
        ),
        topRelationships: relationshipsResult.rows.map((r) => ({
          name: r.name,
          revenue: num(r.revenue),
          orders: parseInt(r.orders, 10),
        })),
      },
    });
  } catch (err) {
    req.log.error({ err }, "store-analytics customer-insights failed");
    res.status(500).json({ error: "Failed to compute analytics" });
  }
});

/**
 * GET /store-analytics/operations
 *
 * Section 10 — Operations Analytics. Internal operational visibility over the
 * order pipeline (status mix, unassigned / without-florist / without-driver,
 * edited-after-creation, manual discounts, customer-service & POS orders) plus
 * cash / offline rollups (walk-in / cash / card sales, custom-price orders,
 * cash expenses, cash open/close, variance, sales by agent, orders by shop).
 *
 * Order-derived cards honor the full shared filter bar (date + country / city /
 * brand / channel) via the same filtered-order set as the other sections. Cash
 * / workshop rollups have no country/city/brand/channel dimension, so they honor
 * only the selected date range. All amounts are USD (cash amounts are converted
 * from their drawer / sale currency via the workspace's stored FX rates).
 */
router.get("/store-analytics/operations", async (req, res) => {
  const wreq = workspace(req);
  const ownerId = wreq.workspaceOwnerId;

  const range = resolveRange(req.query.from, req.query.to);
  const filters = parseAnalyticsFilters(req);

  const { sql: filterSql, params: filterParams } = buildFilterConditions(
    filters,
    ownerId,
    4,
  );
  // Operations-specific filtered order set: exposes the extra columns the order
  // cards need (source, location, discount, timestamps) while applying the same
  // shared filter conditions as filteredOrdersCte.
  const opCte = `
    WITH filtered AS (
      SELECT
        o.id,
        o.status,
        o.channel,
        o.source,
        o.location_id,
        o.created_at,
        o.updated_at,
        NULLIF(o.totals->>'discount', '')::numeric AS discount_amt,
        COALESCE(pay.paid_usd, NULLIF(o.totals->>'total', '')::numeric, 0) AS revenue_usd
      FROM orders o
      LEFT JOIN (
        SELECT order_id, SUM(amount_usd) AS paid_usd
        FROM order_payment
        WHERE amount_usd IS NOT NULL
        GROUP BY order_id
      ) pay ON pay.order_id = o.id
      WHERE o.workspace_owner_id = $1
        AND o.ordered_at >= $2
        AND o.ordered_at < $3
        ${filterSql}
    )
  `;
  const baseParams = [ownerId, range.from, range.to, ...filterParams];

  try {
    // Build the (currency → rate-to-USD) lookup for the cash / workshop rollups.
    const cashCurrencies = await db.query<{ cur: string }>(
      `SELECT DISTINCT upper(currency) AS cur
         FROM (
           SELECT currency FROM cash_transactions
             WHERE workspace_owner_id = $1 AND transaction_date >= $2 AND transaction_date < $3
           UNION SELECT currency FROM cash_sessions
             WHERE workspace_owner_id = $1 AND opened_at >= $2 AND opened_at < $3
           UNION SELECT currency FROM workshop_sales
             WHERE workspace_owner_id = $1 AND created_at >= $2 AND created_at < $3
           UNION SELECT currency FROM workshop_sale_payments
             WHERE workspace_owner_id = $1 AND paid_at >= $2 AND paid_at < $3
         ) c
        WHERE currency IS NOT NULL AND currency <> ''`,
      [ownerId, range.from, range.to],
    );
    const fxPairs: Array<[string, number]> = [];
    for (const { cur } of cashCurrencies.rows) {
      if (!/^[A-Z]{3}$/.test(cur)) continue;
      if (cur === "USD") {
        fxPairs.push(["USD", 1]);
        continue;
      }
      const rate = await getStoredRate(cur, "USD", ownerId);
      if (rate && Number.isFinite(rate.rate) && rate.rate > 0) {
        fxPairs.push([cur, rate.rate]);
      }
    }
    if (!fxPairs.some(([c]) => c === "USD")) fxPairs.push(["USD", 1]);
    // `rate` is a server-derived number; `cur` is validated to [A-Z]{3} above.
    // Unknown/unconvertible currencies fall back to a rate of 1 via COALESCE.
    const fxCte = `fx(cur, rate) AS (VALUES ${fxPairs
      .map(([c, r]) => `('${c}', '${r}'::numeric)`)
      .join(", ")})`;
    const cashParams = [ownerId, range.from, range.to];

    const [
      summaryResult,
      byStatusResult,
      bySourceResult,
      byChannelResult,
      byLocationResult,
      cashTxResult,
      cashSessionResult,
      workshopResult,
      paymentsByMethodResult,
      salesByAgentResult,
      punctualityResult,
    ] = await Promise.all([
      // Headline operational counts (order-derived).
      db.query<{
        total: string;
        pending: string;
        without_florist: string;
        without_driver: string;
        unassigned: string;
        edited: string;
        manual_discount_orders: string;
        manual_discount_total: string;
        pos_orders: string;
        customer_service_orders: string;
      }>(
        `${opCte}
         SELECT
           COUNT(*) AS total,
           COUNT(*) FILTER (WHERE status = 'pending') AS pending,
           COUNT(*) FILTER (
             WHERE NOT EXISTS (SELECT 1 FROM order_florist_assignments fa WHERE fa.order_id = filtered.id)
           ) AS without_florist,
           COUNT(*) FILTER (
             WHERE NOT EXISTS (SELECT 1 FROM fleet_driver_order_assignments da WHERE da.order_id = filtered.id)
           ) AS without_driver,
           COUNT(*) FILTER (
             WHERE NOT EXISTS (SELECT 1 FROM order_florist_assignments fa WHERE fa.order_id = filtered.id)
               AND NOT EXISTS (SELECT 1 FROM fleet_driver_order_assignments da WHERE da.order_id = filtered.id)
           ) AS unassigned,
           COUNT(*) FILTER (
             WHERE EXISTS (SELECT 1 FROM order_events oe WHERE oe.order_id = filtered.id)
           ) AS edited,
           COUNT(*) FILTER (WHERE discount_amt IS NOT NULL AND discount_amt > 0) AS manual_discount_orders,
           COALESCE(SUM(discount_amt) FILTER (WHERE discount_amt IS NOT NULL AND discount_amt > 0), 0) AS manual_discount_total,
           COUNT(*) FILTER (
             WHERE lower(COALESCE(channel, '')) = 'pos' OR lower(source) = 'pos'
           ) AS pos_orders,
           COUNT(*) FILTER (
             WHERE lower(source) IN ('manual', 'offline', 'whatsapp', 'phone', 'instagram', 'messenger')
                OR lower(COALESCE(channel, '')) IN ('whatsapp', 'offline', 'phone', 'instagram', 'messenger')
           ) AS customer_service_orders
         FROM filtered`,
        baseParams,
      ),

      // Orders by status.
      db.query<{ status: string; count: string }>(
        `${opCte}
         SELECT status, COUNT(*) AS count
         FROM filtered
         GROUP BY status
         ORDER BY count DESC`,
        baseParams,
      ),

      // Orders by source.
      db.query<{ source: string; count: string }>(
        `${opCte}
         SELECT COALESCE(NULLIF(source, ''), 'unknown') AS source, COUNT(*) AS count
         FROM filtered
         GROUP BY 1
         ORDER BY count DESC`,
        baseParams,
      ),

      // Orders by channel.
      db.query<{ channel: string; count: string }>(
        `${opCte}
         SELECT COALESCE(NULLIF(channel, ''), 'unknown') AS channel, COUNT(*) AS count
         FROM filtered
         GROUP BY 1
         ORDER BY count DESC`,
        baseParams,
      ),

      // Orders by shop / location (with valid revenue).
      db.query<{
        location_id: number | null;
        name: string | null;
        orders: string;
        revenue: string;
      }>(
        `${opCte}
         SELECT
           f.location_id,
           l.name,
           COUNT(*) AS orders,
           COALESCE(SUM(f.revenue_usd) FILTER (WHERE f.status NOT IN (${NON_REVENUE_SQL})), 0) AS revenue
         FROM filtered f
         LEFT JOIN locations l ON l.id = f.location_id
         GROUP BY f.location_id, l.name
         ORDER BY orders DESC`,
        baseParams,
      ),

      // Cash transactions rollup (cash sales in, expenses out) → USD.
      db.query<{ cash_sales: string; cash_expenses: string }>(
        `WITH ${fxCte}
         SELECT
           COALESCE(SUM(ct.amount * COALESCE(fx.rate, 1)) FILTER (WHERE ct.type = 'sale' AND ct.direction = 'in'), 0) AS cash_sales,
           COALESCE(SUM(ct.amount * COALESCE(fx.rate, 1)) FILTER (WHERE ct.type IN ('expense', 'bill') AND ct.direction = 'out'), 0) AS cash_expenses
         FROM cash_transactions ct
         LEFT JOIN fx ON fx.cur = upper(ct.currency)
         WHERE ct.workspace_owner_id = $1
           AND ct.transaction_date >= $2
           AND ct.transaction_date < $3
           AND ct.status = 'confirmed'`,
        cashParams,
      ),

      // Cash sessions rollup (open/close totals, variance) → USD.
      db.query<{
        sessions: string;
        open_sessions: string;
        closed_sessions: string;
        open_total: string;
        close_total: string;
        variance: string;
      }>(
        `WITH ${fxCte}
         SELECT
           COUNT(*) AS sessions,
           COUNT(*) FILTER (WHERE cs.status = 'open') AS open_sessions,
           COUNT(*) FILTER (WHERE cs.status IN ('closed', 'approved')) AS closed_sessions,
           COALESCE(SUM(cs.opening_cash * COALESCE(fx.rate, 1)), 0) AS open_total,
           COALESCE(SUM(cs.actual_cash * COALESCE(fx.rate, 1)) FILTER (WHERE cs.actual_cash IS NOT NULL), 0) AS close_total,
           COALESCE(SUM(cs.difference * COALESCE(fx.rate, 1)) FILTER (WHERE cs.difference IS NOT NULL), 0) AS variance
         FROM cash_sessions cs
         LEFT JOIN fx ON fx.cur = upper(cs.currency)
         WHERE cs.workspace_owner_id = $1
           AND cs.opened_at >= $2
           AND cs.opened_at < $3`,
        cashParams,
      ),

      // Walk-in / custom-price (workshop) sales → USD.
      db.query<{
        orders: string;
        total_usd: string;
        paid_usd: string;
        discount_usd: string;
      }>(
        `WITH ${fxCte}
         SELECT
           COUNT(*) AS orders,
           COALESCE(SUM(ws.total * COALESCE(fx.rate, 1)), 0) AS total_usd,
           COALESCE(SUM(ws.amount_paid * COALESCE(fx.rate, 1)), 0) AS paid_usd,
           COALESCE(SUM(ws.discount_total * COALESCE(fx.rate, 1)), 0) AS discount_usd
         FROM workshop_sales ws
         LEFT JOIN fx ON fx.cur = upper(ws.currency)
         WHERE ws.workspace_owner_id = $1
           AND ws.created_at >= $2
           AND ws.created_at < $3
           AND ws.status <> 'cancelled'`,
        cashParams,
      ),

      // Workshop payments split by method (cash vs card etc.) → USD.
      db.query<{ method: string; amount_usd: string; count: string }>(
        `WITH ${fxCte}
         SELECT
           lower(COALESCE(NULLIF(wsp.method, ''), 'other')) AS method,
           COALESCE(SUM(wsp.amount * COALESCE(fx.rate, 1)), 0) AS amount_usd,
           COUNT(*) AS count
         FROM workshop_sale_payments wsp
         LEFT JOIN fx ON fx.cur = upper(wsp.currency)
         WHERE wsp.workspace_owner_id = $1
           AND wsp.paid_at >= $2
           AND wsp.paid_at < $3
         GROUP BY 1
         ORDER BY amount_usd DESC`,
        cashParams,
      ),

      // Cash sales by agent (drawer sale transactions) → USD, agent name via
      // workspace_members lookup (best-effort; falls back to the clerk id).
      db.query<{ agent: string | null; email: string | null; amount_usd: string; count: string }>(
        `WITH ${fxCte}
         SELECT
           ct.created_by_clerk_id AS agent,
           wm.member_email AS email,
           COALESCE(SUM(ct.amount * COALESCE(fx.rate, 1)), 0) AS amount_usd,
           COUNT(*) AS count
         FROM cash_transactions ct
         LEFT JOIN fx ON fx.cur = upper(ct.currency)
         LEFT JOIN workspace_members wm
           ON wm.member_user_id = ct.created_by_clerk_id
          AND wm.workspace_owner_id = $1
         WHERE ct.workspace_owner_id = $1
           AND ct.transaction_date >= $2
           AND ct.transaction_date < $3
           AND ct.status = 'confirmed'
           AND ct.type = 'sale'
           AND ct.direction = 'in'
         GROUP BY ct.created_by_clerk_id, wm.member_email
         ORDER BY amount_usd DESC
         LIMIT 20`,
        cashParams,
      ),

      // Delivery punctuality inputs: completed orders with their completion
      // time (earliest status_changed→completed/delivered event, falling back
      // to tookan_delivered_at) plus the data needed to derive the deadline.
      // Classification (on-time vs late) happens in JS via classifyPunctuality.
      db.query<{
        id: string;
        display_order_number: string | null;
        ordered_at: Date | null;
        created_at: Date | null;
        window_end: Date | null;
        is_express: boolean;
        completed_at: Date | null;
      }>(
        `WITH filtered AS (
          SELECT
            o.id,
            o.display_order_number,
            o.ordered_at,
            o.created_at,
            o.window_end,
            lower(COALESCE(o.delivery_address->>'isExpress', '')) IN ('true', '1') AS is_express,
            o.tookan_delivered_at,
            o.status,
            o.channel,
            o.source,
            o.location_id
          FROM orders o
          WHERE o.workspace_owner_id = $1
            AND o.ordered_at >= $2
            AND o.ordered_at < $3
            ${filterSql}
        )
        SELECT
          f.id,
          f.display_order_number,
          f.ordered_at,
          f.created_at,
          f.window_end,
          f.is_express,
          COALESCE(ev.completed_at, f.tookan_delivered_at) AS completed_at
        FROM filtered f
        LEFT JOIN LATERAL (
          SELECT MIN(oe.created_at) AS completed_at
          FROM order_events oe
          WHERE oe.order_id = f.id
            AND oe.event_type = 'status_changed'
            AND lower(COALESCE(oe.payload->>'to', '')) IN ('completed', 'delivered')
        ) ev ON true
        WHERE COALESCE(ev.completed_at, f.tookan_delivered_at) IS NOT NULL
          AND (f.is_express OR f.window_end IS NOT NULL)`,
        baseParams,
      ),
    ]);

    const s = summaryResult.rows[0];
    const cashTx = cashTxResult.rows[0];
    const cashSess = cashSessionResult.rows[0];
    const ws = workshopResult.rows[0];

    // Classify the FULL filtered set so summary counts are exact; only the
    // drill-down list returned to the client is capped for payload size.
    const allPunctuality = punctualityResult.rows
      .map((r) => classifyPunctuality(r))
      .filter((p): p is NonNullable<typeof p> => p !== null)
      .sort((a, b) => b.minutesLate - a.minutesLate);
    const onTimeCount = allPunctuality.filter((p) => p.status === "on_time").length;
    const lateCount = allPunctuality.filter((p) => p.status === "late").length;
    const punctualityOrders = allPunctuality.slice(0, PUNCTUALITY_LIST_LIMIT);

    res.json({
      summary: {
        totalOrders: parseInt(s?.total ?? "0", 10),
        pendingOrders: parseInt(s?.pending ?? "0", 10),
        unassignedOrders: parseInt(s?.unassigned ?? "0", 10),
        ordersWithoutFlorist: parseInt(s?.without_florist ?? "0", 10),
        ordersWithoutDriver: parseInt(s?.without_driver ?? "0", 10),
        ordersEditedAfterCreation: parseInt(s?.edited ?? "0", 10),
        manualDiscountOrders: parseInt(s?.manual_discount_orders ?? "0", 10),
        manualDiscountTotalUsd: num(s?.manual_discount_total),
        customerServiceOrders: parseInt(s?.customer_service_orders ?? "0", 10),
        posOrders: parseInt(s?.pos_orders ?? "0", 10),
        onTimeOrders: onTimeCount,
        lateOrders: lateCount,
      },
      punctualityOrders,
      ordersByStatus: byStatusResult.rows.map((r) => ({
        status: r.status ?? "unknown",
        count: parseInt(r.count, 10),
      })),
      ordersBySource: bySourceResult.rows.map((r) => ({
        source: r.source,
        count: parseInt(r.count, 10),
      })),
      ordersByChannel: byChannelResult.rows.map((r) => ({
        channel: r.channel,
        count: parseInt(r.count, 10),
      })),
      ordersByLocation: byLocationResult.rows.map((r) => ({
        name:
          r.name ?? (r.location_id != null ? `Location ${r.location_id}` : "Unassigned"),
        orders: parseInt(r.orders, 10),
        revenueUsd: num(r.revenue),
      })),
      cash: {
        walkInSalesUsd: num(ws?.total_usd),
        walkInOrders: parseInt(ws?.orders ?? "0", 10),
        walkInPaidUsd: num(ws?.paid_usd),
        customPriceDiscountUsd: num(ws?.discount_usd),
        customPriceOrders: parseInt(ws?.orders ?? "0", 10),
        cashSalesUsd: num(cashTx?.cash_sales),
        cashExpensesUsd: num(cashTx?.cash_expenses),
        sessions: parseInt(cashSess?.sessions ?? "0", 10),
        openSessions: parseInt(cashSess?.open_sessions ?? "0", 10),
        closedSessions: parseInt(cashSess?.closed_sessions ?? "0", 10),
        cashOpenTotalUsd: num(cashSess?.open_total),
        cashCloseTotalUsd: num(cashSess?.close_total),
        cashVarianceUsd: num(cashSess?.variance),
      },
      paymentsByMethod: paymentsByMethodResult.rows.map((r) => ({
        method: r.method,
        amountUsd: num(r.amount_usd),
        count: parseInt(r.count, 10),
      })),
      salesByAgent: salesByAgentResult.rows.map((r) => ({
        agent: r.email ?? r.agent ?? "Unknown",
        salesUsd: num(r.amount_usd),
        count: parseInt(r.count, 10),
      })),
    });
  } catch (err) {
    req.log.error({ err }, "store-analytics operations failed");
    res.status(500).json({ error: "Failed to compute analytics" });
  }
});

/**
 * Canonical marketing-channel CASE expression from a lowercased source + medium
 * pair (each already coalesced to '' when null). Used for both order attribution
 * and website events so the two data sources bucket into the same channels.
 */
function channelCase(src: string, med: string): string {
  return `CASE
    WHEN ${src} ~ 'google' AND ${med} ~ 'cpc|ppc|paid|ads' THEN 'google_ads'
    WHEN ${src} ~ 'google' THEN 'organic'
    WHEN ${src} ~ 'facebook|meta|instagram' AND ${med} ~ 'cpc|ppc|paid|ads' THEN 'meta_ads'
    WHEN ${src} ~ 'facebook|meta|instagram' THEN 'meta_ads'
    WHEN ${src} ~ 'whatsapp' OR ${med} ~ 'whatsapp' THEN 'whatsapp'
    WHEN ${src} ~ 'email|newsletter|klaviyo|mailchimp|sendgrid' OR ${med} ~ 'email' THEN 'email'
    WHEN ${src} ~ 'influencer|creator|affiliate' OR ${med} ~ 'influencer|affiliate' THEN 'influencer'
    WHEN ${med} ~ 'organic' THEN 'organic'
    WHEN ${src} = '' AND ${med} = '' THEN 'direct'
    ELSE 'other'
  END`;
}

/**
 * Canonical marketing channel from an `ad_spend_entries.channel` free-text value.
 * Known channels normalise to the same keys as `channelCase`; anything else is
 * preserved (lowercased) so spend on niche channels still surfaces.
 */
function spendChannelCase(col: string): string {
  const c = `lower(${col})`;
  return `CASE
    WHEN ${c} ~ 'google' THEN 'google_ads'
    WHEN ${c} ~ 'meta|facebook|instagram' THEN 'meta_ads'
    WHEN ${c} ~ 'whatsapp' THEN 'whatsapp'
    WHEN ${c} ~ 'email|newsletter' THEN 'email'
    WHEN ${c} ~ 'influencer|affiliate' THEN 'influencer'
    WHEN ${c} ~ 'organic' THEN 'organic'
    WHEN ${c} ~ 'direct' THEN 'direct'
    ELSE ${c}
  END`;
}

// Order-attribution source/medium: last_touch preferred, first_touch fallback,
// then the top-level `source` string. Coalesced to '' so `channelCase` matches.
const ATTR_SRC = `lower(COALESCE(NULLIF(attr->'last_touch'->>'utm_source',''), NULLIF(attr->'first_touch'->>'utm_source',''), NULLIF(attr->>'source',''), ''))`;
const ATTR_MED = `lower(COALESCE(NULLIF(attr->'last_touch'->>'utm_medium',''), NULLIF(attr->'first_touch'->>'utm_medium',''), ''))`;
// Website-event source/medium.
const WE_SRC = `lower(COALESCE(NULLIF(we.utm_source,''), NULLIF(we.traffic_source,''), ''))`;
const WE_MED = `lower(COALESCE(NULLIF(we.utm_medium,''), ''))`;

const round2 = (n: number) => Math.round(n * 100) / 100;
const ratio = (num: number, den: number): number | null =>
  den > 0 ? round2(num / den) : null;
const pct = (num: number, den: number): number | null =>
  den > 0 ? round2((num / den) * 100) : null;

// ── Marketplace Analytics (Section 11) ─────────────────────────────────────

/** Canonical marketplace channels that charge a commission. */
const MARKETPLACE_CHANNELS = [
  "toters",
  "deliveroo",
  "careem",
  "talabat",
] as const;

/** All channel keys surfaced by the marketplace section, in display order. */
const MARKETPLACE_ALL_CHANNELS = [
  "website",
  "pos",
  "whatsapp",
  "toters",
  "deliveroo",
  "careem",
  "talabat",
  "other",
] as const;
type MarketplaceChannelKey = (typeof MARKETPLACE_ALL_CHANNELS)[number];

/** Default commission percentage per channel when not configured. */
const DEFAULT_COMMISSION_RATES: Record<MarketplaceChannelKey, number> = {
  website: 0,
  pos: 0,
  whatsapp: 0,
  toters: 30,
  deliveroo: 30,
  careem: 30,
  talabat: 30,
  other: 0,
};

/**
 * Bucket an order into a marketplace channel from its `channel`/`source`.
 * Marketplace strings win first, then owned channels, else 'other'. Reads both
 * `o.channel` (often unset) and `o.source` (the richer field).
 */
function marketplaceChannelCase(): string {
  const c = `lower(COALESCE(NULLIF(o.channel, ''), o.source, ''))`;
  const s = `lower(COALESCE(o.source, ''))`;
  return `CASE
    WHEN ${c} ~ 'toters' OR ${s} ~ 'toters' THEN 'toters'
    WHEN ${c} ~ 'deliveroo' OR ${s} ~ 'deliveroo' THEN 'deliveroo'
    WHEN ${c} ~ 'careem' OR ${s} ~ 'careem' THEN 'careem'
    WHEN ${c} ~ 'talabat' OR ${s} ~ 'talabat' THEN 'talabat'
    WHEN ${c} ~ 'whatsapp' THEN 'whatsapp'
    WHEN ${c} ~ 'pos' OR ${c} ~ 'walk' THEN 'pos'
    WHEN ${c} ~ 'website' OR ${c} ~ 'web' OR ${c} ~ 'external' OR ${c} ~ 'online' THEN 'website'
    ELSE 'other'
  END`;
}

/**
 * Effective per-channel commission rates: stored workspace overrides merged
 * over the code defaults, each clamped to [0, 100].
 */
async function getMarketplaceCommissionRates(
  ownerId: string,
): Promise<Record<MarketplaceChannelKey, number>> {
  const rates: Record<MarketplaceChannelKey, number> = {
    ...DEFAULT_COMMISSION_RATES,
  };
  const result = await db.query<{ marketplace_commission_rates: unknown }>(
    `SELECT marketplace_commission_rates
       FROM workspace_settings WHERE workspace_owner_id = $1`,
    [ownerId],
  );
  const stored = result.rows[0]?.marketplace_commission_rates;
  if (stored && typeof stored === "object") {
    for (const key of MARKETPLACE_ALL_CHANNELS) {
      const v = (stored as Record<string, unknown>)[key];
      if (typeof v === "number" && Number.isFinite(v)) {
        rates[key] = Math.max(0, Math.min(100, v));
      }
    }
  }
  return rates;
}

/**
 * GET /store-analytics/marketing
 *
 * Section 8 of the E-commerce Analytics page. Connects marketing ad spend to
 * revenue and gross margin so campaigns can be judged on gross-margin ROAS, not
 * just revenue ROAS. Source/UTM come from `orders.marketing_attribution`;
 * spend/clicks/impressions from `ad_spend_entries`; sessions/add-to-carts from
 * `web_events`. Returns per-source and per-campaign breakdowns (both revenue
 * ROAS and gross-margin ROAS), CAC, first-order CAC, repeat revenue by source,
 * plus promo-code and landing-page performance. All money is USD.
 */
router.get("/store-analytics/marketing", async (req, res) => {
  const wreq = workspace(req);
  const ownerId = wreq.workspaceOwnerId;

  const range = resolveRange(req.query.from, req.query.to);
  const compare = req.query.compare === "true" || req.query.compare === "1";
  const filters = parseAnalyticsFilters(req);
  const bucket = bucketFor(range);

  const { sql: filterSql, params: filterParams } = buildFilterConditions(
    filters,
    ownerId,
    4,
  );
  const baseParams = [ownerId, range.from, range.to, ...filterParams];

  const { sql: weFilterSql, params: weFilterParams } = webEventFilter(filters);
  const weBase = [ownerId, range.from, range.to, ...weFilterParams];

  // Per-order marketing CTE: valid orders with revenue, gross-margin COGS,
  // derived channel/campaign/landing-page and a first-vs-repeat flag.
  const orderMktCte = `
    WITH filtered AS (
      SELECT
        o.id, o.status, o.ordered_at, o.delivery_address,
        o.marketing_attribution AS attr,
        ${ORDER_REVENUE_USD} AS revenue_usd
      FROM orders o
      LEFT JOIN (
        SELECT order_id, SUM(amount_usd) AS paid_usd
        FROM order_payment WHERE amount_usd IS NOT NULL GROUP BY order_id
      ) pay ON pay.order_id = o.id
      WHERE o.workspace_owner_id = $1
        AND o.ordered_at >= $2
        AND o.ordered_at < $3
        ${filterSql}
    ),
    valid AS (
      SELECT * FROM filtered WHERE status NOT IN (${NON_REVENUE_SQL})
    ),
    order_cogs AS (
      SELECT
        li.order_id,
        SUM(li.quantity::numeric * cogs.cogs_usd)
          FILTER (WHERE cogs.cogs_usd IS NOT NULL) AS cogs_usd
      FROM order_line_items li
      JOIN valid v ON v.id = li.order_id
      LEFT JOIN LATERAL (
        SELECT p.id, p.workspace_owner_id
        FROM products p
        WHERE p.workspace_owner_id = $1
          AND (
            lower(COALESCE(li.name, '')) = lower(p.name)
            OR (li.product_id IS NOT NULL AND li.product_id = p.id)
          )
        ORDER BY (li.product_id IS NOT NULL AND li.product_id = p.id) DESC
        LIMIT 1
      ) p ON true
      LEFT JOIN LATERAL (
        SELECT
          CASE
            WHEN COUNT(pr.base_item_id) = 0 THEN NULL
            WHEN COUNT(pr.base_item_id) FILTER (
              WHERE bis.price IS NOT NULL AND bis.currency = 'USD'
            ) = COUNT(pr.base_item_id)
            THEN SUM(pr.quantity::numeric * bis.price::numeric)
            ELSE NULL
          END AS cogs_usd
        FROM product_recipes pr
        LEFT JOIN base_item_suppliers bis
          ON bis.base_item_id = pr.base_item_id
         AND bis.workspace_owner_id = pr.workspace_owner_id
         AND bis.is_preferred = true
        WHERE pr.product_id = p.id
          AND pr.workspace_owner_id = p.workspace_owner_id
      ) cogs ON true
      GROUP BY li.order_id
    ),
    order_first AS (
      SELECT DISTINCT ON (v.id) v.id,
        NOT EXISTS (
          SELECT 1
          FROM order_contacts oc2
          JOIN orders o2 ON o2.id = oc2.order_id
          WHERE oc2.contact_id = oc.contact_id
            AND oc2.role = 'customer'
            AND o2.workspace_owner_id = $1
            AND o2.ordered_at < v.ordered_at
        ) AS is_first
      FROM valid v
      JOIN order_contacts oc ON oc.order_id = v.id AND oc.role = 'customer'
      ORDER BY v.id
    ),
    order_mkt AS (
      SELECT
        v.id,
        v.revenue_usd,
        ${channelCase(ATTR_SRC, ATTR_MED)} AS channel,
        NULLIF(COALESCE(
          v.attr->'last_touch'->>'utm_campaign',
          v.attr->'first_touch'->>'utm_campaign'
        ), '') AS campaign,
        NULLIF(COALESCE(
          v.attr->'last_touch'->>'landing_page_path',
          v.attr->'first_touch'->>'landing_page_path'
        ), '') AS landing_page,
        COALESCE(oc.cogs_usd, 0) AS cogs_usd,
        COALESCE(ofr.is_first, true) AS is_first,
        (v.attr IS NOT NULL) AS has_attr
      FROM valid v
      LEFT JOIN order_cogs oc ON oc.order_id = v.id
      LEFT JOIN order_first ofr ON ofr.id = v.id
    )
  `;

  try {
    // FX for ad-spend currencies (spend may be recorded in AED etc.).
    const spendCurrencies = await db.query<{ cur: string }>(
      `SELECT DISTINCT upper(COALESCE(NULLIF(currency, ''), 'AED')) AS cur
         FROM ad_spend_entries
        WHERE workspace_owner_id = $1
          AND period_end >= $2::date
          AND period_start < $3::date`,
      [ownerId, range.from, range.to],
    );
    const fxPairs: Array<[string, number]> = [];
    for (const { cur } of spendCurrencies.rows) {
      if (!/^[A-Z]{3}$/.test(cur)) continue;
      if (cur === "USD") {
        fxPairs.push(["USD", 1]);
        continue;
      }
      const rate = await getStoredRate(cur, "USD", ownerId);
      if (rate && Number.isFinite(rate.rate) && rate.rate > 0) {
        fxPairs.push([cur, rate.rate]);
      }
    }
    if (!fxPairs.some(([c]) => c === "USD")) fxPairs.push(["USD", 1]);
    const fxCte = `fx(cur, rate) AS (VALUES ${fxPairs
      .map(([c, r]) => `('${c}', '${r}'::numeric)`)
      .join(", ")})`;

    const spendDateParams = [ownerId, range.from, range.to];

    const [
      bySourceResult,
      campaignOrdersResult,
      landingPagesResult,
      promoResult,
      attrCountResult,
      spendByChannelResult,
      spendByCampaignResult,
      weByChannelResult,
      weByCampaignResult,
      weTotalResult,
    ] = await Promise.all([
      // Revenue / orders / margin / first-vs-repeat by channel (order-derived).
      db.query<{
        channel: string;
        orders: string;
        first_orders: string;
        revenue: string;
        repeat_revenue: string;
        cogs: string;
      }>(
        `${orderMktCte}
         SELECT
           channel,
           COUNT(*) AS orders,
           COUNT(*) FILTER (WHERE is_first) AS first_orders,
           COALESCE(SUM(revenue_usd), 0) AS revenue,
           COALESCE(SUM(revenue_usd) FILTER (WHERE NOT is_first), 0) AS repeat_revenue,
           COALESCE(SUM(cogs_usd), 0) AS cogs
         FROM order_mkt
         GROUP BY channel`,
        baseParams,
      ),

      // Orders / revenue / margin by (channel, campaign) (order-derived).
      db.query<{
        channel: string;
        campaign: string;
        orders: string;
        revenue: string;
        cogs: string;
      }>(
        `${orderMktCte}
         SELECT
           channel,
           COALESCE(campaign, '(none)') AS campaign,
           COUNT(*) AS orders,
           COALESCE(SUM(revenue_usd), 0) AS revenue,
           COALESCE(SUM(cogs_usd), 0) AS cogs
         FROM order_mkt
         GROUP BY channel, COALESCE(campaign, '(none)')`,
        baseParams,
      ),

      // Landing-page performance (order-derived).
      db.query<{ path: string; orders: string; revenue: string }>(
        `${orderMktCte}
         SELECT landing_page AS path,
           COUNT(*) AS orders,
           COALESCE(SUM(revenue_usd), 0) AS revenue
         FROM order_mkt
         WHERE landing_page IS NOT NULL
         GROUP BY landing_page
         ORDER BY revenue DESC
         LIMIT 10`,
        baseParams,
      ),

      // Promo-code performance (order-derived).
      db.query<{
        code: string;
        redemptions: string;
        discount: string;
        revenue: string;
      }>(
        `${orderMktCte}
         SELECT
           c.code AS code,
           COUNT(*) AS redemptions,
           COALESCE(SUM(cr.discount_amount_usd), 0) AS discount,
           COALESCE(SUM(om.revenue_usd), 0) AS revenue
         FROM coupon_redemptions cr
         JOIN order_mkt om ON om.id = cr.order_id
         JOIN coupons c ON c.id = cr.coupon_id
         GROUP BY c.code
         ORDER BY revenue DESC
         LIMIT 20`,
        baseParams,
      ),

      // Whether any orders carry marketing attribution at all.
      db.query<{ attributed: string }>(
        `${orderMktCte}
         SELECT COUNT(*) FILTER (WHERE has_attr) AS attributed
         FROM order_mkt`,
        baseParams,
      ),

      // Ad spend by channel (USD via FX).
      db.query<{
        channel: string;
        spend: string;
        clicks: string;
        impressions: string;
      }>(
        `WITH ${fxCte}
         SELECT
           ${spendChannelCase("a.channel")} AS channel,
           COALESCE(SUM(a.spend_amount * COALESCE(fx.rate, 1)), 0) AS spend,
           COALESCE(SUM(a.clicks), 0) AS clicks,
           COALESCE(SUM(a.impressions), 0) AS impressions
         FROM ad_spend_entries a
         LEFT JOIN fx ON fx.cur = upper(COALESCE(NULLIF(a.currency, ''), 'AED'))
         WHERE a.workspace_owner_id = $1
           AND a.period_end >= $2::date
           AND a.period_start < $3::date
         GROUP BY 1`,
        spendDateParams,
      ),

      // Ad spend by (channel, campaign) (USD via FX).
      db.query<{
        channel: string;
        campaign: string;
        spend: string;
        clicks: string;
        impressions: string;
      }>(
        `WITH ${fxCte}
         SELECT
           ${spendChannelCase("a.channel")} AS channel,
           COALESCE(NULLIF(a.campaign, ''), '(none)') AS campaign,
           COALESCE(SUM(a.spend_amount * COALESCE(fx.rate, 1)), 0) AS spend,
           COALESCE(SUM(a.clicks), 0) AS clicks,
           COALESCE(SUM(a.impressions), 0) AS impressions
         FROM ad_spend_entries a
         LEFT JOIN fx ON fx.cur = upper(COALESCE(NULLIF(a.currency, ''), 'AED'))
         WHERE a.workspace_owner_id = $1
           AND a.period_end >= $2::date
           AND a.period_start < $3::date
         GROUP BY 1, 2`,
        spendDateParams,
      ),

      // Website sessions + add-to-carts by channel (event-derived).
      db.query<{ channel: string; sessions: string; add_to_carts: string }>(
        `SELECT
           ${channelCase(WE_SRC, WE_MED)} AS channel,
           COUNT(DISTINCT we.session_id) AS sessions,
           COUNT(*) FILTER (WHERE we.event_type = 'add_to_cart') AS add_to_carts
         FROM web_events we
         WHERE we.workspace_owner_id = $1
           AND we.occurred_at >= $2
           AND we.occurred_at < $3
           ${weFilterSql}
         GROUP BY 1`,
        weBase,
      ),

      // Website sessions + add-to-carts by (channel, campaign) (event-derived).
      db.query<{
        channel: string;
        campaign: string;
        sessions: string;
        add_to_carts: string;
      }>(
        `SELECT
           ${channelCase(WE_SRC, WE_MED)} AS channel,
           COALESCE(NULLIF(we.utm_campaign, ''), '(none)') AS campaign,
           COUNT(DISTINCT we.session_id) AS sessions,
           COUNT(*) FILTER (WHERE we.event_type = 'add_to_cart') AS add_to_carts
         FROM web_events we
         WHERE we.workspace_owner_id = $1
           AND we.occurred_at >= $2
           AND we.occurred_at < $3
           ${weFilterSql}
         GROUP BY 1, 2`,
        weBase,
      ),

      // Website totals (event-derived).
      db.query<{ sessions: string; add_to_carts: string }>(
        `SELECT
           COUNT(DISTINCT we.session_id) AS sessions,
           COUNT(*) FILTER (WHERE we.event_type = 'add_to_cart') AS add_to_carts
         FROM web_events we
         WHERE we.workspace_owner_id = $1
           AND we.occurred_at >= $2
           AND we.occurred_at < $3
           ${weFilterSql}`,
        weBase,
      ),
    ]);

    // ---- Merge per-source data keyed by channel ----
    type SourceAgg = {
      channel: string;
      revenueUsd: number;
      orders: number;
      firstOrders: number;
      repeatRevenueUsd: number;
      grossMarginUsd: number;
      spendUsd: number;
      clicks: number;
      sessions: number;
    };
    const sources = new Map<string, SourceAgg>();
    const source = (channel: string): SourceAgg => {
      let s = sources.get(channel);
      if (!s) {
        s = {
          channel,
          revenueUsd: 0,
          orders: 0,
          firstOrders: 0,
          repeatRevenueUsd: 0,
          grossMarginUsd: 0,
          spendUsd: 0,
          clicks: 0,
          sessions: 0,
        };
        sources.set(channel, s);
      }
      return s;
    };

    for (const r of bySourceResult.rows) {
      const s = source(r.channel);
      s.revenueUsd = num(r.revenue);
      s.orders = parseInt(r.orders, 10);
      s.firstOrders = parseInt(r.first_orders, 10);
      s.repeatRevenueUsd = num(r.repeat_revenue);
      s.grossMarginUsd = num(r.revenue) - num(r.cogs);
    }
    for (const r of spendByChannelResult.rows) {
      const s = source(r.channel);
      s.spendUsd = num(r.spend);
      s.clicks = parseInt(r.clicks, 10);
    }
    for (const r of weByChannelResult.rows) {
      const s = source(r.channel);
      s.sessions = parseInt(r.sessions, 10);
    }

    const bySource = Array.from(sources.values())
      .map((s) => ({
        channel: s.channel,
        revenueUsd: round2(s.revenueUsd),
        orders: s.orders,
        firstOrders: s.firstOrders,
        repeatRevenueUsd: round2(s.repeatRevenueUsd),
        grossMarginUsd: round2(s.grossMarginUsd),
        spendUsd: round2(s.spendUsd),
        clicks: s.clicks,
        sessions: s.sessions,
        conversionRate: pct(s.orders, s.sessions),
        cac: ratio(s.spendUsd, s.orders),
        firstOrderCac: ratio(s.spendUsd, s.firstOrders),
        revenueRoas: ratio(s.revenueUsd, s.spendUsd),
        grossMarginRoas: ratio(s.grossMarginUsd, s.spendUsd),
      }))
      .sort((a, b) => b.revenueUsd - a.revenueUsd);

    // ---- Merge per-campaign data keyed by channel + campaign ----
    type CampAgg = {
      channel: string;
      campaign: string;
      spendUsd: number;
      clicks: number;
      sessions: number;
      addToCarts: number;
      orders: number;
      revenueUsd: number;
      grossMarginUsd: number;
    };
    const camps = new Map<string, CampAgg>();
    const campKey = (ch: string, ca: string) => `${ch}\u0000${ca}`;
    const camp = (ch: string, ca: string): CampAgg => {
      const k = campKey(ch, ca);
      let c = camps.get(k);
      if (!c) {
        c = {
          channel: ch,
          campaign: ca,
          spendUsd: 0,
          clicks: 0,
          sessions: 0,
          addToCarts: 0,
          orders: 0,
          revenueUsd: 0,
          grossMarginUsd: 0,
        };
        camps.set(k, c);
      }
      return c;
    };

    for (const r of campaignOrdersResult.rows) {
      const c = camp(r.channel, r.campaign);
      c.orders = parseInt(r.orders, 10);
      c.revenueUsd = num(r.revenue);
      c.grossMarginUsd = num(r.revenue) - num(r.cogs);
    }
    for (const r of spendByCampaignResult.rows) {
      const c = camp(r.channel, r.campaign);
      c.spendUsd = num(r.spend);
      c.clicks = parseInt(r.clicks, 10);
    }
    for (const r of weByCampaignResult.rows) {
      const c = camp(r.channel, r.campaign);
      c.sessions = parseInt(r.sessions, 10);
      c.addToCarts = parseInt(r.add_to_carts, 10);
    }

    const campaigns = Array.from(camps.values())
      .map((c) => ({
        channel: c.channel,
        campaign: c.campaign,
        spendUsd: round2(c.spendUsd),
        clicks: c.clicks,
        sessions: c.sessions,
        addToCarts: c.addToCarts,
        orders: c.orders,
        revenueUsd: round2(c.revenueUsd),
        grossMarginUsd: round2(c.grossMarginUsd),
        revenueRoas: ratio(c.revenueUsd, c.spendUsd),
        grossMarginRoas: ratio(c.grossMarginUsd, c.spendUsd),
        cac: ratio(c.spendUsd, c.orders),
      }))
      .sort((a, b) => b.spendUsd - a.spendUsd || b.revenueUsd - a.revenueUsd);

    // ---- Totals ----
    const totalRevenue = bySource.reduce((s, r) => s + r.revenueUsd, 0);
    const totalOrders = bySource.reduce((s, r) => s + r.orders, 0);
    const totalFirstOrders = bySource.reduce((s, r) => s + r.firstOrders, 0);
    const totalRepeatRevenue = bySource.reduce(
      (s, r) => s + r.repeatRevenueUsd,
      0,
    );
    const totalGrossMargin = bySource.reduce((s, r) => s + r.grossMarginUsd, 0);
    const totalSpend = spendByChannelResult.rows.reduce(
      (s, r) => s + num(r.spend),
      0,
    );
    const totalClicks = spendByChannelResult.rows.reduce(
      (s, r) => s + parseInt(r.clicks, 10),
      0,
    );
    const totalImpressions = spendByChannelResult.rows.reduce(
      (s, r) => s + parseInt(r.impressions, 10),
      0,
    );
    const totalSessions = parseInt(weTotalResult.rows[0]?.sessions ?? "0", 10);
    const totalAddToCarts = parseInt(
      weTotalResult.rows[0]?.add_to_carts ?? "0",
      10,
    );

    const spendTracked = spendByChannelResult.rows.length > 0;
    const attributionTracked =
      parseInt(attrCountResult.rows[0]?.attributed ?? "0", 10) > 0;
    const eventsTracked = totalSessions > 0;

    res.json({
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      comparison: compare
        ? (() => {
            const p = previousRange(range);
            return { from: p.from.toISOString(), to: p.to.toISOString() };
          })()
        : null,
      bucket,
      spendTracked,
      attributionTracked,
      eventsTracked,
      totals: {
        revenueUsd: round2(totalRevenue),
        orders: totalOrders,
        firstOrders: totalFirstOrders,
        repeatRevenueUsd: round2(totalRepeatRevenue),
        grossMarginUsd: round2(totalGrossMargin),
        grossMarginPct: pct(totalGrossMargin, totalRevenue),
        spendUsd: round2(totalSpend),
        clicks: totalClicks,
        impressions: totalImpressions,
        sessions: totalSessions,
        addToCarts: totalAddToCarts,
        cac: ratio(totalSpend, totalOrders),
        firstOrderCac: ratio(totalSpend, totalFirstOrders),
        revenueRoas: ratio(totalRevenue, totalSpend),
        grossMarginRoas: ratio(totalGrossMargin, totalSpend),
        conversionRate: pct(totalOrders, totalSessions),
      },
      bySource,
      campaigns,
      promoPerformance: promoResult.rows.map((r) => ({
        code: r.code,
        redemptions: parseInt(r.redemptions, 10),
        discountUsd: round2(num(r.discount)),
        revenueUsd: round2(num(r.revenue)),
      })),
      landingPages: landingPagesResult.rows.map((r) => ({
        path: r.path,
        orders: parseInt(r.orders, 10),
        revenueUsd: round2(num(r.revenue)),
      })),
    });
  } catch (err) {
    req.log.error({ err }, "store-analytics marketing failed");
    res.status(500).json({ error: "Failed to compute analytics" });
  }
});
/**
 * Inner LATERAL join that resolves exactly one product per line item, matched
 * by product_id (preferred) or case-insensitive name. Unmatched line items are
 * dropped. Exposes `p.id`, `p.name`, and `p.workspace_owner_id` (the latter two
 * consumed by ${COGS_LATERAL}). Owner id is always placeholder $1.
 */
const PRODUCT_MATCH_LATERAL = `
  JOIN LATERAL (
    SELECT p.id, p.name, p.main_image_url, p.workspace_owner_id
    FROM products p
    WHERE p.workspace_owner_id = $1
      AND (
        lower(COALESCE(li.name, '')) = lower(p.name)
        OR (li.product_id IS NOT NULL AND li.product_id = p.id)
      )
    ORDER BY (li.product_id IS NOT NULL AND li.product_id = p.id) DESC
    LIMIT 1
  ) p ON true`;

/**
 * LEFT LATERAL join computing a matched product's USD cost of goods (`cogs_usd`)
 * from its recipe. NULL when the recipe is empty or any item lacks a USD
 * preferred-supplier price. Requires a preceding `p` alias (see
 * ${PRODUCT_MATCH_LATERAL}).
 */
const COGS_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT
      CASE
        WHEN COUNT(pr.base_item_id) = 0 THEN NULL
        WHEN COUNT(pr.base_item_id) FILTER (
          WHERE bis.price IS NOT NULL AND bis.currency = 'USD'
        ) = COUNT(pr.base_item_id)
        THEN SUM(pr.quantity::numeric * bis.price::numeric)
        ELSE NULL
      END AS cogs_usd
    FROM product_recipes pr
    LEFT JOIN base_item_suppliers bis
      ON bis.base_item_id = pr.base_item_id
     AND bis.workspace_owner_id = pr.workspace_owner_id
     AND bis.is_preferred = true
    WHERE pr.product_id = p.id
      AND pr.workspace_owner_id = p.workspace_owner_id
  ) cogs ON true`;

type ProductAggRow = {
  id: number;
  name: string;
  main_image_url: string | null;
  revenue: string;
  quantity: string;
  cogs: string | null;
  orders_total: string;
  orders_cancelled: string;
};

function mapProductRow(r: ProductAggRow) {
  const revenue = num(r.revenue);
  const cogs = r.cogs != null ? num(r.cogs) : null;
  const ordersTotal = parseInt(r.orders_total, 10);
  const ordersCancelled = parseInt(r.orders_cancelled, 10);
  const marginUsd = cogs != null ? revenue - cogs : null;
  const marginPct =
    marginUsd != null && revenue > 0 ? (marginUsd / revenue) * 100 : null;
  return {
    id: r.id,
    name: r.name,
    mainImageUrl: r.main_image_url ?? null,
    revenue,
    quantity: num(r.quantity),
    marginUsd,
    marginPct,
    refundRate: ordersTotal > 0 ? (ordersCancelled / ordersTotal) * 100 : 0,
    orders: ordersTotal,
  };
}

/**
 * GET /store-analytics/product-performance
 *
 * Section 3 of the E-commerce Analytics page. Reveals what is selling and what
 * is profitable: best/worst sellers with revenue, quantity, margin and
 * refund/cancellation rate; per-city product performance (orders + margin); and
 * the product mix by catalog category (revenue share). View / add-to-cart /
 * conversion metrics are aggregated from storefront web events (product_view /
 * add_to_cart / purchase-completion) when the website has pushed them; the
 * tracking flags report whether such events exist in the selected range. Web
 * events honor the date range plus country/city/brand filters (channel has no
 * web-event equivalent). All money is USD.
 */
router.get("/store-analytics/product-performance", async (req, res) => {
  const wreq = workspace(req);
  const ownerId = wreq.workspaceOwnerId;

  const range = resolveRange(req.query.from, req.query.to);
  const filters = parseAnalyticsFilters(req);

  const { sql: cte, params: filterParams } = filteredOrdersCte(ownerId, filters);
  const baseParams = [ownerId, range.from, range.to, ...filterParams];

  // Website-event totals (views / add-to-carts / purchase completions) for the
  // range. Separate param list: web events use their own filter mapping.
  const we = buildWebEventFilters(filters, 4);
  const eventTotalsSql = `
    SELECT
      COUNT(*) FILTER (WHERE we.event_type = 'product_view') AS views,
      COUNT(*) FILTER (WHERE we.event_type = 'add_to_cart') AS carts,
      COUNT(*) FILTER (WHERE we.event_type IN ('order_created', 'purchase', 'payment_completed')) AS purchases
    FROM web_events we
    WHERE we.workspace_owner_id = $1
      AND we.occurred_at >= $2
      AND we.occurred_at < $3
      ${we.sql}`;
  const eventParams = [ownerId, range.from, range.to, ...we.params];

  // Per-product aggregation over the filtered order set. Revenue / quantity /
  // cogs are summed only over revenue-bearing statuses; refund rate uses the
  // full order count (incl. cancelled/refunded) so it reflects the true share.
  const prodAggCte = `
    ${cte},
    prod_agg AS (
      SELECT
        p.id AS id,
        p.name AS name,
        p.main_image_url AS main_image_url,
        COALESCE(SUM(li.line_total::numeric)
          FILTER (WHERE f.status NOT IN (${NON_REVENUE_SQL})), 0) AS revenue,
        COALESCE(SUM(li.quantity::numeric)
          FILTER (WHERE f.status NOT IN (${NON_REVENUE_SQL})), 0) AS quantity,
        SUM(li.quantity::numeric * cogs.cogs_usd)
          FILTER (WHERE f.status NOT IN (${NON_REVENUE_SQL}) AND cogs.cogs_usd IS NOT NULL) AS cogs,
        COUNT(DISTINCT li.order_id) AS orders_total,
        COUNT(DISTINCT li.order_id) FILTER (WHERE f.status IN ('cancelled', 'refunded')) AS orders_cancelled
      FROM order_line_items li
      JOIN filtered f ON f.id = li.order_id
      ${PRODUCT_MATCH_LATERAL}
      ${COGS_LATERAL}
      GROUP BY p.id, p.name, p.main_image_url
    )
  `;

  try {
    const [topResult, bottomResult, byCityResult, categoryResult, eventResult] =
      await Promise.all([
        db.query<ProductAggRow>(
          `${prodAggCte}
           SELECT * FROM prod_agg
           ORDER BY orders_total DESC, revenue DESC
           LIMIT 15`,
          baseParams,
        ),
        db.query<ProductAggRow>(
          `${prodAggCte}
           SELECT * FROM prod_agg
           WHERE revenue > 0
           ORDER BY orders_total ASC, revenue ASC
           LIMIT 15`,
          baseParams,
        ),

        // Per-city product performance: order count + margin (revenue minus the
        // costed portion of line items) per delivery city.
        db.query<{
          city_id: string | null;
          name: string | null;
          orders: string;
          revenue: string;
          cogs: string | null;
        }>(
          `${cte},
           order_costs AS (
             SELECT
               li.order_id AS order_id,
               SUM(li.quantity::numeric * cogs.cogs_usd)
                 FILTER (WHERE cogs.cogs_usd IS NOT NULL) AS cogs
             FROM order_line_items li
             JOIN filtered f ON f.id = li.order_id AND f.status NOT IN (${NON_REVENUE_SQL})
             ${PRODUCT_MATCH_LATERAL}
             ${COGS_LATERAL}
             GROUP BY li.order_id
           )
           SELECT
             COALESCE(dc.id::text, f.delivery_address->>'cityId') AS city_id,
             dc.name AS name,
             COUNT(*) AS orders,
             COALESCE(SUM(f.revenue_usd), 0) AS revenue,
             SUM(oc.cogs) AS cogs
           FROM filtered f
           LEFT JOIN delivery_cities dc
             ON dc.workspace_owner_id = $1
            AND ${cityMatchSql(`f.delivery_address->>'cityId'`)}
           LEFT JOIN order_costs oc ON oc.order_id = f.id
           WHERE f.status NOT IN (${NON_REVENUE_SQL})
           GROUP BY 1, 2
           ORDER BY 3 DESC`,
          baseParams,
        ),

        // Product mix by catalog category (line-item revenue attributed via a
        // product's linked catalog categories).
        db.query<{ name: string; revenue: string; orders: string }>(
          `${cte}
           SELECT
             cc.name AS name,
             COALESCE(SUM(li.line_total::numeric), 0) AS revenue,
             COUNT(DISTINCT li.order_id) AS orders
           FROM order_line_items li
           JOIN filtered f ON f.id = li.order_id AND f.status NOT IN (${NON_REVENUE_SQL})
           ${PRODUCT_MATCH_LATERAL}
           JOIN product_catalog_categories pcc ON pcc.product_id = p.id
           JOIN catalog_categories cc ON cc.id = pcc.attribute_id
           GROUP BY cc.name
           ORDER BY 2 DESC`,
          baseParams,
        ),

        // Website-event totals for the tracking cards.
        db.query<{ views: string; carts: string; purchases: string }>(
          eventTotalsSql,
          eventParams,
        ),
      ]);

    const evRow = eventResult.rows[0];
    const views = evRow ? parseInt(evRow.views, 10) : 0;
    const carts = evRow ? parseInt(evRow.carts, 10) : 0;
    const purchases = evRow ? parseInt(evRow.purchases, 10) : 0;

    res.json({
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      topProducts: topResult.rows.map(mapProductRow),
      bottomProducts: bottomResult.rows.map(mapProductRow),
      byCity: byCityResult.rows.map((r) => {
        const revenue = num(r.revenue);
        const cogs = r.cogs != null ? num(r.cogs) : null;
        return {
          name: r.name ?? prettifyCitySlug(r.city_id) ?? "Unknown",
          orders: parseInt(r.orders, 10),
          revenue,
          marginUsd: cogs != null ? revenue - cogs : null,
        };
      }),
      categoryMix: categoryResult.rows.map((r) => ({
        name: r.name,
        revenue: num(r.revenue),
        orders: parseInt(r.orders, 10),
      })),
      // Website-event totals for the tracking cards. Rates are per product
      // view; null when there are no views in the range.
      events: {
        views,
        addToCarts: carts,
        purchases,
        addToCartRate: views > 0 ? (carts / views) * 100 : null,
        conversionRate: views > 0 ? (purchases / views) * 100 : null,
      },
      tracking: {
        views: views > 0,
        addToCart: views > 0,
        conversionRate: views > 0,
      },
    });
  } catch (err) {
    req.log.error({ err }, "store-analytics product-performance failed");
    res.status(500).json({ error: "Failed to compute analytics" });
  }
});

// ---- Search & Discovery event-type vocabularies (website events) ----
// The storefront may emit any of these synonyms; group them so the section is
// resilient to naming drift on the website side.
const SEARCH_TYPES = ["search", "search_query", "search_performed", "search_submitted"];
const NO_RESULT_TYPES = ["search_no_result", "search_no_results", "no_results_found", "search_empty"];
const RESULT_CLICK_TYPES = ["search_result_click", "search_result_clicked", "search_results_clicked"];
const CATEGORY_CLICK_TYPES = ["category_click", "category_view", "category_selected"];
const OCCASION_CLICK_TYPES = ["occasion_click", "occasion_view", "occasion_selected"];
const FILTER_TYPES = ["filter_selected", "filter_applied", "filter_used"];
const SORT_TYPES = ["sort_selected", "sort_applied", "sort_changed"];
const RECIPIENT_TYPES = ["recipient_selected", "recipient_click"];
const BRAND_SELECT_TYPES = ["brand_selected", "brand_click"];
const PRICE_RANGE_TYPES = ["price_range_selected", "price_filter_selected", "price_range_applied"];
const CONVERSION_TYPES = ["order_created", "purchase", "payment_completed", "checkout_completed"];

// `we`-qualified `event_type IN (...)` fragment for the single-table web-event
// queries below. Values are single-quoted via `sqlQuote`.
const weIn = (types: string[]) =>
  `we.event_type IN (${types.map(sqlQuote).join(", ")})`;

// The search term: the dedicated `search_query` column when populated, else
// the first non-empty term-like key inside the `properties` jsonb payload —
// the website historically pushed the term as a property (e.g. `query`,
// `search_term`, `q`) rather than the top-level field, so old rows only carry
// it there. Applied consistently to top terms, unique terms, no-result terms
// and click-through joins via TERM_EXPR/HAS_TERM below.
const RAW_TERM_EXPR = `COALESCE(
  NULLIF(trim(we.search_query), ''),
  NULLIF(trim(we.properties->>'query'), ''),
  NULLIF(trim(we.properties->>'search_term'), ''),
  NULLIF(trim(we.properties->>'searchTerm'), ''),
  NULLIF(trim(we.properties->>'searchQuery'), ''),
  NULLIF(trim(we.properties->>'search_query'), ''),
  NULLIF(trim(we.properties->>'term'), ''),
  NULLIF(trim(we.properties->>'q'), '')
)`;
// A non-empty, trimmed search term.
const TERM_EXPR = `lower(${RAW_TERM_EXPR})`;
const HAS_TERM = `${RAW_TERM_EXPR} IS NOT NULL`;

/**
 * GET /store-analytics/search-discovery
 *
 * Section 12 of the E-commerce Analytics page. Surfaces what customers search
 * for and how they navigate the storefront, entirely from `web_events`: top
 * search terms, no-result searches, search conversion, category/occasion
 * clicks, filter/sort usage, event-level counts, and a merchandising insight
 * (high-volume searches with weak/no matching results). Like the other
 * event-derived sections it honours only the date range + brand filter (web
 * events carry no country/city/channel dimension) and is gated behind
 * `eventsTracked`; the UI shows a "waiting for website events" state when empty.
 */
router.get("/store-analytics/search-discovery", async (req, res) => {
  const wreq = workspace(req);
  const ownerId = wreq.workspaceOwnerId;

  const range = resolveRange(req.query.from, req.query.to);
  const compare = req.query.compare === "true" || req.query.compare === "1";
  const filters = parseAnalyticsFilters(req);
  const bucket = bucketFor(range);

  const { sql: weFilterSql, params: weFilterParams } = webEventFilter(filters);
  const weBase = [ownerId, range.from, range.to, ...weFilterParams];

  // A "search action" is either a search-typed event or a no-result-typed event
  // (the latter represents a search that returned nothing). No-result searches
  // are those flagged by a no-result event OR a search event with result_count 0.
  const searchIn = weIn(SEARCH_TYPES);
  const noResultIn = weIn(NO_RESULT_TYPES);
  const searchAction = `(${searchIn} OR ${noResultIn})`;
  const noResultCond = `(${noResultIn} OR (${searchIn} AND we.result_count = 0))`;
  const resultClickIn = weIn(RESULT_CLICK_TYPES);
  const categoryIn = weIn(CATEGORY_CLICK_TYPES);
  const occasionIn = weIn(OCCASION_CLICK_TYPES);
  const filterIn = weIn(FILTER_TYPES);
  const sortIn = weIn(SORT_TYPES);
  const recipientIn = weIn(RECIPIENT_TYPES);
  const brandSelIn = weIn(BRAND_SELECT_TYPES);
  const priceIn = weIn(PRICE_RANGE_TYPES);
  const convIn = weIn(CONVERSION_TYPES);

  const whereBase = `we.workspace_owner_id = $1 AND we.occurred_at >= $2 AND we.occurred_at < $3`;

  try {
    const [
      overviewResult,
      conversionResult,
      topTermsResult,
      noResultTermsResult,
      gapsResult,
      categoryResult,
      occasionResult,
      filterResult,
      sortResult,
    ] = await Promise.all([
      // Event-level counts + totals.
      db.query<{
        searches: string;
        no_result_searches: string;
        result_clicks: string;
        filter_selected: string;
        sort_selected: string;
        occasion_selected: string;
        recipient_selected: string;
        brand_selected: string;
        price_range_selected: string;
        category_clicks: string;
        unique_terms: string;
      }>(
        `SELECT
           COUNT(*) FILTER (WHERE ${searchAction}) AS searches,
           COUNT(*) FILTER (WHERE ${noResultCond}) AS no_result_searches,
           COUNT(*) FILTER (WHERE ${resultClickIn}) AS result_clicks,
           COUNT(*) FILTER (WHERE ${filterIn}) AS filter_selected,
           COUNT(*) FILTER (WHERE ${sortIn}) AS sort_selected,
           COUNT(*) FILTER (WHERE ${occasionIn}) AS occasion_selected,
           COUNT(*) FILTER (WHERE ${recipientIn}) AS recipient_selected,
           COUNT(*) FILTER (WHERE ${brandSelIn}) AS brand_selected,
           COUNT(*) FILTER (WHERE ${priceIn}) AS price_range_selected,
           COUNT(*) FILTER (WHERE ${categoryIn}) AS category_clicks,
           COUNT(DISTINCT ${TERM_EXPR})
             FILTER (WHERE ${searchAction} AND ${HAS_TERM}) AS unique_terms
         FROM web_events we
         WHERE ${whereBase}
           ${weFilterSql}`,
        weBase,
      ),

      // Session-level search conversion: search sessions vs those that also
      // reached a conversion event. The conversion side is scoped by session
      // membership (not brand), since conversion events carry no brand.
      db.query<{ search_sessions: string; converted_sessions: string }>(
        `WITH search_sess AS (
           SELECT DISTINCT we.session_id
           FROM web_events we
           WHERE ${whereBase}
             AND ${searchAction}
             AND we.session_id IS NOT NULL
             ${weFilterSql}
         )
         SELECT
           (SELECT COUNT(*) FROM search_sess) AS search_sessions,
           (SELECT COUNT(DISTINCT we.session_id)
              FROM web_events we
              JOIN search_sess s ON s.session_id = we.session_id
              WHERE we.workspace_owner_id = $1
                AND we.occurred_at >= $2
                AND we.occurred_at < $3
                AND ${convIn}) AS converted_sessions`,
        weBase,
      ),

      // Top search terms with sessions, avg result count and result clicks.
      db.query<{
        term: string;
        searches: string;
        sessions: string;
        avg_result_count: string | null;
        clicks: string;
      }>(
        `SELECT
           ${TERM_EXPR} AS term,
           COUNT(*) FILTER (WHERE ${searchAction}) AS searches,
           COUNT(DISTINCT we.session_id) AS sessions,
           AVG(we.result_count) FILTER (WHERE we.result_count IS NOT NULL) AS avg_result_count,
           COUNT(*) FILTER (WHERE ${resultClickIn}) AS clicks
         FROM web_events we
         WHERE ${whereBase}
           AND ${HAS_TERM}
           AND (${searchAction} OR ${resultClickIn})
           ${weFilterSql}
         GROUP BY 1
         ORDER BY searches DESC, sessions DESC
         LIMIT 25`,
        weBase,
      ),

      // Searches that returned no results, by term.
      db.query<{ term: string; searches: string }>(
        `SELECT ${TERM_EXPR} AS term, COUNT(*) AS searches
         FROM web_events we
         WHERE ${whereBase}
           AND ${HAS_TERM}
           AND ${noResultCond}
           ${weFilterSql}
         GROUP BY 1
         ORDER BY searches DESC
         LIMIT 25`,
        weBase,
      ),

      // Merchandising gaps: high-volume terms whose searches surface weak/no
      // matching results (low average result count).
      db.query<{ term: string; searches: string; avg_result_count: string }>(
        `SELECT ${TERM_EXPR} AS term,
           COUNT(*) AS searches,
           AVG(we.result_count) AS avg_result_count
         FROM web_events we
         WHERE ${whereBase}
           AND ${HAS_TERM}
           AND ${searchAction}
           AND we.result_count IS NOT NULL
           ${weFilterSql}
         GROUP BY 1
         HAVING AVG(we.result_count) < 3
         ORDER BY searches DESC, avg_result_count ASC
         LIMIT 15`,
        weBase,
      ),

      // Category clicks.
      db.query<{ name: string; clicks: string }>(
        `SELECT
           COALESCE(NULLIF(we.category, ''), NULLIF(we.properties->>'category', '')) AS name,
           COUNT(*) AS clicks
         FROM web_events we
         WHERE ${whereBase}
           AND ${categoryIn}
           AND COALESCE(NULLIF(we.category, ''), NULLIF(we.properties->>'category', '')) IS NOT NULL
           ${weFilterSql}
         GROUP BY 1
         ORDER BY clicks DESC
         LIMIT 15`,
        weBase,
      ),

      // Occasion clicks.
      db.query<{ name: string; clicks: string }>(
        `SELECT
           COALESCE(NULLIF(we.occasion, ''), NULLIF(we.properties->>'occasion', '')) AS name,
           COUNT(*) AS clicks
         FROM web_events we
         WHERE ${whereBase}
           AND ${occasionIn}
           AND COALESCE(NULLIF(we.occasion, ''), NULLIF(we.properties->>'occasion', '')) IS NOT NULL
           ${weFilterSql}
         GROUP BY 1
         ORDER BY clicks DESC
         LIMIT 15`,
        weBase,
      ),

      // Filter usage, keyed by the filter type/name in properties.
      db.query<{ name: string; count: string }>(
        `SELECT
           COALESCE(
             NULLIF(we.properties->>'filterType', ''),
             NULLIF(we.properties->>'filter', ''),
             NULLIF(we.properties->>'name', ''),
             'other'
           ) AS name,
           COUNT(*) AS count
         FROM web_events we
         WHERE ${whereBase}
           AND ${filterIn}
           ${weFilterSql}
         GROUP BY 1
         ORDER BY count DESC
         LIMIT 15`,
        weBase,
      ),

      // Sort usage, keyed by the sort option in properties.
      db.query<{ name: string; count: string }>(
        `SELECT
           COALESCE(
             NULLIF(we.properties->>'sortOption', ''),
             NULLIF(we.properties->>'sort', ''),
             NULLIF(we.properties->>'sortKey', ''),
             NULLIF(we.properties->>'value', ''),
             'other'
           ) AS name,
           COUNT(*) AS count
         FROM web_events we
         WHERE ${whereBase}
           AND ${sortIn}
           ${weFilterSql}
         GROUP BY 1
         ORDER BY count DESC
         LIMIT 15`,
        weBase,
      ),
    ]);

    const ov = overviewResult.rows[0];
    const searches = parseInt(ov?.searches ?? "0", 10);
    const noResultSearches = parseInt(ov?.no_result_searches ?? "0", 10);
    const resultClicks = parseInt(ov?.result_clicks ?? "0", 10);
    const filterSelected = parseInt(ov?.filter_selected ?? "0", 10);
    const sortSelected = parseInt(ov?.sort_selected ?? "0", 10);
    const occasionSelected = parseInt(ov?.occasion_selected ?? "0", 10);
    const recipientSelected = parseInt(ov?.recipient_selected ?? "0", 10);
    const brandSelected = parseInt(ov?.brand_selected ?? "0", 10);
    const priceRangeSelected = parseInt(ov?.price_range_selected ?? "0", 10);
    const categoryClicks = parseInt(ov?.category_clicks ?? "0", 10);
    const uniqueTerms = parseInt(ov?.unique_terms ?? "0", 10);

    const searchSessions = parseInt(
      conversionResult.rows[0]?.search_sessions ?? "0",
      10,
    );
    const convertedSessions = parseInt(
      conversionResult.rows[0]?.converted_sessions ?? "0",
      10,
    );

    const searchTracked = searches > 0;
    const eventsTracked =
      searches > 0 ||
      resultClicks > 0 ||
      categoryClicks > 0 ||
      occasionSelected > 0 ||
      filterSelected > 0 ||
      sortSelected > 0 ||
      recipientSelected > 0 ||
      brandSelected > 0 ||
      priceRangeSelected > 0;

    res.json({
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      comparison: compare
        ? (() => {
            const p = previousRange(range);
            return { from: p.from.toISOString(), to: p.to.toISOString() };
          })()
        : null,
      bucket,
      searchTracked,
      eventsTracked,
      totals: {
        searches,
        searchSessions,
        noResultSearches,
        noResultRate: pct(noResultSearches, searches),
        resultClicks,
        clickThroughRate: pct(resultClicks, searches),
        searchConversionRate: pct(convertedSessions, searchSessions),
        uniqueTerms,
      },
      eventCounts: {
        searchQueryTyped: searches,
        searchResultsClicked: resultClicks,
        noResultsFound: noResultSearches,
        filterSelected,
        sortSelected,
        occasionSelected,
        recipientSelected,
        brandSelected,
        priceRangeSelected,
      },
      topSearchTerms: topTermsResult.rows.map((r) => {
        const s = parseInt(r.searches, 10);
        const clicks = parseInt(r.clicks, 10);
        return {
          term: r.term,
          searches: s,
          sessions: parseInt(r.sessions, 10),
          avgResultCount:
            r.avg_result_count == null ? null : round2(num(r.avg_result_count)),
          clicks,
          clickThroughRate: pct(clicks, s),
        };
      }),
      noResultTerms: noResultTermsResult.rows.map((r) => ({
        term: r.term,
        searches: parseInt(r.searches, 10),
      })),
      merchandisingGaps: gapsResult.rows.map((r) => ({
        term: r.term,
        searches: parseInt(r.searches, 10),
        avgResultCount: round2(num(r.avg_result_count)),
      })),
      categoryClicks: categoryResult.rows.map((r) => ({
        name: r.name,
        clicks: parseInt(r.clicks, 10),
      })),
      occasionClicks: occasionResult.rows.map((r) => ({
        name: r.name,
        clicks: parseInt(r.clicks, 10),
      })),
      filterUsage: filterResult.rows.map((r) => ({
        name: r.name,
        count: parseInt(r.count, 10),
      })),
      sortUsage: sortResult.rows.map((r) => ({
        name: r.name,
        count: parseInt(r.count, 10),
      })),
    });
  } catch (err) {
    req.log.error({ err }, "store-analytics search-discovery failed");
    res.status(500).json({ error: "Failed to compute analytics" });
  }
});

/**
 * GET /store-analytics/seo
 *
 * Section 13 of the E-commerce Analytics page. Brings SEO performance into the
 * suite: organic sessions/revenue/conversion (organic traffic derived from
 * `web_events` + `orders.marketing_attribution` via the shared `channelCase`),
 * top landing/category/occasion/brand pages, and Search-Console-style metrics
 * (impressions, clicks, CTR, average Google position) from owner-managed
 * `seo_metrics`. Also surfaces page-quality signals (low word count, missing
 * metadata, short titles, poor conversion) and prioritization views (SEO pages
 * by traffic/revenue/conversion, pages needing improvement). Content signals
 * (word count / title / meta description) are read from `web_events.properties`
 * when the storefront pushes them. All money is USD. `seo_metrics` carries no
 * country/city/channel dimensions, so only the date range applies to it.
 */
router.get("/store-analytics/seo", async (req, res) => {
  const wreq = workspace(req);
  const ownerId = wreq.workspaceOwnerId;

  const range = resolveRange(req.query.from, req.query.to);
  const compare = req.query.compare === "true" || req.query.compare === "1";
  const filters = parseAnalyticsFilters(req);
  const bucket = bucketFor(range);

  const { sql: filterSql, params: filterParams } = buildFilterConditions(
    filters,
    ownerId,
    4,
  );
  const baseParams = [ownerId, range.from, range.to, ...filterParams];

  const { sql: weFilterSql, params: weFilterParams } = webEventFilter(filters);
  const weBase = [ownerId, range.from, range.to, ...weFilterParams];

  const seoParams = [ownerId, range.from, range.to];

  // Organic orders CTE: valid revenue orders whose attributed channel is
  // organic, with a landing-page path pulled from the attribution blob.
  const organicOrdersCte = `
    WITH filtered AS (
      SELECT
        o.id, o.status,
        o.marketing_attribution AS attr,
        NULLIF(COALESCE(
          o.marketing_attribution->'last_touch'->>'landing_page_path',
          o.marketing_attribution->'first_touch'->>'landing_page_path',
          o.marketing_attribution->>'landing_page_path'
        ), '') AS landing_page,
        ${ORDER_REVENUE_USD} AS revenue_usd
      FROM orders o
      LEFT JOIN (
        SELECT order_id, SUM(amount_usd) AS paid_usd
        FROM order_payment
        WHERE amount_usd IS NOT NULL
        GROUP BY order_id
      ) pay ON pay.order_id = o.id
      WHERE o.workspace_owner_id = $1
        AND o.ordered_at >= $2
        AND o.ordered_at < $3
        ${filterSql}
    ),
    valid AS (
      SELECT * FROM filtered WHERE status NOT IN (${NON_REVENUE_SQL})
    ),
    organic AS (
      SELECT v.id, v.revenue_usd, v.landing_page
      FROM valid v
      WHERE ${channelCase(ATTR_SRC, ATTR_MED)} = 'organic'
    )`;

  const weOrganic = `${channelCase(WE_SRC, WE_MED)} = 'organic'`;
  const seoWhere = `workspace_owner_id = $1 AND period_end >= $2::date AND period_start < $3::date`;
  const wordCountExpr = `CASE WHEN we.properties->>'wordCount' ~ '^[0-9]+$' THEN (we.properties->>'wordCount')::int END`;

  try {
    const [
      organicTotalsResult,
      attrResult,
      organicByLandingResult,
      organicByCategoryResult,
      organicByOccasionResult,
      organicByBrandResult,
      weOrganicTotalsResult,
      weOrganicByPathResult,
      seoByLandingResult,
      seoByQueryResult,
      seoAggResult,
    ] = await Promise.all([
      // Organic order totals (orders + USD revenue).
      db.query<{ orders: string; revenue: string }>(
        `${organicOrdersCte}
         SELECT COUNT(*) AS orders, COALESCE(SUM(revenue_usd), 0) AS revenue
         FROM organic`,
        baseParams,
      ),

      // Whether any order in the window carries marketing attribution at all.
      db.query<{ attributed: string }>(
        `SELECT COUNT(*) AS attributed
         FROM orders o
         WHERE o.workspace_owner_id = $1
           AND o.ordered_at >= $2
           AND o.ordered_at < $3
           AND o.marketing_attribution IS NOT NULL
           AND o.marketing_attribution::text <> '{}'::text`,
        [ownerId, range.from, range.to],
      ),

      // Organic revenue/orders by landing page.
      db.query<{ path: string; orders: string; revenue: string }>(
        `${organicOrdersCte}
         SELECT landing_page AS path,
                COUNT(*) AS orders,
                COALESCE(SUM(revenue_usd), 0) AS revenue
         FROM organic
         WHERE landing_page IS NOT NULL
         GROUP BY landing_page
         ORDER BY revenue DESC`,
        baseParams,
      ),

      // Organic revenue by catalog category (line-item attributed).
      db.query<{ name: string; revenue: string; orders: string }>(
        `${organicOrdersCte}
         SELECT cc.name AS name,
                COALESCE(SUM(li.line_total::numeric), 0) AS revenue,
                COUNT(DISTINCT li.order_id) AS orders
         FROM order_line_items li
         JOIN organic om ON om.id = li.order_id
         ${PRODUCT_MATCH_LATERAL}
         JOIN product_catalog_categories pcc ON pcc.product_id = p.id
         JOIN catalog_categories cc ON cc.id = pcc.attribute_id
         GROUP BY cc.name
         ORDER BY 2 DESC
         LIMIT 10`,
        baseParams,
      ),

      // Organic revenue by occasion (line-item attributed).
      db.query<{ name: string; revenue: string; orders: string }>(
        `${organicOrdersCte}
         SELECT occ.name AS name,
                COALESCE(SUM(li.line_total::numeric), 0) AS revenue,
                COUNT(DISTINCT li.order_id) AS orders
         FROM order_line_items li
         JOIN organic om ON om.id = li.order_id
         ${PRODUCT_MATCH_LATERAL}
         JOIN product_occasions po ON po.product_id = p.id
         JOIN occasions occ ON occ.id = po.attribute_id
         GROUP BY occ.name
         ORDER BY 2 DESC
         LIMIT 10`,
        baseParams,
      ),

      // Organic revenue by brand (matched product's brand text).
      db.query<{ name: string; revenue: string; orders: string }>(
        `${organicOrdersCte}
         SELECT COALESCE(NULLIF(p.brand, ''), 'Unknown') AS name,
                COALESCE(SUM(li.line_total::numeric), 0) AS revenue,
                COUNT(DISTINCT li.order_id) AS orders
         FROM order_line_items li
         JOIN organic om ON om.id = li.order_id
         JOIN LATERAL (
           SELECT p.id, p.brand
           FROM products p
           WHERE p.workspace_owner_id = $1
             AND (
               lower(COALESCE(li.name, '')) = lower(p.name)
               OR (li.product_id IS NOT NULL AND li.product_id = p.id)
             )
           ORDER BY (li.product_id IS NOT NULL AND li.product_id = p.id) DESC
           LIMIT 1
         ) p ON true
         GROUP BY 1
         ORDER BY 2 DESC
         LIMIT 10`,
        baseParams,
      ),

      // Organic web sessions total.
      db.query<{ sessions: string }>(
        `SELECT COUNT(DISTINCT we.session_id) AS sessions
         FROM web_events we
         WHERE we.workspace_owner_id = $1
           AND we.occurred_at >= $2
           AND we.occurred_at < $3
           AND ${weOrganic}
           ${weFilterSql}`,
        weBase,
      ),

      // Organic web sessions + content-quality signals by path.
      db.query<{
        path: string;
        sessions: string;
        word_count: string | null;
        title_length: string | null;
        has_meta: boolean | null;
        has_content: boolean | null;
      }>(
        `SELECT we.path AS path,
                COUNT(DISTINCT we.session_id) AS sessions,
                MAX(${wordCountExpr}) AS word_count,
                MAX(char_length(NULLIF(we.properties->>'title', ''))) AS title_length,
                bool_or(NULLIF(we.properties->>'metaDescription', '') IS NOT NULL) AS has_meta,
                bool_or(
                  we.properties ? 'wordCount'
                  OR we.properties ? 'title'
                  OR we.properties ? 'metaDescription'
                ) AS has_content
         FROM web_events we
         WHERE we.workspace_owner_id = $1
           AND we.occurred_at >= $2
           AND we.occurred_at < $3
           AND ${weOrganic}
           AND we.path IS NOT NULL
           ${weFilterSql}
         GROUP BY we.path`,
        weBase,
      ),

      // SEO metrics per landing page (page-level rows: query IS NULL).
      db.query<{
        landing_page: string;
        impressions: string;
        clicks: string;
        avg_position: string | null;
      }>(
        `SELECT landing_page,
                COALESCE(SUM(impressions), 0) AS impressions,
                COALESCE(SUM(clicks), 0) AS clicks,
                CASE WHEN SUM(impressions) FILTER (WHERE avg_position IS NOT NULL) > 0
                  THEN SUM(avg_position * impressions) FILTER (WHERE avg_position IS NOT NULL)
                       / SUM(impressions) FILTER (WHERE avg_position IS NOT NULL)
                END AS avg_position
         FROM seo_metrics
         WHERE ${seoWhere} AND landing_page IS NOT NULL AND query IS NULL
         GROUP BY landing_page
         ORDER BY impressions DESC`,
        seoParams,
      ),

      // SEO metrics per query (query-level rows: query IS NOT NULL).
      db.query<{
        query: string;
        impressions: string;
        clicks: string;
        avg_position: string | null;
      }>(
        `SELECT query,
                COALESCE(SUM(impressions), 0) AS impressions,
                COALESCE(SUM(clicks), 0) AS clicks,
                CASE WHEN SUM(impressions) FILTER (WHERE avg_position IS NOT NULL) > 0
                  THEN SUM(avg_position * impressions) FILTER (WHERE avg_position IS NOT NULL)
                       / SUM(impressions) FILTER (WHERE avg_position IS NOT NULL)
                END AS avg_position
         FROM seo_metrics
         WHERE ${seoWhere} AND query IS NOT NULL
         GROUP BY query
         ORDER BY impressions DESC
         LIMIT 25`,
        seoParams,
      ),

      // SEO aggregate rows (landing_page IS NULL AND query IS NULL).
      db.query<{
        impressions: string;
        clicks: string;
        avg_position: string | null;
      }>(
        `SELECT COALESCE(SUM(impressions), 0) AS impressions,
                COALESCE(SUM(clicks), 0) AS clicks,
                CASE WHEN SUM(impressions) FILTER (WHERE avg_position IS NOT NULL) > 0
                  THEN SUM(avg_position * impressions) FILTER (WHERE avg_position IS NOT NULL)
                       / SUM(impressions) FILTER (WHERE avg_position IS NOT NULL)
                END AS avg_position
         FROM seo_metrics
         WHERE ${seoWhere} AND landing_page IS NULL AND query IS NULL`,
        seoParams,
      ),
    ]);

    const organicSessions = parseInt(
      weOrganicTotalsResult.rows[0]?.sessions ?? "0",
      10,
    );
    const organicOrders = parseInt(
      organicTotalsResult.rows[0]?.orders ?? "0",
      10,
    );
    const organicRevenueUsd = num(organicTotalsResult.rows[0]?.revenue);
    const attributionTracked =
      parseInt(attrResult.rows[0]?.attributed ?? "0", 10) > 0;
    const eventsTracked = organicSessions > 0;

    // --- SEO totals: prefer the finest grain that has impressions. -----------
    type SeoAgg = { impressions: number; clicks: number; posWeighted: number };
    const weighted = (
      rows: { impressions: string; clicks: string; avg_position: string | null }[],
    ): SeoAgg =>
      rows.reduce<SeoAgg>(
        (acc, r) => {
          const imp = parseInt(r.impressions, 10) || 0;
          const clk = parseInt(r.clicks, 10) || 0;
          const pos = r.avg_position == null ? null : num(r.avg_position);
          return {
            impressions: acc.impressions + imp,
            clicks: acc.clicks + clk,
            posWeighted: acc.posWeighted + (pos != null ? pos * imp : 0),
          };
        },
        { impressions: 0, clicks: 0, posWeighted: 0 },
      );

    const landingAgg = weighted(seoByLandingResult.rows);
    const queryAgg = weighted(seoByQueryResult.rows);
    const rowAgg = weighted(seoAggResult.rows);
    const chosen =
      landingAgg.impressions > 0
        ? landingAgg
        : queryAgg.impressions > 0
          ? queryAgg
          : rowAgg;
    const seoTracked = chosen.impressions > 0;
    const impressions = chosen.impressions;
    const clicks = chosen.clicks;
    const ctr = pct(clicks, impressions);
    const avgPosition =
      chosen.impressions > 0 && chosen.posWeighted > 0
        ? round2(chosen.posWeighted / chosen.impressions)
        : null;

    const organicConversionRate = pct(organicOrders, organicSessions);

    // --- Merge per-path signals from web events, orders and SEO metrics. -----
    type PageAgg = {
      path: string;
      sessions: number;
      orders: number;
      revenueUsd: number;
      impressions: number;
      clicks: number;
      avgPosition: number | null;
      wordCount: number | null;
      titleLength: number | null;
      hasMetaDescription: boolean | null;
    };
    const pages = new Map<string, PageAgg>();
    const ensure = (path: string): PageAgg => {
      let p = pages.get(path);
      if (!p) {
        p = {
          path,
          sessions: 0,
          orders: 0,
          revenueUsd: 0,
          impressions: 0,
          clicks: 0,
          avgPosition: null,
          wordCount: null,
          titleLength: null,
          hasMetaDescription: null,
        };
        pages.set(path, p);
      }
      return p;
    };

    let pageQualityTracked = false;
    for (const r of weOrganicByPathResult.rows) {
      const p = ensure(r.path);
      p.sessions = parseInt(r.sessions, 10) || 0;
      p.wordCount = r.word_count == null ? null : parseInt(r.word_count, 10);
      p.titleLength =
        r.title_length == null ? null : parseInt(r.title_length, 10);
      p.hasMetaDescription = r.has_meta ?? null;
      if (r.has_content) pageQualityTracked = true;
    }
    for (const r of organicByLandingResult.rows) {
      const p = ensure(r.path);
      p.orders = parseInt(r.orders, 10) || 0;
      p.revenueUsd = num(r.revenue);
    }
    for (const r of seoByLandingResult.rows) {
      const p = ensure(r.landing_page);
      p.impressions = parseInt(r.impressions, 10) || 0;
      p.clicks = parseInt(r.clicks, 10) || 0;
      p.avgPosition = r.avg_position == null ? null : num(r.avg_position);
    }

    const toPage = (p: PageAgg) => ({
      path: p.path,
      sessions: p.sessions,
      orders: p.orders,
      revenueUsd: round2(p.revenueUsd),
      conversionRate: pct(p.orders, p.sessions),
      impressions: p.impressions,
      clicks: p.clicks,
      ctr: pct(p.clicks, p.impressions),
      avgPosition: p.avgPosition,
      wordCount: p.wordCount,
      titleLength: p.titleLength,
      hasMetaDescription: p.hasMetaDescription,
    });

    const allPages = [...pages.values()];

    const pagesByTraffic = allPages
      .filter((p) => p.sessions > 0)
      .sort((a, b) => b.sessions - a.sessions)
      .slice(0, 15)
      .map(toPage);
    const pagesByRevenue = allPages
      .filter((p) => p.revenueUsd > 0)
      .sort((a, b) => b.revenueUsd - a.revenueUsd)
      .slice(0, 15)
      .map(toPage);
    const pagesByConversion = allPages
      .filter((p) => p.sessions > 0)
      .sort(
        (a, b) =>
          b.orders / Math.max(b.sessions, 1) -
          a.orders / Math.max(a.sessions, 1),
      )
      .slice(0, 15)
      .map(toPage);

    // Pages needing improvement: compute per-page issue codes.
    const LOW_WORD_COUNT = 300;
    const SHORT_TITLE = 30;
    const MIN_SESSIONS_FOR_CONV = 20;
    const POOR_CONVERSION_PCT = 1;
    const MIN_IMPR_FOR_CTR = 100;
    const LOW_CTR_PCT = 1;
    const POOR_POSITION = 10;

    const pagesNeedingImprovement = allPages
      .map((p) => {
        const issues: string[] = [];
        if (p.wordCount != null && p.wordCount < LOW_WORD_COUNT)
          issues.push("low_word_count");
        if (p.hasMetaDescription === false) issues.push("missing_metadata");
        if (p.titleLength != null && p.titleLength < SHORT_TITLE)
          issues.push("short_title");
        const conv = p.sessions > 0 ? (p.orders / p.sessions) * 100 : null;
        if (
          p.sessions >= MIN_SESSIONS_FOR_CONV &&
          conv != null &&
          conv < POOR_CONVERSION_PCT
        )
          issues.push("poor_conversion");
        const ctrPct =
          p.impressions > 0 ? (p.clicks / p.impressions) * 100 : null;
        if (
          p.impressions >= MIN_IMPR_FOR_CTR &&
          ctrPct != null &&
          ctrPct < LOW_CTR_PCT
        )
          issues.push("low_ctr");
        if (p.avgPosition != null && p.avgPosition > POOR_POSITION)
          issues.push("poor_position");
        return { page: toPage(p), issues };
      })
      .filter((r) => r.issues.length > 0)
      .sort(
        (a, b) =>
          b.page.sessions - a.page.sessions ||
          b.page.impressions - a.page.impressions,
      )
      .slice(0, 20)
      .map((r) => ({ ...r.page, issues: r.issues }));

    const dim = (
      rows: { name: string; revenue: string; orders: string }[],
    ) =>
      rows.map((r) => ({
        name: r.name,
        revenueUsd: num(r.revenue),
        orders: parseInt(r.orders, 10),
      }));

    res.json({
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      comparison: compare
        ? (() => {
            const prev = previousRange(range);
            return { from: prev.from.toISOString(), to: prev.to.toISOString() };
          })()
        : null,
      bucket,
      seoTracked,
      eventsTracked,
      attributionTracked,
      pageQualityTracked,
      totals: {
        organicSessions,
        organicOrders,
        organicRevenueUsd: round2(organicRevenueUsd),
        organicConversionRate,
        impressions,
        clicks,
        ctr,
        avgPosition,
      },
      categoryPages: dim(organicByCategoryResult.rows),
      occasionPages: dim(organicByOccasionResult.rows),
      brandPages: dim(organicByBrandResult.rows),
      topQueries: seoByQueryResult.rows.map((r) => ({
        query: r.query,
        impressions: parseInt(r.impressions, 10) || 0,
        clicks: parseInt(r.clicks, 10) || 0,
        ctr: pct(parseInt(r.clicks, 10) || 0, parseInt(r.impressions, 10) || 0),
        avgPosition: r.avg_position == null ? null : num(r.avg_position),
      })),
      pagesByTraffic,
      pagesByRevenue,
      pagesByConversion,
      pagesNeedingImprovement,
    });
  } catch (err) {
    req.log.error({ err }, "store-analytics seo failed");
    res.status(500).json({ error: "Failed to compute analytics" });
  }
});

/**
 * GET /store-analytics/inventory-cogs
 *
 * Section 9 of the E-commerce Analytics page: Inventory & COGS. Connects sales
 * to purchasing/profit — COGS by order/product/category, base-item material
 * consumption, low/out-of-stock signals, supplier cost trends, gross margin by
 * arrangement, and data-quality lists (products missing a recipe, products sold
 * without COGS data). All money is USD (AED supplier prices and supplier
 * invoices converted via the workspace's stored FX rates). Honors the shared
 * date range + filters. Reporting only.
 */
router.get("/store-analytics/inventory-cogs", async (req, res) => {
  const wreq = workspace(req);
  const ownerId = wreq.workspaceOwnerId;

  const range = resolveRange(req.query.from, req.query.to);
  const filters = parseAnalyticsFilters(req);
  const bucket = bucketFor(range);

  const { sql: cte, params: filterParams } = filteredOrdersCte(ownerId, filters);
  const baseParams = [ownerId, range.from, range.to, ...filterParams];

  try {
    // AED→USD conversion for base-item supplier prices. The base_item_suppliers
    // currency is constrained to AED|USD, so a single rate suffices. When no
    // rate is stored, AED-priced items are treated as un-costable (their COGS
    // stays NULL), matching the conservative behaviour of the executive KPIs.
    const aedRate = await getStoredRate("AED", "USD", ownerId);
    const aedToUsd =
      aedRate && Number.isFinite(aedRate.rate) && aedRate.rate > 0
        ? aedRate.rate
        : null;
    const aedLiteral = aedToUsd != null ? `'${aedToUsd}'::numeric` : null;

    // Preferred-supplier unit price expressed in USD (NULL when unpriced or an
    // AED price cannot be converted). `bis` must be in scope where used.
    const PRICE_USD = `
      CASE
        WHEN bis.price IS NULL THEN NULL
        WHEN bis.currency = 'USD' THEN bis.price::numeric
        ${aedLiteral ? `WHEN bis.currency = 'AED' THEN bis.price::numeric * ${aedLiteral}` : ``}
        ELSE NULL
      END`;

    // Match one product per line item (prefer product_id, else name match).
    const PRODUCT_MATCH = `
      LEFT JOIN LATERAL (
        SELECT p.id, p.workspace_owner_id, p.name, p.brand, p.category
        FROM products p
        WHERE p.workspace_owner_id = $1
          AND (
            lower(COALESCE(li.name, '')) = lower(p.name)
            OR (li.product_id IS NOT NULL AND li.product_id = p.id)
          )
        ORDER BY (li.product_id IS NOT NULL AND li.product_id = p.id) DESC
        LIMIT 1
      ) p ON true`;

    // Per-product USD COGS from its recipe. cogs_usd is NULL unless every recipe
    // base item has a priced preferred supplier (partial recipes are not costed).
    const PRODUCT_COGS = `
      LEFT JOIN LATERAL (
        SELECT
          COUNT(pr.base_item_id) AS recipe_lines,
          CASE
            WHEN COUNT(pr.base_item_id) = 0 THEN NULL
            WHEN COUNT(pr.base_item_id) FILTER (WHERE (${PRICE_USD}) IS NOT NULL)
                 = COUNT(pr.base_item_id)
              THEN SUM(pr.quantity::numeric * (${PRICE_USD}))
            ELSE NULL
          END AS cogs_usd
        FROM product_recipes pr
        LEFT JOIN base_item_suppliers bis
          ON bis.base_item_id = pr.base_item_id
         AND bis.workspace_owner_id = pr.workspace_owner_id
         AND bis.is_preferred = true
        WHERE pr.product_id = p.id
          AND pr.workspace_owner_id = p.workspace_owner_id
      ) cogs ON true`;

    // One row per sold line item, tagged with its matched product, category,
    // revenue and (NULL-tolerant) COGS. Reused by the product/category/order/
    // KPI/data-quality queries.
    const costedCte = `, costed AS (
      SELECT
        li.order_id,
        p.id AS product_id,
        COALESCE(p.name, li.name) AS product_name,
        COALESCE(NULLIF(p.category, ''), 'Uncategorized') AS category,
        li.quantity::numeric AS units,
        COALESCE(li.line_total::numeric, 0) AS line_revenue,
        cogs.cogs_usd AS unit_cogs,
        CASE WHEN cogs.cogs_usd IS NOT NULL
          THEN li.quantity::numeric * cogs.cogs_usd ELSE NULL END AS line_cogs,
        (cogs.recipe_lines IS NOT NULL AND cogs.recipe_lines > 0) AS has_recipe
      FROM order_line_items li
      JOIN filtered f ON f.id = li.order_id AND f.status NOT IN (${NON_REVENUE_SQL})
      ${PRODUCT_MATCH}
      ${PRODUCT_COGS}
    )`;

    // Supplier-invoice FX: convert every invoiced currency to USD. Distinct
    // currencies are validated to [A-Z]{3} and resolved via the workspace's
    // stored rates (best-effort; unknown currencies fall back to rate 1).
    const invCurRows = await db.query<{ cur: string }>(
      `SELECT DISTINCT upper(COALESCE(NULLIF(si.currency, ''), 'AED')) AS cur
         FROM supplier_invoices si
        WHERE si.workspace_owner_id = $1
          AND si.issued_at >= $2
          AND si.issued_at < $3`,
      [ownerId, range.from, range.to],
    );
    const fxPairs: Array<[string, number]> = [["USD", 1]];
    for (const { cur } of invCurRows.rows) {
      if (!/^[A-Z]{3}$/.test(cur) || cur === "USD") continue;
      const rate = await getStoredRate(cur, "USD", ownerId);
      if (rate && Number.isFinite(rate.rate) && rate.rate > 0) {
        fxPairs.push([cur, rate.rate]);
      }
    }
    const fxCte = `fx(cur, rate) AS (VALUES ${fxPairs
      .map(([c, r]) => `('${c}', '${r}'::numeric)`)
      .join(", ")})`;

    const [
      kpiResult,
      byProductResult,
      byCategoryResult,
      byOrderResult,
      materialResult,
      lowStockResult,
      outStockResult,
      supplierTrendResult,
      supplierBySupplierResult,
      missingRecipeResult,
      soldNoCogsResult,
    ] = await Promise.all([
      // KPIs
      db.query<{
        total_revenue: string;
        total_line_revenue: string;
        costed_revenue: string;
        total_cogs: string;
        orders_all: string;
        orders_with_cogs: string;
      }>(
        `${cte}${costedCte}
         SELECT
           (SELECT COALESCE(SUM(revenue_usd), 0) FROM filtered
             WHERE status NOT IN (${NON_REVENUE_SQL})) AS total_revenue,
           COALESCE(SUM(line_revenue), 0) AS total_line_revenue,
           COALESCE(SUM(line_revenue) FILTER (WHERE line_cogs IS NOT NULL), 0) AS costed_revenue,
           COALESCE(SUM(line_cogs) FILTER (WHERE line_cogs IS NOT NULL), 0) AS total_cogs,
           COUNT(DISTINCT order_id) AS orders_all,
           COUNT(DISTINCT order_id) FILTER (WHERE line_cogs IS NOT NULL) AS orders_with_cogs
         FROM costed`,
        baseParams,
      ),

      // COGS by product (also serves as gross-margin-by-arrangement)
      db.query<{
        name: string;
        units: string;
        revenue: string;
        cogs: string | null;
      }>(
        `${cte}${costedCte}
         SELECT
           product_name AS name,
           SUM(units) AS units,
           COALESCE(SUM(line_revenue), 0) AS revenue,
           SUM(line_cogs) FILTER (WHERE line_cogs IS NOT NULL) AS cogs
         FROM costed
         GROUP BY product_name
         ORDER BY cogs DESC NULLS LAST, revenue DESC
         LIMIT 20`,
        baseParams,
      ),

      // COGS by category
      db.query<{
        name: string;
        units: string;
        revenue: string;
        cogs: string | null;
      }>(
        `${cte}${costedCte}
         SELECT
           category AS name,
           SUM(units) AS units,
           COALESCE(SUM(line_revenue), 0) AS revenue,
           SUM(line_cogs) FILTER (WHERE line_cogs IS NOT NULL) AS cogs
         FROM costed
         GROUP BY category
         ORDER BY revenue DESC
         LIMIT 20`,
        baseParams,
      ),

      // Top orders by COGS
      db.query<{
        order_id: string;
        display_order_number: string | null;
        ordered_at: string;
        revenue: string;
        cogs: string;
      }>(
        `${cte}${costedCte}
         SELECT
           f.id AS order_id,
           o.display_order_number,
           f.ordered_at,
           f.revenue_usd AS revenue,
           SUM(c.line_cogs) AS cogs
         FROM filtered f
         JOIN costed c ON c.order_id = f.id
         JOIN orders o ON o.id = f.id
         WHERE f.status NOT IN (${NON_REVENUE_SQL})
         GROUP BY f.id, o.display_order_number, f.ordered_at, f.revenue_usd
         HAVING SUM(c.line_cogs) IS NOT NULL AND SUM(c.line_cogs) > 0
         ORDER BY cogs DESC
         LIMIT 15`,
        baseParams,
      ),

      // Base-item material consumption (recipe expansion over sold line items)
      db.query<{
        name: string;
        category: string;
        quantity: string;
        cost: string | null;
      }>(
        `${cte}
         SELECT
           bi.name AS name,
           COALESCE(bic.name, 'Uncategorized') AS category,
           SUM(li.quantity::numeric * pr.quantity::numeric) AS quantity,
           SUM(li.quantity::numeric * pr.quantity::numeric * (${PRICE_USD}))
             FILTER (WHERE (${PRICE_USD}) IS NOT NULL) AS cost
         FROM order_line_items li
         JOIN filtered f ON f.id = li.order_id AND f.status NOT IN (${NON_REVENUE_SQL})
         ${PRODUCT_MATCH}
         JOIN product_recipes pr ON pr.product_id = p.id AND pr.workspace_owner_id = $1
         JOIN base_items bi ON bi.id = pr.base_item_id AND bi.workspace_owner_id = $1
         LEFT JOIN base_item_categories bic ON bic.id = bi.category_id
         LEFT JOIN base_item_suppliers bis
           ON bis.base_item_id = pr.base_item_id
          AND bis.workspace_owner_id = $1
          AND bis.is_preferred = true
         GROUP BY bi.id, bi.name, bic.name
         ORDER BY quantity DESC
         LIMIT 20`,
        baseParams,
      ),

      // Low-stock base items (current state; base items carry no order dims)
      db.query<{
        name: string;
        code: string;
        category: string;
        stock: string;
        threshold: string;
        total: string;
      }>(
        `SELECT
           bi.name,
           bi.code,
           COALESCE(bic.name, 'Uncategorized') AS category,
           bi.stock::numeric AS stock,
           bi.low_stock_threshold::numeric AS threshold,
           COUNT(*) OVER() AS total
         FROM base_items bi
         LEFT JOIN base_item_categories bic ON bic.id = bi.category_id
         WHERE bi.workspace_owner_id = $1
           AND bi.stock > 0
           AND bi.low_stock_threshold > 0
           AND bi.stock <= bi.low_stock_threshold
         ORDER BY (bi.stock / NULLIF(bi.low_stock_threshold, 0)) ASC
         LIMIT 50`,
        [ownerId],
      ),

      // Out-of-stock base items (current state)
      db.query<{
        name: string;
        code: string;
        category: string;
        stock: string;
        threshold: string;
        total: string;
      }>(
        `SELECT
           bi.name,
           bi.code,
           COALESCE(bic.name, 'Uncategorized') AS category,
           bi.stock::numeric AS stock,
           bi.low_stock_threshold::numeric AS threshold,
           COUNT(*) OVER() AS total
         FROM base_items bi
         LEFT JOIN base_item_categories bic ON bic.id = bi.category_id
         WHERE bi.workspace_owner_id = $1
           AND bi.stock <= 0
         ORDER BY bi.name ASC
         LIMIT 50`,
        [ownerId],
      ),

      // Supplier cost trend over time (supplier invoices; date range only)
      db.query<{ bucket_date: string; amount: string }>(
        `WITH ${fxCte}
         SELECT
           date_trunc('${bucket}', si.issued_at AT TIME ZONE 'UTC')::date::text AS bucket_date,
           COALESCE(SUM(si.amount::numeric * COALESCE(fx.rate, 1)), 0) AS amount
         FROM supplier_invoices si
         LEFT JOIN fx ON fx.cur = upper(COALESCE(NULLIF(si.currency, ''), 'AED'))
         WHERE si.workspace_owner_id = $1
           AND si.issued_at >= $2
           AND si.issued_at < $3
         GROUP BY 1
         ORDER BY 1 ASC`,
        [ownerId, range.from, range.to],
      ),

      // Supplier cost by supplier (top suppliers by invoiced USD in range)
      db.query<{ name: string; amount: string }>(
        `WITH ${fxCte}
         SELECT
           s.name AS name,
           COALESCE(SUM(si.amount::numeric * COALESCE(fx.rate, 1)), 0) AS amount
         FROM supplier_invoices si
         JOIN suppliers s ON s.id = si.supplier_id
         LEFT JOIN fx ON fx.cur = upper(COALESCE(NULLIF(si.currency, ''), 'AED'))
         WHERE si.workspace_owner_id = $1
           AND si.issued_at >= $2
           AND si.issued_at < $3
         GROUP BY s.name
         ORDER BY amount DESC
         LIMIT 15`,
        [ownerId, range.from, range.to],
      ),

      // Data quality: products with no recipe at all
      db.query<{ name: string; total: string }>(
        `SELECT p.name, COUNT(*) OVER() AS total
         FROM products p
         WHERE p.workspace_owner_id = $1
           AND NOT EXISTS (
             SELECT 1 FROM product_recipes pr WHERE pr.product_id = p.id
           )
         ORDER BY p.name ASC
         LIMIT 50`,
        [ownerId],
      ),

      // Data quality: products sold in range but with no computable COGS
      db.query<{
        name: string;
        units: string;
        revenue: string;
        has_recipe: boolean;
        total: string;
      }>(
        `${cte}${costedCte}
         SELECT
           product_name AS name,
           SUM(units) AS units,
           COALESCE(SUM(line_revenue), 0) AS revenue,
           bool_or(has_recipe) AS has_recipe,
           COUNT(*) OVER() AS total
         FROM costed
         WHERE line_cogs IS NULL
         GROUP BY product_name
         ORDER BY revenue DESC
         LIMIT 50`,
        baseParams,
      ),
    ]);

    const k = kpiResult.rows[0];
    const totalRevenueUsd = num(k?.total_revenue);
    const totalLineRevenueUsd = num(k?.total_line_revenue);
    const costedRevenueUsd = num(k?.costed_revenue);
    const totalCogsUsd = num(k?.total_cogs);
    const ordersWithCogs = parseInt(k?.orders_with_cogs ?? "0", 10);
    const grossMarginUsd = costedRevenueUsd - totalCogsUsd;
    const grossMarginPct =
      costedRevenueUsd > 0 ? (grossMarginUsd / costedRevenueUsd) * 100 : 0;
    const avgMaterialCogsPerOrderUsd =
      ordersWithCogs > 0 ? totalCogsUsd / ordersWithCogs : 0;
    const cogsCoveragePct =
      totalLineRevenueUsd > 0
        ? (costedRevenueUsd / totalLineRevenueUsd) * 100
        : 0;

    const marginRow = (r: {
      name: string;
      units: string;
      revenue: string;
      cogs: string | null;
    }) => {
      const revenue = num(r.revenue);
      const cogs = r.cogs != null ? num(r.cogs) : null;
      const marginUsd = cogs != null ? revenue - cogs : null;
      return {
        name: r.name,
        units: num(r.units),
        revenueUsd: revenue,
        cogsUsd: cogs,
        marginUsd,
        marginPct:
          marginUsd != null && revenue > 0 ? (marginUsd / revenue) * 100 : null,
      };
    };

    const stockRow = (r: {
      name: string;
      code: string;
      category: string;
      stock: string;
      threshold: string;
    }) => ({
      name: r.name,
      code: r.code,
      category: r.category,
      stock: num(r.stock),
      threshold: num(r.threshold),
    });

    res.json({
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      bucket,
      kpis: {
        totalRevenueUsd,
        totalCogsUsd,
        costedRevenueUsd,
        grossMarginUsd,
        grossMarginPct,
        avgMaterialCogsPerOrderUsd,
        cogsCoveragePct,
        ordersWithCogs,
      },
      cogsByProduct: byProductResult.rows.map(marginRow),
      cogsByCategory: byCategoryResult.rows.map(marginRow),
      topOrdersByCogs: byOrderResult.rows.map((r) => {
        const revenue = num(r.revenue);
        const cogs = num(r.cogs);
        const marginUsd = revenue - cogs;
        return {
          orderId: r.order_id,
          reference: r.display_order_number ?? r.order_id.slice(0, 8),
          orderedAt: r.ordered_at,
          revenueUsd: revenue,
          cogsUsd: cogs,
          marginUsd,
          marginPct: revenue > 0 ? (marginUsd / revenue) * 100 : null,
        };
      }),
      materialConsumption: materialResult.rows.map((r) => ({
        name: r.name,
        category: r.category,
        quantity: num(r.quantity),
        costUsd: r.cost != null ? num(r.cost) : null,
      })),
      lowStockItems: lowStockResult.rows.map(stockRow),
      lowStockCount: parseInt(lowStockResult.rows[0]?.total ?? "0", 10),
      outOfStockItems: outStockResult.rows.map(stockRow),
      outOfStockCount: parseInt(outStockResult.rows[0]?.total ?? "0", 10),
      supplierCostTrend: supplierTrendResult.rows.map((r) => ({
        date: r.bucket_date,
        amountUsd: num(r.amount),
      })),
      supplierCostBySupplier: supplierBySupplierResult.rows.map((r) => ({
        name: r.name,
        amountUsd: num(r.amount),
      })),
      dataQuality: {
        productsMissingRecipe: {
          count: parseInt(missingRecipeResult.rows[0]?.total ?? "0", 10),
          items: missingRecipeResult.rows.map((r) => ({ name: r.name })),
        },
        productsSoldWithoutCogs: {
          count: parseInt(soldNoCogsResult.rows[0]?.total ?? "0", 10),
          items: soldNoCogsResult.rows.map((r) => ({
            name: r.name,
            units: num(r.units),
            revenueUsd: num(r.revenue),
            hasRecipe: r.has_recipe,
          })),
        },
      },
    });
  } catch (err) {
    req.log.error({ err }, "store-analytics inventory-cogs failed");
    res.status(500).json({ error: "Failed to compute analytics" });
  }
});

/**
 * A single generated insight. The frontend maps `code` + `direction` to a
 * localized message template and interpolates `label` + `values`, so no
 * human-readable text is produced server-side (keeps insights i18n-friendly).
 */
type Insight = {
  id: string;
  code:
    | "revenue_swing"
    | "payment_failure_spike"
    | "category_move"
    | "city_conversion"
    | "product_view_to_cart";
  level: "critical" | "warning" | "positive" | "info";
  section: "overview" | "sales" | "products" | "funnel" | "cart_checkout";
  direction: "up" | "down";
  /** Data-driven name (category / city / product); null for global metrics. */
  label: string | null;
  /** Ranking weight; higher surfaces first. */
  score: number;
  values: {
    pct?: number;
    current?: number;
    previous?: number;
    views?: number;
    rate?: number;
    average?: number;
  };
};

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * GET /store-analytics/insights
 *
 * Section 14 — the Alerts & Insights engine. Evaluates a fixed set of
 * threshold / period-comparison rules against the same analytics aggregations
 * used by the other sections and returns ranked, plain-language findings.
 *
 * The reporting window always compares against the immediately-preceding window
 * of equal length (the "previous period"), independent of the `compare` flag.
 * Rules that depend on website-tracking (`web_events`) are only evaluated when
 * that data exists for the current window, so no fake alerts appear before the
 * website integration is live. All money is USD.
 */
router.get("/store-analytics/insights", async (req, res) => {
  const wreq = workspace(req);
  const ownerId = wreq.workspaceOwnerId;

  const range = resolveRange(req.query.from, req.query.to);
  const prev = previousRange(range);
  const filters = parseAnalyticsFilters(req);

  const { sql: cte } = filteredOrdersCte(ownerId, filters);
  const { params: filterParams } = buildFilterConditions(filters, ownerId, 4);
  const curParams = [ownerId, range.from, range.to, ...filterParams];
  const prevParams = [ownerId, prev.from, prev.to, ...filterParams];

  const we = webEventFilter(filters);
  const weCur = [ownerId, range.from, range.to, ...we.params];
  const wePrev = [ownerId, prev.from, prev.to, ...we.params];

  // Payment failure counts (order-derived) for a window.
  const paymentFailureSql = `
    ${cte}
    SELECT
      COUNT(*) FILTER (WHERE op.status = 'failed') AS failed,
      COUNT(*) FILTER (WHERE op.status = 'paid') AS paid
    FROM order_payment op
    JOIN filtered f ON f.id = op.order_id
    WHERE op.status IN ('failed', 'paid')`;

  // Revenue by catalog category (line-item attributed) for a window.
  const categorySql = `
    ${cte}
    SELECT
      cc.name AS name,
      COALESCE(SUM(li.line_total::numeric), 0) AS revenue
    FROM order_line_items li
    JOIN filtered f ON f.id = li.order_id AND f.status NOT IN (${NON_REVENUE_SQL})
    ${PRODUCT_MATCH_LATERAL}
    JOIN product_catalog_categories pcc ON pcc.product_id = p.id
    JOIN catalog_categories cc ON cc.id = pcc.attribute_id
    GROUP BY cc.name`;

  // Per-city session conversion (website events) for a window. A session
  // "converts" when it fires any order/purchase completion event.
  const cityConversionSql = `
    WITH sess AS (
      SELECT
        we.session_id,
        max(we.city) AS city,
        bool_or(we.event_type IN ('order_created', 'purchase', 'payment_completed')) AS converted
      FROM web_events we
      WHERE we.workspace_owner_id = $1
        AND we.occurred_at >= $2
        AND we.occurred_at < $3
        AND we.session_id IS NOT NULL
        ${we.sql}
      GROUP BY we.session_id
    )
    SELECT
      COALESCE(NULLIF(city, ''), '') AS city,
      COUNT(*) AS sessions,
      COUNT(*) FILTER (WHERE converted) AS conversions
    FROM sess
    GROUP BY 1`;

  // Per-product view / add-to-cart counts (website events) for the current
  // window, with the product name resolved from `product_ref`.
  const viewToCartSql = `
    SELECT
      we.product_ref AS product_ref,
      max(pm.name) AS name,
      COUNT(*) FILTER (WHERE we.event_type = 'product_view') AS views,
      COUNT(*) FILTER (WHERE we.event_type = 'add_to_cart') AS carts
    FROM web_events we
    LEFT JOIN LATERAL (
      SELECT p.name
      FROM products p
      WHERE p.workspace_owner_id = $1
        AND (p.id::text = we.product_ref OR lower(p.name) = lower(we.product_ref))
      LIMIT 1
    ) pm ON true
    WHERE we.workspace_owner_id = $1
      AND we.occurred_at >= $2
      AND we.occurred_at < $3
      AND we.event_type IN ('product_view', 'add_to_cart')
      AND we.product_ref IS NOT NULL
      AND we.product_ref <> ''
      ${we.sql}
    GROUP BY we.product_ref`;

  try {
    const [
      curKpis,
      prevKpis,
      curFail,
      prevFail,
      curCat,
      prevCat,
      cityCur,
      cityPrev,
      viewCart,
    ] = await Promise.all([
      computeKpis(ownerId, range, filters),
      computeKpis(ownerId, prev, filters),
      db.query<{ failed: string; paid: string }>(paymentFailureSql, curParams),
      db.query<{ failed: string; paid: string }>(paymentFailureSql, prevParams),
      db.query<{ name: string; revenue: string }>(categorySql, curParams),
      db.query<{ name: string; revenue: string }>(categorySql, prevParams),
      db.query<{ city: string; sessions: string; conversions: string }>(
        cityConversionSql,
        weCur,
      ),
      db.query<{ city: string; sessions: string; conversions: string }>(
        cityConversionSql,
        wePrev,
      ),
      db.query<{
        product_ref: string;
        name: string | null;
        views: string;
        carts: string;
      }>(viewToCartSql, weCur),
    ]);

    const insights: Insight[] = [];

    // ---- Rule 1: revenue swing (always available) --------------------------
    if (prevKpis.totalRevenue > 0) {
      const cur = curKpis.totalRevenue;
      const previous = prevKpis.totalRevenue;
      const pct = ((cur - previous) / previous) * 100;
      if (Math.abs(pct) >= 10) {
        const direction = pct >= 0 ? "up" : "down";
        const level =
          direction === "down" ? (Math.abs(pct) >= 25 ? "critical" : "warning") : "positive";
        insights.push({
          id: "revenue_swing",
          code: "revenue_swing",
          level,
          section: "overview",
          direction,
          label: null,
          score: Math.abs(pct) * 3,
          values: {
            pct: round1(Math.abs(pct)),
            current: Math.round(cur),
            previous: Math.round(previous),
          },
        });
      }
    }

    // ---- Rule 2: payment failure spike (always available) ------------------
    {
      const cf = curFail.rows[0];
      const pfRow = prevFail.rows[0];
      const curFailed = parseInt(cf?.failed ?? "0", 10);
      const curPaid = parseInt(cf?.paid ?? "0", 10);
      const prevFailed = parseInt(pfRow?.failed ?? "0", 10);
      const prevPaid = parseInt(pfRow?.paid ?? "0", 10);
      const curTotal = curFailed + curPaid;
      const prevTotal = prevFailed + prevPaid;
      const curRate = curTotal > 0 ? (curFailed / curTotal) * 100 : 0;
      const prevRate = prevTotal > 0 ? (prevFailed / prevTotal) * 100 : 0;
      // Need a meaningful sample this period, at least two failures, and either
      // a clear jump in rate or a new spike where there was none before.
      const jumped = curRate - prevRate >= 5;
      const newSpike = prevRate === 0 && curRate >= 10;
      if (curTotal >= 5 && curFailed >= 2 && (jumped || newSpike)) {
        insights.push({
          id: "payment_failure_spike",
          code: "payment_failure_spike",
          level: curRate >= 25 ? "critical" : "warning",
          section: "cart_checkout",
          direction: "up",
          label: null,
          score: 20 + (curRate - prevRate) * 4,
          values: {
            current: round1(curRate),
            previous: round1(prevRate),
          },
        });
      }
    }

    // ---- Rule 3: category revenue moves (always available) -----------------
    {
      const prevMap = new Map<string, number>();
      for (const r of prevCat.rows) prevMap.set(r.name, num(r.revenue));
      const candidates: Insight[] = [];
      for (const r of curCat.rows) {
        const cur = num(r.revenue);
        const previous = prevMap.get(r.name) ?? 0;
        if (previous <= 0) continue;
        const pct = ((cur - previous) / previous) * 100;
        const absMove = Math.abs(cur - previous);
        if (Math.abs(pct) >= 20 && absMove >= 50) {
          const direction = pct >= 0 ? "up" : "down";
          candidates.push({
            id: `category_move:${r.name}`,
            code: "category_move",
            level: direction === "up" ? "positive" : "warning",
            section: "products",
            direction,
            label: r.name,
            score: absMove,
            values: {
              pct: round1(Math.abs(pct)),
              current: Math.round(cur),
              previous: Math.round(previous),
            },
          });
        }
      }
      candidates.sort((a, b) => b.score - a.score);
      for (const c of candidates.slice(0, 2)) {
        // Normalize score onto the same magnitude scale as the pct-based rules.
        insights.push({ ...c, score: (c.values.pct ?? 0) * 1.5 });
      }
    }

    const eventsTracked = cityCur.rows.reduce((s, r) => s + parseInt(r.sessions, 10), 0) > 0;

    // ---- Rule 4: conversion changes by city (website-tracking gated) -------
    if (eventsTracked) {
      const prevMap = new Map<string, { sessions: number; conversions: number }>();
      for (const r of cityPrev.rows) {
        prevMap.set(r.city, {
          sessions: parseInt(r.sessions, 10),
          conversions: parseInt(r.conversions, 10),
        });
      }
      const candidates: Insight[] = [];
      for (const r of cityCur.rows) {
        if (!r.city) continue; // skip sessions without a resolved city
        const curSessions = parseInt(r.sessions, 10);
        const p = prevMap.get(r.city);
        if (!p || curSessions < 20 || p.sessions < 20) continue;
        const curRate = (parseInt(r.conversions, 10) / curSessions) * 100;
        const prevRate = (p.conversions / p.sessions) * 100;
        const ppChange = curRate - prevRate;
        const rel = prevRate > 0 ? Math.abs(ppChange) / prevRate : 1;
        if (Math.abs(ppChange) >= 1 && rel >= 0.2) {
          const direction = ppChange >= 0 ? "up" : "down";
          candidates.push({
            id: `city_conversion:${r.city}`,
            code: "city_conversion",
            level: direction === "down" ? "warning" : "positive",
            section: "funnel",
            direction,
            label: r.city,
            score: Math.abs(ppChange) * 5,
            values: {
              current: round1(curRate),
              previous: round1(prevRate),
            },
          });
        }
      }
      candidates.sort((a, b) => b.score - a.score);
      insights.push(...candidates.slice(0, 2));
    }

    // ---- Rule 5: product view-to-cart anomalies (website-tracking gated) ---
    if (eventsTracked) {
      const rows = viewCart.rows.map((r) => ({
        name: r.name ?? r.product_ref,
        views: parseInt(r.views, 10),
        carts: parseInt(r.carts, 10),
      }));
      const totalViews = rows.reduce((s, r) => s + r.views, 0);
      const totalCarts = rows.reduce((s, r) => s + r.carts, 0);
      if (totalViews > 0) {
        const average = (totalCarts / totalViews) * 100;
        const candidates: Insight[] = [];
        for (const r of rows) {
          if (r.views < 30) continue;
          const rate = (r.carts / r.views) * 100;
          // High interest (views) but a conversion clearly below the store norm.
          if (rate < average * 0.5 && rate < 10) {
            candidates.push({
              id: `product_view_to_cart:${r.name}`,
              code: "product_view_to_cart",
              level: "warning",
              section: "products",
              direction: "down",
              label: r.name,
              score: (average - rate) * (r.views / 10),
              values: {
                views: r.views,
                rate: round1(rate),
                average: round1(average),
              },
            });
          }
        }
        candidates.sort((a, b) => b.score - a.score);
        insights.push(...candidates.slice(0, 2));
      }
    }

    insights.sort((a, b) => b.score - a.score);

    res.json({
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      comparison: { from: prev.from.toISOString(), to: prev.to.toISOString() },
      eventsTracked,
      insights: insights.slice(0, 8),
    });
  } catch (err) {
    req.log.error({ err }, "store-analytics insights failed");
    res.status(500).json({ error: "Failed to compute analytics" });
  }
});

/**
 * GET /store-analytics/marketplace
 *
 * Section 11 — per-marketplace-channel performance. Buckets orders into
 * Website / POS / WhatsApp / Toters / Deliveroo / Careem / Talabat (+ Other),
 * then returns revenue, orders, commission paid (from configured per-channel
 * rates), net revenue after commission, delivery cost, net revenue after
 * commission + delivery, cancellation rate, AOV, and best-selling products per
 * channel. The headline nets commission and delivery off revenue and compares
 * expected marketplace payout (revenue − commission) against the recorded
 * payout captured from marketplace statement reports. Honors the shared filter
 * bar; all money in USD.
 */
router.get("/store-analytics/marketplace", async (req, res) => {
  const wreq = workspace(req);
  const ownerId = wreq.workspaceOwnerId;

  const range = resolveRange(req.query.from, req.query.to);
  const compare = req.query.compare === "true" || req.query.compare === "1";
  const filters = parseAnalyticsFilters(req);

  const { sql: filterSql, params: filterParams } = buildFilterConditions(
    filters,
    ownerId,
    4,
  );
  const baseParams = [ownerId, range.from, range.to, ...filterParams];

  const marketplaceCte = `
    WITH filtered AS (
      SELECT
        o.id,
        o.status,
        ${marketplaceChannelCase()} AS mkt_channel,
        ${ORDER_REVENUE_USD} AS revenue_usd,
        ${ORDER_DELIVERY_FEE_USD} AS delivery_fee_usd
      FROM orders o
      LEFT JOIN (
        SELECT order_id, SUM(amount_usd) AS paid_usd
        FROM order_payment WHERE amount_usd IS NOT NULL GROUP BY order_id
      ) pay ON pay.order_id = o.id
      WHERE o.workspace_owner_id = $1
        AND o.ordered_at >= $2
        AND o.ordered_at < $3
        ${filterSql}
    )
  `;

  try {
    const rates = await getMarketplaceCommissionRates(ownerId);

    const [byChannelResult, bestSellersResult, reportsResult] =
      await Promise.all([
        // Per-channel order aggregates.
        db.query<{
          channel: string;
          total_orders: string;
          valid_orders: string;
          cancelled_orders: string;
          revenue: string;
          delivery: string;
        }>(
          `${marketplaceCte}
           SELECT
             mkt_channel AS channel,
             COUNT(*) AS total_orders,
             COUNT(*) FILTER (WHERE status NOT IN (${NON_REVENUE_SQL})) AS valid_orders,
             COUNT(*) FILTER (WHERE status IN ('cancelled', 'refunded')) AS cancelled_orders,
             COALESCE(SUM(revenue_usd) FILTER (WHERE status NOT IN (${NON_REVENUE_SQL})), 0) AS revenue,
             COALESCE(SUM(delivery_fee_usd) FILTER (WHERE status NOT IN (${NON_REVENUE_SQL})), 0) AS delivery
           FROM filtered
           GROUP BY mkt_channel`,
          baseParams,
        ),

        // Top 5 best-selling products per channel (from valid orders).
        db.query<{
          channel: string;
          name: string;
          qty: string;
          revenue: string;
        }>(
          `${marketplaceCte},
           valid AS (
             SELECT id, mkt_channel FROM filtered
             WHERE status NOT IN (${NON_REVENUE_SQL})
           ),
           li_agg AS (
             SELECT
               v.mkt_channel AS channel,
               COALESCE(NULLIF(li.name, ''), '(unknown)') AS name,
               COALESCE(SUM(li.quantity), 0) AS qty,
               COALESCE(SUM(li.line_total), 0) AS revenue
             FROM order_line_items li
             JOIN valid v ON v.id = li.order_id
             GROUP BY v.mkt_channel, COALESCE(NULLIF(li.name, ''), '(unknown)')
           ),
           ranked AS (
             SELECT *,
               ROW_NUMBER() OVER (
                 PARTITION BY channel ORDER BY revenue DESC, qty DESC
               ) AS rn
             FROM li_agg
           )
           SELECT channel, name, qty, revenue
           FROM ranked WHERE rn <= 5
           ORDER BY channel, revenue DESC`,
          baseParams,
        ),

        // Recorded marketplace statement reports overlapping the window.
        // Reports are keyed by marketplace + brand/location + period and carry
        // no country/city/channel dimensions, so they honor the date range only.
        db.query<{
          marketplace: string;
          commission: string;
          net_revenue: string;
          total_revenue: string;
          reports: string;
        }>(
          `SELECT
             lower(mr.marketplace) AS marketplace,
             COALESCE(SUM(m.metric_value) FILTER (WHERE m.metric_name = 'commission'), 0) AS commission,
             COALESCE(SUM(m.metric_value) FILTER (WHERE m.metric_name = 'net_revenue'), 0) AS net_revenue,
             COALESCE(SUM(m.metric_value) FILTER (WHERE m.metric_name = 'total_revenue'), 0) AS total_revenue,
             COUNT(DISTINCT mr.id) AS reports
           FROM marketplace_reports mr
           JOIN marketplace_report_metrics m ON m.report_id = mr.id
           WHERE mr.workspace_owner_id = $1
             AND mr.report_period_end >= $2::date
             AND mr.report_period_start < $3::date
           GROUP BY lower(mr.marketplace)`,
          [ownerId, range.from, range.to],
        ),
      ]);

    // Group best-sellers by channel.
    const bestByChannel = new Map<
      string,
      Array<{ name: string; quantity: number; revenueUsd: number }>
    >();
    for (const r of bestSellersResult.rows) {
      const arr = bestByChannel.get(r.channel) ?? [];
      arr.push({
        name: r.name,
        quantity: parseInt(r.qty, 10),
        revenueUsd: round2(num(r.revenue)),
      });
      bestByChannel.set(r.channel, arr);
    }

    // Recorded reports keyed by marketplace.
    const reportsByMkt = new Map<
      string,
      { commission: number; netRevenue: number; totalRevenue: number }
    >();
    for (const r of reportsResult.rows) {
      reportsByMkt.set(r.marketplace, {
        commission: num(r.commission),
        netRevenue: num(r.net_revenue),
        totalRevenue: num(r.total_revenue),
      });
    }
    const reportsTracked = reportsResult.rows.length > 0;

    const isMarketplace = (channel: string): boolean =>
      (MARKETPLACE_CHANNELS as readonly string[]).includes(channel);

    const byChannel = byChannelResult.rows
      .map((r) => {
        const channel = r.channel;
        const revenueUsd = round2(num(r.revenue));
        const orders = parseInt(r.valid_orders, 10);
        const totalOrders = parseInt(r.total_orders, 10);
        const cancelledOrders = parseInt(r.cancelled_orders, 10);
        const deliveryCostUsd = round2(num(r.delivery));
        const rate = rates[channel as MarketplaceChannelKey] ?? 0;
        const commissionUsd = round2((revenueUsd * rate) / 100);
        const netAfterCommissionUsd = round2(revenueUsd - commissionUsd);
        const netRevenueUsd = round2(
          revenueUsd - commissionUsd - deliveryCostUsd,
        );
        return {
          channel,
          isMarketplace: isMarketplace(channel),
          orders,
          totalOrders,
          cancelledOrders,
          cancellationRate: pct(cancelledOrders, totalOrders),
          revenueUsd,
          commissionRatePct: rate,
          commissionUsd,
          netAfterCommissionUsd,
          deliveryCostUsd,
          netRevenueUsd,
          avgOrderValueUsd: ratio(revenueUsd, orders),
          bestSellers: bestByChannel.get(channel) ?? [],
        };
      })
      .sort((a, b) => b.revenueUsd - a.revenueUsd);

    // Payout comparison: expected (revenue − commission) vs recorded reports,
    // per marketplace channel that has either order data or a report.
    const payoutComparison = MARKETPLACE_CHANNELS.map((channel) => {
      const ch = byChannel.find((c) => c.channel === channel);
      const rep = reportsByMkt.get(channel);
      if (!ch && !rep) return null;
      const expectedPayoutUsd = round2(ch ? ch.netAfterCommissionUsd : 0);
      return {
        channel,
        expectedPayoutUsd,
        recordedCommissionUsd: rep ? round2(rep.commission) : null,
        recordedPayoutUsd: rep ? round2(rep.netRevenue) : null,
        recordedTotalRevenueUsd: rep ? round2(rep.totalRevenue) : null,
        varianceUsd: rep ? round2(rep.netRevenue - expectedPayoutUsd) : null,
      };
    }).filter((p): p is NonNullable<typeof p> => p !== null);

    const totalRevenue = byChannel.reduce((s, c) => s + c.revenueUsd, 0);
    const totalOrders = byChannel.reduce((s, c) => s + c.orders, 0);
    const totalCommission = byChannel.reduce((s, c) => s + c.commissionUsd, 0);
    const totalDelivery = byChannel.reduce((s, c) => s + c.deliveryCostUsd, 0);
    const totalNet = totalRevenue - totalCommission - totalDelivery;
    const marketplaceRevenue = byChannel
      .filter((c) => c.isMarketplace)
      .reduce((s, c) => s + c.revenueUsd, 0);
    const expectedPayout = payoutComparison.reduce(
      (s, p) => s + p.expectedPayoutUsd,
      0,
    );
    const recordedPayout = reportsTracked
      ? Array.from(reportsByMkt.values()).reduce((s, r) => s + r.netRevenue, 0)
      : null;

    res.json({
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      comparison: compare
        ? (() => {
            const p = previousRange(range);
            return { from: p.from.toISOString(), to: p.to.toISOString() };
          })()
        : null,
      reportsTracked,
      commissionRates: rates,
      totals: {
        revenueUsd: round2(totalRevenue),
        orders: totalOrders,
        commissionUsd: round2(totalCommission),
        deliveryCostUsd: round2(totalDelivery),
        netRevenueUsd: round2(totalNet),
        marketplaceRevenueUsd: round2(marketplaceRevenue),
        expectedPayoutUsd: round2(expectedPayout),
        recordedPayoutUsd: recordedPayout == null ? null : round2(recordedPayout),
        avgOrderValueUsd: ratio(totalRevenue, totalOrders),
      },
      byChannel,
      payoutComparison,
    });
  } catch (err) {
    req.log.error({ err }, "store-analytics marketplace failed");
    res.status(500).json({ error: "Failed to compute analytics" });
  }
});

/**
 * PUT /store-analytics/marketplace/commission-rates
 *
 * Owner-only. Persists per-channel commission rate overrides (percent) used by
 * the marketplace section. Unknown keys are ignored; values clamped to [0, 100].
 * Returns the effective rates (stored overrides merged over code defaults).
 */
router.put("/store-analytics/marketplace/commission-rates", async (req, res) => {
  const wreq = workspace(req);
  if (wreq.workspaceRole !== "owner") {
    res.status(403).json({ error: "Owner access required" });
    return;
  }
  const ownerId = wreq.workspaceOwnerId;
  const input = (req.body as { rates?: unknown } | undefined)?.rates;
  if (!input || typeof input !== "object") {
    res.status(400).json({ error: "rates object required" });
    return;
  }
  const clean: Record<string, number> = {};
  for (const key of MARKETPLACE_ALL_CHANNELS) {
    const v = (input as Record<string, unknown>)[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      clean[key] = Math.max(0, Math.min(100, Math.round(v * 100) / 100));
    }
  }
  try {
    await db.query(
      `INSERT INTO workspace_settings (workspace_owner_id, marketplace_commission_rates)
       VALUES ($1, $2::jsonb)
       ON CONFLICT (workspace_owner_id)
       DO UPDATE SET marketplace_commission_rates = EXCLUDED.marketplace_commission_rates`,
      [ownerId, JSON.stringify(clean)],
    );
    const rates = await getMarketplaceCommissionRates(ownerId);
    res.json({ rates });
  } catch (err) {
    req.log.error({ err }, "update marketplace commission rates failed");
    res.status(500).json({ error: "Failed to save commission rates" });
  }
});
export default router;
