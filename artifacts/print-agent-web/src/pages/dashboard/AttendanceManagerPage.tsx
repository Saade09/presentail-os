import { useState, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetAttendanceLive,
  useGetAdminTimesheets,
  useApproveAttendanceSession,
  useRejectAttendanceSession,
  usePatchAttendanceSession,
  useLockAttendanceSession,
  useGetAttendanceSessionAuditLog,
  useGetAdminAttendanceRequests,
  useApproveAttendanceRequest,
  useRejectAttendanceRequest,
  useBulkApproveAttendanceRequests,
  useBulkRejectAttendanceRequests,
  useGetAdminAttendancePendingCount,
  getGetAttendanceLiveQueryKey,
  getGetAdminTimesheetsQueryKey,
  getGetAdminAttendanceRequestsQueryKey,
  getGetAdminAttendancePendingCountQueryKey,
  exportAttendanceCsv,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
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
import {
  Clock,
  CheckCircle2,
  XCircle,
  Download,
  Lock,
  Loader2,
  Users,
  ScrollText,
  Edit,
  AlertTriangle,
  Search,
  FileEdit,
  BellOff,
  LogOut,
} from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";
import { cn } from "@/lib/utils";

type CorrectionRequest = {
  id: number;
  employee_id: number;
  employee_name: string | null;
  attendance_session_id: number | null;
  request_type: string;
  requested_clock_in_at: string | null;
  requested_clock_out_at: string | null;
  reason: string | null;
  status: string;
  reviewer_note: string | null;
  created_at: string;
};

const CORRECTION_REQUEST_TYPE_LABELS: Record<string, string> = {
  missed_clock_in: "Missed Clock-In",
  missed_clock_out: "Missed Clock-Out",
  edit_clock_in: "Edit Clock-In",
  edit_clock_out: "Edit Clock-Out",
  offsite_clock_in: "Offsite Clock-In",
  offsite_clock_out: "Offsite Clock-Out",
  other: "Other",
};

function correctionStatusBadge(status: string) {
  switch (status) {
    case "pending":
      return (
        <Badge className="gap-1 bg-amber-100 text-amber-800 border-amber-200" variant="secondary">
          <Clock size={10} /> Pending
        </Badge>
      );
    case "approved":
      return (
        <Badge className="gap-1 bg-emerald-100 text-emerald-800 border-emerald-200" variant="secondary">
          <CheckCircle2 size={10} /> Approved
        </Badge>
      );
    case "rejected":
      return (
        <Badge className="gap-1 bg-red-100 text-red-800 border-red-200" variant="secondary">
          <XCircle size={10} /> Rejected
        </Badge>
      );
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

type Session = {
  id: number;
  employee_id: number;
  employee_name: string | null;
  clock_in_at: string;
  clock_out_at: string | null;
  break_minutes: number;
  paid_minutes: number | null;
  late_minutes: number | null;
  early_leave_minutes: number | null;
  overtime_minutes: number | null;
  status: string;
  employee_note: string | null;
  manager_note: string | null;
  location_name: string | null;
  missed_clockout_notif_sent_at: string | null;
  missed_clockout_reminder_sent_at: string | null;
};

type AuditEntry = {
  id: number;
  actor_type: string;
  actor_name: string | null;
  action: string;
  changed_fields: Record<string, unknown> | null;
  note: string | null;
  created_at: string;
};

function sessionStatusBadge(status: string) {
  switch (status) {
    case "open":
      return (
        <Badge className="gap-1 bg-blue-100 text-blue-800 border-blue-200" variant="secondary">
          <Clock size={10} /> Active
        </Badge>
      );
    case "completed":
      return (
        <Badge className="gap-1 bg-amber-100 text-amber-800 border-amber-200" variant="secondary">
          Completed
        </Badge>
      );
    case "approved":
      return (
        <Badge className="gap-1 bg-emerald-100 text-emerald-800 border-emerald-200" variant="secondary">
          <CheckCircle2 size={10} /> Approved
        </Badge>
      );
    case "rejected":
      return (
        <Badge className="gap-1 bg-red-100 text-red-800 border-red-200" variant="secondary">
          <XCircle size={10} /> Rejected
        </Badge>
      );
    case "locked":
      return (
        <Badge className="gap-1 bg-gray-100 text-gray-700 border-gray-200" variant="secondary">
          <Lock size={10} /> Locked
        </Badge>
      );
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

function formatTime(ts: string | null | undefined) {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function formatDateTime(ts: string) {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDate(ts: string) {
  return new Date(ts).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function formatMinutes(m: number | null | undefined) {
  if (m == null || m === 0) return "—";
  const h = Math.floor(m / 60);
  const min = m % 60;
  if (h === 0) return `${min}m`;
  if (min === 0) return `${h}h`;
  return `${h}h ${min}m`;
}

function firstOfMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const LATE_HOUR = 9;

function computeTimesheetSummary(sessions: Session[]) {
  const total = sessions.length;
  const withPaid = sessions.filter((s) => s.paid_minutes != null && s.paid_minutes > 0);
  const avgMinutes =
    withPaid.length > 0
      ? withPaid.reduce((acc, s) => acc + (s.paid_minutes ?? 0), 0) / withPaid.length
      : 0;
  const lateCount = sessions.filter((s) => {
    const h = new Date(s.clock_in_at).getHours();
    return h > LATE_HOUR;
  }).length;
  const totalLateMinutes = sessions.reduce((acc, s) => acc + (s.late_minutes ?? 0), 0);
  const totalEarlyLeaveMinutes = sessions.reduce((acc, s) => acc + (s.early_leave_minutes ?? 0), 0);
  const totalOvertimeMinutes = sessions.reduce((acc, s) => acc + (s.overtime_minutes ?? 0), 0);
  return { total, avgMinutes, lateCount, totalLateMinutes, totalEarlyLeaveMinutes, totalOvertimeMinutes };
}

function computeDailyChartData(sessions: Session[]) {
  const map = new Map<string, { date: string; totalMinutes: number; count: number }>();
  for (const s of sessions) {
    const d = new Date(s.clock_in_at);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const label = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const existing = map.get(key);
    if (existing) {
      existing.totalMinutes += s.paid_minutes ?? 0;
      existing.count += 1;
    } else {
      map.set(key, { date: label, totalMinutes: s.paid_minutes ?? 0, count: 1 });
    }
  }
  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, v]) => ({ date: v.date, hours: Math.round((v.totalMinutes / 60) * 10) / 10, sessions: v.count }));
}

function TimesheetSummary({ sessions }: { sessions: Session[] }) {
  const { total, avgMinutes, lateCount, totalLateMinutes, totalEarlyLeaveMinutes, totalOvertimeMinutes } = useMemo(() => computeTimesheetSummary(sessions), [sessions]);
  const chartData = useMemo(() => computeDailyChartData(sessions), [sessions]);

  const avgH = Math.floor(avgMinutes / 60);
  const avgM = Math.round(avgMinutes % 60);
  const avgLabel = avgMinutes === 0 ? "—" : avgM === 0 ? `${avgH}h` : `${avgH}h ${avgM}m`;

  const hasDeviations = totalLateMinutes > 0 || totalEarlyLeaveMinutes > 0 || totalOvertimeMinutes > 0;

  if (total === 0) return null;

  return (
    <div className="space-y-3">
      {/* Stat strip */}
      <div className="grid grid-cols-3 gap-3">
        <Card>
          <CardContent className="pt-4 pb-4">
            <p className="text-xs text-muted-foreground mb-1">Total Sessions</p>
            <p className="text-2xl font-bold">{total}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-4">
            <p className="text-xs text-muted-foreground mb-1">Avg Hours Worked</p>
            <p className="text-2xl font-bold">{avgLabel}</p>
          </CardContent>
        </Card>
        <Card className={cn(lateCount > 0 && "border-amber-200")}>
          <CardContent className="pt-4 pb-4">
            <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
              {lateCount > 0 && <AlertTriangle size={11} className="text-amber-500" />}
              Late Clock-ins (after {LATE_HOUR}:00)
            </p>
            <p className={cn("text-2xl font-bold", lateCount > 0 ? "text-amber-600" : "")}>{lateCount}</p>
          </CardContent>
        </Card>
      </div>

      {/* Late / Early-leave / Overtime totals — only shown when at least one is non-zero */}
      {hasDeviations && (
        <div className="flex flex-wrap gap-3">
          {totalLateMinutes > 0 && (
            <Card className="border-amber-200 flex-1 min-w-[140px]">
              <CardContent className="pt-3 pb-3">
                <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
                  <AlertTriangle size={11} className="text-amber-500" />
                  Total Late
                </p>
                <p className="text-xl font-bold text-amber-600">{formatMinutes(totalLateMinutes)}</p>
              </CardContent>
            </Card>
          )}
          {totalEarlyLeaveMinutes > 0 && (
            <Card className="border-orange-200 flex-1 min-w-[140px]">
              <CardContent className="pt-3 pb-3">
                <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
                  <LogOut size={11} className="text-orange-500" />
                  Total Early Leave
                </p>
                <p className="text-xl font-bold text-orange-600">{formatMinutes(totalEarlyLeaveMinutes)}</p>
              </CardContent>
            </Card>
          )}
          {totalOvertimeMinutes > 0 && (
            <Card className="border-purple-200 flex-1 min-w-[140px]">
              <CardContent className="pt-3 pb-3">
                <p className="text-xs text-muted-foreground mb-1 flex items-center gap-1">
                  <Clock size={11} className="text-purple-500" />
                  Total Overtime
                </p>
                <p className="text-xl font-bold text-purple-600">{formatMinutes(totalOvertimeMinutes)}</p>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {/* Bar chart — only when there are multiple days of data */}
      {chartData.length > 1 && (
        <Card>
          <CardHeader className="pb-2 pt-4">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Paid Hours by Day
            </CardTitle>
          </CardHeader>
          <CardContent className="pb-4">
            <ResponsiveContainer width="100%" height={140}>
              <BarChart data={chartData} margin={{ top: 0, right: 8, left: -20, bottom: 0 }} barSize={20}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  cursor={{ fill: "hsl(var(--muted))" }}
                  contentStyle={{
                    borderRadius: "8px",
                    border: "1px solid hsl(var(--border))",
                    fontSize: 12,
                    background: "hsl(var(--background))",
                  }}
                  formatter={(val: number) => [`${val}h`, "Paid hours"]}
                />
                <Bar dataKey="hours" fill="hsl(var(--primary))" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function AuditLogPanel({ sessionId }: { sessionId: number }) {
  const { data, isLoading } = useGetAttendanceSessionAuditLog(sessionId);
  const logs: AuditEntry[] = ((data as Record<string, unknown> | undefined)?.logs as AuditEntry[] | undefined) ?? [];

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-muted-foreground text-sm py-4">
        <Loader2 size={15} className="animate-spin" />
        Loading audit log…
      </div>
    );
  }

  if (logs.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-4">No audit entries yet.</p>
    );
  }

  return (
    <div className="space-y-3">
      {logs.map((entry) => (
        <div key={entry.id} className="flex gap-3 text-sm">
          <div className="shrink-0 w-1.5 h-1.5 rounded-full bg-muted-foreground/40 mt-2" />
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="font-medium">{entry.actor_name ?? entry.actor_type}</span>
              <span className="text-muted-foreground">{entry.action.replace(/_/g, " ")}</span>
              <span className="text-xs text-muted-foreground ml-auto">{formatDateTime(entry.created_at)}</span>
            </div>
            {entry.note && (
              <p className="text-muted-foreground text-xs mt-0.5 italic">"{entry.note}"</p>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function AttendanceManagerPage() {
  const qc = useQueryClient();
  const { toast } = useToast();

  const [tab, setTab] = useState<"live" | "timesheets" | "corrections">("live");
  const [dateFrom, setDateFrom] = useState(firstOfMonth);
  const [dateTo, setDateTo] = useState(todayStr);
  const [statusFilter, setStatusFilter] = useState("all");
  const [missedClockoutFilter, setMissedClockoutFilter] = useState(false);
  const [selectedSession, setSelectedSession] = useState<Session | null>(null);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [rejectNote, setRejectNote] = useState("");
  const [editForm, setEditForm] = useState({
    clock_in_at: "",
    clock_out_at: "",
    break_minutes: "",
    manager_note: "",
  });
  const [exporting, setExporting] = useState(false);

  // Corrections tab state
  const [corrStatusFilter, setCorrStatusFilter] = useState("pending");
  const [corrEmployeeFilter, setCorrEmployeeFilter] = useState("");
  const [selectedRequestIds, setSelectedRequestIds] = useState<Set<number>>(new Set());
  const [corrRejectDialogOpen, setCorrRejectDialogOpen] = useState(false);
  const [corrRejectNote, setCorrRejectNote] = useState("");
  const [corrActiveRequest, setCorrActiveRequest] = useState<CorrectionRequest | null>(null);
  const [bulkRejectDialogOpen, setBulkRejectDialogOpen] = useState(false);
  const [bulkRejectNote, setBulkRejectNote] = useState("");

  const liveParams = {
    ...(missedClockoutFilter ? { missed_clockout: "true" as const } : {}),
  };
  const { data: liveData, isLoading: liveLoading } = useGetAttendanceLive(
    liveParams,
    {
      query: {
        queryKey: getGetAttendanceLiveQueryKey(liveParams),
        enabled: tab === "live",
        refetchInterval: 30_000,
      },
    },
  );
  const liveSessions: Session[] = ((liveData as Record<string, unknown> | undefined)?.sessions as Session[] | undefined) ?? [];

  const timesheetParams = {
    from: dateFrom,
    to: dateTo,
    ...(statusFilter !== "all" ? { status: statusFilter } : {}),
    ...(missedClockoutFilter ? { missed_clockout: "true" as const } : {}),
    limit: 100,
  };
  const { data: timesheetsData, isLoading: timesheetsLoading } = useGetAdminTimesheets(
    timesheetParams,
    { query: { queryKey: getGetAdminTimesheetsQueryKey(timesheetParams), enabled: tab === "timesheets" } },
  );
  const sessions: Session[] = ((timesheetsData as Record<string, unknown> | undefined)?.sessions as Session[] | undefined) ?? [];

  // Pending count badge — always polling so the badge is visible regardless of active tab
  const { data: pendingCountData } = useGetAdminAttendancePendingCount({
    query: { queryKey: getGetAdminAttendancePendingCountQueryKey(), refetchInterval: 30_000 },
  });
  const pendingCount = (pendingCountData as { count?: number } | undefined)?.count ?? 0;

  // Corrections tab data
  const corrParams = {
    status: corrStatusFilter,
    ...(corrEmployeeFilter.trim() ? { employee_name: corrEmployeeFilter.trim() } : {}),
    limit: 200,
  };
  const { data: corrData, isLoading: corrLoading } = useGetAdminAttendanceRequests(
    corrParams,
    { query: { queryKey: getGetAdminAttendanceRequestsQueryKey(corrParams), enabled: tab === "corrections" } },
  );
  const corrRequests: CorrectionRequest[] =
    ((corrData as Record<string, unknown> | undefined)?.requests as CorrectionRequest[] | undefined) ?? [];

  const approveRequestMutation = useApproveAttendanceRequest({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetAdminAttendanceRequestsQueryKey() });
        toast({ title: "Request approved" });
        setCorrActiveRequest(null);
      },
      onError: (err: Error) =>
        toast({ title: "Error", description: err.message, variant: "destructive" }),
    },
  });

  const rejectRequestMutation = useRejectAttendanceRequest({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetAdminAttendanceRequestsQueryKey() });
        toast({ title: "Request rejected" });
        setCorrRejectDialogOpen(false);
        setCorrActiveRequest(null);
      },
      onError: (err: Error) =>
        toast({ title: "Error", description: err.message, variant: "destructive" }),
    },
  });

  const bulkApproveMutation = useBulkApproveAttendanceRequests({
    mutation: {
      onSuccess: (result) => {
        qc.invalidateQueries({ queryKey: getGetAdminAttendanceRequestsQueryKey() });
        const res = result as { succeeded?: number; failed?: number };
        toast({
          title: `Bulk approved: ${res.succeeded ?? 0} approved${(res.failed ?? 0) > 0 ? `, ${res.failed} failed` : ""}`,
        });
        setSelectedRequestIds(new Set());
      },
      onError: (err: Error) =>
        toast({ title: "Error", description: err.message, variant: "destructive" }),
    },
  });

  const bulkRejectMutation = useBulkRejectAttendanceRequests({
    mutation: {
      onSuccess: (result) => {
        qc.invalidateQueries({ queryKey: getGetAdminAttendanceRequestsQueryKey() });
        const res = result as { succeeded?: number; failed?: number };
        toast({
          title: `Bulk rejected: ${res.succeeded ?? 0} rejected${(res.failed ?? 0) > 0 ? `, ${res.failed} failed` : ""}`,
        });
        setSelectedRequestIds(new Set());
        setBulkRejectDialogOpen(false);
      },
      onError: (err: Error) =>
        toast({ title: "Error", description: err.message, variant: "destructive" }),
    },
  });

  function toggleSelectRequest(id: number) {
    setSelectedRequestIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAllRequests() {
    const pending = corrRequests.filter((r) => r.status === "pending");
    if (pending.every((r) => selectedRequestIds.has(r.id))) {
      setSelectedRequestIds(new Set());
    } else {
      setSelectedRequestIds(new Set(pending.map((r) => r.id)));
    }
  }

  const pendingRequests = corrRequests.filter((r) => r.status === "pending");
  const allPendingSelected =
    pendingRequests.length > 0 && pendingRequests.every((r) => selectedRequestIds.has(r.id));
  const somePendingSelected = pendingRequests.some((r) => selectedRequestIds.has(r.id));

  const approveMutation = useApproveAttendanceSession({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetAdminTimesheetsQueryKey() });
        qc.invalidateQueries({ queryKey: getGetAttendanceLiveQueryKey() });
        toast({ title: "Session approved" });
        setSelectedSession(null);
      },
      onError: (err: Error) =>
        toast({ title: "Error", description: err.message, variant: "destructive" }),
    },
  });

  const rejectMutation = useRejectAttendanceSession({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetAdminTimesheetsQueryKey() });
        qc.invalidateQueries({ queryKey: getGetAttendanceLiveQueryKey() });
        toast({ title: "Session rejected" });
        setRejectDialogOpen(false);
        setSelectedSession(null);
      },
      onError: (err: Error) =>
        toast({ title: "Error", description: err.message, variant: "destructive" }),
    },
  });

  const patchMutation = usePatchAttendanceSession({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetAdminTimesheetsQueryKey() });
        qc.invalidateQueries({ queryKey: getGetAttendanceLiveQueryKey() });
        toast({ title: "Session updated" });
        setEditDialogOpen(false);
      },
      onError: (err: Error) =>
        toast({ title: "Error", description: err.message, variant: "destructive" }),
    },
  });

  const lockMutation = useLockAttendanceSession({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetAdminTimesheetsQueryKey() });
        toast({ title: "Session locked for payroll" });
        setSelectedSession(null);
      },
      onError: (err: Error) =>
        toast({ title: "Error", description: err.message, variant: "destructive" }),
    },
  });

  function openEdit(s: Session) {
    setEditForm({
      clock_in_at: s.clock_in_at ? new Date(s.clock_in_at).toISOString().slice(0, 16) : "",
      clock_out_at: s.clock_out_at ? new Date(s.clock_out_at).toISOString().slice(0, 16) : "",
      break_minutes: String(s.break_minutes ?? 0),
      manager_note: s.manager_note ?? "",
    });
    setEditDialogOpen(true);
  }

  function handleEdit() {
    if (!selectedSession) return;
    const body: Record<string, unknown> = {};
    if (editForm.clock_in_at) body.clock_in_at = new Date(editForm.clock_in_at).toISOString();
    if (editForm.clock_out_at) body.clock_out_at = new Date(editForm.clock_out_at).toISOString();
    if (editForm.break_minutes !== "") body.break_minutes = Number(editForm.break_minutes);
    if (editForm.manager_note) body.manager_note = editForm.manager_note;
    patchMutation.mutate({ id: selectedSession.id, data: body as Parameters<typeof patchMutation.mutate>[0]["data"] });
  }

  async function handleExport() {
    setExporting(true);
    try {
      const csv = await exportAttendanceCsv({ from: dateFrom, to: dateTo });
      const blob = new Blob([csv as string], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `attendance-${dateFrom}-to-${dateTo}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast({ title: "Export failed", description: "Could not export attendance data.", variant: "destructive" });
    } finally {
      setExporting(false);
    }
  }

  // Count of missed clock-out sessions for the filter chip badge
  const liveMissedCount = missedClockoutFilter
    ? liveSessions.length
    : liveSessions.filter((s) => s.missed_clockout_notif_sent_at !== null).length;

  const timesheetsTotal = ((timesheetsData as Record<string, unknown> | undefined)?.total as number | undefined);
  const timesheetsMissedCount = missedClockoutFilter
    ? (timesheetsTotal ?? sessions.length)
    : sessions.filter((s) => s.missed_clockout_notif_sent_at !== null).length;

  const displaySessions = tab === "live" ? liveSessions : sessions;
  const isLoading = tab === "live" ? liveLoading : timesheetsLoading;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Users size={22} />
            Attendance
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Monitor and manage team attendance sessions.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {tab === "timesheets" && (
            <Button
              size="sm"
              variant="outline"
              className="gap-2"
              onClick={handleExport}
              disabled={exporting}
            >
              {exporting ? (
                <Loader2 size={15} className="animate-spin" />
              ) : (
                <Download size={15} />
              )}
              Export CSV
            </Button>
          )}
        </div>
      </div>

      {/* Tab switcher */}
      <div className="flex items-center gap-1 border-b">
        {(["live", "timesheets", "corrections"] as const).map((t) => (
          <button
            key={t}
            onClick={() => { setTab(t); setSelectedRequestIds(new Set()); }}
            className={cn(
              "px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors flex items-center gap-1.5",
              tab === t
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t === "live" ? "Live View" : t === "timesheets" ? "Timesheets" : (
              <>
                <FileEdit size={13} />
                Correction Requests
                {pendingCount > 0 && (
                  <span className="ml-1 inline-flex items-center justify-center rounded-full bg-amber-500 text-white text-[10px] font-semibold leading-none px-1.5 py-0.5 min-w-[18px]">
                    {pendingCount}
                  </span>
                )}
              </>
            )}
          </button>
        ))}
      </div>

      {/* Missed clock-out filter chip (Live View) */}
      {tab === "live" && (
        <div className="flex items-center gap-2">
          <button
            onClick={() => setMissedClockoutFilter((f) => !f)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors",
              missedClockoutFilter
                ? "bg-amber-100 border-amber-300 text-amber-900"
                : "border-muted-foreground/30 text-muted-foreground hover:border-muted-foreground/60 hover:text-foreground",
            )}
          >
            <BellOff size={13} />
            Missed clock-out
            {liveMissedCount > 0 && (
              <span
                className={cn(
                  "inline-flex items-center justify-center rounded-full text-[10px] font-semibold leading-none px-1.5 py-0.5 min-w-[18px]",
                  missedClockoutFilter
                    ? "bg-amber-600 text-white"
                    : "bg-amber-100 text-amber-800",
                )}
              >
                {liveMissedCount}
              </span>
            )}
          </button>
        </div>
      )}

      {/* Filters (timesheets only) */}
      {tab === "timesheets" && (
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex flex-wrap gap-3 items-end">
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">From</Label>
                <Input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className="h-9 w-40"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">To</Label>
                <Input
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  className="h-9 w-40"
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">Status</Label>
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="h-9 w-44">
                    <SelectValue placeholder="All statuses" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All statuses</SelectItem>
                    <SelectItem value="open">Active</SelectItem>
                    <SelectItem value="completed">Completed</SelectItem>
                    <SelectItem value="approved">Approved</SelectItem>
                    <SelectItem value="rejected">Rejected</SelectItem>
                    <SelectItem value="locked">Locked</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-end pb-0.5">
                <button
                  onClick={() => setMissedClockoutFilter((f) => !f)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border h-9 px-3 text-sm font-medium transition-colors",
                    missedClockoutFilter
                      ? "bg-amber-100 border-amber-300 text-amber-900"
                      : "border-muted-foreground/30 text-muted-foreground hover:border-muted-foreground/60 hover:text-foreground",
                  )}
                >
                  <BellOff size={13} />
                  Missed clock-out
                  {timesheetsMissedCount > 0 && (
                    <span
                      className={cn(
                        "inline-flex items-center justify-center rounded-full text-[10px] font-semibold leading-none px-1.5 py-0.5 min-w-[18px]",
                        missedClockoutFilter
                          ? "bg-amber-600 text-white"
                          : "bg-amber-100 text-amber-800",
                      )}
                    >
                      {timesheetsMissedCount}
                    </span>
                  )}
                </button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Timesheets summary — stat strip + daily chart */}
      {tab === "timesheets" && !timesheetsLoading && (
        <TimesheetSummary sessions={sessions} />
      )}

      {/* ─── Correction Requests Tab ─────────────────────────────────────── */}
      {tab === "corrections" && (
        <div className="space-y-4">
          {/* Filters */}
          <Card>
            <CardContent className="pt-4 pb-4">
              <div className="flex flex-wrap gap-3 items-end">
                <div className="space-y-1">
                  <p className="text-xs text-muted-foreground">Status</p>
                  <Select value={corrStatusFilter} onValueChange={(v) => { setCorrStatusFilter(v); setSelectedRequestIds(new Set()); }}>
                    <SelectTrigger className="h-9 w-44">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="pending">Pending</SelectItem>
                      <SelectItem value="approved">Approved</SelectItem>
                      <SelectItem value="rejected">Rejected</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1 flex-1 min-w-48">
                  <p className="text-xs text-muted-foreground">Employee</p>
                  <div className="relative">
                    <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      className="h-9 pl-8"
                      placeholder="Filter by name…"
                      value={corrEmployeeFilter}
                      onChange={(e) => setCorrEmployeeFilter(e.target.value)}
                    />
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Bulk action bar */}
          {corrStatusFilter === "pending" && selectedRequestIds.size > 0 && (
            <div className="flex items-center gap-3 px-4 py-2.5 bg-primary/5 border border-primary/20 rounded-lg">
              <span className="text-sm font-medium text-primary">
                {selectedRequestIds.size} selected
              </span>
              <div className="flex items-center gap-2 ml-auto">
                <Button
                  size="sm"
                  className="gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white"
                  onClick={() => bulkApproveMutation.mutate({ data: { ids: Array.from(selectedRequestIds) } })}
                  disabled={bulkApproveMutation.isPending || bulkRejectMutation.isPending}
                >
                  {bulkApproveMutation.isPending ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    <CheckCircle2 size={13} />
                  )}
                  Approve all
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5 text-red-600 border-red-200 hover:bg-red-50"
                  onClick={() => { setBulkRejectNote(""); setBulkRejectDialogOpen(true); }}
                  disabled={bulkApproveMutation.isPending || bulkRejectMutation.isPending}
                >
                  <XCircle size={13} />
                  Reject all
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground"
                  onClick={() => setSelectedRequestIds(new Set())}
                >
                  Clear
                </Button>
              </div>
            </div>
          )}

          {/* Requests table */}
          <Card>
            <CardContent className="p-0">
              {corrLoading ? (
                <div className="flex items-center justify-center py-16 gap-2 text-muted-foreground">
                  <Loader2 size={18} className="animate-spin" />
                  Loading…
                </div>
              ) : corrRequests.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
                  <FileEdit size={30} className="opacity-30" />
                  <p className="text-sm">
                    {corrStatusFilter === "pending"
                      ? "No pending correction requests."
                      : `No ${corrStatusFilter} requests found.`}
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/40">
                        {corrStatusFilter === "pending" && (
                          <th className="px-4 py-3 w-10">
                            <Checkbox
                              checked={allPendingSelected}
                              data-state={somePendingSelected && !allPendingSelected ? "indeterminate" : undefined}
                              onCheckedChange={toggleSelectAllRequests}
                              aria-label="Select all"
                            />
                          </th>
                        )}
                        <th className="text-left px-4 py-3 font-medium text-muted-foreground">Employee</th>
                        <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden sm:table-cell">Type</th>
                        <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden md:table-cell">Session date</th>
                        <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden md:table-cell">Submitted</th>
                        <th className="text-left px-4 py-3 font-medium text-muted-foreground">Status</th>
                        {corrStatusFilter === "pending" && (
                          <th className="px-4 py-3 w-32" />
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {corrRequests.map((req) => (
                        <tr key={req.id} className="border-b last:border-0 hover:bg-muted/20 transition-colors">
                          {corrStatusFilter === "pending" && (
                            <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                              <Checkbox
                                checked={selectedRequestIds.has(req.id)}
                                onCheckedChange={() => toggleSelectRequest(req.id)}
                                aria-label={`Select request ${req.id}`}
                              />
                            </td>
                          )}
                          <td className="px-4 py-3">
                            <div className="font-medium">
                              {req.employee_name ?? `Employee #${req.employee_id}`}
                            </div>
                            {req.reason && (
                              <div className="text-xs text-muted-foreground truncate max-w-[180px]" title={req.reason}>
                                {req.reason}
                              </div>
                            )}
                          </td>
                          <td className="px-4 py-3 hidden sm:table-cell text-muted-foreground">
                            <Badge variant="outline" className="text-xs font-normal">
                              {CORRECTION_REQUEST_TYPE_LABELS[req.request_type] ?? req.request_type}
                            </Badge>
                          </td>
                          <td className="px-4 py-3 hidden md:table-cell text-muted-foreground text-xs">
                            {req.requested_clock_in_at
                              ? formatDateTime(req.requested_clock_in_at)
                              : req.requested_clock_out_at
                              ? formatDateTime(req.requested_clock_out_at)
                              : "—"}
                          </td>
                          <td className="px-4 py-3 hidden md:table-cell text-muted-foreground text-xs">
                            {formatDateTime(req.created_at)}
                          </td>
                          <td className="px-4 py-3">
                            {correctionStatusBadge(req.status)}
                            {req.reviewer_note && (
                              <div className="text-xs text-muted-foreground mt-1 italic truncate max-w-[140px]" title={req.reviewer_note}>
                                "{req.reviewer_note}"
                              </div>
                            )}
                          </td>
                          {corrStatusFilter === "pending" && (
                            <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                              <div className="flex items-center gap-1.5 justify-end">
                                <Button
                                  size="sm"
                                  className="h-7 gap-1 bg-emerald-600 hover:bg-emerald-700 text-white px-2"
                                  onClick={() => approveRequestMutation.mutate({ id: req.id, data: {} })}
                                  disabled={approveRequestMutation.isPending}
                                >
                                  {approveRequestMutation.isPending && approveRequestMutation.variables?.id === req.id ? (
                                    <Loader2 size={12} className="animate-spin" />
                                  ) : (
                                    <CheckCircle2 size={12} />
                                  )}
                                  Approve
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 gap-1 text-red-600 border-red-200 hover:bg-red-50 px-2"
                                  onClick={() => {
                                    setCorrActiveRequest(req);
                                    setCorrRejectNote("");
                                    setCorrRejectDialogOpen(true);
                                  }}
                                >
                                  <XCircle size={12} />
                                  Reject
                                </Button>
                              </div>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Single reject dialog */}
          <Dialog open={corrRejectDialogOpen} onOpenChange={(o) => { if (!o) setCorrRejectDialogOpen(false); }}>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <XCircle size={18} className="text-red-500" />
                  Reject Request
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-3 py-2">
                {corrActiveRequest && (
                  <p className="text-sm text-muted-foreground">
                    Rejecting{" "}
                    <span className="font-medium text-foreground">
                      {CORRECTION_REQUEST_TYPE_LABELS[corrActiveRequest.request_type] ?? corrActiveRequest.request_type}
                    </span>{" "}
                    request from{" "}
                    <span className="font-medium text-foreground">
                      {corrActiveRequest.employee_name ?? `Employee #${corrActiveRequest.employee_id}`}
                    </span>.
                  </p>
                )}
                <Textarea
                  value={corrRejectNote}
                  onChange={(e) => setCorrRejectNote(e.target.value)}
                  rows={3}
                  className="resize-none"
                  placeholder="Reason for rejection (optional)…"
                />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setCorrRejectDialogOpen(false)} disabled={rejectRequestMutation.isPending}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={() => {
                    if (!corrActiveRequest) return;
                    rejectRequestMutation.mutate({
                      id: corrActiveRequest.id,
                      data: corrRejectNote ? { reviewer_note: corrRejectNote } : {},
                    });
                  }}
                  disabled={rejectRequestMutation.isPending}
                >
                  {rejectRequestMutation.isPending && <Loader2 size={14} className="animate-spin mr-1.5" />}
                  Reject request
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          {/* Bulk reject dialog */}
          <Dialog open={bulkRejectDialogOpen} onOpenChange={(o) => { if (!o) setBulkRejectDialogOpen(false); }}>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">
                  <XCircle size={18} className="text-red-500" />
                  Reject {selectedRequestIds.size} Request{selectedRequestIds.size !== 1 ? "s" : ""}
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-3 py-2">
                <p className="text-sm text-muted-foreground">
                  This will reject all {selectedRequestIds.size} selected pending correction requests.
                </p>
                <Textarea
                  value={bulkRejectNote}
                  onChange={(e) => setBulkRejectNote(e.target.value)}
                  rows={3}
                  className="resize-none"
                  placeholder="Reason for rejection (optional, applies to all)…"
                />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setBulkRejectDialogOpen(false)} disabled={bulkRejectMutation.isPending}>
                  Cancel
                </Button>
                <Button
                  variant="destructive"
                  onClick={() =>
                    bulkRejectMutation.mutate({
                      data: {
                        ids: Array.from(selectedRequestIds),
                        ...(bulkRejectNote ? { reviewer_note: bulkRejectNote } : {}),
                      },
                    })
                  }
                  disabled={bulkRejectMutation.isPending}
                >
                  {bulkRejectMutation.isPending && <Loader2 size={14} className="animate-spin mr-1.5" />}
                  Reject all
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      )}

      {/* Sessions table */}
      <Card className={cn(tab === "corrections" && "hidden")}>
        {tab === "live" && (
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              Currently clocked in — {liveSessions.length} employee{liveSessions.length !== 1 ? "s" : ""}
            </CardTitle>
          </CardHeader>
        )}
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-16 gap-2 text-muted-foreground">
              <Loader2 size={18} className="animate-spin" />
              Loading…
            </div>
          ) : displaySessions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-2 text-muted-foreground">
              <Clock size={30} className="opacity-30" />
              <p className="text-sm">
                {tab === "live" ? "Nobody is clocked in right now." : "No sessions found for this period."}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40">
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Employee</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Clock In</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden sm:table-cell">Clock Out</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden md:table-cell">Break</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden md:table-cell">Paid Hrs</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Status</th>
                    <th className="px-4 py-3 w-24" />
                  </tr>
                </thead>
                <tbody>
                  {displaySessions.map((s) => (
                    <tr
                      key={s.id}
                      className="border-b last:border-0 hover:bg-muted/20 transition-colors cursor-pointer"
                      onClick={() => setSelectedSession(s)}
                    >
                      <td className="px-4 py-3 font-medium">
                        {s.employee_name ?? `Employee #${s.employee_id}`}
                        {s.location_name && (
                          <div className="text-xs text-muted-foreground font-normal">{s.location_name}</div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {tab === "timesheets" ? (
                          <div>
                            <div>{formatDate(s.clock_in_at)}</div>
                            <div className="text-xs">{formatTime(s.clock_in_at)}</div>
                          </div>
                        ) : (
                          formatTime(s.clock_in_at)
                        )}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground hidden sm:table-cell">
                        {formatTime(s.clock_out_at)}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground hidden md:table-cell">
                        {formatMinutes(s.break_minutes)}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground hidden md:table-cell">
                        {formatMinutes(s.paid_minutes)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-col gap-1 items-start">
                          {sessionStatusBadge(s.status)}
                          <div className="flex flex-wrap gap-1">
                            {(s.late_minutes ?? 0) > 0 && (
                              <Badge className="text-xs gap-1 bg-amber-100 text-amber-800 border-amber-200" variant="secondary">
                                Late {formatMinutes(s.late_minutes)}
                              </Badge>
                            )}
                            {(s.early_leave_minutes ?? 0) > 0 && (
                              <Badge className="text-xs gap-1 bg-orange-100 text-orange-800 border-orange-200" variant="secondary">
                                Early {formatMinutes(s.early_leave_minutes)}
                              </Badge>
                            )}
                            {(s.overtime_minutes ?? 0) > 0 && (
                              <Badge className="text-xs gap-1 bg-purple-100 text-purple-800 border-purple-200" variant="secondary">
                                OT {formatMinutes(s.overtime_minutes)}
                              </Badge>
                            )}
                          </div>
                          {s.missed_clockout_reminder_sent_at ? (
                            <Badge className="gap-1 bg-red-100 text-red-800 border-red-200 text-[10px] leading-tight" variant="secondary">
                              <BellOff size={9} /> Follow-up sent
                            </Badge>
                          ) : s.missed_clockout_notif_sent_at ? (
                            <Badge className="gap-1 bg-amber-100 text-amber-800 border-amber-200 text-[10px] leading-tight" variant="secondary">
                              <BellOff size={9} /> Alert sent
                            </Badge>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1 justify-end" onClick={(e) => e.stopPropagation()}>
                          {s.status !== "locked" && (
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7"
                              title="Edit session"
                              onClick={() => {
                                setSelectedSession(s);
                                openEdit(s);
                              }}
                            >
                              <Edit size={13} />
                            </Button>
                          )}
                          {(s.status === "completed" || s.status === "open") && (
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7 text-emerald-600 hover:text-emerald-700"
                              title="Approve"
                              onClick={() => approveMutation.mutate({ id: s.id })}
                              disabled={approveMutation.isPending}
                            >
                              {approveMutation.isPending ? (
                                <Loader2 size={13} className="animate-spin" />
                              ) : (
                                <CheckCircle2 size={13} />
                              )}
                            </Button>
                          )}
                          {s.status !== "locked" && s.status !== "rejected" && (
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7 text-red-500 hover:text-red-600"
                              title="Reject"
                              onClick={() => {
                                setSelectedSession(s);
                                setRejectNote("");
                                setRejectDialogOpen(true);
                              }}
                            >
                              <XCircle size={13} />
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Session Detail Sheet */}
      <Sheet open={!!selectedSession && !editDialogOpen && !rejectDialogOpen} onOpenChange={(o) => { if (!o) setSelectedSession(null); }}>
        <SheetContent className="w-full sm:max-w-md overflow-y-auto">
          {selectedSession && (
            <>
              <SheetHeader className="mb-6">
                <SheetTitle className="flex items-center gap-2">
                  Session #{selectedSession.id}
                  {sessionStatusBadge(selectedSession.status)}
                </SheetTitle>
              </SheetHeader>
              <div className="space-y-5">
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <p className="text-muted-foreground text-xs mb-1">Employee</p>
                    <p className="font-medium">
                      {selectedSession.employee_name ?? `Employee #${selectedSession.employee_id}`}
                    </p>
                  </div>
                  {selectedSession.location_name && (
                    <div>
                      <p className="text-muted-foreground text-xs mb-1">Location</p>
                      <p className="font-medium">{selectedSession.location_name}</p>
                    </div>
                  )}
                  <div>
                    <p className="text-muted-foreground text-xs mb-1">Clock In</p>
                    <p className="font-medium">{formatDateTime(selectedSession.clock_in_at)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-xs mb-1">Clock Out</p>
                    <p className="font-medium">{formatTime(selectedSession.clock_out_at)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-xs mb-1">Break</p>
                    <p className="font-medium">{formatMinutes(selectedSession.break_minutes)}</p>
                  </div>
                  <div>
                    <p className="text-muted-foreground text-xs mb-1">Paid Hours</p>
                    <p className="font-medium">{formatMinutes(selectedSession.paid_minutes)}</p>
                  </div>
                  {(selectedSession.late_minutes ?? 0) > 0 && (
                    <div>
                      <p className="text-muted-foreground text-xs mb-1">Late Arrival</p>
                      <p className="font-medium text-amber-700">{formatMinutes(selectedSession.late_minutes)}</p>
                    </div>
                  )}
                  {(selectedSession.early_leave_minutes ?? 0) > 0 && (
                    <div>
                      <p className="text-muted-foreground text-xs mb-1">Early Leave</p>
                      <p className="font-medium text-orange-700">{formatMinutes(selectedSession.early_leave_minutes)}</p>
                    </div>
                  )}
                  {(selectedSession.overtime_minutes ?? 0) > 0 && (
                    <div>
                      <p className="text-muted-foreground text-xs mb-1">Overtime</p>
                      <p className="font-medium text-purple-700">{formatMinutes(selectedSession.overtime_minutes)}</p>
                    </div>
                  )}
                </div>

                {/* Late / Overtime / Early-leave chips — only shown when > 0 */}
                {((selectedSession.late_minutes ?? 0) > 0 ||
                  (selectedSession.overtime_minutes ?? 0) > 0 ||
                  (selectedSession.early_leave_minutes ?? 0) > 0) && (
                  <div className="flex flex-wrap gap-2">
                    {(selectedSession.late_minutes ?? 0) > 0 && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-orange-100 text-orange-700 text-xs font-medium px-2.5 py-1 border border-orange-200">
                        <AlertTriangle size={11} />
                        Late {formatMinutes(selectedSession.late_minutes)}
                      </span>
                    )}
                    {(selectedSession.overtime_minutes ?? 0) > 0 && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 text-blue-700 text-xs font-medium px-2.5 py-1 border border-blue-200">
                        <Clock size={11} />
                        OT {formatMinutes(selectedSession.overtime_minutes)}
                      </span>
                    )}
                    {(selectedSession.early_leave_minutes ?? 0) > 0 && (
                      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 text-amber-700 text-xs font-medium px-2.5 py-1 border border-amber-200">
                        <AlertTriangle size={11} />
                        Early leave {formatMinutes(selectedSession.early_leave_minutes)}
                      </span>
                    )}
                  </div>
                )}

                {/* Missed clock-out alert banner */}
                {selectedSession.missed_clockout_notif_sent_at && !selectedSession.clock_out_at && (
                  <div className={cn(
                    "rounded-lg border p-3 text-sm",
                    selectedSession.missed_clockout_reminder_sent_at
                      ? "bg-red-50 border-red-200 text-red-900"
                      : "bg-amber-50 border-amber-200 text-amber-900",
                  )}>
                    <div className="flex items-start gap-2">
                      <BellOff size={15} className={cn(
                        "mt-0.5 shrink-0",
                        selectedSession.missed_clockout_reminder_sent_at ? "text-red-600" : "text-amber-600",
                      )} />
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-xs mb-0.5">
                          {selectedSession.missed_clockout_reminder_sent_at
                            ? "Follow-up reminder sent"
                            : "Missed clock-out alert sent"}
                        </p>
                        <p className="text-xs opacity-80">
                          {selectedSession.missed_clockout_reminder_sent_at
                            ? `Alert sent ${formatDateTime(selectedSession.missed_clockout_notif_sent_at)}, reminder sent ${formatDateTime(selectedSession.missed_clockout_reminder_sent_at)}.`
                            : `Alert sent ${formatDateTime(selectedSession.missed_clockout_notif_sent_at)}.`}
                          {" "}This employee has not clocked out. You can clock them out now.
                        </p>
                      </div>
                    </div>
                    <div className="mt-2.5 ml-5">
                      <Button
                        size="sm"
                        className={cn(
                          "gap-1.5 h-7 text-xs",
                          selectedSession.missed_clockout_reminder_sent_at
                            ? "bg-red-600 hover:bg-red-700 text-white"
                            : "bg-amber-600 hover:bg-amber-700 text-white",
                        )}
                        onClick={() =>
                          patchMutation.mutate({
                            id: selectedSession.id,
                            data: { clock_out_at: new Date().toISOString() } as Parameters<typeof patchMutation.mutate>[0]["data"],
                          })
                        }
                        disabled={patchMutation.isPending}
                      >
                        {patchMutation.isPending ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <LogOut size={12} />
                        )}
                        Clock out now
                      </Button>
                    </div>
                  </div>
                )}

                {selectedSession.employee_note && (
                  <div className="rounded-lg bg-muted/50 p-3 text-sm">
                    <p className="text-muted-foreground text-xs mb-1">Employee note</p>
                    <p>{selectedSession.employee_note}</p>
                  </div>
                )}
                {selectedSession.manager_note && (
                  <div className="rounded-lg bg-muted/50 p-3 text-sm">
                    <p className="text-muted-foreground text-xs mb-1">Manager note</p>
                    <p>{selectedSession.manager_note}</p>
                  </div>
                )}

                {/* Actions */}
                {selectedSession.status !== "locked" && (
                  <div className="flex flex-wrap gap-2 pt-1">
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-1.5"
                      onClick={() => openEdit(selectedSession)}
                    >
                      <Edit size={14} />
                      Edit
                    </Button>
                    {(selectedSession.status === "completed" || selectedSession.status === "open") && (
                      <Button
                        size="sm"
                        className="gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white"
                        onClick={() => approveMutation.mutate({ id: selectedSession.id })}
                        disabled={approveMutation.isPending}
                      >
                        {approveMutation.isPending ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <CheckCircle2 size={14} />
                        )}
                        Approve
                      </Button>
                    )}
                    {selectedSession.status !== "rejected" && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-1.5 text-red-600 border-red-200 hover:bg-red-50"
                        onClick={() => {
                          setRejectNote("");
                          setRejectDialogOpen(true);
                        }}
                      >
                        <XCircle size={14} />
                        Reject
                      </Button>
                    )}
                    {selectedSession.status === "approved" && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-1.5"
                        onClick={() => lockMutation.mutate({ id: selectedSession.id })}
                        disabled={lockMutation.isPending}
                      >
                        {lockMutation.isPending ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <Lock size={14} />
                        )}
                        Lock for Payroll
                      </Button>
                    )}
                  </div>
                )}

                {/* Audit Log */}
                <div>
                  <h3 className="text-sm font-semibold flex items-center gap-2 mb-3">
                    <ScrollText size={15} />
                    Audit Log
                  </h3>
                  <AuditLogPanel sessionId={selectedSession.id} />
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* Edit Dialog */}
      <Dialog open={editDialogOpen} onOpenChange={(o) => { if (!o) setEditDialogOpen(false); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Session #{selectedSession?.id}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Clock In</Label>
                <Input
                  type="datetime-local"
                  value={editForm.clock_in_at}
                  onChange={(e) => setEditForm((f) => ({ ...f, clock_in_at: e.target.value }))}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Clock Out</Label>
                <Input
                  type="datetime-local"
                  value={editForm.clock_out_at}
                  onChange={(e) => setEditForm((f) => ({ ...f, clock_out_at: e.target.value }))}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Break (minutes)</Label>
              <Input
                type="number"
                min="0"
                value={editForm.break_minutes}
                onChange={(e) => setEditForm((f) => ({ ...f, break_minutes: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Manager note</Label>
              <Textarea
                value={editForm.manager_note}
                onChange={(e) => setEditForm((f) => ({ ...f, manager_note: e.target.value }))}
                rows={3}
                className="resize-none"
                placeholder="Optional note…"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditDialogOpen(false)} disabled={patchMutation.isPending}>
              Cancel
            </Button>
            <Button onClick={handleEdit} disabled={patchMutation.isPending}>
              {patchMutation.isPending && <Loader2 size={14} className="animate-spin mr-1.5" />}
              Save changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reject Dialog */}
      <Dialog open={rejectDialogOpen} onOpenChange={(o) => { if (!o) setRejectDialogOpen(false); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Reject Session</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">
              Optionally provide a note explaining why this session is being rejected.
            </p>
            <Textarea
              value={rejectNote}
              onChange={(e) => setRejectNote(e.target.value)}
              rows={3}
              className="resize-none"
              placeholder="Manager note (optional)…"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectDialogOpen(false)} disabled={rejectMutation.isPending}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (!selectedSession) return;
                rejectMutation.mutate({
                  id: selectedSession.id,
                  data: rejectNote ? { manager_note: rejectNote } : {},
                });
              }}
              disabled={rejectMutation.isPending}
            >
              {rejectMutation.isPending && <Loader2 size={14} className="animate-spin mr-1.5" />}
              Reject session
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
