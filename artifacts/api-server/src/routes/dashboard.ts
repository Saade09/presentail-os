import { Router } from "express";
import {
  GetOperationsDashboardSummaryQueryParams,
  GetOperationsDashboardSummaryResponse,
} from "@workspace/api-zod";
import { db } from "../lib/db";
import { requireAuth } from "../lib/auth";
import { hasPageAccess, resolveWorkspace, workspace } from "../lib/workspace";
import { cardPhotoSatisfiedSql } from "../lib/floristEvidence";

const router = Router();

router.use(requireAuth, resolveWorkspace);

function isValidTimeZone(timeZone: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone });
    return true;
  } catch {
    return false;
  }
}

function parseLocalCalendarDate(value: unknown): {
  raw: string;
  date: Date;
} | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    return null;
  }
  return { raw: value, date };
}

/**
 * GET /api/dashboard/operations-summary
 * Returns the action counts used by the permission-gated Ops dashboard.
 */
router.get("/dashboard/operations-summary", async (req, res): Promise<void> => {
  const wreq = workspace(req);
  if (!hasPageAccess(wreq, "ops-dashboard")) {
    res.status(403).json({ error: "You do not have access to the Ops Dashboard" });
    return;
  }

  const localDate = parseLocalCalendarDate(req.query.date);
  const timeZone = typeof req.query.tz === "string" ? req.query.tz.trim() : "";
  const parsed = GetOperationsDashboardSummaryQueryParams.safeParse({
    date: localDate?.date,
    tz: timeZone,
  });
  if (!localDate || !parsed.success || !isValidTimeZone(timeZone)) {
    res.status(400).json({ error: "A valid local date and IANA time zone are required" });
    return;
  }

  const ownerId = wreq.workspaceOwnerId;
  const [floristResult, cmcResult, processingResult] = await Promise.all([
    db.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM order_florist_assignments ofa
         JOIN orders o
           ON o.id = ofa.order_id
          AND o.workspace_owner_id = ofa.workspace_owner_id
        WHERE ofa.workspace_owner_id = $1
          AND ofa.status <> 'completed'
          AND ofa.verification_status = 'rejected'
          AND ofa.photo_items_path IS NOT NULL
          AND ${cardPhotoSatisfiedSql("ofa", "o")}`,
      [ownerId],
    ),
    db.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM cmc_requests
        WHERE workspace_owner_id = $1
          AND status = 'submitted'`,
      [ownerId],
    ),
    db.query<{ count: number }>(
      `SELECT count(*)::int AS count
         FROM orders o
        WHERE o.workspace_owner_id = $1
          AND o.status = 'processing'
           AND CASE
                 WHEN o.delivery_address->>'date' ~ '^\\d{4}-\\d{2}-\\d{2}$'
                 THEN o.delivery_address->>'date'
                 ELSE to_char((o.window_start AT TIME ZONE $2)::date, 'YYYY-MM-DD')
               END = $3`,
      [ownerId, timeZone, localDate.raw],
    ),
  ]);

  res.json(
    GetOperationsDashboardSummaryResponse.parse({
      florist_manual_review_count: Number(floristResult.rows[0]?.count ?? 0),
      cmc_submitted_request_count: Number(cmcResult.rows[0]?.count ?? 0),
      processing_orders_today_count: Number(processingResult.rows[0]?.count ?? 0),
    }),
  );
});

/**
 * GET /api/dashboard/summary
 * Returns aggregate counts for the Project Manager dashboard:
 * - total_brands, total_locations, total_channels
 * - products_available, products_out_of_stock, products_not_available
 * - brands_without_products, total_base_items, low_stock_base_items, out_of_stock_base_items
 *
 * Respects location-based access restrictions:
 * - When assignedLocationIds is non-null and non-empty, counts are scoped:
 *   - total_locations: only the assigned location IDs
 *   - total_brands: only brands linked to the assigned locations via location_brands
 *   - product counts: only products whose brand name matches a brand linked to
 *     the assigned locations
 *   - total_channels: workspace-wide (channels have no location concept)
 *   - base item counts: workspace-wide (base items have no location concept)
 */
router.get("/dashboard/summary", async (req, res) => {
  const wreq = workspace(req);
  const ownerId = wreq.workspaceOwnerId;
  const assignedLocationIds = wreq.assignedLocationIds;

  const isLocationRestricted =
    assignedLocationIds !== null && assignedLocationIds.length > 0;

  const [
    brandsResult,
    locationsResult,
    channelsResult,
    productsResult,
    brandsWithoutProductsResult,
    totalBaseItemsResult,
    lowStockBaseItemsResult,
    outOfStockBaseItemsResult,
  ] = await Promise.all([
    isLocationRestricted
      ? db.query<{ count: string }>(
          `SELECT COUNT(DISTINCT b.id) AS count
             FROM brands b
             JOIN location_brands lb ON lb.brand_id = b.id
            WHERE b.workspace_owner_id = $1
              AND lb.location_id = ANY($2::int[])
              AND lb.workspace_owner_id = $1`,
          [ownerId, assignedLocationIds],
        )
      : db.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM brands WHERE workspace_owner_id = $1`,
          [ownerId],
        ),

    isLocationRestricted
      ? db.query<{ count: string }>(
          `SELECT COUNT(*) AS count
             FROM locations
            WHERE workspace_owner_id = $1
              AND id = ANY($2::int[])`,
          [ownerId, assignedLocationIds],
        )
      : db.query<{ count: string }>(
          `SELECT COUNT(*) AS count FROM locations WHERE workspace_owner_id = $1`,
          [ownerId],
        ),

    db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM channels WHERE workspace_owner_id = $1`,
      [ownerId],
    ),

    isLocationRestricted
      ? db.query<{ status: string; count: string }>(
          `SELECT p.status, COUNT(*) AS count
             FROM products p
            WHERE p.workspace_owner_id = $1
              AND p.brand IN (
                SELECT DISTINCT b.name
                  FROM brands b
                  JOIN location_brands lb ON lb.brand_id = b.id
                 WHERE lb.workspace_owner_id = $1
                   AND lb.location_id = ANY($2::int[])
              )
            GROUP BY p.status`,
          [ownerId, assignedLocationIds],
        )
      : db.query<{ status: string; count: string }>(
          `SELECT status, COUNT(*) AS count
             FROM products
            WHERE workspace_owner_id = $1
            GROUP BY status`,
          [ownerId],
        ),

    // Brands without any associated products (location-restricted when applicable)
    isLocationRestricted
      ? db.query<{ count: string }>(
          `SELECT COUNT(DISTINCT b.id) AS count
             FROM brands b
             JOIN location_brands lb ON lb.brand_id = b.id
            WHERE b.workspace_owner_id = $1
              AND lb.location_id = ANY($2::int[])
              AND lb.workspace_owner_id = $1
              AND NOT EXISTS (
                SELECT 1 FROM products p
                 WHERE p.workspace_owner_id = $1
                   AND p.brand = b.name
              )`,
          [ownerId, assignedLocationIds],
        )
      : db.query<{ count: string }>(
          `SELECT COUNT(*) AS count
             FROM brands b
            WHERE b.workspace_owner_id = $1
              AND NOT EXISTS (
                SELECT 1 FROM products p
                 WHERE p.workspace_owner_id = $1
                   AND p.brand = b.name
              )`,
          [ownerId],
        ),

    // Total base items
    db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM base_items WHERE workspace_owner_id = $1`,
      [ownerId],
    ),

    // Low stock base items: stock > 0 AND stock <= low_stock_threshold
    db.query<{ count: string }>(
      `SELECT COUNT(*) AS count
         FROM base_items
        WHERE workspace_owner_id = $1
          AND stock > 0
          AND low_stock_threshold > 0
          AND stock <= low_stock_threshold`,
      [ownerId],
    ),

    // Out of stock base items: stock <= 0
    db.query<{ count: string }>(
      `SELECT COUNT(*) AS count
         FROM base_items
        WHERE workspace_owner_id = $1
          AND stock <= 0`,
      [ownerId],
    ),
  ]);

  const productCounts: Record<string, number> = {};
  for (const row of productsResult.rows) {
    productCounts[row.status] = parseInt(row.count, 10);
  }

  res.json({
    total_brands: parseInt(brandsResult.rows[0]?.count ?? "0", 10),
    total_locations: parseInt(locationsResult.rows[0]?.count ?? "0", 10),
    total_channels: parseInt(channelsResult.rows[0]?.count ?? "0", 10),
    products_available: productCounts["available"] ?? 0,
    products_out_of_stock: productCounts["out_of_stock"] ?? 0,
    products_not_available: productCounts["not_available"] ?? 0,
    brands_without_products: parseInt(brandsWithoutProductsResult.rows[0]?.count ?? "0", 10),
    total_base_items: parseInt(totalBaseItemsResult.rows[0]?.count ?? "0", 10),
    low_stock_base_items: parseInt(lowStockBaseItemsResult.rows[0]?.count ?? "0", 10),
    out_of_stock_base_items: parseInt(outOfStockBaseItemsResult.rows[0]?.count ?? "0", 10),
  });
});

export default router;
