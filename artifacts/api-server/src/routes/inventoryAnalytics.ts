import { Router, type IRouter } from "express";
import { createHash } from "node:crypto";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { resolveWorkspace, workspace } from "../lib/workspace";
import { resolveRange, parseAnalyticsFilters } from "../lib/storeAnalytics";
import { z } from "zod/v4";
import {
  InventoryError,
  postMovement as postOperationalMovement,
} from "../lib/inventoryService";

const router: IRouter = Router();
router.use(requireAuth, resolveWorkspace);

function canManageBaseItems(wreq: ReturnType<typeof workspace>): boolean {
  return (
    wreq.workspaceRole === "owner" ||
    (wreq.allowedPages?.includes("base_items.manage") ?? false)
  );
}

function num(v: string | null | undefined): number {
  if (v == null) return 0;
  const n = parseFloat(v);
  return Number.isNaN(n) ? 0 : n;
}

function parseInventoryFilters(req: {
  query: Record<string, unknown>;
}) {
  const q = req.query as Record<string, string | undefined>;
  return {
    locationId: q.locationId ? parseInt(q.locationId, 10) : null,
    categoryId: q.categoryId ? parseInt(q.categoryId, 10) : null,
    supplierId: q.supplierId ? parseInt(q.supplierId, 10) : null,
    baseItemId: q.baseItemId ? parseInt(q.baseItemId, 10) : null,
    movementType: q.movementType ?? null,
    employeeId: q.employeeId ?? null,
  };
}

// ──────────────────────────────────────────────────────────────
// GET /api/inventory-analytics/overview
// ──────────────────────────────────────────────────────────────
router.get("/inventory-analytics/overview", async (req, res) => {
  try {
    const ws = workspace(req);
    const range = resolveRange(req.query.from, req.query.to);

    const [cogsRow, targetRow, locationRows, weeklyRows, driverRows] =
      await Promise.all([
        db.query<{
          net_revenue: string;
          actual_cogs: string;
          theoretical_cogs: string;
          purchase_value: string;
          recipe_value: string;
          waste_value: string;
        }>(
          `WITH ordered_revenue AS (
             SELECT COALESCE(SUM(oi.line_total), 0) AS net_revenue
             FROM orders o
             JOIN order_line_items oi ON oi.order_id = o.id
             WHERE o.workspace_owner_id = $1
               AND o.ordered_at >= $2 AND o.ordered_at < $3
               AND o.status NOT IN ('cancelled','refunded','failed','trash')
           ),
           ledger_agg AS (
             SELECT
               COALESCE(SUM(CASE WHEN movement_type IN ('recipe_consumption','recorded_wastage','transfer_out') AND quantity_change < 0
                                  THEN ABS(COALESCE(total_value,0)) ELSE 0 END), 0) AS actual_cogs,
               COALESCE(SUM(CASE WHEN movement_type = 'purchase_receipt'
                                  THEN COALESCE(total_value,0) ELSE 0 END), 0) AS purchase_value,
               COALESCE(SUM(CASE WHEN movement_type = 'recipe_consumption'
                                  THEN ABS(COALESCE(total_value,0)) ELSE 0 END), 0) AS recipe_value,
               COALESCE(SUM(CASE WHEN movement_type = 'recorded_wastage'
                                  THEN ABS(COALESCE(total_value,0)) ELSE 0 END), 0) AS waste_value
             FROM inventory_movements
             WHERE workspace_owner_id = $1
               AND posted_at >= $2 AND posted_at < $3
               AND reversed_by_id IS NULL
           ),
           snapshot_cogs AS (
             SELECT COALESCE(SUM(
               (snap->>'unitCost')::numeric * (snap->>'quantity')::numeric
             ), 0) AS theoretical_cogs
             FROM orders o
             JOIN order_line_items oi ON oi.order_id = o.id
             JOIN LATERAL jsonb_array_elements(COALESCE(oi.recipe_snapshot,'[]'::jsonb)) snap ON TRUE
             WHERE o.workspace_owner_id = $1
               AND o.ordered_at >= $2 AND o.ordered_at < $3
               AND o.status NOT IN ('cancelled','refunded','failed','trash')
           )
           SELECT r.net_revenue, l.actual_cogs, s.theoretical_cogs,
                  l.purchase_value, l.recipe_value, l.waste_value
           FROM ordered_revenue r, ledger_agg l, snapshot_cogs s`,
          [ws.workspaceOwnerId, range.from, range.to],
        ),

        db.query<{ target_cogs_pct: string }>(
          `SELECT target_cogs_pct FROM inventory_cogs_targets
           WHERE workspace_owner_id = $1
           ORDER BY effective_from DESC LIMIT 1`,
          [ws.workspaceOwnerId],
        ),

        db.query<{
          location_id: string;
          location_name: string;
          actual_cogs: string;
          net_revenue: string;
        }>(
          `SELECT
             m.location_id::text,
             COALESCE(l.name, 'Unknown') AS location_name,
             COALESCE(SUM(CASE WHEN m.movement_type IN ('recipe_consumption','recorded_wastage')
                               THEN ABS(COALESCE(m.total_value,0)) ELSE 0 END), 0) AS actual_cogs,
             COALESCE(SUM(CASE WHEN m.movement_type = 'recipe_consumption'
                               THEN ABS(COALESCE(m.total_value,0)) ELSE 0 END), 0) AS net_revenue
           FROM inventory_movements m
           LEFT JOIN locations l ON l.id = m.location_id
           WHERE m.workspace_owner_id = $1
             AND m.posted_at >= $2 AND m.posted_at < $3
             AND m.reversed_by_id IS NULL
           GROUP BY m.location_id, l.name
           ORDER BY actual_cogs DESC
           LIMIT 10`,
          [ws.workspaceOwnerId, range.from, range.to],
        ),

        db.query<{
          week_start: string;
          actual_cogs: string;
          theoretical_cogs: string;
          net_revenue: string;
        }>(
          `WITH weeks AS (
             SELECT generate_series(
               date_trunc('week', $2::timestamptz),
               date_trunc('week', $3::timestamptz),
               '7 days'::interval
             ) AS week_start
           )
           SELECT
             w.week_start::date::text,
             COALESCE(SUM(CASE WHEN m.movement_type IN ('recipe_consumption','recorded_wastage')
                               THEN ABS(COALESCE(m.total_value,0)) ELSE 0 END), 0) AS actual_cogs,
             0::text AS theoretical_cogs,
             0::text AS net_revenue
           FROM weeks w
           LEFT JOIN inventory_movements m
             ON m.workspace_owner_id = $1
             AND m.posted_at >= w.week_start AND m.posted_at < w.week_start + '7 days'::interval
             AND m.reversed_by_id IS NULL
           GROUP BY w.week_start
           ORDER BY w.week_start`,
          [ws.workspaceOwnerId, range.from, range.to],
        ),

        db.query<{
          base_item_id: string;
          base_item_name: string;
          cost_impact: string;
          movement_type: string;
        }>(
          `SELECT
             m.base_item_id::text,
             COALESCE(bi.name, 'Unknown') AS base_item_name,
             SUM(ABS(COALESCE(m.total_value,0))) AS cost_impact,
             m.movement_type
           FROM inventory_movements m
           LEFT JOIN base_items bi ON bi.id = m.base_item_id
           WHERE m.workspace_owner_id = $1
             AND m.posted_at >= $2 AND m.posted_at < $3
             AND m.movement_type IN ('recipe_consumption','recorded_wastage')
             AND m.reversed_by_id IS NULL
           GROUP BY m.base_item_id, bi.name, m.movement_type
           ORDER BY cost_impact DESC
           LIMIT 10`,
          [ws.workspaceOwnerId, range.from, range.to],
        ),
      ]);

    const r = cogsRow.rows[0];
    const netRevenue = num(r.net_revenue);
    const actualCogs = num(r.actual_cogs);
    const theoreticalCogs = num(r.theoretical_cogs);
    const targetCogsRow = targetRow.rows[0];
    const targetCogsPct = targetCogsRow ? num(targetCogsRow.target_cogs_pct) : null;

    const actualCogsPct = netRevenue > 0 ? (actualCogs / netRevenue) * 100 : null;
    const theoreticalCogsPct = netRevenue > 0 ? (theoreticalCogs / netRevenue) * 100 : null;
    const cogsGap =
      actualCogsPct != null && theoreticalCogsPct != null
        ? actualCogsPct - theoreticalCogsPct
        : null;
    const grossMarginPct = netRevenue > 0 ? ((netRevenue - actualCogs) / netRevenue) * 100 : null;
    const costVariance = actualCogs - theoreticalCogs;

    res.json({
      kpis: {
        netRevenue,
        actualCogs,
        actualCogsPct,
        theoreticalCogs,
        theoreticalCogsPct,
        cogsGap,
        costVariance,
        grossMarginPct,
        targetCogsPct,
        purchaseValue: num(r.purchase_value),
        recipeValue: num(r.recipe_value),
        wasteValue: num(r.waste_value),
      },
      cogsByLocation: locationRows.rows.map((row) => ({
        locationId: row.location_id,
        locationName: row.location_name,
        actualCogs: num(row.actual_cogs),
        actualCogsPct:
          num(row.net_revenue) > 0
            ? (num(row.actual_cogs) / num(row.net_revenue)) * 100
            : null,
      })),
      weeklyCogsTrend: weeklyRows.rows.map((row) => ({
        weekStart: row.week_start,
        actualCogs: num(row.actual_cogs),
        theoreticalCogs: num(row.theoretical_cogs),
        netRevenue: num(row.net_revenue),
        targetCogsPct,
      })),
      largestCogsDrivers: driverRows.rows.map((row) => ({
        baseItemId: row.base_item_id,
        baseItemName: row.base_item_name,
        costImpact: num(row.cost_impact),
        movementType: row.movement_type,
      })),
    });
  } catch (err) {
    req.log.error({ err }, "inventory-analytics overview failed");
    res.status(500).json({ error: "Failed to load inventory overview" });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/inventory-analytics/movements
// ──────────────────────────────────────────────────────────────
router.get("/inventory-analytics/movements", async (req, res) => {
  try {
    const ws = workspace(req);
    const range = resolveRange(req.query.from, req.query.to);
    const filters = parseInventoryFilters(req);

    const page = Math.max(1, parseInt((req.query.page as string) ?? "1", 10));
    const pageSize = 50;
    const offset = (page - 1) * pageSize;

    const params: (string | number | Date | null)[] = [
      ws.workspaceOwnerId,
      range.from,
      range.to,
    ];
    const conditions: string[] = [
      "m.workspace_owner_id = $1",
      "m.posted_at >= $2",
      "m.posted_at < $3",
      "m.reversed_by_id IS NULL",
    ];

    if (filters.locationId) {
      params.push(filters.locationId);
      conditions.push(`m.location_id = $${params.length}`);
    }
    if (filters.baseItemId) {
      params.push(filters.baseItemId);
      conditions.push(`m.base_item_id = $${params.length}`);
    }
    if (filters.movementType) {
      params.push(filters.movementType);
      conditions.push(`m.movement_type = $${params.length}`);
    }
    if (filters.employeeId) {
      params.push(filters.employeeId);
      conditions.push(`m.employee_id = $${params.length}`);
    }

    const where = conditions.join(" AND ");

    const [rows, countRow, kpiRow] = await Promise.all([
      db.query<{
        id: string;
        base_item_id: string;
        base_item_name: string;
        location_id: string | null;
        location_name: string | null;
        movement_type: string;
        quantity_change: string;
        unit_of_measure: string | null;
        unit_cost: string | null;
        total_value: string | null;
        currency: string;
        source_type: string | null;
        source_id: string | null;
        source_label: string | null;
        employee_id: string | null;
        notes: string | null;
        posted_at: string;
      }>(
        `SELECT
           m.id::text, m.base_item_id::text,
           COALESCE(bi.name, 'Unknown') AS base_item_name,
           m.location_id::text, COALESCE(l.name, NULL) AS location_name,
           m.movement_type, m.quantity_change::text, m.unit_of_measure,
           m.unit_cost::text, m.total_value::text, m.currency,
           m.source_type, m.source_id, m.source_label,
           m.employee_id, m.notes, m.posted_at::text
         FROM inventory_movements m
         LEFT JOIN base_items bi ON bi.id = m.base_item_id
         LEFT JOIN locations l ON l.id = m.location_id
         WHERE ${where}
         ORDER BY m.posted_at DESC
         LIMIT ${pageSize} OFFSET ${offset}`,
        params,
      ),
      db.query<{ cnt: string }>(
        `SELECT COUNT(*)::text AS cnt FROM inventory_movements m WHERE ${where}`,
        params,
      ),
      db.query<{
        opening_value: string;
        purchase_value: string;
        recipe_value: string;
        waste_value: string;
        variance_value: string;
      }>(
        `SELECT
           COALESCE(SUM(CASE WHEN movement_type = 'purchase_receipt' THEN COALESCE(total_value,0) ELSE 0 END), 0) AS purchase_value,
           COALESCE(SUM(CASE WHEN movement_type = 'recipe_consumption' THEN ABS(COALESCE(total_value,0)) ELSE 0 END), 0) AS recipe_value,
           COALESCE(SUM(CASE WHEN movement_type = 'recorded_wastage' THEN ABS(COALESCE(total_value,0)) ELSE 0 END), 0) AS waste_value,
           COALESCE(SUM(CASE WHEN movement_type = 'stock_count_adjustment' THEN COALESCE(total_value,0) ELSE 0 END), 0) AS variance_value,
           0 AS opening_value
         FROM inventory_movements m
         WHERE ${where}`,
        params,
      ),
    ]);

    const kpi = kpiRow.rows[0];
    res.json({
      movements: rows.rows,
      total: parseInt(countRow.rows[0].cnt, 10),
      page,
      pageSize,
      summary: {
        openingStockValue: num(kpi.opening_value),
        purchases: num(kpi.purchase_value),
        recipeConsumption: num(kpi.recipe_value),
        recordedWaste: num(kpi.waste_value),
        stockVariance: num(kpi.variance_value),
      },
    });
  } catch (err) {
    req.log.error({ err }, "inventory-analytics movements failed");
    res.status(500).json({ error: "Failed to load movements" });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/inventory-analytics/variance
// ──────────────────────────────────────────────────────────────
router.get("/inventory-analytics/variance", async (req, res) => {
  try {
    const ws = workspace(req);
    const range = resolveRange(req.query.from, req.query.to);

    const [byItemRows, byLocationRows, kpiRow] = await Promise.all([
      db.query<{
        base_item_id: string;
        base_item_name: string;
        recipe_qty: string;
        actual_qty: string;
        qty_variance: string;
        theoretical_cost: string;
        actual_cost: string;
        cost_variance: string;
      }>(
        `SELECT
           m.base_item_id::text,
           COALESCE(bi.name, 'Unknown') AS base_item_name,
           COALESCE(SUM(CASE WHEN m.movement_type = 'recipe_consumption' THEN ABS(m.quantity_change) ELSE 0 END), 0)::text AS recipe_qty,
           COALESCE(SUM(CASE WHEN m.movement_type = 'recipe_consumption' THEN ABS(m.quantity_change) ELSE 0 END), 0)::text AS actual_qty,
           0::text AS qty_variance,
           COALESCE(SUM(CASE WHEN m.movement_type = 'recipe_consumption' THEN ABS(COALESCE(m.total_value,0)) ELSE 0 END), 0)::text AS theoretical_cost,
           COALESCE(SUM(CASE WHEN m.movement_type IN ('recipe_consumption','recorded_wastage') THEN ABS(COALESCE(m.total_value,0)) ELSE 0 END), 0)::text AS actual_cost,
           COALESCE(SUM(CASE WHEN m.movement_type IN ('recipe_consumption','recorded_wastage') THEN ABS(COALESCE(m.total_value,0)) ELSE 0 END)
             - SUM(CASE WHEN m.movement_type = 'recipe_consumption' THEN ABS(COALESCE(m.total_value,0)) ELSE 0 END), 0)::text AS cost_variance
         FROM inventory_movements m
         LEFT JOIN base_items bi ON bi.id = m.base_item_id
         WHERE m.workspace_owner_id = $1
           AND m.posted_at >= $2 AND m.posted_at < $3
           AND m.reversed_by_id IS NULL
         GROUP BY m.base_item_id, bi.name
         ORDER BY cost_variance DESC
         LIMIT 20`,
        [ws.workspaceOwnerId, range.from, range.to],
      ),
      db.query<{
        location_id: string;
        location_name: string;
        actual_cost: string;
        theoretical_cost: string;
        cost_variance: string;
      }>(
        `SELECT
           m.location_id::text,
           COALESCE(l.name, 'No Location') AS location_name,
           COALESCE(SUM(CASE WHEN m.movement_type IN ('recipe_consumption','recorded_wastage') THEN ABS(COALESCE(m.total_value,0)) ELSE 0 END), 0)::text AS actual_cost,
           COALESCE(SUM(CASE WHEN m.movement_type = 'recipe_consumption' THEN ABS(COALESCE(m.total_value,0)) ELSE 0 END), 0)::text AS theoretical_cost,
           COALESCE(SUM(CASE WHEN m.movement_type = 'recorded_wastage' THEN ABS(COALESCE(m.total_value,0)) ELSE 0 END), 0)::text AS cost_variance
         FROM inventory_movements m
         LEFT JOIN locations l ON l.id = m.location_id
         WHERE m.workspace_owner_id = $1
           AND m.posted_at >= $2 AND m.posted_at < $3
           AND m.reversed_by_id IS NULL
         GROUP BY m.location_id, l.name
         ORDER BY cost_variance DESC`,
        [ws.workspaceOwnerId, range.from, range.to],
      ),
      db.query<{
        actual_cogs: string;
        theoretical_cogs: string;
      }>(
        `SELECT
           COALESCE(SUM(CASE WHEN movement_type IN ('recipe_consumption','recorded_wastage') THEN ABS(COALESCE(total_value,0)) ELSE 0 END), 0)::text AS actual_cogs,
           COALESCE(SUM(CASE WHEN movement_type = 'recipe_consumption' THEN ABS(COALESCE(total_value,0)) ELSE 0 END), 0)::text AS theoretical_cogs
         FROM inventory_movements
         WHERE workspace_owner_id = $1
           AND posted_at >= $2 AND posted_at < $3
           AND reversed_by_id IS NULL`,
        [ws.workspaceOwnerId, range.from, range.to],
      ),
    ]);

    const k = kpiRow.rows[0];
    const actualCogs = num(k.actual_cogs);
    const theoreticalCogs = num(k.theoretical_cogs);

    res.json({
      kpis: {
        actualCogs,
        theoreticalCogs,
        costVariance: actualCogs - theoreticalCogs,
      },
      byBaseItem: byItemRows.rows.map((r) => ({
        baseItemId: r.base_item_id,
        baseItemName: r.base_item_name,
        recipeQty: num(r.recipe_qty),
        actualQty: num(r.actual_qty),
        qtyVariance: num(r.qty_variance),
        theoreticalCost: num(r.theoretical_cost),
        actualCost: num(r.actual_cost),
        costVariance: num(r.cost_variance),
        likelyDriver: num(r.cost_variance) > 0.01 ? "unrecorded_waste" : "none",
      })),
      byLocation: byLocationRows.rows.map((r) => ({
        locationId: r.location_id,
        locationName: r.location_name,
        actualCost: num(r.actual_cost),
        theoreticalCost: num(r.theoretical_cost),
        costVariance: num(r.cost_variance),
      })),
    });
  } catch (err) {
    req.log.error({ err }, "inventory-analytics variance failed");
    res.status(500).json({ error: "Failed to load variance data" });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/inventory-analytics/wastage
// ──────────────────────────────────────────────────────────────
router.get("/inventory-analytics/wastage", async (req, res) => {
  try {
    const ws = workspace(req);
    const range = resolveRange(req.query.from, req.query.to);

    const [kpiRow, byItemRows, byReasonRows, byLocationRows, byWeekRows, recordRows] =
      await Promise.all([
        db.query<{
          waste_qty: string;
          waste_value: string;
          purchase_value: string;
        }>(
          `SELECT
             COALESCE(SUM(wr.quantity), 0)::text AS waste_qty,
             COALESCE(SUM(ABS(COALESCE(m.total_value,0))), 0)::text AS waste_value,
             0::text AS purchase_value
           FROM wastage_records wr
           LEFT JOIN inventory_movements m ON m.id = wr.movement_id
           WHERE wr.workspace_owner_id = $1
             AND wr.created_at >= $2 AND wr.created_at < $3`,
          [ws.workspaceOwnerId, range.from, range.to],
        ),
        db.query<{
          base_item_id: string;
          base_item_name: string;
          waste_qty: string;
          waste_value: string;
        }>(
          `SELECT
             wr.base_item_id::text,
             COALESCE(bi.name, 'Unknown') AS base_item_name,
             SUM(wr.quantity)::text AS waste_qty,
             COALESCE(SUM(ABS(COALESCE(m.total_value,0))), 0)::text AS waste_value
           FROM wastage_records wr
           LEFT JOIN base_items bi ON bi.id = wr.base_item_id
           LEFT JOIN inventory_movements m ON m.id = wr.movement_id
           WHERE wr.workspace_owner_id = $1
             AND wr.created_at >= $2 AND wr.created_at < $3
           GROUP BY wr.base_item_id, bi.name
           ORDER BY waste_value DESC
           LIMIT 10`,
          [ws.workspaceOwnerId, range.from, range.to],
        ),
        db.query<{ reason: string; waste_qty: string; waste_value: string }>(
          `SELECT
             wr.reason,
             SUM(wr.quantity)::text AS waste_qty,
             COALESCE(SUM(ABS(COALESCE(m.total_value,0))), 0)::text AS waste_value
           FROM wastage_records wr
           LEFT JOIN inventory_movements m ON m.id = wr.movement_id
           WHERE wr.workspace_owner_id = $1
             AND wr.created_at >= $2 AND wr.created_at < $3
           GROUP BY wr.reason
           ORDER BY waste_value DESC`,
          [ws.workspaceOwnerId, range.from, range.to],
        ),
        db.query<{
          location_id: string | null;
          location_name: string;
          waste_qty: string;
          waste_value: string;
        }>(
          `SELECT
             wr.location_id::text,
             COALESCE(l.name, 'No Location') AS location_name,
             SUM(wr.quantity)::text AS waste_qty,
             COALESCE(SUM(ABS(COALESCE(m.total_value,0))), 0)::text AS waste_value
           FROM wastage_records wr
           LEFT JOIN locations l ON l.id = wr.location_id
           LEFT JOIN inventory_movements m ON m.id = wr.movement_id
           WHERE wr.workspace_owner_id = $1
             AND wr.created_at >= $2 AND wr.created_at < $3
           GROUP BY wr.location_id, l.name
           ORDER BY waste_value DESC`,
          [ws.workspaceOwnerId, range.from, range.to],
        ),
        db.query<{ week_start: string; waste_qty: string; waste_value: string }>(
          `SELECT
             date_trunc('week', wr.created_at)::date::text AS week_start,
             SUM(wr.quantity)::text AS waste_qty,
             COALESCE(SUM(ABS(COALESCE(m.total_value,0))), 0)::text AS waste_value
           FROM wastage_records wr
           LEFT JOIN inventory_movements m ON m.id = wr.movement_id
           WHERE wr.workspace_owner_id = $1
             AND wr.created_at >= $2 AND wr.created_at < $3
           GROUP BY week_start
           ORDER BY week_start`,
          [ws.workspaceOwnerId, range.from, range.to],
        ),
        db.query<{
          id: string;
          base_item_id: string;
          base_item_name: string;
          location_id: string | null;
          location_name: string;
          quantity: string;
          unit_of_measure: string | null;
          reason: string;
          employee_id: string | null;
          order_id: string | null;
          notes: string | null;
          created_at: string;
          waste_value: string;
        }>(
          `SELECT
             wr.id::text, wr.base_item_id::text,
             COALESCE(bi.name, 'Unknown') AS base_item_name,
             wr.location_id::text, COALESCE(l.name, 'No Location') AS location_name,
             wr.quantity::text, wr.unit_of_measure, wr.reason,
             wr.employee_id, wr.order_id::text, wr.notes,
             wr.created_at::text,
             COALESCE(ABS(m.total_value),0)::text AS waste_value
           FROM wastage_records wr
           LEFT JOIN base_items bi ON bi.id = wr.base_item_id
           LEFT JOIN locations l ON l.id = wr.location_id
           LEFT JOIN inventory_movements m ON m.id = wr.movement_id
           WHERE wr.workspace_owner_id = $1
             AND wr.created_at >= $2 AND wr.created_at < $3
           ORDER BY wr.created_at DESC
           LIMIT 200`,
          [ws.workspaceOwnerId, range.from, range.to],
        ),
      ]);

    const kpi = kpiRow.rows[0];
    const wasteValue = num(kpi.waste_value);
    const purchaseValue = num(kpi.purchase_value);

    res.json({
      kpis: {
        wasteQty: num(kpi.waste_qty),
        wasteValue,
        wasteAsPctOfPurchases:
          purchaseValue > 0 ? (wasteValue / purchaseValue) * 100 : null,
      },
      byBaseItem: byItemRows.rows.map((r) => ({
        baseItemId: r.base_item_id,
        baseItemName: r.base_item_name,
        wasteQty: num(r.waste_qty),
        wasteValue: num(r.waste_value),
      })),
      byReason: byReasonRows.rows.map((r) => ({
        reason: r.reason,
        wasteQty: num(r.waste_qty),
        wasteValue: num(r.waste_value),
      })),
      byLocation: byLocationRows.rows.map((r) => ({
        locationId: r.location_id,
        locationName: r.location_name,
        wasteQty: num(r.waste_qty),
        wasteValue: num(r.waste_value),
      })),
      byWeek: byWeekRows.rows.map((r) => ({
        weekStart: r.week_start,
        wasteQty: num(r.waste_qty),
        wasteValue: num(r.waste_value),
      })),
      records: recordRows.rows.map((r) => ({
        id: r.id,
        baseItemId: r.base_item_id,
        baseItemName: r.base_item_name,
        locationId: r.location_id,
        locationName: r.location_name,
        quantity: num(r.quantity),
        unitOfMeasure: r.unit_of_measure,
        reason: r.reason,
        employeeId: r.employee_id,
        orderId: r.order_id,
        notes: r.notes,
        createdAt: r.created_at,
        wasteValue: num(r.waste_value),
      })),
    });
  } catch (err) {
    req.log.error({ err }, "inventory-analytics wastage failed");
    res.status(500).json({ error: "Failed to load wastage data" });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/inventory-analytics/procurement
// ──────────────────────────────────────────────────────────────
router.get("/inventory-analytics/procurement", async (req, res) => {
  try {
    const ws = workspace(req);
    const range = resolveRange(req.query.from, req.query.to);

    const [kpiRow, bySupplierRows, byLocationRows, byCategoryRows, costTrendRows] =
      await Promise.all([
        db.query<{
          purchase_value: string;
          received_value: string;
          pending_value: string;
        }>(
          `SELECT
             COALESCE(SUM(CASE WHEN m.movement_type = 'purchase_receipt' THEN COALESCE(m.total_value,0) ELSE 0 END), 0)::text AS purchase_value,
             COALESCE(SUM(CASE WHEN m.movement_type = 'purchase_receipt' AND m.quantity_change > 0 THEN COALESCE(m.total_value,0) ELSE 0 END), 0)::text AS received_value,
             0::text AS pending_value
           FROM inventory_movements m
           WHERE m.workspace_owner_id = $1
             AND m.posted_at >= $2 AND m.posted_at < $3
             AND m.reversed_by_id IS NULL`,
          [ws.workspaceOwnerId, range.from, range.to],
        ),
        db.query<{ supplier_label: string; purchase_value: string; order_count: string }>(
          `SELECT
             COALESCE(m.source_label, 'Unknown Supplier') AS supplier_label,
             SUM(COALESCE(m.total_value,0))::text AS purchase_value,
             COUNT(DISTINCT m.source_id)::text AS order_count
           FROM inventory_movements m
           WHERE m.workspace_owner_id = $1
             AND m.posted_at >= $2 AND m.posted_at < $3
             AND m.movement_type = 'purchase_receipt'
             AND m.reversed_by_id IS NULL
           GROUP BY m.source_label
           ORDER BY purchase_value DESC
           LIMIT 10`,
          [ws.workspaceOwnerId, range.from, range.to],
        ),
        db.query<{
          location_id: string | null;
          location_name: string;
          purchase_value: string;
        }>(
          `SELECT
             m.location_id::text,
             COALESCE(l.name, 'No Location') AS location_name,
             SUM(COALESCE(m.total_value,0))::text AS purchase_value
           FROM inventory_movements m
           LEFT JOIN locations l ON l.id = m.location_id
           WHERE m.workspace_owner_id = $1
             AND m.posted_at >= $2 AND m.posted_at < $3
             AND m.movement_type = 'purchase_receipt'
             AND m.reversed_by_id IS NULL
           GROUP BY m.location_id, l.name
           ORDER BY purchase_value DESC`,
          [ws.workspaceOwnerId, range.from, range.to],
        ),
        db.query<{ category_name: string; purchase_value: string }>(
          `SELECT
             COALESCE(bic.name, 'Uncategorized') AS category_name,
             SUM(COALESCE(m.total_value,0))::text AS purchase_value
           FROM inventory_movements m
           LEFT JOIN base_items bi ON bi.id = m.base_item_id
           LEFT JOIN base_item_categories bic ON bic.id = bi.category_id
           WHERE m.workspace_owner_id = $1
             AND m.posted_at >= $2 AND m.posted_at < $3
             AND m.movement_type = 'purchase_receipt'
             AND m.reversed_by_id IS NULL
           GROUP BY bic.name
           ORDER BY purchase_value DESC`,
          [ws.workspaceOwnerId, range.from, range.to],
        ),
        db.query<{ week_start: string; purchase_value: string; avg_unit_cost: string }>(
          `SELECT
             date_trunc('week', m.posted_at)::date::text AS week_start,
             SUM(COALESCE(m.total_value,0))::text AS purchase_value,
             AVG(COALESCE(m.unit_cost,0))::text AS avg_unit_cost
           FROM inventory_movements m
           WHERE m.workspace_owner_id = $1
             AND m.posted_at >= $2 AND m.posted_at < $3
             AND m.movement_type = 'purchase_receipt'
             AND m.reversed_by_id IS NULL
           GROUP BY week_start
           ORDER BY week_start`,
          [ws.workspaceOwnerId, range.from, range.to],
        ),
      ]);

    const kpi = kpiRow.rows[0];
    res.json({
      kpis: {
        purchaseValue: num(kpi.purchase_value),
        receivedValue: num(kpi.received_value),
        pendingValue: num(kpi.pending_value),
      },
      bySupplier: bySupplierRows.rows.map((r) => ({
        supplierLabel: r.supplier_label,
        purchaseValue: num(r.purchase_value),
        orderCount: parseInt(r.order_count, 10),
      })),
      byLocation: byLocationRows.rows.map((r) => ({
        locationId: r.location_id,
        locationName: r.location_name,
        purchaseValue: num(r.purchase_value),
      })),
      byCategory: byCategoryRows.rows.map((r) => ({
        categoryName: r.category_name,
        purchaseValue: num(r.purchase_value),
      })),
      costTrend: costTrendRows.rows.map((r) => ({
        weekStart: r.week_start,
        purchaseValue: num(r.purchase_value),
        avgUnitCost: num(r.avg_unit_cost),
      })),
    });
  } catch (err) {
    req.log.error({ err }, "inventory-analytics procurement failed");
    res.status(500).json({ error: "Failed to load procurement data" });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/inventory-analytics/transfers
// ──────────────────────────────────────────────────────────────
router.get("/inventory-analytics/transfers", async (req, res) => {
  try {
    const ws = workspace(req);
    const range = resolveRange(req.query.from, req.query.to);

    const [kpiRow, transferRows] = await Promise.all([
      db.query<{
        transfer_in_value: string;
        transfer_out_value: string;
        transfer_in_qty: string;
        transfer_out_qty: string;
      }>(
        `SELECT
           COALESCE(SUM(CASE WHEN movement_type = 'transfer_in' THEN COALESCE(total_value,0) ELSE 0 END), 0)::text AS transfer_in_value,
           COALESCE(SUM(CASE WHEN movement_type = 'transfer_out' THEN ABS(COALESCE(total_value,0)) ELSE 0 END), 0)::text AS transfer_out_value,
           COALESCE(SUM(CASE WHEN movement_type = 'transfer_in' THEN quantity_change ELSE 0 END), 0)::text AS transfer_in_qty,
           COALESCE(SUM(CASE WHEN movement_type = 'transfer_out' THEN ABS(quantity_change) ELSE 0 END), 0)::text AS transfer_out_qty
         FROM inventory_movements
         WHERE workspace_owner_id = $1
           AND posted_at >= $2 AND posted_at < $3
           AND movement_type IN ('transfer_in','transfer_out')
           AND reversed_by_id IS NULL`,
        [ws.workspaceOwnerId, range.from, range.to],
      ),
      db.query<{
        source_id: string;
        base_item_id: string;
        base_item_name: string;
        dispatched_qty: string | null;
        received_qty: string | null;
        dispatched_value: string | null;
        received_value: string | null;
        source_label: string | null;
        out_location_id: string | null;
        in_location_id: string | null;
        dispatched_at: string | null;
        received_at: string | null;
        employee_id: string | null;
      }>(
        `SELECT
           m.source_id,
           m.base_item_id::text,
           COALESCE(bi.name, 'Unknown') AS base_item_name,
           MAX(CASE WHEN m.movement_type = 'transfer_out' THEN ABS(m.quantity_change) END)::text AS dispatched_qty,
           MAX(CASE WHEN m.movement_type = 'transfer_in' THEN m.quantity_change END)::text AS received_qty,
           MAX(CASE WHEN m.movement_type = 'transfer_out' THEN ABS(COALESCE(m.total_value,0)) END)::text AS dispatched_value,
           MAX(CASE WHEN m.movement_type = 'transfer_in' THEN COALESCE(m.total_value,0) END)::text AS received_value,
           MAX(m.source_label) AS source_label,
           MAX(CASE WHEN m.movement_type = 'transfer_out' THEN m.location_id END)::text AS out_location_id,
           MAX(CASE WHEN m.movement_type = 'transfer_in' THEN m.location_id END)::text AS in_location_id,
           MAX(CASE WHEN m.movement_type = 'transfer_out' THEN m.posted_at END)::text AS dispatched_at,
           MAX(CASE WHEN m.movement_type = 'transfer_in' THEN m.posted_at END)::text AS received_at,
           MAX(m.employee_id) AS employee_id
         FROM inventory_movements m
         LEFT JOIN base_items bi ON bi.id = m.base_item_id
         WHERE m.workspace_owner_id = $1
           AND m.posted_at >= $2 AND m.posted_at < $3
           AND m.movement_type IN ('transfer_in','transfer_out')
           AND m.reversed_by_id IS NULL
         GROUP BY m.source_id, m.base_item_id, bi.name
         ORDER BY dispatched_at DESC NULLS LAST
         LIMIT 100`,
        [ws.workspaceOwnerId, range.from, range.to],
      ),
    ]);

    const kpi = kpiRow.rows[0];
    res.json({
      kpis: {
        transferInValue: num(kpi.transfer_in_value),
        transferOutValue: num(kpi.transfer_out_value),
        transferInQty: num(kpi.transfer_in_qty),
        transferOutQty: num(kpi.transfer_out_qty),
      },
      transfers: transferRows.rows.map((r) => {
        const dispatched = num(r.dispatched_qty);
        const received = num(r.received_qty);
        return {
          sourceId: r.source_id,
          baseItemId: r.base_item_id,
          baseItemName: r.base_item_name,
          dispatchedQty: dispatched,
          receivedQty: received,
          qtyVariance: received - dispatched,
          dispatchedValue: num(r.dispatched_value),
          receivedValue: num(r.received_value),
          sourceLabel: r.source_label,
          outLocationId: r.out_location_id,
          inLocationId: r.in_location_id,
          dispatchedAt: r.dispatched_at,
          receivedAt: r.received_at,
          employeeId: r.employee_id,
          status: r.received_at ? "received" : "pending",
        };
      }),
    });
  } catch (err) {
    req.log.error({ err }, "inventory-analytics transfers failed");
    res.status(500).json({ error: "Failed to load transfer data" });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/inventory-analytics/theoretical-cost
// ──────────────────────────────────────────────────────────────
router.get("/inventory-analytics/theoretical-cost", async (req, res) => {
  try {
    const ws = workspace(req);
    const range = resolveRange(req.query.from, req.query.to);

    const rows = await db.query<{
      base_item_id: string;
      base_item_name: string;
      theoretical_qty: string;
      theoretical_unit_cost: string;
      theoretical_total_cost: string;
      share_pct: string;
    }>(
      `WITH base AS (
         SELECT
           m.base_item_id,
           SUM(ABS(m.quantity_change)) AS theoretical_qty,
           AVG(COALESCE(m.unit_cost,0)) AS theoretical_unit_cost,
           SUM(ABS(COALESCE(m.total_value,0))) AS theoretical_total_cost
         FROM inventory_movements m
         WHERE m.workspace_owner_id = $1
           AND m.posted_at >= $2 AND m.posted_at < $3
           AND m.movement_type = 'recipe_consumption'
           AND m.reversed_by_id IS NULL
         GROUP BY m.base_item_id
       ),
       total AS (
         SELECT SUM(theoretical_total_cost) AS grand_total FROM base
       )
       SELECT
         b.base_item_id::text,
         COALESCE(bi.name, 'Unknown') AS base_item_name,
         b.theoretical_qty::text,
         b.theoretical_unit_cost::text,
         b.theoretical_total_cost::text,
         CASE WHEN t.grand_total > 0
              THEN (b.theoretical_total_cost / t.grand_total * 100)
              ELSE 0
         END::text AS share_pct
       FROM base b
       LEFT JOIN base_items bi ON bi.id = b.base_item_id
       CROSS JOIN total t
       ORDER BY b.theoretical_total_cost DESC`,
      [ws.workspaceOwnerId, range.from, range.to],
    );

    res.json({
      items: rows.rows.map((r) => ({
        baseItemId: r.base_item_id,
        baseItemName: r.base_item_name,
        theoreticalQty: num(r.theoretical_qty),
        theoreticalUnitCost: num(r.theoretical_unit_cost),
        theoreticalTotalCost: num(r.theoretical_total_cost),
        sharePct: num(r.share_pct),
      })),
    });
  } catch (err) {
    req.log.error({ err }, "inventory-analytics theoretical-cost failed");
    res.status(500).json({ error: "Failed to load theoretical cost data" });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/inventory-analytics/actual-cost
// ──────────────────────────────────────────────────────────────
router.get("/inventory-analytics/actual-cost", async (req, res) => {
  try {
    const ws = workspace(req);
    const range = resolveRange(req.query.from, req.query.to);

    const rows = await db.query<{
      base_item_id: string;
      base_item_name: string;
      actual_qty: string;
      actual_unit_cost: string;
      actual_total_cost: string;
      share_pct: string;
    }>(
      `WITH base AS (
         SELECT
           m.base_item_id,
           SUM(ABS(m.quantity_change)) AS actual_qty,
           AVG(COALESCE(m.unit_cost,0)) AS actual_unit_cost,
           SUM(ABS(COALESCE(m.total_value,0))) AS actual_total_cost
         FROM inventory_movements m
         WHERE m.workspace_owner_id = $1
           AND m.posted_at >= $2 AND m.posted_at < $3
           AND m.movement_type IN ('recipe_consumption','recorded_wastage')
           AND m.reversed_by_id IS NULL
         GROUP BY m.base_item_id
       ),
       total AS (
         SELECT SUM(actual_total_cost) AS grand_total FROM base
       )
       SELECT
         b.base_item_id::text,
         COALESCE(bi.name, 'Unknown') AS base_item_name,
         b.actual_qty::text,
         b.actual_unit_cost::text,
         b.actual_total_cost::text,
         CASE WHEN t.grand_total > 0
              THEN (b.actual_total_cost / t.grand_total * 100)
              ELSE 0
         END::text AS share_pct
       FROM base b
       LEFT JOIN base_items bi ON bi.id = b.base_item_id
       CROSS JOIN total t
       ORDER BY b.actual_total_cost DESC`,
      [ws.workspaceOwnerId, range.from, range.to],
    );

    res.json({
      items: rows.rows.map((r) => ({
        baseItemId: r.base_item_id,
        baseItemName: r.base_item_name,
        actualQty: num(r.actual_qty),
        actualUnitCost: num(r.actual_unit_cost),
        actualTotalCost: num(r.actual_total_cost),
        sharePct: num(r.share_pct),
      })),
    });
  } catch (err) {
    req.log.error({ err }, "inventory-analytics actual-cost failed");
    res.status(500).json({ error: "Failed to load actual cost data" });
  }
});

// ──────────────────────────────────────────────────────────────
// GET /api/inventory-analytics/cogs-target
// PUT /api/inventory-analytics/cogs-target
// ──────────────────────────────────────────────────────────────
router.get("/inventory-analytics/cogs-target", async (req, res) => {
  try {
    const ws = workspace(req);
    const row = await db.query<{
      id: string;
      target_cogs_pct: string;
      entity_id: string | null;
      location_id: string | null;
      effective_from: string;
    }>(
      `SELECT id::text, target_cogs_pct::text, entity_id, location_id::text, effective_from::text
       FROM inventory_cogs_targets
       WHERE workspace_owner_id = $1
       ORDER BY effective_from DESC
       LIMIT 1`,
      [ws.workspaceOwnerId],
    );
    res.json({
      target: row.rows[0]
        ? {
            id: row.rows[0].id,
            targetCogsPct: num(row.rows[0].target_cogs_pct),
            entityId: row.rows[0].entity_id,
            locationId: row.rows[0].location_id,
            effectiveFrom: row.rows[0].effective_from,
          }
        : null,
    });
  } catch (err) {
    req.log.error({ err }, "inventory-analytics cogs-target GET failed");
    res.status(500).json({ error: "Failed to load COGS target" });
  }
});

const CogsTargetBodySchema = z.object({
  targetCogsPct: z.number().min(0).max(100),
  entityId: z.string().nullable().optional(),
  locationId: z.number().nullable().optional(),
});

router.put("/inventory-analytics/cogs-target", async (req, res) => {
  try {
    const ws = workspace(req);
    const parsed = CogsTargetBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const { targetCogsPct, entityId, locationId } = parsed.data;
    await db.query(
      `INSERT INTO inventory_cogs_targets
         (workspace_owner_id, target_cogs_pct, entity_id, location_id, effective_from, updated_at)
       VALUES ($1, $2, $3, $4, now(), now())`,
      [ws.workspaceOwnerId, targetCogsPct, entityId ?? null, locationId ?? null],
    );
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "inventory-analytics cogs-target PUT failed");
    res.status(500).json({ error: "Failed to save COGS target" });
  }
});

// ──────────────────────────────────────────────────────────────
// POST /api/base-items/wastage
// ──────────────────────────────────────────────────────────────
const WastageBodySchema = z.object({
  actionId: z.string().uuid(),
  baseItemId: z.number().int(),
  locationId: z.number().int(),
  quantity: z.number().positive(),
  unitOfMeasure: z.string().optional(),
  reason: z.enum([
    "damaged_on_receipt",
    "expired",
    "production_damage",
    "quality_issue",
    "over_preparation",
    "cancelled_prepared_order",
    "missing_unexplained",
    "other",
  ]),
  employeeId: z.string().nullable().optional(),
  orderId: z.number().int().nullable().optional(),
  notes: z.string().nullable().optional(),
  imageUrls: z.array(z.string()).nullable().optional(),
  unitCost: z.number().nullable().optional(),
});

router.post("/base-items/wastage", async (req, res) => {
  try {
    const ws = workspace(req);
    if (!canManageBaseItems(ws)) {
      res.status(403).json({
        error: "Requires owner or base_items.manage permission",
      });
      return;
    }
    const parsed = WastageBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input", details: parsed.error.issues });
      return;
    }
    const d = parsed.data;

    const idempotencyKey = `wastage:${d.actionId}`;
    // The immutable movement actor must always be the authenticated caller.
    // employeeId is a separately assigned "responsible employee" field on the
    // wastage audit record and must never be allowed to spoof ledger authorship.
    const actorId = ws.userId ?? null;
    const payloadHash = createHash("sha256")
      .update(
        JSON.stringify({
          baseItemId: d.baseItemId,
          locationId: d.locationId,
          quantity: d.quantity,
          unitOfMeasure: d.unitOfMeasure?.trim().toLowerCase() || null,
          reason: d.reason,
            employeeId: d.employeeId ?? null,
          orderId: d.orderId ?? null,
          notes: d.notes ?? null,
          imageUrls: d.imageUrls ?? [],
          unitCost: d.unitCost ?? null,
        }),
      )
      .digest("hex");
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [`${ws.workspaceOwnerId}:${idempotencyKey}`],
      );
      const priorMovement = await client.query<{
        id: number;
        base_item_id: number;
        location_id: number;
        quantity_change: string;
        reason: string;
        note: string | null;
        metadata_snapshot: {
          actionId?: string;
          payloadHash?: string;
        } | null;
      }>(
        `SELECT id, base_item_id, location_id, quantity_change::text, reason, note, metadata_snapshot
           FROM base_item_stock_adjustments
          WHERE workspace_owner_id = $1
            AND idempotency_key = $2
          FOR UPDATE`,
        [ws.workspaceOwnerId, idempotencyKey],
      );
      if (priorMovement.rowCount! > 0) {
        const prior = priorMovement.rows[0];
        const samePayload =
          prior.metadata_snapshot?.actionId === d.actionId &&
          prior.metadata_snapshot?.payloadHash === payloadHash;
        if (!samePayload) {
          await client.query("ROLLBACK");
          res.status(409).json({
            error: "actionId already used with a different payload",
            movementId: prior.id,
          });
          return;
        }
        const existing = await client.query<{ id: string }>(
          `SELECT id::text
             FROM wastage_records
            WHERE workspace_owner_id = $1
              AND operational_movement_id = $2`,
          [ws.workspaceOwnerId, prior.id],
        );
        if (existing.rowCount === 0) {
          throw new Error("Wastage retry found an operational movement without its audit record");
        }
        await client.query("COMMIT");
        res.status(200).json({
          id: existing.rows[0].id,
          movementId: prior.id,
          duplicate: true,
        });
        return;
      }
      const target = await client.query<{
        canonical_unit: string;
        inventory_allow_negative_stock: boolean;
      }>(
        `SELECT COALESCE((
            SELECT bip.unit
              FROM base_item_packages bip
             WHERE bip.base_item_id = bi.id
               AND bip.is_default = true
             ORDER BY bip.id ASC
             LIMIT 1
          ), 'unit') AS canonical_unit,
          COALESCE(ws.inventory_allow_negative_stock, false) AS inventory_allow_negative_stock
           FROM base_items bi
            LEFT JOIN workspace_settings ws ON ws.workspace_owner_id = bi.workspace_owner_id
          WHERE bi.id = $1
            AND bi.workspace_owner_id = $2`,
        [d.baseItemId, ws.workspaceOwnerId],
      );
      if (target.rowCount === 0) {
        throw new InventoryError("INVALID_LEDGER_TARGET", {
          workspaceOwnerId: ws.workspaceOwnerId,
          baseItemId: d.baseItemId,
          locationId: d.locationId,
        });
      }
      const canonicalUnit = target.rows[0].canonical_unit;
      const allowNegativeStock =
        target.rows[0].inventory_allow_negative_stock === true;
      const requestedUnit = d.unitOfMeasure?.trim();
      // Wastage amounts are balance-changing operational values. Until an
      // explicit UOM conversion design exists, accept only the canonical unit
      // rather than silently treating (for example) a case as one unit.
      if (
        requestedUnit &&
        requestedUnit.toLocaleLowerCase() !== canonicalUnit.toLocaleLowerCase()
      ) {
        await client.query("ROLLBACK");
        res.status(400).json({
          error: "INVALID_UNIT_OF_MEASURE",
          details: { requestedUnit, canonicalUnit },
        });
        return;
      }
      const movement = await postOperationalMovement(client, {
        workspaceOwnerId: ws.workspaceOwnerId,
        baseItemId: d.baseItemId,
        locationId: d.locationId,
        movementType: "waste_damage",
        quantityChange: -d.quantity,
        canonicalUnit,
        reason: `Wastage: ${d.reason}`,
        note: d.notes,
        createdByUserId: actorId,
        actorType: actorId ? "user" : "system",
        actorId,
        sourceType: "wastage_record",
        sourceId: idempotencyKey,
        sourceLabelSnapshot: `Wastage: ${d.reason}`,
        referenceType: d.orderId != null ? "order" : "wastage",
        referenceId: d.orderId?.toString() ?? null,
        referenceLabelSnapshot: d.orderId != null
          ? `Order #${d.orderId}`
          : `Wastage: ${d.reason}`,
        idempotencyKey,
        inventoryAllowNegativeStock: allowNegativeStock,
        metadataSnapshot: {
          actionId: d.actionId,
          payloadHash,
          reason: d.reason,
          imageUrls: d.imageUrls ?? [],
          unitCost: d.unitCost ?? null,
          requestedUnit: requestedUnit ?? canonicalUnit,
          canonicalUnit,
        },
      });

      if (!movement.posted || movement.movementId == null) {
        throw new Error("Wastage action was serialized but did not create an operational movement");
      }

      // Deliberately do not write inventory_movements here. That generic
      // analytics/costing store is not an on-hand source and needs its own
      // explicit migration/reconciliation plan before any dual-write is added.
      const wastageRow = await client.query<{ id: string }>(
        `INSERT INTO wastage_records
           (workspace_owner_id, base_item_id, location_id, quantity, unit_of_measure, reason,
            employee_id, order_id, notes, image_urls, operational_movement_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         RETURNING id::text`,
        [
          ws.workspaceOwnerId,
          d.baseItemId,
          d.locationId,
          d.quantity,
          canonicalUnit,
          d.reason,
          d.employeeId ?? null,
          d.orderId ?? null,
          d.notes ?? null,
          d.imageUrls ? JSON.stringify(d.imageUrls) : null,
          movement.movementId,
        ],
      );

      await client.query("COMMIT");
      res.status(201).json({ id: wastageRow.rows[0].id, movementId: movement.movementId });
    } catch (err) {
      await client.query("ROLLBACK");
      if (err instanceof InventoryError) {
        res.status(400).json({ error: err.code, details: err.detail });
        return;
      }
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    req.log.error({ err }, "base-items wastage POST failed");
    res.status(500).json({ error: "Failed to record wastage" });
  }
});

export default router;
