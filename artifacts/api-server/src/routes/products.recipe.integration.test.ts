/**
 * Integration test: verifies that recipe sort_order survives a full round-trip
 * through the PUT /products/:id/recipe HTTP route against a real database.
 *
 * Two regression scenarios are covered:
 *
 *  1. The sort_order column is accidentally dropped (or the migration reverted)
 *     → the PUT request fails with a DB error and the test surfaces it.
 *
 *  2. The ORDER BY clause in the SELECT changes (e.g. sort_order is removed or
 *     the direction flips)
 *     → the recipe returned in the PUT response comes back in the wrong order
 *     and the row-order assertion fails.
 *
 * Auth and workspace middleware are stubbed (same pattern as
 * transactions.rollback.integration.test.ts) so the test does not need real
 * Clerk credentials.  Everything else — including the database — is real.
 *
 * The test is skipped automatically when DATABASE_URL is not set, making it
 * safe to run in CI environments without a live database.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";
import type { WorkspaceRequest } from "../lib/workspace";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;

// ─────────────────────────────────────────────────────────────────────────────
// Mocks — auth / workspace / logger / object storage only.
// db is NOT mocked; the real pool is used throughout.
// ─────────────────────────────────────────────────────────────────────────────

const OWNER_ID = "__test_recipe_sort_order_round_trip__";

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
    wreq.userId = "__test_recipe_user__";
    wreq.userEmail = "recipe-test@example.com";
    next();
  },
  workspace: (req: express.Request) => req as unknown as WorkspaceRequest,
  hasPageAccess: () => true,
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

vi.mock("../lib/objectStorage", () => ({
  objectStorageClient: {
    uploadFile: vi.fn(),
    deleteFile: vi.fn(),
    getSignedUrl: vi.fn(),
  },
}));

// ─────────────────────────────────────────────────────────────────────────────
// Imports — MUST come after vi.mock declarations (hoisting boundary)
// ─────────────────────────────────────────────────────────────────────────────

import productsRouter from "./products";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(productsRouter);
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!DATABASE_URL)(
  "PUT /products/:id/recipe — sort_order round-trip (integration)",
  () => {
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;
    let productId: number;
    let baseItemIds: number[];

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });
      app = makeApp();

      // Remove any leftovers from previous failed runs.
      await pool.query(
        `DELETE FROM product_recipes WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM products WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM base_items WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );

      // Seed one product.
      const productResult = await pool.query<{ id: number }>(
        `INSERT INTO products (workspace_owner_id, name)
         VALUES ($1, $2)
         RETURNING id`,
        [OWNER_ID, "Recipe Sort Test Product"],
      );
      productId = productResult.rows[0].id;

      // Seed three base items.
      const baseItemResult = await pool.query<{ id: number }>(
        `INSERT INTO base_items (workspace_owner_id, name, code)
         VALUES
           ($1, 'Base Item Alpha', 'RST-ALPHA'),
           ($1, 'Base Item Beta',  'RST-BETA'),
           ($1, 'Base Item Gamma', 'RST-GAMMA')
         RETURNING id`,
        [OWNER_ID],
      );
      baseItemIds = baseItemResult.rows.map((r) => r.id);
    });

    afterAll(async () => {
      if (!pool) return;
      await pool.query(
        `DELETE FROM product_recipes WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM products WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.query(
        `DELETE FROM base_items WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.end();
    });

    it("PUT responds 200 and returns recipe items in the requested sort_order", async () => {
      // Deliberately supply items in reverse natural (insertion) order so that
      // sort_order is the only signal that can produce the expected read-back
      // order.  Gamma first (sort_order=0), Alpha second (1), Beta third (2).
      const items = [
        { base_item_id: baseItemIds[2], quantity: 3, sort_order: 0 }, // Gamma
        { base_item_id: baseItemIds[0], quantity: 1, sort_order: 1 }, // Alpha
        { base_item_id: baseItemIds[1], quantity: 2, sort_order: 2 }, // Beta
      ];

      const res = await request(app)
        .put(`/products/${productId}/recipe`)
        .send({ items });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("recipe");

      const recipe: Array<{ base_item_id: number; quantity: number }> = res.body.recipe;
      expect(recipe).toHaveLength(3);

      // Assert the response order matches the supplied sort_order values.
      expect(recipe[0].base_item_id).toBe(baseItemIds[2]); // Gamma — sort_order 0
      expect(recipe[1].base_item_id).toBe(baseItemIds[0]); // Alpha — sort_order 1
      expect(recipe[2].base_item_id).toBe(baseItemIds[1]); // Beta  — sort_order 2
    });

    it("quantities are preserved in the round-trip response", async () => {
      // The previous test seeded the recipe; re-read it via another PUT with
      // the same payload to confirm quantities survive unchanged.
      const items = [
        { base_item_id: baseItemIds[2], quantity: 3, sort_order: 0 },
        { base_item_id: baseItemIds[0], quantity: 1, sort_order: 1 },
        { base_item_id: baseItemIds[1], quantity: 2, sort_order: 2 },
      ];

      const res = await request(app)
        .put(`/products/${productId}/recipe`)
        .send({ items });

      expect(res.status).toBe(200);
      const recipe: Array<{ base_item_id: number; quantity: number }> = res.body.recipe;

      expect(parseFloat(String(recipe[0].quantity))).toBe(3); // Gamma
      expect(parseFloat(String(recipe[1].quantity))).toBe(1); // Alpha
      expect(parseFloat(String(recipe[2].quantity))).toBe(2); // Beta
    });

    it("re-saving with reversed sort_order changes the order in the response", async () => {
      // Simulate a user drag-reorder save: Beta first, Alpha second, Gamma third.
      const reversedItems = [
        { base_item_id: baseItemIds[1], quantity: 2, sort_order: 0 }, // Beta  first
        { base_item_id: baseItemIds[0], quantity: 1, sort_order: 1 }, // Alpha second
        { base_item_id: baseItemIds[2], quantity: 3, sort_order: 2 }, // Gamma third
      ];

      const res = await request(app)
        .put(`/products/${productId}/recipe`)
        .send({ items: reversedItems });

      expect(res.status).toBe(200);
      const recipe: Array<{ base_item_id: number }> = res.body.recipe;
      expect(recipe).toHaveLength(3);

      expect(recipe[0].base_item_id).toBe(baseItemIds[1]); // Beta  — sort_order 0
      expect(recipe[1].base_item_id).toBe(baseItemIds[0]); // Alpha — sort_order 1
      expect(recipe[2].base_item_id).toBe(baseItemIds[2]); // Gamma — sort_order 2
    });

    it("returns 404 when the product does not exist in the workspace", async () => {
      const res = await request(app)
        .put(`/products/999999999/recipe`)
        .send({ items: [] });

      expect(res.status).toBe(404);
    });

    it("returns 400 when a base_item_id does not belong to the workspace", async () => {
      const res = await request(app)
        .put(`/products/${productId}/recipe`)
        .send({
          items: [
            // ID 0 is unlikely to ever be a valid base_items row.
            { base_item_id: 0, quantity: 1, sort_order: 0 },
          ],
        });

      expect(res.status).toBe(400);
    });
  },
);
