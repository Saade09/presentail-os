import { useState, useMemo, useRef, useEffect } from "react";
import { Link } from "wouter";
import {
  Package,
  Loader2,
  Trash2,
  ShoppingCart,
  Search,
  ShoppingBag,
  ChevronRight,
  Star,
  ChevronsUpDown,
  Check,
  Home,
  Paperclip,
  X,
  AlertTriangle,
  Pencil,
  Info,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
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
import { useToast } from "@/hooks/use-toast";
import { useQuery } from "@tanstack/react-query";
import {
  useCreatePurchaseOrder,
  useListSuppliers,
  useListSupplierCatalogItems,
} from "@workspace/api-client-react";
import type { SupplierCatalogItem } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/queryClient";

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------
export type SupplierOption = {
  id: number;
  name: string;
  display_name?: string | null;
  country?: string | null;
  default_vat_treatment?: string | null;
  default_vat_rate?: string | null;
  currency_pref?: string | null;
  payment_terms?: string | null;
};

export type CartItem = {
  supplier_catalog_item_id: number | null;
  item: SupplierCatalogItem;
  quantity: string;
};

export function cartKey(item: Pick<SupplierCatalogItem, "id" | "source">): string {
  return `${item.source ?? "standalone"}-${item.id}`;
}

/**
 * Resolve the `supplier_catalog_item_id` to store in the cart for a given
 * catalog item. Linked base items have no real supplier_catalog_items row, so
 * they must submit `null` (with a `base_item_id` instead); standalone items use
 * their own id. Keeping this in one place guards against the payload-shape
 * mismatch that previously caused a 404 when ordering linked base items.
 */
export function resolveSupplierCatalogItemId(
  item: Pick<SupplierCatalogItem, "id" | "source">,
): number | null {
  return item.source === "linked_base_item" ? null : item.id;
}

export type PoLineItemPayload = {
  supplier_catalog_item_id: number | null;
  base_item_id?: number | null;
  description: string;
  quantity: string;
  unit_price: string;
  currency: string;
};

/**
 * Build the line-item payload submitted to `POST /api/purchase-orders` for a
 * single cart entry. Linked base items send `supplier_catalog_item_id: null`
 * plus a `base_item_id`; standalone items send `supplier_catalog_item_id: id`
 * and omit `base_item_id`.
 */
export function buildLineItemPayload(
  cartItem: CartItem,
  fallbackCurrency: string,
): PoLineItemPayload {
  const { item, quantity } = cartItem;
  const base: Omit<PoLineItemPayload, "supplier_catalog_item_id" | "base_item_id"> = {
    description: item.name,
    quantity,
    unit_price: item.price ?? "0",
    currency: item.currency || fallbackCurrency,
  };
  if (item.source === "linked_base_item") {
    return {
      supplier_catalog_item_id: null,
      base_item_id: item.base_item_id ?? null,
      ...base,
    };
  }
  return {
    supplier_catalog_item_id: item.id,
    ...base,
  };
}

export type OrderSettings = {
  location_id: number | null;
  po_number: string;
  status: string;
  currency: string;
  expected_delivery_date: string;
  notes: string;
  discount_amount: string;
  delivery_fee_amount: string;
  vat_treatment: string;
  vat_rate: string;
  payment_terms: string;
  supplier_reference: string;
};

export function emptySettings(currency = "AED"): OrderSettings {
  return {
    location_id: null,
    po_number: "",
    status: "pending_approval",
    currency,
    expected_delivery_date: "",
    notes: "",
    discount_amount: "",
    delivery_fee_amount: "",
    vat_treatment: "no_vat",
    vat_rate: "",
    payment_terms: "",
    supplier_reference: "",
  };
}

export const PO_STATUS_MAP: Record<string, { label: string; className: string }> = {
  draft:             { label: "Draft",               className: "bg-gray-100 text-gray-700" },
  pending_approval:  { label: "Awaiting approval",   className: "bg-orange-100 text-orange-700" },
  approved:          { label: "Approved",            className: "bg-teal-100 text-teal-700" },
  sent:      { label: "Sent",               className: "bg-blue-100 text-blue-700" },
  confirmed: { label: "Confirmed",          className: "bg-purple-100 text-purple-700" },
  partial:   { label: "Partially Received", className: "bg-yellow-100 text-yellow-700" },
  received:  { label: "Received",           className: "bg-green-100 text-green-700" },
  cancelled: { label: "Cancelled",          className: "bg-gray-100 text-gray-500 line-through" },
};

export function PoStatusBadge({ status }: { status: string | null | undefined }) {
  const entry = status ? PO_STATUS_MAP[status] : undefined;
  return (
    <span className={cn("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", entry?.className ?? "bg-gray-100 text-gray-600")}>
      {entry?.label ?? status ?? "—"}
    </span>
  );
}

export const PO_STATUSES = ["draft", "pending_approval", "approved", "sent", "confirmed", "partial", "received", "cancelled"];
export const PO_CURRENCIES = ["AED", "USD", "EUR", "GBP", "SAR", "LBP"];

export const VAT_TREATMENT_LABELS: Record<string, string> = {
  no_vat: "No VAT",
  vat_exclusive: "VAT Exclusive (added on top)",
  vat_inclusive: "VAT Inclusive (already included)",
};

/** Standard VAT rate (%) by country name, used as the default when the supplier has no own default. */
export const COUNTRY_VAT_RATE_DEFAULTS: Record<string, number> = {
  Lebanon: 11,
  "United Arab Emirates": 5,
};

/** Selectable preset VAT rates (%) shown in the PO VAT rate dropdown. */
export const PO_VAT_RATE_PRESETS = [5, 8, 10, 11, 15, 20];

/** Normalize a VAT rate string to a canonical numeric string (e.g. "5.00" -> "5"); "" when blank/invalid. */
export function normalizeVatRate(value: string | null | undefined): string {
  if (value == null || value === "") return "";
  const n = parseFloat(value);
  return Number.isFinite(n) ? String(n) : "";
}

/** Resolve the default VAT rate (as a numeric string) for a country name, or "" if unknown. */
export function countryDefaultVatRate(country: string | null | undefined): string {
  if (!country) return "";
  const rate = COUNTRY_VAT_RATE_DEFAULTS[country.trim()];
  return rate != null ? String(rate) : "";
}

/** Compute live cost summary for display in the review wizard. */
export function computeReviewCostSummary(cartTotal: number, settings: OrderSettings) {
  const subtotal = Math.round((cartTotal + Number.EPSILON) * 100) / 100;
  const discount = Math.max(0, parseFloat(settings.discount_amount) || 0);
  const deliveryFee = Math.max(0, parseFloat(settings.delivery_fee_amount) || 0);
  const vatRate = parseFloat(settings.vat_rate) || 0;
  let vatAmount = 0;
  if (settings.vat_treatment === "vat_exclusive") {
    vatAmount = Math.round((subtotal * (vatRate / 100)) * 100) / 100;
  } else if (settings.vat_treatment === "vat_inclusive") {
    vatAmount = Math.round((subtotal - subtotal / (1 + vatRate / 100)) * 100) / 100;
  }
  const grandTotal = Math.max(0, Math.round((subtotal - discount + deliveryFee + vatAmount) * 100) / 100);
  return { subtotal, discount, deliveryFee, vatAmount, grandTotal };
}

// ---------------------------------------------------------------------------
// Location Combobox
// ---------------------------------------------------------------------------
type LocationOption = { id: number; name: string };

export function LocationCombobox({
  value,
  onChange,
  disabled,
  ariaLabel,
}: {
  value: number | null;
  onChange: (id: number | null) => void;
  disabled?: boolean;
  ariaLabel?: string;
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
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={ariaLabel}
          className="w-full justify-between font-normal h-9 px-3 text-sm"
          type="button"
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
                <CommandItem value="" onSelect={() => { onChange(null); setOpen(false); }} className="text-muted-foreground">
                  — Clear selection —
                </CommandItem>
              )}
              {locations.map((l) => (
                <CommandItem key={l.id} value={l.name} onSelect={() => { onChange(l.id); setOpen(false); }}>
                  <Check className={cn("mr-2 size-4", value === l.id ? "opacity-100" : "opacity-0")} />
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

// ---------------------------------------------------------------------------
// Supplier list panel for wizard (left side)
// ---------------------------------------------------------------------------
export function SupplierListPanel({
  selectedId,
  onSelect,
  initialSupplierId,
}: {
  selectedId: number | null;
  onSelect: (supplier: SupplierOption) => void;
  initialSupplierId?: number;
}) {
  const [search, setSearch] = useState("");
  const { data, isLoading } = useListSuppliers({ q: search || undefined });
  const suppliers: SupplierOption[] = data?.suppliers ?? [];
  const selectedRowRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (suppliers.length > 0 && selectedId != null && selectedRowRef.current) {
      selectedRowRef.current.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [suppliers.length, selectedId]);

  return (
    <div className="flex flex-col h-full border-r border-border">
      <div className="p-3 border-b border-border">
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search suppliers…"
            className="pl-8 h-8 text-sm"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={16} className="animate-spin text-muted-foreground" />
          </div>
        ) : suppliers.length === 0 ? (
          <div className="py-8 text-center">
            <p className="text-sm text-muted-foreground">No suppliers found</p>
          </div>
        ) : (
          suppliers.map((s) => {
            const isActive = selectedId === s.id;
            const isHome = initialSupplierId != null && s.id === initialSupplierId;
            const displayName = s.display_name || s.name;
            const initial = displayName.trim().charAt(0).toUpperCase();
            return (
              <button
                key={s.id}
                ref={isActive ? selectedRowRef : null}
                type="button"
                onClick={() => onSelect(s)}
                className={cn(
                  "w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted/50",
                  isActive && "bg-primary/5 border-r-2 border-primary",
                  isHome && !isActive && "bg-muted/30",
                )}
              >
                <div className={cn(
                  "w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0",
                  isActive ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
                )}>
                  {initial}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <p className={cn("text-sm font-medium truncate", isActive && "text-primary")}>{displayName}</p>
                    {isHome && (
                      <Home size={11} className={cn("shrink-0", isActive ? "text-primary" : "text-muted-foreground")} />
                    )}
                  </div>
                </div>
                {isActive && <ChevronRight size={14} className="text-primary shrink-0" />}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Catalog items panel for wizard (right side)
// ---------------------------------------------------------------------------
export function CatalogItemsPanel({
  supplierId,
  supplierName,
  cartItems,
  onQtyChange,
  currency,
}: {
  supplierId: number;
  supplierName: string;
  cartItems: Map<string, CartItem>;
  onQtyChange: (item: SupplierCatalogItem, qty: string) => void;
  currency: string;
}) {
  const [search, setSearch] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("");
  const [lowStockOnly, setLowStockOnly] = useState(false);

  const { data, isLoading } = useListSupplierCatalogItems(supplierId, {
    active_only: true,
    q: search || undefined,
    low_stock_only: lowStockOnly || undefined,
  });

  const catalogItems: SupplierCatalogItem[] = data?.catalog_items ?? [];

  const categories = useMemo(() => {
    const cats = new Set<string>();
    catalogItems.forEach((ci) => { if (ci.category) cats.add(ci.category); });
    return Array.from(cats).sort();
  }, [catalogItems]);

  const filtered = categoryFilter
    ? catalogItems.filter((ci) => ci.category === categoryFilter)
    : catalogItems;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full py-16">
        <Loader2 size={20} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (catalogItems.length === 0 && !search && !lowStockOnly) {
    return (
      <div className="flex flex-col items-center justify-center h-full py-16 gap-3 text-center px-6">
        <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center">
          <Package size={22} className="text-muted-foreground" />
        </div>
        <div>
          <p className="font-medium text-sm">No catalog items for {supplierName}</p>
          <p className="text-xs text-muted-foreground mt-1">
            Add items to this supplier's catalog from the{" "}
            <Link
              href={`/dashboard/suppliers/${supplierId}`}
              className="underline text-primary hover:text-primary/80"
            >
              Supplier detail page
            </Link>
            .
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="p-3 border-b border-border space-y-2">
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search items…"
              className="pl-8 h-8 text-sm"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <button
            type="button"
            onClick={() => setLowStockOnly((v) => !v)}
            className={cn(
              "rounded px-2.5 h-8 text-xs font-medium border transition-colors shrink-0",
              lowStockOnly
                ? "bg-yellow-100 text-yellow-800 border-yellow-300"
                : "border-border text-muted-foreground hover:bg-muted",
            )}
          >
            Low Stock
          </button>
        </div>
        {categories.length > 0 && (
          <div className="flex gap-1.5 flex-wrap">
            <button
              type="button"
              onClick={() => setCategoryFilter("")}
              className={cn(
                "rounded-full px-2.5 py-0.5 text-xs font-medium border transition-colors",
                !categoryFilter
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-border text-muted-foreground hover:bg-muted",
              )}
            >
              All
            </button>
            {categories.map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setCategoryFilter(cat === categoryFilter ? "" : cat)}
                className={cn(
                  "rounded-full px-2.5 py-0.5 text-xs font-medium border transition-colors",
                  categoryFilter === cat
                    ? "bg-primary text-primary-foreground border-primary"
                    : "border-border text-muted-foreground hover:bg-muted",
                )}
              >
                {cat}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="py-10 text-center">
            <p className="text-sm text-muted-foreground">No items match your search</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-background z-10">
              <tr className="border-b border-border bg-muted/40">
                <th className="text-left px-3 py-2 font-medium text-muted-foreground text-xs">Item</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground text-xs">Category</th>
                <th className="text-right px-3 py-2 font-medium text-muted-foreground text-xs">Price</th>
                <th className="text-left px-3 py-2 font-medium text-muted-foreground text-xs">Unit</th>
                <th className="text-right px-3 py-2 font-medium text-muted-foreground text-xs">Stock/Par</th>
                <th className="text-right px-3 py-2 font-medium text-muted-foreground text-xs">Min Qty</th>
                <th className="text-center px-3 py-2 font-medium text-muted-foreground text-xs w-32">Qty</th>
                <th className="text-right px-3 py-2 font-medium text-muted-foreground text-xs">Line Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((ci) => {
                const cartEntry = cartItems.get(cartKey(ci));
                const inCart = cartEntry !== undefined && parseFloat(cartEntry.quantity) > 0;
                const itemCurrency = ci.currency || currency;
                const priceDisplay = ci.price
                  ? `${itemCurrency} ${parseFloat(ci.price).toFixed(2)}`
                  : "—";
                const qty = parseFloat(cartEntry?.quantity ?? "0") || 0;
                const price = parseFloat(ci.price ?? "0") || 0;
                const lineTotal = qty * price;
                const stockNum = ci.current_stock != null ? parseFloat(ci.current_stock) : null;
                const parNum = ci.par_level != null ? parseFloat(ci.par_level) : null;
                const isLow = stockNum != null && parNum != null && stockNum < parNum;

                return (
                  <tr
                    key={ci.id}
                    className={cn(
                      "hover:bg-muted/20 transition-colors",
                      inCart && "bg-primary/5",
                    )}
                  >
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        {inCart && <Star size={11} className="text-primary shrink-0 fill-primary" />}
                        <div className="min-w-0">
                          <p className="font-medium text-xs leading-snug truncate">{ci.name}</p>
                          {ci.supplier_item_code && (
                            <p className="text-[10px] text-muted-foreground font-mono">{ci.supplier_item_code}</p>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{ci.category || "—"}</td>
                    <td className="px-3 py-2 text-right text-xs font-medium whitespace-nowrap">{priceDisplay}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{ci.unit || "—"}</td>
                    <td className="px-3 py-2 text-right text-xs whitespace-nowrap">
                      {stockNum != null ? (
                        <span className={cn(isLow ? "text-yellow-600 font-medium" : "text-muted-foreground")}>
                          {stockNum % 1 === 0 ? stockNum : stockNum.toFixed(1)}
                          {parNum != null && ` / ${parNum % 1 === 0 ? parNum : parNum.toFixed(1)}`}
                        </span>
                      ) : "—"}
                    </td>
                    <td className="px-3 py-2 text-right text-xs text-muted-foreground whitespace-nowrap">
                      {ci.min_order_quantity && parseFloat(ci.min_order_quantity) !== 1
                        ? parseFloat(ci.min_order_quantity) % 1 === 0
                          ? parseFloat(ci.min_order_quantity)
                          : parseFloat(ci.min_order_quantity).toFixed(1)
                        : "—"}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-center gap-1">
                        <button
                          type="button"
                          className="h-6 w-6 rounded border border-border flex items-center justify-center text-muted-foreground hover:bg-muted transition-colors text-sm font-bold"
                          onClick={() => {
                            const cur = parseFloat(cartEntry?.quantity ?? "0") || 0;
                            if (cur > 0) onQtyChange(ci, String(cur - 1));
                          }}
                        >
                          −
                        </button>
                        <Input
                          type="number"
                          min="0"
                          step="1"
                          inputMode="numeric"
                          aria-label={`Quantity for ${ci.name}`}
                          className="h-7 w-16 text-center text-sm px-2"
                          value={cartEntry?.quantity ?? "0"}
                          onChange={(e) => onQtyChange(ci, e.target.value)}
                        />
                        <button
                          type="button"
                          className="h-6 w-6 rounded border border-border flex items-center justify-center text-muted-foreground hover:bg-muted transition-colors text-sm font-bold"
                          onClick={() => {
                            const cur = parseFloat(cartEntry?.quantity ?? "0") || 0;
                            onQtyChange(ci, String(cur + 1));
                          }}
                        >
                          +
                        </button>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right text-xs whitespace-nowrap">
                      {inCart && ci.price
                        ? <span className="font-medium">{itemCurrency} {lineTotal.toFixed(2)}</span>
                        : <span className="text-muted-foreground">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create PO Wizard Dialog
// ---------------------------------------------------------------------------
export function CreatePoWizard({
  open,
  onClose,
  onCreated,
  initialSupplier,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
  initialSupplier?: SupplierOption;
}) {
  const { toast } = useToast();

  type Step = "catalog" | "review";
  const [step, setStep] = useState<Step>("catalog");
  const [selectedSupplier, setSelectedSupplier] = useState<SupplierOption | null>(initialSupplier ?? null);
  const [cartItems, setCartItems] = useState<Map<string, CartItem>>(new Map());
  const [settings, setSettings] = useState<OrderSettings>(emptySettings());
  const [attachmentItems, setAttachmentItems] = useState<Array<{ url: string; name: string }>>([]);
  const [attachUploading, setAttachUploading] = useState(false);
  const [vatRateOverridden, setVatRateOverridden] = useState(false);

  const { data: locationsData } = useQuery({
    queryKey: ["/api/locations"],
    queryFn: () => apiFetch<{ locations: { id: number; name: string }[] }>("/api/locations"),
  });
  const selectedLocationName =
    settings.location_id != null
      ? locationsData?.locations.find((l) => l.id === settings.location_id)?.name ??
        `Location #${settings.location_id}`
      : null;

  const createMutation = useCreatePurchaseOrder({
    mutation: {
      onSuccess: () => {
        onCreated();
        handleClose();
        toast({ title: "Purchase order created" });
      },
      onError: (err) => {
        toast({
          title: "Failed to create purchase order",
          description: err instanceof Error ? err.message : undefined,
          variant: "destructive",
        });
      },
    },
  });

  function handleClose() {
    onClose();
    setTimeout(() => {
      setStep("catalog");
      setSelectedSupplier(initialSupplier ?? null);
      setCartItems(new Map());
      setSettings(emptySettings());
      setAttachmentItems([]);
      setVatRateOverridden(false);
    }, 300);
  }

  async function handleAttachFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    setAttachUploading(true);
    try {
      const res = await apiFetch<{ uploadURL: string; objectPath: string }>(
        "/api/storage/uploads/request-url",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: file.name, size: file.size, contentType: file.type || "application/pdf" }),
        },
      );
      const putRes = await fetch(res.uploadURL, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type || "application/octet-stream" },
      });
      if (!putRes.ok) throw new Error("Upload failed");
      setAttachmentItems((prev) => [...prev, { url: res.objectPath, name: file.name }]);
    } catch {
      toast({ title: "Failed to upload attachment", variant: "destructive" });
    } finally {
      setAttachUploading(false);
    }
  }

  function handleQtyChange(item: SupplierCatalogItem, qty: string) {
    setCartItems((prev) => {
      const next = new Map(prev);
      const key = cartKey(item);
      const numQty = parseFloat(qty) || 0;
      if (numQty <= 0) {
        next.delete(key);
      } else {
        next.set(key, {
          supplier_catalog_item_id: resolveSupplierCatalogItemId(item),
          item,
          quantity: qty,
        });
      }
      return next;
    });
  }

  function handleSelectSupplier(supplier: SupplierOption) {
    if (supplier.id !== selectedSupplier?.id) {
      setSelectedSupplier(supplier);
      setCartItems(new Map());
      setVatRateOverridden(false);
      setSettings((s) => ({
        ...s,
        vat_treatment: supplier.default_vat_treatment || "no_vat",
        vat_rate:
          normalizeVatRate(supplier.default_vat_rate) ||
          countryDefaultVatRate(supplier.country),
        payment_terms: supplier.payment_terms || s.payment_terms,
        currency: supplier.currency_pref || s.currency,
      }));
    }
  }

  const cartList = Array.from(cartItems.values());
  const cartTotal = cartList.reduce((sum, ci) => {
    const price = parseFloat(ci.item.price ?? "0") || 0;
    const qty = parseFloat(ci.quantity) || 0;
    return sum + price * qty;
  }, 0);
  const cartTotalQty = cartList.reduce((sum, ci) => sum + (parseFloat(ci.quantity) || 0), 0);

  const activeCartCurrency = cartList[0]?.item.currency ?? settings.currency;

  const hasDefaultVatRate = !!(
    selectedSupplier?.default_vat_rate && parseFloat(selectedSupplier.default_vat_rate) > 0
  );
  const vatRateReadOnly = hasDefaultVatRate && !vatRateOverridden;

  // Preset rates plus any supplier-default / currently-selected rate not in the presets,
  // so the dropdown always has a matching option for the selected value.
  const vatRateOptions = useMemo(() => {
    const set = new Set<string>(PO_VAT_RATE_PRESETS.map(String));
    const supplierDefault = normalizeVatRate(selectedSupplier?.default_vat_rate);
    if (supplierDefault) set.add(supplierDefault);
    const current = normalizeVatRate(settings.vat_rate);
    if (current) set.add(current);
    return Array.from(set).sort((a, b) => Number(a) - Number(b));
  }, [selectedSupplier?.default_vat_rate, settings.vat_rate]);

  const vatRateNum = parseFloat(settings.vat_rate) || 0;
  const validationErrors: string[] = [];
  if (!settings.location_id) validationErrors.push("Select a delivery location.");
  if (settings.vat_treatment !== "no_vat" && vatRateNum <= 0) {
    validationErrors.push("Enter a VAT rate greater than 0%.");
  }
  const canSubmit =
    validationErrors.length === 0 && cartList.length > 0 && !createMutation.isPending;

  const costSummary = computeReviewCostSummary(cartTotal, settings);
  const fmtAmt = (n: number) =>
    n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  function handleGoToReview() {
    if (!selectedSupplier) {
      toast({ title: "Select a supplier first", variant: "destructive" });
      return;
    }
    if (cartList.length === 0) {
      toast({ title: "Add at least one item to your order", variant: "destructive" });
      return;
    }
    setSettings((s) => ({ ...s, currency: activeCartCurrency }));
    setStep("review");
  }

  function handlePlaceOrder() {
    if (!selectedSupplier || createMutation.isPending) return;
    if (settings.location_id == null || validationErrors.length > 0) {
      toast({ title: validationErrors[0] ?? "Please fix the highlighted fields", variant: "destructive" });
      return;
    }

    const vatRate = parseFloat(settings.vat_rate) || 0;

    createMutation.mutate({
      data: {
        supplier_id: selectedSupplier.id,
        location_id: settings.location_id,
        po_number: settings.po_number.trim() || null,
        status: settings.status,
        currency: settings.currency,
        total_amount: null,
        expected_delivery_date: settings.expected_delivery_date || null,
        notes: settings.notes.trim() || null,
        discount_amount: settings.discount_amount.trim() || null,
        delivery_fee_amount: settings.delivery_fee_amount.trim() || null,
        vat_treatment: settings.vat_treatment,
        vat_rate: settings.vat_treatment !== "no_vat" ? String(vatRate) : null,
        payment_terms: settings.payment_terms.trim() || null,
        supplier_reference: settings.supplier_reference.trim() || null,
        attachment_urls: attachmentItems.length > 0 ? JSON.stringify(attachmentItems.map((a) => a.url)) : null,
        line_items: cartList.map((ci) => buildLineItemPayload(ci, settings.currency)),
      },
    });
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); }}>
      <DialogContent
        className="max-w-5xl w-full p-0 gap-0 overflow-hidden"
        style={{
          height: "calc(100dvh - 48px)",
          maxHeight: "calc(100dvh - 48px)",
          // DialogContent is display:grid; its implicit row is content-sized by
          // default, so a tall step body would push the row (and the pinned
          // footer) past the fixed dialog height instead of scrolling. Pinning
          // the single grid row to minmax(0,1fr) clamps the inner flex column to
          // the dialog height so the body's overflow-y-auto actually scrolls.
          gridTemplateRows: "minmax(0, 1fr)",
        }}
      >
        {step === "catalog" ? (
          <div className="flex flex-col h-full">
            <DialogHeader className="px-5 py-4 border-b border-border shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
                  <ShoppingCart size={16} />
                </div>
                <div>
                  <DialogTitle className="text-base font-semibold">New Purchase Order</DialogTitle>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Select a supplier and add items from their catalog
                  </p>
                </div>
              </div>
            </DialogHeader>

            <div className="flex flex-1 min-h-0">
              {/* Left: Supplier list */}
              <div className="w-56 shrink-0 flex flex-col overflow-hidden">
                <div className="px-3 py-2 border-b border-border">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Suppliers</p>
                </div>
                <div className="flex-1 overflow-hidden">
                  <SupplierListPanel
                    selectedId={selectedSupplier?.id ?? null}
                    onSelect={handleSelectSupplier}
                    initialSupplierId={initialSupplier?.id}
                  />
                </div>
              </div>

              {/* Right: Catalog items */}
              <div className="flex-1 flex flex-col overflow-hidden">
                {selectedSupplier ? (
                  <>
                    <div className="px-3 py-2 border-b border-border flex items-center gap-2">
                      <div className="w-5 h-5 rounded-full bg-primary flex items-center justify-center text-[10px] font-bold text-primary-foreground shrink-0">
                        {(selectedSupplier.display_name || selectedSupplier.name).charAt(0).toUpperCase()}
                      </div>
                      <p className="text-xs font-semibold text-muted-foreground">
                        {selectedSupplier.display_name || selectedSupplier.name} — Catalog
                      </p>
                    </div>
                    <div className="flex-1 overflow-hidden">
                      <CatalogItemsPanel
                        supplierId={selectedSupplier.id}
                        supplierName={selectedSupplier.display_name || selectedSupplier.name}
                        cartItems={cartItems}
                        onQtyChange={handleQtyChange}
                        currency={settings.currency}
                      />
                    </div>
                  </>
                ) : (
                  <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-8">
                    <div className="w-14 h-14 rounded-full bg-muted flex items-center justify-center">
                      <ShoppingBag size={24} className="text-muted-foreground" />
                    </div>
                    <div>
                      <p className="font-semibold text-sm">Select a supplier</p>
                      <p className="text-xs text-muted-foreground mt-1">
                        Choose a supplier on the left to browse their catalog items
                      </p>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Sticky bottom cart bar */}
            <div className="border-t border-border bg-background px-5 py-3 shrink-0">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-3 min-w-0">
                  {cartList.length > 0 ? (
                    <>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <ShoppingCart size={15} className="text-primary" />
                        <span className="text-sm font-semibold">
                          {cartList.length} item{cartList.length !== 1 ? "s" : ""}
                        </span>
                      </div>
                      <span className="text-muted-foreground shrink-0">·</span>
                      <span className="text-sm font-medium shrink-0">
                        {cartTotalQty % 1 === 0 ? cartTotalQty : cartTotalQty.toFixed(1)} units
                      </span>
                      <span className="text-muted-foreground shrink-0">·</span>
                      <span className="text-sm font-medium shrink-0">
                        {activeCartCurrency} {cartTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </span>
                      <div className="flex gap-1 flex-wrap max-w-xs overflow-hidden">
                        {cartList.slice(0, 3).map((ci) => (
                          <Badge key={ci.supplier_catalog_item_id} variant="secondary" className="text-[10px] max-w-[120px] truncate">
                            {ci.item.name} ×{ci.quantity}
                          </Badge>
                        ))}
                        {cartList.length > 3 && (
                          <Badge variant="secondary" className="text-[10px]">+{cartList.length - 3} more</Badge>
                        )}
                      </div>
                    </>
                  ) : (
                    <span className="text-sm text-muted-foreground">No items selected</span>
                  )}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <Button variant="outline" size="sm" onClick={handleClose}>Cancel</Button>
                  {cartList.length > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive/70 hover:text-destructive"
                      onClick={() => setCartItems(new Map())}
                    >
                      Clear All
                    </Button>
                  )}
                  <Button
                    size="sm"
                    onClick={handleGoToReview}
                    disabled={cartList.length === 0 || !selectedSupplier}
                    className="gap-1.5"
                  >
                    Review Order
                    <ChevronRight size={14} />
                  </Button>
                </div>
              </div>
            </div>
          </div>
        ) : (
          /* Step 2: Review */
          <div className="flex flex-col h-full">
            <DialogHeader className="px-5 py-4 border-b border-border shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
                  <ShoppingCart size={16} />
                </div>
                <div>
                  <DialogTitle className="text-base font-semibold">Review order</DialogTitle>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Confirm items and set order details
                  </p>
                </div>
              </div>
            </DialogHeader>

            <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 space-y-6">
              {/* Required-field warning banner */}
              {validationErrors.length > 0 && (
                <Alert variant="destructive" className="py-3">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>
                    <p className="font-medium">Before you can create this order:</p>
                    <ul className="mt-1 list-disc pl-4 space-y-0.5">
                      {validationErrors.map((err) => (
                        <li key={err}>{err}</li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}

              {/* Order context summary */}
              <div>
                <h3 className="text-sm font-semibold mb-2">Order summary</h3>
                <div className="rounded-lg border border-border bg-muted/20 px-4 py-3 grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3">
                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Supplier</p>
                    <p className="text-sm font-medium truncate">
                      {selectedSupplier?.display_name || selectedSupplier?.name || (
                        <span className="text-muted-foreground font-normal">Not set</span>
                      )}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Location</p>
                    <p className="text-sm font-medium truncate">
                      {selectedLocationName ?? (
                        <span className="text-destructive font-normal">Not set</span>
                      )}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Currency</p>
                    <p className="text-sm font-medium">{settings.currency}</p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Expected delivery</p>
                    <p className="text-sm font-medium">
                      {settings.expected_delivery_date || (
                        <span className="text-muted-foreground font-normal">Not set</span>
                      )}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Payment terms</p>
                    <p className="text-sm font-medium truncate">
                      {settings.payment_terms || (
                        <span className="text-muted-foreground font-normal">Not set</span>
                      )}
                    </p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Status</p>
                    <span className={cn(
                      "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
                      PO_STATUS_MAP.draft.className,
                    )}>
                      {PO_STATUS_MAP.draft.label}
                    </span>
                  </div>
                </div>
              </div>

              {/* Selected items */}
              <div>
                <div className="flex items-baseline justify-between mb-2">
                  <h3 className="text-sm font-semibold">Selected items</h3>
                  <span className="text-xs text-muted-foreground">
                    {cartList.length} item{cartList.length !== 1 ? "s" : ""}
                  </span>
                </div>
                <div className="rounded-lg border border-border overflow-hidden">
                  <table className="w-full text-sm tabular-nums">
                    <thead>
                      <tr className="border-b border-border bg-muted/40">
                        <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Item</th>
                        <th className="text-left px-3 py-2 text-xs font-medium text-muted-foreground">Code</th>
                        <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground">Unit price</th>
                        <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground w-32">Qty</th>
                        <th className="text-right px-3 py-2 text-xs font-medium text-muted-foreground">Line total</th>
                        <th className="px-3 py-2 w-10" />
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border">
                      {cartList.map((ci) => {
                        const price = parseFloat(ci.item.price ?? "0") || 0;
                        const qty = parseFloat(ci.quantity) || 0;
                        const lineTotal = price * qty;
                        const itemCur = ci.item.currency || settings.currency;
                        return (
                          <tr key={ci.supplier_catalog_item_id} className="hover:bg-muted/20">
                            <td className="px-3 py-2">
                              <p className="font-medium text-xs">{ci.item.name}</p>
                              {ci.item.category && <p className="text-[10px] text-muted-foreground">{ci.item.category}</p>}
                            </td>
                            <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                              {ci.item.supplier_item_code || "—"}
                            </td>
                            <td className="px-3 py-2 text-right text-xs whitespace-nowrap">
                              {ci.item.price ? `${itemCur} ${fmtAmt(price)}` : "—"}
                            </td>
                            <td className="px-3 py-2">
                              <Input
                                type="number"
                                min="0"
                                step="1"
                                inputMode="numeric"
                                aria-label={`Quantity for ${ci.item.name}`}
                                className="h-8 w-24 text-right text-sm pr-7 ml-auto"
                                value={ci.quantity}
                                onChange={(e) => handleQtyChange(ci.item, e.target.value)}
                              />
                            </td>
                            <td className="px-3 py-2 text-right text-xs font-medium whitespace-nowrap">
                              {itemCur} {fmtAmt(lineTotal)}
                            </td>
                            <td className="px-3 py-2 text-right">
                              <button
                                type="button"
                                aria-label={`Remove ${ci.item.name}`}
                                title="Remove item"
                                className="text-muted-foreground hover:text-destructive transition-colors"
                                onClick={() => handleQtyChange(ci.item, "0")}
                              >
                                <Trash2 size={13} />
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-border bg-muted/30">
                        <td colSpan={4} className="px-3 py-2 text-xs font-semibold text-right text-muted-foreground">
                          Order total (sum of line totals)
                        </td>
                        <td className="px-3 py-2 text-right text-sm font-bold whitespace-nowrap">
                          {activeCartCurrency} {fmtAmt(cartTotal)}
                        </td>
                        <td />
                      </tr>
                    </tfoot>
                  </table>
                </div>
                <p className="text-[10px] text-muted-foreground mt-1">
                  Each line total is unit price × quantity. The order total is the sum of all line totals.
                </p>
              </div>

              {/* Cost adjustments */}
              {(() => {
                const cs = costSummary;
                const cur = activeCartCurrency;
                return (
                  <div>
                    <h3 className="text-sm font-semibold mb-2">Cost adjustments</h3>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label className="text-xs">Discount</Label>
                        <div className="relative">
                          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">{cur}</span>
                          <Input
                            type="number"
                            min="0"
                            step="0.01"
                            placeholder="0.00"
                            className="pl-10 text-sm"
                            value={settings.discount_amount}
                            onChange={(e) => setSettings((s) => ({ ...s, discount_amount: e.target.value }))}
                          />
                        </div>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">Delivery fee</Label>
                        <div className="relative">
                          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">{cur}</span>
                          <Input
                            type="number"
                            min="0"
                            step="0.01"
                            placeholder="0.00"
                            className="pl-10 text-sm"
                            value={settings.delivery_fee_amount}
                            onChange={(e) => setSettings((s) => ({ ...s, delivery_fee_amount: e.target.value }))}
                          />
                        </div>
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">VAT treatment</Label>
                        <select
                          className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
                          value={settings.vat_treatment}
                          onChange={(e) =>
                            setSettings((s) => ({
                              ...s,
                              vat_treatment: e.target.value,
                              vat_rate:
                                e.target.value === "no_vat"
                                  ? ""
                                  : s.vat_rate ||
                                    normalizeVatRate(selectedSupplier?.default_vat_rate) ||
                                    countryDefaultVatRate(selectedSupplier?.country),
                            }))
                          }
                        >
                          {Object.entries(VAT_TREATMENT_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                        </select>
                      </div>
                      {settings.vat_treatment !== "no_vat" && (
                        <div className="space-y-1">
                          <div className="flex items-center justify-between">
                            <Label className="text-xs">VAT rate (%)</Label>
                            {hasDefaultVatRate && (
                              vatRateReadOnly ? (
                                <button
                                  type="button"
                                  className="inline-flex items-center gap-1 text-[10px] text-primary hover:underline"
                                  onClick={() => setVatRateOverridden(true)}
                                >
                                  <Pencil size={10} /> Override
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  className="text-[10px] text-muted-foreground hover:underline"
                                  onClick={() => {
                                    setVatRateOverridden(false);
                                    setSettings((s) => ({
                                      ...s,
                                      vat_rate: normalizeVatRate(selectedSupplier?.default_vat_rate),
                                    }));
                                  }}
                                >
                                  Use default
                                </button>
                              )
                            )}
                          </div>
                          <select
                            aria-label="VAT rate (%)"
                            disabled={vatRateReadOnly}
                            className={cn(
                              "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring",
                              vatRateReadOnly && "bg-muted/50 text-muted-foreground",
                            )}
                            value={settings.vat_rate}
                            onChange={(e) => setSettings((s) => ({ ...s, vat_rate: e.target.value }))}
                          >
                            <option value="" disabled>Select a rate…</option>
                            {vatRateOptions.map((r) => (
                              <option key={r} value={r}>{r}%</option>
                            ))}
                          </select>
                        </div>
                      )}
                    </div>

                    {settings.vat_treatment !== "no_vat" && (
                      <p className="flex items-start gap-1.5 text-[10px] text-muted-foreground mt-2">
                        <Info size={12} className="shrink-0 mt-px" />
                        {settings.vat_treatment === "vat_exclusive"
                          ? "VAT is calculated on the subtotal and added on top of the order total."
                          : "The subtotal is treated as already including VAT; the VAT portion is shown for reference and not added again."}
                        {vatRateReadOnly && " Rate defaults from the supplier — choose Override to change it."}
                      </p>
                    )}

                    <div className="mt-3 rounded-lg border border-border overflow-hidden">
                      <div className="divide-y divide-border">
                        <div className="flex justify-between px-4 py-2 text-xs">
                          <span className="text-muted-foreground">Subtotal</span>
                          <span className="font-medium">{cur} {fmtAmt(cs.subtotal)}</span>
                        </div>
                        {cs.discount > 0 && (
                          <div className="flex justify-between px-4 py-2 text-xs">
                            <span className="text-muted-foreground">Discount</span>
                            <span className="font-medium text-destructive">− {cur} {fmtAmt(cs.discount)}</span>
                          </div>
                        )}
                        {cs.deliveryFee > 0 && (
                          <div className="flex justify-between px-4 py-2 text-xs">
                            <span className="text-muted-foreground">Delivery fee</span>
                            <span className="font-medium">+ {cur} {fmtAmt(cs.deliveryFee)}</span>
                          </div>
                        )}
                        {settings.vat_treatment !== "no_vat" && (
                          <div className="flex justify-between px-4 py-2 text-xs">
                            <span className="text-muted-foreground">
                              VAT ({settings.vat_rate || "0"}%
                              {settings.vat_treatment === "vat_inclusive" ? " incl." : ""})
                            </span>
                            <span className="font-medium">
                              {settings.vat_treatment === "vat_inclusive" ? "incl. " : "+ "}
                              {cur} {fmtAmt(cs.vatAmount)}
                            </span>
                          </div>
                        )}
                        <div className="flex justify-between px-4 py-2.5 bg-muted/30">
                          <span className="text-sm font-semibold">Grand total</span>
                          <span className="text-base font-bold">{cur} {fmtAmt(cs.grandTotal)}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* Order details */}
              <div>
                <h3 className="text-sm font-semibold mb-2">Order details</h3>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Location <span className="text-destructive">*</span></Label>
                    <div className={cn(!settings.location_id && "rounded-md ring-1 ring-destructive/60")}>
                      <LocationCombobox
                        value={settings.location_id}
                        onChange={(id) => setSettings((s) => ({ ...s, location_id: id }))}
                      />
                    </div>
                    {!settings.location_id && (
                      <p className="text-[10px] text-destructive">Required</p>
                    )}
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Currency</Label>
                    <select
                      className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
                      value={settings.currency}
                      onChange={(e) => setSettings((s) => ({ ...s, currency: e.target.value }))}
                    >
                      {PO_CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">PO number</Label>
                    <Input
                      placeholder="Auto-generated if blank"
                      value={settings.po_number}
                      onChange={(e) => setSettings((s) => ({ ...s, po_number: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Status</Label>
                    <div className="flex h-9 items-center">
                      <span className={cn(
                        "inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium",
                        PO_STATUS_MAP.draft.className,
                      )}>
                        {PO_STATUS_MAP.draft.label}
                      </span>
                      <span className="ml-2 text-[10px] text-muted-foreground">
                        Set automatically on creation
                      </span>
                    </div>
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Expected delivery date</Label>
                    <Input
                      type="date"
                      value={settings.expected_delivery_date}
                      onChange={(e) => setSettings((s) => ({ ...s, expected_delivery_date: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Payment terms</Label>
                    <Input
                      placeholder="e.g. Net 30"
                      value={settings.payment_terms}
                      onChange={(e) => setSettings((s) => ({ ...s, payment_terms: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-1 col-span-2">
                    <Label className="text-xs">Supplier reference</Label>
                    <Input
                      placeholder="Supplier's quote or reference number"
                      value={settings.supplier_reference}
                      onChange={(e) => setSettings((s) => ({ ...s, supplier_reference: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-1 col-span-2">
                    <Label className="text-xs">Notes</Label>
                    <Textarea
                      placeholder="Optional notes…"
                      className="resize-none h-16 text-sm"
                      value={settings.notes}
                      onChange={(e) => setSettings((s) => ({ ...s, notes: e.target.value }))}
                    />
                  </div>
                </div>
              </div>

              {/* Attachments */}
              <div>
                <h3 className="text-sm font-semibold mb-2">Attachments</h3>
                <div className="space-y-2">
                  {attachmentItems.length > 0 && (
                    <div className="rounded-lg border border-border divide-y divide-border">
                      {attachmentItems.map((att, i) => (
                        <div key={i} className="flex items-center gap-2 px-3 py-2">
                          <Paperclip size={13} className="text-muted-foreground shrink-0" />
                          <span className="text-sm flex-1 truncate min-w-0">{att.name}</span>
                          <button
                            type="button"
                            className="text-muted-foreground hover:text-destructive transition-colors shrink-0"
                            onClick={() => setAttachmentItems((prev) => prev.filter((_, j) => j !== i))}
                          >
                            <X size={13} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  <div>
                    <label
                      className={cn(
                        "inline-flex items-center gap-1.5 cursor-pointer rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground hover:bg-muted transition-colors",
                        attachUploading && "opacity-50 pointer-events-none",
                      )}
                    >
                      {attachUploading ? (
                        <><Loader2 size={13} className="animate-spin" />Uploading…</>
                      ) : (
                        <><Paperclip size={13} />Attach file</>
                      )}
                      <input
                        type="file"
                        className="sr-only"
                        accept="image/jpeg,image/png,image/webp,image/gif,application/pdf"
                        onChange={handleAttachFile}
                        disabled={attachUploading}
                      />
                    </label>
                    <p className="text-[10px] text-muted-foreground mt-1">PDF, JPG, PNG, WebP, GIF — up to 100 MB</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="px-5 py-3 border-t border-border bg-background shrink-0 flex items-center justify-between gap-4">
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setStep("catalog")}
                  disabled={createMutation.isPending}
                >
                  ← Back to catalog
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={handleClose}
                  disabled={createMutation.isPending}
                >
                  Cancel
                </Button>
              </div>
              <div className="flex items-center gap-4">
                <div className="text-right">
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Grand total</p>
                  <p className="text-lg font-bold leading-tight whitespace-nowrap">
                    {activeCartCurrency} {fmtAmt(costSummary.grandTotal)}
                  </p>
                </div>
                <Button
                  size="sm"
                  onClick={handlePlaceOrder}
                  disabled={!canSubmit}
                  className="gap-1.5"
                >
                  {createMutation.isPending ? (
                    <><Loader2 size={13} className="animate-spin" />Creating…</>
                  ) : (
                    <><ShoppingCart size={13} />Create purchase order</>
                  )}
                </Button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
