import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  useGetStoreSeo,
  getGetStoreSeoQueryKey,
  type StoreSeoPage,
  type StoreSeoDimensionPage,
} from "@workspace/api-client-react";
import { useStoreAnalyticsFilters } from "@/hooks/use-store-analytics-filters";
import { StoreAnalyticsFilterBar } from "@/components/StoreAnalyticsFilterBar";
import { AnalyticsExportMenu } from "@/components/AnalyticsExportMenu";
import { buildFilterSummary, datasetsFromResponse } from "@/lib/analytics-export";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Search,
  MousePointerClick,
  Percent,
  Gauge,
  Users,
  DollarSign,
  Target,
  TrendingUp,
  Link2,
  ListChecks,
  AlertTriangle,
  Info,
  LayoutGrid,
  PartyPopper,
  Sparkles,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Loader2,
  ExternalLink,
  KeyRound,
  Trash2,
} from "lucide-react";

function formatUsd(n: number): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2,
  }).format(n);
}

function formatInt(n: number): string {
  return new Intl.NumberFormat().format(n);
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
    <div className="flex min-h-[160px] items-center justify-center text-center text-sm text-muted-foreground">
      {message}
    </div>
  );
}

/** Banner shown when a section has no tracking data yet. */
function WaitingState({ message }: { message: string }) {
  return (
    <div className="flex min-h-[160px] flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
      <Info size={22} className="opacity-60" />
      <span className="max-w-xs">{message}</span>
    </div>
  );
}

interface GscStatus {
  connected: boolean;
  enabled: boolean;
  siteUrl: string | null;
  syncStatus: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  credentialsSaved?: boolean;
  credentialsFromEnv?: boolean;
  credentialSource?: "workspace" | "environment" | "none";
  clientId?: string | null;
  credentialError?: string | null;
  credentialErrorCode?:
    | "credentials_unreadable"
    | "credential_storage_unavailable"
    | null;
}

const GSC_OAUTH_ERROR_CODES = new Set([
  "access_denied",
  "owner_required",
  "state_missing",
  "state_mismatch",
  "credentials_unavailable",
  "not_configured",
  "no_properties",
  "callback_failed",
  "oauth_state_failed",
]);

export function gscOauthErrorTranslationKey(code: string | undefined): string {
  return `seoAnalytics.searchConsole.oauthErrors.${
    code && GSC_OAUTH_ERROR_CODES.has(code) ? code : "callback_failed"
  }`;
}

export function gscCredentialNoticeTranslationKey(
  reauthorizationRequired: boolean,
  action: "saved" | "cleared",
): string {
  if (reauthorizationRequired) {
    return "seoAnalytics.searchConsole.reauthorizationRequired";
  }
  return action === "saved"
    ? "seoAnalytics.searchConsole.credentialsSaved"
    : "seoAnalytics.searchConsole.credentialsCleared";
}

function useGscStatus() {
  const { t } = useTranslation();
  const [status, setStatus] = useState<GscStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [savingCredentials, setSavingCredentials] = useState(false);
  const [clearingCredentials, setClearingCredentials] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [credentialNotice, setCredentialNotice] = useState<string | null>(null);

  const refetch = () => {
    fetch("/api/seo/search-console/status", { credentials: "include" })
      .then((r) => {
        if (!r.ok) throw new Error("Unable to load Search Console status");
        return r.json();
      })
      .then((d: GscStatus) => setStatus(d))
      .catch(() => {});
  };

  useEffect(() => {
    refetch();
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const connected = params.get("gsc_connected");
    const error = params.get("gsc_error");
    if (!connected && !error) return;

    params.delete("gsc_connected");
    params.delete("gsc_error");
    const query = params.toString();
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
    );

    if (connected === "1") {
      setConnectionError(null);
      setCredentialNotice(t("seoAnalytics.searchConsole.connectedSuccess"));
      refetch();
    } else if (error) {
      setConnectionError(t(gscOauthErrorTranslationKey(error)));
    }
  }, [t]);

  const connectUrl = async () => {
    setConnectionError(null);
    try {
      const response = await fetch("/api/seo/search-console/auth-url", {
        credentials: "include",
      });
      const body = await response.json().catch(() => ({})) as {
        url?: string;
        code?: string;
      };
      if (!response.ok || !body.url) {
        setConnectionError(t(gscOauthErrorTranslationKey(body.code)));
        return;
      }
      window.location.href = body.url;
    } catch {
      setConnectionError(t("seoAnalytics.searchConsole.errors.network_error"));
    }
  };

  const disconnect = () => {
    fetch("/api/seo/search-console/connection", {
      method: "DELETE",
      credentials: "include",
    })
      .then(() => refetch())
      .catch(() => {});
  };

  const syncNow = () => {
    setSyncing(true);
    fetch("/api/seo/search-console/sync", {
      method: "POST",
      credentials: "include",
    })
      .then(() => {
        setTimeout(() => {
          refetch();
          setSyncing(false);
        }, 1500);
      })
      .catch(() => setSyncing(false));
  };

  const saveCredentials = async (clientId: string, clientSecret: string): Promise<string | null> => {
    setSavingCredentials(true);
    try {
      const r = await fetch("/api/seo/search-console/credentials", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId, clientSecret }),
      });
      const body = await r.json().catch(() => ({})) as {
        code?: string;
        reauthorizationRequired?: boolean;
      };
      if (!r.ok) {
        const key = body.code && [
          "encryption_unavailable",
          "invalid_client_id",
          "invalid_client_secret",
          "save_failed",
        ].includes(body.code)
          ? body.code
          : "save_failed";
        return t(`seoAnalytics.searchConsole.errors.${key}`);
      }
      setConnectionError(null);
      setCredentialNotice(
        t(gscCredentialNoticeTranslationKey(
          body.reauthorizationRequired === true,
          "saved",
        )),
      );
      refetch();
      return null;
    } catch {
      return t("seoAnalytics.searchConsole.errors.network_error");
    } finally {
      setSavingCredentials(false);
    }
  };

  const clearCredentials = async (): Promise<string | null> => {
    setClearingCredentials(true);
    try {
      const r = await fetch("/api/seo/search-console/credentials", {
        method: "DELETE",
        credentials: "include",
      });
      const body = await r.json().catch(() => ({})) as {
        code?: string;
        reauthorizationRequired?: boolean;
      };
      if (!r.ok) {
        return t("seoAnalytics.searchConsole.errors.clear_failed");
      }
      setConnectionError(null);
      setCredentialNotice(
        t(gscCredentialNoticeTranslationKey(
          body.reauthorizationRequired === true,
          "cleared",
        )),
      );
      refetch();
      return null;
    } catch {
      return t("seoAnalytics.searchConsole.errors.network_error");
    } finally {
      setClearingCredentials(false);
    }
  };

  return {
    status,
    syncing,
    savingCredentials,
    clearingCredentials,
    connectUrl,
    disconnect,
    syncNow,
    saveCredentials,
    clearCredentials,
    connectionError,
    credentialNotice,
  };
}

export function GscCredentialsDialog({
  open,
  onOpenChange,
  existingClientId,
  hasWorkspaceOverride,
  credentialSource,
  onSave,
  onClear,
  saving,
  clearing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingClientId: string | null | undefined;
  hasWorkspaceOverride: boolean;
  credentialSource: "workspace" | "environment" | "none";
  onSave: (clientId: string, clientSecret: string) => Promise<string | null>;
  onClear: () => Promise<string | null>;
  saving: boolean;
  clearing: boolean;
}) {
  const { t } = useTranslation();
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setClientId("");
      setClientSecret("");
      setError(null);
    }
  }, [open]);

  const handleSave = async () => {
    if (!clientId.trim() || !clientSecret.trim()) {
      setError(t("seoAnalytics.searchConsole.credentialsDialog.requiredError"));
      return;
    }
    setError(null);
    const saveError = await onSave(clientId.trim(), clientSecret.trim());
    if (!saveError) {
      onOpenChange(false);
    } else {
      setError(saveError);
    }
  };

  const handleClear = async () => {
    const clearError = await onClear();
    if (!clearError) onOpenChange(false);
    else setError(clearError);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound size={18} className="text-teal-600" />
            {t("seoAnalytics.searchConsole.credentialsDialog.title")}
          </DialogTitle>
        </DialogHeader>

        {existingClientId && (
          <div className="rounded-md border border-teal-200 bg-teal-50/60 px-3 py-2 text-sm dark:border-teal-800 dark:bg-teal-950/30">
            <span className="font-medium text-teal-800 dark:text-teal-300">
              {t(`seoAnalytics.searchConsole.credentialSource.${credentialSource}`)}
            </span>
            <span className="ml-2 font-mono text-xs text-muted-foreground">
              {existingClientId}
            </span>
          </div>
        )}

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="gsc-client-id">
              {t("seoAnalytics.searchConsole.credentialsDialog.clientIdLabel")}
            </Label>
            <Input
              id="gsc-client-id"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              placeholder={existingClientId ?? t("seoAnalytics.searchConsole.credentialsDialog.clientIdPlaceholder")}
              autoComplete="off"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="gsc-client-secret">
              {t("seoAnalytics.searchConsole.credentialsDialog.clientSecretLabel")}
            </Label>
            <Input
              id="gsc-client-secret"
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder={t("seoAnalytics.searchConsole.credentialsDialog.secretPlaceholder")}
              autoComplete="new-password"
            />
          </div>
          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}
        </div>

        <DialogFooter className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between sm:gap-0">
          <div>
            {hasWorkspaceOverride && (
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={handleClear}
                disabled={clearing || saving}
              >
                {clearing ? (
                  <Loader2 size={14} className="mr-1.5 animate-spin" />
                ) : (
                  <Trash2 size={14} className="mr-1.5" />
                )}
                {t("seoAnalytics.searchConsole.credentialsDialog.clear")}
              </Button>
            )}
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving || clearing}>
              {t("seoAnalytics.searchConsole.credentialsDialog.cancel")}
            </Button>
            <Button onClick={handleSave} disabled={saving || clearing}>
              {saving && <Loader2 size={14} className="mr-1.5 animate-spin" />}
              {t("seoAnalytics.searchConsole.credentialsDialog.save")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function GscCredentialManagementCard({
  status,
  onManage,
}: {
  status: GscStatus;
  onManage: () => void;
}) {
  const { t } = useTranslation();
  const source = status.credentialSource ?? "none";

  return (
    <Card className="border-muted">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between gap-2 text-sm font-medium">
          <span className="flex items-center gap-2">
            <Info size={16} className="text-teal-600" />
            {t("seoAnalytics.searchConsole.credentialsTitle")}
          </span>
          <Button
            size="sm"
            variant={status.credentialsSaved ? "outline" : "default"}
            className="shrink-0"
            onClick={onManage}
          >
            <KeyRound size={14} className="mr-1.5" />
            {source === "none"
              ? t("seoAnalytics.searchConsole.credentialsDialog.addButton")
              : t("seoAnalytics.searchConsole.credentialsDialog.changeButton")}
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm text-muted-foreground">
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-1.5 rounded-full border border-teal-200 bg-teal-50 px-2.5 py-1 text-xs font-medium text-teal-700 dark:border-teal-800 dark:bg-teal-950 dark:text-teal-400">
            {source === "none" ? <Info size={12} /> : <CheckCircle2 size={12} />}
            {t(`seoAnalytics.searchConsole.credentialSource.${source}`)}
          </span>
          {status.clientId && (
            <span className="font-mono text-xs">
              {t("seoAnalytics.searchConsole.maskedClientId", { clientId: status.clientId })}
            </span>
          )}
        </div>
        {status.credentialErrorCode && (
          <p className="text-sm text-destructive">
            {t(`seoAnalytics.searchConsole.errors.${status.credentialErrorCode}`)}
          </p>
        )}
        <p>{t("seoAnalytics.searchConsole.setupBody")}</p>
        <div className="space-y-1.5 rounded-md border bg-muted/30 p-3">
          <p className="text-xs font-medium text-foreground">
            {t("seoAnalytics.searchConsole.setupSteps")}
          </p>
          <ol className="list-decimal space-y-1 pl-4 text-xs">
            <li>{t("seoAnalytics.searchConsole.step1")}</li>
            <li>{t("seoAnalytics.searchConsole.step2")}</li>
            <li>{t("seoAnalytics.searchConsole.step3")}</li>
            <li>{t("seoAnalytics.searchConsole.step4")}</li>
          </ol>
        </div>
        <a
          href="https://console.cloud.google.com/apis/credentials"
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs text-teal-700 hover:underline"
        >
          {t("seoAnalytics.searchConsole.openConsole")}
          <ExternalLink size={12} />
        </a>
      </CardContent>
    </Card>
  );
}

export function GscConnectionFeedback({
  error,
  notice,
}: {
  error: string | null;
  notice: string | null;
}) {
  return (
    <>
      {error && (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
        >
          {error}
        </div>
      )}
      {!error && notice && (
        <div
          role="status"
          className="rounded-md border border-teal-200 bg-teal-50 px-4 py-3 text-sm text-teal-800 dark:border-teal-800 dark:bg-teal-950/30 dark:text-teal-300"
        >
          {notice}
        </div>
      )}
    </>
  );
}

export default function SeoAnalyticsPage() {
  const { t } = useTranslation();
  const filters = useStoreAnalyticsFilters();
  const { data, isLoading, isError } = useGetStoreSeo(filters.apiParams, {
    query: {
      queryKey: getGetStoreSeoQueryKey(filters.apiParams),
      placeholderData: (prev) => prev,
    },
  });
  const gsc = useGscStatus();
  const [credentialsDialogOpen, setCredentialsDialogOpen] = useState(false);

  const seoTracked = data?.seoTracked ?? false;
  const eventsTracked = data?.eventsTracked ?? false;
  const attributionTracked = data?.attributionTracked ?? false;
  const totals = data?.totals;

  const naOrValue = (tracked: boolean, value: string): string =>
    tracked ? value : t("seoAnalytics.notAvailable");
  const numOr = (
    tracked: boolean,
    v: number | null | undefined,
    fmt: (n: number) => string,
  ): string =>
    !tracked || v == null ? t("seoAnalytics.notAvailable") : fmt(v);

  const formatPct = (n: number): string => `${n.toFixed(1)}%`;
  const formatPos = (n: number): string => n.toFixed(1);

  const issueLabel = (code: string): string => {
    const key = `seoAnalytics.issues.${code}`;
    const translated = t(key);
    return translated === key ? code : translated;
  };

  // --- Reusable page table (used by all four prioritization views). ----------
  function PageTable({
    pages,
    sortKey,
    showIssues = false,
    emptyMessage,
  }: {
    pages: StoreSeoPage[];
    sortKey: "sessions" | "revenueUsd" | "conversionRate" | "issues";
    showIssues?: boolean;
    emptyMessage: string;
  }) {
    if (pages.length === 0) {
      return <EmptyChart message={emptyMessage} />;
    }
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b text-xs text-muted-foreground">
              <th className="py-2 pr-3 text-left font-medium">
                {t("seoAnalytics.table.path")}
              </th>
              <th className="py-2 pr-3 text-right font-medium">
                {t("seoAnalytics.table.sessions")}
              </th>
              <th className="py-2 pr-3 text-right font-medium">
                {t("seoAnalytics.table.orders")}
              </th>
              <th className="py-2 pr-3 text-right font-medium">
                {t("seoAnalytics.table.revenue")}
              </th>
              <th className="py-2 pr-3 text-right font-medium">
                {t("seoAnalytics.table.conversion")}
              </th>
              <th className="py-2 pr-3 text-right font-medium">
                {t("seoAnalytics.table.impressions")}
              </th>
              <th className="py-2 pr-3 text-right font-medium">
                {t("seoAnalytics.table.ctr")}
              </th>
              <th
                className={
                  showIssues
                    ? "py-2 pr-3 text-right font-medium"
                    : "py-2 text-right font-medium"
                }
              >
                {t("seoAnalytics.table.position")}
              </th>
              {showIssues && (
                <th className="py-2 text-left font-medium">
                  {t("seoAnalytics.table.issues")}
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {pages.map((p, i) => (
              <tr
                key={p.path}
                className="border-b last:border-0 align-top hover:bg-muted/40"
                data-testid={`row-seo-${sortKey}-${i}`}
              >
                <td className="max-w-[240px] truncate py-2 pr-3 font-mono text-xs">
                  {p.path}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {formatInt(p.sessions)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">
                  {formatInt(p.orders)}
                </td>
                <td className="py-2 pr-3 text-right font-medium tabular-nums">
                  {formatUsd(p.revenueUsd)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {p.conversionRate == null ? "—" : formatPct(p.conversionRate)}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">
                  {p.impressions > 0 ? formatInt(p.impressions) : "—"}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">
                  {p.ctr == null ? "—" : formatPct(p.ctr)}
                </td>
                <td
                  className={
                    showIssues
                      ? "py-2 pr-3 text-right tabular-nums text-muted-foreground"
                      : "py-2 text-right tabular-nums text-muted-foreground"
                  }
                >
                  {p.avgPosition == null ? "—" : formatPos(p.avgPosition)}
                </td>
                {showIssues && (
                  <td className="py-2">
                    <div className="flex flex-wrap gap-1">
                      {(p.issues ?? []).map((code) => (
                        <Badge
                          key={code}
                          variant="secondary"
                          className="text-[10px] font-normal"
                        >
                          {issueLabel(code)}
                        </Badge>
                      ))}
                    </div>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  // --- Reusable catalog-dimension list (category / occasion / brand). --------
  function DimensionList({
    icon,
    title,
    rows,
  }: {
    icon: React.ReactNode;
    title: string;
    rows: StoreSeoDimensionPage[];
  }) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            {icon}
            {title}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!data ? (
            <EmptyChart message={t("seoAnalytics.noData")} />
          ) : !attributionTracked ? (
            <WaitingState message={t("seoAnalytics.attributionWaiting")} />
          ) : rows.length > 0 ? (
            <div className="space-y-1">
              <div className="flex items-center justify-between px-1 pb-2 text-xs font-medium text-muted-foreground">
                <span>{t("seoAnalytics.table.name")}</span>
                <div className="flex gap-6">
                  <span className="w-16 text-right">
                    {t("seoAnalytics.table.orders")}
                  </span>
                  <span className="w-24 text-right">
                    {t("seoAnalytics.table.revenue")}
                  </span>
                </div>
              </div>
              {rows.map((r, i) => (
                <div
                  key={r.name}
                  className="flex items-center justify-between rounded-md px-1 py-1.5 text-sm hover:bg-muted/50"
                  data-testid={`row-dim-${i}`}
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
            <EmptyChart message={t("seoAnalytics.noData")} />
          )}
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {t("seoAnalytics.title")}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t("seoAnalytics.subtitle")}
        </p>
      </div>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <StoreAnalyticsFilterBar filters={filters} />
        </div>
        <AnalyticsExportMenu
          filename="seo-analytics"
          title="SEO Analytics"
          filterSummary={buildFilterSummary(filters.apiParams)}
          getDatasets={() => datasetsFromResponse(data)}
          disabled={isLoading || !data}
        />
      </div>

      {isError && (
        <Card>
          <CardContent className="p-6 text-center text-sm text-red-500">
            {t("seoAnalytics.loadError")}
          </CardContent>
        </Card>
      )}

      <GscConnectionFeedback
        error={gsc.connectionError}
        notice={gsc.credentialNotice}
      />

      {/* Search Console connect / status panel */}
      {gsc.status && (
        gsc.status.connected ? (
          <Card className="border-teal-200 bg-teal-50/40 dark:border-teal-800 dark:bg-teal-950/20">
            <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="flex items-center gap-2">
                <CheckCircle2 size={18} className="shrink-0 text-teal-600" />
                <div>
                  <span className="font-medium text-sm">
                    {t("seoAnalytics.searchConsole.connected")}
                  </span>
                  {gsc.status.siteUrl && (
                    <span className="ml-2 font-mono text-xs text-muted-foreground">
                      {gsc.status.siteUrl}
                    </span>
                  )}
                  {gsc.status.lastSyncAt && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      &middot;{" "}
                      {t("seoAnalytics.searchConsole.lastSync")}{" "}
                      {new Date(gsc.status.lastSyncAt).toLocaleString()}
                    </span>
                  )}
                  {gsc.status.syncStatus === "syncing" && (
                    <span className="ml-2 inline-flex items-center gap-1 text-xs text-teal-600">
                      <Loader2 size={12} className="animate-spin" />
                      {t("seoAnalytics.searchConsole.syncing")}
                    </span>
                  )}
                  {gsc.status.syncStatus === "error" && gsc.status.lastError && (
                    <span className="ml-2 text-xs text-red-500">
                      {t("seoAnalytics.searchConsole.syncError")}: {gsc.status.lastError}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={gsc.syncNow}
                  disabled={gsc.syncing || gsc.status.syncStatus === "syncing"}
                >
                  {gsc.syncing ? (
                    <Loader2 size={14} className="mr-1.5 animate-spin" />
                  ) : (
                    <RefreshCw size={14} className="mr-1.5" />
                  )}
                  {t("seoAnalytics.searchConsole.syncNow")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={gsc.disconnect}
                >
                  <XCircle size={14} className="mr-1.5" />
                  {t("seoAnalytics.searchConsole.disconnect")}
                </Button>
              </div>
            </CardContent>
          </Card>
        ) : (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center gap-2 p-6 text-center">
              <Search size={26} className="text-muted-foreground opacity-70" />
              <div className="text-base font-medium">
                {t("seoAnalytics.connectTitle")}
              </div>
              <p className="max-w-md text-sm text-muted-foreground">
                {t("seoAnalytics.connectBody")}
              </p>
              {gsc.status.credentialsSaved && (
                <div className="flex items-center gap-1.5 text-xs text-teal-700 dark:text-teal-400">
                  <CheckCircle2 size={13} />
                  {t("seoAnalytics.searchConsole.credentialsDialog.savedBadge")}
                  {gsc.status.clientId && (
                    <span className="font-mono text-muted-foreground">({gsc.status.clientId})</span>
                  )}
                </div>
              )}
              {gsc.status.enabled && (
                <Button
                  size="sm"
                  className="mt-2"
                  onClick={gsc.connectUrl}
                >
                  {t("seoAnalytics.searchConsole.connectButton")}
                </Button>
              )}
            </CardContent>
          </Card>
        )
      )}
      {/* Search Console credential management */}
      {gsc.status && (
        <GscCredentialManagementCard
          status={gsc.status}
          onManage={() => setCredentialsDialogOpen(true)}
        />
      )}

      {gsc.status && (
        <GscCredentialsDialog
          open={credentialsDialogOpen}
          onOpenChange={setCredentialsDialogOpen}
          existingClientId={gsc.status.clientId}
          hasWorkspaceOverride={gsc.status.credentialsSaved ?? false}
          credentialSource={gsc.status.credentialSource ?? "none"}
          onSave={gsc.saveCredentials}
          onClear={gsc.clearCredentials}
          saving={gsc.savingCredentials}
          clearing={gsc.clearingCredentials}
        />
      )}
      {/* Fallback when GSC status hasn't loaded yet and there's no SEO data */}
      {!gsc.status && data && !seoTracked && (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center gap-2 p-6 text-center">
            <Search size={26} className="text-muted-foreground opacity-70" />
            <div className="text-base font-medium">
              {t("seoAnalytics.connectTitle")}
            </div>
            <p className="max-w-md text-sm text-muted-foreground">
              {t("seoAnalytics.connectBody")}
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
              icon={<Users size={16} />}
              label={t("seoAnalytics.kpi.organicSessions")}
              value={naOrValue(eventsTracked, formatInt(totals?.organicSessions ?? 0))}
              hint={eventsTracked ? undefined : t("seoAnalytics.eventsWaiting")}
            />
            <KpiCard
              icon={<DollarSign size={16} />}
              label={t("seoAnalytics.kpi.organicRevenue")}
              value={naOrValue(
                attributionTracked,
                formatUsd(totals?.organicRevenueUsd ?? 0),
              )}
              hint={
                attributionTracked
                  ? `${totals?.organicOrders ?? 0} ${t("seoAnalytics.kpi.orders").toLowerCase()}`
                  : t("seoAnalytics.attributionWaiting")
              }
            />
            <KpiCard
              icon={<Target size={16} />}
              label={t("seoAnalytics.kpi.organicConversion")}
              value={numOr(eventsTracked, totals?.organicConversionRate, formatPct)}
              hint={eventsTracked ? undefined : t("seoAnalytics.eventsWaiting")}
            />
            <KpiCard
              icon={<Search size={16} />}
              label={t("seoAnalytics.kpi.impressions")}
              value={naOrValue(seoTracked, formatInt(totals?.impressions ?? 0))}
              hint={seoTracked ? undefined : t("seoAnalytics.connectTitle")}
            />
            <KpiCard
              icon={<MousePointerClick size={16} />}
              label={t("seoAnalytics.kpi.clicks")}
              value={naOrValue(seoTracked, formatInt(totals?.clicks ?? 0))}
              hint={seoTracked ? undefined : t("seoAnalytics.connectTitle")}
            />
            <KpiCard
              icon={<Percent size={16} />}
              label={t("seoAnalytics.kpi.ctr")}
              value={numOr(seoTracked, totals?.ctr, formatPct)}
              hint={seoTracked ? undefined : t("seoAnalytics.connectTitle")}
            />
            <KpiCard
              icon={<Gauge size={16} />}
              label={t("seoAnalytics.kpi.avgPosition")}
              value={numOr(seoTracked, totals?.avgPosition, formatPos)}
              hint={seoTracked ? undefined : t("seoAnalytics.connectTitle")}
            />
            <KpiCard
              icon={<TrendingUp size={16} />}
              label={t("seoAnalytics.kpi.organicOrders")}
              value={naOrValue(attributionTracked, formatInt(totals?.organicOrders ?? 0))}
              hint={attributionTracked ? undefined : t("seoAnalytics.attributionWaiting")}
            />
          </>
        )}
      </div>

      {/* Catalog-dimension pages */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <DimensionList
          icon={<LayoutGrid size={16} />}
          title={t("seoAnalytics.chart.categoryPages")}
          rows={data?.categoryPages ?? []}
        />
        <DimensionList
          icon={<PartyPopper size={16} />}
          title={t("seoAnalytics.chart.occasionPages")}
          rows={data?.occasionPages ?? []}
        />
        <DimensionList
          icon={<Sparkles size={16} />}
          title={t("seoAnalytics.chart.brandPages")}
          rows={data?.brandPages ?? []}
        />
      </div>

      {/* Top search queries (from SEO metrics) */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Search size={16} />
            {t("seoAnalytics.chart.topQueries")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!data ? (
            <EmptyChart message={t("seoAnalytics.noData")} />
          ) : !seoTracked ? (
            <WaitingState message={t("seoAnalytics.connectBody")} />
          ) : data.topQueries.length > 0 ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="py-2 pr-3 text-left font-medium">
                      {t("seoAnalytics.table.query")}
                    </th>
                    <th className="py-2 pr-3 text-right font-medium">
                      {t("seoAnalytics.table.impressions")}
                    </th>
                    <th className="py-2 pr-3 text-right font-medium">
                      {t("seoAnalytics.table.clicks")}
                    </th>
                    <th className="py-2 pr-3 text-right font-medium">
                      {t("seoAnalytics.table.ctr")}
                    </th>
                    <th className="py-2 text-right font-medium">
                      {t("seoAnalytics.table.position")}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.topQueries.map((q, i) => (
                    <tr
                      key={q.query}
                      className="border-b last:border-0 hover:bg-muted/40"
                      data-testid={`row-query-${i}`}
                    >
                      <td className="max-w-[280px] truncate py-2 pr-3">
                        {q.query}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {formatInt(q.impressions)}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums text-muted-foreground">
                        {formatInt(q.clicks)}
                      </td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {q.ctr == null ? "—" : formatPct(q.ctr)}
                      </td>
                      <td className="py-2 text-right tabular-nums text-muted-foreground">
                        {q.avgPosition == null ? "—" : formatPos(q.avgPosition)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyChart message={t("seoAnalytics.table.noQueries")} />
          )}
        </CardContent>
      </Card>

      {/* Prioritization: pages by traffic */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Users size={16} />
            {t("seoAnalytics.chart.pagesByTraffic")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!data ? (
            <EmptyChart message={t("seoAnalytics.noData")} />
          ) : !eventsTracked ? (
            <WaitingState message={t("seoAnalytics.eventsWaiting")} />
          ) : (
            <PageTable
              pages={data.pagesByTraffic}
              sortKey="sessions"
              emptyMessage={t("seoAnalytics.table.noPages")}
            />
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Prioritization: pages by revenue */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <DollarSign size={16} />
              {t("seoAnalytics.chart.pagesByRevenue")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!data ? (
              <EmptyChart message={t("seoAnalytics.noData")} />
            ) : !attributionTracked ? (
              <WaitingState message={t("seoAnalytics.attributionWaiting")} />
            ) : (
              <PageTable
                pages={data.pagesByRevenue}
                sortKey="revenueUsd"
                emptyMessage={t("seoAnalytics.table.noPages")}
              />
            )}
          </CardContent>
        </Card>

        {/* Prioritization: pages by conversion */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Target size={16} />
              {t("seoAnalytics.chart.pagesByConversion")}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!data ? (
              <EmptyChart message={t("seoAnalytics.noData")} />
            ) : !eventsTracked ? (
              <WaitingState message={t("seoAnalytics.eventsWaiting")} />
            ) : (
              <PageTable
                pages={data.pagesByConversion}
                sortKey="conversionRate"
                emptyMessage={t("seoAnalytics.table.noPages")}
              />
            )}
          </CardContent>
        </Card>
      </div>

      {/* Page quality: pages needing improvement */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <AlertTriangle size={16} />
            {t("seoAnalytics.chart.pagesNeedingImprovement")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {!data ? (
            <EmptyChart message={t("seoAnalytics.noData")} />
          ) : !eventsTracked && !seoTracked ? (
            <WaitingState message={t("seoAnalytics.connectBody")} />
          ) : data.pagesNeedingImprovement.length > 0 ? (
            <PageTable
              pages={data.pagesNeedingImprovement}
              sortKey="issues"
              showIssues
              emptyMessage={t("seoAnalytics.table.noIssues")}
            />
          ) : (
            <div className="flex min-h-[120px] flex-col items-center justify-center gap-2 text-center text-sm text-muted-foreground">
              <ListChecks size={22} className="opacity-60" />
              <span>{t("seoAnalytics.table.noIssues")}</span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Content-signal availability hint. */}
      {data && !data.pageQualityTracked && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Link2 size={14} className="opacity-70" />
          {t("seoAnalytics.contentSignalsHint")}
        </p>
      )}
    </div>
  );
}
