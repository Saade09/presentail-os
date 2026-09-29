import { useMemo } from "react";
import { useLocation } from "wouter";
import { useTranslation } from "react-i18next";
import { AnalyticsExportMenu } from "@/components/AnalyticsExportMenu";
import { buildFilterSummary, datasetsFromResponse } from "@/lib/analytics-export";
import {
  useGetStoreSales,
  getGetStoreSalesQueryKey,
  useGetStoreTimeSlots,
  getGetStoreTimeSlotsQueryKey,
  useGetStoreFunnel,
  getGetStoreFunnelQueryKey,
  type GetStoreSalesParams,
  type StoreNamedRevenue,
  type StoreTimeSlotsResponse,
  type StoreHeatmapCell,
  type StoreCountryStat,
  type StoreFunnelBreakdownItem,
} from "@workspace/api-client-react";
import { BreakdownCard, formatSourceLabel } from "@/components/analytics/BreakdownCard";
import type { DatePreset } from "@/hooks/use-store-analytics-filters";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
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
  LabelList,
  Line,
  LineChart,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from "recharts";
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

function formatUsd(n: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: n >= 1000 ? 0 : 2,
  }).format(n);
}

function EmptyChart({ message }: { message: string }) {
  return (
    <div className="flex h-[240px] items-center justify-center text-center text-sm text-muted-foreground">
      {message}
    </div>
  );
}

const CITY_TEAL = "hsl(160, 84%, 39%)";
const CITY_BAR_ROWS = 8;
const CITY_ROW_HEIGHT = 36;
const CITY_MIN_HEIGHT = 240;
const CITY_YAXIS_WIDTH = 130;

function formatCompactUsd(v: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(v);
}

/** Custom Y-axis tick that shows the city name (with ellipsis if too long) and the % share below it. */
function CityYAxisTick({
  x,
  y,
  payload,
  percentMap,
}: {
  x?: number;
  y?: number;
  payload?: { value: string };
  percentMap: Record<string, number>;
}) {
  const name = payload?.value ?? "";
  const pct = percentMap[name];
  const maxChars = Math.floor((CITY_YAXIS_WIDTH - 12) / 6.5);
  const display = name.length > maxChars ? name.slice(0, maxChars - 1) + "\u2026" : name;
  return (
    <g transform={`translate(${x},${y})`}>
      {display !== name && <title>{name}</title>}
      <text x={-4} y={-4} textAnchor="end" fontSize={11} fill="currentColor">
        {display}
      </text>
      {pct !== undefined && (
        <text x={-4} y={9} textAnchor="end" fontSize={10} fill="#6b7280">
          {pct}%
        </text>
      )}
    </g>
  );
}

/** Enhanced city revenue bar chart: ranked teal gradient, inline labels, % of total, compact axes. */
function CityRevenueChart({
  title,
  data,
  emptyMessage,
}: {
  title: string;
  data: StoreNamedRevenue[];
  emptyMessage: string;
}) {
  const rows = data.slice(0, CITY_BAR_ROWS);
  const total = rows.reduce((s, r) => s + r.revenue, 0);
  const percentMap: Record<string, number> = Object.fromEntries(
    rows.map((r) => [r.name, total > 0 ? Math.round((r.revenue / total) * 100) : 0]),
  );
  const chartHeight = Math.max(CITY_MIN_HEIGHT, rows.length * CITY_ROW_HEIGHT);
  const config = { revenue: { label: title, color: CITY_TEAL } } satisfies ChartConfig;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length > 0 ? (
          <ChartContainer
            config={config}
            style={{ height: chartHeight }}
            className="w-full"
            data-testid="chart-revenue-by-city"
          >
            <BarChart data={rows} layout="vertical" margin={{ left: 8, right: 56 }}>
              <CartesianGrid horizontal={false} strokeDasharray="3 3" />
              <XAxis
                type="number"
                tickLine={false}
                axisLine={false}
                fontSize={11}
                tickFormatter={formatCompactUsd}
              />
              <YAxis
                type="category"
                dataKey="name"
                tickLine={false}
                axisLine={false}
                width={CITY_YAXIS_WIDTH}
                tick={(tickProps) => (
                  <CityYAxisTick {...tickProps} percentMap={percentMap} />
                )}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    formatter={(value) => [formatUsd(value as number), title]}
                  />
                }
              />
              <Bar dataKey="revenue" radius={4}>
                {rows.map((_, i) => {
                  const opacity = Math.max(
                    0.35,
                    1.0 - (i / Math.max(1, rows.length - 1)) * 0.65,
                  );
                  return <Cell key={i} fill={CITY_TEAL} fillOpacity={opacity} />;
                })}
                <LabelList
                  dataKey="revenue"
                  position="right"
                  fontSize={11}
                  formatter={formatCompactUsd}
                />
              </Bar>
            </BarChart>
          </ChartContainer>
        ) : (
          <EmptyChart message={emptyMessage} />
        )}
      </CardContent>
    </Card>
  );
}

/** Horizontal-bar breakdown chart for a list of {name, revenue}. */
function BarBreakdownCard({
  title,
  data,
  colorIndex = 0,
  emptyMessage,
  testid,
}: {
  title: string;
  data: StoreNamedRevenue[];
  colorIndex?: number;
  emptyMessage: string;
  testid?: string;
}) {
  const config = { revenue: { label: title, color: CHART_COLORS[colorIndex] } } satisfies ChartConfig;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {data.length > 0 ? (
          <ChartContainer config={config} className="h-[240px] w-full" data-testid={testid}>
            <BarChart data={data.slice(0, 8)} layout="vertical" margin={{ left: 8, right: 8 }}>
              <CartesianGrid horizontal={false} strokeDasharray="3 3" />
              <XAxis
                type="number"
                tickLine={false}
                axisLine={false}
                fontSize={11}
                tickFormatter={(v: number) => `$${v}`}
              />
              <YAxis
                type="category"
                dataKey="name"
                tickLine={false}
                axisLine={false}
                fontSize={11}
                width={100}
              />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="revenue" fill={CHART_COLORS[colorIndex]} radius={4} />
            </BarChart>
          </ChartContainer>
        ) : (
          <EmptyChart message={emptyMessage} />
        )}
      </CardContent>
    </Card>
  );
}

/** Tabular breakdown list (name, orders, revenue). */
function TableBreakdownCard({
  title,
  nameHeader,
  rows,
  emptyMessage,
  ordersLabel,
  revenueLabel,
  testid,
}: {
  title: string;
  nameHeader: string;
  rows: { name: string; orders: number; revenue: number }[];
  emptyMessage: string;
  ordersLabel: string;
  revenueLabel: string;
  testid?: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length > 0 ? (
          <div className="space-y-1" data-testid={testid}>
            <div className="flex items-center justify-between px-1 pb-2 text-xs font-medium text-muted-foreground">
              <span>{nameHeader}</span>
              <div className="flex gap-6">
                <span className="w-16 text-right">{ordersLabel}</span>
                <span className="w-24 text-right">{revenueLabel}</span>
              </div>
            </div>
            {rows.slice(0, 8).map((r, i) => (
              <div
                key={r.name ?? i}
                className="flex items-center justify-between rounded-md px-1 py-1.5 text-sm hover:bg-muted/50"
              >
                <span className="flex items-center gap-2 truncate">
                  <span
                    className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }}
                  />
                  <span className="truncate capitalize">{r.name}</span>
                </span>
                <div className="flex gap-6">
                  <span className="w-16 text-right tabular-nums text-muted-foreground">
                    {r.orders}
                  </span>
                  <span className="w-24 text-right font-medium tabular-nums">
                    {formatUsd(r.revenue)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyChart message={emptyMessage} />
        )}
      </CardContent>
    </Card>
  );
}

/** Small trend arrow for conversion rate direction. */
function ConversionTrendBadge({
  trend,
  prevPct,
  title,
}: {
  trend: "up" | "down" | "flat" | null | undefined;
  prevPct: number | null | undefined;
  title: string;
}) {
  if (trend == null) return <span className="text-muted-foreground">—</span>;
  const prevLabel = prevPct != null ? `${prevPct.toFixed(2)}%` : null;
  const label = prevLabel ? `${title}: ${prevLabel}` : title;
  if (trend === "up") {
    return (
      <span title={label} className="inline-flex items-center gap-0.5 text-emerald-600 font-medium">
        ↑
        {prevLabel && (
          <span className="text-xs font-normal text-muted-foreground">{prevLabel}</span>
        )}
      </span>
    );
  }
  if (trend === "down") {
    return (
      <span title={label} className="inline-flex items-center gap-0.5 text-red-500 font-medium">
        ↓
        {prevLabel && (
          <span className="text-xs font-normal text-muted-foreground">{prevLabel}</span>
        )}
      </span>
    );
  }
  return (
    <span title={label} className="inline-flex items-center gap-0.5 text-muted-foreground">
      →
      {prevLabel && (
        <span className="text-xs">{prevLabel}</span>
      )}
    </span>
  );
}

/** AOV by Country table: sorted by aov descending. */
function AovByCountryCard({
  rows,
  emptyMessage,
  testid,
}: {
  rows: StoreCountryStat[];
  emptyMessage: string;
  testid?: string;
}) {
  const { t } = useTranslation();
  const sorted = useMemo(
    () => [...rows].sort((a, b) => (b.aov ?? 0) - (a.aov ?? 0)),
    [rows],
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {t("storeAnalytics.sales.aovByCountry.title")}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          {t("storeAnalytics.sales.buyerCountryHint")}
        </p>
      </CardHeader>
      <CardContent>
        {sorted.length > 0 ? (
          <div className="overflow-x-auto" data-testid={testid}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs font-medium text-muted-foreground">
                  <th className="px-2 py-2 text-start">
                    {t("storeAnalytics.sales.aovByCountry.country")}
                  </th>
                  <th className="px-2 py-2 text-end">
                    {t("storeAnalytics.sales.aovByCountry.orders")}
                  </th>
                  <th className="px-2 py-2 text-end">
                    {t("storeAnalytics.sales.aovByCountry.aov")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((r, i) => (
                  <tr
                    key={r.name ?? i}
                    className="border-b last:border-0 hover:bg-muted/50"
                  >
                    <td className="px-2 py-2">
                      <span className="flex items-center gap-2">
                        <span
                          className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }}
                        />
                        <span className="capitalize">{r.name}</span>
                      </span>
                    </td>
                    <td className="px-2 py-2 text-end tabular-nums text-muted-foreground">
                      {r.orders}
                    </td>
                    <td className="px-2 py-2 text-end font-medium tabular-nums">
                      {formatUsd(r.aov)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyChart message={emptyMessage} />
        )}
      </CardContent>
    </Card>
  );
}

/** Conversion Rate by Country table: sorted by conversionRatePct descending. */
function ConversionByCountryCard({
  rows,
  emptyMessage,
  testid,
}: {
  rows: StoreCountryStat[];
  emptyMessage: string;
  testid?: string;
}) {
  const { t } = useTranslation();
  const sorted = useMemo(
    () =>
      [...rows].sort(
        (a, b) => (b.conversionRatePct ?? -1) - (a.conversionRatePct ?? -1),
      ),
    [rows],
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {t("storeAnalytics.sales.conversionByCountry.title")}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          {t("storeAnalytics.sales.buyerCountryHint")}
        </p>
      </CardHeader>
      <CardContent>
        {sorted.length > 0 ? (
          <div className="overflow-x-auto" data-testid={testid}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs font-medium text-muted-foreground">
                  <th className="px-2 py-2 text-start">
                    {t("storeAnalytics.sales.conversionByCountry.country")}
                  </th>
                  <th className="px-2 py-2 text-end">
                    {t("storeAnalytics.sales.conversionByCountry.sessions")}
                  </th>
                  <th className="px-2 py-2 text-end">
                    {t("storeAnalytics.sales.conversionByCountry.orders")}
                  </th>
                  <th className="px-2 py-2 text-end">
                    {t("storeAnalytics.sales.conversionByCountry.rate")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((r, i) => (
                  <tr
                    key={r.name ?? i}
                    className="border-b last:border-0 hover:bg-muted/50"
                  >
                    <td className="px-2 py-2">
                      <span className="flex items-center gap-2">
                        <span
                          className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }}
                        />
                        <span className="capitalize">{r.name}</span>
                      </span>
                    </td>
                    <td className="px-2 py-2 text-end tabular-nums text-muted-foreground">
                      {r.sessions != null ? r.sessions.toLocaleString() : "—"}
                    </td>
                    <td className="px-2 py-2 text-end tabular-nums text-muted-foreground">
                      {r.orders}
                    </td>
                    <td className="px-2 py-2 text-end font-medium tabular-nums">
                      {r.conversionRatePct != null
                        ? `${r.conversionRatePct.toFixed(2)}%`
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyChart message={emptyMessage} />
        )}
      </CardContent>
    </Card>
  );
}

/** Unified Performance by Country table: Visitors · Orders · Revenue · AOV · Conv. Rate · Trend */
function PerformanceByCountryCard({
  rows,
  emptyMessage,
  testid,
}: {
  rows: StoreCountryStat[];
  emptyMessage: string;
  testid?: string;
}) {
  const { t } = useTranslation();
  const hasTrend = rows.some((r) => r.conversionTrend != null);
  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle className="text-base">
          {t("storeAnalytics.sales.countryPerformance.title")}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          {t("storeAnalytics.sales.buyerCountryHint")}
        </p>
      </CardHeader>
      <CardContent>
        {rows.length > 0 ? (
          <div className="overflow-x-auto" data-testid={testid}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-xs font-medium text-muted-foreground">
                  <th className="px-2 py-2 text-start">
                    {t("storeAnalytics.sales.countryPerformance.country")}
                  </th>
                  <th className="px-2 py-2 text-end">
                    {t("storeAnalytics.sales.countryPerformance.visitors")}
                  </th>
                  <th className="px-2 py-2 text-end">
                    {t("storeAnalytics.sales.countryPerformance.orders")}
                  </th>
                  <th className="px-2 py-2 text-end">
                    {t("storeAnalytics.sales.countryPerformance.revenue")}
                  </th>
                  <th className="px-2 py-2 text-end">
                    {t("storeAnalytics.sales.countryPerformance.aov")}
                  </th>
                  <th className="px-2 py-2 text-end">
                    {t("storeAnalytics.sales.countryPerformance.conversionRate")}
                  </th>
                  {hasTrend && (
                    <th className="px-2 py-2 text-end">
                      {t("storeAnalytics.sales.countryPerformance.trend")}
                    </th>
                  )}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr
                    key={r.name ?? i}
                    className="border-b last:border-0 hover:bg-muted/50"
                  >
                    <td className="px-2 py-2">
                      <span className="flex items-center gap-2">
                        <span
                          className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                          style={{ backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }}
                        />
                        <span className="capitalize">{r.name}</span>
                      </span>
                    </td>
                    <td className="px-2 py-2 text-end tabular-nums text-muted-foreground">
                      {r.sessions != null ? r.sessions.toLocaleString() : "—"}
                    </td>
                    <td className="px-2 py-2 text-end tabular-nums text-muted-foreground">
                      {r.orders}
                    </td>
                    <td className="px-2 py-2 text-end font-medium tabular-nums">
                      {formatUsd(r.revenue)}
                    </td>
                    <td className="px-2 py-2 text-end tabular-nums">
                      {formatUsd(r.aov)}
                    </td>
                    <td className="px-2 py-2 text-end tabular-nums">
                      {r.conversionRatePct != null
                        ? `${r.conversionRatePct.toFixed(2)}%`
                        : "—"}
                    </td>
                    {hasTrend && (
                      <td className="px-2 py-2 text-end tabular-nums">
                        <ConversionTrendBadge
                          trend={r.conversionTrend}
                          prevPct={r.conversionRatePrevPct}
                          title={
                            r.conversionTrend === "up"
                              ? t("storeAnalytics.sales.countryPerformance.trendUp")
                              : r.conversionTrend === "down"
                                ? t("storeAnalytics.sales.countryPerformance.trendDown")
                                : t("storeAnalytics.sales.countryPerformance.trendFlat")
                          }
                        />
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyChart message={emptyMessage} />
        )}
      </CardContent>
    </Card>
  );
}

/** Sales by delivery time slot: express KPI chips + per-slot breakdown table. */
export function TimeSlotsCard({
  data,
  isLoading,
  emptyMessage,
}: {
  data: StoreTimeSlotsResponse | undefined;
  isLoading: boolean;
  emptyMessage: string;
}) {
  const { t } = useTranslation();
  const slots = data?.timeSlots ?? [];
  const totals = data?.totals;
  const hasData = slots.length > 0;

  const noSlotLabel = t("storeAnalytics.sales.timeSlots.noSlot");

  // Chart rows keep the API order (window start asc, no-slot last).
  const chartRows = useMemo(
    () =>
      slots.map((s) => ({
        name: s.slot ?? noSlotLabel,
        revenue: s.revenue,
        orders: s.orders,
      })),
    [slots, noSlotLabel],
  );

  // Highest-revenue slot gets highlighted in the chart and called out on top.
  const topSlotName = useMemo(() => {
    if (chartRows.length === 0) return null;
    let top = chartRows[0];
    for (const r of chartRows) if (r.revenue > top.revenue) top = r;
    return top.revenue > 0 ? top.name : null;
  }, [chartRows]);

  const chartConfig = {
    revenue: { label: t("storeAnalytics.revenue"), color: CHART_COLORS[0] },
    orders: { label: t("storeAnalytics.sales.orders"), color: CHART_COLORS[2] },
  } satisfies ChartConfig;

  const kpis = totals
    ? [
        { label: t("storeAnalytics.sales.timeSlots.expressOrders"), value: String(totals.expressOrders) },
        { label: t("storeAnalytics.sales.timeSlots.expressRevenue"), value: formatUsd(totals.expressRevenue) },
        { label: t("storeAnalytics.sales.timeSlots.expressSurcharges"), value: formatUsd(totals.expressSurchargeUsd) },
        { label: t("storeAnalytics.sales.timeSlots.slotFees"), value: formatUsd(totals.slotFeeUsd) },
      ]
    : [];

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle className="text-base">
          {t("storeAnalytics.sales.timeSlots.title")}
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          {t("storeAnalytics.sales.timeSlots.subtitle")}
        </p>
      </CardHeader>
      <CardContent>
        {isLoading && !data ? (
          <Skeleton className="h-[240px] w-full" />
        ) : hasData ? (
          <div className="space-y-4" data-testid="table-sales-by-time-slot">
            {topSlotName && (
              <div
                className="inline-flex items-center gap-2 rounded-full bg-[#E6F4F6] px-3 py-1 text-xs font-medium text-[#064E5A]"
                data-testid="badge-top-time-slot"
              >
                <span>{t("storeAnalytics.sales.timeSlots.topSlot")}</span>
                <span dir="ltr" className="font-semibold">
                  {topSlotName}
                </span>
              </div>
            )}
            <ChartContainer
              config={chartConfig}
              className="h-[260px] w-full"
              data-testid="chart-sales-by-time-slot"
            >
              <BarChart data={chartRows} margin={{ left: 4, right: 4 }}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" />
                <XAxis
                  dataKey="name"
                  tickLine={false}
                  axisLine={false}
                  tick={{ fontSize: 11 }}
                  interval={0}
                  angle={-30}
                  height={50}
                  textAnchor="end"
                />
                <YAxis
                  yAxisId="revenue"
                  tickLine={false}
                  axisLine={false}
                  width={56}
                  tickFormatter={(v: number) => formatUsd(v)}
                />
                <YAxis
                  yAxisId="orders"
                  orientation="right"
                  tickLine={false}
                  axisLine={false}
                  width={36}
                  allowDecimals={false}
                />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar yAxisId="revenue" dataKey="revenue" radius={[3, 3, 0, 0]}>
                  {chartRows.map((r) => (
                    <Cell
                      key={r.name}
                      fill={r.name === topSlotName ? "hsl(190, 90%, 30%)" : CHART_COLORS[0]}
                    />
                  ))}
                </Bar>
                <Bar
                  yAxisId="orders"
                  dataKey="orders"
                  fill={CHART_COLORS[2]}
                  radius={[3, 3, 0, 0]}
                  maxBarSize={14}
                />
              </BarChart>
            </ChartContainer>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {kpis.map((k) => (
                <div key={k.label} className="rounded-lg border p-3">
                  <p className="text-xs text-muted-foreground">{k.label}</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums">{k.value}</p>
                </div>
              ))}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs font-medium text-muted-foreground">
                    <th className="px-2 py-2 text-start">{t("storeAnalytics.sales.timeSlots.colSlot")}</th>
                    <th className="px-2 py-2 text-end">{t("storeAnalytics.sales.orders")}</th>
                    <th className="px-2 py-2 text-end">{t("storeAnalytics.revenue")}</th>
                    <th className="px-2 py-2 text-end">{t("storeAnalytics.sales.share")}</th>
                    <th className="px-2 py-2 text-end">{t("storeAnalytics.sales.timeSlots.colStandard")}</th>
                    <th className="px-2 py-2 text-end">{t("storeAnalytics.sales.timeSlots.colExpress")}</th>
                    <th className="px-2 py-2 text-end">{t("storeAnalytics.sales.timeSlots.colExpressSurcharge")}</th>
                    <th className="px-2 py-2 text-end">{t("storeAnalytics.sales.timeSlots.colSlotFee")}</th>
                  </tr>
                </thead>
                <tbody>
                  {slots.map((s, i) => (
                    <tr key={s.slot ?? `none-${i}`} className="border-b last:border-0 hover:bg-muted/50">
                      <td className="px-2 py-2">
                        <span className="flex items-center gap-2">
                          <span
                            className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                            style={{ backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }}
                          />
                          <span dir="ltr">
                            {s.slot ?? t("storeAnalytics.sales.timeSlots.noSlot")}
                          </span>
                        </span>
                      </td>
                      <td className="px-2 py-2 text-end tabular-nums">{s.orders}</td>
                      <td className="px-2 py-2 text-end font-medium tabular-nums">{formatUsd(s.revenue)}</td>
                      <td className="px-2 py-2 text-end tabular-nums text-muted-foreground">
                        {s.sharePct.toFixed(1)}%
                      </td>
                      <td className="px-2 py-2 text-end tabular-nums text-muted-foreground">
                        {s.standardOrders} · {formatUsd(s.standardRevenue)}
                      </td>
                      <td className="px-2 py-2 text-end tabular-nums text-muted-foreground">
                        {s.expressOrders} · {formatUsd(s.expressRevenue)}
                      </td>
                      <td className="px-2 py-2 text-end tabular-nums text-muted-foreground">
                        {formatUsd(s.expressSurchargeUsd)}
                      </td>
                      <td className="px-2 py-2 text-end tabular-nums text-muted-foreground">
                        {formatUsd(s.slotFeeUsd)}
                      </td>
                    </tr>
                  ))}
                  {totals && (
                    <tr className="font-medium">
                      <td className="px-2 py-2">{t("storeAnalytics.sales.timeSlots.total")}</td>
                      <td className="px-2 py-2 text-end tabular-nums">{totals.orders}</td>
                      <td className="px-2 py-2 text-end tabular-nums">{formatUsd(totals.revenue)}</td>
                      <td className="px-2 py-2 text-end tabular-nums">100%</td>
                      <td className="px-2 py-2 text-end tabular-nums">
                        {totals.orders - totals.expressOrders} · {formatUsd(totals.revenue - totals.expressRevenue)}
                      </td>
                      <td className="px-2 py-2 text-end tabular-nums">
                        {totals.expressOrders} · {formatUsd(totals.expressRevenue)}
                      </td>
                      <td className="px-2 py-2 text-end tabular-nums">{formatUsd(totals.expressSurchargeUsd)}</td>
                      <td className="px-2 py-2 text-end tabular-nums">{formatUsd(totals.slotFeeUsd)}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <EmptyChart message={emptyMessage} />
        )}
      </CardContent>
    </Card>
  );
}

/** Short localized weekday names in Postgres DOW order (0=Sunday .. 6=Saturday). */
function useWeekdayLabels(lang: string): string[] {
  return useMemo(() => {
    const fmt = new Intl.DateTimeFormat(lang || undefined, { weekday: "short" });
    // 2023-01-01 was a Sunday.
    return Array.from({ length: 7 }, (_, i) => fmt.format(new Date(2023, 0, 1 + i)));
  }, [lang]);
}

/** Custom tooltip for the DOW bar chart showing revenue + orders. */
function DowTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: Array<{ payload: { revenue: number; orders: number } }>;
  label?: string;
}) {
  const { t } = useTranslation();
  if (!active || !payload?.length) return null;
  const { revenue, orders } = payload[0].payload;
  return (
    <div className="rounded-lg border bg-background px-3 py-2 text-sm shadow-md">
      <p className="mb-1 font-medium">{label}</p>
      <p className="text-muted-foreground">
        {t("storeAnalytics.revenue")}: <span className="font-medium text-foreground">{formatUsd(revenue)}</span>
      </p>
      <p className="text-muted-foreground">
        {t("storeAnalytics.sales.orders")}: <span className="font-medium text-foreground">{orders}</span>
      </p>
    </div>
  );
}

/** Revenue by Day of Week bar chart — only visible when range is weekly (≤7 days). */
export function RevenueByDowCard({
  hourlyHeatmap,
  resolvedRange,
  isThisWeek,
  emptyMessage,
}: {
  hourlyHeatmap: StoreHeatmapCell[];
  resolvedRange: { from: Date; to: Date };
  isThisWeek: boolean;
  emptyMessage: string;
}) {
  const { t, i18n } = useTranslation();

  const dowData = useMemo(() => {
    // Aggregate heatmap cells by dow (sum revenue + orders across all hours for that day).
    const byDow: Record<number, { revenue: number; orders: number }> = {};
    for (const cell of hourlyHeatmap) {
      if (!byDow[cell.dow]) byDow[cell.dow] = { revenue: 0, orders: 0 };
      byDow[cell.dow].revenue += cell.revenue;
      byDow[cell.dow].orders += cell.orders;
    }

    // Build the actual days covered by the range (from inclusive, to exclusive).
    const days: { dow: number; date: Date }[] = [];
    const cursor = new Date(resolvedRange.from);
    while (cursor < resolvedRange.to) {
      days.push({ dow: cursor.getDay(), date: new Date(cursor) });
      cursor.setDate(cursor.getDate() + 1);
    }

    // Sort Mon→Sun (JS getDay: 0=Sun,1=Mon…6=Sat → ISO order: 1,2,3,4,5,6,0).
    const MON_FIRST_ORDER = [1, 2, 3, 4, 5, 6, 0];
    days.sort((a, b) => MON_FIRST_ORDER.indexOf(a.dow) - MON_FIRST_ORDER.indexOf(b.dow));

    const todayStr = new Date().toDateString();
    const weekdayFmt = new Intl.DateTimeFormat(i18n.language || undefined, { weekday: "short" });
    const dayFmt = new Intl.DateTimeFormat(i18n.language || undefined, { day: "numeric", month: "short" });

    return days.map(({ dow, date }) => ({
      dow,
      date,
      label: `${weekdayFmt.format(date)} ${dayFmt.format(date)}`,
      revenue: byDow[dow]?.revenue ?? 0,
      orders: byDow[dow]?.orders ?? 0,
      isToday: isThisWeek && date.toDateString() === todayStr,
    }));
  }, [hourlyHeatmap, resolvedRange, isThisWeek, i18n.language]);

  const allZero = dowData.every((d) => d.revenue === 0);
  const todayFill = "hsl(190, 90%, 30%)";
  const defaultFill = CHART_COLORS[0];

  const config = {
    revenue: { label: t("storeAnalytics.revenue"), color: defaultFill },
  } satisfies ChartConfig;

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <CardTitle className="text-base">{t("storeAnalytics.sales.revenueByDow")}</CardTitle>
      </CardHeader>
      <CardContent>
        {allZero ? (
          <EmptyChart message={emptyMessage} />
        ) : (
          <ChartContainer
            config={config}
            className="h-[260px] w-full"
            data-testid="chart-revenue-by-dow"
            data-has-today={dowData.some((d) => d.isToday) ? "true" : undefined}
          >
            <BarChart data={dowData} margin={{ left: 8, right: 8 }}>
              <CartesianGrid vertical={false} strokeDasharray="3 3" />
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={false}
                tick={{ fontSize: 11 }}
                interval={0}
              />
              <YAxis
                tickLine={false}
                axisLine={false}
                fontSize={11}
                width={56}
                tickFormatter={formatCompactUsd}
              />
              <ChartTooltip content={<DowTooltip />} />
              <Bar dataKey="revenue" radius={[3, 3, 0, 0]}>
                {dowData.map((d, i) => (
                  <Cell key={i} fill={d.isToday ? todayFill : defaultFill} />
                ))}
              </Bar>
            </BarChart>
          </ChartContainer>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Traffic source breakdown card with click-through to the orders page
 * pre-filtered by marketing attribution source.
 */
function TrafficSourceBreakdownCard({
  title,
  items,
}: {
  title: string;
  items: StoreFunnelBreakdownItem[];
}) {
  const { t } = useTranslation();
  const [, navigate] = useLocation();

  function handleRowClick(value: string) {
    navigate(`/orders?attribution=${encodeURIComponent(value)}`);
  }

  return (
    <BreakdownCard
      title={title}
      items={items}
      labelFor={(v) =>
        v === "unknown"
          ? t("storeAnalytics.funnel.unknown")
          : t(`storeAnalytics.trafficSourceLabels.${v.replace(/\./g, "_")}`, {
              defaultValue: formatSourceLabel(v),
            })
      }
      onRowClick={handleRowClick}
    />
  );
}

export function StoreSalesSection({
  apiParams,
  preset,
  resolvedRange,
}: {
  apiParams: GetStoreSalesParams;
  preset: DatePreset;
  resolvedRange: { from: Date; to: Date };
}) {
  const { t, i18n } = useTranslation();

  const isWeeklyRange = useMemo(() => {
    const spanMs = resolvedRange.to.getTime() - resolvedRange.from.getTime();
    const spanDays = Math.ceil(spanMs / (1000 * 60 * 60 * 24));
    return spanDays <= 7;
  }, [resolvedRange]);

  const isThisWeek = preset === "this_week";
  const salesParams = useMemo<GetStoreSalesParams>(
    () => ({
      from: apiParams.from,
      to: apiParams.to,
      country: apiParams.country,
      city: apiParams.city,
      brand: apiParams.brand,
      channel: apiParams.channel,
    }),
    [apiParams.from, apiParams.to, apiParams.country, apiParams.city, apiParams.brand, apiParams.channel],
  );
  const { data, isLoading, isError } = useGetStoreSales(salesParams, {
    query: {
      queryKey: getGetStoreSalesQueryKey(salesParams),
      placeholderData: (prev) => prev,
    },
  });
  const { data: timeSlotData, isLoading: timeSlotsLoading } = useGetStoreTimeSlots(
    salesParams,
    {
      query: {
        queryKey: getGetStoreTimeSlotsQueryKey(salesParams),
        placeholderData: (prev) => prev,
      },
    },
  );
  const { data: funnelData } = useGetStoreFunnel(salesParams, {
    query: {
      queryKey: getGetStoreFunnelQueryKey(salesParams),
      placeholderData: (prev) => prev,
    },
  });

  const weekdays = useWeekdayLabels(i18n.language);

  const heatmapMax = useMemo(() => {
    if (!data) return 0;
    return data.hourlyHeatmap.reduce((m, c) => Math.max(m, c.orders), 0);
  }, [data]);

  const heatmapGrid = useMemo(() => {
    // grid[dow][hour] = orders
    const grid: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
    if (data) {
      for (const c of data.hourlyHeatmap) {
        if (c.dow >= 0 && c.dow < 7 && c.hour >= 0 && c.hour < 24) {
          grid[c.dow][c.hour] = c.orders;
        }
      }
    }
    return grid;
  }, [data]);

  const revenueConfig = {
    revenue: { label: t("storeAnalytics.revenue"), color: CHART_COLORS[0] },
  } satisfies ChartConfig;
  const ordersConfig = {
    orders: { label: t("storeAnalytics.sales.orders"), color: CHART_COLORS[1] },
  } satisfies ChartConfig;

  const noData = t("storeAnalytics.noData");

  const sourceRows = useMemo(
    () =>
      (data?.ordersBySource ?? []).map((s) => ({
        name: t(`storeAnalytics.sales.source.${s.source}`, s.source),
        value: s.orders,
        revenue: s.revenue,
      })),
    [data, t],
  );

  return (
    <div className="space-y-4" data-testid="section-sales">
      <div className="flex justify-end">
        <AnalyticsExportMenu
          filename="store-analytics-sales"
          title="E-commerce Analytics — Sales"
          filterSummary={buildFilterSummary(salesParams)}
          getDatasets={() => datasetsFromResponse(data)}
          disabled={isLoading || !data}
        />
      </div>
      <div>
        <h2 className="text-lg font-semibold tracking-tight">
          {t("storeAnalytics.sales.title")}
        </h2>
        <p className="text-sm text-muted-foreground">{t("storeAnalytics.sales.subtitle")}</p>
      </div>

      {isError && (
        <Card>
          <CardContent className="p-6 text-center text-sm text-red-500">
            {t("storeAnalytics.loadError")}
          </CardContent>
        </Card>
      )}

      {isLoading && !data ? (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[300px] w-full" />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {/* Revenue over time */}
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle className="text-base">
                {t("storeAnalytics.sales.revenueOverTime")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {data && data.revenueOverTime.length > 0 ? (
                <ChartContainer config={revenueConfig} className="h-[260px] w-full">
                  <AreaChart data={data.revenueOverTime} margin={{ left: 8, right: 8 }}>
                    <defs>
                      <linearGradient id="salesRevFill" x1="0" y1="0" x2="0" y2="1">
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
                    <Area
                      type="monotone"
                      dataKey="revenue"
                      stroke={CHART_COLORS[0]}
                      fill="url(#salesRevFill)"
                      strokeWidth={2}
                    />
                  </AreaChart>
                </ChartContainer>
              ) : (
                <EmptyChart message={noData} />
              )}
            </CardContent>
          </Card>

          {/* Orders over time */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {t("storeAnalytics.sales.ordersOverTime")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {data && data.revenueOverTime.length > 0 ? (
                <ChartContainer config={ordersConfig} className="h-[240px] w-full">
                  <LineChart data={data.revenueOverTime} margin={{ left: 8, right: 8 }}>
                    <CartesianGrid vertical={false} strokeDasharray="3 3" />
                    <XAxis dataKey="date" tickLine={false} axisLine={false} fontSize={11} />
                    <YAxis
                      tickLine={false}
                      axisLine={false}
                      fontSize={11}
                      width={36}
                      allowDecimals={false}
                    />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Line
                      type="monotone"
                      dataKey="orders"
                      stroke={CHART_COLORS[1]}
                      strokeWidth={2}
                      dot={false}
                    />
                  </LineChart>
                </ChartContainer>
              ) : (
                <EmptyChart message={noData} />
              )}
            </CardContent>
          </Card>

          {/* Best-selling hours */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {t("storeAnalytics.sales.revenueByHour")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {data && data.revenueByHour.some((h) => h.revenue > 0 || h.orders > 0) ? (
                <ChartContainer config={revenueConfig} className="h-[240px] w-full">
                  <BarChart data={data.revenueByHour} margin={{ left: 8, right: 8 }}>
                    <CartesianGrid vertical={false} strokeDasharray="3 3" />
                    <XAxis
                      dataKey="hour"
                      tickLine={false}
                      axisLine={false}
                      fontSize={11}
                      interval={2}
                      tickFormatter={(v: number) => `${v}h`}
                    />
                    <YAxis
                      tickLine={false}
                      axisLine={false}
                      fontSize={11}
                      width={48}
                      tickFormatter={(v: number) => `$${v}`}
                    />
                    <ChartTooltip content={<ChartTooltipContent />} />
                    <Bar dataKey="revenue" fill={CHART_COLORS[0]} radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ChartContainer>
              ) : (
                <EmptyChart message={noData} />
              )}
            </CardContent>
          </Card>

          {/* Revenue by Day of Week — only for weekly ranges (≤7 days) */}
          {isWeeklyRange && data && (
            <RevenueByDowCard
              hourlyHeatmap={data.hourlyHeatmap}
              resolvedRange={resolvedRange}
              isThisWeek={isThisWeek}
              emptyMessage={noData}
            />
          )}

          {/* Hourly order heatmap */}
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle className="text-base">
                {t("storeAnalytics.sales.hourlyHeatmap")}
              </CardTitle>
              <p className="text-xs text-muted-foreground">
                {t("storeAnalytics.sales.heatmapHint")}
              </p>
            </CardHeader>
            <CardContent>
              {data && heatmapMax > 0 ? (
                <div className="overflow-x-auto" data-testid="heatmap-orders">
                  <div className="min-w-[560px]">
                    {/* Hour header */}
                    <div className="flex items-center gap-1 pl-10">
                      {Array.from({ length: 24 }, (_, h) => (
                        <div
                          key={h}
                          className="flex-1 text-center text-[9px] text-muted-foreground"
                        >
                          {h % 3 === 0 ? h : ""}
                        </div>
                      ))}
                    </div>
                    {heatmapGrid.map((row, dow) => (
                      <div key={dow} className="mt-1 flex items-center gap-1">
                        <div className="w-9 shrink-0 text-[10px] text-muted-foreground">
                          {weekdays[dow]}
                        </div>
                        {row.map((orders, hour) => {
                          const intensity = heatmapMax > 0 ? orders / heatmapMax : 0;
                          return (
                            <div
                              key={hour}
                              className="aspect-square flex-1 rounded-[3px] border border-border/40"
                              style={{
                                backgroundColor:
                                  orders > 0
                                    ? `hsla(210, 100%, 45%, ${0.12 + intensity * 0.88})`
                                    : "transparent",
                              }}
                              title={`${weekdays[dow]} ${hour}:00 — ${orders}`}
                            />
                          );
                        })}
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <EmptyChart message={noData} />
              )}
            </CardContent>
          </Card>

          {/* Revenue by channel */}
          <BarBreakdownCard
            title={t("storeAnalytics.sales.revenueByChannel")}
            data={data?.revenueByChannel ?? []}
            colorIndex={0}
            emptyMessage={noData}
            testid="chart-revenue-by-channel"
          />

          {/* Revenue by city */}
          <CityRevenueChart
            title={t("storeAnalytics.sales.revenueByCity")}
            data={data?.revenueByCity ?? []}
            emptyMessage={noData}
          />

          {/* Revenue by payment method */}
          <BarBreakdownCard
            title={t("storeAnalytics.sales.revenueByPaymentMethod")}
            data={data?.revenueByPaymentMethod ?? []}
            colorIndex={3}
            emptyMessage={noData}
            testid="chart-revenue-by-payment-method"
          />

          {/* Orders by source (donut) */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {t("storeAnalytics.sales.ordersBySource")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {sourceRows.length > 0 ? (
                <ChartContainer config={{}} className="mx-auto h-[240px]" data-testid="chart-orders-by-source">
                  <PieChart>
                    <ChartTooltip content={<ChartTooltipContent nameKey="name" />} />
                    <Pie
                      data={sourceRows}
                      dataKey="value"
                      nameKey="name"
                      innerRadius={55}
                      outerRadius={90}
                      paddingAngle={2}
                    >
                      {sourceRows.map((_, i) => (
                        <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                      ))}
                    </Pie>
                  </PieChart>
                </ChartContainer>
              ) : (
                <EmptyChart message={noData} />
              )}
            </CardContent>
          </Card>

          {/* By traffic source (funnel breakdown reused) */}
          <TrafficSourceBreakdownCard
            title={t("storeAnalytics.sales.byTrafficSource")}
            items={funnelData?.breakdowns.trafficSource ?? []}
          />

          {/* Revenue by brand */}
          <BarBreakdownCard
            title={t("storeAnalytics.sales.revenueByBrand")}
            data={data?.revenueByBrand ?? []}
            colorIndex={2}
            emptyMessage={noData}
            testid="chart-revenue-by-brand"
          />

          {/* Revenue by occasion */}
          <BarBreakdownCard
            title={t("storeAnalytics.sales.revenueByOccasion")}
            data={data?.revenueByOccasion ?? []}
            colorIndex={4}
            emptyMessage={noData}
            testid="chart-revenue-by-occasion"
          />

          {/* Performance by country (unified: visitors, orders, revenue, AOV, conversion rate) */}
          <PerformanceByCountryCard
            rows={data?.revenueByCountry ?? []}
            emptyMessage={noData}
            testid="table-performance-by-country"
          />

          {/* AOV by Country: sorted by AOV descending */}
          <AovByCountryCard
            rows={data?.revenueByCountry ?? []}
            emptyMessage={noData}
            testid="table-aov-by-country"
          />

          {/* Conversion Rate by Country: sorted by conversion rate descending */}
          <ConversionByCountryCard
            rows={data?.revenueByCountry ?? []}
            emptyMessage={noData}
            testid="table-conversion-by-country"
          />

          {/* Revenue by currency (table) */}
          <TableBreakdownCard
            title={t("storeAnalytics.sales.revenueByCurrency")}
            nameHeader={t("storeAnalytics.sales.currency")}
            rows={data?.revenueByCurrency ?? []}
            emptyMessage={noData}
            ordersLabel={t("storeAnalytics.sales.orders")}
            revenueLabel={t("storeAnalytics.revenue")}
            testid="table-revenue-by-currency"
          />

          {/* Sales by delivery time slot */}
          <TimeSlotsCard
            data={timeSlotData}
            isLoading={timeSlotsLoading}
            emptyMessage={noData}
          />
        </div>
      )}
    </div>
  );
}

export default StoreSalesSection;
