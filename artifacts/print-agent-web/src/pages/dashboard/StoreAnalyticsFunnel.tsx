import { useTranslation } from "react-i18next";
import { AnalyticsExportMenu } from "@/components/AnalyticsExportMenu";
import { buildFilterSummary, datasetsFromResponse } from "@/lib/analytics-export";
import {
  useGetStoreFunnel,
  getGetStoreFunnelQueryKey,
  type GetStoreFunnelParams,
} from "@workspace/api-client-react";
import type { UseStoreAnalyticsFilters } from "@/hooks/use-store-analytics-filters";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import {
  Activity,
  TrendingUp,
  TrendingDown,
  Minus,
  Radio,
} from "lucide-react";
import { BreakdownCard, formatSourceLabel } from "@/components/analytics/BreakdownCard";

const STEP_COLOR = "hsl(210, 100%, 45%)";

function formatPct(n: number): string {
  return `${n.toFixed(1)}%`;
}

function formatInt(n: number): string {
  return new Intl.NumberFormat().format(Math.round(n));
}

function StepDelta({ current, previous }: { current: number; previous: number | null }) {
  if (previous === null || previous === undefined) return null;
  if (previous === 0 && current === 0) return null;
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

export default function StoreAnalyticsFunnel({
  filters,
}: {
  filters: UseStoreAnalyticsFilters;
}) {
  const { t } = useTranslation();
  // GetStoreFunnelParams is structurally identical to the overview params.
  const params: GetStoreFunnelParams = filters.apiParams;
  const { data, isLoading, isError } = useGetStoreFunnel(params, {
    query: {
      queryKey: getGetStoreFunnelQueryKey(params),
      placeholderData: (prev) => prev,
    },
  });

  if (isError) {
    return (
      <Card>
        <CardContent className="p-6 text-center text-sm text-red-500">
          {t("storeAnalytics.loadError")}
        </CardContent>
      </Card>
    );
  }

  if (isLoading && !data) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-[420px] w-full" />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Skeleton className="h-[220px] w-full" />
          <Skeleton className="h-[220px] w-full" />
        </div>
      </div>
    );
  }

  // No website tracking data has ever arrived for this workspace.
  if (data && !data.tracked) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center gap-3 p-12 text-center">
          <div className="rounded-full bg-muted p-3 text-muted-foreground">
            <Radio size={28} />
          </div>
          <h3 className="text-lg font-semibold">
            {t("storeAnalytics.funnel.waitingTitle")}
          </h3>
          <p className="max-w-md text-sm text-muted-foreground">
            {t("storeAnalytics.funnel.waitingDesc")}
          </p>
        </CardContent>
      </Card>
    );
  }

  const steps = data?.steps ?? [];
  const base = steps[0]?.users ?? 0;
  const prevByKey = new Map(
    (data?.previousSteps ?? []).map((s) => [s.key, s.users]),
  );
  const presentailEvents = data?.presentailEvents ?? [];

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <AnalyticsExportMenu
          filename="store-analytics-funnel"
          title="E-commerce Analytics — Funnel"
          filterSummary={buildFilterSummary(filters.apiParams)}
          getDatasets={() => datasetsFromResponse(data)}
          disabled={isLoading || !data}
        />
      </div>
      {/* Conversion funnel */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity size={16} />
            {t("storeAnalytics.funnel.title")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {base > 0 ? (
            <div className="space-y-3">
              {steps.map((step, i) => {
                const widthPct = base > 0 ? Math.max((step.users / base) * 100, 1.5) : 0;
                const prev = prevByKey.has(step.key)
                  ? prevByKey.get(step.key) ?? null
                  : null;
                return (
                  <div key={step.key} className="space-y-1">
                    <div className="flex items-center justify-between text-sm">
                      <span className="flex items-center gap-2 font-medium">
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {i + 1}.
                        </span>
                        {t(`storeAnalytics.funnel.steps.${step.key}`)}
                      </span>
                      <span className="flex items-center gap-3">
                        {data?.comparison && (
                          <StepDelta current={step.users} previous={prev} />
                        )}
                        <span className="tabular-nums font-semibold">
                          {formatInt(step.users)}
                        </span>
                        <span className="w-14 text-right text-xs tabular-nums text-muted-foreground">
                          {formatPct(step.overallConversionRate)}
                        </span>
                      </span>
                    </div>
                    <div className="h-6 w-full overflow-hidden rounded-md bg-muted">
                      <div
                        className="flex h-full items-center rounded-md transition-all"
                        style={{
                          width: `${widthPct}%`,
                          backgroundColor: STEP_COLOR,
                          opacity: 1 - i * 0.055,
                        }}
                      />
                    </div>
                    {i > 0 && step.dropOff > 0 && (
                      <div className="text-xs text-red-500">
                        {t("storeAnalytics.funnel.dropOff", {
                          count: step.dropOff,
                          rate: formatPct(step.dropOffRate),
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="flex h-[200px] items-center justify-center text-center text-sm text-muted-foreground">
              {t("storeAnalytics.noData")}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Breakdowns */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <BreakdownCard
          title={t("storeAnalytics.funnel.breakdown.device")}
          items={data?.breakdowns.device ?? []}
          labelFor={(v) =>
            v === "unknown" ? t("storeAnalytics.funnel.unknown") : v
          }
        />
        <BreakdownCard
          title={t("storeAnalytics.funnel.breakdown.trafficSource")}
          items={data?.breakdowns.trafficSource ?? []}
          labelFor={(v) =>
            v === "unknown"
              ? t("storeAnalytics.funnel.unknown")
              : t(`storeAnalytics.trafficSourceLabels.${v.replace(/\./g, "_")}`, {
                  defaultValue: formatSourceLabel(v),
                })
          }
        />
        <BreakdownCard
          title={t("storeAnalytics.funnel.breakdown.country")}
          items={data?.breakdowns.country ?? []}
          labelFor={(v) =>
            v === "unknown" ? t("storeAnalytics.funnel.unknown") : v
          }
        />
        <BreakdownCard
          title={t("storeAnalytics.funnel.breakdown.city")}
          items={data?.breakdowns.city ?? []}
          labelFor={(v) =>
            v === "unknown" ? t("storeAnalytics.funnel.unknown") : v
          }
        />
        <BreakdownCard
          title={t("storeAnalytics.funnel.breakdown.language")}
          items={data?.breakdowns.language ?? []}
          labelFor={(v) =>
            ["en", "ar", "fr", "other"].includes(v)
              ? t(`storeAnalytics.funnel.language.${v}`)
              : v === "unknown"
                ? t("storeAnalytics.funnel.unknown")
                : v
          }
        />
      </div>

      {/* Presentail-specific events */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {t("storeAnalytics.funnel.presentailEvents")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-3">
            {presentailEvents.map((ev) => (
              <div
                key={ev.key}
                className="rounded-lg border p-3"
              >
                <div className="text-xs text-muted-foreground">
                  {t(`storeAnalytics.funnel.events.${ev.key}`)}
                </div>
                <div className="mt-1 text-xl font-semibold tabular-nums">
                  {formatInt(ev.events)}
                </div>
                <div className="text-xs text-muted-foreground">
                  {t("storeAnalytics.funnel.eventSessions", {
                    count: ev.sessions,
                  })}
                </div>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
