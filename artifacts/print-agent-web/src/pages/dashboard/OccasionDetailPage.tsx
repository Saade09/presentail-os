import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import {
  ArrowLeft, Edit2, Copy, Archive, Plus, CheckCircle2, Circle, Clock,
  Calendar, MapPin, Tag, Users, BarChart2, AlertTriangle, Target,
} from "lucide-react";
import { apiFetch } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  type Occasion, type CampaignPlan, TYPE_COLOR, PRIORITY_COLOR, PhaseBadge,
  ALL_MARKETS, CURRENCIES, PLAN_STATUSES,
} from "./OccasionCampaignCalendarPage";

type ReadinessItem = {
  id: number;
  title: string;
  category: string;
  status: "not_started" | "in_progress" | "done";
  due_date: string | null;
  notes: string | null;
  is_default: boolean;
};

type OccasionDetail = Occasion & {
  plan_count: number;
  readiness_score: number;
};

type ReadinessResponse = {
  items: ReadinessItem[];
  score: number;
};

const STATUS_CYCLE: Record<string, "not_started" | "in_progress" | "done"> = {
  not_started: "in_progress",
  in_progress: "done",
  done: "not_started",
};

function StatusIcon({ status }: { status: string }) {
  if (status === "done") return <CheckCircle2 size={16} className="text-green-500 shrink-0" />;
  if (status === "in_progress") return <Clock size={16} className="text-amber-500 shrink-0" />;
  return <Circle size={16} className="text-muted-foreground shrink-0" />;
}

function ReadinessBar({ score }: { score: number }) {
  const color = score >= 80 ? "bg-green-500" : score >= 50 ? "bg-blue-500" : score >= 30 ? "bg-amber-500" : "bg-red-500";
  const textColor = score >= 80 ? "text-green-600" : score >= 50 ? "text-blue-600" : score >= 30 ? "text-amber-600" : "text-red-600";
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-sm">
        <span className="text-muted-foreground">Readiness score</span>
        <span className={cn("font-bold", textColor)}>{score}%</span>
      </div>
      <div className="h-2 bg-border rounded-full overflow-hidden">
        <div className={cn("h-full rounded-full transition-all", color)} style={{ width: `${score}%` }} />
      </div>
    </div>
  );
}

function CreatePlanDialog({ open, onClose, occasionId, occasionName }: {
  open: boolean; onClose: () => void; occasionId: number; occasionName: string;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const today = new Date().toISOString().split("T")[0];
  const [form, setForm] = useState({
    name: `${occasionName} Campaign`,
    target_date: today, markets: [] as string[], budget: "", currency: "AED",
    notes: "", status: "draft", goal: "",
  });
  const [errors, setErrors] = useState<string[]>([]);

  const mutation = useMutation({
    mutationFn: (data: object) =>
      apiFetch("/api/occasion-campaigns/plans", { method: "POST", body: JSON.stringify(data) }),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ["/api/occasion-campaigns/plans"] });
      void qc.invalidateQueries({ queryKey: ["/api/occasion-campaigns/occasions", occasionId] });
      toast({ title: "Campaign plan created" });
      onClose();
    },
    onError: (e: Error) => setErrors([e.message]),
  });

  function handleSubmit() {
    const errs: string[] = [];
    if (!form.name.trim()) errs.push("Campaign name is required.");
    if (!form.target_date) errs.push("Target date is required.");
    if (errs.length > 0) { setErrors(errs); return; }
    setErrors([]);
    mutation.mutate({
      occasion_id: occasionId, name: form.name.trim(), target_date: form.target_date,
      markets: form.markets, budget: form.budget ? parseFloat(form.budget) : null,
      currency: form.currency, notes: form.notes.trim() || null, status: form.status,
      goal: form.goal.trim() || null,
    });
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create campaign plan</DialogTitle>
          <DialogDescription>For: {occasionName}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Campaign name *</Label>
            <Input value={form.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} autoFocus />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Target date *</Label>
              <Input type="date" value={form.target_date} onChange={(e) => setForm((p) => ({ ...p, target_date: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label>Status</Label>
              <Select value={form.status} onValueChange={(v) => setForm((p) => ({ ...p, status: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{PLAN_STATUSES.map((s) => <SelectItem key={s} value={s}>{s.replace(/_/g, " ")}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>Markets</Label>
            <div className="flex flex-wrap gap-1.5">
              {ALL_MARKETS.map((m) => (
                <button key={m} type="button"
                  onClick={() => setForm((p) => ({ ...p, markets: p.markets.includes(m) ? p.markets.filter((x) => x !== m) : [...p.markets, m] }))}
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
              <Input type="number" placeholder="0" value={form.budget} onChange={(e) => setForm((p) => ({ ...p, budget: e.target.value }))} />
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
            <Label>Goal (optional)</Label>
            <Input placeholder="e.g. 500 orders" value={form.goal} onChange={(e) => setForm((p) => ({ ...p, goal: e.target.value }))} />
          </div>
          <div className="space-y-1.5">
            <Label>Notes (optional)</Label>
            <Textarea placeholder="Add notes…" value={form.notes} onChange={(e) => setForm((p) => ({ ...p, notes: e.target.value }))} rows={2} />
          </div>
          {errors.length > 0 && (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3">
              {errors.map((e, i) => <p key={i} className="text-sm text-destructive">{e}</p>)}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={mutation.isPending}>
            {mutation.isPending ? "Creating…" : "Create plan"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function OccasionDetailPage() {
  const params = useParams<{ id: string }>();
  const id = parseInt(params.id, 10);
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { realIsOwner } = useWorkspaceRole();
  const [createPlanOpen, setCreatePlanOpen] = useState(false);

  const occasionQuery = useQuery({
    queryKey: ["/api/occasion-campaigns/occasions", id],
    queryFn: () => apiFetch<{ occasion: OccasionDetail }>(`/api/occasion-campaigns/occasions/${id}`),
    enabled: !isNaN(id),
  });

  const plansQuery = useQuery({
    queryKey: ["/api/occasion-campaigns/plans", { occasion_id: id }],
    queryFn: () => apiFetch<{ plans: CampaignPlan[] }>(`/api/occasion-campaigns/plans?occasion_id=${id}`),
    enabled: !isNaN(id),
  });

  const readinessQuery = useQuery({
    queryKey: ["/api/occasion-campaigns/readiness", id],
    queryFn: () => apiFetch<ReadinessResponse>(`/api/occasion-campaigns/occasions/${id}/readiness`),
    enabled: !isNaN(id),
  });

  const patchReadinessMutation = useMutation({
    mutationFn: ({ itemId, status }: { itemId: number; status: string }) =>
      apiFetch(`/api/occasion-campaigns/occasions/${id}/readiness/${itemId}`, {
        method: "PATCH", body: JSON.stringify({ status }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["/api/occasion-campaigns/readiness", id] });
    },
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });

  const archiveMutation = useMutation({
    mutationFn: (archive: boolean) =>
      apiFetch(`/api/occasion-campaigns/occasions/${id}`, {
        method: "PATCH", body: JSON.stringify({ status: archive ? "archived" : "active" }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["/api/occasion-campaigns/occasions"] });
      void qc.invalidateQueries({ queryKey: ["/api/occasion-campaigns/occasions", id] });
      toast({ title: "Occasion updated" });
    },
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });

  const duplicateMutation = useMutation({
    mutationFn: () => apiFetch(`/api/occasion-campaigns/occasions/${id}/duplicate`, { method: "POST" }),
    onSuccess: (data: { occasion: Occasion }) => {
      void qc.invalidateQueries({ queryKey: ["/api/occasion-campaigns/occasions"] });
      toast({ title: "Occasion duplicated" });
      setLocation(`/occasion-campaigns/occasions/${data.occasion.id}`);
    },
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });

  if (occasionQuery.isPending) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-64 bg-muted animate-pulse rounded" />
        <div className="h-40 bg-muted animate-pulse rounded-lg" />
        <div className="grid grid-cols-2 gap-4">
          <div className="h-64 bg-muted animate-pulse rounded-lg" />
          <div className="h-64 bg-muted animate-pulse rounded-lg" />
        </div>
      </div>
    );
  }

  if (occasionQuery.isError || !occasionQuery.data?.occasion) {
    return (
      <div className="text-center py-16">
        <p className="text-destructive">Occasion not found.</p>
        <Button variant="outline" className="mt-4" onClick={() => setLocation("/occasion-campaigns")}>
          <ArrowLeft size={14} className="mr-1.5" /> Back to occasions
        </Button>
      </div>
    );
  }

  const occasion = occasionQuery.data.occasion;
  const plans = plansQuery.data?.plans ?? [];
  const readinessItems = readinessQuery.data?.items ?? [];
  const readinessScore = readinessQuery.data?.score ?? 0;

  const categorizedItems = readinessItems.reduce((acc, item) => {
    if (!acc[item.category]) acc[item.category] = [];
    acc[item.category].push(item);
    return acc;
  }, {} as Record<string, ReadinessItem[]>);

  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <Button variant="ghost" size="sm" onClick={() => setLocation("/occasion-campaigns")} className="-ml-2">
        <ArrowLeft size={14} className="mr-1.5" /> Occasion Campaigns
      </Button>

      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-2xl font-bold">{occasion.name}</h1>
            <PhaseBadge phase={occasion.campaign_phase} />
            <Badge variant="outline" className={cn("capitalize", PRIORITY_COLOR[occasion.priority])}>
              {occasion.priority} priority
            </Badge>
            <Badge variant="outline" className={cn("capitalize", TYPE_COLOR[occasion.type])}>
              {occasion.type.replace(/_/g, " ")}
            </Badge>
            {occasion.status === "archived" && (
              <Badge variant="secondary" className="text-xs">Archived</Badge>
            )}
          </div>
          <div className="flex items-center gap-4 mt-2 text-sm text-muted-foreground flex-wrap">
            {occasion.next_occurrence && (
              <span className="flex items-center gap-1">
                <Calendar size={13} /> {occasion.next_occurrence}
              </span>
            )}
            {occasion.days_until !== null && (
              <span className="font-semibold text-foreground">{occasion.days_until} days away</span>
            )}
            {occasion.markets.length > 0 && (
              <span className="flex items-center gap-1">
                <MapPin size={13} /> {occasion.markets.join(", ")}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {realIsOwner && (
            <>
              <Button variant="outline" size="sm" onClick={() => duplicateMutation.mutate()} disabled={duplicateMutation.isPending}>
                <Copy size={14} className="mr-1.5" /> Duplicate
              </Button>
              <Button variant="outline" size="sm"
                onClick={() => archiveMutation.mutate(occasion.status !== "archived")}
                disabled={archiveMutation.isPending}>
                <Archive size={14} className="mr-1.5" />
                {occasion.status === "archived" ? "Unarchive" : "Archive"}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setLocation(`/occasion-campaigns/occasions/${id}/edit`)}>
                <Edit2 size={14} className="mr-1.5" /> Edit
              </Button>
            </>
          )}
          <Button size="sm" onClick={() => setCreatePlanOpen(true)}>
            <Plus size={14} className="mr-1.5" /> Create plan
          </Button>
        </div>
      </div>

      {/* Overview + Readiness */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Overview */}
        <div className="lg:col-span-2 space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Overview</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {occasion.description && (
                <p className="text-sm text-muted-foreground">{occasion.description}</p>
              )}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Recurrence</p>
                  <p className="font-medium capitalize">{occasion.recurrence.replace(/_/g, " ")}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Campaign start</p>
                  <p className="font-medium">{occasion.campaign_start_days_before} days before</p>
                </div>
                {occasion.preparation_days && (
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Prep days</p>
                    <p className="font-medium">{occasion.preparation_days}</p>
                  </div>
                )}
                {occasion.demand_level && (
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Demand level</p>
                    <p className="font-medium capitalize">{occasion.demand_level}</p>
                  </div>
                )}
              </div>
              {occasion.product_focus && (
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Product focus</p>
                  <p className="text-sm">{occasion.product_focus}</p>
                </div>
              )}
              {occasion.recommended_channels.length > 0 && (
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wide mb-2">Recommended channels</p>
                  <div className="flex flex-wrap gap-1.5">
                    {occasion.recommended_channels.map((ch) => (
                      <Badge key={ch} variant="secondary" className="text-xs">{ch}</Badge>
                    ))}
                  </div>
                </div>
              )}
              {occasion.tags.length > 0 && (
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wide mb-2 flex items-center gap-1">
                    <Tag size={11} /> Tags
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {occasion.tags.map((tag) => (
                      <Badge key={tag} variant="outline" className="text-xs">{tag}</Badge>
                    ))}
                  </div>
                </div>
              )}
              {occasion.notes && (
                <div className="rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground">
                  {occasion.notes}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Campaign Plans */}
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">Campaign Plans ({plans.length})</CardTitle>
                <Button size="sm" variant="outline" onClick={() => setCreatePlanOpen(true)}>
                  <Plus size={13} className="mr-1.5" /> Add plan
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {plans.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border p-6 text-center">
                  <p className="text-sm text-muted-foreground">No campaign plans yet.</p>
                  <Button variant="outline" size="sm" className="mt-3" onClick={() => setCreatePlanOpen(true)}>
                    <Plus size={13} className="mr-1.5" /> Create first plan
                  </Button>
                </div>
              ) : (
                <ul className="divide-y divide-border">
                  {plans.map((plan) => (
                    <li key={plan.id} className="py-3 flex items-center gap-3 cursor-pointer hover:bg-muted/20 -mx-2 px-2 rounded transition-colors"
                      onClick={() => setLocation(`/occasion-campaigns/plans/${plan.id}`)}>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium">{plan.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {plan.target_date}
                          {plan.days_until !== null && ` · ${plan.days_until}d`}
                          {plan.markets.length > 0 && ` · ${plan.markets.join(", ")}`}
                        </p>
                      </div>
                      <Badge variant="outline" className="text-xs capitalize shrink-0">{plan.status.replace(/_/g, " ")}</Badge>
                      <PhaseBadge phase={plan.campaign_phase} />
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {/* Links placeholder cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">Products & Catalog</CardTitle></CardHeader>
              <CardContent>
                <div className="rounded-lg border border-dashed border-border p-4 text-center">
                  <p className="text-xs text-muted-foreground">Link products to this occasion from the Products page.</p>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">Marketing Budget</CardTitle></CardHeader>
              <CardContent>
                <div className="rounded-lg border border-dashed border-border p-4 text-center">
                  <p className="text-xs text-muted-foreground">Budget planning coming soon.</p>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>

        {/* Readiness Checklist */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <BarChart2 size={16} /> Readiness
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <ReadinessBar score={readinessScore} />
              {Object.entries(categorizedItems).map(([category, items]) => (
                <div key={category}>
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2 capitalize">
                    {category}
                  </p>
                  <ul className="space-y-2">
                    {items.map((item) => (
                      <li key={item.id} className="flex items-start gap-2">
                        <button
                          type="button"
                          onClick={() => patchReadinessMutation.mutate({
                            itemId: item.id,
                            status: STATUS_CYCLE[item.status] ?? "not_started",
                          })}
                          className="mt-0.5 hover:opacity-70 transition-opacity"
                          aria-label="Toggle status"
                        >
                          <StatusIcon status={item.status} />
                        </button>
                        <span className={cn("text-sm", item.status === "done" && "line-through text-muted-foreground")}>
                          {item.title}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              {readinessItems.length === 0 && readinessQuery.isPending && (
                <p className="text-xs text-muted-foreground">Loading checklist…</p>
              )}
            </CardContent>
          </Card>

          {/* Quick stats */}
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Quick Stats</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Plans</span>
                <span className="font-medium">{occasion.plan_count}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Markets</span>
                <span className="font-medium">{occasion.markets.length}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Status</span>
                <Badge variant="outline" className="text-xs capitalize">{occasion.status}</Badge>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Recurrence</span>
                <span className="font-medium capitalize text-xs text-right">{occasion.recurrence.replace(/_/g, " ")}</span>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <CreatePlanDialog
        open={createPlanOpen}
        onClose={() => setCreatePlanOpen(false)}
        occasionId={id}
        occasionName={occasion.name}
      />
    </div>
  );
}
