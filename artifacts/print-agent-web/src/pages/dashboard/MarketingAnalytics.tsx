import { useTranslation } from "react-i18next";
import {
  useGetStoreMarketing,
  getGetStoreMarketingQueryKey,
  type StoreMarketingSource,
} from "@workspace/api-client-react";
import { useStoreAnalyticsFilters } from "@/hooks/use-store-analytics-filters";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { AdPlatformsSection } from "@/components/AdPlatformsSection";
import { StoreAnalyticsFilterBar } from "@/components/StoreAnalyticsFilterBar";
import { AnalyticsExportMenu } from "@/components/AnalyticsExportMenu";
import { buildFilterSummary, datasetsFromResponse } from "@/lib/analytics-export";
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
import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from "recharts";
import {
  DollarSign,
  Megaphone,
  TrendingUp,
  Target,
  UserPlus,
  ShoppingBag,
  Percent,
  Repeat,
  Ticket,
  Link2,
  Info,
} from "lucide-react";

const CHART_COLORS = [
  "hsl(210, 100%, 45%)",
  "hsl(160, 84%, 39%)",
  "hsl(35, 92%, 52%)",
  "hsl(280, 65%, 60%)",
  "hsl(340, 82%, 58%)",
  "hsl(190, 90%, 42%)",
  "hsl(50, 92%, 50%)",
  "hsl(0, 0%, 55%)",
];

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

function formatRoas(n: number): string {
  return `${n.toFixed(2)}×`;
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

/** Banner shown when a section has no tracking data yet. */
function WaitingState({ message }: { message: string }) {
  return (
    <div className="flex h-[240px] flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
      <Info size={22} className="opacity-60" />
      <span className="max-w-xs">{message}</span>
    </div>
  );
}

export default function MarketingAnalyticsPage() {
  const { t } = useTranslation();
  const { isOwner } = useWorkspaceRole();
  const filters = useStoreAnalyticsFilters();
  const { data, isLoading, isError } = useGetStoreMarketing(filters.apiParams, {
    query: {
      queryKey: getGetStoreMarketingQueryKey(filters.apiParams),
      placeholderData: (prev) => prev,
    },
  });

  const spendTracked = data?.spendTracked ?? false;
  const attributionTracked = data?.attributionTracked ?? false;
  const eventsTracked = data?.eventsTracked ?? false;
  const totals = data?.totals;

  const sourceLabel = (channel: string): string => {
    const key = `marketingAnalytics.source.${channel}`;
    const translated = t(key);
    return translated === key ? channel : translated;
  };

  const spendHint = spendTracked ? undefined : t("marketingAnalytics.connectSpendTitle");
  const naOrValue = (tracked: boolean, value: string): string =>
    tracked ? value : t("marketingAnalytics.notAvailable");
  const ratioOr = (v: number | null | undefined, fmt: (n: number) => string): string =>
    v == null ? t("marketingAnalytics.notAvailable") : fmt(v);

  const revenueBarConfig = {
    revenueUsd: { label: t("marketingAnalytics.kpi.revenue"), color: CHART_COLORS[0] },
  } satisfies ChartConfig;

  const roasBarConfig = {
    revenueRoas: {
      label: t("marketingAnalytics.table.revenueRoas"),
      color: CHART_COLORS[0],
    },
    grossMarginRoas: {
      label: t("marketingAnalytics.table.grossMarginRoas"),
      color: CHART_COLORS[1],
    },
  } satisfies ChartConfig;

  const bySource: StoreMarketingSource[] = data?.bySource ?? [];
  const revenueChartData = bySource
    .filter((s) => s.revenueUsd > 0)
    .slice(0, 8)
    .map((s) => ({ name: sourceLabel(s.channel), revenueUsd: s.revenueUsd }));
  const roasChartData = bySource
    .filter((s) => s.spendUsd > 0)
    .slice(0, 8)
    .map((s) => ({
      name: sourceLabel(s.channel),
      revenueRoas: s.revenueRoas ?? 0,
      grossMarginRoas: s.grossMarginRoas ?? 0,
    }));

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {t("marketingAnalytics.title")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("marketingAnalytics.subtitle")}
        </p>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <StoreAnalyticsFilterBar filters={filters} />
        </div>
        <AnalyticsExportMenu
          filename="marketing-analytics"
          title="Marketing Analytics"
          filterSummary={buildFilterSummary(filters.apiParams)}
          getDatasets={() => datasetsFromResponse(data)}
          disabled={isLoading || !data}
        />
      </div>

      {isError && (
        <Card>
          <CardContent className="p-6 text-center text-sm text-red-500">
            {t("marketingAnalytics.loadError")}
          </CardContent>
        </Card>
      )}

      {/* Connect-ad-spend banner (spend is the enabler for CAC/ROAS). */}
      {data && !spendTracked && (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-2 p-6 text-center">
            <Megaphone size={26} className="text-muted-foreground opacity-70" />
            <div className="text-base font-medium">
              {t("marketingAnalytics.connectSpendTitle")}
            </div>
            <p className="max-w-md text-sm text-muted-foreground">
              {t("marketingAnalytics.connectSpendBody")}
            </p>
            {isOwner && (
              <button
                type="button"
                className="text-sm font-medium text-primary underline-offset-4 hover:underline"
                onClick={() =>
                  document
                    .getElementById("ad-platforms")
                    ?.scrollIntoView({ behavior: "smooth", block: "start" })
                }
                data-testid="button-goto-ad-platforms"
              >
                {t("adPlatforms.bannerCta")}
              </button>
            )}
          </CardContent>
        </Card>
      )}

      {/* Ad platform connections — owner-only auto-sync of Google/Meta spend. */}
      {isOwner && <AdPlatformsSection />}

      {/* KPI cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {isLoading && !data ? (
          Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-[104px] w-full" />
          ))
        ) : (
          <>
            <KpiCard
              icon={<DollarSign size={16} />}
              label={t("marketingAnalytics.kpi.revenue")}
              value={formatUsd(totals?.revenueUsd ?? 0)}
              hint={`${totals?.orders ?? 0} ${t("marketingAnalytics.kpi.orders").toLowerCase()}`}
            />
            <KpiCard
              icon={<Megaphone size={16} />}
              label={t("marketingAnalytics.kpi.spend")}
              value={naOrValue(spendTracked, formatUsd(totals?.spendUsd ?? 0))}
              hint={spendTracked ? `${totals?.clicks ?? 0} ${t("marketingAnalytics.table.clicks").toLowerCase()}` : spendHint}
            />
            <KpiCard
              icon={<TrendingUp size={16} />}
              label={t("marketingAnalytics.kpi.revenueRoas")}
              value={naOrValue(spendTracked, ratioOr(totals?.revenueRoas, formatRoas))}
              hint={spendHint}
            />
            <KpiCard
              icon={<Target size={16} />}
              label={t("marketingAnalytics.kpi.grossMarginRoas")}
              value={naOrValue(spendTracked, ratioOr(totals?.grossMarginRoas, formatRoas))}
              hint={spendHint}
            />
            <KpiCard
              icon={<UserPlus size={16} />}
              label={t("marketingAnalytics.kpi.cac")}
              value={naOrValue(spendTracked, ratioOr(totals?.cac, formatUsd))}
              hint={spendHint}
            />
            <KpiCard
              icon={<UserPlus size={16} />}
              label={t("marketingAnalytics.kpi.firstOrderCac")}
              value={naOrValue(spendTracked, ratioOr(totals?.firstOrderCac, formatUsd))}
              hint={spendHint}
            />
            <KpiCard
              icon={<Percent size={16} />}
              label={t("marketingAnalytics.kpi.grossMargin")}
              value={formatUsd(totals?.grossMarginUsd ?? 0)}
              hint={ratioOr(totals?.grossMarginPct, formatPct)}
            />
            <KpiCard
              icon={<Repeat size={16} />}
              label={t("marketingAnalytics.kpi.repeatRevenue")}
              value={formatUsd(totals?.repeatRevenueUsd ?? 0)}
              hint={
                eventsTracked
                  ? `${formatPct(totals?.conversionRate ?? 0)} ${t("marketingAnalytics.kpi.conversionRate").toLowerCase()}`
                  : undefined
              }
            />
          </>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Revenue by source */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <DollarSign size={16} />
              {t("marketingAnalytics.chart.revenueBySource")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!data ? (
              <EmptyChart message={t("marketingAnalytics.noData")} />
            ) : !attributionTracked ? (
              <WaitingState message={t("marketingAnalytics.attributionWaiting")} />
            ) : revenueChartData.length > 0 ? (
              <ChartContainer config={revenueBarConfig} className="h-[260px] w-full">
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
                  <Bar dataKey="revenueUsd" radius={4}>
                    {revenueChartData.map((_, i) => (
                      <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ChartContainer>
            ) : (
              <EmptyChart message={t("marketingAnalytics.noData")} />
            )}
          </CardContent>
        </Card>

        {/* ROAS by source (revenue vs gross-margin, side by side) */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <TrendingUp size={16} />
              {t("marketingAnalytics.chart.roasBySource")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!data ? (
              <EmptyChart message={t("marketingAnalytics.noData")} />
            ) : !spendTracked ? (
              <WaitingState message={t("marketingAnalytics.connectSpendBody")} />
            ) : roasChartData.length > 0 ? (
              <ChartContainer config={roasBarConfig} className="h-[260px] w-full">
                <BarChart data={roasChartData} margin={{ left: 8, right: 8 }}>
                  <CartesianGrid vertical={false} strokeDasharray="3 3" />
                  <XAxis dataKey="name" tickLine={false} axisLine={false} fontSize={11} />
                  <YAxis
                    tickLine={false}
                    axisLine={false}
                    fontSize={11}
                    width={44}
                    tickFormatter={(v: number) => `${v}×`}
                  />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <ChartLegend content={<ChartLegendContent />} />
                  <Bar dataKey="revenueRoas" fill={CHART_COLORS[0]} radius={4} />
                  <Bar dataKey="grossMarginRoas" fill={CHART_COLORS[1]} radius={4} />
                </BarChart>
              </ChartContainer>
            ) : (
              <EmptyChart message={t("marketingAnalytics.noData")} />
            )}
          </CardContent>
        </Card>
      </div>

      {/* Campaign performance table (both ROAS side by side) */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Megaphone size={16} />
            {t("marketingAnalytics.table.campaigns")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {data && data.campaigns.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="py-2 pr-3 text-left font-medium">
                      {t("marketingAnalytics.table.channel")}
                    </th>
                    <th className="py-2 pr-3 text-left font-medium">
                      {t("marketingAnalytics.table.campaign")}
                    </th>
                    <th className="py-2 pr-3 text-right font-medium">
                      {t("marketingAnalytics.table.spend")}
                    </th>
                    <th className="py-2 pr-3 text-right font-medium">
                      {t("marketingAnalytics.table.clicks")}
                    </th>
                    <th className="py-2 pr-3 text-right font-medium">
                      {t("marketingAnalytics.table.sessions")}
                    </th>
                    <th className="py-2 pr-3 text-right font-medium">
                      {t("marketingAnalytics.table.addToCarts")}
                    </th>
                    <th className="py-2 pr-3 text-right font-medium">
                      {t("marketingAnalytics.table.orders")}
                    </th>
                    <th className="py-2 pr-3 text-right font-medium">
                      {t("marketingAnalytics.table.revenue")}
                    </th>
                    <th className="py-2 pr-3 text-right font-medium">
                      {t("marketingAnalytics.table.grossMargin")}
                    </th>
                    <th className="py-2 pr-3 text-right font-medium">
                      {t("marketingAnalytics.table.revenueRoas")}
                    </th>
                    <th className="py-2 pr-3 text-right font-medium">
                      {t("marketingAnalytics.table.grossMarginRoas")}
                    </th>
                    <th className="py-2 text-right font-medium">
                      {t("marketingAnalytics.table.cac")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.campaigns.map((c, i) => (
                    <tr
                      key={`${c.channel}\u0000${c.campaign}`}
                      className="border-b last:border-0 hover:bg-muted/40"
                      data-testid={`row-campaign-${i}`}
                    >
                      <td className="py-2 pr-3">{sourceLabel(c.channel)}</td>
                      <td className="py-2 pr-3 text-muted-foreground">{c.campaign}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {formatUsd(c.spendUsd)}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">
                        {c.clicks}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">
                        {c.sessions}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">
                        {c.addToCarts}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">{c.orders}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {formatUsd(c.revenueUsd)}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {formatUsd(c.grossMarginUsd)}
                      </td>
                      <td className="py-2 pr-3 text-right font-medium tabular-nums">
                        {ratioOr(c.revenueRoas, formatRoas)}
                      </td>
                      <td className="py-2 pr-3 text-right font-medium tabular-nums">
                        {ratioOr(c.grossMarginRoas, formatRoas)}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        {ratioOr(c.cac, formatUsd)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyChart message={t("marketingAnalytics.table.noCampaigns")} />
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Promo-code performance */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Ticket size={16} />
              {t("marketingAnalytics.chart.promoPerformance")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {data && data.promoPerformance.length > 0 ? (
              <div className="space-y-1">
                <div className="flex items-center justify-between px-1 pb-2 text-xs font-medium text-muted-foreground">
                  <span>{t("marketingAnalytics.table.code")}</span>
                  <div className="flex gap-6">
                    <span className="w-16 text-right">
                      {t("marketingAnalytics.table.redemptions")}
                    </span>
                    <span className="w-20 text-right">
                      {t("marketingAnalytics.table.discount")}
                    </span>
                    <span className="w-24 text-right">
                      {t("marketingAnalytics.table.revenue")}
                    </span>
                  </div>
                </div>
                {data.promoPerformance.map((p, i) => (
                  <div
                    key={p.code}
                    className="flex items-center justify-between rounded-md px-1 py-1.5 text-sm hover:bg-muted/50"
                    data-testid={`row-promo-${i}`}
                  >
                    <span className="truncate font-mono uppercase">{p.code}</span>
                    <div className="flex gap-6">
                      <span className="w-16 text-right tabular-nums text-muted-foreground">
                        {p.redemptions}
                      </span>
                      <span className="w-20 text-right tabular-nums text-muted-foreground">
                        {formatUsd(p.discountUsd)}
                      </span>
                      <span className="w-24 text-right font-medium tabular-nums">
                        {formatUsd(p.revenueUsd)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyChart message={t("marketingAnalytics.table.noPromos")} />
            )}
          </CardContent>
        </Card>

        {/* Landing-page performance */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Link2 size={16} />
              {t("marketingAnalytics.chart.landingPages")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!data ? (
              <EmptyChart message={t("marketingAnalytics.noData")} />
            ) : !attributionTracked ? (
              <WaitingState message={t("marketingAnalytics.attributionWaiting")} />
            ) : data.landingPages.length > 0 ? (
              <div className="space-y-1">
                <div className="flex items-center justify-between px-1 pb-2 text-xs font-medium text-muted-foreground">
                  <span>{t("marketingAnalytics.table.path")}</span>
                  <div className="flex gap-6">
                    <span className="w-16 text-right">
                      {t("marketingAnalytics.table.orders")}
                    </span>
                    <span className="w-24 text-right">
                      {t("marketingAnalytics.table.revenue")}
                    </span>
                  </div>
                </div>
                {data.landingPages.map((l, i) => (
                  <div
                    key={l.path}
                    className="flex items-center justify-between rounded-md px-1 py-1.5 text-sm hover:bg-muted/50"
                    data-testid={`row-landing-${i}`}
                  >
                    <span className="truncate font-mono text-xs">{l.path}</span>
                    <div className="flex gap-6">
                      <span className="w-16 text-right tabular-nums text-muted-foreground">
                        {l.orders}
                      </span>
                      <span className="w-24 text-right font-medium tabular-nums">
                        {formatUsd(l.revenueUsd)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyChart message={t("marketingAnalytics.table.noLandingPages")} />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
