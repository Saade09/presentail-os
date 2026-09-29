import { useState, useRef, useId } from "react";
import {
  Search,
  Plus,
  X,
  Minus,
  Package,
  AlertTriangle,
  ImageIcon,
  Loader2,
  MapPin,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useCmcActiveShift,
  useWorkspaceLocations,
  useCmcShelfProducts,
  RETURN_REASONS,
} from "@/hooks/useCmcReturns";
import type { ReturnReason, EligibleProduct } from "@/hooks/useCmcReturns";
import { useReturnsContext } from "./CmcPosReturnsContext";
import type { DraftLineItem } from "./CmcPosReturnsContext";
import { apiFetch } from "@/lib/queryClient";

// ── Location selector section ─────────────────────────────────────────────────

function LocationSection() {
  const { draft, updateDetails } = useReturnsContext();
  const { branch_location_id, return_to_location_id } = draft.details;

  const { data: shiftData, isLoading: shiftLoading } = useCmcActiveShift();
  const { data: locationsData } = useWorkspaceLocations();

  const locations = locationsData?.locations ?? [];

  // Auto-fill branch from active shift when it first loads
  const activeShift = shiftData?.shift;
  if (
    activeShift &&
    branch_location_id === null &&
    !shiftLoading
  ) {
    // Use a timeout to avoid setState-during-render
    setTimeout(() =>
      updateDetails({ branch_location_id: activeShift.location_id }),
    0);
  }

  const branchLocationName =
    activeShift?.location_id === branch_location_id
      ? activeShift.location_name
      : locations.find((l) => l.id === branch_location_id)?.name ?? null;

  return (
    <div className="rounded-lg border bg-muted/20 p-4 space-y-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <MapPin className="h-4 w-4 text-teal-700" />
        Locations
      </div>

      {/* Branch location */}
      <div className="space-y-1.5">
        <Label className="text-xs">Your branch</Label>
        {activeShift ? (
          <div className="flex items-center gap-2 rounded-md border bg-card px-3 py-2 text-sm">
            <span className="font-medium">{activeShift.location_name}</span>
            <Badge variant="outline" className="text-xs bg-teal-50 text-teal-700 border-teal-200 ml-auto">
              Active shift
            </Badge>
          </div>
        ) : (
          <Select
            value={branch_location_id?.toString() ?? ""}
            onValueChange={(v) =>
              updateDetails({ branch_location_id: parseInt(v) })
            }
          >
            <SelectTrigger
              className="h-9"
              aria-label="Select your branch location"
            >
              <SelectValue
                placeholder={
                  shiftLoading ? "Loading…" : "Select your branch…"
                }
              />
            </SelectTrigger>
            <SelectContent>
              {locations.map((l) => (
                <SelectItem key={l.id} value={l.id.toString()}>
                  {l.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Return-to location */}
      <div className="space-y-1.5">
        <Label className="text-xs">
          Return destination{" "}
          <span className="text-destructive">*</span>
        </Label>
        <Select
          value={return_to_location_id?.toString() ?? ""}
          onValueChange={(v) =>
            updateDetails({ return_to_location_id: parseInt(v) })
          }
        >
          <SelectTrigger
            className="h-9"
            aria-label="Select return destination location"
          >
            <SelectValue placeholder="Select where to return items…" />
          </SelectTrigger>
          <SelectContent>
            {locations
              .filter((l) => l.id !== branch_location_id)
              .map((l) => (
                <SelectItem key={l.id} value={l.id.toString()}>
                  {l.name}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Select the CMC distribution or receiving location.
        </p>
      </div>
    </div>
  );
}

// ── Custom item form ───────────────────────────────────────────────────────────

function CustomItemForm({ onAdd }: { onAdd: () => void }) {
  const { addLine } = useReturnsContext();
  const [desc, setDesc] = useState("");
  const [reason, setReason] = useState<ReturnReason>("damaged");
  const [qty, setQty] = useState(1);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const descId = useId();

  const handleImageChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      setUploadError("File must be under 10 MB");
      return;
    }
    setUploading(true);
    setUploadError(null);
    try {
      const fd = new FormData();
      fd.append("photo", file);
      const res = await apiFetch<{ url: string }>(
        "/api/cmc-pos/returns/upload-photo",
        { method: "POST", body: fd },
      );
      setImageUrl(res.url);
    } catch {
      setUploadError("Upload failed — please try again");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const handleAdd = () => {
    if (!desc.trim()) return;
    addLine({
      product_id: null,
      name_snapshot: desc.trim(),
      sku_snapshot: null,
      image_url: imageUrl,
      quantity: qty,
      reason,
      available_stock: 9999,
      is_custom: true,
    });
    setDesc("");
    setReason("damaged");
    setQty(1);
    setImageUrl(null);
    onAdd();
  };

  return (
    <div className="rounded-lg border border-dashed border-border p-4 bg-muted/20 space-y-3">
      <p className="text-sm font-medium">Add custom item</p>
      <div className="space-y-1.5">
        <Label htmlFor={descId}>Description</Label>
        <Input
          id={descId}
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder="Describe the item…"
          maxLength={200}
          aria-required="true"
        />
      </div>

      <div className="flex gap-2 items-end">
        <div className="flex-1 space-y-1.5">
          <Label>Reason</Label>
          <Select
            value={reason}
            onValueChange={(v) => setReason(v as ReturnReason)}
          >
            <SelectTrigger aria-label="Return reason">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RETURN_REASONS.map((r) => (
                <SelectItem key={r.value} value={r.value}>
                  {r.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label>Qty</Label>
          <div className="flex items-center gap-1">
            <Button
              type="button"
              size="icon"
              variant="outline"
              className="h-9 w-9"
              onClick={() => setQty((q) => Math.max(1, q - 1))}
              aria-label="Decrease quantity"
            >
              <Minus className="h-3.5 w-3.5" />
            </Button>
            <Input
              type="number"
              min={1}
              value={qty}
              onChange={(e) =>
                setQty(Math.max(1, parseInt(e.target.value) || 1))
              }
              className="w-14 text-center h-9"
              aria-label="Quantity"
            />
            <Button
              type="button"
              size="icon"
              variant="outline"
              className="h-9 w-9"
              onClick={() => setQty((q) => q + 1)}
              aria-label="Increase quantity"
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>

      {/* Photo upload */}
      <div className="space-y-1">
        <Label className="text-xs text-muted-foreground">
          Photo (optional)
        </Label>
        {imageUrl ? (
          <div className="flex items-center gap-2">
            <img
              src={imageUrl}
              alt="Custom item"
              className="h-10 w-10 rounded border object-cover"
            />
            <button
              type="button"
              className="text-xs text-destructive hover:underline"
              onClick={() => setImageUrl(null)}
            >
              Remove
            </button>
          </div>
        ) : (
          <div>
            <input
              ref={fileRef}
              type="file"
              accept=".jpg,.jpeg,.png"
              className="hidden"
              id="custom-item-photo"
              onChange={handleImageChange}
              aria-label="Upload custom item photo"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 text-xs gap-1.5"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
            >
              {uploading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ImageIcon className="h-3.5 w-3.5" />
              )}
              {uploading ? "Uploading…" : "Upload photo"}
            </Button>
            {uploadError && (
              <p className="text-xs text-destructive mt-1">{uploadError}</p>
            )}
          </div>
        )}
      </div>

      <Button
        type="button"
        size="sm"
        className="bg-teal-700 hover:bg-teal-800 text-white"
        disabled={!desc.trim()}
        onClick={handleAdd}
      >
        <Plus className="h-3.5 w-3.5 mr-1" />
        Add item
      </Button>
    </div>
  );
}

// ── Product search ─────────────────────────────────────────────────────────────

function ProductSearch({
  locationId,
  onSelect,
  selectedIds,
}: {
  locationId: number | null;
  onSelect: (product: EligibleProduct) => void;
  selectedIds: Set<number>;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();

  const { data: products, isLoading } = useCmcShelfProducts(locationId, query);

  return (
    <div className="relative">
      <Label htmlFor={inputId} className="sr-only">
        Search CMC products
      </Label>
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
        <Input
          ref={inputRef}
          id={inputId}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          placeholder={
            locationId
              ? "Search by name or SKU…"
              : "Select a branch location above first"
          }
          className="pl-8"
          disabled={!locationId}
          aria-label="Search CMC products"
          aria-autocomplete="list"
          aria-expanded={open}
          role="combobox"
        />
        {isLoading && query && (
          <Loader2 className="absolute right-2.5 top-1/2 -translate-y-1/2 h-4 w-4 animate-spin text-muted-foreground" />
        )}
      </div>

      {open && query.length > 0 && locationId && (
        <div
          className="absolute z-20 left-0 right-0 mt-1 rounded-lg border bg-card shadow-md max-h-60 overflow-y-auto"
          role="listbox"
          aria-label="Product search results"
        >
          {(!products || products.length === 0) && !isLoading && (
            <div className="py-6 text-center text-sm text-muted-foreground">
              No products found
            </div>
          )}
          {(products ?? []).map((p) => {
            const alreadyAdded = selectedIds.has(p.id);
            return (
              <button
                key={p.id}
                type="button"
                role="option"
                aria-selected={alreadyAdded}
                className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-muted/50 text-left transition-colors disabled:opacity-50"
                disabled={alreadyAdded}
                onClick={() => {
                  onSelect(p);
                  setQuery("");
                  setOpen(false);
                  inputRef.current?.focus();
                }}
              >
                {p.image_url ? (
                  <img
                    src={p.image_url}
                    alt=""
                    className="h-8 w-8 rounded border object-cover shrink-0"
                  />
                ) : (
                  <div className="h-8 w-8 rounded border bg-muted shrink-0 flex items-center justify-center">
                    <Package className="h-4 w-4 text-muted-foreground opacity-40" />
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{p.name}</p>
                  {p.sku && (
                    <p className="text-xs text-muted-foreground">{p.sku}</p>
                  )}
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-xs text-muted-foreground">
                    {p.available_stock} in stock
                  </p>
                  {alreadyAdded && (
                    <p className="text-xs text-teal-700 font-medium">Added</p>
                  )}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Line row ───────────────────────────────────────────────────────────────────

function LineRow({ line }: { line: DraftLineItem }) {
  const { updateLine, removeLine } = useReturnsContext();
  const qtyId = useId();

  const maxQty = line.is_custom ? 9999 : line.available_stock;

  return (
    <tr className="border-b last:border-0">
      <td className="py-3 px-3">
        <div className="flex items-center gap-2">
          {line.image_url ? (
            <img
              src={line.image_url}
              alt=""
              className="h-8 w-8 rounded border object-cover shrink-0"
            />
          ) : (
            <div className="h-8 w-8 rounded border bg-muted shrink-0 flex items-center justify-center">
              <Package className="h-4 w-4 text-muted-foreground opacity-40" />
            </div>
          )}
          <div className="min-w-0">
            <p className="text-sm font-medium truncate max-w-[160px]">
              {line.name_snapshot}
            </p>
            {line.sku_snapshot && (
              <p className="text-xs text-muted-foreground">
                {line.sku_snapshot}
              </p>
            )}
            {line.is_custom && (
              <Badge
                variant="outline"
                className="text-xs bg-purple-50 text-purple-700 border-purple-200 mt-0.5"
              >
                Custom
              </Badge>
            )}
          </div>
        </div>
      </td>

      {!line.is_custom ? (
        <td className="py-3 px-3 text-center">
          <span className="text-xs text-muted-foreground">
            {line.available_stock}
          </span>
        </td>
      ) : (
        <td className="py-3 px-3" />
      )}

      <td className="py-3 px-3">
        <div className="flex items-center gap-1 justify-center">
          <Button
            type="button"
            size="icon"
            variant="outline"
            className="h-7 w-7"
            onClick={() =>
              updateLine(line.draftId, {
                quantity: Math.max(1, line.quantity - 1),
              })
            }
            aria-label="Decrease quantity"
          >
            <Minus className="h-3 w-3" />
          </Button>
          <Input
            id={qtyId}
            type="number"
            min={1}
            max={maxQty}
            value={line.quantity}
            onChange={(e) => {
              const v = parseInt(e.target.value) || 1;
              updateLine(line.draftId, {
                quantity: Math.min(maxQty, Math.max(1, v)),
              });
            }}
            className="w-12 text-center h-7 text-sm px-1"
            aria-label={`Quantity for ${line.name_snapshot}`}
          />
          <Button
            type="button"
            size="icon"
            variant="outline"
            className="h-7 w-7"
            onClick={() =>
              updateLine(line.draftId, {
                quantity: Math.min(maxQty, line.quantity + 1),
              })
            }
            aria-label="Increase quantity"
          >
            <Plus className="h-3 w-3" />
          </Button>
        </div>
        {!line.is_custom && line.quantity > line.available_stock && (
          <p className="text-xs text-destructive mt-0.5 text-center">
            Exceeds stock
          </p>
        )}
      </td>

      <td className="py-3 px-3">
        <Select
          value={line.reason}
          onValueChange={(v) =>
            updateLine(line.draftId, { reason: v as ReturnReason })
          }
        >
          <SelectTrigger
            className="h-8 text-xs w-36"
            aria-label={`Return reason for ${line.name_snapshot}`}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RETURN_REASONS.map((r) => (
              <SelectItem key={r.value} value={r.value} className="text-xs">
                {r.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </td>

      <td className="py-3 px-3">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground hover:text-destructive"
          onClick={() => removeLine(line.draftId)}
          aria-label={`Remove ${line.name_snapshot}`}
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </td>
    </tr>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

export default function CmcPosReturnsStep1() {
  const { draft, addLine, setStep } = useReturnsContext();
  const [showCustomForm, setShowCustomForm] = useState(false);

  const { branch_location_id, return_to_location_id } = draft.details;
  const lines = draft.lines;

  const selectedProductIds = new Set(
    lines.filter((l) => l.product_id !== null).map((l) => l.product_id!),
  );

  const totalUnits = lines.reduce((s, l) => s + l.quantity, 0);

  const hasInvalid = lines.some(
    (l) => !l.is_custom && l.quantity > l.available_stock,
  );

  const locationsReady =
    branch_location_id !== null && return_to_location_id !== null;
  const canContinue = locationsReady && lines.length > 0 && !hasInvalid;

  const handleSelectProduct = (p: EligibleProduct) => {
    addLine({
      product_id: p.id,
      name_snapshot: p.name,
      sku_snapshot: p.sku,
      image_url: p.image_url,
      quantity: 1,
      reason: "damaged",
      available_stock: p.available_stock,
      is_custom: false,
    });
  };

  return (
    <div className="flex flex-col gap-5">
      {/* Step header */}
      <div>
        <h2
          className="text-base font-semibold"
          tabIndex={-1}
          id="step1-heading"
        >
          Step 1 of 3 — Select products to return
        </h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          Confirm your branch and return destination, then search for CMC
          catalogue products or add a custom item.
        </p>
      </div>

      {/* Location section */}
      <LocationSection />

      {/* Search */}
      <ProductSearch
        locationId={branch_location_id}
        onSelect={handleSelectProduct}
        selectedIds={selectedProductIds}
      />

      {/* Lines table */}
      {lines.length > 0 ? (
        <div className="rounded-lg border overflow-hidden">
          <table className="w-full" aria-label="Selected return items">
            <thead>
              <tr className="border-b bg-muted/20">
                <th className="text-left py-2 px-3 text-xs font-medium text-muted-foreground">
                  Product
                </th>
                <th className="text-center py-2 px-3 text-xs font-medium text-muted-foreground">
                  In stock
                </th>
                <th className="text-center py-2 px-3 text-xs font-medium text-muted-foreground">
                  Quantity
                </th>
                <th className="text-left py-2 px-3 text-xs font-medium text-muted-foreground">
                  Reason
                </th>
                <th className="py-2 px-3 w-8" />
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <LineRow key={line.draftId} line={line} />
              ))}
            </tbody>
          </table>
          <div className="px-3 py-2.5 border-t bg-muted/10 flex items-center gap-2 text-xs text-muted-foreground">
            <span>
              {lines.length} product{lines.length !== 1 ? "s" : ""} ·{" "}
              {totalUnits} unit{totalUnits !== 1 ? "s" : ""} total
            </span>
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-dashed py-10 text-center">
          <Package className="h-8 w-8 text-muted-foreground mx-auto mb-2 opacity-40" />
          <p className="text-sm text-muted-foreground">
            {locationsReady
              ? "No items added yet. Search above or add a custom item."
              : "Select both locations above to start adding products."}
          </p>
        </div>
      )}

      {/* Add custom item */}
      {locationsReady && (
        <>
          {!showCustomForm ? (
            <button
              type="button"
              className="flex items-center gap-1.5 text-sm text-teal-700 hover:underline font-medium self-start"
              onClick={() => setShowCustomForm(true)}
            >
              <Plus className="h-4 w-4" />
              Add custom item
            </button>
          ) : (
            <CustomItemForm onAdd={() => setShowCustomForm(false)} />
          )}
        </>
      )}

      {hasInvalid && (
        <div className="flex items-start gap-2 rounded-md bg-amber-50 border border-amber-200 px-3 py-2.5 text-sm text-amber-800">
          <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
          <span>
            One or more quantities exceed available stock. Please adjust before
            continuing.
          </span>
        </div>
      )}

      {/* Actions */}
      <div className="flex justify-end pt-2">
        <Button
          className="bg-teal-700 hover:bg-teal-800 text-white"
          disabled={!canContinue}
          onClick={() => setStep(1)}
          aria-label="Continue to step 2"
        >
          Continue
        </Button>
      </div>
    </div>
  );
}
