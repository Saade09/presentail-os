import { useState, useMemo, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useParams, Link, useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  Loader2,
  Pencil,
  Trash2,
  ShoppingCart,
  Package,
  FileText,
  Plus,
  X,
  Check,
  List,
  Send,
  CheckCircle2,
  ChevronsUpDown,
  Lock,
  PackageCheck,
  AlertTriangle,
  Download,
  Tag,
  Paperclip,
  ExternalLink,
  Clock,
  RotateCcw,
  Info,
  Search,
  Receipt,
  Link2,
  Copy,
  UserCheck,
  MoreHorizontal,
  UploadCloud,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { cn } from "@/lib/utils";
import { apiFetch, getClerkToken } from "@/lib/queryClient";
import {
  useGetPurchaseOrder,
  useUpdatePurchaseOrder,
  useDeletePurchaseOrder,
  useListSupplierInvoices,
  getListSupplierInvoicesQueryKey,
  useListPurchaseOrderLineItems,
  useCreatePurchaseOrderLineItem,
  useUpdatePurchaseOrderLineItem,
  useDeletePurchaseOrderLineItem,
  useSendPurchaseOrder,
  useAcceptPurchaseOrder,
  useListBaseItems,
  useGetBaseItem,
  getGetBaseItemQueryKey,
  useReceivePurchaseOrder,
  useListPurchaseOrderReceiveHistory,
  getListPurchaseOrderReceiveHistoryQueryKey,
  getGetPurchaseOrderQueryKey,
  getListPurchaseOrdersQueryKey,
  getListPurchaseOrderLineItemsQueryKey,
  useListSupplierCatalogItems,
  useGetPurchaseOrderLineItemStocks,
  getGetPurchaseOrderLineItemStocksQueryKey,
  useListPurchaseOrderActivity,
  getListPurchaseOrderActivityQueryKey,
  useListPurchaseOrderInvoices,
  useLinkPurchaseOrderInvoice,
  useUnlinkPurchaseOrderInvoice,
  getListPurchaseOrderInvoicesQueryKey,
} from "@workspace/api-client-react";
import type { PurchaseOrder, SupplierInvoice, PurchaseOrderLineItem, BaseItemListItem, PurchaseOrderReceiveHistoryItem, SupplierCatalogItem, PurchaseOrderLineItemStockItem, PurchaseOrderActivityItem, PurchaseOrderLinkedInvoice } from "@workspace/api-client-react";
import { computeReviewCostSummary, VAT_TREATMENT_LABELS } from "@/components/CreatePoWizard";
import { AddInvoiceDialog } from "@/components/AddInvoiceDialog";

const PO_STATUS_MAP: Record<string, { label: string; className: string }> = {
  created:           { label: "Created",             className: "bg-gray-100 text-gray-700" },
  sent:              { label: "Sent to Supplier",    className: "bg-blue-100 text-blue-700" },
  supplier_accepted: { label: "Supplier Accepted",   className: "bg-teal-100 text-teal-700" },
  partial:           { label: "Partially Received",  className: "bg-yellow-100 text-yellow-700" },
  received:          { label: "Received",            className: "bg-green-100 text-green-700" },
  completed:         { label: "Completed",           className: "bg-emerald-100 text-emerald-700" },
  cancelled:         { label: "Cancelled",           className: "bg-gray-100 text-gray-500 line-through" },
  // Legacy DB values that may still exist — mapped gracefully
  draft:             { label: "Draft",               className: "bg-gray-100 text-gray-700" },
  pending_approval:  { label: "Created",             className: "bg-gray-100 text-gray-700" },
  approved:          { label: "Created",             className: "bg-gray-100 text-gray-700" },
  confirmed:         { label: "Confirmed",           className: "bg-purple-100 text-purple-700" },
};

const PO_STATUSES = ["created", "sent", "supplier_accepted", "partial", "received", "completed", "cancelled"];
const PO_CURRENCIES = ["AED", "USD", "EUR", "GBP", "SAR", "LBP"];

function PoStatusBadge({ status }: { status: string }) {
  const s = PO_STATUS_MAP[status] ?? { label: status, className: "bg-gray-100 text-gray-600" };
  return (
    <span className={cn("inline-block rounded px-1.5 py-0.5 text-xs font-medium", s.className)}>
      {s.label}
    </span>
  );
}

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function fmtAmt(val: string | null | undefined, decimals = 2): string {
  if (val == null) return "—";
  const n = parseFloat(val);
  if (isNaN(n)) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

const LIFECYCLE_STAGES = [
  { key: "created",           label: "po.lifecycle.created",       Icon: ShoppingCart },
  { key: "sent",              label: "po.lifecycle.sent",          Icon: Send },
  { key: "supplier_accepted", label: "po.lifecycle.accepted",      Icon: UserCheck },
  { key: "invoice_linked",    label: "po.lifecycle.invoiceLinked", Icon: Receipt },
  { key: "stock_received",    label: "po.lifecycle.stockReceived", Icon: Package },
  { key: "completed",         label: "po.lifecycle.completed",     Icon: CheckCircle2 },
] as const;

function PoLifecycleTracker({ po }: {
  po: {
    status: string;
    sent_at?: string | null;
    accepted_at?: string | null;
    received_items_count: number;
    invoice_coverage_status?: string | null;
    is_overdue?: boolean;
  }
}) {
  const { t } = useTranslation();

  const completedStatuses = new Set(["supplier_accepted", "partial", "received", "completed"]);
  const receivedStatuses = new Set(["partial", "received", "completed"]);
  const completedFinalStatuses = new Set(["received", "completed"]);

  const stagesDone = {
    created: true,
    sent: !!(po.sent_at || completedStatuses.has(po.status)),
    supplier_accepted: completedStatuses.has(po.status) || po.status === "supplier_accepted",
    invoice_linked: po.invoice_coverage_status === "fully_invoiced" || po.invoice_coverage_status === "matched",
    stock_received: po.received_items_count > 0 || receivedStatuses.has(po.status),
    completed: completedFinalStatuses.has(po.status),
  };

  const currentStageIndex = (() => {
    if (stagesDone.completed) return 5;
    if (stagesDone.stock_received) return 4;
    if (stagesDone.invoice_linked) return 3;
    if (stagesDone.supplier_accepted) return 2;
    if (stagesDone.sent) return 1;
    return 0;
  })();

  return (
    <div className="bg-white border border-border rounded-xl p-4 shadow-none">
      <div className="flex items-center gap-0">
        {LIFECYCLE_STAGES.map((stage, idx) => {
          const done = stagesDone[stage.key];
          const isActive = idx === currentStageIndex;
          const isLast = idx === LIFECYCLE_STAGES.length - 1;
          const { Icon } = stage;
          const overdueActive = isActive && po.is_overdue;
          return (
            <div key={stage.key} className="flex items-center flex-1 min-w-0">
              <div className="flex flex-col items-center gap-1 flex-shrink-0">
                <div className={cn(
                  "h-7 w-7 rounded-full border-2 flex items-center justify-center transition-colors",
                  done
                    ? "border-teal-500 bg-teal-500"
                    : overdueActive
                    ? "border-red-400 bg-red-50"
                    : isActive
                    ? "border-teal-400 bg-white"
                    : "border-gray-200 bg-white",
                )}>
                  {done
                    ? <Icon size={13} className="text-white" />
                    : overdueActive
                    ? <Icon size={13} className="text-red-500" />
                    : isActive
                    ? <Icon size={13} className="text-teal-500" />
                    : <Icon size={13} className="text-gray-300" />}
                </div>
                <span className={cn(
                  "text-[10px] font-medium text-center leading-tight whitespace-nowrap",
                  done ? "text-teal-600" : overdueActive ? "text-red-500" : isActive ? "text-gray-700" : "text-gray-400",
                )}>
                  {t(stage.label, stage.key)}
                </span>
              </div>
              {!isLast && (
                <div className={cn(
                  "h-0.5 flex-1 mx-1 rounded-full transition-colors",
                  done ? "bg-teal-400" : "bg-gray-200",
                )} />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

type EditFormState = {
  po_number: string;
  status: string;
  currency: string;
  total_amount: string;
  total_amount_manual_override: boolean;
  expected_delivery_date: string;
  notes: string;
  location_id: number | null;
  discount_amount: string;
  delivery_fee_amount: string;
  vat_treatment: string;
  vat_rate: string;
};

function parseAttachments(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((a: unknown) => {
        if (typeof a === "string") return a;
        if (typeof a === "object" && a !== null && typeof (a as Record<string, unknown>).url === "string")
          return (a as Record<string, unknown>).url as string;
        return null;
      })
      .filter((u): u is string => u !== null);
  } catch {
    return [];
  }
}

function attachmentLabel(url: string, nameMap: Map<string, string>): string {
  const mapped = nameMap.get(url);
  if (mapped) return mapped;
  const last = url.split("/").pop() ?? url;
  return last.length > 36 ? last.slice(0, 33) + "…" : last;
}

function attachmentDisplayUrl(objectPath: string): string {
  if (objectPath.startsWith("/objects/")) return `/api/storage${objectPath}`;
  if (objectPath.startsWith("http")) return objectPath;
  return `/api/storage${objectPath}`;
}

function poToForm(po: PurchaseOrder): EditFormState {
  return {
    po_number: po.po_number ?? "",
    status: po.status,
    currency: po.currency,
    total_amount: po.total_amount ?? "",
    total_amount_manual_override: po.total_amount_manual_override ?? false,
    expected_delivery_date: po.expected_delivery_date ? po.expected_delivery_date.slice(0, 10) : "",
    notes: po.notes ?? "",
    location_id: po.location_id ?? null,
    discount_amount: po.discount_amount && parseFloat(po.discount_amount) !== 0 ? po.discount_amount : "",
    delivery_fee_amount: po.delivery_fee_amount && parseFloat(po.delivery_fee_amount) !== 0 ? po.delivery_fee_amount : "",
    vat_treatment: po.vat_treatment ?? "no_vat",
    vat_rate: po.vat_rate ?? "",
  };
}

function LocationComboboxDetail({
  value,
  onChange,
  disabled,
}: {
  value: number | null;
  onChange: (id: number | null) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { data } = useQuery({
    queryKey: ["/api/locations"],
    queryFn: () => apiFetch<{ locations: LocationOption[] }>("/api/locations"),
  });
  const locations: LocationOption[] = data?.locations ?? [];
  const selected = value != null ? locations.find((l) => l.id === value) ?? null : null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between font-normal h-9 px-3 text-sm"
          disabled={disabled}
        >
          <span className={value != null ? "text-foreground" : "text-muted-foreground"}>
            {selected ? selected.name : (value != null ? `Location #${value}` : "Select location…")}
          </span>
          <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search locations…" />
          <CommandList>
            <CommandEmpty>No locations found.</CommandEmpty>
            <CommandGroup>
              {value != null && (
                <CommandItem value="" onSelect={() => { onChange(null); setOpen(false); }} className="text-muted-foreground text-xs">
                  — Clear —
                </CommandItem>
              )}
              {locations.map((l) => (
                <CommandItem key={l.id} value={l.name} onSelect={() => { onChange(l.id); setOpen(false); }}>
                  <Check size={14} className={cn("mr-2 shrink-0", value === l.id ? "opacity-100" : "opacity-0")} />
                  <span className="truncate">{l.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function AttachmentsSection({
  poId,
  attachmentUrls,
  canEdit,
  onUpdated,
}: {
  poId: number;
  attachmentUrls: string | null | undefined;
  canEdit: boolean;
  onUpdated: () => void;
}) {
  const { toast } = useToast();
  const [urls, setUrls] = useState<string[]>(() => parseAttachments(attachmentUrls));
  const [nameMap, setNameMap] = useState<Map<string, string>>(() => new Map());
  const [uploading, setUploading] = useState(false);
  const [savedIndicator, setSavedIndicator] = useState(false);
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingUrlsRef = useRef<string[]>([]);
  const attachmentUrlsRef = useRef(attachmentUrls);
  attachmentUrlsRef.current = attachmentUrls;

  useEffect(() => {
    const serverUrls = parseAttachments(attachmentUrls);
    const stillPending = pendingUrlsRef.current.filter((u) => !serverUrls.includes(u));
    setUrls([...serverUrls, ...stillPending]);
  }, [attachmentUrls]);

  useEffect(() => {
    return () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    };
  }, []);

  const updateMutation = useUpdatePurchaseOrder();

  const handleRemove = useCallback(
    (index: number) => {
      const next = urls.filter((_, i) => i !== index);
      setUrls(next);
      updateMutation.mutate(
        { id: poId, data: { attachment_urls: next.length > 0 ? JSON.stringify(next) : null } },
        {
          onSuccess: () => {
            onUpdated();
            setSavedIndicator(true);
            if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
            savedTimerRef.current = setTimeout(() => setSavedIndicator(false), 2500);
          },
          onError: (err) => {
            toast({
              title: "Failed to update attachments",
              description: err instanceof Error ? err.message : undefined,
              variant: "destructive",
            });
          },
        },
      );
    },
    [urls, poId, onUpdated, toast, updateMutation],
  );

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setUploading(true);
    const snapshotUrls = urls;
    try {
      const res = await apiFetch<{ uploadURL: string; objectPath: string }>(
        "/api/storage/uploads/request-url",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: file.name,
            size: file.size,
            contentType: file.type || "application/pdf",
          }),
        },
      );
      const putRes = await fetch(res.uploadURL, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type || "application/octet-stream" },
      });
      if (!putRes.ok) throw new Error("Upload failed");
      const newPath = res.objectPath;
      const nextUrls = [...snapshotUrls, newPath];
      pendingUrlsRef.current = [...pendingUrlsRef.current, newPath];
      setUrls(nextUrls);
      setNameMap((prev) => new Map(prev).set(newPath, file.name));
      updateMutation.mutate(
        { id: poId, data: { attachment_urls: JSON.stringify(nextUrls) } },
        {
          onSuccess: () => {
            pendingUrlsRef.current = pendingUrlsRef.current.filter((u) => u !== newPath);
            onUpdated();
            setSavedIndicator(true);
            if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
            savedTimerRef.current = setTimeout(() => setSavedIndicator(false), 2500);
          },
          onError: (err) => {
            pendingUrlsRef.current = pendingUrlsRef.current.filter((u) => u !== newPath);
            setUrls(parseAttachments(attachmentUrlsRef.current));
            toast({
              title: "Failed to update attachments",
              description: err instanceof Error ? err.message : undefined,
              variant: "destructive",
            });
          },
        },
      );
    } catch {
      toast({ title: "Failed to upload attachment", variant: "destructive" });
    } finally {
      setUploading(false);
    }
  }

  if (urls.length === 0 && !canEdit) {
    return (
      <div className="text-center py-6 space-y-2">
        <Paperclip size={20} className="mx-auto text-muted-foreground" />
        <p className="text-sm text-muted-foreground">No attachments on this purchase order.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {urls.length > 0 && (
        <div className="rounded-lg border border-border divide-y divide-border">
          {urls.map((url, i) => (
            <div key={url} className="flex items-center gap-2.5 px-3 py-2.5">
              <Paperclip size={14} className="text-muted-foreground shrink-0" />
              <a
                href={attachmentDisplayUrl(url)}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1 min-w-0 text-sm text-primary hover:underline truncate flex items-center gap-1"
              >
                {attachmentLabel(url, nameMap)}
                <ExternalLink size={11} className="shrink-0 opacity-60" />
              </a>
              {canEdit && (
                <button
                  type="button"
                  className="text-muted-foreground hover:text-destructive transition-colors shrink-0"
                  disabled={updateMutation.isPending}
                  onClick={() => handleRemove(i)}
                  title="Remove attachment"
                >
                  <X size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {canEdit && (
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <label
              className={cn(
                "inline-flex items-center gap-1.5 cursor-pointer rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground hover:bg-muted transition-colors",
                (uploading || updateMutation.isPending) && "opacity-50 pointer-events-none",
              )}
            >
              {uploading ? (
                <><Loader2 size={13} className="animate-spin" />Uploading…</>
              ) : (
                <><Paperclip size={13} />Attach file</>
              )}
              <input
                type="file"
                className="hidden"
                accept="image/jpeg,image/png,image/webp,image/gif,application/pdf"
                onChange={handleUpload}
                disabled={uploading || updateMutation.isPending}
              />
            </label>
            {updateMutation.isPending && !uploading && (
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <Loader2 size={11} className="animate-spin" />
                Saving…
              </span>
            )}
            {savedIndicator && !updateMutation.isPending && (
              <span className="inline-flex items-center gap-1 text-xs text-emerald-600 font-medium">
                <Check size={11} />
                Saved
              </span>
            )}
          </div>
          <p className="text-[10px] text-muted-foreground mt-1">PDF, JPG, PNG, WebP, GIF — up to 100 MB</p>
        </div>
      )}
    </div>
  );
}

type ActivityMeta = Record<string, unknown>;

const ACTIVITY_EVENT_CONFIG: Record<string, {
  label: string;
  iconBg: string;
  iconColor: string;
  Icon: React.ElementType;
}> = {
  po_created:                 { label: "PO created",             iconBg: "bg-blue-100",    iconColor: "text-blue-600",    Icon: FileText },
  po_sent:                    { label: "PO sent",                 iconBg: "bg-indigo-100",  iconColor: "text-indigo-600",  Icon: Send },
  po_resent:                  { label: "PO resent to supplier",   iconBg: "bg-indigo-100",  iconColor: "text-indigo-600",  Icon: Send },
  po_supplier_accepted:       { label: "Supplier accepted",       iconBg: "bg-teal-100",    iconColor: "text-teal-600",    Icon: Check },
  po_manually_accepted:       { label: "Manually marked accepted",iconBg: "bg-teal-100",    iconColor: "text-teal-600",    Icon: UserCheck },
  po_approved:                { label: "Supplier accepted",       iconBg: "bg-teal-100",    iconColor: "text-teal-600",    Icon: Check },
  po_received:                { label: "Stock received",          iconBg: "bg-green-100",   iconColor: "text-green-600",   Icon: PackageCheck },
  po_updated:                 { label: "PO updated",              iconBg: "bg-gray-100",    iconColor: "text-gray-600",    Icon: Pencil },
  po_duplicated:              { label: "PO duplicated",           iconBg: "bg-purple-100",  iconColor: "text-purple-600",  Icon: Copy },
  po_cancelled:               { label: "PO cancelled",            iconBg: "bg-red-100",     iconColor: "text-red-600",     Icon: X },
  po_status_changed:          { label: "Status changed",          iconBg: "bg-amber-100",   iconColor: "text-amber-600",   Icon: RotateCcw },
  supplier_document_attached: { label: "Document attached",       iconBg: "bg-primary/10",  iconColor: "text-primary",     Icon: Paperclip },
  po_line_item_added:         { label: "Line item added",         iconBg: "bg-emerald-100", iconColor: "text-emerald-600", Icon: Package },
  po_line_item_updated:       { label: "Line item updated",       iconBg: "bg-primary/10",  iconColor: "text-primary",     Icon: Package },
  po_line_item_removed:       { label: "Line item removed",       iconBg: "bg-red-100",     iconColor: "text-red-600",     Icon: Package },
};

function getActivityConfig(eventType: string) {
  return ACTIVITY_EVENT_CONFIG[eventType] ?? {
    label: eventType.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    iconBg: "bg-gray-100",
    iconColor: "text-gray-500",
    Icon: Clock,
  };
}

function formatPrice(unitPrice: unknown, currency: unknown): string {
  const price = typeof unitPrice === "string" ? parseFloat(unitPrice) : (unitPrice as number);
  const cur = typeof currency === "string" ? currency : "AED";
  return isNaN(price) ? String(unitPrice) : `${price.toFixed(2)} ${cur}`;
}

function formatActivityTimestamp(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function ActivityEventDetail({ eventType, meta }: { eventType: string; meta: ActivityMeta | null | undefined }) {
  if (eventType === "po_status_changed" && meta) {
    const from = meta.from as string | undefined;
    const to = meta.to as string | undefined;
    if (from && to) {
      return (
        <div className="flex items-center gap-1.5 mt-1 flex-wrap">
          <PoStatusBadge status={from} />
          <span className="text-xs text-muted-foreground">→</span>
          <PoStatusBadge status={to} />
        </div>
      );
    }
  }

  if (eventType === "po_received" && meta) {
    const locationName = meta.location_name as string | undefined;
    const items = meta.items as Array<{ base_item_name?: string; quantity_received?: number }> | undefined;

    return (
      <div className="mt-1 space-y-1">
        {locationName && (
          <p className="text-xs text-muted-foreground">
            Location: <span className="font-medium text-foreground">{locationName}</span>
          </p>
        )}
        {items && items.length > 0 && (
          <div className="rounded border border-border bg-muted/30 divide-y divide-border">
            {items.map((item, i) => (
              <div key={i} className="flex items-center justify-between px-2.5 py-1.5 gap-3">
                <span className="text-xs text-foreground truncate">
                  {item.base_item_name ?? `Item #${i + 1}`}
                </span>
                <span className="text-xs font-semibold text-foreground shrink-0">
                  ×{item.quantity_received ?? 0}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  if (eventType === "po_sent" && meta) {
    const toEmail = meta.to_email as string | undefined;
    if (toEmail) {
      return (
        <p className="text-xs text-muted-foreground mt-0.5">
          Sent to <span className="font-medium text-foreground">{toEmail}</span>
        </p>
      );
    }
  }

  if ((eventType === "po_line_item_added" || eventType === "po_line_item_removed") && meta) {
    return (
      <p className="text-xs text-muted-foreground mt-0.5">
        <span className="font-medium text-foreground">{meta.description as string}</span>
        {" — "}qty: {meta.quantity as number}, unit price: {formatPrice(meta.unit_price, meta.currency)}
      </p>
    );
  }

  if (eventType === "po_line_item_updated" && meta) {
    const before = meta.before as { quantity: number; unit_price: string | number; currency: string } | undefined;
    const after = meta.after as { quantity: number; unit_price: string | number; currency: string } | undefined;
    const qtyChanged = before && after && String(before.quantity) !== String(after.quantity);
    const priceChanged = before && after && String(before.unit_price) !== String(after.unit_price);
    return (
      <div className="mt-1 space-y-0.5">
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{meta.description as string}</span>
        </p>
        {qtyChanged && (
          <p className="text-xs text-muted-foreground">
            Qty:{" "}
            <span className="line-through opacity-60">{before!.quantity}</span>
            {" → "}
            <span className="text-foreground font-medium">{after!.quantity}</span>
          </p>
        )}
        {priceChanged && (
          <p className="text-xs text-muted-foreground">
            Unit price:{" "}
            <span className="line-through opacity-60">{formatPrice(before!.unit_price, before!.currency)}</span>
            {" → "}
            <span className="text-foreground font-medium">{formatPrice(after!.unit_price, after!.currency)}</span>
          </p>
        )}
        {!qtyChanged && !priceChanged && (
          <p className="text-xs text-muted-foreground">No quantity or price changes.</p>
        )}
      </div>
    );
  }

  return null;
}

function ActivitySection({ poId }: { poId: number }) {
  const { data, isLoading } = useListPurchaseOrderActivity(poId, {
    query: { queryKey: getListPurchaseOrderActivityQueryKey(poId) },
  });
  const activity: PurchaseOrderActivityItem[] = data?.activity ?? [];

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
        <Loader2 size={13} className="animate-spin" />
        Loading activity…
      </div>
    );
  }

  if (activity.length === 0) {
    return (
      <div className="text-center py-6 space-y-2">
        <Clock size={20} className="mx-auto text-muted-foreground" />
        <p className="text-sm text-muted-foreground">No activity recorded yet.</p>
        <p className="text-xs text-muted-foreground">
          Activity is logged when documents are attached by supplier emails or other events occur.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-0 divide-y divide-border rounded-lg border border-border overflow-hidden">
      {activity.map((entry) => {
        const meta = entry.metadata as ActivityMeta | null | undefined;
        const config = getActivityConfig(entry.event_type);
        const { Icon, iconBg, iconColor, label } = config;

        const storagePath = meta?.storage_path as string | undefined;
        const fileName = meta?.file_name as string | undefined;
        const supplierName = meta?.supplier_name as string | undefined;
        const hasLink = !!storagePath;
        const displayUrl = storagePath
          ? (storagePath.startsWith("/objects/") ? `/api/storage${storagePath}` : storagePath)
          : null;

        const showDefaultDescription =
          entry.description &&
          entry.event_type !== "po_sent" &&
          entry.event_type !== "po_received" &&
          entry.event_type !== "po_line_item_added" &&
          entry.event_type !== "po_line_item_updated" &&
          entry.event_type !== "po_line_item_removed";

        return (
          <div key={entry.id} className="flex items-start gap-3 px-4 py-3 hover:bg-muted/30 transition-colors">
            <div className={`mt-0.5 h-7 w-7 rounded-full ${iconBg} flex items-center justify-center shrink-0`}>
              <Icon size={13} className={iconColor} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs font-semibold text-foreground">{label}</span>
                {supplierName && (
                  <span className="text-xs text-muted-foreground">from {supplierName}</span>
                )}
                {entry.actor_name && (
                  <span className="text-xs text-muted-foreground">by {entry.actor_name}</span>
                )}
              </div>
              <ActivityEventDetail eventType={entry.event_type} meta={meta} />
              {showDefaultDescription && (
                <p className="text-xs text-muted-foreground mt-0.5">{entry.description}</p>
              )}

              {hasLink && displayUrl && (
                <a
                  href={displayUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 mt-1 text-xs text-primary hover:underline"
                >
                  <Paperclip size={11} className="shrink-0" />
                  {fileName ?? "View document"}
                  <ExternalLink size={10} className="shrink-0 opacity-60" />
                </a>
              )}
            </div>
            <span className="text-[11px] text-muted-foreground shrink-0 mt-0.5 whitespace-nowrap">
              {formatActivityTimestamp(entry.created_at)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function RecentActivityPreview({ poId }: { poId: number }) {
  const { data, isLoading } = useListPurchaseOrderActivity(poId, {
    query: { queryKey: getListPurchaseOrderActivityQueryKey(poId) },
  });
  const activity: PurchaseOrderActivityItem[] = (data?.activity ?? []).slice(0, 3);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
        <Loader2 size={13} className="animate-spin" />
        Loading…
      </div>
    );
  }

  if (activity.length === 0) {
    return (
      <div className="text-center py-4 space-y-1">
        <Clock size={16} className="mx-auto text-muted-foreground" />
        <p className="text-xs text-muted-foreground">No activity yet.</p>
      </div>
    );
  }

  return (
    <div className="space-y-0 divide-y divide-border rounded-lg border border-border overflow-hidden">
      {activity.map((entry) => {
        const config = getActivityConfig(entry.event_type);
        const { Icon, iconBg, iconColor, label } = config;
        return (
          <div key={entry.id} className="flex items-center gap-2.5 px-3 py-2.5">
            <div className={`h-6 w-6 rounded-full ${iconBg} flex items-center justify-center shrink-0`}>
              <Icon size={11} className={iconColor} />
            </div>
            <div className="flex-1 min-w-0">
              <span className="text-xs font-medium text-foreground">{label}</span>
              {entry.actor_name && (
                <span className="text-xs text-muted-foreground"> · {entry.actor_name}</span>
              )}
            </div>
            <span className="text-[10px] text-muted-foreground shrink-0 whitespace-nowrap">
              {formatActivityTimestamp(entry.created_at)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

const INVOICE_COVERAGE_MAP: Record<string, { label: string; className: string }> = {
  awaiting_invoice:   { label: "Awaiting invoice",   className: "bg-gray-100 text-gray-600" },
  partially_invoiced: { label: "Partially invoiced", className: "bg-yellow-100 text-yellow-700" },
  fully_invoiced:     { label: "Fully invoiced",     className: "bg-teal-100 text-teal-700" },
  matched:            { label: "Matched ✓",          className: "bg-green-100 text-green-700" },
  difference_found:   { label: "Difference found",   className: "bg-red-100 text-red-700" },
};

function InvoiceCoverageBadge({ status }: { status: string | null | undefined }) {
  if (!status) return null;
  const s = INVOICE_COVERAGE_MAP[status] ?? { label: status, className: "bg-gray-100 text-gray-600" };
  return (
    <span className={cn("inline-block rounded px-1.5 py-0.5 text-xs font-medium", s.className)}>
      {s.label}
    </span>
  );
}

function LinkedInvoicesSection({
  purchaseOrderId,
  supplierId,
  canEdit,
}: {
  purchaseOrderId: number;
  supplierId: number | null | undefined;
  canEdit: boolean;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [linkDrawerOpen, setLinkDrawerOpen] = useState(false);
  const [unlinkingId, setUnlinkingId] = useState<number | null>(null);
  const [linkNotes, setLinkNotes] = useState("");
  const [selectedInvoiceId, setSelectedInvoiceId] = useState<number | null>(null);
  const [invoiceSearch, setInvoiceSearch] = useState("");
  const [invoiceDialogOpen, setInvoiceDialogOpen] = useState(false);
  const [invoiceDialogFile, setInvoiceDialogFile] = useState<File | null>(null);
  const [invoiceDialogStep, setInvoiceDialogStep] = useState<"upload" | "manual">("upload");
  const [isDroppingFile, setIsDroppingFile] = useState(false);
  const dropFileInputRef = useRef<HTMLInputElement>(null);

  const { data, isLoading } = useListPurchaseOrderInvoices(purchaseOrderId);
  const linkedInvoices: PurchaseOrderLinkedInvoice[] = data?.linked_invoices ?? [];

  const { data: supplierInvoicesData } = useListSupplierInvoices(supplierId ?? 0, {
    query: { queryKey: getListSupplierInvoicesQueryKey(supplierId ?? 0), enabled: linkDrawerOpen && !!supplierId },
  });
  const allInvoices = supplierInvoicesData?.invoices ?? [];
  const linkedIds = new Set(linkedInvoices.map((li) => li.supplier_invoice_id));
  const availableInvoices = allInvoices.filter((inv) => !linkedIds.has(inv.id));
  const filteredAvailableInvoices = availableInvoices.filter((inv) => {
    if (!invoiceSearch) return true;
    const s = invoiceSearch.toLowerCase();
    return (inv.invoice_number ?? "").toLowerCase().includes(s) || inv.amount.includes(s);
  });

  const linkMutation = useLinkPurchaseOrderInvoice({
    mutation: {
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: getListPurchaseOrderInvoicesQueryKey(purchaseOrderId) });
        void qc.invalidateQueries({ queryKey: getGetPurchaseOrderQueryKey(purchaseOrderId) });
        setLinkDrawerOpen(false);
        setSelectedInvoiceId(null);
        setLinkNotes("");
        toast({ title: t("po.linkSuccess") });
      },
      onError: (err) => {
        toast({ title: t("po.linkError"), description: err instanceof Error ? err.message : undefined, variant: "destructive" });
      },
    },
  });

  const unlinkMutation = useUnlinkPurchaseOrderInvoice({
    mutation: {
      onSuccess: () => {
        void qc.invalidateQueries({ queryKey: getListPurchaseOrderInvoicesQueryKey(purchaseOrderId) });
        void qc.invalidateQueries({ queryKey: getGetPurchaseOrderQueryKey(purchaseOrderId) });
        setUnlinkingId(null);
        toast({ title: t("po.unlinkSuccess") });
      },
      onError: () => {
        setUnlinkingId(null);
        toast({ title: t("po.unlinkError"), variant: "destructive" });
      },
    },
  });

  function handleLink() {
    if (!selectedInvoiceId) return;
    linkMutation.mutate({ id: purchaseOrderId, data: { supplier_invoice_id: selectedInvoiceId, notes: linkNotes.trim() || null } });
  }

  function handleUnlink(invoiceId: number) {
    setUnlinkingId(invoiceId);
    unlinkMutation.mutate({ id: purchaseOrderId, invoiceId });
  }

  function openUploadDialog(file: File) {
    setInvoiceDialogFile(file);
    setInvoiceDialogStep("upload");
    setInvoiceDialogOpen(true);
  }

  function openManualDialog() {
    setInvoiceDialogFile(null);
    setInvoiceDialogStep("manual");
    setInvoiceDialogOpen(true);
  }

  function handleDropZoneDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDroppingFile(false);
    const files = e.dataTransfer.files;
    if (files && files.length > 0) openUploadDialog(files[0]);
  }

  function handleBrowseChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (files && files.length > 0) openUploadDialog(files[0]);
    e.target.value = "";
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
        <Loader2 size={13} className="animate-spin" />
        Loading linked invoices…
      </div>
    );
  }

  return (
    <>
      <div className="space-y-3">
        {linkedInvoices.length === 0 ? (
          canEdit && supplierId ? (
            <div className="space-y-3">
              <div
                className={cn(
                  "rounded-xl border-2 border-dashed cursor-pointer transition-colors",
                  isDroppingFile
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-primary/40",
                )}
                onDragOver={(e) => { e.preventDefault(); setIsDroppingFile(true); }}
                onDragLeave={() => setIsDroppingFile(false)}
                onDrop={handleDropZoneDrop}
                onClick={() => dropFileInputRef.current?.click()}
              >
                <div className="flex flex-col items-center py-7 gap-2.5">
                  <div className="h-10 w-10 rounded-full bg-muted flex items-center justify-center">
                    <UploadCloud size={18} className="text-muted-foreground" />
                  </div>
                  <p className="text-sm font-medium text-foreground">
                    Drop invoice here or browse
                  </p>
                </div>
              </div>
              <input
                ref={dropFileInputRef}
                type="file"
                accept=".pdf,.jpg,.jpeg,.png"
                className="hidden"
                onChange={handleBrowseChange}
              />
              <p className="text-xs text-center text-muted-foreground leading-relaxed">
                AI will extract supplier name, invoice number, date, VAT, currency, total, and line items
              </p>
              <Button
                className="w-full"
                size="sm"
                onClick={() => dropFileInputRef.current?.click()}
              >
                <UploadCloud size={14} className="me-1.5" />
                Upload Invoice
              </Button>
              <div className="flex items-center justify-center gap-3">
                <button
                  type="button"
                  className="text-xs text-primary underline-offset-4 hover:underline"
                  onClick={openManualDialog}
                >
                  Enter manually
                </button>
                <span className="text-muted-foreground/50 text-xs select-none">|</span>
                <button
                  type="button"
                  className="text-xs text-primary underline-offset-4 hover:underline"
                  onClick={() => setLinkDrawerOpen(true)}
                >
                  Choose existing invoice
                </button>
              </div>
            </div>
          ) : (
            <div className="text-center py-6 space-y-2">
              <Receipt size={20} className="mx-auto text-muted-foreground" />
              <p className="text-sm text-muted-foreground">{t("po.noLinkedInvoices")}</p>
              <p className="text-xs text-muted-foreground">{t("po.noLinkedInvoicesHint")}</p>
            </div>
          )
        ) : (
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground whitespace-nowrap">{t("po.invoiceRef")}</th>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground whitespace-nowrap">Date</th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground whitespace-nowrap">Amount</th>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground whitespace-nowrap">{t("po.invoicePaymentStatus")}</th>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground whitespace-nowrap">{t("po.invoiceDueDate")}</th>
                  {canEdit && <th className="px-2 py-2" />}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {linkedInvoices.map((inv) => (
                  <tr key={inv.poi_id} className="hover:bg-muted/30 transition-colors">
                    <td className="px-3 py-2 font-mono text-xs">
                      {inv.invoice_number || `INV-${String(inv.supplier_invoice_id).padStart(4, "0")}`}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground text-xs">
                      {formatDate(inv.issued_at)}
                    </td>
                    <td className="px-3 py-2 text-right font-medium whitespace-nowrap">
                      {inv.currency} {parseFloat(inv.grand_total ?? inv.amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </td>
                    <td className="px-3 py-2">
                      <span className={cn("inline-block rounded px-1.5 py-0.5 text-xs font-medium",
                        inv.payment_status === "paid" ? "bg-green-100 text-green-700" :
                        inv.payment_status === "overdue" ? "bg-red-100 text-red-700" :
                        inv.payment_status === "partially_paid" ? "bg-yellow-100 text-yellow-700" :
                        "bg-gray-100 text-gray-600"
                      )}>
                        {inv.payment_status === "paid" ? t("po.paymentStatusPaid") :
                         inv.payment_status === "overdue" ? t("po.paymentStatusOverdue") :
                         inv.payment_status === "partially_paid" ? t("po.paymentStatusPartiallyPaid") :
                         t("po.paymentStatusUnpaid")}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground text-xs">
                      {inv.due_date ? formatDate(inv.due_date) : "—"}
                    </td>
                    {canEdit && (
                      <td className="px-2 py-2 text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-xs text-muted-foreground hover:text-red-600"
                          disabled={unlinkingId === inv.supplier_invoice_id || unlinkMutation.isPending}
                          onClick={() => handleUnlink(inv.supplier_invoice_id)}
                        >
                          {unlinkingId === inv.supplier_invoice_id
                            ? <Loader2 size={11} className="animate-spin" />
                            : t("po.unlinkInvoice")}
                        </Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {canEdit && supplierId && linkedInvoices.length > 0 && (
          <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setLinkDrawerOpen(true)}>
            <Plus size={12} className="me-1.5" />
            {t("po.linkInvoice")}
          </Button>
        )}
      </div>

      {canEdit && supplierId && (
        <AddInvoiceDialog
          open={invoiceDialogOpen}
          onOpenChange={setInvoiceDialogOpen}
          supplierId={supplierId}
          initialFile={invoiceDialogFile}
          initialStep={invoiceDialogStep}
          defaultReferenceType="purchase_order"
          defaultReferenceId={purchaseOrderId}
        />
      )}

      <Sheet open={linkDrawerOpen} onOpenChange={setLinkDrawerOpen}>
        <SheetContent className="sm:max-w-md">
          <SheetHeader>
            <SheetTitle>{t("po.linkInvoiceDrawerTitle")}</SheetTitle>
            <SheetDescription>{t("po.linkInvoiceDrawerDesc")}</SheetDescription>
          </SheetHeader>
          <div className="mt-4 space-y-4">
            <div className="relative">
              <Search size={13} className="absolute start-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
              <Input
                className="ps-8 h-8 text-sm"
                placeholder={t("po.searchInvoices")}
                value={invoiceSearch}
                onChange={(e) => setInvoiceSearch(e.target.value)}
              />
            </div>
            <div className="max-h-72 overflow-y-auto rounded border border-border divide-y divide-border">
              {filteredAvailableInvoices.length === 0 ? (
                <div className="px-3 py-6 text-center text-sm text-muted-foreground">{t("po.noInvoicesFound")}</div>
              ) : (
                filteredAvailableInvoices.map((inv) => (
                  <button
                    key={inv.id}
                    type="button"
                    className={cn(
                      "w-full text-left px-3 py-2.5 text-sm hover:bg-muted/50 transition-colors flex items-center justify-between gap-2",
                      selectedInvoiceId === inv.id && "bg-teal-50 border-s-2 border-teal-500"
                    )}
                    onClick={() => setSelectedInvoiceId(selectedInvoiceId === inv.id ? null : inv.id)}
                  >
                    <div>
                      <span className="font-mono text-xs font-medium">
                        {inv.invoice_number || `INV-${String(inv.id).padStart(4, "0")}`}
                      </span>
                      <span className="text-muted-foreground text-xs ms-2">{formatDate(inv.issued_at)}</span>
                    </div>
                    <span className="text-xs font-medium whitespace-nowrap">
                      {inv.currency} {parseFloat(inv.amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  </button>
                ))
              )}
            </div>
            <div>
              <Label className="text-xs mb-1.5 block">{t("po.linkNotesLabel")}</Label>
              <Input
                className="h-8 text-sm"
                placeholder="e.g. Partial delivery invoice"
                value={linkNotes}
                onChange={(e) => setLinkNotes(e.target.value)}
              />
            </div>
          </div>
          <SheetFooter className="mt-6">
            <Button
              size="sm"
              disabled={!selectedInvoiceId || linkMutation.isPending}
              onClick={handleLink}
            >
              {linkMutation.isPending && <Loader2 size={13} className="me-1.5 animate-spin" />}
              {t("po.linkInvoice")}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </>
  );
}

type NewLineItemDraft = {
  description: string;
  description_ar: string;
  quantity: string;
  unit_price: string;
  currency: string;
  received_quantity: string;
  base_item_id: number | null;
  supplier_catalog_item_id: number | null;
  base_item_supplier_id: number | null;
  vat_treatment: string;
};

type EditLineItemDraft = NewLineItemDraft & {
  id: number;
  supplier_item_code?: string | null;
  supplier_item_unit?: string | null;
  applied_tax_rate: string;
  tax_amount: string;
  tax_override: boolean;
  tax_category: string | null;
};

/** Item returned by GET /api/suppliers/:id/linked-base-items */
type LinkedBaseItem = {
  base_item_supplier_id: number;
  base_item_id: number;
  base_item_name: string;
  base_item_code: string | null;
  image_url: string | null;
  supplier_item_name: string | null;
  supplier_item_code: string | null;
  price: string | null;
  currency: string;
  pricing_uom: string | null;
  is_preferred: boolean;
  name_ar: string | null;
};
function BaseItemCombobox({
  value,
  onChange,
  disabled,
}: {
  value: number | null;
  onChange: (id: number | null, name: string | null) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const { data } = useListBaseItems({ q: search || undefined, limit: 50, status: "active" });
  const items: BaseItemListItem[] = data?.items ?? [];

  const selected = value != null ? items.find((i) => i.id === value) ?? null : null;

  const { data: fetchedItem, isLoading: isFetchingItem } = useGetBaseItem(value ?? 0, {
    query: { queryKey: getGetBaseItemQueryKey(value ?? 0), enabled: value != null && selected == null },
  });
  const resolvedName = selected?.name ?? fetchedItem?.item.name ?? null;
  const isLoadingName = value != null && selected == null && isFetchingItem;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="h-7 w-full justify-between px-2 text-xs font-normal"
          disabled={disabled}
        >
          {isLoadingName ? (
            <span className="flex items-center gap-1 text-muted-foreground">
              <Loader2 size={11} className="animate-spin shrink-0" />
              <span>Loading…</span>
            </span>
          ) : (
            <span className={value != null ? "text-foreground truncate" : "text-muted-foreground"}>
              {resolvedName ?? (value != null ? `Base Item #${value}` : "Link base item…")}
            </span>
          )}
          <ChevronsUpDown size={11} className="ml-1 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search base items…"
            value={search}
            onValueChange={setSearch}
          />
          <CommandList className="max-h-52">
            <CommandEmpty>No base items found.</CommandEmpty>
            <CommandGroup>
              {value != null && (
                <CommandItem
                  value=""
                  onSelect={() => { onChange(null, null); setOpen(false); setSearch(""); }}
                  className="text-muted-foreground text-xs"
                >
                  — Clear —
                </CommandItem>
              )}
              {items.map((item) => (
                <CommandItem
                  key={item.id}
                  value={String(item.id)}
                  onSelect={() => { onChange(item.id, item.name); setOpen(false); setSearch(""); }}
                  className="text-xs"
                >
                  <Check size={12} className={cn("mr-1.5 shrink-0", value === item.id ? "opacity-100" : "opacity-0")} />
                  <span className="truncate">{item.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function CatalogItemCombobox({
  supplierId,
  value,
  onChange,
  disabled,
}: {
  supplierId: number;
  /** base_item_supplier_id of the currently selected item, or null */
  value: number | null;
  onChange: (item: LinkedBaseItem | null) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const { data, isLoading } = useQuery<{ items: LinkedBaseItem[] }>({
    queryKey: ["linked-base-items", supplierId, search],
    queryFn: () => apiFetch(`/api/suppliers/${supplierId}/linked-base-items?q=${encodeURIComponent(search)}&limit=50`),
    enabled: supplierId > 0,
    staleTime: 30_000,
  });
  const items: LinkedBaseItem[] = data?.items ?? [];
  const selected = value != null ? items.find((i) => i.base_item_supplier_id === value) ?? null : null;

  const displayName = selected
    ? (selected.supplier_item_name ?? selected.base_item_name)
    : value != null
    ? `Item #${value}`
    : null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="h-7 w-full justify-between px-2 text-xs font-normal"
          disabled={disabled}
        >
          <span className={displayName != null ? "text-foreground truncate" : "text-muted-foreground"}>
            {displayName ?? "Pick from catalog…"}
          </span>
          <ChevronsUpDown size={11} className="ml-1 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search by name or code…"
            value={search}
            onValueChange={setSearch}
          />
          <CommandList className="max-h-52">
            {isLoading ? (
              <div className="flex items-center justify-center py-4">
                <Loader2 size={14} className="animate-spin text-muted-foreground" />
              </div>
            ) : (
              <CommandEmpty>No linked base items found.</CommandEmpty>
            )}
            <CommandGroup>
              {value != null && (
                <CommandItem
                  value=""
                  onSelect={() => { onChange(null); setOpen(false); setSearch(""); }}
                  className="text-muted-foreground text-xs"
                >
                  — Clear —
                </CommandItem>
              )}
              {items.map((item) => (
                <CommandItem
                  key={item.base_item_supplier_id}
                  value={String(item.base_item_supplier_id)}
                  onSelect={() => { onChange(item); setOpen(false); setSearch(""); }}
                  className="text-xs"
                >
                  <Check size={12} className={cn("mr-1.5 shrink-0", value === item.base_item_supplier_id ? "opacity-100" : "opacity-0")} />
                  <div className="flex flex-col min-w-0">
                    <span className="truncate">{item.supplier_item_name ?? item.base_item_name}</span>
                    <span className="text-muted-foreground truncate">
                      {item.supplier_item_code && <span className="font-mono">{item.supplier_item_code} </span>}
                      {item.price && <span>{item.currency} {parseFloat(item.price).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>}
                      {item.pricing_uom && <span> / {item.pricing_uom}</span>}
                    </span>
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function LineItemsSection({
  poId,
  supplierId,
  poCurrency,
  canEdit,
  lockedTotal,
  isManualOverride,
  isEditing,
  bulkEdits,
  onBulkEdit,
  bulkSaving,
}: {
  poId: number;
  supplierId: number;
  poCurrency: string;
  canEdit: boolean;
  lockedTotal: string | null | undefined;
  isManualOverride: boolean;
  isEditing: boolean;
  bulkEdits: Record<number, { quantity: string; unit_price: string }>;
  onBulkEdit: (id: number, field: "quantity" | "unit_price", value: string) => void;
  bulkSaving: boolean;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data, isLoading } = useListPurchaseOrderLineItems(poId);
  const lineItems: PurchaseOrderLineItem[] = data?.line_items ?? [];
  const calculatedTotal = data?.calculated_total ?? null;

  const totalTaxAmount = lineItems.reduce((sum, li) => {
    const t = li.tax_amount != null ? parseFloat(li.tax_amount as string) : 0;
    return sum + (isNaN(t) ? 0 : t);
  }, 0);
  const hasTax = lineItems.some(
    (li) =>
      (li.tax_amount != null && parseFloat(li.tax_amount as string) > 0) ||
      (li.tax_category != null && li.tax_category !== "not_classified"),
  );
  const grossTotal = hasTax && calculatedTotal
    ? (parseFloat(calculatedTotal) + totalTaxAmount).toFixed(2)
    : null;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: getListPurchaseOrderLineItemsQueryKey(poId) });
    qc.invalidateQueries({ queryKey: getGetPurchaseOrderQueryKey(poId) });
    qc.invalidateQueries({ queryKey: getListPurchaseOrdersQueryKey() });
  };

  const createMutation = useCreatePurchaseOrderLineItem({
    mutation: {
      onSuccess: () => { invalidate(); setAdding(false); setDraft(emptyDraft(poCurrency)); },
      onError: (err) => toast({ title: "Failed to add line item", description: err instanceof Error ? err.message : undefined, variant: "destructive" }),
    },
  });

  const updateMutation = useUpdatePurchaseOrderLineItem({
    mutation: {
      onSuccess: () => { invalidate(); setEditing(null); },
      onError: (err) => toast({ title: "Failed to update line item", description: err instanceof Error ? err.message : undefined, variant: "destructive" }),
    },
  });

  const deleteMutation = useDeletePurchaseOrderLineItem({
    mutation: {
      onSuccess: () => { invalidate(); setDeleteId(null); },
      onError: (err) => toast({ title: "Failed to delete line item", description: err instanceof Error ? err.message : undefined, variant: "destructive" }),
    },
  });

  function emptyDraft(currency: string): NewLineItemDraft {
    return { description: "", description_ar: "", quantity: "1", unit_price: "0", currency, received_quantity: "", base_item_id: null, supplier_catalog_item_id: null, base_item_supplier_id: null, vat_treatment: "" };
  }

  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<NewLineItemDraft>(emptyDraft(poCurrency));
  const [editing, setEditing] = useState<EditLineItemDraft | null>(null);
  const [deleteId, setDeleteId] = useState<number | null>(null);

  function startAdd() {
    setDraft(emptyDraft(poCurrency));
    setAdding(true);
    setEditing(null);
  }

  function startEdit(li: PurchaseOrderLineItem) {
    setEditing({
      id: li.id,
      description: li.description,
      description_ar: li.description_ar ?? "",
      quantity: li.quantity,
      unit_price: li.unit_price,
      currency: li.currency,
      received_quantity: li.received_quantity ?? "",
      base_item_id: li.base_item_id ?? null,
      supplier_catalog_item_id: li.supplier_catalog_item_id ?? null,
      base_item_supplier_id: li.base_item_supplier_id ?? null,
      supplier_item_code: li.supplier_item_code ?? null,
      supplier_item_unit: li.supplier_item_unit ?? null,
      vat_treatment: li.vat_treatment ?? "",
      applied_tax_rate: li.applied_tax_rate ?? "",
      tax_amount: li.tax_amount ?? "",
      tax_override: li.tax_override,
      tax_category: li.tax_category ?? null,
    });
    setAdding(false);
  }

  function handleCreate() {
    // Skip client-side description check when BIS is selected — the server derives
    // the description from supplier_item_name ?? base_item.name automatically.
    if (!draft.description.trim() && draft.base_item_supplier_id == null) { toast({ title: "Description is required", variant: "destructive" }); return; }
    createMutation.mutate({
      id: poId,
      data: {
        base_item_id: draft.base_item_id,
        supplier_catalog_item_id: draft.base_item_supplier_id != null ? null : draft.supplier_catalog_item_id,
        base_item_supplier_id: draft.base_item_supplier_id,
        description: draft.description.trim(),
        description_ar: draft.description_ar.trim() || null,
        quantity: draft.quantity,
        unit_price: draft.unit_price,
        currency: draft.currency || poCurrency,
        received_quantity: draft.received_quantity.trim() || null,
        vat_treatment: draft.vat_treatment || null,
      },
    });
  }

  function handleUpdate() {
    if (!editing) return;
    updateMutation.mutate({
      id: poId,
      lineItemId: editing.id,
      data: {
        base_item_id: editing.base_item_id,
        supplier_catalog_item_id: editing.base_item_supplier_id != null ? null : editing.supplier_catalog_item_id,
        base_item_supplier_id: editing.base_item_supplier_id,
        description: editing.description.trim(),
        description_ar: editing.description_ar.trim() || null,
        quantity: editing.quantity,
        unit_price: editing.unit_price,
        currency: editing.currency,
        received_quantity: editing.received_quantity.trim() || null,
        vat_treatment: editing.vat_treatment || null,
        ...(editing.tax_override && editing.applied_tax_rate.trim()
          ? {
              applied_tax_rate: editing.applied_tax_rate.trim(),
              tax_amount: editing.tax_amount.trim() || undefined,
            }
          : {}),
      },
    });
  }

  function handleReResolveTax() {
    if (!editing) return;
    updateMutation.mutate({
      id: poId,
      lineItemId: editing.id,
      data: {
        base_item_id: editing.base_item_id,
        supplier_catalog_item_id: editing.supplier_catalog_item_id,
        description: editing.description.trim(),
        quantity: editing.quantity,
        unit_price: editing.unit_price,
        currency: editing.currency,
        received_quantity: editing.received_quantity.trim() || null,
        vat_treatment: editing.vat_treatment || null,
        re_resolve_tax: true,
      },
    });
  }

  const TAX_CATEGORY_LABELS: Record<string, string> = {
    standard_taxable: "Standard",
    zero_rated: "Zero-rated",
    exempt: "Exempt",
    non_taxable: "Non-taxable",
    food_grocery: "Food/Grocery",
    packaging: "Packaging",
    service: "Service",
    import_related: "Import",
  };

  function lineTotal(qty: string, price: string): string {
    const q = parseFloat(qty);
    const p = parseFloat(price);
    if (isNaN(q) || isNaN(p)) return "—";
    return (q * p).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
        <Loader2 size={13} className="animate-spin" />
        Loading line items…
      </div>
    );
  }

  const colClass = "px-3 py-2 text-xs";

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="text-left px-3 py-2 font-medium text-muted-foreground text-xs">Description</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground text-xs whitespace-nowrap">Item Code / Unit</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground text-xs whitespace-nowrap">Qty</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground text-xs whitespace-nowrap">Unit Price</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground text-xs whitespace-nowrap">Line Total</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground text-xs whitespace-nowrap">Received</th>
              <th className="text-right px-3 py-2 font-medium text-muted-foreground text-xs whitespace-nowrap">Outstanding</th>
              {canEdit && <th className="px-3 py-2 w-16" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {lineItems.length === 0 && !adding && (
              <tr>
                <td colSpan={canEdit ? 8 : 7} className="px-3 py-6 text-center text-muted-foreground text-sm">
                  No line items yet.{canEdit && " Click \"Add line item\" to get started."}
                </td>
              </tr>
            )}
            {lineItems.map((li) => (
              editing?.id === li.id ? (
                <tr key={li.id} className="bg-muted/20">
                  <td className={colClass}>
                    <div className="flex flex-col gap-1">
                      <CatalogItemCombobox
                        supplierId={supplierId}
                        value={editing.base_item_supplier_id}
                        onChange={(item) =>
                          setEditing((p) => p ? {
                            ...p,
                            base_item_supplier_id: item?.base_item_supplier_id ?? null,
                            supplier_catalog_item_id: null,
                            description: item ? (item.supplier_item_name ?? item.base_item_name) : p.description,
                            description_ar: (!p.description_ar.trim() && item?.name_ar) ? item.name_ar : p.description_ar,
                            unit_price: item?.price ?? p.unit_price,
                            base_item_id: item?.base_item_id ?? p.base_item_id,
                          } : p)
                        }
                        disabled={updateMutation.isPending}
                      />
                      <BaseItemCombobox
                        value={editing.base_item_id}
                        onChange={(id, name) =>
                          setEditing((p) => p ? {
                            ...p,
                            base_item_id: id,
                            description: name ?? p.description,
                          } : p)
                        }
                        disabled={updateMutation.isPending}
                      />
                      <Input
                        className="h-7 text-xs"
                        value={editing.description}
                        onChange={(e) => setEditing((p) => p ? { ...p, description: e.target.value } : p)}
                        disabled={updateMutation.isPending}
                        placeholder="Description"
                      />
                      <Input
                        className="h-7 text-xs text-right"
                        dir="rtl"
                        value={editing.description_ar}
                        onChange={(e) => setEditing((p) => p ? { ...p, description_ar: e.target.value } : p)}
                        disabled={updateMutation.isPending}
                        placeholder="الاسم بالعربية (اختياري)"
                      />
                      <Select
                        value={editing.vat_treatment || "none"}
                        onValueChange={(v) => setEditing((p) => p ? { ...p, vat_treatment: v === "none" ? "" : v } : p)}
                        disabled={updateMutation.isPending}
                      >
                        <SelectTrigger className="h-7 text-xs w-full">
                          <SelectValue placeholder="VAT treatment…" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none" className="text-xs">No override</SelectItem>
                          <SelectItem value="exclusive" className="text-xs">Exclusive (ex-VAT)</SelectItem>
                          <SelectItem value="inclusive" className="text-xs">Inclusive (inc-VAT)</SelectItem>
                          <SelectItem value="no_vat" className="text-xs">No VAT</SelectItem>
                        </SelectContent>
                      </Select>
                      {/* Tax details */}
                      {(editing.applied_tax_rate || editing.tax_category) && (
                        <div className="rounded border border-amber-200 bg-amber-50 p-1.5 space-y-1">
                          {!editing.tax_override && editing.applied_tax_rate && (
                            <p className="text-[10px] text-amber-700">
                              Tax resolved from rule:{" "}
                              <span className="font-medium">
                                {editing.tax_category ? (TAX_CATEGORY_LABELS[editing.tax_category] ?? editing.tax_category) : "—"}
                              </span>{" "}
                              @ <span className="font-medium">{parseFloat(editing.applied_tax_rate).toFixed(2)}%</span>
                            </p>
                          )}
                          {editing.tax_override && (
                            <p className="text-[10px] text-orange-600 font-medium">Manual tax override</p>
                          )}
                          <div className="flex items-center gap-1">
                            <label className="text-[10px] text-muted-foreground w-16 shrink-0">Rate %</label>
                            <Input
                              className="h-6 text-[11px] w-20"
                              type="number"
                              min="0"
                              step="any"
                              placeholder="auto"
                              value={editing.applied_tax_rate}
                              onChange={(e) =>
                                setEditing((p) => p ? {
                                  ...p,
                                  applied_tax_rate: e.target.value,
                                  tax_override: e.target.value.trim() !== "",
                                } : p)
                              }
                              disabled={updateMutation.isPending}
                            />
                          </div>
                          <div className="flex items-center gap-1">
                            <label className="text-[10px] text-muted-foreground w-16 shrink-0">Tax amt</label>
                            <Input
                              className="h-6 text-[11px] w-20"
                              type="number"
                              min="0"
                              step="any"
                              placeholder="auto"
                              value={editing.tax_amount}
                              onChange={(e) =>
                                setEditing((p) => p ? {
                                  ...p,
                                  tax_amount: e.target.value,
                                  tax_override: p.tax_override || e.target.value.trim() !== "",
                                } : p)
                              }
                              disabled={updateMutation.isPending}
                            />
                          </div>
                          {editing.tax_override && (
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="h-6 w-full text-[10px] text-muted-foreground gap-1 px-1"
                              onClick={handleReResolveTax}
                              disabled={updateMutation.isPending}
                            >
                              <RotateCcw size={9} />
                              Re-resolve from rule
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  </td>
                  <td className={cn(colClass, "text-muted-foreground")}>
                    {editing.supplier_catalog_item_id != null ? (
                      <span className="text-xs italic">auto-filled</span>
                    ) : editing.supplier_item_code ? (
                      <span className="text-xs font-mono">{editing.supplier_item_code}</span>
                    ) : <span className="text-xs">—</span>}
                  </td>
                  <td className={colClass}>
                    <Input
                      className="h-7 text-xs w-20 text-right"
                      type="number"
                      min="0"
                      step="any"
                      value={editing.quantity}
                      onChange={(e) => setEditing((p) => p ? { ...p, quantity: e.target.value } : p)}
                      disabled={updateMutation.isPending}
                    />
                  </td>
                  <td className={colClass}>
                    <Input
                      className="h-7 text-xs w-24 text-right"
                      type="number"
                      min="0"
                      step="any"
                      value={editing.unit_price}
                      onChange={(e) => setEditing((p) => p ? { ...p, unit_price: e.target.value } : p)}
                      disabled={updateMutation.isPending}
                    />
                  </td>
                  <td className={cn(colClass, "text-right whitespace-nowrap font-medium")}>
                    {lineTotal(editing.quantity, editing.unit_price)}
                  </td>
                  <td className={colClass}>
                    <Input
                      className="h-7 text-xs w-20 text-right"
                      type="number"
                      min="0"
                      step="any"
                      placeholder="—"
                      value={editing.received_quantity}
                      onChange={(e) => setEditing((p) => p ? { ...p, received_quantity: e.target.value } : p)}
                      disabled={updateMutation.isPending}
                    />
                  </td>
                  <td className={cn(colClass, "text-right text-muted-foreground text-xs")}>
                    {(() => {
                      const qty = parseFloat(editing.quantity);
                      const rec = editing.received_quantity.trim() ? parseFloat(editing.received_quantity) : 0;
                      const outstanding = isNaN(qty) ? null : Math.max(0, qty - (isNaN(rec) ? 0 : rec));
                      if (outstanding === null || outstanding === 0) return <span className="text-green-600 font-medium">✓</span>;
                      return <span className="text-yellow-600 font-medium">{outstanding % 1 === 0 ? outstanding : outstanding.toFixed(2)}</span>;
                    })()}
                  </td>
                  <td className={cn(colClass, "text-right")}>
                    <div className="flex items-center justify-end gap-1">
                      <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-muted-foreground" onClick={() => setEditing(null)} disabled={updateMutation.isPending}>
                        <X size={12} />
                      </Button>
                      <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-primary" onClick={handleUpdate} disabled={updateMutation.isPending}>
                        {updateMutation.isPending ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                      </Button>
                    </div>
                  </td>
                </tr>
              ) : (
                <tr key={li.id} className="hover:bg-muted/30 transition-colors group">
                  <td className={colClass}>
                    <div className="flex flex-col gap-0.5">
                      <div>
                        <span className="font-medium">{li.description}</span>
                        {li.base_item_name && (
                          li.base_item_id ? (
                            <Link href={`/dashboard/base-items/${li.base_item_id}?tab=inventory`} className="ml-1 text-xs text-primary hover:underline">({li.base_item_name})</Link>
                          ) : (
                            <span className="ml-1 text-muted-foreground text-xs">({li.base_item_name})</span>
                          )
                        )}
                        {li.vat_treatment && li.vat_treatment !== "no_vat" && (
                          <span className="ml-1 inline-block rounded px-1 py-0.5 text-[10px] font-medium bg-blue-50 text-blue-600 whitespace-nowrap">
                            {li.vat_treatment === "exclusive" ? "ex-VAT" : li.vat_treatment === "inclusive" ? "inc-VAT" : li.vat_treatment}
                          </span>
                        )}
                      </div>
                      {li.description_ar && (
                        <div dir="rtl" className="text-xs text-muted-foreground text-right">
                          {li.description_ar}
                        </div>
                      )}
                      {(() => {
                        const hasMeaningfulCategory = li.tax_category && li.tax_category !== "not_classified";
                        const categoryLabel = hasMeaningfulCategory ? (TAX_CATEGORY_LABELS[li.tax_category!] ?? li.tax_category) : null;
                        const rateLabel = li.applied_tax_rate != null ? `${parseFloat(li.applied_tax_rate as string).toFixed(2)}%` : null;
                        const parts = [categoryLabel, rateLabel].filter(Boolean).join(" · ");
                        if (!parts) return null;
                        return (
                          <span className="text-[10px] text-muted-foreground leading-tight">
                            {parts}
                          </span>
                        );
                      })()}
                    </div>
                  </td>
                  <td className={colClass}>
                    {(li.supplier_catalog_item_id != null || li.supplier_item_code || li.supplier_item_unit) ? (
                      <div className="flex flex-col gap-0.5">
                        {li.supplier_catalog_item_id != null && (
                          <Link
                            href={`/dashboard/suppliers/${supplierId}/catalog/${li.supplier_catalog_item_id}`}
                            className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-medium bg-violet-50 text-violet-700 hover:bg-violet-100 transition-colors w-fit"
                          >
                            <Tag size={9} />
                            Catalog
                          </Link>
                        )}
                        {li.supplier_item_code && <span className="text-xs font-mono text-foreground">{li.supplier_item_code}</span>}
                        {li.supplier_item_unit && <span className="text-xs text-muted-foreground">{li.supplier_item_unit}</span>}
                      </div>
                    ) : <span className="text-xs text-muted-foreground">—</span>}
                  </td>
                  <td className={cn(colClass, "text-right")}>
                    {isEditing ? (
                      <Input
                        className="h-7 text-xs w-20 text-right ml-auto"
                        type="number"
                        min="0"
                        step="any"
                        value={bulkEdits[li.id]?.quantity ?? li.quantity}
                        onChange={(e) => onBulkEdit(li.id, "quantity", e.target.value)}
                        disabled={bulkSaving}
                      />
                    ) : (
                      fmtAmt(li.quantity, 4).replace(/\.?0+$/, "")
                    )}
                  </td>
                  <td className={cn(colClass, "text-right whitespace-nowrap")}>
                    {isEditing ? (
                      <Input
                        className="h-7 text-xs w-24 text-right ml-auto"
                        type="number"
                        min="0"
                        step="any"
                        value={bulkEdits[li.id]?.unit_price ?? li.unit_price}
                        onChange={(e) => onBulkEdit(li.id, "unit_price", e.target.value)}
                        disabled={bulkSaving}
                      />
                    ) : (
                      <>{li.currency} {fmtAmt(li.unit_price)}</>
                    )}
                  </td>
                  <td className={cn(colClass, "text-right font-medium whitespace-nowrap")}>
                    <div className="flex flex-col items-end gap-0.5">
                      <span>{li.currency} {lineTotal(bulkEdits[li.id]?.quantity ?? li.quantity, bulkEdits[li.id]?.unit_price ?? li.unit_price)}</span>
                      {li.applied_tax_rate != null && (
                        <span className={cn(
                          "inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-medium",
                          li.tax_override
                            ? "bg-orange-100 text-orange-700"
                            : "bg-orange-50 text-orange-600",
                        )}>
                          Tax {parseFloat(li.applied_tax_rate as string).toFixed(2)}%
                          {li.tax_override && <span className="ml-0.5 opacity-70">(manual)</span>}
                        </span>
                      )}
                      {li.tax_amount != null && parseFloat(li.tax_amount as string) !== 0 && (
                        <span className="text-[10px] text-amber-600 font-normal">
                          +tax {li.currency} {parseFloat(li.tax_amount as string).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className={cn(colClass, "text-right")}>
                    {li.received_quantity != null ? (() => {
                      const received = parseFloat(li.received_quantity);
                      const ordered = parseFloat(li.quantity);
                      const pct = ordered > 0 ? Math.min(100, Math.round((received / ordered) * 100)) : 0;
                      const full = received >= ordered;
                      const recStr = fmtAmt(li.received_quantity, 4).replace(/\.?0+$/, "");
                      const ordStr = fmtAmt(li.quantity, 4).replace(/\.?0+$/, "");
                      return (
                        <div className="flex flex-col items-end gap-1">
                          <span className={cn("text-xs font-medium", full ? "text-green-600" : "text-yellow-600")}>
                            {recStr} / {ordStr}
                          </span>
                          <div className="w-16 h-1.5 rounded-full bg-muted overflow-hidden">
                            <div
                              className={cn("h-full rounded-full transition-all", full ? "bg-green-500" : "bg-yellow-400")}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      );
                    })() : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className={cn(colClass, "text-right")}>
                    {(() => {
                      const ordered = parseFloat(li.quantity);
                      const received = li.received_quantity != null ? parseFloat(li.received_quantity) : 0;
                      const outstanding = Math.max(0, ordered - received);
                      if (outstanding === 0) {
                        return <span className="text-green-600 text-xs font-medium">✓ Done</span>;
                      }
                      const outStr = fmtAmt(String(outstanding), 4).replace(/\.?0+$/, "");
                      return (
                        <span className="text-yellow-600 text-xs font-medium whitespace-nowrap">
                          {outStr} outstanding
                        </span>
                      );
                    })()}
                  </td>
                  {canEdit && (
                    <td className={cn(colClass, "text-right")}>
                      <div className={cn(
                        "flex items-center justify-end gap-1 transition-opacity",
                        isEditing ? "opacity-100" : "opacity-0 group-hover:opacity-100",
                      )}>
                        {!isEditing && (
                          <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-muted-foreground" onClick={() => startEdit(li)}>
                            <Pencil size={11} />
                          </Button>
                        )}
                        <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-destructive/70 hover:text-destructive" disabled={bulkSaving} onClick={() => setDeleteId(li.id)}>
                          <Trash2 size={11} />
                        </Button>
                      </div>
                    </td>
                  )}
                </tr>
              )
            ))}

            {adding && (
              <tr className="bg-muted/20">
                <td className={colClass}>
                  <div className="flex flex-col gap-1">
                    <CatalogItemCombobox
                      supplierId={supplierId}
                      value={draft.base_item_supplier_id}
                      onChange={(item) =>
                        setDraft((p) => ({
                          ...p,
                          base_item_supplier_id: item?.base_item_supplier_id ?? null,
                          supplier_catalog_item_id: null,
                          description: item ? (item.supplier_item_name ?? item.base_item_name) : p.description,
                          description_ar: (!p.description_ar.trim() && item?.name_ar) ? item.name_ar : p.description_ar,
                          unit_price: item?.price ?? p.unit_price,
                          base_item_id: item?.base_item_id ?? p.base_item_id,
                        }))
                      }
                      disabled={createMutation.isPending}
                    />
                    <BaseItemCombobox
                      value={draft.base_item_id}
                      onChange={(id, name) =>
                        setDraft((p) => ({
                          ...p,
                          base_item_id: id,
                          description: name ?? p.description,
                        }))
                      }
                      disabled={createMutation.isPending}
                    />
                    <Input
                      className="h-7 text-xs"
                      value={draft.description}
                      onChange={(e) => setDraft((p) => ({ ...p, description: e.target.value }))}
                      disabled={createMutation.isPending}
                      placeholder="Item description"
                      autoFocus
                    />
                    <Input
                      className="h-7 text-xs text-right"
                      dir="rtl"
                      value={draft.description_ar}
                      onChange={(e) => setDraft((p) => ({ ...p, description_ar: e.target.value }))}
                      disabled={createMutation.isPending}
                      placeholder="الاسم بالعربية (اختياري)"
                    />
                    <Select
                      value={draft.vat_treatment || "none"}
                      onValueChange={(v) => setDraft((p) => ({ ...p, vat_treatment: v === "none" ? "" : v }))}
                      disabled={createMutation.isPending}
                    >
                      <SelectTrigger className="h-7 text-xs w-full">
                        <SelectValue placeholder="VAT treatment…" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none" className="text-xs">No override</SelectItem>
                        <SelectItem value="exclusive" className="text-xs">Exclusive (ex-VAT)</SelectItem>
                        <SelectItem value="inclusive" className="text-xs">Inclusive (inc-VAT)</SelectItem>
                        <SelectItem value="no_vat" className="text-xs">No VAT</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </td>
                <td className={cn(colClass, "text-xs text-muted-foreground")}>
                  {(draft.base_item_supplier_id != null || draft.supplier_catalog_item_id != null)
                    ? <span className="italic">auto-filled</span>
                    : <span>—</span>}
                </td>
                <td className={colClass}>
                  <Input
                    className="h-7 text-xs w-20 text-right"
                    type="number"
                    min="0"
                    step="any"
                    value={draft.quantity}
                    onChange={(e) => setDraft((p) => ({ ...p, quantity: e.target.value }))}
                    disabled={createMutation.isPending}
                  />
                </td>
                <td className={colClass}>
                  <Input
                    className="h-7 text-xs w-24 text-right"
                    type="number"
                    min="0"
                    step="any"
                    value={draft.unit_price}
                    onChange={(e) => setDraft((p) => ({ ...p, unit_price: e.target.value }))}
                    disabled={createMutation.isPending}
                  />
                </td>
                <td className={cn(colClass, "text-right whitespace-nowrap font-medium text-muted-foreground")}>
                  {lineTotal(draft.quantity, draft.unit_price)}
                </td>
                <td className={colClass}>
                  <Input
                    className="h-7 text-xs w-20 text-right"
                    type="number"
                    min="0"
                    step="any"
                    placeholder="—"
                    value={draft.received_quantity}
                    onChange={(e) => setDraft((p) => ({ ...p, received_quantity: e.target.value }))}
                    disabled={createMutation.isPending}
                  />
                </td>
                <td className={cn(colClass, "text-right text-xs text-muted-foreground")}>
                  {(() => {
                    const qty = parseFloat(draft.quantity);
                    const rec = draft.received_quantity.trim() ? parseFloat(draft.received_quantity) : 0;
                    const outstanding = isNaN(qty) ? null : Math.max(0, qty - (isNaN(rec) ? 0 : rec));
                    if (outstanding === null || outstanding === 0) return null;
                    return <span className="text-yellow-600 font-medium">{outstanding % 1 === 0 ? outstanding : outstanding.toFixed(2)}</span>;
                  })()}
                </td>
                <td className={cn(colClass, "text-right")}>
                  <div className="flex items-center justify-end gap-1">
                    <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-muted-foreground" onClick={() => setAdding(false)} disabled={createMutation.isPending}>
                      <X size={12} />
                    </Button>
                    <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-primary" onClick={handleCreate} disabled={createMutation.isPending}>
                      {createMutation.isPending ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
                    </Button>
                  </div>
                </td>
              </tr>
            )}

            {lineItems.length > 0 && (
              <>
                <tr className="border-t border-border bg-muted/30">
                  <td colSpan={3} className={cn(colClass, "text-right font-semibold text-muted-foreground")}>
                    {hasTax ? "Net Subtotal" : "Calculated Total"}
                  </td>
                  <td className={cn(colClass, "text-right font-bold whitespace-nowrap")}>
                    {poCurrency} {calculatedTotal ? fmtAmt(calculatedTotal) : "0.00"}
                  </td>
                  <td colSpan={canEdit ? 3 : 2} />
                </tr>
                {hasTax && (
                  <>
                    <tr className="bg-muted/30">
                      <td colSpan={3} className={cn(colClass, "text-right text-muted-foreground")}>
                        Tax
                      </td>
                      <td className={cn(colClass, "text-right whitespace-nowrap text-orange-600 font-medium")}>
                        + {poCurrency} {fmtAmt(String(totalTaxAmount))}
                      </td>
                      <td colSpan={canEdit ? 3 : 2} />
                    </tr>
                    <tr className="bg-muted/30 border-t border-border/60">
                      <td colSpan={3} className={cn(colClass, "text-right font-semibold text-muted-foreground")}>
                        Gross Total (incl. tax)
                      </td>
                      <td className={cn(colClass, "text-right font-bold whitespace-nowrap")}>
                        {poCurrency} {grossTotal ? fmtAmt(grossTotal) : "0.00"}
                      </td>
                      <td colSpan={canEdit ? 3 : 2} />
                    </tr>
                  </>
                )}
              </>
            )}
          </tbody>
        </table>
      </div>

      {canEdit && !adding && (
        <Button size="sm" variant="outline" className="gap-1.5" onClick={startAdd}>
          <Plus size={13} />
          Add line item
        </Button>
      )}

      {(() => {
        if (isEditing || !isManualOverride || !calculatedTotal || lockedTotal == null) return null;
        const locked = parseFloat(lockedTotal);
        const calc = parseFloat(calculatedTotal);
        if (isNaN(locked) || isNaN(calc)) return null;
        const diff = Math.abs(locked - calc);
        if (diff < 0.005) return null;
        const diffStr = diff.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        return (
          <div className="flex items-start gap-2 rounded-lg border border-yellow-200 bg-yellow-50 px-3 py-2.5 text-sm text-yellow-800">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-yellow-500" />
            <span>
              Locked total differs from line-item sum by <span className="font-medium">{poCurrency} {diffStr}</span>
            </span>
          </div>
        );
      })()}

      <AlertDialog open={deleteId != null} onOpenChange={(open) => { if (!open) setDeleteId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove line item?</AlertDialogTitle>
            <AlertDialogDescription>
              This line item will be permanently removed from the purchase order.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteMutation.isPending}
              onClick={() => deleteId != null && deleteMutation.mutate({ id: poId, lineItemId: deleteId })}
            >
              {deleteMutation.isPending ? "Removing…" : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

type LocationOption = { id: number; name: string };

function ReceiveStockDialog({
  open,
  onClose,
  poId,
}: {
  open: boolean;
  onClose: () => void;
  poId: number;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: lineItemsData } = useListPurchaseOrderLineItems(poId, {
    query: { queryKey: getListPurchaseOrderLineItemsQueryKey(poId), enabled: open },
  });
  const allLineItems: PurchaseOrderLineItem[] = lineItemsData?.line_items ?? [];
  const linkedItems = allLineItems.filter((li) => li.base_item_id != null);

  const { data: locationsData, isLoading: locationsLoading } = useQuery({
    queryKey: ["/api/locations"],
    queryFn: () => apiFetch<{ locations: LocationOption[] }>("/api/locations"),
    enabled: open,
  });
  const locations: LocationOption[] = locationsData?.locations ?? [];

  const [locationId, setLocationId] = useState<string>("");
  const [quantities, setQuantities] = useState<Record<number, string>>({});
  const [overReceiptAcknowledged, setOverReceiptAcknowledged] = useState(false);
  const [receiveActionId, setReceiveActionId] = useState(() => crypto.randomUUID());

  const locationIdNum = locationId ? parseInt(locationId, 10) : null;

  const { data: stockData, isLoading: stockLoading } = useGetPurchaseOrderLineItemStocks(
    poId,
    { location_id: locationIdNum! },
    {
      query: {
        queryKey: getGetPurchaseOrderLineItemStocksQueryKey(poId, { location_id: locationIdNum! }),
        enabled: open && locationIdNum != null && !isNaN(locationIdNum),
      },
    },
  );
  const stockByLineItemId = new Map<number, PurchaseOrderLineItemStockItem>(
    (stockData?.stocks ?? []).map((s) => [s.line_item_id, s]),
  );

  function initQuantities() {
    const init: Record<number, string> = {};
    for (const li of linkedItems) {
      const ordered = parseFloat(li.quantity) || 0;
      const received = parseFloat(li.received_quantity ?? "0") || 0;
      const remaining = Math.max(0, ordered - received);
      init[li.id] = remaining > 0 ? String(remaining) : "";
    }
    setQuantities(init);
    setOverReceiptAcknowledged(false);
    setReceiveActionId(crypto.randomUUID());
  }

  function getOverReceiptInfo(li: PurchaseOrderLineItem): { exceeds: boolean; ordered: number; total: number } | null {
    const qty = parseFloat(quantities[li.id] ?? "");
    if (isNaN(qty) || qty <= 0) return null;
    const ordered = parseFloat(li.quantity) || 0;
    const alreadyReceived = parseFloat(li.received_quantity ?? "0") || 0;
    const total = alreadyReceived + qty;
    return { exceeds: total > ordered, ordered, total };
  }

  const overReceiptItems = linkedItems.filter((li) => getOverReceiptInfo(li)?.exceeds);
  const hasOverReceipt = overReceiptItems.length > 0;

  const receiveMutation = useReceivePurchaseOrder({
    mutation: {
      onSuccess: (data) => {
        qc.invalidateQueries({ queryKey: getListPurchaseOrderLineItemsQueryKey(poId) });
        qc.invalidateQueries({ queryKey: getGetPurchaseOrderQueryKey(poId) });
        qc.invalidateQueries({ queryKey: getListPurchaseOrderReceiveHistoryQueryKey(poId) });
        toast({
          title: "Stock received",
          description: `${data.received.length} item${data.received.length !== 1 ? "s" : ""} added to inventory at ${data.location_name}.`,
        });
        onClose();
      },
      onError: (err) => {
        const msg = err instanceof Error ? err.message : "";
        const isAcceptanceRequired = msg.toLowerCase().includes("acceptance") || (err as any)?.code === "acceptance_required";
        toast({
          title: isAcceptanceRequired ? "Supplier acceptance required" : "Failed to receive stock",
          description: isAcceptanceRequired
            ? "The supplier must accept this PO before stock can be received."
            : (msg || undefined),
          variant: "destructive",
        });
      },
    },
  });

  function handleSubmit() {
    const locId = parseInt(locationId, 10);
    if (isNaN(locId)) {
      toast({ title: "Please select a location", variant: "destructive" });
      return;
    }

    const receipts: { line_item_id: number; quantity: number }[] = [];
    for (const li of linkedItems) {
      const qty = parseFloat(quantities[li.id] ?? "");
      if (!isNaN(qty) && qty > 0) {
        receipts.push({ line_item_id: li.id, quantity: qty });
      }
    }

    if (receipts.length === 0) {
      toast({ title: "Enter a quantity for at least one item", variant: "destructive" });
      return;
    }

    receiveMutation.mutate({
      id: poId,
      data: {
        receive_action_id: receiveActionId,
        location_id: locId,
        receipts,
        allow_over_receipt: hasOverReceipt && overReceiptAcknowledged,
      },
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
        else initQuantities();
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <PackageCheck size={18} className="text-primary" />
            Receive Stock
          </DialogTitle>
        </DialogHeader>

        {linkedItems.length === 0 ? (
          <p className="text-sm text-muted-foreground py-4 text-center">
            No line items are linked to a base item. Link a base item to a line item first.
          </p>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs">Destination location</Label>
              {locationsLoading ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 size={12} className="animate-spin" /> Loading locations…
                </div>
              ) : (
                <select
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
                  value={locationId}
                  onChange={(e) => setLocationId(e.target.value)}
                  disabled={receiveMutation.isPending}
                >
                  <option value="">Select a location…</option>
                  {locations.map((l) => (
                    <option key={l.id} value={String(l.id)}>{l.name}</option>
                  ))}
                </select>
              )}
            </div>

            <div className="rounded-lg border border-border overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/50">
                    <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Item</th>
                    <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground whitespace-nowrap">Ordered</th>
                    <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground whitespace-nowrap">Received</th>
                    <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground whitespace-nowrap">Current stock</th>
                    <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground whitespace-nowrap">Qty to receive</th>
                    <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground whitespace-nowrap">Stock after</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {linkedItems.map((li) => {
                    const ordered = parseFloat(li.quantity) || 0;
                    const received = parseFloat(li.received_quantity ?? "0") || 0;
                    const overInfo = getOverReceiptInfo(li);
                    const rowExceeds = overInfo?.exceeds ?? false;

                    const stockInfo = stockByLineItemId.get(li.id);
                    const currentStock = stockInfo != null ? stockInfo.current_stock : null;
                    const lowStockThreshold = stockInfo?.low_stock_threshold ?? 0;
                    const qtyToReceive = parseFloat(quantities[li.id] ?? "");
                    const hasQty = !isNaN(qtyToReceive) && qtyToReceive > 0;
                    const stockAfter = currentStock != null ? currentStock + (hasQty ? qtyToReceive : 0) : null;
                    const stockAfterIsZero = stockAfter != null && stockAfter <= 0;
                    const stockAfterIsLow = !stockAfterIsZero && stockAfter != null && lowStockThreshold > 0 && stockAfter <= lowStockThreshold;

                    function fmtStock(v: number): string {
                      return v % 1 === 0 ? String(v) : v.toFixed(2).replace(/\.?0+$/, "");
                    }

                    return (
                      <tr key={li.id} className={cn(rowExceeds && "bg-amber-50")}>
                        <td className="px-3 py-2 text-xs">
                          <span className="font-medium">{li.base_item_name ?? li.description}</span>
                          {li.base_item_name && li.base_item_name !== li.description && (
                            <span className="block text-muted-foreground truncate">{li.description}</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-xs text-right text-muted-foreground">
                          {fmtAmt(li.quantity, 4).replace(/\.?0+$/, "")}
                        </td>
                        <td className="px-3 py-2 text-xs text-right text-muted-foreground">
                          {received > 0 ? fmtAmt(String(received), 4).replace(/\.?0+$/, "") : "—"}
                        </td>
                        <td className="px-3 py-2 text-xs text-right text-muted-foreground">
                          {locationIdNum == null ? (
                            <span className="text-muted-foreground/40">—</span>
                          ) : stockLoading ? (
                            <Loader2 size={11} className="animate-spin ml-auto" />
                          ) : currentStock != null ? (
                            fmtStock(currentStock)
                          ) : "—"}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <div className="flex flex-col items-end gap-0.5">
                            <Input
                              className={cn(
                                "h-7 text-xs w-24 text-right ml-auto",
                                rowExceeds && "border-amber-400 focus-visible:ring-amber-400",
                              )}
                              type="number"
                              min="0"
                              step="any"
                              placeholder={String(Math.max(0, ordered - received))}
                              value={quantities[li.id] ?? ""}
                              onChange={(e) => {
                                setQuantities((prev) => ({ ...prev, [li.id]: e.target.value }));
                                setOverReceiptAcknowledged(false);
                              }}
                              disabled={receiveMutation.isPending}
                            />
                            {rowExceeds && overInfo && (
                              <span className="text-[10px] text-amber-600 font-medium whitespace-nowrap">
                                {fmtAmt(String(overInfo.total), 4).replace(/\.?0+$/, "")} &gt; ordered
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-xs text-right">
                          {stockAfter != null ? (
                            <span className={cn(
                              "font-medium inline-flex items-center gap-1 justify-end",
                              stockAfterIsZero ? "text-red-600" : stockAfterIsLow ? "text-amber-600" : "text-green-700",
                            )}>
                              {(stockAfterIsZero || stockAfterIsLow) && <AlertTriangle size={11} className="shrink-0" />}
                              {fmtStock(stockAfter)}
                            </span>
                          ) : (
                            <span className="text-muted-foreground/40">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {hasOverReceipt && (
              <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2.5 flex gap-2.5">
                <AlertTriangle size={15} className="text-amber-500 mt-0.5 shrink-0" />
                <div className="space-y-1.5 flex-1 min-w-0">
                  <p className="text-xs font-medium text-amber-800">
                    {overReceiptItems.length === 1
                      ? "One item exceeds the ordered quantity"
                      : `${overReceiptItems.length} items exceed their ordered quantities`}
                  </p>
                  <p className="text-xs text-amber-700">
                    Receiving more than ordered is unusual and may be a data-entry mistake. Please confirm this is intentional.
                  </p>
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      checked={overReceiptAcknowledged}
                      onChange={(e) => setOverReceiptAcknowledged(e.target.checked)}
                      disabled={receiveMutation.isPending}
                      className="h-3.5 w-3.5 accent-amber-600"
                    />
                    <span className="text-xs text-amber-800 font-medium">I understand — proceed with over-receipt</span>
                  </label>
                </div>
              </div>
            )}

            <p className="text-xs text-muted-foreground">
              Each quantity will be added to the selected location's stock and recorded as a "received" adjustment.
            </p>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={receiveMutation.isPending}>
            Cancel
          </Button>
          {linkedItems.length > 0 && (
            <Button
              onClick={handleSubmit}
              disabled={receiveMutation.isPending || (hasOverReceipt && !overReceiptAcknowledged)}
            >
              {receiveMutation.isPending ? (
                <><Loader2 size={13} className="animate-spin mr-1.5" />Receiving…</>
              ) : (
                <><PackageCheck size={13} className="mr-1.5" />Receive stock</>
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReceivedItemsSection({ poId }: { poId: number }) {
  const { data, isLoading, isError } = useListPurchaseOrderReceiveHistory(poId);
  const history: PurchaseOrderReceiveHistoryItem[] = data?.history ?? [];

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
        <Loader2 size={13} className="animate-spin" />
        Loading receive history…
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex items-center gap-2 text-sm text-destructive py-4">
        <AlertTriangle size={14} />
        Failed to load receive history.
      </div>
    );
  }

  if (history.length === 0) {
    return (
      <div className="text-center py-6 space-y-2">
        <PackageCheck size={20} className="mx-auto text-muted-foreground" />
        <p className="text-sm text-muted-foreground">No stock receipts recorded against this purchase order yet.</p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/50">
            <th className="text-left px-3 py-2 font-medium text-muted-foreground text-xs">Base Item</th>
            <th className="text-right px-3 py-2 font-medium text-muted-foreground text-xs whitespace-nowrap">Qty Received</th>
            <th className="text-left px-3 py-2 font-medium text-muted-foreground text-xs">Location</th>
            <th className="text-left px-3 py-2 font-medium text-muted-foreground text-xs">Note</th>
            <th className="text-right px-3 py-2 font-medium text-muted-foreground text-xs whitespace-nowrap">Date</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {history.map((item) => {
            const qty = item.quantity_change;
            const qtyStr = qty % 1 === 0 ? String(qty) : qty.toFixed(4).replace(/\.?0+$/, "");
            return (
              <tr key={item.id} className="hover:bg-muted/30 transition-colors">
                <td className="px-3 py-2 font-medium text-xs">
                  <Link
                    href={`/dashboard/base-items/${item.base_item_id}?tab=inventory`}
                    className="text-primary hover:underline"
                  >
                    {item.base_item_name ?? `Base Item #${item.base_item_id}`}
                  </Link>
                </td>
                <td className="px-3 py-2 text-right text-xs font-medium text-green-700">
                  +{qtyStr}
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {item.location_name ?? "—"}
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {item.note ?? "—"}
                </td>
                <td className="px-3 py-2 text-right text-xs text-muted-foreground whitespace-nowrap">
                  {formatDate(item.created_at)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function PurchaseOrderDetailPage() {
  const { t } = useTranslation();
  const params = useParams<{ id: string }>();
  const poId = parseInt(params.id ?? "", 10);
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { isOwner, allowedPages } = useWorkspaceRole();
  const canEdit = isOwner || (allowedPages?.includes("suppliers.edit") ?? false);
  const canApprove = isOwner || (allowedPages?.includes("suppliers.approve") ?? false);

  const [isEditing, setIsEditing] = useState(false);
  const [form, setForm] = useState<EditFormState | null>(null);
  const [lineItemEdits, setLineItemEdits] = useState<Record<number, { quantity: string; unit_price: string }>>({});
  const [savingAll, setSavingAll] = useState(false);
  const [vatRateOverridden, setVatRateOverridden] = useState(false);
  const locationChangedRef = useRef(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [duplicating, setDuplicating] = useState(false);
  const [sendConfirmOpen, setSendConfirmOpen] = useState(false);
  const [acceptConfirmOpen, setAcceptConfirmOpen] = useState(false);
  const [receiveOpen, setReceiveOpen] = useState(false);
  const [manualAcceptOpen, setManualAcceptOpen] = useState(false);
  const [manualAcceptName, setManualAcceptName] = useState("");
  const [manualAcceptNotes, setManualAcceptNotes] = useState("");
  const [manualAccepting, setManualAccepting] = useState(false);
  const [copyLinkFeedback, setCopyLinkFeedback] = useState(false);
  const [pdfDownloadingEn, setPdfDownloadingEn] = useState(false);
  const [pdfDownloadingAr, setPdfDownloadingAr] = useState(false);
  const [activitySheetOpen, setActivitySheetOpen] = useState(false);
  const lowStockStorageKey = `po-low-stock-dismissed-${poId}`;

  const [dismissedRecord, setDismissedRecord] = useState<Record<string, number>>(() => {
    try {
      const raw = sessionStorage.getItem(`po-low-stock-dismissed-${poId}`);
      return raw ? (JSON.parse(raw) as Record<string, number>) : {};
    } catch {
      return {};
    }
  });

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(lowStockStorageKey);
      setDismissedRecord(raw ? (JSON.parse(raw) as Record<string, number>) : {});
    } catch {
      setDismissedRecord({});
    }
  }, [lowStockStorageKey]);

  async function handleDownloadPdf(language: "en" | "ar") {
    if (!po) return;
    const setLoading = language === "ar" ? setPdfDownloadingAr : setPdfDownloadingEn;
    setLoading(true);
    try {
      const token = await getClerkToken();
      const res = await fetch(`/api/purchase-orders/${poId}/pdf?language=${language}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      if (!res.ok) {
        let ref: string | undefined;
        try {
          const body = await res.json();
          ref = typeof body?.ref === "string" ? body.ref : undefined;
        } catch {
          // non-JSON body, ignore
        }
        toast({
          title: "Failed to generate PDF",
          description: ref ? `Reference: ${ref}` : undefined,
          variant: "destructive",
        });
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const langSuffix = language === "ar" ? "AR" : "EN";
      a.download = `PO-${po.po_number_label.replace(/[^a-zA-Z0-9_-]/g, "_")}-${langSuffix}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast({ title: "Failed to generate PDF", variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }

  const { data, isLoading, isError } = useGetPurchaseOrder(poId, {
    query: {
      queryKey: getGetPurchaseOrderQueryKey(poId),
      enabled: !isNaN(poId),
    },
  });

  const po = data?.purchase_order;

  const locationIdForStocks = po?.location_id ?? 0;
  const { data: stocksData } = useGetPurchaseOrderLineItemStocks(
    poId,
    { location_id: locationIdForStocks },
    {
      query: {
        queryKey: getGetPurchaseOrderLineItemStocksQueryKey(poId, { location_id: locationIdForStocks }),
        enabled: !isNaN(poId) && locationIdForStocks > 0 && (po?.line_items_count ?? 0) > 0,
      },
    },
  );
  const lowStockItems: PurchaseOrderLineItemStockItem[] = (stocksData?.stocks ?? []).filter(
    (s) => s.current_stock <= 0 || (s.low_stock_threshold > 0 && s.current_stock <= s.low_stock_threshold),
  );

  const lowStockBannerVisible = useMemo(() => {
    if (lowStockItems.length === 0) return false;
    if (Object.keys(dismissedRecord).length === 0) return true;
    return lowStockItems.some((item) => {
      const dismissedStock = dismissedRecord[String(item.base_item_id)];
      return dismissedStock === undefined || item.current_stock < dismissedStock;
    });
  }, [lowStockItems, dismissedRecord]);

  const { data: lineItemsData } = useListPurchaseOrderLineItems(poId, {
    query: {
      queryKey: getListPurchaseOrderLineItemsQueryKey(poId),
      enabled: !isNaN(poId),
    },
  });
  const lineItemsForTax = lineItemsData?.line_items ?? [];
  const totalTaxFromLineItems = lineItemsForTax.reduce((sum, li) => {
    const t = li.tax_amount != null ? parseFloat(li.tax_amount as string) : 0;
    return sum + (isNaN(t) ? 0 : t);
  }, 0);
  const hasTaxFromLineItems = lineItemsForTax.some(
    (li) =>
      (li.tax_amount != null && parseFloat(li.tax_amount as string) > 0) ||
      (li.tax_category != null && li.tax_category !== "not_classified"),
  );

  const editSubtotal = lineItemsForTax.reduce((sum, li) => {
    const e = lineItemEdits[li.id];
    const qty = parseFloat(e?.quantity ?? li.quantity) || 0;
    const price = parseFloat(e?.unit_price ?? li.unit_price) || 0;
    return sum + qty * price;
  }, 0);
  const editCostSummary = form
    ? computeReviewCostSummary(editSubtotal, {
        location_id: form.location_id,
        po_number: form.po_number,
        status: form.status,
        currency: form.currency,
        expected_delivery_date: form.expected_delivery_date,
        notes: form.notes,
        discount_amount: form.discount_amount,
        delivery_fee_amount: form.delivery_fee_amount,
        vat_treatment: form.vat_treatment,
        vat_rate: form.vat_rate,
        payment_terms: "",
        supplier_reference: "",
      })
    : null;
  const hasSupplierVatRate = !!(po?.vat_rate && parseFloat(po.vat_rate) > 0);
  const vatRateReadOnly =
    hasSupplierVatRate && !vatRateOverridden && (form?.vat_treatment ?? "no_vat") !== "no_vat";

  const updateMutation = useUpdatePurchaseOrder({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetPurchaseOrderQueryKey(poId) });
        qc.invalidateQueries({ queryKey: getListPurchaseOrdersQueryKey() });
        if (locationChangedRef.current) {
          qc.invalidateQueries({ queryKey: getListPurchaseOrderLineItemsQueryKey(poId) });
        }
        setIsEditing(false);
        setLineItemEdits({});
      },
      onError: (err) => {
        toast({ title: "Failed to update", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
      },
    },
  });

  const updateLineItemMutation = useUpdatePurchaseOrderLineItem();

  const deleteMutation = useDeletePurchaseOrder({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListPurchaseOrdersQueryKey() });
        toast({ title: "Purchase order deleted" });
        navigate("/purchase-orders");
      },
      onError: (err) => {
        toast({ title: "Failed to delete", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
      },
    },
  });

  const sendMutation = useSendPurchaseOrder({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetPurchaseOrderQueryKey(poId) });
        qc.invalidateQueries({ queryKey: getListPurchaseOrdersQueryKey() });
        setSendConfirmOpen(false);
        toast({ title: "Purchase order sent", description: "Email sent to supplier contact." });
      },
      onError: (err: unknown) => {
        setSendConfirmOpen(false);
        const msg = err instanceof Error ? err.message : undefined;
        toast({ title: "Failed to send", description: msg, variant: "destructive" });
      },
    },
  });

  const acceptMutation = useAcceptPurchaseOrder({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetPurchaseOrderQueryKey(poId) });
        qc.invalidateQueries({ queryKey: getListPurchaseOrdersQueryKey() });
        setAcceptConfirmOpen(false);
        toast({ title: t("po.acceptSuccess"), description: t("po.acceptSuccessDesc") });
      },
      onError: (err: unknown) => {
        setAcceptConfirmOpen(false);
        const msg = err instanceof Error ? err.message : undefined;
        toast({ title: t("po.acceptFailed"), description: msg, variant: "destructive" });
      },
    },
  });

  function startEdit() {
    if (po) {
      setForm(poToForm(po));
      setLineItemEdits({});
      setVatRateOverridden(false);
      setIsEditing(true);
    }
  }

  function cancelEdit() {
    setIsEditing(false);
    setForm(null);
    setLineItemEdits({});
  }

  const handleLineItemBulkEdit = useCallback(
    (id: number, field: "quantity" | "unit_price", value: string) => {
      setLineItemEdits((prev) => {
        const li = lineItemsForTax.find((x) => x.id === id);
        const cur = prev[id] ?? { quantity: li?.quantity ?? "0", unit_price: li?.unit_price ?? "0" };
        return { ...prev, [id]: { ...cur, [field]: value } };
      });
    },
    [lineItemsForTax],
  );

  const saving = savingAll || updateMutation.isPending;

  async function handleSave() {
    if (!form) return;

    // Collect line items whose quantity or unit price changed during this edit session.
    const changedLineItems = lineItemsForTax
      .map((li) => {
        const e = lineItemEdits[li.id];
        if (!e) return null;
        if (e.quantity === li.quantity && e.unit_price === li.unit_price) return null;
        return { id: li.id, quantity: e.quantity.trim(), unit_price: e.unit_price.trim() };
      })
      .filter((x): x is { id: number; quantity: string; unit_price: string } => x !== null);

    // Validate line-item edits before persisting anything.
    for (const li of changedLineItems) {
      const q = parseFloat(li.quantity);
      const p = parseFloat(li.unit_price);
      if (li.quantity === "" || isNaN(q) || q < 0) {
        toast({ title: "Invalid quantity", description: "Each line item must have a non-negative quantity.", variant: "destructive" });
        return;
      }
      if (li.unit_price === "" || isNaN(p) || p < 0) {
        toast({ title: "Invalid unit price", description: "Each line item must have a non-negative unit price.", variant: "destructive" });
        return;
      }
    }

    locationChangedRef.current = form.location_id !== (po?.location_id ?? null);
    const noVat = form.vat_treatment === "no_vat";

    setSavingAll(true);
    try {
      // Persist line-item changes first so the order-level recompute (which sums
      // line items server-side) sees the new quantities/prices.
      for (const li of changedLineItems) {
        await updateLineItemMutation.mutateAsync({
          id: poId,
          lineItemId: li.id,
          data: { quantity: li.quantity, unit_price: li.unit_price },
        });
      }

      await updateMutation.mutateAsync({
        id: poId,
        data: {
          po_number: form.po_number.trim() || null,
          status: form.status,
          currency: form.currency,
          total_amount: form.total_amount_manual_override ? (form.total_amount.trim() || null) : null,
          total_amount_manual_override: form.total_amount_manual_override,
          expected_delivery_date: form.expected_delivery_date || null,
          notes: form.notes.trim() || null,
          location_id: form.location_id ?? null,
          discount_amount: form.discount_amount.trim() || null,
          delivery_fee_amount: form.delivery_fee_amount.trim() || null,
          vat_treatment: form.vat_treatment,
          vat_rate: noVat ? null : (form.vat_rate.trim() || null),
        },
      });

      if (changedLineItems.length > 0) {
        qc.invalidateQueries({ queryKey: getListPurchaseOrderLineItemsQueryKey(poId) });
      }
      toast({
        title: "Purchase order updated",
        description: locationChangedRef.current
          ? "Line-item taxes have been recalculated for the new location."
          : changedLineItems.length > 0
            ? `${changedLineItems.length} line item${changedLineItems.length === 1 ? "" : "s"} updated.`
            : undefined,
      });
    } catch (err) {
      toast({
        title: "Failed to save line items",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
      qc.invalidateQueries({ queryKey: getListPurchaseOrderLineItemsQueryKey(poId) });
    } finally {
      setSavingAll(false);
    }
  }

  if (isNaN(poId)) {
    return (
      <div className="space-y-4">
        <Link href="/purchase-orders"><Button variant="ghost" size="sm" className="gap-1.5"><ArrowLeft size={14} />Purchase Orders</Button></Link>
        <p className="text-destructive text-sm">Invalid purchase order ID.</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
        <Loader2 size={16} className="animate-spin" />
        Loading purchase order…
      </div>
    );
  }

  if (isError || !po) {
    return (
      <div className="space-y-4">
        <Link href="/purchase-orders"><Button variant="ghost" size="sm" className="gap-1.5"><ArrowLeft size={14} />Purchase Orders</Button></Link>
        <p className="text-destructive text-sm">Purchase order not found.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-1.5 text-sm text-muted-foreground">
        <Link href="/purchase-orders" className="hover:text-foreground transition-colors">Purchase Orders</Link>
        <span>/</span>
        {po.supplier_id && (
          <>
            <Link href={`/suppliers/${po.supplier_id}`} className="hover:text-foreground transition-colors">
              {po.supplier_name ?? `Supplier #${po.supplier_id}`}
            </Link>
            <span>/</span>
          </>
        )}
        <span className="text-foreground font-medium">{po.po_number_label}</span>
      </nav>

      {/* Lifecycle progress tracker */}
      <PoLifecycleTracker po={{
        status: po.status,
        sent_at: po.sent_at,
        accepted_at: (po as any).accepted_at,
        received_items_count: po.received_items_count,
        invoice_coverage_status: (po as any).invoice_coverage_status ?? null,
        is_overdue: (po as any).is_overdue ?? false,
      }} />

      {/* Acceptance invalidated warning */}
      {!isEditing && po.status === "sent" && (po as any).acceptance_invalidated_at && !(po as any).acceptance_token && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-500" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-amber-800">
              {t("po.acceptanceLinkInvalidated", "The acceptance link has been invalidated")}
            </p>
            <p className="text-xs text-amber-600 mt-0.5">
              {t("po.acceptanceLinkInvalidatedDesc", "The PO was edited after being sent. Resend it to the supplier to generate a fresh link.")}
            </p>
          </div>
        </div>
      )}

      {/* Low-stock warning banner */}
      {lowStockBannerVisible && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-500" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-amber-800">
              {lowStockItems.length === 1
                ? "1 item is running low on stock at this location"
                : `${lowStockItems.length} items are running low on stock at this location`}
            </p>
            <ul className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
              {lowStockItems.map((s) => (
                <li key={s.base_item_id}>
                  <Link
                    href={`/dashboard/base-items/${s.base_item_id}?tab=inventory`}
                    className="text-xs text-amber-700 underline underline-offset-2 hover:text-amber-900 font-medium"
                  >
                    {s.base_item_name ?? `Base Item #${s.base_item_id}`}
                    <span className="ml-1 font-normal text-amber-600">
                      ({s.current_stock <= 0 ? "out of stock" : `${s.current_stock} left`})
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
          <button
            type="button"
            className="shrink-0 text-amber-400 hover:text-amber-600 transition-colors"
            onClick={() => {
              const record: Record<string, number> = {};
              for (const item of lowStockItems) {
                record[String(item.base_item_id)] = item.current_stock;
              }
              try {
                sessionStorage.setItem(lowStockStorageKey, JSON.stringify(record));
              } catch {
                // ignore — sessionStorage may be unavailable
              }
              setDismissedRecord(record);
            }}
            aria-label="Dismiss low-stock warning"
          >
            <X size={15} />
          </button>
        </div>
      )}

      {/* Next-step banner */}
      {po.status === "created" && !isEditing && (
        <div className="flex items-start gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
          <Send size={15} className="mt-0.5 shrink-0 text-blue-500" />
          <div>
            <span className="font-semibold">{t("po.nextStep.created", "Next step:")} </span>
            {t("po.nextStep.createdDesc", "Send this PO to the supplier so they can review and accept it.")}
          </div>
        </div>
      )}
      {po.status === "sent" && !po.acceptance_invalidated_at && !isEditing && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <Clock size={15} className="mt-0.5 shrink-0 text-amber-500" />
          <div>
            <span className="font-semibold">{t("po.nextStep.sent", "Awaiting supplier acceptance.")} </span>
            {t("po.nextStep.sentDesc", "The acceptance link has been sent to the supplier.")}
          </div>
        </div>
      )}
      {(po.status === "sent" || po.status === "created") && po.acceptance_invalidated_at && !isEditing && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <AlertTriangle size={15} className="mt-0.5 shrink-0 text-amber-500" />
          <div>
            <span className="font-semibold">{t("po.nextStep.invalidated", "PO was edited after sending.")} </span>
            {t("po.nextStep.invalidatedDesc", "Resend the PO to issue a fresh acceptance link.")}
          </div>
        </div>
      )}
      {po.status === "supplier_accepted" && !isEditing && (
        <div className="flex items-start gap-3 rounded-lg border border-teal-200 bg-teal-50 px-4 py-3 text-sm text-teal-800">
          <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-teal-500" />
          <div>
            <span className="font-semibold">{t("po.nextStep.accepted", "Supplier accepted.")} </span>
            {t("po.nextStep.acceptedDesc", "You can now link invoices and receive stock once goods arrive.")}
            {(po as any).is_overdue && (
              <p className="mt-0.5 text-amber-700 font-medium">{t("po.nextStep.overdueHint")}</p>
            )}
          </div>
        </div>
      )}
      {po.status === "partial" && !isEditing && (
        <div className="flex items-start gap-3 rounded-lg border border-yellow-200 bg-yellow-50 px-4 py-3 text-sm text-yellow-800">
          <Package size={15} className="mt-0.5 shrink-0 text-yellow-500" />
          <div>
            <span className="font-semibold">{t("po.nextStep.partial", "Partial receipt recorded.")} </span>
            {t("po.nextStep.partialDesc", "Some items have been received. Continue receiving outstanding stock.")}
          </div>
        </div>
      )}
      {(po.status === "received" || po.status === "completed") && !isEditing && (
        <div className="flex items-start gap-3 rounded-lg border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-800">
          <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-green-500" />
          <div>
            <span className="font-semibold">{t("po.nextStep.received", "All stock received.")} </span>
            {t("po.nextStep.receivedDesc", "Link and match a supplier invoice to complete this PO.")}
          </div>
        </div>
      )}

      {/* Compact header */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center text-primary shrink-0">
            <ShoppingCart size={17} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-lg font-bold tracking-tight font-mono">{po.po_number_label}</h1>
              <PoStatusBadge status={po.status} />
              {(po as any).is_overdue && (
                <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-red-100 text-red-700">
                  {t("po.overdue", "Overdue")}
                </span>
              )}
            </div>
            <p className="text-sm text-muted-foreground mt-0.5 truncate">
              {po.supplier_name ?? "Unknown supplier"}
              {po.supplier_is_archived === true && (
                <Badge variant="secondary" className="ml-2 text-[10px]">Archived</Badge>
              )}
              {po.location_name && (
                <span className="ml-2 text-xs text-muted-foreground">· {po.location_name}</span>
              )}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {/* Send/Resend primary action */}
          {isOwner && !isEditing && (po.status === "created" || po.status === "sent") && (
            <Button
              size="sm"
              className="gap-1.5 bg-blue-600 hover:bg-blue-700 text-white"
              onClick={() => setSendConfirmOpen(true)}
              disabled={sendMutation.isPending}
            >
              {sendMutation.isPending ? (
                <><Loader2 size={13} className="animate-spin" />Sending…</>
              ) : (
                <><Send size={13} />{po.status === "sent" ? t("po.resend", "Resend") : t("po.sendToSupplier", "Send to supplier")}</>
              )}
            </Button>
          )}
          {/* Receive stock button */}
          {canEdit && !isEditing && po.status !== "cancelled" && (
            <Button
              size="sm"
              variant="outline"
              className={cn(
                "gap-1.5",
                (po.status === "supplier_accepted" || po.status === "partial" || po.status === "received")
                  ? "border-green-200 text-green-700 hover:bg-green-50 hover:text-green-800"
                  : "border-gray-200 text-gray-400",
              )}
              disabled={po.status !== "supplier_accepted" && po.status !== "partial"}
              onClick={() => setReceiveOpen(true)}
            >
              <PackageCheck size={13} />
              {t("po.receiveStock", "Receive stock")}
            </Button>
          )}
          {isEditing && (
            <>
              <Button variant="outline" size="sm" onClick={cancelEdit} disabled={saving}>Cancel</Button>
              <Button size="sm" onClick={handleSave} disabled={saving}>
                {saving ? <><Loader2 size={13} className="animate-spin mr-1.5" />Saving…</> : "Save changes"}
              </Button>
            </>
          )}
          {/* More actions dropdown */}
          {!isEditing && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-8 w-8 p-0">
                  <MoreHorizontal size={15} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger disabled={pdfDownloadingEn || pdfDownloadingAr}>
                    <Download size={13} className="mr-2" />
                    {(pdfDownloadingEn || pdfDownloadingAr) ? "Generating PDF…" : "Download PDF"}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    <DropdownMenuItem onClick={() => handleDownloadPdf("en")} disabled={pdfDownloadingEn}>
                      {pdfDownloadingEn ? <Loader2 size={13} className="animate-spin mr-2" /> : <Download size={13} className="mr-2" />}
                      {pdfDownloadingEn ? "Generating…" : "Download English PDF"}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleDownloadPdf("ar")} disabled={pdfDownloadingAr}>
                      {pdfDownloadingAr ? <Loader2 size={13} className="animate-spin mr-2" /> : <Download size={13} className="mr-2" />}
                      {pdfDownloadingAr ? "Generating…" : "Download Arabic PDF"}
                    </DropdownMenuItem>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                {canEdit && po.status !== "cancelled" && (
                  <DropdownMenuItem onClick={startEdit}>
                    <Pencil size={13} className="mr-2" />
                    Edit PO
                  </DropdownMenuItem>
                )}
                {canEdit && ["sent", "supplier_accepted"].includes(po.status) && (
                  <DropdownMenuItem onClick={() => setSendConfirmOpen(true)}>
                    <Send size={13} className="mr-2" />
                    Resend to supplier
                  </DropdownMenuItem>
                )}
                {canApprove && po.status === "sent" && (
                  <DropdownMenuItem onClick={() => setManualAcceptOpen(true)} disabled={manualAccepting}>
                    <UserCheck size={13} className="mr-2" />
                    {t("po.markAccepted", "Mark as Accepted")}
                  </DropdownMenuItem>
                )}
                {po.status === "sent" && (po as any).acceptance_token && (
                  <DropdownMenuItem onClick={() => {
                    const url = `${window.location.origin}/po-accept/${(po as any).acceptance_token}`;
                    navigator.clipboard.writeText(url).catch(() => {});
                    setCopyLinkFeedback(true);
                    setTimeout(() => setCopyLinkFeedback(false), 2000);
                    toast({ title: t("po.linkCopied", "Acceptance link copied") });
                  }}>
                    <Link2 size={13} className="mr-2" />
                    {t("po.copyAcceptLink", "Copy acceptance link")}
                  </DropdownMenuItem>
                )}
                {canEdit && (
                  <DropdownMenuItem
                    disabled={duplicating}
                    onClick={async () => {
                      setDuplicating(true);
                      try {
                        const token = await getClerkToken();
                        const res = await apiFetch<{ id: number }>(`/api/purchase-orders/${poId}/duplicate`, {
                          method: "POST",
                          headers: { Authorization: `Bearer ${token}` },
                        });
                        toast({ title: "Purchase order duplicated", description: "Opening the duplicate…" });
                        window.location.href = `/purchase-orders/${res.id}`;
                      } catch (err) {
                        toast({ title: "Failed to duplicate", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
                        setDuplicating(false);
                      }
                    }}
                  >
                    <Copy size={13} className="mr-2" />
                    {duplicating ? "Duplicating…" : "Duplicate PO"}
                  </DropdownMenuItem>
                )}
                {canEdit && !["cancelled", "received", "completed"].includes(po.status) && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-amber-600 focus:text-amber-600"
                      onClick={() => setCancelOpen(true)}
                    >
                      <X size={13} className="mr-2" />
                      Cancel PO
                    </DropdownMenuItem>
                  </>
                )}
                {canEdit && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onClick={() => setDeleteOpen(true)}
                    >
                      <Trash2 size={13} className="mr-2" />
                      Delete PO
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {/* Two-column layout */}
      <div className="grid grid-cols-1 xl:grid-cols-[65fr_35fr] gap-5 items-start">

        {/* Left column */}
        <div className="space-y-5">

          {/* Supplier Invoice card */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Receipt size={15} className="text-muted-foreground" />
                  {t("po.supplierInvoiceTitle", "Supplier Invoice")}
                </CardTitle>
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center gap-1 rounded-full bg-teal-50 border border-teal-200 px-2 py-0.5 text-[11px] font-medium text-teal-700">
                    <Sparkles size={10} />
                    AI extraction
                  </span>
                  <InvoiceCoverageBadge status={po.invoice_coverage_status} />
                  {po.supplier_id && (
                    <Link href={`/suppliers/${po.supplier_id}?tab=invoices`}>
                      <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-muted-foreground">
                        {t("po.manageInvoices")}
                      </Button>
                    </Link>
                  )}
                </div>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {po.invoice_coverage_status === "matched"
                  ? t("po.coverageMatchedDesc")
                  : po.invoice_coverage_status === "difference_found"
                  ? t("po.coverageDifferenceDesc")
                  : po.invoice_coverage_status === "fully_invoiced"
                  ? t("po.coverageFullyDesc")
                  : po.invoice_coverage_status === "partially_invoiced"
                  ? t("po.coveragePartiallyDesc")
                  : t("po.coverageAwaitingDesc")}
              </p>
            </CardHeader>
            <CardContent>
              <LinkedInvoicesSection
                purchaseOrderId={po.id}
                supplierId={po.supplier_id}
                canEdit={canEdit}
              />
            </CardContent>
          </Card>

          {/* Line Items card */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <List size={15} className="text-muted-foreground" />
                {t("po.lineItemsTitle", "Line Items")}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <LineItemsSection
                poId={poId}
                supplierId={po.supplier_id}
                poCurrency={po.currency}
                canEdit={canEdit}
                lockedTotal={po.total_amount}
                isManualOverride={po.total_amount_manual_override ?? false}
                isEditing={isEditing}
                bulkEdits={lineItemEdits}
                onBulkEdit={handleLineItemBulkEdit}
                bulkSaving={saving}
              />
            </CardContent>
          </Card>

          {/* Stock Receipts card */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <PackageCheck size={15} className="text-muted-foreground" />
                  {t("po.stockReceiptsTitle", "Stock Receipts")}
                </CardTitle>
                {po.line_items_count > 0 && (
                  <div className="flex items-center gap-2">
                    <div className="w-24 h-1.5 rounded-full bg-muted overflow-hidden">
                      <div
                        className={cn("h-full rounded-full transition-all", po.received_items_count >= po.line_items_count ? "bg-green-500" : "bg-yellow-400")}
                        style={{ width: `${Math.min(100, Math.round((po.received_items_count / po.line_items_count) * 100))}%` }}
                      />
                    </div>
                    <span className="text-xs text-muted-foreground whitespace-nowrap">
                      {po.received_items_count}/{po.line_items_count}
                    </span>
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {(po.status === "created" || po.status === "sent") ? (
                <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs text-amber-800">
                  <AlertTriangle size={14} className="shrink-0 text-amber-500" />
                  {t("po.receiveDisabled", "Supplier acceptance required before receiving stock.")}
                </div>
              ) : (
                <ReceivedItemsSection poId={poId} />
              )}
            </CardContent>
          </Card>
        </div>

        {/* Right column */}
        <div className="space-y-5">

          {/* PO Summary card */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Package size={15} className="text-muted-foreground" />
                  {t("po.poSummaryTitle", "PO Summary")}
                </CardTitle>
                {canEdit && !isEditing && po.status !== "cancelled" && (
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={startEdit}>
                    <Pencil size={11} className="mr-1" />
                    Edit
                  </Button>
                )}
                {isEditing && (
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={cancelEdit} disabled={saving}>
                    Cancel
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="space-y-3">
              {isEditing && form ? (
                <div className="space-y-3">
                  <div className="space-y-1">
                    <Label className="text-xs">PO Number</Label>
                    <Input
                      placeholder="e.g. PO-2026-001"
                      value={form.po_number}
                      onChange={(e) => setForm((f) => f ? { ...f, po_number: e.target.value } : f)}
                      disabled={updateMutation.isPending}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Location</Label>
                    <LocationComboboxDetail
                      value={form.location_id}
                      onChange={(id) => setForm((f) => f ? { ...f, location_id: id } : f)}
                      disabled={updateMutation.isPending}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label className="text-xs">Status</Label>
                      <select
                        className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
                        value={form.status}
                        onChange={(e) => setForm((f) => f ? { ...f, status: e.target.value } : f)}
                        disabled={updateMutation.isPending}
                      >
                        {PO_STATUSES.filter((s) => (s !== "pending_approval" && s !== "approved") || s === form.status).map((s) => <option key={s} value={s}>{PO_STATUS_MAP[s]?.label ?? s}</option>)}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">Currency</Label>
                      <select
                        className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
                        value={form.currency}
                        onChange={(e) => setForm((f) => f ? { ...f, currency: e.target.value } : f)}
                        disabled={updateMutation.isPending}
                      >
                        {PO_CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs">Total Amount</Label>
                      <button
                        type="button"
                        onClick={() => setForm((f) => f ? { ...f, total_amount_manual_override: !f.total_amount_manual_override } : f)}
                        disabled={updateMutation.isPending}
                        className={cn(
                          "flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium transition-colors",
                          form.total_amount_manual_override
                            ? "bg-amber-100 text-amber-700 hover:bg-amber-200"
                            : "bg-muted text-muted-foreground hover:bg-muted/80",
                        )}
                      >
                        <Lock size={10} />
                        {form.total_amount_manual_override ? "Locked" : "Lock total"}
                      </button>
                    </div>
                    {form.total_amount_manual_override ? (
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        placeholder="0.00"
                        value={form.total_amount}
                        onChange={(e) => setForm((f) => f ? { ...f, total_amount: e.target.value } : f)}
                        disabled={updateMutation.isPending}
                      />
                    ) : (
                      <p className="text-xs text-muted-foreground py-1">
                        Auto-calculated from line items.
                      </p>
                    )}
                  </div>

                  {/* Cost adjustments */}
                  <div className="rounded-lg border border-border p-3 space-y-3">
                    <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Cost adjustments</p>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="space-y-1">
                        <Label className="text-xs">Discount</Label>
                        <Input
                          type="number"
                          min="0"
                          step="0.01"
                          placeholder="0.00"
                          value={form.discount_amount}
                          onChange={(e) => setForm((f) => f ? { ...f, discount_amount: e.target.value } : f)}
                          disabled={updateMutation.isPending}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Delivery fee</Label>
                        <Input
                          type="number"
                          min="0"
                          step="0.01"
                          placeholder="0.00"
                          value={form.delivery_fee_amount}
                          onChange={(e) => setForm((f) => f ? { ...f, delivery_fee_amount: e.target.value } : f)}
                          disabled={updateMutation.isPending}
                        />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">VAT treatment</Label>
                      <select
                        className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
                        value={form.vat_treatment}
                        onChange={(e) => {
                          const v = e.target.value;
                          setForm((f) => f ? {
                            ...f,
                            vat_treatment: v,
                            vat_rate: v === "no_vat" ? "" : (f.vat_rate || po.vat_rate || ""),
                          } : f);
                        }}
                        disabled={updateMutation.isPending}
                      >
                        {Object.entries(VAT_TREATMENT_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                      </select>
                    </div>
                    {form.vat_treatment !== "no_vat" && (
                      <div className="space-y-1">
                        <div className="flex items-center justify-between">
                          <Label className="text-xs">VAT rate (%)</Label>
                          {hasSupplierVatRate && (
                            vatRateReadOnly ? (
                              <button type="button" className="inline-flex items-center gap-1 text-[10px] text-primary hover:underline" onClick={() => setVatRateOverridden(true)}>
                                <Pencil size={10} /> Override
                              </button>
                            ) : (
                              <button type="button" className="text-[10px] text-muted-foreground hover:underline" onClick={() => { setVatRateOverridden(false); setForm((f) => f ? { ...f, vat_rate: po.vat_rate || "" } : f); }}>
                                Use default
                              </button>
                            )
                          )}
                        </div>
                        <Input
                          type="number" min="0" max="100" step="0.01" placeholder="e.g. 5"
                          readOnly={vatRateReadOnly}
                          className={cn("text-sm", vatRateReadOnly && "bg-muted/50 text-muted-foreground")}
                          value={form.vat_rate}
                          onChange={(e) => setForm((f) => f ? { ...f, vat_rate: e.target.value } : f)}
                          disabled={updateMutation.isPending}
                        />
                      </div>
                    )}
                    {form.vat_treatment !== "no_vat" && (
                      <p className="flex items-start gap-1.5 text-[10px] text-muted-foreground">
                        <Info size={12} className="shrink-0 mt-px" />
                        {form.vat_treatment === "vat_exclusive"
                          ? "VAT is calculated on the subtotal and added on top."
                          : "The subtotal includes VAT; the VAT portion is shown for reference."}
                        {vatRateReadOnly && " Rate defaults from the supplier — Override to change."}
                      </p>
                    )}
                    {editCostSummary && (
                      <div className="rounded-md border border-border overflow-hidden">
                        <div className="divide-y divide-border">
                          <div className="flex justify-between px-3 py-1.5 text-xs">
                            <span className="text-muted-foreground">Subtotal</span>
                            <span className="font-medium tabular-nums">{form.currency} {fmtAmt(String(editCostSummary.subtotal))}</span>
                          </div>
                          {editCostSummary.discount > 0 && (
                            <div className="flex justify-between px-3 py-1.5 text-xs">
                              <span className="text-muted-foreground">Discount</span>
                              <span className="font-medium tabular-nums text-destructive">− {form.currency} {fmtAmt(String(editCostSummary.discount))}</span>
                            </div>
                          )}
                          {editCostSummary.deliveryFee > 0 && (
                            <div className="flex justify-between px-3 py-1.5 text-xs">
                              <span className="text-muted-foreground">Delivery fee</span>
                              <span className="font-medium tabular-nums">+ {form.currency} {fmtAmt(String(editCostSummary.deliveryFee))}</span>
                            </div>
                          )}
                          {form.vat_treatment !== "no_vat" && (
                            <div className="flex justify-between px-3 py-1.5 text-xs">
                              <span className="text-muted-foreground">VAT ({form.vat_rate || "0"}%{form.vat_treatment === "vat_inclusive" ? " incl." : ""})</span>
                              <span className="font-medium tabular-nums">{form.vat_treatment === "vat_inclusive" ? "incl. " : "+ "}{form.currency} {fmtAmt(String(editCostSummary.vatAmount))}</span>
                            </div>
                          )}
                          <div className="flex justify-between px-3 py-2 bg-muted/30">
                            <span className="text-sm font-semibold">Grand total</span>
                            <span className="text-sm font-bold tabular-nums">{form.currency} {fmtAmt(String(editCostSummary.grandTotal))}</span>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="space-y-1">
                    <Label className="text-xs">Expected Delivery Date</Label>
                    <Input
                      type="date"
                      value={form.expected_delivery_date}
                      onChange={(e) => setForm((f) => f ? { ...f, expected_delivery_date: e.target.value } : f)}
                      disabled={updateMutation.isPending}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Notes</Label>
                    <Input
                      placeholder="Optional notes…"
                      value={form.notes}
                      onChange={(e) => setForm((f) => f ? { ...f, notes: e.target.value } : f)}
                      disabled={updateMutation.isPending}
                    />
                  </div>
                  <div className="flex justify-end gap-2 pt-1">
                    <Button variant="outline" size="sm" onClick={cancelEdit} disabled={saving}>Cancel</Button>
                    <Button size="sm" onClick={handleSave} disabled={saving}>
                      {saving ? <><Loader2 size={13} className="animate-spin mr-1.5" />Saving…</> : "Save changes"}
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="space-y-2.5 text-sm">
                  <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground shrink-0">PO Number</span>
                    <span className="text-right font-mono font-medium text-xs">{po.po_number_label}</span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground shrink-0">Supplier</span>
                    <Link href={`/suppliers/${po.supplier_id}`} className="text-right text-primary hover:underline truncate">
                      {po.supplier_name ?? `Supplier #${po.supplier_id}`}
                    </Link>
                  </div>
                  {po.location_name && (
                    <div className="flex justify-between gap-2">
                      <span className="text-muted-foreground shrink-0">Location</span>
                      <span className="text-right text-xs">{po.location_name}</span>
                    </div>
                  )}
                  <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground shrink-0">Status</span>
                    <PoStatusBadge status={po.status} />
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground shrink-0">
                      {po.grand_total_amount != null ? "Grand Total" : "Total Amount"}
                    </span>
                    <span className="text-right font-medium flex items-center gap-1">
                      {(po.grand_total_amount ?? po.effective_total)
                        ? `${po.currency} ${parseFloat((po.grand_total_amount ?? po.effective_total)!).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                        : "—"}
                      {po.total_amount_manual_override && (
                        <span title="Total locked — not auto-synced from line items" className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-medium bg-amber-100 text-amber-700">
                          <Lock size={9} />
                          Locked
                        </span>
                      )}
                    </span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground shrink-0">Expected Delivery</span>
                    <span className="text-right text-xs">{formatDate(po.expected_delivery_date)}</span>
                  </div>
                  <div className="flex justify-between gap-2">
                    <span className="text-muted-foreground shrink-0">Created</span>
                    <span className="text-right text-xs">{formatDate(po.created_at)}</span>
                  </div>
                  {po.created_by_name && (
                    <div className="flex justify-between gap-2">
                      <span className="text-muted-foreground shrink-0">Created by</span>
                      <span className="text-right text-xs">{po.created_by_name}</span>
                    </div>
                  )}
                  {po.sent_at && (
                    <div className="flex justify-between gap-2">
                      <span className="text-muted-foreground shrink-0 flex items-center gap-1">
                        <CheckCircle2 size={12} className="text-blue-500" />
                        Last sent
                      </span>
                      <span className="text-right text-xs text-blue-600">{formatDate(po.sent_at)}</span>
                    </div>
                  )}
                  {po.payment_terms && (
                    <div className="flex justify-between gap-2">
                      <span className="text-muted-foreground shrink-0">Payment Terms</span>
                      <span className="text-right text-xs">{po.payment_terms}</span>
                    </div>
                  )}
                  {po.supplier_reference && (
                    <div className="flex justify-between gap-2">
                      <span className="text-muted-foreground shrink-0">Supplier Ref.</span>
                      <span className="text-right text-xs font-mono">{po.supplier_reference}</span>
                    </div>
                  )}
                  {po.notes && (
                    <div className="pt-1 border-t border-border">
                      <p className="text-xs text-muted-foreground mb-1">Notes</p>
                      <p className="text-sm whitespace-pre-wrap">{po.notes}</p>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Financial Summary card */}
          {(po.subtotal_amount != null || po.vat_amount != null || po.grand_total_amount != null || po.discount_amount != null || po.delivery_fee_amount != null || po.vat_treatment != null || hasTaxFromLineItems) && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Tag size={15} className="text-muted-foreground" />
                  {t("po.financialSummaryTitle", "Financial Summary")}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2 text-sm">
                  {po.subtotal_amount != null && (
                    <div className="flex justify-between gap-2">
                      <span className="text-muted-foreground">Subtotal</span>
                      <span className="font-medium tabular-nums">{po.currency} {fmtAmt(po.subtotal_amount)}</span>
                    </div>
                  )}
                  {po.discount_amount != null && parseFloat(po.discount_amount) !== 0 && (
                    <div className="flex justify-between gap-2">
                      <span className="text-muted-foreground">Discount</span>
                      <span className="font-medium tabular-nums text-green-700">− {po.currency} {fmtAmt(po.discount_amount)}</span>
                    </div>
                  )}
                  {po.delivery_fee_amount != null && parseFloat(po.delivery_fee_amount) !== 0 && (
                    <div className="flex justify-between gap-2">
                      <span className="text-muted-foreground">Delivery Fee</span>
                      <span className="font-medium tabular-nums">+ {po.currency} {fmtAmt(po.delivery_fee_amount)}</span>
                    </div>
                  )}
                  {(po.vat_amount != null || po.vat_treatment != null) && (
                    <div className="flex justify-between gap-2">
                      <span className="text-muted-foreground">
                        VAT
                        {po.vat_rate != null && po.vat_treatment !== "no_vat" && (
                          <span className="ml-1 text-xs">({po.vat_rate}%{po.vat_treatment === "vat_inclusive" ? " incl." : " excl."})</span>
                        )}
                      </span>
                      <span className="font-medium tabular-nums flex items-center gap-1">
                        {po.vat_treatment === "no_vat" ? (
                          <span className="text-xs text-muted-foreground font-normal">No VAT</span>
                        ) : po.vat_amount != null ? (
                          <>{po.currency} {fmtAmt(po.vat_amount)}</>
                        ) : "—"}
                        {po.vat_manual_override && po.vat_treatment !== "no_vat" && (
                          <span className="inline-flex items-center rounded px-1 py-0.5 text-[10px] font-medium bg-amber-100 text-amber-700">manual</span>
                        )}
                      </span>
                    </div>
                  )}
                  {hasTaxFromLineItems && (
                    <div className="flex justify-between gap-2">
                      <span className="text-muted-foreground">Tax</span>
                      <span className="font-medium tabular-nums">{po.currency} {totalTaxFromLineItems.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                    </div>
                  )}
                  <div className="flex justify-between gap-2 pt-2 border-t border-border">
                    <span className="font-semibold">Grand Total</span>
                    <span className="font-bold tabular-nums">
                      {po.grand_total_amount != null
                        ? `${po.currency} ${fmtAmt(po.grand_total_amount)}`
                        : po.effective_total != null
                          ? `${po.currency} ${fmtAmt(po.effective_total)}`
                          : "—"}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Attachments card */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-semibold flex items-center gap-2">
                <Paperclip size={15} className="text-muted-foreground" />
                Attachments
              </CardTitle>
            </CardHeader>
            <CardContent>
              <AttachmentsSection
                poId={poId}
                attachmentUrls={po.attachment_urls}
                canEdit={canEdit && !isEditing}
                onUpdated={() => { qc.invalidateQueries({ queryKey: getGetPurchaseOrderQueryKey(poId) }); }}
              />
            </CardContent>
          </Card>

          {/* Recent Activity card */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Clock size={15} className="text-muted-foreground" />
                  Recent Activity
                </CardTitle>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-muted-foreground"
                  onClick={() => setActivitySheetOpen(true)}
                >
                  View all
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <RecentActivityPreview poId={poId} />
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Activity Sheet */}
      <Sheet open={activitySheetOpen} onOpenChange={setActivitySheetOpen}>
        <SheetContent className="sm:max-w-lg">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <Clock size={16} className="text-muted-foreground" />
              Activity
            </SheetTitle>
            <SheetDescription>Full activity history for {po.po_number_label}</SheetDescription>
          </SheetHeader>
          <div className="mt-4 overflow-y-auto max-h-[calc(100vh-120px)]">
            <ActivitySection poId={poId} />
          </div>
        </SheetContent>
      </Sheet>

      {/* Send to supplier confirmation dialog */}
      <AlertDialog open={sendConfirmOpen} onOpenChange={setSendConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send to supplier?</AlertDialogTitle>
            <AlertDialogDescription>
              This will email "{po.po_number_label}" to the supplier's contact address and advance the status to "Sent".
              {po.sent_at && (
                <span className="block mt-1 text-xs text-muted-foreground">
                  Previously sent on {formatDate(po.sent_at)}.
                </span>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={sendMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={sendMutation.isPending}
              onClick={() => sendMutation.mutate({ id: poId })}
            >
              {sendMutation.isPending ? "Sending…" : "Send email"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Manual acceptance dialog */}
      <Dialog open={manualAcceptOpen} onOpenChange={(o) => {
        if (!manualAccepting) setManualAcceptOpen(o);
      }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("po.manualAcceptTitle", "Mark as Supplier Accepted")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <p className="text-sm text-muted-foreground">
              {t("po.manualAcceptDesc", "Record that the supplier has accepted this PO outside of the digital acceptance link.")}
            </p>
            <div className="space-y-1">
              <Label className="text-sm">{t("po.manualAcceptName", "Supplier contact name")} <span className="text-muted-foreground text-xs">({t("po.optional", "optional")})</span></Label>
              <Input
                value={manualAcceptName}
                onChange={(e) => setManualAcceptName(e.target.value)}
                placeholder={t("po.manualAcceptNamePlaceholder", "e.g. Ahmed Al-Rashid")}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-sm">{t("po.manualAcceptNotes", "Notes")} <span className="text-muted-foreground text-xs">({t("po.optional", "optional")})</span></Label>
              <Textarea
                value={manualAcceptNotes}
                onChange={(e) => setManualAcceptNotes(e.target.value)}
                placeholder={t("po.manualAcceptNotesPlaceholder", "e.g. Confirmed via phone call")}
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setManualAcceptOpen(false)} disabled={manualAccepting}>
              {t("po.cancel", "Cancel")}
            </Button>
            <Button
              disabled={manualAccepting}
              onClick={async () => {
                setManualAccepting(true);
                try {
                  const token = await getClerkToken();
                  await apiFetch(`/api/purchase-orders/${poId}/acceptance/manual`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                    body: JSON.stringify({
                      responder_name: manualAcceptName.trim() || undefined,
                      notes: manualAcceptNotes.trim() || undefined,
                    }),
                  });
                  toast({ title: t("po.manualAcceptSuccess", "PO marked as supplier accepted") });
                  setManualAcceptOpen(false);
                  setManualAcceptName("");
                  setManualAcceptNotes("");
                  qc.invalidateQueries({ queryKey: getGetPurchaseOrderQueryKey(poId) });
                  qc.invalidateQueries({ queryKey: getListPurchaseOrdersQueryKey() });
                } catch (err) {
                  toast({ title: t("po.manualAcceptError", "Failed to update status"), variant: "destructive" });
                } finally {
                  setManualAccepting(false);
                }
              }}
            >
              {manualAccepting ? (
                <><Loader2 size={14} className="animate-spin mr-1.5" />{t("po.manualAccepting", "Marking…")}</>
              ) : (
                t("po.manualAcceptConfirm", "Confirm Acceptance")
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cancel PO dialog */}
      <AlertDialog open={cancelOpen} onOpenChange={(o) => { if (!cancelling) setCancelOpen(o); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel purchase order?</AlertDialogTitle>
            <AlertDialogDescription>
              "{po.po_number_label}" will be marked as cancelled. This does not delete the PO — you can still view it in the cancelled tab.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={cancelling}>Keep PO</AlertDialogCancel>
            <AlertDialogAction
              disabled={cancelling}
              onClick={async (e) => {
                e.preventDefault();
                setCancelling(true);
                try {
                  const token = await getClerkToken();
                  await apiFetch(`/api/purchase-orders/${poId}/status`, {
                    method: "PATCH",
                    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
                    body: JSON.stringify({ action: "cancel" }),
                  });
                  toast({ title: "Purchase order cancelled" });
                  setCancelOpen(false);
                  qc.invalidateQueries({ queryKey: getGetPurchaseOrderQueryKey(poId) });
                  qc.invalidateQueries({ queryKey: getListPurchaseOrdersQueryKey() });
                } catch (err) {
                  toast({ title: "Failed to cancel", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
                } finally {
                  setCancelling(false);
                }
              }}
            >
              {cancelling ? <><Loader2 size={13} className="animate-spin mr-1.5" />Cancelling…</> : "Cancel PO"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete dialog */}
      <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete purchase order?</AlertDialogTitle>
            <AlertDialogDescription>
              "{po.po_number_label}" will be permanently removed along with all its line items. Any invoices linked to it will lose their reference. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteMutation.isPending}
              onClick={() => deleteMutation.mutate({ id: poId })}
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Receive stock dialog */}
      <ReceiveStockDialog
        open={receiveOpen}
        onClose={() => setReceiveOpen(false)}
        poId={poId}
      />
    </div>
  );
}
