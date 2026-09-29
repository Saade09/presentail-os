import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { Download } from "lucide-react";

interface FunnelRow { status: string; count: number; }
interface OverviewReport {
  funnel: FunnelRow[];
  avgDaysDiscoveryToLive: number | null;
}

interface LinksReport {
  linksByWeek: Array<{ week: string; new_domains: string; lost_domains: string }>;
}

const FUNNEL_COLORS: Record<string, string> = {
  discovered: "#94a3b8",
  qualified: "#3b82f6",
  approved: "#8b5cf6",
  rejected: "#ef4444",
};

export function BacklinkEngineReportsContent({ showHeader = false }: { showHeader?: boolean }) {
  const { t } = useTranslation();

  const { data: overviewData, isLoading: loadingOverview } = useQuery({
    queryKey: ["backlink-engine", "reports", "overview"],
    queryFn: () => apiFetch<OverviewReport>("/api/backlink-engine/reports/overview"),
    staleTime: 60_000,
  });

  const { data: linksData, isLoading: loadingLinks } = useQuery({
    queryKey: ["backlink-engine", "reports", "links"],
    queryFn: () => apiFetch<LinksReport>("/api/backlink-engine/reports/links"),
    staleTime: 60_000,
  });

  const funnel = overviewData?.funnel ?? [];
  const linksByWeek = (linksData?.linksByWeek ?? []).map((r) => ({
    week: new Date(r.week).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    won: parseInt(r.new_domains, 10),
    lost: parseInt(r.lost_domains, 10),
  }));

  function handleExport() {
    window.open("/api/backlink-engine/reports/export/opportunities", "_blank");
  }

  return (
    <div className="space-y-6">
      {showHeader && (
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">{t("backlinkEngine.reports.title")}</h1>
            <p className="text-muted-foreground text-sm mt-1">{t("backlinkEngine.reports.subtitle")}</p>
          </div>
          <Button variant="outline" onClick={handleExport}>
            <Download className="h-4 w-4 me-2" />
            {t("backlinkEngine.reports.exportOpportunities")}
          </Button>
        </div>
      )}

      {!showHeader && (
        <div className="flex items-center justify-between gap-4">
          <p className="text-muted-foreground text-sm">{t("backlinkEngine.reports.subtitle")}</p>
          <Button variant="outline" onClick={handleExport}>
            <Download className="h-4 w-4 me-2" />
            {t("backlinkEngine.reports.exportOpportunities")}
          </Button>
        </div>
      )}

      {/* Avg days to conversion */}
      {overviewData && (
        <Card>
          <CardContent className="flex items-center gap-4 p-6">
            <div>
              <p className="text-3xl font-bold">
                {overviewData.avgDaysDiscoveryToLive !== null ? `${overviewData.avgDaysDiscoveryToLive.toFixed(0)}d` : "—"}
              </p>
              <p className="text-sm text-muted-foreground">{t("backlinkEngine.reports.avgDaysToLive")}</p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Funnel */}
      <Card>
        <CardHeader>
          <CardTitle>{t("backlinkEngine.reports.opportunityFunnel")}</CardTitle>
        </CardHeader>
        <CardContent>
          {loadingOverview ? (
            <Skeleton className="h-48" />
          ) : funnel.length === 0 ? (
            <p className="text-center text-muted-foreground text-sm py-8">{t("backlinkEngine.reports.noData")}</p>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={funnel} layout="vertical" margin={{ left: 10, right: 30 }}>
                <XAxis type="number" />
                <YAxis type="category" dataKey="status" width={90} tick={{ fontSize: 12 }} />
                <Tooltip />
                <Bar dataKey="count" radius={4}>
                  {funnel.map((entry) => (
                    <Cell key={entry.status} fill={FUNNEL_COLORS[entry.status] ?? "#64748b"} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* Links won/lost by week */}
      <Card>
        <CardHeader>
          <CardTitle>{t("backlinkEngine.reports.linksOverTime")}</CardTitle>
        </CardHeader>
        <CardContent>
          {loadingLinks ? (
            <Skeleton className="h-48" />
          ) : linksByWeek.length === 0 ? (
            <p className="text-center text-muted-foreground text-sm py-8">{t("backlinkEngine.reports.noData")}</p>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={linksByWeek}>
                <XAxis dataKey="week" tick={{ fontSize: 11 }} />
                <YAxis />
                <Tooltip />
                <Bar dataKey="won" name={t("backlinkEngine.monitor.live")} fill="#22c55e" radius={[4, 4, 0, 0]} />
                <Bar dataKey="lost" name={t("backlinkEngine.monitor.lost")} fill="#ef4444" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default function BacklinkEngineReports() {
  return (
    <div className="p-6">
      <BacklinkEngineReportsContent showHeader />
    </div>
  );
}
