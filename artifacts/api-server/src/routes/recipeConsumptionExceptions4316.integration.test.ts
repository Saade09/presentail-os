/**
 * Integration tests for task #4316 — durable recipe-consumption exception flow.
 *
 * Exercises recipeConsumption service (postRecipeConsumption / upsertRecipeConsumptionException)
 * and the recipeConsumptionExceptions router against a real PostgreSQL database.
 *
 * Scenarios:
 *
 *   A. Missing baseline creates an open durable exception
 *      A1. postRecipeConsumption with flag ON but no baseline → skips, creates open exception
 *          with status="open", reason="MISSING_LEDGER_BASELINE", immutable source_snapshot,
 *          recipe-calculation snapshot, and one failed attempt in attempt_history.
 *
 *   B. List / detail workspace isolation and permission behaviour
 *      B1. GET /inventory/recipe-consumption-exceptions returns only own-workspace exceptions.
 *      B2. GET :id returns full detail including attempt_history.
 *      B3. GET :id with wrong workspace → 404.
 *      B4. GET with member that has no view permission → 403.
 *
 *   C. Retry happy path (baseline added after exception was created)
 *      C1. POST :id/retry after baseline → resolves exception, posts exactly one
 *          product_consumption movement at the order's location_id, status="resolved",
 *          resolved_movement_id set, success attempt appended.
 *      C2. Duplicate retry on already-resolved exception → 409.
 *      C3. Second idempotent retry of same exception (before it resolves) → same
 *          movement_id via idempotency key, does not double-post stock.
 *      C4. source_snapshot preserved across retry (immutable).
 *
 *   D. Missing location — can be corrected and retried
 *      D1. Exception created with no location (MISSING_FULFILMENT_LOCATION).
 *      D2. Retry while location still missing → 422 MISSING_FULFILMENT_LOCATION.
 *      D3. Add location to order, retry → resolves.
 *
 *   E. Negative-stock flag behaviour
 *      E1. Baseline present but stock=0 and allow_negative=false → exception with
 *          reason="INSUFFICIENT_STOCK".
 *      E2. Flip allow_negative_stock=true, retry → resolves (stock goes negative).
 *
 *   F. Baseline + ledger-delta reconciliation
 *      F1. After successful retry, base_item_location_statuses.stock equals the
 *          cutover_balance minus the consumed quantity.
 *
 * Auth/workspace middleware is stubbed; the database is real.
 * Skips automatically when DATABASE_URL is not set.
 *
 * Run:
 *   bash artifacts/api-server/test-integration-local.sh \
 *     src/routes/recipeConsumptionExceptions4316.integration.test.ts
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";
import { randomUUID } from "crypto";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;

// ─────────────────────────────────────────────────────────────────────────────
// Unique workspace IDs – never collide with real data
// ─────────────────────────────────────────────────────────────────────────────

const OWNER_ID       = "__integ_rce4316__";
const USER_ID        = "__integ_rce4316_user__";
const OTHER_OWNER_ID = "__integ_rce4316_other__";

// ─────────────────────────────────────────────────────────────────────────────
// Mocks (auth / workspace / logger / side-effect libs – db is real)
// ─────────────────────────────────────────────────────────────────────────────

vi.mock("../lib/auth", () => ({
  requireAuth: (_req: express.Request, _res: express.Response, next: express.NextFunction) =>
    next(),
  authed: (_req: express.Request) => ({ userId: USER_ID }),
}));

vi.mock("../lib/workspace", () => ({
  resolveWorkspace: (
    req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => {
    const wreq = req as unknown as import("../lib/workspace").WorkspaceRequest;
    // The mock reads a custom header so individual tests can override the workspace.
    const owner = (req.headers["x-test-owner"] as string | undefined) ?? OWNER_ID;
    const role  = (req.headers["x-test-role"]  as string | undefined) ?? "owner";
    wreq.workspaceOwnerId    = owner;
    wreq.workspaceRole       = role === "owner" ? "owner" : "member";
    wreq.workspaceActualRole = role === "owner" ? "owner" : "member";
    wreq.userId    = USER_ID;
    wreq.userEmail = "rce4316@example.com";
    wreq.allowedPages = role === "owner" ? null : (
      (req.headers["x-test-pages"] as string | undefined)?.split(",") ?? []
    );
    next();
  },
  workspace: (req: express.Request) =>
    req as unknown as import("../lib/workspace").WorkspaceRequest,
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info:  vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  },
}));

// ─────────────────────────────────────────────────────────────────────────────
// Router imports (MUST come after vi.mock)
// ─────────────────────────────────────────────────────────────────────────────

import recipeConsumptionExceptionsRouter from "./recipeConsumptionExceptions";
import { db as routeDb } from "../lib/db";
import {
  postRecipeConsumption,
  upsertRecipeConsumptionException,
} from "../lib/recipeConsumption";
import { postCancellationReversal } from "../lib/cancellationReversal";

// ─────────────────────────────────────────────────────────────────────────────
// App factory
// ─────────────────────────────────────────────────────────────────────────────

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api", recipeConsumptionExceptionsRouter);
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err?.message ?? String(err) });
  });
  return app;
}

// ─────────────────────────────────────────────────────────────────────────────
// Suite
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!DATABASE_URL)(
  "Durable recipe-consumption exception flow — integration (task #4316)",
  () => {
    let pool: InstanceType<typeof Pool>;
    let app: express.Express;

    // Seeded entity IDs
    let baseItemId: number;
    let locationId:  number;
    let productId:   number;

    // ─────────────────────────────────────────────────────────────────────────
    // beforeAll – seed workspace entities
    // ─────────────────────────────────────────────────────────────────────────

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });
      app  = makeApp();

      // ── Clean up any leftovers ────────────────────────────────────────────
      await wipeWorkspace(pool, OWNER_ID);
      await wipeWorkspace(pool, OTHER_OWNER_ID);

      // ── Seed shared entities ──────────────────────────────────────────────

      // Base item
      const biRow = await pool.query<{ id: number }>(
        `INSERT INTO base_items (workspace_owner_id, name, code, status, stock)
         VALUES ($1, 'RCE4316 Rose', 'RCE4316-BI-001', 'active', 0) RETURNING id`,
        [OWNER_ID],
      );
      baseItemId = biRow.rows[0].id;

      // Location
      const locRow = await pool.query<{ id: number }>(
        `INSERT INTO locations (workspace_owner_id, name, country)
         VALUES ($1, 'RCE4316 Store', 'AE') RETURNING id`,
        [OWNER_ID],
      );
      locationId = locRow.rows[0].id;

      // base_item_location_statuses (stock = 50)
      await pool.query(
        `INSERT INTO base_item_location_statuses
           (workspace_owner_id, base_item_id, location_id, is_active, stock)
         VALUES ($1, $2, $3, true, 50)`,
        [OWNER_ID, baseItemId, locationId],
      );

      // Product (inventory_tracked)
      const pRow = await pool.query<{ id: number }>(
        `INSERT INTO products (workspace_owner_id, name, price_usd, price_aed, inventory_tracked)
         VALUES ($1, 'RCE4316 Bouquet', 0, 0, true) RETURNING id`,
        [OWNER_ID],
      );
      productId = pRow.rows[0].id;

      // Recipe: 3 roses per product
      await pool.query(
        `INSERT INTO product_recipes (workspace_owner_id, product_id, base_item_id, quantity)
         VALUES ($1, $2, $3, 3)`,
        [OWNER_ID, productId, baseItemId],
      );

      // workspace_settings: recipe consumption enabled, negative stock OFF
      await pool.query(
        `INSERT INTO workspace_settings
           (workspace_owner_id, inventory_recipe_consumption_enabled, inventory_allow_negative_stock)
         VALUES ($1, true, false)
         ON CONFLICT (workspace_owner_id) DO UPDATE
           SET inventory_recipe_consumption_enabled = true,
               inventory_allow_negative_stock       = false`,
        [OWNER_ID],
      );
    });

    afterAll(async () => {
      if (!pool) return;
      await wipeWorkspace(pool, OWNER_ID);
      await wipeWorkspace(pool, OTHER_OWNER_ID);
      await pool.end();
      await (routeDb as unknown as import("pg").Pool).end();
    });

    // ─────────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────────

    /** Remove all test-owned rows in dependency order. */
    async function wipeWorkspace(db: pg.Pool, owner: string): Promise<void> {
      await db.query(`DELETE FROM recipe_consumption_exceptions   WHERE workspace_owner_id = $1`, [owner]);
      await db.query(`DELETE FROM base_item_stock_adjustments     WHERE workspace_owner_id = $1`, [owner]);
      await db.query(`DELETE FROM base_item_ledger_settings       WHERE workspace_owner_id = $1`, [owner]);
      await db.query(`DELETE FROM order_florist_assignments       WHERE workspace_owner_id = $1`, [owner]);
      await db.query(`DELETE FROM order_line_items WHERE order_id IN (SELECT id FROM orders WHERE workspace_owner_id = $1)`, [owner]);
      await db.query(`DELETE FROM orders                          WHERE workspace_owner_id = $1`, [owner]);
      await db.query(`DELETE FROM product_recipes                 WHERE workspace_owner_id = $1`, [owner]);
      await db.query(`DELETE FROM products                        WHERE workspace_owner_id = $1`, [owner]);
      await db.query(`DELETE FROM base_item_location_statuses     WHERE workspace_owner_id = $1`, [owner]);
      await db.query(`DELETE FROM base_items                      WHERE workspace_owner_id = $1`, [owner]);
      await db.query(`DELETE FROM locations                       WHERE workspace_owner_id = $1`, [owner]);
      await db.query(`DELETE FROM workspace_settings              WHERE workspace_owner_id = $1`, [owner]);
    }

    /** Reset location stock and clear all adjustment / exception rows. */
    async function resetInventory(stockLevel = 50): Promise<void> {
      await pool.query(
        `UPDATE base_item_location_statuses SET stock = $1
          WHERE workspace_owner_id = $2 AND base_item_id = $3`,
        [stockLevel, OWNER_ID, baseItemId],
      );
      await pool.query(`UPDATE base_items SET stock = $1 WHERE id = $2`, [stockLevel, baseItemId]);
      await pool.query(`DELETE FROM base_item_stock_adjustments WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM recipe_consumption_exceptions WHERE workspace_owner_id = $1`, [OWNER_ID]);
      await pool.query(`DELETE FROM base_item_ledger_settings WHERE workspace_owner_id = $1`, [OWNER_ID]);
    }

    /**
     * Create a minimal order with one line item for productId, optionally
     * assigning a location via order.location_id or order_florist_assignments.
     */
    async function createOrder(opts: {
      useOrderLocation?: boolean;   // set orders.location_id
      useAssignment?: boolean;      // set order_florist_assignments.location_id
      orderedQty?: number;
    } = {}): Promise<{ orderId: string; lineItemId: string }> {
      const { useOrderLocation = false, useAssignment = false, orderedQty = 2 } = opts;

      const orderRow = await pool.query<{ id: string }>(
        `INSERT INTO orders (workspace_owner_id, source, status, location_id, created_at, updated_at)
         VALUES ($1, 'manual', 'ready_for_delivery', $2, now(), now())
         RETURNING id`,
        [OWNER_ID, useOrderLocation ? locationId : null],
      );
      const orderId = orderRow.rows[0].id;

      const liRow = await pool.query<{ id: string }>(
        `INSERT INTO order_line_items (order_id, product_id, name, quantity)
         VALUES ($1, $2, 'RCE4316 Bouquet', $3)
         RETURNING id`,
        [orderId, productId, orderedQty],
      );
      const lineItemId = liRow.rows[0].id;

      if (useAssignment) {
        await pool.query(
          `INSERT INTO order_florist_assignments
             (workspace_owner_id, order_id, location_id, status, created_at, updated_at)
           VALUES ($1, $2, $3, 'pending', now(), now())`,
          [OWNER_ID, orderId, locationId],
        );
      }

      return { orderId, lineItemId };
    }

    /** Insert a baseline row for the seeded base item + location. */
    async function addBaseline(cutoverBalance = 50): Promise<void> {
      await pool.query(
        `INSERT INTO base_item_ledger_settings
           (workspace_owner_id, base_item_id, location_id,
            cutover_at, cutover_balance, verified_by_user_id, verification_reason, verified_at)
         VALUES ($1, $2, $3, now(), $4, $5, 'integration test', now())
         ON CONFLICT (workspace_owner_id, base_item_id, location_id)
         DO UPDATE SET cutover_balance = EXCLUDED.cutover_balance`,
        [OWNER_ID, baseItemId, locationId, cutoverBalance, USER_ID],
      );
    }

    function immutableRecipeSource(
      orderId: string,
      lineItemId: string,
      orderedQty = 2,
      recipeQty = 3,
    ): import("../lib/recipeConsumption").ExceptionSourceSnapshot {
      const idempotencyKey = `pc:${orderId}:${lineItemId}:${baseItemId}:c0`;
      const consumed = orderedQty * recipeQty;
      return {
        eventType: "order.ready_for_delivery",
        eventCycle: 0,
        orderId,
        lineItemId,
        productId,
        baseItemId,
        locationId,
        idempotencyKey,
        recipeSnapshot: {
          productId,
          productName: "RCE4316 Bouquet",
          lineItemId,
          orderedQty: String(orderedQty),
          baseItemId,
          baseItemName: "RCE4316 Rose",
          recipeQty: String(recipeQty),
          canonicalUnit: "unit",
          canonicalQtyPerLineItem: String(consumed),
          calculation: `${orderedQty} ordered × ${recipeQty} recipe unit = ${consumed} unit`,
          cycle: 0,
        },
      };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // A. Missing baseline creates an open durable exception
    // ─────────────────────────────────────────────────────────────────────────

    describe("A. Missing baseline → open exception", () => {
      it("A1: postRecipeConsumption with no baseline creates open exception with immutable snapshot", async () => {
        await resetInventory();
        const { orderId, lineItemId } = await createOrder({ useOrderLocation: true });

        // No baseline → postRecipeConsumption should skip + create exception
        const client = await (routeDb as unknown as import("pg").Pool).connect();
        let result: Awaited<ReturnType<typeof postRecipeConsumption>>;
        try {
          await client.query("BEGIN");
          result = await postRecipeConsumption(client, orderId, OWNER_ID);
          await client.query("COMMIT");
        } finally {
          client.release();
        }

        // Should have one skipped entry with MISSING_LEDGER_BASELINE
        expect(result.skippedEntries).toBeDefined();
        const entry = result.skippedEntries!.find(e => e.reason === "MISSING_LEDGER_BASELINE");
        expect(entry).toBeDefined();
        expect(entry!.baseItemId).toBe(baseItemId);

        // Verify durable exception row exists in DB
        const excRow = await pool.query<{
          id: string;
          status: string;
          reason: string;
          source_snapshot: Record<string, unknown>;
          attempt_history: Array<Record<string, unknown>>;
          resolved_movement_id: number | null;
          order_id: string;
          line_item_id: string;
          base_item_id: number;
          location_id: number;
          idempotency_key: string;
        }>(
          `SELECT id, status, reason, source_snapshot, attempt_history,
                  resolved_movement_id, order_id, line_item_id, base_item_id,
                  location_id, idempotency_key
             FROM recipe_consumption_exceptions
            WHERE workspace_owner_id = $1
            ORDER BY created_at DESC LIMIT 1`,
          [OWNER_ID],
        );
        expect(excRow.rowCount).toBe(1);

        const exc = excRow.rows[0];
        expect(exc.status).toBe("open");
        expect(exc.reason).toBe("MISSING_LEDGER_BASELINE");
        expect(exc.resolved_movement_id).toBeNull();
        expect(exc.order_id).toBe(orderId);
        expect(exc.line_item_id).toBe(lineItemId);
        expect(exc.base_item_id).toBe(baseItemId);
        expect(exc.location_id).toBe(locationId);

        // idempotency_key uses buildConsumptionKey pattern: pc:<orderId>:<lineItemId>:<baseItemId>:c0
        expect(exc.idempotency_key).toContain(`pc:${orderId}:${lineItemId}:${baseItemId}:`);

        // source_snapshot must be a non-empty object capturing the event
        expect(typeof exc.source_snapshot).toBe("object");
        expect(exc.source_snapshot).not.toBeNull();
        const snap = exc.source_snapshot;
        expect(snap.orderId).toBe(orderId);
        expect(snap.lineItemId).toBe(lineItemId);
        expect(snap.baseItemId).toBe(baseItemId);
        expect(snap.locationId).toBe(locationId);
        // recipeSnapshot with calculation string
        expect(snap.recipeSnapshot).toBeDefined();
        const rSnap = snap.recipeSnapshot as Record<string, unknown>;
        expect(typeof rSnap.calculation).toBe("string");
        expect(rSnap.calculation as string).toMatch(/ordered.*recipe/i);

        // attempt_history must have exactly 1 failed attempt
        expect(Array.isArray(exc.attempt_history)).toBe(true);
        expect(exc.attempt_history.length).toBe(1);
        const attempt = exc.attempt_history[0];
        expect(attempt.succeeded).toBe(false);
        expect(attempt.reason).toBe("MISSING_LEDGER_BASELINE");

        // No movement should have been posted
        const movCount = await pool.query<{ cnt: string }>(
          `SELECT COUNT(*)::text AS cnt FROM base_item_stock_adjustments
            WHERE workspace_owner_id = $1 AND order_id = $2`,
          [OWNER_ID, orderId],
        );
        expect(Number(movCount.rows[0].cnt)).toBe(0);

        await pool.query(`DELETE FROM orders WHERE id = $1`, [orderId]);
      });

      it("A1 immutability: re-running postRecipeConsumption for same order does not mutate source_snapshot", async () => {
        await resetInventory();
        const { orderId } = await createOrder({ useOrderLocation: true });

        const client = await (routeDb as unknown as import("pg").Pool).connect();
        try {
          await client.query("BEGIN");
          await postRecipeConsumption(client, orderId, OWNER_ID);
          await client.query("COMMIT");
        } finally {
          client.release();
        }

        // Grab original snapshot
        const before = await pool.query<{ source_snapshot: string; attempt_history_len: string }>(
          `SELECT source_snapshot::text AS source_snapshot,
                  jsonb_array_length(attempt_history)::text AS attempt_history_len
             FROM recipe_consumption_exceptions
            WHERE workspace_owner_id = $1
            ORDER BY created_at DESC LIMIT 1`,
          [OWNER_ID],
        );
        const originalSnapshot = before.rows[0].source_snapshot;

        // Run again (re-fire for same order)
        const client2 = await (routeDb as unknown as import("pg").Pool).connect();
        try {
          await client2.query("BEGIN");
          await postRecipeConsumption(client2, orderId, OWNER_ID);
          await client2.query("COMMIT");
        } finally {
          client2.release();
        }

        const after = await pool.query<{ source_snapshot: string; attempt_history_len: string }>(
          `SELECT source_snapshot::text AS source_snapshot,
                  jsonb_array_length(attempt_history)::text AS attempt_history_len
             FROM recipe_consumption_exceptions
            WHERE workspace_owner_id = $1
            ORDER BY created_at DESC LIMIT 1`,
          [OWNER_ID],
        );

        // source_snapshot must be unchanged (immutable)
        expect(after.rows[0].source_snapshot).toBe(originalSnapshot);
        // attempt_history should have grown by 1 (upsert appends)
        expect(Number(after.rows[0].attempt_history_len)).toBeGreaterThan(
          Number(before.rows[0].attempt_history_len),
        );

        await pool.query(`DELETE FROM orders WHERE id = $1`, [orderId]);
      });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // B. List / detail — workspace isolation and permission behaviour
    // ─────────────────────────────────────────────────────────────────────────

    describe("B. List / detail API", () => {
      let excId: string;
      let otherExcId: string;

      beforeAll(async () => {
        await resetInventory();

        // Seed one exception in OWNER_ID workspace directly
        const client = await (routeDb as unknown as import("pg").Pool).connect();
        try {
          await client.query("BEGIN");
          excId = await upsertRecipeConsumptionException(client, {
            workspaceOwnerId: OWNER_ID,
            orderId: randomUUID(),
            lineItemId: randomUUID(),
            baseItemId,
            productId,
            locationId,
            reason: "MISSING_LEDGER_BASELINE",
            idempotencyKey: `pc:${randomUUID()}:c0`,
            sourceSnapshot: {
              orderId: "test-order-B",
              lineItemId: "test-li-B",
              idempotencyKey: "pc:test-B:c0",
            },
          });
          await client.query("COMMIT");
        } finally {
          client.release();
        }

        // Seed one exception in OTHER_OWNER_ID workspace
        // (needs a base item in that workspace for FK; we insert without FK check risk
        //  by using a direct insert with workspace isolation only via workspace_owner_id)
        const otherClient = await (routeDb as unknown as import("pg").Pool).connect();
        try {
          await otherClient.query("BEGIN");
          otherExcId = await upsertRecipeConsumptionException(otherClient, {
            workspaceOwnerId: OTHER_OWNER_ID,
            orderId: randomUUID(),
            lineItemId: randomUUID(),
            baseItemId: null,         // nullable in schema
            productId: null,
            locationId: null,
            reason: "MISSING_RECIPE",
            idempotencyKey: `pc:other:${randomUUID()}:c0`,
            sourceSnapshot: {
              orderId: "other-order",
              lineItemId: "other-li",
              idempotencyKey: "pc:other:c0",
            },
          });
          await otherClient.query("COMMIT");
        } finally {
          otherClient.release();
        }
      });

      afterAll(async () => {
        await resetInventory();
      });

      it("B1: GET list returns only exceptions belonging to the caller's workspace", async () => {
        const res = await request(app)
          .get("/api/inventory/recipe-consumption-exceptions")
          .set("x-test-owner", OWNER_ID);

        expect(res.status).toBe(200);
        expect(Array.isArray(res.body.items)).toBe(true);
        // All returned items must belong to OWNER_ID
        for (const item of res.body.items as Array<{ workspace_owner_id: string }>) {
          expect(item.workspace_owner_id).toBe(OWNER_ID);
        }
        // Must include the seeded exception
        const ids = (res.body.items as Array<{ id: string }>).map(i => i.id);
        expect(ids).toContain(excId);
        // Must NOT contain the other workspace's exception
        expect(ids).not.toContain(otherExcId);
      });

      it("B2: GET :id returns full detail including attempt_history", async () => {
        const res = await request(app)
          .get(`/api/inventory/recipe-consumption-exceptions/${excId}`)
          .set("x-test-owner", OWNER_ID);

        expect(res.status).toBe(200);
        expect(res.body.id).toBe(excId);
        expect(res.body.status).toBe("open");
        expect(res.body.reason).toBe("MISSING_LEDGER_BASELINE");
        expect(Array.isArray(res.body.attempt_history)).toBe(true);
        expect(typeof res.body.source_snapshot).toBe("object");
      });

      it("B3: GET :id from wrong workspace → 404", async () => {
        // Request as OTHER_OWNER_ID trying to read OWNER_ID's exception
        const res = await request(app)
          .get(`/api/inventory/recipe-consumption-exceptions/${excId}`)
          .set("x-test-owner", OTHER_OWNER_ID);

        expect(res.status).toBe(404);
      });

      it("B4: GET list with member lacking view permission → 403", async () => {
        const res = await request(app)
          .get("/api/inventory/recipe-consumption-exceptions")
          .set("x-test-owner", OWNER_ID)
          .set("x-test-role",  "member")
          .set("x-test-pages", ""); // empty — no permissions

        expect(res.status).toBe(403);
      });

      it("B4b: GET list with member having base_items.view → 200", async () => {
        const res = await request(app)
          .get("/api/inventory/recipe-consumption-exceptions")
          .set("x-test-owner", OWNER_ID)
          .set("x-test-role",  "member")
          .set("x-test-pages", "base_items.view");

        expect(res.status).toBe(200);
      });

      it("B4c: POST retry with member lacking manage permission → 403", async () => {
        const res = await request(app)
          .post(`/api/inventory/recipe-consumption-exceptions/${excId}/retry`)
          .set("x-test-owner", OWNER_ID)
          .set("x-test-role",  "member")
          .set("x-test-pages", "base_items.view"); // view only, not manage

        expect(res.status).toBe(403);
      });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // C. Retry happy path
    // ─────────────────────────────────────────────────────────────────────────

    describe("C. Retry happy path", () => {
      it("C1: after adding baseline, retry resolves exception and posts exactly one movement", async () => {
        await resetInventory();
        await addBaseline(50);
        const { orderId, lineItemId } = await createOrder({ useOrderLocation: true });

        // Create exception first (simulate initial failure before baseline was added)
        const idempKey = `pc:${orderId}:${lineItemId}:${baseItemId}:c0`;
        const client = await (routeDb as unknown as import("pg").Pool).connect();
        let excId: string;
        try {
          await client.query("BEGIN");
          excId = await upsertRecipeConsumptionException(client, {
            workspaceOwnerId: OWNER_ID,
            orderId,
            lineItemId,
            baseItemId,
            productId,
            locationId,
            reason: "MISSING_LEDGER_BASELINE",
            idempotencyKey: idempKey,
            sourceSnapshot: immutableRecipeSource(orderId, lineItemId),
            attempt: {
              attemptedAt: new Date().toISOString(),
              reason: "MISSING_LEDGER_BASELINE",
              detail: { baseItemId, locationId },
              succeeded: false,
            },
          });
          await client.query("COMMIT");
        } finally {
          client.release();
        }

        // POST retry
        const res = await request(app)
          .post(`/api/inventory/recipe-consumption-exceptions/${excId}/retry`)
          .set("x-test-owner", OWNER_ID);

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.status).toBe("resolved");
        expect(typeof res.body.movementId).toBe("number");
        const movementId = res.body.movementId as number;

        // Exception row must now be resolved
        const excRow = await pool.query<{ status: string; resolved_movement_id: number; attempt_history: unknown[] }>(
          `SELECT status, resolved_movement_id, attempt_history
             FROM recipe_consumption_exceptions WHERE id = $1`,
          [excId],
        );
        expect(excRow.rows[0].status).toBe("resolved");
        expect(excRow.rows[0].resolved_movement_id).toBe(movementId);

        // attempt_history must have a new success entry
        const history = excRow.rows[0].attempt_history as Array<{ succeeded: boolean; movementId?: number }>;
        const successAttempt = history.find(a => a.succeeded === true);
        expect(successAttempt).toBeDefined();
        expect(successAttempt!.movementId).toBe(movementId);

        // Exactly one product_consumption movement for this order
        const movRows = await pool.query<{ id: number; movement_type: string; quantity_change: string; location_id: number }>(
          `SELECT id, movement_type, quantity_change::text, location_id
             FROM base_item_stock_adjustments
            WHERE workspace_owner_id = $1 AND order_id = $2`,
          [OWNER_ID, orderId],
        );
        expect(movRows.rowCount).toBe(1);
        expect(movRows.rows[0].movement_type).toBe("product_consumption");
        // 2 ordered × 3 recipe = -6
        expect(Number(movRows.rows[0].quantity_change)).toBe(-6);
        // Posted at the order's location
        expect(movRows.rows[0].location_id).toBe(locationId);

        await pool.query(`DELETE FROM orders WHERE id = $1`, [orderId]);
      });

      it("C2: retry on already-resolved exception → 409", async () => {
        await resetInventory();
        await addBaseline(50);
        const { orderId, lineItemId } = await createOrder({ useOrderLocation: true });

        const idempKey = `pc:${orderId}:${lineItemId}:${baseItemId}:c0`;
        const client = await (routeDb as unknown as import("pg").Pool).connect();
        let excId: string;
        try {
          await client.query("BEGIN");
          excId = await upsertRecipeConsumptionException(client, {
            workspaceOwnerId: OWNER_ID,
            orderId,
            lineItemId,
            baseItemId,
            productId,
            locationId,
            reason: "MISSING_LEDGER_BASELINE",
            idempotencyKey: idempKey,
            sourceSnapshot: immutableRecipeSource(orderId, lineItemId),
          });
          await client.query("COMMIT");
        } finally {
          client.release();
        }

        // First retry – should succeed
        const first = await request(app)
          .post(`/api/inventory/recipe-consumption-exceptions/${excId}/retry`)
          .set("x-test-owner", OWNER_ID);
        expect(first.status).toBe(200);
        expect(first.body.status).toBe("resolved");

        // Second retry – should 409
        const second = await request(app)
          .post(`/api/inventory/recipe-consumption-exceptions/${excId}/retry`)
          .set("x-test-owner", OWNER_ID);
        expect(second.status).toBe(409);
        expect(second.body.error).toMatch(/already resolved/i);

        await pool.query(`DELETE FROM orders WHERE id = $1`, [orderId]);
      });

      it("C3: idempotent duplicate retry does not double-post stock", async () => {
        await resetInventory();
        await addBaseline(50);
        const { orderId, lineItemId } = await createOrder({ useOrderLocation: true });

        const idempKey = `pc:${orderId}:${lineItemId}:${baseItemId}:c0`;
        const client = await (routeDb as unknown as import("pg").Pool).connect();
        let excId: string;
        try {
          await client.query("BEGIN");
          excId = await upsertRecipeConsumptionException(client, {
            workspaceOwnerId: OWNER_ID,
            orderId,
            lineItemId,
            baseItemId,
            productId,
            locationId,
            reason: "MISSING_LEDGER_BASELINE",
            idempotencyKey: idempKey,
            sourceSnapshot: immutableRecipeSource(orderId, lineItemId),
          });
          await client.query("COMMIT");
        } finally {
          client.release();
        }

        // First retry
        const first = await request(app)
          .post(`/api/inventory/recipe-consumption-exceptions/${excId}/retry`)
          .set("x-test-owner", OWNER_ID);
        expect(first.status).toBe(200);
        const movementId1 = first.body.movementId as number;

        // Reopen the exception manually to simulate a retry from an "open" state
        // (in production this would be a race; here we simulate via direct DB write)
        await pool.query(
          `UPDATE recipe_consumption_exceptions
              SET status = 'open', resolved_movement_id = NULL
            WHERE id = $1`,
          [excId],
        );

        // Second retry attempt with the same idempotency key already posted
        const second = await request(app)
          .post(`/api/inventory/recipe-consumption-exceptions/${excId}/retry`)
          .set("x-test-owner", OWNER_ID);
        expect(second.status).toBe(200);
        expect(second.body.status).toBe("resolved");
        // Must return the same movement, not a new one
        expect(second.body.movementId).toBe(movementId1);

        // Stock must reflect exactly one consumption (not two)
        const locRow = await pool.query<{ stock: string }>(
          `SELECT stock FROM base_item_location_statuses
            WHERE base_item_id = $1 AND location_id = $2`,
          [baseItemId, locationId],
        );
        expect(Number(locRow.rows[0].stock)).toBe(50 - 6); // 50 - (2×3)

        // Only one adjustment row
        const movCount = await pool.query<{ cnt: string }>(
          `SELECT COUNT(*)::text AS cnt FROM base_item_stock_adjustments
            WHERE workspace_owner_id = $1 AND order_id = $2`,
          [OWNER_ID, orderId],
        );
        expect(Number(movCount.rows[0].cnt)).toBe(1);

        await pool.query(`DELETE FROM orders WHERE id = $1`, [orderId]);
      });

      it("C4: source_snapshot is preserved (immutable) across retry", async () => {
        await resetInventory();
        await addBaseline(50);
        const { orderId, lineItemId } = await createOrder({ useOrderLocation: true });

        const idempKey = `pc:${orderId}:${lineItemId}:${baseItemId}:c0`;
        const originalSnap = immutableRecipeSource(orderId, lineItemId);
        (originalSnap.recipeSnapshot as Record<string, unknown>).calculation =
          "ORIGINAL_SNAPSHOT_SENTINEL";

        const client = await (routeDb as unknown as import("pg").Pool).connect();
        let excId: string;
        try {
          await client.query("BEGIN");
          excId = await upsertRecipeConsumptionException(client, {
            workspaceOwnerId: OWNER_ID,
            orderId,
            lineItemId,
            baseItemId,
            productId,
            locationId,
            reason: "MISSING_LEDGER_BASELINE",
            idempotencyKey: idempKey,
            sourceSnapshot: originalSnap as import("../lib/recipeConsumption").ExceptionSourceSnapshot,
          });
          await client.query("COMMIT");
        } finally {
          client.release();
        }

        // Retry (resolves)
        const retryRes = await request(app)
          .post(`/api/inventory/recipe-consumption-exceptions/${excId}/retry`)
          .set("x-test-owner", OWNER_ID);
        expect(retryRes.status).toBe(200);

        // source_snapshot must still contain the original sentinel
        const excRow = await pool.query<{ source_snapshot: Record<string, unknown> }>(
          `SELECT source_snapshot FROM recipe_consumption_exceptions WHERE id = $1`,
          [excId],
        );
        const snap = excRow.rows[0].source_snapshot as Record<string, unknown>;
        const rSnap = snap.recipeSnapshot as Record<string, unknown> | undefined;
        expect(rSnap?.calculation).toBe("ORIGINAL_SNAPSHOT_SENTINEL");

        await pool.query(`DELETE FROM orders WHERE id = $1`, [orderId]);
      });

      it("C5: rejects retry when order quantity changed after the physical event", async () => {
        await resetInventory();
        await addBaseline(50);
        const { orderId, lineItemId } = await createOrder({
          useOrderLocation: true,
          orderedQty: 2,
        });
        const idempKey = `pc:${orderId}:${lineItemId}:${baseItemId}:c0`;
        const client = await (routeDb as unknown as import("pg").Pool).connect();
        let excId: string;
        try {
          await client.query("BEGIN");
          excId = await upsertRecipeConsumptionException(client, {
            workspaceOwnerId: OWNER_ID,
            orderId,
            lineItemId,
            baseItemId,
            productId,
            locationId,
            reason: "MISSING_LEDGER_BASELINE",
            idempotencyKey: idempKey,
            sourceSnapshot: immutableRecipeSource(orderId, lineItemId, 2),
          });
          await client.query("COMMIT");
        } finally {
          client.release();
        }

        await pool.query(
          `UPDATE order_line_items SET quantity = 5 WHERE id = $1`,
          [lineItemId],
        );
        const retry = await request(app)
          .post(`/api/inventory/recipe-consumption-exceptions/${excId}/retry`)
          .set("x-test-owner", OWNER_ID);
        expect(retry.status).toBe(422);
        expect(retry.body.reason).toBe("INTEGRITY_FAILURE");
        const movementCount = await pool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
             FROM base_item_stock_adjustments
            WHERE workspace_owner_id = $1 AND order_id = $2`,
          [OWNER_ID, orderId],
        );
        expect(Number(movementCount.rows[0].count)).toBe(0);
        await pool.query(`DELETE FROM orders WHERE id = $1`, [orderId]);
      });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // D. Missing location – can be corrected and retried
    // ─────────────────────────────────────────────────────────────────────────

    describe("D. Missing location flow", () => {
      it("D1-D3: exception created with no location, retry fails, location added, retry succeeds", async () => {
        await resetInventory();
        await addBaseline(50);

        // Create order with NO location
        const { orderId, lineItemId } = await createOrder({
          useOrderLocation: false,
          useAssignment: false,
        });

        // postRecipeConsumption should create MISSING_FULFILMENT_LOCATION exception
        const client = await (routeDb as unknown as import("pg").Pool).connect();
        try {
          await client.query("BEGIN");
          const res = await postRecipeConsumption(client, orderId, OWNER_ID);
          await client.query("COMMIT");
          const entry = res.skippedEntries?.find(e => e.reason === "MISSING_FULFILMENT_LOCATION");
          expect(entry).toBeDefined();
        } finally {
          client.release();
        }

        // Retrieve the created exception
        const excRow = await pool.query<{ id: string; reason: string; status: string }>(
          `SELECT id, reason, status FROM recipe_consumption_exceptions
            WHERE workspace_owner_id = $1 AND order_id = $2`,
          [OWNER_ID, orderId],
        );
        expect(excRow.rowCount).toBe(1);
        const excId = excRow.rows[0].id;
        expect(excRow.rows[0].reason).toBe("MISSING_FULFILMENT_LOCATION");

        // D2: retry while location still missing → 422
        const failRetry = await request(app)
          .post(`/api/inventory/recipe-consumption-exceptions/${excId}/retry`)
          .set("x-test-owner", OWNER_ID);
        expect(failRetry.status).toBe(422);
        expect(failRetry.body.reason).toBe("MISSING_FULFILMENT_LOCATION");

        // Exception must still be open
        const afterFail = await pool.query<{ status: string }>(
          `SELECT status FROM recipe_consumption_exceptions WHERE id = $1`,
          [excId],
        );
        expect(afterFail.rows[0].status).toBe("open");

        // D3: add location to order, retry should succeed
        await pool.query(
          `UPDATE orders SET location_id = $1 WHERE id = $2`,
          [locationId, orderId],
        );

        const successRetry = await request(app)
          .post(`/api/inventory/recipe-consumption-exceptions/${excId}/retry`)
          .set("x-test-owner", OWNER_ID);
        expect(successRetry.status).toBe(200);
        expect(successRetry.body.status).toBe("resolved");
        expect(typeof successRetry.body.movementId).toBe("number");

        // Movement posted at the correct location
        const movRow = await pool.query<{ location_id: number }>(
          `SELECT location_id FROM base_item_stock_adjustments
            WHERE workspace_owner_id = $1 AND order_id = $2`,
          [OWNER_ID, orderId],
        );
        expect(movRow.rowCount).toBe(1);
        expect(movRow.rows[0].location_id).toBe(locationId);

        await pool.query(`DELETE FROM orders WHERE id = $1`, [orderId]);
      });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // E. Negative-stock flag behaviour
    // ─────────────────────────────────────────────────────────────────────────

    describe("E. Negative-stock flag behaviour", () => {
      it("E1: baseline present but stock=0, allow_negative=false → INSUFFICIENT_STOCK exception on retry", async () => {
        // Reset to stock=0 so any consumption fails
        await resetInventory(0);
        await addBaseline(0); // baseline with 0 balance

        const { orderId, lineItemId } = await createOrder({ useOrderLocation: true });

        // Create exception via upsert (as if initial postRecipeConsumption failed with MISSING_LEDGER_BASELINE)
        const idempKey = `pc:${orderId}:${lineItemId}:${baseItemId}:c0`;
        const client = await (routeDb as unknown as import("pg").Pool).connect();
        let excId: string;
        try {
          await client.query("BEGIN");
          excId = await upsertRecipeConsumptionException(client, {
            workspaceOwnerId: OWNER_ID,
            orderId,
            lineItemId,
            baseItemId,
            productId,
            locationId,
            reason: "MISSING_LEDGER_BASELINE",
            idempotencyKey: idempKey,
            sourceSnapshot: immutableRecipeSource(orderId, lineItemId),
          });
          await client.query("COMMIT");
        } finally {
          client.release();
        }

        // Retry: stock=0, consuming -6 → INSUFFICIENT_STOCK
        const res = await request(app)
          .post(`/api/inventory/recipe-consumption-exceptions/${excId}/retry`)
          .set("x-test-owner", OWNER_ID);
        expect(res.status).toBe(422);
        expect(res.body.reason).toBe("INSUFFICIENT_STOCK");

        // Exception must be open with an INSUFFICIENT_STOCK attempt
        const excRow = await pool.query<{ status: string; reason: string; attempt_history: unknown[] }>(
          `SELECT status, reason, attempt_history
             FROM recipe_consumption_exceptions WHERE id = $1`,
          [excId],
        );
        expect(excRow.rows[0].status).toBe("open");
        expect(excRow.rows[0].reason).toBe("INSUFFICIENT_STOCK");
        const hist = excRow.rows[0].attempt_history as Array<{ succeeded: boolean; reason: string }>;
        const lastAttempt = hist[hist.length - 1];
        expect(lastAttempt.succeeded).toBe(false);
        expect(lastAttempt.reason).toBe("INSUFFICIENT_STOCK");

        await pool.query(`DELETE FROM orders WHERE id = $1`, [orderId]);
      });

      it("E2: flip allow_negative_stock=true, retry succeeds (stock goes negative)", async () => {
        await resetInventory(0);
        await addBaseline(0);

        // Enable negative stock
        await pool.query(
          `UPDATE workspace_settings SET inventory_allow_negative_stock = true
            WHERE workspace_owner_id = $1`,
          [OWNER_ID],
        );

        const { orderId, lineItemId } = await createOrder({ useOrderLocation: true });

        const idempKey = `pc:${orderId}:${lineItemId}:${baseItemId}:c0`;
        const client = await (routeDb as unknown as import("pg").Pool).connect();
        let excId: string;
        try {
          await client.query("BEGIN");
          excId = await upsertRecipeConsumptionException(client, {
            workspaceOwnerId: OWNER_ID,
            orderId,
            lineItemId,
            baseItemId,
            productId,
            locationId,
            reason: "INSUFFICIENT_STOCK",
            idempotencyKey: idempKey,
            sourceSnapshot: immutableRecipeSource(orderId, lineItemId),
          });
          await client.query("COMMIT");
        } finally {
          client.release();
        }

        // Retry should now succeed (negative stock allowed)
        const res = await request(app)
          .post(`/api/inventory/recipe-consumption-exceptions/${excId}/retry`)
          .set("x-test-owner", OWNER_ID);
        expect(res.status).toBe(200);
        expect(res.body.status).toBe("resolved");

        // Stock should be negative: 0 - 6 = -6
        const locRow = await pool.query<{ stock: string }>(
          `SELECT stock FROM base_item_location_statuses
            WHERE base_item_id = $1 AND location_id = $2`,
          [baseItemId, locationId],
        );
        expect(Number(locRow.rows[0].stock)).toBe(-6);

        // Restore flag
        await pool.query(
          `UPDATE workspace_settings SET inventory_allow_negative_stock = false
            WHERE workspace_owner_id = $1`,
          [OWNER_ID],
        );

        await pool.query(`DELETE FROM orders WHERE id = $1`, [orderId]);
      });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // F. Baseline + ledger-delta reconciliation
    // ─────────────────────────────────────────────────────────────────────────

    describe("F. Baseline + ledger-delta reconciliation", () => {
      it("F1: after retry, cached stock = cutover_balance + SUM(quantity_change)", async () => {
        await resetInventory(50);
        await addBaseline(50);

        const { orderId, lineItemId } = await createOrder({ useOrderLocation: true, orderedQty: 4 });

        // Create exception
        const idempKey = `pc:${orderId}:${lineItemId}:${baseItemId}:c0`;
        const client = await (routeDb as unknown as import("pg").Pool).connect();
        let excId: string;
        try {
          await client.query("BEGIN");
          excId = await upsertRecipeConsumptionException(client, {
            workspaceOwnerId: OWNER_ID,
            orderId,
            lineItemId,
            baseItemId,
            productId,
            locationId,
            reason: "MISSING_LEDGER_BASELINE",
            idempotencyKey: idempKey,
            sourceSnapshot: immutableRecipeSource(orderId, lineItemId, 4),
          });
          await client.query("COMMIT");
        } finally {
          client.release();
        }

        const retryRes = await request(app)
          .post(`/api/inventory/recipe-consumption-exceptions/${excId}/retry`)
          .set("x-test-owner", OWNER_ID);
        expect(retryRes.status).toBe(200);

        // Reconcile: cutover_balance + SUM(movements) should equal cached stock
        const baselineRow = await pool.query<{ cutover_balance: string }>(
          `SELECT cutover_balance FROM base_item_ledger_settings
            WHERE workspace_owner_id = $1 AND base_item_id = $2 AND location_id = $3`,
          [OWNER_ID, baseItemId, locationId],
        );
        const cutoverBalance = Number(baselineRow.rows[0].cutover_balance);

        const deltaRow = await pool.query<{ delta: string }>(
          `SELECT COALESCE(SUM(quantity_change), 0)::text AS delta
             FROM base_item_stock_adjustments
            WHERE workspace_owner_id = $1
              AND base_item_id = $2
              AND location_id = $3
              AND ledger_scope = 'base_item_operational'`,
          [OWNER_ID, baseItemId, locationId],
        );
        const delta = Number(deltaRow.rows[0].delta);

        const cachedStock = await pool.query<{ stock: string }>(
          `SELECT stock FROM base_item_location_statuses
            WHERE base_item_id = $1 AND location_id = $2`,
          [baseItemId, locationId],
        );
        const cached = Number(cachedStock.rows[0].stock);

        // cutover_balance (50) + delta (-12 for 4 ordered × 3 recipe) = 38
        expect(cutoverBalance + delta).toBe(cached);
        expect(cached).toBe(50 - 4 * 3); // 38

        await pool.query(`DELETE FROM orders WHERE id = $1`, [orderId]);
      });
    });

    describe("G. Fulfilment-cycle and corrected-recipe regressions", () => {
      it("G1: creates a fresh open exception for c1 after c0 was consumed and reversed", async () => {
        await resetInventory(50);
        const { orderId, lineItemId } = await createOrder({ useOrderLocation: true });

        const firstClient = await (routeDb as unknown as import("pg").Pool).connect();
        try {
          await firstClient.query("BEGIN");
          await postRecipeConsumption(firstClient, orderId, OWNER_ID, {
            fulfillmentCycle: 0,
          });
          await firstClient.query("COMMIT");
        } finally {
          firstClient.release();
        }
        const c0Exception = await pool.query<{ id: string }>(
          `SELECT id FROM recipe_consumption_exceptions
            WHERE workspace_owner_id = $1 AND idempotency_key = $2`,
          [OWNER_ID, `pc:${orderId}:${lineItemId}:${baseItemId}:c0`],
        );
        expect(c0Exception.rowCount).toBe(1);

        await addBaseline(50);
        const retry = await request(app)
          .post(`/api/inventory/recipe-consumption-exceptions/${c0Exception.rows[0].id}/retry`)
          .set("x-test-owner", OWNER_ID);
        expect(retry.status).toBe(200);

        const reversalClient = await (routeDb as unknown as import("pg").Pool).connect();
        try {
          await reversalClient.query("BEGIN");
          const reversed = await postCancellationReversal(
            reversalClient,
            orderId,
            OWNER_ID,
          );
          expect(reversed.movementIds).toHaveLength(1);
          await reversalClient.query("COMMIT");
        } finally {
          reversalClient.release();
        }

        await pool.query(
          `DELETE FROM base_item_ledger_settings
            WHERE workspace_owner_id = $1 AND base_item_id = $2 AND location_id = $3`,
          [OWNER_ID, baseItemId, locationId],
        );
        const secondClient = await (routeDb as unknown as import("pg").Pool).connect();
        try {
          await secondClient.query("BEGIN");
          await postRecipeConsumption(secondClient, orderId, OWNER_ID, {
            fulfillmentCycle: 1,
          });
          await secondClient.query("COMMIT");
        } finally {
          secondClient.release();
        }

        const exceptions = await pool.query<{ status: string; idempotency_key: string }>(
          `SELECT status, idempotency_key
             FROM recipe_consumption_exceptions
            WHERE workspace_owner_id = $1 AND order_id = $2
            ORDER BY idempotency_key`,
          [OWNER_ID, orderId],
        );
        expect(exceptions.rows).toEqual([
          {
            status: "resolved",
            idempotency_key: `pc:${orderId}:${lineItemId}:${baseItemId}:c0`,
          },
          {
            status: "open",
            idempotency_key: `pc:${orderId}:${lineItemId}:${baseItemId}:c1`,
          },
        ]);
        await pool.query(`DELETE FROM orders WHERE id = $1`, [orderId]);
      });

      it("G2: corrected missing recipe retries every ingredient using original ordered quantity", async () => {
        await resetInventory(50);
        await pool.query(`DELETE FROM product_recipes WHERE product_id = $1`, [productId]);
        const secondBase = await pool.query<{ id: number }>(
          `INSERT INTO base_items (workspace_owner_id, name, code, status, stock)
           VALUES ($1, 'RCE4316 Ribbon', $2, 'active', 50) RETURNING id`,
          [OWNER_ID, `RCE4316-${randomUUID()}`],
        );
        const secondBaseItemId = secondBase.rows[0].id;
        try {
          await pool.query(
            `INSERT INTO base_item_location_statuses
               (workspace_owner_id, base_item_id, location_id, is_active, stock)
             VALUES ($1, $2, $3, true, 50)`,
            [OWNER_ID, secondBaseItemId, locationId],
          );
          const { orderId, lineItemId } = await createOrder({
            useOrderLocation: true,
            orderedQty: 2,
          });
          const initialClient = await (routeDb as unknown as import("pg").Pool).connect();
          try {
            await initialClient.query("BEGIN");
            await postRecipeConsumption(initialClient, orderId, OWNER_ID, {
              fulfillmentCycle: 0,
            });
            await initialClient.query("COMMIT");
          } finally {
            initialClient.release();
          }
          const missingRecipe = await pool.query<{ id: string }>(
            `SELECT id FROM recipe_consumption_exceptions
              WHERE workspace_owner_id = $1
                AND idempotency_key = $2`,
            [OWNER_ID, `pc:${orderId}:${lineItemId}:no_base_item:c0`],
          );
          expect(missingRecipe.rowCount).toBe(1);

          await addBaseline(50);
          await pool.query(
            `INSERT INTO base_item_ledger_settings
               (workspace_owner_id, base_item_id, location_id, cutover_at,
                cutover_balance, verified_by_user_id, verification_reason, verified_at)
             VALUES ($1, $2, $3, now(), 50, $4, 'integration test', now())`,
            [OWNER_ID, secondBaseItemId, locationId, USER_ID],
          );
          await pool.query(
            `INSERT INTO product_recipes
               (workspace_owner_id, product_id, base_item_id, quantity)
             VALUES ($1, $2, $3, 3), ($1, $2, $4, 4)`,
            [OWNER_ID, productId, baseItemId, secondBaseItemId],
          );

          const retry = await request(app)
            .post(`/api/inventory/recipe-consumption-exceptions/${missingRecipe.rows[0].id}/retry`)
            .set("x-test-owner", OWNER_ID);
          expect(retry.status).toBe(200);
          expect(retry.body.movementIds).toHaveLength(2);
          const movements = await pool.query<{ base_item_id: number; quantity_change: string }>(
            `SELECT base_item_id, quantity_change::text
               FROM base_item_stock_adjustments
              WHERE workspace_owner_id = $1
                AND order_id = $2
                AND movement_type = 'product_consumption'
              ORDER BY base_item_id`,
            [OWNER_ID, orderId],
          );
          expect(
            movements.rows.map((row) => [
              row.base_item_id,
              Number(row.quantity_change),
            ]),
          ).toEqual(
            [
              [baseItemId, -6],
              [secondBaseItemId, -8],
            ].sort((a, b) => a[0] - b[0]),
          );
          await pool.query(`DELETE FROM orders WHERE id = $1`, [orderId]);
        } finally {
          await pool.query(`DELETE FROM base_item_stock_adjustments WHERE base_item_id = $1`, [secondBaseItemId]);
          await pool.query(`DELETE FROM base_item_ledger_settings WHERE base_item_id = $1`, [secondBaseItemId]);
          await pool.query(`DELETE FROM base_item_location_statuses WHERE base_item_id = $1`, [secondBaseItemId]);
          await pool.query(`DELETE FROM base_items WHERE id = $1`, [secondBaseItemId]);
          await pool.query(`DELETE FROM product_recipes WHERE product_id = $1`, [productId]);
          await pool.query(
            `INSERT INTO product_recipes (workspace_owner_id, product_id, base_item_id, quantity)
             VALUES ($1, $2, $3, 3)`,
            [OWNER_ID, productId, baseItemId],
          );
        }
      });
    });
  },
);
