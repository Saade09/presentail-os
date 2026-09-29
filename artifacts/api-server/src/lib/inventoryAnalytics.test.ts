import { describe, it, expect } from "vitest";
import {
  calcTheoreticalUsage,
  calcTheoreticalCogs,
  calcTheoreticalCogsPercent,
  calcExpectedClosing,
  calcActualCogsPercent,
  calcGrossMarginPercent,
  calcCostVariance,
  calcCostVariancePercent,
  calcWasteAsPctOfPurchases,
  calcWeightedAvgCost,
  classifyVarianceDriver,
  isCogsTargetFavorable,
} from "./inventoryAnalytics";

describe("calcTheoreticalUsage", () => {
  it("multiplies prepared qty by recipe qty", () => {
    expect(calcTheoreticalUsage(10, 2.5)).toBeCloseTo(25);
  });
  it("returns 0 for zero inputs", () => {
    expect(calcTheoreticalUsage(0, 5)).toBe(0);
  });
});

describe("calcTheoreticalCogs", () => {
  it("multiplies usage by unit cost", () => {
    expect(calcTheoreticalCogs(25, 3)).toBeCloseTo(75);
  });
  it("handles zero cost", () => {
    expect(calcTheoreticalCogs(10, 0)).toBe(0);
  });
});

describe("calcTheoreticalCogsPercent", () => {
  it("computes percentage of revenue", () => {
    expect(calcTheoreticalCogsPercent(30, 100)).toBeCloseTo(30);
  });
  it("returns null when revenue is 0", () => {
    expect(calcTheoreticalCogsPercent(30, 0)).toBeNull();
  });
  it("returns null when revenue is null", () => {
    expect(calcTheoreticalCogsPercent(30, null)).toBeNull();
  });
});

describe("calcExpectedClosing", () => {
  it("computes opening + receipts + transferIn - transferOut + returns + adjustments - recipeUsage - waste", () => {
    expect(calcExpectedClosing(100, 50, 10, 5, 3, 2, 30, 5)).toBeCloseTo(125);
  });
  it("returns 0 when all zeros", () => {
    expect(calcExpectedClosing(0, 0, 0, 0, 0, 0, 0, 0)).toBe(0);
  });
  it("can return negative", () => {
    expect(calcExpectedClosing(10, 0, 0, 0, 0, 0, 20, 0)).toBeCloseTo(-10);
  });
});

describe("calcActualCogsPercent", () => {
  it("computes actual COGS %", () => {
    expect(calcActualCogsPercent(40, 200)).toBeCloseTo(20);
  });
  it("returns null for zero revenue", () => {
    expect(calcActualCogsPercent(40, 0)).toBeNull();
  });
});

describe("calcGrossMarginPercent", () => {
  it("computes (revenue - cogs) / revenue * 100", () => {
    expect(calcGrossMarginPercent(200, 60)).toBeCloseTo(70);
  });
  it("returns null for zero revenue", () => {
    expect(calcGrossMarginPercent(0, 0)).toBeNull();
  });
});

describe("calcCostVariance", () => {
  it("returns actual minus theoretical (positive = unfavorable)", () => {
    expect(calcCostVariance(80, 60)).toBeCloseTo(20);
  });
  it("returns negative when actual < theoretical (favorable)", () => {
    expect(calcCostVariance(50, 60)).toBeCloseTo(-10);
  });
});

describe("calcCostVariancePercent", () => {
  it("returns variance pct relative to theoretical", () => {
    expect(calcCostVariancePercent(80, 100)).toBeCloseTo(-20);
    expect(calcCostVariancePercent(120, 100)).toBeCloseTo(20);
  });
  it("returns null when theoretical is zero", () => {
    expect(calcCostVariancePercent(80, 0)).toBeNull();
  });
});

describe("calcWasteAsPctOfPurchases", () => {
  it("returns waste / purchases * 100", () => {
    expect(calcWasteAsPctOfPurchases(5, 100)).toBeCloseTo(5);
  });
  it("returns null for zero purchases", () => {
    expect(calcWasteAsPctOfPurchases(5, 0)).toBeNull();
  });
});

describe("calcWeightedAvgCost", () => {
  it("returns total value / total qty", () => {
    expect(calcWeightedAvgCost(300, 100)).toBeCloseTo(3);
  });
  it("returns null when qty is 0", () => {
    expect(calcWeightedAvgCost(300, 0)).toBeNull();
  });
});

describe("classifyVarianceDriver", () => {
  it("returns none when cost impact is negligible", () => {
    expect(classifyVarianceDriver(0, 0, false, false, false, false)).toBe("none");
  });
  it("returns purchase_price_increase when that flag is true and impact exists", () => {
    expect(classifyVarianceDriver(5, 20, true, false, false, false)).toBe("purchase_price_increase");
  });
  it("returns unrecorded_waste when that flag is true", () => {
    expect(classifyVarianceDriver(3, 15, false, false, true, false)).toBe("unrecorded_waste");
  });
  it("returns quantity_over_usage when positive variance and no other flags", () => {
    expect(classifyVarianceDriver(5, 10, false, false, false, false)).toBe("quantity_over_usage");
  });
  it("returns mixed when multiple flags are set", () => {
    expect(classifyVarianceDriver(5, 20, true, true, false, false)).toBe("mixed");
  });
});

describe("isCogsTargetFavorable", () => {
  it("returns true when actual pct is at or below target", () => {
    expect(isCogsTargetFavorable(28, 30)).toBe(true);
    expect(isCogsTargetFavorable(30, 30)).toBe(true);
  });
  it("returns false when actual pct is above target", () => {
    expect(isCogsTargetFavorable(32, 30)).toBe(false);
  });
  it("returns null when actual pct is null", () => {
    expect(isCogsTargetFavorable(null, 30)).toBeNull();
  });
  it("returns null when target is null", () => {
    expect(isCogsTargetFavorable(28, null)).toBeNull();
  });
});
