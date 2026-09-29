import pg from "pg";
import path from "path";
import fs from "fs";

/**
 * IDs of the records seeded for the protected-route smoke tests.
 *
 * These IDs are written to `.protected-route-ids.json` so both the runtime
 * route list (`src/protected-routes.ts`) and Playwright specs can read them
 * synchronously without a DB connection.
 */
export type ProtectedRouteIds = {
  brandId: string;
  locationId: string;
  productId: string;
  baseItemId: string;
  customerId: string;
  driverId: string;
  budgetId: string;
  purchaseOrderId: string;
};

export const PROTECTED_ROUTE_IDS_PATH = path.join(
  import.meta.dirname,
  ".protected-route-ids.json",
);

const SEED = {
  brand: "e2e-protected-routes-brand",
  location: "e2e-protected-routes-location",
  productSku: "E2E-PROTECTED-ROUTES-PRODUCT",
  productName: "e2e-protected-routes-product",
  baseItemCode: "E2E-PROTECTED-ROUTES-BASE-ITEM",
  baseItemName: "e2e-protected-routes-base-item",
  customerEmail: "e2e-protected-routes-customer@presentail.test",
  driverFirstName: "E2EDriver",
  driverLastName: "ProtectedRoutes",
  driverVehicleType: "motorcycle",
  budgetName: "e2e-protected-routes-budget",
} as const;

/**
 * Find an existing row by a natural key, otherwise insert it. Avoids relying
 * on `ON CONFLICT` so we don't need a database-level unique constraint
 * matching the natural key (some of the relevant tables only have partial
 * unique indexes, which Postgres won't accept as conflict targets).
 */
async function upsertReturningId(
  pool: pg.Pool,
  table: string,
  selectWhere: string,
  selectParams: unknown[],
  insertColumns: string,
  insertPlaceholders: string,
  insertParams: unknown[],
): Promise<number> {
  const found = await pool.query<{ id: number }>(
    `SELECT id FROM ${table} WHERE ${selectWhere} LIMIT 1`,
    selectParams,
  );
  if (found.rows.length > 0) return found.rows[0].id;

  const inserted = await pool.query<{ id: number }>(
    `INSERT INTO ${table} (${insertColumns}) VALUES (${insertPlaceholders}) RETURNING id`,
    insertParams,
  );
  return inserted.rows[0].id;
}

/**
 * Idempotently seed one brand, location, product, base item, and customer
 * for the protected-route e2e tests, returning the resulting IDs.
 */
export async function seedProtectedRouteRecords(
  pool: pg.Pool,
  ownerUserId: string,
): Promise<ProtectedRouteIds> {
  if (!ownerUserId) {
    throw new Error("seedProtectedRouteRecords: ownerUserId is required");
  }
  const owner = ownerUserId;

  const brandId = await upsertReturningId(
    pool,
    "brands",
    "workspace_owner_id = $1 AND name = $2",
    [owner, SEED.brand],
    "workspace_owner_id, name",
    "$1, $2",
    [owner, SEED.brand],
  );

  const locationId = await upsertReturningId(
    pool,
    "locations",
    "workspace_owner_id = $1 AND name = $2",
    [owner, SEED.location],
    "workspace_owner_id, name",
    "$1, $2",
    [owner, SEED.location],
  );

  const productId = await upsertReturningId(
    pool,
    "products",
    "workspace_owner_id = $1 AND sku = $2",
    [owner, SEED.productSku],
    "workspace_owner_id, name, sku",
    "$1, $2, $3",
    [owner, SEED.productName, SEED.productSku],
  );

  const baseItemId = await upsertReturningId(
    pool,
    "base_items",
    "workspace_owner_id = $1 AND code = $2",
    [owner, SEED.baseItemCode],
    "workspace_owner_id, name, code",
    "$1, $2, $3",
    [owner, SEED.baseItemName, SEED.baseItemCode],
  );

  const customerId = await upsertReturningId(
    pool,
    "customers",
    "workspace_owner_id = $1 AND email = $2",
    [owner, SEED.customerEmail],
    "workspace_owner_id, email, first_name, last_name",
    "$1, $2, $3, $4",
    [owner, SEED.customerEmail, "E2E", "Protected"],
  );

  const driverId = await upsertReturningId(
    pool,
    "fleet_drivers",
    "workspace_owner_id = $1 AND first_name = $2 AND last_name = $3",
    [owner, SEED.driverFirstName, SEED.driverLastName],
    "workspace_owner_id, first_name, last_name, vehicle_type",
    "$1, $2, $3, $4",
    [owner, SEED.driverFirstName, SEED.driverLastName, SEED.driverVehicleType],
  );

  const budgetId = await upsertReturningId(
    pool,
    "budget_configs",
    "workspace_owner_id = $1 AND name = $2",
    [owner, SEED.budgetName],
    "workspace_owner_id, name, month, year, start_date, end_date, currency, channels",
    "$1, $2, $3, $4, $5, $6, $7, $8",
    [owner, SEED.budgetName, 1, 2026, "2026-01-01", "2026-01-31", "AED", "[]"],
  );

  return {
    brandId: String(brandId),
    locationId: String(locationId),
    productId: String(productId),
    baseItemId: String(baseItemId),
    customerId: String(customerId),
    driverId: String(driverId),
    budgetId: String(budgetId),
  };
}

/**
 * Run the seed against `DATABASE_URL` and persist the resulting IDs to
 * `.protected-route-ids.json`. Skips silently when no DATABASE_URL is set
 * so unit tests / CI environments without a DB still work.
 */
export async function seedAndPersistProtectedRouteIds(
  ownerUserId: string,
): Promise<void> {
  if (!process.env.DATABASE_URL) {
    // Remove any stale seed file from a previous run with DB access — its
    // IDs would no longer correspond to records in the (now-absent) DB.
    try {
      fs.unlinkSync(PROTECTED_ROUTE_IDS_PATH);
    } catch {
      // file not present — fine
    }
    return;
  }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    const ids = await seedProtectedRouteRecords(pool, ownerUserId);
    fs.writeFileSync(PROTECTED_ROUTE_IDS_PATH, JSON.stringify(ids, null, 2));
  } finally {
    await pool.end();
  }
}
