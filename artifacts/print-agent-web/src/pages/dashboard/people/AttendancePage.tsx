import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import {
  Clock,
  Loader2,
  RefreshCw,
  Download,
  Check,
  X,
  Edit,
  Lock,
  ScrollText,
  Users,
  Coffee,
  AlertTriangle,
  LogOut,
  UserCheck,
  Save,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";

// ─── Types ────────────────────────────────────────────────────────────────────

type LiveSession = {
  id: number;
  employee_id: number;
  employee_name: string;
  location_name: string | null;
  clock_in_at: string;
  clock_out_at: string | null;
  status: string;
  late_minutes: number | null;
  break_minutes: number | null;
  gross_minutes: number | null;
  paid_minutes: number | null;
  breaks: { break_start_at: string; break_end_at: string | null }[] | null;
};

type TimesheetSession = {
  id: number;
  employee_id: number;
  employee_name: string;
  location_name: string | null;
  clock_in_at: string;
  clock_out_at: string | null;
  gross_minutes: number | null;
  break_minutes: number | null;
  paid_minutes: number | null;
  overtime_minutes: number | null;
  late_minutes: number | null;
  early_leave_minutes: number | null;
  status: string;
  manager_note: string | null;
  employee_note: string | null;
};

type AttendanceRequest = {
  id: number;
  employee_id: number;
  employee_name: string;
  request_type: string;
  reason: string | null;
  requested_clock_in_at: string | null;
  requested_clock_out_at: string | null;
  status: string;
  created_at: string;
  reviewer_note: string | null;
};

type AuditEntry = {
  id: number;
  action: string;
  actor_user_id: string;
  old_value_json: string | null;
  new_value_json: string | null;
  created_at: string;
};

type TeamMember = {
  id: number;
  first_name: string;
  last_name: string | null;
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function firstOfMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

function formatTime(ts: string | null) {
  if (!ts) return "—";
  return new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function formatMinutes(m: number | null | undefined) {
  if (!m) return "—";
  const h = Math.floor(m / 60);
  const min = m % 60;
  if (h === 0) return `${min}m`;
  if (min === 0) return `${h}h`;
  return `${h}h ${min}m`;
}

function sessionStatusColor(status: string) {
  switch (status) {
    case "open": return "bg-emerald-100 text-emerald-800";
    case "completed": return "bg-blue-100 text-blue-800";
    case "approved": return "bg-teal-100 text-teal-800";
    case "locked": return "bg-gray-200 text-gray-700";
    case "rejected": return "bg-red-100 text-red-800";
    case "pending_review": return "bg-amber-100 text-amber-800";
    default: return "bg-muted text-muted-foreground";
  }
}

function sessionStatusLabel(status: string) {
  const map: Record<string, string> = {
    open: "Clocked In",
    completed: "Clocked Out",
    approved: "Approved",
    locked: "Locked",
    rejected: "Rejected",
    pending_review: "Pending Review",
  };
  return map[status] ?? status;
}

function requestTypeLabel(t: string) {
  const map: Record<string, string> = {
    missed_clock_in: "Missed Clock-In",
    missed_clock_out: "Missed Clock-Out",
    edit_clock_in: "Edit Clock-In",
    edit_clock_out: "Edit Clock-Out",
    offsite_clock_in: "Off-Site Clock-In",
    offsite_clock_out: "Off-Site Clock-Out",
    other: "Other",
  };
  return map[t] ?? t;
}

// ─── Live Dashboard Tab ───────────────────────────────────────────────────────

function LiveTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [locationFilter, setLocationFilter] = useState("all");
  const [employeeFilter, setEmployeeFilter] = useState("");

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ["attendance-live"],
    queryFn: () => apiFetch("/api/admin/attendance/live"),
    refetchInterval: 60_000,
  });
  const sessions: LiveSession[] = (data as { sessions?: LiveSession[] })?.sessions ?? [];

  const filtered = sessions.filter((s) => {
    if (locationFilter !== "all" && s.location_name !== locationFilter) return false;
    if (employeeFilter && !s.employee_name.toLowerCase().includes(employeeFilter.toLowerCase())) return false;
    return true;
  });

  const present = sessions.filter((s) => s.status === "open" && !s.breaks?.some((b) => !b.break_end_at));
  const onBreak = sessions.filter((s) => s.status === "open" && s.breaks?.some((b) => !b.break_end_at));
  const late = sessions.filter((s) => (s.late_minutes ?? 0) > 0 && s.status === "open");
  const clockedOut = sessions.filter((s) => ["completed", "approved", "locked"].includes(s.status));
  const pendingReview = sessions.filter((s) => s.status === "pending_review");

  const uniqueLocations = [...new Set(sessions.map((s) => s.location_name).filter(Boolean))] as string[];

  const statCards = [
    { label: "Clocked In", count: present.length, icon: UserCheck, color: "text-emerald-600" },
    { label: "On Break", count: onBreak.length, icon: Coffee, color: "text-amber-600" },
    { label: "Late", count: late.length, icon: AlertTriangle, color: "text-orange-600" },
    { label: "Clocked Out", count: clockedOut.length, icon: LogOut, color: "text-blue-600" },
    { label: "Pending Review", count: pendingReview.length, icon: Clock, color: "text-red-600" },
    { label: "Today Total", count: sessions.length, icon: Users, color: "text-muted-foreground" },
  ];

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Today's live attendance snapshot. Auto-refreshes every minute.</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            qc.invalidateQueries({ queryKey: ["attendance-live"] });
            toast({ title: "Refreshed" });
          }}
          disabled={isFetching}
        >
          {isFetching ? <Loader2 size={13} className="animate-spin mr-1.5" /> : <RefreshCw size={13} className="mr-1.5" />}
          Refresh
        </Button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {statCards.map((c) => (
          <Card key={c.label}>
            <CardContent className="p-4 text-center">
              <c.icon size={18} className={`mx-auto mb-1 ${c.color}`} />
              <div className="text-2xl font-bold">{c.count}</div>
              <div className="text-xs text-muted-foreground mt-0.5">{c.label}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Employee</Label>
          <Input
            placeholder="Search by name…"
            value={employeeFilter}
            onChange={(e) => setEmployeeFilter(e.target.value)}
            className="w-48 h-8 text-sm"
          />
        </div>
        {uniqueLocations.length > 0 && (
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Location</Label>
            <Select value={locationFilter} onValueChange={setLocationFilter}>
              <SelectTrigger className="w-48 h-8 text-sm">
                <SelectValue placeholder="All locations" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All locations</SelectItem>
                {uniqueLocations.map((l) => (
                  <SelectItem key={l} value={l}>{l}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <Loader2 size={18} className="animate-spin mr-2" /> Loading…
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-2 text-muted-foreground">
              <Clock size={32} className="opacity-30" />
              <p className="text-sm">No sessions found for today.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40">
                    <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Employee</th>
                    <th className="text-left px-4 py-2.5 font-medium text-muted-foreground hidden md:table-cell">Location</th>
                    <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Clock In</th>
                    <th className="text-left px-4 py-2.5 font-medium text-muted-foreground hidden sm:table-cell">Late</th>
                    <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((s) => {
                    const isOnBreak = s.breaks?.some((b) => !b.break_end_at);
                    return (
                      <tr key={s.id} className="border-b last:border-0 hover:bg-muted/20 transition-colors">
                        <td className="px-4 py-3 font-medium">{s.employee_name}</td>
                        <td className="px-4 py-3 text-muted-foreground hidden md:table-cell">{s.location_name ?? "—"}</td>
                        <td className="px-4 py-3 text-muted-foreground">{formatTime(s.clock_in_at)}</td>
                        <td className="px-4 py-3 hidden sm:table-cell">
                          {(s.late_minutes ?? 0) > 0 ? (
                            <span className="text-orange-600 text-xs font-medium">{formatMinutes(s.late_minutes)}</span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <Badge
                            className={`text-xs py-0 h-5 font-normal ${isOnBreak ? "bg-amber-100 text-amber-800" : sessionStatusColor(s.status)}`}
                            variant="secondary"
                          >
                            {isOnBreak ? "On Break" : sessionStatusLabel(s.status)}
                          </Badge>
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
    </div>
  );
}

// ─── Timesheets Tab ───────────────────────────────────────────────────────────

function TimesheetsTab({ isOwner }: { isOwner: boolean }) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const [dateFrom, setDateFrom] = useState(firstOfMonth);
  const [dateTo, setDateTo] = useState(todayStr);
  const [statusFilter, setStatusFilter] = useState("all");
  const [employeeFilter, setEmployeeFilter] = useState("all");
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;

  const [auditDrawerSession, setAuditDrawerSession] = useState<TimesheetSession | null>(null);
  const [editSession, setEditSession] = useState<TimesheetSession | null>(null);
  const [rejectSession, setRejectSession] = useState<TimesheetSession | null>(null);
  const [rejectNote, setRejectNote] = useState("");
  const [lockSession, setLockSession] = useState<TimesheetSession | null>(null);
  const [exportDialog, setExportDialog] = useState(false);
  const [exportFrom, setExportFrom] = useState(firstOfMonth);
  const [exportTo, setExportTo] = useState(todayStr);

  const [editForm, setEditForm] = useState({ clock_in_at: "", clock_out_at: "", break_minutes: "", manager_note: "" });

  const { data: membersData } = useQuery({
    queryKey: ["team-members"],
    queryFn: () => apiFetch("/api/team-members"),
  });
  const members: TeamMember[] = (membersData as { team_members?: TeamMember[] })?.team_members ?? [];

  const { data, isLoading } = useQuery({
    queryKey: ["admin-timesheets", { dateFrom, dateTo, statusFilter, employeeFilter, page }],
    queryFn: () => {
      const p = new URLSearchParams();
      if (dateFrom) p.set("from", dateFrom);
      if (dateTo) p.set("to", dateTo + "T23:59:59");
      if (statusFilter !== "all") p.set("status", statusFilter);
      if (employeeFilter !== "all") p.set("employee_id", employeeFilter);
      p.set("limit", String(PAGE_SIZE));
      p.set("offset", String(page * PAGE_SIZE));
      return apiFetch(`/api/admin/attendance/timesheets?${p}`);
    },
  });
  const sessions: TimesheetSession[] = (data as { sessions?: TimesheetSession[] })?.sessions ?? [];
  const total: number = (data as { total?: number })?.total ?? 0;

  const { data: auditData, isLoading: auditLoading } = useQuery({
    queryKey: ["audit-log", auditDrawerSession?.id],
    queryFn: () => apiFetch(`/api/admin/attendance/sessions/${auditDrawerSession!.id}/audit-log`),
    enabled: !!auditDrawerSession,
  });
  const auditLogs: AuditEntry[] = (auditData as { logs?: AuditEntry[] })?.logs ?? [];

  const approveMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/admin/attendance/sessions/${id}/approve`, { method: "POST" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["admin-timesheets"] }); toast({ title: "Session approved" }); },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const rejectMutation = useMutation({
    mutationFn: ({ id, note }: { id: number; note: string }) =>
      apiFetch(`/api/admin/attendance/sessions/${id}/reject`, { method: "POST", body: JSON.stringify({ manager_note: note || undefined }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-timesheets"] });
      toast({ title: "Session rejected" });
      setRejectSession(null);
      setRejectNote("");
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const editMutation = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Record<string, unknown> }) =>
      apiFetch(`/api/admin/attendance/sessions/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-timesheets"] });
      toast({ title: "Session updated" });
      setEditSession(null);
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const lockMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/admin/attendance/sessions/${id}/lock`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-timesheets"] });
      toast({ title: "Session locked for payroll" });
      setLockSession(null);
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  function openEdit(s: TimesheetSession) {
    setEditSession(s);
    setEditForm({
      clock_in_at: s.clock_in_at ? new Date(s.clock_in_at).toISOString().slice(0, 16) : "",
      clock_out_at: s.clock_out_at ? new Date(s.clock_out_at).toISOString().slice(0, 16) : "",
      break_minutes: String(s.break_minutes ?? 0),
      manager_note: s.manager_note ?? "",
    });
  }

  function handleExport() {
    const p = new URLSearchParams();
    if (exportFrom) p.set("from", exportFrom);
    if (exportTo) p.set("to", exportTo + "T23:59:59");
    window.open(`/api/admin/attendance/export.csv?${p}`, "_blank");
    setExportDialog(false);
    toast({ title: "Export started" });
  }

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-3 items-end">
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">From</Label>
          <Input type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(0); }} className="w-40 h-8 text-sm" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">To</Label>
          <Input type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(0); }} className="w-40 h-8 text-sm" />
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Employee</Label>
          <Select value={employeeFilter} onValueChange={(v) => { setEmployeeFilter(v); setPage(0); }}>
            <SelectTrigger className="w-44 h-8 text-sm"><SelectValue placeholder="All employees" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All employees</SelectItem>
              {members.map((m) => (
                <SelectItem key={m.id} value={String(m.id)}>{m.first_name} {m.last_name ?? ""}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Status</Label>
          <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(0); }}>
            <SelectTrigger className="w-40 h-8 text-sm"><SelectValue placeholder="All statuses" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {["open", "completed", "approved", "rejected", "locked", "pending_review"].map((s) => (
                <SelectItem key={s} value={s}>{sessionStatusLabel(s)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {isOwner && (
          <Button variant="outline" size="sm" className="h-8" onClick={() => setExportDialog(true)}>
            <Download size={13} className="mr-1.5" /> Export CSV
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <Loader2 size={18} className="animate-spin mr-2" /> Loading…
            </div>
          ) : sessions.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-2 text-muted-foreground">
              <Clock size={32} className="opacity-30" />
              <p className="text-sm">No timesheet sessions for this period.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40">
                    <th className="text-left px-3 py-2.5 font-medium text-muted-foreground">Employee</th>
                    <th className="text-left px-3 py-2.5 font-medium text-muted-foreground hidden lg:table-cell">Location</th>
                    <th className="text-left px-3 py-2.5 font-medium text-muted-foreground">Clock In</th>
                    <th className="text-left px-3 py-2.5 font-medium text-muted-foreground hidden md:table-cell">Clock Out</th>
                    <th className="text-left px-3 py-2.5 font-medium text-muted-foreground hidden xl:table-cell">Gross</th>
                    <th className="text-left px-3 py-2.5 font-medium text-muted-foreground hidden xl:table-cell">Break</th>
                    <th className="text-left px-3 py-2.5 font-medium text-muted-foreground hidden xl:table-cell">Paid</th>
                    <th className="text-left px-3 py-2.5 font-medium text-muted-foreground hidden 2xl:table-cell">OT</th>
                    <th className="text-left px-3 py-2.5 font-medium text-muted-foreground hidden 2xl:table-cell">Late</th>
                    <th className="text-left px-3 py-2.5 font-medium text-muted-foreground hidden 2xl:table-cell">Early Leave</th>
                    <th className="text-left px-3 py-2.5 font-medium text-muted-foreground">Status</th>
                    <th className="px-3 py-2.5 w-28" />
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((s) => (
                    <tr key={s.id} className="border-b last:border-0 hover:bg-muted/20 transition-colors">
                      <td className="px-3 py-2.5 font-medium">
                        <div>{s.employee_name}</div>
                        {((s.late_minutes ?? 0) > 0 || (s.overtime_minutes ?? 0) > 0 || (s.early_leave_minutes ?? 0) > 0) && (
                          <div className="flex flex-wrap gap-1 mt-1 2xl:hidden">
                            {(s.late_minutes ?? 0) > 0 && (
                              <span className="inline-flex items-center gap-0.5 rounded-full bg-orange-100 text-orange-700 text-[10px] font-medium px-1.5 py-0.5 border border-orange-200">
                                <AlertTriangle size={9} />
                                Late {formatMinutes(s.late_minutes)}
                              </span>
                            )}
                            {(s.overtime_minutes ?? 0) > 0 && (
                              <span className="inline-flex items-center gap-0.5 rounded-full bg-blue-100 text-blue-700 text-[10px] font-medium px-1.5 py-0.5 border border-blue-200">
                                OT {formatMinutes(s.overtime_minutes)}
                              </span>
                            )}
                            {(s.early_leave_minutes ?? 0) > 0 && (
                              <span className="inline-flex items-center gap-0.5 rounded-full bg-amber-100 text-amber-700 text-[10px] font-medium px-1.5 py-0.5 border border-amber-200">
                                Early {formatMinutes(s.early_leave_minutes)}
                              </span>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground hidden lg:table-cell">{s.location_name ?? "—"}</td>
                      <td className="px-3 py-2.5 text-muted-foreground whitespace-nowrap">
                        {new Date(s.clock_in_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })} {formatTime(s.clock_in_at)}
                      </td>
                      <td className="px-3 py-2.5 text-muted-foreground hidden md:table-cell">{formatTime(s.clock_out_at)}</td>
                      <td className="px-3 py-2.5 text-muted-foreground hidden xl:table-cell">{formatMinutes(s.gross_minutes)}</td>
                      <td className="px-3 py-2.5 text-muted-foreground hidden xl:table-cell">{formatMinutes(s.break_minutes)}</td>
                      <td className="px-3 py-2.5 text-muted-foreground hidden xl:table-cell">{formatMinutes(s.paid_minutes)}</td>
                      <td className="px-3 py-2.5 text-muted-foreground hidden 2xl:table-cell">{formatMinutes(s.overtime_minutes)}</td>
                      <td className="px-3 py-2.5 hidden 2xl:table-cell">
                        {(s.late_minutes ?? 0) > 0 ? (
                          <span className="text-orange-600 text-xs">{formatMinutes(s.late_minutes)}</span>
                        ) : "—"}
                      </td>
                      <td className="px-3 py-2.5 hidden 2xl:table-cell">
                        {(s.early_leave_minutes ?? 0) > 0 ? (
                          <span className="text-amber-600 text-xs">{formatMinutes(s.early_leave_minutes)}</span>
                        ) : "—"}
                      </td>
                      <td className="px-3 py-2.5">
                        <Badge className={`text-xs py-0 h-5 font-normal ${sessionStatusColor(s.status)}`} variant="secondary">
                          {sessionStatusLabel(s.status)}
                        </Badge>
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-0.5 justify-end">
                          {s.status !== "locked" && (
                            <Button size="icon" variant="ghost" className="h-7 w-7 text-emerald-600" title="Approve"
                              onClick={() => approveMutation.mutate(s.id)}
                              disabled={approveMutation.isPending}>
                              <Check size={13} />
                            </Button>
                          )}
                          {s.status !== "locked" && (
                            <Button size="icon" variant="ghost" className="h-7 w-7 text-red-500" title="Reject"
                              onClick={() => { setRejectSession(s); setRejectNote(""); }}>
                              <X size={13} />
                            </Button>
                          )}
                          {s.status !== "locked" && (
                            <Button size="icon" variant="ghost" className="h-7 w-7" title="Edit" onClick={() => openEdit(s)}>
                              <Edit size={13} />
                            </Button>
                          )}
                          {isOwner && ["approved", "completed"].includes(s.status) && (
                            <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground" title="Lock"
                              onClick={() => setLockSession(s)}>
                              <Lock size={13} />
                            </Button>
                          )}
                          {isOwner && (
                            <Button size="icon" variant="ghost" className="h-7 w-7 text-muted-foreground" title="Audit Log"
                              onClick={() => setAuditDrawerSession(s)}>
                              <ScrollText size={13} />
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

      {totalPages > 1 && (
        <div className="flex items-center gap-2 justify-end text-sm text-muted-foreground">
          <Button size="sm" variant="outline" onClick={() => setPage((p) => p - 1)} disabled={page === 0}>Previous</Button>
          <span>Page {page + 1} of {totalPages}</span>
          <Button size="sm" variant="outline" onClick={() => setPage((p) => p + 1)} disabled={page >= totalPages - 1}>Next</Button>
        </div>
      )}

      {/* Reject Dialog */}
      <Dialog open={!!rejectSession} onOpenChange={(o) => { if (!o) setRejectSession(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Reject session?</DialogTitle></DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">
              Rejecting {rejectSession?.employee_name}'s session on {rejectSession?.clock_in_at ? new Date(rejectSession.clock_in_at).toLocaleDateString() : ""}.
            </p>
            <div className="space-y-1">
              <Label className="text-xs">Note (optional)</Label>
              <Textarea rows={3} value={rejectNote} onChange={(e) => setRejectNote(e.target.value)} placeholder="Reason for rejection…" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRejectSession(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => rejectSession && rejectMutation.mutate({ id: rejectSession.id, note: rejectNote })}
              disabled={rejectMutation.isPending}>
              {rejectMutation.isPending && <Loader2 size={13} className="animate-spin mr-1.5" />}
              Reject
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={!!editSession} onOpenChange={(o) => { if (!o) setEditSession(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Edit Session — {editSession?.employee_name}</DialogTitle></DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1">
              <Label className="text-xs">Clock In</Label>
              <Input type="datetime-local" value={editForm.clock_in_at}
                onChange={(e) => setEditForm((f) => ({ ...f, clock_in_at: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Clock Out</Label>
              <Input type="datetime-local" value={editForm.clock_out_at}
                onChange={(e) => setEditForm((f) => ({ ...f, clock_out_at: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Break minutes</Label>
              <Input type="number" min="0" value={editForm.break_minutes}
                onChange={(e) => setEditForm((f) => ({ ...f, break_minutes: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Manager note</Label>
              <Textarea rows={2} value={editForm.manager_note}
                onChange={(e) => setEditForm((f) => ({ ...f, manager_note: e.target.value }))} placeholder="Optional note…" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditSession(null)}>Cancel</Button>
            <Button onClick={() => {
              if (!editSession) return;
              const body: Record<string, unknown> = {};
              if (editForm.clock_in_at) body.clock_in_at = new Date(editForm.clock_in_at).toISOString();
              if (editForm.clock_out_at) body.clock_out_at = new Date(editForm.clock_out_at).toISOString();
              body.break_minutes = Number(editForm.break_minutes) || 0;
              if (editForm.manager_note) body.manager_note = editForm.manager_note;
              editMutation.mutate({ id: editSession.id, body });
            }} disabled={editMutation.isPending}>
              {editMutation.isPending && <Loader2 size={13} className="animate-spin mr-1.5" />}
              Save changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Lock Confirm */}
      <AlertDialog open={!!lockSession} onOpenChange={(o) => { if (!o) setLockSession(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Lock session for payroll?</AlertDialogTitle>
            <AlertDialogDescription>
              This will lock {lockSession?.employee_name}'s session and prevent further edits. Use this for payroll cut-off.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => lockSession && lockMutation.mutate(lockSession.id)}>Lock</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Export Dialog */}
      <Dialog open={exportDialog} onOpenChange={setExportDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader><DialogTitle>Export Timesheets as CSV</DialogTitle></DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-xs text-muted-foreground">Exports approved and locked sessions in the selected date range.</p>
            <div className="space-y-1">
              <Label className="text-xs">From</Label>
              <Input type="date" value={exportFrom} onChange={(e) => setExportFrom(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">To</Label>
              <Input type="date" value={exportTo} onChange={(e) => setExportTo(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setExportDialog(false)}>Cancel</Button>
            <Button onClick={handleExport}>
              <Download size={13} className="mr-1.5" /> Download CSV
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Audit Log Drawer */}
      <Sheet open={!!auditDrawerSession} onOpenChange={(o) => { if (!o) setAuditDrawerSession(null); }}>
        <SheetContent className="w-full sm:max-w-lg overflow-y-auto">
          <SheetHeader>
            <SheetTitle>
              Audit Log — {auditDrawerSession?.employee_name}
              <span className="ml-2 text-sm font-normal text-muted-foreground">
                {auditDrawerSession?.clock_in_at ? new Date(auditDrawerSession.clock_in_at).toLocaleDateString() : ""}
              </span>
            </SheetTitle>
          </SheetHeader>
          <div className="mt-4">
            {auditLoading ? (
              <div className="flex items-center gap-2 text-muted-foreground py-8"><Loader2 size={16} className="animate-spin" /> Loading…</div>
            ) : auditLogs.length === 0 ? (
              <p className="text-sm text-muted-foreground py-8 text-center">No audit log entries for this session.</p>
            ) : (
              <div className="space-y-3">
                {auditLogs.map((log) => (
                  <div key={log.id} className="border rounded-lg p-3 text-sm">
                    <div className="flex items-center justify-between mb-1">
                      <span className="font-medium capitalize">{log.action.replace(/_/g, " ")}</span>
                      <span className="text-xs text-muted-foreground">
                        {new Date(log.created_at).toLocaleString()}
                      </span>
                    </div>
                    {log.old_value_json && (
                      <pre className="text-xs text-muted-foreground bg-muted/30 rounded p-2 overflow-x-auto mt-1">
                        Before: {JSON.stringify(JSON.parse(log.old_value_json), null, 2)}
                      </pre>
                    )}
                    {log.new_value_json && (
                      <pre className="text-xs text-emerald-700 bg-emerald-50 rounded p-2 overflow-x-auto mt-1">
                        After: {JSON.stringify(JSON.parse(log.new_value_json), null, 2)}
                      </pre>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

// ─── Requests Tab ─────────────────────────────────────────────────────────────

function RequestsTab() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState("pending");
  const [actionDialog, setActionDialog] = useState<{ req: AttendanceRequest; action: "approve" | "reject" } | null>(null);
  const [reviewerNote, setReviewerNote] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["admin-attendance-requests", statusFilter],
    queryFn: () => apiFetch(`/api/admin/attendance/requests?status=${statusFilter}&limit=100`),
  });
  const requests: AttendanceRequest[] = (data as { requests?: AttendanceRequest[] })?.requests ?? [];

  const approveMutation = useMutation({
    mutationFn: ({ id, note }: { id: number; note: string }) =>
      apiFetch(`/api/admin/attendance/requests/${id}/approve`, { method: "POST", body: JSON.stringify({ reviewer_note: note || undefined }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-attendance-requests"] });
      toast({ title: "Request approved" });
      setActionDialog(null);
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const rejectMutation = useMutation({
    mutationFn: ({ id, note }: { id: number; note: string }) =>
      apiFetch(`/api/admin/attendance/requests/${id}/reject`, { method: "POST", body: JSON.stringify({ reviewer_note: note || undefined }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-attendance-requests"] });
      toast({ title: "Request rejected" });
      setActionDialog(null);
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  function handleAction() {
    if (!actionDialog) return;
    const { req, action } = actionDialog;
    if (action === "approve") approveMutation.mutate({ id: req.id, note: reviewerNote });
    else rejectMutation.mutate({ id: req.id, note: reviewerNote });
  }

  const isSaving = approveMutation.isPending || rejectMutation.isPending;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="space-y-1">
          <Label className="text-xs text-muted-foreground">Filter</Label>
          <Select value={statusFilter} onValueChange={setStatusFilter}>
            <SelectTrigger className="w-36 h-8 text-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="pending">Pending</SelectItem>
              <SelectItem value="approved">Approved</SelectItem>
              <SelectItem value="rejected">Rejected</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <Loader2 size={18} className="animate-spin mr-2" /> Loading…
            </div>
          ) : requests.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-2 text-muted-foreground">
              <Check size={32} className="opacity-30" />
              <p className="text-sm">No {statusFilter} correction requests.</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40">
                    <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Employee</th>
                    <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Type</th>
                    <th className="text-left px-4 py-2.5 font-medium text-muted-foreground hidden md:table-cell">Requested Times</th>
                    <th className="text-left px-4 py-2.5 font-medium text-muted-foreground hidden lg:table-cell">Reason</th>
                    <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Submitted</th>
                    <th className="px-4 py-2.5 w-24" />
                  </tr>
                </thead>
                <tbody>
                  {requests.map((r) => (
                    <tr key={r.id} className="border-b last:border-0 hover:bg-muted/20 transition-colors">
                      <td className="px-4 py-3 font-medium">{r.employee_name}</td>
                      <td className="px-4 py-3">
                        <Badge variant="outline" className="text-xs font-normal">{requestTypeLabel(r.request_type)}</Badge>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground text-xs hidden md:table-cell">
                        {r.requested_clock_in_at && <div>In: {formatTime(r.requested_clock_in_at)}</div>}
                        {r.requested_clock_out_at && <div>Out: {formatTime(r.requested_clock_out_at)}</div>}
                        {!r.requested_clock_in_at && !r.requested_clock_out_at && "—"}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground text-xs hidden lg:table-cell max-w-xs truncate">{r.reason ?? "—"}</td>
                      <td className="px-4 py-3 text-muted-foreground text-xs">{new Date(r.created_at).toLocaleDateString()}</td>
                      <td className="px-4 py-3">
                        {r.status === "pending" && (
                          <div className="flex items-center gap-1 justify-end">
                            <Button size="sm" variant="outline" className="h-7 text-emerald-700 border-emerald-200 hover:bg-emerald-50"
                              onClick={() => { setActionDialog({ req: r, action: "approve" }); setReviewerNote(""); }}>
                              <Check size={12} className="mr-1" /> Approve
                            </Button>
                            <Button size="sm" variant="outline" className="h-7 text-red-600 border-red-200 hover:bg-red-50"
                              onClick={() => { setActionDialog({ req: r, action: "reject" }); setReviewerNote(""); }}>
                              <X size={12} className="mr-1" /> Reject
                            </Button>
                          </div>
                        )}
                        {r.status !== "pending" && (
                          <Badge className={r.status === "approved" ? "bg-teal-100 text-teal-800 text-xs" : "bg-red-100 text-red-800 text-xs"} variant="secondary">
                            {r.status}
                          </Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!actionDialog} onOpenChange={(o) => { if (!o) setActionDialog(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {actionDialog?.action === "approve" ? "Approve" : "Reject"} Correction Request
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">
              {actionDialog?.req.employee_name} — {requestTypeLabel(actionDialog?.req.request_type ?? "")}
            </p>
            {actionDialog?.req.reason && (
              <p className="text-sm bg-muted/40 rounded p-2">"{actionDialog.req.reason}"</p>
            )}
            <div className="space-y-1">
              <Label className="text-xs">Reviewer note (optional)</Label>
              <Textarea rows={2} value={reviewerNote} onChange={(e) => setReviewerNote(e.target.value)} placeholder="Add a note…" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setActionDialog(null)}>Cancel</Button>
            <Button
              variant={actionDialog?.action === "reject" ? "destructive" : "default"}
              onClick={handleAction}
              disabled={isSaving}
            >
              {isSaving && <Loader2 size={13} className="animate-spin mr-1.5" />}
              {actionDialog?.action === "approve" ? "Approve" : "Reject"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ─── Settings Tab ─────────────────────────────────────────────────────────────

type LocationRow = {
  id: number;
  name: string;
  attendance_enabled: boolean | null;
  geofence_radius_meters: number | null;
  latitude: number | null;
  longitude: number | null;
};

function SettingsTab() {
  const { isOwner } = useWorkspaceRole();
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: locData } = useQuery({
    queryKey: ["locations"],
    queryFn: () => apiFetch("/api/locations"),
  });
  const locations = (locData as { locations?: LocationRow[] })?.locations ?? [];

  const [geofenceEdits, setGeofenceEdits] = useState<Record<number, string>>({});
  const [savingRow, setSavingRow] = useState<number | null>(null);

  const patchLocation = useCallback(
    async (id: number, patch: { geofence_radius_meters?: number | null; attendance_enabled?: boolean }) => {
      setSavingRow(id);
      try {
        await apiFetch(`/api/locations/${id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        await qc.invalidateQueries({ queryKey: ["locations"] });
        toast({ title: "Saved", description: "Location settings updated." });
        setGeofenceEdits((prev) => { const next = { ...prev }; delete next[id]; return next; });
      } catch {
        toast({ title: "Error", description: "Failed to save location settings.", variant: "destructive" });
      } finally {
        setSavingRow(null);
      }
    },
    [qc, toast],
  );

  const { data: membersData } = useQuery({
    queryKey: ["team-members"],
    queryFn: () => apiFetch("/api/team-members"),
  });
  const members = (membersData as { team_members?: { id: number; first_name: string; last_name: string | null; job_title: string | null; department_name: string | null; employment_status: string }[] })?.team_members ?? [];

  return (
    <div className="space-y-6 max-w-3xl">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Locations</CardTitle>
          <p className="text-sm text-muted-foreground">
            {isOwner
              ? "Configure attendance tracking and geofence radius per location."
              : "Locations with attendance tracking configuration."}
          </p>
        </CardHeader>
        <CardContent className="p-0">
          {locations.length === 0 ? (
            <p className="text-sm text-muted-foreground px-4 pb-4">No locations configured.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40">
                    <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Location</th>
                    <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Geofence (m)</th>
                    <th className="text-left px-4 py-2.5 font-medium text-muted-foreground hidden md:table-cell">Coordinates</th>
                    <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Attendance</th>
                    {isOwner && <th className="px-4 py-2.5" />}
                  </tr>
                </thead>
                <tbody>
                  {locations.map((l) => {
                    const editedRadius = geofenceEdits[l.id];
                    const radiusDirty = editedRadius !== undefined && editedRadius !== String(l.geofence_radius_meters ?? "");
                    const isSaving = savingRow === l.id;

                    return (
                      <tr key={l.id} className="border-b last:border-0">
                        <td className="px-4 py-3 font-medium">{l.name}</td>
                        <td className="px-4 py-3">
                          {isOwner ? (
                            <Input
                              type="number"
                              min={1}
                              className="h-7 w-24 text-sm"
                              value={editedRadius !== undefined ? editedRadius : (l.geofence_radius_meters ?? "")}
                              onChange={(e) => setGeofenceEdits((prev) => ({ ...prev, [l.id]: e.target.value }))}
                              disabled={isSaving}
                            />
                          ) : (
                            <span className="text-muted-foreground">{l.geofence_radius_meters ?? "—"}</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground text-xs hidden md:table-cell">
                          {l.latitude != null && l.longitude != null
                            ? `${Number(l.latitude).toFixed(4)}, ${Number(l.longitude).toFixed(4)}`
                            : "Not set"}
                        </td>
                        <td className="px-4 py-3">
                          {isOwner ? (
                            <Switch
                              checked={l.attendance_enabled ?? false}
                              disabled={isSaving}
                              onCheckedChange={(checked) => patchLocation(l.id, { attendance_enabled: checked })}
                            />
                          ) : (
                            <Badge
                              className={l.attendance_enabled ? "bg-emerald-100 text-emerald-800 text-xs" : "bg-muted text-muted-foreground text-xs"}
                              variant="secondary"
                            >
                              {l.attendance_enabled ? "Enabled" : "Disabled"}
                            </Badge>
                          )}
                        </td>
                        {isOwner && (
                          <td className="px-4 py-3">
                            {radiusDirty && (
                              <Button
                                size="sm"
                                variant="outline"
                                className="h-7 gap-1.5 text-xs"
                                disabled={isSaving}
                                onClick={() => {
                                  const val = editedRadius.trim() === "" ? null : parseInt(editedRadius, 10);
                                  if (editedRadius.trim() !== "" && (Number.isNaN(val) || (val !== null && val < 1))) {
                                    toast({ title: "Invalid radius", description: "Enter a positive whole number.", variant: "destructive" });
                                    return;
                                  }
                                  patchLocation(l.id, { geofence_radius_meters: val });
                                }}
                              >
                                {isSaving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
                                Save
                              </Button>
                            )}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Team Members</CardTitle>
          <p className="text-sm text-muted-foreground">
            All active team members. To assign managers, schedules, or enable attendance tracking, edit from the{" "}
            <a href="/people" className="underline hover:text-foreground">People</a> page.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          {members.length === 0 ? (
            <p className="text-sm text-muted-foreground px-4 pb-4">No team members found.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40">
                    <th className="text-left px-4 py-2.5 font-medium text-muted-foreground">Employee</th>
                    <th className="text-left px-4 py-2.5 font-medium text-muted-foreground hidden md:table-cell">Job Title</th>
                    <th className="text-left px-4 py-2.5 font-medium text-muted-foreground hidden lg:table-cell">Department</th>
                    <th className="text-left px-4 py-2.5 font-medium text-muted-foreground hidden sm:table-cell">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {members.map((m) => (
                    <tr key={m.id} className="border-b last:border-0 hover:bg-muted/20 transition-colors">
                      <td className="px-4 py-3 font-medium">{m.first_name} {m.last_name ?? ""}</td>
                      <td className="px-4 py-3 text-muted-foreground hidden md:table-cell">{m.job_title ?? "—"}</td>
                      <td className="px-4 py-3 text-muted-foreground hidden lg:table-cell">{m.department_name ?? "—"}</td>
                      <td className="px-4 py-3 hidden sm:table-cell">
                        <Badge variant="secondary" className="text-xs py-0 h-5 font-normal capitalize">
                          {m.employment_status?.replace("_", " ") ?? "—"}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

type Tab = "live" | "timesheets" | "requests" | "settings";

export default function AttendancePage() {
  const { isOwner } = useWorkspaceRole();
  const [tab, setTab] = useState<Tab>("live");

  const tabs: { id: Tab; label: string }[] = [
    { id: "live", label: "Live" },
    { id: "timesheets", label: "Timesheets" },
    { id: "requests", label: "Requests" },
    { id: "settings", label: "Settings" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Clock size={22} />
        <div>
          <h1 className="text-2xl font-bold">Attendance</h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            Track and manage team attendance, timesheets, and correction requests.
          </p>
        </div>
      </div>

      <div className="flex gap-1 border-b">
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === t.id
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "live" && <LiveTab />}
      {tab === "timesheets" && <TimesheetsTab isOwner={isOwner} />}
      {tab === "requests" && <RequestsTab />}
      {tab === "settings" && <SettingsTab />}
    </div>
  );
}
