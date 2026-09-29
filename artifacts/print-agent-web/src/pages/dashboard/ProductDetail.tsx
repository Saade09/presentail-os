import { useRef, useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useParams } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useGetProductCogs, useListCatalogBrands, getListCatalogBrandsQueryKey } from "@workspace/api-client-react";
import { apiFetch, getClerkToken } from "@/lib/queryClient";
import { formatAED, formatUSD } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { PriceText } from "@/components/ui/price-text";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CategoryOccasionPicker, type SelectedCategoryOption } from "@/components/CategoryOccasionPicker";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogHeader,
  DialogFooter,
} from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import SalesHistoryTab from "./SalesHistoryTab";
import { ProductPublishingTab } from "./ProductPublishingTab";
import { ProductCityAvailabilityTab } from "./ProductCityAvailabilityTab";
import { RecipeSuggestionPanel } from "./RecipeSuggestionPanel";
import { ImageCropDownloadModal } from "@/components/ImageCropDownloadModal";
import { BaseItemImageThumbnail } from "@/components/BaseItemImageThumbnail";
import { WorkspaceImage } from "@/components/WorkspaceImage";
import { useToast } from "@/hooks/use-toast";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import {
  ArrowLeft,
  Upload,
  X,
  Loader2,
  GripHorizontal,
  GripVertical,
  Plus,
  ShoppingBag,
  ChevronDown,
  Check,
  PlusCircle,
  Pencil,
  MapPin,
  FlaskConical,
  BarChart2,
  DollarSign,
  AlertTriangle,
  ZoomIn,
  Download,
  ArrowUp,
  ArrowDown,
} from "lucide-react";
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

type Product = {
  id: number;
  workspace_owner_id: string;
  name: string;
  price_usd: string;
  price_aed: string;
  discount_price_usd: string | null;
  discount_price_aed: string | null;
  main_image_url: string | null;
  additional_image_urls: string[];
  description: string | null;
  status: string;
  brand: string | null;
  tags: string[];
  category: string | null;
  catalog_categories?: { id: number; name: string; slug: string }[];
  occasions?: { id: number; name: string; slug: string }[];
  has_input_field?: boolean;
  letter_input_enabled?: boolean;
  is_upsell?: boolean;
  is_cmc?: boolean;
  catalog_brand?: { id: number; name: string } | null;
  created_at: string;
  express_delivery_enabled?: boolean;
  inventory_tracked?: boolean;
};

type RecipeItem = {
  base_item_id: number;
  name: string;
  code: string;
  image_url: string | null;
  quantity: string;
};

type BaseItemOption = {
  id: number;
  name: string;
  code: string;
  image_url: string | null;
};

type Brand = {
  id: number;
  name: string;
  primary_logo_id: number | null;
};

type LocationStatus = {
  location_id: number;
  location_name: string;
  is_active: boolean;
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

function stateBadge(enabled: boolean, enabledLabel = "Enabled", disabledLabel = "Disabled") {
  return enabled ? (
    <Badge className="border-0 bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
      {enabledLabel}
    </Badge>
  ) : (
    <Badge variant="outline" className="text-muted-foreground">{disabledLabel}</Badge>
  );
}

function imageUrl(path: string | null): string | null {
  if (!path) return null;
  if (path.startsWith("/objects/")) return `/api/storage${path}`;
  if (path.startsWith("http")) return path;
  return `/api/storage${path}`;
}

function ReadOnlyField({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{label}</p>
      <div className="text-sm">{value ?? <span className="text-muted-foreground italic">Not set</span>}</div>
    </div>
  );
}

const MAX_ADDITIONAL_IMAGES = 5;

function ImageUploadButton({
  label,
  currentUrl,
  onUploaded,
  onRemove,
  readOnly,
}: {
  label: string;
  currentUrl: string | null;
  onUploaded: (url: string) => void;
  onRemove: () => void;
  readOnly?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleFile = async (file: File) => {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setError("Image must be a JPEG, PNG, or WebP file.");
      return;
    }
    setError(null);
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
      setError(err instanceof Error ? err.message : "Upload failed. Please try again.");
    } finally {
      setUploading(false);
    }
  };

  const displayUrl = imageUrl(currentUrl);

  if (readOnly) {
    return (
      <div className="space-y-1.5">
        <Label className="text-sm">{label}</Label>
        {displayUrl ? (
          <div className="w-32 h-32 rounded-lg border border-border overflow-hidden bg-muted">
            <img src={displayUrl} alt="" className="w-full h-full object-cover" />
          </div>
        ) : (
          <div className="w-32 h-32 rounded-lg border border-dashed border-border flex items-center justify-center bg-muted">
            <span className="text-xs text-muted-foreground">No image</span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <Label className="text-sm">{label}</Label>
      {displayUrl ? (
        <div className="flex items-start gap-3">
          <div className="relative w-24 h-24 rounded-lg border border-border overflow-hidden shrink-0 bg-muted">
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
            {uploading ? <Loader2 size={12} className="animate-spin mr-1" /> : <Upload size={12} className="mr-1" />}
            Replace
          </Button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="w-full border-2 border-dashed border-border rounded-lg h-28 flex flex-col items-center justify-center gap-2 hover:border-primary/50 hover:bg-secondary/30 transition-colors disabled:opacity-50"
        >
          {uploading ? (
            <Loader2 size={20} className="text-muted-foreground animate-spin" />
          ) : (
            <Upload size={20} className="text-muted-foreground" />
          )}
          <span className="text-xs text-muted-foreground">{uploading ? "Uploading…" : "Click to upload"}</span>
        </button>
      )}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
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
      className="relative w-20 h-20 rounded-md border border-border overflow-hidden bg-muted shrink-0 group"
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
  readOnly,
}: {
  urls: string[];
  onChange: (urls: string[]) => void;
  readOnly?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleFile = async (file: File) => {
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      setError("Image must be a JPEG, PNG, or WebP file.");
      return;
    }
    if (urls.length >= MAX_ADDITIONAL_IMAGES) {
      setError(`You can add up to ${MAX_ADDITIONAL_IMAGES} additional images.`);
      return;
    }
    setError(null);
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
      setError(err instanceof Error ? err.message : "Upload failed. Please try again.");
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

  if (readOnly) {
    return (
      <div className="space-y-1">
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Additional Images</p>
        {urls.length === 0 ? (
          <p className="text-sm text-muted-foreground italic">None</p>
        ) : (
          <div className="flex flex-wrap gap-2 mt-1">
            {urls.map((url, idx) => {
              const displayUrl = imageUrl(url);
              return (
                <div key={idx} className="w-20 h-20 rounded-md border border-border overflow-hidden bg-muted shrink-0">
                  {displayUrl && <img src={displayUrl} alt="" className="w-full h-full object-cover" />}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

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
                className="w-20 h-20 border-2 border-dashed border-border rounded-md flex flex-col items-center justify-center hover:border-primary/50 hover:bg-secondary/30 transition-colors disabled:opacity-50"
              >
                {uploading ? <Loader2 size={14} className="animate-spin text-muted-foreground" /> : <Plus size={14} className="text-muted-foreground" />}
              </button>
            )}
            {Array.from({ length: Math.max(0, MAX_ADDITIONAL_IMAGES - urls.length - (atLimit ? 0 : 1)) }).map((_, i) => (
              <div key={`empty-${i}`} className="w-20 h-20 border border-dashed border-border/40 rounded-md bg-muted/10 shrink-0" />
            ))}
          </div>
        </SortableContext>
      </DndContext>
      {urls.length > 0 && (
        <p className="text-xs text-muted-foreground">Drag images to reorder them.</p>
      )}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
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

function RecipeAddCombobox({
  excludeIds,
  onAdd,
}: {
  excludeIds: Set<number>;
  onAdd: (item: BaseItemOption) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const { data } = useQuery({
    queryKey: ["base-items-search", search],
    queryFn: () =>
      apiFetch<{ items: BaseItemOption[] }>(
        `/api/base-items${search.trim() ? `?q=${encodeURIComponent(search.trim())}` : ""}`,
      ),
    staleTime: 10_000,
  });

  const items = (data?.items ?? []).filter((it) => !excludeIds.has(it.id));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5 h-8 text-xs">
          <Plus size={12} />
          Add base item
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
            {items.length === 0 ? (
              <CommandEmpty className="text-xs text-muted-foreground py-4 text-center">
                {search.trim() ? "No matching base items" : "No base items yet"}
              </CommandEmpty>
            ) : (
              <CommandGroup>
                {items.map((item) => {
                  const url = imageUrl(item.image_url);
                  return (
                    <CommandItem
                      key={item.id}
                      value={String(item.id)}
                      onSelect={() => {
                        onAdd(item);
                        setOpen(false);
                        setSearch("");
                      }}
                      className="gap-2"
                    >
                      <BaseItemImageThumbnail imageUrl={url} name={item.name} size={6} />
                      <span className="min-w-0 truncate">{item.name}</span>
                      <span className="text-xs text-muted-foreground font-mono shrink-0">{item.code}</span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export function SortableRecipeRow({
  item,
  isLast,
  canManage,
  onQtyChange,
  onRemove,
  showError,
}: {
  item: RecipeItem;
  isLast: boolean;
  canManage: boolean;
  onQtyChange: (value: string) => void;
  onRemove: () => void;
  showError: boolean;
}) {
  const [touched, setTouched] = useState(false);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.base_item_id,
    disabled: !canManage,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  const url = imageUrl(item.image_url);
  const qty = parseFloat(item.quantity);
  const isInvalid = item.quantity.trim() === "" || isNaN(qty) || qty <= 0;
  const displayError = canManage && isInvalid && (touched || showError);
  return (
    <tr ref={setNodeRef} style={style} className={isLast ? "" : "border-b border-border"} data-testid={`recipe-row-${item.base_item_id}`}>
      <td className="px-3 py-2">
        <div className="flex items-center gap-2">
          {canManage && (
            <button
              type="button"
              {...attributes}
              {...listeners}
              className="text-muted-foreground/40 hover:text-muted-foreground cursor-grab active:cursor-grabbing touch-none shrink-0"
              title="Drag to reorder"
              data-testid={`recipe-drag-handle-${item.base_item_id}`}
            >
              <GripVertical size={14} />
            </button>
          )}
          <Link
            href={`/base-items/${item.base_item_id}`}
            className="flex min-w-0 items-center gap-2 rounded-sm hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
            data-testid={`recipe-base-item-link-${item.base_item_id}`}
          >
            <BaseItemImageThumbnail imageUrl={url} name={item.name} size={7} />
            <span className="font-medium truncate max-w-[140px]">{item.name}</span>
          </Link>
        </div>
      </td>
      <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{item.code}</td>
      <td className="px-3 py-2">
        {canManage ? (
          <div className="flex flex-col gap-0.5">
            <Input
              type="number"
              min="0.001"
              step="any"
              value={item.quantity}
              onChange={(e) => onQtyChange(e.target.value)}
              onBlur={() => setTouched(true)}
              className={`h-7 w-24 text-sm${displayError ? " border-destructive focus-visible:ring-destructive/30" : ""}`}
            />
            {displayError && (
              <p className="text-xs text-destructive">Must be greater than 0</p>
            )}
          </div>
        ) : (
          <span>{item.quantity}</span>
        )}
      </td>
      {canManage && (
        <td className="px-2 py-2 text-right">
          <button
            type="button"
            onClick={onRemove}
            className="w-6 h-6 rounded flex items-center justify-center text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
            title="Remove"
          >
            <X size={13} />
          </button>
        </td>
      )}
    </tr>
  );
}

type FormState = {
  name: string;
  price_usd: string;
  price_aed: string;
  discount_price_usd: string;
  discount_price_aed: string;
  description: string;
  status: string;
  brand: string;
  categories: SelectedCategoryOption[];
  tags: string;
  main_image_url: string | null;
  additional_image_urls: string[];
  has_input_field: boolean;
  letter_input_enabled: boolean;
  is_upsell: boolean;
  is_cmc: boolean;
  initial_cmc_stock: number | null;
  catalog_brand_id: string;
};

function productToForm(p: Product): FormState {
  return {
    name: p.name,
    price_usd: p.price_usd,
    price_aed: p.price_aed,
    discount_price_usd: p.discount_price_usd ?? "",
    discount_price_aed: p.discount_price_aed ?? "",
    description: p.description ?? "",
    status: p.status,
    brand: p.brand ?? "",
    has_input_field: p.has_input_field ?? false,
    letter_input_enabled: p.letter_input_enabled ?? false,
    is_upsell: p.is_upsell ?? false,
    is_cmc: p.is_cmc ?? false,
    initial_cmc_stock: null,
    catalog_brand_id: p.catalog_brand ? String(p.catalog_brand.id) : "",
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
  };
}

function normalizeNumberInput(value: string, emptyValue: "" | null): number | string | null {
  const trimmed = value.trim();
  if (trimmed === "") return emptyValue;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : `invalid:${trimmed}`;
}

function normalizeForm(form: FormState): unknown {
  return {
    ...form,
    name: form.name.trim(),
    price_usd: normalizeNumberInput(form.price_usd, ""),
    price_aed: normalizeNumberInput(form.price_aed, ""),
    discount_price_usd: normalizeNumberInput(form.discount_price_usd, null),
    discount_price_aed: normalizeNumberInput(form.discount_price_aed, null),
    description: form.description.trim() || null,
    brand: form.brand.trim() || null,
    tags: form.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
    categories: [...form.categories]
      .map(({ kind, id }) => ({ kind, id }))
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.id - b.id),
    main_image_url: form.main_image_url || null,
    additional_image_urls: [...form.additional_image_urls],
  };
}

function normalizeRecipe(items: RecipeItem[]): unknown[] {
  return items.map((item) => ({
    base_item_id: item.base_item_id,
    quantity: normalizeNumberInput(item.quantity, ""),
  }));
}

type ChannelDimEntry = {
  id: number;
  channel_id: number;
  channel_name: string;
  width_px: number;
  height_px: number;
  output_format: "jpeg" | "png" | "webp";
};

type ChannelEntry = {
  id: number;
  name: string;
  has_logo: boolean;
};

function ChannelLogoTile({ channel }: { channel: ChannelEntry }) {
  const [imgError, setImgError] = useState(false);
  const showFallback = !channel.has_logo || imgError;

  if (showFallback) {
    return (
      <div className="w-8 h-8 rounded border border-border bg-muted flex items-center justify-center shrink-0 text-xs font-semibold text-muted-foreground uppercase select-none">
        {channel.name.charAt(0)}
      </div>
    );
  }

  return (
    <WorkspaceImage
      src={`/api/channels/${channel.id}/logo`}
      alt={`${channel.name} logo`}
      className="w-8 h-8 rounded border border-border bg-muted object-contain shrink-0"
      onError={() => setImgError(true)}
    />
  );
}

function ProductImageLightbox({
  product,
  open,
  onClose,
}: {
  product: Product;
  open: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const fullUrl = imageUrl(product.main_image_url);

  const { data: dimsData, isLoading: dimsLoading } = useQuery({
    queryKey: ["channel-image-configs-product"],
    queryFn: () => apiFetch<{ image_configs: ChannelDimEntry[] }>("/api/channel-image-configs?image_type=product"),
    enabled: open,
  });

  const { data: channelsData, isLoading: channelsLoading } = useQuery({
    queryKey: ["channels"],
    queryFn: () => apiFetch<{ channels: ChannelEntry[] }>("/api/channels"),
    enabled: open,
  });

  const allDims = dimsData?.image_configs ?? [];
  const allChannels = channelsData?.channels ?? [];

  const [downloadingOriginal, setDownloadingOriginal] = useState(false);
  const [downloadingChannel, setDownloadingChannel] = useState<Record<number, boolean>>({});

  // One entry per channel — show download button if this channel has dimensions configured
  const channelEntries = allChannels.map((ch) => {
    const dim = allDims.find((d) => d.channel_id === ch.id);
    let disabledReason: React.ReactNode | null = null;
    if (!dim || !fullUrl) {
      if (!fullUrl) {
        disabledReason = "No product image has been uploaded.";
      } else {
        disabledReason = (
          <>
            <p>{`No image size configured for ${ch.name}. Configure dimensions in channel settings.`}</p>
            <Link
              href="/channels"
              onClick={() => onClose()}
              className="mt-2 inline-block underline text-primary"
            >
              Go to channel settings
            </Link>
          </>
        );
      }
    }
    return { channel: ch, dim: dim ?? null, disabledReason };
  });

  const [cropChannel, setCropChannel] = useState<ChannelDimEntry | null>(null);

  async function handleDownloadOriginal() {
    setDownloadingOriginal(true);
    try {
      const token = await getClerkToken();
      const resp = await fetch(`/api/products/${product.id}/images/download-original`, {
        credentials: "include",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!resp.ok) {
        throw new Error("Download failed");
      }
      const blob = await resp.blob();
      const contentType = resp.headers.get("Content-Type") ?? "application/octet-stream";
      const extMap: Record<string, string> = {
        "image/jpeg": "jpg",
        "image/png": "png",
        "image/webp": "webp",
      };
      const ext = extMap[contentType] ?? "bin";
      const safeName = product.name.replace(/[^a-z0-9_\- ]/gi, "_");
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${safeName}-original.${ext}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      toast({ title: "Download failed", description: "Could not download the original image. Please try again.", variant: "destructive" });
    } finally {
      setDownloadingOriginal(false);
    }
  }

  const isLoading = dimsLoading || channelsLoading;

  return (
    <>
      <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogTitle>{product.name}</DialogTitle>
          <DialogDescription className="sr-only">
            Full-size product image and download options
          </DialogDescription>
          <div className="space-y-6">
            {/* Full-size image */}
            {fullUrl ? (
              <div className="flex justify-center">
                <img
                  src={fullUrl}
                  alt={product.name}
                  className="max-w-full max-h-80 object-contain rounded-lg border border-border"
                />
              </div>
            ) : (
              <div className="flex items-center justify-center h-48 bg-muted rounded-lg border border-dashed border-border">
                <ShoppingBag size={40} className="text-muted-foreground" />
              </div>
            )}

            {/* Download options */}
            <div className="space-y-3">
              <div>
                <p className="text-sm font-semibold">Download Options</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Download the original image or a version cropped for a specific channel.
                </p>
              </div>

              {/* Original image section */}
              <div className="rounded-lg border border-border px-4 py-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">Original Image</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Download the unmodified uploaded image
                  </p>
                </div>
                {fullUrl ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="shrink-0 gap-1.5"
                    onClick={handleDownloadOriginal}
                    disabled={downloadingOriginal}
                    data-testid="download-original-btn"
                  >
                    {downloadingOriginal ? (
                      <Loader2 size={13} className="animate-spin" />
                    ) : (
                      <Download size={13} />
                    )}
                    Download original
                  </Button>
                ) : (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="shrink-0" tabIndex={0}>
                        <Button size="sm" variant="outline" className="pointer-events-none" disabled>
                          <Download size={13} className="mr-1.5" />
                          Download original
                        </Button>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="left" className="max-w-xs text-center">
                      No product image has been uploaded.
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>

              {/* Channel rows */}
              {isLoading ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                  <Loader2 size={14} className="animate-spin" />
                  Loading channels…
                </div>
              ) : allChannels.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                  No channels configured. Add channels in the Channels section.
                </div>
              ) : (
                <div className="space-y-2">
                  {channelEntries.map(({ channel, dim, disabledReason }) => (
                    <div
                      key={channel.id}
                      className="flex items-center justify-between gap-3 rounded-lg border border-border px-4 py-3"
                    >
                      <div className="flex items-center gap-3 min-w-0">
                        <ChannelLogoTile channel={channel} />
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">{channel.name}</p>
                          {dim ? (
                            <p className="text-xs text-muted-foreground mt-0.5">
                              {dim.width_px} × {dim.height_px} px · {dim.output_format.toUpperCase()}
                            </p>
                          ) : (
                            <p className="text-xs text-muted-foreground italic mt-0.5">
                              No dimensions configured
                            </p>
                          )}
                        </div>
                      </div>
                      {dim && fullUrl ? (
                        <Button
                          size="sm"
                          variant="outline"
                          className="shrink-0 gap-1.5"
                          onClick={() => setCropChannel(dim)}
                        >
                          <Download size={13} />
                          Download
                        </Button>
                      ) : (
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="shrink-0" tabIndex={0} data-testid={`download-disabled-${channel.id}`}>
                              <Button size="sm" variant="outline" className="shrink-0 pointer-events-none" disabled>
                                <Download size={13} className="mr-1.5" />
                                Download
                              </Button>
                            </span>
                          </TooltipTrigger>
                          <TooltipContent side="left" className="max-w-xs text-center">
                            {disabledReason}
                          </TooltipContent>
                        </Tooltip>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {cropChannel && fullUrl && (
        <ImageCropDownloadModal
          open={true}
          onClose={() => setCropChannel(null)}
          imageUrl={fullUrl}
          channelName={cropChannel.channel_name}
          targetWidth={cropChannel.width_px}
          targetHeight={cropChannel.height_px}
          productName={product.name}
          outputFormat={cropChannel.output_format}
        />
      )}
    </>
  );
}

function ProductDetailsReadOnly({ product }: { product: Product }) {
  const thumb = imageUrl(product.main_image_url);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const categories = product.catalog_categories ?? [];
  const occasions = product.occasions ?? [];
  const additionalImages = product.additional_image_urls ?? [];
  const chips = (items: Array<{ id: number; name: string }>, empty: string) =>
    items.length > 0 ? (
      <div className="flex flex-wrap gap-1.5">
        {items.map((item) => <Badge key={item.id} variant="secondary" className="font-normal">{item.name}</Badge>)}
      </div>
    ) : <span className="text-muted-foreground italic">{empty}</span>;

  const detailCard = (title: string, children: React.ReactNode, className = "") => (
    <section className={`rounded-xl border border-border bg-card p-4 sm:p-5 ${className}`}>
      <h2 className="text-sm font-semibold">{title}</h2>
      <div className="mt-4">{children}</div>
    </section>
  );

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(280px,1fr)]" data-testid="product-view-mode">
      <div className="space-y-4">
        {detailCard("Media", (
          <div className="space-y-4">
            {thumb ? (
              <button
                type="button"
                onClick={() => setLightboxOpen(true)}
                className="group relative aspect-[4/3] w-full max-w-xl overflow-hidden rounded-lg border border-border bg-muted cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                title="Preview image and download options"
                data-testid="product-image-thumb"
              >
                <img src={thumb} alt={product.name} className="h-full w-full object-cover" />
                <span className="absolute inset-0 flex items-center justify-center bg-black/35 text-white opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
                  <ZoomIn size={22} />
                  <span className="sr-only">Preview image</span>
                </span>
              </button>
            ) : (
              <div className="flex aspect-[4/3] w-full max-w-xl items-center justify-center rounded-lg border border-dashed border-border bg-muted">
                <div className="text-center text-muted-foreground">
                  <ShoppingBag size={34} className="mx-auto mb-2" />
                  <p className="text-sm">No main image</p>
                </div>
              </div>
            )}
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Additional images</p>
              {additionalImages.length > 0 ? (
                <div className="flex flex-wrap gap-2">
                  {additionalImages.map((url, idx) => {
                    const displayUrl = imageUrl(url);
                    return <div key={`${url}-${idx}`} className="h-16 w-16 overflow-hidden rounded-md border border-border bg-muted">
                      {displayUrl && <img src={displayUrl} alt={`${product.name} additional image ${idx + 1}`} className="h-full w-full object-cover" />}
                    </div>;
                  })}
                </div>
              ) : <p className="text-sm italic text-muted-foreground">No additional images</p>}
            </div>
          </div>
        ))}
        {detailCard("Basic information", (
          <div className="grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-2">
            <ReadOnlyField label="Product name" value={product.name} />
            <ReadOnlyField label="Brand" value={product.brand} />
            <ReadOnlyField label="Catalog brand" value={product.catalog_brand?.name} />
            <ReadOnlyField label="Created" value={new Date(product.created_at).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })} />
            <ReadOnlyField label="Description" value={product.description || <span className="italic text-muted-foreground">No description</span>} />
            <ReadOnlyField label="Legacy category" value={product.category} />
          </div>
        ))}
        {detailCard("Classification", (
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            <ReadOnlyField label="Categories" value={chips(categories, "No categories")} />
            <ReadOnlyField label="Occasions" value={chips(occasions, "No occasions")} />
          </div>
        ))}
      </div>
      <div className="space-y-4">
        {detailCard("Status & tags", (
          <div className="space-y-5">
            <ReadOnlyField label="Availability" value={statusBadge(product.status)} />
            <ReadOnlyField label="Tags" value={product.tags.length ? (
              <div className="flex flex-wrap gap-1.5">{product.tags.map((tag) => <Badge key={tag} variant="secondary" className="font-normal">{tag}</Badge>)}</div>
            ) : <span className="italic text-muted-foreground">No tags</span>} />
          </div>
        ))}
        {detailCard("Market pricing", (
          <div className="space-y-4">
            <ReadOnlyField label="Lebanon · USD" value={
              <span className="flex items-baseline gap-2">
                <PriceText value={formatUSD(product.discount_price_usd || product.price_usd)} />
                {product.discount_price_usd && <span className="text-sm text-muted-foreground line-through">{formatUSD(product.price_usd)}</span>}
              </span>
            } />
            <ReadOnlyField label="UAE · AED" value={
              <span className="flex items-baseline gap-2">
                <PriceText value={formatAED(product.discount_price_aed || product.price_aed)} />
                {product.discount_price_aed && <span className="text-sm text-muted-foreground line-through">{formatAED(product.price_aed)}</span>}
              </span>
            } />
          </div>
        ))}
        {detailCard("Personalization & channels", (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3"><span className="text-sm">Customer input field</span>{stateBadge(product.has_input_field ?? false)}</div>
            <div className="flex items-center justify-between gap-3"><span className="text-sm">Letter personalization</span>{stateBadge(product.letter_input_enabled ?? false)}</div>
            <div className="flex items-center justify-between gap-3"><span className="text-sm">Checkout add-on</span>{stateBadge(product.is_upsell ?? false, "Enabled", "Not an add-on")}</div>
            <div className="flex items-center justify-between gap-3"><span className="text-sm">CMC Beirut product</span>{stateBadge(product.is_cmc ?? false, "Enabled", "Not enabled")}</div>
            <p className="text-xs text-muted-foreground">Personalization and checkout settings apply when this product is offered in the relevant sales channel.</p>
          </div>
        ))}
      </div>
      <ProductImageLightbox
        product={product}
        open={lightboxOpen}
        onClose={() => setLightboxOpen(false)}
      />
    </div>
  );
}

function ProductDetailsEditForm({
  product,
  form,
  set,
  brands,
  saveAttempted,
  nameTouched,
  setNameTouched,
  priceUsdTouched,
  setPriceUsdTouched,
  priceAedTouched,
  setPriceAedTouched,
  nameError,
  priceUsdError,
  priceAedError,
  discountUsdError,
  discountAedError,
  prevBrandRef,
  latestRunId,
  onOpenGallery,
}: {
  product: Product;
  form: FormState;
  set: <K extends keyof FormState>(key: K, value: FormState[K]) => void;
  brands: Brand[];
  saveAttempted: boolean;
  nameTouched: boolean;
  setNameTouched: (v: boolean) => void;
  priceUsdTouched: boolean;
  setPriceUsdTouched: (v: boolean) => void;
  priceAedTouched: boolean;
  setPriceAedTouched: (v: boolean) => void;
  nameError: string | null;
  priceUsdError: string | null;
  priceAedError: string | null;
  discountUsdError: string | null;
  discountAedError: string | null;
  prevBrandRef: React.MutableRefObject<string>;
  latestRunId?: number;
  onOpenGallery?: () => void;
}) {
  const { t } = useTranslation();
  const catalogBrandsQuery = useListCatalogBrands(
    { pageSize: 100 },
    { query: { queryKey: getListCatalogBrandsQueryKey({ pageSize: 100 }) } },
  );
  const catalogBrands = catalogBrandsQuery.data?.items ?? [];

  const editCard = (title: React.ReactNode, children: React.ReactNode, className = "") => (
    <section className={`rounded-xl border border-border bg-card p-4 sm:p-5 ${className}`}>
      <div className="flex items-center justify-between w-full">
        <h2 className="text-sm font-semibold">{title}</h2>
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(280px,1fr)]" data-testid="product-edit-mode">
      <div className="space-y-4">
        {editCard(
          <div className="flex items-center justify-between w-full gap-4">
            <span>Media</span>
            <div className="flex items-center gap-2">
              {(!form.main_image_url || !form.main_image_url.startsWith("/objects/")) && (
                <span className="text-xs text-muted-foreground">Add a primary product image first.</span>
              )}
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="border-teal-500 text-teal-600 hover:bg-teal-50 dark:hover:bg-teal-950/30 gap-1.5 h-7 text-xs px-2.5 -my-1 disabled:opacity-50 disabled:pointer-events-none"
                disabled={!form.main_image_url || !form.main_image_url.startsWith("/objects/")}
                onClick={(e) => {
                  e.preventDefault();
                  onOpenGallery?.();
                }}
              >
                <FlaskConical size={13} />
                Generate gallery with AI
              </Button>
            </div>
          </div>,
          <div className="space-y-6">
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
            {latestRunId && (
              <GalleryRunTracker
                runId={latestRunId}
                productId={product.id}
                productMainImageUrl={product.main_image_url}
                onApproved={(updatedProduct) => {
                  set("additional_image_urls", updatedProduct.additional_image_urls);
                }}
              />
            )}
          </div>
        )}

        {editCard("Basic information", (
          <div className="space-y-5">
            <div className="space-y-1.5">
              <Label htmlFor="pd-name">Name <span className="text-destructive">*</span></Label>
              <div className="flex flex-col gap-0.5">
                <Input
                  id="pd-name"
                  value={form.name}
                  onChange={(e) => set("name", e.target.value)}
                  onBlur={() => setNameTouched(true)}
                  placeholder="e.g. Premium Gift Box"
                  className={nameError && nameTouched ? "border-destructive focus-visible:ring-destructive/30" : ""}
                />
                {nameError && nameTouched && (
                  <p className="text-xs text-destructive">{nameError}</p>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label>Brand</Label>
                <Select value={form.brand || ""} onValueChange={(v) => set("brand", v)}>
                  <SelectTrigger>
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
                <Label htmlFor="pd-catalog-brand">{t("products.catalogBrand")}</Label>
                <Select
                  value={form.catalog_brand_id || "__none__"}
                  onValueChange={(v) => set("catalog_brand_id", v === "__none__" ? "" : v)}
                >
                  <SelectTrigger id="pd-catalog-brand">
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
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="pd-description">Description</Label>
              <Textarea
                id="pd-description"
                value={form.description}
                onChange={(e) => set("description", e.target.value)}
                placeholder="Optional product description…"
                rows={3}
              />
            </div>
          </div>
        ))}

        {editCard("Classification", (
          <div className="space-y-1.5">
            <Label>Categories &amp; Occasions</Label>
            <CategoryOccasionPicker
              value={form.categories}
              onChange={(v) => set("categories", v)}
            />
          </div>
        ))}
      </div>

      <div className="space-y-4">
        {editCard("Status & tags", (
          <div className="space-y-5">
            <div className="space-y-1.5">
              <Label>Status</Label>
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
              <Label htmlFor="pd-tags">Tags <span className="text-xs text-muted-foreground">(comma-separated)</span></Label>
              <Input
                id="pd-tags"
                value={form.tags}
                onChange={(e) => set("tags", e.target.value)}
                placeholder="e.g. gift, luxury, seasonal"
              />
            </div>
          </div>
        ))}

        {editCard("Market pricing", (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="pd-price-usd">Price (USD) <span className="text-destructive">*</span></Label>
                <div className="flex flex-col gap-0.5">
                  <Input
                    id="pd-price-usd"
                    type="number"
                    min="0"
                    step="0.01"
                    value={form.price_usd}
                    onChange={(e) => set("price_usd", e.target.value)}
                    onBlur={() => setPriceUsdTouched(true)}
                    placeholder="0.00"
                    className={priceUsdError && priceUsdTouched ? "border-destructive focus-visible:ring-destructive/30" : ""}
                  />
                  {priceUsdError && priceUsdTouched && (
                    <p className="text-xs text-destructive">{priceUsdError}</p>
                  )}
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pd-discount-usd">Discount (USD)</Label>
                <div className="flex flex-col gap-0.5">
                  <Input
                    id="pd-discount-usd"
                    type="number"
                    min="0"
                    step="0.01"
                    value={form.discount_price_usd}
                    onChange={(e) => set("discount_price_usd", e.target.value)}
                    placeholder="0.00"
                    className={discountUsdError ? "border-destructive focus-visible:ring-destructive/30" : ""}
                  />
                  {discountUsdError && (
                    <p className="text-xs text-destructive">{discountUsdError}</p>
                  )}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="pd-price-aed">Price (AED) <span className="text-destructive">*</span></Label>
                <div className="flex flex-col gap-0.5">
                  <Input
                    id="pd-price-aed"
                    type="number"
                    min="0"
                    step="0.01"
                    value={form.price_aed}
                    onChange={(e) => set("price_aed", e.target.value)}
                    onBlur={() => setPriceAedTouched(true)}
                    placeholder="0.00"
                    className={priceAedError && priceAedTouched ? "border-destructive focus-visible:ring-destructive/30" : ""}
                  />
                  {priceAedError && priceAedTouched && (
                    <p className="text-xs text-destructive">{priceAedError}</p>
                  )}
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pd-discount-aed">Discount (AED)</Label>
                <div className="flex flex-col gap-0.5">
                  <Input
                    id="pd-discount-aed"
                    type="number"
                    min="0"
                    step="0.01"
                    value={form.discount_price_aed}
                    onChange={(e) => set("discount_price_aed", e.target.value)}
                    placeholder="0.00"
                    className={discountAedError ? "border-destructive focus-visible:ring-destructive/30" : ""}
                  />
                  {discountAedError && (
                    <p className="text-xs text-destructive">{discountAedError}</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        ))}

        {editCard("Personalization & channels", (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3 py-1">
              <div className="space-y-0.5">
                <Label htmlFor="pd-input-field" className="text-sm font-medium">{t("products.hasInputField")}</Label>
                <p className="text-xs text-muted-foreground">{t("products.hasInputFieldHint")}</p>
              </div>
              <Switch
                id="pd-input-field"
                checked={form.has_input_field}
                onCheckedChange={(v) => set("has_input_field", v)}
              />
            </div>
            <div className="flex items-center justify-between gap-3 py-1 border-t border-border/50">
              <div className="space-y-0.5 mt-1">
                <Label htmlFor="pd-letter-input" className="text-sm font-medium">{t("products.letterInput")}</Label>
                <p className="text-xs text-muted-foreground">{t("products.letterInputHint")}</p>
              </div>
              <Switch
                id="pd-letter-input"
                checked={form.letter_input_enabled}
                onCheckedChange={(v) => set("letter_input_enabled", v)}
              />
            </div>
            <div className="flex items-center justify-between gap-3 py-1 border-t border-border/50">
              <div className="space-y-0.5 mt-1">
                <Label htmlFor="pd-upsell" className="text-sm font-medium">{t("products.upsell")}</Label>
                <p className="text-xs text-muted-foreground">{t("products.upsellHint")}</p>
              </div>
              <Switch
                id="pd-upsell"
                checked={form.is_upsell}
                onCheckedChange={(v) => set("is_upsell", v)}
              />
            </div>
            <div className="flex items-center justify-between gap-3 py-1 border-t border-border/50">
              <div className="space-y-0.5 mt-1">
                <Label htmlFor="pd-cmc" className="text-sm font-medium">{t("products.isCmc")}</Label>
                <p className="text-xs text-muted-foreground">{t("products.isCmcHint")}</p>
              </div>
              <Switch
                id="pd-cmc"
                checked={form.is_cmc}
                onCheckedChange={(v) => {
                  set("is_cmc", v);
                  if (!v) set("initial_cmc_stock", null);
                }}
              />
            </div>
            {form.is_cmc && (
              <div className="space-y-1.5 pl-3 border-l-2 border-primary/20 pt-2 pb-1 mt-1">
                <Label htmlFor="pd-initial-cmc-stock">Initial Stock <span className="text-xs text-muted-foreground font-normal">(optional)</span></Label>
                <Input
                  id="pd-initial-cmc-stock"
                  type="number"
                  min={0}
                  step={1}
                  value={form.initial_cmc_stock === null ? "" : String(form.initial_cmc_stock)}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val === "") {
                      set("initial_cmc_stock", null);
                    } else {
                      const n = parseInt(val, 10);
                      if (!isNaN(n) && n >= 0) set("initial_cmc_stock", n);
                    }
                  }}
                  placeholder="Leave blank to skip"
                  className="max-w-[160px] h-8"
                />
                <p className="text-xs text-muted-foreground max-w-sm leading-snug">Seeds the workspace-level baseline stock for this product. Only applied once.</p>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function LocationsTab({ productId, canManage }: { productId: number; canManage: boolean }) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["product-location-statuses", productId],
    queryFn: () => apiFetch<{ locationStatuses: LocationStatus[] }>(`/api/products/${productId}/location-statuses`),
  });

  const locationStatuses = data?.locationStatuses ?? [];

  const [pending, setPending] = useState<Set<number>>(new Set());
  const [errors, setErrors] = useState<Record<number, string>>({});

  const toggleMutation = useMutation({
    mutationFn: ({ locationId, isActive }: { locationId: number; isActive: boolean }) =>
      apiFetch(`/api/products/${productId}/location-statuses/${locationId}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive }),
      }),
    onMutate: ({ locationId }) => {
      setPending((prev) => new Set(prev).add(locationId));
      setErrors((prev) => {
        const next = { ...prev };
        delete next[locationId];
        return next;
      });
    },
    onSuccess: (_data, { locationId }) => {
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(locationId);
        return next;
      });
      qc.invalidateQueries({ queryKey: ["product-location-statuses", productId] });
    },
    onError: (_err, { locationId }) => {
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(locationId);
        return next;
      });
      setErrors((prev) => ({ ...prev, [locationId]: "Failed to save. Please try again." }));
      toast({ title: "Failed to update location", variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
        <Loader2 size={14} className="animate-spin" />
        Loading locations…
      </div>
    );
  }

  if (locationStatuses.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-10 text-center">
        <MapPin size={28} className="mx-auto mb-2 text-muted-foreground" />
        <p className="font-medium text-sm">No locations configured</p>
        <p className="text-xs text-muted-foreground mt-1">
          Add locations in the Locations section to manage product availability.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border divide-y divide-border">
      {locationStatuses.map((ls) => {
        const isPending = pending.has(ls.location_id);
        const err = errors[ls.location_id];
        return (
          <div key={ls.location_id} className="flex items-center justify-between gap-3 px-4 py-3">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{ls.location_name}</p>
              {err && <p className="text-xs text-destructive mt-0.5">{err}</p>}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {isPending && <Loader2 size={12} className="animate-spin text-muted-foreground" />}
              <Switch
                checked={ls.is_active}
                disabled={isPending || !canManage}
                onCheckedChange={(checked) =>
                  toggleMutation.mutate({ locationId: ls.location_id, isActive: checked })
                }
                aria-label={`${ls.location_name} active`}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RecipeReadOnlyTab({ items }: { items: RecipeItem[] }) {
  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-10 text-center">
        <FlaskConical size={28} className="mx-auto mb-2 text-muted-foreground" />
        <p className="font-medium text-sm">No recipe items</p>
        <p className="text-xs text-muted-foreground mt-1">
          Edit this product to add base items to its recipe.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border bg-muted/40">
            <th className="px-3 py-2 text-left font-medium text-xs text-muted-foreground uppercase tracking-wide">Base Item</th>
            <th className="px-3 py-2 text-left font-medium text-xs text-muted-foreground uppercase tracking-wide">Code</th>
            <th className="px-3 py-2 text-left font-medium text-xs text-muted-foreground uppercase tracking-wide">Quantity</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, idx) => {
            const url = imageUrl(item.image_url);
            return (
              <tr key={item.base_item_id} className={idx < items.length - 1 ? "border-b border-border" : ""}>
                <td className="px-3 py-2">
                  <Link
                    href={`/base-items/${item.base_item_id}`}
                    className="flex min-w-0 items-center gap-2 rounded-sm hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                    data-testid={`recipe-base-item-link-${item.base_item_id}`}
                  >
                    <BaseItemImageThumbnail imageUrl={url} name={item.name} size={7} />
                    <span className="font-medium truncate">{item.name}</span>
                  </Link>
                </td>
                <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{item.code}</td>
                <td className="px-3 py-2">{item.quantity}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RecipeEditTab({
  recipeItems,
  setRecipeItems,
  setRecipeDirty,
  saveAttempted,
  canManage,
}: {
  recipeItems: RecipeItem[];
  setRecipeItems: React.Dispatch<React.SetStateAction<RecipeItem[]>>;
  setRecipeDirty: (v: boolean) => void;
  saveAttempted: boolean;
  canManage: boolean;
}) {
  const recipeSensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  function handleRecipeDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      setRecipeItems((items) => {
        const oldIndex = items.findIndex((it) => it.base_item_id === active.id);
        const newIndex = items.findIndex((it) => it.base_item_id === over.id);
        if (oldIndex === -1 || newIndex === -1) return items;
        return arrayMove(items, oldIndex, newIndex);
      });
      setRecipeDirty(true);
    }
  }

  if (recipeItems.length === 0) {
    return (
      <div className="space-y-4">
        <div className="rounded-lg border border-dashed border-border p-10 text-center">
          <FlaskConical size={28} className="mx-auto mb-2 text-muted-foreground" />
          <p className="font-medium text-sm">No recipe items yet</p>
          <p className="text-xs text-muted-foreground mt-1">Add base items to build the recipe.</p>
        </div>
        {canManage && (
          <RecipeAddCombobox
            excludeIds={new Set(recipeItems.map((it) => it.base_item_id))}
            onAdd={(item) => {
              setRecipeItems((prev) => [
                ...prev,
                { base_item_id: item.id, name: item.name, code: item.code, image_url: item.image_url, quantity: "1" },
              ]);
              setRecipeDirty(true);
            }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <DndContext sensors={recipeSensors} collisionDetection={closestCenter} onDragEnd={handleRecipeDragEnd}>
        <SortableContext items={recipeItems.map((it) => it.base_item_id)}>
          <div className="rounded-lg border border-border overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40">
                  <th className="px-3 py-2 text-left font-medium text-xs text-muted-foreground uppercase tracking-wide">Base Item</th>
                  <th className="px-3 py-2 text-left font-medium text-xs text-muted-foreground uppercase tracking-wide">Code</th>
                  <th className="px-3 py-2 text-left font-medium text-xs text-muted-foreground uppercase tracking-wide">Quantity</th>
                  {canManage && <th className="px-2 py-2" />}
                </tr>
              </thead>
              <tbody>
                {recipeItems.map((item, idx) => (
                  <SortableRecipeRow
                    key={item.base_item_id}
                    item={item}
                    isLast={idx === recipeItems.length - 1}
                    canManage={canManage}
                    onQtyChange={(value) => {
                      setRecipeItems((prev) =>
                        prev.map((it) => it.base_item_id === item.base_item_id ? { ...it, quantity: value } : it),
                      );
                      setRecipeDirty(true);
                    }}
                    onRemove={() => {
                      setRecipeItems((prev) => prev.filter((it) => it.base_item_id !== item.base_item_id));
                      setRecipeDirty(true);
                    }}
                    showError={saveAttempted}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </SortableContext>
      </DndContext>
      {canManage && (
        <RecipeAddCombobox
          excludeIds={new Set(recipeItems.map((it) => it.base_item_id))}
          onAdd={(item) => {
            setRecipeItems((prev) => [
              ...prev,
              { base_item_id: item.id, name: item.name, code: item.code, image_url: item.image_url, quantity: "1" },
            ]);
            setRecipeDirty(true);
          }}
        />
      )}
    </div>
  );
}

function formatMoney(value: number | null | undefined, currency: string | null | undefined): string {
  if (value == null || !isFinite(value) || currency == null) return "—";
  if (currency === "USD") return `$${value.toFixed(2)} USD`;
  if (currency === "AED") return `${value.toFixed(2)} AED`;
  return `${value.toFixed(2)} ${currency}`;
}

function COGSTab({
  productId,
  priceUsd,
  priceAed,
}: {
  productId: number;
  priceUsd: string | null | undefined;
  priceAed: string | null | undefined;
}) {
  const { data, isLoading, isError } = useGetProductCogs(productId);

  if (isLoading) {
    return (
      <div className="rounded-lg border border-border p-10 text-center">
        <Loader2 size={20} className="mx-auto mb-2 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Loading cost breakdown…</p>
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="rounded-lg border border-destructive/50 bg-destructive/5 p-6 text-center">
        <p className="text-sm font-medium text-destructive">Could not load COGS</p>
        <p className="text-xs text-muted-foreground mt-1">Please try again in a moment.</p>
      </div>
    );
  }

  const items = data.items;
  const totals = data.totals;
  const pricedCount = items.length - totals.missing_pricing_count;

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-10 text-center">
        <DollarSign size={28} className="mx-auto mb-2 text-muted-foreground" />
        <p className="font-medium text-sm">No recipe to cost</p>
        <p className="text-xs text-muted-foreground mt-1">
          Add base items to this product's recipe to see a cost breakdown.
        </p>
      </div>
    );
  }

  if (pricedCount === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-10 text-center">
        <DollarSign size={28} className="mx-auto mb-2 text-muted-foreground" />
        <p className="font-medium text-sm">No supplier pricing yet</p>
        <p className="text-xs text-muted-foreground mt-1">
          None of this product's ingredients have a preferred supplier price set.
          Add supplier pricing in the Base Items module to see COGS here.
        </p>
      </div>
    );
  }

  const sellingPriceStr = totals.currency === "USD" ? priceUsd : totals.currency === "AED" ? priceAed : null;
  const sellingPrice = sellingPriceStr != null && sellingPriceStr !== "" ? Number(sellingPriceStr) : null;
  const hasSellingPrice = sellingPrice != null && isFinite(sellingPrice) && sellingPrice > 0;
  const totalCogs = totals.total_cogs;
  const margin =
    hasSellingPrice && totalCogs != null ? sellingPrice - totalCogs : null;
  const marginPct =
    margin != null && hasSellingPrice ? (margin / sellingPrice) * 100 : null;

  return (
    <div className="space-y-4">
      {totals.missing_pricing_count > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950/40">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <div>
            <p className="font-medium text-amber-900 dark:text-amber-200">
              {totals.missing_pricing_count} ingredient{totals.missing_pricing_count === 1 ? "" : "s"} without supplier pricing
            </p>
            <p className="text-xs text-amber-800 dark:text-amber-300 mt-0.5">
              The total COGS below excludes these rows and may be incomplete.
              Set a preferred supplier price in the Base Items module to include them.
            </p>
          </div>
        </div>
      )}

      {totals.mixed_currencies && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950/40">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400" />
          <div>
            <p className="font-medium text-amber-900 dark:text-amber-200">Mixed currencies</p>
            <p className="text-xs text-amber-800 dark:text-amber-300 mt-0.5">
              Ingredient prices are stored in more than one currency. Totals are shown per currency below.
            </p>
          </div>
        </div>
      )}

      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40">
              <th className="px-3 py-2 text-left font-medium text-xs text-muted-foreground uppercase tracking-wide">Ingredient</th>
              <th className="px-3 py-2 text-right font-medium text-xs text-muted-foreground uppercase tracking-wide">Unit cost</th>
              <th className="px-3 py-2 text-right font-medium text-xs text-muted-foreground uppercase tracking-wide">Quantity</th>
              <th className="px-3 py-2 text-right font-medium text-xs text-muted-foreground uppercase tracking-wide">Line cost</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, idx) => {
              const url = imageUrl(item.image_url ?? null);
              const hasPricing = item.line_cost != null && item.currency != null;
              return (
                <tr
                  key={item.base_item_id}
                  className={idx < items.length - 1 ? "border-b border-border" : ""}
                >
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <BaseItemImageThumbnail imageUrl={url} name={item.name} size={7} />
                      <div className="min-w-0">
                        <div className="font-medium truncate">{item.name}</div>
                        <div className="font-mono text-xs text-muted-foreground">{item.code}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right">
                    {hasPricing ? (
                      <div>
                        <div>{formatMoney(item.unit_price ?? null, item.currency ?? null)}</div>
                        {item.pricing_uom ? (
                          <div className="text-xs text-muted-foreground">/ {item.pricing_uom}</div>
                        ) : null}
                      </div>
                    ) : (
                      <Badge variant="outline" className="text-amber-700 border-amber-300 dark:text-amber-300 dark:border-amber-700">
                        No pricing
                      </Badge>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">{item.quantity}</td>
                  <td className="px-3 py-2 text-right font-medium">
                    {hasPricing ? formatMoney(item.line_cost ?? null, item.currency ?? null) : "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="rounded-lg border border-border p-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-muted-foreground">Total COGS</span>
          {totals.mixed_currencies ? (
            <div className="text-right">
              {totals.totals_by_currency.map((t) => (
                <div key={t.currency} className="font-semibold">
                  {formatMoney(t.total, t.currency)}
                </div>
              ))}
            </div>
          ) : (
            <span className="font-semibold">{formatMoney(totalCogs, totals.currency)}</span>
          )}
        </div>

        {!totals.mixed_currencies && (
          <>
            <div className="flex items-center justify-between border-t border-border pt-3">
              <span className="text-sm font-medium text-muted-foreground">Selling price</span>
              <span className="font-semibold">
                {totals.currency === "USD"
                  ? formatUSD(priceUsd ?? null)
                  : totals.currency === "AED"
                    ? formatAED(priceAed ?? null)
                    : "—"}
              </span>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-muted-foreground">Gross margin</span>
              {hasSellingPrice && margin != null ? (
                <span className={`font-semibold ${margin >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"}`}>
                  {formatMoney(margin, totals.currency)}
                  {marginPct != null ? (
                    <span className="ml-2 text-xs font-normal">({marginPct.toFixed(1)}%)</span>
                  ) : null}
                </span>
              ) : (
                <span className="text-sm text-muted-foreground">Set a {totals.currency} price to see margin</span>
              )}
            </div>

            {totals.brand_target_cogs != null && (() => {
              const targetCogsPct = totals.brand_target_cogs;
              const targetMarginPct = 100 - targetCogsPct;
              const onTarget = marginPct != null ? marginPct >= targetMarginPct : null;
              return (
                <div className="flex items-center justify-between border-t border-border pt-3">
                  <span className="text-sm font-medium text-muted-foreground">Target margin</span>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold">{targetMarginPct.toFixed(1)}%</span>
                    {onTarget != null && hasSellingPrice ? (
                      onTarget ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
                          <ArrowUp size={12} />
                          On target
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
                          <ArrowDown size={12} />
                          Below target
                        </span>
                      )
                    ) : null}
                  </div>
                </div>
              );
            })()}
          </>
        )}
      </div>
    </div>
  );
}

function ComingSoonTab({ label }: { label: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border p-10 text-center">
      <p className="text-sm font-medium text-muted-foreground">{label}</p>
      <p className="text-xs text-muted-foreground mt-1">This data is not yet available.</p>
    </div>
  );
}

const VALID_TABS = ["details", "locations", "sales-history", "recipe", "cogs", "cities", "publishing"] as const;
const GALLERY_ACTIVE_STATUSES = new Set(["PENDING", "RUNNING", "RETRY_WAITING"]);
const GALLERY_STALL_TIMEOUT_MS = 15 * 60 * 1000;

function isGalleryRunStalled(run: any, now = Date.now()): boolean {
  if (!run || !GALLERY_ACTIVE_STATUSES.has(run.status)) return false;
  const timestamps = [run.updated_at, run.created_at]
    .concat((run.candidates ?? []).map((candidate: any) => candidate.updated_at))
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value));
  if (!timestamps.length) return false;
  return now - Math.max(...timestamps) > GALLERY_STALL_TIMEOUT_MS;
}

export default function ProductDetail() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, navigate] = useLocation();

  const initialTab = (() => {
    const param = new URLSearchParams(window.location.search).get("tab");
    return VALID_TABS.includes(param as (typeof VALID_TABS)[number]) ? param! : "details";
  })();
  const { isOwner, allowedPages } = useWorkspaceRole();
  const canManageProducts = isOwner || (allowedPages?.includes("products.manage") ?? false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["product", id],
    queryFn: () => apiFetch<{ product: Product; recipe: RecipeItem[] }>(`/api/products/${id}`),
    retry: false,
  });

  const product = data?.product;

  const [galleryDialogOpen, setGalleryDialogOpen] = useState(false);

  const runsQuery = useQuery({
    queryKey: ["product-gallery-runs", product?.id],
    queryFn: () => apiFetch<{ runs: any[] }>(`/api/products/${product?.id}/gallery/runs`),
    enabled: !!product?.id && canManageProducts,
    refetchInterval: (query) => query.state.data?.runs?.some(
      (run: any) => GALLERY_ACTIVE_STATUSES.has(run.status) && !isGalleryRunStalled(run),
    ) ? 2000 : false,
  });

  const latestRun = runsQuery.data?.runs?.[0];


  type ProductMode = "view" | "edit" | "saving" | "saved";
  const [mode, setMode] = useState<ProductMode>("view");
  const [form, setForm] = useState<FormState | null>(null);
  const prevBrandRef = useRef<string>("");

  const [recipeItems, setRecipeItems] = useState<RecipeItem[]>([]);
  const [, setRecipeEditTouched] = useState(false);
  const [saveAttempted, setSaveAttempted] = useState(false);
  const [nameTouched, setNameTouched] = useState(false);
  const [priceUsdTouched, setPriceUsdTouched] = useState(false);
  const [priceAedTouched, setPriceAedTouched] = useState(false);
  const [headerLightboxOpen, setHeaderLightboxOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<(typeof VALID_TABS)[number]>(initialTab as (typeof VALID_TABS)[number]);
  const [discardDialogOpen, setDiscardDialogOpen] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<
    { kind: "tab"; value: (typeof VALID_TABS)[number] } |
    { kind: "path"; value: string } |
    { kind: "cancel" } |
    null
  >(null);

  const isEditing = mode === "edit" || mode === "saving";

  useEffect(() => {
    if (product && !isEditing) {
      setForm(productToForm(product));
      prevBrandRef.current = product.brand ?? "";
    }
  }, [product, isEditing]);

  useEffect(() => {
    if (data?.recipe && !isEditing) {
      setRecipeItems(data.recipe);
    }
  }, [data?.recipe, isEditing]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((f) => f ? { ...f, [key]: value } : f);
    setRecipeEditTouched(true);
  }

  const loadedForm = product ? productToForm(product) : null;
  const dirty = !!form && !!loadedForm &&
    JSON.stringify(normalizeForm(form)) !== JSON.stringify(normalizeForm(loadedForm));
  const recipeDirty = !!data?.recipe &&
    JSON.stringify(normalizeRecipe(recipeItems)) !== JSON.stringify(normalizeRecipe(data.recipe));
  const hasUnsavedChanges = isEditing && (dirty || recipeDirty);


  const { data: brandsData } = useQuery({
    queryKey: ["brands"],
    queryFn: () => apiFetch<{ brands: Brand[] }>("/api/brands"),
  });
  const brands = brandsData?.brands ?? [];

  const saveMutation = useMutation({
    mutationFn: async (f: FormState) => {
      const productResult = await apiFetch<{ product: Product }>(`/api/products/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: f.name.trim(),
          price_usd: parseFloat(f.price_usd),
          price_aed: parseFloat(f.price_aed),
          discount_price_usd: f.discount_price_usd.trim() === "" ? null : parseFloat(f.discount_price_usd),
          discount_price_aed: f.discount_price_aed.trim() === "" ? null : parseFloat(f.discount_price_aed),
          description: f.description.trim() || null,
          status: f.status,
          brand: f.brand.trim() || null,
          tags: f.tags.split(",").map((t) => t.trim()).filter(Boolean),
          catalog_category_ids: f.categories.filter((c) => c.kind === "catalog_category").map((c) => c.id),
          occasion_ids: f.categories.filter((c) => c.kind === "occasion").map((c) => c.id),
          main_image_url: f.main_image_url,
          additional_image_urls: f.additional_image_urls,
          has_input_field: f.has_input_field,
          letter_input_enabled: f.letter_input_enabled,
          is_upsell: f.is_upsell,
          is_cmc: f.is_cmc,
          ...(f.is_cmc && f.initial_cmc_stock !== null ? { initial_cmc_stock: f.initial_cmc_stock } : {}),
          catalog_brand_id: f.catalog_brand_id ? Number(f.catalog_brand_id) : null,
        }),
      });

      let savedRecipe: RecipeItem[] | undefined;
      if (recipeDirty) {
        const recipeResult = await apiFetch<{ recipe: RecipeItem[] }>(`/api/products/${id}/recipe`, {
          method: "PUT",
          body: JSON.stringify({
            items: recipeItems.map((it, i) => ({
              base_item_id: it.base_item_id,
              quantity: parseFloat(it.quantity),
              sort_order: i,
            })),
          }),
        });
        savedRecipe = recipeResult.recipe;
      }

      return { product: productResult.product, recipe: savedRecipe };
    },
    onMutate: () => {
      setMode("saving");
    },
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.setQueryData(["product", id], (old: { product: Product; recipe: RecipeItem[] } | undefined) => ({
        product: result.product,
        recipe: result.recipe ?? old?.recipe ?? [],
      }));
      setForm(productToForm(result.product));
      if (result.recipe) setRecipeItems(result.recipe);
      setSaveAttempted(false);
      setMode("saved");
      toast({ title: "Saved", description: "Product changes were saved.", duration: 4000 });
      window.setTimeout(() => setMode("view"), 700);
    },
    onError: (err: Error) => {
      setMode("edit");
      toast({ variant: "destructive", title: "Failed to save product", description: err.message });
    },
  });

  const hasInvalidRecipeQty = recipeItems.some((it) => {
    const qty = Number(it.quantity);
    return isNaN(qty) || qty <= 0;
  });

  function priceError(value: string): string | null {
    if (value.trim() === "") return "Required";
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return "Must be a valid number";
    if (parsed < 0) return "Must be a non-negative number";
    return null;
  }

  function discountErrorFn(discount: string, regular: string): string | null {
    if (discount.trim() === "") return null;
    const d = Number(discount);
    if (isNaN(d) || d < 0) return "Must be a valid non-negative number";
    const r = Number(regular);
    if (!isNaN(r) && d >= r) return "Must be less than the regular price";
    return null;
  }

  const nameError = form && form.name.trim().length === 0 ? "Required" : null;
  const priceUsdError = form ? priceError(form.price_usd) : null;
  const priceAedError = form ? priceError(form.price_aed) : null;
  const discountUsdError = form ? discountErrorFn(form.discount_price_usd, form.price_usd) : null;
  const discountAedError = form ? discountErrorFn(form.discount_price_aed, form.price_aed) : null;

  const canSave =
    !!form &&
    form.name.trim().length > 0 &&
    form.price_usd !== "" &&
    form.price_aed !== "" &&
    priceUsdError === null &&
    priceAedError === null &&
    discountUsdError === null &&
    discountAedError === null &&
    !hasInvalidRecipeQty &&
    (dirty || recipeDirty) &&
    !saveMutation.isPending;

  function handleSave() {
    if (!form) return;
    if (nameError || priceUsdError || priceAedError || discountUsdError || discountAedError || hasInvalidRecipeQty) {
      setSaveAttempted(true);
      if (nameError) {
        setNameTouched(true);
        document.getElementById("pd-name")?.focus();
      } else if (priceUsdError) {
        setPriceUsdTouched(true);
        document.getElementById("pd-price-usd")?.focus();
      } else if (priceAedError) {
        setPriceAedTouched(true);
        document.getElementById("pd-price-aed")?.focus();
      } else if (discountUsdError) {
        document.getElementById("pd-discount-usd")?.focus();
      } else if (discountAedError) {
        document.getElementById("pd-discount-aed")?.focus();
      }
      return;
    }
    saveMutation.mutate(form);
  }

  function discardChanges() {
    if (!product) return;
    setForm(productToForm(product));
    setSaveAttempted(false);
    setNameTouched(false);
    setPriceUsdTouched(false);
    setPriceAedTouched(false);
    if (data?.recipe) {
      setRecipeItems(data.recipe);
    }
    setRecipeEditTouched(false);
    setMode("view");
  }

  function requestNavigation(action:
    { kind: "tab"; value: (typeof VALID_TABS)[number] } |
    { kind: "path"; value: string } |
    { kind: "cancel" },
  ) {
    if (hasUnsavedChanges) {
      setPendingNavigation(action);
      setDiscardDialogOpen(true);
      return;
    }
    if (action.kind === "tab") setActiveTab(action.value);
    if (action.kind === "path") navigate(action.value);
    if (action.kind === "cancel") discardChanges();
  }

  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [hasUnsavedChanges]);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <Link href="/products">
            <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground">
              <ArrowLeft size={14} />
              Products
            </Button>
          </Link>
        </div>
        <div className="flex items-center justify-center py-16">
          <Loader2 size={28} className="animate-spin text-muted-foreground" />
        </div>
      </div>
    );
  }

  if (isError || !product || !form) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <Link href="/products">
            <Button variant="ghost" size="sm" className="gap-1.5 text-muted-foreground">
              <ArrowLeft size={14} />
              Products
            </Button>
          </Link>
        </div>
        <div className="rounded-lg border border-dashed border-border p-12 text-center">
          <ShoppingBag size={32} className="mx-auto mb-3 text-muted-foreground" />
          <p className="font-medium">Product not found</p>
          <p className="text-sm text-muted-foreground mt-1">
            This product may have been deleted or you don't have access to it.
          </p>
          <Link href="/products">
            <Button variant="outline" className="mt-4">Back to Products</Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Back link */}
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 text-muted-foreground"
          onClick={() => requestNavigation({ kind: "path", value: "/products" })}
        >
          <ArrowLeft size={14} />
          Products
        </Button>
      </div>

      {/* Header */}
      <div className="sticky top-0 z-30 -mx-2 flex items-start gap-3 border-b border-border bg-background/95 px-2 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/85">
        {/* Product image thumbnail */}
        {(() => {
          const thumb = imageUrl(product.main_image_url);
          return thumb ? (
            <button
              type="button"
              onClick={() => setHeaderLightboxOpen(true)}
              className="group relative shrink-0 w-20 h-20 rounded-lg border border-border overflow-hidden bg-muted cursor-pointer"
              title="Click to view full size and download"
            >
              <img src={thumb} alt={product.name} className="w-full h-full object-cover" />
              <div className="absolute inset-0 bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                <ZoomIn size={16} className="text-white" />
              </div>
            </button>
          ) : (
            <div className="shrink-0 w-20 h-20 rounded-lg border border-dashed border-border flex items-center justify-center bg-muted">
              <ShoppingBag size={22} className="text-muted-foreground" />
            </div>
          );
        })()}

        {/* Name, badge, subtitle, description, and action buttons */}
        <div className="flex-1 min-w-0 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl font-bold tracking-tight sm:text-2xl">{product.name}</h1>
              {statusBadge(product.status)}
              {hasUnsavedChanges && <Badge variant="outline" className="border-amber-300 text-amber-700 dark:border-amber-700 dark:text-amber-300">Unsaved changes</Badge>}
              {mode === "saved" && <Badge className="border-0 bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"><Check size={12} className="mr-1" />Saved</Badge>}
            </div>
            {(product.brand || product.category) && (
              <p className="text-sm text-muted-foreground mt-1">
                {[product.brand, product.category].filter(Boolean).join(" · ")}
              </p>
            )}
            {product.description && (
              <p className="text-sm text-muted-foreground mt-1 line-clamp-2">
                {product.description}
              </p>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setHeaderLightboxOpen(true)}
              aria-label="Preview product image"
            >
              <ZoomIn size={14} />
              <span className="hidden sm:inline">Preview</span>
            </Button>
            {canManageProducts && mode === "view" && (
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => setMode("edit")}
                data-testid="button-edit-product"
              >
                <Pencil size={14} className="mr-1.5" />
                Edit
              </Button>
            )}
            {canManageProducts && isEditing && (
              <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => requestNavigation({ kind: "cancel" })}
                disabled={saveMutation.isPending}
              >
                Cancel
              </Button>
              <div
                data-testid="save-button-wrapper"
                onMouseDown={() => {
                  if (hasInvalidRecipeQty || nameError || priceUsdError || priceAedError || discountUsdError || discountAedError) {
                    setSaveAttempted(true);
                    if (nameError) setNameTouched(true);
                    if (priceUsdError) setPriceUsdTouched(true);
                    if (priceAedError) setPriceAedTouched(true);
                  }
                }}
              >
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={!canSave}
                >
                  {saveMutation.isPending ? (
                    <><Loader2 size={14} className="animate-spin mr-1.5" />Saving…</>
                  ) : (
                    "Save"
                  )}
                </Button>
              </div>
              </>
            )}
          </div>
        </div>
      </div>
      {/* Header image lightbox */}
      <ProductImageLightbox
        product={product}
        open={headerLightboxOpen}
        onClose={() => setHeaderLightboxOpen(false)}
      />

      {/* Tabs */}
      <Tabs
        value={activeTab}
        onValueChange={(value) => requestNavigation({ kind: "tab", value: value as (typeof VALID_TABS)[number] })}
      >
        <TabsList className="flex flex-wrap h-auto gap-1 w-full justify-start">
          <TabsTrigger value="details">Product Details</TabsTrigger>
          <TabsTrigger value="locations">Locations</TabsTrigger>
          <TabsTrigger value="sales-history">Sales History</TabsTrigger>
          <TabsTrigger value="recipe">Recipe</TabsTrigger>
          <TabsTrigger value="cogs">COGS</TabsTrigger>
          <TabsTrigger value="cities">City Availability</TabsTrigger>
          <TabsTrigger value="publishing">Publishing</TabsTrigger>
        </TabsList>

        {/* Product Details tab */}
        <TabsContent value="details" className="mt-4">
          {isEditing ? (
            <ProductDetailsEditForm
              product={product}
              form={form}
              set={set}
              brands={brands}
              saveAttempted={saveAttempted}
              nameTouched={nameTouched}
              setNameTouched={setNameTouched}
              priceUsdTouched={priceUsdTouched}
              setPriceUsdTouched={setPriceUsdTouched}
              priceAedTouched={priceAedTouched}
              setPriceAedTouched={setPriceAedTouched}
              nameError={nameError}
              priceUsdError={priceUsdError}
              priceAedError={priceAedError}
              discountUsdError={discountUsdError}
              discountAedError={discountAedError}
              prevBrandRef={prevBrandRef}
              latestRunId={latestRun?.id}
              onOpenGallery={() => setGalleryDialogOpen(true)}
            />
          ) : (
            <ProductDetailsReadOnly product={product} />
          )}
        </TabsContent>

        {/* Locations tab */}
        <TabsContent value="locations" className="mt-4">
          <LocationsTab productId={product.id} canManage={canManageProducts} />
        </TabsContent>

        {/* Sales History tab */}
        <TabsContent value="sales-history" className="mt-4">
          <SalesHistoryTab productId={product.id} />
        </TabsContent>

        {/* Recipe tab */}
        <TabsContent value="recipe" className="mt-4 space-y-6">
          {/* Live recipe section */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Live Recipe
              </span>
              <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">
                Active · COGS tied to this
              </span>
            </div>
            {isEditing ? (
              <RecipeEditTab
                recipeItems={recipeItems}
                setRecipeItems={setRecipeItems}
                setRecipeDirty={setRecipeEditTouched}
                saveAttempted={saveAttempted}
                canManage={canManageProducts}
              />
            ) : (
              <RecipeReadOnlyTab items={recipeItems} />
            )}
          </div>

          {/* Recipe suggestion section (managers only) */}
          {canManageProducts && !isEditing && (
            <div>
              <div className="flex items-center gap-2 mb-3">
                <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Recipe Suggestions
                </span>
              </div>
              <RecipeSuggestionPanel
                productId={product.id}
                canManage={canManageProducts}
              />
            </div>
          )}
        </TabsContent>

        {/* COGS tab */}
        <TabsContent value="cogs" className="mt-4">
          {product ? (
            <COGSTab
              productId={product.id}
              priceUsd={product.price_usd}
              priceAed={product.price_aed}
            />
          ) : null}
        </TabsContent>

        {/* City Availability tab */}
        <TabsContent value="cities" className="mt-4">
          <ProductCityAvailabilityTab productId={product.id} canManage={canManageProducts} />
        </TabsContent>

        {/* Publishing tab */}
        <TabsContent value="publishing" className="mt-4">
          <ProductPublishingTab productId={product.id} canManage={canManageProducts} />
        </TabsContent>
      </Tabs>
      <AlertDialog open={discardDialogOpen} onOpenChange={setDiscardDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>
              Your product and recipe edits have not been saved. Discarding them cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingNavigation(null)}>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const action = pendingNavigation;
                discardChanges();
                if (action?.kind === "tab") setActiveTab(action.value);
                if (action?.kind === "path") navigate(action.value);
                setPendingNavigation(null);
                setDiscardDialogOpen(false);
              }}
            >
              Discard changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <GenerateGalleryDialog
        productId={product.id}
        productMainImageUrl={product.main_image_url}
        open={galleryDialogOpen}
        onOpenChange={setGalleryDialogOpen}
      />
    </div>
  );
}
const GALLERY_OPTIONS = [
  { id: "alternative_composition", label: "Alternative composition", desc: "A fresh studio arrangement" },
  { id: "close_up_details", label: "Close-up details", desc: "Highlight flowers and finishing" },
  { id: "lifestyle_setting", label: "Lifestyle setting", desc: "Show the product in context" },
  { id: "hand_held_scale", label: "Hand-held for scale", desc: "Help customers understand size" },
] as const;

function CandidateCard({
  candidate,
  productId,
  productMainImageUrl,
  onApproved,
  isRunStalled = false,
}: {
  candidate: any;
  productId: number;
  productMainImageUrl: string | null;
  onApproved: (product: Product) => void;
  isRunStalled?: boolean;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [compareOpen, setCompareOpen] = useState(false);

  const isStale = !!productMainImageUrl && !!candidate.source_path && candidate.source_path !== productMainImageUrl;
  const isPending = ["PENDING", "PROCESSING", "RETRY_WAITING"].includes(candidate.status);
  const isReady = candidate.status === "DRAFT";
  const isFailed = candidate.status === "FAILED";
  const isApproved = candidate.status === "APPROVED";
  const isRejected = candidate.status === "REJECTED";

  const actionMutation = useMutation({
    mutationFn: (action: "approve" | "reject" | "retry" | "delete") =>
      apiFetch(`/api/products/${productId}/gallery/candidates/${candidate.id}${action === "delete" ? "" : `/${action}`}`, { method: action === "delete" ? "DELETE" : "POST" }),
    onSuccess: (data: any, action) => {
      queryClient.invalidateQueries({ queryKey: ["product-gallery-runs", productId] });
      queryClient.invalidateQueries({ queryKey: ["product-gallery-run", productId] });
      queryClient.invalidateQueries({ queryKey: ["product"] });
      if (action === "approve") {
        if (data?.product) onApproved(data.product as Product);
        toast({ title: "Added to gallery" });
      } else if (action === "retry") {
        toast({ title: "Regenerating image" });
      }
    },
    onError: (err: any) => {
      toast({ title: "Action failed", description: err.message, variant: "destructive" });
    }
  });

  const opt = GALLERY_OPTIONS.find(o => o.id === candidate.gallery_type);
  const label = opt ? opt.label : candidate.gallery_type;

  return (
    <div className="border border-border rounded-lg overflow-hidden bg-card flex flex-col relative group shadow-sm hover:shadow transition-shadow">
      <div className="aspect-square bg-muted relative">
        {isPending ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground gap-2">
            {isRunStalled
              ? <AlertTriangle size={24} className="opacity-60" />
              : <Loader2 className="animate-spin" size={24} />}
            <span className="text-xs font-medium uppercase tracking-wider">
              {isRunStalled
                ? "Stalled"
                : candidate.status === "RETRY_WAITING"
                ? "Waiting to retry..."
                : candidate.status === "PENDING"
                  ? "Queued..."
                  : "Generating..."}
            </span>
          </div>
        ) : candidate.image_path ? (
          <>
            <img src={imageUrl(candidate.image_path)!} alt="" className="w-full h-full object-cover" />
            <div className="absolute inset-x-0 bottom-0 p-2 bg-gradient-to-t from-black/60 to-transparent flex justify-end opacity-0 group-hover:opacity-100 transition-opacity">
              <Button size="icon" variant="secondary" className="w-7 h-7 rounded-full bg-background/80 hover:bg-background" onClick={(e) => { e.preventDefault(); setCompareOpen(true); }}>
                <ZoomIn size={14} />
              </Button>
            </div>
          </>
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-muted-foreground">
            <AlertTriangle size={24} className="mb-2 opacity-50" />
            <span className="text-xs">{isFailed ? "Failed" : "No image"}</span>
          </div>
        )}

        <div className="absolute top-2 left-2 flex flex-col gap-1 items-start">
          <Badge variant="secondary" className="bg-background/90 backdrop-blur text-[10px] uppercase font-semibold border-0">AI Draft</Badge>
          {isStale && <Badge variant="destructive" className="text-[10px] uppercase font-semibold border-0">previous-source</Badge>}
          {isFailed && <Badge variant="destructive" className="text-[10px] uppercase font-semibold border-0">Failed</Badge>}
          {isApproved && <Badge className="bg-emerald-500 hover:bg-emerald-600 text-white text-[10px] uppercase font-semibold border-0">Approved</Badge>}
        </div>
      </div>

      <div className="p-3 flex flex-col flex-1">
        <p className="text-xs font-medium mb-1 uppercase tracking-wider text-muted-foreground">{label.replace('_', ' ')}</p>

        {isFailed && candidate.error?.message && (
          <p className="text-[10px] text-destructive mt-1 mb-2 line-clamp-2" title={candidate.error.message}>{candidate.error.message}</p>
        )}
        {actionMutation.isError && (
          <p className="text-[10px] text-destructive mt-1 mb-2 line-clamp-2">{(actionMutation.error as any).message}</p>
        )}

        <div className="mt-auto pt-3 flex gap-2">
          {isReady && !isStale && !isApproved && (
            <Button type="button" size="sm" className="flex-1 text-xs h-7" disabled={actionMutation.isPending} onClick={() => actionMutation.mutate("approve")}>
              Approve & add to gallery
            </Button>
          )}
          {isFailed && (
            <Button type="button" size="sm" variant="outline" className="flex-1 text-xs h-7" disabled={actionMutation.isPending} onClick={() => actionMutation.mutate("retry")}>
              Retry
            </Button>
          )}
          {isReady && !isStale && (
            <Button type="button" size="sm" variant="outline" className="text-xs h-7" disabled={actionMutation.isPending} onClick={() => actionMutation.mutate("retry")}>
              Regenerate
            </Button>
          )}
          {!isApproved && !isPending && !isRejected && (
             <Button type="button" size="sm" variant="ghost" className="px-2 text-xs h-7 text-muted-foreground hover:text-destructive" disabled={actionMutation.isPending} onClick={() => actionMutation.mutate(isRejected || isFailed ? "delete" : "reject")}>
               {isRejected || isFailed ? "Delete" : "Reject"}
             </Button>
          )}
          {isRejected && (
            <Button type="button" size="sm" variant="ghost" className="px-2 text-xs h-7 text-muted-foreground hover:text-destructive" disabled={actionMutation.isPending} onClick={() => actionMutation.mutate("delete")}>
              Delete
            </Button>
          )}
        </div>
      </div>

      {candidate.image_path && (
        <Dialog open={compareOpen} onOpenChange={setCompareOpen}>
          <DialogContent className="max-w-4xl bg-background/95 backdrop-blur-sm border-muted">
            <DialogHeader>
              <DialogTitle>Compare with Original</DialogTitle>
            </DialogHeader>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-6 mt-2">
              <div className="space-y-3">
                <p className="text-sm font-medium text-center text-muted-foreground">Original</p>
                <div className="rounded-lg overflow-hidden border bg-muted aspect-square">
                  <img src={imageUrl(productMainImageUrl)!} alt="" className="w-full h-full object-cover" />
                </div>
              </div>
              <div className="space-y-3">
                <p className="text-sm font-medium text-center text-primary">AI Generated</p>
                <div className="rounded-lg overflow-hidden border-2 border-primary/20 bg-muted aspect-square relative">
                  <img src={imageUrl(candidate.image_path)!} alt="" className="w-full h-full object-cover" />
                  {isStale && (
                    <div className="absolute top-3 right-3">
                      <Badge variant="destructive" className="shadow-sm border-0">previous-source</Badge>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function GalleryRunTracker({
  runId,
  productId,
  productMainImageUrl,
  onApproved,
}: {
  runId: number;
  productId: number;
  productMainImageUrl: string | null;
  onApproved: (product: Product) => void;
}) {
  const queryClient = useQueryClient();
  const runQuery = useQuery({
    queryKey: ["product-gallery-run", productId, runId],
    queryFn: () => apiFetch<{ run: { id: number; status?: string; created_at?: string; updated_at?: string; candidates: any[] } }>(`/api/products/${productId}/gallery/runs/${runId}`),
    refetchInterval: (query) => {
      const run = query.state.data?.run;
      return run?.candidates?.some((candidate: any) =>
        ["PENDING", "PROCESSING", "RETRY_WAITING"].includes(candidate.status)
      ) && !isGalleryRunStalled(run) ? 2000 : false;
    },
  });

  const run = runQuery.data?.run;
  const candidates = run?.candidates?.filter((c: any) => c.status !== "DELETED") || [];
  const isStalled = isGalleryRunStalled(run);
  const recoveryMutation = useMutation({
    mutationFn: () => apiFetch(
      `/api/products/${productId}/gallery/runs/${runId}/recover`,
      { method: "POST" },
    ),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["product-gallery-runs", productId] });
      await runQuery.refetch();
    },
  });
  if (runQuery.isError) {
    return (
      <Alert variant="destructive" className="mt-4">
        <AlertTriangle size={16} />
        <AlertDescription className="flex items-center justify-between gap-3">
          <span>Gallery progress could not be refreshed. Check your connection and try again.</span>
          <Button type="button" size="sm" variant="outline" onClick={() => runQuery.refetch()}>
            Retry
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
  if (!candidates.length && !isStalled) return null;

  const completedCount = candidates.filter((c: any) => ["DRAFT", "APPROVED", "REJECTED", "STALE"].includes(c.status)).length;
  const processingCount = candidates.filter((c: any) => c.status === "PROCESSING").length;
  const retryingCount = candidates.filter((c: any) => c.status === "RETRY_WAITING").length;
  const queuedCount = candidates.filter((c: any) => c.status === "PENDING").length;
  const failedCount = candidates.filter((c: any) => c.status === "FAILED").length;
  const isGenerating = !isStalled && processingCount + retryingCount + queuedCount > 0;
  const totalCount = candidates.length;

  return (
    <div className="pt-4 mt-2 border-t border-border">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
          <FlaskConical size={12} />
          AI Gallery Drafts
        </h3>
        <span className={`text-xs font-medium flex items-center gap-1.5 ${
          isGenerating
            ? "text-teal-600 dark:text-teal-400"
            : failedCount > 0
              ? "text-destructive"
              : "text-muted-foreground"
        }`}>
            {isGenerating && <Loader2 size={12} className="animate-spin" />}
            {completedCount} of {totalCount} finished
            {!isStalled && processingCount > 0 ? ` · ${processingCount} generating` : ""}
            {!isStalled && retryingCount > 0 ? ` · ${retryingCount} retrying` : ""}
            {!isStalled && queuedCount > 0 ? ` · ${queuedCount} queued` : ""}
            {isStalled ? " · stalled" : ""}
            {failedCount > 0 ? ` · ${failedCount} failed` : ""}
        </span>
      </div>
      {isStalled && (
        <Alert variant="destructive" className="mb-3">
          <AlertTriangle size={16} />
          <AlertDescription className="flex items-center justify-between gap-3">
            <span>
              Gallery generation appears stalled or unavailable. Retry generation to recover interrupted work.
              {recoveryMutation.isError && (
                <span className="block mt-1">{(recoveryMutation.error as Error).message}</span>
              )}
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={recoveryMutation.isPending}
              onClick={() => recoveryMutation.mutate()}
            >
              {recoveryMutation.isPending && <Loader2 size={12} className="animate-spin mr-1.5" />}
              Retry generation
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {!!candidates.length && (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3">
          {candidates.map((c: any) => (
            <CandidateCard
              key={c.id}
              candidate={c}
              productId={productId}
              productMainImageUrl={productMainImageUrl}
              onApproved={onApproved}
              isRunStalled={isStalled}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function GenerateGalleryDialog({
  productId,
  productMainImageUrl,
  open,
  onOpenChange,
}: {
  productId: number;
  productMainImageUrl: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(GALLERY_OPTIONS.map((option) => option.id)),
  );
  const idempotencyKeyRef = useRef(crypto.randomUUID());

  useEffect(() => {
    if (!open) return;
    setSelected(new Set(GALLERY_OPTIONS.map((option) => option.id)));
    idempotencyKeyRef.current = crypto.randomUUID();
  }, [open]);

  const generate = useMutation({
    mutationFn: async () => {
      return apiFetch(`/api/products/${productId}/gallery/runs`, {
        method: "POST",
        body: JSON.stringify({
          selectedTypes: Array.from(selected),
          idempotencyKey: idempotencyKeyRef.current,
        })
      });
    },
    onSuccess: async (data: any) => {
      const runId = data?.run?.id;
      if (data?.run) {
        queryClient.setQueryData<{ runs: any[] }>(
          ["product-gallery-runs", productId],
          (current) => ({
            runs: [
              data.run,
              ...(current?.runs ?? []).filter((run) => run.id !== data.run.id),
            ],
          }),
        );
      }
      await queryClient.refetchQueries({ queryKey: ["product-gallery-runs", productId], type: "active" });
      if (runId) {
        await queryClient.fetchQuery({
          queryKey: ["product-gallery-run", productId, runId],
          queryFn: () => apiFetch(`/api/products/${productId}/gallery/runs/${runId}`),
        });
      }
      onOpenChange(false);
      setSelected(new Set(GALLERY_OPTIONS.map((option) => option.id)));
      toast({ title: "Started generating images" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to start generation", description: err.message, variant: "destructive" });
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Generate product gallery</DialogTitle>
          <DialogDescription>
            Create additional images using the primary product image as reference.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col sm:flex-row gap-6 mt-2">
          <div className="sm:w-1/3 shrink-0">
            <p className="text-sm font-medium mb-3">Original image</p>
            <div className="aspect-square rounded-lg border bg-muted overflow-hidden">
              {productMainImageUrl ? (
                <img src={imageUrl(productMainImageUrl)!} alt="" className="w-full h-full object-cover" />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-muted-foreground text-xs">No image</div>
              )}
            </div>
          </div>
          <div className="flex-1">
            <p className="text-sm font-medium mb-3">Choose images to generate</p>
            <div className="space-y-3">
              {GALLERY_OPTIONS.map(opt => {
                const checked = selected.has(opt.id);
                return (
                  <label key={opt.id} className="flex items-start gap-3 cursor-pointer group">
                    <Checkbox
                      checked={checked}
                      onCheckedChange={(c) => {
                        const next = new Set(selected);
                        if (c) next.add(opt.id);
                        else next.delete(opt.id);
                        setSelected(next);
                      }}
                      className="mt-0.5"
                    />
                    <div className="space-y-1">
                      <p className="text-sm font-medium leading-none group-hover:text-primary transition-colors">
                        {opt.label} <span className="text-muted-foreground font-normal">/ {opt.desc}</span>
                      </p>
                    </div>
                  </label>
                )
              })}
            </div>
          </div>
        </div>
        <Alert className="mt-4 bg-muted/50 border-0">
          <AlertDescription className="text-muted-foreground">
            AI may adjust small product details. Review every image before publishing.
          </AlertDescription>
        </Alert>
        <DialogFooter className="flex flex-col sm:flex-row sm:items-center justify-between mt-4 gap-4">
          <span className="text-sm text-muted-foreground">Images will be saved as drafts.</span>
          <div className="flex gap-2 w-full sm:w-auto">
            <Button type="button" variant="outline" className="flex-1 sm:flex-none" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button
              type="button"
              className="flex-1 sm:flex-none"
              disabled={selected.size === 0 || generate.isPending}
              onClick={() => generate.mutate()}
            >
              {generate.isPending && <Loader2 size={14} className="animate-spin mr-2" />}
              Generate {selected.size} image{selected.size === 1 ? '' : 's'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
