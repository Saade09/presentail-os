import { useState, useCallback, useMemo, useDeferredValue, memo, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useSearch } from "wouter";
import { ToastAction } from "@/components/ui/toast";
import {
  ArrowLeft, Plus, Minus, Trash2, ShoppingCart, CheckCircle2,
  Loader2, ChevronDown, ChevronUp, CloudUpload, CalendarDays,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DateRangePicker, type DateRangeValue } from "@/components/ui/date-range-picker";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { apiFetch } from "@/lib/queryClient";
import { isPermissionError } from "@/lib/permissionError";
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { toast } from "@/hooks/use-toast";
import { imageUrl } from "@/lib/imageUrl";
import { computeSaleTotals, clampDiscountValue, type DiscountType } from "./cmcSaleDiscount";

type ShelfProduct = {
  id: number;
  name: string;
  price_usd: string;
  price_aed: string;
  sku: string;
  status: string;
  main_image_url: string | null;
  stock_qty?: string;
};

type CartItem = {
  key: string;
  product_id: number | null;
  name: string;
  price_usd: string;
  qty: number;
  image_url?: string | null;
  description?: string | null;
  item_type: "shelf" | "custom";
};

type ActiveShift = {
  id: number;
  location_id: number;
  location_name: string;
  opened_at: string;
};

const PAYMENT_METHODS = ["cash", "card", "bank_transfer", "whish", "other"];

function todayIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Memoized so that cart/search/form state changes don't re-render every
// product tile — on a shelf with many products this keeps taps responsive,
// especially inside the mobile WebView.
const ProductCard = memo(function ProductCard({
  product,
  inCart,
  onAdd,
}: {
  product: ShelfProduct;
  inCart: boolean;
  onAdd: (p: ShelfProduct) => void;
}) {
  const img = imageUrl(product.main_image_url);
  return (
    <button
      onClick={() => onAdd(product)}
      className={`flex flex-col items-start rounded-lg border p-3 text-left transition hover:shadow-sm active:scale-95 ${
        inCart
          ? "border-teal-500 bg-teal-50 ring-1 ring-teal-400"
          : "bg-card hover:border-teal-400"
      }`}
    >
      {img && (
        <img
          src={img}
          alt={product.name}
          loading="lazy"
          decoding="async"
          className="mb-2 h-36 w-full rounded object-cover sm:h-32"
        />
      )}
      <p className="text-sm font-medium leading-snug">{product.name}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{product.sku}</p>
      <p className="mt-1 font-semibold text-teal-700">${parseFloat(product.price_usd || "0").toFixed(2)}</p>
    </button>
  );
});

export default function CmcPosSale() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const searchParams = new URLSearchParams(useSearch());
  const entryMode = searchParams.get("mode");     // "scan" = barcode-ready state
  const entryFocus = searchParams.get("focus");   // "search" = focus search input

  const searchInputRef = useRef<HTMLInputElement>(null);

  const [cart, setCart] = useState<CartItem[]>([]);
  const [search, setSearch] = useState("");
  const [scanReady, setScanReady] = useState(entryMode === "scan");
  const [paymentMethod, setPaymentMethod] = useState("cash");
  const [receiptImageUrl, setReceiptImageUrl] = useState<string | null>(null);
  const [receiptImagePreview, setReceiptImagePreview] = useState<string | null>(null);
  const [uploadingReceipt, setUploadingReceipt] = useState(false);
  const [discountType, setDiscountType] = useState<DiscountType>("amount");
  const [discountValue, setDiscountValue] = useState("");
  const [discountDescription, setDiscountDescription] = useState("");
  const [notes, setNotes] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [shelfOpen, setShelfOpen] = useState(true);
  const [customOpen, setCustomOpen] = useState(true);

  const today = todayIso();
  const [fulfilmentRange, setFulfilmentRange] = useState<Partial<DateRangeValue>>({ from: today, to: today });

  const [customName, setCustomName] = useState("");
  const [customPrice, setCustomPrice] = useState("");
  const [customDesc, setCustomDesc] = useState("");
  const [customImageUrl, setCustomImageUrl] = useState<string | null>(null);
  const [customImagePreview, setCustomImagePreview] = useState<string | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [customNameError, setCustomNameError] = useState(false);
  const [customPriceError, setCustomPriceError] = useState(false);

  // Auto-focus the search input when arriving via Scan Barcode or Search Products shortcuts.
  // For scan mode we also show a "ready to scan" prompt so the user knows the input is live.
  useEffect(() => {
    if (entryMode === "scan" || entryFocus === "search") {
      // Small delay so Collapsible can open and the input is mounted
      const t = setTimeout(() => searchInputRef.current?.focus(), 150);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [entryMode, entryFocus]);

  const [selectedLocationId, setSelectedLocationId] = useState<number | null>(null);

  const { data: shiftData, isPending: shiftPending } = useQuery<{ shift: ActiveShift | null }>({
    queryKey: ["cmc-pos-active-shift"],
    queryFn: () => apiFetch<{ shift: ActiveShift | null }>("/api/cmc-pos/shifts/active", {}),
    staleTime: 30_000,
  });

  const activeShift = shiftData?.shift ?? null;

  // Reset manual location selection whenever a shift becomes active
  useEffect(() => {
    if (activeShift) setSelectedLocationId(null);
  }, [activeShift]);

  const effectiveLocationId = activeShift?.location_id ?? selectedLocationId;

  // Only fetch locations when there is no active shift and the shift query has resolved
  const { data: locationsData } = useQuery<{ locations: { id: number; name: string }[] }>({
    queryKey: ["locations"],
    queryFn: () => apiFetch<{ locations: { id: number; name: string }[] }>("/api/locations", {}),
    enabled: !shiftPending && !activeShift,
    staleTime: 60_000,
  });

  // Auto-select CMC Beirut Hospital (or first location) when no active shift
  useEffect(() => {
    if (!locationsData || locationsData.locations.length === 0) return;
    const match =
      locationsData.locations.find((l) =>
        l.name.toLowerCase().includes("cmc beirut hospital")
      ) ?? locationsData.locations[0];
    setSelectedLocationId(match.id);
  }, [locationsData]);

  // Wait until the active shift is known before fetching products — otherwise
  // the page fires one fetch without a location and a second one right after,
  // doubling the initial load. keepPreviousData avoids a grid flash if the
  // location changes.
  const { data: productsData, isPending: productsPending } = useQuery<{ products: ShelfProduct[] }>({
    queryKey: ["cmc-pos-shelf-products", effectiveLocationId ?? null],
    queryFn: () => {
      const loc = effectiveLocationId;
      const qs = loc ? `?location_id=${loc}` : "";
      return apiFetch<{ products: ShelfProduct[] }>(`/api/cmc-pos/shelf-products${qs}`, {});
    },
    enabled: !shiftPending,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });

  const products = productsData?.products;
  const productsLoading = shiftPending || (productsPending && !products);

  // Defer filtering so typing in the search box stays responsive even with a
  // large product grid; memoize so cart/form state changes skip the refilter.
  const deferredSearch = useDeferredValue(search);
  const filtered = useMemo(() => {
    const list = products ?? [];
    const q = deferredSearch.trim().toLowerCase();
    if (q === "") return list;
    return list.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.sku ?? "").toLowerCase().includes(q),
    );
  }, [products, deferredSearch]);

  const cartProductIds = new Set(cart.filter((c) => c.item_type === "shelf").map((c) => c.product_id));

  const addToCart = useCallback(
    (p: ShelfProduct) => {
      setCart((prev) => {
        const idx = prev.findIndex((c) => c.product_id === p.id && c.item_type === "shelf");
        if (idx !== -1) {
          const next = [...prev];
          next[idx] = { ...next[idx], qty: next[idx].qty + 1 };
          return next;
        }
        return [...prev, {
          key: `catalog-${p.id}`,
          product_id: p.id,
          name: p.name,
          price_usd: p.price_usd,
          qty: 1,
          image_url: p.main_image_url,
          item_type: "shelf",
        }];
      });
    },
    [],
  );

  const uploadCustomImage = async (file: File) => {
    const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];
    if (!ALLOWED_TYPES.includes(file.type)) {
      toast({ title: t("cmcPos.sale.custom.imageTypeError"), variant: "destructive" });
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast({ title: t("cmcPos.sale.custom.imageSizeError"), variant: "destructive" });
      return;
    }
    const previewUrl = URL.createObjectURL(file);
    setCustomImagePreview(previewUrl);
    setUploadingImage(true);
    try {
      const fd = new FormData();
      fd.append("image", file);
      const data = await apiFetch<{ url: string }>("/api/cmc-pos/upload-image", { method: "POST", body: fd });
      setCustomImageUrl(data.url);
    } catch {
      toast({ title: t("cmcPos.uploadError", "Upload failed"), variant: "destructive" });
      setCustomImagePreview(null);
    } finally {
      setUploadingImage(false);
    }
  };

  const uploadReceiptImage = async (file: File) => {
    const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];
    if (!ALLOWED_TYPES.includes(file.type)) {
      toast({ title: t("cmcPos.sale.custom.imageTypeError"), variant: "destructive" });
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast({ title: t("cmcPos.sale.custom.imageSizeError"), variant: "destructive" });
      return;
    }
    const previewUrl = URL.createObjectURL(file);
    setReceiptImagePreview(previewUrl);
    setUploadingReceipt(true);
    try {
      const fd = new FormData();
      fd.append("image", file);
      const data = await apiFetch<{ url: string }>("/api/cmc-pos/upload-image", { method: "POST", body: fd });
      setReceiptImageUrl(data.url);
    } catch {
      toast({ title: t("cmcPos.uploadError", "Upload failed"), variant: "destructive" });
      setReceiptImagePreview(null);
      setReceiptImageUrl(null);
    } finally {
      setUploadingReceipt(false);
    }
  };

  const addCustomItem = () => {
    const name = customName.trim();
    const price = parseFloat(customPrice);
    let hasError = false;
    if (!name) { setCustomNameError(true); hasError = true; }
    if (!customPrice || isNaN(price) || price <= 0) { setCustomPriceError(true); hasError = true; }
    if (hasError) return;
    const key = `custom-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setCart((prev) => [
      ...prev,
      { key, product_id: null, name, price_usd: String(price), qty: 1, image_url: customImageUrl, description: customDesc || null, item_type: "custom" },
    ]);
    setCustomName("");
    setCustomPrice("");
    setCustomDesc("");
    setCustomImageUrl(null);
    setCustomImagePreview(null);
    setCustomNameError(false);
    setCustomPriceError(false);
  };

  const updateQty = (key: string, qty: number) => {
    if (qty <= 0) {
      setCart((prev) => prev.filter((c) => c.key !== key));
    } else {
      setCart((prev) => prev.map((c) => (c.key === key ? { ...c, qty } : c)));
    }
  };

  const shelfSubtotal = cart
    .filter((c) => c.item_type === "shelf")
    .reduce((s, c) => s + parseFloat(c.price_usd || "0") * c.qty, 0);
  const customSubtotal = cart
    .filter((c) => c.item_type === "custom")
    .reduce((s, c) => s + parseFloat(c.price_usd || "0") * c.qty, 0);
  // Discount applies to the COMBINED total (shelf + custom items).
  const { subtotal, discountAmount: computedDiscount, total } = computeSaleTotals(
    shelfSubtotal,
    customSubtotal,
    discountType,
    discountValue,
  );
  const clampedDiscountValue = clampDiscountValue(discountType, discountValue, subtotal);
  const hasDiscount = computedDiscount > 0;

  // Cash sale is blocked when payment method is cash but there's no active shift
  // (which means no open cash session at the location).
  const isCashWithNoShift = paymentMethod === "cash" && !activeShift;

  const createSale = useMutation({
    mutationFn: async () => {
      const key = typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
      return apiFetch<{ sale: unknown }>("/api/cmc-pos/sales", {
        method: "POST",
        body: JSON.stringify({
          // location_id is required by the API; effectiveLocationId must be non-null
          // before the user is allowed to submit (enforced by the disabled guard below).
          location_id: effectiveLocationId!,
          shift_id: activeShift?.id ?? null,
          line_items: cart.map((c) => ({
            product_id: c.product_id,
            name: c.name,
            qty: c.qty,
            unit_price: parseFloat(c.price_usd || "0"),
            image_url: c.image_url ?? null,
            description: c.description ?? null,
            item_type: c.item_type,
          })),
          payment_method: paymentMethod,
          payment_reference: null,
          receipt_image_url: receiptImageUrl || null,
          notes: notes || null,
          discount_amount: computedDiscount,
          ...(hasDiscount
            ? {
                discount_type: discountType,
                discount_value: clampedDiscountValue,
                discount_description: discountDescription.trim() || null,
              }
            : {}),
          idempotency_key: key,
          fulfilment_date: fulfilmentRange.from || null,
          fulfilment_date_to: fulfilmentRange.to || null,
        }),
      });
    },
    onSuccess: () => {
      setSubmitted(true);
      qc.invalidateQueries({ queryKey: ["cmc-pos-metrics"] });
      qc.invalidateQueries({ queryKey: ["cmc-pos-cash-drawer"] });
    },
    onError: (err: Error) => {
      if (isPermissionError(err)) {
        toast({
          title: t("cmcPos.noPermission"),
          description: t("cmcPos.noPermissionDesc"),
          variant: "destructive",
        });
        return;
      }
      // Server-side cash session gate: offer a direct path to start the shift
      if ((err as { code?: string }).code === "NO_ACTIVE_CASH_SESSION") {
        qc.invalidateQueries({ queryKey: ["cmc-pos-active-shift"] });
        toast({
          title: "No active shift",
          description: "Start a cash drawer shift before recording a cash sale.",
          variant: "destructive",
          action: (
            <ToastAction altText="Start Shift" asChild>
              {/* Route to the CMC POS dashboard (visible to all CMC users) —
                  /cmc-pos/cash-drawer is permission-gated and renders blank
                  for members without the cash_drawer sub-permission. */}
              <Link href="/cmc-pos">Start Shift</Link>
            </ToastAction>
          ),
        });
        return;
      }
      toast({ title: t("cmcPos.sale.errorTitle"), description: t("cmcPos.sale.errorDesc"), variant: "destructive" });
    },
  });

  if (submitted) {
    return (
      <div className="flex flex-col items-center justify-center gap-6 p-8 text-center min-h-[60vh]">
        <CheckCircle2 className="h-16 w-16 text-emerald-500" />
        <h2 className="text-xl font-semibold">{t("cmcPos.sale.successTitle")}</h2>
        <p className="text-muted-foreground">{t("cmcPos.sale.successDesc")}</p>
        <div className="flex flex-col gap-3 w-full max-w-xs sm:flex-row sm:max-w-none sm:w-auto">
          <Button className="h-12 sm:h-10" onClick={() => {
            setCart([]);
            setSubmitted(false);
            setDiscountType("amount");
            setDiscountValue("");
            setDiscountDescription("");
            setReceiptImageUrl(null);
            setReceiptImagePreview(null);
            setNotes("");
            setFulfilmentRange({ from: todayIso(), to: todayIso() });
          }}>
            {t("cmcPos.sale.newSale")}
          </Button>
          <Button variant="outline" className="h-12 sm:h-10" asChild>
            <Link href="/cmc-pos">{t("cmcPos.backToDashboard")}</Link>
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col lg:flex-row">
      {/* Left column: date + product sections */}
      <div className="flex-1 overflow-y-auto p-4 sm:p-6">
        {/* Header */}
        <div className="mb-4 flex items-center gap-2">
          <Button variant="ghost" size="icon" className="h-11 w-11 shrink-0" asChild>
            <Link href="/cmc-pos"><ArrowLeft className="h-5 w-5" /></Link>
          </Button>
          <h1 className="text-lg font-semibold sm:text-xl">{t("cmcPos.workflow1Title")}</h1>
          {activeShift && (
            <Badge variant="outline" className="ms-auto shrink-0 text-xs">
              {t("cmcPos.shift.active")}: {activeShift.location_name}
            </Badge>
          )}
        </div>

        {/* Sale date range */}
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border bg-card p-3">
          <CalendarDays className="h-4 w-4 text-teal-600 shrink-0" />
          <Label className="text-sm font-medium shrink-0">{t("cmcPos.sale.fulfilmentDate")}</Label>
          <DateRangePicker
            value={fulfilmentRange}
            onChange={setFulfilmentRange}
            placeholder={t("cmcPos.sale.fulfilmentDatePlaceholder", "Select date range")}
            className="h-9 flex-1 min-w-48"
          />
          {fulfilmentRange.from === today && fulfilmentRange.to === today && (
            <Badge className="bg-teal-100 text-teal-700 hover:bg-teal-100 shrink-0 text-xs font-medium">
              {t("cmcPos.sale.todayBadge")}
            </Badge>
          )}
        </div>

        {/* Shelf items collapsible */}
        <Collapsible open={shelfOpen} onOpenChange={setShelfOpen} className="mb-4">
          <CollapsibleTrigger asChild>
            <button className="flex w-full items-center justify-between rounded-lg border bg-card px-4 py-3 text-start hover:bg-muted/30 transition">
              <span className="font-semibold text-sm">
                {t("cmcPos.sale.shelfItemsSection")}
                <span className="ms-2 text-xs font-normal text-muted-foreground">
                  ({filtered.length})
                </span>
              </span>
              {shelfOpen ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-3 space-y-3">
              {scanReady && (
                <div className="flex items-center gap-2 rounded-lg border border-teal-200 bg-teal-50 px-3 py-2 text-xs text-teal-800">
                  <span className="inline-block h-2 w-2 rounded-full bg-teal-500 animate-pulse" />
                  Ready to scan — swipe a barcode or type a SKU
                  <button
                    type="button"
                    onClick={() => setScanReady(false)}
                    className="ms-auto text-teal-600 hover:text-teal-900 font-medium"
                  >
                    Dismiss
                  </button>
                </div>
              )}
              <Input
                ref={searchInputRef}
                placeholder={scanReady ? t("cmcPos.sale.scanPlaceholder", "Scan barcode or search…") : t("cmcPos.sale.searchPlaceholder")}
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  if (scanReady && e.target.value) setScanReady(false);
                }}
                className="h-11"
              />
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
                {productsLoading ? (
                  Array.from({ length: 8 }, (_, i) => (
                    <div key={i} className="flex flex-col items-start rounded-lg border bg-card p-3">
                      <Skeleton className="mb-2 h-36 w-full rounded sm:h-32" />
                      <Skeleton className="h-4 w-3/4" />
                      <Skeleton className="mt-1.5 h-3 w-1/3" />
                      <Skeleton className="mt-2 h-4 w-1/4" />
                    </div>
                  ))
                ) : (
                  <>
                    {filtered.map((p) => (
                      <ProductCard key={p.id} product={p} inCart={cartProductIds.has(p.id)} onAdd={addToCart} />
                    ))}
                    {filtered.length === 0 && (
                      <p className="col-span-full py-8 text-center text-muted-foreground">{t("cmcPos.sale.noProducts")}</p>
                    )}
                  </>
                )}
              </div>
            </div>
          </CollapsibleContent>
        </Collapsible>

        {/* Custom product collapsible */}
        <Collapsible open={customOpen} onOpenChange={setCustomOpen}>
          <CollapsibleTrigger asChild>
            <button className="flex w-full items-center justify-between rounded-lg border bg-card px-4 py-3 text-start hover:bg-muted/30 transition">
              <span className="font-semibold text-sm">{t("cmcPos.sale.customProductSection")}</span>
              {customOpen ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-3 rounded-lg border-2 border-dashed border-teal-300 bg-card p-4 space-y-4">
              {/* Image upload */}
              <div className="space-y-1.5">
                <Label className="text-xs">{t("cmcPos.sale.custom.imageLabel")}</Label>
                <label className="flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-muted-foreground/25 p-4 cursor-pointer hover:border-teal-400 transition min-h-[80px] relative">
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    className="sr-only"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) uploadCustomImage(f);
                      e.target.value = "";
                    }}
                  />
                  {uploadingImage ? (
                    <Loader2 className="h-6 w-6 animate-spin text-teal-600" />
                  ) : customImagePreview ? (
                    <img src={customImagePreview} alt="" className="h-16 w-16 rounded object-cover border" />
                  ) : (
                    <>
                      <CloudUpload className="h-6 w-6 text-muted-foreground" />
                      <p className="text-xs text-muted-foreground text-center">{t("cmcPos.sale.custom.imageHint")}</p>
                    </>
                  )}
                </label>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label className="text-xs">{t("cmcPos.sale.custom.descriptionLabel")}</Label>
                  <Input
                    className={`h-10 ${customNameError ? "border-destructive" : ""}`}
                    placeholder={t("cmcPos.sale.custom.descriptionPlaceholder")}
                    value={customName}
                    onChange={(e) => { setCustomName(e.target.value); if (e.target.value.trim()) setCustomNameError(false); }}
                  />
                  {customNameError && <p className="text-xs text-destructive">{t("cmcPos.sale.custom.descriptionRequired")}</p>}
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">{t("cmcPos.sale.custom.priceLabel")}</Label>
                  <Input
                    className={`h-10 ${customPriceError ? "border-destructive" : ""}`}
                    type="number"
                    min="0.01"
                    step="0.01"
                    placeholder="0.00"
                    value={customPrice}
                    onChange={(e) => { setCustomPrice(e.target.value); if (parseFloat(e.target.value) > 0) setCustomPriceError(false); }}
                  />
                  {customPriceError && <p className="text-xs text-destructive">{t("cmcPos.sale.custom.priceRequired")}</p>}
                </div>
                <div className="space-y-1.5 sm:col-span-2">
                  <Label className="text-xs">{t("cmcPos.customItemDesc")}</Label>
                  <Textarea
                    className="min-h-[56px] resize-none text-sm"
                    placeholder={t("cmcPos.customItemDesc")}
                    value={customDesc}
                    onChange={(e) => setCustomDesc(e.target.value)}
                    rows={2}
                  />
                </div>
              </div>

              <Button size="sm" className="h-9 bg-teal-600 hover:bg-teal-700" onClick={addCustomItem}>
                <Plus className="me-1 h-4 w-4" />{t("cmcPos.sale.addCustomItem")}
              </Button>
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>

      {/* Right column: cart */}
      <div className="w-full border-t bg-background p-4 sm:p-6 lg:w-96 lg:border-s lg:border-t-0 lg:overflow-y-auto">
        <div className="flex items-center gap-2 mb-4">
          <ShoppingCart className="h-5 w-5 text-teal-600 shrink-0" />
          <h2 className="font-semibold">{t("cmcPos.sale.cart")} ({cart.reduce((s, c) => s + c.qty, 0)})</h2>
        </div>

        <div className="space-y-3 max-h-64 overflow-y-auto mb-4 lg:max-h-none">
          {cart.length === 0 && (
            <p className="py-4 text-center text-sm text-muted-foreground">{t("cmcPos.sale.emptyCart")}</p>
          )}
          {cart.map((c) => {
            const lineTotal = parseFloat(c.price_usd || "0") * c.qty;
            return (
              <div key={c.key} className="flex items-start gap-2">
                {c.image_url && imageUrl(c.image_url) && (
                  <img src={imageUrl(c.image_url) ?? undefined} alt="" className="h-12 w-12 rounded object-cover shrink-0 border mt-0.5" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <p className="text-sm font-medium truncate">{c.name}</p>
                    <Badge
                      variant="outline"
                      className={`text-[10px] px-1.5 py-0 shrink-0 ${c.item_type === "custom" ? "border-amber-300 text-amber-700 bg-amber-50" : "border-teal-300 text-teal-700 bg-teal-50"}`}
                    >
                      {c.item_type === "custom" ? t("cmcPos.sale.badge.custom") : t("cmcPos.sale.badge.shelf")}
                    </Badge>
                  </div>
                  {c.description && <p className="text-xs text-muted-foreground truncate">{c.description}</p>}
                  <p className="text-xs text-muted-foreground">${parseFloat(c.price_usd || "0").toFixed(2)} × {c.qty} = ${lineTotal.toFixed(2)}</p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button size="icon" variant="outline" className="h-8 w-8" onClick={() => updateQty(c.key, c.qty - 1)}>
                    <Minus className="h-3.5 w-3.5" />
                  </Button>
                  <span className="w-6 text-center text-sm font-medium">{c.qty}</span>
                  <Button size="icon" variant="outline" className="h-8 w-8" onClick={() => updateQty(c.key, c.qty + 1)}>
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="icon" variant="ghost" className="h-8 w-8 text-destructive" onClick={() => updateQty(c.key, 0)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>

        <Separator className="my-4" />

        <div className="space-y-3">
          {shelfSubtotal > 0 && (
            <div className="flex justify-between text-sm">
              <span>{t("cmcPos.sale.shelfSubtotal")}</span>
              <span>${shelfSubtotal.toFixed(2)}</span>
            </div>
          )}
          {customSubtotal > 0 && (
            <div className="flex justify-between text-sm">
              <span>{t("cmcPos.sale.customSubtotal")}</span>
              <span>${customSubtotal.toFixed(2)}</span>
            </div>
          )}
          {(shelfSubtotal > 0 || customSubtotal > 0) && (
            <div className="flex justify-between text-sm">
              <span>{t("cmcPos.sale.subtotal")}</span>
              <span>${subtotal.toFixed(2)}</span>
            </div>
          )}

          {cart.length > 0 && (
            <div className="space-y-2 rounded-lg border bg-muted/20 p-3">
              <Label className="text-sm font-medium">{t("cmcPos.sale.discountSection", "Discount (optional)")}</Label>
              <div className="flex items-center gap-2">
                <div className="flex rounded-md border overflow-hidden shrink-0">
                  <button
                    type="button"
                    onClick={() => setDiscountType("percent")}
                    className={`px-3 h-10 text-sm font-medium transition ${
                      discountType === "percent" ? "bg-teal-600 text-white" : "bg-card text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    %
                  </button>
                  <button
                    type="button"
                    onClick={() => setDiscountType("amount")}
                    className={`px-3 h-10 text-sm font-medium border-s transition ${
                      discountType === "amount" ? "bg-teal-600 text-white" : "bg-card text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    $
                  </button>
                </div>
                <Input
                  type="number"
                  min="0"
                  max={discountType === "percent" ? 100 : subtotal}
                  step="0.01"
                  value={discountValue}
                  onChange={(e) => setDiscountValue(e.target.value)}
                  placeholder={discountType === "percent" ? "0–100" : "0.00"}
                  className="h-10"
                />
              </div>
              <Input
                value={discountDescription}
                onChange={(e) => setDiscountDescription(e.target.value)}
                maxLength={500}
                placeholder={t("cmcPos.sale.discountDescriptionPlaceholder", "Reason (optional)")}
                className="h-10"
              />
              <p className="text-xs text-muted-foreground">
                {t("cmcPos.sale.discountTotalHelperText", "Applies to the whole total, including custom items.")}
              </p>
            </div>
          )}

          {hasDiscount && (
            <div className="flex justify-between text-sm text-destructive">
              <span>
                {t("cmcPos.sale.discountLine", "Discount")}
                {discountType === "percent" ? ` (${clampedDiscountValue}%)` : ""}
              </span>
              <span>-${computedDiscount.toFixed(2)}</span>
            </div>
          )}

          <div className="flex justify-between font-semibold">
            <span>{t("cmcPos.sale.total")}</span>
            <span className="text-teal-700">${total.toFixed(2)}</span>
          </div>
        </div>

        <Separator className="my-4" />

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>{t("cmcPos.sale.paymentMethod")}</Label>
            <Select value={paymentMethod} onValueChange={setPaymentMethod}>
              <SelectTrigger className="h-11">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAYMENT_METHODS.map((m) => (
                  <SelectItem key={m} value={m}>{t(`cmcPos.sale.pm.${m}`)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-sm">{t("cmcPos.sale.receiptImage")}</Label>
            <label className="flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-muted-foreground/25 p-4 cursor-pointer hover:border-teal-400 transition min-h-[80px] relative">
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="sr-only"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) uploadReceiptImage(f);
                  e.target.value = "";
                }}
              />
              {uploadingReceipt ? (
                <Loader2 className="h-6 w-6 animate-spin text-teal-600" />
              ) : receiptImagePreview ? (
                <img src={receiptImagePreview} alt="" className="h-16 w-16 rounded object-cover border" />
              ) : (
                <>
                  <CloudUpload className="h-6 w-6 text-muted-foreground" />
                  <p className="text-xs text-muted-foreground text-center">{t("cmcPos.sale.receiptImageHint")}</p>
                </>
              )}
            </label>
            {receiptImagePreview && !uploadingReceipt && (
              <button
                type="button"
                className="text-xs text-destructive hover:underline"
                onClick={() => { setReceiptImageUrl(null); setReceiptImagePreview(null); }}
              >
                {t("cmcPos.sale.receiptImageClear")}
              </button>
            )}
          </div>
          <div className="space-y-1.5">
            <Label>{t("cmcPos.sale.notes")}</Label>
            <Input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              className="h-11"
              placeholder={t("cmcPos.sale.notesPlaceholder")}
            />
          </div>
        </div>

        {/* When no shift is active, show a warning only if there are no locations */}
        {!activeShift && locationsData && locationsData.locations.length === 0 && (
          <div className="mt-4">
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {t("cmcPos.sale.noShiftWarning", "No active shift — open a shift from the dashboard to record a sale against a location.")}
            </p>
          </div>
        )}

        {/* Cash gate callout: cash with no active shift */}
        {isCashWithNoShift && (
          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 space-y-2">
            <p className="text-xs font-medium text-amber-800 flex items-center gap-1.5">
              <span>⚠️</span>
              Start a cash drawer shift before recording a cash sale.
            </p>
            <Link href="/cmc-pos" asChild>
              <a className="inline-flex h-7 items-center gap-1 rounded-md bg-amber-700 px-3 text-xs font-medium text-white hover:bg-amber-800 transition-colors">
                Start Shift
              </a>
            </Link>
          </div>
        )}

        <Button
          className="mt-5 w-full h-12 bg-teal-600 hover:bg-teal-700 text-base font-semibold"
          disabled={cart.length === 0 || createSale.isPending || !effectiveLocationId || isCashWithNoShift}
          onClick={() => createSale.mutate()}
        >
          {createSale.isPending ? (
            <Loader2 className="me-2 h-4 w-4 animate-spin" />
          ) : null}
          {t("cmcPos.sale.charge")} ${total.toFixed(2)}
        </Button>
      </div>
    </div>
  );
}
