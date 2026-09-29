import { describe, it, expect, vi } from "vitest";

vi.mock("./db", () => ({ db: { query: vi.fn() }, withTransaction: vi.fn() }));
vi.mock("./logger", () => ({ logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { computeSessionCurrencySummary } from "./cashDesk";

// Pending/declined/cancelled salary expenses must never move session totals.
describe("computeSessionCurrencySummary — approval_status exclusion", () => {
  const session = { currency: "USD", opening_cash: "100.00" };

  it("excludes pending, declined, and cancelled transactions from totals", () => {
    const txns = [
      { currency: "USD", type: "expense", direction: "out", amount: "10.00", approval_status: "confirmed" },
      { currency: "USD", type: "expense", direction: "out", amount: "50.00", approval_status: "pending" },
      { currency: "USD", type: "expense", direction: "out", amount: "25.00", approval_status: "declined" },
      { currency: "USD", type: "expense", direction: "out", amount: "5.00", approval_status: "cancelled" },
    ];
    const summary = computeSessionCurrencySummary(session, ["USD"], txns);
    const usd = summary.find((r) => r.currency === "USD");
    expect(usd?.expenses_paid).toBe(10);
    expect(usd?.expected_cash).toBe(90);
  });

  it("treats missing/null approval_status as confirmed (legacy rows)", () => {
    const txns = [
      { currency: "USD", type: "expense", direction: "out", amount: "10.00" },
      { currency: "USD", type: "expense", direction: "out", amount: "20.00", approval_status: null },
    ];
    const summary = computeSessionCurrencySummary(session, ["USD"], txns);
    const usd = summary.find((r) => r.currency === "USD");
    expect(usd?.expenses_paid).toBe(30);
  });
});

// Movement-expansion parity: when a pending multi-currency salary expense is
// replaced by its movement rows, those rows must carry the parent's
// approval_status so the summary still excludes them.
describe("computeSessionCurrencySummary — pending movements excluded", () => {
  it("excludes movement rows tagged with a pending parent status", () => {
    const session = { currency: "USD", opening_cash: "100.00" };
    const txns = [
      { currency: "USD", type: "expense", direction: "out", amount: "10.00", approval_status: "confirmed" },
      // Movement rows of a pending salary expense (as built by the routes).
      { currency: "USD", type: "expense", direction: "out", amount: "40.00", approval_status: "pending" },
      { currency: "LBP", type: "expense", direction: "out", amount: "900000.00", approval_status: "pending" },
    ];
    const summary = computeSessionCurrencySummary(session, ["USD", "LBP"], txns);
    expect(summary.find((r) => r.currency === "USD")?.expenses_paid).toBe(10);
    expect(summary.find((r) => r.currency === "LBP")?.expenses_paid ?? 0).toBe(0);
  });
});
