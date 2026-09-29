import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useSearch, useLocation } from "wouter";
import {
  Download, ChevronRight, Loader2,
  RefreshCw, ChevronLeft, FileText,
  TrendingUp, Percent, DollarSign, ShoppingCart, BarChart2,
  Search, ChevronDown,
} from "lucide-react";
import { imageUrl } from "@/lib/imageUrl";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, getClerkToken } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { DateRangePicker, getPresetDates, type DateRangeValue } from "@/components/ui/date-range-picker";
import { toast } from "@/hooks/use-toast";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";

// ── Constants ─────────────────────────────────────────────────────────────────

const PAYMENT_METHODS = ["cash", "card", "bank_transfer", "whish", "other"];
const HISTORY_PAGE_SIZE = 25;

// ── Types ─────────────────────────────────────────────────────────────────────

type LineItem = {
  product_id?: number | null;
  name: string;
  qty: number;
  unit_price: number;
  discount?: number;
  image_url?: string | null;
  description?: string | null;
  item_type?: "shelf" | "custom";
  quantity?: number;
};

type AuditSale = {
  id: string;
  fulfilment_date: string | null;
  reporting_date: string;
  created_at: string;
  line_items: LineItem[];
  total: string;
  payment_method: string | null;
};

type AuditTotals = { gross: string; net: string; vat: string };

type AuditResponse = {
  sales: AuditSale[];
  totals: AuditTotals;
  total: number;
  limit: number;
  offset: number;
};

// ── Shared helpers ─────────────────────────────────────────────────────────────

function getSaleNumber(id: string) {
  // Extract trailing numeric run from UUID, pad to at least 5 digits, prefix with CMC-
  const digits = id.replace(/-/g, "").match(/(\d+)$/)?.[1] ?? id.replace(/\D/g, "").slice(-8);
  const numeric = digits ? parseInt(digits, 16) % 100000 : 0;
  return `CMC-${String(numeric).padStart(5, "0")}`;
}

function formatDateOnly(dateStr: string) {
  const bare = dateStr.split("T")[0];
  const [year, month, day] = bare.split("-").map(Number);
  if (!year || !month || !day) return dateStr;
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric",
  });
}

function formatReportingTime(iso: string) {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: CMC_REPORTING_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

function formatMoney(n: number): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function computeNet(gross: number): number { return gross / (1 + 0.11); }
function computeVat(gross: number): number { return gross - computeNet(gross); }

function formatPaymentMethod(s: string | null | undefined): string {
  if (!s) return "—";
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function formatLastUpdated(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) +
    ", " + d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

// ── Preset helpers ─────────────────────────────────────────────────────────────

const CMC_REPORTING_TIMEZONE = "Asia/Beirut";

/**
 * Resolve the initial date range from URL params.
 * When the URL carries no from/to at all, default to month-to-date
 * ("this month" preset). Any explicit URL range is kept as-is.
 */
export function resolveInitialRange(urlFrom: string, urlTo: string): { from: string; to: string } {
  if (!urlFrom && !urlTo) {
    return getPresetDates("this_month", { timezone: CMC_REPORTING_TIMEZONE });
  }
  return { from: urlFrom, to: urlTo };
}

// ── Summary stat row ─────────────────────────────────────────────────────────────

function AuditSummaryCards({ totals, totalCount }: { totals: AuditTotals | undefined; totalCount: number }) {
  const gross = totals ? parseFloat(totals.gross) : 0;
  const net = totals ? parseFloat(totals.net) : 0;
  const vat = totals ? parseFloat(totals.vat) : 0;
  const avgOrder = totalCount > 0 ? gross / totalCount : 0;
  const vatPct = net > 0 ? ((vat / net) * 100).toFixed(0) : "11";

  const stats = [
    {
      icon: <TrendingUp className="h-4 w-4 text-teal-600" />,
      label: "Net sales",
      value: `$${formatMoney(net)}`,
      sub: "Excluding VAT",
      accent: true,
    },
    {
      icon: <Percent className="h-4 w-4 text-muted-foreground" />,
      label: "VAT",
      value: `$${formatMoney(vat)}`,
      sub: `${vatPct}% of net sales`,
      accent: false,
    },
    {
      icon: <DollarSign className="h-4 w-4 text-teal-600" />,
      label: "Gross sales",
      value: `$${formatMoney(gross)}`,
      sub: "Including VAT",
      accent: true,
    },
    {
      icon: <ShoppingCart className="h-4 w-4 text-muted-foreground" />,
      label: "Transactions",
      value: String(totalCount),
      sub: "Orders",
      accent: false,
    },
    {
      icon: <BarChart2 className="h-4 w-4 text-muted-foreground" />,
      label: "Avg. order",
      value: `$${formatMoney(avgOrder)}`,
      sub: "Gross average",
      accent: false,
    },
  ];

  return (
    <div className="flex divide-x border rounded-lg bg-card overflow-hidden">
      {stats.map((s, i) => (
        <div key={i} className="flex-1 flex items-center gap-3 px-4 py-3 min-w-0">
          <div className="shrink-0 h-8 w-8 rounded-md bg-muted flex items-center justify-center">
            {s.icon}
          </div>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground truncate">{s.label}</p>
            <p className={`text-base font-bold truncate ${s.accent ? "text-teal-700" : ""}`}>{s.value}</p>
            <p className="text-xs text-muted-foreground truncate">{s.sub}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-12 w-full rounded" />)}
    </div>
  );
}

// ── Filter bar ────────────────────────────────────────────────────────────────

type FilterState = {
  localFrom: string;
  localTo: string;
  paymentMethod: string;
  search: string;
};

type HistoryFilterBarProps = {
  filter: FilterState;
  onFilterChange: (patch: Partial<FilterState>) => void;
  onApply: (patch?: Partial<FilterState>) => void;
  onExport: () => void;
  isExporting: boolean;
  noRecords: boolean;
};

export function HistoryFilterBar({
  filter,
  onFilterChange,
  onApply,
  onExport,
  isExporting,
  noRecords,
}: HistoryFilterBarProps) {
  const { t } = useTranslation();

  function handlePaymentChange(v: string) {
    const patch = { paymentMethod: v === "__all" ? "" : v };
    onFilterChange(patch);
    onApply(patch);
  }

  function handleSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      onApply();
    }
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {/* One controlled date-range entry point. Draft changes stay inside the picker until Apply. */}
      <DateRangePicker
        value={{ from: filter.localFrom, to: filter.localTo }}
        onApply={(range: DateRangeValue) => onApply({ localFrom: range.from, localTo: range.to })}
        timezone={CMC_REPORTING_TIMEZONE}
        allowClear={false}
        compact
        data-testid="input-cmc-history-date-range"
      />

      {/* Payment method */}
      <Select value={filter.paymentMethod || "__all"} onValueChange={handlePaymentChange}>
        <SelectTrigger className="h-9 text-sm w-36" data-testid="select-cmc-history-payment-method"><SelectValue placeholder="All methods" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="__all">All methods</SelectItem>
          {PAYMENT_METHODS.map((m) => (
            <SelectItem key={m} value={m}>{t(`cmcPos.sale.pm.${m}`, { defaultValue: m })}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Order ID search */}
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
        <Input
          value={filter.search}
          onChange={(e) => onFilterChange({ search: e.target.value })}
          onKeyDown={handleSearchKeyDown}
          aria-label="Search history"
          data-testid="input-cmc-history-search"
          placeholder="Search…"
          className="h-9 text-sm pl-8 w-36"
        />
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Export split button */}
      <div className="flex items-center">
        <Button
          size="sm"
          className="h-9 rounded-r-none bg-teal-700 hover:bg-teal-800 text-white border-r border-teal-600 pe-3"
          onClick={onExport}
          disabled={noRecords || isExporting}
          data-testid="btn-export-csv"
        >
          {isExporting ? <Loader2 className="me-1.5 h-3.5 w-3.5 animate-spin" /> : <Download className="me-1.5 h-3.5 w-3.5" />}
          {isExporting ? "Exporting…" : "Export"}
        </Button>
        <Button
          size="sm"
          className="h-9 rounded-l-none bg-teal-700 hover:bg-teal-800 text-white px-2"
          disabled={noRecords || isExporting}
          aria-label="Export options"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

// ── Items cell ─────────────────────────────────────────────────────────────────

function ItemsCell({ items }: { items: LineItem[] }) {
  const first = items[0];
  if (!first) return <span className="text-muted-foreground text-sm">—</span>;
  const imgSrc = first.image_url ? imageUrl(first.image_url) : null;
  const extra = items.length - 1;
  return (
    <div className="flex items-center gap-2">
      {imgSrc ? (
        <img src={imgSrc} alt="" className="h-9 w-9 rounded object-cover border border-border shrink-0"
          onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }} />
      ) : (
        <div className="h-9 w-9 rounded bg-muted shrink-0 border border-border flex items-center justify-center">
          <FileText className="h-3.5 w-3.5 text-muted-foreground" />
        </div>
      )}
      <div className="min-w-0">
        <p className="text-sm truncate max-w-[140px] capitalize">{first.name}</p>
        {extra > 0 && <p className="text-xs text-muted-foreground">+{extra} more</p>}
      </div>
    </div>
  );
}

// ── HistoryTab ────────────────────────────────────────────────────────────────

type AppliedFilter = {
  from: string;
  to: string;
  paymentMethod: string;
  search: string;
};

export function buildAuditQueryParams(
  filter: AppliedFilter,
  pagination?: { limit: number; offset: number },
): URLSearchParams {
  const params = new URLSearchParams();
  if (filter.from) params.set("from", filter.from);
  if (filter.to) params.set("to", filter.to);
  if (filter.paymentMethod) params.set("payment_method", filter.paymentMethod);
  if (filter.search) params.set("search", filter.search);
  if (pagination) {
    params.set("limit", String(pagination.limit));
    params.set("offset", String(pagination.offset));
  }
  return params;
}

export function buildHistoryFilterUrl(filter: FilterState): string {
  const params = new URLSearchParams();
  if (filter.localFrom) params.set("from", filter.localFrom);
  if (filter.localTo) params.set("to", filter.localTo);
  if (filter.paymentMethod) params.set("payment_method", filter.paymentMethod);
  if (filter.search) params.set("search", filter.search);
  const query = params.toString();
  return `/cmc-pos/sales${query ? `?${query}` : ""}`;
}

function HistoryTab({ appliedFilter, onExport, isExporting }: {
  appliedFilter: AppliedFilter;
  onExport: () => void;
  isExporting: boolean;
}) {
  const { t } = useTranslation();
  const search = useSearch();
  const [, navigate] = useLocation();

  const searchParams = new URLSearchParams(search);
  const urlPage = Math.max(1, parseInt(searchParams.get("page") ?? "1"));
  const pageSize = HISTORY_PAGE_SIZE;
  const offset = (urlPage - 1) * pageSize;

  function navToPage(page: number) {
    const next = new URLSearchParams(search);
    if (page <= 1) next.delete("page"); else next.set("page", String(page));
    navigate(`/cmc-pos/sales?${next.toString()}`);
  }

  const apiQuery = buildAuditQueryParams(appliedFilter, { limit: pageSize, offset }).toString();

  const hasDateRange = !!(appliedFilter.from && appliedFilter.to);

  const { data, isLoading, isError, refetch, dataUpdatedAt } = useQuery<AuditResponse>({
    queryKey: ["cmc-pos-history", appliedFilter.from, appliedFilter.to, appliedFilter.paymentMethod, appliedFilter.search, urlPage, pageSize],
    queryFn: () => apiFetch<AuditResponse>(`/api/cmc-pos/audit?${apiQuery}`),
    placeholderData: (prev) => prev,
    enabled: hasDateRange,
  });

  const sales = data?.sales ?? [];
  const totals = data?.totals;
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // Redirect to last page if current exceeds available pages
  useEffect(() => {
    if (!isLoading && !isError && data && urlPage > totalPages) navToPage(totalPages);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, isError, totalPages, urlPage]);

  return (
    <div className="space-y-4">
      {/* KPI stat row */}
      <AuditSummaryCards
        totals={totals}
        totalCount={total}
      />

      {/* Prompt: no date range selected */}
      {!hasDateRange && (
        <div className="rounded-lg border bg-card p-8 text-center">
          <p className="text-sm text-muted-foreground">Select a date range to view history.</p>
        </div>
      )}

      {/* Loading skeleton */}
      {hasDateRange && isLoading && (
        <div className="rounded-lg border bg-card p-6"><TableSkeleton /></div>
      )}

      {/* Error */}
      {hasDateRange && isError && (
        <div className="rounded-lg border bg-card p-8 flex flex-col items-center gap-3 text-center">
          <p className="text-sm text-destructive">Failed to load history.</p>
          <Button size="sm" variant="outline" onClick={() => refetch()}>
            <RefreshCw className="h-3.5 w-3.5 me-1.5" />Retry
          </Button>
        </div>
      )}

      {/* Empty */}
      {hasDateRange && !isLoading && !isError && sales.length === 0 && (
        <div className="rounded-lg border bg-card p-8 text-center">
          <p className="text-sm text-muted-foreground">
            {t("cmcPos.salesHistory.empty", { defaultValue: "No sales found for this filter." })}
          </p>
        </div>
      )}

      {/* Transaction count + last-updated */}
      {hasDateRange && !isLoading && !isError && sales.length > 0 && (
        <p className="text-sm font-medium">
          {total} transactions{" "}
          {dataUpdatedAt > 0 && (
            <span className="font-normal text-muted-foreground">
              Updated {formatLastUpdated(dataUpdatedAt)}
            </span>
          )}
        </p>
      )}

      {/* Table */}
      {hasDateRange && !isLoading && !isError && sales.length > 0 && (
        <div className="rounded-lg border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date &amp; Time (Beirut)</TableHead>
                <TableHead>Order ID</TableHead>
                <TableHead>Items</TableHead>
                <TableHead>Payment</TableHead>
                <TableHead className="text-end">Net</TableHead>
                <TableHead className="text-end">VAT</TableHead>
                <TableHead className="text-end">Gross</TableHead>
                <TableHead className="w-8" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sales.map((sale) => {
                const dateStr = formatDateOnly(sale.reporting_date);
                const timeStr = sale.created_at ? formatReportingTime(sale.created_at) : "";
                const gross = parseFloat(sale.total ?? "0");
                const net = computeNet(gross);
                const vat = computeVat(gross);
                return (
                  <TableRow key={sale.id} className="hover:bg-muted/30">
                    <TableCell className="text-sm whitespace-nowrap">
                      <div>{dateStr}</div>
                      {timeStr && <div className="text-xs text-muted-foreground">{timeStr}</div>}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{getSaleNumber(sale.id)}</TableCell>
                    <TableCell><ItemsCell items={sale.line_items ?? []} /></TableCell>
                    <TableCell className="text-sm">{formatPaymentMethod(sale.payment_method)}</TableCell>
                    <TableCell className="text-end text-sm font-medium">${formatMoney(net)}</TableCell>
                    <TableCell className="text-end text-sm text-muted-foreground">${formatMoney(vat)}</TableCell>
                    <TableCell className="text-end text-sm font-semibold text-teal-700">${formatMoney(gross)}</TableCell>
                    <TableCell className="text-muted-foreground">
                      <ChevronRight className="h-4 w-4" />
                    </TableCell>
                  </TableRow>
                );
              })}

              {/* Period total row */}
              {totals && (
                <TableRow className="bg-muted/30 font-semibold">
                  <TableCell colSpan={4} className="text-sm">Period total</TableCell>
                  <TableCell className="text-end text-sm">${formatMoney(parseFloat(totals.net))}</TableCell>
                  <TableCell className="text-end text-sm">${formatMoney(parseFloat(totals.vat))}</TableCell>
                  <TableCell className="text-end text-sm text-teal-700">${formatMoney(parseFloat(totals.gross))}</TableCell>
                  <TableCell />
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Pagination */}
      {total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Left: count */}
          <span className="text-sm text-muted-foreground">
            {`${offset + 1}–${Math.min(offset + pageSize, total)} of ${total}`}
          </span>
          {/* Right: page buttons */}
          <div className="flex items-center gap-1">
            <Button variant="outline" size="sm" className="h-8 w-8 p-0" disabled={urlPage <= 1} onClick={() => navToPage(urlPage - 1)}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            {buildPageNums(urlPage, totalPages).map((p, i) =>
              p === "…" ? (
                <span key={`e-${i}`} className="px-1 text-sm text-muted-foreground select-none">…</span>
              ) : (
                <Button key={p} variant={p === urlPage ? "default" : "outline"} size="sm"
                  className={`h-8 w-8 text-xs ${p === urlPage ? "bg-teal-700 hover:bg-teal-800 border-teal-700" : ""}`}
                  onClick={() => navToPage(p as number)}>
                  {p}
                </Button>
              )
            )}
            <Button variant="outline" size="sm" className="h-8 w-8 p-0" disabled={urlPage >= totalPages} onClick={() => navToPage(urlPage + 1)}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function buildPageNums(current: number, total: number): (number | "…")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages: (number | "…")[] = [];
  const delta = 2;
  const rangeStart = Math.max(2, current - delta);
  const rangeEnd = Math.min(total - 1, current + delta);
  pages.push(1);
  if (rangeStart > 2) pages.push("…");
  for (let i = rangeStart; i <= rangeEnd; i++) pages.push(i);
  if (rangeEnd < total - 1) pages.push("…");
  pages.push(total);
  return pages;
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function CmcPosSalesPage() {
  const { loaded } = useWorkspaceRole();
  const [, navigate] = useLocation();
  const search = useSearch();
  const searchParams = new URLSearchParams(search);
  const [isExporting, setIsExporting] = useState(false);

  const urlFrom = searchParams.get("from") ?? "";
  const urlTo = searchParams.get("to") ?? "";
  const urlPaymentMethod = searchParams.get("payment_method") ?? "";
  const urlSearch = searchParams.get("search") ?? "";

  // Default to month-to-date when the URL carries no explicit range
  const initialRange = resolveInitialRange(urlFrom, urlTo);

  const [localFilter, setLocalFilter] = useState<FilterState>({
    localFrom: initialRange.from,
    localTo: initialRange.to,
    paymentMethod: urlPaymentMethod,
    search: urlSearch,
  });

  // Sync local filter when URL changes externally (e.g. browser back)
  useEffect(() => {
    const range = resolveInitialRange(urlFrom, urlTo);
    setLocalFilter({
      localFrom: range.from,
      localTo: range.to,
      paymentMethod: urlPaymentMethod,
      search: urlSearch,
    });
    setAppliedFilter({
      from: range.from,
      to: range.to,
      paymentMethod: urlPaymentMethod,
      search: urlSearch,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlFrom, urlTo, urlPaymentMethod, urlSearch]);

  const [appliedFilter, setAppliedFilter] = useState<AppliedFilter>({
    from: initialRange.from,
    to: initialRange.to,
    paymentMethod: urlPaymentMethod,
    search: urlSearch,
  });

  // applyFilters merges an optional immediate patch (for cases where the state
  // update hasn't flushed yet when calling immediately after onFilterChange)
  function applyFilters(patch?: Partial<FilterState>) {
    const merged = patch ? { ...localFilter, ...patch } : localFilter;
    navigate(buildHistoryFilterUrl(merged));
    setAppliedFilter({
      from: merged.localFrom,
      to: merged.localTo,
      paymentMethod: merged.paymentMethod,
      search: merged.search,
    });
  }

  async function handleExportCsv() {
    if (isExporting) return;
    setIsExporting(true);
    try {
      const p = buildAuditQueryParams(appliedFilter);
      const url = `/api/cmc-pos/audit/export?${p.toString()}`;
      const token = await getClerkToken();
      const response = await fetch(url, {
        credentials: "include",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) throw new Error(`Export failed: ${response.statusText}`);
      const blob = await response.blob();
      const rangeLabel = appliedFilter.from === appliedFilter.to
        ? (appliedFilter.from || "all")
        : `${appliedFilter.from || "start"}_${appliedFilter.to || "end"}`;
      const filename = `cmc-history-${rangeLabel}.csv`;
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl; anchor.download = filename;
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      URL.revokeObjectURL(objectUrl);
      toast({ title: "Export complete", description: `${filename} downloaded.` });
    } catch {
      toast({ title: "Export failed. Please try again.", variant: "destructive" });
    } finally {
      setIsExporting(false);
    }
  }

  const noRecords = !appliedFilter.from || !appliedFilter.to;

  if (!loaded) return null;

  return (
    <div className="space-y-6 p-6">
      {/* Toolbar */}
      <HistoryFilterBar
        filter={localFilter}
        onFilterChange={(patch) => setLocalFilter((prev) => ({ ...prev, ...patch }))}
        onApply={applyFilters}
        onExport={handleExportCsv}
        isExporting={isExporting}
        noRecords={noRecords}
      />

      {/* History table + KPIs */}
      <HistoryTab
        appliedFilter={appliedFilter}
        onExport={handleExportCsv}
        isExporting={isExporting}
      />
    </div>
  );
}
