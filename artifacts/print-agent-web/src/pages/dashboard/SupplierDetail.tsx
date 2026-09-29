import { useState, useCallback, useRef } from "react";
import { useParams, Link, useLocation } from "wouter";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { getCountries, type Country } from "react-phone-number-input";
import "react-phone-number-input/style.css";
import {
  ArrowLeft,
  Store,
  Package,
  Loader2,
  Pencil,
  Archive,
  Trash2,
  Paperclip,
  Upload,
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronsUpDown,
  Check,
  FileText,
  Download,
  Eye,
  X,
  Link2,
  TrendingUp,
  Clock,
  CreditCard,
  BarChart2,
  Mail,
  Phone,
  MapPin,
  Building2,
  ShoppingBag,
  ShoppingCart,
  Plus,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { BaseItemImageThumbnail } from "@/components/BaseItemImageThumbnail";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { getClerkToken, apiFetch } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { COUNTRY_CATALOGUE, EXCLUDED_COUNTRY_NAMES, getCountryMetadata, isExcludedCountry } from "@/lib/countries";
import { cn } from "@/lib/utils";
import { imageUrl } from "@/lib/imageUrl";
import {
  useGetSupplier,
  usePatchSupplier,
  useDeleteSupplier,
  useListSupplierItems,
  useListSupplierDocuments,
  useUploadSupplierDocument,
  useDeleteSupplierDocument,
  useListSupplierStatements,
  useListSupplierStatementRequests,
  useUploadSupplierStatement,
  useDeleteSupplierStatement,
  getListSupplierStatementsQueryKey,
  getListSupplierStatementRequestsQueryKey,
  useListSupplierInvoices,
  useDeleteSupplierInvoice,
  useListBaseItems,
  useListPurchaseOrders,
  useCreatePurchaseOrder,
  useGetSupplierSpendTrend,
  useListSupplierCatalogItems,
  useCreateSupplierCatalogItem,
  useUpdateSupplierCatalogItem,
  useDeleteSupplierCatalogItem,
  getListSuppliersQueryKey,
  getGetSupplierQueryKey,
  getListSupplierDocumentsQueryKey,
  getListSupplierInvoicesQueryKey,
  getListPurchaseOrdersQueryKey,
  getListSupplierCatalogItemsQueryKey,
  useGetBaseItem,
  getGetBaseItemQueryKey,
} from "@workspace/api-client-react";
import type { Supplier, SupplierItem, SupplierDocument, SupplierStatement, SupplierInvoice, BaseItemListItem, PurchaseOrder, SupplierCatalogItem } from "@workspace/api-client-react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  Cell,
} from "recharts";
import { taxNumberLabel, SupplierFormModal, SupplierFormState, supplierToForm as supplierToFormModal, buildSupplierPayload } from "./Suppliers";
import { StockLogPopover } from "@/components/StockLogPopover";
import { AddInvoiceDialog } from "@/components/AddInvoiceDialog";

const SUPPLIER_ALLOWED_COUNTRIES: Country[] = getCountries().filter((c) => !isExcludedCountry(c));
const SUPPLIER_COUNTRY_OPTIONS = COUNTRY_CATALOGUE.filter(
  (c) => !EXCLUDED_COUNTRY_NAMES.includes(c.name),
);

const PAYMENT_TERMS_OPTIONS = [
  "Net 7", "Net 15", "Net 30", "Net 45", "Net 60", "Net 90",
  "Due on Receipt", "50% Upfront", "Cash on Delivery",
];

const CURRENCY_OPTIONS = ["AED", "USD", "EUR", "GBP", "SAR", "LBP"];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function supplierInitials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  return new Date(dateStr).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// ---------------------------------------------------------------------------
// Searchable country combobox
// ---------------------------------------------------------------------------
function CountryCombobox({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (val: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const filtered = SUPPLIER_COUNTRY_OPTIONS.filter((c) =>
    c.name.toLowerCase().includes(search.toLowerCase()),
  );

  const selected = SUPPLIER_COUNTRY_OPTIONS.find((c) => c.name === value);
  const meta = selected ? getCountryMetadata(selected.name) : null;

  if (disabled) {
    return (
      <div className="flex h-9 items-center px-3 rounded-md border border-input bg-muted text-sm">
        {meta ? `${meta.flagEmoji} ${meta.name}` : (value || "—")}
      </div>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between font-normal h-9 px-3"
          type="button"
        >
          <span className={value ? "text-foreground" : "text-muted-foreground"}>
            {meta ? `${meta.flagEmoji} ${meta.name}` : (value || "Select country…")}
          </span>
          <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search countries…"
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            <CommandEmpty>No country found.</CommandEmpty>
            <CommandGroup>
              {value && (
                <CommandItem
                  value=""
                  onSelect={() => { onChange(""); setOpen(false); setSearch(""); }}
                  className="text-muted-foreground"
                >
                  — Clear selection —
                </CommandItem>
              )}
              {filtered.map((c) => {
                const m = getCountryMetadata(c.name);
                return (
                  <CommandItem
                    key={c.code}
                    value={c.name}
                    onSelect={() => { onChange(c.name); setOpen(false); setSearch(""); }}
                  >
                    <Check className={cn("mr-2 size-4", value === c.name ? "opacity-100" : "opacity-0")} />
                    {m ? `${m.flagEmoji} ${c.name}` : c.name}
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}


// ---------------------------------------------------------------------------
// KPI card
// ---------------------------------------------------------------------------
function KpiCard({
  icon: Icon,
  label,
  value,
  muted,
}: {
  icon: React.ElementType;
  label: string;
  value: string | number;
  muted?: boolean;
}) {
  return (
    <div className="rounded-lg border border-border bg-white p-4 flex items-start gap-3">
      <div className="rounded-md bg-primary/8 p-2 shrink-0">
        <Icon size={16} className="text-primary" />
      </div>
      <div className="min-w-0">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className={cn("text-sm font-semibold mt-0.5 truncate", muted && "text-muted-foreground font-normal")}>
          {value}
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Spend trend chart
// ---------------------------------------------------------------------------
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function SpendTrendChart({ supplierId, compact = false, year: yearProp }: { supplierId: number; compact?: boolean; year?: number }) {
  const { data, isLoading } = useGetSupplierSpendTrend(supplierId, yearProp ? { year: yearProp } : undefined);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
        <Loader2 size={13} className="animate-spin" />
        Loading spend trend…
      </div>
    );
  }

  const months = data?.months ?? [];
  const currency = data?.currency ?? null;
  const year = data?.year ?? yearProp ?? new Date().getFullYear();
  const hasData = months.some((m) => m.total > 0);

  if (!hasData) {
    return (
      <div className={cn("text-center space-y-2", compact ? "py-4" : "py-8")}>
        <TrendingUp size={compact ? 18 : 22} className="mx-auto text-muted-foreground" />
        <p className="text-sm text-muted-foreground">No spend data for {year}.</p>
        {!compact && (
          <p className="text-xs text-muted-foreground">Add invoices to track monthly spend.</p>
        )}
      </div>
    );
  }

  const chartData = months.map((m) => ({
    name: MONTH_LABELS[m.month - 1],
    total: m.total,
  }));

  const currentMonth = new Date().getMonth() + 1;

  function formatAmount(val: number) {
    if (val >= 1000) return `${(val / 1000).toFixed(1)}k`;
    return val.toFixed(0);
  }

  return (
    <div className="space-y-1">
      {!compact && (
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs text-muted-foreground font-medium">Monthly Spend — {year}</p>
          {currency && <p className="text-xs text-muted-foreground">{currency}</p>}
        </div>
      )}
      <ResponsiveContainer width="100%" height={compact ? 80 : 160}>
        <BarChart data={chartData} margin={{ top: 4, right: 4, left: -20, bottom: 0 }} barSize={compact ? 8 : 14}>
          <XAxis
            dataKey="name"
            tick={{ fontSize: compact ? 9 : 11, fill: "#94a3b8" }}
            axisLine={false}
            tickLine={false}
          />
          {!compact && (
            <YAxis
              tickFormatter={formatAmount}
              tick={{ fontSize: 10, fill: "#94a3b8" }}
              axisLine={false}
              tickLine={false}
              width={40}
            />
          )}
          <Tooltip
            formatter={(val: number) =>
              currency
                ? [`${currency} ${val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`, "Spend"]
                : [val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }), "Spend"]
            }
            contentStyle={{ fontSize: 12, borderRadius: 6 }}
            cursor={{ fill: "rgba(0,0,0,0.04)" }}
          />
          <Bar dataKey="total" radius={[3, 3, 0, 0]}>
            {chartData.map((_, idx) => (
              <Cell
                key={idx}
                fill={idx + 1 === currentMonth ? "hsl(var(--primary))" : "hsl(var(--primary) / 0.35)"}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
      {compact && currency && (
        <p className="text-xs text-muted-foreground text-right">{currency} · {year}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Performance tab (spend trend with year picker)
// ---------------------------------------------------------------------------
function PerformanceTab({ supplierId }: { supplierId: number }) {
  const currentYear = new Date().getFullYear();
  const [selectedYear, setSelectedYear] = useState(currentYear);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <BarChart2 size={16} className="text-muted-foreground" />
              Monthly Spend Trend
            </CardTitle>
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={() => setSelectedYear((y) => y - 1)}
              >
                <ChevronLeft size={14} />
              </Button>
              <span className="text-xs text-muted-foreground w-10 text-center tabular-nums">
                {selectedYear}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                disabled={selectedYear >= currentYear}
                onClick={() => setSelectedYear((y) => y + 1)}
              >
                <ChevronRight size={14} />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <SpendTrendChart supplierId={supplierId} year={selectedYear} />
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Items tab
// ---------------------------------------------------------------------------
function SupplierItemsTab({ supplierId }: { supplierId: number }) {
  const { data, isLoading } = useListSupplierItems(supplierId);
  const items: SupplierItem[] = data?.items ?? [];

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
        <Loader2 size={14} className="animate-spin" />
        Loading items…
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-10 text-center space-y-3">
        <Package size={28} className="mx-auto text-muted-foreground" />
        <div>
          <p className="font-medium text-sm">No items linked to this supplier</p>
          <p className="text-xs text-muted-foreground mt-1">
            Link this supplier to a base item from the base item's Suppliers tab.
          </p>
        </div>
        <Link href="/base-items">
          <Button size="sm" variant="outline">Go to Base Items</Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-border overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="px-3 py-2 w-14" aria-label="Image" />
              <th className="text-left px-3 py-2 font-medium text-muted-foreground whitespace-nowrap">Item Code</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground whitespace-nowrap">Item Name</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground whitespace-nowrap">Category</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground whitespace-nowrap">Supplier Item Name</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground whitespace-nowrap">Supplier Item Code</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground whitespace-nowrap">Price</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground whitespace-nowrap">Pricing UOM</th>
              <th className="text-left px-3 py-2 font-medium text-muted-foreground whitespace-nowrap">Package</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {items.map((item) => {
              const categoryDisplay = item.main_category_name && item.sub_category_name && item.main_category_name !== item.sub_category_name
                ? `${item.main_category_name} › ${item.sub_category_name}`
                : (item.main_category_name || item.sub_category_name || "—");
              const priceDisplay = item.price != null
                ? `${item.currency} ${parseFloat(item.price).toFixed(2)}`
                : "—";
              return (
                <tr key={item.link_id} className="hover:bg-muted/30 transition-colors">
                  <td className="px-3 py-2">
                    <BaseItemImageThumbnail imageUrl={imageUrl(item.image_url)} name={item.name} />
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">{item.code}</td>
                  <td className="px-3 py-2">
                    <Link href={`/base-items/${item.base_item_id}`} className="hover:underline font-medium">
                      {item.name}
                    </Link>
                    <div className="flex gap-1.5 mt-0.5 flex-wrap">
                      {item.is_preferred && (
                        <span className="text-xs text-purple-700 bg-purple-100 rounded px-1.5 py-0.5">Preferred</span>
                      )}
                      {item.is_default_order_unit && (
                        <span className="text-xs text-blue-700 bg-blue-100 rounded px-1.5 py-0.5">Default Order Unit</span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{categoryDisplay}</td>
                  <td className="px-3 py-2 text-muted-foreground">{item.supplier_item_name ?? "—"}</td>
                  <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{item.supplier_item_code ?? "—"}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{priceDisplay}</td>
                  <td className="px-3 py-2 text-muted-foreground">{item.pricing_uom ?? "—"}</td>
                  <td className="px-3 py-2 text-muted-foreground">{item.package_name ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">{items.length} item{items.length !== 1 ? "s" : ""}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Documents tab
// ---------------------------------------------------------------------------
function DocumentsTab({ supplierId, canEdit }: { supplierId: number; canEdit: boolean }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const { data, isLoading } = useListSupplierDocuments(supplierId);
  const documents: SupplierDocument[] = data?.documents ?? [];

  const uploadMutation = useUploadSupplierDocument({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListSupplierDocumentsQueryKey(supplierId) });
        toast({ title: "Document uploaded" });
      },
      onError: (err) => {
        toast({
          title: "Upload failed",
          description: err instanceof Error ? err.message : "Could not upload document",
          variant: "destructive",
        });
      },
    },
  });

  const deleteMutation = useDeleteSupplierDocument({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListSupplierDocumentsQueryKey(supplierId) });
        setDeletingId(null);
        toast({ title: "Document deleted" });
      },
      onError: (err) => {
        setDeletingId(null);
        toast({
          title: "Delete failed",
          description: err instanceof Error ? err.message : "Could not delete document",
          variant: "destructive",
        });
      },
    },
  });

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    uploadMutation.mutate({ id: supplierId, data: { file } });
  }

  function handleDelete(doc: SupplierDocument) {
    setDeletingId(doc.id);
    deleteMutation.mutate({ id: supplierId, docId: doc.id });
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
        <Loader2 size={14} className="animate-spin" />
        Loading documents…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={handleFileChange}
        disabled={uploadMutation.isPending}
      />

      {documents.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-10 text-center space-y-3">
          <Paperclip size={28} className="mx-auto text-muted-foreground" />
          <div>
            <p className="font-medium text-sm">No documents yet</p>
            <p className="text-xs text-muted-foreground mt-1">
              Upload contracts, certificates, and other supplier documents here.
            </p>
          </div>
          {canEdit && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploadMutation.isPending}
            >
              {uploadMutation.isPending ? (
                <><Loader2 size={13} className="animate-spin mr-1.5" />Uploading…</>
              ) : (
                <><Upload size={13} className="mr-1.5" />Upload Document</>
              )}
            </Button>
          )}
        </div>
      ) : (
        <>
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">File</th>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground whitespace-nowrap">Uploaded</th>
                  <th className="w-8 px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {documents.map((doc) => {
                  const href = imageUrl(doc.file_url);
                  const isDeleting = deletingId === doc.id && deleteMutation.isPending;
                  return (
                    <tr key={doc.id} className="hover:bg-muted/30 transition-colors">
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <FileText size={14} className="shrink-0 text-muted-foreground" />
                          {href ? (
                            <a
                              href={href}
                              target="_blank"
                              rel="noopener noreferrer"
                              download={doc.file_name}
                              className="hover:underline font-medium truncate max-w-xs"
                            >
                              {doc.file_name}
                            </a>
                          ) : (
                            <span className="font-medium truncate max-w-xs">{doc.file_name}</span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">
                        {formatDate(doc.created_at)}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1">
                          {href && (
                            <a href={href} target="_blank" rel="noopener noreferrer" download={doc.file_name} title="Download">
                              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" asChild>
                                <span><Download size={13} /></span>
                              </Button>
                            </a>
                          )}
                          {canEdit && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                              title="Delete"
                              disabled={isDeleting}
                              onClick={() => handleDelete(doc)}
                            >
                              {isDeleting ? <Loader2 size={13} className="animate-spin" /> : <X size={13} />}
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              {documents.length} document{documents.length !== 1 ? "s" : ""}
            </p>
            {canEdit && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
                disabled={uploadMutation.isPending}
              >
                {uploadMutation.isPending ? (
                  <><Loader2 size={13} className="animate-spin mr-1.5" />Uploading…</>
                ) : (
                  <><Upload size={13} className="mr-1.5" />Upload Document</>
                )}
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Statements tab (statement of account)
// ---------------------------------------------------------------------------
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const STATEMENT_STATUS_MAP: Record<string, { label: string; className: string }> = {
  uploaded:   { label: "Uploaded",   className: "bg-blue-100 text-blue-700" },
  reviewed:   { label: "Reviewed",   className: "bg-green-100 text-green-700" },
  reconciled: { label: "Reconciled", className: "bg-emerald-100 text-emerald-700" },
};

type StatementForm = {
  statement_month: string;
  statement_year: string;
  statement_date: string;
  currency: string;
  opening_balance: string;
  closing_balance: string;
  notes: string;
  file: File | null;
};

function StatementsTab({
  supplierId,
  canEdit,
  currencyPref,
}: {
  supplierId: number;
  canEdit: boolean;
  currencyPref: string | null | undefined;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, setLocation] = useLocation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [duplicateConfirm, setDuplicateConfirm] = useState(false);

  const now = new Date();
  const emptyForm = useCallback((): StatementForm => ({
    statement_month: String(now.getMonth() + 1),
    statement_year: String(now.getFullYear()),
    statement_date: "",
    currency: currencyPref || "",
    opening_balance: "",
    closing_balance: "",
    notes: "",
    file: null,
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [currencyPref]);
  const [form, setForm] = useState<StatementForm>(emptyForm);

  const { data, isLoading } = useListSupplierStatements(supplierId);
  const statements: SupplierStatement[] = data?.statements ?? [];
  const collectionRequestsQuery = useListSupplierStatementRequests(
    { supplier_id: supplierId },
    { query: { queryKey: getListSupplierStatementRequestsQueryKey({ supplier_id: supplierId }) } },
  );
  const collectionRequests = collectionRequestsQuery.data?.requests ?? [];

  const uploadMutation = useUploadSupplierStatement();
  const deleteMutation = useDeleteSupplierStatement({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListSupplierStatementsQueryKey(supplierId) });
        setDeletingId(null);
        setConfirmDeleteId(null);
        toast({ title: "Statement deleted" });
      },
      onError: (err) => {
        setDeletingId(null);
        toast({
          title: "Delete failed",
          description: err instanceof Error ? err.message : "Could not delete statement",
          variant: "destructive",
        });
      },
    },
  });

  function openUpload() {
    setForm(emptyForm());
    setDuplicateConfirm(false);
    setUploadOpen(true);
  }

  function submitUpload(force: boolean) {
    if (!form.file) {
      toast({ title: "A file is required", variant: "destructive" });
      return;
    }
    const month = parseInt(form.statement_month, 10);
    const year = parseInt(form.statement_year, 10);
    if (isNaN(month) || month < 1 || month > 12) {
      toast({ title: "Statement month is required", variant: "destructive" });
      return;
    }
    if (isNaN(year)) {
      toast({ title: "Statement year is required", variant: "destructive" });
      return;
    }
    uploadMutation.mutate(
      {
        id: supplierId,
        params: force ? { force: true } : undefined,
        data: {
          file: form.file,
          statement_month: month,
          statement_year: year,
          statement_date: form.statement_date || undefined,
          currency: form.currency || undefined,
          opening_balance: form.opening_balance.trim() || undefined,
          closing_balance: form.closing_balance.trim() || undefined,
          notes: form.notes.trim() || undefined,
        },
      },
      {
        onSuccess: () => {
          qc.invalidateQueries({ queryKey: getListSupplierStatementsQueryKey(supplierId) });
          setUploadOpen(false);
          setDuplicateConfirm(false);
          toast({ title: "Statement uploaded" });
        },
        onError: (err) => {
          const status = (err as { status?: number } | undefined)?.status;
          if (status === 409) {
            setDuplicateConfirm(true);
            return;
          }
          toast({
            title: "Upload failed",
            description: err instanceof Error ? err.message : "Could not upload statement",
            variant: "destructive",
          });
        },
      },
    );
  }

  function handleDelete(id: string) {
    setDeletingId(id);
    deleteMutation.mutate({ id: supplierId, statementId: id });
  }

  function formatBalance(value: string | null | undefined, currency: string | null | undefined): string {
    if (value === null || value === undefined || value === "") return "—";
    const num = Number(value);
    const display = isNaN(num) ? value : num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return currency ? `${currency} ${display}` : display;
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
        <Loader2 size={14} className="animate-spin" />
        Loading statements…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border overflow-hidden">
        <div className="flex items-center justify-between border-b border-border bg-muted/30 px-3 py-3">
          <div>
            <p className="text-sm font-medium">Statement collection history</p>
            <p className="mt-0.5 text-xs text-muted-foreground">Automated requests and manual uploads stay together for this supplier.</p>
          </div>
          <Link href="/supplier-statements">
            <Button size="sm" variant="outline" data-testid="button-open-supplier-statements">Open collection workspace</Button>
          </Link>
        </div>
        {collectionRequestsQuery.isLoading ? (
          <div className="px-3 py-5 text-sm text-muted-foreground">Loading collection requests…</div>
        ) : collectionRequests.length === 0 ? (
          <div className="px-3 py-5 text-sm text-muted-foreground">No automated collection requests for this supplier yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-border bg-muted/20 text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">Exact period</th>
                <th className="px-3 py-2 font-medium">Entity</th>
                <th className="px-3 py-2 font-medium">Source / status</th>
                <th className="px-3 py-2 font-medium">Received</th>
                <th className="px-3 py-2 text-right font-medium">Journey</th>
              </tr></thead>
              <tbody className="divide-y divide-border">
                {collectionRequests.map((request) => {
                  const linked = statements.find((statement) => statement.collection_request_id === request.id);
                  return (
                    <tr key={request.id} data-testid={`supplier-collection-request-${request.id}`} className="hover:bg-muted/20">
                      <td className="px-3 py-2 font-medium">{request.period_label || `${request.period_start ?? "—"} – ${request.period_end ?? "—"}`}</td>
                      <td className="px-3 py-2 text-muted-foreground">Entity {request.finance_entity_id ?? "—"}</td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge variant="secondary" className="font-normal">{request.source === "scheduled" ? "Automated" : "Manual request"}</Badge>
                          <Badge variant="outline" className="font-normal">{request.status ?? "Open"}</Badge>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{linked?.received_at ? formatDate(linked.received_at) : request.received_at ? formatDate(request.received_at) : "Not received"}</td>
                      <td className="px-3 py-2 text-right">
                        <Button size="sm" variant="ghost" data-testid={`button-view-collection-request-${request.id}`} onClick={() => setLocation(`/supplier-statements?request_id=${encodeURIComponent(request.id ?? "")}`)}>View journey</Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {statements.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-10 text-center space-y-3">
          <FileText size={28} className="mx-auto text-muted-foreground" />
          <div>
            <p className="font-medium text-sm">No statements uploaded yet</p>
            <p className="text-xs text-muted-foreground mt-1">
              Upload the supplier's monthly statement of account for reconciliation.
            </p>
          </div>
          {canEdit && (
            <Button size="sm" variant="outline" onClick={openUpload}>
              <Upload size={13} className="mr-1.5" />Upload Statement
            </Button>
          )}
        </div>
      ) : (
        <>
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground whitespace-nowrap">Period</th>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground">File name</th>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground whitespace-nowrap">Currency</th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground whitespace-nowrap">Closing balance</th>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground whitespace-nowrap">Uploaded by</th>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground whitespace-nowrap">Uploaded date</th>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground whitespace-nowrap">Status</th>
                  <th className="w-8 px-3 py-2 text-right font-medium text-muted-foreground">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {statements.map((s) => {
                  const href = imageUrl(s.file_url);
                  const isDeleting = deletingId === s.id && deleteMutation.isPending;
                  const statusMeta = STATEMENT_STATUS_MAP[s.status] ?? { label: s.status, className: "bg-gray-100 text-gray-700" };
                  const monthLabel = MONTH_NAMES[s.statement_month - 1] ?? s.statement_month;
                  return (
                    <tr key={s.id} className="hover:bg-muted/30 transition-colors">
                      <td className="px-3 py-2 whitespace-nowrap font-medium">{monthLabel} {s.statement_year}</td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <FileText size={14} className="shrink-0 text-muted-foreground" />
                          {href ? (
                            <a
                              href={href}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="hover:underline truncate max-w-xs"
                            >
                              {s.original_file_name}
                            </a>
                          ) : (
                            <span className="truncate max-w-xs">{s.original_file_name}</span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{s.currency || "—"}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-right">{formatBalance(s.closing_balance, s.currency)}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{s.uploaded_by_email || "—"}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{formatDate(s.created_at)}</td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        <Badge variant="secondary" className={cn("font-normal", statusMeta.className)}>{statusMeta.label}</Badge>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center justify-end gap-1">
                          {href && (
                            <>
                              <a href={href} target="_blank" rel="noopener noreferrer" title="View">
                                <Button variant="ghost" size="sm" className="h-7 w-7 p-0" asChild>
                                  <span><Eye size={13} /></span>
                                </Button>
                              </a>
                              <a href={href} download={s.original_file_name} title="Download">
                                <Button variant="ghost" size="sm" className="h-7 w-7 p-0" asChild>
                                  <span><Download size={13} /></span>
                                </Button>
                              </a>
                            </>
                          )}
                          {canEdit && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                              title="Delete"
                              disabled={isDeleting}
                              onClick={() => setConfirmDeleteId(s.id)}
                            >
                              {isDeleting ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between">
            <p className="text-xs text-muted-foreground">
              {statements.length} statement{statements.length !== 1 ? "s" : ""}
            </p>
            {canEdit && (
              <Button size="sm" variant="outline" onClick={openUpload}>
                <Upload size={13} className="mr-1.5" />Upload Statement
              </Button>
            )}
          </div>
        </>
      )}

      {/* Upload modal */}
      <AlertDialog open={uploadOpen} onOpenChange={(v) => { if (!uploadMutation.isPending) setUploadOpen(v); }}>
        <AlertDialogContent className="max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>Upload Statement of Account</AlertDialogTitle>
          </AlertDialogHeader>
          <div className="space-y-3 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Month <span className="text-destructive">*</span></Label>
                <select
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
                  value={form.statement_month}
                  onChange={(e) => setForm((f) => ({ ...f, statement_month: e.target.value }))}
                  disabled={uploadMutation.isPending}
                >
                  {MONTH_NAMES.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Year <span className="text-destructive">*</span></Label>
                <Input
                  type="number"
                  min="1900"
                  max="9999"
                  value={form.statement_year}
                  onChange={(e) => setForm((f) => ({ ...f, statement_year: e.target.value }))}
                  disabled={uploadMutation.isPending}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Statement Date</Label>
                <Input
                  type="date"
                  value={form.statement_date}
                  onChange={(e) => setForm((f) => ({ ...f, statement_date: e.target.value }))}
                  disabled={uploadMutation.isPending}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Currency</Label>
                <select
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
                  value={form.currency}
                  onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value }))}
                  disabled={uploadMutation.isPending}
                >
                  <option value="">—</option>
                  {CURRENCY_OPTIONS.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Opening Balance</Label>
                <Input
                  type="number" step="0.01" placeholder="0.00"
                  value={form.opening_balance}
                  onChange={(e) => setForm((f) => ({ ...f, opening_balance: e.target.value }))}
                  disabled={uploadMutation.isPending}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Closing Balance</Label>
                <Input
                  type="number" step="0.01" placeholder="0.00"
                  value={form.closing_balance}
                  onChange={(e) => setForm((f) => ({ ...f, closing_balance: e.target.value }))}
                  disabled={uploadMutation.isPending}
                />
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Notes</Label>
              <Textarea
                placeholder="Optional notes…"
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                disabled={uploadMutation.isPending}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">File <span className="text-destructive">*</span></Label>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,.xlsx,.xls,.csv,.png,.jpg,.jpeg"
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm file:mr-3 file:border-0 file:bg-transparent file:text-sm file:font-medium focus:outline-none focus:ring-1 focus:ring-ring"
                onChange={(e) => setForm((f) => ({ ...f, file: e.target.files?.[0] ?? null }))}
                disabled={uploadMutation.isPending}
              />
              <p className="text-xs text-muted-foreground">PDF, XLSX, XLS, CSV, PNG or JPG.</p>
            </div>

            {duplicateConfirm && (
              <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800 flex items-start gap-2">
                <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                <span>
                  A statement already exists for this supplier in {MONTH_NAMES[parseInt(form.statement_month, 10) - 1]} {form.statement_year}.
                  Upload anyway?
                </span>
              </div>
            )}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={uploadMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={uploadMutation.isPending}
              onClick={(e) => { e.preventDefault(); submitUpload(duplicateConfirm); }}
            >
              {uploadMutation.isPending ? (
                <><Loader2 size={13} className="animate-spin mr-1.5" />Uploading…</>
              ) : duplicateConfirm ? "Upload Anyway" : "Upload Statement"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete confirmation */}
      <AlertDialog open={confirmDeleteId !== null} onOpenChange={(v) => { if (!v) setConfirmDeleteId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete statement?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes the statement record and its stored file. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteMutation.isPending}
              onClick={(e) => { e.preventDefault(); if (confirmDeleteId) handleDelete(confirmDeleteId); }}
            >
              {deleteMutation.isPending ? <><Loader2 size={13} className="animate-spin mr-1.5" />Deleting…</> : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Invoice status badge
// ---------------------------------------------------------------------------
const INVOICE_STATUS_MAP: Record<string, { label: string; className: string }> = {
  draft:     { label: "Draft",     className: "bg-gray-100 text-gray-700" },
  issued:    { label: "Issued",    className: "bg-blue-100 text-blue-700" },
  paid:      { label: "Paid",      className: "bg-green-100 text-green-700" },
  overdue:   { label: "Overdue",   className: "bg-red-100 text-red-700" },
  cancelled: { label: "Cancelled", className: "bg-gray-100 text-gray-500 line-through" },
};

function InvoiceStatusBadge({ status }: { status: string }) {
  const s = INVOICE_STATUS_MAP[status] ?? { label: status, className: "bg-gray-100 text-gray-600" };
  return (
    <span className={cn("inline-block rounded px-1.5 py-0.5 text-xs font-medium", s.className)}>
      {s.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Invoices tab
// ---------------------------------------------------------------------------
function SupplierInvoicesTab({ supplierId, canEdit, currencyPref, supplierVatStatus }: { supplierId: number; canEdit: boolean; currencyPref?: string | null; supplierVatStatus?: "registered" | "not_registered" | "unknown" | null }) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data, isLoading } = useListSupplierInvoices(supplierId);
  const invoices: SupplierInvoice[] = data?.invoices ?? [];

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingInvoice, setEditingInvoice] = useState<SupplierInvoice | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [exportFrom, setExportFrom] = useState("");
  const [exportTo, setExportTo] = useState("");

  function openCreate() {
    setEditingInvoice(null);
    setDialogOpen(true);
  }

  function openEdit(inv: SupplierInvoice) {
    setEditingInvoice(inv);
    setDialogOpen(true);
  }

  const deleteMutation = useDeleteSupplierInvoice({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListSupplierInvoicesQueryKey(supplierId) });
        qc.invalidateQueries({ queryKey: getGetSupplierQueryKey(supplierId) });
        setDeletingId(null);
        setConfirmDeleteId(null);
        toast({ title: "Invoice deleted" });
      },
      onError: (err) => {
        setDeletingId(null);
        toast({ title: "Failed to delete invoice", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
      },
    },
  });

  function handleDelete(inv: SupplierInvoice) {
    setDeletingId(inv.id);
    deleteMutation.mutate({ id: supplierId, invoiceId: inv.id });
  }

  async function handleExport() {
    if (isExporting) return;
    setIsExporting(true);
    try {
      const params = new URLSearchParams();
      if (exportFrom) params.set("from", exportFrom);
      if (exportTo) params.set("to", exportTo);
      const url = `/api/suppliers/${supplierId}/invoices/export?${params.toString()}`;
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
      const filename = filenameMatch ? filenameMatch[1] : "invoices.csv";
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
      toast({ title: "Export complete", description: `${filename} downloaded.` });
    } catch (err) {
      toast({
        title: "Export failed",
        description: err instanceof Error ? err.message : "Something went wrong.",
        variant: "destructive",
      });
    } finally {
      setIsExporting(false);
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
        <Loader2 size={14} className="animate-spin" />
        Loading invoices…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {invoices.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-10 text-center space-y-3">
          <CreditCard size={28} className="mx-auto text-muted-foreground" />
          <div>
            <p className="font-medium text-sm">No invoices yet</p>
            <p className="text-xs text-muted-foreground mt-1">
              Record invoices from this supplier to track spend and payment history.
            </p>
          </div>
          {canEdit && (
            <Button size="sm" variant="outline" onClick={openCreate}>
              <FileText size={13} className="mr-1.5" />
              Add Invoice
            </Button>
          )}
        </div>
      ) : (
        <>
          <div className="rounded-lg border border-border overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/50">
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground whitespace-nowrap">Invoice #</th>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground whitespace-nowrap">Date</th>
                  <th className="text-right px-3 py-2 font-medium text-muted-foreground whitespace-nowrap">Amount</th>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground whitespace-nowrap">Status</th>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground whitespace-nowrap">Linked To</th>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground whitespace-nowrap">Paid On</th>
                  <th className="text-left px-3 py-2 font-medium text-muted-foreground whitespace-nowrap">Notes</th>
                  <th className="w-16 px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {invoices.map((inv) => {
                  const isDeleting = deletingId === inv.id && deleteMutation.isPending;
                  const importedInvoice = inv as SupplierInvoice & {
                    ai_import_id?: number | null;
                    ai_import_source_available?: boolean;
                  };
                  const aiImportId = importedInvoice.ai_import_id;
                  return (
                    <tr key={inv.id} className="hover:bg-muted/30 transition-colors">
                      <td className="px-3 py-2 font-mono text-xs">{inv.invoice_number || `INV-${String(inv.id).padStart(4, "0")}`}</td>
                      <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">{formatDate(inv.issued_at)}</td>
                      <td className="px-3 py-2 text-right whitespace-nowrap font-medium">
                        {inv.currency} {parseFloat(inv.amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                      <td className="px-3 py-2"><InvoiceStatusBadge status={inv.status} /></td>
                      <td className="px-3 py-2 text-xs">
                        {inv.reference_type === "base_item" && inv.reference_id != null ? (
                          <Link
                            href={`/base-items/${inv.reference_id}`}
                            className="inline-flex items-center gap-1 text-primary hover:underline font-medium"
                          >
                            <Package size={12} className="shrink-0" />
                            {inv.reference_name ?? `Base Item #${inv.reference_id}`}
                          </Link>
                        ) : inv.reference_type === "purchase_order" && inv.reference_id != null ? (
                          <Link
                            href={`/purchase-orders/${inv.reference_id}`}
                            className="inline-flex items-center gap-1 text-primary hover:underline font-medium"
                          >
                            <ShoppingCart size={12} className="shrink-0" />
                            {inv.reference_name ?? `PO #${inv.reference_id}`}
                          </Link>
                        ) : aiImportId != null ? (
                          <Link
                            href="/ai-invoice-import"
                            className="inline-flex items-center gap-1 text-primary hover:underline font-medium"
                          >
                            <FileText size={12} className="shrink-0" />
                            AI Import #{aiImportId}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-muted-foreground text-xs">{formatDate(inv.paid_at)}</td>
                      <td className="px-3 py-2 text-muted-foreground text-xs max-w-[140px] truncate">{inv.notes || "—"}</td>
                      <td className="px-3 py-2">
                        {importedInvoice.ai_import_source_available && aiImportId != null ? (
                          <Button asChild variant="ghost" size="sm" className="h-7 px-2">
                            <a
                              href={`/api/finance/invoice-review/${aiImportId}/source`}
                              target="_blank"
                              rel="noopener noreferrer"
                              aria-label={`View invoice ${inv.invoice_number || inv.id}`}
                              data-testid={`link-view-invoice-source-${inv.id}`}
                            >
                              <Eye size={13} className="mr-1" />
                              View invoice
                            </a>
                          </Button>
                        ) : canEdit && aiImportId == null ? (
                          <div className="flex items-center gap-1">
                            <Button variant="ghost" size="sm" className="h-7 w-7 p-0" title="Edit" onClick={() => openEdit(inv)}>
                              <Pencil size={13} />
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                              title="Delete"
                              disabled={isDeleting}
                              onClick={() => setConfirmDeleteId(inv.id)}
                            >
                              {isDeleting ? <Loader2 size={13} className="animate-spin" /> : <X size={13} />}
                            </Button>
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between flex-wrap gap-2">
            <p className="text-xs text-muted-foreground">
              {invoices.length} invoice{invoices.length !== 1 ? "s" : ""}
            </p>
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex items-center gap-1.5">
                <Label className="text-xs text-muted-foreground whitespace-nowrap">From</Label>
                <Input
                  type="date"
                  className="h-7 text-xs w-32 px-2"
                  value={exportFrom}
                  onChange={(e) => setExportFrom(e.target.value)}
                />
              </div>
              <div className="flex items-center gap-1.5">
                <Label className="text-xs text-muted-foreground whitespace-nowrap">To</Label>
                <Input
                  type="date"
                  className="h-7 text-xs w-32 px-2"
                  value={exportTo}
                  onChange={(e) => setExportTo(e.target.value)}
                />
              </div>
              <Button size="sm" variant="outline" onClick={handleExport} disabled={isExporting}>
                {isExporting ? <Loader2 size={13} className="mr-1.5 animate-spin" /> : <Download size={13} className="mr-1.5" />}
                Export CSV
              </Button>
              {canEdit && (
                <Button size="sm" variant="outline" onClick={openCreate}>
                  <FileText size={13} className="mr-1.5" />
                  Add Invoice
                </Button>
              )}
            </div>
          </div>
        </>
      )}

      <AddInvoiceDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        supplierId={supplierId}
        editingInvoice={editingInvoice}
        currencyPref={currencyPref}
        supplierVatStatus={supplierVatStatus}
      />

      {/* Delete confirm dialog */}
      <AlertDialog open={confirmDeleteId !== null} onOpenChange={(v) => { if (!v) setConfirmDeleteId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete invoice?</AlertDialogTitle>
            <AlertDialogDescription>
              This invoice record will be permanently removed. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteMutation.isPending}
              onClick={() => {
                const inv = invoices.find((i) => i.id === confirmDeleteId);
                if (inv) handleDelete(inv);
              }}
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview tab
// ---------------------------------------------------------------------------
function OverviewTab({
  supplier,
  supplierId,
  canEdit,
  onEditNotes,
}: {
  supplier: Supplier;
  supplierId: number;
  canEdit: boolean;
  onEditNotes: () => void;
}) {
  const { data: itemsData, isLoading: itemsLoading } = useListSupplierItems(supplierId);
  const items: SupplierItem[] = itemsData?.items ?? [];

  const countryMeta = supplier.country ? getCountryMetadata(supplier.country) : null;
  const supplierIdLabel = supplier.supplier_id_label ?? `SUP-${String(supplier.id).padStart(4, "0")}`;
  const taxLabel = taxNumberLabel(supplier.country ?? "");

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
      {/* Company Profile */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Building2 size={15} className="text-muted-foreground" />
            Company Profile
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2.5 text-sm">
          <div className="flex justify-between gap-2">
            <span className="text-muted-foreground shrink-0">Legal Name</span>
            <span className="text-right font-medium truncate">{supplier.name}</span>
          </div>
          {supplier.display_name && supplier.display_name !== supplier.name && (
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground shrink-0">Display Name</span>
              <span className="text-right truncate">{supplier.display_name}</span>
            </div>
          )}
          <div className="flex justify-between gap-2">
            <span className="text-muted-foreground shrink-0">{taxLabel}</span>
            <span className="text-right font-mono text-xs">{supplier.tax_number || "—"}</span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-muted-foreground shrink-0">Country</span>
            <span className="text-right">
              {countryMeta ? `${countryMeta.flagEmoji} ${countryMeta.name}` : (supplier.country || "—")}
            </span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-muted-foreground shrink-0">Supplier Code</span>
            <span className="text-right font-mono text-xs">{supplier.supplier_code || "—"}</span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-muted-foreground shrink-0">Supplier ID</span>
            <span className="text-right font-mono text-xs">{supplierIdLabel}</span>
          </div>
          {supplier.category && (
            <div className="flex justify-between gap-2 items-center">
              <span className="text-muted-foreground shrink-0">Category</span>
              <Badge variant="secondary" className="text-xs font-normal">{supplier.category}</Badge>
            </div>
          )}
          <div className="flex justify-between gap-2">
            <span className="text-muted-foreground shrink-0">Payment Terms</span>
            <span className="text-right">{supplier.payment_terms || "—"}</span>
          </div>
          <div className="flex justify-between gap-2 items-center">
            <span className="text-muted-foreground shrink-0">VAT Registered</span>
            {supplier.vat_registered ? (
              <Badge className="bg-green-600 hover:bg-green-700 text-xs font-normal">Yes</Badge>
            ) : (
              <span className="text-right text-muted-foreground">No</span>
            )}
          </div>
          {supplier.website && (
            <div className="flex justify-between gap-2 items-center">
              <span className="text-muted-foreground shrink-0 flex items-center gap-1">
                <Link2 size={12} />
                Website
              </span>
              <a
                href={supplier.website}
                target="_blank"
                rel="noopener noreferrer"
                className="text-right text-primary hover:underline truncate text-sm"
              >
                {supplier.website.replace(/^https?:\/\//, "")}
              </a>
            </div>
          )}
          {supplier.billing_address && (
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground shrink-0 flex items-center gap-1">
                <MapPin size={12} />
                Billing Address
              </span>
              <span className="text-right text-xs whitespace-pre-wrap max-w-[55%]">{supplier.billing_address}</span>
            </div>
          )}
          <div className="flex justify-between gap-2">
            <span className="text-muted-foreground shrink-0">Supplier Since</span>
            <span className="text-right text-xs">{formatDate(supplier.created_at)}</span>
          </div>
          {Array.isArray(supplier.tags) && supplier.tags.length > 0 && (
            <div className="pt-1 border-t border-border">
              <p className="text-xs text-muted-foreground mb-1.5">Tags</p>
              <div className="flex flex-wrap gap-1.5">
                {(supplier.tags as string[]).map((tag) => (
                  <span
                    key={tag}
                    className="inline-flex items-center rounded-full bg-primary/10 border border-primary/20 text-primary px-2.5 py-0.5 text-xs font-medium"
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Primary Contact */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <Store size={15} className="text-muted-foreground" />
            Primary Contact
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2.5 text-sm">
          <div className="flex justify-between gap-2">
            <span className="text-muted-foreground shrink-0">Name</span>
            <span className="text-right font-medium">{supplier.contact_name || "—"}</span>
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-muted-foreground shrink-0">Role</span>
            <span className="text-right text-muted-foreground">Not set</span>
          </div>
          <div className="flex justify-between gap-2 items-center">
            <span className="text-muted-foreground shrink-0 flex items-center gap-1">
              <Mail size={12} />
              Email
            </span>
            {supplier.contact_email ? (
              <a href={`mailto:${supplier.contact_email}`} className="text-right text-primary hover:underline truncate">
                {supplier.contact_email}
              </a>
            ) : (
              <span className="text-right text-muted-foreground">—</span>
            )}
          </div>
          <div className="flex justify-between gap-2 items-center">
            <span className="text-muted-foreground shrink-0 flex items-center gap-1">
              <Phone size={12} />
              Phone
            </span>
            {supplier.contact_phone ? (
              <a href={`tel:${supplier.contact_phone}`} className="text-right text-primary hover:underline">
                {supplier.contact_phone}
              </a>
            ) : (
              <span className="text-right text-muted-foreground">—</span>
            )}
          </div>
          <div className="flex justify-between gap-2">
            <span className="text-muted-foreground shrink-0 flex items-center gap-1">
              <MapPin size={12} />
              Preferred Currency
            </span>
            <span className="text-right">{supplier.currency_pref || "—"}</span>
          </div>
          {supplier.min_order_value && (
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground shrink-0">Min. Order</span>
              <span className="text-right">{supplier.min_order_value}</span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Notes */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <FileText size={15} className="text-muted-foreground" />
              Internal Notes
            </CardTitle>
            {canEdit && (
              <Button size="sm" variant="ghost" className="h-7 px-2 text-muted-foreground" onClick={onEditNotes}>
                <Pencil size={12} className="mr-1" />
                Edit
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {supplier.notes ? (
            <p className="text-sm whitespace-pre-wrap">{supplier.notes}</p>
          ) : (
            <p className="text-sm text-muted-foreground italic">No internal notes yet.</p>
          )}
        </CardContent>
      </Card>

      {/* Recent Invoices */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <CreditCard size={15} className="text-muted-foreground" />
            Recent Invoices
          </CardTitle>
        </CardHeader>
        <CardContent className="text-center py-6 space-y-2">
          <CreditCard size={22} className="mx-auto text-muted-foreground" />
          <p className="text-sm text-muted-foreground">No invoices yet.</p>
        </CardContent>
      </Card>

      {/* Linked Base Items */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-semibold flex items-center gap-2">
              <Link2 size={15} className="text-muted-foreground" />
              Linked Base Items
            </CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          {itemsLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
              <Loader2 size={13} className="animate-spin" />
              Loading…
            </div>
          ) : items.length === 0 ? (
            <div className="text-center py-4 space-y-2">
              <Package size={20} className="mx-auto text-muted-foreground" />
              <p className="text-sm text-muted-foreground">No items linked yet.</p>
            </div>
          ) : (
            <div className="space-y-1.5">
              {items.slice(0, 5).map((item) => (
                <div key={item.link_id} className="flex items-center justify-between gap-2 text-sm py-1 border-b border-border last:border-0">
                  <Link href={`/base-items/${item.base_item_id}`} className="font-medium hover:underline truncate">
                    {item.name}
                  </Link>
                  <span className="text-xs text-muted-foreground shrink-0 font-mono">{item.code}</span>
                </div>
              ))}
              {items.length > 5 && (
                <p className="text-xs text-muted-foreground pt-1">
                  +{items.length - 5} more — see Linked Items tab
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Spend Trend */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold flex items-center gap-2">
            <BarChart2 size={15} className="text-muted-foreground" />
            Spend Trend
          </CardTitle>
        </CardHeader>
        <CardContent>
          <SpendTrendChart supplierId={supplierId} compact />
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Purchase orders tab (embedded in supplier detail)
// ---------------------------------------------------------------------------
const PO_STATUS_MAP_SUPPLIER: Record<string, { label: string; className: string }> = {
  draft:     { label: "Draft",     className: "bg-gray-100 text-gray-700" },
  sent:      { label: "Sent",      className: "bg-blue-100 text-blue-700" },
  confirmed: { label: "Confirmed", className: "bg-purple-100 text-purple-700" },
  received:  { label: "Received",  className: "bg-green-100 text-green-700" },
  cancelled: { label: "Cancelled", className: "bg-gray-100 text-gray-500" },
};

const PO_STATUSES_S = ["draft", "sent", "confirmed", "received", "cancelled"];
const PO_CURRENCIES_S = ["AED", "USD", "EUR", "GBP", "SAR", "LBP"];

function SupplierPurchaseOrdersTab({ supplierId, canEdit }: { supplierId: number; canEdit: boolean }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const [createOpen, setCreateOpen] = useState(false);
  const [poForm, setPoForm] = useState({ po_number: "", status: "draft", currency: "AED", total_amount: "", expected_delivery_date: "", notes: "", location_id: null as number | null });

  const { data, isLoading } = useListPurchaseOrders({ supplier_id: supplierId });
  const orders: PurchaseOrder[] = data?.purchase_orders ?? [];

  type LocationOption = { id: number; name: string };
  const { data: locationsData } = useQuery<{ locations: LocationOption[] }>({
    queryKey: ["locations"],
    queryFn: () => apiFetch<{ locations: LocationOption[] }>("/api/locations"),
  });
  const locationOptions = locationsData?.locations ?? [];

  const [locOpen, setLocOpen] = useState(false);

  const createMutation = useCreatePurchaseOrder({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListPurchaseOrdersQueryKey() });
        setCreateOpen(false);
        setPoForm({ po_number: "", status: "draft", currency: "AED", total_amount: "", expected_delivery_date: "", notes: "", location_id: null });
        toast({ title: "Purchase order created" });
      },
      onError: (err) => {
        toast({ title: "Failed to create purchase order", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
      },
    },
  });

  const isSaving = createMutation.isPending;

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
        <Loader2 size={14} className="animate-spin" />Loading purchase orders…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">Purchase orders from this supplier.</p>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => navigate("/purchase-orders")} className="gap-1.5 text-xs">
            <ArrowRight size={12} />
            View all POs
          </Button>
          {canEdit && (
            <Button size="sm" onClick={() => setCreateOpen(true)} className="gap-1.5 text-xs">
              <Plus size={12} />
              New PO
            </Button>
          )}
        </div>
      </div>

      {orders.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-10 text-center space-y-2">
          <ShoppingCart size={24} className="mx-auto text-muted-foreground" />
          <p className="text-sm font-medium">No purchase orders yet</p>
          <p className="text-xs text-muted-foreground">Create a purchase order to track items ordered from this supplier.</p>
          {canEdit && (
            <Button size="sm" variant="outline" onClick={() => setCreateOpen(true)} className="mt-1">
              <Plus size={12} className="mr-1.5" />New PO
            </Button>
          )}
        </div>
      ) : (
        <div className="rounded-lg border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="text-left px-3 py-2 font-medium text-muted-foreground whitespace-nowrap">PO Number</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground whitespace-nowrap">Status</th>
                <th className="text-right px-3 py-2 font-medium text-muted-foreground whitespace-nowrap">Amount</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground whitespace-nowrap">Expected Delivery</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground whitespace-nowrap">Created</th>
                <th className="w-12 px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {orders.map((po) => {
                const s = PO_STATUS_MAP_SUPPLIER[po.status];
                return (
                  <tr key={po.id} className="hover:bg-muted/30 transition-colors cursor-pointer" onClick={() => navigate(`/purchase-orders/${po.id}`)}>
                    <td className="px-3 py-2 font-mono text-xs font-medium text-primary hover:underline">{po.po_number_label}</td>
                    <td className="px-3 py-2">
                      <span className={cn("inline-block rounded px-1.5 py-0.5 text-xs font-medium", s?.className ?? "bg-gray-100 text-gray-600")}>
                        {s?.label ?? po.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap font-medium">
                      {po.total_amount
                        ? `${po.currency} ${parseFloat(po.total_amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                        : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground text-xs whitespace-nowrap">
                      {po.expected_delivery_date ? new Date(po.expected_delivery_date).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "—"}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground text-xs whitespace-nowrap">
                      {new Date(po.created_at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}
                    </td>
                    <td className="px-3 py-2">
                      <ArrowRight size={13} className="text-muted-foreground" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Quick create dialog */}
      <AlertDialog open={createOpen} onOpenChange={(v) => { if (!isSaving) setCreateOpen(v); }}>
        <AlertDialogContent className="max-w-lg">
          <AlertDialogHeader>
            <AlertDialogTitle>New Purchase Order</AlertDialogTitle>
          </AlertDialogHeader>
          <div className="space-y-3 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">PO Number</Label>
                <Input
                  placeholder="e.g. PO-2026-001"
                  value={poForm.po_number}
                  onChange={(e) => setPoForm((f) => ({ ...f, po_number: e.target.value }))}
                  disabled={isSaving}
                />
                <p className="text-xs text-muted-foreground">Auto-generated if blank.</p>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Status</Label>
                <select
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
                  value={poForm.status}
                  onChange={(e) => setPoForm((f) => ({ ...f, status: e.target.value }))}
                  disabled={isSaving}
                >
                  {PO_STATUSES_S.map((s) => <option key={s} value={s}>{PO_STATUS_MAP_SUPPLIER[s]?.label ?? s}</option>)}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Total Amount</Label>
                <Input
                  type="number" min="0" step="0.01" placeholder="0.00"
                  value={poForm.total_amount}
                  onChange={(e) => setPoForm((f) => ({ ...f, total_amount: e.target.value }))}
                  disabled={isSaving}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Currency</Label>
                <select
                  className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
                  value={poForm.currency}
                  onChange={(e) => setPoForm((f) => ({ ...f, currency: e.target.value }))}
                  disabled={isSaving}
                >
                  {PO_CURRENCIES_S.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Expected Delivery Date</Label>
              <Input
                type="date"
                value={poForm.expected_delivery_date}
                onChange={(e) => setPoForm((f) => ({ ...f, expected_delivery_date: e.target.value }))}
                disabled={isSaving}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Location <span className="text-destructive">*</span></Label>
              <Popover open={locOpen} onOpenChange={setLocOpen}>
                <PopoverTrigger asChild>
                  <Button variant="outline" role="combobox" disabled={isSaving} className="w-full justify-between font-normal">
                    {poForm.location_id != null
                      ? (locationOptions.find((l) => l.id === poForm.location_id)?.name ?? "Unknown location")
                      : <span className="text-muted-foreground">Select location…</span>}
                    <ChevronsUpDown size={12} className="ml-auto opacity-50" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-72 p-0" align="start">
                  <Command>
                    <CommandInput placeholder="Search locations…" />
                    <CommandList>
                      <CommandEmpty>No locations found.</CommandEmpty>
                      <CommandGroup>
                        {locationOptions.map((loc) => (
                          <CommandItem key={loc.id} value={loc.name} onSelect={() => { setPoForm((f) => ({ ...f, location_id: loc.id })); setLocOpen(false); }}>
                            <Check size={13} className={cn("mr-2", poForm.location_id === loc.id ? "opacity-100" : "opacity-0")} />
                            {loc.name}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Notes</Label>
              <Input
                placeholder="Optional notes…"
                value={poForm.notes}
                onChange={(e) => setPoForm((f) => ({ ...f, notes: e.target.value }))}
                disabled={isSaving}
              />
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isSaving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={isSaving}
              onClick={() => {
                if (poForm.location_id == null) {
                  toast({ title: "Location is required", variant: "destructive" });
                  return;
                }
                createMutation.mutate({
                  data: {
                    supplier_id: supplierId,
                    location_id: poForm.location_id,
                    po_number: poForm.po_number.trim() || null,
                    status: poForm.status,
                    currency: poForm.currency,
                    total_amount: poForm.total_amount.trim() || null,
                    expected_delivery_date: poForm.expected_delivery_date || null,
                    notes: poForm.notes.trim() || null,
                  },
                });
              }}
            >
              {isSaving ? <><Loader2 size={13} className="animate-spin mr-1.5" />Creating…</> : "Create Purchase Order"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Supplier Catalog Items Tab
// ---------------------------------------------------------------------------
type CatalogItemFormState = {
  name: string;
  supplier_item_code: string;
  unit: string;
  price: string;
  currency: string;
  category: string;
  is_active: boolean;
  base_item_id: number | null;
};

function emptyCatalogItemForm(): CatalogItemFormState {
  return { name: "", supplier_item_code: "", unit: "", price: "", currency: "AED", category: "", is_active: true, base_item_id: null };
}

function catalogItemToForm(item: SupplierCatalogItem): CatalogItemFormState {
  return {
    name: item.name,
    supplier_item_code: item.supplier_item_code ?? "",
    unit: item.unit ?? "",
    price: item.price ?? "",
    currency: item.currency ?? "AED",
    category: item.category ?? "",
    is_active: item.is_active ?? true,
    base_item_id: item.base_item_id ?? null,
  };
}

function CatalogBaseItemCombobox({
  value,
  onChange,
  disabled,
}: {
  value: number | null;
  onChange: (id: number | null) => void;
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
          className="h-9 w-full justify-between px-3 text-sm font-normal"
          disabled={disabled}
        >
          {isLoadingName ? (
            <span className="flex items-center gap-1 text-muted-foreground">
              <Loader2 size={12} className="animate-spin shrink-0" />
              <span>Loading…</span>
            </span>
          ) : (
            <span className={value != null ? "text-foreground truncate" : "text-muted-foreground"}>
              {resolvedName ?? (value != null ? `Base Item #${value}` : "Link to base item…")}
            </span>
          )}
          <ChevronsUpDown size={12} className="ml-1 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
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
                  onSelect={() => { onChange(null); setOpen(false); setSearch(""); }}
                  className="text-muted-foreground text-xs"
                >
                  — Clear link —
                </CommandItem>
              )}
              {items.map((item) => (
                <CommandItem
                  key={item.id}
                  value={String(item.id)}
                  onSelect={() => { onChange(item.id); setOpen(false); setSearch(""); }}
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

const CATALOG_ITEM_CURRENCIES = ["AED", "USD", "EUR", "GBP", "SAR", "LBP"];

function isReorderNeeded(item: SupplierCatalogItem): boolean {
  if (item.current_stock == null || item.par_level == null) return false;
  return parseFloat(item.current_stock) < parseFloat(item.par_level);
}

type InlineEditState = { itemId: number; field: "current_stock" | "par_level"; value: string };

function SupplierCatalogItemsTab({ supplierId, canEdit }: { supplierId: number; canEdit: boolean }) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const [search, setSearch] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const [showReorderOnly, setShowReorderOnly] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editItem, setEditItem] = useState<SupplierCatalogItem | null>(null);
  const [deleteItem, setDeleteItem] = useState<SupplierCatalogItem | null>(null);
  const [form, setForm] = useState<CatalogItemFormState>(emptyCatalogItemForm());
  const [inlineEdit, setInlineEdit] = useState<InlineEditState | null>(null);
  const [inlineSavingId, setInlineSavingId] = useState<number | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);

  const { data, isLoading } = useListSupplierCatalogItems(supplierId, {
    q: search || undefined,
    active_only: showInactive ? undefined : true,
    low_stock_only: showReorderOnly || undefined,
  });
  const items: SupplierCatalogItem[] = data?.catalog_items ?? [];

  const { data: allData } = useListSupplierCatalogItems(supplierId, {
    active_only: true,
    low_stock_only: true,
  });
  const reorderCount = (allData?.catalog_items ?? []).filter((i) => i.source === "standalone").length;

  const createMutation = useCreateSupplierCatalogItem({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListSupplierCatalogItemsQueryKey(supplierId) });
        setCreateOpen(false);
        setForm(emptyCatalogItemForm());
        setCodeError(null);
        toast({ title: "Catalog item created" });
      },
      onError: (err: unknown) => {
        const apiErr = err as { status?: number; data?: { error?: string } };
        if (apiErr?.status === 409) {
          setCodeError("This supplier item code is already linked to a base item for this supplier. Use a different code or remove the existing link first.");
        } else {
          toast({ title: "Failed to create", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
        }
      },
    },
  });

  const updateMutation = useUpdateSupplierCatalogItem({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListSupplierCatalogItemsQueryKey(supplierId) });
        setEditItem(null);
        toast({ title: "Catalog item updated" });
      },
      onError: (err) => {
        toast({ title: "Failed to update", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
      },
    },
  });

  const deleteMutation = useDeleteSupplierCatalogItem({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListSupplierCatalogItemsQueryKey(supplierId) });
        setDeleteItem(null);
        toast({ title: "Catalog item deleted" });
      },
      onError: (err) => {
        toast({ title: "Failed to delete", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
      },
    },
  });

  const inlineMutation = useUpdateSupplierCatalogItem({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListSupplierCatalogItemsQueryKey(supplierId) });
        setInlineEdit(null);
        setInlineSavingId(null);
      },
      onError: (err) => {
        setInlineSavingId(null);
        toast({ title: "Failed to save", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
      },
    },
  });

  function commitInlineEdit(state: InlineEditState) {
    const raw = state.value.trim();
    const num = raw === "" ? null : parseFloat(raw);
    if (raw !== "" && (num == null || isNaN(num) || num < 0)) {
      setInlineEdit(null);
      return;
    }
    setInlineSavingId(state.itemId);
    inlineMutation.mutate({
      supplierId,
      itemId: state.itemId,
      data: { [state.field]: num == null ? null : String(num) } as Parameters<typeof inlineMutation.mutate>[0]["data"],
    });
  }

  function handleCreate() {
    if (!form.name.trim()) {
      toast({ title: "Item name is required", variant: "destructive" });
      return;
    }
    createMutation.mutate({
      supplierId,
      data: {
        name: form.name.trim(),
        supplier_item_code: form.supplier_item_code.trim() || null,
        unit: form.unit.trim() || null,
        price: form.price.trim() || null,
        currency: form.currency || "AED",
        category: form.category.trim() || null,
        is_active: form.is_active,
        base_item_id: form.base_item_id,
      },
    });
  }

  function handleUpdate() {
    if (!editItem || !form.name.trim()) {
      toast({ title: "Item name is required", variant: "destructive" });
      return;
    }
    updateMutation.mutate({
      supplierId,
      itemId: editItem.id,
      data: {
        name: form.name.trim(),
        supplier_item_code: form.supplier_item_code.trim() || null,
        unit: form.unit.trim() || null,
        price: form.price.trim() || null,
        currency: form.currency || "AED",
        category: form.category.trim() || null,
        is_active: form.is_active,
        base_item_id: form.base_item_id,
      },
    });
  }

  function openEdit(item: SupplierCatalogItem) {
    setForm(catalogItemToForm(item));
    setEditItem(item);
  }

  const isFormBusy = createMutation.isPending || updateMutation.isPending;

  function CatalogItemForm({ onSubmit, submitLabel }: { onSubmit: () => void; submitLabel: string }) {
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2 space-y-1">
            <Label className="text-xs">Item Name <span className="text-destructive">*</span></Label>
            <Input
              placeholder="e.g. Floral Foam Block"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              disabled={isFormBusy}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Supplier Item Code</Label>
            <Input
              placeholder="e.g. SKU-1234"
              value={form.supplier_item_code}
              onChange={(e) => { setCodeError(null); setForm((f) => ({ ...f, supplier_item_code: e.target.value })); }}
              disabled={isFormBusy}
              className={codeError ? "border-destructive focus-visible:ring-destructive" : undefined}
            />
            {codeError && (
              <p className="text-[11px] text-destructive leading-tight">{codeError}</p>
            )}
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Category</Label>
            <Input
              placeholder="e.g. Packaging"
              value={form.category}
              onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
              disabled={isFormBusy}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Price</Label>
            <Input
              type="number"
              min="0"
              step="0.01"
              placeholder="0.00"
              value={form.price}
              onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))}
              disabled={isFormBusy}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Currency</Label>
            <select
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
              value={form.currency}
              onChange={(e) => setForm((f) => ({ ...f, currency: e.target.value }))}
              disabled={isFormBusy}
            >
              {CATALOG_ITEM_CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Unit</Label>
            <Input
              placeholder="e.g. piece, box, kg"
              value={form.unit}
              onChange={(e) => setForm((f) => ({ ...f, unit: e.target.value }))}
              disabled={isFormBusy}
            />
          </div>
          <div className="col-span-2 space-y-1">
            <Label className="text-xs">Linked Base Item <span className="text-muted-foreground">(optional)</span></Label>
            <CatalogBaseItemCombobox
              value={form.base_item_id}
              onChange={(id) => setForm((f) => ({ ...f, base_item_id: id }))}
              disabled={isFormBusy}
            />
            <p className="text-[10px] text-muted-foreground">When linked, receiving stock on a PO will automatically update this base item's inventory.</p>
          </div>
          <div className="col-span-2 flex items-center gap-2">
            <input
              type="checkbox"
              id="catalog-item-active"
              checked={form.is_active}
              onChange={(e) => setForm((f) => ({ ...f, is_active: e.target.checked }))}
              disabled={isFormBusy}
              className="h-4 w-4 accent-primary"
            />
            <Label htmlFor="catalog-item-active" className="text-xs cursor-pointer">Active (visible in PO catalog)</Label>
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="outline" size="sm" onClick={() => { setCreateOpen(false); setEditItem(null); setCodeError(null); }} disabled={isFormBusy}>Cancel</Button>
          <Button size="sm" onClick={onSubmit} disabled={isFormBusy}>
            {isFormBusy ? <><Loader2 size={13} className="animate-spin mr-1.5" />Saving…</> : submitLabel}
          </Button>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
        <Loader2 size={14} className="animate-spin" />
        Loading catalog items…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 flex-wrap flex-1">
          <div className="relative flex-1 min-w-[160px] max-w-xs">
            <Package size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search catalog items…"
              className="pl-8 h-8 text-sm"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <Button
            size="sm"
            variant={showReorderOnly ? "default" : "outline"}
            className={cn("gap-1.5 h-8 text-xs shrink-0", showReorderOnly && "bg-amber-600 hover:bg-amber-700 text-white border-amber-600")}
            onClick={() => setShowReorderOnly((v) => !v)}
          >
            <AlertTriangle size={12} />
            Reorder Needed
            {reorderCount > 0 && (
              <span className={cn(
                "ml-0.5 rounded-full px-1.5 py-0 text-[10px] font-semibold leading-5",
                showReorderOnly ? "bg-white/25 text-white" : "bg-amber-100 text-amber-700",
              )}>
                {reorderCount}
              </span>
            )}
          </Button>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={(e) => setShowInactive(e.target.checked)}
              className="h-3.5 w-3.5 accent-primary"
            />
            Show inactive
          </label>
        </div>
        {canEdit && !createOpen && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" className="gap-1.5 shrink-0">
                <Plus size={13} />
                Add Item
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <Link href="/dashboard/base-items" className="cursor-pointer">
                  <Link2 size={13} className="mr-2" />
                  Link existing base item
                </Link>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={() => { setForm(emptyCatalogItemForm()); setCodeError(null); setCreateOpen(true); setEditItem(null); }}
              >
                <ShoppingCart size={13} className="mr-2" />
                Add standalone catalog item
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {createOpen && (
        <Card className="shadow-none border-dashed">
          <CardHeader className="pb-2 pt-4 px-4">
            <CardTitle className="text-sm font-semibold">New Catalog Item</CardTitle>
          </CardHeader>
          <CardContent className="px-4 pb-4">
            <CatalogItemForm onSubmit={handleCreate} submitLabel="Create Item" />
          </CardContent>
        </Card>
      )}

      {items.length === 0 && !createOpen ? (
        <div className="rounded-lg border border-dashed border-border p-10 text-center space-y-3">
          <ShoppingBag size={26} className="mx-auto text-muted-foreground" />
          <div>
            <p className="font-medium text-sm">
              {search ? "No items match your search" : "No catalog items yet"}
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {search
                ? "Try different keywords or clear the search."
                : "Link base items from the Base Items page, or add standalone catalog items using the Add Item button."}
            </p>
          </div>
          {!search && canEdit && (
            <Button size="sm" variant="outline" onClick={() => { setForm(emptyCatalogItemForm()); setCreateOpen(true); }}>
              <Plus size={13} className="mr-1.5" />
              Add Standalone Item
            </Button>
          )}
        </div>
      ) : items.length > 0 ? (
        <>
          {items.some((i) => i.source === "linked_base_item") && !items.some((i) => i.source === "standalone") && (
            <div className="rounded-md bg-blue-50 border border-blue-200 px-3 py-2 text-xs text-blue-700 flex items-start gap-2">
              <Link2 size={13} className="shrink-0 mt-0.5" />
              <span>
                All catalog items here come from linked base items. Add standalone catalog items only for supplier products not yet mapped to a base item.
              </span>
            </div>
          )}
        <div className="rounded-lg border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="text-left px-3 py-2 font-medium text-muted-foreground text-xs">Item Name</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground text-xs">Code</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground text-xs">Category</th>
                <th className="text-right px-3 py-2 font-medium text-muted-foreground text-xs">Price</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground text-xs">Unit</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground text-xs whitespace-nowrap">Stock / Par</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground text-xs">Internal Item</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground text-xs">Status</th>
                <th className="px-3 py-2 w-24" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {items.map((item) => {
                const isLinked = item.source === "linked_base_item";
                const isEditingThis = !isLinked && editItem?.id === item.id;
                const needsReorder = !isLinked && isReorderNeeded(item);
                const stockNum = item.current_stock != null ? parseFloat(item.current_stock) : null;
                const parNum = item.par_level != null ? parseFloat(item.par_level) : null;
                const rowKey = `${item.source}-${item.id}`;
                return (
                  <tr key={rowKey} className={cn("hover:bg-muted/20 transition-colors", !item.is_active && !isLinked && "opacity-60")}>
                    {isEditingThis ? (
                      <td colSpan={9} className="px-3 py-3">
                        <CatalogItemForm onSubmit={handleUpdate} submitLabel="Save Changes" />
                      </td>
                    ) : isLinked ? (
                      <>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <p className="font-medium text-xs">{item.name}</p>
                            <span className="text-[10px] font-medium bg-blue-100 text-blue-700 rounded px-1.5 py-0.5">Internal</span>
                            {item.is_preferred && (
                              <span className="text-[10px] font-medium bg-purple-100 text-purple-700 rounded px-1.5 py-0.5">Preferred</span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{item.supplier_item_code || "—"}</td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">—</td>
                        <td className="px-3 py-2 text-right text-xs font-medium whitespace-nowrap">
                          {item.price ? `${item.currency} ${parseFloat(item.price).toFixed(2)}` : "—"}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">{item.unit || "—"}</td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">—</td>
                        <td className="px-3 py-2 text-xs">
                          {item.base_item_id != null ? (
                            <Link
                              href={`/dashboard/base-items/${item.base_item_id}`}
                              className="text-primary hover:underline truncate max-w-[140px] inline-block"
                            >
                              {item.internal_item_code ? `${item.internal_item_code} · ` : ""}{item.internal_item_name || item.base_item_name}
                            </Link>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <span className="inline-block rounded px-1.5 py-0.5 text-[10px] font-medium bg-blue-100 text-blue-700">
                            Internal
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-1">
                            {item.base_item_id != null && (
                              <Link href={`/dashboard/base-items/${item.base_item_id}`}>
                                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs gap-1">
                                  <ArrowRight size={11} />
                                  View
                                </Button>
                              </Link>
                            )}
                          </div>
                        </td>
                      </>
                    ) : (
                      <>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-1.5">
                            {needsReorder && (
                              <AlertTriangle size={12} className="text-amber-500 shrink-0" aria-label="Stock below par level — reorder needed" />
                            )}
                            <p className="font-medium text-xs">{item.name}</p>
                          </div>
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{item.supplier_item_code || "—"}</td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">{item.category || "—"}</td>
                        <td className="px-3 py-2 text-right text-xs font-medium whitespace-nowrap">
                          {item.price ? `${item.currency} ${parseFloat(item.price).toFixed(2)}` : "—"}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">{item.unit || "—"}</td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          <div className="flex items-center gap-0.5">
                            {(["current_stock", "par_level"] as const).map((field, fi) => {
                              const currentVal = field === "current_stock" ? stockNum : parNum;
                              const isActiveField = inlineEdit?.itemId === item.id && inlineEdit.field === field;
                              const isSaving = inlineSavingId === item.id;
                              return (
                                <span key={field} className="flex items-center gap-0.5">
                                  {fi === 1 && <span className="text-muted-foreground text-xs mx-0.5">/</span>}
                                  {isActiveField ? (
                                    <input
                                      autoFocus
                                      type="number"
                                      min="0"
                                      step="any"
                                      value={inlineEdit.value}
                                      onChange={(e) => setInlineEdit((s) => s ? { ...s, value: e.target.value } : s)}
                                      onKeyDown={(e) => {
                                        if (e.key === "Enter") { e.preventDefault(); commitInlineEdit(inlineEdit); }
                                        if (e.key === "Escape") { e.preventDefault(); setInlineEdit(null); }
                                      }}
                                      onBlur={() => commitInlineEdit(inlineEdit)}
                                      className="w-16 h-5 px-1 text-[10px] font-medium rounded border border-primary bg-background focus:outline-none focus:ring-1 focus:ring-primary"
                                    />
                                  ) : (
                                    <button
                                      type="button"
                                      disabled={!canEdit || isSaving || !!editItem}
                                      onClick={() => canEdit && !isSaving && !editItem && setInlineEdit({ itemId: item.id, field, value: currentVal != null ? String(currentVal) : "" })}
                                      title={canEdit ? `Click to edit ${field === "current_stock" ? "stock" : "par level"}` : undefined}
                                      className={cn(
                                        "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors",
                                        needsReorder && field === "current_stock"
                                          ? "bg-amber-50 text-amber-700 ring-1 ring-amber-200"
                                          : "bg-muted text-muted-foreground",
                                        canEdit && !isSaving && !editItem && "hover:bg-primary/10 hover:text-primary cursor-pointer",
                                        isSaving && "opacity-50 cursor-wait",
                                      )}
                                    >
                                      {isSaving ? <Loader2 size={9} className="animate-spin" /> : (currentVal != null ? currentVal.toLocaleString() : "—")}
                                    </button>
                                  )}
                                </span>
                              );
                            })}
                          </div>
                        </td>
                        <td className="px-3 py-2 text-xs">
                          {item.base_item_id != null && item.base_item_name ? (
                            <Link
                              href={`/dashboard/base-items/${item.base_item_id}`}
                              className="text-primary hover:underline truncate max-w-[120px] inline-block"
                            >
                              {item.base_item_name}
                            </Link>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <span className={cn(
                            "inline-block rounded px-1.5 py-0.5 text-[10px] font-medium",
                            item.is_active
                              ? "bg-green-100 text-green-700"
                              : "bg-gray-100 text-gray-500",
                          )}>
                            {item.is_active ? "Active" : "Inactive"}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-1">
                            <StockLogPopover supplierId={supplierId} itemId={item.id} itemName={item.name} />
                            {canEdit && (
                              <>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 w-7 p-0"
                                  onClick={() => openEdit(item)}
                                  disabled={isFormBusy}
                                >
                                  <Pencil size={13} />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-7 w-7 p-0 text-destructive hover:text-destructive"
                                  onClick={() => setDeleteItem(item)}
                                  disabled={deleteMutation.isPending}
                                >
                                  <Trash2 size={13} />
                                </Button>
                              </>
                            )}
                          </div>
                        </td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        </>
      ) : null}

      <p className="text-xs text-muted-foreground">{items.length} catalog item{items.length !== 1 ? "s" : ""}</p>

      <AlertDialog open={deleteItem !== null} onOpenChange={(v) => { if (!v) setDeleteItem(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete catalog item?</AlertDialogTitle>
            <AlertDialogDescription>
              "{deleteItem?.name}" will be permanently removed from this supplier's catalog. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteMutation.isPending}
              onClick={() => deleteItem && deleteMutation.mutate({ supplierId, itemId: deleteItem.id })}
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab types
// ---------------------------------------------------------------------------
type TabKey = "overview" | "items" | "catalog-items" | "invoices" | "statements" | "purchase-orders" | "performance" | "documents";

const TABS: { key: TabKey; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "items", label: "Linked Items" },
  { key: "catalog-items", label: "Catalog Items" },
  { key: "invoices", label: "Invoices" },
  { key: "statements", label: "Statements" },
  { key: "purchase-orders", label: "Purchase Orders" },
  { key: "performance", label: "Performance" },
  { key: "documents", label: "Documents" },
];

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export default function SupplierDetailPage() {
  const params = useParams<{ supplierId: string }>();
  const supplierId = parseInt(params.supplierId ?? "", 10);
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { isOwner, allowedPages } = useWorkspaceRole();
  const canEdit = isOwner || (allowedPages?.includes("suppliers.edit") ?? false);
  const canArchive = isOwner || (allowedPages?.includes("suppliers.delete") ?? false);

  const [activeTab, setActiveTab] = useState<TabKey>("overview");
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [archiveWarning, setArchiveWarning] = useState<{ open_po_count: number; open_invoice_count: number } | null>(null);
  const [forceArchivePending, setForceArchivePending] = useState(false);

  const { data, isLoading, isError } = useGetSupplier(supplierId, {
    query: {
      queryKey: getGetSupplierQueryKey(supplierId),
      enabled: !isNaN(supplierId),
    },
  });

  const supplier = data?.supplier;

  const patchMutation = usePatchSupplier({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListSuppliersQueryKey() });
        qc.invalidateQueries({ queryKey: getGetSupplierQueryKey(supplierId) });
        toast({ title: "Supplier updated" });
        setEditModalOpen(false);
      },
      onError: (err) => {
        toast({ title: "Failed to save supplier", description: err instanceof Error ? err.message : "Unknown error", variant: "destructive" });
      },
    },
  });

  const archiveMutation = useDeleteSupplier({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListSuppliersQueryKey() });
        qc.invalidateQueries({ queryKey: getGetSupplierQueryKey(supplierId) });
        toast({ title: "Supplier archived" });
        setArchiveDialogOpen(false);
        setDeleteDialogOpen(false);
        navigate("/suppliers");
      },
      onError: (err: unknown) => {
        const apiErr = err as { status?: number; data?: { requires_confirmation?: boolean; open_po_count?: number; open_invoice_count?: number } };
        if (apiErr?.status === 409 && apiErr?.data?.requires_confirmation) {
          setArchiveDialogOpen(false);
          setDeleteDialogOpen(false);
          setArchiveWarning({
            open_po_count: apiErr.data.open_po_count ?? 0,
            open_invoice_count: apiErr.data.open_invoice_count ?? 0,
          });
          return;
        }
        toast({
          title: "Failed to archive",
          description: err instanceof Error ? err.message : undefined,
          variant: "destructive",
        });
      },
    },
  });

  async function handleForceArchive() {
    setForceArchivePending(true);
    try {
      const res = await fetch(`/api/suppliers/${supplierId}?force=true`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      await qc.invalidateQueries({ queryKey: getListSuppliersQueryKey() });
      await qc.invalidateQueries({ queryKey: getGetSupplierQueryKey(supplierId) });
      toast({ title: "Supplier archived" });
      setArchiveWarning(null);
      navigate("/suppliers");
    } catch (err) {
      toast({ title: "Failed to archive supplier", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    } finally {
      setForceArchivePending(false);
    }
  }

  const handleEditSave = useCallback((form: SupplierFormState) => {
    patchMutation.mutate({
      id: supplierId,
      data: buildSupplierPayload(form) as Parameters<typeof patchMutation.mutate>[0]["data"],
    });
  }, [supplierId, patchMutation]);

  if (isNaN(supplierId)) {
    return (
      <div className="space-y-4">
        <Link href="/suppliers"><Button variant="ghost" size="sm" className="gap-1.5"><ArrowLeft size={14} />Suppliers</Button></Link>
        <p className="text-destructive text-sm">Invalid supplier ID.</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
        <Loader2 size={16} className="animate-spin" />
        Loading supplier…
      </div>
    );
  }

  if (isError || !supplier) {
    return (
      <div className="space-y-4">
        <Link href="/suppliers"><Button variant="ghost" size="sm" className="gap-1.5"><ArrowLeft size={14} />Suppliers</Button></Link>
        <p className="text-destructive text-sm">Supplier not found.</p>
      </div>
    );
  }

  const displayName = supplier.display_name || supplier.name;
  const countryMeta = supplier.country ? getCountryMetadata(supplier.country) : null;
  const initials = supplierInitials(displayName);

  const tabsWithCounts = TABS.map((t) => ({
    ...t,
    label: t.key === "items" && supplier.item_count != null
      ? `Linked Items (${supplier.item_count})`
      : t.key === "invoices" && supplier.invoice_count != null && supplier.invoice_count > 0
        ? `Invoices (${supplier.invoice_count})`
        : t.label,
  }));

  return (
    <div className="space-y-0">
      {/* Breadcrumb */}
      <nav className="flex items-center gap-1.5 text-sm text-muted-foreground mb-5">
        <Link href="/suppliers" className="hover:text-foreground transition-colors">Suppliers</Link>
        <span>/</span>
        <span className="text-foreground font-medium truncate">{displayName}</span>
      </nav>

      {/* Page header */}
      <div className="flex items-start gap-4 mb-6">
        <div className="h-14 w-14 rounded-xl bg-primary/10 flex items-center justify-center text-primary text-lg font-bold shrink-0">
          {initials}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-2xl font-bold tracking-tight">{displayName}</h1>
            {supplier.is_archived ? (
              <Badge variant="secondary">Archived</Badge>
            ) : (
              <Badge className="bg-green-600 hover:bg-green-700">Active</Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">
            {supplier.display_name && supplier.display_name !== supplier.name
              ? supplier.name
              : ""}
            {supplier.display_name && supplier.display_name !== supplier.name && countryMeta ? " · " : ""}
            {countryMeta ? `${countryMeta.flagEmoji} ${countryMeta.name}` : ""}
          </p>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 shrink-0">
          <Button variant="outline" size="sm" onClick={() => navigate("/suppliers")} className="gap-1.5">
            <ArrowLeft size={14} />
            Back
          </Button>
          {canEdit && (
            <Button variant="outline" size="sm" onClick={() => setEditModalOpen(true)} className="gap-1.5">
              <Pencil size={13} />
              Edit
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="h-8 w-8 p-0">
                <ShoppingBag size={15} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {canArchive && !supplier.is_archived && (
                <DropdownMenuItem onClick={() => setArchiveDialogOpen(true)} className="gap-2 text-muted-foreground">
                  <Archive size={14} />
                  Archive supplier
                </DropdownMenuItem>
              )}
              {canArchive && supplier.is_archived && (
                <DropdownMenuItem onClick={() => patchMutation.mutate({ id: supplierId, data: { is_archived: false } })} className="gap-2">
                  <CheckCircle2 size={14} />
                  Restore supplier
                </DropdownMenuItem>
              )}
              {canArchive && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setDeleteDialogOpen(true)} className="gap-2 text-destructive focus:text-destructive">
                    <Trash2 size={14} />
                    Delete supplier
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-3 mb-6">
        <KpiCard icon={Link2} label="Linked Items" value={supplier.item_count ?? 0} />
        <KpiCard icon={CreditCard} label="Invoices" value={supplier.invoice_count ?? 0} muted={!supplier.invoice_count} />
        <KpiCard
          icon={TrendingUp}
          label="Spend YTD"
          value={
            supplier.spend_ytd && parseFloat(supplier.spend_ytd) > 0
              ? `${supplier.spend_ytd_currency ?? ""} ${parseFloat(supplier.spend_ytd).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`.trim()
              : "—"
          }
          muted={!supplier.spend_ytd || parseFloat(supplier.spend_ytd) === 0}
        />
        <KpiCard
          icon={CheckCircle2}
          label="Paid / Outstanding"
          value={
            (supplier.paid_count ?? 0) > 0 || (supplier.outstanding_count ?? 0) > 0
              ? `${supplier.paid_count ?? 0} paid / ${supplier.outstanding_count ?? 0} outstanding`
              : "—"
          }
          muted={(supplier.paid_count ?? 0) === 0 && (supplier.outstanding_count ?? 0) === 0}
        />
        <KpiCard icon={CheckCircle2} label="On-time Delivery" value="Not tracked" muted />
        <KpiCard
          icon={Clock}
          label="Avg Lead Time"
          value={supplier.lead_time_days != null ? `${supplier.lead_time_days} days` : "Not set"}
          muted={supplier.lead_time_days == null}
        />
        <KpiCard
          icon={CreditCard}
          label="Payment Terms"
          value={supplier.payment_terms || "Not set"}
          muted={!supplier.payment_terms}
        />
      </div>

      {/* Tab bar */}
      <div className="border-b border-border mb-6">
        <div className="flex gap-0 overflow-x-auto">
          {tabsWithCounts.map((tab) => (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                activeTab === tab.key
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      {activeTab === "overview" && (
        <OverviewTab
          supplier={supplier}
          supplierId={supplierId}
          canEdit={canEdit}
          onEditNotes={() => setEditModalOpen(true)}
        />
      )}
      {activeTab === "items" && <SupplierItemsTab supplierId={supplierId} />}
      {activeTab === "catalog-items" && <SupplierCatalogItemsTab supplierId={supplierId} canEdit={canEdit} />}
      {activeTab === "invoices" && (
        <SupplierInvoicesTab
          supplierId={supplierId}
          canEdit={canEdit}
          currencyPref={supplier.currency_pref}
          supplierVatStatus={(supplier as { vat_status?: "registered" | "not_registered" | "unknown" | null }).vat_status}
        />
      )}
      {activeTab === "statements" && (
        <StatementsTab
          supplierId={supplierId}
          canEdit={canEdit}
          currencyPref={supplier.currency_pref}
        />
      )}
      {activeTab === "purchase-orders" && (
        <SupplierPurchaseOrdersTab supplierId={supplierId} canEdit={canEdit} />
      )}
      {activeTab === "performance" && (
        <PerformanceTab supplierId={supplierId} />
      )}
      {activeTab === "documents" && <DocumentsTab supplierId={supplierId} canEdit={canEdit} />}

      {/* Edit modal */}
      <SupplierFormModal
        open={editModalOpen}
        onClose={() => setEditModalOpen(false)}
        initial={supplierToFormModal(supplier)}
        onSave={handleEditSave}
        isPending={patchMutation.isPending}
        title="Edit Supplier"
      />

      {/* Archive dialog */}
      <AlertDialog open={archiveDialogOpen} onOpenChange={setArchiveDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive supplier?</AlertDialogTitle>
            <AlertDialogDescription>
              "{displayName}" will be archived and hidden from the supplier dropdown on base items. You can restore it later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={archiveMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={archiveMutation.isPending} onClick={() => archiveMutation.mutate({ id: supplierId })}>
              {archiveMutation.isPending ? "Archiving…" : "Archive"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Archive warning — open POs / invoices */}
      <AlertDialog open={archiveWarning !== null} onOpenChange={(v) => { if (!v) setArchiveWarning(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertCircle size={18} className="text-amber-500 shrink-0" />
              Supplier has open records
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>
                  <strong>"{displayName}"</strong> has open records that will remain in the system after archiving:
                </p>
                <ul className="list-disc list-inside space-y-1 text-sm">
                  {(archiveWarning?.open_po_count ?? 0) > 0 && (
                    <li>
                      <strong>{archiveWarning!.open_po_count}</strong> open purchase order{archiveWarning!.open_po_count !== 1 ? "s" : ""}
                    </li>
                  )}
                  {(archiveWarning?.open_invoice_count ?? 0) > 0 && (
                    <li>
                      <strong>{archiveWarning!.open_invoice_count}</strong> outstanding invoice{archiveWarning!.open_invoice_count !== 1 ? "s" : ""}
                    </li>
                  )}
                </ul>
                <p className="text-xs text-muted-foreground">
                  These records will not be deleted, but you should resolve them before archiving. You can restore the supplier later.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={forceArchivePending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={forceArchivePending}
              onClick={handleForceArchive}
            >
              {forceArchivePending ? "Archiving…" : "Archive anyway"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete dialog */}
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete supplier?</AlertDialogTitle>
            <AlertDialogDescription>
              This will archive "{displayName}". You can restore it from the suppliers list. A permanent delete is not available.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={archiveMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={archiveMutation.isPending} onClick={() => archiveMutation.mutate({ id: supplierId })}>
              {archiveMutation.isPending ? "Archiving…" : "Archive & Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
