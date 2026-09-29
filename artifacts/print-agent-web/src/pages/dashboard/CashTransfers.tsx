import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useSearch } from "wouter";
import { useTranslation } from "react-i18next";
import {
  ArrowLeftRight,
  Search,
  X,
  Loader2,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { apiFetch } from "@/lib/queryClient";
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
import { cn } from "@/lib/utils";
import { formatCashMoney } from "@/lib/cashMoney";
import { formatDateTime } from "@/lib/cashSessionsDashboard";
import {
  TransferDetailPanel,
  transferStatusLabel,
  transferStatusClass,
} from "./TransferDetailPanel";

// ---------------------------------------------------------------------------
// Types — aligned with GET /api/cash-transfers response
// ---------------------------------------------------------------------------

export type TransferRow = {
  id: number;
  transfer_number: string;
  /** ISO timestamp (handed_over_at from DB) */
  handed_over_at: string | null;
  created_at: string;
  source_drawer_name: string | null;
  source_location_name: string | null;
  destination_drawer_name: string | null;
  destination_location_name: string | null;
  /** ISO 4217 code — field is currency_code in the DB */
  currency_code: string;
  sent_amount: string;
  /** carrier_user_id (Clerk user ID) or null */
  carrier_user_id: string | null;
  /** Free-text name for external carriers */
  external_carrier_name: string | null;
  /** intended_receiver_user_id (Clerk user ID) or null */
  intended_receiver_user_id: string | null;
  status: "IN_TRANSIT" | "COMPLETED" | "DISPUTED" | "RETURNED";
};

type TransfersResponse = {
  transfers: TransferRow[];
  /** Total matching rows (for pagination) */
  total: number;
  page: number;
  /** Rows per page */
  pageSize: number;
  totalPages: number;
};

// ---------------------------------------------------------------------------
// Status pill
// ---------------------------------------------------------------------------

function StatusPill({ status }: { status: string }) {
  return (
    <Badge
      variant="outline"
      className={cn("text-xs whitespace-nowrap", transferStatusClass(status))}
    >
      {status === "DISPUTED" && <AlertTriangle className="mr-1 h-3 w-3" />}
      {transferStatusLabel(status)}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Needs-attention: only DISPUTED is reliably signal from list API
// ---------------------------------------------------------------------------

function needsAttention(t: TransferRow): boolean {
  return t.status === "DISPUTED";
}

function NeedsAttentionIcon({ transfer }: { transfer: TransferRow }) {
  if (transfer.status !== "DISPUTED") return null;
  return (
    <span title="Disputed" className="inline-flex items-center text-red-500">
      <AlertTriangle className="h-3.5 w-3.5" />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Age display — relative time since created_at for IN_TRANSIT transfers
// ---------------------------------------------------------------------------

function ageDisplay(t: TransferRow): string {
  if (t.status !== "IN_TRANSIT") return "—";
  const sentMs = new Date(t.handed_over_at ?? t.created_at).getTime();
  if (!Number.isFinite(sentMs)) return "—";
  const totalMinutes = Math.floor((Date.now() - sentMs) / 60_000);
  if (totalMinutes < 0) return "—";
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ---------------------------------------------------------------------------
// Query string builder — aligned with API filter params
// ---------------------------------------------------------------------------

function buildQs(opts: {
  from: string;
  to: string;
  status: string;
  currency: string;
  q: string;
  page: number;
}): string {
  const p = new URLSearchParams();
  if (opts.from) p.set("from", opts.from);
  if (opts.to) p.set("to", opts.to);
  if (opts.status && opts.status !== "all") p.set("status", opts.status);
  if (opts.currency && opts.currency !== "all") p.set("currency", opts.currency);
  if (opts.q.trim()) p.set("q", opts.q.trim());
  p.set("page", String(opts.page));
  return p.toString();
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function CashTransfers() {
  const { t } = useTranslation();
  const [, navigate] = useLocation();
  const search = useSearch();

  // Panel state
  const [panelId, setPanelId] = useState<number | null>(null);

  // ---- URL-synced filter + page state ------------------------------------
  const params = new URLSearchParams(search);
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  const currency = params.get("currency") ?? "";
  const status = params.get("status") ?? "";
  const q = params.get("q") ?? "";
  const page = Math.max(1, parseInt(params.get("page") ?? "1", 10) || 1);

  function updateParams(updates: Record<string, string | null>, resetPage = true) {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(updates)) {
      if (v == null || v === "") next.delete(k);
      else next.set(k, v);
    }
    if (resetPage) next.delete("page");
    const qs = next.toString();
    navigate(`/cash-transfers${qs ? `?${qs}` : ""}`, { replace: true });
  }

  const setFilter = (key: string, value: string) =>
    updateParams({ [key]: value === "all" ? null : value });

  const clearFilters = () =>
    updateParams({ from: null, to: null, currency: null, status: null, q: null });

  const hasActiveFilters =
    !!from ||
    !!to ||
    !!(currency && currency !== "all") ||
    !!(status && status !== "all") ||
    q.trim() !== "";

  // ---- Query -------------------------------------------------------------
  const qs = buildQs({ from, to, status, currency, q, page });

  const {
    data: transfersData,
    isLoading,
    isError,
    refetch,
  } = useQuery<TransfersResponse>({
    queryKey: ["cash-transfers", qs],
    queryFn: () => apiFetch(`/api/cash-transfers?${qs}`),
    staleTime: 30_000,
  });

  const transfers = transfersData?.transfers ?? [];
  const totalCount = transfersData?.total ?? 0;
  const pageSize = transfersData?.pageSize ?? 20;
  const totalPages = transfersData?.totalPages ?? Math.max(1, Math.ceil(totalCount / pageSize));

  // ---- Attention items ---------------------------------------------------
  const attentionCount = transfers.filter(needsAttention).length;

  // ---- Render ------------------------------------------------------------
  return (
    <div className="space-y-5 p-4 md:p-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <ArrowLeftRight className="h-6 w-6" />
            {t("nav.cashTransfers")}
          </h1>
          <p className="text-sm text-muted-foreground">
            Monitor all cash transfers across locations and sessions.
          </p>
        </div>
      </div>

      {/* Needs Attention Banner */}
      {attentionCount > 0 && (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="flex items-center gap-3 py-3 px-4">
            <AlertTriangle className="h-4 w-4 shrink-0 text-red-600" />
            <p className="text-sm font-medium text-red-800">
              {attentionCount === 1
                ? "1 disputed transfer needs attention"
                : `${attentionCount} disputed transfers need attention`}
            </p>
          </CardContent>
        </Card>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Date range */}
        <Input
          type="date"
          className="h-8 w-36 text-xs"
          value={from}
          onChange={(e) => updateParams({ from: e.target.value || null })}
          aria-label="From date"
        />
        <span className="text-xs text-muted-foreground">–</span>
        <Input
          type="date"
          className="h-8 w-36 text-xs"
          value={to}
          onChange={(e) => updateParams({ to: e.target.value || null })}
          aria-label="To date"
        />

        {/* Status */}
        <Select value={status || "all"} onValueChange={(v) => setFilter("status", v)}>
          <SelectTrigger className="h-8 w-32 text-xs">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            <SelectItem value="IN_TRANSIT">In transit</SelectItem>
            <SelectItem value="COMPLETED">Completed</SelectItem>
            <SelectItem value="DISPUTED">Disputed</SelectItem>
            <SelectItem value="RETURNED">Returned</SelectItem>
          </SelectContent>
        </Select>

        {/* Currency */}
        <Select value={currency || "all"} onValueChange={(v) => setFilter("currency", v)}>
          <SelectTrigger className="h-8 w-28 text-xs">
            <SelectValue placeholder="Currency" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All currencies</SelectItem>
            <SelectItem value="AED">AED</SelectItem>
            <SelectItem value="USD">USD</SelectItem>
            <SelectItem value="LBP">LBP</SelectItem>
          </SelectContent>
        </Select>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            className="h-8 w-48 pl-7 text-xs"
            placeholder="Search transfer #…"
            value={q}
            onChange={(e) => updateParams({ q: e.target.value || null })}
          />
          {q && (
            <button
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground"
              onClick={() => updateParams({ q: null })}
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        {hasActiveFilters && (
          <Button variant="ghost" size="sm" className="h-8 text-xs" onClick={clearFilters}>
            Clear filters
          </Button>
        )}
      </div>

      {/* Table / Empty / Error */}
      {isError ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-10">
            <p className="text-sm text-muted-foreground">Failed to load transfers.</p>
            <Button variant="outline" onClick={() => void refetch()}>Retry</Button>
          </CardContent>
        </Card>
      ) : isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : transfers.length === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <ArrowLeftRight className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">
              {hasActiveFilters ? "No transfers match your filters." : "No transfers yet."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Desktop / tablet — horizontal scroll, sticky first column */}
          <div className="hidden overflow-x-auto rounded-lg border sm:block">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/30 text-left text-xs uppercase text-muted-foreground">
                  <th className="sticky left-0 z-10 bg-muted/30 py-2.5 pl-4 pr-3 font-medium">
                    Transfer #
                  </th>
                  <th className="py-2.5 pr-3 font-medium">Sent at</th>
                  <th className="py-2.5 pr-3 font-medium">Source</th>
                  <th className="py-2.5 pr-3 font-medium">Destination</th>
                  <th className="py-2.5 pr-3 font-medium">Amount</th>
                  <th className="py-2.5 pr-3 font-medium">Carried by</th>
                  <th className="py-2.5 pr-3 font-medium">Intended receiver</th>
                  <th className="py-2.5 pr-3 font-medium">Status</th>
                  <th className="py-2.5 pr-3 font-medium">Age</th>
                  <th className="py-2.5 pr-4 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {transfers.map((t) => (
                  <tr
                    key={t.id}
                    onClick={() => setPanelId(t.id)}
                    className={cn(
                      "cursor-pointer border-b transition-colors last:border-0 hover:bg-muted/30",
                      needsAttention(t) && "border-l-2 border-l-red-400",
                    )}
                  >
                    {/* Transfer # — sticky */}
                    <td className="sticky left-0 z-10 bg-background py-2.5 pl-4 pr-3 font-mono text-xs font-medium">
                      <div className="flex items-center gap-1.5">
                        <NeedsAttentionIcon transfer={t} />
                        #{t.transfer_number}
                      </div>
                    </td>
                    {/* Sent at */}
                    <td className="py-2.5 pr-3 whitespace-nowrap text-xs text-muted-foreground">
                      {formatDateTime(t.handed_over_at ?? t.created_at)}
                    </td>
                    {/* Source */}
                    <td className="py-2.5 pr-3">
                      <p className="font-medium">{t.source_drawer_name ?? "—"}</p>
                      {t.source_location_name && (
                        <p className="text-xs text-muted-foreground">{t.source_location_name}</p>
                      )}
                    </td>
                    {/* Destination */}
                    <td className="py-2.5 pr-3">
                      <p className="font-medium">{t.destination_drawer_name ?? "—"}</p>
                      {t.destination_location_name && (
                        <p className="text-xs text-muted-foreground">{t.destination_location_name}</p>
                      )}
                    </td>
                    {/* Amount */}
                    <td className="py-2.5 pr-3 font-medium whitespace-nowrap">
                      {formatCashMoney(t.sent_amount, t.currency_code)}
                    </td>
                    {/* Carried by */}
                    <td className="py-2.5 pr-3 text-sm">
                      {t.external_carrier_name ?? (t.carrier_user_id ? "Internal" : "—")}
                    </td>
                    {/* Intended receiver */}
                    <td className="py-2.5 pr-3 text-sm">
                      {t.intended_receiver_user_id ? "Assigned" : "—"}
                    </td>
                    {/* Status */}
                    <td className="py-2.5 pr-3">
                      <StatusPill status={t.status} />
                    </td>
                    {/* Age */}
                    <td className="py-2.5 pr-3 text-sm whitespace-nowrap">
                      {ageDisplay(t)}
                    </td>
                    {/* Action */}
                    <td
                      className="py-2.5 pr-4 text-right"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <div className="flex justify-end gap-1.5">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-xs"
                          onClick={() => setPanelId(t.id)}
                        >
                          View
                        </Button>
                        {t.status === "IN_TRANSIT" && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2 text-xs"
                            onClick={() => navigate(`/cash-transfers/${t.id}`)}
                          >
                            Confirm receipt
                          </Button>
                        )}
                        {t.status === "DISPUTED" && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2 text-xs border-red-200 text-red-700 hover:bg-red-50"
                            onClick={() => navigate(`/cash-transfers/${t.id}`)}
                          >
                            Resolve dispute
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile stacked cards */}
          <div className="flex flex-col gap-3 sm:hidden">
            {transfers.map((t) => (
              <Card
                key={t.id}
                onClick={() => setPanelId(t.id)}
                className={cn(
                  "cursor-pointer transition-shadow hover:shadow-sm",
                  needsAttention(t) && "border-l-4 border-l-red-400",
                )}
              >
                <CardContent className="flex flex-col gap-2 p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <NeedsAttentionIcon transfer={t} />
                      <span className="font-mono text-xs font-medium">#{t.transfer_number}</span>
                    </div>
                    <StatusPill status={t.status} />
                  </div>
                  <div className="flex items-center gap-1.5 text-sm">
                    <span className="font-medium">{t.source_drawer_name ?? "—"}</span>
                    <ArrowLeftRight className="h-3 w-3 text-muted-foreground" />
                    <span className="font-medium">{t.destination_drawer_name ?? "—"}</span>
                  </div>
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-bold">{formatCashMoney(t.sent_amount, t.currency_code)}</span>
                    <span className="text-xs text-muted-foreground">
                      {formatDateTime(t.handed_over_at ?? t.created_at)}
                    </span>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between pt-2 text-sm text-muted-foreground">
              <span>
                Showing {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, totalCount)} of {totalCount}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 w-7 p-0"
                  disabled={page <= 1}
                  onClick={() => updateParams({ page: String(page - 1) }, false)}
                  aria-label="Previous page"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
                <span className="px-2 text-xs">
                  Page {page} of {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 w-7 p-0"
                  disabled={page >= totalPages}
                  onClick={() => updateParams({ page: String(page + 1) }, false)}
                  aria-label="Next page"
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Transfer Detail Side Panel */}
      <TransferDetailPanel
        transferId={panelId}
        open={panelId != null}
        onClose={() => setPanelId(null)}
      />
    </div>
  );
}
