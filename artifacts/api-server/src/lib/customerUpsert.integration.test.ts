/**
 * Integration tests: exercise upsertCustomerFromOrder and
 * recomputeCustomerAggregates against a real PostgreSQL database, including
 * the partial unique index on (workspace_owner_id, email) that makes
 * email-first matching idempotent.
 *
 * Skips automatically when DATABASE_URL is not set.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import pg from "pg";
import {
  upsertCustomerFromOrder,
  recomputeCustomerAggregates,
} from "./customerUpsert";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;

const TEST_WORKSPACE = `__cust_upsert_test_${Date.now()}`;
const TEST_STORE_URL = `https://cust-upsert-test-${Date.now()}.example.com`;

describe.skipIf(!DATABASE_URL)(
  "upsertCustomerFromOrder + recomputeCustomerAggregates — real DB (integration)",
  () => {
    let pool: InstanceType<typeof Pool>;

    beforeAll(async () => {
      pool = new Pool({ connectionString: DATABASE_URL });
    });

    afterAll(async () => {
      if (!pool) return;
      await pool.query(`DELETE FROM customers WHERE workspace_owner_id = $1`, [TEST_WORKSPACE]);
      await pool.end();
    });

    beforeEach(async () => {
      await pool.query(`DELETE FROM customers WHERE workspace_owner_id = $1`, [TEST_WORKSPACE]);
    });

    it("creates a new customer row when the email is not yet known", async () => {
      const id = await upsertCustomerFromOrder(TEST_WORKSPACE, {
        firstName: "Alice",
        lastName: "Smith",
        email: "alice@example.com",
        source: "manual",
      });

      expect(id).not.toBeNull();
      const r = await pool.query(
        `SELECT first_name, last_name, email, source FROM customers WHERE id = $1`,
        [id],
      );
      expect(r.rows[0]).toMatchObject({
        first_name: "Alice",
        last_name: "Smith",
        email: "alice@example.com",
        source: "manual",
      });
    });

    it("does NOT create a duplicate row when the same email recurs (case-insensitive)", async () => {
      const a = await upsertCustomerFromOrder(TEST_WORKSPACE, {
        email: "Repeat@Example.com",
        firstName: "First",
      });
      const b = await upsertCustomerFromOrder(TEST_WORKSPACE, {
        email: "  REPEAT@example.COM  ",
        firstName: "Should-Not-Overwrite",
        phone: "+15551112222",
      });

      expect(a).not.toBeNull();
      expect(b).toBe(a);

      const cnt = await pool.query<{ c: string }>(
        `SELECT COUNT(*)::text AS c FROM customers WHERE workspace_owner_id = $1`,
        [TEST_WORKSPACE],
      );
      expect(parseInt(cnt.rows[0].c, 10)).toBe(1);

      // The COALESCE in the upsert should preserve the existing first_name
      // and add the previously missing phone (normalized).
      const row = await pool.query<{ first_name: string; phone: string }>(
        `SELECT first_name, phone FROM customers WHERE id = $1`,
        [a],
      );
      expect(row.rows[0].first_name).toBe("First");
      expect(row.rows[0].phone).toBe("+15551112222");
    });

    it("normalizes mixed-case emails so 'X@Y.com' and 'x@y.com' resolve to the same row", async () => {
      const a = await upsertCustomerFromOrder(TEST_WORKSPACE, { email: "MiXeD@Case.IO" });
      const b = await upsertCustomerFromOrder(TEST_WORKSPACE, { email: "mixed@case.io" });
      expect(a).toBe(b);

      const r = await pool.query<{ email: string }>(
        `SELECT email FROM customers WHERE id = $1`,
        [a],
      );
      expect(r.rows[0].email).toBe("mixed@case.io");
    });

    it("phone-only fallback: matches by normalized phone when email is absent", async () => {
      const a = await upsertCustomerFromOrder(TEST_WORKSPACE, {
        firstName: "Phone",
        phone: "+971 50 123 4567",
      });
      const b = await upsertCustomerFromOrder(TEST_WORKSPACE, {
        // Different formatting, same digits — must dedupe.
        phone: "+971-50-123-4567",
      });
      const c = await upsertCustomerFromOrder(TEST_WORKSPACE, {
        phone: "(050) 123 4567", // different leading format → different normalization
      });

      expect(a).not.toBeNull();
      expect(b).toBe(a);
      // c normalizes to "0501234567" — different from "+971501234567",
      // so it's a different customer.
      expect(c).not.toBe(a);

      const stored = await pool.query<{ phone: string }>(
        `SELECT phone FROM customers WHERE id = $1`,
        [a],
      );
      expect(stored.rows[0].phone).toBe("+971501234567");
    });

    it("phone-only INSERT stores email as NULL (so partial unique index allows other phone-only rows)", async () => {
      const a = await upsertCustomerFromOrder(TEST_WORKSPACE, { phone: "5550000001" });
      const b = await upsertCustomerFromOrder(TEST_WORKSPACE, { phone: "5550000002" });
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(b).not.toBe(a);

      const rows = await pool.query<{ email: string | null }>(
        `SELECT email FROM customers WHERE workspace_owner_id = $1`,
        [TEST_WORKSPACE],
      );
      expect(rows.rows.every((r) => r.email === null)).toBe(true);
    });

    it("recomputeCustomerAggregates is a no-op", async () => {
      const customerId = await upsertCustomerFromOrder(TEST_WORKSPACE, {
        email: "noop@example.com",
      });
      expect(customerId).not.toBeNull();

      // Pre-seed some aggregate values.
      await pool.query(
        `UPDATE customers
            SET total_orders = 5, total_spent = 123.45, last_order_at = now()
          WHERE id = $1`,
        [customerId],
      );

      // No-op should not touch the values.
      await recomputeCustomerAggregates(customerId!);

      const r = await pool.query<{
        total_orders: number;
        total_spent: string;
        last_order_at: string | null;
      }>(
        `SELECT total_orders, total_spent, last_order_at
           FROM customers WHERE id = $1`,
        [customerId],
      );
      expect(r.rows[0].total_orders).toBe(5);
      expect(parseFloat(r.rows[0].total_spent)).toBe(123.45);
      expect(r.rows[0].last_order_at).not.toBeNull();
    });
  },
);
