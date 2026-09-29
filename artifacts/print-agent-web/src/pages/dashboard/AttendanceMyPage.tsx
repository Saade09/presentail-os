import { useState, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetAttendanceToday,
  useClockIn,
  useClockOut,
  useStartBreak,
  useEndBreak,
  useGetMyTimesheets,
  useCreateAttendanceRequest,
  useGetMyAttendanceRequests,
  getGetAttendanceTodayQueryKey,
  getGetMyTimesheetsQueryKey,
  getGetMyAttendanceRequestsQueryKey,
} from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
  Coffee,
  LogIn,
  LogOut,
  FileEdit,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertCircle,
  AlertTriangle,
  Timer,
  HelpCircle,
  ListChecks,
} from "lucide-react";

type Session = {
  id: number;
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
};

type BreakRecord = {
  id: number;
  started_at: string;
  ended_at: string | null;
  break_type: string | null;
};

type AttendanceRequest = {
  id: number;
  attendance_session_id: number | null;
  request_type: string;
  status: string;
  reason: string | null;
  reviewer_note: string | null;
  created_at: string;
};

const REQUEST_TYPES = [
  { value: "missed_clock_in", label: "Missed Clock-In" },
  { value: "missed_clock_out", label: "Missed Clock-Out" },
  { value: "edit_clock_in", label: "Edit Clock-In Time" },
  { value: "edit_clock_out", label: "Edit Clock-Out Time" },
  { value: "offsite_clock_in", label: "Offsite Clock-In" },
  { value: "offsite_clock_out", label: "Offsite Clock-Out" },
  { value: "other", label: "Other" },
];

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
        <Badge className="gap-1 bg-emerald-100 text-emerald-800 border-emerald-200" variant="secondary">
          <CheckCircle2 size={10} /> Completed
        </Badge>
      );
    case "approved":
      return (
        <Badge className="gap-1 bg-green-100 text-green-800 border-green-200" variant="secondary">
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
          Locked
        </Badge>
      );
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

function requestStatusBadge(status: string) {
  switch (status) {
    case "pending":
      return (
        <Badge className="gap-1 bg-amber-100 text-amber-800 border-amber-200 text-xs" variant="secondary">
          <HelpCircle size={9} /> Pending
        </Badge>
      );
    case "approved":
      return (
        <Badge className="gap-1 bg-green-100 text-green-800 border-green-200 text-xs" variant="secondary">
          <CheckCircle2 size={9} /> Approved
        </Badge>
      );
    case "rejected":
      return (
        <Badge className="gap-1 bg-red-100 text-red-800 border-red-200 text-xs" variant="secondary">
          <XCircle size={9} /> Rejected
        </Badge>
      );
    default:
      return null;
  }
}

function formatTime(ts: string | null | undefined) {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
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

export default function AttendanceMyPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [dateFrom, setDateFrom] = useState(firstOfMonth);
  const [dateTo, setDateTo] = useState(todayStr);
  const [requestDialogOpen, setRequestDialogOpen] = useState(false);
  const [requestStatusFilter, setRequestStatusFilter] = useState("all");
  const [requestForm, setRequestForm] = useState({
    attendance_session_id: null as number | null,
    request_type: "",
    reason: "",
    requested_clock_in_at: "",
    requested_clock_out_at: "",
  });

  const { data: todayData, isLoading: todayLoading } = useGetAttendanceToday();
  const openSession = (todayData as Record<string, unknown> | undefined)?.openSession as Session | null | undefined;
  const activeBreak = (todayData as Record<string, unknown> | undefined)?.activeBreak as BreakRecord | null | undefined;

  const { data: timesheetsData, isLoading: timesheetsLoading } = useGetMyTimesheets({
    from: dateFrom,
    to: dateTo,
    limit: 50,
  });
  const sessions: Session[] = ((timesheetsData as Record<string, unknown> | undefined)?.sessions as Session[] | undefined) ?? [];

  const sessionTotals = useMemo(() => ({
    lateMinutes: sessions.reduce((acc, s) => acc + (s.late_minutes ?? 0), 0),
    earlyLeaveMinutes: sessions.reduce((acc, s) => acc + (s.early_leave_minutes ?? 0), 0),
    overtimeMinutes: sessions.reduce((acc, s) => acc + (s.overtime_minutes ?? 0), 0),
  }), [sessions]);

  const { data: myRequestsData } = useGetMyAttendanceRequests();
  const myRequests: AttendanceRequest[] = ((myRequestsData as Record<string, unknown> | undefined)?.requests as AttendanceRequest[] | undefined) ?? [];

  const pendingBySession = new Map<number, AttendanceRequest>();
  const latestBySession = new Map<number, AttendanceRequest>();
  const sessionsById = new Map<number, Session>();
  for (const s of sessions) sessionsById.set(s.id, s);
  for (const r of myRequests) {
    if (r.attendance_session_id == null) continue;
    const sid = r.attendance_session_id;
    if (!latestBySession.has(sid)) latestBySession.set(sid, r);
    if (r.status === "pending" && !pendingBySession.has(sid)) {
      pendingBySession.set(sid, r);
    }
  }

  const filteredRequests =
    requestStatusFilter === "all"
      ? myRequests
      : myRequests.filter((r) => r.status === requestStatusFilter);

  const clockInMutation = useClockIn({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetAttendanceTodayQueryKey() });
        qc.invalidateQueries({ queryKey: getGetMyTimesheetsQueryKey() });
        toast({ title: "Clocked in successfully" });
      },
      onError: (err: Error) =>
        toast({ title: "Clock-in failed", description: err.message, variant: "destructive" }),
    },
  });

  const clockOutMutation = useClockOut({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetAttendanceTodayQueryKey() });
        qc.invalidateQueries({ queryKey: getGetMyTimesheetsQueryKey() });
        toast({ title: "Clocked out successfully" });
      },
      onError: (err: Error) =>
        toast({ title: "Clock-out failed", description: err.message, variant: "destructive" }),
    },
  });

  const startBreakMutation = useStartBreak({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetAttendanceTodayQueryKey() });
        toast({ title: "Break started" });
      },
      onError: (err: Error) =>
        toast({ title: "Error", description: err.message, variant: "destructive" }),
    },
  });

  const endBreakMutation = useEndBreak({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetAttendanceTodayQueryKey() });
        toast({ title: "Break ended" });
      },
      onError: (err: Error) =>
        toast({ title: "Error", description: err.message, variant: "destructive" }),
    },
  });

  const createRequestMutation = useCreateAttendanceRequest({
    mutation: {
      onSuccess: () => {
        toast({ title: "Correction request submitted" });
        setRequestDialogOpen(false);
        setRequestForm({
          attendance_session_id: null,
          request_type: "",
          reason: "",
          requested_clock_in_at: "",
          requested_clock_out_at: "",
        });
        qc.invalidateQueries({ queryKey: getGetMyAttendanceRequestsQueryKey() });
      },
      onError: (err: Error) =>
        toast({ title: "Error", description: err.message, variant: "destructive" }),
    },
  });

  const isClocked = !!openSession;
  const isOnBreak = !!activeBreak;

  function handleClockIn() {
    clockInMutation.mutate({ data: {} });
  }

  function handleClockOut() {
    clockOutMutation.mutate({ data: {} });
  }

  function handleStartBreak() {
    startBreakMutation.mutate({ data: {} });
  }

  function handleEndBreak() {
    endBreakMutation.mutate();
  }

  function openCorrectionDialog(session?: Session) {
    setRequestForm({
      attendance_session_id: session?.id ?? null,
      request_type: "",
      reason: "",
      requested_clock_in_at: "",
      requested_clock_out_at: "",
    });
    setRequestDialogOpen(true);
  }

  function handleSubmitRequest() {
    const body: Record<string, unknown> = {
      request_type: requestForm.request_type,
      reason: requestForm.reason || undefined,
    };
    if (requestForm.attendance_session_id != null) {
      body.attendance_session_id = requestForm.attendance_session_id;
    }
    if (requestForm.requested_clock_in_at) body.requested_clock_in_at = requestForm.requested_clock_in_at;
    if (requestForm.requested_clock_out_at) body.requested_clock_out_at = requestForm.requested_clock_out_at;
    createRequestMutation.mutate({ data: body as Parameters<typeof createRequestMutation.mutate>[0]["data"] });
  }

  const busyClock = clockInMutation.isPending || clockOutMutation.isPending;
  const busyBreak = startBreakMutation.isPending || endBreakMutation.isPending;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Clock size={22} />
          My Attendance
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Track your clock-in/out, breaks, and view your timesheet history.
        </p>
      </div>

      <Tabs defaultValue="timesheet">
        <TabsList className="mb-2">
          <TabsTrigger value="timesheet" className="gap-2">
            <Clock size={14} /> Timesheet
          </TabsTrigger>
          <TabsTrigger value="my-requests" className="gap-2">
            <ListChecks size={14} /> My Requests
            {myRequests.filter((r) => r.status === "pending").length > 0 && (
              <Badge className="ml-1 h-4 min-w-4 px-1 text-[10px] bg-amber-500 text-white border-0">
                {myRequests.filter((r) => r.status === "pending").length}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="timesheet" className="space-y-6 mt-0">

      {/* Today's Status Card */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Today's Status</CardTitle>
        </CardHeader>
        <CardContent>
          {todayLoading ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <Loader2 size={16} className="animate-spin" />
              Loading…
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                {!isClocked ? (
                  <Button
                    onClick={handleClockIn}
                    disabled={busyClock}
                    className="gap-2"
                  >
                    {clockInMutation.isPending ? (
                      <Loader2 size={16} className="animate-spin" />
                    ) : (
                      <LogIn size={16} />
                    )}
                    Clock In
                  </Button>
                ) : (
                  <>
                    <Button
                      variant="destructive"
                      onClick={handleClockOut}
                      disabled={busyClock}
                      className="gap-2"
                    >
                      {clockOutMutation.isPending ? (
                        <Loader2 size={16} className="animate-spin" />
                      ) : (
                        <LogOut size={16} />
                      )}
                      Clock Out
                    </Button>
                    {!isOnBreak ? (
                      <Button
                        variant="outline"
                        onClick={handleStartBreak}
                        disabled={busyBreak}
                        className="gap-2"
                      >
                        {startBreakMutation.isPending ? (
                          <Loader2 size={16} className="animate-spin" />
                        ) : (
                          <Coffee size={16} />
                        )}
                        Start Break
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        onClick={handleEndBreak}
                        disabled={busyBreak}
                        className="gap-2 border-amber-300 text-amber-700 hover:bg-amber-50"
                      >
                        {endBreakMutation.isPending ? (
                          <Loader2 size={16} className="animate-spin" />
                        ) : (
                          <Timer size={16} />
                        )}
                        End Break
                      </Button>
                    )}
                  </>
                )}

                <Button
                  variant="outline"
                  size="sm"
                  className="gap-2 ml-auto"
                  onClick={() => openCorrectionDialog()}
                >
                  <FileEdit size={15} />
                  Submit Correction
                </Button>
              </div>

              {isClocked && openSession && (
                <div className="rounded-lg border border-blue-100 bg-blue-50 px-4 py-3 text-sm space-y-1">
                  <div className="flex items-center gap-2 font-medium text-blue-800">
                    <Clock size={14} />
                    Currently clocked in since {formatTime(openSession.clock_in_at)}
                  </div>
                  {isOnBreak && activeBreak && (
                    <div className="flex items-center gap-2 text-amber-700">
                      <Coffee size={13} />
                      On break since {formatTime(activeBreak.started_at)}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Timesheet History */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <CardTitle className="text-base">My Timesheet</CardTitle>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <Label className="text-xs">From</Label>
                <Input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className="h-8 w-36 text-sm"
                />
              </div>
              <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <Label className="text-xs">To</Label>
                <Input
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  className="h-8 w-36 text-sm"
                />
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {timesheetsLoading ? (
            <div className="flex items-center justify-center py-12 gap-2 text-muted-foreground text-sm">
              <Loader2 size={16} className="animate-spin" />
              Loading…
            </div>
          ) : sessions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 gap-2 text-muted-foreground">
              <Clock size={30} className="opacity-30" />
              <p className="text-sm">No sessions found for this period.</p>
            </div>
          ) : (
            <>
            {(sessionTotals.lateMinutes > 0 || sessionTotals.earlyLeaveMinutes > 0 || sessionTotals.overtimeMinutes > 0) && (
              <div className="flex flex-wrap gap-3 px-4 pt-4 pb-2">
                {sessionTotals.lateMinutes > 0 && (
                  <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm">
                    <AlertTriangle size={13} className="text-amber-500 shrink-0" />
                    <span className="text-muted-foreground">Total late:</span>
                    <span className="font-semibold text-amber-700">{formatMinutes(sessionTotals.lateMinutes)}</span>
                  </div>
                )}
                {sessionTotals.earlyLeaveMinutes > 0 && (
                  <div className="flex items-center gap-2 rounded-md border border-orange-200 bg-orange-50 px-3 py-2 text-sm">
                    <LogOut size={13} className="text-orange-500 shrink-0" />
                    <span className="text-muted-foreground">Total early leave:</span>
                    <span className="font-semibold text-orange-700">{formatMinutes(sessionTotals.earlyLeaveMinutes)}</span>
                  </div>
                )}
                {sessionTotals.overtimeMinutes > 0 && (
                  <div className="flex items-center gap-2 rounded-md border border-purple-200 bg-purple-50 px-3 py-2 text-sm">
                    <Timer size={13} className="text-purple-500 shrink-0" />
                    <span className="text-muted-foreground">Total overtime:</span>
                    <span className="font-semibold text-purple-700">{formatMinutes(sessionTotals.overtimeMinutes)}</span>
                  </div>
                )}
              </div>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40">
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Date</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden sm:table-cell">Clock In</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden sm:table-cell">Clock Out</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden md:table-cell">Break</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden md:table-cell">Paid Hours</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Status</th>
                    <th className="px-4 py-3 w-36" />
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((s) => {
                    const pendingReq = pendingBySession.get(s.id);
                    const latestReq = latestBySession.get(s.id);
                    const displayReq = pendingReq ?? latestReq;
                    return (
                      <tr key={s.id} className="border-b last:border-0 hover:bg-muted/20 transition-colors">
                        <td className="px-4 py-3">
                          <div className="font-medium">{formatDate(s.clock_in_at)}</div>
                          {s.employee_note && (
                            <div className="text-xs text-muted-foreground mt-0.5 truncate max-w-[160px]">
                              {s.employee_note}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground hidden sm:table-cell">
                          {formatTime(s.clock_in_at)}
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
                            {displayReq && requestStatusBadge(displayReq.status)}
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
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right">
                          {s.status !== "locked" && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 text-xs gap-1 text-muted-foreground hover:text-foreground"
                              onClick={() => openCorrectionDialog(s)}
                            >
                              <FileEdit size={12} />
                              Request Correction
                            </Button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            </>
          )}
        </CardContent>
      </Card>

        </TabsContent>

        {/* ── My Requests Tab ──────────────────────────────────────── */}
        <TabsContent value="my-requests" className="mt-0">
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between flex-wrap gap-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <ListChecks size={16} />
                  My Correction Requests
                </CardTitle>
                <Select value={requestStatusFilter} onValueChange={setRequestStatusFilter}>
                  <SelectTrigger className="h-8 w-36 text-sm">
                    <SelectValue placeholder="Filter by status" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All statuses</SelectItem>
                    <SelectItem value="pending">Pending</SelectItem>
                    <SelectItem value="approved">Approved</SelectItem>
                    <SelectItem value="rejected">Rejected</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {filteredRequests.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 gap-2 text-muted-foreground">
                  <ListChecks size={30} className="opacity-30" />
                  <p className="text-sm">
                    {requestStatusFilter === "all"
                      ? "You haven't submitted any correction requests yet."
                      : `No ${requestStatusFilter} requests found.`}
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b bg-muted/40">
                        <th className="text-left px-4 py-3 font-medium text-muted-foreground">Type</th>
                        <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden sm:table-cell">Session Date</th>
                        <th className="text-left px-4 py-3 font-medium text-muted-foreground">Status</th>
                        <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden md:table-cell">Reviewer Note</th>
                        <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden sm:table-cell">Submitted</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredRequests.map((r) => {
                        const typeLabel =
                          REQUEST_TYPES.find((t) => t.value === r.request_type)?.label ??
                          r.request_type;
                        const linkedSession =
                          r.attendance_session_id != null
                            ? sessionsById.get(r.attendance_session_id)
                            : undefined;
                        const sessionDate = linkedSession
                          ? formatDate(linkedSession.clock_in_at)
                          : r.attendance_session_id != null
                          ? `#${r.attendance_session_id}`
                          : "—";
                        return (
                          <tr
                            key={r.id}
                            className="border-b last:border-0 hover:bg-muted/20 transition-colors"
                          >
                            <td className="px-4 py-3 font-medium">{typeLabel}</td>
                            <td className="px-4 py-3 text-muted-foreground hidden sm:table-cell">
                              {sessionDate}
                            </td>
                            <td className="px-4 py-3">
                              {requestStatusBadge(r.status)}
                            </td>
                            <td className="px-4 py-3 text-muted-foreground hidden md:table-cell max-w-xs">
                              {r.reviewer_note ? (
                                <span className="text-xs">{r.reviewer_note}</span>
                              ) : (
                                <span className="text-muted-foreground/40 text-xs">—</span>
                              )}
                            </td>
                            <td className="px-4 py-3 text-muted-foreground hidden sm:table-cell text-xs">
                              {formatDate(r.created_at)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

      </Tabs>

      {/* Correction Request Dialog */}
      <Dialog open={requestDialogOpen} onOpenChange={setRequestDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertCircle size={18} />
              Submit Correction Request
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {requestForm.attendance_session_id != null && (
              <p className="text-xs text-muted-foreground bg-muted/40 rounded px-3 py-2">
                Linked to session #{requestForm.attendance_session_id}
              </p>
            )}
            <div className="space-y-1.5">
              <Label>
                Request type <span className="text-destructive">*</span>
              </Label>
              <Select
                value={requestForm.request_type}
                onValueChange={(v) => setRequestForm((f) => ({ ...f, request_type: v }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select a reason…" />
                </SelectTrigger>
                <SelectContent>
                  {REQUEST_TYPES.map((rt) => (
                    <SelectItem key={rt.value} value={rt.value}>
                      {rt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {(requestForm.request_type === "missed_clock_in" ||
              requestForm.request_type === "edit_clock_in" ||
              requestForm.request_type === "offsite_clock_in") && (
              <div className="space-y-1.5">
                <Label>Requested clock-in time</Label>
                <Input
                  type="datetime-local"
                  value={requestForm.requested_clock_in_at}
                  onChange={(e) =>
                    setRequestForm((f) => ({ ...f, requested_clock_in_at: e.target.value }))
                  }
                />
              </div>
            )}

            {(requestForm.request_type === "missed_clock_out" ||
              requestForm.request_type === "edit_clock_out" ||
              requestForm.request_type === "offsite_clock_out") && (
              <div className="space-y-1.5">
                <Label>Requested clock-out time</Label>
                <Input
                  type="datetime-local"
                  value={requestForm.requested_clock_out_at}
                  onChange={(e) =>
                    setRequestForm((f) => ({ ...f, requested_clock_out_at: e.target.value }))
                  }
                />
              </div>
            )}

            <div className="space-y-1.5">
              <Label>Reason / notes</Label>
              <Textarea
                value={requestForm.reason}
                onChange={(e) => setRequestForm((f) => ({ ...f, reason: e.target.value }))}
                placeholder="Explain why you're submitting this request…"
                className="resize-none"
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setRequestDialogOpen(false)}
              disabled={createRequestMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={handleSubmitRequest}
              disabled={!requestForm.request_type || createRequestMutation.isPending}
            >
              {createRequestMutation.isPending && (
                <Loader2 size={14} className="animate-spin mr-1.5" />
              )}
              Submit request
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
