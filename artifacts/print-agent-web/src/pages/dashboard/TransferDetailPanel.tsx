import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useParams } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeftRight,
  X,
  Loader2,
  CheckCircle2,
  Clock,
  AlertTriangle,
  RotateCcw,
  ExternalLink,
  ArrowRight,
  ArrowLeft,
} from "lucide-react";
import { apiFetch } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { formatCashMoney } from "@/lib/cashMoney";
import { formatDateTime } from "@/lib/cashSessionsDashboard";
import { transferMethodLabel } from "./TransferCashModal";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { useToast } from "@/hooks/use-toast";

// ---------------------------------------------------------------------------
// Types — aligned with GET /api/cash-transfers/:transferId
//
// The API returns { transfer: TransferDbRow, auditEvents: AuditEvent[] }.
// ---------------------------------------------------------------------------

export type AuditEvent = {
  id: number;
  cash_transfer_id: number;
  event_type: string;
  actor_user_id: string | null;
  actor_name: string | null;
  payload: string | null; // JSON string
  created_at: string;
};

export type TransferDbRow = {
  id: number;
  transfer_number: string;
  status: "IN_TRANSIT" | "COMPLETED" | "DISPUTED" | "RETURNED";
  /** ISO 4217 code */
  currency_code: string;
  sent_amount: string;
  received_amount: string | null;
  difference_amount: string | null;
  source_session_id: number | null;
  source_drawer_id: number | null;
  source_drawer_name: string | null;
  source_location_id: number | null;
  source_location_name: string | null;
  destination_session_id: number | null;
  destination_drawer_id: number | null;
  destination_drawer_name: string | null;
  destination_location_id: number | null;
  destination_location_name: string | null;
  initiated_by_user_id: string | null;
  handed_over_by_user_id: string | null;
  intended_receiver_user_id: string | null;
  received_by_user_id: string | null;
  transfer_method: string | null;
  carrier_type: string | null;
  carrier_user_id: string | null;
  external_carrier_name: string | null;
  note: string | null;
  handed_over_at: string | null;
  received_at: string | null;
  created_at: string;
  updated_at: string;
};

export type TransferDetailResponse = {
  transfer: TransferDbRow;
  auditEvents: AuditEvent[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function transferStatusLabel(status: string): string {
  switch (status) {
    case "IN_TRANSIT": return "In transit";
    case "COMPLETED": return "Completed";
    case "DISPUTED": return "Disputed";
    case "RETURNED": return "Returned";
    default: return status;
  }
}

export function transferStatusClass(status: string): string {
  switch (status) {
    case "IN_TRANSIT":
      return "bg-blue-50 text-blue-700 border-blue-200";
    case "COMPLETED":
      return "bg-teal-50 text-teal-700 border-teal-200";
    case "DISPUTED":
      return "bg-red-50 text-red-700 border-red-200";
    case "RETURNED":
      return "bg-gray-100 text-gray-600 border-gray-200";
    default:
      return "bg-muted text-muted-foreground border-transparent";
  }
}

function timelineIcon(eventType: string) {
  if (eventType === "received" || eventType === "completed")
    return <CheckCircle2 className="h-4 w-4 text-teal-600" />;
  if (eventType === "disputed")
    return <AlertTriangle className="h-4 w-4 text-red-500" />;
  if (eventType === "returned")
    return <RotateCcw className="h-4 w-4 text-gray-500" />;
  if (eventType === "resolved")
    return <CheckCircle2 className="h-4 w-4 text-emerald-600" />;
  return <Clock className="h-4 w-4 text-blue-500" />;
}

function timelineLabel(eventType: string): string {
  switch (eventType) {
    case "initiated": return "Transfer initiated";
    case "dispatched": return "Dispatched";
    case "received": return "Receipt confirmed";
    case "completed": return "Completed";
    case "disputed": return "Dispute raised";
    case "returned": return "Returned to source";
    case "resolved": return "Dispute resolved";
    default: return eventType.replace(/_/g, " ");
  }
}

function carrierDisplay(t: TransferDbRow): string | null {
  if (t.external_carrier_name) return t.external_carrier_name;
  if (t.carrier_user_id) return "Internal carrier";
  return null;
}

// ---------------------------------------------------------------------------
// Detail content (shared between panel and page)
// ---------------------------------------------------------------------------

function DetailField({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="text-sm">{value ?? <span className="text-muted-foreground">—</span>}</div>
    </div>
  );
}

function SessionLink({
  sessionId,
  drawerName,
  locationName,
  navigate,
}: {
  sessionId: number | null;
  drawerName: string | null;
  locationName: string | null;
  navigate: (path: string) => void;
}) {
  if (!sessionId) return <span className="text-muted-foreground">—</span>;
  const label = [drawerName, locationName].filter(Boolean).join(" · ") || `Session #${sessionId}`;
  return (
    <button
      className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline"
      onClick={() => navigate(`/cash-sessions/${sessionId}`)}
    >
      {label}
      <ExternalLink className="h-3 w-3" />
    </button>
  );
}

function TransferDetailContent({
  data,
  onConfirmReceipt,
  onResolveDispute,
  onReportDifference,
  isActioning,
}: {
  data: TransferDetailResponse;
  onConfirmReceipt?: () => void;
  onResolveDispute?: () => void;
  onReportDifference?: () => void;
  isActioning?: boolean;
}) {
  const [, navigate] = useLocation();
  const { isOwner, allowedPages } = useWorkspaceRole();
  const can = (perm: string) => isOwner || (allowedPages?.includes(perm) ?? false);

  const { transfer, auditEvents } = data;
  const diff = transfer.difference_amount != null ? Number(transfer.difference_amount) : null;

  return (
    <div className="flex flex-col gap-6 pb-8">
      {/* Header — ID + status + amount */}
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground font-mono">#{transfer.transfer_number}</p>
        <div className="flex items-center gap-2 flex-wrap">
          <Badge
            variant="outline"
            className={cn("text-xs", transferStatusClass(transfer.status))}
          >
            {transfer.status === "DISPUTED" && <AlertTriangle className="mr-1 h-3 w-3" />}
            {transferStatusLabel(transfer.status)}
          </Badge>
        </div>
        <p className="text-3xl font-bold">
          {formatCashMoney(transfer.sent_amount, transfer.currency_code)}
        </p>
      </div>

      {/* Route */}
      <div>
        <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Route</p>
        <div className="flex items-center gap-3 rounded-lg border px-3 py-2.5 text-sm">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted-foreground mb-0.5">Source</p>
            <SessionLink
              sessionId={transfer.source_session_id}
              drawerName={transfer.source_drawer_name}
              locationName={transfer.source_location_name}
              navigate={navigate}
            />
          </div>
          <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1 text-right">
            <p className="text-xs text-muted-foreground mb-0.5">Destination</p>
            <SessionLink
              sessionId={transfer.destination_session_id}
              drawerName={transfer.destination_drawer_name}
              locationName={transfer.destination_location_name}
              navigate={navigate}
            />
          </div>
        </div>
      </div>

      {/* Sent / Received / Difference (only when we have receipt data) */}
      {(transfer.received_amount != null || transfer.difference_amount != null) && (
        <div className="grid grid-cols-3 gap-3 rounded-lg border p-3">
          <div className="space-y-0.5">
            <p className="text-xs text-muted-foreground">Sent</p>
            <p className="text-sm font-medium">{formatCashMoney(transfer.sent_amount, transfer.currency_code)}</p>
          </div>
          <div className="space-y-0.5">
            <p className="text-xs text-muted-foreground">Received</p>
            <p className="text-sm font-medium">{formatCashMoney(transfer.received_amount, transfer.currency_code)}</p>
          </div>
          <div className="space-y-0.5">
            <p className="text-xs text-muted-foreground">Difference</p>
            <p
              className={cn(
                "text-sm font-medium",
                diff != null && diff < 0 && "text-red-600",
                diff != null && diff > 0 && "text-amber-600",
                diff === 0 && "text-emerald-600",
              )}
            >
              {formatCashMoney(transfer.difference_amount, transfer.currency_code, { signed: true })}
            </p>
          </div>
        </div>
      )}

      {/* Transfer method */}
      {transfer.transfer_method && (
        <DetailField
          label="Transfer method"
          value={transferMethodLabel(transfer.transfer_method)}
        />
      )}

      {/* People */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-3">
        <DetailField
          label="Carrier"
          value={carrierDisplay(transfer)}
        />
        <DetailField
          label="Carrier type"
          value={transfer.carrier_type}
        />
        <DetailField
          label="Intended receiver"
          value={transfer.intended_receiver_user_id ? "Assigned member" : null}
        />
        <DetailField
          label="Actual receiver"
          value={transfer.received_by_user_id ? "Confirmed member" : null}
        />
      </div>

      {/* Timestamps */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-3">
        <DetailField label="Handed over" value={formatDateTime(transfer.handed_over_at)} />
        <DetailField label="Received" value={formatDateTime(transfer.received_at)} />
      </div>

      {/* Notes */}
      {transfer.note && (
        <DetailField
          label="Notes"
          value={<p className="whitespace-pre-wrap text-sm">{transfer.note}</p>}
        />
      )}

      {/* Timeline */}
      {auditEvents.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Timeline
          </p>
          <ol className="relative ml-2 space-y-0 border-l border-muted">
            {auditEvents.map((ev) => {
              let payloadDetail: string | null = null;
              try {
                const parsed = JSON.parse(ev.payload ?? "{}");
                if (parsed.amount && parsed.currency) {
                  payloadDetail = `${parsed.currency} ${parsed.amount}`;
                }
              } catch {
                // ignore
              }
              return (
                <li key={ev.id} className="ml-4 pb-4">
                  <span className="absolute -left-[9px] flex h-4 w-4 items-center justify-center rounded-full bg-background">
                    {timelineIcon(ev.event_type)}
                  </span>
                  <p className="text-sm font-medium leading-tight">{timelineLabel(ev.event_type)}</p>
                  {ev.actor_name && (
                    <p className="text-xs text-muted-foreground">by {ev.actor_name}</p>
                  )}
                  {payloadDetail && (
                    <p className="text-xs text-muted-foreground">{payloadDetail}</p>
                  )}
                  <p className="text-xs text-muted-foreground">{formatDateTime(ev.created_at)}</p>
                </li>
              );
            })}
          </ol>
        </div>
      )}

      {/* Actions */}
      {(onConfirmReceipt || onResolveDispute || onReportDifference) && (
        <div className="flex flex-col gap-2 border-t pt-4">
          {transfer.status === "IN_TRANSIT" && can("cash_sessions.receive_transfer") && onConfirmReceipt && (
            <Button onClick={onConfirmReceipt} disabled={isActioning} className="w-full gap-1.5">
              {isActioning ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="h-4 w-4" />
              )}
              Confirm receipt
            </Button>
          )}
          {transfer.status === "IN_TRANSIT" && can("cash_sessions.receive_transfer") && onReportDifference && (
            <Button
              variant="outline"
              onClick={onReportDifference}
              disabled={isActioning}
              className="w-full gap-1.5"
            >
              <AlertTriangle className="h-4 w-4" />
              Report a difference
            </Button>
          )}
          {transfer.status === "DISPUTED" && can("cash_sessions.resolve_transfer_dispute") && onResolveDispute && (
            <Button
              variant="outline"
              onClick={onResolveDispute}
              disabled={isActioning}
              className="w-full gap-1.5 border-red-200 text-red-700 hover:bg-red-50"
            >
              {isActioning ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <AlertTriangle className="h-4 w-4" />
              )}
              Resolve dispute
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Side panel (Sheet)
// ---------------------------------------------------------------------------

export type TransferDetailPanelProps = {
  transferId: number | null;
  open: boolean;
  onClose: () => void;
};

export function TransferDetailPanel({ transferId, open, onClose }: TransferDetailPanelProps) {
  const qc = useQueryClient();
  const { toast } = useToast();

  // Resolve dispute form state
  const [resolveOpen, setResolveOpen] = useState(false);
  const [resolveReason, setResolveReason] = useState("");
  const [resolveNote, setResolveNote] = useState("");

  // Report difference form state
  const [reportOpen, setReportOpen] = useState(false);
  const [reportAmount, setReportAmount] = useState("");
  const [reportExplanation, setReportExplanation] = useState("");

  const { data, isLoading, isError } = useQuery<TransferDetailResponse>({
    queryKey: ["cash-transfer", transferId],
    queryFn: () => apiFetch(`/api/cash-transfers/${transferId}`),
    enabled: open && transferId != null,
  });

  const confirmMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/cash-transfers/${transferId}/confirm-receipt`, { method: "POST", body: "{}" }),
    onSuccess: () => {
      toast({ title: "Transfer receipt confirmed" });
      void qc.invalidateQueries({ queryKey: ["cash-transfer", transferId] });
      void qc.invalidateQueries({ queryKey: ["cash-transfers"] });
    },
    onError: (err: Error) => toast({ title: err.message || "Failed to confirm receipt", variant: "destructive" }),
  });

  const resolveMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/cash-transfers/${transferId}/resolve-dispute`, {
        method: "POST",
        body: JSON.stringify({
          resolution_reason: resolveReason.trim(),
          resolution_note: resolveNote.trim() || null,
        }),
      }),
    onSuccess: () => {
      toast({ title: "Dispute resolved" });
      setResolveOpen(false);
      setResolveReason("");
      setResolveNote("");
      void qc.invalidateQueries({ queryKey: ["cash-transfer", transferId] });
      void qc.invalidateQueries({ queryKey: ["cash-transfers"] });
    },
    onError: (err: Error) => toast({ title: err.message || "Failed to resolve dispute", variant: "destructive" }),
  });

  const reportMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/cash-transfers/${transferId}/report-difference`, {
        method: "POST",
        body: JSON.stringify({
          actual_received_amount: parseFloat(reportAmount) || 0,
          explanation: reportExplanation.trim(),
        }),
      }),
    onSuccess: () => {
      toast({ title: "Difference reported. A supervisor will review the dispute." });
      setReportOpen(false);
      setReportAmount("");
      setReportExplanation("");
      void qc.invalidateQueries({ queryKey: ["cash-transfer", transferId] });
      void qc.invalidateQueries({ queryKey: ["cash-transfers"] });
    },
    onError: (err: Error) => toast({ title: err.message || "Failed to report difference", variant: "destructive" }),
  });

  return (
    <>
      <Sheet open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
        <SheetContent side="right" className="w-full max-w-lg overflow-y-auto p-0 sm:max-w-lg">
          <SheetHeader className="sticky top-0 z-10 border-b bg-background px-5 py-4">
            <div className="flex items-center justify-between">
              <SheetTitle className="flex items-center gap-2 text-base font-semibold">
                <ArrowLeftRight className="h-4 w-4" /> Transfer details
              </SheetTitle>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onClose}>
                <X className="h-4 w-4" />
              </Button>
            </div>
          </SheetHeader>

          <div className="px-5 pt-5">
            {isLoading && (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            )}
            {isError && (
              <p className="py-10 text-center text-sm text-muted-foreground">
                Failed to load transfer details.
              </p>
            )}
            {data && (
              <TransferDetailContent
                data={data}
                onConfirmReceipt={() => confirmMutation.mutate()}
                onResolveDispute={() => setResolveOpen(true)}
                onReportDifference={() => {
                  setReportAmount(data.transfer.sent_amount);
                  setReportOpen(true);
                }}
                isActioning={confirmMutation.isPending || resolveMutation.isPending || reportMutation.isPending}
              />
            )}
          </div>
        </SheetContent>
      </Sheet>

      {/* Resolve dispute dialog */}
      <Dialog open={resolveOpen} onOpenChange={(v) => !v && setResolveOpen(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Resolve Dispute</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>
                Resolution reason{" "}
                <span className="text-xs font-normal text-muted-foreground">(required)</span>
              </Label>
              <Textarea
                value={resolveReason}
                onChange={(e) => setResolveReason(e.target.value)}
                rows={3}
                placeholder="Explain how the dispute was resolved…"
              />
            </div>
            <div className="space-y-1.5">
              <Label>
                Additional note{" "}
                <span className="text-xs font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Textarea
                value={resolveNote}
                onChange={(e) => setResolveNote(e.target.value)}
                rows={2}
                placeholder="Any additional context…"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResolveOpen(false)}>Cancel</Button>
            <Button
              disabled={!resolveReason.trim() || resolveMutation.isPending}
              onClick={() => resolveMutation.mutate()}
              className="gap-1.5 border-red-200 text-red-700 hover:bg-red-50"
              variant="outline"
            >
              {resolveMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Resolve dispute
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Report difference dialog */}
      <Dialog open={reportOpen} onOpenChange={(v) => !v && setReportOpen(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Report a Difference</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>
                Actual amount received{data ? ` (${data.transfer.currency_code})` : ""}
              </Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={reportAmount}
                onChange={(e) => setReportAmount(e.target.value)}
              />
            </div>
            {parseFloat(reportAmount) > 0 && data && (
              <div
                className={cn(
                  "flex items-center justify-between rounded-md border px-3 py-2 text-sm font-semibold",
                  parseFloat(reportAmount) - Number(data.transfer.sent_amount) === 0
                    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                    : parseFloat(reportAmount) - Number(data.transfer.sent_amount) < 0
                      ? "border-red-200 bg-red-50 text-red-700"
                      : "border-amber-200 bg-amber-50 text-amber-700",
                )}
              >
                <span>Difference</span>
                <span>
                  {parseFloat(reportAmount) - Number(data.transfer.sent_amount) >= 0 ? "+" : ""}
                  {formatCashMoney(
                    parseFloat(reportAmount) - Number(data.transfer.sent_amount),
                    data.transfer.currency_code,
                  )}
                </span>
              </div>
            )}
            <div className="space-y-1.5">
              <Label>
                Explanation{" "}
                <span className="text-xs font-normal text-muted-foreground">(required)</span>
              </Label>
              <Textarea
                value={reportExplanation}
                onChange={(e) => setReportExplanation(e.target.value)}
                rows={3}
                placeholder="Describe the discrepancy…"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReportOpen(false)}>Cancel</Button>
            <Button
              disabled={!(parseFloat(reportAmount) > 0) || !reportExplanation.trim() || reportMutation.isPending}
              onClick={() => reportMutation.mutate()}
              variant="destructive"
            >
              {reportMutation.isPending && <Loader2 className="me-1.5 h-4 w-4 animate-spin" />}
              Report difference
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// Standalone page (/cash-transfers/:id)
// ---------------------------------------------------------------------------

export function TransferDetailPage() {
  const [, navigate] = useLocation();
  const params = useParams<{ id: string }>();
  const qc = useQueryClient();
  const { toast } = useToast();
  const transferId = parseInt(params.id ?? "", 10);

  // Resolve dispute form state
  const [resolveOpen, setResolveOpen] = useState(false);
  const [resolveReason, setResolveReason] = useState("");
  const [resolveNote, setResolveNote] = useState("");

  // Report difference form state
  const [reportOpen, setReportOpen] = useState(false);
  const [reportAmount, setReportAmount] = useState("");
  const [reportExplanation, setReportExplanation] = useState("");

  const { data, isLoading, isError } = useQuery<TransferDetailResponse>({
    queryKey: ["cash-transfer", transferId],
    queryFn: () => apiFetch(`/api/cash-transfers/${transferId}`),
    enabled: Number.isFinite(transferId),
  });

  const confirmMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/cash-transfers/${transferId}/confirm-receipt`, { method: "POST", body: "{}" }),
    onSuccess: () => {
      toast({ title: "Transfer receipt confirmed" });
      void qc.invalidateQueries({ queryKey: ["cash-transfer", transferId] });
      void qc.invalidateQueries({ queryKey: ["cash-transfers"] });
    },
    onError: (err: Error) => toast({ title: err.message || "Failed to confirm receipt", variant: "destructive" }),
  });

  const resolveMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/cash-transfers/${transferId}/resolve-dispute`, {
        method: "POST",
        body: JSON.stringify({
          resolution_reason: resolveReason.trim(),
          resolution_note: resolveNote.trim() || null,
        }),
      }),
    onSuccess: () => {
      toast({ title: "Dispute resolved" });
      setResolveOpen(false);
      setResolveReason("");
      setResolveNote("");
      void qc.invalidateQueries({ queryKey: ["cash-transfer", transferId] });
      void qc.invalidateQueries({ queryKey: ["cash-transfers"] });
    },
    onError: (err: Error) => toast({ title: err.message || "Failed to resolve dispute", variant: "destructive" }),
  });

  const reportMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/cash-transfers/${transferId}/report-difference`, {
        method: "POST",
        body: JSON.stringify({
          actual_received_amount: parseFloat(reportAmount) || 0,
          explanation: reportExplanation.trim(),
        }),
      }),
    onSuccess: () => {
      toast({ title: "Difference reported. A supervisor will review the dispute." });
      setReportOpen(false);
      setReportAmount("");
      setReportExplanation("");
      void qc.invalidateQueries({ queryKey: ["cash-transfer", transferId] });
      void qc.invalidateQueries({ queryKey: ["cash-transfers"] });
    },
    onError: (err: Error) => toast({ title: err.message || "Failed to report difference", variant: "destructive" }),
  });

  return (
    <>
      <div className="space-y-5 p-4 md:p-6">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => navigate("/cash-transfers")}
            className="gap-1.5"
          >
            <ArrowLeft className="h-4 w-4" /> Cash Transfers
          </Button>
          <span className="text-muted-foreground">/</span>
          <span className="text-sm font-medium">
            {data ? `#${data.transfer.transfer_number}` : "Transfer"}
          </span>
        </div>

        {isLoading && (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        )}
        {isError && (
          <p className="py-10 text-center text-sm text-muted-foreground">
            Failed to load transfer details.
          </p>
        )}
        {data && (
          <div className="mx-auto max-w-2xl">
            <TransferDetailContent
              data={data}
              onConfirmReceipt={() => confirmMutation.mutate()}
              onResolveDispute={() => setResolveOpen(true)}
              onReportDifference={() => {
                setReportAmount(data.transfer.sent_amount);
                setReportOpen(true);
              }}
              isActioning={confirmMutation.isPending || resolveMutation.isPending || reportMutation.isPending}
            />
          </div>
        )}
      </div>

      {/* Resolve dispute dialog */}
      <Dialog open={resolveOpen} onOpenChange={(v) => !v && setResolveOpen(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Resolve Dispute</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>
                Resolution reason{" "}
                <span className="text-xs font-normal text-muted-foreground">(required)</span>
              </Label>
              <Textarea
                value={resolveReason}
                onChange={(e) => setResolveReason(e.target.value)}
                rows={3}
                placeholder="Explain how the dispute was resolved…"
              />
            </div>
            <div className="space-y-1.5">
              <Label>
                Additional note{" "}
                <span className="text-xs font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Textarea
                value={resolveNote}
                onChange={(e) => setResolveNote(e.target.value)}
                rows={2}
                placeholder="Any additional context…"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResolveOpen(false)}>Cancel</Button>
            <Button
              disabled={!resolveReason.trim() || resolveMutation.isPending}
              onClick={() => resolveMutation.mutate()}
              className="gap-1.5 border-red-200 text-red-700 hover:bg-red-50"
              variant="outline"
            >
              {resolveMutation.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Resolve dispute
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Report difference dialog */}
      <Dialog open={reportOpen} onOpenChange={(v) => !v && setReportOpen(false)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Report a Difference</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>
                Actual amount received{data ? ` (${data.transfer.currency_code})` : ""}
              </Label>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={reportAmount}
                onChange={(e) => setReportAmount(e.target.value)}
              />
            </div>
            {parseFloat(reportAmount) > 0 && data && (
              <div
                className={cn(
                  "flex items-center justify-between rounded-md border px-3 py-2 text-sm font-semibold",
                  parseFloat(reportAmount) - Number(data.transfer.sent_amount) === 0
                    ? "border-emerald-200 bg-emerald-50 text-emerald-700"
                    : parseFloat(reportAmount) - Number(data.transfer.sent_amount) < 0
                      ? "border-red-200 bg-red-50 text-red-700"
                      : "border-amber-200 bg-amber-50 text-amber-700",
                )}
              >
                <span>Difference</span>
                <span>
                  {parseFloat(reportAmount) - Number(data.transfer.sent_amount) >= 0 ? "+" : ""}
                  {formatCashMoney(
                    parseFloat(reportAmount) - Number(data.transfer.sent_amount),
                    data.transfer.currency_code,
                  )}
                </span>
              </div>
            )}
            <div className="space-y-1.5">
              <Label>
                Explanation{" "}
                <span className="text-xs font-normal text-muted-foreground">(required)</span>
              </Label>
              <Textarea
                value={reportExplanation}
                onChange={(e) => setReportExplanation(e.target.value)}
                rows={3}
                placeholder="Describe the discrepancy…"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setReportOpen(false)}>Cancel</Button>
            <Button
              disabled={!(parseFloat(reportAmount) > 0) || !reportExplanation.trim() || reportMutation.isPending}
              onClick={() => reportMutation.mutate()}
              variant="destructive"
            >
              {reportMutation.isPending && <Loader2 className="me-1.5 h-4 w-4 animate-spin" />}
              Report difference
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
