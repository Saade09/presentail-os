import { useState, useEffect, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
} from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";
import { toast } from "@/hooks/use-toast";
import { formatUsd, formatLbp } from "./cmcPosDashboard.helpers";

// ── Types ──────────────────────────────────────────────────────────────────────

export type ResolveShiftModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shiftId: number;
  shiftOpenedAt: string;
  locationTimezone: string;
  locationName: string | null;
  openingCash: number;
  cashSalesTotal: number;
  /** Total cash movements (expenses, adjustments) in the primary currency */
  cashMovements: number;
  expectedBalance: number;
  currency: string | null;
  secondaryCurrency?: string | null;
  openingCashSecondary?: number;
  expectedBalanceSecondary?: number;
  /** "HH:MM" cutoff time configured for the location */
  locationCutoffTime?: string | null;
  onClose: () => void;
};

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtCurrency(amount: number, currency: string): string {
  if (currency === "LBP") return formatLbp(amount);
  if (currency === "USD") return formatUsd(amount);
  const value = Number(amount);
  return `${
    Number.isFinite(value)
      ? value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
      : "0.00"
  } ${currency}`;
}

function fmt(amount: number, currency: string | null): string {
  return currency ? fmtCurrency(amount, currency) : "—";
}

function formatInTimezone(iso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleString();
  }
}

function formatDuration(openedAt: string): string {
  const diffMs = Math.max(0, Date.now() - new Date(openedAt).getTime());
  const totalMins = Math.floor(diffMs / 60_000);
  const h = Math.floor(totalMins / 60);
  const m = totalMins % 60;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatCutoffTime(cutoff: string, timezone: string): string {
  // cutoff is "HH:MM" (24h). Render it as a local-timezone time label.
  try {
    const [hh, mm] = cutoff.split(":").map(Number);
    const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date());
    const candidate = new Date(`${localDate}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00`);
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(candidate);
  } catch {
    return cutoff;
  }
}

// ── Constants ──────────────────────────────────────────────────────────────────

const REASON_OPTIONS: { value: string; label: string }[] = [
  { value: "forgot_to_close", label: "Forgot to close shift" },
  { value: "employee_unavailable", label: "Employee unavailable" },
  { value: "technical_issue", label: "Technical issue" },
  { value: "store_closed_unexpectedly", label: "Store closed unexpectedly" },
  { value: "other", label: "Other" },
];

// ── Sub-components ─────────────────────────────────────────────────────────────

function SummaryRow({
  label,
  value,
  highlight,
  bold,
}: {
  label: string;
  value: string;
  highlight?: "warning" | "ok";
  bold?: boolean;
}) {
  const textClass =
    highlight === "warning"
      ? "text-amber-700 font-semibold"
      : highlight === "ok"
      ? "text-emerald-700 font-semibold"
      : bold
      ? "font-bold text-gray-900"
      : "text-gray-700";
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 border-b border-gray-100 last:border-0">
      <span className="text-xs text-gray-500 shrink-0">{label}</span>
      <span className={`text-xs tabular-nums text-right break-words max-w-[60%] ${textClass}`}>
        {value}
      </span>
    </div>
  );
}

// ── Main modal component ───────────────────────────────────────────────────────

export default function ResolveShiftModal({
  open,
  onOpenChange,
  shiftId,
  shiftOpenedAt,
  locationTimezone,
  locationName,
  openingCash,
  cashSalesTotal,
  cashMovements,
  expectedBalance,
  currency,
  secondaryCurrency,
  openingCashSecondary,
  expectedBalanceSecondary,
  locationCutoffTime,
  onClose,
}: ResolveShiftModalProps) {
  // Form state
  const [countedBalance, setCountedBalance] = useState(expectedBalance.toFixed(2));
  const [countedBalanceSecondary, setCountedBalanceSecondary] = useState(
    expectedBalanceSecondary?.toFixed(2) ?? "",
  );
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");

  // Track whether the user has manually edited the counted balance this session.
  // If not, we update it to match the latest expectedBalance when the modal opens
  // (expectedBalance can change between mount and open due to live drawer data loading).
  const userEditedBalance = useRef(false);

  // Reset all form state whenever the modal opens. Also refresh countedBalance from
  // the current expectedBalance unless the user has already started editing it.
  useEffect(() => {
    if (!open) return;
    // Modal just opened — reset transient state
    setReason("");
    setNote("");
    userEditedBalance.current = false;
    // Always seed the counted balance from the live expected balance on open
    setCountedBalance(expectedBalance.toFixed(2));
    setCountedBalanceSecondary(expectedBalanceSecondary?.toFixed(2) ?? "");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const counted = parseFloat(countedBalance) || 0;
  const difference = Math.round((counted - expectedBalance) * 100) / 100;
  const hasDiscrepancy = Math.abs(difference) > 0.009;
  const countedSecondary = parseFloat(countedBalanceSecondary) || 0;
  const differenceSecondary = secondaryCurrency && expectedBalanceSecondary !== undefined
    ? Math.round((countedSecondary - expectedBalanceSecondary) * 100) / 100
    : 0;
  const hasSecondaryDiscrepancy = Math.abs(differenceSecondary) > 0.009;

  const isFormValid =
    countedBalance !== "" &&
    counted >= 0 &&
    reason !== "" &&
    (!secondaryCurrency || (countedBalanceSecondary !== "" && countedSecondary >= 0));

  const qc = useQueryClient();

  const resolve = useMutation({
    mutationFn: () =>
      apiFetch<{ status: "closed" }>(
        "/api/cmc-pos/shifts/resolve",
        {
          method: "POST",
          body: JSON.stringify({
            shiftId,
            countedBalance: counted,
            ...(secondaryCurrency ? { countedBalanceSecondary: countedSecondary } : {}),
            currency: currency ?? "",
            reason,
            note: note.trim() || null,
          }),
        },
      ),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["cmc-pos-active-shift"] });
      qc.invalidateQueries({ queryKey: ["cmc-pos-cash-drawer"] });
      qc.invalidateQueries({ queryKey: ["cmc-pos-cash-drawer-transactions"] });
      qc.invalidateQueries({ queryKey: ["cmc-pos-metrics"] });
      qc.invalidateQueries({ queryKey: ["cmc-pos-shifts"] });
      toast({ title: "Shift resolved and closed successfully." });
      onClose();
      onOpenChange(false);
    },
    onError: (err: Error) => {
      // Error is shown inline via resolve.isError — no toast needed here
    },
  });

  function handleOpenChange(nextOpen: boolean) {
    // Prevent closing while submitting
    if (resolve.isPending) return;
    if (!nextOpen) {
      // Reset form when closing
      setCountedBalance(expectedBalance.toFixed(2));
      setCountedBalanceSecondary(expectedBalanceSecondary?.toFixed(2) ?? "");
      setReason("");
      setNote("");
      resolve.reset();
    }
    onOpenChange(nextOpen);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-md p-0 overflow-hidden flex flex-col"
        style={{ maxHeight: "90vh" }}
        aria-labelledby="resolve-modal-title"
      >
        <DialogHeader className="px-5 pt-5 pb-3 border-b border-gray-100 shrink-0">
          <DialogTitle id="resolve-modal-title">
            Resolve &amp; Close Shift
          </DialogTitle>
        </DialogHeader>

        <div className="overflow-y-auto flex-1 px-5 py-4 space-y-4">
          <>
              {/* Step 1 – Session summary */}
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                  Session Summary
                </p>
                <div className="rounded-lg border border-gray-200 bg-white px-4 py-3">
                  {locationName && <SummaryRow label="Location" value={locationName} />}
                  <SummaryRow
                    label="Opening time"
                    value={formatInTimezone(shiftOpenedAt, locationTimezone)}
                  />
                  {locationCutoffTime && (
                    <SummaryRow
                      label="Scheduled closing"
                      value={formatCutoffTime(locationCutoffTime, locationTimezone)}
                    />
                  )}
                  <SummaryRow label="Duration open" value={formatDuration(shiftOpenedAt)} />
                  <SummaryRow label="Opening float" value={fmt(openingCash, currency)} />
                  <SummaryRow label="Recorded cash sales" value={fmt(cashSalesTotal, currency)} />
                  {cashMovements > 0 && (
                    <SummaryRow
                      label="Cash movements"
                      value={`−${fmt(cashMovements, currency)}`}
                      highlight="warning"
                    />
                  )}
                  <SummaryRow
                    label="Expected drawer balance"
                    value={fmt(expectedBalance, currency)}
                    bold
                  />
                  {secondaryCurrency && (
                    <>
                      {openingCashSecondary !== undefined && (
                        <SummaryRow
                          label={`Opening float (${secondaryCurrency})`}
                          value={fmt(openingCashSecondary, secondaryCurrency)}
                        />
                      )}
                      {expectedBalanceSecondary !== undefined && (
                        <SummaryRow
                          label={`Expected drawer balance (${secondaryCurrency})`}
                          value={fmt(expectedBalanceSecondary, secondaryCurrency)}
                          bold
                        />
                      )}
                    </>
                  )}
                </div>
              </div>

              {/* Step 2 – Counted balance */}
              <div className="space-y-1.5">
                <Label htmlFor="counted-cash" className="text-xs">
                  Actual counted cash in drawer
                  {currency && ` (${currency})`}
                  <span className="text-red-500 ml-0.5">*</span>
                </Label>
                <Input
                  id="counted-cash"
                  type="number"
                  min="0"
                  step="0.01"
                  className="h-9 text-sm"
                  placeholder="0.00"
                  value={countedBalance}
                  onChange={(e) => {
                    userEditedBalance.current = true;
                    setCountedBalance(e.target.value);
                  }}
                />
              </div>

              {secondaryCurrency && (
                <>
                  <div className="space-y-1.5">
                    <Label htmlFor="counted-cash-secondary" className="text-xs">
                      Actual counted cash in drawer ({secondaryCurrency})
                      <span className="text-red-500 ml-0.5">*</span>
                    </Label>
                    <Input
                      id="counted-cash-secondary"
                      type="number"
                      min="0"
                      step="0.01"
                      className="h-9 text-sm"
                      placeholder="0.00"
                      value={countedBalanceSecondary}
                      onChange={(e) => setCountedBalanceSecondary(e.target.value)}
                    />
                  </div>
                  <div
                    className={`rounded-lg px-4 py-3 border ${
                      hasSecondaryDiscrepancy
                        ? "bg-amber-50 border-amber-200"
                        : "bg-emerald-50 border-emerald-200"
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium">
                        {hasSecondaryDiscrepancy ? (
                          <span className="text-amber-700 flex items-center gap-1">
                            <AlertTriangle className="h-3 w-3" />
                            {differenceSecondary > 0 ? "Surplus" : "Shortage"} ({secondaryCurrency})
                          </span>
                        ) : (
                          <span className="text-emerald-700 flex items-center gap-1">
                            <CheckCircle2 className="h-3 w-3" />
                            {secondaryCurrency} Balanced
                          </span>
                        )}
                      </span>
                      <span
                        className={`text-sm font-bold tabular-nums ${
                          hasSecondaryDiscrepancy ? "text-amber-700" : "text-emerald-700"
                        }`}
                      >
                        {differenceSecondary > 0 ? "+" : ""}
                        {fmt(differenceSecondary, secondaryCurrency)}
                      </span>
                    </div>
                  </div>
                </>
              )}

              {/* Step 3 – Live discrepancy */}
              <div
                className={`rounded-lg px-4 py-3 border ${
                  hasDiscrepancy
                    ? "bg-amber-50 border-amber-200"
                    : Math.abs(difference) < 0.005
                    ? "bg-emerald-50 border-emerald-200"
                    : "bg-gray-50 border-gray-200"
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium">
                    {hasDiscrepancy ? (
                      <span className="text-amber-700 flex items-center gap-1">
                        <AlertTriangle className="h-3 w-3" />
                        {difference > 0 ? "Surplus" : "Shortage"}
                      </span>
                    ) : (
                      <span className="text-emerald-700 flex items-center gap-1">
                        <CheckCircle2 className="h-3 w-3" />
                        Balanced
                      </span>
                    )}
                  </span>
                  <span
                    className={`text-sm font-bold tabular-nums ${
                      hasDiscrepancy ? "text-amber-700" : "text-emerald-700"
                    }`}
                  >
                    {difference > 0 ? "+" : ""}
                    {fmt(difference, currency)}
                  </span>
                </div>
              </div>

              {/* Step 4 – Reason */}
              <div className="space-y-2">
                <Label className="text-xs">
                  Reason for late closure
                  <span className="text-red-500 ml-0.5">*</span>
                </Label>
                <RadioGroup
                  value={reason}
                  onValueChange={setReason}
                  className="gap-2"
                  aria-label="Reason for late closure"
                >
                  {REASON_OPTIONS.map((r) => (
                    <div key={r.value} className="flex items-center gap-2.5">
                      <RadioGroupItem value={r.value} id={`reason-${r.value}`} />
                      <Label
                        htmlFor={`reason-${r.value}`}
                        className="text-sm font-normal cursor-pointer"
                      >
                        {r.label}
                      </Label>
                    </div>
                  ))}
                </RadioGroup>
              </div>

              {/* Step 5 – Optional note */}
              <div className="space-y-1.5">
                <Label htmlFor="resolve-note" className="text-xs">Note (optional)</Label>
                <Textarea
                  id="resolve-note"
                  rows={2}
                  className="text-sm resize-none"
                  placeholder="Add any extra context…"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </div>

              {/* Network error inline with retry */}
              {resolve.isError && (
                <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 flex items-center justify-between gap-3">
                  <p className="text-xs text-red-700">
                    {(resolve.error as Error)?.message || "Failed to resolve shift. Please try again."}
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0 text-xs h-7 border-red-300 text-red-700 hover:bg-red-50"
                    onClick={() => resolve.mutate()}
                  >
                    Retry
                  </Button>
                </div>
              )}

              {/* Actions */}
              <div className="flex gap-2 pt-1 pb-1">
                <Button
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  onClick={() => handleOpenChange(false)}
                  disabled={resolve.isPending}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  className="flex-1 text-white"
                  style={{ background: "#00414e" }}
                  disabled={!isFormValid || resolve.isPending}
                  onClick={() => resolve.mutate()}
                >
                  {resolve.isPending && (
                    <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                  )}
                  Confirm &amp; Close Session
                </Button>
              </div>
          </>
        </div>
      </DialogContent>
    </Dialog>
  );
}
