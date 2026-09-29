import { useState, useRef, useEffect, useMemo } from "react";
import { Link, useParams, useSearch } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useGetBaseItem,
  useGetBaseItemProducts,
  useGetBaseItemLocationStatuses,
  usePatchBaseItemLocationStatus,
  usePatchBaseItem,
  useListBaseItemAuditLog,
  useListBaseItemInvoices,
  getGetBaseItemLocationStatusesQueryKey,
  getGetBaseItemQueryKey,
  getGetBaseItemInventoryOverviewQueryKey,
  getListBaseItemAdjustmentsQueryKey,
} from "@workspace/api-client-react";
import type {
  BaseItemDetail,
  BaseItemProductLink,
  BaseItemLocationStatus,
  BaseItemAuditLogEntry,
  BaseItemInvoice,
} from "@workspace/api-client-react";
import { InventoryTab } from "./InventoryTab";
import { StockMovementTab } from "./StockMovementTab";
import { PackagingTab } from "./PackagingTab";
import { SuppliersTab } from "./SuppliersTab";
import { apiFetch } from "@/lib/queryClient";
import { imageUrl } from "@/lib/imageUrl";
import {
  ArrowLeft,
  FlaskConical,
  History as HistoryIcon,
  ImageIcon,
  Loader2,
  MapPin,
  Package,
  Pencil,
  Receipt,
  Sparkles,
  Upload,
  X,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { WorkspaceImage } from "@/components/WorkspaceImage";

type SubCategory = { id: number; name: string; parent_id: number };
type MainCategory = { id: number; name: string; parent_id: null; subcategories: SubCategory[] };

type EditFormState = {
  name: string;
  alternate_name: string;
  category_id: string;
  accounting_category: string;
  tax_category: string;
  tax_rate: string;
  image_url: string | null;
};

const TAX_CATEGORY_OPTIONS: { value: string; label: string }[] = [
  { value: "not_classified", label: "Not Classified" },
  { value: "standard_taxable", label: "Standard Taxable" },
  { value: "zero_rated", label: "Zero Rated" },
  { value: "exempt", label: "Exempt" },
  { value: "non_taxable", label: "Non-Taxable" },
  { value: "food_grocery", label: "Food & Grocery" },
  { value: "packaging", label: "Packaging" },
  { value: "service", label: "Service" },
  { value: "import_related", label: "Import-Related" },
];

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

function ReadOnlyField({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{label}</p>
      <p className="text-sm">{value ?? <span className="text-muted-foreground italic">Not set</span>}</p>
    </div>
  );
}

function ImageUploadField({
  currentUrl,
  onUploaded,
  onRemove,
}: {
  currentUrl: string | null;
  onUploaded: (url: string) => void;
  onRemove: () => void;
}) {
  const { toast } = useToast();
  const [uploading, setUploading] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [showAiPrompt, setShowAiPrompt] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const promptRef = useRef<HTMLInputElement>(null);
  const thumb = imageUrl(currentUrl);

  useEffect(() => {
    if (showAiPrompt) promptRef.current?.focus();
  }, [showAiPrompt]);

  async function handleFile(file: File) {
    setUploading(true);
    setUploadError(null);
    try {
      const fd = new FormData();
      fd.append("image", file);
      const data = await apiFetch<{ url: string }>("/api/base-items/upload-image", {
        method: "POST",
        body: fd,
      });
      onUploaded(data.url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not upload image.";
      setUploadError(msg);
      toast({ title: "Upload failed", description: msg, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  }

  async function handleGenerate() {
    if (!aiPrompt.trim()) return;
    setGenerating(true);
    setGenerateError(null);
    try {
      const data = await apiFetch<{ url: string }>("/api/base-items/generate-image", {
        method: "POST",
        body: JSON.stringify({ prompt: aiPrompt.trim() }),
      });
      onUploaded(data.url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not generate image.";
      setGenerateError(msg);
      toast({ title: "Generation failed", description: msg, variant: "destructive" });
    } finally {
      setGenerating(false);
    }
  }

  const busy = uploading || generating;

  return (
    <div className="space-y-1.5">
      <Label>Image</Label>
      {thumb ? (
        <div className="flex items-center gap-3">
          <div className="w-16 h-16 rounded-md border border-border overflow-hidden bg-muted shrink-0">
            <img src={thumb} alt="" className="w-full h-full object-cover" />
          </div>
          <div className="flex gap-2 flex-wrap">
            <Button size="sm" variant="outline" onClick={() => inputRef.current?.click()} disabled={busy}>
              {uploading ? <><Loader2 size={14} className="animate-spin mr-1.5" />Uploading…</> : <><Upload size={14} className="mr-1.5" />Replace</>}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => { setShowAiPrompt((v) => !v); setGenerateError(null); }} disabled={busy}>
              <Sparkles size={14} className="mr-1.5" />Generate with AI
            </Button>
            <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={onRemove} disabled={busy}>
              <X size={14} className="mr-1.5" />Remove
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            className="flex flex-col items-center justify-center w-full h-24 rounded-md border-2 border-dashed border-border bg-muted/30 hover:bg-muted/50 transition-colors cursor-pointer text-muted-foreground text-sm gap-1.5"
          >
            {uploading ? (
              <><Loader2 size={18} className="animate-spin" /><span>Uploading…</span></>
            ) : (
              <><ImageIcon size={18} /><span>Click to upload image</span><span className="text-xs">JPEG, PNG, or WebP</span></>
            )}
          </button>
          <Button type="button" size="sm" variant="outline" className="w-full" onClick={() => { setShowAiPrompt((v) => !v); setGenerateError(null); }} disabled={busy}>
            <Sparkles size={14} className="mr-1.5" />Generate with AI
          </Button>
        </div>
      )}
      {uploadError && <p className="text-sm text-destructive" role="alert">{uploadError}</p>}
      {showAiPrompt && (
        <div className="space-y-1.5 pt-1">
          <div className="flex gap-2 items-center">
            <Input
              ref={promptRef}
              placeholder="Describe the image, e.g. red roses bouquet"
              value={aiPrompt}
              onChange={(e) => setAiPrompt(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleGenerate();
                if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setShowAiPrompt(false); setGenerateError(null); }
              }}
              disabled={generating}
              className="flex-1"
            />
            <Button type="button" size="sm" onClick={handleGenerate} disabled={!aiPrompt.trim() || generating}>
              {generating ? <><Loader2 size={14} className="animate-spin mr-1.5" />{thumb ? "Regenerating…" : "Generating…"}</> : (thumb ? "Regenerate" : "Generate")}
            </Button>
          </div>
          {generateError && <p className="text-sm text-destructive" role="alert">{generateError}</p>}
        </div>
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

function BaseItemDetailsTab({ item }: { item: BaseItemDetail }) {
  const thumb = imageUrl(item.image_url ?? null);
  const category = item.sub_category_name
    ? `${item.main_category_name} › ${item.sub_category_name}`
    : item.main_category_name;

  return (
    <div className="space-y-6">
      {thumb && (
        <div className="w-24 h-24 rounded-lg border border-border overflow-hidden bg-muted">
          <img src={thumb} alt={item.name} className="w-full h-full object-cover" />
        </div>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-5">
        <ReadOnlyField label="Name" value={item.name} />
        <ReadOnlyField label="Code" value={item.code} />
        <ReadOnlyField label="Alternate Name" value={item.alternate_name} />
        <ReadOnlyField label="Category" value={category} />
        <ReadOnlyField label="Accounting Category" value={item.accounting_category} />
        <ReadOnlyField label="Tax Category" value={TAX_CATEGORY_OPTIONS.find((o) => o.value === (item as unknown as { tax_category?: string }).tax_category)?.label ?? (item as unknown as { tax_category?: string }).tax_category ?? "Not Classified"} />
        <ReadOnlyField label="Legacy Tax Rate" value={item.tax_rate != null ? `${item.tax_rate}%` : null} />
        <ReadOnlyField
          label="Created"
          value={new Date(item.created_at).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}
        />
      </div>
    </div>
  );
}

function EditDetailsForm({
  item,
  categories,
  onSaved,
  onCancel,
}: {
  item: BaseItemDetail;
  categories: MainCategory[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const [form, setForm] = useState<EditFormState>({
    name: item.name,
    alternate_name: item.alternate_name ?? "",
    category_id: item.category_id != null ? String(item.category_id) : "",
    accounting_category: item.accounting_category ?? "",
    tax_category: (item as unknown as { tax_category?: string }).tax_category ?? "not_classified",
    tax_rate: item.tax_rate != null ? String(item.tax_rate) : "",
    image_url: item.image_url ?? null,
  });

  function set<K extends keyof EditFormState>(key: K, value: EditFormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  const patchMutation = usePatchBaseItem({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getGetBaseItemQueryKey(item.id) });
        toast({ title: "Base item updated" });
        onSaved();
      },
      onError: (err) => {
        const msg = err instanceof Error ? err.message : "Could not save changes. Please try again.";
        toast({ title: "Failed to save", description: msg, variant: "destructive" });
      },
    },
  });

  function handleSave() {
    if (!form.name.trim()) return;
    patchMutation.mutate({
      id: item.id,
      data: {
        name: form.name.trim(),
        alternate_name: form.alternate_name.trim() || null,
        category_id: form.category_id ? parseInt(form.category_id, 10) : null,
        accounting_category: form.accounting_category.trim() || null,
        tax_category: form.tax_category || null,
        tax_rate: String(form.tax_rate).trim() || null,
        image_url: form.image_url || null,
      },
    });
  }

  const taxRateError =
    String(form.tax_rate).trim() !== "" &&
    (isNaN(parseFloat(form.tax_rate)) || parseFloat(form.tax_rate) < 0 || parseFloat(form.tax_rate) > 100)
      ? "Tax rate must be a number between 0 and 100"
      : null;

  const canSave = form.name.trim().length > 0 && !patchMutation.isPending && !taxRateError;

  return (
    <div className="space-y-5">
      <div className="space-y-1.5">
        <Label className="text-sm">Code</Label>
        <div className="flex h-9 w-full rounded-md border border-input bg-muted px-3 py-2 text-sm text-muted-foreground select-all font-mono tracking-widest">
          {item.code}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="edit-name">Name <span className="text-destructive">*</span></Label>
        <Input
          id="edit-name"
          value={form.name}
          onChange={(e) => set("name", e.target.value)}
          placeholder="e.g. Red Roses"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="edit-alternate-name">Alternate Name</Label>
        <Input
          id="edit-alternate-name"
          value={form.alternate_name}
          onChange={(e) => set("alternate_name", e.target.value)}
          placeholder="Optional alternate name"
        />
      </div>

      <div className="space-y-1.5">
        <Label>Category</Label>
        <Select
          value={form.category_id || "none"}
          onValueChange={(v) => set("category_id", v === "none" ? "" : v)}
        >
          <SelectTrigger>
            <SelectValue placeholder="Select category…" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">
              <span className="text-muted-foreground">No category</span>
            </SelectItem>
            {categories.map((main) => (
              <SelectGroup key={main.id}>
                <SelectLabel>{main.name}</SelectLabel>
                <SelectItem value={String(main.id)}>{main.name}</SelectItem>
                {main.subcategories.map((sub) => (
                  <SelectItem key={sub.id} value={String(sub.id)} className="pl-6">
                    └ {sub.name}
                  </SelectItem>
                ))}
              </SelectGroup>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="edit-accounting-category">Accounting Category</Label>
        <Input
          id="edit-accounting-category"
          value={form.accounting_category}
          onChange={(e) => set("accounting_category", e.target.value)}
          placeholder="e.g. Cost of Goods"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="edit-tax-category">Tax Category</Label>
        <Select
          value={form.tax_category || "not_classified"}
          onValueChange={(v) => set("tax_category", v)}
        >
          <SelectTrigger id="edit-tax-category">
            <SelectValue placeholder="Select tax category…" />
          </SelectTrigger>
          <SelectContent>
            {TAX_CATEGORY_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="edit-tax-rate">Legacy Tax Rate (%)</Label>
        <Input
          id="edit-tax-rate"
          type="number"
          min="0"
          max="100"
          step="any"
          value={form.tax_rate}
          onChange={(e) => set("tax_rate", e.target.value)}
          placeholder="e.g. 10"
        />
        <p className="text-xs text-muted-foreground">Deprecated — use Tax Category above for location-based rates.</p>
        {taxRateError && <p className="text-sm text-destructive">{taxRateError}</p>}
      </div>

      <ImageUploadField
        currentUrl={form.image_url}
        onUploaded={(url) => set("image_url", url)}
        onRemove={() => set("image_url", null)}
      />

      <div className="flex gap-2 pt-2">
        <Button onClick={handleSave} disabled={!canSave}>
          {patchMutation.isPending ? <><Loader2 size={14} className="animate-spin mr-1.5" />Saving…</> : "Save changes"}
        </Button>
        <Button variant="outline" onClick={onCancel} disabled={patchMutation.isPending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

type SortField = "quantity" | "name" | "recipe_updated_at";
type StatusFilter = "all" | "available" | "out_of_stock" | "not_available";

function formatRecipeDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}

function buildUomTotals(products: BaseItemProductLink[]): { unit: string; total: number }[] {
  const byUnit: Record<string, number> = {};
  let withQty = 0;
  for (const p of products) {
    const qty = parseFloat(p.quantity);
    if (isNaN(qty) || qty === 0) continue;
    withQty++;
    const unit = p.unit ?? "unit";
    byUnit[unit] = (byUnit[unit] ?? 0) + qty;
  }
  return Object.entries(byUnit).map(([unit, total]) => ({ unit, total }));
}

function formatQtyDisplay(total: number): string {
  return Number.isInteger(total) ? String(total) : total.toFixed(2).replace(/\.?0+$/, "");
}

function UsageSummaryBlock({ products }: { products: BaseItemProductLink[] }) {
  if (products.length === 0) return null;
  const uomTotals = buildUomTotals(products);
  return (
    <div className="rounded-lg border border-border bg-muted/40 px-4 py-3 space-y-1">
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
        Usage Summary — {products.length} product{products.length !== 1 ? "s" : ""}
      </p>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {uomTotals.map(({ unit, total }) => (
          <span key={unit} className="text-sm font-semibold tabular-nums">
            {formatQtyDisplay(total)} <span className="font-normal text-muted-foreground">{unit}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function UsageOverviewCards({ baseItemId }: { baseItemId: number }) {
  const { data, isLoading } = useGetBaseItemProducts(baseItemId);
  const products: BaseItemProductLink[] = data?.products ?? [];

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="rounded-lg border border-border bg-card p-4 animate-pulse space-y-2">
            <div className="h-3 bg-muted rounded w-2/3" />
            <div className="h-6 bg-muted rounded w-1/2" />
          </div>
        ))}
      </div>
    );
  }

  if (products.length === 0) return null;

  const uomTotals = buildUomTotals(products);
  const topProduct = products.reduce((best, p) => {
    const qty = parseFloat(p.quantity) || 0;
    const bestQty = parseFloat(best.quantity) || 0;
    return qty > bestQty ? p : best;
  }, products[0]);
  const latestDate = products.reduce((latest, p) => {
    return new Date(p.recipe_updated_at) > new Date(latest) ? p.recipe_updated_at : latest;
  }, products[0].recipe_updated_at);

  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Usage Overview</p>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {/* Products count */}
        <div className="rounded-lg border border-border bg-card p-4 space-y-1">
          <p className="text-xs text-muted-foreground">Products using this item</p>
          <p className="text-2xl font-bold tabular-nums">{products.length}</p>
        </div>

        {/* Total consumption */}
        <div className="rounded-lg border border-border bg-card p-4 space-y-1">
          <p className="text-xs text-muted-foreground">Total recipe consumption</p>
          <div className="space-y-0.5">
            {uomTotals.map(({ unit, total }) => (
              <p key={unit} className="text-lg font-bold tabular-nums leading-tight">
                {formatQtyDisplay(total)} <span className="text-sm font-normal text-muted-foreground">{unit}</span>
              </p>
            ))}
          </div>
        </div>

        {/* Top product */}
        <div className="rounded-lg border border-border bg-card p-4 space-y-1">
          <p className="text-xs text-muted-foreground">Top product</p>
          <p className="text-sm font-semibold truncate" title={topProduct.name}>{topProduct.name}</p>
          <p className="text-xs text-muted-foreground tabular-nums">
            {formatQtyDisplay(parseFloat(topProduct.quantity) || 0)} {topProduct.unit ?? "unit"}
          </p>
        </div>

        {/* Last used */}
        <div className="rounded-lg border border-border bg-card p-4 space-y-1">
          <p className="text-xs text-muted-foreground">Last used in recipe</p>
          <p className="text-sm font-semibold">{formatRecipeDate(latestDate)}</p>
        </div>
      </div>
    </div>
  );
}

function ProductsTab({ baseItemId }: { baseItemId: number }) {
  const { data, isLoading, isError } = useGetBaseItemProducts(baseItemId);
  const [sortField, setSortField] = useState<SortField>("quantity");
  const [sortAsc, setSortAsc] = useState(false);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const allProducts: BaseItemProductLink[] = data?.products ?? [];

  const filtered = statusFilter === "all"
    ? allProducts
    : allProducts.filter((p) => p.status === statusFilter);

  const sorted = [...filtered].sort((a, b) => {
    let cmp = 0;
    if (sortField === "quantity") {
      cmp = parseFloat(a.quantity) - parseFloat(b.quantity);
    } else if (sortField === "name") {
      cmp = a.name.localeCompare(b.name);
    } else {
      cmp = new Date(a.recipe_updated_at).getTime() - new Date(b.recipe_updated_at).getTime();
    }
    return sortAsc ? cmp : -cmp;
  });

  function toggleSort(field: SortField) {
    if (sortField === field) {
      setSortAsc((v) => !v);
    } else {
      setSortField(field);
      setSortAsc(field === "name");
    }
  }

  const STATUS_FILTERS: { value: StatusFilter; label: string }[] = [
    { value: "all", label: "All" },
    { value: "available", label: "Available" },
    { value: "out_of_stock", label: "Out of Stock" },
    { value: "not_available", label: "Not Available" },
  ];

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
        <Loader2 size={14} className="animate-spin" />
        Loading products…
      </div>
    );
  }

  if (isError) {
    console.error("Failed to load base item products:", data);
    return (
      <div className="rounded-lg border border-dashed border-border p-10 text-center">
        <p className="font-medium text-sm text-destructive">Failed to load products</p>
        <p className="text-xs text-muted-foreground mt-1">Please refresh the page and try again.</p>
      </div>
    );
  }

  if (allProducts.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-10 text-center">
        <Package size={28} className="mx-auto mb-2 text-muted-foreground" />
        <p className="font-medium text-sm">This base item is not currently used in any product recipes</p>
        <p className="text-xs text-muted-foreground mt-1">
          When a product recipe includes this item, it will appear here with usage details.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Usage summary */}
      <UsageSummaryBlock products={allProducts} />

      {/* Controls row */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Status filter chips */}
        <div className="flex items-center gap-1 flex-wrap">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setStatusFilter(f.value)}
              className={`px-2.5 py-0.5 rounded-full text-xs font-medium border transition-colors ${
                statusFilter === f.value
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-transparent text-muted-foreground border-border hover:border-primary/50"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* Sort buttons */}
        <div className="flex items-center gap-1 ml-auto">
          <span className="text-xs text-muted-foreground mr-1">Sort:</span>
          {(["quantity", "name", "recipe_updated_at"] as SortField[]).map((field) => {
            const label = field === "quantity" ? "Qty" : field === "name" ? "Name" : "Updated";
            const active = sortField === field;
            return (
              <button
                key={field}
                type="button"
                onClick={() => toggleSort(field)}
                className={`px-2 py-0.5 rounded text-xs border transition-colors flex items-center gap-0.5 ${
                  active
                    ? "bg-muted border-border text-foreground"
                    : "bg-transparent border-transparent text-muted-foreground hover:border-border"
                }`}
              >
                {label}
                {active && (
                  <span className="text-[10px]">{sortAsc ? "↑" : "↓"}</span>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Product rows */}
      {sorted.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-8 text-center">
          <p className="text-sm text-muted-foreground">No products match the selected filter.</p>
        </div>
      ) : (
        <div className="rounded-lg border border-border divide-y divide-border">
          {sorted.map((product) => (
            <div key={product.id} className="flex items-center gap-3 px-4 py-3">
              {/* Image */}
              <div className="shrink-0 w-10 h-10 rounded-md overflow-hidden border border-border bg-muted flex items-center justify-center">
                {product.image_url ? (
                  <img
                    src={imageUrl(product.image_url) ?? product.image_url}
                    alt=""
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <Package size={18} className="text-muted-foreground" />
                )}
              </div>

              {/* Name + category */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <p className="font-medium text-sm truncate">{product.name}</p>
                  {product.brand_id && product.brand_logo_id && (
                    <WorkspaceImage
                      src={`/api/brands/${product.brand_id}/logos/${product.brand_logo_id}/image`}
                      alt=""
                      className="shrink-0 h-4 w-auto max-w-[48px] object-contain"
                    />
                  )}
                </div>
                <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                  {product.sku && (
                    <span className="text-xs text-muted-foreground font-mono">SKU: {product.sku}</span>
                  )}
                  {product.category && (
                    <span className="text-xs text-muted-foreground truncate">{product.category}</span>
                  )}
                  <span className="text-xs text-muted-foreground">
                    Updated {formatRecipeDate(product.recipe_updated_at)}
                  </span>
                </div>
              </div>

              {/* Quantity + unit */}
              <div className="shrink-0 text-right">
                {(() => {
                  const qty = parseFloat(product.quantity);
                  if (!product.quantity || isNaN(qty) || qty === 0) {
                    return <p className="text-sm text-muted-foreground italic">Not set</p>;
                  }
                  return (
                    <p className="text-sm font-semibold tabular-nums">
                      {formatQtyDisplay(qty)}{product.unit ? ` ${product.unit}` : ""}
                    </p>
                  );
                })()}
                <p className="text-[10px] text-muted-foreground">qty used</p>
              </div>

              {/* Status badge */}
              <div className="shrink-0">{statusBadge(product.status)}</div>

              {/* Actions */}
              <div className="shrink-0 flex items-center gap-1">
                <a
                  href={`/products/${product.id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs px-2 py-1 rounded border border-border hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                >
                  View Product
                </a>
                <a
                  href={`/products/${product.id}?tab=recipe`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs px-2 py-1 rounded border border-border hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                >
                  View Recipe
                </a>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


const ACTION_LABELS: Record<string, string> = {
  bulk_update_category: "Category updated",
  bulk_update_type: "Type updated",
  bulk_archive: "Archived",
  merge: "Merged",
  duplicate: "Duplicated",
};

function formatAuditDate(ts: string) {
  return new Date(ts).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function getCategoryName(id: number | null | undefined, categories: MainCategory[]): string {
  if (id == null) return "None";
  for (const main of categories) {
    if (main.id === id) return main.name;
    for (const sub of main.subcategories) {
      if (sub.id === id) return sub.name;
    }
  }
  return `#${id}`;
}

function AuditLogContext({
  entry,
  baseItemId,
  categories,
}: {
  entry: BaseItemAuditLogEntry;
  baseItemId: number;
  categories: MainCategory[];
}) {
  const prev = entry.previous_values ?? null;
  const next = entry.new_values ?? null;

  switch (entry.action) {
    case "bulk_update_category": {
      const prevCatId = prev ? (prev[String(baseItemId)] as number | null | undefined) : undefined;
      const newCatId = next ? (next.category_id as number | null | undefined) : undefined;
      const prevName = getCategoryName(prevCatId, categories);
      const newName = getCategoryName(newCatId, categories);
      return (
        <p className="text-xs text-muted-foreground mt-1">
          Category: <span className="font-medium text-foreground">{prevName}</span>
          {" → "}
          <span className="font-medium text-foreground">{newName}</span>
        </p>
      );
    }
    case "bulk_update_type": {
      const prevType = prev ? (prev[String(baseItemId)] as string | null | undefined) : undefined;
      const newType = next ? (next.type as string | null | undefined) : undefined;
      const prevLabel = prevType ?? "None";
      const newLabel = newType ?? "None";
      return (
        <p className="text-xs text-muted-foreground mt-1">
          Type: <span className="font-medium text-foreground">{prevLabel}</span>
          {" → "}
          <span className="font-medium text-foreground">{newLabel}</span>
        </p>
      );
    }
    case "merge": {
      const masterId = next ? (next.master_id as number | undefined) : undefined;
      const dups = prev ? (prev.duplicates as number[] | undefined) : undefined;
      const dupCount = dups?.length ?? 0;
      if (masterId != null) {
        return (
          <p className="text-xs text-muted-foreground mt-1">
            Merged {dupCount} item{dupCount !== 1 ? "s" : ""} into item{" "}
            <span className="font-medium text-foreground">#{masterId}</span>
          </p>
        );
      }
      return null;
    }
    case "duplicate": {
      const newId = next ? (next.new_id as number | undefined) : undefined;
      if (newId != null) {
        return (
          <p className="text-xs text-muted-foreground mt-1">
            New item <span className="font-medium text-foreground">#{newId}</span> created
          </p>
        );
      }
      return null;
    }
    default:
      return null;
  }
}

function formatInvoiceDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  } catch {
    return iso;
  }
}

function invoiceStatusBadge(status: string) {
  switch (status) {
    case "paid":
      return <Badge className="bg-green-100 text-green-800 border-green-200 text-xs font-medium">Paid</Badge>;
    case "issued":
      return <Badge className="bg-blue-100 text-blue-800 border-blue-200 text-xs font-medium">Issued</Badge>;
    case "cancelled":
      return <Badge className="bg-gray-100 text-gray-600 border-gray-200 text-xs font-medium">Cancelled</Badge>;
    default:
      return <Badge variant="outline" className="text-xs font-medium">{status}</Badge>;
  }
}

function InvoiceSpendTab({ baseItemId }: { baseItemId: number }) {
  const { data, isLoading } = useListBaseItemInvoices(baseItemId);
  const invoices: BaseItemInvoice[] = data?.invoices ?? [];
  const invoiceCount = data?.invoice_count ?? 0;
  const totalSpend = data ? parseFloat(data.total_spend) : 0;
  const spendYtd = data ? parseFloat(data.spend_ytd) : 0;

  const currencyDisplay = invoices[0]?.currency ?? "";

  function formatAmount(val: number, currency: string) {
    try {
      return val.toLocaleString(undefined, { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 });
    } catch {
      return `${currency} ${val.toFixed(2)}`;
    }
  }

  return (
    <div className="space-y-4">
      {/* Spend summary cards */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground mb-1">All-Time Spend</p>
          {isLoading ? (
            <div className="h-7 w-24 animate-pulse bg-muted rounded" />
          ) : (
            <p className="text-2xl font-bold tabular-nums">
              {currencyDisplay ? formatAmount(totalSpend, currencyDisplay) : totalSpend.toFixed(2)}
            </p>
          )}
          <p className="text-xs text-muted-foreground mt-1">
            {invoiceCount} invoice{invoiceCount !== 1 ? "s" : ""}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground mb-1">Year-to-Date Spend</p>
          {isLoading ? (
            <div className="h-7 w-24 animate-pulse bg-muted rounded" />
          ) : (
            <p className="text-2xl font-bold tabular-nums">
              {currencyDisplay ? formatAmount(spendYtd, currencyDisplay) : spendYtd.toFixed(2)}
            </p>
          )}
          <p className="text-xs text-muted-foreground mt-1">
            {new Date().getFullYear()} so far
          </p>
        </div>
      </div>

      {/* Invoice list */}
      <div className="rounded-lg border border-border bg-card">
        <div className="px-5 py-3 border-b border-border flex items-center gap-2">
          <Receipt size={14} className="text-muted-foreground" />
          <h3 className="text-sm font-semibold">Linked Invoices</h3>
          {invoiceCount > 0 && (
            <span className="ml-auto text-xs text-muted-foreground">{invoiceCount} invoice{invoiceCount !== 1 ? "s" : ""}</span>
          )}
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground p-5">
            <Loader2 size={14} className="animate-spin" />
            Loading invoices…
          </div>
        ) : invoices.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            No invoices linked to this base item yet.<br />
            <span className="text-xs mt-1 block">Link an invoice from the supplier's Invoices tab by selecting this item as the reference.</span>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {invoices.map((inv) => (
              <Link
                key={inv.id}
                href={`/suppliers/${inv.supplier_id}`}
                className="flex items-center gap-4 px-5 py-4 hover:bg-muted/50 transition-colors group"
              >
                <div className="shrink-0">
                  <Receipt size={14} className="text-muted-foreground group-hover:text-foreground transition-colors" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium truncate">
                      {inv.invoice_number ? `#${inv.invoice_number}` : `Invoice ${inv.id}`}
                    </span>
                    {invoiceStatusBadge(inv.status)}
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {inv.supplier_name} · {formatInvoiceDate(inv.issued_at)}
                  </p>
                  {inv.notes && (
                    <p className="text-xs text-muted-foreground mt-0.5 truncate">{inv.notes}</p>
                  )}
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-sm font-semibold tabular-nums">
                    {formatAmount(parseFloat(inv.amount), inv.currency)}
                  </p>
                  {inv.paid_at && (
                    <p className="text-xs text-muted-foreground mt-0.5">Paid {formatInvoiceDate(inv.paid_at)}</p>
                  )}
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AuditLogTab({ baseItemId }: { baseItemId: number }) {
  const [page, setPage] = useState(1);
  const limit = 25;

  const { data, isLoading } = useListBaseItemAuditLog(baseItemId, { page, limit });
  const entries: BaseItemAuditLogEntry[] = data?.entries ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / limit);

  const { data: categoriesData } = useQuery<{ categories: MainCategory[] }>({
    queryKey: ["base-item-categories"],
    queryFn: () => apiFetch("/api/base-item-categories"),
  });
  const categories = categoriesData?.categories ?? [];

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="px-5 py-3 border-b border-border flex items-center gap-2">
        <HistoryIcon size={14} className="text-muted-foreground" />
        <h3 className="text-sm font-semibold">Audit Log</h3>
        {total > 0 && (
          <span className="ml-auto text-xs text-muted-foreground">{total} event{total !== 1 ? "s" : ""}</span>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground p-5">
          <Loader2 size={14} className="animate-spin" />
          Loading history…
        </div>
      ) : entries.length === 0 ? (
        <div className="py-10 text-center text-sm text-muted-foreground">
          No audit log entries for this item yet.
        </div>
      ) : (
        <div className="divide-y divide-border">
          {entries.map((entry) => (
            <div key={entry.id} className="flex items-start gap-3 px-5 py-4">
              <div className="shrink-0 mt-0.5">
                <HistoryIcon size={14} className="text-muted-foreground" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium">
                    {ACTION_LABELS[entry.action] ?? entry.action.replace(/_/g, " ")}
                  </span>
                  {entry.affected_ids.length > 1 && (
                    <Badge variant="secondary" className="text-xs">
                      {entry.affected_ids.length} items
                    </Badge>
                  )}
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {entry.actor_name ?? "Unknown user"} · {formatAuditDate(entry.created_at)}
                </p>
                <AuditLogContext entry={entry} baseItemId={baseItemId} categories={categories} />
              </div>
            </div>
          ))}
        </div>
      )}

      {totalPages > 1 && (
        <div className="flex items-center justify-between px-5 py-3 border-t border-border">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page <= 1}
          >
            <ChevronLeft size={13} />
            Prev
          </Button>
          <span className="text-xs text-muted-foreground">
            Page {page} of {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
          >
            Next
            <ChevronRight size={13} />
          </Button>
        </div>
      )}
    </div>
  );
}

function ActiveLocationsPanel({ baseItemId }: { baseItemId: number }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { isOwner, allowedPages } = useWorkspaceRole();
  const canManage = isOwner || (allowedPages?.includes("base_items.manage") ?? false);

  const { data, isLoading } = useGetBaseItemLocationStatuses(baseItemId);
  const locationStatuses: BaseItemLocationStatus[] = data?.locationStatuses ?? [];

  const [pending, setPending] = useState<Set<number>>(new Set());
  const [errors, setErrors] = useState<Record<number, string>>({});

  const toggleMutation = usePatchBaseItemLocationStatus({
    mutation: {
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
        qc.invalidateQueries({ queryKey: getGetBaseItemLocationStatusesQueryKey(baseItemId) });
        qc.invalidateQueries({ queryKey: getGetBaseItemInventoryOverviewQueryKey(baseItemId) });
        qc.invalidateQueries({ queryKey: getListBaseItemAdjustmentsQueryKey(baseItemId) });
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
    },
  });

  // Group locations by country
  const byCountry = useMemo((): [string, BaseItemLocationStatus[]][] => {
    const map = new Map<string, BaseItemLocationStatus[]>();
    for (const ls of locationStatuses) {
      const c = ls.country || "";
      if (!map.has(c)) map.set(c, []);
      map.get(c)!.push(ls);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [locationStatuses]);

  const multipleCountries = byCountry.length > 1;

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="px-4 py-3 border-b border-border flex items-center gap-2">
        <MapPin size={14} className="text-muted-foreground" />
        <h3 className="text-sm font-semibold">Active Locations</h3>
      </div>
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground p-4">
          <Loader2 size={14} className="animate-spin" />
          Loading…
        </div>
      ) : locationStatuses.length === 0 ? (
        <div className="p-4 text-sm text-muted-foreground">
          No locations configured.
        </div>
      ) : (
        <div>
          {byCountry.map(([country, locs]) => (
            <div key={country}>
              {multipleCountries && (
                <div className="px-4 py-1.5 border-b border-border bg-muted/30 flex items-center gap-1.5">
                  <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    {country || "—"}
                  </span>
                </div>
              )}
              <div className="divide-y divide-border">
                {locs.map((ls) => {
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
                            toggleMutation.mutate({ id: baseItemId, locationId: ls.location_id, data: { isActive: checked } })
                          }
                          aria-label={`${ls.location_name} active`}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const VALID_BASE_ITEM_TABS = ["details", "packaging", "suppliers", "invoices", "inventory", "stock-movements", "products", "history"] as const;

export default function BaseItemDetailPage() {
  const { baseItemId: baseItemIdStr } = useParams<{ baseItemId: string }>();
  const baseItemId = parseInt(baseItemIdStr ?? "", 10);
  const search = useSearch();
  const tabParam = new URLSearchParams(search).get("tab");
  const initialTabRaw: string = tabParam && (VALID_BASE_ITEM_TABS as readonly string[]).includes(tabParam) ? tabParam : "details";

  const { isOwner, allowedPages } = useWorkspaceRole();
  const canManage = isOwner || (allowedPages?.includes("base_items.manage") ?? false);
  const canViewInventory =
    isOwner ||
    (allowedPages?.includes("base_items.view") ?? false) ||
    (allowedPages?.includes("base_items.manage") ?? false);

  const initialTab =
    (initialTabRaw === "inventory" || initialTabRaw === "stock-movements") && !canViewInventory
      ? "details"
      : initialTabRaw;

  const { data, isLoading, isError } = useGetBaseItem(baseItemId);
  const item = data?.item;

  const [isEditing, setIsEditing] = useState(false);

  const { data: categoriesData } = useQuery<{ categories: MainCategory[] }>({
    queryKey: ["base-item-categories"],
    queryFn: () => apiFetch("/api/base-item-categories"),
    enabled: canManage,
  });
  const categories = categoriesData?.categories ?? [];

  if (isNaN(baseItemId)) {
    return (
      <div className="space-y-4">
        <Link href="/base-items">
          <Button variant="ghost" size="sm" className="gap-1.5">
            <ArrowLeft size={14} />
            Back to Base Items
          </Button>
        </Link>
        <p className="text-sm text-destructive">Invalid base item ID.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/base-items">
          <Button variant="ghost" size="sm" className="gap-1.5">
            <ArrowLeft size={14} />
            Base Items
          </Button>
        </Link>
      </div>

      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 size={16} className="animate-spin" />
          Loading…
        </div>
      )}

      {isError && (
        <div className="rounded-lg border border-dashed border-border p-10 text-center">
          <FlaskConical size={28} className="mx-auto mb-2 text-muted-foreground" />
          <p className="font-medium text-sm">Base item not found</p>
          <p className="text-xs text-muted-foreground mt-1">
            This base item may have been deleted or you may not have access to it.
          </p>
        </div>
      )}

      {item && (
        <>
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="text-3xl font-bold tracking-tight">{item.name}</h1>
              <p className="text-muted-foreground text-sm mt-1 font-mono tracking-widest">{item.code}</p>
            </div>
            {canManage && !isEditing && (
              <Button
                variant="outline"
                size="sm"
                className="shrink-0"
                onClick={() => setIsEditing(true)}
                data-testid="button-edit-base-item"
              >
                <Pencil size={14} className="mr-1.5" />
                Edit
              </Button>
            )}
          </div>

          <div className="flex flex-col lg:flex-row gap-6 items-start">
            <div className="flex-1 min-w-0">
              <Tabs defaultValue={initialTab}>
                <TabsList className="flex flex-wrap h-auto gap-1 w-full justify-start">
                  <TabsTrigger value="details">Base Item Details</TabsTrigger>
                  <TabsTrigger value="packaging">Packaging</TabsTrigger>
                  <TabsTrigger value="suppliers">Suppliers</TabsTrigger>
                  <TabsTrigger value="invoices">Invoice Spend</TabsTrigger>
                  {canViewInventory && <TabsTrigger value="inventory">Inventory</TabsTrigger>}
                  {canViewInventory && <TabsTrigger value="stock-movements">Stock Movements</TabsTrigger>}
                  <TabsTrigger value="products">Products</TabsTrigger>
                  <TabsTrigger value="history">History</TabsTrigger>
                </TabsList>

                <TabsContent value="details" className="mt-4">
                  <div className="space-y-4">
                    <div className="rounded-lg border border-border bg-card p-5">
                      {isEditing ? (
                        <EditDetailsForm
                          item={item}
                          categories={categories}
                          onSaved={() => setIsEditing(false)}
                          onCancel={() => setIsEditing(false)}
                        />
                      ) : (
                        <BaseItemDetailsTab item={item} />
                      )}
                    </div>
                    {!isEditing && <UsageOverviewCards baseItemId={baseItemId} />}
                  </div>
                </TabsContent>

                <TabsContent value="packaging" className="mt-4">
                  <PackagingTab baseItemId={baseItemId} />
                </TabsContent>

                <TabsContent value="suppliers" className="mt-4">
                  <SuppliersTab baseItemId={baseItemId} />
                </TabsContent>

                <TabsContent value="invoices" className="mt-4">
                  <InvoiceSpendTab baseItemId={baseItemId} />
                </TabsContent>

                {canViewInventory && (
                  <TabsContent value="inventory" className="mt-4">
                    <InventoryTab item={item} />
                  </TabsContent>
                )}

                {canViewInventory && (
                  <TabsContent value="stock-movements" className="mt-4">
                    <StockMovementTab baseItemId={baseItemId} />
                  </TabsContent>
                )}

                <TabsContent value="products" className="mt-4">
                  <ProductsTab baseItemId={baseItemId} />
                </TabsContent>

                <TabsContent value="history" className="mt-4">
                  <AuditLogTab baseItemId={baseItemId} />
                </TabsContent>
              </Tabs>
            </div>

            <div className="w-full lg:w-72 shrink-0">
              <ActiveLocationsPanel baseItemId={baseItemId} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
