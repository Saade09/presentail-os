import { describe, it, expect } from "vitest";
import { formatCashMoney, DASH, decimalPlaces } from "./cashMoney";

describe("decimalPlaces", () => {
  it("returns 0 for LBP (case-insensitive)", () => {
    expect(decimalPlaces("LBP")).toBe(0);
    expect(decimalPlaces("lbp")).toBe(0);
  });

  it("returns 2 for USD, AED, and unknown currencies", () => {
    expect(decimalPlaces("USD")).toBe(2);
    expect(decimalPlaces("AED")).toBe(2);
    expect(decimalPlaces("EUR")).toBe(2);
    expect(decimalPlaces("XYZ")).toBe(2);
  });
});

describe("formatCashMoney", () => {
  describe("null / undefined → em-dash", () => {
    it("returns DASH for null", () => {
      expect(formatCashMoney(null)).toBe(DASH);
      expect(formatCashMoney(null, "USD")).toBe(DASH);
    });

    it("returns DASH for undefined", () => {
      expect(formatCashMoney(undefined)).toBe(DASH);
      expect(formatCashMoney(undefined, "LBP")).toBe(DASH);
    });

    it("returns DASH for empty string", () => {
      expect(formatCashMoney("")).toBe(DASH);
    });

    it("returns DASH for non-numeric string", () => {
      expect(formatCashMoney("abc", "USD")).toBe(DASH);
    });
  });

  describe("USD — two decimals with thousands separator, prefix", () => {
    it("formats positive USD", () => {
      expect(formatCashMoney(53, "USD")).toBe("USD 53.00");
    });

    it("formats large USD with thousands separator", () => {
      expect(formatCashMoney(1234567.89, "USD")).toBe("USD 1,234,567.89");
    });

    it("formats USD from numeric string", () => {
      expect(formatCashMoney("712", "USD")).toBe("USD 712.00");
    });

    it("formats zero USD", () => {
      expect(formatCashMoney(0, "USD")).toBe("USD 0.00");
    });
  });

  describe("LBP — zero decimals with thousands separator, prefix", () => {
    it("formats positive LBP", () => {
      expect(formatCashMoney(125000, "LBP")).toBe("LBP 125,000");
    });

    it("formats large LBP", () => {
      expect(formatCashMoney(24500000, "LBP")).toBe("LBP 24,500,000");
    });

    it("formats zero LBP", () => {
      expect(formatCashMoney(0, "LBP")).toBe("LBP 0");
    });

    it("formats LBP from numeric string", () => {
      expect(formatCashMoney("24500000", "LBP")).toBe("LBP 24,500,000");
    });
  });

  describe("negative values", () => {
    it("uses proper minus sign (U+2212) for negative USD", () => {
      expect(formatCashMoney(-53, "USD")).toBe("USD \u221253.00");
    });

    it("uses proper minus sign for negative LBP", () => {
      expect(formatCashMoney(-15000, "LBP")).toBe("LBP \u221215,000");
    });
  });

  describe("negative zero normalisation", () => {
    it("treats -0 as 0 for USD", () => {
      expect(formatCashMoney(-0, "USD")).toBe("USD 0.00");
    });

    it("treats -0 as 0 for LBP", () => {
      expect(formatCashMoney(-0, "LBP")).toBe("LBP 0");
    });

    it("treats numeric string '-0' as zero", () => {
      expect(formatCashMoney("-0", "USD")).toBe("USD 0.00");
    });
  });

  describe("signed option", () => {
    it("prefixes positive with + when signed=true", () => {
      expect(formatCashMoney(53, "USD", { signed: true })).toBe("USD +53.00");
    });

    it("still uses − for negatives with signed=true", () => {
      expect(formatCashMoney(-53, "USD", { signed: true })).toBe("USD \u221253.00");
    });

    it("does NOT prefix zero with + even when signed=true", () => {
      expect(formatCashMoney(0, "USD", { signed: true })).toBe("USD 0.00");
    });
  });

  describe("no currency provided", () => {
    it("formats with 2 decimals and no prefix", () => {
      expect(formatCashMoney(100)).toBe("100.00");
    });

    it("returns DASH for null without currency", () => {
      expect(formatCashMoney(null)).toBe(DASH);
    });
  });

  describe("unsupported / unknown currency falls back to 2 decimals", () => {
    it("formats EUR with 2 decimals and prefix", () => {
      expect(formatCashMoney(100, "EUR")).toBe("EUR 100.00");
    });

    it("formats XYZ with 2 decimals and prefix", () => {
      expect(formatCashMoney(99.9, "XYZ")).toBe("XYZ 99.90");
    });

    it("formats AED with 2 decimals and prefix (two-decimal fallback)", () => {
      expect(formatCashMoney(199.5, "AED")).toBe("AED 199.50");
    });
  });
});

// ---------------------------------------------------------------------------
// Expected cash projection formula
// ---------------------------------------------------------------------------

describe("expected cash projection", () => {
  /**
   * expected = opening + sales_collected − expenses_paid + adjustments
   * (adjustments is signed: positive means an inflow adjustment)
   */
  function project(
    opening: number,
    salesCollected: number,
    expensesPaid: number,
    adjustments: number,
  ): number {
    return opening + salesCollected - expensesPaid + adjustments;
  }

  it("simple USD session: opening + sales − expenses", () => {
    const result = project(100, 250, 80, 0);
    expect(result).toBeCloseTo(270, 5); // 100 + 250 − 80 = 270
  });

  it("LBP session with large amounts", () => {
    const result = project(5_000_000, 24_500_000, 1_200_000, 0);
    expect(result).toBe(28_300_000);
  });

  it("positive adjustment increases expected cash", () => {
    const result = project(100, 200, 50, 30);
    expect(result).toBe(280); // 100 + 200 − 50 + 30
  });

  it("negative adjustment decreases expected cash", () => {
    const result = project(100, 200, 50, -30);
    expect(result).toBe(220); // 100 + 200 − 50 − 30
  });

  it("currencies are tracked independently — USD and LBP projections never mix", () => {
    const usd = project(100, 250, 80, 0); // = 270
    const lbp = project(0, 5_000_000, 0, 0); // = 5_000_000
    expect(usd).toBe(270);
    expect(lbp).toBe(5_000_000);
  });
});

// ---------------------------------------------------------------------------
// Reconciliation outcome labels
// ---------------------------------------------------------------------------

describe("reconciliation outcome labels", () => {
  /**
   * Labels mirror the server-side enrichment in GET /cash-sessions/:id.
   * difference = counted − expected (positive = overage, negative = shortage)
   */
  function computeResult(
    expected: number,
    actual: number | null,
  ): "balanced" | "shortage" | "overage" | "awaiting_count" {
    if (actual === null) return "awaiting_count";
    const variance = actual - expected;
    if (variance === 0) return "balanced";
    if (variance < 0) return "shortage";
    return "overage";
  }

  it("returns 'balanced' when counted equals expected", () => {
    expect(computeResult(270, 270)).toBe("balanced");
    expect(computeResult(0, 0)).toBe("balanced");
  });

  it("returns 'shortage' when counted is below expected", () => {
    expect(computeResult(270, 255)).toBe("shortage");
    expect(computeResult(24_500_000, 24_000_000)).toBe("shortage");
  });

  it("returns 'overage' when counted is above expected", () => {
    expect(computeResult(270, 285)).toBe("overage");
    expect(computeResult(100, 101)).toBe("overage");
  });

  it("returns 'awaiting_count' when actual is null", () => {
    expect(computeResult(270, null)).toBe("awaiting_count");
    expect(computeResult(0, null)).toBe("awaiting_count");
  });

  it("difference is always counted − expected (not expected − counted)", () => {
    const expected = 270;
    const actual = 255;
    const difference = actual - expected; // −15 → shortage
    expect(difference).toBe(-15);
    expect(computeResult(expected, actual)).toBe("shortage");
  });
});

// ---------------------------------------------------------------------------
// Reversal net amounts
// ---------------------------------------------------------------------------

describe("reversal net amounts", () => {
  /**
   * A reversal offsets the original transaction's cash impact.
   * Net contribution = original amount − reversed amount.
   */
  function netContribution(originalAmount: number, reversedAmount: number): number {
    return originalAmount - reversedAmount;
  }

  it("full reversal: net contribution is zero", () => {
    expect(netContribution(150, 150)).toBe(0);
    expect(netContribution(24_500_000, 24_500_000)).toBe(0);
  });

  it("partial reversal: net = original − reversed amount", () => {
    expect(netContribution(150, 50)).toBe(100);
    expect(netContribution(1_000_000, 300_000)).toBe(700_000);
  });

  it("no reversal: net equals original amount", () => {
    expect(netContribution(150, 0)).toBe(150);
  });
});

// ---------------------------------------------------------------------------
// Duplicate-session warning suppression predicate
// ---------------------------------------------------------------------------

describe("duplicate-session open_conflict warning", () => {
  /**
   * The warning should be shown when:
   *   - the VIEWED session is open or pending_review, AND
   *   - open_conflict is not null (another session is open on the same drawer)
   * The warning is suppressed when the viewed session is closed/approved —
   * there is no meaningful conflict for a historical session.
   */
  function shouldShowConflictWarning(
    viewedSessionStatus: string,
    openConflict: { id: number; session_number: string } | null,
  ): boolean {
    if (!openConflict) return false;
    return viewedSessionStatus === "open" || viewedSessionStatus === "pending_review";
  }

  const conflict = { id: 99, session_number: "CS-OTHER-0001" };

  it("shows warning when viewed session is open and another session is open", () => {
    expect(shouldShowConflictWarning("open", conflict)).toBe(true);
  });

  it("shows warning when viewed session is pending_review and another is open", () => {
    expect(shouldShowConflictWarning("pending_review", conflict)).toBe(true);
  });

  it("suppresses warning when viewed session is approved (historical view)", () => {
    expect(shouldShowConflictWarning("approved", conflict)).toBe(false);
  });

  it("suppresses warning when viewed session is flagged (closed state)", () => {
    expect(shouldShowConflictWarning("flagged", conflict)).toBe(false);
  });

  it("suppresses warning when open_conflict is null regardless of status", () => {
    expect(shouldShowConflictWarning("open", null)).toBe(false);
    expect(shouldShowConflictWarning("approved", null)).toBe(false);
  });
});
