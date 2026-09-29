import { useState } from "react";
import { Link } from "wouter";
import { ArrowLeft, ClipboardList, Download, FileText, RefreshCw, ChevronLeft, ChevronRight } from "lucide-react";
import { imageUrl } from "@/lib/imageUrl";
import { useQuery } from "@tanstack/react-query";
import { apiFetch, getClerkToken } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "@/hooks/use-toast";
import { DateRangePicker, type DateRangeValue } from "@/components/ui/date-range-picker";

const PAGE_SIZE = 20;
const VAT_RATE = 0.11;

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function computeNet(gross: number): number {
  return gross / (1 + VAT_RATE);
}

function computeVat(gross: number): number {
  return gross - computeNet(gross);
}

function formatMoney(n: number): string {
  return n.toFixed(2);
}

type LineItem = {
  name?: string;
  image_url?: string | null;
  qty?: number;
  quantity?: number;
};

type AuditSale = {
  id: string;
  fulfilment_date: string;
  created_at: string;
  line_items: LineItem[];
  total: string;
  payment_method: string | null;
};

type AuditTotals = {
  gross: string;
  net: string;
  vat: string;
};

type AuditResponse = {
  sales: AuditSale[];
  totals: AuditTotals;
  total: number;
  limit: number;
  offset: number;
};

function formatPaymentMethod(s: string | null | undefined): string {
  if (!s) return "—";
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function toTitleCase(s: string): string {
  return s.replace(/\S+/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

async function urlToBase64(url: string): Promise<string | null> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const blob = await resp.blob();
    return await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => resolve(null as unknown as string);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

function formatFulfilmentDatetime(sale: AuditSale): { date: string; time: string } {
  const created = sale.created_at ? new Date(sale.created_at) : null;
  const time = created ? created.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "";
  const rawDate = sale.fulfilment_date;
  const date = rawDate ? rawDate.slice(0, 10) : "—";
  return { date, time };
}

function ProductCell({ items }: { items: LineItem[] }) {
  return (
    <div className="space-y-1.5">
      {items.map((li, idx) => {
        const imgSrc = li.image_url ? imageUrl(li.image_url) : null;
        const qty = li.qty ?? li.quantity ?? 1;
        return (
          <div key={idx} className="flex items-center gap-2">
            {imgSrc ? (
              <img
                src={imgSrc}
                alt=""
                className="h-12 w-12 rounded object-cover shrink-0 border border-border"
                onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
              />
            ) : (
              <div className="h-12 w-12 rounded bg-muted shrink-0 border border-border flex items-center justify-center">
                <FileText className="h-3.5 w-3.5 text-muted-foreground" />
              </div>
            )}
            <span className="text-sm leading-tight">
              {li.name ?? "—"}{qty > 1 ? ` ×${qty}` : ""}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function SummaryCards({
  range,
  totals,
}: {
  range: DateRangeValue;
  totals: AuditTotals | undefined;
}) {
  const gross = totals ? parseFloat(totals.gross) : 0;
  const net = totals ? parseFloat(totals.net) : 0;

  const rangeLabel =
    range.from === range.to
      ? range.from
      : `${range.from} – ${range.to}`;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Selected Sale Range</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-lg font-bold leading-tight">{rangeLabel || "—"}</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Net Sales</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-bold text-teal-700">${formatMoney(net)}</p>
          <p className="text-xs text-muted-foreground mt-0.5">Excl. VAT</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Gross Sales</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-2xl font-bold text-teal-700">${formatMoney(gross)}</p>
          <p className="text-xs text-muted-foreground mt-0.5">11% VAT included</p>
        </CardContent>
      </Card>
    </div>
  );
}

function TableSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 5 }).map((_, i) => (
        <Skeleton key={i} className="h-12 w-full rounded" />
      ))}
    </div>
  );
}

export default function CmcPosAudit() {
  const today = todayIso();

  // `selectedRange` is what the picker shows (may be partial while user is choosing).
  // `appliedRange` is the last explicitly committed complete range — used by the query,
  // summary cards, and all export handlers. Partial selections never mutate it.
  const [selectedRange, setSelectedRange] = useState<Partial<DateRangeValue>>({ from: today, to: today });
  const [appliedRange, setAppliedRange] = useState<DateRangeValue>({ from: today, to: today });
  const [page, setPage] = useState(0);
  const [isPdfExporting, setIsPdfExporting] = useState(false);
  const [isCsvExporting, setIsCsvExporting] = useState(false);

  const { data, isLoading, isError, refetch } = useQuery<AuditResponse>({
    queryKey: ["cmc-pos-audit", appliedRange.from, appliedRange.to, page],
    queryFn: () =>
      apiFetch<AuditResponse>(
        `/api/cmc-pos/audit?from=${encodeURIComponent(appliedRange.from)}&to=${encodeURIComponent(appliedRange.to)}&limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}`,
      ),
  });

  const sales = data?.sales ?? [];
  const totals = data?.totals;
  const totalCount = data?.total ?? 0;
  const totalPages = Math.ceil(totalCount / PAGE_SIZE);
  const hasMore = sales.length === PAGE_SIZE;
  const grossTotal = totals ? parseFloat(totals.gross) : 0;
  const noRecords = grossTotal === 0 && totalCount === 0;

  async function handleExportCsv() {
    if (isCsvExporting || noRecords) return;
    setIsCsvExporting(true);
    try {
      const url = `/api/cmc-pos/audit/export?from=${encodeURIComponent(appliedRange.from)}&to=${encodeURIComponent(appliedRange.to)}`;
      const token = await getClerkToken();
      const response = await fetch(url, {
        credentials: "include",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) throw new Error(`Export failed: ${response.statusText}`);
      const blob = await response.blob();
      const rangeLabel = appliedRange.from === appliedRange.to
        ? appliedRange.from
        : `${appliedRange.from}_${appliedRange.to}`;
      const filename = `cmc-audit-${rangeLabel}.csv`;
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
    } catch {
      toast({ title: "CSV export failed. Please try again.", variant: "destructive" });
    } finally {
      setIsCsvExporting(false);
    }
  }

  async function handleExportPdf() {
    if (isPdfExporting || noRecords) return;
    setIsPdfExporting(true);
    try {
      const allSales: AuditSale[] = [];
      let fetchOffset = 0;
      const BATCH = 200;
      while (true) {
        const batch = await apiFetch<AuditResponse>(
          `/api/cmc-pos/audit?from=${encodeURIComponent(appliedRange.from)}&to=${encodeURIComponent(appliedRange.to)}&limit=${BATCH}&offset=${fetchOffset}`,
        );
        allSales.push(...batch.sales);
        if (batch.sales.length < BATCH) break;
        fetchOffset += BATCH;
      }

      const gross = allSales.reduce((s, r) => s + parseFloat(r.total ?? "0"), 0);
      const net = computeNet(gross);
      const vat = computeVat(gross);

      // Fetch logo as base64 (silently skip if unavailable)
      const logoDataUrl = await urlToBase64("/presentail-logo.png");

      // Collect all distinct product image URLs and pre-fetch them as base64
      const rawImageUrls = new Set<string>();
      for (const s of allSales) {
        for (const li of s.line_items ?? []) {
          if (li.image_url) rawImageUrls.add(li.image_url);
        }
      }
      const imageCache = new Map<string, string | null>();
      await Promise.all(
        [...rawImageUrls].map(async (raw) => {
          const fullUrl = imageUrl(raw);
          const dataUrl = fullUrl ? await urlToBase64(fullUrl) : null;
          imageCache.set(raw, dataUrl);
        }),
      );

      // Build per-row item data (title-cased names + pre-fetched image data URLs)
      type RowItem = { name: string; qty: number; dataUrl: string | null };
      const rowItemData: RowItem[][] = allSales.map((s) =>
        (s.line_items ?? []).map((li) => ({
          name: toTitleCase(li.name ?? "—"),
          qty: li.qty ?? li.quantity ?? 1,
          dataUrl: li.image_url ? (imageCache.get(li.image_url) ?? null) : null,
        })),
      );

      const [{ jsPDF }, autoTableModule] = await Promise.all([
        import("jspdf"),
        import("jspdf-autotable"),
      ]);
      const autoTable = autoTableModule.default;
      const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });

      const marginX = 40;
      let y = 48;

      doc.setFontSize(18);
      doc.setFont("helvetica", "bold");
      doc.text("CMC Audit Report", marginX, y);
      y += 22;

      doc.setFontSize(10);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(80);
      const rangeLabel = appliedRange.from === appliedRange.to
        ? appliedRange.from
        : `${appliedRange.from} – ${appliedRange.to}`;
      doc.text(`Sale Range: ${rangeLabel}`, marginX, y);
      y += 14;
      doc.text(`Generated: ${new Date().toLocaleString("en-US")}`, marginX, y);
      y += 20;

      doc.setTextColor(0);
      doc.setFontSize(11);
      doc.setFont("helvetica", "bold");
      doc.text("Summary", marginX, y);
      y += 14;

      doc.setFontSize(10);
      doc.setFont("helvetica", "normal");
      doc.text(`Net Sales: $${formatMoney(net)}`, marginX, y); y += 12;
      doc.text(`VAT (11%): $${formatMoney(vat)}`, marginX, y); y += 12;
      doc.text(`Gross Sales: $${formatMoney(gross)}`, marginX, y); y += 20;

      // Image dimensions and per-item row height (pt)
      const IMG_W = 36;
      const IMG_H = 36;
      const ITEM_LINE_H = 10; // approx line height at fontSize 8 (pt)
      // Each item occupies ceil(IMG_H / ITEM_LINE_H) blank lines to force cell height
      const LINES_PER_ITEM = Math.ceil(IMG_H / ITEM_LINE_H); // 4
      // Extra left padding to make room for the thumbnail
      const IMG_PAD_LEFT = IMG_W + 8;

      const PRODUCTS_COL = 2;

      const head = [["Sale Date", "Time", "Products", "Net Amount", "Gross Amount", "Payment Method"]];
      const body = allSales.map((s, i) => {
        const { date, time } = formatFulfilmentDatetime(s);
        const items = rowItemData[i];
        // Each item gets (LINES_PER_ITEM - 1) extra blank lines to accommodate the thumbnail height
        const productText = items
          .map((it) => `${it.name}${it.qty > 1 ? ` ×${it.qty}` : ""}${"\n".repeat(LINES_PER_ITEM - 1)}`)
          .join("\n");
        const grossAmt = parseFloat(s.total ?? "0");
        const netAmt = computeNet(grossAmt);
        return [
          date,
          time,
          productText,
          `$${formatMoney(netAmt)}`,
          `$${formatMoney(grossAmt)}`,
          formatPaymentMethod(s.payment_method),
        ];
      });

      autoTable(doc, {
        startY: y,
        head,
        body,
        margin: { left: marginX, right: marginX },
        styles: { fontSize: 8, cellPadding: 4 },
        headStyles: { fillColor: [6, 78, 90] },
        theme: "striped",
        showHead: "everyPage",
        columnStyles: {
          [PRODUCTS_COL]: {
            cellPadding: { top: 4, right: 4, bottom: 4, left: IMG_PAD_LEFT },
            minCellHeight: IMG_H + 8,
          },
        },
        didDrawCell: (data) => {
          if (data.section !== "body" || data.column.index !== PRODUCTS_COL) return;
          const items = rowItemData[data.row.index];
          if (!items || items.length === 0) return;
          const blockH = LINES_PER_ITEM * ITEM_LINE_H;
          items.forEach((item, i) => {
            const imgX = data.cell.x + 4;
            const blockTop = data.cell.y + data.cell.padding("top") + i * blockH;
            const imgY = blockTop + (blockH - IMG_H) / 2;
            if (item.dataUrl) {
              try {
                doc.addImage(item.dataUrl, "PNG", imgX, imgY, IMG_W, IMG_H);
              } catch {
                // skip broken images
              }
            }
          });
        },
        didDrawPage: (hookData) => {
          // Logo top-right on every page
          if (logoDataUrl) {
            const pageW = doc.internal.pageSize.getWidth();
            try {
              doc.addImage(logoDataUrl, "PNG", pageW - marginX - 80, 18, 80, 30);
            } catch {
              // skip if image fails
            }
          }
          // Page number bottom-right
          const pageNum = hookData.pageNumber;
          const pageCount = doc.getNumberOfPages();
          doc.setFontSize(8);
          doc.setTextColor(120);
          doc.text(
            `Page ${pageNum} of ${pageCount}`,
            doc.internal.pageSize.getWidth() - marginX,
            doc.internal.pageSize.getHeight() - 20,
            { align: "right" },
          );
          doc.setTextColor(0);
        },
      });

      const pdfRangeLabel = appliedRange.from === appliedRange.to
        ? appliedRange.from
        : `${appliedRange.from}_${appliedRange.to}`;
      doc.save(`cmc-audit-${pdfRangeLabel}.pdf`);
    } catch {
      toast({ title: "PDF export failed. Please try again.", variant: "destructive" });
    } finally {
      setIsPdfExporting(false);
    }
  }

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" asChild>
          <Link href="/cmc-pos"><ArrowLeft className="h-4 w-4" /></Link>
        </Button>
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-teal-100">
          <ClipboardList className="h-5 w-5 text-teal-700" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold">CMC Audit</h1>
          <p className="text-sm text-muted-foreground">Read-only view of recorded CMC sales by sale date range</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-card p-4">
        <div className="space-y-1">
          <Label className="text-xs">Sale Date Range</Label>
          <DateRangePicker
            value={selectedRange}
            onChange={(newRange) => {
              setSelectedRange(newRange);
              // Auto-commit only when the range is complete (both endpoints chosen).
              // Partial selections (only `from` picked) never touch appliedRange so
              // summary cards and exports always reflect a properly committed range.
              if (newRange.from && newRange.to) {
                setAppliedRange({ from: newRange.from, to: newRange.to });
                setPage(0);
              }
            }}
            placeholder="Select date range"
            className="h-8 text-sm"
            data-testid="input-audit-date-range"
          />
        </div>
        <div className="flex-1" />
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={handleExportCsv}
            disabled={noRecords || isCsvExporting}
            data-testid="btn-export-csv"
          >
            <Download className="h-3.5 w-3.5 me-1.5" />
            {isCsvExporting ? "Exporting…" : "Export CSV"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={handleExportPdf}
            disabled={noRecords || isPdfExporting}
            data-testid="btn-export-pdf"
          >
            <FileText className="h-3.5 w-3.5 me-1.5" />
            {isPdfExporting ? "Generating…" : "Download PDF"}
          </Button>
        </div>
      </div>

      <SummaryCards range={appliedRange} totals={totals} />

      {isLoading && (
        <div className="rounded-lg border bg-card p-6">
          <TableSkeleton />
        </div>
      )}

      {isError && (
        <div className="rounded-lg border bg-card p-8 flex flex-col items-center gap-3 text-center">
          <p className="text-sm text-destructive">Failed to load audit data.</p>
          <Button size="sm" variant="outline" onClick={() => refetch()}>
            <RefreshCw className="h-3.5 w-3.5 me-1.5" />
            Retry
          </Button>
        </div>
      )}

      {!isLoading && !isError && sales.length === 0 && (
        <div className="rounded-lg border bg-card p-8 text-center">
          <p className="text-sm text-muted-foreground">No recorded sales for this sale date range.</p>
        </div>
      )}

      {!isLoading && !isError && sales.length > 0 && (
        <div className="rounded-lg border bg-card overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Sale Date/Time</TableHead>
                <TableHead>Product</TableHead>
                <TableHead className="text-end">Net Amount</TableHead>
                <TableHead className="text-end">Gross Amount</TableHead>
                <TableHead>Payment Method</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sales.map((sale) => {
                const { date, time } = formatFulfilmentDatetime(sale);
                const gross = parseFloat(sale.total ?? "0");
                const net = computeNet(gross);
                return (
                  <TableRow key={sale.id}>
                    <TableCell className="text-sm whitespace-nowrap">
                      <div>{date}</div>
                      {time && <div className="text-xs text-muted-foreground">{time}</div>}
                    </TableCell>
                    <TableCell>
                      <ProductCell items={sale.line_items ?? []} />
                    </TableCell>
                    <TableCell className="text-end text-sm font-medium">
                      ${formatMoney(net)}
                    </TableCell>
                    <TableCell className="text-end text-sm font-semibold text-teal-700">
                      ${formatMoney(gross)}
                    </TableCell>
                    <TableCell className="text-sm">
                      {formatPaymentMethod(sale.payment_method)}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>

          {(page > 0 || hasMore) && (
            <div className="flex items-center justify-between px-4 py-3 border-t">
              <p className="text-sm text-muted-foreground">
                {totalCount > 0
                  ? `Showing ${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, totalCount)} of ${totalCount}`
                  : ""}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={page === 0}
                  onClick={() => setPage((p) => p - 1)}
                  data-testid="btn-prev"
                >
                  <ChevronLeft className="h-4 w-4" />
                  Previous
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!hasMore || page + 1 >= totalPages}
                  onClick={() => setPage((p) => p + 1)}
                  data-testid="btn-next"
                >
                  Next
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
