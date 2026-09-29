import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  CalendarOff,
  Plus,
  Edit,
  Trash2,
  Loader2,
  AlertTriangle,
  Ban,
  CheckCircle2,
} from "lucide-react";

type BlackoutDate = {
  id: number;
  name: string;
  description: string | null;
  start_date: string;
  end_date: string;
  restriction_type: string;
  employee_message: string | null;
  allow_exceptions: boolean;
  status: string;
};

const RESTRICTION_TYPE_OPTIONS = [
  { value: "warning_only", label: "Warning only", description: "Shows a warning but allows submission" },
  { value: "blocking", label: "Blocking", description: "Prevents leave requests from being submitted" },
  { value: "manager_approval", label: "Requires manager approval", description: "Requires extra approval from manager" },
];

const STATUS_OPTIONS = [
  { value: "upcoming", label: "Upcoming" },
  { value: "active", label: "Active" },
  { value: "past", label: "Past" },
  { value: "cancelled", label: "Cancelled" },
];

function restrictionIcon(type: string) {
  switch (type) {
    case "blocking": return <Ban size={13} className="text-red-500" />;
    case "manager_approval": return <CheckCircle2 size={13} className="text-blue-500" />;
    default: return <AlertTriangle size={13} className="text-amber-500" />;
  }
}

function restrictionLabel(type: string) {
  return RESTRICTION_TYPE_OPTIONS.find((o) => o.value === type)?.label ?? type;
}

function restrictionColor(type: string) {
  switch (type) {
    case "blocking": return "bg-red-100 text-red-800";
    case "manager_approval": return "bg-blue-100 text-blue-800";
    default: return "bg-amber-100 text-amber-800";
  }
}

function statusColor(status: string) {
  switch (status) {
    case "active": return "bg-emerald-100 text-emerald-800";
    case "upcoming": return "bg-blue-100 text-blue-800";
    case "past": return "bg-muted text-muted-foreground";
    case "cancelled": return "bg-red-100 text-red-700";
    default: return "bg-muted text-muted-foreground";
  }
}

function formatDate(d: string) {
  return new Date(d + "T00:00:00").toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

type FormState = {
  name: string;
  description: string;
  start_date: string;
  end_date: string;
  restriction_type: string;
  employee_message: string;
  status: string;
};

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const DEFAULT_FORM: FormState = {
  name: "",
  description: "",
  start_date: todayStr(),
  end_date: todayStr(),
  restriction_type: "warning_only",
  employee_message: "",
  status: "upcoming",
};

export default function BlackoutDatesPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { isOwner } = useWorkspaceRole();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<BlackoutDate | null>(null);
  const [form, setForm] = useState<FormState>(DEFAULT_FORM);
  const [deleteTarget, setDeleteTarget] = useState<BlackoutDate | null>(null);
  const [statusFilter, setStatusFilter] = useState("all");

  const { data, isLoading } = useQuery({
    queryKey: ["blackout-dates", { statusFilter }],
    queryFn: () => {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      return apiFetch(`/api/blackout-dates?${params}`);
    },
  });
  const items: BlackoutDate[] = (data as { blackout_dates?: BlackoutDate[] })?.blackout_dates ?? [];

  const createMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch("/api/blackout-dates", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["blackout-dates"] });
      toast({ title: "Blackout date created" });
      setDialogOpen(false);
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Record<string, unknown> }) =>
      apiFetch(`/api/blackout-dates/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["blackout-dates"] });
      toast({ title: "Blackout date updated" });
      setDialogOpen(false);
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/blackout-dates/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["blackout-dates"] });
      toast({ title: "Blackout date deleted" });
      setDeleteTarget(null);
    },
    onError: (err: Error) => toast({ title: "Error", description: err.message, variant: "destructive" }),
  });

  function openAdd() {
    setEditingItem(null);
    setForm({ ...DEFAULT_FORM, start_date: todayStr(), end_date: todayStr() });
    setDialogOpen(true);
  }

  function openEdit(item: BlackoutDate) {
    setEditingItem(item);
    setForm({
      name: item.name,
      description: item.description ?? "",
      start_date: item.start_date,
      end_date: item.end_date,
      restriction_type: item.restriction_type,
      employee_message: item.employee_message ?? "",
      status: item.status,
    });
    setDialogOpen(true);
  }

  function handleSubmit() {
    const body: Record<string, unknown> = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      start_date: form.start_date,
      end_date: form.end_date,
      restriction_type: form.restriction_type,
      employee_message: form.employee_message.trim() || null,
      status: form.status,
    };
    if (editingItem) {
      updateMutation.mutate({ id: editingItem.id, body });
    } else {
      createMutation.mutate(body);
    }
  }

  const isSaving = createMutation.isPending || updateMutation.isPending;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <CalendarOff size={22} />
            Blackout Dates
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Define date ranges when leave requests are restricted or blocked.
          </p>
        </div>
        {isOwner && (
          <Button onClick={openAdd} size="sm">
            <Plus size={16} className="mr-1" />
            Add Blackout Date
          </Button>
        )}
      </div>

      <div className="flex items-center gap-3">
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-48">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {STATUS_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <Loader2 size={20} className="animate-spin mr-2" />
              Loading…
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-2 text-muted-foreground">
              <CalendarOff size={32} className="opacity-30" />
              <p className="text-sm">No blackout dates configured.</p>
              {isOwner && (
                <Button size="sm" variant="outline" onClick={openAdd}>
                  <Plus size={14} className="mr-1" />
                  Add blackout date
                </Button>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40">
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Name</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Date Range</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden md:table-cell">Restriction</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Status</th>
                    {isOwner && <th className="px-4 py-3 w-20" />}
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.id} className="border-b last:border-0 hover:bg-muted/20 transition-colors">
                      <td className="px-4 py-3">
                        <div className="font-medium">{item.name}</div>
                        {item.description && (
                          <div className="text-xs text-muted-foreground mt-0.5 truncate max-w-xs">{item.description}</div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-sm text-muted-foreground">
                        <div>{formatDate(item.start_date)}</div>
                        {item.end_date !== item.start_date && (
                          <div>→ {formatDate(item.end_date)}</div>
                        )}
                      </td>
                      <td className="px-4 py-3 hidden md:table-cell">
                        <div className="flex items-center gap-1.5">
                          {restrictionIcon(item.restriction_type)}
                          <Badge
                            className={`text-xs py-0 h-5 font-normal ${restrictionColor(item.restriction_type)}`}
                            variant="secondary"
                          >
                            {restrictionLabel(item.restriction_type)}
                          </Badge>
                        </div>
                        {item.allow_exceptions && (
                          <div className="text-xs text-muted-foreground mt-0.5">Exceptions allowed</div>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <Badge className={`text-xs py-0 h-5 font-normal ${statusColor(item.status)}`} variant="secondary">
                          {STATUS_OPTIONS.find((o) => o.value === item.status)?.label ?? item.status}
                        </Badge>
                      </td>
                      {isOwner && (
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1 justify-end">
                            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => openEdit(item)} title="Edit">
                              <Edit size={13} />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7 text-muted-foreground"
                              onClick={() => setDeleteTarget(item)}
                              title="Delete"
                            >
                              <Trash2 size={13} />
                            </Button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Add / Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingItem ? "Edit Blackout Date" : "Add Blackout Date"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1">
              <Label>Name <span className="text-destructive">*</span></Label>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Year-End Freeze, Peak Season…"
              />
            </div>
            <div className="space-y-1">
              <Label>Description</Label>
              <Input
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="Optional description…"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Start Date <span className="text-destructive">*</span></Label>
                <Input
                  type="date"
                  value={form.start_date}
                  onChange={(e) => setForm((f) => ({ ...f, start_date: e.target.value }))}
                />
              </div>
              <div className="space-y-1">
                <Label>End Date <span className="text-destructive">*</span></Label>
                <Input
                  type="date"
                  value={form.end_date}
                  min={form.start_date}
                  onChange={(e) => setForm((f) => ({ ...f, end_date: e.target.value }))}
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label>Restriction Type</Label>
              <Select
                value={form.restriction_type}
                onValueChange={(v) => setForm((f) => ({ ...f, restriction_type: v }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {RESTRICTION_TYPE_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      <div>
                        <div className="font-medium">{o.label}</div>
                        <div className="text-xs text-muted-foreground">{o.description}</div>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Status</Label>
              <Select
                value={form.status}
                onValueChange={(v) => setForm((f) => ({ ...f, status: v }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {STATUS_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>Employee Message</Label>
              <Textarea
                value={form.employee_message}
                onChange={(e) => setForm((f) => ({ ...f, employee_message: e.target.value }))}
                placeholder="Message shown to employees when they try to book leave during this period…"
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={isSaving}>Cancel</Button>
            <Button
              onClick={handleSubmit}
              disabled={!form.name.trim() || !form.start_date || !form.end_date || isSaving}
            >
              {isSaving && <Loader2 size={14} className="animate-spin mr-1.5" />}
              {editingItem ? "Save changes" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => { if (!o) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{deleteTarget?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this blackout date period. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90"
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
