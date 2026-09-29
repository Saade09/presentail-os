import { useTranslation } from "react-i18next";
import {
  useGetStoreCustomerInsights,
  getGetStoreCustomerInsightsQueryKey,
  type StoreCustomerKpis,
} from "@workspace/api-client-react";
import { useStoreAnalyticsFilters } from "@/hooks/use-store-analytics-filters";
import { StoreAnalyticsFilterBar } from "@/components/StoreAnalyticsFilterBar";
import { AnalyticsExportMenu } from "@/components/AnalyticsExportMenu";
import { buildFilterSummary, datasetsFromResponse } from "@/lib/analytics-export";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, XAxis, YAxis } from "recharts";
import {
  TrendingUp,
  TrendingDown,
  Minus,
  Users,
  UserPlus,
  Repeat,
  DollarSign,
  ShoppingBag,
  Gift,
  Heart,
  Crown,
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

function formatNum(n: number): string {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(n);
}

function DeltaBadge({
  current,
  previous,
}: {
  current: number;
  previous: number | null | undefined;
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
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-xs font-medium",
        isUp ? "text-green-600" : "text-red-500",
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
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  current?: number;
  previous?: number | null;
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
            <DeltaBadge current={current} previous={previous} />
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

export default function CustomerAnalyticsPage() {
  const { t } = useTranslation();
  const filters = useStoreAnalyticsFilters();
  const { data, isLoading, isError } = useGetStoreCustomerInsights(filters.apiParams, {
    query: {
      queryKey: getGetStoreCustomerInsightsQueryKey(filters.apiParams),
      placeholderData: (prev) => prev,
    },
  });

  const kpis: StoreCustomerKpis | undefined = data?.kpis;
  const prev = data?.previousKpis ?? null;
  const gifting = data?.gifting;

  const countConfig = {
    customers: { label: t("customerAnalytics.customers"), color: CHART_COLORS[0] },
  } satisfies ChartConfig;

  const ordersConfig = {
    orders: { label: t("customerAnalytics.orders"), color: CHART_COLORS[3] },
  } satisfies ChartConfig;

  return (
    <div className="space-y-6 p-4 sm:p-6" data-testid="page-customer-analytics">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {t("customerAnalytics.title")}
        </h1>
        <p className="text-sm text-muted-foreground">{t("customerAnalytics.subtitle")}</p>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <StoreAnalyticsFilterBar filters={filters} />
        </div>
        <AnalyticsExportMenu
          filename="customer-analytics"
          title="Customer Analytics"
          filterSummary={buildFilterSummary(filters.apiParams)}
          getDatasets={() => datasetsFromResponse(data)}
          disabled={isLoading || !data}
        />
      </div>

      {isError && (
        <Card>
          <CardContent className="p-6 text-center text-sm text-red-500">
            {t("customerAnalytics.loadError")}
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
              icon={<Users size={16} />}
              label={t("customerAnalytics.kpi.uniqueCustomers")}
              value={String(kpis?.uniqueCustomers ?? 0)}
              current={kpis?.uniqueCustomers}
              previous={prev?.uniqueCustomers}
            />
            <KpiCard
              icon={<UserPlus size={16} />}
              label={t("customerAnalytics.kpi.newCustomers")}
              value={String(kpis?.newCustomers ?? 0)}
              current={kpis?.newCustomers}
              previous={prev?.newCustomers}
              hint={t("customerAnalytics.kpi.returningHint", {
                count: kpis?.returningCustomers ?? 0,
              })}
            />
            <KpiCard
              icon={<Repeat size={16} />}
              label={t("customerAnalytics.kpi.repeatPurchaseRate")}
              value={formatPct(kpis?.repeatPurchaseRate ?? 0)}
              current={kpis?.repeatPurchaseRate}
              previous={prev?.repeatPurchaseRate}
            />
            <KpiCard
              icon={<DollarSign size={16} />}
              label={t("customerAnalytics.kpi.clv")}
              value={formatUsd(kpis?.clv ?? 0)}
              current={kpis?.clv}
              previous={prev?.clv}
            />
            <KpiCard
              icon={<ShoppingBag size={16} />}
              label={t("customerAnalytics.kpi.avgOrdersPerCustomer")}
              value={formatNum(kpis?.avgOrdersPerCustomer ?? 0)}
              current={kpis?.avgOrdersPerCustomer}
              previous={prev?.avgOrdersPerCustomer}
            />
            <KpiCard
              icon={<UserPlus size={16} />}
              label={t("customerAnalytics.kpi.aovNew")}
              value={formatUsd(data?.aovByType.new.aov ?? 0)}
              hint={t("customerAnalytics.kpi.ordersHint", {
                count: data?.aovByType.new.orders ?? 0,
              })}
            />
            <KpiCard
              icon={<Repeat size={16} />}
              label={t("customerAnalytics.kpi.aovReturning")}
              value={formatUsd(data?.aovByType.returning.aov ?? 0)}
              hint={t("customerAnalytics.kpi.ordersHint", {
                count: data?.aovByType.returning.orders ?? 0,
              })}
            />
            <KpiCard
              icon={<Gift size={16} />}
              label={t("customerAnalytics.kpi.uniqueSenders")}
              value={String(gifting?.uniqueSenders ?? 0)}
              hint={t("customerAnalytics.kpi.recipientsHint", {
                count: gifting?.uniqueRecipients ?? 0,
              })}
            />
          </>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* New vs returning (donut) */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t("customerAnalytics.chart.newVsReturning")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data && (kpis?.newCustomers || kpis?.returningCustomers) ? (
              <ChartContainer config={{}} className="mx-auto h-[240px]">
                <PieChart>
                  <ChartTooltip content={<ChartTooltipContent nameKey="name" />} />
                  <Pie
                    data={[
                      {
                        name: t("customerAnalytics.newCustomers"),
                        value: kpis?.newCustomers ?? 0,
                      },
                      {
                        name: t("customerAnalytics.returningCustomers"),
                        value: kpis?.returningCustomers ?? 0,
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
              <EmptyChart message={t("customerAnalytics.noData")} />
            )}
          </CardContent>
        </Card>

        {/* Recipient relationships (bars) */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Heart size={16} />
              {t("customerAnalytics.chart.relationships")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {gifting && gifting.topRelationships.length > 0 ? (
              <ChartContainer config={ordersConfig} className="h-[240px] w-full">
                <BarChart
                  data={gifting.topRelationships.slice(0, 8)}
                  layout="vertical"
                  margin={{ left: 8, right: 8 }}
                >
                  <CartesianGrid horizontal={false} strokeDasharray="3 3" />
                  <XAxis type="number" tickLine={false} axisLine={false} fontSize={11} allowDecimals={false} />
                  <YAxis
                    type="category"
                    dataKey="name"
                    tickLine={false}
                    axisLine={false}
                    fontSize={11}
                    width={90}
                  />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="orders" fill={CHART_COLORS[4]} radius={4} />
                </BarChart>
              </ChartContainer>
            ) : (
              <EmptyChart message={t("customerAnalytics.noData")} />
            )}
          </CardContent>
        </Card>

        {/* Top customers (VIPs) */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Crown size={16} />
              {t("customerAnalytics.chart.topCustomers")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data && data.topCustomers.length > 0 ? (
              <div className="space-y-1">
                <div className="flex items-center justify-between px-1 pb-2 text-xs font-medium text-muted-foreground">
                  <span>{t("customerAnalytics.customer")}</span>
                  <div className="flex gap-6">
                    <span className="w-16 text-right">{t("customerAnalytics.orders")}</span>
                    <span className="w-24 text-right">{t("customerAnalytics.revenue")}</span>
                  </div>
                </div>
                {data.topCustomers.map((c, i) => (
                  <div
                    key={c.id}
                    className="flex items-center justify-between rounded-md px-1 py-1.5 text-sm hover:bg-muted/50"
                    data-testid={`row-customer-${i}`}
                  >
                    <span className="flex items-center gap-2 truncate">
                      <span className="truncate">{c.name}</span>
                      {c.isVip && (
                        <Badge variant="secondary" className="shrink-0 gap-1">
                          <Crown size={10} />
                          {t("customerAnalytics.vip")}
                        </Badge>
                      )}
                    </span>
                    <div className="flex gap-6">
                      <span className="w-16 text-right tabular-nums text-muted-foreground">
                        {c.orders}
                      </span>
                      <span className="w-24 text-right font-medium tabular-nums">
                        {formatUsd(c.revenue)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyChart message={t("customerAnalytics.noData")} />
            )}
          </CardContent>
        </Card>

        {/* Customers by city (bars) */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t("customerAnalytics.chart.customersByCity")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data && data.customersByCity.length > 0 ? (
              <ChartContainer config={countConfig} className="h-[240px] w-full">
                <BarChart
                  data={data.customersByCity.slice(0, 8)}
                  layout="vertical"
                  margin={{ left: 8, right: 8 }}
                >
                  <CartesianGrid horizontal={false} strokeDasharray="3 3" />
                  <XAxis type="number" tickLine={false} axisLine={false} fontSize={11} allowDecimals={false} />
                  <YAxis
                    type="category"
                    dataKey="name"
                    tickLine={false}
                    axisLine={false}
                    fontSize={11}
                    width={90}
                  />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="customers" fill={CHART_COLORS[0]} radius={4} />
                </BarChart>
              </ChartContainer>
            ) : (
              <EmptyChart message={t("customerAnalytics.noData")} />
            )}
          </CardContent>
        </Card>

        {/* Customers by country (summary list) */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t("customerAnalytics.chart.customersByCountry")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data && data.customersByCountry.length > 0 ? (
              <div className="space-y-1">
                <div className="flex items-center justify-between px-1 pb-2 text-xs font-medium text-muted-foreground">
                  <span>{t("customerAnalytics.country")}</span>
                  <span className="w-24 text-right">{t("customerAnalytics.customers")}</span>
                </div>
                {data.customersByCountry.slice(0, 8).map((c, i) => (
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
                    <span className="w-24 text-right font-medium tabular-nums">
                      {c.customers}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyChart message={t("customerAnalytics.noData")} />
            )}
          </CardContent>
        </Card>

        {/* Gifting summary */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Gift size={16} />
              {t("customerAnalytics.chart.gifting")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {gifting ? (
              <div className="space-y-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">
                    {t("customerAnalytics.gifting.uniqueSenders")}
                  </span>
                  <span className="font-medium tabular-nums">{gifting.uniqueSenders}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">
                    {t("customerAnalytics.gifting.uniqueRecipients")}
                  </span>
                  <span className="font-medium tabular-nums">
                    {gifting.uniqueRecipients}
                  </span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">
                    {t("customerAnalytics.gifting.multipleRecipients")}
                  </span>
                  <span className="font-medium tabular-nums">
                    {gifting.customersWithMultipleRecipients}
                  </span>
                </div>
              </div>
            ) : (
              <EmptyChart message={t("customerAnalytics.noData")} />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
