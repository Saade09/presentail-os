import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation, useParams } from "wouter";
import { useTranslation } from "react-i18next";
import { useUser } from "@clerk/react";
import {
  ArrowLeft,
  ArrowLeftRight,
  Calculator,
  Check,
  Download,
  Info,
  Loader2,
  Lock,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
} from "lucide-react";
import { apiFetch, getClerkToken } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { formatCashMoney, decimalPlaces as currencyDecimals } from "@/lib/cashMoney";
import type { SessionDetailResponse } from "./CashSessionDetail";

const TEAL_DARK = "#064E5A";
const TEAL_PALE = "#E6F4F6";

export type ReconciliationApproval = {
  status: "pending" | "approved" | "rejected";
  requested_at: string;
  decided_by_clerk_id: string | null;
  decided_at: string | null;
  note: string | null;
};

export type ReconciliationCount = {
  currency: string;
  expected: number;
  actual: number;
  variance: number;
  explanation: string | null;
  requires_approval: boolean;
  approval: ReconciliationApproval | null;
};

export type ReconciliationState = {
  started_at: string;
  started_by_clerk_id: string | null;
  counted_at: string | null;
  counted_by_clerk_id: string | null;
  tx_count: number;
  last_tx_id: number | null;
  counts: ReconciliationCount[];
};

const DENOMINATIONS: Record<string, number[]> = {
  USD: [100, 50, 20, 10, 5, 2, 1],
  AED: [1000, 500, 200, 100, 50, 20, 10, 5],
  LBP: [100000, 50000, 20000, 10000, 5000, 1000],
};

export { decimalPlaces as currencyDecimals } from "@/lib/cashMoney";


type CountEntry = { actual: string; denomQty: Record<string, string>; showDenoms: boolean };

function denomTotal(currency: string, denomQty: Record<string, string>): number {
  const denoms = DENOMINATIONS[currency.toUpperCase()] ?? [];
  let total = 0;
  for (const d of denoms) {
    const qty = parseInt(denomQty[String(d)] ?? "", 10);
    if (Number.isFinite(qty) && qty > 0) total += qty * d;
  }
  return total;
}

export default function CashSessionClose() {
  const params = useParams();
  const id = params.id;
  const [, navigate] = useLocation();
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { user } = useUser();
  const { isOwner, allowedPages } = useWorkspaceRole();
  const canApprove = isOwner || (allowedPages?.includes("cash_sessions.approve") ?? false);

  // Local blind-count entries — preserved across a recount.
  const [entries, setEntries] = useState<Record<string, CountEntry>>({});
  const [note, setNote] = useState("");
  const [explanations, setExplanations] = useState<Record<string, string>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [step, setStep] = useState<1 | 2 | 3 | null>(null);

  const { data, isLoading } = useQuery<SessionDetailResponse>({
    queryKey: ["cash-session", id],
    queryFn: () => apiFetch(`/api/cash-sessions/${id}`),
    enabled: !!id,
  });
  const session = data?.session;
  const summary = data?.currency_summary ?? [];
  const activeTransfers = data?.active_transfers ?? [];
  const rec = (session as unknown as { reconciliation?: ReconciliationState | null } | undefined)
    ?.reconciliation ?? null;
  const hasCounts = !!rec && rec.counts.length > 0;

  // Derive the visible step: explicit user choice wins, else server state.
  const activeStep: 1 | 2 | 3 = step ?? (hasCounts ? 2 : 1);

  function entry(cur: string): CountEntry {
    return entries[cur] ?? { actual: "", denomQty: {}, showDenoms: false };
  }
  function setEntry(cur: string, patch: Partial<CountEntry>) {
    setEntries((e) => ({ ...e, [cur]: { ...entry(cur), ...patch } }));
  }

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["cash-session", id] });
    qc.invalidateQueries({ queryKey: ["cash-sessions"] });
  };

  const countsMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ reconciliation: ReconciliationState }>(
        `/api/cash-sessions/${id}/reconciliation/counts`,
        {
          method: "POST",
          body: JSON.stringify({
            counts: summary.map((row) => ({
              currency: row.currency,
              actual: Number(entry(row.currency).actual),
            })),
          }),
        },
      ),
    onSuccess: () => {
      invalidate();
      setStep(2);
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  const recountMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/cash-sessions/${id}/reconciliation/recount`, { method: "POST" }),
    onSuccess: () => {
      invalidate();
      setConfirmed(false);
      setStep(1);
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  const explanationMutation = useMutation({
    mutationFn: ({ currency, explanation }: { currency: string; explanation: string }) =>
      apiFetch(`/api/cash-sessions/${id}/reconciliation/explanation`, {
        method: "POST",
        body: JSON.stringify({ currency, explanation }),
      }),
    onSuccess: () => {
      toast({ title: t("cashSessions.reconcile.explanationSaved") });
      invalidate();
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  const approvalMutation = useMutation({
    mutationFn: ({ currency, decision }: { currency: string; decision: "approved" | "rejected" }) =>
      apiFetch(`/api/cash-sessions/${id}/reconciliation/approval`, {
        method: "POST",
        body: JSON.stringify({ currency, decision }),
      }),
    onSuccess: () => invalidate(),
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  const closeMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/cash-sessions/${id}/reconcile-close`, {
        method: "POST",
        body: JSON.stringify({ confirmed: true, closing_note: note.trim() || null }),
      }),
    onSuccess: () => {
      toast({ title: t("cashSessions.close.sessionClosed") });
      invalidate();
      navigate(`/cash-sessions/${id}`);
    },
    onError: (err: Error & { body?: { stale?: boolean } }) => {
      const stale = (err as { body?: { stale?: boolean } }).body?.stale;
      if (stale || /recount/i.test(err.message)) {
        toast({ title: t("cashSessions.reconcile.staleError"), variant: "destructive" });
        setConfirmed(false);
        setStep(1);
        invalidate();
      } else {
        toast({ title: err.message, variant: "destructive" });
        invalidate();
      }
    },
  });

  async function downloadReport() {
    try {
      const token = await getClerkToken();
      const resp = await fetch(`/api/cash-sessions/${id}/reconciliation/report`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (!resp.ok) {
        const body = (await resp.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${resp.status}`);
      }
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `reconciliation-${session?.session_number ?? id}.txt`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast({ title: (err as Error).message, variant: "destructive" });
    }
  }

  const allCounted = useMemo(
    () =>
      summary.length > 0 &&
      summary.every((row) => {
        const v = Number(entry(row.currency).actual);
        return entry(row.currency).actual !== "" && Number.isFinite(v) && v >= 0;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [summary, entries],
  );

  // Step-2/3 readiness from the server-side reconciliation state.
  const counts = rec?.counts ?? [];
  const myClerkId = user?.id ?? null;
  const iCounted = !!rec?.counted_by_clerk_id && rec.counted_by_clerk_id === myClerkId;
  const missingExplanations = counts.filter(
    (c) => c.variance !== 0 && !(explanations[c.currency] ?? c.explanation ?? "").trim(),
  );
  const unsavedExplanations = counts.filter((c) => {
    const local = (explanations[c.currency] ?? "").trim();
    return c.variance !== 0 && local && local !== (c.explanation ?? "");
  });
  const pendingApprovals = counts.filter(
    (c) => c.requires_approval && (c.approval?.status ?? "pending") === "pending",
  );
  const rejectedApprovals = counts.filter((c) => c.approval?.status === "rejected");
  const readyToConfirm =
    hasCounts &&
    missingExplanations.length === 0 &&
    unsavedExplanations.length === 0 &&
    pendingApprovals.length === 0 &&
    rejectedApprovals.length === 0;

  const stepLabels = [
    t("cashSessions.reconcile.step1Title"),
    t("cashSessions.reconcile.step2Title"),
    t("cashSessions.reconcile.step3Title"),
  ];

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4 md:p-6">
      <Button
        variant="ghost"
        size="sm"
        onClick={() => navigate(`/cash-sessions/${id}`)}
        className="gap-1.5 -ms-2"
        data-testid="button-back"
      >
        <ArrowLeft className="h-4 w-4 rtl:rotate-180" /> {t("cashSessions.close.back")}
      </Button>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Lock className="h-5 w-5" /> {t("cashSessions.close.title")}
            {session ? (
              <span className="font-mono text-sm font-normal text-muted-foreground">
                {session.session_number}
              </span>
            ) : null}
          </CardTitle>
          {/* Stepper */}
          <div className="flex items-center gap-2 pt-2" data-testid="stepper">
            {stepLabels.map((label, i) => {
              const n = (i + 1) as 1 | 2 | 3;
              const active = activeStep === n;
              const done = activeStep > n;
              return (
                <div key={label} className="flex items-center gap-2">
                  {i > 0 && <div className="h-px w-6 bg-border" />}
                  <div
                    className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
                      active ? "text-white" : done ? "" : "text-muted-foreground"
                    }`}
                    style={
                      active
                        ? { backgroundColor: TEAL_DARK }
                        : done
                          ? { backgroundColor: TEAL_PALE, color: TEAL_DARK }
                          : undefined
                    }
                    data-testid={`step-indicator-${n}`}
                  >
                    {done ? <Check className="h-3 w-3" /> : <span>{n}</span>}
                    <span className="hidden sm:inline">{label}</span>
                  </div>
                </div>
              );
            })}
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          {isLoading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : !session ? (
            <p className="text-sm text-muted-foreground">Session not found.</p>
          ) : session.status !== "open" ? (
            <p className="text-sm text-muted-foreground">{t("cashSessions.close.notOpen")}</p>
          ) : activeStep === 1 ? (
            <>
              {/* STEP 1 — blind count: expected totals intentionally hidden */}
              <p className="text-sm text-muted-foreground">{t("cashSessions.reconcile.step1Intro")}</p>
              {summary.map((row) => {
                const e = entry(row.currency);
                const denoms = DENOMINATIONS[row.currency.toUpperCase()] ?? [];
                const decimals = currencyDecimals(row.currency);
                const dTotal = denomTotal(row.currency, e.denomQty);
                return (
                  <div
                    key={row.currency}
                    className="space-y-3 rounded-lg border p-4"
                    data-testid={`count-block-${row.currency}`}
                  >
                    <div className="flex items-center justify-between">
                      <span
                        className="rounded px-2 py-0.5 text-xs font-semibold text-white"
                        style={{ backgroundColor: TEAL_DARK }}
                      >
                        {row.currency}
                      </span>
                      {denoms.length > 0 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="gap-1.5 text-xs"
                          onClick={() => setEntry(row.currency, { showDenoms: !e.showDenoms })}
                          data-testid={`button-denoms-${row.currency}`}
                        >
                          <Calculator className="h-3.5 w-3.5" />
                          {t("cashSessions.reconcile.denominationHelper")}
                        </Button>
                      )}
                    </div>
                    {e.showDenoms && denoms.length > 0 && (
                      <div className="space-y-2 rounded-md p-3" style={{ backgroundColor: TEAL_PALE }}>
                        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                          {denoms.map((d) => (
                            <div key={d} className="flex items-center gap-1.5">
                              <span className="w-16 shrink-0 text-end text-xs tabular-nums" dir="ltr">
                                {d.toLocaleString()}
                              </span>
                              <span className="text-xs text-muted-foreground">×</span>
                              <Input
                                type="number"
                                min="0"
                                step="1"
                                className="h-8"
                                value={e.denomQty[String(d)] ?? ""}
                                onChange={(ev) =>
                                  setEntry(row.currency, {
                                    denomQty: { ...e.denomQty, [String(d)]: ev.target.value },
                                  })
                                }
                                data-testid={`input-denom-${row.currency}-${d}`}
                              />
                            </div>
                          ))}
                        </div>
                        <div className="flex items-center justify-between text-sm">
                          <span className="text-muted-foreground">
                            {t("cashSessions.reconcile.denomTotal")}:{" "}
                            <span className="font-semibold tabular-nums" style={{ color: TEAL_DARK }} dir="ltr">
                              {formatCashMoney(dTotal, row.currency)}
                            </span>
                          </span>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              setEntry(row.currency, { actual: String(dTotal.toFixed(decimals)) })
                            }
                            data-testid={`button-use-denom-total-${row.currency}`}
                          >
                            {t("cashSessions.reconcile.useTotal")}
                          </Button>
                        </div>
                      </div>
                    )}
                    <div className="space-y-1.5">
                      <Label>
                        {t("cashSessions.close.counted")} ({row.currency})
                      </Label>
                      <Input
                        type="number"
                        min="0"
                        step={decimals === 0 ? "1" : "0.01"}
                        value={e.actual}
                        onChange={(ev) => setEntry(row.currency, { actual: ev.target.value })}
                        placeholder={decimals === 0 ? "0" : "0.00"}
                        data-testid={`input-counted-${row.currency}`}
                      />
                      {decimals === 0 && (
                        <p className="text-xs text-muted-foreground">
                          {t("cashSessions.reconcile.noDecimals", { currency: row.currency })}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
              <div className="flex justify-end gap-2">
                <Button variant="outline" onClick={() => navigate(`/cash-sessions/${id}`)}>
                  {t("cashSessions.reconcile.cancel")}
                </Button>
                <Button
                  disabled={!allCounted || countsMutation.isPending}
                  onClick={() => countsMutation.mutate()}
                  className="gap-1.5 text-white hover:opacity-90"
                  style={{ backgroundColor: TEAL_DARK }}
                  data-testid="button-submit-counts"
                >
                  {countsMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                  {t("cashSessions.reconcile.submitCounts")}
                </Button>
              </div>
            </>
          ) : activeStep === 2 ? (
            <>
              {/* STEP 2 — review variance */}
              <p className="text-sm text-muted-foreground">{t("cashSessions.reconcile.step2Intro")}</p>
              {counts.map((c) => {
                const localExplanation = explanations[c.currency] ?? c.explanation ?? "";
                const approvalStatus = c.approval?.status ?? null;
                return (
                  <div
                    key={c.currency}
                    className="space-y-3 rounded-lg border p-4"
                    data-testid={`review-block-${c.currency}`}
                  >
                    <div className="flex items-center justify-between">
                      <span
                        className="rounded px-2 py-0.5 text-xs font-semibold text-white"
                        style={{ backgroundColor: TEAL_DARK }}
                      >
                        {c.currency}
                      </span>
                      <span
                        className={`text-sm font-semibold tabular-nums ${
                          c.variance === 0
                            ? "text-emerald-600"
                            : c.variance < 0
                              ? "text-red-600"
                              : "text-amber-600"
                        }`}
                        dir="ltr"
                        data-testid={`text-variance-${c.currency}`}
                      >
                        {c.variance > 0 ? "+" : ""}
                        {formatCashMoney(c.variance, c.currency)} (
                        {c.variance === 0
                          ? t("cashSessions.close.balanced")
                          : c.variance < 0
                            ? t("cashSessions.close.short")
                            : t("cashSessions.close.over")}
                        )
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <div className="rounded-md p-2" style={{ backgroundColor: TEAL_PALE }}>
                        <div className="text-xs text-muted-foreground">
                          {t("cashSessions.close.expected")}
                        </div>
                        <div className="font-semibold tabular-nums" style={{ color: TEAL_DARK }} dir="ltr">
                          {formatCashMoney(c.expected, c.currency)}
                        </div>
                      </div>
                      <div className="rounded-md bg-muted p-2">
                        <div className="text-xs text-muted-foreground">
                          {t("cashSessions.close.counted")}
                        </div>
                        <div className="font-semibold tabular-nums" dir="ltr">
                          {formatCashMoney(c.actual, c.currency)}
                        </div>
                      </div>
                    </div>
                    {c.variance !== 0 && (
                      <div className="space-y-1.5">
                        <Label>{t("cashSessions.close.explanation")}</Label>
                        <Textarea
                          value={localExplanation}
                          onChange={(ev) =>
                            setExplanations((x) => ({ ...x, [c.currency]: ev.target.value }))
                          }
                          rows={2}
                          data-testid={`input-explanation-${c.currency}`}
                        />
                        <div className="flex items-center justify-between">
                          {!localExplanation.trim() ? (
                            <p className="text-xs text-red-600">
                              {t("cashSessions.close.explanationRequired")}
                            </p>
                          ) : (
                            <span />
                          )}
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            disabled={
                              !localExplanation.trim() ||
                              localExplanation.trim() === (c.explanation ?? "") ||
                              explanationMutation.isPending
                            }
                            onClick={() =>
                              explanationMutation.mutate({
                                currency: c.currency,
                                explanation: localExplanation.trim(),
                              })
                            }
                            data-testid={`button-save-explanation-${c.currency}`}
                          >
                            {t("cashSessions.reconcile.saveExplanation")}
                          </Button>
                        </div>
                      </div>
                    )}
                    {c.requires_approval && (
                      <div
                        className={`space-y-2 rounded-md border px-3 py-2 text-xs ${
                          approvalStatus === "approved"
                            ? "border-emerald-300 bg-emerald-50 text-emerald-800"
                            : approvalStatus === "rejected"
                              ? "border-red-300 bg-red-50 text-red-800"
                              : "border-amber-300 bg-amber-50 text-amber-800"
                        }`}
                        data-testid={`approval-block-${c.currency}`}
                      >
                        <div className="flex items-start gap-2">
                          {approvalStatus === "approved" ? (
                            <ShieldCheck className="h-4 w-4 shrink-0" />
                          ) : approvalStatus === "rejected" ? (
                            <ShieldX className="h-4 w-4 shrink-0" />
                          ) : (
                            <ShieldAlert className="h-4 w-4 shrink-0" />
                          )}
                          <span>
                            {approvalStatus === "approved"
                              ? t("cashSessions.reconcile.approvalApproved")
                              : approvalStatus === "rejected"
                                ? t("cashSessions.reconcile.approvalRejected")
                                : t("cashSessions.close.approvalNeeded")}
                          </span>
                        </div>
                        {approvalStatus === "pending" &&
                          (canApprove && !iCounted ? (
                            <div className="flex gap-2">
                              <Button
                                type="button"
                                size="sm"
                                className="h-7 bg-emerald-600 text-white hover:bg-emerald-700"
                                disabled={approvalMutation.isPending}
                                onClick={() =>
                                  approvalMutation.mutate({
                                    currency: c.currency,
                                    decision: "approved",
                                  })
                                }
                                data-testid={`button-approve-${c.currency}`}
                              >
                                {t("cashSessions.reconcile.approve")}
                              </Button>
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className="h-7 border-red-300 text-red-700"
                                disabled={approvalMutation.isPending}
                                onClick={() =>
                                  approvalMutation.mutate({
                                    currency: c.currency,
                                    decision: "rejected",
                                  })
                                }
                                data-testid={`button-reject-${c.currency}`}
                              >
                                {t("cashSessions.reconcile.reject")}
                              </Button>
                            </div>
                          ) : (
                            <p>
                              {iCounted && canApprove
                                ? t("cashSessions.reconcile.selfApprovalBlocked")
                                : t("cashSessions.reconcile.askSupervisor")}
                            </p>
                          ))}
                      </div>
                    )}
                  </div>
                );
              })}
              <div className="flex flex-wrap justify-between gap-2">
                <Button
                  variant="outline"
                  className="gap-1.5"
                  disabled={recountMutation.isPending}
                  onClick={() => recountMutation.mutate()}
                  data-testid="button-recount"
                >
                  <RotateCcw className="h-3.5 w-3.5" /> {t("cashSessions.reconcile.recount")}
                </Button>
                <Button
                  disabled={!readyToConfirm}
                  onClick={() => setStep(3)}
                  className="gap-1.5 text-white hover:opacity-90"
                  style={{ backgroundColor: TEAL_DARK }}
                  data-testid="button-to-confirm"
                >
                  {t("cashSessions.reconcile.continue")}
                </Button>
              </div>
              {unsavedExplanations.length > 0 && (
                <p className="text-end text-xs text-amber-600">
                  {t("cashSessions.reconcile.unsavedExplanations")}
                </p>
              )}
            </>
          ) : (
            <>
              {/* STEP 3 — confirm closure */}
              <p className="text-sm text-muted-foreground">{t("cashSessions.reconcile.step3Intro")}</p>
              <div className="overflow-hidden rounded-lg border">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-muted/50 text-start text-xs text-muted-foreground">
                      <th className="p-2 text-start">{t("cashSessions.currency")}</th>
                      <th className="p-2 text-end">{t("cashSessions.close.expected")}</th>
                      <th className="p-2 text-end">{t("cashSessions.close.counted")}</th>
                      <th className="p-2 text-end">{t("cashSessions.close.variance")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {counts.map((c) => (
                      <tr key={c.currency} className="border-t" data-testid={`summary-row-${c.currency}`}>
                        <td className="p-2 font-medium">{c.currency}</td>
                        <td className="p-2 text-end tabular-nums" dir="ltr">
                          {formatCashMoney(c.expected, c.currency)}
                        </td>
                        <td className="p-2 text-end tabular-nums" dir="ltr">
                          {formatCashMoney(c.actual, c.currency)}
                        </td>
                        <td
                          className={`p-2 text-end tabular-nums ${
                            c.variance === 0
                              ? "text-emerald-600"
                              : c.variance < 0
                                ? "text-red-600"
                                : "text-amber-600"
                          }`}
                          dir="ltr"
                        >
                          {c.variance > 0 ? "+" : ""}
                          {formatCashMoney(c.variance, c.currency)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {/* In-transit transfer notice (informational, non-blocking) */}
              {activeTransfers.filter((tr) => tr.status === "in_transit" || (tr as { status?: string }).status === "IN_TRANSIT").length > 0 && (
                <div
                  className="flex items-start gap-2 rounded-lg border px-3 py-2.5 text-xs"
                  style={{ borderColor: "#BFDBFE", backgroundColor: "#EFF6FF", color: "#1D4ED8" }}
                  data-testid="in-transit-transfers-notice"
                >
                  <Info className="mt-0.5 h-4 w-4 shrink-0" />
                  <div>
                    <p className="font-semibold">
                      {activeTransfers.length === 1
                        ? "1 transfer in transit"
                        : `${activeTransfers.length} transfers in transit`}
                    </p>
                    <p className="mt-0.5 text-blue-700">
                      The following transfers have not yet been received. You can still close this
                      session — they will be noted in the report.
                    </p>
                    <ul className="mt-1 space-y-0.5">
                      {activeTransfers.map((tr) => (
                        <li key={tr.id} className="flex items-center gap-1.5">
                          <ArrowLeftRight className="h-3 w-3 shrink-0" />
                          <span dir="ltr" className="font-semibold">
                            {tr.currency} {tr.amount}
                          </span>
                          {" → "}
                          {[tr.destination_location_name, tr.destination_drawer_name]
                            .filter(Boolean)
                            .join(" · ")}
                          <span className="font-mono">({tr.transfer_number})</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              )}

              <div className="space-y-1.5">
                <Label>{t("cashSessions.close.closingNote")}</Label>
                <Textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  rows={2}
                  placeholder={t("cashSessions.optional")}
                  data-testid="input-closing-note"
                />
              </div>
              <label className="flex items-start gap-2 text-sm" data-testid="label-confirm">
                <Checkbox
                  checked={confirmed}
                  onCheckedChange={(v) => setConfirmed(v === true)}
                  data-testid="checkbox-confirm"
                />
                <span>{t("cashSessions.reconcile.confirmStatement")}</span>
              </label>
              <div className="flex flex-wrap justify-between gap-2">
                <Button variant="outline" onClick={() => setStep(2)} data-testid="button-back-to-review">
                  {t("cashSessions.close.back")}
                </Button>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    className="gap-1.5"
                    onClick={downloadReport}
                    data-testid="button-download-report"
                  >
                    <Download className="h-3.5 w-3.5" /> {t("cashSessions.reconcile.downloadReport")}
                  </Button>
                  <Button
                    disabled={!confirmed || closeMutation.isPending}
                    onClick={() => closeMutation.mutate()}
                    className="gap-1.5 text-white hover:opacity-90"
                    style={{ backgroundColor: TEAL_DARK }}
                    data-testid="button-close-session"
                  >
                    {closeMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                    {t("cashSessions.close.closeSession")}
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
