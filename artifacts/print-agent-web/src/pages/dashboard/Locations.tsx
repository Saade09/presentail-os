import { useState, useEffect } from "react";
import { Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  Plus,
  Pencil,
  MapPin,
  MoreHorizontal,
  AlertTriangle,
  X,
  Search,
  LayoutGrid,
  Table2,
  Map,
  ShoppingCart,
  MonitorX,
  CheckCircle2,
  PauseCircle,
  Building2,
  ArrowRight,
  CheckSquare,
  ChevronDown,
  Flower2,
} from "lucide-react";
import { apiFetch, queryClient } from "@/lib/queryClient";
import { DEFAULT_COUNTRIES, isExcludedCountry, findCountryByName } from "@/lib/countries";
import { FlagImage } from "@/components/FlagImage";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
} from "@/components/ui/card";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useToast } from "@/hooks/use-toast";
import { useRoles } from "@/hooks/use-roles";
import { Label } from "@/components/ui/label";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { StaleDataBadge } from "@/components/StaleDataBadge";
import { checkNameWarning } from "@/lib/nameWarning";

type LocationCountry = string;
type LocationTypeValue = "Point of Sale" | "Central Warehouse";
const TYPE_OPTIONS: LocationTypeValue[] = ["Point of Sale", "Central Warehouse"];

type RentCurrency = "USD" | "AED";
const CURRENCY_OPTIONS: RentCurrency[] = ["USD", "AED"];

type LocationStatus = "active" | "paused" | "setup_incomplete";

type Location = {
  id: number;
  name: string;
  country: LocationCountry;
  location_type: LocationTypeValue;
  status: LocationStatus;
  annual_rent: number | null;
  rent_currency: RentCurrency | null;
  payments_per_year: number | null;
  daily_capacity: number | null;
  address: string | null;
  created_at: string;
  device_count: number;
  devices_online: number;
  devices_offline: number;
  job_count: number;
  page_sum: number;
  brands_count: number;
  products_count: number;
  orders_today: number;
  pending_prep: number;
  has_operating_hours: boolean;
  has_routing: boolean;
  has_capacity: boolean;
};

type LocationFormData = {
  name: string;
  country: LocationCountry;
  location_type: LocationTypeValue;
  address: string;
  status: LocationStatus;
  annual_rent: number | null;
  rent_currency: RentCurrency | null;
  payments_per_year: number | null;
  florist_member_ids?: number[];
};

type FloristOption = {
  id: number;
  label: string;
  floristLocationId: number | null;
};

function getCountryFlagEmoji(countryName: string): string {
  const entry = findCountryByName(countryName);
  if (!entry) return "";
  const code = entry.code.toUpperCase();
  return (
    String.fromCodePoint(0x1f1e6 + code.charCodeAt(0) - 65) +
    String.fromCodePoint(0x1f1e6 + code.charCodeAt(1) - 65)
  );
}

function StatusPill({ status, loading = false }: { status: LocationStatus; loading?: boolean }) {
  if (loading) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300 animate-pulse">
        <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
        Updating…
      </span>
    );
  }
  if (status === "active") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
        Active
      </span>
    );
  }
  if (status === "paused") {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300">
        <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
        Paused
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300">
      <span className="w-1.5 h-1.5 rounded-full bg-blue-400" />
      Setup incomplete
    </span>
  );
}

function CapacityBar({ load, capacity }: { load: number; capacity: number | null }) {
  if (capacity === null || capacity === 0) {
    return <span className="text-xs text-muted-foreground">Capacity not set</span>;
  }
  const pct = Math.min(100, Math.round((load / capacity) * 100));
  const color =
    pct > 90
      ? "bg-red-500"
      : pct > 70
      ? "bg-amber-500"
      : "bg-emerald-500";
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>Capacity load</span>
        <span className="font-medium">{pct}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function MetricCell({ label, value }: { label: string; value: string | number | null }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-semibold tabular-nums">{value ?? "—"}</p>
    </div>
  );
}

function SetupIncompleteSection({
  loc,
  isOwner,
  onActivate,
  isActivating,
}: {
  loc: Location;
  isOwner: boolean;
  onActivate: () => void;
  isActivating: boolean;
}) {
  const checklist: { label: string; done: boolean }[] = [
    { label: "Add devices", done: loc.device_count > 0 },
    { label: "Add products", done: loc.products_count > 0 },
    { label: "Add brands", done: loc.brands_count > 0 },
    { label: "Set operating hours", done: loc.has_operating_hours },
    { label: "Configure routing", done: loc.has_routing },
    { label: "Set capacity", done: loc.has_capacity },
  ];
  const completedCount = checklist.filter((c) => c.done).length;
  const total = checklist.length;
  const allDone = completedCount === total;
  const pct = Math.round((completedCount / total) * 100);
  const missing = checklist.filter((c) => !c.done);

  if (allDone) {
    return (
      <div className="space-y-3">
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="text-emerald-700 dark:text-emerald-400 font-medium flex items-center gap-1">
              <CheckCircle2 size={12} className="shrink-0" />
              All steps complete
            </span>
            <span className="text-emerald-700 dark:text-emerald-400">{total} of {total}</span>
          </div>
          <div className="h-1.5 rounded-full bg-muted overflow-hidden">
            <div className="h-full rounded-full bg-emerald-500 w-full" />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          This location is ready to go live. Activate it to start accepting orders.
        </p>
        {isOwner && (
          <Button
            size="sm"
            className="w-full gap-1.5 text-xs h-7 bg-emerald-600 hover:bg-emerald-700 text-white"
            onClick={onActivate}
            disabled={isActivating}
            data-testid="button-activate-location"
          >
            <CheckCircle2 size={12} />
            {isActivating ? "Activating…" : "Activate location"}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>Setup progress</span>
          <span>{completedCount} of {total} steps completed</span>
        </div>
        <div className="h-1.5 rounded-full bg-muted overflow-hidden">
          <div
            className="h-full rounded-full bg-amber-400"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
      {missing.length > 0 && (
        <div>
          <p className="text-xs font-medium text-muted-foreground mb-1">Missing items</p>
          <ul className="space-y-0.5">
            {missing.map((item) => (
              <li key={item.label} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Plus size={10} className="text-amber-500 shrink-0" />
                {item.label}
              </li>
            ))}
          </ul>
        </div>
      )}
      <Link href={`/locations/${loc.id}`}>
        <Button size="sm" variant="outline" className="w-full gap-1.5 text-xs h-7">
          <CheckSquare size={12} />
          Continue setup
        </Button>
      </Link>
    </div>
  );
}

function LocationCard({
  loc,
  isOwner,
  onEdit,
  onDelete,
  onPause,
  onResume,
  onActivate,
  isActivating,
  loading = false,
}: {
  loc: Location;
  isOwner: boolean;
  onEdit: (loc: Location) => void;
  onDelete: (loc: Location) => void;
  onPause: (loc: Location) => void;
  onResume: (loc: Location) => void;
  onActivate: (loc: Location) => void;
  isActivating: boolean;
  loading?: boolean;
}) {
  const isPaused = loc.status === "paused";
  const isSetupIncomplete = loc.status === "setup_incomplete";
  const isWarehouse = loc.location_type === "Central Warehouse";

  return (
    <Card
      data-testid={`location-card-${loc.id}`}
      className={`flex flex-col ${isPaused ? "opacity-80" : ""}`}
    >
      <div className="p-4 space-y-3">
        <div className="flex items-start gap-2">
          <div className="w-9 h-9 rounded-lg bg-secondary flex items-center justify-center shrink-0 mt-0.5">
            {isWarehouse ? <Building2 size={18} /> : <MapPin size={18} />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-semibold text-sm leading-tight truncate">{loc.name}</span>
              <StatusPill status={loc.status} loading={loading} />
            </div>
            <p className="text-xs text-muted-foreground mt-0.5">
              {loc.location_type} · {loc.country}
            </p>
          </div>
          {isOwner && (
            <div className="flex items-center gap-0.5 shrink-0">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => onEdit(loc)}
                data-testid={`button-edit-location-${loc.id}`}
              >
                <Pencil size={13} />
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0"
                    data-testid={`button-more-location-${loc.id}`}
                  >
                    <MoreHorizontal size={15} />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem asChild>
                    <Link href={`/locations/${loc.id}`}>
                      <span className="flex items-center gap-2">
                        <ArrowRight size={13} /> View details
                      </span>
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => onEdit(loc)}>
                    <Pencil size={13} className="mr-2" /> Edit
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {isPaused ? (
                    <DropdownMenuItem onClick={() => onResume(loc)}>
                      <CheckCircle2 size={13} className="mr-2 text-emerald-600" /> Resume
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem onClick={() => onPause(loc)}>
                      <PauseCircle size={13} className="mr-2 text-amber-600" /> Pause
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onClick={() => onDelete(loc)}
                    data-testid={`button-delete-location-${loc.id}`}
                  >
                    <X size={13} className="mr-2" /> Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          )}
        </div>

        {isSetupIncomplete ? (
          <SetupIncompleteSection
            loc={loc}
            isOwner={isOwner}
            onActivate={() => onActivate(loc)}
            isActivating={isActivating}
          />
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-x-2 gap-y-2">
              {isWarehouse ? (
                <>
                  <MetricCell label="Transfer jobs" value={isPaused ? 0 : "—"} />
                  <MetricCell label="Customer orders" value={isPaused ? 0 : loc.orders_today} />
                </>
              ) : (
                <>
                  <MetricCell label="Orders today" value={isPaused ? 0 : loc.orders_today} />
                  <MetricCell label="Pending prep" value={isPaused ? 0 : loc.pending_prep} />
                </>
              )}
              <MetricCell
                label="Devices"
                value={
                  isPaused
                    ? "0 Online · 0 Offline"
                    : `${loc.devices_online} Online · ${loc.devices_offline} Offline`
                }
              />
              <MetricCell label="Brands" value={isPaused ? 0 : loc.brands_count} />
              <MetricCell label="Products" value={isPaused ? 0 : loc.products_count} />
            </div>

            <CapacityBar
              load={isPaused ? 0 : loc.orders_today}
              capacity={loc.daily_capacity}
            />

            <div className="flex items-center justify-between">
              {isPaused && (
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5 text-xs h-7"
                  onClick={() => onResume(loc)}
                >
                  <CheckCircle2 size={12} className="text-emerald-600" />
                  Resume
                </Button>
              )}
              <Link href={`/locations/${loc.id}`} className={isPaused ? "" : "ml-auto"}>
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-1 text-xs h-7"
                  data-testid={`button-view-location-${loc.id}`}
                >
                  View <ArrowRight size={11} />
                </Button>
              </Link>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}

function LocationSummaryCards({ locations }: { locations: Location[] }) {
  const total = locations.length;
  const active = locations.filter((l) => l.status === "active").length;
  const paused = locations.filter((l) => l.status === "paused").length;
  const ordersToday = locations.reduce((sum, l) => sum + (l.orders_today ?? 0), 0);
  const deviceIssues = locations.reduce((sum, l) => sum + (l.devices_offline ?? 0), 0);

  const cards = [
    {
      label: "Total Locations",
      value: total,
      sub: `Across ${[...new Set(locations.map((l) => l.country))].length} countries`,
      icon: <MapPin size={20} className="text-indigo-500" />,
      bg: "bg-indigo-50 dark:bg-indigo-950",
    },
    {
      label: "Active",
      value: active,
      sub: total > 0 ? `${Math.round((active / total) * 100)}% of locations` : "No locations",
      icon: <CheckCircle2 size={20} className="text-emerald-500" />,
      bg: "bg-emerald-50 dark:bg-emerald-950",
    },
    {
      label: "Paused",
      value: paused,
      sub: total > 0 ? `${Math.round((paused / total) * 100)}% of locations` : "No locations",
      icon: <PauseCircle size={20} className="text-amber-500" />,
      bg: "bg-amber-50 dark:bg-amber-950",
    },
    {
      label: "Orders Today",
      value: ordersToday,
      sub: ordersToday > 0 ? "Across all locations" : "None yet today",
      icon: <ShoppingCart size={20} className="text-blue-500" />,
      bg: "bg-blue-50 dark:bg-blue-950",
    },
    {
      label: "Device Issues",
      value: deviceIssues,
      sub: deviceIssues > 0 ? "Needs attention" : "All devices online",
      icon: <MonitorX size={20} className={deviceIssues > 0 ? "text-red-500" : "text-muted-foreground"} />,
      bg: deviceIssues > 0 ? "bg-red-50 dark:bg-red-950" : "bg-muted/40",
    },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
      {cards.map((c) => (
        <Card key={c.label} className="p-4">
          <div className="flex items-center gap-3">
            <div className={`w-10 h-10 rounded-lg ${c.bg} flex items-center justify-center shrink-0`}>
              {c.icon}
            </div>
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground leading-tight">{c.label}</p>
              <p className="text-2xl font-bold tabular-nums leading-tight">{c.value}</p>
              <p className="text-xs text-muted-foreground leading-tight truncate">{c.sub}</p>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}

function LocationsAttentionBanner({ locations }: { locations: Location[] }) {
  const [dismissed, setDismissed] = useState(false);

  const issues = locations
    .filter(
      (l) =>
        l.status === "paused" ||
        l.status === "setup_incomplete" ||
        l.devices_offline > 0,
    )
    .map((l) => {
      if (l.status === "paused") return `${l.name}: location paused`;
      if (l.status === "setup_incomplete") return `${l.name}: setup incomplete`;
      return `${l.name}: ${l.devices_offline} device${l.devices_offline === 1 ? "" : "s"} offline`;
    });

  if (issues.length === 0 || dismissed) return null;

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 rounded-lg bg-amber-50 border border-amber-200 dark:bg-amber-950/40 dark:border-amber-800">
      <AlertTriangle size={16} className="text-amber-600 shrink-0" />
      <span className="text-sm font-medium text-amber-800 dark:text-amber-300 shrink-0">
        Needs attention
      </span>
      <div className="flex-1 flex flex-wrap gap-x-4 gap-y-1">
        {issues.slice(0, 3).map((issue) => (
          <span key={issue} className="text-xs text-amber-700 dark:text-amber-400 flex items-center gap-1">
            <span className="w-1 h-1 rounded-full bg-amber-500 inline-block" />
            {issue}
          </span>
        ))}
        {issues.length > 3 && (
          <span className="text-xs text-amber-600 dark:text-amber-400">
            +{issues.length - 3} more
          </span>
        )}
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 w-6 p-0 text-amber-600 hover:text-amber-800 shrink-0"
        onClick={() => setDismissed(true)}
      >
        <X size={13} />
      </Button>
    </div>
  );
}

type ViewMode = "cards" | "table" | "map";

function LocationForm({
  initial,
  onSubmit,
  isPending,
  onCancel,
  countryOptions,
  countryFlagUrls,
  countryLoading,
  existingNames = [],
  floristOptions = [],
  floristsLoaded = false,
  initialFloristIds = [],
}: {
  initial?: LocationFormData;
  onSubmit: (data: LocationFormData) => void;
  isPending: boolean;
  onCancel: () => void;
  countryOptions: string[];
  countryLoading?: boolean;
  existingNames?: string[];
  countryFlagUrls: Record<string, string | null>;
  floristOptions?: FloristOption[];
  floristsLoaded?: boolean;
  initialFloristIds?: number[];
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial?.name ?? "");
  const nameWarning = checkNameWarning(name, existingNames);
  const [country, setCountry] = useState<LocationCountry>(
    initial?.country ?? (countryOptions[0] ?? ""),
  );
  const [locationType, setLocationType] = useState<LocationTypeValue>(
    initial?.location_type ?? "Point of Sale",
  );
  const [address, setAddress] = useState(initial?.address ?? "");
  const [status, setStatus] = useState<LocationStatus>(initial?.status ?? "active");

  useEffect(() => {
    if (countryOptions.length > 0 && !countryOptions.includes(country)) {
      setCountry(
        initial?.country && countryOptions.includes(initial.country)
          ? initial.country
          : countryOptions[0],
      );
    }
  }, [countryOptions]);

  const [annualRent, setAnnualRent] = useState<string>(
    initial?.annual_rent != null ? String(initial.annual_rent) : "",
  );

  const formatRent = (raw: string) => {
    if (!raw) return "";
    const parts = raw.split(".");
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return parts.join(".");
  };

  const handleRentChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value.replace(/,/g, "").replace(/[^\d.]/g, "");
    const dotCount = (raw.match(/\./g) ?? []).length;
    if (dotCount <= 1) setAnnualRent(raw);
  };

  const [rentCurrency, setRentCurrency] = useState<RentCurrency | "">(
    initial?.rent_currency ?? "",
  );
  const [paymentsPerYear, setPaymentsPerYear] = useState<string>(
    initial?.payments_per_year != null ? String(initial.payments_per_year) : "",
  );

  const [selectedFloristIds, setSelectedFloristIds] =
    useState<number[]>(initialFloristIds);
  const [floristsInitialized, setFloristsInitialized] =
    useState<boolean>(floristsLoaded);

  useEffect(() => {
    if (floristsLoaded && !floristsInitialized) {
      setFloristsInitialized(true);
      setSelectedFloristIds(initialFloristIds);
    }
  }, [floristsLoaded, floristsInitialized, initialFloristIds]);

  const toggleFlorist = (memberId: number) => {
    setSelectedFloristIds((prev) =>
      prev.includes(memberId)
        ? prev.filter((id) => id !== memberId)
        : [...prev, memberId],
    );
  };

  const floristTriggerLabel =
    selectedFloristIds.length === 0
      ? t("locations.floristsPlaceholder")
      : selectedFloristIds.length === 1
        ? (floristOptions.find((o) => o.id === selectedFloristIds[0])?.label ??
          t("locations.floristsSelected", { count: 1 }))
        : t("locations.floristsSelected", { count: selectedFloristIds.length });

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="loc-name">Name</Label>
        <Input
          id="loc-name"
          placeholder="e.g. Beirut City Centre"
          value={name}
          onChange={(e) => setName(e.target.value)}
          data-testid="input-location-name"
          autoFocus
        />
        {nameWarning.exactMatch && (
          <p className="text-xs text-amber-600 dark:text-amber-400" data-testid="name-warning-exact">
            A location named &ldquo;{nameWarning.exactMatch}&rdquo; already exists.
          </p>
        )}
        {!nameWarning.exactMatch && nameWarning.similarMatches.length > 0 && (
          <p className="text-xs text-amber-600 dark:text-amber-400" data-testid="name-warning-similar">
            Similar location names already exist: {nameWarning.similarMatches.join(", ")}.
          </p>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="loc-type">Type</Label>
          <Select
            value={locationType}
            onValueChange={(v) => setLocationType(v as LocationTypeValue)}
          >
            <SelectTrigger id="loc-type" data-testid="select-location-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TYPE_OPTIONS.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="loc-status">Initial status</Label>
          <Select value={status} onValueChange={(v) => setStatus(v as LocationStatus)}>
            <SelectTrigger id="loc-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="setup_incomplete">Setup incomplete</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="loc-country">Country</Label>
        <Select
          value={country}
          onValueChange={(v) => setCountry(v)}
          disabled={countryLoading || countryOptions.length === 0}
        >
          <SelectTrigger id="loc-country" data-testid="select-location-country">
            <SelectValue
              placeholder={countryLoading ? "Loading countries…" : "Select country"}
            />
          </SelectTrigger>
          <SelectContent>
            {countryOptions.map((c) => (
              <SelectItem key={c} value={c}>
                <span className="inline-flex items-center gap-2">
                  <span aria-hidden="true">
                    <FlagImage country={c} url={countryFlagUrls[c] ?? null} size={14} />
                  </span>
                  {c}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="loc-address">Address</Label>
        <Input
          id="loc-address"
          placeholder="e.g. Hamra Street, Beirut"
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          data-testid="input-location-address"
        />
      </div>
      {floristsLoaded && floristOptions.length > 0 && (
        <div className="space-y-1.5">
          <Label>{t("locations.florists")}</Label>
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                className="w-full justify-between font-normal"
                data-testid="select-location-florists"
              >
                <span className="flex items-center gap-2 truncate">
                  <Flower2 size={14} className="shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="truncate">{floristTriggerLabel}</span>
                </span>
                <ChevronDown size={14} className="ms-2 shrink-0 text-muted-foreground" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-[--radix-popover-trigger-width] p-1" align="start">
              {floristOptions.map((opt) => {
                const checked = selectedFloristIds.includes(opt.id);
                return (
                  <div
                    key={opt.id}
                    role="option"
                    aria-selected={checked}
                    className="flex items-center gap-2 w-full rounded px-2 py-1.5 text-sm cursor-pointer select-none hover:bg-secondary/60 transition-colors"
                    onClick={() => toggleFlorist(opt.id)}
                    data-testid={`option-florist-${opt.id}`}
                  >
                    <span className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-primary ${checked ? "bg-primary text-primary-foreground" : "bg-background"}`}>
                      {checked && (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className="h-3 w-3">
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                    </span>
                    <span className="truncate">{opt.label}</span>
                  </div>
                );
              })}
            </PopoverContent>
          </Popover>
          <p className="text-xs text-muted-foreground">
            {t("locations.floristsHelp")}
          </p>
        </div>
      )}
      <div className="flex gap-2">
        <div className="space-y-1.5 flex-1">
          <Label htmlFor="loc-rent">Annual Rent</Label>
          <Input
            id="loc-rent"
            type="text"
            inputMode="decimal"
            placeholder="e.g. 24,000"
            value={formatRent(annualRent)}
            onChange={handleRentChange}
            data-testid="input-annual-rent"
          />
        </div>
        <div className="space-y-1.5 w-28">
          <Label htmlFor="loc-currency">Currency</Label>
          <Select
            value={rentCurrency}
            onValueChange={(v) => setRentCurrency(v as RentCurrency)}
          >
            <SelectTrigger id="loc-currency" data-testid="select-rent-currency">
              <SelectValue placeholder="—" />
            </SelectTrigger>
            <SelectContent>
              {CURRENCY_OPTIONS.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="loc-payments">Payments per Year</Label>
        <Input
          id="loc-payments"
          type="number"
          min="1"
          step="1"
          placeholder="e.g. 12"
          value={paymentsPerYear}
          onChange={(e) => setPaymentsPerYear(e.target.value)}
          data-testid="input-payments-per-year"
        />
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel} disabled={isPending}>
          Cancel
        </Button>
        <Button
          onClick={() =>
            onSubmit({
              name: name.trim(),
              country,
              location_type: locationType,
              address: address.trim(),
              status,
              annual_rent: annualRent !== "" ? parseFloat(annualRent) : null,
              rent_currency: rentCurrency !== "" ? rentCurrency : null,
              payments_per_year:
                paymentsPerYear !== "" ? parseInt(paymentsPerYear, 10) : null,
              ...(floristsLoaded
                ? { florist_member_ids: selectedFloristIds }
                : {}),
            })
          }
          disabled={isPending || !name.trim() || !country || countryLoading}
          data-testid="button-confirm-location"
        >
          {isPending ? "Saving…" : "Save"}
        </Button>
      </DialogFooter>
    </div>
  );
}

type WorkspaceSettings = {
  available_countries?: string[];
  available_country_details?: Array<{
    name: string;
    code: string | null;
    flagImageUrl: string | null;
  }>;
};

export default function LocationsPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { isOwner } = useWorkspaceRole();

  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [editingLocation, setEditingLocation] = useState<Location | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Location | null>(null);
  const [pauseTarget, setPauseTarget] = useState<Location | null>(null);

  const [search, setSearch] = useState("");
  const [filterCountry, setFilterCountry] = useState<string>("all");
  const [filterType, setFilterType] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [viewMode, setViewMode] = useState<ViewMode>("cards");

  const { data, isLoading } = useQuery({
    queryKey: ["locations"],
    queryFn: () => apiFetch<{ locations: Location[] }>("/api/locations"),
  });

  const { data: settingsData, isLoading: settingsLoading } = useQuery<WorkspaceSettings>({
    queryKey: ["workspace-settings"],
    queryFn: () => apiFetch<WorkspaceSettings>("/api/settings"),
  });

  type UsersResponse = {
    members: Array<{
      id: number;
      email: string;
      role: "owner" | "member";
      custom_role_id: number | null;
      florist_location_id: number | null;
      first_name: string | null;
      last_name: string | null;
    }>;
  };

  const { data: usersData } = useQuery({
    queryKey: ["users"],
    queryFn: () => apiFetch<UsersResponse>("/api/users"),
    enabled: isOwner,
  });
  const { data: rolesData } = useRoles();

  const floristsLoaded = !!usersData && !!rolesData;

  const floristOptions: FloristOption[] = (() => {
    if (!floristsLoaded) return [];
    const floristRoleIds = new Set(
      (rolesData?.roles ?? [])
        .filter((r) => r.allowed_pages?.includes("florist_orders"))
        .map((r) => r.id),
    );
    return (usersData?.members ?? [])
      .filter(
        (m) =>
          m.role !== "owner" &&
          m.custom_role_id !== null &&
          floristRoleIds.has(m.custom_role_id),
      )
      .map((m) => {
        const fullName = [m.first_name, m.last_name].filter(Boolean).join(" ");
        return {
          id: m.id,
          label: fullName ? `${fullName} (${m.email})` : m.email,
          floristLocationId: m.florist_location_id,
        };
      });
  })();

  const countryOptions: string[] = settingsLoading
    ? []
    : (() => {
        const fromSettings = (settingsData?.available_countries ?? []).filter(
          (c) => !isExcludedCountry(c),
        );
        return fromSettings.length > 0 ? fromSettings : DEFAULT_COUNTRIES;
      })();

  const countryFlagUrls: Record<string, string | null> = (() => {
    const map: Record<string, string | null> = {};
    for (const d of settingsData?.available_country_details ?? []) {
      map[d.name] = d.flagImageUrl;
    }
    return map;
  })();

  const createMutation = useMutation({
    mutationFn: (body: LocationFormData) =>
      apiFetch<{ location: Location }>("/api/locations", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["locations"] });
      queryClient.invalidateQueries({ queryKey: ["users"] });
      setIsCreateOpen(false);
      toast({ title: "Location created" });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to create location",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, ...body }: { id: number } & LocationFormData) =>
      apiFetch<{ location: Location }>(`/api/locations/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["locations"] });
      queryClient.invalidateQueries({ queryKey: ["users"] });
      setEditingLocation(null);
      toast({ title: "Location updated" });
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to update location",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/api/locations/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["locations"] });
      queryClient.invalidateQueries({ queryKey: ["devices"] });
      setDeleteTarget(null);
      toast({ title: "Location deleted" });
    },
  });

  const [pendingActionIds, setPendingActionIds] = useState<Set<number>>(new Set());

  const pauseMutation = useMutation({
    mutationFn: ({ id }: { id: number }) =>
      apiFetch(`/api/locations/${id}/pause`, { method: "POST", body: JSON.stringify({}) }),
    onMutate: ({ id }) => {
      setPendingActionIds((prev) => new Set(prev).add(id));
      setPauseTarget(null);
    },
    onSuccess: async (_, { id }) => {
      await queryClient.invalidateQueries({ queryKey: ["locations"] });
      setPendingActionIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      toast({ title: "Location paused" });
    },
    onError: (_, { id }) => {
      setPendingActionIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    },
  });

  const resumeMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/api/locations/${id}/resume`, { method: "POST", body: JSON.stringify({}) }),
    onMutate: (id) => {
      setPendingActionIds((prev) => new Set(prev).add(id));
    },
    onSuccess: async (_, id) => {
      await queryClient.invalidateQueries({ queryKey: ["locations"] });
      setPendingActionIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      toast({ title: "Location resumed" });
    },
    onError: (_, id) => {
      setPendingActionIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    },
  });

  const activateMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/api/locations/${id}/resume`, { method: "POST", body: JSON.stringify({}) }),
    onMutate: (id) => {
      setPendingActionIds((prev) => new Set(prev).add(id));
    },
    onSuccess: async (_, id) => {
      await queryClient.invalidateQueries({ queryKey: ["locations"] });
      setPendingActionIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      toast({ title: "Location activated", description: "The location is now live." });
    },
    onError: (_, id) => {
      setPendingActionIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    },
  });

  const locations = data?.locations ?? [];

  const allCountries = [...new Set(locations.map((l) => l.country))].sort();

  const filtered = locations.filter((l) => {
    if (
      search &&
      !l.name.toLowerCase().includes(search.toLowerCase()) &&
      !l.country.toLowerCase().includes(search.toLowerCase())
    )
      return false;
    if (filterCountry !== "all" && l.country !== filterCountry) return false;
    if (filterType !== "all" && l.location_type !== filterType) return false;
    if (filterStatus !== "all" && l.status !== filterStatus) return false;
    return true;
  });

  const hasFilters =
    search !== "" ||
    filterCountry !== "all" ||
    filterType !== "all" ||
    filterStatus !== "all";

  const grouped = filtered.reduce<Record<string, Location[]>>((acc, loc) => {
    const key = loc.country || "__unassigned__";
    if (!acc[key]) acc[key] = [];
    acc[key].push(loc);
    return acc;
  }, {});

  const sortedGroups = Object.keys(grouped)
    .sort((a, b) => {
      if (a === "__unassigned__") return 1;
      if (b === "__unassigned__") return -1;
      return a.localeCompare(b);
    });

  const clearFilters = () => {
    setSearch("");
    setFilterCountry("all");
    setFilterType("all");
    setFilterStatus("all");
  };

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t("locations.title")}</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Organise your devices and operations by physical point of sale.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <StaleDataBadge
            queries={[{ queryKey: ["locations"], url: "/api/locations" }]}
            data-testid="locations-stale-badge"
          />
          {isOwner && (
            <Button
              onClick={() => setIsCreateOpen(true)}
              className="gap-2"
              data-testid="button-new-location"
            >
              <Plus size={16} />
              New location
            </Button>
          )}
        </div>
      </div>

      {!isLoading && locations.length > 0 && (
        <LocationSummaryCards locations={locations} />
      )}

      {!isLoading && locations.length > 0 && (
        <LocationsAttentionBanner locations={locations} />
      )}

      {!isLoading && locations.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-48">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <Input
              placeholder="Search locations…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 h-9"
              data-testid="input-search-locations"
            />
          </div>
          <Select value={filterCountry} onValueChange={setFilterCountry}>
            <SelectTrigger className="w-36 h-9" data-testid="filter-country">
              <SelectValue placeholder="Country" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All countries</SelectItem>
              {allCountries.map((c) => (
                <SelectItem key={c} value={c}>
                  {getCountryFlagEmoji(c)} {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={filterType} onValueChange={setFilterType}>
            <SelectTrigger className="w-40 h-9" data-testid="filter-type">
              <SelectValue placeholder="Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              {TYPE_OPTIONS.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={filterStatus} onValueChange={setFilterStatus}>
            <SelectTrigger className="w-36 h-9" data-testid="filter-status">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="paused">Paused</SelectItem>
              <SelectItem value="setup_incomplete">Setup incomplete</SelectItem>
            </SelectContent>
          </Select>
          <div className="flex items-center border rounded-md overflow-hidden h-9">
            <Button
              variant={viewMode === "cards" ? "default" : "ghost"}
              size="sm"
              className="h-9 rounded-none px-3 gap-1.5"
              onClick={() => setViewMode("cards")}
            >
              <LayoutGrid size={14} /> Cards
            </Button>
            <Button
              variant={viewMode === "table" ? "default" : "ghost"}
              size="sm"
              className="h-9 rounded-none px-3 gap-1.5 border-x"
              onClick={() => setViewMode("table")}
            >
              <Table2 size={14} /> Table
            </Button>
            <Button
              variant={viewMode === "map" ? "default" : "ghost"}
              size="sm"
              className="h-9 rounded-none px-3 gap-1.5"
              onClick={() => setViewMode("map")}
            >
              <Map size={14} /> Map
            </Button>
          </div>
        </div>
      )}

      {isLoading ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            {t("common.loading")}
          </CardContent>
        </Card>
      ) : locations.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 space-y-4 text-center">
          <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center">
            <MapPin className="w-8 h-8 text-muted-foreground" />
          </div>
          <div>
            <p className="font-semibold text-lg">No locations yet</p>
            <p className="text-sm text-muted-foreground mt-1">
              Add your first location to start organising your operations.
            </p>
          </div>
          {isOwner && (
            <Button onClick={() => setIsCreateOpen(true)} className="gap-2">
              <Plus size={16} />
              New location
            </Button>
          )}
        </div>
      ) : viewMode === "table" ? (
        <div className="flex flex-col items-center justify-center py-16 space-y-2 text-center border rounded-xl">
          <Table2 size={32} className="text-muted-foreground" />
          <p className="font-medium text-muted-foreground">Table view coming soon</p>
        </div>
      ) : viewMode === "map" ? (
        <div className="flex flex-col items-center justify-center py-16 space-y-2 text-center border rounded-xl">
          <Map size={32} className="text-muted-foreground" />
          <p className="font-medium text-muted-foreground">Map view coming soon</p>
        </div>
      ) : filtered.length === 0 && hasFilters ? (
        <div className="flex flex-col items-center justify-center py-16 space-y-3 text-center">
          <Search size={32} className="text-muted-foreground" />
          <div>
            <p className="font-medium">No locations match your filters</p>
            <p className="text-sm text-muted-foreground">
              Try adjusting your search or filters.
            </p>
          </div>
          <Button variant="outline" onClick={clearFilters}>
            Clear filters
          </Button>
        </div>
      ) : (
        <div className="space-y-6">
          {sortedGroups.map((groupKey) => {
            const groupLocs = grouped[groupKey];
            const displayName = groupKey === "__unassigned__" ? "Unassigned country" : groupKey;
            const flag = groupKey !== "__unassigned__" ? getCountryFlagEmoji(groupKey) : "";
            return (
              <div key={groupKey} className="space-y-3">
                <div className="flex items-center gap-2">
                  {flag && <span className="text-lg">{flag}</span>}
                  <h2 className="font-semibold text-sm">{displayName}</h2>
                  <Badge variant="secondary" className="text-xs">
                    {groupLocs.length} {groupLocs.length === 1 ? "location" : "locations"}
                  </Badge>
                </div>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {groupLocs.map((loc) => (
                    <LocationCard
                      key={loc.id}
                      loc={loc}
                      isOwner={isOwner}
                      onEdit={setEditingLocation}
                      onDelete={setDeleteTarget}
                      onPause={setPauseTarget}
                      onResume={(l) => {
                        resumeMutation.mutate(l.id);
                      }}
                      onActivate={(l) => {
                        activateMutation.mutate(l.id);
                      }}
                      isActivating={pendingActionIds.has(loc.id)}
                      loading={pendingActionIds.has(loc.id)}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Dialog open={isCreateOpen} onOpenChange={setIsCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New location</DialogTitle>
            <DialogDescription>
              Add a new location to your workspace.
            </DialogDescription>
          </DialogHeader>
          <LocationForm
            onSubmit={(formData) => createMutation.mutate(formData)}
            isPending={createMutation.isPending}
            onCancel={() => setIsCreateOpen(false)}
            countryOptions={countryOptions}
            countryFlagUrls={countryFlagUrls}
            countryLoading={settingsLoading}
            existingNames={locations.map((l) => l.name)}
            floristOptions={floristOptions}
            floristsLoaded={floristsLoaded}
            initialFloristIds={[]}
          />
        </DialogContent>
      </Dialog>

      <Dialog
        open={editingLocation !== null}
        onOpenChange={(open) => !open && setEditingLocation(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit location</DialogTitle>
            <DialogDescription>
              Update the details of this location.
            </DialogDescription>
          </DialogHeader>
          {editingLocation && (
            <LocationForm
              initial={{
                name: editingLocation.name,
                country: editingLocation.country,
                location_type: editingLocation.location_type,
                address: editingLocation.address ?? "",
                status: editingLocation.status,
                annual_rent: editingLocation.annual_rent,
                rent_currency: editingLocation.rent_currency,
                payments_per_year: editingLocation.payments_per_year,
              }}
              onSubmit={(body) =>
                updateMutation.mutate({ id: editingLocation.id, ...body })
              }
              isPending={updateMutation.isPending}
              onCancel={() => setEditingLocation(null)}
              countryOptions={countryOptions}
              countryFlagUrls={countryFlagUrls}
              countryLoading={settingsLoading}
              existingNames={locations
                .filter((l) => l.id !== editingLocation.id)
                .map((l) => l.name)}
              floristOptions={floristOptions}
              floristsLoaded={floristsLoaded}
              initialFloristIds={floristOptions
                .filter((o) => o.floristLocationId === editingLocation.id)
                .map((o) => o.id)}
            />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent data-testid="dialog-delete-location">
          <DialogHeader>
            <DialogTitle>Delete location?</DialogTitle>
            <DialogDescription>
              Deleting <strong>{deleteTarget?.name}</strong> will unassign its{" "}
              {deleteTarget?.device_count === 1
                ? "1 device"
                : `${deleteTarget?.device_count ?? 0} devices`}{" "}
              but will not delete them.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
              disabled={deleteMutation.isPending}
              data-testid="button-confirm-delete-location"
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={pauseTarget !== null} onOpenChange={(open) => !open && setPauseTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Pause location?</DialogTitle>
            <DialogDescription>
              Pausing <strong>{pauseTarget?.name}</strong> will stop it from receiving new
              orders. You can resume it at any time.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPauseTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="default"
              onClick={() => pauseTarget && pauseMutation.mutate({ id: pauseTarget.id })}
              disabled={pauseMutation.isPending}
            >
              {pauseMutation.isPending ? "Pausing…" : "Pause location"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
