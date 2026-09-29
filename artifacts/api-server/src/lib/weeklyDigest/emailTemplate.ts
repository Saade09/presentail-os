// ---------------------------------------------------------------------------
// Weekly Sales Digest — inline-styled HTML email template (task #2830)
// Follows the email.ts template-literal pattern: tables only, no external
// CSS/JS, all styles inline so it renders in common email clients.
// ---------------------------------------------------------------------------

import type {
  WeeklyDigestData,
  WeeklyMetrics,
  BreakdownRow,
  CmcWeeklyMetrics,
} from "./aggregate";
import { pctChange } from "./aggregate";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const usdFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

function usd(n: number): string {
  return usdFmt.format(n);
}

function pctLabel(value: number | null): string {
  if (value == null) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}

function deltaCell(current: number, previous: number, invert = false): string {
  const delta = pctChange(current, previous);
  let color = "#6b7280";
  if (delta != null && Math.abs(delta) >= 0.05) {
    const good = invert ? delta < 0 : delta > 0;
    color = good ? "#059669" : "#dc2626";
  }
  return `<td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:right;color:${color};font-weight:600;">${pctLabel(delta)}</td>`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function shortDate(d: Date): string {
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** e.g. "Jun 29–Jul 5" — end shown as the Sunday (window.end − 1 day). */
export function formatWeekRange(data: WeeklyDigestData): string {
  const start = data.window.start;
  const sunday = new Date(data.window.end.getTime() - 86_400_000);
  return `${shortDate(start)}\u2013${shortDate(sunday)}`;
}

export function buildWeeklyDigestSubject(data: WeeklyDigestData): string {
  return `Presentail Weekly Sales Report — Week ${data.weekNumber} | ${formatWeekRange(data)}`;
}

// ── Section building blocks ─────────────────────────────────────────────────

const H2 = `margin:28px 0 10px;font-size:16px;color:#111827;`;
const TABLE = `width:100%;border-collapse:collapse;font-size:13px;color:#374151;`;
const TH = `padding:8px 12px;background:#f9fafb;border-bottom:2px solid #e5e7eb;text-align:left;font-weight:600;color:#6b7280;text-transform:uppercase;font-size:11px;letter-spacing:0.04em;`;
const THR = TH + `text-align:right;`;
const TD = `padding:8px 12px;border-bottom:1px solid #e5e7eb;`;
const TDR = TD + `text-align:right;`;

function section(title: string, body: string): string {
  return `<h2 style="${H2}">${escapeHtml(title)}</h2>${body}`;
}

function comingSoon(title: string, note: string): string {
  return `
    <h2 style="${H2}">${escapeHtml(title)}</h2>
    <div style="padding:12px 16px;background:#f9fafb;border:1px dashed #d1d5db;border-radius:8px;color:#9ca3af;font-size:13px;">
      ${escapeHtml(note)} <span style="display:inline-block;margin-left:6px;padding:2px 8px;background:#e5e7eb;border-radius:9999px;font-size:11px;color:#6b7280;">Coming soon</span>
    </div>`;
}

function breakdownTable(
  rows: BreakdownRow[],
  prevRows: BreakdownRow[],
  labelHeader: string,
  showOrders = true,
): string {
  if (rows.length === 0) {
    return `<div style="padding:10px 12px;color:#9ca3af;font-size:13px;">No data this week.</div>`;
  }
  const prevMap = new Map(prevRows.map((r) => [r.label, r]));
  const body = rows
    .map((r) => {
      const prev = prevMap.get(r.label);
      return `<tr>
        <td style="${TD}">${escapeHtml(r.label)}</td>
        ${showOrders ? `<td style="${TDR}">${r.orders}</td>` : ""}
        <td style="${TDR}">${usd(r.salesUsd)}</td>
        ${deltaCell(r.salesUsd, prev?.salesUsd ?? 0)}
      </tr>`;
    })
    .join("");
  return `<table style="${TABLE}" cellpadding="0" cellspacing="0">
    <tr><th style="${TH}">${escapeHtml(labelHeader)}</th>${showOrders ? `<th style="${THR}">Orders</th>` : ""}<th style="${THR}">Sales</th><th style="${THR}">vs prev</th></tr>
    ${body}
  </table>`;
}

function summaryTable(cur: WeeklyMetrics, prev: WeeklyMetrics): string {
  const row = (
    label: string,
    curVal: string,
    prevVal: string,
    curNum: number,
    prevNum: number,
    invert = false,
  ) => `<tr>
      <td style="${TD}font-weight:600;color:#111827;">${escapeHtml(label)}</td>
      <td style="${TDR}font-weight:600;">${curVal}</td>
      <td style="${TDR}color:#6b7280;">${prevVal}</td>
      ${deltaCell(curNum, prevNum, invert)}
    </tr>`;

  return `<table style="${TABLE}" cellpadding="0" cellspacing="0">
    <tr><th style="${TH}">Metric</th><th style="${THR}">This week</th><th style="${THR}">Previous week</th><th style="${THR}">Change</th></tr>
    ${row("Gross Sales", usd(cur.grossSalesUsd), usd(prev.grossSalesUsd), cur.grossSalesUsd, prev.grossSalesUsd)}
    ${row("Net Sales", usd(cur.netSalesUsd), usd(prev.netSalesUsd), cur.netSalesUsd, prev.netSalesUsd)}
    ${row("Orders", String(cur.orders), String(prev.orders), cur.orders, prev.orders)}
    ${row("AOV", usd(cur.aovUsd), usd(prev.aovUsd), cur.aovUsd, prev.aovUsd)}
    ${row(
      "Gross Margin",
      cur.grossMarginPct != null ? `${cur.grossMarginPct.toFixed(1)}%` : "—",
      prev.grossMarginPct != null ? `${prev.grossMarginPct.toFixed(1)}%` : "—",
      cur.grossMarginPct ?? 0,
      prev.grossMarginPct ?? 0,
    )}
    ${row("COGS", usd(cur.cogsUsd), usd(prev.cogsUsd), cur.cogsUsd, prev.cogsUsd, true)}
  </table>`;
}

function bestSellersTable(cur: WeeklyMetrics): string {
  if (cur.bestSellers.length === 0) {
    return `<div style="padding:10px 12px;color:#9ca3af;font-size:13px;">No product sales this week.</div>`;
  }
  const rows = cur.bestSellers
    .map((b, i) => {
      const badge = b.isNew
        ? ` <span style="display:inline-block;margin-left:6px;padding:2px 8px;background:#dbeafe;border-radius:9999px;font-size:11px;color:#1d4ed8;font-weight:600;">New best-seller</span>`
        : "";
      return `<tr>
        <td style="${TD}color:#9ca3af;">${i + 1}</td>
        <td style="${TD}">${escapeHtml(b.name)}${badge}</td>
        <td style="${TDR}">${b.units}</td>
        <td style="${TDR}">${usd(b.salesUsd)}</td>
        <td style="${TDR}">${b.marginPct != null ? `${b.marginPct.toFixed(1)}%` : "—"}</td>
      </tr>`;
    })
    .join("");
  return `<table style="${TABLE}" cellpadding="0" cellspacing="0">
    <tr><th style="${TH}">#</th><th style="${TH}">Product</th><th style="${THR}">Units</th><th style="${THR}">Sales</th><th style="${THR}">Margin</th></tr>
    ${rows}
  </table>`;
}

function customersSection(cur: WeeklyMetrics, prev: WeeklyMetrics): string {
  return `<table style="${TABLE}" cellpadding="0" cellspacing="0">
    <tr><th style="${TH}">Metric</th><th style="${THR}">This week</th><th style="${THR}">Previous week</th><th style="${THR}">Change</th></tr>
    <tr><td style="${TD}">New customers</td><td style="${TDR}">${cur.newCustomers}</td><td style="${TDR}color:#6b7280;">${prev.newCustomers}</td>${deltaCell(cur.newCustomers, prev.newCustomers)}</tr>
    <tr><td style="${TD}">Returning customers</td><td style="${TDR}">${cur.returningCustomers}</td><td style="${TDR}color:#6b7280;">${prev.returningCustomers}</td>${deltaCell(cur.returningCustomers, prev.returningCustomers)}</tr>
    <tr><td style="${TD}">Repeat rate</td><td style="${TDR}">${cur.repeatRatePct != null ? `${cur.repeatRatePct.toFixed(1)}%` : "—"}</td><td style="${TDR}color:#6b7280;">${prev.repeatRatePct != null ? `${prev.repeatRatePct.toFixed(1)}%` : "—"}</td>${deltaCell(cur.repeatRatePct ?? 0, prev.repeatRatePct ?? 0)}</tr>
    <tr><td style="${TD}">Guest orders</td><td style="${TDR}">${cur.guestOrders}</td><td style="${TDR}color:#6b7280;">${prev.guestOrders}</td>${deltaCell(cur.guestOrders, prev.guestOrders)}</tr>
    <tr><td style="${TD}">Registered-customer orders</td><td style="${TDR}">${cur.registeredOrders}</td><td style="${TDR}color:#6b7280;">${prev.registeredOrders}</td>${deltaCell(cur.registeredOrders, prev.registeredOrders)}</tr>
  </table>`;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function dailyTable(cur: WeeklyMetrics): string {
  const rows = cur.daily
    .map((d) => {
      const day = new Date(`${d.date}T00:00:00Z`);
      return `<tr>
        <td style="${TD}">${DAY_NAMES[day.getUTCDay()]} ${escapeHtml(shortDate(day))}</td>
        <td style="${TDR}">${d.orders}</td>
        <td style="${TDR}">${usd(d.salesUsd)}</td>
      </tr>`;
    })
    .join("");
  return `<table style="${TABLE}" cellpadding="0" cellspacing="0">
    <tr><th style="${TH}">Day</th><th style="${THR}">Orders</th><th style="${THR}">Sales</th></tr>
    ${rows}
  </table>`;
}

function adjustmentsSection(cur: WeeklyMetrics, prev: WeeklyMetrics): string {
  return `<table style="${TABLE}" cellpadding="0" cellspacing="0">
    <tr><th style="${TH}">Metric</th><th style="${THR}">This week</th><th style="${THR}">Previous week</th><th style="${THR}">Change</th></tr>
    <tr><td style="${TD}">Discounts given</td><td style="${TDR}">${usd(cur.discountsUsd)}</td><td style="${TDR}color:#6b7280;">${usd(prev.discountsUsd)}</td>${deltaCell(cur.discountsUsd, prev.discountsUsd, true)}</tr>
    <tr><td style="${TD}">Coupon redemptions</td><td style="${TDR}">${cur.couponRedemptions}</td><td style="${TDR}color:#6b7280;">${prev.couponRedemptions}</td>${deltaCell(cur.couponRedemptions, prev.couponRedemptions)}</tr>
    <tr><td style="${TD}">Refunded orders</td><td style="${TDR}">${cur.refundedOrders} (${usd(cur.refundedUsd)})</td><td style="${TDR}color:#6b7280;">${prev.refundedOrders} (${usd(prev.refundedUsd)})</td>${deltaCell(cur.refundedUsd, prev.refundedUsd, true)}</tr>
    <tr><td style="${TD}">Cancelled orders</td><td style="${TDR}">${cur.cancelledOrders} (${usd(cur.cancelledUsd)})</td><td style="${TDR}color:#6b7280;">${prev.cancelledOrders} (${usd(prev.cancelledUsd)})</td>${deltaCell(cur.cancelledUsd, prev.cancelledUsd, true)}</tr>
  </table>`;
}

function hoursLabel(h: number | null): string {
  if (h == null) return "—";
  return `${h.toFixed(1)} h`;
}

function deliverySection(cur: WeeklyMetrics, prev: WeeklyMetrics): string {
  const d = cur.delivery;
  const p = prev.delivery;
  const pct = (v: number | null) => (v != null ? `${v.toFixed(1)}%` : "—");
  const note =
    d.onTimeRatePct == null && d.avgDeliveryTimeHours == null
      ? `<div style="margin-top:8px;padding:8px 12px;color:#9ca3af;font-size:12px;">On-time rate and average delivery time need delivered-at timestamps (Tookan) — no timed deliveries were recorded this week.</div>`
      : "";
  return `<table style="${TABLE}" cellpadding="0" cellspacing="0">
    <tr><th style="${TH}">Metric</th><th style="${THR}">This week</th><th style="${THR}">Previous week</th><th style="${THR}">Change</th></tr>
    <tr><td style="${TD}">On-time delivery rate</td><td style="${TDR}">${pct(d.onTimeRatePct)}</td><td style="${TDR}color:#6b7280;">${pct(p.onTimeRatePct)}</td>${deltaCell(d.onTimeRatePct ?? 0, p.onTimeRatePct ?? 0)}</tr>
    <tr><td style="${TD}">Late deliveries</td><td style="${TDR}">${d.lateDeliveries}</td><td style="${TDR}color:#6b7280;">${p.lateDeliveries}</td>${deltaCell(d.lateDeliveries, p.lateDeliveries, true)}</tr>
    <tr><td style="${TD}">Same-day orders</td><td style="${TDR}">${d.sameDayOrders}</td><td style="${TDR}color:#6b7280;">${p.sameDayOrders}</td>${deltaCell(d.sameDayOrders, p.sameDayOrders)}</tr>
    <tr><td style="${TD}">Express orders</td><td style="${TDR}">${d.expressOrders}</td><td style="${TDR}color:#6b7280;">${p.expressOrders}</td>${deltaCell(d.expressOrders, p.expressOrders)}</tr>
    <tr><td style="${TD}">Avg delivery time (order → delivered)</td><td style="${TDR}">${hoursLabel(d.avgDeliveryTimeHours)}</td><td style="${TDR}color:#6b7280;">${hoursLabel(p.avgDeliveryTimeHours)}</td>${deltaCell(d.avgDeliveryTimeHours ?? 0, p.avgDeliveryTimeHours ?? 0, true)}</tr>
  </table>${note}`;
}

function cmcSalesSection(cur: CmcWeeklyMetrics, prev: CmcWeeklyMetrics): string {
  if (cur.saleCount === 0 && prev.saleCount === 0) {
    return `<div style="padding:10px 12px;color:#9ca3af;font-size:13px;">No CMC POS sales this week.</div>`;
  }
  const row = (
    label: string,
    curVal: string,
    prevVal: string,
    curNum: number,
    prevNum: number,
    invert = false,
  ) => `<tr>
      <td style="${TD}">${escapeHtml(label)}</td>
      <td style="${TDR}font-weight:600;">${curVal}</td>
      <td style="${TDR}color:#6b7280;">${prevVal}</td>
      ${deltaCell(curNum, prevNum, invert)}
    </tr>`;
  return `<table style="${TABLE}" cellpadding="0" cellspacing="0">
    <tr><th style="${TH}">Metric</th><th style="${THR}">This week</th><th style="${THR}">Previous week</th><th style="${THR}">Change</th></tr>
    ${row("Sales count", String(cur.saleCount), String(prev.saleCount), cur.saleCount, prev.saleCount)}
    ${row("Gross sales (VAT incl.)", usd(cur.grossSalesUsd), usd(prev.grossSalesUsd), cur.grossSalesUsd, prev.grossSalesUsd)}
    ${row("Net sales (VAT excl.)", usd(cur.netSalesUsd), usd(prev.netSalesUsd), cur.netSalesUsd, prev.netSalesUsd)}
    ${row("Commission (20% of net)", usd(cur.commissionUsd), usd(prev.commissionUsd), cur.commissionUsd, prev.commissionUsd)}
    ${row("Commission VAT (11%)", usd(cur.commissionVatUsd), usd(prev.commissionVatUsd), cur.commissionVatUsd, prev.commissionVatUsd)}
    ${row("Total payable to CMC", usd(cur.payableUsd), usd(prev.payableUsd), cur.payableUsd, prev.payableUsd)}
  </table>`;
}

function funnelSection(cur: WeeklyMetrics, prev: WeeklyMetrics): string {
  const f = cur.funnel;
  const p = prev.funnel;
  if (!f.tracked && !p.tracked) {
    return `<div style="padding:10px 12px;color:#9ca3af;font-size:13px;">No storefront view events were recorded this week — product view and conversion metrics appear once the website pushes analytics events.</div>`;
  }
  const pct = (v: number | null) => (v != null ? `${v.toFixed(1)}%` : "—");
  return `<table style="${TABLE}" cellpadding="0" cellspacing="0">
    <tr><th style="${TH}">Metric</th><th style="${THR}">This week</th><th style="${THR}">Previous week</th><th style="${THR}">Change</th></tr>
    <tr><td style="${TD}">Product views</td><td style="${TDR}">${f.productViews.toLocaleString("en-US")}</td><td style="${TDR}color:#6b7280;">${p.productViews.toLocaleString("en-US")}</td>${deltaCell(f.productViews, p.productViews)}</tr>
    <tr><td style="${TD}">Add-to-carts</td><td style="${TDR}">${f.addToCarts.toLocaleString("en-US")}</td><td style="${TDR}color:#6b7280;">${p.addToCarts.toLocaleString("en-US")}</td>${deltaCell(f.addToCarts, p.addToCarts)}</tr>
    <tr><td style="${TD}">Add-to-cart rate</td><td style="${TDR}">${pct(f.addToCartRatePct)}</td><td style="${TDR}color:#6b7280;">${pct(p.addToCartRatePct)}</td>${deltaCell(f.addToCartRatePct ?? 0, p.addToCartRatePct ?? 0)}</tr>
    <tr><td style="${TD}">Product conversion rate</td><td style="${TDR}">${pct(f.conversionRatePct)}</td><td style="${TDR}color:#6b7280;">${pct(p.conversionRatePct)}</td>${deltaCell(f.conversionRatePct ?? 0, p.conversionRatePct ?? 0)}</tr>
  </table>`;
}

function bulletList(items: string[], accent: string): string {
  if (items.length === 0) {
    return `<div style="padding:10px 12px;color:#9ca3af;font-size:13px;">No highlights this week.</div>`;
  }
  const lis = items
    .map(
      (i) =>
        `<li style="margin:6px 0;line-height:1.5;color:#374151;font-size:13px;">${escapeHtml(i)}</li>`,
    )
    .join("");
  return `<ul style="margin:8px 0 0;padding-left:20px;border-left:3px solid ${accent};list-style:disc;">${lis}</ul>`;
}

// ── Full email ──────────────────────────────────────────────────────────────

export function buildWeeklyDigestHtml(opts: {
  data: WeeklyDigestData;
  insights: string[];
  actions: string[];
}): string {
  const { data, insights, actions } = opts;
  const cur = data.current;
  const prev = data.previous;
  const range = formatWeekRange(data);

  return `<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f3f4f6;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;max-width:640px;width:100%;">
        <tr><td style="background:#111827;padding:24px 32px;">
          <div style="font-size:18px;font-weight:700;color:#ffffff;">Presentail Weekly Sales Report</div>
          <div style="margin-top:4px;font-size:13px;color:#9ca3af;">Week ${data.weekNumber} · ${escapeHtml(range)} · all amounts in USD</div>
        </td></tr>
        <tr><td style="padding:24px 32px 32px;">

          ${section("Executive Summary", summaryTable(cur, prev))}

          ${section("Sales by Country", breakdownTable(cur.byCountry, prev.byCountry, "Country"))}
          ${section("Sales by City", breakdownTable(cur.byCity, prev.byCity, "City"))}
          ${section("Sales by Channel (incl. CMC POS)", breakdownTable(cur.byChannel, prev.byChannel, "Channel"))}
          ${section("Sales by Category", breakdownTable(cur.byCategory, prev.byCategory, "Category", false))}
          ${section("Best Sellers", bestSellersTable(cur))}
          ${section("Sales by Occasion", breakdownTable(cur.byOccasion, prev.byOccasion, "Occasion", false))}
          ${section("Sales by Recipient", breakdownTable(cur.byRecipient, prev.byRecipient, "Recipient", false))}
          ${section("Customer Data", customersSection(cur, prev))}
          ${section("Daily Breakdown", dailyTable(cur))}
          ${section("Discounts, Refunds & Cancellations", adjustmentsSection(cur, prev))}
          ${comingSoon("Marketing Snapshot", "Ad spend, ROAS and CAC will appear here once marketing integrations are connected.")}
          ${section("Delivery Performance", deliverySection(cur, prev))}
          ${section("CMC POS Sales", cmcSalesSection(cur.cmcMetrics, prev.cmcMetrics))}
          ${section("Product Views & Conversion", funnelSection(cur, prev))}
          ${section("Key Insights This Week", bulletList(insights, "#2563eb"))}
          ${section("Suggested Actions", bulletList(actions, "#059669"))}

          <div style="margin-top:32px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:12px;color:#9ca3af;">
            You are receiving this because the Weekly Sales Digest is enabled for your Presentail OS workspace.
            Manage this digest from Settings &rarr; Weekly Sales Digest.
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/** Plain-text fallback body. */
export function buildWeeklyDigestText(opts: {
  data: WeeklyDigestData;
  insights: string[];
  actions: string[];
}): string {
  const { data, insights, actions } = opts;
  const cur = data.current;
  const prev = data.previous;
  const line = (label: string, curVal: string, prevVal: string) =>
    `${label}: ${curVal} (prev ${prevVal})`;
  return [
    `Presentail Weekly Sales Report — Week ${data.weekNumber} | ${formatWeekRange(data)}`,
    "",
    line("Gross Sales", usd(cur.grossSalesUsd), usd(prev.grossSalesUsd)),
    line("Net Sales", usd(cur.netSalesUsd), usd(prev.netSalesUsd)),
    line("Orders", String(cur.orders), String(prev.orders)),
    line("AOV", usd(cur.aovUsd), usd(prev.aovUsd)),
    line(
      "Gross Margin",
      cur.grossMarginPct != null ? `${cur.grossMarginPct.toFixed(1)}%` : "n/a",
      prev.grossMarginPct != null ? `${prev.grossMarginPct.toFixed(1)}%` : "n/a",
    ),
    line("COGS", usd(cur.cogsUsd), usd(prev.cogsUsd)),
    "",
    "Delivery performance:",
    line(
      "On-time delivery rate",
      cur.delivery.onTimeRatePct != null ? `${cur.delivery.onTimeRatePct.toFixed(1)}%` : "n/a",
      prev.delivery.onTimeRatePct != null ? `${prev.delivery.onTimeRatePct.toFixed(1)}%` : "n/a",
    ),
    line("Late deliveries", String(cur.delivery.lateDeliveries), String(prev.delivery.lateDeliveries)),
    line("Same-day orders", String(cur.delivery.sameDayOrders), String(prev.delivery.sameDayOrders)),
    line("Express orders", String(cur.delivery.expressOrders), String(prev.delivery.expressOrders)),
    line(
      "Avg delivery time",
      cur.delivery.avgDeliveryTimeHours != null ? `${cur.delivery.avgDeliveryTimeHours.toFixed(1)} h` : "n/a",
      prev.delivery.avgDeliveryTimeHours != null ? `${prev.delivery.avgDeliveryTimeHours.toFixed(1)} h` : "n/a",
    ),
    "",
    "Product views & conversion:",
    line("Product views", String(cur.funnel.productViews), String(prev.funnel.productViews)),
    line("Add-to-carts", String(cur.funnel.addToCarts), String(prev.funnel.addToCarts)),
    line(
      "Add-to-cart rate",
      cur.funnel.addToCartRatePct != null ? `${cur.funnel.addToCartRatePct.toFixed(1)}%` : "n/a",
      prev.funnel.addToCartRatePct != null ? `${prev.funnel.addToCartRatePct.toFixed(1)}%` : "n/a",
    ),
    line(
      "Product conversion rate",
      cur.funnel.conversionRatePct != null ? `${cur.funnel.conversionRatePct.toFixed(1)}%` : "n/a",
      prev.funnel.conversionRatePct != null ? `${prev.funnel.conversionRatePct.toFixed(1)}%` : "n/a",
    ),
    "",
    "CMC POS Sales:",
    line("CMC sales count", String(cur.cmcMetrics.saleCount), String(prev.cmcMetrics.saleCount)),
    line("Gross sales (VAT incl.)", usd(cur.cmcMetrics.grossSalesUsd), usd(prev.cmcMetrics.grossSalesUsd)),
    line("Net sales (VAT excl.)", usd(cur.cmcMetrics.netSalesUsd), usd(prev.cmcMetrics.netSalesUsd)),
    line("Commission (20%)", usd(cur.cmcMetrics.commissionUsd), usd(prev.cmcMetrics.commissionUsd)),
    line("Commission VAT (11%)", usd(cur.cmcMetrics.commissionVatUsd), usd(prev.cmcMetrics.commissionVatUsd)),
    line("Total payable", usd(cur.cmcMetrics.payableUsd), usd(prev.cmcMetrics.payableUsd)),
    "",
    "Key insights:",
    ...insights.map((i) => `- ${i}`),
    "",
    "Suggested actions:",
    ...actions.map((a) => `- ${a}`),
  ].join("\n");
}
