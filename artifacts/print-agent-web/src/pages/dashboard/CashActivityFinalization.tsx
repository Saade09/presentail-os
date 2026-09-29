/**
 * Finalization flow for Cash Activity month close.
 *
 * FinalizeMonthModal – 4-step guided close flow:
 *   1. Cash reconciliation check (open cash sessions)
 *   2. Exceptions review (unmatched / missing evidence / needs review)
 *   3. Accounting review checklist
 *   4. Lock & finalize (final totals + confirm)
 *
 * ReopenMonthModal – single-step reopen with mandatory reason.
 */

import { useState, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Loader2,
  Lock,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { formatCashMoney } from "@/lib/cashMoney";

// ─── Types ─────────────────────────────────────────────────────────────────────

interface CashActivitySummary {
  cashSalesTotal: string;
  refundsTotal: string;
  cashExpensesTotal: string;
  netCashActivity: string;
  needsReviewCount: number;
  totalTransactions: number;
  expectedCash: string;
  deposited: string;
  transferred: string;
  cashPositionDifference: string;
  balanced: boolean;
}

interface ApiParams {
  yearMonth: string;
  entityId?: string;
  locationId?: string;
  drawerId?: string;
  currency?: string;
}

interface CashSession {
  id: number;
  name: string;
  drawerName: string | null;
  locationName: string | null;
  status: string;
}

interface ChecklistItem {
  id: number;
  label: string;
  isChecked: boolean;
  isAutoCompleted?: boolean;
  sortOrder: number;
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function buildQS(obj: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && String(v) !== "") p.set(k, String(v));
  }
  return p.toString() ? `?${p.toString()}` : "";
}

// ─── Step indicator ─────────────────────────────────────────────────────────────

const STEP_LABELS_KEY = [
  "cashActivity.finalize.stepCashReconciliation",
  "cashActivity.finalize.stepExceptions",
  "cashActivity.finalize.stepAccountingReview",
  "cashActivity.finalize.stepLockFinalize",
] as const;

function StepIndicator({ step, total }: { step: number; total: number }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2 mb-6">
      {Array.from({ length: total }, (_, i) => (
        <div key={i} className="flex items-center gap-2">
          <div
            className={`flex items-center justify-center w-6 h-6 rounded-full text-[11px] font-semibold shrink-0 transition-colors ${
              i + 1 < step
                ? "bg-primary text-primary-foreground"
                : i + 1 === step
                  ? "bg-primary text-primary-foreground ring-2 ring-primary ring-offset-1"
                  : "bg-muted text-muted-foreground"
            }`}
          >
            {i + 1 < step ? <CheckCircle2 className="w-3.5 h-3.5" /> : i + 1}
          </div>
          <span
            className={`text-xs hidden sm:block ${
              i + 1 === step ? "font-medium text-foreground" : "text-muted-foreground"
            }`}
          >
            {t(STEP_LABELS_KEY[i])}
          </span>
          {i + 1 < total && (
            <div className={`h-px w-6 ${i + 1 < step ? "bg-primary" : "bg-border"}`} />
          )}
        </div>
      ))}
    </div>
  );
}

// ─── Status row ─────────────────────────────────────────────────────────────────

type RowState = "pass" | "warn" | "block" | "loading" | "unknown";

function StatusRow({
  label,
  value,
  state,
}: {
  label: string;
  value: string | number;
  state: RowState;
}) {
  const icon =
    state === "loading" ? (
      <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
    ) : state === "pass" ? (
      <CheckCircle2 className="w-4 h-4 text-green-600" />
    ) : state === "warn" ? (
      <AlertTriangle className="w-4 h-4 text-amber-500" />
    ) : state === "block" ? (
      <XCircle className="w-4 h-4 text-destructive" />
    ) : (
      <div className="w-4 h-4 rounded-full bg-muted" />
    );

  return (
    <div className="flex items-center justify-between py-2 border-b last:border-0">
      <div className="flex items-center gap-2 text-sm">
        {icon}
        <span>{label}</span>
      </div>
      <span
        className={`text-sm tabular-nums font-medium ${
          state === "block"
            ? "text-destructive"
            : state === "warn"
              ? "text-amber-600"
              : state === "pass"
                ? "text-green-700"
                : "text-muted-foreground"
        }`}
      >
        {value}
      </span>
    </div>
  );
}

// ─── Step 1: Cash reconciliation ────────────────────────────────────────────────

function Step1CashReconciliation({
  yearMonth,
  entityId,
  onBlockingChange,
}: {
  yearMonth: string;
  entityId?: string;
  onBlockingChange: (blocked: boolean) => void;
}) {
  const { t } = useTranslation();
  const [sessions, setSessions] = useState<CashSession[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  // Fetch open sessions on mount
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);

    const qs = buildQS({
      status: "open",
      yearMonth,
      entityId,
      pageSize: 100,
    });
    fetch(`/api/cash-sessions${qs}`, { credentials: "include" })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: { sessions?: CashSession[]; rows?: CashSession[] }) => {
        if (cancelled) return;
        const open = data.sessions ?? data.rows ?? [];
        setSessions(open);
        onBlockingChange(open.length > 0);
      })
      .catch(() => {
        if (cancelled) return;
        setError(true);
        onBlockingChange(false); // allow proceeding on fetch error
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [yearMonth, entityId]);

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 text-sm text-destructive p-3 rounded-md bg-destructive/10">
        <AlertTriangle className="w-4 h-4 shrink-0" />
        {t("cashActivity.finalize.sessionsError")}
      </div>
    );
  }

  const openCount = sessions?.length ?? 0;

  return (
    <div className="space-y-4">
      <StatusRow
        label={t("cashActivity.finalize.sessionsStatus")}
        value={openCount === 0 ? t("cashActivity.finalize.sessionsClosed") : `${openCount} open`}
        state={openCount === 0 ? "pass" : "block"}
      />

      {openCount > 0 && (
        <div className="rounded-md bg-destructive/10 border border-destructive/20 p-3 space-y-2">
          <p className="text-xs text-destructive font-medium">
            {t("cashActivity.finalize.sessionsOpenWarning", { count: openCount })}
          </p>
          <ul className="space-y-1">
            {sessions!.slice(0, 10).map((s) => (
              <li key={s.id} className="text-xs text-muted-foreground flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-destructive shrink-0" />
                {s.name ?? `Session #${s.id}`}
                {s.drawerName && <span className="text-muted-foreground/60">— {s.drawerName}</span>}
              </li>
            ))}
            {openCount > 10 && (
              <li className="text-xs text-muted-foreground">
                +{openCount - 10} more…
              </li>
            )}
          </ul>
        </div>
      )}

      {openCount === 0 && (
        <p className="text-sm text-muted-foreground">
          {t("cashActivity.finalize.sessionsAllClosed")}
        </p>
      )}
    </div>
  );
}

// ─── Step 2: Exceptions ─────────────────────────────────────────────────────────

const UNMATCHED_BLOCK_THRESHOLD = 0; // any unmatched transaction blocks finalization

function Step2Exceptions({
  apiParams,
  needsReviewCount,
  onBlockingChange,
}: {
  apiParams: ApiParams;
  needsReviewCount: number;
  onBlockingChange: (blocked: boolean) => void;
}) {
  const { t } = useTranslation();
  const [unmatchedTotal, setUnmatchedTotal] = useState<number | null>(null);
  const [missingEvidenceTotal, setMissingEvidenceTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const base: Record<string, string | undefined> = {
      yearMonth: apiParams.yearMonth,
      entityId: apiParams.entityId,
      locationId: apiParams.locationId,
      drawerId: apiParams.drawerId,
      currency: apiParams.currency,
    };

    Promise.all([
      fetch(`/api/cash-activity/transactions${buildQS({ ...base, tab: "unmatched", pageSize: "1" })}`, {
        credentials: "include",
      }).then((r) => r.ok ? r.json() : { total: 0 }),
      fetch(`/api/cash-activity/transactions${buildQS({ ...base, tab: "unmatched", hasReceipt: "false", pageSize: "1" })}`, {
        credentials: "include",
      }).then((r) => r.ok ? r.json() : { total: 0 }),
    ])
      .then(([unmatchedData, missingData]) => {
        if (cancelled) return;
        const unmatched = unmatchedData.total ?? 0;
        const missing = missingData.total ?? 0;
        setUnmatchedTotal(unmatched);
        setMissingEvidenceTotal(missing);
        onBlockingChange(unmatched > UNMATCHED_BLOCK_THRESHOLD);
      })
      .catch(() => {
        if (cancelled) return;
        setUnmatchedTotal(0);
        setMissingEvidenceTotal(0);
        onBlockingChange(false);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiParams.yearMonth, apiParams.entityId, apiParams.locationId, apiParams.drawerId, apiParams.currency]);

  const unmatched = unmatchedTotal ?? 0;
  const missingEvidence = missingEvidenceTotal ?? 0;
  const isBlocked = unmatched > UNMATCHED_BLOCK_THRESHOLD;

  return (
    <div className="space-y-4">
      <div className="divide-y rounded-md border">
        <StatusRow
          label={t("cashActivity.finalize.exceptionsUnmatched")}
          value={loading ? "—" : unmatched}
          state={loading ? "loading" : unmatched > UNMATCHED_BLOCK_THRESHOLD ? "block" : "pass"}
        />
        <StatusRow
          label={t("cashActivity.finalize.exceptionsMissingEvidence")}
          value={loading ? "—" : missingEvidence}
          state={loading ? "loading" : missingEvidence > 0 ? "warn" : "pass"}
        />
        <StatusRow
          label={t("cashActivity.finalize.exceptionsNeedsReview")}
          value={needsReviewCount}
          state={needsReviewCount > 0 ? "warn" : "pass"}
        />
      </div>

      {!loading && isBlocked && (
        <div className="flex items-center gap-2 text-sm text-destructive p-3 rounded-md bg-destructive/10">
          <XCircle className="w-4 h-4 shrink-0" />
          {t("cashActivity.finalize.exceptionsBlocking")}
        </div>
      )}

      {!loading && !isBlocked && missingEvidence > 0 && (
        <div className="flex items-center gap-2 text-sm text-amber-700 p-3 rounded-md bg-amber-50 border border-amber-200">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          {t("cashActivity.finalize.exceptionsMissingEvidenceWarn", { count: missingEvidence })}
        </div>
      )}

      {!loading && !isBlocked && needsReviewCount > 0 && (
        <div className="flex items-center gap-2 text-sm text-amber-700 p-3 rounded-md bg-amber-50 border border-amber-200">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          {t("cashActivity.finalize.exceptionsNeedsReviewWarn", { count: needsReviewCount })}
        </div>
      )}
    </div>
  );
}

// ─── Step 3: Accounting review ──────────────────────────────────────────────────

function Step3AccountingReview({
  yearMonth,
  entityId,
  onBlockingChange,
}: {
  yearMonth: string;
  entityId?: string;
  onBlockingChange: (blocked: boolean) => void;
}) {
  const { t } = useTranslation();
  const [items, setItems] = useState<ChecklistItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);

    if (!entityId) {
      setLoading(false);
      setItems([]);
      onBlockingChange(false);
      return;
    }

    const [year, month] = yearMonth.split("-").map(Number);

    // Find the accounting month for this yearMonth, then look for entity-months
    fetch(
      `/api/accounting/months${buildQS({ year })}`,
      { credentials: "include" },
    )
      .then((r) => r.ok ? r.json() : { months: [] })
      .then(async (data: { months: Array<{ id: number; year: number; month: number; entity_months?: Array<{ id: number; entity_id: number }> }> }) => {
        if (cancelled) return;
        const acctMonth = data.months?.find(
          (m) => m.year === year && m.month === month,
        );
        if (!acctMonth) {
          setItems([]);
          onBlockingChange(false);
          return;
        }

        // Try to find the entity-month from the month's entity_months list
        const entityMonths = acctMonth.entity_months ?? [];
        const entityMonth = entityMonths.find(
          (em) => String(em.entity_id) === String(entityId),
        );

        if (!entityMonth) {
          setItems([]);
          onBlockingChange(false);
          return;
        }

        // Fetch checklist for this entity-month
        const clRes = await fetch(
          `/api/accounting/entity-months/${entityMonth.id}/checklist`,
          { credentials: "include" },
        );
        if (!clRes.ok) {
          setItems([]);
          onBlockingChange(false);
          return;
        }
        const clData = await clRes.json();
        const checklistItems: ChecklistItem[] = clData.checklist?.items ?? [];
        setItems(checklistItems);
        // Block if any mandatory unchecked item is present
        const hasBlocker = checklistItems.some(
          (item) => !item.isChecked && !item.isAutoCompleted,
        );
        onBlockingChange(hasBlocker);
      })
      .catch(() => {
        if (cancelled) return;
        setError(true);
        onBlockingChange(false);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [yearMonth, entityId]);

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 text-sm text-amber-700 p-3 rounded-md bg-amber-50 border border-amber-200">
        <AlertTriangle className="w-4 h-4 shrink-0" />
        {t("cashActivity.finalize.checklistError")}
      </div>
    );
  }

  if (!items || items.length === 0) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground p-4 rounded-md border border-dashed">
        <CheckCircle2 className="w-4 h-4 text-muted-foreground" />
        {t("cashActivity.finalize.checklistEmpty")}
      </div>
    );
  }

  const allClear = items.every((item) => item.isChecked || item.isAutoCompleted);

  return (
    <div className="space-y-4">
      <div className="divide-y rounded-md border">
        {items.map((item) => (
          <div key={item.id} className="flex items-center gap-3 p-3">
            {item.isChecked || item.isAutoCompleted ? (
              <CheckCircle2 className="w-4 h-4 text-green-600 shrink-0" />
            ) : (
              <div className="w-4 h-4 rounded border-2 border-muted-foreground/40 shrink-0" />
            )}
            <span
              className={`text-sm ${
                item.isChecked || item.isAutoCompleted
                  ? "text-muted-foreground line-through"
                  : "text-foreground"
              }`}
            >
              {item.label}
              {item.isAutoCompleted && (
                <Badge className="ml-2 text-[10px] bg-sky-100 text-sky-700 border-sky-200">
                  Auto
                </Badge>
              )}
            </span>
          </div>
        ))}
      </div>

      {allClear ? (
        <div className="flex items-center gap-2 text-sm text-green-700 p-3 rounded-md bg-green-50 border border-green-200">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          {t("cashActivity.finalize.checklistAllClear")}
        </div>
      ) : (
        <div className="flex items-center gap-2 text-sm text-amber-700 p-3 rounded-md bg-amber-50 border border-amber-200">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          {t("cashActivity.finalize.checklistIncomplete", {
            count: items.filter((i) => !i.isChecked && !i.isAutoCompleted).length,
          })}
        </div>
      )}
    </div>
  );
}

// ─── Step 4: Lock and finalize ──────────────────────────────────────────────────

function Step4LockFinalize({
  yearMonth,
  entityId,
  summary,
  currency,
  monthLabel,
  stepBlocked,
  onSuccess,
}: {
  yearMonth: string;
  entityId?: string;
  summary: CashActivitySummary | undefined;
  currency: string;
  monthLabel: string;
  stepBlocked: boolean;
  onSuccess: () => void;
}) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cur = currency || "AED";

  const handleFinalize = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const qs = buildQS({ entityId });
      const res = await fetch(`/api/cash-activity/months/${yearMonth}/finalize${qs}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entityId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("cashActivity.finalize.errorToast"));
    } finally {
      setLoading(false);
    }
  }, [yearMonth, entityId, onSuccess, t]);

  const totals = summary
    ? [
        {
          label: t("cashActivity.finalize.totalsCashSales"),
          value: formatCashMoney(parseFloat(summary.cashSalesTotal), cur),
        },
        {
          label: t("cashActivity.finalize.totalsRefunds"),
          value: formatCashMoney(parseFloat(summary.refundsTotal), cur),
        },
        {
          label: t("cashActivity.finalize.totalsExpenses"),
          value: formatCashMoney(parseFloat(summary.cashExpensesTotal), cur),
        },
        {
          label: t("cashActivity.finalize.totalsNet"),
          value: formatCashMoney(parseFloat(summary.netCashActivity), cur),
          highlight: true,
        },
        {
          label: t("cashActivity.finalize.totalsCashPosition"),
          value: formatCashMoney(parseFloat(summary.cashPositionDifference), cur),
          highlight: !summary.balanced,
        },
      ]
    : [];

  return (
    <div className="space-y-5">
      {/* Final totals */}
      <div className="rounded-md border divide-y">
        {summary
          ? totals.map(({ label, value, highlight }) => (
              <div key={label} className="flex justify-between items-center px-4 py-3">
                <span className="text-sm text-muted-foreground">{label}</span>
                <span
                  className={`text-sm tabular-nums font-semibold ${
                    highlight ? "text-foreground" : "text-foreground"
                  }`}
                >
                  {value}
                </span>
              </div>
            ))
          : [...Array(5)].map((_, i) => (
              <div key={i} className="flex justify-between px-4 py-3">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-4 w-20" />
              </div>
            ))}
      </div>

      {/* Confirmation notice */}
      <div className="flex items-start gap-3 p-3 rounded-md bg-amber-50 border border-amber-200">
        <Lock className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
        <p className="text-xs text-amber-700">{t("cashActivity.finalize.confirmNotice")}</p>
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 text-sm text-destructive p-3 rounded-md bg-destructive/10">
          <XCircle className="w-4 h-4 shrink-0" />
          {error}
        </div>
      )}

      {/* Finalize button */}
      <Button
        className="w-full"
        disabled={stepBlocked || loading}
        onClick={handleFinalize}
      >
        {loading && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
        {loading
          ? t("cashActivity.finalize.finalizing")
          : t("cashActivity.finalize.finalizeButton", { month: monthLabel })}
      </Button>
    </div>
  );
}

// ─── FinalizeMonthModal ─────────────────────────────────────────────────────────

export interface FinalizeMonthModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  yearMonth: string;
  monthLabel: string;
  entityId?: string;
  apiParams: ApiParams;
  summary: CashActivitySummary | undefined;
  currency: string;
  onSuccess: () => void;
}

export function FinalizeMonthModal({
  open,
  onOpenChange,
  yearMonth,
  monthLabel,
  entityId,
  apiParams,
  summary,
  currency,
  onSuccess,
}: FinalizeMonthModalProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState(1);
  const TOTAL_STEPS = 4;

  // Per-step blocking flags
  const [step1Blocked, setStep1Blocked] = useState(false);
  const [step2Blocked, setStep2Blocked] = useState(false);
  const [step3Blocked, setStep3Blocked] = useState(false);

  const currentStepBlocked =
    (step === 1 && step1Blocked) ||
    (step === 2 && step2Blocked) ||
    (step === 3 && step3Blocked);

  const allPriorStepsClear = !step1Blocked && !step2Blocked && !step3Blocked;

  function handleClose() {
    onOpenChange(false);
    // Reset after close animation
    setTimeout(() => setStep(1), 300);
  }

  function handleSuccess() {
    onSuccess();
    handleClose();
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-base">
            {t("cashActivity.finalize.modalTitle", { month: monthLabel })}
          </DialogTitle>
          <p className="text-xs text-muted-foreground">
            {t("cashActivity.finalize.step", { current: step, total: TOTAL_STEPS })}
          </p>
        </DialogHeader>

        <StepIndicator step={step} total={TOTAL_STEPS} />

        <div className="min-h-[200px]">
          {step === 1 && (
            <Step1CashReconciliation
              yearMonth={yearMonth}
              entityId={entityId}
              onBlockingChange={setStep1Blocked}
            />
          )}
          {step === 2 && (
            <Step2Exceptions
              apiParams={apiParams}
              needsReviewCount={summary?.needsReviewCount ?? 0}
              onBlockingChange={setStep2Blocked}
            />
          )}
          {step === 3 && (
            <Step3AccountingReview
              yearMonth={yearMonth}
              entityId={entityId}
              onBlockingChange={setStep3Blocked}
            />
          )}
          {step === 4 && (
            <Step4LockFinalize
              yearMonth={yearMonth}
              entityId={entityId}
              summary={summary}
              currency={currency}
              monthLabel={monthLabel}
              stepBlocked={!allPriorStepsClear}
              onSuccess={handleSuccess}
            />
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" size="sm" onClick={handleClose}>
            {t("common.cancel")}
          </Button>
          {step > 1 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setStep((s) => Math.max(1, s - 1))}
            >
              {t("cashActivity.finalize.back")}
            </Button>
          )}
          {step < TOTAL_STEPS && (
            <Button
              size="sm"
              disabled={currentStepBlocked}
              onClick={() => setStep((s) => Math.min(TOTAL_STEPS, s + 1))}
            >
              {t("cashActivity.finalize.next")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── ReopenMonthModal ──────────────────────────────────────────────────────────

export interface ReopenMonthModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  yearMonth: string;
  monthLabel: string;
  entityId?: string;
  onSuccess: () => void;
}

export function ReopenMonthModal({
  open,
  onOpenChange,
  yearMonth,
  monthLabel,
  entityId,
  onSuccess,
}: ReopenMonthModalProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reasonTrimmed = reason.trim();
  const isValid = reasonTrimmed.length >= 10;

  function handleClose() {
    if (loading) return;
    onOpenChange(false);
    setTimeout(() => {
      setReason("");
      setError(null);
    }, 300);
  }

  async function handleReopen() {
    if (!isValid) return;
    setLoading(true);
    setError(null);
    try {
      const qs = buildQS({ entityId });
      const res = await fetch(`/api/cash-activity/months/${yearMonth}/reopen${qs}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reasonTrimmed, entityId }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      queryClient.invalidateQueries({ queryKey: ["cash-activity-month-status"] });
      queryClient.invalidateQueries({ queryKey: ["cash-activity-summary"] });
      queryClient.invalidateQueries({ queryKey: ["cash-activity-transactions"] });
      onSuccess();
      handleClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("cashActivity.reopen.errorToast"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base">
            {t("cashActivity.reopen.modalTitle", { month: monthLabel })}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {t("cashActivity.reopen.description")}
          </p>

          <div className="space-y-1.5">
            <label className="text-sm font-medium">
              {t("cashActivity.reopen.reasonLabel")}
            </label>
            <Textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t("cashActivity.reopen.reasonPlaceholder")}
              rows={4}
              className="text-sm resize-none"
              disabled={loading}
            />
            {reason.trim().length > 0 && !isValid && (
              <p className="text-xs text-destructive">
                {t("cashActivity.reopen.reasonMinLength")}
              </p>
            )}
          </div>

          {error && (
            <div className="flex items-center gap-2 text-sm text-destructive p-3 rounded-md bg-destructive/10">
              <XCircle className="w-4 h-4 shrink-0" />
              {error}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button variant="outline" size="sm" onClick={handleClose} disabled={loading}>
            {t("cashActivity.reopen.cancel")}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={!isValid || loading}
            onClick={handleReopen}
          >
            {loading && <Loader2 className="w-4 h-4 animate-spin mr-2" />}
            {loading
              ? t("cashActivity.reopen.reopening")
              : t("cashActivity.reopen.confirmButton")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
