import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useRoute } from "wouter";
import {
  ArrowLeft, CheckCircle2, Send, XCircle, Package,
  Loader2, Clock, AlertCircle, ArrowRight, User, RefreshCw, Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { apiFetch } from "@/lib/queryClient";
import { isPermissionError } from "@/lib/permissionError";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/hooks/use-toast";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";

// ── Types ─────────────────────────────────────────────────────────────────────

type LineItem = {
  id: number;
  product_id: number | null;
  name: string | null;
  requested_qty: number;
  accepted_qty: number | null;
  received_qty: number | null;
  unit_price: string | null;
  notes: string | null;
  image_url: string | null;
};

type RequestEvent = {
  id: number;
  actor_user_id: string | null;
  from_status: string | null;
  to_status: string;
  notes: string | null;
  created_at: string;
};

type BranchRequest = {
  id: string;
  status: string;
  priority: string;
  purpose: string;
  needed_by: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  destination_location_name: string | null;
  source_location_name: string | null;
  tookan_job_id: string | null;
  tookan_task_id: string | null;
  line_items: LineItem[] | null;
  events: RequestEvent[] | null;
};

// ── Status config ─────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<string, { label: string; classes: string }> = {
  draft:      { label: "Draft",      classes: "bg-gray-100 text-gray-600 border-gray-200" },
  submitted:  { label: "Submitted",  classes: "bg-blue-50 text-blue-700 border-blue-200" },
  accepted:   { label: "Approved",   classes: "bg-yellow-50 text-yellow-700 border-yellow-200" },
  dispatched: { label: "Dispatched", classes: "bg-orange-50 text-orange-700 border-orange-200" },
  received:   { label: "Delivered",  classes: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  cancelled:  { label: "Cancelled",  classes: "bg-red-50 text-red-600 border-red-200" },
};

const STATUS_FLOW = ["submitted", "dispatched", "received"];

// ── Helpers ───────────────────────────────────────────────────────────────────

function shortId(id: string) {
  return `BR-${id.slice(0, 4).toUpperCase()}`;
}

function formatTs(iso: string) {
  return new Date(iso).toLocaleString([], {
    month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  });
}

function actionLabel(from: string | null, to: string): string {
  if (!from) return `Request created (${to})`;
  const labels: Record<string, string> = {
    submitted: "Request submitted",
    accepted: "Request approved",
    dispatched: "Dispatched",
    received: "Delivered & received",
    cancelled: "Request cancelled",
  };
  return labels[to] ?? `Status changed to ${to}`;
}

// ── Status step bar ───────────────────────────────────────────────────────────

function StatusStepper({ status }: { status: string }) {
  if (status === "cancelled") {
    return (
      <div className="flex items-center gap-2 text-sm text-red-600">
        <XCircle className="h-4 w-4" /> Request cancelled
      </div>
    );
  }
  const current = STATUS_FLOW.indexOf(status);
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {STATUS_FLOW.map((s, i) => {
        const done = i <= current;
        const active = i === current;
        const conf = STATUS_CONFIG[s];
        return (
          <div key={s} className="flex items-center gap-1.5">
            <div className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium border ${
              done ? conf.classes : "bg-muted/40 text-muted-foreground border-muted"
            } ${active ? "ring-2 ring-offset-1 ring-teal-700/40" : ""}`}>
              {done && <CheckCircle2 className="h-3 w-3" />}
              {conf.label}
            </div>
            {i < STATUS_FLOW.length - 1 && (
              <ArrowRight className={`h-3 w-3 shrink-0 ${done && i < current ? "text-teal-700" : "text-muted-foreground/40"}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function CmcPosRequestDetail() {
  const { t } = useTranslation();
  const [, params] = useRoute("/cmc-pos/request/:id");
  const id = params?.id ?? "";
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const { allowedPages, isOwner } = useWorkspaceRole();
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  const canDispatch = isOwner || (allowedPages?.includes("cmc_pos.dispatch_request") ?? false);
  const canReceive = isOwner || (allowedPages?.includes("cmc_pos.receive_request") ?? false);
  const canCancel = isOwner || (allowedPages?.includes("cmc_pos.create_request") ?? false);
  const canDelete = isOwner || (allowedPages?.includes("cmc_pos.delete_request") ?? false);

  const { data, isLoading, isError } = useQuery<{ request: BranchRequest }>({
    queryKey: ["cmc-pos-request", id],
    queryFn: () => apiFetch<{ request: BranchRequest }>(`/api/cmc-pos/requests/${id}`, {}),
    enabled: !!id,
  });

  const actionMutation = useMutation({
    mutationFn: ({ action, notes }: { action: string; notes?: string }) =>
      apiFetch<{ request: unknown; tookan_error?: string }>(`/api/cmc-pos/requests/${id}/${action}`, {
        method: "POST",
        body: notes ? JSON.stringify({ notes }) : undefined,
      }),
    onSuccess: (data, { action }) => {
      const msgs: Record<string, string> = {
        accept: "Request approved",
        dispatch: "Request dispatched",
        receive: "Delivery confirmed",
        cancel: "Request cancelled",
        submit: "Request submitted",
      };
      if (action === "submit" && data?.tookan_error) {
        // The request was submitted but the courier task couldn't be created —
        // surface the actionable reason; the Retry button remains available.
        toast({
          title: "Submitted, but dispatch task failed",
          description: data.tookan_error,
          variant: "destructive",
        });
      } else {
        toast({ title: msgs[action] ?? "Done" });
      }
      qc.invalidateQueries({ queryKey: ["cmc-pos-request", id] });
      qc.invalidateQueries({ queryKey: ["cmc-pos-requests"] });
      qc.invalidateQueries({ queryKey: ["cmc-pos-request-metrics"] });
    },
    onError: (err) => {
      if (isPermissionError(err)) {
        toast({ title: t("cmcPos.noPermission"), description: t("cmcPos.noPermissionDesc"), variant: "destructive" });
        return;
      }
      toast({ title: "Action failed", description: String(err), variant: "destructive" });
    },
  });

  const retryTookanMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/cmc-pos/requests/${id}/retry-tookan`, { method: "POST" }),
    onSuccess: () => {
      toast({ title: "Tookan task created" });
      qc.invalidateQueries({ queryKey: ["cmc-pos-request", id] });
    },
    onError: (err) => {
      if (isPermissionError(err)) {
        toast({ title: t("cmcPos.noPermission"), description: t("cmcPos.noPermissionDesc"), variant: "destructive" });
        return;
      }
      toast({ title: "Retry failed", description: err instanceof Error ? err.message : String(err), variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/cmc-pos/requests/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast({ title: "Request deleted" });
      qc.invalidateQueries({ queryKey: ["cmc-pos-requests"] });
      qc.invalidateQueries({ queryKey: ["cmc-pos-request-metrics"] });
      navigate("/cmc-pos/location-requests");
    },
    onError: (err) => {
      if (isPermissionError(err)) {
        toast({ title: t("cmcPos.noPermission"), description: t("cmcPos.noPermissionDesc"), variant: "destructive" });
        return;
      }
      toast({ title: "Delete failed", description: String(err), variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-64">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (isError || !data?.request) {
    return (
      <div className="p-6 text-center">
        <AlertCircle className="h-8 w-8 text-destructive mx-auto mb-2" />
        <p className="text-sm text-muted-foreground">Request not found or failed to load.</p>
        <Button variant="outline" size="sm" className="mt-4" asChild>
          <Link href="/cmc-pos/location-requests">Back to requests</Link>
        </Button>
      </div>
    );
  }

  const req = data.request;
  const items = req.line_items ?? [];
  const events = (req.events ?? []).slice().reverse();
  const statusConf = STATUS_CONFIG[req.status] ?? { label: req.status, classes: "bg-gray-100 text-gray-600 border-gray-200" };
  const estimatedValue = items.reduce((s, li) => s + (parseFloat(li.unit_price ?? "0") * li.requested_qty), 0);
  const isPending = actionMutation.isPending;

  // Available actions based on status + permissions
  const actions: { label: string; action: string; icon: React.ElementType; variant?: "destructive" | "outline" | "default"; primary?: boolean }[] = [
    ...(req.status === "draft" ? [
      { label: "Submit", action: "submit", icon: Send, primary: true },
    ] : []),
    ...(req.status === "submitted" && canDispatch ? [
      { label: "Mark as dispatched", action: "dispatch", icon: Send, primary: true },
    ] : []),
    ...(req.status === "dispatched" && canReceive ? [
      { label: "Confirm delivery", action: "receive", icon: CheckCircle2, primary: true },
    ] : []),
    ...(["draft", "submitted"].includes(req.status) && canCancel ? [
      { label: "Cancel request", action: "cancel", icon: XCircle, variant: "outline" as const },
    ] : []),
  ];

  return (
    <div className="flex flex-col min-h-full">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-4 border-b">
        <Button variant="ghost" size="icon" className="h-9 w-9 shrink-0" asChild>
          <Link href="/cmc-pos/location-requests">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div className="flex-1 min-w-0">
          <p className="text-xs text-muted-foreground">
            <Link href="/cmc-pos/location-requests" className="hover:underline">Branch Requests</Link>
          </p>
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-base font-semibold">{shortId(req.id)}</h1>
            <Badge variant="outline" className={`text-xs font-medium ${statusConf.classes}`}>
              {statusConf.label}
            </Badge>
            {req.priority === "urgent" && (
              <Badge variant="outline" className="bg-orange-50 text-orange-700 border-orange-200 text-xs">
                Urgent
              </Badge>
            )}
          </div>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2 shrink-0">
          {/* Tookan status — shown only when request is still active */}
          {["submitted", "dispatched"].includes(req.status) && (isOwner || (allowedPages?.includes("cmc_pos.dispatch_request") ?? false)) && (
            req.tookan_job_id === null ? (
              // Creation failed and sentinel was released — safe to retry
              <Button
                size="sm"
                variant="outline"
                disabled={retryTookanMutation.isPending || isPending}
                onClick={() => retryTookanMutation.mutate()}
              >
                {retryTookanMutation.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
                ) : (
                  <RefreshCw className="h-4 w-4 mr-1.5" />
                )}
                Retry Tookan
              </Button>
            ) : req.tookan_job_id === "pending" ? (
              // Slot is claimed — in progress or needs manual resolution
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground px-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Tookan pending…
              </span>
            ) : null
          )}
          {actions.map((a) => (
            <Button
              key={a.action}
              size="sm"
              variant={a.primary ? "default" : a.variant ?? "outline"}
              className={a.primary ? "bg-teal-800 hover:bg-teal-900 text-white" : a.action === "cancel" ? "text-destructive border-destructive/30 hover:bg-red-50" : ""}
              disabled={isPending}
              onClick={() => actionMutation.mutate({ action: a.action })}
            >
              {isPending && actionMutation.variables?.action === a.action ? (
                <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
              ) : (
                <a.icon className="h-4 w-4 mr-1.5" />
              )}
              {a.label}
            </Button>
          ))}
          {/* Delete — available for delivered or cancelled requests */}
          {["received", "cancelled"].includes(req.status) && canDelete && (
            <Button
              size="sm"
              variant="outline"
              className="text-destructive border-destructive/30 hover:bg-red-50"
              disabled={deleteMutation.isPending}
              onClick={() => setDeleteConfirm(true)}
            >
              {deleteMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin mr-1.5" />
              ) : (
                <Trash2 className="h-4 w-4 mr-1.5" />
              )}
              Delete request
            </Button>
          )}
        </div>
      </div>

      {/* Delete confirmation dialog */}
      <AlertDialog open={deleteConfirm} onOpenChange={setDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete request?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete {shortId(req.id)} and all its line items. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => { setDeleteConfirm(false); deleteMutation.mutate(); }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <div className="flex-1 overflow-auto p-6 grid grid-cols-1 gap-6 lg:grid-cols-[1fr,320px]">
        {/* LEFT COLUMN */}
        <div className="space-y-6">
          {/* Status flow */}
          <div className="rounded-xl border p-4">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">
              Status
            </h3>
            <StatusStepper status={req.status} />
          </div>

          {/* Request details */}
          <div className="rounded-xl border p-4 space-y-3">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
              Request details
            </h3>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <p className="text-xs text-muted-foreground">Route</p>
                <div className="flex items-center gap-1.5 mt-0.5 font-medium">
                  <span>{req.source_location_name ?? "—"}</span>
                  <ArrowRight className="h-3 w-3 text-muted-foreground" />
                  <span>{req.destination_location_name ?? "—"}</span>
                </div>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Purpose</p>
                <p className="mt-0.5 capitalize">{req.purpose.replace(/_/g, " ")}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Needed by</p>
                <p className="mt-0.5 flex items-center gap-1.5">
                  {req.needed_by ? (
                    <>
                      <Clock className="h-3.5 w-3.5 text-muted-foreground" />
                      {new Date(req.needed_by).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                    </>
                  ) : "—"}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Created</p>
                <p className="mt-0.5">{formatTs(req.created_at)}</p>
              </div>
            </div>
            {req.notes && (
              <div className="pt-2 border-t">
                <p className="text-xs text-muted-foreground mb-1">Notes</p>
                <p className="text-sm">{req.notes}</p>
              </div>
            )}
          </div>

          {/* Items table */}
          <div className="rounded-xl border overflow-hidden">
            <div className="px-4 py-3 border-b bg-muted/20">
              <h3 className="text-sm font-semibold">Items · {items.length}</h3>
            </div>
            {items.length === 0 ? (
              <div className="py-8 text-center">
                <Package className="h-8 w-8 text-muted-foreground mx-auto mb-2 opacity-40" />
                <p className="text-sm text-muted-foreground">No items</p>
              </div>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/10">
                    <th className="text-left py-2 px-4 text-xs font-medium text-muted-foreground">Product</th>
                    <th className="text-center py-2 px-4 text-xs font-medium text-muted-foreground">Requested</th>
                    <th className="text-center py-2 px-4 text-xs font-medium text-muted-foreground">Accepted</th>
                    <th className="text-right py-2 px-4 text-xs font-medium text-muted-foreground">Unit price</th>
                    <th className="text-right py-2 px-4 text-xs font-medium text-muted-foreground">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((li) => {
                    const lineTotal = (parseFloat(li.unit_price ?? "0") * li.requested_qty).toFixed(2);
                    return (
                      <tr key={li.id} className="border-b last:border-0 hover:bg-muted/20">
                        <td className="py-3 px-4">
                          <div className="flex items-center gap-2">
                            {li.image_url ? (
                              <img src={li.image_url} alt="" className="h-8 w-8 rounded object-cover border shrink-0" />
                            ) : (
                              <div className="h-8 w-8 rounded border bg-muted shrink-0 flex items-center justify-center">
                                <Package className="h-4 w-4 text-muted-foreground opacity-40" />
                              </div>
                            )}
                            <span className="font-medium">{li.name ?? `Product #${li.product_id}`}</span>
                          </div>
                        </td>
                        <td className="py-3 px-4 text-center">{li.requested_qty}</td>
                        <td className="py-3 px-4 text-center text-muted-foreground">
                          {li.accepted_qty ?? "—"}
                        </td>
                        <td className="py-3 px-4 text-right text-muted-foreground">
                          {li.unit_price ? `$${parseFloat(li.unit_price).toFixed(2)}` : "—"}
                        </td>
                        <td className="py-3 px-4 text-right font-medium">
                          {li.unit_price ? `$${lineTotal}` : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                {estimatedValue > 0 && (
                  <tfoot>
                    <tr className="border-t bg-muted/10">
                      <td colSpan={4} className="py-2.5 px-4 text-right text-xs font-medium text-muted-foreground">
                        Estimated total
                      </td>
                      <td className="py-2.5 px-4 text-right font-semibold">
                        ${estimatedValue.toFixed(2)}
                      </td>
                    </tr>
                  </tfoot>
                )}
              </table>
            )}
          </div>
        </div>

        {/* RIGHT COLUMN — activity */}
        <div className="space-y-4">
          <div className="rounded-xl border overflow-hidden">
            <div className="px-4 py-3 border-b bg-muted/20">
              <h3 className="text-sm font-semibold">Activity</h3>
            </div>
            {events.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">No activity yet</p>
            ) : (
              <div className="divide-y">
                {events.map((e) => (
                  <div key={e.id} className="px-4 py-3 flex gap-3">
                    <div className="h-7 w-7 rounded-full bg-muted flex items-center justify-center shrink-0 mt-0.5">
                      <User className="h-3.5 w-3.5 text-muted-foreground" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium">{actionLabel(e.from_status, e.to_status)}</p>
                      {e.notes && (
                        <p className="text-xs text-muted-foreground mt-0.5">{e.notes}</p>
                      )}
                      <p className="text-xs text-muted-foreground mt-0.5">{formatTs(e.created_at)}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
