import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  FileText,
  CalendarDays,
  DollarSign,
  Clock,
  Download,
  FileDown,
  Search,
} from "lucide-react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DateRangePicker, type DateRangeValue } from "@/components/ui/date-range-picker";
import { useToast } from "@/hooks/use-toast";
import {
  useInvoiceList,
  useInvalidateInvoiceList,
  downloadInvoicePdf,
  exportInvoicesCsv,
  type InvoiceRow,
  type InvoiceSummary,
} from "./invoices-queries";
import { CreateInvoiceButton } from "./CreateInvoiceDialog";

const FILTER_CURRENCIES = ["AED", "USD", "EUR", "GBP", "SAR"] as const;
const PAGE_SIZE = 20;

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function pageNumbers(current: number, total: number): Array<number | "…"> {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages = new Set<number>([1, total, current - 1, current, current + 1]);
  if (current <= 3) [2, 3, 4].forEach((p) => pages.add(p));
  if (current >= total - 2) [total - 3, total - 2, total - 1].forEach((p) => pages.add(p));
  const sorted = [...pages].filter((p) => p >= 1 && p <= total).sort((a, b) => a - b);
  const out: Array<number | "…"> = [];
  let prev = 0;
  for (const p of sorted) {
    if (prev && p - prev > 1) out.push("…");
    out.push(p);
    prev = p;
  }
  return out;
}

function formatDateTime(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  const date = d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return { date, time };
}

function formatAmount(amount: number | string | null, currency: string): string {
  if (amount === null) return "—";
  const num = typeof amount === "string" ? parseFloat(amount) : amount;
  if (isNaN(num)) return "—";
  return `${num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}

function formatSummaryValue(value: number | null | undefined, currency?: string): string {
  if (value == null) return currency ? "—" : "0";
  if (currency) {
    return `${value.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return value.toLocaleString();
}

// ── Summary stat card ──────────────────────────────────────────────────────────
function StatCard({
  title,
  value,
  sub,
  icon: Icon,
  isLoading,
}: {
  title: string;
  value: string;
  sub?: string;
  icon: React.ElementType;
  isLoading: boolean;
}) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <p className="text-sm text-muted-foreground">{title}</p>
            {isLoading ? (
              <div className="h-8 w-28 rounded bg-muted animate-pulse mt-1" />
            ) : (
              <p className="text-2xl font-bold mt-1 truncate">{value}</p>
            )}
            {sub && !isLoading && (
              <p className="text-xs text-muted-foreground mt-0.5 truncate">{sub}</p>
            )}
          </div>
          <div className="p-3 rounded-full bg-secondary shrink-0 ms-3">
            <Icon size={18} className="text-muted-foreground" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ── Table skeleton ─────────────────────────────────────────────────────────────
function TableSkeleton({ rows = 8 }: { rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }).map((_, i) => (
        <TableRow key={i}>
          {Array.from({ length: 7 }).map((__, j) => (
            <TableCell key={j}>
              <div className="h-4 rounded bg-muted animate-pulse" style={{ width: j === 6 ? 32 : "80%" }} />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  );
}

// ── Download button ────────────────────────────────────────────────────────────
function DownloadCell({ row }: { row: InvoiceRow }) {
  const { toast } = useToast();
  const [loading, setLoading] = useState(false);
  const { t } = useTranslation();

  async function handleDownload() {
    if (loading) return;
    setLoading(true);
    try {
      await downloadInvoicePdf(row.id);
    } catch {
      toast({
        title: t("invoices.downloadError"),
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-8 w-8"
      onClick={handleDownload}
      disabled={loading}
      title={t("invoices.downloadPdf")}
    >
      <FileDown className="h-4 w-4" />
    </Button>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────
export default function Invoices() {
  const { t } = useTranslation();
  const { toast } = useToast();

  const [searchInput, setSearchInput] = useState("");
  const [dateRange, setDateRange] = useState<Partial<DateRangeValue>>({});
  const [currency, setCurrency] = useState("all");
  const [page, setPage] = useState(1);
  const [exporting, setExporting] = useState(false);

  const debouncedSearch = useDebounced(searchInput);

  // Reset to page 1 when filters change
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, dateRange, currency]);

  const queryParams = {
    search: debouncedSearch || undefined,
    dateFrom: dateRange.from,
    dateTo: dateRange.to,
    currency: currency === "all" ? undefined : currency,
    page,
    page_size: PAGE_SIZE,
  };

  const { data, isLoading, isFetching } = useInvoiceList(queryParams);
  const invalidate = useInvalidateInvoiceList();

  const summary: InvoiceSummary = data?.summary ?? {
    total: 0,
    this_month: 0,
    total_value: null,
    last_created_at: null,
  };
  const items = data?.items ?? [];
  const totalPages = data?.total_pages ?? 1;
  const total = data?.total ?? 0;

  async function handleExportCsv() {
    if (exporting) return;
    setExporting(true);
    try {
      await exportInvoicesCsv({
        search: debouncedSearch || undefined,
        dateFrom: dateRange.from,
        dateTo: dateRange.to,
        currency: currency === "all" ? undefined : currency,
      });
    } catch {
      toast({
        title: t("invoices.exportError"),
        variant: "destructive",
      });
    } finally {
      setExporting(false);
    }
  }

  const lastCreatedDisplay = summary.last_created_at
    ? formatDateTime(summary.last_created_at).date
    : "—";

  const rangeStart = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const rangeEnd = Math.min(page * PAGE_SIZE, total);

  return (
    <div className="space-y-6 p-6">
      {/* Page header */}
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="rounded-lg bg-muted p-2">
            <FileText className="h-5 w-5 text-muted-foreground" />
          </div>
          <div>
            <h1 className="text-xl font-semibold text-foreground">{t("invoices.title")}</h1>
            <p className="text-sm text-muted-foreground">{t("invoices.subtitle")}</p>
          </div>
        </div>
        <CreateInvoiceButton onSuccess={invalidate} />
      </div>

      {/* Summary metric cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          title={t("invoices.statTotal")}
          value={formatSummaryValue(summary.total)}
          icon={FileText}
          isLoading={isLoading}
        />
        <StatCard
          title={t("invoices.statThisMonth")}
          value={formatSummaryValue(summary.this_month)}
          icon={CalendarDays}
          isLoading={isLoading}
        />
        <StatCard
          title={t("invoices.statTotalValue")}
          value={formatSummaryValue(summary.total_value)}
          sub={currency ? currency : t("invoices.allCurrencies")}
          icon={DollarSign}
          isLoading={isLoading}
        />
        <StatCard
          title={t("invoices.statLastCreated")}
          value={lastCreatedDisplay}
          icon={Clock}
          isLoading={isLoading}
        />
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-48 max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
          <Input
            className="ps-8"
            placeholder={t("invoices.searchPlaceholder")}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </div>

        <DateRangePicker
          value={dateRange}
          onChange={setDateRange}
          placeholder={t("invoices.allDates")}
        />

        <Select value={currency} onValueChange={setCurrency}>
          <SelectTrigger className="w-36">
            <SelectValue placeholder={t("invoices.allCurrencies")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("invoices.allCurrencies")}</SelectItem>
            {FILTER_CURRENCIES.filter(Boolean).map((c) => (
              <SelectItem key={c} value={c}>
                {c}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="ms-auto">
          <Button
            variant="outline"
            size="sm"
            onClick={handleExportCsv}
            disabled={exporting}
          >
            <Download className="h-4 w-4 me-2" />
            {exporting ? t("invoices.exporting") : t("invoices.exportCsv")}
          </Button>
        </div>
      </div>

      {/* History table */}
      <div className="rounded-lg border bg-white overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("invoices.colInvoiceNo")}</TableHead>
              <TableHead>{t("invoices.colCreated")}</TableHead>
              <TableHead>{t("invoices.colCustomer")}</TableHead>
              <TableHead>{t("invoices.colDescription")}</TableHead>
              <TableHead>{t("invoices.colAmount")}</TableHead>
              <TableHead>{t("invoices.colCreatedBy")}</TableHead>
              <TableHead className="w-12">{t("invoices.colPdf")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableSkeleton />
            ) : items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="h-48 text-center">
                  <div className="flex flex-col items-center gap-2 text-muted-foreground">
                    <FileText className="h-10 w-10 opacity-30" />
                    <p className="text-sm font-medium">{t("invoices.emptyTitle")}</p>
                    <p className="text-xs">{t("invoices.emptyDesc")}</p>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              items.map((row) => {
                const { date, time } = formatDateTime(row.created_at);
                return (
                  <TableRow key={row.id} className={isFetching ? "opacity-60" : ""}>
                    <TableCell className="font-mono text-sm font-medium">
                      {row.invoice_number}
                    </TableCell>
                    <TableCell>
                      <div className="text-sm">{date}</div>
                      <div className="text-xs text-muted-foreground">{time}</div>
                    </TableCell>
                    <TableCell>
                      <div className="text-sm">{row.customer_name ?? "—"}</div>
                      {row.customer_email && (
                        <div className="text-xs text-muted-foreground">{row.customer_email}</div>
                      )}
                    </TableCell>
                    <TableCell className="max-w-48 truncate text-sm text-muted-foreground">
                      {row.item_description ?? "—"}
                    </TableCell>
                    <TableCell className="text-sm font-medium">
                      {formatAmount(row.amount, row.currency)}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {row.created_by_name ?? "—"}
                    </TableCell>
                    <TableCell>
                      <DownloadCell row={row} />
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {/* Paginator */}
      {!isLoading && total > 0 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>
            {t("invoices.showingRange", { start: rangeStart, end: rangeEnd, total })}
          </span>
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="outline"
              className="h-8 w-8 p-0"
              onClick={() => setPage((p) => p - 1)}
              disabled={page <= 1}
            >
              <ChevronLeft size={14} />
            </Button>
            {pageNumbers(page, totalPages).map((p, i) =>
              p === "…" ? (
                <span key={`gap-${i}`} className="px-1.5 text-muted-foreground">
                  …
                </span>
              ) : (
                <Button
                  key={p}
                  size="sm"
                  variant={p === page ? "default" : "outline"}
                  className="h-8 min-w-8 px-2"
                  onClick={() => setPage(p)}
                >
                  {p}
                </Button>
              ),
            )}
            <Button
              size="sm"
              variant="outline"
              className="h-8 w-8 p-0"
              onClick={() => setPage((p) => p + 1)}
              disabled={page >= totalPages}
            >
              <ChevronRight size={14} />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
