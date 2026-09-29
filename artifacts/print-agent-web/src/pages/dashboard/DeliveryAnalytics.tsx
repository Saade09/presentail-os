import { useTranslation } from "react-i18next";
import {
  useGetDeliveryAnalytics,
  getGetDeliveryAnalyticsQueryKey,
  type DeliveryAnalyticsKpis,
} from "@workspace/api-client-react";
import { useStoreAnalyticsFilters } from "@/hooks/use-store-analytics-filters";
import { StoreAnalyticsFilterBar } from "@/components/StoreAnalyticsFilterBar";
import { AnalyticsExportMenu } from "@/components/AnalyticsExportMenu";
import { buildFilterSummary, datasetsFromResponse } from "@/lib/analytics-export";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from "recharts";
import {
  TrendingUp,
  TrendingDown,
  Minus,
  Truck,
  CalendarClock,
  Timer,
  XCircle,
  DollarSign,
  Wallet,
  Gift,
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

function DeltaBadge({
  current,
  previous,
  invert = false,
}: {
  current: number;
  previous: number | null | undefined;
  invert?: boolean;
}) {
  if (previous === null || previous === undefined) return null;

  if (previous === 0 && current === 0) {
    return (
      <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground">
        <Minus size={12} />—
      </span>
    );
  }

  const pct = previous === 0 ? 100 : Math.round(((current - previous) / previous) * 100);
  if (pct === 0) {
    return (
      <span className="inline-flex items-center gap-0.5 text-xs text-muted-foreground">
        <Minus size={12} />0%
      </span>
    );
  }

  const isUp = pct > 0;
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
      {pct}%
    </span>
  );
}

function KpiCard({
  icon,
  label,
  value,
  current,
  previous,
  invert,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  current?: number;
  previous?: number | null;
  invert?: boolean;
  hint?: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">{label}</span>
          <span className="text-muted-foreground">{icon}</span>
        </div>
        <div className="mt-2 text-2xl font-semibold tracking-tight">{value}</div>
        <div className="mt-1 flex items-center gap-2">
          {current !== undefined && previous !== undefined && (
            <DeltaBadge current={current} previous={previous} invert={invert} />
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

export default function DeliveryAnalyticsPage() {
  const { t } = useTranslation();
  const filters = useStoreAnalyticsFilters();
  const { data, isLoading, isError } = useGetDeliveryAnalytics(filters.apiParams, {
    query: {
      queryKey: getGetDeliveryAnalyticsQueryKey(filters.apiParams),
      placeholderData: (prev) => prev,
    },
  });

  const kpis: DeliveryAnalyticsKpis | undefined = data?.kpis;
  const prev = data?.previousKpis ?? null;

  const ordersConfig = {
    orders: { label: t("deliveryAnalytics.orders"), color: CHART_COLORS[0] },
  } satisfies ChartConfig;

  const sameDay = data?.sameDayVsScheduled.sameDay ?? 0;
  const scheduled = data?.sameDayVsScheduled.scheduled ?? 0;

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {t("deliveryAnalytics.title")}
        </h1>
        <p className="text-sm text-muted-foreground">{t("deliveryAnalytics.subtitle")}</p>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <StoreAnalyticsFilterBar filters={filters} />
        </div>
        <AnalyticsExportMenu
          filename="delivery-analytics"
          title="Delivery Analytics"
          filterSummary={buildFilterSummary(filters.apiParams)}
          getDatasets={() => datasetsFromResponse(data)}
          disabled={isLoading || !data}
        />
      </div>

      {isError && (
        <Card>
          <CardContent className="p-6 text-center text-sm text-red-500">
            {t("deliveryAnalytics.loadError")}
          </CardContent>
        </Card>
      )}

      {/* KPI cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {isLoading && !data ? (
          Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-[104px] w-full" />
          ))
        ) : (
          <>
            <KpiCard
              icon={<Truck size={16} />}
              label={t("deliveryAnalytics.kpi.totalDeliveries")}
              value={String(kpis?.totalDeliveries ?? 0)}
              current={kpis?.totalDeliveries}
              previous={prev?.totalDeliveries}
            />
            <KpiCard
              icon={<Timer size={16} />}
              label={t("deliveryAnalytics.kpi.onTimeRate")}
              value={
                kpis?.onTimeRate != null
                  ? formatPct(kpis.onTimeRate)
                  : t("deliveryAnalytics.notAvailable")
              }
              current={kpis?.onTimeRate ?? undefined}
              previous={prev?.onTimeRate ?? undefined}
            />
            <KpiCard
              icon={<TrendingDown size={16} />}
              label={t("deliveryAnalytics.kpi.lateDeliveries")}
              value={String(kpis?.lateDeliveries ?? 0)}
              current={kpis?.lateDeliveries}
              previous={prev?.lateDeliveries}
              invert
            />
            <KpiCard
              icon={<XCircle size={16} />}
              label={t("deliveryAnalytics.kpi.failedDeliveries")}
              value={String(kpis?.failedDeliveries ?? 0)}
              current={kpis?.failedDeliveries}
              previous={prev?.failedDeliveries}
              invert
            />
            <KpiCard
              icon={<DollarSign size={16} />}
              label={t("deliveryAnalytics.kpi.avgDeliveryFee")}
              value={formatUsd(kpis?.avgDeliveryFee ?? 0)}
              current={kpis?.avgDeliveryFee}
              previous={prev?.avgDeliveryFee}
            />
            <KpiCard
              icon={<DollarSign size={16} />}
              label={t("deliveryAnalytics.kpi.deliveryRevenue")}
              value={formatUsd(kpis?.deliveryRevenue ?? 0)}
              current={kpis?.deliveryRevenue}
              previous={prev?.deliveryRevenue}
            />
            <KpiCard
              icon={<Wallet size={16} />}
              label={t("deliveryAnalytics.kpi.deliveryProfit")}
              value={formatUsd(kpis?.deliveryProfit ?? 0)}
              current={kpis?.deliveryProfit}
              previous={prev?.deliveryProfit}
              hint={
                kpis?.deliveryCost != null
                  ? t("deliveryAnalytics.costHint", { cost: formatUsd(kpis.deliveryCost) })
                  : undefined
              }
            />
            <KpiCard
              icon={<Gift size={16} />}
              label={t("deliveryAnalytics.kpi.freeDeliveryOrders")}
              value={String(kpis?.freeDeliveryOrders ?? 0)}
              current={kpis?.freeDeliveryOrders}
              previous={prev?.freeDeliveryOrders}
            />
          </>
        )}
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Orders by delivery date */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">
              {t("deliveryAnalytics.chart.ordersByDeliveryDate")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data && data.ordersByDeliveryDate.length > 0 ? (
              <ChartContainer config={ordersConfig} className="h-[260px] w-full">
                <AreaChart
                  data={data.ordersByDeliveryDate}
                  margin={{ left: 8, right: 8 }}
                >
                  <defs>
                    <linearGradient id="ordFill" x1="0" y1="0" x2="0" y2="1">
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
                    width={40}
                    allowDecimals={false}
                  />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Area
                    type="monotone"
                    dataKey="orders"
                    stroke={CHART_COLORS[0]}
                    fill="url(#ordFill)"
                    strokeWidth={2}
                  />
                </AreaChart>
              </ChartContainer>
            ) : (
              <EmptyChart message={t("deliveryAnalytics.noData")} />
            )}
          </CardContent>
        </Card>

        {/* Same-day vs scheduled (donut) */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t("deliveryAnalytics.chart.sameDayVsScheduled")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data && (sameDay > 0 || scheduled > 0) ? (
              <ChartContainer config={{}} className="mx-auto h-[240px]">
                <PieChart>
                  <ChartTooltip content={<ChartTooltipContent nameKey="name" />} />
                  <Pie
                    data={[
                      { name: t("deliveryAnalytics.sameDay"), value: sameDay },
                      { name: t("deliveryAnalytics.scheduled"), value: scheduled },
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
              <EmptyChart message={t("deliveryAnalytics.noData")} />
            )}
          </CardContent>
        </Card>

        {/* Delivery slot usage (bars) */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CalendarClock size={16} />
              {t("deliveryAnalytics.chart.slotUsage")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data && data.slotUsage.length > 0 ? (
              <ChartContainer config={ordersConfig} className="h-[240px] w-full">
                <BarChart
                  data={data.slotUsage}
                  layout="vertical"
                  margin={{ left: 8, right: 8 }}
                >
                  <CartesianGrid horizontal={false} strokeDasharray="3 3" />
                  <XAxis
                    type="number"
                    tickLine={false}
                    axisLine={false}
                    fontSize={11}
                    allowDecimals={false}
                  />
                  <YAxis
                    type="category"
                    dataKey="slot"
                    tickLine={false}
                    axisLine={false}
                    fontSize={11}
                    width={90}
                  />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="orders" fill={CHART_COLORS[2]} radius={4} />
                </BarChart>
              </ChartContainer>
            ) : (
              <EmptyChart message={t("deliveryAnalytics.noData")} />
            )}
          </CardContent>
        </Card>
      </div>

      {/* Per city/district breakdown */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t("deliveryAnalytics.chart.byDistrict")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {data && data.districts.length > 0 ? (() => {
            const maxOrders = Math.max(...data.districts.map((d) => d.orders), 1);
            return (
              <div className="overflow-x-auto">
                <div className="max-h-[520px] overflow-auto">
                  <Table>
                    <TableHeader className="sticky top-0 z-10 bg-background">
                      <TableRow className="border-b-0">
                        <TableHead rowSpan={2} className="align-bottom border-b pb-2" />
                        <TableHead rowSpan={2} className="align-bottom border-b pb-2">
                          {t("deliveryAnalytics.district")}
                        </TableHead>
                        <TableHead rowSpan={2} className="text-right align-bottom border-b pb-2">
                          {t("deliveryAnalytics.orders")}
                        </TableHead>
                        <TableHead
                          colSpan={3}
                          className="text-center text-xs font-medium uppercase tracking-wide text-muted-foreground bg-muted/40 border-b-0 pb-1"
                        >
                          {t("deliveryAnalytics.groupFinancials")}
                        </TableHead>
                        <TableHead
                          colSpan={4}
                          className="text-center text-xs font-medium uppercase tracking-wide text-muted-foreground bg-muted/40 border-b-0 pb-1"
                        >
                          {t("deliveryAnalytics.groupPerformance")}
                        </TableHead>
                        <TableHead rowSpan={2} className="text-right align-bottom border-b pb-2">
                          {t("deliveryAnalytics.window")}
                        </TableHead>
                      </TableRow>
                      <TableRow>
                        <TableHead className="text-right border-b pb-2">
                          {t("deliveryAnalytics.revenue")}
                        </TableHead>
                        <TableHead className="text-right border-b pb-2">
                          {t("deliveryAnalytics.avgFee")}
                        </TableHead>
                        <TableHead className="text-right border-b pb-2">
                          {t("deliveryAnalytics.cost")}
                        </TableHead>
                        <TableHead className="text-right border-b pb-2">
                          {t("deliveryAnalytics.freeOrders")}
                        </TableHead>
                        <TableHead className="text-right border-b pb-2">
                          {t("deliveryAnalytics.late")}
                        </TableHead>
                        <TableHead className="text-right border-b pb-2">
                          {t("deliveryAnalytics.failed")}
                        </TableHead>
                        <TableHead className="text-right border-b pb-2">
                          {t("deliveryAnalytics.driverAssigned")}
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.districts.map((d, i) => (
                        <TableRow
                          key={d.cityId ?? d.name ?? i}
                          data-testid={`row-district-${i}`}
                          className={cn(
                            "even:bg-muted/30",
                            i === 0 && "border-s-2 border-teal-500",
                          )}
                        >
                          <TableCell className="w-8 text-center text-xs text-muted-foreground tabular-nums font-mono">
                            {i + 1}
                          </TableCell>
                          <TableCell className="font-medium">{d.name}</TableCell>
                          <TableCell className="text-right tabular-nums">
                            <div className="flex flex-col items-end gap-1">
                              <span>{d.orders}</span>
                              <div className="h-1 w-24 rounded-full bg-muted overflow-hidden">
                                <div
                                  className="h-full rounded-full bg-teal-400/70"
                                  style={{ width: `${(d.orders / maxOrders) * 100}%` }}
                                />
                              </div>
                            </div>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatUsd(d.revenue)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatUsd(d.avgFee)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatUsd(d.cost)}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {d.freeDeliveryOrders}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {d.lateOrders > 0 ? (
                              <span className="inline-flex items-center justify-center rounded-full px-2 py-0.5 text-xs font-medium bg-amber-50 text-amber-700">
                                {d.lateOrders}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">0</span>
                            )}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {d.failedOrders > 0 ? (
                              <span className="inline-flex items-center justify-center rounded-full px-2 py-0.5 text-xs font-medium bg-red-50 text-red-600">
                                {d.failedOrders}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">0</span>
                            )}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {d.driverAssignedOrders}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {d.windowLabel ? (
                              <code className="rounded bg-muted px-1.5 py-0.5 text-xs font-mono">
                                {d.windowLabel}
                              </code>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            );
          })() : (
            <EmptyChart message={t("deliveryAnalytics.noData")} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
