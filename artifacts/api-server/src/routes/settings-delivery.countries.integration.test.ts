/**
 * Integration tests: confirm that active-cities counts are returned correctly
 * by GET /admin/settings/countries even when delivery_cities rows store
 * country_code in lowercase.
 *
 * The route uses UPPER(country_code) in its SQL GROUP-BY query, so lowercase
 * values must be normalised before matching against the workspace's available
 * country codes (which are always uppercased).  Both test suites would fail if
 * the UPPER() call were accidentally removed.
 *
 * Suites:
 *   1. Lebanon ('lb') — original coverage
 *   2. UAE ('ae')     — confirms the same normalisation works for a second country
 *   3. Saudi Arabia ('sa') — third-country confirmation
 *   4. Country removed from available list — orphaned cities are not counted
 *   5. Inactive city (is_active = false) — excluded from active count
 *   6. Mixed active + inactive cities — only the active city is counted
 *
 * ── Contributor convention ────────────────────────────────────────────────────
 * Every suite in this file controls its own isolated workspace (unique owner ID)
 * and inserts a deterministic, known number of rows before asserting.  Because
 * the inserted row count is always known ahead of time, assertions on
 * `active_cities_count` MUST use exact matchers (toBe(N)) rather than
 * inequality matchers (toBeGreaterThanOrEqual).  Exact assertions catch
 * double-counting regressions that inequality matchers would silently miss.
 *
 * When adding a new suite for a new country:
 *   1. Define a unique OWNER_ID constant (e.g. `const JO_OWNER_ID = "__test_jo_city_count__"`).
 *   2. Insert only the rows the test needs; clean up in afterAll.
 *   3. Assert the count with `toBe(N)` — never `toBeGreaterThanOrEqual`.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Auth and workspace middleware are mocked so the suite does not require real
 * Clerk credentials.  The database is real — tests are skipped automatically
 * when DATABASE_URL is not set.
 *
 * Run via:
 *   pnpm --filter @workspace/api-server run test:integration:local
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";
import type { WorkspaceRequest } from "../lib/workspace";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const LB_OWNER_ID = "__test_lb_city_count__";
const UAE_OWNER_ID = "__test_ae_city_count__";
const SA_OWNER_ID = "__test_sa_city_count__";
const REMOVED_COUNTRY_OWNER_ID = "__test_removed_country__";
const INACTIVE_CITY_OWNER_ID = "__test_inactive_city_count__";
const MIXED_CITY_OWNER_ID = "__test_mixed_city_count__";

// `activeOwnerId` is mutated by each suite's beforeAll so the single shared
// workspace mock injects the right owner for whichever suite is running.
// Initialised to the Lebanon owner (Suite 1 runs first).
let activeOwnerId: string = LB_OWNER_ID;

// ─────────────────────────────────────────────────────────────────────────────
// Mocks — auth / workspace / logger
// db is NOT mocked; the real pool is used throughout.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
  authed: (req: express.Request) => req,
}));

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    const wreq = req as unknown as WorkspaceRequest;
    wreq.workspaceOwnerId = activeOwnerId;
    wreq.workspaceRole = "owner";
    wreq.workspaceActualRole = "owner";
    wreq.userId = "__test_countries_user__";
    wreq.userEmail = "countries-test@example.com";
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

// Imports MUST come AFTER vi.mock declarations.
import { adminRouter } from "./settings-delivery";

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(adminRouter);
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite 1 — Lebanon ('lb' lowercase country_code)
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!DATABASE_URL)(
  "GET /admin/settings/countries — Lebanon city count with lowercase country_code (integration)",
  () => {
    let pool: InstanceType<typeof Pool>;
    let insertedCityId: number | null = null;

    beforeAll(async () => {
      activeOwnerId = LB_OWNER_ID;
      pool = new Pool({ connectionString: DATABASE_URL });

      // Remove any leftovers from a previous failed run.
      await pool.query(
        `DELETE FROM delivery_cities WHERE workspace_owner_id = $1`,
        [LB_OWNER_ID],
      );
      await pool.query(
        `DELETE FROM delivery_country_settings WHERE workspace_owner_id = $1`,
        [LB_OWNER_ID],
      );
      await pool.query(
        `DELETE FROM workspace_settings WHERE workspace_owner_id = $1`,
        [LB_OWNER_ID],
      );

      // Insert a workspace_settings row with Lebanon (only) as the available
      // country so the route's available-country list is deterministic.
      await pool.query(
        `INSERT INTO workspace_settings (workspace_owner_id, available_countries)
         VALUES ($1, $2)
         ON CONFLICT (workspace_owner_id) DO UPDATE SET available_countries = EXCLUDED.available_countries`,
        [LB_OWNER_ID, ["Lebanon"]],
      );

      // Insert a delivery_city for Lebanon using a deliberately lowercase
      // country_code ('lb').  The route must UPPER()-normalise this to 'LB'
      // for the city to be counted.
      const result = await pool.query<{ id: number }>(
        `INSERT INTO delivery_cities
           (workspace_owner_id, country_code, name, slug, sort_order, is_active,
            delivery_fee, free_delivery_enabled)
         VALUES ($1, 'lb', 'Beirut Test', 'beirut-test-lb-count', 0, true, 0, false)
         RETURNING id`,
        [LB_OWNER_ID],
      );
      insertedCityId = result.rows[0]?.id ?? null;
    });

    afterAll(async () => {
      if (insertedCityId !== null) {
        await pool.query(`DELETE FROM delivery_cities WHERE id = $1`, [insertedCityId]);
      }
      await pool.query(
        `DELETE FROM delivery_country_settings WHERE workspace_owner_id = $1`,
        [LB_OWNER_ID],
      );
      await pool.query(
        `DELETE FROM workspace_settings WHERE workspace_owner_id = $1`,
        [LB_OWNER_ID],
      );
      await pool.end();
    });

    it("returns active_cities_count of exactly 1 for Lebanon when the row uses a lowercase country_code", async () => {
      const app = makeApp();
      const res = await request(app).get("/admin/settings/countries");

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("countries");

      const countries: Array<{
        name: string;
        code: string;
        active_cities_count: number;
      }> = res.body.countries;

      const lebanon = countries.find((c) => c.name === "Lebanon");
      expect(lebanon).toBeDefined();
      expect(lebanon!.code).toBe("LB");
      expect(lebanon!.active_cities_count).toBe(1);
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Suite 2 — UAE ('ae' lowercase country_code)
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!DATABASE_URL)(
  "GET /admin/settings/countries — UAE city count with lowercase country_code (integration)",
  () => {
    let pool: InstanceType<typeof Pool>;
    let insertedCityId: number | null = null;

    beforeAll(async () => {
      activeOwnerId = UAE_OWNER_ID;
      pool = new Pool({ connectionString: DATABASE_URL });

      // Remove any leftovers from a previous failed run.
      await pool.query(
        `DELETE FROM delivery_cities WHERE workspace_owner_id = $1`,
        [UAE_OWNER_ID],
      );
      await pool.query(
        `DELETE FROM delivery_country_settings WHERE workspace_owner_id = $1`,
        [UAE_OWNER_ID],
      );
      await pool.query(
        `DELETE FROM workspace_settings WHERE workspace_owner_id = $1`,
        [UAE_OWNER_ID],
      );

      // Insert a workspace_settings row with UAE (only) as the available
      // country so the route's available-country list is deterministic.
      await pool.query(
        `INSERT INTO workspace_settings (workspace_owner_id, available_countries)
         VALUES ($1, $2)
         ON CONFLICT (workspace_owner_id) DO UPDATE SET available_countries = EXCLUDED.available_countries`,
        [UAE_OWNER_ID, ["United Arab Emirates"]],
      );

      // Insert a delivery_city for UAE using a deliberately lowercase
      // country_code ('ae').  The route must UPPER()-normalise this to 'AE'
      // for the city to be counted.
      const result = await pool.query<{ id: number }>(
        `INSERT INTO delivery_cities
           (workspace_owner_id, country_code, name, slug, sort_order, is_active,
            delivery_fee, free_delivery_enabled)
         VALUES ($1, 'ae', 'Dubai Test', 'dubai-test-ae-count', 0, true, 0, false)
         RETURNING id`,
        [UAE_OWNER_ID],
      );
      insertedCityId = result.rows[0]?.id ?? null;
    });

    afterAll(async () => {
      if (insertedCityId !== null) {
        await pool.query(`DELETE FROM delivery_cities WHERE id = $1`, [insertedCityId]);
      }
      await pool.query(
        `DELETE FROM delivery_country_settings WHERE workspace_owner_id = $1`,
        [UAE_OWNER_ID],
      );
      await pool.query(
        `DELETE FROM workspace_settings WHERE workspace_owner_id = $1`,
        [UAE_OWNER_ID],
      );
      await pool.end();
    });

    it("returns active_cities_count of exactly 1 for UAE when the row uses a lowercase country_code", async () => {
      const app = makeApp();
      const res = await request(app).get("/admin/settings/countries");

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("countries");

      const countries: Array<{
        name: string;
        code: string;
        active_cities_count: number;
      }> = res.body.countries;

      const uae = countries.find((c) => c.name === "United Arab Emirates");
      expect(uae).toBeDefined();
      expect(uae!.code).toBe("AE");
      expect(uae!.active_cities_count).toBe(1);
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Suite 3 — Saudi Arabia ('sa' lowercase country_code)
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!DATABASE_URL)(
  "GET /admin/settings/countries — Saudi Arabia city count with lowercase country_code (integration)",
  () => {
    let pool: InstanceType<typeof Pool>;
    let insertedCityId: number | null = null;

    beforeAll(async () => {
      activeOwnerId = SA_OWNER_ID;
      pool = new Pool({ connectionString: DATABASE_URL });

      // Remove any leftovers from a previous failed run.
      await pool.query(
        `DELETE FROM delivery_cities WHERE workspace_owner_id = $1`,
        [SA_OWNER_ID],
      );
      await pool.query(
        `DELETE FROM delivery_country_settings WHERE workspace_owner_id = $1`,
        [SA_OWNER_ID],
      );
      await pool.query(
        `DELETE FROM workspace_settings WHERE workspace_owner_id = $1`,
        [SA_OWNER_ID],
      );

      // Insert a workspace_settings row with Saudi Arabia (only) as the
      // available country so the route's available-country list is deterministic.
      await pool.query(
        `INSERT INTO workspace_settings (workspace_owner_id, available_countries)
         VALUES ($1, $2)
         ON CONFLICT (workspace_owner_id) DO UPDATE SET available_countries = EXCLUDED.available_countries`,
        [SA_OWNER_ID, ["Saudi Arabia"]],
      );

      // Insert a delivery_city for Saudi Arabia using a deliberately lowercase
      // country_code ('sa').  The route must UPPER()-normalise this to 'SA'
      // for the city to be counted.
      const result = await pool.query<{ id: number }>(
        `INSERT INTO delivery_cities
           (workspace_owner_id, country_code, name, slug, sort_order, is_active,
            delivery_fee, free_delivery_enabled)
         VALUES ($1, 'sa', 'Riyadh Test', 'riyadh-test-sa-count', 0, true, 0, false)
         RETURNING id`,
        [SA_OWNER_ID],
      );
      insertedCityId = result.rows[0]?.id ?? null;
    });

    afterAll(async () => {
      if (insertedCityId !== null) {
        await pool.query(`DELETE FROM delivery_cities WHERE id = $1`, [insertedCityId]);
      }
      await pool.query(
        `DELETE FROM delivery_country_settings WHERE workspace_owner_id = $1`,
        [SA_OWNER_ID],
      );
      await pool.query(
        `DELETE FROM workspace_settings WHERE workspace_owner_id = $1`,
        [SA_OWNER_ID],
      );
      await pool.end();
    });

    it("returns active_cities_count of exactly 1 for Saudi Arabia when the row uses a lowercase country_code", async () => {
      const app = makeApp();
      const res = await request(app).get("/admin/settings/countries");

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("countries");

      const countries: Array<{
        name: string;
        code: string;
        active_cities_count: number;
      }> = res.body.countries;

      const saudiArabia = countries.find((c) => c.name === "Saudi Arabia");
      expect(saudiArabia).toBeDefined();
      expect(saudiArabia!.code).toBe("SA");
      expect(saudiArabia!.active_cities_count).toBe(1);
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Suite 4 — Country removed from available list
//
// A delivery_city exists for UAE, but the workspace's available_countries only
// lists Lebanon.  The route must NOT surface UAE in the response (or, if it
// does appear, must report active_cities_count of 0), because a removed country
// should have no influence on the returned payload.
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!DATABASE_URL)(
  "GET /admin/settings/countries — city for a removed country is not counted (integration)",
  () => {
    let pool: InstanceType<typeof Pool>;
    let insertedCityId: number | null = null;

    beforeAll(async () => {
      activeOwnerId = REMOVED_COUNTRY_OWNER_ID;
      pool = new Pool({ connectionString: DATABASE_URL });

      // Remove any leftovers from a previous failed run.
      await pool.query(
        `DELETE FROM delivery_cities WHERE workspace_owner_id = $1`,
        [REMOVED_COUNTRY_OWNER_ID],
      );
      await pool.query(
        `DELETE FROM delivery_country_settings WHERE workspace_owner_id = $1`,
        [REMOVED_COUNTRY_OWNER_ID],
      );
      await pool.query(
        `DELETE FROM workspace_settings WHERE workspace_owner_id = $1`,
        [REMOVED_COUNTRY_OWNER_ID],
      );

      // Only Lebanon is listed as available — UAE has been "removed".
      await pool.query(
        `INSERT INTO workspace_settings (workspace_owner_id, available_countries)
         VALUES ($1, $2)
         ON CONFLICT (workspace_owner_id) DO UPDATE SET available_countries = EXCLUDED.available_countries`,
        [REMOVED_COUNTRY_OWNER_ID, ["Lebanon"]],
      );

      // Insert an active delivery_city for UAE even though UAE is not in the
      // workspace's available_countries list.  The route must not count it.
      const result = await pool.query<{ id: number }>(
        `INSERT INTO delivery_cities
           (workspace_owner_id, country_code, name, slug, sort_order, is_active,
            delivery_fee, free_delivery_enabled)
         VALUES ($1, 'AE', 'Dubai Orphan', 'dubai-orphan-removed-test', 0, true, 0, false)
         RETURNING id`,
        [REMOVED_COUNTRY_OWNER_ID],
      );
      insertedCityId = result.rows[0]?.id ?? null;
    });

    afterAll(async () => {
      if (insertedCityId !== null) {
        await pool.query(`DELETE FROM delivery_cities WHERE id = $1`, [insertedCityId]);
      }
      await pool.query(
        `DELETE FROM delivery_country_settings WHERE workspace_owner_id = $1`,
        [REMOVED_COUNTRY_OWNER_ID],
      );
      await pool.query(
        `DELETE FROM workspace_settings WHERE workspace_owner_id = $1`,
        [REMOVED_COUNTRY_OWNER_ID],
      );
      await pool.end();
    });

    it("does not include the removed country or reports active_cities_count 0 for it", async () => {
      const app = makeApp();
      const res = await request(app).get("/admin/settings/countries");

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("countries");

      const countries: Array<{
        name: string;
        code: string;
        active_cities_count: number;
      }> = res.body.countries;

      // UAE was removed from available_countries, so it must either be absent
      // from the response or, if present, show zero active cities.
      const uae = countries.find((c) => c.code === "AE");
      if (uae !== undefined) {
        expect(uae.active_cities_count).toBe(0);
      } else {
        expect(uae).toBeUndefined();
      }
    });

    it("still returns Lebanon with the correct data when UAE is removed", async () => {
      const app = makeApp();
      const res = await request(app).get("/admin/settings/countries");

      expect(res.status).toBe(200);

      const countries: Array<{
        name: string;
        code: string;
        active_cities_count: number;
      }> = res.body.countries;

      // Lebanon is the only available country, so it must appear in the list.
      const lebanon = countries.find((c) => c.code === "LB");
      expect(lebanon).toBeDefined();
      expect(lebanon!.name).toBe("Lebanon");
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Suite 5 — Inactive city is not counted (is_active = false)
//
// A delivery_city exists for Jordan but has is_active = false.  The route
// filters by is_active = true in its COUNT query, so the inactive city must
// contribute 0 to active_cities_count even though the country is in the
// available list.
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!DATABASE_URL)(
  "GET /admin/settings/countries — inactive city (is_active = false) is not counted (integration)",
  () => {
    let pool: InstanceType<typeof Pool>;
    let insertedCityId: number | null = null;

    beforeAll(async () => {
      activeOwnerId = INACTIVE_CITY_OWNER_ID;
      pool = new Pool({ connectionString: DATABASE_URL });

      // Remove any leftovers from a previous failed run.
      await pool.query(
        `DELETE FROM delivery_cities WHERE workspace_owner_id = $1`,
        [INACTIVE_CITY_OWNER_ID],
      );
      await pool.query(
        `DELETE FROM delivery_country_settings WHERE workspace_owner_id = $1`,
        [INACTIVE_CITY_OWNER_ID],
      );
      await pool.query(
        `DELETE FROM workspace_settings WHERE workspace_owner_id = $1`,
        [INACTIVE_CITY_OWNER_ID],
      );

      // Jordan is the only available country so the response is deterministic.
      await pool.query(
        `INSERT INTO workspace_settings (workspace_owner_id, available_countries)
         VALUES ($1, $2)
         ON CONFLICT (workspace_owner_id) DO UPDATE SET available_countries = EXCLUDED.available_countries`,
        [INACTIVE_CITY_OWNER_ID, ["Jordan"]],
      );

      // Insert a delivery_city for Jordan with is_active = false.
      // The route must NOT count this city in active_cities_count.
      const result = await pool.query<{ id: number }>(
        `INSERT INTO delivery_cities
           (workspace_owner_id, country_code, name, slug, sort_order, is_active,
            delivery_fee, free_delivery_enabled)
         VALUES ($1, 'JO', 'Amman Inactive', 'amman-inactive-test', 0, false, 0, false)
         RETURNING id`,
        [INACTIVE_CITY_OWNER_ID],
      );
      insertedCityId = result.rows[0]?.id ?? null;
    });

    afterAll(async () => {
      if (insertedCityId !== null) {
        await pool.query(`DELETE FROM delivery_cities WHERE id = $1`, [insertedCityId]);
      }
      await pool.query(
        `DELETE FROM delivery_country_settings WHERE workspace_owner_id = $1`,
        [INACTIVE_CITY_OWNER_ID],
      );
      await pool.query(
        `DELETE FROM workspace_settings WHERE workspace_owner_id = $1`,
        [INACTIVE_CITY_OWNER_ID],
      );
      await pool.end();
    });

    it("reports active_cities_count of 0 for a country whose only city has is_active = false", async () => {
      const app = makeApp();
      const res = await request(app).get("/admin/settings/countries");

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("countries");

      const countries: Array<{
        name: string;
        code: string;
        active_cities_count: number;
      }> = res.body.countries;

      // Jordan must appear in the list because it is in available_countries.
      const jordan = countries.find((c) => c.code === "JO");
      expect(jordan).toBeDefined();
      expect(jordan!.name).toBe("Jordan");

      // The single city is inactive, so the count must be exactly 0.
      expect(jordan!.active_cities_count).toBe(0);
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Suite 6 — Mixed active and inactive cities
//
// A country (Kuwait) has two delivery_cities: one with is_active = true and
// one with is_active = false.  Only the active city must be reflected in
// active_cities_count — the count must be exactly 1.
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!DATABASE_URL)(
  "GET /admin/settings/countries — mixed active and inactive cities counted accurately (integration)",
  () => {
    let pool: InstanceType<typeof Pool>;
    let insertedActiveCityId: number | null = null;
    let insertedInactiveCityId: number | null = null;

    beforeAll(async () => {
      activeOwnerId = MIXED_CITY_OWNER_ID;
      pool = new Pool({ connectionString: DATABASE_URL });

      // Remove any leftovers from a previous failed run.
      await pool.query(
        `DELETE FROM delivery_cities WHERE workspace_owner_id = $1`,
        [MIXED_CITY_OWNER_ID],
      );
      await pool.query(
        `DELETE FROM delivery_country_settings WHERE workspace_owner_id = $1`,
        [MIXED_CITY_OWNER_ID],
      );
      await pool.query(
        `DELETE FROM workspace_settings WHERE workspace_owner_id = $1`,
        [MIXED_CITY_OWNER_ID],
      );

      // Kuwait is the only available country so the response is deterministic.
      await pool.query(
        `INSERT INTO workspace_settings (workspace_owner_id, available_countries)
         VALUES ($1, $2)
         ON CONFLICT (workspace_owner_id) DO UPDATE SET available_countries = EXCLUDED.available_countries`,
        [MIXED_CITY_OWNER_ID, ["Kuwait"]],
      );

      // Insert one active city for Kuwait.
      const activeResult = await pool.query<{ id: number }>(
        `INSERT INTO delivery_cities
           (workspace_owner_id, country_code, name, slug, sort_order, is_active,
            delivery_fee, free_delivery_enabled)
         VALUES ($1, 'KW', 'Kuwait City Active', 'kuwait-city-active-mixed-test', 0, true, 0, false)
         RETURNING id`,
        [MIXED_CITY_OWNER_ID],
      );
      insertedActiveCityId = activeResult.rows[0]?.id ?? null;

      // Insert one inactive city for the same country.
      const inactiveResult = await pool.query<{ id: number }>(
        `INSERT INTO delivery_cities
           (workspace_owner_id, country_code, name, slug, sort_order, is_active,
            delivery_fee, free_delivery_enabled)
         VALUES ($1, 'KW', 'Hawalli Inactive', 'hawalli-inactive-mixed-test', 1, false, 0, false)
         RETURNING id`,
        [MIXED_CITY_OWNER_ID],
      );
      insertedInactiveCityId = inactiveResult.rows[0]?.id ?? null;
    });

    afterAll(async () => {
      if (insertedActiveCityId !== null) {
        await pool.query(`DELETE FROM delivery_cities WHERE id = $1`, [insertedActiveCityId]);
      }
      if (insertedInactiveCityId !== null) {
        await pool.query(`DELETE FROM delivery_cities WHERE id = $1`, [insertedInactiveCityId]);
      }
      await pool.query(
        `DELETE FROM delivery_country_settings WHERE workspace_owner_id = $1`,
        [MIXED_CITY_OWNER_ID],
      );
      await pool.query(
        `DELETE FROM workspace_settings WHERE workspace_owner_id = $1`,
        [MIXED_CITY_OWNER_ID],
      );
      await pool.end();
    });

    it("reports active_cities_count of exactly 1 when one city is active and one is inactive", async () => {
      const app = makeApp();
      const res = await request(app).get("/admin/settings/countries");

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("countries");

      const countries: Array<{
        name: string;
        code: string;
        active_cities_count: number;
      }> = res.body.countries;

      // Kuwait must appear because it is in available_countries.
      const kuwait = countries.find((c) => c.code === "KW");
      expect(kuwait).toBeDefined();
      expect(kuwait!.name).toBe("Kuwait");

      // Only the active city must be counted — the inactive one must be excluded.
      expect(kuwait!.active_cities_count).toBe(1);
    });
  },
);
