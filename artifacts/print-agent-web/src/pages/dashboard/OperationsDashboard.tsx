import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { format } from "date-fns";
import { Link } from "wouter";
import {
  getGetOperationsDashboardSummaryQueryKey,
  useGetOperationsDashboardSummary,
} from "@workspace/api-client-react";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import {
  hasCmcPosSubAccess,
  hasFloristOrdersAccess,
} from "@/pages/dashboard/nav";
import { useDocumentVisibility } from "@/hooks/use-document-visibility";
import {
  Camera,
  MapPin,
  Package,
  ArrowRight,
  RefreshCcw,
  AlertTriangle,
  CheckSquare,
} from "lucide-react";
import { Button } from "@/components/ui/button";

export default function OperationsDashboard() {
  const { t } = useTranslation();
  const isVisible = useDocumentVisibility();

  const { isOwner, allowedPages, loaded: rolesLoaded } = useWorkspaceRole();

  const hasOrdersAccess = isOwner || !!allowedPages?.includes("orders");
  const hasFloristAccess =
    isOwner || hasFloristOrdersAccess(allowedPages ?? []);
  const hasCmcAccess =
    isOwner ||
    hasCmcPosSubAccess("cmc_pos.view_location_requests")(allowedPages ?? []);

  const [todayStr, setTodayStr] = useState(() => format(new Date(), "yyyy-MM-dd"));
  const tz = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    [],
  );
  const queryParams = useMemo(() => ({ date: todayStr, tz }), [todayStr, tz]);

  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout>;

    const scheduleNextLocalDay = () => {
      const now = new Date();
      const nextMidnight = new Date(now);
      nextMidnight.setHours(24, 0, 0, 0);

      timeout = setTimeout(() => {
        setTodayStr(format(new Date(), "yyyy-MM-dd"));
        scheduleNextLocalDay();
      }, nextMidnight.getTime() - now.getTime() + 10);
    };

    scheduleNextLocalDay();
    return () => clearTimeout(timeout);
  }, []);

  const { data, isLoading, isError, refetch, isRefetching } =
    useGetOperationsDashboardSummary(
      queryParams,
      {
        query: {
          queryKey: getGetOperationsDashboardSummaryQueryKey(queryParams),
          refetchInterval: isVisible ? 30_000 : false,
          refetchIntervalInBackground: false,
          refetchOnWindowFocus: false,
        },
      },
    );

  useEffect(() => {
    if (isVisible && !isLoading) {
      refetch();
    }
  }, [isVisible, refetch, isLoading]);

  if (!rolesLoaded) {
    return null;
  }

  return (
    <div
      className="max-w-6xl mx-auto space-y-8 p-6 md:p-8 animate-in fade-in duration-500"
      data-testid="ops-dashboard"
    >
        <header className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-foreground">
              {t("opsDashboard.title")}
            </h1>
            <p className="text-muted-foreground mt-1.5 text-base">
              {t("opsDashboard.subtitle")}
            </p>
          </div>
          <Button 
            variant="outline" 
            size="sm" 
            onClick={() => refetch()} 
            disabled={isLoading || isRefetching}
            className="w-full sm:w-auto"
          >
            <RefreshCcw className={`w-4 h-4 mr-2 ${isRefetching ? "animate-spin" : ""}`} />
            {t("opsDashboard.refresh")}
          </Button>
        </header>

        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </div>
        ) : isError ? (
          <div className="p-12 border border-destructive/20 bg-destructive/5 rounded-xl flex flex-col items-center justify-center text-center">
            <AlertTriangle className="w-10 h-10 text-destructive mb-4" />
            <h2 className="text-lg font-semibold text-destructive">{t("opsDashboard.error")}</h2>
            <Button variant="outline" className="mt-4" onClick={() => refetch()}>
              {t("opsDashboard.retry")}
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            
            {/* Florist Review Alert - Only if > 0 */}
            {data && data.florist_manual_review_count > 0 && (
              <StatCard
                title={t("opsDashboard.floristReview")}
                description={t("opsDashboard.floristReviewDesc")}
                count={data.florist_manual_review_count}
                icon={Camera}
                href="/florist-orders"
                canLink={hasFloristAccess}
                colorTheme="rose"
                testId="ops-florist-review"
              />
            )}

            {/* CMC Requests Alert - Only if > 0 */}
            {data && data.cmc_submitted_request_count > 0 && (
              <StatCard
                title={t("opsDashboard.cmcRequests")}
                description={t("opsDashboard.cmcRequestsDesc")}
                count={data.cmc_submitted_request_count}
                icon={MapPin}
                href="/cmc-pos/location-requests?status=submitted"
                canLink={hasCmcAccess}
                colorTheme="amber"
                testId="ops-cmc-requests"
              />
            )}

            {/* Processing Orders - Always visible */}
            {data && (
              <StatCard
                title={t("opsDashboard.processingOrders")}
                description={t("opsDashboard.processingOrdersDesc")}
                count={data.processing_orders_today_count}
                icon={Package}
                href={`/orders?status=processing&deliveryDates=${todayStr}`}
                canLink={hasOrdersAccess}
                colorTheme="emerald"
                testId="ops-processing-orders"
              />
            )}

            {data && data.florist_manual_review_count === 0 && data.cmc_submitted_request_count === 0 && (
              <div className="col-span-1 md:col-span-2 p-8 border border-dashed rounded-xl bg-muted/10 flex flex-col items-center justify-center text-center text-muted-foreground h-full min-h-[220px]">
                <div className="w-12 h-12 rounded-full bg-muted/50 flex items-center justify-center mb-4">
                  <CheckSquare className="w-6 h-6 opacity-50" />
                </div>
                <p className="text-lg font-medium">{t("opsDashboard.noActionRequired")}</p>
              </div>
            )}
          </div>
        )}
    </div>
  );
}

interface StatCardProps {
  title: string;
  description: string;
  count: number;
  icon: React.ElementType;
  href: string;
  canLink: boolean;
  colorTheme: "rose" | "amber" | "emerald";
  testId: string;
}

function StatCard({
  title,
  description,
  count,
  icon: Icon,
  href,
  canLink,
  colorTheme,
  testId,
}: StatCardProps) {
  const { t } = useTranslation();
  const themeClasses = {
    rose: {
      bg: "bg-rose-100 dark:bg-rose-500/20",
      text: "text-rose-600 dark:text-rose-400",
      borderHover: "hover:border-rose-300 dark:hover:border-rose-500/50",
      ringFocus: "focus-visible:ring-rose-500",
      link: "text-rose-600 dark:text-rose-400",
    },
    amber: {
      bg: "bg-amber-100 dark:bg-amber-500/20",
      text: "text-amber-600 dark:text-amber-400",
      borderHover: "hover:border-amber-300 dark:hover:border-amber-500/50",
      ringFocus: "focus-visible:ring-amber-500",
      link: "text-amber-600 dark:text-amber-400",
    },
    emerald: {
      bg: "bg-emerald-100 dark:bg-emerald-500/20",
      text: "text-emerald-600 dark:text-emerald-400",
      borderHover: "hover:border-emerald-300 dark:hover:border-emerald-500/50",
      ringFocus: "focus-visible:ring-emerald-500",
      link: "text-emerald-600 dark:text-emerald-400",
    },
  };

  const theme = themeClasses[colorTheme];

  const content = (
    <div 
      data-testid={testId}
      className={`
        flex flex-col p-6 h-full border rounded-xl bg-card shadow-sm transition-all duration-300 relative overflow-hidden
        ${canLink ? `hover:shadow-md ${theme.borderHover} hover:-translate-y-1` : "opacity-90 grayscale-[0.2]"}
      `}
    >
      <div className="flex items-start justify-between relative z-10">
        <div className={`p-3 rounded-2xl ${theme.bg}`}>
          <Icon className={`w-6 h-6 ${theme.text}`} strokeWidth={2.5} />
        </div>
        <span className={`text-5xl font-black tracking-tighter tabular-nums leading-none ${count > 0 ? "text-foreground" : "text-muted-foreground/40"}`}>
          {count}
        </span>
      </div>
      
      <div className="mt-8 flex-1 relative z-10">
        <h3 className="font-bold text-xl tracking-tight leading-tight">{title}</h3>
        <p className="text-sm text-muted-foreground mt-2 leading-relaxed">{description}</p>
      </div>

      {canLink && (
        <div className={`mt-6 flex items-center gap-2 text-sm font-semibold opacity-0 -translate-x-2 group-hover:opacity-100 group-hover:translate-x-0 transition-all duration-300 ${theme.link} relative z-10`}>
          <span>{t("opsDashboard.viewItems")}</span>
          <ArrowRight className="w-4 h-4" />
        </div>
      )}

      <div className={`absolute -right-12 -bottom-12 w-48 h-48 rounded-full blur-3xl opacity-0 group-hover:opacity-20 transition-opacity duration-700 pointer-events-none ${theme.bg}`} />
    </div>
  );

  if (canLink) {
    return (
      <Link 
        href={href} 
        className={`block group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 rounded-xl ${theme.ringFocus}`}
      >
        {content}
      </Link>
    );
  }

  return content;
}

function SkeletonCard() {
  return (
    <div
      className="flex flex-col p-6 h-full border rounded-xl bg-card shadow-sm min-h-[220px]"
      data-testid="ops-dashboard-skeleton"
    >
      <div className="flex items-start justify-between">
        <div className="w-12 h-12 rounded-2xl bg-muted animate-pulse" />
        <div className="w-16 h-12 bg-muted animate-pulse rounded-md" />
      </div>
      <div className="mt-8 flex-1">
        <div className="w-3/4 h-6 bg-muted animate-pulse rounded-md" />
        <div className="w-full h-4 bg-muted animate-pulse rounded-md mt-3" />
      </div>
    </div>
  );
}
