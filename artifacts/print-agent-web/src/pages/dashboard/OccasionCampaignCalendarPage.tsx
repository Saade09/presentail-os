import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CalendarDays, LayoutGrid, List, ChevronLeft, ChevronRight,
  Star, Zap, Target, TrendingUp, AlertTriangle, BarChart2,
} from "lucide-react";
import { useLocation } from "wouter";
import { apiFetch } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

// ── Shared types ───────────────────────────────────────────────────────────
export type Occasion = {
  id: number;
  name: string;
  type: string;
  priority: string;
  status: string;
  markets: string[];
  product_focus: string | null;
  recommended_channels: string[];
  campaign_start_days_before: number;
  month: number | null;
  day: number | null;
  notes: string | null;
  description: string | null;
  recurrence: string;
  preparation_days: number | null;
  demand_level: string | null;
  owner_user_id: string | null;
  tags: string[];
  is_active: boolean;
  next_occurrence: string | null;
  days_until: number | null;
  campaign_phase: string | null;
};

export type CampaignPlan = {
  id: number;
  occasion_id: number;
  occasion_name?: string;
  occasion_type?: string;
  name: string;
  target_date: string;
  markets: string[];
  budget: number | null;
  currency: string;
  notes: string | null;
  status: string;
  channel: string | null;
  market: string | null;
  owner_user_id: string | null;
  start_date: string | null;
  end_date: string | null;
  goal: string | null;
  days_until: number | null;
  campaign_phase: string | null;
};

export type OccasionType = {
  id: number;
  name: string;
  color: string;
  description: string | null;
};

export type Summary = {
  upcoming_occasions_count: number;
  next_occasion: { name: string; days_away: number } | null;
  campaigns_launching_this_week: number;
  high_priority_market_count: number;
  occasions_missing_plans: number;
  average_readiness_score: number;
};

// ── Constants ─────────────────────────────────────────────────────────────
export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const TYPE_COLOR: Record<string, string> = {
  high_priority: "bg-red-100 text-red-800 border-red-200",
  religious: "bg-purple-100 text-purple-800 border-purple-200",
  seasonal: "bg-green-100 text-green-800 border-green-200",
  corporate: "bg-blue-100 text-blue-800 border-blue-200",
  promotional: "bg-amber-100 text-amber-800 border-amber-200",
  personal: "bg-pink-100 text-pink-800 border-pink-200",
};

export const TYPE_DOT: Record<string, string> = {
  high_priority: "bg-red-400",
  religious: "bg-purple-400",
  seasonal: "bg-green-400",
  corporate: "bg-blue-400",
  promotional: "bg-amber-400",
  personal: "bg-pink-400",
};

export const PRIORITY_COLOR: Record<string, string> = {
  high: "bg-red-100 text-red-700 border-red-200",
  medium: "bg-amber-100 text-amber-700 border-amber-200",
  low: "bg-gray-100 text-gray-600 border-gray-200",
};

export const ALL_MARKETS = ["UAE", "KSA", "Lebanon", "Kuwait", "Bahrain", "Oman", "Jordan", "Egypt"];
export const CURRENCIES = ["AED", "USD", "EUR", "GBP", "SAR", "KWD", "QAR"];
export const PLAN_STATUSES = ["draft", "in_progress", "launched", "completed", "paused"];

// ── Phase badge ────────────────────────────────────────────────────────────
export function PhaseBadge({ phase }: { phase: string | null }) {
  if (!phase) return null;
  const color =
    phase === "Live today" ? "bg-green-500 text-white" :
    phase === "Urgency" || phase === "Last chance" ? "bg-red-500 text-white" :
    phase === "Main push" ? "bg-amber-500 text-white" :
    phase === "Pre-launch" ? "bg-blue-500 text-white" :
    phase === "Retention" ? "bg-purple-500 text-white" :
    phase === "Completed" ? "bg-gray-400 text-white" :
    "bg-slate-100 text-slate-700";
  return (
    <span className={cn("text-xs font-semibold px-2 py-0.5 rounded-full", color)}>
      {phase}
    </span>
  );
}

// ── KPI Card ───────────────────────────────────────────────────────────────
export function KpiCard({
  icon, label, value, sub, color, onClick,
}: {
  icon: React.ReactNode; label: string; value: string | number;
  sub?: string; color: string; onClick?: () => void;
}) {
  return (
    <Card className={cn(onClick && "cursor-pointer hover:shadow-md transition-shadow")}>
      <CardContent className="pt-5 pb-4" onClick={onClick}>
        <div className="flex items-start gap-3">
          <div className={cn("rounded-lg p-2 shrink-0", color)}>{icon}</div>
          <div className="min-w-0">
            <p className="text-sm text-muted-foreground">{label}</p>
            <p className="text-2xl font-bold mt-0.5">{value}</p>
            {sub && <p className="text-xs text-muted-foreground mt-0.5 truncate">{sub}</p>}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Calendar helpers ───────────────────────────────────────────────────────
function buildCalendarDays(year: number, month: number): (Date | null)[] {
  const firstDay = new Date(Date.UTC(year, month, 1));
  const lastDay = new Date(Date.UTC(year, month + 1, 0));
  const startDow = firstDay.getUTCDay();
  const days: (Date | null)[] = [];
  for (let i = 0; i < startDow; i++) days.push(null);
  for (let d = 1; d <= lastDay.getUTCDate(); d++) days.push(new Date(Date.UTC(year, month, d)));
  while (days.length % 7 !== 0) days.push(null);
  return days;
}

function occasionsForDate(occasions: Occasion[], date: Date): Occasion[] {
  const m = date.getUTCMonth() + 1;
  const d = date.getUTCDate();
  return occasions.filter((occ) => occ.month === m && occ.day === d);
}

// ── Tab constants ──────────────────────────────────────────────────────────
type Tab = "calendar" | "occasions" | "plans" | "readiness" | "insights";

const TABS: { id: Tab; label: string }[] = [
  { id: "calendar", label: "Calendar" },
  { id: "occasions", label: "Occasions" },
  { id: "plans", label: "Campaign Plans" },
  { id: "readiness", label: "Readiness Board" },
  { id: "insights", label: "Insights" },
];

// ── Calendar tab ───────────────────────────────────────────────────────────
function CalendarTab({ occasions, plans }: { occasions: Occasion[]; plans: CampaignPlan[] }) {
  const now = new Date();
  const [, setLocation] = useLocation();
  const [viewYear, setViewYear] = useState(now.getFullYear());
  const [viewMonth, setViewMonth] = useState(now.getMonth());
  const [viewMode, setViewMode] = useState<"calendar" | "list">("calendar");
  const [marketFilter, setMarketFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [priorityFilter, setPriorityFilter] = useState("all");

  const calendarDays = useMemo(() => buildCalendarDays(viewYear, viewMonth), [viewYear, viewMonth]);
  const isCurrentMonth = viewYear === now.getFullYear() && viewMonth === now.getMonth();

  const filteredOccasions = useMemo(() => {
    return occasions.filter((occ) => {
      if (marketFilter !== "all" && !occ.markets.includes(marketFilter)) return false;
      if (typeFilter !== "all" && occ.type !== typeFilter) return false;
      if (priorityFilter !== "all" && occ.priority !== priorityFilter) return false;
      return true;
    });
  }, [occasions, marketFilter, typeFilter, priorityFilter]);

  const listOccasions = useMemo(() => {
    return [...filteredOccasions]
      .filter((occ) => occ.month !== null)
      .sort((a, b) => {
        if ((a.month ?? 0) !== (b.month ?? 0)) return (a.month ?? 0) - (b.month ?? 0);
        return (a.day ?? 0) - (b.day ?? 0);
      });
  }, [filteredOccasions]);

  const allMarkets = useMemo(() => {
    const set = new Set<string>();
    for (const occ of occasions) for (const m of occ.markets) set.add(m);
    return Array.from(set).sort();
  }, [occasions]);

  const allTypes = useMemo(() => {
    const set = new Set<string>();
    for (const occ of occasions) set.add(occ.type);
    return Array.from(set).sort();
  }, [occasions]);

  function prevMonth() {
    if (viewMonth === 0) { setViewYear((y) => y - 1); setViewMonth(11); }
    else setViewMonth((m) => m - 1);
  }
  function nextMonth() {
    if (viewMonth === 11) { setViewYear((y) => y + 1); setViewMonth(0); }
    else setViewMonth((m) => m + 1);
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon" onClick={prevMonth}><ChevronLeft size={16} /></Button>
          <h2 className="text-base font-semibold w-36 text-center">{MONTH_NAMES[viewMonth]} {viewYear}</h2>
          <Button variant="outline" size="icon" onClick={nextMonth}><ChevronRight size={16} /></Button>
          {!isCurrentMonth && (
            <Button variant="ghost" size="sm" onClick={() => { setViewYear(now.getFullYear()); setViewMonth(now.getMonth()); }}>
              Today
            </Button>
          )}
        </div>
        <div className="flex items-center gap-2 ml-auto flex-wrap">
          <Select value={marketFilter} onValueChange={setMarketFilter}>
            <SelectTrigger className="h-8 w-32 text-xs"><SelectValue placeholder="All markets" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All markets</SelectItem>
              {allMarkets.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="h-8 w-32 text-xs"><SelectValue placeholder="All types" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              {allTypes.map((t) => <SelectItem key={t} value={t}>{t.replace(/_/g, " ")}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={priorityFilter} onValueChange={setPriorityFilter}>
            <SelectTrigger className="h-8 w-28 text-xs"><SelectValue placeholder="All priorities" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All priorities</SelectItem>
              <SelectItem value="high">High</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
              <SelectItem value="low">Low</SelectItem>
            </SelectContent>
          </Select>
          <div className="flex rounded-lg border border-border overflow-hidden">
            <button type="button" onClick={() => setViewMode("calendar")}
              className={cn("px-2.5 py-1.5 text-xs flex items-center gap-1.5 transition-colors",
                viewMode === "calendar" ? "bg-primary text-primary-foreground" : "hover:bg-secondary")}>
              <LayoutGrid size={13} /> Month
            </button>
            <button type="button" onClick={() => setViewMode("list")}
              className={cn("px-2.5 py-1.5 text-xs flex items-center gap-1.5 border-l border-border transition-colors",
                viewMode === "list" ? "bg-primary text-primary-foreground" : "hover:bg-secondary")}>
              <List size={13} /> List
            </button>
          </div>
        </div>
      </div>

      {viewMode === "calendar" ? (
        <Card>
          <CardContent className="p-0">
            <div className="grid grid-cols-7 border-b border-border">
              {DAY_NAMES.map((d) => (
                <div key={d} className="text-center text-xs font-medium text-muted-foreground py-2">{d}</div>
              ))}
            </div>
            <div className="grid grid-cols-7">
              {calendarDays.map((date, i) => {
                if (!date) return <div key={`empty-${i}`} className="border-r border-b border-border/50 min-h-[90px]" />;
                const isToday = date.getUTCFullYear() === now.getFullYear() &&
                  date.getUTCMonth() === now.getMonth() && date.getUTCDate() === now.getDate();
                const dayOccs = occasionsForDate(filteredOccasions, date);
                return (
                  <div key={date.toISOString()}
                    className={cn("border-r border-b border-border/50 min-h-[90px] p-1.5", (i + 1) % 7 === 0 && "border-r-0")}>
                    <div className={cn("text-xs font-medium w-6 h-6 flex items-center justify-center rounded-full mb-1",
                      isToday ? "bg-primary text-primary-foreground" : "text-muted-foreground")}>
                      {date.getUTCDate()}
                    </div>
                    <div className="space-y-0.5">
                      {dayOccs.map((occ) => (
                        <button key={occ.id} type="button"
                          onClick={() => setLocation(`/occasion-campaigns/occasions/${occ.id}`)}
                          className={cn(
                            "w-full text-left text-[10px] font-medium px-1.5 py-0.5 rounded border truncate leading-tight transition-opacity hover:opacity-80",
                            TYPE_COLOR[occ.type] ?? "bg-gray-100 text-gray-700 border-gray-200"
                          )}
                          title={occ.name}>
                          {occ.name}
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">All occasions — chronological</CardTitle>
          </CardHeader>
          <CardContent>
            {listOccasions.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">No occasions match the selected filters.</p>
            ) : (
              <ul className="divide-y divide-border">
                {listOccasions.map((occ) => (
                  <li key={occ.id}
                    className="py-3 flex items-center gap-3 cursor-pointer hover:bg-muted/30 rounded-lg px-2 -mx-2 transition-colors"
                    onClick={() => setLocation(`/occasion-campaigns/occasions/${occ.id}`)}>
                    <span className={cn("w-2.5 h-2.5 rounded-full shrink-0", TYPE_DOT[occ.type] ?? "bg-gray-400")} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-medium">{occ.name}</span>
                        <PhaseBadge phase={occ.campaign_phase} />
                        <Badge variant="outline" className={cn("text-xs capitalize", PRIORITY_COLOR[occ.priority])}>
                          {occ.priority}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {occ.next_occurrence ?? "—"}
                        {occ.days_until !== null && ` · ${occ.days_until} days away`}
                        {occ.markets.length > 0 && ` · ${occ.markets.join(", ")}`}
                      </p>
                    </div>
                    <Badge variant="outline" className={cn("text-xs capitalize shrink-0", TYPE_COLOR[occ.type])}>
                      {occ.type.replace(/_/g, " ")}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      {/* Upcoming plans card */}
      {plans.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">Upcoming Campaign Plans</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
              {plans
                .filter((p) => p.target_date >= new Date().toISOString().split("T")[0])
                .slice(0, 5)
                .map((plan) => (
                  <li key={plan.id} className="flex items-center gap-3 py-2 border-b border-border/50 last:border-0">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{plan.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {plan.occasion_name} · {plan.target_date}
                        {plan.days_until !== null && ` · ${plan.days_until}d`}
                      </p>
                    </div>
                    <Badge variant="outline" className="text-xs capitalize shrink-0">{plan.status}</Badge>
                  </li>
                ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────
export default function OccasionCampaignCalendarPage() {
  const [activeTab, setActiveTab] = useState<Tab>(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    return t && ["calendar", "occasions", "plans", "readiness", "insights"].includes(t)
      ? (t as Tab)
      : "calendar";
  });

  const summaryQuery = useQuery({
    queryKey: ["/api/occasion-campaigns/summary"],
    queryFn: () => apiFetch<Summary>("/api/occasion-campaigns/summary"),
  });

  const occasionsQuery = useQuery({
    queryKey: ["/api/occasion-campaigns/occasions"],
    queryFn: () => apiFetch<{ occasions: Occasion[] }>("/api/occasion-campaigns/occasions"),
  });

  const plansQuery = useQuery({
    queryKey: ["/api/occasion-campaigns/plans"],
    queryFn: () => apiFetch<{ plans: CampaignPlan[] }>("/api/occasion-campaigns/plans"),
  });

  const summary = summaryQuery.data;
  const occasions = occasionsQuery.data?.occasions ?? [];
  const plans = plansQuery.data?.plans ?? [];

  if (occasionsQuery.isPending || summaryQuery.isPending) {
    return (
      <div className="space-y-6">
        <div className="h-8 w-64 bg-muted animate-pulse rounded" />
        <div className="grid grid-cols-4 gap-4">
          {[0, 1, 2, 3].map((i) => <div key={i} className="h-24 bg-muted animate-pulse rounded-lg" />)}
        </div>
        <div className="h-96 bg-muted animate-pulse rounded-lg" />
      </div>
    );
  }

  if (occasionsQuery.isError) {
    return (
      <div className="text-center py-16">
        <p className="text-destructive">Failed to load occasion campaigns.</p>
        <Button variant="outline" className="mt-4" onClick={() => void occasionsQuery.refetch()}>Retry</Button>
      </div>
    );
  }

  // Lazy-load tab content
  const TabContent = getTabContent(activeTab);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-3xl font-bold flex items-center gap-2">
          <CalendarDays className="h-7 w-7" />
          Occasion Campaigns
        </h1>
        <p className="text-muted-foreground mt-1">
          Plan and track marketing campaigns around key flower e-commerce occasions.
        </p>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          icon={<Star size={18} className="text-amber-600" />}
          label="Upcoming critical occasions"
          value={summary?.upcoming_occasions_count ?? 0}
          sub={summary?.next_occasion ? `Next: ${summary.next_occasion.name} in ${summary.next_occasion.days_away}d` : undefined}
          color="bg-amber-50"
          onClick={() => setActiveTab("occasions")}
        />
        <KpiCard
          icon={<Zap size={18} className="text-blue-600" />}
          label="Campaigns launching this week"
          value={summary?.campaigns_launching_this_week ?? 0}
          color="bg-blue-50"
          onClick={() => setActiveTab("plans")}
        />
        <KpiCard
          icon={<AlertTriangle size={18} className="text-red-600" />}
          label="Occasions missing plans"
          value={summary?.occasions_missing_plans ?? 0}
          color="bg-red-50"
          onClick={() => setActiveTab("readiness")}
        />
        <KpiCard
          icon={<BarChart2 size={18} className="text-green-600" />}
          label="Average readiness score"
          value={`${summary?.average_readiness_score ?? 0}%`}
          color="bg-green-50"
          onClick={() => setActiveTab("insights")}
        />
      </div>

      {/* Tabs */}
      <div className="border-b border-border">
        <nav className="flex gap-0 overflow-x-auto">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={cn(
                "px-4 py-2.5 text-sm font-medium border-b-2 whitespace-nowrap transition-colors",
                activeTab === tab.id
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground hover:border-border",
              )}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Tab content */}
      <TabContent occasions={occasions} plans={plans} summary={summary} />
    </div>
  );
}

// ── Tab content lazy loader ─────────────────────────────────────────────────

type TabProps = { occasions: Occasion[]; plans: CampaignPlan[]; summary: Summary | undefined };

function getTabContent(tab: Tab): React.ComponentType<TabProps> {
  switch (tab) {
    case "calendar": return (props) => <CalendarTab occasions={props.occasions} plans={props.plans} />;
    case "occasions": return OccasionsTab;
    case "plans": return PlansTab;
    case "readiness": return ReadinessBoardTab;
    case "insights": return InsightsTab;
  }
}

// ── Forward references for tabs (defined in same file for simplicity) ──────

import { OccasionsTab } from "./occasionCampaigns/OccasionsTab";
import { PlansTab } from "./occasionCampaigns/PlansTab";
import { ReadinessBoardTab } from "./occasionCampaigns/ReadinessBoardTab";
import { InsightsTab } from "./occasionCampaigns/InsightsTab";
