import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { AnalyticsExportMenu } from "@/components/AnalyticsExportMenu";
import { datasetsFromResponse } from "@/lib/analytics-export";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
} from "recharts";
import {
  MessageSquare,
  Clock,
  CheckCircle2,
  AlertTriangle,
  Zap,
  Users,
  Tag,
  Wifi,
  WifiOff,
  RefreshCw,
} from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

type Days = 7 | 14 | 30 | 90;

interface OverviewData {
  success: boolean;
  days: number;
  total_conversations: number;
  messages_by_day: { date: string; inbound: number; outbound: number }[];
  avg_first_response_seconds: number | null;
  avg_resolution_seconds: number | null;
  automation_resolution_rate: number | null;
  human_handoff_rate: number | null;
  failed_outbound_count: number;
  top_tags: { name: string; count: number }[];
  webhook_failure_count: number;
}

interface ChannelData {
  success: boolean;
  channels: {
    id: number;
    provider: string;
    name: string;
    status: string;
    last_webhook_received_at: string | null;
    last_error: string | null;
    conversation_count: number;
    message_count: number;
    failed_webhook_count: number;
  }[];
}

function formatSeconds(secs: number | null): string {
  if (secs === null) return "—";
  if (secs < 60) return `${Math.round(secs)}s`;
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  return `${(secs / 3600).toFixed(1)}h`;
}

function formatPct(rate: number | null): string {
  if (rate === null) return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

function formatLastSeen(ts: string | null): string {
  if (!ts) return "Never";
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const msgChartConfig: ChartConfig = {
  inbound: { label: "Inbound", color: "hsl(210, 100%, 45%)" },
  outbound: { label: "Outbound", color: "hsl(160, 60%, 45%)" },
};

const tagChartConfig: ChartConfig = {
  count: { label: "Uses", color: "hsl(270, 60%, 55%)" },
};

const DAY_OPTIONS: { label: string; value: Days }[] = [
  { label: "7d", value: 7 },
  { label: "14d", value: 14 },
  { label: "30d", value: 30 },
  { label: "90d", value: 90 },
];

export default function OmnichannelAnalyticsPage() {
  const [days, setDays] = useState<Days>(30);

  const {
    data: overview,
    isLoading: overviewLoading,
    isError: overviewError,
    refetch: refetchOverview,
  } = useQuery<OverviewData>({
    queryKey: ["omnichannel-analytics-overview", days],
    queryFn: () => apiFetch(`/api/omnichannel/analytics/overview?days=${days}`),
  });

  const { data: channels, isLoading: channelsLoading } = useQuery<ChannelData>({
    queryKey: ["omnichannel-analytics-channels", days],
    queryFn: () => apiFetch(`/api/omnichannel/analytics/channels?days=${days}`),
  });

  const isLoading = overviewLoading || channelsLoading;

  const kpis = overview
    ? [
        {
          label: "Total Conversations",
          value: overview.total_conversations.toLocaleString(),
          icon: MessageSquare,
          color: "text-blue-600",
        },
        {
          label: "Avg First Response",
          value: formatSeconds(overview.avg_first_response_seconds),
          icon: Clock,
          color: "text-amber-600",
        },
        {
          label: "Avg Resolution Time",
          value: formatSeconds(overview.avg_resolution_seconds),
          icon: CheckCircle2,
          color: "text-green-600",
        },
        {
          label: "Automation Resolution",
          value: formatPct(overview.automation_resolution_rate),
          icon: Zap,
          color: "text-purple-600",
        },
        {
          label: "Human Handoff Rate",
          value: formatPct(overview.human_handoff_rate),
          icon: Users,
          color: "text-indigo-600",
        },
        {
          label: "Failed Outbound",
          value: overview.failed_outbound_count.toLocaleString(),
          icon: AlertTriangle,
          color: overview.failed_outbound_count > 0 ? "text-red-600" : "text-muted-foreground",
        },
        {
          label: "Webhook Failures",
          value: overview.webhook_failure_count.toLocaleString(),
          icon: AlertTriangle,
          color: overview.webhook_failure_count > 0 ? "text-orange-600" : "text-muted-foreground",
        },
      ]
    : [];

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Omnichannel Analytics</h1>
          <p className="text-muted-foreground text-sm mt-0.5">
            Conversation and messaging metrics across all channels
          </p>
        </div>
        <div className="flex items-center gap-2">
          <AnalyticsExportMenu
            filename="omnichannel-analytics"
            title="Omnichannel Analytics"
            filterSummary={`days: ${days}`}
            getDatasets={() => [
              ...datasetsFromResponse(overview),
              ...datasetsFromResponse(channels),
            ]}
            disabled={isLoading || !overview}
          />
          {DAY_OPTIONS.map((opt) => (
            <Button
              key={opt.value}
              variant={days === opt.value ? "default" : "outline"}
              size="sm"
              onClick={() => setDays(opt.value)}
            >
              {opt.label}
            </Button>
          ))}
          <Button
            variant="ghost"
            size="icon"
            onClick={() => refetchOverview()}
            disabled={isLoading}
            title="Refresh"
          >
            <RefreshCw className={cn("w-4 h-4", isLoading && "animate-spin")} />
          </Button>
        </div>
      </div>

      {isLoading && (
        <div className="flex justify-center py-16">
          <Spinner className="size-8 text-primary" />
        </div>
      )}

      {overviewError && !isLoading && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center">
          <p className="text-destructive font-medium">Failed to load analytics</p>
          <Button variant="outline" size="sm" className="mt-3" onClick={() => refetchOverview()}>
            Retry
          </Button>
        </div>
      )}

      {overview && !isLoading && (
        <>
          {/* KPI Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {kpis.map((kpi) => (
              <Card key={kpi.label}>
                <CardContent className="p-4">
                  <div className="flex items-start justify-between">
                    <p className="text-xs text-muted-foreground font-medium">{kpi.label}</p>
                    <kpi.icon className={cn("w-4 h-4 mt-0.5", kpi.color)} />
                  </div>
                  <p className="text-2xl font-bold mt-1 tracking-tight">{kpi.value}</p>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Messages by Day line chart */}
          {overview.messages_by_day.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-semibold">Messages per Day</CardTitle>
              </CardHeader>
              <CardContent>
                <ChartContainer config={msgChartConfig} className="h-64 w-full">
                  <LineChart data={overview.messages_by_day}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                    <XAxis
                      dataKey="date"
                      tick={{ fontSize: 11 }}
                      tickFormatter={(v: string) => {
                        const d = new Date(v + "T00:00:00Z");
                        return d.toLocaleDateString(undefined, {
                          month: "short",
                          day: "numeric",
                          timeZone: "UTC",
                        });
                      }}
                    />
                    <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Line
                      type="monotone"
                      dataKey="inbound"
                      stroke="hsl(210, 100%, 45%)"
                      strokeWidth={2}
                      dot={false}
                      name="Inbound"
                    />
                    <Line
                      type="monotone"
                      dataKey="outbound"
                      stroke="hsl(160, 60%, 45%)"
                      strokeWidth={2}
                      dot={false}
                      name="Outbound"
                    />
                  </LineChart>
                </ChartContainer>
              </CardContent>
            </Card>
          )}

          {/* Top Tags bar chart */}
          {overview.top_tags.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-sm font-semibold flex items-center gap-1.5">
                  <Tag className="w-4 h-4" />
                  Top Tags
                </CardTitle>
              </CardHeader>
              <CardContent>
                <ChartContainer config={tagChartConfig} className="h-48 w-full">
                  <BarChart data={overview.top_tags}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Bar dataKey="count" fill="hsl(270, 60%, 55%)" radius={[3, 3, 0, 0]} name="Uses" />
                  </BarChart>
                </ChartContainer>
              </CardContent>
            </Card>
          )}
        </>
      )}

      {/* Channel Health Cards */}
      {channels && channels.channels.length > 0 && (
        <div>
          <h2 className="text-base font-semibold mb-3">Channel Health</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {channels.channels.map((ch) => {
              const isHealthy = ch.status === "connected" && ch.failed_webhook_count === 0;
              const isError = ch.status === "error" || ch.failed_webhook_count > 5;
              return (
                <Card
                  key={ch.id}
                  className={cn(
                    "border",
                    isError && "border-destructive/40 bg-destructive/5",
                    !isError && isHealthy && "border-green-200 bg-green-50/30",
                  )}
                >
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="font-medium text-sm leading-none">{ch.name}</p>
                        <p className="text-xs text-muted-foreground mt-0.5 capitalize">{ch.provider}</p>
                      </div>
                      {ch.status === "connected" ? (
                        <Wifi className="w-4 h-4 text-green-600 shrink-0" />
                      ) : (
                        <WifiOff className="w-4 h-4 text-muted-foreground shrink-0" />
                      )}
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                      <div>
                        <p className="text-muted-foreground">Conversations</p>
                        <p className="font-semibold">{ch.conversation_count}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Messages</p>
                        <p className="font-semibold">{ch.message_count}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Last event</p>
                        <p className="font-semibold">{formatLastSeen(ch.last_webhook_received_at)}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Failed webhooks</p>
                        <p
                          className={cn(
                            "font-semibold",
                            ch.failed_webhook_count > 0 ? "text-destructive" : "text-green-600",
                          )}
                        >
                          {ch.failed_webhook_count}
                        </p>
                      </div>
                    </div>
                    {ch.last_error && (
                      <p className="mt-2 text-[11px] text-destructive truncate" title={ch.last_error}>
                        {ch.last_error}
                      </p>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
