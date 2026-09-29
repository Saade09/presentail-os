import { useState, useEffect } from "react";
import { Link, useSearch, useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { getCountries, type Country } from "react-phone-number-input";
import { PhoneInputField } from "@/components/PhoneInputField";
import { isExcludedCountry } from "@/lib/countries";
import {
  Users2,
  UserCheck,
  Clock,
  Crown,
  UserX,
  Shield,
  Search,
  Plus,
  Mail,
  Phone,
  Building2,
  BriefcaseBusiness,
  MoreHorizontal,
  ChevronRight,
  AlertTriangle,
  X,
  Wrench,
  ExternalLink,
  UserPlus,
  Globe,
  ChevronLeft,
  KeyRound,
  Eye,
  EyeOff,
} from "lucide-react";
import { apiFetch, queryClient } from "@/lib/queryClient";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";

const ALLOWED_COUNTRIES: Country[] = getCountries().filter(
  (c) => !isExcludedCountry(c),
);

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
  has_external_profile: boolean;
  external_type: string | null;
  external_company_name: string | null;
  access_expires_at: string | null;
  revoked_at: string | null;
};

type Stats = {
  totalPeople: number;
  totalTeamMembers: number;
  totalUsersWithAccess: number;
  totalPendingInvites: number;
  totalAdmins: number;
  totalNoLoginAccess: number;
  totalExternal: number;
};

type PeopleResponse = {
  people: PersonRow[];
  stats: Stats;
};

const TABS = [
  { id: "all", label: "All People" },
  { id: "team-members", label: "Team Members" },
  { id: "users", label: "Users With Access" },
  { id: "pending", label: "Pending Invites" },
  { id: "no-access", label: "No Login Access" },
  { id: "external", label: "External Users" },
  { id: "archived", label: "Archived" },
] as const;

type TabId = (typeof TABS)[number]["id"];

function personDisplayName(p: PersonRow): string {
  const first = p.first_name?.trim();
  const last = p.last_name?.trim();
  if (first && last) return `${first} ${last}`;
  if (first) return first;
  return p.email ?? "Unknown";
}

function PersonAvatar({ person }: { person: PersonRow }) {
  const initials = personDisplayName(person).charAt(0).toUpperCase();
  return (
    <div className="w-9 h-9 rounded-full bg-secondary flex items-center justify-center text-sm font-medium shrink-0 overflow-hidden">
      {person.image_url ? (
        <img
          src={person.image_url}
          alt=""
          className="w-full h-full object-cover"
          referrerPolicy="no-referrer"
        />
      ) : (
        initials
      )}
    </div>
  );
}

function AccessBadge({ person }: { person: PersonRow }) {
  const { t } = useTranslation();
  if (person.access_type === "owner") {
    return (
      <span className="inline-flex items-center gap-1 text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full">
        <Crown size={10} />
        {t("people.accessBadge.owner")}
      </span>
    );
  }
  if (person.access_type === "user") {
    return (
      <span className="inline-flex items-center gap-1 text-xs bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full">
        <UserCheck size={10} />
        {t("people.accessBadge.user")}
      </span>
    );
  }
  if (person.access_type === "pending_invite") {
    return (
      <span className="inline-flex items-center gap-1 text-xs bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full">
        <Clock size={10} />
        {t("people.accessBadge.pending")}
      </span>
    );
  }
  if (person.access_type === "team_member_only") {
    return (
      <span className="inline-flex items-center gap-1 text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded-full">
        <UserX size={10} />
        {t("people.accessBadge.noLogin")}
      </span>
    );
  }
  return null;
}

function SourceBadge({ source }: { source: PersonRow["source"] }) {
  const { t } = useTranslation();
  if (source === "both") {
    return (
      <span className="inline-flex items-center gap-1 text-xs bg-blue-100 text-blue-800 px-2 py-0.5 rounded-full">
        <Shield size={10} />
        {t("people.sourceBadge.both")}
      </span>
    );
  }
  if (source === "team_member") {
    return (
      <span className="inline-flex items-center gap-1 text-xs bg-purple-100 text-purple-800 px-2 py-0.5 rounded-full">
        {t("people.sourceBadge.teamMember")}
      </span>
    );
  }
  if (source === "external") {
    return (
      <span className="inline-flex items-center gap-1 text-xs bg-orange-100 text-orange-800 px-2 py-0.5 rounded-full">
        {t("people.external.sourceBadge")}
      </span>
    );
  }
  return null;
}

function StatCard({
  label,
  value,
  icon: Icon,
  color,
}: {
  label: string;
  value: number;
  icon: React.ElementType;
  color: string;
}) {
  return (
    <div className="bg-card border border-border rounded-xl p-4 space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">{label}</span>
        <Icon size={16} className={color} />
      </div>
      <p className="text-2xl font-bold">{value}</p>
    </div>
  );
}

type PersonType = "internal" | "workspace_user" | "workspace_user_password" | "external";

type InternalForm = {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  job_title: string;
  employment_status: string;
};

type InviteForm = {
  email: string;
  roleId: string;
};

type ExternalForm = {
  first_name: string;
  last_name: string;
  email: string;
  external_type: string;
  company: string;
};

type PasswordForm = {
  email: string;
  roleId: string;
  firstName: string;
  lastName: string;
  password: string;
  confirmPassword: string;
};

const EMPTY_INTERNAL: InternalForm = {
  first_name: "",
  last_name: "",
  email: "",
  phone: "",
  job_title: "",
  employment_status: "full_time",
};

const EMPTY_INVITE: InviteForm = { email: "", roleId: "" };

const EMPTY_PASSWORD_FORM: PasswordForm = {
  email: "",
  roleId: "",
  firstName: "",
  lastName: "",
  password: "",
  confirmPassword: "",
};

const EMPTY_EXTERNAL: ExternalForm = {
  first_name: "",
  last_name: "",
  email: "",
  external_type: "other",
  company: "",
};

type WorkspaceRole = { id: number; name: string };

function TypeCard({
  icon: Icon,
  title,
  description,
  onClick,
  isLastUsed,
  lastUsedLabel,
}: {
  icon: React.ElementType;
  title: string;
  description: string;
  onClick: () => void;
  isLastUsed?: boolean;
  lastUsedLabel?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "w-full text-left flex items-start gap-3 p-4 rounded-xl border transition-colors group " +
        (isLastUsed
          ? "border-primary bg-primary/5 hover:bg-primary/10"
          : "border-border hover:border-primary hover:bg-primary/5")
      }
    >
      <div className={
        "mt-0.5 p-2 rounded-lg transition-colors " +
        (isLastUsed ? "bg-primary/10" : "bg-muted group-hover:bg-primary/10")
      }>
        <Icon size={18} className={isLastUsed ? "text-primary" : "text-muted-foreground group-hover:text-primary"} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className="font-medium text-sm">{title}</p>
          {isLastUsed && lastUsedLabel && (
            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-primary/15 text-primary leading-none">
              {lastUsedLabel}
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-0.5 leading-snug">{description}</p>
      </div>
      <ChevronRight size={16} className={
        "shrink-0 mt-1 " + (isLastUsed ? "text-primary" : "text-muted-foreground group-hover:text-primary")
      } />
    </button>
  );
}

function DuplicateAlert({ personId, label, viewLabel }: { personId: string; label: string; viewLabel: string }) {
  return (
    <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700 text-amber-800 dark:text-amber-300 text-sm">
      <AlertTriangle size={15} className="mt-0.5 shrink-0" />
      <div>
        {label}{" "}
        <Link
          href={`/people/${encodeURIComponent(personId)}`}
          className="underline font-medium"
        >
          {viewLabel}
        </Link>
      </div>
    </div>
  );
}

function AddPersonDialog({
  open,
  onOpenChange,
  onCreated,
  initialType,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: () => void;
  initialType?: PersonType | null;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();

  const [step, setStep] = useState<"select" | "form">("select");
  const [personType, setPersonType] = useState<PersonType | null>(null);
  const [lastUsedType, setLastUsedType] = useState<PersonType | null>(null);
  const [internalForm, setInternalForm] = useState<InternalForm>(EMPTY_INTERNAL);
  const [inviteForm, setInviteForm] = useState<InviteForm>(EMPTY_INVITE);
  const [passwordForm, setPasswordForm] = useState<PasswordForm>(EMPTY_PASSWORD_FORM);
  const [showPassword, setShowPassword] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [externalForm, setExternalForm] = useState<ExternalForm>(EMPTY_EXTERNAL);
  const [duplicateId, setDuplicateId] = useState<string | null>(null);

  const { data: profileData } = useQuery<{ pref_add_person_last_type: string | null }>({
    queryKey: ["profile"],
    queryFn: () => apiFetch("/api/profile"),
    staleTime: 60_000,
  });

  useEffect(() => {
    if (!profileData) return;
    const stored = profileData.pref_add_person_last_type;
    if (stored === "internal" || stored === "workspace_user" || stored === "workspace_user_password" || stored === "external") {
      setLastUsedType(stored);
    }
  }, [profileData]);

  const { data: rolesData } = useQuery<{ roles: WorkspaceRole[] }>({
    queryKey: ["workspace-roles"],
    queryFn: () => apiFetch("/api/roles"),
    enabled: open && (personType === "workspace_user" || personType === "workspace_user_password"),
    staleTime: 60_000,
  });
  const roles = rolesData?.roles ?? [];

  function reset() {
    setStep("select");
    setPersonType(null);
    setInternalForm(EMPTY_INTERNAL);
    setInviteForm(EMPTY_INVITE);
    setPasswordForm(EMPTY_PASSWORD_FORM);
    setShowPassword(false);
    setPasswordError(null);
    setExternalForm(EMPTY_EXTERNAL);
    setDuplicateId(null);
  }

  useEffect(() => {
    if (open && initialType) {
      setPersonType(initialType);
      setStep("form");
    }
  }, [open, initialType]);

  function handleOpenChange(v: boolean) {
    if (!v) reset();
    onOpenChange(v);
  }

  function selectType(type: PersonType) {
    setPersonType(type);
    setLastUsedType(type);
    queryClient.setQueryData<{ pref_add_person_last_type: string | null }>(
      ["profile"],
      (prev) => prev ? { ...prev, pref_add_person_last_type: type } : prev,
    );
    apiFetch("/api/profile", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pref_add_person_last_type: type }),
    }).catch(() => {});
    setDuplicateId(null);
    setStep("form");
  }

  // ── Internal team member ────────────────────────────────────────────────────
  const createInternalMutation = useMutation({
    mutationFn: (data: InternalForm) =>
      apiFetch("/api/people", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          first_name: data.first_name.trim(),
          last_name: data.last_name.trim() || undefined,
          email: data.email.trim() || undefined,
          phone: data.phone.trim() || undefined,
          job_title: data.job_title.trim() || undefined,
          employment_status: data.employment_status || undefined,
        }),
      }),
    onSuccess: () => {
      toast({ title: t("people.addDialog.successToast") });
      handleOpenChange(false);
      onCreated();
    },
    onError: (err: Error & { status?: number; body?: Record<string, unknown> }) => {
      const body = err.body as { existing_person_id?: string } | undefined;
      if (body?.existing_person_id) {
        setDuplicateId(body.existing_person_id as string);
      } else {
        toast({ title: t("common.error"), description: err.message, variant: "destructive" });
      }
    },
  });

  function handleInternalSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!internalForm.first_name.trim()) return;
    setDuplicateId(null);
    createInternalMutation.mutate(internalForm);
  }

  // ── Workspace user / invite ─────────────────────────────────────────────────
  const inviteMutation = useMutation({
    mutationFn: (data: InviteForm) =>
      apiFetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: data.email.trim(), roleId: Number(data.roleId) }),
      }),
    onSuccess: () => {
      toast({ title: t("people.addDialog.inviteSent") });
      handleOpenChange(false);
      onCreated();
    },
    onError: (err: Error & { body?: Record<string, unknown> }) => {
      const body = err.body as { existing_person_id?: string } | undefined;
      if (body?.existing_person_id) {
        setDuplicateId(body.existing_person_id as string);
      } else {
        toast({ title: t("common.error"), description: err.message, variant: "destructive" });
      }
    },
  });

  function handleInviteSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!inviteForm.email.trim() || !inviteForm.roleId) return;
    inviteMutation.mutate(inviteForm);
  }

  // ── External user ───────────────────────────────────────────────────────────
  const createExternalMutation = useMutation({
    mutationFn: async (data: ExternalForm) => {
      const person = await apiFetch<{ id: string }>("/api/people", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          first_name: data.first_name.trim(),
          last_name: data.last_name.trim() || undefined,
          email: data.email.trim() || undefined,
          employment_status: "contractor",
        }),
      });
      await apiFetch(`/api/people/${encodeURIComponent(person.id)}/external-profile`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          external_type: data.external_type,
          company_name: data.company.trim() || undefined,
        }),
      });
      return person;
    },
    onSuccess: () => {
      toast({ title: t("people.addDialog.externalSuccess") });
      handleOpenChange(false);
      onCreated();
    },
    onError: (err: Error & { body?: Record<string, unknown> }) => {
      const body = err.body as { existing_person_id?: string } | undefined;
      if (body?.existing_person_id) {
        setDuplicateId(body.existing_person_id as string);
      } else {
        toast({ title: t("common.error"), description: err.message, variant: "destructive" });
      }
    },
  });

  function handleExternalSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!externalForm.first_name.trim()) return;
    setDuplicateId(null);
    createExternalMutation.mutate(externalForm);
  }

  const EXTERNAL_TYPES = [
    "auditor", "lawyer", "accountant", "consultant", "agency", "vendor", "other",
  ] as const;

  // ── Workspace user / Set Password ──────────────────────────────────────────
  const createWithPasswordMutation = useMutation({
    mutationFn: (data: PasswordForm) =>
      apiFetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: data.email.trim(),
          roleId: Number(data.roleId),
          mobilePassword: data.password,
          firstName: data.firstName.trim() || undefined,
          lastName: data.lastName.trim() || undefined,
        }),
      }),
    onSuccess: () => {
      toast({ title: t("people.addDialog.passwordUserSuccess") });
      handleOpenChange(false);
      onCreated();
    },
    onError: (err: Error & { body?: Record<string, unknown> }) => {
      const body = err.body as { existing_person_id?: string } | undefined;
      if (body?.existing_person_id) {
        setDuplicateId(body.existing_person_id as string);
      } else {
        toast({ title: t("common.error"), description: err.message, variant: "destructive" });
      }
    },
  });

  function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPasswordError(null);
    if (passwordForm.password.length < 8) {
      setPasswordError(t("people.addDialog.passwordTooShort"));
      return;
    }
    if (passwordForm.password !== passwordForm.confirmPassword) {
      setPasswordError(t("people.addDialog.passwordMismatch"));
      return;
    }
    setDuplicateId(null);
    createWithPasswordMutation.mutate(passwordForm);
  }

  const isAnythingPending =
    createInternalMutation.isPending ||
    inviteMutation.isPending ||
    createWithPasswordMutation.isPending ||
    createExternalMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("people.addDialog.title")}</DialogTitle>
        </DialogHeader>

        {/* ── Step 1: type selector ── */}
        {step === "select" && (
          <div className="space-y-3 py-1">
            <p className="text-sm text-muted-foreground">{t("people.addDialog.stepSelectType")}</p>
            <TypeCard
              icon={UserCheck}
              title={t("people.addDialog.typeInternalMember")}
              description={t("people.addDialog.typeInternalMemberDesc")}
              onClick={() => selectType("internal")}
              isLastUsed={lastUsedType === "internal"}
              lastUsedLabel={t("people.addDialog.lastUsed")}
            />
            <TypeCard
              icon={UserPlus}
              title={t("people.addDialog.typeWorkspaceUser")}
              description={t("people.addDialog.typeWorkspaceUserDesc")}
              onClick={() => selectType("workspace_user")}
              isLastUsed={lastUsedType === "workspace_user"}
              lastUsedLabel={t("people.addDialog.lastUsed")}
            />
            <TypeCard
              icon={KeyRound}
              title={t("people.addDialog.typePasswordUser")}
              description={t("people.addDialog.typePasswordUserDesc")}
              onClick={() => selectType("workspace_user_password")}
              isLastUsed={lastUsedType === "workspace_user_password"}
              lastUsedLabel={t("people.addDialog.lastUsed")}
            />
            <TypeCard
              icon={Globe}
              title={t("people.addDialog.typeExternalUser")}
              description={t("people.addDialog.typeExternalUserDesc")}
              onClick={() => selectType("external")}
              isLastUsed={lastUsedType === "external"}
              lastUsedLabel={t("people.addDialog.lastUsed")}
            />
          </div>
        )}

        {/* ── Step 2a: Internal Team Member ── */}
        {step === "form" && personType === "internal" && (
          <form onSubmit={handleInternalSubmit} className="space-y-4">
            {duplicateId && (
              <DuplicateAlert
                personId={duplicateId}
                label={t("people.addDialog.duplicateError")}
                viewLabel={t("people.addDialog.viewExistingProfile")}
              />
            )}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="add-first-name">
                  {t("people.addDialog.firstName")} <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="add-first-name"
                  value={internalForm.first_name}
                  onChange={(e) => setInternalForm((p) => ({ ...p, first_name: e.target.value }))}
                  placeholder={t("people.addDialog.firstNamePlaceholder")}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="add-last-name">{t("people.addDialog.lastName")}</Label>
                <Input
                  id="add-last-name"
                  value={internalForm.last_name}
                  onChange={(e) => setInternalForm((p) => ({ ...p, last_name: e.target.value }))}
                  placeholder={t("people.addDialog.lastNamePlaceholder")}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="add-email">{t("people.addDialog.email")}</Label>
              <Input
                id="add-email"
                type="email"
                value={internalForm.email}
                onChange={(e) => { setInternalForm((p) => ({ ...p, email: e.target.value })); setDuplicateId(null); }}
                placeholder={t("people.addDialog.emailPlaceholder")}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="add-phone">{t("people.addDialog.phone")}</Label>
              <PhoneInputField
                id="add-phone"
                international
                countryCallingCodeEditable={false}
                defaultCountry="LB"
                countries={ALLOWED_COUNTRIES}
                value={internalForm.phone || undefined}
                onChange={(val) => setInternalForm((p) => ({ ...p, phone: val ?? "" }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="add-job-title">{t("people.addDialog.jobTitle")}</Label>
              <Input
                id="add-job-title"
                value={internalForm.job_title}
                onChange={(e) => setInternalForm((p) => ({ ...p, job_title: e.target.value }))}
                placeholder={t("people.addDialog.jobTitlePlaceholder")}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="add-employment-status">{t("people.addDialog.employmentStatus")}</Label>
              <select
                id="add-employment-status"
                value={internalForm.employment_status}
                onChange={(e) => setInternalForm((p) => ({ ...p, employment_status: e.target.value }))}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                <option value="full_time">{t("people.addDialog.statusFullTime")}</option>
                <option value="part_time">{t("people.addDialog.statusPartTime")}</option>
                <option value="contractor">{t("people.addDialog.statusContractor")}</option>
                <option value="intern">{t("people.addDialog.statusIntern")}</option>
              </select>
            </div>
            <DialogFooter className="gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setStep("select")} disabled={isAnythingPending}>
                <ChevronLeft size={14} className="mr-1" />
                {t("people.addDialog.back")}
              </Button>
              <Button type="submit" disabled={isAnythingPending || !internalForm.first_name.trim()}>
                {isAnythingPending ? t("common.saving") : t("people.addDialog.submit")}
              </Button>
            </DialogFooter>
          </form>
        )}

        {/* ── Step 2b: Workspace User / Invite ── */}
        {step === "form" && personType === "workspace_user" && (
          <form onSubmit={handleInviteSubmit} className="space-y-4">
            {duplicateId && (
              <DuplicateAlert
                personId={duplicateId}
                label={t("people.addDialog.duplicateError")}
                viewLabel={t("people.addDialog.viewExistingProfile")}
              />
            )}
            <div className="space-y-1.5">
              <Label htmlFor="invite-email">
                {t("people.addDialog.inviteEmail")} <span className="text-destructive">*</span>
              </Label>
              <Input
                id="invite-email"
                type="email"
                value={inviteForm.email}
                onChange={(e) => { setInviteForm((p) => ({ ...p, email: e.target.value })); setDuplicateId(null); }}
                placeholder={t("people.addDialog.inviteEmailPlaceholder")}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="invite-role">
                {t("people.addDialog.inviteRole")} <span className="text-destructive">*</span>
              </Label>
              {roles.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("people.addDialog.noRoles")}</p>
              ) : (
                <select
                  id="invite-role"
                  value={inviteForm.roleId}
                  onChange={(e) => setInviteForm((p) => ({ ...p, roleId: e.target.value }))}
                  required
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <option value="">{t("people.addDialog.inviteRolePlaceholder")}</option>
                  {roles.map((r) => (
                    <option key={r.id} value={String(r.id)}>{r.name}</option>
                  ))}
                </select>
              )}
            </div>
            <DialogFooter className="gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setStep("select")} disabled={isAnythingPending}>
                <ChevronLeft size={14} className="mr-1" />
                {t("people.addDialog.back")}
              </Button>
              <Button
                type="submit"
                disabled={isAnythingPending || !inviteForm.email.trim() || !inviteForm.roleId}
              >
                {isAnythingPending ? t("common.saving") : t("people.addDialog.sendInvite")}
              </Button>
            </DialogFooter>
          </form>
        )}

        {/* ── Step 2d: Workspace User / Set Password ── */}
        {step === "form" && personType === "workspace_user_password" && (
          <form onSubmit={handlePasswordSubmit} className="space-y-4">
            {duplicateId && (
              <DuplicateAlert
                personId={duplicateId}
                label={t("people.addDialog.duplicateError")}
                viewLabel={t("people.addDialog.viewExistingProfile")}
              />
            )}
            <div className="space-y-1.5">
              <Label htmlFor="pw-email">
                {t("people.addDialog.inviteEmail")} <span className="text-destructive">*</span>
              </Label>
              <Input
                id="pw-email"
                type="email"
                value={passwordForm.email}
                onChange={(e) => { setPasswordForm((p) => ({ ...p, email: e.target.value })); setDuplicateId(null); }}
                placeholder={t("people.addDialog.inviteEmailPlaceholder")}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pw-role">
                {t("people.addDialog.inviteRole")} <span className="text-destructive">*</span>
              </Label>
              {roles.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("people.addDialog.noRoles")}</p>
              ) : (
                <select
                  id="pw-role"
                  value={passwordForm.roleId}
                  onChange={(e) => setPasswordForm((p) => ({ ...p, roleId: e.target.value }))}
                  required
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  <option value="">{t("people.addDialog.inviteRolePlaceholder")}</option>
                  {roles.map((r) => (
                    <option key={r.id} value={String(r.id)}>{r.name}</option>
                  ))}
                </select>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="pw-first-name">{t("people.addDialog.firstName")}</Label>
                <Input
                  id="pw-first-name"
                  value={passwordForm.firstName}
                  onChange={(e) => setPasswordForm((p) => ({ ...p, firstName: e.target.value }))}
                  placeholder={t("people.addDialog.firstNamePlaceholder")}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pw-last-name">{t("people.addDialog.lastName")}</Label>
                <Input
                  id="pw-last-name"
                  value={passwordForm.lastName}
                  onChange={(e) => setPasswordForm((p) => ({ ...p, lastName: e.target.value }))}
                  placeholder={t("people.addDialog.lastNamePlaceholder")}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pw-password">
                {t("people.addDialog.password")} <span className="text-destructive">*</span>
              </Label>
              <div className="relative">
                <Input
                  id="pw-password"
                  type={showPassword ? "text" : "password"}
                  value={passwordForm.password}
                  onChange={(e) => { setPasswordForm((p) => ({ ...p, password: e.target.value })); setPasswordError(null); }}
                  placeholder={t("people.addDialog.passwordPlaceholder")}
                  required
                  className="pr-9"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute inset-y-0 end-0 flex items-center px-3 text-muted-foreground hover:text-foreground"
                  tabIndex={-1}
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pw-confirm">
                {t("people.addDialog.confirmPassword")} <span className="text-destructive">*</span>
              </Label>
              <Input
                id="pw-confirm"
                type={showPassword ? "text" : "password"}
                value={passwordForm.confirmPassword}
                onChange={(e) => { setPasswordForm((p) => ({ ...p, confirmPassword: e.target.value })); setPasswordError(null); }}
                placeholder={t("people.addDialog.confirmPasswordPlaceholder")}
                required
              />
            </div>
            {passwordError && (
              <p className="text-sm text-destructive">{passwordError}</p>
            )}
            <DialogFooter className="gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setStep("select")} disabled={isAnythingPending}>
                <ChevronLeft size={14} className="mr-1" />
                {t("people.addDialog.back")}
              </Button>
              <Button
                type="submit"
                disabled={isAnythingPending || !passwordForm.email.trim() || !passwordForm.roleId || !passwordForm.password || !passwordForm.confirmPassword}
              >
                {isAnythingPending ? t("common.saving") : t("people.addDialog.createPasswordUser")}
              </Button>
            </DialogFooter>
          </form>
        )}

        {/* ── Step 2c: External User ── */}
        {step === "form" && personType === "external" && (
          <form onSubmit={handleExternalSubmit} className="space-y-4">
            {duplicateId && (
              <DuplicateAlert
                personId={duplicateId}
                label={t("people.addDialog.duplicateError")}
                viewLabel={t("people.addDialog.viewExistingProfile")}
              />
            )}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="ext-first-name">
                  {t("people.addDialog.firstName")} <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="ext-first-name"
                  value={externalForm.first_name}
                  onChange={(e) => setExternalForm((p) => ({ ...p, first_name: e.target.value }))}
                  placeholder={t("people.addDialog.firstNamePlaceholder")}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ext-last-name">{t("people.addDialog.lastName")}</Label>
                <Input
                  id="ext-last-name"
                  value={externalForm.last_name}
                  onChange={(e) => setExternalForm((p) => ({ ...p, last_name: e.target.value }))}
                  placeholder={t("people.addDialog.lastNamePlaceholder")}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ext-email">{t("people.addDialog.email")}</Label>
              <Input
                id="ext-email"
                type="email"
                value={externalForm.email}
                onChange={(e) => { setExternalForm((p) => ({ ...p, email: e.target.value })); setDuplicateId(null); }}
                placeholder={t("people.addDialog.emailPlaceholder")}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ext-type">{t("people.addDialog.externalType")}</Label>
              <select
                id="ext-type"
                value={externalForm.external_type}
                onChange={(e) => setExternalForm((p) => ({ ...p, external_type: e.target.value }))}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {EXTERNAL_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {t(`people.external.types.${type}`)}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ext-company">{t("people.addDialog.externalCompany")}</Label>
              <Input
                id="ext-company"
                value={externalForm.company}
                onChange={(e) => setExternalForm((p) => ({ ...p, company: e.target.value }))}
                placeholder={t("people.addDialog.externalCompanyPlaceholder")}
              />
            </div>
            <DialogFooter className="gap-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setStep("select")} disabled={isAnythingPending}>
                <ChevronLeft size={14} className="mr-1" />
                {t("people.addDialog.back")}
              </Button>
              <Button type="submit" disabled={isAnythingPending || !externalForm.first_name.trim()}>
                {isAnythingPending ? t("common.saving") : t("people.addDialog.addExternal")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

export default function PeopleDirectoryPage() {
  const { t } = useTranslation();
  const { isOwner } = useWorkspaceRole();

  const [tab, setTab] = useState<TabId>("all");
  const [search, setSearch] = useState("");
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [addInitialType, setAddInitialType] = useState<PersonType | null>(null);
  const [bannerDismissed, setBannerDismissed] = useState(false);

  const searchString = useSearch();
  const [, setLocation] = useLocation();

  useEffect(() => {
    const params = new URLSearchParams(searchString);
    const add = params.get("add");
    if (!add) return;
    if (add === "invite") {
      setAddInitialType("workspace_user");
    } else if (add === "internal" || add === "workspace_user" || add === "external") {
      setAddInitialType(add as PersonType);
    } else {
      setAddInitialType(null);
    }
    setAddDialogOpen(true);
    setLocation("/people", { replace: true });
  }, [searchString, setLocation]);

  const { data, isLoading } = useQuery<PeopleResponse>({
    queryKey: ["people", { tab, q: search }],
    queryFn: () => {
      const params = new URLSearchParams();
      params.set("tab", tab);
      if (search) params.set("q", search);
      return apiFetch(`/api/people?${params}`);
    },
  });

  const { data: orphanData, refetch: refetchOrphans } = useQuery<{ orphan_count: number }>({
    queryKey: ["people-orphan-count"],
    queryFn: () => apiFetch("/api/people/orphan-count"),
    enabled: isOwner,
    staleTime: 60_000,
  });

  const orphanCount = orphanData?.orphan_count ?? 0;

  const repairMutation = useMutation({
    mutationFn: () =>
      apiFetch("/api/people/repair-orphans", { method: "POST" }),
    onSuccess: (result: { repaired: number }) => {
      queryClient.invalidateQueries({ queryKey: ["people"] });
      refetchOrphans();
      if (result.repaired === 0) {
        setBannerDismissed(true);
      }
    },
  });

  const people = data?.people ?? [];
  const stats = data?.stats;

  function handlePersonCreated() {
    queryClient.invalidateQueries({ queryKey: ["people"] });
    refetchOrphans();
  }

  const showOrphanBanner = isOwner && !bannerDismissed && orphanCount > 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Users2 size={22} />
            {t("people.directory.title")}
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            {t("people.directory.subtitle")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link href="/roles">
              {t("people.directory.manageRoles")}
            </Link>
          </Button>
          {isOwner && (
            <Button size="sm" onClick={() => setAddDialogOpen(true)}>
              <Plus size={16} className="mr-1" />
              {t("people.directory.addPerson")}
            </Button>
          )}
        </div>
      </div>

      {showOrphanBanner && (
        <div className="flex items-start gap-3 p-4 rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300">
          <AlertTriangle size={18} className="mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">
              {t("people.orphanBanner.title", { count: orphanCount })}
            </p>
            <p className="text-xs mt-0.5 opacity-80">
              {t("people.orphanBanner.description")}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              size="sm"
              variant="outline"
              className="border-amber-300 dark:border-amber-700 text-amber-800 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-800/40 h-7 text-xs"
              onClick={() => repairMutation.mutate()}
              disabled={repairMutation.isPending}
            >
              <Wrench size={12} className="mr-1" />
              {repairMutation.isPending
                ? t("people.orphanBanner.repairing")
                : t("people.orphanBanner.repairButton")}
            </Button>
            <button
              onClick={() => setBannerDismissed(true)}
              className="p-1 rounded hover:bg-amber-100 dark:hover:bg-amber-800/40 transition-colors"
              aria-label={t("common.dismiss")}
            >
              <X size={14} />
            </button>
          </div>
        </div>
      )}

      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
          <StatCard
            label={t("people.stats.totalPeople")}
            value={stats.totalPeople}
            icon={Users2}
            color="text-primary"
          />
          <StatCard
            label={t("people.stats.teamMembers")}
            value={stats.totalTeamMembers}
            icon={UserCheck}
            color="text-purple-600"
          />
          <StatCard
            label={t("people.stats.usersWithAccess")}
            value={stats.totalUsersWithAccess}
            icon={Shield}
            color="text-emerald-600"
          />
          <StatCard
            label={t("people.stats.pendingInvites")}
            value={stats.totalPendingInvites}
            icon={Clock}
            color="text-amber-600"
          />
          <StatCard
            label={t("people.stats.admins")}
            value={stats.totalAdmins}
            icon={Crown}
            color="text-blue-600"
          />
          <StatCard
            label={t("people.stats.noLoginAccess")}
            value={stats.totalNoLoginAccess}
            icon={UserX}
            color="text-muted-foreground"
          />
          <StatCard
            label={t("people.stats.externalUsers")}
            value={stats.totalExternal}
            icon={ExternalLink}
            color="text-orange-600"
          />
        </div>
      )}

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder={t("people.directory.searchPlaceholder")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      <div className="flex gap-1 border-b border-border overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={`px-4 py-2 text-sm font-medium whitespace-nowrap border-b-2 transition-colors ${
              tab === t.id
                ? "border-primary text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground text-sm">
          {t("common.loading")}
        </div>
      ) : people.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 gap-2 text-muted-foreground">
          <Users2 size={32} className="opacity-30" />
          <p className="text-sm">{t("people.directory.empty")}</p>
        </div>
      ) : (
        <div className="border border-border rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/40">
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">
                  {t("people.directory.colName")}
                </th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden md:table-cell">
                  {t("people.directory.colRoleDept")}
                </th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden lg:table-cell">
                  {t("people.directory.colContact")}
                </th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">
                  {t("people.directory.colAccess")}
                </th>
                <th className="px-4 py-3 w-10" />
              </tr>
            </thead>
            <tbody>
              {people.map((person) => (
                <tr
                  key={person.id}
                  className="border-b last:border-0 hover:bg-muted/20 transition-colors"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <PersonAvatar person={person} />
                      <div className="min-w-0">
                        <Link
                          href={`/people/${encodeURIComponent(person.id)}`}
                          className="font-medium truncate hover:underline"
                        >
                          {personDisplayName(person)}
                        </Link>
                        {person.email && (
                          <div className="text-xs text-muted-foreground truncate">
                            {person.email}
                          </div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 hidden md:table-cell">
                    <div className="space-y-0.5">
                      {person.job_title && (
                        <div className="flex items-center gap-1 text-sm">
                          <BriefcaseBusiness size={12} className="text-muted-foreground" />
                          {person.job_title}
                        </div>
                      )}
                      {person.department_name && (
                        <div className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Building2 size={11} />
                          {person.department_name}
                        </div>
                      )}
                      {person.role_name && (
                        <Badge variant="secondary" className="text-xs h-5 py-0">
                          {person.role_name}
                        </Badge>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 hidden lg:table-cell">
                    <div className="space-y-0.5">
                      {person.email && (
                        <div className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Mail size={11} />
                          {person.email}
                        </div>
                      )}
                      {person.phone && (
                        <div className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Phone size={11} />
                          {person.phone}
                        </div>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      <AccessBadge person={person} />
                      <SourceBadge source={person.source} />
                      {person.revoked_at && (
                        <span className="inline-flex items-center gap-1 text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full">
                          {t("people.external.accessRevoked")}
                        </span>
                      )}
                      {!person.revoked_at && person.access_expires_at && new Date(person.access_expires_at) < new Date() && (
                        <span className="inline-flex items-center gap-1 text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full">
                          {t("people.external.accessExpired")}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-7 w-7">
                          <MoreHorizontal size={14} />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem asChild>
                          <Link href={`/people/${encodeURIComponent(person.id)}`}>
                            <ChevronRight size={14} className="mr-1" />
                            {t("people.directory.viewProfile")}
                          </Link>
                        </DropdownMenuItem>
                        {person.team_member_id && (
                          <DropdownMenuItem asChild>
                            <Link href={`/admin/people/team-members`}>
                              <UserCheck size={14} className="mr-1" />
                              {t("people.directory.viewTeamMember")}
                            </Link>
                          </DropdownMenuItem>
                        )}
                        {(person.access_type === "user" || person.access_type === "owner") && (
                          <DropdownMenuItem asChild>
                            <Link href="/people/access">
                              <Shield size={14} className="mr-1" />
                              {t("people.directory.manageAccess")}
                            </Link>
                          </DropdownMenuItem>
                        )}
                        {person.access_type === "pending_invite" && isOwner && (
                          <DropdownMenuItem asChild>
                            <Link href="/people/access">
                              <Mail size={14} className="mr-1" />
                              {t("people.directory.manageInvite")}
                            </Link>
                          </DropdownMenuItem>
                        )}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {isOwner && (
        <AddPersonDialog
          open={addDialogOpen}
          onOpenChange={(v) => {
            setAddDialogOpen(v);
            if (!v) setAddInitialType(null);
          }}
          onCreated={handlePersonCreated}
          initialType={addInitialType}
        />
      )}
    </div>
  );
}
