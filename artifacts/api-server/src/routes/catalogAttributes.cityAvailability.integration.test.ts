/**
 * Integration tests for catalog-attribute City Availability against a REAL
 * database.  These guard the bug where the admin
 * `GET /:type/:id/city-availability` endpoint produced malformed SQL
 * (`ca."occasion_city_availability"."occasion_id"`) because the FK column was
 * interpolated as a table-qualified Drizzle PgColumn on the `ca` alias.  That
 * threw at runtime, 500'd the endpoint, and left the admin panel showing
 * "0 of 0 cities" for every workspace and every attribute type.
 *
 * The route's unit tests mock the Drizzle layer, so the real SQL was never
 * executed and the regression shipped silently.  This suite executes the real
 * query and therefore fails loudly if the malformed-join regression returns.
 *
 * Coverage:
 *   1. GET city-availability lists every workspace delivery city with the
 *      default-on enabled flag (enabled_count == total_cities) — parameterized
 *      across ALL FOUR attribute types (occasions, catalog_categories,
 *      catalog_brands, recipients), since the buggy code path is shared.
 *   2. Saving a city toggled OFF persists, and the public catalog endpoint
 *      then hides the attribute for that city while still showing it for an
 *      enabled city.
 *
 * Auth / workspace / webhook / object-storage are mocked; the database is real
 * and the suite is skipped automatically when DATABASE_URL is not set.
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

const OWNER_ID = "__test_catattr_city_avail__";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks — auth / workspace / logger / webhook / object-storage.
// db is NOT mocked; the real pool/drizzle connection is used throughout.
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
    wreq.workspaceOwnerId = OWNER_ID;
    wreq.workspaceRole = "owner";
    wreq.workspaceActualRole = "owner";
    wreq.userId = "__test_catattr_user__";
    wreq.userEmail = "catattr-test@example.com";
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

vi.mock("../lib/catalogWebhook", () => ({
  fireCatalogAttributeWebhook: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../lib/objectStorage", () => ({
  objectStorageService: {
    copyPrivateObjectToPublic: vi.fn().mockResolvedValue(null),
  },
  buildPublicObjectUrl: (p: string | null | undefined) =>
    p ? `https://os.presentail.com/api/storage/public-objects/${p}` : null,
}));

// Imports MUST come AFTER vi.mock declarations.
import catalogAttributesRouter from "./catalogAttributes";
import catalogAttributesPublicRouter from "./catalogAttributesPublic";

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (
      req as unknown as {
        log: {
          error: (...a: unknown[]) => void;
          warn: (...a: unknown[]) => void;
          info: (...a: unknown[]) => void;
        };
      }
    ).log = { error: () => {}, warn: () => {}, info: () => {} };
    next();
  });
  app.use(catalogAttributesRouter);
  app.use(catalogAttributesPublicRouter);
  return app;
}

// The four attribute types share an identical column structure and the same
// buggy GET code path. Each entry carries the route prefix, the main table,
// the city-availability table, and its FK column so we can seed + clean up.
const ATTRIBUTE_TYPES = [
  {
    route: "occasions",
    table: "occasions",
    cityTable: "occasion_city_availability",
    fkCol: "occasion_id",
    name: "Birthday CA Test",
    slug: "birthday-ca-test",
  },
  {
    route: "catalog_categories",
    table: "catalog_categories",
    cityTable: "catalog_category_city_availability",
    fkCol: "catalog_category_id",
    name: "Flowers CA Test",
    slug: "flowers-ca-test",
  },
  {
    route: "catalog_brands",
    table: "catalog_brands",
    cityTable: "catalog_brand_city_availability",
    fkCol: "catalog_brand_id",
    name: "Acme CA Test",
    slug: "acme-ca-test",
  },
  {
    route: "recipients",
    table: "recipients",
    cityTable: "recipient_city_availability",
    fkCol: "recipient_id",
    name: "Mother CA Test",
    slug: "mother-ca-test",
  },
] as const;

// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!DATABASE_URL)(
  "catalog-attribute City Availability (integration)",
  () => {
    let pool: InstanceType<typeof Pool>;
    let cityAId: number;
    let cityBId: number;
    // Per-type seeded attribute id, keyed by route.
    const attributeIds: Record<string, number> = {};

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });

      // Clean any leftovers from a previous failed run.
      for (const t of ATTRIBUTE_TYPES) {
        await pool.query(
          `DELETE FROM ${t.cityTable} WHERE ${t.fkCol} IN (SELECT id FROM ${t.table} WHERE workspace_owner_id = $1)`,
          [OWNER_ID],
        );
        await pool.query(`DELETE FROM ${t.table} WHERE workspace_owner_id = $1`, [OWNER_ID]);
      }
      await pool.query(`DELETE FROM delivery_cities WHERE workspace_owner_id = $1`, [OWNER_ID]);

      // Two active delivery cities for the workspace.
      const cityA = await pool.query<{ id: number }>(
        `INSERT INTO delivery_cities
           (workspace_owner_id, country_code, name, slug, sort_order, is_active,
            delivery_fee, free_delivery_enabled)
         VALUES ($1, 'LB', 'Beirut CA Test', 'beirut-ca-test', 0, true, 0, false)
         RETURNING id`,
        [OWNER_ID],
      );
      cityAId = cityA.rows[0]!.id;

      const cityB = await pool.query<{ id: number }>(
        `INSERT INTO delivery_cities
           (workspace_owner_id, country_code, name, slug, sort_order, is_active,
            delivery_fee, free_delivery_enabled)
         VALUES ($1, 'LB', 'Tripoli CA Test', 'tripoli-ca-test', 1, true, 0, false)
         RETURNING id`,
        [OWNER_ID],
      );
      cityBId = cityB.rows[0]!.id;

      // One active attribute per type.
      for (const t of ATTRIBUTE_TYPES) {
        const row = await pool.query<{ id: number }>(
          `INSERT INTO ${t.table}
             (workspace_owner_id, name, slug, sort_order, is_active)
           VALUES ($1, $2, $3, 0, true)
           RETURNING id`,
          [OWNER_ID, t.name, t.slug],
        );
        attributeIds[t.route] = row.rows[0]!.id;
      }
    });

    afterAll(async () => {
      for (const t of ATTRIBUTE_TYPES) {
        await pool.query(
          `DELETE FROM ${t.cityTable} WHERE ${t.fkCol} IN (SELECT id FROM ${t.table} WHERE workspace_owner_id = $1)`,
          [OWNER_ID],
        );
        await pool.query(`DELETE FROM ${t.table} WHERE workspace_owner_id = $1`, [OWNER_ID]);
      }
      await pool.query(`DELETE FROM delivery_cities WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.end();
    });

    it.each(ATTRIBUTE_TYPES)(
      "lists every delivery city with default-on enabled flags for $route (regression: malformed alias join)",
      async (t) => {
        const app = makeApp();
        const id = attributeIds[t.route]!;
        const res = await request(app).get(`/${t.route}/${id}/city-availability`);

        expect(res.status).toBe(200);
        expect(res.body.total_cities).toBe(2);
        // Default-on: no explicit rows yet, so both cities are enabled.
        expect(res.body.enabled_count).toBe(2);

        const cities: Array<{ city_id: number; is_enabled: boolean; city_name: string }> =
          res.body.cities;
        expect(cities).toHaveLength(2);
        const cityIds = cities.map((c) => c.city_id).sort((a, b) => a - b);
        expect(cityIds).toEqual([cityAId, cityBId].sort((a, b) => a - b));
        expect(cities.every((c) => c.is_enabled === true)).toBe(true);
      },
    );

    it("hides the attribute from the public catalog for a city that is toggled off", async () => {
      const app = makeApp();
      const occasionId = attributeIds["occasions"]!;

      // Disable city A, keep city B enabled, via the batch save endpoint.
      const saveRes = await request(app)
        .put(`/occasions/${occasionId}/city-availability`)
        .send([
          { city_id: cityAId, is_enabled: false },
          { city_id: cityBId, is_enabled: true },
        ]);
      expect(saveRes.status).toBe(200);

      // GET city-availability now reflects the toggle.
      const getRes = await request(app).get(`/occasions/${occasionId}/city-availability`);
      expect(getRes.status).toBe(200);
      expect(getRes.body.enabled_count).toBe(1);
      const cityA = getRes.body.cities.find(
        (c: { city_id: number }) => c.city_id === cityAId,
      );
      const cityB = getRes.body.cities.find(
        (c: { city_id: number }) => c.city_id === cityBId,
      );
      expect(cityA.is_enabled).toBe(false);
      expect(cityB.is_enabled).toBe(true);

      // Public catalog: disabled city A must NOT see the occasion.
      const publicA = await request(app).get(`/catalog-attributes/occasions?city_id=${cityAId}`);
      expect(publicA.status).toBe(200);
      expect(
        (publicA.body.occasions as Array<{ id: number }>).some((o) => o.id === occasionId),
      ).toBe(false);

      // Public catalog: enabled city B still sees the occasion.
      const publicB = await request(app).get(`/catalog-attributes/occasions?city_id=${cityBId}`);
      expect(publicB.status).toBe(200);
      expect(
        (publicB.body.occasions as Array<{ id: number }>).some((o) => o.id === occasionId),
      ).toBe(true);
    });
  },
);
