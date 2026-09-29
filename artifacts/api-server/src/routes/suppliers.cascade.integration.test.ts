/**
 * Integration test: verifies that deleting a supplier row automatically
 * removes all referencing supplier_documents, supplier_invoices, and
 * purchase_orders rows (plus their line items) via ON DELETE CASCADE.
 *
 * All three FK constraints are defined in lib/db/src/schema/suppliers.ts:
 *   supplier_documents.supplier_id  → suppliers.id  ON DELETE CASCADE
 *   supplier_invoices.supplier_id   → suppliers.id  ON DELETE CASCADE
 *   purchase_orders.supplier_id     → suppliers.id  ON DELETE CASCADE
 *
 * purchase_order_line_items.purchase_order_id → purchase_orders.id
 * ON DELETE CASCADE is also exercised here to ensure the cascade chain
 * propagates fully.
 *
 * The suite skips automatically when DATABASE_URL is not set.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;

const OWNER_ID = "__cascade_test_supplier_owner__";

describe.skipIf(!DATABASE_URL)(
  "supplier ON DELETE CASCADE — real database (integration)",
  () => {
    let pool: InstanceType<typeof Pool>;

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });
      await cleanUp(pool);
    });

    afterAll(async () => {
      if (!pool) return;
      await cleanUp(pool);
      await pool.end();
    });

    // ─────────────────────────────────────────────────────────────────────
    // supplier_documents cascade
    // ─────────────────────────────────────────────────────────────────────

    it("deleting a supplier removes its supplier_documents", async () => {
      const { rows } = await pool.query<{ id: number }>(
        `INSERT INTO suppliers (workspace_owner_id, name)
         VALUES ($1, 'Cascade Doc Supplier') RETURNING id`,
        [OWNER_ID],
      );
      const supplierId = rows[0].id;

      await pool.query(
        `INSERT INTO supplier_documents (supplier_id, workspace_owner_id, file_name, file_url)
         VALUES ($1, $2, 'invoice.pdf', 'https://example.com/invoice.pdf'),
                ($1, $2, 'contract.pdf', 'https://example.com/contract.pdf')`,
        [supplierId, OWNER_ID],
      );

      const before = await pool.query<{ count: string }>(
        `SELECT count(*) AS count FROM supplier_documents WHERE supplier_id = $1`,
        [supplierId],
      );
      expect(
        parseInt(before.rows[0].count, 10),
        "two supplier_documents rows must exist before deletion",
      ).toBe(2);

      await pool.query(`DELETE FROM suppliers WHERE id = $1`, [supplierId]);

      const after = await pool.query<{ count: string }>(
        `SELECT count(*) AS count FROM supplier_documents WHERE supplier_id = $1`,
        [supplierId],
      );
      expect(
        parseInt(after.rows[0].count, 10),
        "supplier_documents rows must be removed by ON DELETE CASCADE",
      ).toBe(0);
    });

    // ─────────────────────────────────────────────────────────────────────
    // supplier_invoices cascade
    // ─────────────────────────────────────────────────────────────────────

    it("deleting a supplier removes its supplier_invoices", async () => {
      const { rows } = await pool.query<{ id: number }>(
        `INSERT INTO suppliers (workspace_owner_id, name)
         VALUES ($1, 'Cascade Invoice Supplier') RETURNING id`,
        [OWNER_ID],
      );
      const supplierId = rows[0].id;

      await pool.query(
        `INSERT INTO supplier_invoices
           (supplier_id, workspace_owner_id, amount, currency, status)
         VALUES
           ($1, $2, 500, 'AED', 'issued'),
           ($1, $2, 250, 'AED', 'paid'),
           ($1, $2,  75, 'AED', 'cancelled')`,
        [supplierId, OWNER_ID],
      );

      const before = await pool.query<{ count: string }>(
        `SELECT count(*) AS count FROM supplier_invoices WHERE supplier_id = $1`,
        [supplierId],
      );
      expect(
        parseInt(before.rows[0].count, 10),
        "three supplier_invoices rows must exist before deletion",
      ).toBe(3);

      await pool.query(`DELETE FROM suppliers WHERE id = $1`, [supplierId]);

      const after = await pool.query<{ count: string }>(
        `SELECT count(*) AS count FROM supplier_invoices WHERE supplier_id = $1`,
        [supplierId],
      );
      expect(
        parseInt(after.rows[0].count, 10),
        "supplier_invoices rows must be removed by ON DELETE CASCADE",
      ).toBe(0);
    });

    // ─────────────────────────────────────────────────────────────────────
    // purchase_orders cascade
    // ─────────────────────────────────────────────────────────────────────

    it("deleting a supplier removes its purchase_orders", async () => {
      const { rows } = await pool.query<{ id: number }>(
        `INSERT INTO suppliers (workspace_owner_id, name)
         VALUES ($1, 'Cascade PO Supplier') RETURNING id`,
        [OWNER_ID],
      );
      const supplierId = rows[0].id;

      await pool.query(
        `INSERT INTO purchase_orders (workspace_owner_id, supplier_id, status)
         VALUES ($1, $2, 'draft'),
                ($1, $2, 'sent')`,
        [OWNER_ID, supplierId],
      );

      const before = await pool.query<{ count: string }>(
        `SELECT count(*) AS count FROM purchase_orders WHERE supplier_id = $1`,
        [supplierId],
      );
      expect(
        parseInt(before.rows[0].count, 10),
        "two purchase_orders rows must exist before deletion",
      ).toBe(2);

      await pool.query(`DELETE FROM suppliers WHERE id = $1`, [supplierId]);

      const after = await pool.query<{ count: string }>(
        `SELECT count(*) AS count FROM purchase_orders WHERE supplier_id = $1`,
        [supplierId],
      );
      expect(
        parseInt(after.rows[0].count, 10),
        "purchase_orders rows must be removed by ON DELETE CASCADE",
      ).toBe(0);
    });

    // ─────────────────────────────────────────────────────────────────────
    // purchase_order_line_items cascade chain
    // ─────────────────────────────────────────────────────────────────────

    it("deleting a supplier also removes purchase_order_line_items via cascade chain", async () => {
      const { rows } = await pool.query<{ id: number }>(
        `INSERT INTO suppliers (workspace_owner_id, name)
         VALUES ($1, 'Cascade LineItems Supplier') RETURNING id`,
        [OWNER_ID],
      );
      const supplierId = rows[0].id;

      const poResult = await pool.query<{ id: number }>(
        `INSERT INTO purchase_orders (workspace_owner_id, supplier_id, status)
         VALUES ($1, $2, 'draft') RETURNING id`,
        [OWNER_ID, supplierId],
      );
      const poId = poResult.rows[0].id;

      await pool.query(
        `INSERT INTO purchase_order_line_items
           (purchase_order_id, description, quantity, unit_price, currency)
         VALUES
           ($1, 'Widget A', 10, 5.00, 'AED'),
           ($1, 'Widget B',  5, 12.50, 'AED')`,
        [poId],
      );

      const beforeItems = await pool.query<{ count: string }>(
        `SELECT count(*) AS count FROM purchase_order_line_items
          WHERE purchase_order_id = $1`,
        [poId],
      );
      expect(
        parseInt(beforeItems.rows[0].count, 10),
        "two line_items rows must exist before deletion",
      ).toBe(2);

      await pool.query(`DELETE FROM suppliers WHERE id = $1`, [supplierId]);

      const afterItems = await pool.query<{ count: string }>(
        `SELECT count(*) AS count FROM purchase_order_line_items
          WHERE purchase_order_id = $1`,
        [poId],
      );
      expect(
        parseInt(afterItems.rows[0].count, 10),
        "purchase_order_line_items must be removed via cascading deletes (supplier→PO→line items)",
      ).toBe(0);
    });

    // ─────────────────────────────────────────────────────────────────────
    // All related tables deleted together
    // ─────────────────────────────────────────────────────────────────────

    it("deleting a supplier removes documents, invoices, and purchase orders in one shot", async () => {
      const { rows } = await pool.query<{ id: number }>(
        `INSERT INTO suppliers (workspace_owner_id, name)
         VALUES ($1, 'Cascade All Supplier') RETURNING id`,
        [OWNER_ID],
      );
      const supplierId = rows[0].id;

      await pool.query(
        `INSERT INTO supplier_documents (supplier_id, workspace_owner_id, file_name, file_url)
         VALUES ($1, $2, 'doc.pdf', 'https://example.com/doc.pdf')`,
        [supplierId, OWNER_ID],
      );
      await pool.query(
        `INSERT INTO supplier_invoices
           (supplier_id, workspace_owner_id, amount, currency, status)
         VALUES ($1, $2, 1000, 'AED', 'issued')`,
        [supplierId, OWNER_ID],
      );
      await pool.query(
        `INSERT INTO purchase_orders (workspace_owner_id, supplier_id, status)
         VALUES ($1, $2, 'draft')`,
        [OWNER_ID, supplierId],
      );

      await pool.query(`DELETE FROM suppliers WHERE id = $1`, [supplierId]);

      const docCount = await pool.query<{ count: string }>(
        `SELECT count(*) AS count FROM supplier_documents WHERE supplier_id = $1`,
        [supplierId],
      );
      const invCount = await pool.query<{ count: string }>(
        `SELECT count(*) AS count FROM supplier_invoices WHERE supplier_id = $1`,
        [supplierId],
      );
      const poCount = await pool.query<{ count: string }>(
        `SELECT count(*) AS count FROM purchase_orders WHERE supplier_id = $1`,
        [supplierId],
      );

      expect(
        parseInt(docCount.rows[0].count, 10),
        "supplier_documents must be 0 after cascade delete",
      ).toBe(0);
      expect(
        parseInt(invCount.rows[0].count, 10),
        "supplier_invoices must be 0 after cascade delete",
      ).toBe(0);
      expect(
        parseInt(poCount.rows[0].count, 10),
        "purchase_orders must be 0 after cascade delete",
      ).toBe(0);
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Archive-preservation tests
// Confirms that soft-archiving a supplier (is_archived = true) does NOT
// remove or hide its linked invoices, purchase orders, or line items.
// ─────────────────────────────────────────────────────────────────────────────

const ARCHIVE_OWNER_ID = "__archive_test_supplier_owner__";

describe.skipIf(!DATABASE_URL)(
  "archived supplier — purchase history is preserved (integration)",
  () => {
    let pool: InstanceType<typeof Pool>;

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });
      await cleanUpArchive(pool);
    });

    afterAll(async () => {
      if (!pool) return;
      await cleanUpArchive(pool);
      await pool.end();
    });

    it("archiving a supplier keeps its supplier_invoices rows intact", async () => {
      const { rows } = await pool.query<{ id: number }>(
        `INSERT INTO suppliers (workspace_owner_id, name)
         VALUES ($1, 'Archive Invoice Supplier') RETURNING id`,
        [ARCHIVE_OWNER_ID],
      );
      const supplierId = rows[0].id;

      await pool.query(
        `INSERT INTO supplier_invoices
           (supplier_id, workspace_owner_id, amount, currency, status, issued_at)
         VALUES
           ($1, $2, 1200, 'AED', 'paid',   NOW() - INTERVAL '2 months'),
           ($1, $2,  300, 'AED', 'issued', NOW() - INTERVAL '1 month'),
           ($1, $2,   50, 'AED', 'cancelled', NOW())`,
        [supplierId, ARCHIVE_OWNER_ID],
      );

      await pool.query(
        `UPDATE suppliers SET is_archived = true WHERE id = $1`,
        [supplierId],
      );

      const invCount = await pool.query<{ count: string }>(
        `SELECT count(*) AS count FROM supplier_invoices WHERE supplier_id = $1`,
        [supplierId],
      );
      expect(
        parseInt(invCount.rows[0].count, 10),
        "all three supplier_invoices rows must still exist after archiving",
      ).toBe(3);
    });

    it("archiving a supplier keeps its purchase_orders and line_items intact", async () => {
      const { rows } = await pool.query<{ id: number }>(
        `INSERT INTO suppliers (workspace_owner_id, name)
         VALUES ($1, 'Archive PO Supplier') RETURNING id`,
        [ARCHIVE_OWNER_ID],
      );
      const supplierId = rows[0].id;

      const poResult = await pool.query<{ id: number }>(
        `INSERT INTO purchase_orders (workspace_owner_id, supplier_id, status)
         VALUES ($1, $2, 'received'),
                ($1, $2, 'sent')
         RETURNING id`,
        [ARCHIVE_OWNER_ID, supplierId],
      );
      const poId = poResult.rows[0].id;

      await pool.query(
        `INSERT INTO purchase_order_line_items
           (purchase_order_id, description, quantity, unit_price, currency)
         VALUES
           ($1, 'Item Alpha', 5, 20.00, 'AED'),
           ($1, 'Item Beta',  2, 75.00, 'AED')`,
        [poId],
      );

      await pool.query(
        `UPDATE suppliers SET is_archived = true WHERE id = $1`,
        [supplierId],
      );

      const poCount = await pool.query<{ count: string }>(
        `SELECT count(*) AS count FROM purchase_orders WHERE supplier_id = $1`,
        [supplierId],
      );
      expect(
        parseInt(poCount.rows[0].count, 10),
        "both purchase_orders rows must still exist after archiving",
      ).toBe(2);

      const lineCount = await pool.query<{ count: string }>(
        `SELECT count(*) AS count FROM purchase_order_line_items
          WHERE purchase_order_id = $1`,
        [poId],
      );
      expect(
        parseInt(lineCount.rows[0].count, 10),
        "both purchase_order_line_items rows must still exist after archiving",
      ).toBe(2);
    });

    it("spend-trend query returns correct totals for an archived supplier", async () => {
      const { rows } = await pool.query<{ id: number }>(
        `INSERT INTO suppliers (workspace_owner_id, name, currency_pref)
         VALUES ($1, 'Archive SpendTrend Supplier', 'AED') RETURNING id`,
        [ARCHIVE_OWNER_ID],
      );
      const supplierId = rows[0].id;

      const currentYear = new Date().getFullYear();

      await pool.query(
        `INSERT INTO supplier_invoices
           (supplier_id, workspace_owner_id, amount, currency, status, issued_at)
         VALUES
           ($1, $2, 1000, 'AED', 'paid',      make_timestamptz($3, 1, 15, 0, 0, 0)),
           ($1, $2,  500, 'AED', 'paid',      make_timestamptz($3, 3, 10, 0, 0, 0)),
           ($1, $2,  200, 'AED', 'cancelled', make_timestamptz($3, 3, 20, 0, 0, 0))`,
        [supplierId, ARCHIVE_OWNER_ID, currentYear],
      );

      await pool.query(
        `UPDATE suppliers SET is_archived = true WHERE id = $1`,
        [supplierId],
      );

      const supplierCheck = await pool.query<{ id: number }>(
        `SELECT id FROM suppliers WHERE id = $1 AND workspace_owner_id = $2`,
        [supplierId, ARCHIVE_OWNER_ID],
      );
      expect(
        supplierCheck.rowCount,
        "archived supplier must still be findable by id + workspace_owner_id (no is_archived filter)",
      ).toBe(1);

      const spendResult = await pool.query<{ month: number; total: string }>(
        `SELECT
           EXTRACT(MONTH FROM issued_at)::int AS month,
           COALESCE(SUM(CASE WHEN status <> 'cancelled' THEN amount ELSE 0 END), 0)::text AS total
         FROM supplier_invoices
         WHERE supplier_id = $1
           AND workspace_owner_id = $2
           AND EXTRACT(YEAR FROM issued_at) = $3
         GROUP BY month
         ORDER BY month`,
        [supplierId, ARCHIVE_OWNER_ID, currentYear],
      );

      expect(spendResult.rows.length, "two non-empty months must be returned").toBe(2);

      const jan = spendResult.rows.find((r) => r.month === 1);
      expect(jan, "January row must exist").toBeDefined();
      expect(parseFloat(jan!.total)).toBe(1000);

      const mar = spendResult.rows.find((r) => r.month === 3);
      expect(mar, "March row must exist").toBeDefined();
      expect(
        parseFloat(mar!.total),
        "cancelled invoice must be excluded from March total",
      ).toBe(500);
    });

    it("archiving preserves all related data simultaneously (invoices + POs + line items)", async () => {
      const { rows } = await pool.query<{ id: number }>(
        `INSERT INTO suppliers (workspace_owner_id, name)
         VALUES ($1, 'Archive All Supplier') RETURNING id`,
        [ARCHIVE_OWNER_ID],
      );
      const supplierId = rows[0].id;

      await pool.query(
        `INSERT INTO supplier_documents (supplier_id, workspace_owner_id, file_name, file_url)
         VALUES ($1, $2, 'contract.pdf', 'https://example.com/contract.pdf')`,
        [supplierId, ARCHIVE_OWNER_ID],
      );
      await pool.query(
        `INSERT INTO supplier_invoices
           (supplier_id, workspace_owner_id, amount, currency, status)
         VALUES ($1, $2, 750, 'AED', 'paid'),
                ($1, $2, 250, 'AED', 'issued')`,
        [supplierId, ARCHIVE_OWNER_ID],
      );
      const poResult = await pool.query<{ id: number }>(
        `INSERT INTO purchase_orders (workspace_owner_id, supplier_id, status)
         VALUES ($1, $2, 'received') RETURNING id`,
        [ARCHIVE_OWNER_ID, supplierId],
      );
      const poId = poResult.rows[0].id;
      await pool.query(
        `INSERT INTO purchase_order_line_items
           (purchase_order_id, description, quantity, unit_price, currency)
         VALUES ($1, 'Bulk Widget', 100, 3.50, 'AED')`,
        [poId],
      );

      await pool.query(
        `UPDATE suppliers SET is_archived = true WHERE id = $1`,
        [supplierId],
      );

      const [docCount, invCount, poCount, lineCount] = await Promise.all([
        pool.query<{ count: string }>(
          `SELECT count(*) AS count FROM supplier_documents WHERE supplier_id = $1`,
          [supplierId],
        ),
        pool.query<{ count: string }>(
          `SELECT count(*) AS count FROM supplier_invoices WHERE supplier_id = $1`,
          [supplierId],
        ),
        pool.query<{ count: string }>(
          `SELECT count(*) AS count FROM purchase_orders WHERE supplier_id = $1`,
          [supplierId],
        ),
        pool.query<{ count: string }>(
          `SELECT count(*) AS count FROM purchase_order_line_items WHERE purchase_order_id = $1`,
          [poId],
        ),
      ]);

      expect(
        parseInt(docCount.rows[0].count, 10),
        "supplier_documents must survive archiving",
      ).toBe(1);
      expect(
        parseInt(invCount.rows[0].count, 10),
        "supplier_invoices must survive archiving",
      ).toBe(2);
      expect(
        parseInt(poCount.rows[0].count, 10),
        "purchase_orders must survive archiving",
      ).toBe(1);
      expect(
        parseInt(lineCount.rows[0].count, 10),
        "purchase_order_line_items must survive archiving",
      ).toBe(1);
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Shared cleanup helpers
// ─────────────────────────────────────────────────────────────────────────────

async function cleanUp(pool: InstanceType<typeof Pool>): Promise<void> {
  await pool.query(
    `DELETE FROM suppliers WHERE workspace_owner_id = $1`,
    [OWNER_ID],
  );
}

async function cleanUpArchive(pool: InstanceType<typeof Pool>): Promise<void> {
  await pool.query(
    `DELETE FROM suppliers WHERE workspace_owner_id = $1`,
    [ARCHIVE_OWNER_ID],
  );
}
