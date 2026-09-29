import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { AlertTriangle, TrendingUp, Zap, Target, ArrowRight, Star } from "lucide-react";
import { apiFetch } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { type Occasion, type CampaignPlan, TYPE_COLOR, PRIORITY_COLOR, PhaseBadge } from "../OccasionCampaignCalendarPage";

type InsightsData = {
  upcoming_critical: (Occasion & { days_until: number | null; next_occurrence: string | null })[];
  missing_plans: (Occasion & { days_until: number | null; next_occurrence: string | null })[];
  campaigns_this_week: CampaignPlan[];
  average_readiness_score: number;
  recommended_actions: {
    title: string;
    reason: string;
    urgency: "urgent" | "high" | "medium";
    occasion_id?: number;
    occasion_name?: string;
  }[];
};

type Props = {
  occasions: Occasion[];
  plans: CampaignPlan[];
  summary: unknown;
};

const URGENCY_COLOR = {
  urgent: "border-red-300 bg-red-50 text-red-700",
  high: "border-amber-300 bg-amber-50 text-amber-700",
  medium: "border-blue-300 bg-blue-50 text-blue-700",
};

function ReadinessMeter({ score }: { score: number }) {
  const color = score >= 80 ? "text-green-600 bg-green-50" : score >= 50 ? "text-blue-600 bg-blue-50" : "text-red-600 bg-red-50";
  return (
    <div className={cn("rounded-full w-16 h-16 flex items-center justify-center text-xl font-bold", color)}>
      {score}%
    </div>
  );
}

export function InsightsTab({ occasions, plans }: Props) {
  const [, setLocation] = useLocation();

  const insightsQuery = useQuery({
    queryKey: ["/api/occasion-campaigns/insights"],
    queryFn: () => apiFetch<InsightsData>("/api/occasion-campaigns/insights"),
  });

  const data = insightsQuery.data;

  if (insightsQuery.isPending) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-48 bg-muted animate-pulse rounded-lg" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Summary row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-5">
            <div className="flex items-center gap-3">
              <div className="rounded-lg p-2 bg-amber-50"><Star size={18} className="text-amber-600" /></div>
              <div>
                <p className="text-xs text-muted-foreground">Upcoming critical</p>
                <p className="text-2xl font-bold">{data?.upcoming_critical.length ?? 0}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <div className="flex items-center gap-3">
              <div className="rounded-lg p-2 bg-red-50"><AlertTriangle size={18} className="text-red-600" /></div>
              <div>
                <p className="text-xs text-muted-foreground">Missing plans</p>
                <p className="text-2xl font-bold">{data?.missing_plans.length ?? 0}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <div className="flex items-center gap-3">
              <div className="rounded-lg p-2 bg-blue-50"><Zap size={18} className="text-blue-600" /></div>
              <div>
                <p className="text-xs text-muted-foreground">Campaigns this week</p>
                <p className="text-2xl font-bold">{data?.campaigns_this_week.length ?? 0}</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-5">
            <div className="flex items-center gap-3">
              <div className="rounded-lg p-2 bg-green-50"><TrendingUp size={18} className="text-green-600" /></div>
              <div>
                <p className="text-xs text-muted-foreground">Average readiness</p>
                <p className="text-2xl font-bold">{data?.average_readiness_score ?? 0}%</p>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Recommended Actions */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Target size={16} /> Recommended Actions
            </CardTitle>
            <CardDescription>Prioritized actions to improve campaign readiness.</CardDescription>
          </CardHeader>
          <CardContent>
            {!data?.recommended_actions.length ? (
              <p className="text-sm text-muted-foreground text-center py-6">
                No actions needed — great readiness!
              </p>
            ) : (
              <div className="space-y-3">
                {data.recommended_actions.map((action, i) => (
                  <div key={i} className={cn("rounded-lg border p-3", URGENCY_COLOR[action.urgency])}>
                    <div className="flex items-start gap-2">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium">{action.title}</p>
                        <p className="text-xs opacity-80 mt-0.5">{action.reason}</p>
                      </div>
                      <Badge variant="outline" className="text-xs capitalize shrink-0 border-current">
                        {action.urgency}
                      </Badge>
                    </div>
                    {action.occasion_id && (
                      <Button variant="ghost" size="sm" className="mt-2 h-7 text-xs px-2"
                        onClick={() => setLocation(`/occasion-campaigns/occasions/${action.occasion_id}`)}>
                        View occasion <ArrowRight size={12} className="ml-1" />
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Upcoming Critical Occasions */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Star size={16} /> Upcoming Critical Occasions
            </CardTitle>
            <CardDescription>High-priority occasions in the next 45 days.</CardDescription>
          </CardHeader>
          <CardContent>
            {!data?.upcoming_critical.length ? (
              <p className="text-sm text-muted-foreground text-center py-6">No critical occasions in the next 45 days.</p>
            ) : (
              <ul className="divide-y divide-border">
                {data.upcoming_critical.map((occ) => (
                  <li key={occ.id} className="py-3 cursor-pointer hover:bg-muted/20 -mx-2 px-2 rounded transition-colors"
                    onClick={() => setLocation(`/occasion-campaigns/occasions/${occ.id}`)}>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium">{occ.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {occ.next_occurrence} · {occ.days_until}d away · {occ.markets.join(", ")}
                        </p>
                      </div>
                      <Badge variant="outline" className={cn("text-xs capitalize", TYPE_COLOR[occ.type])}>
                        {occ.type.replace(/_/g, " ")}
                      </Badge>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Occasions Missing Plans */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle size={16} /> Occasions Without Plans
            </CardTitle>
            <CardDescription>These occasions need campaign plans assigned.</CardDescription>
          </CardHeader>
          <CardContent>
            {!data?.missing_plans.length ? (
              <p className="text-sm text-muted-foreground text-center py-6">
                All occasions have campaign plans! 🎉
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {data.missing_plans.map((occ) => (
                  <li key={occ.id} className="py-3 cursor-pointer hover:bg-muted/20 -mx-2 px-2 rounded transition-colors"
                    onClick={() => setLocation(`/occasion-campaigns/occasions/${occ.id}`)}>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium">{occ.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {occ.days_until !== null ? `${occ.days_until}d away` : "No date"}
                          {occ.markets.length > 0 && ` · ${occ.markets.join(", ")}`}
                        </p>
                      </div>
                      <Badge variant="outline" className={cn("text-xs capitalize", PRIORITY_COLOR[occ.priority])}>
                        {occ.priority}
                      </Badge>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Campaigns This Week */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Zap size={16} /> Campaigns Launching This Week
            </CardTitle>
            <CardDescription>Campaign plans with target dates in the next 7 days.</CardDescription>
          </CardHeader>
          <CardContent>
            {!data?.campaigns_this_week.length ? (
              <p className="text-sm text-muted-foreground text-center py-6">No campaigns launching this week.</p>
            ) : (
              <ul className="divide-y divide-border">
                {data.campaigns_this_week.map((plan) => (
                  <li key={plan.id} className="py-3 cursor-pointer hover:bg-muted/20 -mx-2 px-2 rounded transition-colors"
                    onClick={() => setLocation(`/occasion-campaigns/plans/${plan.id}`)}>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium">{plan.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {plan.occasion_name} · {plan.target_date}
                          {plan.days_until !== null && ` · ${plan.days_until}d`}
                        </p>
                      </div>
                      <PhaseBadge phase={plan.campaign_phase} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* Revenue placeholder */}
        <Card className="lg:col-span-2">
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <TrendingUp size={16} /> Revenue Attribution
            </CardTitle>
            <CardDescription>Sales data attributed to occasion campaigns will appear here.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="rounded-lg border border-dashed border-border bg-muted/20 py-12 text-center">
              <TrendingUp size={32} className="mx-auto text-muted-foreground mb-3" />
              <p className="text-sm font-medium text-muted-foreground">Revenue attribution coming soon</p>
              <p className="text-xs text-muted-foreground mt-1">Sales data by occasion will appear here when orders are linked.</p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
