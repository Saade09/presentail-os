import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { CheckCircle2, XCircle, Loader2 } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";
import { toast } from "@/hooks/use-toast";
import { formatUsd, formatLbp } from "./cmcPosDashboard.helpers";

// ── Types ──────────────────────────────────────────────────────────────────────

export type PendingResolution = {
  id: number;
  /** Display name of the user who submitted the resolution */
  resolver_name?: string | null;
  counted_balance: string;
  expected_balance: string;
  difference: string;
  reason: string;
  note: string | null;
  currency: string;
  created_at: string;
};

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  resolution: PendingResolution;
  onDone: () => void;
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

const REASON_LABELS: Record<string, string> = {
  forgot_to_close: "Forgot to close shift",
  employee_unavailable: "Employee unavailable",
  technical_issue: "Technical issue",
  store_closed_unexpectedly: "Store closed unexpectedly",
  other: "Other",
};

// ── Sub-components ─────────────────────────────────────────────────────────────

function SummaryRow({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: "warning" | "ok";
}) {
  const textClass =
    highlight === "warning"
      ? "text-amber-700 font-semibold"
      : highlight === "ok"
      ? "text-emerald-700 font-semibold"
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

// ── Main Component ─────────────────────────────────────────────────────────────

export default function ApproveResolutionModal({
  open,
  onOpenChange,
  resolution,
  onDone,
}: Props) {
  const [approverNote, setApproverNote] = useState("");
  const [pendingAction, setPendingAction] = useState<"approve" | "reject" | null>(null);

  const difference = Number(resolution.difference);
  const hasDiscrepancy = Math.abs(difference) > 0.009;

  const qc = useQueryClient();

  const act = useMutation({
    mutationFn: ({ action }: { action: "approve" | "reject" }) =>
      apiFetch<{ status: string }>(
        action === "approve"
          ? "/api/cmc-pos/shifts/resolve/approve"
          : "/api/cmc-pos/shifts/resolve/reject",
        {
          method: "POST",
          body: JSON.stringify({
            resolutionId: resolution.id,
            approverNote: approverNote.trim() || null,
          }),
        },
      ),
    onSuccess: (_, { action }) => {
      qc.invalidateQueries({ queryKey: ["cmc-pos-active-shift"] });
      qc.invalidateQueries({ queryKey: ["cmc-pos-cash-drawer"] });
      qc.invalidateQueries({ queryKey: ["cmc-pos-cash-drawer-transactions"] });
      qc.invalidateQueries({ queryKey: ["cmc-pos-shifts"] });
      toast({
        title:
          action === "approve"
            ? "Resolution approved — session closed."
            : "Resolution rejected — session remains open for correction.",
      });
      setPendingAction(null);
      onDone();
      onOpenChange(false);
    },
    onError: (err: Error) => {
      setPendingAction(null);
      toast({ title: err.message || "Action failed", variant: "destructive" });
    },
  });

  function handleOpenChange(nextOpen: boolean) {
    if (act.isPending) return;
    if (!nextOpen) {
      setApproverNote("");
      setPendingAction(null);
      act.reset();
    }
    onOpenChange(nextOpen);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-md p-0 overflow-hidden"
        aria-labelledby="approve-resolution-title"
      >
        <DialogHeader className="px-5 pt-5 pb-3 border-b border-gray-100">
          <DialogTitle id="approve-resolution-title">Approve Resolution</DialogTitle>
        </DialogHeader>

        <div className="px-5 py-4 space-y-4">
          {/* Resolution summary */}
          <div className="rounded-lg border border-gray-200 bg-gray-50 px-4 py-3">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
              Resolution Details
            </p>
            {resolution.resolver_name && (
              <SummaryRow label="Submitted by" value={resolution.resolver_name} />
            )}
            <SummaryRow
              label="Submitted at"
              value={new Date(resolution.created_at).toLocaleString([], {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            />
            <SummaryRow
              label="Expected balance"
              value={fmtCurrency(Number(resolution.expected_balance), resolution.currency)}
            />
            <SummaryRow
              label="Counted balance"
              value={fmtCurrency(Number(resolution.counted_balance), resolution.currency)}
            />
            <SummaryRow
              label="Difference"
              value={`${difference > 0 ? "+" : ""}${fmtCurrency(difference, resolution.currency)}`}
              highlight={hasDiscrepancy ? "warning" : "ok"}
            />
            <SummaryRow
              label="Reason"
              value={REASON_LABELS[resolution.reason] ?? resolution.reason}
            />
            {resolution.note && <SummaryRow label="Note" value={resolution.note} />}
          </div>

          {/* Manager note */}
          <div className="space-y-1.5">
            <Label htmlFor="approver-note" className="text-xs">
              Manager note <span className="text-gray-400">(optional)</span>
            </Label>
            <Textarea
              id="approver-note"
              rows={2}
              className="text-sm resize-none"
              placeholder="Add context for the decision…"
              value={approverNote}
              onChange={(e) => setApproverNote(e.target.value)}
              disabled={act.isPending}
            />
          </div>

          {/* Inline error */}
          {act.isError && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2">
              <p className="text-xs text-red-700">
                {(act.error as Error)?.message || "Action failed. Please try again."}
              </p>
            </div>
          )}

          {/* Approve / Reject buttons */}
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="flex-1 border-red-200 text-red-700 hover:bg-red-50 hover:border-red-300"
              disabled={act.isPending}
              onClick={() => {
                setPendingAction("reject");
                act.mutate({ action: "reject" });
              }}
            >
              {act.isPending && pendingAction === "reject" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
              ) : (
                <XCircle className="h-3.5 w-3.5 mr-1.5" />
              )}
              Reject
            </Button>
            <Button
              size="sm"
              className="flex-1 text-white"
              style={{ background: "#00414e" }}
              disabled={act.isPending}
              onClick={() => {
                setPendingAction("approve");
                act.mutate({ action: "approve" });
              }}
            >
              {act.isPending && pendingAction === "approve" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
              ) : (
                <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />
              )}
              Approve
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
