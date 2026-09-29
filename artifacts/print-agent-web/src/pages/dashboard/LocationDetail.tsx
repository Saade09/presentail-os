import { useState, useRef, useEffect } from "react";
import { WorkspaceImage } from "@/components/WorkspaceImage";
import { useParams, Link } from "wouter";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  MapPin,
  ArrowLeft,
  Smartphone,
  Circle,
  X,
  Plus,
  PrinterIcon,
  FileText,
  AlertTriangle,
  Tag,
  Users,
  ShoppingBag,
  Settings,
  BarChart2,
  Layers,
  Clock,
  Zap,
  TrendingUp,
  TrendingDown,
  Package,
  Truck,
  ChevronRight,
  MoreHorizontal,
  PauseCircle,
  PlayCircle,
  Building2,
  Search,
  RotateCcw,
  CheckCircle2,
  XCircle,
  Info,
  Globe,
  ToggleLeft,
  ToggleRight,
  Activity,
} from "lucide-react";
import { apiFetch, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
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
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";

type LocationActivityEvent = {
  event_type: "device_heartbeat" | "brand_linked" | "brand_removed" | "member_added" | "member_removed" | "job_completed";
  occurred_at: string;
  subject_name: string | null;
  subject_id: string | null;
  actor_name: string | null;
};

type LocationInfo = {
  id: number;
  name: string;
  country: string;
  location_type: string;
  annual_rent: number | null;
  rent_currency: string | null;
  payments_per_year: number | null;
  status: string | null;
  daily_capacity: number | null;
  same_day_cutoff_time: string | null;
  express_cutoff_time: string | null;
  operating_hours: Record<string, { open: string; close: string; closed?: boolean }> | null;
  timezone: string | null;
  backup_location_id: number | null;
  backup_location_name: string | null;
  auto_routing_enabled: boolean | null;
  served_area_ids: number[] | null;
  paused_at: string | null;
  paused_by: string | null;
  pause_reason: string | null;
  internal_notes: string | null;
  address: string | null;
};

type Device = {
  id: number;
  name: string;
  machine_id: string;
  os: string | null;
  agent_version: string | null;
  printers: string[];
  last_seen_at: string;
  created_at: string;
  location_id: number | null;
  location_name: string | null;
};

type LocationDetailData = {
  location: LocationInfo;
  devices: Device[];
};

type LocationStats = {
  total_jobs: number;
  total_pages: number;
  recent_errors: number;
  orders_today: number;
  orders_yesterday: number;
  pending_prep: number;
  ready_for_dispatch: number;
  at_risk: number;
};

type AllDevicesData = {
  devices: Device[];
};

type LocationBrand = { id: number; name: string; primary_logo_id: number | null };
type AllBrandsData = { brands: LocationBrand[] };

type LocationMember = { id: number; email: string; role: string; role_name: string | null };
type AllMembersData = { members: LocationMember[] };

type LocationProduct = {
  id: number;
  name: string;
  status: string;
  brand: string | null;
  category: string | null;
  main_image_url: string | null;
  price_usd?: number | null;
};

type DeliveryCity = {
  id: number;
  name: string;
  country: string;
  is_active: boolean;
};

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function isOnline(iso: string): boolean {
  return Date.now() - new Date(iso).getTime() < 5 * 60 * 1000;
}

function formatRent(location: LocationInfo): string | null {
  if (location.annual_rent == null) return null;
  const n = Number(location.annual_rent);
  if (location.rent_currency === "AED") return `AED ${n.toLocaleString()}`;
  if (location.rent_currency === "USD") return `$${n.toLocaleString()}`;
  return n.toLocaleString();
}

function StatusPill({ status, loading = false }: { status: string | null; loading?: boolean }) {
  if (loading) {
    return (
      <Badge
        data-testid="location-status-pill"
        variant="outline"
        className="bg-blue-50 text-blue-700 border-blue-200 animate-pulse"
      >
        Updating…
      </Badge>
    );
  }
  const s = status ?? "active";
  if (s === "paused") return <Badge data-testid="location-status-pill" variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">Paused</Badge>;
  if (s === "inactive") return <Badge data-testid="location-status-pill" variant="outline" className="bg-red-50 text-red-700 border-red-200">Inactive</Badge>;
  return <Badge data-testid="location-status-pill" variant="outline" className="bg-green-50 text-green-700 border-green-200">Active</Badge>;
}

function KpiCard({
  icon: Icon,
  label,
  value,
  badge,
  iconClass = "",
  valueClass = "",
}: {
  icon: React.ElementType;
  label: string;
  value: string | number;
  badge?: React.ReactNode;
  iconClass?: string;
  valueClass?: string;
}) {
  return (
    <Card>
      <CardContent className="py-4 px-5 flex items-center gap-3">
        <div className={`w-9 h-9 rounded-md flex items-center justify-center shrink-0 ${iconClass || "bg-secondary"}`}>
          <Icon size={16} className={valueClass} />
        </div>
        <div className="min-w-0">
          <div className="flex items-baseline gap-1.5">
            <span className={`text-2xl font-bold ${valueClass}`}>{value}</span>
            {badge}
          </div>
          <div className="text-xs text-muted-foreground">{label}</div>
        </div>
      </CardContent>
    </Card>
  );
}

function ProductThumb({ url }: { url: string | null }) {
  const src = url
    ? (url.startsWith("/objects/")
        ? `/api/storage${url}`
        : url.startsWith("http")
        ? url
        : `/api/storage${url}`)
    : null;
  return (
    <div className="shrink-0 w-9 h-9 rounded-md overflow-hidden border border-border bg-muted flex items-center justify-center">
      {src ? (
        <img src={src} alt="" className="w-full h-full object-cover" />
      ) : (
        <ShoppingBag size={14} className="text-muted-foreground" />
      )}
    </div>
  );
}

function AvailabilityPill({ status }: { status: string }) {
  if (status === "available") return <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200 text-xs">Available</Badge>;
  if (status === "out_of_stock") return <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200 text-xs">Out of Stock</Badge>;
  return <Badge variant="outline" className="bg-gray-50 text-gray-600 border-gray-200 text-xs">N/A</Badge>;
}

export default function LocationDetailPage() {
  const { t } = useTranslation();
  const params = useParams<{ id: string }>();
  const locationId = parseInt(params.id, 10);
  const { toast } = useToast();
  const { isOwner } = useWorkspaceRole();

  const [activeTab, setActiveTab] = useState("overview");
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [selectedDeviceId, setSelectedDeviceId] = useState<string>("");
  const [isAddBrandOpen, setIsAddBrandOpen] = useState(false);
  const [selectedBrandId, setSelectedBrandId] = useState<string>("");
  const [isAddMemberOpen, setIsAddMemberOpen] = useState(false);
  const [selectedMemberId, setSelectedMemberId] = useState<string>("");
  const [isPauseDialogOpen, setIsPauseDialogOpen] = useState(false);
  const [pauseReason, setPauseReason] = useState("");
  const [productSearch, setProductSearch] = useState("");
  const [statusUpdating, setStatusUpdating] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["location-detail", locationId],
    queryFn: () =>
      apiFetch<LocationDetailData>(`/api/locations/${locationId}/devices`),
    enabled: !Number.isNaN(locationId),
  });

  const { data: allDevicesData } = useQuery({
    queryKey: ["devices"],
    queryFn: () => apiFetch<AllDevicesData>("/api/devices"),
  });

  const { data: locationBrandsData } = useQuery({
    queryKey: ["location-brands", locationId],
    queryFn: () => apiFetch<{ brands: LocationBrand[] }>(`/api/locations/${locationId}/brands`),
    enabled: !Number.isNaN(locationId),
  });

  const { data: allBrandsData } = useQuery({
    queryKey: ["brands"],
    queryFn: () => apiFetch<AllBrandsData>("/api/brands"),
  });

  const { data: statsData } = useQuery({
    queryKey: ["location-stats", locationId],
    queryFn: () =>
      apiFetch<{ stats: LocationStats }>(`/api/locations/${locationId}/stats`),
    enabled: !Number.isNaN(locationId),
  });

  const { data: locationMembersData } = useQuery({
    queryKey: ["location-members", locationId],
    queryFn: () => apiFetch<{ members: LocationMember[] }>(`/api/locations/${locationId}/members`),
    enabled: !Number.isNaN(locationId) && isOwner,
  });

  const { data: allMembersData } = useQuery({
    queryKey: ["users"],
    queryFn: () => apiFetch<AllMembersData>("/api/users"),
    enabled: isOwner,
  });

  const { data: locationProductsData } = useQuery({
    queryKey: ["location-products", locationId],
    queryFn: () => apiFetch<{ products: LocationProduct[] }>(`/api/products/by-location/${locationId}`),
    enabled: !Number.isNaN(locationId),
  });

  const { data: activityData } = useQuery({
    queryKey: ["location-activity", locationId],
    queryFn: () =>
      apiFetch<{ events: LocationActivityEvent[] }>(`/api/locations/${locationId}/activity`),
    enabled: !Number.isNaN(locationId),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    staleTime: 20_000,
  });

  const { data: deliveryCitiesData } = useQuery({
    queryKey: ["delivery-cities"],
    queryFn: () => apiFetch<{ cities: DeliveryCity[] }>("/api/cities"),
  });

  const invalidateLocation = async () => {
    await queryClient.invalidateQueries({ queryKey: ["location-detail", locationId] });
    await queryClient.invalidateQueries({ queryKey: ["location-stats", locationId] });
    await queryClient.invalidateQueries({ queryKey: ["locations"] });
  };

  const assignMutation = useMutation({
    mutationFn: ({ deviceId, locId }: { deviceId: number; locId: number | null }) =>
      apiFetch(`/api/devices/${deviceId}/location`, {
        method: "PATCH",
        body: JSON.stringify({ location_id: locId }),
      }),
    onMutate: () => { setStatusUpdating(true); },
    onSuccess: async () => {
      await invalidateLocation();
      await queryClient.invalidateQueries({ queryKey: ["devices"] });
      setStatusUpdating(false);
    },
    onError: () => { setStatusUpdating(false); },
  });

  const addMemberMutation = useMutation({
    mutationFn: (memberId: number) =>
      apiFetch(`/api/locations/${locationId}/members`, {
        method: "POST",
        body: JSON.stringify({ member_id: memberId }),
      }),
    onMutate: () => { setStatusUpdating(true); },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["location-members", locationId] });
      await queryClient.invalidateQueries({ queryKey: ["users"] });
      setIsAddMemberOpen(false);
      setSelectedMemberId("");
      setStatusUpdating(false);
      toast({ title: "Member added to location" });
    },
    onError: () => { setStatusUpdating(false); },
  });

  const removeMemberMutation = useMutation({
    mutationFn: (memberId: number) =>
      apiFetch(`/api/locations/${locationId}/members/${memberId}`, { method: "DELETE" }),
    onMutate: () => { setStatusUpdating(true); },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["location-members", locationId] });
      await queryClient.invalidateQueries({ queryKey: ["users"] });
      setStatusUpdating(false);
      toast({ title: "Member removed from location" });
    },
    onError: () => { setStatusUpdating(false); },
  });

  const addBrandMutation = useMutation({
    mutationFn: (brandId: number) =>
      apiFetch(`/api/locations/${locationId}/brands`, {
        method: "POST",
        body: JSON.stringify({ brand_id: brandId }),
      }),
    onMutate: () => { setStatusUpdating(true); },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["location-brands", locationId] });
      await invalidateLocation();
      setIsAddBrandOpen(false);
      setSelectedBrandId("");
      setStatusUpdating(false);
      toast({ title: t("locations.brandAdded") });
    },
    onError: () => { setStatusUpdating(false); },
  });

  const removeBrandMutation = useMutation({
    mutationFn: (brandId: number) =>
      apiFetch(`/api/locations/${locationId}/brands/${brandId}`, { method: "DELETE" }),
    onMutate: () => { setStatusUpdating(true); },
    onSuccess: async (_, brandId) => {
      await queryClient.invalidateQueries({ queryKey: ["location-brands", locationId] });
      await invalidateLocation();
      const name = locationBrandsData?.brands.find((b) => b.id === brandId)?.name ?? "Brand";
      setStatusUpdating(false);
      toast({ title: t("locations.brandRemoved", { name }) });
    },
    onError: () => { setStatusUpdating(false); },
  });

  const pauseMutation = useMutation({
    mutationFn: (reason: string) =>
      apiFetch(`/api/locations/${locationId}/pause`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      }),
    onMutate: () => { setStatusUpdating(true); },
    onSuccess: async () => {
      await invalidateLocation();
      setIsPauseDialogOpen(false);
      setPauseReason("");
      setStatusUpdating(false);
      toast({ title: "Location paused" });
    },
    onError: () => { setStatusUpdating(false); },
  });

  const resumeMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/locations/${locationId}/resume`, { method: "POST" }),
    onMutate: () => { setStatusUpdating(true); },
    onSuccess: async () => {
      await invalidateLocation();
      setStatusUpdating(false);
      toast({ title: "Location resumed" });
    },
    onError: () => { setStatusUpdating(false); },
  });

  const handleAdd = () => {
    const devId = parseInt(selectedDeviceId, 10);
    if (Number.isNaN(devId)) return;
    assignMutation.mutate(
      { deviceId: devId, locId: locationId },
      {
        onSuccess: () => {
          setIsAddOpen(false);
          setSelectedDeviceId("");
          toast({ title: t("locations.deviceAssigned") });
        },
      },
    );
  };

  const handleRemove = (deviceId: number, deviceName: string) => {
    assignMutation.mutate(
      { deviceId, locId: null },
      {
        onSuccess: () => {
          toast({ title: t("locations.deviceRemoved", { name: deviceName }) });
        },
      },
    );
  };

  if (isLoading) {
    return (
      <div className="text-center py-12 text-muted-foreground">{t("common.loading")}</div>
    );
  }

  if (!data) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        {t("locations.locationNotFound")}
      </div>
    );
  }

  const { location, devices } = data;
  const stats = statsData?.stats;

  const allDevices = allDevicesData?.devices ?? [];
  const assignedIds = new Set(devices.map((d) => d.id));
  const unassignedDevices = allDevices.filter((d) => !assignedIds.has(d.id));

  const locationBrands = locationBrandsData?.brands ?? [];
  const allBrands = allBrandsData?.brands ?? [];
  const assignedBrandIds = new Set(locationBrands.map((b) => b.id));
  const unassignedBrands = allBrands.filter((b) => !assignedBrandIds.has(b.id));
  const isPOS = location.location_type === "Point of Sale";

  const locationMembers = locationMembersData?.members ?? [];
  const allWorkspaceMembers = (allMembersData as { members?: LocationMember[] } | undefined)?.members ?? [];
  const assignedMemberIds = new Set(locationMembers.map((m) => m.id));
  const unassignedMembers = allWorkspaceMembers.filter(
    (m) => !assignedMemberIds.has(m.id) && m.role !== "owner",
  );

  const allDeliveryCities = deliveryCitiesData?.cities ?? [];
  const servedAreaIds = location.served_area_ids ?? [];
  const servedCities = allDeliveryCities.filter((c) => servedAreaIds.includes(c.id));

  const locationProducts = locationProductsData?.products ?? [];
  const filteredProducts = locationProducts.filter((p) =>
    productSearch === "" ||
    p.name.toLowerCase().includes(productSearch.toLowerCase()) ||
    (p.brand ?? "").toLowerCase().includes(productSearch.toLowerCase()) ||
    (p.category ?? "").toLowerCase().includes(productSearch.toLowerCase()),
  );
  const previewProducts = filteredProducts.slice(0, 5);

  const onlineDevices = devices.filter((d) => isOnline(d.last_seen_at));
  const offlineDevices = devices.filter((d) => !isOnline(d.last_seen_at));
  const deviceErrors = stats?.recent_errors ?? 0;

  // Capacity progress
  const capacity = location.daily_capacity ?? 0;
  const currentLoad = stats?.orders_today ?? 0;
  const capacityPct = capacity > 0 ? Math.min(100, Math.round((currentLoad / capacity) * 100)) : 0;
  const capacityColor = capacityPct >= 90 ? "bg-destructive" : capacityPct >= 70 ? "bg-amber-500" : "bg-green-500";

  const rentStr = formatRent(location);
  const locationStatus = location.status ?? "active";

  const rawActivityEvents = activityData?.events ?? [];

  function activityEventMeta(ev: LocationActivityEvent): {
    icon: React.ElementType;
    color: string;
    label: string;
  } {
    const name = ev.subject_name ?? "Unknown";
    const by = ev.actor_name ? ` by ${ev.actor_name}` : "";
    switch (ev.event_type) {
      case "device_heartbeat":
        return {
          icon: Smartphone,
          color: "text-green-500",
          label: `${name} checked in`,
        };
      case "brand_linked":
        return {
          icon: Tag,
          color: "text-blue-500",
          label: `${name} linked to this location${by}`,
        };
      case "brand_removed":
        return {
          icon: Tag,
          color: "text-red-400",
          label: `${name} removed from this location${by}`,
        };
      case "member_added":
        return {
          icon: Users,
          color: "text-violet-500",
          label: `${name} added to this location${by}`,
        };
      case "member_removed":
        return {
          icon: Users,
          color: "text-red-400",
          label: `${name} removed from this location${by}`,
        };
      case "job_completed":
        return {
          icon: PrinterIcon,
          color: "text-emerald-500",
          label: `Print job completed${name ? `: ${name}` : ""}`,
        };
    }
  }

  return (
    <div className="space-y-6">
      {/* Back nav */}
      <div>
        <Link href="/locations">
          <Button variant="ghost" size="sm" className="gap-1.5 -ml-2 mb-4 text-muted-foreground">
            <ArrowLeft size={14} />
            {t("locations.title")}
          </Button>
        </Link>

        {/* Header */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl bg-secondary flex items-center justify-center shrink-0">
              <MapPin size={22} />
            </div>
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <h1 className="text-2xl font-bold tracking-tight">{location.name}</h1>
                <StatusPill status={locationStatus} loading={statusUpdating} />
              </div>
              <p className="text-sm text-muted-foreground mt-0.5">
                {location.location_type} · {location.country}
              </p>
              {(rentStr || location.payments_per_year != null) && (
                <div className="flex flex-wrap gap-3 mt-1 text-xs text-muted-foreground">
                  {rentStr && (
                    <span><span className="font-medium text-foreground">{rentStr}</span> annual rent</span>
                  )}
                  {location.payments_per_year != null && (
                    <span>
                      <span className="font-medium text-foreground">{location.payments_per_year}</span>
                      {" "}{location.payments_per_year === 1 ? "payment" : "payments"} per year
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Action buttons */}
          {isOwner && (
            <div className="flex items-center gap-2 flex-wrap">
              {locationStatus === "paused" ? (
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-2"
                  onClick={() => resumeMutation.mutate()}
                  disabled={resumeMutation.isPending}
                  data-testid="button-resume-location"
                >
                  <PlayCircle size={14} />
                  Resume Location
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-2 text-amber-700 border-amber-300 hover:bg-amber-50"
                  onClick={() => setIsPauseDialogOpen(true)}
                  data-testid="button-pause-location"
                >
                  <PauseCircle size={14} />
                  Pause Location
                </Button>
              )}
              {isPOS && (
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-2"
                  onClick={() => { setActiveTab("overview"); setIsAddBrandOpen(true); }}
                  disabled={unassignedBrands.length === 0}
                >
                  <Plus size={14} />
                  Assign Brand
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                className="gap-2"
                onClick={() => { setActiveTab("team-devices"); setIsAddOpen(true); }}
              >
                <Plus size={14} />
                Add Device
              </Button>
            </div>
          )}
        </div>
      </div>

      {/* KPI cards row */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3" data-testid="location-stats">
        {(() => {
          const ordersToday = stats?.orders_today ?? 0;
          const ordersYesterday = stats?.orders_yesterday ?? 0;
          const diff = ordersToday - ordersYesterday;
          const vsYesterdayBadge = stats != null ? (
            <span className={`text-[10px] font-medium px-1 py-0.5 rounded ${
              diff > 0 ? "bg-green-100 text-green-700" :
              diff < 0 ? "bg-red-100 text-red-700" :
              "bg-secondary text-muted-foreground"
            }`}>
              {diff > 0 ? `+${diff}` : diff === 0 ? "=" : diff} vs yday
            </span>
          ) : undefined;
          return (
            <KpiCard
              icon={Package}
              label="Today's Orders"
              value={stats != null ? ordersToday : "—"}
              badge={vsYesterdayBadge}
            />
          );
        })()}
        <KpiCard
          icon={Clock}
          label="Pending Prep"
          value={stats != null ? (stats.pending_prep ?? 0) : "—"}
          iconClass={stats != null && (stats.pending_prep ?? 0) > 0 ? "bg-amber-100" : ""}
          valueClass={stats != null && (stats.pending_prep ?? 0) > 0 ? "text-amber-700" : ""}
        />
        <KpiCard
          icon={Truck}
          label="Ready for Dispatch"
          value={stats != null ? (stats.ready_for_dispatch ?? 0) : "—"}
          iconClass={stats != null && (stats.ready_for_dispatch ?? 0) > 0 ? "bg-blue-100" : ""}
          valueClass={stats != null && (stats.ready_for_dispatch ?? 0) > 0 ? "text-blue-700" : ""}
        />
        <KpiCard
          icon={AlertTriangle}
          label="At Risk"
          value={stats != null ? (stats.at_risk ?? 0) : "—"}
          iconClass={stats != null && (stats.at_risk ?? 0) > 0 ? "bg-destructive/10" : ""}
          valueClass={stats != null && (stats.at_risk ?? 0) > 0 ? "text-destructive" : ""}
        />
        <KpiCard
          icon={AlertTriangle}
          label="Device Errors"
          value={deviceErrors}
          iconClass={deviceErrors > 0 ? "bg-destructive/10" : "bg-secondary"}
          valueClass={deviceErrors > 0 ? "text-destructive" : ""}
        />
      </div>

      {/* Pause notice banner */}
      {locationStatus === "paused" && (
        <div data-testid="location-paused-banner" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 flex items-start gap-3">
          <PauseCircle size={18} className="text-amber-600 mt-0.5 shrink-0" />
          <div className="flex-1 text-sm">
            <span className="font-medium text-amber-800">This location is paused.</span>
            {location.pause_reason && (
              <span className="text-amber-700 ml-1">Reason: {location.pause_reason}</span>
            )}
            {location.paused_at && (
              <span className="text-amber-600 ml-1">({timeAgo(location.paused_at)})</span>
            )}
          </div>
        </div>
      )}

      {/* Main tab navigation */}
      <Tabs value={activeTab} onValueChange={setActiveTab}>
        <TabsList className="flex w-full justify-start overflow-x-auto gap-1 bg-transparent border-b rounded-none p-0 h-auto mb-4">
          {[
            { value: "overview", label: "Overview", icon: BarChart2 },
            { value: "operations", label: "Operations", icon: Settings },
            { value: "catalog", label: "Catalog", icon: Layers },
            { value: "team-devices", label: "Team & Devices", icon: Users },
            { value: "activity", label: "Activity", icon: Activity },
            { value: "settings", label: "Settings", icon: Settings },
          ].map(({ value, label, icon: Icon }) => (
            <TabsTrigger
              key={value}
              value={value}
              className="flex items-center gap-1.5 rounded-none border-b-2 border-transparent data-[state=active]:border-foreground data-[state=active]:bg-transparent px-3 pb-2 pt-0 text-sm font-medium text-muted-foreground data-[state=active]:text-foreground"
            >
              <Icon size={14} />
              {label}
            </TabsTrigger>
          ))}
        </TabsList>

        {/* ── OVERVIEW TAB ──────────────────────────────────────────────── */}
        <TabsContent value="overview" className="space-y-6 mt-0">
          {/* Row 1: Capacity, Hours, Routing */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Capacity & Load */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <BarChart2 size={15} className="text-muted-foreground" />
                  Capacity &amp; Load
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                {capacity > 0 ? (
                  <>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">{currentLoad} / {capacity} orders</span>
                      <span className="font-medium">{capacityPct}%</span>
                    </div>
                    <div className="h-2 rounded-full bg-secondary overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${capacityColor}`}
                        style={{ width: `${capacityPct}%` }}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {capacityPct >= 90 ? "⚠ Near capacity" : capacityPct >= 70 ? "Getting busy" : "Capacity available"}
                    </p>
                  </>
                ) : (
                  <div className="py-3 text-center">
                    <p className="text-sm text-muted-foreground">Daily capacity not set.</p>
                    {isOwner && (
                      <Button size="sm" variant="link" className="mt-1 h-auto p-0 text-xs" onClick={() => setActiveTab("operations")}>
                        Configure in Operations →
                      </Button>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Operating Hours */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Clock size={15} className="text-muted-foreground" />
                  Operating Hours
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {location.same_day_cutoff_time || location.express_cutoff_time || location.timezone ? (
                  <>
                    {location.same_day_cutoff_time && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Same-day cutoff</span>
                        <span className="font-medium">{location.same_day_cutoff_time}</span>
                      </div>
                    )}
                    {location.express_cutoff_time && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Express cutoff</span>
                        <span className="font-medium">{location.express_cutoff_time}</span>
                      </div>
                    )}
                    {location.timezone && (
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">Timezone</span>
                        <span className="font-medium text-xs">{location.timezone}</span>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="py-3 text-center">
                    <p className="text-sm text-muted-foreground">Hours not configured.</p>
                    {isOwner && (
                      <Button size="sm" variant="link" className="mt-1 h-auto p-0 text-xs" onClick={() => setActiveTab("operations")}>
                        Configure in Operations →
                      </Button>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Order Routing */}
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Zap size={15} className="text-muted-foreground" />
                  Order Routing
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">Auto-routing</span>
                  {location.auto_routing_enabled ? (
                    <Badge variant="outline" className="bg-green-50 text-green-700 border-green-200 text-xs">Enabled</Badge>
                  ) : (
                    <Badge variant="outline" className="text-xs">Disabled</Badge>
                  )}
                </div>
                {location.backup_location_name && (
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">Backup location</span>
                    <span className="font-medium text-xs">{location.backup_location_name}</span>
                  </div>
                )}
                {servedCities.length > 0 && (
                  <div className="flex flex-col gap-1">
                    <span className="text-muted-foreground">Served cities</span>
                    <div className="flex flex-wrap gap-1 mt-0.5">
                      {servedCities.map((c) => (
                        <Badge key={c.id} variant="outline" className="text-xs">{c.name}</Badge>
                      ))}
                    </div>
                  </div>
                )}
                {servedAreaIds.length > 0 && servedCities.length === 0 && (
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground">Served areas</span>
                    <Badge variant="outline" className="text-xs">{servedAreaIds.length} area{servedAreaIds.length !== 1 ? "s" : ""}</Badge>
                  </div>
                )}
                {!location.backup_location_name && !location.auto_routing_enabled && !servedAreaIds.length && (
                  <p className="text-xs text-muted-foreground pt-1">
                    Configure routing rules to handle overflow orders.
                    {isOwner && (
                      <button className="ml-1 text-foreground underline" onClick={() => setActiveTab("operations")}>
                        Set up →
                      </button>
                    )}
                  </p>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Row 2: Devices summary */}
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Smartphone size={15} className="text-muted-foreground" />
                  Devices
                  <span className="font-normal text-muted-foreground">
                    {onlineDevices.length} online · {offlineDevices.length} offline
                  </span>
                </CardTitle>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs text-muted-foreground gap-1"
                  onClick={() => setActiveTab("team-devices")}
                >
                  View all <ChevronRight size={12} />
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {devices.length === 0 ? (
                <div className="py-6 text-center">
                  <Smartphone className="w-10 h-10 mx-auto text-muted-foreground/30 mb-2" />
                  <p className="text-sm text-muted-foreground">{t("locations.noDevicesAssigned")}</p>
                  {isOwner && (
                    <Button size="sm" variant="outline" className="mt-3 gap-2" onClick={() => { setActiveTab("team-devices"); setIsAddOpen(true); }}>
                      <Plus size={14} /> Add Device
                    </Button>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  {devices.slice(0, 4).map((d) => (
                    <div key={d.id} className="flex items-center justify-between py-1.5">
                      <div className="flex items-center gap-2">
                        <Circle
                          size={8}
                          className={isOnline(d.last_seen_at) ? "fill-green-500 text-green-500" : "fill-muted-foreground text-muted-foreground"}
                        />
                        <span className="text-sm font-medium">{d.name}</span>
                        {d.os && <span className="text-xs text-muted-foreground">{d.os}</span>}
                      </div>
                      <span className="text-xs text-muted-foreground">{timeAgo(d.last_seen_at)}</span>
                    </div>
                  ))}
                  {devices.length > 4 && (
                    <p className="text-xs text-muted-foreground pt-1">+{devices.length - 4} more</p>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Row 3: Brands grid + Products preview + Activity feed */}
          {isPOS && (
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              {/* Brands compact grid */}
              <Card>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-sm font-semibold flex items-center gap-2">
                      <Tag size={15} className="text-muted-foreground" />
                      Brands ({locationBrands.length})
                    </CardTitle>
                    <div className="flex items-center gap-1">
                      {isOwner && (
                        <Button variant="ghost" size="sm" className="text-xs gap-1 h-7" onClick={() => setIsAddBrandOpen(true)} disabled={unassignedBrands.length === 0}>
                          <Plus size={12} /> Assign
                        </Button>
                      )}
                      <Button variant="ghost" size="sm" className="text-xs gap-1 h-7" onClick={() => setActiveTab("catalog")}>
                        View all <ChevronRight size={12} />
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  {locationBrands.length === 0 ? (
                    <div className="py-6 text-center">
                      <Tag className="w-9 h-9 mx-auto text-muted-foreground/30 mb-2" />
                      <p className="text-sm text-muted-foreground">No brands assigned.</p>
                      {isOwner && allBrands.length > 0 && (
                        <Button size="sm" variant="outline" className="mt-2 gap-2" onClick={() => setIsAddBrandOpen(true)}>
                          <Plus size={14} /> Assign Brand
                        </Button>
                      )}
                    </div>
                  ) : (
                    <div className="grid grid-cols-3 gap-2">
                      {locationBrands.slice(0, 9).map((brand) => (
                        <div key={brand.id} className="flex flex-col items-center gap-1 p-1.5 rounded-lg hover:bg-muted/40 transition-colors">
                          <div className="w-10 h-10 rounded-md bg-secondary flex items-center justify-center overflow-hidden">
                            {brand.primary_logo_id ? (
                              <WorkspaceImage
                                src={`/api/brands/${brand.id}/logos/${brand.primary_logo_id}/image`}
                                alt={brand.name}
                                className="w-full h-full object-contain"
                              />
                            ) : (
                              <Tag size={14} />
                            )}
                          </div>
                          <span className="text-[10px] text-center text-muted-foreground leading-tight truncate w-full text-center">{brand.name}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>

              {/* Products preview */}
              <Card className="lg:col-span-2">
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle className="text-sm font-semibold flex items-center gap-2">
                      <ShoppingBag size={15} className="text-muted-foreground" />
                      Products
                    </CardTitle>
                    <div className="flex items-center gap-2">
                      <div className="relative">
                        <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
                        <input
                          className="h-7 pl-6 pr-2 text-xs rounded-md border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring w-36"
                          placeholder="Search products…"
                          value={productSearch}
                          onChange={(e) => setProductSearch(e.target.value)}
                        />
                      </div>
                      <Button variant="ghost" size="sm" className="text-xs gap-1 h-7" onClick={() => setActiveTab("catalog")}>
                        View all <ChevronRight size={12} />
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  {locationProducts.length === 0 ? (
                    <div className="py-6 text-center">
                      <ShoppingBag className="w-9 h-9 mx-auto text-muted-foreground/30 mb-2" />
                      <p className="text-sm text-muted-foreground">No products available at this location.</p>
                      <p className="text-xs text-muted-foreground mt-1">Enable products from each product's Locations tab.</p>
                    </div>
                  ) : (
                    <>
                      <div className="divide-y divide-border rounded-md border">
                        {previewProducts.map((product) => (
                          <a
                            key={product.id}
                            href={`/products/${product.id}`}
                            className="flex items-center gap-3 px-3 py-2.5 hover:bg-muted/40 transition-colors"
                          >
                            <ProductThumb url={product.main_image_url} />
                            <div className="flex-1 min-w-0">
                              <p className="font-medium text-sm truncate">{product.name}</p>
                              {(product.brand || product.category) && (
                                <p className="text-xs text-muted-foreground truncate">
                                  {[product.brand, product.category].filter(Boolean).join(" · ")}
                                </p>
                              )}
                            </div>
                            <AvailabilityPill status={product.status} />
                          </a>
                        ))}
                      </div>
                      <p className="text-xs text-muted-foreground mt-2">
                        Showing {previewProducts.length} of {filteredProducts.length}
                        {filteredProducts.length !== locationProducts.length && ` (filtered from ${locationProducts.length})`}
                        {" · "}
                        <button className="underline text-foreground" onClick={() => setActiveTab("catalog")}>
                          View all products →
                        </button>
                      </p>
                    </>
                  )}
                </CardContent>
              </Card>
            </div>
          )}

          {/* Activity feed preview */}
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Clock size={15} className="text-muted-foreground" />
                  Recent Activity
                </CardTitle>
                {rawActivityEvents.length > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-xs text-muted-foreground gap-1"
                    onClick={() => setActiveTab("activity")}
                  >
                    View all <ChevronRight size={12} />
                  </Button>
                )}
              </div>
              <CardDescription className="text-xs">
                Device check-ins, brand and member changes, and completed print jobs.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {rawActivityEvents.length === 0 ? (
                <p className="text-sm text-muted-foreground py-4 text-center">No activity to show yet.</p>
              ) : (
                <>
                  <div className="space-y-3">
                    {rawActivityEvents.slice(0, 5).map((ev, i) => {
                      const meta = activityEventMeta(ev);
                      return (
                        <div key={i} className="flex items-start gap-3">
                          <div className="w-7 h-7 rounded-full bg-secondary flex items-center justify-center shrink-0 mt-0.5">
                            <meta.icon size={13} className={meta.color} />
                          </div>
                          <div className="flex-1 text-sm">
                            <span>{meta.label}</span>
                            <span className="text-xs text-muted-foreground ml-2">{timeAgo(ev.occurred_at)}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {rawActivityEvents.length > 5 && (
                    <button
                      className="mt-3 text-xs text-muted-foreground underline hover:text-foreground transition-colors"
                      onClick={() => setActiveTab("activity")}
                    >
                      View all {rawActivityEvents.length} events →
                    </button>
                  )}
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── OPERATIONS TAB ───────────────────────────────────────────── */}
        <TabsContent value="operations" className="space-y-6 mt-0">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Operating Hours Editor */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Clock size={16} className="text-muted-foreground" />
                  Cutoff Times
                </CardTitle>
                <CardDescription>Order cutoff thresholds for this location.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">Same-day cutoff</span>
                  <span className="font-medium">{location.same_day_cutoff_time ?? <span className="text-muted-foreground italic">Not set</span>}</span>
                </div>
                <Separator />
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">Express cutoff</span>
                  <span className="font-medium">{location.express_cutoff_time ?? <span className="text-muted-foreground italic">Not set</span>}</span>
                </div>
                <Separator />
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">Timezone</span>
                  <span className="font-medium">{location.timezone ?? <span className="text-muted-foreground italic">Not set</span>}</span>
                </div>
                {isOwner && (
                  <Button size="sm" variant="outline" className="mt-2 gap-2" onClick={() => setActiveTab("settings")}>
                    <Settings size={13} />
                    Edit in Settings
                  </Button>
                )}
              </CardContent>
            </Card>

            {/* Daily Capacity */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <BarChart2 size={16} className="text-muted-foreground" />
                  Daily Capacity
                </CardTitle>
                <CardDescription>Maximum orders per day this location can handle.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                {capacity > 0 ? (
                  <>
                    <div className="text-3xl font-bold">{capacity}</div>
                    <p className="text-muted-foreground">orders / day</p>
                    <div className="h-2 rounded-full bg-secondary overflow-hidden">
                      <div
                        className={`h-full rounded-full ${capacityColor}`}
                        style={{ width: `${capacityPct}%` }}
                      />
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {currentLoad} orders today ({capacityPct}% utilized)
                      {/* TODO: wire to real order count from native orders table */}
                    </p>
                  </>
                ) : (
                  <div className="py-2">
                    <p className="text-muted-foreground">Daily capacity not configured.</p>
                    {isOwner && (
                      <Button size="sm" variant="outline" className="mt-3 gap-2" onClick={() => setActiveTab("settings")}>
                        <Settings size={13} />
                        Set capacity in Settings
                      </Button>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Order Routing */}
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Zap size={16} className="text-muted-foreground" />
                  Order Routing
                </CardTitle>
                <CardDescription>Automatic routing and overflow rules.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3 text-sm">
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">Auto-routing</span>
                  {location.auto_routing_enabled ? (
                    <div className="flex items-center gap-1.5 text-green-600">
                      <CheckCircle2 size={14} />
                      <span className="font-medium">Enabled</span>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      <XCircle size={14} />
                      <span>Disabled</span>
                    </div>
                  )}
                </div>
                <Separator />
                <div className="flex justify-between items-center">
                  <span className="text-muted-foreground">Backup location</span>
                  <span className="font-medium">{location.backup_location_name ?? <span className="text-muted-foreground italic">Not set</span>}</span>
                </div>
                <Separator />
                <div className="space-y-1.5">
                  <span className="text-muted-foreground">Served cities</span>
                  {servedCities.length > 0 ? (
                    <div className="flex flex-wrap gap-1">
                      {servedCities.map((c) => (
                        <Badge key={c.id} variant="outline" className="text-xs">{c.name}</Badge>
                      ))}
                    </div>
                  ) : (
                    <span className="text-muted-foreground italic text-sm">Not set</span>
                  )}
                </div>
                {isOwner && (
                  <Button size="sm" variant="outline" className="mt-2 gap-2" onClick={() => setActiveTab("settings")}>
                    <Settings size={13} />
                    Configure in Settings
                  </Button>
                )}
              </CardContent>
            </Card>

            {/* Pause / Resume card */}
            {isOwner && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    {locationStatus === "paused" ? <PlayCircle size={16} className="text-green-600" /> : <PauseCircle size={16} className="text-amber-600" />}
                    {locationStatus === "paused" ? "Resume Location" : "Pause Location"}
                  </CardTitle>
                  <CardDescription>
                    {locationStatus === "paused"
                      ? "Resume this location to accept orders again."
                      : "Temporarily pause this location to stop accepting orders."}
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 text-sm">
                  {locationStatus === "paused" && (
                    <div className="rounded-md bg-amber-50 border border-amber-200 p-3 text-xs text-amber-800">
                      <strong>Paused</strong>
                      {location.pause_reason && <span> — {location.pause_reason}</span>}
                      {location.paused_at && <span> ({timeAgo(location.paused_at)})</span>}
                    </div>
                  )}
                  {locationStatus === "paused" ? (
                    <Button
                      size="sm"
                      className="gap-2 bg-green-600 hover:bg-green-700"
                      onClick={() => resumeMutation.mutate()}
                      disabled={resumeMutation.isPending}
                    >
                      <PlayCircle size={14} />
                      {resumeMutation.isPending ? "Resuming…" : "Resume Location"}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      className="gap-2 text-amber-700 border-amber-300 hover:bg-amber-50"
                      onClick={() => setIsPauseDialogOpen(true)}
                    >
                      <PauseCircle size={14} />
                      Pause Location
                    </Button>
                  )}
                </CardContent>
              </Card>
            )}
          </div>
        </TabsContent>

        {/* ── CATALOG TAB ──────────────────────────────────────────────── */}
        <TabsContent value="catalog" className="space-y-6 mt-0">
          {isPOS && (
            <>
              {/* All Brands */}
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="flex items-center gap-2">
                        <Tag size={16} className="text-muted-foreground" />
                        {t("locations.brandsSection")} ({locationBrands.length})
                      </CardTitle>
                      <CardDescription>Brands assigned to this Point of Sale.</CardDescription>
                    </div>
                    {isOwner && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-2"
                        onClick={() => setIsAddBrandOpen(true)}
                        disabled={unassignedBrands.length === 0}
                      >
                        <Plus size={14} />
                        {t("locations.addBrand")}
                      </Button>
                    )}
                  </div>
                </CardHeader>
                <CardContent>
                  {locationBrands.length === 0 ? (
                    <div className="py-10 text-center space-y-3">
                      <Tag className="w-10 h-10 mx-auto text-muted-foreground/30" />
                      <p className="font-medium text-sm">No brands assigned</p>
                      <p className="text-xs text-muted-foreground">Assign brands to track which products are available at this location.</p>
                      {isOwner && allBrands.length > 0 && (
                        <Button size="sm" variant="outline" className="gap-2" onClick={() => setIsAddBrandOpen(true)}>
                          <Plus size={14} />
                          {t("locations.addBrand")}
                        </Button>
                      )}
                    </div>
                  ) : (
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {locationBrands.map((brand) => (
                        <Card key={brand.id} data-testid={`location-brand-${brand.id}`} className="flex items-center justify-between px-4 py-3">
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-md bg-secondary flex items-center justify-center shrink-0 overflow-hidden">
                              {brand.primary_logo_id ? (
                                <WorkspaceImage
                                  src={`/api/brands/${brand.id}/logos/${brand.primary_logo_id}/image`}
                                  alt={brand.name}
                                  className="w-full h-full object-contain"
                                />
                              ) : (
                                <Tag size={15} />
                              )}
                            </div>
                            <span className="font-medium text-sm">{brand.name}</span>
                          </div>
                          {isOwner && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="gap-1.5 text-muted-foreground h-8 px-2"
                              onClick={() => removeBrandMutation.mutate(brand.id)}
                              disabled={removeBrandMutation.isPending}
                              data-testid={`button-remove-brand-${brand.id}`}
                            >
                              <X size={14} />
                              {t("common.remove")}
                            </Button>
                          )}
                        </Card>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </>
          )}

          {/* All Products */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <ShoppingBag size={16} className="text-muted-foreground" />
                    Products ({locationProducts.length})
                  </CardTitle>
                  <CardDescription>All products available at this location.</CardDescription>
                </div>
                <div className="relative">
                  <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    className="h-8 pl-8 text-sm w-52"
                    placeholder="Search products…"
                    value={productSearch}
                    onChange={(e) => setProductSearch(e.target.value)}
                  />
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {locationProducts.length === 0 ? (
                <div className="py-10 text-center space-y-2">
                  <ShoppingBag className="w-10 h-10 mx-auto text-muted-foreground/30" />
                  <p className="font-medium text-sm">No products available at this location</p>
                  <p className="text-xs text-muted-foreground">Enable products for this location from each product's Locations tab.</p>
                </div>
              ) : (
                <>
                  <div className="rounded-md border divide-y divide-border">
                    {filteredProducts.map((product) => (
                      <a
                        key={product.id}
                        href={`/products/${product.id}`}
                        className="flex items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors"
                      >
                        <ProductThumb url={product.main_image_url} />
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-sm truncate">{product.name}</p>
                          {(product.brand || product.category) && (
                            <p className="text-xs text-muted-foreground truncate">
                              {[product.brand, product.category].filter(Boolean).join(" · ")}
                            </p>
                          )}
                        </div>
                        <AvailabilityPill status={product.status} />
                      </a>
                    ))}
                  </div>
                  {filteredProducts.length === 0 && productSearch && (
                    <p className="text-sm text-center text-muted-foreground py-6">No products match "{productSearch}"</p>
                  )}
                  <p className="text-xs text-muted-foreground mt-2">
                    {filteredProducts.length !== locationProducts.length
                      ? `Showing ${filteredProducts.length} of ${locationProducts.length} products`
                      : `${locationProducts.length} product${locationProducts.length === 1 ? "" : "s"} total`}
                  </p>
                </>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── TEAM & DEVICES TAB ───────────────────────────────────────── */}
        <TabsContent value="team-devices" className="space-y-6 mt-0">
          {/* Devices */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Smartphone size={16} className="text-muted-foreground" />
                    {t("locations.devicesSection")} ({devices.length})
                  </CardTitle>
                  <CardDescription>
                    {onlineDevices.length} online · {offlineDevices.length} offline
                  </CardDescription>
                </div>
                {isOwner && (
                  <Button
                    size="sm"
                    className="gap-2"
                    onClick={() => setIsAddOpen(true)}
                    disabled={unassignedDevices.length === 0}
                    data-testid="button-add-device-to-location"
                  >
                    <Plus size={14} />
                    {t("locations.addDevice")}
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {devices.length === 0 ? (
                <div className="py-10 text-center space-y-3">
                  <Smartphone className="w-12 h-12 mx-auto text-muted-foreground/30" />
                  <p className="font-medium">{t("locations.noDevicesAssigned")}</p>
                  <p className="text-sm text-muted-foreground">{t("locations.noDevicesAssignedDesc")}</p>
                  {isOwner && (
                    <Button size="sm" variant="outline" className="gap-2" onClick={() => setIsAddOpen(true)} disabled={unassignedDevices.length === 0}>
                      <Plus size={14} /> Add First Device
                    </Button>
                  )}
                </div>
              ) : (
                <div className="grid gap-4">
                  {devices.map((d) => (
                    <Card key={d.id} data-testid={`device-${d.id}`}>
                      <CardHeader>
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 rounded-md bg-secondary flex items-center justify-center">
                              <Smartphone size={20} />
                            </div>
                            <div>
                              <CardTitle className="text-base">{d.name}</CardTitle>
                              <CardDescription className="flex items-center gap-2 mt-1">
                                <Circle
                                  size={8}
                                  className={
                                    isOnline(d.last_seen_at)
                                      ? "fill-green-500 text-green-500"
                                      : "fill-muted-foreground text-muted-foreground"
                                  }
                                />
                                {isOnline(d.last_seen_at) ? t("common.online") : t("common.offline")} ·{" "}
                                {t("devices.lastSeen", { time: timeAgo(d.last_seen_at) })}
                              </CardDescription>
                            </div>
                          </div>
                          {isOwner && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="gap-1.5 text-muted-foreground"
                              onClick={() => handleRemove(d.id, d.name)}
                              disabled={assignMutation.isPending}
                              data-testid={`button-remove-device-${d.id}`}
                            >
                              <X size={14} />
                              {t("common.remove")}
                            </Button>
                          )}
                        </div>
                      </CardHeader>
                      <CardContent className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
                        <div>
                          <div className="text-xs text-muted-foreground uppercase tracking-wide">{t("devices.os")}</div>
                          <div className="font-medium mt-1">{d.os ?? t("common.unknown")}</div>
                        </div>
                        <div>
                          <div className="text-xs text-muted-foreground uppercase tracking-wide">{t("devices.agent")}</div>
                          <div className="font-medium mt-1">v{d.agent_version ?? "?"}</div>
                        </div>
                        <div>
                          <div className="text-xs text-muted-foreground uppercase tracking-wide">{t("devices.printers")}</div>
                          <div className="font-medium mt-1">{d.printers?.length ?? 0}</div>
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Members */}
          {isOwner && (
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <Users size={16} className="text-muted-foreground" />
                      Members ({locationMembers.length})
                    </CardTitle>
                    <CardDescription>
                      Members assigned to this location see only data from their assigned locations.
                    </CardDescription>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-2"
                    onClick={() => setIsAddMemberOpen(true)}
                    disabled={unassignedMembers.length === 0}
                    data-testid="button-add-member-to-location"
                  >
                    <Plus size={14} />
                    Add Member
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {locationMembers.length === 0 ? (
                  <div className="py-10 text-center space-y-3">
                    <Users className="w-10 h-10 mx-auto text-muted-foreground/30" />
                    <p className="font-medium text-sm">No members assigned</p>
                    <p className="text-xs text-muted-foreground max-w-sm mx-auto">Members with no location assignment can see all locations' data. Assign members here to restrict their view to this location only.</p>
                    <Button size="sm" variant="outline" className="gap-2" onClick={() => setIsAddMemberOpen(true)} disabled={unassignedMembers.length === 0}>
                      <Plus size={14} /> Assign Member
                    </Button>
                  </div>
                ) : (
                  <div className="grid gap-2">
                    {locationMembers.map((m) => (
                      <div key={m.id} className="flex items-center justify-between px-3 py-2.5 rounded-lg border" data-testid={`location-member-${m.id}`}>
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center text-xs font-medium shrink-0">
                            {m.email[0]?.toUpperCase() ?? "?"}
                          </div>
                          <div>
                            <div className="text-sm font-medium">{m.email}</div>
                            {m.role_name && (
                              <div className="text-xs text-muted-foreground">{m.role_name}</div>
                            )}
                          </div>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="gap-1.5 text-muted-foreground h-8 px-2"
                          onClick={() => removeMemberMutation.mutate(m.id)}
                          disabled={removeMemberMutation.isPending}
                          data-testid={`button-remove-member-${m.id}`}
                        >
                          <X size={14} />
                          Remove
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </TabsContent>

        {/* ── ACTIVITY TAB ─────────────────────────────────────────────── */}
        <TabsContent value="activity" className="mt-0">
          <Card>
            <CardHeader>
              <CardTitle className="text-base flex items-center gap-2">
                <Activity size={16} className="text-muted-foreground" />
                Activity Feed
              </CardTitle>
              <CardDescription>
                Device check-ins, brand and member changes, and completed print jobs — up to the last 50 events.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {rawActivityEvents.length === 0 ? (
                <div className="py-10 text-center">
                  <Activity className="w-10 h-10 mx-auto text-muted-foreground/30 mb-3" />
                  <p className="text-sm text-muted-foreground">No activity to show yet.</p>
                  <p className="text-xs text-muted-foreground mt-1">Events will appear here as devices check in and catalog changes are made.</p>
                </div>
              ) : (
                <div className="space-y-1">
                  {rawActivityEvents.map((ev, i) => {
                    const meta = activityEventMeta(ev);
                    return (
                      <div key={i} className="flex items-start gap-3 py-2.5 border-b border-border last:border-0">
                        <div className="w-8 h-8 rounded-full bg-secondary flex items-center justify-center shrink-0 mt-0.5">
                          <meta.icon size={14} className={meta.color} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm">{meta.label}</p>
                          <p className="text-xs text-muted-foreground mt-0.5">{timeAgo(ev.occurred_at)}</p>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── SETTINGS TAB ─────────────────────────────────────────────── */}
        <TabsContent value="settings" className="space-y-6 mt-0">
          <SettingsTabContent
            location={location}
            locationId={locationId}
            isOwner={isOwner}
            deliveryCities={allDeliveryCities}
            onSaved={() => {
              invalidateLocation();
              toast({ title: "Location settings saved" });
            }}
            onSaveError={(msg) => {
              toast({ variant: "destructive", title: "Failed to save", description: msg });
            }}
            onSavingChange={setStatusUpdating}
          />
        </TabsContent>
      </Tabs>

      {/* ── Shared Dialogs ─────────────────────────────────────────────── */}

      {/* Pause dialog */}
      <Dialog open={isPauseDialogOpen} onOpenChange={(open) => { setIsPauseDialogOpen(open); if (!open) setPauseReason(""); }}>
        <DialogContent data-testid="dialog-pause-location">
          <DialogHeader>
            <DialogTitle>Pause {location.name}</DialogTitle>
            <DialogDescription>
              Pausing will stop this location from accepting orders. You can resume at any time.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-sm font-medium">Reason (optional)</label>
            <Input
              data-testid="input-pause-reason"
              placeholder="e.g. Staff shortage, maintenance…"
              value={pauseReason}
              onChange={(e) => setPauseReason(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsPauseDialogOpen(false)}>Cancel</Button>
            <Button
              data-testid="button-confirm-pause"
              className="bg-amber-600 hover:bg-amber-700"
              onClick={() => pauseMutation.mutate(pauseReason)}
              disabled={pauseMutation.isPending}
            >
              {pauseMutation.isPending ? "Pausing…" : "Pause Location"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add device dialog */}
      <Dialog open={isAddOpen} onOpenChange={(open) => { setIsAddOpen(open); if (!open) setSelectedDeviceId(""); }}>
        <DialogContent data-testid="dialog-add-device">
          <DialogHeader>
            <DialogTitle>{t("locations.addDeviceTitle", { name: location.name })}</DialogTitle>
            <DialogDescription>
              {t("locations.addDeviceDesc")}
            </DialogDescription>
          </DialogHeader>
          <Select value={selectedDeviceId} onValueChange={setSelectedDeviceId}>
            <SelectTrigger data-testid="select-device">
              <SelectValue placeholder={t("locations.selectDevice")} />
            </SelectTrigger>
            <SelectContent>
              {unassignedDevices.map((d) => (
                <SelectItem key={d.id} value={String(d.id)}>
                  {d.name}
                  {d.location_name ? ` (${t("locations.currentlyIn", { location: d.location_name })})` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsAddOpen(false)}>
              {t("common.cancel")}
            </Button>
            <Button
              onClick={handleAdd}
              disabled={!selectedDeviceId || assignMutation.isPending}
              data-testid="button-confirm-add-device"
            >
              {assignMutation.isPending ? t("locations.assigning") : t("common.add")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add brand dialog */}
      <Dialog open={isAddBrandOpen} onOpenChange={(open) => { setIsAddBrandOpen(open); if (!open) setSelectedBrandId(""); }}>
        <DialogContent data-testid="dialog-add-brand">
          <DialogHeader>
            <DialogTitle>{t("locations.addBrandTitle", { name: location.name })}</DialogTitle>
            <DialogDescription>
              {t("locations.addBrandDesc")}
            </DialogDescription>
          </DialogHeader>
          <Select value={selectedBrandId} onValueChange={setSelectedBrandId}>
            <SelectTrigger data-testid="select-brand-to-add">
              <SelectValue placeholder={t("locations.selectBrand")} />
            </SelectTrigger>
            <SelectContent>
              {unassignedBrands.map((b) => (
                <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsAddBrandOpen(false)}>{t("common.cancel")}</Button>
            <Button
              data-testid="button-confirm-add-brand"
              onClick={() => addBrandMutation.mutate(parseInt(selectedBrandId, 10))}
              disabled={!selectedBrandId || addBrandMutation.isPending}
            >
              {addBrandMutation.isPending ? t("locations.adding") : t("common.add")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add member dialog */}
      <Dialog open={isAddMemberOpen} onOpenChange={(open) => { setIsAddMemberOpen(open); if (!open) setSelectedMemberId(""); }}>
        <DialogContent data-testid="dialog-add-member-to-location">
          <DialogHeader>
            <DialogTitle>Add member to {location.name}</DialogTitle>
            <DialogDescription>
              Select a member to assign to this location. Assigned members will only see data from their assigned locations.
            </DialogDescription>
          </DialogHeader>
          <Select value={selectedMemberId} onValueChange={setSelectedMemberId}>
            <SelectTrigger data-testid="select-member-to-add">
              <SelectValue placeholder="Select a member" />
            </SelectTrigger>
            <SelectContent>
              {unassignedMembers.map((m) => (
                <SelectItem key={m.id} value={String(m.id)}>
                  {m.email}
                  {m.role_name && <span className="text-muted-foreground ml-1">({m.role_name})</span>}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsAddMemberOpen(false)}>Cancel</Button>
            <Button
              onClick={() => addMemberMutation.mutate(parseInt(selectedMemberId, 10))}
              disabled={!selectedMemberId || addMemberMutation.isPending}
              data-testid="button-confirm-add-member"
            >
              {addMemberMutation.isPending ? "Adding…" : "Add"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Settings Tab Sub-component ────────────────────────────────────────────────

type SettingsTabProps = {
  location: LocationInfo;
  locationId: number;
  isOwner: boolean;
  deliveryCities: DeliveryCity[];
  onSaved: () => void;
  onSaveError: (msg: string) => void;
  onSavingChange?: (saving: boolean) => void;
};

function SettingsTabContent({ location, locationId, isOwner, deliveryCities, onSaved, onSaveError, onSavingChange }: SettingsTabProps) {
  const [form, setForm] = useState({
    name: location.name,
    country: location.country,
    location_type: location.location_type,
    address: location.address ?? "",
    annual_rent: location.annual_rent != null ? String(location.annual_rent) : "",
    rent_currency: location.rent_currency ?? "",
    payments_per_year: location.payments_per_year != null ? String(location.payments_per_year) : "",
    daily_capacity: location.daily_capacity != null ? String(location.daily_capacity) : "",
    same_day_cutoff_time: location.same_day_cutoff_time ?? "",
    express_cutoff_time: location.express_cutoff_time ?? "",
    timezone: location.timezone ?? "",
    auto_routing_enabled: location.auto_routing_enabled ?? false,
    internal_notes: location.internal_notes ?? "",
    served_area_ids: location.served_area_ids ?? [] as number[],
  });

  const [cityPickerOpen, setCityPickerOpen] = useState(false);
  const cityPickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!cityPickerOpen) return;
    function handleClickOutside(e: MouseEvent) {
      if (cityPickerRef.current && !cityPickerRef.current.contains(e.target as Node)) {
        setCityPickerOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [cityPickerOpen]);

  const toggleCity = (cityId: number) => {
    setForm((f) => {
      const already = f.served_area_ids.includes(cityId);
      return {
        ...f,
        served_area_ids: already
          ? f.served_area_ids.filter((id) => id !== cityId)
          : [...f.served_area_ids, cityId],
      };
    });
  };

  const saveMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/locations/${locationId}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: form.name,
          country: form.country,
          location_type: form.location_type,
          address: form.address || undefined,
          annual_rent: form.annual_rent || undefined,
          rent_currency: form.rent_currency || undefined,
          payments_per_year: form.payments_per_year || undefined,
          daily_capacity: form.daily_capacity || undefined,
          same_day_cutoff_time: form.same_day_cutoff_time || undefined,
          express_cutoff_time: form.express_cutoff_time || undefined,
          timezone: form.timezone || undefined,
          auto_routing_enabled: form.auto_routing_enabled,
          internal_notes: form.internal_notes || undefined,
          served_area_ids: form.served_area_ids,
        }),
      }),
    onMutate: () => { onSavingChange?.(true); },
    onSuccess: async () => {
      onSaved();
      onSavingChange?.(false);
    },
    onError: (err: Error) => {
      onSaveError(err.message);
      onSavingChange?.(false);
    },
  });

  const field = (key: keyof typeof form, label: string, placeholder?: string, type = "text") => (
    <div className="space-y-1.5">
      <label className="text-sm font-medium">{label}</label>
      <Input
        type={type}
        value={form[key] as string}
        onChange={(e) => setForm((f) => ({ ...f, [key]: e.target.value }))}
        placeholder={placeholder}
        disabled={!isOwner}
      />
    </div>
  );

  return (
    <div className="space-y-6 max-w-2xl">
      {/* Basic info */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Location Details</CardTitle>
          <CardDescription>Name, type, address, and country.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {field("name", "Location Name", "e.g. Achrafieh POS")}
          {field("address", "Address", "e.g. Mar Mikhael, Beirut")}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Type</label>
              <Select
                value={form.location_type}
                onValueChange={(v) => setForm((f) => ({ ...f, location_type: v }))}
                disabled={!isOwner}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="Point of Sale">Point of Sale</SelectItem>
                  <SelectItem value="Central Warehouse">Central Warehouse</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {field("country", "Country", "e.g. Lebanon")}
          </div>
        </CardContent>
      </Card>

      {/* Financial */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Financial</CardTitle>
          <CardDescription>Annual rent and payment schedule.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            {field("annual_rent", "Annual Rent", "e.g. 12000", "number")}
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Currency</label>
              <Select
                value={form.rent_currency || ""}
                onValueChange={(v) => setForm((f) => ({ ...f, rent_currency: v }))}
                disabled={!isOwner}
              >
                <SelectTrigger><SelectValue placeholder="Select currency" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="USD">USD</SelectItem>
                  <SelectItem value="AED">AED</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {field("payments_per_year", "Payments Per Year", "e.g. 12", "number")}
        </CardContent>
      </Card>

      {/* Operations */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Operations</CardTitle>
          <CardDescription>Capacity, cutoff times, and routing settings.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {field("daily_capacity", "Daily Capacity (orders)", "e.g. 50", "number")}
          <div className="grid grid-cols-2 gap-4">
            {field("same_day_cutoff_time", "Same-day Cutoff", "e.g. 14:00")}
            {field("express_cutoff_time", "Express Cutoff", "e.g. 12:00")}
          </div>
          {field("timezone", "Timezone", "e.g. Asia/Beirut")}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Auto-routing</p>
              <p className="text-xs text-muted-foreground">Automatically route overflow orders to backup location.</p>
            </div>
            <button
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus-visible:outline-none ${form.auto_routing_enabled ? "bg-primary" : "bg-input"} ${!isOwner ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
              onClick={() => isOwner && setForm((f) => ({ ...f, auto_routing_enabled: !f.auto_routing_enabled }))}
            >
              <span className={`inline-block h-4 w-4 transform rounded-full bg-background transition-transform ${form.auto_routing_enabled ? "translate-x-6" : "translate-x-1"}`} />
            </button>
          </div>

          {/* Served Cities multi-select */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium">Served Cities</label>
            <p className="text-xs text-muted-foreground">Delivery cities this location serves.</p>
            {deliveryCities.length === 0 ? (
              <p className="text-xs text-muted-foreground italic">No delivery cities configured for this workspace.</p>
            ) : (
              <div className="relative" ref={cityPickerRef}>
                <button
                  type="button"
                  disabled={!isOwner}
                  onClick={() => isOwner && setCityPickerOpen((o) => !o)}
                  className={`w-full flex items-center justify-between rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${!isOwner ? "opacity-50 cursor-not-allowed" : "cursor-pointer hover:bg-muted/40"}`}
                >
                  <span className="truncate">
                    {form.served_area_ids.length === 0
                      ? <span className="text-muted-foreground">Select cities…</span>
                      : deliveryCities
                          .filter((c) => form.served_area_ids.includes(c.id))
                          .map((c) => c.name)
                          .join(", ")}
                  </span>
                  <svg className="h-4 w-4 opacity-50 shrink-0 ml-2" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z" clipRule="evenodd" />
                  </svg>
                </button>

                {cityPickerOpen && (
                  <div className="absolute z-50 mt-1 w-full max-h-52 overflow-y-auto rounded-md border border-border bg-popover shadow-md">
                    {deliveryCities.map((city) => (
                      <label
                        key={city.id}
                        className="flex items-center gap-2.5 px-3 py-2 text-sm cursor-pointer hover:bg-muted/50 select-none"
                      >
                        <Checkbox
                          checked={form.served_area_ids.includes(city.id)}
                          onCheckedChange={() => toggleCity(city.id)}
                          id={`city-${city.id}`}
                        />
                        <span className="flex-1">{city.name}</span>
                        {!city.is_active && (
                          <span className="text-xs text-muted-foreground">(inactive)</span>
                        )}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )}

            {form.served_area_ids.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {deliveryCities
                  .filter((c) => form.served_area_ids.includes(c.id))
                  .map((c) => (
                    <Badge key={c.id} variant="outline" className="text-xs gap-1 pr-1">
                      {c.name}
                      {isOwner && (
                        <button
                          type="button"
                          onClick={() => toggleCity(c.id)}
                          className="ml-0.5 rounded-sm opacity-60 hover:opacity-100 hover:bg-muted"
                        >
                          <X size={11} />
                        </button>
                      )}
                    </Badge>
                  ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Internal Notes */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Internal Notes</CardTitle>
          <CardDescription>Private notes visible only to workspace owners.</CardDescription>
        </CardHeader>
        <CardContent>
          <textarea
            className="w-full min-h-[80px] rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 resize-y disabled:opacity-50"
            value={form.internal_notes}
            onChange={(e) => setForm((f) => ({ ...f, internal_notes: e.target.value }))}
            placeholder="Notes about this location…"
            disabled={!isOwner}
          />
        </CardContent>
      </Card>

      {isOwner && (
        <div className="flex justify-end">
          <Button
            data-testid="button-save-settings"
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending || !form.name}
          >
            {saveMutation.isPending ? "Saving…" : "Save Settings"}
          </Button>
        </div>
      )}
    </div>
  );
}
