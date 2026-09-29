import { useState, useRef, useEffect, useMemo } from "react";
import { Link, useParams } from "wouter";
import { MarketplaceReportsTab, MarketplacePerformanceCard, MarketplaceMetricsSection } from "./MarketplaceReportsTab";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiFetch, getClerkToken } from "@/lib/queryClient";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { formatAED, formatUSD } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { PriceText } from "@/components/ui/price-text";
import { Card, CardContent } from "@/components/ui/card";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft, Upload, Pencil, Trash2, Check, X,
  ImagePlus, Images, Layers, FileImage,
  GripVertical, ImageIcon, ShoppingBag, Plus, Loader2,
  Download, ZoomIn, Lock, ArrowRight, Search,
  TrendingUp, Package, Tag, ArrowUpRight, ArrowDownRight,
  ExternalLink, ChevronLeft, ChevronRight,
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
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ToastAction } from "@/components/ui/toast";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Progress } from "@/components/ui/progress";
import { CategoryCombobox } from "@/components/CategoryCombobox";
import { WorkspaceImage } from "@/components/WorkspaceImage";
import {
  ComposedChart,
  Bar,
  Line,
  LineChart,
  PieChart,
  Pie,
  Cell,
  BarChart,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as RechartsTooltip,
  ReferenceLine,
  ResponsiveContainer,
} from "recharts";
const CATEGORY_COLORS = ["#0d9488", "#6366f1", "#f59e0b", "#ec4899", "#8b5cf6"];

// ─── Types ────────────────────────────────────────────────────────────────────

type BrandDetail = {
  id: number;
  name: string;
  description: string | null;
  target_cogs: string | null;
  created_at: string;
  updated_at: string | null;
  sticker_count: string;
  has_logo: boolean;
  has_card_message: boolean;
};

function formatDate(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  try {
    return new Date(dateStr).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return "—";
  }
}

function formatRelativeTime(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  try {
    const date = new Date(dateStr);
    const now = Date.now();
    const diffMs = now - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    if (diffSec < 60) return "just now";
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return diffMin === 1 ? "1 minute ago" : `${diffMin} minutes ago`;
    const diffHr = Math.floor(diffMin / 60);
    if (diffHr < 24) return diffHr === 1 ? "1 hour ago" : `${diffHr} hours ago`;
    const diffDay = Math.floor(diffHr / 24);
    if (diffDay < 30) return diffDay === 1 ? "1 day ago" : `${diffDay} days ago`;
    const diffMo = Math.floor(diffDay / 30);
    if (diffMo < 12) return diffMo === 1 ? "1 month ago" : `${diffMo} months ago`;
    const diffYr = Math.floor(diffMo / 12);
    return diffYr === 1 ? "1 year ago" : `${diffYr} years ago`;
  } catch {
    return "—";
  }
}

type ApiSticker = {
  id: number;
  name: string;
  file_name: string;
  created_at: string;
  brand_id: number;
};

type CoverPhoto = {
  id: number;
  brand_id: number;
  label: string;
  photo_mime: string;
  created_at: string;
};

type Channel = {
  id: number;
  name: string;
  has_logo: boolean;
  has_cover_photo: boolean;
  cover_photo_width: number | null;
  cover_photo_height: number | null;
  created_at: string;
};

type BrandLogo = {
  id: number;
  brand_id: number;
  label: string | null;
  logo_mime: string;
  sort_order: number;
  created_at: string;
};

type BrandProduct = {
  id: number;
  name: string;
  price_usd: string;
  price_aed: string;
  discount_price_usd: string | null;
  discount_price_aed: string | null;
  main_image_url: string | null;
  additional_image_urls: string[];
  status: string;
  category: string | null;
  brand: string | null;
  created_at?: string;
};

type TrendPeriod = { period: string; label: string; job_count: number; actual_cogs: number | null };
type ProductAvailabilityFilter = "all" | "available" | "unavailable";
type ActiveTab = "overview" | "assets" | "products" | "analytics" | "marketplace-reports" | "linked-items";

type BrandItem = {
  id: number;
  code: string;
  name: string;
  main_image_url: string | null;
  main_category_name: string | null;
  sub_category_name: string | null;
};

type ExportChannelConfig = {
  id: number;
  channel_id: number;
  channel_name: string;
  width_px: number;
  height_px: number;
  output_format: string;
};

type ExportChannelEntry = {
  id: number;
  name: string;
  has_logo: boolean;
};

function ExportChannelLogoTile({ channel }: { channel: ExportChannelEntry }) {
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

type BrandAnalyticsKpis = {
  total_revenue: number;
  total_orders: number;
  avg_order_value: number;
  total_units: number;
  active_products: number;
  total_products: number;
};
type BrandAnalyticsTrendPoint = { period: string; revenue: number; orders: number };
type BrandAnalyticsCategoryPoint = { name: string; value: number };
type BrandAnalyticsChannelPoint = { channel: string; revenue: number; orders: number };
type BrandAnalyticsTopProduct = { name: string; category: string | null; orders: number; revenue_usd: number; status: string };
type BrandAnalytics = {
  period: string;
  granularity: string;
  kpis: BrandAnalyticsKpis;
  sales_trend: BrandAnalyticsTrendPoint[];
  category_breakdown: BrandAnalyticsCategoryPoint[];
  channel_breakdown: BrandAnalyticsChannelPoint[];
  top_products: BrandAnalyticsTopProduct[];
};

// ─── Constants ────────────────────────────────────────────────────────────────

const LOGO_UNDO_DURATION_MS = 5000;

const COVER_LABELS = [
  "All Year",
  "Christmas",
  "New Year's",
  "Valentine's Day",
  "Women's Day",
  "Mother's Day",
  "Father's Day",
  "Easter",
  "Eid",
] as const;

const TAB_LABELS: { id: ActiveTab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "assets", label: "Assets" },
  { id: "products", label: "Products" },
  { id: "linked-items", label: "Linked Items" },
  { id: "analytics", label: "Analytics" },
  { id: "marketplace-reports", label: "Marketplace Reports" },
];

// ─── Helper components ────────────────────────────────────────────────────────

function UndoCountdownAction({
  onUndo,
  durationMs,
}: {
  onUndo: () => void;
  durationMs: number;
}) {
  const [seconds, setSeconds] = useState(Math.ceil(durationMs / 1000));

  useEffect(() => {
    const id = setInterval(() => {
      setSeconds((s) => Math.max(0, s - 1));
    }, 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <ToastAction altText="Undo logo deletion" onClick={onUndo}>
      Undo ({seconds}s)
    </ToastAction>
  );
}

export function SortableLogoItem({
  logo,
  idx,
  isFirst,
  isOnlyOne,
  canManage,
  brandId,
  editingLogoLabelId,
  editingLogoLabelValue,
  setEditingLogoLabelId,
  setEditingLogoLabelValue,
  onSaveLabel,
  onDelete,
  isSavingLabel,
  isDeleting,
  brandName,
}: {
  logo: BrandLogo;
  idx: number;
  isFirst: boolean;
  isOnlyOne: boolean;
  canManage: boolean;
  brandId: number;
  editingLogoLabelId: number | null;
  editingLogoLabelValue: string;
  setEditingLogoLabelId: (id: number | null) => void;
  setEditingLogoLabelValue: (v: string) => void;
  onSaveLabel: (logoId: number, label: string) => void;
  onDelete: (logoId: number) => void;
  isSavingLabel: boolean;
  isDeleting: boolean;
  brandName: string;
}) {
  const { toast } = useToast();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: logo.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 10 : undefined,
  };

  const isEditingLabel = editingLogoLabelId === logo.id;
  const [isDownloading, setIsDownloading] = useState(false);

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-3 px-4 py-3 bg-background"
    >
      {canManage && (
        <button
          {...attributes}
          {...listeners}
          className="cursor-grab active:cursor-grabbing text-muted-foreground hover:text-foreground shrink-0 touch-none"
          title="Drag to reorder"
        >
          <GripVertical size={16} />
        </button>
      )}

      <div className="w-12 h-12 rounded-md border border-border overflow-hidden shrink-0 bg-muted flex items-center justify-center">
        <WorkspaceImage
          src={`/api/brands/${brandId}/logos/${logo.id}/image`}
          alt={logo.label ?? `Logo ${idx + 1}`}
          className="w-full h-full object-cover"
        />
      </div>

      <div className="flex-1 min-w-0">
        {isEditingLabel ? (
          <div className="flex items-center gap-1.5">
            <Input
              className="h-7 text-sm px-2 max-w-[180px]"
              value={editingLogoLabelValue}
              onChange={(e) => setEditingLogoLabelValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onSaveLabel(logo.id, editingLogoLabelValue);
                if (e.key === "Escape") setEditingLogoLabelId(null);
              }}
              placeholder="e.g. Primary, Dark mode…"
              autoFocus
            />
            <button
              className="text-green-600 hover:text-green-700"
              onClick={() => onSaveLabel(logo.id, editingLogoLabelValue)}
              disabled={isSavingLabel}
            >
              <Check size={14} />
            </button>
            <button
              className="text-muted-foreground hover:text-foreground"
              onClick={() => setEditingLogoLabelId(null)}
            >
              <X size={14} />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-medium truncate">
              {logo.label || (isFirst ? "Primary" : `Logo ${idx + 1}`)}
            </span>
            {isFirst && (
              <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-primary/10 text-primary shrink-0">
                Primary
              </span>
            )}
            {canManage && (
              <button
                className="text-muted-foreground hover:text-foreground ml-1"
                onClick={() => { setEditingLogoLabelId(logo.id); setEditingLogoLabelValue(logo.label ?? ""); }}
                title="Edit label"
              >
                <Pencil size={12} />
              </button>
            )}
          </div>
        )}
      </div>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="sm"
            variant="ghost"
            className="h-8 w-8 p-0 shrink-0 text-muted-foreground hover:text-foreground"
            aria-label="Download logo"
            disabled={isDownloading}
            onClick={async () => {
              setIsDownloading(true);
              try {
                const token = await getClerkToken();
                const res = await fetch(`/api/brands/${brandId}/logos/${logo.id}/image`, {
                  credentials: "include",
                  headers: token ? { Authorization: `Bearer ${token}` } : {},
                });
                if (!res.ok) throw new Error("Download failed");
                const blob = await res.blob();
                const ext = blob.type.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `${brandName} ${logo.label ? logo.label + " Logo" : "Logo"}.${ext}`
                  .replace(/[/\\:*?"<>|]/g, "")
                  .replace(/\s+/g, "-")
                  .toLowerCase();
                document.body.appendChild(a);
                a.click();
                a.remove();
                URL.revokeObjectURL(url);
              } catch {
                toast({ title: "Download failed", description: "Could not download the logo. Please try again.", variant: "destructive" });
              } finally {
                setIsDownloading(false);
              }
            }}
          >
            {isDownloading ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
          </Button>
        </TooltipTrigger>
        <TooltipContent>Download logo</TooltipContent>
      </Tooltip>

      {canManage && (
        <div className="flex items-center gap-1 shrink-0">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex">
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                  disabled={isOnlyOne || isDeleting}
                  onClick={() => !isOnlyOne && onDelete(logo.id)}
                >
                  <Trash2 size={14} />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {isOnlyOne ? "A brand must keep at least one logo" : "Remove logo"}
            </TooltipContent>
          </Tooltip>
        </div>
      )}
    </div>
  );
}

// ─── KPI / Metric card ────────────────────────────────────────────────────────

function MetricCard({
  icon,
  label,
  value,
  sub,
  trend,
  trendDir,
  accent,
}: {
  icon?: React.ReactNode;
  label: string;
  value: string | number;
  sub?: string;
  trend?: number;
  trendDir?: "up" | "down" | "flat";
  accent?: string;
}) {
  return (
    <div className={`rounded-xl border border-border bg-card px-5 py-4 flex flex-col gap-1 shadow-sm ${accent ?? ""}`}>
      {icon && <div className="mb-1 text-muted-foreground">{icon}</div>}
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{label}</p>
      <p className="text-2xl font-bold tracking-tight">{value}</p>
      {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
      {trend !== undefined && trendDir && trendDir !== "flat" && (
        <div className={`flex items-center gap-1 text-xs font-medium mt-0.5 ${trendDir === "up" ? "text-green-600" : "text-red-500"}`}>
          {trendDir === "up" ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
          {Math.abs(trend)}% vs prev period
        </div>
      )}
    </div>
  );
}

// ─── Status badge helper ──────────────────────────────────────────────────────

function ProductStatusBadge({ status }: { status: string }) {
  switch (status) {
    case "available":
      return <Badge className="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 border-0 text-[11px]">Available</Badge>;
    case "out_of_stock":
      return <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border-0 text-[11px]">Out of Stock</Badge>;
    case "not_available":
      return <Badge className="bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-0 text-[11px]">Not Available</Badge>;
    default:
      return <Badge variant="secondary" className="text-[11px]">{status}</Badge>;
  }
}

function productImageUrl(path: string | null): string | null {
  if (!path) return null;
  if (path.startsWith("/objects/")) return `/api/storage${path}`;
  return path;
}

// ─── Main page ────────────────────────────────────────────────────────────────

export default function BrandDetailPage() {
  const { t } = useTranslation();
  const { brandId } = useParams<{ brandId: string }>();
  const id = parseInt(brandId ?? "", 10);
  const { toast } = useToast();
  const qc = useQueryClient();

  // ─── tab ──────────────────────────────────────────────────────────────────
  const initialTab = (() => {
    try {
      const p = new URLSearchParams(window.location.search).get("tab");
      const valid: ActiveTab[] = ["overview", "assets", "products", "analytics", "marketplace-reports"];
      return valid.includes(p as ActiveTab) ? (p as ActiveTab) : "overview";
    } catch {
      return "overview";
    }
  })();
  const [activeTab, setActiveTab] = useState<ActiveTab>(initialTab);

  // ─── role ─────────────────────────────────────────────────────────────────
  const { isOwner, role, allowedPages } = useWorkspaceRole();
  const canManage = isOwner || role === "designer" || (allowedPages?.includes("brands.manage") ?? false);
  const canManageStickers = canManage;
  const canEditBrand = canManage || (allowedPages?.includes("brands.edit") ?? false);
  const canManageLogos = canManage || (allowedPages?.includes("brands.manage-logos") ?? false);
  const canManageCoverPhotos = canManage || (allowedPages?.includes("brands.manage-cover-photos") ?? false);
  const canManageCardMessage = canManage || (allowedPages?.includes("brands.manage-card-message") ?? false);
  const canDeleteBrand = isOwner || role === "designer" || (allowedPages?.includes("brands.delete") ?? false);

  // ─── brand ────────────────────────────────────────────────────────────────
  const { data: brandData, isLoading: brandLoading } = useQuery({
    queryKey: ["brands", id],
    queryFn: () => apiFetch<{ brand: BrandDetail }>(`/api/brands/${id}`),
    enabled: !Number.isNaN(id),
  });
  const brand = brandData?.brand;

  // ─── stickers ─────────────────────────────────────────────────────────────
  const { data: stickersData, isLoading: stickersLoading } = useQuery({
    queryKey: ["brands", id, "stickers"],
    queryFn: () => apiFetch<{ stickers: ApiSticker[] }>(`/api/brands/${id}/stickers`),
    enabled: !Number.isNaN(id),
  });
  const stickers = stickersData?.stickers ?? [];

  // ─── active sticker sheet ─────────────────────────────────────────────────
  const { data: stickerSheetData } = useQuery({
    queryKey: ["brand-sticker-sheets", "brand", id],
    queryFn: () =>
      apiFetch<{
        brands: Array<{
          brand_id: number;
          brand_name: string;
          sheet: {
            id: number;
            status: string;
            version_number: number;
            file_name: string;
            sticker_count: number;
            is_active: boolean;
            change_request_notes: string | null;
          } | null;
        }>;
      }>(`/api/brand-sticker-sheets?brand_id=${id}`),
    enabled: !Number.isNaN(id),
    staleTime: 30_000,
  });
  const activeStickerSheet = stickerSheetData?.brands?.[0]?.sheet ?? null;
  const canUploadStickerSheet =
    isOwner ||
    (allowedPages?.includes("sticker-sheets.upload") ?? false) ||
    (allowedPages?.includes("stickers.upload") ?? false);

  // ─── cover photos ─────────────────────────────────────────────────────────
  const { data: coverData, isLoading: coverLoading } = useQuery({
    queryKey: ["brands", id, "cover-photos"],
    queryFn: () => apiFetch<{ coverPhotos: CoverPhoto[] }>(`/api/brands/${id}/cover-photos`),
    enabled: !Number.isNaN(id),
  });
  const coverPhotos = coverData?.coverPhotos ?? [];

  // ─── channels (for cover photo downloads) ─────────────────────────────────
  const { data: channelsData } = useQuery({
    queryKey: ["channels"],
    queryFn: () => apiFetch<{ channels: Channel[] }>("/api/channels"),
    enabled: !Number.isNaN(id),
  });
  const coverPhotoChannels = (channelsData?.channels ?? []).filter(
    (c): c is Channel & { cover_photo_width: number; cover_photo_height: number } =>
      c.has_cover_photo && c.cover_photo_width !== null && c.cover_photo_height !== null,
  );

  // ─── linked base items ────────────────────────────────────────────────────
  const { data: brandItemsData, isLoading: brandItemsLoading } = useQuery({
    queryKey: ["brands", id, "items"],
    queryFn: () => apiFetch<{ items: BrandItem[] }>(`/api/brands/${id}/items`),
    enabled: !Number.isNaN(id),
  });
  const brandItems = brandItemsData?.items ?? [];

  // ─── cogs summary ─────────────────────────────────────────────────────────
  const { data: cogsSummary } = useQuery({
    queryKey: ["brands", id, "cogs-summary"],
    queryFn: () =>
      apiFetch<{ target_cogs: number | null; actual_cogs: number | null; completed_job_count: number }>(
        `/api/brands/${id}/cogs-summary`,
      ),
    enabled: !Number.isNaN(id),
  });

  // ─── logos ────────────────────────────────────────────────────────────────
  const { data: logosData, isLoading: logosLoading } = useQuery({
    queryKey: ["brands", id, "logos"],
    queryFn: () => apiFetch<{ logos: BrandLogo[] }>(`/api/brands/${id}/logos`),
    enabled: !Number.isNaN(id),
  });
  const logos = logosData?.logos ?? [];

  const logoSensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  function handleLogoDragEnd(event: DragEndEvent) {
    if (reorderLogosMutation.isPending) return;
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = logos.findIndex((l) => l.id === active.id);
    const newIndex = logos.findIndex((l) => l.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const reordered = arrayMove(logos, oldIndex, newIndex);
    reorderLogosMutation.mutate(reordered.map((l) => l.id));
  }

  const logoUndoTimersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const [addLogoOpen, setAddLogoOpen] = useState(false);
  const [addLogoFile, setAddLogoFile] = useState<File | null>(null);
  const [addLogoLabel, setAddLogoLabel] = useState("");
  const [addLogoPreview, setAddLogoPreview] = useState<string | null>(null);
  const [addLogoError, setAddLogoError] = useState<string | null>(null);
  const addLogoInputRef = useRef<HTMLInputElement>(null);

  const [editingLogoLabelId, setEditingLogoLabelId] = useState<number | null>(null);
  const [editingLogoLabelValue, setEditingLogoLabelValue] = useState("");

  const addLogoMutation = useMutation({
    mutationFn: async () => {
      if (!addLogoFile) throw new Error("A logo file is required");
      const fd = new FormData();
      fd.append("logo", addLogoFile);
      if (addLogoLabel.trim()) fd.append("label", addLogoLabel.trim());
      const token = await getClerkToken();
      const res = await fetch(`/api/brands/${id}/logos`, {
        method: "POST",
        credentials: "include",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
      return json;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["brands", id, "logos"] });
      qc.invalidateQueries({ queryKey: ["brands", id] });
      qc.invalidateQueries({ queryKey: ["brands"] });
      toast({ title: "Logo added" });
      setAddLogoOpen(false);
      setAddLogoFile(null);
      setAddLogoLabel("");
      setAddLogoPreview((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
      setAddLogoError(null);
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", title: t("brands.uploadFailed"), description: err.message });
    },
  });

  const updateLogoLabelMutation = useMutation({
    mutationFn: ({ logoId, label }: { logoId: number; label: string }) =>
      apiFetch(`/api/brands/${id}/logos/${logoId}`, {
        method: "PATCH",
        body: JSON.stringify({ label: label || "" }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["brands", id, "logos"] });
      setEditingLogoLabelId(null);
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", title: "Update failed", description: err.message });
    },
  });

  const reorderLogosMutation = useMutation({
    mutationFn: (ids: number[]) =>
      apiFetch(`/api/brands/${id}/logos/reorder`, {
        method: "PUT",
        body: JSON.stringify({ ids }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["brands", id, "logos"] });
      qc.invalidateQueries({ queryKey: ["brands", id] });
      qc.invalidateQueries({ queryKey: ["brands"] });
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", title: "Reorder failed", description: err.message });
    },
  });

  const restoreLogoMutation = useMutation({
    mutationFn: (logoId: number) =>
      apiFetch(`/api/brands/${id}/logos/${logoId}/restore`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["brands", id, "logos"] });
      qc.invalidateQueries({ queryKey: ["brands", id] });
      qc.invalidateQueries({ queryKey: ["brands"] });
    },
  });

  const permanentDeleteLogoMutation = useMutation({
    mutationFn: (logoId: number) =>
      apiFetch(`/api/brands/${id}/logos/${logoId}/permanent`, { method: "DELETE" }),
  });

  const softDeleteLogoMutation = useMutation({
    mutationFn: (logoId: number) =>
      apiFetch(`/api/brands/${id}/logos/${logoId}`, { method: "DELETE" }),
    onSuccess: (_data, logoId) => {
      qc.invalidateQueries({ queryKey: ["brands", id, "logos"] });
      qc.invalidateQueries({ queryKey: ["brands", id] });
      qc.invalidateQueries({ queryKey: ["brands"] });
      scheduleLogoUndo(logoId);
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", title: t("brands.deleteFailed"), description: err.message });
    },
  });

  function scheduleLogoUndo(logoId: number) {
    const existing = logoUndoTimersRef.current.get(logoId);
    if (existing) clearTimeout(existing);
    const { dismiss } = toast({
      title: "Logo removed",
      description: "The logo has been removed from this brand.",
      duration: LOGO_UNDO_DURATION_MS,
      action: (
        <UndoCountdownAction
          durationMs={LOGO_UNDO_DURATION_MS}
          onUndo={() => {
            const timer = logoUndoTimersRef.current.get(logoId);
            if (timer) {
              clearTimeout(timer);
              logoUndoTimersRef.current.delete(logoId);
            }
            restoreLogoMutation.mutate(logoId);
            dismiss();
          }}
        />
      ),
    });
    const timer = setTimeout(() => {
      logoUndoTimersRef.current.delete(logoId);
      permanentDeleteLogoMutation.mutate(logoId);
    }, LOGO_UNDO_DURATION_MS);
    logoUndoTimersRef.current.set(logoId, timer);
  }

  function handleAddLogoFile(file: File) {
    if (!file.type.startsWith("image/")) {
      setAddLogoError("Please select a JPEG, PNG, or WebP image.");
      return;
    }
    if (addLogoPreview) URL.revokeObjectURL(addLogoPreview);
    const preview = URL.createObjectURL(file);
    setAddLogoPreview(preview);
    setAddLogoFile(file);
    setAddLogoError(null);
    const img = new Image();
    img.onload = () => {
      if (img.naturalWidth !== img.naturalHeight) {
        setAddLogoError("Logo must be square (width must equal height).");
      } else if (img.naturalWidth < 200) {
        setAddLogoError(`Logo must be at least 200 × 200 px (yours is ${img.naturalWidth} × ${img.naturalHeight}).`);
      } else {
        setAddLogoError(null);
      }
    };
    img.onerror = () => { setAddLogoError("Could not read the image."); };
    img.src = preview;
  }

  // ─── cogs trend ───────────────────────────────────────────────────────────
  const [trendGranularity, setTrendGranularity] = useState<"month" | "week">("month");

  const { data: cogsTrend } = useQuery({
    queryKey: ["brands", id, "cogs-trend", trendGranularity],
    queryFn: () =>
      apiFetch<{ granularity: string; target_cogs: number | null; periods: TrendPeriod[] }>(
        `/api/brands/${id}/cogs-trend?granularity=${trendGranularity}`,
      ),
    enabled: !Number.isNaN(id),
  });

  // ─── cover photos ─────────────────────────────────────────────────────────
  const [addCoverOpen, setAddCoverOpen] = useState(false);
  const [coverLabel, setCoverLabel] = useState("");
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const coverInputRef = useRef<HTMLInputElement>(null);
  const [deleteCoverTarget, setDeleteCoverTarget] = useState<CoverPhoto | null>(null);

  const addCoverMutation = useMutation({
    mutationFn: async () => {
      if (!coverFile || !coverLabel) throw new Error("Label and photo are required");
      const fd = new FormData();
      fd.append("label", coverLabel);
      fd.append("photo", coverFile);
      const token = await getClerkToken();
      const res = await fetch(`/api/brands/${id}/cover-photos`, {
        method: "POST",
        credentials: "include",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
      return json;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["brands", id, "cover-photos"] });
      toast({ title: t("brands.coverPhotoAdded") });
      setAddCoverOpen(false);
      setCoverLabel("");
      setCoverFile(null);
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", title: t("brands.uploadFailed"), description: err.message });
    },
  });

  const deleteCoverMutation = useMutation({
    mutationFn: (photoId: number) =>
      apiFetch(`/api/brands/${id}/cover-photos/${photoId}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["brands", id, "cover-photos"] });
      setDeleteCoverTarget(null);
      toast({ title: t("brands.coverPhotoDeleted") });
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", title: t("brands.deleteFailed"), description: err.message });
    },
  });

  const [selectedCoverPhoto, setSelectedCoverPhoto] = useState<CoverPhoto | null>(null);
  const [downloadingOriginal, setDownloadingOriginal] = useState(false);
  const [downloadingChannels, setDownloadingChannels] = useState<Set<number>>(new Set());

  async function downloadCoverOriginal(photo: CoverPhoto) {
    if (downloadingOriginal) return;
    setDownloadingOriginal(true);
    try {
      const token = await getClerkToken();
      const res = await fetch(`/api/brands/${id}/cover-photos/${photo.id}/image`, {
        credentials: "include",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const ext = blob.type === "image/png" ? "png" : "jpg";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${brand?.name ?? "brand"}-${photo.label}.${ext}`
        .replace(/[/\\:*?"<>|]/g, "")
        .replace(/\s+/g, "-")
        .toLowerCase();
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      toast({ variant: "destructive", title: "Download failed", description: (err as Error).message });
    } finally {
      setDownloadingOriginal(false);
    }
  }

  async function downloadCoverForChannel(
    photo: CoverPhoto,
    channel: Channel & { cover_photo_width: number; cover_photo_height: number },
  ) {
    if (downloadingChannels.has(channel.id)) return;
    setDownloadingChannels((prev) => new Set(prev).add(channel.id));
    try {
      const token = await getClerkToken();
      const res = await fetch(`/api/brands/${id}/cover-photos/${photo.id}/image`, {
        credentials: "include",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const imgUrl = URL.createObjectURL(blob);
      await new Promise<void>((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
          const canvas = document.createElement("canvas");
          canvas.width = channel.cover_photo_width;
          canvas.height = channel.cover_photo_height;
          const ctx = canvas.getContext("2d");
          if (!ctx) { reject(new Error("Canvas not supported")); return; }
          ctx.drawImage(img, 0, 0, channel.cover_photo_width, channel.cover_photo_height);
          canvas.toBlob((resizedBlob) => {
            if (!resizedBlob) { reject(new Error("Failed to create blob")); return; }
            const outUrl = URL.createObjectURL(resizedBlob);
            const a = document.createElement("a");
            a.href = outUrl;
            a.download = `${brand?.name ?? "brand"}-${photo.label}-${channel.name}-${channel.cover_photo_width}x${channel.cover_photo_height}.jpg`
              .replace(/[/\\:*?"<>|]/g, "").replace(/\s+/g, "-").toLowerCase();
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(outUrl);
            URL.revokeObjectURL(imgUrl);
            resolve();
          }, "image/jpeg", 0.92);
        };
        img.onerror = () => { URL.revokeObjectURL(imgUrl); reject(new Error("Failed to load image")); };
        img.src = imgUrl;
      });
    } catch (err) {
      toast({ variant: "destructive", title: "Download failed", description: (err as Error).message });
    } finally {
      setDownloadingChannels((prev) => {
        const next = new Set(prev);
        next.delete(channel.id);
        return next;
      });
    }
  }

  // ─── card message ─────────────────────────────────────────────────────────
  const [cardMsgVersion, setCardMsgVersion] = useState(0);
  const cardMsgInputRef = useRef<HTMLInputElement>(null);
  const [deleteCardMsgOpen, setDeleteCardMsgOpen] = useState(false);

  const cardMsgMutation = useMutation({
    mutationFn: async (file: File) => {
      const fd = new FormData();
      fd.append("image", file);
      const token = await getClerkToken();
      const res = await fetch(`/api/brands/${id}/card-message`, {
        method: "PUT",
        credentials: "include",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((json as { error?: string }).error ?? `HTTP ${res.status}`);
      return json;
    },
    onSuccess: () => {
      setCardMsgVersion((v) => v + 1);
      qc.invalidateQueries({ queryKey: ["brands", id] });
      toast({ title: t("brands.cardMsgUpdated") });
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", title: t("brands.uploadFailed"), description: err.message });
    },
  });

  const deleteCardMsgMutation = useMutation({
    mutationFn: () => apiFetch(`/api/brands/${id}/card-message`, { method: "DELETE" }),
    onSuccess: () => {
      setCardMsgVersion((v) => v + 1);
      qc.invalidateQueries({ queryKey: ["brands", id] });
      setDeleteCardMsgOpen(false);
      toast({ title: t("brands.cardMsgRemoved") });
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", title: t("brands.deleteFailed"), description: err.message });
    },
  });

  const handleCardMsgFile = (file: File) => {
    if (file.type !== "image/jpeg" && file.type !== "image/png") {
      toast({ variant: "destructive", title: t("brands.invalidFile"), description: t("brands.cardMsgInvalidFileDesc") });
      return;
    }
    cardMsgMutation.mutate(file);
  };

  // ─── brand products ───────────────────────────────────────────────────────
  // Fetch all brand products (used for Overview preview, Products tab stats & table, and export)
  const [productAvailabilityFilter, setProductAvailabilityFilter] = useState<ProductAvailabilityFilter>("all");
  const [isExporting, setIsExporting] = useState(false);
  // Streaming export progress: { processed, total } while the ZIP builds, null otherwise.
  const [exportProgress, setExportProgress] = useState<{ processed: number; total: number } | null>(null);
  // Aborts the in-flight export fetch (and thus the server build) when the user cancels.
  const exportAbortRef = useRef<AbortController | null>(null);

  // Export image version picker
  const [exportPickerOpen, setExportPickerOpen] = useState(false);
  const [exportConfigs, setExportConfigs] = useState<ExportChannelConfig[]>([]);
  const [exportChannels, setExportChannels] = useState<ExportChannelEntry[]>([]);
  const [exportConfigsLoading, setExportConfigsLoading] = useState(false);
  const [selectedExportConfigId, setSelectedExportConfigId] = useState<string>("original");

  const { data: allBrandProductsData } = useQuery({
    queryKey: ["products", { brand: brand?.name, all: true }],
    queryFn: () =>
      apiFetch<{ products: BrandProduct[]; total: number }>(
        `/api/products?brand=${encodeURIComponent(brand!.name)}&pageSize=100`,
      ),
    enabled: !!brand,
  });
  const allBrandProducts = allBrandProductsData?.products ?? [];

  // Products tab filter/search/sort/pagination state
  const [productsSearch, setProductsSearch] = useState("");
  const [productsStatusFilter, setProductsStatusFilter] = useState<ProductAvailabilityFilter>("all");
  const [productsCategoryFilter, setProductsCategoryFilter] = useState("");
  const [productsSort, setProductsSort] = useState<"name" | "price_usd" | "price_aed" | "created_at">("created_at");
  const [productsPage, setProductsPage] = useState(1);
  const PRODUCTS_PAGE_SIZE = 10;

  // Distinct categories from all products
  const productCategories = useMemo(() => {
    const cats = new Set<string>();
    for (const p of allBrandProducts) {
      if (p.category) cats.add(p.category);
    }
    return Array.from(cats).sort();
  }, [allBrandProducts]);

  // Filtered + sorted products for Products tab
  const filteredProducts = useMemo(() => {
    let list = [...allBrandProducts];
    // status filter
    if (productsStatusFilter === "available") {
      list = list.filter((p) => p.status === "available");
    } else if (productsStatusFilter === "unavailable") {
      list = list.filter((p) => p.status !== "available");
    }
    // category filter
    if (productsCategoryFilter) {
      list = list.filter((p) => p.category?.toLowerCase() === productsCategoryFilter.toLowerCase());
    }
    // search
    if (productsSearch.trim()) {
      const q = productsSearch.trim().toLowerCase();
      list = list.filter((p) => p.name.toLowerCase().includes(q));
    }
    // sort
    list.sort((a, b) => {
      if (productsSort === "name") return a.name.localeCompare(b.name);
      if (productsSort === "price_usd") return parseFloat(a.price_usd || "0") - parseFloat(b.price_usd || "0");
      if (productsSort === "price_aed") return parseFloat(a.price_aed || "0") - parseFloat(b.price_aed || "0");
      // created_at: newest first
      return (b.created_at ?? "").localeCompare(a.created_at ?? "");
    });
    return list;
  }, [allBrandProducts, productsStatusFilter, productsCategoryFilter, productsSearch, productsSort]);

  const totalProductPages = Math.max(1, Math.ceil(filteredProducts.length / PRODUCTS_PAGE_SIZE));
  const paginatedProducts = filteredProducts.slice(
    (productsPage - 1) * PRODUCTS_PAGE_SIZE,
    productsPage * PRODUCTS_PAGE_SIZE,
  );

  // Overview product preview (filtered by productAvailabilityFilter, first 5)
  const overviewProducts = useMemo(() => {
    let list = [...allBrandProducts];
    if (productAvailabilityFilter === "available") list = list.filter((p) => p.status === "available");
    else if (productAvailabilityFilter === "unavailable") list = list.filter((p) => p.status !== "available");
    return list.slice(0, 5);
  }, [allBrandProducts, productAvailabilityFilter]);

  // Product stats (for Products tab KPI cards)
  const productStats = useMemo(() => {
    const total = allBrandProducts.length;
    const available = allBrandProducts.filter((p) => p.status === "available").length;
    const unavailable = total - available;
    const categories = new Set(allBrandProducts.map((p) => p.category).filter(Boolean)).size;
    const prices = allBrandProducts
      .map((p) => parseFloat(p.price_usd || "0"))
      .filter((n) => !isNaN(n) && n > 0);
    const avgPrice = prices.length ? prices.reduce((a, b) => a + b, 0) / prices.length : 0;
    return { total, available, unavailable, categories, avgPrice };
  }, [allBrandProducts]);

  // ─── add product ──────────────────────────────────────────────────────────
  const [addProductOpen, setAddProductOpen] = useState(false);
  const addProductFileRef = useRef<HTMLInputElement>(null);
  const [addProductForm, setAddProductForm] = useState({
    name: "",
    price_usd: "",
    price_aed: "",
    discount_price_usd: "",
    discount_price_aed: "",
    status: "available",
    description: "",
    category: "",
    main_image_url: null as string | null,
  });
  const [addProductUploading, setAddProductUploading] = useState(false);

  const discountFieldError = (discount: string, regular: string): string | null => {
    if (discount.trim() === "") return null;
    const d = parseFloat(discount);
    if (isNaN(d) || d < 0) return "Must be a valid non-negative number";
    const r = parseFloat(regular);
    if (!isNaN(r) && d >= r) return "Must be less than the regular price";
    return null;
  };
  const addDiscountUsdError = discountFieldError(addProductForm.discount_price_usd, addProductForm.price_usd);
  const addDiscountAedError = discountFieldError(addProductForm.discount_price_aed, addProductForm.price_aed);

  const addProductMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ product: BrandProduct }>("/api/products", {
        method: "POST",
        body: JSON.stringify({
          name: addProductForm.name.trim(),
          price_usd: parseFloat(addProductForm.price_usd),
          price_aed: parseFloat(addProductForm.price_aed),
          discount_price_usd: addProductForm.discount_price_usd.trim() === "" ? null : parseFloat(addProductForm.discount_price_usd),
          discount_price_aed: addProductForm.discount_price_aed.trim() === "" ? null : parseFloat(addProductForm.discount_price_aed),
          status: addProductForm.status,
          description: addProductForm.description.trim() || null,
          category: addProductForm.category.trim() || null,
          brand: brand?.name ?? null,
          main_image_url: addProductForm.main_image_url,
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["products", { brand: brand?.name, all: true }] });
      qc.invalidateQueries({ queryKey: ["products"] });
      toast({ title: "Product added" });
      setAddProductOpen(false);
      setAddProductForm({ name: "", price_usd: "", price_aed: "", discount_price_usd: "", discount_price_aed: "", status: "available", description: "", category: "", main_image_url: null });
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", title: "Failed to add product", description: err.message });
    },
  });

  async function handleAddProductImageUpload(file: File) {
    if (!file.type.startsWith("image/")) return;
    setAddProductUploading(true);
    try {
      const fd = new FormData();
      fd.append("image", file);
      const token = await getClerkToken();
      const res = await fetch("/api/products/upload-image", {
        method: "POST",
        credentials: "include",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Upload failed");
      setAddProductForm((f) => ({ ...f, main_image_url: json.url }));
    } catch (err) {
      toast({ variant: "destructive", title: "Image upload failed", description: String(err) });
    } finally {
      setAddProductUploading(false);
    }
  }

  // ─── inline rename ────────────────────────────────────────────────────────
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState("");

  const startEditName = () => {
    setNameValue(brand?.name ?? "");
    setEditingName(true);
  };

  const renameBrandMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/brands/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: nameValue.trim() }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["brands", id] });
      qc.invalidateQueries({ queryKey: ["brands"] });
      toast({ title: "Brand renamed" });
      setEditingName(false);
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", title: "Rename failed", description: err.message });
    },
  });

  const commitRename = () => {
    if (!nameValue.trim()) {
      toast({ variant: "destructive", title: "Name is required", description: "Brand name cannot be empty." });
      return;
    }
    renameBrandMutation.mutate();
  };

  // ─── description / target_cogs editing ───────────────────────────────────
  const [editingMeta, setEditingMeta] = useState(false);
  const [metaDescription, setMetaDescription] = useState("");
  const [metaTargetCogs, setMetaTargetCogs] = useState("");

  const startEditMeta = () => {
    setMetaDescription(brand?.description ?? "");
    setMetaTargetCogs(brand?.target_cogs !== null && brand?.target_cogs !== undefined ? parseFloat(brand.target_cogs).toString() : "");
    setEditingMeta(true);
  };

  const metaMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/brands/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: brand!.name,
          description: metaDescription.trim() || "",
          target_cogs: metaTargetCogs !== "" ? metaTargetCogs : "",
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["brands", id] });
      qc.invalidateQueries({ queryKey: ["brands"] });
      toast({ title: t("brands.brandUpdated") });
      setEditingMeta(false);
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", title: t("brands.updateFailed"), description: err.message });
    },
  });

  // ─── delete brand ─────────────────────────────────────────────────────────
  const [deleteBrandOpen, setDeleteBrandOpen] = useState(false);
  const deleteBrandMutation = useMutation({
    mutationFn: () => apiFetch(`/api/brands/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["brands"] });
      toast({ title: "Brand deleted" });
      window.location.href = "/brands";
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", title: "Delete failed", description: err.message });
      setDeleteBrandOpen(false);
    },
  });

  // ─── sticker upload / rename / delete / move ──────────────────────────────
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadName, setUploadName] = useState("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const uploadMutation = useMutation({
    mutationFn: async () => {
      if (!uploadFile || !uploadName.trim()) throw new Error("Name and file are required");
      const fd = new FormData();
      fd.append("pdf", uploadFile);
      fd.append("name", uploadName.trim());
      fd.append("brand_id", String(id));
      const token = await getClerkToken();
      const res = await fetch("/api/stickers", {
        method: "POST",
        credentials: "include",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["brands", id, "stickers"] });
      qc.invalidateQueries({ queryKey: ["brands"] });
      qc.invalidateQueries({ queryKey: ["stickers"] });
      toast({ title: t("brands.stickerUploaded") });
      setUploadOpen(false);
      setUploadName("");
      setUploadFile(null);
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", title: t("brands.uploadFailed"), description: err.message });
    },
  });

  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const renameMutation = useMutation({
    mutationFn: ({ sid, name }: { sid: number; name: string }) =>
      apiFetch(`/api/stickers/${sid}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["brands", id, "stickers"] });
      qc.invalidateQueries({ queryKey: ["stickers"] });
      setRenamingId(null);
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", title: t("brands.renameFailed2"), description: err.message });
    },
  });

  const [deleteTarget, setDeleteTarget] = useState<ApiSticker | null>(null);

  const deleteStickerMutation = useMutation({
    mutationFn: (sid: number) =>
      apiFetch(`/api/stickers/${sid}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["brands", id, "stickers"] });
      qc.invalidateQueries({ queryKey: ["brands"] });
      qc.invalidateQueries({ queryKey: ["stickers"] });
      setDeleteTarget(null);
      toast({ title: t("brands.stickerDeleted") });
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", title: t("brands.deleteFailed"), description: err.message });
    },
  });

  const [moveTarget, setMoveTarget] = useState<ApiSticker | null>(null);
  const [moveToBrandId, setMoveToBrandId] = useState<string>("");

  const { data: allBrandsData } = useQuery({
    queryKey: ["brands"],
    queryFn: () => apiFetch<{ brands: { id: number; name: string }[] }>("/api/brands"),
    enabled: moveTarget !== null,
  });
  const allBrands = allBrandsData?.brands ?? [];

  const moveStickerMutation = useMutation({
    mutationFn: ({ sid, brandId }: { sid: number; brandId: number }) =>
      apiFetch(`/api/stickers/${sid}`, {
        method: "PATCH",
        body: JSON.stringify({ brand_id: brandId }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["brands", id, "stickers"] });
      qc.invalidateQueries({ queryKey: ["brands"] });
      qc.invalidateQueries({ queryKey: ["stickers"] });
      setMoveTarget(null);
      setMoveToBrandId("");
      toast({ title: t("brands.stickerMoved") });
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", title: t("brands.moveFailed"), description: err.message });
    },
  });

  // ─── analytics tab state ──────────────────────────────────────────────────
  const [analyticsPeriod, setAnalyticsPeriod] = useState<"Last 7 days" | "Last 30 days" | "Last 90 days" | "Last year">("Last 30 days");
  const [analyticsChannels, setAnalyticsChannels] = useState<string[]>(["All Channels"]);
  const [salesGranularity, setSalesGranularity] = useState<"day" | "week" | "month">("month");

  const PERIOD_TO_API: Record<typeof analyticsPeriod, string> = {
    "Last 7 days": "7d",
    "Last 30 days": "30d",
    "Last 90 days": "90d",
    "Last year": "1y",
  };

  const { data: analyticsData, isLoading: analyticsLoading } = useQuery({
    queryKey: ["brands", id, "analytics", analyticsPeriod, salesGranularity],
    queryFn: () =>
      apiFetch<BrandAnalytics>(
        `/api/brands/${id}/analytics?period=${PERIOD_TO_API[analyticsPeriod]}&granularity=${salesGranularity}`,
      ),
    enabled: !!id && !Number.isNaN(id),
  });

  const salesTrendData = analyticsData?.sales_trend ?? [];

  const analyticsChannelOptions = [
    "All Channels",
    ...Array.from(new Set((analyticsData?.channel_breakdown ?? []).map((c) => c.channel))),
  ];

  const filteredChannelBreakdown = analyticsData?.channel_breakdown
    ? analyticsChannels.includes("All Channels")
      ? analyticsData.channel_breakdown
      : analyticsData.channel_breakdown.filter((c) => analyticsChannels.includes(c.channel))
    : [];

  const filteredCategoryBreakdown = analyticsData?.category_breakdown ?? [];

  // ─── early returns ────────────────────────────────────────────────────────

  if (Number.isNaN(id)) {
    return <div className="text-muted-foreground text-sm">{t("brands.invalidBrandId")}</div>;
  }

  if (brandLoading) {
    return <div className="text-sm text-muted-foreground">{t("common.loading")}</div>;
  }

  if (!brand) {
    return (
      <div className="space-y-4">
        <Link href="/brands" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft size={14} />
          {t("brands.backToBrands")}
        </Link>
        <p className="text-sm text-muted-foreground">{t("brands.brandNotFound")}</p>
      </div>
    );
  }

  // ─── header action buttons (context-sensitive) ────────────────────────────

  const headerActions = (
    <div className="flex items-center gap-2 shrink-0 flex-wrap">
      {activeTab === "overview" && (
        <>
          {canEditBrand && (
            <Button size="sm" variant="outline" onClick={startEditMeta}>
              <Pencil size={14} className="mr-1.5" />
              Edit Brand
            </Button>
          )}
          {canDeleteBrand && (
            <Button size="sm" variant="outline" className="text-destructive hover:text-destructive" onClick={() => setDeleteBrandOpen(true)}>
              <Trash2 size={14} className="mr-1.5" />
              Delete
            </Button>
          )}
        </>
      )}
      {activeTab === "assets" && (
        <>
          {canManageLogos && (
            <Button size="sm" variant="outline" onClick={() => { setAddLogoFile(null); setAddLogoLabel(""); setAddLogoPreview(null); setAddLogoError(null); setAddLogoOpen(true); }}>
              <ImagePlus size={14} className="mr-1.5" />
              Add Logo
            </Button>
          )}
          {canManageCoverPhotos && (
            <Button size="sm" variant="outline" onClick={() => { setCoverLabel(""); setCoverFile(null); setAddCoverOpen(true); }}>
              <Images size={14} className="mr-1.5" />
              Add Cover Photo
            </Button>
          )}
          {canManageStickers && (
            <Button size="sm" variant="outline" onClick={() => { setUploadName(""); setUploadFile(null); setUploadOpen(true); }}>
              <Upload size={14} className="mr-1.5" />
              Add Sticker
            </Button>
          )}
        </>
      )}
      {activeTab === "products" && (
        <>
          <Button
            size="sm"
            variant="outline"
            disabled={isExporting || exportConfigsLoading}
            onClick={async () => {
              setExportConfigsLoading(true);
              try {
                const token = await getClerkToken();
                const [configsRes, channelsRes] = await Promise.all([
                  fetch("/api/channel-image-configs?image_type=product", {
                    credentials: "include",
                    headers: token ? { Authorization: `Bearer ${token}` } : {},
                  }),
                  fetch("/api/channels", {
                    credentials: "include",
                    headers: token ? { Authorization: `Bearer ${token}` } : {},
                  }),
                ]);
                const configsJson = configsRes.ok ? await configsRes.json() : { image_configs: [] };
                const channelsJson = channelsRes.ok ? await channelsRes.json() : { channels: [] };
                setExportConfigs(configsJson.image_configs ?? []);
                setExportChannels(channelsJson.channels ?? []);
                setSelectedExportConfigId("original");
                setExportPickerOpen(true);
              } catch {
                toast({ variant: "destructive", title: "Failed to load channel options", description: "Please try again." });
              } finally {
                setExportConfigsLoading(false);
              }
            }}
          >
            {isExporting || exportConfigsLoading ? <Loader2 size={14} className="animate-spin mr-1.5" /> : <Download size={14} className="mr-1.5" />}
            {isExporting ? "Exporting…" : "Export"}
          </Button>
          {isOwner && (
            <Button size="sm" onClick={() => {
              setAddProductForm({ name: "", price_usd: "", price_aed: "", discount_price_usd: "", discount_price_aed: "", status: "available", description: "", category: "", main_image_url: null });
              setAddProductOpen(true);
            }}>
              <Plus size={14} className="mr-1.5" />
              Add Product
            </Button>
          )}
        </>
      )}
    </div>
  );

  // ─── JSX ──────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-0">
      {/* ── Brand header ── */}
      <div className="pb-0 space-y-4">
        <Link
          href="/brands"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft size={14} />
          {t("brands.backToBrands")}
        </Link>

        <div className="flex items-start justify-between gap-4 flex-wrap">
          {/* Logo + Name + Description + Pills */}
          <div className="flex items-start gap-4 min-w-0">
            <div className="shrink-0 w-16 h-16 rounded-xl border border-border overflow-hidden bg-secondary flex items-center justify-center">
              {logos.length > 0 ? (
                <WorkspaceImage
                  src={`/api/brands/${id}/logos/${logos[0].id}/image`}
                  alt={`${brand.name} logo`}
                  className="w-full h-full object-cover"
                />
              ) : brand.has_logo ? (
                <WorkspaceImage
                  src={`/api/brands/${id}/logo`}
                  alt={`${brand.name} logo`}
                  className="w-full h-full object-cover"
                />
              ) : (
                <span className="text-2xl font-bold text-muted-foreground/40 select-none">
                  {brand.name.charAt(0).toUpperCase()}
                </span>
              )}
            </div>

            <div className="flex-1 min-w-0">
              {editingName ? (
                <div className="flex items-center gap-2 mb-1">
                  <Input
                    className="text-xl font-bold h-9 max-w-xs"
                    value={nameValue}
                    onChange={(e) => setNameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitRename();
                      if (e.key === "Escape") setEditingName(false);
                    }}
                    autoFocus
                    disabled={renameBrandMutation.isPending}
                  />
                  <Button size="sm" onClick={commitRename} disabled={renameBrandMutation.isPending}>
                    <Check size={13} className="mr-1" />
                    {renameBrandMutation.isPending ? "Saving…" : "Save"}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setEditingName(false)} disabled={renameBrandMutation.isPending}>
                    Cancel
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-2 group/name mb-0.5">
                  <h1
                    className={`text-2xl font-bold tracking-tight${canEditBrand ? " cursor-pointer hover:text-foreground/80 transition-colors" : ""}`}
                    onClick={canEditBrand ? startEditName : undefined}
                    title={canEditBrand ? "Click to rename" : undefined}
                  >
                    {brand.name}
                  </h1>
                  {canEditBrand && (
                    <button
                      type="button"
                      onClick={startEditName}
                      className="opacity-0 group-hover/name:opacity-100 transition-opacity text-muted-foreground hover:text-foreground"
                      title="Rename brand"
                    >
                      <Pencil size={14} />
                    </button>
                  )}
                </div>
              )}
              {brand.description && !editingMeta && (
                <p className="text-sm text-muted-foreground max-w-lg leading-snug">{brand.description}</p>
              )}

              {/* Stat pills */}
              <div className="flex flex-wrap items-center gap-2 mt-2">
                <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-secondary text-muted-foreground border border-border">
                  <Layers size={10} />
                  {brand.sticker_count} sticker{parseInt(brand.sticker_count, 10) !== 1 ? "s" : ""}
                </span>
                <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-secondary text-muted-foreground border border-border">
                  <ShoppingBag size={10} />
                  {allBrandProducts.length} product{allBrandProducts.length !== 1 ? "s" : ""}
                </span>
                <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-secondary text-muted-foreground border border-border">
                  <ImageIcon size={10} />
                  {logos.length} logo{logos.length !== 1 ? "s" : ""}
                </span>
                {brand.target_cogs !== null && (
                  <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-teal-50 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400 border border-teal-200 dark:border-teal-800">
                    <TrendingUp size={10} />
                    Target: {parseFloat(brand.target_cogs).toFixed(1)}% COGS
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Context-sensitive action buttons */}
          {headerActions}
        </div>

        {/* ── Tab bar ── */}
        <div className="border-b border-border mt-2">
          <nav className="flex gap-0" role="tablist">
            {TAB_LABELS.map((tab) => (
              <button
                key={tab.id}
                role="tab"
                aria-selected={activeTab === tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px ${
                  activeTab === tab.id
                    ? "border-teal-600 text-teal-700 dark:border-teal-400 dark:text-teal-400"
                    : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          OVERVIEW TAB
      ══════════════════════════════════════════════════════════════════════ */}
      {activeTab === "overview" && (
        <div className="space-y-6 pt-6">
          {/* KPI row */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <MetricCard
              icon={<ImageIcon size={16} />}
              label="Logos"
              value={logos.length}
              sub={logos.length === 0 ? "None uploaded" : logos.length === 1 ? "Primary only" : `${logos.length} variants`}
            />
            <MetricCard
              icon={<Layers size={16} />}
              label="Stickers"
              value={parseInt(brand.sticker_count, 10)}
              sub="PDF sticker designs"
            />
            <MetricCard
              icon={<Images size={16} />}
              label="Cover Photos"
              value={coverPhotos.length}
              sub="Seasonal covers"
            />
            <MetricCard
              icon={<ShoppingBag size={16} />}
              label="Products"
              value={allBrandProducts.length}
              sub={`${productStats.available} available`}
            />
            <MetricCard
              icon={<TrendingUp size={16} />}
              label="COGS Status"
              value={brand.target_cogs !== null ? `${parseFloat(brand.target_cogs).toFixed(1)}%` : "—"}
              sub={brand.target_cogs !== null ? "Target set" : "No target set"}
              accent={brand.target_cogs !== null ? "border-teal-200 dark:border-teal-800" : ""}
            />
          </div>

          {/* COGS trend chart */}
          {(() => {
            const periods = cogsTrend?.periods ?? [];
            const targetCogs = cogsTrend?.target_cogs ?? null;
            if (periods.length < 2) return null;
            const hasActual = periods.some((p) => p.actual_cogs !== null);
            return (
              <div className="rounded-xl border border-border bg-card p-4 shadow-sm space-y-3">
                <div className="flex items-center justify-between gap-4">
                  <div>
                    <h2 className="text-sm font-semibold">COGS Trend</h2>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {hasActual
                        ? "Actual COGS % vs target by period"
                        : "Completed print jobs per period — COGS % will appear once per-job costs are tracked"}
                    </p>
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    {(["month", "week"] as const).map((g) => (
                      <button
                        key={g}
                        type="button"
                        onClick={() => setTrendGranularity(g)}
                        className={`px-2.5 py-1 rounded text-xs font-medium transition-colors capitalize ${trendGranularity === g ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
                      >
                        {g}
                      </button>
                    ))}
                  </div>
                </div>
                <ResponsiveContainer width="100%" height={220}>
                  <ComposedChart data={periods} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                    <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                    <XAxis dataKey="label" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                    {hasActual ? (
                      <YAxis yAxisId="cogs" tickFormatter={(v) => `${v}%`} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={40} />
                    ) : (
                      <YAxis yAxisId="jobs" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={32} allowDecimals={false} />
                    )}
                    <RechartsTooltip
                      formatter={(value: number, name: string) => {
                        if (name === "actual_cogs") return [`${value.toFixed(1)}%`, "Actual COGS"];
                        if (name === "job_count") return [value, "Jobs completed"];
                        return [value, name];
                      }}
                      contentStyle={{ fontSize: 12 }}
                    />
                    {hasActual ? (
                      <>
                        {targetCogs !== null && (
                          <ReferenceLine yAxisId="cogs" y={targetCogs} stroke="hsl(var(--destructive))" strokeDasharray="4 3" label={{ value: `Target ${targetCogs.toFixed(1)}%`, position: "insideTopRight", fontSize: 10, fill: "hsl(var(--destructive))" }} />
                        )}
                        <Line yAxisId="cogs" type="monotone" dataKey="actual_cogs" stroke="hsl(var(--primary))" strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} connectNulls={false} />
                      </>
                    ) : (
                      <Bar yAxisId="jobs" dataKey="job_count" fill="hsl(var(--primary))" opacity={0.7} radius={[3, 3, 0, 0]} name="job_count" />
                    )}
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            );
          })()}

          {/* Sticker Sheet card */}
          <div className="rounded-xl border border-border bg-card p-4 shadow-sm space-y-2">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold flex items-center gap-1.5">
                <FileImage size={14} className="text-muted-foreground" />
                Sticker Sheet
              </h2>
              <div className="flex items-center gap-2">
                {activeStickerSheet && (
                  <Link href="/stickers" className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-0.5">
                    View all
                    <ExternalLink size={10} />
                  </Link>
                )}
                {canUploadStickerSheet && (
                  <Link href="/stickers" className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                    <Upload size={11} />
                    {activeStickerSheet ? "Upload New" : "Upload Sheet"}
                  </Link>
                )}
              </div>
            </div>
            {activeStickerSheet ? (
              <div className="flex items-center gap-3 flex-wrap">
                <div className="flex items-center gap-1.5">
                  {activeStickerSheet.status === "print_ready" && activeStickerSheet.is_active ? (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700 bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-800 rounded-full px-2 py-0.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block" />
                      Print Ready
                    </span>
                  ) : activeStickerSheet.status === "pending_review" ? (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-full px-2 py-0.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-amber-500 inline-block" />
                      Pending Review
                    </span>
                  ) : activeStickerSheet.status === "needs_changes" ? (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-red-700 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-full px-2 py-0.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-red-500 inline-block" />
                      Needs Changes
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground border rounded-full px-2 py-0.5">
                      {activeStickerSheet.status}
                    </span>
                  )}
                </div>
                <span className="text-xs text-muted-foreground">v{activeStickerSheet.version_number}</span>
                <span className="text-xs text-muted-foreground truncate max-w-[180px]">{activeStickerSheet.file_name}</span>
                <span className="text-xs text-muted-foreground">{activeStickerSheet.sticker_count} sticker{activeStickerSheet.sticker_count !== 1 ? "s" : ""}</span>
                {activeStickerSheet.change_request_notes && (
                  <p className="text-xs text-destructive w-full">{activeStickerSheet.change_request_notes}</p>
                )}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No sticker sheet uploaded yet.</p>
            )}
          </div>

          {/* Brand Details card */}
          <div className="rounded-xl border border-border bg-card p-4 shadow-sm space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold">Brand Details</h2>
              {canEditBrand && !editingMeta && (
                <button type="button" onClick={startEditMeta} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors">
                  <Pencil size={11} />
                  Edit
                </button>
              )}
            </div>

            {editingMeta ? (
              <div className="space-y-3">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">{t("brands.description")}</label>
                  <Textarea
                    value={metaDescription}
                    onChange={(e) => setMetaDescription(e.target.value)}
                    placeholder={t("brands.descriptionPlaceholder")}
                    rows={2}
                    className="resize-none text-sm"
                    autoFocus
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-xs font-medium text-muted-foreground">{t("brands.targetCogsLabel")}</label>
                  <div className="relative w-36">
                    <Input
                      type="number"
                      min={0}
                      max={100}
                      step={0.1}
                      placeholder="e.g. 28"
                      value={metaTargetCogs}
                      onChange={(e) => setMetaTargetCogs(e.target.value)}
                      className="pr-7 text-sm"
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground pointer-events-none">%</span>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" onClick={() => metaMutation.mutate()} disabled={metaMutation.isPending}>
                    <Check size={13} className="mr-1" />
                    {metaMutation.isPending ? t("common.saving") : t("common.save")}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setEditingMeta(false)} disabled={metaMutation.isPending}>
                    {t("common.cancel")}
                  </Button>
                </div>
              </div>
            ) : (
              <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
                <div>
                  <dt className="text-xs text-muted-foreground mb-0.5">Description</dt>
                  <dd className="text-sm">{brand.description || <span className="text-muted-foreground/60 italic">No description</span>}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground mb-0.5">Created</dt>
                  <dd className="text-sm">{new Date(brand.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground mb-0.5">Last updated</dt>
                  <dd className="text-sm" title={formatDate(brand.updated_at ?? brand.created_at)}>
                    {formatRelativeTime(brand.updated_at ?? brand.created_at)}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground mb-0.5">Primary Logo</dt>
                  <dd>
                    {logos.length > 0 ? (
                      <div className="w-10 h-10 rounded-md border border-border overflow-hidden bg-muted">
                        <WorkspaceImage src={`/api/brands/${id}/logos/${logos[0].id}/image`} alt="Primary logo" className="w-full h-full object-cover" />
                      </div>
                    ) : (
                      <span className="text-muted-foreground/60 italic text-xs">No logo</span>
                    )}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground mb-0.5">Card Message</dt>
                  <dd>
                    {brand.has_card_message ? (
                      <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700 bg-green-50 dark:bg-green-900/30 dark:text-green-400 px-2 py-0.5 rounded-full">
                        <Check size={10} />
                        Set
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground/60 italic">Not set</span>
                    )}
                  </dd>
                </div>
                {brand.target_cogs !== null && (
                  <div>
                    <dt className="text-xs text-muted-foreground mb-0.5">COGS Target</dt>
                    <dd className="text-sm font-medium">{parseFloat(brand.target_cogs).toFixed(1)}%</dd>
                  </div>
                )}
              </dl>
            )}
          </div>

          {/* Mini sections row */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Logos mini */}
            <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold flex items-center gap-1.5"><ImageIcon size={14} className="text-muted-foreground" /> Logos</h3>
                <button className="text-xs text-teal-600 hover:underline" onClick={() => setActiveTab("assets")}>
                  View all →
                </button>
              </div>
              {logosLoading ? (
                <div className="text-xs text-muted-foreground">Loading…</div>
              ) : logos.length === 0 ? (
                <div className="text-xs text-muted-foreground italic">No logos yet</div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {logos.slice(0, 4).map((logo, idx) => (
                    <div key={logo.id} className="w-10 h-10 rounded-md border border-border overflow-hidden bg-muted">
                      <WorkspaceImage src={`/api/brands/${id}/logos/${logo.id}/image`} alt={logo.label ?? `Logo ${idx + 1}`} className="w-full h-full object-cover" />
                    </div>
                  ))}
                  {logos.length > 4 && (
                    <div className="w-10 h-10 rounded-md border border-border bg-muted flex items-center justify-center text-[10px] font-medium text-muted-foreground">
                      +{logos.length - 4}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Cover Photos mini */}
            <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold flex items-center gap-1.5"><Images size={14} className="text-muted-foreground" /> Cover Photos</h3>
                <button className="text-xs text-teal-600 hover:underline" onClick={() => setActiveTab("assets")}>
                  View all →
                </button>
              </div>
              {coverLoading ? (
                <div className="text-xs text-muted-foreground">Loading…</div>
              ) : coverPhotos.length === 0 ? (
                <div className="text-xs text-muted-foreground italic">No cover photos yet</div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {coverPhotos.slice(0, 3).map((photo) => (
                    <div key={photo.id} className="w-16 h-10 rounded-md border border-border overflow-hidden bg-muted">
                      <WorkspaceImage src={`/api/brands/${id}/cover-photos/${photo.id}/image`} alt={photo.label} className="w-full h-full object-cover" />
                    </div>
                  ))}
                  {coverPhotos.length > 3 && (
                    <div className="w-10 h-10 rounded-md border border-border bg-muted flex items-center justify-center text-[10px] font-medium text-muted-foreground">
                      +{coverPhotos.length - 3}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Card Message mini */}
            <div className="rounded-xl border border-border bg-card p-4 shadow-sm">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold flex items-center gap-1.5"><FileImage size={14} className="text-muted-foreground" /> Card Message</h3>
                <button className="text-xs text-teal-600 hover:underline" onClick={() => setActiveTab("assets")}>
                  View all →
                </button>
              </div>
              {brand.has_card_message ? (
                <div className="rounded-md border border-border overflow-hidden bg-secondary/30 max-w-[120px]">
                  <WorkspaceImage src={`/api/brands/${id}/card-message?v=${cardMsgVersion}`} alt="Card message" className="w-full object-contain" />
                </div>
              ) : (
                <div className="text-xs text-muted-foreground italic">Not set</div>
              )}
            </div>
          </div>

          {/* Marketplace Performance mini-card */}
          <MarketplacePerformanceCard brandId={id} onViewAll={() => setActiveTab("marketplace-reports")} />

          {/* Products preview */}
          <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-border flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-2">
                <ShoppingBag size={15} className="text-muted-foreground" />
                <h2 className="text-sm font-semibold">Products</h2>
                <span className="text-xs text-muted-foreground">({allBrandProducts.length})</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex items-center rounded-md border border-border overflow-hidden text-xs font-medium">
                  {(["all", "available", "unavailable"] as const).map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setProductAvailabilityFilter(f)}
                      className={`px-2.5 py-1.5 transition-colors ${productAvailabilityFilter === f ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-secondary"}`}
                    >
                      {f === "all" ? "All" : f === "available" ? "Available" : "Unavailable"}
                    </button>
                  ))}
                </div>
                <button className="text-xs text-teal-600 hover:underline" onClick={() => setActiveTab("products")}>
                  View all →
                </button>
              </div>
            </div>
            {overviewProducts.length === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground">
                {productAvailabilityFilter === "all" ? "No products assigned to this brand." : `No ${productAvailabilityFilter} products.`}
              </div>
            ) : (
              <div className="divide-y divide-border">
                {overviewProducts.map((product) => {
                  const imgUrl = productImageUrl(product.main_image_url);
                  return (
                    <div key={product.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-secondary/30 transition-colors">
                      <a href={`/products/${product.id}`} target="_blank" rel="noopener noreferrer" className="w-9 h-9 rounded-md border border-border overflow-hidden bg-muted flex items-center justify-center shrink-0">
                        {imgUrl ? <img src={imgUrl} alt={product.name} className="w-full h-full object-cover" /> : <ImageIcon size={13} className="text-muted-foreground" />}
                      </a>
                      <div className="flex-1 min-w-0">
                        <a href={`/products/${product.id}`} target="_blank" rel="noopener noreferrer" className="text-sm font-medium truncate hover:underline block">{product.name}</a>
                        <p className="text-xs text-muted-foreground">
                          {product.discount_price_usd ? (
                            <>
                              {formatUSD(product.discount_price_usd)} <span className="line-through">{formatUSD(product.price_usd)}</span>
                            </>
                          ) : (
                            formatUSD(product.price_usd)
                          )} · {product.discount_price_aed ? (
                            <>
                              {formatAED(product.discount_price_aed)} <span className="line-through">{formatAED(product.price_aed)}</span>
                            </>
                          ) : (
                            formatAED(product.price_aed)
                          )}{product.category ? ` · ${product.category}` : ""}
                        </p>
                      </div>
                      <ProductStatusBadge status={product.status} />
                    </div>
                  );
                })}
              </div>
            )}
            {allBrandProducts.length > 5 && (
              <div className="px-4 py-2.5 border-t border-border text-center">
                <button className="text-xs text-teal-600 hover:underline" onClick={() => setActiveTab("products")}>
                  See all {allBrandProducts.length} products →
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          ASSETS TAB
      ══════════════════════════════════════════════════════════════════════ */}
      {activeTab === "assets" && (
        <div className="space-y-6 pt-6">
          {/* Asset KPI cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <MetricCard icon={<ImageIcon size={16} />} label="Logos" value={logos.length} sub={logos.length === 1 ? "1 variant" : `${logos.length} variants`} />
            <MetricCard icon={<Layers size={16} />} label="Stickers" value={parseInt(brand.sticker_count, 10)} sub="PDF designs" />
            <MetricCard icon={<Images size={16} />} label="Cover Photos" value={coverPhotos.length} sub="Seasonal covers" />
            <MetricCard
              icon={<FileImage size={16} />}
              label="Card Message"
              value={brand.has_card_message ? "Set" : "Not set"}
              sub={brand.has_card_message ? "Image uploaded" : "No image"}
              accent={brand.has_card_message ? "border-green-200 dark:border-green-800" : ""}
            />
          </div>

          {/* ── Logos section ── */}
          <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
            <div className="px-4 py-3 bg-muted/30 border-b border-border flex items-center justify-between">
              <div className="flex items-center gap-2">
                <ImageIcon size={15} className="text-muted-foreground" />
                <h2 className="text-sm font-semibold">Logos</h2>
                {logos.length > 0 && <span className="text-xs text-muted-foreground">({logos.length})</span>}
                {!canManageLogos && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full border border-border bg-muted text-muted-foreground cursor-default">
                        <Lock size={9} /> Read only
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>Your role cannot manage logos</TooltipContent>
                  </Tooltip>
                )}
              </div>
              {canManageLogos && (
                <Button size="sm" variant="outline" onClick={() => { setAddLogoFile(null); setAddLogoLabel(""); setAddLogoPreview(null); setAddLogoError(null); setAddLogoOpen(true); }}>
                  <ImagePlus size={14} className="mr-1.5" /> Add logo
                </Button>
              )}
            </div>
            {logosLoading ? (
              <div className="p-4 text-sm text-muted-foreground">{t("common.loading")}</div>
            ) : logos.length === 0 ? (
              <div className="p-8 text-center">
                <ImageIcon size={28} className="mx-auto mb-2 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">No logos yet</p>
                {canManageLogos && (
                  <Button size="sm" variant="outline" className="mt-3" onClick={() => { setAddLogoFile(null); setAddLogoLabel(""); setAddLogoPreview(null); setAddLogoError(null); setAddLogoOpen(true); }}>
                    <ImagePlus size={14} className="mr-1.5" /> Add logo
                  </Button>
                )}
              </div>
            ) : (
              <DndContext sensors={logoSensors} collisionDetection={closestCenter} onDragEnd={handleLogoDragEnd}>
                <SortableContext items={logos.map((l) => l.id)} strategy={verticalListSortingStrategy}>
                  <div className="divide-y divide-border">
                    {logos.map((logo, idx) => (
                      <SortableLogoItem
                        key={logo.id}
                        logo={logo}
                        idx={idx}
                        isFirst={idx === 0}
                        isOnlyOne={logos.length === 1}
                        canManage={canManageLogos}
                        brandId={id}
                        editingLogoLabelId={editingLogoLabelId}
                        editingLogoLabelValue={editingLogoLabelValue}
                        setEditingLogoLabelId={setEditingLogoLabelId}
                        setEditingLogoLabelValue={setEditingLogoLabelValue}
                        onSaveLabel={(logoId, label) => updateLogoLabelMutation.mutate({ logoId, label })}
                        onDelete={(logoId) => softDeleteLogoMutation.mutate(logoId)}
                        isSavingLabel={updateLogoLabelMutation.isPending}
                        isDeleting={softDeleteLogoMutation.isPending}
                        brandName={brand.name}
                      />
                    ))}
                  </div>
                </SortableContext>
              </DndContext>
            )}
          </div>

          {/* ── Stickers section ── */}
          <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
            <div className="px-4 py-3 bg-muted/30 border-b border-border flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Layers size={15} className="text-muted-foreground" />
                <h2 className="text-sm font-semibold">{t("brands.stickers")}</h2>
                {stickers.length > 0 && <span className="text-xs text-muted-foreground">({stickers.length})</span>}
                {!canManageStickers && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full border border-border bg-muted text-muted-foreground cursor-default">
                        <Lock size={9} /> Read only
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>Your role cannot manage stickers</TooltipContent>
                  </Tooltip>
                )}
              </div>
              {canManageStickers && (
                <Button size="sm" variant="outline" onClick={() => { setUploadName(""); setUploadFile(null); setUploadOpen(true); }}>
                  <Upload size={14} className="mr-1.5" /> {t("brands.addSticker")}
                </Button>
              )}
            </div>
            {stickersLoading ? (
              <div className="p-4 text-sm text-muted-foreground">{t("brands.loadingStickers")}</div>
            ) : stickers.length === 0 ? (
              <div className="p-8 text-center">
                <Layers size={28} className="mx-auto mb-2 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">{t("brands.noStickersYet")}</p>
                {canManageStickers && (
                  <Button size="sm" variant="outline" className="mt-3" onClick={() => { setUploadName(""); setUploadFile(null); setUploadOpen(true); }}>
                    <Upload size={14} className="mr-1.5" /> {t("brands.addSticker")}
                  </Button>
                )}
              </div>
            ) : (
              <div className="divide-y divide-border">
                {stickers.map((sticker) => {
                  const isRenaming = renamingId === sticker.id;
                  return (
                    <div key={sticker.id} className="flex items-center gap-3 px-4 py-3">
                      <div className="text-2xl shrink-0">📄</div>
                      <div className="flex-1 min-w-0">
                        {isRenaming ? (
                          <div className="flex items-center gap-1.5">
                            <Input
                              className="h-7 text-sm px-2 max-w-[180px]"
                              value={renameValue}
                              onChange={(e) => setRenameValue(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") renameMutation.mutate({ sid: sticker.id, name: renameValue });
                                if (e.key === "Escape") setRenamingId(null);
                              }}
                              autoFocus
                            />
                            <button className="text-green-600 hover:text-green-700" onClick={() => renameMutation.mutate({ sid: sticker.id, name: renameValue })} disabled={renameMutation.isPending}>
                              <Check size={14} />
                            </button>
                            <button className="text-muted-foreground hover:text-foreground" onClick={() => setRenamingId(null)}>
                              <X size={14} />
                            </button>
                          </div>
                        ) : (
                          <p className="text-sm font-medium truncate">{sticker.name}</p>
                        )}
                        <p className="text-xs text-muted-foreground">{sticker.file_name}</p>
                      </div>
                      {canManageStickers && !isRenaming && (
                        <div className="flex items-center gap-1 shrink-0">
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-muted-foreground" onClick={() => { setRenamingId(sticker.id); setRenameValue(sticker.name); }}>
                            <Pencil size={13} />
                          </Button>
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-muted-foreground" onClick={() => { setMoveTarget(sticker); setMoveToBrandId(""); }}>
                            <ArrowRight size={13} />
                          </Button>
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive hover:text-destructive" onClick={() => setDeleteTarget(sticker)}>
                            <Trash2 size={13} />
                          </Button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* ── Cover Photos section ── */}
          <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
            <div className="px-4 py-3 bg-muted/30 border-b border-border flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Images size={15} className="text-muted-foreground" />
                <h2 className="text-sm font-semibold">{t("brands.coverPhotos")}</h2>
                {coverPhotos.length > 0 && <span className="text-xs text-muted-foreground">({coverPhotos.length})</span>}
                {!canManageCoverPhotos && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full border border-border bg-muted text-muted-foreground cursor-default">
                        <Lock size={9} /> Read only
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>Your role cannot manage cover photos</TooltipContent>
                  </Tooltip>
                )}
              </div>
              {canManageCoverPhotos && (
                <Button size="sm" variant="outline" onClick={() => { setCoverLabel(""); setCoverFile(null); setAddCoverOpen(true); }}>
                  <ImagePlus size={14} className="mr-1.5" /> {t("brands.addCoverPhoto")}
                </Button>
              )}
            </div>
            {coverLoading ? (
              <div className="p-4 text-sm text-muted-foreground">{t("common.loading")}</div>
            ) : coverPhotos.length === 0 ? (
              <div className="p-8 text-center">
                <Images size={28} className="mx-auto mb-2 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">{t("brands.noCoverPhotos")}</p>
                {canManageCoverPhotos && (
                  <Button size="sm" variant="outline" className="mt-3" onClick={() => { setCoverLabel(""); setCoverFile(null); setAddCoverOpen(true); }}>
                    <ImagePlus size={14} className="mr-1.5" /> {t("brands.addCoverPhoto")}
                  </Button>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 p-4">
                {coverPhotos.map((photo) => (
                  <div
                    key={photo.id}
                    className="group rounded-lg border border-border overflow-hidden cursor-pointer bg-secondary/20 hover:shadow-md transition-shadow"
                    onClick={() => setSelectedCoverPhoto(photo)}
                  >
                    <div className="relative aspect-video bg-muted">
                      <WorkspaceImage src={`/api/brands/${id}/cover-photos/${photo.id}/image`} alt={photo.label} className="w-full h-full object-cover" />
                      <div className="absolute inset-0 bg-black/0 group-hover:bg-black/25 transition-colors flex items-center justify-center pointer-events-none">
                        <ZoomIn size={18} className="text-white opacity-0 group-hover:opacity-100 transition-opacity" />
                      </div>
                      {canManageCoverPhotos && (
                        <button
                          className="absolute top-1 right-1 p-1 rounded bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-destructive"
                          onClick={(e) => { e.stopPropagation(); setDeleteCoverTarget(photo); }}
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                    </div>
                    <div className="px-2.5 py-1.5">
                      <span className="text-xs font-medium text-muted-foreground">{photo.label}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── Card Message section ── */}
          <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
            <div className="px-4 py-3 bg-muted/30 border-b border-border flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileImage size={15} className="text-muted-foreground" />
                <h2 className="text-sm font-semibold">{t("brands.cardMessage")}</h2>
                {!canManageCardMessage && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="inline-flex items-center gap-1 text-xs px-1.5 py-0.5 rounded-full border border-border bg-muted text-muted-foreground cursor-default">
                        <Lock size={9} /> Read only
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>Your role cannot manage the card message</TooltipContent>
                  </Tooltip>
                )}
              </div>
              {canManageCardMessage && (
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="outline" onClick={() => cardMsgInputRef.current?.click()} disabled={cardMsgMutation.isPending}>
                    <Upload size={14} className="mr-1.5" />
                    {cardMsgMutation.isPending ? t("brands.uploading") : brand.has_card_message ? t("common.replace") : t("brands.uploadImage")}
                  </Button>
                  {brand.has_card_message && (
                    <Button size="sm" variant="outline" className="text-destructive hover:text-destructive" onClick={() => setDeleteCardMsgOpen(true)} disabled={deleteCardMsgMutation.isPending}>
                      <Trash2 size={14} className="mr-1.5" /> {t("common.remove")}
                    </Button>
                  )}
                </div>
              )}
            </div>
            <div className="p-4">
              {brand.has_card_message ? (
                <div className="rounded-lg border border-border overflow-hidden bg-secondary/30 max-w-sm">
                  <WorkspaceImage src={`/api/brands/${id}/card-message?v=${cardMsgVersion}`} alt={t("brands.cardMessage")} className="w-full object-contain" />
                </div>
              ) : (
                <div className="rounded-lg border border-dashed border-border p-8 text-center max-w-sm">
                  <FileImage size={28} className="mx-auto mb-2 text-muted-foreground/40" />
                  <p className="text-sm text-muted-foreground">{t("brands.noCardMessage")}</p>
                  {canManageCardMessage && (
                    <Button size="sm" variant="outline" className="mt-3" onClick={() => cardMsgInputRef.current?.click()} disabled={cardMsgMutation.isPending}>
                      <Upload size={14} className="mr-1.5" /> {t("brands.uploadImage")}
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>

          <input
            ref={cardMsgInputRef}
            type="file"
            accept="image/jpeg,image/png"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) { handleCardMsgFile(file); e.target.value = ""; }
            }}
          />
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          PRODUCTS TAB
      ══════════════════════════════════════════════════════════════════════ */}
      {activeTab === "products" && (
        <div className="space-y-5 pt-6">
          {/* Stat cards */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            <MetricCard icon={<Package size={16} />} label="Total" value={productStats.total} sub="All products" />
            <MetricCard icon={<Check size={16} />} label="Available" value={productStats.available} sub="Ready to sell" accent="border-green-200 dark:border-green-800" />
            <MetricCard icon={<X size={16} />} label="Unavailable" value={productStats.unavailable} sub="Hidden or OOS" />
            <MetricCard icon={<Tag size={16} />} label="Categories" value={productStats.categories} sub="Distinct categories" />
            <MetricCard icon={<TrendingUp size={16} />} label="Avg. Price" value={productStats.avgPrice > 0 ? `$${productStats.avgPrice.toFixed(2)}` : "—"} sub="USD average" />
          </div>

          {/* Filters & search */}
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[180px] max-w-xs">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
              <Input
                type="search"
                value={productsSearch}
                onChange={(e) => { setProductsSearch(e.target.value); setProductsPage(1); }}
                placeholder="Search products…"
                className="h-8 pl-8 text-sm"
              />
            </div>

            {/* Status segmented filter */}
            <div className="flex items-center rounded-md border border-border overflow-hidden text-xs font-medium shrink-0">
              {(["all", "available", "unavailable"] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => { setProductsStatusFilter(f); setProductsPage(1); }}
                  className={`px-2.5 py-1.5 transition-colors ${productsStatusFilter === f ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground hover:bg-secondary"}`}
                >
                  {f === "all" ? "All" : f === "available" ? "Available" : "Unavailable"}
                </button>
              ))}
            </div>

            {/* Category dropdown */}
            {productCategories.length > 0 && (
              <Select value={productsCategoryFilter || "__all__"} onValueChange={(v) => { setProductsCategoryFilter(v === "__all__" ? "" : v); setProductsPage(1); }}>
                <SelectTrigger className="h-8 text-sm w-40">
                  <SelectValue placeholder="Category" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__all__">All categories</SelectItem>
                  {productCategories.map((c) => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}

            {/* Sort dropdown */}
            <Select value={productsSort} onValueChange={(v) => setProductsSort(v as typeof productsSort)}>
              <SelectTrigger className="h-8 text-sm w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="created_at">Newest first</SelectItem>
                <SelectItem value="name">Name A–Z</SelectItem>
                <SelectItem value="price_usd">Price (USD)</SelectItem>
                <SelectItem value="price_aed">Price (AED)</SelectItem>
              </SelectContent>
            </Select>

            <span className="text-xs text-muted-foreground ml-auto">
              {filteredProducts.length} of {allBrandProducts.length} products
            </span>
          </div>

          {/* Products table */}
          <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
            {paginatedProducts.length === 0 ? (
              <div className="p-10 text-center">
                <ShoppingBag size={28} className="mx-auto mb-2 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">
                  {allBrandProducts.length === 0
                    ? "No products assigned to this brand."
                    : "No products match your filters."}
                </p>
              </div>
            ) : (
              <div className="divide-y divide-border">
                {/* Table header */}
                <div className="hidden sm:grid grid-cols-[2fr_1fr_1fr_1fr_100px_32px] gap-3 px-4 py-2 bg-muted/40 text-xs font-medium text-muted-foreground">
                  <span>Product</span>
                  <span>Category</span>
                  <span>USD</span>
                  <span>AED</span>
                  <span>Status</span>
                  <span />
                </div>
                {paginatedProducts.map((product) => {
                  const imgUrl = productImageUrl(product.main_image_url);
                  return (
                    <div key={product.id} className="flex sm:grid sm:grid-cols-[2fr_1fr_1fr_1fr_100px_32px] items-center gap-3 px-4 py-2.5 hover:bg-secondary/30 transition-colors">
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="w-9 h-9 rounded-md border border-border overflow-hidden bg-muted flex items-center justify-center shrink-0">
                          {imgUrl ? <img src={imgUrl} alt={product.name} className="w-full h-full object-cover" /> : <ImageIcon size={12} className="text-muted-foreground" />}
                        </div>
                        <span className="text-sm font-medium truncate">{product.name}</span>
                      </div>
                      <span className="text-xs text-muted-foreground hidden sm:block truncate">{product.category ?? "—"}</span>
                      <span className="text-xs hidden sm:block">
                        {product.discount_price_usd ? (
                          <span className="flex items-baseline gap-1.5">
                            <PriceText value={formatUSD(product.discount_price_usd)} />
                            <span className="text-muted-foreground line-through">{formatUSD(product.price_usd)}</span>
                          </span>
                        ) : (
                          <PriceText value={formatUSD(product.price_usd)} />
                        )}
                      </span>
                      <span className="text-xs hidden sm:block">
                        {product.discount_price_aed ? (
                          <span className="flex items-baseline gap-1.5">
                            <PriceText value={formatAED(product.discount_price_aed)} />
                            <span className="text-muted-foreground line-through">{formatAED(product.price_aed)}</span>
                          </span>
                        ) : (
                          <PriceText value={formatAED(product.price_aed)} />
                        )}
                      </span>
                      <div className="hidden sm:flex">
                        <ProductStatusBadge status={product.status} />
                      </div>
                      <a
                        href={`/products/${product.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-muted-foreground hover:text-foreground shrink-0"
                      >
                        <ExternalLink size={13} />
                      </a>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Pagination */}
          {totalProductPages > 1 && (
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                Page {productsPage} of {totalProductPages} · {filteredProducts.length} products
              </p>
              <div className="flex items-center gap-1">
                <Button size="sm" variant="outline" className="h-7 w-7 p-0" disabled={productsPage <= 1} onClick={() => setProductsPage((p) => Math.max(1, p - 1))}>
                  <ChevronLeft size={13} />
                </Button>
                <Button size="sm" variant="outline" className="h-7 w-7 p-0" disabled={productsPage >= totalProductPages} onClick={() => setProductsPage((p) => Math.min(totalProductPages, p + 1))}>
                  <ChevronRight size={13} />
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          ANALYTICS TAB — real data from GET /api/brands/:id/analytics
      ══════════════════════════════════════════════════════════════════════ */}
      {activeTab === "analytics" && (
        <div className="space-y-6 pt-6">
          {/* Filter bar */}
          <div className="flex flex-wrap items-center gap-3 pb-2 border-b border-border">
            <div className="flex items-center gap-1.5">
              <label className="text-xs font-medium text-muted-foreground">Period</label>
              <Select value={analyticsPeriod} onValueChange={(v) => setAnalyticsPeriod(v as typeof analyticsPeriod)}>
                <SelectTrigger className="h-7 text-xs w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(["Last 7 days", "Last 30 days", "Last 90 days", "Last year"] as const).map((p) => (
                    <SelectItem key={p} value={p}>{p}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-xs font-medium text-muted-foreground">Channels</span>
              {analyticsChannelOptions.map((ch) => (
                <button
                  key={ch}
                  type="button"
                  onClick={() => {
                    setAnalyticsChannels((prev) =>
                      ch === "All Channels"
                        ? ["All Channels"]
                        : prev.includes(ch)
                        ? prev.filter((c) => c !== ch && c !== "All Channels") || ["All Channels"]
                        : [...prev.filter((c) => c !== "All Channels"), ch],
                    );
                  }}
                  className={`px-2 py-0.5 rounded-full text-xs font-medium border transition-colors ${
                    analyticsChannels.includes(ch)
                      ? "bg-teal-600 text-white border-teal-600"
                      : "border-border text-muted-foreground hover:border-foreground hover:text-foreground"
                  }`}
                >
                  {ch}
                </button>
              ))}
            </div>
            {analyticsLoading && (
              <span className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground/60 italic">
                <Loader2 size={10} className="animate-spin" /> Loading…
              </span>
            )}
          </div>

          {/* 6 inventory metric cards — live data from products */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <MetricCard
              label="Total Revenue"
              value={`$${(analyticsData?.kpis.total_revenue ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
              sub="USD"
              trend={0}
              trendDir="flat"
            />
            <MetricCard
              label="Total Orders"
              value={String(analyticsData?.kpis.total_orders ?? 0)}
              sub="orders"
              trend={0}
              trendDir="flat"
            />
            <MetricCard
              label="Avg. Order Value"
              value={`$${(analyticsData?.kpis.avg_order_value ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`}
              sub="per order"
              trend={0}
              trendDir="flat"
            />
            <MetricCard
              label="Total Units Sold"
              value={String(Math.round(analyticsData?.kpis.total_units ?? 0))}
              sub="units"
              trend={0}
              trendDir="flat"
            />
            <MetricCard
              label="Active Products"
              value={String(analyticsData?.kpis.active_products ?? 0)}
              sub={`of ${analyticsData?.kpis.total_products ?? 0} total`}
              trend={0}
              trendDir="flat"
            />
            <MetricCard
              label="Linked Products"
              value={String(analyticsData?.kpis.total_products ?? 0)}
              sub="in this brand"
              trend={0}
              trendDir="flat"
            />
          </div>

          {/* Charts row 1: Sales Trend + COGS Trend */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Sales Trend */}
            <div className="rounded-xl border border-border bg-card p-4 shadow-sm space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-semibold">Sales Trend</h3>
                  <p className="text-xs text-muted-foreground">Revenue over time</p>
                </div>
                <div className="flex items-center gap-1">
                  {(["day", "week", "month"] as const).map((g) => (
                    <button
                      key={g}
                      type="button"
                      onClick={() => setSalesGranularity(g)}
                      className={`px-2 py-0.5 rounded text-xs font-medium capitalize transition-colors ${salesGranularity === g ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
                    >
                      {g === "day" ? "Day" : g === "week" ? "Week" : "Month"}
                    </button>
                  ))}
                </div>
              </div>
              <ResponsiveContainer width="100%" height={200}>
                <LineChart data={salesTrendData} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis dataKey="period" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
                  <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} width={45} tickFormatter={(v) => `$${(v / 1000).toFixed(1)}k`} />
                  <RechartsTooltip formatter={(v: number) => [`$${v.toLocaleString()}`, "Revenue"]} contentStyle={{ fontSize: 12 }} />
                  <Line type="monotone" dataKey="revenue" stroke="#0d9488" strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* COGS Trend */}
            <div className="rounded-xl border border-border bg-card p-4 shadow-sm space-y-3">
              <div>
                <h3 className="text-sm font-semibold">COGS Trend</h3>
                <p className="text-xs text-muted-foreground">Actual vs target cost of goods sold</p>
              </div>
              <ResponsiveContainer width="100%" height={200}>
                <ComposedChart data={cogsTrend?.periods ?? []} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis dataKey="label" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fontSize: 10 }} tickLine={false} axisLine={false} width={38} tickFormatter={(v) => `${v}%`} />
                  <RechartsTooltip formatter={(v: number, name: string) => [`${v.toFixed(1)}%`, name === "actual_cogs" ? "Actual COGS" : "Target"]} contentStyle={{ fontSize: 12 }} />
                  {cogsSummary?.target_cogs != null && (
                    <ReferenceLine
                      y={cogsSummary.target_cogs}
                      stroke="hsl(var(--destructive))"
                      strokeDasharray="4 3"
                      label={{ value: `Target ${cogsSummary.target_cogs}%`, position: "insideTopRight", fontSize: 10, fill: "hsl(var(--destructive))" }}
                    />
                  )}
                  <Line type="monotone" dataKey="actual_cogs" stroke="#0d9488" strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} name="actual_cogs" />
                </ComposedChart>
              </ResponsiveContainer>
              {!cogsSummary?.target_cogs && (
                <p className="text-[10px] text-muted-foreground/60 text-center italic">Set a target COGS % on the Overview tab to enable this chart</p>
              )}
            </div>
          </div>

          {/* Charts row 2: Top Categories (donut) + Sales by Channel (horiz bars) */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Top Categories donut */}
            <div className="rounded-xl border border-border bg-card p-4 shadow-sm space-y-3">
              <div>
                <h3 className="text-sm font-semibold">Top Categories</h3>
                <p className="text-xs text-muted-foreground">Revenue share by category</p>
              </div>
              {filteredCategoryBreakdown.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-10">No category data for this period</p>
              ) : (
                <div className="flex items-center gap-4">
                  <ResponsiveContainer width={160} height={160}>
                    <PieChart>
                      <Pie
                        data={filteredCategoryBreakdown}
                        dataKey="value"
                        nameKey="name"
                        innerRadius={50}
                        outerRadius={75}
                        paddingAngle={2}
                      >
                        {filteredCategoryBreakdown.map((_, i) => (
                          <Cell key={i} fill={CATEGORY_COLORS[i % CATEGORY_COLORS.length]} />
                        ))}
                      </Pie>
                      <RechartsTooltip formatter={(v: number) => [`${v}%`, "Share"]} contentStyle={{ fontSize: 12 }} />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="flex-1 space-y-1.5">
                    {filteredCategoryBreakdown.map((cat, i) => (
                      <div key={cat.name} className="flex items-center gap-2 text-xs">
                        <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: CATEGORY_COLORS[i % CATEGORY_COLORS.length] }} />
                        <span className="flex-1 truncate text-muted-foreground">{cat.name}</span>
                        <span className="font-medium">{cat.value}%</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Sales by Channel */}
            <div className="rounded-xl border border-border bg-card p-4 shadow-sm space-y-3">
              <div>
                <h3 className="text-sm font-semibold">Sales by Store</h3>
                <p className="text-xs text-muted-foreground">Revenue per channel</p>
              </div>
              {filteredChannelBreakdown.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-10">No store data for this period</p>
              ) : (
                <ResponsiveContainer width="100%" height={Math.max(160, filteredChannelBreakdown.length * 36)}>
                  <BarChart layout="vertical" data={filteredChannelBreakdown} margin={{ top: 0, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} className="stroke-border" />
                    <XAxis type="number" tick={{ fontSize: 10 }} tickLine={false} axisLine={false} tickFormatter={(v) => `$${(v / 1000).toFixed(0)}k`} />
                    <YAxis type="category" dataKey="channel" tick={{ fontSize: 11 }} tickLine={false} axisLine={false} width={90} />
                    <RechartsTooltip formatter={(v: number) => [`$${v.toLocaleString()}`, "Revenue"]} contentStyle={{ fontSize: 12 }} />
                    <Bar dataKey="revenue" fill="#0d9488" radius={[0, 4, 4, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          {/* Products table — live data */}
          <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
            <div className="px-4 py-3 bg-muted/30 border-b border-border flex items-center justify-between">
              <h3 className="text-sm font-semibold">
                Products
                {allBrandProducts.length > 0 && (
                  <span className="ml-1.5 text-xs font-normal text-muted-foreground">({allBrandProducts.length})</span>
                )}
              </h3>
              <button className="text-xs text-teal-600 hover:underline" onClick={() => setActiveTab("products")}>
                View all products →
              </button>
            </div>
            {analyticsData?.top_products.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-8">No sales data found for this period</p>
            ) : (
              <div className="divide-y divide-border">
                <div className="hidden sm:grid grid-cols-[2fr_1fr_80px_100px_80px] gap-3 px-4 py-2 bg-muted/20 text-xs font-medium text-muted-foreground">
                  <span>Product</span>
                  <span>Category</span>
                  <span>Orders</span>
                  <span>Revenue</span>
                  <span>Status</span>
                </div>
                {(analyticsData?.top_products ?? []).map((p) => (
                  <div key={p.name} className="grid grid-cols-1 sm:grid-cols-[2fr_1fr_80px_100px_80px] items-center gap-3 px-4 py-3">
                    <span className="text-sm font-medium">{p.name}</span>
                    <span className="text-xs text-muted-foreground hidden sm:block">{p.category ?? "—"}</span>
                    <span className="text-sm font-medium hidden sm:block">{p.orders}</span>
                    <span className="text-sm hidden sm:block">${p.revenue_usd.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
                    <div className="hidden sm:flex">
                      <ProductStatusBadge status={p.status} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Marketplace Performance card — most recent approved report */}
          <MarketplacePerformanceCard brandId={id} onViewAll={() => setActiveTab("marketplace-reports")} />

          {/* Marketplace Metrics section */}
          <MarketplaceMetricsSection brandId={id} />
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          MARKETPLACE REPORTS TAB
      ══════════════════════════════════════════════════════════════════════ */}
      {activeTab === "marketplace-reports" && (
        <MarketplaceReportsTab brandId={id} brandName={brand.name} />
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          LINKED ITEMS TAB
      ══════════════════════════════════════════════════════════════════════ */}
      {activeTab === "linked-items" && (
        <div className="space-y-4 pt-6">
          {brandItemsLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
              <Loader2 size={14} className="animate-spin" />
              Loading items…
            </div>
          ) : brandItems.length === 0 ? (
            <div className="rounded-lg border border-dashed border-border p-10 text-center space-y-3">
              <Package size={28} className="mx-auto text-muted-foreground" />
              <div>
                <p className="font-medium text-sm">No base items linked to this brand</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Base items appear here when they are used in product recipes for products belonging to this brand.
                </p>
              </div>
              <Link href="/base-items">
                <Button size="sm" variant="outline">Go to Base Items</Button>
              </Link>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="rounded-lg border border-border overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border bg-muted/50">
                      <th className="px-3 py-2 w-14" aria-label="Image" />
                      <th className="text-left px-3 py-2 font-medium text-muted-foreground whitespace-nowrap">Item Code</th>
                      <th className="text-left px-3 py-2 font-medium text-muted-foreground whitespace-nowrap">Item Name</th>
                      <th className="text-left px-3 py-2 font-medium text-muted-foreground whitespace-nowrap">Category</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {brandItems.map((item) => {
                      const categoryDisplay = item.main_category_name && item.sub_category_name && item.main_category_name !== item.sub_category_name
                        ? `${item.main_category_name} › ${item.sub_category_name}`
                        : (item.main_category_name || item.sub_category_name || "—");
                      const initial = item.name.trim().charAt(0).toUpperCase();
                      return (
                        <tr key={item.id} className="hover:bg-muted/30 transition-colors">
                          <td className="px-3 py-2">
                            {item.main_image_url ? (
                              <img
                                src={productImageUrl(item.main_image_url) ?? item.main_image_url}
                                alt={item.name}
                                className="w-10 h-10 rounded-md object-cover border border-border bg-muted flex-shrink-0"
                              />
                            ) : (
                              <div className="w-10 h-10 rounded-md bg-muted border border-border flex items-center justify-center flex-shrink-0">
                                <span className="text-xs font-semibold text-muted-foreground">{initial}</span>
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-2 font-mono text-xs">{item.code}</td>
                          <td className="px-3 py-2">
                            <Link href={`/base-items/${item.id}`} className="hover:underline font-medium">
                              {item.name}
                            </Link>
                          </td>
                          <td className="px-3 py-2 text-muted-foreground">{categoryDisplay}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-muted-foreground">{brandItems.length} item{brandItems.length !== 1 ? "s" : ""}</p>
            </div>
          )}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════════════════
          SHARED DIALOGS (all tabs)
      ══════════════════════════════════════════════════════════════════════ */}

      {/* Add Logo dialog */}
      <Dialog
        open={addLogoOpen}
        onOpenChange={(o) => { if (!o) { setAddLogoOpen(false); setAddLogoFile(null); setAddLogoLabel(""); if (addLogoPreview) URL.revokeObjectURL(addLogoPreview); setAddLogoPreview(null); setAddLogoError(null); } }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add logo</DialogTitle>
            <DialogDescription>Upload a square image (min 200 × 200 px). JPEG, PNG, or WebP.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="logo-label">Label <span className="text-muted-foreground font-normal">(optional)</span></Label>
              <Input id="logo-label" placeholder="e.g. Primary, Dark mode, Icon only…" value={addLogoLabel} onChange={(e) => setAddLogoLabel(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Image <span className="text-destructive">*</span></Label>
              <div
                className="border-2 border-dashed rounded-lg overflow-hidden cursor-pointer hover:border-primary/50 transition-colors"
                onClick={() => addLogoInputRef.current?.click()}
              >
                {addLogoPreview ? (
                  <div className="relative aspect-square w-full bg-secondary/30">
                    <img src={addLogoPreview} alt="Logo preview" className="w-full h-full object-contain" />
                  </div>
                ) : (
                  <div className="aspect-square flex flex-col items-center justify-center gap-2 text-muted-foreground">
                    <ImageIcon size={24} />
                    <span className="text-sm">Click to select image</span>
                  </div>
                )}
              </div>
              {addLogoError && <p className="text-xs text-destructive">{addLogoError}</p>}
              {addLogoFile && !addLogoError && <p className="text-xs text-green-600">Image looks good</p>}
              <input ref={addLogoInputRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) { handleAddLogoFile(f); e.target.value = ""; } }} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setAddLogoOpen(false); setAddLogoFile(null); setAddLogoLabel(""); if (addLogoPreview) URL.revokeObjectURL(addLogoPreview); setAddLogoPreview(null); setAddLogoError(null); }}>
              {t("common.cancel")}
            </Button>
            <Button onClick={() => addLogoMutation.mutate()} disabled={!addLogoFile || !!addLogoError || addLogoMutation.isPending}>
              {addLogoMutation.isPending ? t("brands.uploading") : "Add logo"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Add Cover Photo dialog */}
      <Dialog
        open={addCoverOpen}
        onOpenChange={(o) => { if (!o) { setAddCoverOpen(false); setCoverLabel(""); setCoverFile(null); } }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("brands.addCoverPhoto")}</DialogTitle>
            <DialogDescription>{t("brands.coverPhotoDesc", { name: brand.name })}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>{t("brands.label")}</Label>
              <Select value={coverLabel} onValueChange={setCoverLabel}>
                <SelectTrigger><SelectValue placeholder={t("brands.selectLabel")} /></SelectTrigger>
                <SelectContent>{COVER_LABELS.map((l) => <SelectItem key={l} value={l}>{l}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t("brands.photo")}</Label>
              <div className="border-2 border-dashed rounded-lg overflow-hidden cursor-pointer hover:border-primary/50 transition-colors" onClick={() => coverInputRef.current?.click()}>
                {coverFile ? (
                  <img src={URL.createObjectURL(coverFile)} alt={t("brands.photo")} className="w-full aspect-video object-cover" />
                ) : (
                  <div className="p-6 flex flex-col items-center gap-2 text-muted-foreground">
                    <ImagePlus size={24} />
                    <span className="text-sm">{t("brands.clickToSelectImage")}</span>
                  </div>
                )}
              </div>
              <input
                ref={coverInputRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) {
                    if (f.size > 25 * 1024 * 1024) {
                      toast({ variant: "destructive", title: t("brands.uploadFailed"), description: "Photo must be under 25 MB." });
                      e.target.value = "";
                      return;
                    }
                    setCoverFile(f);
                    e.target.value = "";
                  }
                }}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setAddCoverOpen(false); setCoverLabel(""); setCoverFile(null); }}>{t("common.cancel")}</Button>
            <Button onClick={() => addCoverMutation.mutate()} disabled={!coverLabel || !coverFile || addCoverMutation.isPending}>
              {addCoverMutation.isPending ? t("brands.uploading") : t("brands.addPhoto")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete cover photo */}
      <AlertDialog open={deleteCoverTarget !== null} onOpenChange={(o) => !o && setDeleteCoverTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("brands.deleteCoverPhotoTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("brands.deleteCoverPhotoLabelDesc", { label: deleteCoverTarget?.label ?? "" })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => deleteCoverTarget && deleteCoverMutation.mutate(deleteCoverTarget.id)}>
              {deleteCoverMutation.isPending ? t("common.deleting") : t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Sticker upload dialog */}
      <Dialog open={uploadOpen} onOpenChange={(o) => { if (!o) { setUploadOpen(false); setUploadName(""); setUploadFile(null); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("brands.uploadStickerTitle")}</DialogTitle>
            <DialogDescription>{t("brands.uploadStickerDesc", { name: brand.name })}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t("brands.stickerNameLabel")}</label>
              <Input placeholder={t("brands.stickerNameExample")} value={uploadName} onChange={(e) => setUploadName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">{t("brands.pdfFile")}</label>
              <div className="border-2 border-dashed rounded-lg p-6 text-center cursor-pointer hover:border-primary/50 transition-colors" onClick={() => fileInputRef.current?.click()}>
                {uploadFile ? <p className="text-sm font-medium">{uploadFile.name}</p> : <p className="text-sm text-muted-foreground">{t("brands.clickToSelectPdf")}</p>}
              </div>
              <input ref={fileInputRef} type="file" accept=".pdf,application/pdf" className="hidden" onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setUploadOpen(false); setUploadName(""); setUploadFile(null); }}>{t("common.cancel")}</Button>
            <Button onClick={() => uploadMutation.mutate()} disabled={!uploadFile || !uploadName.trim() || uploadMutation.isPending}>
              {uploadMutation.isPending ? t("brands.uploading") : t("brands.upload")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete card message */}
      <AlertDialog open={deleteCardMsgOpen} onOpenChange={(o) => !o && setDeleteCardMsgOpen(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("brands.removeCardMsgTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("brands.removeCardMsgDesc", { name: brand.name })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => deleteCardMsgMutation.mutate()} disabled={deleteCardMsgMutation.isPending}>
              {deleteCardMsgMutation.isPending ? t("brands.removing") : t("common.remove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Add Product dialog */}
      <Dialog open={addProductOpen} onOpenChange={(o) => !o && setAddProductOpen(false)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Add Product</DialogTitle>
            <DialogDescription>Add a new product to the <strong>{brand.name}</strong> brand.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="ap-name">Name <span className="text-destructive">*</span></Label>
              <Input id="ap-name" value={addProductForm.name} onChange={(e) => setAddProductForm((f) => ({ ...f, name: e.target.value }))} placeholder="e.g. Premium Gift Box" autoFocus />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="ap-usd">Price (USD) <span className="text-destructive">*</span></Label>
                <Input id="ap-usd" type="number" min="0" step="0.01" value={addProductForm.price_usd} onChange={(e) => setAddProductForm((f) => ({ ...f, price_usd: e.target.value }))} placeholder="0.00" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ap-aed">Price (AED) <span className="text-destructive">*</span></Label>
                <Input id="ap-aed" type="number" min="0" step="0.01" value={addProductForm.price_aed} onChange={(e) => setAddProductForm((f) => ({ ...f, price_aed: e.target.value }))} placeholder="0.00" />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="ap-disc-usd">Discount price (USD) <span className="text-muted-foreground text-xs">(optional)</span></Label>
                <Input id="ap-disc-usd" type="number" min="0" step="0.01" value={addProductForm.discount_price_usd} onChange={(e) => setAddProductForm((f) => ({ ...f, discount_price_usd: e.target.value }))} placeholder="0.00" className={addDiscountUsdError ? "border-destructive focus-visible:ring-destructive/30" : ""} />
                {addDiscountUsdError && <p className="text-xs text-destructive">{addDiscountUsdError}</p>}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ap-disc-aed">Discount price (AED) <span className="text-muted-foreground text-xs">(optional)</span></Label>
                <Input id="ap-disc-aed" type="number" min="0" step="0.01" value={addProductForm.discount_price_aed} onChange={(e) => setAddProductForm((f) => ({ ...f, discount_price_aed: e.target.value }))} placeholder="0.00" className={addDiscountAedError ? "border-destructive focus-visible:ring-destructive/30" : ""} />
                {addDiscountAedError && <p className="text-xs text-destructive">{addDiscountAedError}</p>}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Status <span className="text-destructive">*</span></Label>
              <Select value={addProductForm.status} onValueChange={(v) => setAddProductForm((f) => ({ ...f, status: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="available">Available</SelectItem>
                  <SelectItem value="out_of_stock">Out of Stock</SelectItem>
                  <SelectItem value="not_available">Not Available</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Category</Label>
              <CategoryCombobox lockedBrand={brand.name} value={addProductForm.category} onChange={(v) => setAddProductForm((f) => ({ ...f, category: v }))} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ap-desc">Description</Label>
              <Textarea id="ap-desc" value={addProductForm.description} onChange={(e) => setAddProductForm((f) => ({ ...f, description: e.target.value }))} placeholder="Optional description…" rows={2} />
            </div>
            <div className="space-y-1.5">
              <Label>Main Image</Label>
              {addProductForm.main_image_url ? (
                <div className="flex items-center gap-3">
                  <div className="relative w-20 h-20 rounded-md border border-border overflow-hidden shrink-0 bg-muted">
                    <WorkspaceImage src={`/api/storage${addProductForm.main_image_url}`} alt="" className="w-full h-full object-cover" />
                    <button type="button" onClick={() => setAddProductForm((f) => ({ ...f, main_image_url: null }))} className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-background/80 flex items-center justify-center hover:bg-background">
                      <X size={10} />
                    </button>
                  </div>
                  <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={() => addProductFileRef.current?.click()} disabled={addProductUploading}>Replace</Button>
                </div>
              ) : (
                <button type="button" onClick={() => addProductFileRef.current?.click()} disabled={addProductUploading} className="w-full border-2 border-dashed border-border rounded-lg h-24 flex flex-col items-center justify-center gap-2 hover:border-primary/50 hover:bg-secondary/30 transition-colors disabled:opacity-50">
                  {addProductUploading ? <Loader2 size={20} className="text-muted-foreground animate-spin" /> : <ImageIcon size={20} className="text-muted-foreground" />}
                  <span className="text-xs text-muted-foreground">{addProductUploading ? "Uploading…" : "Click to upload"}</span>
                </button>
              )}
              <input ref={addProductFileRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) { handleAddProductImageUpload(f); e.target.value = ""; } }} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddProductOpen(false)} disabled={addProductMutation.isPending}>Cancel</Button>
            <Button
              onClick={() => addProductMutation.mutate()}
              disabled={!addProductForm.name.trim() || !addProductForm.price_usd || !addProductForm.price_aed || isNaN(parseFloat(addProductForm.price_usd)) || isNaN(parseFloat(addProductForm.price_aed)) || addDiscountUsdError !== null || addDiscountAedError !== null || addProductMutation.isPending}
            >
              {addProductMutation.isPending ? "Adding…" : "Add Product"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete sticker */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("brands.deleteStickerByName", { name: deleteTarget?.name ?? "" })}</AlertDialogTitle>
            <AlertDialogDescription>{t("brands.deleteStickerConfirmDesc")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => deleteTarget && deleteStickerMutation.mutate(deleteTarget.id)}>
              {deleteStickerMutation.isPending ? t("common.deleting") : t("common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Move sticker */}
      <Dialog open={moveTarget !== null} onOpenChange={(o) => { if (!o) { setMoveTarget(null); setMoveToBrandId(""); } }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("brands.moveStickerTitle", { name: moveTarget?.name ?? "" })}</DialogTitle>
            <DialogDescription>{t("brands.moveStickerDesc")}</DialogDescription>
          </DialogHeader>
          <Select value={moveToBrandId} onValueChange={setMoveToBrandId}>
            <SelectTrigger><SelectValue placeholder={t("brands.selectBrand")} /></SelectTrigger>
            <SelectContent>
              {allBrands.filter((b) => b.id !== id).map((b) => (
                <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setMoveTarget(null); setMoveToBrandId(""); }}>{t("common.cancel")}</Button>
            <Button disabled={!moveToBrandId || moveStickerMutation.isPending} onClick={() => {
              if (moveTarget && moveToBrandId) moveStickerMutation.mutate({ sid: moveTarget.id, brandId: parseInt(moveToBrandId, 10) });
            }}>
              {moveStickerMutation.isPending ? <Loader2 size={14} className="animate-spin mr-1" /> : <ArrowRight size={14} className="mr-1" />}
              {t("brands.moveSticker")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete brand */}
      <AlertDialog open={deleteBrandOpen} onOpenChange={(o) => !o && setDeleteBrandOpen(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{brand.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently delete this brand. All associated logos and cover photos will be removed. Stickers must be reassigned first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={deleteBrandMutation.isPending} onClick={() => deleteBrandMutation.mutate()}>
              {deleteBrandMutation.isPending ? "Deleting…" : "Delete Brand"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Export image version picker */}
      <Dialog open={exportPickerOpen} onOpenChange={(o) => { if (!o) setExportPickerOpen(false); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Export Products</DialogTitle>
            <DialogDescription>
              Choose the image version to include in the exported ZIP.
            </DialogDescription>
          </DialogHeader>
          <RadioGroup
            value={selectedExportConfigId}
            onValueChange={setSelectedExportConfigId}
            className="space-y-1 py-1"
          >
            <Label
              htmlFor="export-original"
              className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5 cursor-pointer hover:bg-accent/50 transition-colors has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5"
            >
              <RadioGroupItem value="original" id="export-original" />
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <div className="w-8 h-8 rounded border border-border bg-muted flex items-center justify-center shrink-0">
                  <FileImage size={14} className="text-muted-foreground" />
                </div>
                <span className="text-sm font-medium">Original Image</span>
              </div>
            </Label>
            {exportConfigs.map((cfg) => {
              const ch = exportChannels.find((c) => c.id === cfg.channel_id) ?? {
                id: cfg.channel_id,
                name: cfg.channel_name,
                has_logo: false,
              };
              return (
                <Label
                  key={cfg.id}
                  htmlFor={`export-cfg-${cfg.id}`}
                  className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5 cursor-pointer hover:bg-accent/50 transition-colors has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5"
                >
                  <RadioGroupItem value={String(cfg.id)} id={`export-cfg-${cfg.id}`} />
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <ExportChannelLogoTile channel={ch} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{cfg.channel_name}</p>
                      <p className="text-xs text-muted-foreground">
                        {cfg.width_px} × {cfg.height_px} · {cfg.output_format.toUpperCase()}
                      </p>
                    </div>
                  </div>
                </Label>
              );
            })}
          </RadioGroup>
          {isExporting && (
            <div className="space-y-1.5 py-1">
              <Progress
                value={
                  exportProgress && exportProgress.total > 0
                    ? Math.min(100, Math.round((exportProgress.processed / exportProgress.total) * 100))
                    : undefined
                }
                className={exportProgress && exportProgress.total > 0 ? "" : "animate-pulse"}
              />
              <p className="text-xs text-muted-foreground text-center">
                {exportProgress && exportProgress.total > 0
                  ? `Resizing ${Math.min(exportProgress.processed, exportProgress.total)} of ${exportProgress.total} images…`
                  : "Preparing export…"}
              </p>
            </div>
          )}
          <DialogFooter className="gap-2">
            {isExporting ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => exportAbortRef.current?.abort()}
              >
                Cancel export
              </Button>
            ) : (
              <Button variant="ghost" size="sm" onClick={() => setExportPickerOpen(false)}>
                Cancel
              </Button>
            )}
            <Button
              size="sm"
              disabled={isExporting}
              className="gap-1.5"
              onClick={async () => {
                setIsExporting(true);
                setExportProgress({ processed: 0, total: 0 });
                const abortController = new AbortController();
                exportAbortRef.current = abortController;
                try {
                  const params = new URLSearchParams({ availability: productAvailabilityFilter });
                  if (selectedExportConfigId !== "original") {
                    params.set("channelConfigId", selectedExportConfigId);
                  }

                  // Stream progress over SSE (consumed via fetch so we can send a
                  // Bearer token — EventSource cannot set Authorization headers)
                  // while the server builds the ZIP, then download the finished
                  // ZIP via the one-time token it returns.
                  const authToken = await getClerkToken();
                  const progressRes = await fetch(
                    `/api/brands/${id}/products/export/progress?${params.toString()}`,
                    {
                      credentials: "include",
                      headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
                      signal: abortController.signal,
                    },
                  );
                  if (!progressRes.ok || !progressRes.body) {
                    throw new Error(`Export failed (HTTP ${progressRes.status})`);
                  }

                  let doneData: { token: string; filename: string } | null = null;
                  let streamError: string | null = null;

                  const handleSseEvent = (eventName: string, dataStr: string) => {
                    let parsed: unknown = null;
                    try {
                      parsed = dataStr ? JSON.parse(dataStr) : null;
                    } catch {
                      return;
                    }
                    if (eventName === "start") {
                      const d = parsed as { total?: number };
                      setExportProgress({ processed: 0, total: d?.total ?? 0 });
                    } else if (eventName === "progress") {
                      const d = parsed as { processed: number; total: number };
                      setExportProgress({ processed: d.processed, total: d.total });
                    } else if (eventName === "done") {
                      doneData = parsed as { token: string; filename: string };
                    } else if (eventName === "error") {
                      const d = parsed as { message?: string };
                      streamError = d?.message ?? "Export failed while building the ZIP.";
                    }
                  };

                  const reader = progressRes.body.getReader();
                  const decoder = new TextDecoder();
                  let buffer = "";
                  for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    let sep: number;
                    while ((sep = buffer.indexOf("\n\n")) !== -1) {
                      const rawEvent = buffer.slice(0, sep);
                      buffer = buffer.slice(sep + 2);
                      let eventName = "message";
                      let dataStr = "";
                      for (const line of rawEvent.split("\n")) {
                        if (line.startsWith("event:")) eventName = line.slice(6).trim();
                        else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
                      }
                      handleSseEvent(eventName, dataStr);
                    }
                  }

                  if (streamError) throw new Error(streamError);
                  if (!doneData) throw new Error("Export finished but returned an invalid response.");
                  const { token: downloadToken, filename } = doneData;

                  const res = await fetch(
                    `/api/brands/${id}/products/export/download/${downloadToken}`,
                    {
                      credentials: "include",
                      headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
                    },
                  );
                  if (!res.ok) throw new Error(`Export failed (HTTP ${res.status})`);
                  const blob = await res.blob();
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  const disposition = res.headers.get("Content-Disposition") ?? "";
                  const match = disposition.match(/filename="([^"]+)"/);
                  a.download = match?.[1] ?? filename ?? "products-export.zip";
                  document.body.appendChild(a);
                  a.click();
                  a.remove();
                  URL.revokeObjectURL(url);
                  setExportPickerOpen(false);
                } catch (err) {
                  // Aborts come from the user cancelling — not a real failure.
                  if ((err as Error).name !== "AbortError") {
                    toast({ variant: "destructive", title: "Export failed", description: (err as Error).message });
                  }
                } finally {
                  exportAbortRef.current = null;
                  setIsExporting(false);
                  setExportProgress(null);
                }
              }}
            >
              {isExporting ? <Loader2 size={13} className="animate-spin" /> : <Download size={13} />}
              {isExporting
                ? exportProgress && exportProgress.total > 0
                  ? `Resizing ${Math.min(exportProgress.processed, exportProgress.total)} of ${exportProgress.total}…`
                  : "Exporting…"
                : "Export"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cover Photo Lightbox */}
      <Dialog
        open={selectedCoverPhoto !== null}
        onOpenChange={(o) => { if (!o) { setSelectedCoverPhoto(null); setDownloadingOriginal(false); setDownloadingChannels(new Set()); } }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{selectedCoverPhoto?.label}</DialogTitle>
            <DialogDescription className="sr-only">Cover photo preview and download options</DialogDescription>
          </DialogHeader>
          {selectedCoverPhoto && (
            <div className="space-y-4">
              <div className="rounded-lg overflow-hidden bg-secondary/30">
                <WorkspaceImage src={`/api/brands/${id}/cover-photos/${selectedCoverPhoto.id}/image`} alt={selectedCoverPhoto.label} className="w-full object-contain max-h-[380px]" />
              </div>
              <div className="space-y-2">
                <Button variant="outline" className="w-full gap-2" onClick={() => downloadCoverOriginal(selectedCoverPhoto)} disabled={downloadingOriginal}>
                  {downloadingOriginal ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
                  Download original
                </Button>
                {coverPhotoChannels.length > 0 && (
                  <div className="space-y-1.5 pt-1">
                    <p className="text-sm font-medium text-muted-foreground">Download for channels</p>
                    {coverPhotoChannels.map((channel) => (
                      <Button key={channel.id} variant="outline" className="w-full gap-2 justify-start" onClick={() => downloadCoverForChannel(selectedCoverPhoto, channel)} disabled={downloadingChannels.has(channel.id)}>
                        {downloadingChannels.has(channel.id) ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />}
                        {channel.has_logo ? (
                          <WorkspaceImage src={`/api/channels/${channel.id}/logo`} alt={channel.name} className="h-5 w-5 rounded-sm object-contain shrink-0" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }} />
                        ) : null}
                        <span className="flex-1 text-left">{channel.name}</span>
                        <span className="text-xs text-muted-foreground">{channel.cover_photo_width}×{channel.cover_photo_height}</span>
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
