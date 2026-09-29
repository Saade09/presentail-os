import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { useLocation } from "wouter";
import {
  MapPin,
  Loader2,
  Search,
  Clock,
  AlertTriangle,
  CheckCircle2,
  CalendarClock,
  Phone,
  Send,
  ShieldCheck,
  MessageSquare,
  XCircle,
  Info,
  History,
  ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { apiFetch } from "@/lib/queryClient";
import { AddressCollectorOrderLabel } from "@/components/AddressCollectorOrderLabel";

type TabKey = "active" | "scheduled" | "waiting" | "attention" | "closed";

type Kpis = {
  awaiting: number;
  scheduled: number;
  atRisk: number;
  collectedAutomatically: number;
};

type RequestRow = {
  id: string;
  order_id: number | string | null;
  order_number: string | null;
  source: string;
  respondio_contact_id: string | null;
  respondio_profile_url: string | null;
  recipient_name: string | null;
  recipient_phone: string | null;
  preferred_language: "en" | "ar" | null;
  status: string;
  risk_level: string | null;
  window_start: string | null;
  window_end: string | null;
  delivery_timezone: string | null;
  last_contact_at: string | null;
  last_contact_channel: string | null;
  address_received_at: string | null;
  link_first_opened_at: string | null;
  created_at: string | null;
  next_action_at: string | null;
  next_action_type: string | null;
  messages_sent: number | null;
  outreach_step: string | null;
  provider_status: string | null;
  template_sent_at: string | null;
  resolution_outcome: string | null;
  closure_reason: string | null;
  closure_source: string | null;
  closed_at: string | null;
  outcome_label: string | null;
};

type ListResponse = {
  kpis: Kpis;
  requests: RequestRow[];
  total: number;
};

type DetailEvent = {
  id: number;
  event_type: string;
  previous_state: string | null;
  new_state: string | null;
  actor: string | null;
  channel: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
};

type DetailAction = {
  id: number;
  action_type: string;
  channel: string | null;
  scheduled_at: string | null;
  status: string | null;
  attempt_count: number | null;
  triggering_rule: string | null;
  provider_status: string | null;
  sent_at: string | null;
  error_code: string | null;
  error_message: string | null;
};

type DetailResponse = {
  request: RequestRow & {
    recipient_phone: string | null;
    submitted_address: Record<string, unknown> | string | null;
    submitted_lat: number | null;
    submitted_lng: number | null;
    token_expires_at: string | null;
    address_deadline: string | null;
    compliance_state: string | null;
    sms_opt_out: boolean | null;
    processing_started_at: string | null;
    inbound_reply_type: string | null;
    inbound_reply_text: string | null;
    inbound_lat: number | null;
    inbound_lng: number | null;
    inbound_classifier: Record<string, unknown> | null;
    inbound_confidence: number | null;
    inbound_outcome: string | null;
    inbound_error: string | null;
  };
  events: DetailEvent[];
  actions: DetailAction[];
};

const STATUS_BADGE: Record<string, string> = {
  awaiting_address: "bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30",
  processing: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-400 border-indigo-500/30",
  resolved: "bg-green-500/15 text-green-700 dark:text-green-400 border-green-500/30",
  failed: "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30",
  scheduled: "bg-slate-500/15 text-slate-700 dark:text-slate-400 border-slate-500/30",
  whatsapp_queued: "bg-slate-500/15 text-slate-700 dark:text-slate-400 border-slate-500/30",
  whatsapp_sent: "bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30",
  whatsapp_delivered: "bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30",
  whatsapp_failed: "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30",
  sms_fallback_sent: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30",
  link_opened: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-400 border-indigo-500/30",
  in_progress: "bg-indigo-500/15 text-indigo-700 dark:text-indigo-400 border-indigo-500/30",
  address_received: "bg-green-500/15 text-green-700 dark:text-green-400 border-green-500/30",
  verified: "bg-green-500/15 text-green-700 dark:text-green-400 border-green-500/30",
  needs_review: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30",
  escalated: "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30",
  expired: "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30",
  cancelled: "bg-slate-500/15 text-slate-700 dark:text-slate-400 border-slate-500/30",
};

function useLocale() {
  const { i18n } = useTranslation();
  return i18n.language === "ar" ? "ar" : "en";
}

function formatWindow(
  start: string | null,
  end: string | null,
  tz: string | null,
  locale: string,
): string {
  if (!start) return "—";
  try {
    const opts: Intl.DateTimeFormatOptions = {
      hour: "numeric",
      minute: "2-digit",
      timeZone: tz || undefined,
    };
    const dateOpts: Intl.DateTimeFormatOptions = {
      month: "short",
      day: "numeric",
      timeZone: tz || undefined,
    };
    const d = new Date(start).toLocaleDateString(locale, dateOpts);
    const s = new Date(start).toLocaleTimeString(locale, opts);
    if (!end) return `${d}, ${s}`;
    const e = new Date(end).toLocaleTimeString(locale, opts);
    return `${d}, ${s} – ${e}`;
  } catch {
    return "—";
  }
}

function relativeTime(
  iso: string | null,
  locale: string,
  t: (k: string) => string,
): string {
  if (!iso) return t("addressCollector.never");
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "—";
  const diffMs = then - Date.now();
  const abs = Math.abs(diffMs);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const min = Math.round(diffMs / 60000);
  const hr = Math.round(diffMs / 3600000);
  const day = Math.round(diffMs / 86400000);
  if (abs < 3600000) return rtf.format(min, "minute");
  if (abs < 86400000) return rtf.format(hr, "hour");
  return rtf.format(day, "day");
}

function LangBadge({ lang }: { lang: "en" | "ar" | null }) {
  const label = lang === "ar" ? "AR" : "EN";
  return (
    <span className="inline-flex items-center rounded border border-border px-1 text-[10px] font-medium text-muted-foreground">
      {label}
    </span>
  );
}

function EventIcon({ type }: { type: string }) {
  if (type.includes("whatsapp")) return <MessageSquare size={14} className="text-blue-600" />;
  if (type.includes("sms")) return <Send size={14} className="text-amber-600" />;
  if (type.includes("fail") || type.includes("error") || type.includes("escalat"))
    return <AlertTriangle size={14} className="text-red-600" />;
  if (type.includes("verified") || type.includes("received"))
    return <CheckCircle2 size={14} className="text-green-600" />;
  if (type.includes("open")) return <ShieldCheck size={14} className="text-indigo-600" />;
  return <History size={14} className="text-muted-foreground" />;
}

function actionLabel(type: string | null, t: TFunction): string {
  if (!type) return "—";
  return t(`addressCollector.action.${type}`, type.replaceAll("_", " "));
}

function KpiCard({
  icon,
  label,
  value,
  tone,
  testId,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  tone: string;
  testId: string;
}) {
  return (
    <Card data-testid={testId}>
      <CardContent className="flex items-center gap-3 p-4">
        <div className={`flex h-9 w-9 items-center justify-center rounded-lg ${tone}`}>{icon}</div>
        <div>
          <p className="text-2xl font-bold leading-none text-foreground">{value}</p>
          <p className="text-xs text-muted-foreground mt-1">{label}</p>
        </div>
      </CardContent>
    </Card>
  );
}

export default function AddressCollectorPage() {
  const { t } = useTranslation();
  const locale = useLocale();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [location, navigate] = useLocation();

  const [tab, setTab] = useState<TabKey>("active");
  const [q, setQ] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    // Wouter's location hook tracks the pathname only in this app, so read
    // the browser search string separately for a direct collector deep link.
    const requestId = new URLSearchParams(window.location.search).get("requestId");
    if (requestId && /^[0-9a-f-]{36}$/i.test(requestId)) {
      setSelectedId(requestId);
    } else {
      setSelectedId(null);
    }
  }, [location]);

  const closeDetail = () => {
    setSelectedId(null);
    if (window.location.search) navigate("/address-collector");
  };

  const listKey = ["address-collector", tab, q] as const;
  const { data, isLoading, isError } = useQuery({
    queryKey: listKey,
    queryFn: () => {
      const params = new URLSearchParams({ tab });
      if (q.trim()) params.set("q", q.trim());
      return apiFetch<ListResponse>(`/api/address-collector?${params.toString()}`);
    },
    refetchInterval: 30_000,
  });

  const kpis = data?.kpis;
  const requests = data?.requests ?? [];

  const detailKey = ["address-collector-detail", selectedId] as const;
  const { data: detail, isLoading: detailLoading } = useQuery({
    queryKey: detailKey,
    queryFn: () => apiFetch<DetailResponse>(`/api/address-collector/${selectedId}`),
    enabled: selectedId != null,
    refetchInterval: selectedId != null ? 30_000 : false,
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["address-collector"] });
    void queryClient.invalidateQueries({ queryKey: ["address-collector-detail", selectedId] });
  };

  const statusMut = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      apiFetch(`/api/address-collector/${id}/status`, {
        method: "POST",
        body: JSON.stringify({ status }),
      }),
    onSuccess: () => {
      toast({ title: t("addressCollector.statusUpdated") });
      invalidate();
    },
    onError: () => {
      toast({ title: t("addressCollector.statusFailed"), variant: "destructive" });
    },
  });

  const detailReq = detail?.request;
  const countdown = useMemo(() => {
    if (!detailReq?.window_start) return null;
    return relativeTime(detailReq.window_start, locale, t);
  }, [detailReq?.window_start, locale, t]);

  const tabs: { key: TabKey; label: string }[] = [
    { key: "active", label: t("addressCollector.tabActive") },
    { key: "scheduled", label: t("addressCollector.tabScheduled") },
    { key: "waiting", label: t("addressCollector.tabWaiting") },
    { key: "attention", label: t("addressCollector.tabAttention") },
    { key: "closed", label: t("addressCollector.tabClosed") },
  ];

  return (
    <div className="p-6 space-y-6" data-testid="address-collector-page">
      {/* Title row */}
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight text-foreground">
          <MapPin size={22} className="text-[#0d6e7a]" />
          {t("addressCollector.title")}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">{t("addressCollector.subtitle")}</p>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard
          testId="address-collector-kpi-awaiting"
          icon={<Clock size={18} className="text-amber-600" />}
          tone="bg-amber-500/15"
          value={kpis?.awaiting ?? "—"}
          label={t("addressCollector.kpiAwaiting")}
        />
        <KpiCard
          testId="address-collector-kpi-scheduled"
          icon={<CalendarClock size={18} className="text-blue-600" />}
          tone="bg-blue-500/15"
          value={kpis?.scheduled ?? "—"}
          label={t("addressCollector.kpiScheduled")}
        />
        <KpiCard
          testId="address-collector-kpi-atrisk"
          icon={<AlertTriangle size={18} className="text-red-600" />}
          tone="bg-red-500/15"
          value={kpis?.atRisk ?? "—"}
          label={t("addressCollector.kpiAtRisk")}
        />
        <KpiCard
          testId="address-collector-kpi-collected"
          icon={<CheckCircle2 size={18} className="text-green-600" />}
          tone="bg-green-500/15"
          value={kpis ? `${kpis.collectedAutomatically}%` : "—"}
          label={t("addressCollector.kpiCollected")}
        />
      </div>

      {/* Timing rules info banner */}
      <div className="flex items-start gap-2 rounded-lg border border-[#b2dde3] bg-[#e6f4f5] px-4 py-3">
        <Info size={16} className="mt-0.5 shrink-0 text-[#0d6e7a]" />
        <p className="text-xs text-[#0d6e7a]">{t("addressCollector.timingRules")}</p>
      </div>

      {/* Search */}
      <div className="relative max-w-md">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input
          data-testid="address-collector-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t("addressCollector.searchPlaceholder")}
          className="pl-9"
        />
      </div>

      {/* Tabs */}
      <Tabs value={tab} onValueChange={(v) => setTab(v as TabKey)}>
        <TabsList data-testid="address-collector-tabs">
          {tabs.map((tb) => (
            <TabsTrigger key={tb.key} value={tb.key} data-testid={`address-collector-tab-${tb.key}`}>
              {tb.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {/* Table */}
      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex justify-center py-16">
              <Loader2 className="animate-spin text-muted-foreground" size={26} />
            </div>
          ) : isError ? (
            <div className="py-16 text-center text-sm text-destructive">
              {t("addressCollector.loadError")}
            </div>
          ) : requests.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              {t("addressCollector.empty")}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("addressCollector.colRecipient")}</TableHead>
                  <TableHead>{t("addressCollector.colWindow")}</TableHead>
                  <TableHead>{t("addressCollector.colPlan")}</TableHead>
                  <TableHead>{t("addressCollector.colLastContact")}</TableHead>
                  <TableHead>{t("addressCollector.colStatus")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {requests.map((r) => (
                  <TableRow
                    key={r.id}
                    data-testid={`address-collector-row-${r.id}`}
                    className={r.closed_at ? "cursor-pointer opacity-60" : "cursor-pointer"}
                    onClick={() => {
                      setSelectedId(r.id);
                      navigate(`/address-collector?requestId=${encodeURIComponent(r.id)}`);
                    }}
                  >
                    <TableCell>
                      <div className="flex flex-col">
                        <span className="flex items-center gap-1.5 font-medium text-foreground">
                          {r.recipient_name || t("addressCollector.noName")}
                          <LangBadge lang={r.preferred_language} />
                        </span>
                        <span className="text-[11px] text-muted-foreground">
                          <AddressCollectorOrderLabel
                            orderId={r.order_id}
                            orderNumber={r.order_number}
                            orderLabel={t("addressCollector.orderLabel")}
                            standaloneLabel={t("addressCollector.standaloneReceiver")}
                            unavailableLabel={t("addressCollector.orderNumberUnavailable")}
                          />
                        </span>
                        {r.recipient_phone && (
                          <span className="text-xs text-muted-foreground">{r.recipient_phone}</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">
                      {formatWindow(r.window_start, r.window_end, r.delivery_timezone, locale)}
                    </TableCell>
                    <TableCell className="text-sm">
                      {r.closed_at ? (
                        <span className="font-medium text-muted-foreground">
                          {t("addressCollector.noActionRequired")}
                        </span>
                      ) : r.next_action_type || r.outreach_step ? (
                        <div className="flex flex-col">
                          <span>{actionLabel(r.next_action_type ?? r.outreach_step, t)}</span>
                          {(r.next_action_at || r.template_sent_at) && (
                            <span className="text-xs text-muted-foreground">
                              {relativeTime(r.next_action_at ?? r.template_sent_at, locale, t)}
                            </span>
                          )}
                          {r.provider_status && (
                            <span className="text-xs capitalize text-muted-foreground">
                              {t(`addressCollector.providerStatus.${r.provider_status}`, r.provider_status)}
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm">
                      {r.last_contact_at ? (
                        <div className="flex flex-col">
                          <span>{relativeTime(r.last_contact_at, locale, t)}</span>
                          {r.last_contact_channel && (
                            <span className="text-xs text-muted-foreground capitalize">
                              {r.last_contact_channel}
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="text-muted-foreground">{t("addressCollector.notContacted")}</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={STATUS_BADGE[r.status] ?? ""}
                      >
                        {r.outcome_label ?? t(`addressCollector.status.${r.status}`, r.status)}
                      </Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Detail Sheet */}
      <Sheet open={selectedId != null} onOpenChange={(o) => { if (!o) closeDetail(); }}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-md" data-testid="address-collector-detail">
          {detailLoading || !detail ? (
            <div className="flex justify-center py-16">
              <Loader2 className="animate-spin text-muted-foreground" size={26} />
            </div>
          ) : (
            <>
              <SheetHeader className="mb-4">
                <SheetTitle className="flex items-center gap-2">
                  {detailReq?.recipient_name || t("addressCollector.noName")}
                  <LangBadge lang={detailReq?.preferred_language ?? null} />
                </SheetTitle>
              </SheetHeader>

              <div className="space-y-5">
                {/* Order + status */}
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">
                    <AddressCollectorOrderLabel
                      orderId={detailReq?.order_id ?? null}
                      orderNumber={detailReq?.order_number ?? null}
                      orderLabel={t("addressCollector.orderLabel")}
                      standaloneLabel={t("addressCollector.standaloneReceiver")}
                      unavailableLabel={t("addressCollector.orderNumberUnavailable")}
                    />
                  </span>
                  {detailReq && (
                    <Badge variant="outline" className={STATUS_BADGE[detailReq.status] ?? ""}>
                      {t(`addressCollector.status.${detailReq.status}`, detailReq.status)}
                    </Badge>
                  )}
                </div>

                {detailReq?.closed_at && (
                  <div className="rounded-lg border border-border bg-muted/40 p-3" data-testid="address-collector-closure">
                    <p className="text-sm font-medium text-foreground">
                      {detailReq.outcome_label ?? t("addressCollector.closed")}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {detailReq.closure_reason || t("addressCollector.noActionRequired")}
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {new Date(detailReq.closed_at).toLocaleString(locale)}
                    </p>
                  </div>
                )}

                {/* Phone + call */}
                {detailReq?.recipient_phone && (
                  <div className="flex items-center justify-between rounded-lg border border-border p-3">
                    <div className="flex items-center gap-2 text-sm">
                      <Phone size={14} className="text-muted-foreground" />
                      {detailReq.recipient_phone}
                    </div>
                    <Button
                      asChild
                      size="sm"
                      variant="outline"
                      data-testid="address-collector-call"
                    >
                      <a href={`tel:${detailReq.recipient_phone}`}>{t("addressCollector.call")}</a>
                    </Button>
                  </div>
                )}

                {detailReq?.respondio_profile_url && (
                  <Button asChild variant="outline" className="w-full gap-2" data-testid="address-collector-open-respondio">
                    <a href={detailReq.respondio_profile_url} target="_blank" rel="noreferrer">
                      <ExternalLink size={15} />
                      {t("addressCollector.openRespondio")}
                    </a>
                  </Button>
                )}

                {/* Countdown */}
                {detailReq?.window_start && <div className="rounded-lg border border-border p-3">
                  <p className="text-xs text-muted-foreground">{t("addressCollector.countdown")}</p>
                  <p className="mt-0.5 text-base font-semibold text-foreground">{countdown ?? "—"}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {formatWindow(
                      detailReq?.window_start ?? null,
                      detailReq?.window_end ?? null,
                      detailReq?.delivery_timezone ?? null,
                      locale,
                    )}
                  </p>
                </div>}

                {(detailReq?.inbound_reply_type || detailReq?.inbound_outcome) && (
                  <div className="space-y-2 rounded-lg border border-border p-3" data-testid="address-collector-reply-review">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-xs font-medium text-muted-foreground">Recipient reply</p>
                      {detailReq.inbound_outcome && (
                        <Badge variant="outline">{detailReq.inbound_outcome.replaceAll("_", " ")}</Badge>
                      )}
                    </div>
                    <p className="text-sm font-medium capitalize">
                      {detailReq.inbound_reply_type?.replaceAll("_", " ")}
                    </p>
                    {detailReq.inbound_reply_text && (
                      <p className="whitespace-pre-wrap break-words text-sm text-foreground">
                        {detailReq.inbound_reply_text}
                      </p>
                    )}
                    {detailReq.inbound_lat != null && detailReq.inbound_lng != null && (
                      <p className="text-xs text-muted-foreground">
                        {detailReq.inbound_lat.toFixed(6)}, {detailReq.inbound_lng.toFixed(6)}
                      </p>
                    )}
                    {detailReq.inbound_confidence != null && (
                      <p className="text-xs text-muted-foreground">
                        Confidence: {Math.round(detailReq.inbound_confidence * 100)}%
                      </p>
                    )}
                    {detailReq.inbound_error && (
                      <p className="text-xs text-red-600">{detailReq.inbound_error}</p>
                    )}
                  </div>
                )}

                {/* Status controls */}
                {!detailReq?.closed_at && <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">
                    {t("addressCollector.statusControls")}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      data-testid="address-collector-mark-verified"
                      disabled={statusMut.isPending || !selectedId}
                      onClick={() => selectedId && statusMut.mutate({ id: selectedId, status: "verified" })}
                    >
                      {t("addressCollector.markVerified")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      data-testid="address-collector-mark-review"
                      disabled={statusMut.isPending || !selectedId}
                      onClick={() => selectedId && statusMut.mutate({ id: selectedId, status: "needs_review" })}
                    >
                      {t("addressCollector.needsReview")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      data-testid="address-collector-mark-escalated"
                      disabled={statusMut.isPending || !selectedId}
                      onClick={() => selectedId && statusMut.mutate({ id: selectedId, status: "escalated" })}
                    >
                      {t("addressCollector.escalate")}
                    </Button>
                  </div>
                </div>}

                <Separator />

                {/* Activity timeline */}
                <div className="space-y-3">
                  <p className="text-xs font-medium text-muted-foreground">
                    {t("addressCollector.activityTimeline")}
                  </p>
                  {detail.events.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("addressCollector.noEvents")}</p>
                  ) : (
                    <ul className="space-y-3" data-testid="address-collector-timeline">
                      {[...detail.events]
                        .sort(
                          (a, b) =>
                            new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
                        )
                        .map((ev) => (
                          <li key={ev.id} className="flex items-start gap-2.5">
                            <div className="mt-0.5">
                              <EventIcon type={ev.event_type} />
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="text-sm text-foreground">
                                {t(`addressCollector.event.${ev.event_type}`, ev.event_type)}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {new Date(ev.created_at).toLocaleString(locale)}
                                {ev.channel ? ` · ${ev.channel}` : ""}
                                {ev.actor ? ` · ${ev.actor}` : ""}
                              </p>
                              {typeof ev.metadata?.provider_status === "string" && (
                                <p className="text-xs capitalize text-muted-foreground">
                                  {t(`addressCollector.providerStatus.${ev.metadata.provider_status}`, ev.metadata.provider_status)}
                                </p>
                              )}
                            </div>
                          </li>
                        ))}
                    </ul>
                  )}
                </div>

                <Separator />

                {/* Scheduled actions */}
                <div className="space-y-3">
                  <p className="text-xs font-medium text-muted-foreground">
                    {t("addressCollector.scheduledActions")}
                  </p>
                  {detail.actions.length === 0 ? (
                    <p className="text-sm text-muted-foreground">{t("addressCollector.noActions")}</p>
                  ) : (
                    <ul className="space-y-2" data-testid="address-collector-actions">
                      {detail.actions.map((ac) => (
                        <li
                          key={ac.id}
                          className="rounded-lg border border-border p-2.5 text-sm"
                        >
                          <div className="flex items-center justify-between">
                            <span className="font-medium text-foreground">
                              {actionLabel(ac.action_type, t)}
                              {ac.channel ? ` · ${ac.channel}` : ""}
                            </span>
                            {ac.status && (
                              <span className="text-xs capitalize text-muted-foreground">
                                {ac.status}
                              </span>
                            )}
                          </div>
                          {ac.provider_status && (
                            <p className="text-xs capitalize text-muted-foreground">
                              {t(`addressCollector.providerStatus.${ac.provider_status}`, ac.provider_status)}
                            </p>
                          )}
                          {ac.scheduled_at && (
                            <p className="text-xs text-muted-foreground">
                              {new Date(ac.sent_at ?? ac.scheduled_at).toLocaleString(locale)}
                            </p>
                          )}
                          {ac.error_message && (
                            <p className="mt-1 flex items-center gap-1 text-xs text-destructive">
                              <XCircle size={11} />
                              {ac.error_message}
                              {ac.error_code ? ` (${ac.error_code})` : ""}
                            </p>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
