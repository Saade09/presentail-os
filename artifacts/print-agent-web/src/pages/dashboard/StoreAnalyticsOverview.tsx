import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AnalyticsExportMenu } from "@/components/AnalyticsExportMenu";
import { buildFilterSummary, datasetsFromResponse } from "@/lib/analytics-export";
import {
  useGetStoreExecutiveOverview,
  getGetStoreExecutiveOverviewQueryKey,
  useGetStoreInsights,
  getGetStoreInsightsQueryKey,
  useGetStoreNetRevenueBreakdown,
  getGetStoreNetRevenueBreakdownQueryKey,
  useGetStorePerformanceSummary,
  getGetStorePerformanceSummaryQueryKey,
  type StoreAnalyticsKpis,
  type StoreInsight,
  type StoreRevenueByPeriodItem,
  type GetStoreNetRevenueBreakdownParams,
  type GetStorePerformanceSummaryParams,
} from "@workspace/api-client-react";
import type { UseStoreAnalyticsFilters } from "@/hooks/use-store-analytics-filters";
import { StoreAnalyticsBasisStrip } from "@/components/StoreAnalyticsFilterBar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ComposedChart,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from "recharts";
import {
  TrendingUp,
  TrendingDown,
  Minus,
  XCircle,
  Truck,
  MonitorSmartphone,
  Lightbulb,
  AlertTriangle,
  AlertCircle,
  Info,
  MousePointerClick,
} from "lucide-react";
import { cn } from "@/lib/utils";

const CHART_COLORS = [
  "hsl(210, 100%, 45%)",
  "hsl(160, 84%, 39%)",
  "hsl(35, 92%, 52%)",
  "hsl(280, 65%, 60%)",
  "hsl(340, 82%, 58%)",
  "hsl(190, 90%, 42%)",
  "hsl(50, 92%, 50%)",
];

const BASELINE_COLOR = "hsl(215, 15%, 60%)";

function formatUsd(n: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: n >= 1000 ? 0 : 2,
  }).format(n);
}

function formatPct(n: number): string {
  return `${n.toFixed(1)}%`;
}

function pctChange(current: number, previous: number | null | undefined): number | null {
  if (previous === null || previous === undefined) return null;
  if (previous === 0) return current === 0 ? 0 : null;
  return ((current - previous) / previous) * 100;
}

function DeltaBadge({
  current,
  previous,
  invert = false,
  suffix,
}: {
  current: number;
  previous: number | null | undefined;
  invert?: boolean;
  suffix?: string;
}) {
  if (previous === null || previous === undefined) return null;

  const pct = pctChange(current, previous);
  if (pct === null) {
    return (
      <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground">
        <Minus size={12} />—
      </span>
    );
  }
  const rounded = Math.round(pct);
  if (rounded === 0) {
    return (
      <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground">
        <Minus size={12} />
        0%{suffix ? ` ${suffix}` : ""}
      </span>
    );
  }

  const isUp = rounded > 0;
  const isGood = invert ? !isUp : isUp;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-xs font-medium",
        isGood ? "text-green-600" : "text-red-500",
      )}
    >
      {isUp ? <TrendingUp size={12} /> : <TrendingDown size={12} />}
      {isUp ? "+" : ""}
      {rounded}%{suffix ? <span className="font-normal text-muted-foreground"> {suffix}</span> : null}
    </span>
  );
}

function Sparkline({
  points,
  color,
}: {
  points: { x: string; y: number | null }[];
  color: string;
}) {
  if (points.length < 2 || points.every((p) => p.y === null)) return null;
  return (
    <ChartContainer config={{}} className="h-10 w-full">
      <LineChart data={points} margin={{ top: 4, bottom: 4, left: 0, right: 0 }}>
        <Line
          type="monotone"
          dataKey="y"
          stroke={color}
          strokeWidth={1.5}
          dot={false}
          connectNulls={false}
          isAnimationActive={false}
        />
      </LineChart>
    </ChartContainer>
  );
}

/**
 * Commercial (tier-1) KPI card: big value, delta vs baseline, sparkline,
 * info popover with the exact definition, optional click-through.
 */
function CommercialKpiCard({
  label,
  value,
  current,
  previous,
  invert,
  vsLabel,
  definition,
  spark,
  sparkColor,
  hint,
  onClick,
  testId,
}: {
  label: string;
  value: string;
  current?: number;
  previous?: number | null;
  invert?: boolean;
  vsLabel?: string | null;
  definition: string;
  spark?: { x: string; y: number | null }[];
  sparkColor?: string;
  hint?: string;
  onClick?: () => void;
  testId: string;
}) {
  const { t } = useTranslation();
  return (
    <Card
      className={cn(onClick && "cursor-pointer transition-colors hover:bg-muted/40")}
      onClick={onClick}
      data-testid={testId}
    >
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm text-muted-foreground">{label}</span>
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="shrink-0 text-muted-foreground hover:text-foreground"
                onClick={(e) => e.stopPropagation()}
                aria-label={t("storeAnalytics.definition")}
                data-testid={`${testId}-info`}
              >
                <Info size={14} />
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-72 text-xs" onClick={(e) => e.stopPropagation()}>
              {definition}
            </PopoverContent>
          </Popover>
        </div>
        <div className="mt-2 text-2xl font-semibold tracking-tight">{value}</div>
        <div className="mt-1 flex min-h-4 items-center gap-2">
          {current !== undefined && previous !== undefined && (
            <DeltaBadge
              current={current}
              previous={previous}
              invert={invert}
              suffix={vsLabel ?? undefined}
            />
          )}
          {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
        </div>
        {spark && <Sparkline points={spark} color={sparkColor ?? CHART_COLORS[0]} />}
      </CardContent>
    </Card>
  );
}

/** Operational (tier-2) KPI card — visually smaller and quieter. */
function OperationalKpiCard({
  icon,
  label,
  value,
  current,
  previous,
  invert,
  vsLabel,
  hint,
  testId,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  current?: number;
  previous?: number | null;
  invert?: boolean;
  vsLabel?: string | null;
  hint?: string;
  testId: string;
}) {
  return (
    <Card data-testid={testId}>
      <CardContent className="p-3">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">{label}</span>
          <span className="text-muted-foreground">{icon}</span>
        </div>
        <div className="mt-1 text-lg font-semibold tracking-tight">{value}</div>
        <div className="flex min-h-4 items-center gap-2">
          {current !== undefined && previous !== undefined && (
            <DeltaBadge
              current={current}
              previous={previous}
              invert={invert}
              suffix={vsLabel ?? undefined}
            />
          )}
          {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
        </div>
      </CardContent>
    </Card>
  );
}

function EmptyChart({ message }: { message: string }) {
  return (
    <div className="flex h-[240px] items-center justify-center text-center text-sm text-muted-foreground">
      {message}
    </div>
  );
}

const PERIOD_HIGHLIGHT_COLOR = "hsl(210, 100%, 36%)";

function RevenueByPeriodCard({
  items,
  periodType,
}: {
  items: StoreRevenueByPeriodItem[];
  periodType: "hour" | "dow" | "dom" | "month";
}) {
  const { t, i18n } = useTranslation();
  const isRtl = i18n.dir() === "rtl";

  const titleKey =
    periodType === "hour"
      ? "storeAnalytics.overview.revenueByPeriod.titleHour"
      : periodType === "dow"
        ? "storeAnalytics.overview.revenueByPeriod.titleDow"
        : periodType === "dom"
          ? "storeAnalytics.overview.revenueByPeriod.titleDom"
          : "storeAnalytics.overview.revenueByPeriod.titleMonth";

  const hours: string[] = t("storeAnalytics.overview.revenueByPeriod.hours", {
    returnObjects: true,
  }) as string[];
  const days: string[] = t("storeAnalytics.overview.revenueByPeriod.days", {
    returnObjects: true,
  }) as string[];
  const months: string[] = t("storeAnalytics.overview.revenueByPeriod.months", {
    returnObjects: true,
  }) as string[];

  const formatLabel = (label: string): string => {
    const n = parseInt(label, 10);
    if (periodType === "hour") return Array.isArray(hours) ? (hours[n] ?? label) : label;
    if (periodType === "dow") return Array.isArray(days) ? (days[n] ?? label) : label;
    if (periodType === "month")
      return Array.isArray(months) ? (months[n - 1] ?? label) : label;
    return label;
  };

  const maxRevenue = Math.max(...items.map((d) => d.revenue), 0);
  const hasData = items.some((d) => d.revenue > 0 || d.orders > 0);

  const chartData = items.map((d) => ({ ...d, displayLabel: formatLabel(d.label) }));

  const periodConfig = {
    revenue: {
      label: t("storeAnalytics.overview.revenueByPeriod.revenue"),
      color: CHART_COLORS[0],
    },
    orders: {
      label: t("storeAnalytics.overview.revenueByPeriod.orders"),
      color: CHART_COLORS[1],
    },
  } satisfies ChartConfig;

  const tickInterval =
    periodType === "hour" ? 2 : periodType === "dow" ? 0 : periodType === "dom" ? 4 : 0;

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle className="text-base">{t(titleKey)}</CardTitle>
      </CardHeader>
      <CardContent>
        {hasData ? (
          <ChartContainer config={periodConfig} className="h-[260px] w-full">
            <BarChart data={chartData} margin={{ left: 8, right: 8 }}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis
                dataKey="displayLabel"
                tickLine={false}
                axisLine={false}
                fontSize={11}
                interval={tickInterval}
                tick={isRtl ? (props) => {
                  const { x, y, payload } = props as { x: number; y: number; payload: { value: string } };
                  return (
                    <text x={x} y={y} dy={12} textAnchor="middle" fontSize={11} fill="currentColor" direction="ltr">
                      {payload.value}
                    </text>
                  );
                } : undefined}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                fontSize={11}
                width={48}
                tickFormatter={(v: number) => `$${v}`}
              />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="revenue" radius={[3, 3, 0, 0]} isAnimationActive={false}>
                {chartData.map((entry, index) => (
                  <Cell
                    key={index}
                    fill={entry.revenue === maxRevenue && maxRevenue > 0 ? PERIOD_HIGHLIGHT_COLOR : CHART_COLORS[0]}
                  />
                ))}
              </Bar>
            </BarChart>
          </ChartContainer>
        ) : (
          <EmptyChart message={t("storeAnalytics.noData")} />
        )}
      </CardContent>
    </Card>
  );
}

const INSIGHT_LEVEL_STYLES: Record<
  StoreInsight["level"],
  { icon: React.ReactNode; badge: string }
> = {
  critical: {
    icon: <AlertTriangle size={16} className="text-red-500" />,
    badge: "bg-red-500/10 text-red-600 dark:text-red-400",
  },
  warning: {
    icon: <AlertCircle size={16} className="text-amber-500" />,
    badge: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  },
  positive: {
    icon: <TrendingUp size={16} className="text-emerald-500" />,
    badge: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  },
  info: {
    icon: <Info size={16} className="text-blue-500" />,
    badge: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  },
};

/**
 * Builds a localized, plain-language message from the structured insight. The
 * backend returns only codes + numeric values so all prose lives in i18n.
 */
function useInsightMessage() {
  const { t } = useTranslation();
  return (insight: StoreInsight): string => {
    const v = insight.values;
    const label = insight.label ?? "";
    switch (insight.code) {
      case "revenue_swing":
        return t(`storeAnalytics.insights.revenueSwing.${insight.direction}`, {
          pct: v.pct ?? 0,
          current: formatUsd(v.current ?? 0),
          previous: formatUsd(v.previous ?? 0),
        });
      case "payment_failure_spike":
        return t("storeAnalytics.insights.paymentFailureSpike", {
          current: v.current ?? 0,
          previous: v.previous ?? 0,
        });
      case "category_move":
        return t(`storeAnalytics.insights.categoryMove.${insight.direction}`, {
          label,
          pct: v.pct ?? 0,
        });
      case "city_conversion":
        return t(`storeAnalytics.insights.cityConversion.${insight.direction}`, {
          label,
          current: v.current ?? 0,
          previous: v.previous ?? 0,
        });
      case "product_view_to_cart":
        return t("storeAnalytics.insights.productViewToCart", {
          label,
          views: v.views ?? 0,
          rate: v.rate ?? 0,
          average: v.average ?? 0,
        });
      default:
        return "";
    }
  };
}

/**
 * Deterministic pale-teal performance summary banner. All copy is rendered
 * client-side from the structured codes the endpoint returns.
 */
function PerformanceSummaryBanner({
  params,
  vsLabel,
}: {
  params: GetStorePerformanceSummaryParams;
  vsLabel: string | null;
}) {
  const { t } = useTranslation();
  // No placeholderData here on purpose: the summary is insight *text*, and
  // stale sentences for a different period/comparison are misleading. Show the
  // skeleton whenever the current params' data isn't loaded yet.
  const { data, isLoading } = useGetStorePerformanceSummary(params, {
    query: {
      queryKey: getGetStorePerformanceSummaryQueryKey(params),
    },
  });

  if (isLoading && !data) {
    return <Skeleton className="h-16 w-full" data-testid="summary-skeleton" />;
  }
  if (!data) return null;

  const { headline, driver, attention } = data;

  const sentences: string[] = [];
  switch (headline.code) {
    case "no_data":
      sentences.push(t("storeAnalytics.summary.noData"));
      break;
    case "no_comparison":
      sentences.push(
        t("storeAnalytics.summary.noComparison", {
          revenue: formatUsd(headline.currentRevenue),
          orders: headline.currentOrders,
        }),
      );
      break;
    case "stable":
      sentences.push(
        t("storeAnalytics.summary.stable", {
          revenue: formatUsd(headline.currentRevenue),
          vs: vsLabel ?? "",
        }),
      );
      break;
    case "revenue_up":
    case "revenue_down":
      sentences.push(
        t(
          headline.code === "revenue_up"
            ? "storeAnalytics.summary.revenueUp"
            : "storeAnalytics.summary.revenueDown",
          {
            pct: Math.abs(headline.revenuePct ?? 0).toFixed(1),
            revenue: formatUsd(headline.currentRevenue),
            vs: vsLabel ?? "",
          },
        ),
      );
      break;
  }

  if (driver.supported && driver.code) {
    sentences.push(
      t(`storeAnalytics.summary.driver.${driver.code}`, {
        ordersPct: Math.abs(driver.ordersPct ?? 0).toFixed(1),
        aovPct: Math.abs(driver.aovPct ?? 0).toFixed(1),
      }),
    );
  }

  if (attention.code === "missing_cogs") {
    sentences.push(
      t("storeAnalytics.summary.attention.missingCogs", {
        coverage: (attention.values?.coveragePct ?? 0).toFixed(0),
      }),
    );
  } else if (attention.code === "cancellation_up") {
    sentences.push(
      t("storeAnalytics.summary.attention.cancellationUp", {
        current: (attention.values?.current ?? 0).toFixed(1),
        previous: (attention.values?.previous ?? 0).toFixed(1),
      }),
    );
  }

  if (sentences.length === 0) return null;

  return (
    <div
      className="rounded-lg border border-teal-200 bg-teal-50 p-4 text-sm text-teal-900 dark:border-teal-900 dark:bg-teal-950/40 dark:text-teal-100"
      data-testid="banner-performance-summary"
    >
      <p className="font-medium">{t("storeAnalytics.summary.title")}</p>
      <p className="mt-1">{sentences.join(" ")}</p>
    </div>
  );
}

/** Net revenue breakdown drawer — reconciles exactly to the headline number. */
function NetRevenueDrawer({
  open,
  onOpenChange,
  params,
  cogsCoveragePct,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  params: GetStoreNetRevenueBreakdownParams;
  cogsCoveragePct: number | null;
}) {
  const { t } = useTranslation();
  const { data, isLoading } = useGetStoreNetRevenueBreakdown(params, {
    query: {
      queryKey: getGetStoreNetRevenueBreakdownQueryKey(params),
      enabled: open,
    },
  });

  const c = data?.components;

  const Row = ({
    label,
    value,
    sign,
    bold,
    testId,
  }: {
    label: string;
    value: number;
    sign?: "plus" | "minus";
    bold?: boolean;
    testId: string;
  }) => (
    <div
      className={cn("flex items-center justify-between py-1.5 text-sm", bold && "font-semibold")}
      data-testid={testId}
    >
      <span>{label}</span>
      <span className="tabular-nums">
        {sign === "minus" ? "− " : sign === "plus" ? "+ " : ""}
        {formatUsd(value)}
      </span>
    </div>
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{t("storeAnalytics.drawer.netRevenueTitle")}</SheetTitle>
          <SheetDescription>{t("storeAnalytics.drawer.netRevenueSubtitle")}</SheetDescription>
        </SheetHeader>
        {isLoading || !data || !c ? (
          <div className="mt-6 space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        ) : (
          <div className="mt-6 space-y-4">
            <div>
              <Row
                label={t("storeAnalytics.drawer.grossProductSales")}
                value={c.grossProductSales}
                testId="row-gross-product-sales"
              />
              <Row
                label={t("storeAnalytics.drawer.deliveryFees")}
                value={c.deliveryFees}
                sign="plus"
                testId="row-delivery-fees"
              />
              <Row
                label={t("storeAnalytics.drawer.discounts")}
                value={c.discounts}
                sign="minus"
                testId="row-discounts"
              />
              <Row
                label={t("storeAnalytics.drawer.refunds")}
                value={c.refunds}
                sign="minus"
                testId="row-refunds"
              />
              {!data.refundsAvailable && (
                <p className="pb-1 text-xs text-muted-foreground">
                  {t("storeAnalytics.drawer.refundsNotTracked")}
                </p>
              )}
              <Separator className="my-2" />
              <Row
                label={t("storeAnalytics.drawer.netRevenue")}
                value={c.netRevenue}
                bold
                testId="row-net-revenue"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {t("storeAnalytics.drawer.ordersIncluded", { count: c.orders })}
              </p>
            </div>

            <div className="rounded-md bg-muted/60 p-3 text-xs text-muted-foreground">
              <p>
                {t("storeAnalytics.drawer.excludedStatuses", {
                  statuses: data.excludedStatuses.join(", "),
                })}
              </p>
              {cogsCoveragePct !== null && (
                <p className="mt-1">
                  {t("storeAnalytics.drawer.cogsCoverage", {
                    pct: cogsCoveragePct.toFixed(0),
                  })}
                </p>
              )}
            </div>

            {data.baselineComponents && (
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground">
                  {t("storeAnalytics.drawer.baseline")}
                </p>
                <Row
                  label={t("storeAnalytics.drawer.netRevenue")}
                  value={data.baselineComponents.netRevenue}
                  testId="row-baseline-net-revenue"
                />
                <p className="text-xs text-muted-foreground">
                  {t("storeAnalytics.drawer.ordersIncluded", {
                    count: data.baselineComponents.orders,
                  })}
                </p>
              </div>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

export default function StoreAnalyticsOverview({
  filters,
  onNavigateSection,
}: {
  filters: UseStoreAnalyticsFilters;
  onNavigateSection?: (section: string) => void;
}) {
  const { t } = useTranslation();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { data, isLoading, isError } = useGetStoreExecutiveOverview(filters.apiParams, {
    query: {
      queryKey: getGetStoreExecutiveOverviewQueryKey(filters.apiParams),
      placeholderData: (prev) => prev,
    },
  });

  const insightsQuery = useGetStoreInsights(filters.apiParams, {
    query: {
      queryKey: getGetStoreInsightsQueryKey(filters.apiParams),
      placeholderData: (prev) => prev,
    },
  });
  const insights = insightsQuery.data?.insights ?? [];
  const buildInsightMessage = useInsightMessage();

  const kpis: StoreAnalyticsKpis | undefined = data?.kpis;
  const prev = data?.previousKpis ?? null;
  const comparisonMode = data?.comparisonMode ?? "none";

  const vsLabel =
    comparisonMode === "previous"
      ? t("storeAnalytics.compare.vsPrevious")
      : comparisonMode === "last_year"
        ? t("storeAnalytics.compare.vsLastYear")
        : comparisonMode === "custom"
          ? t("storeAnalytics.compare.vsCustom")
          : null;

  // Sparkline series derived from the bucketed revenue trend.
  const sparks = useMemo(() => {
    const rows = data?.revenueOverTime ?? [];
    const netRevenue = rows.map((r) => ({ x: r.date, y: r.revenue }));
    const orders = rows.map((r) => ({ x: r.date, y: r.orders }));
    const aov = rows.map((r) => ({
      x: r.date,
      y: r.orders > 0 ? r.revenue / r.orders : null,
    }));
    const grossProfit = rows.map((r) => ({
      x: r.date,
      y: r.cogs != null ? r.revenue - r.cogs : null,
    }));
    const grossMargin = rows.map((r) => ({
      x: r.date,
      y: r.cogs != null && r.revenue > 0 ? ((r.revenue - r.cogs) / r.revenue) * 100 : null,
    }));
    return { netRevenue, orders, aov, grossProfit, grossMargin };
  }, [data?.revenueOverTime]);

  // Merge current + baseline trends by bucket index for the overlay chart.
  const trendData = useMemo(() => {
    const rows = data?.revenueOverTime ?? [];
    const baseline = data?.comparisonRevenueOverTime ?? null;
    return rows.map((r, i) => ({
      date: r.date,
      revenue: r.revenue,
      baseline: baseline?.[i]?.revenue ?? null,
    }));
  }, [data?.revenueOverTime, data?.comparisonRevenueOverTime]);

  const hasBaselineTrend = Boolean(
    data?.comparisonRevenueOverTime && data.comparisonRevenueOverTime.length > 0,
  );

  const cogsAvailable = kpis?.grossMarginUsd != null;
  const cogsCoverage = kpis?.cogsCoveragePct ?? null;

  const revenueConfig = {
    revenue: { label: t("storeAnalytics.revenue"), color: CHART_COLORS[0] },
    baseline: { label: t("storeAnalytics.compare.baselineSeries"), color: BASELINE_COLOR },
  } satisfies ChartConfig;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <StoreAnalyticsBasisStrip
          range={data?.range ?? null}
          comparison={data?.comparison ?? null}
          comparisonMode={comparisonMode}
        />
        <div className="flex items-center gap-3">
          {data?.updatedAt && (
            <span className="text-xs text-muted-foreground" data-testid="text-updated-at">
              {t("storeAnalytics.updatedAt", {
                time: new Date(data.updatedAt).toLocaleTimeString(),
              })}
            </span>
          )}
          <AnalyticsExportMenu
            filename="store-analytics-overview"
            title="E-commerce Analytics — Overview"
            filterSummary={buildFilterSummary(filters.apiParams)}
            getDatasets={() => datasetsFromResponse(data)}
            disabled={isLoading || !data}
          />
        </div>
      </div>

      {isError && (
        <Card>
          <CardContent className="p-6 text-center text-sm text-red-500">
            {t("storeAnalytics.loadError")}
          </CardContent>
        </Card>
      )}

      <PerformanceSummaryBanner
        params={filters.apiParams as GetStorePerformanceSummaryParams}
        vsLabel={vsLabel}
      />

      {/* Tier 1 — Commercial KPIs */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {isLoading && !data ? (
          Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-[148px] w-full" />
          ))
        ) : (
          <>
            <CommercialKpiCard
              label={t("storeAnalytics.kpi.netRevenue")}
              value={formatUsd(kpis?.totalRevenue ?? 0)}
              current={kpis?.totalRevenue}
              previous={prev?.totalRevenue}
              vsLabel={vsLabel}
              definition={t("storeAnalytics.definitions.netRevenue")}
              spark={sparks.netRevenue}
              sparkColor={CHART_COLORS[0]}
              onClick={() => setDrawerOpen(true)}
              testId="card-net-revenue"
            />
            <CommercialKpiCard
              label={t("storeAnalytics.kpi.orders")}
              value={String(kpis?.orders ?? 0)}
              current={kpis?.orders}
              previous={prev?.orders}
              vsLabel={vsLabel}
              definition={t("storeAnalytics.definitions.orders")}
              spark={sparks.orders}
              sparkColor={CHART_COLORS[1]}
              testId="card-orders"
            />
            <CommercialKpiCard
              label={t("storeAnalytics.kpi.aov")}
              value={formatUsd(kpis?.aov ?? 0)}
              current={kpis?.aov}
              previous={prev?.aov}
              vsLabel={vsLabel}
              definition={t("storeAnalytics.definitions.aov")}
              spark={sparks.aov}
              sparkColor={CHART_COLORS[2]}
              testId="card-aov"
            />
            <CommercialKpiCard
              label={t("storeAnalytics.kpi.grossProfit")}
              value={
                cogsAvailable
                  ? formatUsd(kpis?.grossMarginUsd ?? 0)
                  : t("storeAnalytics.notAvailable")
              }
              current={cogsAvailable ? (kpis?.grossMarginUsd ?? undefined) : undefined}
              previous={cogsAvailable ? prev?.grossMarginUsd : undefined}
              vsLabel={vsLabel}
              definition={t("storeAnalytics.definitions.grossProfit")}
              spark={cogsAvailable ? sparks.grossProfit : undefined}
              sparkColor={CHART_COLORS[3]}
              hint={
                !cogsAvailable
                  ? t("storeAnalytics.missingCogsHint")
                  : cogsCoverage !== null && cogsCoverage < 95
                    ? t("storeAnalytics.cogsCoverageHint", { pct: cogsCoverage.toFixed(0) })
                    : undefined
              }
              testId="card-gross-profit"
            />
            <CommercialKpiCard
              label={t("storeAnalytics.kpi.grossMargin")}
              value={
                kpis?.grossMarginPct != null
                  ? formatPct(kpis.grossMarginPct)
                  : t("storeAnalytics.notAvailable")
              }
              current={kpis?.grossMarginPct ?? undefined}
              previous={prev?.grossMarginPct ?? undefined}
              vsLabel={vsLabel}
              definition={t("storeAnalytics.definitions.grossMargin")}
              spark={kpis?.grossMarginPct != null ? sparks.grossMargin : undefined}
              sparkColor={CHART_COLORS[5]}
              hint={
                kpis?.grossMarginPct == null ? t("storeAnalytics.missingCogsHint") : undefined
              }
              testId="card-gross-margin"
            />
          </>
        )}
      </div>

      {/* Tier 2 — Operational KPIs */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {isLoading && !data ? (
          Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-[84px] w-full" />)
        ) : (
          <>
            <OperationalKpiCard
              icon={<MousePointerClick size={14} />}
              label={t("storeAnalytics.kpi.conversionRate")}
              value={
                data?.conversionRateTracked && kpis?.conversionRate != null
                  ? formatPct(kpis.conversionRate)
                  : t("storeAnalytics.notAvailable")
              }
              current={
                data?.conversionRateTracked ? (kpis?.conversionRate ?? undefined) : undefined
              }
              previous={
                data?.conversionRateTracked ? (prev?.conversionRate ?? undefined) : undefined
              }
              vsLabel={vsLabel}
              hint={!data?.conversionRateTracked ? t("storeAnalytics.needsTracking") : undefined}
              testId="card-conversion-rate"
            />
            <OperationalKpiCard
              icon={<XCircle size={14} />}
              label={t("storeAnalytics.kpi.cancellationRate")}
              value={formatPct(kpis?.cancellationRate ?? 0)}
              current={kpis?.cancellationRate}
              previous={prev?.cancellationRate}
              invert
              vsLabel={vsLabel}
              testId="card-cancellation-rate"
            />
            <OperationalKpiCard
              icon={<Truck size={14} />}
              label={t("storeAnalytics.kpi.deliverySuccessRate")}
              value={formatPct(kpis?.deliverySuccessRate ?? 0)}
              current={kpis?.deliverySuccessRate}
              previous={prev?.deliverySuccessRate}
              vsLabel={vsLabel}
              testId="card-delivery-success-rate"
            />
          </>
        )}
      </div>

      <NetRevenueDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        params={filters.apiParams as GetStoreNetRevenueBreakdownParams}
        cogsCoveragePct={cogsCoverage}
      />

      {/* Charts */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Revenue over time (+ baseline overlay) */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">
              {t("storeAnalytics.chart.revenueOverTime")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data && trendData.length > 0 ? (
              <ChartContainer config={revenueConfig} className="h-[260px] w-full">
                <ComposedChart data={trendData} margin={{ left: 8, right: 8 }}>
                  <defs>
                    <linearGradient id="revFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={CHART_COLORS[0]} stopOpacity={0.35} />
                      <stop offset="95%" stopColor={CHART_COLORS[0]} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis dataKey="date" tickLine={false} axisLine={false} fontSize={11} />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    fontSize={11}
                    width={48}
                    tickFormatter={(v: number) => `$${v}`}
                  />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  {hasBaselineTrend && (
                    <Line
                      type="monotone"
                      dataKey="baseline"
                      stroke={BASELINE_COLOR}
                      strokeWidth={1.5}
                      strokeDasharray="5 4"
                      dot={false}
                    />
                  )}
                  <Area
                    type="monotone"
                    dataKey="revenue"
                    stroke={CHART_COLORS[0]}
                    fill="url(#revFill)"
                    strokeWidth={2}
                  />
                </ComposedChart>
              </ChartContainer>
            ) : (
              <EmptyChart message={t("storeAnalytics.noData")} />
            )}
          </CardContent>
        </Card>

        {/* Revenue by period (hour / dow / dom / month) */}
        {data && data.revenueByPeriod && (
          <RevenueByPeriodCard
            items={data.revenueByPeriod}
            periodType={data.periodType as "hour" | "dow" | "dom" | "month"}
          />
        )}

        {/* Revenue by channel (donut) */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t("storeAnalytics.chart.revenueByChannel")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data && data.revenueByChannel.length > 0 ? (
              <ChartContainer config={{}} className="mx-auto h-[240px]">
                <PieChart>
                  <ChartTooltip content={<ChartTooltipContent nameKey="name" />} />
                  <Pie
                    data={data.revenueByChannel}
                    dataKey="revenue"
                    nameKey="name"
                    innerRadius={55}
                    outerRadius={90}
                    paddingAngle={2}
                  >
                    {data.revenueByChannel.map((_, i) => (
                      <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                    ))}
                  </Pie>
                </PieChart>
              </ChartContainer>
            ) : (
              <EmptyChart message={t("storeAnalytics.noData")} />
            )}
          </CardContent>
        </Card>

        {/* New vs returning (donut) */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t("storeAnalytics.chart.newVsReturning")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data && (data.newVsReturning.new > 0 || data.newVsReturning.returning > 0) ? (
              <ChartContainer config={{}} className="mx-auto h-[240px]">
                <PieChart>
                  <ChartTooltip content={<ChartTooltipContent nameKey="name" />} />
                  <Pie
                    data={[
                      { name: t("storeAnalytics.newCustomers"), value: data.newVsReturning.new },
                      {
                        name: t("storeAnalytics.returningCustomers"),
                        value: data.newVsReturning.returning,
                      },
                    ]}
                    dataKey="value"
                    nameKey="name"
                    innerRadius={55}
                    outerRadius={90}
                    paddingAngle={2}
                  >
                    <Cell fill={CHART_COLORS[0]} />
                    <Cell fill={CHART_COLORS[1]} />
                  </Pie>
                </PieChart>
              </ChartContainer>
            ) : (
              <EmptyChart message={t("storeAnalytics.noData")} />
            )}
          </CardContent>
        </Card>

        {/* Revenue by city (bars) */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t("storeAnalytics.chart.revenueByCity")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data && data.revenueByCity.length > 0 ? (
              <ChartContainer config={revenueConfig} className="h-[240px] w-full">
                <BarChart
                  data={data.revenueByCity.slice(0, 8)}
                  layout="vertical"
                  margin={{ left: 8, right: 8 }}
                >
                  <CartesianGrid horizontal={false} strokeDasharray="3 3" />
                  <XAxis type="number" tickLine={false} axisLine={false} fontSize={11} tickFormatter={(v: number) => `$${v}`} />
                  <YAxis
                    type="category"
                    dataKey="name"
                    tickLine={false}
                    axisLine={false}
                    fontSize={11}
                    width={90}
                  />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="revenue" fill={CHART_COLORS[0]} radius={4} />
                </BarChart>
              </ChartContainer>
            ) : (
              <EmptyChart message={t("storeAnalytics.noData")} />
            )}
          </CardContent>
        </Card>

        {/* Revenue by country (summary list) */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t("storeAnalytics.chart.revenueByCountry")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data && data.revenueByCountry.length > 0 ? (
              <div className="overflow-x-auto">
                <div className="min-w-[480px] space-y-1">
                <div className="flex items-center justify-between px-1 pb-2 text-xs font-medium text-muted-foreground">
                  <span>{t("storeAnalytics.country")}</span>
                  <div className="flex gap-6">
                    <span className="w-16 text-right">{t("storeAnalytics.kpi.orders")}</span>
                    <span className="w-24 text-right">{t("storeAnalytics.revenue")}</span>
                    <span className="w-20 text-right">{t("storeAnalytics.kpi.aov")}</span>
                    <span className="w-24 text-right">{t("storeAnalytics.kpi.conversionRate")}</span>
                  </div>
                </div>
                {data.revenueByCountry.slice(0, 8).map((c, i) => (
                  <div
                    key={c.code ?? c.name ?? i}
                    className="flex items-center justify-between rounded-md px-1 py-1.5 text-sm hover:bg-muted/50"
                    data-testid={`row-country-${i}`}
                  >
                    <span className="flex items-center gap-2 truncate">
                      <span
                        className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }}
                      />
                      <span className="truncate">{c.name}</span>
                    </span>
                    <div className="flex gap-6">
                      <span className="w-16 text-right tabular-nums text-muted-foreground">
                        {c.orders}
                      </span>
                      <span className="w-24 text-right font-medium tabular-nums">
                        {formatUsd(c.revenue)}
                      </span>
                      <span className="w-20 text-right tabular-nums text-muted-foreground">
                        {formatUsd(c.aov)}
                      </span>
                      <span className="w-24 text-right tabular-nums text-muted-foreground">
                        {c.conversionRatePct != null
                          ? `${c.conversionRatePct.toFixed(2)}%`
                          : "—"}
                      </span>
                    </div>
                  </div>
                ))}
                </div>
              </div>
            ) : (
              <EmptyChart message={t("storeAnalytics.noData")} />
            )}
          </CardContent>
        </Card>

        {/* Top occasions (bars) */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t("storeAnalytics.chart.topOccasions")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data && data.topOccasions.length > 0 ? (
              <ChartContainer config={revenueConfig} className="h-[240px] w-full">
                <BarChart
                  data={data.topOccasions.slice(0, 8)}
                  layout="vertical"
                  margin={{ left: 8, right: 8 }}
                >
                  <CartesianGrid horizontal={false} strokeDasharray="3 3" />
                  <XAxis type="number" tickLine={false} axisLine={false} fontSize={11} tickFormatter={(v: number) => `$${v}`} />
                  <YAxis
                    type="category"
                    dataKey="name"
                    tickLine={false}
                    axisLine={false}
                    fontSize={11}
                    width={90}
                  />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="revenue" fill={CHART_COLORS[2]} radius={4} />
                </BarChart>
              </ChartContainer>
            ) : (
              <EmptyChart message={t("storeAnalytics.noData")} />
            )}
          </CardContent>
        </Card>

        {/* Orders by device */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <MonitorSmartphone size={16} />
              {t("storeAnalytics.chart.ordersByDevice")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data?.ordersByDevice?.tracked && data.ordersByDevice.items.length > 0 ? (
              <ChartContainer config={{}} className="h-[240px] w-full">
                <BarChart
                  data={data.ordersByDevice.items}
                  layout="vertical"
                  margin={{ left: 8, right: 8 }}
                >
                  <CartesianGrid horizontal={false} strokeDasharray="3 3" />
                  <XAxis type="number" tickLine={false} axisLine={false} fontSize={11} />
                  <YAxis
                    type="category"
                    dataKey="name"
                    tickLine={false}
                    axisLine={false}
                    fontSize={11}
                    width={70}
                  />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="orders" radius={4}>
                    {data.ordersByDevice.items.map((_, i) => (
                      <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ChartContainer>
            ) : (
              <EmptyChart message={t("storeAnalytics.needsTracking")} />
            )}
          </CardContent>
        </Card>

        {/* Insights & alerts */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Lightbulb size={16} />
              {t("storeAnalytics.chart.insights")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {insightsQuery.isLoading && !insightsQuery.data ? (
              <div className="space-y-2">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-14 w-full" />
                ))}
              </div>
            ) : insights.length === 0 ? (
              <EmptyChart message={t("storeAnalytics.insights.empty")} />
            ) : (
              <ul className="space-y-2">
                {insights.map((insight) => {
                  const style = INSIGHT_LEVEL_STYLES[insight.level];
                  const clickable = insight.section !== "overview";
                  return (
                    <li key={insight.id}>
                      <button
                        type="button"
                        disabled={!clickable}
                        onClick={
                          clickable
                            ? () => onNavigateSection?.(insight.section)
                            : undefined
                        }
                        className={cn(
                          "flex w-full items-start gap-3 rounded-lg border p-3 text-start transition-colors",
                          clickable
                            ? "hover:bg-muted/60 cursor-pointer"
                            : "cursor-default",
                        )}
                      >
                        <span className="mt-0.5 shrink-0">{style.icon}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm text-foreground">
                            {buildInsightMessage(insight)}
                          </span>
                          {clickable && (
                            <span className="mt-1 inline-flex items-center gap-0.5 text-xs text-muted-foreground">
                              {t("storeAnalytics.insights.viewSection", {
                                section: t(
                                  `storeAnalytics.insights.sections.${insight.section}`,
                                ),
                              })}
                            </span>
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
