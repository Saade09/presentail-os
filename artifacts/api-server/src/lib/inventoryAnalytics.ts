/**
 * Pure calculation helpers for the Inventory & Cost Analytics module.
 * No DB calls — fully unit-testable in isolation.
 * Sign convention: favorable = actual COGS % below theoretical and below target.
 */

export function calcTheoreticalUsage(
  preparedQty: number,
  recipeQty: number,
): number {
  return preparedQty * recipeQty;
}

export function calcTheoreticalCogs(
  theoreticalUsage: number,
  historicalUnitCost: number,
): number {
  return theoreticalUsage * historicalUnitCost;
}

export function calcTheoreticalCogsPercent(
  theoreticalCogs: number,
  netRevenue: number | null | undefined,
): number | null {
  if (!netRevenue || netRevenue === 0) return null;
  return (theoreticalCogs / netRevenue) * 100;
}

export function calcExpectedClosing(
  opening: number,
  receipts: number,
  transferIn: number,
  transferOut: number,
  returns: number,
  adjustments: number,
  recipeUsage: number,
  waste: number,
): number {
  return (
    opening +
    receipts +
    transferIn -
    transferOut +
    returns +
    adjustments -
    recipeUsage -
    waste
  );
}

export function calcStockVariance(
  countedClosing: number,
  expectedClosing: number,
): number {
  return countedClosing - expectedClosing;
}

export function calcActualConsumption(
  opening: number,
  receipts: number,
  netTransfers: number,
  adjustments: number,
  countedClosing: number,
): number {
  return opening + receipts + netTransfers + adjustments - countedClosing;
}

export function calcActualCogs(
  actualConsumption: number,
  historicalCost: number,
): number {
  return actualConsumption * historicalCost;
}

export function calcActualCogsPercent(
  actualCogs: number,
  netRevenue: number | null | undefined,
): number | null {
  if (!netRevenue || netRevenue === 0) return null;
  return (actualCogs / netRevenue) * 100;
}

export function calcCogsGap(
  actualCogsPercent: number | null,
  theoreticalCogsPercent: number | null,
): number | null {
  if (actualCogsPercent === null || theoreticalCogsPercent === null) return null;
  return actualCogsPercent - theoreticalCogsPercent;
}

export function calcCostVariance(
  actualCogs: number,
  theoreticalCogs: number,
): number {
  return actualCogs - theoreticalCogs;
}

export function calcGrossMarginPercent(
  netRevenue: number | null | undefined,
  actualCogs: number,
): number | null {
  if (!netRevenue || netRevenue === 0) return null;
  return ((netRevenue - actualCogs) / netRevenue) * 100;
}

export type VarianceDriver =
  | "purchase_price_increase"
  | "pack_size_mismatch"
  | "unrecorded_waste"
  | "stock_count_discrepancy"
  | "quantity_over_usage"
  | "mixed"
  | "none";

export function classifyVarianceDriver(
  quantityVariance: number,
  costImpact: number,
  purchasePriceMoved: boolean,
  packSizeMismatch: boolean,
  unrecordedWaste: boolean,
  stockCountDiscrepancy: boolean,
): VarianceDriver {
  if (Math.abs(costImpact) < 0.01) return "none";

  const drivers: VarianceDriver[] = [];

  if (purchasePriceMoved) drivers.push("purchase_price_increase");
  if (packSizeMismatch) drivers.push("pack_size_mismatch");
  if (unrecordedWaste) drivers.push("unrecorded_waste");
  if (stockCountDiscrepancy) drivers.push("stock_count_discrepancy");
  if (quantityVariance > 0 && drivers.length === 0)
    drivers.push("quantity_over_usage");

  if (drivers.length === 0) return "none";
  if (drivers.length === 1) return drivers[0];
  return "mixed";
}

export interface WeeklyCogsTrend {
  weekStart: string;
  actualCogsPercent: number | null;
  theoreticalCogsPercent: number | null;
  targetCogsPercent: number | null;
}

export function buildWeeklyCogsTrend(
  weeks: Array<{
    weekStart: string;
    actualCogs: number;
    theoreticalCogs: number;
    netRevenue: number;
  }>,
  targetCogsPercent: number | null,
): WeeklyCogsTrend[] {
  return weeks.map((w) => ({
    weekStart: w.weekStart,
    actualCogsPercent: calcActualCogsPercent(w.actualCogs, w.netRevenue),
    theoreticalCogsPercent: calcTheoreticalCogsPercent(w.theoreticalCogs, w.netRevenue),
    targetCogsPercent,
  }));
}

export interface StockMovementSummary {
  openingStockValue: number;
  purchases: number;
  recipeConsumption: number;
  recordedWaste: number;
  stockVariance: number;
  closingStockValue: number;
}

export function buildStockMovementSummary(
  openingStockValue: number,
  purchases: number,
  recipeConsumption: number,
  recordedWaste: number,
  manualAdjustments: number,
  netTransfers: number,
): StockMovementSummary {
  const closingStockValue =
    openingStockValue +
    purchases -
    recipeConsumption -
    recordedWaste +
    manualAdjustments +
    netTransfers;
  const stockVariance = manualAdjustments;
  return {
    openingStockValue,
    purchases,
    recipeConsumption,
    recordedWaste,
    stockVariance,
    closingStockValue,
  };
}

export function isCogsTargetFavorable(
  actualCogsPercent: number | null,
  targetCogsPercent: number | null,
): boolean | null {
  if (actualCogsPercent === null || targetCogsPercent === null) return null;
  return actualCogsPercent <= targetCogsPercent;
}

export function calcCostVariancePercent(
  actualCogs: number,
  theoreticalCogs: number,
): number | null {
  if (theoreticalCogs === 0) return null;
  return ((actualCogs - theoreticalCogs) / theoreticalCogs) * 100;
}

export function calcWasteAsPctOfPurchases(
  wasteValue: number,
  purchaseValue: number,
): number | null {
  if (purchaseValue === 0) return null;
  return (wasteValue / purchaseValue) * 100;
}

export function calcWeightedAvgCost(
  totalValue: number,
  totalQty: number,
): number | null {
  if (totalQty === 0) return null;
  return totalValue / totalQty;
}
