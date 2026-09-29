import { useRef, useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useSearch, useLocation } from "wouter";
import { apiFetch, getClerkToken } from "@/lib/queryClient";
import { StaleDataBadge } from "@/components/StaleDataBadge";
import { formatAED, formatUSD } from "@/lib/utils";
import {
  fallbackToOriginalProductImage,
  imageUrl,
  productImageUrl,
} from "@/lib/imageUrl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { PriceText } from "@/components/ui/price-text";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  useListDeliveryCountries,
  getListDeliveryCountriesQueryKey,
  useGetProductCountryAvailability,
  getGetProductCountryAvailabilityQueryKey,
  useGetProductCityAvailability,
  getGetProductCityAvailabilityQueryKey,
  useListCatalogBrands,
  getListCatalogBrandsQueryKey,
  useListOccasions,
  getListOccasionsQueryKey,
  useBulkUpdateProducts,
  useBulkDeleteProducts,
  type BulkUpdateProductsInput,
} from "@workspace/api-client-react";
import { useTranslation } from "react-i18next";
import { CategoryOccasionPicker, type SelectedCategoryOption } from "@/components/CategoryOccasionPicker";
import { WorkspaceImage } from "@/components/WorkspaceImage";
import { useToast } from "@/hooks/use-toast";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { useUserPreference } from "@/hooks/use-user-preference";
import {
  Plus, Trash2, ShoppingBag, ImageIcon, X, Upload, Loader2, Search,
  GripHorizontal, ChevronDown, PlusCircle, ChevronLeft, ChevronRight,
  ChevronsLeft, ChevronsRight, MoreHorizontal, Pencil, ExternalLink,
  Copy, Archive, LayoutList, LayoutGrid, BarChart3, Package, AlertCircle,
  TrendingUp, RefreshCw, RefreshCcw,
} from "lucide-react";
import { checkNameWarning } from "@/lib/nameWarning";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  horizontalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

import { MerchantReconciliationPanel } from "./MerchantReconciliationPanel";

export const SEARCH_DEBOUNCE_MS = 300;

type Product = {
  id: number;
  workspace_owner_id: string;
  name: string;
  price_usd: string;
  price_aed: string;
  discount_price_usd?: string | null;
  discount_price_aed?: string | null;
  main_image_url: string | null;
  main_image_display_url?: string | null;
  main_image_thumbnail_url?: string | null;
  additional_image_urls: string[];
  description: string | null;
  status: string;
  brand: string | null;
  tags: string[];
  category: string | null;
  catalog_categories?: { id: number; name: string; slug: string }[];
  occasions?: { id: number; name: string; slug: string }[];
  sku: string | null;
  created_at: string;
  is_archived?: boolean;
  express_delivery_enabled?: boolean;
  has_input_field?: boolean;
  letter_input_enabled?: boolean;
  is_upsell?: boolean;
  catalog_brand?: { id: number; name: string } | null;
  cogs_usd?: string | number | null;
  delivery_disabled_count?: number;
  merchant_sync_status?: string | null;
  merchant_sync_error?: string | null;
  merchant_synced_at?: string | null;
  merchant_sync_disabled?: boolean | null;
};

type PublishAreaResult = {
  area: string;
  success: boolean;
  count: number;
  error?: string;
};

type ProductUpdateWarning = {
  area: string;
  message: string;
};

type ProductSummary = {
  total: number;
  available_count: number;
  hidden_count: number;
  missing_info_count: number;
  missing_images_count: number;
  avg_cogs_pct: number | null;
  archived_count: number;
};

type Brand = {
  id: number;
  name: string;
  primary_logo_id: number | null;
};

const STATUS_OPTIONS = [
  { value: "available", label: "Available" },
  { value: "out_of_stock", label: "Out of Stock" },
  { value: "not_available", label: "Not Available" },
] as const;

function statusBadge(status: string) {
  switch (status) {
    case "available":
      return <Badge className="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 border-0">Available</Badge>;
    case "out_of_stock":
      return <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border-0">Out of Stock</Badge>;
    case "not_available":
      return <Badge className="bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-0">Not Available</Badge>;
    default:
      return <Badge variant="secondary">{status}</Badge>;
  }
}

function computeCompleteness(p: Product): number {
  const fields = [
    !!p.main_image_url,
    !!(p.name && p.name.trim()),
    !!p.sku,
    !!(p.brand && p.brand.trim()),
    !!(p.category && p.category.trim()),
    p.price_usd != null && p.price_usd !== "" && parseFloat(String(p.price_usd)) >= 0,
    p.price_aed != null && p.price_aed !== "" && parseFloat(String(p.price_aed)) >= 0,
    p.cogs_usd != null,
    !!(p.status),
  ];
  const done = fields.filter(Boolean).length;
  return Math.round((done / fields.length) * 100);
}

function computeCogsPct(p: Product): number | null {
  if (p.cogs_usd == null) return null;
  const cogs = parseFloat(String(p.cogs_usd));
  const price = parseFloat(String(p.price_usd));
  if (!isFinite(cogs) || !isFinite(price) || price <= 0) return null;
  return (cogs / price) * 100;
}

function DeliveryCitiesBadge({
  disabledCount,
  totalCities,
}: {
  disabledCount: number;
  totalCities: number;
}) {
  if (totalCities <= 0) return null;
  const enabled = Math.max(0, totalCities - disabledCount);

  if (enabled === 0) {
    return (
      <Badge
        className="bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-0 gap-1"
        data-testid="badge-delivers-nowhere"
        title="This product is disabled in every delivery city, so it delivers nowhere."
      >
        <AlertCircle size={11} />
        Delivers nowhere
      </Badge>
    );
  }

  if (disabledCount === 0) {
    return (
      <Badge
        className="bg-muted text-muted-foreground border-0"
        data-testid="badge-delivery-cities"
        title="Delivers to all delivery cities"
      >
        All cities
      </Badge>
    );
  }

  return (
    <Badge
      className="bg-muted text-muted-foreground border-0"
      data-testid="badge-delivery-cities"
      title={`Delivers to ${enabled} of ${totalCities} delivery cities`}
    >
      {enabled} of {totalCities} cities
    </Badge>
  );
}

function CompletnessBadge({ pct }: { pct: number }) {
  const color =
    pct === 100
      ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 border-0"
      : pct >= 70
      ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border-0"
      : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-0";
  return <Badge className={color}>{pct}% Complete</Badge>;
}

function MerchantBadge({
  status: statusProp,
  error,
  syncedAt,
}: {
  status?: string | null;
  error?: string | null;
  syncedAt?: string | null;
}) {
  const { t } = useTranslation();
  // Backend stores statuses uppercase (SYNCED/FAILED/ACTION_REQUIRED/PENDING);
  // normalize so both casings render correctly.
  const status = (statusProp ?? "pending").toLowerCase();

  let badgeClass = "";
  let label = "";
  switch (status) {
    case "synced":
      badgeClass = "bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400 border-0 cursor-pointer";
      label = t("products.merchantSynced");
      break;
    case "error":
    case "failed":
      badgeClass = "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-0 cursor-pointer";
      label = t("products.merchantError");
      break;
    case "action_required":
      badgeClass = "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400 border-0 cursor-pointer";
      label = t("products.merchantActionRequired");
      break;
    case "disabled":
      badgeClass = "bg-muted text-muted-foreground border-0 cursor-pointer";
      label = t("products.merchantDisabled");
      break;
    case "pending":
      badgeClass = "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border-0 cursor-pointer";
      label = t("products.merchantPending");
      break;
    default:
      badgeClass = "bg-muted text-muted-foreground border-0 cursor-pointer";
      label = status;
  }

  const hasDetails = !!(error || syncedAt);
  if (!hasDetails) {
    return <Badge className={badgeClass}>{label}</Badge>;
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Badge className={badgeClass}>{label}</Badge>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-3 space-y-1.5" align="start">
        <p className="text-xs font-semibold text-foreground">{t("products.merchantDetails")}</p>
        {syncedAt && (
          <p className="text-xs text-muted-foreground">
            {t("products.merchantSyncedAt")}{" "}
            {new Date(syncedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
          </p>
        )}
        {error && (
          <p className="text-xs text-red-600 dark:text-red-400 break-words">{error}</p>
        )}
      </PopoverContent>
    </Popover>
  );
}

type ProductFormState = {
  name: string;
  price_usd: string;
  price_aed: string;
  discount_price_usd: string;
  discount_price_aed: string;
  description: string;
  status: string;
  brand: string;
  merchant_sync_disabled: boolean;
  categories: SelectedCategoryOption[];
  tags: string;
  main_image_url: string | null;
  additional_image_urls: string[];
  express_delivery_enabled: boolean;
  has_input_field: boolean;
  letter_input_enabled: boolean;
  is_upsell: boolean;
  catalog_brand_id: string;
  countryUpdates: { country_code: string; is_available: boolean }[];
  cityUpdates: { city_id: number; is_available: boolean }[];
};

const DEFAULT_FORM: ProductFormState = {
  name: "",
  price_usd: "",
  price_aed: "",
  discount_price_usd: "",
  discount_price_aed: "",
  description: "",
  status: "available",
  brand: "",
  merchant_sync_disabled: false,
  categories: [],
  tags: "",
  main_image_url: null,
  additional_image_urls: [],
  express_delivery_enabled: true,
  has_input_field: false,
  letter_input_enabled: false,
  is_upsell: false,
  catalog_brand_id: "",
  countryUpdates: [],
  cityUpdates: [],
};

/**
 * Validate an optional discount (sale) price against its regular price.
 * Empty means "no sale" (valid). When provided it must be a non-negative
 * number strictly less than the regular price. Returns an error key or null.
 */
function discountError(discount: string, regular: string): string | null {
  if (discount.trim() === "") return null;
  const d = parseFloat(discount);
  if (isNaN(d) || d < 0) return "errInvalid";
  const r = parseFloat(regular);
  if (!isNaN(r) && d >= r) return "errBelowRegular";
  return null;
}

function ImageUploadButton({
  label,
  currentUrl,
  onUploaded,
  onRemove,
}: {
  label: string;
  currentUrl: string | null;
  onUploaded: (url: string) => void;
  onRemove: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const handleFile = async (file: File) => {
    if (!file.type.startsWith("image/")) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("image", file);
      const token = await getClerkToken();
      const res = await fetch("/api/products/upload-image", {
        method: "POST",
        body: fd,
        credentials: "include",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Upload failed");
      onUploaded(json.url);
    } catch (err) {
      console.error("Upload error:", err);
    } finally {
      setUploading(false);
    }
  };

  const displayUrl = imageUrl(currentUrl);

  return (
    <div className="space-y-1.5">
      <Label className="text-sm">{label}</Label>
      {displayUrl ? (
        <div className="flex items-start gap-3">
          <div className="relative w-20 h-20 rounded-md border border-border overflow-hidden shrink-0 bg-muted">
            <img src={displayUrl} alt="" className="w-full h-full object-cover" />
            <button
              type="button"
              onClick={onRemove}
              className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-background/80 flex items-center justify-center hover:bg-background"
            >
              <X size={10} />
            </button>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-1 h-7 text-xs"
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
          >
            {uploading ? <Loader2 size={12} className="animate-spin mr-1" /> : null}
            Replace
          </Button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="w-full border-2 border-dashed border-border rounded-lg h-24 flex flex-col items-center justify-center gap-2 hover:border-primary/50 hover:bg-secondary/30 transition-colors disabled:opacity-50"
        >
          {uploading ? (
            <Loader2 size={20} className="text-muted-foreground animate-spin" />
          ) : (
            <Upload size={20} className="text-muted-foreground" />
          )}
          <span className="text-xs text-muted-foreground">{uploading ? "Uploading…" : "Click to upload"}</span>
        </button>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}

const MAX_ADDITIONAL_IMAGES = 5;

function SortableImageItem({
  id,
  url,
  onRemove,
}: {
  id: string;
  url: string;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
  };
  const displayUrl = imageUrl(url);

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="relative w-16 h-16 rounded-md border border-border overflow-hidden bg-muted shrink-0 group"
    >
      {displayUrl && <img src={displayUrl} alt="" className="w-full h-full object-cover" />}
      <button
        type="button"
        onClick={onRemove}
        className="absolute top-0.5 right-0.5 w-4 h-4 rounded-full bg-background/80 flex items-center justify-center hover:bg-background z-10"
      >
        <X size={8} />
      </button>
      <button
        type="button"
        {...attributes}
        {...listeners}
        className="absolute bottom-0.5 left-1/2 -translate-x-1/2 text-white/80 hover:text-white cursor-grab active:cursor-grabbing touch-none"
        title="Drag to reorder"
      >
        <GripHorizontal size={12} />
      </button>
    </div>
  );
}

function AdditionalImagesUploader({
  urls,
  onChange,
}: {
  urls: string[];
  onChange: (urls: string[]) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleFile = async (file: File) => {
    if (!file.type.startsWith("image/")) return;
    if (urls.length >= MAX_ADDITIONAL_IMAGES) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("image", file);
      const token = await getClerkToken();
      const res = await fetch("/api/products/upload-image", {
        method: "POST",
        body: fd,
        credentials: "include",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Upload failed");
      onChange([...urls, json.url]);
    } catch (err) {
      console.error("Upload error:", err);
    } finally {
      setUploading(false);
    }
  };

  const items = urls.map((url, idx) => ({ id: `${idx}:${url}`, url }));

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      const oldIndex = items.findIndex((it) => it.id === active.id);
      const newIndex = items.findIndex((it) => it.id === over.id);
      if (oldIndex !== -1 && newIndex !== -1) {
        onChange(arrayMove(urls, oldIndex, newIndex));
      }
    }
  }

  const atLimit = urls.length >= MAX_ADDITIONAL_IMAGES;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label className="text-sm">Additional Images</Label>
        <span className="text-xs text-muted-foreground">{urls.length} / {MAX_ADDITIONAL_IMAGES}</span>
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={items.map((it) => it.id)} strategy={horizontalListSortingStrategy}>
          <div className="flex flex-wrap gap-2">
            {items.map(({ id, url }, idx) => (
              <SortableImageItem
                key={id}
                id={id}
                url={url}
                onRemove={() => onChange(urls.filter((_, i) => i !== idx))}
              />
            ))}
            {!atLimit && (
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                disabled={uploading}
                className="w-16 h-16 border-2 border-dashed border-border rounded-md flex flex-col items-center justify-center hover:border-primary/50 hover:bg-secondary/30 transition-colors disabled:opacity-50"
              >
                {uploading ? <Loader2 size={14} className="animate-spin text-muted-foreground" /> : <Plus size={14} className="text-muted-foreground" />}
              </button>
            )}
          </div>
        </SortableContext>
      </DndContext>
      {urls.length > 0 && (
        <p className="text-xs text-muted-foreground">Drag images to reorder them.</p>
      )}
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
          e.target.value = "";
        }}
      />
    </div>
  );
}

type ProductDialogProps = {
  open: boolean;
  onClose: () => void;
  initialValues?: Partial<ProductFormState>;
  productId?: number;
  sku?: string | null;
  brands: Brand[];
  existingNames?: string[];
  onSubmit: (data: ProductFormState) => void;
  isPending: boolean;
  title: string;
  description: string;
  submitLabel: string;
  merchantSyncStatus?: string | null;
  merchantSyncError?: string | null;
  merchantSyncedAt?: string | null;
};

type AvailabilityCountry = { code: string; name: string; flag: string | null };
type AvailabilityCity = { id: number; name: string; country: string };

function ProductDialog({
  open,
  onClose,
  initialValues,
  productId,
  sku,
  brands,
  existingNames = [],
  onSubmit,
  isPending,
  title,
  description,
  submitLabel,
  merchantSyncStatus,
  merchantSyncError,
  merchantSyncedAt,
}: ProductDialogProps) {
  const { t } = useTranslation();
  const [form, setForm] = useState<ProductFormState>({ ...DEFAULT_FORM, ...initialValues });
  const nameWarning = checkNameWarning(form.name, existingNames);

  function set<K extends keyof ProductFormState>(key: K, value: ProductFormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  // ─── Country / City availability (default-on exclusion model) ──────────────
  const isEdit = productId != null;

  // Catalog-attribute brands (separate from the required text `brand` above).
  const catalogBrandsQuery = useListCatalogBrands(
    { pageSize: 100 },
    { query: { enabled: open, queryKey: getListCatalogBrandsQueryKey({ pageSize: 100 }) } },
  );
  const catalogBrands = catalogBrandsQuery.data?.items ?? [];

  // Master lists for the create flow (no product yet).
  const deliveryCountriesQuery = useListDeliveryCountries({
    query: { enabled: open && !isEdit, queryKey: getListDeliveryCountriesQueryKey() },
  });
  const citiesMasterQuery = useQuery({
    queryKey: ["cities-master"],
    queryFn: () => apiFetch<{ cities: { id: number; name: string; country: string; is_active: boolean }[] }>("/api/cities"),
    enabled: open && !isEdit,
  });

  // Per-product availability for the edit flow (universe + current state).
  const productCountryQuery = useGetProductCountryAvailability(productId ?? 0, {
    query: {
      enabled: open && isEdit,
      queryKey: getGetProductCountryAvailabilityQueryKey(productId ?? 0),
    },
  });
  const productCityQuery = useGetProductCityAvailability(productId ?? 0, {
    query: {
      enabled: open && isEdit,
      queryKey: getGetProductCityAvailabilityQueryKey(productId ?? 0),
    },
  });

  const countryOptions: AvailabilityCountry[] = isEdit
    ? (productCountryQuery.data?.countries ?? []).map((c) => ({
        code: c.country_code.toUpperCase(),
        name: c.country_name,
        flag: c.flag_emoji ?? null,
      }))
    : (deliveryCountriesQuery.data?.countries ?? []).map((c) => ({
        code: c.code.toUpperCase(),
        name: c.name,
        flag: c.flag_emoji ?? null,
      }));

  const codeToName = new Map(countryOptions.map((c) => [c.code, c.name]));
  const cityOptions: AvailabilityCity[] = isEdit
    ? (productCityQuery.data?.cities ?? [])
        .filter((c) => c.city_is_active)
        .map((c) => ({
          id: c.city_id,
          name: c.city_name,
          country: codeToName.get(c.country_code.toUpperCase()) ?? c.country_code,
        }))
    : (citiesMasterQuery.data?.cities ?? [])
        .filter((c) => c.is_active)
        .map((c) => ({ id: c.id, name: c.name, country: c.country }));

  const [disabledCountries, setDisabledCountries] = useState<Set<string>>(new Set());
  const [disabledCities, setDisabledCities] = useState<Set<number>>(new Set());
  const [availSeeded, setAvailSeeded] = useState(false);

  // Reset selection state whenever the dialog (re)opens.
  useEffect(() => {
    if (!open) {
      setAvailSeeded(false);
      setDisabledCountries(new Set());
      setDisabledCities(new Set());
    }
  }, [open]);

  // Seed disabled sets from existing per-product rows in the edit flow.
  useEffect(() => {
    if (!open || !isEdit || availSeeded) return;
    if (productCountryQuery.data && productCityQuery.data) {
      setDisabledCountries(
        new Set(
          productCountryQuery.data.countries
            .filter((c) => !c.is_available)
            .map((c) => c.country_code.toUpperCase()),
        ),
      );
      setDisabledCities(
        new Set(productCityQuery.data.cities.filter((c) => !c.is_available).map((c) => c.city_id)),
      );
      setAvailSeeded(true);
    }
  }, [open, isEdit, availSeeded, productCountryQuery.data, productCityQuery.data]);

  function toggleCountry(code: string, available: boolean) {
    setDisabledCountries((prev) => {
      const next = new Set(prev);
      if (available) next.delete(code);
      else next.add(code);
      return next;
    });
  }
  function toggleCity(id: number, available: boolean) {
    setDisabledCities((prev) => {
      const next = new Set(prev);
      if (available) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const citiesByCountry = (() => {
    const map = new Map<string, AvailabilityCity[]>();
    for (const c of cityOptions) {
      const arr = map.get(c.country) ?? [];
      arr.push(c);
      map.set(c.country, arr);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  })();

  const availabilityLoading = isEdit
    ? productCountryQuery.isLoading || productCityQuery.isLoading
    : deliveryCountriesQuery.isLoading || citiesMasterQuery.isLoading;

  function buildAvailabilityUpdates(): Pick<ProductFormState, "countryUpdates" | "cityUpdates"> {
    return {
      countryUpdates: countryOptions.map((c) => ({
        country_code: c.code,
        is_available: !disabledCountries.has(c.code),
      })),
      cityUpdates: cityOptions.map((c) => ({
        city_id: c.id,
        is_available: !disabledCities.has(c.id),
      })),
    };
  }

  const canSubmit =
    form.name.trim().length > 0 &&
    form.brand.trim().length > 0 &&
    form.price_usd !== "" &&
    form.price_aed !== "" &&
    !isNaN(parseFloat(form.price_usd)) &&
    !isNaN(parseFloat(form.price_aed)) &&
    discountError(form.discount_price_usd, form.price_usd) === null &&
    discountError(form.discount_price_aed, form.price_aed) === null &&
    !isPending;

  const discountUsdError = discountError(form.discount_price_usd, form.price_usd);
  const discountAedError = discountError(form.discount_price_aed, form.price_aed);

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          {sku !== undefined && (
            <div className="space-y-1.5">
              <Label className="text-sm">SKU</Label>
              <div className="flex h-9 w-full rounded-md border border-input bg-muted px-3 py-2 text-sm text-muted-foreground select-all font-mono">
                {sku ?? "—"}
              </div>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="prod-name">Name <span className="text-destructive">*</span></Label>
            <Input
              id="prod-name"
              data-testid="input-product-name"
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="e.g. Premium Gift Box"
              autoFocus
            />
            {nameWarning.exactMatch && (
              <p className="text-xs text-amber-600 dark:text-amber-400" data-testid="name-warning-exact">
                A product named &ldquo;{nameWarning.exactMatch}&rdquo; already exists.
              </p>
            )}
            {!nameWarning.exactMatch && nameWarning.similarMatches.length > 0 && (
              <p className="text-xs text-amber-600 dark:text-amber-400" data-testid="name-warning-similar">
                Similar product names already exist: {nameWarning.similarMatches.join(", ")}.
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="prod-price-usd">Price (USD) <span className="text-destructive">*</span></Label>
              <Input
                id="prod-price-usd"
                type="number"
                min="0"
                step="0.01"
                value={form.price_usd}
                onChange={(e) => set("price_usd", e.target.value)}
                placeholder="0.00"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="prod-price-aed">Price (AED) <span className="text-destructive">*</span></Label>
              <Input
                id="prod-price-aed"
                type="number"
                min="0"
                step="0.01"
                value={form.price_aed}
                onChange={(e) => set("price_aed", e.target.value)}
                placeholder="0.00"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="prod-discount-usd">{t("products.discountUsd")} <span className="text-muted-foreground text-xs">({t("products.optional")})</span></Label>
              <Input
                id="prod-discount-usd"
                type="number"
                min="0"
                step="0.01"
                value={form.discount_price_usd}
                onChange={(e) => set("discount_price_usd", e.target.value)}
                placeholder="0.00"
                className={discountUsdError ? "border-destructive focus-visible:ring-destructive/30" : ""}
              />
              {discountUsdError && (
                <p className="text-xs text-destructive">{t(`products.${discountUsdError}`)}</p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="prod-discount-aed">{t("products.discountAed")} <span className="text-muted-foreground text-xs">({t("products.optional")})</span></Label>
              <Input
                id="prod-discount-aed"
                type="number"
                min="0"
                step="0.01"
                value={form.discount_price_aed}
                onChange={(e) => set("discount_price_aed", e.target.value)}
                placeholder="0.00"
                className={discountAedError ? "border-destructive focus-visible:ring-destructive/30" : ""}
              />
              {discountAedError && (
                <p className="text-xs text-destructive">{t(`products.${discountAedError}`)}</p>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Status <span className="text-destructive">*</span></Label>
            <Select value={form.status} onValueChange={(v) => set("status", v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="prod-brand">Brand <span className="text-destructive">*</span></Label>
            <Select
              value={form.brand || ""}
              onValueChange={(v) => set("brand", v)}
            >
              <SelectTrigger id="prod-brand">
                <SelectValue placeholder="Select brand…">
                  {form.brand && (() => {
                    const b = brands.find((b) => b.name === form.brand);
                    return b ? (
                      <span className="flex items-center gap-2">
                        {b.primary_logo_id ? (
                          <WorkspaceImage
                            src={`/api/brands/${b.id}/logos/${b.primary_logo_id}/image`}
                            alt=""
                            className="w-5 h-5 object-contain rounded-sm shrink-0"
                          />
                        ) : (
                          <span className="w-5 h-5 rounded-sm bg-muted shrink-0" />
                        )}
                        {b.name}
                      </span>
                    ) : form.brand;
                  })()}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {brands.map((b) => (
                  <SelectItem key={b.id} value={b.name}>
                    <span className="flex items-center gap-2">
                      {b.primary_logo_id ? (
                        <WorkspaceImage
                          src={`/api/brands/${b.id}/logos/${b.primary_logo_id}/image`}
                          alt=""
                          className="w-5 h-5 object-contain rounded-sm shrink-0"
                        />
                      ) : (
                        <span className="w-5 h-5 rounded-sm bg-muted shrink-0" />
                      )}
                      {b.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="prod-catalog-brand">{t("products.catalogBrand")}</Label>
            <Select
              value={form.catalog_brand_id || "__none__"}
              onValueChange={(v) => set("catalog_brand_id", v === "__none__" ? "" : v)}
            >
              <SelectTrigger id="prod-catalog-brand">
                <SelectValue placeholder={t("products.catalogBrandNone")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__none__">{t("products.catalogBrandNone")}</SelectItem>
                {catalogBrands.map((b) => (
                  <SelectItem key={b.id} value={String(b.id)}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between gap-3 rounded-md border p-3">
            <div className="space-y-0.5">
              <Label htmlFor="prod-express">{t("products.expressDelivery")}</Label>
              <p className="text-xs text-muted-foreground">{t("products.expressDeliveryHint")}</p>
            </div>
            <Switch
              id="prod-express"
              checked={form.express_delivery_enabled}
              onCheckedChange={(v) => set("express_delivery_enabled", v)}
            />
          </div>

          <div className="flex items-center justify-between gap-3 rounded-md border p-3">
            <div className="space-y-0.5">
              <Label htmlFor="prod-input-field">{t("products.hasInputField")}</Label>
              <p className="text-xs text-muted-foreground">{t("products.hasInputFieldHint")}</p>
            </div>
            <Switch
              id="prod-input-field"
              checked={form.has_input_field}
              onCheckedChange={(v) => set("has_input_field", v)}
            />
          </div>

          <div className="flex items-center justify-between gap-3 rounded-md border p-3">
            <div className="space-y-0.5">
              <Label htmlFor="prod-letter-input">{t("products.letterInput")}</Label>
              <p className="text-xs text-muted-foreground">{t("products.letterInputHint")}</p>
            </div>
            <Switch
              id="prod-letter-input"
              checked={form.letter_input_enabled}
              onCheckedChange={(v) => set("letter_input_enabled", v)}
            />
          </div>

          <div className="flex items-center justify-between gap-3 rounded-md border p-3">
            <div className="space-y-0.5">
              <Label htmlFor="prod-upsell">{t("products.upsell")}</Label>
              <p className="text-xs text-muted-foreground">{t("products.upsellHint")}</p>
            </div>
            <Switch
              id="prod-upsell"
              checked={form.is_upsell}
              onCheckedChange={(v) => set("is_upsell", v)}
            />
          </div>

          {isEdit && (merchantSyncStatus || merchantSyncError || merchantSyncedAt) && (
            <div className="rounded-md border p-3 space-y-1.5">
              <div className="flex items-center gap-2">
                <p className="text-xs font-semibold text-foreground">{t("products.merchantDetails")}</p>
                <MerchantBadge
                  status={form.merchant_sync_disabled ? "disabled" : merchantSyncStatus}
                  error={merchantSyncError}
                  syncedAt={merchantSyncedAt}
                />
              </div>
              {merchantSyncedAt && (
                <p className="text-xs text-muted-foreground">
                  {t("products.merchantSyncedAt")}{" "}
                  {new Date(merchantSyncedAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}
                </p>
              )}
              {merchantSyncError && !form.merchant_sync_disabled && (
                <p className="text-xs text-red-600 dark:text-red-400 break-words">{merchantSyncError}</p>
              )}
            </div>
          )}

          {isEdit && (
            <div className="flex items-center justify-between gap-3 rounded-md border p-3">
              <div className="space-y-0.5">
                <Label htmlFor="prod-merchant-sync-disabled">{t("products.merchantSyncDisabled")}</Label>
                <p className="text-xs text-muted-foreground">{t("products.merchantSyncDisabledHint")}</p>
              </div>
              <Switch
                id="prod-merchant-sync-disabled"
                checked={form.merchant_sync_disabled}
                onCheckedChange={(v) => set("merchant_sync_disabled", v)}
              />
            </div>
          )}

          <div className="space-y-1.5">
            <Label>Categories &amp; Occasions</Label>
            <CategoryOccasionPicker
              value={form.categories}
              onChange={(v) => set("categories", v)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="prod-tags">Tags <span className="text-xs text-muted-foreground">(comma-separated)</span></Label>
            <Input
              id="prod-tags"
              value={form.tags}
              onChange={(e) => set("tags", e.target.value)}
              placeholder="e.g. luxury, seasonal"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="prod-desc">Description</Label>
            <Textarea
              id="prod-desc"
              value={form.description}
              onChange={(e) => set("description", e.target.value)}
              placeholder="Optional product description…"
              rows={3}
            />
          </div>

          <ImageUploadButton
            label="Main Image"
            currentUrl={form.main_image_url}
            onUploaded={(url) => set("main_image_url", url)}
            onRemove={() => set("main_image_url", null)}
          />

          <AdditionalImagesUploader
            urls={form.additional_image_urls}
            onChange={(urls) => set("additional_image_urls", urls)}
          />

          <div className="space-y-3 rounded-md border p-3">
            <div>
              <Label className="text-sm font-medium">{t("products.availabilityTitle")}</Label>
              <p className="text-xs text-muted-foreground">{t("products.availabilityHint")}</p>
            </div>

            {availabilityLoading ? (
              <p className="text-xs text-muted-foreground flex items-center gap-1.5">
                <Loader2 size={12} className="animate-spin" />
                {t("products.availabilityLoading")}
              </p>
            ) : (
              <>
                {countryOptions.length > 0 && (
                  <Collapsible defaultOpen>
                    <CollapsibleTrigger className="flex w-full items-center justify-between text-sm font-medium">
                      <span>{t("products.availabilityCountries")}</span>
                      <ChevronDown size={14} />
                    </CollapsibleTrigger>
                    <CollapsibleContent className="pt-2">
                      <div className="grid grid-cols-2 gap-1.5">
                        {countryOptions.map((c) => {
                          const checked = !disabledCountries.has(c.code);
                          return (
                            <label
                              key={c.code}
                              className="flex items-center gap-2 text-sm cursor-pointer rounded px-1 py-1 hover:bg-muted/50"
                            >
                              <Checkbox
                                checked={checked}
                                onCheckedChange={(v) => toggleCountry(c.code, v === true)}
                                data-testid={`avail-country-${c.code}`}
                              />
                              <span className="truncate">
                                {c.flag ? `${c.flag} ` : ""}
                                {c.name}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                )}

                {cityOptions.length > 0 && (
                  <Collapsible defaultOpen>
                    <CollapsibleTrigger className="flex w-full items-center justify-between text-sm font-medium">
                      <span>{t("products.availabilityCities")}</span>
                      <ChevronDown size={14} />
                    </CollapsibleTrigger>
                    <CollapsibleContent className="pt-2 space-y-3 max-h-64 overflow-y-auto">
                      {citiesByCountry.map(([country, cities]) => (
                        <div key={country} className="space-y-1">
                          <p className="text-xs font-medium text-muted-foreground">{country}</p>
                          <div className="grid grid-cols-2 gap-1.5">
                            {cities.map((c) => {
                              const checked = !disabledCities.has(c.id);
                              return (
                                <label
                                  key={c.id}
                                  className="flex items-center gap-2 text-sm cursor-pointer rounded px-1 py-1 hover:bg-muted/50"
                                >
                                  <Checkbox
                                    checked={checked}
                                    onCheckedChange={(v) => toggleCity(c.id, v === true)}
                                    data-testid={`avail-city-${c.id}`}
                                  />
                                  <span className="truncate">{c.name}</span>
                                </label>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                    </CollapsibleContent>
                  </Collapsible>
                )}

                {countryOptions.length === 0 && cityOptions.length === 0 && (
                  <p className="text-xs text-muted-foreground">{t("products.availabilityEmpty")}</p>
                )}
              </>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => onSubmit({ ...form, ...buildAvailabilityUpdates() })}
            disabled={!canSubmit}
          >
            {isPending ? <><Loader2 size={14} className="animate-spin mr-1.5" />{submitLabel}…</> : submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export type FilterState = {
  q: string;
  status: string[];
  brand: string[];
  category: string[];
  occasion: string[];
  catalogBrand: string[];
  brandSearch: string;
  cogsMinPct: string;
  cogsMaxPct: string;
  tab: string;
};

export type PaginationState = {
  page: number;
  pageSize: number;
};

const VALID_PAGE_SIZES = [10, 25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 25;

export function parseFilters(search: string): FilterState {
  const params = new URLSearchParams(search);
  return {
    q: params.get("q") ?? "",
    status: params.getAll("status"),
    brand: params.getAll("brand"),
    category: params.getAll("category"),
    occasion: params.getAll("occasion"),
    catalogBrand: params.getAll("catalogBrand"),
    brandSearch: params.get("brandSearch") ?? "",
    cogsMinPct: params.get("cogsMinPct") ?? "",
    cogsMaxPct: params.get("cogsMaxPct") ?? "",
    tab: params.get("tab") ?? "all",
  };
}

export function parsePagination(search: string): PaginationState {
  const params = new URLSearchParams(search);
  const rawPage = parseInt(params.get("page") ?? "1", 10);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;
  const rawPageSize = parseInt(params.get("pageSize") ?? String(DEFAULT_PAGE_SIZE), 10);
  const pageSize = (VALID_PAGE_SIZES as readonly number[]).includes(rawPageSize) ? rawPageSize : DEFAULT_PAGE_SIZE;
  return { page, pageSize };
}

export function buildProductsUrl(filters: FilterState, pagination?: PaginationState): string {
  const params = new URLSearchParams();
  if (filters.tab === "archived") {
    params.set("archived_only", "true");
  } else {
    if (filters.q) params.set("q", filters.q);
    for (const s of filters.status) params.append("status", s);
    for (const b of filters.brand) params.append("brand", b);
    for (const c of filters.category) params.append("category", c);
    for (const o of filters.occasion) params.append("occasion", o);
    for (const cb of filters.catalogBrand) params.append("catalog_brand", cb);
    if (filters.brandSearch) params.set("brandSearch", filters.brandSearch);
    if (filters.cogsMinPct) params.set("cogs_min_pct", filters.cogsMinPct);
    if (filters.cogsMaxPct) params.set("cogs_max_pct", filters.cogsMaxPct);
  }
  if (pagination) {
    params.set("page", String(pagination.page));
    params.set("pageSize", String(pagination.pageSize));
  }
  const qs = params.toString();
  return qs ? `/api/products?${qs}` : `/api/products`;
}

// The KPI summary respects the active content filters (search + catalog
// attributes) but never the status tab, COGS range, or pagination — those drive
// the per-tab counts / COGS KPI and would otherwise zero out the summary.
export function buildSummaryUrl(filters: FilterState): string {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  for (const b of filters.brand) params.append("brand", b);
  for (const c of filters.category) params.append("category", c);
  for (const o of filters.occasion) params.append("occasion", o);
  for (const cb of filters.catalogBrand) params.append("catalog_brand", cb);
  if (filters.brandSearch) params.set("brandSearch", filters.brandSearch);
  const qs = params.toString();
  return qs ? `/api/products/summary?${qs}` : `/api/products/summary`;
}

export type PageJumpResult =
  | { action: "navigate"; page: number }
  | { action: "reset" };

export function resolvePageJump(
  rawInput: string,
  currentPage: number,
  totalPages: number,
): PageJumpResult {
  const trimmed = rawInput.trim();
  if (!/^\d+$/.test(trimmed)) {
    return { action: "reset" };
  }
  const parsed = parseInt(trimmed, 10);
  const safeTotal = Math.max(1, totalPages);
  const clamped = Math.min(Math.max(parsed, 1), safeTotal);
  if (clamped === currentPage) {
    return { action: "reset" };
  }
  return { action: "navigate", page: clamped };
}

export function buildFilterParams(filters: FilterState, pagination?: PaginationState, viewMode?: "list" | "gallery"): string {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  for (const s of filters.status) params.append("status", s);
  for (const b of filters.brand) params.append("brand", b);
  for (const c of filters.category) params.append("category", c);
  for (const o of filters.occasion) params.append("occasion", o);
  for (const cb of filters.catalogBrand) params.append("catalogBrand", cb);
  if (filters.brandSearch) params.set("brandSearch", filters.brandSearch);
  if (filters.cogsMinPct) params.set("cogsMinPct", filters.cogsMinPct);
  if (filters.cogsMaxPct) params.set("cogsMaxPct", filters.cogsMaxPct);
  if (filters.tab && filters.tab !== "all") params.set("tab", filters.tab);
  if (pagination) {
    if (pagination.page !== 1) params.set("page", String(pagination.page));
    if (pagination.pageSize !== DEFAULT_PAGE_SIZE) params.set("pageSize", String(pagination.pageSize));
  }
  if (viewMode === "gallery") params.set("view", "gallery");
  return params.toString();
}

const PRODUCTS_FILTER_KEY = "products_filter_state";

function loadSavedFilters(): FilterState | null {
  try {
    const raw = sessionStorage.getItem(PRODUCTS_FILTER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const toStringArray = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    return {
      q: typeof parsed.q === "string" ? parsed.q : "",
      status: toStringArray(parsed.status),
      brand: toStringArray(parsed.brand),
      category: toStringArray(parsed.category),
      occasion: toStringArray(parsed.occasion),
      catalogBrand: toStringArray(parsed.catalogBrand),
      brandSearch: typeof parsed.brandSearch === "string" ? parsed.brandSearch : "",
      cogsMinPct: typeof parsed.cogsMinPct === "string" ? parsed.cogsMinPct : "",
      cogsMaxPct: typeof parsed.cogsMaxPct === "string" ? parsed.cogsMaxPct : "",
      tab: typeof parsed.tab === "string" ? parsed.tab : "all",
    };
  } catch {
    return null;
  }
}

function getStatusFiltersForTab(tab: string): string[] {
  switch (tab) {
    case "available": return ["available"];
    case "unavailable": return ["out_of_stock", "not_available"];
    default: return [];
  }
}

const TABS = [
  { id: "all", label: "All Products" },
  { id: "available", label: "Available" },
  { id: "unavailable", label: "Unavailable" },
  { id: "missing_info", label: "Missing Info" },
  { id: "archived", label: "Archived" },
] as const;

export default function ProductsPage() {
  const { t } = useTranslation();
  const [reconciliationOpen, setReconciliationOpen] = useState(false);
  const { toast } = useToast();
  const qc = useQueryClient();
  const { isOwner, allowedPages } = useWorkspaceRole();
  const canManageProducts = isOwner || (allowedPages?.includes("products.manage") ?? false);
  const search = useSearch();
  const [location, navigate] = useLocation();

  const filters = parseFilters(search);
  const pagination = parsePagination(search);

  const [searchInput, setSearchInput] = useState(filters.q);
  const [brandSearchInput, setBrandSearchInput] = useState(filters.brandSearch);
  const [cogsMinInput, setCogsMinInput] = useState(filters.cogsMinPct);
  const [cogsMaxInput, setCogsMaxInput] = useState(filters.cogsMaxPct);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const viewMode: "list" | "gallery" = new URLSearchParams(search).get("view") === "gallery" ? "gallery" : "list";

  const { value: galleryDensity, set: setGalleryDensity } = useUserPreference<"compact" | "comfortable">("products_gallery_density", "compact");

  const searchRef = useRef(search);
  const locationRef = useRef(location);
  useEffect(() => {
    searchRef.current = search;
    locationRef.current = location;
  });

  // Restore saved filters from sessionStorage on mount (view mode handled separately below).
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    const currentSearch = searchRef.current;
    if (currentSearch) return; // URL params already present — nothing to restore
    const savedFilters = loadSavedFilters();
    if (!savedFilters) return;
    const qs = buildFilterParams(savedFilters, undefined, undefined);
    if (qs) {
      navigate(`${locationRef.current.split("?")[0]}?${qs}`, { replace: true });
    }
  }, [navigate]);

  // Server-driven view mode preference: when the server preference first loads and
  // no "view" param is already present in the URL, apply "gallery" if that's the stored pref.
  const { value: viewModePref, loaded: viewModePrefLoaded, set: setViewModePref } =
    useUserPreference<"list" | "gallery">("products_view_mode", "list");
  const viewModeRestoredRef = useRef(false);
  useEffect(() => {
    if (!viewModePrefLoaded || viewModeRestoredRef.current) return;
    viewModeRestoredRef.current = true;
    if (viewModePref !== "gallery") return;
    const currentSearch = searchRef.current;
    const existingParams = new URLSearchParams(currentSearch);
    if (!existingParams.has("view")) {
      existingParams.set("view", "gallery");
      navigate(`${locationRef.current.split("?")[0]}?${existingParams.toString()}`, { replace: true });
    }
  }, [viewModePrefLoaded, viewModePref, navigate]);

  const statusKey = filters.status.join(",");
  const brandKey = filters.brand.join(",");
  const categoryKey = filters.category.join(",");
  const occasionKey = filters.occasion.join(",");
  const catalogBrandKey = filters.catalogBrand.join(",");
  useEffect(() => {
    const hasFilters = !!(
      filters.q ||
      filters.status.length ||
      filters.brand.length ||
      filters.category.length ||
      filters.occasion.length ||
      filters.catalogBrand.length ||
      filters.brandSearch ||
      filters.cogsMinPct ||
      filters.cogsMaxPct
    );
    if (hasFilters) {
      sessionStorage.setItem(PRODUCTS_FILTER_KEY, JSON.stringify(filters));
    } else {
      sessionStorage.removeItem(PRODUCTS_FILTER_KEY);
    }
  }, [filters.q, statusKey, brandKey, categoryKey, occasionKey, catalogBrandKey, filters.brandSearch, filters.cogsMinPct, filters.cogsMaxPct]);

  useEffect(() => { setSearchInput(filters.q); }, [filters.q]);
  useEffect(() => { setBrandSearchInput(filters.brandSearch); }, [filters.brandSearch]);
  useEffect(() => { setCogsMinInput(filters.cogsMinPct); }, [filters.cogsMinPct]);
  useEffect(() => { setCogsMaxInput(filters.cogsMaxPct); }, [filters.cogsMaxPct]);

  const searchInputInitializedRef = useRef(false);
  useEffect(() => {
    if (!searchInputInitializedRef.current) { searchInputInitializedRef.current = true; return; }
    const id = setTimeout(() => {
      const current = parseFilters(searchRef.current);
      const pg = parsePagination(searchRef.current);
      const vm = new URLSearchParams(searchRef.current).get("view") === "gallery" ? "gallery" as const : undefined;
      const qs = buildFilterParams({ ...current, q: searchInput }, { ...pg, page: 1 }, vm);
      const base = locationRef.current.split("?")[0];
      navigate(qs ? `${base}?${qs}` : base, { replace: true });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [searchInput]);

  const brandSearchInputInitializedRef = useRef(false);
  useEffect(() => {
    if (!brandSearchInputInitializedRef.current) { brandSearchInputInitializedRef.current = true; return; }
    const id = setTimeout(() => {
      const current = parseFilters(searchRef.current);
      const pg = parsePagination(searchRef.current);
      const vm = new URLSearchParams(searchRef.current).get("view") === "gallery" ? "gallery" as const : undefined;
      const qs = buildFilterParams({ ...current, brandSearch: brandSearchInput }, { ...pg, page: 1 }, vm);
      const base = locationRef.current.split("?")[0];
      navigate(qs ? `${base}?${qs}` : base, { replace: true });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [brandSearchInput]);

  const cogsInputInitializedRef = useRef(false);
  useEffect(() => {
    if (!cogsInputInitializedRef.current) { cogsInputInitializedRef.current = true; return; }
    const id = setTimeout(() => {
      const current = parseFilters(searchRef.current);
      const pg = parsePagination(searchRef.current);
      const vm = new URLSearchParams(searchRef.current).get("view") === "gallery" ? "gallery" as const : undefined;
      const qs = buildFilterParams(
        { ...current, cogsMinPct: cogsMinInput, cogsMaxPct: cogsMaxInput },
        { ...pg, page: 1 },
        vm,
      );
      const base = locationRef.current.split("?")[0];
      navigate(qs ? `${base}?${qs}` : base, { replace: true });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [cogsMinInput, cogsMaxInput]);

  function buildFilterUrl(nextFilters: FilterState, nextPagination?: PaginationState): string {
    const pg = nextPagination ?? { ...pagination, page: 1 };
    const qs = buildFilterParams(nextFilters, pg, viewMode);
    return qs ? `${location.split("?")[0]}?${qs}` : location.split("?")[0];
  }

  function setViewMode(mode: "list" | "gallery") {
    setViewModePref(mode);
    const qs = buildFilterParams(filters, pagination, mode === "gallery" ? mode : undefined);
    const base = location.split("?")[0];
    navigate(qs ? `${base}?${qs}` : base, { replace: true });
  }

  function updateStatusFilter(statuses: string[]) {
    navigate(buildFilterUrl({ ...filters, status: statuses }), { replace: true });
  }
  function updateBrandFilter(brands: string[]) {
    navigate(buildFilterUrl({ ...filters, brand: brands }), { replace: true });
  }
  function updateCategoryFilter(cats: string[]) {
    navigate(buildFilterUrl({ ...filters, category: cats }), { replace: true });
  }
  function updateOccasionFilter(occasions: string[]) {
    navigate(buildFilterUrl({ ...filters, occasion: occasions }), { replace: true });
  }
  function updateCatalogBrandFilter(brands: string[]) {
    navigate(buildFilterUrl({ ...filters, catalogBrand: brands }), { replace: true });
  }

  function switchTab(tabId: string) {
    const tabStatuses = tabId === "archived" ? [] : getStatusFiltersForTab(tabId);
    const qs = buildFilterParams({ ...filters, tab: tabId, status: tabStatuses }, { page: 1, pageSize: pagination.pageSize });
    const base = location.split("?")[0];
    navigate(qs ? `${base}?${qs}` : base, { replace: true });
    setSelectedIds(new Set());
  }

  function clearAllFilters() {
    setSearchInput("");
    setBrandSearchInput("");
    setCogsMinInput("");
    setCogsMaxInput("");
    sessionStorage.removeItem(PRODUCTS_FILTER_KEY);
    navigate(location.split("?")[0], { replace: true });
  }

  function goToPage(p: number) {
    const qs = buildFilterParams(filters, { ...pagination, page: p });
    const base = location.split("?")[0];
    navigate(qs ? `${base}?${qs}` : base, { replace: true });
  }

  function changePageSize(size: number) {
    const qs = buildFilterParams(filters, { page: 1, pageSize: size });
    const base = location.split("?")[0];
    navigate(qs ? `${base}?${qs}` : base, { replace: true });
  }

  const hasActiveFilters = !!(
    filters.q || filters.status.length > 0 || filters.brand.length > 0 ||
    filters.category.length > 0 || filters.occasion.length > 0 ||
    filters.catalogBrand.length > 0 || filters.brandSearch ||
    filters.cogsMinPct || filters.cogsMaxPct
  );

  const effectiveFilters: FilterState = {
    ...filters,
    status: filters.tab === "archived" ? [] : (filters.status.length > 0 ? filters.status : getStatusFiltersForTab(filters.tab)),
  };

  const { data: summaryData } = useQuery({
    queryKey: [
      "products-summary",
      effectiveFilters.q, effectiveFilters.brand,
      effectiveFilters.category, effectiveFilters.occasion,
      effectiveFilters.catalogBrand, effectiveFilters.brandSearch,
    ],
    queryFn: () => apiFetch<ProductSummary>(buildSummaryUrl(effectiveFilters)),
    staleTime: 30_000,
  });

  const { data: productsData, isLoading } = useQuery({
    queryKey: [
      "products",
      filters.tab,
      effectiveFilters.q, effectiveFilters.status, effectiveFilters.brand,
      effectiveFilters.category, effectiveFilters.occasion,
      effectiveFilters.catalogBrand, effectiveFilters.brandSearch,
      effectiveFilters.cogsMinPct, effectiveFilters.cogsMaxPct,
      pagination.page, pagination.pageSize,
    ],
    queryFn: () =>
      apiFetch<{ products: Product[]; total: number; page: number; pageSize: number; totalPages: number; total_delivery_cities: number }>(
        buildProductsUrl(effectiveFilters, pagination),
      ),
  });

  const totalDeliveryCities = productsData?.total_delivery_cities ?? 0;
  let products = productsData?.products ?? [];
  if (filters.tab === "missing_info") {
    products = products.filter((p) => computeCompleteness(p) < 100);
  }
  const total = productsData?.total ?? 0;
  const totalPages = productsData?.totalPages ?? pagination.page;
  const currentPage = productsData?.page ?? pagination.page;

  const [pageJumpInput, setPageJumpInput] = useState(String(pagination.page));
  useEffect(() => { setPageJumpInput(String(pagination.page)); }, [pagination.page]);

  function commitPageJump() {
    if (!productsData) return;
    const result = resolvePageJump(pageJumpInput, pagination.page, totalPages);
    if (result.action === "navigate") goToPage(result.page);
    else setPageJumpInput(String(pagination.page));
  }

  const { data: brandsData } = useQuery({
    queryKey: ["brands"],
    queryFn: () => apiFetch<{ brands: Brand[] }>("/api/brands"),
  });
  const brands = brandsData?.brands ?? [];

  const { data: categoriesData } = useQuery({
    queryKey: ["product-categories"],
    queryFn: () => apiFetch<{ categories: string[] }>("/api/products/categories"),
  });
  const categories = categoriesData?.categories ?? [];

  const { data: occasionsData } = useListOccasions({ pageSize: 100 }, { query: { queryKey: getListOccasionsQueryKey({ pageSize: 100 }) } });
  const occasionOptions = occasionsData?.items ?? [];

  const { data: catalogBrandsData } = useListCatalogBrands({ pageSize: 100 }, { query: { queryKey: getListCatalogBrandsQueryKey({ pageSize: 100 }) } });
  const catalogBrandOptions = catalogBrandsData?.items ?? [];

  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Product | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Product | null>(null);
  const [bulkEditOpen, setBulkEditOpen] = useState(false);
  const [bulkEditStatus, setBulkEditStatus] = useState("");
  const [bulkEditBrand, setBulkEditBrand] = useState("");
  const [bulkEditCategories, setBulkEditCategories] = useState<SelectedCategoryOption[]>([]);
  const [bulkEditCatalogBrand, setBulkEditCatalogBrand] = useState("");
  const [bulkAvailMode, setBulkAvailMode] = useState("");
  const [bulkAvailCountries, setBulkAvailCountries] = useState<Set<string>>(new Set());
  const [bulkAvailCities, setBulkAvailCities] = useState<Set<number>>(new Set());
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);


  function resetBulkEditState() {
    setBulkEditStatus("");
    setBulkEditBrand("");
    setBulkEditCategories([]);
    setBulkEditCatalogBrand("");
    setBulkAvailMode("");
    setBulkAvailCountries(new Set());
    setBulkAvailCities(new Set());
  }

  // Country / city option lists for the bulk availability picker.
  const bulkCountriesQuery = useListDeliveryCountries({
    query: { enabled: bulkEditOpen, queryKey: getListDeliveryCountriesQueryKey() },
  });
  const bulkCountryOptions = (bulkCountriesQuery.data?.countries ?? []).map((c) => ({
    code: c.code.toUpperCase(),
    name: c.name,
    flag: c.flag_emoji ?? null,
  }));
  const bulkCitiesQuery = useQuery({
    queryKey: ["cities-master"],
    queryFn: () => apiFetch<{ cities: { id: number; name: string; country: string; is_active: boolean }[] }>("/api/cities"),
    enabled: bulkEditOpen,
  });
  const bulkCityOptions = (bulkCitiesQuery.data?.cities ?? []).filter((c) => c.is_active);

  const bulkEditHasChanges =
    (!!bulkEditStatus && bulkEditStatus !== "__no_change__") ||
    (!!bulkEditBrand && bulkEditBrand !== "__no_change__") ||
    bulkEditCategories.length > 0 ||
    (!!bulkEditCatalogBrand && bulkEditCatalogBrand !== "__no_change__") ||
    (!!bulkAvailMode &&
      bulkAvailMode !== "__no_change__" &&
      (bulkAvailCountries.size > 0 || bulkAvailCities.size > 0));

  async function persistAvailability(id: number, form: ProductFormState) {
    if (form.countryUpdates.length > 0) {
      await apiFetch(`/api/products/${id}/country-availability`, {
        method: "PUT",
        body: JSON.stringify(form.countryUpdates),
      });
    }
    if (form.cityUpdates.length > 0) {
      await apiFetch(`/api/products/${id}/city-availability`, {
        method: "PUT",
        body: JSON.stringify(form.cityUpdates),
      });
    }
  }

  async function persistAvailabilityAfterUpdate(
    id: number,
    form: ProductFormState,
  ): Promise<ProductUpdateWarning[]> {
    const warnings: ProductUpdateWarning[] = [];
    const operations: Array<{
      area: string;
      url: string;
      updates: ProductFormState["countryUpdates"] | ProductFormState["cityUpdates"];
    }> = [
      {
        area: "country availability",
        url: `/api/products/${id}/country-availability`,
        updates: form.countryUpdates,
      },
      {
        area: "city availability",
        url: `/api/products/${id}/city-availability`,
        updates: form.cityUpdates,
      },
    ];

    for (const operation of operations) {
      if (operation.updates.length === 0) continue;
      try {
        await apiFetch(operation.url, {
          method: "PUT",
          body: JSON.stringify(operation.updates),
        });
      } catch (err) {
        const detail = err instanceof Error ? err.message : "Unknown error";
        warnings.push({
          area: operation.area,
          message: `The product was saved, but ${operation.area} could not be updated: ${detail}`,
        });
      }
    }

    return warnings;
  }

  const createMutation = useMutation({
    mutationFn: async (form: ProductFormState) => {
      const res = await apiFetch<{ product: Product }>("/api/products", {
        method: "POST",
        body: JSON.stringify({
          name: form.name.trim(),
          price_usd: parseFloat(form.price_usd),
          price_aed: parseFloat(form.price_aed),
          discount_price_usd: form.discount_price_usd.trim() === "" ? null : parseFloat(form.discount_price_usd),
          discount_price_aed: form.discount_price_aed.trim() === "" ? null : parseFloat(form.discount_price_aed),
          description: form.description.trim() || null,
          status: form.status,
          brand: form.brand.trim() || null,
          tags: form.tags.split(",").map((t) => t.trim()).filter(Boolean),
          catalog_category_ids: form.categories.filter((c) => c.kind === "catalog_category").map((c) => c.id),
          occasion_ids: form.categories.filter((c) => c.kind === "occasion").map((c) => c.id),
          main_image_url: form.main_image_url,
          additional_image_urls: form.additional_image_urls,
          express_delivery_enabled: form.express_delivery_enabled,
          has_input_field: form.has_input_field,
          letter_input_enabled: form.letter_input_enabled,
          is_upsell: form.is_upsell,
          catalog_brand_id: form.catalog_brand_id ? Number(form.catalog_brand_id) : null,
        }),
      });
      await persistAvailability(res.product.id, form);
      return res;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: ["products-summary"] });
      toast({ title: "Product created" });
      setCreateOpen(false);
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", title: "Failed to create product", description: err.message });
    },
  });

  const editMutation = useMutation({
    mutationFn: async ({ id, form }: { id: number; form: ProductFormState }) => {
      const res = await apiFetch<{ product: Product; warnings?: ProductUpdateWarning[] }>(`/api/products/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: form.name.trim(),
          price_usd: parseFloat(form.price_usd),
          price_aed: parseFloat(form.price_aed),
          discount_price_usd: form.discount_price_usd.trim() === "" ? null : parseFloat(form.discount_price_usd),
          discount_price_aed: form.discount_price_aed.trim() === "" ? null : parseFloat(form.discount_price_aed),
          description: form.description.trim() || null,
          status: form.status,
          brand: form.brand.trim() || null,
          tags: form.tags.split(",").map((t) => t.trim()).filter(Boolean),
          catalog_category_ids: form.categories.filter((c) => c.kind === "catalog_category").map((c) => c.id),
          occasion_ids: form.categories.filter((c) => c.kind === "occasion").map((c) => c.id),
          main_image_url: form.main_image_url,
          additional_image_urls: form.additional_image_urls,
          express_delivery_enabled: form.express_delivery_enabled,
          has_input_field: form.has_input_field,
          letter_input_enabled: form.letter_input_enabled,
          is_upsell: form.is_upsell,
          merchant_sync_disabled: form.merchant_sync_disabled,
          catalog_brand_id: form.catalog_brand_id ? Number(form.catalog_brand_id) : null,
        }),
      });
      const availabilityWarnings = await persistAvailabilityAfterUpdate(id, form);
      return {
        ...res,
        warnings: [...(res.warnings ?? []), ...availabilityWarnings],
      };
    },
    onSuccess: (result, variables) => {
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: ["products-summary"] });
      qc.invalidateQueries({ queryKey: getGetProductCountryAvailabilityQueryKey(variables.id) });
      qc.invalidateQueries({ queryKey: getGetProductCityAvailabilityQueryKey(variables.id) });
      toast({ title: "Product updated" });
      if (result.warnings.length > 0) {
        toast({
          title: "Product updated with a warning",
          description: result.warnings.map((warning) => warning.message).join(" "),
        });
      }
      setEditTarget(null);
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", title: "Failed to update product", description: err.message });
    },
  });

  const duplicateMutation = useMutation({
    mutationFn: async (id: number) => {
      return apiFetch<{ product: Product }>(`/api/products/${id}/duplicate`, {
        method: "POST",
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: ["products-summary"] });
      toast({ title: "Product duplicated" });
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", title: "Failed to duplicate product", description: err.message });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/products/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: ["products-summary"] });
      setDeleteTarget(null);
      toast({ title: "Product deleted" });
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", title: "Delete failed", description: err.message });
      setDeleteTarget(null);
    },
  });

  const bulkUpdateMutation = useBulkUpdateProducts({
    mutation: {
      onSuccess: (data) => {
        qc.invalidateQueries({ queryKey: ["products"] });
        qc.invalidateQueries({ queryKey: ["products-summary"] });
        toast({ title: `${data.updated} product${data.updated === 1 ? "" : "s"} updated` });
        setSelectedIds(new Set());
        setBulkEditOpen(false);
        resetBulkEditState();
      },
      onError: (err: Error) => {
        toast({ variant: "destructive", title: "Bulk update failed", description: err.message });
      },
    },
  });

  const bulkDeleteMutation = useBulkDeleteProducts({
    mutation: {
      onSuccess: (data) => {
        qc.invalidateQueries({ queryKey: ["products"] });
        qc.invalidateQueries({ queryKey: ["products-summary"] });
        toast({ title: t("products.bulkDeletedToast", { count: data.deleted }) });
        setSelectedIds(new Set());
        setBulkDeleteOpen(false);
      },
      onError: (err: Error) => {
        toast({ variant: "destructive", title: t("products.bulkDeleteFailed"), description: err.message });
        setBulkDeleteOpen(false);
      },
    },
  });

  const syncMutation = useMutation<PublishAreaResult>({
    mutationFn: () =>
      apiFetch<PublishAreaResult>("/api/publish/products", { method: "POST" }),
    onSuccess: (data) => {
      if (data.success) {
        toast({
          title: "Synced to website",
          description: `${data.count} product${data.count === 1 ? "" : "s"} pushed to the connected website.`,
        });
      } else {
        toast({
          variant: "destructive",
          title: "Sync failed",
          description: data.error ?? "The connected website did not accept the products.",
        });
      }
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", title: "Sync failed", description: err.message });
    },
  });

  // GMC Sync Health — owner-only, only fetches when isOwner
  type MerchantSyncIssue = { id: number; name: string; status: string | null; error: string | null; syncedAt: string | null };
  type MerchantSyncStatusData = {
    counts: { pending: number; running: number; completed: number; failed: number; retry_waiting: number };
    config?: { ok: boolean; problems: string[] };
    issues: MerchantSyncIssue[];
  };
  const { data: merchantSyncStatus } = useQuery<MerchantSyncStatusData>({
    queryKey: ["merchant-sync-status"],
    queryFn: () => apiFetch<MerchantSyncStatusData>("/api/products/merchant-sync-status"),
    enabled: isOwner,
    refetchInterval: 30_000,
  });



  async function handleExport() {
    try {
      const idsParam = selectedIds.size > 0 ? `?ids=${Array.from(selectedIds).join(",")}` : "";
      const token = await getClerkToken();
      const res = await fetch(`/api/products/export${idsParam}`, {
        credentials: "include",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error((json as { error?: string }).error ?? "Export failed");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const date = new Date().toISOString().slice(0, 10);
      a.download = `products-export-${date}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      toast({ variant: "destructive", title: "Export failed", description: (err as Error).message });
    }
  }

  const archiveMutation = useMutation({
    mutationFn: ({ id, is_archived }: { id: number; is_archived: boolean }) =>
      apiFetch<{ product: Product }>(`/api/products/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ is_archived }),
      }),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: ["products-summary"] });
      toast({ title: variables.is_archived ? "Product archived" : "Product restored" });
    },
    onError: (err: Error, variables) => {
      toast({ variant: "destructive", title: variables.is_archived ? "Archive failed" : "Restore failed", description: err.message });
    },
  });
  function productToFormState(p: Product): ProductFormState {
    return {
      name: p.name,
      price_usd: p.price_usd,
      price_aed: p.price_aed,
      discount_price_usd: p.discount_price_usd ?? "",
      discount_price_aed: p.discount_price_aed ?? "",
      description: p.description ?? "",
      status: p.status,
      brand: p.brand ?? "",
      categories: [
        ...(p.catalog_categories ?? []).map((c) => ({
          kind: "catalog_category" as const,
          id: c.id,
          name: c.name,
          slug: c.slug,
        })),
        ...(p.occasions ?? []).map((o) => ({
          kind: "occasion" as const,
          id: o.id,
          name: o.name,
          slug: o.slug,
        })),
      ],
      tags: p.tags.join(", "),
      main_image_url: p.main_image_url,
      additional_image_urls: p.additional_image_urls,
      express_delivery_enabled: p.express_delivery_enabled ?? true,
      has_input_field: p.has_input_field ?? false,
      letter_input_enabled: p.letter_input_enabled ?? false,
      is_upsell: p.is_upsell ?? false,
      merchant_sync_disabled: p.merchant_sync_disabled ?? false,
      catalog_brand_id: p.catalog_brand ? String(p.catalog_brand.id) : "",
      countryUpdates: [],
      cityUpdates: [],
    };
  }

  function toggleSelect(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    if (selectedIds.size === products.length && products.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(products.map((p) => p.id)));
    }
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Products</h1>
          <p className="text-muted-foreground mt-1">
            Manage your workspace's product catalogue.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StaleDataBadge
            queries={[{ queryKey: ["products"], url: "/api/products" }]}
            data-testid="products-stale-badge"
          />
          {canManageProducts && (
            <Button
              variant="outline"
              onClick={() => syncMutation.mutate()}
              disabled={syncMutation.isPending}
              data-testid="button-sync-products"
            >
              {syncMutation.isPending ? (
                <Loader2 size={16} className="mr-2 animate-spin" />
              ) : (
                <RefreshCw size={16} className="mr-2" />
              )}
              {syncMutation.isPending ? "Syncing…" : "Sync to website"}
            </Button>
          )}

          {isOwner && (
            <Button
              variant="outline"
              onClick={() => setReconciliationOpen(true)}
              className="w-full sm:w-auto text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-900 hover:bg-emerald-50 dark:hover:bg-emerald-900/30"
              data-testid="btn-open-reconciliation"
            >
              <RefreshCcw size={16} className="mr-2" />
              Merchant Reconciliation
            </Button>
          )}
          {canManageProducts && (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus size={16} className="mr-2" />
              New Product
            </Button>
          )}
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        {[
          {
            icon: <Package size={16} className="text-muted-foreground" />,
            label: "Total Products",
            value: summaryData?.total ?? "—",
          },
          {
            icon: <div className="w-2 h-2 rounded-full bg-green-500 shrink-0" />,
            label: "Available",
            value: summaryData?.available_count ?? "—",
          },
          {
            icon: <div className="w-2 h-2 rounded-full bg-red-400 shrink-0" />,
            label: "Hidden",
            value: summaryData?.hidden_count ?? "—",
          },
          {
            icon: <TrendingUp size={16} className="text-muted-foreground" />,
            label: "Avg COGS %",
            value: summaryData?.avg_cogs_pct != null
              ? `${summaryData.avg_cogs_pct.toFixed(1)}%`
              : "—",
          },
          {
            icon: <AlertCircle size={16} className="text-amber-500" />,
            label: "Missing Info",
            value: summaryData?.missing_info_count ?? "—",
          },
          {
            icon: <ImageIcon size={16} className="text-muted-foreground" />,
            label: "Missing Images",
            value: summaryData?.missing_images_count ?? "—",
          },
        ].map((card) => (
          <div
            key={card.label}
            className="rounded-lg border border-border bg-card p-3 flex flex-col gap-1"
          >
            <div className="flex items-center gap-1.5">
              {card.icon}
              <span className="text-xs text-muted-foreground truncate">{card.label}</span>
            </div>
            <p className="text-xl font-bold tabular-nums">{card.value}</p>
          </div>
        ))}
      </div>

      {/* GMC Sync Health */}
      {isOwner && merchantSyncStatus && (merchantSyncStatus.config?.ok === false || merchantSyncStatus.counts.failed > 0 || merchantSyncStatus.counts.retry_waiting > 0 || merchantSyncStatus.issues.length > 0) && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30 p-4 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <AlertCircle size={16} className="text-amber-600 dark:text-amber-400 shrink-0" />
              <span className="text-sm font-semibold text-amber-900 dark:text-amber-200">Google Merchant Center Sync Health</span>
            </div>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              {merchantSyncStatus.counts.pending > 0 && <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-blue-400" />{merchantSyncStatus.counts.pending} pending</span>}
              {merchantSyncStatus.counts.running > 0 && <span className="flex items-center gap-1"><Loader2 size={10} className="animate-spin" />{merchantSyncStatus.counts.running} running</span>}
              {merchantSyncStatus.counts.retry_waiting > 0 && <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-amber-400" />{merchantSyncStatus.counts.retry_waiting} waiting retry</span>}
              {merchantSyncStatus.counts.failed > 0 && <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-red-500" />{merchantSyncStatus.counts.failed} failed</span>}
              {merchantSyncStatus.counts.completed > 0 && <span className="flex items-center gap-1"><span className="inline-block w-2 h-2 rounded-full bg-green-500" />{merchantSyncStatus.counts.completed} completed</span>}
            </div>
          </div>
          {merchantSyncStatus.config?.ok === false && (
            <div className="rounded border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 px-3 py-2 space-y-1" data-testid="merchant-config-problems">
              <p className="text-xs font-semibold text-red-800 dark:text-red-300">Merchant Center is not configured — nothing will be sent until this is fixed:</p>
              {merchantSyncStatus.config.problems.map((problem, i) => (
                <p key={i} className="text-xs text-red-700 dark:text-red-400 break-words">{problem}</p>
              ))}
            </div>
          )}
          {merchantSyncStatus.issues.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-amber-800 dark:text-amber-300">Products with issues:</p>
              <div className="max-h-48 overflow-y-auto rounded border border-amber-200 dark:border-amber-800 bg-white dark:bg-background divide-y divide-amber-100 dark:divide-amber-900">
                {merchantSyncStatus.issues.map((issue) => (
                  <div key={issue.id} className="flex items-start gap-2 px-3 py-2 text-xs">
                    <span className={`mt-0.5 inline-block w-2 h-2 rounded-full shrink-0 ${issue.status === "FAILED" ? "bg-red-500" : issue.status === "ACTION_REQUIRED" ? "bg-orange-500" : "bg-amber-400"}`} />
                    <div className="min-w-0 flex-1">
                      <span className="font-medium text-foreground truncate block">{issue.name}</span>
                      <span className="text-muted-foreground break-words">{issue.error}</span>
                    </div>
                    {issue.syncedAt && (
                      <span className="text-muted-foreground whitespace-nowrap shrink-0">
                        {new Date(issue.syncedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-border">
        {TABS.map((tab) => {
          const isActive = filters.tab === tab.id || (tab.id === "all" && !filters.tab);
          const count = tab.id === "all"
            ? summaryData?.total
            : tab.id === "available"
            ? summaryData?.available_count
            : tab.id === "unavailable"
            ? summaryData?.hidden_count
            : tab.id === "missing_info"
            ? summaryData?.missing_info_count
            : tab.id === "archived"
            ? summaryData?.archived_count
            : undefined;
          return (
            <button
              key={tab.id}
              onClick={() => switchTab(tab.id)}
              className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium border-b-2 transition-colors ${
                isActive
                  ? "border-primary text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {tab.label}
              {count !== undefined && (
                <span className={`text-xs tabular-nums px-1.5 py-0.5 rounded-full ${
                  isActive ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
                }`}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Filters row */}
      <div className="flex flex-wrap gap-2">
        <div className="relative flex-1 min-w-[180px]">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <Input
            className="pl-8"
            placeholder="Search products by name or SKU…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </div>

        {/* Status filter */}
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" className="w-36 justify-between font-normal">
              <span className="truncate">
                {filters.status.length === 0
                  ? "All Statuses"
                  : filters.status.length === 1
                  ? (STATUS_OPTIONS.find((o) => o.value === filters.status[0])?.label ?? filters.status[0])
                  : `${filters.status.length} statuses`}
              </span>
              <ChevronDown size={14} className="ml-2 shrink-0 text-muted-foreground" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-48 p-1" align="start">
            {STATUS_OPTIONS.map((opt) => {
              const checked = filters.status.includes(opt.value);
              return (
                <div
                  key={opt.value}
                  role="option"
                  aria-selected={checked}
                  className="flex items-center gap-2 w-full rounded px-2 py-1.5 text-sm cursor-pointer select-none hover:bg-secondary/60 transition-colors"
                  onClick={() => updateStatusFilter(
                    checked ? filters.status.filter((s) => s !== opt.value) : [...filters.status, opt.value]
                  )}
                >
                  <span className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-primary ${checked ? "bg-primary text-primary-foreground" : "bg-background"}`}>
                    {checked && (
                      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </span>
                  <span>{opt.label}</span>
                </div>
              );
            })}
          </PopoverContent>
        </Popover>

        {/* Brand filter */}
        {brands.length > 0 && (
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" className="w-36 justify-between font-normal">
                <span className="truncate">
                  {filters.brandSearch
                    ? `"${filters.brandSearch}"`
                    : filters.brand.length === 0
                    ? "All Brands"
                    : filters.brand.length === 1
                    ? filters.brand[0]
                    : `${filters.brand.length} brands`}
                </span>
                <ChevronDown size={14} className="ml-2 shrink-0 text-muted-foreground" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-52 p-1" align="start">
              <div className="px-1 pb-1">
                <div className="relative">
                  <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                  <input
                    type="text"
                    placeholder="Search brands…"
                    value={brandSearchInput}
                    onChange={(e) => setBrandSearchInput(e.target.value)}
                    className="w-full rounded border border-input bg-background pl-6 pr-2 py-1 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                  />
                  {brandSearchInput && (
                    <button
                      type="button"
                      onClick={() => setBrandSearchInput("")}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      <X size={10} />
                    </button>
                  )}
                </div>
              </div>
              {brands
                .filter((b) => !brandSearchInput || b.name.toLowerCase().includes(brandSearchInput.toLowerCase()))
                .map((b) => {
                  const checked = filters.brand.includes(b.name);
                  return (
                    <div
                      key={b.id}
                      role="option"
                      aria-selected={checked}
                      className="flex items-center gap-2 w-full rounded px-2 py-1.5 text-sm cursor-pointer select-none hover:bg-secondary/60 transition-colors"
                      onClick={() => updateBrandFilter(
                        checked ? filters.brand.filter((x) => x !== b.name) : [...filters.brand, b.name]
                      )}
                    >
                      <span className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-primary ${checked ? "bg-primary text-primary-foreground" : "bg-background"}`}>
                        {checked && (
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3">
                            <polyline points="20 6 9 17 4 12" />
                          </svg>
                        )}
                      </span>
                      <span>{b.name}</span>
                    </div>
                  );
                })}
              {brands.filter((b) => !brandSearchInput || b.name.toLowerCase().includes(brandSearchInput.toLowerCase())).length === 0 && (
                <p className="px-2 py-3 text-xs text-muted-foreground text-center">No brands match &ldquo;{brandSearchInput}&rdquo;</p>
              )}
            </PopoverContent>
          </Popover>
        )}

        {/* Category filter */}
        {categories.length > 0 && (
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" className="w-36 justify-between font-normal">
                <span className="truncate">
                  {filters.category.length === 0
                    ? "All Categories"
                    : filters.category.length === 1
                    ? filters.category[0]
                    : `${filters.category.length} categories`}
                </span>
                <ChevronDown size={14} className="ml-2 shrink-0 text-muted-foreground" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-48 p-1" align="start">
              {categories.map((c) => {
                const checked = filters.category.includes(c);
                return (
                  <div
                    key={c}
                    role="option"
                    aria-selected={checked}
                    className="flex items-center gap-2 w-full rounded px-2 py-1.5 text-sm cursor-pointer select-none hover:bg-secondary/60 transition-colors"
                    onClick={() => updateCategoryFilter(
                      checked ? filters.category.filter((x) => x !== c) : [...filters.category, c]
                    )}
                  >
                    <span className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-primary ${checked ? "bg-primary text-primary-foreground" : "bg-background"}`}>
                      {checked && (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                    </span>
                    <span>{c}</span>
                  </div>
                );
              })}
            </PopoverContent>
          </Popover>
        )}

        {/* Occasion filter */}
        {occasionOptions.length > 0 && (
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" className="w-36 justify-between font-normal">
                <span className="truncate">
                  {filters.occasion.length === 0
                    ? t("products.allOccasions", "All Occasions")
                    : filters.occasion.length === 1
                    ? (occasionOptions.find((o) => o.slug === filters.occasion[0])?.name ?? filters.occasion[0])
                    : t("products.occasionCount", "{{count}} occasions", { count: filters.occasion.length })}
                </span>
                <ChevronDown size={14} className="ml-2 shrink-0 text-muted-foreground" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-48 p-1" align="start">
              {occasionOptions.map((o) => {
                const checked = filters.occasion.includes(o.slug);
                return (
                  <div
                    key={o.id}
                    role="option"
                    aria-selected={checked}
                    className="flex items-center gap-2 w-full rounded px-2 py-1.5 text-sm cursor-pointer select-none hover:bg-secondary/60 transition-colors"
                    onClick={() => updateOccasionFilter(
                      checked ? filters.occasion.filter((x) => x !== o.slug) : [...filters.occasion, o.slug]
                    )}
                  >
                    <span className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-primary ${checked ? "bg-primary text-primary-foreground" : "bg-background"}`}>
                      {checked && (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                    </span>
                    <span>{o.name}</span>
                  </div>
                );
              })}
            </PopoverContent>
          </Popover>
        )}

        {/* Catalog Brand filter */}
        {catalogBrandOptions.length > 0 && (
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" className="w-36 justify-between font-normal">
                <span className="truncate">
                  {filters.catalogBrand.length === 0
                    ? t("products.allCatalogBrands", "All Brands")
                    : filters.catalogBrand.length === 1
                    ? (catalogBrandOptions.find((b) => b.slug === filters.catalogBrand[0])?.name ?? filters.catalogBrand[0])
                    : t("products.catalogBrandCount", "{{count}} brands", { count: filters.catalogBrand.length })}
                </span>
                <ChevronDown size={14} className="ml-2 shrink-0 text-muted-foreground" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-48 p-1" align="start">
              {catalogBrandOptions.map((b) => {
                const checked = filters.catalogBrand.includes(b.slug);
                return (
                  <div
                    key={b.id}
                    role="option"
                    aria-selected={checked}
                    className="flex items-center gap-2 w-full rounded px-2 py-1.5 text-sm cursor-pointer select-none hover:bg-secondary/60 transition-colors"
                    onClick={() => updateCatalogBrandFilter(
                      checked ? filters.catalogBrand.filter((x) => x !== b.slug) : [...filters.catalogBrand, b.slug]
                    )}
                  >
                    <span className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-primary ${checked ? "bg-primary text-primary-foreground" : "bg-background"}`}>
                      {checked && (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                    </span>
                    <span>{b.name}</span>
                  </div>
                );
              })}
            </PopoverContent>
          </Popover>
        )}

        {/* COGS % Range */}
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              className={`w-36 justify-between font-normal ${filters.cogsMinPct || filters.cogsMaxPct ? "border-primary text-primary" : ""}`}
            >
              <span className="truncate">
                {filters.cogsMinPct || filters.cogsMaxPct
                  ? `COGS: ${filters.cogsMinPct || "0"}–${filters.cogsMaxPct || "∞"}%`
                  : "COGS % Range"}
              </span>
              <BarChart3 size={14} className="ml-2 shrink-0 text-muted-foreground" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-56 p-3" align="start">
            <p className="text-xs font-medium mb-2 text-muted-foreground">Filter by COGS %</p>
            <div className="flex items-center gap-2">
              <div className="flex-1">
                <Label className="text-xs mb-1">Min %</Label>
                <Input
                  type="number"
                  min="0"
                  max="100"
                  step="1"
                  placeholder="0"
                  value={cogsMinInput}
                  onChange={(e) => setCogsMinInput(e.target.value)}
                  className="h-8 text-sm"
                />
              </div>
              <span className="text-muted-foreground mt-5">–</span>
              <div className="flex-1">
                <Label className="text-xs mb-1">Max %</Label>
                <Input
                  type="number"
                  min="0"
                  max="200"
                  step="1"
                  placeholder="100"
                  value={cogsMaxInput}
                  onChange={(e) => setCogsMaxInput(e.target.value)}
                  className="h-8 text-sm"
                />
              </div>
            </div>
            {(cogsMinInput || cogsMaxInput) && (
              <Button
                variant="ghost"
                size="sm"
                className="w-full mt-2 h-7 text-xs"
                onClick={() => { setCogsMinInput(""); setCogsMaxInput(""); }}
              >
                Clear COGS filter
              </Button>
            )}
          </PopoverContent>
        </Popover>

        {hasActiveFilters && (
          <Button variant="ghost" size="sm" className="shrink-0 h-10 px-3 text-muted-foreground" onClick={clearAllFilters}>
            <X size={14} className="mr-1.5" />
            Clear
          </Button>
        )}
      </div>

      {/* Bulk actions toolbar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/50 px-4 py-2.5">
          <span className="text-sm font-medium">{selectedIds.size} selected</span>
          <div className="flex items-center gap-2 ml-2">
            {canManageProducts && (
              <Button
                variant="outline"
                size="sm"
                className="h-8"
                onClick={() => {
                  resetBulkEditState();
                  setBulkEditOpen(true);
                }}
              >
                <Pencil size={13} className="mr-1.5" />
                Bulk Edit
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              onClick={handleExport}
            >
              Export
            </Button>


            <Button
              variant="outline"
              size="sm"
              className="h-8 text-destructive hover:text-destructive"
              disabled={archiveMutation.isPending}
              onClick={() => {
                bulkUpdateMutation.mutate({
                  data: { ids: Array.from(selectedIds), updates: { is_archived: true } },
                });
              }}
            >
              <Archive size={13} className="mr-1.5" />
              Archive
            </Button>
            {isOwner && (
              <Button
                variant="outline"
                size="sm"
                className="h-8 text-destructive hover:text-destructive"
                disabled={bulkDeleteMutation.isPending}
                onClick={() => setBulkDeleteOpen(true)}
                data-testid="button-bulk-delete"
              >
                <Trash2 size={13} className="mr-1.5" />
                {t("products.bulkDelete")}
              </Button>
            )}
          </div>
          <button
            type="button"
            className="ml-auto text-muted-foreground hover:text-foreground"
            onClick={() => setSelectedIds(new Set())}
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* View toggle + result count */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-sm text-muted-foreground">
          {isLoading ? "Loading…" : total === 1 ? "1 product" : `${total} products`}
        </span>
        <div className="flex items-center gap-2">
          {viewMode === "gallery" && (
            <div className="flex items-center gap-1 rounded-md border border-border p-0.5" data-testid="products-gallery-density-toggle">
              <button
                type="button"
                data-testid="products-gallery-density-compact"
                onClick={() => setGalleryDensity("compact")}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs transition-colors ${
                  galleryDensity === "compact" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
                title="Compact"
              >
                Compact
              </button>
              <button
                type="button"
                data-testid="products-gallery-density-comfortable"
                onClick={() => setGalleryDensity("comfortable")}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs transition-colors ${
                  galleryDensity === "comfortable" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
                title="Comfortable"
              >
                Comfortable
              </button>
            </div>
          )}
          <div className="flex items-center gap-1 rounded-md border border-border p-0.5" data-testid="products-view-toggle">
            <button
              type="button"
              data-testid="products-view-toggle-list"
              onClick={() => setViewMode("list")}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-sm transition-colors ${
                viewMode === "list" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
              title="List view"
            >
              <LayoutList size={14} />
            </button>
            <button
              type="button"
              data-testid="products-view-toggle-gallery"
              onClick={() => setViewMode("gallery")}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-sm transition-colors ${
                viewMode === "gallery" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
              title="Gallery view"
            >
              <LayoutGrid size={14} />
            </button>
          </div>
        </div>
      </div>

      {/* Products list / gallery */}
      {isLoading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : products.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-12 text-center">
          <ShoppingBag size={32} className="mx-auto mb-3 text-muted-foreground" />
          {hasActiveFilters || filters.tab !== "all" ? (
            <>
              <p className="font-medium">No products match your filters</p>
              <p className="text-sm text-muted-foreground mt-1">Try adjusting or clearing the filters.</p>
              <Button variant="outline" className="mt-4" onClick={clearAllFilters}>
                Clear filters
              </Button>
            </>
          ) : (
            <>
              <p className="font-medium">No products yet</p>
              <p className="text-sm text-muted-foreground mt-1">Add products to build your workspace catalogue.</p>
              {canManageProducts && (
                <Button className="mt-4" onClick={() => setCreateOpen(true)}>
                  <Plus size={16} className="mr-2" />
                  New Product
                </Button>
              )}
            </>
          )}
        </div>
      ) : viewMode === "gallery" ? (
        <div
          className={`grid gap-4 ${
            galleryDensity === "comfortable"
              ? "grid-cols-2 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4"
              : "grid-cols-2 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-5"
          }`}
          data-testid="products-gallery"
        >
          {products.map((product, index) => {
            const mainImg = productImageUrl(product, "thumbnail");
            const cogsPct = computeCogsPct(product);
            const marginPct = cogsPct !== null ? 100 - cogsPct : null;
            const completeness = computeCompleteness(product);
            const isSelected = selectedIds.has(product.id);
            const isComfortable = galleryDensity === "comfortable";

            return (
              <div
                key={product.id}
                className={`relative rounded-lg border bg-card overflow-hidden cursor-pointer hover:shadow-md transition-shadow ${
                  isSelected ? "border-primary ring-1 ring-primary" : "border-border"
                }`}
                onClick={() => navigate(`/products/${product.id}`)}
              >
                {/* Checkbox */}
                <div
                  className="absolute top-2 left-2 z-10"
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-border cursor-pointer accent-primary"
                    checked={isSelected}
                    onChange={() => toggleSelect(product.id)}
                    aria-label={`Select ${product.name}`}
                  />
                </div>

                {/* Actions dropdown */}
                <div
                  className="absolute top-2 right-2 z-10"
                  onClick={(e) => e.stopPropagation()}
                >
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 w-7 p-0 bg-background/80 hover:bg-background backdrop-blur-sm"
                        aria-label="Product actions"
                      >
                        <MoreHorizontal size={13} />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-44">
                      {canManageProducts && (
                        <DropdownMenuItem
                          data-testid={`button-edit-product-gallery-${product.id}`}
                          onClick={() => setEditTarget(product)}
                        >
                          <Pencil size={14} className="mr-2" />
                          Edit product
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem onClick={() => navigate(`/products/${product.id}`)}>
                        <ExternalLink size={14} className="mr-2" />
                        View product
                      </DropdownMenuItem>
                      {canManageProducts && (
                        <DropdownMenuItem
                          onClick={() => duplicateMutation.mutate(product.id)}
                          disabled={duplicateMutation.isPending}
                        >
                          <Copy size={14} className="mr-2" />
                          Duplicate
                        </DropdownMenuItem>
                      )}
                      {canManageProducts && (
                        <>
                          <DropdownMenuSeparator />
                          {product.is_archived ? (
                            <DropdownMenuItem
                              onClick={() => archiveMutation.mutate({ id: product.id, is_archived: false })}
                              disabled={archiveMutation.isPending}
                            >
                              <Archive size={14} className="mr-2" />
                              Restore
                            </DropdownMenuItem>
                          ) : (
                            <DropdownMenuItem
                              onClick={() => archiveMutation.mutate({ id: product.id, is_archived: true })}
                              disabled={archiveMutation.isPending}
                            >
                              <Archive size={14} className="mr-2" />
                              Archive
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onClick={() => setDeleteTarget(product)}
                          >
                            <Trash2 size={14} className="mr-2" />
                            Delete product
                          </DropdownMenuItem>
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>

                {/* Product image */}
                <div className={`${isComfortable ? "aspect-[4/3]" : "aspect-square"} bg-muted flex items-center justify-center overflow-hidden`}>
                  {mainImg ? (
                    <img
                      src={mainImg}
                      alt={product.name}
                      width={320}
                      height={320}
                      loading={index < 4 ? "eager" : "lazy"}
                      decoding="async"
                      onError={(event) =>
                        fallbackToOriginalProductImage(event.currentTarget, product.main_image_url)
                      }
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <ImageIcon size={isComfortable ? 36 : 28} className="text-muted-foreground/50" />
                  )}
                </div>

                {/* Card body */}
                <div className={`${isComfortable ? "p-4" : "p-3"} space-y-2`}>
                  <p className={`font-medium leading-snug line-clamp-2 ${isComfortable ? "text-sm" : "text-sm"}`}>{product.name}</p>
                  {product.brand && (
                    <p className="text-xs text-muted-foreground truncate">{product.brand}</p>
                  )}
                  {isComfortable ? (
                    <>
                      <div className="flex items-center justify-between gap-1">
                        <div className="flex flex-col gap-0.5">
                          {product.discount_price_usd ? (
                            <span className="flex items-baseline gap-1.5">
                              <PriceText value={formatUSD(product.discount_price_usd)} />
                              <span className="text-xs text-muted-foreground line-through font-mono tabular-nums">{formatUSD(product.price_usd)}</span>
                            </span>
                          ) : (
                            <PriceText value={formatUSD(product.price_usd)} />
                          )}
                          <span className="text-xs text-muted-foreground font-mono tabular-nums">
                            {product.discount_price_aed ? (
                              <>
                                {formatAED(product.discount_price_aed)} <span className="line-through">{formatAED(product.price_aed)}</span>
                              </>
                            ) : (
                              formatAED(product.price_aed)
                            )}
                          </span>
                        </div>
                        <div className="flex flex-col items-end gap-0.5">
                          {cogsPct !== null ? (
                            <span className="text-xs text-muted-foreground font-mono tabular-nums">
                              {Math.round(cogsPct)}% COGS
                            </span>
                          ) : (
                            <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border-0 text-[10px]">
                              No COGS
                            </Badge>
                          )}
                          {marginPct !== null ? (
                            <span className={`text-xs font-mono tabular-nums font-medium ${marginPct < 0 ? "text-red-600" : marginPct < 30 ? "text-amber-600" : "text-green-600"}`}>
                              {Math.round(marginPct)}% margin
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="flex items-center justify-between gap-1">
                      {product.discount_price_usd ? (
                        <span className="flex items-baseline gap-1.5">
                          <PriceText value={formatUSD(product.discount_price_usd)} />
                          <span className="text-xs text-muted-foreground line-through font-mono tabular-nums">{formatUSD(product.price_usd)}</span>
                        </span>
                      ) : (
                        <PriceText value={formatUSD(product.price_usd)} />
                      )}
                      {cogsPct !== null ? (
                        <span className="text-xs text-muted-foreground font-mono tabular-nums">
                          {Math.round(cogsPct)}% COGS
                        </span>
                      ) : null}
                    </div>
                  )}
                  <div className="flex flex-wrap gap-1">
                    <CompletnessBadge pct={completeness} />
                    {statusBadge(product.status)}
                    <MerchantBadge
                      status={product.merchant_sync_disabled ? "disabled" : product.merchant_sync_status}
                      error={product.merchant_sync_error}
                      syncedAt={product.merchant_synced_at}
                    />
                    <DeliveryCitiesBadge
                      disabledCount={product.delivery_disabled_count ?? 0}
                      totalCities={totalDeliveryCities}
                    />
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden" data-testid="products-list">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40">
                  <th className="w-10 px-3 py-2.5 text-left">
                    <input
                      type="checkbox"
                      className="h-4 w-4 rounded border-border cursor-pointer"
                      checked={selectedIds.size === products.length && products.length > 0}
                      onChange={toggleSelectAll}
                      aria-label="Select all"
                    />
                  </th>
                  <th className="px-3 py-2.5 text-left font-medium text-muted-foreground">Product</th>
                  <th className="px-3 py-2.5 text-left font-medium text-muted-foreground">Complete</th>
                  <th className="px-3 py-2.5 text-right font-medium text-muted-foreground">Pricing</th>
                  <th className="px-3 py-2.5 text-right font-medium text-muted-foreground">COGS %</th>
                  <th className="px-3 py-2.5 text-right font-medium text-muted-foreground">Margin</th>
                  <th className="px-3 py-2.5 text-left font-medium text-muted-foreground">Status</th>
                  <th className="px-3 py-2.5 text-left font-medium text-muted-foreground">Merchant</th>
                  <th className="px-3 py-2.5 text-left font-medium text-muted-foreground">Delivers to</th>
                  <th className="px-3 py-2.5 text-left font-medium text-muted-foreground hidden xl:table-cell">Added</th>
                  <th className="w-10 px-3 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {products.map((product, index) => {
                  const mainImg = productImageUrl(product, "thumbnail");
                  const cogsPct = computeCogsPct(product);
                  const marginPct = cogsPct !== null ? 100 - cogsPct : null;
                  const completeness = computeCompleteness(product);
                  const isSelected = selectedIds.has(product.id);

                  return (
                    <tr
                      key={product.id}
                      className={`hover:bg-muted/30 transition-colors ${isSelected ? "bg-primary/5" : ""}`}
                    >
                      <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          className="h-4 w-4 rounded border-border cursor-pointer"
                          checked={isSelected}
                          onChange={() => toggleSelect(product.id)}
                          aria-label={`Select ${product.name}`}
                        />
                      </td>

                      {/* Product cell */}
                      <td
                        className="px-3 py-2.5 cursor-pointer"
                        onClick={() => navigate(`/products/${product.id}`)}
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <div className="w-10 h-10 rounded-md border border-border overflow-hidden bg-muted flex items-center justify-center shrink-0">
                            {mainImg ? (
                              <img
                                src={mainImg}
                                alt={product.name}
                                width={40}
                                height={40}
                                loading={index < 12 ? "eager" : "lazy"}
                                decoding="async"
                                onError={(event) =>
                                  fallbackToOriginalProductImage(event.currentTarget, product.main_image_url)
                                }
                                className="w-full h-full object-cover"
                              />
                            ) : (
                              <ImageIcon size={14} className="text-muted-foreground" />
                            )}
                          </div>
                          <div className="min-w-0">
                            <p className="font-medium truncate max-w-[180px]">{product.name}</p>
                            <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                              {product.sku && (
                                <span className="font-mono text-xs text-muted-foreground bg-muted px-1.5 py-0 rounded">
                                  {product.sku}
                                </span>
                              )}
                              {product.brand && (
                                <span className="text-xs text-muted-foreground truncate">{product.brand}</span>
                              )}
                              {product.brand && product.category && (
                                <span className="text-xs text-muted-foreground">·</span>
                              )}
                              {product.category && (
                                <span className="text-xs text-muted-foreground truncate">{product.category}</span>
                              )}
                            </div>
                          </div>
                        </div>
                      </td>

                      {/* Completeness */}
                      <td className="px-3 py-2.5">
                        <CompletnessBadge pct={completeness} />
                      </td>

                      {/* Pricing */}
                      <td className="px-3 py-2.5 text-right">
                        <div className="flex flex-col items-end gap-0.5">
                          {product.discount_price_usd ? (
                            <span className="flex items-baseline gap-1.5">
                              <PriceText value={formatUSD(product.discount_price_usd)} />
                              <span className="text-xs text-muted-foreground line-through">{formatUSD(product.price_usd)}</span>
                            </span>
                          ) : (
                            <PriceText value={formatUSD(product.price_usd)} />
                          )}
                          <span className="text-xs text-muted-foreground">
                            {product.discount_price_aed ? (
                              <>
                                {formatAED(product.discount_price_aed)} <span className="line-through">{formatAED(product.price_aed)}</span>
                              </>
                            ) : (
                              formatAED(product.price_aed)
                            )}
                          </span>
                        </div>
                      </td>

                      {/* COGS % */}
                      <td className="px-3 py-2.5 text-right">
                        {cogsPct !== null ? (
                          <span className="font-mono text-sm font-medium">{Math.round(cogsPct)}%</span>
                        ) : (
                          <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border-0 text-[10px]">
                            Missing COGS
                          </Badge>
                        )}
                      </td>

                      {/* Margin */}
                      <td className="px-3 py-2.5 text-right">
                        {marginPct !== null ? (
                          <span className={`font-mono text-sm font-medium ${marginPct < 0 ? "text-red-600" : marginPct < 30 ? "text-amber-600" : "text-green-600"}`}>
                            {Math.round(marginPct)}%
                          </span>
                        ) : (
                          <span className="text-muted-foreground text-xs">—</span>
                        )}
                      </td>

                      {/* Status */}
                      <td className="px-3 py-2.5">
                        {statusBadge(product.status)}
                      </td>

                      {/* Merchant sync */}
                      <td className="px-3 py-2.5">
                        <MerchantBadge
                          status={product.merchant_sync_disabled ? "disabled" : product.merchant_sync_status}
                          error={product.merchant_sync_error}
                          syncedAt={product.merchant_synced_at}
                        />
                      </td>

                      {/* Delivers to */}
                      <td className="px-3 py-2.5">
                        <DeliveryCitiesBadge
                          disabledCount={product.delivery_disabled_count ?? 0}
                          totalCities={totalDeliveryCities}
                        />
                      </td>

                      {/* Added date */}
                      <td className="px-3 py-2.5 text-xs text-muted-foreground hidden xl:table-cell whitespace-nowrap">
                        {new Date(product.created_at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}
                      </td>

                      {/* Actions */}
                      <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-8 w-8 p-0"
                              aria-label="Product actions"
                            >
                              <MoreHorizontal size={15} />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-44">
                            {canManageProducts && (
                              <DropdownMenuItem
                                data-testid={`button-edit-product-${product.id}`}
                                onClick={() => setEditTarget(product)}
                              >
                                <Pencil size={14} className="mr-2" />
                                Edit product
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem onClick={() => navigate(`/products/${product.id}`)}>
                              <ExternalLink size={14} className="mr-2" />
                              View product
                            </DropdownMenuItem>
                            {canManageProducts && (
                              <DropdownMenuItem
                                onClick={() => duplicateMutation.mutate(product.id)}
                                disabled={duplicateMutation.isPending}
                              >
                                <Copy size={14} className="mr-2" />
                                Duplicate
                              </DropdownMenuItem>
                            )}
                            {canManageProducts && (
                              <>
                                <DropdownMenuSeparator />
                                {product.is_archived ? (
                                  <DropdownMenuItem
                                    onClick={() => archiveMutation.mutate({ id: product.id, is_archived: false })}
                                    disabled={archiveMutation.isPending}
                                  >
                                    <Archive size={14} className="mr-2" />
                                    Restore
                                  </DropdownMenuItem>
                                ) : (
                                  <DropdownMenuItem
                                    onClick={() => archiveMutation.mutate({ id: product.id, is_archived: true })}
                                    disabled={archiveMutation.isPending}
                                  >
                                    <Archive size={14} className="mr-2" />
                                    Archive
                                  </DropdownMenuItem>
                                )}
                                <DropdownMenuItem
                                  className="text-destructive focus:text-destructive"
                                  onClick={() => setDeleteTarget(product)}
                                >
                                  <Trash2 size={14} className="mr-2" />
                                  Delete product
                                </DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Pagination */}
      {!isLoading && products.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>Rows per page:</span>
            <select
              value={pagination.pageSize}
              onChange={(e) => changePageSize(Number(e.target.value))}
              className="rounded border border-input bg-background px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-ring"
            >
              {[10, 25, 50, 100].map((size) => (
                <option key={size} value={size}>{size}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-sm text-muted-foreground">
              {total === 1 ? "1 product" : `${total} products`}
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                className="h-8 px-2"
                onClick={() => goToPage(1)}
                disabled={currentPage <= 1}
                aria-label="First page"
                data-testid="button-page-first"
              >
                <ChevronsLeft size={14} />
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 px-2"
                onClick={() => goToPage(currentPage - 1)}
                disabled={currentPage <= 1}
                aria-label="Previous page"
              >
                <ChevronLeft size={14} />
                <span className="ml-1 hidden sm:inline">Previous</span>
              </Button>
              <div className="flex items-center gap-1 px-2 text-sm tabular-nums">
                <span>Page {pagination.page} of {totalPages}</span>
                <span className="sr-only"> — jump to page:</span>
                <Input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={pageJumpInput}
                  onChange={(e) => setPageJumpInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); commitPageJump(); }
                  }}
                  onBlur={commitPageJump}
                  disabled={totalPages <= 1}
                  aria-label="Jump to page"
                  data-testid="input-page-jump"
                  className="h-8 w-14 px-2 text-center tabular-nums"
                />
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-8 px-2"
                onClick={() => goToPage(currentPage + 1)}
                disabled={currentPage >= totalPages}
                aria-label="Next page"
              >
                <span className="mr-1 hidden sm:inline">Next</span>
                <ChevronRight size={14} />
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="h-8 px-2"
                onClick={() => goToPage(totalPages)}
                disabled={currentPage >= totalPages || totalPages <= 1}
                aria-label="Last page"
                data-testid="button-page-last"
              >
                <ChevronsRight size={14} />
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Dialogs */}
      {canManageProducts && (
        <>
          <ProductDialog
            open={createOpen}
            onClose={() => setCreateOpen(false)}
            brands={brands}
            existingNames={products.map((p) => p.name)}
            onSubmit={(form) => createMutation.mutate(form)}
            isPending={createMutation.isPending}
            title="New Product"
            description="Fill in the product details. Name and prices are required."
            submitLabel="Create"
          />

          {editTarget && (
            <ProductDialog
              open={editTarget !== null}
              onClose={() => setEditTarget(null)}
              productId={editTarget.id}
              initialValues={productToFormState(editTarget)}
              sku={editTarget.sku}
              brands={brands}
              existingNames={products.filter((p) => p.id !== editTarget.id).map((p) => p.name)}
              onSubmit={(form) => editMutation.mutate({ id: editTarget.id, form })}
              isPending={editMutation.isPending}
              title="Edit Product"
              description={`Update the details for "${editTarget.name}".`}
              submitLabel="Save"
              merchantSyncStatus={editTarget.merchant_sync_status}
              merchantSyncError={editTarget.merchant_sync_error}
              merchantSyncedAt={editTarget.merchant_synced_at}
            />
          )}
        </>
      )}

      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete &ldquo;{deleteTarget?.name}&rdquo;?</AlertDialogTitle>
            <AlertDialogDescription>
              This product will be permanently removed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Bulk Edit Dialog */}
      <Dialog open={bulkEditOpen} onOpenChange={(o) => !o && setBulkEditOpen(false)}>
        <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Bulk Edit</DialogTitle>
            <DialogDescription>
              Update {selectedIds.size} selected product{selectedIds.size === 1 ? "" : "s"}. Leave a field blank to keep it unchanged.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Status</Label>
              <Select value={bulkEditStatus} onValueChange={setBulkEditStatus}>
                <SelectTrigger>
                  <SelectValue placeholder="— no change —" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__no_change__">— no change —</SelectItem>
                  {STATUS_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Brand</Label>
              <Select value={bulkEditBrand} onValueChange={setBulkEditBrand}>
                <SelectTrigger>
                  <SelectValue placeholder="— no change —" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__no_change__">— no change —</SelectItem>
                  {brands.map((b) => (
                    <SelectItem key={b.id} value={b.name}>{b.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t("products.bulkCategoriesLabel")}</Label>
              <CategoryOccasionPicker value={bulkEditCategories} onChange={setBulkEditCategories} />
              <p className="text-xs text-muted-foreground">{t("products.bulkCategoriesHint")}</p>
            </div>
            <div className="space-y-1.5">
              <Label>{t("products.bulkItemBrand")}</Label>
              <Select value={bulkEditCatalogBrand} onValueChange={setBulkEditCatalogBrand}>
                <SelectTrigger data-testid="select-bulk-item-brand">
                  <SelectValue placeholder="— no change —" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__no_change__">— no change —</SelectItem>
                  {catalogBrandOptions.map((b) => (
                    <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t("products.bulkAvailability")}</Label>
              <Select value={bulkAvailMode} onValueChange={setBulkAvailMode}>
                <SelectTrigger data-testid="select-bulk-availability-mode">
                  <SelectValue placeholder="— no change —" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__no_change__">— no change —</SelectItem>
                  <SelectItem value="available">{t("products.bulkSetAvailable")}</SelectItem>
                  <SelectItem value="unavailable">{t("products.bulkSetUnavailable")}</SelectItem>
                </SelectContent>
              </Select>
              {bulkAvailMode && bulkAvailMode !== "__no_change__" && (
                <div className="space-y-2 pt-1">
                  <p className="text-xs text-muted-foreground">{t("products.bulkAvailabilityHint")}</p>
                  <div>
                    <p className="text-xs font-medium mb-1">{t("products.availabilityCountries")}</p>
                    <div className="max-h-32 overflow-y-auto rounded-md border border-border p-2 space-y-1">
                      {bulkCountriesQuery.isLoading ? (
                        <p className="text-xs text-muted-foreground">…</p>
                      ) : bulkCountryOptions.length === 0 ? (
                        <p className="text-xs text-muted-foreground">—</p>
                      ) : (
                        bulkCountryOptions.map((c) => (
                          <label key={c.code} className="flex items-center gap-2 text-sm cursor-pointer">
                            <Checkbox
                              checked={bulkAvailCountries.has(c.code)}
                              onCheckedChange={(checked) => {
                                setBulkAvailCountries((prev) => {
                                  const next = new Set(prev);
                                  if (checked) next.add(c.code); else next.delete(c.code);
                                  return next;
                                });
                              }}
                            />
                            <span>{c.flag ? `${c.flag} ` : ""}{c.name}</span>
                          </label>
                        ))
                      )}
                    </div>
                  </div>
                  <div>
                    <p className="text-xs font-medium mb-1">{t("products.availabilityCities")}</p>
                    <div className="max-h-32 overflow-y-auto rounded-md border border-border p-2 space-y-1">
                      {bulkCitiesQuery.isLoading ? (
                        <p className="text-xs text-muted-foreground">…</p>
                      ) : bulkCityOptions.length === 0 ? (
                        <p className="text-xs text-muted-foreground">—</p>
                      ) : (
                        bulkCityOptions.map((c) => (
                          <label key={c.id} className="flex items-center gap-2 text-sm cursor-pointer">
                            <Checkbox
                              checked={bulkAvailCities.has(c.id)}
                              onCheckedChange={(checked) => {
                                setBulkAvailCities((prev) => {
                                  const next = new Set(prev);
                                  if (checked) next.add(c.id); else next.delete(c.id);
                                  return next;
                                });
                              }}
                            />
                            <span>{c.name} <span className="text-muted-foreground text-xs">({c.country})</span></span>
                          </label>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkEditOpen(false)} disabled={bulkUpdateMutation.isPending}>
              Cancel
            </Button>
            <Button
              data-testid="button-bulk-save"
              disabled={!bulkEditHasChanges || bulkUpdateMutation.isPending}
              onClick={() => {
                const updates: Record<string, unknown> = {};
                if (bulkEditStatus && bulkEditStatus !== "__no_change__") updates.status = bulkEditStatus;
                if (bulkEditBrand && bulkEditBrand !== "__no_change__") updates.brand = bulkEditBrand;
                const catIds = bulkEditCategories.filter((c) => c.kind === "catalog_category").map((c) => c.id);
                const occIds = bulkEditCategories.filter((c) => c.kind === "occasion").map((c) => c.id);
                if (catIds.length > 0) updates.add_catalog_category_ids = catIds;
                if (occIds.length > 0) updates.add_occasion_ids = occIds;
                if (bulkEditCatalogBrand && bulkEditCatalogBrand !== "__no_change__") {
                  updates.catalog_brand_id = Number(bulkEditCatalogBrand);
                }
                if (bulkAvailMode && bulkAvailMode !== "__no_change__") {
                  const isAvail = bulkAvailMode === "available";
                  if (bulkAvailCountries.size > 0) {
                    updates.country_availability = Array.from(bulkAvailCountries).map((code) => ({
                      country_code: code,
                      is_available: isAvail,
                    }));
                  }
                  if (bulkAvailCities.size > 0) {
                    updates.city_availability = Array.from(bulkAvailCities).map((cityId) => ({
                      city_id: cityId,
                      is_available: isAvail,
                    }));
                  }
                }
                bulkUpdateMutation.mutate({
                  data: { ids: Array.from(selectedIds), updates: updates as BulkUpdateProductsInput["updates"] },
                });
              }}
            >
              {bulkUpdateMutation.isPending ? (
                <><Loader2 size={14} className="animate-spin mr-1.5" />Saving…</>
              ) : "Save Changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk delete confirmation (owner only) */}
      <AlertDialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("products.bulkDeleteTitle", { count: selectedIds.size })}</AlertDialogTitle>
            <AlertDialogDescription>{t("products.bulkDeleteDesc")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={bulkDeleteMutation.isPending}>{t("products.bulkDeleteCancel")}</AlertDialogCancel>
            <AlertDialogAction
              data-testid="button-bulk-delete-confirm"
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={bulkDeleteMutation.isPending}
              onClick={(e) => {
                e.preventDefault();
                bulkDeleteMutation.mutate({ data: { ids: Array.from(selectedIds) } });
              }}
            >
              {bulkDeleteMutation.isPending ? (
                <><Loader2 size={14} className="animate-spin mr-1.5" />{t("products.bulkDeleting")}</>
              ) : t("products.bulkDeleteConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* GMC unsync confirmation (owner only) */}

      {reconciliationOpen && (
        <MerchantReconciliationPanel open={reconciliationOpen} onOpenChange={setReconciliationOpen} />
      )}
    </div>
  );
}
