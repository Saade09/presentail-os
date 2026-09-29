/**
 * Integration test: verifies that maybeAutoActivateLocation transitions a
 * location from setup_incomplete → active when all 6 conditions are met
 * against a real PostgreSQL engine, and leaves the status unchanged when any
 * single condition is missing.
 *
 * Also verifies maybeAutoActivateLocationsByBrand dispatches correctly.
 *
 * Auth and workspace middleware are NOT involved — the lib functions are
 * called directly. The database is real (provided by test-integration-local.sh).
 * The suite skips automatically when DATABASE_URL is not set.
 *
 * Run via:
 *   pnpm --filter @workspace/api-server run test:integration:local
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import {
  maybeAutoActivateLocation,
  maybeAutoActivateLocationsByBrand,
} from "./locationSetup";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;

const OWNER_ID = "__loc_setup_int_test__";

// ─────────────────────────────────────────────────────────────────────────────
// Valid seed values
// ─────────────────────────────────────────────────────────────────────────────

/** A valid operating_hours object: Monday open 09:00–18:00 (not closed). */
const VALID_OH = JSON.stringify({
  monday: { open: "09:00", close: "18:00" },
});

/** operating_hours where every listed day is explicitly closed. */
const ALL_CLOSED_OH = JSON.stringify({
  monday: { open: "09:00", close: "18:00", closed: "true" },
});

/** operating_hours that is an empty object — no days configured. */
const EMPTY_OH = "{}";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

type Pool = InstanceType<typeof Pool>;

/** Insert a bare location row; returns its id. */
async function insertLocation(
  pool: Pool,
  opts: {
    status?: string;
    daily_capacity?: number | null;
    auto_routing_enabled?: boolean | null;
    operating_hours?: string | null;
  } = {},
): Promise<number> {
  const {
    status = "setup_incomplete",
    daily_capacity = 10,
    auto_routing_enabled = true,
    operating_hours = VALID_OH,
  } = opts;

  const r = await pool.query<{ id: number }>(
    `INSERT INTO locations
       (workspace_owner_id, name, country, status,
        daily_capacity, auto_routing_enabled, operating_hours)
     VALUES ($1, 'Setup Integration Location', 'Lebanon', $2, $3, $4, $5::jsonb)
     RETURNING id`,
    [OWNER_ID, status, daily_capacity, auto_routing_enabled, operating_hours],
  );
  return r.rows[0].id;
}

/** Seed a device linked to locationId. */
async function seedDevice(pool: Pool, locationId: number): Promise<void> {
  await pool.query(
    `INSERT INTO devices (user_id, name, machine_id, location_id)
     VALUES ($1, 'Printer', $2, $3)`,
    [OWNER_ID, `mach-setup-${locationId}-${Date.now()}`, locationId],
  );
}

/** Seed a brand + location_brands link. Returns the brand name. */
async function seedBrand(pool: Pool, locationId: number): Promise<string> {
  const brandName = `SetupBrand-${locationId}`;
  const br = await pool.query<{ id: number }>(
    `INSERT INTO brands (workspace_owner_id, name) VALUES ($1, $2) RETURNING id`,
    [OWNER_ID, brandName],
  );
  const brandId = br.rows[0].id;
  await pool.query(
    `INSERT INTO location_brands (workspace_owner_id, location_id, brand_id)
     VALUES ($1, $2, $3)`,
    [OWNER_ID, locationId, brandId],
  );
  return brandName;
}

/** Seed a product with the given brand name and status. */
async function seedProduct(
  pool: Pool,
  brandName: string,
  status = "available",
): Promise<void> {
  await pool.query(
    `INSERT INTO products (workspace_owner_id, name, brand, status)
     VALUES ($1, $2, $3, $4)`,
    [OWNER_ID, `SetupProduct-${brandName}`, brandName, status],
  );
}

/** Seed all 6 conditions for locationId. Returns the brand name used. */
async function seedAllConditions(pool: Pool, locationId: number): Promise<string> {
  await seedDevice(pool, locationId);
  const brandName = await seedBrand(pool, locationId);
  await seedProduct(pool, brandName);
  // daily_capacity, auto_routing_enabled, operating_hours are baked into the location row
  return brandName;
}

/** Read the current status column from the locations table. */
async function getStatus(pool: Pool, locationId: number): Promise<string> {
  const r = await pool.query<{ status: string }>(
    `SELECT status FROM locations WHERE id = $1`,
    [locationId],
  );
  return r.rows[0].status;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!DATABASE_URL)(
  "maybeAutoActivateLocation — real DB (integration)",
  () => {
    let pool: Pool;

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });

      // Purge any leftovers from previous failed runs (FK-safe order).
      await pool.query(`DELETE FROM products       WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM devices        WHERE user_id = $1`, [OWNER_ID]);
      // Deleting locations cascades to location_brands.
      await pool.query(`DELETE FROM locations      WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM brands         WHERE workspace_owner_id = $1`, [OWNER_ID]);
    });

    afterAll(async () => {
      if (!pool) return;
      await pool.query(`DELETE FROM products       WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM devices        WHERE user_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM locations      WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM brands         WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.end();
    });

    // ── Happy path ──────────────────────────────────────────────────────────

    it("transitions setup_incomplete → active when all 6 conditions are satisfied", async () => {
      const locationId = await insertLocation(pool);
      await seedAllConditions(pool, locationId);

      await maybeAutoActivateLocation(OWNER_ID, locationId);

      expect(await getStatus(pool, locationId)).toBe("active");
    });

    // ── No-op when status is already not setup_incomplete ───────────────────

    it("does not change status when location is already active", async () => {
      const locationId = await insertLocation(pool, { status: "active" });
      await seedAllConditions(pool, locationId);

      await maybeAutoActivateLocation(OWNER_ID, locationId);

      expect(await getStatus(pool, locationId)).toBe("active");
    });

    it("does not change status when location is paused", async () => {
      const locationId = await insertLocation(pool, { status: "paused" });
      await seedAllConditions(pool, locationId);

      await maybeAutoActivateLocation(OWNER_ID, locationId);

      expect(await getStatus(pool, locationId)).toBe("paused");
    });

    // ── Missing exactly one flag ─────────────────────────────────────────────

    it("stays setup_incomplete when no device is linked (has_devices = false)", async () => {
      const locationId = await insertLocation(pool);
      // Seed brands + products + all non-device conditions — skip device.
      const brandName = await seedBrand(pool, locationId);
      await seedProduct(pool, brandName);

      await maybeAutoActivateLocation(OWNER_ID, locationId);

      expect(await getStatus(pool, locationId)).toBe("setup_incomplete");
    });

    it("stays setup_incomplete when no brand is linked to the location (has_brands = false)", async () => {
      const locationId = await insertLocation(pool);
      // Seed device only — no brand or location_brands row.
      await seedDevice(pool, locationId);

      await maybeAutoActivateLocation(OWNER_ID, locationId);

      expect(await getStatus(pool, locationId)).toBe("setup_incomplete");
    });

    it("stays setup_incomplete when no available product exists for the linked brand (has_products = false)", async () => {
      const locationId = await insertLocation(pool);
      await seedDevice(pool, locationId);
      const brandName = await seedBrand(pool, locationId);
      // Insert product but mark it not_available — should not count.
      await seedProduct(pool, brandName, "not_available");

      await maybeAutoActivateLocation(OWNER_ID, locationId);

      expect(await getStatus(pool, locationId)).toBe("setup_incomplete");
    });

    it("stays setup_incomplete when operating_hours is NULL (has_operating_hours = false)", async () => {
      const locationId = await insertLocation(pool, { operating_hours: null });
      await seedAllConditions(pool, locationId);

      await maybeAutoActivateLocation(OWNER_ID, locationId);

      expect(await getStatus(pool, locationId)).toBe("setup_incomplete");
    });

    it("stays setup_incomplete when operating_hours is an empty object (has_operating_hours = false)", async () => {
      const locationId = await insertLocation(pool, { operating_hours: EMPTY_OH });
      await seedAllConditions(pool, locationId);

      await maybeAutoActivateLocation(OWNER_ID, locationId);

      expect(await getStatus(pool, locationId)).toBe("setup_incomplete");
    });

    it("stays setup_incomplete when all days in operating_hours are closed (has_operating_hours = false)", async () => {
      const locationId = await insertLocation(pool, { operating_hours: ALL_CLOSED_OH });
      await seedAllConditions(pool, locationId);

      await maybeAutoActivateLocation(OWNER_ID, locationId);

      expect(await getStatus(pool, locationId)).toBe("setup_incomplete");
    });

    it("stays setup_incomplete when no routing is configured (has_routing = false)", async () => {
      // auto_routing_enabled=false, no backup_location_id, no served_area_ids
      const locationId = await insertLocation(pool, { auto_routing_enabled: false });
      await seedAllConditions(pool, locationId);

      await maybeAutoActivateLocation(OWNER_ID, locationId);

      expect(await getStatus(pool, locationId)).toBe("setup_incomplete");
    });

    it("stays setup_incomplete when daily_capacity is 0 (has_capacity = false)", async () => {
      const locationId = await insertLocation(pool, { daily_capacity: 0 });
      await seedAllConditions(pool, locationId);

      await maybeAutoActivateLocation(OWNER_ID, locationId);

      expect(await getStatus(pool, locationId)).toBe("setup_incomplete");
    });

    it("stays setup_incomplete when daily_capacity is NULL (has_capacity = false)", async () => {
      const locationId = await insertLocation(pool, { daily_capacity: null });
      await seedAllConditions(pool, locationId);

      await maybeAutoActivateLocation(OWNER_ID, locationId);

      expect(await getStatus(pool, locationId)).toBe("setup_incomplete");
    });

    // ── Routing alternatives ─────────────────────────────────────────────────

    it("activates when routing is satisfied via a non-empty served_area_ids array", async () => {
      const locationId = await insertLocation(pool, { auto_routing_enabled: false });
      // Patch served_area_ids directly (not a constructor param).
      await pool.query(
        `UPDATE locations SET served_area_ids = '[1]'::jsonb WHERE id = $1`,
        [locationId],
      );
      await seedAllConditions(pool, locationId);

      await maybeAutoActivateLocation(OWNER_ID, locationId);

      expect(await getStatus(pool, locationId)).toBe("active");
    });

    it("activates when routing is satisfied via backup_location_id IS NOT NULL", async () => {
      // Insert a second location to act as the backup target (FK constraint).
      const backupLocationId = await insertLocation(pool, { auto_routing_enabled: false });

      const locationId = await insertLocation(pool, { auto_routing_enabled: false });
      // Point to the backup location — satisfies the third routing branch.
      await pool.query(
        `UPDATE locations SET backup_location_id = $1 WHERE id = $2`,
        [backupLocationId, locationId],
      );
      await seedAllConditions(pool, locationId);

      await maybeAutoActivateLocation(OWNER_ID, locationId);

      expect(await getStatus(pool, locationId)).toBe("active");
    });

    // ── Cross-workspace isolation ────────────────────────────────────────────

    it("is a no-op when the location belongs to a different workspace owner", async () => {
      const locationId = await insertLocation(pool);
      await seedAllConditions(pool, locationId);

      // Call with a different ownerId — should not find the row.
      await maybeAutoActivateLocation("__different_owner__", locationId);

      expect(await getStatus(pool, locationId)).toBe("setup_incomplete");
    });

    // ── maybeAutoActivateLocationsByBrand ────────────────────────────────────

    it("maybeAutoActivateLocationsByBrand activates all matching setup_incomplete locations", async () => {
      // Two locations that have all conditions except they are both linked to the same brand.
      const locAId = await insertLocation(pool);
      const locBId = await insertLocation(pool);

      await seedDevice(pool, locAId);
      await seedDevice(pool, locBId);

      // Share one brand name across both locations.
      const sharedBrandName = `SharedBrand-${Date.now()}`;
      const br = await pool.query<{ id: number }>(
        `INSERT INTO brands (workspace_owner_id, name) VALUES ($1, $2) RETURNING id`,
        [OWNER_ID, sharedBrandName],
      );
      const brandId = br.rows[0].id;
      await pool.query(
        `INSERT INTO location_brands (workspace_owner_id, location_id, brand_id)
         VALUES ($1, $2, $3), ($1, $4, $3)`,
        [OWNER_ID, locAId, brandId, locBId],
      );
      await seedProduct(pool, sharedBrandName);

      await maybeAutoActivateLocationsByBrand(OWNER_ID, sharedBrandName);

      expect(await getStatus(pool, locAId)).toBe("active");
      expect(await getStatus(pool, locBId)).toBe("active");
    });

    it("maybeAutoActivateLocationsByBrand is a no-op when brandName is null", async () => {
      // Just verify the function doesn't throw and returns without querying anything.
      await expect(
        maybeAutoActivateLocationsByBrand(OWNER_ID, null),
      ).resolves.toBeUndefined();
    });

    it("maybeAutoActivateLocationsByBrand does not activate a location that is missing a condition", async () => {
      const locationId = await insertLocation(pool);

      const brandName = `ByBrandIncomplete-${locationId}`;
      const br = await pool.query<{ id: number }>(
        `INSERT INTO brands (workspace_owner_id, name) VALUES ($1, $2) RETURNING id`,
        [OWNER_ID, brandName],
      );
      const brandId = br.rows[0].id;
      await pool.query(
        `INSERT INTO location_brands (workspace_owner_id, location_id, brand_id)
         VALUES ($1, $2, $3)`,
        [OWNER_ID, locationId, brandId],
      );
      await seedProduct(pool, brandName);
      // Deliberately omit device — has_devices will be false.

      await maybeAutoActivateLocationsByBrand(OWNER_ID, brandName);

      expect(await getStatus(pool, locationId)).toBe("setup_incomplete");
    });
  },
);
