import { useState, useEffect, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  ShieldCheck, Plus, Pencil, Trash2, Copy, Search, ChevronDown, ChevronRight,
  Eye, Users, Layers, Hash, ArrowUpDown, Filter, X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { apiFetch, queryClient } from "@/lib/queryClient";
import {
  ALL_PAGES,
  SUB_PERMISSION_LABELS,
  isValidPageKey,
} from "@/known-page-keys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Badge } from "@/components/ui/badge";
import { WorkspaceImage } from "@/components/WorkspaceImage";
import { useToast } from "@/hooks/use-toast";
import type { WorkspaceRole } from "@/hooks/use-roles";
import { checkNameWarning } from "@/lib/nameWarning";
import { computeSmartDefault } from "@/lib/roleDefaults";
import { PERMISSION_GROUPS } from "./permission-groups";
import type { PermPage, PermGroup } from "./permission-groups";

type WorkspaceMember = {
  id: number;
  email: string;
  role: string;
  custom_role_id: number | null;
  role_name: string | null;
};

type Channel = {
  id: number;
  name: string;
  has_logo?: boolean;
};

type RolesResponse = { roles: WorkspaceRole[] };

// All top-level page keys as a set for quick lookup
const TOP_LEVEL_PAGE_KEYS = new Set(ALL_PAGES.map((p) => p.key));

function isTopLevel(key: string) {
  return TOP_LEVEL_PAGE_KEYS.has(key);
}

/**
 * Roles created before a page was retired can still contain its old key.
 * Keep those legacy values out of the editor payload so adding a current
 * permission does not fail validation for an unrelated, invisible key.
 */
function normalizeAllowedPages(pages: string[] | null | undefined): string[] {
  return [...new Set((pages ?? []).filter(isValidPageKey))];
}

function countEnabledPages(pages: string[]): number {
  return pages.filter((k) => isTopLevel(k)).length;
}

function countEnabledPerms(pages: string[]): number {
  return pages.length;
}

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// ── Grouped Permission Editor ─────────────────────────────────────────────────

function GroupedPermissionEditor({
  value,
  onChange,
}: {
  value: string[];
  onChange: (pages: string[]) => void;
}) {
  const [search, setSearch] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  function toggleGroup(id: string) {
    setCollapsed((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  function togglePage(pageKey: string, subPerms?: { key: string }[]) {
    const isEnabled = value.includes(pageKey);
    if (isEnabled) {
      const keysToRemove = new Set([pageKey, ...(subPerms?.map((s) => s.key) ?? [])]);
      onChange(value.filter((k) => !keysToRemove.has(k)));
    } else {
      onChange([...value, pageKey]);
    }
  }

  function toggleSub(subKey: string, parentKey: string) {
    if (value.includes(subKey)) {
      onChange(value.filter((k) => k !== subKey));
    } else {
      // Auto-check parent when checking a sub-perm
      const next = [...value, subKey];
      if (!next.includes(parentKey)) next.push(parentKey);
      onChange(next);
    }
  }

  function toggleGroup_allPages(group: PermGroup) {
    const allKeys = group.pages.flatMap((p) => [p.key, ...(p.subPerms?.map((s) => s.key) ?? [])]);
    const allEnabled = allKeys.every((k) => value.includes(k));
    if (allEnabled) {
      onChange(value.filter((k) => !new Set(allKeys).has(k)));
    } else {
      const toAdd = allKeys.filter((k) => !value.includes(k));
      onChange([...value, ...toAdd]);
    }
  }

  const lowerSearch = search.toLowerCase();

  const matchesSearch = (label: string) =>
    !lowerSearch || label.toLowerCase().includes(lowerSearch);

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input
          className="pl-8 h-8 text-sm"
          placeholder="Search permissions…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          data-testid="input-permission-search"
        />
      </div>

      <div className="space-y-1">
        {PERMISSION_GROUPS.map((group) => {
          // Keep every row when the group itself matches. In particular, the
          // CMC POS page rows are labelled "Dashboard" and "New Order", so a
          // search for "CMC" must not hide those independently grantable pages.
          const groupMatchesSearch = matchesSearch(group.label);
          const visiblePages = groupMatchesSearch
            ? group.pages
            : group.pages.filter(
                (p) =>
                  matchesSearch(p.label) ||
                  p.subPerms?.some((s) => matchesSearch(s.label)),
              );
          if (visiblePages.length === 0) return null;

          const allGroupKeys = group.pages.flatMap((p) => [
            p.key,
            ...(p.subPerms?.map((s) => s.key) ?? []),
          ]);
          const enabledCount = allGroupKeys.filter((k) => value.includes(k)).length;
          const allGroupEnabled = allGroupKeys.length > 0 && allGroupKeys.every((k) => value.includes(k));
          const someGroupEnabled = enabledCount > 0 && !allGroupEnabled;
          const isOpen = !collapsed[group.id];

          return (
            <div key={group.id} className="border rounded-md overflow-hidden">
              <div
                className="flex items-center gap-2 px-3 py-2 bg-muted/40 cursor-pointer select-none hover:bg-muted/60 transition-colors"
                onClick={() => toggleGroup(group.id)}
              >
                <Checkbox
                  checked={allGroupEnabled}
                  data-indeterminate={someGroupEnabled}
                  onCheckedChange={() => {
                    toggleGroup_allPages(group);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="shrink-0"
                  data-testid={`checkbox-group-${group.id}`}
                />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{group.label}</span>
                    {enabledCount > 0 && (
                      <Badge variant="secondary" className="text-xs px-1.5 py-0 h-4">
                        {enabledCount}
                      </Badge>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">{group.description}</p>
                </div>
                {isOpen ? (
                  <ChevronDown size={14} className="text-muted-foreground shrink-0" />
                ) : (
                  <ChevronRight size={14} className="text-muted-foreground shrink-0" />
                )}
              </div>

              {isOpen && (
                <div className="px-3 py-2 space-y-2">
                  {visiblePages.map((page) => {
                    const pageEnabled = value.includes(page.key);
                    const visibleSubs = page.subPerms?.filter(
                      (s) =>
                        !lowerSearch ||
                        groupMatchesSearch ||
                        matchesSearch(s.label) ||
                        matchesSearch(page.label),
                    );
                    return (
                      <div key={page.key}>
                        <label className="flex items-center gap-2 text-sm cursor-pointer py-0.5">
                          <Checkbox
                            checked={pageEnabled}
                            onCheckedChange={() => togglePage(page.key, page.subPerms)}
                            data-testid={`checkbox-page-${page.key}`}
                          />
                          <span>{page.label}</span>
                        </label>
                        {pageEnabled && visibleSubs && visibleSubs.length > 0 && (
                          <div className="ml-6 mt-1 space-y-1">
                            {visibleSubs.map((sub) => (
                              <label key={sub.key} className="flex items-center gap-2 text-xs cursor-pointer py-0.5 text-muted-foreground">
                                <Checkbox
                                  checked={value.includes(sub.key)}
                                  onCheckedChange={() => toggleSub(sub.key, page.key)}
                                  data-testid={`checkbox-page-${sub.key}`}
                                />
                                <span>{sub.label}</span>
                              </label>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Channel access chips ──────────────────────────────────────────────────────

function ChannelChips({
  channels,
  value,
  onChange,
}: {
  channels: Channel[];
  value: number[];
  onChange: (ids: number[]) => void;
}) {
  function toggle(id: number) {
    if (value.includes(id)) {
      onChange(value.filter((v) => v !== id));
    } else {
      onChange([...value, id]);
    }
  }

  if (channels.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No channels exist yet. Create channels first to grant access here.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap gap-2">
      {channels.map((c) => {
        const selected = value.includes(c.id);
        return (
          <button
            key={c.id}
            type="button"
            onClick={() => toggle(c.id)}
            className={`inline-flex items-center gap-1.5 text-sm px-2.5 py-1 rounded-full border transition-colors ${
              selected
                ? "bg-primary text-primary-foreground border-primary"
                : "bg-background text-foreground border-border hover:bg-secondary"
            }`}
            data-testid={`channel-chip-${c.id}`}
          >
            <span className="w-5 h-5 rounded-full bg-current/10 flex items-center justify-center text-[10px] font-bold shrink-0 overflow-hidden">
              {c.has_logo ? (
                <WorkspaceImage
                  src={`/api/channels/${c.id}/logo`}
                  alt={c.name}
                  className="w-full h-full object-cover"
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.display = "none";
                  }}
                />
              ) : (
                c.name[0]?.toUpperCase() ?? "?"
              )}
            </span>
            {c.name}
          </button>
        );
      })}
    </div>
  );
}

// ── Role Editor (full-page create/edit view) ──────────────────────────────────

function RoleEditor({
  role,
  roles,
  channels,
  onCancel,
  onSave,
  isPending,
  readOnly = false,
}: {
  role?: WorkspaceRole;
  roles: WorkspaceRole[];
  channels: Channel[];
  onCancel: () => void;
  onSave: (name: string, description: string | null, pages: string[], channelIds: number[]) => void;
  isPending: boolean;
  readOnly?: boolean;
}) {
  const isEditing = !!role && !readOnly;
  const [name, setName] = useState(role?.name ?? "");
  const [description, setDescription] = useState(role?.description ?? "");
  const [pages, setPages] = useState<string[]>(() =>
    normalizeAllowedPages(role?.allowed_pages),
  );
  const [channelIds, setChannelIds] = useState<number[]>(role?.channel_ids ?? []);

  const existingNames = roles.filter((r) => r.id !== role?.id).map((r) => r.name);
  const nameWarning = checkNameWarning(name, existingNames);

  const enabledModules = countEnabledPages(pages);
  const enabledPerms = countEnabledPerms(pages);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    onSave(
      name.trim(),
      description.trim() || null,
      normalizeAllowedPages(pages),
      channelIds,
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">
            {readOnly ? role?.name ?? "View role" : isEditing ? "Edit role" : "Create role"}
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {readOnly
              ? "Read-only view of this role's permissions and channel access."
              : isEditing
                ? "Update this role's name, permissions, and channel access."
                : "Define a new role with specific page permissions and channel access."}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button type="button" variant="outline" onClick={onCancel} disabled={isPending}>
            {readOnly ? "Back" : "Cancel"}
          </Button>
          {!readOnly && (
            <Button
              type="submit"
              form="role-editor-form"
              disabled={isPending || !name.trim()}
              data-testid="button-role-submit"
            >
              {isPending ? "Saving…" : isEditing ? "Save changes" : "Create role"}
            </Button>
          )}
        </div>
      </div>

      <form id="role-editor-form" onSubmit={handleSubmit} className="space-y-4">
        {/* Role basics */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Role basics</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Role name <span className="text-destructive">*</span></label>
                <Input
                  placeholder="e.g. Designer"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                  maxLength={100}
                  data-testid="input-role-name"
                />
                {nameWarning.exactMatch && (
                  <p className="text-xs text-amber-600 dark:text-amber-400" data-testid="name-warning-exact">
                    A role named &ldquo;{nameWarning.exactMatch}&rdquo; already exists.
                  </p>
                )}
                {!nameWarning.exactMatch && nameWarning.similarMatches.length > 0 && (
                  <p className="text-xs text-amber-600 dark:text-amber-400" data-testid="name-warning-similar">
                    Similar names exist: {nameWarning.similarMatches.join(", ")}.
                  </p>
                )}
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium">Description <span className="text-muted-foreground font-normal">(optional)</span></label>
                <Input
                  placeholder="Brief description of this role"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  maxLength={500}
                  data-testid="input-role-description"
                />
              </div>
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              <span className="inline-flex items-center gap-1.5 text-xs bg-secondary text-foreground px-2.5 py-1 rounded-full">
                <Layers size={11} />
                {enabledModules} module{enabledModules !== 1 ? "s" : ""} enabled
              </span>
              <span className="inline-flex items-center gap-1.5 text-xs bg-secondary text-foreground px-2.5 py-1 rounded-full">
                <Hash size={11} />
                {enabledPerms} permission{enabledPerms !== 1 ? "s" : ""}
              </span>
              <span className="inline-flex items-center gap-1.5 text-xs bg-secondary text-foreground px-2.5 py-1 rounded-full">
                <ShieldCheck size={11} />
                {channelIds.length} channel{channelIds.length !== 1 ? "s" : ""} assigned
              </span>
            </div>
          </CardContent>
        </Card>

        {/* Permissions */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Permissions</CardTitle>
            <p className="text-sm text-muted-foreground">
              Members with this role will only see the pages you enable below.
            </p>
          </CardHeader>
          <CardContent>
            <GroupedPermissionEditor value={pages} onChange={setPages} />
          </CardContent>
        </Card>

        {/* Channel access */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Channel access</CardTitle>
            <p className="text-sm text-muted-foreground">
              Members with this role will only see channels you grant below. If none selected, they have no channel access.
            </p>
          </CardHeader>
          <CardContent>
            <ChannelChips channels={channels} value={channelIds} onChange={setChannelIds} />
          </CardContent>
        </Card>
      </form>
    </div>
  );
}

// ── Channel logo chips for role rows ──────────────────────────────────────────

function ChannelLogos({
  channelIds,
  allChannels,
  max = 3,
}: {
  channelIds: number[];
  allChannels: Channel[];
  max?: number;
}) {
  if (channelIds.length === 0) return <span className="text-xs text-muted-foreground">No channels</span>;
  const visible = channelIds.slice(0, max);
  const remaining = channelIds.length - max;
  return (
    <div className="flex items-center gap-1">
      {visible.map((id) => {
        const ch = allChannels.find((c) => c.id === id);
        const initial = ch?.name[0]?.toUpperCase() ?? "?";
        return (
          <span
            key={id}
            className="w-5 h-5 rounded-full bg-secondary flex items-center justify-center text-[10px] font-bold text-foreground ring-1 ring-border overflow-hidden"
            title={ch?.name ?? `Channel ${id}`}
          >
            {ch?.has_logo ? (
              <WorkspaceImage
                src={`/api/channels/${id}/logo`}
                alt={ch.name}
                className="w-full h-full object-cover"
                onError={(e) => {
                  (e.currentTarget as HTMLImageElement).style.display = "none";
                  const parent = e.currentTarget.parentElement;
                  if (parent) parent.textContent = initial;
                }}
              />
            ) : (
              initial
            )}
          </span>
        );
      })}
      {remaining > 0 && (
        <span className="text-xs text-muted-foreground ml-0.5">+{remaining} more</span>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

type ViewState =
  | { kind: "list" }
  | { kind: "create" }
  | { kind: "edit"; role: WorkspaceRole }
  | { kind: "view"; role: WorkspaceRole };

export default function RolesPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [view, setView] = useState<ViewState>({ kind: "list" });
  const [deletingRole, setDeletingRole] = useState<WorkspaceRole | null>(null);
  const [reassignments, setReassignments] = useState<Record<number, number | null>>({});
  const [search, setSearch] = useState("");
  const [filterChannelId, setFilterChannelId] = useState<string>("__all__");
  const [sortBy, setSortBy] = useState<"default" | "name_asc" | "name_desc" | "perms_desc">("default");

  const { data, isLoading } = useQuery<RolesResponse>({
    queryKey: ["roles"],
    queryFn: () => apiFetch("/api/roles"),
  });

  const { data: usersData, isLoading: usersLoading } = useQuery<{ members: WorkspaceMember[] }>({
    queryKey: ["users"],
    queryFn: () => apiFetch("/api/users"),
    enabled: deletingRole !== null,
  });

  const { data: channelsData } = useQuery<{ channels: Channel[] }>({
    queryKey: ["channels-all-owner"],
    queryFn: () => apiFetch("/api/channels"),
  });

  const roles = data?.roles ?? [];
  const allChannels = channelsData?.channels ?? [];

  const affectedMembers: WorkspaceMember[] =
    deletingRole && usersData
      ? usersData.members.filter(
          (m) => m.custom_role_id === deletingRole.id && m.role !== "owner",
        )
      : [];

  useEffect(() => {
    if (!deletingRole || !usersData || affectedMembers.length === 0) return;
    if (Object.keys(reassignments).length > 0) return;
    const defaultRoleId = computeSmartDefault(
      usersData.members,
      deletingRole.id,
      affectedMembers,
    );
    setReassignments(
      Object.fromEntries(affectedMembers.map((m) => [m.id, defaultRoleId])),
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usersData, deletingRole]);

  function invalidate() {
    queryClient.invalidateQueries({ queryKey: ["roles"] });
  }

  // ── Summary stats ────────────────────────────────────────────────────────

  const totalUsersAssigned = useMemo(() => {
    if (!usersData) return null;
    return usersData.members.filter((m) => m.custom_role_id !== null && m.role !== "owner").length;
  }, [usersData]);

  const { data: allUsersData } = useQuery<{ members: WorkspaceMember[] }>({
    queryKey: ["users"],
    queryFn: () => apiFetch("/api/users"),
  });

  const summaryUsersAssigned = useMemo(() => {
    if (!allUsersData) return "—";
    return String(allUsersData.members.filter((m) => m.custom_role_id !== null && m.role !== "owner").length);
  }, [allUsersData]);

  const totalEnabledPerms = useMemo(
    () => roles.reduce((sum, r) => sum + r.allowed_pages.length, 0),
    [roles],
  );

  const channelsCovered = useMemo(() => {
    const ids = new Set<number>();
    for (const r of roles) for (const cid of r.channel_ids) ids.add(cid);
    return ids.size;
  }, [roles]);

  // ── Filtered / sorted list ───────────────────────────────────────────────

  const filteredRoles = useMemo(() => {
    let list = roles.filter((r) => {
      if (search && !r.name.toLowerCase().includes(search.toLowerCase())) return false;
      if (filterChannelId !== "__all__" && !r.channel_ids.includes(parseInt(filterChannelId, 10)))
        return false;
      return true;
    });

    if (sortBy === "name_asc") list = [...list].sort((a, b) => a.name.localeCompare(b.name));
    else if (sortBy === "name_desc") list = [...list].sort((a, b) => b.name.localeCompare(a.name));
    else if (sortBy === "perms_desc")
      list = [...list].sort((a, b) => b.allowed_pages.length - a.allowed_pages.length);

    return list;
  }, [roles, search, filterChannelId, sortBy]);

  // ── Mutations ────────────────────────────────────────────────────────────

  const createMutation = useMutation({
    mutationFn: ({
      name,
      description,
      allowedPages,
      channelIds,
    }: {
      name: string;
      description: string | null;
      allowedPages: string[];
      channelIds: number[];
    }) =>
      apiFetch("/api/roles", {
        method: "POST",
        body: JSON.stringify({ name, description, allowedPages, channelIds }),
      }),
    onSuccess: () => {
      setView({ kind: "list" });
      invalidate();
      toast({ title: "Role created" });
    },
    onError: (e: Error) =>
      toast({ title: "Could not create role", description: e.message, variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: ({
      id,
      name,
      description,
      allowedPages,
      channelIds,
    }: {
      id: number;
      name: string;
      description: string | null;
      allowedPages: string[];
      channelIds: number[];
    }) =>
      apiFetch(`/api/roles/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ name, description, allowedPages, channelIds }),
      }),
    onSuccess: () => {
      setView({ kind: "list" });
      invalidate();
      toast({ title: "Role updated" });
    },
    onError: (e: Error) =>
      toast({ title: "Could not update role", description: e.message, variant: "destructive" }),
  });

  const duplicateMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/api/roles/${id}/duplicate`, { method: "POST" }),
    onSuccess: () => {
      invalidate();
      toast({ title: "Role duplicated" });
    },
    onError: (e: Error) =>
      toast({ title: "Could not duplicate role", description: e.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async ({
      id,
      members,
      memberReassignments,
    }: {
      id: number;
      members: WorkspaceMember[];
      memberReassignments: Record<number, number | null>;
    }) => {
      await Promise.all(
        members.map((m) =>
          apiFetch(`/api/users/${m.id}`, {
            method: "PATCH",
            body: JSON.stringify({ roleId: memberReassignments[m.id] ?? null }),
          }),
        ),
      );
      return apiFetch(`/api/roles/${id}`, { method: "DELETE" });
    },
    onSuccess: () => {
      setDeletingRole(null);
      setReassignments({});
      invalidate();
      queryClient.invalidateQueries({ queryKey: ["users"] });
      toast({ title: "Role deleted" });
    },
    onError: (e: Error) => {
      toast({ title: "Could not delete role", description: e.message, variant: "destructive" });
    },
  });

  // ── Role editor view ─────────────────────────────────────────────────────

  if (view.kind === "create" || view.kind === "edit") {
    return (
      <RoleEditor
        role={view.kind === "edit" ? view.role : undefined}
        roles={roles}
        channels={allChannels}
        onCancel={() => setView({ kind: "list" })}
        onSave={(name, description, pages, channelIds) => {
          if (view.kind === "edit") {
            updateMutation.mutate({
              id: view.role.id,
              name,
              description,
              allowedPages: pages,
              channelIds,
            });
          } else {
            createMutation.mutate({ name, description, allowedPages: pages, channelIds });
          }
        }}
        isPending={createMutation.isPending || updateMutation.isPending}
      />
    );
  }

  if (view.kind === "view") {
    return (
      <RoleEditor
        role={view.role}
        roles={roles}
        channels={allChannels}
        readOnly
        onCancel={() => setView({ kind: "list" })}
        onSave={() => {}}
        isPending={false}
      />
    );
  }

  // ── List view ────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t("roles.title")}</h1>
          <p className="text-muted-foreground mt-1">
            {t("roles.description")}
          </p>
        </div>
        <Button
          onClick={() => setView({ kind: "create" })}
          className="shrink-0"
          data-testid="button-new-role"
        >
          <Plus size={16} className="mr-1.5" />
          {t("roles.newRole")}
        </Button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card>
          <CardContent className="p-4">
            <div className="text-2xl font-bold">{isLoading ? "—" : roles.length}</div>
            <div className="text-xs text-muted-foreground mt-0.5">Total roles</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-2xl font-bold">{summaryUsersAssigned}</div>
            <div className="text-xs text-muted-foreground mt-0.5">Users assigned</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-2xl font-bold">{isLoading ? "—" : totalEnabledPerms}</div>
            <div className="text-xs text-muted-foreground mt-0.5">Total permissions</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <div className="text-2xl font-bold">{isLoading ? "—" : channelsCovered}</div>
            <div className="text-xs text-muted-foreground mt-0.5">Channels covered</div>
          </CardContent>
        </Card>
      </div>

      {/* Search / filter / sort */}
      {!isLoading && roles.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[180px]">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-8 h-8 text-sm"
              placeholder="Search roles…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              data-testid="input-search-roles"
            />
          </div>
          {allChannels.length > 0 && (
            <Select value={filterChannelId} onValueChange={setFilterChannelId}>
              <SelectTrigger className="h-8 w-auto min-w-[11rem] text-xs" data-testid="filter-channel">
                <Filter size={12} className="mr-1.5 text-muted-foreground" />
                <SelectValue placeholder="All channels" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__" className="text-xs">All channels</SelectItem>
                {allChannels.map((c) => (
                  <SelectItem key={c.id} value={String(c.id)} className="text-xs">
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Select value={sortBy} onValueChange={(v) => setSortBy(v as typeof sortBy)}>
            <SelectTrigger className="h-8 w-auto min-w-[10rem] text-xs" data-testid="sort-roles">
              <ArrowUpDown size={12} className="mr-1.5 text-muted-foreground" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default" className="text-xs">Default order</SelectItem>
              <SelectItem value="name_asc" className="text-xs">Name A–Z</SelectItem>
              <SelectItem value="name_desc" className="text-xs">Name Z–A</SelectItem>
              <SelectItem value="perms_desc" className="text-xs">Most permissions</SelectItem>
            </SelectContent>
          </Select>
          {(search || filterChannelId !== "__all__" || sortBy !== "default") && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 text-xs gap-1"
              onClick={() => { setSearch(""); setFilterChannelId("__all__"); setSortBy("default"); }}
            >
              <X size={13} />
              Clear
            </Button>
          )}
        </div>
      )}

      {/* Roles list */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="py-12 text-center text-muted-foreground">
              {t("common.loading")}
            </div>
          ) : roles.length === 0 ? (
            <div className="py-12 text-center text-muted-foreground">
              <ShieldCheck size={32} className="mx-auto mb-3 opacity-30" />
              <p>{t("roles.noRolesYet")}</p>
              <p className="text-sm mt-1">{t("roles.noRolesCreate")}</p>
            </div>
          ) : filteredRoles.length === 0 ? (
            <div className="py-10 text-center text-muted-foreground">
              <Search size={28} className="mx-auto mb-3 opacity-30" />
              <p className="text-sm">No roles match your search.</p>
            </div>
          ) : (
            <ul className="divide-y">
              {filteredRoles.map((r) => {
                const modules = countEnabledPages(r.allowed_pages);
                const perms = countEnabledPerms(r.allowed_pages);
                return (
                  <li
                    key={r.id}
                    className="flex items-start gap-4 px-5 py-4"
                    data-testid={`role-row-${r.id}`}
                  >
                    <div className="w-9 h-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                      <ShieldCheck size={16} className="text-primary" />
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-sm">{r.name}</span>
                        {r.description && (
                          <span className="text-xs text-muted-foreground truncate max-w-[240px]">
                            {r.description}
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                          <Users size={11} />
                          {allUsersData
                            ? String(allUsersData.members.filter((m) => m.custom_role_id === r.id).length)
                            : "—"}{" "}
                          users
                        </span>
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                          <Layers size={11} />
                          {modules} modules
                        </span>
                        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                          <Hash size={11} />
                          {perms} permissions
                        </span>
                        <span className="text-xs text-muted-foreground">
                          Updated {timeAgo(r.updated_at ?? r.created_at)}
                        </span>
                      </div>

                      <div className="mt-2" data-testid={`role-channels-${r.id}`}>
                        <ChannelLogos channelIds={r.channel_ids ?? []} allChannels={allChannels} />
                      </div>
                    </div>

                    <div className="flex items-center gap-0.5 shrink-0">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        title="View role"
                        onClick={() => setView({ kind: "view", role: r })}
                        data-testid={`button-view-role-${r.id}`}
                      >
                        <Eye size={15} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        title="Edit role"
                        onClick={() => setView({ kind: "edit", role: r })}
                        data-testid={`button-edit-role-${r.id}`}
                      >
                        <Pencil size={14} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        title="Duplicate role"
                        onClick={() => duplicateMutation.mutate(r.id)}
                        disabled={duplicateMutation.isPending}
                        data-testid={`button-duplicate-role-${r.id}`}
                      >
                        <Copy size={14} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        title="Delete role"
                        onClick={() => setDeletingRole(r)}
                        data-testid={`button-delete-role-${r.id}`}
                      >
                        <Trash2 size={14} className="text-destructive" />
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* Delete dialog */}
      <Dialog
        open={deletingRole !== null}
        onOpenChange={(open) => {
          if (!open && !deleteMutation.isPending) {
            setDeletingRole(null);
            setReassignments({});
          }
        }}
      >
        <DialogContent data-testid="dialog-confirm-delete-role">
          <DialogHeader>
            <DialogTitle>Delete role?</DialogTitle>
            <DialogDescription>
              {deletingRole && affectedMembers.length === 0 && (
                <>
                  Permanently delete the <strong>{deletingRole.name}</strong>{" "}
                  role? This cannot be undone.
                </>
              )}
              {deletingRole && affectedMembers.length > 0 && (
                <>
                  <strong>{affectedMembers.length}</strong>{" "}
                  {affectedMembers.length === 1 ? "member is" : "members are"}{" "}
                  assigned to <strong>{deletingRole.name}</strong>. Reassign
                  them below, then confirm deletion.
                </>
              )}
            </DialogDescription>
          </DialogHeader>

          {affectedMembers.length > 0 && (() => {
            const rowValues = affectedMembers.map((m) =>
              m.id in reassignments
                ? reassignments[m.id] === null
                  ? "none"
                  : String(reassignments[m.id])
                : "none",
            );
            const uniqueValues = [...new Set(rowValues)];
            const bulkDisplayValue = uniqueValues.length === 1 ? uniqueValues[0] : "";
            return (
              <div className="space-y-3">
                <div className="flex items-center gap-3 pb-2 border-b">
                  <span className="flex-1 min-w-0 text-sm font-medium text-muted-foreground">
                    Move all to…
                  </span>
                  <Select
                    value={bulkDisplayValue}
                    onValueChange={(val) => {
                      const newRoleId = val === "none" ? null : parseInt(val, 10);
                      setReassignments(
                        Object.fromEntries(
                          affectedMembers.map((m) => [m.id, newRoleId]),
                        ),
                      );
                    }}
                  >
                    <SelectTrigger className="w-40 shrink-0" data-testid="select-reassign-all">
                      <SelectValue placeholder="Pick a role…" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">No role</SelectItem>
                      {roles
                        .filter((r) => r.id !== deletingRole?.id)
                        .map((r) => (
                          <SelectItem key={r.id} value={String(r.id)}>
                            {r.name}
                          </SelectItem>
                        ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2 max-h-52 overflow-y-auto pr-1">
                  {affectedMembers.map((member) => {
                    const currentValue =
                      member.id in reassignments
                        ? reassignments[member.id] === null
                          ? "none"
                          : String(reassignments[member.id])
                        : "none";
                    return (
                      <div
                        key={member.id}
                        className="flex items-center gap-3"
                        data-testid={`reassign-row-${member.id}`}
                      >
                        <span className="flex-1 min-w-0 truncate text-sm">{member.email}</span>
                        <Select
                          value={currentValue}
                          onValueChange={(val) =>
                            setReassignments((prev) => ({
                              ...prev,
                              [member.id]: val === "none" ? null : parseInt(val, 10),
                            }))
                          }
                        >
                          <SelectTrigger
                            className="w-40 shrink-0"
                            data-testid={`select-reassign-${member.id}`}
                          >
                            <SelectValue placeholder="No role" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">No role</SelectItem>
                            {roles
                              .filter((r) => r.id !== deletingRole?.id)
                              .map((r) => (
                                <SelectItem key={r.id} value={String(r.id)}>
                                  {r.name}
                                </SelectItem>
                              ))}
                          </SelectContent>
                        </Select>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })()}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setDeletingRole(null);
                setReassignments({});
              }}
              disabled={deleteMutation.isPending}
              data-testid="button-cancel-delete-role"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending || usersLoading}
              onClick={() => {
                if (deletingRole)
                  deleteMutation.mutate({
                    id: deletingRole.id,
                    members: affectedMembers,
                    memberReassignments: reassignments,
                  });
              }}
              data-testid="button-confirm-delete-role"
            >
              {deleteMutation.isPending
                ? "Deleting…"
                : affectedMembers.length > 0
                  ? "Reassign & Delete"
                  : "Delete role"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
