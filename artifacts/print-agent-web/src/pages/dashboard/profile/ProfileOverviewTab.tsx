import { useUser } from "@clerk/react";
type UserResource = NonNullable<ReturnType<typeof useUser>["user"]>;
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  User, Briefcase, Shield, Bell, MapPin, Users, Calendar,
  Plane, Stethoscope, Clock, PhoneCall, ChevronRight,
} from "lucide-react";
import { useGetTimeOffBalance } from "@workspace/api-client-react";
import type { FullProfileData } from "./types";
import {
  formatBirthday, formatDisplayDate, getRoleLabel,
  GENDER_OPTIONS, EMPLOYMENT_TYPE_OPTIONS,
} from "./types";

interface ProfileOverviewTabProps {
  user?: UserResource;
  profile: FullProfileData | undefined;
  allowedPages: string[] | null;
  isOwner: boolean;
  onNavigate: (tab: string) => void;
  readOnly?: boolean;
  readOnlyMember?: { firstName: string | null; lastName: string | null; email: string };
}

function OverviewRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex items-start gap-3 py-1.5">
      <span className="text-xs text-muted-foreground w-28 shrink-0 pt-0.5">{label}</span>
      <span className="text-sm font-medium">{value || "—"}</span>
    </div>
  );
}

function SectionCard({
  title,
  icon: Icon,
  linkTab,
  onNavigate,
  children,
}: {
  title: string;
  icon: React.ElementType;
  linkTab?: string;
  onNavigate?: (tab: string) => void;
  children: React.ReactNode;
}) {
  return (
    <Card className="h-full">
      <CardHeader className="pb-2 pt-4 px-5">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold flex items-center gap-1.5">
            <Icon size={14} />
            {title}
          </CardTitle>
          {linkTab && onNavigate && (
            <button
              type="button"
              onClick={() => onNavigate(linkTab)}
              className="text-xs text-primary hover:underline flex items-center gap-0.5"
            >
              Edit <ChevronRight size={12} />
            </button>
          )}
        </div>
      </CardHeader>
      <CardContent className="px-5 pb-4">
        {children}
      </CardContent>
    </Card>
  );
}

function TimeOffSummaryCard({ onNavigate }: { onNavigate: (tab: string) => void }) {
  const { data: balanceData, isLoading } = useGetTimeOffBalance();
  const balance = balanceData?.balance ?? null;

  if (isLoading) {
    return (
      <Card className="h-full">
        <CardHeader className="pb-2 pt-4 px-5">
          <CardTitle className="text-sm font-semibold flex items-center gap-1.5">
            <Calendar size={14} />
            Time Off Summary
          </CardTitle>
        </CardHeader>
        <CardContent className="px-5 pb-4">
          <div className="space-y-2 animate-pulse">
            <div className="h-4 bg-muted rounded w-3/4" />
            <div className="h-3 bg-muted rounded w-1/2" />
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="h-full">
      <CardHeader className="pb-2 pt-4 px-5">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-semibold flex items-center gap-1.5">
            <Calendar size={14} />
            Time Off Summary
          </CardTitle>
          <button
            type="button"
            onClick={() => onNavigate("time-off")}
            className="text-xs text-primary hover:underline flex items-center gap-0.5"
          >
            View <ChevronRight size={12} />
          </button>
        </div>
      </CardHeader>
      <CardContent className="px-5 pb-4">
        {balance == null ? (
          <p className="text-xs text-muted-foreground">No time-off policy assigned.</p>
        ) : (
          <div className="space-y-3">
            {/* Vacation */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs flex items-center gap-1 text-muted-foreground">
                  <Plane size={11} /> Vacation
                </span>
                <span className="text-xs font-medium">
                  {Number(balance.vacation_remaining).toFixed(1)} / {Number(balance.vacation_entitled).toFixed(0)} days
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full rounded-full bg-emerald-500"
                  style={{
                    width: `${Math.min(100, (Number(balance.vacation_remaining) / Math.max(1, Number(balance.vacation_entitled))) * 100)}%`,
                  }}
                />
              </div>
            </div>
            {/* Sick leave */}
            {balance.sick_leave_entitled != null && (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs flex items-center gap-1 text-muted-foreground">
                    <Stethoscope size={11} /> Sick Leave
                  </span>
                  <span className="text-xs font-medium">
                    {Number(balance.sick_leave_used).toFixed(1)} used / {Number(balance.sick_leave_entitled).toFixed(0)} days
                  </span>
                </div>
                <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full bg-rose-400"
                    style={{
                      width: `${Math.min(100, (Number(balance.sick_leave_used) / Math.max(1, Number(balance.sick_leave_entitled))) * 100)}%`,
                    }}
                  />
                </div>
              </div>
            )}
            {Number(balance.vacation_pending) > 0 && (
              <p className="text-xs text-amber-600 flex items-center gap-1">
                <Clock size={11} />
                {Number(balance.vacation_pending).toFixed(1)} vacation days pending approval
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function ProfileOverviewTab({
  user,
  profile,
  allowedPages,
  isOwner,
  onNavigate,
  readOnly = false,
  readOnlyMember,
}: ProfileOverviewTabProps) {
  const email = readOnlyMember?.email ?? user?.primaryEmailAddress?.emailAddress ?? profile?.member_email ?? "";
  const fullName =
    [readOnlyMember?.firstName ?? user?.firstName, readOnlyMember?.lastName ?? user?.lastName]
      .filter(Boolean)
      .join(" ") || email.split("@")[0];

  const genderLabel = GENDER_OPTIONS.find((g) => g.value === profile?.gender)?.label ?? profile?.gender ?? null;
  const employmentTypeLabel =
    EMPLOYMENT_TYPE_OPTIONS.find((o) => o.value === profile?.employment_type)?.label ?? profile?.employment_type ?? null;

  function hasPage(page: string): boolean {
    if (allowedPages === null) return true;
    return allowedPages.includes(page);
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {/* Personal Details */}
      <SectionCard title="Personal Details" icon={User} linkTab="personal" onNavigate={onNavigate}>
        <OverviewRow label="Full name" value={fullName} />
        <OverviewRow label="Email" value={email} />
        <OverviewRow label="Phone" value={profile?.phone ?? null} />
        <OverviewRow label="Birthday" value={formatBirthday(profile?.birthday ?? null)} />
        <OverviewRow label="Gender" value={genderLabel} />
        <OverviewRow label="Job title" value={profile?.job_title ?? null} />
      </SectionCard>

      {/* Work Information */}
      <SectionCard title="Work Information" icon={Briefcase} linkTab="work" onNavigate={onNavigate}>
        <OverviewRow label="Department" value={profile?.department ?? null} />
        <OverviewRow label="Location" value={profile?.location ?? null} />
        <OverviewRow label="Type" value={employmentTypeLabel} />
        <OverviewRow label="Start date" value={formatDisplayDate(profile?.start_date ?? null)} />
        <OverviewRow label="Manager" value={profile?.manager_name ?? null} />
        <OverviewRow label="Status" value={profile?.employment_status ?? "active"} />
      </SectionCard>

      {/* Access & Permissions */}
      <SectionCard title="Access & Permissions" icon={Shield} linkTab="access" onNavigate={onNavigate}>
        <div className="mb-2">
          <Badge variant={profile?.role === "owner" ? "default" : "outline"} className="text-xs">
            {profile ? getRoleLabel(profile) : "—"}
          </Badge>
        </div>
        {profile?.assigned_locations && profile.assigned_locations.length > 0 && (
          <div className="mb-2">
            <p className="text-xs text-muted-foreground mb-1">Assigned locations</p>
            <div className="flex flex-wrap gap-1">
              {profile.assigned_locations.map((loc) => (
                <Badge key={loc.id} variant="secondary" className="text-xs flex items-center gap-0.5">
                  <MapPin size={9} />
                  {loc.name}
                </Badge>
              ))}
            </div>
          </div>
        )}
        <div className="mt-2 space-y-1">
          <p className="text-xs text-muted-foreground">
            Time-off approval: <span className={isOwner || hasPage("time-off.manage") ? "text-emerald-600 font-medium" : ""}>{isOwner || hasPage("time-off.manage") ? "Yes" : "No"}</span>
          </p>
          <p className="text-xs text-muted-foreground">
            Analytics: <span className={isOwner || hasPage("analytics") ? "text-emerald-600 font-medium" : ""}>{isOwner || hasPage("analytics") ? "Yes" : "No"}</span>
          </p>
        </div>
      </SectionCard>

      {/* Time Off Summary — only show for own profile (hooks use current user's auth) */}
      {!readOnly && <TimeOffSummaryCard onNavigate={onNavigate} />}

      {/* Emergency Contact */}
      {!readOnly && (
        <Card className="h-full">
          <CardHeader className="pb-2 pt-4 px-5">
            <div className="flex items-center justify-between">
              <CardTitle className="text-sm font-semibold flex items-center gap-1.5">
                <PhoneCall size={14} />
                Emergency Contact
              </CardTitle>
              <button
                type="button"
                onClick={() => onNavigate("personal")}
                className="text-xs text-primary hover:underline flex items-center gap-0.5"
              >
                Edit <ChevronRight size={12} />
              </button>
            </div>
          </CardHeader>
          <CardContent className="px-5 pb-4">
            {profile?.ec_name ? (
              <div className="space-y-1">
                <OverviewRow label="Name" value={profile.ec_name} />
                <OverviewRow label="Relationship" value={profile.ec_relationship ?? null} />
                <OverviewRow label="Phone" value={profile.ec_phone ?? null} />
              </div>
            ) : (
              <p className="text-xs text-muted-foreground italic">No emergency contact saved yet.</p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Notifications & Preferences */}
      <Card className="h-full">
        <CardHeader className="pb-2 pt-4 px-5">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-semibold flex items-center gap-1.5">
              <Bell size={14} />
              Notifications & Preferences
            </CardTitle>
            {!readOnly && (
              <button
                type="button"
                onClick={() => onNavigate("notifications")}
                className="text-xs text-primary hover:underline flex items-center gap-0.5"
              >
                Edit <ChevronRight size={12} />
              </button>
            )}
          </div>
        </CardHeader>
        <CardContent className="px-5 pb-4 space-y-1.5">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground text-xs">Time-off email (requests)</span>
            <Badge
              variant="secondary"
              className={`text-xs ${profile?.notify_email_on_time_off_request ? "text-emerald-700 bg-emerald-50 border-emerald-200" : ""}`}
            >
              {profile?.notify_email_on_time_off_request ? "On" : "Off"}
            </Badge>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground text-xs">Time-off email (decisions)</span>
            <Badge
              variant="secondary"
              className={`text-xs ${profile?.notify_email_on_time_off_decision ? "text-emerald-700 bg-emerald-50 border-emerald-200" : ""}`}
            >
              {profile?.notify_email_on_time_off_decision ? "On" : "Off"}
            </Badge>
          </div>
          {!readOnly && (
            <Button
              variant="link"
              size="sm"
              className="text-xs h-auto p-0 mt-1"
              onClick={() => onNavigate("notifications")}
            >
              Manage notification settings →
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
