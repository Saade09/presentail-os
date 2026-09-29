import { useTranslation } from "react-i18next";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Link2, Search, TrendingUp, AlertTriangle, Plus, Settings } from "lucide-react";
import { BacklinkEngineReportsContent } from "./BacklinkEngineReports";

interface OverviewData {
  kpi: {
    totalOpportunities: number;
    qualified: number;
    outreachSent: number;
    backlinksWon: number;
    lostLinks: number;
  };
  topOpportunities: Array<{
    id: number;
    domain: string;
    page_url: string;
    opportunity_type: string | null;
    market: string;
    ai_score: string | null;
    status: string;
    last_activity_at: string | null;
  }>;
  backlinksWonTrend: Array<{ week: string; won: number }>;
}

function useBacklinkOverview() {
  return useQuery({
    queryKey: ["backlink-engine", "overview"],
    queryFn: () => apiFetch<OverviewData>("/api/backlink-engine/overview"),
    staleTime: 60_000,
  });
}

function KpiCard({ label, value, icon: Icon, color }: { label: string; value: number; icon: React.ElementType; color: string }) {
  return (
    <Card>
      <CardContent className="flex items-center gap-4 p-6">
        <div className={`rounded-lg p-3 ${color}`}>
          <Icon className="h-5 w-5 text-white" />
        </div>
        <div>
          <p className="text-2xl font-bold">{value.toLocaleString()}</p>
          <p className="text-sm text-muted-foreground">{label}</p>
        </div>
      </CardContent>
    </Card>
  );
}

export default function BacklinkEngineOverview() {
  const { t } = useTranslation();
  const { data, isLoading } = useBacklinkOverview();

  const kpi = data?.kpi;
  const opportunities = data?.topOpportunities ?? [];

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t("backlinkEngine.overview.title")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("backlinkEngine.overview.subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" asChild>
            <Link href="/backlink-engine/settings">
              <Settings className="h-4 w-4 me-2" />
              {t("backlinkEngine.settings.title")}
            </Link>
          </Button>
          <Button asChild>
            <Link href="/backlink-engine/opportunities">
              <Plus className="h-4 w-4 me-2" />
              {t("backlinkEngine.overview.addOpportunity")}
            </Link>
          </Button>
        </div>
      </div>

      <Tabs defaultValue="overview">
        <TabsList>
          <TabsTrigger value="overview">{t("backlinkEngine.overview.title")}</TabsTrigger>
          <TabsTrigger value="reports">{t("backlinkEngine.reports.title")}</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-6 space-y-6">
          {/* KPI Cards */}
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-24" />)
            ) : (
              <>
                <KpiCard label={t("backlinkEngine.kpi.totalOpportunities")} value={kpi?.totalOpportunities ?? 0} icon={Search} color="bg-blue-500" />
                <KpiCard label={t("backlinkEngine.kpi.qualified")} value={kpi?.qualified ?? 0} icon={TrendingUp} color="bg-teal-500" />
                <KpiCard label={t("backlinkEngine.kpi.outreachSent")} value={kpi?.outreachSent ?? 0} icon={Link2} color="bg-purple-500" />
                <KpiCard label={t("backlinkEngine.kpi.backlinksWon")} value={kpi?.backlinksWon ?? 0} icon={Link2} color="bg-green-500" />
                <KpiCard label={t("backlinkEngine.kpi.lostLinks")} value={kpi?.lostLinks ?? 0} icon={AlertTriangle} color="bg-red-500" />
              </>
            )}
          </div>

          {/* Top Opportunities */}
          <Card>
            <CardHeader className="flex-row items-center justify-between">
              <CardTitle>{t("backlinkEngine.overview.topOpportunities")}</CardTitle>
              <Button variant="ghost" size="sm" asChild>
                <Link href="/backlink-engine/opportunities">{t("common.viewAll")}</Link>
              </Button>
            </CardHeader>
            <CardContent className="p-0">
              {isLoading ? (
                <div className="p-6 space-y-3">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-10" />)}</div>
              ) : opportunities.length === 0 ? (
                <p className="p-6 text-center text-muted-foreground text-sm">{t("backlinkEngine.overview.noOpportunities")}</p>
              ) : (
                <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40">
                  <th className="p-3 text-start font-medium">{t("backlinkEngine.fields.domain")}</th>
                  <th className="p-3 text-start font-medium hidden md:table-cell">{t("backlinkEngine.fields.market")}</th>
                  <th className="p-3 text-start font-medium">{t("backlinkEngine.fields.aiScore")}</th>
                  <th className="p-3 text-start font-medium">{t("backlinkEngine.fields.status")}</th>
                </tr>
              </thead>
              <tbody>
                {opportunities.map((opp) => (
                  <tr key={opp.id} className="border-b last:border-0 hover:bg-muted/20">
                    <td className="p-3">
                      <Link href={`/backlink-engine/opportunities`} className="font-medium hover:underline">{opp.domain}</Link>
                      <p className="text-xs text-muted-foreground truncate max-w-xs">{opp.page_url}</p>
                    </td>
                    <td className="p-3 hidden md:table-cell">
                      <Badge variant="outline">{opp.market.toUpperCase()}</Badge>
                    </td>
                    <td className="p-3">
                      {opp.ai_score ? (
                        <span className={`font-bold ${parseFloat(opp.ai_score) >= 70 ? "text-green-600" : parseFloat(opp.ai_score) >= 40 ? "text-amber-600" : "text-muted-foreground"}`}>
                          {parseFloat(opp.ai_score).toFixed(0)}
                        </span>
                      ) : "—"}
                    </td>
                    <td className="p-3">
                      <Badge variant={opp.status === "qualified" || opp.status === "approved" ? "default" : "secondary"}>
                        {t(`backlinkEngine.status.${opp.status}`, { defaultValue: opp.status })}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
                </table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="reports" className="mt-6">
          <BacklinkEngineReportsContent />
        </TabsContent>
      </Tabs>
    </div>
  );
}
