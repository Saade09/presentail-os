import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { AnalyticsExportMenu } from "@/components/AnalyticsExportMenu";
import { buildFilterSummary, datasetsFromResponse } from "@/lib/analytics-export";
import {
  useGetStorePaymentMethods,
  getGetStorePaymentMethodsQueryKey,
  type GetStorePaymentMethodsParams,
} from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";

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

/** Human-friendly method label: "stripe" -> "Stripe", "payment_link" -> "Payment link". */
function prettyMethod(method: string): string {
  const cleaned = method.replace(/[_-]+/g, " ").trim();
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function EmptyChart({ message }: { message: string }) {
  return (
    <div className="flex h-[240px] items-center justify-center text-center text-sm text-muted-foreground">
      {message}
    </div>
  );
}

export function StorePaymentMethodsSection({
  apiParams,
}: {
  apiParams: GetStorePaymentMethodsParams;
}) {
  const { t } = useTranslation();
  const params = useMemo<GetStorePaymentMethodsParams>(
    () => ({
      from: apiParams.from,
      to: apiParams.to,
      country: apiParams.country,
      city: apiParams.city,
      brand: apiParams.brand,
      channel: apiParams.channel,
    }),
    [
      apiParams.from,
      apiParams.to,
      apiParams.country,
      apiParams.city,
      apiParams.brand,
      apiParams.channel,
    ],
  );
  const { data, isLoading, isError } = useGetStorePaymentMethods(params, {
    query: {
      queryKey: getGetStorePaymentMethodsQueryKey(params),
      placeholderData: (prev) => prev,
    },
  });

  const noData = t("storeAnalytics.noData");

  // Methods ordered by revenue; limit the trend chart to the top 6 series.
  const methods = data?.methods ?? [];
  const trendMethods = useMemo(
    () => methods.slice(0, 6).map((m) => m.method),
    [methods],
  );

  // Pivot flat (date, method, revenue) cells into one row per date.
  const trendRows = useMemo(() => {
    if (!data) return [];
    const byDate = new Map<string, Record<string, number | string>>();
    for (const cell of data.revenueOverTime) {
      if (!trendMethods.includes(cell.method)) continue;
      const row = byDate.get(cell.date) ?? { date: cell.date };
      row[cell.method] = cell.revenue;
      byDate.set(cell.date, row);
    }
    // Fill missing methods with 0 so stacked areas don't break.
    const rows = Array.from(byDate.values());
    for (const row of rows) {
      for (const m of trendMethods) {
        if (row[m] == null) row[m] = 0;
      }
    }
    return rows.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  }, [data, trendMethods]);

  const trendConfig = useMemo(() => {
    const cfg: ChartConfig = {};
    trendMethods.forEach((m, i) => {
      cfg[m] = { label: prettyMethod(m), color: CHART_COLORS[i % CHART_COLORS.length] };
    });
    return cfg;
  }, [trendMethods]);

  return (
    <div className="space-y-4" data-testid="section-payment-methods">
      <div className="flex justify-end">
        <AnalyticsExportMenu
          filename="store-analytics-payment-methods"
          title="E-commerce Analytics — Payment Methods"
          filterSummary={buildFilterSummary(params)}
          getDatasets={() => datasetsFromResponse(data)}
          disabled={isLoading || !data}
        />
      </div>
      <div>
        <h2 className="text-lg font-semibold tracking-tight">
          {t("storeAnalytics.paymentMethods.title")}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t("storeAnalytics.paymentMethods.subtitle")}
        </p>
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
            <Skeleton key={i} className="h-[220px] w-full" />
          ))}
        </div>
      ) : (
        <>
          {/* Per-method KPI cards */}
          {methods.length > 0 ? (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {methods.slice(0, 8).map((m, i) => (
                <Card key={m.method} data-testid={`card-method-${m.method}`}>
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center gap-2 text-sm font-medium">
                      <span
                        className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{
                          backgroundColor: CHART_COLORS[i % CHART_COLORS.length],
                        }}
                      />
                      <span className="truncate">{prettyMethod(m.method)}</span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-1">
                    <div className="text-2xl font-semibold tabular-nums">
                      {formatUsd(m.revenue)}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {t("storeAnalytics.paymentMethods.kpiLine", {
                        orders: m.orders,
                        aov: formatUsd(m.aov),
                      })}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {t("storeAnalytics.paymentMethods.shareOfRevenue", {
                        pct: formatPct(m.sharePct),
                      })}
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <Card>
              <CardContent>
                <EmptyChart message={noData} />
              </CardContent>
            </Card>
          )}

          {/* Revenue over time by method (stacked areas) */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {t("storeAnalytics.paymentMethods.revenueOverTime")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {trendRows.length > 0 ? (
                <ChartContainer
                  config={trendConfig}
                  className="h-[280px] w-full"
                  data-testid="chart-payment-methods-trend"
                >
                  <AreaChart data={trendRows} margin={{ left: 8, right: 8 }}>
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
                    <ChartLegend content={<ChartLegendContent />} />
                    {trendMethods.map((m, i) => (
                      <Area
                        key={m}
                        type="monotone"
                        dataKey={m}
                        stackId="1"
                        stroke={CHART_COLORS[i % CHART_COLORS.length]}
                        fill={CHART_COLORS[i % CHART_COLORS.length]}
                        fillOpacity={0.25}
                        strokeWidth={2}
                      />
                    ))}
                  </AreaChart>
                </ChartContainer>
              ) : (
                <EmptyChart message={noData} />
              )}
            </CardContent>
          </Card>

          {/* Breakdown table */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                {t("storeAnalytics.paymentMethods.breakdown")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {methods.length > 0 ? (
                <div className="overflow-x-auto" data-testid="table-payment-methods">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-xs font-medium text-muted-foreground">
                        <th className="px-2 py-2 text-start">
                          {t("storeAnalytics.paymentMethods.colMethod")}
                        </th>
                        <th className="px-2 py-2 text-end">
                          {t("storeAnalytics.paymentMethods.colRevenue")}
                        </th>
                        <th className="px-2 py-2 text-end">
                          {t("storeAnalytics.paymentMethods.colOrders")}
                        </th>
                        <th className="px-2 py-2 text-end">
                          {t("storeAnalytics.paymentMethods.colAov")}
                        </th>
                        <th className="px-2 py-2 text-end">
                          {t("storeAnalytics.paymentMethods.colShare")}
                        </th>
                        <th className="px-2 py-2 text-start">
                          {t("storeAnalytics.paymentMethods.colCurrencies")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {methods.map((m, i) => (
                        <tr key={m.method} className="border-b last:border-0 hover:bg-muted/50">
                          <td className="px-2 py-2">
                            <span className="flex items-center gap-2">
                              <span
                                className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                                style={{
                                  backgroundColor: CHART_COLORS[i % CHART_COLORS.length],
                                }}
                              />
                              {prettyMethod(m.method)}
                            </span>
                          </td>
                          <td className="px-2 py-2 text-end font-medium tabular-nums">
                            {formatUsd(m.revenue)}
                          </td>
                          <td className="px-2 py-2 text-end tabular-nums">{m.orders}</td>
                          <td className="px-2 py-2 text-end tabular-nums">
                            {formatUsd(m.aov)}
                          </td>
                          <td className="px-2 py-2 text-end tabular-nums">
                            {formatPct(m.sharePct)}
                          </td>
                          <td className="px-2 py-2 text-muted-foreground">
                            {m.currencies
                              .map(
                                (c) =>
                                  `${c.currency} ${formatUsd(c.revenue)} (${c.orders})`,
                              )
                              .join(" · ")}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <EmptyChart message={noData} />
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
