import { useTranslation } from "react-i18next";
import {
  useGetStoreCartCheckout,
  getGetStoreCartCheckoutQueryKey,
} from "@workspace/api-client-react";
import { useStoreAnalyticsFilters } from "@/hooks/use-store-analytics-filters";
import { StoreAnalyticsFilterBar } from "@/components/StoreAnalyticsFilterBar";
import { AnalyticsExportMenu } from "@/components/AnalyticsExportMenu";
import { buildFilterSummary, datasetsFromResponse } from "@/lib/analytics-export";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from "recharts";
import {
  ShoppingCart,
  PackageX,
  Wallet,
  Truck,
  Ticket,
  CreditCard,
  AlertTriangle,
  Info,
  Gift,
} from "lucide-react";

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

function KpiCard({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
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
        {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
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

/** Banner shown when a website-event section has no tracking data yet. */
function WaitingForEvents({ message }: { message: string }) {
  return (
    <div className="flex h-[240px] flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
      <Info size={22} className="opacity-60" />
      <span className="max-w-xs">{message}</span>
    </div>
  );
}

export default function CartCheckoutAnalyticsPage() {
  const { t } = useTranslation();
  const filters = useStoreAnalyticsFilters();
  const { data, isLoading, isError } = useGetStoreCartCheckout(filters.apiParams, {
    query: {
      queryKey: getGetStoreCartCheckoutQueryKey(filters.apiParams),
      placeholderData: (prev) => prev,
    },
  });

  const eventsTracked = data?.eventsTracked ?? false;
  const barConfig = {
    value: { label: t("cartCheckout.value"), color: CHART_COLORS[0] },
  } satisfies ChartConfig;

  const funnelData = data
    ? [
        { name: t("cartCheckout.funnel.productViews"), value: data.funnel.productViews },
        { name: t("cartCheckout.funnel.addedToCart"), value: data.funnel.addedToCart },
        { name: t("cartCheckout.funnel.reachedCheckout"), value: data.funnel.reachedCheckout },
        { name: t("cartCheckout.funnel.paymentCompleted"), value: data.funnel.paymentCompleted },
      ]
    : [];

  const waitingMsg = t("cartCheckout.waitingForEvents");

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {t("cartCheckout.title")}
        </h1>
        <p className="text-sm text-muted-foreground">{t("cartCheckout.subtitle")}</p>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <StoreAnalyticsFilterBar filters={filters} />
        </div>
        <AnalyticsExportMenu
          filename="cart-checkout-analytics"
          title="Cart & Checkout Analytics"
          filterSummary={buildFilterSummary(filters.apiParams)}
          getDatasets={() => datasetsFromResponse(data)}
          disabled={isLoading || !data}
        />
      </div>

      {isError && (
        <Card>
          <CardContent className="p-6 text-center text-sm text-red-500">
            {t("cartCheckout.loadError")}
          </CardContent>
        </Card>
      )}

      {/* KPI cards — behavioural (need events) + order/payment (always) */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {isLoading && !data ? (
          Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-[104px] w-full" />
          ))
        ) : (
          <>
            <KpiCard
              icon={<PackageX size={16} />}
              label={t("cartCheckout.kpi.cartAbandonment")}
              value={
                eventsTracked
                  ? formatPct(data?.rates.cartAbandonmentRate ?? 0)
                  : t("cartCheckout.notAvailable")
              }
              hint={eventsTracked ? undefined : t("cartCheckout.needsTracking")}
            />
            <KpiCard
              icon={<ShoppingCart size={16} />}
              label={t("cartCheckout.kpi.checkoutAbandonment")}
              value={
                eventsTracked
                  ? formatPct(data?.rates.checkoutAbandonmentRate ?? 0)
                  : t("cartCheckout.notAvailable")
              }
              hint={eventsTracked ? undefined : t("cartCheckout.needsTracking")}
            />
            <KpiCard
              icon={<Wallet size={16} />}
              label={t("cartCheckout.kpi.avgCartValue")}
              value={
                eventsTracked
                  ? formatUsd(data?.rates.averageCartValueUsd ?? 0)
                  : t("cartCheckout.notAvailable")
              }
              hint={eventsTracked ? undefined : t("cartCheckout.needsTracking")}
            />
            <KpiCard
              icon={<AlertTriangle size={16} />}
              label={t("cartCheckout.kpi.paymentFailureRate")}
              value={formatPct(data?.paymentFailureRate ?? 0)}
              hint={formatUsd(data?.revenueLostToPaymentFailureUsd ?? 0) + " " + t("cartCheckout.kpi.lost")}
            />
            <KpiCard
              icon={<Truck size={16} />}
              label={t("cartCheckout.kpi.freeDeliveryShare")}
              value={formatPct(data?.deliveryFee.freeDeliveryShare ?? 0)}
              hint={`${data?.deliveryFee.freeDeliveryOrders ?? 0} / ${data?.deliveryFee.validOrders ?? 0}`}
            />
            <KpiCard
              icon={<Truck size={16} />}
              label={t("cartCheckout.kpi.avgDeliveryFee")}
              value={formatUsd(data?.deliveryFee.avgDeliveryFeeUsd ?? 0)}
              hint={`${data?.deliveryFee.paidDeliveryOrders ?? 0} ${t("cartCheckout.kpi.paidDeliveryOrders")}`}
            />
            <KpiCard
              icon={<Ticket size={16} />}
              label={t("cartCheckout.kpi.promoRedeemed")}
              value={String(data?.promoUsage.redeemedOrders ?? 0)}
              hint={`${formatUsd(data?.promoUsage.discountUsd ?? 0)} ${t("cartCheckout.kpi.discount")}`}
            />
            <KpiCard
              icon={<CreditCard size={16} />}
              label={t("cartCheckout.kpi.paymentLinkOrders")}
              value={String(data?.paymentLinks.paid ?? 0)}
              hint={`${data?.paymentLinks.created ?? 0} ${t("cartCheckout.kpi.created")} · ${formatUsd(data?.paymentLinks.paidRevenueUsd ?? 0)}`}
            />
          </>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Checkout funnel (behavioural) */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShoppingCart size={16} />
              {t("cartCheckout.chart.funnel")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!data ? (
              <EmptyChart message={t("cartCheckout.noData")} />
            ) : eventsTracked ? (
              <ChartContainer config={barConfig} className="h-[260px] w-full">
                <BarChart data={funnelData} margin={{ left: 8, right: 8 }}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis dataKey="name" tickLine={false} axisLine={false} fontSize={11} />
                  <YAxis tickLine={false} axisLine={false} fontSize={11} width={48} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="value" radius={4}>
                    {funnelData.map((_, i) => (
                      <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ChartContainer>
            ) : (
              <WaitingForEvents message={waitingMsg} />
            )}
          </CardContent>
        </Card>

        {/* Payment failures by provider (order-derived) */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle size={16} />
              {t("cartCheckout.chart.failuresByProvider")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data && data.failedByProvider.length > 0 ? (
              <div className="space-y-1">
                <div className="flex items-center justify-between px-1 pb-2 text-xs font-medium text-muted-foreground">
                  <span>{t("cartCheckout.provider")}</span>
                  <div className="flex gap-6">
                    <span className="w-16 text-right">{t("cartCheckout.failed")}</span>
                    <span className="w-16 text-right">{t("cartCheckout.failRate")}</span>
                    <span className="w-24 text-right">{t("cartCheckout.lostUsd")}</span>
                  </div>
                </div>
                {data.failedByProvider.map((p, i) => (
                  <div
                    key={p.provider}
                    className="flex items-center justify-between rounded-md px-1 py-1.5 text-sm hover:bg-muted/50"
                    data-testid={`row-provider-${i}`}
                  >
                    <span className="truncate capitalize">{p.provider}</span>
                    <div className="flex gap-6">
                      <span className="w-16 text-right tabular-nums text-muted-foreground">
                        {p.failed}
                      </span>
                      <span className="w-16 text-right tabular-nums">
                        {formatPct(p.failureRate)}
                      </span>
                      <span className="w-24 text-right font-medium tabular-nums">
                        {formatUsd(p.lostRevenueUsd)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyChart message={t("cartCheckout.noPaymentFailures")} />
            )}
          </CardContent>
        </Card>

        {/* AOV by free vs paid delivery (order-derived) */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Truck size={16} />
              {t("cartCheckout.chart.aovByDelivery")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data &&
            (data.aovByFreeDelivery.freeDelivery.orders > 0 ||
              data.aovByFreeDelivery.paidDelivery.orders > 0) ? (
              <ChartContainer config={barConfig} className="h-[240px] w-full">
                <BarChart
                  data={[
                    {
                      name: t("cartCheckout.freeDelivery"),
                      value: data.aovByFreeDelivery.freeDelivery.aovUsd,
                    },
                    {
                      name: t("cartCheckout.paidDelivery"),
                      value: data.aovByFreeDelivery.paidDelivery.aovUsd,
                    },
                  ]}
                  margin={{ left: 8, right: 8 }}
                >
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis dataKey="name" tickLine={false} axisLine={false} fontSize={11} />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    fontSize={11}
                    width={48}
                    tickFormatter={(v: number) => `$${v}`}
                  />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="value" radius={4}>
                    <Cell fill={CHART_COLORS[1]} />
                    <Cell fill={CHART_COLORS[2]} />
                  </Bar>
                </BarChart>
              </ChartContainer>
            ) : (
              <EmptyChart message={t("cartCheckout.noData")} />
            )}
          </CardContent>
        </Card>

        {/* Top promo codes (order-derived) */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Ticket size={16} />
              {t("cartCheckout.chart.topPromoCodes")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data && data.promoUsage.topCodes.length > 0 ? (
              <div className="space-y-1">
                {data.promoUsage.topCodes.map((c, i) => (
                  <div
                    key={c.name}
                    className="flex items-center justify-between rounded-md px-1 py-1.5 text-sm hover:bg-muted/50"
                    data-testid={`row-promo-${i}`}
                  >
                    <span className="flex items-center gap-2 truncate">
                      <span
                        className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }}
                      />
                      <span className="truncate font-mono uppercase">{c.name}</span>
                    </span>
                    <span className="tabular-nums text-muted-foreground">{c.count}</span>
                  </div>
                ))}
                {eventsTracked && (
                  <div className="mt-2 border-t pt-2 text-xs text-muted-foreground">
                    {t("cartCheckout.promoEvents", {
                      applied: data.promoUsage.applied,
                      failed: data.promoUsage.failed,
                    })}
                  </div>
                )}
              </div>
            ) : (
              <EmptyChart message={t("cartCheckout.noData")} />
            )}
          </CardContent>
        </Card>

        {/* Free-delivery bar behaviour (behavioural) */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Gift size={16} />
              {t("cartCheckout.chart.freeDeliveryBar")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!data ? (
              <EmptyChart message={t("cartCheckout.noData")} />
            ) : eventsTracked ? (
              <div className="flex h-[240px] flex-col justify-center gap-4">
                <div>
                  <div className="text-3xl font-semibold tracking-tight">
                    {data.freeDeliveryBar.belowThresholdSessions}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {t("cartCheckout.belowThreshold")}
                    {data.freeDeliveryBar.thresholdUsd != null &&
                      ` (< ${formatUsd(data.freeDeliveryBar.thresholdUsd)})`}
                  </div>
                </div>
                <div>
                  <div className="text-3xl font-semibold tracking-tight">
                    {data.freeDeliveryBar.addedAfterBarSessions}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {t("cartCheckout.addedAfterBar")}
                  </div>
                </div>
              </div>
            ) : (
              <WaitingForEvents message={waitingMsg} />
            )}
          </CardContent>
        </Card>

        {/* Checkout drop-off by city (behavioural) */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t("cartCheckout.chart.dropoffByCity")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!data ? (
              <EmptyChart message={t("cartCheckout.noData")} />
            ) : !eventsTracked ? (
              <WaitingForEvents message={waitingMsg} />
            ) : data.checkoutDropoffByCity.length > 0 ? (
              <ChartContainer config={barConfig} className="h-[240px] w-full">
                <BarChart
                  data={data.checkoutDropoffByCity.slice(0, 8)}
                  layout="vertical"
                  margin={{ left: 8, right: 8 }}
                >
                  <CartesianGrid horizontal={false} strokeDasharray="3 3" />
                  <XAxis
                    type="number"
                    tickLine={false}
                    axisLine={false}
                    fontSize={11}
                    tickFormatter={(v: number) => `${v}%`}
                  />
                  <YAxis
                    type="category"
                    dataKey="name"
                    tickLine={false}
                    axisLine={false}
                    fontSize={11}
                    width={90}
                  />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="dropoffRate" fill={CHART_COLORS[4]} radius={4} />
                </BarChart>
              </ChartContainer>
            ) : (
              <EmptyChart message={t("cartCheckout.noData")} />
            )}
          </CardContent>
        </Card>

        {/* Checkout drop-off by delivery slot (behavioural) */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              {t("cartCheckout.chart.dropoffBySlot")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!data ? (
              <EmptyChart message={t("cartCheckout.noData")} />
            ) : !eventsTracked ? (
              <WaitingForEvents message={waitingMsg} />
            ) : data.checkoutDropoffBySlot.length > 0 ? (
              <ChartContainer config={barConfig} className="h-[240px] w-full">
                <BarChart
                  data={data.checkoutDropoffBySlot.slice(0, 8)}
                  layout="vertical"
                  margin={{ left: 8, right: 8 }}
                >
                  <CartesianGrid horizontal={false} strokeDasharray="3 3" />
                  <XAxis
                    type="number"
                    tickLine={false}
                    axisLine={false}
                    fontSize={11}
                    tickFormatter={(v: number) => `${v}%`}
                  />
                  <YAxis
                    type="category"
                    dataKey="name"
                    tickLine={false}
                    axisLine={false}
                    fontSize={11}
                    width={90}
                  />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="dropoffRate" fill={CHART_COLORS[3]} radius={4} />
                </BarChart>
              </ChartContainer>
            ) : (
              <EmptyChart message={t("cartCheckout.noData")} />
            )}
          </CardContent>
        </Card>

        {/* Delivery-fee impact on conversion (behavioural) */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Truck size={16} />
              {t("cartCheckout.chart.deliveryFeeConversion")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!data ? (
              <EmptyChart message={t("cartCheckout.noData")} />
            ) : !eventsTracked ? (
              <WaitingForEvents message={waitingMsg} />
            ) : data.conversionByDeliveryFee.length > 0 ? (
              <div className="flex h-[240px] flex-col justify-center gap-4">
                {data.conversionByDeliveryFee.map((b) => (
                  <div key={b.bucket} data-testid={`conv-${b.bucket}`}>
                    <div className="flex items-baseline justify-between">
                      <span className="text-sm text-muted-foreground">
                        {b.bucket === "free"
                          ? t("cartCheckout.freeDelivery")
                          : t("cartCheckout.paidDelivery")}
                      </span>
                      <span className="text-2xl font-semibold tracking-tight">
                        {formatPct(b.conversionRate)}
                      </span>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {b.completed} / {b.sessions} {t("cartCheckout.sessions")}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyChart message={t("cartCheckout.noData")} />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
