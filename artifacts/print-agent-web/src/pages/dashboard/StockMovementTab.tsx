import { useState, useCallback, useEffect, useRef, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useGetBaseItemLocationStatuses, getGetBaseItemLocationStatusesQueryKey } from "@workspace/api-client-react";
import { apiFetch, getClerkToken } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Loader2,
  ChevronLeft,
  ChevronRight,
  ArrowDownRight,
  ArrowUpRight,
  Minus,
  Download,
  Search,
  X,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  BookOpen,
} from "lucide-react";
import { format } from "date-fns";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface StockMovementRow {
  id: number;
  created_at: string;
  quantity_change: string;
  running_balance: string;
  reason: string;
  note: string | null;
  movement_type: string | null;
  location_id: number | null;
  location_name: string | null;
  created_by_user_id: string | null;
  source_display_name: string | null;
  order_id: string | null;
  order_line_item_id: string | null;
  product_id: number | null;
  product_name: string | null;
  purchase_order_id: number | null;
  transfer_id: number | null;
  reversal_of_id: number | null;
  recipe_snapshot: Record<string, unknown> | null;
  cutover_baseline: boolean;
  idempotency_key: string | null;
  reference_label: string | null;
  display_order_number: string | null;
  po_label: string | null;
  transfer_label: string | null;
  reference_type?: string | null;
  reference_id?: string | null;
  reference_label_snapshot?: string | null;
  metadata_snapshot?: Record<string, unknown> | null;
}

interface StockMovementSummary {
  openingBalance: number;
  received: number;
  consumed: number;
  closingBalance: number;
}

interface StockMovementsResponse {
  movements: StockMovementRow[];
  total: number;
  page: number;
  limit: number;
  summary: StockMovementSummary;
}

interface LocationStatusWithCountry {
  location_id: number;
  location_name: string;
  country?: string | null;
}

interface Props {
  baseItemId: number;
  locationStatuses?: LocationStatusWithCountry[];
  countries?: string[];
}

type SortField = "date" | "type" | "reference" | "location" | "change" | "balance";
type SortDirection = "asc" | "desc";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Full OPERATIONAL_MOVEMENT_TYPES taxonomy + legacy aliases
const MOVEMENT_TYPES = [
  { value: "opening_balance",            label: "Opening Balance" },
  { value: "purchase_order_receipt",     label: "Purchase Order Receipt" },
  { value: "product_consumption",        label: "Consumption" },
  { value: "transfer_in",               label: "Transfer In" },
  { value: "transfer_out",              label: "Transfer Out" },
  { value: "waste_damage",              label: "Waste / Damage" },
  { value: "manual_adjustment",         label: "Manual Adjustment" },
  { value: "customer_return",           label: "Customer Return" },
  { value: "supplier_return",           label: "Supplier Return" },
  { value: "order_cancellation",        label: "Order Cancellation" },
  { value: "inventory_count_correction",label: "Inventory Count Correction" },
  { value: "reversal",                  label: "Reversal" },
  { value: "cmc_return",               label: "CMC Return" },
  { value: "cmc_return_reversal",       label: "CMC Return Reversal" },
  // Legacy aliases kept for backwards-compat display
  { value: "receive",                   label: "Purchase Received (legacy)" },
  { value: "wastage",                   label: "Wastage (legacy)" },
  { value: "cutover_baseline",          label: "Cutover Baseline" },
] as const;

const PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDefaultDates(): { from: string; to: string } {
  const now = new Date();
  const to = formatLocalDate(now);
  const from30 = new Date(now);
  from30.setDate(from30.getDate() - 30);
  const from = formatLocalDate(from30);
  return { from, to };
}

function formatLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function movementTypeBadge(type: string | null): {
  label: string;
  variant: "default" | "secondary" | "destructive" | "outline";
} {
  switch (type) {
    case "opening_balance":
      return { label: "Opening Balance", variant: "outline" };
    case "purchase_order_receipt":
    case "receive":
      return { label: "Purchase Receipt", variant: "default" };
    case "product_consumption":
      return { label: "Consumption", variant: "destructive" };
    case "transfer_in":
      return { label: "Transfer In", variant: "default" };
    case "transfer_out":
      return { label: "Transfer Out", variant: "destructive" };
    case "waste_damage":
    case "wastage":
      return { label: "Waste / Damage", variant: "destructive" };
    case "manual_adjustment":
      return { label: "Manual Adjustment", variant: "outline" };
    case "customer_return":
      return { label: "Customer Return", variant: "secondary" };
    case "supplier_return":
      return { label: "Supplier Return", variant: "secondary" };
    case "order_cancellation":
      return { label: "Order Cancellation", variant: "secondary" };
    case "inventory_count_correction":
      return { label: "Count Correction", variant: "outline" };
    case "reversal":
      return { label: "Reversal", variant: "secondary" };
    case "cmc_return":
      return { label: "CMC Return", variant: "secondary" };
    case "cmc_return_reversal":
      return { label: "CMC Return Reversal", variant: "secondary" };
    case "cutover_baseline":
      return { label: "Cutover Baseline", variant: "outline" };
    default:
      return { label: type ?? "Unknown", variant: "outline" };
  }
}

function apiSortField(field: SortField): "date" | "type" | "reference" | "location" | "quantity" | "balance" {
  return field === "change" ? "quantity" : field;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SummaryCard({
  label,
  value,
  positive,
}: {
  label: string;
  value: number;
  positive?: boolean;
}) {
  const color =
    positive === undefined
      ? "text-foreground"
      : positive
      ? "text-emerald-600"
      : "text-red-500";
  return (
    <div className="rounded-lg border border-border bg-card p-3 flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={`text-base font-semibold font-mono ${color}`}>
        {value >= 0 ? "" : "−"}
        {Math.abs(value).toFixed(2)}
      </span>
    </div>
  );
}

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

// ---------------------------------------------------------------------------
// Sort header button
// ---------------------------------------------------------------------------

function SortHeader({
  field,
  label,
  sortBy,
  sortDir,
  onSort,
  align = "start",
}: {
  field: SortField;
  label: string;
  sortBy: SortField;
  sortDir: SortDirection;
  onSort: (f: SortField) => void;
  align?: "start" | "end";
}) {
  const active = sortBy === field;
  return (
    <button
      type="button"
      onClick={() => onSort(field)}
      className={`flex items-center gap-1 font-medium text-muted-foreground hover:text-foreground whitespace-nowrap ${align === "end" ? "ms-auto" : ""}`}
      aria-label={`Sort by ${label}`}
      aria-sort={active ? (sortDir === "asc" ? "ascending" : "descending") : undefined}
      data-testid={`sort-${field}`}
    >
      {label}
      {active ? (
        sortDir === "asc" ? (
          <ArrowUp size={12} className="text-primary" />
        ) : (
          <ArrowDown size={12} className="text-primary" />
        )
      ) : (
        <ArrowUpDown size={12} className="opacity-40" />
      )}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Recipe snapshot dialog
// ---------------------------------------------------------------------------

function RecipeSnapshotDialog({
  snapshot,
  open,
  onClose,
}: {
  snapshot: Record<string, unknown> | null;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();

  function renderValue(v: unknown, depth = 0): string {
    if (v === null || v === undefined) return "—";
    if (typeof v === "object" && !Array.isArray(v)) {
      if (depth > 3) return JSON.stringify(v);
      return Object.entries(v as Record<string, unknown>)
        .map(([k, val]) => `${k}: ${renderValue(val, depth + 1)}`)
        .join(", ");
    }
    if (Array.isArray(v)) {
      return v.map((item) => renderValue(item, depth + 1)).join("; ");
    }
    return String(v);
  }

  const rows = useMemo(() => {
    if (!snapshot) return [];
    return Object.entries(snapshot).map(([key, value]) => ({
      key,
      display: renderValue(value),
    }));
  }, [snapshot]);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto" data-testid="recipe-snapshot-dialog">
        <DialogHeader>
          <DialogTitle>
            {t("stockMovements.recipeSnapshotTitle", "Recipe Snapshot (Historical)")}
          </DialogTitle>
          <DialogDescription>
            {t(
              "stockMovements.recipeSnapshotDesc",
              "This is an immutable historical snapshot of the recipe at the time of consumption. It reflects the exact ingredients and quantities used and cannot be changed.",
            )}
          </DialogDescription>
        </DialogHeader>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("stockMovements.recipeSnapshotEmpty", "No snapshot data available.")}
          </p>
        ) : (
          <dl className="space-y-2 text-sm">
            {rows.map((r) => (
              <div key={r.key} className="grid grid-cols-[1fr_2fr] gap-2 border-b border-border pb-1 last:border-0">
                <dt className="font-medium text-muted-foreground truncate" title={r.key}>
                  {r.key}
                </dt>
                <dd className="text-foreground break-words">{r.display}</dd>
              </div>
            ))}
          </dl>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Reference cell – actionable links
// ---------------------------------------------------------------------------

function ReferenceCell({
  row,
  baseItemId,
}: {
  row: StockMovementRow;
  baseItemId: number;
}) {
  const { t } = useTranslation();

  // Build the primary actionable link target
  function buildHref(): string | null {
    const mt = row.movement_type;
    const referenceType = row.reference_type;
    const referenceId = row.reference_id;

    if (row.order_id || (referenceType === "order" && referenceId)) {
      // order links: /orders/:id
      return `/orders/${row.order_id ?? referenceId}`;
    }
    if (row.purchase_order_id || (referenceType === "purchase_order" && referenceId)) {
      return `/purchase-orders/${row.purchase_order_id ?? referenceId}`;
    }
    if (row.product_id || (referenceType === "product" && referenceId)) {
      return `/products/${row.product_id ?? referenceId}`;
    }

    // Transfer: deep-link back to stock-movements tab with transfer label search
    if (
      (mt === "transfer_in" || mt === "transfer_out") &&
      (row.transfer_label || row.transfer_id || referenceId)
    ) {
      const q = row.transfer_label ?? row.reference_label ?? `T-${row.transfer_id ?? referenceId}`;
      return `/base-items/${baseItemId}?tab=stock-movements&q=${encodeURIComponent(q)}`;
    }

    // Reversal: link back to movements with movement id search
    if (
      (mt === "reversal" || mt === "order_cancellation" || mt === "cmc_return_reversal") &&
      row.reversal_of_id != null
    ) {
      return `/base-items/${baseItemId}?tab=stock-movements&q=${encodeURIComponent(String(row.reversal_of_id))}`;
    }

    // Manual adjustment / count correction / returns – deep-link by movement id
    if (
      mt === "manual_adjustment" ||
      mt === "inventory_count_correction" ||
      mt === "customer_return" ||
      mt === "supplier_return" ||
      mt === "cmc_return"
    ) {
      return `/base-items/${baseItemId}?tab=stock-movements&q=${encodeURIComponent(String(row.id))}`;
    }

    return null;
  }

  const href = buildHref();

  return (
    <div className="space-y-0.5">
      {row.reference_label && href ? (
        <a
          href={href}
          className="text-primary hover:underline leading-tight line-clamp-1 block"
          data-testid={`ref-link-${row.id}`}
        >
          {row.reference_label}
        </a>
      ) : row.reference_label ? (
        <p className="text-foreground leading-tight line-clamp-1">{row.reference_label}</p>
      ) : null}

      {row.product_name && row.product_id && (
        <a
          href={`/products/${row.product_id}`}
          className="text-xs text-muted-foreground hover:text-primary hover:underline leading-tight line-clamp-1 block"
          data-testid={`product-link-${row.id}`}
        >
          {t("stockMovements.product", "Product")}: {row.product_name}
        </a>
      )}

      {row.note && (
        <p className="text-muted-foreground leading-tight italic line-clamp-1 text-xs">
          {row.note}
        </p>
      )}

      {row.reversal_of_id != null && (
        <a
          href={`/base-items/${baseItemId}?tab=stock-movements&q=${encodeURIComponent(String(row.reversal_of_id))}`}
          className="text-muted-foreground hover:text-primary hover:underline leading-tight text-[11px] block"
          data-testid={`reversal-link-${row.id}`}
        >
          {t("stockMovements.reversalOf", "Reversal of #{{id}}", { id: row.reversal_of_id })}
        </a>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function StockMovementTab({ baseItemId, locationStatuses, countries }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();

  const defaults = useMemo(() => getDefaultDates(), []);

  const [page, setPage] = useState(1);
  const [locationId, setLocationId] = useState<string>("all");
  const [movementType, setMovementType] = useState<string>("all");
  const [country, setCountry] = useState<string>("all");
  const [fromDate, setFromDate] = useState<string>(defaults.from);
  const [toDate, setToDate] = useState<string>(defaults.to);
  const [searchRaw, setSearchRaw] = useState<string>(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("q") ?? "";
  });
  const [sortBy, setSortBy] = useState<SortField>("date");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");
  const [recipeRow, setRecipeRow] = useState<StockMovementRow | null>(null);

  const searchQ = useDebounced(searchRaw, 400);
  const exportingRef = useRef(false);
  const [exporting, setExporting] = useState(false);

  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  // Default dates for comparison (to know if they're "active filters")
  const defaultFromDate = defaults.from;
  const defaultToDate = defaults.to;

  const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE), tz });
  params.set("sortBy", apiSortField(sortBy));
  params.set("sortDirection", sortDirection);
  if (locationId !== "all") params.set("locationId", locationId);
  if (movementType !== "all") params.set("movementType", movementType);
  if (country !== "all") params.set("country", country);
  if (fromDate) params.set("from", fromDate);
  if (toDate) params.set("to", toDate);
  if (searchQ) params.set("q", searchQ);

  const { data, isLoading, isError } = useQuery<StockMovementsResponse>({
    queryKey: [
      "base-item-stock-movements",
      baseItemId,
      page,
      locationId,
      movementType,
      country,
      fromDate,
      toDate,
      searchQ,
      sortBy,
      sortDirection,
    ],
    queryFn: () =>
      apiFetch(`/api/base-items/${baseItemId}/stock-movements?${params.toString()}`),
    staleTime: 30_000,
  });

  const movements = data?.movements ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const summary = data?.summary;

  // Self-fetch location statuses when not provided by the parent
  const { data: locationData } = useGetBaseItemLocationStatuses(baseItemId, {
    query: {
      queryKey: getGetBaseItemLocationStatusesQueryKey(baseItemId),
      enabled: !locationStatuses,
    },
  });

  // Full location statuses (with country)
  const fullLocationStatuses = useMemo(
    () =>
      locationStatuses ??
      (locationData?.locationStatuses ?? []).map((ls) => ({
        location_id: ls.location_id,
        location_name: ls.location_name,
        country: ls.country ?? null,
      })),
    [locationStatuses, locationData],
  );

  const uniqueCountries = useMemo(
    () =>
      countries ??
      Array.from(
        new Set(
          fullLocationStatuses
            .map((ls) => ls.country)
            .filter(Boolean) as string[],
        ),
      ).sort(),
    [countries, fullLocationStatuses],
  );

  // Cascade: when country is selected, filter locations to that country
  const filteredLocations = useMemo(() => {
    if (country === "all") return fullLocationStatuses;
    return fullLocationStatuses.filter((ls) => ls.country === country);
  }, [fullLocationStatuses, country]);

  // If current locationId is not in filteredLocations, reset it
  useEffect(() => {
    if (locationId === "all") return;
    const exists = filteredLocations.some(
      (ls) => String(ls.location_id) === locationId,
    );
    if (!exists) {
      setLocationId("all");
    }
  }, [filteredLocations, locationId]);

  function formatDate(iso: string) {
    try {
      return format(new Date(iso), "MMM d, yyyy HH:mm");
    } catch {
      return iso;
    }
  }

  // Determine if non-default filters are active (for empty-state distinction)
  const hasNonDefaultFilters =
    locationId !== "all" ||
    movementType !== "all" ||
    country !== "all" ||
    fromDate !== defaultFromDate ||
    toDate !== defaultToDate ||
    searchQ !== "";

  const handleClearFilters = useCallback(() => {
    setLocationId("all");
    setMovementType("all");
    setCountry("all");
    setFromDate(defaultFromDate);
    setToDate(defaultToDate);
    setSearchRaw("");
    setPage(1);
  }, [defaultFromDate, defaultToDate]);

  // Show "Clear" when any filter differs from default
  const hasFilters =
    locationId !== "all" ||
    movementType !== "all" ||
    country !== "all" ||
    fromDate !== defaultFromDate ||
    toDate !== defaultToDate ||
    searchRaw !== "";

  function handleSort(field: SortField) {
    if (sortBy === field) {
      setSortDirection((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortBy(field);
      setSortDirection(field === "date" ? "desc" : "asc");
    }
    setPage(1);
  }

  const handleExport = useCallback(async () => {
    if (exportingRef.current) return;
    exportingRef.current = true;
    setExporting(true);
    let objectUrl: string | null = null;
    try {
      const exportParams = new URLSearchParams({ tz });
      if (locationId !== "all") exportParams.set("locationId", locationId);
      if (movementType !== "all") exportParams.set("movementType", movementType);
      if (country !== "all") exportParams.set("country", country);
      if (fromDate) exportParams.set("from", fromDate);
      if (toDate) exportParams.set("to", toDate);
      if (searchQ) exportParams.set("q", searchQ);
      exportParams.set("sortBy", apiSortField(sortBy));
      exportParams.set("sortDirection", sortDirection);

      const token = await getClerkToken();
      const url = `/api/base-items/${baseItemId}/stock-movements/export?${exportParams.toString()}`;
      const resp = await fetch(url, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        credentials: "include",
      });

      if (!resp.ok) {
        let msg = t("stockMovements.exportFailed", "Export failed");
        try {
          const errData = (await resp.json()) as Record<string, unknown>;
          if (typeof errData.error === "string") msg = errData.error;
          else if (typeof errData.message === "string") msg = errData.message;
        } catch {
          // ignore parse errors
        }
        toast({ title: msg, variant: "destructive" });
        return;
      }

      const blob = await resp.blob();
      objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = `stock-movements-${baseItemId}.csv`;
      a.click();
      toast({
        title: t("stockMovements.exportSuccess", "CSV downloaded"),
        description: t(
          "stockMovements.exportSuccessDesc",
          "Stock movements exported successfully.",
        ),
      });
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : t("stockMovements.exportFailed", "Export failed");
      toast({ title: msg, variant: "destructive" });
    } finally {
      if (objectUrl) {
        // Revoke after a short delay to allow the download to start
        setTimeout(() => {
          if (objectUrl) URL.revokeObjectURL(objectUrl);
        }, 2000);
      }
      exportingRef.current = false;
      setExporting(false);
    }
  }, [baseItemId, locationId, movementType, country, fromDate, toDate, searchQ, sortBy, sortDirection, tz, t, toast]);

  return (
    <div className="space-y-4">
      {/* Summary cards */}
      {summary && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <SummaryCard
            label={t("stockMovements.opening", "Opening balance")}
            value={summary.openingBalance}
          />
          <SummaryCard
            label={t("stockMovements.received", "Received")}
            value={summary.received}
            positive={true}
          />
          <SummaryCard
            label={t("stockMovements.consumed", "Consumed")}
            value={summary.consumed}
            positive={false}
          />
          <SummaryCard
            label={t("stockMovements.closing", "Closing balance")}
            value={summary.closingBalance}
          />
        </div>
      )}

      {/* Filter bar */}
      <div className="flex flex-wrap gap-2 items-center">
        {/* Country filter */}
        {uniqueCountries.length > 1 && (
          <Select
            value={country}
            onValueChange={(v) => {
              setCountry(v);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-36 h-8 text-sm" data-testid="filter-country">
              <SelectValue placeholder={t("stockMovements.allCountries", "All countries")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">
                {t("stockMovements.allCountries", "All countries")}
              </SelectItem>
              {uniqueCountries.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {/* Location filter — cascaded by country */}
        {fullLocationStatuses.length > 1 && (
          <Select
            value={locationId}
            onValueChange={(v) => {
              setLocationId(v);
              setPage(1);
            }}
          >
            <SelectTrigger className="w-44 h-8 text-sm" data-testid="filter-location">
              <SelectValue placeholder={t("stockMovements.allLocations", "All locations")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">
                {t("stockMovements.allLocations", "All locations")}
              </SelectItem>
              {filteredLocations.map((l) => (
                <SelectItem key={l.location_id} value={String(l.location_id)}>
                  {l.location_name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {/* Movement type filter */}
        <Select
          value={movementType}
          onValueChange={(v) => {
            setMovementType(v);
            setPage(1);
          }}
        >
          <SelectTrigger className="w-52 h-8 text-sm" data-testid="filter-type">
            <SelectValue placeholder={t("stockMovements.allTypes", "All movement types")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">
              {t("stockMovements.allTypes", "All movement types")}
            </SelectItem>
            {MOVEMENT_TYPES.map((mt) => (
              <SelectItem key={mt.value} value={mt.value}>
                {t(`stockMovements.types.${mt.value}`, mt.label)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Date range */}
        <input
          type="date"
          value={fromDate}
          onChange={(e) => {
            setFromDate(e.target.value);
            setPage(1);
          }}
          className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground w-36"
          aria-label={t("stockMovements.from", "From date")}
          data-testid="filter-from-date"
        />
        <input
          type="date"
          value={toDate}
          onChange={(e) => {
            setToDate(e.target.value);
            setPage(1);
          }}
          className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground w-36"
          aria-label={t("stockMovements.to", "To date")}
          data-testid="filter-to-date"
        />

        {/* Reference search */}
        <div className="relative">
          <Search
            size={14}
            className="absolute start-2 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
          />
          <Input
            value={searchRaw}
            onChange={(e) => {
              setSearchRaw(e.target.value);
              setPage(1);
            }}
            className="h-8 ps-7 pe-7 w-48 text-sm"
            placeholder={t("stockMovements.searchPlaceholder", "Search reference…")}
            data-testid="filter-search"
          />
          {searchRaw && (
            <button
              type="button"
              onClick={() => {
                setSearchRaw("");
                setPage(1);
              }}
              className="absolute end-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              data-testid="clear-search"
            >
              <X size={12} />
            </button>
          )}
        </div>

        {hasFilters && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-xs"
            onClick={handleClearFilters}
            data-testid="clear-filters"
          >
            {t("stockMovements.clearFilters", "Clear")}
          </Button>
        )}

        {/* Total + export */}
        <span className="text-xs text-muted-foreground ms-auto" data-testid="total-entries">
          {total > 0 &&
            t("stockMovements.totalEntries", "{{count}} entries", { count: total })}
        </span>
        <Button
          variant="outline"
          size="sm"
          className="h-8 text-xs gap-1"
          onClick={handleExport}
          disabled={exporting}
          data-testid="export-csv"
        >
          {exporting ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <Download size={12} />
          )}
          {t("stockMovements.export", "CSV")}
        </Button>
      </div>

      {/* Loading state */}
      {isLoading && (
        <div
          className="flex items-center gap-2 text-sm text-muted-foreground py-6 justify-center"
          data-testid="loading-state"
        >
          <Loader2 size={16} className="animate-spin" />
          {t("stockMovements.loading", "Loading movements…")}
        </div>
      )}

      {/* Error state */}
      {isError && (
        <div className="py-6 text-center text-sm text-destructive" data-testid="error-state">
          {t("stockMovements.loadError", "Failed to load stock movements.")}
        </div>
      )}

      {/* Table */}
      {!isLoading && !isError && (
        <div className="rounded-lg border border-border overflow-x-auto">
          <table className="w-full text-sm" data-testid="movements-table">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="text-start py-2.5 px-3 font-medium text-muted-foreground whitespace-nowrap">
                  <SortHeader
                    field="date"
                    label={t("stockMovements.colDate", "Date")}
                    sortBy={sortBy}
                    sortDir={sortDirection}
                    onSort={handleSort}
                  />
                </th>
                <th className="text-start py-2.5 px-3 font-medium text-muted-foreground whitespace-nowrap">
                  <SortHeader
                    field="type"
                    label={t("stockMovements.colType", "Type")}
                    sortBy={sortBy}
                    sortDir={sortDirection}
                    onSort={handleSort}
                  />
                </th>
                <th className="text-start py-2.5 px-3 font-medium text-muted-foreground whitespace-nowrap">
                  <SortHeader
                    field="reference"
                    label={t("stockMovements.colReference", "Reference")}
                    sortBy={sortBy}
                    sortDir={sortDirection}
                    onSort={handleSort}
                  />
                </th>
                <th className="text-start py-2.5 px-3 font-medium text-muted-foreground whitespace-nowrap">
                  <SortHeader
                    field="location"
                    label={t("stockMovements.colLocation", "Location")}
                    sortBy={sortBy}
                    sortDir={sortDirection}
                    onSort={handleSort}
                  />
                </th>
                <th className="text-end py-2.5 px-3 font-medium text-muted-foreground whitespace-nowrap">
                  <SortHeader
                    field="change"
                    label={t("stockMovements.colChange", "Change")}
                    sortBy={sortBy}
                    sortDir={sortDirection}
                    onSort={handleSort}
                    align="end"
                  />
                </th>
                <th className="text-end py-2.5 px-3 font-medium text-muted-foreground whitespace-nowrap">
                  <SortHeader
                    field="balance"
                    label={t("stockMovements.colBalance", "Balance")}
                    sortBy={sortBy}
                    sortDir={sortDirection}
                    onSort={handleSort}
                    align="end"
                  />
                </th>
                <th className="text-start py-2.5 px-3 font-medium text-muted-foreground whitespace-nowrap">
                  {t("stockMovements.colSource", "Source")}
                </th>
                <th className="text-start py-2.5 px-3 font-medium text-muted-foreground whitespace-nowrap">
                  {t("stockMovements.colDetails", "Details")}
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {movements.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-12 text-center">
                    <p className="text-sm font-medium text-muted-foreground" data-testid="empty-message">
                      {hasNonDefaultFilters
                        ? t("stockMovements.noResults", "No movements match your filters.")
                        : t("stockMovements.empty", "No stock movements yet.")}
                    </p>
                    {!hasNonDefaultFilters && (
                      <p className="text-xs text-muted-foreground mt-1">
                        {t(
                          "stockMovements.emptyHint",
                          "Movements will appear here once stock is adjusted or orders are fulfilled.",
                        )}
                      </p>
                    )}
                  </td>
                </tr>
              ) : (
                movements.map((m) => {
                  const badge = movementTypeBadge(m.movement_type);
                  const movementLabel = t(
                    `stockMovements.types.${m.movement_type ?? "unknown"}`,
                    badge.label,
                  );
                  const qty = parseFloat(m.quantity_change);
                  const isIn = qty > 0;
                  const isOut = qty < 0;
                  return (
                    <tr
                      key={m.id}
                      className="hover:bg-muted/20 transition-colors"
                      data-testid={`movement-row-${m.id}`}
                    >
                      <td className="py-2.5 px-3 whitespace-nowrap text-xs text-muted-foreground">
                        {formatDate(m.created_at)}
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap">
                        <Badge variant={badge.variant} className="text-xs font-normal">
                          {movementLabel}
                        </Badge>
                        {m.cutover_baseline && (
                          <Badge variant="outline" className="ms-1 text-xs font-normal">
                            {t("stockMovements.baseline", "Baseline")}
                          </Badge>
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-xs max-w-[200px]">
                        <ReferenceCell row={m} baseItemId={baseItemId} />
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap text-xs">
                        {m.location_name ?? "—"}
                      </td>
                      <td className="py-2.5 px-3 text-end whitespace-nowrap text-xs">
                        {isIn && (
                          <span className="flex items-center justify-end gap-1 text-emerald-600 font-mono font-medium">
                            <ArrowUpRight size={13} aria-hidden="true" />
                            <span className="text-[10px] font-sans font-semibold uppercase tracking-wide">
                              {t("stockMovements.inLabel", "In")}
                            </span>
                            +{m.quantity_change}
                          </span>
                        )}
                        {isOut && (
                          <span className="flex items-center justify-end gap-1 text-red-500 font-mono font-medium">
                            <ArrowDownRight size={13} aria-hidden="true" />
                            <span className="text-[10px] font-sans font-semibold uppercase tracking-wide">
                              {t("stockMovements.outLabel", "Out")}
                            </span>
                            {m.quantity_change}
                          </span>
                        )}
                        {!isIn && !isOut && (
                          <span className="flex items-center justify-end gap-1 text-muted-foreground font-mono">
                            <Minus size={13} aria-hidden="true" />
                            {m.quantity_change}
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-end font-mono text-xs text-muted-foreground whitespace-nowrap">
                        {parseFloat(m.running_balance).toFixed(2)}
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap text-xs text-muted-foreground">
                        {m.source_display_name ?? t("stockMovements.system", "System")}
                      </td>
                      <td className="py-2.5 px-3 whitespace-nowrap text-xs">
                        {m.recipe_snapshot != null && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 px-2 text-xs gap-1"
                            onClick={() => setRecipeRow(m)}
                            data-testid={`recipe-btn-${m.id}`}
                          >
                            <BookOpen size={12} />
                            {t("stockMovements.recipeDetails", "Recipe")}
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between" data-testid="pagination">
          <span className="text-xs text-muted-foreground">
            {t("stockMovements.pageOf", "Page {{page}} of {{total}}", {
              page,
              total: totalPages,
            })}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              data-testid="pagination-prev"
            >
              <ChevronLeft size={14} />
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              data-testid="pagination-next"
            >
              <ChevronRight size={14} />
            </Button>
          </div>
        </div>
      )}

      {/* Recipe snapshot dialog */}
      <RecipeSnapshotDialog
        snapshot={recipeRow?.recipe_snapshot ?? null}
        open={recipeRow != null}
        onClose={() => setRecipeRow(null)}
      />
    </div>
  );
}
