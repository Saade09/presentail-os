import { Link } from "wouter";
import { HeartHandshake, History, ChevronDown, ChevronUp, Clock, MapPin, Filter } from "lucide-react";
import { useMemo, useState } from "react";
import CmcPosWhatsAppQrModal from "./cmc-pos/CmcPosWhatsAppQrModal";
import { apiFetch } from "@/lib/queryClient";
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";

import CmcPosKpiCards, { type CmcMetrics } from "./cmc-pos/CmcPosKpiCards";
import CmcPosPrimaryWorkflow from "./cmc-pos/CmcPosPrimaryWorkflow";
import CmcPosSecondaryWorkflows from "./cmc-pos/CmcPosSecondaryWorkflows";
import CmcPosCashDrawer from "./cmc-pos/CmcPosCashDrawer";
import CmcPosHealthStrip from "./cmc-pos/CmcPosHealthStrip";

import { computePendingRequests, formatAmount } from "./cmc-pos/cmcPosDashboard.helpers";

type PendingResolution = {
  id: number;
  resolver_name?: string | null;
  counted_balance: string;
  expected_balance: string;
  difference: string;
  reason: string;
  note: string | null;
  currency: string;
  created_at: string;
};

type ActiveShift = {
  id: number;
  location_id: number;
  location_name: string;
  location_timezone: string;
  /** "HH:MM" scheduled closing time configured for the location */
  location_cutoff_time?: string | null;
  opened_at: string;
  opening_cash?: string;
  currency?: string | null;
  /** True when this shift has run past its expected closing time */
  isOverdue?: boolean;
  /** ISO timestamp when the shift became overdue, or null */
  overdueAt?: string | null;
  /** Current status of the linked cash session, when one exists. */
  cash_session_status?: string | null;
  /** True when there is a pending (unresolved) resolution from a previous session */
  previousSessionPending?: boolean;
  /** Pending resolution summary for the manager approve/reject flow */
  pendingResolution?: PendingResolution | null;
};

type ShelfProductsResponse = {
  products: { id: number; stock_qty?: number }[];
};

/**
 * Compute how long after the scheduled close (cutoff time) a session was resolved.
 * Returns a human-readable string like "2h 15m" or null when data is missing.
 *
 * @param overdueAt          ISO timestamp when the session became overdue (cutoff + grace)
 * @param resolvedAt         ISO timestamp when the resolution was completed
 * @param graceMinutes       Grace period configured for the location (defaults to 30)
 */
function formatResolutionDelay(
  overdueAt: string | null,
  resolvedAt: string | null,
  graceMinutes: number | null,
): string | null {
  if (!overdueAt || !resolvedAt) return null;
  const overdueAtMs = new Date(overdueAt).getTime();
  const resolvedAtMs = new Date(resolvedAt).getTime();
  if (!Number.isFinite(overdueAtMs) || !Number.isFinite(resolvedAtMs)) return null;
  // scheduled close = overdue_at − grace, so we measure from the actual cutoff
  const graceMs = (graceMinutes ?? 30) * 60_000;
  const scheduledCloseMs = overdueAtMs - graceMs;
  const delayMs = resolvedAtMs - scheduledCloseMs;
  if (delayMs <= 0) return null;
  const totalMinutes = Math.floor(delayMs / 60_000);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/**
 * Compute the ISO timestamp for midnight at the start of today in the given
 * IANA timezone. DST-aware: derives the offset at midnight itself (not at the
 * current wall-clock time) so spring-forward/fall-back days are handled
 * correctly. Returns a stable zero-millisecond UTC ISO string.
 *
 * Strategy:
 * 1. Format `now` in the target timezone to get today's local calendar date.
 * 2. Start from UTC midnight of that calendar date as a first guess.
 * 3. Check what local time that UTC instant maps to and correct by the offset
 *    at *that* candidate — not at `now` — so DST transitions between midnight
 *    and the current time don't corrupt the result.
 */
function startOfDayInTimezone(tz: string): string {
  try {
    const now = new Date();

    // Step 1: get today's local date parts in the target timezone.
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const y = parseInt(parts.find((p) => p.type === "year")!.value, 10);
    const mo = parseInt(parts.find((p) => p.type === "month")!.value, 10);
    const d = parseInt(parts.find((p) => p.type === "day")!.value, 10);

    // Step 2: candidate = UTC midnight of that calendar date (0 ms, so stable).
    const candidate = new Date(Date.UTC(y, mo - 1, d, 0, 0, 0, 0));

    // Step 3: find the local time at the candidate and shift by the offset.
    const localTimeAtCandidate = new Intl.DateTimeFormat("sv-SE", {
      timeZone: tz,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).format(candidate);
    const [ch, cm, cs] = localTimeAtCandidate.split(":").map(Number);
    const elapsedMs = (ch * 3600 + cm * 60 + cs) * 1000;

    if (elapsedMs === 0) return candidate.toISOString();

    // If local time at UTC-midnight is AM, midnight is earlier in UTC.
    // If it's PM, midnight is later (timezone is behind UTC by more than 0).
    const adjusted =
      ch < 12
        ? new Date(candidate.getTime() - elapsedMs)
        : new Date(candidate.getTime() + (86_400_000 - elapsedMs));

    return adjusted.toISOString(); // always ends in .000Z — stable query key
  } catch {
    // Fallback: UTC midnight
    const d = new Date();
    return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).toISOString();
  }
}

export default function CmcPos() {
  // 1. Active shift — drives locationId, timezone, and subtitle for subsequent queries
  const { data: shiftData, isSuccess: shiftSettled } = useQuery<{ shift: ActiveShift | null }>({
    queryKey: ["cmc-pos-active-shift"],
    queryFn: () => apiFetch<{ shift: ActiveShift | null }>("/api/cmc-pos/shifts/active", {}),
    staleTime: 30_000,
  });

  const activeShift = shiftData?.shift ?? null;
  const locationId = activeShift?.location_id ?? null;
  const isShiftActive = activeShift !== null;
  const isOverdue = activeShift?.isOverdue ?? false;
  const isCashSessionFinalized =
    activeShift?.cash_session_status != null &&
    activeShift.cash_session_status !== "open";

  // Use the active location's configured timezone to bound today's KPIs correctly.
  // Falls back to "UTC" before the shift response arrives (shiftSettled = false means
  // metrics query is disabled anyway, so the exact value doesn't affect results).
  const locationTimezone = activeShift?.location_timezone ?? "UTC";
  // Memoised so the value (and therefore the query key) stays stable across
  // re-renders as long as the timezone hasn't changed.  The function always
  // returns a zero-millisecond ISO string, so the key is also identical for
  // any two renders within the same local calendar day.
  const from = useMemo(() => startOfDayInTimezone(locationTimezone), [locationTimezone]);

  // Subtitle: derive from the active location when known, else a safe default.
  const subtitle = activeShift
    ? `${activeShift.location_name} · Point of Sale`
    : "CMC POS · Point of Sale";

  // 2. Metrics — today's KPIs (shelf sales, requests, delivery counts)
  const {
    data: metrics,
    isLoading: metricsLoading,
    error: metricsError,
  } = useQuery<CmcMetrics>({
    queryKey: ["cmc-pos-metrics", from, locationId],
    queryFn: () => {
      const qs = locationId ? `&location_id=${locationId}` : "";
      return apiFetch<CmcMetrics>(
        `/api/cmc-pos/metrics?from=${encodeURIComponent(from)}${qs}`,
        {},
      );
    },
    enabled: shiftSettled,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  });

  // 3. Shelf product count + stock alerts — for inventory status in primary workflow
  const { data: shelfData } = useQuery<ShelfProductsResponse>({
    queryKey: ["cmc-pos-shelf-products", locationId],
    queryFn: () => {
      const qs = locationId ? `?location_id=${locationId}` : "";
      return apiFetch<ShelfProductsResponse>(`/api/cmc-pos/shelf-products${qs}`, {});
    },
    enabled: shiftSettled,
    staleTime: 60_000,
  });

  const products = shelfData?.products ?? [];
  const productCount = shelfData ? products.length : undefined;

  // Stock alerts: products where the location's stock is 0 (only available when
  // locationId is set, since the shelf-products endpoint only joins stock when
  // a location_id is provided).
  const stockAlerts = locationId
    ? products.filter((p) => p.stock_qty !== undefined && p.stock_qty <= 0).length
    : 0;

  const cashSalesTotal = Number(metrics?.sales.cash_total ?? 0) || 0;
  const cashRefundsTotal = Number(metrics?.sales.cash_refunds_total ?? 0) || 0;

  // WhatsApp QR modal
  const [whatsappQrOpen, setWhatsappQrOpen] = useState(false);

  // Overdue resolve trigger — incrementing tells the cash drawer to open its close form
  const [resolveOverdueTrigger, setResolveOverdueTrigger] = useState(0);

  // Permission check — manager-level filter chip visibility
  const { isOwner, allowedPages } = useWorkspaceRole();
  const can = (perm: string) => isOwner || (allowedPages?.includes(perm) ?? false);

  // Shift history
  const [historyOpen, setHistoryOpen] = useState(false);
  /** When true, only shifts resolved via the overdue flow are shown. */
  const [overdueFilter, setOverdueFilter] = useState(false);

  const { data: shiftsData, isLoading: shiftsLoading } = useQuery<{
    shifts: {
      id: number;
      status: string;
      location_name: string | null;
      opened_at: string;
      closed_at: string | null;
      opening_cash: string;
      closing_cash_kept: string | null;
      closing_cash_transferred: string | null;
      discrepancy_note: string | null;
      currency: string | null;
      /** Sum of cash_sale transactions for this shift's session */
      cash_sales_total: string | null;
      /** ID of the linked overdue resolution row, if any */
      resolution_id: number | null;
      resolution_status: string | null;
      overdue_at: string | null;
      resolved_at: string | null;
      original_business_date: string | null;
      resolution_grace_minutes: number | null;
    }[];
  }>({
    queryKey: ["cmc-pos-shifts", locationId, overdueFilter],
    queryFn: () => {
      const parts: string[] = [];
      if (locationId) parts.push(`location_id=${locationId}`);
      if (overdueFilter) parts.push("filter=overdue");
      const qs = parts.length ? `?${parts.join("&")}` : "";
      return apiFetch(`/api/cmc-pos/shifts${qs}`);
    },
    enabled: historyOpen,
    staleTime: 60_000,
  });

  const pendingRequests = computePendingRequests(
    metrics?.requests.submitted_count,
    metrics?.requests.accepted_count,
    metrics?.requests.dispatched_count,
  );
  const paymentIssues = parseInt(metrics?.sales.payment_issues ?? "0") || 0;

  return (
    <div className="min-h-full bg-gray-50/40 p-4 sm:p-6 space-y-5">
      {/* ── Page header ───────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl" style={{ background: "#e0eff0" }}>
            <HeartHandshake className="h-5 w-5" style={{ color: "#00414e" }} />
          </div>
          <div>
            <h1 className="text-xl font-bold text-gray-900 sm:text-2xl">CMC POS Dashboard</h1>
            <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>
          </div>
        </div>

        {/* Status badges + history button */}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setWhatsappQrOpen(true)}
            aria-label="Show WhatsApp ordering QR code"
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 text-xs font-medium text-gray-700 hover:bg-gray-50 transition-colors shadow-sm"
          >
            {/* WhatsApp icon in brand green */}
            <svg width="14" height="14" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <path d="M16 2C8.268 2 2 8.268 2 16c0 2.478.672 4.8 1.846 6.794L2 30l7.394-1.826A13.937 13.937 0 0 0 16 30c7.732 0 14-6.268 14-14S23.732 2 16 2Z" fill="#25D366"/>
              <path d="M22.08 19.04c-.318-.16-1.88-.928-2.172-1.034-.292-.106-.504-.16-.716.16-.212.318-.822 1.034-.99 1.24-.178.212-.35.24-.666.08-.318-.16-1.34-.494-2.552-1.574-.944-.842-1.58-1.882-1.764-2.2-.186-.318-.02-.49.14-.648.142-.14.318-.37.478-.554.16-.184.212-.318.318-.528.106-.212.054-.398-.026-.558-.08-.16-.716-1.726-.98-2.364-.258-.622-.52-.538-.716-.548-.186-.008-.398-.01-.61-.01-.212 0-.558.08-.85.398-.292.318-1.11 1.086-1.11 2.648 0 1.562 1.136 3.072 1.296 3.284.158.212 2.236 3.41 5.418 4.784.756.326 1.346.52 1.806.666.758.24 1.448.206 1.994.126.608-.09 1.88-.768 2.146-1.51.266-.742.266-1.38.186-1.512-.08-.132-.292-.212-.61-.37Z" fill="white"/>
            </svg>
            WhatsApp QR
          </button>
          <Link href="/cmc-pos/sales" asChild>
            <a
              data-testid="btn-view-sales-history"
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-gray-200 bg-white px-3 text-xs font-medium text-gray-700 hover:bg-gray-50 transition-colors shadow-sm"
            >
              <History className="h-3.5 w-3.5" style={{ color: "#00414e" }} />
              View Sales History
            </a>
          </Link>
        </div>
      </div>

      <CmcPosWhatsAppQrModal open={whatsappQrOpen} onOpenChange={setWhatsappQrOpen} />

      {/* ── KPI cards ─────────────────────────────────────────────────── */}
      <CmcPosKpiCards
        metrics={metrics}
        isLoading={!shiftSettled || metricsLoading}
        error={metricsError as Error | null}
      />

      {/* ── Two-column body ───────────────────────────────────────────── */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_320px]">
        {/* Left column */}
        <div className="space-y-5">
          <CmcPosPrimaryWorkflow
            productCount={productCount}
            isShiftActive={isShiftActive}
            isOverdue={isOverdue}
          />

          <CmcPosSecondaryWorkflows />

          <CmcPosHealthStrip
            counts={{
              pendingRequests,
              paymentIssues,
              stockAlerts,
            }}
            isOverdue={isOverdue}
            isSessionFinalized={isCashSessionFinalized}
            onResolveOverdue={() => setResolveOverdueTrigger((v) => v + 1)}
          />

        </div>

        {/* Right column — cash drawer */}
        <div className="lg:self-start lg:sticky lg:top-6">
          <CmcPosCashDrawer
            locationId={locationId}
            locationName={activeShift?.location_name ?? null}
            shiftId={activeShift?.id ?? null}
            shiftOpenedAt={activeShift?.opened_at ?? null}
            openingCash={Number(activeShift?.opening_cash ?? 0)}
            shiftCurrency={activeShift?.currency ?? null}
            isShiftActive={isShiftActive}
            isOverdue={isOverdue}
            isSessionFinalized={isCashSessionFinalized}
            locationTimezone={locationTimezone}
            locationCutoffTime={activeShift?.location_cutoff_time ?? null}
            resolveOverdueTrigger={resolveOverdueTrigger}
            cashSalesTotal={cashSalesTotal}
            cashRefundsTotal={cashRefundsTotal}
            previousSessionPending={activeShift?.previousSessionPending ?? false}
            pendingResolution={activeShift?.pendingResolution ?? null}
          />
        </div>
      </div>

      {/* ── Shift History ──────────────────────────────────────────── */}
      <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
        <button
          type="button"
          className="flex w-full items-center justify-between px-5 py-4 border-b border-gray-100 bg-gray-50 text-left"
          onClick={() => setHistoryOpen((v) => !v)}
        >
          <div className="flex items-center gap-2">
            <Clock className="h-4 w-4" style={{ color: "#00414e" }} />
            <span className="text-sm font-semibold text-gray-900">Shift History</span>
          </div>
          {historyOpen ? (
            <ChevronUp className="h-4 w-4 text-gray-400" />
          ) : (
            <ChevronDown className="h-4 w-4 text-gray-400" />
          )}
        </button>

        {/* Manager-only filter chip — visible when history is open */}
        {historyOpen && can("cash_sessions.approve") && (
          <div className="flex items-center gap-2 px-5 py-2 border-b border-gray-100 bg-gray-50/60">
            <button
              type="button"
              onClick={() => setOverdueFilter((v) => !v)}
              className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                overdueFilter
                  ? "bg-orange-100 text-orange-800 border border-orange-200"
                  : "bg-white text-gray-600 border border-gray-200 hover:bg-gray-50"
              }`}
            >
              <Filter className="h-3 w-3" />
              {overdueFilter ? "Showing overdue only" : "Show overdue only"}
            </button>
          </div>
        )}

        {historyOpen && (
          <div className="divide-y divide-gray-100">
            {shiftsLoading && (
              <div className="px-5 py-4 space-y-2">
                {[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
              </div>
            )}
            {!shiftsLoading && (shiftsData?.shifts ?? []).length === 0 && (
              <div className="px-5 py-6 text-center text-sm text-gray-400">
                {overdueFilter ? "No overdue shifts found" : "No shifts yet"}
              </div>
            )}
            {(shiftsData?.shifts ?? []).map((s) => {
              // Expected balance at close = opening_cash + cash_sales_total (from ledger)
              const shiftExpectedBalance =
                Number(s.opening_cash) + Number(s.cash_sales_total ?? 0);
              const discrepancy =
                s.closing_cash_kept !== null
                  ? Math.round(
                      (Number(s.closing_cash_kept) +
                        Number(s.closing_cash_transferred ?? 0) -
                        shiftExpectedBalance) *
                        100,
                    ) / 100
                  : null;
              const resolutionDelay = formatResolutionDelay(
                s.overdue_at,
                s.resolved_at,
                s.resolution_grace_minutes,
              );
              return (
                <div key={s.id} className="px-5 py-3 flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2">
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
                          s.status === "open"
                            ? "bg-emerald-100 text-emerald-800"
                            : "bg-gray-100 text-gray-600"
                        }`}
                      >
                        {s.status === "open" ? "Open" : "Closed"}
                      </span>
                      {s.resolution_id != null && (
                        <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium bg-orange-100 text-orange-800">
                          Resolved Late
                        </span>
                      )}
                      {s.location_name && (
                        <span className="flex items-center gap-1 text-xs text-gray-500">
                          <MapPin className="h-3 w-3" />
                          {s.location_name}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-500">
                      {new Date(s.opened_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}
                      {s.closed_at &&
                        ` → ${new Date(s.closed_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`}
                    </p>
                    {resolutionDelay && (
                      <p className="text-xs text-orange-700">
                        Resolved {resolutionDelay} after scheduled close
                      </p>
                    )}
                    {s.discrepancy_note && (
                      <p className="text-xs text-amber-700 italic">{s.discrepancy_note}</p>
                    )}
                  </div>
                  <div className="text-right space-y-0.5">
                    <p className="text-sm font-semibold tabular-nums">
                      Opening: {s.currency ? formatAmount(Number(s.opening_cash), s.currency) : "Currency unavailable"}
                    </p>
                    {s.closing_cash_kept !== null && (
                      <p className="text-xs text-gray-600 tabular-nums">
                        Kept: {s.currency ? formatAmount(Number(s.closing_cash_kept), s.currency) : "Currency unavailable"}
                        {Number(s.closing_cash_transferred ?? 0) > 0 &&
                          ` · Sent: ${s.currency ? formatAmount(Number(s.closing_cash_transferred), s.currency) : "Currency unavailable"}`}
                      </p>
                    )}
                    {discrepancy !== null && Math.abs(discrepancy) > 0.005 && (
                      <p className={`text-xs font-medium tabular-nums ${discrepancy < 0 ? "text-amber-700" : "text-emerald-700"}`}>
                        {discrepancy > 0 ? "+" : ""}{s.currency ? formatAmount(discrepancy, s.currency) : "Currency unavailable"} discrepancy
                      </p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
