import { useEffect, useRef, useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiFetch } from "@/lib/queryClient";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { useUserPreference } from "@/hooks/use-user-preference";
import {
  getListMarketplaceBrandAliasesQueryKey,
} from "@workspace/api-client-react";
import { BrandAliasesView } from "./BrandAliasesPage";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { WorkspaceImage } from "@/components/WorkspaceImage";
import { useToast } from "@/hooks/use-toast";
import {
  Plus,
  Pencil,
  Trash2,
  Tag,
  ImageIcon,
  X,
  TriangleAlert,
  LayoutGrid,
  LayoutList,
  Search,
  MoreHorizontal,
  SlidersHorizontal,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { checkNameWarning } from "@/lib/nameWarning";

type BrandsView = "list" | "gallery";
type BrandsTab = "brands" | "statement-aliases";

type SortOption = "name-asc" | "name-desc" | "newest" | "oldest" | "sticker-asc" | "sticker-desc";
type FilterOption = "all" | "has-stickers" | "no-stickers" | "has-target" | "missing-target";

const PAGE_SIZE = 10;

function getBrandsTabFromUrl(): BrandsTab {
  if (typeof window !== "undefined") {
    const tab = new URLSearchParams(window.location.search).get("tab");
    if (tab === "statement-aliases") return tab;
  }
  return "brands";
}

type Brand = {
  id: number;
  name: string;
  description: string | null;
  target_cogs: string | null;
  created_at: string;
  updated_at: string | null;
  sticker_count: string;
  product_count: string;
  has_logo: boolean;
  failed_import_count?: number;
};

type LogoState = {
  file: File;
  preview: string;
  error: string | null;
};

function validateLogoImage(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      if (img.naturalWidth !== img.naturalHeight) {
        resolve("Logo must be square (width must equal height).");
        return;
      }
      if (img.naturalWidth < 200) {
        resolve(`Logo must be at least 200 × 200 px (yours is ${img.naturalWidth} × ${img.naturalHeight}).`);
        return;
      }
      resolve(null);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve("Could not read the image file.");
    };
    img.src = url;
  });
}

function LogoPicker({
  logo,
  onChange,
}: {
  logo: LogoState | null;
  onChange: (logo: LogoState | null) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = async (file: File) => {
    if (!file.type.startsWith("image/")) {
      onChange({ file, preview: "", error: "Please select a JPEG, PNG, or WebP image." });
      return;
    }
    const preview = URL.createObjectURL(file);
    const error = await validateLogoImage(file);
    onChange({ file, preview, error });
  };

  return (
    <div className="space-y-2">
      <Label>Logo <span className="text-destructive">*</span></Label>
      <p className="text-xs text-muted-foreground">
        Square image, minimum 300 × 300 px. JPEG, PNG, or WebP.
      </p>

      {logo ? (
        <div className="flex items-start gap-3">
          <div className="relative w-20 h-20 rounded-md border border-border overflow-hidden shrink-0 bg-muted">
            {logo.preview && (
              <img
                src={logo.preview}
                alt="Logo preview"
                className="w-full h-full object-cover"
              />
            )}
            <button
              type="button"
              onClick={() => { onChange(null); if (inputRef.current) inputRef.current.value = ""; }}
              className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-background/80 flex items-center justify-center hover:bg-background"
            >
              <X size={10} />
            </button>
          </div>
          <div className="flex-1 min-w-0 pt-1">
            <p className="text-sm font-medium truncate">{logo.file.name}</p>
            {logo.error ? (
              <p className="text-xs text-destructive mt-1">{logo.error}</p>
            ) : (
              <p className="text-xs text-green-600 mt-1">Image looks good</p>
            )}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2 h-7 text-xs"
              onClick={() => inputRef.current?.click()}
            >
              Replace
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex justify-center">
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="aspect-square w-40 border-2 border-dashed border-border rounded-lg flex flex-col items-center justify-center gap-2 hover:border-primary/50 hover:bg-secondary/30 transition-colors"
          >
            <ImageIcon size={24} className="text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Click to select logo</span>
          </button>
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFile(file);
        }}
      />
    </div>
  );
}

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

function exportBrandsToCSV(brandsToExport: Brand[], filename: string) {
  const headers = ["Brand name", "Sticker count", "Product count", "Target audience", "Last Updated"];
  const rows = brandsToExport.map((b) => [
    b.name,
    b.sticker_count,
    b.product_count,
    b.target_cogs !== null ? `${parseFloat(b.target_cogs).toFixed(0)}%` : "",
    formatDate(b.updated_at ?? b.created_at),
  ]);

  const escapeCsv = (val: string) => {
    const str = String(val);
    if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const csv = [headers, ...rows]
    .map((row) => row.map(escapeCsv).join(","))
    .join("\r\n");

  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function BrandsPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { isOwner, realIsOwner, role, allowedPages } = useWorkspaceRole();
  const canManageAliases = realIsOwner === undefined ? isOwner : realIsOwner;
  const [selectedTab, setSelectedTab] = useState<BrandsTab>(getBrandsTabFromUrl);
  const aliasesQuery = useQuery({
    queryKey: getListMarketplaceBrandAliasesQueryKey(),
    queryFn: () => apiFetch<{ aliases: unknown[] }>("/api/marketplace-brand-aliases"),
    enabled: canManageAliases,
  });
  const aliasCount = aliasesQuery.data?.aliases.length ?? 0;

  useEffect(() => {
    if (!canManageAliases && selectedTab !== "brands") {
      setSelectedTab("brands");
      if (typeof window !== "undefined") {
        const params = new URLSearchParams(window.location.search);
        params.delete("tab");
        const query = params.toString();
        window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
      }
    }
  }, [canManageAliases, selectedTab]);

  function selectTab(tab: string) {
    if (tab !== "brands" && tab !== "statement-aliases") return;
    if (tab === "statement-aliases" && !canManageAliases) return;
    setSelectedTab(tab);
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      if (tab === "brands") params.delete("tab");
      else params.set("tab", tab);
      const query = params.toString();
      window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
    }
  }
  const canManageBrand =
    isOwner ||
    role === "designer" ||
    (allowedPages?.includes("brands.manage") ?? false);
  const canCreateBrand = canManageBrand || (allowedPages?.includes("brands.create") ?? false);
  const canEditBrand = canManageBrand || (allowedPages?.includes("brands.edit") ?? false);
  const canDeleteBrand =
    isOwner ||
    role === "designer" ||
    (allowedPages?.includes("brands.delete") ?? false);

  const { data, isLoading } = useQuery({
    queryKey: ["brands"],
    queryFn: () => apiFetch<{ brands: Brand[]; workspaceJobCount: number }>("/api/brands"),
  });
  const brands = data?.brands ?? [];
  const workspaceJobCount = data?.workspaceJobCount ?? 0;

  // ─── create ───────────────────────────────────────────────────────────────
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [createTargetCogs, setCreateTargetCogs] = useState("");
  const [createLogo, setCreateLogo] = useState<LogoState | null>(null);
  const [createNameServerError, setCreateNameServerError] = useState<string | null>(null);

  const canCreate = createName.trim().length > 0 && createLogo !== null && !createLogo.error;
  const createNameWarning = checkNameWarning(createName, brands.map((b) => b.name));

  const createMutation = useMutation({
    mutationFn: () => {
      const fd = new FormData();
      fd.append("name", createName.trim());
      fd.append("logo", createLogo!.file);
      if (createDescription.trim()) fd.append("description", createDescription.trim());
      if (createTargetCogs !== "") fd.append("target_cogs", createTargetCogs);
      return fetch("/api/brands", {
        method: "POST",
        body: fd,
        credentials: "include",
      }).then(async (r) => {
        const json = await r.json();
        if (!r.ok) {
          const err = new Error(json.error ?? "Failed to create brand") as Error & { status: number };
          err.status = r.status;
          throw err;
        }
        return json as { brand: Brand };
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["brands"] });
      toast({ title: "Brand created" });
      setCreateOpen(false);
      setCreateName("");
      setCreateDescription("");
      setCreateTargetCogs("");
      setCreateLogo(null);
      setCreateNameServerError(null);
    },
    onError: (err: Error & { status?: number }) => {
      if (err.status === 409) {
        setCreateNameServerError("A brand with this name already exists");
      } else {
        toast({ variant: "destructive", title: "Failed to create brand", description: err.message });
      }
    },
  });

  const handleCloseCreate = () => {
    setCreateOpen(false);
    setCreateName("");
    setCreateDescription("");
    setCreateTargetCogs("");
    setCreateLogo(null);
    setCreateNameServerError(null);
  };

  // ─── rename ───────────────────────────────────────────────────────────────
  const [renameTarget, setRenameTarget] = useState<Brand | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameNameServerError, setRenameNameServerError] = useState<string | null>(null);

  const renameMutation = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) =>
      apiFetch(`/api/brands/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["brands"] });
      toast({ title: "Brand renamed" });
      setRenameTarget(null);
      setRenameNameServerError(null);
    },
    onError: (err: Error & { status?: number }) => {
      if (err.status === 409) {
        setRenameNameServerError("A brand with this name already exists");
      } else {
        toast({ variant: "destructive", title: "Rename failed", description: err.message });
      }
    },
  });

  // ─── delete ───────────────────────────────────────────────────────────────
  const [deleteTarget, setDeleteTarget] = useState<Brand | null>(null);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/api/brands/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["brands"] });
      setDeleteTarget(null);
      toast({ title: "Brand deleted" });
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", title: "Delete failed", description: err.message });
      setDeleteTarget(null);
    },
  });

  // ─── search ───────────────────────────────────────────────────────────────
  const [search, setSearch] = useState("");
  const trimmedSearch = search.trim().toLowerCase();

  // ─── sort & filter ───────────────────────────────────────────────────────
  const [sortBy, setSortBy] = useState<SortOption>("name-asc");
  const [filterBy, setFilterBy] = useState<FilterOption>("all");

  // ─── bulk selection ──────────────────────────────────────────────────────
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  // ─── pagination ──────────────────────────────────────────────────────────
  const [currentPage, setCurrentPage] = useState(1);

  useEffect(() => {
    setCurrentPage(1);
  }, [search, sortBy, filterBy]);

  // ─── view toggle (list / gallery) ─────────────────────────────────────────
  // Start from URL param if present, otherwise wait for server preference.
  const [view, setViewState] = useState<BrandsView>(() => {
    if (typeof window === "undefined") return "list";
    try {
      const urlParam = new URLSearchParams(window.location.search).get("view");
      if (urlParam === "gallery" || urlParam === "list") return urlParam;
    } catch { /* ignore */ }
    return "list";
  });

  const { value: viewPref, set: setViewPref, loaded: viewPrefLoaded } =
    useUserPreference<BrandsView>("brands_view_mode", "list");

  // Apply server preference once on first load (URL param always takes precedence).
  const viewPrefApplied = useRef(false);
  useEffect(() => {
    if (!viewPrefLoaded || viewPrefApplied.current) return;
    viewPrefApplied.current = true;
    try {
      const urlParam = new URLSearchParams(window.location.search).get("view");
      if (urlParam === "gallery" || urlParam === "list") return; // URL takes precedence
    } catch { /* ignore */ }
    setViewState(viewPref);
  }, [viewPrefLoaded, viewPref]);

  function setView(v: BrandsView) {
    setViewState(v);
    setViewPref(v);
  }

  const isProjectManager = allowedPages?.includes("project-manager-dashboard") ?? false;

  const renderCountLabel = (brand: Brand) => {
    const count = isProjectManager
      ? parseInt(brand.product_count, 10)
      : parseInt(brand.sticker_count, 10);
    return isProjectManager
      ? t(count === 1 ? "brands.productCount_one" : "brands.productCount_other", { count })
      : t(count === 1 ? "brands.stickerCount_one" : "brands.stickerCount_other", { count });
  };

  // ─── list-view derived list (full sort + filter + pagination) ───────────
  let filteredBrands = brands.slice();

  if (trimmedSearch) {
    filteredBrands = filteredBrands.filter((b) => b.name.toLowerCase().includes(trimmedSearch));
  }

  if (filterBy === "has-stickers") {
    filteredBrands = filteredBrands.filter((b) => parseInt(b.sticker_count, 10) > 0);
  } else if (filterBy === "no-stickers") {
    filteredBrands = filteredBrands.filter((b) => parseInt(b.sticker_count, 10) === 0);
  } else if (filterBy === "has-target") {
    filteredBrands = filteredBrands.filter((b) => b.target_cogs !== null);
  } else if (filterBy === "missing-target") {
    filteredBrands = filteredBrands.filter((b) => b.target_cogs === null);
  }

  filteredBrands.sort((a, b) => {
    switch (sortBy) {
      case "name-asc": return a.name.localeCompare(b.name);
      case "name-desc": return b.name.localeCompare(a.name);
      case "newest": return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      case "oldest": return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
      case "sticker-asc": return parseInt(a.sticker_count, 10) - parseInt(b.sticker_count, 10);
      case "sticker-desc": return parseInt(b.sticker_count, 10) - parseInt(a.sticker_count, 10);
      default: return 0;
    }
  });

  const totalPages = Math.max(1, Math.ceil(filteredBrands.length / PAGE_SIZE));
  const safePage = Math.min(currentPage, totalPages);
  const pagedBrands = filteredBrands.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  // ─── gallery-view derived list (search only, name A–Z, no sort/filter) ──
  let galleryBrands = brands.slice();
  if (trimmedSearch) {
    galleryBrands = galleryBrands.filter((b) => b.name.toLowerCase().includes(trimmedSearch));
  }
  galleryBrands.sort((a, b) => a.name.localeCompare(b.name));

  const isListFiltering = trimmedSearch.length > 0 || filterBy !== "all";
  const isGalleryFiltering = trimmedSearch.length > 0;
  const isFiltering = view === "list" ? isListFiltering : isGalleryFiltering;
  const visibleCount = view === "list" ? filteredBrands.length : galleryBrands.length;

  const showToolbar = !isLoading && brands.length > 0;

  // ─── bulk helpers ─────────────────────────────────────────────────────────
  const pageIds = pagedBrands.map((b) => b.id);
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));
  const somePageSelected = pageIds.some((id) => selectedIds.has(id));

  const togglePageSelection = () => {
    if (allPageSelected) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        pageIds.forEach((id) => next.delete(id));
        return next;
      });
    } else {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        pageIds.forEach((id) => next.add(id));
        return next;
      });
    }
  };

  const toggleRow = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleBulkDelete = async () => {
    const ids = Array.from(selectedIds);
    try {
      await Promise.all(ids.map((id) => deleteMutation.mutateAsync(id)));
      setSelectedIds(new Set());
      setBulkDeleteOpen(false);
      qc.invalidateQueries({ queryKey: ["brands"] });
      toast({ title: `${ids.length} brand${ids.length === 1 ? "" : "s"} deleted` });
    } catch {
      // individual errors handled by deleteMutation.onError
    }
  };

  // ─── actions for gallery view (unchanged) ─────────────────────────────────
  const renderGalleryActions = (brand: Brand) => (
    <>
      {canEditBrand && (
        <Button
          size="sm"
          variant="ghost"
          className="h-10 w-10 p-0"
          onClick={() => {
            setRenameTarget(brand);
            setRenameValue(brand.name);
          }}
          title="Rename"
          data-testid={`button-rename-brand-${brand.id}`}
        >
          <Pencil size={16} />
        </Button>
      )}
      {canDeleteBrand && (
        <Button
          size="sm"
          variant="ghost"
          className="h-10 w-10 p-0 text-destructive hover:text-destructive"
          onClick={() => setDeleteTarget(brand)}
          title="Delete"
          data-testid={`button-delete-brand-${brand.id}`}
        >
          <Trash2 size={16} />
        </Button>
      )}
    </>
  );

  // ─── page number buttons ──────────────────────────────────────────────────
  const getPageNumbers = () => {
    if (totalPages <= 5) return Array.from({ length: totalPages }, (_, i) => i + 1);
    const pages: number[] = [];
    pages.push(1);
    if (safePage > 3) pages.push(-1);
    for (let p = Math.max(2, safePage - 1); p <= Math.min(totalPages - 1, safePage + 1); p++) {
      pages.push(p);
    }
    if (safePage < totalPages - 2) pages.push(-1);
    pages.push(totalPages);
    return pages;
  };

  return (
    <div>
      <Tabs value={selectedTab} onValueChange={selectTab}>
        <TabsList className="w-full justify-start overflow-x-auto">
          <TabsTrigger value="brands" data-testid="brands-tab">
            Brands
            <span className="ml-1.5 text-xs text-muted-foreground">{brands.length}</span>
          </TabsTrigger>
          {canManageAliases && (
            <TabsTrigger value="statement-aliases" data-testid="statement-aliases-tab">
              Statement Aliases
              <span className="ml-1.5 text-xs text-muted-foreground">{aliasCount}</span>
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent value="brands" className="mt-6">
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t("brands.title")}</h1>
          <p className="text-muted-foreground mt-2">
            {t("brands.description")}
          </p>
        </div>
        {canCreateBrand && (
          <Button onClick={() => { setCreateName(""); setCreateDescription(""); setCreateTargetCogs(""); setCreateLogo(null); setCreateOpen(true); }}>
            <Plus size={16} className="mr-2" />
            {t("brands.newBrand")}
          </Button>
        )}
      </div>

      {showToolbar && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p
            className="text-sm text-muted-foreground"
            data-testid="brands-count"
          >
            {isFiltering
              ? `${visibleCount} of ${brands.length} brands`
              : brands.length === 1
              ? "1 brand"
              : `${brands.length} brands`}
          </p>
          <div className="flex flex-wrap items-center gap-2 flex-1 justify-end">
            {brands.length > 1 && (
              <div className="relative min-w-[180px] max-w-xs">
                <Search
                  size={14}
                  className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none"
                />
                <Input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Search brands..."
                  className="h-9 pl-8 pr-8"
                  aria-label="Search brands"
                  data-testid="brands-search-input"
                />
                {search.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setSearch("")}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 inline-flex items-center justify-center h-6 w-6 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                    aria-label="Clear search"
                    data-testid="brands-search-clear"
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
            )}
            {view === "list" && (
              <>
                <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortOption)}>
                  <SelectTrigger className="h-9 w-[160px]" aria-label="Sort brands">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="name-asc">Name A–Z</SelectItem>
                    <SelectItem value="name-desc">Name Z–A</SelectItem>
                    <SelectItem value="newest">Newest</SelectItem>
                    <SelectItem value="oldest">Oldest</SelectItem>
                    <SelectItem value="sticker-asc">Sticker count ↑</SelectItem>
                    <SelectItem value="sticker-desc">Sticker count ↓</SelectItem>
                  </SelectContent>
                </Select>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant={filterBy !== "all" ? "secondary" : "outline"}
                      size="sm"
                      className="h-9 gap-1.5"
                      aria-label="Filter brands"
                    >
                      <SlidersHorizontal size={14} />
                      Filter
                      {filterBy !== "all" && (
                        <span className="ml-0.5 inline-flex h-4 w-4 items-center justify-center rounded-full bg-primary text-primary-foreground text-[10px] font-medium">
                          1
                        </span>
                      )}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-44">
                    {(["all", "has-stickers", "no-stickers", "has-target", "missing-target"] as FilterOption[]).map((opt) => (
                      <DropdownMenuItem
                        key={opt}
                        onClick={() => setFilterBy(opt)}
                        className={filterBy === opt ? "bg-secondary" : ""}
                      >
                        {opt === "all" && "All"}
                        {opt === "has-stickers" && "Has stickers"}
                        {opt === "no-stickers" && "No stickers"}
                        {opt === "has-target" && "Has target"}
                        {opt === "missing-target" && "Missing target"}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              <Button
                variant="outline"
                size="sm"
                className="h-9 gap-1.5"
                aria-label="Export all visible brands"
                onClick={() => {
                  exportBrandsToCSV(filteredBrands, "brands-export.csv");
                }}
              >
                Export
              </Button>
              </>
            )}
            <ToggleGroup
              type="single"
              value={view}
              onValueChange={(v) => { if (v === "list" || v === "gallery") setView(v); }}
              variant="outline"
              size="sm"
              aria-label="Brands view"
              data-testid="brands-view-toggle"
            >
              <ToggleGroupItem
                value="list"
                aria-label="List view"
                data-testid="brands-view-toggle-list"
              >
                <LayoutList size={14} className="mr-1.5" />
                List
              </ToggleGroupItem>
              <ToggleGroupItem
                value="gallery"
                aria-label="Gallery view"
                data-testid="brands-view-toggle-gallery"
              >
                <LayoutGrid size={14} className="mr-1.5" />
                Gallery
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="text-sm text-muted-foreground">{t("common.loading")}</div>
      ) : brands.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-12 text-center">
          <Tag size={32} className="mx-auto mb-3 text-muted-foreground" />
          <p className="font-medium">{t("brands.noBrandsTitle")}</p>
          <p className="text-sm text-muted-foreground mt-1">
            {t("brands.noBrandsDesc")}
          </p>
          {canCreateBrand && (
            <Button className="mt-4" onClick={() => { setCreateName(""); setCreateDescription(""); setCreateTargetCogs(""); setCreateLogo(null); setCreateOpen(true); }}>
              <Plus size={16} className="mr-2" />
              {t("brands.newBrand")}
            </Button>
          )}
        </div>
      ) : isFiltering && visibleCount === 0 ? (
        <div
          className="rounded-lg border border-dashed border-border p-12 text-center"
          data-testid="brands-no-search-results"
        >
          <Search size={32} className="mx-auto mb-3 text-muted-foreground" />
          <p className="font-medium">No matching brands</p>
          <p className="text-sm text-muted-foreground mt-1">
            {view === "list" ? "Try a different name or adjust the filters." : "Try a different name."}
          </p>
          <Button
            variant="outline"
            className="mt-4"
            onClick={() => { setSearch(""); setFilterBy("all"); }}
          >
            {view === "list" ? "Clear search and filters" : "Clear search"}
          </Button>
        </div>
      ) : view === "list" ? (
        <div className="space-y-3">
          {selectedIds.size > 0 && (
            <div className="flex items-center gap-3 rounded-lg border border-border bg-secondary/50 px-4 py-2.5">
              <span className="text-sm font-medium">
                {selectedIds.size} selected
              </span>
              <div className="flex items-center gap-2 ml-auto">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs"
                  onClick={() => {
                    const brandsToExport = brands.filter((b) => selectedIds.has(b.id));
                    exportBrandsToCSV(brandsToExport, "brands-export.csv");
                  }}
                >
                  Export selected
                </Button>
                {canDeleteBrand && (
                  <Button
                    size="sm"
                    variant="destructive"
                    className="h-8 text-xs"
                    onClick={() => setBulkDeleteOpen(true)}
                  >
                    <Trash2 size={12} className="mr-1.5" />
                    Delete selected
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-8 text-xs"
                  onClick={() => setSelectedIds(new Set())}
                >
                  <X size={12} className="mr-1" />
                  Clear selection
                </Button>
              </div>
            </div>
          )}

          <div className="rounded-lg border border-border overflow-hidden" data-testid="brands-list">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40">
                  <th className="w-10 px-3 py-3 text-left">
                    <Checkbox
                      checked={allPageSelected}
                      data-state={somePageSelected && !allPageSelected ? "indeterminate" : undefined}
                      onCheckedChange={togglePageSelection}
                      aria-label="Select all on page"
                    />
                  </th>
                  <th className="px-3 py-3 text-left font-medium text-muted-foreground">Brand</th>
                  <th className="px-3 py-3 text-left font-medium text-muted-foreground hidden sm:table-cell">
                    {isProjectManager ? "Products" : "Stickers"}
                  </th>
                  <th className="px-3 py-3 text-left font-medium text-muted-foreground hidden md:table-cell">Target</th>
                  <th className="px-3 py-3 text-left font-medium text-muted-foreground hidden lg:table-cell">Last Updated</th>
                  <th className="px-3 py-3 text-right font-medium text-muted-foreground">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {pagedBrands.map((brand) => (
                  <tr
                    key={brand.id}
                    className="hover:bg-secondary/30 transition-colors"
                    data-testid={`brand-row-${brand.id}`}
                  >
                    <td className="w-10 px-3 py-3">
                      <Checkbox
                        checked={selectedIds.has(brand.id)}
                        onCheckedChange={() => toggleRow(brand.id)}
                        aria-label={`Select ${brand.name}`}
                      />
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-md border border-border overflow-hidden shrink-0 bg-muted flex items-center justify-center">
                          {brand.has_logo ? (
                            <WorkspaceImage
                              src={`/api/brands/${brand.id}/logo`}
                              alt={brand.name}
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <Tag size={16} className="text-muted-foreground" />
                          )}
                        </div>
                        <div className="min-w-0">
                          <Link
                            href={`/brands/${brand.id}`}
                            className="font-medium hover:text-primary transition-colors truncate block"
                          >
                            {brand.name}
                          </Link>
                          <div className="flex flex-wrap items-center gap-1 mt-0.5">
                            {brand.target_cogs !== null && workspaceJobCount > 0 && (
                              <span
                                className="inline-flex items-center gap-1 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400 px-1.5 py-0.5 text-[10px] font-medium leading-none"
                                title={`COGS target: ${parseFloat(brand.target_cogs).toFixed(1)}% — review costs`}
                              >
                                <TriangleAlert size={9} />
                                COGS
                              </span>
                            )}
                            {(brand.failed_import_count ?? 0) > 0 && (
                              <Link
                                href={`/brands/${brand.id}?tab=marketplace-reports`}
                                className="inline-flex items-center gap-1 rounded-full bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400 px-1.5 py-0.5 text-[10px] font-medium leading-none hover:bg-red-200 dark:hover:bg-red-900/60 transition-colors"
                                title={`${brand.failed_import_count} import${brand.failed_import_count === 1 ? "" : "s"} need attention — click to review`}
                                onClick={(e) => e.stopPropagation()}
                              >
                                <TriangleAlert size={9} />
                                {brand.failed_import_count} import{brand.failed_import_count === 1 ? "" : "s"}
                              </Link>
                            )}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-3 text-muted-foreground hidden sm:table-cell">
                      {renderCountLabel(brand)}
                    </td>
                    <td className="px-3 py-3 text-muted-foreground hidden md:table-cell">
                      {brand.target_cogs !== null
                        ? `${parseFloat(brand.target_cogs).toFixed(0)}%`
                        : "—"}
                    </td>
                    <td className="px-3 py-3 text-muted-foreground hidden lg:table-cell">
                      <span title={formatDate(brand.updated_at ?? brand.created_at)}>
                        {formatRelativeTime(brand.updated_at ?? brand.created_at)}
                      </span>
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <Link href={`/brands/${brand.id}`}>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-8 px-2.5 text-xs hidden sm:inline-flex"
                          >
                            View
                          </Button>
                        </Link>
                        {canEditBrand && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-8 w-8 p-0"
                            onClick={() => {
                              setRenameTarget(brand);
                              setRenameValue(brand.name);
                            }}
                            title="Rename"
                            data-testid={`button-rename-brand-${brand.id}`}
                          >
                            <Pencil size={14} />
                          </Button>
                        )}
                        {canDeleteBrand && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-8 w-8 p-0"
                                title="More actions"
                              >
                                <MoreHorizontal size={14} />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                className="text-destructive focus:text-destructive"
                                onClick={() => setDeleteTarget(brand)}
                                data-testid={`button-delete-brand-${brand.id}`}
                              >
                                <Trash2 size={14} className="mr-2" />
                                Delete
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-between pt-1">
              <p className="text-xs text-muted-foreground">
                Showing {(safePage - 1) * PAGE_SIZE + 1}–{Math.min(safePage * PAGE_SIZE, filteredBrands.length)} of {filteredBrands.length} brands
              </p>
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 w-8 p-0"
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  disabled={safePage === 1}
                  aria-label="Previous page"
                >
                  <ChevronLeft size={14} />
                </Button>
                {getPageNumbers().map((p, i) =>
                  p === -1 ? (
                    <span key={`ellipsis-${i}`} className="px-1 text-muted-foreground text-sm">…</span>
                  ) : (
                    <Button
                      key={p}
                      size="sm"
                      variant={p === safePage ? "default" : "outline"}
                      className="h-8 w-8 p-0 text-xs"
                      onClick={() => setCurrentPage(p)}
                      aria-label={`Page ${p}`}
                    >
                      {p}
                    </Button>
                  )
                )}
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 w-8 p-0"
                  onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                  disabled={safePage === totalPages}
                  aria-label="Next page"
                >
                  <ChevronRight size={14} />
                </Button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4"
          data-testid="brands-gallery"
        >
          {galleryBrands.map((brand) => (
            <div
              key={brand.id}
              className="group flex flex-col rounded-lg border border-border bg-background overflow-hidden hover:bg-secondary/40 hover:border-border/80 transition-colors"
              data-testid={`brand-card-${brand.id}`}
            >
              <Link
                href={`/brands/${brand.id}`}
                className="block aspect-square w-full bg-muted relative overflow-hidden"
                aria-label={`Open ${brand.name}`}
              >
                {brand.has_logo ? (
                  <WorkspaceImage
                    src={`/api/brands/${brand.id}/logo`}
                    alt={brand.name}
                    className="w-full h-full object-cover transition-transform group-hover:scale-[1.02]"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <Tag size={48} className="text-muted-foreground" />
                  </div>
                )}
              </Link>
              <div className="flex items-start gap-2 p-3">
                <Link
                  href={`/brands/${brand.id}`}
                  className="flex-1 min-w-0 group/link"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <p className="font-medium text-base group-hover/link:text-primary transition-colors truncate">
                      {brand.name}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-1 mt-0.5">
                    {brand.target_cogs !== null && workspaceJobCount > 0 && (
                      <span
                        className="inline-flex items-center gap-1 shrink-0 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-400 px-1.5 py-0.5 text-[10px] font-medium leading-none"
                        title={`COGS target: ${parseFloat(brand.target_cogs).toFixed(1)}% — review costs`}
                      >
                        <TriangleAlert size={9} />
                        COGS
                      </span>
                    )}
                    {(brand.failed_import_count ?? 0) > 0 && (
                      <Link
                        href={`/brands/${brand.id}?tab=marketplace-reports`}
                        className="inline-flex items-center gap-1 shrink-0 rounded-full bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400 px-1.5 py-0.5 text-[10px] font-medium leading-none hover:bg-red-200 dark:hover:bg-red-900/60 transition-colors"
                        title={`${brand.failed_import_count} import${brand.failed_import_count === 1 ? "" : "s"} need attention — click to review`}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <TriangleAlert size={9} />
                        {brand.failed_import_count} import{brand.failed_import_count === 1 ? "" : "s"}
                      </Link>
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground mt-0.5 truncate">
                    {renderCountLabel(brand)}
                  </p>
                  <p
                    className="text-xs text-muted-foreground/70 mt-0.5 truncate"
                    title={formatDate(brand.updated_at ?? brand.created_at)}
                  >
                    Updated {formatRelativeTime(brand.updated_at ?? brand.created_at)}
                  </p>
                </Link>
                <div className="flex items-center gap-0.5 shrink-0 -mr-1.5 -mt-1">
                  <Link
                    href={`/brands/${brand.id}`}
                    aria-label={`Open ${brand.name}`}
                    title="Open"
                    className="inline-flex items-center justify-center h-8 w-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
                    data-testid={`button-open-brand-${brand.id}`}
                  >
                    <ChevronRight size={16} />
                  </Link>
                  {renderGalleryActions(brand)}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Create dialog ── */}
      <Dialog open={createOpen} onOpenChange={(o) => { if (!o) handleCloseCreate(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New Brand</DialogTitle>
            <DialogDescription>Give your brand a name and upload a square logo.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="brand-name">Brand name <span className="text-destructive">*</span></Label>
              <Input
                id="brand-name"
                placeholder="e.g. Acme Co."
                value={createName}
                onChange={(e) => { setCreateName(e.target.value); setCreateNameServerError(null); }}
                autoFocus
              />
              {createName.length > 0 && createName.trim().length === 0 && (
                <p className="text-xs text-destructive" data-testid="name-error-whitespace">
                  Brand name cannot be blank.
                </p>
              )}
              {createNameServerError && (
                <p className="text-xs text-destructive" data-testid="name-error-duplicate">
                  {createNameServerError}
                </p>
              )}
              {!createNameServerError && createNameWarning.exactMatch && (
                <p className="text-xs text-amber-600 dark:text-amber-400" data-testid="name-warning-exact">
                  A brand named &ldquo;{createNameWarning.exactMatch}&rdquo; already exists.
                </p>
              )}
              {!createNameServerError && !createNameWarning.exactMatch && createNameWarning.similarMatches.length > 0 && (
                <p className="text-xs text-amber-600 dark:text-amber-400" data-testid="name-warning-similar">
                  Similar brand names already exist: {createNameWarning.similarMatches.join(", ")}.
                </p>
              )}
            </div>
            <LogoPicker logo={createLogo} onChange={setCreateLogo} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={handleCloseCreate}>
              Cancel
            </Button>
            <Button
              onClick={() => createMutation.mutate()}
              disabled={!canCreate || createMutation.isPending}
            >
              {createMutation.isPending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Rename dialog ── */}
      <Dialog open={renameTarget !== null} onOpenChange={(o) => { if (!o) { setRenameTarget(null); setRenameNameServerError(null); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename Brand</DialogTitle>
            <DialogDescription>Enter a new name for "{renameTarget?.name}".</DialogDescription>
          </DialogHeader>
          <div className="py-2 space-y-1.5">
            <Input
              data-testid="input-brand-rename"
              value={renameValue}
              onChange={(e) => { setRenameValue(e.target.value); setRenameNameServerError(null); }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && renameValue.trim() && !renameMutation.isPending) {
                  renameMutation.mutate({ id: renameTarget!.id, name: renameValue.trim() });
                }
              }}
              autoFocus
            />
            {renameValue.length > 0 && renameValue.trim().length === 0 && (
              <p className="text-xs text-destructive" data-testid="rename-error-whitespace">
                Brand name cannot be blank.
              </p>
            )}
            {renameNameServerError && (
              <p className="text-xs text-destructive" data-testid="rename-error-duplicate">
                {renameNameServerError}
              </p>
            )}
            {(() => {
              const renameWarning = checkNameWarning(
                renameValue,
                brands.filter((b) => b.id !== renameTarget?.id).map((b) => b.name),
              );
              if (renameWarning.exactMatch) {
                return (
                  <p className="text-xs text-amber-600 dark:text-amber-400" data-testid="name-warning-exact">
                    A brand named &ldquo;{renameWarning.exactMatch}&rdquo; already exists.
                  </p>
                );
              }
              if (renameWarning.similarMatches.length > 0) {
                return (
                  <p className="text-xs text-amber-600 dark:text-amber-400" data-testid="name-warning-similar">
                    Similar brand names already exist: {renameWarning.similarMatches.join(", ")}.
                  </p>
                );
              }
              return null;
            })()}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameTarget(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => renameMutation.mutate({ id: renameTarget!.id, name: renameValue.trim() })}
              disabled={!renameValue.trim() || renameMutation.isPending}
            >
              {renameMutation.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete confirmation ── */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{deleteTarget?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              {parseInt(deleteTarget?.sticker_count ?? "0", 10) > 0
                ? `This brand has ${deleteTarget?.sticker_count} sticker(s) assigned to it. You must reassign or delete those stickers before deleting this brand.`
                : "This brand will be permanently removed."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Bulk delete confirmation ── */}
      <AlertDialog open={bulkDeleteOpen} onOpenChange={(o) => !o && setBulkDeleteOpen(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {selectedIds.size} brand{selectedIds.size === 1 ? "" : "s"}?</AlertDialogTitle>
            <AlertDialogDescription>
              {selectedIds.size === 1
                ? "This brand will be permanently removed."
                : `These ${selectedIds.size} brands will be permanently removed.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={handleBulkDelete}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting…" : `Delete ${selectedIds.size} brand${selectedIds.size === 1 ? "" : "s"}`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
        </TabsContent>
        {canManageAliases && (
          <TabsContent value="statement-aliases" className="mt-6">
            <BrandAliasesView />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
