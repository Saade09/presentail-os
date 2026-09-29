import { useTranslation } from "react-i18next";
import {
  useGetStoreSearchDiscovery,
  getGetStoreSearchDiscoveryQueryKey,
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
  Search,
  SearchX,
  MousePointerClick,
  Target,
  Hash,
  Tags,
  Gift,
  SlidersHorizontal,
  ArrowUpDown,
  Filter,
  ClipboardList,
  Info,
  Lightbulb,
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

function formatInt(n: number): string {
  return new Intl.NumberFormat().format(n);
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

/** Banner shown when a section has no tracking data yet. */
function WaitingState({ message }: { message: string }) {
  return (
    <div className="flex h-[240px] flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
      <Info size={22} className="opacity-60" />
      <span className="max-w-xs">{message}</span>
    </div>
  );
}

export default function SearchDiscoveryAnalyticsPage() {
  const { t } = useTranslation();
  const filters = useStoreAnalyticsFilters();
  const { data, isLoading, isError } = useGetStoreSearchDiscovery(
    filters.apiParams,
    {
      query: {
        queryKey: getGetStoreSearchDiscoveryQueryKey(filters.apiParams),
        placeholderData: (prev) => prev,
      },
    },
  );

  const eventsTracked = data?.eventsTracked ?? false;
  const totals = data?.totals;
  const counts = data?.eventCounts;

  const ratioOr = (
    v: number | null | undefined,
    fmt: (n: number) => string,
  ): string => (v == null ? t("searchDiscovery.notAvailable") : fmt(v));

  const barConfig = {
    value: { label: t("searchDiscovery.clicks"), color: CHART_COLORS[0] },
  } satisfies ChartConfig;

  const categoryData = (data?.categoryClicks ?? [])
    .slice(0, 8)
    .map((c) => ({ name: c.name, value: c.clicks }));
  const occasionData = (data?.occasionClicks ?? [])
    .slice(0, 8)
    .map((c) => ({ name: c.name, value: c.clicks }));
  const filterData = (data?.filterUsage ?? [])
    .slice(0, 8)
    .map((c) => ({ name: c.name, value: c.count }));
  const sortData = (data?.sortUsage ?? [])
    .slice(0, 8)
    .map((c) => ({ name: c.name, value: c.count }));

  const eventCountRows: Array<{ key: string; label: string; value: number }> =
    counts
      ? [
          { key: "searchQueryTyped", label: t("searchDiscovery.events.searchTyped"), value: counts.searchQueryTyped },
          { key: "searchResultsClicked", label: t("searchDiscovery.events.resultsClicked"), value: counts.searchResultsClicked },
          { key: "noResultsFound", label: t("searchDiscovery.events.noResults"), value: counts.noResultsFound },
          { key: "filterSelected", label: t("searchDiscovery.events.filterSelected"), value: counts.filterSelected },
          { key: "sortSelected", label: t("searchDiscovery.events.sortSelected"), value: counts.sortSelected },
          { key: "occasionSelected", label: t("searchDiscovery.events.occasionSelected"), value: counts.occasionSelected },
          { key: "recipientSelected", label: t("searchDiscovery.events.recipientSelected"), value: counts.recipientSelected },
          { key: "brandSelected", label: t("searchDiscovery.events.brandSelected"), value: counts.brandSelected },
          { key: "priceRangeSelected", label: t("searchDiscovery.events.priceRangeSelected"), value: counts.priceRangeSelected },
        ]
      : [];

  function ClicksChart({
    rows,
    empty,
  }: {
    rows: Array<{ name: string; value: number }>;
    empty: string;
  }) {
    if (!data) return <EmptyChart message={t("searchDiscovery.noData")} />;
    if (!eventsTracked)
      return <WaitingState message={t("searchDiscovery.eventsWaiting")} />;
    if (rows.length === 0) return <EmptyChart message={empty} />;
    return (
      <ChartContainer config={barConfig} className="h-[260px] w-full">
        <BarChart data={rows} margin={{ left: 8, right: 8 }}>
          <CartesianGrid vertical={false} strokeDasharray="3 3" />
          <XAxis dataKey="name" tickLine={false} axisLine={false} fontSize={11} />
          <YAxis
            tickLine={false}
            axisLine={false}
            fontSize={11}
            width={40}
            allowDecimals={false}
          />
          <ChartTooltip content={<ChartTooltipContent />} />
          <Bar dataKey="value" radius={4}>
            {rows.map((_, i) => (
              <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
            ))}
          </Bar>
        </BarChart>
      </ChartContainer>
    );
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {t("searchDiscovery.title")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("searchDiscovery.subtitle")}
        </p>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <StoreAnalyticsFilterBar filters={filters} />
        </div>
        <AnalyticsExportMenu
          filename="search-discovery-analytics"
          title="Search & Discovery Analytics"
          filterSummary={buildFilterSummary(filters.apiParams)}
          getDatasets={() => datasetsFromResponse(data)}
          disabled={isLoading || !data}
        />
      </div>

      {isError && (
        <Card>
          <CardContent className="p-6 text-center text-sm text-red-500">
            {t("searchDiscovery.loadError")}
          </CardContent>
        </Card>
      )}

      {/* Waiting-for-events banner (website events are the enabler). */}
      {data && !eventsTracked && (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-2 p-6 text-center">
            <Search size={26} className="text-muted-foreground opacity-70" />
            <div className="text-base font-medium">
              {t("searchDiscovery.waitingTitle")}
            </div>
            <p className="max-w-md text-sm text-muted-foreground">
              {t("searchDiscovery.waitingBody")}
            </p>
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
              icon={<Search size={16} />}
              label={t("searchDiscovery.kpi.searches")}
              value={formatInt(totals?.searches ?? 0)}
              hint={`${formatInt(totals?.searchSessions ?? 0)} ${t("searchDiscovery.kpi.searchSessions").toLowerCase()}`}
            />
            <KpiCard
              icon={<Hash size={16} />}
              label={t("searchDiscovery.kpi.uniqueTerms")}
              value={formatInt(totals?.uniqueTerms ?? 0)}
            />
            <KpiCard
              icon={<SearchX size={16} />}
              label={t("searchDiscovery.kpi.noResultRate")}
              value={ratioOr(totals?.noResultRate, formatPct)}
              hint={`${formatInt(totals?.noResultSearches ?? 0)} ${t("searchDiscovery.kpi.noResultSearches").toLowerCase()}`}
            />
            <KpiCard
              icon={<MousePointerClick size={16} />}
              label={t("searchDiscovery.kpi.clickThroughRate")}
              value={ratioOr(totals?.clickThroughRate, formatPct)}
              hint={`${formatInt(totals?.resultClicks ?? 0)} ${t("searchDiscovery.kpi.resultClicks").toLowerCase()}`}
            />
            <KpiCard
              icon={<Target size={16} />}
              label={t("searchDiscovery.kpi.searchConversionRate")}
              value={ratioOr(totals?.searchConversionRate, formatPct)}
              hint={t("searchDiscovery.kpi.searchConversionHint")}
            />
          </>
        )}
      </div>

      {/* Merchandising insight */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Lightbulb size={16} />
            {t("searchDiscovery.gaps.title")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!data ? (
            <EmptyChart message={t("searchDiscovery.noData")} />
          ) : !eventsTracked ? (
            <WaitingState message={t("searchDiscovery.eventsWaiting")} />
          ) : data.merchandisingGaps.length > 0 ? (
            <>
              <p className="mb-3 text-sm text-muted-foreground">
                {t("searchDiscovery.gaps.subtitle")}
              </p>
              <div className="space-y-1">
                <div className="flex items-center justify-between px-1 pb-2 text-xs font-medium text-muted-foreground">
                  <span>{t("searchDiscovery.table.term")}</span>
                  <div className="flex gap-6">
                    <span className="w-16 text-right">
                      {t("searchDiscovery.table.searches")}
                    </span>
                    <span className="w-24 text-right">
                      {t("searchDiscovery.table.avgResults")}
                    </span>
                  </div>
                </div>
                {data.merchandisingGaps.map((g, i) => (
                  <div
                    key={g.term}
                    className="flex items-center justify-between rounded-md px-1 py-1.5 text-sm hover:bg-muted/50"
                    data-testid={`row-gap-${i}`}
                  >
                    <span className="truncate font-medium">{g.term}</span>
                    <div className="flex gap-6">
                      <span className="w-16 text-right tabular-nums text-muted-foreground">
                        {formatInt(g.searches)}
                      </span>
                      <span className="w-24 text-right tabular-nums text-amber-600 dark:text-amber-500">
                        {g.avgResultCount.toFixed(1)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <EmptyChart message={t("searchDiscovery.gaps.empty")} />
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Top search terms */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Search size={16} />
              {t("searchDiscovery.topTerms.title")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!data ? (
              <EmptyChart message={t("searchDiscovery.noData")} />
            ) : !eventsTracked ? (
              <WaitingState message={t("searchDiscovery.eventsWaiting")} />
            ) : data.topSearchTerms.length > 0 ? (
              <div className="space-y-1">
                <div className="flex items-center justify-between px-1 pb-2 text-xs font-medium text-muted-foreground">
                  <span>{t("searchDiscovery.table.term")}</span>
                  <div className="flex gap-6">
                    <span className="w-16 text-right">
                      {t("searchDiscovery.table.searches")}
                    </span>
                    <span className="w-16 text-right">
                      {t("searchDiscovery.table.clicks")}
                    </span>
                    <span className="w-16 text-right">
                      {t("searchDiscovery.table.ctr")}
                    </span>
                  </div>
                </div>
                {data.topSearchTerms.map((s, i) => (
                  <div
                    key={s.term}
                    className="flex items-center justify-between rounded-md px-1 py-1.5 text-sm hover:bg-muted/50"
                    data-testid={`row-term-${i}`}
                  >
                    <span className="truncate font-medium">{s.term}</span>
                    <div className="flex gap-6">
                      <span className="w-16 text-right tabular-nums">
                        {formatInt(s.searches)}
                      </span>
                      <span className="w-16 text-right tabular-nums text-muted-foreground">
                        {formatInt(s.clicks)}
                      </span>
                      <span className="w-16 text-right tabular-nums text-muted-foreground">
                        {ratioOr(s.clickThroughRate, formatPct)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyChart message={t("searchDiscovery.topTerms.empty")} />
            )}
          </CardContent>
        </Card>

        {/* No-result searches */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <SearchX size={16} />
              {t("searchDiscovery.noResults.title")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!data ? (
              <EmptyChart message={t("searchDiscovery.noData")} />
            ) : !eventsTracked ? (
              <WaitingState message={t("searchDiscovery.eventsWaiting")} />
            ) : data.noResultTerms.length > 0 ? (
              <div className="space-y-1">
                <div className="flex items-center justify-between px-1 pb-2 text-xs font-medium text-muted-foreground">
                  <span>{t("searchDiscovery.table.term")}</span>
                  <span className="w-16 text-right">
                    {t("searchDiscovery.table.searches")}
                  </span>
                </div>
                {data.noResultTerms.map((n, i) => (
                  <div
                    key={n.term}
                    className="flex items-center justify-between rounded-md px-1 py-1.5 text-sm hover:bg-muted/50"
                    data-testid={`row-noresult-${i}`}
                  >
                    <span className="truncate font-medium">{n.term}</span>
                    <span className="w-16 text-right tabular-nums text-muted-foreground">
                      {formatInt(n.searches)}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyChart message={t("searchDiscovery.noResults.empty")} />
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Category clicks */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Tags size={16} />
              {t("searchDiscovery.categoryClicks.title")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ClicksChart
              rows={categoryData}
              empty={t("searchDiscovery.categoryClicks.empty")}
            />
          </CardContent>
        </Card>

        {/* Occasion clicks */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Gift size={16} />
              {t("searchDiscovery.occasionClicks.title")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ClicksChart
              rows={occasionData}
              empty={t("searchDiscovery.occasionClicks.empty")}
            />
          </CardContent>
        </Card>

        {/* Filter usage */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <SlidersHorizontal size={16} />
              {t("searchDiscovery.filterUsage.title")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ClicksChart
              rows={filterData}
              empty={t("searchDiscovery.filterUsage.empty")}
            />
          </CardContent>
        </Card>

        {/* Sort usage */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ArrowUpDown size={16} />
              {t("searchDiscovery.sortUsage.title")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ClicksChart
              rows={sortData}
              empty={t("searchDiscovery.sortUsage.empty")}
            />
          </CardContent>
        </Card>
      </div>

      {/* Event-level counts */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ClipboardList size={16} />
            {t("searchDiscovery.events.title")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!data ? (
            <EmptyChart message={t("searchDiscovery.noData")} />
          ) : !eventsTracked ? (
            <WaitingState message={t("searchDiscovery.eventsWaiting")} />
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-3">
              {eventCountRows.map((row) => (
                <div
                  key={row.key}
                  className="flex items-center justify-between rounded-lg border p-3"
                  data-testid={`event-count-${row.key}`}
                >
                  <span className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Filter size={14} className="opacity-60" />
                    {row.label}
                  </span>
                  <span className="text-lg font-semibold tabular-nums">
                    {formatInt(row.value)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
