import { db } from "./db";

/**
 * Pure calculation module for CMC Monthly Sales.
 * No HTTP, no side effects. All figures are in USD.
 *
 * Financial formulas:
 *   gross     = sum of cmc_sales.total WHERE status = 'paid', grouped by month
 *   net       = gross / 1.11   (VAT-exclusive)
 *   commission = round(net × 0.20, 2)
 *   commissionVat = round(commission × 0.11, 2)
 *   payable   = commission + commissionVat
 */

export type MonthlySalesMode = "single" | "range" | "all_time";

export interface SalesVerification {
  qualifyingCount: number;
  refundsExcluded: number;
  unmatchedCount: number;
  lastRefreshed: string;
}

export interface AnnualSummary {
  statementCount: number;
  grossYtd: number;
  paidToDate: number;
  outstanding: number;
}

export interface MonthlySalesRow {
  month: string;
  gross: number;
  net: number;
  commission: number;
  commissionVat: number;
  payable: number;
  status: "unpaid" | "paid";
  paidAt: string | null;
  /** ISO date string: 10th of the month following the settlement month */
  dueDate: string;
}

export interface MonthlySalesTotals {
  gross: number;
  net: number;
  commission: number;
  commissionVat: number;
  payable: number;
}

export interface MonthlySalesResult {
  months: MonthlySalesRow[];
  totals: MonthlySalesTotals;
  currency: string;
  fromMonth: string | null;
  toMonth: string | null;
  /** Populated only for mode=single */
  salesVerification?: SalesVerification;
  /** Populated only for mode=all_time */
  annualSummary?: AnnualSummary;
}

const MONTH_RE = /^\d{4}-\d{2}$/;

/**
 * Validate and resolve SQL-safe month bounds from mode + params.
 * Returns { fromMonth, toMonth } — both inclusive YYYY-MM strings.
 * For all_time, both are null (no WHERE filter).
 */
export function resolveMonthBounds(
  mode: MonthlySalesMode,
  month?: string,
  from?: string,
  to?: string,
): { fromMonth: string | null; toMonth: string | null } {
  if (mode === "all_time") {
    return { fromMonth: null, toMonth: null };
  }

  if (mode === "single") {
    const m = month ?? "";
    if (!MONTH_RE.test(m)) {
      throw new Error("month param must be YYYY-MM");
    }
    return { fromMonth: m, toMonth: m };
  }

  if (mode === "range") {
    const f = from ?? "";
    const t = to ?? "";
    if (!MONTH_RE.test(f) || !MONTH_RE.test(t)) {
      throw new Error("from and to params must be YYYY-MM");
    }
    if (f > t) {
      throw new Error("from must not be after to");
    }
    return { fromMonth: f, toMonth: t };
  }

  throw new Error(`Invalid mode: ${String(mode)}`);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function deriveFinancials(gross: number): {
  net: number;
  commission: number;
  commissionVat: number;
  payable: number;
} {
  const net = gross / 1.11;
  const commission = round2(net * 0.20);
  const commissionVat = round2(commission * 0.11);
  const payable = round2(commission + commissionVat);
  return { net, commission, commissionVat, payable };
}

/**
 * Compute the due date for a settlement month: 10th of the following month.
 * e.g. "2026-07" → "2026-08-10"
 */
function computeDueDate(month: string): string {
  const [yearStr, monthStr] = month.split("-");
  const year = parseInt(yearStr, 10);
  const monthNum = parseInt(monthStr, 10);
  const nextYear = monthNum === 12 ? year + 1 : year;
  const nextMonth = monthNum === 12 ? 1 : monthNum + 1;
  return `${nextYear}-${String(nextMonth).padStart(2, "0")}-10`;
}

/**
 * Query monthly sales data for a workspace.
 * Only includes paid sales (status = 'paid') by fulfilment_date month.
 * Enforces USD.
 */
export async function computeMonthlySales(
  workspaceOwnerId: string,
  mode: MonthlySalesMode,
  month?: string,
  from?: string,
  to?: string,
): Promise<MonthlySalesResult> {
  const { fromMonth, toMonth } = resolveMonthBounds(mode, month, from, to);

  const params: unknown[] = [workspaceOwnerId];
  const conditions: string[] = [
    "s.workspace_owner_id = $1",
    "s.status = 'paid'",
    "s.fulfilment_date IS NOT NULL",
  ];

  if (fromMonth !== null) {
    params.push(`${fromMonth}-01`);
    conditions.push(`s.fulfilment_date >= $${params.length}::date`);
  }
  if (toMonth !== null) {
    const [y, m] = toMonth.split("-").map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    params.push(`${toMonth}-${String(lastDay).padStart(2, "0")}`);
    conditions.push(`s.fulfilment_date <= $${params.length}::date`);
  }

  const where = conditions.join(" AND ");

  const salesResult = await db.query(
    `SELECT
       to_char(s.fulfilment_date, 'YYYY-MM') AS month,
       COALESCE(SUM(s.total), 0) AS gross_sum
     FROM cmc_sales s
     WHERE ${where}
     GROUP BY to_char(s.fulfilment_date, 'YYYY-MM')
     ORDER BY month DESC`,
    params,
  );

  const monthLabels = salesResult.rows.map((r) => r.month as string);

  let settlementsMap: Map<string, { status: string; paidAt: string | null }> = new Map();

  if (monthLabels.length > 0) {
    const placeholders = monthLabels.map((_, i) => `$${i + 2}`).join(", ");
    const settlementResult = await db.query(
      `SELECT settlement_month, status, paid_at
         FROM cmc_monthly_settlements
        WHERE workspace_owner_id = $1
          AND settlement_month IN (${placeholders})`,
      [workspaceOwnerId, ...monthLabels],
    );
    for (const row of settlementResult.rows) {
      settlementsMap.set(row.settlement_month as string, {
        status: row.status as string,
        paidAt: row.paid_at ? String(row.paid_at) : null,
      });
    }
  }

  const months: MonthlySalesRow[] = salesResult.rows.map((r) => {
    const gross = parseFloat(r.gross_sum as string);
    const { net, commission, commissionVat, payable } = deriveFinancials(gross);
    const settlement = settlementsMap.get(r.month as string);
    return {
      month: r.month as string,
      gross,
      net,
      commission,
      commissionVat,
      payable,
      status: (settlement?.status ?? "unpaid") as "unpaid" | "paid",
      paidAt: settlement?.paidAt ?? null,
      dueDate: computeDueDate(r.month as string),
    };
  });

  const totalGross = months.reduce((s, m) => s + m.gross, 0);
  const {
    net: totalNet,
    commission: totalCommission,
    commissionVat: totalCommissionVat,
    payable: totalPayable,
  } = deriveFinancials(totalGross);

  // Sales verification for single mode
  let salesVerification: SalesVerification | undefined;
  if (mode === "single" && month) {
    const [y, mo] = month.split("-").map(Number);
    const lastDay = new Date(y, mo, 0).getDate();
    const startDate = `${month}-01`;
    const endDate = `${month}-${String(lastDay).padStart(2, "0")}`;

    const verResult = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'paid') AS qualifying_count,
         COUNT(*) FILTER (WHERE status IN ('voided', 'refunded')) AS refunds_excluded
       FROM cmc_sales
       WHERE workspace_owner_id = $1
         AND fulfilment_date IS NOT NULL
         AND fulfilment_date >= $2::date
         AND fulfilment_date <= $3::date`,
      [workspaceOwnerId, startDate, endDate],
    );
    const vr = verResult.rows[0];
    salesVerification = {
      qualifyingCount: parseInt(vr.qualifying_count as string, 10),
      refundsExcluded: parseInt(vr.refunds_excluded as string, 10),
      unmatchedCount: 0,
      lastRefreshed: new Date().toISOString(),
    };
  }

  // Annual summary for all_time mode
  let annualSummary: AnnualSummary | undefined;
  if (mode === "all_time") {
    const currentYear = new Date().getFullYear();
    const currentYearStr = String(currentYear);
    const grossYtd = months
      .filter((m) => m.month.startsWith(currentYearStr))
      .reduce((s, m) => s + m.gross, 0);
    const paidToDate = months
      .filter((m) => m.status === "paid")
      .reduce((s, m) => s + m.payable, 0);
    const outstanding = months
      .filter((m) => m.status !== "paid")
      .reduce((s, m) => s + m.payable, 0);
    annualSummary = {
      statementCount: months.length,
      grossYtd: round2(grossYtd),
      paidToDate: round2(paidToDate),
      outstanding: round2(outstanding),
    };
  }

  return {
    months,
    totals: {
      gross: totalGross,
      net: totalNet,
      commission: totalCommission,
      commissionVat: totalCommissionVat,
      payable: totalPayable,
    },
    currency: "USD",
    fromMonth,
    toMonth,
    salesVerification,
    annualSummary,
  };
}

/**
 * Build a plain-text summary for the monthly report email.
 */
export function buildMonthlyReportEmailText(
  reportMonth: string,
  result: MonthlySalesResult,
): string {
  const { totals } = result;
  return [
    `CMC Monthly Sales Report — ${reportMonth}`,
    "",
    `Period: ${reportMonth}`,
    `Currency: USD (all figures)`,
    "",
    `Gross Revenue (VAT incl.): $${totals.gross.toFixed(2)}`,
    `Net Sales (excl. VAT):      $${totals.net.toFixed(2)}`,
    `Commission (20% of net):    $${totals.commission.toFixed(2)}`,
    `Commission VAT (11%):       $${totals.commissionVat.toFixed(2)}`,
    `Total Payable to CMC:       $${totals.payable.toFixed(2)}`,
    "",
    "See attached PDF for the full monthly breakdown.",
  ].join("\n");
}

/**
 * Build the HTML for the monthly report email body.
 */
export function buildMonthlyReportEmailHtml(
  reportMonth: string,
  result: MonthlySalesResult,
): string {
  const { totals } = result;
  const fmt = (n: number) => `$${n.toFixed(2)}`;

  const rows = result.months
    .map(
      (m) =>
        `<tr>
          <td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;">${m.month}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;text-align:right;">${fmt(m.gross)}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;text-align:right;">${fmt(m.net)}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;text-align:right;">${fmt(m.payable)}</td>
          <td style="padding:6px 12px;border-bottom:1px solid #e5e7eb;text-align:center;">${m.status === "paid" ? "✓ Paid" : "Unpaid"}</td>
        </tr>`,
    )
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8" /><title>CMC Monthly Sales Report — ${reportMonth}</title></head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:40px 0;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;">
        <tr><td style="background:#0A404E;padding:28px 32px;">
          <span style="color:#ffffff;font-size:20px;font-weight:700;">CMC Monthly Sales Report</span><br/>
          <span style="color:#a5d6df;font-size:14px;">${reportMonth}</span>
        </td></tr>
        <tr><td style="padding:28px 32px;">
          <p style="margin:0 0 20px;color:#374151;font-size:14px;">Here is the CMC monthly sales summary for <strong>${reportMonth}</strong>.</p>
          <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
            <thead>
              <tr style="background:#f9fafb;">
                <th style="padding:8px 12px;text-align:left;font-size:12px;color:#6b7280;border-bottom:1px solid #e5e7eb;">Month</th>
                <th style="padding:8px 12px;text-align:right;font-size:12px;color:#6b7280;border-bottom:1px solid #e5e7eb;">Gross</th>
                <th style="padding:8px 12px;text-align:right;font-size:12px;color:#6b7280;border-bottom:1px solid #e5e7eb;">Net</th>
                <th style="padding:8px 12px;text-align:right;font-size:12px;color:#6b7280;border-bottom:1px solid #e5e7eb;">Payable</th>
                <th style="padding:8px 12px;text-align:center;font-size:12px;color:#6b7280;border-bottom:1px solid #e5e7eb;">Status</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:20px;background:#f0f9fa;border-radius:8px;padding:16px;">
            <tr>
              <td style="font-size:13px;color:#374151;padding:4px 0;">Gross Revenue (VAT incl.)</td>
              <td style="font-size:13px;font-weight:600;text-align:right;padding:4px 0;">${fmt(totals.gross)}</td>
            </tr>
            <tr>
              <td style="font-size:13px;color:#374151;padding:4px 0;">Net Sales (excl. VAT)</td>
              <td style="font-size:13px;font-weight:600;text-align:right;padding:4px 0;">${fmt(totals.net)}</td>
            </tr>
            <tr>
              <td style="font-size:13px;color:#374151;padding:4px 0;">Commission (20% of net)</td>
              <td style="font-size:13px;font-weight:600;text-align:right;padding:4px 0;">${fmt(totals.commission)}</td>
            </tr>
            <tr>
              <td style="font-size:13px;color:#374151;padding:4px 0;">Commission VAT (11%)</td>
              <td style="font-size:13px;font-weight:600;text-align:right;padding:4px 0;">${fmt(totals.commissionVat)}</td>
            </tr>
            <tr style="border-top:2px solid #0A404E;">
              <td style="font-size:14px;font-weight:700;color:#0A404E;padding:8px 0 4px;">Total Payable to CMC</td>
              <td style="font-size:14px;font-weight:700;color:#0A404E;text-align:right;padding:8px 0 4px;">${fmt(totals.payable)}</td>
            </tr>
          </table>
          <p style="margin:20px 0 0;font-size:12px;color:#9ca3af;">The full breakdown PDF is attached to this email. All figures are in USD.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
