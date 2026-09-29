import { useState, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { Briefcase, Lock } from "lucide-react";
import type { FullProfileData } from "./types";
import { EMPLOYMENT_TYPE_OPTIONS, formatDisplayDate } from "./types";

interface WorkMember {
  id: number;
  email: string;
  first_name: string | null;
  last_name: string | null;
  joined: boolean;
}

interface ProfileWorkTabProps {
  profile: FullProfileData | undefined;
  isOwner: boolean;
  onDirtyChange: (dirty: boolean) => void;
  saveSignal: number;
  resetSignal: number;
  onSaved: (updated: FullProfileData) => void;
}

function memberLabel(m: WorkMember): string {
  const name = [m.first_name, m.last_name].filter(Boolean).join(" ");
  return name || m.email;
}

export function ProfileWorkTab({
  profile,
  isOwner,
  onDirtyChange,
  saveSignal,
  resetSignal,
  onSaved,
}: ProfileWorkTabProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [department, setDepartment] = useState(profile?.department ?? "");
  const [location, setLocation] = useState(profile?.location ?? "");
  const [employmentType, setEmploymentType] = useState(profile?.employment_type ?? "");
  const [startDate, setStartDate] = useState(profile?.start_date ?? "");
  const [managerMemberId, setManagerMemberId] = useState<string>(
    profile?.manager_member_id?.toString() ?? "",
  );
  const [saving, setSaving] = useState(false);

  const savedRef = useRef({
    department: profile?.department ?? "",
    location: profile?.location ?? "",
    employmentType: profile?.employment_type ?? "",
    startDate: profile?.start_date ?? "",
    managerMemberId: profile?.manager_member_id?.toString() ?? "",
  });

  const { data: membersData } = useQuery<{ members: WorkMember[] }>({
    queryKey: ["users"],
    queryFn: () => apiFetch<{ members: WorkMember[] }>("/api/users"),
    enabled: isOwner,
  });
  const members = membersData?.members.filter((m) => m.joined) ?? [];

  useEffect(() => {
    if (profile) {
      const dep = profile.department ?? "";
      const loc = profile.location ?? "";
      const et = profile.employment_type ?? "";
      const sd = profile.start_date ?? "";
      const mgr = profile.manager_member_id?.toString() ?? "";
      setDepartment(dep);
      setLocation(loc);
      setEmploymentType(et);
      setStartDate(sd);
      setManagerMemberId(mgr);
      savedRef.current = { department: dep, location: loc, employmentType: et, startDate: sd, managerMemberId: mgr };
    }
  }, [profile]);

  const isDirty =
    department !== savedRef.current.department ||
    location !== savedRef.current.location ||
    employmentType !== savedRef.current.employmentType ||
    startDate !== savedRef.current.startDate ||
    managerMemberId !== savedRef.current.managerMemberId;

  useEffect(() => {
    onDirtyChange(isOwner ? isDirty : false);
  }, [isDirty, isOwner, onDirtyChange]);

  useEffect(() => {
    if (resetSignal > 0) {
      setDepartment(savedRef.current.department);
      setLocation(savedRef.current.location);
      setEmploymentType(savedRef.current.employmentType);
      setStartDate(savedRef.current.startDate);
      setManagerMemberId(savedRef.current.managerMemberId);
    }
  }, [resetSignal]);

  useEffect(() => {
    if (saveSignal > 0 && isOwner) {
      void handleSave();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveSignal]);

  async function handleSave() {
    setSaving(true);
    try {
      const updated = await apiFetch<FullProfileData>("/api/profile/work-info", {
        method: "PATCH",
        body: JSON.stringify({
          department: department || null,
          location: location || null,
          employment_type: employmentType || null,
          start_date: startDate || null,
          manager_member_id: managerMemberId ? parseInt(managerMemberId, 10) : null,
        }),
      });
      savedRef.current = {
        department: updated.department ?? "",
        location: updated.location ?? "",
        employmentType: updated.employment_type ?? "",
        startDate: updated.start_date ?? "",
        managerMemberId: updated.manager_member_id?.toString() ?? "",
      };
      queryClient.setQueryData(["profile"], updated);
      onSaved(updated);
      toast({ title: "Work info saved", description: "Work information has been updated." });
    } catch {
      toast({ title: "Failed to save", description: "Could not save work information.", variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  function Field({ label, value }: { label: string; value: string | null }) {
    return (
      <div className="space-y-1">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-sm font-medium">{value || "—"}</p>
      </div>
    );
  }

  const employmentTypeLabel =
    EMPLOYMENT_TYPE_OPTIONS.find((o) => o.value === profile?.employment_type)?.label ?? profile?.employment_type ?? null;
  const managerLabel = profile?.manager_name ?? null;

  const statusBadgeClass =
    profile?.employment_status === "active"
      ? "text-emerald-700 bg-emerald-50 border-emerald-200"
      : "text-muted-foreground bg-muted border-border";

  return (
    <div className="space-y-5">
      {/* Employment status */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold flex items-center gap-2">
            <Briefcase size={16} />
            Employment Status
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3">
            <Badge variant="outline" className={`capitalize ${statusBadgeClass}`}>
              {profile?.employment_status ?? "active"}
            </Badge>
            <span className="text-xs text-muted-foreground">
              Status is managed by workspace administrators.
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Work information */}
      {isOwner ? (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold">Work Information</CardTitle>
            <p className="text-xs text-muted-foreground mt-1">Editable by workspace owners only.</p>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="department">Department</Label>
                <Input
                  id="department"
                  value={department}
                  onChange={(e) => setDepartment(e.target.value)}
                  placeholder="e.g. Operations"
                  data-testid="input-department"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="work-location">Location / Office</Label>
                <Input
                  id="work-location"
                  value={location}
                  onChange={(e) => setLocation(e.target.value)}
                  placeholder="e.g. Beirut HQ"
                  data-testid="input-location"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="employment-type">Employment type</Label>
                <select
                  id="employment-type"
                  value={employmentType}
                  onChange={(e) => setEmploymentType(e.target.value)}
                  data-testid="select-employment-type"
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  {EMPLOYMENT_TYPE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="start-date">Start date</Label>
                <Input
                  id="start-date"
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  data-testid="input-start-date"
                />
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="manager-select">Manager</Label>
                <select
                  id="manager-select"
                  value={managerMemberId}
                  onChange={(e) => setManagerMemberId(e.target.value)}
                  data-testid="select-manager"
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  <option value="">— No manager —</option>
                  {members.map((m) => (
                    <option key={m.id} value={m.id.toString()}>
                      {memberLabel(m)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="flex justify-end">
              <Button onClick={handleSave} disabled={saving} data-testid="save-work-info-button">
                {saving ? "Saving…" : "Save work info"}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base font-semibold flex items-center gap-2">
              Work Information
              <Lock size={14} className="text-muted-foreground" />
            </CardTitle>
            <p className="text-xs text-muted-foreground mt-1">These fields are managed by your workspace owner.</p>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-4">
              <Field label="Department" value={profile?.department ?? null} />
              <Field label="Location / Office" value={profile?.location ?? null} />
              <Field label="Employment Type" value={employmentTypeLabel} />
              <Field label="Start Date" value={formatDisplayDate(profile?.start_date ?? null)} />
              <Field label="Manager" value={managerLabel} />
            </div>
          </CardContent>
        </Card>
      )}

      {/* Work schedule summary */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base font-semibold">Work Schedule Summary</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground mb-2">Manage your schedule in the Schedule tab.</p>
          {profile?.working_days ? (
            <div className="flex gap-1.5 flex-wrap">
              {(["monday","tuesday","wednesday","thursday","friday","saturday","sunday"] as const).map((day) => {
                const active = profile.working_days?.[day];
                const short = day.slice(0, 3).charAt(0).toUpperCase() + day.slice(1, 3);
                return (
                  <span
                    key={day}
                    className={`w-9 h-9 rounded-full text-xs font-medium flex items-center justify-center border-2 ${
                      active
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-border text-muted-foreground"
                    }`}
                  >
                    {short}
                  </span>
                );
              })}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No schedule set.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
