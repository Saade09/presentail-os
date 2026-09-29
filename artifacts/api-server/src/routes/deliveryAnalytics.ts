import { Router, type IRouter } from "express";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import {
  resolveRange,
  previousRange,
  bucketFor,
  parseAnalyticsFilters,
  buildFilterConditions,
  cityMatchSql,
  num,
  prettifyCitySlug,
  type AnalyticsRange,
  type AnalyticsFilters,
} from "../lib/storeAnalytics";

const router: IRouter = Router();

router.use(requireAuth, resolveWorkspace);

/**
 * Order revenue in USD: prefer summed payment `amount_usd` (the USD equivalent
 * of what the customer actually paid), else the stored USD total.
 */
const ORDER_REVENUE_USD = `COALESCE(pay.paid_usd, NULLIF(o.totals->>'total', '')::numeric, 0)`;

/**
 * Delivery fee charged to the customer, in USD. Stored inside the order totals
 * jsonb under `shipping` (the storefront maps its `delivery_fee` onto
 * `totals.shipping`). Treated as USD, consistent with how `totals.total` is used
 * as the USD revenue fallback.
 */
const DELIVERY_FEE_USD = `COALESCE(NULLIF(o.totals->>'shipping', '')::numeric, 0)`;

// ── Classification fragments (evaluated over the `filtered f` CTE) ────────────
/** Delivery completed successfully (OS status or Tookan job status). */
const IS_DELIVERED = `(f.status = 'completed' OR f.tookan_status = 'successful')`;
/** Delivery failed (Tookan failed/declined, or OS status failed). */
const IS_FAILED = `(f.tookan_status IN ('failed', 'declined') OR f.status = 'failed')`;
/** No delivery fee charged. */
const IS_FREE = `(f.delivery_fee_usd = 0)`;
/** Requested delivery day is the same calendar day as the order. */
const SAME_DAY = `(f.window_start IS NOT NULL AND (f.window_start AT TIME ZONE 'UTC')::date = (f.ordered_at AT TIME ZONE 'UTC')::date)`;
/** Requested delivery day is later than the order day. */
const SCHEDULED = `(f.window_start IS NOT NULL AND (f.window_start AT TIME ZONE 'UTC')::date > (f.ordered_at AT TIME ZONE 'UTC')::date)`;
/** Delivered on or before the promised window end (needs an actual delivered_at). */
const ON_TIME = `(${IS_DELIVERED} AND f.window_end IS NOT NULL AND f.delivered_at IS NOT NULL AND f.delivered_at <= f.window_end)`;
/** Delivered after the promised window end. */
const LATE = `(${IS_DELIVERED} AND f.window_end IS NOT NULL AND f.delivered_at IS NOT NULL AND f.delivered_at > f.window_end)`;

/**
 * Shared CTE producing the filtered delivery-order set. Each row exposes the
 * delivery-specific columns the aggregations need (fee, cost, actual delivered
 * time, driver assignment). Pickup orders are excluded. Callers append their own
 * SELECT/aggregation. Placeholder $1 = owner, $2 = from, $3 = to, filter params
 * start at $4.
 */
function filteredDeliveryCte(
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
        o.tookan_status,
        o.ordered_at,
        o.window_start,
        o.window_end,
        o.delivery_address,
        ${ORDER_REVENUE_USD} AS revenue_usd,
        ${DELIVERY_FEE_USD} AS delivery_fee_usd,
        COALESCE(asg.delivered_at, o.tookan_delivered_at) AS delivered_at,
        (asg.n IS NOT NULL AND asg.n > 0) AS has_driver,
        COALESCE(cost.cost_cents, 0) / 100.0 AS delivery_cost_usd
      FROM orders o
      LEFT JOIN (
        SELECT order_id, SUM(amount_usd) AS paid_usd
        FROM order_payment
        WHERE amount_usd IS NOT NULL
        GROUP BY order_id
      ) pay ON pay.order_id = o.id
      LEFT JOIN (
        SELECT order_id, MAX(delivered_at) AS delivered_at, COUNT(*) AS n
        FROM fleet_driver_order_assignments
        WHERE workspace_owner_id = $1 AND order_id IS NOT NULL
        GROUP BY order_id
      ) asg ON asg.order_id = o.id
      LEFT JOIN (
        SELECT order_id AS oid_text,
               SUM(CASE type WHEN 'deduction' THEN -amount_cents ELSE amount_cents END) AS cost_cents
        FROM fleet_driver_transactions
        WHERE order_id IS NOT NULL
        GROUP BY order_id
      ) cost ON cost.oid_text = o.id::text
      WHERE o.workspace_owner_id = $1
        AND o.ordered_at >= $2
        AND o.ordered_at < $3
        AND (o.delivery_type IS DISTINCT FROM 'pickup')
        ${filterSql}
    )
  `;
  return { sql, params: filterParams };
}

type DeliveryKpiRow = {
  total_deliveries: string;
  same_day: string;
  scheduled: string;
  failed: string;
  free_delivery: string;
  on_time: string;
  late: string;
  delivery_revenue: string;
  delivery_cost: string;
  avg_fee: string;
};

async function computeDeliveryKpis(
  ownerId: string,
  range: AnalyticsRange,
  filters: AnalyticsFilters,
) {
  const { sql: cte, params: filterParams } = filteredDeliveryCte(ownerId, filters);
  const params = [ownerId, range.from, range.to, ...filterParams];

  const sql = `
    ${cte}
    SELECT
      COUNT(*) AS total_deliveries,
      COUNT(*) FILTER (WHERE ${SAME_DAY}) AS same_day,
      COUNT(*) FILTER (WHERE ${SCHEDULED}) AS scheduled,
      COUNT(*) FILTER (WHERE ${IS_FAILED}) AS failed,
      COUNT(*) FILTER (WHERE ${IS_FREE}) AS free_delivery,
      COUNT(*) FILTER (WHERE ${ON_TIME}) AS on_time,
      COUNT(*) FILTER (WHERE ${LATE}) AS late,
      COALESCE(SUM(f.delivery_fee_usd), 0) AS delivery_revenue,
      COALESCE(SUM(f.delivery_cost_usd), 0) AS delivery_cost,
      COALESCE(AVG(f.delivery_fee_usd), 0) AS avg_fee
    FROM filtered f
  `;

  const result = await db.query<DeliveryKpiRow>(sql, params);
  const r = result.rows[0];

  const totalDeliveries = parseInt(r?.total_deliveries ?? "0", 10);
  const onTime = parseInt(r?.on_time ?? "0", 10);
  const late = parseInt(r?.late ?? "0", 10);
  const rated = onTime + late;
  const deliveryRevenue = num(r?.delivery_revenue);
  const deliveryCost = num(r?.delivery_cost);

  return {
    totalDeliveries,
    sameDayOrders: parseInt(r?.same_day ?? "0", 10),
    scheduledOrders: parseInt(r?.scheduled ?? "0", 10),
    onTimeRate: rated > 0 ? (onTime / rated) * 100 : null,
    lateDeliveries: late,
    failedDeliveries: parseInt(r?.failed ?? "0", 10),
    avgDeliveryFee: num(r?.avg_fee),
    deliveryRevenue,
    deliveryCost,
    deliveryProfit: deliveryRevenue - deliveryCost,
    freeDeliveryOrders: parseInt(r?.free_delivery ?? "0", 10),
  };
}

/**
 * GET /store-analytics/delivery
 *
 * Section 7 (Delivery) of the E-commerce Analytics page. Reporting-only. Returns
 * delivery KPIs (with previous-period figures for deltas when `compare=true`),
 * an orders-by-delivery-date trend, same-day vs scheduled split, delivery-slot
 * usage, and a per-city/district breakdown. All money is USD.
 */
router.get("/store-analytics/delivery", async (req, res) => {
  const wreq = workspace(req);
  const ownerId = wreq.workspaceOwnerId;

  const range = resolveRange(req.query.from, req.query.to);
  const compare = req.query.compare === "true" || req.query.compare === "1";
  const filters = parseAnalyticsFilters(req);
  const bucket = bucketFor(range);

  const { sql: cte, params: filterParams } = filteredDeliveryCte(ownerId, filters);
  const baseParams = [ownerId, range.from, range.to, ...filterParams];

  try {
    const [kpis, previousKpis, byDateResult, slotResult, districtResult] =
      await Promise.all([
        computeDeliveryKpis(ownerId, range, filters),
        compare
          ? computeDeliveryKpis(ownerId, previousRange(range), filters)
          : Promise.resolve(null),

        // Orders by delivery date (falls back to order date when no window)
        db.query<{ bucket_date: string; orders: string }>(
          `${cte}
           SELECT
             date_trunc('${bucket}', COALESCE(f.window_start, f.ordered_at) AT TIME ZONE 'UTC')::date::text AS bucket_date,
             COUNT(*) AS orders
           FROM filtered f
           GROUP BY 1
           ORDER BY 1 ASC`,
          baseParams,
        ),

        // Delivery-slot usage (time-of-day window), busiest first
        db.query<{ slot: string; orders: string }>(
          `${cte}
           SELECT
             to_char(f.window_start AT TIME ZONE 'UTC', 'HH24:MI') || '-' ||
             to_char(f.window_end AT TIME ZONE 'UTC', 'HH24:MI') AS slot,
             COUNT(*) AS orders
           FROM filtered f
           WHERE f.window_start IS NOT NULL AND f.window_end IS NOT NULL
           GROUP BY 1
           ORDER BY 2 DESC
           LIMIT 12`,
          baseParams,
        ),

        // Per city/district breakdown
        db.query<{
          city_id: string | null;
          name: string | null;
          orders: string;
          revenue: string;
          avg_fee: string;
          cost: string;
          free_delivery: string;
          late_orders: string;
          failed_orders: string;
          driver_assigned: string;
          win_start: string | null;
          win_end: string | null;
        }>(
          `${cte}
           SELECT
             COALESCE(dc.id::text, f.delivery_address->>'cityId') AS city_id,
             dc.name AS name,
             COUNT(*) AS orders,
             COALESCE(SUM(f.revenue_usd), 0) AS revenue,
             COALESCE(AVG(f.delivery_fee_usd), 0) AS avg_fee,
             COALESCE(SUM(f.delivery_cost_usd), 0) AS cost,
             COUNT(*) FILTER (WHERE ${IS_FREE}) AS free_delivery,
             COUNT(*) FILTER (WHERE ${LATE}) AS late_orders,
             COUNT(*) FILTER (WHERE ${IS_FAILED}) AS failed_orders,
             COUNT(*) FILTER (WHERE f.has_driver) AS driver_assigned,
             to_char(MIN(f.window_start AT TIME ZONE 'UTC'), 'HH24:MI') AS win_start,
             to_char(MAX(f.window_end AT TIME ZONE 'UTC'), 'HH24:MI') AS win_end
           FROM filtered f
           LEFT JOIN delivery_cities dc
             ON dc.workspace_owner_id = $1
            AND ${cityMatchSql(`f.delivery_address->>'cityId'`)}
           GROUP BY 1, 2
           ORDER BY 3 DESC`,
          baseParams,
        ),
      ]);

    res.json({
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      comparison: compare
        ? (() => {
            const p = previousRange(range);
            return { from: p.from.toISOString(), to: p.to.toISOString() };
          })()
        : null,
      bucket,
      kpis,
      previousKpis,
      ordersByDeliveryDate: byDateResult.rows.map((r) => ({
        date: r.bucket_date,
        orders: parseInt(r.orders, 10),
      })),
      sameDayVsScheduled: {
        sameDay: kpis.sameDayOrders,
        scheduled: kpis.scheduledOrders,
      },
      slotUsage: slotResult.rows.map((r) => ({
        slot: r.slot,
        orders: parseInt(r.orders, 10),
      })),
      districts: districtResult.rows.map((r) => ({
        cityId: r.city_id,
        name: r.name ?? prettifyCitySlug(r.city_id) ?? "Unknown",
        orders: parseInt(r.orders, 10),
        revenue: num(r.revenue),
        avgFee: num(r.avg_fee),
        cost: num(r.cost),
        freeDeliveryOrders: parseInt(r.free_delivery, 10),
        lateOrders: parseInt(r.late_orders, 10),
        failedOrders: parseInt(r.failed_orders, 10),
        driverAssignedOrders: parseInt(r.driver_assigned, 10),
        windowLabel:
          r.win_start && r.win_end ? `${r.win_start}-${r.win_end}` : null,
      })),
    });
  } catch (err) {
    req.log.error({ err }, "store-analytics delivery failed");
    res.status(500).json({ error: "Failed to compute delivery analytics" });
  }
});

export default router;
