import { useState, useEffect, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { useListCatalogCategories } from "@workspace/api-client-react";
import { apiFetch } from "@/lib/queryClient";
import { imageUrl } from "@/lib/imageUrl";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Search, X, Pencil, AlertTriangle, ChevronLeft, ChevronRight } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

export type PickerProduct = {
  id: number;
  name: string;
  price_usd: string | null;
  sku: string;
  barcode: string | null;
  main_image_url: string | null;
  status: string;
  catalog_categories: { id: number; name: string }[];
};

type BranchProductsResponse = {
  products: PickerProduct[];
  total: number;
  page: number;
  limit: number;
};

type SelectionEntry = { product: PickerProduct; qty: number };

export type PickerLineItem = {
  product_id: number | null;
  productName: string;
  requested_qty: number;
  unit_price: string;
  notes: string;
  customMode: boolean;
  image_url?: string | null;
};

export interface BranchProductPickerModalProps {
  open: boolean;
  onClose: () => void;
  /** Display name for the source branch shown in the dialog title */
  sourceBranchName?: string;
  /** Existing line items to pre-populate selections when the modal opens */
  initialLineItems?: PickerLineItem[];
  onConfirm: (lineItems: PickerLineItem[]) => void;
  /** Called when "Add as custom item" is clicked — modal closes then this fires */
  onAddCustomItem?: () => void;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const PAGE_SIZE = 24;
/** Hard ceiling for any single product quantity in a branch request */
const MAX_QTY = 999;

// ── useDebounce ───────────────────────────────────────────────────────────────

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

// ── PickerQtyStepper ──────────────────────────────────────────────────────────
// qty = 0 means "not selected". Typing 0 or using − to go below 1 removes the
// item from the selection. Non-integer / negative values are silently ignored.

function PickerQtyStepper({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  const handleInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value.trim();
    if (raw === "" || raw === "0") { onChange(0); return; }
    // Reject anything that is not a plain positive integer (no decimals, no negatives)
    if (!/^\d+$/.test(raw)) return;
    const v = parseInt(raw, 10);
    if (!Number.isFinite(v) || v <= 0) return;
    onChange(Math.min(v, MAX_QTY));
  };

  return (
    <div
      className="flex items-center gap-1"
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        aria-label="Decrease quantity"
        className="h-7 w-7 rounded border text-lg leading-none flex items-center justify-center hover:bg-muted transition-colors"
        onClick={() => onChange(Math.max(0, value - 1))}
      >
        −
      </button>
      <input
        type="number"
        min={0}
        max={MAX_QTY}
        value={value === 0 ? "" : value}
        onChange={handleInput}
        aria-label="Quantity"
        placeholder="0"
        className="w-12 h-7 text-center text-sm font-medium border rounded bg-transparent focus:outline-none focus:ring-1 focus:ring-ring [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <button
        type="button"
        aria-label="Increase quantity"
        className="h-7 w-7 rounded border text-lg leading-none flex items-center justify-center hover:bg-muted transition-colors"
        onClick={() => onChange(Math.min(value + 1, MAX_QTY))}
      >
        +
      </button>
    </div>
  );
}

// ── BranchProductPickerModal ──────────────────────────────────────────────────

export function BranchProductPickerModal({
  open,
  onClose,
  sourceBranchName,
  initialLineItems = [],
  onConfirm,
  onAddCustomItem,
}: BranchProductPickerModalProps) {
  // ── Selection state ──────────────────────────────────────────────────────────
  const [selections, setSelections] = useState<Map<number, SelectionEntry>>(
    () => new Map(),
  );
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const debouncedSearch = useDebounce(search, 300);

  // Initialise / reset when the modal opens
  useEffect(() => {
    if (!open) return;
    const map = new Map<number, SelectionEntry>();
    for (const li of initialLineItems) {
      if (li.product_id !== null && !li.customMode && li.requested_qty > 0) {
        map.set(li.product_id, {
          product: {
            id: li.product_id,
            name: li.productName,
            sku: "",
            barcode: null,
            price_usd: li.unit_price || null,
            main_image_url: li.image_url ?? null,
            status: "active",
            catalog_categories: [],
          },
          qty: li.requested_qty,
        });
      }
    }
    setSelections(map);
    setActiveCategory(null);
    setSearch("");
    setPage(1);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Reset page when search/category changes
  useEffect(() => { setPage(1); }, [debouncedSearch, activeCategory]);

  // ── Catalog categories ────────────────────────────────────────────────────────
  const categoriesQ = useListCatalogCategories(
    { pageSize: 100 },
    { query: { enabled: open, queryKey: ["cmc-pos-picker-catalog-categories"] } },
  );
  const categories = categoriesQ.data?.items ?? [];

  // ── Products query ────────────────────────────────────────────────────────────
  const queryParams = new URLSearchParams();
  if (debouncedSearch) queryParams.set("q", debouncedSearch);
  if (activeCategory) queryParams.set("category", activeCategory);
  queryParams.set("page", String(page));
  queryParams.set("limit", String(PAGE_SIZE));

  const productsQ = useQuery<BranchProductsResponse>({
    queryKey: [
      "cmc-pos-branch-products-picker",
      debouncedSearch,
      activeCategory,
      page,
    ],
    queryFn: () =>
      apiFetch<BranchProductsResponse>(
        `/api/cmc-pos/branch-products?${queryParams.toString()}`,
        {},
      ),
    enabled: open,
  });

  const products = productsQ.data?.products ?? [];
  const total = productsQ.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // ── Selection helpers ─────────────────────────────────────────────────────────
  const setQty = useCallback((product: PickerProduct, qty: number) => {
    setSelections((prev) => {
      const next = new Map(prev);
      if (qty <= 0) {
        next.delete(product.id);
      } else {
        next.set(product.id, { product, qty });
      }
      return next;
    });
  }, []);

  const removeSelection = useCallback((productId: number) => {
    setSelections((prev) => {
      const next = new Map(prev);
      next.delete(productId);
      return next;
    });
  }, []);

  // ── Derived totals ────────────────────────────────────────────────────────────
  const totalSelected = selections.size;
  const totalUnits = Array.from(selections.values()).reduce(
    (s, e) => s + e.qty,
    0,
  );

  // ── Handlers ──────────────────────────────────────────────────────────────────
  const handleConfirm = () => {
    const lineItems: PickerLineItem[] = Array.from(selections.values()).map(
      ({ product, qty }) => ({
        product_id: product.id,
        productName: product.name,
        requested_qty: qty,
        unit_price: product.price_usd ?? "",
        notes: "",
        customMode: false,
        image_url: product.main_image_url,
      }),
    );
    onConfirm(lineItems);
  };

  const handleCustomItem = () => {
    onClose();
    onAddCustomItem?.();
  };

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent
        className="flex flex-col p-0 gap-0 overflow-hidden"
        style={{ maxWidth: "90vw", width: "90vw", height: "90vh" }}
      >
        {/* Header */}
        <DialogHeader className="px-5 py-4 border-b shrink-0">
          <DialogTitle className="text-base">
            Browse products
            {sourceBranchName ? ` — ${sourceBranchName}` : ""}
          </DialogTitle>
        </DialogHeader>

        {/* Three-column body */}
        <div className="flex flex-1 min-h-0 overflow-hidden">

          {/* ── Left: category nav ──────────────────────────────────────────── */}
          <nav
            className="w-52 shrink-0 border-r overflow-y-auto"
            aria-label="Product categories"
          >
            <ul className="py-2">
              <li>
                <button
                  type="button"
                  aria-current={activeCategory === null ? "true" : undefined}
                  onClick={() => setActiveCategory(null)}
                  className={`w-full text-left px-4 py-2 text-sm transition-colors hover:bg-muted/60 ${
                    activeCategory === null ? "bg-muted font-medium" : ""
                  }`}
                >
                  All products
                </button>
              </li>
              {categoriesQ.isLoading && (
                <li className="px-4 py-2 space-y-2">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-4 w-28" />
                </li>
              )}
              {categories.map((cat) => (
                <li key={cat.id}>
                  <button
                    type="button"
                    aria-current={
                      activeCategory === cat.name ? "true" : undefined
                    }
                    onClick={() => setActiveCategory(cat.name)}
                    className={`w-full text-left px-4 py-2 text-sm transition-colors hover:bg-muted/60 ${
                      activeCategory === cat.name ? "bg-muted font-medium" : ""
                    }`}
                  >
                    <span className="block truncate">{cat.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {cat.product_count}{" "}
                      {cat.product_count === 1 ? "product" : "products"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </nav>

          {/* ── Centre: product list ─────────────────────────────────────────── */}
          <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
            {/* Search */}
            <div className="px-4 py-3 border-b shrink-0">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
                <Input
                  placeholder="Search by name, SKU, or barcode…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-9 h-9"
                  aria-label="Search products"
                />
              </div>
            </div>

            {/* Product rows */}
            <div className="flex-1 overflow-y-auto">
              {productsQ.isLoading && (
                <div className="p-4 space-y-3" aria-label="Loading products">
                  {Array.from({ length: 6 }).map((_, i) => (
                    <div key={i} className="flex items-center gap-3">
                      <Skeleton className="h-10 w-10 rounded" />
                      <div className="flex-1 space-y-1">
                        <Skeleton className="h-4 w-48" />
                        <Skeleton className="h-3 w-24" />
                      </div>
                      <Skeleton className="h-7 w-28" />
                    </div>
                  ))}
                </div>
              )}

              {productsQ.isError && !productsQ.isLoading && (
                <div className="p-8 text-center">
                  <AlertTriangle className="mx-auto h-8 w-8 text-muted-foreground mb-2" />
                  <p className="text-sm text-muted-foreground mb-3">
                    Failed to load products
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => productsQ.refetch()}
                  >
                    Retry
                  </Button>
                </div>
              )}

              {!productsQ.isLoading &&
                !productsQ.isError &&
                products.length === 0 && (
                  <div className="p-8 text-center">
                    <p className="text-sm text-muted-foreground">
                      {debouncedSearch
                        ? `No products match "${debouncedSearch}"`
                        : activeCategory
                        ? `No products in "${activeCategory}"`
                        : "No products available"}
                    </p>
                  </div>
                )}

              {!productsQ.isLoading &&
                !productsQ.isError &&
                products.length > 0 && (
                  <div className="divide-y" role="list" aria-label="Products">
                    {products.map((product) => {
                      const entry = selections.get(product.id);
                      const qty = entry?.qty ?? 0;
                      const thumb = imageUrl(product.main_image_url);
                      return (
                        <div
                          key={product.id}
                          role="listitem"
                          className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors"
                        >
                          {thumb ? (
                            <img
                              src={thumb}
                              alt=""
                              className="h-10 w-10 rounded object-cover border shrink-0"
                            />
                          ) : (
                            <div
                              className="h-10 w-10 rounded border bg-muted shrink-0"
                              aria-hidden="true"
                            />
                          )}

                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">
                              {product.name}
                            </p>
                            {product.sku && (
                              <p className="text-xs text-muted-foreground truncate">
                                {product.sku}
                              </p>
                            )}
                          </div>

                          <PickerQtyStepper
                            value={qty}
                            onChange={(v) => setQty(product, v)}
                          />
                        </div>
                      );
                    })}
                  </div>
                )}
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="shrink-0 border-t px-4 py-2 flex items-center justify-between text-sm text-muted-foreground">
                <span>
                  Page {page} of {totalPages}
                </span>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    aria-label="Previous page"
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={page >= totalPages}
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    aria-label="Next page"
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}
          </div>

          {/* ── Right: selected products panel ──────────────────────────────── */}
          <aside className="w-72 shrink-0 border-l flex flex-col overflow-hidden">
            <div className="px-4 py-3 border-b shrink-0">
              <p className="text-sm font-medium">
                Selected
                {totalSelected > 0 ? ` (${totalSelected})` : ""}
              </p>
            </div>

            <div className="flex-1 overflow-y-auto">
              {totalSelected === 0 && (
                <p className="px-4 py-6 text-sm text-muted-foreground text-center">
                  No products selected yet
                </p>
              )}
              <div className="divide-y" role="list" aria-label="Selected products">
                {Array.from(selections.values()).map(({ product, qty }) => {
                  const thumb = imageUrl(product.main_image_url);
                  return (
                    <div
                      key={product.id}
                      role="listitem"
                      className="flex items-start gap-2 px-3 py-3"
                    >
                      {thumb ? (
                        <img
                          src={thumb}
                          alt=""
                          className="h-8 w-8 rounded object-cover border shrink-0 mt-0.5"
                        />
                      ) : (
                        <div
                          className="h-8 w-8 rounded border bg-muted shrink-0 mt-0.5"
                          aria-hidden="true"
                        />
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium truncate">
                          {product.name}
                        </p>
                        {product.sku && (
                          <p className="text-[10px] text-muted-foreground truncate">
                            {product.sku}
                          </p>
                        )}
                        <div className="mt-1.5">
                          <PickerQtyStepper
                            value={qty}
                            onChange={(v) => setQty(product, v)}
                          />
                        </div>
                      </div>
                      <button
                        type="button"
                        aria-label={`Remove ${product.name}`}
                        className="shrink-0 mt-0.5 text-muted-foreground hover:text-destructive transition-colors"
                        onClick={() => removeSelection(product.id)}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>

            {totalSelected > 0 && (
              <div className="shrink-0 border-t px-3 py-2 text-xs text-muted-foreground">
                {totalUnits} {totalUnits === 1 ? "unit" : "units"} total
              </div>
            )}
          </aside>
        </div>

        {/* Footer */}
        <DialogFooter className="px-5 py-3 border-t shrink-0 flex-row items-center justify-between gap-2">
          <div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground gap-1.5"
              onClick={handleCustomItem}
            >
              <Pencil className="h-3.5 w-3.5" />
              Add as custom item
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={totalSelected === 0}
              className="bg-teal-800 hover:bg-teal-900 text-white disabled:opacity-50"
              onClick={handleConfirm}
            >
              Add {totalSelected}{" "}
              {totalSelected === 1 ? "product" : "products"} · {totalUnits}{" "}
              {totalUnits === 1 ? "unit" : "units"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
