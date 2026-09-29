import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useGetStoreMarketplace,
  getGetStoreMarketplaceQueryKey,
  useUpdateMarketplaceCommissionRates,
  type StoreMarketplaceChannel,
  type MarketplaceCommissionRates,
} from "@workspace/api-client-react";
import { useStoreAnalyticsFilters } from "@/hooks/use-store-analytics-filters";
import { StoreAnalyticsFilterBar } from "@/components/StoreAnalyticsFilterBar";
import { AnalyticsExportMenu } from "@/components/AnalyticsExportMenu";
import { buildFilterSummary, datasetsFromResponse } from "@/lib/analytics-export";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  type ChartConfig,
} from "@/components/ui/chart";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  DollarSign,
  Store,
  Wallet,
  Percent,
  ShoppingBag,
  Scale,
  Trophy,
  Info,
  Save,
} from "lucide-react";

const CHART_COLORS = [
  "hsl(210, 100%, 45%)",
  "hsl(160, 84%, 39%)",
];

/** Canonical channel keys the commission-rate editor exposes. */
const EDITABLE_CHANNELS = [
  "website",
  "pos",
  "whatsapp",
  "toters",
  "deliveroo",
  "careem",
  "talabat",
] as const;

function formatUsd(n: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2,
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

function WaitingState({ message }: { message: string }) {
  return (
    <div className="flex h-[240px] flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
      <Info size={22} className="opacity-60" />
      <span className="max-w-xs">{message}</span>
    </div>
  );
}

export default function MarketplaceAnalyticsPage() {
  const { t } = useTranslation();
  const filters = useStoreAnalyticsFilters();
  const { isOwner } = useWorkspaceRole();
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data, isLoading, isError } = useGetStoreMarketplace(filters.apiParams, {
    query: {
      queryKey: getGetStoreMarketplaceQueryKey(filters.apiParams),
      placeholderData: (prev) => prev,
    },
  });

  const totals = data?.totals;
  const reportsTracked = data?.reportsTracked ?? false;

  const channelLabel = (channel: string): string => {
    const key = `marketplaceAnalytics.channel.${channel}`;
    const translated = t(key);
    return translated === key ? channel : translated;
  };

  // Commission-rate editor local state (owner only).
  const [rateDraft, setRateDraft] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!data?.commissionRates) return;
    const next: Record<string, string> = {};
    for (const ch of EDITABLE_CHANNELS) {
      const v = data.commissionRates[ch];
      next[ch] = v == null ? "" : String(v);
    }
    setRateDraft(next);
  }, [data?.commissionRates]);

  const updateRates = useUpdateMarketplaceCommissionRates();
  const saveRates = () => {
    const rates: MarketplaceCommissionRates = {};
    for (const ch of EDITABLE_CHANNELS) {
      const raw = rateDraft[ch];
      if (raw == null || raw === "") continue;
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
        toast({
          title: t("marketplaceAnalytics.rates.invalidTitle"),
          description: t("marketplaceAnalytics.rates.invalidBody"),
          variant: "destructive",
        });
        return;
      }
      rates[ch] = parsed;
    }
    updateRates.mutate(
      { data: { rates } },
      {
        onSuccess: () => {
          toast({ title: t("marketplaceAnalytics.rates.saved") });
          qc.invalidateQueries({ queryKey: ["getStoreMarketplace"] });
        },
        onError: () => {
          toast({
            title: t("marketplaceAnalytics.rates.saveError"),
            variant: "destructive",
          });
        },
      },
    );
  };

  const revenueBarConfig = {
    revenueUsd: {
      label: t("marketplaceAnalytics.kpi.revenue"),
      color: CHART_COLORS[0],
    },
    netRevenueUsd: {
      label: t("marketplaceAnalytics.kpi.netRevenue"),
      color: CHART_COLORS[1],
    },
  } satisfies ChartConfig;

  const byChannel: StoreMarketplaceChannel[] = data?.byChannel ?? [];
  const revenueChartData = byChannel
    .filter((c) => c.revenueUsd > 0)
    .map((c) => ({
      name: channelLabel(c.channel),
      revenueUsd: c.revenueUsd,
      netRevenueUsd: c.netRevenueUsd,
    }));

  const bestSellerChannels = byChannel.filter((c) => c.bestSellers.length > 0);
  const payoutRows = data?.payoutComparison ?? [];

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {t("marketplaceAnalytics.title")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("marketplaceAnalytics.subtitle")}
        </p>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <StoreAnalyticsFilterBar filters={filters} />
        </div>
        <AnalyticsExportMenu
          filename="marketplace-analytics"
          title="Marketplace Analytics"
          filterSummary={buildFilterSummary(filters.apiParams)}
          getDatasets={() => datasetsFromResponse(data)}
          disabled={isLoading || !data}
        />
      </div>

      {isError && (
        <Card>
          <CardContent className="p-6 text-center text-sm text-red-500">
            {t("marketplaceAnalytics.loadError")}
          </CardContent>
        </Card>
      )}

      {/* Headline KPI cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {isLoading && !data ? (
          Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[104px] w-full" />
          ))
        ) : (
          <>
            <KpiCard
              icon={<Scale size={16} />}
              label={t("marketplaceAnalytics.kpi.netRevenue")}
              value={formatUsd(totals?.netRevenueUsd ?? 0)}
              hint={t("marketplaceAnalytics.kpi.netRevenueHint")}
            />
            <KpiCard
              icon={<DollarSign size={16} />}
              label={t("marketplaceAnalytics.kpi.revenue")}
              value={formatUsd(totals?.revenueUsd ?? 0)}
              hint={`${totals?.orders ?? 0} ${t("marketplaceAnalytics.kpi.orders").toLowerCase()}`}
            />
            <KpiCard
              icon={<Percent size={16} />}
              label={t("marketplaceAnalytics.kpi.commission")}
              value={formatUsd(totals?.commissionUsd ?? 0)}
              hint={`${formatUsd(totals?.deliveryCostUsd ?? 0)} ${t("marketplaceAnalytics.kpi.delivery").toLowerCase()}`}
            />
            <KpiCard
              icon={<Wallet size={16} />}
              label={t("marketplaceAnalytics.kpi.expectedPayout")}
              value={formatUsd(totals?.expectedPayoutUsd ?? 0)}
              hint={
                totals?.recordedPayoutUsd == null
                  ? t("marketplaceAnalytics.kpi.noPayoutData")
                  : `${t("marketplaceAnalytics.kpi.recorded")}: ${formatUsd(totals.recordedPayoutUsd)}`
              }
            />
          </>
        )}
      </div>

      {/* Commission-rate editor (owner only) */}
      {isOwner && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Percent size={16} />
              {t("marketplaceAnalytics.rates.title")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-4 text-sm text-muted-foreground">
              {t("marketplaceAnalytics.rates.description")}
            </p>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              {EDITABLE_CHANNELS.map((ch) => (
                <div key={ch} className="space-y-1.5">
                  <Label htmlFor={`rate-${ch}`} className="text-xs">
                    {channelLabel(ch)}
                  </Label>
                  <div className="relative">
                    <Input
                      id={`rate-${ch}`}
                      data-testid={`input-rate-${ch}`}
                      type="number"
                      inputMode="decimal"
                      min={0}
                      max={100}
                      step={0.5}
                      className="pr-7"
                      value={rateDraft[ch] ?? ""}
                      onChange={(e) =>
                        setRateDraft((prev) => ({ ...prev, [ch]: e.target.value }))
                      }
                    />
                    <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                      %
                    </span>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-4 flex justify-end">
              <Button
                onClick={saveRates}
                disabled={updateRates.isPending}
                data-testid="button-save-rates"
              >
                <Save size={16} className="mr-2" />
                {updateRates.isPending
                  ? t("marketplaceAnalytics.rates.saving")
                  : t("marketplaceAnalytics.rates.save")}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Revenue vs net revenue by channel */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Store size={16} />
            {t("marketplaceAnalytics.chart.revenueByChannel")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!data ? (
            <EmptyChart message={t("marketplaceAnalytics.noData")} />
          ) : revenueChartData.length > 0 ? (
            <ChartContainer config={revenueBarConfig} className="h-[280px] w-full">
              <BarChart data={revenueChartData} margin={{ left: 8, right: 8 }}>
                <CartesianGrid vertical={false} strokeDasharray="3 3" />
                <XAxis dataKey="name" tickLine={false} axisLine={false} fontSize={11} />
                <YAxis
                  tickLine={false}
                  axisLine={false}
                  fontSize={11}
                  width={52}
                  tickFormatter={(v: number) => `$${v}`}
                />
                <ChartTooltip content={<ChartTooltipContent />} />
                <ChartLegend content={<ChartLegendContent />} />
                <Bar dataKey="revenueUsd" fill={CHART_COLORS[0]} radius={4} />
                <Bar dataKey="netRevenueUsd" fill={CHART_COLORS[1]} radius={4} />
              </BarChart>
            </ChartContainer>
          ) : (
            <EmptyChart message={t("marketplaceAnalytics.noData")} />
          )}
        </CardContent>
      </Card>

      {/* Per-channel table */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShoppingBag size={16} />
            {t("marketplaceAnalytics.table.byChannel")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {data && byChannel.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="py-2 pr-3 text-left font-medium">
                      {t("marketplaceAnalytics.table.channel")}
                    </th>
                    <th className="py-2 pr-3 text-right font-medium">
                      {t("marketplaceAnalytics.table.orders")}
                    </th>
                    <th className="py-2 pr-3 text-right font-medium">
                      {t("marketplaceAnalytics.table.cancellationRate")}
                    </th>
                    <th className="py-2 pr-3 text-right font-medium">
                      {t("marketplaceAnalytics.table.revenue")}
                    </th>
                    <th className="py-2 pr-3 text-right font-medium">
                      {t("marketplaceAnalytics.table.commissionRate")}
                    </th>
                    <th className="py-2 pr-3 text-right font-medium">
                      {t("marketplaceAnalytics.table.commission")}
                    </th>
                    <th className="py-2 pr-3 text-right font-medium">
                      {t("marketplaceAnalytics.table.delivery")}
                    </th>
                    <th className="py-2 pr-3 text-right font-medium">
                      {t("marketplaceAnalytics.table.netRevenue")}
                    </th>
                    <th className="py-2 text-right font-medium">
                      {t("marketplaceAnalytics.table.aov")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {byChannel.map((c, i) => (
                    <tr
                      key={c.channel}
                      className="border-b last:border-0 hover:bg-muted/40"
                      data-testid={`row-channel-${i}`}
                    >
                      <td className="py-2 pr-3">
                        <span className="flex items-center gap-2">
                          {channelLabel(c.channel)}
                          {c.isMarketplace && (
                            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                              {t("marketplaceAnalytics.table.marketplaceTag")}
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">{c.orders}</td>
                      <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">
                        {c.cancellationRate == null ? "—" : formatPct(c.cancellationRate)}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {formatUsd(c.revenueUsd)}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">
                        {formatPct(c.commissionRatePct)}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {formatUsd(c.commissionUsd)}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">
                        {formatUsd(c.deliveryCostUsd)}
                      </td>
                      <td className="py-2 pr-3 text-right font-medium tabular-nums">
                        {formatUsd(c.netRevenueUsd)}
                      </td>
                      <td className="py-2 text-right tabular-nums text-muted-foreground">
                        {c.avgOrderValueUsd == null ? "—" : formatUsd(c.avgOrderValueUsd)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyChart message={t("marketplaceAnalytics.noData")} />
          )}
        </CardContent>
      </Card>

      {/* Payout comparison (expected vs recorded) */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Wallet size={16} />
            {t("marketplaceAnalytics.payout.title")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!data ? (
            <EmptyChart message={t("marketplaceAnalytics.noData")} />
          ) : !reportsTracked ? (
            <WaitingState message={t("marketplaceAnalytics.payout.waiting")} />
          ) : payoutRows.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="py-2 pr-3 text-left font-medium">
                      {t("marketplaceAnalytics.table.channel")}
                    </th>
                    <th className="py-2 pr-3 text-right font-medium">
                      {t("marketplaceAnalytics.payout.expected")}
                    </th>
                    <th className="py-2 pr-3 text-right font-medium">
                      {t("marketplaceAnalytics.payout.recorded")}
                    </th>
                    <th className="py-2 text-right font-medium">
                      {t("marketplaceAnalytics.payout.variance")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {payoutRows.map((p, i) => (
                    <tr
                      key={p.channel}
                      className="border-b last:border-0 hover:bg-muted/40"
                      data-testid={`row-payout-${i}`}
                    >
                      <td className="py-2 pr-3">{channelLabel(p.channel)}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {formatUsd(p.expectedPayoutUsd)}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">
                        {p.recordedPayoutUsd == null ? "—" : formatUsd(p.recordedPayoutUsd)}
                      </td>
                      <td
                        className={`py-2 text-right font-medium tabular-nums ${
                          p.varianceUsd == null
                            ? "text-muted-foreground"
                            : p.varianceUsd < 0
                              ? "text-red-500"
                              : "text-emerald-600"
                        }`}
                      >
                        {p.varianceUsd == null ? "—" : formatUsd(p.varianceUsd)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyChart message={t("marketplaceAnalytics.payout.waiting")} />
          )}
        </CardContent>
      </Card>

      {/* Best sellers by channel */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Trophy size={16} />
            {t("marketplaceAnalytics.bestSellers.title")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {data && bestSellerChannels.length > 0 ? (
            <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
              {bestSellerChannels.map((c) => (
                <div key={c.channel} className="space-y-2">
                  <div className="text-sm font-medium">{channelLabel(c.channel)}</div>
                  <div className="space-y-1">
                    {c.bestSellers.map((b, i) => (
                      <div
                        key={`${c.channel}\u0000${b.name}`}
                        className="flex items-center justify-between gap-2 rounded-md px-1 py-1 text-sm hover:bg-muted/50"
                        data-testid={`row-bestseller-${c.channel}-${i}`}
                      >
                        <span className="truncate">{b.name}</span>
                        <span className="flex shrink-0 gap-3">
                          <span className="tabular-nums text-muted-foreground">
                            ×{b.quantity}
                          </span>
                          <span className="w-20 text-right font-medium tabular-nums">
                            {formatUsd(b.revenueUsd)}
                          </span>
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyChart message={t("marketplaceAnalytics.bestSellers.empty")} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
