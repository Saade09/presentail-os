import { useMemo, useState, useEffect } from "react";
import { Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  Users, Trash2, Mail, Crown, Clock, UserPlus, ShieldCheck, AlertTriangle, X,
  CheckCircle2, UserCheck, RotateCcw, Ban, Copy, Check, MapPin, Briefcase,
  Pencil, Filter, ArrowUpDown, CalendarOff, CalendarDays, MoreHorizontal, ExternalLink,
  Eye, EyeOff, Smartphone,
} from "lucide-react";
import { apiFetch, queryClient } from "@/lib/queryClient";
import { useTranslation } from "react-i18next";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { formatWorkSchedule } from "@/lib/workSchedule";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { StaleDataBadge } from "@/components/StaleDataBadge";
import { useRoles } from "@/hooks/use-roles";
import { cn } from "@/lib/utils";

const COPY_FEEDBACK_MS = 2000;

type AssignedLocation = { id: number; name: string };

type EmploymentType = "full_time" | "part_time" | "contractor" | "intern";
type EmploymentStatus = "active" | "inactive" | "on_leave";

type WorkingDaysConfig = {
  monday: boolean;
  tuesday: boolean;
  wednesday: boolean;
  thursday: boolean;
  friday: boolean;
  saturday: boolean;
  sunday: boolean;
};

const DEFAULT_WORKING_DAYS: WorkingDaysConfig = {
  monday: true,
  tuesday: true,
  wednesday: true,
  thursday: true,
  friday: true,
  saturday: false,
  sunday: false,
};

type Member = {
  id: number;
  email: string;
  role: "owner" | "member";
  custom_role_id: number | null;
  role_name: string | null;
  role_names: string[];
  custom_role_ids: number[];
  joined: boolean;
  joined_at: string | null;
  invited_at: string;
  invited_by_email: string | null;
  manager_member_id: number | null;
  manager_email: string | null;
  florist_location_id: number | null;
  first_name: string | null;
  last_name: string | null;
  image_url: string | null;
  invite_token: string | null;
  assigned_locations: AssignedLocation[];
  job_title: string | null;
  start_date: string | null;
  department: string | null;
  location: string | null;
  employment_type: EmploymentType | null;
  employment_status: EmploymentStatus;
  working_days: WorkingDaysConfig | null;
};

const DEPARTMENT_OPTIONS = [
  "Operations",
  "Customer Service",
  "Design",
  "Engineering",
  "Marketing",
  "Sales",
  "Finance",
  "HR",
  "Logistics",
  "Production",
  "Other",
] as const;

const EMPLOYMENT_TYPE_LABELS: Record<EmploymentType, string> = {
  full_time: "Full-time",
  part_time: "Part-time",
  contractor: "Contractor",
  intern: "Intern",
};

const EMPLOYMENT_STATUS_LABELS: Record<EmploymentStatus, string> = {
  active: "Active",
  inactive: "Inactive",
  on_leave: "On leave",
};

const EMPLOYMENT_STATUS_BADGE: Record<EmploymentStatus, string> = {
  active: "bg-emerald-100 text-emerald-800 border-emerald-200",
  inactive: "bg-muted text-muted-foreground border-border",
  on_leave: "bg-amber-100 text-amber-800 border-amber-200",
};

type UsersResponse = {
  members: Member[];
  me: {
    role: string;
    email: string | null;
    allowedPages: string[] | null;
    customRoleId: number | null;
    customRoleIds?: number[];
  };
};

function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function displayName(m: {
  first_name?: string | null;
  last_name?: string | null;
  email: string;
}): string {
  const first = m.first_name?.trim();
  const last = m.last_name?.trim();
  if (first && last) return `${first} ${last.charAt(0).toUpperCase()}.`;
  if (first) return first;
  return m.email;
}

type AuditLogEntry = {
  id: number;
  changed_by_user_id: string;
  target_member_id: number;
  old_role: string | null;
  new_role: string | null;
  old_custom_role_id: number | null;
  new_custom_role_id: number | null;
  old_role_name: string | null;
  new_role_name: string | null;
  target_email: string | null;
  changed_at: string;
};

type FailedAccessRequest = {
  id: number;
  requester_email: string;
  requester_name: string;
  error_message: string | null;
  created_at: string;
};

type AccessRequest = {
  id: number;
  requester_clerk_id: string;
  requester_email: string;
  requester_name: string;
  status: string;
  requested_at: string;
  resolved_at: string | null;
};

type PendingRoleChange = {
  member: Member;
  newRoleId: number;
  newRoleName: string;
};

type PendingManagerChange = {
  member: Member;
  newManagerId: number | null;
  newManagerEmail: string | null;
};

type PendingLocationChange = {
  member: Member;
  selectedIds: Set<number>;
};

type EmploymentInfoForm = {
  member: Member;
  jobTitle: string;
  startDate: string;
  managerMemberId: string;
  department: string;
  location: string;
  employmentType: EmploymentType | "";
  employmentStatus: EmploymentStatus;
  workingDays: WorkingDaysConfig;
};

const WORK_SCHEDULE_DAYS: { key: keyof WorkingDaysConfig; label: string; short: string }[] = [
  { key: "monday", label: "Monday", short: "Mon" },
  { key: "tuesday", label: "Tuesday", short: "Tue" },
  { key: "wednesday", label: "Wednesday", short: "Wed" },
  { key: "thursday", label: "Thursday", short: "Thu" },
  { key: "friday", label: "Friday", short: "Fri" },
  { key: "saturday", label: "Saturday", short: "Sat" },
  { key: "sunday", label: "Sunday", short: "Sun" },
];

function useCanManageTimeOffPolicies(): boolean {
  const { allowedPages, loaded } = useWorkspaceRole();
  if (!loaded) return false;
  if (allowedPages === null) return true;
  return allowedPages.includes("time-off.manage");
}

function MemberAvatar({ member, size = 9 }: { member: Member; size?: number }) {
  const cls = `w-${size} h-${size} rounded-full bg-secondary flex items-center justify-center text-sm font-medium shrink-0 overflow-hidden`;
  return (
    <div className={cls}>
      {member.image_url ? (
        <img
          src={member.image_url}
          alt={member.email}
          className="w-full h-full object-cover"
          referrerPolicy="no-referrer"
        />
      ) : (
        member.email[0]?.toUpperCase() ?? "?"
      )}
    </div>
  );
}

// ── Status badge ──────────────────────────────────────────────────────────────

function StatusBadge({ member }: { member: Member }) {
  if (!member.joined) {
    return (
      <span className="inline-flex items-center gap-1 text-xs bg-amber-500/10 text-amber-700 dark:text-amber-400 px-2 py-0.5 rounded-full border border-amber-200/50">
        <Clock size={10} />
        Pending
      </span>
    );
  }
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border ${EMPLOYMENT_STATUS_BADGE[member.employment_status]}`}
    >
      {EMPLOYMENT_STATUS_LABELS[member.employment_status]}
    </span>
  );
}

// ── Role badge ────────────────────────────────────────────────────────────────

function RoleBadge({ member }: { member: Member }) {
  if (member.role === "owner") {
    return (
      <span className="inline-flex items-center gap-1 text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full">
        <Crown size={10} />
        Owner
      </span>
    );
  }
  const roleNames = member.role_names?.length ? member.role_names : (member.role_name ? [member.role_name] : []);
  if (roleNames.length === 0) {
    return <span className="text-xs text-muted-foreground italic">No role</span>;
  }
  return (
    <>
      {roleNames.map((name) => (
        <span key={name} className="inline-flex items-center text-xs bg-secondary text-foreground px-2 py-0.5 rounded-full">
          {name}
        </span>
      ))}
    </>
  );
}

// ── Invite dialog ─────────────────────────────────────────────────────────────

function InviteDialog({
  open,
  onOpenChange,
  customRoles,
  onInvite,
  isPending,
  defaultEmail,
  defaultFromAccessRequest,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  customRoles: { id: number; name: string }[];
  onInvite: (email: string, roleId: number, isAccessRequest: boolean, mobilePassword?: string) => void;
  isPending: boolean;
  defaultEmail?: string;
  defaultFromAccessRequest?: boolean;
}) {
  const { t } = useTranslation();
  const [email, setEmail] = useState(defaultEmail ?? "");
  const [inviteRoleId, setInviteRoleId] = useState<string>("");
  const [fromAccessRequest, setFromAccessRequest] = useState(defaultFromAccessRequest ?? false);
  const [mobilePassword, setMobilePassword] = useState("");
  const [showMobilePassword, setShowMobilePassword] = useState(false);

  // Sync local state whenever the dialog opens or its defaults change
  useEffect(() => {
    if (open) {
      setEmail(defaultEmail ?? "");
      setFromAccessRequest(defaultFromAccessRequest ?? false);
      setInviteRoleId("");
      setMobilePassword("");
      setShowMobilePassword(false);
    }
  }, [open, defaultEmail, defaultFromAccessRequest]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const em = email.trim();
    if (!em || !inviteRoleId) return;
    const pw = mobilePassword.trim();
    onInvite(em, parseInt(inviteRoleId, 10), fromAccessRequest, pw || undefined);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="dialog-invite">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus size={18} />
            {t("users.inviteSomeone")}
          </DialogTitle>
          <DialogDescription>{t("users.inviteSomeoneDesc")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="invite-email" className="text-sm font-medium">
              Email address
            </Label>
            <Input
              id="invite-email"
              type="email"
              placeholder={t("users.emailPlaceholder")}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              data-testid="input-invite-email"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm font-medium">Role</Label>
            <Select value={inviteRoleId} onValueChange={setInviteRoleId}>
              <SelectTrigger data-testid="select-trigger-invite-role">
                <SelectValue placeholder={t("users.selectRolePlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {customRoles.length === 0 ? (
                  <SelectItem value="__none__" disabled className="text-muted-foreground text-xs">
                    {t("users.noRolesDefined")}
                  </SelectItem>
                ) : (
                  customRoles.map((r) => (
                    <SelectItem key={r.id} value={String(r.id)}>
                      {r.name}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>

          {/* Mobile app password — optional, for Apple/Google review accounts */}
          <div className="space-y-1.5">
            <Label htmlFor="invite-mobile-password" className="text-sm font-medium flex items-center gap-1.5">
              <Smartphone size={14} className="text-muted-foreground" />
              Mobile app password
              <span className="text-muted-foreground font-normal">(optional)</span>
            </Label>
            <div className="relative">
              <Input
                id="invite-mobile-password"
                type={showMobilePassword ? "text" : "password"}
                placeholder="Min. 8 characters"
                value={mobilePassword}
                onChange={(e) => setMobilePassword(e.target.value)}
                autoComplete="new-password"
                className="pr-10"
                data-testid="input-invite-mobile-password"
              />
              <button
                type="button"
                className="absolute inset-y-0 end-0 flex items-center px-3 text-muted-foreground hover:text-foreground"
                onClick={() => setShowMobilePassword((v) => !v)}
                tabIndex={-1}
                aria-label={showMobilePassword ? "Hide password" : "Show password"}
              >
                {showMobilePassword ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              If set, the account is created immediately (no invite email) so the user can sign in to the mobile app right away.
              Required for Apple &amp; Google app review accounts.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Checkbox
              id="from-access-request"
              checked={fromAccessRequest}
              onCheckedChange={(checked) => setFromAccessRequest(checked === true)}
              data-testid="checkbox-from-access-request"
            />
            <Label
              htmlFor="from-access-request"
              className="text-sm text-muted-foreground cursor-pointer select-none flex items-center gap-1.5"
            >
              <CheckCircle2
                size={14}
                className={fromAccessRequest ? "text-green-600" : "text-muted-foreground/50"}
              />
              This is in response to an access request
            </Label>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isPending || !email.trim() || !inviteRoleId || (mobilePassword.length > 0 && mobilePassword.trim().length < 8)}
              data-testid="button-invite"
            >
              {isPending
                ? mobilePassword.trim()
                  ? "Creating account…"
                  : fromAccessRequest
                    ? "Approving…"
                    : t("users.inviting")
                : mobilePassword.trim()
                  ? "Create account"
                  : fromAccessRequest
                    ? "Approve & send invite"
                    : t("users.sendInvite")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Set Mobile Password Dialog ─────────────────────────────────────────────────

function SetMobilePasswordDialog({
  member,
  onClose,
  onSave,
  isPending,
}: {
  member: Member;
  onClose: () => void;
  onSave: (password: string) => void;
  isPending: boolean;
}) {
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const pw = password.trim();
    if (pw.length < 8) return;
    onSave(pw);
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent data-testid="dialog-set-mobile-password">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Smartphone size={18} />
            Set mobile app password
          </DialogTitle>
          <DialogDescription>
            Set a password for <strong>{displayName(member)}</strong> so they can sign in to the
            mobile app with email and password.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="set-mobile-password" className="text-sm font-medium">
              New password
            </Label>
            <div className="relative">
              <Input
                id="set-mobile-password"
                type={showPassword ? "text" : "password"}
                placeholder="Min. 8 characters"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                autoFocus
                className="pr-10"
                data-testid="input-set-mobile-password"
              />
              <button
                type="button"
                className="absolute inset-y-0 end-0 flex items-center px-3 text-muted-foreground hover:text-foreground"
                onClick={() => setShowPassword((v) => !v)}
                tabIndex={-1}
                aria-label={showPassword ? "Hide password" : "Show password"}
              >
                {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
            <p className="text-xs text-muted-foreground">
              The user can use this password to sign in via "Sign in with password" on the mobile app.
              Existing OTP and Google sign-in methods are unaffected.
            </p>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isPending || password.trim().length < 8}
              data-testid="button-set-mobile-password-save"
            >
              {isPending ? "Saving…" : "Set password"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Main page ──

export default function UsersPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const canManageTimeOffPolicies = useCanManageTimeOffPolicies();

  const [showInviteDialog, setShowInviteDialog] = useState(false);
  const [inviteDefaultEmail, setInviteDefaultEmail] = useState<string | undefined>();
  const [inviteDefaultFromAR, setInviteDefaultFromAR] = useState(false);

  const [pendingRemove, setPendingRemove] = useState<Member | null>(null);
  const [pendingManagerChange, setPendingManagerChange] = useState<PendingManagerChange | null>(null);
  const [pendingLocationChange, setPendingLocationChange] = useState<PendingLocationChange | null>(null);
  const [employmentInfoForm, setEmploymentInfoForm] = useState<EmploymentInfoForm | null>(null);
  const [approveRequest, setApproveRequest] = useState<AccessRequest | null>(null);
  const [approveRoleId, setApproveRoleId] = useState<string>("");
  const [pendingPromoteToOwner, setPendingPromoteToOwner] = useState<Member | null>(null);
  const [showAuditLog, setShowAuditLog] = useState(false);

  const [setPasswordFor, setSetPasswordFor] = useState<Member | null>(null);

  // Role picker dialog (for changing a member's role from the dropdown)
  const [rolePickerFor, setRolePickerFor] = useState<Member | null>(null);
  const [rolePickerSelectedIds, setRolePickerSelectedIds] = useState<Set<number>>(new Set());
  const [rolePickerFloristLocationId, setRolePickerFloristLocationId] = useState<string>("");

  // Manager picker dialog
  const [managerPickerFor, setManagerPickerFor] = useState<Member | null>(null);
  const [managerPickerSelectedId, setManagerPickerSelectedId] = useState<string>("");

  // Copy feedback
  const [copiedInviteId, setCopiedInviteId] = useState<number | null>(null);

  // Filters

  const [filterDepartment, setFilterDepartment] = useState<string>("__all__");
  const [filterEmploymentStatus, setFilterEmploymentStatus] = useState<string>("__all__");
  const [filterEmploymentType, setFilterEmploymentType] = useState<string>("__all__");
  const [filterManagerId, setFilterManagerId] = useState<string>("__all__");
  const [sortBy, setSortBy] = useState<
    "default" | "start_date_asc" | "start_date_desc" | "job_title_asc" | "job_title_desc"
  >("default");

  const { data, isLoading } = useQuery({
    queryKey: ["users"],
    queryFn: () => apiFetch<UsersResponse>("/api/users"),
  });

  const { data: rolesData } = useRoles();
  const customRoles = rolesData?.roles ?? [];

  // Permission helpers derived from data response
  const isOwner = data?.me?.role === "owner";
  const { allowedPages } = useWorkspaceRole();
  const canManageUsers = isOwner || (allowedPages?.includes("users") ?? false);
  const can = (key: string): boolean => {
    if (isOwner) return true;
    if (allowedPages === null) return false;
    return allowedPages.includes(key);
  };


  const { data: locationsData } = useQuery({
    queryKey: ["locations"],
    queryFn: () =>
      apiFetch<{ locations: { id: number; name: string; location_type: string }[] }>(
        "/api/locations",
      ),
    enabled: isOwner || (allowedPages?.includes("users.assign-role") ?? false),
  });

  const { data: accessRequestsData } = useQuery({
    queryKey: ["access-requests"],
    queryFn: () => apiFetch<{ requests: AccessRequest[] }>("/api/access-requests"),
    enabled: isOwner,
  });
  const pendingAccessRequests = accessRequestsData?.requests ?? [];

  const approveMutation = useMutation({
    mutationKey: ["approveAccessRequest"],
    mutationFn: ({ id, roleId }: { id: number; roleId: number }) =>
      apiFetch(`/api/access-requests/${id}/approve`, {
        method: "POST",
        body: JSON.stringify({ roleId }),
      }),
    onSuccess: () => {
      setApproveRequest(null);
      setApproveRoleId("");
      queryClient.invalidateQueries({ queryKey: ["access-requests"] });
      queryClient.invalidateQueries({ queryKey: ["users"] });
      toast({
        title: "Request approved",
        description: "The user has been added to the workspace.",
      });
    },
    onError: (e: Error) =>
      toast({
        title: "Could not approve request",
        description: e.message,
        variant: "destructive",
      }),
  });

  const rejectMutation = useMutation({
    mutationKey: ["rejectAccessRequest"],
    mutationFn: (id: number) =>
      apiFetch(`/api/access-requests/${id}/reject`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["access-requests"] });
      toast({ title: "Request rejected" });
    },
    onError: (e: Error) =>
      toast({
        title: "Could not reject request",
        description: e.message,
        variant: "destructive",
      }),
  });

  const inviteMutation = useMutation({
    mutationKey: ["invite"],
    mutationFn: ({
      em,
      roleId,
      isAccessRequest,
      mobilePassword,
    }: {
      em: string;
      roleId: number;
      isAccessRequest: boolean;
      mobilePassword?: string;
    }) =>
      apiFetch<{ member: Member }>("/api/users", {
        method: "POST",
        body: JSON.stringify({
          email: em,
          roleId,
          ...(isAccessRequest ? { fromAccessRequest: true } : {}),
          ...(mobilePassword ? { mobilePassword } : {}),
        }),
      }),
    onSuccess: (_data, vars) => {
      setShowInviteDialog(false);
      setInviteDefaultEmail(undefined);
      setInviteDefaultFromAR(false);

      queryClient.invalidateQueries({ queryKey: ["users"] });
      queryClient.invalidateQueries({ queryKey: ["access-requests"] });
      toast({
        title: vars.mobilePassword ? "Account created" : t("users.invitationAdded"),
        description: vars.mobilePassword
          ? "The account is ready — the user can sign in to the mobile app with their email and password."
          : t("users.invitationAddedDesc"),
      });
    },
    onError: (e: Error) => {
      toast({
        title: t("users.couldNotInvite"),
        description: e.message,
        variant: "destructive",
      });
    },
  });

  const removeMutation = useMutation({
    mutationKey: ["removeUser"],
    mutationFn: (id: number) => apiFetch(`/api/users/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["users"] }),
    onError: (e: Error) =>
      toast({
        title: t("users.couldNotRemove"),
        description: e.message,
        variant: "destructive",
      }),
  });

  const changeRoleMutation = useMutation({
    mutationKey: ["changeRole"],
    mutationFn: ({
      id,
      roleIds,
      floristLocationId,
    }: {
      id: number;
      roleIds: number[];
      floristLocationId?: number | null;
    }) =>
      apiFetch(`/api/users/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          roleIds,
          ...(floristLocationId !== undefined ? { floristLocationId } : {}),
        }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["users"] }),
    onError: (e: Error) =>
      toast({
        title: t("users.couldNotChangeRole"),
        description: e.message,
        variant: "destructive",
      }),
  });

  const changeManagerMutation = useMutation({
    mutationKey: ["changeManager"],
    mutationFn: ({ id, managerMemberId }: { id: number; managerMemberId: number | null }) =>
      apiFetch(`/api/users/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ managerMemberId }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      setManagerPickerFor(null);
    },
    onError: (e: Error) =>
      toast({
        title: "Could not update manager",
        description: e.message,
        variant: "destructive",
      }),
  });

  const changeLocationsMutation = useMutation({
    mutationKey: ["changeLocations"],
    mutationFn: ({ id, locationIds }: { id: number; locationIds: number[] }) =>
      apiFetch(`/api/users/${id}/locations`, {
        method: "PUT",
        body: JSON.stringify({ locationIds }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      setPendingLocationChange(null);
      toast({ title: "Locations updated" });
    },
    onError: (e: Error) => {
      setPendingLocationChange(null);
      toast({
        title: "Could not update locations",
        description: e.message,
        variant: "destructive",
      });
    },
  });

  const employmentInfoMutation = useMutation({
    // Convention: every useMutation in this file declares a mutationKey so that
    // tests can locate callbacks by key rather than by positional index.
    // Adding or reordering mutations will never silently shift test lookups.
    mutationKey: ["employmentInfo"],
    mutationFn: ({ id, payload }: { id: number; payload: Record<string, unknown> }) =>
      apiFetch(`/api/users/${id}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      setEmploymentInfoForm(null);
      toast({ title: "Employment info saved" });
    },
    onError: (e: Error) =>
      toast({
        title: "Could not save employment info",
        description: e.message,
        variant: "destructive",
      }),
  });

  const resendInviteMutation = useMutation({
    mutationKey: ["resendInvite"],
    mutationFn: (id: number) =>
      apiFetch(`/api/users/${id}/resend-invite`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["users"] });
      toast({ title: "Invite resent", description: "A fresh invite link has been emailed." });
    },
    onError: (e: Error) =>
      toast({
        title: "Could not resend invite",
        description: e.message,
        variant: "destructive",
      }),
  });

  const promoteToOwnerMutation = useMutation({
    mutationKey: ["promoteToOwner"],
    mutationFn: (id: number) =>
      apiFetch(`/api/users/${id}/promote-to-owner`, { method: "POST" }),
    onSuccess: () => {
      setPendingPromoteToOwner(null);
      queryClient.invalidateQueries({ queryKey: ["users"] });
      queryClient.invalidateQueries({ queryKey: ["users-role-audit-log"] });
      toast({
        title: t("users.makeOwnerSuccessTitle"),
        description: t("users.makeOwnerSuccessDesc"),
      });
    },
    onError: (e: Error) =>
      toast({
        title: "Could not promote member",
        description: e.message,
        variant: "destructive",
      }),
  });

  const { data: auditLogData } = useQuery({
    queryKey: ["users-role-audit-log"],
    queryFn: () => apiFetch<{ entries: AuditLogEntry[] }>("/api/users/role-audit-log"),
    enabled: isOwner && showAuditLog,
  });

  const { data: failedRequestsData } = useQuery({
    queryKey: ["failed-access-requests"],
    queryFn: () =>
      apiFetch<{ failedRequests: FailedAccessRequest[] }>("/api/users/failed-access-requests"),
    enabled: data?.me?.role === "owner",
  });

  const dismissFailedRequestMutation = useMutation({
    mutationKey: ["dismissFailedRequest"],
    mutationFn: (id: number) =>
      apiFetch(`/api/users/failed-access-requests/${id}`, { method: "DELETE" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["failed-access-requests"] }),
    onError: (e: Error) =>
      toast({ title: "Could not dismiss", description: e.message, variant: "destructive" }),
  });

  const setMobilePasswordMutation = useMutation({
    mutationKey: ["setMobilePassword"],
    mutationFn: ({ id, password }: { id: number; password: string }) =>
      apiFetch(`/api/users/${id}/set-mobile-password`, {
        method: "POST",
        body: JSON.stringify({ password }),
      }),
    onSuccess: () => {
      setSetPasswordFor(null);
      toast({ title: "Mobile password set", description: "The user can now sign in to the mobile app with their password." });
    },
    onError: (e: Error) =>
      toast({ title: "Could not set password", description: e.message, variant: "destructive" }),
  });

  const { data: membersWithPolicy } = useQuery({
    queryKey: ["time-off", "members-with-policy"],
    enabled: canManageTimeOffPolicies,
    queryFn: async () => {
      const policiesResp = await apiFetch<{ policies: { id: number }[] }>(
        "/api/time-off/policies",
      );
      const assigneesLists = await Promise.all(
        policiesResp.policies.map((p) =>
          apiFetch<{ assignees: { member_id: number }[] }>(
            `/api/time-off/policies/${p.id}/assignees`,
          ),
        ),
      );
      const ids = new Set<number>();
      for (const r of assigneesLists) {
        for (const a of r.assignees) ids.add(a.member_id);
      }
      return ids;
    },
  });

  const members = data?.members ?? [];
  const failedRequests = failedRequestsData?.failedRequests ?? [];
  const allLocations = locationsData?.locations ?? [];

  // The florist-location picker is required whenever the role selected in the
  // role-picker dialog grants the Florist Orders page.
  const rolePickerNeedsFloristLocation = useMemo(() => {
    return Array.from(rolePickerSelectedIds).some(
      (id) => customRoles.find((r) => r.id === id)?.allowed_pages?.includes("florist_orders"),
    );
  }, [customRoles, rolePickerSelectedIds]);
  const managerOptions = members;

  // Summary stats
  const totalCount = members.length;
  const activeCount = members.filter((m) => m.joined || m.role === "owner").length;
  const pendingCount = members.filter((m) => !m.joined && m.role !== "owner").length;
  const adminCount = members.filter((m) => m.role === "owner").length;

  const departmentFilterOptions = useMemo(() => {
    const set = new Set<string>();
    for (const m of members) {
      if (m.department) set.add(m.department);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [members]);

  const managerFilterOptions = useMemo(() => {
    const seen = new Set<number>();
    const opts: Member[] = [];
    for (const m of members) {
      if (m.manager_member_id && !seen.has(m.manager_member_id)) {
        seen.add(m.manager_member_id);
        const mgr = members.find((mo) => mo.id === m.manager_member_id);
        if (mgr) opts.push(mgr);
      }
    }
    return opts.sort((a, b) => displayName(a).localeCompare(displayName(b)));
  }, [members]);

  const filteredMembers = useMemo(() => {
    let list = members.filter((m) => {
      if (filterDepartment !== "__all__") {
        if (filterDepartment === "__none__") {
          if (m.department) return false;
        } else if (m.department !== filterDepartment) {
          return false;
        }
      }
      if (
        filterEmploymentStatus !== "__all__" &&
        m.employment_status !== filterEmploymentStatus
      )
        return false;
      if (filterEmploymentType !== "__all__") {
        if (filterEmploymentType === "__none__") {
          if (m.employment_type) return false;
        } else if (m.employment_type !== filterEmploymentType) {
          return false;
        }
      }
      if (filterManagerId !== "__all__") {
        if (filterManagerId === "__none__") {
          if (m.manager_member_id) return false;
        } else if (String(m.manager_member_id ?? "") !== filterManagerId) {
          return false;
        }
      }
      return true;
    });

    if (sortBy !== "default") {
      const sorted = [...list];
      sorted.sort((a, b) => {
        if (sortBy === "start_date_asc" || sortBy === "start_date_desc") {
          const av = a.start_date ?? "";
          const bv = b.start_date ?? "";
          if (!av && !bv) return 0;
          if (!av) return 1;
          if (!bv) return -1;
          return sortBy === "start_date_asc"
            ? av.localeCompare(bv)
            : bv.localeCompare(av);
        }
        const av = (a.job_title ?? "").toLowerCase();
        const bv = (b.job_title ?? "").toLowerCase();
        if (!av && !bv) return 0;
        if (!av) return 1;
        if (!bv) return -1;
        return sortBy === "job_title_asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      });
      list = sorted;
    }
    return list;
  }, [members, filterDepartment, filterEmploymentStatus, filterEmploymentType, filterManagerId, sortBy]);

  const pendingFiltered = filteredMembers.filter((m) => !m.joined && m.role !== "owner");
  const activeFiltered = filteredMembers.filter((m) => m.joined || m.role === "owner");


  const hasActiveFilters =
    filterDepartment !== "__all__" ||
    filterEmploymentStatus !== "__all__" ||
    filterEmploymentType !== "__all__" ||
    filterManagerId !== "__all__" ||
    sortBy !== "default";

  const clearFilters = () => {
    setFilterDepartment("__all__");
    setFilterEmploymentStatus("__all__");
    setFilterEmploymentType("__all__");
    setFilterManagerId("__all__");
    setSortBy("default");
  };

  const handleCopyInviteLink = (m: Member) => {
    if (!m.invite_token) return;
    const url = `${window.location.origin}/join?token=${m.invite_token}`;
    navigator.clipboard
      .writeText(url)
      .then(() => {
        setCopiedInviteId(m.id);
        setTimeout(
          () => setCopiedInviteId((prev) => (prev === m.id ? null : prev)),
          COPY_FEEDBACK_MS,
        );
      })
      .catch(() => {
        toast({
          title: "Could not copy link",
          description: "Please copy it manually.",
          variant: "destructive",
        });
      });
  };

  // ── Pending invite row ──────────────────────────────────────────────────────

  function PendingRow({ m }: { m: Member }) {
    return (
      <li
        className="flex items-center gap-3 px-5 py-3.5"
        data-testid={`member-${m.id}`}
      >
        <div className="w-9 h-9 rounded-full bg-amber-100 dark:bg-amber-900 flex items-center justify-center text-sm font-medium shrink-0 text-amber-800 dark:text-amber-200">
          {m.email[0]?.toUpperCase() ?? "?"}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium truncate">{m.email}</span>
            <RoleBadge member={m} />
            <StatusBadge member={m} />
          </div>
          <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1.5">
            <Mail size={11} />
            Invited {timeAgo(m.invited_at)}
            {m.invited_by_email && <> by {m.invited_by_email}</>}
          </div>
        </div>
        {canManageUsers && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                data-testid={`menu-pending-${m.id}`}
              >
                <MoreHorizontal size={15} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuItem
                onClick={() => resendInviteMutation.mutate(m.id)}
                disabled={resendInviteMutation.isPending}
                data-testid={`button-resend-invite-${m.id}`}
              >
                <RotateCcw size={13} className="mr-2" />
                Resend invite
              </DropdownMenuItem>
              {m.invite_token && (
                <DropdownMenuItem
                  onClick={() => handleCopyInviteLink(m)}
                  data-testid={`button-copy-invite-link-${m.id}`}
                >
                  {copiedInviteId === m.id ? (
                    <Check size={13} className="mr-2 text-green-600" />
                  ) : (
                    <Copy size={13} className="mr-2" />
                  )}
                  Copy invite link
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => setPendingRemove(m)}
                className="text-destructive focus:text-destructive"
                data-testid={`button-revoke-invite-${m.id}`}
              >
                <Ban size={13} className="mr-2" />
                Revoke invite
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </li>
    );
  }

  // ── Active member row ───────────────────────────────────────────────────────

  function ActiveRow({ m }: { m: Member }) {
    const managerMember = m.manager_member_id
      ? members.find((mo) => mo.id === m.manager_member_id)
      : null;

    return (
      <li
        className="flex items-start gap-3 px-5 py-3.5"
        data-testid={`member-${m.id}`}
      >
        <MemberAvatar member={m} size={9} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium">
              {displayName(m) !== m.email ? displayName(m) : m.email}
            </span>
            {displayName(m) !== m.email && (
              <span className="text-xs text-muted-foreground truncate">{m.email}</span>
            )}
            <RoleBadge member={m} />
            <StatusBadge member={m} />
            {canManageTimeOffPolicies &&
              membersWithPolicy &&
              !membersWithPolicy.has(m.id) && (
                <Link
                  href="/admin/time-off/policies"
                  className="inline-flex items-center gap-1 text-xs bg-muted text-muted-foreground hover:bg-amber-500/10 hover:text-amber-700 dark:hover:text-amber-400 px-2 py-0.5 rounded-full border border-transparent hover:border-amber-200 transition-colors"
                  title="No time-off policy assigned — click to assign one"
                  data-testid={`no-time-off-policy-${m.id}`}
                >
                  <CalendarOff size={11} />
                  No time-off policy
                </Link>
              )}
          </div>

          <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-2 flex-wrap">
            <span className="flex items-center gap-1">
              <Mail size={11} />
              Joined {timeAgo(m.joined_at)}
            </span>
            {managerMember && (
              <span
                className="flex items-center gap-1"
                data-testid={`manager-display-${m.id}`}
              >
                · Manager: {displayName(managerMember)}
              </span>
            )}
          </div>

          {(m.job_title || m.department || m.employment_status !== "active") && (
            <div
              className="flex flex-wrap gap-1.5 mt-1"
              data-testid={`employment-display-${m.id}`}
            >
              {m.job_title && (
                <span className="inline-flex items-center gap-1 text-xs bg-secondary text-foreground px-2 py-0.5 rounded-full">
                  <Briefcase size={10} />
                  {m.job_title}
                </span>
              )}
              {m.department && (
                <span className="hidden sm:inline-flex items-center gap-1 text-xs bg-secondary text-foreground px-2 py-0.5 rounded-full">
                  {m.department}
                </span>
              )}
            </div>
          )}

          {m.assigned_locations && m.assigned_locations.length > 0 && (
            <div
              className="flex flex-wrap gap-1 mt-1"
              data-testid={`locations-display-${m.id}`}
            >
              {m.assigned_locations.map((loc) => (
                <Badge key={loc.id} variant="secondary" className="text-xs gap-1 py-0 h-5">
                  <MapPin size={9} />
                  {loc.name}
                </Badge>
              ))}
            </div>
          )}

          {formatWorkSchedule(m.working_days) && (
            <div
              className="flex flex-wrap gap-1 mt-1"
              data-testid={`schedule-display-${m.id}`}
            >
              <span className="inline-flex items-center gap-1 text-xs bg-blue-500/10 text-blue-700 dark:text-blue-400 px-2 py-0.5 rounded-full">
                <CalendarDays size={10} />
                {formatWorkSchedule(m.working_days)}
              </span>
            </div>
          )}
        </div>

        {canManageUsers && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0 mt-0.5"
                data-testid={`menu-active-${m.id}`}
              >
                <MoreHorizontal size={15} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              {m.joined && (
                <>
                  <DropdownMenuItem asChild data-testid={`button-view-profile-${m.id}`}>
                    <Link href={`/users/${m.id}/profile`}>
                      <ExternalLink size={14} className="mr-2" />
                      View profile
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuItem
                onClick={() =>
                  setEmploymentInfoForm({
                    member: m,
                    jobTitle: m.job_title ?? "",
                    startDate: m.start_date ?? "",
                    managerMemberId: m.manager_member_id
                      ? String(m.manager_member_id)
                      : "",
                    department: m.department ?? "",
                    location: m.location ?? "",
                    employmentType: (m.employment_type ?? "full_time") as EmploymentType | "",
                    employmentStatus: m.employment_status ?? "active",
                    workingDays: m.working_days ?? DEFAULT_WORKING_DAYS,
                  })
                }
                data-testid={`button-edit-employment-${m.id}`}
              >
                <Pencil size={14} className="mr-2" />
                Edit info
              </DropdownMenuItem>
              {allLocations.length > 0 && (
                <DropdownMenuItem
                  onClick={() =>
                    setPendingLocationChange({
                      member: m,
                      selectedIds: new Set(m.assigned_locations.map((l) => l.id)),
                    })
                  }
                  data-testid={`button-change-locations-${m.id}`}
                >
                  <MapPin size={14} className="mr-2" />
                  {m.assigned_locations.length > 0
                    ? `${m.assigned_locations.length} location${m.assigned_locations.length > 1 ? "s" : ""}`
                    : "Assign locations"}
                </DropdownMenuItem>
              )}
              {m.role !== "owner" && customRoles.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={() => {
                      setRolePickerFor(m);
                      setRolePickerSelectedIds(new Set(m.custom_role_ids ?? []));
                      setRolePickerFloristLocationId(m.florist_location_id ? String(m.florist_location_id) : "");
                    }}
                    data-testid={`menu-change-role-${m.id}`}
                  >
                    <ShieldCheck size={14} className="mr-2" />
                    Change roles
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {managerOptions
                    .filter((mo) => mo.id !== m.id)
                    .slice(0, 5)
                    .map((mo) => (
                      <DropdownMenuItem
                        key={mo.id}
                        onClick={() =>
                          setPendingManagerChange({
                            member: m,
                            newManagerId: mo.id,
                            newManagerEmail: mo.email,
                          })
                        }
                        data-testid={`menu-manager-${m.id}-${mo.id}`}
                      >
                        <UserCheck size={14} className="mr-2" />
                        Manager: {displayName(mo)}
                      </DropdownMenuItem>
                    ))}
                  {m.manager_member_id && (
                    <DropdownMenuItem
                      onClick={() =>
                        setPendingManagerChange({
                          member: m,
                          newManagerId: null,
                          newManagerEmail: null,
                        })
                      }
                      data-testid={`menu-remove-manager-${m.id}`}
                    >
                      <X size={14} className="mr-2" />
                      Remove manager
                    </DropdownMenuItem>
                  )}
                </>
              )}
              {m.role !== "owner" && (
                <>
                  <DropdownMenuSeparator />
                  {m.joined && isOwner && (
                    <DropdownMenuItem
                      onClick={() => setSetPasswordFor(m)}
                      data-testid={`button-set-mobile-password-${m.id}`}
                    >
                      <Smartphone size={14} className="mr-2" />
                      Set mobile password
                    </DropdownMenuItem>
                  )}
                  {m.joined && (
                    <DropdownMenuItem
                      onClick={() => setPendingPromoteToOwner(m)}
                      data-testid={`button-promote-owner-${m.id}`}
                    >
                      <Crown size={14} className="mr-2 text-amber-600" />
                      Make owner
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onClick={() => setPendingRemove(m)}
                    data-testid={`button-remove-${m.id}`}
                  >
                    <Trash2 size={14} className="mr-2" />
                    Remove user
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </li>
    );
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t("users.title")}</h1>
          <p className="text-muted-foreground mt-2">{t("users.description")}</p>

        </div>
        <div className="flex items-center gap-2 shrink-0">
          <StaleDataBadge
            queries={[{ queryKey: ["users"], url: "/api/users" }]}
            data-testid="users-stale-badge"
          />
          {canManageUsers && (
            <Button asChild variant="outline" size="sm" className="gap-2">
              <Link href="/roles">
                <ShieldCheck size={15} />
                {t("users.manageRoles")}
              </Link>
            </Button>
          )}
          {can("users.invite") && (
            <Button
              size="sm"
              className="gap-2"
              onClick={() => setShowInviteDialog(true)}
              data-testid="button-invite-member"
            >
              <UserPlus size={15} />
              {t("users.inviteMember")}

            </Button>
          )}
        </div>
      </div>

      {/* Summary stat cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="text-xs">{t("users.totalMembers")}</CardDescription>
            <CardTitle className="text-2xl">{isLoading ? "—" : totalCount}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="text-xs">{t("users.activeMembers")}</CardDescription>
            <CardTitle className="text-2xl">{isLoading ? "—" : activeCount}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="text-xs">{t("users.pendingInvites")}</CardDescription>
            <CardTitle className="text-2xl">{isLoading ? "—" : pendingCount}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription className="text-xs">{t("users.admins")}</CardDescription>
            <CardTitle className="text-2xl">{isLoading ? "—" : adminCount}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      {/* Filter bar */}
      {!isLoading && members.length > 0 && (
        <Card>
          <CardContent className="pt-4 pb-4">
            <div className="flex flex-wrap items-center gap-2" data-testid="users-filters">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Filter size={13} />
                <span className="hidden sm:inline">Filter:</span>
              </div>
              <Select value={filterDepartment} onValueChange={setFilterDepartment}>
                <SelectTrigger className="h-8 w-auto min-w-[10rem] text-xs" data-testid="filter-department">
                  <SelectValue placeholder="Department" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__" className="text-xs">{t("users.allDepartments")}</SelectItem>
                  <SelectItem value="__none__" className="text-xs">{t("users.noDepartment")}</SelectItem>
                  {departmentFilterOptions.map((d) => (
                    <SelectItem key={d} value={d} className="text-xs">{d}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={filterEmploymentStatus} onValueChange={setFilterEmploymentStatus}>
                <SelectTrigger className="h-8 w-auto min-w-[9rem] text-xs" data-testid="filter-employment-status">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__" className="text-xs">{t("users.allStatuses")}</SelectItem>
                  {(Object.keys(EMPLOYMENT_STATUS_LABELS) as EmploymentStatus[]).map((k) => (
                    <SelectItem key={k} value={k} className="text-xs">{EMPLOYMENT_STATUS_LABELS[k]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={filterEmploymentType} onValueChange={setFilterEmploymentType}>
                <SelectTrigger className="h-8 w-auto min-w-[9rem] text-xs" data-testid="filter-employment-type">
                  <SelectValue placeholder="Type" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__" className="text-xs">{t("users.allTypes")}</SelectItem>
                  <SelectItem value="__none__" className="text-xs">{t("users.noType")}</SelectItem>
                  {(Object.keys(EMPLOYMENT_TYPE_LABELS) as EmploymentType[]).map((k) => (
                    <SelectItem key={k} value={k} className="text-xs">{EMPLOYMENT_TYPE_LABELS[k]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={filterManagerId} onValueChange={setFilterManagerId}>
                <SelectTrigger className="h-8 w-auto min-w-[10rem] text-xs" data-testid="filter-manager">
                  <SelectValue placeholder="Manager" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__" className="text-xs">{t("users.allManagers")}</SelectItem>
                  <SelectItem value="__none__" className="text-xs">{t("users.noManager")}</SelectItem>
                  {managerFilterOptions.map((mgr) => (
                    <SelectItem key={mgr.id} value={String(mgr.id)} className="text-xs">
                      {displayName(mgr)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground ml-1">
                <ArrowUpDown size={13} />
                <span className="hidden sm:inline">Sort:</span>
              </div>
              <Select value={sortBy} onValueChange={(v) => setSortBy(v as typeof sortBy)}>
                <SelectTrigger className="h-8 w-auto min-w-[11rem] text-xs" data-testid="sort-by">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default" className="text-xs">{t("users.defaultOrder")}</SelectItem>
                  <SelectItem value="start_date_asc" className="text-xs">Start date (oldest first)</SelectItem>
                  <SelectItem value="start_date_desc" className="text-xs">Start date (newest first)</SelectItem>
                  <SelectItem value="job_title_asc" className="text-xs">Job title (A–Z)</SelectItem>
                  <SelectItem value="job_title_desc" className="text-xs">Job title (Z–A)</SelectItem>
                </SelectContent>
              </Select>
              {hasActiveFilters && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 text-xs gap-1"
                  onClick={clearFilters}
                  data-testid="button-clear-filters"
                >
                  <X size={13} />
                  {t("users.clearFilters")}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Access requests (owner-only) */}

      {isOwner && pendingAccessRequests.length > 0 && (
        <Card className="border-amber-200 dark:border-amber-800">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg">
              <UserCheck size={18} className="text-amber-600 dark:text-amber-400" />
              Access Requests
              <span className="ml-1 inline-flex items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900 text-amber-800 dark:text-amber-200 text-xs font-semibold px-2 py-0.5">
                {pendingAccessRequests.length}
              </span>
            </CardTitle>
            <CardDescription>
              These users signed in but don't have workspace access yet. Assign a role and
              approve to add them.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y">
              {pendingAccessRequests.map((ar) => (
                <li key={ar.id} className="flex items-center gap-4 px-6 py-4" data-testid={`access-request-${ar.id}`}>
                  <div className="w-10 h-10 rounded-full bg-amber-100 dark:bg-amber-900 flex items-center justify-center text-sm font-medium shrink-0 text-amber-800 dark:text-amber-200">
                    {ar.requester_email[0]?.toUpperCase() ?? "?"}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium truncate">{ar.requester_email}</span>
                      {ar.requester_name && ar.requester_name !== ar.requester_email && (
                        <span className="text-xs text-muted-foreground">
                          ({ar.requester_name})
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1.5">
                      <Clock size={11} />
                      Requested {timeAgo(ar.requested_at)}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => rejectMutation.mutate(ar.id)}
                      disabled={rejectMutation.isPending}
                      data-testid={`button-reject-request-${ar.id}`}
                      title="Reject request"
                    >
                      <X size={16} className="text-destructive" />
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => {
                        setApproveRequest(ar);
                        setApproveRoleId("");
                        setInviteDefaultEmail(ar.requester_email);
                        setInviteDefaultFromAR(true);
                        setShowInviteDialog(true);
                      }}
                      data-testid={`button-approve-request-${ar.id}`}
                    >
                      Approve
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Failed access requests (owner-only) */}

      {isOwner && failedRequests.length > 0 && (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg text-destructive">
              <AlertTriangle size={18} />
              Failed Access Requests
            </CardTitle>
            <CardDescription>
              These access request emails failed to deliver. The requester may need to be
              invited manually.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            <ul className="divide-y">
              {failedRequests.map((r) => (
                <li
                  key={r.id}
                  className="flex items-start gap-4 px-6 py-4"
                  data-testid={`failed-request-${r.id}`}
                >
                  <div className="w-10 h-10 rounded-full bg-destructive/10 flex items-center justify-center text-sm font-medium shrink-0 text-destructive">
                    {r.requester_email[0]?.toUpperCase() ?? "?"}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-medium truncate">{r.requester_email}</div>
                    {r.requester_name && r.requester_name !== r.requester_email && (
                      <div className="text-sm text-muted-foreground">{r.requester_name}</div>
                    )}
                    <div className="text-xs text-muted-foreground mt-0.5">
                      Email failed {timeAgo(r.created_at)}
                      {r.error_message && (
                        <>
                          {" "}
                          &mdash;{" "}
                          <span className="text-destructive/80">{r.error_message}</span>
                        </>
                      )}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => dismissFailedRequestMutation.mutate(r.id)}
                    disabled={dismissFailedRequestMutation.isPending}
                    data-testid={`button-dismiss-failed-${r.id}`}
                    title="Dismiss"
                  >
                    <X size={16} />
                  </Button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* Pending invites section */}
      {(isLoading || pendingFiltered.length > 0 || (members.some((m) => !m.joined && m.role !== "owner"))) && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Clock size={16} className="text-amber-600" />
              {t("users.pendingInvitesSection", { count: members.filter((m) => !m.joined && m.role !== "owner").length })}
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="py-8 text-center text-muted-foreground text-sm">{t("common.loading")}</div>
            ) : pendingFiltered.length === 0 ? (
              <div className="py-8 text-center text-muted-foreground text-sm px-6">
                {hasActiveFilters ? "No pending invites match the current filters." : t("users.noPendingInvites")}
              </div>
            ) : (
              <ul className="divide-y">
                {pendingFiltered.map((m) => (
                  <li key={m.id} className="flex items-center gap-4 px-6 py-4" data-testid={`member-${m.id}`}>
                    <MemberAvatar member={m} size={10} />

                    {/* Info */}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium truncate text-sm">{m.email}</span>
                        {(m.role_names ?? (m.role_name ? [m.role_name] : [])).map((name) => (
                          <span key={name} className="inline-flex items-center text-xs bg-secondary text-foreground px-2 py-0.5 rounded-full">
                            {name}
                          </span>
                        ))}
                        <span className="inline-flex items-center gap-1 text-xs bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-400 px-2 py-0.5 rounded-full border border-amber-200 dark:border-amber-800">
                          <Clock size={10} />
                          {t("common.pending")}
                        </span>
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1.5">
                        <Mail size={11} />
                        Invited {timeAgo(m.invited_at)}
                        {m.invited_by_email && <> by {m.invited_by_email}</>}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5" data-testid={`manager-display-${m.id}`}>
                        Manager: {m.manager_member_id
                          ? displayName(members.find((mo) => mo.id === m.manager_member_id) ?? { email: m.manager_email ?? "—" })
                          : "—"}
                      </div>
                    </div>

                    {/* Actions */}
                    <div className="flex items-center gap-2 shrink-0">
                      {can("users.resend-invite") && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 text-xs gap-1.5"
                          onClick={() => resendInviteMutation.mutate(m.id)}
                          disabled={resendInviteMutation.isPending}
                          data-testid={`button-resend-invite-${m.id}`}
                        >
                          <RotateCcw size={13} />
                          {t("users.resendInvite")}
                        </Button>
                      )}
                      {can("users.revoke-invite") && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 text-xs gap-1.5 text-destructive hover:text-destructive"
                          onClick={() => setPendingRemove(m)}
                          data-testid={`button-revoke-invite-${m.id}`}
                        >
                          <Ban size={13} />
                          {t("users.revoke")}
                        </Button>
                      )}
                      {can("users.copy-invite-link") && m.invite_token && (
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-8 w-8 p-0"
                              data-testid={`button-invite-menu-${m.id}`}
                              title="More actions"
                            >
                              <MoreHorizontal size={15} />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-52">
                            <DropdownMenuItem
                              onClick={() => handleCopyInviteLink(m)}
                              data-testid={`button-copy-invite-link-${m.id}`}
                            >
                              {copiedInviteId === m.id ? (
                                <Check size={14} className="mr-2 text-green-600" />
                              ) : (
                                <Copy size={14} className="mr-2" />
                              )}
                              {copiedInviteId === m.id ? "Copied!" : t("users.copyInviteLink")}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      {/* Active members section */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Users size={16} />
            {t("users.activeMembersSection", { count: members.filter((m) => m.joined || m.role === "owner").length })}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="py-12 text-center text-muted-foreground">{t("common.loading")}</div>
          ) : activeFiltered.length === 0 ? (
            <div className="py-12 text-center text-muted-foreground" data-testid="users-empty-active">
              {hasActiveFilters ? (
                <>
                  <Filter size={28} className="mx-auto mb-3" />
                  <p>No members match the current filters.</p>
                  <Button variant="link" size="sm" onClick={clearFilters} data-testid="button-clear-filters-empty">
                    Clear filters
                  </Button>
                </>
              ) : (
                <>
                  <Users size={32} className="mx-auto mb-3" />
                  <p>{t("users.noActiveMembers")}</p>
                </>
              )}
            </div>
          ) : (
            <ul className="divide-y">
              {activeFiltered.map((m) => (
                <li key={m.id} className="flex items-center gap-4 px-6 py-4" data-testid={`member-${m.id}`}>
                  <MemberAvatar member={m} />

                  {/* Info */}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium truncate text-sm">{displayName(m)}</span>
                      {m.email !== displayName(m) && (
                        <span className="text-xs text-muted-foreground truncate">{m.email}</span>
                      )}
                      {m.role === "owner" ? (
                        <span className="inline-flex items-center gap-1 text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full">
                          <Crown size={11} />
                          {t("common.owner")}
                        </span>
                      ) : m.role_name ? (
                        <span className="inline-flex items-center gap-1 text-xs bg-secondary text-foreground px-2 py-0.5 rounded-full">
                          {m.role_name}
                        </span>
                      ) : null}
                      <span className="inline-flex items-center gap-1 text-xs bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 px-2 py-0.5 rounded-full border border-emerald-200 dark:border-emerald-800">
                        {t("users.active")}
                      </span>
                      {canManageTimeOffPolicies && m.joined && membersWithPolicy && !membersWithPolicy.has(m.id) && (
                        <Link
                          href="/admin/time-off/policies"
                          className="inline-flex items-center gap-1 text-xs bg-muted text-muted-foreground hover:bg-amber-500/10 hover:text-amber-700 dark:hover:text-amber-400 px-2 py-0.5 rounded-full border border-transparent hover:border-amber-200 transition-colors"
                          title="No time-off policy assigned — click to assign one"
                          data-testid={`no-time-off-policy-${m.id}`}
                        >
                          <CalendarOff size={11} />
                          No time-off policy
                        </Link>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1.5">
                      <Mail size={11} />
                      Joined {timeAgo(m.joined_at)}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5" data-testid={`manager-display-${m.id}`}>
                      Manager: {m.manager_member_id
                        ? displayName(members.find((mo) => mo.id === m.manager_member_id) ?? { email: m.manager_email ?? "—" })
                        : "—"}
                    </div>
                    {(m.job_title || m.department || m.employment_status !== "active") && (
                      <div className="flex flex-wrap gap-1.5 mt-1" data-testid={`employment-display-${m.id}`}>
                        {m.job_title && (
                          <span className="inline-flex items-center gap-1 text-xs bg-secondary text-foreground px-2 py-0.5 rounded-full">
                            <Briefcase size={10} />
                            {m.job_title}
                          </span>
                        )}
                        {m.department && (
                          <span className="hidden sm:inline-flex items-center gap-1 text-xs bg-secondary text-foreground px-2 py-0.5 rounded-full">
                            {m.department}
                          </span>
                        )}
                        <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border ${EMPLOYMENT_STATUS_BADGE[m.employment_status]}`}>
                          {EMPLOYMENT_STATUS_LABELS[m.employment_status]}
                        </span>
                      </div>
                    )}
                    {m.assigned_locations && m.assigned_locations.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1" data-testid={`locations-display-${m.id}`}>
                        {m.assigned_locations.map((loc) => (
                          <Badge key={loc.id} variant="secondary" className="text-xs gap-1 py-0 h-5">
                            <MapPin size={9} />
                            {loc.name}
                          </Badge>
                        ))}
                      </div>
                    )}
                    {formatWorkSchedule(m.working_days) && (
                      <div className="flex flex-wrap gap-1 mt-1" data-testid={`schedule-display-${m.id}`}>
                        <span className="inline-flex items-center gap-1 text-xs bg-blue-500/10 text-blue-700 dark:text-blue-400 px-2 py-0.5 rounded-full">
                          <CalendarDays size={10} />
                          {formatWorkSchedule(m.working_days)}
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2 shrink-0">
                    {can("users.edit") && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 text-xs gap-1.5"
                        onClick={() =>
                          setEmploymentInfoForm({
                            member: m,
                            jobTitle: m.job_title ?? "",
                            startDate: m.start_date ?? "",
                            managerMemberId: m.manager_member_id ? String(m.manager_member_id) : "",
                            department: m.department ?? "",
                            location: m.location ?? "",
                            employmentType: (m.employment_type ?? "full_time") as EmploymentType | "",
                            employmentStatus: m.employment_status ?? "active",
                            workingDays: m.working_days ?? DEFAULT_WORKING_DAYS,
                          })
                        }
                        data-testid={`button-edit-employment-${m.id}`}
                        title="Edit employment information"
                      >
                        <Pencil size={13} />
                        {t("users.edit")}
                      </Button>
                    )}
                    {m.role !== "owner" && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 w-8 p-0"
                            data-testid={`button-member-menu-${m.id}`}
                          >
                            <MoreHorizontal size={15} />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-48">
                          {isOwner && allLocations.length > 0 && (
                            <DropdownMenuItem
                              onClick={() =>
                                setPendingLocationChange({
                                  member: m,
                                  selectedIds: new Set(m.assigned_locations.map((l) => l.id)),
                                })
                              }
                              data-testid={`button-change-locations-${m.id}`}
                            >
                              <MapPin size={14} className="mr-2" />
                              {t("users.assignLocations")}
                            </DropdownMenuItem>
                          )}
                          {can("users.assign-role") && (
                            <DropdownMenuItem
                              onClick={() => {
                                setRolePickerFor(m);
                                setRolePickerSelectedIds(new Set(m.custom_role_ids ?? []));
                                setRolePickerFloristLocationId(
                                  m.florist_location_id ? String(m.florist_location_id) : "",
                                );
                              }}
                              data-testid={`button-change-role-${m.id}`}
                            >
                              <ShieldCheck size={14} className="mr-2" />
                              {t("users.changeRoleAction")}
                            </DropdownMenuItem>
                          )}
                          {can("users.edit") && (
                            <DropdownMenuItem
                              onClick={() => {
                                setManagerPickerFor(m);
                                setManagerPickerSelectedId(m.manager_member_id ? String(m.manager_member_id) : "__none__");
                              }}
                              data-testid={`button-change-manager-${m.id}`}
                            >
                              <UserCheck size={14} className="mr-2" />
                              {t("users.changeManager")}
                            </DropdownMenuItem>
                          )}
                          {(can("users.remove") || can("users.make-owner")) && (
                            <DropdownMenuSeparator />
                          )}
                          {can("users.make-owner") && m.joined && (
                            <DropdownMenuItem
                              onClick={() => setPendingPromoteToOwner(m)}
                              data-testid={`button-promote-owner-${m.id}`}
                              className="text-amber-700 focus:text-amber-700 dark:text-amber-400"
                            >
                              <Crown size={14} className="mr-2" />
                              {t("users.makeOwner")}
                            </DropdownMenuItem>
                          )}
                          {can("users.remove") && (
                            <DropdownMenuItem
                              onClick={() => setPendingRemove(m)}
                              data-testid={`button-remove-${m.id}`}
                              className="text-destructive focus:text-destructive"
                            >
                              <Trash2 size={14} className="mr-2" />
                              {t("users.removeUser")}
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Audit log (owner-only) */}

      {isOwner && (
        <Card>
          <CardHeader
            className="cursor-pointer"
            onClick={() => setShowAuditLog((v) => !v)}
          >
            <CardTitle className="text-base flex items-center gap-2">
              <ShieldCheck size={16} />
              Role change audit log
              <span className="ml-auto text-xs text-muted-foreground font-normal">
                {showAuditLog ? "Hide" : "Show"}
              </span>
            </CardTitle>
            <CardDescription>
              A record of all role and ownership changes in this workspace.
            </CardDescription>
          </CardHeader>
          {showAuditLog && (
            <CardContent>
              {!auditLogData ? (
                <p className="text-sm text-muted-foreground">Loading…</p>
              ) : auditLogData.entries.length === 0 ? (
                <p className="text-sm text-muted-foreground">No role changes recorded yet.</p>
              ) : (
                <ul className="space-y-2">
                  {auditLogData.entries.map((entry) => (
                    <li
                      key={entry.id}
                      className="text-sm flex items-start gap-2 py-1.5 border-b last:border-0"
                    >
                      <div className="flex-1 min-w-0">
                        <span className="font-medium">
                          {entry.target_email ?? `Member #${entry.target_member_id}`}
                        </span>{" "}
                        {entry.new_role === "owner" ? (
                          <span className="text-amber-700">promoted to owner</span>
                        ) : (
                          <>
                            role changed from{" "}
                            <span className="font-medium">
                              {entry.old_role_name ?? entry.old_role ?? "none"}
                            </span>{" "}
                            to{" "}
                            <span className="font-medium">
                              {entry.new_role_name ?? entry.new_role ?? "none"}
                            </span>
                          </>
                        )}
                      </div>
                      <span className="text-xs text-muted-foreground shrink-0">
                        {timeAgo(entry.changed_at)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          )}
        </Card>
      )}

      {/* ── Dialogs ────────────────────────────────────────────────────────── */}

      {/* Invite member dialog */}
      <InviteDialog
        open={showInviteDialog}
        onOpenChange={setShowInviteDialog}
        customRoles={customRoles}
        onInvite={(email, roleId, isAccessRequest, mobilePassword) =>
          inviteMutation.mutate({ em: email, roleId, isAccessRequest, mobilePassword })
        }
        isPending={inviteMutation.isPending}
        defaultEmail={inviteDefaultEmail}
        defaultFromAccessRequest={inviteDefaultFromAR}
      />

      {/* Confirm remove / revoke */}

      <Dialog
        open={pendingRemove !== null}
        onOpenChange={(open) => {
          if (!open) setPendingRemove(null);
        }}
      >
        <DialogContent data-testid="dialog-confirm-remove">
          <DialogHeader>
            <DialogTitle>
              {pendingRemove?.joined ? t("users.removeMember") : t("users.cancelInvitation")}
            </DialogTitle>
            <DialogDescription>
              {pendingRemove &&
                (pendingRemove.joined ? (
                  <>{t("users.removeConfirmDesc", { email: pendingRemove.email })}</>
                ) : (
                  <>{t("users.cancelInviteDesc", { email: pendingRemove.email })}</>
                ))}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingRemove(null)} data-testid="button-cancel-remove">
              {t("common.cancel")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (pendingRemove) {
                  removeMutation.mutate(pendingRemove.id, {
                    onSettled: () => setPendingRemove(null),
                  });
                }
              }}
              disabled={removeMutation.isPending}
              data-testid="button-confirm-remove"
            >
              {removeMutation.isPending
                ? pendingRemove?.joined
                  ? t("users.removing")
                  : t("users.cancelling")
                : pendingRemove?.joined
                  ? t("common.remove")
                  : t("users.cancelInvite")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Role picker dialog (multi-select checkboxes) */}
      <Dialog
        open={rolePickerFor !== null}
        onOpenChange={(open) => { if (!open) { setRolePickerFor(null); setRolePickerSelectedIds(new Set()); setRolePickerFloristLocationId(""); } }}
      >
        <DialogContent data-testid="dialog-role-picker">
          <DialogHeader>
            <DialogTitle>{t("users.changeRoleAction")}</DialogTitle>
            <DialogDescription>
              {rolePickerFor && <>Select roles for <strong>{rolePickerFor.email}</strong>. You can pick more than one.</>}
            </DialogDescription>
          </DialogHeader>
          <div className="py-2 space-y-3">
            <div className="space-y-1 max-h-60 overflow-y-auto border rounded-md p-2">
              {customRoles.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-2">No custom roles defined.</p>
              ) : (
                customRoles.map((r) => {
                  const checked = rolePickerSelectedIds.has(r.id);
                  return (
                    <div
                      key={r.id}
                      className="flex items-center gap-2 px-1 py-1.5 rounded hover:bg-secondary/50 cursor-pointer"
                      onClick={() =>
                        setRolePickerSelectedIds((prev) => {
                          const next = new Set(prev);
                          if (checked) next.delete(r.id); else next.add(r.id);
                          return next;
                        })
                      }
                    >
                      <Checkbox
                        id={`role-picker-${r.id}`}
                        checked={checked}
                        onCheckedChange={(v) =>
                          setRolePickerSelectedIds((prev) => {
                            const next = new Set(prev);
                            if (v) next.add(r.id); else next.delete(r.id);
                            return next;
                          })
                        }
                        data-testid={`checkbox-role-picker-${r.id}`}
                      />
                      <Label htmlFor={`role-picker-${r.id}`} className="cursor-pointer font-normal flex-1" onClick={(e) => e.stopPropagation()}>
                        {r.name}
                      </Label>
                    </div>
                  );
                })
              )}
            </div>
            {rolePickerNeedsFloristLocation && (
              <div className="space-y-1.5">
                <p className="text-sm font-medium">{t("users.floristLocation")}</p>
                <Select
                  value={rolePickerFloristLocationId}
                  onValueChange={setRolePickerFloristLocationId}
                  data-testid="select-florist-location"
                >
                  <SelectTrigger className="w-full" data-testid="select-trigger-florist-location">
                    <SelectValue placeholder={t("users.floristLocationPlaceholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    {allLocations.map((loc) => (
                      <SelectItem key={loc.id} value={String(loc.id)}>{loc.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{t("users.floristLocationHelp")}</p>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setRolePickerFor(null); setRolePickerSelectedIds(new Set()); setRolePickerFloristLocationId(""); }}>
              {t("common.cancel")}
            </Button>
            <Button
              disabled={
                changeRoleMutation.isPending ||
                (rolePickerNeedsFloristLocation && !rolePickerFloristLocationId)
              }
              onClick={() => {
                if (rolePickerFor) {
                  changeRoleMutation.mutate(
                    {
                      id: rolePickerFor.id,
                      roleIds: Array.from(rolePickerSelectedIds),
                      floristLocationId: rolePickerNeedsFloristLocation
                        ? parseInt(rolePickerFloristLocationId, 10)
                        : undefined,
                    },
                    { onSettled: () => { setRolePickerFor(null); setRolePickerSelectedIds(new Set()); setRolePickerFloristLocationId(""); } },
                  );
                }
              }}
              data-testid="button-confirm-role-picker"
            >
              {changeRoleMutation.isPending ? t("common.saving") : t("common.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Manager picker dialog */}
      <Dialog
        open={managerPickerFor !== null}
        onOpenChange={(open) => { if (!open) { setManagerPickerFor(null); setManagerPickerSelectedId(""); } }}
      >
        <DialogContent data-testid="dialog-manager-picker">
          <DialogHeader>
            <DialogTitle>{t("users.changeManager")}</DialogTitle>
            <DialogDescription>
              {managerPickerFor && <>Select a manager for <strong>{displayName(managerPickerFor)}</strong>.</>}
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Select value={managerPickerSelectedId} onValueChange={setManagerPickerSelectedId} data-testid="select-manager-picker">
              <SelectTrigger className="w-full">
                <SelectValue placeholder="No manager" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">No manager</SelectItem>
                {managerOptions
                  .filter((mo) => mo.id !== managerPickerFor?.id)
                  .map((mo) => (
                    <SelectItem key={mo.id} value={String(mo.id)}>{displayName(mo)}</SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => { setManagerPickerFor(null); setManagerPickerSelectedId(""); }}
              data-testid="button-cancel-manager-change"
            >
              {t("common.cancel")}
            </Button>
            <Button
              disabled={changeManagerMutation.isPending}
              onClick={() => {
                if (managerPickerFor) {
                  const newManagerId = managerPickerSelectedId === "__none__" ? null : parseInt(managerPickerSelectedId, 10);
                  changeManagerMutation.mutate({ id: managerPickerFor.id, managerMemberId: newManagerId });
                }
              }}
              data-testid="button-confirm-manager-change"
            >
              {changeManagerMutation.isPending ? t("common.saving") : t("common.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Change locations dialog */}
      <Dialog
        open={pendingLocationChange !== null}
        onOpenChange={(open) => {
          if (!open) setPendingLocationChange(null);
        }}
      >
        <DialogContent data-testid="dialog-change-locations">
          <DialogHeader>
            <DialogTitle>Change locations</DialogTitle>
            <DialogDescription>
              {pendingLocationChange && (
                <>
                  Select the locations{" "}
                  <strong>{pendingLocationChange.member.email}</strong> can access. Leave all
                  unchecked to grant access to all locations.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2 max-h-72 overflow-y-auto">
            {allLocations.map((loc) => {
              const checked = pendingLocationChange?.selectedIds.has(loc.id) ?? false;
              return (
                <div
                  key={loc.id}
                  className="flex items-center gap-3 px-1 py-1.5 rounded hover:bg-secondary/50"
                >
                  <Checkbox
                    id={`loc-${loc.id}`}
                    checked={checked}
                    onCheckedChange={(v) => {
                      if (!pendingLocationChange) return;
                      const next = new Set(pendingLocationChange.selectedIds);
                      if (v) next.add(loc.id);
                      else next.delete(loc.id);
                      setPendingLocationChange({ ...pendingLocationChange, selectedIds: next });
                    }}
                    data-testid={`checkbox-location-${loc.id}`}
                  />
                  <Label
                    htmlFor={`loc-${loc.id}`}
                    className="flex items-center gap-2 cursor-pointer font-normal"
                  >
                    <MapPin size={13} className="text-muted-foreground" />
                    {loc.name}
                    <span className="text-xs text-muted-foreground">
                      ({loc.location_type})
                    </span>
                  </Label>
                </div>
              );
            })}
            {allLocations.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-4">
                No locations defined yet.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingLocationChange(null)} data-testid="button-cancel-location-change">
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (pendingLocationChange) {
                  changeLocationsMutation.mutate({
                    id: pendingLocationChange.member.id,
                    locationIds: Array.from(pendingLocationChange.selectedIds),
                  });
                }
              }}
              disabled={changeLocationsMutation.isPending}
              data-testid="button-confirm-location-change"
            >
              {changeLocationsMutation.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Promote to owner dialog */}
      <Dialog
        open={pendingPromoteToOwner !== null}
        onOpenChange={(open) => {
          if (!open) setPendingPromoteToOwner(null);
        }}
      >
        <DialogContent data-testid="dialog-promote-to-owner">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Crown size={18} className="text-amber-600" />
              {t("users.makeOwnerDialogTitle")}
            </DialogTitle>
            <DialogDescription>
              {pendingPromoteToOwner && (
                <>{t("users.makeOwnerDialogBody", { email: pendingPromoteToOwner.email })}</>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingPromoteToOwner(null)} data-testid="button-cancel-promote-owner">
              {t("common.cancel")}
            </Button>
            <Button
              onClick={() => {
                if (pendingPromoteToOwner) {
                  promoteToOwnerMutation.mutate(pendingPromoteToOwner.id);
                }
              }}
              disabled={promoteToOwnerMutation.isPending}
              data-testid="button-confirm-promote"
              className="bg-amber-600 hover:bg-amber-700 text-white"
            >
              {promoteToOwnerMutation.isPending
                ? t("users.makeOwnerConfirming")
                : t("users.makeOwnerConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Employment info dialog */}
      {employmentInfoForm && (
        <Dialog open onOpenChange={(open) => { if (!open) setEmploymentInfoForm(null); }}>
          <DialogContent className="max-w-lg" data-testid="dialog-employment-info">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Briefcase size={18} />
                Edit employment info
              </DialogTitle>
              <DialogDescription>
                Update employment details for{" "}
                <strong>{employmentInfoForm.member.email}</strong>.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3 py-2">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-sm">Job title</Label>
                  <Input
                    placeholder="e.g. Designer"
                    value={employmentInfoForm.jobTitle}
                    onChange={(e) =>
                      setEmploymentInfoForm((f) => f && { ...f, jobTitle: e.target.value })
                    }
                    maxLength={200}
                    data-testid="input-job-title"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-sm">Start date</Label>
                  <Input
                    type="date"
                    value={employmentInfoForm.startDate}
                    onChange={(e) =>
                      setEmploymentInfoForm((f) => f && { ...f, startDate: e.target.value })
                    }
                    data-testid="input-start-date"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm">Department</Label>
                <Select
                  value={employmentInfoForm.department || "__none__"}
                  onValueChange={(v) =>
                    setEmploymentInfoForm((f) =>
                      f && { ...f, department: v === "__none__" ? "" : v },
                    )
                  }
                >
                  <SelectTrigger data-testid="select-department">
                    <SelectValue placeholder="No department" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">No department</SelectItem>
                    {DEPARTMENT_OPTIONS.map((d) => (
                      <SelectItem key={d} value={d}>
                        {d}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-sm">Employment type</Label>
                  <Select
                    value={employmentInfoForm.employmentType || "full_time"}
                    onValueChange={(v) =>
                      setEmploymentInfoForm((f) =>
                        f && { ...f, employmentType: v as EmploymentType },
                      )
                    }
                  >
                    <SelectTrigger data-testid="select-employment-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(EMPLOYMENT_TYPE_LABELS) as EmploymentType[]).map((k) => (
                        <SelectItem key={k} value={k}>
                          {EMPLOYMENT_TYPE_LABELS[k]}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-sm">Status</Label>
                  <Select
                    value={employmentInfoForm.employmentStatus}
                    onValueChange={(v) =>
                      setEmploymentInfoForm((f) =>
                        f && { ...f, employmentStatus: v as EmploymentStatus },
                      )
                    }
                  >
                    <SelectTrigger data-testid="select-employment-status">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(Object.keys(EMPLOYMENT_STATUS_LABELS) as EmploymentStatus[]).map(
                        (k) => (
                          <SelectItem key={k} value={k}>
                            {EMPLOYMENT_STATUS_LABELS[k]}
                          </SelectItem>
                        ),
                      )}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm">Manager</Label>
                <Select
                  value={employmentInfoForm.managerMemberId || "__none__"}
                  onValueChange={(v) =>
                    setEmploymentInfoForm((f) =>
                      f && { ...f, managerMemberId: v === "__none__" ? "" : v },
                    )
                  }
                >
                  <SelectTrigger data-testid="select-manager">
                    <SelectValue placeholder="No manager" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">No manager</SelectItem>
                    {managerOptions
                      .filter((mo) => mo.id !== employmentInfoForm.member.id)
                      .map((mo) => (
                        <SelectItem key={mo.id} value={String(mo.id)}>{displayName(mo)}</SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label className="text-sm">Working days</Label>
                <div className="flex gap-1.5 flex-wrap">
                  {WORK_SCHEDULE_DAYS.map((d) => {
                    const active = employmentInfoForm.workingDays[d.key];
                    return (
                      <button
                        key={d.key}
                        type="button"
                        onClick={() =>
                          setEmploymentInfoForm((f) =>
                            f && {
                              ...f,
                              workingDays: { ...f.workingDays, [d.key]: !active },
                            },
                          )
                        }
                        className={cn(
                          "h-8 w-12 rounded-md border text-xs font-medium uppercase transition-colors",
                          active
                            ? "bg-primary text-primary-foreground border-primary"
                            : "bg-background text-muted-foreground hover:bg-muted",
                        )}
                      >
                        {d.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setEmploymentInfoForm(null)}
                data-testid="button-cancel-employment-info"
              >
                Cancel
              </Button>
              <Button
                onClick={() => {
                  const f = employmentInfoForm;
                  if (!f) return;
                  const payload: Record<string, unknown> = {
                    jobTitle: f.jobTitle.trim() || null,
                    startDate: f.startDate || null,
                    department: f.department || null,
                    location: f.location || null,
                    employmentType: f.employmentType || "full_time",
                    employmentStatus: f.employmentStatus,
                    workingDays: f.workingDays,
                  };
                  if (f.managerMemberId) {
                    payload.managerMemberId = parseInt(f.managerMemberId, 10);
                  } else {
                    payload.managerMemberId = null;
                  }
                  employmentInfoMutation.mutate({ id: f.member.id, payload });
                }}
                disabled={employmentInfoMutation.isPending}
                data-testid="button-save-employment-info"
              >
                {employmentInfoMutation.isPending ? "Saving…" : "Save changes"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* Set mobile password dialog */}
      {setPasswordFor && (
        <SetMobilePasswordDialog
          member={setPasswordFor}
          onClose={() => setSetPasswordFor(null)}
          onSave={(password) => setMobilePasswordMutation.mutate({ id: setPasswordFor.id, password })}
          isPending={setMobilePasswordMutation.isPending}
        />
      )}

      {/* Approve access request dialog (kept for compatibility with existing flow) */}

      <Dialog
        open={approveRequest !== null && !showInviteDialog}
        onOpenChange={(open) => {
          if (!open) {
            setApproveRequest(null);
            setApproveRoleId("");
          }
        }}
      >
        <DialogContent data-testid="dialog-approve-request">
          <DialogHeader>
            <DialogTitle>Approve access request</DialogTitle>
            <DialogDescription>
              {approveRequest && (
                <>
                  Assign a role to <strong>{approveRequest.requester_email}</strong> and send
                  them an invite.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <Select value={approveRoleId} onValueChange={setApproveRoleId} data-testid="select-approve-role">
              <SelectTrigger className="w-full" data-testid="select-trigger-approve-role">
                <SelectValue placeholder="Select a role" />
              </SelectTrigger>
              <SelectContent>
                {customRoles.map((r) => (
                  <SelectItem key={r.id} value={String(r.id)}>
                    {r.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setApproveRequest(null);
                setApproveRoleId("");
              }}
              data-testid="button-cancel-approve-request"
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (approveRequest && approveRoleId) {
                  approveMutation.mutate({
                    id: approveRequest.id,
                    roleId: parseInt(approveRoleId, 10),
                  });
                }
              }}
              disabled={approveMutation.isPending || !approveRoleId}
              data-testid="button-confirm-approve-request"
            >
              {approveMutation.isPending ? "Approving…" : "Approve & invite"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
