import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListAdPlatforms,
  getListAdPlatformsQueryKey,
  useConnectAdPlatform,
  useVerifyGoogleAdsConnection,
  useSyncAdPlatform,
  useDisconnectAdPlatform,
  useRetryAdPlatformConversionFailure,
} from "@workspace/api-client-react";
import type { AdPlatformConnection } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Plug, RefreshCw, Unplug, AlertCircle, CheckCircle2 } from "lucide-react";

type Platform = "google_ads" | "meta_ads";

const META_FIELDS = ["accessToken", "adAccountId"] as const;

const SECRET_FIELDS = new Set(["accessToken"]);
const OPTIONAL_FIELDS = new Set<string>();

function extractErrorMessage(err: unknown): string | null {
  if (err && typeof err === "object") {
    const data = (err as { data?: unknown }).data;
    if (data && typeof data === "object" && typeof (data as { error?: unknown }).error === "string") {
      return (data as { error: string }).error;
    }
    if (typeof (err as { message?: unknown }).message === "string") {
      return (err as { message: string }).message;
    }
  }
  return null;
}

function PlatformRow({
  conn,
  onConnect,
}: {
  conn: AdPlatformConnection;
  onConnect: (platform: Platform) => void;
}) {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: getListAdPlatformsQueryKey() });

  const syncMutation = useSyncAdPlatform({
    mutation: {
      onSuccess: () => {
        toast({ description: t("adPlatforms.syncStarted") });
        void invalidate();
      },
      onError: (err) => {
        toast({
          variant: "destructive",
          description: extractErrorMessage(err) ?? t("adPlatforms.syncFailed"),
        });
      },
    },
  });
  const disconnectMutation = useDisconnectAdPlatform({
    mutation: {
      onSuccess: () => {
        toast({ description: t("adPlatforms.disconnected") });
        void invalidate();
      },
      onError: (err) => {
        toast({
          variant: "destructive",
          description: extractErrorMessage(err) ?? t("adPlatforms.genericError"),
        });
      },
    },
  });
  const verifyMutation = useVerifyGoogleAdsConnection({
    mutation: {
      onSuccess: () => {
        toast({ description: t("adPlatforms.connectionVerified") });
        void invalidate();
      },
      onError: (err) => {
        toast({
          variant: "destructive",
          description: extractErrorMessage(err) ?? t("adPlatforms.verificationFailed"),
        });
        void invalidate();
      },
    },
  });

  const platform = conn.platform as Platform;
  const name = t(`adPlatforms.platform.${platform}`);
  const syncing = conn.syncStatus === "syncing";
  const formatDate = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleString(i18n.language === "ar" ? "ar" : "en", { dateStyle: "medium", timeStyle: "short" }) : null;

  return (
    <div
      className="flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between"
      data-testid={`row-ad-platform-${platform}`}
    >
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{name}</span>
          {conn.connected ? (
            syncing ? (
              <Badge variant="secondary" className="gap-1">
                <Loader2 size={12} className="animate-spin" />
                {t("adPlatforms.status.syncing")}
              </Badge>
            ) : conn.syncStatus === "error" ? (
              <Badge variant="destructive" className="gap-1">
                <AlertCircle size={12} />
                {t("adPlatforms.status.error")}
              </Badge>
            ) : (
              <Badge variant="secondary" className="gap-1 text-emerald-700 dark:text-emerald-400">
                <CheckCircle2 size={12} />
                {t("adPlatforms.status.connected")}
              </Badge>
            )
          ) : (
            <Badge variant="outline">{t("adPlatforms.status.notConnected")}</Badge>
          )}
        </div>
        {platform === "google_ads" && !conn.connected && conn.missingConfigurationVariables?.length ? (
          <div className="text-xs text-muted-foreground" data-testid="google-ads-missing-configuration">
            {t("adPlatforms.configurationRequired")}:{" "}
            {conn.missingConfigurationVariables.join(", ")}
          </div>
        ) : conn.connected && (
          <div className="text-xs text-muted-foreground">
            {platform === "google_ads" && conn.customerId && (
              <span>{t("adPlatforms.customerId", { id: conn.customerId })}</span>
            )}
            {(conn.accountName ?? conn.accountLabel) && (
              <span>
                {platform === "google_ads" && conn.customerId ? " · " : ""}
                {conn.accountName ?? conn.accountLabel}
              </span>
            )}
            {platform === "google_ads" && conn.accountTimeZone && (
              <span>{" · "}{t("adPlatforms.timezone", { timezone: conn.accountTimeZone })}</span>
            )}
            {platform === "google_ads" && conn.accountCurrency && (
              <span>{" · "}{t("adPlatforms.currency", { currency: conn.accountCurrency })}</span>
            )}
            {conn.lastSyncAt && (
              <span>
                {" · "}
                {t("adPlatforms.lastSync", { date: formatDate(conn.lastSyncAt) })}
              </span>
            )}
            {conn.entryCount > 0 && (
              <span>
                {" · "}
                {t("adPlatforms.entryCount", { count: conn.entryCount })}
                {conn.latestDataDate ? ` (${t("adPlatforms.latestData", { date: conn.latestDataDate })})` : ""}
              </span>
            )}
          </div>
        )}
        {conn.connected && conn.syncStatus === "error" && conn.lastError && (
          <p className="text-xs text-destructive" data-testid={`text-sync-error-${platform}`}>
            {conn.lastError}
          </p>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {conn.connected ? (
          <>
            {platform === "google_ads" && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => verifyMutation.mutate()}
                disabled={syncing || verifyMutation.isPending}
                data-testid="button-test-google-ads"
              >
                {verifyMutation.isPending && (
                  <Loader2 size={14} className="me-1 animate-spin" />
                )}
                {t("adPlatforms.testConnection")}
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={syncing || syncMutation.isPending}
              onClick={() => syncMutation.mutate({ platform })}
              data-testid={`button-sync-${platform}`}
            >
              {syncing || syncMutation.isPending ? (
                <Loader2 size={14} className="me-1 animate-spin" />
              ) : (
                <RefreshCw size={14} className="me-1" />
              )}
              {t("adPlatforms.syncNow")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={disconnectMutation.isPending}
              onClick={() => {
                if (window.confirm(t("adPlatforms.disconnectConfirm", { platform: name }))) {
                  disconnectMutation.mutate({ platform });
                }
              }}
              data-testid={`button-disconnect-${platform}`}
            >
              <Unplug size={14} className="me-1" />
              {t("adPlatforms.disconnect")}
            </Button>
          </>
        ) : platform === "google_ads" ? (
          <Button
            size="sm"
            onClick={() => verifyMutation.mutate()}
            disabled={verifyMutation.isPending}
            data-testid="button-test-google-ads"
          >
            {verifyMutation.isPending && <Loader2 size={14} className="me-1 animate-spin" />}
            {t("adPlatforms.testConnection")}
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={() => onConnect(platform)}
            data-testid={`button-connect-${platform}`}
          >
            <Plug size={14} className="me-1" />
            {t("adPlatforms.connect")}
          </Button>
        )}
      </div>
    </div>
  );
}

export function AdPlatformsSection() {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading } = useListAdPlatforms({
    query: {
      queryKey: getListAdPlatformsQueryKey(),
      // Poll while any platform is mid-sync so backfill progress surfaces.
      refetchInterval: (query) =>
        query.state.data?.connections.some((c) => c.syncStatus === "syncing")
          ? 5000
          : false,
    },
  });

  const [dialogPlatform, setDialogPlatform] = useState<Platform | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const connectMutation = useConnectAdPlatform({
    mutation: {
      onSuccess: () => {
        toast({ description: t("adPlatforms.connectedToast") });
        setDialogPlatform(null);
        setForm({});
        setFormError(null);
        void queryClient.invalidateQueries({ queryKey: getListAdPlatformsQueryKey() });
      },
      onError: (err) => {
        setFormError(extractErrorMessage(err) ?? t("adPlatforms.genericError"));
      },
    },
  });
  const retryConversionMutation = useRetryAdPlatformConversionFailure({
    mutation: {
      onSuccess: () => {
        toast({ description: t("adPlatforms.conversionFailures.retryQueued") });
        void queryClient.invalidateQueries({ queryKey: getListAdPlatformsQueryKey() });
      },
      onError: (err) => {
        toast({
          variant: "destructive",
          description:
            extractErrorMessage(err) ?? t("adPlatforms.conversionFailures.retryFailed"),
        });
      },
    },
  });

  const fields = META_FIELDS;
  const missingRequired =
    dialogPlatform !== null &&
    fields.some((f) => !OPTIONAL_FIELDS.has(f) && !(form[f] ?? "").trim());

  const submit = () => {
    // Google Ads is server-owned and can only be verified from this UI. The
    // credential connect endpoint intentionally accepts Meta Ads only.
    if (dialogPlatform !== "meta_ads" || missingRequired) return;
    setFormError(null);
    const payload: Record<string, string> = {};
    for (const f of fields) {
      const v = (form[f] ?? "").trim();
      if (v) payload[f] = v;
    }
    connectMutation.mutate({
      platform: dialogPlatform,
      data: payload as never,
    });
  };

  return (
    <Card data-testid="card-ad-platforms" id="ad-platforms">
      <CardHeader>
        <CardTitle className="text-base">{t("adPlatforms.title")}</CardTitle>
        <CardDescription>{t("adPlatforms.subtitle")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {data?.conversionFailures.total ? (
          <Alert
            variant="destructive"
            data-testid="alert-paid-link-conversion-failures"
          >
            <AlertCircle size={16} />
            <AlertTitle>
              {t("adPlatforms.conversionFailures.title", {
                count: data.conversionFailures.total,
              })}
            </AlertTitle>
            <AlertDescription className="space-y-3">
              <p>{t("adPlatforms.conversionFailures.description")}</p>
              {data.conversionFailures.markets.map((market) => (
                <div
                  key={market.countryCode ?? market.marketName}
                  className="rounded-md border border-destructive/30 bg-background/70 p-3"
                  data-testid={`paid-link-conversion-market-${market.countryCode ?? "unknown"}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-foreground">{market.marketName}</span>
                    <Badge variant="destructive">
                      {t("adPlatforms.conversionFailures.failedCount", {
                        count: market.failedCount,
                      })}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("adPlatforms.conversionFailures.latestFailure", {
                      date: new Date(market.latestFailedAt).toLocaleString(
                        i18n.language === "ar" ? "ar" : "en",
                        { dateStyle: "medium", timeStyle: "short" },
                      ),
                    })}
                  </p>
                  <div className="mt-3 space-y-2">
                    {market.failures.map((failure) => {
                      const retrying =
                        retryConversionMutation.isPending &&
                        retryConversionMutation.variables?.id === failure.id;
                      return (
                        <div
                          key={failure.id}
                          className="flex flex-col gap-2 rounded-md bg-muted/50 p-2 sm:flex-row sm:items-center sm:justify-between"
                          data-testid={`paid-link-conversion-failure-${failure.id}`}
                        >
                          <div className="min-w-0">
                            <p className="text-sm text-foreground">{failure.reason}</p>
                            <p className="text-xs text-muted-foreground">
                              {t("adPlatforms.conversionFailures.attempts", {
                                count: failure.attemptCount,
                              })}
                            </p>
                          </div>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={retryConversionMutation.isPending}
                            onClick={() =>
                              retryConversionMutation.mutate({ id: failure.id })
                            }
                            data-testid={`button-retry-paid-link-conversion-${failure.id}`}
                          >
                            {retrying ? (
                              <Loader2 size={14} className="me-1 animate-spin" />
                            ) : (
                              <RefreshCw size={14} className="me-1" />
                            )}
                            {t("adPlatforms.conversionFailures.retry")}
                          </Button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </AlertDescription>
          </Alert>
        ) : null}
        {isLoading || !data ? (
          <div className="flex items-center gap-2 p-2 text-sm text-muted-foreground">
            <Loader2 size={14} className="animate-spin" /> {t("adPlatforms.loading")}
          </div>
        ) : (
          data.connections.map((conn) => (
            <PlatformRow key={conn.platform} conn={conn} onConnect={setDialogPlatform} />
          ))
        )}
        <p className="text-xs text-muted-foreground">{t("adPlatforms.precedenceNote")}</p>
      </CardContent>

      <Dialog
        open={dialogPlatform !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDialogPlatform(null);
            setForm({});
            setFormError(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {t("adPlatforms.connectTitle", {
                platform: dialogPlatform ? t(`adPlatforms.platform.${dialogPlatform}`) : "",
              })}
            </DialogTitle>
            <DialogDescription>
              {dialogPlatform ? t(`adPlatforms.connectHelp.${dialogPlatform}`) : null}
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[50vh] space-y-3 overflow-y-auto py-1">
            {dialogPlatform &&
              fields.map((f) => (
                <div key={f} className="space-y-1">
                  <Label htmlFor={`ad-platform-${f}`}>
                    {t(`adPlatforms.fields.${f}`)}
                    {OPTIONAL_FIELDS.has(f) && (
                      <span className="ms-1 text-xs text-muted-foreground">
                        ({t("adPlatforms.optional")})
                      </span>
                    )}
                  </Label>
                  <Input
                    id={`ad-platform-${f}`}
                    type={SECRET_FIELDS.has(f) ? "password" : "text"}
                    autoComplete="off"
                    value={form[f] ?? ""}
                    onChange={(e) => setForm((prev) => ({ ...prev, [f]: e.target.value }))}
                    data-testid={`input-${f}`}
                  />
                </div>
              ))}
            {formError && (
              <p className="text-sm text-destructive" data-testid="text-connect-error">
                {formError}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDialogPlatform(null)}
              disabled={connectMutation.isPending}
            >
              {t("adPlatforms.cancel")}
            </Button>
            <Button
              onClick={submit}
              disabled={missingRequired || connectMutation.isPending}
              data-testid="button-submit-connect"
            >
              {connectMutation.isPending && <Loader2 size={14} className="me-1 animate-spin" />}
              {t("adPlatforms.connectSubmit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
