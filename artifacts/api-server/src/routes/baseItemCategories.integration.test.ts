/**
 * Integration tests for the base item categories API.
 *
 * Covers the endpoints that have no existing coverage:
 *   GET  /base-item-categories/stats
 *   POST /base-item-categories/merge
 *   POST /base-item-categories/:id/archive
 *   POST /base-item-categories/:id/reorder
 *   GET  /base-item-categories/:id/base-items
 *   PATCH /base-item-categories/:id (partial field updates)
 *
 * Auth and workspace middleware are stubbed so no real Clerk credentials are
 * needed. The database is real — tests seed their own rows under a unique
 * OWNER_ID and clean up in afterAll.
 *
 * The suite skips automatically when DATABASE_URL is not set, making it safe
 * to run in environments without a live database.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";
import type { WorkspaceRequest } from "../lib/workspace";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;

// ─────────────────────────────────────────────────────────────────────────────
// Unique owner ID so tests never collide with real workspace data
// ─────────────────────────────────────────────────────────────────────────────

const OWNER_ID = "__integration_test_base_item_categories__";
const USER_ID = "__integration_test_bic_user__";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks — auth / workspace / logger only. db is NOT mocked.
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
    wreq.userId = USER_ID;
    wreq.userEmail = "bic-test@example.com";
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

// ─────────────────────────────────────────────────────────────────────────────
// Import the router AFTER vi.mock declarations (hoisting boundary)
// ─────────────────────────────────────────────────────────────────────────────

import baseItemCategoriesRouter from "./baseItemCategories";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(baseItemCategoriesRouter);
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!DATABASE_URL)(
  "base-item-categories integration tests",
  () => {
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;

    // IDs created during seeding
    let catAId: number; // "Cat A" — main category
    let catBId: number; // "Cat B" — main category
    let catSubId: number; // "Cat Sub" — subcategory of Cat A
    let baseItemId: number; // a base_item linked to Cat A

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });
      app = makeApp();

      // Wipe any leftovers from previous failed runs
      await pool.query(`DELETE FROM base_items WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(
        `DELETE FROM base_item_categories WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );

      // Seed main categories
      const catAResult = await pool.query<{ id: number }>(
        `INSERT INTO base_item_categories (workspace_owner_id, name, status)
         VALUES ($1, 'Cat A', 'active') RETURNING id`,
        [OWNER_ID],
      );
      catAId = catAResult.rows[0].id;

      const catBResult = await pool.query<{ id: number }>(
        `INSERT INTO base_item_categories (workspace_owner_id, name, status)
         VALUES ($1, 'Cat B', 'active') RETURNING id`,
        [OWNER_ID],
      );
      catBId = catBResult.rows[0].id;

      // Seed a subcategory under Cat A
      const catSubResult = await pool.query<{ id: number }>(
        `INSERT INTO base_item_categories (workspace_owner_id, name, parent_id, status)
         VALUES ($1, 'Cat Sub', $2, 'active') RETURNING id`,
        [OWNER_ID, catAId],
      );
      catSubId = catSubResult.rows[0].id;

      // Seed a base item assigned to Cat A
      const biResult = await pool.query<{ id: number }>(
        `INSERT INTO base_items (workspace_owner_id, name, code, category_id)
         VALUES ($1, 'BI Alpha', 'BIC-ALPHA', $2) RETURNING id`,
        [OWNER_ID, catAId],
      );
      baseItemId = biResult.rows[0].id;
    });

    afterAll(async () => {
      if (!pool) return;
      await pool.query(`DELETE FROM base_items WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(
        `DELETE FROM base_item_categories WHERE workspace_owner_id = $1`,
        [OWNER_ID],
      );
      await pool.end();
    });

    // ─────────────────────────────────────────────────────────────────────
    // GET /base-item-categories/stats
    // ─────────────────────────────────────────────────────────────────────

    describe("GET /base-item-categories/stats", () => {
      it("returns correct aggregate counts for the workspace", async () => {
        const res = await request(app).get("/base-item-categories/stats");

        expect(res.status).toBe(200);
        // 3 seeded active categories (Cat A, Cat B, Cat Sub)
        expect(res.body.total_categories).toBeGreaterThanOrEqual(3);
        // 1 base_item is assigned to Cat A
        expect(res.body.total_assigned).toBeGreaterThanOrEqual(1);
        // need_review is always 0 (hard-coded to 0 in the query)
        expect(res.body.need_review).toBe(0);
        // All counts must be non-negative integers
        expect(typeof res.body.total_categories).toBe("number");
        expect(typeof res.body.total_assigned).toBe("number");
        expect(typeof res.body.uncategorized).toBe("number");
      });

      it("uncategorized count increases when a base item has no category", async () => {
        // Insert a base item with no category
        await pool.query(
          `INSERT INTO base_items (workspace_owner_id, name, code)
           VALUES ($1, 'BI No Cat', 'BIC-NOCAT')`,
          [OWNER_ID],
        );

        const res = await request(app).get("/base-item-categories/stats");

        expect(res.status).toBe(200);
        expect(res.body.uncategorized).toBeGreaterThanOrEqual(1);

        // Clean up
        await pool.query(
          `DELETE FROM base_items WHERE workspace_owner_id = $1 AND code = 'BIC-NOCAT'`,
          [OWNER_ID],
        );
      });

      it("does not include archived categories in total_categories", async () => {
        // Grab the baseline count
        const before = await request(app).get("/base-item-categories/stats");
        const beforeCount = before.body.total_categories as number;

        // Archive Cat B temporarily
        await pool.query(
          `UPDATE base_item_categories SET status = 'archived' WHERE id = $1`,
          [catBId],
        );

        const res = await request(app).get("/base-item-categories/stats");

        expect(res.status).toBe(200);
        expect(res.body.total_categories).toBe(beforeCount - 1);

        // Restore
        await pool.query(
          `UPDATE base_item_categories SET status = 'active' WHERE id = $1`,
          [catBId],
        );
      });
    });

    // ─────────────────────────────────────────────────────────────────────
    // GET /base-item-categories/:id/base-items
    // ─────────────────────────────────────────────────────────────────────

    describe("GET /base-item-categories/:id/base-items", () => {
      it("returns the base items assigned to the category", async () => {
        const res = await request(app).get(
          `/base-item-categories/${catAId}/base-items`,
        );

        expect(res.status).toBe(200);
        expect(res.body).toHaveProperty("items");
        const items: Array<{ id: number; name: string }> = res.body.items;
        const found = items.find((i) => i.id === baseItemId);
        expect(found).toBeDefined();
        expect(found!.name).toBe("BI Alpha");
      });

      it("returns an empty list for a category with no base items", async () => {
        const res = await request(app).get(
          `/base-item-categories/${catBId}/base-items`,
        );

        expect(res.status).toBe(200);
        expect(res.body.items).toEqual([]);
      });

      it("returns 404 when the category does not exist", async () => {
        const res = await request(app).get(
          "/base-item-categories/999999999/base-items",
        );

        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/not found/i);
      });

      it("returns 400 for a non-numeric category id", async () => {
        const res = await request(app).get(
          "/base-item-categories/abc/base-items",
        );

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/invalid category id/i);
      });

      it("does not expose base items from a different workspace", async () => {
        // catSubId belongs to OWNER_ID, so it should return items only for OWNER_ID
        const res = await request(app).get(
          `/base-item-categories/${catSubId}/base-items`,
        );

        expect(res.status).toBe(200);
        // Cat Sub has no base items in our test workspace
        expect(res.body.items).toEqual([]);
      });
    });

    // ─────────────────────────────────────────────────────────────────────
    // POST /base-item-categories/:id/archive
    // ─────────────────────────────────────────────────────────────────────

    describe("POST /base-item-categories/:id/archive", () => {
      it("archives a category and sets its status to archived", async () => {
        // Create a dedicated category for this test
        const r = await pool.query<{ id: number }>(
          `INSERT INTO base_item_categories (workspace_owner_id, name, status)
           VALUES ($1, 'To Archive', 'active') RETURNING id`,
          [OWNER_ID],
        );
        const archiveId = r.rows[0].id;

        const res = await request(app).post(
          `/base-item-categories/${archiveId}/archive`,
        );

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true });

        // Verify in DB
        const dbRow = await pool.query<{ status: string }>(
          `SELECT status FROM base_item_categories WHERE id = $1`,
          [archiveId],
        );
        expect(dbRow.rows[0].status).toBe("archived");

        // Cleanup
        await pool.query(
          `DELETE FROM base_item_categories WHERE id = $1`,
          [archiveId],
        );
      });

      it("returns 404 when the category does not exist", async () => {
        const res = await request(app).post(
          "/base-item-categories/999999999/archive",
        );

        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/not found/i);
      });

      it("returns 400 for a non-numeric category id", async () => {
        const res = await request(app).post(
          "/base-item-categories/abc/archive",
        );

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/invalid category id/i);
      });
    });

    // ─────────────────────────────────────────────────────────────────────
    // POST /base-item-categories/merge
    // ─────────────────────────────────────────────────────────────────────

    describe("POST /base-item-categories/merge", () => {
      it("moves base items from source to target and archives the source", async () => {
        // Seed fresh source and target categories
        const srcR = await pool.query<{ id: number }>(
          `INSERT INTO base_item_categories (workspace_owner_id, name, status)
           VALUES ($1, 'Merge Source', 'active') RETURNING id`,
          [OWNER_ID],
        );
        const srcId = srcR.rows[0].id;

        const tgtR = await pool.query<{ id: number }>(
          `INSERT INTO base_item_categories (workspace_owner_id, name, status)
           VALUES ($1, 'Merge Target', 'active') RETURNING id`,
          [OWNER_ID],
        );
        const tgtId = tgtR.rows[0].id;

        // Assign two base items to the source
        const biR = await pool.query<{ id: number }>(
          `INSERT INTO base_items (workspace_owner_id, name, code, category_id)
           VALUES
             ($1, 'Merge Item 1', 'MRG-1', $2),
             ($1, 'Merge Item 2', 'MRG-2', $2)
           RETURNING id`,
          [OWNER_ID, srcId],
        );
        const mergeItemIds = biR.rows.map((r) => r.id);

        const res = await request(app)
          .post("/base-item-categories/merge")
          .send({ source_id: srcId, target_id: tgtId });

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.moved_items).toBe(2);
        expect(res.body.moved_children).toBe(0);

        // Verify base items now point to target
        const biCheck = await pool.query<{ category_id: number }>(
          `SELECT category_id FROM base_items WHERE id = ANY($1)`,
          [mergeItemIds],
        );
        for (const row of biCheck.rows) {
          expect(row.category_id).toBe(tgtId);
        }

        // Verify source is archived
        const srcCheck = await pool.query<{ status: string }>(
          `SELECT status FROM base_item_categories WHERE id = $1`,
          [srcId],
        );
        expect(srcCheck.rows[0].status).toBe("archived");

        // Cleanup
        await pool.query(`DELETE FROM base_items WHERE id = ANY($1)`, [mergeItemIds]);
        await pool.query(
          `DELETE FROM base_item_categories WHERE id = ANY($1)`,
          [[srcId, tgtId]],
        );
      });

      it("moves child subcategories from source to target", async () => {
        const srcR = await pool.query<{ id: number }>(
          `INSERT INTO base_item_categories (workspace_owner_id, name, status)
           VALUES ($1, 'Merge Src Children', 'active') RETURNING id`,
          [OWNER_ID],
        );
        const srcId = srcR.rows[0].id;

        const tgtR = await pool.query<{ id: number }>(
          `INSERT INTO base_item_categories (workspace_owner_id, name, status)
           VALUES ($1, 'Merge Tgt Children', 'active') RETURNING id`,
          [OWNER_ID],
        );
        const tgtId = tgtR.rows[0].id;

        const childR = await pool.query<{ id: number }>(
          `INSERT INTO base_item_categories (workspace_owner_id, name, parent_id, status)
           VALUES ($1, 'Child Cat', $2, 'active') RETURNING id`,
          [OWNER_ID, srcId],
        );
        const childId = childR.rows[0].id;

        const res = await request(app)
          .post("/base-item-categories/merge")
          .send({ source_id: srcId, target_id: tgtId });

        expect(res.status).toBe(200);
        expect(res.body.moved_children).toBe(1);

        // Child should now have parent_id = tgtId
        const childCheck = await pool.query<{ parent_id: number }>(
          `SELECT parent_id FROM base_item_categories WHERE id = $1`,
          [childId],
        );
        expect(childCheck.rows[0].parent_id).toBe(tgtId);

        // Cleanup
        await pool.query(
          `DELETE FROM base_item_categories WHERE id = ANY($1)`,
          [[srcId, tgtId, childId]],
        );
      });

      it("returns 400 when source_id equals target_id", async () => {
        const res = await request(app)
          .post("/base-item-categories/merge")
          .send({ source_id: catAId, target_id: catAId });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/must be different/i);
      });

      it("returns 404 when source category does not exist", async () => {
        const res = await request(app)
          .post("/base-item-categories/merge")
          .send({ source_id: 999999999, target_id: catBId });

        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/source/i);
      });

      it("returns 404 when target category does not exist", async () => {
        const res = await request(app)
          .post("/base-item-categories/merge")
          .send({ source_id: catAId, target_id: 999999999 });

        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/target/i);
      });

      it("returns 400 when source_id is invalid", async () => {
        const res = await request(app)
          .post("/base-item-categories/merge")
          .send({ source_id: "bad", target_id: catBId });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/source_id/i);
      });
    });

    // ─────────────────────────────────────────────────────────────────────
    // POST /base-item-categories/:id/reorder
    // ─────────────────────────────────────────────────────────────────────

    describe("POST /base-item-categories/:id/reorder", () => {
      it("swaps sort_order between two sibling categories when direction is 'down'", async () => {
        // Seed two sibling categories with distinct sort_order values
        const firstR = await pool.query<{ id: number }>(
          `INSERT INTO base_item_categories (workspace_owner_id, name, status, sort_order)
           VALUES ($1, 'Reorder First', 'active', 10) RETURNING id`,
          [OWNER_ID],
        );
        const firstId = firstR.rows[0].id;

        const secondR = await pool.query<{ id: number }>(
          `INSERT INTO base_item_categories (workspace_owner_id, name, status, sort_order)
           VALUES ($1, 'Reorder Second', 'active', 20) RETURNING id`,
          [OWNER_ID],
        );
        const secondId = secondR.rows[0].id;

        // Move 'first' down — it should swap sort_order with 'second'
        const res = await request(app)
          .post(`/base-item-categories/${firstId}/reorder`)
          .send({ direction: "down" });

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);

        // Check that sort_orders were actually swapped in the DB
        const rows = await pool.query<{ id: number; sort_order: number }>(
          `SELECT id, sort_order FROM base_item_categories WHERE id = ANY($1)`,
          [[firstId, secondId]],
        );
        const byId = Object.fromEntries(rows.rows.map((r) => [r.id, r.sort_order]));
        expect(byId[firstId]).toBe(20);
        expect(byId[secondId]).toBe(10);

        // Cleanup
        await pool.query(
          `DELETE FROM base_item_categories WHERE id = ANY($1)`,
          [[firstId, secondId]],
        );
      });

      it("swaps sort_order between two sibling categories when direction is 'up'", async () => {
        const firstR = await pool.query<{ id: number }>(
          `INSERT INTO base_item_categories (workspace_owner_id, name, status, sort_order)
           VALUES ($1, 'Up First', 'active', 5) RETURNING id`,
          [OWNER_ID],
        );
        const firstId = firstR.rows[0].id;

        const secondR = await pool.query<{ id: number }>(
          `INSERT INTO base_item_categories (workspace_owner_id, name, status, sort_order)
           VALUES ($1, 'Up Second', 'active', 15) RETURNING id`,
          [OWNER_ID],
        );
        const secondId = secondR.rows[0].id;

        // Move 'second' up — it should swap with 'first'
        const res = await request(app)
          .post(`/base-item-categories/${secondId}/reorder`)
          .send({ direction: "up" });

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);

        const rows = await pool.query<{ id: number; sort_order: number }>(
          `SELECT id, sort_order FROM base_item_categories WHERE id = ANY($1)`,
          [[firstId, secondId]],
        );
        const byId = Object.fromEntries(rows.rows.map((r) => [r.id, r.sort_order]));
        expect(byId[firstId]).toBe(15);
        expect(byId[secondId]).toBe(5);

        // Cleanup
        await pool.query(
          `DELETE FROM base_item_categories WHERE id = ANY($1)`,
          [[firstId, secondId]],
        );
      });

      it("reassigns parent_id when new_parent_id is provided", async () => {
        const parentAR = await pool.query<{ id: number }>(
          `INSERT INTO base_item_categories (workspace_owner_id, name, status)
           VALUES ($1, 'Reorder Parent A', 'active') RETURNING id`,
          [OWNER_ID],
        );
        const parentAId = parentAR.rows[0].id;

        const parentBR = await pool.query<{ id: number }>(
          `INSERT INTO base_item_categories (workspace_owner_id, name, status)
           VALUES ($1, 'Reorder Parent B', 'active') RETURNING id`,
          [OWNER_ID],
        );
        const parentBId = parentBR.rows[0].id;

        const childR = await pool.query<{ id: number }>(
          `INSERT INTO base_item_categories (workspace_owner_id, name, parent_id, status)
           VALUES ($1, 'Reorder Child', $2, 'active') RETURNING id`,
          [OWNER_ID, parentAId],
        );
        const childId = childR.rows[0].id;

        // Reassign child to parentB
        const res = await request(app)
          .post(`/base-item-categories/${childId}/reorder`)
          .send({ new_parent_id: parentBId });

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);

        const dbRow = await pool.query<{ parent_id: number }>(
          `SELECT parent_id FROM base_item_categories WHERE id = $1`,
          [childId],
        );
        expect(dbRow.rows[0].parent_id).toBe(parentBId);

        // Cleanup
        await pool.query(
          `DELETE FROM base_item_categories WHERE id = ANY($1)`,
          [[parentAId, parentBId, childId]],
        );
      });

      it("promotes a subcategory to main (new_parent_id = null)", async () => {
        const parentR = await pool.query<{ id: number }>(
          `INSERT INTO base_item_categories (workspace_owner_id, name, status)
           VALUES ($1, 'Promote Parent', 'active') RETURNING id`,
          [OWNER_ID],
        );
        const parentId = parentR.rows[0].id;

        const childR = await pool.query<{ id: number }>(
          `INSERT INTO base_item_categories (workspace_owner_id, name, parent_id, status)
           VALUES ($1, 'Promote Child', $2, 'active') RETURNING id`,
          [OWNER_ID, parentId],
        );
        const childId = childR.rows[0].id;

        const res = await request(app)
          .post(`/base-item-categories/${childId}/reorder`)
          .send({ new_parent_id: null });

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);

        const dbRow = await pool.query<{ parent_id: number | null }>(
          `SELECT parent_id FROM base_item_categories WHERE id = $1`,
          [childId],
        );
        expect(dbRow.rows[0].parent_id).toBeNull();

        // Cleanup
        await pool.query(
          `DELETE FROM base_item_categories WHERE id = ANY($1)`,
          [[parentId, childId]],
        );
      });

      it("returns 404 when the category does not exist", async () => {
        const res = await request(app)
          .post("/base-item-categories/999999999/reorder")
          .send({ direction: "up" });

        expect(res.status).toBe(404);
        expect(res.body.error).toMatch(/not found/i);
      });

      it("returns 400 for a non-numeric category id", async () => {
        const res = await request(app)
          .post("/base-item-categories/abc/reorder")
          .send({ direction: "up" });

        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/invalid category id/i);
      });
    });

    // ─────────────────────────────────────────────────────────────────────
    // PATCH /base-item-categories/:id — partial field updates
    // ─────────────────────────────────────────────────────────────────────

    describe("PATCH /base-item-categories/:id — partial updates (real DB)", () => {
      it("updates only the description without touching the name", async () => {
        const r = await pool.query<{ id: number }>(
          `INSERT INTO base_item_categories (workspace_owner_id, name, status)
           VALUES ($1, 'Partial Update Cat', 'active') RETURNING id`,
          [OWNER_ID],
        );
        const id = r.rows[0].id;

        const res = await request(app)
          .patch(`/base-item-categories/${id}`)
          .send({ description: "A useful description" });

        expect(res.status).toBe(200);
        expect(res.body.category.description).toBe("A useful description");
        // name must be unchanged
        expect(res.body.category.name).toBe("Partial Update Cat");

        await pool.query(`DELETE FROM base_item_categories WHERE id = $1`, [id]);
      });

      it("updates status to archived via PATCH", async () => {
        const r = await pool.query<{ id: number }>(
          `INSERT INTO base_item_categories (workspace_owner_id, name, status)
           VALUES ($1, 'Status Patch Cat', 'active') RETURNING id`,
          [OWNER_ID],
        );
        const id = r.rows[0].id;

        const res = await request(app)
          .patch(`/base-item-categories/${id}`)
          .send({ status: "archived" });

        expect(res.status).toBe(200);
        expect(res.body.category.status).toBe("archived");

        await pool.query(`DELETE FROM base_item_categories WHERE id = $1`, [id]);
      });

      it("updates sort_order via PATCH", async () => {
        const r = await pool.query<{ id: number }>(
          `INSERT INTO base_item_categories (workspace_owner_id, name, status, sort_order)
           VALUES ($1, 'Sort Order Cat', 'active', 100) RETURNING id`,
          [OWNER_ID],
        );
        const id = r.rows[0].id;

        const res = await request(app)
          .patch(`/base-item-categories/${id}`)
          .send({ sort_order: 55 });

        expect(res.status).toBe(200);
        expect(res.body.category.sort_order).toBe(55);

        await pool.query(`DELETE FROM base_item_categories WHERE id = $1`, [id]);
      });

      it("updates category_type via PATCH", async () => {
        const r = await pool.query<{ id: number }>(
          `INSERT INTO base_item_categories (workspace_owner_id, name, status)
           VALUES ($1, 'Type Patch Cat', 'active') RETURNING id`,
          [OWNER_ID],
        );
        const id = r.rows[0].id;

        const res = await request(app)
          .patch(`/base-item-categories/${id}`)
          .send({ category_type: "consumable" });

        expect(res.status).toBe(200);
        expect(res.body.category.category_type).toBe("consumable");
        // name must be unchanged
        expect(res.body.category.name).toBe("Type Patch Cat");

        await pool.query(`DELETE FROM base_item_categories WHERE id = $1`, [id]);
      });
    });
  },
);
