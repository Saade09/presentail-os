// ---------------------------------------------------------------------------
// Weekly Sales Digest — aggregation module (task #2830)
//
// Computes all digest metrics for a workspace over a Monday–Sunday window.
// Design: thin SQL fetch (fetchWeeklyRaw) + pure computation
// (computeWeeklyMetrics) so the math is unit-testable without a database.
// All amounts are USD. Weeks are UTC-based (Monday 00:00 UTC → next Monday).
// ---------------------------------------------------------------------------

import { db } from "../db";

// ── Week windows ────────────────────────────────────────────────────────────

export interface WeekWindow {
  /** Monday 00:00:00 UTC (inclusive) */
  start: Date;
  /** Next Monday 00:00:00 UTC (exclusive) */
  end: Date;
}

/** Returns the most recent fully-completed Monday–Sunday week as of `now`. */
export function getLastCompletedWeek(now: Date = new Date()): WeekWindow {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  // getUTCDay(): 0=Sun..6=Sat → days since Monday
  const daysSinceMonday = (d.getUTCDay() + 6) % 7;
  const thisMonday = new Date(d.getTime() - daysSinceMonday * 86_400_000);
  const start = new Date(thisMonday.getTime() - 7 * 86_400_000);
  return { start, end: thisMonday };
}

/** The week immediately before `w`. */
export function getPreviousWeek(w: WeekWindow): WeekWindow {
  return {
    start: new Date(w.start.getTime() - 7 * 86_400_000),
    end: new Date(w.start.getTime()),
  };
}

/** ISO-8601 week number of the given date (UTC). */
export function isoWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  // Shift to the Thursday of this ISO week
  const dayNum = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  return 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
}

/** ISO date string (YYYY-MM-DD, UTC) — used as the week key for idempotency. */
export function weekStartKey(w: WeekWindow): string {
  return w.start.toISOString().slice(0, 10);
}

/** % change from previous to current; null when previous is 0/absent. */
export function pctChange(current: number, previous: number): number | null {
  if (!Number.isFinite(previous) || previous === 0) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

// ── Raw data shapes (from SQL) ──────────────────────────────────────────────

export interface RawOrderRow {
  id: string;
  status: string;
  channel: string | null;
  source: string | null;
  totals: {
    subtotal?: number | null;
    shipping?: number | null;
    discount?: number | null;
    total?: number | null;
    currency?: string | null;
  } | null;
  delivery_address: Record<string, unknown> | null;
  ordered_at: Date | string;
  payment_amount_usd: string | number | null;
  payment_status: string | null;
  // Delivery fields (task #3088). Optional so older fixtures keep compiling.
  delivery_type?: string | null;
  tookan_status?: string | null;
  window_start?: Date | string | null;
  window_end?: Date | string | null;
  /** Actual delivered timestamp: driver assignment or Tookan delivered-at. */
  delivered_at?: Date | string | null;
}

export interface RawLineItemRow {
  order_id: string;
  product_id: number | null;
  name: string;
  quantity: string | number;
  unit_price: string | number | null;
  line_total: string | number | null;
  category: string | null;
  cogs_usd: string | number | null;
  occasions: string[] | null;
  recipients: string[] | null;
}

export interface RawCustomerRow {
  order_id: string;
  contact_id: string;
  email: string | null;
  first_order_at: Date | string | null;
}

export interface RawCouponStats {
  redemption_count: number;
  total_discount_usd: number;
}

export interface RawWebEventTotals {
  product_views: number;
  add_to_carts: number;
  purchases: number;
}

export interface RawCmcSaleRow {
  id: string;
  status: string;
  /** Gross VAT-inclusive total (numeric string or number from Postgres). */
  total: string | number;
  /** Date attribution primary key; falls back to created_at when null. */
  fulfilment_date: string | null;
  created_at: Date | string;
}

export interface WeeklyRawData {
  window: WeekWindow;
  orders: RawOrderRow[];
  lineItems: RawLineItemRow[];
  customers: RawCustomerRow[];
  coupons: RawCouponStats;
  webEvents: RawWebEventTotals;
  /** Walk-in CMC POS sales — already filtered to status=paid by the SQL fetch. */
  cmcSales: RawCmcSaleRow[];
}

// ── Computed metrics shape ──────────────────────────────────────────────────

export interface BreakdownRow {
  label: string;
  orders: number;
  salesUsd: number;
}

export interface BestSellerRow {
  name: string;
  units: number;
  salesUsd: number;
  /** Gross margin % over items with known COGS; null when COGS unknown */
  marginPct: number | null;
  isNew?: boolean;
}

export interface DailyRow {
  /** YYYY-MM-DD (UTC) */
  date: string;
  orders: number;
  salesUsd: number;
}

export interface DeliveryStats {
  /** Counted (non-cancelled/refunded) non-pickup orders in the week. */
  deliveryOrders: number;
  /** Orders confirmed delivered (OS status completed or Tookan successful). */
  deliveredOrders: number;
  /** Delivered on/before the promised window end (needs delivered_at + window_end). */
  onTimeDeliveries: number;
  /** Delivered after the promised window end. */
  lateDeliveries: number;
  /** onTime / (onTime + late) %; null when no delivery has both timestamps. */
  onTimeRatePct: number | null;
  /** Requested delivery day == order day (from the delivery window). */
  sameDayOrders: number;
  /** delivery_type = 'express'. */
  expressOrders: number;
  /** Mean hours from order placed to delivered; null when no delivered_at data. */
  avgDeliveryTimeHours: number | null;
}

/** CMC POS financial metrics derived from qualifying (paid) cmc_sales rows. */
export interface CmcWeeklyMetrics {
  /** Number of paid CMC sales in the week. */
  saleCount: number;
  /** Sum of cmc_sales.total for paid rows (VAT-inclusive). */
  grossSalesUsd: number;
  /** Gross / 1.11 — excludes VAT. */
  netSalesUsd: number;
  /** 20% of netSalesUsd — Presentail commission. */
  commissionUsd: number;
  /** 11% of commissionUsd — VAT on the commission. */
  commissionVatUsd: number;
  /** commissionUsd + commissionVatUsd — total payable to CMC. */
  payableUsd: number;
}

export interface WeeklyMetrics {
  orders: number;
  /** Pre-discount sales of counted (non-cancelled/refunded) orders */
  grossSalesUsd: number;
  /** Post-discount sales (what was actually charged) */
  netSalesUsd: number;
  discountsUsd: number;
  aovUsd: number;
  /** Sum of known COGS across counted line items */
  cogsUsd: number;
  /** Revenue of line items whose COGS is known (margin denominator) */
  cogsCoveredSalesUsd: number;
  /** Gross margin % over COGS-covered revenue; null when nothing covered */
  grossMarginPct: number | null;

  byCountry: BreakdownRow[];
  byCity: BreakdownRow[];
  byChannel: BreakdownRow[];
  byCategory: BreakdownRow[];
  bestSellers: BestSellerRow[];
  byOccasion: BreakdownRow[];
  byRecipient: BreakdownRow[];

  newCustomers: number;
  returningCustomers: number;
  repeatRatePct: number | null;
  guestOrders: number;
  registeredOrders: number;

  daily: DailyRow[];

  cancelledOrders: number;
  cancelledUsd: number;
  refundedOrders: number;
  refundedUsd: number;
  couponRedemptions: number;
  couponDiscountUsd: number;

  delivery: DeliveryStats;

  funnel: FunnelStats;

  /** CMC POS walk-in sales — separate from online/OS orders. */
  cmcMetrics: CmcWeeklyMetrics;
}

export interface FunnelStats {
  /** Storefront product_view events in the week; 0 when tracking is off. */
  productViews: number;
  addToCarts: number;
  /** order_created / purchase / payment_completed events. */
  purchases: number;
  /** add_to_carts / views %; null when there are no views. */
  addToCartRatePct: number | null;
  /** purchases / views %; null when there are no views. */
  conversionRatePct: number | null;
  /** True when any product_view events exist in the week (tracking active). */
  tracked: boolean;
}

export interface WeeklyDigestData {
  weekNumber: number;
  window: WeekWindow;
  current: WeeklyMetrics;
  previous: WeeklyMetrics;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function num(v: string | number | null | undefined): number {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

function orderNetUsd(o: RawOrderRow): number {
  const t = o.totals;
  if (t && typeof t.total === "number" && Number.isFinite(t.total)) return t.total;
  return num(o.payment_amount_usd);
}

function orderDiscountUsd(o: RawOrderRow): number {
  const t = o.totals;
  if (t && typeof t.discount === "number" && Number.isFinite(t.discount)) return t.discount;
  return 0;
}

function isCancelled(o: RawOrderRow): boolean {
  return o.status === "cancelled";
}

function isRefunded(o: RawOrderRow): boolean {
  return o.status === "refunded" || o.payment_status === "refunded";
}

/** Orders counted toward sales totals. */
function isCounted(o: RawOrderRow): boolean {
  return !isCancelled(o) && !isRefunded(o);
}

function addRow(map: Map<string, BreakdownRow>, label: string, salesUsd: number, orders = 1): void {
  const row = map.get(label) ?? { label, orders: 0, salesUsd: 0 };
  row.orders += orders;
  row.salesUsd += salesUsd;
  map.set(label, row);
}

function sortRows(map: Map<string, BreakdownRow>, limit = 12): BreakdownRow[] {
  return [...map.values()].sort((a, b) => b.salesUsd - a.salesUsd).slice(0, limit);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : null;
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ── Delivery stats (pure; exported for unit tests) ──────────────────────────

function toDate(v: Date | string | null | undefined): Date | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isFinite(d.getTime()) ? d : null;
}

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Computes delivery metrics over counted (non-cancelled/refunded) orders,
 * mirroring the delivery analytics route classifications:
 * - pickup orders excluded
 * - delivered = OS status 'completed' OR tookan_status 'successful'
 * - on-time/late = delivered_at vs window_end (both must exist)
 * - same-day = requested window day equals order day
 */
export function computeDeliveryStats(orders: RawOrderRow[]): DeliveryStats {
  const deliveries = orders.filter(
    (o) => isCounted(o) && (o.delivery_type ?? null) !== "pickup",
  );

  let delivered = 0;
  let onTime = 0;
  let late = 0;
  let sameDay = 0;
  let express = 0;
  let timeSumMs = 0;
  let timeCount = 0;

  for (const o of deliveries) {
    const isDelivered = o.status === "completed" || o.tookan_status === "successful";
    const deliveredAt = toDate(o.delivered_at);
    const windowEnd = toDate(o.window_end);
    const windowStart = toDate(o.window_start);
    const orderedAt = toDate(o.ordered_at);

    if (isDelivered) delivered += 1;
    if (isDelivered && deliveredAt && windowEnd) {
      if (deliveredAt.getTime() <= windowEnd.getTime()) onTime += 1;
      else late += 1;
    }
    if (windowStart && orderedAt && utcDay(windowStart) === utcDay(orderedAt)) {
      sameDay += 1;
    }
    if (o.delivery_type === "express") express += 1;
    if (isDelivered && deliveredAt && orderedAt) {
      const ms = deliveredAt.getTime() - orderedAt.getTime();
      if (ms >= 0) {
        timeSumMs += ms;
        timeCount += 1;
      }
    }
  }

  const rated = onTime + late;
  return {
    deliveryOrders: deliveries.length,
    deliveredOrders: delivered,
    onTimeDeliveries: onTime,
    lateDeliveries: late,
    onTimeRatePct: rated > 0 ? round2((onTime / rated) * 100) : null,
    sameDayOrders: sameDay,
    expressOrders: express,
    avgDeliveryTimeHours:
      timeCount > 0 ? round2(timeSumMs / timeCount / 3_600_000) : null,
  };
}

/**
 * Derives CMC financial metrics from qualifying (paid) cmc_sales rows.
 * Uses the same formulas as the monthly CMC report:
 *   net           = gross / 1.11
 *   commission    = 20% of net
 *   commissionVat = 11% of commission
 *   payable       = commission + commissionVat
 *
 * The attribution date is fulfilment_date when set, otherwise created_at.
 * This function expects rows already pre-filtered to the correct time window
 * by the SQL query; it only re-filters status='paid' for safety.
 */
export function computeCmcMetrics(sales: RawCmcSaleRow[]): CmcWeeklyMetrics {
  const qualifying = sales.filter((s) => s.status === "paid");
  const gross = qualifying.reduce((acc, s) => acc + num(s.total), 0);
  const net = gross / 1.11;
  const commission = round2(net * 0.2);
  const commissionVat = round2(commission * 0.11);
  const payable = round2(commission + commissionVat);
  return {
    saleCount: qualifying.length,
    grossSalesUsd: round2(gross),
    netSalesUsd: round2(net),
    commissionUsd: commission,
    commissionVatUsd: commissionVat,
    payableUsd: payable,
  };
}

/**
 * Storefront funnel from web events (same classification as the Products
 * analytics tab): views = product_view, carts = add_to_cart, purchases =
 * order_created|purchase|payment_completed. Rates are null when no views.
 */
export function computeFunnelStats(ev: RawWebEventTotals): FunnelStats {
  const views = ev.product_views;
  return {
    productViews: views,
    addToCarts: ev.add_to_carts,
    purchases: ev.purchases,
    addToCartRatePct: views > 0 ? round2((ev.add_to_carts / views) * 100) : null,
    conversionRatePct: views > 0 ? round2((ev.purchases / views) * 100) : null,
    tracked: views > 0,
  };
}

// ── Pure computation ────────────────────────────────────────────────────────

export function computeWeeklyMetrics(raw: WeeklyRawData): WeeklyMetrics {
  const counted = raw.orders.filter(isCounted);
  const countedIds = new Set(counted.map((o) => o.id));

  let netSales = 0;
  let discounts = 0;
  const byCountry = new Map<string, BreakdownRow>();
  const byCity = new Map<string, BreakdownRow>();
  const byChannel = new Map<string, BreakdownRow>();
  const dailyMap = new Map<string, DailyRow>();

  // Seed the 7 days of the window so quiet days still render
  for (let i = 0; i < 7; i++) {
    const date = new Date(raw.window.start.getTime() + i * 86_400_000)
      .toISOString()
      .slice(0, 10);
    dailyMap.set(date, { date, orders: 0, salesUsd: 0 });
  }

  for (const o of counted) {
    const net = orderNetUsd(o);
    const discount = orderDiscountUsd(o);
    netSales += net;
    discounts += discount;

    const addr = o.delivery_address ?? {};
    const country =
      str(addr["countryCode"]) ?? str(addr["country"]) ?? "Unknown";
    const city = str(addr["district"]) ?? str(addr["city"]) ?? "Unknown";
    addRow(byCountry, country, net);
    addRow(byCity, city, net);
    addRow(byChannel, str(o.channel) ?? str(o.source) ?? "Unknown", net);

    const day = new Date(o.ordered_at).toISOString().slice(0, 10);
    const dailyRow = dailyMap.get(day);
    if (dailyRow) {
      dailyRow.orders += 1;
      dailyRow.salesUsd += net;
    }
  }

  // ── Fold CMC POS sales into the breakdowns ─────────────────────────────
  const cmcMetrics = computeCmcMetrics(raw.cmcSales);
  // CMC gross is VAT-inclusive — treat it as both "gross" and "net" for the
  // combined online+CMC headline totals (no separate OS-style discount line).
  netSales += cmcMetrics.grossSalesUsd;

  for (const sale of raw.cmcSales.filter((s) => s.status === "paid")) {
    const gross = num(sale.total);
    addRow(byChannel, "CMC POS", gross);

    // Attribution: fulfilment_date when set, otherwise created_at.
    const attrDate = sale.fulfilment_date
      ? sale.fulfilment_date.slice(0, 10)
      : new Date(sale.created_at).toISOString().slice(0, 10);
    const dailyRow = dailyMap.get(attrDate);
    if (dailyRow) {
      dailyRow.orders += 1;
      dailyRow.salesUsd += gross;
    }
  }

  const grossSales = netSales + discounts;
  const orders = counted.length;

  // Line items → COGS, category, best sellers, occasions, recipients
  const byCategory = new Map<string, BreakdownRow>();
  const byOccasion = new Map<string, BreakdownRow>();
  const byRecipient = new Map<string, BreakdownRow>();
  const productMap = new Map<
    string,
    { name: string; units: number; salesUsd: number; cogsUsd: number; coveredSalesUsd: number }
  >();
  let cogsTotal = 0;
  let cogsCoveredSales = 0;

  for (const li of raw.lineItems) {
    if (!countedIds.has(li.order_id)) continue;
    const qty = num(li.quantity);
    const revenue =
      li.line_total != null ? num(li.line_total) : num(li.unit_price) * qty;
    const unitCogs = li.cogs_usd != null ? num(li.cogs_usd) : null;

    addRow(byCategory, str(li.category) ?? "Uncategorized", revenue, 0);
    for (const occ of li.occasions ?? []) addRow(byOccasion, occ, revenue, 0);
    for (const rec of li.recipients ?? []) addRow(byRecipient, rec, revenue, 0);

    const key = li.name;
    const p = productMap.get(key) ?? {
      name: li.name,
      units: 0,
      salesUsd: 0,
      cogsUsd: 0,
      coveredSalesUsd: 0,
    };
    p.units += qty;
    p.salesUsd += revenue;
    if (unitCogs != null) {
      const itemCogs = unitCogs * qty;
      p.cogsUsd += itemCogs;
      p.coveredSalesUsd += revenue;
      cogsTotal += itemCogs;
      cogsCoveredSales += revenue;
    }
    productMap.set(key, p);
  }

  const bestSellers: BestSellerRow[] = [...productMap.values()]
    .sort((a, b) => b.salesUsd - a.salesUsd)
    .slice(0, 10)
    .map((p) => ({
      name: p.name,
      units: round2(p.units),
      salesUsd: round2(p.salesUsd),
      marginPct:
        p.coveredSalesUsd > 0
          ? round2(((p.coveredSalesUsd - p.cogsUsd) / p.coveredSalesUsd) * 100)
          : null,
    }));

  // Customers
  const contactsByOrder = new Map<string, RawCustomerRow>();
  for (const c of raw.customers) {
    if (countedIds.has(c.order_id)) contactsByOrder.set(c.order_id, c);
  }
  const seenContacts = new Map<string, RawCustomerRow>();
  for (const c of contactsByOrder.values()) {
    if (!seenContacts.has(c.contact_id)) seenContacts.set(c.contact_id, c);
  }
  let newCustomers = 0;
  let returningCustomers = 0;
  for (const c of seenContacts.values()) {
    const first = c.first_order_at ? new Date(c.first_order_at) : null;
    if (first && first.getTime() < raw.window.start.getTime()) returningCustomers += 1;
    else newCustomers += 1;
  }
  const totalCustomers = newCustomers + returningCustomers;
  const registeredOrders = [...contactsByOrder.values()].filter((c) => c.email != null).length;
  const guestOrders = orders - registeredOrders;

  // Cancellations / refunds
  let cancelledOrders = 0;
  let cancelledUsd = 0;
  let refundedOrders = 0;
  let refundedUsd = 0;
  for (const o of raw.orders) {
    if (isCancelled(o)) {
      cancelledOrders += 1;
      cancelledUsd += orderNetUsd(o);
    } else if (isRefunded(o)) {
      refundedOrders += 1;
      refundedUsd += orderNetUsd(o);
    }
  }

  return {
    orders,
    grossSalesUsd: round2(grossSales),
    netSalesUsd: round2(netSales),
    discountsUsd: round2(discounts),
    aovUsd: orders > 0 ? round2(netSales / orders) : 0,
    cogsUsd: round2(cogsTotal),
    cogsCoveredSalesUsd: round2(cogsCoveredSales),
    grossMarginPct:
      cogsCoveredSales > 0
        ? round2(((cogsCoveredSales - cogsTotal) / cogsCoveredSales) * 100)
        : null,
    byCountry: sortRows(byCountry),
    byCity: sortRows(byCity),
    byChannel: sortRows(byChannel),
    byCategory: sortRows(byCategory),
    bestSellers,
    byOccasion: sortRows(byOccasion, 8),
    byRecipient: sortRows(byRecipient, 8),
    newCustomers,
    returningCustomers,
    repeatRatePct:
      totalCustomers > 0 ? round2((returningCustomers / totalCustomers) * 100) : null,
    guestOrders,
    registeredOrders,
    daily: [...dailyMap.values()].map((d) => ({ ...d, salesUsd: round2(d.salesUsd) })),
    cancelledOrders,
    cancelledUsd: round2(cancelledUsd),
    refundedOrders,
    refundedUsd: round2(refundedUsd),
    couponRedemptions: raw.coupons.redemption_count,
    couponDiscountUsd: round2(raw.coupons.total_discount_usd),
    delivery: computeDeliveryStats(raw.orders),
    funnel: computeFunnelStats(raw.webEvents),
    cmcMetrics,
  };
}

/** Marks best sellers that are in the current top 10 but not the prior week's. */
export function markNewBestSellers(current: WeeklyMetrics, previous: WeeklyMetrics): void {
  const prevNames = new Set(previous.bestSellers.map((b) => b.name));
  for (const b of current.bestSellers) {
    b.isNew = !prevNames.has(b.name);
  }
}

// ── SQL fetch ───────────────────────────────────────────────────────────────

const ORDER_WINDOW_WHERE = `
  o.workspace_owner_id = $1
  AND COALESCE(o.ordered_at, o.created_at) >= $2
  AND COALESCE(o.ordered_at, o.created_at) < $3
`;

// Same preferred-supplier COGS logic as routes/products.ts COGS_LATERAL_SQL,
// evaluated per product referenced by a line item.
const LINE_ITEM_COGS_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT
      CASE
        WHEN COUNT(pr.base_item_id) = 0 THEN NULL
        WHEN COUNT(pr.base_item_id) FILTER (
          WHERE bis.price IS NOT NULL AND bis.currency = 'USD'
        ) = COUNT(pr.base_item_id)
        THEN SUM(pr.quantity::numeric * bis.price::numeric)
        ELSE NULL
      END AS cogs_usd
    FROM product_recipes pr
    LEFT JOIN base_item_suppliers bis
      ON bis.base_item_id = pr.base_item_id
     AND bis.workspace_owner_id = pr.workspace_owner_id
     AND bis.is_preferred = true
    WHERE pr.product_id = p.id
      AND pr.workspace_owner_id = p.workspace_owner_id
  ) cogs_data ON true
`;

export async function fetchWeeklyRaw(
  ownerId: string,
  window: WeekWindow,
): Promise<WeeklyRawData> {
  const params = [ownerId, window.start, window.end];

  const ordersResult = await db.query(
    `SELECT o.id, o.status, o.channel, o.source, o.totals, o.delivery_address,
            COALESCE(o.ordered_at, o.created_at) AS ordered_at,
            op.amount_usd AS payment_amount_usd, op.status AS payment_status,
            o.delivery_type, o.tookan_status, o.window_start, o.window_end,
            COALESCE(asg.delivered_at, o.tookan_delivered_at) AS delivered_at
       FROM orders o
       LEFT JOIN order_payment op ON op.order_id = o.id
       LEFT JOIN (
         SELECT order_id, MAX(delivered_at) AS delivered_at
           FROM fleet_driver_order_assignments
          WHERE workspace_owner_id = $1 AND order_id IS NOT NULL
          GROUP BY order_id
       ) asg ON asg.order_id = o.id
      WHERE ${ORDER_WINDOW_WHERE}`,
    params,
  );

  const lineItemsResult = await db.query(
    `SELECT li.order_id, li.product_id, li.name, li.quantity, li.unit_price, li.line_total,
            p.category, cogs_data.cogs_usd,
            occ.names AS occasions, rec.names AS recipients
       FROM order_line_items li
       JOIN orders o ON o.id = li.order_id
       LEFT JOIN products p
         ON p.id = li.product_id AND p.workspace_owner_id = $1
       ${LINE_ITEM_COGS_LATERAL}
       LEFT JOIN LATERAL (
         SELECT array_agg(oc2.name) AS names
           FROM product_occasions po
           JOIN occasions oc2 ON oc2.id = po.attribute_id
          WHERE po.product_id = p.id
       ) occ ON true
       LEFT JOIN LATERAL (
         SELECT array_agg(r2.name) AS names
           FROM product_recipients prj
           JOIN recipients r2 ON r2.id = prj.attribute_id
          WHERE prj.product_id = p.id
       ) rec ON true
      WHERE ${ORDER_WINDOW_WHERE}`,
    params,
  );

  const customersResult = await db.query(
    `SELECT DISTINCT ON (oc.order_id)
            oc.order_id, c.id AS contact_id, c.email, fo.first_order_at
       FROM order_contacts oc
       JOIN contacts c ON c.id = oc.contact_id
       JOIN orders o ON o.id = oc.order_id
       LEFT JOIN LATERAL (
         SELECT MIN(COALESCE(o2.ordered_at, o2.created_at)) AS first_order_at
           FROM order_contacts oc2
           JOIN orders o2 ON o2.id = oc2.order_id
          WHERE oc2.contact_id = c.id
            AND oc2.role = 'customer'
            AND o2.workspace_owner_id = $1
            AND o2.status <> 'cancelled'
       ) fo ON true
      WHERE oc.role = 'customer'
        AND ${ORDER_WINDOW_WHERE}
      ORDER BY oc.order_id, oc.created_at ASC`,
    params,
  );

  const couponsResult = await db.query(
    `SELECT COUNT(*)::int AS redemption_count,
            COALESCE(SUM(cr.discount_amount_usd), 0)::numeric AS total_discount_usd
       FROM coupon_redemptions cr
       JOIN orders o ON o.id = cr.order_id
      WHERE cr.workspace_owner_id = $1
        AND cr.status = 'confirmed'
        AND ${ORDER_WINDOW_WHERE}`,
    params,
  );

  const couponRow = couponsResult.rows[0] as
    | { redemption_count: number; total_discount_usd: string | number }
    | undefined;

  const webEventsResult = await db.query(
    `SELECT
        COUNT(*) FILTER (WHERE we.event_type = 'product_view')::int AS product_views,
        COUNT(*) FILTER (WHERE we.event_type = 'add_to_cart')::int AS add_to_carts,
        COUNT(*) FILTER (WHERE we.event_type IN ('order_created', 'purchase', 'payment_completed'))::int AS purchases
       FROM web_events we
      WHERE we.workspace_owner_id = $1
        AND we.occurred_at >= $2
        AND we.occurred_at < $3`,
    params,
  );
  const webRow = webEventsResult.rows[0] as
    | { product_views: number; add_to_carts: number; purchases: number }
    | undefined;

  // CMC POS sales attributed by fulfilment_date when set, created_at otherwise.
  // Only paid sales are fetched; voided/refunded rows are excluded.
  const cmcSalesResult = await db.query(
    `SELECT id, status, total::numeric AS total, fulfilment_date, created_at
       FROM cmc_sales
      WHERE workspace_owner_id = $1
        AND status = 'paid'
        AND COALESCE(fulfilment_date::timestamptz, created_at) >= $2
        AND COALESCE(fulfilment_date::timestamptz, created_at) < $3`,
    params,
  );

  return {
    window,
    orders: ordersResult.rows as RawOrderRow[],
    lineItems: lineItemsResult.rows as RawLineItemRow[],
    customers: customersResult.rows as RawCustomerRow[],
    coupons: {
      redemption_count: couponRow?.redemption_count ?? 0,
      total_discount_usd: num(couponRow?.total_discount_usd ?? 0),
    },
    webEvents: {
      product_views: webRow?.product_views ?? 0,
      add_to_carts: webRow?.add_to_carts ?? 0,
      purchases: webRow?.purchases ?? 0,
    },
    cmcSales: cmcSalesResult.rows as RawCmcSaleRow[],
  };
}

/** Builds the full digest dataset: current week + prior week (for deltas). */
export async function buildWeeklyDigestData(
  ownerId: string,
  window: WeekWindow,
): Promise<WeeklyDigestData> {
  const prevWindow = getPreviousWeek(window);
  const [currentRaw, previousRaw] = [
    await fetchWeeklyRaw(ownerId, window),
    await fetchWeeklyRaw(ownerId, prevWindow),
  ];
  const current = computeWeeklyMetrics(currentRaw);
  const previous = computeWeeklyMetrics(previousRaw);
  markNewBestSellers(current, previous);
  return {
    weekNumber: isoWeekNumber(window.start),
    window,
    current,
    previous,
  };
}
