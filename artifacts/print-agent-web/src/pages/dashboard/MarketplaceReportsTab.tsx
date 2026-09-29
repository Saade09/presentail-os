import { useState, useEffect, useRef } from "react";
import {
  useListBrandMarketplaceReports,
  useListBrandMarketplaceReportImports,
  getGetMarketplaceReportQueryOptions,
  usePatchMarketplaceReportImport,
  useApproveMarketplaceReportImport,
  useManualMarketplaceReportUpload,
  useMatchMarketplaceReportProducts,
  useRetryMarketplaceReportImport,
  useReExtractMarketplaceReportImport,
  getListBrandMarketplaceReportsQueryKey,
  getListBrandMarketplaceReportImportsQueryKey,
  useListMarketplaceBrandAliases,
  useCreateMarketplaceBrandAlias,
  useDeleteMarketplaceBrandAlias,
  getListMarketplaceBrandAliasesQueryKey,
} from "@workspace/api-client-react";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import type {
  MarketplaceReport,
  MarketplaceReportImport,
  MarketplaceReportDetail,
  MarketplaceReportMetric,
  MarketplaceReportItem,
  MarketplaceBrandAlias,
} from "@workspace/api-client-react";
import { useQueryClient, useQuery, useQueries } from "@tanstack/react-query";
import {
  Upload,
  Loader2,
  FileText,
  BarChart2,
  TrendingUp,
  Star,
  ShoppingCart,
  DollarSign,
  Clock,
  Truck,
  AlertCircle,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Check,
  X,
  ExternalLink,
  ChevronLeft,
  ChevronRight,
  Eye,
  Package,
  ArrowUpRight,
  Info,
  RefreshCw,
  Tag,
  Pencil,
  Plus,
  Trash2,
  Mail,
  Copy,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { apiFetch, getClerkToken } from "@/lib/queryClient";
import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ResponsiveContainer,
  Legend,
  AreaChart,
  Area,
} from "recharts";

// ─── Types ────────────────────────────────────────────────────────────────────

type Location = { id: number; name: string };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(s: string | null | undefined): string {
  if (!s) return "—";
  try {
    return new Date(s).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return "—";
  }
}

function formatWeekRange(start: string | null | undefined, end: string | null | undefined): string {
  if (!start) return "—";
  const s = formatDate(start);
  const e = end ? formatDate(end) : "";
  return e ? `${s} – ${e}` : s;
}

function formatCurrency(val: number | null | undefined, currency = "USD"): string {
  if (val == null) return "—";
  if (currency === "AED") return `AED ${val.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `$${val.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatSeconds(val: number | null | undefined): string {
  if (val == null) return "—";
  const m = Math.floor(val / 60);
  const s = Math.round(val % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function getImportStatusColor(status: string): string {
  switch (status) {
    case "approved": return "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400";
    case "ready_to_approve": return "bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400";
    case "needs_review": return "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400";
    case "extraction_failed": return "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400";
    case "pending": return "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400";
    case "duplicate": return "bg-secondary text-muted-foreground";
    case "rejected": return "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400";
    default: return "bg-secondary text-muted-foreground";
  }
}

function getMatchStatusStyle(status: string): string {
  switch (status) {
    case "matched": return "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400";
    case "needs_review": return "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400";
    case "ignored": return "bg-secondary text-muted-foreground";
    default: return "bg-secondary text-muted-foreground";
  }
}

function getMetricByName(metrics: MarketplaceReportMetric[], name: string): number | null {
  return metrics.find((m) => m.metric_name === name)?.metric_value ?? null;
}

// ─── KPI Card ─────────────────────────────────────────────────────────────────

function MktKpiCard({
  icon,
  label,
  value,
  sub,
  badge,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  sub?: string;
  badge?: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-card px-5 py-4 flex flex-col gap-1 shadow-sm">
      <div className="flex items-center justify-between mb-1">
        <div className="text-muted-foreground">{icon}</div>
        {badge}
      </div>
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{label}</p>
      <p className="text-2xl font-bold tracking-tight">{value}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

// ─── Import Status Badge ───────────────────────────────────────────────────────

function getImportStatusLabel(status: string): string {
  switch (status) {
    case "approved": return "Approved";
    case "ready_to_approve": return "Ready to Approve";
    case "needs_review": return "Needs Review";
    case "extraction_failed": return "Extraction Failed";
    case "pending": return "Pending";
    case "duplicate": return "Duplicate";
    case "rejected": return "Rejected";
    default: return status;
  }
}

function ImportStatusBadge({ status }: { status: string }) {
  if (status === "pending") {
    return (
      <Badge className={`border-0 text-[11px] gap-1 ${getImportStatusColor(status)}`}>
        <Loader2 size={10} className="animate-spin" />
        Processing…
      </Badge>
    );
  }
  return (
    <Badge className={`border-0 text-[11px] ${getImportStatusColor(status)}`}>
      {getImportStatusLabel(status)}
    </Badge>
  );
}

function getConfidenceLabel(confidence: number): string {
  if (confidence >= 0.9) return "High confidence";
  if (confidence >= 0.7) return "Good confidence";
  return "Low confidence";
}

function getConfidenceStyle(confidence: number): string {
  if (confidence >= 0.9) return "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400";
  if (confidence >= 0.7) return "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400";
  return "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400";
}

function ConfidenceBadge({ confidence }: { confidence: number | null | undefined }) {
  if (confidence == null) return null;
  const pct = Math.round(confidence * 100);
  return (
    <Badge className={`border-0 text-[11px] gap-1 ${getConfidenceStyle(confidence)}`}>
      {getConfidenceLabel(confidence)} · {pct}%
    </Badge>
  );
}

// ─── Report Detail Drawer ─────────────────────────────────────────────────────

function ReportDetailDrawer({
  reportId,
  open,
  onClose,
}: {
  reportId: number | null;
  open: boolean;
  onClose: () => void;
}) {
  const { data, isLoading } = useQuery({
    ...getGetMarketplaceReportQueryOptions(reportId ?? 0),
    enabled: open && reportId !== null,
  });
  const report = data?.report as MarketplaceReportDetail | undefined;

  const orders = report ? getMetricByName(report.metrics, "total_orders") : null;
  const revenue = report ? getMetricByName(report.metrics, "total_revenue") : null;
  const aov = report ? getMetricByName(report.metrics, "average_order_value") : null;
  const rating = report ? getMetricByName(report.metrics, "rating") : null;
  const prepTime = report ? getMetricByName(report.metrics, "prep_time_seconds") : null;
  const deliveryTime = report ? getMetricByName(report.metrics, "delivery_time_seconds") : null;
  const cancelRate = report ? getMetricByName(report.metrics, "cancel_rate") : null;
  const driverWait = report ? getMetricByName(report.metrics, "driver_wait_seconds") : null;

  const trendData = (report?.weekly_trends ?? []).reduce<Record<string, { week: string; orders?: number; revenue?: number }>>((acc, t) => {
    if (!acc[t.week_label]) acc[t.week_label] = { week: t.week_label };
    if (t.metric_name === "orders") acc[t.week_label].orders = t.value ?? undefined;
    if (t.metric_name === "revenue") acc[t.week_label].revenue = t.value ?? undefined;
    return acc;
  }, {});
  const chartData = Object.values(trendData);

  const items = report?.items ?? [];

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BarChart2 size={18} className="text-teal-600" />
            Marketplace Report Detail
          </DialogTitle>
          {report && (
            <DialogDescription>
              {report.marketplace} · {report.location_name ?? "All Locations"} · {formatWeekRange(report.report_period_start, report.report_period_end)}
            </DialogDescription>
          )}
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground justify-center">
            <Loader2 size={16} className="animate-spin" />
            Loading report…
          </div>
        ) : !report ? (
          <div className="py-8 text-center text-sm text-muted-foreground">Report not found.</div>
        ) : (
          <div className="space-y-5">
            {/* Header info row */}
            <div className="rounded-lg border border-border bg-secondary/30 p-3 grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-2 text-sm">
              <div><span className="text-xs text-muted-foreground">Marketplace</span><p className="font-medium">{report.marketplace}</p></div>
              <div><span className="text-xs text-muted-foreground">Brand</span><p className="font-medium">{report.brand_name ?? "—"}</p></div>
              <div><span className="text-xs text-muted-foreground">Location</span><p className="font-medium">{report.location_name ?? "—"}</p></div>
              <div><span className="text-xs text-muted-foreground">Report Week</span><p className="font-medium">{formatWeekRange(report.report_period_start, report.report_period_end)}</p></div>
              <div><span className="text-xs text-muted-foreground">Approved</span><p className="font-medium">{formatDate(report.created_at)}</p></div>
              {report.detected_merchant_name && (
                <div>
                  <span className="text-xs text-muted-foreground">Detected as</span>
                  <p className="font-medium font-mono text-xs">{report.detected_merchant_name}</p>
                </div>
              )}
              <div>
                <span className="text-xs text-muted-foreground">Source PDF</span>
                <a
                  href={`/api/marketplace-reports/${report.id}/source-pdf`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-teal-600 hover:underline text-xs mt-0.5"
                >
                  <FileText size={11} /> View PDF
                </a>
              </div>
            </div>

            {/* Summary KPI cards */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <MktKpiCard icon={<ShoppingCart size={16} />} label="Weekly Orders" value={orders != null ? orders.toLocaleString() : "—"} />
              <MktKpiCard icon={<DollarSign size={16} />} label="Weekly Revenue" value={revenue != null ? formatCurrency(revenue) : "—"} />
              <MktKpiCard icon={<TrendingUp size={16} />} label="AOV" value={aov != null ? formatCurrency(aov) : "—"} />
              <MktKpiCard
                icon={<Star size={16} />}
                label="Rating"
                value={rating != null ? rating.toFixed(1) : "—"}
                badge={rating != null && rating >= 4.5 ? <Badge className="bg-green-100 text-green-700 border-0 text-[10px]">Excellent</Badge> : undefined}
              />
            </div>

            {/* Operational metrics */}
            <div className="rounded-xl border border-border bg-card shadow-sm p-4">
              <h3 className="text-sm font-semibold mb-3 flex items-center gap-1.5"><Clock size={14} className="text-muted-foreground" /> Operational Metrics</h3>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
                <div><p className="text-xs text-muted-foreground">Prep Time</p><p className="font-medium">{formatSeconds(prepTime)}</p></div>
                <div><p className="text-xs text-muted-foreground">Delivery Time</p><p className="font-medium">{formatSeconds(deliveryTime)}</p></div>
                <div><p className="text-xs text-muted-foreground">Cancel Rate</p><p className="font-medium">{cancelRate != null ? `${cancelRate.toFixed(1)}%` : "—"}</p></div>
                <div><p className="text-xs text-muted-foreground">Driver Wait</p><p className="font-medium">{formatSeconds(driverWait)}</p></div>
              </div>
            </div>

            {/* Trend chart */}
            {chartData.length > 0 && (
              <div className="rounded-xl border border-border bg-card shadow-sm p-4">
                <h3 className="text-sm font-semibold mb-3 flex items-center gap-1.5"><TrendingUp size={14} className="text-muted-foreground" /> Orders & Revenue Trend</h3>
                <ResponsiveContainer width="100%" height={180}>
                  <ComposedChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                    <XAxis dataKey="week" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                    <YAxis yAxisId="orders" orientation="left" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} width={32} allowDecimals={false} />
                    <YAxis yAxisId="revenue" orientation="right" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} width={50} tickFormatter={(v) => `$${v}`} />
                    <RechartsTooltip contentStyle={{ fontSize: 12 }} />
                    <Legend iconSize={10} wrapperStyle={{ fontSize: 11 }} />
                    <Bar yAxisId="orders" dataKey="orders" fill="#0d9488" opacity={0.8} radius={[3, 3, 0, 0]} name="Orders" />
                    <Line yAxisId="revenue" type="monotone" dataKey="revenue" stroke="#6366f1" strokeWidth={2} dot={{ r: 3 }} name="Revenue ($)" />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* Best-selling items */}
            {items.length > 0 && (
              <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
                <div className="px-4 py-3 border-b border-border bg-muted/30">
                  <h3 className="text-sm font-semibold flex items-center gap-1.5"><Package size={14} className="text-muted-foreground" /> Best-Selling Items</h3>
                </div>
                <div className="divide-y divide-border">
                  <div className="hidden sm:grid grid-cols-[40px_2fr_80px_100px_90px_2fr_100px] gap-3 px-4 py-2 bg-muted/20 text-xs font-medium text-muted-foreground">
                    <span>#</span><span>Item</span><span>Qty</span><span>Revenue</span><span>% Rev</span><span>Matched Product</span><span>Status</span>
                  </div>
                  {items.map((item) => {
                    const revenueTotal = revenue ?? 1;
                    const pct = item.revenue != null ? ((item.revenue / revenueTotal) * 100).toFixed(1) : "—";
                    return (
                      <div key={item.id} className="grid grid-cols-[40px_2fr_80px_100px_90px_2fr_100px] gap-3 px-4 py-2.5 text-sm items-center">
                        <span className="text-muted-foreground font-medium text-xs">{item.rank ?? "—"}</span>
                        <span className="font-medium truncate">{item.item_name}</span>
                        <span className="text-muted-foreground text-xs">{item.quantity ?? "—"}</span>
                        <span className="text-xs">{item.revenue != null ? formatCurrency(item.revenue) : "—"}</span>
                        <span className="text-xs text-muted-foreground">{pct !== "—" ? `${pct}%` : "—"}</span>
                        <span className="text-xs truncate">
                          {item.matched_product_name ? (
                            <a href={`/products/${item.matched_product_id}`} target="_blank" rel="noopener noreferrer" className="text-teal-600 hover:underline flex items-center gap-1">
                              {item.matched_product_name} <ExternalLink size={10} />
                            </a>
                          ) : "—"}
                        </span>
                        <Badge className={`border-0 text-[10px] ${getMatchStatusStyle(item.match_status)}`}>
                          {item.match_status === "matched" ? "Matched" : item.match_status === "needs_review" ? "Review" : "Ignored"}
                        </Badge>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Review Wizard ────────────────────────────────────────────────────────────

type ExtractedData = {
  confidence?: number;
  total_orders?: number;
  total_revenue?: number;
  average_order_value?: number;
  rating?: number;
  prep_time_seconds?: number;
  delivery_time_seconds?: number;
  cancel_rate?: number;
  driver_wait_seconds?: number;
  items?: Array<{
    item_name: string;
    rank?: number;
    quantity?: number;
    revenue?: number;
    match_status?: string;
    matched_product_id?: number;
    matched_product_name?: string;
  }>;
  [key: string]: unknown;
};

function AliasMatchBanner({ aliasName }: { aliasName: string | null }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded-md border border-teal-200 dark:border-teal-800 bg-teal-50 dark:bg-teal-900/20 overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-1.5 px-3 py-2 text-xs text-teal-700 dark:text-teal-400 hover:bg-teal-100/60 dark:hover:bg-teal-900/40 transition-colors text-left"
      >
        <Tag size={12} className="shrink-0" />
        <span className="flex-1 font-medium">Auto-matched via saved alias</span>
        <span className="text-teal-500 dark:text-teal-500 underline underline-offset-2 text-[11px]">
          {expanded ? "hide" : "show alias"}
        </span>
      </button>
      {expanded && (
        <div className="px-3 pb-2.5 pt-0.5 text-xs text-teal-700 dark:text-teal-300 border-t border-teal-200 dark:border-teal-800 bg-teal-50/60 dark:bg-teal-900/10">
          <span className="text-muted-foreground">Matched by alias: </span>
          <span className="font-semibold">{aliasName ?? "—"}</span>
          <p className="text-muted-foreground mt-0.5">Verify the brand and location below, and adjust if needed.</p>
        </div>
      )}
    </div>
  );
}

function ReviewWizard({
  importItem,
  open,
  onClose,
  onApproved,
  locations,
  brands,
}: {
  importItem: MarketplaceReportImport | null;
  open: boolean;
  onClose: () => void;
  onApproved: () => void;
  locations: Location[];
  brands: { id: number; name: string }[];
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [step, setStep] = useState(1);
  const [saveAsAlias, setSaveAsAlias] = useState(false);

  const extractedData = (importItem?.extracted_data ?? {}) as ExtractedData;

  const [form, setForm] = useState({
    detected_merchant_name: importItem?.detected_merchant_name ?? "",
    detected_brand_id: importItem?.detected_brand_id != null ? String(importItem.detected_brand_id) : "",
    detected_location_id: importItem?.detected_location_id != null ? String(importItem.detected_location_id) : "",
    report_period_start: importItem?.report_period_start ?? "",
    report_period_end: importItem?.report_period_end ?? "",
    marketplace: importItem?.marketplace ?? "Toters",
    total_orders: extractedData.total_orders != null ? String(extractedData.total_orders) : "",
    total_revenue: extractedData.total_revenue != null ? String(extractedData.total_revenue) : "",
    average_order_value: extractedData.average_order_value != null ? String(extractedData.average_order_value) : "",
    rating: extractedData.rating != null ? String(extractedData.rating) : "",
    prep_time_min: extractedData.prep_time_seconds != null ? String(Math.floor(extractedData.prep_time_seconds / 60)) : "",
    prep_time_sec: extractedData.prep_time_seconds != null ? String(Math.round(extractedData.prep_time_seconds % 60)) : "",
    delivery_time_min: extractedData.delivery_time_seconds != null ? String(Math.floor(extractedData.delivery_time_seconds / 60)) : "",
    delivery_time_sec: extractedData.delivery_time_seconds != null ? String(Math.round(extractedData.delivery_time_seconds % 60)) : "",
    cancel_rate: extractedData.cancel_rate != null ? String(extractedData.cancel_rate) : "",
    driver_wait_min: extractedData.driver_wait_seconds != null ? String(Math.floor(extractedData.driver_wait_seconds / 60)) : "",
    driver_wait_sec: extractedData.driver_wait_seconds != null ? String(Math.round(extractedData.driver_wait_seconds % 60)) : "",
  });

  const patchMutation = usePatchMarketplaceReportImport({
    mutation: {
      onError: (err) => {
        toast({ variant: "destructive", title: "Save failed", description: err instanceof Error ? err.message : "Could not save changes" });
      },
    },
  });

  const approveMutation = useApproveMarketplaceReportImport({
    mutation: {
      onSuccess: () => {
        toast({ title: "Report approved", description: "The import has been promoted to an approved report." });
        onApproved();
        onClose();
      },
      onError: (err) => {
        toast({ variant: "destructive", title: "Approval failed", description: err instanceof Error ? err.message : "Could not approve" });
      },
    },
  });

  const matchMutation = useMatchMarketplaceReportProducts({
    mutation: {
      onSuccess: () => { toast({ title: "Products re-matched" }); },
      onError: () => { toast({ variant: "destructive", title: "Match failed" }); },
    },
  });

  const createAliasMutation = useCreateMarketplaceBrandAlias({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListMarketplaceBrandAliasesQueryKey() });
        toast({ title: "Alias saved", description: "This merchant name will auto-match in future imports." });
      },
      onError: () => {
        toast({ variant: "destructive", title: "Could not save alias" });
      },
    },
  });

  if (!importItem) return null;

  const totalSteps = 6;

  async function saveCurrentStep() {
    const prepSec = (parseInt(form.prep_time_min || "0", 10) * 60) + parseInt(form.prep_time_sec || "0", 10);
    const delivSec = (parseInt(form.delivery_time_min || "0", 10) * 60) + parseInt(form.delivery_time_sec || "0", 10);
    const waitSec = (parseInt(form.driver_wait_min || "0", 10) * 60) + parseInt(form.driver_wait_sec || "0", 10);

    const updatedExtracted: ExtractedData = {
      ...extractedData,
      ...(form.total_orders !== "" ? { total_orders: parseFloat(form.total_orders) } : {}),
      ...(form.total_revenue !== "" ? { total_revenue: parseFloat(form.total_revenue) } : {}),
      ...(form.average_order_value !== "" ? { average_order_value: parseFloat(form.average_order_value) } : {}),
      ...(form.rating !== "" ? { rating: parseFloat(form.rating) } : {}),
      ...(form.prep_time_min !== "" ? { prep_time_seconds: prepSec } : {}),
      ...(form.delivery_time_min !== "" ? { delivery_time_seconds: delivSec } : {}),
      ...(form.cancel_rate !== "" ? { cancel_rate: parseFloat(form.cancel_rate) } : {}),
      ...(form.driver_wait_min !== "" ? { driver_wait_seconds: waitSec } : {}),
    };

    await patchMutation.mutateAsync({
      importId: importItem!.id,
      data: {
        detected_merchant_name: form.detected_merchant_name || undefined,
        detected_brand_id: form.detected_brand_id ? parseInt(form.detected_brand_id, 10) : null,
        detected_location_id: form.detected_location_id ? parseInt(form.detected_location_id, 10) : null,
        report_period_start: form.report_period_start || undefined,
        report_period_end: form.report_period_end || undefined,
        marketplace: form.marketplace || undefined,
        extracted_data: updatedExtracted,
      },
    });

    if (saveAsAlias && step === 2 && form.detected_merchant_name.trim() && form.detected_brand_id) {
      createAliasMutation.mutate({
        data: {
          marketplace: form.marketplace || importItem!.marketplace,
          alias_name: form.detected_merchant_name.trim(),
          brand_id: parseInt(form.detected_brand_id, 10),
          location_id: form.detected_location_id ? parseInt(form.detected_location_id, 10) : undefined,
        },
      });
      setSaveAsAlias(false);
    }
  }

  async function handleNext() {
    if (step < totalSteps) {
      await saveCurrentStep();
      setStep((s) => s + 1);
    }
  }

  async function handleApprove() {
    await saveCurrentStep();
    approveMutation.mutate({ importId: importItem!.id });
  }

  const isSaving = patchMutation.isPending || approveMutation.isPending || createAliasMutation.isPending;

  const stepLabels = ["Source", "Brand & Location", "Summary Metrics", "Operational Metrics", "Best-Selling Items", "Approve"];

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Eye size={18} className="text-teal-600" />
            Review Import — Step {step} of {totalSteps}
          </DialogTitle>
          <DialogDescription>{stepLabels[step - 1]}</DialogDescription>
        </DialogHeader>

        {/* Step progress */}
        <div className="flex gap-1 mb-2">
          {stepLabels.map((label, i) => (
            <div key={i} className="flex-1">
              <div className={`h-1.5 rounded-full transition-colors ${i + 1 <= step ? "bg-teal-600" : "bg-border"}`} />
              <p className="text-[9px] text-muted-foreground mt-0.5 text-center hidden sm:block truncate">{label}</p>
            </div>
          ))}
        </div>

        {/* Step 1: Source info */}
        {step === 1 && (
          <div className="space-y-4 py-2">
            <div className="rounded-lg border border-border bg-secondary/30 p-4 space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-x-6 gap-y-3">
                <div><p className="text-xs text-muted-foreground">Source Type</p><p className="font-medium capitalize">{importItem.source_type}</p></div>
                <div><p className="text-xs text-muted-foreground">Marketplace</p><p className="font-medium">{importItem.marketplace}</p></div>
                <div><p className="text-xs text-muted-foreground">Import Status</p><ImportStatusBadge status={importItem.import_status} /></div>
                <div><p className="text-xs text-muted-foreground">Received</p><p className="font-medium">{formatDate(importItem.created_at)}</p></div>
                <div><p className="text-xs text-muted-foreground">Detected Merchant</p><p className="font-medium">{importItem.detected_merchant_name ?? "—"}</p></div>
                <div>
                  <p className="text-xs text-muted-foreground">Source PDF</p>
                  {importItem.pdf_storage_path ? (
                    <p className="text-xs text-teal-600 flex items-center gap-1 mt-0.5"><FileText size={11} /> PDF attached</p>
                  ) : (
                    <p className="text-xs text-muted-foreground italic">No PDF</p>
                  )}
                </div>
                {extractedData.confidence != null && (
                  <div>
                    <p className="text-xs text-muted-foreground">AI Confidence</p>
                    <div className="mt-0.5">
                      <ConfidenceBadge confidence={extractedData.confidence} />
                    </div>
                  </div>
                )}
              </div>
              {importItem.notes && (
                <div>
                  <p className="text-xs text-muted-foreground">Notes</p>
                  <p className="text-sm">{importItem.notes}</p>
                </div>
              )}
            </div>
            {extractedData.confidence != null && extractedData.confidence < 0.7 && (
              <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-900/20 px-4 py-3">
                <AlertTriangle size={15} className="shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" />
                <div>
                  <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">Low extraction confidence ({Math.round(extractedData.confidence * 100)}%)</p>
                  <p className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
                    The AI was not confident in all fields it extracted. Please carefully review every step of this wizard and correct any values that look incorrect before approving.
                  </p>
                </div>
              </div>
            )}
            {importItem.email_message_id && (
              <div className="rounded-lg border border-border p-3 text-xs text-muted-foreground">
                <span className="font-medium">Email Message ID:</span> {importItem.email_message_id}
              </div>
            )}
          </div>
        )}

        {/* Step 2: Brand & Location */}
        {step === 2 && (
          <div className="space-y-4 py-2">
            {importItem.auto_matched_alias_id != null && (
              <AliasMatchBanner aliasName={importItem.auto_matched_alias_name ?? null} />
            )}
            <div className="space-y-1.5">
              <Label htmlFor="wiz-merchant">Detected Merchant Name</Label>
              <Input
                id="wiz-merchant"
                value={form.detected_merchant_name}
                onChange={(e) => setForm((f) => ({ ...f, detected_merchant_name: e.target.value }))}
                placeholder="e.g. Presentail"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wiz-marketplace">Marketplace</Label>
              <Select value={form.marketplace || "Toters"} onValueChange={(v) => setForm((f) => ({ ...f, marketplace: v }))}>
                <SelectTrigger id="wiz-marketplace">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Toters">Toters</SelectItem>
                  <SelectItem value="Careem">Careem</SelectItem>
                  <SelectItem value="Talabat">Talabat</SelectItem>
                  <SelectItem value="Deliveroo">Deliveroo</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wiz-brand">Brand</Label>
              <Select value={form.detected_brand_id || "__none__"} onValueChange={(v) => setForm((f) => ({ ...f, detected_brand_id: v === "__none__" ? "" : v }))}>
                <SelectTrigger id="wiz-brand">
                  <SelectValue placeholder="Select brand…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__"><span className="text-muted-foreground">Not set</span></SelectItem>
                  {brands.map((b) => <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="wiz-location">Location</Label>
              <Select value={form.detected_location_id || "__none__"} onValueChange={(v) => setForm((f) => ({ ...f, detected_location_id: v === "__none__" ? "" : v }))}>
                <SelectTrigger id="wiz-location">
                  <SelectValue placeholder="Select location…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__"><span className="text-muted-foreground">All / Not specified</span></SelectItem>
                  {locations.map((l) => <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            {form.detected_merchant_name.trim() && form.detected_brand_id && (
              <label className="flex items-start gap-2.5 cursor-pointer rounded-md border border-border bg-muted/30 px-3 py-2.5 hover:bg-muted/50 transition-colors">
                <input
                  type="checkbox"
                  className="mt-0.5 accent-teal-600"
                  checked={saveAsAlias}
                  onChange={(e) => setSaveAsAlias(e.target.checked)}
                />
                <div>
                  <p className="text-sm font-medium leading-none">Save as alias</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Future reports from <span className="font-medium">{form.detected_merchant_name.trim()}</span> on <span className="font-medium">{form.marketplace || importItem.marketplace}</span> will auto-match to the selected brand.
                  </p>
                </div>
              </label>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="wiz-start">Report Start Date</Label>
                <Input id="wiz-start" type="date" value={form.report_period_start} onChange={(e) => setForm((f) => ({ ...f, report_period_start: e.target.value }))} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="wiz-end">Report End Date</Label>
                <Input id="wiz-end" type="date" value={form.report_period_end} onChange={(e) => setForm((f) => ({ ...f, report_period_end: e.target.value }))} />
              </div>
            </div>
          </div>
        )}

        {/* Step 3: Summary Metrics */}
        {step === 3 && (
          <div className="space-y-4 py-2">
            <p className="text-xs text-muted-foreground">Review and correct the extracted summary metrics for this report.</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="wiz-orders">Total Orders</Label>
                <Input id="wiz-orders" type="number" min="0" value={form.total_orders} onChange={(e) => setForm((f) => ({ ...f, total_orders: e.target.value }))} placeholder="e.g. 342" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="wiz-revenue">Total Revenue (USD)</Label>
                <Input id="wiz-revenue" type="number" min="0" step="0.01" value={form.total_revenue} onChange={(e) => setForm((f) => ({ ...f, total_revenue: e.target.value }))} placeholder="e.g. 4200.00" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="wiz-aov">Average Order Value (USD)</Label>
                <Input id="wiz-aov" type="number" min="0" step="0.01" value={form.average_order_value} onChange={(e) => setForm((f) => ({ ...f, average_order_value: e.target.value }))} placeholder="e.g. 12.28" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="wiz-rating">Rating (out of 5)</Label>
                <Input id="wiz-rating" type="number" min="0" max="5" step="0.1" value={form.rating} onChange={(e) => setForm((f) => ({ ...f, rating: e.target.value }))} placeholder="e.g. 4.8" />
              </div>
            </div>
          </div>
        )}

        {/* Step 4: Operational Metrics */}
        {step === 4 && (
          <div className="space-y-4 py-2">
            <p className="text-xs text-muted-foreground">Enter times in minutes:seconds format.</p>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Prep Time (mm:ss)</Label>
                <div className="flex gap-1 items-center">
                  <Input className="w-16" type="number" min="0" value={form.prep_time_min} onChange={(e) => setForm((f) => ({ ...f, prep_time_min: e.target.value }))} placeholder="mm" />
                  <span className="text-muted-foreground">:</span>
                  <Input className="w-16" type="number" min="0" max="59" value={form.prep_time_sec} onChange={(e) => setForm((f) => ({ ...f, prep_time_sec: e.target.value }))} placeholder="ss" />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Delivery Time (mm:ss)</Label>
                <div className="flex gap-1 items-center">
                  <Input className="w-16" type="number" min="0" value={form.delivery_time_min} onChange={(e) => setForm((f) => ({ ...f, delivery_time_min: e.target.value }))} placeholder="mm" />
                  <span className="text-muted-foreground">:</span>
                  <Input className="w-16" type="number" min="0" max="59" value={form.delivery_time_sec} onChange={(e) => setForm((f) => ({ ...f, delivery_time_sec: e.target.value }))} placeholder="ss" />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="wiz-cancel">Cancel Rate (%)</Label>
                <Input id="wiz-cancel" type="number" min="0" max="100" step="0.1" value={form.cancel_rate} onChange={(e) => setForm((f) => ({ ...f, cancel_rate: e.target.value }))} placeholder="e.g. 2.1" />
              </div>
              <div className="space-y-1.5">
                <Label>Driver Wait Time (mm:ss)</Label>
                <div className="flex gap-1 items-center">
                  <Input className="w-16" type="number" min="0" value={form.driver_wait_min} onChange={(e) => setForm((f) => ({ ...f, driver_wait_min: e.target.value }))} placeholder="mm" />
                  <span className="text-muted-foreground">:</span>
                  <Input className="w-16" type="number" min="0" max="59" value={form.driver_wait_sec} onChange={(e) => setForm((f) => ({ ...f, driver_wait_sec: e.target.value }))} placeholder="ss" />
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Step 5: Best-Selling Items */}
        {step === 5 && (
          <div className="space-y-3 py-2">
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">Extracted items from the report. Use the match button to re-run product matching.</p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => matchMutation.mutate({ importId: importItem.id })}
                disabled={matchMutation.isPending}
              >
                {matchMutation.isPending ? <Loader2 size={12} className="animate-spin mr-1" /> : <RefreshCw size={12} className="mr-1" />}
                Re-match
              </Button>
            </div>
            {(extractedData.items ?? []).length === 0 ? (
              <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                No items extracted yet. Run product matching to populate this list.
              </div>
            ) : (
              <div className="rounded-lg border border-border overflow-hidden">
                <div className="bg-muted/20 grid grid-cols-[40px_2fr_80px_100px_2fr_90px] gap-3 px-4 py-2 text-xs font-medium text-muted-foreground">
                  <span>#</span><span>Item</span><span>Qty</span><span>Revenue</span><span>Matched Product</span><span>Status</span>
                </div>
                <div className="divide-y divide-border max-h-64 overflow-y-auto">
                  {(extractedData.items ?? []).map((item, i) => (
                    <div key={i} className="grid grid-cols-[40px_2fr_80px_100px_2fr_90px] gap-3 px-4 py-2.5 text-sm items-center">
                      <span className="text-xs text-muted-foreground">{item.rank ?? i + 1}</span>
                      <span className="text-xs font-medium truncate">{item.item_name}</span>
                      <span className="text-xs text-muted-foreground">{item.quantity ?? "—"}</span>
                      <span className="text-xs">{item.revenue != null ? formatCurrency(item.revenue) : "—"}</span>
                      <span className="text-xs truncate text-muted-foreground">{item.matched_product_name ?? "—"}</span>
                      <Badge className={`border-0 text-[10px] ${getMatchStatusStyle(item.match_status ?? "needs_review")}`}>
                        {item.match_status === "matched" ? "Matched" : item.match_status === "ignored" ? "Ignored" : "Review"}
                      </Badge>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Step 6: Approve */}
        {step === 6 && (
          <div className="space-y-4 py-2">
            <div className="rounded-lg border border-teal-200 bg-teal-50 dark:bg-teal-900/20 dark:border-teal-800 p-4 flex items-start gap-3">
              <Check size={18} className="text-teal-600 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-medium text-teal-800 dark:text-teal-200">Ready to approve</p>
                <p className="text-xs text-teal-700 dark:text-teal-300 mt-1">
                  Approving this import will promote it to a full marketplace report. This action cannot be undone.
                </p>
              </div>
            </div>
            <div className="rounded-lg border border-border bg-secondary/30 p-4 space-y-2 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div><p className="text-xs text-muted-foreground">Marketplace</p><p className="font-medium">{form.marketplace}</p></div>
                <div><p className="text-xs text-muted-foreground">Brand</p><p className="font-medium">{brands.find((b) => String(b.id) === form.detected_brand_id)?.name ?? "—"}</p></div>
                <div><p className="text-xs text-muted-foreground">Location</p><p className="font-medium">{locations.find((l) => String(l.id) === form.detected_location_id)?.name ?? "All"}</p></div>
                <div><p className="text-xs text-muted-foreground">Report Period</p><p className="font-medium">{formatWeekRange(form.report_period_start, form.report_period_end)}</p></div>
                <div><p className="text-xs text-muted-foreground">Orders</p><p className="font-medium">{form.total_orders || "—"}</p></div>
                <div><p className="text-xs text-muted-foreground">Revenue</p><p className="font-medium">{form.total_revenue ? formatCurrency(parseFloat(form.total_revenue)) : "—"}</p></div>
              </div>
            </div>
          </div>
        )}

        <DialogFooter className="flex items-center gap-2 mt-4">
          {step > 1 && (
            <Button variant="outline" size="sm" onClick={() => setStep((s) => s - 1)} disabled={isSaving}>
              <ChevronLeft size={14} className="mr-1" /> Back
            </Button>
          )}
          <div className="flex-1" />
          <Button variant="outline" size="sm" onClick={onClose} disabled={isSaving}>Cancel</Button>
          {step < totalSteps ? (
            <Button size="sm" onClick={handleNext} disabled={isSaving}>
              {isSaving ? <><Loader2 size={13} className="animate-spin mr-1.5" />Saving…</> : <>Next <ChevronRight size={14} className="ml-1" /></>}
            </Button>
          ) : (
            <Button size="sm" className="bg-teal-600 hover:bg-teal-700 text-white" onClick={handleApprove} disabled={isSaving}>
              {isSaving ? <><Loader2 size={13} className="animate-spin mr-1.5" />Approving…</> : <><Check size={13} className="mr-1.5" />Approve Report</>}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Manual Upload Dialog ─────────────────────────────────────────────────────

function ManualUploadDialog({
  brandId,
  open,
  onClose,
  onSuccess,
  locations,
}: {
  brandId: number;
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
  locations: Location[];
}) {
  const { toast } = useToast();
  const [form, setForm] = useState({
    marketplace: "Toters",
    location_id: "",
    report_period_start: "",
    report_period_end: "",
    notes: "",
  });
  const [file, setFile] = useState<File | null>(null);

  const uploadMutation = useManualMarketplaceReportUpload({
    mutation: {
      onSuccess: () => {
        toast({ title: "Report uploaded", description: "The PDF has been queued for processing." });
        onSuccess();
        onClose();
        setForm({ marketplace: "Toters", location_id: "", report_period_start: "", report_period_end: "", notes: "" });
        setFile(null);
      },
      onError: (err) => {
        toast({ variant: "destructive", title: "Upload failed", description: err instanceof Error ? err.message : "Could not upload" });
      },
    },
  });

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) { toast({ variant: "destructive", title: "PDF required" }); return; }
    uploadMutation.mutate({
      brandId,
      data: {
        pdf: file,
        marketplace: form.marketplace,
        location_id: form.location_id ? parseInt(form.location_id, 10) : null,
        report_period_start: form.report_period_start || undefined,
        report_period_end: form.report_period_end || undefined,
        notes: form.notes || undefined,
      },
    });
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload size={18} className="text-teal-600" />
            Upload Marketplace Report
          </DialogTitle>
          <DialogDescription>Upload a PDF report to be processed and reviewed.</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="up-marketplace">Marketplace</Label>
            <Select value={form.marketplace} onValueChange={(v) => setForm((f) => ({ ...f, marketplace: v }))}>
              <SelectTrigger id="up-marketplace"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="Toters">Toters</SelectItem>
                <SelectItem value="Careem">Careem</SelectItem>
                <SelectItem value="Talabat">Talabat</SelectItem>
                <SelectItem value="Deliveroo">Deliveroo</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="up-location">Location (optional)</Label>
            <Select value={form.location_id || "__all__"} onValueChange={(v) => setForm((f) => ({ ...f, location_id: v === "__all__" ? "" : v }))}>
              <SelectTrigger id="up-location"><SelectValue placeholder="All locations" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__"><span className="text-muted-foreground">All locations</span></SelectItem>
                {locations.map((l) => <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="up-start">Report Start Date</Label>
              <Input id="up-start" type="date" value={form.report_period_start} onChange={(e) => setForm((f) => ({ ...f, report_period_start: e.target.value }))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="up-end">Report End Date</Label>
              <Input id="up-end" type="date" value={form.report_period_end} onChange={(e) => setForm((f) => ({ ...f, report_period_end: e.target.value }))} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>PDF File <span className="text-destructive">*</span></Label>
            <div
              className={`relative border-2 border-dashed rounded-lg p-4 text-center cursor-pointer transition-colors ${file ? "border-teal-400 bg-teal-50 dark:bg-teal-900/20" : "border-border hover:border-teal-400"}`}
              onClick={() => document.getElementById("up-pdf-input")?.click()}
            >
              <input
                id="up-pdf-input"
                type="file"
                accept="application/pdf"
                className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) setFile(f); e.target.value = ""; }}
              />
              {file ? (
                <div className="flex items-center justify-center gap-2 text-sm text-teal-700 dark:text-teal-300">
                  <FileText size={16} />
                  <span className="font-medium truncate max-w-[200px]">{file.name}</span>
                  <button type="button" onClick={(e) => { e.stopPropagation(); setFile(null); }} className="text-muted-foreground hover:text-foreground">
                    <X size={14} />
                  </button>
                </div>
              ) : (
                <div className="text-sm text-muted-foreground">
                  <Upload size={20} className="mx-auto mb-1 opacity-40" />
                  Click to select a PDF
                </div>
              )}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="up-notes">Notes (optional)</Label>
            <Input id="up-notes" value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder="e.g. Week 21 report" />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={uploadMutation.isPending}>Cancel</Button>
            <Button type="submit" disabled={uploadMutation.isPending || !file}>
              {uploadMutation.isPending ? <><Loader2 size={13} className="animate-spin mr-1.5" />Uploading…</> : "Upload Report"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ─── Brand Aliases Section ────────────────────────────────────────────────────

const MARKETPLACE_OPTIONS = ["Toters", "Careem", "Talabat", "Deliveroo", "Zomato", "Other"];

function BrandAliasesSection({
  locations,
  brands,
}: {
  locations: Location[];
  brands: { id: number; name: string }[];
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(false);

  // Add form state
  const [showAddForm, setShowAddForm] = useState(false);
  const [addForm, setAddForm] = useState({
    marketplace: "Toters",
    alias_name: "",
    brand_id: "",
    location_id: "",
  });

  // Edit state: id of the row being edited
  const [editId, setEditId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState({
    marketplace: "",
    alias_name: "",
    brand_id: "",
    location_id: "",
  });

  const { data, isLoading } = useListMarketplaceBrandAliases();
  const aliases: MarketplaceBrandAlias[] = data?.aliases ?? [];

  const createMutation = useCreateMarketplaceBrandAlias({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListMarketplaceBrandAliasesQueryKey() });
        toast({ title: "Alias saved" });
        setShowAddForm(false);
        setAddForm({ marketplace: "Toters", alias_name: "", brand_id: "", location_id: "" });
        setEditId(null);
      },
      onError: (err) => {
        toast({ variant: "destructive", title: "Failed to save alias", description: err instanceof Error ? err.message : "Could not save" });
      },
    },
  });

  const deleteMutation = useDeleteMarketplaceBrandAlias({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListMarketplaceBrandAliasesQueryKey() });
        toast({ title: "Alias deleted" });
      },
      onError: (err) => {
        toast({ variant: "destructive", title: "Failed to delete alias", description: err instanceof Error ? err.message : "Could not delete" });
      },
    },
  });

  const addDuplicate =
    addForm.alias_name.trim() !== ""
      ? aliases.find(
          (a) =>
            a.marketplace === addForm.marketplace &&
            a.alias_name.toLowerCase() === addForm.alias_name.trim().toLowerCase()
        ) ?? null
      : null;

  function handleAddSubmit() {
    if (!addForm.alias_name.trim() || !addForm.brand_id) {
      toast({ variant: "destructive", title: "Alias name and brand are required" });
      return;
    }
    if (addDuplicate) {
      toast({
        variant: "destructive",
        title: "Duplicate merchant name",
        description: `"${addForm.alias_name.trim()}" already exists for ${addForm.marketplace}. Edit or delete the existing entry instead.`,
      });
      return;
    }
    createMutation.mutate({
      data: {
        marketplace: addForm.marketplace,
        alias_name: addForm.alias_name.trim(),
        brand_id: parseInt(addForm.brand_id, 10),
        location_id: addForm.location_id ? parseInt(addForm.location_id, 10) : null,
      },
    });
  }

  function startEdit(alias: MarketplaceBrandAlias) {
    setEditId(alias.id);
    setEditForm({
      marketplace: alias.marketplace,
      alias_name: alias.alias_name,
      brand_id: alias.brand_id != null ? String(alias.brand_id) : "",
      location_id: alias.location_id != null ? String(alias.location_id) : "",
    });
  }

  const editDuplicate =
    editId !== null && editForm.alias_name.trim() !== ""
      ? aliases.find(
          (a) =>
            a.id !== editId &&
            a.marketplace === editForm.marketplace &&
            a.alias_name.toLowerCase() === editForm.alias_name.trim().toLowerCase()
        ) ?? null
      : null;

  async function handleEditSubmit(alias: MarketplaceBrandAlias) {
    if (!editForm.alias_name.trim() || !editForm.brand_id) {
      toast({ variant: "destructive", title: "Alias name and brand are required" });
      return;
    }
    if (editDuplicate) {
      toast({
        variant: "destructive",
        title: "Duplicate merchant name",
        description: `"${editForm.alias_name.trim()}" already exists for ${editForm.marketplace}. Edit or delete the existing entry instead.`,
      });
      return;
    }
    const aliasNameChanged = editForm.alias_name.trim() !== alias.alias_name || editForm.marketplace !== alias.marketplace;
    if (aliasNameChanged) {
      // Delete old and create new
      await deleteMutation.mutateAsync({ id: alias.id });
    }
    createMutation.mutate({
      data: {
        marketplace: editForm.marketplace,
        alias_name: editForm.alias_name.trim(),
        brand_id: parseInt(editForm.brand_id, 10),
        location_id: editForm.location_id ? parseInt(editForm.location_id, 10) : null,
      },
    });
  }

  const isBusy = createMutation.isPending || deleteMutation.isPending;

  return (
    <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-4 py-3 border-b border-border bg-muted/30 flex items-center justify-between hover:bg-muted/50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <Tag size={14} className="text-muted-foreground" />
          <h3 className="text-sm font-semibold">Brand Aliases</h3>
          {aliases.length > 0 && (
            <Badge className="bg-secondary text-muted-foreground border-0 text-[10px]">{aliases.length}</Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground hidden sm:inline">Auto-link reports by merchant name</span>
          {expanded ? <ChevronUp size={14} className="text-muted-foreground" /> : <ChevronDown size={14} className="text-muted-foreground" />}
        </div>
      </button>

      {expanded && (
        <div>
          {isLoading ? (
            <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Loader2 size={14} className="animate-spin" /> Loading aliases…
            </div>
          ) : aliases.length === 0 && !showAddForm ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              <Tag size={20} className="mx-auto mb-1.5 text-muted-foreground/40" />
              <p>No aliases yet.</p>
              <p className="text-xs mt-1">Add an alias to auto-link uploaded reports to a brand when the merchant name matches.</p>
              <Button size="sm" variant="outline" className="mt-3" onClick={() => setShowAddForm(true)}>
                <Plus size={13} className="mr-1.5" /> Add Alias
              </Button>
            </div>
          ) : (
            <div>
              {/* Header row */}
              <div className="hidden sm:grid grid-cols-[1fr_1.5fr_1.5fr_1fr_80px] gap-3 px-4 py-2 bg-muted/20 text-xs font-medium text-muted-foreground border-b border-border">
                <span>Marketplace</span>
                <span>Merchant Name (Alias)</span>
                <span>Brand</span>
                <span>Location</span>
                <span />
              </div>

              <div className="divide-y divide-border">
                {aliases.map((alias) =>
                  editId === alias.id ? (
                    /* Edit row */
                    <div key={alias.id} className="px-4 py-2.5 bg-secondary/10">
                      <div className="grid grid-cols-1 sm:grid-cols-[1fr_1.5fr_1.5fr_1fr_80px] gap-2 items-center">
                        <Select value={editForm.marketplace} onValueChange={(v) => setEditForm((f) => ({ ...f, marketplace: v }))}>
                          <SelectTrigger className="h-7 text-xs">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {MARKETPLACE_OPTIONS.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                          </SelectContent>
                        </Select>
                        <Input
                          value={editForm.alias_name}
                          onChange={(e) => setEditForm((f) => ({ ...f, alias_name: e.target.value }))}
                          className={`h-7 text-xs ${editDuplicate ? "border-destructive focus-visible:ring-destructive" : ""}`}
                          placeholder="e.g. Presentail Beirut"
                        />
                        <Select value={editForm.brand_id} onValueChange={(v) => setEditForm((f) => ({ ...f, brand_id: v }))}>
                          <SelectTrigger className="h-7 text-xs">
                            <SelectValue placeholder="Select brand" />
                          </SelectTrigger>
                          <SelectContent>
                            {brands.map((b) => <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>)}
                          </SelectContent>
                        </Select>
                        <Select value={editForm.location_id || "__none__"} onValueChange={(v) => setEditForm((f) => ({ ...f, location_id: v === "__none__" ? "" : v }))}>
                          <SelectTrigger className="h-7 text-xs">
                            <SelectValue placeholder="Any location" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__none__">Any location</SelectItem>
                            {locations.map((l) => <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>)}
                          </SelectContent>
                        </Select>
                        <div className="flex items-center gap-1">
                          <Button size="sm" variant="outline" className="h-7 w-7 p-0 text-green-600" disabled={isBusy || !!editDuplicate} onClick={() => handleEditSubmit(alias)}>
                            {isBusy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                          </Button>
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0" disabled={isBusy} onClick={() => setEditId(null)}>
                            <X size={12} />
                          </Button>
                        </div>
                      </div>
                      {editDuplicate && (
                        <p className="mt-1.5 flex items-center gap-1 text-xs text-destructive">
                          <AlertTriangle size={11} className="shrink-0" />
                          <span>
                            <span className="font-mono">{editForm.alias_name.trim()}</span> already exists for {editForm.marketplace} — edit or delete the existing entry instead.
                          </span>
                        </p>
                      )}
                    </div>
                  ) : (
                    /* Display row */
                    <div key={alias.id} className="px-4 py-2.5 grid grid-cols-[1fr_1.5fr_1.5fr_1fr_80px] gap-3 items-center text-sm hover:bg-secondary/20 transition-colors">
                      <span className="text-xs font-medium">{alias.marketplace}</span>
                      <span className="text-xs font-mono truncate" title={alias.alias_name}>{alias.alias_name}</span>
                      <span className="text-xs truncate">{alias.brand_name ?? <span className="text-muted-foreground">—</span>}</span>
                      <span className="text-xs text-muted-foreground truncate">{alias.location_name ?? "Any"}</span>
                      <div className="flex items-center gap-1">
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground" onClick={() => startEdit(alias)}>
                          <Pencil size={12} />
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"
                          disabled={deleteMutation.isPending}
                          onClick={() => deleteMutation.mutate({ id: alias.id })}
                        >
                          {deleteMutation.isPending ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
                        </Button>
                      </div>
                    </div>
                  )
                )}
              </div>

              {/* Add form */}
              {showAddForm ? (
                <div className="px-4 py-3 border-t border-border bg-secondary/10">
                  <p className="text-xs font-medium text-muted-foreground mb-2">New Alias</p>
                  <div className="grid grid-cols-1 sm:grid-cols-[1fr_1.5fr_1.5fr_1fr_80px] gap-2 items-end">
                    <div>
                      <Label className="text-xs mb-1 block">Marketplace</Label>
                      <Select value={addForm.marketplace} onValueChange={(v) => setAddForm((f) => ({ ...f, marketplace: v }))}>
                        <SelectTrigger className="h-7 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {MARKETPLACE_OPTIONS.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label className="text-xs mb-1 block">Merchant Name</Label>
                      <Input
                        value={addForm.alias_name}
                        onChange={(e) => setAddForm((f) => ({ ...f, alias_name: e.target.value }))}
                        className={`h-7 text-xs ${addDuplicate ? "border-destructive focus-visible:ring-destructive" : ""}`}
                        placeholder="e.g. Presentail Beirut"
                        onKeyDown={(e) => { if (e.key === "Enter") handleAddSubmit(); }}
                      />
                    </div>
                    <div>
                      <Label className="text-xs mb-1 block">Brand</Label>
                      <Select value={addForm.brand_id} onValueChange={(v) => setAddForm((f) => ({ ...f, brand_id: v }))}>
                        <SelectTrigger className="h-7 text-xs">
                          <SelectValue placeholder="Select brand" />
                        </SelectTrigger>
                        <SelectContent>
                          {brands.map((b) => <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                    <div>
                      <Label className="text-xs mb-1 block">Location <span className="text-muted-foreground">(optional)</span></Label>
                      <Select value={addForm.location_id || "__none__"} onValueChange={(v) => setAddForm((f) => ({ ...f, location_id: v === "__none__" ? "" : v }))}>
                        <SelectTrigger className="h-7 text-xs">
                          <SelectValue placeholder="Any location" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__none__">Any location</SelectItem>
                          {locations.map((l) => <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="flex items-center gap-1 pt-4 sm:pt-0">
                      <Button size="sm" className="h-7" disabled={isBusy || !!addDuplicate} onClick={handleAddSubmit}>
                        {isBusy ? <Loader2 size={12} className="animate-spin mr-1" /> : <Check size={12} className="mr-1" />}
                        Save
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7" disabled={isBusy} onClick={() => { setShowAddForm(false); setAddForm({ marketplace: "Toters", alias_name: "", brand_id: "", location_id: "" }); }}>
                        <X size={12} />
                      </Button>
                    </div>
                  </div>
                  {addDuplicate && (
                    <p className="mt-1.5 flex items-center gap-1 text-xs text-destructive">
                      <AlertTriangle size={11} className="shrink-0" />
                      <span>
                        <span className="font-mono">{addForm.alias_name.trim()}</span> already exists for {addForm.marketplace} — edit or delete the existing entry instead.
                      </span>
                    </p>
                  )}
                </div>
              ) : (
                <div className="px-4 py-2.5 border-t border-border">
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => { setShowAddForm(true); setEditId(null); }}>
                    <Plus size={12} className="mr-1.5" /> Add Alias
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatementAliasesLink() {
  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">Statement Aliases</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Manage marketplace statement-name mappings alongside your canonical brands.
          </p>
        </div>
        <a
          href="/brands?tab=statement-aliases"
          className="inline-flex h-8 items-center justify-center rounded-md border border-input bg-background px-3 text-xs font-medium shadow-sm transition-colors hover:bg-accent hover:text-accent-foreground"
          data-testid="manage-statement-aliases-link"
        >
          Manage aliases
        </a>
      </div>
    </div>
  );
}

// ─── Main Tab ─────────────────────────────────────────────────────────────────

export function MarketplaceReportsTab({
  brandId,
  brandName,
}: {
  brandId: number;
  brandName: string;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { realIsOwner } = useWorkspaceRole();

  // Inbound email address
  const { data: inboundEmailData } = useQuery({
    queryKey: ["marketplace-inbound-email"],
    queryFn: () => apiFetch<{ success: boolean; email: string; domain: string }>("/api/marketplace-reports/inbound-email"),
    enabled: realIsOwner,
    staleTime: Infinity,
  });
  const [copiedEmail, setCopiedEmail] = useState(false);

  function handleCopyEmail() {
    if (!inboundEmailData?.email) return;
    navigator.clipboard.writeText(inboundEmailData.email).then(() => {
      setCopiedEmail(true);
      setTimeout(() => setCopiedEmail(false), 2000);
    });
  }

  // Filters
  const [filterMarketplace, setFilterMarketplace] = useState("__all__");
  const [filterLocationId, setFilterLocationId] = useState("__all__");
  const [selectedReportId, setSelectedReportId] = useState<number | null>(null);

  // UI state
  const [importsExpanded, setImportsExpanded] = useState(true);
  const [reviewImport, setReviewImport] = useState<MarketplaceReportImport | null>(null);
  const [showUploadDialog, setShowUploadDialog] = useState(false);
  const [showReportDetail, setShowReportDetail] = useState(false);
  const [detailReportId, setDetailReportId] = useState<number | null>(null);
  const [reportsPage, setReportsPage] = useState(1);
  const REPORTS_PAGE_SIZE = 10;

  // Fetch locations
  const { data: locationsData } = useQuery({
    queryKey: ["locations"],
    queryFn: () => apiFetch<{ locations: Location[] }>("/api/locations"),
  });
  const locations: Location[] = locationsData?.locations ?? [];

  // Fetch brands (for wizard)
  const { data: allBrandsData } = useQuery({
    queryKey: ["brands"],
    queryFn: () => apiFetch<{ brands: { id: number; name: string }[] }>("/api/brands"),
  });
  const allBrands = allBrandsData?.brands ?? [];

  // Fetch approved reports
  const { data: reportsData, isLoading: reportsLoading } = useListBrandMarketplaceReports(
    brandId,
    {
      marketplace: filterMarketplace !== "__all__" ? filterMarketplace : undefined,
      location_id: filterLocationId !== "__all__" ? parseInt(filterLocationId, 10) : undefined,
    },
  );
  const reports: MarketplaceReport[] = reportsData?.reports ?? [];

  // Polling state: track import IDs that should be polled after a retry
  const [pollingIds, setPollingIds] = useState<Set<number>>(new Set());
  const pollingStartRef = useRef<Map<number, number>>(new Map());

  // Fetch imports (all)
  const { data: importsData, isLoading: importsLoading } = useListBrandMarketplaceReportImports(brandId);
  const allImports: MarketplaceReportImport[] = importsData?.imports ?? [];
  const pendingImports = allImports.filter((i) => i.import_status !== "approved" && i.import_status !== "duplicate");
  const actionableImports = allImports.filter((i) => i.import_status === "needs_review" || i.import_status === "extraction_failed");

  // Auto-poll while any import is still in `pending` (extraction in progress)
  const hasPendingImports = allImports.some((i) => i.import_status === "pending");
  useEffect(() => {
    if (!hasPendingImports) return;
    const interval = setInterval(() => {
      qc.invalidateQueries({ queryKey: getListBrandMarketplaceReportImportsQueryKey(brandId) });
    }, 3000);
    return () => clearInterval(interval);
  }, [hasPendingImports, brandId]);

  // Keep a ref to pollingIds so the transition-detection effect can read it
  // without adding pollingIds to its dependency array (which would cause spurious runs).
  const pollingIdsRef = useRef(pollingIds);
  useEffect(() => { pollingIdsRef.current = pollingIds; }, [pollingIds]);

  // Track each import's previous status so we can detect pending → terminal transitions.
  // We skip imports already tracked by pollingIds (the retry flow handles toasts for those).
  const prevImportStatusesRef = useRef<Map<number, string>>(new Map());
  useEffect(() => {
    for (const imp of allImports) {
      const prevStatus = prevImportStatusesRef.current.get(imp.id);
      if (prevStatus === "pending" && imp.import_status !== "pending") {
        if (!pollingIdsRef.current.has(imp.id)) {
          if (imp.import_status === "extraction_failed") {
            toast({
              variant: "destructive",
              title: "Extraction failed",
              description: "The report could not be extracted — try again.",
            });
          } else if (imp.import_status === "needs_review") {
            const captured = imp;
            toast({
              title: "Extraction complete — ready to review",
              description: "The report needs your review before it can be approved.",
              action: (
                <ToastAction altText="Review now" onClick={() => setReviewImport(captured)}>
                  Review now
                </ToastAction>
              ),
            });
          } else if (imp.import_status === "ready_to_approve") {
            const captured = imp;
            toast({
              title: "Extraction complete — ready to approve",
              description: "Review the import and approve it to add it to your reports.",
              action: (
                <ToastAction altText="Review now" onClick={() => setReviewImport(captured)}>
                  Review now
                </ToastAction>
              ),
            });
          } else {
            toast({
              title: "Extraction complete",
              description: `Status: ${getImportStatusLabel(imp.import_status)}`,
            });
          }
        }
      }
      prevImportStatusesRef.current.set(imp.id, imp.import_status);
    }
  }, [allImports]);

  // Drive refetches on a 3-second interval while there are pending retried imports
  useEffect(() => {
    if (pollingIds.size === 0) return;
    const interval = setInterval(() => {
      qc.invalidateQueries({ queryKey: getListBrandMarketplaceReportImportsQueryKey(brandId) });
    }, 3000);
    return () => clearInterval(interval);
  }, [pollingIds.size, brandId]);

  // Detect status changes for polled imports and stop polling when resolved or timed out
  useEffect(() => {
    if (pollingIds.size === 0) return;

    const now = Date.now();
    const toRemove: number[] = [];

    for (const imp of allImports) {
      if (!pollingIds.has(imp.id)) continue;

      const startTime = pollingStartRef.current.get(imp.id) ?? now;
      const elapsed = now - startTime;

      if (imp.import_status !== "pending") {
        toRemove.push(imp.id);
        if (imp.import_status === "extraction_failed") {
          toast({ variant: "destructive", title: "Extraction failed again", description: "The retry did not succeed. You can fix it manually." });
        } else {
          const captured = imp;
          toast({
            title: "Extraction complete",
            description: `Import status: ${getImportStatusLabel(imp.import_status)}`,
            action: (
              <ToastAction altText="Review now" onClick={() => setReviewImport(captured)}>
                Review now
              </ToastAction>
            ),
          });
        }
      } else if (elapsed > 30000) {
        toRemove.push(imp.id);
        toast({ title: "Still processing", description: "Extraction is taking longer than expected. Reload the page to check." });
      }
    }

    if (toRemove.length > 0) {
      for (const id of toRemove) pollingStartRef.current.delete(id);
      setPollingIds((prev) => {
        const next = new Set(prev);
        for (const id of toRemove) next.delete(id);
        return next;
      });
    }
  }, [allImports]);

  const [retryingId, setRetryingId] = useState<number | null>(null);
  const retryMutation = useRetryMarketplaceReportImport({
    mutation: {
      onSuccess: (_data, { importId }) => {
        setRetryingId(null);
        pollingStartRef.current.set(importId, Date.now());
        setPollingIds((prev) => new Set([...prev, importId]));
        qc.invalidateQueries({ queryKey: getListBrandMarketplaceReportImportsQueryKey(brandId) });
      },
      onError: (err) => {
        setRetryingId(null);
        toast({ variant: "destructive", title: "Retry failed", description: err instanceof Error ? err.message : "Could not retry extraction" });
      },
    },
  });

  function handleRetryClick(imp: MarketplaceReportImport) {
    setRetryingId(imp.id);
    retryMutation.mutate({ importId: imp.id });
  }

  const [reExtractingId, setReExtractingId] = useState<number | null>(null);
  const reExtractMutation = useReExtractMarketplaceReportImport({
    mutation: {
      onSuccess: (_data, { importId }) => {
        setReExtractingId(null);
        toast({ title: "Re-extraction queued", description: "AI extraction is running — refresh in a moment to see the updated status." });
        setTimeout(() => {
          qc.invalidateQueries({ queryKey: getListBrandMarketplaceReportImportsQueryKey(brandId) });
        }, 3000);
      },
      onError: (err) => {
        setReExtractingId(null);
        toast({ variant: "destructive", title: "Re-extraction failed", description: err instanceof Error ? err.message : "Could not re-extract" });
      },
    },
  });

  function handleReExtractClick(imp: MarketplaceReportImport) {
    setReExtractingId(imp.id);
    reExtractMutation.mutate({ importId: imp.id });
  }

  // Selected/latest report for KPIs
  const latestReport = selectedReportId
    ? reports.find((r) => r.id === selectedReportId) ?? reports[0]
    : reports[0];

  const { data: latestReportDetailData } = useQuery({
    ...getGetMarketplaceReportQueryOptions(latestReport?.id ?? 0),
    enabled: !!latestReport,
  });
  const latestDetail = latestReportDetailData?.report as MarketplaceReportDetail | undefined;

  const kpiOrders = latestDetail ? getMetricByName(latestDetail.metrics, "total_orders") : null;
  const kpiRevenue = latestDetail ? getMetricByName(latestDetail.metrics, "total_revenue") : null;
  const kpiAov = latestDetail ? getMetricByName(latestDetail.metrics, "average_order_value") : null;
  const kpiRating = latestDetail ? getMetricByName(latestDetail.metrics, "rating") : null;
  const kpiPrepTime = latestDetail ? getMetricByName(latestDetail.metrics, "prep_time_seconds") : null;
  const kpiDelivery = latestDetail ? getMetricByName(latestDetail.metrics, "delivery_time_seconds") : null;
  const kpiCancelRate = latestDetail ? getMetricByName(latestDetail.metrics, "cancel_rate") : null;
  const kpiDriverWait = latestDetail ? getMetricByName(latestDetail.metrics, "driver_wait_seconds") : null;

  const trendData = (latestDetail?.weekly_trends ?? []).reduce<Record<string, { week: string; orders?: number; revenue?: number }>>((acc, t) => {
    if (!acc[t.week_label]) acc[t.week_label] = { week: t.week_label };
    if (t.metric_name === "orders") acc[t.week_label].orders = t.value ?? undefined;
    if (t.metric_name === "revenue") acc[t.week_label].revenue = t.value ?? undefined;
    return acc;
  }, {});
  const chartData = Object.values(trendData);

  const items = latestDetail?.items ?? [];

  // Distinct marketplaces from reports
  const marketplaceOptions = Array.from(new Set(reports.map((r) => r.marketplace)));

  // Paginated reports
  const totalPages = Math.max(1, Math.ceil(reports.length / REPORTS_PAGE_SIZE));
  const paginatedReports = reports.slice((reportsPage - 1) * REPORTS_PAGE_SIZE, reportsPage * REPORTS_PAGE_SIZE);

  function handleReviewClick(imp: MarketplaceReportImport) {
    setReviewImport(imp);
  }

  function handleApproved() {
    qc.invalidateQueries({ queryKey: getListBrandMarketplaceReportsQueryKey(brandId) });
    qc.invalidateQueries({ queryKey: getListBrandMarketplaceReportImportsQueryKey(brandId) });
  }

  function handleUploadSuccess() {
    qc.invalidateQueries({ queryKey: getListBrandMarketplaceReportImportsQueryKey(brandId) });
  }

  return (
    <div className="space-y-6 pt-6">
      {/* ── Header row ── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <p className="text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1">
              Brands › {brandName} › Marketplace Reports
            </span>
          </p>
          <h2 className="text-sm font-semibold mt-0.5">Marketplace Reports</h2>
        </div>
        <Button size="sm" onClick={() => setShowUploadDialog(true)}>
          <Upload size={14} className="mr-1.5" />
          Upload Report
        </Button>
      </div>

      {/* ── Inbound Email Card (owners only) ── */}
      {realIsOwner && inboundEmailData?.email && (
        <div className="rounded-xl border border-teal-200 bg-teal-50 dark:border-teal-800 dark:bg-teal-950/30 p-4 flex flex-col sm:flex-row sm:items-center gap-3">
          <div className="flex items-center gap-2 shrink-0 text-teal-700 dark:text-teal-400">
            <Mail size={16} />
            <span className="text-sm font-semibold">Your Report Inbound Email</span>
          </div>
          <div className="flex-1 flex items-center gap-2 min-w-0">
            <code className="flex-1 truncate rounded-md bg-white dark:bg-teal-900/40 border border-teal-200 dark:border-teal-700 px-3 py-1.5 text-xs font-mono text-teal-800 dark:text-teal-200 select-all">
              {inboundEmailData.email}
            </code>
            <Button
              size="sm"
              variant="outline"
              className="shrink-0 h-8 border-teal-300 dark:border-teal-700 hover:bg-teal-100 dark:hover:bg-teal-900/50"
              onClick={handleCopyEmail}
            >
              {copiedEmail ? (
                <><Check size={13} className="mr-1.5 text-green-600" /> Copied</>
              ) : (
                <><Copy size={13} className="mr-1.5" /> Copy</>
              )}
            </Button>
          </div>
          <p className="text-xs text-teal-600 dark:text-teal-400 sm:w-48 shrink-0">
            Give this address to Toters or Careem to receive reports automatically by email.
          </p>
        </div>
      )}

      {/* ── Filters row ── */}
      <div className="flex flex-wrap items-center gap-3 pb-3 border-b border-border">
        <div className="flex items-center gap-1.5">
          <label className="text-xs font-medium text-muted-foreground">Marketplace</label>
          <Select value={filterMarketplace} onValueChange={(v) => { setFilterMarketplace(v); setReportsPage(1); }}>
            <SelectTrigger className="h-7 text-xs w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All</SelectItem>
              {marketplaceOptions.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
              <SelectItem value="Toters">Toters</SelectItem>
              <SelectItem value="Careem">Careem</SelectItem>
              <SelectItem value="Talabat">Talabat</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-1.5">
          <label className="text-xs font-medium text-muted-foreground">Location</label>
          <Select value={filterLocationId} onValueChange={(v) => { setFilterLocationId(v); setReportsPage(1); }}>
            <SelectTrigger className="h-7 text-xs w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">All Locations</SelectItem>
              {locations.map((l) => <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        {reports.length > 0 && (
          <div className="flex items-center gap-1.5">
            <label className="text-xs font-medium text-muted-foreground">Report Week</label>
            <Select value={selectedReportId != null ? String(selectedReportId) : "__latest__"} onValueChange={(v) => setSelectedReportId(v === "__latest__" ? null : parseInt(v, 10))}>
              <SelectTrigger className="h-7 text-xs w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__latest__">Latest</SelectItem>
                {reports.map((r) => (
                  <SelectItem key={r.id} value={String(r.id)}>
                    {formatWeekRange(r.report_period_start, r.report_period_end)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
        <span className="ml-auto text-xs text-muted-foreground">{reports.length} approved report{reports.length !== 1 ? "s" : ""}</span>
      </div>

      {/* ── KPI Cards ── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <MktKpiCard
          icon={<BarChart2 size={16} />}
          label="Latest Report"
          value={latestReport ? formatWeekRange(latestReport.report_period_start, latestReport.report_period_end).split("–")[0].trim() : "—"}
          sub={latestReport ? latestReport.marketplace : "No reports yet"}
        />
        <MktKpiCard icon={<ShoppingCart size={16} />} label="Weekly Orders" value={kpiOrders != null ? kpiOrders.toLocaleString() : "—"} sub="This report" />
        <MktKpiCard icon={<DollarSign size={16} />} label="Weekly Revenue" value={kpiRevenue != null ? formatCurrency(kpiRevenue) : "—"} sub="This report" />
        <MktKpiCard icon={<TrendingUp size={16} />} label="AOV" value={kpiAov != null ? formatCurrency(kpiAov) : "—"} sub="Average order value" />
        <MktKpiCard
          icon={<Star size={16} />}
          label="Rating"
          value={kpiRating != null ? kpiRating.toFixed(1) : "—"}
          sub="Customer rating"
          badge={kpiRating != null && kpiRating >= 4.5 ? <Badge className="bg-green-100 text-green-700 border-0 text-[10px]">Excellent</Badge> : undefined}
        />
      </div>

      {/* ── Source & Storage + Import Status cards ── */}
      {latestReport && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="rounded-xl border border-border bg-card shadow-sm p-4 space-y-2">
            <h3 className="text-sm font-semibold flex items-center gap-1.5"><Info size={14} className="text-muted-foreground" /> Source & Storage</h3>
            <div className="text-sm space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Marketplace</span>
                <span className="font-medium">{latestReport.marketplace}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Location</span>
                <span className="font-medium">{latestReport.location_name ?? "All"}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Approved</span>
                <span className="font-medium">{formatDate(latestReport.created_at)}</span>
              </div>
              <div className="flex items-center justify-between pt-1">
                <span className="text-xs text-muted-foreground">Source PDF</span>
                <a
                  href={`/api/marketplace-reports/${latestReport.id}/source-pdf`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-teal-600 hover:underline text-xs"
                >
                  <FileText size={11} /> View PDF <ExternalLink size={10} />
                </a>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-border bg-card shadow-sm p-4 space-y-2">
            <h3 className="text-sm font-semibold flex items-center gap-1.5"><AlertCircle size={14} className="text-muted-foreground" /> Import Status</h3>
            <div className="text-sm space-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Pending reviews</span>
                <Badge className={`border-0 text-[11px] ${pendingImports.length > 0 ? "bg-amber-100 text-amber-700" : "bg-green-100 text-green-700"}`}>
                  {pendingImports.length}
                </Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Total imports</span>
                <span className="font-medium">{allImports.length}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Approved</span>
                <span className="font-medium">{reports.length}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Operational Metrics card ── */}
      {latestDetail && (kpiPrepTime != null || kpiDelivery != null || kpiCancelRate != null || kpiDriverWait != null) && (
        <div className="rounded-xl border border-border bg-card shadow-sm p-4">
          <h3 className="text-sm font-semibold mb-3 flex items-center gap-1.5"><Clock size={14} className="text-muted-foreground" /> Operational Metrics</h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
            <div>
              <p className="text-xs text-muted-foreground flex items-center gap-1"><Clock size={10} /> Prep Time</p>
              <p className="font-medium mt-0.5">{formatSeconds(kpiPrepTime)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground flex items-center gap-1"><Truck size={10} /> Delivery Time</p>
              <p className="font-medium mt-0.5">{formatSeconds(kpiDelivery)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground flex items-center gap-1"><X size={10} /> Cancel Rate</p>
              <p className="font-medium mt-0.5">{kpiCancelRate != null ? `${kpiCancelRate.toFixed(1)}%` : "—"}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground flex items-center gap-1"><Clock size={10} /> Driver Wait</p>
              <p className="font-medium mt-0.5">{formatSeconds(kpiDriverWait)}</p>
            </div>
          </div>
        </div>
      )}

      {/* ── Trend Chart ── */}
      {chartData.length > 1 && (
        <div className="rounded-xl border border-border bg-card shadow-sm p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold flex items-center gap-1.5"><TrendingUp size={14} className="text-muted-foreground" /> Orders & Revenue Trend</h3>
            <p className="text-xs text-muted-foreground">{latestReport?.marketplace} · {formatWeekRange(latestReport?.report_period_start, latestReport?.report_period_end)}</p>
          </div>
          <ResponsiveContainer width="100%" height={220}>
            <ComposedChart data={chartData} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey="week" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
              <YAxis yAxisId="orders" orientation="left" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={32} allowDecimals={false} />
              <YAxis yAxisId="revenue" orientation="right" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={55} tickFormatter={(v) => `$${v}`} />
              <RechartsTooltip contentStyle={{ fontSize: 12 }} />
              <Legend iconSize={10} wrapperStyle={{ fontSize: 11 }} />
              <Bar yAxisId="orders" dataKey="orders" fill="#0d9488" opacity={0.8} radius={[3, 3, 0, 0]} name="Orders" />
              <Line yAxisId="revenue" type="monotone" dataKey="revenue" stroke="#6366f1" strokeWidth={2} dot={{ r: 3 }} name="Revenue ($)" />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* ── Best-Selling Items ── */}
      {items.length > 0 && (
        <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
          <div className="px-4 py-3 border-b border-border bg-muted/30 flex items-center gap-2">
            <Package size={14} className="text-muted-foreground" />
            <h3 className="text-sm font-semibold">Best-Selling Items</h3>
            <span className="text-xs text-muted-foreground">({items.length})</span>
          </div>
          <div className="divide-y divide-border">
            <div className="hidden sm:grid grid-cols-[40px_2fr_80px_110px_90px_2fr_100px] gap-3 px-4 py-2 bg-muted/20 text-xs font-medium text-muted-foreground">
              <span>Rank</span><span>Item</span><span>Qty</span><span>Total Paid</span><span>% of Rev</span><span>Matched Product</span><span>Match Status</span>
            </div>
            {items.map((item) => {
              const revTotal = kpiRevenue ?? 1;
              const pct = item.revenue != null ? ((item.revenue / revTotal) * 100).toFixed(1) : "—";
              return (
                <div key={item.id} className="grid grid-cols-[40px_2fr_80px_110px_90px_2fr_100px] gap-3 px-4 py-2.5 text-sm items-center hover:bg-secondary/20 transition-colors">
                  <span className="text-xs text-muted-foreground font-medium">{item.rank ?? "—"}</span>
                  <span className="text-sm font-medium truncate">{item.item_name}</span>
                  <span className="text-xs text-muted-foreground">{item.quantity ?? "—"}</span>
                  <span className="text-xs">{item.revenue != null ? formatCurrency(item.revenue) : "—"}</span>
                  <span className="text-xs text-muted-foreground">{pct !== "—" ? `${pct}%` : "—"}</span>
                  <span className="text-xs truncate">
                    {item.matched_product_name ? (
                      <a href={`/products/${item.matched_product_id}`} target="_blank" rel="noopener noreferrer" className="text-teal-600 hover:underline flex items-center gap-1">
                        {item.matched_product_name} <ExternalLink size={10} />
                      </a>
                    ) : <span className="text-muted-foreground">—</span>}
                  </span>
                  <Badge className={`border-0 text-[10px] ${getMatchStatusStyle(item.match_status)}`}>
                    {item.match_status === "matched" ? "Matched" : item.match_status === "needs_review" ? "Needs Review" : "Ignored"}
                  </Badge>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Error / Needs-Review Banners ── */}
      {actionableImports.length > 0 && (
        <div className="space-y-2">
          {actionableImports.map((imp) => {
            const isError = imp.import_status === "extraction_failed";
            const isRetrying = retryingId === imp.id || pollingIds.has(imp.id);
            return (
              <div
                key={imp.id}
                className={`flex items-start gap-3 rounded-xl border px-4 py-3 ${isError ? "border-red-200 bg-red-50 dark:border-red-900/40 dark:bg-red-900/10" : "border-amber-200 bg-amber-50 dark:border-amber-900/40 dark:bg-amber-900/10"}`}
              >
                <AlertCircle size={16} className={`shrink-0 mt-0.5 ${isError ? "text-red-500" : "text-amber-500"}`} />
                <div className="flex-1 min-w-0">
                  <p className={`text-sm font-semibold ${isError ? "text-red-700 dark:text-red-400" : "text-amber-700 dark:text-amber-400"}`}>
                    {isError ? "PDF extraction failed" : "Import needs manual review"}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {imp.marketplace}
                    {imp.detected_merchant_name ? ` · ${imp.detected_merchant_name}` : ""}
                    {imp.report_period_start ? ` · ${formatWeekRange(imp.report_period_start, imp.report_period_end)}` : ""}
                    {" · "}Received {formatDate(imp.created_at)}
                  </p>
                </div>
                {isError && realIsOwner ? (
                  <div className="shrink-0 flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-red-300 text-red-700 hover:bg-red-50 dark:border-red-700 dark:text-red-400"
                      disabled={isRetrying}
                      onClick={() => handleRetryClick(imp)}
                    >
                      {isRetrying ? <Loader2 size={13} className="mr-1.5 animate-spin" /> : <RefreshCw size={13} className="mr-1.5" />}
                      Retry extraction
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-muted-foreground"
                      disabled={isRetrying}
                      onClick={() => handleReviewClick(imp)}
                    >
                      Fix manually
                    </Button>
                  </div>
                ) : !isError && realIsOwner ? (
                  <div className="shrink-0 flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-amber-300 text-amber-700 hover:bg-amber-50 dark:border-amber-700 dark:text-amber-400"
                      disabled={reExtractingId === imp.id}
                      onClick={() => handleReExtractClick(imp)}
                    >
                      {reExtractingId === imp.id ? <Loader2 size={13} className="mr-1.5 animate-spin" /> : <RefreshCw size={13} className="mr-1.5" />}
                      Re-extract with AI
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-muted-foreground"
                      disabled={reExtractingId === imp.id}
                      onClick={() => handleReviewClick(imp)}
                    >
                      Fix manually
                    </Button>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    variant={isError ? "destructive" : "outline"}
                    className="shrink-0"
                    onClick={() => handleReviewClick(imp)}
                  >
                    <RefreshCw size={13} className="mr-1.5" /> Fix &amp; Approve
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── Import History ── */}
      <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
        <button
          type="button"
          onClick={() => setImportsExpanded((v) => !v)}
          className="w-full px-4 py-3 border-b border-border bg-muted/30 flex items-center justify-between hover:bg-muted/50 transition-colors"
        >
          <div className="flex items-center gap-2">
            <AlertCircle size={14} className="text-muted-foreground" />
            <h3 className="text-sm font-semibold">Import History</h3>
            {hasPendingImports && (
              <Badge className="bg-blue-100 text-blue-700 border-0 text-[10px] gap-1 dark:bg-blue-900/30 dark:text-blue-400">
                <Loader2 size={9} className="animate-spin" />
                {allImports.filter((i) => i.import_status === "pending").length} extracting
              </Badge>
            )}
            {pendingImports.length > 0 && (
              <Badge className="bg-amber-100 text-amber-700 border-0 text-[10px]">{pendingImports.length} pending</Badge>
            )}
            {actionableImports.length > 0 && (
              <Badge className="bg-red-100 text-red-700 border-0 text-[10px]">{actionableImports.length} need attention</Badge>
            )}
          </div>
          {importsExpanded ? <ChevronUp size={14} className="text-muted-foreground" /> : <ChevronDown size={14} className="text-muted-foreground" />}
        </button>

        {importsExpanded && (
          <div>
            {importsLoading ? (
              <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
                <Loader2 size={14} className="animate-spin" /> Loading imports…
              </div>
            ) : allImports.length === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground">
                <FileText size={20} className="mx-auto mb-1.5 text-muted-foreground/40" />
                No imports yet. Upload a PDF report to get started.
              </div>
            ) : (
              <div className="divide-y divide-border">
                {allImports.map((imp) => {
                  const isActionable = imp.import_status === "needs_review" || imp.import_status === "extraction_failed";
                  const isApproved = imp.import_status === "approved";
                  const isReadyToApprove = imp.import_status === "ready_to_approve";
                  return (
                    <div key={imp.id} className={`px-4 py-3 flex items-start gap-3 hover:bg-secondary/20 transition-colors ${isActionable ? "bg-amber-50/40 dark:bg-amber-900/5" : ""}`}>
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-2 mb-1">
                          <ImportStatusBadge status={imp.import_status} />
                          <ConfidenceBadge confidence={(imp.extracted_data as ExtractedData | null)?.confidence} />
                          <span className="text-xs font-medium">{imp.marketplace}</span>
                          {imp.brand_name && <span className="text-xs text-muted-foreground">· {imp.brand_name}</span>}
                          {imp.location_name && <span className="text-xs text-muted-foreground">· {imp.location_name}</span>}
                        </div>
                        {imp.detected_merchant_name && (
                          <p className="text-xs text-muted-foreground">Merchant: {imp.detected_merchant_name}</p>
                        )}
                        {(imp.report_period_start || imp.report_period_end) && (
                          <p className="text-xs text-muted-foreground">Period: {formatWeekRange(imp.report_period_start, imp.report_period_end)}</p>
                        )}
                        <p className="text-xs text-muted-foreground mt-0.5">Received {formatDate(imp.created_at)}</p>
                      </div>
                      {isApproved && imp.approved_report_id != null ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="shrink-0 text-teal-600 hover:text-teal-700"
                          onClick={() => { setDetailReportId(imp.approved_report_id!); setShowReportDetail(true); }}
                        >
                          <BarChart2 size={13} className="mr-1.5" /> View Report
                        </Button>
                      ) : imp.import_status === "extraction_failed" ? (
                        <div className="shrink-0 flex items-center gap-1.5">
                          {realIsOwner && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="border-red-300 text-red-700 hover:bg-red-50 dark:border-red-700 dark:text-red-400"
                              disabled={retryingId === imp.id || pollingIds.has(imp.id)}
                              onClick={() => handleRetryClick(imp)}
                            >
                              {(retryingId === imp.id || pollingIds.has(imp.id)) ? <Loader2 size={13} className="mr-1.5 animate-spin" /> : <RefreshCw size={13} className="mr-1.5" />}
                              Retry
                            </Button>
                          )}
                          <Button size="sm" variant="ghost" className="text-muted-foreground" onClick={() => handleReviewClick(imp)}>
                            Fix manually
                          </Button>
                        </div>
                      ) : isActionable ? (
                        <div className="shrink-0 flex items-center gap-1.5">
                          {realIsOwner && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="border-amber-300 text-amber-700 hover:bg-amber-50 dark:border-amber-700 dark:text-amber-400"
                              disabled={reExtractingId === imp.id}
                              onClick={() => handleReExtractClick(imp)}
                            >
                              {reExtractingId === imp.id ? <Loader2 size={13} className="mr-1.5 animate-spin" /> : <RefreshCw size={13} className="mr-1.5" />}
                              Re-extract with AI
                            </Button>
                          )}
                          <Button size="sm" variant="ghost" className="text-muted-foreground" disabled={reExtractingId === imp.id} onClick={() => handleReviewClick(imp)}>
                            Fix manually
                          </Button>
                        </div>
                      ) : isReadyToApprove ? (
                        <Button size="sm" variant="outline" className="shrink-0" onClick={() => handleReviewClick(imp)}>
                          <Eye size={13} className="mr-1.5" /> Review &amp; Approve
                        </Button>
                      ) : imp.import_status === "pending" ? (
                        <span className="shrink-0 flex items-center gap-1.5 text-xs text-blue-600 dark:text-blue-400">
                          <Loader2 size={12} className="animate-spin" />
                          Extracting…
                        </span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Approved Reports Table ── */}
      <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b border-border bg-muted/30 flex items-center gap-2">
          <BarChart2 size={14} className="text-muted-foreground" />
          <h3 className="text-sm font-semibold">Approved Reports</h3>
          <span className="text-xs text-muted-foreground">({reports.length})</span>
        </div>

        {reportsLoading ? (
          <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <Loader2 size={14} className="animate-spin" /> Loading reports…
          </div>
        ) : reports.length === 0 ? (
          <div className="p-10 text-center">
            <BarChart2 size={28} className="mx-auto mb-2 text-muted-foreground/40" />
            <p className="text-sm text-muted-foreground">No approved reports yet.</p>
            <p className="text-xs text-muted-foreground mt-1">Upload a PDF report or wait for the next automatic import.</p>
          </div>
        ) : (
          <>
            <div className="divide-y divide-border">
              <div className="hidden sm:grid grid-cols-[2fr_120px_140px_80px_100px_80px_100px_80px] gap-3 px-4 py-2 bg-muted/20 text-xs font-medium text-muted-foreground">
                <span>Report Week</span>
                <span>Marketplace</span>
                <span>Location</span>
                <span>Orders</span>
                <span>Revenue</span>
                <span>AOV</span>
                <span>Approved</span>
                <span>PDF</span>
              </div>
              {paginatedReports.map((report) => (
                <div
                  key={report.id}
                  className="grid grid-cols-[2fr_120px_140px_80px_100px_80px_100px_80px] gap-3 px-4 py-2.5 text-sm items-center hover:bg-secondary/30 transition-colors cursor-pointer"
                  onClick={() => { setDetailReportId(report.id); setShowReportDetail(true); }}
                >
                  <div className="min-w-0">
                    <p className="text-xs font-medium truncate">{formatWeekRange(report.report_period_start, report.report_period_end)}</p>
                    {report.detected_merchant_name && (
                      <p className="text-[10px] text-muted-foreground font-mono truncate" title={report.detected_merchant_name}>
                        {report.detected_merchant_name}
                      </p>
                    )}
                  </div>
                  <span className="text-xs">{report.marketplace}</span>
                  <span className="text-xs text-muted-foreground truncate">{report.location_name ?? "All"}</span>
                  <span className="text-xs text-muted-foreground">—</span>
                  <span className="text-xs text-muted-foreground">—</span>
                  <span className="text-xs text-muted-foreground">—</span>
                  <span className="text-xs text-muted-foreground">{formatDate(report.created_at)}</span>
                  <a
                    href={`/api/marketplace-reports/${report.id}/source-pdf`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-teal-600 hover:underline text-xs flex items-center gap-1"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <FileText size={11} /> PDF
                  </a>
                </div>
              ))}
            </div>
            {totalPages > 1 && (
              <div className="px-4 py-2.5 border-t border-border flex items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">Page {reportsPage} of {totalPages} · {reports.length} reports</p>
                <div className="flex items-center gap-1">
                  <Button size="sm" variant="outline" className="h-7 w-7 p-0" disabled={reportsPage <= 1} onClick={() => setReportsPage((p) => p - 1)}>
                    <ChevronLeft size={13} />
                  </Button>
                  <Button size="sm" variant="outline" className="h-7 w-7 p-0" disabled={reportsPage >= totalPages} onClick={() => setReportsPage((p) => p + 1)}>
                    <ChevronRight size={13} />
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <StatementAliasesLink />

      {/* ── Dialogs ── */}
      <ReviewWizard
        importItem={reviewImport}
        open={reviewImport !== null}
        onClose={() => setReviewImport(null)}
        onApproved={handleApproved}
        locations={locations}
        brands={allBrands}
      />

      <ManualUploadDialog
        brandId={brandId}
        open={showUploadDialog}
        onClose={() => setShowUploadDialog(false)}
        onSuccess={handleUploadSuccess}
        locations={locations}
      />

      <ReportDetailDrawer
        reportId={detailReportId}
        open={showReportDetail}
        onClose={() => { setShowReportDetail(false); setDetailReportId(null); }}
      />
    </div>
  );
}

// ─── Single marketplace/location combo mini-card ──────────────────────────────

function MarketplaceComboCard({ report }: { report: MarketplaceReport }) {
  const { data: detailData } = useQuery({
    ...getGetMarketplaceReportQueryOptions(report.id),
    enabled: true,
  });
  const detail = detailData?.report as MarketplaceReportDetail | undefined;

  const orders = detail ? getMetricByName(detail.metrics, "total_orders") : null;
  const revenue = detail ? getMetricByName(detail.metrics, "total_revenue") : null;
  const aov = detail ? getMetricByName(detail.metrics, "average_order_value") : null;
  const rating = detail ? getMetricByName(detail.metrics, "rating") : null;
  const topItem = detail?.items?.[0];

  const sparklineData = (detail?.weekly_trends ?? []).reduce<Record<string, { week: string; orders?: number }>>((acc, t) => {
    if (!acc[t.week_label]) acc[t.week_label] = { week: t.week_label };
    if (t.metric_name === "orders") acc[t.week_label].orders = t.value ?? undefined;
    return acc;
  }, {});
  const sparkData = Object.values(sparklineData);
  const gradId = `mktGrad-${report.id}`;

  return (
    <div className="rounded-xl border border-border bg-card p-4 shadow-sm space-y-3">
      <div className="space-y-0.5">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-semibold">{report.marketplace}</span>
          {report.location_name && (
            <Badge className="bg-secondary text-muted-foreground border-0 text-[10px]">{report.location_name}</Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">{formatWeekRange(report.report_period_start, report.report_period_end)}</p>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <div>
          <p className="text-xs text-muted-foreground">Orders</p>
          <p className="font-semibold">{orders != null ? orders.toLocaleString() : detail ? "—" : "…"}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Revenue</p>
          <p className="font-semibold">{revenue != null ? formatCurrency(revenue) : detail ? "—" : "…"}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">AOV</p>
          <p className="font-semibold">{aov != null ? formatCurrency(aov) : detail ? "—" : "…"}</p>
        </div>
        <div>
          <p className="text-xs text-muted-foreground">Rating</p>
          <p className="font-semibold flex items-center gap-1">
            {rating != null ? `${rating.toFixed(1)} ★` : detail ? "—" : "…"}
            {rating != null && rating >= 4.5 && <Badge className="bg-green-100 text-green-700 border-0 text-[9px]">Excellent</Badge>}
          </p>
        </div>
      </div>

      {sparkData.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground flex items-center gap-1"><TrendingUp size={10} /> Weekly Orders</p>
          <ResponsiveContainer width="100%" height={60}>
            <AreaChart data={sparkData} margin={{ top: 2, right: 4, left: 0, bottom: 2 }}>
              <defs>
                <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#0d9488" stopOpacity={0.25} />
                  <stop offset="95%" stopColor="#0d9488" stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="week" tick={{ fontSize: 8 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
              <RechartsTooltip contentStyle={{ fontSize: 10 }} formatter={(v: number) => [v.toLocaleString(), "Orders"]} />
              <Area type="monotone" dataKey="orders" stroke="#0d9488" strokeWidth={1.5} fill={`url(#${gradId})`} dot={false} activeDot={{ r: 2 }} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      {topItem && (
        <div className="pt-1 border-t border-border">
          <p className="text-xs text-muted-foreground">Top Item</p>
          <p className="text-xs font-medium mt-0.5 truncate">
            #{topItem.rank ?? 1} {topItem.item_name}
            {topItem.quantity != null ? <span className="text-muted-foreground"> · {topItem.quantity} sold</span> : ""}
          </p>
        </div>
      )}
    </div>
  );
}

// ─── Marketplace Performance card (for Analytics tab) ─────────────────────────
// Shows one mini-card per marketplace/location combo (most recent report per
// combo). Gracefully collapses to a single card when only one combo exists.

export function MarketplacePerformanceCard({
  brandId,
  onViewAll,
}: {
  brandId: number;
  onViewAll: () => void;
}) {
  const { data: reportsData, isLoading } = useListBrandMarketplaceReports(brandId, {});
  const reports: MarketplaceReport[] = reportsData?.reports ?? [];

  // Group by marketplace + location, keep the most recent report per combo
  // (API returns reports sorted newest-first)
  const comboMap = new Map<string, MarketplaceReport>();
  for (const r of reports) {
    const key = `${r.marketplace}__${r.location_id ?? ""}`;
    if (!comboMap.has(key)) comboMap.set(key, r);
  }
  const combos = Array.from(comboMap.values());

  if (isLoading) {
    return (
      <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
        <h3 className="text-sm font-semibold mb-2 flex items-center gap-1.5">
          <BarChart2 size={14} className="text-muted-foreground" /> Marketplace Performance
        </h3>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground py-2">
          <Loader2 size={12} className="animate-spin" /> Loading…
        </div>
      </div>
    );
  }

  if (combos.length === 0) return null;

  const isMultiple = combos.length > 1;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold flex items-center gap-1.5">
          <BarChart2 size={14} className="text-muted-foreground" />
          Marketplace Performance
          {isMultiple && (
            <Badge className="bg-secondary text-muted-foreground border-0 text-[10px]">
              {combos.length} channels
            </Badge>
          )}
        </h3>
        <button className="text-xs text-teal-600 hover:underline flex items-center gap-0.5" onClick={onViewAll}>
          View all reports <ArrowUpRight size={11} />
        </button>
      </div>
      <div className={isMultiple ? "grid grid-cols-1 sm:grid-cols-2 gap-3" : ""}>
        {combos.map((report) => (
          <MarketplaceComboCard key={`${report.marketplace}-${report.location_id ?? ""}`} report={report} />
        ))}
      </div>
    </div>
  );
}

// ─── Marketplace Metrics section (for Analytics tab) ──────────────────────────

export function MarketplaceMetricsSection({
  brandId,
}: {
  brandId: number;
}) {
  const [expanded, setExpanded] = useState(false);

  const { data: reportsData, isLoading } = useListBrandMarketplaceReports(brandId, {});
  const reports: MarketplaceReport[] = reportsData?.reports ?? [];

  // Group by marketplace + location (newest-first from API, so first seen = most recent)
  const comboMap = new Map<string, { latestReport: MarketplaceReport; count: number }>();
  for (const r of reports) {
    const key = `${r.marketplace}__${r.location_id ?? ""}`;
    const existing = comboMap.get(key);
    if (!existing) {
      comboMap.set(key, { latestReport: r, count: 1 });
    } else {
      existing.count += 1;
    }
  }
  const combos = Array.from(comboMap.values());

  if (!isLoading && reports.length === 0) return null;

  return (
    <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-4 py-3 border-b border-border bg-muted/30 flex items-center justify-between hover:bg-muted/50 transition-colors"
      >
        <div className="flex items-center gap-2">
          <BarChart2 size={14} className="text-muted-foreground" />
          <h3 className="text-sm font-semibold">Marketplace Metrics</h3>
          <Badge className="bg-teal-100 text-teal-700 border-0 text-[10px]">Toters data — not internal Presentail sales</Badge>
        </div>
        {expanded ? <ChevronUp size={14} className="text-muted-foreground" /> : <ChevronDown size={14} className="text-muted-foreground" />}
      </button>

      {expanded && (
        <div className="p-4 space-y-4">
          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-2"><Loader2 size={14} className="animate-spin" /> Loading…</div>
          ) : reports.length === 0 ? (
            <p className="text-sm text-muted-foreground">No approved marketplace reports to show metrics for.</p>
          ) : (
            <>
              <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-800 p-3 text-xs text-amber-800 dark:text-amber-200 flex items-start gap-2">
                <Info size={13} className="shrink-0 mt-0.5 text-amber-600" />
                These metrics come from marketplace platform reports (Toters, etc.) and represent marketplace sales activity — separate from Presentail internal order analytics.
              </div>

              {/* Per-combo summary counters */}
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                <div className="rounded-lg border border-border bg-secondary/30 px-3 py-2.5">
                  <p className="text-xs text-muted-foreground">Total Reports</p>
                  <p className="text-xl font-bold mt-0.5">{reports.length}</p>
                </div>
                {combos.map(({ latestReport, count }) => (
                  <div
                    key={`${latestReport.marketplace}-${latestReport.location_id ?? ""}`}
                    className="rounded-lg border border-border bg-secondary/30 px-3 py-2.5"
                  >
                    <p className="text-xs text-muted-foreground truncate">
                      {latestReport.marketplace}{latestReport.location_name ? ` · ${latestReport.location_name}` : ""}
                    </p>
                    <p className="text-xl font-bold mt-0.5">{count}</p>
                    <p className="text-[10px] text-muted-foreground">
                      {count === 1 ? "report" : "reports"}
                    </p>
                  </div>
                ))}
              </div>

              {/* Full report log */}
              <div className="rounded-lg border border-border overflow-hidden">
                <div className="bg-muted/20 grid grid-cols-[2fr_120px_140px_120px] gap-3 px-4 py-2 text-xs font-medium text-muted-foreground">
                  <span>Report Week</span><span>Marketplace</span><span>Location</span><span>Approved At</span>
                </div>
                <div className="divide-y divide-border max-h-48 overflow-y-auto">
                  {reports.map((r) => (
                    <div key={r.id} className="grid grid-cols-[2fr_120px_140px_120px] gap-3 px-4 py-2 text-xs items-center">
                      <span className="font-medium truncate">{formatWeekRange(r.report_period_start, r.report_period_end)}</span>
                      <span>{r.marketplace}</span>
                      <span className="text-muted-foreground truncate">{r.location_name ?? "All"}</span>
                      <span className="text-muted-foreground">{formatDate(r.created_at)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
