import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  Plus, Trash2, Pencil, MapPin, Truck, Zap, Gift,
  Globe, CheckCircle, Search, CalendarClock,
} from "lucide-react";
import { DistrictDeliveryRulesDrawer, type CityForDrawer } from "./DistrictDeliveryRulesDrawer";
import { apiFetch, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Label } from "@/components/ui/label";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { TimePicker } from "@/components/ui/time-picker";

type City = {
  id: number;
  country: string;
  name: string;
  slug: string;
  is_active: boolean;
  sort_order: number;
  delivery_fee: string | null;
  free_delivery_enabled: boolean;
  free_delivery_threshold: string | null;
  express_delivery_enabled: boolean;
  express_delivery_fee: string | null;
  express_delivery_cutoff_time: string | null;
  standard_delivery_available: boolean;
  express_delivery_available: boolean;
  express_free_delivery_threshold: string | null;
  cutoff_time: string | null;
  max_standard_orders_per_slot: number | null;
  max_express_orders_per_slot: number | null;
  created_at: string;
};

type CitiesResponse = { cities: City[]; countries: string[] };

type CityFormData = {
  name: string;
  country: string;
  slug?: string;
  is_active: boolean;
  sort_order: number;
  delivery_fee: number;
  free_delivery_enabled: boolean;
  free_delivery_threshold: number | null;
  express_delivery_enabled: boolean;
  express_delivery_fee: number | null;
  express_delivery_cutoff_time: string | null;
};

function fmtFee(val: string | null | undefined): string {
  if (val == null || val === "") return "0.00";
  const n = parseFloat(val);
  return Number.isFinite(n) ? n.toFixed(2) : "0.00";
}

// ── Summary card ─────────────────────────────────────────────────────────────
function StatCard({
  icon,
  label,
  value,
  sub,
  iconClass,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  sub?: string;
  iconClass?: string;
}) {
  return (
    <div className="rounded-xl border bg-card p-5 flex items-start gap-4">
      <div className={`mt-0.5 rounded-lg p-2.5 ${iconClass ?? "bg-muted"}`}>
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="text-2xl font-bold leading-tight">{value}</p>
        {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

// ── Skeleton loaders ──────────────────────────────────────────────────────────
function SummarySkeleton() {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="rounded-xl border bg-card p-5 flex items-start gap-4">
          <Skeleton className="h-10 w-10 rounded-lg shrink-0" />
          <div className="flex-1 space-y-2 pt-0.5">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-7 w-12" />
            <Skeleton className="h-3 w-20" />
          </div>
        </div>
      ))}
    </div>
  );
}

function CityRowSkeleton() {
  return (
    <div className="rounded-xl border bg-card px-5 py-4 flex items-center gap-6">
      <div className="flex-1 space-y-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-3 w-20" />
      </div>
      <Skeleton className="h-8 w-20 hidden sm:block" />
      <Skeleton className="h-8 w-28 hidden md:block" />
      <Skeleton className="h-8 w-28 hidden md:block" />
      <Skeleton className="h-7 w-14 hidden lg:block" />
    </div>
  );
}

// ── City form ─────────────────────────────────────────────────────────────────
function CityForm({
  initial,
  onSubmit,
  isPending,
  onCancel,
  countryOptions,
}: {
  initial?: Partial<CityFormData & { slug: string }>;
  onSubmit: (data: CityFormData) => void;
  isPending: boolean;
  onCancel: () => void;
  countryOptions: string[];
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [country, setCountry] = useState(initial?.country ?? (countryOptions[0] ?? ""));
  const [slug, setSlug] = useState(initial?.slug ?? "");
  const [isActive, setIsActive] = useState(initial?.is_active ?? true);
  const [sortOrder, setSortOrder] = useState(String(initial?.sort_order ?? 0));

  const [deliveryFee, setDeliveryFee] = useState(String(initial?.delivery_fee ?? 0));
  const [freeEnabled, setFreeEnabled] = useState(initial?.free_delivery_enabled ?? false);
  const [freeThreshold, setFreeThreshold] = useState(
    initial?.free_delivery_threshold != null ? String(initial.free_delivery_threshold) : "",
  );
  const [expressEnabled, setExpressEnabled] = useState(initial?.express_delivery_enabled ?? false);
  const [expressFee, setExpressFee] = useState(
    initial?.express_delivery_fee != null ? String(initial.express_delivery_fee) : "",
  );
  const [expressCutoff, setExpressCutoff] = useState(initial?.express_delivery_cutoff_time ?? "");

  useEffect(() => {
    if (countryOptions.length > 0 && !countryOptions.includes(country)) {
      setCountry(countryOptions[0]);
    }
  }, [countryOptions, country]);

  const deliveryFeeNum = parseFloat(deliveryFee);
  const isValid =
    name.trim() !== "" &&
    country !== "" &&
    Number.isFinite(deliveryFeeNum) && deliveryFeeNum >= 0 &&
    (!freeEnabled || freeThreshold === "" || (Number.isFinite(parseFloat(freeThreshold)) && parseFloat(freeThreshold) >= 0)) &&
    (!expressEnabled || expressFee === "" || (Number.isFinite(parseFloat(expressFee)) && parseFloat(expressFee) >= 0));

  function handleSubmit() {
    onSubmit({
      name: name.trim(),
      country,
      slug: slug.trim() || undefined,
      is_active: isActive,
      sort_order: parseInt(sortOrder, 10) || 0,
      delivery_fee: parseFloat(deliveryFee) || 0,
      free_delivery_enabled: freeEnabled,
      free_delivery_threshold: freeEnabled && freeThreshold ? parseFloat(freeThreshold) : null,
      express_delivery_enabled: expressEnabled,
      express_delivery_fee: expressEnabled && expressFee ? parseFloat(expressFee) : null,
      express_delivery_cutoff_time: expressEnabled && expressCutoff ? expressCutoff : null,
    });
  }

  return (
    <div className="space-y-5 max-h-[70vh] overflow-y-auto pr-1">
      {/* Basic info */}
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="city-name">City name</Label>
          <Input
            id="city-name"
            placeholder="e.g. Beirut"
            value={name}
            onChange={(e) => setName(e.target.value)}
            data-testid="input-city-name"
            autoFocus
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="city-country">Country</Label>
            <Select value={country} onValueChange={setCountry}>
              <SelectTrigger id="city-country" data-testid="select-city-country">
                <SelectValue placeholder="Select country" />
              </SelectTrigger>
              <SelectContent>
                {countryOptions.map((c) => (
                  <SelectItem key={c} value={c}>{c}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="city-sort">Sort order</Label>
            <Input
              id="city-sort"
              type="number"
              value={sortOrder}
              onChange={(e) => setSortOrder(e.target.value)}
              data-testid="input-city-sort"
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="city-slug">Slug <span className="text-muted-foreground">(optional)</span></Label>
          <Input
            id="city-slug"
            placeholder="auto-generated from name"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            data-testid="input-city-slug"
          />
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id="city-active"
            checked={isActive}
            onCheckedChange={setIsActive}
            data-testid="switch-city-active"
          />
          <Label htmlFor="city-active">Active</Label>
        </div>
      </div>

      <hr />

      {/* Standard delivery */}
      <div className="space-y-3">
        <div className="flex items-center gap-2 text-sm font-semibold">
          <Truck size={15} className="text-muted-foreground" />
          Standard Delivery
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="city-delivery-fee">Delivery fee</Label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
            <Input
              id="city-delivery-fee"
              type="number"
              min="0"
              step="0.01"
              placeholder="0.00"
              value={deliveryFee}
              onChange={(e) => setDeliveryFee(e.target.value)}
              className="pl-7"
              data-testid="input-delivery-fee"
            />
          </div>
        </div>
      </div>

      <hr />

      {/* Free delivery */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Gift size={15} className="text-muted-foreground" />
            Free Delivery
          </div>
          <Switch
            id="free-delivery-toggle"
            checked={freeEnabled}
            onCheckedChange={setFreeEnabled}
            data-testid="switch-free-delivery"
          />
        </div>
        {freeEnabled && (
          <div className="space-y-1.5 pl-1">
            <Label htmlFor="free-threshold">Free above amount <span className="text-muted-foreground">(optional)</span></Label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
              <Input
                id="free-threshold"
                type="number"
                min="0"
                step="0.01"
                placeholder="e.g. 50.00"
                value={freeThreshold}
                onChange={(e) => setFreeThreshold(e.target.value)}
                className="pl-7"
                data-testid="input-free-threshold"
              />
            </div>
            <p className="text-xs text-muted-foreground">Leave empty if always free</p>
          </div>
        )}
      </div>

      <hr />

      {/* Express delivery */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Zap size={15} className="text-muted-foreground" />
            Express Delivery
          </div>
          <Switch
            id="express-delivery-toggle"
            checked={expressEnabled}
            onCheckedChange={setExpressEnabled}
            data-testid="switch-express-delivery"
          />
        </div>
        {expressEnabled && (
          <div className="space-y-3 pl-1">
            <div className="space-y-1.5">
              <Label htmlFor="express-fee">Express fee</Label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                <Input
                  id="express-fee"
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="0.00"
                  value={expressFee}
                  onChange={(e) => setExpressFee(e.target.value)}
                  className="pl-7"
                  data-testid="input-express-fee"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="express-cutoff">Order cutoff time <span className="text-muted-foreground">(optional)</span></Label>
              <TimePicker
                id="express-cutoff"
                value={expressCutoff}
                onChange={setExpressCutoff}
                data-testid="input-express-cutoff"
              />
            </div>
          </div>
        )}
      </div>

      <DialogFooter className="pt-2">
        <Button variant="outline" onClick={onCancel} disabled={isPending}>Cancel</Button>
        <Button
          onClick={handleSubmit}
          disabled={isPending || !isValid}
          data-testid="button-confirm-city"
        >
          {isPending ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </div>
  );
}

// ── City row card ─────────────────────────────────────────────────────────────
function CityCard({
  city,
  canManage,
  onEdit,
  onDelete,
  onToggleActive,
  onToggleFree,
  onToggleExpress,
  onOpenDetail,
}: {
  city: City;
  canManage: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onToggleActive: (val: boolean) => void;
  onToggleFree: (val: boolean) => void;
  onToggleExpress: (val: boolean) => void;
  onOpenDetail: () => void;
}) {
  const threshold = city.free_delivery_threshold != null ? parseFloat(city.free_delivery_threshold) : null;
  const expressFee = city.express_delivery_fee != null ? parseFloat(city.express_delivery_fee) : null;

  return (
    <div
      className="rounded-xl border bg-card px-5 py-4 flex flex-col sm:flex-row sm:items-center gap-4 sm:gap-0"
      data-testid={`city-card-${city.id}`}
    >
      {/* Left: name + slug + active toggle — clicking opens detail drawer */}
      <div
        className="flex-1 min-w-0 sm:pr-4 cursor-pointer"
        onClick={onOpenDetail}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onOpenDetail(); }}
        data-testid={`city-row-name-${city.id}`}
      >
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-semibold text-sm hover:underline">{city.name}</span>
          {/* Stop switch click from bubbling to the row detail handler */}
          <span onClick={(e) => e.stopPropagation()}>
            <Switch
              checked={city.is_active}
              onCheckedChange={canManage ? onToggleActive : undefined}
              disabled={!canManage}
              data-testid={`switch-active-${city.id}`}
              className="scale-75"
            />
          </span>
          <Badge
            variant={city.is_active ? "default" : "secondary"}
            className="text-[10px] px-1.5 py-0"
          >
            {city.is_active ? "Active" : "Inactive"}
          </Badge>
        </div>
        <p className="font-mono text-xs text-muted-foreground mt-0.5">{city.slug}</p>
      </div>

      {/* Delivery columns */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 sm:gap-0 text-sm">
        {/* Standard delivery fee */}
        <div className="sm:w-36 sm:border-l sm:pl-4">
          <p className="text-xs text-muted-foreground mb-0.5">Standard Delivery</p>
          <p className="font-semibold">${fmtFee(city.delivery_fee)}</p>
          <p className="text-[10px] text-muted-foreground">Delivery fee</p>
        </div>

        {/* Free delivery */}
        <div className="sm:w-44 sm:border-l sm:pl-4">
          <p className="text-xs text-muted-foreground mb-1">Free Delivery</p>
          <div className="flex items-center gap-2">
            <Switch
              checked={city.free_delivery_enabled}
              onCheckedChange={canManage ? onToggleFree : undefined}
              disabled={!canManage}
              data-testid={`switch-free-${city.id}`}
              className="scale-90"
            />
            {city.free_delivery_enabled ? (
              <span className="text-xs">
                {threshold != null ? `Above $${threshold.toFixed(2)}` : "Always free"}
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">—</span>
            )}
          </div>
        </div>

        {/* Express delivery */}
        <div className="sm:w-52 sm:border-l sm:pl-4">
          <p className="text-xs text-muted-foreground mb-1">Express Delivery</p>
          <div className="flex items-center gap-2">
            <Switch
              checked={city.express_delivery_enabled}
              onCheckedChange={canManage ? onToggleExpress : undefined}
              disabled={!canManage}
              data-testid={`switch-express-${city.id}`}
              className="scale-90"
            />
            {city.express_delivery_enabled ? (
              <span className="text-xs">
                {expressFee != null ? `$${expressFee.toFixed(2)}` : ""}
                {city.express_delivery_cutoff_time ? ` · by ${city.express_delivery_cutoff_time}` : ""}
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">—</span>
            )}
          </div>
        </div>
      </div>

      {/* Action buttons */}
      <div className="flex items-center gap-1 sm:pl-4 self-end sm:self-center">
        <Button
          variant="outline"
          size="sm"
          className="h-8 px-2.5 gap-1.5 text-xs hidden sm:flex"
          onClick={onOpenDetail}
          data-testid={`button-manage-rules-${city.id}`}
        >
          <CalendarClock size={13} />
          Schedule
        </Button>
        <Button
          variant="outline"
          size="sm"
          className="h-8 w-8 p-0 flex sm:hidden"
          onClick={onOpenDetail}
          data-testid={`button-manage-rules-mobile-${city.id}`}
        >
          <CalendarClock size={13} />
        </Button>
        {canManage && (
          <>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0"
              onClick={onEdit}
              data-testid={`button-edit-city-${city.id}`}
            >
              <Pencil size={14} />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0"
              onClick={onDelete}
              data-testid={`button-delete-city-${city.id}`}
            >
              <Trash2 size={14} className="text-destructive" />
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
type SortKey = "name-asc" | "name-desc" | "newest" | "oldest";
type StatusFilter = "__all__" | "active" | "inactive";

export default function CitiesPage() {
  const { toast } = useToast();
  const { isOwner, allowedPages } = useWorkspaceRole();
  const canManage = isOwner || (allowedPages?.includes("cities.manage") ?? false);

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editing, setEditing] = useState<City | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<City | null>(null);
  const [rulesTarget, setRulesTarget] = useState<City | null>(null);

  const [search, setSearch] = useState("");
  const [countryFilter, setCountryFilter] = useState<string>("__all__");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("__all__");
  const [sort, setSort] = useState<SortKey>("name-asc");

  const { data, isLoading, isError } = useQuery<CitiesResponse>({
    queryKey: ["cities"],
    queryFn: () => apiFetch<CitiesResponse>("/api/cities"),
  });

  const allCities = data?.cities ?? [];
  const countries = data?.countries ?? [];

  // Filter
  const filtered = allCities.filter((c) => {
    if (countryFilter !== "__all__" && c.country !== countryFilter) return false;
    if (statusFilter === "active" && !c.is_active) return false;
    if (statusFilter === "inactive" && c.is_active) return false;
    if (search.trim() && !c.name.toLowerCase().includes(search.trim().toLowerCase())) return false;
    return true;
  });

  // Sort
  const sorted = [...filtered].sort((a, b) => {
    if (sort === "name-asc") return a.name.localeCompare(b.name);
    if (sort === "name-desc") return b.name.localeCompare(a.name);
    if (sort === "newest") return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    if (sort === "oldest") return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    return 0;
  });

  // Group by country
  const grouped = new Map<string, City[]>();
  for (const c of sorted) {
    if (!grouped.has(c.country)) grouped.set(c.country, []);
    grouped.get(c.country)!.push(c);
  }

  // Summary stats
  const totalCountries = new Set(allCities.map((c) => c.country)).size;
  const activeCount = allCities.filter((c) => c.is_active).length;
  const freeCount = allCities.filter((c) => c.free_delivery_enabled).length;
  const expressCount = allCities.filter((c) => c.express_delivery_enabled).length;
  const totalCount = allCities.length;
  const activePct = totalCount > 0 ? Math.round((activeCount / totalCount) * 100) : 0;
  const freePct = totalCount > 0 ? Math.round((freeCount / totalCount) * 100) : 0;
  const expressPct = totalCount > 0 ? Math.round((expressCount / totalCount) * 100) : 0;

  const handleError = (err: unknown) => {
    const msg = err instanceof Error ? err.message : "Save failed";
    toast({ title: "Error", description: msg, variant: "destructive" });
  };

  const createMutation = useMutation({
    mutationFn: (body: CityFormData) =>
      apiFetch<{ city: City }>("/api/cities", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cities"] });
      setIsCreateOpen(false);
      toast({ title: "City created" });
    },
    onError: handleError,
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, ...body }: { id: number } & CityFormData) =>
      apiFetch<{ city: City }>(`/api/cities/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cities"] });
      setEditing(null);
      toast({ title: "City updated" });
    },
    onError: handleError,
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, ...patch }: { id: number } & Partial<Pick<City, "is_active" | "free_delivery_enabled" | "express_delivery_enabled">>) =>
      apiFetch<{ city: City }>(`/api/cities/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
    onMutate: async ({ id, ...patch }) => {
      await queryClient.cancelQueries({ queryKey: ["cities"] });
      const prev = queryClient.getQueryData<CitiesResponse>(["cities"]);
      queryClient.setQueryData<CitiesResponse>(["cities"], (old) => {
        if (!old) return old;
        return {
          ...old,
          cities: old.cities.map((c) => (c.id === id ? { ...c, ...patch } : c)),
        };
      });
      return { prev };
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.prev) queryClient.setQueryData(["cities"], ctx.prev);
      toast({ title: "Failed to update", variant: "destructive" });
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ["cities"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/cities/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cities"] });
      setDeleteTarget(null);
      toast({ title: "City deleted" });
    },
    onError: handleError,
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Delivery Cities</h1>
          <p className="text-muted-foreground mt-1.5 text-sm">
            Manage the cities where your products can be delivered, including pricing and delivery options.
          </p>
        </div>
        {canManage && (
          <Button
            onClick={() => setIsCreateOpen(true)}
            className="gap-2 bg-teal-700 hover:bg-teal-800 text-white shrink-0"
            data-testid="button-new-city"
          >
            <Plus size={16} /> New city
          </Button>
        )}
      </div>

      {/* Summary cards */}
      {isLoading ? (
        <SummarySkeleton />
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            icon={<Globe size={18} className="text-blue-600" />}
            iconClass="bg-blue-50 dark:bg-blue-950"
            label="Total Cities"
            value={totalCount}
            sub={`Across ${totalCountries} ${totalCountries === 1 ? "country" : "countries"}`}
          />
          <StatCard
            icon={<CheckCircle size={18} className="text-green-600" />}
            iconClass="bg-green-50 dark:bg-green-950"
            label="Active Cities"
            value={activeCount}
            sub={`${activePct}% of total`}
          />
          <StatCard
            icon={<Gift size={18} className="text-purple-600" />}
            iconClass="bg-purple-50 dark:bg-purple-950"
            label="Free Delivery"
            value={freeCount}
            sub={`${freePct}% of cities`}
          />
          <StatCard
            icon={<Zap size={18} className="text-amber-600" />}
            iconClass="bg-amber-50 dark:bg-amber-950"
            label="Express Delivery"
            value={expressCount}
            sub={`${expressPct}% of cities`}
          />
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3 flex-wrap">
        <div className="relative flex-1 min-w-48 max-w-sm">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search cities…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-8"
            data-testid="input-cities-search"
          />
        </div>
        <Select value={countryFilter} onValueChange={setCountryFilter}>
          <SelectTrigger className="w-44" data-testid="select-cities-country-filter">
            <SelectValue placeholder="All countries" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All countries</SelectItem>
            {countries.map((c) => (
              <SelectItem key={c} value={c}>{c}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as StatusFilter)}>
          <SelectTrigger className="w-36" data-testid="select-cities-status-filter">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">All statuses</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="inactive">Inactive</SelectItem>
          </SelectContent>
        </Select>
        <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
          <SelectTrigger className="w-40" data-testid="select-cities-sort">
            <SelectValue placeholder="Sort" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="name-asc">A – Z</SelectItem>
            <SelectItem value="name-desc">Z – A</SelectItem>
            <SelectItem value="newest">Newest first</SelectItem>
            <SelectItem value="oldest">Oldest first</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="space-y-6">
          {[1, 2].map((g) => (
            <div key={g} className="space-y-3">
              <Skeleton className="h-5 w-40" />
              <div className="space-y-2">
                {Array.from({ length: 2 }).map((_, i) => <CityRowSkeleton key={i} />)}
              </div>
            </div>
          ))}
        </div>
      ) : isError ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-5 py-8 text-center">
          <p className="font-medium text-destructive">Failed to load cities</p>
          <p className="text-sm text-muted-foreground mt-1">Please refresh the page to try again.</p>
        </div>
      ) : allCities.length === 0 ? (
        <div className="rounded-xl border bg-card px-6 py-16 text-center space-y-3">
          <MapPin className="w-12 h-12 mx-auto text-muted-foreground/40" />
          <div>
            <p className="font-semibold text-lg">No delivery cities yet</p>
            <p className="text-sm text-muted-foreground mt-1">
              Add your first city to start managing per-city delivery availability and pricing.
            </p>
          </div>
          {canManage && (
            <Button
              className="mt-2 gap-2 bg-teal-700 hover:bg-teal-800 text-white"
              onClick={() => setIsCreateOpen(true)}
            >
              <Plus size={16} /> New city
            </Button>
          )}
        </div>
      ) : sorted.length === 0 ? (
        <div className="rounded-xl border bg-card px-6 py-12 text-center">
          <Search className="w-10 h-10 mx-auto text-muted-foreground/40 mb-3" />
          <p className="font-medium">No cities match your filters</p>
          <p className="text-sm text-muted-foreground mt-1">Try adjusting the search or filters above.</p>
        </div>
      ) : (
        <div className="space-y-8">
          {Array.from(grouped.entries()).map(([country, items]) => (
            <div key={country} className="space-y-3" data-testid={`country-group-${country}`}>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-semibold">{country}</h2>
                <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
                  {items.length} {items.length === 1 ? "city" : "cities"}
                </span>
              </div>
              <div className="space-y-2">
                {items.map((c) => (
                  <CityCard
                    key={c.id}
                    city={c}
                    canManage={canManage}
                    onEdit={() => setEditing(c)}
                    onDelete={() => setDeleteTarget(c)}
                    onToggleActive={(val) => toggleMutation.mutate({ id: c.id, is_active: val })}
                    onToggleFree={(val) => toggleMutation.mutate({ id: c.id, free_delivery_enabled: val })}
                    onToggleExpress={(val) => toggleMutation.mutate({ id: c.id, express_delivery_enabled: val })}
                    onOpenDetail={() => setRulesTarget(c)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create dialog */}
      <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>New city</DialogTitle>
            <DialogDescription>Add a delivery city and configure its pricing.</DialogDescription>
          </DialogHeader>
          <CityForm
            onSubmit={(data) => createMutation.mutate(data)}
            isPending={createMutation.isPending}
            onCancel={() => setIsCreateOpen(false)}
            countryOptions={countries}
          />
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit city</DialogTitle>
            <DialogDescription>Update this city's details and delivery configuration.</DialogDescription>
          </DialogHeader>
          {editing && (
            <CityForm
              initial={{
                name: editing.name,
                country: editing.country,
                slug: editing.slug,
                is_active: editing.is_active,
                sort_order: editing.sort_order,
                delivery_fee: parseFloat(editing.delivery_fee ?? "0") || 0,
                free_delivery_enabled: editing.free_delivery_enabled,
                free_delivery_threshold: editing.free_delivery_threshold != null
                  ? parseFloat(editing.free_delivery_threshold)
                  : null,
                express_delivery_enabled: editing.express_delivery_enabled,
                express_delivery_fee: editing.express_delivery_fee != null
                  ? parseFloat(editing.express_delivery_fee)
                  : null,
                express_delivery_cutoff_time: editing.express_delivery_cutoff_time,
              }}
              onSubmit={(body) => updateMutation.mutate({ id: editing.id, ...body })}
              isPending={updateMutation.isPending}
              onCancel={() => setEditing(null)}
              countryOptions={countries}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Delivery rules drawer — opens directly to the Weekly Slots tab */}
      <DistrictDeliveryRulesDrawer
        city={rulesTarget}
        open={rulesTarget !== null}
        onOpenChange={(open) => { if (!open) setRulesTarget(null); }}
        canManage={canManage}
        initialTab="weekly-slots"
      />

      {/* Delete dialog */}
      <Dialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent data-testid="dialog-delete-city">
          <DialogHeader>
            <DialogTitle>Delete city?</DialogTitle>
            <DialogDescription>
              Deleting <strong>{deleteTarget?.name}</strong> will also remove its product
              availability rows. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          {allCities.length === 1 && (
            <p className="text-sm text-destructive" data-testid="warning-last-city">
              You cannot delete the last city. Add another city before removing this one.
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
              disabled={deleteMutation.isPending || allCities.length === 1}
              data-testid="button-confirm-delete-city"
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
