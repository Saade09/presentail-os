import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Settings, CheckCircle, XCircle, Clock } from "lucide-react";

interface BacklinkSettings {
  id: number;
  seo_provider: string;
  qualification_threshold: number;
  max_followups: number;
  daily_send_limit: number;
  cooling_period_days: number;
  discovery_job_cron: string;
  monitor_job_cron: string;
  updated_at: string;
}

interface JobRun {
  job_type: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  records_processed: number;
  error: string | null;
}

interface SettingsResponse {
  settings: BacklinkSettings | null;
  jobHistory: JobRun[];
}

interface OpportunitiesResponse {
  total: number;
  opportunities: unknown[];
  page: number;
  limit: number;
}

function JobStatusIcon({ status }: { status: string }) {
  if (status === "completed") return <CheckCircle className="h-4 w-4 text-green-500" />;
  if (status === "failed") return <XCircle className="h-4 w-4 text-red-500" />;
  return <Clock className="h-4 w-4 text-amber-500 animate-spin" />;
}

export default function BacklinkEngineSettings() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["backlink-engine", "settings"],
    queryFn: () => apiFetch<SettingsResponse>("/api/backlink-engine/settings"),
    staleTime: 30_000,
  });

  const settings = data?.settings;
  const jobHistory = data?.jobHistory ?? [];

  const [provider, setProvider] = useState("stub");
  const [threshold, setThreshold] = useState(70);
  const [maxFollowups, setMaxFollowups] = useState("2");
  const [dailyLimit, setDailyLimit] = useState("20");
  const [coolingDays, setCoolingDays] = useState("30");

  useEffect(() => {
    if (settings) {
      setProvider(settings.seo_provider);
      setThreshold(settings.qualification_threshold);
      setMaxFollowups(String(settings.max_followups));
      setDailyLimit(String(settings.daily_send_limit));
      setCoolingDays(String(settings.cooling_period_days));
    }
  }, [settings]);

  const { data: previewData } = useQuery({
    queryKey: ["backlink-engine", "opportunities-count", threshold],
    queryFn: () =>
      apiFetch<OpportunitiesResponse>(
        `/api/backlink-engine/opportunities?minScore=${threshold}&status=discovered&limit=1`,
      ),
    staleTime: 60_000,
  });
  const previewCount = previewData?.total ?? null;

  const updateMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch("/api/backlink-engine/settings", { method: "PUT", body: JSON.stringify(body) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["backlink-engine", "settings"] });
      toast({ title: t("backlinkEngine.settings.saved") });
    },
    onError: () => toast({ variant: "destructive", title: t("common.error") }),
  });

  function handleSave() {
    updateMutation.mutate({
      seoProvider: provider,
      qualificationThreshold: threshold,
      maxFollowups: parseInt(maxFollowups, 10),
      dailySendLimit: parseInt(dailyLimit, 10),
      coolingPeriodDays: parseInt(coolingDays, 10),
    });
  }

  if (isLoading) {
    return (
      <div className="p-6 space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-48" />
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-bold">{t("backlinkEngine.settings.title")}</h1>
        <p className="text-muted-foreground text-sm mt-1">{t("backlinkEngine.settings.subtitle")}</p>
      </div>

      {/* Settings form */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Settings className="h-5 w-5" />
            {t("backlinkEngine.settings.discoverySettings")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <Label>{t("backlinkEngine.settings.seoProvider")}</Label>
              <Select value={provider} onValueChange={setProvider}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="stub">{t("backlinkEngine.settings.providerStub")}</SelectItem>
                  <SelectItem value="dataforseo">DataForSEO</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1">{t("backlinkEngine.settings.seoProviderHint")}</p>
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <Label>{t("backlinkEngine.settings.qualificationThreshold")}</Label>
                <span className="text-sm font-semibold tabular-nums text-primary">{threshold}</span>
              </div>
              <Slider
                min={0}
                max={100}
                step={1}
                value={[threshold]}
                onValueChange={([v]) => setThreshold(v)}
                className="mt-2"
              />
              <p className="text-xs text-muted-foreground mt-2">{t("backlinkEngine.settings.thresholdHint")}</p>
              {previewCount !== null && (
                <p className="text-xs mt-1.5 font-medium text-primary">
                  {previewCount > 0
                    ? t("backlinkEngine.settings.thresholdPreview", { count: previewCount })
                    : t("backlinkEngine.settings.thresholdPreviewNone")}
                </p>
              )}
            </div>
          </div>

          <div className="border-t pt-4">
            <p className="font-medium text-sm mb-3">{t("backlinkEngine.settings.outreachSettings")}</p>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <div>
                <Label>{t("backlinkEngine.settings.maxFollowups")}</Label>
                <Input className="mt-1" type="number" min={0} max={5} value={maxFollowups} onChange={(e) => setMaxFollowups(e.target.value)} />
              </div>
              <div>
                <Label>{t("backlinkEngine.settings.dailySendLimit")}</Label>
                <Input className="mt-1" type="number" min={1} max={500} value={dailyLimit} onChange={(e) => setDailyLimit(e.target.value)} />
              </div>
              <div>
                <Label>{t("backlinkEngine.settings.coolingPeriodDays")}</Label>
                <Input className="mt-1" type="number" min={0} max={365} value={coolingDays} onChange={(e) => setCoolingDays(e.target.value)} />
              </div>
            </div>
          </div>

          <div className="flex justify-end pt-2">
            <Button onClick={handleSave} disabled={updateMutation.isPending}>
              {t("common.save")}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Job history */}
      <Card>
        <CardHeader>
          <CardTitle>{t("backlinkEngine.settings.jobHistory")}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {jobHistory.length === 0 ? (
            <p className="p-6 text-center text-muted-foreground text-sm">{t("backlinkEngine.settings.noJobHistory")}</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/40">
                  <th className="p-3 text-start font-medium">{t("backlinkEngine.settings.jobType")}</th>
                  <th className="p-3 text-start font-medium">{t("backlinkEngine.fields.status")}</th>
                  <th className="p-3 text-start font-medium hidden md:table-cell">{t("backlinkEngine.settings.processed")}</th>
                  <th className="p-3 text-start font-medium hidden md:table-cell">{t("backlinkEngine.settings.startedAt")}</th>
                </tr>
              </thead>
              <tbody>
                {jobHistory.map((job, i) => (
                  <tr key={i} className="border-b last:border-0 hover:bg-muted/20">
                    <td className="p-3 font-medium">{job.job_type}</td>
                    <td className="p-3">
                      <div className="flex items-center gap-1.5">
                        <JobStatusIcon status={job.status} />
                        <Badge variant={job.status === "completed" ? "default" : job.status === "failed" ? "destructive" : "secondary"}>
                          {job.status}
                        </Badge>
                      </div>
                      {job.error && <p className="text-xs text-red-600 mt-1 truncate max-w-[200px]">{job.error}</p>}
                    </td>
                    <td className="p-3 hidden md:table-cell">{job.records_processed.toLocaleString()}</td>
                    <td className="p-3 hidden md:table-cell text-muted-foreground text-xs">
                      {new Date(job.started_at).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
