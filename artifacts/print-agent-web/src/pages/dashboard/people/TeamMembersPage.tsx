import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { getCountries, type Country } from "react-phone-number-input";
import { PhoneInputField } from "@/components/PhoneInputField";
import { isExcludedCountry } from "@/lib/countries";
import { apiFetch } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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
  UserCheck,
  Plus,
  Search,
  Edit,
  Archive,
  Loader2,
  Building2,
  BriefcaseBusiness,
  Mail,
  Phone,
} from "lucide-react";

const ALLOWED_COUNTRIES: Country[] = getCountries().filter(
  (c) => !isExcludedCountry(c),
);

type Department = {
  id: number;
  name: string;
  status: string;
};

type TeamMember = {
  id: number;
  first_name: string;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  job_title: string | null;
  department_id: number | null;
  department_name: string | null;
  employment_status: string;
  start_date: string | null;
  archived_at: string | null;
  image_url: string | null;
};

function MemberAvatar({ member }: { member: TeamMember }) {
  const initials = (member.first_name.charAt(0) + (member.last_name?.charAt(0) ?? "")).toUpperCase();
  return (
    <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center text-xs font-medium shrink-0 overflow-hidden">
      {member.image_url ? (
        <img
          src={member.image_url}
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

const EMPLOYMENT_STATUS_OPTIONS = [
  { value: "full_time", label: "Full Time" },
  { value: "part_time", label: "Part Time" },
  { value: "contractor", label: "Contractor" },
  { value: "intern", label: "Intern" },
  { value: "temporary", label: "Temporary" },
];

function employmentStatusLabel(status: string) {
  return EMPLOYMENT_STATUS_OPTIONS.find((o) => o.value === status)?.label ?? status;
}

function employmentStatusColor(status: string) {
  switch (status) {
    case "full_time": return "bg-emerald-100 text-emerald-800";
    case "part_time": return "bg-blue-100 text-blue-800";
    case "contractor": return "bg-purple-100 text-purple-800";
    case "intern": return "bg-amber-100 text-amber-800";
    default: return "bg-muted text-muted-foreground";
  }
}

type MemberFormState = {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  job_title: string;
  department_id: string;
  employment_status: string;
  start_date: string;
  notes: string;
};

const DEFAULT_FORM: MemberFormState = {
  first_name: "",
  last_name: "",
  email: "",
  phone: "",
  job_title: "",
  department_id: "none",
  employment_status: "full_time",
  start_date: "",
  notes: "",
};

export default function TeamMembersPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { isOwner } = useWorkspaceRole();

  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingMember, setEditingMember] = useState<TeamMember | null>(null);
  const [form, setForm] = useState<MemberFormState>(DEFAULT_FORM);
  const [archiveTarget, setArchiveTarget] = useState<TeamMember | null>(null);

  const { data: depsData } = useQuery({
    queryKey: ["departments"],
    queryFn: () => apiFetch("/api/departments"),
  });
  const departments: Department[] = (depsData as { departments?: Department[] })?.departments ?? [];

  const { data, isLoading } = useQuery({
    queryKey: ["team-members", { q: search, showArchived }],
    queryFn: () => {
      const params = new URLSearchParams();
      if (search) params.set("q", search);
      if (showArchived) params.set("include_archived", "true");
      return apiFetch(`/api/team-members?${params}`);
    },
  });
  const members: TeamMember[] = (data as { team_members?: TeamMember[] })?.team_members ?? [];

  const createMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch("/api/team-members", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["team-members"] });
      toast({ title: "Team member added" });
      setDialogOpen(false);
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Record<string, unknown> }) =>
      apiFetch(`/api/team-members/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["team-members"] });
      toast({ title: "Team member updated" });
      setDialogOpen(false);
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const archiveMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/api/team-members/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["team-members"] });
      toast({ title: "Team member archived" });
      setArchiveTarget(null);
    },
    onError: (err: Error) => {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  function openAdd() {
    setEditingMember(null);
    setForm(DEFAULT_FORM);
    setDialogOpen(true);
  }

  function openEdit(m: TeamMember) {
    setEditingMember(m);
    setForm({
      first_name: m.first_name,
      last_name: m.last_name ?? "",
      email: m.email ?? "",
      phone: m.phone ?? "",
      job_title: m.job_title ?? "",
      department_id: m.department_id ? String(m.department_id) : "none",
      employment_status: m.employment_status,
      start_date: m.start_date ?? "",
      notes: "",
    });
    setDialogOpen(true);
  }

  function handleSubmit() {
    const body: Record<string, unknown> = {
      first_name: form.first_name.trim(),
      last_name: form.last_name.trim() || null,
      email: form.email.trim() || null,
      phone: form.phone.trim() || null,
      job_title: form.job_title.trim() || null,
      department_id: form.department_id && form.department_id !== "none" ? Number(form.department_id) : null,
      employment_status: form.employment_status,
      start_date: form.start_date || null,
      notes: form.notes.trim() || null,
    };
    if (editingMember) {
      updateMutation.mutate({ id: editingMember.id, body });
    } else {
      createMutation.mutate(body);
    }
  }

  const isSaving = createMutation.isPending || updateMutation.isPending;

  const filtered = members.filter((m) => {
    if (!showArchived && m.archived_at) return false;
    return true;
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <UserCheck size={22} />
            Team Members
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Manage your workspace's team members and their details.
          </p>
        </div>
        {isOwner && (
          <Button onClick={openAdd} size="sm">
            <Plus size={16} className="mr-1" />
            Add Member
          </Button>
        )}
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="Search members…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(e) => setShowArchived(e.target.checked)}
            className="rounded"
          />
          Show archived
        </label>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex items-center justify-center py-16 text-muted-foreground">
              <Loader2 size={20} className="animate-spin mr-2" />
              Loading…
            </div>
          ) : filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-2 text-muted-foreground">
              <UserCheck size={32} className="opacity-30" />
              <p className="text-sm">No team members found.</p>
              {isOwner && (
                <Button size="sm" variant="outline" onClick={openAdd}>
                  <Plus size={14} className="mr-1" />
                  Add your first member
                </Button>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40">
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Name</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden md:table-cell">Role / Department</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground hidden lg:table-cell">Contact</th>
                    <th className="text-left px-4 py-3 font-medium text-muted-foreground">Status</th>
                    {isOwner && <th className="px-4 py-3 w-20" />}
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((m) => (
                    <tr
                      key={m.id}
                      className={`border-b last:border-0 hover:bg-muted/20 transition-colors ${m.archived_at ? "opacity-50" : ""}`}
                    >
                      <td className="px-4 py-3">
                        <Link href={`/admin/people/team-members/${m.id}`}>
                          <div className="flex items-center gap-2.5 cursor-pointer group">
                            <MemberAvatar member={m} />
                            <div>
                              <div className="font-medium group-hover:underline">
                                {m.first_name} {m.last_name ?? ""}
                                {m.archived_at && (
                                  <span className="ml-2 text-xs text-muted-foreground">(archived)</span>
                                )}
                              </div>
                              {m.start_date && (
                                <div className="text-xs text-muted-foreground mt-0.5">
                                  Since {new Date(m.start_date + "T00:00:00").toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}
                                </div>
                              )}
                            </div>
                          </div>
                        </Link>
                      </td>
                      <td className="px-4 py-3 hidden md:table-cell">
                        <div className="space-y-0.5">
                          {m.job_title && (
                            <div className="flex items-center gap-1 text-sm">
                              <BriefcaseBusiness size={12} className="text-muted-foreground" />
                              {m.job_title}
                            </div>
                          )}
                          {m.department_name && (
                            <div className="flex items-center gap-1 text-xs text-muted-foreground">
                              <Building2 size={11} />
                              {m.department_name}
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3 hidden lg:table-cell">
                        <div className="space-y-0.5">
                          {m.email && (
                            <div className="flex items-center gap-1 text-xs text-muted-foreground">
                              <Mail size={11} />
                              {m.email}
                            </div>
                          )}
                          {m.phone && (
                            <div className="flex items-center gap-1 text-xs text-muted-foreground">
                              <Phone size={11} />
                              {m.phone}
                            </div>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <Badge className={`text-xs py-0 h-5 font-normal ${employmentStatusColor(m.employment_status)}`} variant="secondary">
                          {employmentStatusLabel(m.employment_status)}
                        </Badge>
                      </td>
                      {isOwner && (
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1 justify-end">
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7"
                              onClick={() => openEdit(m)}
                              title="Edit"
                            >
                              <Edit size={13} />
                            </Button>
                            {!m.archived_at && (
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-7 w-7 text-muted-foreground"
                                onClick={() => setArchiveTarget(m)}
                                title="Archive"
                              >
                                <Archive size={13} />
                              </Button>
                            )}
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
            <DialogTitle>{editingMember ? "Edit Team Member" : "Add Team Member"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>First Name <span className="text-destructive">*</span></Label>
                <Input
                  value={form.first_name}
                  onChange={(e) => setForm((f) => ({ ...f, first_name: e.target.value }))}
                  placeholder="Jane"
                />
              </div>
              <div className="space-y-1">
                <Label>Last Name</Label>
                <Input
                  value={form.last_name}
                  onChange={(e) => setForm((f) => ({ ...f, last_name: e.target.value }))}
                  placeholder="Doe"
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label>Email</Label>
              <Input
                type="email"
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                placeholder="jane@example.com"
              />
            </div>
            <div className="space-y-1">
              <Label>Phone</Label>
              <PhoneInputField
                international
                countryCallingCodeEditable={false}
                defaultCountry="LB"
                countries={ALLOWED_COUNTRIES}
                value={form.phone || undefined}
                onChange={(val) => setForm((f) => ({ ...f, phone: val ?? "" }))}
              />
            </div>
            <div className="space-y-1">
              <Label>Job Title</Label>
              <Input
                value={form.job_title}
                onChange={(e) => setForm((f) => ({ ...f, job_title: e.target.value }))}
                placeholder="Software Engineer"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Department</Label>
                <Select
                  value={form.department_id}
                  onValueChange={(v) => setForm((f) => ({ ...f, department_id: v }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="None" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    {departments.map((d) => (
                      <SelectItem key={d.id} value={String(d.id)}>{d.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>Employment Type</Label>
                <Select
                  value={form.employment_status}
                  onValueChange={(v) => setForm((f) => ({ ...f, employment_status: v }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {EMPLOYMENT_STATUS_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1">
              <Label>Start Date</Label>
              <Input
                type="date"
                value={form.start_date}
                onChange={(e) => setForm((f) => ({ ...f, start_date: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label>Notes</Label>
              <Input
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                placeholder="Optional notes…"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={isSaving}>Cancel</Button>
            <Button
              onClick={handleSubmit}
              disabled={!form.first_name.trim() || isSaving}
            >
              {isSaving && <Loader2 size={14} className="animate-spin mr-1.5" />}
              {editingMember ? "Save changes" : "Add Member"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Archive Confirmation */}
      <AlertDialog open={!!archiveTarget} onOpenChange={(o) => { if (!o) setArchiveTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive this member?</AlertDialogTitle>
            <AlertDialogDescription>
              {archiveTarget?.first_name} {archiveTarget?.last_name} will be archived and hidden from active lists.
              You can restore them later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90"
              onClick={() => archiveTarget && archiveMutation.mutate(archiveTarget.id)}
            >
              Archive
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
