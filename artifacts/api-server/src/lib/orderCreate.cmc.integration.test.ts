/**
 * Real-database regression coverage for CMC New Order creation.
 *
 * The CMC branch writes an orders row, order payment, and matching cmc_sales
 * row in one transaction. This suite intentionally uses the real db pool so a
 * placeholder/value drift in the cmc_sales INSERT fails at the database
 * boundary instead of being hidden by a mocked client.
 *
 * Skips automatically when DATABASE_URL is not set.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { createManualOrder } from "./orderCreate";

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const TEST_WORKSPACE = `__cmc_order_create_${Date.now()}`;
const TEST_ACTOR = "__cmc_order_create_test_user__";

describe.skipIf(!DATABASE_URL)("CMC New Order creation — real DB (integration)", () => {
  let pool: InstanceType<typeof Pool>;

  async function clearTestRows(): Promise<void> {
    await pool.query(`DELETE FROM cmc_sales WHERE workspace_owner_id = $1`, [TEST_WORKSPACE]);
    await pool.query(`DELETE FROM orders WHERE workspace_owner_id = $1`, [TEST_WORKSPACE]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  beforeEach(async () => {
    await clearTestRows();
  });

  afterAll(async () => {
    if (!pool) return;
    await clearTestRows();
    await pool.end();
  });

  it.each([
    { method: "cash", status: "pending" },
    { method: "card", status: "pending" },
    { method: "whish", status: "pending" },
  ])("persists a $method CMC order and matching sale", async ({ method, status }) => {
    const displayOrderNumber = `CMC-TEST-${method}-${Date.now()}`;
    const { orderId } = await createManualOrder({
      workspaceOwnerId: TEST_WORKSPACE,
      actorUserId: TEST_ACTOR,
      displayOrderNumber,
      data: {
        source: "cmc-pos",
        status: "pending",
        line_items: [
          { name: "Integration bouquet", quantity: 2, unit_price: 12.5 },
          { name: "Integration card", quantity: 1, unit_price: 5 },
        ],
        totals: { subtotal: 999, total: 999, currency: "USD" },
        payment: { method, status, currency: "USD" },
      },
    });

    const orderResult = await pool.query<{
      id: string;
      source: string;
      display_order_number: string;
      totals: Record<string, unknown>;
    }>(
      `SELECT id, source, display_order_number, totals
         FROM orders
        WHERE id = $1`,
      [orderId],
    );
    const paymentResult = await pool.query<{
      method: string;
      status: string;
      currency: string;
      amount: string;
    }>(
      `SELECT method, status, currency, amount
         FROM order_payment
        WHERE order_id = $1`,
      [orderId],
    );
    const saleResult = await pool.query<{
      workflow_type: string;
      source_channel: string;
      status: string;
      order_id: string;
      subtotal: string;
      discount_amount: string;
      total: string;
      payment_method: string;
    }>(
      `SELECT workflow_type, source_channel, status, order_id, subtotal,
              discount_amount, total, payment_method
         FROM cmc_sales
        WHERE order_id = $1`,
      [orderId],
    );

    expect(orderResult.rows).toHaveLength(1);
    expect(orderResult.rows[0]).toMatchObject({
      id: orderId,
      source: "cmc-pos",
      display_order_number: displayOrderNumber,
      totals: expect.objectContaining({
        subtotal: 30,
        total: 30,
        currency: "USD",
      }),
    });
    expect(paymentResult.rows).toEqual([
      { method, status, currency: "USD", amount: "30.0000" },
    ]);
    expect(saleResult.rows).toEqual([
      {
        workflow_type: "order",
        source_channel: "cmc-pos",
        status: "pending",
        order_id: orderId,
        subtotal: "30.0000",
        discount_amount: "0.0000",
        total: "30.0000",
        payment_method: method,
      },
    ]);
  });
});