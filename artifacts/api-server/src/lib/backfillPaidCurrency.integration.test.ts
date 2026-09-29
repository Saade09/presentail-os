/**
 * Integration test: backfillPaidCurrencyAmounts against a real PostgreSQL
 * database — verifies the raw SQL (column names, jsonb operators, numeric
 * casts) actually runs, since unit tests only exercise mocked queries.
 *
 * The suite skips automatically when DATABASE_URL is not set.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;

const OWNER_ID = `__backfill_paid_currency_test_${Date.now()}`;

import { backfillPaidCurrencyAmounts } from "./backfillPaidCurrency";

async function cleanup(pool: InstanceType<typeof Pool>): Promise<void> {
  await pool.query(`DELETE FROM orders WHERE workspace_owner_id = $1`, [OWNER_ID]);
}

describe.skipIf(!DATABASE_URL)("backfillPaidCurrencyAmounts (integration)", () => {
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

  it("repairs a legacy non-USD order and leaves USD orders untouched", async () => {
    // Legacy CHF order: totals JSON has only USD figures; order_payment has
    // the foreign currency code but no paid-currency amount.
    const chfOrder = await pool.query<{ id: string }>(
      `INSERT INTO orders (workspace_owner_id, status, totals, raw_payload)
       VALUES ($1, 'pending',
               '{"subtotal": 60, "shipping": 12, "total": 72, "currency": "USD"}'::jsonb,
               '{"payment": {"method": "stripe", "totalUsd": 72, "totalAmount": 70, "currencyCode": "CHF"}}'::jsonb)
       RETURNING id`,
      [OWNER_ID],
    );
    const chfOrderId = chfOrder.rows[0]!.id;
    await pool.query(
      `INSERT INTO order_payment (order_id, method, status, currency, amount_usd)
       VALUES ($1, 'stripe', 'paid', 'CHF', 72)`,
      [chfOrderId],
    );

    // USD order: must not be touched by the backfill.
    const usdOrder = await pool.query<{ id: string }>(
      `INSERT INTO orders (workspace_owner_id, status, totals, raw_payload)
       VALUES ($1, 'pending',
               '{"total": 105, "currency": "USD"}'::jsonb,
               '{"payment": {"method": "stripe", "totalUsd": 105, "totalAmount": 105, "currencyCode": "USD"}}'::jsonb)
       RETURNING id`,
      [OWNER_ID],
    );
    const usdOrderId = usdOrder.rows[0]!.id;
    await pool.query(
      `INSERT INTO order_payment (order_id, method, status, currency, amount_usd)
       VALUES ($1, 'stripe', 'paid', 'USD', 105)`,
      [usdOrderId],
    );

    await backfillPaidCurrencyAmounts();

    const chfTotals = await pool.query<{
      totals: Record<string, unknown>;
      amount: string | null;
    }>(
      `SELECT o.totals, p.amount
         FROM orders o JOIN order_payment p ON p.order_id = o.id
        WHERE o.id = $1`,
      [chfOrderId],
    );
    const totals = chfTotals.rows[0]!.totals;
    // Paid pair merged in; USD figures untouched.
    expect(Number(totals.paid_total)).toBe(70);
    expect(totals.paid_currency).toBe("CHF");
    expect(Number(totals.total)).toBe(72);
    expect(Number(chfTotals.rows[0]!.amount)).toBe(70);

    const usdRow = await pool.query<{
      totals: Record<string, unknown>;
      amount: string | null;
    }>(
      `SELECT o.totals, p.amount
         FROM orders o JOIN order_payment p ON p.order_id = o.id
        WHERE o.id = $1`,
      [usdOrderId],
    );
    expect(usdRow.rows[0]!.totals.paid_total).toBeUndefined();
    expect(usdRow.rows[0]!.totals.paid_currency).toBeUndefined();
    expect(usdRow.rows[0]!.amount).toBeNull();

    // Idempotent: a second run changes nothing (the WHERE clause excludes it).
    await backfillPaidCurrencyAmounts();
    const again = await pool.query<{ totals: Record<string, unknown> }>(
      `SELECT totals FROM orders WHERE id = $1`,
      [chfOrderId],
    );
    expect(Number(again.rows[0]!.totals.paid_total)).toBe(70);
  });
});
