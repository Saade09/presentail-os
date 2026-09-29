/**
 * Integration test: backfillLineItemProducts against a real PostgreSQL
 * database — verifies the raw UPDATE … FROM SQL (joins, lower() name match,
 * min(id) tie-break) actually runs and is idempotent.
 *
 * The suite skips automatically when DATABASE_URL is not set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;

const OWNER_ID = `__backfill_line_items_test_${Date.now()}`;

import { backfillLineItemProducts } from "./backfillLineItemProducts";

async function cleanup(pool: InstanceType<typeof Pool>): Promise<void> {
  await pool.query(`DELETE FROM orders WHERE workspace_owner_id = $1`, [OWNER_ID]);
  await pool.query(`DELETE FROM products WHERE workspace_owner_id = $1`, [OWNER_ID]);
}

describe.skipIf(!DATABASE_URL)("backfillLineItemProducts (integration)", () => {
  let pool: InstanceType<typeof Pool>;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await cleanup(pool);
  });

  afterAll(async () => {
    if (!pool) return;
    await cleanup(pool);
    await pool.end();
  });

  it("links legacy rows by sku, then name, and fills missing images", async () => {
    const product = await pool.query<{ id: number }>(
      `INSERT INTO products (workspace_owner_id, name, sku, main_image_url)
       VALUES ($1, 'Peony Bouquet', 'PEONY-1', '/objects/x/peony.jpg') RETURNING id`,
      [OWNER_ID],
    );
    const productId = product.rows[0]!.id;

    const order = await pool.query<{ id: string }>(
      `INSERT INTO orders (workspace_owner_id, source, status, ordered_at, totals)
       VALUES ($1, 'external', 'pending', now(), '{"total": 40}'::jsonb) RETURNING id`,
      [OWNER_ID],
    );
    const orderId = order.rows[0]!.id;

    // Legacy rows: (a) sku match, (b) case-insensitive name match,
    // (c) unmatched, (d) already linked but missing image.
    await pool.query(
      `INSERT INTO order_line_items (order_id, name, quantity, sku, product_id)
       VALUES ($1, 'Old Display Name', 1, 'PEONY-1', NULL),
              ($1, 'peony BOUQUET', 1, 'no-such-sku', NULL),
              ($1, 'Totally Unknown', 1, NULL, NULL),
              ($1, 'Linked No Image', 1, NULL, $2)`,
      [orderId, productId],
    );

    await backfillLineItemProducts();

    const rows = await pool.query<{
      name: string;
      product_id: number | null;
      image_url: string | null;
    }>(
      `SELECT name, product_id, image_url FROM order_line_items
        WHERE order_id = $1 ORDER BY name ASC`,
      [orderId],
    );
    const byName = new Map(rows.rows.map((r) => [r.name, r]));

    expect(byName.get("Old Display Name")).toMatchObject({
      product_id: productId,
      image_url: "/objects/x/peony.jpg",
    });
    expect(byName.get("peony BOUQUET")).toMatchObject({
      product_id: productId,
      image_url: "/objects/x/peony.jpg",
    });
    expect(byName.get("Totally Unknown")).toMatchObject({
      product_id: null,
      image_url: null,
    });
    expect(byName.get("Linked No Image")).toMatchObject({
      product_id: productId,
      image_url: "/objects/x/peony.jpg",
    });

    // Idempotent: a second run changes nothing.
    await backfillLineItemProducts();
    const again = await pool.query<{ product_id: number | null; image_url: string | null }>(
      `SELECT product_id, image_url FROM order_line_items WHERE order_id = $1 AND name = 'Totally Unknown'`,
      [orderId],
    );
    expect(again.rows[0]).toMatchObject({ product_id: null, image_url: null });
  });
});
