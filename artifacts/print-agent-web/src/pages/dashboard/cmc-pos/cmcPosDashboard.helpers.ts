/**
 * Pure helpers for the CMC POS Dashboard redesign.
 * All functions are side-effect-free so they can be unit-tested directly.
 */

// ── Currency formatting ───────────────────────────────────────────────────

export function formatUsd(value: string | number | null | undefined): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return "$0.00";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatLbp(value: string | number | null | undefined): string {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return "0 LBP";
  return `${Math.round(n).toLocaleString("en-US")} LBP`;
}

export function formatAmount(value: string | number | null | undefined, currency: string): string {
  if (currency === "LBP") return formatLbp(value);
  if (currency === "USD") return formatUsd(value);
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return `0.00 ${currency}`;
  return `${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

// ── Health strip severity ─────────────────────────────────────────────────

export type HealthSeverity = "ok" | "warning" | "critical";

export type HealthCounts = {
  pendingRequests: number;
  paymentIssues: number;
  stockAlerts: number;
};

export function deriveHealthSeverity(counts: HealthCounts): HealthSeverity {
  const total = counts.pendingRequests + counts.paymentIssues + counts.stockAlerts;
  if (total === 0) return "ok";
  if (counts.paymentIssues > 0 || counts.stockAlerts > 0) return "critical";
  return "warning";
}

export function healthMessage(severity: HealthSeverity): string {
  if (severity === "ok") return "Everything is running smoothly";
  if (severity === "critical") return "Attention required";
  return "Some items need review";
}

// ── Status badge labels ───────────────────────────────────────────────────

const SALE_STATUS_LABELS: Record<string, string> = {
  paid: "Completed",
  refunded: "Refunded",
  voided: "Voided",
};

const REQUEST_STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  submitted: "Submitted",
  accepted: "Accepted",
  dispatched: "Dispatched",
  received: "Received",
  cancelled: "Cancelled",
};

const DELIVERY_STATUS_LABELS: Record<string, string> = {
  accepted: "In Preparation",
  dispatched: "Dispatched",
  completed: "Completed",
  delivered: "Delivered",
  cancelled: "Cancelled",
};

export function activityStatusLabel(type: string, status: string): string {
  if (type === "sale") return SALE_STATUS_LABELS[status] ?? status;
  if (type === "request") return REQUEST_STATUS_LABELS[status] ?? status;
  if (type === "delivery") return DELIVERY_STATUS_LABELS[status] ?? status;
  return status;
}

export function activityTypeLabel(type: string): string {
  if (type === "sale") return "Shelf Sale";
  if (type === "request") return "Branch Request";
  if (type === "delivery") return "Delivery Order";
  return type;
}

// ── Status badge color classes ────────────────────────────────────────────

export function statusBadgeClasses(type: string, status: string): string {
  if (type === "sale") {
    if (status === "paid") return "bg-emerald-100 text-emerald-800";
    if (status === "refunded") return "bg-amber-100 text-amber-800";
    if (status === "voided") return "bg-red-100 text-red-700";
  }
  if (type === "request") {
    if (status === "dispatched") return "bg-blue-100 text-blue-800";
    if (status === "received") return "bg-emerald-100 text-emerald-800";
    if (status === "submitted" || status === "accepted") return "bg-amber-100 text-amber-800";
    if (status === "cancelled") return "bg-red-100 text-red-700";
  }
  if (type === "delivery") {
    if (status === "completed" || status === "delivered") return "bg-emerald-100 text-emerald-800";
    if (status === "dispatched") return "bg-blue-100 text-blue-800";
    if (status === "accepted") return "bg-violet-100 text-violet-800";
    if (status === "cancelled") return "bg-red-100 text-red-700";
  }
  return "bg-gray-100 text-gray-700";
}

// ── KPI helpers ───────────────────────────────────────────────────────────

export function computeTodayRevenue(
  grossTotal: string | null | undefined,
  deliveryRevenue: string | null | undefined,
): number {
  return (Number(grossTotal ?? 0) || 0) + (Number(deliveryRevenue ?? 0) || 0);
}

export function computeTotalOrders(
  paidCount: string | null | undefined,
  deliveryCount: string | null | undefined,
): number {
  return (parseInt(paidCount ?? "0") || 0) + (parseInt(deliveryCount ?? "0") || 0);
}

export function computePendingRequests(
  submittedCount: string | null | undefined,
  acceptedCount: string | null | undefined,
  dispatchedCount: string | null | undefined,
): number {
  return (
    (parseInt(submittedCount ?? "0") || 0) +
    (parseInt(acceptedCount ?? "0") || 0) +
    (parseInt(dispatchedCount ?? "0") || 0)
  );
}
