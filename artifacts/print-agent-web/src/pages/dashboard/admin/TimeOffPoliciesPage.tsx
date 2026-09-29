import { useState, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient, useQuery, useQueries } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";
import {
  useListTimeOffPolicies,
  useCreateTimeOffPolicy,
  useUpdateTimeOffPolicy,
  useDeleteTimeOffPolicy,
  useListTimeOffPolicyAssignees,
  useAdjustTimeOffBalance,
  useAssignTimeOffPolicy,
  getListTimeOffPoliciesQueryKey,
  getListTimeOffPolicyAssigneesQueryKey,
  getMemberTimeOffBalanceAdjustments,
} from "@workspace/api-client-react";
import type { TimeOffPolicy, TimeOffPolicyAssignee, TimeOffBalanceAdjustmentEntry } from "@workspace/api-client-react";
import {
  Shield,
  Plus,
  Users,
  Edit,
  UserCheck,
  Trash2,
  AlertTriangle,
  Loader2,
  CheckCircle2,
  MoreHorizontal,
  Sun,
  Heart,
  Zap,
  Clock,
  Search,
  RotateCcw,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  SlidersHorizontal,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";

type WorkspaceMember = {
  id: number;
  email: string;
  role: string;
  joined: boolean;
  first_name: string | null;
  last_name: string | null;
  image_url: string | null;
};

function memberDisplayName(m: WorkspaceMember): string {
  return [m.first_name, m.last_name].filter(Boolean).join(" ").trim() || m.email;
}

function MemberAvatar({ member, size = 28 }: { member: WorkspaceMember; size?: number }) {
  const initials = (member.first_name?.[0] ?? member.email[0] ?? "?").toUpperCase();
  if (member.image_url) {
    return (
      <img
        src={member.image_url}
        alt={memberDisplayName(member)}
        className="rounded-full object-cover shrink-0"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <div
      className="rounded-full bg-muted flex items-center justify-center shrink-0 font-semibold text-muted-foreground"
      style={{ width: size, height: size, fontSize: Math.max(10, size * 0.38) }}
    >
      {initials}
    </div>
  );
}

function InitialsAvatar({ name, email, size = 32 }: { name?: string | null; email?: string | null; size?: number }) {
  const display = name || email || "?";
  const initials = display[0].toUpperCase();
  return (
    <div
      className="rounded-full bg-primary/10 flex items-center justify-center shrink-0 font-semibold text-primary"
      style={{ width: size, height: size, fontSize: Math.max(10, size * 0.38) }}
    >
      {initials}
    </div>
  );
}

function useWorkspaceMembers(enabled = true) {
  return useQuery<{ members: WorkspaceMember[] }>({
    queryKey: ["users"],
    queryFn: () => apiFetch<{ members: WorkspaceMember[] }>("/api/users"),
    enabled,
    staleTime: 60_000,
  });
}

type BalanceStatus = "Good" | "Low" | "Negative" | "Missing";

function getBalanceStatus(val: string | number | null | undefined): BalanceStatus {
  if (val == null) return "Missing";
  const n = Number(val);
  if (isNaN(n)) return "Missing";
  if (n < 0) return "Negative";
  if (n <= 5) return "Low";
  return "Good";
}

function BalanceChip({ status }: { status: BalanceStatus }) {
  if (status === "Good") {
    return (
      <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
        Good
      </span>
    );
  }
  if (status === "Low") {
    return (
      <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-yellow-50 text-yellow-700 border border-yellow-200">
        Low
      </span>
    );
  }
  if (status === "Negative") {
    return (
      <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-red-50 text-red-700 border border-red-200">
        Negative
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-gray-100 text-gray-500 border border-gray-200">
      Missing
    </span>
  );
}

function accrualLabel(type: string) {
  if (type === "ANNUAL_GRANT") return "Annual Grant";
  if (type === "MONTHLY_ACCRUAL") return "Monthly Accrual";
  if (type === "MANUAL") return "Manual";
  return type;
}

type PolicyFormData = {
  name: string;
  description: string;
  vacation_days_per_year: number;
  sick_leave_days_per_year: number;
  accrual_type: "ANNUAL_GRANT" | "MONTHLY_ACCRUAL" | "MANUAL";
  carryover_allowed: boolean;
  max_carryover_days: number | null;
  applies_after_months_of_employment: number;
  is_active: boolean;
};

const defaultForm: PolicyFormData = {
  name: "",
  description: "",
  vacation_days_per_year: 20,
  sick_leave_days_per_year: 10,
  accrual_type: "ANNUAL_GRANT",
  carryover_allowed: false,
  max_carryover_days: null,
  applies_after_months_of_employment: 0,
  is_active: true,
};

function PolicyForm({
  initial,
  onSave,
  saving,
  onCancel,
}: {
  initial: PolicyFormData;
  onSave: (data: PolicyFormData) => void;
  saving: boolean;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<PolicyFormData>(initial);

  function set<K extends keyof PolicyFormData>(k: K, v: PolicyFormData[K]) {
    setForm((prev) => ({ ...prev, [k]: v }));
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="col-span-2 space-y-1.5">
          <Label>Policy name *</Label>
          <Input
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            placeholder="e.g. Standard Full-Time Policy"
          />
        </div>
        <div className="col-span-2 space-y-1.5">
          <Label>Description</Label>
          <Textarea
            value={form.description}
            onChange={(e) => set("description", e.target.value)}
            placeholder="Optional description…"
            rows={2}
            className="resize-none"
          />
        </div>
        <div className="space-y-1.5">
          <Label>Vacation days / year</Label>
          <Input
            type="number"
            min={0}
            max={365}
            value={form.vacation_days_per_year}
            onChange={(e) => set("vacation_days_per_year", Number(e.target.value))}
          />
        </div>
        <div className="space-y-1.5">
          <Label>Sick leave days / year</Label>
          <Input
            type="number"
            min={0}
            max={365}
            value={form.sick_leave_days_per_year}
            onChange={(e) => set("sick_leave_days_per_year", Number(e.target.value))}
          />
        </div>
        <div className="space-y-1.5">
          <Label>Accrual type</Label>
          <Select
            value={form.accrual_type}
            onValueChange={(v) => set("accrual_type", v as PolicyFormData["accrual_type"])}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ANNUAL_GRANT">Annual Grant</SelectItem>
              <SelectItem value="MONTHLY_ACCRUAL">Monthly Accrual</SelectItem>
              <SelectItem value="MANUAL">Manual</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Applies after (months employed)</Label>
          <Input
            type="number"
            min={0}
            value={form.applies_after_months_of_employment}
            onChange={(e) => set("applies_after_months_of_employment", Number(e.target.value))}
          />
        </div>
        <div className="flex items-center gap-3">
          <Switch
            id="carryover"
            checked={form.carryover_allowed}
            onCheckedChange={(v) => set("carryover_allowed", v)}
          />
          <Label htmlFor="carryover">Allow carryover</Label>
        </div>
        {form.carryover_allowed && (
          <div className="space-y-1.5">
            <Label>Max carryover days</Label>
            <Input
              type="number"
              min={0}
              value={form.max_carryover_days ?? ""}
              onChange={(e) => set("max_carryover_days", e.target.value ? Number(e.target.value) : null)}
              placeholder="No limit"
            />
          </div>
        )}
        <div className="flex items-center gap-3">
          <Switch
            id="is-active"
            checked={form.is_active}
            onCheckedChange={(v) => set("is_active", v)}
          />
          <Label htmlFor="is-active">Active</Label>
        </div>
      </div>
      <div className="flex gap-2 justify-end pt-2">
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={() => onSave(form)} disabled={saving || !form.name.trim()}>
          {saving ? "Saving…" : "Save Policy"}
        </Button>
      </div>
    </div>
  );
}

type AdjustType = "add" | "subtract" | "set";

function AdjustBalanceModal({
  open,
  onOpenChange,
  assignee,
  policyId,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  assignee: TimeOffPolicyAssignee | null;
  policyId: number;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [adjustType, setAdjustType] = useState<AdjustType>("add");
  const [adjustDays, setAdjustDays] = useState("");
  const [effectiveDate, setEffectiveDate] = useState(new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");

  function reset() {
    setAdjustType("add");
    setAdjustDays("");
    setEffectiveDate(new Date().toISOString().slice(0, 10));
    setReason("");
    setNote("");
  }

  const currentBalance = assignee?.vacation_remaining != null ? Number(assignee.vacation_remaining) : null;

  const previewBalance = useMemo(() => {
    if (currentBalance == null) return null;
    const days = Number(adjustDays);
    if (isNaN(days) || adjustDays === "") return null;
    if (adjustType === "add") return currentBalance + days;
    if (adjustType === "subtract") return currentBalance - days;
    return days;
  }, [currentBalance, adjustType, adjustDays]);

  const adjustMutation = useAdjustTimeOffBalance({
    mutation: {
      onSuccess: () => {
        toast({ title: "Balance adjusted" });
        onOpenChange(false);
        reset();
        queryClient.invalidateQueries({ queryKey: getListTimeOffPolicyAssigneesQueryKey(policyId) });
      },
      onError: (err: unknown) => {
        const msg = err instanceof Error ? err.message : "Failed to adjust balance";
        toast({ title: "Error", description: msg, variant: "destructive" });
      },
    },
  });

  function handleSave() {
    if (!assignee || !reason.trim() || adjustDays === "") return;
    const days = Number(adjustDays);
    let newBalance: number;
    if (adjustType === "add") newBalance = (currentBalance ?? 0) + days;
    else if (adjustType === "subtract") newBalance = (currentBalance ?? 0) - days;
    else newBalance = days;
    adjustMutation.mutate({
      id: policyId,
      data: {
        memberId: assignee.member_id,
        vacationEntitled: newBalance,
        adjustmentReason: note ? `${reason} — ${note}` : reason,
      },
    });
    // TODO: create adjustment audit record when audit log table is added
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Adjust Vacation Balance</DialogTitle>
          {assignee && (
            <DialogDescription>
              Adjusting balance for <strong>{assignee.member_name}</strong>
              {assignee.member_email ? ` (${assignee.member_email})` : ""}
            </DialogDescription>
          )}
        </DialogHeader>

        {assignee && (
          <div className="space-y-4 py-1">
            {currentBalance != null && (
              <div className="flex items-center justify-between rounded-lg bg-muted/50 border px-4 py-3">
                <span className="text-sm text-muted-foreground">Current balance</span>
                <span className="font-semibold text-base">{currentBalance.toFixed(1)} days</span>
              </div>
            )}

            <div className="space-y-1.5">
              <Label>Adjustment type</Label>
              <Select value={adjustType} onValueChange={(v) => setAdjustType(v as AdjustType)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="add">Add days</SelectItem>
                  <SelectItem value="subtract">Subtract days</SelectItem>
                  <SelectItem value="set">Set exact balance</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>
                {adjustType === "set" ? "New balance (days)" : "Number of days"}
              </Label>
              <Input
                type="number"
                min={adjustType === "subtract" ? undefined : 0}
                placeholder="0"
                value={adjustDays}
                onChange={(e) => setAdjustDays(e.target.value)}
              />
            </div>

            {previewBalance != null && (
              <div className="flex items-center justify-between rounded-lg bg-primary/5 border border-primary/20 px-4 py-3">
                <span className="text-sm text-muted-foreground">New balance will be</span>
                <span className={`font-semibold text-base ${previewBalance < 0 ? "text-destructive" : "text-primary"}`}>
                  {previewBalance.toFixed(1)} days
                </span>
              </div>
            )}

            <div className="space-y-1.5">
              <Label>Effective date</Label>
              <Input
                type="date"
                value={effectiveDate}
                onChange={(e) => setEffectiveDate(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <Label>Reason *</Label>
              <Textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Required — reason for this adjustment…"
                rows={2}
                className="resize-none"
              />
            </div>

            <div className="space-y-1.5">
              <Label>Note <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Any additional context…"
              />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => { onOpenChange(false); reset(); }}>
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={adjustMutation.isPending || !reason.trim() || adjustDays === ""}
          >
            {adjustMutation.isPending ? "Saving…" : "Save adjustment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EmployeesTab({
  policyId,
  onAssign,
}: {
  policyId: number;
  onAssign: () => void;
}) {
  const { data, isLoading } = useListTimeOffPolicyAssignees(policyId);
  const assignees: TimeOffPolicyAssignee[] = data?.assignees ?? [];

  const [search, setSearch] = useState("");
  const [locationFilter, setLocationFilter] = useState("all");
  const [managerFilter, setManagerFilter] = useState("all");
  const [balanceFilter, setBalanceFilter] = useState("all");
  const [adjustTarget, setAdjustTarget] = useState<TimeOffPolicyAssignee | null>(null);
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 10;

  const locations = useMemo(() => {
    const vals = [...new Set(assignees.map((a) => a.location_name).filter(Boolean))] as string[];
    return vals.sort();
  }, [assignees]);

  const managers = useMemo(() => {
    const vals = [...new Set(assignees.map((a) => a.manager_name).filter(Boolean))] as string[];
    return vals.sort();
  }, [assignees]);

  const filtered = useMemo(() => {
    let list = assignees;
    const q = search.toLowerCase().trim();
    if (q) {
      list = list.filter(
        (a) =>
          (a.member_name ?? "").toLowerCase().includes(q) ||
          (a.member_email ?? "").toLowerCase().includes(q),
      );
    }
    if (locationFilter !== "all") {
      list = list.filter((a) => a.location_name === locationFilter);
    }
    if (managerFilter !== "all") {
      list = list.filter((a) => a.manager_name === managerFilter);
    }
    if (balanceFilter !== "all") {
      list = list.filter((a) => getBalanceStatus(a.vacation_remaining) === balanceFilter);
    }
    return list;
  }, [assignees, search, locationFilter, managerFilter, balanceFilter]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const paged = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  function resetFilters() {
    setSearch("");
    setLocationFilter("all");
    setManagerFilter("all");
    setBalanceFilter("all");
    setPage(1);
  }

  const hasFilters = search !== "" || locationFilter !== "all" || managerFilter !== "all" || balanceFilter !== "all";

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-8 justify-center text-muted-foreground text-sm">
        <Loader2 size={16} className="animate-spin" />
        Loading employees…
      </div>
    );
  }

  if (assignees.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 py-12 text-center">
        <div className="rounded-full bg-muted p-4">
          <Users size={28} className="text-muted-foreground" />
        </div>
        <p className="font-medium text-sm">No employees assigned yet</p>
        <p className="text-sm text-muted-foreground max-w-xs">
          Time-off requests and balances can exist independently of a policy
          assignment. Assign this policy to team members so their leave
          entitlements are tracked here.
        </p>
        <Button size="sm" className="mt-1 gap-1.5" onClick={onAssign}>
          <UserCheck size={14} />
          Assign Employees
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 items-center">
        <div className="relative flex-1 min-w-[180px]">
          <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-8 h-8 text-sm"
            placeholder="Search employees…"
            value={search}
            onChange={(e) => { setSearch(e.target.value); setPage(1); }}
          />
        </div>
        <Select value={locationFilter} onValueChange={(v) => { setLocationFilter(v); setPage(1); }}>
          <SelectTrigger className="h-8 text-xs w-[140px]">
            <SelectValue placeholder="All Locations" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Locations</SelectItem>
            {locations.map((l) => (
              <SelectItem key={l} value={l}>{l}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={managerFilter} onValueChange={(v) => { setManagerFilter(v); setPage(1); }}>
          <SelectTrigger className="h-8 text-xs w-[140px]">
            <SelectValue placeholder="All Managers" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Managers</SelectItem>
            {managers.map((m) => (
              <SelectItem key={m} value={m}>{m}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={balanceFilter} onValueChange={(v) => { setBalanceFilter(v); setPage(1); }}>
          <SelectTrigger className="h-8 text-xs w-[140px]">
            <SelectValue placeholder="All Statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Statuses</SelectItem>
            <SelectItem value="Good">Good</SelectItem>
            <SelectItem value="Low">Low</SelectItem>
            <SelectItem value="Negative">Negative</SelectItem>
            <SelectItem value="Missing">Missing</SelectItem>
          </SelectContent>
        </Select>
        {hasFilters && (
          <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-xs" onClick={resetFilters}>
            <RotateCcw size={12} />
            Reset
          </Button>
        )}
      </div>

      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/30 border-b text-left">
              <th className="px-3 py-2.5 text-xs font-medium text-muted-foreground">Employee</th>
              <th className="px-3 py-2.5 text-xs font-medium text-muted-foreground">Manager</th>
              <th className="px-3 py-2.5 text-xs font-medium text-muted-foreground">Location</th>
              <th className="px-3 py-2.5 text-xs font-medium text-muted-foreground">Vacation Balance</th>
              <th className="px-3 py-2.5 text-xs font-medium text-muted-foreground">Effective Date</th>
              <th className="px-3 py-2.5 text-xs font-medium text-muted-foreground">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {paged.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-sm text-muted-foreground">
                  No employees match the current filters.
                </td>
              </tr>
            ) : (
              paged.map((a) => {
                const balStatus = getBalanceStatus(a.vacation_remaining);
                const hasMissingManager = !a.manager_name;
                const hasMissingLocation = !a.location_name;
                const hasMissingDate = !a.effective_from;
                const hasWarning =
                  hasMissingManager ||
                  hasMissingLocation ||
                  hasMissingDate ||
                  balStatus === "Negative" ||
                  balStatus === "Low";

                const warningText = [
                  hasMissingManager && "Manager not assigned",
                  hasMissingLocation && "Location not assigned",
                  hasMissingDate && "No effective date",
                  balStatus === "Negative" && "Negative balance",
                  balStatus === "Low" && "Low balance",
                ]
                  .filter(Boolean)
                  .join("; ");

                return (
                  <tr key={a.member_id} className="hover:bg-muted/20 transition-colors">
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2.5">
                        {a.member_image_url ? (
                          <img
                            src={a.member_image_url}
                            alt={a.member_name}
                            className="rounded-full object-cover shrink-0"
                            style={{ width: 32, height: 32 }}
                          />
                        ) : (
                          <InitialsAvatar name={a.member_name} email={a.member_email} size={32} />
                        )}
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="font-medium text-sm leading-tight truncate max-w-[140px]">
                              {a.member_name ?? "—"}
                            </span>
                            {hasWarning && (
                              <span title={warningText}>
                                <AlertTriangle size={12} className="text-amber-500 shrink-0" aria-label={warningText} />
                              </span>
                            )}
                          </div>
                          <div className="text-xs text-muted-foreground truncate max-w-[180px]">
                            {a.member_email ?? ""}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-sm text-muted-foreground">
                      {a.manager_name ?? (
                        <span className="text-muted-foreground/50">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-sm text-muted-foreground">
                      {a.location_name ?? (
                        <span className="text-muted-foreground/50">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <span className={`text-sm font-medium ${balStatus === "Negative" ? "text-destructive" : ""}`}>
                          {a.vacation_remaining != null
                            ? `${Number(a.vacation_remaining).toFixed(1)} days`
                            : "—"}
                        </span>
                        <BalanceChip status={balStatus} />
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-sm text-muted-foreground">
                      {a.effective_from
                        ? new Date(a.effective_from + "T00:00:00").toLocaleDateString(undefined, {
                            year: "numeric",
                            month: "short",
                            day: "numeric",
                          })
                        : <span className="text-muted-foreground/50">—</span>}
                    </td>
                    <td className="px-3 py-2.5">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2.5 text-xs gap-1"
                        onClick={() => setAdjustTarget(a)}
                      >
                        <Edit size={11} />
                        Adjust balance
                      </Button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {filtered.length > PAGE_SIZE && (
        <div className="flex items-center justify-between text-xs text-muted-foreground pt-1">
          <span>
            Showing {((currentPage - 1) * PAGE_SIZE) + 1}–{Math.min(currentPage * PAGE_SIZE, filtered.length)} of {filtered.length} employees
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              disabled={currentPage === 1}
              onClick={() => setPage((p) => p - 1)}
            >
              <ChevronLeft size={13} />
            </Button>
            <span className="px-2 py-0.5 rounded bg-muted font-medium">{currentPage}</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0"
              disabled={currentPage >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              <ChevronRight size={13} />
            </Button>
          </div>
        </div>
      )}

      <AdjustBalanceModal
        open={!!adjustTarget}
        onOpenChange={(v) => !v && setAdjustTarget(null)}
        assignee={adjustTarget}
        policyId={policyId}
      />
    </div>
  );
}

function OverviewTab({ policy }: { policy: TimeOffPolicy }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 py-2">
      {policy.description && (
        <div className="sm:col-span-2">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Description</p>
          <p className="text-sm">{policy.description}</p>
        </div>
      )}
      <div>
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Accrual Type</p>
        <p className="text-sm font-medium">{accrualLabel(policy.accrual_type ?? "ANNUAL_GRANT")}</p>
      </div>
      <div>
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Carryover</p>
        <p className="text-sm font-medium">
          {policy.carryover_allowed
            ? policy.max_carryover_days != null
              ? `Allowed (max ${policy.max_carryover_days} days)`
              : "Allowed (no limit)"
            : "Not allowed"}
        </p>
      </div>
      <div>
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Employment Requirement</p>
        <p className="text-sm font-medium">
          {Number(policy.applies_after_months_of_employment ?? 0) === 0
            ? "Immediate"
            : `After ${policy.applies_after_months_of_employment} month${Number(policy.applies_after_months_of_employment) === 1 ? "" : "s"}`}
        </p>
      </div>
      <div>
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-1">Status</p>
        <p className="text-sm font-medium">{policy.is_active ? "Active" : "Inactive"}</p>
      </div>
    </div>
  );
}

type AdjustmentWithMember = TimeOffBalanceAdjustmentEntry & { member_name: string };

export function AdjustmentsTab({ policyId }: { policyId: number }) {
  const { data: assigneesData, isLoading: assigneesLoading } = useListTimeOffPolicyAssignees(policyId);
  const assignees = assigneesData?.assignees ?? [];

  const adjustmentQueries = useQueries({
    queries: assignees.map((a) => ({
      queryKey: [`/api/time-off/members/${a.member_id}/balance/adjustments`],
      queryFn: () => getMemberTimeOffBalanceAdjustments(a.member_id),
    })),
  });

  const isLoading = assigneesLoading || (assignees.length > 0 && adjustmentQueries.some((q) => q.isLoading));

  const allAdjustments: AdjustmentWithMember[] = [];
  assignees.forEach((assignee, i) => {
    const q = adjustmentQueries[i];
    if (q?.data?.adjustments) {
      for (const adj of q.data.adjustments) {
        allAdjustments.push({
          ...adj,
          member_name: assignee.member_name ?? assignee.member_email ?? "Unknown",
        });
      }
    }
  });
  allAdjustments.sort((a, b) => new Date(b.adjusted_at).getTime() - new Date(a.adjusted_at).getTime());

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-8 justify-center text-muted-foreground text-sm">
        <Loader2 size={16} className="animate-spin" />
        Loading adjustments…
      </div>
    );
  }

  if (allAdjustments.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 py-12 text-center">
        <div className="rounded-full bg-muted p-4">
          <ClipboardList size={28} className="text-muted-foreground" />
        </div>
        <p className="font-medium text-sm">No adjustments yet</p>
        <p className="text-sm text-muted-foreground max-w-xs">
          Balance adjustment history will appear here once employees have been adjusted.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <p className="text-xs text-muted-foreground flex items-center gap-1.5 mb-2">
        <SlidersHorizontal size={12} />
        {allAdjustments.length} adjustment{allAdjustments.length === 1 ? "" : "s"} across all members
      </p>
      <div className="divide-y divide-border rounded-md border overflow-hidden">
        {allAdjustments.map((adj) => {
          const delta = Number(adj.amount_changed);
          const isPositive = delta > 0;
          const isNegative = delta < 0;
          return (
            <div key={adj.id} className="flex items-start gap-3 px-4 py-3 hover:bg-muted/30 transition-colors">
              <InitialsAvatar name={adj.member_name} size={32} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium">{adj.member_name}</span>
                  <span className="text-sm text-muted-foreground">
                    {Number(adj.vacation_entitled_before).toFixed(0)} → {Number(adj.vacation_entitled_after).toFixed(0)} days
                    <span className="ml-1 text-xs text-muted-foreground/70">({adj.policy_year})</span>
                  </span>
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
                {adj.reason && (
                  <p className="text-xs text-muted-foreground mt-0.5 italic">&ldquo;{adj.reason}&rdquo;</p>
                )}
                <p className="text-xs text-muted-foreground mt-0.5">
                  Adjusted by {adj.adjusted_by_name}
                </p>
              </div>
              <span className="text-xs text-muted-foreground whitespace-nowrap shrink-0">
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
    </div>
  );
}

function PolicyCard({
  policy,
  assigneeCount,
}: {
  policy: TimeOffPolicy;
  assigneeCount: number;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const deleteMutation = useDeleteTimeOffPolicy({
    mutation: {
      onSuccess: () => {
        toast({ title: "Time-off policy deleted." });
        setDeleteOpen(false);
        queryClient.invalidateQueries({ queryKey: getListTimeOffPoliciesQueryKey() });
      },
      onError: (err: unknown) => {
        const msg = err instanceof Error ? err.message : "";
        if (msg.toLowerCase().includes("assigned")) {
          toast({
            title: "Cannot delete policy",
            description: "This policy is assigned to employees and cannot be deleted until they are reassigned.",
            variant: "destructive",
          });
        } else {
          toast({
            title: "Could not delete time-off policy. Please try again.",
            variant: "destructive",
          });
        }
        setDeleteOpen(false);
      },
    },
  });

  const updateMutation = useUpdateTimeOffPolicy({
    mutation: {
      onSuccess: () => {
        toast({ title: "Policy updated" });
        setEditOpen(false);
        queryClient.invalidateQueries({ queryKey: getListTimeOffPoliciesQueryKey() });
      },
      onError: (err: unknown) => {
        const msg = err instanceof Error ? err.message : "Failed to update policy";
        toast({ title: "Error", description: msg, variant: "destructive" });
      },
    },
  });

  const [assignScope, setAssignScope] = useState<"all" | "specific_user">("all");
  const [selectedUserId, setSelectedUserId] = useState<number | null>(null);
  const [userSearch, setUserSearch] = useState("");

  const membersQuery = useWorkspaceMembers(assignOpen && assignScope === "specific_user");
  const joinedMembers = useMemo(
    () => (membersQuery.data?.members ?? []).filter((m) => m.joined),
    [membersQuery.data],
  );

  const assigneesQuery = useListTimeOffPolicyAssignees(policy.id, {
    query: { queryKey: getListTimeOffPolicyAssigneesQueryKey(policy.id), enabled: assignOpen },
  });
  const assignedMemberIds = useMemo<Set<number>>(() => {
    const rows = assigneesQuery.data?.assignees ?? [];
    return new Set(rows.map((r) => r.member_id));
  }, [assigneesQuery.data]);

  const filteredMembers = useMemo(() => {
    const q = userSearch.toLowerCase().trim();
    if (!q) return joinedMembers;
    return joinedMembers.filter(
      (m) =>
        m.email.toLowerCase().includes(q) ||
        (m.first_name ?? "").toLowerCase().includes(q) ||
        (m.last_name ?? "").toLowerCase().includes(q),
    );
  }, [joinedMembers, userSearch]);

  const selectedMember = useMemo(
    () => joinedMembers.find((m) => m.id === selectedUserId) ?? null,
    [joinedMembers, selectedUserId],
  );

  const memberPolicyCheckQuery = useQuery<{ assigned: boolean; policyName: string | null }>({
    queryKey: ["member-policy-check", selectedUserId],
    queryFn: () =>
      apiFetch<{ assigned: boolean; policyName: string | null }>(
        `/api/time-off/member-policy-check?userId=${selectedUserId}`,
      ),
    enabled: assignOpen && assignScope === "specific_user" && selectedUserId !== null,
    staleTime: 0,
  });
  const selectedAlreadyAssigned =
    selectedUserId !== null && memberPolicyCheckQuery.data?.assigned === true;

  function resetAssignDialog() {
    setAssignScope("all");
    setSelectedUserId(null);
    setUserSearch("");
  }

  const assignMutation = useAssignTimeOffPolicy({
    mutation: {
      onSuccess: (data: unknown) => {
        const result = data as { ok: boolean; emailSent?: boolean } | undefined;
        toast({ title: "Policy assigned successfully" });
        if (result?.emailSent === false) {
          toast({
            title: "Email notification could not be sent",
            description: "The policy was assigned, but the email notification to the member failed to send.",
            variant: "destructive",
          });
        }
        setAssignOpen(false);
        resetAssignDialog();
        queryClient.invalidateQueries({ queryKey: getListTimeOffPolicyAssigneesQueryKey(policy.id) });
      },
      onError: (err: unknown) => {
        const msg = err instanceof Error ? err.message : "Failed to assign policy";
        toast({ title: "Error", description: msg, variant: "destructive" });
      },
    },
  });

  return (
    <Card className="shadow-sm overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex flex-col sm:flex-row sm:items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <CardTitle className="text-base font-semibold">{policy.name}</CardTitle>
              {policy.is_active ? (
                <Badge className="bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-50 text-xs font-medium">
                  Active
                </Badge>
              ) : (
                <Badge variant="secondary" className="text-muted-foreground text-xs">
                  Inactive
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-2 mt-2 flex-wrap">
              <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 text-blue-700 border border-blue-200 px-2.5 py-0.5 text-xs font-medium">
                <Sun size={11} />
                Annual Leave: {policy.vacation_days_per_year ?? 0} days/yr
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-purple-50 text-purple-700 border border-purple-200 px-2.5 py-0.5 text-xs font-medium">
                <Heart size={11} />
                Sick Leave: {policy.sick_leave_days_per_year ?? 0} days/yr
              </span>
              <span className="inline-flex items-center gap-1 rounded-full bg-gray-100 text-gray-700 border border-gray-200 px-2.5 py-0.5 text-xs font-medium">
                <Zap size={11} />
                Grant Type: {accrualLabel(policy.accrual_type ?? "ANNUAL_GRANT")}
              </span>
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <Users size={12} />
                {assigneeCount} {assigneeCount === 1 ? "employee" : "employees"} assigned
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button
              size="sm"
              variant="outline"
              className="h-8 px-3 text-xs gap-1.5"
              onClick={() => setEditOpen(true)}
            >
              <Edit size={12} />
              Edit Policy
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-8 px-3 text-xs gap-1.5"
              onClick={() => setAssignOpen(true)}
            >
              <UserCheck size={12} />
              Assign Employees
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" className="h-8 w-8 p-0">
                  <MoreHorizontal size={14} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  className="text-destructive focus:text-destructive gap-2"
                  onClick={() => setDeleteOpen(true)}
                >
                  <Trash2 size={13} />
                  Delete policy
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </CardHeader>

      <CardContent className="pt-0">
        <Tabs defaultValue="employees">
          <TabsList className="h-8 text-xs mb-3">
            <TabsTrigger value="overview" className="text-xs px-3 py-1">Overview</TabsTrigger>
            <TabsTrigger value="employees" className="text-xs px-3 py-1">Employees</TabsTrigger>
            <TabsTrigger value="adjustments" className="text-xs px-3 py-1">Adjustments</TabsTrigger>
          </TabsList>

          <TabsContent value="overview">
            <OverviewTab policy={policy} />
          </TabsContent>

          <TabsContent value="employees">
            <EmployeesTab policyId={policy.id} onAssign={() => setAssignOpen(true)} />
          </TabsContent>

          <TabsContent value="adjustments">
            <AdjustmentsTab policyId={policy.id} />
          </TabsContent>
        </Tabs>
      </CardContent>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Policy</DialogTitle>
          </DialogHeader>
          <PolicyForm
            initial={{
              name: policy.name,
              description: policy.description ?? "",
              vacation_days_per_year: Number(policy.vacation_days_per_year),
              sick_leave_days_per_year: Number(policy.sick_leave_days_per_year ?? 10),
              accrual_type: (policy.accrual_type ?? "ANNUAL_GRANT") as PolicyFormData["accrual_type"],
              carryover_allowed: policy.carryover_allowed ?? false,
              max_carryover_days: policy.max_carryover_days != null ? Number(policy.max_carryover_days) : null,
              applies_after_months_of_employment: Number(policy.applies_after_months_of_employment ?? 0),
              is_active: policy.is_active ?? true,
            }}
            onSave={(data) => {
              updateMutation.mutate({
                id: policy.id,
                data: {
                  name: data.name,
                  description: data.description || null,
                  vacation_days_per_year: data.vacation_days_per_year,
                  sick_leave_days_per_year: data.sick_leave_days_per_year,
                  accrual_type: data.accrual_type,
                  carryover_allowed: data.carryover_allowed,
                  max_carryover_days: data.carryover_allowed ? (data.max_carryover_days ?? null) : null,
                  applies_after_months_of_employment: data.applies_after_months_of_employment,
                  is_active: data.is_active,
                },
              });
            }}
            saving={updateMutation.isPending}
            onCancel={() => setEditOpen(false)}
          />
        </DialogContent>
      </Dialog>

      <Dialog
        open={assignOpen}
        onOpenChange={(open) => {
          setAssignOpen(open);
          if (!open) resetAssignDialog();
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Assign Policy</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-sm text-muted-foreground">
              Assign <strong>{policy.name}</strong> to team members. This will update their leave balance for the current year.
            </p>
            <div className="space-y-1.5">
              <Label>Scope</Label>
              <Select
                value={assignScope}
                onValueChange={(v) => {
                  setAssignScope(v as "all" | "specific_user");
                  setSelectedUserId(null);
                  setUserSearch("");
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All workspace members</SelectItem>
                  <SelectItem value="specific_user">Specific user</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {assignScope === "specific_user" && (
              <div className="space-y-2">
                <Label>Select member</Label>
                {membersQuery.isLoading ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                    <Loader2 size={14} className="animate-spin" />
                    Loading members…
                  </div>
                ) : (
                  <>
                    <Input
                      placeholder="Search by name or email…"
                      value={userSearch}
                      onChange={(e) => setUserSearch(e.target.value)}
                      className="text-sm"
                    />
                    <div className="border rounded-md max-h-44 overflow-y-auto">
                      {filteredMembers.length === 0 ? (
                        <p className="text-xs text-muted-foreground p-3 text-center">
                          {userSearch ? "No members match your search." : "No joined members found."}
                        </p>
                      ) : (
                        filteredMembers.map((m) => {
                          const alreadyAssigned = assignedMemberIds.has(m.id);
                          return (
                            <button
                              key={m.id}
                              type="button"
                              className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors text-sm border-b last:border-b-0 ${alreadyAssigned ? "opacity-50 cursor-not-allowed" : `hover:bg-muted/50 ${selectedUserId === m.id ? "bg-muted" : ""}`}`}
                              onClick={() => {
                                if (alreadyAssigned) return;
                                setSelectedUserId(m.id === selectedUserId ? null : m.id);
                              }}
                            >
                              <MemberAvatar member={m} size={28} />
                              <div className="flex-1 min-w-0">
                                <div className="font-medium truncate leading-tight">
                                  {memberDisplayName(m)}
                                </div>
                                <div className="text-xs text-muted-foreground truncate">{m.email}</div>
                              </div>
                              {alreadyAssigned ? (
                                <span className="shrink-0 inline-flex items-center gap-1 rounded-full border border-emerald-300 bg-emerald-50 px-2 py-0.5 text-xs font-medium text-emerald-700">
                                  <CheckCircle2 size={11} />
                                  Already assigned
                                </span>
                              ) : selectedUserId === m.id ? (
                                <div className="shrink-0 w-4 h-4 rounded-full bg-primary flex items-center justify-center">
                                  <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                                    <path d="M1.5 4L3 5.5L6.5 2" stroke="white" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                                  </svg>
                                </div>
                              ) : null}
                            </button>
                          );
                        })
                      )}
                    </div>
                  </>
                )}

                {selectedAlreadyAssigned && selectedMember && (
                  <div className="flex items-start gap-2 rounded-md border border-yellow-300 bg-yellow-50 px-3 py-2">
                    <AlertTriangle size={14} className="text-yellow-600 mt-0.5 shrink-0" />
                    <p className="text-xs text-yellow-800">
                      {memberDisplayName(selectedMember)} already has a leave policy assigned for this year
                      {memberPolicyCheckQuery.data?.policyName
                        ? `: "${memberPolicyCheckQuery.data.policyName}".`
                        : "."}
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setAssignOpen(false);
                resetAssignDialog();
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (assignScope === "specific_user") {
                  if (!selectedUserId) return;
                  assignMutation.mutate({
                    id: policy.id,
                    data: {
                      scope: "specific_user",
                      userId: selectedUserId,
                      effectiveFrom: new Date().toISOString().slice(0, 10),
                    },
                  });
                } else {
                  assignMutation.mutate({
                    id: policy.id,
                    data: {
                      scope: assignScope,
                      effectiveFrom: new Date().toISOString().slice(0, 10),
                    },
                  });
                }
              }}
              disabled={
                assignMutation.isPending ||
                (assignScope === "specific_user" &&
                  (!selectedUserId ||
                    selectedAlreadyAssigned ||
                    (selectedUserId !== null && assignedMemberIds.has(selectedUserId))))
              }
            >
              {assignMutation.isPending ? (
                <>
                  <Loader2 size={13} className="animate-spin mr-1.5" />
                  Assigning…
                </>
              ) : (
                "Assign"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteOpen}
        onOpenChange={(open) => !deleteMutation.isPending && setDeleteOpen(open)}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete time-off policy?</DialogTitle>
            <DialogDescription>
              This will permanently delete this policy. Employees assigned to this policy may lose this policy assignment. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteOpen(false)} disabled={deleteMutation.isPending}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteMutation.mutate({ id: policy.id })}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete policy"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function SummaryCards({ policies }: { policies: TimeOffPolicy[] }) {
  const membersQuery = useWorkspaceMembers(policies.length > 0);
  const joinedTotal = useMemo(
    () => (membersQuery.data?.members ?? []).filter((m) => m.joined).length,
    [membersQuery.data],
  );

  const assigneeQueries = useQueries({
    queries: policies.map((p) => ({
      queryKey: getListTimeOffPolicyAssigneesQueryKey(p.id),
      queryFn: () =>
        apiFetch<{ assignees: TimeOffPolicyAssignee[] }>(`/api/time-off/policies/${p.id}/assignees`),
      staleTime: 60_000,
    })),
  });

  const allLoaded = assigneeQueries.every((q) => q.isSuccess);

  const { totalAssigned, uniqueAssignedIds, pendingAdjustments } = useMemo(() => {
    if (!allLoaded) return { totalAssigned: 0, uniqueAssignedIds: new Set<number>(), pendingAdjustments: 0 };
    const ids = new Set<number>();
    let pending = 0;
    for (const q of assigneeQueries) {
      const assignees = (q.data as { assignees: TimeOffPolicyAssignee[] } | undefined)?.assignees ?? [];
      for (const a of assignees) {
        ids.add(a.member_id);
        const bal = getBalanceStatus(a.vacation_remaining);
        if (bal === "Negative" || bal === "Low") pending++;
      }
    }
    return { totalAssigned: ids.size, uniqueAssignedIds: ids, pendingAdjustments: pending };
  }, [allLoaded, assigneeQueries]);

  const activePolicies = policies.filter((p) => p.is_active).length;
  const unassigned = Math.max(0, joinedTotal - uniqueAssignedIds.size);
  const assignedPercent = joinedTotal > 0 ? Math.round((totalAssigned / joinedTotal) * 100) : 0;
  const unassignedPercent = joinedTotal > 0 ? Math.round((unassigned / joinedTotal) * 100) : 0;

  const cards = [
    {
      icon: <Shield size={22} className="text-blue-600" />,
      iconBg: "bg-blue-50",
      value: activePolicies,
      label: "Active Policies",
      sub: "Across all locations",
    },
    {
      icon: <Users size={22} className="text-indigo-600" />,
      iconBg: "bg-indigo-50",
      value: allLoaded ? totalAssigned : "—",
      label: "Employees Assigned",
      sub: allLoaded && joinedTotal > 0 ? `${assignedPercent}% of total employees` : "Loading…",
    },
    {
      icon: <UserCheck size={22} className="text-pink-600" />,
      iconBg: "bg-pink-50",
      value: allLoaded && membersQuery.isSuccess ? unassigned : "—",
      label: "Unassigned Employees",
      sub:
        allLoaded && membersQuery.isSuccess && joinedTotal > 0
          ? `${unassignedPercent}% of total employees`
          : "Loading…",
    },
    {
      icon: <Clock size={22} className="text-amber-600" />,
      iconBg: "bg-amber-50",
      value: allLoaded ? pendingAdjustments : "—",
      label: "Pending Adjustments",
      sub: pendingAdjustments > 0 ? "Require attention" : "All balances healthy",
      subClassName: pendingAdjustments > 0 ? "text-amber-600" : undefined,
    },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {cards.map((c) => (
        <Card key={c.label} className="shadow-sm">
          <CardContent className="p-4 flex items-start gap-3">
            <div className={`rounded-xl p-2.5 shrink-0 ${c.iconBg}`}>{c.icon}</div>
            <div className="min-w-0">
              <p className="text-2xl font-bold leading-tight">{c.value}</p>
              <p className="text-sm font-medium mt-0.5">{c.label}</p>
              <p className={`text-xs mt-0.5 ${c.subClassName ?? "text-muted-foreground"}`}>{c.sub}</p>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export default function TimeOffPoliciesPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useListTimeOffPolicies();
  const policies: TimeOffPolicy[] = data?.policies ?? [];

  const [createOpen, setCreateOpen] = useState(false);

  const createMutation = useCreateTimeOffPolicy({
    mutation: {
      onSuccess: () => {
        toast({ title: "Policy created" });
        setCreateOpen(false);
        queryClient.invalidateQueries({ queryKey: getListTimeOffPoliciesQueryKey() });
      },
      onError: (err: unknown) => {
        const msg = err instanceof Error ? err.message : "Failed to create policy";
        toast({ title: "Error", description: msg, variant: "destructive" });
      },
    },
  });

  const assigneeCounts = useQueries({
    queries: policies.map((p) => ({
      queryKey: getListTimeOffPolicyAssigneesQueryKey(p.id),
      queryFn: () =>
        apiFetch<{ assignees: TimeOffPolicyAssignee[] }>(`/api/time-off/policies/${p.id}/assignees`),
      staleTime: 60_000,
    })),
  });

  const countByPolicyId = useMemo(() => {
    const map = new Map<number, number>();
    policies.forEach((p, i) => {
      const q = assigneeCounts[i];
      const assignees = (q?.data as { assignees: TimeOffPolicyAssignee[] } | undefined)?.assignees ?? [];
      map.set(p.id, assignees.length);
    });
    return map;
  }, [policies, assigneeCounts]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <nav className="flex items-center gap-1.5 text-xs text-muted-foreground mb-2">
            <span>People &amp; Time Off</span>
            <ChevronRight size={12} />
            <span className="text-foreground font-medium">Leave Policies</span>
          </nav>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Shield size={22} />
            Time-Off Policies
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Manage leave policies and assign them to employees.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)} className="gap-2 shrink-0">
          <Plus size={15} />
          New Policy
        </Button>
      </div>

      {!isLoading && !error && policies.length > 0 && (
        <SummaryCards policies={policies} />
      )}

      {isLoading && (
        <div className="text-center py-12 text-muted-foreground">Loading policies…</div>
      )}
      {error && (
        <div className="text-center py-12 text-destructive">Failed to load policies</div>
      )}
      {!isLoading && !error && policies.length === 0 && (
        <Card>
          <CardContent className="py-12 flex flex-col items-center gap-3 text-muted-foreground">
            <Shield size={36} />
            <p className="font-medium">No policies yet</p>
            <p className="text-sm">Create your first time-off policy to start managing leave entitlements.</p>
            <Button onClick={() => setCreateOpen(true)} className="gap-2 mt-1">
              <Plus size={14} />
              Create Policy
            </Button>
          </CardContent>
        </Card>
      )}

      {!isLoading && policies.length > 0 && (
        <div className="space-y-4">
          {policies.map((p) => (
            <PolicyCard key={p.id} policy={p} assigneeCount={countByPolicyId.get(p.id) ?? 0} />
          ))}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Create Policy</DialogTitle>
          </DialogHeader>
          <PolicyForm
            initial={defaultForm}
            onSave={(data) => {
              createMutation.mutate({
                data: {
                  name: data.name,
                  description: data.description || null,
                  vacation_days_per_year: data.vacation_days_per_year,
                  sick_leave_days_per_year: data.sick_leave_days_per_year,
                  accrual_type: data.accrual_type,
                  carryover_allowed: data.carryover_allowed,
                  max_carryover_days: data.carryover_allowed ? (data.max_carryover_days ?? null) : null,
                  applies_after_months_of_employment: data.applies_after_months_of_employment,
                  is_active: data.is_active,
                },
              });
            }}
            saving={createMutation.isPending}
            onCancel={() => setCreateOpen(false)}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
