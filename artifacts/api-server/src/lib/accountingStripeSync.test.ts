import { describe, it, expect, vi, beforeEach } from "vitest";

const mockStripeInstance = vi.hoisted(() => ({
  balanceTransactions: {
    list: vi.fn(),
  },
  charges: {
    retrieve: vi.fn(),
  },
}));

vi.mock("./db", () => ({
  db: { query: vi.fn(), connect: vi.fn() },
}));
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("stripe", () => {
  function MockStripe() {
    return mockStripeInstance;
  }
  return { default: MockStripe };
});

import { db } from "./db.js";
import {
  categorize,
  getOpeningBalance,
  matchChargeToOrder,
  runStripeSync,
} from "./accountingStripeSync.js";
import type Stripe from "stripe";

const mockedDb = db as unknown as { query: ReturnType<typeof vi.fn> };

function makeTxn(
  overrides: Partial<Stripe.BalanceTransaction> & { ending_balance?: number | null },
): Stripe.BalanceTransaction {
  return {
    id: "txn_test",
    object: "balance_transaction",
    amount: 1000,
    available_on: 0,
    created: 1700000000,
    currency: "usd",
    description: null,
    exchange_rate: null,
    fee: 29,
    fee_details: [],
    net: 971,
    reporting_category: "charge",
    source: "ch_test",
    status: "available",
    type: "charge",
    ...overrides,
  } as unknown as Stripe.BalanceTransaction;
}

beforeEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// categorize
// ---------------------------------------------------------------------------

describe("categorize", () => {
  it("puts a 'charge' type into charges bucket", () => {
    const txn = makeTxn({ type: "charge" });
    const result = categorize([txn]);
    expect(result.charges).toHaveLength(1);
    expect(result.refunds).toHaveLength(0);
    expect(result.fees).toHaveLength(0);
    expect(result.disputes).toHaveLength(0);
    expect(result.payouts).toHaveLength(0);
    expect(result.adjustments).toHaveLength(0);
  });

  it("puts 'refund' and 'partial_capture_reversal' into refunds", () => {
    const txns = [
      makeTxn({ type: "refund", amount: -500 }),
      makeTxn({ type: "partial_capture_reversal" as Stripe.BalanceTransaction.Type, amount: -200 }),
    ];
    const result = categorize(txns);
    expect(result.refunds).toHaveLength(2);
    expect(result.charges).toHaveLength(0);
  });

  it("puts 'application_fee' and 'stripe_fee' into fees", () => {
    const txns = [
      makeTxn({ type: "application_fee", amount: -100 }),
      makeTxn({ type: "stripe_fee", amount: -50 }),
    ];
    const result = categorize(txns);
    expect(result.fees).toHaveLength(2);
  });

  it("puts 'dispute' and 'dispute_reversal' into disputes", () => {
    const txns = [
      makeTxn({ type: "dispute" as Stripe.BalanceTransaction.Type, amount: -1500 }),
      makeTxn({ type: "dispute_reversal" as Stripe.BalanceTransaction.Type, amount: 1500 }),
    ];
    const result = categorize(txns);
    expect(result.disputes).toHaveLength(2);
  });

  it("puts 'payout', 'payout_failure', 'payout_cancel' into payouts", () => {
    const txns = [
      makeTxn({ type: "payout", amount: -5000 }),
      makeTxn({ type: "payout_failure", amount: 5000 }),
      makeTxn({ type: "payout_cancel", amount: 5000 }),
    ];
    const result = categorize(txns);
    expect(result.payouts).toHaveLength(3);
  });

  it("puts unknown types into adjustments", () => {
    const txn = makeTxn({ type: "transfer" as Stripe.BalanceTransaction.Type });
    const result = categorize([txn]);
    expect(result.adjustments).toHaveLength(1);
  });

  it("handles an empty transaction list — all buckets empty", () => {
    const result = categorize([]);
    expect(result.charges).toHaveLength(0);
    expect(result.refunds).toHaveLength(0);
    expect(result.fees).toHaveLength(0);
    expect(result.disputes).toHaveLength(0);
    expect(result.payouts).toHaveLength(0);
    expect(result.adjustments).toHaveLength(0);
  });

  it("splits a mixed list into the correct buckets", () => {
    const txns = [
      makeTxn({ type: "charge", amount: 3000 }),
      makeTxn({ type: "refund", amount: -500 }),
      makeTxn({ type: "stripe_fee", amount: -100 }),
      makeTxn({ type: "dispute" as Stripe.BalanceTransaction.Type, amount: -800 }),
      makeTxn({ type: "payout", amount: -4000 }),
      makeTxn({ type: "adjustment" as Stripe.BalanceTransaction.Type, amount: 200 }),
    ];
    const result = categorize(txns);
    expect(result.charges).toHaveLength(1);
    expect(result.refunds).toHaveLength(1);
    expect(result.fees).toHaveLength(1);
    expect(result.disputes).toHaveLength(1);
    expect(result.payouts).toHaveLength(1);
    expect(result.adjustments).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// getOpeningBalance
// ---------------------------------------------------------------------------

describe("getOpeningBalance", () => {
  it("returns the ending_balance of the last transaction before the month start", async () => {
    mockStripeInstance.balanceTransactions.list.mockResolvedValue({
      data: [
        makeTxn({ id: "txn_prev", ending_balance: 25000 } as Parameters<typeof makeTxn>[0]),
      ],
      has_more: false,
    });

    const balance = await getOpeningBalance(
      mockStripeInstance as unknown as Stripe,
      1700000000,
    );
    expect(balance).toBe(25000);
    expect(mockStripeInstance.balanceTransactions.list).toHaveBeenCalledWith({
      created: { lt: 1700000000 },
      limit: 1,
    });
  });

  it("returns 0 when there are no prior transactions (first month)", async () => {
    mockStripeInstance.balanceTransactions.list.mockResolvedValue({
      data: [],
      has_more: false,
    });

    const balance = await getOpeningBalance(
      mockStripeInstance as unknown as Stripe,
      1700000000,
    );
    expect(balance).toBe(0);
  });

  it("returns 0 when ending_balance is null on the prior transaction", async () => {
    mockStripeInstance.balanceTransactions.list.mockResolvedValue({
      data: [makeTxn({ id: "txn_prev", ending_balance: null } as Parameters<typeof makeTxn>[0])],
      has_more: false,
    });

    const balance = await getOpeningBalance(
      mockStripeInstance as unknown as Stripe,
      1700000000,
    );
    expect(balance).toBe(0);
  });

  it("returns 0 and does not throw when the Stripe call fails", async () => {
    mockStripeInstance.balanceTransactions.list.mockRejectedValue(
      new Error("Stripe API error"),
    );

    const balance = await getOpeningBalance(
      mockStripeInstance as unknown as Stripe,
      1700000000,
    );
    expect(balance).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// matchChargeToOrder
// ---------------------------------------------------------------------------

describe("matchChargeToOrder", () => {
  it("returns none confidence when source is missing", async () => {
    const txn = makeTxn({ source: null as unknown as string });
    const result = await matchChargeToOrder(
      mockStripeInstance as unknown as Stripe,
      txn,
      "owner_1",
    );
    expect(result).toEqual({ orderId: null, confidence: "none" });
  });

  it("returns none confidence when source is an expanded object, not a string", async () => {
    const txn = makeTxn({ source: { id: "ch_abc" } as unknown as string });
    const result = await matchChargeToOrder(
      mockStripeInstance as unknown as Stripe,
      txn,
      "owner_1",
    );
    expect(result).toEqual({ orderId: null, confidence: "none" });
  });

  it("returns high confidence when payment_intent_id matches an OS order", async () => {
    const txn = makeTxn({ source: "ch_abc", type: "charge" });
    mockStripeInstance.charges.retrieve.mockResolvedValue({
      id: "ch_abc",
      payment_intent: "pi_xyz",
      metadata: {},
    });
    mockedDb.query
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ order_id: "order_1" }] });

    const result = await matchChargeToOrder(
      mockStripeInstance as unknown as Stripe,
      txn,
      "owner_1",
    );
    expect(result).toEqual({ orderId: "order_1", confidence: "high" });
  });

  it("falls back to charge_id lookup (medium confidence) when pi lookup misses", async () => {
    const txn = makeTxn({ source: "ch_abc", type: "charge" });
    mockStripeInstance.charges.retrieve.mockResolvedValue({
      id: "ch_abc",
      payment_intent: "pi_xyz",
      metadata: {},
    });
    mockedDb.query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ order_id: "order_2" }] });

    const result = await matchChargeToOrder(
      mockStripeInstance as unknown as Stripe,
      txn,
      "owner_1",
    );
    expect(result).toEqual({ orderId: "order_2", confidence: "medium" });
  });

  it("falls back to metadata order_id lookup (low confidence) when both db lookups miss", async () => {
    const txn = makeTxn({ source: "ch_abc", type: "charge" });
    mockStripeInstance.charges.retrieve.mockResolvedValue({
      id: "ch_abc",
      payment_intent: "pi_xyz",
      metadata: { order_id: "order_meta" },
    });
    mockedDb.query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ id: "order_meta" }] });

    const result = await matchChargeToOrder(
      mockStripeInstance as unknown as Stripe,
      txn,
      "owner_1",
    );
    expect(result).toEqual({ orderId: "order_meta", confidence: "low" });
  });

  it("returns none when all lookups miss", async () => {
    const txn = makeTxn({ source: "ch_abc", type: "charge" });
    mockStripeInstance.charges.retrieve.mockResolvedValue({
      id: "ch_abc",
      payment_intent: "pi_xyz",
      metadata: {},
    });
    mockedDb.query
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] });

    const result = await matchChargeToOrder(
      mockStripeInstance as unknown as Stripe,
      txn,
      "owner_1",
    );
    expect(result).toEqual({ orderId: null, confidence: "none" });
  });

  it("returns none and does not throw when Stripe charge retrieve fails", async () => {
    const txn = makeTxn({ source: "ch_abc", type: "charge" });
    mockStripeInstance.charges.retrieve.mockRejectedValue(new Error("Network error"));

    const result = await matchChargeToOrder(
      mockStripeInstance as unknown as Stripe,
      txn,
      "owner_1",
    );
    expect(result).toEqual({ orderId: null, confidence: "none" });
  });
});

// ---------------------------------------------------------------------------
// runStripeSync — roll-forward arithmetic + edge cases
// ---------------------------------------------------------------------------

describe("runStripeSync", () => {
  const WORKSPACE_OWNER = "owner_ws";
  const SOURCE_MONTH_ID = 42;

  function buildStripeListPage(
    txns: ReturnType<typeof makeTxn>[],
    hasMore = false,
  ) {
    return { data: txns, has_more: hasMore };
  }

  function setupDbForSync(osOrders: Array<{
    order_id: string;
    amount_cents: number;
    amount: string | null;
    currency: string;
  }> = []) {
    mockedDb.query
      .mockResolvedValueOnce({ rows: [{ id: 99 }], rowCount: 1 })
      .mockResolvedValue({ rows: osOrders, rowCount: osOrders.length });
  }

  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
  });

  it("empty month — all financial figures are zero, status is unknown/matched", async () => {
    mockStripeInstance.balanceTransactions.list.mockResolvedValue(
      buildStripeListPage([]),
    );
    mockedDb.query
      .mockResolvedValueOnce({ rows: [{ id: 99 }], rowCount: 1 })
      .mockResolvedValue({ rows: [], rowCount: 0 });

    const result = await runStripeSync(SOURCE_MONTH_ID, WORKSPACE_OWNER, 2024, 2);

    expect(result.recordsSynced).toBe(0);
    expect(result.stripeChargesAmountCents).toBe(0);
    expect(result.refundsCents).toBe(0);
    expect(result.feesCents).toBe(0);
    expect(result.disputesCents).toBe(0);
    expect(result.adjustmentsCents).toBe(0);
    expect(result.payoutsCents).toBe(0);
    expect(result.openingBalanceCents).toBe(0);
    expect(result.closingBalanceCents).toBe(0);
    expect(result.payoutReconciliationStatus).toBe("unknown");
    expect(result.salesReconciliationStatus).toBe("matched");
  });

  it("opening balance is carried forward from the prior month's last transaction", async () => {
    const openingTxn = makeTxn({
      id: "txn_prev",
      ending_balance: 50000,
    } as Parameters<typeof makeTxn>[0]);

    mockStripeInstance.balanceTransactions.list
      .mockResolvedValueOnce(buildStripeListPage([]))
      .mockResolvedValueOnce(buildStripeListPage([openingTxn]));

    mockedDb.query
      .mockResolvedValueOnce({ rows: [{ id: 99 }], rowCount: 1 })
      .mockResolvedValue({ rows: [], rowCount: 0 });

    const result = await runStripeSync(SOURCE_MONTH_ID, WORKSPACE_OWNER, 2024, 3);

    expect(result.openingBalanceCents).toBe(50000);
    expect(result.closingBalanceCents).toBe(50000);
  });

  it("closing balance falls back to opening balance when there are no payouts in the month", async () => {
    const charge = makeTxn({
      id: "txn_c1",
      type: "charge",
      amount: 10000,
      fee: 290,
      net: 9710,
      source: null as unknown as string,
    });

    mockStripeInstance.balanceTransactions.list
      .mockResolvedValueOnce(buildStripeListPage([charge]))
      .mockResolvedValueOnce(buildStripeListPage([]));

    mockedDb.query
      .mockResolvedValueOnce({ rows: [{ id: 99 }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValue({ rows: [], rowCount: 0 });

    const result = await runStripeSync(SOURCE_MONTH_ID, WORKSPACE_OWNER, 2024, 4);

    expect(result.closingBalanceCents).toBe(0);
  });

  it("roll-forward arithmetic: opening + charges − refunds − fees − disputes + adjustments − payouts = closing", async () => {
    const openingBalance = 20000;
    const chargeAmt = 50000;
    const refundAmt = -5000;
    const feeAmt = 1500;
    const disputeAmt = -3000;
    const adjustmentAmt = 2000;
    const payoutAmt = -30000;
    const expectedClosing =
      openingBalance + chargeAmt - Math.abs(refundAmt) - feeAmt - Math.abs(disputeAmt) + adjustmentAmt - Math.abs(payoutAmt);

    const computedEnding = expectedClosing;

    const BASE_TS = 1700000000;
    const txns = [
      makeTxn({
        id: "txn_c1",
        type: "charge",
        amount: chargeAmt,
        fee: 0,
        source: null as unknown as string,
        created: BASE_TS,
      }),
      makeTxn({ id: "txn_r1", type: "refund", amount: refundAmt, fee: 0, created: BASE_TS + 1 }),
      makeTxn({ id: "txn_f1", type: "stripe_fee", amount: -feeAmt, fee: feeAmt, created: BASE_TS + 2 }),
      makeTxn({ id: "txn_d1", type: "dispute" as Stripe.BalanceTransaction.Type, amount: disputeAmt, fee: 0, created: BASE_TS + 3 }),
      makeTxn({
        id: "txn_a1",
        type: "adjustment" as Stripe.BalanceTransaction.Type,
        amount: adjustmentAmt,
        fee: 0,
        created: BASE_TS + 4,
      }),
      makeTxn({
        id: "txn_p1",
        type: "payout",
        amount: payoutAmt,
        fee: 0,
        created: BASE_TS + 5,
        ending_balance: computedEnding,
      } as Parameters<typeof makeTxn>[0]),
    ];

    const prevTxn = makeTxn({
      id: "txn_prev",
      ending_balance: openingBalance,
    } as Parameters<typeof makeTxn>[0]);

    mockStripeInstance.balanceTransactions.list
      .mockResolvedValueOnce(buildStripeListPage(txns))
      .mockResolvedValueOnce(buildStripeListPage([prevTxn]));

    mockedDb.query
      .mockResolvedValueOnce({ rows: [{ id: 99 }], rowCount: 1 })
      .mockResolvedValue({ rows: [], rowCount: 0 });

    const result = await runStripeSync(SOURCE_MONTH_ID, WORKSPACE_OWNER, 2024, 5);

    expect(result.openingBalanceCents).toBe(openingBalance);
    expect(result.stripeChargesAmountCents).toBe(chargeAmt);
    expect(result.refundsCents).toBe(Math.abs(refundAmt));
    expect(result.disputesCents).toBe(Math.abs(disputeAmt));
    expect(result.adjustmentsCents).toBe(adjustmentAmt);
    expect(result.payoutsCents).toBe(Math.abs(payoutAmt));

    const computedClosing =
      result.openingBalanceCents +
      result.stripeChargesAmountCents -
      result.refundsCents -
      result.feesCents -
      result.disputesCents +
      result.adjustmentsCents -
      result.payoutsCents;
    expect(computedClosing).toBe(expectedClosing);
    expect(result.closingBalanceCents).toBe(computedEnding);
    expect(Math.abs(computedClosing - result.closingBalanceCents)).toBeLessThanOrEqual(1);
    expect(result.payoutReconciliationStatus).toBe("matched");
  });

  it("partial month (current in-progress): no ending_balance on latest txn → closing falls back to opening", async () => {
    const charge = makeTxn({
      id: "txn_c1",
      type: "charge",
      amount: 8000,
      fee: 0,
      source: null as unknown as string,
      ending_balance: null,
    } as Parameters<typeof makeTxn>[0]);

    const prevTxn = makeTxn({
      id: "txn_prev",
      ending_balance: 15000,
    } as Parameters<typeof makeTxn>[0]);

    mockStripeInstance.balanceTransactions.list
      .mockResolvedValueOnce(buildStripeListPage([charge]))
      .mockResolvedValueOnce(buildStripeListPage([prevTxn]));

    mockedDb.query
      .mockResolvedValueOnce({ rows: [{ id: 99 }], rowCount: 1 })
      .mockResolvedValue({ rows: [], rowCount: 0 });

    const result = await runStripeSync(SOURCE_MONTH_ID, WORKSPACE_OWNER, 2024, 7);

    expect(result.openingBalanceCents).toBe(15000);
    expect(result.closingBalanceCents).toBe(15000);
  });

  it("month boundary: uses correct UTC timestamps (year/month args map to month start/end)", async () => {
    mockStripeInstance.balanceTransactions.list.mockResolvedValue(
      buildStripeListPage([]),
    );
    mockedDb.query
      .mockResolvedValueOnce({ rows: [{ id: 99 }], rowCount: 1 })
      .mockResolvedValue({ rows: [], rowCount: 0 });

    await runStripeSync(SOURCE_MONTH_ID, WORKSPACE_OWNER, 2024, 12);

    const firstCall = mockStripeInstance.balanceTransactions.list.mock.calls[0][0];
    const dec1Ts = Math.floor(Date.UTC(2024, 11, 1) / 1000);
    const jan1Ts = Math.floor(Date.UTC(2025, 0, 1) / 1000);
    expect(firstCall.created.gte).toBe(dec1Ts);
    expect(firstCall.created.lt).toBe(jan1Ts);
  });

  it("sales reconciliation is 'matched' when all OS orders match Stripe charges", async () => {
    const charge = makeTxn({
      id: "txn_c1",
      type: "charge",
      amount: 5000,
      fee: 145,
      source: "ch_abc",
    });

    const prevTxn = makeTxn({
      id: "txn_prev",
      ending_balance: 0,
    } as Parameters<typeof makeTxn>[0]);

    mockStripeInstance.balanceTransactions.list
      .mockResolvedValueOnce(buildStripeListPage([charge]))
      .mockResolvedValueOnce(buildStripeListPage([prevTxn]));

    mockStripeInstance.charges.retrieve.mockResolvedValue({
      id: "ch_abc",
      payment_intent: "pi_abc",
      metadata: {},
    });

    mockedDb.query
      .mockResolvedValueOnce({ rows: [{ id: 99 }], rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ order_id: "order_a" }] })
      .mockResolvedValueOnce({
        rows: [{ order_id: "order_a", amount_cents: 5000, amount: null, currency: "usd" }],
        rowCount: 1,
      })
      .mockResolvedValue({ rows: [], rowCount: 0 });

    const result = await runStripeSync(SOURCE_MONTH_ID, WORKSPACE_OWNER, 2024, 6);
    expect(result.salesReconciliationStatus).toBe("matched");
    expect(result.matchedCount).toBe(1);
    expect(result.unmatchedStripeCount).toBe(0);
  });

  it("payout reconciliation is 'unmatched' when computed closing differs from Stripe ending_balance", async () => {
    const charge = makeTxn({
      id: "txn_c1",
      type: "charge",
      amount: 5000,
      fee: 0,
      source: null as unknown as string,
      ending_balance: 99999,
    } as Parameters<typeof makeTxn>[0]);

    const prevTxn = makeTxn({
      id: "txn_prev",
      ending_balance: 0,
    } as Parameters<typeof makeTxn>[0]);

    mockStripeInstance.balanceTransactions.list
      .mockResolvedValueOnce(buildStripeListPage([charge]))
      .mockResolvedValueOnce(buildStripeListPage([prevTxn]));

    mockedDb.query
      .mockResolvedValueOnce({ rows: [{ id: 99 }], rowCount: 1 })
      .mockResolvedValue({ rows: [], rowCount: 0 });

    const result = await runStripeSync(SOURCE_MONTH_ID, WORKSPACE_OWNER, 2024, 8);
    expect(result.payoutReconciliationStatus).toBe("unmatched");
  });
});
