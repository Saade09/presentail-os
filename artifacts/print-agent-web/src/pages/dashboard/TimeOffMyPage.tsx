import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";
import {
  useGetTimeOffBalance,
  useGetTimeOffBalanceAdjustments,
  useListTimeOffRequests,
  useCancelTimeOffRequest,
  useListMyPublicHolidays,
  getGetTimeOffBalanceQueryKey,
  getListTimeOffRequestsQueryKey,
} from "@workspace/api-client-react";
import type { TimeOffRequest, PublicHolidayItem } from "@workspace/api-client-react";
import { RequestTimeOffDialog } from "@/components/RequestTimeOffDialog";
import {
  CalendarOff,
  Plane,
  Stethoscope,
  Clock,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Star,
  SlidersHorizontal,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Link } from "wouter";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";

function useCanManageTimeOffPolicies(): boolean {
  const { allowedPages, loaded } = useWorkspaceRole();
  if (!loaded) return false;
  if (allowedPages === null) return true;
  return allowedPages.includes("time-off.manage");
}

function formatDate(dateStr: string) {
  return new Date(String(dateStr).slice(0, 10) + "T00:00:00").toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case "PENDING":
      return (
        <Badge variant="secondary" className="gap-1 text-amber-700 bg-amber-100 border-amber-200">
          <Clock size={11} />
          Pending
        </Badge>
      );
    case "APPROVED":
      return (
        <Badge variant="secondary" className="gap-1 text-emerald-700 bg-emerald-100 border-emerald-200">
          <CheckCircle2 size={11} />
          Approved
        </Badge>
      );
    case "DECLINED":
      return (
        <Badge variant="secondary" className="gap-1 text-destructive bg-destructive/10 border-destructive/20">
          <XCircle size={11} />
          Declined
        </Badge>
      );
    case "CANCELLED":
      return (
        <Badge variant="secondary" className="gap-1 text-muted-foreground bg-muted border-border">
          <XCircle size={11} />
          Cancelled
        </Badge>
      );
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

type WorkingDaysConfig = {
  monday: boolean;
  tuesday: boolean;
  wednesday: boolean;
  thursday: boolean;
  friday: boolean;
  saturday: boolean;
  sunday: boolean;
};

type ProfileWorkingDays = { working_days: WorkingDaysConfig | null };

function formatDateTime(dateStr: string) {
  return new Date(dateStr).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export default function TimeOffMyPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canManagePolicies = useCanManageTimeOffPolicies();
  const [showDialog, setShowDialog] = useState(false);
  const [filterYear, setFilterYear] = useState<number>(new Date().getFullYear());
  const [filterType, setFilterType] = useState<"" | "VACATION" | "SICK_LEAVE">("");
  const currentYear = new Date().getFullYear();

  const { data: balanceData, isLoading: balanceLoading } = useGetTimeOffBalance();
  const balance = balanceData?.balance ?? null;
  const { data: adjustmentsData } = useGetTimeOffBalanceAdjustments();
  const adjustments = adjustmentsData?.adjustments ?? [];

  const { data: requestsData, isLoading: requestsLoading } = useListTimeOffRequests({
    year: filterYear,
    type: (filterType as "VACATION" | "SICK_LEAVE") || undefined,
  });
  const requests = requestsData?.requests ?? [];

  const { mutateAsync: cancelRequest } = useCancelTimeOffRequest();

  const { data: holidaysData } = useListMyPublicHolidays({ year: currentYear });
  const publicHolidays: PublicHolidayItem[] = (holidaysData?.holidays ?? []) as PublicHolidayItem[];

  const { data: profileData } = useQuery<ProfileWorkingDays>({
    queryKey: ["profile"],
    queryFn: () => apiFetch<ProfileWorkingDays>("/api/profile"),
  });
  const workingDays = profileData?.working_days ?? null;

  async function handleCancel(req: TimeOffRequest) {
    try {
      await cancelRequest({ id: req.id });
      await queryClient.invalidateQueries({ queryKey: getGetTimeOffBalanceQueryKey() });
      await queryClient.invalidateQueries({ queryKey: getListTimeOffRequestsQueryKey() });
      toast({ title: "Request cancelled", description: "Your time-off request has been cancelled." });
    } catch {
      toast({
        title: "Failed to cancel",
        description: "Could not cancel the request. Please try again.",
        variant: "destructive",
      });
    }
  }

  const yearOptions = [currentYear - 1, currentYear, currentYear + 1];

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Time Off</h1>
          <p className="text-muted-foreground mt-2">View your balances and manage leave requests.</p>
        </div>
        <Button onClick={() => setShowDialog(true)} data-testid="request-time-off-btn">
          Request Time Off
        </Button>
      </div>

      {/* Balance Cards */}
      {balanceLoading ? (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
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
                <Button size="sm" data-testid="assign-policy-btn">
                  Assign a time-off policy
                </Button>
              </Link>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <Card>
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-7 h-7 rounded-md bg-emerald-100 flex items-center justify-center">
                  <Plane size={14} className="text-emerald-700" />
                </div>
                <span className="text-xs font-medium text-muted-foreground">Vacation Left</span>
              </div>
              <p className="text-3xl font-bold">{Number(balance.vacation_remaining).toFixed(1)}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                of {Number(balance.vacation_entitled).toFixed(0)} days
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-7 h-7 rounded-md bg-amber-100 flex items-center justify-center">
                  <Clock size={14} className="text-amber-700" />
                </div>
                <span className="text-xs font-medium text-muted-foreground">Pending</span>
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
                <span className="text-xs font-medium text-muted-foreground">Vacation Used</span>
              </div>
              <p className="text-3xl font-bold">{Number(balance.vacation_used).toFixed(1)}</p>
              <p className="text-xs text-muted-foreground mt-0.5">this year</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-4">
              <div className="flex items-center gap-2 mb-2">
                <div className="w-7 h-7 rounded-md bg-rose-100 flex items-center justify-center">
                  <Stethoscope size={14} className="text-rose-700" />
                </div>
                <span className="text-xs font-medium text-muted-foreground">Sick Used</span>
              </div>
              <p className="text-3xl font-bold">{Number(balance.sick_leave_used).toFixed(1)}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {balance.sick_leave_entitled != null
                  ? `of ${Number(balance.sick_leave_entitled).toFixed(0)}`
                  : "no limit"}
              </p>
            </CardContent>
          </Card>
          {Number(balance.vacation_carryover) > 0 && (
            <Card>
              <CardContent className="pt-4 pb-4">
                <div className="flex items-center gap-2 mb-2">
                  <div className="w-7 h-7 rounded-md bg-purple-100 flex items-center justify-center">
                    <Star size={14} className="text-purple-700" />
                  </div>
                  <span className="text-xs font-medium text-muted-foreground">Carried Over</span>
                </div>
                <p className="text-3xl font-bold">{Number(balance.vacation_carryover).toFixed(1)}</p>
                <p className="text-xs text-muted-foreground mt-0.5">from last year</p>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Request History */}
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
                {yearOptions.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
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
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-10 rounded bg-muted animate-pulse" />
              ))}
            </div>
          ) : requests.length === 0 ? (
            <div className="px-6 pb-8 pt-4 text-center">
              <AlertCircle size={20} className="text-muted-foreground mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">No requests found for this period.</p>
            </div>
          ) : (
            <div className="divide-y divide-border">
              {requests.map((req) => (
                <div
                  key={req.id}
                  className="flex items-center gap-3 px-6 py-3 hover:bg-muted/40 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium">{req.type_name}</span>
                      <StatusBadge status={req.status} />
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {formatDate(req.start_date)}
                      {req.start_date !== req.end_date ? ` – ${formatDate(req.end_date)}` : ""}
                      {req.half_day && " (half day)"}
                      {" · "}
                      {Number(req.total_days).toFixed(1)}{" "}
                      {Number(req.total_days) === 1 ? "day" : "days"}
                    </p>
                    {(req.status === "APPROVED" || req.status === "DECLINED") &&
                      req.reviewed_by_name &&
                      req.reviewed_at && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Reviewed by {req.reviewed_by_name} on {formatDate(req.reviewed_at)}
                        </p>
                      )}
                    {req.status === "CANCELLED" && req.cancelled_by != null && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {req.cancelled_by_self
                          ? "Cancelled by you"
                          : `Cancelled by ${req.cancelled_by_name ?? "an admin"}`}
                        {req.cancelled_at ? ` on ${formatDate(req.cancelled_at)}` : ""}
                      </p>
                    )}
                    {req.status === "CANCELLED" && req.cancellation_reason && (
                      <p className="text-xs text-muted-foreground mt-0.5 italic">
                        "{req.cancellation_reason}"
                      </p>
                    )}
                    {req.manager_note && (
                      <p className="text-xs text-muted-foreground mt-0.5 italic">
                        "{req.manager_note}"
                      </p>
                    )}
                  </div>
                  <div
                    className={cn(
                      "text-xs text-muted-foreground whitespace-nowrap",
                      req.status === "PENDING" && "flex items-center gap-2",
                    )}
                  >
                    <span>{formatDate(req.created_at)}</span>
                    {req.status === "PENDING" && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 text-xs text-destructive hover:text-destructive px-2"
                        onClick={() => handleCancel(req)}
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

      {/* Public Holidays */}
      {publicHolidays.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Star size={15} className="text-amber-500" />
              Public Holidays {currentYear}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {publicHolidays.map((h) => (
                <div key={h.id} className="flex items-center justify-between py-1.5 border-b last:border-0">
                  <div className="flex items-center gap-2">
                    <Star size={11} className="text-amber-500 flex-shrink-0" />
                    <span className="text-sm font-medium">{h.name}</span>
                    {(h.is_paid ?? true) && (
                      <Badge variant="secondary" className="text-xs py-0 h-4 text-amber-700 bg-amber-100">
                        paid
                      </Badge>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {new Date(h.date + "T00:00:00").toLocaleDateString(undefined, {
                      month: "short",
                      day: "numeric",
                    })}
                    {h.end_date && h.end_date !== h.date && (
                      <>
                        {" – "}
                        {new Date(String(h.end_date).slice(0, 10) + "T00:00:00").toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                        })}
                      </>
                    )}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Balance Adjustments */}
      {adjustments.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <SlidersHorizontal size={15} className="text-muted-foreground" />
              Balance Adjustments
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-border">
              {adjustments.map((adj) => {
                const delta = Number(adj.amount_changed);
                const isPositive = delta > 0;
                const isNegative = delta < 0;
                return (
                  <div key={adj.id} className="flex items-start gap-3 px-6 py-3">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-medium">
                          Vacation entitlement: {Number(adj.vacation_entitled_before).toFixed(0)} → {Number(adj.vacation_entitled_after).toFixed(0)} days
                          {" "}
                          <span className="text-muted-foreground font-normal">({adj.policy_year})</span>
                        </p>
                        <span
                          className={cn(
                            "text-xs font-semibold px-1.5 py-0.5 rounded",
                            isPositive && "text-emerald-700 bg-emerald-100",
                            isNegative && "text-destructive bg-destructive/10",
                            !isPositive && !isNegative && "text-muted-foreground bg-muted",
                          )}
                        >
                          {isPositive ? `+${delta.toFixed(0)}` : delta.toFixed(0)} d
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5 italic">"{adj.reason}"</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Adjusted by {adj.adjusted_by_name}
                      </p>
                    </div>
                    <span className="text-xs text-muted-foreground whitespace-nowrap">
                      {formatDateTime(adj.adjusted_at)}
                    </span>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      <RequestTimeOffDialog
        open={showDialog}
        onOpenChange={setShowDialog}
        balance={balance}
        workingDays={workingDays}
        publicHolidays={publicHolidays}
        approverName={balance?.manager_name ?? null}
      />
    </div>
  );
}
