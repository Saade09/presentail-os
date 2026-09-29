import { describe, it, expect, vi } from "vitest";

vi.mock("./db", () => ({ db: { query: vi.fn() } }));
vi.mock("./logger", () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } }));

import {
  buildReconciliationCounts,
  reconciliationCloseBlockers,
  isReconciliationStale,
  computeSessionCurrencySummary,
  type ReconciliationState,
  type ReconciliationCount,
  type SessionCurrencySummary,
} from "./cashDesk";

function summaryRow(currency: string, expected: number): SessionCurrencySummary {
  return {
    currency,
    opening_cash: 0,
    sales_collected: 0,
    expenses_paid: 0,
    adjustments: 0,
    expected_cash: expected,
  };
}

function count(overrides: Partial<ReconciliationCount> & { currency: string }): ReconciliationCount {
  return {
    expected: 100,
    actual: 100,
    variance: 0,
    explanation: null,
    requires_approval: false,
    approval: null,
    ...overrides,
  };
}

function rec(counts: ReconciliationCount[], extra?: Partial<ReconciliationState>): ReconciliationState {
  return {
    started_at: "2026-07-17T00:00:00.000Z",
    started_by_clerk_id: "user_a",
    counted_at: "2026-07-17T00:05:00.000Z",
    counted_by_clerk_id: "user_a",
    tx_count: 3,
    last_tx_id: 30,
    counts,
    ...extra,
  };
}

describe("buildReconciliationCounts", () => {
  it("computes variance per currency and no approval below threshold", () => {
    const r = buildReconciliationCounts(
      [summaryRow("USD", 100)],
      [{ currency: "usd", actual: 105 }],
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.counts).toHaveLength(1);
    expect(r.counts[0]).toMatchObject({
      currency: "USD",
      expected: 100,
      actual: 105,
      variance: 5,
      requires_approval: false,
      approval: null,
    });
  });

  it("attaches a pending approval when the variance exceeds the threshold", () => {
    // USD threshold is 10
    const r = buildReconciliationCounts(
      [summaryRow("USD", 100)],
      [{ currency: "USD", actual: 130 }],
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.counts[0].requires_approval).toBe(true);
    expect(r.counts[0].approval?.status).toBe("pending");
    expect(r.counts[0].approval?.decided_by_clerk_id).toBeNull();
  });

  it("does not require an explanation at count time (blind count)", () => {
    const r = buildReconciliationCounts(
      [summaryRow("USD", 100)],
      [{ currency: "USD", actual: 95 }],
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.counts[0].explanation).toBeNull();
  });

  it("keeps currencies separate — one count per session currency, no offsetting", () => {
    const r = buildReconciliationCounts(
      [summaryRow("USD", 100), summaryRow("LBP", 5_000_000)],
      [
        { currency: "USD", actual: 90 },
        { currency: "LBP", actual: 6_000_000 },
      ],
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.counts.map((c) => c.variance)).toEqual([-10, 1_000_000]);
  });

  it("rejects missing, duplicate, unexpected, and negative counts", () => {
    const summary = [summaryRow("USD", 100)];
    expect(buildReconciliationCounts(summary, []).ok).toBe(false);
    expect(
      buildReconciliationCounts(summary, [
        { currency: "USD", actual: 1 },
        { currency: "usd", actual: 2 },
      ]).ok,
    ).toBe(false);
    expect(
      buildReconciliationCounts(summary, [
        { currency: "USD", actual: 1 },
        { currency: "EUR", actual: 2 },
      ]).ok,
    ).toBe(false);
    expect(buildReconciliationCounts(summary, [{ currency: "USD", actual: -5 }]).ok).toBe(false);
    expect(buildReconciliationCounts(summary, [{ currency: "USD", actual: NaN }]).ok).toBe(false);
  });
});

describe("reconciliationCloseBlockers", () => {
  it("blocks with no_counts when there is no reconciliation or no counts", () => {
    expect(reconciliationCloseBlockers(null)).toEqual([{ code: "no_counts" }]);
    expect(reconciliationCloseBlockers(rec([]))).toEqual([{ code: "no_counts" }]);
  });

  it("requires an explanation for non-zero variances", () => {
    const blockers = reconciliationCloseBlockers(
      rec([count({ currency: "USD", actual: 95, variance: -5 })]),
    );
    expect(blockers).toEqual([{ code: "missing_explanation", currency: "USD" }]);
  });

  it("blocks on pending and rejected approvals", () => {
    const pending = rec([
      count({
        currency: "USD",
        variance: 20,
        explanation: "recount error",
        requires_approval: true,
        approval: {
          status: "pending",
          requested_at: "2026-07-17T00:05:00.000Z",
          decided_by_clerk_id: null,
          decided_at: null,
          note: null,
        },
      }),
    ]);
    expect(reconciliationCloseBlockers(pending)).toEqual([
      { code: "approval_pending", currency: "USD" },
    ]);

    const rejected = rec([
      count({
        currency: "USD",
        variance: 20,
        explanation: "recount error",
        requires_approval: true,
        approval: {
          status: "rejected",
          requested_at: "2026-07-17T00:05:00.000Z",
          decided_by_clerk_id: "user_b",
          decided_at: "2026-07-17T00:06:00.000Z",
          note: null,
        },
      }),
    ]);
    expect(reconciliationCloseBlockers(rejected)).toEqual([
      { code: "approval_rejected", currency: "USD" },
    ]);
  });

  it("passes when balanced or explained and approved", () => {
    const ready = rec([
      count({ currency: "USD" }),
      count({
        currency: "LBP",
        variance: 2_000_000,
        explanation: "extra note found",
        requires_approval: true,
        approval: {
          status: "approved",
          requested_at: "2026-07-17T00:05:00.000Z",
          decided_by_clerk_id: "user_b",
          decided_at: "2026-07-17T00:06:00.000Z",
          note: "ok",
        },
      }),
    ]);
    expect(reconciliationCloseBlockers(ready)).toEqual([]);
  });
});

describe("isReconciliationStale", () => {
  it("is stale without a reconciliation", () => {
    expect(isReconciliationStale(null, 0, null)).toBe(true);
  });

  it("is fresh when tx count and last id match", () => {
    expect(isReconciliationStale({ tx_count: 3, last_tx_id: 30 }, 3, 30)).toBe(false);
    expect(isReconciliationStale({ tx_count: 0, last_tx_id: null }, 0, null)).toBe(false);
  });

  it("is stale when transactions were added or changed", () => {
    expect(isReconciliationStale({ tx_count: 3, last_tx_id: 30 }, 4, 31)).toBe(true);
    expect(isReconciliationStale({ tx_count: 3, last_tx_id: 30 }, 3, 31)).toBe(true);
  });
});

describe("computeSessionCurrencySummary", () => {
  it("single-currency USD: opening cash flows into the USD row", () => {
    const result = computeSessionCurrencySummary(
      { currency: "USD", opening_cash: 200 },
      ["USD"],
      [],
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      currency: "USD",
      opening_cash: 200,
      sales_collected: 0,
      expenses_paid: 0,
      adjustments: 0,
      expected_cash: 200,
    });
  });

  it("dual-currency USD+LBP: LBP row picks up opening_cash_secondary, not 0", () => {
    const result = computeSessionCurrencySummary(
      {
        currency: "USD",
        opening_cash: 50,
        secondary_currency: "LBP",
        opening_cash_secondary: 125000,
      },
      ["USD", "LBP"],
      [],
    );
    expect(result).toHaveLength(2);
    const usd = result.find((r) => r.currency === "USD");
    const lbp = result.find((r) => r.currency === "LBP");
    expect(usd?.opening_cash).toBe(50);
    expect(usd?.expected_cash).toBe(50);
    expect(lbp?.opening_cash).toBe(125000);
    expect(lbp?.expected_cash).toBe(125000);
  });

  it("expected_cash includes opening balance plus transaction movements", () => {
    const result = computeSessionCurrencySummary(
      {
        currency: "USD",
        opening_cash: 100,
        secondary_currency: "LBP",
        opening_cash_secondary: 50000,
      },
      ["USD", "LBP"],
      [
        { currency: "USD", amount: "30", direction: "in", type: "sale" },
        { currency: "USD", amount: "10", direction: "out", type: "expense" },
        { currency: "LBP", amount: "20000", direction: "in", type: "sale" },
      ],
    );
    const usd = result.find((r) => r.currency === "USD");
    const lbp = result.find((r) => r.currency === "LBP");
    // USD: 100 opening + 30 sale - 10 expense = 120
    expect(usd?.expected_cash).toBe(120);
    expect(usd?.sales_collected).toBe(30);
    expect(usd?.expenses_paid).toBe(10);
    // LBP: 50000 opening + 20000 sale = 70000
    expect(lbp?.expected_cash).toBe(70000);
    expect(lbp?.sales_collected).toBe(20000);
  });

  it("session with no secondary currency: absence of secondary fields does not throw", () => {
    const result = computeSessionCurrencySummary(
      { currency: "USD", opening_cash: 75 },
      ["USD"],
      [],
    );
    expect(result).toHaveLength(1);
    expect(result[0].opening_cash).toBe(75);
  });

  it("secondary currency with null opening_cash_secondary defaults to 0", () => {
    const result = computeSessionCurrencySummary(
      {
        currency: "USD",
        opening_cash: 100,
        secondary_currency: "LBP",
        opening_cash_secondary: null,
      },
      ["USD", "LBP"],
      [],
    );
    const lbp = result.find((r) => r.currency === "LBP");
    expect(lbp?.opening_cash).toBe(0);
    expect(lbp?.expected_cash).toBe(0);
  });
});
