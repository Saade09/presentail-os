import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import {
  ArrowLeft, CheckCircle2, Circle, Clock, Calendar, Target,
  Edit2, BarChart2,
} from "lucide-react";
import { apiFetch } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { type CampaignPlan, PhaseBadge, PLAN_STATUSES } from "./OccasionCampaignCalendarPage";

type ActionRow = {
  id: number;
  plan_id: number;
  title: string;
  description: string | null;
  status: "not_started" | "in_progress" | "done";
  due_date: string | null;
};

type PlanDetail = CampaignPlan & {
  actions: ActionRow[];
};

const STATUS_CYCLE: Record<string, "not_started" | "in_progress" | "done"> = {
  not_started: "in_progress",
  in_progress: "done",
  done: "not_started",
};

const STATUS_COLOR: Record<string, string> = {
  draft: "bg-gray-100 text-gray-700 border-gray-200",
  in_progress: "bg-blue-100 text-blue-700 border-blue-200",
  launched: "bg-green-100 text-green-700 border-green-200",
  completed: "bg-purple-100 text-purple-700 border-purple-200",
  paused: "bg-amber-100 text-amber-700 border-amber-200",
};

function ActionStatusIcon({ status }: { status: string }) {
  if (status === "done") return <CheckCircle2 size={16} className="text-green-500 shrink-0" />;
  if (status === "in_progress") return <Clock size={16} className="text-amber-500 shrink-0" />;
  return <Circle size={16} className="text-muted-foreground shrink-0" />;
}

export default function OccasionCampaignPlanDetailPage() {
  const params = useParams<{ id: string }>();
  const id = parseInt(params.id, 10);
  const [, setLocation] = useLocation();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [editingStatus, setEditingStatus] = useState(false);

  const planQuery = useQuery({
    queryKey: ["/api/occasion-campaigns/plans", id],
    queryFn: () => apiFetch<{ plan: PlanDetail }>(`/api/occasion-campaigns/plans/${id}`),
    enabled: !isNaN(id),
  });

  const patchActionMutation = useMutation({
    mutationFn: ({ actionId, status }: { actionId: number; status: string }) =>
      apiFetch(`/api/occasion-campaigns/actions/${actionId}`, {
        method: "PATCH", body: JSON.stringify({ status }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["/api/occasion-campaigns/plans", id] });
    },
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });

  const patchPlanMutation = useMutation({
    mutationFn: (data: object) =>
      apiFetch(`/api/occasion-campaigns/plans/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["/api/occasion-campaigns/plans", id] });
      void qc.invalidateQueries({ queryKey: ["/api/occasion-campaigns/plans"] });
      toast({ title: "Plan updated" });
      setEditingStatus(false);
    },
    onError: (e: Error) => toast({ title: e.message, variant: "destructive" }),
  });

  if (planQuery.isPending) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-64 bg-muted animate-pulse rounded" />
        <div className="h-40 bg-muted animate-pulse rounded-lg" />
        <div className="grid grid-cols-2 gap-4">
          {[0, 1].map((i) => <div key={i} className="h-48 bg-muted animate-pulse rounded-lg" />)}
        </div>
      </div>
    );
  }

  if (planQuery.isError || !planQuery.data?.plan) {
    return (
      <div className="text-center py-16">
        <p className="text-destructive">Campaign plan not found.</p>
        <Button variant="outline" className="mt-4" onClick={() => setLocation("/occasion-campaigns")}>
          <ArrowLeft size={14} className="mr-1.5" /> Back
        </Button>
      </div>
    );
  }

  const plan = planQuery.data.plan;
  const actions = plan.actions ?? [];

  const doneCount = actions.filter((a) => a.status === "done").length;
  const completionPct = actions.length > 0 ? Math.round((doneCount / actions.length) * 100) : 0;

  return (
    <div className="space-y-6 max-w-4xl">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => setLocation("/occasion-campaigns")} className="-ml-2">
          <ArrowLeft size={14} className="mr-1.5" /> Occasion Campaigns
        </Button>
        {plan.occasion_id && (
          <>
            <span className="text-muted-foreground">/</span>
            <Button variant="ghost" size="sm" className="-ml-1"
              onClick={() => setLocation(`/occasion-campaigns/occasions/${plan.occasion_id}`)}>
              {plan.occasion_name ?? "Occasion"}
            </Button>
          </>
        )}
      </div>

      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">{plan.name}</h1>
          <div className="flex items-center gap-3 mt-2 flex-wrap">
            {editingStatus ? (
              <Select value={plan.status}
                onValueChange={(v) => patchPlanMutation.mutate({ status: v })}>
                <SelectTrigger className="h-7 w-32 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PLAN_STATUSES.map((s) => <SelectItem key={s} value={s}>{s.replace(/_/g, " ")}</SelectItem>)}
                </SelectContent>
              </Select>
            ) : (
              <Badge variant="outline"
                className={cn("cursor-pointer capitalize", STATUS_COLOR[plan.status] ?? "")}
                onClick={() => setEditingStatus(true)}>
                {plan.status.replace(/_/g, " ")}
                <Edit2 size={10} className="ml-1.5 opacity-60" />
              </Badge>
            )}
            <PhaseBadge phase={plan.campaign_phase} />
            {plan.occasion_type && (
              <Badge variant="secondary" className="text-xs capitalize">
                {plan.occasion_type.replace(/_/g, " ")}
              </Badge>
            )}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left col — details + checklist */}
        <div className="lg:col-span-2 space-y-4">
          {/* Overview card */}
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Plan Details</CardTitle></CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-sm">
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Target date</p>
                  <p className="font-medium flex items-center gap-1">
                    <Calendar size={13} /> {plan.target_date}
                  </p>
                  {plan.days_until !== null && (
                    <p className="text-xs text-muted-foreground">{plan.days_until}d away</p>
                  )}
                </div>
                {plan.budget && (
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Budget</p>
                    <p className="font-medium">{plan.budget} {plan.currency}</p>
                  </div>
                )}
                {plan.markets.length > 0 && (
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Markets</p>
                    <div className="flex flex-wrap gap-1">
                      {plan.markets.map((m) => <Badge key={m} variant="secondary" className="text-xs">{m}</Badge>)}
                    </div>
                  </div>
                )}
                {plan.channel && (
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Channel</p>
                    <p className="font-medium">{plan.channel}</p>
                  </div>
                )}
                {plan.market && (
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Market</p>
                    <p className="font-medium">{plan.market}</p>
                  </div>
                )}
                {plan.start_date && (
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Start date</p>
                    <p className="font-medium">{plan.start_date}</p>
                  </div>
                )}
                {plan.end_date && (
                  <div>
                    <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">End date</p>
                    <p className="font-medium">{plan.end_date}</p>
                  </div>
                )}
              </div>
              {plan.goal && (
                <div className="mt-4">
                  <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1 flex items-center gap-1">
                    <Target size={11} /> Campaign goal
                  </p>
                  <p className="text-sm">{plan.goal}</p>
                </div>
              )}
              {plan.notes && (
                <div className="mt-4 rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground">
                  {plan.notes}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Campaign Checklist */}
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">Campaign Checklist</CardTitle>
                <span className="text-sm text-muted-foreground">{doneCount}/{actions.length} done</span>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Progress bar */}
              <div className="h-2 bg-border rounded-full overflow-hidden">
                <div className="h-full bg-primary rounded-full transition-all" style={{ width: `${completionPct}%` }} />
              </div>
              {actions.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">No checklist items.</p>
              ) : (
                <ul className="space-y-2">
                  {actions.map((action) => (
                    <li key={action.id} className="flex items-start gap-2 group">
                      <button
                        type="button"
                        onClick={() => patchActionMutation.mutate({
                          actionId: action.id,
                          status: STATUS_CYCLE[action.status] ?? "not_started",
                        })}
                        className="mt-0.5 hover:opacity-70 transition-opacity"
                        aria-label="Cycle status"
                      >
                        <ActionStatusIcon status={action.status} />
                      </button>
                      <div className="flex-1 min-w-0">
                        <span className={cn("text-sm", action.status === "done" && "line-through text-muted-foreground")}>
                          {action.title}
                        </span>
                        {action.due_date && (
                          <p className="text-xs text-muted-foreground">{action.due_date}</p>
                        )}
                      </div>
                      <Badge variant="outline" className="text-[10px] capitalize opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                        {action.status.replace(/_/g, " ")}
                      </Badge>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right col — stats */}
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Completion</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-center">
                <div className={cn(
                  "rounded-full w-20 h-20 flex items-center justify-center text-2xl font-bold",
                  completionPct >= 80 ? "bg-green-50 text-green-600" :
                  completionPct >= 50 ? "bg-blue-50 text-blue-600" : "bg-amber-50 text-amber-600"
                )}>
                  {completionPct}%
                </div>
              </div>
              <div className="space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Total tasks</span>
                  <span className="font-medium">{actions.length}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Done</span>
                  <span className="font-medium text-green-600">{doneCount}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">In progress</span>
                  <span className="font-medium text-amber-600">
                    {actions.filter((a) => a.status === "in_progress").length}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Not started</span>
                  <span className="font-medium text-muted-foreground">
                    {actions.filter((a) => a.status === "not_started").length}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Placeholders */}
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Performance</CardTitle></CardHeader>
            <CardContent>
              <div className="rounded-lg border border-dashed border-border bg-muted/20 py-8 text-center">
                <BarChart2 size={24} className="mx-auto text-muted-foreground mb-2" />
                <p className="text-xs text-muted-foreground">Revenue data coming soon</p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
