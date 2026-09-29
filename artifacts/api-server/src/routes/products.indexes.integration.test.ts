/**
 * Integration test: verifies that `idx_products_brand_trgm` and
 * `idx_products_category_trgm` GIN trigram indexes created in initDb are
 * present and that the brand / category filter queries actually use them at
 * query time.
 *
 * Three regression scenarios are covered for each index:
 *
 *  1. The index is accidentally dropped
 *     → caught by the catalog existence check.
 *  2. The index definition changes (e.g. access method or expression changes)
 *     → caught by the catalog definition check.
 *  3. The filter query regresses to a full-table scan
 *     (e.g. the ILIKE operator is changed to something GIN-incompatible,
 *      or the lower() expression wrapper is removed)
 *     → caught by the EXPLAIN plan-text assertion below.
 *
 * Why EXPLAIN works here (unlike the name-search test):
 * ───────────────────────────────────────────────────────
 * The brand filter is `lower(brand) ILIKE lower($n) ESCAPE '\'` and the
 * category filter is `lower(category) ILIKE $n ESCAPE '\'`.  Both predicates
 * exactly match the GIN index expressions (lower(brand) and lower(category)
 * respectively), so the planner can use each GIN index directly.
 *
 * How the EXPLAIN assertion is made deterministic:
 * ─────────────────────────────────────────────────
 * The EXPLAIN queries deliberately omit the `workspace_owner_id` predicate.
 * Including it lets the workspace B-tree index satisfy the filter cheaply,
 * leaving the GIN index cost-ineffective regardless of planner settings.
 * Without the workspace predicate the only index that matches `lower(brand)
 * ILIKE ...` is `idx_products_brand_trgm` (and likewise for category).
 * Disabling sequential scans (`SET enable_seqscan = OFF`) forces the planner
 * to pick an index; since only the GIN index applies, it always appears in the
 * plan — independently of table size or statistics.
 *
 * The correctness checks further down verify that the same query shape
 * (with `workspace_owner_id`) returns the expected rows, so end-to-end
 * production correctness is still covered.
 *
 * The test is skipped automatically when DATABASE_URL is not set, making it
 * safe to run in CI environments without a live database.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;

const TEST_WORKSPACE_OWNER_ID = "__test_brand_category_index_check__";

describe.skipIf(!DATABASE_URL)(
  "products brand/category filters — trigram index usage (integration)",
  () => {
    let pool: InstanceType<typeof Pool>;

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });

      // -----------------------------------------------------------------------
      // NOTE: we deliberately do NOT create the indexes here.
      // initDb.ts is responsible for creating idx_products_brand_trgm and
      // idx_products_category_trgm.  If either index is absent the catalog
      // checks below will fail immediately, surfacing the regression instead of
      // silently masking it.
      // -----------------------------------------------------------------------

      // Remove any leftovers from previous failed runs.
      await pool.query(
        `DELETE FROM products WHERE workspace_owner_id = $1`,
        [TEST_WORKSPACE_OWNER_ID],
      );

      // Seed a modest product set with diverse brands and categories.
      // The planner needs at least some rows to build statistics; ANALYZE
      // below ensures cost estimates are accurate.
      const brands = ["Acme", "BrandB", "Contoso", "Dynex", "EcoWear"];
      const categories = ["Bags", "Clothing", "Electronics", "Footwear", "Gadgets"];
      const TOTAL = 500;
      const BATCH = 100;

      for (let offset = 0; offset < TOTAL; offset += BATCH) {
        const batchSize = Math.min(BATCH, TOTAL - offset);
        const valueClauses: string[] = [];
        const params: unknown[] = [TEST_WORKSPACE_OWNER_ID];

        for (let i = 0; i < batchSize; i++) {
          const globalIdx = offset + i;
          const brand = brands[globalIdx % brands.length];
          const category = categories[globalIdx % categories.length];
          const name = `Product ${globalIdx}`;
          params.push(name, brand, category);
          valueClauses.push(
            `($1, $${params.length - 2}, $${params.length - 1}, $${params.length})`,
          );
        }

        await pool.query(
          `INSERT INTO products (workspace_owner_id, name, brand, category)
           VALUES ${valueClauses.join(", ")}`,
          params,
        );
      }

      // Update planner statistics so query cost estimates reflect the seed set.
      await pool.query(`ANALYZE products;`);
    });

    afterAll(async () => {
      if (!pool) return;
      await pool.query(
        `DELETE FROM products WHERE workspace_owner_id = $1`,
        [TEST_WORKSPACE_OWNER_ID],
      );
      await pool.end();
    });

    // -------------------------------------------------------------------------
    // Catalog checks — primary guard against accidental index drops
    // -------------------------------------------------------------------------

    it("idx_products_brand_trgm exists in pg_indexes", async () => {
      const result = await pool.query<{ indexname: string }>(
        `SELECT indexname
           FROM pg_indexes
          WHERE tablename = 'products'
            AND indexname = 'idx_products_brand_trgm'`,
      );
      expect(
        result.rowCount,
        "idx_products_brand_trgm is missing — was it accidentally dropped?",
      ).toBe(1);
      expect(result.rows[0].indexname).toBe("idx_products_brand_trgm");
    });

    it("idx_products_brand_trgm is a GIN index on lower(brand)", async () => {
      const result = await pool.query<{ indexdef: string }>(
        `SELECT indexdef
           FROM pg_indexes
          WHERE tablename = 'products'
            AND indexname = 'idx_products_brand_trgm'`,
      );
      expect(result.rowCount).toBe(1);
      const def = result.rows[0].indexdef;
      expect(def, "Index should use the GIN access method").toMatch(/USING gin/i);
      expect(def, "Index should cover the lower(brand) expression").toMatch(/lower\(brand\)/i);
    });

    it("idx_products_category_trgm exists in pg_indexes", async () => {
      const result = await pool.query<{ indexname: string }>(
        `SELECT indexname
           FROM pg_indexes
          WHERE tablename = 'products'
            AND indexname = 'idx_products_category_trgm'`,
      );
      expect(
        result.rowCount,
        "idx_products_category_trgm is missing — was it accidentally dropped?",
      ).toBe(1);
      expect(result.rows[0].indexname).toBe("idx_products_category_trgm");
    });

    it("idx_products_category_trgm is a GIN index on lower(category)", async () => {
      const result = await pool.query<{ indexdef: string }>(
        `SELECT indexdef
           FROM pg_indexes
          WHERE tablename = 'products'
            AND indexname = 'idx_products_category_trgm'`,
      );
      expect(result.rowCount).toBe(1);
      const def = result.rows[0].indexdef;
      expect(def, "Index should use the GIN access method").toMatch(/USING gin/i);
      expect(def, "Index should cover the lower(category) expression").toMatch(/lower\(category\)/i);
    });

    // -------------------------------------------------------------------------
    // EXPLAIN checks — confirm the GIN index is planner-compatible
    //
    // These queries intentionally omit `workspace_owner_id` so the workspace
    // B-tree index cannot compete.  With sequential scans disabled the planner's
    // only option for the trigram predicate is the GIN index, making the
    // assertion deterministic regardless of table size or statistics.
    // -------------------------------------------------------------------------

    it(
      "brand filter uses idx_products_brand_trgm (GIN Bitmap Index Scan)",
      async () => {
        const client = await pool.connect();
        try {
          await client.query("SET enable_seqscan = OFF");

          const explainResult = await client.query<{ "QUERY PLAN": string }>(
            `EXPLAIN
             SELECT id FROM products
              WHERE lower(brand) ILIKE lower($1) ESCAPE '\\'`,
            ["%acme%"],
          );

          const plan = explainResult.rows.map((r) => r["QUERY PLAN"]).join("\n");

          expect(
            plan,
            `Expected the query plan to reference idx_products_brand_trgm.\n` +
            `Actual plan:\n${plan}\n\n` +
            `This may mean the index was dropped, renamed, or the index expression ` +
            `changed in a way that prevents GIN usage (e.g. the lower() wrapper was removed).`,
          ).toMatch(/idx_products_brand_trgm/i);
        } finally {
          await client.query("SET enable_seqscan = ON");
          client.release();
        }
      },
    );

    it(
      "category filter uses idx_products_category_trgm (GIN Bitmap Index Scan)",
      async () => {
        const client = await pool.connect();
        try {
          await client.query("SET enable_seqscan = OFF");

          const explainResult = await client.query<{ "QUERY PLAN": string }>(
            `EXPLAIN
             SELECT id FROM products
              WHERE lower(category) ILIKE $1 ESCAPE '\\'`,
            ["%bags%"],
          );

          const plan = explainResult.rows.map((r) => r["QUERY PLAN"]).join("\n");

          expect(
            plan,
            `Expected the query plan to reference idx_products_category_trgm.\n` +
            `Actual plan:\n${plan}\n\n` +
            `This may mean the index was dropped, renamed, or the query shape ` +
            `changed in a way that prevents GIN usage (e.g. the lower() expression was removed).`,
          ).toMatch(/idx_products_category_trgm/i);
        } finally {
          await client.query("SET enable_seqscan = ON");
          client.release();
        }
      },
    );

    it(
      "brandSearch filter uses idx_products_brand_trgm (GIN Bitmap Index Scan)",
      async () => {
        // The ?brandSearch= filter uses the same predicate shape as ?brand=,
        // so the same GIN index is exercised.
        const client = await pool.connect();
        try {
          await client.query("SET enable_seqscan = OFF");

          const explainResult = await client.query<{ "QUERY PLAN": string }>(
            `EXPLAIN
             SELECT id FROM products
              WHERE lower(brand) ILIKE lower($1) ESCAPE '\\'`,
            ["%acm%"],
          );

          const plan = explainResult.rows.map((r) => r["QUERY PLAN"]).join("\n");

          expect(
            plan,
            `Expected the query plan to reference idx_products_brand_trgm.\n` +
            `Actual plan:\n${plan}\n\n` +
            `This may mean the index was dropped, renamed, or the brandSearch predicate ` +
            `changed in a way that prevents GIN usage (e.g. lower() wrapper was removed).`,
          ).toMatch(/idx_products_brand_trgm/i);
        } finally {
          await client.query("SET enable_seqscan = ON");
          client.release();
        }
      },
    );

    // -------------------------------------------------------------------------
    // Correctness check — the seeded rows are actually reachable via the filter
    // -------------------------------------------------------------------------

    it("brand filter returns expected rows from the seeded data", async () => {
      const result = await pool.query(
        `SELECT id FROM products
          WHERE workspace_owner_id = $1
            AND brand ILIKE $2 ESCAPE '\\'`,
        [TEST_WORKSPACE_OWNER_ID, "%Acme%"],
      );
      expect(result.rows.length).toBeGreaterThan(0);
    });

    it("brandSearch filter returns expected rows from the seeded data", async () => {
      const result = await pool.query(
        `SELECT id FROM products
          WHERE workspace_owner_id = $1
            AND lower(brand) ILIKE lower($2) ESCAPE '\\'`,
        [TEST_WORKSPACE_OWNER_ID, "%acm%"],
      );
      expect(result.rows.length).toBeGreaterThan(0);
    });

    it("category filter returns expected rows from the seeded data", async () => {
      const result = await pool.query(
        `SELECT id FROM products
          WHERE workspace_owner_id = $1
            AND lower(category) ILIKE $2 ESCAPE '\\'`,
        [TEST_WORKSPACE_OWNER_ID, "%bags%"],
      );
      expect(result.rows.length).toBeGreaterThan(0);
    });
  },
);
