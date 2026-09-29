import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { apiFetch } from "@/lib/queryClient";
import {
  useListTeamTimeOffRequests,
  useListTeamTimeOffBalances,
  useApproveTimeOffRequest,
  useDeclineTimeOffRequest,
  useCancelTimeOffRequest,
  getListTeamTimeOffRequestsQueryKey,
  ListTeamTimeOffRequestsStatus,
  markAllTimeOffRequestNotificationsSeen,
} from "@workspace/api-client-react";
import { getTimeOffNotificationsQueryKey } from "@/hooks/use-time-off-notifications";
import type { TeamTimeOffRequest, TeamTimeOffBalance } from "@workspace/api-client-react";
import {
  CheckCircle2,
  XCircle,
  Clock,
  CalendarDays,
  ChevronDown,
  ChevronUp,
  Users,
  MessageSquare,
  Briefcase,
  Ban,
  Plane,
  Stethoscope,
  CalendarOff,
  BarChart2,
  Search,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { MemberHoverCard } from "@/components/MemberHoverCard";

function formatDate(dateStr: string) {
  return new Date(String(dateStr).slice(0, 10) + "T00:00:00").toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function todayStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

type BlackoutDate = {
  id: number;
  name: string;
  start_date: string;
  end_date: string;
  restriction_type: string;
  status: string;
};

function overlapsBlackout(startDate: string, endDate: string, blackouts: BlackoutDate[]): BlackoutDate[] {
  return blackouts.filter(
    (b) => b.status !== "cancelled" && b.start_date <= endDate && b.end_date >= startDate,
  );
}

const SCHEDULE_DAY_LABELS: { key: string; short: string }[] = [
  { key: "monday",    short: "Mon" },
  { key: "tuesday",  short: "Tue" },
  { key: "wednesday",short: "Wed" },
  { key: "thursday", short: "Thu" },
  { key: "friday",   short: "Fri" },
  { key: "saturday", short: "Sat" },
  { key: "sunday",   short: "Sun" },
];

const DEFAULT_WORKING_DAYS: Record<string, boolean> = {
  monday: true, tuesday: true, wednesday: true, thursday: true,
  friday: true, saturday: false, sunday: false,
};

function formatWorkSchedule(workingDays: Record<string, boolean> | null | undefined): {
  label: string;
  isDefault: boolean;
} {
  const effective = workingDays ?? DEFAULT_WORKING_DAYS;
  const activeDays = SCHEDULE_DAY_LABELS.filter((d) => effective[d.key]);
  const isDefault = !workingDays || Object.keys(DEFAULT_WORKING_DAYS).every(
    (k) => !!effective[k] === !!DEFAULT_WORKING_DAYS[k],
  );
  if (activeDays.length === 0) return { label: "No working days configured", isDefault };
  const names = activeDays.map((d) => d.short).join(", ");
  return { label: `${names} (${activeDays.length} day${activeDays.length !== 1 ? "s" : ""}/week)`, isDefault };
}

function InitialsAvatar({
  name,
  email,
  size = 32,
}: {
  name?: string | null;
  email?: string | null;
  size?: number;
}) {
  const display = name?.trim() || email?.trim() || "?";
  const initials = display[0].toUpperCase();
  return (
    <div
      className="rounded-full bg-muted flex items-center justify-center shrink-0 font-semibold text-muted-foreground select-none"
      style={{ width: size, height: size, fontSize: size * 0.4 }}
    >
      {initials}
    </div>
  );
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
      return (
        <Badge variant="secondary" className="text-muted-foreground">
          {status}
        </Badge>
      );
  }
}

function RequestRow({
  request,
  onApprove,
  onDecline,
  onCancel,
  today,
  blackoutDates,
}: {
  request: TeamTimeOffRequest;
  onApprove: (r: TeamTimeOffRequest) => void;
  onDecline: (r: TeamTimeOffRequest) => void;
  onCancel: (r: TeamTimeOffRequest) => void;
  today: string;
  blackoutDates: BlackoutDate[];
}) {
  const [expanded, setExpanded] = useState(false);
  const isPending = request.status === "PENDING";
  const isFutureApproved = request.status === "APPROVED" && request.start_date > today;
  const overlappingBlackouts = overlapsBlackout(
    String(request.start_date),
    String(request.end_date),
    blackoutDates,
  );

  return (
    <div
      className={cn(
        "border rounded-lg overflow-hidden transition-colors",
        isPending ? "border-border bg-card" : "border-border/60 bg-muted/30",
      )}
    >
      <div
        className="flex items-center gap-4 p-4 cursor-pointer hover:bg-muted/40 transition-colors"
        onClick={() => setExpanded((v) => !v)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && setExpanded((v) => !v)}
      >
        {request.member_image_url ? (
          <img
            src={request.member_image_url}
            alt={request.member_name ?? undefined}
            className="rounded-full object-cover shrink-0"
            style={{ width: 32, height: 32 }}
          />
        ) : (
          <InitialsAvatar name={request.member_name} email={request.member_email} size={32} />
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <MemberHoverCard
              name={request.member_name}
              personId={request.member_id}
              imageUrl={request.member_image_url}
              side="bottom"
            >
              <span className="font-medium text-sm truncate cursor-default">{request.member_name}</span>
            </MemberHoverCard>
            <span className="text-muted-foreground text-xs">·</span>
            <div className="flex items-center gap-1.5">
              <div
                className="w-2.5 h-2.5 rounded-full shrink-0"
                style={{ backgroundColor: request.type_color ?? "#6b7280" }}
              />
              <span className="text-sm text-muted-foreground">{request.type_name}</span>
            </div>
          </div>
          <div className="text-xs text-muted-foreground mt-0.5">
            {formatDate(request.start_date)} – {formatDate(request.end_date)}
            {" · "}
            {parseFloat(String(request.total_days))} day{parseFloat(String(request.total_days)) !== 1 ? "s" : ""}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {overlappingBlackouts.length > 0 && (
            <Badge
              variant="secondary"
              className="gap-1 text-red-700 bg-red-100 border-red-200 text-xs hidden sm:flex"
              title={overlappingBlackouts.map((b) => `Blackout: ${b.name}`).join("; ")}
            >
              <Ban size={10} />
              Blackout
            </Badge>
          )}
          <StatusBadge status={request.status} />
          {isPending && (
            <>
              <Button
                size="sm"
                variant="outline"
                className="text-emerald-700 border-emerald-200 hover:bg-emerald-50 hover:border-emerald-300 h-7 px-2"
                onClick={(e) => {
                  e.stopPropagation();
                  onApprove(request);
                }}
              >
                <CheckCircle2 size={13} className="mr-1" />
                Approve
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="text-destructive border-destructive/20 hover:bg-destructive/5 h-7 px-2"
                onClick={(e) => {
                  e.stopPropagation();
                  onDecline(request);
                }}
              >
                <XCircle size={13} className="mr-1" />
                Decline
              </Button>
            </>
          )}
          {isFutureApproved && (
            <Button
              size="sm"
              variant="outline"
              className="text-destructive border-destructive/20 hover:bg-destructive/5 h-7 px-2"
              onClick={(e) => {
                e.stopPropagation();
                onCancel(request);
              }}
            >
              <XCircle size={13} className="mr-1" />
              Cancel
            </Button>
          )}
          {expanded ? <ChevronUp size={14} className="text-muted-foreground" /> : <ChevronDown size={14} className="text-muted-foreground" />}
        </div>
      </div>
      {expanded && (
        <div className="border-t px-4 py-3 bg-muted/20 text-sm space-y-2">
          {request.reason && (
            <div className="flex gap-2">
              <MessageSquare size={13} className="text-muted-foreground mt-0.5 flex-shrink-0" />
              <div>
                <span className="text-muted-foreground text-xs font-medium uppercase tracking-wide">Reason</span>
                <p className="mt-0.5">{request.reason}</p>
              </div>
            </div>
          )}
          {request.manager_note && (
            <div className="flex gap-2">
              <MessageSquare size={13} className="text-muted-foreground mt-0.5 flex-shrink-0" />
              <div>
                <span className="text-muted-foreground text-xs font-medium uppercase tracking-wide">Manager note</span>
                <p className="mt-0.5">{request.manager_note}</p>
              </div>
            </div>
          )}
          <div className="flex gap-2">
            <Briefcase size={13} className="text-muted-foreground mt-0.5 flex-shrink-0" />
            <div>
              <span className="text-muted-foreground text-xs font-medium uppercase tracking-wide">Work schedule</span>
              {(() => {
                const { label, isDefault } = formatWorkSchedule(request.member_working_days);
                return (
                  <p className="mt-0.5 text-xs">
                    {label}
                    {isDefault && <span className="text-muted-foreground"> — default</span>}
                    <span className="text-muted-foreground ml-1">
                      · {parseFloat(String(request.total_days))} working day{parseFloat(String(request.total_days)) !== 1 ? "s" : ""} deducted
                    </span>
                  </p>
                );
              })()}
            </div>
          </div>
          {request.vacation_remaining != null && request.type_code === "VACATION" && (
            <p className="text-xs text-muted-foreground">
              Balance remaining: <strong>{Number(request.vacation_remaining).toFixed(1)} vacation days</strong>
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            Submitted {new Date(request.created_at).toLocaleString()}
          </p>
          {(request.status === "APPROVED" || request.status === "DECLINED") &&
            request.reviewed_by_name &&
            request.reviewed_at && (
              <div className="flex items-center gap-2">
                {request.reviewed_by_image_url ? (
                  <img
                    src={request.reviewed_by_image_url}
                    alt={request.reviewed_by_name}
                    className="rounded-full object-cover shrink-0"
                    style={{ width: 20, height: 20 }}
                    data-testid="reviewer-avatar-img"
                  />
                ) : (
                  <div
                    className="rounded-full bg-muted flex items-center justify-center shrink-0 font-semibold text-muted-foreground select-none"
                    style={{ width: 20, height: 20, fontSize: 8 }}
                    data-testid="reviewer-avatar-initials"
                  >
                    {request.reviewed_by_name[0].toUpperCase()}
                  </div>
                )}
                <p className="text-xs text-muted-foreground">
                  Reviewed by {request.reviewed_by_name} on{" "}
                  {new Date(request.reviewed_at).toLocaleDateString(undefined, {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                  })}
                </p>
              </div>
            )}
        </div>
      )}
    </div>
  );
}

function TeamBalancesSection({
  balances,
  isLoading,
  isError,
  isOwner,
}: {
  balances: TeamTimeOffBalance[];
  isLoading: boolean;
  isError: boolean;
  isOwner: boolean;
}) {
  const [search, setSearch] = useState("");

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <BarChart2 size={16} className="text-muted-foreground" />
            Team Balances
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-10 rounded bg-muted animate-pulse" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (isError) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <BarChart2 size={16} className="text-muted-foreground" />
            Team Balances
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-destructive">Failed to load team balances. Please refresh the page.</p>
        </CardContent>
      </Card>
    );
  }

  if (balances.length === 0) return null;

  const q = search.trim().toLowerCase();
  const filtered = q
    ? balances.filter(
        (b) =>
          (b.member_name ?? "").toLowerCase().includes(q) ||
          b.member_email.toLowerCase().includes(q),
      )
    : balances;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base font-semibold flex items-center gap-2">
          <BarChart2 size={16} className="text-muted-foreground" />
          Team Balances
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          {isOwner
            ? "Current-year leave balances for all workspace members."
            : "Current-year leave balances for your team."}
        </p>
        {isOwner && (
          <div className="relative mt-2">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <Input
              className="pl-8 h-8 text-sm"
              placeholder="Search by name or email…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {filtered.length === 0 ? (
          <p className="px-6 py-4 text-sm text-muted-foreground">No members match your search.</p>
        ) : (
          <div className="divide-y divide-border">
            {filtered.map((b) => (
              <div key={b.member_id} className="flex items-center gap-4 px-6 py-3 hover:bg-muted/30 transition-colors">
                <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center shrink-0 font-semibold text-muted-foreground text-sm select-none">
                  {(b.member_name?.[0] ?? b.member_email[0]).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{b.member_name}</p>
                  <p className="text-xs text-muted-foreground truncate">{b.member_email}</p>
                </div>
                {b.has_policy ? (
                  <div className="flex items-center gap-4 flex-shrink-0">
                    <div className="flex items-center gap-1.5 text-sm" title="Vacation remaining">
                      <div className="w-6 h-6 rounded bg-emerald-100 flex items-center justify-center">
                        <Plane size={12} className="text-emerald-700" />
                      </div>
                      <span className="font-semibold tabular-nums">
                        {b.vacation_remaining != null ? Number(b.vacation_remaining).toFixed(1) : "—"}
                      </span>
                      <span className="text-muted-foreground text-xs hidden sm:inline">left</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-sm" title="Vacation pending">
                      <div className="w-6 h-6 rounded bg-amber-100 flex items-center justify-center">
                        <Clock size={12} className="text-amber-700" />
                      </div>
                      <span className="font-semibold tabular-nums">
                        {b.vacation_pending != null ? Number(b.vacation_pending).toFixed(1) : "0.0"}
                      </span>
                      <span className="text-muted-foreground text-xs hidden sm:inline">pending</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-sm" title="Sick leave used">
                      <div className="w-6 h-6 rounded bg-rose-100 flex items-center justify-center">
                        <Stethoscope size={12} className="text-rose-700" />
                      </div>
                      <span className="font-semibold tabular-nums">
                        {b.sick_leave_used != null ? Number(b.sick_leave_used).toFixed(1) : "0.0"}
                      </span>
                      <span className="text-muted-foreground text-xs hidden sm:inline">sick used</span>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground flex-shrink-0">
                    <CalendarOff size={13} />
                    No policy
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface CancelModalState {
  request: TeamTimeOffRequest;
  reason: string;
}

export default function TimeOffApprovalsPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const today = todayStr();
  const { isOwner } = useWorkspaceRole();

  const [statusFilter, setStatusFilter] = useState<ListTeamTimeOffRequestsStatus>(ListTeamTimeOffRequestsStatus.PENDING);
  const yearOptions = [new Date().getFullYear(), new Date().getFullYear() - 1];
  const [yearFilter, setYearFilter] = useState<number | undefined>(undefined);

  const [declineTarget, setDeclineTarget] = useState<TeamTimeOffRequest | null>(null);
  const [managerNote, setManagerNote] = useState("");

  const [cancelModal, setCancelModal] = useState<CancelModalState | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);

  const params = {
    status: statusFilter || undefined,
    year: yearFilter,
  };

  const { data, isLoading, error } = useListTeamTimeOffRequests(params);
  const requests = data?.requests ?? [];

  const { data: balancesData, isLoading: balancesLoading, isError: balancesError } = useListTeamTimeOffBalances(
    isOwner ? { all: true } : undefined,
  );
  const teamBalances = balancesData?.balances ?? [];

  const { data: blackoutData } = useQuery({
    queryKey: ["blackout-dates-approvals"],
    queryFn: () => apiFetch("/api/blackout-dates"),
  });
  const blackoutDates: BlackoutDate[] = (blackoutData as { blackout_dates?: BlackoutDate[] })?.blackout_dates ?? [];

  useEffect(() => {
    let cancelled = false;
    markAllTimeOffRequestNotificationsSeen()
      .then(() => {
        if (cancelled) return;
        queryClient.invalidateQueries({ queryKey: getTimeOffNotificationsQueryKey() });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [queryClient]);

  const approveMutation = useApproveTimeOffRequest({
    mutation: {
      onSuccess: () => {
        toast({ title: "Request approved" });
        queryClient.invalidateQueries({ queryKey: getListTeamTimeOffRequestsQueryKey() });
      },
      onError: (err: unknown) => {
        const msg = err instanceof Error ? err.message : "Failed to approve request";
        toast({ title: "Error", description: msg, variant: "destructive" });
      },
    },
  });

  const declineMutation = useDeclineTimeOffRequest({
    mutation: {
      onSuccess: () => {
        toast({ title: "Request declined" });
        setDeclineTarget(null);
        setManagerNote("");
        queryClient.invalidateQueries({ queryKey: getListTeamTimeOffRequestsQueryKey() });
      },
      onError: (err: unknown) => {
        const msg = err instanceof Error ? err.message : "Failed to decline request";
        toast({ title: "Error", description: msg, variant: "destructive" });
      },
    },
  });

  const { mutateAsync: cancelRequest } = useCancelTimeOffRequest();

  function handleApprove(r: TeamTimeOffRequest) {
    approveMutation.mutate({ id: r.id });
  }

  function handleDeclineConfirm() {
    if (!declineTarget) return;
    declineMutation.mutate({
      id: declineTarget.id,
      data: { managerNote: managerNote || null },
    });
  }

  async function handleConfirmCancel() {
    if (!cancelModal) return;
    setIsCancelling(true);
    try {
      await cancelRequest({
        id: cancelModal.request.id,
        data: { cancellation_reason: cancelModal.reason.trim() || null },
      });
      queryClient.invalidateQueries({ queryKey: getListTeamTimeOffRequestsQueryKey() });
      toast({
        title: "Request cancelled",
        description: `${cancelModal.request.member_name}'s approved time off has been cancelled and their balance restored.`,
      });
      setCancelModal(null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to cancel request";
      toast({ title: "Error", description: msg, variant: "destructive" });
    } finally {
      setIsCancelling(false);
    }
  }

  const cancelModalReq = cancelModal?.request ?? null;
  const cancelImpactDays = cancelModalReq ? parseFloat(String(cancelModalReq.total_days)) : 0;
  const cancelCurrentBalance =
    cancelModalReq?.type_code === "VACATION" && cancelModalReq.vacation_remaining != null
      ? Number(cancelModalReq.vacation_remaining)
      : null;
  const cancelNewBalance =
    cancelCurrentBalance != null ? cancelCurrentBalance + cancelImpactDays : null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Users size={22} />
            Team Time-Off Approvals
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Review and action pending time-off requests from your team.
          </p>
        </div>
      </div>

      <div className="flex gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Label className="text-xs text-muted-foreground">Status</Label>
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as ListTeamTimeOffRequestsStatus)}>
            <SelectTrigger className="w-36 h-8 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="PENDING">Pending</SelectItem>
              <SelectItem value="APPROVED">Approved</SelectItem>
              <SelectItem value="DECLINED">Declined</SelectItem>
              <SelectItem value="CANCELLED">Cancelled</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <Label className="text-xs text-muted-foreground">Year</Label>
          <Select value={yearFilter ? String(yearFilter) : "all"} onValueChange={(v) => setYearFilter(v === "all" ? undefined : parseInt(v, 10))}>
            <SelectTrigger className="w-28 h-8 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              {yearOptions.map((y) => (
                <SelectItem key={y} value={String(y)}>
                  {y}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {isLoading && (
        <div className="text-center py-12 text-muted-foreground">Loading requests…</div>
      )}
      {error && (
        <div className="text-center py-12 text-destructive">Failed to load requests</div>
      )}
      {!isLoading && !error && requests.length === 0 && (
        <Card>
          <CardContent className="py-12 flex flex-col items-center gap-3 text-muted-foreground">
            <CalendarDays size={36} />
            <p className="font-medium">No {statusFilter.toLowerCase()} requests</p>
            <p className="text-sm text-center">There are no {statusFilter.toLowerCase()} time-off requests from your team.</p>
          </CardContent>
        </Card>
      )}
      {!isLoading && requests.length > 0 && (
        <div className="space-y-3">
          {requests.map((r) => (
            <RequestRow
              key={r.id}
              request={r}
              today={today}
              blackoutDates={blackoutDates}
              onApprove={handleApprove}
              onDecline={(req) => {
                setDeclineTarget(req);
                setManagerNote("");
              }}
              onCancel={(req) => {
                setCancelModal({ request: req, reason: "" });
              }}
            />
          ))}
        </div>
      )}

      <TeamBalancesSection balances={teamBalances} isLoading={balancesLoading} isError={balancesError} isOwner={isOwner} />

      {/* Decline modal */}
      <Dialog open={!!declineTarget} onOpenChange={(open) => !open && setDeclineTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Decline Time-Off Request</DialogTitle>
          </DialogHeader>
          {declineTarget && (
            <div className="space-y-4 py-2">
              <p className="text-sm text-muted-foreground">
                You are declining the{" "}
                <strong>{declineTarget.type_name}</strong> request from{" "}
                <strong>{declineTarget.member_name}</strong>{" "}
                <span className="text-xs">({declineTarget.member_email})</span> (
                {formatDate(declineTarget.start_date)} – {formatDate(declineTarget.end_date)}).
              </p>
              <div className="space-y-1.5">
                <Label htmlFor="manager-note">Note to employee (optional)</Label>
                <Textarea
                  id="manager-note"
                  placeholder="Provide a reason for declining…"
                  value={managerNote}
                  onChange={(e) => setManagerNote(e.target.value)}
                  className="resize-none"
                  rows={3}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeclineTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeclineConfirm}
              disabled={declineMutation.isPending}
            >
              {declineMutation.isPending ? "Declining…" : "Confirm Decline"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cancel approved request modal */}
      <Dialog
        open={cancelModal !== null}
        onOpenChange={(open) => { if (!open && !isCancelling) setCancelModal(null); }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Cancel Approved Time Off</DialogTitle>
          </DialogHeader>
          {cancelModalReq && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                You are cancelling an approved request on behalf of{" "}
                <strong>{cancelModalReq.member_name}</strong>. Their balance will be restored.
              </p>

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

              {cancelModalReq.type_code === "VACATION" && cancelCurrentBalance != null && (
                <div className="grid grid-cols-3 gap-px rounded-md border border-border overflow-hidden text-center text-sm">
                  <div className="bg-muted/30 px-2 py-2">
                    <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide mb-0.5">Current Balance</p>
                    <p className="font-semibold text-foreground">{cancelCurrentBalance.toFixed(1)}</p>
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
              onClick={handleConfirmCancel}
              disabled={isCancelling}
              data-testid="confirm-cancel-approved-team"
            >
              {isCancelling ? "Cancelling…" : "Yes, Cancel Request"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
