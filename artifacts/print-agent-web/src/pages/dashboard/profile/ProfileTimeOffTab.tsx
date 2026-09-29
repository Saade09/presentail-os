import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  CalendarOff, Plane, Clock, Stethoscope, CheckCircle2, XCircle, AlertCircle,
  CalendarCheck,
} from "lucide-react";
import {
  useGetTimeOffBalance, useListTimeOffRequests, useCancelTimeOffRequest,
  useListMyPublicHolidays, getGetTimeOffBalanceQueryKey, getListTimeOffRequestsQueryKey,
} from "@workspace/api-client-react";
import type { TimeOffRequest, PublicHolidayItem } from "@workspace/api-client-react";
import { RequestTimeOffDialog } from "@/components/RequestTimeOffDialog";
import { cn } from "@/lib/utils";
import { Link } from "wouter";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import type { WorkingDaysConfig } from "./types";

function useCanManageTimeOffPolicies(): boolean {
  const { allowedPages, loaded } = useWorkspaceRole();
  if (!loaded) return false;
  if (allowedPages === null) return true;
  return allowedPages.includes("time-off.manage");
}

function formatDate(dateStr: string) {
  return new Date(String(dateStr).slice(0, 10) + "T00:00:00").toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function todayStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function statusBadge(status: string) {
  switch (status) {
    case "PENDING":
      return (
        <Badge variant="secondary" className="gap-1 text-amber-700 bg-amber-100 border-amber-200">
          <Clock size={11} /> Pending
        </Badge>
      );
    case "APPROVED":
      return (
        <Badge variant="secondary" className="gap-1 text-emerald-700 bg-emerald-100 border-emerald-200">
          <CheckCircle2 size={11} /> Approved
        </Badge>
      );
    case "DECLINED":
      return (
        <Badge variant="secondary" className="gap-1 text-destructive bg-destructive/10 border-destructive/20">
          <XCircle size={11} /> Declined
        </Badge>
      );
    case "CANCELLED":
      return (
        <Badge variant="secondary" className="gap-1 text-muted-foreground bg-muted border-border">
          <XCircle size={11} /> Cancelled
        </Badge>
      );
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

interface ProfileTimeOffTabProps {
  workingDays?: WorkingDaysConfig | null;
}

interface CancelModalState {
  request: TimeOffRequest;
  reason: string;
}

export function ProfileTimeOffTab({ workingDays }: ProfileTimeOffTabProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canManagePolicies = useCanManageTimeOffPolicies();
  const [showDialog, setShowDialog] = useState(false);
  const [filterYear, setFilterYear] = useState<number>(new Date().getFullYear());
  const [filterType, setFilterType] = useState<"" | "VACATION" | "SICK_LEAVE">("");
  const [cancelModal, setCancelModal] = useState<CancelModalState | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);
  const currentYear = new Date().getFullYear();
  const today = todayStr();

  const { data: balanceData, isLoading: balanceLoading } = useGetTimeOffBalance();
  const balance = balanceData?.balance ?? null;

  const { data: holidaysData } = useListMyPublicHolidays({ year: currentYear });
  const publicHolidays: PublicHolidayItem[] = (holidaysData?.holidays ?? []) as PublicHolidayItem[];

  const { data: requestsData, isLoading: requestsLoading } = useListTimeOffRequests({
    year: filterYear,
    type: (filterType as "VACATION" | "SICK_LEAVE") || undefined,
  });
  const requests = requestsData?.requests ?? [];

  const { mutateAsync: cancelRequest } = useCancelTimeOffRequest();

  const upcomingRequests = requests.filter(
    (r) => r.status === "APPROVED" && r.start_date > today,
  );
  const historyRequests = requests.filter(
    (r) => !(r.status === "APPROVED" && r.start_date > today),
  );

  async function handleCancelPending(req: TimeOffRequest) {
    try {
      await cancelRequest({ id: req.id });
      await queryClient.invalidateQueries({ queryKey: getGetTimeOffBalanceQueryKey() });
      await queryClient.invalidateQueries({ queryKey: getListTimeOffRequestsQueryKey() });
      toast({ title: "Request cancelled", description: "Your time-off request has been cancelled." });
    } catch {
      toast({ title: "Failed to cancel", description: "Could not cancel the request. Please try again.", variant: "destructive" });
    }
  }

  async function handleConfirmCancelApproved() {
    if (!cancelModal) return;
    setIsCancelling(true);
    try {
      await cancelRequest({
        id: cancelModal.request.id,
        data: { cancellation_reason: cancelModal.reason.trim() || null },
      });
      await queryClient.invalidateQueries({ queryKey: getGetTimeOffBalanceQueryKey() });
      await queryClient.invalidateQueries({ queryKey: getListTimeOffRequestsQueryKey() });
      toast({ title: "Request cancelled", description: "Your approved time-off has been cancelled and your balance restored." });
      setCancelModal(null);
    } catch {
      toast({ title: "Failed to cancel", description: "Could not cancel the request. Please try again.", variant: "destructive" });
    } finally {
      setIsCancelling(false);
    }
  }

  const yearOptions = [currentYear - 1, currentYear, currentYear + 1];

  const cancelModalReq = cancelModal?.request ?? null;
  const cancelImpactDays = cancelModalReq ? parseFloat(cancelModalReq.total_days) : 0;
  const cancelCurrentBalance =
    cancelModalReq?.type_code === "VACATION"
      ? (balance != null ? Number(balance.vacation_remaining) : null)
      : (balance != null ? Number(balance.sick_leave_used) : null);
  const cancelNewBalance =
    cancelModalReq?.type_code === "VACATION" && cancelCurrentBalance != null
      ? cancelCurrentBalance + cancelImpactDays
      : null;

  return (
    <div className="space-y-5">
      {balanceLoading ? (
        <div className="grid grid-cols-2 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-24 rounded-xl bg-muted animate-pulse" />
          ))}
        </div>
      ) : balance == null ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-10 gap-3 text-center">
            <CalendarOff size={28} className="text-muted-foreground" />
            <div className="space-y-1">
              <p className="font-medium text-sm">No time-off policy assigned</p>
              {canManagePolicies ? (
                <p className="text-xs text-muted-foreground max-w-xs">
                  No time-off policy is assigned yet. Assign one to start tracking leave balances.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground max-w-xs">
                  Ask your manager to assign a time-off policy before you can request leave.
                </p>
              )}
            </div>
            {canManagePolicies && (
              <Link href="/admin/time-off/policies">
                <Button size="sm" data-testid="assign-policy-btn">Assign a time-off policy</Button>
              </Link>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          <Card>
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-7 h-7 rounded-md bg-emerald-100 flex items-center justify-center">
                  <Plane size={14} className="text-emerald-700" />
                </div>
                <span className="text-sm font-medium text-muted-foreground">Vacation Remaining</span>
              </div>
              <p className="text-3xl font-bold">{Number(balance.vacation_remaining).toFixed(1)}</p>
              <p className="text-xs text-muted-foreground mt-0.5">of {Number(balance.vacation_entitled).toFixed(0)} entitled days</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-7 h-7 rounded-md bg-amber-100 flex items-center justify-center">
                  <Clock size={14} className="text-amber-700" />
                </div>
                <span className="text-sm font-medium text-muted-foreground">Vacation Pending</span>
              </div>
              <p className="text-3xl font-bold">{Number(balance.vacation_pending).toFixed(1)}</p>
              <p className="text-xs text-muted-foreground mt-0.5">awaiting approval</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-7 h-7 rounded-md bg-blue-100 flex items-center justify-center">
                  <Plane size={14} className="text-blue-700 rotate-180" />
                </div>
                <span className="text-sm font-medium text-muted-foreground">Vacation Used</span>
              </div>
              <p className="text-3xl font-bold">{Number(balance.vacation_used).toFixed(1)}</p>
              <p className="text-xs text-muted-foreground mt-0.5">days taken this year</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-7 h-7 rounded-md bg-rose-100 flex items-center justify-center">
                  <Stethoscope size={14} className="text-rose-700" />
                </div>
                <span className="text-sm font-medium text-muted-foreground">Sick Leave Used</span>
              </div>
              <p className="text-3xl font-bold">{Number(balance.sick_leave_used).toFixed(1)}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {balance.sick_leave_entitled != null
                  ? `of ${Number(balance.sick_leave_entitled).toFixed(0)} entitled`
                  : "no limit set"}
              </p>
            </CardContent>
          </Card>
          {Number(balance.vacation_carryover) > 0 && (
            <Card>
              <CardContent className="pt-4 pb-4">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-7 h-7 rounded-md bg-purple-100 flex items-center justify-center">
                    <CalendarCheck size={14} className="text-purple-700" />
                  </div>
                  <span className="text-sm font-medium text-muted-foreground">Carried Over</span>
                </div>
                <p className="text-3xl font-bold">{Number(balance.vacation_carryover).toFixed(1)}</p>
                <p className="text-xs text-muted-foreground mt-0.5">from last year</p>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      <div className="flex justify-end">
        <Button onClick={() => setShowDialog(true)} data-testid="request-time-off-btn">
          Request Time Off
        </Button>
      </div>

      {/* Upcoming Time Off section */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <CalendarCheck size={16} className="text-emerald-600" />
            Upcoming Time Off
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {requestsLoading ? (
            <div className="px-6 pb-6 space-y-3">
              {[1, 2].map((i) => <div key={i} className="h-10 rounded bg-muted animate-pulse" />)}
            </div>
          ) : upcomingRequests.length === 0 ? (
            <div className="px-6 pb-8 text-center">
              <p className="text-sm text-muted-foreground">No upcoming time off — approved future requests will appear here.</p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {upcomingRequests.map((req) => (
                <div key={req.id} className="flex items-center gap-3 px-6 py-3 hover:bg-muted/40 transition-colors">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium">{req.type_name}</span>
                      {statusBadge(req.status)}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {formatDate(req.start_date)}
                      {req.start_date !== req.end_date ? ` – ${formatDate(req.end_date)}` : ""}
                      {req.half_day && " (half day)"}
                      {" · "}
                      {Number(req.total_days).toFixed(1)} {Number(req.total_days) === 1 ? "day" : "days"}
                    </p>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 text-xs text-destructive border-destructive/30 hover:bg-destructive/5 hover:text-destructive px-2 shrink-0"
                    onClick={() => setCancelModal({ request: req, reason: "" })}
                    data-testid={`cancel-approved-request-${req.id}`}
                  >
                    Cancel Request
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Request History section */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <CardTitle className="text-base font-semibold">Request History</CardTitle>
            <div className="flex items-center gap-2">
              <select
                value={filterYear}
                onChange={(e) => setFilterYear(Number(e.target.value))}
                className="h-8 rounded-md border border-input bg-transparent px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              >
                {yearOptions.map((y) => <option key={y} value={y}>{y}</option>)}
              </select>
              <select
                value={filterType}
                onChange={(e) => setFilterType(e.target.value as "" | "VACATION" | "SICK_LEAVE")}
                className="h-8 rounded-md border border-input bg-transparent px-2 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="">All types</option>
                <option value="VACATION">Vacation</option>
                <option value="SICK_LEAVE">Sick Leave</option>
              </select>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {requestsLoading ? (
            <div className="px-6 pb-6 space-y-3">
              {[1, 2, 3].map((i) => <div key={i} className="h-10 rounded bg-muted animate-pulse" />)}
            </div>
          ) : historyRequests.length === 0 ? (
            <div className="px-6 pb-8 text-center">
              <AlertCircle size={20} className="text-muted-foreground mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">No requests found for this period.</p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {historyRequests.map((req) => (
                <div key={req.id} className="flex items-center gap-3 px-6 py-3 hover:bg-muted/40 transition-colors">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium">{req.type_name}</span>
                      {statusBadge(req.status)}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {formatDate(req.start_date)}
                      {req.start_date !== req.end_date ? ` – ${formatDate(req.end_date)}` : ""}
                      {req.half_day && " (half day)"}
                      {" · "}
                      {Number(req.total_days).toFixed(1)} {Number(req.total_days) === 1 ? "day" : "days"}
                    </p>
                    {req.manager_note && (
                      <p className="text-xs text-muted-foreground mt-0.5 italic">"{req.manager_note}"</p>
                    )}
                    {req.cancellation_reason && (
                      <p className="text-xs text-muted-foreground mt-0.5 italic">Reason: "{req.cancellation_reason}"</p>
                    )}
                  </div>
                  <div className={cn("text-xs text-muted-foreground whitespace-nowrap", req.status === "PENDING" && "flex items-center gap-2")}>
                    <span>{formatDate(req.created_at)}</span>
                    {req.status === "PENDING" && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs text-destructive hover:text-destructive px-2"
                        onClick={() => handleCancelPending(req)}
                        data-testid={`cancel-request-${req.id}`}
                      >
                        Cancel
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <RequestTimeOffDialog
        open={showDialog}
        onOpenChange={setShowDialog}
        balance={balance}
        workingDays={workingDays}
        publicHolidays={publicHolidays}
      />

      {/* Cancel approved request confirmation modal */}
      <Dialog open={cancelModal !== null} onOpenChange={(open) => { if (!open && !isCancelling) setCancelModal(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Cancel Approved Time Off</DialogTitle>
          </DialogHeader>

          {cancelModalReq && (
            <div className="space-y-4">
              <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Type</span>
                  <span className="font-medium">{cancelModalReq.type_name}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Dates</span>
                  <span className="font-medium">
                    {formatDate(cancelModalReq.start_date)}
                    {cancelModalReq.start_date !== cancelModalReq.end_date
                      ? ` – ${formatDate(cancelModalReq.end_date)}`
                      : ""}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Duration</span>
                  <span className="font-medium">
                    {Number(cancelModalReq.total_days).toFixed(1)}{" "}
                    {Number(cancelModalReq.total_days) === 1 ? "day" : "days"}
                  </span>
                </div>
              </div>

              {cancelModalReq.type_code === "VACATION" && balance != null && (
                <div className="grid grid-cols-3 gap-px rounded-md border border-border overflow-hidden text-center text-sm">
                  <div className="bg-muted/30 px-2 py-2">
                    <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-0.5">Current Balance</p>
                    <p className="font-semibold text-foreground">{Number(balance.vacation_remaining).toFixed(1)}</p>
                  </div>
                  <div className="bg-muted/30 px-2 py-2 border-x border-border">
                    <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-0.5">Days Returned</p>
                    <p className="font-semibold text-emerald-600">+{cancelImpactDays % 1 === 0 ? cancelImpactDays : cancelImpactDays.toFixed(1)}</p>
                  </div>
                  <div className="bg-muted/30 px-2 py-2">
                    <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-0.5">New Balance</p>
                    <p className="font-semibold text-emerald-600">{cancelNewBalance != null ? cancelNewBalance.toFixed(1) : "—"}</p>
                  </div>
                </div>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="cancel-reason" className="text-sm">
                  Reason for cancellation <span className="text-muted-foreground font-normal">(optional)</span>
                </Label>
                <Textarea
                  id="cancel-reason"
                  placeholder="Add a reason…"
                  value={cancelModal?.reason ?? ""}
                  onChange={(e) => setCancelModal((prev) => prev ? { ...prev, reason: e.target.value } : prev)}
                  rows={3}
                  className="resize-none text-sm"
                />
              </div>
            </div>
          )}

          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setCancelModal(null)}
              disabled={isCancelling}
            >
              Keep Request
            </Button>
            <Button
              variant="destructive"
              onClick={handleConfirmCancelApproved}
              disabled={isCancelling}
              data-testid="confirm-cancel-approved"
            >
              {isCancelling ? "Cancelling…" : "Yes, Cancel Request"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
