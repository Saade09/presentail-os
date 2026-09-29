/**
 * Integration test: verifies the base item merge flow against a real Postgres
 * instance, exercising the database constraint paths that unit tests cannot
 * reach.
 *
 * Two regression scenarios are covered:
 *
 *  1. Overlapping product_recipes — master and duplicate both appear in the
 *     same product's recipe. The route must delete the duplicate row before
 *     re-pointing, otherwise the unique constraint on (product_id, base_item_id)
 *     raises an error. After the merge exactly one recipe row should remain
 *     (the master's).
 *
 *  2. Overlapping base_item_location_statuses — master and duplicate both have
 *     a status row for the same location. The route must delete the duplicate
 *     row before re-pointing. After the merge exactly one status row should
 *     remain for that location, pointing to the master.
 *
 * Auth and workspace middleware are stubbed so no real Clerk credentials are
 * needed. The database is real — tests seed their own rows under a unique
 * OWNER_ID and clean up in afterAll.
 *
 * The route's internal `db` singleton (a pg.Pool) is replaced with a real
 * Pool; the route uses pool.connect() to obtain a dedicated client for the
 * transaction, so all statements share the same connection regardless of
 * pool size.
 *
 * The suite skips automatically when DATABASE_URL is not set, making it safe
 * to run in environments without a live database.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;

// ─────────────────────────────────────────────────────────────────────────────
// Unique identifiers so tests never collide with real workspace data
// ─────────────────────────────────────────────────────────────────────────────

const OWNER_ID = "__integration_test_base_item_merge__";
const USER_ID = "__integration_test_bi_merge_user__";
const OTHER_OWNER_ID = "__integration_test_base_item_bulk_other__";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks — auth / workspace / logger / objectStorage / clerkClient / db.
//
// db is mocked with a real Pool; the merge route uses pool.connect() to
// obtain a dedicated client for the transaction, so all statements share the
// same connection regardless of pool size.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("../lib/db", async () => {
  const { default: pgLib } = await import("pg");
  const pool = new pgLib.Pool({
    connectionString: process.env.DATABASE_URL,
  });
  return { db: pool };
});

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
    const wreq = req as unknown as import("../lib/workspace").WorkspaceRequest;
    wreq.workspaceOwnerId = OWNER_ID;
    wreq.workspaceRole = "owner";
    wreq.workspaceActualRole = "owner";
    wreq.userId = USER_ID;
    wreq.userEmail = "merge-test@example.com";
    next();
  },
  workspace: (req: express.Request) => req as unknown as import("../lib/workspace").WorkspaceRequest,
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

vi.mock("@clerk/express", () => ({
  clerkClient: {
    users: {
      getUser: vi.fn(),
      getUserList: vi.fn().mockResolvedValue({ data: [] }),
    },
  },
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
}));

// ─────────────────────────────────────────────────────────────────────────────
// Import the router AFTER vi.mock declarations (hoisting boundary)
// ─────────────────────────────────────────────────────────────────────────────

import baseItemsRouter from "./baseItems";
import { db as routeDb } from "../lib/db";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (req as unknown as Record<string, any>).log = {
      error: () => undefined,
      warn: () => undefined,
      info: () => undefined,
    };
    next();
  });
  app.use(baseItemsRouter);
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err?.message ?? String(err) });
  });
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!DATABASE_URL)(
  "POST /base-items/merge — integration (real database)",
  () => {
    // Separate pool for seeding and verification (no max:1 restriction needed here)
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;

    // IDs created during seeding
    let masterId: number;
    let duplicateId: number;
    let productId: number;
    let locationId: number;
    let bulkItemOneId: number;
    let bulkItemTwoId: number;
    let crossWorkspaceItemId: number;
    let leafCategoryId: number;
    let parentCategoryId: number;
    let subcategoryId: number;
    let inactiveCategoryId: number;

    // ─────────────────────────────────────────────────────────────────────────
    // Setup / teardown
    // ─────────────────────────────────────────────────────────────────────────

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });
      app = makeApp();

      // Wipe any leftovers from a previous failed run
      await pool.query(`DELETE FROM base_item_audit_log WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM base_item_location_statuses WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM product_recipes WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM products WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM base_items WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM base_items WHERE workspace_owner_id = $1`, [OTHER_OWNER_ID]);
      await pool.query(`DELETE FROM base_item_categories WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM locations WHERE workspace_owner_id = $1`, [OWNER_ID]);

      // Seed permanent fixtures used by all tests
      const masterResult = await pool.query<{ id: number }>(
        `INSERT INTO base_items (workspace_owner_id, name, code, status)
         VALUES ($1, 'Merge Master', 'MRG-MASTER', 'active')
         RETURNING id`,
        [OWNER_ID],
      );
      masterId = masterResult.rows[0].id;

      const dupResult = await pool.query<{ id: number }>(
        `INSERT INTO base_items (workspace_owner_id, name, code, status)
         VALUES ($1, 'Merge Duplicate', 'MRG-DUP', 'active')
         RETURNING id`,
        [OWNER_ID],
      );
      duplicateId = dupResult.rows[0].id;

      const productResult = await pool.query<{ id: number }>(
        `INSERT INTO products (workspace_owner_id, name)
         VALUES ($1, 'Merge Test Product')
         RETURNING id`,
        [OWNER_ID],
      );
      productId = productResult.rows[0].id;

      const locationResult = await pool.query<{ id: number }>(
        `INSERT INTO locations (workspace_owner_id, name)
         VALUES ($1, 'Merge Test Location')
         RETURNING id`,
        [OWNER_ID],
      );
      locationId = locationResult.rows[0].id;

      const leafCategory = await pool.query<{ id: number }>(
        `INSERT INTO base_item_categories (workspace_owner_id, name, status)
         VALUES ($1, 'Bulk Leaf Category', 'active')
         RETURNING id`,
        [OWNER_ID],
      );
      leafCategoryId = leafCategory.rows[0].id;

      const parentCategory = await pool.query<{ id: number }>(
        `INSERT INTO base_item_categories (workspace_owner_id, name, status)
         VALUES ($1, 'Bulk Parent Category', 'active')
         RETURNING id`,
        [OWNER_ID],
      );
      parentCategoryId = parentCategory.rows[0].id;

      const subcategory = await pool.query<{ id: number }>(
        `INSERT INTO base_item_categories (workspace_owner_id, name, parent_id, status)
         VALUES ($1, 'Bulk Subcategory', $2, 'active')
         RETURNING id`,
        [OWNER_ID, parentCategoryId],
      );
      subcategoryId = subcategory.rows[0].id;

      const inactiveCategory = await pool.query<{ id: number }>(
        `INSERT INTO base_item_categories (workspace_owner_id, name, status)
         VALUES ($1, 'Bulk Inactive Category', 'archived')
         RETURNING id`,
        [OWNER_ID],
      );
      inactiveCategoryId = inactiveCategory.rows[0].id;

      const bulkItems = await pool.query<{ id: number }>(
        `INSERT INTO base_items (workspace_owner_id, name, code, status)
         VALUES
           ($1, 'Bulk Category Item One', 'BULK-CAT-1', 'active'),
           ($1, 'Bulk Category Item Two', 'BULK-CAT-2', 'active')
         RETURNING id`,
        [OWNER_ID],
      );
      [bulkItemOneId, bulkItemTwoId] = bulkItems.rows.map((row) => row.id);

      const crossWorkspaceItem = await pool.query<{ id: number }>(
        `INSERT INTO base_items (workspace_owner_id, name, code, status)
         VALUES ($1, 'Cross Workspace Bulk Item', 'BULK-CROSS-1', 'active')
         RETURNING id`,
        [OTHER_OWNER_ID],
      );
      crossWorkspaceItemId = crossWorkspaceItem.rows[0].id;
    });

    afterAll(async () => {
      if (!pool) return;
      await pool.query(`DELETE FROM base_item_audit_log WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM base_item_location_statuses WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM product_recipes WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM products WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM base_items WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM base_items WHERE workspace_owner_id = $1`, [OTHER_OWNER_ID]);
      await pool.query(`DELETE FROM base_item_categories WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM locations WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.end();
      // Also end the route's mocked db pool
      await (routeDb as unknown as import("pg").Pool).end();
    });

    // Helper: reset the duplicate back to 'active' between scenarios.
    async function resetDuplicate(): Promise<void> {
      await pool.query(
        `UPDATE base_items
            SET status = 'active',
                merged_into_base_item_id = NULL,
                merged_at = NULL,
                merged_by_user_id = NULL
          WHERE id = $1`,
        [duplicateId],
      );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Scenario 1: overlapping product_recipes
    //
    // Both master and duplicate appear in the same product's recipe. The merge
    // route must DELETE the duplicate row first so the subsequent UPDATE does
    // not violate the unique constraint on (product_id, base_item_id).
    // ─────────────────────────────────────────────────────────────────────────

    it(
      "merges with overlapping product_recipes: returns 200 and leaves exactly one recipe row",
      async () => {
        // Seed: both master and duplicate are in the same product's recipe.
        await pool.query(
          `INSERT INTO product_recipes
             (workspace_owner_id, product_id, base_item_id, quantity)
           VALUES
             ($1, $2, $3, 1),
             ($1, $2, $4, 1)`,
          [OWNER_ID, productId, masterId, duplicateId],
        );

        try {
          const res = await request(app)
            .post("/base-items/merge")
            .send({ ids: [masterId, duplicateId], master_id: masterId });

          expect(res.status).toBe(200);
          expect(res.body.ok).toBe(true);
          expect(res.body.master_id).toBe(masterId);
          expect(res.body.merged).toContain(duplicateId);

          // Exactly one recipe row must remain, pointing to the master.
          const recipeRows = await pool.query<{ base_item_id: number }>(
            `SELECT base_item_id FROM product_recipes
              WHERE workspace_owner_id = $1 AND product_id = $2`,
            [OWNER_ID, productId],
          );
          expect(recipeRows.rowCount).toBe(1);
          expect(recipeRows.rows[0].base_item_id).toBe(masterId);

          // The duplicate must be marked as merged.
          const dupRow = await pool.query<{
            status: string;
            merged_into_base_item_id: number;
          }>(
            `SELECT status, merged_into_base_item_id FROM base_items WHERE id = $1`,
            [duplicateId],
          );
          expect(dupRow.rows[0].status).toBe("merged");
          expect(dupRow.rows[0].merged_into_base_item_id).toBe(masterId);
        } finally {
          await pool.query(`DELETE FROM product_recipes WHERE workspace_owner_id = $1`, [OWNER_ID]);
          await pool.query(`DELETE FROM base_item_audit_log WHERE workspace_owner_id = $1`, [OWNER_ID]);
          await resetDuplicate();
        }
      },
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Scenario 2: overlapping base_item_location_statuses
    //
    // Both master and duplicate have a status row for the same location.
    // The route must DELETE the duplicate row first to avoid violating
    // the unique constraint on (base_item_id, location_id).
    // ─────────────────────────────────────────────────────────────────────────

    it(
      "merges with overlapping base_item_location_statuses: returns 200 and leaves exactly one status row",
      async () => {
        // Seed: both master and duplicate have a status row for the same location.
        await pool.query(
          `INSERT INTO base_item_location_statuses
             (workspace_owner_id, base_item_id, location_id, is_active)
           VALUES
             ($1, $2, $3, true),
             ($1, $4, $3, true)`,
          [OWNER_ID, masterId, locationId, duplicateId],
        );

        try {
          const res = await request(app)
            .post("/base-items/merge")
            .send({ ids: [masterId, duplicateId], master_id: masterId });

          expect(res.status).toBe(200);
          expect(res.body.ok).toBe(true);

          // Exactly one status row must remain for that location (the master's).
          const statusRows = await pool.query<{ base_item_id: number }>(
            `SELECT base_item_id FROM base_item_location_statuses
              WHERE location_id = $1 AND workspace_owner_id = $2`,
            [locationId, OWNER_ID],
          );
          expect(statusRows.rowCount).toBe(1);
          expect(statusRows.rows[0].base_item_id).toBe(masterId);
        } finally {
          await pool.query(`DELETE FROM base_item_location_statuses WHERE workspace_owner_id = $1`, [OWNER_ID]);
          await pool.query(`DELETE FROM base_item_audit_log WHERE workspace_owner_id = $1`, [OWNER_ID]);
          await resetDuplicate();
        }
      },
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Scenario 3: non-overlapping recipe rows are re-pointed to the master
    //
    // When the duplicate has a recipe row for a product that the master does
    // NOT have, that row must be updated to point to the master (not deleted).
    // ─────────────────────────────────────────────────────────────────────────

    it(
      "re-points non-overlapping recipe rows from duplicate to master",
      async () => {
        // A second product whose recipe includes only the duplicate.
        const prod2 = await pool.query<{ id: number }>(
          `INSERT INTO products (workspace_owner_id, name)
           VALUES ($1, 'Merge Test Product 2')
           RETURNING id`,
          [OWNER_ID],
        );
        const product2Id = prod2.rows[0].id;

        await pool.query(
          `INSERT INTO product_recipes
             (workspace_owner_id, product_id, base_item_id, quantity)
           VALUES ($1, $2, $3, 2)`,
          [OWNER_ID, product2Id, duplicateId],
        );

        try {
          const res = await request(app)
            .post("/base-items/merge")
            .send({ ids: [masterId, duplicateId], master_id: masterId });

          expect(res.status).toBe(200);
          expect(res.body.ok).toBe(true);

          // The recipe row that was for the duplicate must now point to the master.
          const recipeRows = await pool.query<{ base_item_id: number; quantity: string }>(
            `SELECT base_item_id, quantity FROM product_recipes
              WHERE workspace_owner_id = $1 AND product_id = $2`,
            [OWNER_ID, product2Id],
          );
          expect(recipeRows.rowCount).toBe(1);
          expect(recipeRows.rows[0].base_item_id).toBe(masterId);
          expect(parseFloat(recipeRows.rows[0].quantity)).toBe(2);
        } finally {
          await pool.query(`DELETE FROM product_recipes WHERE workspace_owner_id = $1`, [OWNER_ID]);
          await pool.query(`DELETE FROM base_item_audit_log WHERE workspace_owner_id = $1`, [OWNER_ID]);
          await pool.query(
            `DELETE FROM products WHERE workspace_owner_id = $1 AND id = $2`,
            [OWNER_ID, product2Id],
          );
          await resetDuplicate();
        }
      },
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Scenario 4: audit log table missing — merge must still succeed
    //
    // Rename base_item_audit_log away so the appendAuditLog INSERT fails with
    // "relation does not exist".  The route must catch that error silently and
    // still return 200 — the merge itself has committed by then.
    // ─────────────────────────────────────────────────────────────────────────

    it(
      "returns 200 even when the audit log table is missing (INSERT fails after COMMIT)",
      async () => {
        await pool.query(
          "ALTER TABLE base_item_audit_log RENAME TO base_item_audit_log_hidden",
        );

        try {
          const res = await request(app)
            .post("/base-items/merge")
            .send({ ids: [masterId, duplicateId], master_id: masterId });

          expect(res.status).toBe(200);
          expect(res.body.ok).toBe(true);
          expect(res.body.master_id).toBe(masterId);
          expect(res.body.merged).toContain(duplicateId);

          // The duplicate must be marked merged even though the audit log failed.
          const dupRow = await pool.query<{
            status: string;
            merged_into_base_item_id: number;
          }>(
            `SELECT status, merged_into_base_item_id FROM base_items WHERE id = $1`,
            [duplicateId],
          );
          expect(dupRow.rows[0].status).toBe("merged");
          expect(dupRow.rows[0].merged_into_base_item_id).toBe(masterId);
        } finally {
          // Restore the table regardless of test outcome.
          await pool.query(
            "ALTER TABLE base_item_audit_log_hidden RENAME TO base_item_audit_log",
          );
          await resetDuplicate();
        }
      },
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Scenario 5: concurrent merges on the same item set
    //
    // A second transaction holds a FOR UPDATE lock on both items and deactivates
    // the duplicate while the merge request is blocked waiting for the lock.
    // Once the holding transaction commits, the merge should find the duplicate
    // no longer active and return 409 — not silently succeed with a partial merge.
    // ─────────────────────────────────────────────────────────────────────────

    it(
      "returns 409 when a concurrent transaction deactivates a duplicate before the lock is acquired",
      async () => {
        // Grab a dedicated client to simulate a concurrent writer.
        const holdingClient = await pool.connect();
        try {
          // Begin a transaction and lock both rows with FOR UPDATE so the merge
          // route's own FOR UPDATE will block until we release the lock.
          await holdingClient.query("BEGIN");
          await holdingClient.query(
            `SELECT id FROM base_items WHERE id IN ($1, $2) FOR UPDATE`,
            [masterId, duplicateId],
          );

          // Eagerly start the merge request by immediately calling .then() so
          // the route handler begins executing before we await anything else.
          // (Supertest requests are lazy and do not start until the thenable is
          //  consumed — wrapping in a new Promise forces eager execution.)
          let mergeResolve!: (r: request.Response) => void;
          let mergeReject!: (e: unknown) => void;
          const mergePromise = new Promise<request.Response>((res, rej) => {
            mergeResolve = res;
            mergeReject = rej;
          });
          void request(app)
            .post("/base-items/merge")
            .send({ ids: [masterId, duplicateId], master_id: masterId })
            .then(mergeResolve, mergeReject);

          // Yield to the event loop so the route handler can advance through
          // the pre-transaction SELECT and reach the FOR UPDATE (where it
          // blocks waiting for our lock to release).
          await new Promise<void>((resolve) => setTimeout(resolve, 500));

          // While we hold the lock, deactivate the duplicate.
          await holdingClient.query(
            `UPDATE base_items SET status = 'merged' WHERE id = $1`,
            [duplicateId],
          );

          // Commit — this releases the lock and unblocks the merge request's
          // FOR UPDATE.  The merge will re-read the rows and find the duplicate
          // no longer active.
          await holdingClient.query("COMMIT");

          // The merge request should now observe the duplicate as inactive
          // inside its transaction and abort with 409.
          const res = await mergePromise;
          expect(res.status).toBe(409);
          expect(res.body.error).toMatch(/no longer active/i);

          // The master must be untouched (still active).
          const masterRow = await pool.query<{ status: string }>(
            `SELECT status FROM base_items WHERE id = $1`,
            [masterId],
          );
          expect(masterRow.rows[0].status).toBe("active");
        } finally {
          await holdingClient.release();
          await resetDuplicate();
        }
      },
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Scenario 6: lock_timeout fires — holding client never releases the lock
    //
    // A second transaction acquires FOR UPDATE on both base items and holds it
    // indefinitely.  The merge route sets lock_timeout = '5s', so after ~5 s
    // Postgres raises error code 55P03 (lock_not_available).  The route must
    // catch that code and return 409 with an "in progress" error, not a 500.
    // The master item must remain untouched (still active).
    // ─────────────────────────────────────────────────────────────────────────

    it(
      "returns 409 when the lock_timeout fires because a concurrent client holds FOR UPDATE indefinitely",
      { timeout: 20_000 },
      async () => {
        const holdingClient = await pool.connect();
        try {
          // Hold the FOR UPDATE lock without ever releasing it — the merge
          // route's lock_timeout will expire before we yield.
          await holdingClient.query("BEGIN");
          await holdingClient.query(
            `SELECT id FROM base_items WHERE id IN ($1, $2) FOR UPDATE`,
            [masterId, duplicateId],
          );

          // Fire the merge request eagerly (same pattern as Scenario 5).
          let mergeResolve!: (r: request.Response) => void;
          let mergeReject!: (e: unknown) => void;
          const mergePromise = new Promise<request.Response>((res, rej) => {
            mergeResolve = res;
            mergeReject = rej;
          });
          void request(app)
            .post("/base-items/merge")
            .send({ ids: [masterId, duplicateId], master_id: masterId })
            .timeout(15_000)
            .then(mergeResolve, mergeReject);

          // Wait for the route to respond.  The route sets lock_timeout = '5s',
          // so Postgres will raise 55P03 after ~5 s and the route will return
          // 409 — all while the holding client still owns the lock.
          const res = await mergePromise;
          expect(res.status).toBe(409);
          expect(res.body.error).toMatch(/in progress/i);

          // The master item must be untouched — the merge transaction was rolled
          // back before any mutation occurred.
          const masterRow = await pool.query<{ status: string }>(
            `SELECT status FROM base_items WHERE id = $1`,
            [masterId],
          );
          expect(masterRow.rows[0].status).toBe("active");
        } finally {
          // Release the holding lock so subsequent tests are not affected.
          await holdingClient.query("ROLLBACK").catch(() => undefined);
          holdingClient.release();
          await resetDuplicate();
        }
      },
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Guard-rail: validation errors
    // ─────────────────────────────────────────────────────────────────────────

    it("returns 400 when ids array has fewer than 2 entries", async () => {
      const res = await request(app)
        .post("/base-items/merge")
        .send({ ids: [masterId], master_id: masterId });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/at least 2/i);
    });

    it("returns 400 when master_id is not in the ids array", async () => {
      const res = await request(app)
        .post("/base-items/merge")
        .send({ ids: [masterId, duplicateId], master_id: 999999999 });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/master_id must be one of the selected ids/i);
    });

    it("returns 400 when one of the ids does not exist in the workspace", async () => {
      const res = await request(app)
        .post("/base-items/merge")
        .send({ ids: [masterId, 999999999], master_id: masterId });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/not found or not active/i);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Bulk category transaction regressions
    // ─────────────────────────────────────────────────────────────────────────

    it("atomically updates multiple Base Items to a valid active subcategory", async () => {
      await pool.query(
        `UPDATE base_items SET category_id = NULL WHERE id = ANY($1::int[])`,
        [[bulkItemOneId, bulkItemTwoId]],
      );

      const res = await request(app)
        .post("/base-items/bulk-update-category")
        .send({ ids: [bulkItemOneId, bulkItemTwoId], category_id: subcategoryId });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, updated: 2 });

      const rows = await pool.query<{ id: number; category_id: number | null }>(
        `SELECT id, category_id FROM base_items WHERE id = ANY($1::int[]) ORDER BY id`,
        [[bulkItemOneId, bulkItemTwoId]],
      );
      expect(rows.rows).toHaveLength(2);
      expect(rows.rows.every((row) => row.category_id === subcategoryId)).toBe(true);
    });

    it("clears one Base Item category and returns the exact updated count", async () => {
      await pool.query(
        `UPDATE base_items SET category_id = $1 WHERE id = $2`,
        [leafCategoryId, bulkItemOneId],
      );

      const res = await request(app)
        .post("/base-items/bulk-update-category")
        .send({ ids: [bulkItemOneId], category_id: null });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, updated: 1 });

      const row = await pool.query<{ category_id: number | null }>(
        `SELECT category_id FROM base_items WHERE id = $1`,
        [bulkItemOneId],
      );
      expect(row.rows[0].category_id).toBeNull();
    });

    it("rolls back without changing any Base Item when the selection includes a cross-workspace ID", async () => {
      await pool.query(
        `UPDATE base_items SET category_id = $1 WHERE id = $2`,
        [leafCategoryId, bulkItemOneId],
      );
      await pool.query(
        `UPDATE base_items SET category_id = NULL WHERE id = $1`,
        [crossWorkspaceItemId],
      );

      const res = await request(app)
        .post("/base-items/bulk-update-category")
        .send({ ids: [bulkItemOneId, crossWorkspaceItemId], category_id: subcategoryId });

      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/not found in this workspace/i);

      const local = await pool.query<{ category_id: number | null }>(
        `SELECT category_id FROM base_items WHERE id = $1`,
        [bulkItemOneId],
      );
      const foreign = await pool.query<{ category_id: number | null }>(
        `SELECT category_id FROM base_items WHERE id = $1`,
        [crossWorkspaceItemId],
      );
      expect(local.rows[0].category_id).toBe(leafCategoryId);
      expect(foreign.rows[0].category_id).toBeNull();
    });

    it("rejects inactive and hierarchy-ineligible categories without changing the item", async () => {
      await pool.query(
        `UPDATE base_items SET category_id = $1 WHERE id = $2`,
        [leafCategoryId, bulkItemOneId],
      );

      const inactiveRes = await request(app)
        .post("/base-items/bulk-update-category")
        .send({ ids: [bulkItemOneId], category_id: inactiveCategoryId });
      expect(inactiveRes.status).toBe(400);
      expect(inactiveRes.body.error).toMatch(/inactive/i);

      const parentRes = await request(app)
        .post("/base-items/bulk-update-category")
        .send({ ids: [bulkItemOneId], category_id: parentCategoryId });
      expect(parentRes.status).toBe(400);
      expect(parentRes.body.error).toMatch(/subcategory/i);

      const row = await pool.query<{ category_id: number | null }>(
        `SELECT category_id FROM base_items WHERE id = $1`,
        [bulkItemOneId],
      );
      expect(row.rows[0].category_id).toBe(leafCategoryId);
    });
  },
);
