import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useAuth } from "@clerk/react";
import {
  ArrowLeft,
  CalendarIcon,
  Check,
  CheckCircle2,
  Clock,
  ImageIcon,
  Loader2,
  Lock,
  MapPin,
  Minus,
  Package,
  Plus,
  Search,
  Trash2,
  User,
  X,
} from "lucide-react";
import { format, addDays } from "date-fns";
import { Link, useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCreateManualOrder } from "@workspace/api-client-react";
import { isPermissionError } from "@/lib/permissionError";
import type { CreateOrderInput } from "@workspace/api-client-react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Calendar } from "@/components/ui/calendar";
import { Sheet, SheetPortal } from "@/components/ui/sheet";
import { useToast } from "@/hooks/use-toast";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { apiFetch } from "@/lib/queryClient";
import { imageUrl } from "@/lib/imageUrl";
import { cn } from "@/lib/utils";
import { normalizePersonName } from "@/lib/personName";
import { formatPaymentMethodLabel } from "@/lib/paymentMethodLabel";
import {
  ContactSearchPicker,
  contactDisplayName,
  type WizardContact,
} from "@/components/ContactSearchPicker";

// ── Types ─────────────────────────────────────────────────────────────────────

type ProductRow = {
  id: number;
  name: string;
  price_usd: string;
  price_aed: string;
  main_image_url: string | null;
  main_image_display_url?: string | null;
  main_image_thumbnail_url?: string | null;
  status: string;
  sku: string | null;
  has_input_field: boolean;
  letter_input_enabled: boolean;
};

type ProductsResponse = {
  products: ProductRow[];
  total: number;
  page?: number;
  pageSize?: number;
  totalPages?: number;
};

type CatalogLine = {
  kind: "catalog";
  product: ProductRow;
  quantity: number;
  custom_input: string;
};

type CustomLine = {
  kind: "custom";
  id: string;
  name: string;
  unit_price: number;
  quantity: number;
  production_instructions: string;
  image_url: string | null;
};

type CartLine = CatalogLine | CustomLine;
type CmcOrderDiscountDraft = {
  type: "percent" | "amount";
  value: string;
  reason: string;
  explanation: string;
};

type SectionId = "customer" | "recipient" | "products";

// ── Helpers ───────────────────────────────────────────────────────────────────

function unitPriceFor(product: ProductRow): number {
  const raw = product.price_usd;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function hasPersonalization(product: ProductRow): boolean {
  return Boolean(product.has_input_field || product.letter_input_enabled);
}

function formatSlotRange(startIso: string | null, endIso: string | null): string {
  if (!startIso) return "";
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) return "";
  const fmt = (d: Date) =>
    d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const startLabel = fmt(start);
  if (!endIso) return startLabel;
  const end = new Date(endIso);
  if (Number.isNaN(end.getTime())) return startLabel;
  return `${startLabel} – ${fmt(end)}`;
}

function combineDayAndTime(date: Date | undefined, time: string): string | null {
  if (!date) return null;
  const pad = (n: number) => String(n).padStart(2, "0");
  const dateStr = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const timeStr = time && time.includes(":") ? time : "00:00";
  const d = new Date(`${dateStr}T${timeStr}`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
  return (parts[0]?.[0] ?? "?").toUpperCase();
}

// ── Catalog Sheet panel ───────────────────────────────────────────────────────

const CATALOG_CATEGORIES = [
  { value: "", label: "All" },
  { value: "flowers", label: "Flowers" },
  { value: "gifts", label: "Gifts" },
  { value: "cakes", label: "Cakes" },
  { value: "addons", label: "Add-ons" },
];

export function CatalogSheet({
  open,
  onClose,
  onAdd,
  cartItems,
}: {
  open: boolean;
  onClose: () => void;
  onAdd: (product: ProductRow) => void;
  cartItems: CartLine[];
}) {
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [category, setCategory] = useState("");
  const [page, setPage] = useState(1);
  const { t } = useTranslation();

  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(id);
  }, [search]);

  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, category]);

  const productsQuery = useQuery({
    queryKey: ["cmc-new-order-products", debouncedSearch, category, page],
    enabled: open,
    queryFn: () => {
      const params = new URLSearchParams();
      if (debouncedSearch.trim()) params.set("q", debouncedSearch.trim());
      if (category) params.set("category", category);
      params.set("page", String(page));
      params.set("pageSize", "50");
      return apiFetch<ProductsResponse>(`/api/order-catalog/products?${params.toString()}`);
    },
  });

  const cartQty = (productId: number) => {
    const line = cartItems.find((l) => l.kind === "catalog" && (l as CatalogLine).product.id === productId);
    return line ? line.quantity : 0;
  };

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetPortal>
        {/* No overlay — sheet sits alongside the Order Review panel */}
        <DialogPrimitive.Content
          aria-label={t("orders.co.catalogTitle", "Catalog")}
          className={cn(
            "fixed inset-y-0 right-0 z-50 flex h-full w-full max-w-[420px] flex-col border-l bg-background shadow-xl",
            "lg:right-72 xl:right-80",
            "transition ease-in-out data-[state=closed]:duration-300 data-[state=open]:duration-500",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right",
          )}
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b px-4 py-3 shrink-0">
            <div>
              <p className="text-sm font-semibold">{t("orders.co.catalogTitle", "Catalog")}</p>
              <p className="text-xs text-muted-foreground">Browse and add products</p>
            </div>
            <DialogPrimitive.Close asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8"
                aria-label="Close catalog"
                onClick={onClose}
              >
                <X size={16} />
              </Button>
            </DialogPrimitive.Close>
          </div>

          {/* Search */}
          <div className="px-4 pt-3 pb-2 shrink-0">
            <div className="relative">
              <Search size={14} className="absolute start-2.5 top-2.5 text-muted-foreground" />
              <Input
                className="ps-8 h-9 text-sm"
                placeholder={t("orders.co.searchProducts", "Search products…")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                autoFocus
              />
            </div>
          </div>

          {/* Category tabs */}
          <div className="flex gap-1 px-4 pb-2 shrink-0 overflow-x-auto">
            {CATALOG_CATEGORIES.map((cat) => (
              <button
                key={cat.value}
                type="button"
                onClick={() => setCategory(cat.value)}
                className={cn(
                  "shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors",
                  category === cat.value
                    ? "bg-teal-700 text-white"
                    : "bg-muted text-muted-foreground hover:bg-muted/80",
                )}
              >
                {cat.label}
              </button>
            ))}
          </div>

          {/* Product grid */}
          <div className="flex-1 overflow-y-auto px-4 pb-4">
            {productsQuery.isLoading ? (
              <div className="flex justify-center py-12">
                <Loader2 size={20} className="animate-spin text-muted-foreground" />
              </div>
            ) : productsQuery.isError ? (
              <p className="py-12 text-center text-sm text-destructive">
                {t("orders.co.productsLoadError", "Could not load products. Please try again.")}
              </p>
            ) : (productsQuery.data?.products ?? []).length === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground">
                {t("orders.co.noProducts", "No products found")}
              </p>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3">
                  {(productsQuery.data?.products ?? []).map((p) => {
                    const qty = cartQty(p.id);
                    return (
                      <div
                        key={p.id}
                        className="flex flex-col gap-2 rounded-lg border bg-card p-2.5 hover:border-teal-300 transition-colors"
                      >
                        <div className="h-20 w-full overflow-hidden rounded-md bg-muted">
                          {imageUrl(p.main_image_display_url ?? p.main_image_url) ? (
                            <img
                              src={imageUrl(p.main_image_display_url ?? p.main_image_url)!}
                              alt={p.name}
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <div className="flex h-full w-full items-center justify-center">
                              <Package size={20} className="text-muted-foreground/50" />
                            </div>
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-xs font-medium line-clamp-2 leading-tight">{p.name}</p>
                          <div className="mt-0.5 flex items-center gap-1 flex-wrap">
                            {p.sku && (
                              <span className="inline-flex items-center rounded bg-slate-100 px-1 text-[10px] font-medium text-slate-600">
                                {p.sku}
                              </span>
                            )}
                            <span
                              className={cn(
                                "text-[10px] font-medium",
                                p.status === "active" ? "text-emerald-600" : "text-amber-600",
                              )}
                            >
                              {p.status === "active" ? "In stock" : p.status}
                            </span>
                          </div>
                          <p className="mt-0.5 text-xs font-semibold">USD {unitPriceFor(p).toFixed(2)}</p>
                        </div>
                        <Button
                          type="button"
                          size="sm"
                          className={cn(
                            "w-full h-7 text-xs gap-1",
                            qty > 0
                              ? "bg-teal-700 hover:bg-teal-800 text-white"
                              : "bg-teal-50 text-teal-700 border border-teal-200 hover:bg-teal-100",
                          )}
                          aria-label={`Add ${p.name}`}
                          onClick={() => onAdd(p)}
                        >
                          <Plus size={12} />
                          {qty > 0 ? `Add again (${qty} in cart)` : "Add"}
                        </Button>
                      </div>
                    );
                  })}
                </div>
                {(productsQuery.data?.totalPages ?? 1) > 1 && (
                  <div className="mt-4 flex items-center justify-between">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={page <= 1}
                      onClick={() => setPage((current) => Math.max(1, current - 1))}
                    >
                      Previous
                    </Button>
                    <span className="text-xs text-muted-foreground">
                      Page {productsQuery.data?.page ?? page} of {productsQuery.data?.totalPages}
                    </span>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={page >= (productsQuery.data?.totalPages ?? 1)}
                      onClick={() => setPage((current) => current + 1)}
                    >
                      Next
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>
        </DialogPrimitive.Content>
      </SheetPortal>
    </Sheet>
  );
}

// ── Custom item inline form ───────────────────────────────────────────────────

function CustomItemForm({
  onAdd,
  onClose,
}: {
  onAdd: (line: CustomLine) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [qty, setQty] = useState(1);
  const [instructions, setInstructions] = useState("");
  const [imageUrlState, setImageUrlState] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleUpload = async (file: File) => {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("image", file);
      const res = await fetch("/api/products/upload-image", {
        method: "POST",
        body: fd,
        credentials: "include",
      });
      if (res.ok) {
        const data = (await res.json()) as { url?: string };
        setImageUrlState(data.url ?? null);
      }
    } catch {
      // ignore
    } finally {
      setUploading(false);
    }
  };

  const canAdd = name.trim() && parseFloat(price) > 0 && instructions.trim();

  const handleAdd = () => {
    if (!canAdd) return;
    onAdd({
      kind: "custom",
      id: `custom-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: name.trim(),
      unit_price: parseFloat(price),
      quantity: Math.max(1, qty),
      production_instructions: instructions.trim(),
      image_url: imageUrlState,
    });
    onClose();
  };

  return (
    <div className="rounded-md border p-3 space-y-2.5 bg-violet-50/50">
      <p className="text-xs font-semibold text-violet-700 uppercase tracking-wide">
        {t("orders.co.customItem.title")}
      </p>
      <div className="space-y-1">
        <Label className="text-xs">
          {t("orders.co.customItem.name")} <span className="text-destructive">*</span>
        </Label>
        <Input
          className="h-8 text-sm"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("orders.co.customItem.namePlaceholder")}
          autoFocus
        />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <Label className="text-xs">
            {t("orders.co.customItem.price")} <span className="text-destructive">*</span>
          </Label>
          <Input
            className="h-8 text-sm"
            type="number"
            min="0"
            step="0.01"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="0.00"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t("orders.co.customItem.qty")}</Label>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              size="icon"
              variant="outline"
              className="h-8 w-8 shrink-0"
              aria-label="Decrease quantity"
              onClick={() => setQty((q) => Math.max(1, q - 1))}
            >
              <Minus size={12} />
            </Button>
            <span className="w-8 text-center text-sm font-medium">{qty}</span>
            <Button
              type="button"
              size="icon"
              variant="outline"
              className="h-8 w-8 shrink-0"
              aria-label="Increase quantity"
              onClick={() => setQty((q) => q + 1)}
            >
              <Plus size={12} />
            </Button>
          </div>
        </div>
      </div>
      <div className="space-y-1">
        <Label className="text-xs">
          {t("orders.co.customItem.instructions")} <span className="text-destructive">*</span>
        </Label>
        <Textarea
          className="text-sm min-h-0"
          rows={2}
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder={t("orders.co.customItem.instructionsPlaceholder")}
        />
      </div>
      <div className="space-y-1">
        <Label className="text-xs">{t("orders.co.customItem.image")}</Label>
        {imageUrlState ? (
          <div className="flex items-center gap-2">
            <img
              src={imageUrl(imageUrlState) ?? imageUrlState}
              alt=""
              className="h-10 w-10 rounded object-cover shrink-0 border"
            />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="text-xs h-7"
              onClick={() => {
                setImageUrlState(null);
                if (fileRef.current) fileRef.current.value = "";
              }}
            >
              {t("orders.co.customItem.removeImage")}
            </Button>
          </div>
        ) : (
          <label
            className={cn(
              "flex items-center gap-2 cursor-pointer rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground hover:bg-muted",
              uploading && "opacity-50 pointer-events-none",
            )}
          >
            {uploading ? <Loader2 size={14} className="animate-spin" /> : <ImageIcon size={14} />}
            <span>{uploading ? t("orders.co.customItem.uploading") : t("orders.co.customItem.imagePlaceholder")}</span>
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="sr-only"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleUpload(f);
              }}
            />
          </label>
        )}
      </div>
      <div className="flex gap-2 pt-1">
        <Button type="button" size="sm" variant="ghost" className="text-xs" onClick={onClose}>
          {t("orders.co.cancel")}
        </Button>
        <Button
          type="button"
          size="sm"
          className="text-xs bg-violet-700 hover:bg-violet-800 text-white"
          disabled={!canAdd}
          onClick={handleAdd}
        >
          {t("orders.co.customItem.add")}
        </Button>
      </div>
    </div>
  );
}

// ── Review panel helpers ──────────────────────────────────────────────────────

function AvatarChip({ name, color = "teal" }: { name: string; color?: "teal" | "violet" }) {
  const colors = {
    teal: "bg-teal-100 text-teal-800",
    violet: "bg-violet-100 text-violet-800",
  };
  return (
    <span
      className={cn(
        "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold",
        colors[color],
      )}
    >
      {initials(name)}
    </span>
  );
}

function ChecklistItem({
  label,
  done,
}: {
  label: string;
  done: boolean;
}) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <div
        className={cn(
          "flex h-4 w-4 shrink-0 items-center justify-center rounded-full",
          done ? "bg-emerald-500" : "bg-amber-400",
        )}
      >
        {done ? (
          <Check size={10} className="text-white" />
        ) : (
          <X size={10} className="text-white" />
        )}
      </div>
      <span className={done ? "text-foreground" : "text-amber-700"}>{label}</span>
    </div>
  );
}

// ── Section card wrapper ──────────────────────────────────────────────────────

function SectionCard({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-xl border bg-card shadow-sm transition-all duration-200", className)}>
      {children}
    </section>
  );
}

// ── Delivery slot constants ───────────────────────────────────────────────────

const DELIVERY_SLOTS = [
  { label: "9–11 AM", start: "09:00", end: "11:00" },
  { label: "11 AM–1 PM", start: "11:00", end: "13:00" },
  { label: "2–4 PM", start: "14:00", end: "16:00" },
  { label: "4–6 PM", start: "16:00", end: "18:00" },
  { label: "6–8 PM", start: "18:00", end: "20:00" },
] as const;

type DeliverySlot = (typeof DELIVERY_SLOTS)[number];

const CMC_PAYMENT_METHODS = [
  { value: "cash", icon: "💵" },
  { value: "card", icon: "💳" },
  { value: "whish", icon: "💸" },
] as const;

type CmcPaymentMethod = (typeof CMC_PAYMENT_METHODS)[number]["value"];

// ── DeliveryDateTimePicker ────────────────────────────────────────────────────

function DeliveryDateTimePicker({
  day,
  startTime,
  endTime,
  onConfirm,
  onClear,
}: {
  day: Date | undefined;
  startTime: string;
  endTime: string;
  onConfirm: (day: Date, start: string, end: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [pickerDay, setPickerDay] = useState<Date | undefined>(day);
  const [pickerSlot, setPickerSlot] = useState<DeliverySlot | null>(
    DELIVERY_SLOTS.find((s) => s.start === startTime && s.end === endTime) ?? null,
  );
  const [calendarMonth, setCalendarMonth] = useState<Date>(day ?? new Date());

  // Sync internal state when external values are cleared or changed externally
  useEffect(() => {
    setPickerDay(day);
    setPickerSlot(
      DELIVERY_SLOTS.find((s) => s.start === startTime && s.end === endTime) ?? null,
    );
    if (day) setCalendarMonth(day);
  }, [day, startTime, endTime]);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = addDays(today, 1);
  const nextAvailable = addDays(today, 2);

  const quickDays = [
    { label: "Today", date: today },
    { label: "Tomorrow", date: tomorrow },
    { label: "Next available", date: nextAvailable },
  ];

  const confirmedSlot =
    day && startTime && endTime
      ? DELIVERY_SLOTS.find((s) => s.start === startTime && s.end === endTime) ?? null
      : null;

  const dayLabel = day ? format(day, "EEE, d MMM") : "Delivery day";
  const timeLabel = confirmedSlot?.label ?? "Delivery time";

  const canConfirm = pickerDay != null && pickerSlot != null;

  const footerLabel =
    pickerDay && pickerSlot
      ? `${format(pickerDay, "EEE, d MMM")}  ${pickerSlot.label}`
      : pickerDay
        ? format(pickerDay, "EEE, d MMM")
        : "";

  const handleOpen = () => {
    // Reset internal picker to currently confirmed values when reopening
    setPickerDay(day);
    setPickerSlot(
      DELIVERY_SLOTS.find((s) => s.start === startTime && s.end === endTime) ?? null,
    );
    if (day) setCalendarMonth(day);
    setOpen(true);
  };

  const handleConfirm = () => {
    if (!canConfirm) return;
    onConfirm(pickerDay!, pickerSlot!.start, pickerSlot!.end);
    setOpen(false);
  };

  const handleClear = () => {
    setPickerDay(undefined);
    setPickerSlot(null);
    onClear();
    setOpen(false);
  };

  const setPickerDayAndMonth = (d: Date | undefined) => {
    setPickerDay(d);
    setPickerSlot(null);
    if (d) setCalendarMonth(d);
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Label className="text-sm font-semibold">
          Delivery date &amp; time <span className="text-destructive">*</span>
        </Label>
        {(day || startTime) && (
          <button
            type="button"
            className="ms-auto flex items-center gap-0.5 text-xs text-muted-foreground hover:text-foreground"
            onClick={handleClear}
            aria-label="Clear delivery date and time"
          >
            <X size={12} /> Clear
          </button>
        )}
      </div>

      {/* Collapsed trigger — two side-by-side buttons */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={handleOpen}
          className={cn(
            "flex flex-1 items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors hover:bg-muted/50",
            day ? "text-foreground" : "text-muted-foreground",
            open && "border-teal-400 ring-1 ring-teal-400",
          )}
        >
          <CalendarIcon size={14} className="shrink-0 text-muted-foreground" />
          <span className="truncate">{dayLabel}</span>
          {day && <CheckCircle2 size={13} className="ms-auto shrink-0 text-emerald-500" />}
        </button>
        <button
          type="button"
          onClick={handleOpen}
          className={cn(
            "flex flex-1 items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors hover:bg-muted/50",
            confirmedSlot ? "text-foreground" : "text-muted-foreground",
            open && "border-teal-400 ring-1 ring-teal-400",
          )}
        >
          <Clock size={14} className="shrink-0 text-muted-foreground" />
          <span className="truncate">{timeLabel}</span>
          {confirmedSlot && <CheckCircle2 size={13} className="ms-auto shrink-0 text-emerald-500" />}
        </button>
      </div>

      {/* Hidden inputs for test automation */}
      <input type="hidden" data-testid="new-order-start-time" value={startTime} readOnly />
      <input type="hidden" data-testid="new-order-end-time" value={endTime} readOnly />

      {/* Expanded panel */}
      {open && (
        <div className="rounded-xl border bg-card shadow-md overflow-hidden">
          {/* Quick-day tabs */}
          <div className="flex gap-1.5 border-b px-3 py-2.5">
            {quickDays.map((qd) => {
              const isActive =
                pickerDay != null &&
                format(pickerDay, "yyyy-MM-dd") === format(qd.date, "yyyy-MM-dd");
              return (
                <button
                  key={qd.label}
                  type="button"
                  onClick={() => setPickerDayAndMonth(qd.date)}
                  className={cn(
                    "shrink-0 rounded-full px-3 py-1 text-xs font-medium transition-colors",
                    isActive
                      ? "bg-teal-700 text-white"
                      : "bg-muted text-muted-foreground hover:bg-muted/80",
                  )}
                >
                  {qd.label}
                </button>
              );
            })}
          </div>

          <div
            className={cn(
              "flex flex-col sm:flex-row",
              pickerDay && "sm:grid sm:grid-cols-[55fr_45fr]",
            )}
          >
            {/* Left: full-month calendar */}
            <div
              className={cn(
                "border-b sm:border-b-0 sm:border-e",
                pickerDay ? "" : "w-full",
              )}
            >
              <Calendar
                mode="single"
                selected={pickerDay}
                onSelect={setPickerDayAndMonth}
                month={calendarMonth}
                onMonthChange={setCalendarMonth}
                className="w-full p-2 [&_.rdp-month]:w-full [&_.rdp-table]:w-full"
              />
              {/* Availability legend */}
              <div className="flex items-center justify-center gap-4 border-t px-3 py-2 text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  Available
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-400" />
                  Low capacity
                </span>
                <span className="flex items-center gap-1">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-slate-300" />
                  Unavailable
                </span>
              </div>
            </div>

            {/* Right: slot column — only rendered when a date is selected */}
            {pickerDay && (
              <div className="flex w-full flex-col gap-2 p-3">
                <p className="text-xs font-semibold text-foreground">
                  {format(pickerDay, "EEEE, d MMMM")}
                </p>
                <p className="text-xs text-muted-foreground">Choose an available time</p>
                <div className="mt-0.5 flex flex-col gap-1.5">
                  {DELIVERY_SLOTS.map((slot) => {
                    const isSelected = pickerSlot?.start === slot.start;
                    return (
                      <button
                        key={slot.start}
                        type="button"
                        onClick={() => setPickerSlot(slot)}
                        className={cn(
                          "rounded-lg border px-3 py-2 text-start text-sm font-medium transition-colors",
                          isSelected
                            ? "border-teal-700 bg-teal-700 text-white"
                            : "border-input bg-background text-foreground hover:bg-muted/50",
                        )}
                      >
                        {slot.label}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground">
                  <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" />
                  Good availability
                </p>
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between gap-3 border-t bg-muted/30 px-3 py-2.5">
            <span className="truncate text-sm text-muted-foreground">
              {footerLabel || "No date selected"}
            </span>
            <Button
              type="button"
              size="sm"
              className="shrink-0 bg-teal-700 text-xs text-white hover:bg-teal-800"
              disabled={!canConfirm}
              onClick={handleConfirm}
            >
              Confirm delivery
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function CmcPosNewOrderPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { userId } = useAuth();
  const { isOwner, allowedPages } = useWorkspaceRole();
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();

  // ── Customer ──────────────────────────────────────────────────────────────
  const [selectedCustomer, setSelectedCustomer] = useState<WizardContact | null>(null);
  const [isNewCustomerForm, setIsNewCustomerForm] = useState(false);
  const [custName, setCustName] = useState("");
  const [custPhone, setCustPhone] = useState("");
  const [custEmail, setCustEmail] = useState("");
  const [custTouched, setCustTouched] = useState(false);

  const handleSelectCustomer = (c: WizardContact | null) => {
    const normalized = c
      ? {
          ...c,
          first_name: normalizePersonName(c.first_name),
          last_name: normalizePersonName(c.last_name),
          display_name: normalizePersonName(c.display_name),
        }
      : null;
    setSelectedCustomer((prev) => {
      if (prev?.id !== normalized?.id) {
        // Customer identity changed — clear all recipient state so stale
        // recName/recPhone don't leave recipientVerified as true.
        setSelectedRecipient(null);
        setIsNewRecipientForm(false);
        setRecName("");
        setRecPhone("");
        setRecTouched(false);
        setDeliveryAddress("");
        setDeliveryDay(undefined);
        setDeliveryStartTime("");
        setDeliveryEndTime("");
      }
      return normalized;
    });
    setIsNewCustomerForm(false);
    setCustTouched(false);
    if (normalized) {
      setCustName(contactDisplayName(normalized));
      setCustPhone(normalized.phone ?? "");
      setCustEmail(normalized.email ?? "");
    } else {
      setCustName("");
      setCustPhone("");
      setCustEmail("");
    }
    // Clear edit override when a selection is made
    setEditingSection((prev) => (prev === "customer" ? null : prev));
  };

  // ── Recipient ─────────────────────────────────────────────────────────────
  const [selectedRecipient, setSelectedRecipient] = useState<WizardContact | null>(null);
  const [isNewRecipientForm, setIsNewRecipientForm] = useState(false);
  const [recName, setRecName] = useState("");
  const [recPhone, setRecPhone] = useState("");
  const [recTouched, setRecTouched] = useState(false);

  const handleSelectRecipient = (c: WizardContact | null) => {
    const normalized = c
      ? {
          ...c,
          first_name: normalizePersonName(c.first_name),
          last_name: normalizePersonName(c.last_name),
          display_name: normalizePersonName(c.display_name),
        }
      : null;
    setSelectedRecipient(normalized);
    setIsNewRecipientForm(false);
    setRecTouched(false);
    if (normalized) {
      setRecName(contactDisplayName(normalized));
      setRecPhone(normalized.phone ?? "");
    } else {
      setRecName("");
      setRecPhone("");
    }
    // Prefill card "To" with recipient's first name — only when the user has not manually edited it.
    // Do NOT reset cardToEdited here; a manual value must survive recipient changes.
    if (!cardToEdited) {
      if (normalized) {
        const firstName = normalized.first_name?.trim() || contactDisplayName(normalized).split(" ")[0] || "";
        setCardTo(firstName);
      } else {
        setCardTo("");
      }
    }
    // Clear edit override when a selection is made
    setEditingSection((prev) => (prev === "recipient" ? null : prev));
  };

  // ── Delivery ──────────────────────────────────────────────────────────────
  const [deliveryAddress, setDeliveryAddress] = useState("");
  const [deliveryDay, setDeliveryDay] = useState<Date | undefined>(undefined);
  const [deliveryStartTime, setDeliveryStartTime] = useState("");
  const [deliveryEndTime, setDeliveryEndTime] = useState("");

  // ── Cart ──────────────────────────────────────────────────────────────────
  const [cart, setCart] = useState<CartLine[]>([]);
  const [showCatalog, setShowCatalog] = useState(false);
  const [showCustomForm, setShowCustomForm] = useState(false);

  const addToCart = (product: ProductRow) => {
    setCart((prev) => {
      const existing = prev.find((l) => l.kind === "catalog" && l.product.id === product.id);
      if (existing) {
        return prev.map((l) =>
          l.kind === "catalog" && l.product.id === product.id
            ? { ...l, quantity: l.quantity + 1 }
            : l,
        );
      }
      return [...prev, { kind: "catalog", product, quantity: 1, custom_input: "" }];
    });
  };

  const addCustomLine = (line: CustomLine) => setCart((prev) => [...prev, line]);

  const setQty = (productId: number, delta: number) => {
    setCart((prev) =>
      prev
        .map((l) =>
          l.kind === "catalog" && l.product.id === productId
            ? { ...l, quantity: Math.max(0, l.quantity + delta) }
            : l,
        )
        .filter((l) => l.quantity > 0),
    );
  };

  const setCustomLineQty = (id: string, delta: number) => {
    setCart((prev) =>
      prev
        .map((l) =>
          l.kind === "custom" && l.id === id
            ? { ...l, quantity: Math.max(0, l.quantity + delta) }
            : l,
        )
        .filter((l) => l.quantity > 0),
    );
  };

  const setCustomInput = (productId: number, value: string) => {
    setCart((prev) =>
      prev.map((l) =>
        l.kind === "catalog" && l.product.id === productId ? { ...l, custom_input: value } : l,
      ),
    );
  };

  const setLineQtyDirect = (key: string | number, value: number, kind: "catalog" | "custom") => {
    const qty = Math.max(1, value);
    setCart((prev) =>
      prev.map((l) =>
        kind === "catalog"
          ? l.kind === "catalog" && l.product.id === (key as number)
            ? { ...l, quantity: qty }
            : l
          : l.kind === "custom" && l.id === (key as string)
            ? { ...l, quantity: qty }
            : l,
      ),
    );
  };

  const removeLine = (productId: number) =>
    setCart((prev) => prev.filter((l) => !(l.kind === "catalog" && l.product.id === productId)));

  const removeCustomLine = (id: string) =>
    setCart((prev) => prev.filter((l) => !(l.kind === "custom" && l.id === id)));

  // ── Card message ──────────────────────────────────────────────────────────
  const [cardMessage, setCardMessage] = useState("");
  const [cardFrom, setCardFrom] = useState("");
  const [cardTo, setCardTo] = useState("");
  const [cardToEdited, setCardToEdited] = useState(false);

  // ── Payment ───────────────────────────────────────────────────────────────
  const [paymentMethod, setPaymentMethod] = useState<CmcPaymentMethod>("cash");
  const [internalNote, setInternalNote] = useState("");
  const [discount, setDiscount] = useState<CmcOrderDiscountDraft | null>(null);
  const [showDiscountEditor, setShowDiscountEditor] = useState(false);
  const draftHydrated = useRef(false);
  const idempotencyKey = useRef(
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `cmc-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  // ── Derived ───────────────────────────────────────────────────────────────
  const windowStartIso = combineDayAndTime(deliveryDay, deliveryStartTime);
  const windowEndIso =
    deliveryDay && deliveryEndTime ? combineDayAndTime(deliveryDay, deliveryEndTime) : null;

  const subtotal = useMemo(
    () =>
      cart.reduce((s, l) => {
        if (l.kind === "catalog") return s + unitPriceFor(l.product) * l.quantity;
        return s + l.unit_price * l.quantity;
      }, 0),
    [cart],
  );
  const canApplyDiscount = isOwner || !!allowedPages?.includes("cmc_pos.discount");
  const discountValue = Number(discount?.value);
  const discountReason = discount?.reason.trim() ?? "";
  const discountExplanation = discount?.explanation.trim() ?? "";
  const discountValueValid =
    discount != null &&
    Number.isFinite(discountValue) &&
    discountValue > 0 &&
    (discount.type === "percent" ? discountValue <= 100 : discountValue <= subtotal);
  const discountValid =
    discount == null ||
    (discountValueValid &&
      discountReason.length > 0 &&
      (discountReason.toLowerCase() !== "other" || discountExplanation.length > 0));
  const discountAmount =
    discount && discountValueValid
      ? Math.min(
          subtotal,
          Math.round(
            (discount.type === "percent" ? (subtotal * discountValue) / 100 : discountValue) * 100,
          ) / 100,
        )
      : 0;
  const netTotal = Math.max(0, Math.round((subtotal - discountAmount) * 100) / 100);
  const discountError =
    discount == null || discountValid
      ? null
      : !discountValueValid
        ? discount?.type === "percent" && discountValue > 100
          ? "Percentage cannot exceed 100%."
          : "Enter a positive value that does not exceed the items subtotal."
        : !discountReason
          ? "Choose a reason for this discount."
          : "Explain why this discount is Other.";

  // Delivery window validation (mirrors CreateOrderWizard)
  const windowValid =
    !windowStartIso ||
    !windowEndIso ||
    new Date(windowEndIso).getTime() > new Date(windowStartIso).getTime();

  const isPastDeliveryDay = !!deliveryDay && (() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const day = new Date(deliveryDay);
    day.setHours(0, 0, 0, 0);
    return day.getTime() < today.getTime();
  })();

  // Checklist
  const customerLinked = selectedCustomer != null
    ? true
    : isNewCustomerForm
      ? custName.trim().length > 0 && custPhone.trim().length > 0 && custEmail.trim().length > 0
      : false;
  const recipientVerified = selectedRecipient != null
    ? true
    : isNewRecipientForm
      ? recName.trim().length > 0 && recPhone.trim().length > 0
      : false;
  const deliveryScheduled =
    deliveryDay != null && deliveryStartTime.length > 0 && deliveryEndTime.length > 0;
  const paymentSelected = true; // always has a default

  const canCreate =
    customerLinked &&
    recipientVerified &&
    deliveryScheduled &&
    windowValid &&
    cart.length > 0 &&
    discountValid;

  // ── Active section state machine ──────────────────────────────────────────
  // Derived "auto" section: the first incomplete required section
  const derivedSection: SectionId = !customerLinked
    ? "customer"
    : !recipientVerified || !deliveryScheduled
    ? "recipient"
    : "products";

  // User can force-open a completed section for editing
  const [editingSection, setEditingSection] = useState<"customer" | "recipient" | null>(null);

  const activeSection: SectionId = editingSection ?? derivedSection;

  // Keep the CMC order draft scoped to the signed-in staff member. This is
  // intentionally real form state (not only cart state) so a refresh does not
  // discard a prepared discount or customer/recipient details.
  const draftKey = `cmc-pos-new-order-draft:${userId ?? "anonymous"}`;
  useEffect(() => {
    if (draftHydrated.current) return;
    try {
      const raw = localStorage.getItem(draftKey);
      if (raw) {
        const saved = JSON.parse(raw) as Record<string, unknown>;
        if (Array.isArray(saved.cart)) setCart(saved.cart as CartLine[]);
        if (saved.selectedCustomer && typeof saved.selectedCustomer === "object") {
          setSelectedCustomer(saved.selectedCustomer as WizardContact);
        } else if (saved.isNewCustomerForm === true) {
          setIsNewCustomerForm(true);
        }
        if (saved.selectedRecipient && typeof saved.selectedRecipient === "object") {
          setSelectedRecipient(saved.selectedRecipient as WizardContact);
        } else if (saved.isNewRecipientForm === true) {
          setIsNewRecipientForm(true);
        }
        if (typeof saved.custName === "string") setCustName(saved.custName);
        if (typeof saved.custPhone === "string") setCustPhone(saved.custPhone);
        if (typeof saved.custEmail === "string") setCustEmail(saved.custEmail);
        if (typeof saved.recName === "string") setRecName(saved.recName);
        if (typeof saved.recPhone === "string") setRecPhone(saved.recPhone);
        if (typeof saved.deliveryAddress === "string") setDeliveryAddress(saved.deliveryAddress);
        if (typeof saved.deliveryDay === "string") {
          const day = new Date(saved.deliveryDay);
          if (!Number.isNaN(day.getTime())) setDeliveryDay(day);
        }
        if (typeof saved.deliveryStartTime === "string") setDeliveryStartTime(saved.deliveryStartTime);
        if (typeof saved.deliveryEndTime === "string") setDeliveryEndTime(saved.deliveryEndTime);
        if (typeof saved.cardMessage === "string") setCardMessage(saved.cardMessage);
        if (typeof saved.cardFrom === "string") setCardFrom(saved.cardFrom);
        if (typeof saved.cardTo === "string") setCardTo(saved.cardTo);
        // Restore the edited flag directly — do not infer it from presence; old drafts without the
        // flag default to false so recipient changes can still auto-update the field.
        if (typeof saved.cardToEdited === "boolean") setCardToEdited(saved.cardToEdited);
        if (typeof saved.internalNote === "string") setInternalNote(saved.internalNote);
        if (
          saved.paymentMethod === "cash" ||
          saved.paymentMethod === "card" ||
          saved.paymentMethod === "whish"
        ) {
          setPaymentMethod(saved.paymentMethod);
        }
        if (saved.discount && typeof saved.discount === "object") {
          const restored = saved.discount as Partial<CmcOrderDiscountDraft>;
          if (
            (restored.type === "percent" || restored.type === "amount") &&
            typeof restored.value === "string" &&
            typeof restored.reason === "string" &&
            typeof restored.explanation === "string"
          ) {
            setDiscount(restored as CmcOrderDiscountDraft);
          }
        }
        if (saved.showDiscountEditor === true) setShowDiscountEditor(true);
      }
    } catch {
      // A malformed old draft should never prevent starting a new order.
      localStorage.removeItem(draftKey);
    } finally {
      draftHydrated.current = true;
    }
  }, [draftKey]);
  useEffect(() => {
    if (!draftHydrated.current) return;
    localStorage.setItem(
      draftKey,
      JSON.stringify({
        cart,
        selectedCustomer, selectedRecipient, isNewCustomerForm, isNewRecipientForm,
        custName, custPhone, custEmail, recName, recPhone, deliveryAddress,
        deliveryDay: deliveryDay?.toISOString() ?? null,
        deliveryStartTime, deliveryEndTime, cardMessage, cardFrom, cardTo, cardToEdited,
        paymentMethod, internalNote, discount, showDiscountEditor,
      }),
    );
  }, [
    cart, selectedCustomer, selectedRecipient, isNewCustomerForm, isNewRecipientForm,
    custName, custPhone, custEmail, recName, recPhone, deliveryAddress, deliveryDay,
    deliveryStartTime, deliveryEndTime, cardMessage, cardFrom, cardTo, cardToEdited, paymentMethod,
    internalNote, discount, showDiscountEditor, draftKey,
  ]);

  // Section display helpers
  const customerIsActive = activeSection === "customer";
  const customerIsComplete = customerLinked && activeSection !== "customer";

  const recipientIsLocked = !customerLinked;
  const recipientIsActive = !recipientIsLocked && activeSection === "recipient";
  const recipientIsComplete =
    !recipientIsLocked && recipientVerified && deliveryScheduled && activeSection !== "recipient";

  const productsIsLocked = !customerLinked || !recipientVerified || !deliveryScheduled;
  const productsIsActive = !productsIsLocked && activeSection === "products";

  // ── Submission ────────────────────────────────────────────────────────────
  const createMut = useCreateManualOrder();

  const buildPayload = (): CreateOrderInput => {
    const customer: CreateOrderInput["customer"] = selectedCustomer
      ? { contact_id: selectedCustomer.id }
      : {
          display_name: normalizePersonName(custName),
          email: custEmail.trim() || null,
          phone: custPhone.trim() || null,
        };

    let recipient: CreateOrderInput["recipient"] = null;
    if (selectedRecipient) {
      recipient = { contact_id: selectedRecipient.id };
    } else if (recName.trim() || recPhone.trim()) {
      recipient = { display_name: normalizePersonName(recName), phone: recPhone.trim() || null };
    }

    const address: Record<string, unknown> = {};
    if (deliveryAddress.trim()) address.address = deliveryAddress.trim();
    if (windowStartIso) {
      const startDate = new Date(windowStartIso);
      const pad = (n: number) => String(n).padStart(2, "0");
      address.date = `${startDate.getFullYear()}-${pad(startDate.getMonth() + 1)}-${pad(startDate.getDate())}`;
      const slot = formatSlotRange(windowStartIso, windowEndIso);
      if (slot) address.slot = slot;
    }

    return {
      // 'cmc-pos' tags the order as CMC-originated: the server also records a
      // matching CMC Sales entry (workflow_type='order') dated by creation.
      source: "cmc-pos",
      status: "pending",
      customer,
      recipient,
      line_items: cart.map((l) => {
        if (l.kind === "catalog") {
          return {
            product_id: l.product.id,
            sku: l.product.sku ?? null,
            name: l.product.name,
            quantity: l.quantity,
            unit_price: unitPriceFor(l.product),
            image_url: l.product.main_image_url ?? null,
            custom_input: l.custom_input.trim() ? l.custom_input.trim() : null,
            is_custom_item: false,
            production_instructions: null,
            custom_item_created_by: null,
          };
        }
        return {
          product_id: null,
          sku: null,
          name: l.name,
          quantity: l.quantity,
          unit_price: l.unit_price,
          image_url: l.image_url,
          custom_input: null,
          is_custom_item: true,
          production_instructions: l.production_instructions || null,
          custom_item_created_by: userId ?? null,
        };
      }),
      delivery_address: Object.keys(address).length > 0 ? address : null,
      delivery_instructions: null,
      window_start: windowStartIso,
      window_end: windowEndIso,
      card_message: cardMessage.trim() || null,
      card_from: normalizePersonName(cardFrom),
      card_to: normalizePersonName(cardTo),
       totals: { subtotal, discount: discountAmount, total: netTotal, currency: "USD" },
       discount:
         discount && discountValid
           ? {
               type: discount.type,
               value: discountValue,
               reason: discountReason,
               explanation: discountExplanation || null,
             }
           : null,
       idempotency_key: idempotencyKey.current,
      payment: { method: paymentMethod, status: "pending", currency: "USD" },
      notes: internalNote.trim() ? { internal_note: internalNote.trim() } : null,
    };
  };

  const handleCreate = () => {
    if (isNewCustomerForm) setCustTouched(true);
    if (isNewRecipientForm) setRecTouched(true);
    if (!canCreate) return;
    createMut.mutate(
      { data: buildPayload() },
      {
        onSuccess: (data) => {
           localStorage.removeItem(draftKey);
          toast({ title: t("orders.co.created") });
          queryClient.invalidateQueries({ queryKey: ["cmc-pos-metrics"] });
          queryClient.invalidateQueries({ queryKey: ["cmc-pos-history"] });
          queryClient.invalidateQueries({ queryKey: ["cmc-pos-sales"] });
          navigate(`/orders/${data.id}`);
        },
        onError: (err) => {
          const serverMessage =
            err != null &&
            typeof err === "object" &&
            "message" in err &&
            typeof (err as { message?: unknown }).message === "string" &&
            (err as { message: string }).message.trim()
              ? (err as { message: string }).message
              : t("orders.co.createError");
          if (isPermissionError(err)) {
            toast({
              title: t("cmcPos.noPermission"),
              description: serverMessage,
              variant: "destructive",
            });
            return;
          }
          toast({
            title: t("orders.co.createError"),
            description: serverMessage,
            variant: "destructive",
          });
        },
      },
    );
  };

  // ── Keyboard shortcut: Enter to create ────────────────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        e.key === "Enter" &&
        (e.metaKey || e.ctrlKey) &&
        canCreate &&
        !createMut.isPending
      ) {
        e.preventDefault();
        handleCreate();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canCreate, createMut.isPending]);

  // ── Derived display values ─────────────────────────────────────────────────

  const reviewCustomerName = selectedCustomer
    ? contactDisplayName(selectedCustomer)
    : normalizePersonName(custName) || "";

  const reviewRecipientName = selectedRecipient
    ? contactDisplayName(selectedRecipient)
    : normalizePersonName(recName) || "";

  // CTA label for disabled state
  const ctaBlockerLabel =
    !customerLinked || !recipientVerified || !deliveryScheduled
      ? "Complete required details"
      : cart.length === 0
        ? "Add at least one item"
        : "Complete all required fields";

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex h-full flex-col">
      {/* ── Top bar ────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3 border-b bg-background px-4 py-3 sm:px-6">
        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" asChild>
          <Link href="/cmc-pos">
            <ArrowLeft className="h-4 w-4" />
          </Link>
        </Button>
        <div>
          <h1 className="text-base font-semibold leading-tight">Create custom order</h1>
          <p className="text-xs text-muted-foreground">
            Enter customer, delivery, and payment details in one place.
          </p>
        </div>
        <div className="ms-auto flex items-center gap-2 text-xs text-muted-foreground">
          <div className="hidden sm:flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
          <span className="hidden sm:block">Draft saved just now</span>
        </div>
      </div>

      {/* ── Two-column body ─────────────────────────────────────────────────── */}
      <div className="flex flex-1 overflow-hidden">
        {/* ── LEFT: scrollable form ──────────────────────────────────────── */}
        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-2xl space-y-4 p-4 sm:p-6">

            {/* ── CUSTOMER ─────────────────────────────────────────────── */}
            {customerIsComplete ? (
              /* Completed/collapsed summary */
              <SectionCard className="p-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-teal-100">
                    <User size={14} className="text-teal-700" />
                  </div>
                  <div className="flex-1 min-w-0 flex items-center gap-2">
                    <AvatarChip name={reviewCustomerName} color="teal" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{reviewCustomerName}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        {[custPhone || selectedCustomer?.phone, custEmail || selectedCustomer?.email]
                          .filter(Boolean)
                          .join(" · ")}
                      </p>
                    </div>
                    <CheckCircle2 size={16} className="shrink-0 text-emerald-500 ms-1" />
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="shrink-0 text-xs h-7"
                    aria-label="Edit customer"
                    onClick={() => setEditingSection("customer")}
                  >
                    Edit
                  </Button>
                </div>
              </SectionCard>
            ) : (
              /* Active state */
              <SectionCard className="p-4 sm:p-5 border-teal-200 ring-1 ring-teal-100">
                <div className="mb-3 flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-teal-100">
                      <User size={14} className="text-teal-700" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h2 className="text-sm font-semibold">Customer</h2>
                        <span className="inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-1.5 py-0 text-[10px] font-semibold text-amber-700">
                          Required
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Link this order to a customer record for history and future orders.
                      </p>
                    </div>
                  </div>
                  {/* Show Done button when in edit mode and customer is still linked */}
                  {editingSection === "customer" && customerLinked && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-xs h-7 shrink-0"
                      onClick={() => setEditingSection(null)}
                    >
                      Done
                    </Button>
                  )}
                </div>

                <p className="mb-1 text-xs font-medium">Find an existing customer</p>
                <ContactSearchPicker
                  mode="customer"
                  selected={selectedCustomer}
                  onSelect={handleSelectCustomer}
                  testIdPrefix="new-order-customer"
                />
                {!selectedCustomer && (
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    Search existing records to avoid duplicates.
                  </p>
                )}
              </SectionCard>
            )}

            {/* ── RECIPIENT & DELIVERY ─────────────────────────────────── */}
            {recipientIsLocked ? (
              /* Locked state */
              <SectionCard className="p-4" aria-disabled="true">
                <div className="flex items-center gap-3 opacity-50">
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-violet-100">
                    <MapPin size={14} className="text-violet-700" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h2 className="text-sm font-semibold">Recipient &amp; Delivery</h2>
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <Lock size={11} />
                      Complete customer details to continue.
                    </p>
                  </div>
                </div>
              </SectionCard>
            ) : recipientIsComplete ? (
              /* Completed/collapsed summary */
              <SectionCard className="p-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-violet-100">
                    <MapPin size={14} className="text-violet-700" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <AvatarChip name={reviewRecipientName} color="violet" />
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate">{reviewRecipientName}</p>
                        <p className="text-xs text-muted-foreground truncate">
                          {[
                            recPhone || selectedRecipient?.phone,
                            deliveryAddress,
                            deliveryDay
                              ? `${format(deliveryDay, "d MMM")} · ${formatSlotRange(windowStartIso, windowEndIso)}`
                              : null,
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </p>
                      </div>
                      <CheckCircle2 size={16} className="shrink-0 text-emerald-500 ms-1" />
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="shrink-0 text-xs h-7"
                    aria-label="Edit recipient and delivery"
                    onClick={() => setEditingSection("recipient")}
                  >
                    Edit
                  </Button>
                </div>
              </SectionCard>
            ) : (
              /* Active state */
              <SectionCard className="p-4 sm:p-5 border-violet-200 ring-1 ring-violet-100">
                <div className="mb-3 flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-violet-100">
                      <MapPin size={14} className="text-violet-700" />
                    </div>
                    <div>
                      <h2 className="text-sm font-semibold">Recipient &amp; Delivery</h2>
                      <p className="text-xs text-muted-foreground">
                        Who receives the order and when?
                      </p>
                    </div>
                  </div>
                  {editingSection === "recipient" && recipientVerified && deliveryScheduled && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="text-xs h-7 shrink-0"
                      onClick={() => setEditingSection(null)}
                    >
                      Done
                    </Button>
                  )}
                </div>

                {!isNewRecipientForm && (
                  <>
                    <p className="mb-2 text-xs font-medium text-muted-foreground">
                      Find an existing recipient
                    </p>
                    <ContactSearchPicker
                      mode="recipient"
                      customerContactId={selectedCustomer?.id ?? null}
                      selected={selectedRecipient}
                      onSelect={handleSelectRecipient}
                      testIdPrefix="new-order-recipient"
                    />
                  </>
                )}

                {isNewRecipientForm && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
                    <div className="space-y-1">
                      <Label className="text-xs">
                        Recipient name <span className="text-destructive">*</span>
                      </Label>
                      <div className="relative">
                        <Input
                          value={recName}
                          onChange={(e) => { setRecName(e.target.value); setRecTouched(true); }}
                          placeholder="Full name"
                          className="pe-7"
                        />
                        {recName.trim() && (
                          <CheckCircle2 size={14} className="absolute end-2 top-2.5 text-emerald-500" />
                        )}
                      </div>
                      {recTouched && !recName.trim() && (
                        <p className="text-xs text-destructive">Required</p>
                      )}
                    </div>
                    <div className="space-y-1">
                      <Label className="text-xs">
                        Recipient phone <span className="text-destructive">*</span>
                      </Label>
                      <div className="relative">
                        <Input
                          value={recPhone}
                          onChange={(e) => { setRecPhone(e.target.value); setRecTouched(true); }}
                          placeholder="+971..."
                          className="pe-7"
                        />
                        {recPhone.trim() && (
                          <CheckCircle2 size={14} className="absolute end-2 top-2.5 text-emerald-500" />
                        )}
                      </div>
                      {recTouched && !recPhone.trim() && (
                        <p className="text-xs text-destructive">Required</p>
                      )}
                    </div>
                  </div>
                )}

                {/* Delivery address */}
                <div className="space-y-1 mb-4 mt-3">
                  <Label className="text-xs font-medium">Delivery address</Label>
                  <div className="relative">
                    <Textarea
                      value={deliveryAddress}
                      onChange={(e) => setDeliveryAddress(e.target.value)}
                      rows={2}
                      placeholder="Enter full delivery address…"
                      className="resize-none pe-7"
                    />
                    {deliveryAddress.trim() && (
                      <CheckCircle2 size={14} className="absolute end-2 top-2.5 text-emerald-500" />
                    )}
                  </div>
                </div>

                {/* Delivery date & time — slot-based picker */}
                <DeliveryDateTimePicker
                  day={deliveryDay}
                  startTime={deliveryStartTime}
                  endTime={deliveryEndTime}
                  onConfirm={(d, start, end) => {
                    setDeliveryDay(d);
                    setDeliveryStartTime(start);
                    setDeliveryEndTime(end);
                  }}
                  onClear={() => {
                    setDeliveryDay(undefined);
                    setDeliveryStartTime("");
                    setDeliveryEndTime("");
                  }}
                />
              </SectionCard>
            )}

            {/* ── PRODUCTS ─────────────────────────────────────────────── */}
            {productsIsLocked ? (
              /* Locked state */
              <SectionCard className="p-4" aria-disabled="true">
                <div className="flex items-center gap-3 opacity-50">
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-amber-100">
                    <Package size={14} className="text-amber-700" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h2 className="text-sm font-semibold">Products</h2>
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <Lock size={11} />
                      Available after recipient and delivery are set.
                    </p>
                  </div>
                </div>
              </SectionCard>
            ) : (
              /* Active state */
              <SectionCard className="p-4 sm:p-5">
                <div className="mb-3 flex items-center gap-2">
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-amber-100">
                    <Package size={14} className="text-amber-700" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h2 className="text-sm font-semibold">Products</h2>
                    <p className="text-xs text-muted-foreground">
                      {cart.length > 0
                        ? `${cart.length} item${cart.length !== 1 ? "s" : ""} · Prices shown in USD`
                        : "Add products from the catalog or create custom items"}
                    </p>
                  </div>
                </div>

                {/* Items table */}
                {cart.length > 0 && (
                  <div className="mb-4 rounded-md border overflow-hidden">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b bg-muted/40">
                          <th className="px-3 py-2 text-start text-xs font-medium text-muted-foreground">PRODUCT</th>
                          <th className="px-3 py-2 text-center text-xs font-medium text-muted-foreground w-20">QTY</th>
                          <th className="px-3 py-2 text-end text-xs font-medium text-muted-foreground w-24">UNIT PRICE</th>
                          <th className="px-3 py-2 text-end text-xs font-medium text-muted-foreground w-24">SUBTOTAL</th>
                          <th className="w-8" />
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {cart.map((l) => {
                          const isCustom = l.kind === "custom";
                          const name = isCustom ? (l as CustomLine).name : (l as CatalogLine).product.name;
                          const sku = !isCustom ? (l as CatalogLine).product.sku : null;
                          const thumb = !isCustom
                            ? imageUrl((l as CatalogLine).product.main_image_url)
                            : (l as CustomLine).image_url
                              ? imageUrl((l as CustomLine).image_url) ?? (l as CustomLine).image_url
                              : null;
                          const unitPrice = isCustom
                            ? (l as CustomLine).unit_price
                            : unitPriceFor((l as CatalogLine).product);
                          const qty = l.quantity;
                          const key = isCustom ? (l as CustomLine).id : (l as CatalogLine).product.id;

                          return (
                            <tr key={isCustom ? (l as CustomLine).id : (l as CatalogLine).product.id}>
                              <td className="px-3 py-2">
                                <div className="flex items-center gap-2.5 min-w-0">
                                  <div className="h-20 w-20 shrink-0 overflow-hidden rounded-md bg-muted">
                                    {thumb ? (
                                      <img src={thumb as string} alt="" className="h-full w-full object-cover" />
                                    ) : (
                                      <div className="flex h-full w-full items-center justify-center">
                                        <Package size={20} className="text-muted-foreground/40" />
                                      </div>
                                    )}
                                  </div>
                                  <div className="min-w-0">
                                    <p className="truncate font-medium text-sm">{name}</p>
                                    {sku && (
                                      <span className="inline-flex items-center rounded bg-slate-100 px-1 text-[10px] font-medium text-slate-600">
                                        {sku}
                                      </span>
                                    )}
                                    {isCustom && (
                                      <span className="inline-flex items-center rounded-sm bg-violet-100 px-1 py-0 text-xs font-medium text-violet-700 ms-1">
                                        {t("orders.customItem.badge")}
                                      </span>
                                    )}
                                    {!isCustom && hasPersonalization((l as CatalogLine).product) && (
                                      <Input
                                        className="mt-1 h-6 text-xs"
                                        value={(l as CatalogLine).custom_input}
                                        maxLength={22}
                                        onChange={(e) =>
                                          setCustomInput((l as CatalogLine).product.id, e.target.value)
                                        }
                                        placeholder={t("orders.co.customInputPlaceholder")}
                                      />
                                    )}
                                  </div>
                                </div>
                              </td>
                              <td className="px-3 py-2">
                                <div className="flex items-center justify-center gap-1">
                                  <Button
                                    type="button"
                                    size="icon"
                                    variant="outline"
                                    className="h-6 w-6"
                                    aria-label={`Decrease quantity of ${name}`}
                                    onClick={() =>
                                      isCustom
                                        ? setCustomLineQty((l as CustomLine).id, -1)
                                        : setQty((l as CatalogLine).product.id, -1)
                                    }
                                  >
                                    <Minus size={10} />
                                  </Button>
                                  <input
                                    type="number"
                                    min="1"
                                    value={qty}
                                    aria-label={`Quantity of ${name}`}
                                    onChange={(e) =>
                                      setLineQtyDirect(
                                        key,
                                        parseInt(e.target.value) || 1,
                                        isCustom ? "custom" : "catalog",
                                      )
                                    }
                                    className="w-8 text-center text-sm border rounded focus:outline-none focus:ring-1 focus:ring-teal-500 py-0.5"
                                  />
                                  <Button
                                    type="button"
                                    size="icon"
                                    variant="outline"
                                    className="h-6 w-6"
                                    aria-label={`Increase quantity of ${name}`}
                                    onClick={() =>
                                      isCustom
                                        ? setCustomLineQty((l as CustomLine).id, 1)
                                        : setQty((l as CatalogLine).product.id, 1)
                                    }
                                  >
                                    <Plus size={10} />
                                  </Button>
                                </div>
                              </td>
                              <td className="px-3 py-2 text-end text-sm">
                                ${unitPrice.toFixed(2)}
                              </td>
                              <td className="px-3 py-2 text-end text-sm font-medium">
                                ${(unitPrice * qty).toFixed(2)}
                              </td>
                              <td className="py-2 pe-2">
                                <Button
                                  type="button"
                                  size="icon"
                                  variant="ghost"
                                  className="h-6 w-6 text-muted-foreground hover:text-destructive"
                                  aria-label={`Remove ${name}`}
                                  onClick={() =>
                                    isCustom
                                      ? removeCustomLine((l as CustomLine).id)
                                      : removeLine((l as CatalogLine).product.id)
                                  }
                                >
                                  <X size={12} />
                                </Button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                      <tfoot>
                        <tr className="border-t bg-muted/20">
                          <td colSpan={3} className="px-3 py-2 text-end text-xs text-muted-foreground font-medium">
                            Items subtotal ·
                          </td>
                          <td className="px-3 py-2 text-end text-sm font-semibold">
                            ${subtotal.toFixed(2)}
                          </td>
                          <td />
                        </tr>
                        {canApplyDiscount && !discount && !showDiscountEditor && (
                          <tr className="bg-muted/10">
                            <td colSpan={5} className="px-3 pb-2">
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-7 gap-1 px-1 text-xs text-teal-700 hover:text-teal-800"
                                onClick={() => {
                                  setDiscount({ type: "amount", value: "", reason: "", explanation: "" });
                                  setShowDiscountEditor(true);
                                }}
                              >
                                <Plus size={13} /> Add discount
                              </Button>
                            </td>
                          </tr>
                        )}
                        {discount && discountValid && !showDiscountEditor && (
                          <tr className="bg-emerald-50/70 text-emerald-800">
                            <td colSpan={3} className="px-3 py-2 text-end text-xs font-medium">
                              Discount{discountReason ? ` · ${discountReason}` : ""}
                            </td>
                            <td className="px-3 py-2 text-end text-sm font-semibold">
                              −${discountAmount.toFixed(2)}
                            </td>
                            <td className="pe-2 text-end whitespace-nowrap">
                              <button
                                type="button"
                                className="me-2 text-xs font-medium underline underline-offset-2"
                                onClick={() => setShowDiscountEditor(true)}
                              >
                                Edit
                              </button>
                              <button
                                type="button"
                                className="text-xs font-medium text-destructive underline underline-offset-2"
                                onClick={() => {
                                  setDiscount(null);
                                  setShowDiscountEditor(false);
                                }}
                              >
                                Remove
                              </button>
                            </td>
                          </tr>
                        )}
                        {discount && discountValid && (
                          <tr className="border-t bg-muted/20">
                            <td colSpan={3} className="px-3 py-2 text-end text-xs font-semibold">
                              Order total
                            </td>
                            <td className="px-3 py-2 text-end text-sm font-bold">
                              ${netTotal.toFixed(2)}
                            </td>
                            <td />
                          </tr>
                        )}
                      </tfoot>
                    </table>
                    {canApplyDiscount && discount && showDiscountEditor && (
                      <div className="border-t bg-teal-50/50 p-3">
                        <div className="mb-2 flex items-center justify-between">
                          <p className="text-xs font-semibold uppercase tracking-wide text-teal-800">
                            Order discount
                          </p>
                          <button
                            type="button"
                            className="text-xs text-muted-foreground underline underline-offset-2"
                            onClick={() => {
                              if (discountValid) setShowDiscountEditor(false);
                              else {
                                setDiscount(null);
                                setShowDiscountEditor(false);
                              }
                            }}
                          >
                            {discountValid ? "Done" : "Cancel"}
                          </button>
                        </div>
                        <div className="grid gap-2 sm:grid-cols-3">
                          <div className="space-y-1">
                            <Label className="text-xs">Type</Label>
                            <select
                              value={discount.type}
                              onChange={(e) => setDiscount({ ...discount, type: e.target.value as CmcOrderDiscountDraft["type"] })}
                              className="h-8 w-full rounded-md border bg-background px-2 text-sm"
                            >
                              <option value="amount">Fixed amount ($)</option>
                              <option value="percent">Percentage (%)</option>
                            </select>
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">Value</Label>
                            <Input
                              className="h-8 text-sm"
                              type="number"
                              min="0"
                              max={discount.type === "percent" ? 100 : subtotal}
                              step="0.01"
                              value={discount.value}
                              onChange={(e) => setDiscount({ ...discount, value: e.target.value })}
                              placeholder={discount.type === "percent" ? "e.g. 10" : "0.00"}
                            />
                          </div>
                          <div className="space-y-1">
                            <Label className="text-xs">Reason</Label>
                            <select
                              value={discount.reason}
                              onChange={(e) => setDiscount({ ...discount, reason: e.target.value })}
                              className="h-8 w-full rounded-md border bg-background px-2 text-sm"
                            >
                              <option value="">Select a reason…</option>
                              <option value="Customer goodwill">Customer goodwill</option>
                              <option value="Service recovery">Service recovery</option>
                              <option value="Staff discount">Staff discount</option>
                              <option value="Other">Other</option>
                            </select>
                          </div>
                        </div>
                        {discount.reason === "Other" && (
                          <div className="mt-2 space-y-1">
                            <Label className="text-xs">Explain this discount</Label>
                            <Input
                              className="h-8 text-sm"
                              value={discount.explanation}
                              onChange={(e) => setDiscount({ ...discount, explanation: e.target.value })}
                              placeholder="Required for Other"
                            />
                          </div>
                        )}
                        {discountError ? (
                          <p className="mt-2 text-xs text-destructive">{discountError}</p>
                        ) : discountValid ? (
                          <p className="mt-2 text-xs text-emerald-700">
                            Applied: −${discountAmount.toFixed(2)} · New total ${netTotal.toFixed(2)}
                          </p>
                        ) : null}
                      </div>
                    )}
                  </div>
                )}

                {/* Action buttons + custom item form */}
                {!showCustomForm && (
                  <div className="flex items-center gap-2 flex-wrap">
                    <Button
                      type="button"
                      variant="default"
                      size="sm"
                      className="gap-1.5 bg-teal-700 hover:bg-teal-800 text-white"
                      onClick={() => {
                        setShowCatalog(true);
                        setShowCustomForm(false);
                      }}
                    >
                      <Plus size={13} />
                      Browse catalog
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="gap-1.5 text-violet-700 border-violet-200 hover:bg-violet-50"
                      onClick={() => {
                        setShowCustomForm(true);
                        setShowCatalog(false);
                      }}
                    >
                      Create custom item
                    </Button>
                  </div>
                )}

                {showCustomForm && (
                  <CustomItemForm
                    onAdd={addCustomLine}
                    onClose={() => setShowCustomForm(false)}
                  />
                )}
              </SectionCard>
            )}

            {/* ── CARD MESSAGE + PAYMENT ───────────────────────────────── */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Card message */}
              <section className="rounded-xl border bg-card p-4 shadow-sm">
                <div className="mb-3 flex items-center gap-2">
                  <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-rose-100">
                    <span className="text-xs">💌</span>
                  </div>
                  <div>
                    <h2 className="text-sm font-semibold">Card message</h2>
                    <p className="text-xs text-muted-foreground">Optional</p>
                  </div>
                </div>
                <div className="space-y-3">
                  <div className="space-y-1">
                    <Label htmlFor="card-to" className="text-xs">To</Label>
                    <Input
                      id="card-to"
                      value={cardTo}
                      onChange={(e) => { setCardToEdited(true); setCardTo(e.target.value); }}
                      onBlur={() => setCardTo(normalizePersonName(cardTo) ?? "")}
                      placeholder="Recipient name"
                      className="h-8 text-sm"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="card-message" className="text-xs">Message</Label>
                    <Textarea
                      id="card-message"
                      value={cardMessage}
                      onChange={(e) => setCardMessage(e.target.value)}
                      rows={3}
                      placeholder="Write a message for the recipient…"
                      className="resize-none text-sm"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="card-from" className="text-xs">From</Label>
                    <Input
                      id="card-from"
                      value={cardFrom}
                      onChange={(e) => setCardFrom(e.target.value)}
                      onBlur={() => setCardFrom(normalizePersonName(cardFrom) ?? "")}
                      placeholder="Sender name"
                      className="h-8 text-sm"
                    />
                  </div>
                </div>
              </section>

              {/* Payment */}
              <section className="rounded-xl border bg-card p-4 shadow-sm">
                <div className="mb-3 flex items-center gap-2">
                  <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-emerald-100">
                    <span className="text-xs">💵</span>
                  </div>
                  <div>
                    <h2 className="text-sm font-semibold">Payment</h2>
                    <p className="text-xs text-muted-foreground">How was / will it be paid?</p>
                  </div>
                </div>
                <div className="space-y-3">
                  <div className="flex rounded-lg border overflow-hidden">
                    {CMC_PAYMENT_METHODS.map(({ value, icon }) => (
                      <button
                        key={value}
                        type="button"
                        data-testid={`new-order-payment-${value}`}
                        aria-pressed={paymentMethod === value}
                        className={cn(
                          "flex-1 py-2 text-sm font-medium transition-colors",
                          paymentMethod === value
                            ? "bg-teal-700 text-white"
                            : "bg-background text-muted-foreground hover:bg-muted",
                        )}
                        onClick={() => setPaymentMethod(value)}
                      >
                        {icon} {formatPaymentMethodLabel(value)}
                      </button>
                    ))}
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Internal note</Label>
                    <Textarea
                      value={internalNote}
                      onChange={(e) => setInternalNote(e.target.value)}
                      rows={2}
                      placeholder="Add an internal note (not a discount reason)…"
                      className="resize-none text-sm"
                    />
                  </div>
                </div>
              </section>
            </div>
          </div>
        </div>

        {/* ── RIGHT: sticky review panel ─────────────────────────────────── */}
        <div className="hidden lg:flex lg:w-72 xl:w-80 flex-col border-l bg-card overflow-y-auto">
          <div className="p-4 space-y-4">
            {/* Header */}
            <div className="rounded-xl p-3" style={{ background: "#00414e" }}>
              <p className="text-[10px] font-semibold uppercase tracking-widest text-teal-300 mb-0.5">
                ORDER REVIEW
              </p>
              <p className="text-base font-bold text-white">
                {canCreate ? "Ready to create" : customerLinked || recipientVerified ? "In progress" : "Incomplete"}
              </p>
            </div>

            {/* Customer card */}
            <div>
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                CUSTOMER
              </p>
              {reviewCustomerName ? (
                <div className="flex items-center gap-2.5 rounded-lg border p-2.5">
                  <AvatarChip name={reviewCustomerName} color="teal" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{reviewCustomerName}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {[custPhone || selectedCustomer?.phone, custEmail || selectedCustomer?.email]
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground italic">Not set</p>
              )}
            </div>

            {/* Recipient card */}
            <div>
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                RECIPIENT
              </p>
              {reviewRecipientName ? (
                <div className="flex items-center gap-2.5 rounded-lg border p-2.5">
                  <AvatarChip name={reviewRecipientName} color="violet" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{reviewRecipientName}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {recPhone || selectedRecipient?.phone || ""}
                    </p>
                  </div>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground italic">Not set</p>
              )}
            </div>

            {/* Delivery summary */}
            <div>
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                DELIVERY
              </p>
              <div className="space-y-1 text-sm">
                {deliveryAddress ? (
                  <div className="flex items-start gap-1.5">
                    <MapPin size={13} className="text-muted-foreground shrink-0 mt-0.5" />
                    <p className="text-sm">{deliveryAddress}</p>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground italic">No address</p>
                )}
                {deliveryDay && (
                  <div className="flex items-center gap-1.5">
                    <CalendarIcon size={13} className="text-muted-foreground shrink-0" />
                    <p className="text-xs">
                      {format(deliveryDay, "EEE, d MMM")}
                      {deliveryStartTime && deliveryEndTime
                        ? ` · ${formatSlotRange(windowStartIso, windowEndIso)}`
                        : ""}
                    </p>
                  </div>
                )}
              </div>
            </div>

            {/* Payment summary */}
            <div>
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
                PAYMENT SUMMARY
              </p>
              <div className="space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Items ({cart.length})</span>
                  <span>${subtotal.toFixed(2)}</span>
                </div>
                {discount && discountValid && (
                  <div className="flex justify-between text-emerald-700">
                    <span>Discount{discountReason ? ` · ${discountReason}` : ""}</span>
                    <span>−${discountAmount.toFixed(2)}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Payment method</span>
                  <span>{formatPaymentMethodLabel(paymentMethod)}</span>
                </div>
                <div className="flex justify-between border-t pt-1 mt-1">
                  <span className="font-semibold">Total</span>
                  <span className="text-xl font-bold" style={{ color: "#00414e" }}>
                    ${netTotal.toFixed(2)}
                  </span>
                </div>
              </div>
            </div>

            {/* Checklist */}
            <div className="space-y-1.5">
              <ChecklistItem label="Customer record linked" done={customerLinked} />
              <ChecklistItem label="Recipient details verified" done={recipientVerified} />
              <ChecklistItem label="Delivery day and time selected" done={deliveryScheduled} />
              <ChecklistItem label="At least one item added" done={cart.length > 0} />
              <ChecklistItem label="Payment method selected" done={paymentSelected} />
            </div>

            {/* Create button */}
            <div>
              <Button
                className="w-full h-11 text-sm font-semibold"
                style={canCreate ? { background: "#00414e" } : undefined}
                disabled={!canCreate || createMut.isPending}
                onClick={handleCreate}
              >
                {createMut.isPending ? (
                  <Loader2 size={16} className="me-2 animate-spin" />
                ) : null}
                {canCreate
                  ? `Create order · $${netTotal.toFixed(2)}`
                  : ctaBlockerLabel}
              </Button>
              {canCreate && (
                <p className="mt-1.5 text-center text-xs text-muted-foreground">
                  Press ⌘/Ctrl + Enter to create order
                </p>
              )}
              {isPastDeliveryDay && (
                <p className="mt-1.5 text-xs text-amber-600">
                  ⚠ Selected delivery day is in the past
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Mobile: floating create button ────────────────────────────────────── */}
        <div className="fixed bottom-0 start-0 end-0 lg:hidden border-t bg-background p-3 z-10">
          <Button
            className="w-full h-11 text-sm font-semibold"
            style={canCreate ? { background: "#00414e" } : undefined}
            disabled={!canCreate || createMut.isPending}
            onClick={handleCreate}
          >
            {createMut.isPending ? <Loader2 size={16} className="me-2 animate-spin" /> : null}
            {canCreate
              ? `Create order · $${netTotal.toFixed(2)}`
              : ctaBlockerLabel}
          </Button>
        </div>
      </div>

      {/* ── Catalog Sheet (slides in from right, doesn't cover Order Review) ── */}
      <CatalogSheet
        open={showCatalog}
        onClose={() => setShowCatalog(false)}
        onAdd={addToCart}
        cartItems={cart}
      />
    </div>
  );
}
