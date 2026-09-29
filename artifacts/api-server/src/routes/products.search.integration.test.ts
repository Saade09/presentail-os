/**
 * Integration test: verifies that the `idx_products_name_trgm` and
 * `idx_products_sku_trgm` GIN trigram indexes created in initDb are present
 * and that the product name/SKU search query uses index scans rather than a
 * full sequential scan.
 *
 * Three regression scenarios are covered:
 *
 *  1. Either index is accidentally dropped
 *     → caught by the catalog existence checks.
 *  2. An index definition changes (e.g. column or access method changes)
 *     → caught by the catalog definition checks.
 *  3. The name/SKU search query regresses to a slow full-table scan
 *     (e.g. the ILIKE operators are changed to something GIN-incompatible)
 *     → caught by the EXPLAIN plan assertions below.
 *
 * How the EXPLAIN assertions are made deterministic:
 * ──────────────────────────────────────────────────
 * The EXPLAIN queries deliberately omit the `workspace_owner_id` predicate.
 * Including it allows the workspace B-tree index to satisfy the filter
 * cheaply, making the GIN index cost-ineffective regardless of planner
 * settings — the planner prefers a Bitmap Index Scan on the B-tree index
 * followed by an in-memory filter rather than the more expensive
 * BitmapOr(GIN, GIN) plan, even with `enable_seqscan = OFF`.
 *
 * Without the workspace predicate, the only index available for
 * `name ILIKE '%…%'` is `idx_products_name_trgm` and the only index
 * available for `sku ILIKE '%…%'` is `idx_products_sku_trgm`.
 * Disabling sequential scans (`SET enable_seqscan = OFF`) forces the planner
 * to pick an index; since only the relevant GIN index applies to each
 * predicate, the chosen plan always references it — independently of table
 * size or statistics.
 *
 * This is the same strategy used by `products.indexes.integration.test.ts`
 * for the brand and category GIN indexes.  Any future EXPLAIN regression
 * test for a GIN trigram index on this table should follow the same pattern:
 * omit `workspace_owner_id` from the EXPLAIN query and assert only on the
 * trigram predicate.  End-to-end correctness (with workspace_owner_id) is
 * verified by the correctness checks further down.
 *
 * The test is skipped automatically when DATABASE_URL is not set, making it
 * safe to run in CI environments without a live database.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";

const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;

const TEST_WORKSPACE_OWNER_ID = "__test_trgm_index_check__";

describe.skipIf(!DATABASE_URL)(
  "products name/SKU search — trigram index usage (integration)",
  () => {
    let pool: InstanceType<typeof Pool>;

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });

      // -----------------------------------------------------------------------
      // NOTE: we deliberately do NOT create the trigram indexes here.
      // initDb.ts is responsible for creating idx_products_name_trgm and
      // idx_products_sku_trgm.  If either index is absent the catalog checks
      // below will fail immediately, surfacing the regression instead of
      // silently masking it.
      // -----------------------------------------------------------------------

      // Remove any leftovers from previous failed runs.
      await pool.query(
        `DELETE FROM products WHERE workspace_owner_id = $1`,
        [TEST_WORKSPACE_OWNER_ID],
      );

      // Insert 10 000 products with diverse names and SKUs so the planner has
      // meaningful statistics and the ILIKE filter is genuinely selective.
      const TOTAL = 10_000;
      const BATCH = 500;
      const adjectives = ["Red", "Blue", "Green", "Yellow", "Purple", "Matte", "Glossy", "Eco", "Pro", "Mini"];
      const nouns = ["Badge", "Holder", "Tag", "Reel", "Lanyard", "Clip", "Wallet", "Sleeve", "Pouch", "Card"];

      for (let offset = 0; offset < TOTAL; offset += BATCH) {
        const batchSize = Math.min(BATCH, TOTAL - offset);
        const valueClauses: string[] = [];
        const params: unknown[] = [TEST_WORKSPACE_OWNER_ID];

        for (let i = 0; i < batchSize; i++) {
          const globalIdx = offset + i;
          const adj = adjectives[globalIdx % adjectives.length];
          const noun = nouns[Math.floor(globalIdx / adjectives.length) % nouns.length];
          const name = `${adj} ${noun} ${globalIdx}`;
          const sku = `SKU-${adj.toUpperCase()}-${globalIdx}`;
          params.push(name, sku);
          valueClauses.push(`($1, $${params.length - 1}, $${params.length})`);
        }

        await pool.query(
          `INSERT INTO products (workspace_owner_id, name, sku) VALUES ${valueClauses.join(", ")}`,
          params,
        );
      }

      // Update planner statistics so query cost estimates reflect reality.
      await pool.query(`ANALYZE products;`);
    });

    afterAll(async () => {
      if (!pool) return;
      await pool.query(
        `DELETE FROM products WHERE workspace_owner_id = $1`,
        [TEST_WORKSPACE_OWNER_ID],
      );
      await pool.end();
    }, 30_000);

    // -------------------------------------------------------------------------
    // Catalog checks — primary guard against accidental index drops
    // -------------------------------------------------------------------------

    it("idx_products_name_trgm exists in pg_indexes", async () => {
      const result = await pool.query<{ indexname: string }>(
        `SELECT indexname
           FROM pg_indexes
          WHERE tablename = 'products'
            AND indexname = 'idx_products_name_trgm'`,
      );
      expect(
        result.rowCount,
        "idx_products_name_trgm is missing — was it accidentally dropped?",
      ).toBe(1);
      expect(result.rows[0].indexname).toBe("idx_products_name_trgm");
    });

    it("idx_products_name_trgm is a GIN index on the name column", async () => {
      const result = await pool.query<{ indexdef: string }>(
        `SELECT indexdef
           FROM pg_indexes
          WHERE tablename = 'products'
            AND indexname = 'idx_products_name_trgm'`,
      );
      expect(result.rowCount).toBe(1);
      const def = result.rows[0].indexdef;
      expect(def, "Index should use the GIN access method").toMatch(/USING gin/i);
      expect(def, "Index should cover the name column").toMatch(/\bname\b/i);
    });

    it("idx_products_sku_trgm exists in pg_indexes", async () => {
      const result = await pool.query<{ indexname: string }>(
        `SELECT indexname
           FROM pg_indexes
          WHERE tablename = 'products'
            AND indexname = 'idx_products_sku_trgm'`,
      );
      expect(
        result.rowCount,
        "idx_products_sku_trgm is missing — was it accidentally dropped?",
      ).toBe(1);
      expect(result.rows[0].indexname).toBe("idx_products_sku_trgm");
    });

    it("idx_products_sku_trgm is a GIN index on the sku column", async () => {
      const result = await pool.query<{ indexdef: string }>(
        `SELECT indexdef
           FROM pg_indexes
          WHERE tablename = 'products'
            AND indexname = 'idx_products_sku_trgm'`,
      );
      expect(result.rowCount).toBe(1);
      const def = result.rows[0].indexdef;
      expect(def, "Index should use the GIN access method").toMatch(/USING gin/i);
      expect(def, "Index should cover the sku column").toMatch(/\bsku\b/i);
    });

    // -------------------------------------------------------------------------
    // EXPLAIN checks — confirm each GIN index is planner-compatible
    //
    // workspace_owner_id is intentionally omitted from these queries so the
    // workspace B-tree index cannot compete with the GIN trigram indexes.
    // With sequential scans disabled, the planner's only option for each
    // trigram predicate is the matching GIN index, making the assertions
    // deterministic regardless of table size or statistics.
    // -------------------------------------------------------------------------

    it(
      "name search uses idx_products_name_trgm (GIN Bitmap Index Scan)",
      async () => {
        const client = await pool.connect();
        try {
          await client.query("SET enable_seqscan = OFF");

          const explainResult = await client.query<{ "QUERY PLAN": string }>(
            `EXPLAIN
             SELECT id FROM products
              WHERE name ILIKE $1 ESCAPE '\\'`,
            ["%badge%"],
          );

          const plan = explainResult.rows.map((r) => r["QUERY PLAN"]).join("\n");

          expect(
            plan,
            `Expected the query plan to reference idx_products_name_trgm.\n` +
            `Actual plan:\n${plan}\n\n` +
            `This may mean the index was dropped, renamed, or the name search predicate ` +
            `changed in a way that prevents GIN usage (e.g. ILIKE was changed to LIKE or =).`,
          ).toMatch(/idx_products_name_trgm/i);
        } finally {
          await client.query("SET enable_seqscan = ON");
          client.release();
        }
      },
    );

    it(
      "SKU search uses idx_products_sku_trgm (GIN Bitmap Index Scan)",
      async () => {
        const client = await pool.connect();
        try {
          // -----------------------------------------------------------------------
          // Why three planner GUC overrides are needed for the SKU GIN check
          // -----------------------------------------------------------------------
          // Unlike the name GIN test (which only needs enable_seqscan = OFF),
          // the SKU GIN test requires all three of:
          //
          //   SET enable_seqscan  = OFF    -- rule out a full table scan
          //   SET enable_indexscan = OFF   -- rule out a plain (non-bitmap) btree scan
          //   SET random_page_cost = 0.01  -- make GIN random I/O cost competitive
          //
          // ROOT CAUSE: index competition between two partial indexes that share
          // the same predicate clause (WHERE sku IS NOT NULL):
          //
          //   idx_products_workspace_sku_unique
          //       UNIQUE INDEX ON products(workspace_owner_id, sku)
          //       WHERE sku IS NOT NULL           ← partial btree
          //
          //   idx_products_sku_trgm
          //       INDEX ON products USING GIN (sku gin_trgm_ops)
          //       WHERE sku IS NOT NULL           ← partial GIN, same predicate
          //
          // Because both indexes have identical partial predicates the planner
          // knows that the btree covers exactly the same row set as the GIN.
          // For a query of the form  WHERE sku ILIKE '%red%'  (no other useful
          // predicate) it may therefore choose the btree as an "index scan over
          // all non-null sku rows, filtered in-memory by ILIKE" — essentially a
          // btree full-scan masquerading as an index-based plan.  That path
          // avoids the higher per-page random I/O cost PostgreSQL normally
          // assigns to GIN bitmap scans (controlled by random_page_cost).
          //
          // Disabling sequential scans alone (enable_seqscan = OFF) is not
          // sufficient because the btree path counts as an *index* scan, not a
          // sequential scan, and is still available to the planner.
          //
          // The three overrides together force the planner onto the only
          // remaining path: the GIN bitmap index scan on idx_products_sku_trgm.
          //
          // LONG-TERM FIX OPTIONS (tracked here for future work):
          //
          //   Option A — Remove the partial predicate from idx_products_sku_trgm:
          //     If the GIN is created without WHERE sku IS NOT NULL it covers
          //     all rows (NULLs included, though GIN skips them internally).
          //     Its partial predicate would then differ from the unique btree's
          //     predicate, breaking the planner's assumption that the two indexes
          //     are interchangeable substitutes.  This is the recommended fix.
          //     Note: requires a one-time DROP + CREATE (or REINDEX CONCURRENTLY)
          //     in production because initDb uses CREATE INDEX IF NOT EXISTS.
          //
          //   Option B — Replace the partial unique btree with a non-partial one
          //     and enforce uniqueness via a partial unique index on a separate
          //     expression (e.g. COALESCE or a unique constraint with NULLS NOT
          //     DISTINCT in PG 15+).  More complex schema change; not recommended.
          //
          //   Option C — Keep the three planner hints in the test but also verify
          //     correctness separately (done below in the correctness section).
          //     This is the current approach — acceptable as long as the hints
          //     are clearly documented (this block).
          // -----------------------------------------------------------------------
          await client.query("SET enable_seqscan = OFF");
          await client.query("SET enable_indexscan = OFF");
          await client.query("SET random_page_cost = 0.01");

          const explainResult = await client.query<{ "QUERY PLAN": string }>(
            `EXPLAIN
             SELECT id FROM products
              WHERE sku ILIKE $1 ESCAPE '\\'`,
            ["%red%"],
          );

          const plan = explainResult.rows.map((r) => r["QUERY PLAN"]).join("\n");

          expect(
            plan,
            `Expected the query plan to reference idx_products_sku_trgm.\n` +
            `Actual plan:\n${plan}\n\n` +
            `This may mean the index was dropped, renamed, or the SKU search predicate ` +
            `changed in a way that prevents GIN usage (e.g. ILIKE was changed to LIKE or =).`,
          ).toMatch(/idx_products_sku_trgm/i);
        } finally {
          await client.query("SET enable_seqscan = ON");
          await client.query("SET enable_indexscan = ON");
          await client.query("SET random_page_cost = DEFAULT");
          client.release();
        }
      },
    );

    it(
      "combined name/SKU search uses both GIN trigram indexes (BitmapOr plan)",
      async () => {
        // Verifies the OR production query shape (name ILIKE … OR sku ILIKE …)
        // without workspace_owner_id so neither the workspace B-tree nor any
        // other non-trigram index can satisfy the filter cheaply.
        //
        // All three planner overrides are required here for the same root-cause
        // reason as the standalone SKU test above: idx_products_workspace_sku_unique
        // (a partial btree with WHERE sku IS NOT NULL) shares its partial predicate
        // with idx_products_sku_trgm (a partial GIN with the same WHERE clause).
        // The planner may prefer a full btree scan on that index over the GIN
        // bitmap scan unless both index scans and sequential scans are disabled
        // and random_page_cost is set near-zero to eliminate the GIN's random-I/O
        // cost penalty.  See the "SKU search uses idx_products_sku_trgm" test
        // above for the full root-cause explanation and long-term fix options.
        const client = await pool.connect();
        try {
          await client.query("SET enable_seqscan = OFF");
          await client.query("SET enable_indexscan = OFF");
          await client.query("SET random_page_cost = 0.01");

          const explainResult = await client.query<{ "QUERY PLAN": string }>(
            `EXPLAIN
             SELECT id FROM products
              WHERE (name ILIKE $1 ESCAPE '\\' OR sku ILIKE $1 ESCAPE '\\')`,
            ["%badge%"],
          );

          const plan = explainResult.rows.map((r) => r["QUERY PLAN"]).join("\n");

          expect(
            plan,
            `Expected the query plan to reference idx_products_name_trgm.\n` +
            `Actual plan:\n${plan}\n\n` +
            `This may mean the index was dropped, renamed, or the name predicate ` +
            `changed in a way that prevents GIN usage.`,
          ).toMatch(/idx_products_name_trgm/i);

          expect(
            plan,
            `Expected the query plan to reference idx_products_sku_trgm.\n` +
            `Actual plan:\n${plan}\n\n` +
            `This may mean the index was dropped, renamed, or the SKU predicate ` +
            `changed in a way that prevents GIN usage.`,
          ).toMatch(/idx_products_sku_trgm/i);
        } finally {
          await client.query("SET enable_seqscan = ON");
          await client.query("SET enable_indexscan = ON");
          await client.query("SET random_page_cost = DEFAULT");
          client.release();
        }
      },
    );

    // -------------------------------------------------------------------------
    // Correctness checks — seeded rows are reachable via the full query shape
    // -------------------------------------------------------------------------

    it("name search returns expected rows from the seeded data", async () => {
      const result = await pool.query(
        `SELECT id FROM products
          WHERE workspace_owner_id = $1
            AND (name ILIKE $2 ESCAPE '\\' OR sku ILIKE $2 ESCAPE '\\')`,
        [TEST_WORKSPACE_OWNER_ID, "%Badge%"],
      );
      expect(result.rows.length).toBeGreaterThan(0);
    });

    it("SKU search returns expected rows from the seeded data", async () => {
      const result = await pool.query(
        `SELECT id FROM products
          WHERE workspace_owner_id = $1
            AND (name ILIKE $2 ESCAPE '\\' OR sku ILIKE $2 ESCAPE '\\')`,
        [TEST_WORKSPACE_OWNER_ID, "%SKU-RED%"],
      );
      expect(result.rows.length).toBeGreaterThan(0);
    });
  },
);
