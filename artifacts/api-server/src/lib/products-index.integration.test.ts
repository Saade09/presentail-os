/**
 * Integration smoke test: verifies that PostgreSQL uses the
 * idx_products_workspace_status index when a status filter is applied
 * to the products table under **default** planner settings.
 *
 * Why the data shape matters:
 *   We insert 2 000 rows for a synthetic workspace where only ONE row
 *   carries the rare status we query for (~0.05 % selectivity).  After
 *   ANALYZE the planner can see that the composite index
 *   (workspace_owner_id, status) is far cheaper than the single-column
 *   idx_products_workspace (which would scan all 2 000 workspace rows
 *   and then filter).  No planner GUCs are tweaked — the test reflects
 *   real production behaviour.
 *
 * What this catches:
 *   - Index is dropped or renamed (catalog check fails first).
 *   - Index is marked invalid (planner cannot use it; plan changes).
 *   - Planner statistics are so stale that it falls back to a seq scan.
 *
 * This test requires DATABASE_URL to be set; it is skipped otherwise.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";

const { Client } = pg;

const TEST_WORKSPACE_ID = `test-idx-smoke-${Date.now()}`;
const RARE_STATUS = `rare_${Date.now()}`;
const ROW_COUNT = 2_000;

const describeSuite = process.env.DATABASE_URL
  ? describe
  : describe.skip;

describeSuite("idx_products_workspace_status query-plan smoke test", () => {
  let client: InstanceType<typeof Client>;

  beforeAll(async () => {
    client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();

    await client.query(
      `INSERT INTO products
         (workspace_owner_id, name, price_usd, price_aed, status)
       SELECT $1,
              'Smoke-test product ' || g,
              1.00, 3.67,
              CASE WHEN g = 1 THEN $2 ELSE 'available' END
         FROM generate_series(1, $3) g`,
      [TEST_WORKSPACE_ID, RARE_STATUS, ROW_COUNT],
    );

    await client.query(`ANALYZE products`);
  });

  afterAll(async () => {
    if (!client) return;

    await client.query(
      `DELETE FROM products WHERE workspace_owner_id = $1`,
      [TEST_WORKSPACE_ID],
    );

    await client.end();
  });

  it("idx_products_workspace_status exists in the database catalog", async () => {
    const result = await client.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef
         FROM pg_indexes
        WHERE tablename = 'products'
          AND indexname = 'idx_products_workspace_status'`,
    );

    expect(
      result.rows,
      "idx_products_workspace_status is missing from pg_indexes — " +
        "check that initDb.ts has been applied to this database.",
    ).toHaveLength(1);

    expect(result.rows[0].indexdef).toMatch(/workspace_owner_id/);
    expect(result.rows[0].indexdef).toMatch(/status/);
  });

  it("uses idx_products_workspace_status for a status-filtered products query (default planner settings)", async () => {
    const result = await client.query<{ "QUERY PLAN": string }>(
      `EXPLAIN (ANALYZE, FORMAT TEXT)
       SELECT id, workspace_owner_id, name, price_usd, price_aed,
              main_image_url, additional_image_urls, description,
              status, brand, tags, category, sku, created_at
         FROM products
        WHERE workspace_owner_id = $1
          AND status IN ($2)
        ORDER BY created_at DESC`,
      [TEST_WORKSPACE_ID, RARE_STATUS],
    );

    const planText = result.rows.map((r) => r["QUERY PLAN"]).join("\n");

    expect(
      planText,
      `Expected query plan to use idx_products_workspace_status.\nFull plan:\n${planText}`,
    ).toMatch(/idx_products_workspace_status/);

    expect(
      planText,
      `Expected an Index Scan node in the query plan.\nFull plan:\n${planText}`,
    ).toMatch(/Index(?:\s+Only)?\s+Scan/i);

    expect(
      planText,
      `Expected no top-level sequential scan on products.\nFull plan:\n${planText}`,
    ).not.toMatch(/^Seq Scan on products/m);
  });
});
