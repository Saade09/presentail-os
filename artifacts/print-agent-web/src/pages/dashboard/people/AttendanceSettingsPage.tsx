import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  MapPin,
  Edit,
  Loader2,
  Radar,
  CalendarClock,
  CheckCircle2,
  XCircle,
} from "lucide-react";

type LocationAttendance = {
  id: number;
  name: string;
  latitude: number | null;
  longitude: number | null;
  geofence_radius_meters: number;
  attendance_enabled: boolean;
  default_schedule_id: number | null;
  default_schedule_name: string | null;
};

type WorkSchedule = {
  id: number;
  name: string;
};

type GeofenceForm = {
  latitude: string;
  longitude: string;
  geofence_radius_meters: string;
  attendance_enabled: boolean;
  default_schedule_id: string;
};

function buildForm(loc: LocationAttendance): GeofenceForm {
  return {
    latitude: loc.latitude != null ? String(loc.latitude) : "",
    longitude: loc.longitude != null ? String(loc.longitude) : "",
    geofence_radius_meters: String(loc.geofence_radius_meters),
    attendance_enabled: loc.attendance_enabled,
    default_schedule_id: loc.default_schedule_id != null ? String(loc.default_schedule_id) : "none",
  };
}

export default function AttendanceSettingsPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { isOwner } = useWorkspaceRole();

  const [editTarget, setEditTarget] = useState<LocationAttendance | null>(null);
  const [form, setForm] = useState<GeofenceForm | null>(null);

  const { data: locData, isLoading: locLoading } = useQuery({
    queryKey: ["attendance-settings-locations"],
    queryFn: () => apiFetch("/api/attendance-settings/locations"),
  });
  const locations: LocationAttendance[] =
    (locData as { locations?: LocationAttendance[] })?.locations ?? [];

  const { data: schedData } = useQuery({
    queryKey: ["work-schedules"],
    queryFn: () => apiFetch("/api/work-schedules"),
  });
  const schedules: WorkSchedule[] =
    (schedData as { work_schedules?: WorkSchedule[] })?.work_schedules ?? [];

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Record<string, unknown> }) =>
      apiFetch(`/api/attendance-settings/locations/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["attendance-settings-locations"] });
      toast({ title: "Attendance settings saved" });
      setEditTarget(null);
    },
    onError: (err: Error) =>
      toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  function openEdit(loc: LocationAttendance) {
    setEditTarget(loc);
    setForm(buildForm(loc));
  }

  function handleSave() {
    if (!editTarget || !form) return;
    const body: Record<string, unknown> = {
      attendance_enabled: form.attendance_enabled,
      geofence_radius_meters: Number(form.geofence_radius_meters) || 100,
      default_schedule_id: form.default_schedule_id === "none" ? null : Number(form.default_schedule_id),
    };
    if (form.latitude.trim() !== "") body.latitude = Number(form.latitude);
    if (form.longitude.trim() !== "") body.longitude = Number(form.longitude);
    if (form.latitude.trim() === "" && form.longitude.trim() === "") {
      body.latitude = null;
      body.longitude = null;
    }
    updateMutation.mutate({ id: editTarget.id, body });
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <Radar size={22} />
          Attendance Settings
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          Configure geofence radii, coordinates, and work schedule assignments per location.
        </p>
      </div>

      {locLoading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 size={20} className="animate-spin mr-2" />
          Loading locations…
        </div>
      ) : locations.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 gap-2 text-muted-foreground">
            <MapPin size={32} className="opacity-30" />
            <p className="text-sm">No active locations found.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {locations.map((loc) => (
            <Card key={loc.id}>
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <CardTitle className="text-base">{loc.name}</CardTitle>
                      {loc.attendance_enabled ? (
                        <Badge variant="secondary" className="text-xs py-0 h-5 gap-1 text-emerald-700 bg-emerald-50 border-emerald-200">
                          <CheckCircle2 size={10} />
                          Enabled
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="text-xs py-0 h-5 gap-1 text-muted-foreground">
                          <XCircle size={10} />
                          Disabled
                        </Badge>
                      )}
                    </div>
                    <CardDescription className="text-xs mt-1 space-y-0.5">
                      <span className="flex items-center gap-1">
                        <Radar size={11} />
                        Geofence radius: <strong>{loc.geofence_radius_meters} m</strong>
                      </span>
                      {loc.latitude != null && loc.longitude != null ? (
                        <span className="flex items-center gap-1">
                          <MapPin size={11} />
                          {loc.latitude.toFixed(5)}, {loc.longitude.toFixed(5)}
                        </span>
                      ) : (
                        <span className="text-amber-600 flex items-center gap-1">
                          <MapPin size={11} />
                          No coordinates set — clock-in will not be geofenced
                        </span>
                      )}
                      {loc.default_schedule_name && (
                        <span className="flex items-center gap-1">
                          <CalendarClock size={11} />
                          Default schedule: <strong>{loc.default_schedule_name}</strong>
                        </span>
                      )}
                    </CardDescription>
                  </div>
                  {isOwner && (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7 flex-shrink-0"
                      onClick={() => openEdit(loc)}
                      title="Edit attendance settings"
                    >
                      <Edit size={13} />
                    </Button>
                  )}
                </div>
              </CardHeader>
            </Card>
          ))}
        </div>
      )}

      {/* Edit Dialog */}
      <Dialog
        open={!!editTarget}
        onOpenChange={(o) => { if (!o) setEditTarget(null); }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Attendance Settings — {editTarget?.name}</DialogTitle>
          </DialogHeader>
          {form && (
            <div className="space-y-4 py-1">
              {/* Attendance toggle */}
              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-sm font-medium">Enable attendance tracking</Label>
                  <p className="text-xs text-muted-foreground">
                    Allow clock-in/out at this location
                  </p>
                </div>
                <Switch
                  checked={form.attendance_enabled}
                  onCheckedChange={(v) => setForm((f) => f && { ...f, attendance_enabled: v })}
                />
              </div>

              <hr />

              {/* Geofence radius */}
              <div className="space-y-1">
                <Label>Geofence Radius (meters)</Label>
                <Input
                  type="number"
                  min="10"
                  max="50000"
                  value={form.geofence_radius_meters}
                  onChange={(e) =>
                    setForm((f) => f && { ...f, geofence_radius_meters: e.target.value })
                  }
                  placeholder="100"
                />
                <p className="text-xs text-muted-foreground">
                  Employees must be within this radius to clock in (10–50,000 m)
                </p>
              </div>

              {/* Coordinates */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>Latitude</Label>
                  <Input
                    type="number"
                    step="0.00001"
                    value={form.latitude}
                    onChange={(e) =>
                      setForm((f) => f && { ...f, latitude: e.target.value })
                    }
                    placeholder="e.g. 25.20453"
                  />
                </div>
                <div className="space-y-1">
                  <Label>Longitude</Label>
                  <Input
                    type="number"
                    step="0.00001"
                    value={form.longitude}
                    onChange={(e) =>
                      setForm((f) => f && { ...f, longitude: e.target.value })
                    }
                    placeholder="e.g. 55.27020"
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground -mt-1">
                Leave both blank to allow clock-in without geofence verification.
              </p>

              <hr />

              {/* Default schedule */}
              <div className="space-y-1">
                <Label>Default Work Schedule</Label>
                <Select
                  value={form.default_schedule_id}
                  onValueChange={(v) =>
                    setForm((f) => f && { ...f, default_schedule_id: v })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="No default schedule" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No default schedule</SelectItem>
                    {schedules.map((s) => (
                      <SelectItem key={s.id} value={String(s.id)}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Used to calculate lateness and overtime when a team member has no personal schedule assigned.
                </p>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setEditTarget(null)}
              disabled={updateMutation.isPending}
            >
              Cancel
            </Button>
            <Button onClick={handleSave} disabled={updateMutation.isPending}>
              {updateMutation.isPending && (
                <Loader2 size={14} className="animate-spin mr-1.5" />
              )}
              Save Settings
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
