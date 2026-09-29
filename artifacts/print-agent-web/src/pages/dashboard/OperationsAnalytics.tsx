import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "wouter";
import {
  useGetStoreOperations,
  getGetStoreOperationsQueryKey,
  type StorePunctualityOrder,
} from "@workspace/api-client-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
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
  ListChecks,
  Clock,
  UserX,
  Flower2,
  Truck,
  Pencil,
  BadgePercent,
  Headset,
  Store,
  Wallet,
  Receipt,
  Banknote,
  CreditCard,
  Scale,
  Users,
  CheckCircle2,
  AlertTriangle,
  Zap,
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
    maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2,
  }).format(n);
}

function KpiCard({
  icon,
  label,
  value,
  hint,
  onClick,
  testId,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
  onClick?: () => void;
  testId?: string;
}) {
  const body = (
    <CardContent className="p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">{label}</span>
        <span className="text-muted-foreground">{icon}</span>
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight">{value}</div>
      {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
    </CardContent>
  );
  if (onClick) {
    return (
      <Card
        role="button"
        tabIndex={0}
        data-testid={testId}
        className="cursor-pointer transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
        onClick={onClick}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onClick();
          }
        }}
      >
        {body}
      </Card>
    );
  }
  return <Card data-testid={testId}>{body}</Card>;
}

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(d);
}

function PunctualityDialog({
  mode,
  onClose,
  orders,
}: {
  mode: "on_time" | "late" | null;
  onClose: () => void;
  orders: StorePunctualityOrder[];
}) {
  const { t } = useTranslation();
  const rows = orders.filter((o) => o.status === mode);
  return (
    <Dialog open={mode !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="flex max-h-[85vh] max-w-3xl flex-col overflow-hidden"
        style={{ gridTemplateRows: "auto minmax(0, 1fr)" }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {mode === "late" ? (
              <AlertTriangle size={18} className="text-red-500" />
            ) : (
              <CheckCircle2 size={18} className="text-emerald-600" />
            )}
            {mode === "late"
              ? t("operations.punctuality.lateDialogTitle")
              : t("operations.punctuality.onTimeDialogTitle")}
          </DialogTitle>
          <DialogDescription>
            {t("operations.punctuality.dialogDescription")}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 overflow-y-auto">
          {rows.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              {t("operations.noData")}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-background text-xs text-muted-foreground">
                <tr className="border-b">
                  <th className="px-2 py-2 text-start font-medium">
                    {t("operations.punctuality.colOrder")}
                  </th>
                  <th className="px-2 py-2 text-start font-medium">
                    {t("operations.punctuality.colPlaced")}
                  </th>
                  <th className="px-2 py-2 text-start font-medium">
                    {t("operations.punctuality.colDeadline")}
                  </th>
                  <th className="px-2 py-2 text-start font-medium">
                    {t("operations.punctuality.colCompleted")}
                  </th>
                  <th className="px-2 py-2 text-end font-medium">
                    {mode === "late"
                      ? t("operations.punctuality.colMinutesLate")
                      : t("operations.punctuality.colMinutesEarly")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((o, i) => (
                  <tr
                    key={o.id}
                    className="border-b last:border-0 hover:bg-muted/50"
                    data-testid={`row-punctuality-${i}`}
                  >
                    <td className="px-2 py-2">
                      <Link
                        href={`/orders/${o.id}`}
                        className="flex items-center gap-1.5 font-medium text-primary hover:underline"
                      >
                        {o.displayOrderNumber ?? o.id.slice(0, 8)}
                        {o.isExpress && (
                          <Badge variant="secondary" className="gap-1 px-1.5 py-0 text-[10px]">
                            <Zap size={10} />
                            {t("operations.punctuality.express")}
                          </Badge>
                        )}
                      </Link>
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap text-muted-foreground">
                      {formatDateTime(o.placedAt)}
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap text-muted-foreground">
                      {formatDateTime(o.deadline)}
                    </td>
                    <td className="px-2 py-2 whitespace-nowrap text-muted-foreground">
                      {formatDateTime(o.completedAt)}
                    </td>
                    <td
                      className={`px-2 py-2 text-end font-medium tabular-nums ${
                        o.status === "late" ? "text-red-600" : "text-emerald-600"
                      }`}
                    >
                      {Math.abs(o.minutesLate)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function EmptyChart({ message }: { message: string }) {
  return (
    <div className="flex h-[240px] items-center justify-center text-center text-sm text-muted-foreground">
      {message}
    </div>
  );
}

export default function OperationsAnalyticsPage() {
  const { t } = useTranslation();
  const [punctualityMode, setPunctualityMode] = useState<"on_time" | "late" | null>(
    null,
  );
  const filters = useStoreAnalyticsFilters();
  const { data, isLoading, isError } = useGetStoreOperations(filters.apiParams, {
    query: {
      queryKey: getGetStoreOperationsQueryKey(filters.apiParams),
      placeholderData: (prev) => prev,
    },
  });

  const barConfig = {
    count: { label: t("operations.count"), color: CHART_COLORS[0] },
  } satisfies ChartConfig;

  const statusData = (data?.ordersByStatus ?? []).map((r) => ({
    name: r.status,
    count: r.count,
  }));
  const sourceData = (data?.ordersBySource ?? []).map((r) => ({
    name: r.source,
    count: r.count,
  }));
  const channelData = (data?.ordersByChannel ?? []).map((r) => ({
    name: r.channel,
    count: r.count,
  }));

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {t("operations.title")}
        </h1>
        <p className="text-sm text-muted-foreground">{t("operations.subtitle")}</p>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <StoreAnalyticsFilterBar filters={filters} />
        </div>
        <AnalyticsExportMenu
          filename="operations-analytics"
          title="Operations Analytics"
          filterSummary={buildFilterSummary(filters.apiParams)}
          getDatasets={() => datasetsFromResponse(data)}
          disabled={isLoading || !data}
        />
      </div>

      {isError && (
        <Card>
          <CardContent className="p-6 text-center text-sm text-red-500">
            {t("operations.loadError")}
          </CardContent>
        </Card>
      )}

      {/* Order pipeline KPIs (order-derived, honor the full filter bar) */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {isLoading && !data ? (
          Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-[104px] w-full" />
          ))
        ) : (
          <>
            <KpiCard
              icon={<ListChecks size={16} />}
              label={t("operations.kpi.totalOrders")}
              value={String(data?.summary.totalOrders ?? 0)}
            />
            <KpiCard
              icon={<Clock size={16} />}
              label={t("operations.kpi.pendingOrders")}
              value={String(data?.summary.pendingOrders ?? 0)}
            />
            <KpiCard
              icon={<UserX size={16} />}
              label={t("operations.kpi.unassignedOrders")}
              value={String(data?.summary.unassignedOrders ?? 0)}
            />
            <KpiCard
              icon={<Flower2 size={16} />}
              label={t("operations.kpi.withoutFlorist")}
              value={String(data?.summary.ordersWithoutFlorist ?? 0)}
            />
            <KpiCard
              icon={<Truck size={16} />}
              label={t("operations.kpi.withoutDriver")}
              value={String(data?.summary.ordersWithoutDriver ?? 0)}
            />
            <KpiCard
              icon={<Pencil size={16} />}
              label={t("operations.kpi.editedAfterCreation")}
              value={String(data?.summary.ordersEditedAfterCreation ?? 0)}
            />
            <KpiCard
              icon={<BadgePercent size={16} />}
              label={t("operations.kpi.manualDiscounts")}
              value={String(data?.summary.manualDiscountOrders ?? 0)}
              hint={`${formatUsd(data?.summary.manualDiscountTotalUsd ?? 0)} ${t("operations.kpi.discount")}`}
            />
            <KpiCard
              icon={<Headset size={16} />}
              label={t("operations.kpi.customerServiceOrders")}
              value={String(data?.summary.customerServiceOrders ?? 0)}
              hint={`${data?.summary.posOrders ?? 0} ${t("operations.kpi.posOrders")}`}
            />
            <KpiCard
              icon={<CheckCircle2 size={16} />}
              label={t("operations.kpi.onTimeOrders")}
              value={String(data?.summary.onTimeOrders ?? 0)}
              hint={t("operations.kpi.onTimeHint")}
              onClick={() => setPunctualityMode("on_time")}
              testId="card-on-time-orders"
            />
            <KpiCard
              icon={<AlertTriangle size={16} />}
              label={t("operations.kpi.lateOrders")}
              value={String(data?.summary.lateOrders ?? 0)}
              hint={t("operations.kpi.lateHint")}
              onClick={() => setPunctualityMode("late")}
              testId="card-late-orders"
            />
          </>
        )}
      </div>

      <PunctualityDialog
        mode={punctualityMode}
        onClose={() => setPunctualityMode(null)}
        orders={data?.punctualityOrders ?? []}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Orders by status */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ListChecks size={16} />
              {t("operations.chart.ordersByStatus")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {statusData.length > 0 ? (
              <ChartContainer config={barConfig} className="h-[260px] w-full">
                <BarChart data={statusData} margin={{ left: 8, right: 8 }}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis dataKey="name" tickLine={false} axisLine={false} fontSize={11} />
                  <YAxis tickLine={false} axisLine={false} fontSize={11} width={40} allowDecimals={false} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="count" radius={4}>
                    {statusData.map((_, i) => (
                      <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ChartContainer>
            ) : (
              <EmptyChart message={t("operations.noData")} />
            )}
          </CardContent>
        </Card>

        {/* Orders by source */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Headset size={16} />
              {t("operations.chart.ordersBySource")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {sourceData.length > 0 ? (
              <ChartContainer config={barConfig} className="h-[260px] w-full">
                <BarChart data={sourceData} margin={{ left: 8, right: 8 }}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis dataKey="name" tickLine={false} axisLine={false} fontSize={11} />
                  <YAxis tickLine={false} axisLine={false} fontSize={11} width={40} allowDecimals={false} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="count" radius={4}>
                    {sourceData.map((_, i) => (
                      <Cell key={i} fill={CHART_COLORS[(i + 2) % CHART_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ChartContainer>
            ) : (
              <EmptyChart message={t("operations.noData")} />
            )}
          </CardContent>
        </Card>

        {/* Orders by channel */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Store size={16} />
              {t("operations.chart.ordersByChannel")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {channelData.length > 0 ? (
              <ChartContainer config={barConfig} className="h-[260px] w-full">
                <BarChart data={channelData} margin={{ left: 8, right: 8 }}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis dataKey="name" tickLine={false} axisLine={false} fontSize={11} />
                  <YAxis tickLine={false} axisLine={false} fontSize={11} width={40} allowDecimals={false} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="count" radius={4}>
                    {channelData.map((_, i) => (
                      <Cell key={i} fill={CHART_COLORS[(i + 4) % CHART_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ChartContainer>
            ) : (
              <EmptyChart message={t("operations.noData")} />
            )}
          </CardContent>
        </Card>

        {/* Orders by shop / location */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Store size={16} />
              {t("operations.chart.ordersByLocation")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data && data.ordersByLocation.length > 0 ? (
              <div className="space-y-1">
                <div className="flex items-center justify-between px-1 pb-2 text-xs font-medium text-muted-foreground">
                  <span>{t("operations.shop")}</span>
                  <div className="flex gap-6">
                    <span className="w-16 text-right">{t("operations.orders")}</span>
                    <span className="w-24 text-right">{t("operations.revenue")}</span>
                  </div>
                </div>
                {data.ordersByLocation.map((r, i) => (
                  <div
                    key={`${r.name}-${i}`}
                    className="flex items-center justify-between rounded-md px-1 py-1.5 text-sm hover:bg-muted/50"
                    data-testid={`row-location-${i}`}
                  >
                    <span className="truncate">{r.name}</span>
                    <div className="flex gap-6">
                      <span className="w-16 text-right tabular-nums text-muted-foreground">
                        {r.orders}
                      </span>
                      <span className="w-24 text-right font-medium tabular-nums">
                        {formatUsd(r.revenueUsd)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyChart message={t("operations.noData")} />
            )}
          </CardContent>
        </Card>
      </div>

      {/* Cash & offline section */}
      <div>
        <h2 className="text-lg font-semibold tracking-tight">
          {t("operations.cashTitle")}
        </h2>
        <p className="text-sm text-muted-foreground">{t("operations.cashSubtitle")}</p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {isLoading && !data ? (
          Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-[104px] w-full" />
          ))
        ) : (
          <>
            <KpiCard
              icon={<Store size={16} />}
              label={t("operations.kpi.walkInSales")}
              value={formatUsd(data?.cash.walkInSalesUsd ?? 0)}
              hint={`${data?.cash.walkInOrders ?? 0} ${t("operations.orders")}`}
            />
            <KpiCard
              icon={<Banknote size={16} />}
              label={t("operations.kpi.cashSales")}
              value={formatUsd(data?.cash.cashSalesUsd ?? 0)}
            />
            <KpiCard
              icon={<CreditCard size={16} />}
              label={t("operations.kpi.customPriceOrders")}
              value={String(data?.cash.customPriceOrders ?? 0)}
              hint={`${formatUsd(data?.cash.customPriceDiscountUsd ?? 0)} ${t("operations.kpi.discount")}`}
            />
            <KpiCard
              icon={<Receipt size={16} />}
              label={t("operations.kpi.cashExpenses")}
              value={formatUsd(data?.cash.cashExpensesUsd ?? 0)}
            />
            <KpiCard
              icon={<Wallet size={16} />}
              label={t("operations.kpi.cashOpen")}
              value={formatUsd(data?.cash.cashOpenTotalUsd ?? 0)}
              hint={`${data?.cash.sessions ?? 0} ${t("operations.kpi.sessions")}`}
            />
            <KpiCard
              icon={<Wallet size={16} />}
              label={t("operations.kpi.cashClose")}
              value={formatUsd(data?.cash.cashCloseTotalUsd ?? 0)}
              hint={`${data?.cash.closedSessions ?? 0} ${t("operations.kpi.closed")}`}
            />
            <KpiCard
              icon={<Scale size={16} />}
              label={t("operations.kpi.cashVariance")}
              value={formatUsd(data?.cash.cashVarianceUsd ?? 0)}
            />
            <KpiCard
              icon={<Clock size={16} />}
              label={t("operations.kpi.openSessions")}
              value={String(data?.cash.openSessions ?? 0)}
            />
          </>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Sales by payment method */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <CreditCard size={16} />
              {t("operations.chart.paymentsByMethod")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data && data.paymentsByMethod.length > 0 ? (
              <div className="space-y-1">
                {data.paymentsByMethod.map((r, i) => (
                  <div
                    key={r.method}
                    className="flex items-center justify-between rounded-md px-1 py-1.5 text-sm hover:bg-muted/50"
                    data-testid={`row-method-${i}`}
                  >
                    <span className="flex items-center gap-2 truncate capitalize">
                      <span
                        className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: CHART_COLORS[i % CHART_COLORS.length] }}
                      />
                      {r.method}
                    </span>
                    <div className="flex gap-6">
                      <span className="w-16 text-right tabular-nums text-muted-foreground">
                        {r.count}
                      </span>
                      <span className="w-24 text-right font-medium tabular-nums">
                        {formatUsd(r.amountUsd)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyChart message={t("operations.noData")} />
            )}
          </CardContent>
        </Card>

        {/* Sales by agent */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Users size={16} />
              {t("operations.chart.salesByAgent")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data && data.salesByAgent.length > 0 ? (
              <div className="space-y-1">
                {data.salesByAgent.map((r, i) => (
                  <div
                    key={`${r.agent}-${i}`}
                    className="flex items-center justify-between rounded-md px-1 py-1.5 text-sm hover:bg-muted/50"
                    data-testid={`row-agent-${i}`}
                  >
                    <span className="truncate">{r.agent}</span>
                    <div className="flex gap-6">
                      <span className="w-16 text-right tabular-nums text-muted-foreground">
                        {r.count}
                      </span>
                      <span className="w-24 text-right font-medium tabular-nums">
                        {formatUsd(r.salesUsd)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyChart message={t("operations.noData")} />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
