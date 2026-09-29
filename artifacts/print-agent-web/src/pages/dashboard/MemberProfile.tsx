import { useState } from "react";
import { useParams, Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ArrowLeft, CalendarDays, Lock, Plane, Clock, Stethoscope, CalendarOff, Star, SlidersHorizontal } from "lucide-react";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { useGetMemberTimeOffBalance, useGetMemberTimeOffBalanceAdjustments } from "@workspace/api-client-react";

import { ProfileOverviewTab } from "./profile/ProfileOverviewTab";
import { ProfilePersonalTab } from "./profile/ProfilePersonalTab";
import { ProfileWorkTab } from "./profile/ProfileWorkTab";
import { ProfileAccessTab } from "./profile/ProfileAccessTab";
import { ProfileNotificationsTab } from "./profile/ProfileNotificationsTab";
import { ProfilePayTab } from "./profile/ProfilePayTab";
import type { FullProfileData, WorkingDaysConfig } from "./profile/types";
import { DEFAULT_WORKING_DAYS, WORK_SCHEDULE_DAYS, getRoleLabel } from "./profile/types";

type MemberProfileData = FullProfileData & {
  first_name: string | null;
  last_name: string | null;
  image_url: string | null;
  allowed_pages: string[] | null;
};

function noop() {}
function noopDirty(_: boolean) {}

function MemberProfileHeader({ data }: { data: MemberProfileData }) {
  const fullName = [data.first_name, data.last_name].filter(Boolean).join(" ") || data.member_email;
  const initials = (data.first_name?.[0] ?? data.member_email[0] ?? "?").toUpperCase();
  const roleLabel = getRoleLabel(data);

  return (
    <div className="rounded-xl border bg-card p-5 mb-6 flex items-center gap-5">
      <div className="relative shrink-0">
        {data.image_url ? (
          <img
            src={data.image_url}
            alt={fullName}
            className="w-20 h-20 rounded-full object-cover border-2 border-border"
          />
        ) : (
          <div className="w-20 h-20 rounded-full bg-muted flex items-center justify-center text-2xl font-bold text-muted-foreground border-2 border-border">
            {initials}
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <h2 className="text-xl font-bold truncate">{fullName}</h2>
        <p className="text-sm text-muted-foreground">{data.member_email}</p>
        <div className="flex items-center gap-2 mt-2 flex-wrap">
          <Badge variant={data.role === "owner" ? "default" : "outline"} className="text-xs">
            {roleLabel}
          </Badge>
          {data.employment_status && (
            <Badge
              variant="outline"
              className={`text-xs capitalize ${
                data.employment_status === "active"
                  ? "text-emerald-700 bg-emerald-50 border-emerald-200"
                  : "text-muted-foreground"
              }`}
            >
              {data.employment_status}
            </Badge>
          )}
          <Badge variant="secondary" className="text-xs gap-1">
            <Lock size={10} />
            Read-only view
          </Badge>
        </div>
      </div>
    </div>
  );
}

function MemberTimeOffBalanceSection({ memberDbId }: { memberDbId: number }) {
  const { data: balanceData, isLoading, isError } = useGetMemberTimeOffBalance(memberDbId);
  const { data: adjustmentsData } = useGetMemberTimeOffBalanceAdjustments(memberDbId);
  const adjustments = adjustmentsData?.adjustments ?? [];
  const balance = balanceData?.balance ?? null;

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-24 rounded-xl bg-muted animate-pulse" />
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-16 gap-4 text-center">
          <Lock size={32} className="text-muted-foreground" />
          <div className="space-y-1">
            <h3 className="font-semibold text-base">Time Off</h3>
            <p className="text-sm text-muted-foreground max-w-xs">
              Time off balances are not accessible. Visit the Time Off Approvals page to manage this member&apos;s requests.
            </p>
          </div>
          <Link href="/time-off/approvals">
            <Button variant="outline" size="sm">View Approvals</Button>
          </Link>
        </CardContent>
      </Card>
    );
  }

  if (balance == null) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-10 gap-3 text-center">
          <CalendarOff size={28} className="text-muted-foreground" />
          <div className="space-y-1">
            <p className="font-medium text-sm">No time-off policy assigned</p>
            <p className="text-xs text-muted-foreground max-w-xs">
              This member has no active time-off policy. Assign one from the HR settings to track their leave balance.
            </p>
          </div>
          <Link href="/admin/time-off/policies">
            <Button size="sm" variant="outline">Manage Policies</Button>
          </Link>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
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
            <p className="text-xs text-muted-foreground mt-0.5">of {Number(balance.vacation_entitled).toFixed(0)} days</p>
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
      <p className="text-xs text-muted-foreground">
        Balance as of {new Date().getFullYear()} · Read-only view
      </p>

      {adjustments.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <SlidersHorizontal size={14} className="text-muted-foreground" />
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
                          {Number(adj.vacation_entitled_before).toFixed(0)} → {Number(adj.vacation_entitled_after).toFixed(0)} days
                          {" "}
                          <span className="text-muted-foreground font-normal">({adj.policy_year})</span>
                        </p>
                        <span
                          className={[
                            "text-xs font-semibold px-1.5 py-0.5 rounded",
                            isPositive ? "text-emerald-700 bg-emerald-100" : "",
                            isNegative ? "text-destructive bg-destructive/10" : "",
                            !isPositive && !isNegative ? "text-muted-foreground bg-muted" : "",
                          ].join(" ")}
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
                      {new Date(adj.adjusted_at).toLocaleDateString(undefined, {
                        year: "numeric",
                        month: "short",
                        day: "numeric",
                      })}
                    </span>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export default function MemberProfilePage() {
  const params = useParams<{ memberId: string }>();
  const memberId = params.memberId;
  const { isOwner, allowedPages } = useWorkspaceRole();
  const canViewProfiles = isOwner || (allowedPages?.includes("users") ?? false);

  const [activeTab, setActiveTab] = useState("overview");

  const { data: profileData, isLoading, isError } = useQuery<MemberProfileData>({
    queryKey: ["member-profile", memberId],
    queryFn: () => apiFetch<MemberProfileData>(`/api/users/${memberId}/profile`),
    enabled: !!memberId && canViewProfiles,
    retry: false,
  });

  const workingDays: WorkingDaysConfig = profileData?.working_days ?? DEFAULT_WORKING_DAYS;

  const TAB_ITEMS = [
    { value: "overview", label: "Overview" },
    { value: "personal", label: "Personal" },
    { value: "work", label: "Work" },
    { value: "access", label: "Access" },
    { value: "schedule", label: "Schedule" },
    { value: "time-off", label: "Time Off" },
    { value: "pay", label: "Pay" },
    { value: "notifications", label: "Notifications" },
    { value: "security", label: "Security" },
  ];

  if (!canViewProfiles) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <Link href="/users">
            <Button variant="ghost" size="sm">
              <ArrowLeft size={16} className="mr-1" />
              Back to Users
            </Button>
          </Link>
        </div>
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 gap-4 text-center">
            <Lock size={32} className="text-muted-foreground" />
            <div className="space-y-1">
              <h3 className="font-semibold text-base">Access Restricted</h3>
              <p className="text-sm text-muted-foreground">
                You do not have permission to view member profiles.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <Link href="/users">
            <Button variant="ghost" size="sm">
              <ArrowLeft size={16} className="mr-1" />
              Back to Users
            </Button>
          </Link>
        </div>
        <div className="rounded-xl border bg-card p-6 mb-6 animate-pulse h-32" />
        <div className="h-10 bg-muted rounded animate-pulse" />
      </div>
    );
  }

  if (isError || !profileData) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <Link href="/users">
            <Button variant="ghost" size="sm">
              <ArrowLeft size={16} className="mr-1" />
              Back to Users
            </Button>
          </Link>
        </div>
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 gap-4 text-center">
            <div className="space-y-1">
              <h3 className="font-semibold text-base">Member not found</h3>
              <p className="text-sm text-muted-foreground">
                This member&apos;s profile could not be loaded.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  const readOnlyMember = {
    firstName: profileData.first_name,
    lastName: profileData.last_name,
    email: profileData.member_email,
  };

  return (
    <div className="space-y-0">
      <div className="flex items-center gap-3 mb-4">
        <Link href="/users">
          <Button variant="ghost" size="sm">
            <ArrowLeft size={16} className="mr-1" />
            Back to Users
          </Button>
        </Link>
        <div>
          <p className="text-xs text-muted-foreground">Viewing member profile</p>
        </div>
      </div>

      <div className="mb-4">
        <h1 className="text-2xl font-bold tracking-tight">
          {[profileData.first_name, profileData.last_name].filter(Boolean).join(" ") || profileData.member_email}&apos;s Profile
        </h1>
        <p className="text-muted-foreground mt-1 text-sm">Read-only view of this member&apos;s profile and settings.</p>
      </div>

      <MemberProfileHeader data={profileData} />

      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="mb-5 flex-wrap h-auto gap-1">
          {TAB_ITEMS.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="overview">
          <ProfileOverviewTab
            profile={profileData}
            allowedPages={profileData.allowed_pages}
            isOwner={profileData.role === "owner"}
            onNavigate={setActiveTab}
            readOnly
            readOnlyMember={readOnlyMember}
          />
        </TabsContent>

        <TabsContent value="personal">
          <ProfilePersonalTab
            profile={profileData}
            onDirtyChange={noopDirty}
            saveSignal={0}
            resetSignal={0}
            onSaved={noop as (updated: FullProfileData) => void}
            readOnly
            readOnlyName={{ firstName: profileData.first_name, lastName: profileData.last_name }}
          />
        </TabsContent>

        <TabsContent value="work">
          <ProfileWorkTab
            profile={profileData}
            isOwner={false}
            onDirtyChange={noopDirty}
            saveSignal={0}
            resetSignal={0}
            onSaved={noop as (updated: FullProfileData) => void}
          />
        </TabsContent>

        <TabsContent value="access">
          <ProfileAccessTab
            profile={profileData}
            allowedPages={profileData.allowed_pages}
            isOwner={profileData.role === "owner"}
          />
        </TabsContent>

        <TabsContent value="schedule">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base font-semibold">
                <CalendarDays size={18} />
                Work Schedule
              </CardTitle>
              <CardDescription>
                This member&apos;s standard working days.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2 flex-wrap">
                {WORK_SCHEDULE_DAYS.map(({ key, label, short }) => {
                  const active = workingDays[key];
                  return (
                    <div
                      key={key}
                      aria-label={label}
                      className={`w-12 h-12 rounded-full text-sm font-medium border-2 flex items-center justify-center ${
                        active
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border bg-transparent text-muted-foreground"
                      }`}
                    >
                      {short}
                    </div>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">
                {Object.values(workingDays).filter(Boolean).length} day
                {Object.values(workingDays).filter(Boolean).length === 1 ? "" : "s"} per week
              </p>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="time-off">
          <MemberTimeOffBalanceSection memberDbId={parseInt(memberId ?? "0", 10)} />
        </TabsContent>

        <TabsContent value="pay">
          <ProfilePayTab isOwner={false} />
        </TabsContent>

        <TabsContent value="notifications">
          <ProfileNotificationsTab
            profile={profileData}
            onSaved={noop as (updated: FullProfileData) => void}
            readOnly
          />
        </TabsContent>

        <TabsContent value="security">
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-16 gap-4 text-center">
              <Lock size={32} className="text-muted-foreground" />
              <div className="space-y-1">
                <h3 className="font-semibold text-base">Security</h3>
                <p className="text-sm text-muted-foreground max-w-xs">
                  Security and authentication details are private to the member.
                </p>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
