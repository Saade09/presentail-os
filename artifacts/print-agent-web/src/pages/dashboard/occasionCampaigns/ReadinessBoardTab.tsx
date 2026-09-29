import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { AlertTriangle, CheckCircle2, Clock, Zap, Flag } from "lucide-react";
import { apiFetch } from "@/lib/queryClient";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { type Occasion, TYPE_DOT } from "../OccasionCampaignCalendarPage";

type BoardEntry = {
  id: number;
  name: string;
  type: string;
  priority: string;
  markets: string[];
  days_until: number | null;
  next_occurrence: string | null;
  readiness_score: number;
  readiness_column: string;
  has_plan: boolean;
  plan_count: number;
  missing_items: string[];
};

type Props = {
  occasions: Occasion[];
  plans: unknown[];
  summary: unknown;
};

const COLUMNS: { id: string; label: string; icon: React.ReactNode; color: string }[] = [
  { id: "needs_planning", label: "Needs Planning", icon: <Flag size={14} />, color: "bg-gray-50 border-gray-200" },
  { id: "in_progress", label: "In Progress", icon: <Clock size={14} />, color: "bg-blue-50 border-blue-200" },
  { id: "at_risk", label: "At Risk", icon: <AlertTriangle size={14} />, color: "bg-red-50 border-red-200" },
  { id: "ready", label: "Ready", icon: <CheckCircle2 size={14} />, color: "bg-green-50 border-green-200" },
  { id: "live", label: "Live", icon: <Zap size={14} />, color: "bg-amber-50 border-amber-200" },
  { id: "completed", label: "Completed", icon: <CheckCircle2 size={14} />, color: "bg-purple-50 border-purple-200" },
];

function ReadinessBar({ score }: { score: number }) {
  const color = score >= 80 ? "bg-green-500" : score >= 50 ? "bg-blue-500" : score >= 30 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="space-y-0.5">
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>Readiness</span>
        <span className={cn("font-semibold", score >= 80 ? "text-green-600" : score >= 50 ? "text-blue-600" : score >= 30 ? "text-amber-600" : "text-red-600")}>
          {score}%
        </span>
      </div>
      <div className="h-1.5 bg-border rounded-full overflow-hidden">
        <div className={cn("h-full rounded-full transition-all", color)} style={{ width: `${score}%` }} />
      </div>
    </div>
  );
}

function OccasionCard({ entry, onClick }: { entry: BoardEntry; onClick: () => void }) {
  const isAtRisk = entry.readiness_column === "at_risk";
  return (
    <div
      onClick={onClick}
      className={cn(
        "bg-white border rounded-lg p-3 cursor-pointer hover:shadow-md transition-all space-y-2",
        isAtRisk ? "border-red-300" : "border-border",
      )}
    >
      <div className="flex items-start gap-2">
        <span className={cn("w-2 h-2 rounded-full shrink-0 mt-1.5", TYPE_DOT[entry.type] ?? "bg-gray-400")} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium leading-tight">{entry.name}</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {entry.days_until !== null
              ? entry.days_until === 0 ? "Today!" : `${entry.days_until}d away`
              : "—"}
            {entry.next_occurrence && <span className="ml-1">· {entry.next_occurrence}</span>}
          </p>
        </div>
      </div>

      <ReadinessBar score={entry.readiness_score} />

      {entry.markets.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {entry.markets.slice(0, 3).map((m) => (
            <Badge key={m} variant="secondary" className="text-[10px] py-0 px-1.5">{m}</Badge>
          ))}
          {entry.markets.length > 3 && <span className="text-[10px] text-muted-foreground">+{entry.markets.length - 3}</span>}
        </div>
      )}

      {entry.missing_items.length > 0 && (
        <div className="space-y-0.5">
          {entry.missing_items.map((item, i) => (
            <p key={i} className="text-[10px] text-red-600 flex items-center gap-1">
              <AlertTriangle size={10} className="shrink-0" /> {item}
            </p>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between text-[10px] text-muted-foreground pt-0.5">
        <span>{entry.plan_count} plan{entry.plan_count !== 1 ? "s" : ""}</span>
        <span className="capitalize font-medium">{entry.priority} priority</span>
      </div>
    </div>
  );
}

export function ReadinessBoardTab({ occasions }: Props) {
  const [, setLocation] = useLocation();

  const boardQuery = useQuery({
    queryKey: ["/api/occasion-campaigns/readiness-board"],
    queryFn: () => apiFetch<{ board: BoardEntry[] }>("/api/occasion-campaigns/readiness-board"),
  });

  const board = boardQuery.data?.board ?? [];

  if (boardQuery.isPending) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4">
        {COLUMNS.map((col) => (
          <div key={col.id} className="space-y-2">
            <div className="h-6 bg-muted animate-pulse rounded" />
            {[0, 1].map((i) => <div key={i} className="h-28 bg-muted animate-pulse rounded-lg" />)}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <p className="text-sm text-muted-foreground">
          {board.length} occasion{board.length !== 1 ? "s" : ""} across {COLUMNS.length} columns
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4 overflow-x-auto">
        {COLUMNS.map((col) => {
          const entries = board.filter((e) => e.readiness_column === col.id);
          return (
            <div key={col.id} className="min-w-0">
              <div className={cn("rounded-lg border p-2 space-y-2 min-h-32", col.color)}>
                <div className="flex items-center gap-1.5 px-1">
                  <span className="text-muted-foreground">{col.icon}</span>
                  <span className="text-xs font-semibold">{col.label}</span>
                  <span className="ml-auto text-xs text-muted-foreground bg-white rounded-full w-5 h-5 flex items-center justify-center border">
                    {entries.length}
                  </span>
                </div>
                <div className="space-y-2">
                  {entries.length === 0 ? (
                    <p className="text-[11px] text-muted-foreground text-center py-4">No occasions</p>
                  ) : (
                    entries.map((entry) => (
                      <OccasionCard
                        key={entry.id}
                        entry={entry}
                        onClick={() => setLocation(`/occasion-campaigns/occasions/${entry.id}`)}
                      />
                    ))
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {board.length === 0 && !boardQuery.isPending && (
        <Card>
          <CardContent className="py-16 text-center text-muted-foreground">
            <p className="text-sm">No occasions found. Create some occasions to see the readiness board.</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
