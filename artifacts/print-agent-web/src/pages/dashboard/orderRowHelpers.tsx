import { useState } from "react";
import { ShoppingCart } from "lucide-react";
import { normalizeOrderStatus } from "@/lib/orderStatus";
import {
  deliveryScheduleDateKey,
  marketDateKey,
  resolveDeliverySchedule,
} from "@/lib/deliveryDate";

/**
 * Order row shape returned by GET /api/orders, shared by the Orders list and
 * the Orders board view so both consumers stay in sync with the API response.
 */
export type OrderRow = {
  id: string;
  display_order_number: string | null;
  external_order_id: string | null;
  status: string;
  source: string | null;
  channel: string | null;
  ordered_at: string | null;
  delivery_type: string | null;
  window_start: string | null;
  window_end: string | null;
  created_at: string;
  delivery_address: Record<string, unknown> | null;
  totals: Record<string, unknown> | null;
  contact_name: string | null;
  contact_email: string | null;
  contact_phone: string | null;
  is_anonymous?: boolean;
  payment_status: string | null;
  payment_method: string | null;
  payment_summary?: {
    commercial_total: number | string | null;
    commercial_currency: string | null;
    paid: number | string;
    pending: number | string;
    remaining: number | string | null;
    overpaid: number | string;
    linked_count: number;
    currency_mismatch: boolean;
  };
  driver_first_name: string | null;
  driver_last_name: string | null;
  assignment_status: string | null;
  thumbnail_url: string | null;
  qr_link: string | null;
  delivery_date_review: string | null;
  workshop: {
    location_id: number;
    location_name: string;
    status: "pending" | "in_progress" | "paused" | "completed";
  } | null;
  delivered_at: string | null;
  delivery_timezone: string;
};

export type DriverOption = {
  id: number;
  first_name: string | null;
  last_name: string | null;
  onboarding_status?: string | null;
};

export type OrdersResponse = {
  orders: OrderRow[];
  total: number;
  limit: number;
  offset: number;
};

export const PAGE_SIZE = 50;

/** Order statuses considered "closed" — no longer needing operational action. */
export const TERMINAL_STATUSES = new Set(["completed", "cancelled", "refunded"]);

/**
 * Statuses a dispatcher no longer needs to act on. These rows sink to the
 * bottom of their day group and render muted; they also show no countdown.
 * (Broader than TERMINAL_STATUSES: a delivered order is done operationally
 * even before it is closed out as completed.)
 */
export const FINISHED_STATUSES = new Set([...TERMINAL_STATUSES, "delivered"]);

export function isFinished(o: OrderRow): boolean {
  return FINISHED_STATUSES.has(normalizeOrderStatus(o.status));
}

export function hasDriver(o: OrderRow): boolean {
  return !!(o.driver_first_name || o.driver_last_name);
}

export function driverFullName(o: OrderRow): string {
  return `${o.driver_first_name ?? ""} ${o.driver_last_name ?? ""}`.trim();
}

export function driverInitials(o: OrderRow): string {
  const a = (o.driver_first_name ?? "").trim();
  const b = (o.driver_last_name ?? "").trim();
  const initials = `${a.charAt(0)}${b.charAt(0)}`.trim();
  return (initials || a.charAt(0) || "?").toUpperCase();
}

/**
 * Whether an order needs a driver: no driver assigned and not in a closed
 * state. Used by the Unassigned quick-filter chip and driver filter.
 */
export function isUnassigned(o: OrderRow): boolean {
  return !hasDriver(o) && !TERMINAL_STATUSES.has(normalizeOrderStatus(o.status));
}

/** COD detection from the payment method recorded on the order. */
export function isCod(o: OrderRow): boolean {
  const method = (o.payment_method ?? "").toLowerCase();
  return method === "cod" || method === "cash" || method === "cash_on_delivery";
}

/**
 * Resolves a Payment badge from the order's payment method/status, or null when
 * there is nothing meaningful to show (rendered as "—"). COD takes precedence
 * over the raw status because cash orders are typically "unpaid" until handover.
 */
export function paymentBadge(o: OrderRow): { labelKey: string; cls: string } | null {
  if (isCod(o)) {
    return {
      labelKey: "orders.paymentCod",
      cls: "bg-amber-100 text-amber-800 border-amber-200",
    };
  }
  const status = (o.payment_status ?? "").toLowerCase();
  if (status === "paid") {
    return {
      labelKey: "orders.paymentPaid",
      cls: "bg-green-100 text-green-800 border-green-200",
    };
  }
  if (status === "refunded") {
    return {
      labelKey: "orders.paymentRefunded",
      cls: "bg-purple-100 text-purple-800 border-purple-200",
    };
  }
  if (
    status === "unpaid" ||
    status === "pending" ||
    status === "unverified" ||
    status === "failed"
  ) {
    return {
      labelKey: "orders.paymentUnpaid",
      cls: "bg-rose-100 text-rose-800 border-rose-200",
    };
  }
  return null;
}

/**
 * True when the payment badge represents an exception a dispatcher should act
 * on (unpaid/COD) rather than a settled state (paid/refunded). Backs the
 * board's payment exception badge as well as the list's "needs attention" dot.
 */
export function isPaymentException(o: OrderRow): boolean {
  const badge = paymentBadge(o);
  return (
    badge != null &&
    badge.labelKey !== "orders.paymentPaid" &&
    badge.labelKey !== "orders.paymentRefunded"
  );
}

/** All list times are judged in the business timezone, not the browser's. */
export const BUSINESS_TZ = "Asia/Beirut";

const businessDayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: BUSINESS_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** `yyyy-MM-dd` calendar date of a timestamp as seen in Asia/Beirut. */
export function businessDateKey(ms: number): string {
  return businessDayFormatter.format(new Date(ms));
}

export type UrgencyGroup = "today" | "tomorrow" | "later" | "unscheduled" | "past";

export type Urgency = {
  group: UrgencyGroup;
  /** Epoch ms of the window end (falls back to start); null when unscheduled. */
  endMs: number | null;
  startMs: number | null;
  finished: boolean;
};

/**
 * Classifies an order for urgency using the same canonical/legacy resolver as
 * the list and detail renderers. Orders lacking usable delivery information
 * are unscheduled rather than guessed. Past-date open orders group under Today
 * because they still compete for today's dispatch.
 */
export function getUrgency(o: OrderRow, nowMs: number): Urgency {
  const finished = isFinished(o);
  const addr = o.delivery_address ?? {};
  const schedule = resolveDeliverySchedule({
    windowStart: o.window_start,
    windowEnd: o.window_end,
    legacyDate: addr["date"],
    legacySlot: addr["slot"],
  });
  if (!schedule || schedule.source === "invalid" || schedule.source === "unscheduled") {
    return { group: "unscheduled", endMs: null, startMs: null, finished };
  }
  const timeZone = o.delivery_timezone || BUSINESS_TZ;
  const dayKey = deliveryScheduleDateKey(schedule, timeZone);
  const startMs = schedule.start?.getTime() ?? NaN;
  const endMs = schedule.end?.getTime() ?? NaN;
  const hasStart = Number.isFinite(startMs);
  const hasEnd = Number.isFinite(endMs);

  // No delivery date, or no time slot at all → Unscheduled (never guessed into Today).
  if (!dayKey || (schedule.source === "canonical" && !hasStart && !hasEnd)) {
    return { group: "unscheduled", endMs: null, startMs: null, finished };
  }

  const todayKey = marketDateKey(new Date(nowMs), timeZone);
  const tomorrowDate = new Date(`${todayKey}T00:00:00.000Z`);
  tomorrowDate.setUTCDate(tomorrowDate.getUTCDate() + 1);
  const tomorrowKey = tomorrowDate.toISOString().slice(0, 10);
  // Past-date OPEN orders fold into Today (they're overdue and compete for
  // today's dispatch); past-date FINISHED orders are history, not urgency.
  let group: UrgencyGroup =
    dayKey <= todayKey ? "today" : dayKey === tomorrowKey ? "tomorrow" : "later";
  if (finished && dayKey < todayKey) group = "past";

  return {
    group,
    endMs: hasEnd ? endMs : startMs,
    startMs: hasStart ? startMs : null,
    finished,
  };
}

/**
 * At-risk classification shared by the Orders list "At Risk" summary card and
 * the board's at-risk sort/badge: an open (not finished) order whose delivery
 * day has already passed (per the viewer's local calendar, matching the
 * Delivery column), or which is explicitly on hold.
 */
export function isAtRiskOrder(o: OrderRow, nowMs: number): boolean {
  if (isFinished(o)) return false;
  if (normalizeOrderStatus(o.status) === "on_hold") return true;
  const addr = o.delivery_address ?? {};
  const schedule = resolveDeliverySchedule({
    windowStart: o.window_start,
    windowEnd: o.window_end,
    legacyDate: addr["date"],
    legacySlot: addr["slot"],
  });
  if (!schedule || schedule.source === "invalid" || schedule.source === "unscheduled") return false;
  const tz = o.delivery_timezone || BUSINESS_TZ;
  return deliveryScheduleDateKey(schedule, tz) < marketDateKey(new Date(nowMs), tz);
}

/**
 * Small representative product thumbnail for an order row. Shows the resolved
 * image when available; on a load error (or no URL) it falls back to a neutral
 * placeholder icon rather than leaving an empty box.
 */
export function OrderThumbnail({ src }: { src: string | null }) {
  const [failed, setFailed] = useState(false);
  const showImage = src && !failed;
  return (
    <div className="h-10 w-10 shrink-0 overflow-hidden rounded-md border border-border bg-secondary/40">
      {showImage ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <div className="flex h-full w-full items-center justify-center text-muted-foreground/30">
          <ShoppingCart size={16} />
        </div>
      )}
    </div>
  );
}
