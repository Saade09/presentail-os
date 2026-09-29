import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { FlaskConical, ChevronDown, ChevronUp, CheckCircle2, XCircle, Clock, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { formatDistanceToNow, format } from "date-fns";

type CheckResult = {
  name: string;
  passed: boolean;
  reason?: string;
};

type SmokeTestRun = {
  id: number;
  ran_at: string;
  base_url: string;
  passed: boolean;
  total: number;
  passed_count: number;
  failed_count: number;
  checks: CheckResult[] | unknown;
  duration_ms: number | null;
};

function parseChecks(checks: unknown): CheckResult[] {
  if (Array.isArray(checks)) return checks as CheckResult[];
  if (typeof checks === "string") {
    try {
      const parsed = JSON.parse(checks);
      if (Array.isArray(parsed)) return parsed as CheckResult[];
    } catch {
      return [];
    }
  }
  return [];
}

function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function RunRow({ run }: { run: SmokeTestRun }) {
  const [expanded, setExpanded] = useState(false);
  const { t } = useTranslation();
  const checks = parseChecks(run.checks);

  return (
    <>
      <TableRow
        className="cursor-pointer hover:bg-muted/50"
        onClick={() => setExpanded((prev) => !prev)}
      >
        <TableCell className="font-mono text-xs text-muted-foreground whitespace-nowrap">
          <span title={format(new Date(run.ran_at), "PPpp")}>
            {formatDistanceToNow(new Date(run.ran_at), { addSuffix: true })}
          </span>
        </TableCell>
        <TableCell className="font-mono text-xs max-w-[200px] truncate" title={run.base_url}>
          {run.base_url}
        </TableCell>
        <TableCell>
          {run.passed ? (
            <Badge variant="default" className="bg-green-600 hover:bg-green-700 gap-1">
              <CheckCircle2 className="size-3" />
              {t("smokeTests.pass")}
            </Badge>
          ) : (
            <Badge variant="destructive" className="gap-1">
              <XCircle className="size-3" />
              {t("smokeTests.fail")}
            </Badge>
          )}
        </TableCell>
        <TableCell className="text-sm tabular-nums">
          <span className="text-green-600 font-medium">{run.passed_count}</span>
          <span className="text-muted-foreground mx-1">/</span>
          <span className="font-medium">{run.total}</span>
          {run.failed_count > 0 && (
            <span className="text-destructive ml-1">({run.failed_count} {t("smokeTests.failed")})</span>
          )}
        </TableCell>
        <TableCell className="text-sm tabular-nums text-muted-foreground">
          <Clock className="size-3 inline mr-1" />
          {formatDuration(run.duration_ms)}
        </TableCell>
        <TableCell className="text-right">
          <Button variant="ghost" size="icon" className="size-6" onClick={(e) => { e.stopPropagation(); setExpanded((prev) => !prev); }}>
            {expanded ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
          </Button>
        </TableCell>
      </TableRow>
      {expanded && checks.length > 0 && (
        <TableRow>
          <TableCell colSpan={6} className="bg-muted/30 py-0">
            <div className="py-3 px-2">
              <p className="text-xs font-semibold text-muted-foreground mb-2 uppercase tracking-wide">
                {t("smokeTests.checkDetails")}
              </p>
              <div className="space-y-1">
                {checks.map((check, idx) => (
                  <div key={idx} className="flex items-start gap-2 text-sm">
                    {check.passed ? (
                      <CheckCircle2 className="size-4 text-green-600 mt-0.5 shrink-0" />
                    ) : (
                      <XCircle className="size-4 text-destructive mt-0.5 shrink-0" />
                    )}
                    <div>
                      <span className="font-medium">{check.name}</span>
                      {!check.passed && check.reason && (
                        <p className="text-xs text-muted-foreground mt-0.5 font-mono">{check.reason}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

export default function SmokeTestRunsPage() {
  const { t } = useTranslation();

  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ["smoke-test-runs"],
    queryFn: () =>
      apiFetch<{ success: boolean; runs: SmokeTestRun[] }>("/api/smoke-test-runs?limit=100"),
  });

  const runs = data?.runs ?? [];
  const totalRuns = runs.length;
  const failedRuns = runs.filter((r) => !r.passed).length;
  const passRate = totalRuns > 0 ? Math.round(((totalRuns - failedRuns) / totalRuns) * 100) : null;

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <FlaskConical className="size-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold">{t("smokeTests.title")}</h1>
            <p className="text-sm text-muted-foreground">{t("smokeTests.subtitle")}</p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching} className="gap-2">
          <RefreshCw className={`size-4 ${isFetching ? "animate-spin" : ""}`} />
          {t("smokeTests.refresh")}
        </Button>
      </div>

      {totalRuns > 0 && (
        <div className="grid grid-cols-3 gap-4">
          <Card>
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-medium text-muted-foreground">{t("smokeTests.totalRuns")}</CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <p className="text-2xl font-bold">{totalRuns}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-medium text-muted-foreground">{t("smokeTests.passRate")}</CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <p className={`text-2xl font-bold ${passRate !== null && passRate < 100 ? "text-destructive" : "text-green-600"}`}>
                {passRate !== null ? `${passRate}%` : "—"}
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2 pt-4 px-4">
              <CardTitle className="text-sm font-medium text-muted-foreground">{t("smokeTests.failedRuns")}</CardTitle>
            </CardHeader>
            <CardContent className="px-4 pb-4">
              <p className={`text-2xl font-bold ${failedRuns > 0 ? "text-destructive" : ""}`}>
                {failedRuns}
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex justify-center items-center py-16">
              <Spinner className="size-6 text-primary" />
            </div>
          ) : isError ? (
            <div className="flex flex-col items-center py-16 gap-3 text-muted-foreground">
              <XCircle className="size-8 text-destructive" />
              <p>{t("smokeTests.loadError")}</p>
              <Button variant="outline" size="sm" onClick={() => refetch()}>
                {t("smokeTests.retry")}
              </Button>
            </div>
          ) : runs.length === 0 ? (
            <div className="flex flex-col items-center py-16 gap-3 text-muted-foreground">
              <FlaskConical className="size-8" />
              <p className="font-medium">{t("smokeTests.noRuns")}</p>
              <p className="text-sm text-center max-w-sm">{t("smokeTests.noRunsHint")}</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("smokeTests.col.ranAt")}</TableHead>
                  <TableHead>{t("smokeTests.col.baseUrl")}</TableHead>
                  <TableHead>{t("smokeTests.col.status")}</TableHead>
                  <TableHead>{t("smokeTests.col.checks")}</TableHead>
                  <TableHead>{t("smokeTests.col.duration")}</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((run) => (
                  <RunRow key={run.id} run={run} />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
