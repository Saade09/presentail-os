import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useSearch } from "wouter";
import {
  Receipt,
  Plus,
  Download,
  Loader2,
  DoorOpen,
  Clock,
  AlertTriangle,
  Coins,
  ArrowRight,
  Search,
  X,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  CircleAlert,
  CircleDollarSign,
} from "lucide-react";
import { apiFetch, isAccessRequestError } from "@/lib/queryClient";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { cn } from "@/lib/utils";
import {
  type SessionRow,
  type SortKey,
  type SortDir,
  type AttentionItem,
  computeNeedsAttention,
  computeIsOverdue,
  primaryAction,
  formatMoney,
  formatDateTime,
  formatOpenDuration,
  heldAmount,
  canManageCashSessionLifecycle,
} from "@/lib/cashSessionsDashboard";
import { getCurrencyFlagEmoji } from "@/lib/countries";

// ---------------------------------------------------------------------------
// Types for the new server-driven responses
// ---------------------------------------------------------------------------

type KpisResponse = {
  openCount: number;
  pendingCount: number;
  flaggedCount: number;
  overdueCount: number;
  openHeldByCurrency: { currency: string; amount: number; count: number }[];
  flaggedDiffByCurrency: { currency: string; amount: number }[];
  differenceByCurrency: { currency: string; amount: number; count: number }[];
  attentionSessions: SessionRow[];
  myOpenSession: SessionRow | null;
  filterOptions: {
    drawers: string[];
    currencies: string[];
    operators: { clerkId: string; name: string }[];
  };
};

type SessionsResponse = {
  sessions: SessionRow[];
  total_count: number;
  page: number;
  page_size: number;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATUS_LABEL_KEYS: Record<string, string> = {
  open: "cashSessions.statusOpen",
  overdue: "cashSessions.statusOverdue",
  pending_review: "cashSessions.statusPendingReview",
  approved: "cashSessions.statusApproved",
  flagged: "cashSessions.statusFlagged",
};

function statusPillClass(status: string): string {
  switch (status) {
    case "open":
      return "bg-teal-50 text-teal-700 border-teal-200";
    case "overdue":
      return "bg-red-50 text-red-700 border-red-200";
    case "pending_review":
      return "bg-amber-50 text-amber-700 border-amber-200";
    case "flagged":
      return "bg-red-50 text-red-700 border-red-200";
    case "approved":
      return "bg-emerald-50 text-emerald-700 border-emerald-200";
    default:
      return "bg-muted text-muted-foreground border-transparent";
  }
}

function differenceClass(diff: number | null): string {
  if (diff == null) return "text-muted-foreground";
  if (diff < 0) return "text-red-600";
  if (diff > 0) return "text-amber-600";
  return "text-emerald-600/80";
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function CashSessions() {
  const { t } = useTranslation();
  const [, navigate] = useLocation();
  const search = useSearch();
  const { isOwner, allowedPages } = useWorkspaceRole();
  const can = (perm: string) => isOwner || (allowedPages?.includes(perm) ?? false);
  const canCashSessionAction = (action: "open" | "close") =>
    canManageCashSessionLifecycle(isOwner, allowedPages, action);

  // ---- URL-synced filter + sort + page state ------------------------------
  const params = new URLSearchParams(search);
  const preset = params.get("preset") ?? "all";
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  const drawer = params.get("drawer") ?? "";
  const operatorId = params.get("operator_id") ?? "";
  const status = params.get("status") ?? "";
  const currency = params.get("currency") ?? "";
  const q = params.get("q") ?? "";
  const sortKey = (params.get("sort") as SortKey) ?? "opened_at";
  const sortDir = (params.get("dir") as SortDir) ?? "desc";
  const page = Math.max(1, parseInt(params.get("page") ?? "1", 10) || 1);

  function updateParams(updates: Record<string, string | null>, resetPage = true) {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(updates)) {
      if (v == null || v === "") next.delete(k);
      else next.set(k, v);
    }
    if (resetPage) next.delete("page");
    const qs = next.toString();
    navigate(`/cash-sessions${qs ? `?${qs}` : ""}`, { replace: true });
  }

  const setFilter = (key: string, value: string) =>
    updateParams({ [key]: value === "all" ? null : value });

  const clearFilters = () =>
    updateParams({
      preset: null,
      from: null,
      to: null,
      drawer: null,
      operator_id: null,
      status: null,
      currency: null,
      q: null,
    });

  const hasActiveFilters =
    (preset && preset !== "all") ||
    !!drawer ||
    !!operatorId ||
    (status && status !== "all") ||
    (currency && currency !== "all") ||
    q.trim() !== "";

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      updateParams({ dir: sortDir === "desc" ? "asc" : "desc" }, false);
    } else {
      updateParams({ sort: key, dir: "desc" }, false);
    }
  }

  // ---- Queries -----------------------------------------------------------

  // KPIs: global, no content filters. Refetch when the component mounts.
  const {
    data: kpisData,
    isLoading: kpisLoading,
    isError: kpisError,
    error: kpisQueryError,
    refetch: refetchKpis,
  } = useQuery<KpisResponse>({
    queryKey: ["cash-sessions-kpis"],
    queryFn: () => apiFetch("/api/cash-sessions/kpis"),
  });

  // Session list: filtered + sorted + paginated. Refetches on any filter/page change.
  const sessionsQs = buildSessionsQs({
    preset,
    from,
    to,
    drawer,
    operatorId,
    status,
    currency,
    q,
    sort: sortKey,
    dir: sortDir,
    page,
  });

  const {
    data: sessionsData,
    isLoading: sessionsLoading,
    isError: sessionsError,
    error: sessionsQueryError,
    refetch: refetchSessions,
  } = useQuery<SessionsResponse>({
    queryKey: ["cash-sessions", sessionsQs],
    queryFn: () => apiFetch(`/api/cash-sessions?${sessionsQs}`),
  });

  const isLoading = kpisLoading || sessionsLoading;
  const isError = kpisError || sessionsError;
  const queryError = kpisQueryError ?? sessionsQueryError;
  function refetch() {
    void refetchKpis();
    void refetchSessions();
  }

  const sessions = sessionsData?.sessions ?? [];
  const totalCount = sessionsData?.total_count ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalCount / (sessionsData?.page_size ?? 20)));

  // KPI data from the kpis endpoint
  const kpis = kpisData ?? {
    openCount: 0,
    pendingCount: 0,
    flaggedCount: 0,
    overdueCount: 0,
    openHeldByCurrency: [],
    flaggedDiffByCurrency: [],
    differenceByCurrency: [],
    attentionSessions: [],
    myOpenSession: null,
    filterOptions: { drawers: [], currencies: [], operators: [] },
  };

  const myOpenSession = kpis.myOpenSession;

  // Attention items classified from the server-provided attention sessions
  const attention: AttentionItem[] = computeNeedsAttention(kpis.attentionSessions);

  // ---- CSV export (current page rows) ------------------------------------
  function exportCsv() {
    const headers = [
      "Session", "Drawer", "Location", "Opened by", "Closed by", "Approved by",
      "Currency", "Status", "Opening", "Expected", "Actual", "Difference",
      "Secondary Currency", "Opening (Secondary)", "Expected (Secondary)",
      "Actual (Secondary)", "Difference (Secondary)", "Opened", "Closed",
    ];
    const rows = sessions.map((s) => [
      s.session_number,
      s.drawer_name ?? "",
      s.location_name ?? "",
      s.opened_by_name ?? "—",
      s.closed_by_name ?? "—",
      s.approved_by_name ?? "—",
      s.currency,
      s.status,
      s.opening_cash,
      s.expected_cash ?? "",
      s.actual_cash ?? "",
      s.difference ?? "",
      s.secondary_currency ?? "",
      s.opening_cash_secondary ?? "",
      s.expected_cash_secondary ?? "",
      s.actual_cash_secondary ?? "",
      s.difference_secondary ?? "",
      s.opened_at,
      s.closed_at ?? "",
    ]);
    const csv = [headers, ...rows]
      .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cash-sessions-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ---- KPI card click handlers -------------------------------------------
  const kpiFilterActive = (s: string) => status === s;

  // ---- Render helpers ----------------------------------------------------
  function amountList(
    list: { currency: string; amount: number }[],
    render: (c: { currency: string; amount: number }) => string,
  ): string {
    if (list.length === 0) return "—";
    return list.map(render).join(" · ");
  }

  function rowActionButton(s: SessionRow) {
    const action = primaryAction(s.status, canCashSessionAction("close"), can("cash_sessions.approve"));
    const label =
      action === "close"
        ? t("cashSessions.actionViewClose")
        : action === "review"
          ? t("cashSessions.actionReview")
          : action === "investigate"
            ? t("cashSessions.actionInvestigate")
            : t("cashSessions.actionView");
    const target =
      action === "close" ? `/cash-sessions/${s.id}/close` : `/cash-sessions/${s.id}`;
    return (
      <Button
        size="sm"
        variant={action === "view" ? "ghost" : "outline"}
        className="h-7 px-2 text-xs"
        onClick={(e) => {
          e.stopPropagation();
          navigate(target);
        }}
      >
        {label}
      </Button>
    );
  }

  function attentionRow(item: AttentionItem) {
    const s = item.session;
    let icon = <CircleAlert className="h-4 w-4 text-red-500" />;
    let title = t("cashSessions.issueShortage");
    let detail = "";
    let actionLabel = t("cashSessions.actionView");
    let target = `/cash-sessions/${s.id}`;

    if (item.kind === "shortage" || item.kind === "overage") {
      icon =
        item.kind === "shortage" ? (
          <CircleAlert className="h-4 w-4 text-red-500" />
        ) : (
          <CircleDollarSign className="h-4 w-4 text-amber-500" />
        );
      title =
        item.kind === "shortage"
          ? t("cashSessions.issueShortage")
          : t("cashSessions.issueOverage");
      detail = t("cashSessions.attentionVariance", {
        expected: formatMoney(s.expected_cash, s.currency),
        counted: formatMoney(s.actual_cash, s.currency),
        difference: formatMoney(s.difference, s.currency),
      });
      actionLabel =
        s.status === "flagged" && can("cash_sessions.approve")
          ? t("cashSessions.actionInvestigate")
          : s.status === "pending_review" && can("cash_sessions.approve")
            ? t("cashSessions.actionReview")
            : t("cashSessions.actionView");
    } else if (item.kind === "flagged") {
      icon = <AlertTriangle className="h-4 w-4 text-red-500" />;
      title = t("cashSessions.issueFlagged");
      detail = t("cashSessions.attentionClosedBy", {
        name: s.closed_by_name ?? "—",
        time: formatDateTime(s.closed_at),
      });
      actionLabel = can("cash_sessions.approve")
        ? t("cashSessions.actionInvestigate")
        : t("cashSessions.actionView");
    } else if (item.kind === "pending_review") {
      icon = <Clock className="h-4 w-4 text-amber-500" />;
      title = t("cashSessions.issuePendingReview");
      detail = t("cashSessions.attentionClosedBy", {
        name: s.closed_by_name ?? "—",
        time: formatDateTime(s.closed_at),
      });
      actionLabel = can("cash_sessions.approve")
        ? t("cashSessions.actionReview")
        : t("cashSessions.actionView");
    } else if (item.kind === "overdue") {
      icon = <AlertTriangle className="h-4 w-4 text-red-600" />;
      const openTime = new Date(s.opened_at).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
      });
      title = t("cashSessions.issueOverdue", { time: openTime });
      const overdueBy = s.overdueByMinutes != null
        ? formatOpenDuration(new Date(Date.now() - s.overdueByMinutes * 60_000).toISOString())
        : "";
      detail = t("cashSessions.attentionOverdueDetail", {
        overdueBy,
        amount: formatMoney(heldAmount(s), s.currency),
      });
      actionLabel = canCashSessionAction("close")
        ? t("cashSessions.actionViewClose")
        : t("cashSessions.actionView");
      target = canCashSessionAction("close")
        ? `/cash-sessions/${s.id}/close`
        : `/cash-sessions/${s.id}`;
    } else if (item.kind === "long_open") {
      icon = <Clock className="h-4 w-4 text-sky-500" />;
      title = t("cashSessions.issueLongOpen", { duration: formatOpenDuration(s.opened_at) });
      detail = t("cashSessions.attentionOpenedBy", {
        name: s.opened_by_name ?? "—",
        amount: formatMoney(heldAmount(s), s.currency),
      });
      actionLabel = canCashSessionAction("close")
        ? t("cashSessions.actionViewClose")
        : t("cashSessions.actionView");
      target = canCashSessionAction("close")
        ? `/cash-sessions/${s.id}/close`
        : `/cash-sessions/${s.id}`;
    } else if (item.kind === "closed_no_count") {
      icon = <CircleAlert className="h-4 w-4 text-amber-500" />;
      title = t("cashSessions.issueClosedNoCount");
      detail = t("cashSessions.attentionClosedBy", {
        name: s.closed_by_name ?? "—",
        time: formatDateTime(s.closed_at),
      });
    }

    return (
      <div key={`${item.kind}-${s.id}`} className="flex items-center gap-3 border-b py-2.5 last:border-0">
        <div className="shrink-0">{icon}</div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {s.drawer_name ?? s.session_number} · {title}
          </p>
          <p className="truncate text-xs text-muted-foreground">{detail}</p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-7 shrink-0 px-2 text-xs"
          onClick={() => navigate(target)}
        >
          {actionLabel}
        </Button>
      </div>
    );
  }

  function sortIcon(key: SortKey) {
    if (sortKey !== key) return <ArrowUpDown className="h-3 w-3 opacity-40" />;
    return sortDir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />;
  }

  // Operator label for selected dropdown value
  const selectedOperatorName =
    operatorId
      ? (kpis.filterOptions.operators.find((o) => o.clerkId === operatorId)?.name ?? operatorId)
      : "all";

  // ---- Page ----------------------------------------------------------------
  return (
    <div className="space-y-5 p-4 md:p-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Receipt className="h-6 w-6" /> {t("cashSessions.title")}
          </h1>
          <p className="text-sm text-muted-foreground">{t("cashSessions.subtitle")}</p>
        </div>
        <div className="flex gap-2">
          {can("cash_sessions.export") && (
            <Button
              variant="outline"
              onClick={exportCsv}
              disabled={sessions.length === 0}
              className="gap-1.5"
            >
              <Download className="h-4 w-4" /> {t("cashSessions.exportCsv")}
            </Button>
          )}
          {canCashSessionAction("open") &&
            (myOpenSession ? (
              <Button
                onClick={() => navigate(`/cash-sessions/${myOpenSession.id}`)}
                className="gap-1.5"
              >
                <ArrowRight className="h-4 w-4 rtl:rotate-180" /> {t("cashSessions.continueSession")}
              </Button>
            ) : (
              <Button onClick={() => navigate("/cash-sessions/new")} className="gap-1.5">
                <Plus className="h-4 w-4" /> {t("cashSessions.startSession")}
              </Button>
            ))}
        </div>
      </div>

      {isError ? (
        <Card>
          <CardContent
            className="flex flex-col items-center gap-3 py-10 text-center"
            role="alert"
            data-testid="cash-sessions-load-error"
          >
            <AlertTriangle className="h-8 w-8 text-destructive opacity-70" />
            <div>
              <p className="text-sm font-medium">
                {isAccessRequestError(queryError)
                  ? t("cashSessions.accessError")
                  : t("cashSessions.loadError")}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {isAccessRequestError(queryError)
                  ? t("cashSessions.accessErrorHint")
                  : t("cashSessions.loadErrorHint")}
              </p>
            </div>
            <Button variant="outline" onClick={refetch}>
              {t("cashSessions.retry")}
            </Button>
          </CardContent>
        </Card>
      ) : isLoading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : (
        <>
          {/* KPI cards */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <KpiCard
              icon={<DoorOpen className="h-4 w-4 text-teal-600" />}
              label={t("cashSessions.kpiOpen")}
              value={kpis.openCount}
              sub={
                kpis.openHeldByCurrency.length > 0
                  ? t("cashSessions.kpiHeld", {
                      amount: amountList(kpis.openHeldByCurrency, (c) =>
                        formatMoney(c.amount, c.currency),
                      ),
                    })
                  : t("cashSessions.kpiNone")
              }
              active={kpiFilterActive("open")}
              activeClass="ring-teal-500/60"
              onClick={() => setFilter("status", kpiFilterActive("open") ? "all" : "open")}
            />
            <KpiCard
              icon={<AlertTriangle className="h-4 w-4 text-red-600" />}
              label={t("cashSessions.kpiOverdue")}
              value={kpis.overdueCount}
              valueClass={kpis.overdueCount > 0 ? "text-red-600" : undefined}
              sub={t("cashSessions.kpiOverdueSub")}
              active={kpiFilterActive("attention")}
              activeClass="ring-red-500/60"
              onClick={() =>
                setFilter("status", kpiFilterActive("attention") ? "all" : "attention")
              }
            />
            <KpiCard
              icon={<Clock className="h-4 w-4 text-amber-600" />}
              label={t("cashSessions.kpiPending")}
              value={kpis.pendingCount}
              sub={kpis.pendingCount > 0 ? t("cashSessions.kpiReviewNow") : t("cashSessions.kpiNone")}
              active={kpiFilterActive("pending_review")}
              activeClass="ring-amber-500/60"
              onClick={() =>
                setFilter("status", kpiFilterActive("pending_review") ? "all" : "pending_review")
              }
            />
            <KpiCard
              icon={<AlertTriangle className="h-4 w-4 text-red-600" />}
              label={t("cashSessions.kpiFlagged")}
              value={kpis.flaggedCount}
              sub={
                kpis.flaggedDiffByCurrency.length > 0
                  ? amountList(kpis.flaggedDiffByCurrency, (c) =>
                      c.amount < 0
                        ? t("cashSessions.kpiShortage", {
                            amount: formatMoney(Math.abs(c.amount), c.currency),
                          })
                        : t("cashSessions.kpiOverage", {
                            amount: formatMoney(c.amount, c.currency),
                          }),
                    )
                  : t("cashSessions.kpiNoVariance")
              }
              active={kpiFilterActive("flagged")}
              activeClass="ring-red-500/60"
              onClick={() => setFilter("status", kpiFilterActive("flagged") ? "all" : "flagged")}
            />
            <KpiCard
              icon={<Coins className="h-4 w-4 text-slate-600" />}
              label={t("cashSessions.kpiTotalDifference")}
              value={
                kpis.differenceByCurrency.length === 0
                  ? "—"
                  : amountList(kpis.differenceByCurrency, (c) =>
                      formatMoney(c.amount, c.currency),
                    )
              }
              valueClass={
                kpis.differenceByCurrency.some((c) => c.amount < 0)
                  ? "text-red-600"
                  : kpis.differenceByCurrency.some((c) => c.amount > 0)
                    ? "text-amber-600"
                    : undefined
              }
              sub={
                kpis.differenceByCurrency.length === 1
                  ? t("cashSessions.kpiPeriod", {
                      currency: kpis.differenceByCurrency[0].currency,
                    })
                  : t("cashSessions.kpiPeriodMulti")
              }
              active={kpiFilterActive("difference")}
              activeClass="ring-slate-500/60"
              onClick={() =>
                setFilter("status", kpiFilterActive("difference") ? "all" : "difference")
              }
            />
          </div>

          {/* Cash held by currency + Needs attention */}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <Card>
              <CardContent className="pt-5">
                <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
                  <Coins className="h-4 w-4 text-muted-foreground" />{" "}
                  {t("cashSessions.cashHeldByCurrency")}
                </div>
                {kpis.openHeldByCurrency.length === 0 ? (
                  <p className="py-4 text-sm text-muted-foreground">
                    {t("cashSessions.noOpenCash")}
                  </p>
                ) : (
                  kpis.openHeldByCurrency.map((c) => (
                    <div
                      key={c.currency}
                      className="flex items-center gap-3 border-b py-2.5 last:border-0"
                    >
                      <span className="shrink-0 text-sm font-semibold">
                        <span dir="ltr">{getCurrencyFlagEmoji(c.currency)} {c.currency}</span>
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-base font-bold tabular-nums" dir="ltr">
                          {formatMoney(c.amount, c.currency)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {t("cashSessions.openDrawers", { count: c.count })}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 shrink-0 px-2 text-xs text-teal-700"
                        onClick={() => updateParams({ status: "open", currency: c.currency })}
                      >
                        {t("cashSessions.viewDrawers")}
                      </Button>
                    </div>
                  ))
                )}
              </CardContent>
            </Card>

            <Card>
              <CardContent className="pt-5">
                <div className="mb-2 flex items-center justify-between">
                  <div className="flex items-center gap-1.5 text-sm font-semibold">
                    <AlertTriangle className="h-4 w-4 text-muted-foreground" />{" "}
                    {t("cashSessions.needsAttention")}
                  </div>
                  {attention.length > 0 && (
                    <span className="text-xs font-medium text-red-600">
                      {t("cashSessions.attentionCount", { count: attention.length })}
                    </span>
                  )}
                </div>
                {attention.length === 0 ? (
                  <p className="py-4 text-sm text-muted-foreground">
                    {t("cashSessions.attentionEmpty")}
                  </p>
                ) : (
                  <div className="max-h-56 overflow-y-auto">
                    {attention.slice(0, 8).map(attentionRow)}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Session history */}
          <Card>
            <CardContent className="space-y-3 pt-5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="me-1 text-sm font-semibold">
                  {t("cashSessions.sessionHistory", { count: totalCount })}
                </span>
                <Badge variant="secondary" className="font-normal">
                  {t("cashSessions.resultsCount", { count: totalCount })}
                </Badge>
              </div>

              {/* Filter toolbar */}
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={preset || "all"}
                  onValueChange={(v) => setFilter("preset", v)}
                >
                  <SelectTrigger className="h-8 w-[130px] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("cashSessions.presetAll")}</SelectItem>
                    <SelectItem value="today">{t("cashSessions.presetToday")}</SelectItem>
                    <SelectItem value="yesterday">{t("cashSessions.presetYesterday")}</SelectItem>
                    <SelectItem value="this_week">{t("cashSessions.presetThisWeek")}</SelectItem>
                    <SelectItem value="this_month">{t("cashSessions.presetThisMonth")}</SelectItem>
                    <SelectItem value="custom">{t("cashSessions.presetCustom")}</SelectItem>
                  </SelectContent>
                </Select>
                {preset === "custom" && (
                  <>
                    <Input
                      type="date"
                      aria-label={t("cashSessions.from")}
                      className="h-8 w-[140px] text-xs"
                      value={from}
                      onChange={(e) => updateParams({ from: e.target.value || null })}
                    />
                    <Input
                      type="date"
                      aria-label={t("cashSessions.to")}
                      className="h-8 w-[140px] text-xs"
                      value={to}
                      onChange={(e) => updateParams({ to: e.target.value || null })}
                    />
                  </>
                )}
                <Select
                  value={drawer || "all"}
                  onValueChange={(v) => setFilter("drawer", v)}
                >
                  <SelectTrigger className="h-8 w-[140px] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("cashSessions.allDrawers")}</SelectItem>
                    {kpis.filterOptions.drawers.map((d) => (
                      <SelectItem key={d} value={d}>
                        {d}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={operatorId || "all"}
                  onValueChange={(v) => {
                    updateParams({ operator_id: v === "all" ? null : v });
                  }}
                >
                  <SelectTrigger className="h-8 w-[140px] text-xs">
                    <SelectValue>
                      {operatorId ? selectedOperatorName : t("cashSessions.allOperators")}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("cashSessions.allOperators")}</SelectItem>
                    {kpis.filterOptions.operators.map((o) => (
                      <SelectItem key={o.clerkId} value={o.clerkId}>
                        {o.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={status || "all"}
                  onValueChange={(v) => setFilter("status", v)}
                >
                  <SelectTrigger className="h-8 w-[150px] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("cashSessions.allStatuses")}</SelectItem>
                    <SelectItem value="open">{t("cashSessions.statusOpen")}</SelectItem>
                    <SelectItem value="pending_review">
                      {t("cashSessions.statusPendingReview")}
                    </SelectItem>
                    <SelectItem value="approved">{t("cashSessions.statusApproved")}</SelectItem>
                    <SelectItem value="flagged">{t("cashSessions.statusFlagged")}</SelectItem>
                    <SelectItem value="attention">{t("cashSessions.statusAttention")}</SelectItem>
                    <SelectItem value="difference">{t("cashSessions.statusDifference")}</SelectItem>
                  </SelectContent>
                </Select>
                <Select
                  value={currency || "all"}
                  onValueChange={(v) => setFilter("currency", v)}
                >
                  <SelectTrigger className="h-8 w-[130px] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("cashSessions.allCurrencies")}</SelectItem>
                    {kpis.filterOptions.currencies.map((c) => (
                      <SelectItem key={c} value={c}>
                        {c}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className="relative min-w-[200px] flex-1">
                  <Search className="absolute start-2.5 top-2 h-4 w-4 text-muted-foreground" />
                  <Input
                    className="h-8 ps-8 text-xs"
                    placeholder={t("cashSessions.searchPlaceholder")}
                    value={q}
                    onChange={(e) => updateParams({ q: e.target.value || null })}
                  />
                </div>
                {hasActiveFilters && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-8 gap-1 px-2 text-xs"
                    onClick={clearFilters}
                  >
                    <X className="h-3.5 w-3.5" /> {t("cashSessions.clearFilters")}
                  </Button>
                )}
              </div>

              {/* Table */}
              {sessionsLoading ? (
                <div className="flex items-center justify-center py-10 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                </div>
              ) : totalCount === 0 && !hasActiveFilters ? (
                <div className="py-10 text-center">
                  <p className="text-sm font-medium">{t("cashSessions.emptyTitle")}</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t("cashSessions.emptyHint")}
                  </p>
                </div>
              ) : sessions.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  {t("cashSessions.noResults")}
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-start text-xs uppercase text-muted-foreground">
                        <th className="py-2 pe-4 text-start">{t("cashSessions.colSession")}</th>
                        <th className="py-2 pe-4 text-start">{t("cashSessions.colDrawer")}</th>
                        <th className="py-2 pe-4 text-start">{t("cashSessions.colOperator")}</th>
                        <th className="py-2 pe-4 text-start">
                          <button
                            className="inline-flex items-center gap-1"
                            onClick={() => toggleSort("opened_at")}
                          >
                            {t("cashSessions.colOpened")} {sortIcon("opened_at")}
                          </button>
                        </th>
                        <th className="py-2 pe-4 text-start">
                          <button
                            className="inline-flex items-center gap-1"
                            onClick={() => toggleSort("status")}
                          >
                            {t("cashSessions.colStatus")} {sortIcon("status")}
                          </button>
                        </th>
                        <th className="py-2 pe-4 text-end">{t("cashSessions.colExpected")}</th>
                        <th className="py-2 pe-4 text-end">{t("cashSessions.colActual")}</th>
                        <th className="py-2 pe-4 text-end">
                          <button
                            className="inline-flex items-center gap-1"
                            onClick={() => toggleSort("difference")}
                          >
                            {t("cashSessions.colDifference")} {sortIcon("difference")}
                          </button>
                        </th>
                        <th className="py-2 text-end">{t("cashSessions.colAction")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sessions.map((s) => {
                        const diff = s.difference != null ? Number(s.difference) : null;
                        return (
                          <tr
                            key={s.id}
                            className="cursor-pointer border-b last:border-0 hover:bg-muted/30"
                            onClick={() => navigate(`/cash-sessions/${s.id}`)}
                          >
                            <td className="whitespace-nowrap py-2.5 pe-4 font-mono text-xs font-medium">
                              {s.session_number}
                            </td>
                            <td className="py-2.5 pe-4">{s.drawer_name ?? "—"}</td>
                            <td className="py-2.5 pe-4">{s.opened_by_name ?? "—"}</td>
                            <td className="whitespace-nowrap py-2.5 pe-4 text-xs text-muted-foreground">
                              {formatDateTime(s.opened_at)}
                            </td>
                            <td className="py-2.5 pe-4">
                              {(() => {
                                const overdue = s.status === "open" && computeIsOverdue(s);
                                const pillStatus = overdue ? "overdue" : s.status;
                                return (
                                  <div className="flex flex-wrap items-center gap-1">
                                    <span
                                      className={cn(
                                        "inline-flex rounded-full border px-2 py-0.5 text-xs font-medium",
                                        statusPillClass(pillStatus),
                                      )}
                                    >
                                      {STATUS_LABEL_KEYS[pillStatus]
                                        ? t(STATUS_LABEL_KEYS[pillStatus])
                                        : pillStatus}
                                    </span>
                                    {s.resolution_id != null && (
                                      <span className="inline-flex rounded-full border border-orange-200 bg-orange-50 px-2 py-0.5 text-xs font-medium text-orange-700">
                                        {t("cashSessions.resolvedLate")}
                                      </span>
                                    )}
                                  </div>
                                );
                              })()}
                            </td>
                            <td
                              className="whitespace-nowrap py-2.5 pe-4 text-end tabular-nums"
                              dir="ltr"
                            >
                              <div>{formatMoney(s.expected_cash, s.currency)}</div>
                              {s.secondary_currency && (
                                <div className="text-xs text-muted-foreground">
                                  {formatMoney(s.expected_cash_secondary, s.secondary_currency)}
                                </div>
                              )}
                            </td>
                            <td
                              className="whitespace-nowrap py-2.5 pe-4 text-end tabular-nums"
                              dir="ltr"
                            >
                              <div>
                                {formatMoney(
                                  s.actual_cash,
                                  s.actual_cash != null ? s.currency : undefined,
                                )}
                              </div>
                              {s.secondary_currency && s.actual_cash_secondary != null && (
                                <div className="text-xs text-muted-foreground">
                                  {formatMoney(s.actual_cash_secondary, s.secondary_currency)}
                                </div>
                              )}
                            </td>
                            <td
                              className={cn(
                                "whitespace-nowrap py-2.5 pe-4 text-end tabular-nums",
                                differenceClass(diff),
                              )}
                              dir="ltr"
                            >
                              <div>
                                {formatMoney(
                                  s.difference,
                                  s.difference != null ? s.currency : undefined,
                                )}
                              </div>
                              {s.secondary_currency && s.difference_secondary != null && (
                                <div
                                  className={cn(
                                    "text-xs",
                                    differenceClass(Number(s.difference_secondary)),
                                  )}
                                >
                                  {formatMoney(s.difference_secondary, s.secondary_currency)}
                                </div>
                              )}
                            </td>
                            <td className="py-2.5 text-end">{rowActionButton(s)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Pagination */}
              {totalPages > 1 && (
                <div className="flex items-center justify-between pt-1">
                  <span className="text-xs text-muted-foreground">
                    {t("cashSessions.pageInfo", { page, totalPages })}
                  </span>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      disabled={page <= 1}
                      onClick={() => updateParams({ page: String(page - 1) }, false)}
                    >
                      {t("cashSessions.pagePrev")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 px-2 text-xs"
                      disabled={page >= totalPages}
                      onClick={() => updateParams({ page: String(page + 1) }, false)}
                    >
                      {t("cashSessions.pageNext")}
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helper: build sessions query string from filter state
// ---------------------------------------------------------------------------

function buildSessionsQs(opts: {
  preset: string;
  from: string;
  to: string;
  drawer: string;
  operatorId: string;
  status: string;
  currency: string;
  q: string;
  sort: string;
  dir: string;
  page: number;
}): string {
  const p = new URLSearchParams();
  if (opts.preset && opts.preset !== "all") p.set("preset", opts.preset);
  if (opts.preset === "custom" || opts.preset === "all") {
    if (opts.from) p.set("from", opts.from);
    if (opts.to) p.set("to", opts.to);
  }
  if (opts.drawer) p.set("drawer", opts.drawer);
  if (opts.operatorId) p.set("operator_id", opts.operatorId);
  if (opts.status && opts.status !== "all") p.set("status", opts.status);
  if (opts.currency && opts.currency !== "all") p.set("currency", opts.currency);
  if (opts.q.trim()) p.set("q", opts.q.trim());
  p.set("sort", opts.sort);
  p.set("dir", opts.dir);
  p.set("page", String(opts.page));
  return p.toString();
}

// ---------------------------------------------------------------------------
// KPI card sub-component
// ---------------------------------------------------------------------------

function KpiCard({
  icon,
  label,
  value,
  valueClass,
  sub,
  active,
  activeClass,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  valueClass?: string;
  sub: string;
  active: boolean;
  activeClass: string;
  onClick: () => void;
}) {
  return (
    <Card
      role="button"
      tabIndex={0}
      aria-pressed={active}
      className={cn(
        "cursor-pointer transition-shadow hover:shadow-sm",
        active && cn("ring-2", activeClass),
      )}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <CardContent className="flex flex-col gap-1 pt-5">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {icon} {label}
        </div>
        <div className={cn("truncate text-2xl font-bold tabular-nums", valueClass)} dir="ltr">
          {value}
        </div>
        <div className="truncate text-xs text-muted-foreground">{sub}</div>
      </CardContent>
    </Card>
  );
}
