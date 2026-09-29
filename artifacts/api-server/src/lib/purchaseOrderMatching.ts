/**
 * Three-way matching library for Purchase Orders.
 * Pure functions — no DB access, fully unit-testable.
 */

export type MatchFieldStatus = "ok" | "warning" | "error" | "missing";

export type DiscrepancyDescriptor = {
  field: string;
  expected: string;
  actual: string;
  severity: "warning" | "error";
};

export type ThreeWayMatchResult = {
  overallStatus: InvoiceCoverageStatus;
  readyForApproval: boolean;
  checks: {
    currency: MatchFieldStatus;
    totalOrdered: MatchFieldStatus;
    totalReceived: MatchFieldStatus;
    totalInvoiced: MatchFieldStatus;
    quantitiesOrdered: MatchFieldStatus;
    quantitiesReceived: MatchFieldStatus;
  };
  summary: {
    poAmount: number | null;
    poAmountCurrency: string;
    receivedAmount: number | null;
    invoicedAmount: number | null;
    invoiceCurrency: string | null;
    totalLinkedInvoices: number;
    fullyReceivedItems: number;
    totalLineItems: number;
  };
  discrepancies: DiscrepancyDescriptor[];
};

export type InvoiceCoverageStatus =
  | "awaiting_invoice"
  | "partially_invoiced"
  | "fully_invoiced"
  | "matched"
  | "difference_found";

type PoLineItem = {
  quantity: string | number;
  unit_price: string | number;
  received_quantity: string | number | null;
};

type LinkedInvoice = {
  grand_total: string | number | null;
  amount: string | number;
  currency: string;
  payment_status?: string | null;
};

type PoInput = {
  currency: string;
  grand_total_amount: string | number | null;
  effective_total?: string | number | null;
};

/** Match tolerance: amounts within 1% (or <0.05 absolute) are considered matched. */
const AMOUNT_TOLERANCE_PCT = 0.01;
const AMOUNT_TOLERANCE_ABS = 0.05;

function toNum(v: string | number | null | undefined): number {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : parseFloat(v);
  return isNaN(n) ? 0 : n;
}

function amountsMatch(a: number, b: number): boolean {
  if (a === 0 && b === 0) return true;
  const abs = Math.abs(a - b);
  if (abs <= AMOUNT_TOLERANCE_ABS) return true;
  const ref = Math.max(Math.abs(a), Math.abs(b), 0.01);
  return abs / ref <= AMOUNT_TOLERANCE_PCT;
}

/**
 * Compute the three-way match result for a purchase order.
 *
 * @param po            Purchase order header (currency, grand total)
 * @param lineItems     PO line items (quantity, unit_price, received_quantity)
 * @param linkedInvoices Invoices linked to this PO via purchase_order_invoices
 */
export function computeThreeWayMatch(
  po: PoInput,
  lineItems: PoLineItem[],
  linkedInvoices: LinkedInvoice[],
): ThreeWayMatchResult {
  const discrepancies: DiscrepancyDescriptor[] = [];

  // ----- PO amount -----
  const poAmount = toNum(po.grand_total_amount ?? po.effective_total);

  // ----- Ordered totals -----
  const orderedTotal = lineItems.reduce(
    (sum, li) => sum + toNum(li.quantity) * toNum(li.unit_price),
    0,
  );

  // ----- Received totals -----
  const receivedTotal = lineItems.reduce(
    (sum, li) => sum + toNum(li.received_quantity) * toNum(li.unit_price),
    0,
  );

  const fullyReceivedItems = lineItems.filter(
    (li) => toNum(li.received_quantity) >= toNum(li.quantity),
  ).length;
  const totalLineItems = lineItems.length;

  // ----- Invoiced totals -----
  const totalLinkedInvoices = linkedInvoices.length;

  // All invoiced amounts (use grand_total if present, else fall back to amount)
  const invoicedAmounts = linkedInvoices.map((inv) => {
    const gt = toNum(inv.grand_total);
    return gt > 0 ? gt : toNum(inv.amount);
  });
  const invoicedTotal = invoicedAmounts.reduce((s, v) => s + v, 0);

  // Detect currency mismatch — check that all linked invoices share the PO currency
  const invoiceCurrencies = [...new Set(linkedInvoices.map((inv) => inv.currency))];
  const invoiceCurrency = invoiceCurrencies.length === 1 ? invoiceCurrencies[0] : null;
  let currencyStatus: MatchFieldStatus = "ok";
  if (totalLinkedInvoices > 0) {
    for (const inv of linkedInvoices) {
      if (inv.currency !== po.currency) {
        currencyStatus = "warning";
        discrepancies.push({
          field: "currency",
          expected: po.currency,
          actual: inv.currency,
          severity: "warning",
        });
        break;
      }
    }
    if (invoiceCurrencies.length > 1) {
      currencyStatus = "error";
    }
  }

  // ----- Determine overall status -----
  if (totalLinkedInvoices === 0) {
    return {
      overallStatus: "awaiting_invoice",
      readyForApproval: false,
      checks: {
        currency: "missing",
        totalOrdered: poAmount > 0 ? "ok" : "missing",
        totalReceived: fullyReceivedItems === totalLineItems && totalLineItems > 0 ? "ok" : "missing",
        totalInvoiced: "missing",
        quantitiesOrdered: totalLineItems > 0 ? "ok" : "missing",
        quantitiesReceived: fullyReceivedItems === totalLineItems && totalLineItems > 0 ? "ok" : "warning",
      },
      summary: {
        poAmount,
        poAmountCurrency: po.currency,
        receivedAmount: receivedTotal,
        invoicedAmount: null,
        invoiceCurrency: null,
        totalLinkedInvoices: 0,
        fullyReceivedItems,
        totalLineItems,
      },
      discrepancies: [],
    };
  }

  // Check if invoiced total covers the PO amount
  const amountsOk = amountsMatch(poAmount, invoicedTotal);
  let totalInvoicedStatus: MatchFieldStatus;
  if (amountsOk) {
    totalInvoicedStatus = "ok";
  } else if (invoicedTotal < poAmount) {
    totalInvoicedStatus = "warning";
    const diff = (poAmount - invoicedTotal).toFixed(2);
    discrepancies.push({
      field: "total_invoiced",
      expected: poAmount.toFixed(2),
      actual: invoicedTotal.toFixed(2),
      severity: "warning",
    });
    void diff;
  } else {
    totalInvoicedStatus = "error";
    discrepancies.push({
      field: "total_invoiced",
      expected: poAmount.toFixed(2),
      actual: invoicedTotal.toFixed(2),
      severity: "error",
    });
  }

  // Check received quantities vs ordered
  const allReceived = fullyReceivedItems === totalLineItems && totalLineItems > 0;
  const quantitiesReceivedStatus: MatchFieldStatus =
    totalLineItems === 0 ? "missing" :
    allReceived ? "ok" : "warning";

  if (!allReceived && totalLineItems > 0) {
    discrepancies.push({
      field: "quantities_received",
      expected: `${totalLineItems} items fully received`,
      actual: `${fullyReceivedItems}/${totalLineItems} items received`,
      severity: "warning",
    });
  }

  // Check ordered total vs PO grand total
  let totalOrderedStatus: MatchFieldStatus = "ok";
  if (poAmount > 0 && !amountsMatch(orderedTotal, poAmount)) {
    totalOrderedStatus = "warning";
  }

  // Determine overall status
  let overallStatus: InvoiceCoverageStatus;
  const fullyInvoiced = amountsOk;
  const hasCurrencyMismatch = currencyStatus === "error" || discrepancies.some((d) => d.field === "currency");
  const hasAmountMismatch = totalInvoicedStatus === "error" || (totalInvoicedStatus === "warning" && invoicedTotal > poAmount);

  if (!fullyInvoiced && invoicedTotal < poAmount) {
    overallStatus = "partially_invoiced";
  } else if (hasAmountMismatch || hasCurrencyMismatch) {
    overallStatus = "difference_found";
  } else if (fullyInvoiced && allReceived && currencyStatus === "ok") {
    overallStatus = "matched";
  } else if (fullyInvoiced) {
    overallStatus = "fully_invoiced";
  } else {
    overallStatus = "difference_found";
  }

  const readyForApproval = overallStatus === "matched";

  return {
    overallStatus,
    readyForApproval,
    checks: {
      currency: currencyStatus,
      totalOrdered: totalOrderedStatus,
      totalReceived: receivedTotal > 0 ? "ok" : "missing",
      totalInvoiced: totalInvoicedStatus,
      quantitiesOrdered: totalLineItems > 0 ? "ok" : "missing",
      quantitiesReceived: quantitiesReceivedStatus,
    },
    summary: {
      poAmount,
      poAmountCurrency: po.currency,
      receivedAmount: receivedTotal,
      invoicedAmount: invoicedTotal,
      invoiceCurrency: invoiceCurrency ?? (invoiceCurrencies[0] ?? null),
      totalLinkedInvoices,
      fullyReceivedItems,
      totalLineItems,
    },
    discrepancies,
  };
}

/**
 * Compute a concise invoice coverage status from PO + linked invoices.
 * Lighter version that doesn't need line items — used for list/card views.
 */
export function computeInvoiceCoverageStatus(
  po: PoInput,
  linkedInvoices: LinkedInvoice[],
  lineItems: PoLineItem[],
): InvoiceCoverageStatus {
  return computeThreeWayMatch(po, lineItems, linkedInvoices).overallStatus;
}

/** Human-readable label for a coverage status. */
export const INVOICE_COVERAGE_LABELS: Record<InvoiceCoverageStatus, string> = {
  awaiting_invoice: "Awaiting invoice",
  partially_invoiced: "Partially invoiced",
  fully_invoiced: "Fully invoiced",
  matched: "Matched",
  difference_found: "Difference found",
};
