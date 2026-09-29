import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useGetRevenueOverview,
  getGetRevenueOverviewQueryKey,
  type RevenueOverviewResponse,
  type RevenueOverviewStreamTotals,
  type RevenueOverviewSnapshotMetric,
} from "@workspace/api-client-react";
import {
  TrendingUp,
  TrendingDown,
  Minus,
  Info,
  AlertTriangle,
  RefreshCw,
  CalendarDays,
  CircleCheck,
  CircleAlert,
  CircleX,
  CircleHelp,
} from "lucide-react";
import {
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";
import { AnalyticsExportMenu } from "@/components/AnalyticsExportMenu";
import { TotersImportsSection } from "@/components/TotersImportsSection";
import type { ExportDataset } from "@/lib/analytics-export";
import {
  useRevenueOverviewFilters,
  DATE_PRESETS,
  COMPARE_MODES,
  type CompareMode,
} from "@/hooks/use-revenue-overview-filters";

type StreamKey = "ecommerce" | "retail" | "cmc" | "toters";

/** Fixed stream accent palette: teal / coral / warm gold / violet. */
const STREAM_COLORS: Record<StreamKey, string> = {
  ecommerce: "#0F766E",
  retail: "#E8604C",
  cmc: "#C9962B",
  toters: "#7C5CBF",
};

const STREAM_ORDER: StreamKey[] = ["ecommerce", "retail", "cmc", "toters"];

function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatMoney(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return v.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: v >= 1000 ? 0 : 2,
  });
}

function formatBucketLabel(iso: string, granularity: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  if (granularity === "hour") {
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      timeZone: "UTC",
    });
  }
  if (granularity === "month") {
    return d.toLocaleDateString(undefined, { month: "short", year: "numeric", timeZone: "UTC" });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

/** Change badge with icon + sign so state is not conveyed by color alone. */
function ChangeBadge({ pct, label }: { pct: number | null | undefined; label?: string }) {
  if (pct === null || pct === undefined) {
    return (
      <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground">
        <Minus size={12} aria-hidden />
        <span>—</span>
      </span>
    );
  }
  const rounded = Math.round(pct * 10) / 10;
  if (rounded === 0) {
    return (
      <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground">
        <Minus size={12} aria-hidden />
        <span>0%{label ? ` ${label}` : ""}</span>
      </span>
    );
  }
  const up = rounded > 0;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-xs font-medium",
        up ? "text-green-700" : "text-red-600",
      )}
    >
      {up ? <TrendingUp size={12} aria-hidden /> : <TrendingDown size={12} aria-hidden />}
      <span>
        {up ? "+" : ""}
        {rounded}%{label ? ` ${label}` : ""}
      </span>
    </span>
  );
}

function DefinitionTip({ text, label }: { text: string | undefined; label: string }) {
  if (!text) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          className="inline-flex text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring rounded"
        >
          <Info size={13} aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-xs">{text}</TooltipContent>
    </Tooltip>
  );
}

function KpiSkeleton() {
  return (
    <Card>
      <CardContent className="pt-6 space-y-2">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-3 w-20" />
      </CardContent>
    </Card>
  );
}

function SnapshotCard({
  title,
  metric,
  format,
  tip,
  testId,
  unavailableLabel,
}: {
  title: string;
  metric: RevenueOverviewSnapshotMetric | undefined;
  format: (v: number) => string;
  tip: string;
  testId: string;
  unavailableLabel: string;
}) {
  return (
    <Card data-testid={testId}>
      <CardContent className="pt-6">
        <div className="flex items-center gap-1.5">
          <p className="text-sm text-muted-foreground">{title}</p>
          <DefinitionTip text={tip} label={`${title} definition`} />
        </div>
        {metric?.available && metric.value !== undefined && metric.value !== null ? (
          <p className="text-2xl font-bold mt-1">{format(metric.value)}</p>
        ) : (
          <div className="mt-1">
            <p className="text-lg font-semibold text-muted-foreground">{unavailableLabel}</p>
            {metric?.reason && (
              <p className="text-xs text-muted-foreground mt-0.5">{metric.reason}</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function AnalyticsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const filters = useRevenueOverviewFilters();
  const [hiddenStreams, setHiddenStreams] = useState<Set<StreamKey>>(new Set());

  const { data, isLoading, isError, refetch, dataUpdatedAt, isFetching } = useGetRevenueOverview(
    filters.apiParams,
    {
      query: {
        queryKey: getGetRevenueOverviewQueryKey(filters.apiParams),
        placeholderData: (prev: RevenueOverviewResponse | undefined) => prev,
      },
    },
  );

  const streams = data?.totals?.streams ?? [];
  const streamByKey = useMemo(() => {
    const m = new Map<StreamKey, RevenueOverviewStreamTotals>();
    for (const s of streams) m.set(s.key as StreamKey, s);
    return m;
  }, [streams]);

  const streamLabel = (key: StreamKey) => t(`revenueOverview.streams.${key}`);

  const totalRevenue = data?.totals?.totalRevenue ?? 0;
  const comparisonSelected = Boolean(data?.comparison);

  const availability = data?.availability ?? [];
  const unavailableStreams = availability.filter((a) => !a.available);
  const allUnavailable = availability.length > 0 && unavailableStreams.length === availability.length;
  const isEmpty =
    !isLoading &&
    !isError &&
    data !== undefined &&
    totalRevenue === 0 &&
    unavailableStreams.length === 0 &&
    streams.every((s) => s.revenue === 0 && s.orders === 0);

  const chartData = useMemo(
    () =>
      (data?.series ?? []).map((p) => ({
        bucket: p.bucket,
        ecommerce: p.ecommerce ?? null,
        retail: p.retail ?? null,
        cmc: p.cmc ?? null,
        toters: p.toters ?? null,
        total: p.total,
      })),
    [data?.series],
  );

  const donutData = useMemo(
    () =>
      STREAM_ORDER.map((key) => {
        const s = streamByKey.get(key);
        return {
          key,
          name: streamLabel(key),
          value: s?.revenue ?? 0,
          share: s?.shareOfTotal ?? 0,
        };
      }).filter((d) => d.value > 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [streamByKey, t],
  );

  // Donut shares reconcile to 100% after rounding: adjust the largest slice.
  const donutShares = useMemo(() => {
    if (donutData.length === 0) return donutData;
    const sum = donutData.reduce((s, d) => s + d.share, 0);
    const drift = Math.round((100 - sum) * 10) / 10;
    if (drift === 0) return donutData;
    const largest = donutData.reduce((a, b) => (b.value > a.value ? b : a), donutData[0]);
    return donutData.map((d) =>
      d === largest ? { ...d, share: Math.round((d.share + drift) * 10) / 10 } : d,
    );
  }, [donutData]);

  const toggleStream = (key: StreamKey) => {
    setHiddenStreams((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const lastUpdated = dataUpdatedAt ? new Date(dataUpdatedAt) : null;

  const getDatasets = (): ExportDataset[] => {
    if (!data) return [];
    const period = `${data.range.from} → ${data.range.to}`;
    const comparisonLabel = data.comparison
      ? `${data.comparison.mode}: ${data.comparison.from} → ${data.comparison.to}`
      : t("revenueOverview.compareNone");
    return [
      {
        title: t("revenueOverview.export.summary"),
        rows: [
          { Metric: t("revenueOverview.export.period"), Value: period },
          { Metric: t("revenueOverview.export.comparison"), Value: comparisonLabel },
          { Metric: t("revenueOverview.totalRevenue"), Value: totalRevenue },
          ...streams.map((s) => ({
            Metric: `${streamLabel(s.key as StreamKey)} (${data.currency})`,
            Value: s.revenue,
          })),
        ],
      },
      {
        title: t("revenueOverview.export.streams"),
        rows: streams.map((s) => ({
          Stream: streamLabel(s.key as StreamKey),
          Period: period,
          [`Revenue (${data.currency})`]: s.revenue,
          Orders: s.orders,
          Refunds: s.refunds,
          "Share %": s.shareOfTotal,
          "Comparison revenue": s.comparisonRevenue ?? "",
          "Change %": s.changePct ?? "",
        })),
      },
      {
        title: t("revenueOverview.export.trend"),
        rows: (data.series ?? []).map((p) => ({
          Bucket: p.bucket,
          Period: period,
          [streamLabel("ecommerce")]: p.ecommerce ?? "",
          [streamLabel("retail")]: p.retail ?? "",
          [streamLabel("cmc")]: p.cmc ?? "",
          [streamLabel("toters")]: p.toters ?? "",
          Total: p.total,
        })),
      },
    ];
  };

  const definitions = (data?.definitions ?? {}) as Record<string, string>;

  return (
    <TooltipProvider delayDuration={150}>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">{t("revenueOverview.title")}</h1>
            <p className="text-muted-foreground mt-2">{t("revenueOverview.subtitle")}</p>
          </div>
          <div className="flex items-center gap-3">
            {lastUpdated && (
              <span className="text-xs text-muted-foreground" data-testid="last-updated">
                {t("revenueOverview.lastUpdated", {
                  time: lastUpdated.toLocaleTimeString(),
                })}
                {isFetching ? "…" : ""}
              </span>
            )}
            <AnalyticsExportMenu
              filename="revenue-overview"
              title={t("revenueOverview.title")}
              filterSummary={
                data
                  ? `${data.range.from} → ${data.range.to}${data.comparison ? ` vs ${data.comparison.from} → ${data.comparison.to}` : ""}`
                  : undefined
              }
              getDatasets={getDatasets}
              disabled={isLoading || !data}
            />
          </div>
        </div>

        {/* Range + comparison controls */}
        <div className="flex flex-wrap items-center gap-2">
          <Select value={filters.preset} onValueChange={(v) => filters.setPreset(v as never)}>
            <SelectTrigger className="w-[150px]" data-testid="select-date-preset">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DATE_PRESETS.map((p) => (
                <SelectItem key={p.value} value={p.value}>
                  {t(p.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {filters.preset === "custom" && (
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" className="gap-2" data-testid="button-custom-range">
                  <CalendarDays size={16} aria-hidden />
                  <span className="text-sm">
                    {filters.customFrom && filters.customTo
                      ? `${filters.customFrom} → ${filters.customTo}`
                      : t("storeAnalytics.presets.custom")}
                  </span>
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <div className="flex flex-col gap-2 p-3 sm:flex-row">
                  <div>
                    <p className="mb-1 px-1 text-xs text-muted-foreground">
                      {t("storeAnalytics.from")}
                    </p>
                    <Calendar
                      mode="single"
                      selected={filters.customFrom ? new Date(filters.customFrom) : undefined}
                      onSelect={(d) =>
                        filters.setCustomRange(d ? toISODate(d) : null, filters.customTo)
                      }
                    />
                  </div>
                  <div>
                    <p className="mb-1 px-1 text-xs text-muted-foreground">
                      {t("storeAnalytics.to")}
                    </p>
                    <Calendar
                      mode="single"
                      selected={filters.customTo ? new Date(filters.customTo) : undefined}
                      onSelect={(d) =>
                        filters.setCustomRange(filters.customFrom, d ? toISODate(d) : null)
                      }
                    />
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          )}

          <div className="ml-auto flex items-center gap-2">
            <span className="text-sm text-muted-foreground">
              {t("storeAnalytics.compare.label")}
            </span>
            <Select
              value={filters.compareMode}
              onValueChange={(v) => filters.setCompareMode(v as CompareMode)}
            >
              <SelectTrigger className="w-[190px]" data-testid="select-compare-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {COMPARE_MODES.map((m) => (
                  <SelectItem key={m.value} value={m.value}>
                    {t(m.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {filters.compareMode === "custom" && (
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="gap-2" data-testid="button-compare-range">
                    <CalendarDays size={16} aria-hidden />
                    <span className="text-sm">
                      {filters.compareFrom && filters.compareTo
                        ? `${filters.compareFrom} → ${filters.compareTo}`
                        : t("storeAnalytics.compare.pickRange")}
                    </span>
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="end">
                  <div className="flex flex-col gap-2 p-3 sm:flex-row">
                    <div>
                      <p className="mb-1 px-1 text-xs text-muted-foreground">
                        {t("storeAnalytics.from")}
                      </p>
                      <Calendar
                        mode="single"
                        selected={filters.compareFrom ? new Date(filters.compareFrom) : undefined}
                        onSelect={(d) =>
                          filters.setCompareRange(d ? toISODate(d) : null, filters.compareTo)
                        }
                      />
                    </div>
                    <div>
                      <p className="mb-1 px-1 text-xs text-muted-foreground">
                        {t("storeAnalytics.to")}
                      </p>
                      <Calendar
                        mode="single"
                        selected={filters.compareTo ? new Date(filters.compareTo) : undefined}
                        onSelect={(d) =>
                          filters.setCompareRange(filters.compareFrom, d ? toISODate(d) : null)
                        }
                      />
                    </div>
                  </div>
                </PopoverContent>
              </Popover>
            )}
          </div>
        </div>

        {/* Error state with retry */}
        {isError && (
          <Card data-testid="revenue-error">
            <CardContent className="pt-6 flex flex-col items-center gap-3 py-10 text-center">
              <AlertTriangle size={24} className="text-destructive" aria-hidden />
              <p className="text-sm text-muted-foreground">{t("revenueOverview.loadError")}</p>
              <Button variant="outline" size="sm" onClick={() => refetch()} data-testid="button-retry">
                <RefreshCw size={14} className="mr-1.5" aria-hidden />
                {t("revenueOverview.retry")}
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Partial / unavailable data banners */}
        {!isError && unavailableStreams.length > 0 && !allUnavailable && (
          <div
            className="flex items-start gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-amber-900"
            data-testid="partial-data-banner"
          >
            <AlertTriangle size={18} className="shrink-0 mt-0.5 text-amber-600" aria-hidden />
            <div className="text-sm">
              <p className="font-semibold">
                {t("revenueOverview.partialData", {
                  streams: unavailableStreams
                    .map((a) => streamLabel(a.stream as StreamKey))
                    .join(", "),
                })}
              </p>
              {unavailableStreams.map(
                (a) => a.reason && <p key={a.stream} className="mt-0.5">{a.reason}</p>,
              )}
            </div>
          </div>
        )}
        {/* Empty state: no activity (distinct from unavailable data) */}
        {isEmpty && (
          <Card data-testid="revenue-empty">
            <CardContent className="pt-6 py-10 text-center text-sm text-muted-foreground">
              {t("revenueOverview.emptyState")}
            </CardContent>
          </Card>
        )}

        {!isError && (
          <>
            {/* KPI cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-4">
              {isLoading && !data ? (
                <>
                  <KpiSkeleton />
                  <KpiSkeleton />
                  <KpiSkeleton />
                  <KpiSkeleton />
                  <KpiSkeleton />
                </>
              ) : (
                <>
                  <Card data-testid="kpi-total">
                    <CardContent className="pt-6">
                      <div className="flex items-center gap-1.5">
                        <p className="text-sm text-muted-foreground">
                          {t("revenueOverview.totalRevenue")}
                        </p>
                        <DefinitionTip
                          text={definitions.currency}
                          label={t("revenueOverview.totalRevenue")}
                        />
                      </div>
                      <p className="text-3xl font-bold mt-1" data-testid="kpi-total-value">
                        {formatMoney(totalRevenue)}
                      </p>
                      <div className="mt-1.5 h-4">
                        {comparisonSelected && (
                          <ChangeBadge pct={data?.totals?.totalChangePct ?? null} />
                        )}
                      </div>
                    </CardContent>
                  </Card>
                  {STREAM_ORDER.map((key) => {
                    const s = streamByKey.get(key);
                    const avail = availability.find((a) => a.stream === key);
                    return (
                      <Card
                        key={key}
                        data-testid={`kpi-${key}`}
                        className="border-t-4"
                        style={{ borderTopColor: STREAM_COLORS[key] }}
                      >
                        <CardContent className="pt-6">
                          <p className="text-sm text-muted-foreground">{streamLabel(key)}</p>
                          {avail && !avail.available ? (
                            <p className="text-lg font-semibold text-muted-foreground mt-1">
                              {t("revenueOverview.unavailable")}
                            </p>
                          ) : (
                            <>
                              <p className="text-3xl font-bold mt-1">
                                {formatMoney(s?.revenue ?? 0)}
                              </p>
                              <div className="mt-1.5 flex items-center gap-2 h-4">
                                {comparisonSelected && <ChangeBadge pct={s?.changePct ?? null} />}
                                <span className="text-xs text-muted-foreground">
                                  {t("revenueOverview.shareOfTotal", {
                                    pct: s?.shareOfTotal ?? 0,
                                  })}
                                </span>
                              </div>
                            </>
                          )}
                        </CardContent>
                      </Card>
                    );
                  })}
                </>
              )}
            </div>

            {/* Trend + Mix */}
            <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
              <Card className="xl:col-span-2" data-testid="revenue-trend">
                <CardHeader className="pb-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <CardTitle className="text-base font-semibold">
                      {t("revenueOverview.trendTitle")}
                    </CardTitle>
                    <div className="flex items-center gap-1.5" role="group" aria-label={t("revenueOverview.trendLegend")}>
                      {STREAM_ORDER.map((key) => {
                        const hidden = hiddenStreams.has(key);
                        return (
                          <button
                            key={key}
                            type="button"
                            aria-pressed={!hidden}
                            onClick={() => toggleStream(key)}
                            data-testid={`legend-${key}`}
                            className={cn(
                              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs focus-visible:ring-2 focus-visible:ring-ring",
                              hidden ? "opacity-40 line-through" : "font-medium",
                            )}
                          >
                            <span
                              className="h-2.5 w-2.5 rounded-full"
                              style={{ backgroundColor: STREAM_COLORS[key] }}
                              aria-hidden
                            />
                            {streamLabel(key)}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  {isLoading && !data ? (
                    <Skeleton className="h-64 w-full" data-testid="trend-skeleton" />
                  ) : chartData.length === 0 ? (
                    <div className="h-64 flex items-center justify-center text-sm text-muted-foreground">
                      {t("revenueOverview.noTrendData")}
                    </div>
                  ) : (
                    <div className="h-64 w-full">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart data={chartData} margin={{ top: 8, right: 8, bottom: 4, left: 0 }}>
                          <CartesianGrid vertical={false} strokeDasharray="3 3" />
                          <XAxis
                            dataKey="bucket"
                            tickLine={false}
                            axisLine={false}
                            tick={{ fontSize: 11 }}
                            interval="preserveStartEnd"
                            tickFormatter={(v) => formatBucketLabel(String(v), data?.granularity ?? "day")}
                          />
                          <YAxis
                            tickLine={false}
                            axisLine={false}
                            tick={{ fontSize: 11 }}
                            tickFormatter={(v) => formatMoney(Number(v))}
                            width={72}
                          />
                          <RechartsTooltip
                            formatter={(value: number | string, name: string) => [
                              formatMoney(Number(value)),
                              name,
                            ]}
                            labelFormatter={(v) =>
                              formatBucketLabel(String(v), data?.granularity ?? "day")
                            }
                          />
                          {STREAM_ORDER.filter((k) => !hiddenStreams.has(k)).map((key) => (
                            <Line
                              key={key}
                              type="monotone"
                              dataKey={key}
                              name={streamLabel(key)}
                              stroke={STREAM_COLORS[key]}
                              strokeWidth={2}
                              dot={false}
                              connectNulls={false}
                            />
                          ))}
                          {hiddenStreams.size === 0 && (
                            <Line
                              type="monotone"
                              dataKey="total"
                              name={t("revenueOverview.totalRevenue")}
                              stroke="hsl(var(--muted-foreground))"
                              strokeDasharray="4 4"
                              strokeWidth={1.5}
                              dot={false}
                              connectNulls={false}
                            />
                          )}
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  )}
                  <p className="text-xs text-muted-foreground mt-2">
                    {t("revenueOverview.trendNote", { granularity: data?.granularity ?? "day" })}
                  </p>
                </CardContent>
              </Card>

              <Card data-testid="revenue-mix">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base font-semibold">
                    {t("revenueOverview.mixTitle")}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {isLoading && !data ? (
                    <Skeleton className="h-64 w-full" data-testid="mix-skeleton" />
                  ) : donutShares.length === 0 ? (
                    <div className="h-64 flex items-center justify-center text-sm text-muted-foreground">
                      {t("revenueOverview.noMixData")}
                    </div>
                  ) : (
                    <>
                      <div className="h-44">
                        <ResponsiveContainer width="100%" height="100%">
                          <PieChart>
                            <Pie
                              data={donutShares}
                              dataKey="value"
                              nameKey="name"
                              innerRadius={50}
                              outerRadius={72}
                              paddingAngle={2}
                            >
                              {donutShares.map((d) => (
                                <Cell key={d.key} fill={STREAM_COLORS[d.key as StreamKey]} />
                              ))}
                            </Pie>
                            <RechartsTooltip
                              formatter={(value: number | string, name: string) => [
                                formatMoney(Number(value)),
                                name,
                              ]}
                            />
                          </PieChart>
                        </ResponsiveContainer>
                      </div>
                      {/* Accessible text representation */}
                      <ul className="mt-3 space-y-1.5" data-testid="mix-legend">
                        {donutShares.map((d) => (
                          <li key={d.key} className="flex items-center justify-between text-sm">
                            <span className="inline-flex items-center gap-2">
                              <span
                                className="h-2.5 w-2.5 rounded-full"
                                style={{ backgroundColor: STREAM_COLORS[d.key as StreamKey] }}
                                aria-hidden
                              />
                              {d.name}
                            </span>
                            <span className="font-medium">
                              {d.share}% · {formatMoney(d.value)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </CardContent>
              </Card>
            </div>

            {/* Operating Snapshot */}
            <div>
              <h2 className="text-lg font-semibold mb-3">{t("revenueOverview.snapshotTitle")}</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
                {isLoading && !data ? (
                  <>
                    <KpiSkeleton />
                    <KpiSkeleton />
                    <KpiSkeleton />
                    <KpiSkeleton />
                  </>
                ) : (
                  <>
                    <SnapshotCard
                      title={t("revenueOverview.snapshot.orders")}
                      metric={data?.snapshot?.orders}
                      format={(v) => v.toLocaleString()}
                      tip={t("revenueOverview.snapshot.ordersTip")}
                      testId="snapshot-orders"
                      unavailableLabel={t("revenueOverview.unavailable")}
                    />
                    <SnapshotCard
                      title={t("revenueOverview.snapshot.aov")}
                      metric={data?.snapshot?.aov}
                      format={formatMoney}
                      tip={t("revenueOverview.snapshot.aovTip")}
                      testId="snapshot-aov"
                      unavailableLabel={t("revenueOverview.unavailable")}
                    />
                    <SnapshotCard
                      title={t("revenueOverview.snapshot.grossMargin")}
                      metric={data?.snapshot?.grossMargin}
                      format={(v) => `${v}%`}
                      tip={t("revenueOverview.snapshot.grossMarginTip")}
                      testId="snapshot-gross-margin"
                      unavailableLabel={t("revenueOverview.unavailable")}
                    />
                    <SnapshotCard
                      title={t("revenueOverview.snapshot.refundRate")}
                      metric={data?.snapshot?.refundRate}
                      format={(v) => `${v}%`}
                      tip={t("revenueOverview.snapshot.refundRateTip")}
                      testId="snapshot-refund-rate"
                      unavailableLabel={t("revenueOverview.unavailable")}
                    />
                  </>
                )}
              </div>
            </div>

            {/* Channel Pulse */}
            <Card data-testid="channel-pulse">
              <CardHeader className="pb-2">
                <div className="flex items-center gap-1.5">
                  <CardTitle className="text-base font-semibold">
                    {t("revenueOverview.pulseTitle")}
                  </CardTitle>
                  <DefinitionTip text={definitions.pulse} label={t("revenueOverview.pulseTitle")} />
                </div>
              </CardHeader>
              <CardContent className="space-y-2">
                {isLoading && !data ? (
                  <>
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-10 w-full" />
                    <Skeleton className="h-10 w-full" />
                  </>
                ) : (
                  (data?.pulse ?? []).map((p) => {
                    const status = p.status;
                    const icon =
                      status === "on_track" ? (
                        <CircleCheck size={16} className="text-green-700" aria-hidden />
                      ) : status === "at_risk" ? (
                        <CircleAlert size={16} className="text-amber-600" aria-hidden />
                      ) : status === "off_track" ? (
                        <CircleX size={16} className="text-red-600" aria-hidden />
                      ) : (
                        <CircleHelp size={16} className="text-muted-foreground" aria-hidden />
                      );
                    return (
                      <div
                        key={p.stream}
                        className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2"
                        data-testid={`pulse-${p.stream}`}
                      >
                        <span className="inline-flex items-center gap-2 text-sm font-medium">
                          <span
                            className="h-2.5 w-2.5 rounded-full"
                            style={{ backgroundColor: STREAM_COLORS[p.stream as StreamKey] }}
                            aria-hidden
                          />
                          {streamLabel(p.stream as StreamKey)}
                        </span>
                        <div className="flex items-center gap-3">
                          <ChangeBadge pct={p.changePct ?? null} />
                          <Badge variant="outline" className="gap-1.5">
                            {icon}
                            {t(`revenueOverview.pulseStatus.${status}`)}
                          </Badge>
                        </div>
                        <p className="w-full text-xs text-muted-foreground">{p.reason}</p>
                      </div>
                    );
                  })
                )}
              </CardContent>
            </Card>

            {/* Toters revenue by store */}
            {(data?.totersByStore ?? []).length > 0 && (
              <Card data-testid="toters-by-store">
                <CardHeader className="pb-2">
                  <div className="flex items-center gap-1.5">
                    <CardTitle className="text-base font-semibold">
                      {t("revenueOverview.totersByStoreTitle")}
                    </CardTitle>
                    <DefinitionTip
                      text={definitions.toters}
                      label={t("revenueOverview.totersByStoreTitle")}
                    />
                  </div>
                </CardHeader>
                <CardContent>
                  <ul className="space-y-1.5">
                    {(data?.totersByStore ?? []).map((s) => (
                      <li
                        key={s.store}
                        className="flex items-center justify-between text-sm"
                        data-testid={`toters-store-${s.store}`}
                      >
                        <span className="inline-flex items-center gap-2">
                          <span
                            className="h-2.5 w-2.5 rounded-full"
                            style={{ backgroundColor: STREAM_COLORS.toters }}
                            aria-hidden
                          />
                          {s.store}
                        </span>
                        <span className="font-medium">
                          {formatMoney(s.revenue)} ·{" "}
                          {t("revenueOverview.totersStoreOrders", { count: s.orders })}
                        </span>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )}

            {/* Toters CSV imports */}
            <TotersImportsSection
              onImported={() =>
                queryClient.invalidateQueries({
                  queryKey: getGetRevenueOverviewQueryKey(filters.apiParams),
                })
              }
            />
          </>
        )}
      </div>
    </TooltipProvider>
  );
}
