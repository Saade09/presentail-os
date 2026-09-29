import { useTranslation } from "react-i18next";
import { AnalyticsExportMenu } from "@/components/AnalyticsExportMenu";
import { buildFilterSummary, datasetsFromResponse } from "@/lib/analytics-export";
import {
  useGetStoreProductPerformance,
  getGetStoreProductPerformanceQueryKey,
  type GetStoreProductPerformanceParams,
  type StoreProductStat,
} from "@workspace/api-client-react";
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
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  XAxis,
  YAxis,
} from "recharts";
import { Eye, Image as ImageIcon, MousePointerClick, Percent } from "lucide-react";
import { imageUrl } from "@/lib/imageUrl";

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

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex h-[220px] items-center justify-center text-center text-sm text-muted-foreground">
      {message}
    </div>
  );
}

function ProductTable({
  rows,
  emptyMessage,
  naLabel,
}: {
  rows: StoreProductStat[];
  emptyMessage: string;
  naLabel: string;
}) {
  const { t } = useTranslation();
  if (rows.length === 0) return <EmptyState message={emptyMessage} />;
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("storeAnalytics.product.colProduct")}</TableHead>
            <TableHead className="text-right">
              {t("storeAnalytics.product.colRevenue")}
            </TableHead>
            <TableHead className="text-right">
              {t("storeAnalytics.product.colQuantity")}
            </TableHead>
            <TableHead className="text-right">
              {t("storeAnalytics.product.colMargin")}
            </TableHead>
            <TableHead className="text-right">
              {t("storeAnalytics.product.colRefundRate")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((p) => {
            const resolvedImageUrl = imageUrl(p.mainImageUrl);
            return (
            <TableRow key={p.id} data-testid={`row-product-${p.id}`}>
              <TableCell className="max-w-[220px] font-medium">
                <div className="flex items-center gap-2">
                  {resolvedImageUrl ? (
                    <img
                      src={resolvedImageUrl}
                      alt=""
                      loading="lazy"
                      className="h-8 w-8 shrink-0 rounded-md object-cover bg-muted"
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).style.display =
                          "none";
                        e.currentTarget.nextElementSibling?.classList.remove(
                          "hidden",
                        );
                      }}
                    />
                  ) : null}
                  <div
                    className={`h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground ${
                      resolvedImageUrl ? "hidden" : "flex"
                    }`}
                  >
                    <ImageIcon className="h-4 w-4" />
                  </div>
                  <span className="truncate">{p.name}</span>
                </div>
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatUsd(p.revenue)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {Math.round(p.quantity)}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {p.marginPct != null ? (
                  <span title={p.marginUsd != null ? formatUsd(p.marginUsd) : undefined}>
                    {formatPct(p.marginPct)}
                  </span>
                ) : (
                  <span className="text-muted-foreground">{naLabel}</span>
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {formatPct(p.refundRate)}
              </TableCell>
            </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function TrackingCard({
  icon,
  label,
  value,
  hint,
  testId,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | null;
  hint: string;
  testId: string;
}) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">{label}</span>
          <span className="text-muted-foreground">{icon}</span>
        </div>
        <div
          className={`mt-2 text-2xl font-semibold tracking-tight ${
            value == null ? "text-muted-foreground" : ""
          }`}
          data-testid={testId}
        >
          {value ?? t("storeAnalytics.notAvailable")}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">{hint}</div>
      </CardContent>
    </Card>
  );
}

type CityRow = {
  name: string;
  orders: number;
  revenue: number;
  marginUsd?: number | null;
};

export function ByCityCard({ rows }: { rows: CityRow[] }) {
  const { t } = useTranslation();
  const top = rows.slice(0, 8);
  const totalOrders = top.reduce((sum, c) => sum + c.orders, 0);
  const maxOrders = top.reduce((max, c) => Math.max(max, c.orders), 0);
  const hasMargin = top.some((c) => c.marginUsd != null);

  const cityConfig = {
    orders: {
      label: t("storeAnalytics.product.colOrders"),
      color: "hsl(190, 90%, 32%)",
    },
  } satisfies ChartConfig;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          {t("storeAnalytics.product.byCity")}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {top.length > 0 ? (
          <>
            <ChartContainer
              config={cityConfig}
              className="w-full"
              style={{ height: Math.max(160, top.length * 34) }}
            >
              <BarChart
                data={top}
                layout="vertical"
                margin={{ left: 4, right: 36 }}
              >
                <CartesianGrid horizontal={false} strokeDasharray="3 3" />
                <XAxis type="number" hide />
                <YAxis
                  type="category"
                  dataKey="name"
                  tickLine={false}
                  axisLine={false}
                  fontSize={12}
                  width={120}
                  interval={0}
                />
                <ChartTooltip content={<ChartTooltipContent />} />
                <Bar dataKey="orders" radius={4} barSize={18}>
                  {top.map((c, i) => (
                    <Cell
                      key={i}
                      fill={
                        c.orders === maxOrders
                          ? "hsl(190, 90%, 32%)"
                          : "hsl(190, 60%, 62%)"
                      }
                    />
                  ))}
                  <LabelList
                    dataKey="orders"
                    position="right"
                    fontSize={11}
                    className="fill-muted-foreground"
                  />
                </Bar>
              </BarChart>
            </ChartContainer>
            <div className="mt-3 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("storeAnalytics.product.colCity")}</TableHead>
                    <TableHead className="text-right">
                      {t("storeAnalytics.product.colOrders")}
                    </TableHead>
                    <TableHead className="w-[120px]">
                      {t("storeAnalytics.product.colShare")}
                    </TableHead>
                    <TableHead className="text-right">
                      {t("storeAnalytics.product.colRevenue")}
                    </TableHead>
                    {hasMargin && (
                      <TableHead className="text-right">
                        {t("storeAnalytics.product.colMargin")}
                      </TableHead>
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {top.map((c, i) => {
                    const sharePct =
                      totalOrders > 0 ? (c.orders / totalOrders) * 100 : 0;
                    return (
                      <TableRow key={c.name} data-testid={`row-city-product-${i}`}>
                        <TableCell className="max-w-[160px] truncate font-medium">
                          {c.name}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {c.orders}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <div className="h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-muted">
                              <div
                                className="h-full rounded-full"
                                style={{
                                  width: `${Math.min(100, sharePct)}%`,
                                  backgroundColor: "hsl(190, 90%, 32%)",
                                }}
                              />
                            </div>
                            <span className="tabular-nums text-xs text-muted-foreground">
                              {formatPct(sharePct)}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatUsd(c.revenue)}
                        </TableCell>
                        {hasMargin && (
                          <TableCell className="text-right tabular-nums">
                            {c.marginUsd != null ? (
                              formatUsd(c.marginUsd)
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                        )}
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
            {!hasMargin && (
              <p
                className="mt-3 text-xs text-muted-foreground"
                data-testid="text-city-margin-hint"
              >
                {t("storeAnalytics.product.marginNeedsCogsHint")}
              </p>
            )}
            <p className="mt-3 text-xs text-muted-foreground">
              {t("storeAnalytics.product.cityViewsHint")}
            </p>
          </>
        ) : (
          <EmptyState message={t("storeAnalytics.noData")} />
        )}
      </CardContent>
    </Card>
  );
}

export default function StoreProductAnalytics({
  params,
}: {
  params: GetStoreProductPerformanceParams;
}) {
  const { t } = useTranslation();
  const { data, isLoading, isError } = useGetStoreProductPerformance(params, {
    query: {
      queryKey: getGetStoreProductPerformanceQueryKey(params),
      placeholderData: (prev) => prev,
    },
  });

  const naLabel = t("storeAnalytics.notAvailable");

  const categoryTotal =
    data?.categoryMix.reduce((sum, c) => sum + c.revenue, 0) ?? 0;

  const categoryConfig = {
    revenue: { label: t("storeAnalytics.revenue"), color: CHART_COLORS[0] },
  } satisfies ChartConfig;

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <AnalyticsExportMenu
          filename="store-analytics-products"
          title="E-commerce Analytics — Products"
          filterSummary={buildFilterSummary(params)}
          getDatasets={() => datasetsFromResponse(data)}
          disabled={isLoading || !data}
        />
      </div>
      {isError && (
        <Card>
          <CardContent className="p-6 text-center text-sm text-red-500">
            {t("storeAnalytics.loadError")}
          </CardContent>
        </Card>
      )}

      {/* Tracking-dependent metrics (from storefront web events) */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <TrackingCard
          icon={<Eye size={16} />}
          label={t("storeAnalytics.product.viewCount")}
          value={
            data?.tracking.views
              ? new Intl.NumberFormat().format(data.events.views)
              : null
          }
          hint={
            data?.tracking.views
              ? t("storeAnalytics.product.viewsTrackedHint")
              : t("storeAnalytics.needsTracking")
          }
          testId="tracking-card-views"
        />
        <TrackingCard
          icon={<MousePointerClick size={16} />}
          label={t("storeAnalytics.product.addToCartRate")}
          value={
            data?.tracking.addToCart && data.events.addToCartRate != null
              ? formatPct(data.events.addToCartRate)
              : null
          }
          hint={
            data?.tracking.addToCart && data.events.addToCartRate != null
              ? t("storeAnalytics.product.addToCartTrackedHint", {
                  carts: new Intl.NumberFormat().format(data.events.addToCarts),
                  views: new Intl.NumberFormat().format(data.events.views),
                })
              : t("storeAnalytics.needsTracking")
          }
          testId="tracking-card-add-to-cart"
        />
        <TrackingCard
          icon={<Percent size={16} />}
          label={t("storeAnalytics.product.conversionRate")}
          value={
            data?.tracking.conversionRate && data.events.conversionRate != null
              ? formatPct(data.events.conversionRate)
              : null
          }
          hint={
            data?.tracking.conversionRate && data.events.conversionRate != null
              ? t("storeAnalytics.product.conversionTrackedHint", {
                  purchases: new Intl.NumberFormat().format(
                    data.events.purchases,
                  ),
                  views: new Intl.NumberFormat().format(data.events.views),
                })
              : t("storeAnalytics.needsTracking")
          }
          testId="tracking-card-conversion"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Best sellers */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t("storeAnalytics.product.bestSellers")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading && !data ? (
              <Skeleton className="h-[220px] w-full" />
            ) : (
              <ProductTable
                rows={data?.topProducts ?? []}
                emptyMessage={t("storeAnalytics.product.noProducts")}
                naLabel={naLabel}
              />
            )}
          </CardContent>
        </Card>

        {/* Worst sellers */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t("storeAnalytics.product.worstSellers")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {isLoading && !data ? (
              <Skeleton className="h-[220px] w-full" />
            ) : (
              <ProductTable
                rows={data?.bottomProducts ?? []}
                emptyMessage={t("storeAnalytics.product.noProducts")}
                naLabel={naLabel}
              />
            )}
          </CardContent>
        </Card>

        {/* Product mix by category */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t("storeAnalytics.product.categoryMix")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data && data.categoryMix.length > 0 ? (
              <div className="space-y-1">
                <div className="flex items-center justify-between px-1 pb-2 text-xs font-medium text-muted-foreground">
                  <span>{t("storeAnalytics.product.colProduct")}</span>
                  <div className="flex gap-6">
                    <span className="w-24 text-right">
                      {t("storeAnalytics.revenue")}
                    </span>
                    <span className="w-16 text-right">
                      {t("storeAnalytics.product.colShare")}
                    </span>
                  </div>
                </div>
                {data.categoryMix.map((c, i) => (
                  <div
                    key={c.name}
                    className="flex items-center justify-between rounded-md px-1 py-1.5 text-sm hover:bg-muted/50"
                    data-testid={`row-category-${i}`}
                  >
                    <span className="flex items-center gap-2 truncate">
                      <span
                        className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }}
                      />
                      <span className="truncate">{c.name}</span>
                    </span>
                    <div className="flex gap-6">
                      <span className="w-24 text-right font-medium tabular-nums">
                        {formatUsd(c.revenue)}
                      </span>
                      <span className="w-16 text-right tabular-nums text-muted-foreground">
                        {categoryTotal > 0
                          ? formatPct((c.revenue / categoryTotal) * 100)
                          : "—"}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState message={t("storeAnalytics.noData")} />
            )}
          </CardContent>
        </Card>

        {/* Product performance by city (orders + margin) */}
        <ByCityCard rows={data?.byCity ?? []} />
      </div>
    </div>
  );
}
