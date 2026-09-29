import type { Request } from "express";

/**
 * Shared helpers for the E-commerce (store) analytics endpoints.
 *
 * These utilities are intentionally decoupled from any single route so future
 * store-analytics sections (Section 2, 3, …) can reuse the same period /
 * comparison math and the same URL-filter parsing + SQL-condition building.
 */

// Statuses that never count towards revenue (mirrors brands.ts analytics).
export const NON_REVENUE_STATUSES = [
  "cancelled",
  "refunded",
  "failed",
  "trash",
] as const;

export type AnalyticsRange = { from: Date; to: Date };

export type AnalyticsFilters = {
  countryCode: string | null;
  cityId: number | null;
  brand: string | null;
  channel: string | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve the selected reporting window from `from`/`to` ISO query params.
 * Falls back to the last 7 days when either bound is missing or invalid.
 * The `to` bound is treated as inclusive of the whole day, so callers should
 * compare with `ordered_at < to` after this normalisation pushes `to` to the
 * end of that calendar day.
 */
export function resolveRange(fromRaw: unknown, toRaw: unknown): AnalyticsRange {
  const parsed = (v: unknown): Date | null => {
    if (typeof v !== "string" || v.trim() === "") return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };

  let from = parsed(fromRaw);
  let to = parsed(toRaw);

  if (!from || !to) {
    // Default: last 7 days ending now.
    to = new Date();
    from = new Date(to.getTime() - 7 * DAY_MS);
  }

  if (from.getTime() > to.getTime()) {
    const tmp = from;
    from = to;
    to = tmp;
  }

  return { from, to };
}

/**
 * The immediately-preceding window of equal duration. For a range of N ms
 * ending at `to`, the previous window is `[from - N, from)`.
 */
export function previousRange(range: AnalyticsRange): AnalyticsRange {
  const duration = range.to.getTime() - range.from.getTime();
  return {
    from: new Date(range.from.getTime() - duration),
    to: new Date(range.from.getTime()),
  };
}

export type ComparisonMode = "none" | "previous" | "last_year" | "custom";

export type ResolvedComparison = {
  mode: ComparisonMode;
  /** Baseline window, or null when mode = "none". */
  baseline: AnalyticsRange | null;
};

/**
 * Resolve the comparison baseline window for the executive analytics pages.
 *
 * - `previous`   — the immediately-preceding window of equal duration.
 * - `last_year`  — the same start date shifted back one calendar year, then
 *                  extended by the *elapsed duration* of the current window, so
 *                  incomplete periods compare the equivalent elapsed days of
 *                  the baseline (never the full baseline period).
 * - `custom`     — a caller-supplied window (falls back to `previous` when the
 *                  custom bounds are missing/invalid).
 */
export function resolveComparison(
  mode: ComparisonMode,
  range: AnalyticsRange,
  customFrom?: unknown,
  customTo?: unknown,
): ResolvedComparison {
  switch (mode) {
    case "none":
      return { mode, baseline: null };
    case "previous":
      return { mode, baseline: previousRange(range) };
    case "last_year": {
      const duration = range.to.getTime() - range.from.getTime();
      const from = new Date(range.from);
      from.setFullYear(from.getFullYear() - 1);
      return { mode, baseline: { from, to: new Date(from.getTime() + duration) } };
    }
    case "custom": {
      const parse = (v: unknown): Date | null => {
        if (typeof v !== "string" || v.trim() === "") return null;
        const d = new Date(v);
        return Number.isNaN(d.getTime()) ? null : d;
      };
      const from = parse(customFrom);
      const to = parse(customTo);
      if (!from || !to) return { mode: "previous", baseline: previousRange(range) };
      return {
        mode,
        baseline:
          from.getTime() <= to.getTime() ? { from, to } : { from: to, to: from },
      };
    }
  }
}

/**
 * Parse the comparison selection from the query string. Accepts the new
 * `compareMode` (+ `compareFrom`/`compareTo` for custom) and remains
 * backwards-compatible with the legacy boolean `compare` flag (mapped to
 * `previous`).
 */
export function parseComparison(
  req: Request,
  range: AnalyticsRange,
): ResolvedComparison {
  const raw = typeof req.query.compareMode === "string" ? req.query.compareMode : null;
  if (raw === "none" || raw === "previous" || raw === "last_year" || raw === "custom") {
    return resolveComparison(raw, range, req.query.compareFrom, req.query.compareTo);
  }
  const legacy = req.query.compare === "true" || req.query.compare === "1";
  return resolveComparison(legacy ? "previous" : "none", range);
}

/** KPI inputs to the deterministic performance-summary rules. */
export type SummaryKpiInput = {
  totalRevenue: number;
  orders: number;
  aov: number;
  grossMarginPct: number | null;
  cancellationRate: number;
  cogsCoveragePct: number | null;
};

export type PerformanceSummary = {
  headline: {
    code:
      | "no_data"
      | "no_comparison"
      | "stable"
      | "revenue_up"
      | "revenue_down";
    revenuePct: number | null;
    currentRevenue: number;
    baselineRevenue: number | null;
    currentOrders: number;
  };
  driver: {
    /** Primary driver of the revenue move when decomposition supports it. */
    code: "orders" | "aov" | "mixed" | null;
    /** True only when one factor clearly dominates ("driven by" language). */
    supported: boolean;
    ordersPct: number | null;
    aovPct: number | null;
  };
  attention: {
    code: "missing_cogs" | "cancellation_up" | null;
    values: { coveragePct?: number; current?: number; previous?: number };
  };
};

const pctChange = (cur: number, base: number): number | null =>
  base > 0 ? ((cur - base) / base) * 100 : null;

const round1v = (n: number) => Math.round(n * 10) / 10;

/**
 * Deterministic executive performance summary. All numbers are computed here
 * from the KPI aggregates — the frontend only maps codes to localized copy.
 *
 * Rules:
 * - Revenue movement is "meaningful" at ≥ 5% absolute change; below that the
 *   summary reports stability.
 * - Driver decomposition: revenue ≈ orders × AOV. A factor is the supported
 *   primary driver only when it moves in the same direction as revenue and
 *   accounts for ≥ 60% of the combined |orders%| + |aov%| movement; otherwise
 *   the movement is "mixed" (frontend must use "alongside" language).
 * - At most ONE attention item: incomplete COGS coverage (< 95%) wins, else a
 *   cancellation-rate rise of ≥ 2 percentage points.
 */
export function buildPerformanceSummary(
  current: SummaryKpiInput,
  baseline: SummaryKpiInput | null,
): PerformanceSummary {
  const attention: PerformanceSummary["attention"] = { code: null, values: {} };
  if (current.cogsCoveragePct != null && current.cogsCoveragePct < 95) {
    attention.code = "missing_cogs";
    attention.values = { coveragePct: round1v(current.cogsCoveragePct) };
  } else if (
    baseline &&
    current.cancellationRate - baseline.cancellationRate >= 2
  ) {
    attention.code = "cancellation_up";
    attention.values = {
      current: round1v(current.cancellationRate),
      previous: round1v(baseline.cancellationRate),
    };
  }

  const emptyDriver: PerformanceSummary["driver"] = {
    code: null,
    supported: false,
    ordersPct: null,
    aovPct: null,
  };

  if (current.orders === 0 && current.totalRevenue === 0) {
    return {
      headline: {
        code: "no_data",
        revenuePct: null,
        currentRevenue: 0,
        baselineRevenue: baseline ? baseline.totalRevenue : null,
        currentOrders: 0,
      },
      driver: emptyDriver,
      attention,
    };
  }

  if (!baseline) {
    return {
      headline: {
        code: "no_comparison",
        revenuePct: null,
        currentRevenue: current.totalRevenue,
        baselineRevenue: null,
        currentOrders: current.orders,
      },
      driver: emptyDriver,
      attention,
    };
  }

  const revenuePct = pctChange(current.totalRevenue, baseline.totalRevenue);
  if (revenuePct === null || Math.abs(revenuePct) < 5) {
    return {
      headline: {
        code: "stable",
        revenuePct: revenuePct === null ? null : round1v(revenuePct),
        currentRevenue: current.totalRevenue,
        baselineRevenue: baseline.totalRevenue,
        currentOrders: current.orders,
      },
      driver: emptyDriver,
      attention,
    };
  }

  const ordersPct = pctChange(current.orders, baseline.orders);
  const aovPct = pctChange(current.aov, baseline.aov);
  const dir = Math.sign(revenuePct);
  let code: "orders" | "aov" | "mixed" = "mixed";
  let supported = false;
  if (ordersPct !== null && aovPct !== null) {
    const total = Math.abs(ordersPct) + Math.abs(aovPct);
    if (total > 0) {
      if (Math.abs(ordersPct) / total >= 0.6 && Math.sign(ordersPct) === dir) {
        code = "orders";
        supported = true;
      } else if (Math.abs(aovPct) / total >= 0.6 && Math.sign(aovPct) === dir) {
        code = "aov";
        supported = true;
      }
    }
  }

  return {
    headline: {
      code: revenuePct >= 0 ? "revenue_up" : "revenue_down",
      revenuePct: round1v(revenuePct),
      currentRevenue: current.totalRevenue,
      baselineRevenue: baseline.totalRevenue,
      currentOrders: current.orders,
    },
    driver: {
      code,
      supported,
      ordersPct: ordersPct === null ? null : round1v(ordersPct),
      aovPct: aovPct === null ? null : round1v(aovPct),
    },
    attention,
  };
}

/**
 * Choose a sensible time bucket for the "over time" trend based on the window
 * length so short presets show daily points and long custom ranges roll up.
 */
export function bucketFor(range: AnalyticsRange): "day" | "week" | "month" {
  const days = (range.to.getTime() - range.from.getTime()) / DAY_MS;
  if (days <= 31) return "day";
  if (days <= 180) return "week";
  return "month";
}

/**
 * Period granularity for the "Revenue by [period]" breakdown bar chart.
 * Thresholds mirror the UI preset groups:
 *   hour  — ≤ 2 days  (Today / Yesterday)
 *   dow   — ≤ 14 days (This week / Last week)
 *   dom   — ≤ 90 days (This month / custom ~15-90 days)
 *   month — > 90 days (Yearly / large custom ranges)
 */
export type PeriodType = "hour" | "dow" | "dom" | "month";

export function periodTypeFor(range: AnalyticsRange): PeriodType {
  const days = (range.to.getTime() - range.from.getTime()) / DAY_MS;
  if (days <= 2) return "hour";
  if (days <= 14) return "dow";
  if (days <= 90) return "dom";
  return "month";
}

/** Parse the shared store-analytics filters from the request query string. */
export function parseAnalyticsFilters(req: Request): AnalyticsFilters {
  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim() !== "" ? v.trim() : null;

  const cityRaw = str(req.query.city);
  const cityId = cityRaw !== null && /^\d+$/.test(cityRaw) ? parseInt(cityRaw, 10) : null;

  return {
    countryCode: str(req.query.country),
    cityId,
    brand: str(req.query.brand),
    channel: str(req.query.channel),
  };
}

/**
 * Build the SQL WHERE conditions (and bound params) shared by every
 * store-analytics query. Returns the extra condition string (each prefixed
 * with " AND ") plus the ordered params appended after the caller's own
 * leading params.
 *
 * @param filters  parsed shared filters
 * @param ownerId  workspace owner id (used inside the brand EXISTS sub-query)
 * @param startIndex 1-based index of the FIRST placeholder this helper may use
 */
export function buildFilterConditions(
  filters: AnalyticsFilters,
  ownerId: string,
  startIndex: number,
): { sql: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  let idx = startIndex;

  if (filters.countryCode) {
    parts.push(`AND lower(o.delivery_address->>'countryCode') = lower($${idx++})`);
    params.push(filters.countryCode);
  }
  if (filters.cityId !== null) {
    // Orders may store either the numeric delivery-city id OR the city's slug
    // (e.g. "lb-saida") in delivery_address->>'cityId'. Match both so
    // slug-stored orders aren't excluded from filtered views.
    parts.push(
      `AND (
         o.delivery_address->>'cityId' = $${idx}
         OR lower(o.delivery_address->>'cityId') IN (
           SELECT lower(fdc.slug) FROM delivery_cities fdc
           WHERE fdc.workspace_owner_id = $${idx + 1} AND fdc.id = $${idx + 2}
         )
       )`,
    );
    params.push(String(filters.cityId), ownerId, filters.cityId);
    idx += 3;
  }
  if (filters.channel) {
    parts.push(`AND o.channel = $${idx++}`);
    params.push(filters.channel);
  }
  if (filters.brand) {
    // Order is in scope when it contains at least one line item that maps to a
    // product of the given brand (matched by name or product_id, mirroring the
    // brand-analytics join strategy).
    parts.push(
      `AND EXISTS (
         SELECT 1 FROM order_line_items li
         JOIN products p ON (
           lower(COALESCE(li.name, '')) = lower(p.name)
           OR (li.product_id IS NOT NULL AND li.product_id = p.id)
         )
         WHERE li.order_id = o.id
           AND p.workspace_owner_id = $${idx}
           AND lower(p.brand) = lower($${idx + 1})
       )`,
    );
    params.push(ownerId, filters.brand);
    idx += 2;
  }

  return { sql: parts.join("\n"), params };
}

/**
 * Boolean SQL condition matching an order's stored `cityId` (which may be a
 * numeric delivery-city id OR a city slug, e.g. "lb-saida") against a
 * `delivery_cities` row aliased `dc`. Never casts non-numeric text to int, so
 * slug-valued cityIds can't throw 22P02 (`invalid input syntax for type
 * integer`) and still resolve to the right city via `dc.slug`.
 *
 * @param cityIdExpr SQL expression yielding the stored cityId text
 *                   (e.g. `f.delivery_address->>'cityId'`)
 */
export function cityMatchSql(cityIdExpr: string): string {
  return `CASE WHEN ${cityIdExpr} ~ '^[0-9]+$'
               THEN dc.id::text = ${cityIdExpr}
               ELSE lower(dc.slug) = lower(${cityIdExpr}) END`;
}

/**
 * Human-readable fallback label for a delivery-city id when no matching
 * `delivery_cities` row exists. Slug-valued ids (e.g. "lb-beirut") are
 * prettified: an optional 2-letter country prefix is stripped and the rest is
 * title-cased ("lb-beirut" → "Beirut", "ae-abu-dhabi" → "Abu Dhabi").
 * Numeric ids and blank values return null (caller shows "Unknown").
 */
export function prettifyCitySlug(cityId: string | null | undefined): string | null {
  if (!cityId) return null;
  const trimmed = cityId.trim();
  if (!trimmed || /^[0-9]+$/.test(trimmed)) return null;
  const withoutPrefix = trimmed.replace(/^[a-z]{2}[-_](?=.)/i, "");
  const words = withoutPrefix.split(/[-_\s]+/).filter(Boolean);
  if (words.length === 0) return null;
  return words
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

export function num(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Raw DB aggregation row for one delivery time-slot bucket. `slot` is the
 * window-derived label ("09:00–12:00" in UTC) or null for orders without a
 * stored delivery window. Counts/sums arrive as Postgres text.
 */
export type TimeSlotRow = {
  slot: string | null;
  sort_start: string | null;
  orders: string | number;
  revenue: string | number | null;
  express_orders: string | number;
  express_revenue: string | number | null;
  express_surcharge_usd: string | number | null;
  slot_fee_usd: string | number | null;
};

export type TimeSlotStat = {
  slot: string | null;
  orders: number;
  revenue: number;
  sharePct: number;
  standardOrders: number;
  standardRevenue: number;
  expressOrders: number;
  expressRevenue: number;
  expressSurchargeUsd: number;
  slotFeeUsd: number;
};

export type TimeSlotTotals = {
  orders: number;
  revenue: number;
  expressOrders: number;
  expressRevenue: number;
  expressSurchargeUsd: number;
  slotFeeUsd: number;
};

/**
 * Turn raw per-slot aggregation rows into the ordered breakdown + overall
 * totals. Slots are ordered by their window start time ascending, with the
 * "no time slot" bucket (slot=null) always last so totals still reconcile.
 * Share % is each slot's revenue share of the window total (1 decimal).
 */
export function buildTimeSlotBreakdown(rows: TimeSlotRow[]): {
  timeSlots: TimeSlotStat[];
  totals: TimeSlotTotals;
} {
  const mapped = rows.map((r) => {
    const orders = typeof r.orders === "number" ? r.orders : parseInt(r.orders, 10) || 0;
    const expressOrders =
      typeof r.express_orders === "number"
        ? r.express_orders
        : parseInt(r.express_orders, 10) || 0;
    const revenue = num(r.revenue);
    const expressRevenue = num(r.express_revenue);
    return {
      slot: r.slot,
      sortStart: r.sort_start,
      orders,
      revenue,
      standardOrders: Math.max(orders - expressOrders, 0),
      standardRevenue: Math.max(revenue - expressRevenue, 0),
      expressOrders,
      expressRevenue,
      expressSurchargeUsd: num(r.express_surcharge_usd),
      slotFeeUsd: num(r.slot_fee_usd),
    };
  });

  mapped.sort((a, b) => {
    if (a.slot === null && b.slot === null) return 0;
    if (a.slot === null) return 1;
    if (b.slot === null) return -1;
    const as = a.sortStart ?? a.slot;
    const bs = b.sortStart ?? b.slot;
    return as < bs ? -1 : as > bs ? 1 : 0;
  });

  const totals = mapped.reduce<TimeSlotTotals>(
    (acc, s) => {
      acc.orders += s.orders;
      acc.revenue += s.revenue;
      acc.expressOrders += s.expressOrders;
      acc.expressRevenue += s.expressRevenue;
      acc.expressSurchargeUsd += s.expressSurchargeUsd;
      acc.slotFeeUsd += s.slotFeeUsd;
      return acc;
    },
    {
      orders: 0,
      revenue: 0,
      expressOrders: 0,
      expressRevenue: 0,
      expressSurchargeUsd: 0,
      slotFeeUsd: 0,
    },
  );

  const timeSlots = mapped.map(({ sortStart: _sortStart, ...s }) => ({
    ...s,
    sharePct:
      totals.revenue > 0 ? Math.round((s.revenue / totals.revenue) * 1000) / 10 : 0,
  }));

  return { timeSlots, totals };
}

// ── Delivery punctuality (on-time vs late) ─────────────────────────────────

/** Grace window (minutes) an express order gets from placement to delivery. */
export const EXPRESS_ON_TIME_MINUTES = 90;

/** Raw per-order row needed to classify delivery punctuality. */
export type PunctualityOrderInput = {
  id: string;
  display_order_number: string | null;
  ordered_at: Date | string | null;
  created_at: Date | string | null;
  window_end: Date | string | null;
  is_express: boolean;
  completed_at: Date | string | null;
};

export type PunctualityOrder = {
  id: string;
  displayOrderNumber: string | null;
  placedAt: string;
  deadline: string;
  completedAt: string;
  isExpress: boolean;
  /** Positive = minutes late, negative = minutes early (rounded). */
  minutesLate: number;
  status: "on_time" | "late";
};

function toDate(v: Date | string | null | undefined): Date | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Classify one completed order as on-time or late.
 *
 * - Express orders (`is_express`): on-time when completed within
 *   {@link EXPRESS_ON_TIME_MINUTES} of placement (`ordered_at`, falling back
 *   to `created_at`).
 * - Standard orders: on-time when completed at or before `window_end`.
 * - Returns null (excluded) when the order has no completion time, or is a
 *   standard order without a delivery window, or lacks the needed timestamps.
 */
export function classifyPunctuality(
  row: PunctualityOrderInput,
): PunctualityOrder | null {
  const completedAt = toDate(row.completed_at);
  if (!completedAt) return null;
  const placedAt = toDate(row.ordered_at) ?? toDate(row.created_at);

  let deadline: Date | null = null;
  if (row.is_express) {
    if (!placedAt) return null;
    deadline = new Date(placedAt.getTime() + EXPRESS_ON_TIME_MINUTES * 60_000);
  } else {
    deadline = toDate(row.window_end);
  }
  if (!deadline) return null;

  const diffMinutes = Math.round(
    (completedAt.getTime() - deadline.getTime()) / 60_000,
  );
  return {
    id: row.id,
    displayOrderNumber: row.display_order_number ?? null,
    placedAt: (placedAt ?? completedAt).toISOString(),
    deadline: deadline.toISOString(),
    completedAt: completedAt.toISOString(),
    isExpress: row.is_express,
    minutesLate: diffMinutes,
    status: completedAt.getTime() <= deadline.getTime() ? "on_time" : "late",
  };
}

/**
 * A single funnel step (or a named event group) mapped to the set of
 * `web_events.event_type` values the website may emit for it. A session is
 * counted as "reaching" the step when it has fired at least one of these event
 * types within the reporting window. Multiple synonyms are accepted so the
 * website enabler is never blocked by exact naming.
 */
export type FunnelStepDef = { key: string; eventTypes: string[] };

/**
 * Ordered conversion funnel from homepage visit → order created. Each step lists
 * the accepted `event_type` values. The last step is the conversion goal used to
 * compute per-dimension conversion rates.
 */
export const FUNNEL_STEPS: FunnelStepDef[] = [
  { key: "homepage_visit", eventTypes: ["home_view", "page_view"] },
  { key: "country_selected", eventTypes: ["country_selected"] },
  { key: "city_selected", eventTypes: ["city_selected"] },
  { key: "category_occasion_viewed", eventTypes: ["category_view", "occasion_view"] },
  { key: "product_viewed", eventTypes: ["product_view"] },
  { key: "add_to_cart", eventTypes: ["add_to_cart"] },
  { key: "checkout_started", eventTypes: ["checkout_started", "checkout_step"] },
  {
    key: "delivery_details_added",
    eventTypes: ["delivery_details_added", "delivery_details"],
  },
  { key: "payment_started", eventTypes: ["payment_started"] },
  { key: "payment_completed", eventTypes: ["payment_completed"] },
  { key: "order_created", eventTypes: ["order_created", "purchase"] },
];

/**
 * Presentail-specific behavioral events surfaced alongside the funnel. These are
 * meaningful moments in the flower e-commerce flow that are not funnel steps but
 * signal friction or intent (e.g. product went unavailable after a city change,
 * promo code failed, payment link opened).
 */
export const PRESENTAIL_FUNNEL_EVENTS: FunnelStepDef[] = [
  { key: "country_selected", eventTypes: ["country_selected"] },
  { key: "city_selected", eventTypes: ["city_selected"] },
  {
    key: "delivery_datetime_selected",
    eventTypes: ["delivery_datetime_selected", "delivery_time_selected"],
  },
  {
    key: "product_unavailable_city_change",
    eventTypes: ["product_unavailable_city_change"],
  },
  {
    key: "free_delivery_threshold_viewed",
    eventTypes: ["free_delivery_threshold_viewed"],
  },
  { key: "payment_link_opened", eventTypes: ["payment_link_opened"] },
  { key: "payment_failed", eventTypes: ["payment_failed"] },
  { key: "promo_applied", eventTypes: ["promo_applied"] },
  { key: "promo_failed", eventTypes: ["promo_failed"] },
];

/**
 * Funnel step keys whose events mark a session as "converted" for the
 * per-dimension breakdowns. The storefront reliably emits `payment_completed`,
 * but the final `order_created`/`purchase` event rarely lands in the same
 * session, so either counts. Step counts themselves are unaffected.
 */
export const FUNNEL_CONVERTED_STEP_KEYS = [
  "payment_completed",
  "order_created",
] as const;

/**
 * Store languages surfaced individually in the funnel language breakdown.
 * Every other base language (and empty/null) folds into `other`.
 */
export const FUNNEL_LANGUAGE_BUCKETS = ["en", "ar", "fr"] as const;

/** Single-quote a server-defined constant for safe inlining in SQL. */
export function sqlQuote(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

/** `event_type IN ('a','b')` fragment for a step's accepted event types. */
export function eventTypeInList(eventTypes: string[]): string {
  return `event_type IN (${eventTypes.map(sqlQuote).join(", ")})`;
}

/**
 * SQL boolean expression flagging a session as converted for the breakdown
 * tables (references the per-step `sN` flags of the `sess` CTE).
 */
export function funnelConvertedSql(): string {
  const indexes = FUNNEL_STEPS.map((s, i) =>
    (FUNNEL_CONVERTED_STEP_KEYS as readonly string[]).includes(s.key) ? i : -1,
  ).filter((i) => i >= 0);
  return `(${indexes.map((i) => `s${i}`).join(" OR ")})`;
}

/**
 * SQL expression normalizing a raw browser locale (en-US, ar_EG, fr-FR, …) to
 * its base language bucket: `en` / `ar` / `fr`, everything else (including
 * empty/null) → `other`.
 */
export function languageBucketSql(col: string): string {
  const base = `lower(split_part(replace(COALESCE(${col}, ''), '_', '-'), '-', 1))`;
  const list = FUNNEL_LANGUAGE_BUCKETS.map(sqlQuote).join(", ");
  return `CASE WHEN ${base} IN (${list}) THEN ${base} ELSE 'other' END`;
}

/**
 * Build the funnel step-count query. Aggregates web_events into sessions, flags
 * which funnel steps each session reached, then counts distinct sessions per
 * step. When `withBreakdowns` is true, also returns per-dimension session +
 * conversion breakdowns (device, country, city, language, traffic source).
 * Breakdown "conversions" count sessions that reached payment_completed OR
 * order_created/purchase; step counts themselves are untouched.
 */
export function buildFunnelQuery(
  filterSql: string,
  withBreakdowns: boolean,
): string {
  const stepFlags = FUNNEL_STEPS.map(
    (s, i) => `bool_or(${eventTypeInList(s.eventTypes)}) AS s${i}`,
  ).join(",\n        ");
  const stepCounts = FUNNEL_STEPS.map(
    (_, i) => `count(*) FILTER (WHERE s${i}) AS s${i}`,
  ).join(",\n          ");

  const converted = funnelConvertedSql();

  const breakdown = (valueExpr: string) => `
    (SELECT COALESCE(json_agg(row_to_json(b)), '[]'::json) FROM (
      SELECT ${valueExpr} AS value,
             count(*) AS sessions,
             count(*) FILTER (WHERE ${converted}) AS conversions
      FROM sess
      GROUP BY 1
      ORDER BY 2 DESC
      LIMIT 12
    ) b)`;
  const rawValue = (col: string) => `COALESCE(NULLIF(${col}, ''), 'unknown')`;

  return `
    WITH ev AS (
      SELECT
        we.session_id,
        we.event_type,
        we.device_type,
        we.country,
        we.city,
        we.language,
        we.traffic_source
      FROM web_events we
      WHERE we.workspace_owner_id = $1
        AND we.occurred_at >= $2
        AND we.occurred_at < $3
        AND we.session_id IS NOT NULL
        ${filterSql}
    ),
    sess AS (
      SELECT
        session_id,
        ${stepFlags},
        max(device_type) AS device_type,
        max(country) AS country,
        max(city) AS city,
        max(language) AS language,
        max(traffic_source) AS traffic_source
      FROM ev
      GROUP BY session_id
    ),
    steps AS (
      SELECT
        count(*) AS total_sessions,
        ${stepCounts}
      FROM sess
    )
    SELECT
      (SELECT row_to_json(steps) FROM steps) AS steps
      ${
        withBreakdowns
          ? `,
      ${breakdown(rawValue("device_type"))} AS by_device,
      ${breakdown(rawValue("country"))} AS by_country,
      ${breakdown(rawValue("city"))} AS by_city,
      ${breakdown(languageBucketSql("language"))} AS by_language,
      ${breakdown(rawValue("traffic_source"))} AS by_traffic`
          : ""
      }
  `;
}
