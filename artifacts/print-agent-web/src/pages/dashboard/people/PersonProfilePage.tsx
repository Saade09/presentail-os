import { useState } from "react";
import { useRoute, Link, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient, useInfiniteQuery } from "@tanstack/react-query";
import {
  Users2,
  UserCheck,
  Shield,
  Clock,
  ArrowLeft,
  Crown,
  Mail,
  Phone,
  BriefcaseBusiness,
  Building2,
  CalendarDays,
  Activity,
  Pencil,
  Trash2,
  User,
  CalendarClock,
  HeartPulse,
  ClipboardList,
  CheckCircle2,
  XCircle,
  ChevronDown,
  ChevronUp,
  Link2,
  Ban,
  CalendarX,
  Plus,
} from "lucide-react";
import { apiFetch } from "@/lib/queryClient";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { MemberHoverCard } from "@/components/MemberHoverCard";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";

const TABS = [
  { id: "overview", labelKey: "people.profile.tabOverview", icon: Users2 },
  { id: "team-member", labelKey: "people.profile.tabTeamMember", icon: UserCheck },
  { id: "access", labelKey: "people.profile.tabAccess", icon: Shield },
  { id: "activity", labelKey: "people.profile.tabActivity", icon: Activity },
] as const;

type TabId = (typeof TABS)[number]["id"];

type PersonRow = {
  id: string;
  source: "member" | "team_member" | "both" | "external";
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  job_title: string | null;
  department_name: string | null;
  image_url: string | null;
  access_type: "owner" | "user" | "pending_invite" | "team_member_only" | "no_access";
  role: string | null;
  role_name: string | null;
  custom_role_id: number | null;
  joined: boolean;
  joined_at: string | null;
  invited_at: string | null;
  member_id: number | null;
  team_member_id: number | null;
  employment_status: string | null;
  archived_at: string | null;
  person_id: number | null;
  profile_id: number | null;
  employee_code: string | null;
  start_date: string | null;
  birthday: string | null;
  emergency_contact_name: string | null;
  emergency_contact_phone: string | null;
  emergency_contact_relationship: string | null;
  notes: string | null;
  manager_id: number | null;
  manager_name: string | null;
  work_schedule_id: number | null;
  work_schedule_name: string | null;
  work_schedule_weekly_hours: number | null;
  department_id: number | null;
  work_schedule_days: Array<{
    day_of_week: string;
    is_working_day: boolean;
    start_time: string | null;
    end_time: string | null;
    break_minutes: number;
  }> | null;
  employment_type: string | null;
  attendance_enabled: boolean | null;
  profile_status: string | null;
  has_external_profile: boolean;
  external_type: string | null;
  external_company_name: string | null;
  access_expires_at: string | null;
  revoked_at: string | null;
};

type Department = { id: number; name: string };
type WorkSchedule = { id: number; name: string };
type TeamMemberOption = { id: number; first_name: string; last_name: string | null; job_title: string | null; department_name: string | null };

const EXTERNAL_TYPES = ["auditor", "lawyer", "accountant", "consultant", "agency", "vendor", "other"] as const;

type ExternalProfileForm = {
  external_type: string;
  company_name: string;
  reason_for_access: string;
  notes: string;
};

type EditForm = {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  job_title: string;
  employment_status: string;
  department_id: string;
  manager_id: string;
  work_schedule_id: string;
  start_date: string;
  birthday: string;
  emergency_contact_name: string;
  emergency_contact_phone: string;
  emergency_contact_relationship: string;
  notes: string;
  attendance_enabled: boolean;
};

function displayName(p: PersonRow): string {
  const first = p.first_name?.trim();
  const last = p.last_name?.trim();
  if (first && last) return `${first} ${last}`;
  if (first) return first;
  return p.email ?? "Unknown";
}

function AccessTypeLabel({ accessType }: { accessType: PersonRow["access_type"] }) {
  const { t } = useTranslation();
  if (accessType === "owner") {
    return (
      <span className="inline-flex items-center gap-1 text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full">
        <Crown size={10} />
        {t("people.accessBadge.owner")}
      </span>
    );
  }
  if (accessType === "user") {
    return (
      <span className="inline-flex items-center gap-1 text-xs bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full">
        <UserCheck size={10} />
        {t("people.accessBadge.user")}
      </span>
    );
  }
  if (accessType === "pending_invite") {
    return (
      <span className="inline-flex items-center gap-1 text-xs bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full">
        <Clock size={10} />
        {t("people.accessBadge.pending")}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded-full">
      {t("people.accessBadge.noLogin")}
    </span>
  );
}

export default function PersonProfilePage() {
  const { t } = useTranslation();
  const [, params] = useRoute("/people/:id");
  const personId = params?.id ?? "";
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { isOwner } = useWorkspaceRole();

  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const [scheduleExpanded, setScheduleExpanded] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [extProfileOpen, setExtProfileOpen] = useState(false);
  const [extProfileForm, setExtProfileForm] = useState<ExternalProfileForm>({
    external_type: "other",
    company_name: "",
    reason_for_access: "",
    notes: "",
  });
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [expiryOpen, setExpiryOpen] = useState(false);
  const [expiryValue, setExpiryValue] = useState("");
  const [editForm, setEditForm] = useState<EditForm>({
    first_name: "",
    last_name: "",
    email: "",
    phone: "",
    job_title: "",
    employment_status: "full_time",
    department_id: "",
    manager_id: "",
    work_schedule_id: "",
    start_date: "",
    birthday: "",
    emergency_contact_name: "",
    emergency_contact_phone: "",
    emergency_contact_relationship: "",
    notes: "",
    attendance_enabled: false,
  });

  const { data: person, isLoading, isError } = useQuery<PersonRow>({
    queryKey: ["people", personId],
    queryFn: () => apiFetch(`/api/people/${encodeURIComponent(personId)}`),
    enabled: !!personId,
  });

  const { data: departments } = useQuery<Department[]>({
    queryKey: ["departments"],
    queryFn: () =>
      apiFetch("/api/departments").then(
        (r: { departments: Department[] }) => r.departments ?? [],
      ),
    enabled: editOpen,
  });

  const { data: workSchedules } = useQuery<WorkSchedule[]>({
    queryKey: ["work-schedules"],
    queryFn: () =>
      apiFetch("/api/work-schedules").then(
        (r: { work_schedules: WorkSchedule[] }) => r.work_schedules ?? [],
      ),
    enabled: editOpen || activeTab === "team-member",
  });

  const scheduleAssignMutation = useMutation({
    mutationFn: (scheduleId: number | null) =>
      apiFetch(`/api/people/${encodeURIComponent(personId)}/schedule`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ work_schedule_id: scheduleId }),
      }),
    onSuccess: (response: PersonRow) => {
      queryClient.setQueryData(["people", personId], response);
      queryClient.invalidateQueries({ queryKey: ["people", personId] });
      toast({ title: t("people.profile.scheduleAssigned") });
    },
    onError: (err: Error) => {
      toast({ title: t("common.error"), description: err.message, variant: "destructive" });
    },
  });

  const activityLimit = 20;

  type ActivityItem = {
    id: number;
    field_name: string;
    old_value: string | null;
    new_value: string | null;
    old_label: string | null;
    new_label: string | null;
    changed_by_name: string;
    changed_at: string;
  };
  type ActivityResponse = { items: ActivityItem[]; total: number; page: number; limit: number };

  const {
    data: activityData,
    isLoading: activityLoading,
    isError: activityError,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery<ActivityResponse>({
    queryKey: ["people-activity", personId],
    queryFn: ({ pageParam }) =>
      apiFetch(
        `/api/people/${encodeURIComponent(personId)}/activity?page=${pageParam}&limit=${activityLimit}`,
      ),
    initialPageParam: 1,
    getNextPageParam: (lastPage) =>
      lastPage.page * lastPage.limit < lastPage.total ? lastPage.page + 1 : undefined,
    enabled: !!personId && activeTab === "activity" && personId.startsWith("tm_"),
  });

  const activityItems = activityData?.pages.flatMap((p) => p.items) ?? [];
  const activityTotal = activityData?.pages[activityData.pages.length - 1]?.total ?? 0;

  const { data: teamMembersRaw } = useQuery<TeamMemberOption[]>({
    queryKey: ["team-members-list"],
    queryFn: () =>
      apiFetch("/api/team-members").then(
        (r: { team_members: TeamMemberOption[] }) => r.team_members ?? [],
      ),
    enabled: editOpen || activeTab === "activity" || activeTab === "team-member",
  });
  const teamMemberOptions = teamMembersRaw ?? [];
  const managerDetailsMap = new Map(
    teamMemberOptions.map((tm) => [
      tm.id,
      { job_title: tm.job_title, department_name: tm.department_name },
    ]),
  );
  const changerDetailsMap = new Map(
    teamMemberOptions.map((tm) => [
      [tm.first_name, tm.last_name].filter(Boolean).join(" "),
      { job_title: tm.job_title, department_name: tm.department_name },
    ]),
  );

  const updateMutation = useMutation({
    mutationFn: (data: EditForm) => {
      const payload: Record<string, unknown> = {
        first_name: data.first_name,
        last_name: data.last_name || "",
        email: data.email || "",
        phone: data.phone || "",
        job_title: data.job_title || "",
        employment_status: data.employment_status,
        department_id: data.department_id ? Number(data.department_id) : null,
        manager_id: data.manager_id ? Number(data.manager_id) : null,
        work_schedule_id: data.work_schedule_id ? Number(data.work_schedule_id) : null,
        start_date: data.start_date || null,
        birthday: data.birthday || null,
        emergency_contact_name: data.emergency_contact_name || "",
        emergency_contact_phone: data.emergency_contact_phone || "",
        emergency_contact_relationship: data.emergency_contact_relationship || "",
        notes: data.notes || "",
        attendance_enabled: data.attendance_enabled,
      };
      return apiFetch(`/api/people/${encodeURIComponent(personId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    },
    onSuccess: (_response, variables) => {
      queryClient.setQueryData(["people", personId], (old: PersonRow | undefined) => {
        if (!old) return old;
        return {
          ...old,
          first_name: variables.first_name,
          last_name: variables.last_name || "",
          email: variables.email || "",
          phone: variables.phone || "",
          job_title: variables.job_title || "",
          employment_status: variables.employment_status,
          department_id: variables.department_id ? Number(variables.department_id) : null,
          manager_id: variables.manager_id ? Number(variables.manager_id) : null,
          work_schedule_id: variables.work_schedule_id ? Number(variables.work_schedule_id) : null,
          start_date: variables.start_date || null,
          birthday: variables.birthday || null,
          emergency_contact_name: variables.emergency_contact_name || "",
          emergency_contact_phone: variables.emergency_contact_phone || "",
          emergency_contact_relationship: variables.emergency_contact_relationship || "",
          notes: variables.notes || "",
          attendance_enabled: variables.attendance_enabled,
        };
      });
      queryClient.setQueriesData(
        { queryKey: ["people"] },
        (old: unknown) => {
          if (!old || typeof old !== "object") return old;
          const list = old as { people?: PersonRow[]; stats?: unknown };
          if (!Array.isArray(list.people)) return old;
          return {
            ...list,
            people: list.people.map((p) =>
              p.id === personId
                ? {
                    ...p,
                    first_name: variables.first_name,
                    last_name: variables.last_name || "",
                    job_title: variables.job_title || "",
                  }
                : p,
            ),
          };
        },
      );
      queryClient.invalidateQueries({ queryKey: ["people", personId] });
      queryClient.invalidateQueries({ queryKey: ["people"] });
      setEditOpen(false);
      toast({ title: t("people.editDialog.successToast") });
    },
    onError: (err: Error) => {
      toast({ title: t("common.error"), description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/people/${encodeURIComponent(personId)}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["people"] });
      toast({ title: t("people.deleteDialog.successToast") });
      navigate("/people");
    },
    onError: (err: Error) => {
      toast({ title: t("common.error"), description: err.message, variant: "destructive" });
    },
  });

  function openEditDialog() {
    if (!person) return;
    setEditForm({
      first_name: person.first_name ?? "",
      last_name: person.last_name ?? "",
      email: person.email ?? "",
      phone: person.phone ?? "",
      job_title: person.job_title ?? "",
      employment_status: person.employment_status ?? "full_time",
      department_id: person.department_id != null ? String(person.department_id) : "",
      manager_id: person.manager_id != null ? String(person.manager_id) : "",
      work_schedule_id: person.work_schedule_id != null ? String(person.work_schedule_id) : "",
      start_date: person.start_date ? person.start_date.slice(0, 10) : "",
      birthday: person.birthday ? person.birthday.slice(0, 10) : "",
      emergency_contact_name: person.emergency_contact_name ?? "",
      emergency_contact_phone: person.emergency_contact_phone ?? "",
      emergency_contact_relationship: person.emergency_contact_relationship ?? "",
      notes: person.notes ?? "",
      attendance_enabled: person.attendance_enabled ?? false,
    });
    setEditOpen(true);
  }

  function handleEditChange(field: keyof EditForm, value: string | boolean) {
    setEditForm((prev) => ({ ...prev, [field]: value }));
  }

  const saveExternalProfileMutation = useMutation({
    mutationFn: (form: ExternalProfileForm) => {
      const method = person?.has_external_profile ? "PATCH" : "POST";
      return apiFetch(`/api/people/${encodeURIComponent(personId)}/external-profile`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          external_type: form.external_type,
          company_name: form.company_name || null,
          reason_for_access: form.reason_for_access || null,
          notes: form.notes || null,
        }),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["people", personId] });
      queryClient.invalidateQueries({ queryKey: ["people"] });
      setExtProfileOpen(false);
      toast({ title: t("people.external.profileSaved") });
    },
    onError: (err: Error) => {
      toast({ title: t("common.error"), description: err.message, variant: "destructive" });
    },
  });

  const removeExternalProfileMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/people/${encodeURIComponent(personId)}/external-profile`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["people", personId] });
      queryClient.invalidateQueries({ queryKey: ["people"] });
      toast({ title: t("people.external.profileRemoved") });
    },
    onError: (err: Error) => {
      toast({ title: t("common.error"), description: err.message, variant: "destructive" });
    },
  });

  const revokeAccessMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/people/${encodeURIComponent(personId)}/revoke-access`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["people", personId] });
      queryClient.invalidateQueries({ queryKey: ["people"] });
      setRevokeOpen(false);
      toast({ title: t("people.external.accessRevoked") });
    },
    onError: (err: Error) => {
      toast({ title: t("common.error"), description: err.message, variant: "destructive" });
    },
  });

  const setExpiryMutation = useMutation({
    mutationFn: (dateStr: string | null) =>
      apiFetch(`/api/people/${encodeURIComponent(personId)}/access-expiry`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access_expires_at: dateStr }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["people", personId] });
      queryClient.invalidateQueries({ queryKey: ["people"] });
      setExpiryOpen(false);
      toast({ title: t("people.external.expiryUpdated") });
    },
    onError: (err: Error) => {
      toast({ title: t("common.error"), description: err.message, variant: "destructive" });
    },
  });

  function openExtProfileDialog() {
    if (!person) return;
    setExtProfileForm({
      external_type: person.external_type ?? "other",
      company_name: person.external_company_name ?? "",
      reason_for_access: "",
      notes: "",
    });
    setExtProfileOpen(true);
  }

  function openExpiryDialog() {
    if (!person) return;
    setExpiryValue(person.access_expires_at ? person.access_expires_at.slice(0, 10) : "");
    setExpiryOpen(true);
  }

  const canEditDelete = isOwner && person?.id.startsWith("tm_");

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh] text-muted-foreground text-sm">
        {t("common.loading")}
      </div>
    );
  }

  if (isError || !person) {
    return (
      <div className="max-w-4xl mx-auto">
        <div className="flex flex-col items-center justify-center py-16 gap-3 text-muted-foreground">
          <Users2 size={32} className="opacity-30" />
          <p className="text-sm">{t("people.profile.notFound")}</p>
          <Button variant="outline" size="sm" asChild>
            <Link href="/people">
              <ArrowLeft size={14} className="mr-1" />
              {t("people.profile.backToDirectory")}
            </Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" asChild>
          <Link href="/people">
            <ArrowLeft size={16} className="mr-1" />
            {t("people.profile.backToDirectory")}
          </Link>
        </Button>
      </div>

      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <div className="w-16 h-16 rounded-full bg-secondary flex items-center justify-center text-2xl font-bold shrink-0">
            {person.image_url ? (
              <img
                src={person.image_url}
                alt=""
                className="w-full h-full rounded-full object-cover"
                referrerPolicy="no-referrer"
              />
            ) : (
              displayName(person).charAt(0).toUpperCase()
            )}
          </div>
          <div className="space-y-1">
            <h1 className="text-2xl font-bold">{displayName(person)}</h1>
            {person.job_title && (
              <p className="text-muted-foreground text-sm flex items-center gap-1">
                <BriefcaseBusiness size={14} />
                {person.job_title}
              </p>
            )}
            <div className="flex flex-wrap gap-1.5">
              <AccessTypeLabel accessType={person.access_type} />
              {person.source === "both" && (
                <Badge variant="secondary" className="text-xs h-5 py-0">
                  {t("people.sourceBadge.both")}
                </Badge>
              )}
              {person.source === "external" && (
                <span className="inline-flex items-center gap-1 text-xs bg-orange-100 text-orange-800 px-2 py-0.5 rounded-full">
                  {t("people.external.sourceBadge")}
                </span>
              )}
              {person.role_name && (
                <Badge variant="outline" className="text-xs h-5 py-0">
                  {person.role_name}
                </Badge>
              )}
              {person.revoked_at && (
                <span className="inline-flex items-center gap-1 text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full">
                  <Ban size={10} />
                  {t("people.external.accessRevoked")}
                </span>
              )}
              {!person.revoked_at && person.access_expires_at && new Date(person.access_expires_at) < new Date() && (
                <span className="inline-flex items-center gap-1 text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full">
                  <CalendarX size={10} />
                  {t("people.external.accessExpired")}
                </span>
              )}
              {!person.revoked_at && person.access_expires_at && new Date(person.access_expires_at) >= new Date() && (
                <span className="inline-flex items-center gap-1 text-xs bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full">
                  <CalendarDays size={10} />
                  {t("people.external.accessExpiresOn", {
                    date: new Date(person.access_expires_at).toLocaleDateString(undefined, {
                      month: "short", day: "numeric", year: "numeric",
                    }),
                  })}
                </span>
              )}
            </div>
          </div>
        </div>

        {canEditDelete && (
          <div className="flex items-center gap-2 shrink-0">
            <Button
              variant="outline"
              size="sm"
              className="text-destructive border-destructive/40 hover:bg-destructive/10"
              onClick={() => setDeleteOpen(true)}
            >
              <Trash2 size={14} className="mr-1" />
              {t("people.deleteDialog.title")}
            </Button>
          </div>
        )}
      </div>

      <div className="flex gap-1 border-b border-border">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 px-4 py-2 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
                activeTab === tab.id
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon size={14} />
              {t(tab.labelKey)}
            </button>
          );
        })}
      </div>

      {activeTab === "overview" && (
        <div className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t("people.profile.contactInfo")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {person.email && (
                  <div className="flex items-center gap-2 text-sm">
                    <Mail size={14} className="text-muted-foreground" />
                    <span>{person.email}</span>
                  </div>
                )}
                {person.phone && (
                  <div className="flex items-center gap-2 text-sm">
                    <Phone size={14} className="text-muted-foreground" />
                    <span>{person.phone}</span>
                  </div>
                )}
                {!person.email && !person.phone && (
                  <p className="text-sm text-muted-foreground">{t("people.profile.noContactInfo")}</p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">{t("people.profile.workInfo")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {person.job_title && (
                  <div className="flex items-center gap-2 text-sm">
                    <BriefcaseBusiness size={14} className="text-muted-foreground" />
                    <span>{person.job_title}</span>
                  </div>
                )}
                {person.department_name && (
                  <div className="flex items-center gap-2 text-sm">
                    <Building2 size={14} className="text-muted-foreground" />
                    <span>{person.department_name}</span>
                  </div>
                )}
                {person.employment_status && (
                  <div className="flex items-center gap-2 text-sm">
                    <CalendarDays size={14} className="text-muted-foreground" />
                    <span className="capitalize">{person.employment_status.replace(/_/g, " ")}</span>
                  </div>
                )}
                {!person.job_title && !person.department_name && !person.employment_status && (
                  <p className="text-sm text-muted-foreground">{t("people.profile.noWorkInfo")}</p>
                )}
              </CardContent>
            </Card>
          </div>

          {(person.has_external_profile || person.source === "external" || isOwner) && (
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Link2 size={16} />
                    {t("people.external.sectionTitle")}
                  </CardTitle>
                  {isOwner && (
                    <div className="flex items-center gap-2">
                      {person.has_external_profile && (
                        <>
                          <Button variant="outline" size="sm" onClick={openExtProfileDialog}>
                            <Pencil size={14} className="mr-1" />
                            {t("people.external.editProfile")}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-destructive border-destructive/40 hover:bg-destructive/10"
                            onClick={() => removeExternalProfileMutation.mutate()}
                            disabled={removeExternalProfileMutation.isPending}
                          >
                            <Trash2 size={14} className="mr-1" />
                            {t("people.external.removeProfile")}
                          </Button>
                        </>
                      )}
                      {!person.has_external_profile && (
                        <Button variant="outline" size="sm" onClick={openExtProfileDialog}>
                          <Plus size={14} className="mr-1" />
                          {t("people.external.addProfile")}
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {person.has_external_profile ? (
                  <div className="space-y-4">
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <p className="text-xs text-muted-foreground">{t("people.external.type")}</p>
                        <p className="text-sm font-medium capitalize">
                          {t(`people.external.types.${person.external_type ?? "other"}`, {
                            defaultValue: (person.external_type ?? "other").replace(/_/g, " "),
                          })}
                        </p>
                      </div>
                      {person.external_company_name && (
                        <div>
                          <p className="text-xs text-muted-foreground">{t("people.external.company")}</p>
                          <p className="text-sm font-medium">{person.external_company_name}</p>
                        </div>
                      )}
                    </div>

                    {isOwner && (
                      <div className="border-t pt-4 space-y-3">
                        <p className="text-sm font-medium">{t("people.external.accessExpiry")}</p>
                        <div className="flex items-center gap-3 flex-wrap">
                          {person.access_expires_at ? (
                            <span className="text-sm text-muted-foreground">
                              {t("people.external.accessExpiresOn", {
                                date: new Date(person.access_expires_at).toLocaleDateString(undefined, {
                                  year: "numeric", month: "long", day: "numeric",
                                }),
                              })}
                            </span>
                          ) : (
                            <span className="text-sm text-muted-foreground">{t("people.external.setExpiry")}</span>
                          )}
                          <Button variant="outline" size="sm" onClick={openExpiryDialog}>
                            <CalendarDays size={14} className="mr-1" />
                            {person.access_expires_at ? t("common.edit") : t("people.external.setExpiry")}
                          </Button>
                          {person.access_expires_at && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="text-muted-foreground"
                              onClick={() => setExpiryMutation.mutate(null)}
                              disabled={setExpiryMutation.isPending}
                            >
                              {t("common.clear")}
                            </Button>
                          )}
                        </div>

                        {!person.revoked_at && (person.access_type === "user" || person.access_type === "owner") && (
                          <div className="pt-1">
                            <Button
                              variant="outline"
                              size="sm"
                              className="text-destructive border-destructive/40 hover:bg-destructive/10"
                              onClick={() => setRevokeOpen(true)}
                            >
                              <Ban size={14} className="mr-1" />
                              {t("people.external.revokeAccess")}
                            </Button>
                          </div>
                        )}
                        {person.revoked_at && (
                          <div className="flex items-center gap-2 text-sm text-red-600 bg-red-50 rounded-md px-3 py-2">
                            <Ban size={14} />
                            <span>
                              {t("people.external.accessRevoked")} —{" "}
                              {new Date(person.revoked_at).toLocaleDateString(undefined, {
                                year: "numeric", month: "long", day: "numeric",
                              })}
                            </span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">{t("people.external.noProfile")}</p>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {activeTab === "team-member" && (
        <div className="space-y-4">
          {person.team_member_id || person.profile_id ? (
            <>
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base flex items-center gap-2">
                      <BriefcaseBusiness size={16} />
                      {t("people.profile.sectionEmployment")}
                    </CardTitle>
                    {canEditDelete && (
                      <Button variant="outline" size="sm" onClick={openEditDialog}>
                        <Pencil size={14} className="mr-1" />
                        {t("people.editDialog.title")}
                      </Button>
                    )}
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="grid gap-3 sm:grid-cols-2">
                    {person.job_title && (
                      <div>
                        <p className="text-xs text-muted-foreground">{t("people.profile.jobTitle")}</p>
                        <p className="text-sm font-medium">{person.job_title}</p>
                      </div>
                    )}
                    {person.department_name && (
                      <div>
                        <p className="text-xs text-muted-foreground">{t("people.profile.department")}</p>
                        <p className="text-sm font-medium">{person.department_name}</p>
                      </div>
                    )}
                    {(person.employment_type ?? person.employment_status) && (
                      <div>
                        <p className="text-xs text-muted-foreground">{t("people.profile.employmentType")}</p>
                        <p className="text-sm font-medium capitalize">
                          {(person.employment_type ?? person.employment_status)!.replace(/_/g, " ")}
                        </p>
                      </div>
                    )}
                    {person.start_date && (
                      <div>
                        <p className="text-xs text-muted-foreground">{t("people.profile.startDate")}</p>
                        <p className="text-sm font-medium">
                          {new Date(person.start_date).toLocaleDateString(undefined, {
                            year: "numeric",
                            month: "long",
                            day: "numeric",
                          })}
                        </p>
                      </div>
                    )}
                    {person.employee_code && (
                      <div>
                        <p className="text-xs text-muted-foreground">{t("people.profile.employeeCode")}</p>
                        <p className="text-sm font-medium font-mono">{person.employee_code}</p>
                      </div>
                    )}
                    {person.birthday && (
                      <div>
                        <p className="text-xs text-muted-foreground">{t("people.profile.birthday")}</p>
                        <p className="text-sm font-medium">
                          {new Date(person.birthday).toLocaleDateString(undefined, {
                            month: "long",
                            day: "numeric",
                          })}
                        </p>
                      </div>
                    )}
                    {person.manager_name && (
                      <div>
                        <p className="text-xs text-muted-foreground">{t("people.profile.manager")}</p>
                        <p className="text-sm font-medium flex items-center gap-1">
                          <User size={13} className="text-muted-foreground" />
                          {(() => {
                            const mgr = person.manager_id != null ? managerDetailsMap.get(Number(person.manager_id)) : undefined;
                            const nameNode = person.manager_id != null ? (
                              <Link
                                href={`/dashboard/people/${person.manager_id}`}
                                className="hover:underline text-primary"
                              >
                                {person.manager_name}
                              </Link>
                            ) : (
                              <span>{person.manager_name}</span>
                            );
                            return (
                              <MemberHoverCard
                                name={person.manager_name ?? ""}
                                personId={person.manager_id}
                                jobTitle={mgr?.job_title}
                                departmentName={mgr?.department_name}
                                side="bottom"
                              >
                                {nameNode}
                              </MemberHoverCard>
                            );
                          })()}
                        </p>
                      </div>
                    )}
                    {person.id.startsWith("tm_") && (
                      <div className="sm:col-span-2">
                        <p className="text-xs text-muted-foreground mb-1">{t("people.profile.workSchedule")}</p>
                        <div className="flex items-center gap-2 flex-wrap">
                          <select
                            className="h-8 rounded-md border border-input bg-transparent px-2 py-1 text-sm flex-1 min-w-0"
                            value={person.work_schedule_id ?? ""}
                            disabled={scheduleAssignMutation.isPending}
                            onChange={(e) => {
                              const val = e.target.value;
                              scheduleAssignMutation.mutate(val === "" ? null : Number(val));
                            }}
                          >
                            <option value="">{t("people.profile.noScheduleAssigned")}</option>
                            {(workSchedules ?? []).map((ws) => (
                              <option key={ws.id} value={String(ws.id)}>{ws.name}</option>
                            ))}
                          </select>
                          {person.work_schedule_weekly_hours != null && person.work_schedule_name && (
                            <span className="text-xs text-muted-foreground tabular-nums shrink-0">
                              {person.work_schedule_weekly_hours} hrs/wk
                            </span>
                          )}
                        </div>
                        {person.work_schedule_name && person.work_schedule_days && person.work_schedule_days.length > 0 && (
                          <>
                            <button
                              type="button"
                              onClick={() => setScheduleExpanded((v) => !v)}
                              className="mt-1 flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                            >
                              <CalendarClock size={12} className="shrink-0" />
                              <span>{person.work_schedule_name}</span>
                              {scheduleExpanded
                                ? <ChevronUp size={12} className="shrink-0" />
                                : <ChevronDown size={12} className="shrink-0" />
                              }
                            </button>
                            {scheduleExpanded && (
                              <div className="mt-2 rounded-md border bg-muted/30 divide-y text-xs">
                                {person.work_schedule_days.map((day) => {
                                  const label = t(`people.profile.scheduleDays.${day.day_of_week}`, { defaultValue: day.day_of_week });
                                  const formatTime = (s: string) => s.slice(0, 5);
                                  return (
                                    <div key={day.day_of_week} className="flex items-center justify-between px-3 py-1.5">
                                      <span className={day.is_working_day ? "font-medium" : "text-muted-foreground"}>{label}</span>
                                      {day.is_working_day && day.start_time && day.end_time ? (
                                        <span className="text-muted-foreground tabular-nums">
                                          {formatTime(day.start_time)} – {formatTime(day.end_time)}
                                        </span>
                                      ) : (
                                        <span className="text-muted-foreground italic">{t("people.profile.scheduleOff")}</span>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    )}
                    {person.attendance_enabled != null && (
                      <div>
                        <p className="text-xs text-muted-foreground">{t("people.profile.attendance")}</p>
                        <p className="text-sm font-medium flex items-center gap-1">
                          {person.attendance_enabled ? (
                            <>
                              <CheckCircle2 size={13} className="text-emerald-600" />
                              {t("people.profile.attendanceEnabled")}
                            </>
                          ) : (
                            <>
                              <XCircle size={13} className="text-muted-foreground" />
                              {t("people.profile.attendanceDisabled")}
                            </>
                          )}
                        </p>
                      </div>
                    )}
                    {person.profile_status && (
                      <div>
                        <p className="text-xs text-muted-foreground">{t("people.profile.profileStatus")}</p>
                        <p className="text-sm font-medium capitalize">
                          {person.profile_status.replace(/_/g, " ")}
                        </p>
                      </div>
                    )}
                  </div>
                  {!person.job_title && !person.department_name && !person.employment_type && !person.employment_status && !person.start_date && !person.employee_code && !person.birthday && !person.manager_name && !person.work_schedule_name && (
                    <p className="text-sm text-muted-foreground">{t("people.profile.teamMemberLinked")}</p>
                  )}
                </CardContent>
              </Card>

              {(person.emergency_contact_name || person.emergency_contact_phone) ? (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                      <HeartPulse size={16} />
                      {t("people.profile.sectionEmergencyContact")}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {person.emergency_contact_name && (
                      <div className="flex items-center gap-2 text-sm">
                        <User size={14} className="text-muted-foreground" />
                        <span>
                          {person.emergency_contact_name}
                          {person.emergency_contact_relationship && (
                            <span className="text-muted-foreground ml-1">
                              ({person.emergency_contact_relationship})
                            </span>
                          )}
                        </span>
                      </div>
                    )}
                    {person.emergency_contact_phone && (
                      <div className="flex items-center gap-2 text-sm">
                        <Phone size={14} className="text-muted-foreground" />
                        <span>{person.emergency_contact_phone}</span>
                      </div>
                    )}
                  </CardContent>
                </Card>
              ) : person.team_member_id ? (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                      <HeartPulse size={16} />
                      {t("people.profile.sectionEmergencyContact")}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm text-muted-foreground">{t("people.profile.noEmergencyContact")}</p>
                  </CardContent>
                </Card>
              ) : null}

              {person.notes && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base flex items-center gap-2">
                      <ClipboardList size={16} />
                      {t("people.profile.sectionNotes")}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <p className="text-sm whitespace-pre-wrap">{person.notes}</p>
                  </CardContent>
                </Card>
              )}

              <div className="pt-1">
                <Button variant="outline" size="sm" asChild>
                  <Link href="/admin/people/team-members">
                    <UserCheck size={14} className="mr-1" />
                    {t("people.profile.viewInTeamMembers")}
                  </Link>
                </Button>
              </div>
            </>
          ) : (
            <Card>
              <CardContent className="pt-6">
                <div className="flex flex-col items-center justify-center py-8 gap-2 text-muted-foreground">
                  <UserCheck size={28} className="opacity-30" />
                  <p className="text-sm">{t("people.profile.noTeamMemberProfile")}</p>
                  {person.member_id && (
                    <Button variant="outline" size="sm" asChild>
                      <Link href="/admin/people/team-members">
                        {t("people.profile.createTeamMember")}
                      </Link>
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {activeTab === "access" && (
        <Card>
          <CardContent className="pt-6">
            {person.member_id ? (
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">{t("people.profile.loginStatus")}</p>
                    <div className="mt-1">
                      <AccessTypeLabel accessType={person.access_type} />
                    </div>
                  </div>
                </div>
                {person.joined_at && (
                  <div>
                    <p className="text-xs text-muted-foreground">{t("people.profile.joinedAt")}</p>
                    <p className="text-sm">
                      {new Date(person.joined_at).toLocaleDateString(undefined, {
                        year: "numeric",
                        month: "long",
                        day: "numeric",
                      })}
                    </p>
                  </div>
                )}
                <Button variant="outline" size="sm" asChild>
                  <Link href="/users">
                    <Shield size={14} className="mr-1" />
                    {t("people.profile.manageAccessInUsers")}
                  </Link>
                </Button>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center py-8 gap-2 text-muted-foreground">
                <Shield size={28} className="opacity-30" />
                <p className="text-sm">{t("people.profile.noLoginAccess")}</p>
                <Button variant="outline" size="sm" asChild>
                  <Link href="/users">
                    {t("people.profile.inviteToWorkspace")}
                  </Link>
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {activeTab === "activity" && (
        <div className="space-y-3">
          {activityLoading && (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <p className="text-sm">{t("people.profile.activityLoading")}</p>
            </div>
          )}
          {activityError && (
            <div className="flex items-center justify-center py-12 text-destructive">
              <p className="text-sm">{t("people.profile.activityError")}</p>
            </div>
          )}
          {!personId.startsWith("tm_") && !activityLoading && !activityError && (
            <Card>
              <CardContent className="pt-6">
                <div className="flex flex-col items-center justify-center py-12 gap-2 text-muted-foreground">
                  <Activity size={28} className="opacity-30" />
                  <p className="text-sm">{t("people.profile.activityComingSoon")}</p>
                </div>
              </CardContent>
            </Card>
          )}
          {activityData && activityItems.length === 0 && (
            <Card>
              <CardContent className="pt-6">
                <div className="flex flex-col items-center justify-center py-12 gap-2 text-muted-foreground">
                  <Activity size={28} className="opacity-30" />
                  <p className="text-sm">{t("people.profile.activityEmpty")}</p>
                </div>
              </CardContent>
            </Card>
          )}
          {activityData && activityItems.length > 0 && (
            <div className="relative">
              <div className="absolute left-4 top-0 bottom-0 w-px bg-border" />
              <div className="space-y-4">
                {activityItems.map((item) => {
                  const fieldLabel = t(
                    `people.profile.activityFields.${item.field_name}`,
                    { defaultValue: item.field_name.replace(/_/g, " ") },
                  );
                  const oldDisplay = item.old_value == null ? t("people.profile.activityUnset") : (item.old_label ?? item.old_value);
                  const newDisplay = item.new_value == null ? t("people.profile.activityUnset") : (item.new_label ?? item.new_value);
                  const date = new Date(item.changed_at);
                  return (
                    <div key={item.id} className="relative pl-10">
                      <div className="absolute left-2.5 top-1.5 w-3 h-3 rounded-full bg-primary/20 border-2 border-primary ring-2 ring-background" />
                      <Card>
                        <CardContent className="pt-4 pb-4">
                          <div className="flex items-start justify-between gap-2 flex-wrap">
                            <p className="text-sm font-medium">
                              {t("people.profile.activityFieldChanged", { field: fieldLabel })}
                            </p>
                            <span className="text-xs text-muted-foreground whitespace-nowrap">
                              {date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}
                              {" "}
                              {date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                            </span>
                          </div>
                          <div className="mt-2 flex items-center gap-2 text-sm text-muted-foreground flex-wrap">
                            <span className="flex items-center gap-1">
                              <span className="font-medium text-xs uppercase tracking-wide">{t("people.profile.activityFrom")}</span>
                              {item.field_name === "manager_id" && item.old_value != null ? (() => {
                                const mgr = managerDetailsMap.get(Number(item.old_value));
                                return (
                                  <MemberHoverCard
                                    name={oldDisplay}
                                    personId={Number(item.old_value)}
                                    jobTitle={mgr?.job_title}
                                    departmentName={mgr?.department_name}
                                    side="bottom"
                                  >
                                    <span className="bg-muted rounded px-1.5 py-0.5 text-xs font-mono max-w-[200px] truncate cursor-default">{oldDisplay}</span>
                                  </MemberHoverCard>
                                );
                              })() : (
                                <span className="bg-muted rounded px-1.5 py-0.5 text-xs font-mono max-w-[200px] truncate">{oldDisplay}</span>
                              )}
                            </span>
                            <span className="text-muted-foreground">→</span>
                            <span className="flex items-center gap-1">
                              <span className="font-medium text-xs uppercase tracking-wide">{t("people.profile.activityTo")}</span>
                              {item.field_name === "manager_id" && item.new_value != null ? (() => {
                                const mgr = managerDetailsMap.get(Number(item.new_value));
                                return (
                                  <MemberHoverCard
                                    name={newDisplay}
                                    personId={Number(item.new_value)}
                                    jobTitle={mgr?.job_title}
                                    departmentName={mgr?.department_name}
                                    side="bottom"
                                  >
                                    <span className="bg-primary/10 text-primary rounded px-1.5 py-0.5 text-xs font-mono max-w-[200px] truncate cursor-default">{newDisplay}</span>
                                  </MemberHoverCard>
                                );
                              })() : (
                                <span className="bg-primary/10 text-primary rounded px-1.5 py-0.5 text-xs font-mono max-w-[200px] truncate">{newDisplay}</span>
                              )}
                            </span>
                          </div>
                          <p className="mt-1.5 text-xs text-muted-foreground">
                            {(() => {
                              const changer = item.changed_by_name ? changerDetailsMap.get(item.changed_by_name) : undefined;
                              const nameNode = item.changed_by_name ? (
                                <MemberHoverCard
                                  name={item.changed_by_name}
                                  jobTitle={changer?.job_title}
                                  departmentName={changer?.department_name}
                                  side="bottom"
                                >
                                  <span className="cursor-default underline decoration-dotted">{item.changed_by_name}</span>
                                </MemberHoverCard>
                              ) : (
                                <span>{item.changed_by_name}</span>
                              );
                              return <>{t("people.profile.activityChangedBy", { name: "" })}{nameNode}</>;
                            })()}
                          </p>
                        </CardContent>
                      </Card>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          {hasNextPage && (
            <div className="flex justify-center pt-2">
              <Button
                variant="outline"
                size="sm"
                disabled={isFetchingNextPage}
                onClick={() => fetchNextPage()}
              >
                {isFetchingNextPage
                  ? t("people.profile.activityLoading")
                  : t("people.profile.activityLoadMore")}
              </Button>
            </div>
          )}
        </div>
      )}

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-secondary flex items-center justify-center text-base font-bold shrink-0">
                {person.image_url ? (
                  <img
                    src={person.image_url}
                    alt=""
                    className="w-full h-full rounded-full object-cover"
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  displayName(person).charAt(0).toUpperCase()
                )}
              </div>
              <DialogTitle>{t("people.editDialog.title")}</DialogTitle>
            </div>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              {t("people.editDialog.sectionBasic")}
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="edit-first-name">
                  {t("people.addDialog.firstName")} <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="edit-first-name"
                  value={editForm.first_name}
                  onChange={(e) => handleEditChange("first_name", e.target.value)}
                  placeholder={t("people.addDialog.firstNamePlaceholder")}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="edit-last-name">{t("people.addDialog.lastName")}</Label>
                <Input
                  id="edit-last-name"
                  value={editForm.last_name}
                  onChange={(e) => handleEditChange("last_name", e.target.value)}
                  placeholder={t("people.addDialog.lastNamePlaceholder")}
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="edit-email">{t("people.addDialog.email")}</Label>
              <Input
                id="edit-email"
                type="email"
                value={editForm.email}
                onChange={(e) => handleEditChange("email", e.target.value)}
                placeholder={t("people.addDialog.emailPlaceholder")}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="edit-phone">{t("people.addDialog.phone")}</Label>
              <Input
                id="edit-phone"
                value={editForm.phone}
                onChange={(e) => handleEditChange("phone", e.target.value)}
                placeholder={t("people.addDialog.phonePlaceholder")}
              />
            </div>

            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider pt-2">
              {t("people.editDialog.sectionEmployment")}
            </p>
            <div className="space-y-1">
              <Label htmlFor="edit-job-title">{t("people.addDialog.jobTitle")}</Label>
              <Input
                id="edit-job-title"
                value={editForm.job_title}
                onChange={(e) => handleEditChange("job_title", e.target.value)}
                placeholder={t("people.addDialog.jobTitlePlaceholder")}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="edit-department">{t("people.profile.department")}</Label>
                <select
                  id="edit-department"
                  className="w-full h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                  value={editForm.department_id}
                  onChange={(e) => handleEditChange("department_id", e.target.value)}
                >
                  <option value="">{t("people.editDialog.noDepartment")}</option>
                  {(departments ?? []).map((d) => (
                    <option key={d.id} value={String(d.id)}>{d.name}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="edit-employment-status">{t("people.addDialog.employmentStatus")}</Label>
                <select
                  id="edit-employment-status"
                  className="w-full h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                  value={editForm.employment_status}
                  onChange={(e) => handleEditChange("employment_status", e.target.value)}
                >
                  <option value="full_time">{t("people.addDialog.statusFullTime")}</option>
                  <option value="part_time">{t("people.addDialog.statusPartTime")}</option>
                  <option value="contractor">{t("people.addDialog.statusContractor")}</option>
                  <option value="intern">{t("people.addDialog.statusIntern")}</option>
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="edit-start-date">{t("people.profile.startDate")}</Label>
                <Input
                  id="edit-start-date"
                  type="date"
                  value={editForm.start_date}
                  onChange={(e) => handleEditChange("start_date", e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="edit-manager">{t("people.profile.manager")}</Label>
                <select
                  id="edit-manager"
                  className="w-full h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                  value={editForm.manager_id}
                  onChange={(e) => handleEditChange("manager_id", e.target.value)}
                >
                  <option value="">{t("people.editDialog.noManager")}</option>
                  {teamMemberOptions
                    .filter((tm) => tm.id !== person?.team_member_id)
                    .map((tm) => (
                      <option key={tm.id} value={String(tm.id)}>
                        {tm.first_name}{tm.last_name ? ` ${tm.last_name}` : ""}
                      </option>
                    ))}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="edit-work-schedule">{t("people.profile.workSchedule")}</Label>
                <select
                  id="edit-work-schedule"
                  className="w-full h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                  value={editForm.work_schedule_id}
                  onChange={(e) => handleEditChange("work_schedule_id", e.target.value)}
                >
                  <option value="">{t("people.editDialog.noWorkSchedule")}</option>
                  {(workSchedules ?? []).map((ws) => (
                    <option key={ws.id} value={String(ws.id)}>{ws.name}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="edit-birthday">{t("people.profile.birthday")}</Label>
                <Input
                  id="edit-birthday"
                  type="date"
                  value={editForm.birthday}
                  onChange={(e) => handleEditChange("birthday", e.target.value)}
                />
              </div>
            </div>
            <div className="flex items-center gap-3">
              <input
                id="edit-attendance"
                type="checkbox"
                className="h-4 w-4 rounded border border-input"
                checked={editForm.attendance_enabled}
                onChange={(e) => handleEditChange("attendance_enabled", e.target.checked)}
              />
              <Label htmlFor="edit-attendance" className="cursor-pointer">
                {t("people.editDialog.attendanceEnabled")}
              </Label>
            </div>

            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider pt-2">
              {t("people.editDialog.sectionEmergencyContact")}
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label htmlFor="edit-ec-name">{t("people.editDialog.ecName")}</Label>
                <Input
                  id="edit-ec-name"
                  value={editForm.emergency_contact_name}
                  onChange={(e) => handleEditChange("emergency_contact_name", e.target.value)}
                  placeholder={t("people.editDialog.ecNamePlaceholder")}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="edit-ec-phone">{t("people.editDialog.ecPhone")}</Label>
                <Input
                  id="edit-ec-phone"
                  value={editForm.emergency_contact_phone}
                  onChange={(e) => handleEditChange("emergency_contact_phone", e.target.value)}
                  placeholder={t("people.editDialog.ecPhonePlaceholder")}
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="edit-ec-relationship">{t("people.editDialog.ecRelationship")}</Label>
              <Input
                id="edit-ec-relationship"
                value={editForm.emergency_contact_relationship}
                onChange={(e) => handleEditChange("emergency_contact_relationship", e.target.value)}
                placeholder={t("people.editDialog.ecRelationshipPlaceholder")}
              />
            </div>

            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider pt-2">
              {t("people.editDialog.sectionNotes")}
            </p>
            <div className="space-y-1">
              <textarea
                id="edit-notes"
                className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm min-h-[72px] resize-none focus:outline-none focus:ring-1 focus:ring-ring"
                value={editForm.notes}
                onChange={(e) => handleEditChange("notes", e.target.value)}
                placeholder={t("people.editDialog.notesPlaceholder")}
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() => updateMutation.mutate(editForm)}
              disabled={!editForm.first_name.trim() || updateMutation.isPending}
            >
              {updateMutation.isPending ? t("common.saving") : t("people.editDialog.submit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("people.deleteDialog.title")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {t("people.deleteDialog.description", { name: displayName(person) })}
          </p>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDeleteOpen(false)}>
              {t("people.deleteDialog.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? t("common.saving") : t("people.deleteDialog.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={extProfileOpen} onOpenChange={setExtProfileOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {person.has_external_profile
                ? t("people.external.editProfile")
                : t("people.external.addProfile")}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-1">
            <div className="space-y-1">
              <Label htmlFor="ext-type">{t("people.external.type")}</Label>
              <select
                id="ext-type"
                className="w-full h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                value={extProfileForm.external_type}
                onChange={(e) => setExtProfileForm((p) => ({ ...p, external_type: e.target.value }))}
              >
                {EXTERNAL_TYPES.map((et) => (
                  <option key={et} value={et}>
                    {t(`people.external.types.${et}`, { defaultValue: et })}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="ext-company">{t("people.external.company")}</Label>
              <Input
                id="ext-company"
                value={extProfileForm.company_name}
                onChange={(e) => setExtProfileForm((p) => ({ ...p, company_name: e.target.value }))}
                placeholder={t("people.externalCompanyPlaceholder", { defaultValue: "Company name (optional)" })}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ext-reason">{t("people.external.reasonForAccess")}</Label>
              <Input
                id="ext-reason"
                value={extProfileForm.reason_for_access}
                onChange={(e) => setExtProfileForm((p) => ({ ...p, reason_for_access: e.target.value }))}
                placeholder={t("people.external.reasonForAccess")}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="ext-notes">{t("people.external.notes")}</Label>
              <textarea
                id="ext-notes"
                className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm min-h-[60px] resize-none focus:outline-none focus:ring-1 focus:ring-ring"
                value={extProfileForm.notes}
                onChange={(e) => setExtProfileForm((p) => ({ ...p, notes: e.target.value }))}
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setExtProfileOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() => saveExternalProfileMutation.mutate(extProfileForm)}
              disabled={saveExternalProfileMutation.isPending}
            >
              {saveExternalProfileMutation.isPending ? t("common.saving") : t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={revokeOpen} onOpenChange={setRevokeOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("people.external.revokeAccess")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm font-medium">
            {t("people.external.revokeAccessConfirm", { name: displayName(person) })}
          </p>
          <p className="text-sm text-muted-foreground">
            {t("people.external.revokeAccessDesc")}
          </p>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setRevokeOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => revokeAccessMutation.mutate()}
              disabled={revokeAccessMutation.isPending}
            >
              {revokeAccessMutation.isPending ? t("common.saving") : t("people.external.revokeAccess")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={expiryOpen} onOpenChange={setExpiryOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("people.external.accessExpiry")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <Label htmlFor="expiry-date">{t("people.external.setExpiry")}</Label>
            <Input
              id="expiry-date"
              type="date"
              value={expiryValue}
              onChange={(e) => setExpiryValue(e.target.value)}
            />
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setExpiryOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() => setExpiryMutation.mutate(expiryValue || null)}
              disabled={setExpiryMutation.isPending}
            >
              {setExpiryMutation.isPending ? t("common.saving") : t("common.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
