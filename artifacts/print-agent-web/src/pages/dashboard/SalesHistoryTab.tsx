import { useMemo, useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, getClerkToken } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Loader2, ChevronLeft, ChevronRight, ShoppingBag, AlertTriangle, Download } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { orderStatusBadgeClass } from "@/lib/orderStatus";

type SalesHistoryItem = {
  order_id: string;
  order_display_number: string | null;
  external_order_id: string | null;
  status: string;
  date: string | null;
  quantity: number;
  unit_price: number | null;
  line_total: number | null;
  currency: string | null;
};

type SalesHistoryResponse = {
  items: SalesHistoryItem[];
  totals: {
    total_quantity: number;
    revenue_by_currency: Array<{ currency: string; total: number }>;
  };
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  matchKey: "both";
};

const PAGE_SIZE = 25;

export const STATUS_LABEL: Record<string, string> = {
  pending: "Pending",
  processing: "Processing",
  "on-hold": "On hold",
  on_hold: "On hold",
  completed: "Completed",
  cancelled: "Cancelled",
  refunded: "Refunded",
  failed: "Failed",
  ready_for_delivery: "Ready for delivery",
};

export function formatStatusLabel(status: string): string {
  if (status in STATUS_LABEL) return STATUS_LABEL[status];
  return status
    .replace(/[_-]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString();
}

function formatMoney(value: number | null, currency: string | null): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const curr = currency ?? "USD";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: curr }).format(value);
  } catch {
    return `${value.toFixed(2)} ${curr}`;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function formatOrderRef(item: SalesHistoryItem): string {
  if (item.order_display_number) return `#${item.order_display_number}`;
  if (item.external_order_id && !UUID_RE.test(item.external_order_id)) return `#${item.external_order_id}`;
  return `#${item.order_id.slice(0, 8)}…`;
}

function toIsoStart(dateStr: string): string | null {
  if (!dateStr) return null;
  const d = new Date(`${dateStr}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function toIsoEnd(dateStr: string): string | null {
  if (!dateStr) return null;
  const d = new Date(`${dateStr}T23:59:59.999Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export default function SalesHistoryTab({ productId }: { productId: number }) {
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");
  const [page, setPage] = useState<number>(1);
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const { toast } = useToast();

  const fromIso = useMemo(() => toIsoStart(from), [from]);
  const toIso = useMemo(() => toIsoEnd(to), [to]);

  const queryKey = ["product-sales-history", productId, fromIso, toIso, page] as const;

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey,
    queryFn: () => {
      const params = new URLSearchParams();
      if (fromIso) params.set("from", fromIso);
      if (toIso) params.set("to", toIso);
      params.set("page", String(page));
      params.set("pageSize", String(PAGE_SIZE));
      return apiFetch<SalesHistoryResponse>(
        `/api/products/${productId}/sales-history?${params.toString()}`,
      );
    },
  });

  const datesInvalid = !!from && !!to && from > to;

  const onClearFilter = () => {
    setFrom("");
    setTo("");
    setPage(1);
  };

  const onExportCsv = async () => {
    if (isExporting) return;
    setIsExporting(true);
    try {
      const params = new URLSearchParams();
      if (fromIso) params.set("from", fromIso);
      if (toIso) params.set("to", toIso);
      const url = `/api/products/${productId}/sales-history/export?${params.toString()}`;
      const token = await getClerkToken();
      const response = await fetch(url, {
        credentials: "include",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) {
        throw new Error(`Export failed: ${response.statusText}`);
      }
      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const filenameMatch = disposition.match(/filename="([^"]+)"/);
      const filename = filenameMatch ? filenameMatch[1] : "sales-history.csv";
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
      toast({
        title: "Export complete",
        description: `${filename} has been downloaded.`,
      });
    } catch (err) {
      toast({
        title: "Export failed",
        description: err instanceof Error ? err.message : "Something went wrong. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsExporting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
        <Loader2 size={14} className="animate-spin" />
        Loading sales history…
      </div>
    );
  }

  if (isError) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-6 text-center">
        <AlertTriangle size={24} className="mx-auto mb-2 text-destructive" />
        <p className="text-sm font-medium text-destructive">Failed to load sales history</p>
        <p className="text-xs text-muted-foreground mt-1">
          {error instanceof Error ? error.message : "Unknown error"}
        </p>
        <Button size="sm" variant="outline" className="mt-3" onClick={() => refetch()}>
          Try again
        </Button>
      </div>
    );
  }

  const items = data?.items ?? [];
  const totals = data?.totals ?? { total_quantity: 0, revenue_by_currency: [] };
  const totalPages = data?.totalPages ?? 1;
  const total = data?.total ?? 0;
  const showEmptyState = total === 0 && !from && !to;

  return (
    <div className="space-y-4" data-testid="sales-history-tab">
      <div className="rounded-lg border border-border bg-card p-4 flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground" htmlFor="sales-from">From</label>
          <Input
            id="sales-from"
            type="date"
            value={from}
            onChange={(e) => { setFrom(e.target.value); setPage(1); }}
            data-testid="sales-history-from"
            className="w-[160px]"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground" htmlFor="sales-to">To</label>
          <Input
            id="sales-to"
            type="date"
            value={to}
            onChange={(e) => { setTo(e.target.value); setPage(1); }}
            data-testid="sales-history-to"
            className="w-[160px]"
          />
        </div>
        {(from || to) && (
          <Button variant="ghost" size="sm" onClick={onClearFilter}>
            Clear
          </Button>
        )}
        {datesInvalid && (
          <span className="text-xs text-destructive">From must be before To</span>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={onExportCsv}
          disabled={isExporting || datesInvalid}
          data-testid="sales-history-export-csv"
        >
          {isExporting ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Download size={14} />
          )}
          Export CSV
        </Button>
        <div className="ml-auto flex flex-wrap items-center gap-4 text-sm">
          <div>
            <span className="text-muted-foreground">Total qty: </span>
            <span className="font-semibold" data-testid="sales-history-total-qty">
              {totals.total_quantity.toLocaleString()}
            </span>
          </div>
          {totals.revenue_by_currency.length === 0 ? (
            <div>
              <span className="text-muted-foreground">Revenue: </span>
              <span className="font-semibold">—</span>
            </div>
          ) : (
            totals.revenue_by_currency.map((r) => (
              <div key={r.currency}>
                <span className="text-muted-foreground">Revenue ({r.currency}): </span>
                <span className="font-semibold">{formatMoney(r.total, r.currency)}</span>
              </div>
            ))
          )}
        </div>
      </div>

      {showEmptyState ? (
        <div className="rounded-lg border border-dashed border-border p-10 text-center">
          <ShoppingBag size={28} className="mx-auto mb-2 text-muted-foreground" />
          <p className="font-medium text-sm">No sales recorded yet</p>
          <p className="text-xs text-muted-foreground mt-1">
            This product has no matching order lines yet.
          </p>
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-8 text-center">
          <p className="text-sm text-muted-foreground">No sales found in the selected range.</p>
        </div>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Order</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Unit price</TableHead>
                <TableHead className="text-right">Line total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((it, idx) => (
                <TableRow key={`${it.order_id}-${idx}`}>
                  <TableCell className="whitespace-nowrap">{formatDate(it.date)}</TableCell>
                  <TableCell className="font-mono text-xs">
                    <Link to={`/orders/${it.order_id}`} className="hover:underline text-primary">
                      {formatOrderRef(it)}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge className={orderStatusBadgeClass(it.status)}>
                      {formatStatusLabel(it.status)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">{it.quantity.toLocaleString()}</TableCell>
                  <TableCell className="text-right">{formatMoney(it.unit_price, it.currency)}</TableCell>
                  <TableCell className="text-right font-medium">{formatMoney(it.line_total, it.currency)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            Page {data?.page ?? 1} of {totalPages} · {total} line{total === 1 ? "" : "s"}
          </span>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={page <= 1 || isFetching}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              <ChevronLeft size={14} /> Prev
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={page >= totalPages || isFetching}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              Next <ChevronRight size={14} />
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
