import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  MailOpen,
  UserPlus,
  Clock,
  CheckCircle2,
  XCircle,
  RotateCcw,
  Copy,
  Check,
  MoreHorizontal,
  Mail,
  Crown,
  ShieldOff,
  Shield,
  Users,
  CalendarClock,
  AlertTriangle,
} from "lucide-react";
import { apiFetch, queryClient } from "@/lib/queryClient";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { useRoles, type WorkspaceRole } from "@/hooks/use-roles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const COPY_FEEDBACK_MS = 2000;

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

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
  first_name: string | null;
  last_name: string | null;
  image_url: string | null;
  invite_token: string | null;
  access_expires_at: string | null;
  revoked_at: string | null;
};

type UsersResponse = {
  members: Member[];
  me: { role: string; email: string | null };
};

type PersonRow = {
  id: string;
  source: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  access_type: "owner" | "user" | "pending_invite" | "team_member_only" | "no_access";
  role: string | null;
  role_name: string | null;
  member_id: number | null;
  has_external_profile: boolean;
  external_type: string | null;
  external_company_name: string | null;
  access_expires_at: string | null;
  revoked_at: string | null;
  image_url: string | null;
};

type PeopleResponse = {
  people: PersonRow[];
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

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function isExpired(iso: string | null): boolean {
  if (!iso) return false;
  return new Date(iso).getTime() < Date.now();
}

function memberName(m: { first_name: string | null; last_name: string | null; email: string | null }): string {
  const first = m.first_name?.trim();
  const last = m.last_name?.trim();
  if (first && last) return `${first} ${last}`;
  if (first) return first;
  return m.email ?? "—";
}

function Avatar({ person, size = 9 }: { person: { first_name: string | null; last_name: string | null; email: string | null; image_url: string | null }; size?: number }) {
  const name = memberName(person);
  const sizeClass = `w-${size} h-${size}`;
  return (
    <div className={`${sizeClass} rounded-full bg-secondary flex items-center justify-center text-sm font-medium shrink-0`}>
      {person.image_url ? (
        <img
          src={person.image_url}
          alt=""
          className="w-full h-full rounded-full object-cover"
          referrerPolicy="no-referrer"
        />
      ) : (
        name.charAt(0).toUpperCase()
      )}
    </div>
  );
}

function RoleBadge({ role, roleNames, roleName }: { role: string | null; roleNames?: string[] | null; roleName?: string | null }) {
  const { t } = useTranslation();
  if (role === "owner") {
    return (
      <span className="inline-flex items-center gap-1 text-xs bg-primary/10 text-primary px-2 py-0.5 rounded-full">
        <Crown size={10} />
        {t("common.owner")}
      </span>
    );
  }
  const names = roleNames?.length ? roleNames : (roleName ? [roleName] : []);
  if (names.length === 0) return null;
  return (
    <>
      {names.map((name) => (
        <span key={name} className="inline-flex items-center text-xs bg-secondary text-foreground px-2 py-0.5 rounded-full">
          {name}
        </span>
      ))}
    </>
  );
}

function ExpiryChip({ expiresAt }: { expiresAt: string | null }) {
  const { t } = useTranslation();
  if (!expiresAt) return null;
  const expired = isExpired(expiresAt);
  if (expired) {
    return (
      <span className="inline-flex items-center gap-1 text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full">
        <AlertTriangle size={10} />
        {t("people.invites.accessExpired")}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">
      <CalendarClock size={10} />
      {t("people.invites.accessExpiresOn", { date: formatDate(expiresAt) })}
    </span>
  );
}

function RevokeAccessDialog({
  name,
  open,
  onClose,
  onConfirm,
  isPending,
}: {
  name: string;
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  isPending: boolean;
}) {
  const { t } = useTranslation();
  return (
    <AlertDialog open={open} onOpenChange={(v) => !v && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("people.invites.revokeAccess")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("people.invites.revokeAccessConfirm", { name })}
            <br />
            {t("people.invites.revokeAccessDesc")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onClose}>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            disabled={isPending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {t("people.invites.revokeAccess")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function SetExpiryDialog({
  open,
  currentExpiry,
  onClose,
  onSave,
  isPending,
}: {
  open: boolean;
  currentExpiry: string | null;
  onClose: () => void;
  onSave: (date: string | null) => void;
  isPending: boolean;
}) {
  const { t } = useTranslation();
  const [value, setValue] = useState(currentExpiry ? currentExpiry.slice(0, 10) : "");

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("people.invites.setExpiry")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1.5">
            <Label>{t("people.invites.expiryDate")}</Label>
            <Input
              type="date"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              min={new Date().toISOString().slice(0, 10)}
            />
          </div>
          <p className="text-xs text-muted-foreground">{t("people.invites.expiryDateHint")}</p>
        </div>
        <DialogFooter className="gap-2">
          {currentExpiry && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onSave(null)}
              disabled={isPending}
            >
              {t("people.invites.clearExpiry")}
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={onClose}>{t("common.cancel")}</Button>
          <Button
            size="sm"
            onClick={() => onSave(value || null)}
            disabled={isPending || !value}
          >
            {t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ChangeRoleDialog({
  member,
  roles,
  rolesLoading,
  open,
  onClose,
  onSave,
  isPending,
}: {
  member: Member;
  roles: WorkspaceRole[];
  rolesLoading: boolean;
  open: boolean;
  onClose: () => void;
  onSave: (roleIds: number[], makeOwner: boolean) => void;
  isPending: boolean;
}) {
  const { t } = useTranslation();
  const initialIds = new Set(member.custom_role_ids ?? (member.custom_role_id ? [member.custom_role_id] : []));
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set(initialIds));
  const [makeOwner, setMakeOwner] = useState(false);

  const hasChanged = makeOwner
    || selectedIds.size !== initialIds.size
    || Array.from(selectedIds).some((id) => !initialIds.has(id));

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("people.invites.changeRole")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <p className="text-sm text-muted-foreground">
            {t("people.invites.changeRoleDesc", { name: memberName(member) })}
          </p>
          <div className="space-y-1.5">
            <Label>{t("people.invites.roleLabel")}</Label>
            {rolesLoading ? (
              <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
            ) : roles.length === 0 ? (
              <p className="text-sm text-muted-foreground">No custom roles defined.</p>
            ) : (
              <div className="space-y-1 max-h-48 overflow-y-auto border rounded-md p-2">
                {roles.map((r) => {
                  const checked = selectedIds.has(r.id);
                  return (
                    <div
                      key={r.id}
                      className="flex items-center gap-2 px-1 py-1.5 rounded hover:bg-secondary/50 cursor-pointer"
                      onClick={() =>
                        setSelectedIds((prev) => {
                          const next = new Set(prev);
                          if (checked) next.delete(r.id); else next.add(r.id);
                          return next;
                        })
                      }
                    >
                      <Checkbox
                        id={`change-role-${r.id}`}
                        checked={checked}
                        onCheckedChange={(v) =>
                          setSelectedIds((prev) => {
                            const next = new Set(prev);
                            if (v) next.add(r.id); else next.delete(r.id);
                            return next;
                          })
                        }
                        data-testid={`checkbox-change-role-${r.id}`}
                      />
                      <Label htmlFor={`change-role-${r.id}`} className="cursor-pointer font-normal flex-1" onClick={(e) => e.stopPropagation()}>
                        {r.name}
                      </Label>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          <div className="border-t pt-2 space-y-1.5">
            <div
              className="flex items-center gap-2 px-1 py-1.5 rounded hover:bg-secondary/50 cursor-pointer"
              onClick={() => setMakeOwner((v) => !v)}
            >
              <Checkbox
                id="change-role-owner"
                checked={makeOwner}
                onCheckedChange={(v) => setMakeOwner(!!v)}
                data-testid="checkbox-change-role-owner"
              />
              <Label htmlFor="change-role-owner" className="cursor-pointer font-normal flex-1" onClick={(e) => e.stopPropagation()}>
                {t("common.owner")}
              </Label>
            </div>
            {makeOwner && (
              <p className="text-xs text-amber-700 bg-amber-50 rounded-md px-2.5 py-2">
                {t("people.invites.changeRoleOwnerHint")}
              </p>
            )}
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            size="sm"
            onClick={() => onSave(Array.from(selectedIds), makeOwner)}
            disabled={isPending || !hasChanged}
            data-testid="button-save-change-role"
          >
            {isPending ? t("common.saving") : t("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MemberRow({
  member,
  isOwner,
  onResend,
  onRevokeInvite,
  onRevokeAccess,
  onSetExpiry,
  onChangeRole,
  isResending,
  isRevoking,
}: {
  member: Member;
  isOwner: boolean;
  onResend: (m: Member) => void;
  onRevokeInvite: (m: Member) => void;
  onRevokeAccess: (m: Member) => void;
  onSetExpiry: (m: Member) => void;
  onChangeRole: (m: Member) => void;
  isResending: boolean;
  isRevoking: boolean;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const isPending = !member.joined && !member.revoked_at;
  const isRevoked = !!member.revoked_at;
  const isActive = member.joined && !isRevoked;

  function copyInviteLink() {
    if (!member.invite_token) return;
    const url = `${window.location.origin}${basePath}/join?token=${encodeURIComponent(member.invite_token)}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    });
  }

  return (
    <div className="flex items-center gap-3 py-3 border-b last:border-0">
      <Avatar person={member} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm truncate">{memberName(member)}</span>
          <span className="text-xs text-muted-foreground">{member.email}</span>
          <RoleBadge role={member.role} roleNames={member.role_names} roleName={member.role_name} />
          {isRevoked && (
            <span className="inline-flex items-center gap-1 text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full">
              <ShieldOff size={10} />
              {t("people.invites.revoked")}
            </span>
          )}
          {isActive && (
            <span className="inline-flex items-center gap-1 text-xs bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full">
              <CheckCircle2 size={10} />
              {t("people.invites.accepted")}
            </span>
          )}
          {isPending && (
            <span className="inline-flex items-center gap-1 text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">
              <Clock size={10} />
              {t("people.invites.pending")}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 mt-0.5 flex-wrap">
          {member.joined_at ? (
            <span className="text-xs text-muted-foreground">
              {t("people.invites.joinedAt", { time: timeAgo(member.joined_at) })}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">
              {t("people.invites.invitedAt", { time: timeAgo(member.invited_at) })}
            </span>
          )}
          {member.invited_by_email && (
            <span className="text-xs text-muted-foreground hidden sm:inline">
              {t("people.invites.invitedBy", { email: member.invited_by_email })}
            </span>
          )}
          {member.access_expires_at && !isRevoked && (
            <ExpiryChip expiresAt={member.access_expires_at} />
          )}
          {isRevoked && member.revoked_at && (
            <span className="text-xs text-muted-foreground">
              {t("people.invites.revokedAt", { time: timeAgo(member.revoked_at) })}
            </span>
          )}
        </div>
      </div>
      {isOwner && !isRevoked && member.role !== "owner" && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0">
              <MoreHorizontal size={14} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {isPending && member.invite_token && (
              <DropdownMenuItem onClick={copyInviteLink}>
                {copied ? <Check size={14} className="mr-2 text-emerald-600" /> : <Copy size={14} className="mr-2" />}
                {copied ? t("people.invites.copied") : t("people.invites.copyLink")}
              </DropdownMenuItem>
            )}
            {isPending && (
              <DropdownMenuItem onClick={() => onResend(member)} disabled={isResending}>
                <RotateCcw size={14} className="mr-2" />
                {t("people.invites.resend")}
              </DropdownMenuItem>
            )}
            {isActive && (
              <DropdownMenuItem onClick={() => onChangeRole(member)}>
                <Shield size={14} className="mr-2" />
                {t("people.invites.changeRole")}
              </DropdownMenuItem>
            )}
            {isActive && (
              <DropdownMenuItem onClick={() => onSetExpiry(member)}>
                <CalendarClock size={14} className="mr-2" />
                {t("people.invites.setExpiry")}
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            {isPending ? (
              <DropdownMenuItem
                onClick={() => onRevokeInvite(member)}
                disabled={isRevoking}
                className="text-destructive focus:text-destructive"
              >
                <XCircle size={14} className="mr-2" />
                {t("people.invites.revoke")}
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem
                onClick={() => onRevokeAccess(member)}
                disabled={isRevoking}
                className="text-destructive focus:text-destructive"
              >
                <ShieldOff size={14} className="mr-2" />
                {t("people.invites.revokeAccess")}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

function ExternalRow({
  person,
  isOwner,
  onRevokeAccess,
  onSetExpiry,
}: {
  person: PersonRow;
  isOwner: boolean;
  onRevokeAccess: (p: PersonRow) => void;
  onSetExpiry: (p: PersonRow) => void;
}) {
  const { t } = useTranslation();
  const hasAccess = person.access_type === "user" || person.access_type === "owner" || person.access_type === "pending_invite";
  const isRevoked = !!person.revoked_at;

  return (
    <div className="flex items-center gap-3 py-3 border-b last:border-0">
      <Avatar person={{ ...person, image_url: person.image_url }} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-medium text-sm truncate">{memberName(person)}</span>
          {person.email && (
            <span className="text-xs text-muted-foreground">{person.email}</span>
          )}
          <span className="inline-flex items-center text-xs bg-purple-100 text-purple-700 px-2 py-0.5 rounded-full">
            {person.external_type
              ? t(`people.external.types.${person.external_type}`, person.external_type)
              : t("people.external.sourceBadge")}
          </span>
          {person.external_company_name && (
            <span className="text-xs text-muted-foreground">{person.external_company_name}</span>
          )}
          {isRevoked && (
            <span className="inline-flex items-center gap-1 text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full">
              <ShieldOff size={10} />
              {t("people.invites.revoked")}
            </span>
          )}
          {!isRevoked && hasAccess && (
            <span className="inline-flex items-center gap-1 text-xs bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full">
              <CheckCircle2 size={10} />
              {t("people.invites.hasAccess")}
            </span>
          )}
          {!isRevoked && !hasAccess && (
            <span className="inline-flex items-center gap-1 text-xs bg-secondary text-muted-foreground px-2 py-0.5 rounded-full">
              {t("people.invites.noAccess")}
            </span>
          )}
        </div>
        {person.access_expires_at && !isRevoked && (
          <div className="mt-0.5">
            <ExpiryChip expiresAt={person.access_expires_at} />
          </div>
        )}
        {isRevoked && person.revoked_at && (
          <span className="text-xs text-muted-foreground mt-0.5 block">
            {t("people.invites.revokedAt", { time: timeAgo(person.revoked_at) })}
          </span>
        )}
      </div>
      {isOwner && hasAccess && !isRevoked && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0">
              <MoreHorizontal size={14} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => onSetExpiry(person)}>
              <CalendarClock size={14} className="mr-2" />
              {t("people.invites.setExpiry")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => onRevokeAccess(person)}
              className="text-destructive focus:text-destructive"
            >
              <ShieldOff size={14} className="mr-2" />
              {t("people.invites.revokeAccess")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

function SectionCard({
  icon,
  title,
  count,
  children,
  emptyIcon,
  emptyText,
}: {
  icon: React.ReactNode;
  title: string;
  count: number;
  children: React.ReactNode;
  emptyIcon?: React.ReactNode;
  emptyText: string;
}) {
  return (
    <div className="border border-border rounded-xl overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 bg-muted/40 border-b">
        {icon}
        <h2 className="text-sm font-semibold">{title} ({count})</h2>
      </div>
      {count === 0 ? (
        <div className="flex flex-col items-center justify-center py-8 gap-2 text-muted-foreground">
          {emptyIcon ?? <Mail size={24} className="opacity-30" />}
          <p className="text-sm">{emptyText}</p>
        </div>
      ) : (
        <div className="px-4">{children}</div>
      )}
    </div>
  );
}

export default function InvitesAccessPage() {
  const { t } = useTranslation();
  const { isOwner } = useWorkspaceRole();
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  const [revokeTarget, setRevokeTarget] = useState<{ id: string; name: string; isMember: boolean; memberId?: number } | null>(null);
  const [expiryTarget, setExpiryTarget] = useState<{ id: string; currentExpiry: string | null } | null>(null);
  const [roleTarget, setRoleTarget] = useState<Member | null>(null);

  const { data: usersData, isLoading: usersLoading } = useQuery<UsersResponse>({
    queryKey: ["users"],
    queryFn: () => apiFetch("/api/users"),
  });

  const { data: rolesData, isLoading: rolesLoading } = useRoles();

  const { data: externalData, isLoading: externalLoading } = useQuery<PeopleResponse>({
    queryKey: ["people", "external"],
    queryFn: () => apiFetch("/api/people?tab=external"),
  });

  const members = usersData?.members ?? [];
  const activeMembers = members.filter((m) => m.joined && !m.revoked_at);
  const pendingMembers = members.filter((m) => !m.joined && !m.revoked_at);
  const revokedMembers = members.filter((m) => !!m.revoked_at);
  const externalPeople = externalData?.people ?? [];

  const isLoading = usersLoading || externalLoading;

  const resendMutation = useMutation({
    mutationFn: (member: Member) =>
      apiFetch(`/api/users/${member.id}/resend-invite`, { method: "POST" }),
    onSuccess: () => {
      toast({ title: t("people.invites.resentSuccess") });
      queryClient.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (err: Error) => {
      toast({ title: t("common.error"), description: err.message, variant: "destructive" });
    },
  });

  const revokeInviteMutation = useMutation({
    mutationFn: (member: Member) =>
      apiFetch(`/api/users/${member.id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast({ title: t("people.invites.revokedSuccess") });
      queryClient.invalidateQueries({ queryKey: ["users"] });
    },
    onError: (err: Error) => {
      toast({ title: t("common.error"), description: err.message, variant: "destructive" });
    },
  });

  const revokeAccessMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/people/${id}/revoke-access`, { method: "POST" }),
    onSuccess: () => {
      toast({ title: t("people.invites.accessRevoked") });
      queryClient.invalidateQueries({ queryKey: ["users"] });
      queryClient.invalidateQueries({ queryKey: ["people", "external"] });
      setRevokeTarget(null);
    },
    onError: (err: Error) => {
      toast({ title: t("common.error"), description: err.message, variant: "destructive" });
    },
  });

  const setExpiryMutation = useMutation({
    mutationFn: ({ id, expiresAt }: { id: string; expiresAt: string | null }) =>
      apiFetch(`/api/people/${id}/access-expiry`, {
        method: "PATCH",
        body: JSON.stringify({ access_expires_at: expiresAt }),
      }),
    onSuccess: () => {
      toast({ title: t("people.invites.expiryUpdated") });
      queryClient.invalidateQueries({ queryKey: ["users"] });
      queryClient.invalidateQueries({ queryKey: ["people", "external"] });
      setExpiryTarget(null);
    },
    onError: (err: Error) => {
      toast({ title: t("common.error"), description: err.message, variant: "destructive" });
    },
  });

  const changeRoleMutation = useMutation({
    mutationFn: ({ id, roleIds }: { id: number; roleIds: number[] }) =>
      apiFetch(`/api/users/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ roleIds }),
      }),
    onSuccess: () => {
      toast({ title: t("people.invites.roleChanged") });
      queryClient.invalidateQueries({ queryKey: ["users"] });
      setRoleTarget(null);
    },
    onError: (err: Error) => {
      toast({ title: t("common.error"), description: err.message, variant: "destructive" });
    },
  });

  const promoteMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/api/users/${id}/promote-to-owner`, { method: "POST" }),
    onSuccess: () => {
      toast({ title: t("people.invites.promotedToOwner") });
      queryClient.invalidateQueries({ queryKey: ["users"] });
      queryClient.invalidateQueries({ queryKey: ["people", "external"] });
      setRoleTarget(null);
    },
    onError: (err: Error) => {
      toast({ title: t("common.error"), description: err.message, variant: "destructive" });
    },
  });

  function handleSaveRole(roleIds: number[], makeOwner: boolean) {
    if (!roleTarget) return;
    if (makeOwner) {
      promoteMutation.mutate(roleTarget.id);
    } else {
      changeRoleMutation.mutate({ id: roleTarget.id, roleIds });
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <MailOpen size={22} />
            {t("people.invites.title")}
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            {t("people.invites.subtitle")}
          </p>
        </div>
        {isOwner && (
          <Button size="sm" onClick={() => setLocation("/people?add=invite")}>
            <UserPlus size={16} className="mr-1" />
            {t("people.invites.inviteNew")}
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground text-sm">
          {t("common.loading")}
        </div>
      ) : (
        <div className="space-y-6">
          <SectionCard
            icon={<CheckCircle2 size={15} className="text-emerald-600" />}
            title={t("people.invites.acceptedSection")}
            count={activeMembers.length}
            emptyIcon={<Users size={24} className="opacity-30" />}
            emptyText={t("people.invites.noAccepted")}
          >
            {activeMembers.map((m) => (
              <MemberRow
                key={m.id}
                member={m}
                isOwner={isOwner}
                onResend={(member) => resendMutation.mutate(member)}
                onRevokeInvite={(member) => revokeInviteMutation.mutate(member)}
                onRevokeAccess={(member) => setRevokeTarget({ id: `wm_${member.id}`, name: memberName(member), isMember: true, memberId: member.id })}
                onSetExpiry={(member) => setExpiryTarget({ id: `wm_${member.id}`, currentExpiry: member.access_expires_at })}
                onChangeRole={(member) => setRoleTarget(member)}
                isResending={resendMutation.isPending}
                isRevoking={revokeInviteMutation.isPending}
              />
            ))}
          </SectionCard>

          <SectionCard
            icon={<Clock size={15} className="text-amber-600" />}
            title={t("people.invites.pendingSection")}
            count={pendingMembers.length}
            emptyIcon={<Mail size={24} className="opacity-30" />}
            emptyText={t("people.invites.noPending")}
          >
            {pendingMembers.map((m) => (
              <MemberRow
                key={m.id}
                member={m}
                isOwner={isOwner}
                onResend={(member) => resendMutation.mutate(member)}
                onRevokeInvite={(member) => revokeInviteMutation.mutate(member)}
                onRevokeAccess={(member) => setRevokeTarget({ id: `wm_${member.id}`, name: memberName(member), isMember: true, memberId: member.id })}
                onSetExpiry={(member) => setExpiryTarget({ id: `wm_${member.id}`, currentExpiry: member.access_expires_at })}
                onChangeRole={(member) => setRoleTarget(member)}
                isResending={resendMutation.isPending}
                isRevoking={revokeInviteMutation.isPending}
              />
            ))}
          </SectionCard>

          <SectionCard
            icon={<Users size={15} className="text-purple-600" />}
            title={t("people.invites.externalSection")}
            count={externalPeople.length}
            emptyIcon={<Users size={24} className="opacity-30" />}
            emptyText={t("people.invites.noExternal")}
          >
            {externalPeople.map((p) => (
              <ExternalRow
                key={p.id}
                person={p}
                isOwner={isOwner}
                onRevokeAccess={(person) => setRevokeTarget({ id: person.id, name: memberName(person), isMember: false })}
                onSetExpiry={(person) => setExpiryTarget({ id: person.id, currentExpiry: person.access_expires_at })}
              />
            ))}
          </SectionCard>

          {revokedMembers.length > 0 && (
            <SectionCard
              icon={<ShieldOff size={15} className="text-red-500" />}
              title={t("people.invites.revokedSection")}
              count={revokedMembers.length}
              emptyText={t("people.invites.noRevoked")}
            >
              {revokedMembers.map((m) => (
                <MemberRow
                  key={m.id}
                  member={m}
                  isOwner={isOwner}
                  onResend={(member) => resendMutation.mutate(member)}
                  onRevokeInvite={(member) => revokeInviteMutation.mutate(member)}
                  onRevokeAccess={(member) => setRevokeTarget({ id: `wm_${member.id}`, name: memberName(member), isMember: true })}
                  onSetExpiry={(member) => setExpiryTarget({ id: `wm_${member.id}`, currentExpiry: member.access_expires_at })}
                  onChangeRole={(member) => setRoleTarget(member)}
                  isResending={resendMutation.isPending}
                  isRevoking={revokeInviteMutation.isPending}
                />
              ))}
            </SectionCard>
          )}
        </div>
      )}

      {revokeTarget && (
        <RevokeAccessDialog
          name={revokeTarget.name}
          open={!!revokeTarget}
          onClose={() => setRevokeTarget(null)}
          onConfirm={() => revokeAccessMutation.mutate(revokeTarget.id)}
          isPending={revokeAccessMutation.isPending}
        />
      )}

      {expiryTarget && (
        <SetExpiryDialog
          open={!!expiryTarget}
          currentExpiry={expiryTarget.currentExpiry}
          onClose={() => setExpiryTarget(null)}
          onSave={(date) => setExpiryMutation.mutate({ id: expiryTarget.id, expiresAt: date })}
          isPending={setExpiryMutation.isPending}
        />
      )}

      {roleTarget && (
        <ChangeRoleDialog
          key={roleTarget.id}
          member={roleTarget}
          roles={rolesData?.roles ?? []}
          rolesLoading={rolesLoading}
          open={!!roleTarget}
          onClose={() => setRoleTarget(null)}
          onSave={handleSaveRole}
          isPending={changeRoleMutation.isPending || promoteMutation.isPending}
        />
      )}
    </div>
  );
}
