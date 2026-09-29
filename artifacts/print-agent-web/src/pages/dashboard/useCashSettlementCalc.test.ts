/**
 * Unit tests for the useCashSettlementCalc hook exported from CashSessionDetail.
 *
 * The hook is a useMemo wrapper around pure arithmetic. Tests cover:
 *   - balanced (exact single-currency payment)
 *   - underpaid (received less than the sale amount)
 *   - overpaid (received more than the sale amount)
 *   - multi-currency change: the spec's worked example
 *     (100 USD, 80 USD + 2M LBP payment, 1 USD + 110k LBP change → balanced)
 *   - rates map applied correctly for foreign-currency rows
 *   - decimal precision (sub-cent rounding)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

// ---------------------------------------------------------------------------
// Mocks — must come before the module import
// ---------------------------------------------------------------------------

vi.mock("wouter", () => ({
  useParams: () => ({ id: "1" }),
  useLocation: () => ["/cash-sessions/1", vi.fn()],
}));

vi.mock("@/lib/queryClient", () => ({
  apiFetch: vi.fn(),
  getClerkToken: vi.fn().mockResolvedValue("tok"),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: vi.fn().mockReturnValue({ data: undefined, isLoading: false }),
  useMutation: vi.fn().mockReturnValue({ mutate: vi.fn(), isPending: false }),
  useQueryClient: vi.fn().mockReturnValue({ invalidateQueries: vi.fn() }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/hooks/use-workspace-role", () => ({
  useWorkspaceRole: () => ({ isOwner: true, allowedPages: null }),
}));

vi.mock("@/lib/imageUrl", () => ({
  imageUrl: vi.fn((url: string) => url),
}));

// ---------------------------------------------------------------------------
// Import the hook AFTER mocks
// ---------------------------------------------------------------------------

import { useCashSettlementCalc } from "./CashSessionDetail";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MovementRow = { id: string; amount: string; currency: string; rateOverride: string };

function row(amount: string, currency: string, rateOverride = ""): MovementRow {
  return { id: "r" + Math.random(), amount, currency, rateOverride };
}

const NO_RATES: Record<string, number> = {};
const USD_LBP_RATES: Record<string, number> = { LBP: 90_000 }; // 1 USD = 90,000 LBP
const USD_AED_RATES: Record<string, number> = { AED: 3.6727 }; // 1 USD = 3.6727 AED

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useCashSettlementCalc", () => {
  // ── balanced (exact single-currency) ──────────────────────────────────────

  it("returns balanced when single payment exactly matches sale amount", () => {
    const { result } = renderHook(() =>
      useCashSettlementCalc({
        docAmount: "100",
        docCurrency: "USD",
        payments: [row("100", "USD")],
        change: [],
        rates: NO_RATES,
      }),
    );

    expect(result.current.status).toBe("balanced");
    expect(result.current.difference).toBeCloseTo(0, 2);
  });

  // ── balanced when no payments yet (empty amount) ──────────────────────────

  it("returns balanced when docAmount is empty (no entry yet)", () => {
    const { result } = renderHook(() =>
      useCashSettlementCalc({
        docAmount: "",
        docCurrency: "USD",
        payments: [],
        change: [],
        rates: NO_RATES,
      }),
    );

    expect(result.current.status).toBe("balanced");
    expect(result.current.difference).toBe(0);
    expect(result.current.drawerImpact.size).toBe(0);
  });

  // ── underpaid ─────────────────────────────────────────────────────────────

  it("returns underpaid when payment is less than the sale amount", () => {
    const { result } = renderHook(() =>
      useCashSettlementCalc({
        docAmount: "100",
        docCurrency: "USD",
        payments: [row("80", "USD")],
        change: [],
        rates: NO_RATES,
      }),
    );

    expect(result.current.status).toBe("underpaid");
    expect(result.current.difference).toBeCloseTo(-20, 2);
  });

  // ── overpaid ──────────────────────────────────────────────────────────────

  it("returns overpaid when payment exceeds the sale amount with no change", () => {
    const { result } = renderHook(() =>
      useCashSettlementCalc({
        docAmount: "100",
        docCurrency: "USD",
        payments: [row("120", "USD")],
        change: [],
        rates: NO_RATES,
      }),
    );

    expect(result.current.status).toBe("overpaid");
    expect(result.current.difference).toBeCloseTo(20, 2);
  });

  // ── multi-currency change: the spec's worked example ─────────────────────
  //
  // 100 USD sale
  // Payments: 80 USD + 2,000,000 LBP (at 1 USD = 90,000 LBP)
  //   → 2,000,000 / 90,000 ≈ 22.22 USD equivalent
  //   → total ≈ 102.22 USD
  // Change: 1 USD + 110,000 LBP
  //   → 110,000 / 90,000 ≈ 1.22 USD equivalent
  //   → total ≈ 2.22 USD
  // Net: 102.22 − 2.22 = 100 USD → balanced ✓
  // Drawer impact: +79 USD, +1,890,000 LBP

  it("worked example: 100 USD sale, 80 USD + 2M LBP, 1 USD + 110k LBP change → balanced", () => {
    const { result } = renderHook(() =>
      useCashSettlementCalc({
        docAmount: "100",
        docCurrency: "USD",
        payments: [row("80", "USD"), row("2000000", "LBP")],
        change: [row("1", "USD"), row("110000", "LBP")],
        rates: USD_LBP_RATES,
      }),
    );

    expect(result.current.status).toBe("balanced");
    // Within 1 cent tolerance — difference should be essentially 0
    expect(Math.abs(result.current.difference)).toBeLessThan(0.02);
  });

  it("worked example: drawer impact is +79 USD and +1,890,000 LBP", () => {
    const { result } = renderHook(() =>
      useCashSettlementCalc({
        docAmount: "100",
        docCurrency: "USD",
        payments: [row("80", "USD"), row("2000000", "LBP")],
        change: [row("1", "USD"), row("110000", "LBP")],
        rates: USD_LBP_RATES,
      }),
    );

    const impact = result.current.drawerImpact;
    expect(impact.get("USD")).toBeCloseTo(79, 2);   // 80 - 1 = 79
    expect(impact.get("LBP")).toBeCloseTo(1_890_000, 0); // 2,000,000 - 110,000
  });

  // ── single payment row (legacy shape — same currency) ────────────────────

  it("single same-currency payment row works (legacy shape)", () => {
    const { result } = renderHook(() =>
      useCashSettlementCalc({
        docAmount: "50",
        docCurrency: "USD",
        payments: [row("50", "USD")],
        change: [],
        rates: NO_RATES,
      }),
    );

    expect(result.current.status).toBe("balanced");
    expect(result.current.drawerImpact.get("USD")).toBeCloseTo(50, 2);
  });

  // ── rates map applied correctly ───────────────────────────────────────────

  it("applies rates map to convert foreign currency rows", () => {
    // 100 USD sale paid with 367.27 AED (at 1 USD = 3.6727 AED → ≈ 100 USD)
    const { result } = renderHook(() =>
      useCashSettlementCalc({
        docAmount: "100",
        docCurrency: "USD",
        payments: [row("367.27", "AED")],
        change: [],
        rates: USD_AED_RATES,
      }),
    );

    // 367.27 / 3.6727 ≈ 100 USD
    expect(result.current.status).toBe("balanced");
  });

  it("rate override on a row overrides the rates map", () => {
    // Normal rate is 3.6727, but user overrides to 3.5 (devalued AED)
    // 100 AED * (1/3.5) ≈ 28.57 USD — should be underpaid vs 100 USD doc amount
    const overrideRow = { ...row("100", "AED"), rateOverride: "3.5" };
    const { result } = renderHook(() =>
      useCashSettlementCalc({
        docAmount: "100",
        docCurrency: "USD",
        payments: [overrideRow],
        change: [],
        rates: USD_AED_RATES,
      }),
    );

    expect(result.current.status).toBe("underpaid");
  });

  // ── decimal precision ─────────────────────────────────────────────────────

  it("rounds sub-cent fractions — three payments summing to exactly 100 USD", () => {
    // Three USD payments of 33.33, 33.33, 33.34 = 100.00
    const { result } = renderHook(() =>
      useCashSettlementCalc({
        docAmount: "100",
        docCurrency: "USD",
        payments: [row("33.33", "USD"), row("33.33", "USD"), row("33.34", "USD")],
        change: [],
        rates: NO_RATES,
      }),
    );

    expect(result.current.status).toBe("balanced");
  });

  // ── expense mode: signs are flipped ──────────────────────────────────────
  //
  // Expense of 50 USD, paid with 50 USD from the drawer; supplier returns
  // 700,000 LBP as change (at 1 USD = 90,000 LBP → ≈ 7.78 USD equivalent).
  // Drawer impact: −50 USD (payment leaves drawer), +700,000 LBP (change enters drawer).

  it("expense mode: 50 USD payment shows −50 USD drawer impact", () => {
    const { result } = renderHook(() =>
      useCashSettlementCalc({
        docAmount: "50",
        docCurrency: "USD",
        payments: [row("50", "USD")],
        change: [],
        rates: NO_RATES,
        mode: "expense",
      }),
    );

    expect(result.current.drawerImpact.get("USD")).toBeCloseTo(-50, 2);
  });

  it("expense mode: 700,000 LBP change shows +700,000 LBP drawer impact", () => {
    const { result } = renderHook(() =>
      useCashSettlementCalc({
        docAmount: "50",
        docCurrency: "USD",
        payments: [row("50", "USD")],
        change: [row("700000", "LBP")],
        rates: USD_LBP_RATES,
        mode: "expense",
      }),
    );

    const impact = result.current.drawerImpact;
    expect(impact.get("USD")).toBeCloseTo(-50, 2);       // payment leaves drawer
    expect(impact.get("LBP")).toBeCloseTo(700_000, 0);   // change returns to drawer
  });

  // ── rows with zero / empty amounts are ignored ────────────────────────────

  it("ignores payment rows with empty or zero amounts", () => {
    const { result } = renderHook(() =>
      useCashSettlementCalc({
        docAmount: "100",
        docCurrency: "USD",
        payments: [row("100", "USD"), row("", "LBP"), row("0", "USD")],
        change: [],
        rates: USD_LBP_RATES,
      }),
    );

    expect(result.current.status).toBe("balanced");
    // LBP impact should be 0 (empty row ignored)
    expect(result.current.drawerImpact.get("LBP") ?? 0).toBe(0);
  });
});
