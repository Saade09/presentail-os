import {
  useState,
  useMemo,
  useEffect,
  useRef,
  useCallback,
} from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ImageIcon,
  Plus,
  Pencil,
  Trash2,
  Copy,
  Pause,
  Play,
  Upload,
  Loader2,
  Eye,
  Monitor,
  Smartphone,
  X,
  Globe,
  CalendarClock,
  CheckCircle2,
  AlertTriangle,
  Info,
  Link2,
  GripVertical,
} from "lucide-react";
import {
  useListOccasions,
  useListCatalogCategories,
  getListOccasionsQueryKey,
  getListCatalogCategoriesQueryKey,
} from "@workspace/api-client-react";
import { apiFetch, queryClient, getClerkToken } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useUpload } from "@workspace/object-storage-web";
import { FlagImage } from "@/components/FlagImage";
import { findCountryByName, findCountryByCode } from "@/lib/countries";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";

type BannerStatus = "Draft" | "Inactive" | "Paused" | "Scheduled" | "Live" | "Expired";
type ScheduleMode = "draft" | "now" | "scheduled";
type DestinationType = "none" | "category" | "occasion" | "custom_url";

interface Side {
  enabled: boolean;
  media_type: "image" | "video" | null;
  media_url: string | null;
  fallback_image_url: string | null;
  link_url: string | null;
}

type LinkKind = "category" | "occasion";

interface Banner {
  id: number;
  internal_name: string;
  title: string | null;
  headline: string | null;
  subtitle: string | null;
  cta_text: string | null;
  country_codes: string[];
  city_ids: number[];
  is_global_for_country: boolean;
  languages: string[];
  desktop: Side;
  mobile: Side;
  link_kind: LinkKind | null;
  link_attribute_id: number | null;
  link_slug: string | null;
  destination_type: string | null;
  destination_value: string | null;
  status_override: string | null;
  start_at: string | null;
  end_at: string | null;
  timezone: string;
  sort_order: number;
  priority: number;
  is_active: boolean;
  activated_at: string | null;
  status: BannerStatus;
  created_at: string;
  updated_at: string;
}

interface Location {
  id: number;
  name: string;
  country: string;
}

interface SettingsResponse {
  available_countries: string[];
  available_country_details?: Array<{ name: string; code: string | null; flagImageUrl: string | null }>;
}

const STATUS_CONFIG: Record<BannerStatus, { label: string; variant: "default" | "secondary" | "destructive" | "outline"; color: string }> = {
  Live:      { label: "Live",      variant: "default",     color: "bg-emerald-100 text-emerald-800 border-emerald-200" },
  Scheduled: { label: "Scheduled", variant: "secondary",   color: "bg-blue-100 text-blue-800 border-blue-200" },
  Draft:     { label: "Draft",     variant: "outline",     color: "bg-gray-100 text-gray-700 border-gray-200" },
  Inactive:  { label: "Inactive",  variant: "outline",     color: "bg-gray-100 text-gray-600 border-gray-200" },
  Paused:    { label: "Paused",    variant: "secondary",   color: "bg-amber-100 text-amber-800 border-amber-200" },
  Expired:   { label: "Expired",   variant: "destructive", color: "bg-red-100 text-red-800 border-red-200" },
};

function StatusPill({ status }: { status: BannerStatus }) {
  const cfg = STATUS_CONFIG[status] ?? STATUS_CONFIG.Draft;
  return (
    <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium", cfg.color)}>
      {cfg.label}
    </span>
  );
}

const EMPTY_SIDE: Side = {
  enabled: false,
  media_type: null,
  media_url: null,
  fallback_image_url: null,
  link_url: null,
};

interface FormState {
  internal_name: string;
  headline: string;
  subtitle: string;
  cta_text: string;
  country_codes: string[];
  city_ids: number[];
  is_global_for_country: boolean;
  languages: string[];
  desktop: Side;
  mobile: Side;
  destination_type: DestinationType;
  link_attribute_id: number | null;
  destination_value: string;
  schedule_mode: ScheduleMode;
  start_at: string;
  end_at: string;
  timezone: string;
  display_priority: number;
  sort_order: number;
  priority: number;
}

function tzOffsetMinutes(date: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = dtf.formatToParts(date).reduce<Record<string, string>>((acc, p) => {
    if (p.type !== "literal") acc[p.type] = p.value;
    return acc;
  }, {});
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour === "24" ? "0" : parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return (asUTC - date.getTime()) / 60000;
}

function fromLocalInput(value: string, timeZone: string): string | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!m) return new Date(value).toISOString();
  const guess = new Date(
    Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])),
  );
  const offset = tzOffsetMinutes(guess, timeZone);
  return new Date(guess.getTime() - offset * 60000).toISOString();
}

function toLocalInput(iso: string, timeZone: string): string {
  const d = new Date(iso);
  const offset = tzOffsetMinutes(d, timeZone);
  const local = new Date(d.getTime() + offset * 60000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
}

function emptyForm(): FormState {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  return {
    internal_name: "",
    headline: "",
    subtitle: "",
    cta_text: "",
    country_codes: [],
    city_ids: [],
    is_global_for_country: true,
    languages: ["en", "ar"],
    desktop: { ...EMPTY_SIDE, enabled: true, media_type: "image" },
    mobile: { ...EMPTY_SIDE },
    destination_type: "none",
    link_attribute_id: null,
    destination_value: "",
    schedule_mode: "draft",
    start_at: "",
    end_at: "",
    timezone: tz,
    display_priority: 0,
    sort_order: 0,
    priority: 0,
  };
}

function bannerToForm(b: Banner): FormState {
  let schedule_mode: ScheduleMode = "draft";
  if (b.is_active) {
    const startMs = b.start_at ? Date.parse(b.start_at) : 0;
    schedule_mode = startMs > Date.now() ? "scheduled" : "now";
  }

  let destination_type: DestinationType = "none";
  let link_attribute_id: number | null = null;
  let destination_value = "";
  if (b.destination_type === "custom_url") {
    destination_type = "custom_url";
    destination_value = b.destination_value ?? "";
  } else if (b.link_kind === "category") {
    destination_type = "category";
    link_attribute_id = b.link_attribute_id ?? null;
  } else if (b.link_kind === "occasion") {
    destination_type = "occasion";
    link_attribute_id = b.link_attribute_id ?? null;
  }

  return {
    internal_name: b.internal_name,
    headline: b.headline ?? "",
    subtitle: b.subtitle ?? "",
    cta_text: b.cta_text ?? "",
    country_codes: [...b.country_codes],
    city_ids: [...b.city_ids],
    is_global_for_country: b.is_global_for_country,
    languages: b.languages?.length ? [...b.languages] : ["en", "ar"],
    desktop: { ...b.desktop },
    mobile: { ...b.mobile },
    destination_type,
    link_attribute_id,
    destination_value,
    schedule_mode,
    start_at: b.start_at ? toLocalInput(b.start_at, b.timezone) : "",
    end_at: b.end_at ? toLocalInput(b.end_at, b.timezone) : "",
    timezone: b.timezone,
    display_priority: b.sort_order,
    sort_order: b.sort_order,
    priority: b.priority,
  };
}

function buildPayload(form: FormState, publishMode: "draft" | "publish") {
  const isActive = publishMode === "publish" && form.schedule_mode !== "draft";
  let startAt: string | null = null;
  if (isActive) {
    if (form.schedule_mode === "now") {
      startAt = new Date().toISOString();
    } else if (form.schedule_mode === "scheduled" && form.start_at) {
      startAt = fromLocalInput(form.start_at, form.timezone);
    }
  }

  const linkKind: LinkKind | null =
    form.destination_type === "category" ? "category"
    : form.destination_type === "occasion" ? "occasion"
    : null;
  const linkAttributeId =
    (form.destination_type === "category" || form.destination_type === "occasion")
      ? form.link_attribute_id
      : null;
  const destinationType = form.destination_type === "none" ? null : form.destination_type;
  const destinationValue = form.destination_type === "custom_url" ? form.destination_value || null : null;

  return {
    internal_name: form.internal_name.trim(),
    headline: form.headline || null,
    subtitle: form.subtitle || null,
    cta_text: form.cta_text || null,
    country_codes: form.country_codes,
    city_ids: form.is_global_for_country ? [] : form.city_ids,
    is_global_for_country: form.is_global_for_country,
    languages: form.languages,
    desktop: form.desktop,
    mobile: form.mobile,
    link_kind: linkKind,
    link_attribute_id: linkAttributeId,
    destination_type: destinationType,
    destination_value: destinationValue,
    start_at: startAt,
    end_at: form.end_at ? fromLocalInput(form.end_at, form.timezone) : null,
    timezone: form.timezone,
    sort_order: form.display_priority,
    priority: form.display_priority,
    is_active: isActive,
  };
}

export default function HomepageBannersPage() {
  const { toast } = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());
  const [statusFilter, setStatusFilter] = useState<BannerStatus | "all">("all");
  const [countryFilter, setCountryFilter] = useState<string>("all");
  const [search, setSearch] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<Banner | null>(null);
  const [previewBanner, setPreviewBanner] = useState<Banner | null>(null);
  const [localOrder, setLocalOrder] = useState<number[]>([]);

  const bannersQuery = useQuery({
    queryKey: ["/api/admin/homepage-banners"],
    queryFn: () => apiFetch<{ banners: Banner[] }>("/api/admin/homepage-banners"),
  });

  const settingsQuery = useQuery({
    queryKey: ["/api/settings"],
    queryFn: () => apiFetch<SettingsResponse>("/api/settings"),
  });

  const locationsQuery = useQuery({
    queryKey: ["/api/locations"],
    queryFn: () => apiFetch<{ locations: Location[] }>("/api/locations"),
  });

  const banners = bannersQuery.data?.banners ?? [];
  const availableCountries = settingsQuery.data?.available_countries ?? [];
  const countryFlagUrls: Record<string, string | null> = useMemo(() => {
    const map: Record<string, string | null> = {};
    for (const d of settingsQuery.data?.available_country_details ?? []) {
      map[d.name] = d.flagImageUrl;
    }
    return map;
  }, [settingsQuery.data]);
  const locations = locationsQuery.data?.locations ?? [];

  const reorderMutation = useMutation({
    mutationFn: (items: { id: number; sort_order: number }[]) =>
      apiFetch("/api/admin/homepage-banners/reorder", {
        method: "PATCH",
        body: JSON.stringify({ items }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/homepage-banners"] });
    },
    onError: (err: Error) => {
      toast({ title: "Reorder failed", description: err.message, variant: "destructive" });
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/homepage-banners"] });
    },
  });

  useEffect(() => {
    if (reorderMutation.isPending) return;
    const sorted = [...(bannersQuery.data?.banners ?? [])].sort(
      (a, b) => a.sort_order - b.sort_order || Date.parse(b.updated_at) - Date.parse(a.updated_at),
    );
    setLocalOrder(sorted.map((b) => b.id));
  }, [bannersQuery.data, reorderMutation.isPending]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const isFiltered =
    statusFilter !== "all" || countryFilter !== "all" || search.trim().length > 0;

  const filteredBanners = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = banners.filter((b) => {
      if (statusFilter !== "all" && b.status !== statusFilter) return false;
      if (countryFilter !== "all" && !b.country_codes.includes(countryFilter)) return false;
      if (q && !b.internal_name.toLowerCase().includes(q)) return false;
      return true;
    });
    if (localOrder.length > 0) {
      const orderMap = new Map(localOrder.map((id, idx) => [id, idx]));
      return filtered.sort(
        (a, b) =>
          (orderMap.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
          (orderMap.get(b.id) ?? Number.MAX_SAFE_INTEGER),
      );
    }
    return filtered.sort(
      (a, b) => a.sort_order - b.sort_order || Date.parse(b.updated_at) - Date.parse(a.updated_at),
    );
  }, [banners, statusFilter, countryFilter, search, localOrder]);

  function openCreate() {
    setEditingId(null);
    setForm(emptyForm());
    setDialogOpen(true);
  }

  function openEdit(b: Banner) {
    setEditingId(b.id);
    setForm(bannerToForm(b));
    setDialogOpen(true);
  }

  const saveMutation = useMutation({
    mutationFn: async (publishMode: "draft" | "publish") => {
      if (!form.internal_name.trim()) throw new Error("Internal name is required");
      if (form.country_codes.length === 0) throw new Error("Select at least one country");
      if (!form.desktop.enabled && !form.mobile.enabled) throw new Error("Enable at least one device");
      if (publishMode === "publish" && form.schedule_mode === "scheduled" && !form.start_at) {
        throw new Error("Set a start date for scheduled publishing");
      }
      const payload = buildPayload(form, publishMode);
      const url = editingId ? `/api/admin/homepage-banners/${editingId}` : `/api/admin/homepage-banners`;
      return apiFetch<{ banner: Banner }>(url, {
        method: editingId ? "PUT" : "POST",
        body: JSON.stringify(payload),
      });
    },
    onSuccess: (_data, publishMode) => {
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/homepage-banners"] });
      toast({ title: publishMode === "publish" ? "Banner published" : "Banner saved as draft" });
      setDialogOpen(false);
    },
    onError: (err: Error) =>
      toast({ title: "Save failed", description: err.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/admin/homepage-banners/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/homepage-banners"] });
      toast({ title: "Banner deleted" });
      setConfirmDelete(null);
    },
    onError: (err: Error) =>
      toast({ title: "Delete failed", description: err.message, variant: "destructive" }),
  });

  const duplicateMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/api/admin/homepage-banners/${id}/duplicate`, { method: "POST" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/homepage-banners"] });
      toast({ title: "Banner duplicated as draft" });
    },
    onError: (err: Error) =>
      toast({ title: "Duplicate failed", description: err.message, variant: "destructive" }),
  });

  const pauseMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/api/admin/homepage-banners/${id}/pause`, { method: "POST" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/homepage-banners"] });
      toast({ title: "Banner paused" });
    },
    onError: (err: Error) =>
      toast({ title: "Pause failed", description: err.message, variant: "destructive" }),
  });

  const resumeMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/api/admin/homepage-banners/${id}/resume`, { method: "POST" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["/api/admin/homepage-banners"] });
      toast({ title: "Banner resumed" });
    },
    onError: (err: Error) =>
      toast({ title: "Resume failed", description: err.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold flex items-center gap-2">
            <ImageIcon className="h-7 w-7" /> Homepage Banners
          </h1>
          <p className="text-muted-foreground mt-1">
            Manage marketing banners shown on the public storefront homepage.
          </p>
        </div>
        <Button onClick={openCreate} data-testid="button-new-banner">
          <Plus className="h-4 w-4 mr-2" /> New Banner
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Banners</CardTitle>
          <CardDescription>{filteredBanners.length} of {banners.length} banner(s)</CardDescription>
          <div className="flex flex-wrap gap-3 pt-2">
            <div className="w-64">
              <Label className="text-xs">Search</Label>
              <Input
                placeholder="Search by name…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                data-testid="input-search-banner"
              />
            </div>
            <div className="w-44">
              <Label className="text-xs">Status</Label>
              <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as BannerStatus | "all")}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="Live">Live</SelectItem>
                  <SelectItem value="Scheduled">Scheduled</SelectItem>
                  <SelectItem value="Paused">Paused</SelectItem>
                  <SelectItem value="Draft">Draft</SelectItem>
                  <SelectItem value="Inactive">Inactive</SelectItem>
                  <SelectItem value="Expired">Expired</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="w-56">
              <Label className="text-xs">Country</Label>
              <Select value={countryFilter} onValueChange={setCountryFilter}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All countries</SelectItem>
                  {availableCountries.map((c) => (
                    <SelectItem key={c} value={c}>
                      <span className="inline-flex items-center gap-2">
                        <FlagImage country={c} url={countryFlagUrls[c] ?? null} size={14} />
                        {c}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {bannersQuery.isLoading ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading…
            </div>
          ) : filteredBanners.length === 0 ? (
            <div className="text-center py-10 text-muted-foreground">
              No banners match the current filters.
            </div>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={(event: DragEndEvent) => {
                const { active, over } = event;
                if (!over || active.id === over.id || isFiltered) return;
                setLocalOrder((prev) => {
                  const oldIndex = prev.indexOf(Number(active.id));
                  const newIndex = prev.indexOf(Number(over.id));
                  if (oldIndex === -1 || newIndex === -1) return prev;
                  const next = arrayMove(prev, oldIndex, newIndex);
                  reorderMutation.mutate(
                    next.map((id, idx) => ({ id, sort_order: idx })),
                  );
                  return next;
                });
              }}
            >
              <SortableContext
                items={filteredBanners.map((b) => b.id)}
                strategy={verticalListSortingStrategy}
                disabled={isFiltered}
              >
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-8 px-1" />
                      <TableHead className="w-[80px]">Preview</TableHead>
                      <TableHead>Name</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Targeting</TableHead>
                      <TableHead>Devices</TableHead>
                      <TableHead>Schedule</TableHead>
                      <TableHead className="w-[160px]">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredBanners.map((b) => (
                      <SortableBannerRow
                        key={b.id}
                        banner={b}
                        isFiltered={isFiltered}
                        countryFlagUrls={countryFlagUrls}
                        onEdit={openEdit}
                        onPreview={setPreviewBanner}
                        onPause={(id) => pauseMutation.mutate(id)}
                        onResume={(id) => resumeMutation.mutate(id)}
                        onDuplicate={(id) => duplicateMutation.mutate(id)}
                        onDelete={setConfirmDelete}
                      />
                    ))}
                  </TableBody>
                </Table>
              </SortableContext>
            </DndContext>
          )}
        </CardContent>
      </Card>

      <BannerEditorDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editingId={editingId}
        form={form}
        setForm={setForm}
        availableCountries={availableCountries}
        countryFlagUrls={countryFlagUrls}
        locations={locations}
        onSaveDraft={() => saveMutation.mutate("draft")}
        onPublish={() => saveMutation.mutate("publish")}
        saving={saveMutation.isPending}
      />

      <PreviewDialog
        banner={previewBanner}
        locations={locations}
        countryFlagUrls={countryFlagUrls}
        onClose={() => setPreviewBanner(null)}
      />

      <AlertDialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete banner?</AlertDialogTitle>
            <AlertDialogDescription>
              {confirmDelete?.internal_name ? `"${confirmDelete.internal_name}" will be permanently deleted.` : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => confirmDelete && deleteMutation.mutate(confirmDelete.id)}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sortable banner row — wraps TableRow with dnd-kit useSortable.
// ---------------------------------------------------------------------------

interface SortableBannerRowProps {
  banner: Banner;
  isFiltered: boolean;
  countryFlagUrls: Record<string, string | null>;
  onEdit: (b: Banner) => void;
  onPreview: (b: Banner) => void;
  onPause: (id: number) => void;
  onResume: (id: number) => void;
  onDuplicate: (id: number) => void;
  onDelete: (b: Banner) => void;
}

function SortableBannerRow({
  banner: b,
  isFiltered,
  countryFlagUrls,
  onEdit,
  onPreview,
  onPause,
  onResume,
  onDuplicate,
  onDelete,
}: SortableBannerRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: b.id,
    disabled: isFiltered,
  });
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    position: isDragging ? "relative" : undefined,
    zIndex: isDragging ? 10 : undefined,
  };

  const thumb =
    b.desktop.fallback_image_url ||
    (b.desktop.media_type === "image" ? b.desktop.media_url : null) ||
    b.mobile.fallback_image_url ||
    (b.mobile.media_type === "image" ? b.mobile.media_url : null);
  const canPause = b.status === "Live" || b.status === "Scheduled";
  const canResume = b.status === "Paused";

  return (
    <TableRow ref={setNodeRef} style={style} {...attributes} data-testid={`row-banner-${b.id}`}>
      <TableCell className="w-8 px-1">
        {!isFiltered ? (
          <button
            type="button"
            {...listeners}
            className="cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground touch-none p-1 rounded"
            title="Drag to reorder"
          >
            <GripVertical className="h-4 w-4" />
          </button>
        ) : (
          <span className="w-6 inline-block" />
        )}
      </TableCell>
      <TableCell>
        {thumb ? (
          <img src={thumb} alt="" className="h-12 w-16 object-cover rounded border" />
        ) : (
          <div className="h-12 w-16 rounded border bg-muted flex items-center justify-center text-muted-foreground">
            <ImageIcon className="h-4 w-4" />
          </div>
        )}
      </TableCell>
      <TableCell className="font-medium">
        <div>{b.internal_name}</div>
        {b.headline ? (
          <div className="text-xs text-muted-foreground truncate max-w-[200px]">{b.headline}</div>
        ) : null}
      </TableCell>
      <TableCell>
        <StatusPill status={b.status} />
      </TableCell>
      <TableCell className="text-sm">
        <div className="flex flex-wrap items-center gap-1">
          {b.country_codes.length === 0 ? (
            <span className="text-muted-foreground">—</span>
          ) : (
            b.country_codes.slice(0, 3).map((c) => (
              <span key={c} className="inline-flex items-center gap-0.5">
                <FlagImage country={c} url={countryFlagUrls[c] ?? null} size={12} />
                <span className="text-xs">{c}</span>
              </span>
            ))
          )}
          {b.country_codes.length > 3 && (
            <span className="text-xs text-muted-foreground">+{b.country_codes.length - 3}</span>
          )}
        </div>
        <div className="text-xs text-muted-foreground mt-0.5">
          {b.is_global_for_country ? "All cities" : `${b.city_ids.length} city(ies)`}
        </div>
      </TableCell>
      <TableCell>
        <div className="flex flex-col gap-0.5">
          {b.desktop.enabled && (
            <Badge variant="outline" className="text-xs py-0 h-5">
              <Monitor className="h-3 w-3 mr-0.5" /> Desktop
            </Badge>
          )}
          {b.mobile.enabled && (
            <Badge variant="outline" className="text-xs py-0 h-5">
              <Smartphone className="h-3 w-3 mr-0.5" /> Mobile
            </Badge>
          )}
        </div>
      </TableCell>
      <TableCell className="text-xs">
        <div>{b.start_at ? new Date(b.start_at).toLocaleDateString() : "—"}</div>
        {b.end_at && (
          <div className="text-muted-foreground">→ {new Date(b.end_at).toLocaleDateString()}</div>
        )}
      </TableCell>
      <TableCell>
        <div className="flex gap-1 flex-wrap">
          <Button size="icon" variant="ghost" onClick={() => onEdit(b)}
            data-testid={`button-edit-${b.id}`} title="Edit">
            <Pencil className="h-4 w-4" />
          </Button>
          <Button size="icon" variant="ghost" onClick={() => onPreview(b)}
            title="Preview" data-testid={`button-preview-${b.id}`}>
            <Eye className="h-4 w-4" />
          </Button>
          {canPause && (
            <Button size="icon" variant="ghost" title="Pause"
              onClick={() => onPause(b.id)}
              data-testid={`button-pause-${b.id}`}>
              <Pause className="h-4 w-4" />
            </Button>
          )}
          {canResume && (
            <Button size="icon" variant="ghost" title="Resume"
              onClick={() => onResume(b.id)}
              data-testid={`button-resume-${b.id}`}>
              <Play className="h-4 w-4" />
            </Button>
          )}
          <Button size="icon" variant="ghost" onClick={() => onDuplicate(b.id)}
            title="Duplicate" data-testid={`button-duplicate-${b.id}`}>
            <Copy className="h-4 w-4" />
          </Button>
          <Button size="icon" variant="ghost" onClick={() => onDelete(b)}
            title="Delete" data-testid={`button-delete-${b.id}`}>
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        </div>
      </TableCell>
    </TableRow>
  );
}

// ---------------------------------------------------------------------------
// Two-column Banner Editor Dialog
// ---------------------------------------------------------------------------

const STEPS = [
  { id: "info",        label: "Information" },
  { id: "targeting",   label: "Targeting" },
  { id: "media",       label: "Media" },
  { id: "destination", label: "Destination" },
  { id: "schedule",    label: "Schedule" },
] as const;

interface EditorProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  editingId: number | null;
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
  availableCountries: string[];
  countryFlagUrls: Record<string, string | null>;
  locations: Location[];
  onSaveDraft: () => void;
  onPublish: () => void;
  saving: boolean;
}

function BannerEditorDialog({
  open,
  onOpenChange,
  editingId,
  form,
  setForm,
  availableCountries,
  countryFlagUrls,
  locations,
  onSaveDraft,
  onPublish,
  saving,
}: EditorProps) {
  const [activeStep, setActiveStep] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sectionRefs = [
    useRef<HTMLElement>(null),
    useRef<HTMLElement>(null),
    useRef<HTMLElement>(null),
    useRef<HTMLElement>(null),
    useRef<HTMLElement>(null),
  ];

  useEffect(() => {
    if (!open) return;
    setActiveStep(0);
  }, [open]);

  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && entry.intersectionRatio > 0.2) {
            const idx = sectionRefs.findIndex((r) => r.current === entry.target);
            if (idx >= 0) setActiveStep(idx);
          }
        }
      },
      { root: container, threshold: 0.2 },
    );
    sectionRefs.forEach((r) => r.current && observer.observe(r.current));
    return () => observer.disconnect();
  });

  function scrollToStep(idx: number) {
    const el = sectionRefs[idx]?.current;
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveStep(idx);
  }

  function updateSide(side: "desktop" | "mobile", patch: Partial<Side>) {
    setForm((prev) => ({ ...prev, [side]: { ...prev[side], ...patch } }));
  }

  const citiesForSelectedCountries = useMemo(
    () => locations.filter((l) => form.country_codes.includes(l.country)),
    [form.country_codes, locations],
  );

  useEffect(() => {
    const validIds = new Set(citiesForSelectedCountries.map((l) => l.id));
    setForm((prev) => {
      const filtered = prev.city_ids.filter((id) => validIds.has(id));
      if (filtered.length === prev.city_ids.length) return prev;
      return { ...prev, city_ids: filtered };
    });
  }, [citiesForSelectedCountries, setForm]);

  const unrecognizedCountries = useMemo(
    () => form.country_codes.filter((c) => !findCountryByName(c) && !findCountryByCode(c)),
    [form.country_codes],
  );

  function toggleCountry(country: string) {
    setForm((prev) => ({
      ...prev,
      country_codes: prev.country_codes.includes(country)
        ? prev.country_codes.filter((c) => c !== country)
        : [...prev.country_codes, country],
    }));
  }

  function toggleCity(cityId: number) {
    setForm((prev) => ({
      ...prev,
      city_ids: prev.city_ids.includes(cityId)
        ? prev.city_ids.filter((id) => id !== cityId)
        : [...prev.city_ids, cityId],
    }));
  }

  function toggleLanguage(lang: string) {
    setForm((prev) => ({
      ...prev,
      languages: prev.languages.includes(lang)
        ? prev.languages.filter((l) => l !== lang)
        : [...prev.languages, lang],
    }));
  }

  const publishLabel =
    form.schedule_mode === "scheduled" ? "Schedule banner" : "Publish banner";

  const canPublish =
    form.internal_name.trim().length > 0 &&
    form.country_codes.length > 0 &&
    (form.desktop.enabled || form.mobile.enabled) &&
    (!form.desktop.enabled || !!form.desktop.media_url) &&
    (!form.mobile.enabled || !!form.mobile.media_url) &&
    (form.schedule_mode !== "scheduled" || !!form.start_at);

  const attentionItems: string[] = [];
  if (!form.internal_name.trim()) attentionItems.push("Internal name is required");
  if (form.country_codes.length === 0) attentionItems.push("Select at least one target country");
  if (!form.desktop.enabled && !form.mobile.enabled) attentionItems.push("Enable at least one device (desktop or mobile)");
  if (form.desktop.enabled && !form.desktop.media_url) attentionItems.push("Desktop image/video is missing");
  if (form.mobile.enabled && !form.mobile.media_url) attentionItems.push("Mobile image/video is missing");
  if (form.schedule_mode === "scheduled" && !form.start_at) attentionItems.push("Set a start date for scheduled publishing");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[1140px] w-[95vw] p-0 gap-0 overflow-hidden flex flex-col h-[90vh]">
        <DialogTitle className="sr-only">{editingId ? "Edit Banner" : "New Banner"}</DialogTitle>
        <DialogDescription className="sr-only">
          Configure media, targeting, and schedule for this homepage banner.
        </DialogDescription>

        {/* Step indicator */}
        <div className="border-b flex-shrink-0 px-6 py-3 bg-background">
          <div className="flex items-center gap-0">
            {STEPS.map((step, idx) => (
              <div key={step.id} className="flex items-center">
                <button
                  type="button"
                  onClick={() => scrollToStep(idx)}
                  className={cn(
                    "flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium transition-colors",
                    activeStep === idx
                      ? "bg-teal-50 text-teal-700 border border-teal-300"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted",
                  )}
                >
                  <span
                    className={cn(
                      "inline-flex items-center justify-center w-5 h-5 rounded-full text-xs font-bold",
                      activeStep === idx
                        ? "bg-teal-600 text-white"
                        : idx < activeStep
                        ? "bg-teal-200 text-teal-700"
                        : "bg-muted text-muted-foreground",
                    )}
                  >
                    {idx < activeStep ? "✓" : idx + 1}
                  </span>
                  {step.label}
                </button>
                {idx < STEPS.length - 1 && (
                  <div className="w-6 h-px bg-border mx-1 flex-shrink-0" />
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Main content: left form + right panel */}
        <div className="flex flex-1 min-h-0 overflow-hidden">
          {/* Left: scrollable form */}
          <div ref={scrollRef} className="flex-1 overflow-y-auto">
            <div className="p-6 space-y-8">
              {/* Section 1: Banner Information */}
              <section ref={sectionRefs[0] as React.RefObject<HTMLElement>} className="space-y-4">
                <SectionHeader icon={<Info className="h-4 w-4" />} title="Banner information" step={1} />
                <div className="space-y-3">
                  <div>
                    <Label>Internal name <span className="text-destructive">*</span></Label>
                    <p className="text-xs text-muted-foreground mb-1">Only visible to admins. Used to identify this banner.</p>
                    <Input
                      value={form.internal_name}
                      onChange={(e) => setForm({ ...form, internal_name: e.target.value })}
                      placeholder="e.g. Spring Sale 2026 — UAE"
                      data-testid="input-internal-name"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label>Headline</Label>
                      <Input
                        value={form.headline}
                        onChange={(e) => setForm({ ...form, headline: e.target.value })}
                        placeholder="Send flowers today"
                      />
                    </div>
                    <div>
                      <Label>CTA button text</Label>
                      <Input
                        value={form.cta_text}
                        onChange={(e) => setForm({ ...form, cta_text: e.target.value })}
                        placeholder="Shop now"
                      />
                    </div>
                  </div>
                  <div>
                    <Label>Subtitle</Label>
                    <Textarea
                      rows={2}
                      value={form.subtitle}
                      onChange={(e) => setForm({ ...form, subtitle: e.target.value })}
                      placeholder="Fresh flowers delivered in 2 hours"
                    />
                  </div>
                </div>
              </section>

              <Separator />

              {/* Section 2: Targeting */}
              <section ref={sectionRefs[1] as React.RefObject<HTMLElement>} className="space-y-4">
                <SectionHeader icon={<Globe className="h-4 w-4" />} title="Targeting" step={2} />

                {/* Country targeting */}
                <div>
                  <Label className="mb-2 block">Countries <span className="text-destructive">*</span></Label>
                  {availableCountries.length === 0 ? (
                    <p className="text-sm text-muted-foreground">No countries configured. Set them in Settings.</p>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {availableCountries.map((c) => {
                        const selected = form.country_codes.includes(c);
                        return (
                          <button
                            key={c}
                            type="button"
                            onClick={() => toggleCountry(c)}
                            className={cn(
                              "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm font-medium transition-colors",
                              selected
                                ? "bg-teal-600 text-white border-teal-600"
                                : "bg-background text-foreground border-border hover:border-teal-400",
                            )}
                          >
                            <FlagImage country={c} url={countryFlagUrls[c] ?? null} size={14} />
                            {c}
                            {selected && <X className="h-3 w-3 ml-0.5 opacity-70" />}
                          </button>
                        );
                      })}
                    </div>
                  )}
                  {unrecognizedCountries.length > 0 && (
                    <p className="text-xs text-amber-600 mt-2 flex items-start gap-1">
                      <AlertTriangle className="h-3 w-3 mt-0.5 flex-shrink-0" />
                      {unrecognizedCountries.join(", ")} {unrecognizedCountries.length === 1 ? "is" : "are"} not a recognized country. This banner may not appear on the storefront.
                    </p>
                  )}
                </div>

                {/* City targeting */}
                <div className="space-y-2">
                  <Label>City targeting</Label>
                  <div className="flex gap-3">
                    {(["all", "specific"] as const).map((mode) => (
                      <label key={mode} className={cn(
                        "flex items-center gap-2 px-3 py-2 rounded-lg border cursor-pointer flex-1 text-sm",
                        (mode === "all") === form.is_global_for_country
                          ? "border-teal-400 bg-teal-50 text-teal-800"
                          : "border-border hover:border-muted-foreground",
                      )}>
                        <input
                          type="radio"
                          name="city_scope"
                          checked={(mode === "all") === form.is_global_for_country}
                          onChange={() => setForm({ ...form, is_global_for_country: mode === "all" })}
                          className="accent-teal-600"
                        />
                        {mode === "all" ? "All cities in selected countries" : "Specific cities"}
                      </label>
                    ))}
                  </div>
                  {!form.is_global_for_country && (
                    <div>
                      {citiesForSelectedCountries.length === 0 ? (
                        <p className="text-sm text-muted-foreground">Select countries above to see their cities.</p>
                      ) : (
                        <div className="flex flex-wrap gap-2 max-h-36 overflow-y-auto border rounded-lg p-3 bg-muted/20">
                          {citiesForSelectedCountries.map((l) => {
                            const selected = form.city_ids.includes(l.id);
                            return (
                              <button
                                key={l.id}
                                type="button"
                                onClick={() => toggleCity(l.id)}
                                className={cn(
                                  "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors",
                                  selected
                                    ? "bg-teal-600 text-white border-teal-600"
                                    : "bg-background text-foreground border-border hover:border-teal-400",
                                )}
                              >
                                {l.name} <span className="opacity-60">({l.country})</span>
                                {selected && <X className="h-2.5 w-2.5 ml-0.5" />}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Language targeting */}
                <div>
                  <Label className="mb-2 block">Language targeting</Label>
                  <div className="flex gap-4">
                    {[
                      { code: "en", label: "English" },
                      { code: "ar", label: "Arabic" },
                      { code: "fr", label: "French" },
                    ].map(({ code, label }) => (
                      <label key={code} className="flex items-center gap-2 cursor-pointer">
                        <Checkbox
                          checked={form.languages.includes(code)}
                          onCheckedChange={() => toggleLanguage(code)}
                        />
                        <span className="text-sm">{label}</span>
                      </label>
                    ))}
                  </div>
                  {form.languages.length === 0 && (
                    <p className="text-xs text-amber-600 mt-1 flex items-center gap-1">
                      <AlertTriangle className="h-3 w-3" /> Select at least one language.
                    </p>
                  )}
                </div>
              </section>

              <Separator />

              {/* Section 3: Media */}
              <section ref={sectionRefs[2] as React.RefObject<HTMLElement>} className="space-y-4">
                <SectionHeader icon={<ImageIcon className="h-4 w-4" />} title="Media" step={3} />
                <p className="text-sm text-muted-foreground -mt-2">
                  Enable each device and upload the banner image or video. Enable at least one.
                </p>

                <div className="grid grid-cols-2 gap-4">
                  <MediaUploadCard
                    side="desktop"
                    value={form.desktop}
                    onChange={(p) => updateSide("desktop", p)}
                  />
                  <MediaUploadCard
                    side="mobile"
                    value={form.mobile}
                    onChange={(p) => updateSide("mobile", p)}
                    onUseDeskopImage={
                      form.desktop.media_url
                        ? () => updateSide("mobile", { media_url: form.desktop.media_url, media_type: form.desktop.media_type })
                        : undefined
                    }
                  />
                </div>

                {!form.desktop.enabled && !form.mobile.enabled && (
                  <div className="flex items-center gap-2 text-sm text-amber-600 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
                    <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                    Enable at least one device.
                  </div>
                )}
              </section>

              <Separator />

              {/* Section 4: Destination */}
              <section ref={sectionRefs[3] as React.RefObject<HTMLElement>} className="space-y-4">
                <SectionHeader icon={<Link2 className="h-4 w-4" />} title="Banner click destination" step={4} />
                <p className="text-sm text-muted-foreground -mt-2">
                  Where customers land when they tap this banner.
                </p>
                <DestinationSection form={form} setForm={setForm} />
              </section>

              <Separator />

              {/* Section 5: Publishing schedule */}
              <section ref={sectionRefs[4] as React.RefObject<HTMLElement>} className="space-y-4">
                <SectionHeader icon={<CalendarClock className="h-4 w-4" />} title="Publishing schedule" step={5} />
                <ScheduleSection form={form} setForm={setForm} />

                {/* Display priority is now managed by drag-and-drop in the banner list. */}
              </section>

              <div className="pb-4" />
            </div>
          </div>

          {/* Right: sticky preview + summary */}
          <div className="w-[340px] flex-shrink-0 border-l bg-muted/20 overflow-y-auto flex flex-col">
            <BannerPreviewPanel form={form} />
            <PublishingSummaryPanel
              form={form}
              attentionItems={attentionItems}
              availableCountries={availableCountries}
              locations={locations}
            />
          </div>
        </div>

        {/* Footer */}
        <div className="border-t flex-shrink-0 px-6 py-4 flex items-center justify-between bg-background">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={onSaveDraft}
              disabled={saving || !form.internal_name.trim()}
              data-testid="button-save-draft"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Save draft
            </Button>
            {form.schedule_mode !== "draft" && (
              <Button
                onClick={onPublish}
                disabled={saving || !canPublish}
                className="bg-teal-600 hover:bg-teal-700 text-white"
                data-testid="button-publish-banner"
              >
                {saving ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <CheckCircle2 className="h-4 w-4 mr-2" />}
                {editingId ? `Update — ${publishLabel}` : publishLabel}
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SectionHeader({ icon, title, step }: { icon: React.ReactNode; title: string; step: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-teal-600 text-white text-xs font-bold flex-shrink-0">
        {step}
      </span>
      <span className="flex items-center gap-1.5 font-semibold text-base">
        {icon}
        <span className="capitalize">{title}</span>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Media upload card
// ---------------------------------------------------------------------------

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_VIDEO_BYTES = 25 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const ALLOWED_VIDEO_TYPES = ["video/mp4"];

const RECOMMENDED_DIMS: Record<"desktop" | "mobile", { w: number; h: number }> = {
  desktop: { w: 2800, h: 1100 },
  mobile:  { w: 1080, h: 1350 },
};

function useImageDimensions(url: string | null) {
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    if (!url || url.startsWith("blob:")) { setDims(null); return; }
    const img = new Image();
    img.onload = () => setDims({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => setDims(null);
    img.src = url;
  }, [url]);
  return dims;
}

function filenameFromUrl(url: string | null): string {
  if (!url) return "";
  try {
    return decodeURIComponent(url.split("/").pop()?.split("?")[0] ?? "").slice(-40) || url;
  } catch {
    return url.slice(-40);
  }
}

interface MediaUploadCardProps {
  side: "desktop" | "mobile";
  value: Side;
  onChange: (patch: Partial<Side>) => void;
  onUseDeskopImage?: () => void;
}

function MediaUploadCard({ side, value, onChange, onUseDeskopImage }: MediaUploadCardProps) {
  const { uploadFile, isUploading } = useUpload({ getAuthToken: getClerkToken });
  const { toast } = useToast();
  const [uploadingField, setUploadingField] = useState<"media" | "fallback" | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fallbackInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const recommended = RECOMMENDED_DIMS[side];
  const dims = useImageDimensions(value.media_type === "image" ? value.media_url : null);
  const sizeWarning = dims
    ? (dims.w !== recommended.w || dims.h !== recommended.h)
      ? `Uploaded image is ${dims.w}×${dims.h}px. Recommended: ${recommended.w}×${recommended.h}px.`
      : null
    : null;

  function validateFile(field: "media" | "fallback", file: File): string | null {
    const isVid = field === "media" && value.media_type === "video";
    const allowed = isVid ? ALLOWED_VIDEO_TYPES : ALLOWED_IMAGE_TYPES;
    const max = isVid ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
    if (!allowed.includes(file.type)) return `Unsupported type: ${file.type}. Allowed: ${allowed.join(", ")}`;
    if (file.size > max) return `File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max: ${(max / 1024 / 1024).toFixed(0)} MB.`;
    return null;
  }

  async function handleUpload(field: "media" | "fallback", file: File) {
    if (!value.media_type && field === "media") {
      onChange({ media_type: file.type.startsWith("video/") ? "video" : "image" });
    }
    const err = validateFile(field, file);
    if (err) {
      toast({ title: "Invalid file", description: err, variant: "destructive" });
      return;
    }
    setUploadingField(field);
    try {
      const res = await uploadFile(file);
      if (!res) {
        toast({ title: "Upload failed", description: "Please try again.", variant: "destructive" });
        return;
      }
      let url: string;
      try {
        const promoted = await apiFetch<{ url: string }>("/api/storage/uploads/make-public", {
          method: "POST",
          body: JSON.stringify({ objectPath: res.objectPath }),
        });
        if (!promoted?.url) throw new Error("No public link returned");
        url = promoted.url;
      } catch (err) {
        toast({
          title: "Upload failed",
          description: err instanceof Error ? err.message : "Could not generate a public link. Please try again.",
          variant: "destructive",
        });
        return;
      }
      if (field === "media") {
        onChange({
          media_url: url,
          media_type: file.type.startsWith("video/") ? "video" : "image",
        });
      } else {
        onChange({ fallback_image_url: url });
      }
    } finally {
      setUploadingField(null);
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) void handleUpload("media", file);
  }

  const isUploadingMedia = uploadingField === "media" && isUploading;
  const isUploadingFallback = uploadingField === "fallback" && isUploading;
  const hasMedia = !!value.media_url;

  return (
    <div className={cn(
      "border rounded-xl p-4 space-y-3 bg-background transition-colors",
      value.enabled ? "border-teal-300" : "border-border opacity-70",
    )}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {side === "desktop" ? <Monitor className="h-4 w-4 text-muted-foreground" /> : <Smartphone className="h-4 w-4 text-muted-foreground" />}
          <span className="font-medium capitalize">{side}</span>
          <span className="text-xs text-muted-foreground">
            {recommended.w}×{recommended.h}px
          </span>
        </div>
        <label className="flex items-center gap-1.5 cursor-pointer">
          <input
            type="checkbox"
            className="accent-teal-600"
            checked={value.enabled}
            onChange={(e) => onChange({ enabled: e.target.checked })}
          />
          <span className="text-sm">Enabled</span>
        </label>
      </div>

      {value.enabled && (
        <>
          {/* Media type selector */}
          {!hasMedia && (
            <div className="flex gap-2">
              {(["image", "video"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => onChange({ media_type: t })}
                  className={cn(
                    "flex-1 py-1 rounded-md border text-xs font-medium transition-colors",
                    value.media_type === t
                      ? "border-teal-500 bg-teal-50 text-teal-700"
                      : "border-border text-muted-foreground hover:border-teal-300",
                  )}
                >
                  {t === "image" ? "Image" : "Video"}
                </button>
              ))}
            </div>
          )}

          {/* Drop zone / thumbnail */}
          {!hasMedia ? (
            <div
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              className={cn(
                "border-2 border-dashed rounded-lg flex flex-col items-center justify-center gap-2 py-8 cursor-pointer transition-colors",
                dragOver ? "border-teal-400 bg-teal-50" : "border-border hover:border-teal-300 hover:bg-muted/50",
              )}
            >
              {isUploadingMedia ? (
                <Loader2 className="h-6 w-6 animate-spin text-teal-600" />
              ) : (
                <>
                  <Upload className="h-6 w-6 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">Click or drag to upload</span>
                  <span className="text-xs text-muted-foreground">
                    {value.media_type === "video" ? "MP4 up to 25 MB" : "JPG, PNG, WebP up to 5 MB"}
                  </span>
                </>
              )}
              <input
                ref={fileInputRef}
                type="file"
                className="hidden"
                accept={value.media_type === "video" ? ALLOWED_VIDEO_TYPES.join(",") : ALLOWED_IMAGE_TYPES.join(",")}
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleUpload("media", f); }}
              />
            </div>
          ) : (
            <div className="space-y-2">
              {/* Thumbnail */}
              <div className="relative rounded-lg overflow-hidden border bg-muted" style={{ aspectRatio: side === "desktop" ? "2800/1100" : "1080/1350" }}>
                {value.media_type === "video" ? (
                  <video src={value.media_url!} className="w-full h-full object-cover" muted />
                ) : (
                  <img src={value.media_url!} alt="" className="w-full h-full object-cover" />
                )}
              </div>
              {/* Filename */}
              <p className="text-xs text-muted-foreground truncate" title={value.media_url ?? ""}>
                {filenameFromUrl(value.media_url)}
              </p>
              {/* Dimension warning */}
              {sizeWarning && (
                <p className="text-xs text-amber-600 flex items-start gap-1">
                  <AlertTriangle className="h-3 w-3 mt-0.5 flex-shrink-0" />
                  {sizeWarning}
                </p>
              )}
              {/* Replace/Remove */}
              <div className="flex gap-2">
                <label className="flex-1 text-center text-xs border rounded py-1.5 cursor-pointer hover:bg-muted">
                  {isUploadingMedia ? <Loader2 className="h-3 w-3 animate-spin inline mr-1" /> : <Upload className="h-3 w-3 inline mr-1" />}
                  Replace
                  <input
                    type="file"
                    className="hidden"
                    accept={value.media_type === "video" ? ALLOWED_VIDEO_TYPES.join(",") : ALLOWED_IMAGE_TYPES.join(",")}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleUpload("media", f); }}
                  />
                </label>
                <button
                  type="button"
                  onClick={() => onChange({ media_url: null, media_type: null })}
                  className="flex-1 text-xs border rounded py-1.5 text-destructive hover:bg-destructive/10"
                >
                  <Trash2 className="h-3 w-3 inline mr-1" />
                  Remove
                </button>
              </div>
            </div>
          )}

          {/* Fallback image (for video) */}
          {value.media_type === "video" && (
            <div className="space-y-1.5">
              <Label className="text-xs">Fallback image (required for video)</Label>
              {value.fallback_image_url ? (
                <div className="flex items-center gap-2">
                  <img src={value.fallback_image_url} alt="fallback" className="h-10 w-16 object-cover rounded border" />
                  <span className="text-xs text-muted-foreground flex-1 truncate">{filenameFromUrl(value.fallback_image_url)}</span>
                  <label className="text-xs border rounded px-2 py-1 cursor-pointer hover:bg-muted">
                    {isUploadingFallback ? <Loader2 className="h-3 w-3 animate-spin" /> : "Replace"}
                    <input ref={fallbackInputRef} type="file" className="hidden" accept={ALLOWED_IMAGE_TYPES.join(",")}
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleUpload("fallback", f); }} />
                  </label>
                  <button type="button" onClick={() => onChange({ fallback_image_url: null })}
                    className="text-destructive text-xs border rounded px-2 py-1 hover:bg-destructive/10">
                    Remove
                  </button>
                </div>
              ) : (
                <label className="flex items-center gap-2 text-xs border rounded-md px-3 py-2 cursor-pointer hover:bg-muted">
                  {isUploadingFallback ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                  Upload fallback image
                  <input ref={fallbackInputRef} type="file" className="hidden" accept={ALLOWED_IMAGE_TYPES.join(",")}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) void handleUpload("fallback", f); }} />
                </label>
              )}
            </div>
          )}

          {/* Use desktop image shortcut (mobile only) */}
          {side === "mobile" && onUseDeskopImage && !hasMedia && (
            <button type="button" onClick={onUseDeskopImage}
              className="w-full text-xs border border-dashed rounded py-1.5 text-teal-700 hover:bg-teal-50">
              Use desktop image for mobile
            </button>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Destination section
// ---------------------------------------------------------------------------

interface DestinationProps {
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
}

function DestinationSection({ form, setForm }: DestinationProps) {
  const occasionsQuery = useListOccasions(
    { status: "active", pageSize: 100 },
    {
      query: {
        queryKey: getListOccasionsQueryKey({ status: "active", pageSize: 100 }),
        enabled: form.destination_type === "occasion",
      },
    },
  );
  const categoriesQuery = useListCatalogCategories(
    { status: "active", pageSize: 100 },
    {
      query: {
        queryKey: getListCatalogCategoriesQueryKey({ status: "active", pageSize: 100 }),
        enabled: form.destination_type === "category",
      },
    },
  );

  const items =
    form.destination_type === "occasion"
      ? occasionsQuery.data?.items ?? []
      : form.destination_type === "category"
      ? categoriesQuery.data?.items ?? []
      : [];
  const isLoading = form.destination_type === "occasion" ? occasionsQuery.isLoading : categoriesQuery.isLoading;

  const DEST_OPTIONS = [
    { value: "none",       label: "No link" },
    { value: "category",   label: "Category" },
    { value: "occasion",   label: "Occasion" },
    { value: "custom_url", label: "Custom URL" },
  ] as const;

  return (
    <div className="space-y-3">
      <div>
        <Label>Click destination</Label>
        <Select
          value={form.destination_type}
          onValueChange={(v) =>
            setForm({ ...form, destination_type: v as DestinationType, link_attribute_id: null, destination_value: "" })
          }
        >
          <SelectTrigger className="w-56" data-testid="select-destination-type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DEST_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {(form.destination_type === "category" || form.destination_type === "occasion") && (
        <div>
          <Label>{form.destination_type === "occasion" ? "Select occasion" : "Select category"}</Label>
          <Select
            value={form.link_attribute_id != null ? String(form.link_attribute_id) : ""}
            onValueChange={(v) => setForm({ ...form, link_attribute_id: Number(v) })}
            disabled={isLoading}
          >
            <SelectTrigger data-testid="select-link-attribute">
              <SelectValue placeholder={isLoading ? "Loading…" : `Select ${form.destination_type}…`} />
            </SelectTrigger>
            <SelectContent>
              {items.map((it) => (
                <SelectItem key={it.id} value={String(it.id)}>{it.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {form.destination_type === "custom_url" && (
        <div>
          <Label>URL</Label>
          <Input
            type="url"
            placeholder="https://example.com/page"
            value={form.destination_value}
            onChange={(e) => setForm({ ...form, destination_value: e.target.value })}
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Schedule section
// ---------------------------------------------------------------------------

interface ScheduleProps {
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
}

function ScheduleSection({ form, setForm }: ScheduleProps) {
  const MODES = [
    {
      value: "draft" as ScheduleMode,
      label: "Draft",
      desc: "Saved but not visible on the storefront.",
      icon: <Info className="h-4 w-4 text-muted-foreground" />,
    },
    {
      value: "now" as ScheduleMode,
      label: "Publish now",
      desc: "Goes live immediately after saving.",
      icon: <CheckCircle2 className="h-4 w-4 text-teal-600" />,
    },
    {
      value: "scheduled" as ScheduleMode,
      label: "Schedule",
      desc: "Set a start date/time and optional end.",
      icon: <CalendarClock className="h-4 w-4 text-blue-600" />,
    },
  ] as const;

  function formatTzLabel(tz: string): string {
    try {
      const offset = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "shortOffset" })
        .formatToParts(new Date())
        .find((p) => p.type === "timeZoneName")?.value ?? "";
      return `${tz} (${offset})`;
    } catch {
      return tz;
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        {MODES.map((mode) => (
          <button
            key={mode.value}
            type="button"
            onClick={() => setForm({ ...form, schedule_mode: mode.value })}
            className={cn(
              "flex flex-col items-start gap-1.5 rounded-xl border p-3 text-left transition-colors",
              form.schedule_mode === mode.value
                ? "border-teal-400 bg-teal-50"
                : "border-border hover:border-muted-foreground",
            )}
          >
            <div className="flex items-center gap-1.5">
              {mode.icon}
              <span className="font-medium text-sm">{mode.label}</span>
            </div>
            <span className="text-xs text-muted-foreground">{mode.desc}</span>
          </button>
        ))}
      </div>

      {form.schedule_mode === "scheduled" && (
        <div className="space-y-3 border rounded-lg p-4 bg-blue-50/50">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>Start date & time <span className="text-destructive">*</span></Label>
              <Input
                type="datetime-local"
                value={form.start_at}
                onChange={(e) => setForm({ ...form, start_at: e.target.value })}
              />
            </div>
            <div>
              <Label>End date & time <span className="text-muted-foreground">(optional)</span></Label>
              <Input
                type="datetime-local"
                value={form.end_at}
                onChange={(e) => setForm({ ...form, end_at: e.target.value })}
              />
            </div>
          </div>
          <div>
            <Label>Timezone</Label>
            <Input
              value={form.timezone}
              onChange={(e) => setForm({ ...form, timezone: e.target.value })}
              placeholder="Asia/Beirut"
            />
            <p className="text-xs text-muted-foreground mt-0.5">
              Current: {formatTzLabel(form.timezone)}
            </p>
          </div>
        </div>
      )}

      {form.schedule_mode === "now" && (
        <div className="space-y-3">
          <div>
            <Label>End date & time <span className="text-muted-foreground">(optional)</span></Label>
            <div className="flex gap-3">
              <Input
                type="datetime-local"
                value={form.end_at}
                onChange={(e) => setForm({ ...form, end_at: e.target.value })}
                className="w-56"
              />
              {form.end_at && (
                <Button variant="ghost" size="sm" onClick={() => setForm({ ...form, end_at: "" })}>
                  <X className="h-4 w-4" />
                </Button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Right panel: Banner preview
// ---------------------------------------------------------------------------

function BannerPreviewPanel({ form }: { form: FormState }) {
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const side = device === "desktop" ? form.desktop : form.mobile;

  return (
    <div className="p-4 space-y-3 border-b">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold">Preview</span>
        <div className="flex gap-1">
          {(["desktop", "mobile"] as const).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDevice(d)}
              className={cn(
                "flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-colors",
                device === d
                  ? "bg-teal-600 text-white"
                  : "text-muted-foreground hover:text-foreground border hover:border-muted-foreground",
              )}
              data-testid={`button-inform-preview-${d}`}
            >
              {d === "desktop" ? <Monitor className="h-3 w-3" /> : <Smartphone className="h-3 w-3" />}
              <span className="capitalize">{d}</span>
            </button>
          ))}
        </div>
      </div>

      <div
        className="border rounded-lg overflow-hidden bg-muted"
        style={
          device === "desktop"
            ? { aspectRatio: "2800/1100" }
            : { aspectRatio: "1080/1350", maxHeight: 200, margin: "0 auto", maxWidth: 160 }
        }
      >
        {side.enabled && side.media_type === "video" && side.media_url ? (
          <video src={side.media_url} poster={side.fallback_image_url ?? undefined}
            className="w-full h-full object-cover" autoPlay muted loop playsInline />
        ) : side.enabled && side.media_type === "image" && side.media_url ? (
          <img src={side.media_url} alt="" className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center text-muted-foreground gap-1">
            <ImageIcon className="h-6 w-6 opacity-40" />
            <span className="text-xs opacity-60">No {device} media</span>
          </div>
        )}
      </div>

      {(form.headline || form.cta_text) && (
        <div className="text-xs text-muted-foreground space-y-0.5 px-1">
          {form.headline && <p className="font-medium text-foreground truncate">{form.headline}</p>}
          {form.subtitle && <p className="truncate">{form.subtitle}</p>}
          {form.cta_text && (
            <span className="inline-block bg-teal-600 text-white rounded px-2 py-0.5 text-xs mt-1">{form.cta_text}</span>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Right panel: Publishing summary
// ---------------------------------------------------------------------------

function computePreviewStatus(form: FormState): BannerStatus {
  if (form.schedule_mode === "draft") return "Draft";
  if (form.schedule_mode === "now") return "Live";
  if (form.schedule_mode === "scheduled") {
    if (!form.start_at) return "Draft";
    const startMs = fromLocalInput(form.start_at, form.timezone);
    if (!startMs) return "Draft";
    return Date.parse(startMs) > Date.now() ? "Scheduled" : "Live";
  }
  return "Draft";
}

function PublishingSummaryPanel({
  form,
  attentionItems,
  availableCountries,
  locations,
}: {
  form: FormState;
  attentionItems: string[];
  availableCountries: string[];
  locations: Location[];
}) {
  const previewStatus = computePreviewStatus(form);

  const deviceSummary = [
    form.desktop.enabled && "Desktop",
    form.mobile.enabled && "Mobile",
  ].filter(Boolean).join(", ") || "None";

  const langLabels: Record<string, string> = { en: "English", ar: "Arabic", fr: "French" };
  const langSummary = form.languages.map((l) => langLabels[l] ?? l).join(", ") || "None";

  const targetingSummary = form.country_codes.length === 0
    ? "No countries selected"
    : `${form.country_codes.slice(0, 3).join(", ")}${form.country_codes.length > 3 ? ` +${form.country_codes.length - 3}` : ""} — ${form.is_global_for_country ? "All cities" : form.city_ids.length === 0 ? "No specific cities" : `${form.city_ids.length} city(ies)`}`;

  let scheduleSummary = "—";
  if (form.schedule_mode === "draft") scheduleSummary = "Saved as draft";
  else if (form.schedule_mode === "now") {
    scheduleSummary = "Publish immediately";
    if (form.end_at) scheduleSummary += ` · ends ${form.end_at}`;
  } else if (form.schedule_mode === "scheduled") {
    scheduleSummary = form.start_at ? `From ${form.start_at}` : "No start date set";
    if (form.end_at) scheduleSummary += ` to ${form.end_at}`;
  }

  let destinationSummary = "No link";
  if (form.destination_type === "category") destinationSummary = `Category (ID: ${form.link_attribute_id ?? "—"})`;
  else if (form.destination_type === "occasion") destinationSummary = `Occasion (ID: ${form.link_attribute_id ?? "—"})`;
  else if (form.destination_type === "custom_url") destinationSummary = form.destination_value || "URL not set";

  return (
    <div className="p-4 space-y-4">
      <span className="text-sm font-semibold">Publishing summary</span>

      <div className="space-y-2.5 text-sm">
        <SummaryRow label="Status">
          <StatusPill status={previewStatus} />
        </SummaryRow>
        <SummaryRow label="Targeting">
          <span className="text-xs text-right">{targetingSummary}</span>
        </SummaryRow>
        <SummaryRow label="Languages">
          <span className="text-xs">{langSummary}</span>
        </SummaryRow>
        <SummaryRow label="Devices">
          <span className="text-xs">{deviceSummary}</span>
        </SummaryRow>
        <SummaryRow label="Schedule">
          <span className="text-xs text-right">{scheduleSummary}</span>
        </SummaryRow>
        <SummaryRow label="Destination">
          <span className="text-xs text-right truncate max-w-[140px]" title={destinationSummary}>{destinationSummary}</span>
        </SummaryRow>
      </div>

      {attentionItems.length > 0 && (
        <div className="border border-amber-200 rounded-lg bg-amber-50 p-3 space-y-1.5">
          <div className="flex items-center gap-1.5 text-amber-800 font-medium text-xs">
            <AlertTriangle className="h-3.5 w-3.5" />
            Needs attention
          </div>
          <ul className="space-y-1">
            {attentionItems.map((item, i) => (
              <li key={i} className="text-xs text-amber-700 flex items-start gap-1.5">
                <span className="mt-0.5">•</span>
                {item}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function SummaryRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-2">
      <span className="text-muted-foreground flex-shrink-0 text-xs">{label}</span>
      <div className="text-right">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preview dialog (row-level preview, unchanged)
// ---------------------------------------------------------------------------

interface PreviewDialogProps {
  banner: Banner | null;
  locations: Location[];
  countryFlagUrls: Record<string, string | null>;
  onClose: () => void;
}

function PreviewDialog({ banner, locations, countryFlagUrls, onClose }: PreviewDialogProps) {
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [country, setCountry] = useState<string>("");
  const [cityId, setCityId] = useState<string>("any");

  useEffect(() => {
    if (banner) {
      setCountry(banner.country_codes[0] ?? "");
      setCityId(banner.is_global_for_country ? "any" : String(banner.city_ids[0] ?? "any"));
      setDevice("desktop");
    }
  }, [banner]);

  if (!banner) return null;
  const side = device === "desktop" ? banner.desktop : banner.mobile;
  const cityIdNum = cityId === "any" ? null : Number(cityId);
  const now = Date.now();
  const matchesCountry = country !== "" && banner.country_codes.includes(country);
  const matchesCity = banner.is_global_for_country || (cityIdNum !== null && banner.city_ids.includes(cityIdNum));
  const inWindow =
    (!banner.start_at || Date.parse(banner.start_at) <= now) &&
    (!banner.end_at || Date.parse(banner.end_at) >= now);
  const wouldRender = banner.is_active && inWindow && side.enabled && matchesCountry && matchesCity;

  let verdict = "Would NOT render";
  let verdictStatus: BannerStatus = "Inactive";
  if (wouldRender) { verdict = "Live now — would render"; verdictStatus = "Live"; }
  else if (!banner.is_active && banner.activated_at == null) { verdict = "Draft (never published)"; verdictStatus = "Draft"; }
  else if (!banner.is_active) { verdict = "Inactive"; verdictStatus = "Inactive"; }
  else if (!inWindow && banner.start_at && Date.parse(banner.start_at) > now) {
    verdict = `Scheduled — starts ${new Date(banner.start_at).toLocaleString()}`;
    verdictStatus = "Scheduled";
  } else if (!inWindow && banner.end_at && Date.parse(banner.end_at) < now) {
    verdict = "Expired"; verdictStatus = "Expired";
  } else if (!side.enabled) { verdict = `No ${device} variant`; }
  else if (!matchesCountry) { verdict = `Not targeted to ${country || "(no country)"}`; }
  else if (!matchesCity) { verdict = "Not targeted to selected city"; }

  return (
    <Dialog open={!!banner} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogTitle>Preview: {banner.internal_name}</DialogTitle>
        <DialogDescription>Simulate how this banner would appear for a given country, city, and device.</DialogDescription>
        <div className="space-y-3">
          <div className="flex flex-wrap gap-3">
            <div className="w-44">
              <Label className="text-xs">Country</Label>
              <Select value={country} onValueChange={setCountry}>
                <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
                <SelectContent>
                  {banner.country_codes.map((c) => (
                    <SelectItem key={c} value={c}>
                      <span className="inline-flex items-center gap-2">
                        <FlagImage country={c} url={countryFlagUrls[c] ?? null} size={14} />
                        {c}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="w-56">
              <Label className="text-xs">City</Label>
              <Select value={cityId} onValueChange={setCityId}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">{banner.is_global_for_country ? "Any city (global)" : "Any city"}</SelectItem>
                  {locations.filter((l) => !country || l.country === country).map((l) => (
                    <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Device</Label>
              <div className="flex gap-1 mt-1">
                {(["desktop", "mobile"] as const).map((d) => (
                  <Button key={d} size="sm" variant={device === d ? "default" : "outline"}
                    onClick={() => setDevice(d)} data-testid={`button-preview-${d}`}>
                    {d === "desktop" ? <Monitor className="h-4 w-4 mr-1" /> : <Smartphone className="h-4 w-4 mr-1" />}
                    {d.charAt(0).toUpperCase() + d.slice(1)}
                  </Button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <StatusPill status={verdictStatus} />
            <span className="text-sm text-muted-foreground">{verdict}</span>
          </div>

          <div
            className="border rounded-lg bg-muted overflow-hidden"
            style={
              device === "desktop"
                ? { aspectRatio: "2800/1100", maxHeight: 360 }
                : { aspectRatio: "1080/1350", maxWidth: 240, margin: "0 auto" }
            }
          >
            {side.enabled && side.media_type === "video" && side.media_url ? (
              <video src={side.media_url} poster={side.fallback_image_url ?? undefined}
                className="w-full h-full object-cover" autoPlay muted loop playsInline />
            ) : side.enabled && side.media_type === "image" && side.media_url ? (
              <img src={side.media_url} alt="" className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-muted-foreground text-sm">
                No {device} media configured
              </div>
            )}
          </div>
        </div>
        <div className="flex justify-end pt-2">
          <Button variant="outline" onClick={onClose}>Close</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
