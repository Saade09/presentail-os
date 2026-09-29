import { useState, useRef, useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  FileText,
  Loader2,
  Plus,
  Sparkles,
  UploadCloud,
  X,
  Link2,
  ShoppingCart,
  Shield,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { imageUrl } from "@/lib/imageUrl";
import { getClerkToken } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import {
  useCreateSupplierInvoice,
  useUpdateSupplierInvoice,
  getListSupplierInvoicesQueryKey,
  getGetSupplierQueryKey,
  useListBaseItems,
  useListPurchaseOrders,
  checkSupplierInvoiceDuplicate,
} from "@workspace/api-client-react";
import type { SupplierInvoice, BaseItemListItem, PurchaseOrder } from "@workspace/api-client-react";

import { useQueryClient } from "@tanstack/react-query";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Check, ChevronsUpDown } from "lucide-react";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type LineItem = {
  description: string;
  quantity: number;
  unit_price: number;
  total: number;
  tax_rate?: number;
};

type ExtractionResult = {
  vendor_name: string | null;
  vendor_tax_number: string | null;
  vendor_address: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  currency: string | null;
  subtotal: number | null;
  discount: number | null;
  tax_amount: number | null;
  total_amount: number | null;
  line_items: LineItem[];
  confidence: number;
  company_validation_status: string | null;
  company_validation_notes: string | null;
};

type ExtractResponse = {
  fileUrl: string;
  fileName: string;
  fileSizeBytes: number;
  mimeType: string;
  extraction: ExtractionResult;
  fieldsDetected: number;
};

type DuplicateMatch = {
  id: number;
  invoiceNumber: string | null;
  amount: string;
  currency: string;
  issuedAt: string;
  status: string;
  reason: string;
};

type POSuggestion = {
  id: number;
  label: string;
  amount: string;
  currency: string;
  status: string;
};

type ReviewForm = {
  invoiceNumber: string;
  issuedAt: string;
  dueDate: string;
  amount: string;
  currency: string;
  status: string;
  vatAmount: string;
  subtotal: string;
  discount: string;
  paymentTerms: string;
  paidAt: string;
  notes: string;
  referenceType: string;
  referenceId: number | null;
  lineItems: LineItem[];
};

const INVOICE_CURRENCIES = ["AED", "USD", "EUR", "GBP", "SAR", "LBP"];
const INVOICE_STATUSES = ["draft", "issued", "paid", "overdue", "cancelled"];

function emptyForm(currencyPref?: string | null): ReviewForm {
  const today = new Date().toISOString().slice(0, 10);
  return {
    invoiceNumber: "",
    issuedAt: today,
    dueDate: "",
    amount: "",
    currency: currencyPref ?? "AED",
    status: "issued",
    vatAmount: "",
    subtotal: "",
    discount: "",
    paymentTerms: "",
    paidAt: "",
    notes: "",
    referenceType: "",
    referenceId: null,
    lineItems: [],
  };
}

function extractionToForm(ex: ExtractionResult, currencyPref?: string | null): ReviewForm {
  const vendorNote = ex.vendor_address ? `Vendor address: ${ex.vendor_address}` : "";
  return {
    invoiceNumber: ex.invoice_number ?? "",
    issuedAt: ex.invoice_date ?? new Date().toISOString().slice(0, 10),
    dueDate: ex.due_date ?? "",
    amount: ex.total_amount != null ? String(ex.total_amount) : "",
    currency: ex.currency ?? currencyPref ?? "AED",
    status: "issued",
    vatAmount: ex.tax_amount != null ? String(ex.tax_amount) : "",
    subtotal: ex.subtotal != null ? String(ex.subtotal) : "",
    discount: ex.discount != null ? String(ex.discount) : "",
    paymentTerms: "",
    paidAt: "",
    notes: vendorNote,
    referenceType: "",
    referenceId: null,
    lineItems: (ex.line_items ?? []).map((li) => ({
      description: li.description,
      quantity: li.quantity,
      unit_price: li.unit_price,
      total: li.total,
      tax_rate: li.tax_rate ?? undefined,
    })),
  };
}

function invoiceToForm(inv: SupplierInvoice, currencyPref?: string | null): ReviewForm {
  return {
    invoiceNumber: inv.invoice_number ?? "",
    issuedAt: inv.issued_at ? inv.issued_at.slice(0, 10) : new Date().toISOString().slice(0, 10),
    dueDate: inv.due_date?.slice(0, 10) ?? "",
    amount: inv.amount,
    currency: inv.currency ?? currencyPref ?? "AED",
    status: inv.status,
    vatAmount: inv.vat_amount ?? "",
    subtotal: inv.subtotal ?? "",
    discount: inv.discount ?? "",
    paymentTerms: inv.payment_terms ?? "",
    paidAt: inv.paid_at ? inv.paid_at.slice(0, 10) : "",
    notes: inv.notes ?? "",
    referenceType: inv.reference_type ?? "",
    referenceId: inv.reference_id ?? null,
    lineItems: (inv.line_items ?? []).map((li) => ({
      description: li.description,
      quantity: li.quantity,
      unit_price: li.unit_price,
      total: li.total,
      tax_rate: li.tax_rate ?? undefined,
    })),
  };
}

function formHasChanges(form: ReviewForm, currencyPref?: string | null): boolean {
  const blank = emptyForm(currencyPref);
  return (
    form.invoiceNumber !== blank.invoiceNumber ||
    form.amount !== blank.amount ||
    form.lineItems.length > 0 ||
    form.notes !== blank.notes
  );
}

// ---------------------------------------------------------------------------
// Confidence badge
// ---------------------------------------------------------------------------
function ConfidenceBadge({ confidence }: { confidence: number }) {
  const pct = Math.round(confidence * 100);
  const color =
    pct >= 80
      ? "bg-green-100 text-green-700"
      : pct >= 60
      ? "bg-yellow-100 text-yellow-700"
      : "bg-red-100 text-red-700";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium",
        color,
      )}
    >
      <Sparkles size={11} />
      {pct}% confidence
    </span>
  );
}

// ---------------------------------------------------------------------------
// Document viewer (left panel in review step)
// ---------------------------------------------------------------------------
function DocumentViewer({
  fileUrl,
  mimeType,
  fileName,
}: {
  fileUrl: string;
  mimeType: string;
  fileName: string;
}) {
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(false);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    let revoked = false;
    let localObjectUrl: string | null = null;
    (async () => {
      try {
        const resolvedUrl = imageUrl(fileUrl) ?? fileUrl;
        const token = await getClerkToken();
        const resp = await fetch(resolvedUrl, {
          credentials: "include",
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!resp.ok) throw new Error("Failed to load document");
        const blob = await resp.blob();
        if (!revoked) {
          localObjectUrl = URL.createObjectURL(blob);
          setObjectUrl(localObjectUrl);
          setIsLoading(false);
        }
      } catch {
        if (!revoked) {
          setError(true);
          setIsLoading(false);
        }
      }
    })();
    return () => {
      revoked = true;
      if (localObjectUrl) URL.revokeObjectURL(localObjectUrl);
    };
  }, [fileUrl]);

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2">
        <Loader2 size={20} className="animate-spin" />
        <span className="text-xs">Loading document…</span>
      </div>
    );
  }
  if (error || !objectUrl) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground gap-2">
        <FileText size={28} />
        <span className="text-xs">{fileName}</span>
        <span className="text-xs text-destructive">Could not preview document</span>
      </div>
    );
  }
  if (mimeType === "application/pdf") {
    return (
      <iframe
        src={objectUrl}
        className="w-full h-full rounded border-0"
        title={fileName}
      />
    );
  }
  return (
    <img
      src={objectUrl}
      alt={fileName}
      className="w-full h-full object-contain rounded"
    />
  );
}

// ---------------------------------------------------------------------------
// Line items editor
// ---------------------------------------------------------------------------
function LineItemsEditor({
  items,
  onChange,
  disabled,
}: {
  items: LineItem[];
  onChange: (items: LineItem[]) => void;
  disabled?: boolean;
}) {
  function addRow() {
    onChange([...items, { description: "", quantity: 1, unit_price: 0, total: 0 }]);
  }
  function removeRow(i: number) {
    onChange(items.filter((_, idx) => idx !== i));
  }
  function updateRow(i: number, field: keyof LineItem, value: string | number) {
    const updated = items.map((row, idx) => {
      if (idx !== i) return row;
      const next = { ...row, [field]: value };
      if (field === "quantity" || field === "unit_price") {
        next.total = Math.round(Number(next.quantity) * Number(next.unit_price) * 100) / 100;
      }
      return next;
    });
    onChange(updated);
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label className="text-xs font-medium">Line Items</Label>
        {!disabled && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-6 text-xs px-2"
            onClick={addRow}
          >
            <Plus size={12} className="mr-1" /> Add row
          </Button>
        )}
      </div>
      {items.length > 0 && (
        <div className="rounded border border-border overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b bg-muted/40">
                <th className="text-left px-2 py-1.5 font-medium text-muted-foreground">
                  Description
                </th>
                <th className="text-right px-2 py-1.5 font-medium text-muted-foreground w-16">
                  Qty
                </th>
                <th className="text-right px-2 py-1.5 font-medium text-muted-foreground w-20">
                  Unit price
                </th>
                <th className="text-right px-2 py-1.5 font-medium text-muted-foreground w-20">
                  Total
                </th>
                {!disabled && <th className="w-8 px-1" />}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {items.map((row, i) => (
                <tr key={i}>
                  <td className="px-2 py-1">
                    {disabled ? (
                      <span>{row.description}</span>
                    ) : (
                      <Input
                        value={row.description}
                        onChange={(e) => updateRow(i, "description", e.target.value)}
                        className="h-7 text-xs"
                        placeholder="Description"
                      />
                    )}
                  </td>
                  <td className="px-2 py-1 text-right">
                    {disabled ? (
                      <span>{row.quantity}</span>
                    ) : (
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        value={row.quantity}
                        onChange={(e) =>
                          updateRow(i, "quantity", parseFloat(e.target.value) || 0)
                        }
                        className="h-7 text-xs text-right w-16"
                      />
                    )}
                  </td>
                  <td className="px-2 py-1 text-right">
                    {disabled ? (
                      <span>{row.unit_price}</span>
                    ) : (
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        value={row.unit_price}
                        onChange={(e) =>
                          updateRow(i, "unit_price", parseFloat(e.target.value) || 0)
                        }
                        className="h-7 text-xs text-right w-20"
                      />
                    )}
                  </td>
                  <td className="px-2 py-1 text-right">
                    {disabled ? (
                      <span>{row.total.toFixed(2)}</span>
                    ) : (
                      <Input
                        type="number"
                        min="0"
                        step="0.01"
                        value={row.total}
                        onChange={(e) =>
                          updateRow(i, "total", parseFloat(e.target.value) || 0)
                        }
                        className="h-7 text-xs text-right w-20"
                      />
                    )}
                  </td>
                  {!disabled && (
                    <td className="px-1 py-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                        onClick={() => removeRow(i)}
                      >
                        <X size={12} />
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
            {items.length > 1 && (
              <tfoot>
                <tr className="border-t bg-muted/20">
                  <td
                    colSpan={disabled ? 3 : 3}
                    className="px-2 py-1.5 text-xs font-medium text-right"
                  >
                    Line item total
                  </td>
                  <td className="px-2 py-1.5 text-right text-xs font-semibold">
                    {items.reduce((s, r) => s + r.total, 0).toFixed(2)}
                  </td>
                  {!disabled && <td />}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PO Combobox
// ---------------------------------------------------------------------------
function POCombobox({
  supplierId,
  value,
  onChange,
  disabled,
}: {
  supplierId: number;
  value: number | null;
  onChange: (id: number | null) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { data } = useListPurchaseOrders({ supplier_id: supplierId });
  const orders: PurchaseOrder[] = data?.purchase_orders ?? [];
  const selected = value != null ? orders.find((o) => o.id === value) ?? null : null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          type="button"
          disabled={disabled}
          className="w-full justify-between font-normal h-9 px-3 text-sm"
        >
          <span className={value != null ? "text-foreground" : "text-muted-foreground"}>
            {selected
              ? selected.po_number_label ?? `PO #${selected.id}`
              : value != null
              ? `PO #${value}`
              : "Select purchase order…"}
          </span>
          <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search POs…" />
          <CommandList>
            <CommandEmpty>No purchase orders found.</CommandEmpty>
            <CommandGroup>
              {value != null && (
                <CommandItem
                  value=""
                  onSelect={() => {
                    onChange(null);
                    setOpen(false);
                  }}
                  className="text-muted-foreground"
                >
                  — Clear —
                </CommandItem>
              )}
              {orders.map((po) => (
                <CommandItem
                  key={po.id}
                  value={String(po.id)}
                  onSelect={() => {
                    onChange(po.id);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      "mr-2 size-4",
                      value === po.id ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <span className="font-mono text-xs">
                    {po.po_number_label ?? `PO-${String(po.id).padStart(4, "0")}`}
                  </span>
                  <span className="ml-1.5 text-xs text-muted-foreground">{po.status}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Base item combobox
// ---------------------------------------------------------------------------
function BaseItemCombobox({
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
  const { data } = useListBaseItems({ q: search || undefined, limit: 50 });
  const items: BaseItemListItem[] = data?.items ?? [];
  const selected = value != null ? items.find((i) => i.id === value) ?? null : null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          type="button"
          disabled={disabled}
          className="w-full justify-between font-normal h-9 px-3 text-sm"
        >
          <span className={value != null ? "text-foreground" : "text-muted-foreground"}>
            {selected
              ? selected.name
              : value != null
              ? `Base Item #${value}`
              : "Select base item…"}
          </span>
          <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search base items…"
            value={search}
            onValueChange={setSearch}
          />
          <CommandList>
            <CommandEmpty>No base items found.</CommandEmpty>
            <CommandGroup>
              {value != null && (
                <CommandItem
                  value=""
                  onSelect={() => {
                    onChange(null);
                    setOpen(false);
                  }}
                  className="text-muted-foreground"
                >
                  — Clear —
                </CommandItem>
              )}
              {items.map((item) => (
                <CommandItem
                  key={item.id}
                  value={String(item.id)}
                  onSelect={() => {
                    onChange(item.id);
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn(
                      "mr-2 size-4",
                      value === item.id ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <span className="truncate">{item.name}</span>
                  <span className="ml-1.5 font-mono text-xs text-muted-foreground shrink-0">
                    {item.code}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Totals reconciliation helper
// ---------------------------------------------------------------------------
function TotalsReconciliation({ form }: { form: ReviewForm }) {
  const lineTotal = form.lineItems.reduce((s, r) => s + r.total, 0);
  const invoiceTotal = parseFloat(form.amount) || 0;
  if (form.lineItems.length === 0 || !form.amount) return null;

  const variance = Math.abs(lineTotal - invoiceTotal);
  const threshold = invoiceTotal * 0.01; // 1% tolerance
  if (variance <= threshold) return null;

  return (
    <div className="flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-700">
      <AlertTriangle size={13} className="mt-0.5 shrink-0" />
      <span>
        Line item total ({lineTotal.toFixed(2)}) doesn't match invoice total ({invoiceTotal.toFixed(2)}).
        Variance: {variance.toFixed(2)} {form.currency}.
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Review form (Step 2)
// ---------------------------------------------------------------------------
function ReviewFormPanel({
  form,
  setForm,
  supplierId,
  disabled,
  poSuggestion,
}: {
  form: ReviewForm;
  setForm: (fn: (f: ReviewForm) => ReviewForm) => void;
  supplierId: number;
  disabled?: boolean;
  poSuggestion?: POSuggestion | null;
}) {
  const { t } = useTranslation();
  const [paidDateClearedNotice, setPaidDateClearedNotice] = useState(false);

  function set<K extends keyof ReviewForm>(key: K, value: ReviewForm[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function handleStatusChange(newStatus: string) {
    setForm((f) => {
      const updates: Partial<ReviewForm> = { status: newStatus };
      if (f.paidAt && newStatus !== "paid") {
        updates.paidAt = "";
        setPaidDateClearedNotice(true);
      } else {
        setPaidDateClearedNotice(false);
      }
      return { ...f, ...updates };
    });
  }

  return (
    <div className="space-y-3">
      {/* PO auto-match suggestion */}
      {poSuggestion != null && form.referenceType === "" && (
        <div className="flex items-start gap-2 rounded-lg bg-sky-50 border border-sky-200 px-3 py-2 text-xs text-sky-700">
          <ShoppingCart size={13} className="mt-0.5 shrink-0" />
          <div>
            <span className="font-medium">Suggested PO match: {poSuggestion.label}</span>
            <span className="text-muted-foreground ml-1">
              ({poSuggestion.currency} {parseFloat(poSuggestion.amount).toFixed(2)},
              {" "}
              {poSuggestion.status})
            </span>
            <button
              type="button"
              className="ml-2 underline font-medium"
              onClick={() =>
                setForm((f) => ({ ...f, referenceType: "purchase_order", referenceId: poSuggestion.id }))
              }
              disabled={disabled}
            >
              Link →
            </button>
          </div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-xs">Invoice Number</Label>
          <Input
            value={form.invoiceNumber}
            onChange={(e) => set("invoiceNumber", e.target.value)}
            placeholder="INV-001"
            disabled={disabled}
            className="h-8 text-sm"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Status *</Label>
          <select
            className="flex h-8 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
            value={form.status}
            onChange={(e) => handleStatusChange(e.target.value)}
            disabled={disabled}
          >
            {INVOICE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-xs">Issue Date *</Label>
          <Input
            type="date"
            value={form.issuedAt}
            onChange={(e) => set("issuedAt", e.target.value)}
            disabled={disabled}
            className="h-8 text-sm"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Due Date</Label>
          <Input
            type="date"
            value={form.dueDate}
            onChange={(e) => set("dueDate", e.target.value)}
            disabled={disabled}
            className="h-8 text-sm"
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-xs">Amount *</Label>
          <Input
            type="number"
            min="0"
            step="0.01"
            value={form.amount}
            onChange={(e) => set("amount", e.target.value)}
            disabled={disabled}
            placeholder="0.00"
            className="h-8 text-sm"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">Currency *</Label>
          <select
            className="flex h-8 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
            value={form.currency}
            onChange={(e) => set("currency", e.target.value)}
            disabled={disabled}
          >
            {INVOICE_CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-xs">{t("supplierInvoices.addInvoice.subtotal")}</Label>
          <Input
            type="number"
            min="0"
            step="0.01"
            value={form.subtotal}
            onChange={(e) => set("subtotal", e.target.value)}
            disabled={disabled}
            placeholder="0.00"
            className="h-8 text-sm"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t("supplierInvoices.addInvoice.discount")}</Label>
          <Input
            type="number"
            min="0"
            step="0.01"
            value={form.discount}
            onChange={(e) => set("discount", e.target.value)}
            disabled={disabled}
            placeholder="0.00"
            className="h-8 text-sm"
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-xs">VAT / Tax Amount</Label>
          <Input
            type="number"
            min="0"
            step="0.01"
            value={form.vatAmount}
            onChange={(e) => set("vatAmount", e.target.value)}
            disabled={disabled}
            placeholder="0.00"
            className="h-8 text-sm"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t("supplierInvoices.addInvoice.paymentTerms")}</Label>
          <Input
            value={form.paymentTerms}
            onChange={(e) => set("paymentTerms", e.target.value)}
            disabled={disabled}
            placeholder={t("supplierInvoices.addInvoice.paymentTermsPlaceholder")}
            className="h-8 text-sm"
          />
        </div>
      </div>
      {form.status === "paid" && (
        <div className="space-y-1">
          <Label className="text-xs">{t("supplierInvoices.addInvoice.paidOn")}</Label>
          <Input
            type="date"
            value={form.paidAt}
            onChange={(e) => {
              set("paidAt", e.target.value);
              setPaidDateClearedNotice(false);
            }}
            disabled={disabled}
            className="h-8 text-sm"
          />
        </div>
      )}
      {paidDateClearedNotice && (
        <p className="text-xs text-muted-foreground">
          {t("supplierInvoices.addInvoice.paidDateCleared")}
        </p>
      )}
      <div className="space-y-1">
        <Label className="text-xs">Notes</Label>
        <Input
          value={form.notes}
          onChange={(e) => set("notes", e.target.value)}
          disabled={disabled}
          placeholder="Optional notes…"
          className="h-8 text-sm"
        />
      </div>

      <div className="space-y-1">
        <Label className="text-xs">Link to…</Label>
        <div className="flex items-center gap-2">
          <select
            className="flex h-8 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50 shrink-0"
            value={form.referenceType}
            onChange={(e) =>
              setForm((f) => ({ ...f, referenceType: e.target.value, referenceId: null }))
            }
            disabled={disabled}
          >
            <option value="">None</option>
            <option value="base_item">Base Item</option>
            <option value="purchase_order">Purchase Order</option>
          </select>
          {form.referenceType === "base_item" && (
            <div className="flex-1">
              <BaseItemCombobox
                value={form.referenceId}
                onChange={(id) => set("referenceId", id)}
                disabled={disabled}
              />
            </div>
          )}
          {form.referenceType === "purchase_order" && (
            <div className="flex-1">
              <POCombobox
                supplierId={supplierId}
                value={form.referenceId}
                onChange={(id) => set("referenceId", id)}
                disabled={disabled}
              />
            </div>
          )}
        </div>
      </div>

      <TotalsReconciliation form={form} />

      <LineItemsEditor
        items={form.lineItems}
        onChange={(items) => set("lineItems", items)}
        disabled={disabled}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — Confirmation Summary
// ---------------------------------------------------------------------------
function ConfirmationSummary({
  form,
  extractResult,
  duplicates,
  overrideDuplicates,
  onOverrideChange,
  isOwner,
}: {
  form: ReviewForm;
  extractResult: ExtractResponse | null;
  duplicates: DuplicateMatch[];
  overrideDuplicates: boolean;
  onOverrideChange: (v: boolean) => void;
  isOwner: boolean;
}) {
  const { t } = useTranslation();
  const lineTotal = form.lineItems.reduce((s, r) => s + r.total, 0);
  const invoiceTotal = parseFloat(form.amount) || 0;
  const hasVariance =
    form.lineItems.length > 0 &&
    form.amount &&
    Math.abs(lineTotal - invoiceTotal) > invoiceTotal * 0.01;

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-medium">Review before saving</h3>

      {/* Key details */}
      <div className="rounded-lg border border-border divide-y divide-border text-sm">
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-muted-foreground">Invoice number</span>
          <span className="font-mono">{form.invoiceNumber || "—"}</span>
        </div>
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-muted-foreground">Amount</span>
          <span className="font-semibold">
            {form.currency} {form.amount ? parseFloat(form.amount).toFixed(2) : "—"}
          </span>
        </div>
        {form.subtotal && parseFloat(form.subtotal) > 0 && (
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-muted-foreground">{t("supplierInvoices.addInvoice.subtotal")}</span>
            <span>
              {form.currency} {parseFloat(form.subtotal).toFixed(2)}
            </span>
          </div>
        )}
        {form.discount && parseFloat(form.discount) > 0 && (
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-muted-foreground">{t("supplierInvoices.addInvoice.discount")}</span>
            <span>
              {form.currency} {parseFloat(form.discount).toFixed(2)}
            </span>
          </div>
        )}
        {form.vatAmount && parseFloat(form.vatAmount) > 0 && (
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-muted-foreground">VAT / Tax</span>
            <span>
              {form.currency} {parseFloat(form.vatAmount).toFixed(2)}
            </span>
          </div>
        )}
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-muted-foreground">Status</span>
          <span className="capitalize">{form.status}</span>
        </div>
        <div className="flex items-center justify-between px-3 py-2">
          <span className="text-muted-foreground">Issue date</span>
          <span>{form.issuedAt}</span>
        </div>
        {form.dueDate && (
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-muted-foreground">Due date</span>
            <span>{form.dueDate}</span>
          </div>
        )}
        {form.paidAt && form.status === "paid" && (
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-muted-foreground">{t("supplierInvoices.addInvoice.paidOn")}</span>
            <span>{form.paidAt}</span>
          </div>
        )}
        {form.paymentTerms && (
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-muted-foreground">{t("supplierInvoices.addInvoice.paymentTerms")}</span>
            <span>{form.paymentTerms}</span>
          </div>
        )}
        {form.lineItems.length > 0 && (
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-muted-foreground">Line items</span>
            <span>
              {form.lineItems.length} item{form.lineItems.length !== 1 ? "s" : ""}
              {" · "}
              {form.currency} {lineTotal.toFixed(2)}
            </span>
          </div>
        )}
        {form.referenceType && form.referenceId != null && (
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-muted-foreground">Linked to</span>
            <span className="flex items-center gap-1">
              <Link2 size={12} />
              {form.referenceType === "purchase_order" ? "Purchase order" : "Base item"} #
              {form.referenceId}
            </span>
          </div>
        )}
        {extractResult && (
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-muted-foreground">Document</span>
            <span className="text-xs truncate max-w-[200px]">{extractResult.fileName}</span>
          </div>
        )}
      </div>

      {/* Totals reconciliation warning in summary */}
      {hasVariance && (
        <div className="flex items-start gap-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-700">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />
          <span>
            Line item total ({form.currency} {lineTotal.toFixed(2)}) doesn't match invoice total
            ({form.currency} {invoiceTotal.toFixed(2)}). Please verify before saving.
          </span>
        </div>
      )}

      {/* Duplicate warning + override */}
      {duplicates.length > 0 && (
        <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-3 space-y-3">
          <div className="flex items-center gap-1.5 text-amber-800 text-sm font-semibold">
            <AlertTriangle size={14} className="shrink-0" />
            {duplicates.length === 1
              ? "This invoice looks like a duplicate"
              : `${duplicates.length} possible duplicates found`}
          </div>
          <div className="space-y-2">
            {duplicates.map((d) => (
              <div key={d.id} className="rounded border border-amber-200 bg-white px-2.5 py-2 text-xs space-y-0.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-amber-800">
                    {d.invoiceNumber ? `Invoice ${d.invoiceNumber}` : `Invoice #${d.id}`}
                  </span>
                  <span className="text-amber-600 capitalize">{d.status}</span>
                </div>
                <div className="text-amber-700">
                  {d.currency} {parseFloat(d.amount).toFixed(2)}
                  {" · "}
                  {d.issuedAt ? d.issuedAt.slice(0, 10) : "—"}
                </div>
                <div className="text-amber-600 italic">
                  Flagged because: {d.reason.toLowerCase()}
                </div>
              </div>
            ))}
          </div>
          {isOwner ? (
            <label className="flex items-start gap-2 text-xs text-amber-800 cursor-pointer">
              <input
                type="checkbox"
                checked={overrideDuplicates}
                onChange={(e) => onOverrideChange(e.target.checked)}
                className="rounded mt-0.5"
              />
              <span>I have reviewed the above and confirm this is not a duplicate — save anyway</span>
            </label>
          ) : (
            <p className="text-xs text-amber-700 font-medium">
              Only owners can override duplicate protection. Contact your workspace owner to proceed.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main dialog
// ---------------------------------------------------------------------------
export type AddInvoiceDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  supplierId: number;
  editingInvoice?: SupplierInvoice | null;
  currencyPref?: string | null;
  /** VAT registration status of the supplier — used to show inline warnings */
  supplierVatStatus?: "registered" | "not_registered" | "unknown" | null;
  initialFile?: File | null;
  initialStep?: "upload" | "manual";
  defaultReferenceType?: string | null;
  defaultReferenceId?: number | null;
};

type Step = "upload" | "review" | "confirm";

export function AddInvoiceDialog({
  open,
  onOpenChange,
  supplierId,
  editingInvoice,
  currencyPref,
  supplierVatStatus,
  initialFile,
  initialStep,
  defaultReferenceType,
  defaultReferenceId,
}: AddInvoiceDialogProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);

  const isEditMode = editingInvoice != null;

  // Detect owner role for duplicate override
  const { isOwner } = useWorkspaceRole();

  const [step, setStep] = useState<Step>(isEditMode ? "review" : "upload");
  const [uploadMode, setUploadMode] = useState<"file" | "manual">("file");

  const [isExtracting, setIsExtracting] = useState(false);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [extractResult, setExtractResult] = useState<ExtractResponse | null>(null);
  const [filePreviewUrl, setFilePreviewUrl] = useState<string | null>(null);
  const [previewMime, setPreviewMime] = useState<string>("application/pdf");

  const [form, setForm] = useState<ReviewForm>(() =>
    isEditMode && editingInvoice
      ? invoiceToForm(editingInvoice, currencyPref)
      : emptyForm(currencyPref),
  );

  const [duplicates, setDuplicates] = useState<DuplicateMatch[]>([]);
  const [overrideDuplicates, setOverrideDuplicates] = useState(false);
  const [isCheckingDuplicates, setIsCheckingDuplicates] = useState(false);
  const [poSuggestion, setPoSuggestion] = useState<POSuggestion | null>(null);

  // Fetch supplier's POs to detect auto-match
  const { data: poData } = useListPurchaseOrders({ supplier_id: supplierId });

  useEffect(() => {
    if (!open) return;
    if (isEditMode && editingInvoice) {
      setForm(invoiceToForm(editingInvoice, currencyPref));
      setStep("review");
    } else {
      const initForm = emptyForm(currencyPref);
      if (defaultReferenceType && defaultReferenceId != null) {
        initForm.referenceType = defaultReferenceType;
        initForm.referenceId = defaultReferenceId;
      }
      setForm(initForm);
      if (initialStep === "manual") {
        setUploadMode("manual");
        setStep("review");
      } else {
        setUploadMode("file");
        setStep("upload");
      }
    }
    setExtractResult(null);
    setFilePreviewUrl(null);
    setPreviewMime("application/pdf");
    setExtractError(null);
    setDuplicates([]);
    setOverrideDuplicates(false);
    setPoSuggestion(null);
    if (initialFile && !isEditMode && initialStep !== "manual") {
      extractFile(initialFile);
    }
  }, [open]);

  // Auto-match PO suggestion whenever form amount / currency changes
  useEffect(() => {
    if (!form.amount || !poData?.purchase_orders) {
      setPoSuggestion(null);
      return;
    }
    if (form.referenceType !== "") {
      setPoSuggestion(null);
      return;
    }
    const invoiceAmt = parseFloat(form.amount);
    if (isNaN(invoiceAmt)) {
      setPoSuggestion(null);
      return;
    }
    const orders: PurchaseOrder[] = poData.purchase_orders;
    const match = orders.find((po) => {
      if (!po.total_amount) return false;
      if (po.currency && po.currency !== form.currency) return false;
      return Math.abs(parseFloat(po.total_amount) - invoiceAmt) < 0.01;
    });
    if (match) {
      setPoSuggestion({
        id: match.id,
        label: match.po_number_label ?? `PO-${String(match.id).padStart(4, "0")}`,
        amount: match.total_amount ?? "0",
        currency: match.currency,
        status: match.status,
      });
    } else {
      setPoSuggestion(null);
    }
  }, [form.amount, form.currency, form.referenceType, poData]);

  const createMutation = useCreateSupplierInvoice({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListSupplierInvoicesQueryKey(supplierId) });
        qc.invalidateQueries({ queryKey: getGetSupplierQueryKey(supplierId) });
        toast({ title: "Invoice created" });
        onOpenChange(false);
      },
      onError: (err) => {
        toast({
          title: "Failed to create invoice",
          description: err instanceof Error ? err.message : undefined,
          variant: "destructive",
        });
      },
    },
  });

  const updateMutation = useUpdateSupplierInvoice({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListSupplierInvoicesQueryKey(supplierId) });
        qc.invalidateQueries({ queryKey: getGetSupplierQueryKey(supplierId) });
        toast({ title: "Invoice updated" });
        onOpenChange(false);
      },
      onError: (err) => {
        toast({
          title: "Failed to update invoice",
          description: err instanceof Error ? err.message : undefined,
          variant: "destructive",
        });
      },
    },
  });

  const isSaving = createMutation.isPending || updateMutation.isPending;

  async function extractFile(file: File) {
    setIsExtracting(true);
    setExtractError(null);
    try {
      const token = await getClerkToken();
      const formData = new FormData();
      formData.append("file", file);
      const resp = await fetch(`/api/suppliers/${supplierId}/invoices/extract`, {
        method: "POST",
        credentials: "include",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: formData,
      });
      if (!resp.ok) {
        const body = (await resp.json().catch(() => ({}))) as {
          error?: string;
          fileUrl?: string;
        };
        if (body.fileUrl) {
          setFilePreviewUrl(body.fileUrl);
          setPreviewMime(file.type);
        }
        throw new Error(body.error ?? `Extraction failed (${resp.status})`);
      }
      const data = (await resp.json()) as ExtractResponse;
      setExtractResult(data);
      setFilePreviewUrl(data.fileUrl);
      setPreviewMime(data.mimeType);
      const extracted = extractionToForm(data.extraction, currencyPref);
      if (extracted.referenceType === "" && defaultReferenceType && defaultReferenceId != null) {
        extracted.referenceType = defaultReferenceType;
        extracted.referenceId = defaultReferenceId;
      }
      setForm(extracted);
      setStep("review");
    } catch (err) {
      setExtractError(err instanceof Error ? err.message : "AI extraction failed");
      toast({
        title: "Extraction failed",
        description: err instanceof Error ? err.message : "Could not extract invoice data.",
        variant: "destructive",
      });
    } finally {
      setIsExtracting(false);
    }
  }

  function handleFileDrop(files: FileList | null) {
    if (!files || files.length === 0) return;
    extractFile(files[0]);
  }

  function handleDragOver(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(true);
  }
  function handleDragLeave() {
    setIsDragging(false);
  }
  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setIsDragging(false);
    handleFileDrop(e.dataTransfer.files);
  }

  function tryClose() {
    if (isSaving || isExtracting) return;
    // If on review step and form has meaningful content, confirm before discarding
    if (!isEditMode && step !== "upload" && formHasChanges(form, currencyPref)) {
      setConfirmClose(true);
    } else {
      onOpenChange(false);
    }
  }

  function buildPayload(override: boolean, statusOverride?: string) {
    const hasRef =
      (form.referenceType === "base_item" || form.referenceType === "purchase_order") &&
      form.referenceId != null;
    const fileUrls = extractResult?.fileUrl
      ? [extractResult.fileUrl]
      : (editingInvoice?.file_urls ?? []);
    const effectiveStatus = statusOverride ?? form.status;

    return {
      amount: form.amount.trim() || "0",
      currency: form.currency,
      status: effectiveStatus,
      invoice_number: form.invoiceNumber.trim() || null,
      issued_at: form.issuedAt ? new Date(form.issuedAt).toISOString() : new Date().toISOString(),
      paid_at: effectiveStatus === "paid" && form.paidAt ? new Date(form.paidAt).toISOString() : null,
      due_date: form.dueDate || null,
      vat_amount: form.vatAmount.trim() || null,
      subtotal: form.subtotal.trim() || null,
      discount: form.discount.trim() || null,
      payment_terms: form.paymentTerms.trim() || null,
      notes: form.notes.trim() || null,
      reference_type: hasRef ? form.referenceType : null,
      reference_id: hasRef ? form.referenceId : null,
      line_items: form.lineItems.length > 0 ? form.lineItems : null,
      file_urls: fileUrls.length > 0 ? fileUrls : null,
      ...(override ? { override_duplicates: true } : {}),
    };
  }

  function handleSaveAsDraft() {
    if (!form.invoiceNumber.trim()) {
      toast({ title: t("supplierInvoices.addInvoice.invoiceNumberRequired"), variant: "destructive" });
      return;
    }
    if (isEditMode && editingInvoice) {
      updateMutation.mutate({
        id: supplierId,
        invoiceId: editingInvoice.id,
        data: buildPayload(false, "draft"),
      });
    } else {
      createMutation.mutate({ id: supplierId, data: buildPayload(false, "draft") });
    }
  }

  function handleSave() {
    if (!form.amount.trim() || !form.issuedAt) {
      toast({ title: "Amount and issue date are required", variant: "destructive" });
      return;
    }
    if (isEditMode && editingInvoice) {
      updateMutation.mutate({
        id: supplierId,
        invoiceId: editingInvoice.id,
        data: buildPayload(false, undefined),
      });
    } else {
      createMutation.mutate({ id: supplierId, data: buildPayload(false, undefined) });
    }
  }

  function handleConfirmSave() {
    if (!form.amount.trim() || !form.issuedAt) return;
    // At step confirm, we always pass override if there were duplicates
    if (isEditMode && editingInvoice) {
      updateMutation.mutate({
        id: supplierId,
        invoiceId: editingInvoice.id,
        data: buildPayload(false),
      });
    } else {
      createMutation.mutate({
        id: supplierId,
        data: buildPayload(duplicates.length > 0 && overrideDuplicates),
      });
    }
  }

  async function runDuplicateCheckAndProceed(then: "confirm" | "save") {
    const total = form.amount.trim() ? parseFloat(form.amount) : undefined;
    const params = {
      invoiceNumber: form.invoiceNumber.trim() || undefined,
      total: total != null && !isNaN(total) ? total : undefined,
      issuedAt: form.issuedAt || undefined,
      currency: form.currency || undefined,
      excludeId: isEditMode && editingInvoice ? editingInvoice.id : undefined,
    };
    setIsCheckingDuplicates(true);
    try {
      const result = await checkSupplierInvoiceDuplicate(supplierId, params);
      const found: DuplicateMatch[] = (result.duplicates ?? []).map((d) => ({
        id: d.id,
        invoiceNumber: d.invoiceNumber ?? null,
        amount: d.amount,
        currency: d.currency,
        issuedAt: d.issuedAt,
        status: d.status,
        reason: d.reason,
      }));
      setDuplicates(found);
      if (then === "confirm") {
        setStep("confirm");
      } else {
        if (found.length > 0) {
          setStep("confirm");
        } else {
          handleSave();
        }
      }
    } catch {
      toast({
        title: "Could not check for duplicates",
        description: "Proceeding without duplicate check.",
        variant: "destructive",
      });
      if (then === "confirm") {
        setStep("confirm");
      } else {
        handleSave();
      }
    } finally {
      setIsCheckingDuplicates(false);
    }
  }

  const hasDuplicates = duplicates.length > 0;
  const canConfirmSave =
    !hasDuplicates ||
    (isOwner && overrideDuplicates);

  const showDocumentPanel = filePreviewUrl != null && step === "review";

  const stepLabels: Array<{ key: Step; label: string }> = [
    { key: "upload", label: "Upload" },
    { key: "review", label: "Review" },
    { key: "confirm", label: "Save" },
  ];

  const currentStepIdx = stepLabels.findIndex((s) => s.key === step);

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(v) => {
          if (!v) tryClose();
        }}
      >
        <DialogContent
          className={cn(
            "gap-0 p-0 overflow-hidden",
            showDocumentPanel ? "max-w-5xl" : "max-w-lg",
          )}
        >
          <DialogHeader className="px-6 pt-5 pb-3 border-b border-border">
            <div className="flex items-center justify-between">
              <DialogTitle className="text-base">
                {isEditMode ? "Edit Invoice" : "Add Invoice"}
              </DialogTitle>
              {!isEditMode && (
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  {stepLabels.map((s, i) => (
                    <span key={s.key} className="flex items-center gap-1">
                      <span
                        className={cn(
                          "h-5 w-5 rounded-full flex items-center justify-center text-[11px] font-medium",
                          i === currentStepIdx
                            ? "bg-primary text-primary-foreground"
                            : i < currentStepIdx
                            ? "bg-green-100 text-green-700"
                            : "bg-muted text-muted-foreground",
                        )}
                      >
                        {i < currentStepIdx ? <Check size={10} /> : i + 1}
                      </span>
                      <span className="hidden sm:inline">{s.label}</span>
                      {i < stepLabels.length - 1 && (
                        <ChevronRight size={12} className="text-muted-foreground/50" />
                      )}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </DialogHeader>

          {/* ── Step 1: Upload ── */}
          {step === "upload" && (
            <div className="px-6 py-5 space-y-4">
              <p className="text-sm text-muted-foreground">
                How would you like to add this invoice?
              </p>

              <div className="grid grid-cols-2 gap-3">
                {/* Upload card */}
                <button
                  type="button"
                  onClick={() => setUploadMode("file")}
                  className={cn(
                    "rounded-lg border-2 p-4 text-left transition-colors relative",
                    uploadMode === "file"
                      ? "border-[#0E7490] bg-[#F0FDFA]"
                      : "border-border hover:border-[#0E7490]/50",
                  )}
                >
                  <span className="absolute top-2.5 end-2.5 inline-flex items-center rounded-full bg-[#CCFBF1] text-[#0D9488] text-[10px] font-semibold px-2 py-0.5">
                    Recommended
                  </span>
                  <UploadCloud size={20} className="mb-2 text-[#0E7490]" />
                  <p className="text-sm font-semibold">Upload invoice</p>
                  <p className="text-xs text-muted-foreground mt-1 leading-snug">
                    Let AI detect the supplier, invoice number, dates, totals, VAT and line items
                  </p>
                </button>

                {/* Manual card */}
                <button
                  type="button"
                  onClick={() => setUploadMode("manual")}
                  className={cn(
                    "rounded-lg border-2 p-4 text-left transition-colors",
                    uploadMode === "manual"
                      ? "border-primary bg-primary/5"
                      : "border-border hover:border-primary/50",
                  )}
                >
                  <FileText size={20} className="mb-2 text-muted-foreground" />
                  <p className="text-sm font-semibold">Enter manually</p>
                  <p className="text-xs text-muted-foreground mt-1 leading-snug">
                    Complete the invoice details yourself without uploading a document
                  </p>
                </button>
              </div>

              {/* Drop zone — shown only in file mode */}
              {uploadMode === "file" && (
                <>
                  <div
                    className={cn(
                      "rounded-xl border-2 border-dashed transition-colors",
                      isDragging ? "border-[#0E7490] bg-[#F0FDFA]" : "border-border hover:border-[#0E7490]/40",
                      isExtracting ? "pointer-events-none opacity-60" : "cursor-pointer",
                    )}
                    onClick={() => !isExtracting && fileInputRef.current?.click()}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                  >
                    <div className="flex flex-col items-center py-8 gap-3">
                      {isExtracting ? (
                        <>
                          <Loader2 size={28} className="animate-spin text-[#0E7490]" />
                          <div className="text-center">
                            <p className="text-sm font-medium">Extracting invoice data…</p>
                            <p className="text-xs text-muted-foreground mt-1">
                              AI is reading your document
                            </p>
                          </div>
                        </>
                      ) : (
                        <>
                          <div className="h-11 w-11 rounded-full bg-muted flex items-center justify-center">
                            <UploadCloud size={20} className="text-muted-foreground" />
                          </div>
                          <div className="text-center space-y-1">
                            <p className="text-sm font-medium">Drop your invoice here</p>
                            <p className="text-xs text-muted-foreground">
                              or click to browse from your computer
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              fileInputRef.current?.click();
                            }}
                            className="mt-1 px-4 py-1.5 rounded-md border border-border text-xs font-medium hover:bg-muted transition-colors"
                          >
                            Choose file
                          </button>
                          <p className="text-[11px] text-muted-foreground">
                            PDF, JPG or PNG · Up to 20 MB · Multiple-page invoices supported
                          </p>
                        </>
                      )}
                    </div>
                  </div>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".pdf,.jpg,.jpeg,.png"
                    className="hidden"
                    onChange={(e) => handleFileDrop(e.target.files)}
                  />
                  {extractError && (
                    <div className="flex items-start gap-2 rounded-lg bg-destructive/10 text-destructive px-3 py-2 text-sm">
                      <AlertTriangle size={15} className="mt-0.5 shrink-0" />
                      <div>
                        <p className="font-medium">Extraction failed</p>
                        <p className="text-xs mt-0.5 opacity-80">{extractError}</p>
                        {filePreviewUrl && (
                          <button
                            type="button"
                            className="mt-1 text-xs underline"
                            onClick={() => setStep("review")}
                          >
                            Continue with manual entry →
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </>
              )}

              {/* Shield note */}
              <div className="flex items-center gap-2 text-xs text-muted-foreground pt-1">
                <Shield size={13} className="shrink-0" />
                <span>AI will extract the details. You'll review before anything is saved.</span>
              </div>
            </div>
          )}

          {/* ── Step 2: Review ── */}
          {step === "review" && (
            <div className="flex flex-col overflow-hidden" style={{ height: "70vh" }}>
              {/* Tab bar */}
              <div className="flex border-b border-border shrink-0">
                <button
                  type="button"
                  onClick={() => setUploadMode("file")}
                  className={cn(
                    "flex items-center gap-1.5 px-5 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px",
                    uploadMode === "file"
                      ? "border-[#0E7490] text-[#0E7490]"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  <UploadCloud size={14} />
                  Upload invoice
                  <span className="inline-flex items-center rounded-full bg-[#CCFBF1] text-[#0D9488] text-[10px] font-semibold px-1.5 py-0.5 ms-1">
                    Recommended
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setUploadMode("manual")}
                  className={cn(
                    "flex items-center gap-1.5 px-5 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px",
                    uploadMode === "manual"
                      ? "border-primary text-primary"
                      : "border-transparent text-muted-foreground hover:text-foreground",
                  )}
                >
                  <FileText size={14} />
                  Enter manually
                </button>
              </div>

              {/* Success banner */}
              {extractResult && uploadMode === "file" && (
                <div className="flex items-center gap-2 px-5 py-2.5 bg-green-50 border-b border-green-200 shrink-0">
                  <CheckCircle2 size={15} className="text-green-600 shrink-0" />
                  <span className="text-sm text-green-800 font-medium">
                    Invoice scanned successfully
                    {extractResult.fieldsDetected > 0 && (
                      <span className="font-normal text-green-700">
                        {" · "}{extractResult.fieldsDetected} fields detected
                      </span>
                    )}
                  </span>
                  {extractResult.extraction.company_validation_status === "matched" && (
                    <span className="ms-auto inline-flex items-center gap-1 text-xs text-green-700 bg-green-100 rounded px-1.5 py-0.5">
                      <CheckCircle2 size={11} /> Vendor matched
                    </span>
                  )}
                  {extractResult.extraction.company_validation_status === "mismatch" && (
                    <span className="ms-auto inline-flex items-center gap-1 text-xs text-amber-700 bg-amber-100 rounded px-1.5 py-0.5">
                      <AlertTriangle size={11} />{" "}
                      {extractResult.extraction.company_validation_notes ?? "Vendor mismatch"}
                    </span>
                  )}
                  <ConfidenceBadge confidence={extractResult.extraction.confidence} />
                </div>
              )}

              {/* Main body */}
              <div
                className={cn(
                  "flex-1 overflow-hidden",
                  showDocumentPanel && uploadMode === "file"
                    ? "grid"
                    : "flex flex-col",
                )}
                style={
                  showDocumentPanel && uploadMode === "file"
                    ? { gridTemplateColumns: "1fr 1fr" }
                    : undefined
                }
              >
                {/* Left: document viewer */}
                {showDocumentPanel && uploadMode === "file" && filePreviewUrl && (
                  <div className="border-e border-border bg-muted/20 overflow-hidden">
                    <DocumentViewer
                      fileUrl={filePreviewUrl}
                      mimeType={previewMime}
                      fileName={extractResult?.fileName ?? "document"}
                    />
                  </div>
                )}

                {/* Right: form */}
                <div className="overflow-y-auto p-5">
                  {(showDocumentPanel && uploadMode === "file") && (
                    <div className="mb-4">
                      <p className="text-sm font-semibold text-foreground">Review detected details</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Confirm the information before saving
                      </p>
                    </div>
                  )}
                  <ReviewFormPanel
                    form={form}
                    setForm={setForm}
                    supplierId={supplierId}
                    disabled={isSaving}
                    poSuggestion={poSuggestion}
                  />
                  {/* VAT status warning — shown when VAT amount > 0 and supplier has a non-standard status */}
                  {form.vatAmount && parseFloat(form.vatAmount) > 0 && supplierVatStatus === "not_registered" && (
                    <div className="flex items-start gap-2 mt-3 rounded-md border border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/30 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
                      <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                      <span>This supplier is not VAT registered. VAT will not be applied by default. Please review before posting.</span>
                    </div>
                  )}
                  {form.vatAmount && parseFloat(form.vatAmount) > 0 && supplierVatStatus === "unknown" && (
                    <div className="flex items-start gap-2 mt-3 rounded-md border border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/30 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
                      <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                      <span>This supplier&apos;s VAT status is unverified. Confirm tax treatment before posting.</span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ── Step 3: Confirm ── */}
          {step === "confirm" && (
            <div className="px-6 py-5 overflow-y-auto max-h-[70vh]">
              <ConfirmationSummary
                form={form}
                extractResult={extractResult}
                duplicates={duplicates}
                overrideDuplicates={overrideDuplicates}
                onOverrideChange={setOverrideDuplicates}
                isOwner={isOwner}
              />
            </div>
          )}

          {/* Footer */}
          <div className="flex items-center justify-between px-6 py-4 border-t border-border bg-background">
            <div className="flex items-center gap-2">
              {step === "upload" && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={tryClose}
                  disabled={isSaving || isExtracting}
                >
                  Cancel
                </Button>
              )}
              {step === "review" && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleSaveAsDraft}
                  disabled={isSaving || isCheckingDuplicates}
                >
                  {isSaving ? (
                    <>
                      <Loader2 size={13} className="animate-spin me-1.5" /> {t("supplierInvoices.addInvoice.savingDraft")}
                    </>
                  ) : (
                    t("supplierInvoices.addInvoice.saveAsDraft")
                  )}
                </Button>
              )}
              {step === "confirm" && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setStep("review");
                    setDuplicates([]);
                    setOverrideDuplicates(false);
                  }}
                  disabled={isSaving}
                >
                  <ChevronLeft size={14} className="me-1" /> Back
                </Button>
              )}
            </div>
            <div className="flex items-center gap-2">
              {step === "upload" && (
                <Button
                  size="sm"
                  onClick={() => setStep("review")}
                  disabled={uploadMode === "file" || isExtracting}
                >
                  Continue
                </Button>
              )}
              {step === "review" && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={tryClose}
                    disabled={isSaving || isCheckingDuplicates}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => {
                      if (!form.amount.trim() || !form.issuedAt) {
                        toast({
                          title: "Amount and issue date are required",
                          variant: "destructive",
                        });
                        return;
                      }
                      if (isEditMode) {
                        runDuplicateCheckAndProceed("save");
                      } else {
                        runDuplicateCheckAndProceed("confirm");
                      }
                    }}
                    disabled={isSaving || isCheckingDuplicates || !form.amount.trim() || !form.issuedAt}
                  >
                    {isEditMode ? (
                      isSaving ? (
                        <>
                          <Loader2 size={13} className="animate-spin me-1.5" /> Saving…
                        </>
                      ) : isCheckingDuplicates ? (
                        <>
                          <Loader2 size={13} className="animate-spin me-1.5" /> Checking…
                        </>
                      ) : (
                        "Save changes"
                      )
                    ) : isCheckingDuplicates ? (
                      <>
                        <Loader2 size={13} className="animate-spin me-1.5" /> Checking…
                      </>
                    ) : (
                      "Save Invoice"
                    )}
                  </Button>
                </>
              )}
              {step === "confirm" && (
                <>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={tryClose}
                    disabled={isSaving}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    onClick={handleConfirmSave}
                    disabled={isSaving || !canConfirmSave}
                    variant={hasDuplicates ? "destructive" : "default"}
                  >
                    {isSaving ? (
                      <>
                        <Loader2 size={13} className="animate-spin me-1.5" />{" "}
                        {hasDuplicates ? "Saving anyway…" : "Creating…"}
                      </>
                    ) : hasDuplicates ? (
                      "Save anyway"
                    ) : (
                      "Save Invoice"
                    )}
                  </Button>
                </>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Unsaved-work close confirmation */}
      <AlertDialog open={confirmClose} onOpenChange={setConfirmClose}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard changes?</AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved invoice data. Closing will discard any information you've entered or
              extracted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmClose(false);
                onOpenChange(false);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Discard and close
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
