import { db } from "./db";
import type { Logger } from "pino";

type MinimalLogger = Pick<Logger, "info">;

/**
 * Checks whether all 6 setup conditions for a location are now satisfied,
 * and if the location is still in `setup_incomplete` status, atomically
 * transitions it to `active`.
 *
 * Safe to call speculatively — it is a no-op when:
 * - the location is not in `setup_incomplete` state, or
 * - any of the 6 conditions is not yet met.
 */
export async function maybeAutoActivateLocation(
  ownerId: string,
  locationId: number,
  log?: MinimalLogger,
): Promise<void> {
  const result = await db.query<{
    status: string;
    has_devices: boolean;
    has_brands: boolean;
    has_products: boolean;
    has_operating_hours: boolean;
    has_routing: boolean;
    has_capacity: boolean;
  }>(
    `SELECT
       l.status,
       (COALESCE(dev.device_count, 0) > 0)::boolean  AS has_devices,
       (COALESCE(br.brands_count,  0) > 0)::boolean  AS has_brands,
       (COALESCE(pr.products_count,0) > 0)::boolean  AS has_products,
       (
         l.operating_hours IS NOT NULL
         AND jsonb_typeof(l.operating_hours) = 'object'
         AND l.operating_hours != '{}'::jsonb
         AND EXISTS (
           SELECT 1
           FROM jsonb_each(l.operating_hours) AS day(key, val)
           WHERE (val->>'closed') IS DISTINCT FROM 'true'
             AND val->>'open'  IS NOT NULL AND val->>'open'  != ''
             AND val->>'close' IS NOT NULL AND val->>'close' != ''
         )
       )::boolean AS has_operating_hours,
       (
         l.auto_routing_enabled = true
         OR l.backup_location_id IS NOT NULL
         OR (l.served_area_ids IS NOT NULL AND jsonb_array_length(l.served_area_ids) > 0)
       )::boolean AS has_routing,
       (l.daily_capacity IS NOT NULL AND l.daily_capacity > 0)::boolean AS has_capacity
     FROM locations l
     LEFT JOIN LATERAL (
       SELECT COUNT(DISTINCT d.id)::int AS device_count
       FROM devices d WHERE d.location_id = l.id
     ) dev ON true
     LEFT JOIN LATERAL (
       SELECT COUNT(DISTINCT lb.brand_id)::int AS brands_count
       FROM location_brands lb
       WHERE lb.location_id = l.id AND lb.workspace_owner_id = l.workspace_owner_id
     ) br ON true
     LEFT JOIN LATERAL (
       SELECT COUNT(DISTINCT p.id)::int AS products_count
       FROM location_brands lb
       JOIN brands b ON b.id = lb.brand_id
       JOIN products p ON p.workspace_owner_id = l.workspace_owner_id
                      AND p.brand = b.name
                      AND p.status != 'not_available'
       WHERE lb.location_id = l.id AND lb.workspace_owner_id = l.workspace_owner_id
     ) pr ON true
     WHERE l.id = $1 AND l.workspace_owner_id = $2`,
    [locationId, ownerId],
  );

  if (result.rowCount === 0) return;
  const row = result.rows[0];

  if (row.status !== "setup_incomplete") return;

  if (
    row.has_devices &&
    row.has_brands &&
    row.has_products &&
    row.has_operating_hours &&
    row.has_routing &&
    row.has_capacity
  ) {
    await db.query(
      `UPDATE locations SET status = 'active'
       WHERE id = $1 AND workspace_owner_id = $2 AND status = 'setup_incomplete'`,
      [locationId, ownerId],
    );
    log?.info({ locationId }, "Location auto-activated: all setup steps complete");
  }
}

/**
 * Finds all setup_incomplete locations that have a specific brand name linked,
 * then calls maybeAutoActivateLocation for each.
 *
 * Use after a product is created or its brand / status changes, since products
 * are linked to locations indirectly through brand names.
 */
export async function maybeAutoActivateLocationsByBrand(
  ownerId: string,
  brandName: string | null,
  log?: MinimalLogger,
): Promise<void> {
  if (!brandName) return;

  const locResult = await db.query<{ location_id: number }>(
    `SELECT lb.location_id
       FROM location_brands lb
       JOIN brands b ON b.id = lb.brand_id
       JOIN locations l ON l.id = lb.location_id
      WHERE lb.workspace_owner_id = $1
        AND b.name = $2
        AND l.status = 'setup_incomplete'`,
    [ownerId, brandName],
  );

  for (const row of locResult.rows) {
    await maybeAutoActivateLocation(ownerId, row.location_id, log);
  }
}
