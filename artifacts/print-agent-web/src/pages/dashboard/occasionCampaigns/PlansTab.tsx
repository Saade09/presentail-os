import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus, Search, MoreHorizontal, Eye, Edit2, Trash2 } from "lucide-react";
import { useLocation } from "wouter";
import { apiFetch } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel,
  AlertDialogContent, AlertDialogDescription, AlertDialogFooter,
  AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { type Occasion, type CampaignPlan, PhaseBadge, ALL_MARKETS, CURRENCIES, PLAN_STATUSES } from "../OccasionCampaignCalendarPage";

type Props = {
  occasions: Occasion[];
  plans: CampaignPlan[];
  summary: unknown;
};

const STATUS_COLOR: Record<string, string> = {
  draft: "bg-gray-100 text-gray-700 border-gray-200",
  in_progress: "bg-blue-100 text-blue-700 border-blue-200",
  launched: "bg-green-100 text-green-700 border-green-200",
  completed: "bg-purple-100 text-purple-700 border-purple-200",
  paused: "bg-amber-100 text-amber-700 border-amber-200",
};

type CreatePlanForm = {
  occasion_id: number | null;
  name: string;
  target_date: string;
  markets: string[];
  budget: string;
  currency: string;
  notes: string;
  status: string;
  goal: string;
};

function CreatePlanModal({
  open, onClose, occasions, audience,
}: {
  open: boolean;
  onClose: () => void;
  occasions: Occasion[];
  audience?: { id: string; name: string } | null;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const today = new Date().toISOString().split("T")[0];
  const [form, setForm] = useState<CreatePlanForm>({
    occasion_id: null, name: "", target_date: today, markets: [],
    budget: "", currency: "AED", notes: "", status: "draft", goal: "",
  });
  const [errors, setErrors] = useState<string[]>([]);

  const mutation = useMutation({
    mutationFn: (data: object) =>
      apiFetch("/api/occasion-campaigns/plans", { method: "POST", body: JSON.stringify(data) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["/api/occasion-campaigns/plans"] });
      void qc.invalidateQueries({ queryKey: ["/api/occasion-campaigns/summary"] });
      toast({ title: "Campaign plan created" });
      onClose();
      setForm({ occasion_id: null, name: "", target_date: today, markets: [], budget: "", currency: "AED", notes: "", status: "draft", goal: "" });
    },
    onError: (e: Error) => setErrors([e.message || "Failed to create plan"]),
  });

  function handleSubmit() {
    const errs: string[] = [];
    if (!form.occasion_id) errs.push("Please select an occasion.");
    if (!form.name.trim()) errs.push("Campaign name is required.");
    if (!form.target_date) errs.push("Target date is required.");
    if (errs.length > 0) { setErrors(errs); return; }
    setErrors([]);
    const notesWithAudience = audience
      ? [form.notes.trim(), `Audience: ${audience.name}`].filter(Boolean).join("\n")
      : form.notes.trim();
    mutation.mutate({
      occasion_id: form.occasion_id, name: form.name.trim(), target_date: form.target_date,
      markets: form.markets, budget: form.budget ? parseFloat(form.budget) : null,
      currency: form.currency, notes: notesWithAudience || null, status: form.status,
      goal: form.goal.trim() || null,
      ...(audience ? { audience_id: audience.id } : {}),
    });
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New campaign plan</DialogTitle>
          <DialogDescription>Plan a marketing campaign around an occasion.</DialogDescription>
        </DialogHeader>
        {audience && (
          <div
            className="rounded-md border bg-teal-50 border-teal-200 px-3 py-2 text-sm text-teal-900"
            data-testid="chip-plan-audience"
          >
            Audience: <span className="font-medium">{audience.name}</span>
            <span className="block text-xs text-teal-700">
              This plan targets the selected audience. Nothing is sent automatically.
            </span>
          </div>
        )}
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Occasion *</Label>
            <Select value={form.occasion_id?.toString() ?? ""}
              onValueChange={(v) => setForm((p) => ({ ...p, occasion_id: parseInt(v, 10) }))}>
              <SelectTrigger><SelectValue placeholder="Select occasion…" /></SelectTrigger>
              <SelectContent>
                {occasions.map((occ) => <SelectItem key={occ.id} value={occ.id.toString()}>{occ.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="plan-name">Campaign name *</Label>
            <Input id="plan-name" placeholder="e.g. Mother's Day 2026 UAE Launch" value={form.name}
              onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} autoFocus />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Target date *</Label>
              <Input type="date" value={form.target_date}
                onChange={(e) => setForm((p) => ({ ...p, target_date: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Status</Label>
              <Select value={form.status} onValueChange={(v) => setForm((p) => ({ ...p, status: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {PLAN_STATUSES.map((s) => <SelectItem key={s} value={s}>{s.replace(/_/g, " ")}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Markets</Label>
            <div className="flex flex-wrap gap-1.5">
              {ALL_MARKETS.map((m) => (
                <button key={m} type="button"
                  onClick={() => setForm((p) => ({
                    ...p, markets: p.markets.includes(m) ? p.markets.filter((x) => x !== m) : [...p.markets, m],
                  }))}
                  className={cn("text-xs px-2.5 py-1 rounded-full border transition-colors",
                    form.markets.includes(m) ? "bg-primary text-primary-foreground border-primary" : "border-border hover:bg-secondary")}>
                  {m}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Budget (optional)</Label>
              <Input type="number" placeholder="0" value={form.budget}
                onChange={(e) => setForm((p) => ({ ...p, budget: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Currency</Label>
              <Select value={form.currency} onValueChange={(v) => setForm((p) => ({ ...p, currency: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{CURRENCIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Campaign goal (optional)</Label>
            <Input placeholder="e.g. 500 orders, 20% revenue increase" value={form.goal}
              onChange={(e) => setForm((p) => ({ ...p, goal: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label>Notes (optional)</Label>
            <Textarea placeholder="Add campaign notes…" value={form.notes}
              onChange={(e) => setForm((p) => ({ ...p, notes: e.target.value }))} rows={2} />
          </div>
          {errors.length > 0 && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 space-y-1">
              {errors.map((e, i) => <p key={i} className="text-sm text-destructive">{e}</p>)}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={mutation.isPending}>
            {mutation.isPending ? "Creating…" : "Create campaign plan"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PlansTab({ occasions, plans }: Props) {
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { realIsOwner } = useWorkspaceRole();
  const [q, setQ] = useState("");
  const [occasionFilter, setOccasionFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [marketFilter, setMarketFilter] = useState("all");
  // Audience handoff: /occasion-campaigns?tab=plans&create=1&audience_id=…&audience_name=…
  const [handoffAudience] = useState<{ id: string; name: string } | null>(() => {
    const params = new URLSearchParams(window.location.search);
    const id = params.get("audience_id");
    const name = params.get("audience_name");
    return id && name ? { id, name } : null;
  });
  const [createModalOpen, setCreateModalOpen] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get("create") === "1" && !!params.get("audience_id");
  });
  const [deleteTarget, setDeleteTarget] = useState<CampaignPlan | null>(null);

  const plansQuery = useQuery({
    queryKey: ["/api/occasion-campaigns/plans", { occasion: occasionFilter, status: statusFilter }],
    queryFn: () => {
      const params = new URLSearchParams();
      if (occasionFilter !== "all") params.set("occasion_id", occasionFilter);
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (marketFilter !== "all") params.set("market", marketFilter);
      return apiFetch<{ plans: CampaignPlan[] }>(`/api/occasion-campaigns/plans?${params}`);
    },
  });
  const allPlans = plansQuery.data?.plans ?? plans;

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/api/occasion-campaigns/plans/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["/api/occasion-campaigns/plans"] });
      void qc.invalidateQueries({ queryKey: ["/api/occasion-campaigns/summary"] });
      toast({ title: "Plan deleted" });
      setDeleteTarget(null);
    },
    onError: (e: Error) => { toast({ title: e.message, variant: "destructive" }); setDeleteTarget(null); },
  });

  const filtered = allPlans.filter((p) => {
    if (q && !p.name.toLowerCase().includes(q.toLowerCase()) && !p.occasion_name?.toLowerCase().includes(q.toLowerCase())) return false;
    return true;
  });

  const allMarkets = Array.from(new Set(allPlans.flatMap((p) => p.markets))).sort();

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input placeholder="Search plans…" value={q} onChange={(e) => setQ(e.target.value)}
            className="pl-8 h-8 w-48 text-xs" />
        </div>
        <Select value={occasionFilter} onValueChange={setOccasionFilter}>
          <SelectTrigger className="h-8 w-36 text-xs"><SelectValue placeholder="All occasions" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All occasions</SelectItem>
            {occasions.map((o) => <SelectItem key={o.id} value={o.id.toString()}>{o.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="h-8 w-28 text-xs"><SelectValue placeholder="All statuses" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {PLAN_STATUSES.map((s) => <SelectItem key={s} value={s}>{s.replace(/_/g, " ")}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={marketFilter} onValueChange={setMarketFilter}>
          <SelectTrigger className="h-8 w-28 text-xs"><SelectValue placeholder="All markets" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All markets</SelectItem>
            {allMarkets.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
          </SelectContent>
        </Select>
        <div className="ml-auto">
          <Button size="sm" onClick={() => setCreateModalOpen(true)}>
            <Plus size={14} className="mr-1.5" /> New plan
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {filtered.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <p className="text-sm">No campaign plans found.</p>
              <Button variant="outline" size="sm" className="mt-4" onClick={() => setCreateModalOpen(true)}>
                <Plus size={14} className="mr-1.5" /> Create your first plan
              </Button>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/30">
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Plan name</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground hidden sm:table-cell">Occasion</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground hidden md:table-cell">Target date</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground hidden lg:table-cell">Budget</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Status</th>
                  <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground hidden md:table-cell">Phase</th>
                  <th className="w-8 px-2" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((plan) => (
                  <tr key={plan.id} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                    <td className="px-4 py-3">
                      <button className="text-left font-medium hover:underline"
                        onClick={() => setLocation(`/occasion-campaigns/plans/${plan.id}`)}>
                        {plan.name}
                      </button>
                    </td>
                    <td className="px-4 py-3 hidden sm:table-cell text-muted-foreground text-xs">
                      {plan.occasion_name ?? "—"}
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell text-xs text-muted-foreground">
                      {plan.target_date}
                      {plan.days_until !== null && <span className="ml-1">({plan.days_until}d)</span>}
                    </td>
                    <td className="px-4 py-3 hidden lg:table-cell text-xs text-muted-foreground">
                      {plan.budget ? `${plan.budget} ${plan.currency}` : "—"}
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant="outline" className={cn("text-xs capitalize", STATUS_COLOR[plan.status] ?? "")}>
                        {plan.status.replace(/_/g, " ")}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 hidden md:table-cell">
                      <PhaseBadge phase={plan.campaign_phase} />
                    </td>
                    <td className="px-2 py-3">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-7 w-7">
                            <MoreHorizontal size={14} />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => setLocation(`/occasion-campaigns/plans/${plan.id}`)}>
                            <Eye size={14} className="mr-2" /> View
                          </DropdownMenuItem>
                          {realIsOwner && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem className="text-destructive" onClick={() => setDeleteTarget(plan)}>
                                <Trash2 size={14} className="mr-2" /> Delete
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <CreatePlanModal open={createModalOpen} onClose={() => setCreateModalOpen(false)} occasions={occasions} audience={handoffAudience} />

      <AlertDialog open={!!deleteTarget} onOpenChange={(v) => !v && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete campaign plan</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete &ldquo;{deleteTarget?.name}&rdquo;? This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
              disabled={deleteMutation.isPending}>
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
