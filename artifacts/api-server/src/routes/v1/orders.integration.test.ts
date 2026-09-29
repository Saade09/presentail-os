/**
 * Real-database regression coverage for the legacy v1 order route.
 *
 * The v1 JSON contract still accepts external_product_id and total, while the
 * production order_line_items table stores those values in external_id and
 * line_total. Exercising the HTTP route against PostgreSQL prevents mocked
 * query tests from hiding future column-name drift.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import pg from "pg";
import ordersRouter from "./orders";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const OWNER_ID = `__v1_order_external_id_${Date.now()}`;

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/v1", ordersRouter);
  return app;
}

describe.skipIf(!DATABASE_URL)(
  "v1 POST /orders — legacy line-item IDs (real DB integration)",
  () => {
    let pool: InstanceType<typeof Pool>;

    async function cleanup(): Promise<void> {
      await pool.query(`DELETE FROM orders WHERE workspace_owner_id = $1`, [OWNER_ID]);
    }

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });

      await cleanup();
    });

    afterAll(async () => {
      if (!pool) return;
      await cleanup();
      await pool.end();
    });

    it("persists external_product_id in external_id and keeps the v1 response stable", async () => {
      const app = makeApp();
      const externalProductId = `legacy-product-${Date.now()}`;

      const response = await request(app)
        .post("/api/v1/orders")
        .send({
          workspace_owner_id: OWNER_ID,
          source: "legacy-v1-integration",
          external_order_id: `legacy-order-${Date.now()}`,
          line_items: [{
            external_product_id: externalProductId,
            name: "Legacy API bouquet",
            quantity: 2,
            unit_price: "42.50",
            total: "85.00",
          }],
        });

      expect(response.status).toBe(201);
      expect(response.body).toEqual({
        success: true,
        id: expect.any(String),
      });

      const stored = await pool.query<{
        external_id: string | null;
        line_total: string | null;
      }>(
        `SELECT external_id, line_total
           FROM order_line_items
          WHERE order_id = $1`,
        [response.body.id],
      );

      expect(stored.rows).toEqual([{
        external_id: externalProductId,
        line_total: "85.0000",
      }]);
    });
  },
);