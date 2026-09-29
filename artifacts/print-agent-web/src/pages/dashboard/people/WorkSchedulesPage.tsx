import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
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
  CalendarClock,
  Plus,
  Edit,
  Trash2,
  Loader2,
  Clock,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

const DAYS_ORDER = [
  { key: "monday", label: "Mon" },
  { key: "tuesday", label: "Tue" },
  { key: "wednesday", label: "Wed" },
  { key: "thursday", label: "Thu" },
  { key: "friday", label: "Fri" },
  { key: "saturday", label: "Sat" },
  { key: "sunday", label: "Sun" },
];

type ScheduleDay = {
  id?: number;
  day_of_week: string;
  is_working_day: boolean;
  start_time: string | null;
  end_time: string | null;
  break_minutes: number;
};

type WorkSchedule = {
  id: number;
  name: string;
  description: string | null;
  status: string;
  default_timezone: string;
  overtime_after_minutes: number;
  break_policy_minutes: number;
  days: ScheduleDay[] | null;
};

type DayForm = {
  is_working_day: boolean;
  start_time: string;
  end_time: string;
  break_minutes: string;
};

function buildDefaultDays(): DayForm[] {
  return DAYS_ORDER.map((d) => ({
    is_working_day: !["saturday", "sunday"].includes(d.key),
    start_time: "09:00",
    end_time: "17:00",
    break_minutes: "60",
  }));
}

function workingDaySummary(days: ScheduleDay[] | null) {
  if (!days || days.length === 0) return "No days configured";
  const working = days.filter((d) => d.is_working_day);
  if (working.length === 0) return "No working days";
  const labels = DAYS_ORDER.filter((d) => working.some((w) => w.day_of_week === d.key)).map((d) => d.label);
  return labels.join(", ");
}

export default function WorkSchedulesPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { isOwner } = useWorkspaceRole();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState<WorkSchedule | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WorkSchedule | null>(null);

  const [formName, setFormName] = useState("");
  const [formDesc, setFormDesc] = useState("");
  const [formTimezone, setFormTimezone] = useState("UTC");
  const [formOvertimeAfter, setFormOvertimeAfter] = useState("480");
  const [formBreakPolicy, setFormBreakPolicy] = useState("0");
  const [formDays, setFormDays] = useState<DayForm[]>(buildDefaultDays());

  const { data, isLoading } = useQuery({
    queryKey: ["work-schedules"],
    queryFn: () => apiFetch("/api/work-schedules"),
  });
  const schedules: WorkSchedule[] = (data as { work_schedules?: WorkSchedule[] })?.work_schedules ?? [];

  const createMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch("/api/work-schedules", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["work-schedules"] });
      toast({ title: "Work schedule created" });
      setDialogOpen(false);
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Record<string, unknown> }) =>
      apiFetch(`/api/work-schedules/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["work-schedules"] });
      toast({ title: "Work schedule updated" });
      setDialogOpen(false);
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/work-schedules/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["work-schedules"] });
      toast({ title: "Work schedule deleted" });
      setDeleteTarget(null);
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  function openAdd() {
    setEditingSchedule(null);
    setFormName("");
    setFormDesc("");
    setFormTimezone("UTC");
    setFormOvertimeAfter("480");
    setFormBreakPolicy("0");
    setFormDays(buildDefaultDays());
    setDialogOpen(true);
  }

  function openEdit(s: WorkSchedule) {
    setEditingSchedule(s);
    setFormName(s.name);
    setFormDesc(s.description ?? "");
    setFormTimezone(s.default_timezone);
    setFormOvertimeAfter(String(s.overtime_after_minutes ?? 480));
    setFormBreakPolicy(String(s.break_policy_minutes ?? 0));
    const days = DAYS_ORDER.map((d) => {
      const existing = s.days?.find((sd) => sd.day_of_week === d.key);
      return {
        is_working_day: existing?.is_working_day ?? !["saturday", "sunday"].includes(d.key),
        start_time: existing?.start_time ?? "09:00",
        end_time: existing?.end_time ?? "17:00",
        break_minutes: String(existing?.break_minutes ?? 60),
      };
    });
    setFormDays(days);
    setDialogOpen(true);
  }

  function handleSubmit() {
    const days = DAYS_ORDER.map((d, i) => ({
      day_of_week: d.key,
      is_working_day: formDays[i].is_working_day,
      start_time: formDays[i].is_working_day ? (formDays[i].start_time || null) : null,
      end_time: formDays[i].is_working_day ? (formDays[i].end_time || null) : null,
      break_minutes: Number(formDays[i].break_minutes) || 0,
    }));
    const body = {
      name: formName.trim(),
      description: formDesc.trim() || null,
      default_timezone: formTimezone || "UTC",
      overtime_after_minutes: Number(formOvertimeAfter) || 480,
      break_policy_minutes: Number(formBreakPolicy) || 0,
      days,
    };
    if (editingSchedule) {
      updateMutation.mutate({ id: editingSchedule.id, body });
    } else {
      createMutation.mutate(body);
    }
  }

  function updateDay(i: number, field: keyof DayForm, value: string | boolean) {
    setFormDays((prev) => prev.map((d, idx) => idx === i ? { ...d, [field]: value } : d));
  }

  const isSaving = createMutation.isPending || updateMutation.isPending;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <CalendarClock size={22} />
            Work Schedules
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Define working hours and days for your team.
          </p>
        </div>
        {isOwner && (
          <Button onClick={openAdd} size="sm">
            <Plus size={16} className="mr-1" />
            New Schedule
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 size={20} className="animate-spin mr-2" />
          Loading…
        </div>
      ) : schedules.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 gap-2 text-muted-foreground">
            <CalendarClock size={32} className="opacity-30" />
            <p className="text-sm">No work schedules defined yet.</p>
            {isOwner && (
              <Button size="sm" variant="outline" onClick={openAdd}>
                <Plus size={14} className="mr-1" />
                Create your first schedule
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {schedules.map((s) => {
            const isExpanded = expandedId === s.id;
            return (
              <Card key={s.id} className="overflow-hidden">
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <CardTitle className="text-base">{s.name}</CardTitle>
                        {s.status !== "active" && (
                          <Badge variant="secondary" className="text-xs py-0 h-5">
                            {s.status}
                          </Badge>
                        )}
                      </div>
                      {s.description && (
                        <CardDescription className="text-xs mt-0.5">{s.description}</CardDescription>
                      )}
                      <p className="text-xs text-muted-foreground mt-1">
                        <Clock size={11} className="inline mr-1" />
                        {workingDaySummary(s.days ?? null)}
                      </p>
                      <div className="flex gap-3 mt-1 flex-wrap">
                        <span className="text-xs text-muted-foreground">
                          Overtime after{" "}
                          <strong>{Math.floor((s.overtime_after_minutes ?? 480) / 60)}h
                            {(s.overtime_after_minutes ?? 480) % 60 > 0 ? ` ${(s.overtime_after_minutes ?? 480) % 60}m` : ""}
                          </strong>
                        </span>
                        {(s.break_policy_minutes ?? 0) > 0 && (
                          <span className="text-xs text-muted-foreground">
                            Min. break <strong>{s.break_policy_minutes} min</strong>
                          </span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {isOwner && (
                        <>
                          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => openEdit(s)} title="Edit">
                            <Edit size={13} />
                          </Button>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 text-muted-foreground"
                            onClick={() => setDeleteTarget(s)}
                            title="Delete"
                          >
                            <Trash2 size={13} />
                          </Button>
                        </>
                      )}
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        onClick={() => setExpandedId(isExpanded ? null : s.id)}
                      >
                        {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                {isExpanded && s.days && s.days.length > 0 && (
                  <CardContent className="pt-0">
                    <div className="grid grid-cols-7 gap-1 mt-2">
                      {DAYS_ORDER.map((d) => {
                        const day = s.days!.find((sd) => sd.day_of_week === d.key);
                        const isWorking = day?.is_working_day ?? false;
                        return (
                          <div
                            key={d.key}
                            className={`rounded-lg p-2 text-center text-xs border ${
                              isWorking
                                ? "bg-emerald-50 border-emerald-200 text-emerald-800"
                                : "bg-muted/30 border-border text-muted-foreground"
                            }`}
                          >
                            <div className="font-medium mb-1">{d.label}</div>
                            {isWorking ? (
                              <div className="text-[10px] leading-tight">
                                {day?.start_time ?? "—"}<br />
                                {day?.end_time ?? "—"}
                              </div>
                            ) : (
                              <div className="text-[10px]">Off</div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </CardContent>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {/* Add / Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingSchedule ? "Edit Work Schedule" : "New Work Schedule"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-5 py-2">
            <div className="space-y-1">
              <Label>Schedule Name <span className="text-destructive">*</span></Label>
              <Input
                value={formName}
                onChange={(e) => setFormName(e.target.value)}
                placeholder="Standard Office Hours"
              />
            </div>
            <div className="space-y-1">
              <Label>Description</Label>
              <Input
                value={formDesc}
                onChange={(e) => setFormDesc(e.target.value)}
                placeholder="Optional description…"
              />
            </div>
            <div className="space-y-1">
              <Label>Timezone</Label>
              <Input
                value={formTimezone}
                onChange={(e) => setFormTimezone(e.target.value)}
                placeholder="UTC"
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label>Overtime After (minutes)</Label>
                <Input
                  type="number"
                  min="0"
                  value={formOvertimeAfter}
                  onChange={(e) => setFormOvertimeAfter(e.target.value)}
                  placeholder="480"
                />
                <p className="text-xs text-muted-foreground">
                  Default: 480 (8 h)
                </p>
              </div>
              <div className="space-y-1">
                <Label>Break Policy (minutes)</Label>
                <Input
                  type="number"
                  min="0"
                  value={formBreakPolicy}
                  onChange={(e) => setFormBreakPolicy(e.target.value)}
                  placeholder="0"
                />
                <p className="text-xs text-muted-foreground">
                  Minimum required break time
                </p>
              </div>
            </div>
            <div>
              <Label className="mb-3 block">Working Days & Hours</Label>
              <div className="space-y-2">
                {DAYS_ORDER.map((d, i) => (
                  <div key={d.key} className="flex items-center gap-3 flex-wrap">
                    <div className="w-16 text-sm font-medium text-muted-foreground">{d.label}</div>
                    <Switch
                      checked={formDays[i].is_working_day}
                      onCheckedChange={(v) => updateDay(i, "is_working_day", v)}
                    />
                    {formDays[i].is_working_day && (
                      <>
                        <Input
                          type="time"
                          value={formDays[i].start_time}
                          onChange={(e) => updateDay(i, "start_time", e.target.value)}
                          className="w-32 h-8 text-sm"
                        />
                        <span className="text-muted-foreground text-sm">–</span>
                        <Input
                          type="time"
                          value={formDays[i].end_time}
                          onChange={(e) => updateDay(i, "end_time", e.target.value)}
                          className="w-32 h-8 text-sm"
                        />
                        <div className="flex items-center gap-1">
                          <Input
                            type="number"
                            min="0"
                            value={formDays[i].break_minutes}
                            onChange={(e) => updateDay(i, "break_minutes", e.target.value)}
                            className="w-16 h-8 text-sm"
                          />
                          <span className="text-xs text-muted-foreground">min break</span>
                        </div>
                      </>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={isSaving}>Cancel</Button>
            <Button
              onClick={handleSubmit}
              disabled={!formName.trim() || isSaving}
            >
              {isSaving && <Loader2 size={14} className="animate-spin mr-1.5" />}
              {editingSchedule ? "Save changes" : "Create Schedule"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{deleteTarget?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete the work schedule. Any team members assigned to it will lose their schedule assignment.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90"
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
