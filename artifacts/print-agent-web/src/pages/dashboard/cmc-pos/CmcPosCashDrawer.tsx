import { useState, useEffect } from "react";
import { Link } from "wouter";
import {
  Eye, Lock, DollarSign, AlertTriangle, CheckCircle2,
  PlayCircle, XCircle, Loader2, Clock, ShieldCheck,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiFetch } from "@/lib/queryClient";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/hooks/use-toast";
import { formatUsd, formatLbp } from "./cmcPosDashboard.helpers";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { StartShiftForm } from "./StartShiftForm";
import ResolveShiftModal from "./ResolveShiftModal";
import ApproveResolutionModal, { type PendingResolution } from "./ApproveResolutionModal";

// ── Types ─────────────────────────────────────────────────────────────────

type CurrencySummary = {
  currency: string;
  opening_cash: number;
  sales_collected: number;
  expenses_paid: number;
  adjustments: number;
  expected_cash: number;
};

type ReconciliationCount = { currency: string; variance: number };

type CmcCashDrawerResponse = {
  session: {
    id: number;
    status: string;
    currency: string;
    secondary_currency: string | null;
    opening_cash: string;
    opened_at: string;
    closed_at: string | null;
    reconciliation: {
      started_at: string;
      counted_at: string | null;
      counts: ReconciliationCount[];
    } | null;
    location_name: string | null;
  } | null;
  currency_summary: CurrencySummary[];
  cash_sales_total?: number;
  expected_balance?: number;
  cash_refunds_total: number;
  cash_refunds_count: number;
  drawer_currency?: string | null;
  drawer_secondary_currency?: string | null;
  shift_currency?: string | null;
};

type Location = { id: number; name: string; currency: string; secondary_currency: string | null };

type Props = {
  locationId: number | null;
  locationName: string | null;
  shiftId: number | null;
  shiftOpenedAt: string | null;
  openingCash: number;
  shiftCurrency: string | null;
  isShiftActive: boolean;
  /** True when the active shift has run past its expected closing time */
  isOverdue?: boolean;
  /** True when the active shift's linked cash session was already finalized. */
  isSessionFinalized?: boolean;
  /** IANA timezone of the active location, used for the overdue age line */
  locationTimezone?: string;
  /**
   * Incrementing this value from a parent (e.g. "Resolve now" in the health
   * strip) programmatically opens the close-shift form inside this component.
   */
  resolveOverdueTrigger?: number;
  cashSalesTotal: number;
  cashRefundsTotal: number;
  /** True when a previous session is awaiting manager approval */
  previousSessionPending?: boolean;
  /** Pending resolution data for manager approve/reject flow */
  pendingResolution?: PendingResolution | null;
  /** Location's scheduled closing time in "HH:MM" format, shown in resolve modal */
  locationCutoffTime?: string | null;
};

// ── Helpers ────────────────────────────────────────────────────────────────

function fmtCurrency(amount: number, currency: string): string {
  if (currency === "LBP") return formatLbp(amount);
  if (currency === "USD") return formatUsd(amount);
  const value = Number(amount);
  return `${Number.isFinite(value) ? value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "0.00"} ${currency}`;
}

function formatWithAuthoritativeCurrency(amount: number, currency: string | null | undefined): string {
  return currency ? fmtCurrency(amount, currency) : "Currency unavailable";
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Format an "Opened [day] at [time] · [duration]" age string for an overdue shift.
 * e.g. "Opened yesterday at 11:20 AM · 19h 27m"
 */
function formatShiftAge(openedAt: string, timezone: string): string {
  try {
    const now = new Date();
    const opened = new Date(openedAt);
    const diffMs = Math.max(0, now.getTime() - opened.getTime());
    const totalMins = Math.floor(diffMs / 60_000);
    const h = Math.floor(totalMins / 60);
    const m = totalMins % 60;
    const duration = h > 0 ? `${h}h ${m}m` : `${m}m`;

    const timeStr = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(opened);

    // Compare calendar dates in the target timezone using ISO-style "en-CA" locale.
    const toLocalDate = (d: Date) =>
      new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(d);
    const nowDate = toLocalDate(now);
    const openedDate = toLocalDate(opened);

    let dayLabel: string;
    if (openedDate === nowDate) {
      dayLabel = "today";
    } else {
      const yesterday = new Date(now.getTime() - 86_400_000);
      dayLabel = toLocalDate(yesterday) === openedDate ? "yesterday" : openedDate;
    }

    return `Opened ${dayLabel} at ${timeStr} · ${duration}`;
  } catch {
    return `Opened at ${new Date(openedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  }
}

function sessionStatusLabel(
  status: string,
  isOverdue?: boolean,
): { label: string; classes: string } {
  if (status === "open") {
    if (isOverdue) return { label: "Session Overdue", classes: "bg-red-100 text-red-700" };
    return { label: "Session Open", classes: "bg-emerald-100 text-emerald-800" };
  }
  if (status === "pending_review") return { label: "Pending Review", classes: "bg-amber-100 text-amber-800" };
  if (status === "flagged") return { label: "Flagged", classes: "bg-red-100 text-red-700" };
  if (status === "approved") return { label: "Approved", classes: "bg-blue-100 text-blue-800" };
  return { label: status, classes: "bg-gray-100 text-gray-600" };
}

/** Amber warning panel shown inside the drawer card when the shift is overdue. */
function OverdueWarningPanel({ sessionFinalized }: { sessionFinalized: boolean }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
      <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
      <div>
        <p className="text-sm font-semibold text-amber-800">
          {sessionFinalized ? "Cash session already finalized" : "Cash session not closed"}
        </p>
        <p className="text-xs text-amber-700 mt-0.5">
          {sessionFinalized
            ? "The shift still needs closure; its recorded reconciliation will not be changed."
            : "This cash session must be reconciled before continuing."}
        </p>
      </div>
    </div>
  );
}

// Derive expected balance from primary currency in summary (avoids cross-currency addition)
function deriveExpectedBalance(
  currencySummary: CurrencySummary[],
  sessionCurrency: string,
  apiExpectedBalance: number | undefined,
): number {
  // Prefer the server-computed value when present
  if (apiExpectedBalance !== undefined && apiExpectedBalance > 0) return apiExpectedBalance;
  // Fallback: use primary-currency summary entry
  const primary = currencySummary.find((cs) => cs.currency === sessionCurrency) ?? currencySummary[0];
  return primary?.expected_cash ?? 0;
}

// ── Sub-components ─────────────────────────────────────────────────────────

function InfoRow({ label, value, bold, highlight }: {
  label: string; value: string; bold?: boolean; highlight?: "warning" | "ok";
}) {
  const textClass = highlight === "warning"
    ? "text-amber-700 font-semibold"
    : highlight === "ok" ? "text-emerald-700"
    : bold ? "font-bold text-gray-900"
    : "text-gray-700";
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 border-b border-gray-100 last:border-0">
      <span className="text-xs text-gray-500">{label}</span>
      <span className={`text-sm tabular-nums ${textClass}`}>{value}</span>
    </div>
  );
}


// ── Start Shift Form ────────────────────────────────────────────────────────
// Imported from shared component; re-exported here for backward compatibility.
export { StartShiftForm } from "./StartShiftForm";

// ── End Shift Form ──────────────────────────────────────────────────────────

function EndShiftForm({
  locationId,
  expectedBalance,
  cashSalesTotal,
  openingCash,
  currency,
  secondaryCurrency,
  openingCashSecondary,
  expectedBalanceSecondary,
  sessionAlreadyFinalized,
  onSuccess,
  onCancel,
}: {
  locationId: number;
  expectedBalance: number;
  cashSalesTotal: number;
  openingCash: number;
  currency: string | null;
  secondaryCurrency?: string | null;
  openingCashSecondary?: number;
  expectedBalanceSecondary?: number;
  sessionAlreadyFinalized: boolean;
  onSuccess: () => void;
  onCancel: () => void;
}) {
  const isDualCurrency = !!(secondaryCurrency) && !sessionAlreadyFinalized;
  const [cashKept, setCashKept] = useState(expectedBalance.toFixed(2));
  const [cashKeptSecondary, setCashKeptSecondary] = useState(
    isDualCurrency && expectedBalanceSecondary != null ? expectedBalanceSecondary.toFixed(2) : "0",
  );
  const [cashTransferred, setCashTransferred] = useState("0");
  const [whishTransferred, setWhishTransferred] = useState("0");
  const [destLocationId, setDestLocationId] = useState("");
  const [discrepancyNote, setDiscrepancyNote] = useState("");
  const [confirmed, setConfirmed] = useState(false);

  const kept = parseFloat(cashKept) || 0;
  const keptSecondary = isDualCurrency ? (parseFloat(cashKeptSecondary) || 0) : 0;
  const transferred = parseFloat(cashTransferred) || 0;
  const whish = parseFloat(whishTransferred) || 0;
  const totalOut = kept + transferred + whish;
  const discrepancy = Math.round((totalOut - expectedBalance) * 100) / 100;
  const hasDiscrepancy = Math.abs(discrepancy) > 0.009;
  const discrepancySecondary = isDualCurrency && expectedBalanceSecondary != null
    ? Math.round((keptSecondary - expectedBalanceSecondary) * 100) / 100
    : 0;
  const hasDiscrepancySecondary = isDualCurrency && Math.abs(discrepancySecondary) > 0.009;
  const hasAnyDiscrepancy = hasDiscrepancy || hasDiscrepancySecondary;
  const showTransfer = transferred > 0;

  const { data: locData } = useQuery<{ locations: Location[] }>({
    queryKey: ["locations"],
    queryFn: () => apiFetch("/api/locations"),
    staleTime: 60_000,
  });
  const locations = (locData?.locations ?? []).filter((l) => l.id !== locationId);

  const qc = useQueryClient();
  const closeShift = useMutation({
    mutationFn: () =>
      apiFetch<{ drawerless?: boolean; message?: string }>("/api/cmc-pos/shifts/close", {
        method: "POST",
        body: JSON.stringify({
          cash_kept: kept,
          cash_transferred: transferred,
          whish_transferred: whish,
          destination_location_id: destLocationId ? Number(destLocationId) : null,
          discrepancy_note: discrepancyNote.trim() || null,
          location_id: locationId || undefined,
          ...(isDualCurrency ? { cash_kept_secondary: keptSecondary } : {}),
        }),
      }),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["cmc-pos-active-shift"] });
      qc.invalidateQueries({ queryKey: ["cmc-pos-cash-drawer"] });
      qc.invalidateQueries({ queryKey: ["cmc-pos-cash-drawer-transactions"] });
      qc.invalidateQueries({ queryKey: ["cmc-pos-metrics"] });
      qc.invalidateQueries({ queryKey: ["cmc-pos-shifts"] });
      toast({
        title: "Shift closed successfully",
        ...(data?.drawerless
          ? { description: "No cash session was linked, so cash reconciliation was skipped." }
          : {}),
      });
      onSuccess();
    },
    onError: (err: Error) => {
      const msg = err.message || "Failed to close shift";
      toast({ title: msg, variant: "destructive" });
    },
  });

  const valid =
    cashKept !== "" &&
    kept >= 0 &&
    (!isDualCurrency || (cashKeptSecondary !== "" && keptSecondary >= 0)) &&
    (!showTransfer || !!destLocationId) &&
    (sessionAlreadyFinalized || !hasAnyDiscrepancy || discrepancyNote.trim().length > 0) &&
    confirmed;

  return (
    <div className="px-5 py-4 space-y-4 border-t border-gray-100 bg-gray-50">
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">
        {sessionAlreadyFinalized ? "Close Shift — Recovery" : "End Shift — Reconciliation"}
      </p>

      {sessionAlreadyFinalized && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          The linked cash session was already finalized, but the CMC shift is still open.
          Closing this shift repairs that mismatch while keeping the recorded reconciliation unchanged.
        </div>
      )}

      {/* Read-only summary */}
      <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 space-y-0">
        <InfoRow label="Opening Float" value={formatWithAuthoritativeCurrency(openingCash, currency)} />
        <InfoRow label="Cash Sales" value={formatWithAuthoritativeCurrency(cashSalesTotal, currency)} bold />
        <InfoRow label="Expected Balance" value={formatWithAuthoritativeCurrency(expectedBalance, currency)} bold />
      </div>

      {!sessionAlreadyFinalized && <div className="space-y-1.5">
        <Label className="text-xs">Cash Kept at This Location ({currency ?? "Currency unavailable"})</Label>
        <Input
          type="number"
          min="0"
          step="0.01"
          className="h-9 text-sm"
          placeholder="0.00"
          value={cashKept}
          onChange={(e) => setCashKept(e.target.value)}
        />
      </div>}

      {!sessionAlreadyFinalized && <div className="space-y-1.5">
        <Label className="text-xs">Cash Sent to Another Location ({currency ?? "Currency unavailable"})</Label>
        <Input
          type="number"
          min="0"
          step="0.01"
          className="h-9 text-sm"
          placeholder="0.00"
          value={cashTransferred}
          onChange={(e) => setCashTransferred(e.target.value)}
        />
      </div>}

      {!sessionAlreadyFinalized && <div className="space-y-1.5">
        <Label className="text-xs">Amount Transferred to Whish ({currency ?? "Currency unavailable"})</Label>
        <Input
          type="number"
          min="0"
          step="0.01"
          className="h-9 text-sm"
          placeholder="0.00"
          value={whishTransferred}
          onChange={(e) => setWhishTransferred(e.target.value)}
        />
      </div>}

      {!sessionAlreadyFinalized && showTransfer && (
        <div className="space-y-1.5">
          <Label className="text-xs">Destination Location <span className="text-red-500">*</span></Label>
          <Select value={destLocationId} onValueChange={setDestLocationId}>
            <SelectTrigger className="h-9 text-sm">
              <SelectValue placeholder="Select destination…" />
            </SelectTrigger>
            <SelectContent>
              {locations.map((l) => (
                <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Live discrepancy */}
      {!sessionAlreadyFinalized && <div className={`rounded-lg px-4 py-3 border ${
        hasDiscrepancy
          ? "bg-amber-50 border-amber-200"
          : Math.abs(totalOut - expectedBalance) < 0.005
          ? "bg-emerald-50 border-emerald-200"
          : "bg-gray-50 border-gray-200"
      }`}>
        <div className="flex items-center justify-between">
          <span className="text-xs text-gray-500">Total Out (kept + sent)</span>
            <span className="text-sm font-semibold tabular-nums">{formatWithAuthoritativeCurrency(totalOut, currency)}</span>
        </div>
        <div className="flex items-center justify-between mt-1">
          <span className="text-xs font-medium">
            {hasDiscrepancy ? (
              <span className="text-amber-700 flex items-center gap-1">
                <AlertTriangle className="h-3 w-3" />
                Discrepancy
              </span>
            ) : (
              <span className="text-emerald-700 flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3" />
                Balanced
              </span>
            )}
          </span>
          <span className={`text-sm font-bold tabular-nums ${hasDiscrepancy ? "text-amber-700" : "text-emerald-700"}`}>
            {discrepancy > 0 ? "+" : ""}{formatWithAuthoritativeCurrency(discrepancy, currency)}
          </span>
        </div>
      </div>}

      {/* Secondary-currency reconciliation section */}
      {isDualCurrency && secondaryCurrency && (
        <>
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide pt-1">
            {secondaryCurrency} — Cash Count
          </p>
          <div className="rounded-lg border border-gray-200 bg-white px-4 py-3 space-y-0">
            {openingCashSecondary !== undefined && (
              <InfoRow label="Opening Float" value={fmtCurrency(openingCashSecondary, secondaryCurrency)} />
            )}
            {expectedBalanceSecondary !== undefined && (
              <InfoRow label="Expected Balance" value={fmtCurrency(expectedBalanceSecondary, secondaryCurrency)} bold />
            )}
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">Cash Kept at This Location ({secondaryCurrency})</Label>
            <Input
              type="number"
              min="0"
              step="0.01"
              className="h-9 text-sm"
              placeholder="0.00"
              value={cashKeptSecondary}
              onChange={(e) => setCashKeptSecondary(e.target.value)}
            />
          </div>
          <div className={`rounded-lg px-4 py-3 border ${
            hasDiscrepancySecondary
              ? "bg-amber-50 border-amber-200"
              : Math.abs(discrepancySecondary) < 0.005
              ? "bg-emerald-50 border-emerald-200"
              : "bg-gray-50 border-gray-200"
          }`}>
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">
                {hasDiscrepancySecondary ? (
                  <span className="text-amber-700 flex items-center gap-1">
                    <AlertTriangle className="h-3 w-3" />
                    Discrepancy ({secondaryCurrency})
                  </span>
                ) : (
                  <span className="text-emerald-700 flex items-center gap-1">
                    <CheckCircle2 className="h-3 w-3" />
                    {secondaryCurrency} Balanced
                  </span>
                )}
              </span>
              <span className={`text-sm font-bold tabular-nums ${hasDiscrepancySecondary ? "text-amber-700" : "text-emerald-700"}`}>
                {discrepancySecondary > 0 ? "+" : ""}{fmtCurrency(discrepancySecondary, secondaryCurrency)}
              </span>
            </div>
          </div>
        </>
      )}

      {!sessionAlreadyFinalized && hasAnyDiscrepancy && (
        <div className="space-y-1.5">
          <Label className="text-xs">Discrepancy Note <span className="text-red-500">*</span></Label>
          <Textarea
            rows={2}
            className="text-sm resize-none"
            placeholder="Explain the discrepancy…"
            value={discrepancyNote}
            onChange={(e) => setDiscrepancyNote(e.target.value)}
          />
        </div>
      )}

      {/* Confirmation */}
      <label className="flex items-start gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          className="mt-0.5"
        />
        <span className="text-xs text-gray-600">
          {sessionAlreadyFinalized
            ? "I confirm the finalized cash session should remain unchanged and this shift can be closed."
            : "I confirm this is the final cash count and the shift can be closed."}
        </span>
      </label>

      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          className="flex-1"
          onClick={onCancel}
          disabled={closeShift.isPending}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          className="flex-1 bg-gray-900 hover:bg-gray-800 text-white"
          disabled={!valid || closeShift.isPending}
          onClick={() => closeShift.mutate()}
        >
          {closeShift.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1" />}
          Close Shift
        </Button>
      </div>
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────

export default function CmcPosCashDrawer({
  locationId,
  locationName,
  shiftId,
  shiftOpenedAt,
  openingCash,
  shiftCurrency,
  isShiftActive,
  isOverdue = false,
  isSessionFinalized = false,
  locationTimezone = "UTC",
  resolveOverdueTrigger,
  cashSalesTotal,
  cashRefundsTotal,
  previousSessionPending = false,
  pendingResolution,
  locationCutoffTime,
}: Props) {
  const { isOwner, allowedPages } = useWorkspaceRole();
  const can = (perm: string) => isOwner || (allowedPages?.includes(perm) ?? false);
  const canViewActivity = can("cash_sessions.adjust") || can("cash_sessions.close") || isOwner;
  const canApprove = isOwner || can("cash_sessions.approve");

  const [showStartForm, setShowStartForm] = useState(false);
  const [showEndForm, setShowEndForm] = useState(false);
  const [resolveModalOpen, setResolveModalOpen] = useState(false);
  const [approveModalOpen, setApproveModalOpen] = useState(false);
  const [closedSummary, setClosedSummary] = useState<{
    expectedBalance: number;
    cashSalesTotal: number;
    currency: string | null;
    pendingApproval?: boolean;
  } | null>(null);

  // Reset forms when shift state changes
  useEffect(() => {
    if (isShiftActive) { setShowStartForm(false); setClosedSummary(null); }
    else { setShowEndForm(false); setResolveModalOpen(false); }
  }, [isShiftActive]);

  // When the parent signals from the overdue health strip, route finalized
  // sessions to shift-only recovery and genuinely open sessions to reconciliation.
  useEffect(() => {
    if (resolveOverdueTrigger && resolveOverdueTrigger > 0 && isShiftActive && isOverdue) {
      if (isSessionFinalized) {
        setShowEndForm(true);
      } else {
        setResolveModalOpen(true);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolveOverdueTrigger]);

  const { data, isLoading, isError, refetch } = useQuery<CmcCashDrawerResponse>({
    queryKey: ["cmc-pos-cash-drawer", locationId],
    queryFn: () =>
      apiFetch<CmcCashDrawerResponse>(
        `/api/cmc-pos/cash-drawer${locationId ? `?location_id=${locationId}` : ""}`,
        {},
      ),
    enabled: isShiftActive && locationId !== null,
    staleTime: 30_000,
    retry: false,
    // Always refetch when the component remounts or the shift state flips —
    // prevents a stale errored result from leaving "Cash session status
    // unavailable" stuck after open/close state changes.
    refetchOnMount: "always",
  });

  const session = data?.session ?? null;
  const sessionAlreadyFinalized =
    isSessionFinalized || (session !== null && session.status !== "open");
  const currencySummary = data?.currency_summary ?? [];
  const liveCashSalesTotal = data?.cash_sales_total ?? cashSalesTotal;
  const authoritativeCurrency =
    session?.currency ?? data?.drawer_currency ?? data?.shift_currency ?? shiftCurrency;

  // Use primary-currency expected_cash to avoid cross-currency summing
  const liveExpectedBalance = session
    ? deriveExpectedBalance(currencySummary, session.currency, data?.expected_balance)
    : 0;
  const secondaryCurrency = session?.secondary_currency ?? null;
  const secondarySummary = secondaryCurrency
    ? currencySummary.find((cs) => cs.currency === secondaryCurrency)
    : undefined;

  const rec = session?.reconciliation ?? null;
  const hasCashVariance = rec !== null &&
    Array.isArray(rec.counts) &&
    rec.counts.some((c) => Math.abs(c.variance ?? 0) > 0);

  const statusInfo = session ? sessionStatusLabel(session.status, isOverdue) : null;

  return (
    <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 border-b border-gray-100 bg-gray-50">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <DollarSign className="h-4 w-4" style={{ color: "#00414e" }} />
            <h2 className="text-sm font-semibold text-gray-900">Current Cash Drawer</h2>
          </div>
          <div className="flex items-center gap-1.5">
            <span
              data-testid="badge-store-status"
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
                isShiftActive
                  ? "bg-emerald-100 text-emerald-800"
                  : "bg-gray-200 text-gray-600"
              }`}
            >
              {isShiftActive ? "Store Open" : "Store Closed"}
            </span>
            <span
              data-testid="badge-shift-status"
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
                isShiftActive && isOverdue
                  ? "bg-red-100 text-red-700"
                  : isShiftActive
                  ? "bg-teal-100 text-teal-800"
                  : "bg-gray-100 text-gray-500"
              }`}
            >
              {isShiftActive ? (
                isOverdue ? (
                  <>
                    <Clock className="h-3 w-3" />
                    Shift Overdue
                  </>
                ) : (
                  <>
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    Shift Active
                  </>
                )
              ) : (
                "No Shift"
              )}
            </span>
          </div>
        </div>
        {shiftOpenedAt && (
          <p className="mt-1 text-xs text-gray-500">
            {isOverdue
              ? formatShiftAge(shiftOpenedAt, locationTimezone)
              : `Opened at ${formatTime(shiftOpenedAt)}${locationName ? ` · ${locationName}` : ""}`}
          </p>
        )}
      </div>

      {/* Body */}
      <div className="px-5 py-4 space-y-4">
        {/* ── No active shift ── */}
        {!isShiftActive && !showStartForm && (
          <div className="py-4 text-center space-y-3">
            {closedSummary ? (
              /* Post-close / post-resolve summary */
              <>
                {closedSummary.pendingApproval ? (
                  <AlertTriangle className="mx-auto h-8 w-8 text-amber-500" />
                ) : (
                  <CheckCircle2 className="mx-auto h-8 w-8 text-emerald-500" />
                )}
                <p className="text-sm font-medium text-gray-700">
                  {closedSummary.pendingApproval
                    ? "Resolution submitted — awaiting approval"
                    : "Shift closed successfully"}
                </p>
                {closedSummary.pendingApproval && (
                  <p className="text-xs text-amber-700">
                    A manager will review and finalise this session.
                  </p>
                )}
                <div className="rounded-lg border border-gray-100 bg-gray-50 px-4 py-3 text-left space-y-0">
                  <InfoRow label="Cash Sales Total" value={formatWithAuthoritativeCurrency(closedSummary.cashSalesTotal, closedSummary.currency)} />
                  <InfoRow label="Expected Balance" value={formatWithAuthoritativeCurrency(closedSummary.expectedBalance, closedSummary.currency)} />
                </div>
              </>
            ) : (
              <>
                <Lock className="mx-auto h-8 w-8 text-gray-300" />
                <p className="text-sm font-medium text-gray-500">No active shift</p>
                <p className="text-xs text-gray-400">Start a shift to enable cash tracking</p>
              </>
            )}
          </div>
        )}

        {/* ── Active shift: loading ── */}
        {isShiftActive && isLoading && !showEndForm && (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-5 w-full" />
            ))}
          </div>
        )}

        {/* ── Active shift: session data ── */}
        {isShiftActive && !isLoading && !showEndForm && (
          <>
            {/* Shift key stats */}
            <div className="rounded-lg px-4 py-3 border" style={{ background: "rgba(0,65,78,0.05)", border: "1px solid rgba(0,65,78,0.15)" }}>
              <p className="text-xs font-medium mb-1" style={{ color: "#00414e" }}>Expected Drawer Balance</p>
              <p className="text-2xl font-bold tabular-nums" style={{ color: "#00414e" }}>
                {formatWithAuthoritativeCurrency(liveExpectedBalance, authoritativeCurrency)}
              </p>
            </div>

            <div>
              <InfoRow label="Opening Float" value={formatWithAuthoritativeCurrency(openingCash, authoritativeCurrency)} />
              <InfoRow label="Cash Sales" value={formatWithAuthoritativeCurrency(liveCashSalesTotal, authoritativeCurrency)} bold />
              {cashRefundsTotal > 0 && (
                <InfoRow label="Cash Refunds" value={`−${formatWithAuthoritativeCurrency(cashRefundsTotal, authoritativeCurrency)}`} highlight="warning" />
              )}
              {currencySummary.map((cs) =>
                cs.expenses_paid > 0 ? (
                  <InfoRow key={`exp-${cs.currency}`}
                    label={`Expenses (${cs.currency})`}
                    value={`−${fmtCurrency(cs.expenses_paid, cs.currency)}`}
                    highlight="warning"
                  />
                ) : null,
              )}
            </div>

            {/* Overdue warning panel */}
            {isOverdue && <OverdueWarningPanel sessionFinalized={sessionAlreadyFinalized} />}

            {/* Cash variance alert from reconciliation counts */}
            {hasCashVariance && (
              <div className="flex items-center gap-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2">
                <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0" />
                <span className="text-xs font-medium text-amber-800">Cash variance detected</span>
              </div>
            )}

            {/* Session status */}
            {session && statusInfo && (
              <div className="flex items-center justify-between">
                <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${statusInfo.classes}`}>
                  {statusInfo.label}
                </span>
                {session.status === "flagged" && (
                  <span className="text-xs text-red-600 flex items-center gap-1">
                    <AlertTriangle className="h-3 w-3" />
                    Supervisor review needed
                  </span>
                )}
              </div>
            )}

            {!session && !showStartForm && (
              <div className="py-2 text-center">
                {isError ? (
                  // Safety-net: if the endpoint unexpectedly returns 403, show a
                  // neutral status rather than "No open cash session" + open button.
                  <>
                    <p className="text-xs text-gray-500 flex items-center justify-center gap-1">
                      <AlertTriangle className="h-3 w-3" />
                      Cash session status unavailable
                    </p>
                    <button
                      data-testid="btn-retry-cash-drawer-status"
                      className="mt-2 inline-flex h-7 items-center rounded-lg border border-gray-200 px-3 text-xs font-medium text-gray-600 hover:bg-gray-50"
                      onClick={() => refetch()}
                    >
                      Retry
                    </button>
                  </>
                ) : (
                  <>
                    <p className="text-xs text-amber-700 flex items-center justify-center gap-1">
                      <AlertTriangle className="h-3 w-3" />
                      No linked cash session
                    </p>
                    <p className="mt-1 text-xs text-gray-500">
                      Start Shift is the only CMC workflow that opens a cash session.
                    </p>
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Start shift form ── */}
      {showStartForm && (
        <StartShiftForm
          onSuccess={() => setShowStartForm(false)}
          onCancel={() => setShowStartForm(false)}
        />
      )}

      {/* ── Standard end shift form (non-overdue shifts) ── */}
      {isShiftActive && showEndForm && shiftId && (!isOverdue || sessionAlreadyFinalized) && (
        <EndShiftForm
          locationId={locationId ?? 0}
          expectedBalance={liveExpectedBalance}
          cashSalesTotal={liveCashSalesTotal}
          openingCash={openingCash}
          currency={authoritativeCurrency}
          secondaryCurrency={session?.secondary_currency}
          sessionAlreadyFinalized={session?.status !== "open"}
          openingCashSecondary={
            session?.secondary_currency
              ? (currencySummary.find((cs) => cs.currency === session.secondary_currency)?.opening_cash)
              : undefined
          }
          expectedBalanceSecondary={
            session?.secondary_currency
              ? (currencySummary.find((cs) => cs.currency === session.secondary_currency)?.expected_cash)
              : undefined
          }
          onSuccess={() => {
            setClosedSummary({
              expectedBalance: liveExpectedBalance,
              cashSalesTotal: liveCashSalesTotal,
              currency: authoritativeCurrency,
              pendingApproval: false,
            });
            setShowEndForm(false);
          }}
          onCancel={() => setShowEndForm(false)}
        />
      )}

      {/* ── Action buttons ── */}
      {!showStartForm && !showEndForm && (
        <div className="px-5 pb-5 space-y-2">
          {/* No shift → start */}
          {!isShiftActive && (
            <Button
              size="sm"
              data-testid="btn-start-shift"
              className="flex h-9 w-full items-center justify-center gap-2 rounded-lg text-xs font-medium text-white"
              style={{ background: "#00414e" }}
              onClick={() => setShowStartForm(true)}
            >
              <PlayCircle className="h-3.5 w-3.5" />
              Start Shift
            </Button>
          )}

          {/* Active shift → actions */}
          {isShiftActive && session && (
            <>
              {canViewActivity && (
                <Link href={`/cash-sessions/${session.id}`} asChild>
                  <a
                    data-testid="btn-view-cash-activity"
                    className="flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-gray-200 text-xs font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                  >
                    <Eye className="h-3.5 w-3.5" />
                    View Cash Activity
                  </a>
                </Link>
              )}
              {isOverdue && !sessionAlreadyFinalized ? (
                <Button
                  size="sm"
                  data-testid="btn-resolve-close-shift"
                  className="flex h-9 w-full items-center justify-center gap-2 rounded-lg text-xs font-semibold text-white transition-colors"
                  style={{ background: "#00414e" }}
                  onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "#002d36")}
                  onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "#00414e")}
                  onClick={() => setResolveModalOpen(true)}
                >
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Resolve &amp; Close Shift
                </Button>
              ) : (
                <Button
                  size="sm"
                  data-testid="btn-end-shift"
                  className="flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-gray-900 text-xs font-medium text-white hover:bg-gray-800 transition-colors"
                  onClick={() => setShowEndForm(true)}
                >
                  <XCircle className="h-3.5 w-3.5" />
                  {sessionAlreadyFinalized ? "Close Shift" : "End Shift"}
                </Button>
              )}
            </>
          )}
          {isShiftActive && !session && !isLoading && !isError && (
            <>
              <p className="text-center text-xs text-gray-400">
                Open a cash session to enable drawer actions
              </p>
              {/* Drawer-less shifts can still be ended — the close skips cash
                  reconciliation server-side. */}
              {isOverdue ? (
                <Button
                  size="sm"
                  data-testid="btn-resolve-close-shift-no-session"
                  className="flex h-9 w-full items-center justify-center gap-2 rounded-lg text-xs font-semibold text-white transition-colors"
                  style={{ background: "#00414e" }}
                  onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "#002d36")}
                  onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "#00414e")}
                  onClick={() => setResolveModalOpen(true)}
                >
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Resolve &amp; Close Shift
                </Button>
              ) : (
                <Button
                  size="sm"
                  data-testid="btn-end-shift-no-session"
                  className="flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-gray-900 text-xs font-medium text-white hover:bg-gray-800 transition-colors"
                  onClick={() => setShowEndForm(true)}
                >
                  <XCircle className="h-3.5 w-3.5" />
                  End Shift
                </Button>
              )}
            </>
          )}

          {/* ── Manager: approve a pending resolution from a previous session ── */}
          {previousSessionPending && pendingResolution && canApprove && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 space-y-2">
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0" />
                <p className="text-xs font-semibold text-amber-800">Previous session pending approval</p>
              </div>
              <p className="text-xs text-amber-700">
                A team member submitted a resolution for an overdue session. Review it before starting new sales.
              </p>
              <Button
                size="sm"
                data-testid="btn-approve-resolution"
                className="flex h-8 w-full items-center justify-center gap-1.5 rounded-lg text-xs font-medium text-white"
                style={{ background: "#00414e" }}
                onMouseEnter={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "#002d36")}
                onMouseLeave={(e) => ((e.currentTarget as HTMLButtonElement).style.background = "#00414e")}
                onClick={() => setApproveModalOpen(true)}
              >
                <ShieldCheck className="h-3.5 w-3.5" />
                Approve Resolution
              </Button>
            </div>
          )}
        </div>
      )}

      {/* ── Resolve Shift Modal (overdue) ── */}
      {shiftId && shiftOpenedAt && (
        <ResolveShiftModal
          open={resolveModalOpen}
          onOpenChange={setResolveModalOpen}
          shiftId={shiftId}
          shiftOpenedAt={shiftOpenedAt}
          locationTimezone={locationTimezone}
          locationName={locationName}
          openingCash={openingCash}
          cashSalesTotal={liveCashSalesTotal}
          cashMovements={
            currencySummary.find((cs) => cs.currency === (authoritativeCurrency ?? ""))?.expenses_paid ?? 0
          }
          expectedBalance={liveExpectedBalance}
          currency={authoritativeCurrency}
          secondaryCurrency={secondaryCurrency}
          openingCashSecondary={secondarySummary?.opening_cash}
          expectedBalanceSecondary={secondarySummary?.expected_cash}
          locationCutoffTime={locationCutoffTime}
          onClose={() => {
            setClosedSummary({
              expectedBalance: liveExpectedBalance,
              cashSalesTotal: liveCashSalesTotal,
              currency: authoritativeCurrency,
              pendingApproval: false,
            });
          }}
        />
      )}

      {/* ── Approve Resolution Modal (manager) ── */}
      {pendingResolution && (
        <ApproveResolutionModal
          open={approveModalOpen}
          onOpenChange={setApproveModalOpen}
          resolution={pendingResolution}
          onDone={() => setApproveModalOpen(false)}
        />
      )}

    </div>
  );
}
