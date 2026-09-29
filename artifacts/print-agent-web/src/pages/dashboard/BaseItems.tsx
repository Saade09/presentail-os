import { useState, useRef, useEffect, useMemo } from "react";
import { useSearchParams, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  FlaskConical,
  Plus,
  Pencil,
  Trash2,
  ImageIcon,
  Loader2,
  X,
  Search,
  Sparkles,
  Download,
  Package,
  Flower2,
  HelpCircle,
  MoreHorizontal,
  ChevronLeft,
  ChevronRight,
  RefreshCw,
  Camera,
  CheckCircle2,
  Copy,
  Eye,
  Archive,
  GitMerge,
  AlertTriangle,
  ChevronDown,
  Columns3,
  Receipt,
  EyeOff,
  RotateCcw,
  Clock,
  CalendarDays,
  Upload,
  FileSpreadsheet,
  CheckCheck,
  SkipForward,
  TriangleAlert,
} from "lucide-react";
import { BaseItemCategoryCombobox } from "@/components/BaseItemCategoryCombobox";
import { BaseItemImageThumbnail } from "@/components/BaseItemImageThumbnail";
import { apiFetch } from "@/lib/queryClient";
import { imageUrl } from "@/lib/imageUrl";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { StaleDataBadge } from "@/components/StaleDataBadge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
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
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { useUserPreference } from "@/hooks/use-user-preference";
import { checkNameWarning } from "@/lib/nameWarning";
import { useTranslation, Trans } from "react-i18next";
import {
  useListBaseItemDeletionHistory,
  getListBaseItemDeletionHistoryQueryKey,
  useListSuppliers,
} from "@workspace/api-client-react";
import type { BaseItemDeletionHistoryEntry, ImportBaseItemsResponse, Supplier } from "@workspace/api-client-react";

type SubCategory = {
  id: number;
  name: string;
  parent_id: number;
  status?: string;
};

type MainCategory = {
  id: number;
  name: string;
  parent_id: null;
  status?: string;
  subcategories: SubCategory[];
};

type BaseItem = {
  id: number;
  name: string;
  code: string;
  image_url: string | null;
  category_id: number | null;
  alternate_name: string | null;
  accounting_category: string | null;
  tax_rate: string | null;
  main_category_name: string | null;
  sub_category_name: string | null;
  created_at: string;
  stock?: number | null;
  low_stock_threshold?: number | null;
  used_in_products?: number;
  status?: string;
  type?: string | null;
  merged_into_base_item_id?: number | null;
  merged_into_name?: string | null;
  total_spend?: string | null;
  spend_ytd?: string | null;
};

type BaseItemSummary = {
  total: number;
  flower: number;
  packaging: number;
  uncategorized: number;
};

type BaseItemSpendSummary = {
  total_spend: string;
  spend_ytd: string;
};

type SpendBreakdownItem = {
  id: number;
  name: string;
  category: string | null;
  spend_ytd: string;
  total_spend: string;
};

function inferType(main: string | null, sub: string | null): string | null {
  const combined = `${main ?? ""} ${sub ?? ""}`.toLowerCase();
  if (combined.includes("flower")) return "Flower";
  if (combined.includes("packag")) return "Packaging";
  if (combined.includes("foliage")) return "Foliage";
  if (combined.includes("ribbon") || combined.includes("wrap")) return "Wrap";
  if (combined.includes("vase") || combined.includes("pot")) return "Vessel";
  return null;
}

const TYPE_COLORS: Record<string, string> = {
  Flower:    "bg-pink-100 text-pink-700 dark:bg-pink-900/30 dark:text-pink-400",
  Packaging: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  Foliage:   "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  Wrap:      "bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400",
  Vessel:    "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
};

function TypeBadge({ main, sub }: { main: string | null; sub: string | null }) {
  const type = inferType(main, sub);
  if (!type) return null;
  const cls = TYPE_COLORS[type] ?? "bg-secondary text-muted-foreground";
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium border-0 ${cls}`}>
      {type}
    </span>
  );
}

const STATUS_COLORS: Record<string, string> = {
  active:   "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  archived: "bg-zinc-100 text-zinc-500 dark:bg-zinc-800/60 dark:text-zinc-400",
  merged:   "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
};

function StatusBadge({ status }: { status?: string }) {
  const s = status ?? "active";
  const cls = STATUS_COLORS[s] ?? STATUS_COLORS.active;
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium border-0 ${cls}`}>
      {s.charAt(0).toUpperCase() + s.slice(1)}
    </span>
  );
}

const VALID_ITEM_TYPES = ["Flower", "Packaging", "Foliage", "Wrap", "Vessel", "Other"];

function StockLevelBadge({ stock, threshold }: { stock: number | null | undefined; threshold: number | null | undefined }) {
  const currentStock = stock ?? 0;
  const currentThreshold = threshold ?? 0;
  const isOut = currentStock === 0;
  const isLow = !isOut && currentThreshold > 0 && currentStock <= currentThreshold;
  if (isOut) {
    return <Badge className="bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-0 text-xs">Out of Stock</Badge>;
  }
  if (isLow) {
    return <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border-0 text-xs">Low Stock</Badge>;
  }
  return null;
}

function formatDate(iso: string) {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function formatSpend(value: string | null | undefined): string {
  const n = parseFloat(value ?? "0");
  if (isNaN(n) || n === 0) return "—";
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

type BaseItemFormState = {
  name: string;
  image_url: string | null;
  category_id: string;
  alternate_name: string;
  accounting_category: string;
  tax_rate: string;
};

const DEFAULT_FORM: BaseItemFormState = {
  name: "",
  image_url: null,
  category_id: "",
  alternate_name: "",
  accounting_category: "",
  tax_rate: "",
};

function buildDefaultPrompt(name: string, categoryLabel: string | null): string {
  const parts: string[] = [];
  if (name.trim()) parts.push(name.trim());
  if (categoryLabel) parts.push(`(${categoryLabel})`);
  return parts.length > 0 ? `Professional product photo of ${parts.join(" ")}` : "";
}

function getCategoryLabel(categoryId: string, categories: MainCategory[]): string | null {
  for (const main of categories) {
    if (String(main.id) === categoryId) return main.name;
    for (const sub of main.subcategories) {
      if (String(sub.id) === categoryId) return `${main.name} - ${sub.name}`;
    }
  }
  return null;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const AI_SUGGESTION_CHIPS = [
  "Isolated on white background",
  "Close-up, high detail",
  "Product photography",
  "Natural lighting",
  "Top view",
];

type AIStyle = "photographic" | "minimal" | "illustration";
type AICount = 1 | 2 | 4;

const STYLE_OPTIONS: { id: AIStyle; label: string; desc: string }[] = [
  { id: "photographic", label: "Photographic", desc: "Realistic studio photo" },
  { id: "minimal", label: "Clean & Minimal", desc: "Simple, clean look" },
  { id: "illustration", label: "Illustration", desc: "Artistic, decorative" },
];


type BaseItemDialogProps = {
  open: boolean;
  onClose: () => void;
  initialValues?: Partial<BaseItemFormState>;
  code?: string;
  categories: MainCategory[];
  categoriesLoading?: boolean;
  existingNames?: string[];
  onSubmit: (data: BaseItemFormState) => void;
  isPending: boolean;
  title: string;
  description: string;
  submitLabel: string;
};

type ImageMeta = { name: string; size?: number };

function BaseItemDialog({
  open,
  onClose,
  initialValues,
  code,
  categories,
  categoriesLoading = false,
  existingNames = [],
  onSubmit,
  isPending,
  title,
  description,
  submitLabel,
}: BaseItemDialogProps) {
  const { toast } = useToast();
  const [form, setForm] = useState<BaseItemFormState>({ ...DEFAULT_FORM, ...initialValues });
  const [didSubmit, setDidSubmit] = useState(false);
  const [dialogStep, setDialogStep] = useState<"details" | "ai-configure" | "ai-results">("details");
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [imageMeta, setImageMeta] = useState<ImageMeta | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // AI state lifted into the dialog so it persists across step navigation
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiStyle, setAiStyle] = useState<AIStyle>(() => {
    const saved = localStorage.getItem("ai_style_pref");
    return (saved === "photographic" || saved === "minimal" || saved === "illustration")
      ? saved
      : "photographic";
  });
  const [aiCount, setAiCount] = useState<AICount>(() => {
    const saved = parseInt(localStorage.getItem("ai_count_pref") ?? "", 10);
    return (saved === 1 || saved === 2 || saved === 4) ? saved : 1;
  });
  const [aiGenerating, setAiGenerating] = useState(false);
  const [aiGeneratedUrls, setAiGeneratedUrls] = useState<string[]>([]);
  const [aiSelectedUrl, setAiSelectedUrl] = useState<string | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);

  const isCreateMode = code === undefined;
  const [debouncedName, setDebouncedName] = useState("");

  useEffect(() => {
    if (!isCreateMode) return;
    const timer = setTimeout(() => setDebouncedName(form.name.trim()), 300);
    return () => clearTimeout(timer);
  }, [form.name, isCreateMode]);

  const { data: nameCheckData } = useQuery({
    queryKey: ["base-items-check-name", debouncedName],
    queryFn: () =>
      apiFetch<{ exactMatch: string | null; similarMatches: string[] }>(
        `/api/base-items/check-name?name=${encodeURIComponent(debouncedName)}`,
      ),
    enabled: isCreateMode && debouncedName.length > 0,
    staleTime: 30_000,
  });

  const nameWarning = isCreateMode
    ? (nameCheckData ?? { exactMatch: null, similarMatches: [] })
    : checkNameWarning(form.name, existingNames);

  const categoryLabel = form.category_id ? getCategoryLabel(form.category_id, categories) : null;

  useEffect(() => {
    if (open) {
      setForm({ ...DEFAULT_FORM, ...initialValues });
      setDidSubmit(false);
      setDialogStep("details");
      setUploadError(null);
      setImageMeta(initialValues?.image_url ? { name: "Existing image" } : null);
      setAiPrompt("");
      setAiStyle("photographic");
      setAiCount(1);
      setAiGenerating(false);
      setAiGeneratedUrls([]);
      setAiSelectedUrl(null);
      setAiError(null);
      setDebouncedName("");
    }
  }, [open]);

  function set<K extends keyof BaseItemFormState>(key: K, value: BaseItemFormState[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  const taxRateValue = form.tax_rate.trim();
  const taxRateInvalid =
    taxRateValue !== "" &&
    (isNaN(parseFloat(taxRateValue)) || parseFloat(taxRateValue) < 0 || parseFloat(taxRateValue) > 100);

  const canSubmit =
    form.name.trim().length > 0 &&
    !!form.category_id &&
    !!form.image_url &&
    !taxRateInvalid &&
    !isPending;

  function handleSubmit() {
    setDidSubmit(true);
    if (canSubmit) onSubmit(form);
  }

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
      set("image_url", data.url);
      setImageMeta({ name: file.name, size: file.size });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not upload image. Please try again.";
      setUploadError(msg);
      toast({ title: "Upload failed", description: msg, variant: "destructive" });
    } finally {
      setUploading(false);
    }
  }

  function openAiStep() {
    if (!aiPrompt) {
      setAiPrompt(buildDefaultPrompt(form.name, categoryLabel));
    }
    setAiError(null);
    setDialogStep("ai-configure");
  }

  function appendAiSuggestion(chip: string) {
    setAiPrompt((prev) => {
      const trimmed = prev.trim();
      if (trimmed.toLowerCase().includes(chip.toLowerCase())) return prev;
      return trimmed ? `${trimmed}, ${chip}` : chip;
    });
  }

  async function handleAiGenerate() {
    if (!aiPrompt.trim()) {
      setAiError("Please enter a prompt.");
      return;
    }
    setAiGenerating(true);
    setAiError(null);
    try {
      const data = await apiFetch<{ urls?: string[]; url?: string }>("/api/base-items/generate-image", {
        method: "POST",
        body: JSON.stringify({ prompt: aiPrompt.trim(), count: aiCount, style: aiStyle }),
      });
      const urls = data.urls ?? (data.url ? [data.url] : []);
      setAiGeneratedUrls(urls);
      setAiSelectedUrl(null);
      if (urls.length > 1) {
        setDialogStep("ai-results");
      }
      // For a single result stay on ai-configure so the prompt remains visible
    } catch (err) {
      const detail = err instanceof Error ? err.message : "Please try again.";
      setAiError(`Generation failed. ${detail}`);
    } finally {
      setAiGenerating(false);
    }
  }

  function handleUseSelectedImage() {
    if (!aiSelectedUrl) {
      setAiError("Please select an image first.");
      return;
    }
    set("image_url", aiSelectedUrl);
    setImageMeta({ name: "AI generated image" });
    setDialogStep("details");
  }

  const thumb = imageUrl(form.image_url);
  const isAiStep = dialogStep === "ai-configure" || dialogStep === "ai-results";

  return (
    <>
      <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
        <DialogContent className={`${isAiStep ? "max-w-3xl" : "max-w-2xl"} max-h-[90vh] overflow-y-auto transition-all`}>

          {/* ── AI Configure Step ── */}
          {dialogStep === "ai-configure" && (
            <div className="space-y-5">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  aria-label="Back to item details"
                  onClick={() => { setAiError(null); setDialogStep("details"); }}
                  className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ChevronLeft size={16} />
                  Back to item details
                </button>
              </div>
              <div>
                <button
                  type="button"
                  onClick={openAiStep}
                  className="text-base font-semibold hover:underline focus:outline-none text-left"
                >
                  Generate with AI
                </button>
                <p className="text-sm text-muted-foreground mt-0.5">Create a product image using AI</p>
              </div>

              {/* Prompt */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="ai-prompt" className="text-sm font-medium">Prompt</Label>
                  <span className="text-xs text-muted-foreground">{aiPrompt.length} / 500</span>
                </div>
                <Textarea
                  id="ai-prompt"
                  value={aiPrompt}
                  onChange={(e) => setAiPrompt(e.target.value.slice(0, 500))}
                  rows={3}
                  placeholder="Describe the image, e.g. red roses bouquet on white background"
                  className="resize-none"
                />
              </div>

              {/* Suggestion chips */}
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground uppercase tracking-wide">Quick suggestions</Label>
                <div className="flex flex-wrap gap-2">
                  {AI_SUGGESTION_CHIPS.map((chip) => (
                    <button
                      key={chip}
                      type="button"
                      onClick={() => appendAiSuggestion(chip)}
                      className="inline-flex items-center px-2.5 py-1 rounded-full text-xs border border-border bg-muted/40 hover:bg-muted hover:border-border/80 transition-colors text-foreground"
                    >
                      {chip}
                    </button>
                  ))}
                </div>
              </div>

              {/* Image Style */}
              <div className="space-y-2">
                <Label className="text-sm font-medium">Image Style</Label>
                <div className="grid grid-cols-3 gap-2">
                  {STYLE_OPTIONS.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => { setAiStyle(s.id); localStorage.setItem("ai_style_pref", s.id); }}
                      className={`flex flex-col items-center gap-1 p-3 rounded-lg border text-center transition-all ${
                        aiStyle === s.id
                          ? "border-primary bg-primary/5 ring-1 ring-primary"
                          : "border-border bg-muted/20 hover:bg-muted/50"
                      }`}
                    >
                      <span className="text-lg">
                        {s.id === "photographic" ? "📷" : s.id === "minimal" ? "◻" : "🎨"}
                      </span>
                      <span className="text-xs font-medium leading-tight">{s.label}</span>
                      <span className="text-[10px] text-muted-foreground leading-tight">{s.desc}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Image Count */}
              <div className="space-y-2">
                <Label className="text-sm font-medium">Number of Images</Label>
                <div className="flex gap-2">
                  {([1, 2, 4] as AICount[]).map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() => { setAiCount(n); localStorage.setItem("ai_count_pref", String(n)); }}
                      className={`flex-1 py-2 px-3 rounded-lg border text-sm font-medium transition-all ${
                        aiCount === n
                          ? "border-primary bg-primary/5 ring-1 ring-primary text-primary"
                          : "border-border bg-muted/20 hover:bg-muted/50 text-foreground"
                      }`}
                    >
                      {n} {n === 1 ? "Image" : "Images"}
                    </button>
                  ))}
                </div>
              </div>

              {aiError && (
                <p className="text-sm text-destructive" role="alert">{aiError}</p>
              )}

              {aiGeneratedUrls.length > 0 && (
                <div className="space-y-2">
                  <div className="rounded-lg overflow-hidden border border-border bg-muted aspect-square max-w-[200px] mx-auto">
                    <img
                      src={imageUrl(aiGeneratedUrls[0]) ?? ""}
                      alt=""
                      className="w-full h-full object-cover"
                    />
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    className="w-full"
                    onClick={() => {
                      set("image_url", aiGeneratedUrls[0]);
                      setImageMeta({ name: "AI generated image" });
                      setDialogStep("details");
                    }}
                  >
                    Use this image
                  </Button>
                </div>
              )}

              <div className="space-y-2 pt-1">
                <Button
                  className="w-full"
                  onClick={handleAiGenerate}
                  disabled={!aiPrompt.trim() || aiGenerating}
                >
                  {aiGenerating ? (
                    <><Loader2 size={14} className="animate-spin mr-2" />Generating…</>
                  ) : aiGeneratedUrls.length > 0 ? (
                    <><RefreshCw size={14} className="mr-2" />Regenerate</>
                  ) : (
                    <><Sparkles size={14} className="mr-2" />Generate</>
                  )}
                </Button>
                <p className="text-xs text-center text-muted-foreground">This may take a few seconds.</p>
              </div>
            </div>
          )}

          {/* ── AI Results Step ── */}
          {dialogStep === "ai-results" && (
            <div className="space-y-5">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => { setAiError(null); setAiGeneratedUrls([]); setAiSelectedUrl(null); setDialogStep("ai-configure"); }}
                  className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ChevronLeft size={16} />
                  Back to item details
                </button>
              </div>
              <div>
                <h2 className="text-base font-semibold">Select an image</h2>
                <p className="text-sm text-muted-foreground mt-0.5">Click an image to select it, then click "Use selected image".</p>
              </div>

              <div className={`grid gap-3 ${aiGeneratedUrls.length === 1 ? "grid-cols-1" : "grid-cols-2"}`}>
                {aiGeneratedUrls.map((url, i) => {
                  const selected = aiSelectedUrl === url;
                  return (
                    <button
                      key={i}
                      type="button"
                      onClick={() => { setAiSelectedUrl(url); setAiError(null); }}
                      className={`relative rounded-lg overflow-hidden border-2 bg-muted aspect-square transition-all ${
                        selected
                          ? "border-primary ring-2 ring-primary"
                          : "border-border hover:border-primary/50"
                      }`}
                    >
                      <img
                        src={imageUrl(url) ?? ""}
                        alt={`Generated option ${i + 1}`}
                        className="w-full h-full object-cover"
                      />
                      {selected && (
                        <div className="absolute top-2 right-2 bg-primary text-primary-foreground rounded-full p-0.5">
                          <CheckCircle2 size={16} />
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>

              {aiError && (
                <p className="text-sm text-destructive" role="alert">{aiError}</p>
              )}

              <div className="flex gap-2 pt-1">
                <Button
                  variant="outline"
                  onClick={() => { setAiError(null); setAiGeneratedUrls([]); setAiSelectedUrl(null); setDialogStep("ai-configure"); }}
                >
                  <RefreshCw size={14} className="mr-2" />
                  Regenerate
                </Button>
                <Button
                  className="flex-1"
                  onClick={handleUseSelectedImage}
                  disabled={!aiSelectedUrl}
                >
                  <CheckCircle2 size={14} className="mr-2" />
                  Use selected image
                </Button>
              </div>
            </div>
          )}

          {/* ── Details Step ── */}
          {dialogStep === "details" && (
            <>
              <DialogHeader>
                <DialogTitle>{title}</DialogTitle>
                <DialogDescription>{description}</DialogDescription>
              </DialogHeader>

              <div className="space-y-6 py-2">
                {/* ── Basic Information ── */}
                <div>
                  <h3 className="text-sm font-semibold text-foreground mb-3">Basic Information</h3>
                  <div className="space-y-4">
                    {code !== undefined && (
                      <div className="space-y-1.5">
                        <Label className="text-sm">Code</Label>
                        <div className="flex h-9 w-full rounded-md border border-input bg-muted px-3 py-2 text-sm text-muted-foreground select-all font-mono tracking-widest">
                          {code}
                        </div>
                      </div>
                    )}
                    <div className="space-y-1.5">
                      <Label htmlFor="bi-name">
                        Name <span className="text-destructive">*</span>
                      </Label>
                      <Input
                        id="bi-name"
                        data-testid="input-base-item-name"
                        value={form.name}
                        onChange={(e) => set("name", e.target.value)}
                        placeholder="e.g. Red Roses"
                        autoFocus
                      />
                      {nameWarning.exactMatch && (
                        <p className="text-xs text-amber-600 dark:text-amber-400" data-testid="name-warning-exact">
                          A base item named &ldquo;{nameWarning.exactMatch}&rdquo; already exists.
                        </p>
                      )}
                      {!nameWarning.exactMatch && nameWarning.similarMatches.length > 0 && (
                        <p className="text-xs text-amber-600 dark:text-amber-400" data-testid="name-warning-similar">
                          Similar base item names already exist: {nameWarning.similarMatches.join(", ")}.
                        </p>
                      )}
                    </div>

                    {/* Edit-only fields */}
                    {code !== undefined && (
                      <>
                        <div className="space-y-1.5">
                          <Label htmlFor="bi-alternate-name">Alternate Name</Label>
                          <Input
                            id="bi-alternate-name"
                            data-testid="input-base-item-alternate-name"
                            value={form.alternate_name}
                            onChange={(e) => set("alternate_name", e.target.value)}
                            placeholder="Optional alternate name"
                          />
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                          <div className="space-y-1.5">
                            <Label htmlFor="bi-accounting-category">Accounting Category</Label>
                            <Input
                              id="bi-accounting-category"
                              data-testid="input-base-item-accounting-category"
                              value={form.accounting_category}
                              onChange={(e) => set("accounting_category", e.target.value)}
                              placeholder="e.g. Cost of Goods"
                            />
                          </div>
                          <div className="space-y-1.5">
                            <Label htmlFor="bi-tax-rate">Tax Rate (%)</Label>
                            <Input
                              id="bi-tax-rate"
                              data-testid="input-base-item-tax-rate"
                              type="number"
                              min="0"
                              max="100"
                              step="any"
                              value={form.tax_rate}
                              onChange={(e) => set("tax_rate", e.target.value)}
                              placeholder="e.g. 10"
                            />
                            {taxRateInvalid && (
                              <p className="text-sm text-destructive">Tax rate must be between 0 and 100.</p>
                            )}
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                </div>

                {/* ── Category ── */}
                <div>
                  <h3 className="text-sm font-semibold text-foreground mb-3">Category</h3>
                  <div className="space-y-1.5">
                    <Label>
                      Category <span className="text-destructive">*</span>
                    </Label>
                    <BaseItemCategoryCombobox
                      value={form.category_id}
                      onChange={(id) => set("category_id", id)}
                      categories={categories}
                      isLoading={categoriesLoading}
                    />
                    {didSubmit && !form.category_id && (
                      <p className="text-sm text-destructive">Please select a category.</p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      <a
                        href="/dashboard/base-item-categories"
                        target="_blank"
                        rel="noreferrer"
                        className="underline hover:text-foreground"
                      >
                        Manage categories
                      </a>
                    </p>
                  </div>
                </div>

                {/* ── Image ── */}
                <div>
                  <h3 className="text-sm font-semibold text-foreground mb-3">
                    Image <span className="text-destructive">*</span>
                  </h3>

                  {!thumb ? (
                    /* Two option cards */
                    <div className="grid grid-cols-2 gap-3">
                      {/* Generate with AI card */}
                      <button
                        type="button"
                        onClick={openAiStep}
                        className="relative flex flex-col items-center justify-center gap-2.5 rounded-xl border-2 border-teal-500 bg-teal-50/60 dark:bg-teal-950/20 p-5 text-center hover:bg-teal-50 dark:hover:bg-teal-950/30 transition-colors"
                      >
                        <span className="absolute top-2 right-2">
                          <Badge className="bg-teal-500 text-white text-[10px] px-1.5 py-0.5 border-0">
                            Recommended
                          </Badge>
                        </span>
                        <div className="w-10 h-10 rounded-full bg-teal-100 dark:bg-teal-900/40 flex items-center justify-center">
                          <Sparkles size={20} className="text-teal-600 dark:text-teal-400" />
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-teal-700 dark:text-teal-300">Generate with AI</p>
                          <p className="text-xs text-teal-600/80 dark:text-teal-400/80 mt-0.5">Create a product image using AI</p>
                        </div>
                      </button>

                      {/* Upload image card */}
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={uploading}
                        className="flex flex-col items-center justify-center gap-2.5 rounded-xl border-2 border-dashed border-border bg-muted/20 p-5 text-center hover:bg-muted/40 transition-colors disabled:opacity-60"
                      >
                        <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
                          {uploading ? (
                            <Loader2 size={20} className="animate-spin text-muted-foreground" />
                          ) : (
                            <Camera size={20} className="text-muted-foreground" />
                          )}
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-foreground">
                            {uploading ? "Uploading…" : "Upload image"}
                          </p>
                          <p className="text-xs text-muted-foreground mt-0.5">JPEG, PNG, or WebP</p>
                        </div>
                      </button>
                    </div>
                  ) : (
                    /* Image preview row */
                    <div className="flex items-center gap-3 p-3 rounded-lg border border-border bg-muted/20">
                      <div className="w-14 h-14 rounded-md border border-border overflow-hidden bg-muted shrink-0">
                        <img src={thumb} alt="" className="w-full h-full object-cover" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">
                          {imageMeta?.name ?? "Image"}
                        </p>
                        {imageMeta?.size != null && (
                          <p className="text-xs text-muted-foreground">{formatFileSize(imageMeta.size)}</p>
                        )}
                        {!imageMeta?.size && (
                          <p className="text-xs text-muted-foreground">Ready to use</p>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            set("image_url", null);
                            setImageMeta(null);
                          }}
                        >
                          Replace
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:text-destructive"
                          onClick={() => {
                            set("image_url", null);
                            setImageMeta(null);
                          }}
                        >
                          <X size={14} />
                        </Button>
                      </div>
                    </div>
                  )}

                  {uploadError && (
                    <p className="text-sm text-destructive mt-2" role="alert">{uploadError}</p>
                  )}
                  {didSubmit && !form.image_url && (
                    <p className="text-sm text-destructive mt-2">Please add an image.</p>
                  )}
                </div>
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={onClose} disabled={isPending}>Cancel</Button>
                <Button
                  onClick={handleSubmit}
                  disabled={isPending || !form.name.trim() || !form.category_id || !form.image_url || taxRateInvalid}
                >
                  {isPending ? <><Loader2 size={14} className="animate-spin mr-1.5" />{submitLabel}…</> : submitLabel}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
          e.target.value = "";
        }}
      />
    </>
  );
}

const SEARCH_DEBOUNCE_MS = 300;
const PAGE_SIZE = 10;

// ─── Update Category Modal ──────────────────────────────────────────────────
function UpdateCategoryModal({
  open,
  onClose,
  ids,
  selectedItems,
  categories,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  ids: number[];
  selectedItems: BaseItem[];
  categories: MainCategory[];
  onSuccess: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [categoryId, setCategoryId] = useState<string>("");

  useEffect(() => {
    if (open) setCategoryId("");
  }, [open]);

  const mutation = useMutation({
    mutationFn: () =>
      apiFetch("/api/base-items/bulk-update-category", {
        method: "POST",
        body: JSON.stringify({ ids, category_id: categoryId ? parseInt(categoryId, 10) : null }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["base-items"] });
      toast({ title: `Category updated for ${ids.length} item${ids.length !== 1 ? "s" : ""}` });
      onSuccess();
      onClose();
    },
    onError: (error: Error) => {
      toast({
        title: "Failed to update category",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const breakdown = selectedItems.reduce<Record<string, number>>((acc, item) => {
    const cat = item.sub_category_name
      ? `${item.main_category_name} › ${item.sub_category_name}`
      : (item.main_category_name ?? "Uncategorized");
    acc[cat] = (acc[cat] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Update Category</DialogTitle>
          <DialogDescription>
            Update the category for {ids.length} selected item{ids.length !== 1 ? "s" : ""}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div>
            <p className="text-xs text-muted-foreground mb-2 font-medium uppercase tracking-wide">Current breakdown</p>
            <div className="space-y-1">
              {Object.entries(breakdown).map(([cat, count]) => (
                <div key={cat} className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">{cat}</span>
                  <span className="tabular-nums font-medium">{count}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>New Category</Label>
            <BaseItemCategoryCombobox
              value={categoryId}
              onChange={setCategoryId}
              categories={categories}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>Cancel</Button>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending || !categoryId}>
            {mutation.isPending ? <><Loader2 size={14} className="animate-spin mr-1.5" />Updating…</> : "Update Category"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Update Type Modal ──────────────────────────────────────────────────────
function UpdateTypeModal({
  open,
  onClose,
  ids,
  selectedItems,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  ids: number[];
  selectedItems: BaseItem[];
  onSuccess: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [type, setType] = useState<string>("");

  useEffect(() => {
    if (open) setType("");
  }, [open]);

  const mutation = useMutation({
    mutationFn: () =>
      apiFetch("/api/base-items/bulk-update-type", {
        method: "POST",
        body: JSON.stringify({ ids, type: type || null }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["base-items"] });
      toast({ title: `Type updated for ${ids.length} item${ids.length !== 1 ? "s" : ""}` });
      onSuccess();
      onClose();
    },
    onError: () => {
      toast({ title: "Failed to update type", variant: "destructive" });
    },
  });

  const breakdown = selectedItems.reduce<Record<string, number>>((acc, item) => {
    const t = item.type ?? inferType(item.main_category_name, item.sub_category_name) ?? "—";
    acc[t] = (acc[t] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Update Type</DialogTitle>
          <DialogDescription>
            Update the type for {ids.length} selected item{ids.length !== 1 ? "s" : ""}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div>
            <p className="text-xs text-muted-foreground mb-2 font-medium uppercase tracking-wide">Current breakdown</p>
            <div className="space-y-1">
              {Object.entries(breakdown).map(([t, count]) => (
                <div key={t} className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">{t}</span>
                  <span className="tabular-nums font-medium">{count}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label>New Type</Label>
            <Select value={type || "none"} onValueChange={(v) => setType(v === "none" ? "" : v)}>
              <SelectTrigger>
                <SelectValue placeholder="Select type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— No type —</SelectItem>
                {VALID_ITEM_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>{t}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>Cancel</Button>
          <Button onClick={() => mutation.mutate()} disabled={mutation.isPending || !type}>
            {mutation.isPending ? <><Loader2 size={14} className="animate-spin mr-1.5" />Updating…</> : "Update Type"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Archive Modal ──────────────────────────────────────────────────────────
function ArchiveModal({
  open,
  onClose,
  ids,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  ids: number[];
  onSuccess: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const mutation = useMutation({
    mutationFn: () =>
      apiFetch("/api/base-items/bulk-archive", {
        method: "POST",
        body: JSON.stringify({ ids }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["base-items"] });
      qc.invalidateQueries({ queryKey: ["base-items-summary"] });
      qc.invalidateQueries({ queryKey: ["base-items-spend-summary"] });
      qc.invalidateQueries({ queryKey: ["base-items-spend-breakdown"] });
      toast({ title: `${ids.length} item${ids.length !== 1 ? "s" : ""} archived` });
      onSuccess();
      onClose();
    },
    onError: () => {
      toast({ title: "Failed to archive items", variant: "destructive" });
    },
  });

  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Archive {ids.length} item{ids.length !== 1 ? "s" : ""}?</AlertDialogTitle>
          <AlertDialogDescription>
            Archived items are hidden from the default view but can be seen by switching the status filter to "Archived". This action can be reversed by contacting support.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={mutation.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {mutation.isPending ? <><Loader2 size={14} className="animate-spin mr-1.5" />Archiving…</> : `Archive ${ids.length} item${ids.length !== 1 ? "s" : ""}`}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ─── Bulk Add Supplier Modal ─────────────────────────────────────────────────
function BulkAddSupplierModal({
  open,
  onClose,
  ids,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  ids: number[];
  onSuccess: () => void;
}) {
  const { toast } = useToast();
  const [supplierId, setSupplierId] = useState("");

  const { data: wsData } = useListSuppliers({});
  const suppliers: Supplier[] = (wsData?.suppliers ?? []).filter((s) => !s.is_archived);

  const mutation = useMutation({
    mutationFn: () =>
      apiFetch("/api/base-items/bulk-add-supplier", {
        method: "POST",
        body: JSON.stringify({ baseItemIds: ids, supplierId: parseInt(supplierId, 10) }),
      }),
    onSuccess: (data: { added: number; skipped: number }) => {
      toast({ title: `Added supplier to ${data.added} base item${data.added !== 1 ? "s" : ""}${data.skipped > 0 ? ` (${data.skipped} already linked)` : ""}` });
      onSuccess();
      onClose();
      setSupplierId("");
    },
    onError: () => toast({ title: "Failed to add supplier", variant: "destructive" }),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { onClose(); setSupplierId(""); } }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Add Supplier to {ids.length} Item{ids.length !== 1 ? "s" : ""}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <p className="text-sm text-muted-foreground">Select the supplier to link to all selected base items. Already-linked items will be skipped.</p>
          <div className="space-y-1">
            <Label className="text-xs">Supplier</Label>
            <Select value={supplierId || "none"} onValueChange={(v) => setSupplierId(v === "none" ? "" : v)}>
              <SelectTrigger className="h-9">
                <SelectValue placeholder="Select supplier…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none"><span className="text-muted-foreground">Select supplier…</span></SelectItem>
                {suppliers.map((s) => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => { onClose(); setSupplierId(""); }} disabled={mutation.isPending}>Cancel</Button>
          <Button onClick={() => mutation.mutate()} disabled={!supplierId || mutation.isPending}>
            {mutation.isPending ? <><Loader2 size={14} className="animate-spin mr-1.5" />Adding…</> : "Add Supplier"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Bulk Remove Supplier Modal ──────────────────────────────────────────────
function BulkRemoveSupplierModal({
  open,
  onClose,
  ids,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  ids: number[];
  onSuccess: () => void;
}) {
  const { toast } = useToast();
  const [supplierId, setSupplierId] = useState("");

  const { data: wsData } = useListSuppliers({});
  const suppliers: Supplier[] = (wsData?.suppliers ?? []).filter((s) => !s.is_archived);

  const mutation = useMutation({
    mutationFn: () =>
      apiFetch("/api/base-items/bulk-remove-supplier", {
        method: "POST",
        body: JSON.stringify({ baseItemIds: ids, supplierId: parseInt(supplierId, 10) }),
      }),
    onSuccess: (data: { removed: number }) => {
      toast({ title: `Removed supplier from ${data.removed} base item${data.removed !== 1 ? "s" : ""}` });
      onSuccess();
      onClose();
      setSupplierId("");
    },
    onError: () => toast({ title: "Failed to remove supplier", variant: "destructive" }),
  });

  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!o) { onClose(); setSupplierId(""); } }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove Supplier from {ids.length} Item{ids.length !== 1 ? "s" : ""}</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3 mt-2">
              <p>Select the supplier to remove from the selected base items. Existing PO line items will not be affected.</p>
              <div className="space-y-1">
                <Label className="text-xs">Supplier</Label>
                <Select value={supplierId || "none"} onValueChange={(v) => setSupplierId(v === "none" ? "" : v)}>
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder="Select supplier…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none"><span className="text-muted-foreground">Select supplier…</span></SelectItem>
                    {suppliers.map((s) => <SelectItem key={s.id} value={String(s.id)}>{s.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => { onClose(); setSupplierId(""); }} disabled={mutation.isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => mutation.mutate()}
            disabled={!supplierId || mutation.isPending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {mutation.isPending ? <><Loader2 size={14} className="animate-spin mr-1.5" />Removing…</> : "Remove Supplier"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ─── Merge Modal ────────────────────────────────────────────────────────────
function MergeModal({
  open,
  onClose,
  selectedItems,
  onSuccess,
}: {
  open: boolean;
  onClose: () => void;
  selectedItems: BaseItem[];
  onSuccess: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [masterId, setMasterId] = useState<string>("");
  const [confirmed, setConfirmed] = useState(false);
  const [retryCountdown, setRetryCountdown] = useState(0);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (open) {
      setMasterId(selectedItems[0] ? String(selectedItems[0].id) : "");
      setConfirmed(false);
      setRetryCountdown(0);
      if (countdownRef.current) clearInterval(countdownRef.current);
    }
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, [open, selectedItems]);

  const startCooldown = (seconds: number) => {
    setRetryCountdown(seconds);
    countdownRef.current = setInterval(() => {
      setRetryCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(countdownRef.current!);
          countdownRef.current = null;
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const categories = new Set(selectedItems.map((i) => i.category_id));
  const types = new Set(selectedItems.map((i) => i.type ?? inferType(i.main_category_name, i.sub_category_name)));
  const hasCategoryMismatch = categories.size > 1;
  const hasTypeMismatch = types.size > 1;

  const mutation = useMutation({
    mutationFn: () =>
      apiFetch("/api/base-items/merge", {
        method: "POST",
        body: JSON.stringify({ ids: selectedItems.map((i) => i.id), master_id: parseInt(masterId, 10) }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["base-items"] });
      toast({ title: "Base items merged successfully" });
      onSuccess();
      onClose();
    },
    onError: (err: unknown) => {
      const apiErr = err as Error & { status?: number };
      if (apiErr.status === 409 && apiErr.message?.toLowerCase().includes("in progress")) {
        toast({
          title: "Another merge is already running",
          description: "Please wait a moment, then try again.",
          variant: "destructive",
        });
        startCooldown(8);
      } else if (apiErr.status === 409) {
        toast({
          title: "Items changed during merge",
          description: "One or more selected items are no longer active. Please refresh and try again.",
          variant: "destructive",
        });
      } else {
        toast({ title: "Failed to merge base items", variant: "destructive" });
      }
    },
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Merge Base Items</DialogTitle>
          <DialogDescription>
            Select the master item. Product recipes and supplier links from the other items will be reassigned to the master, and duplicate items will be marked as merged.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2 max-h-[60vh] overflow-y-auto">
          {(hasCategoryMismatch || hasTypeMismatch) && (
            <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 text-sm text-amber-800 dark:text-amber-300">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              <div>
                {hasCategoryMismatch && <p>Selected items have <strong>different categories</strong>.</p>}
                {hasTypeMismatch && <p>Selected items have <strong>different types</strong>.</p>}
                <p className="mt-0.5 text-xs opacity-75">The master item's category and type will be preserved.</p>
              </div>
            </div>
          )}
          <div className="space-y-2">
            <p className="text-sm font-medium">Select master item</p>
            <RadioGroup value={masterId} onValueChange={setMasterId} className="space-y-2">
              {selectedItems.map((item) => {
                const catLabel = item.sub_category_name
                  ? `${item.main_category_name} › ${item.sub_category_name}`
                  : (item.main_category_name ?? "—");
                const thumb = imageUrl(item.image_url);
                return (
                  <label
                    key={item.id}
                    className={`flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
                      masterId === String(item.id)
                        ? "border-primary bg-primary/5 ring-1 ring-primary"
                        : "border-border hover:border-primary/40"
                    }`}
                  >
                    <RadioGroupItem value={String(item.id)} id={`merge-${item.id}`} />
                    <div className="w-10 h-10 rounded-md border border-border overflow-hidden bg-muted shrink-0">
                      {thumb ? (
                        <img src={thumb} alt={item.name} className="w-full h-full object-cover" />
                      ) : (
                        <ImageIcon size={14} className="m-auto mt-3 text-muted-foreground" />
                      )}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{item.name}</p>
                      <p className="text-xs text-muted-foreground truncate">{catLabel}</p>
                    </div>
                    {masterId === String(item.id) && (
                      <span className="text-xs font-medium text-primary shrink-0">Master</span>
                    )}
                  </label>
                );
              })}
            </RadioGroup>
          </div>
          <div className="flex items-start gap-2">
            <input
              type="checkbox"
              id="merge-confirm"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
              className="mt-1 rounded"
            />
            <label htmlFor="merge-confirm" className="text-sm text-muted-foreground cursor-pointer">
              I understand that {selectedItems.length - 1} item{selectedItems.length - 1 !== 1 ? "s" : ""} will be permanently marked as merged and hidden from active items.
            </label>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>Cancel</Button>
          <Button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || !masterId || !confirmed || retryCountdown > 0}
          >
            {mutation.isPending
              ? <><Loader2 size={14} className="animate-spin mr-1.5" />Merging…</>
              : retryCountdown > 0
                ? <><Loader2 size={14} className="animate-spin mr-1.5" />Try again in {retryCountdown}s</>
                : <><GitMerge size={14} className="mr-1.5" />Merge Items</>}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── View Usage Modal ───────────────────────────────────────────────────────
type UsageProduct = { product_id: number; product_name: string; quantity: number; brand: string | null; status: string };

function ViewUsageModal({
  open,
  onClose,
  item,
}: {
  open: boolean;
  onClose: () => void;
  item: BaseItem | null;
}) {
  const { data, isLoading } = useQuery<{ products: UsageProduct[] }>({
    queryKey: ["base-item-usage", item?.id],
    queryFn: () => apiFetch(`/api/base-items/${item!.id}/usage`),
    enabled: open && item != null,
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Usage — {item?.name}</DialogTitle>
          <DialogDescription>Products that use this base item in their recipe.</DialogDescription>
        </DialogHeader>
        <div className="py-2 max-h-[60vh] overflow-y-auto">
          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
              <Loader2 size={14} className="animate-spin" />Loading…
            </div>
          ) : !data?.products.length ? (
            <div className="text-center py-8 text-sm text-muted-foreground">
              <Eye size={24} className="mx-auto mb-2 opacity-30" />
              Not used in any product recipes.
            </div>
          ) : (
            <div className="space-y-2">
              {data.products.map((p) => (
                <div key={p.product_id} className="flex items-center justify-between gap-3 py-2 border-b border-border last:border-0">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{p.product_name}</p>
                    {p.brand && <p className="text-xs text-muted-foreground truncate">{p.brand}</p>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-xs text-muted-foreground tabular-nums">qty: {p.quantity}</span>
                    <Badge variant="outline" className="text-xs capitalize">{p.status}</Badge>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SummaryCard({
  label,
  value,
  icon,
  loading,
  onClick,
  active,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
  loading: boolean;
  onClick?: () => void;
  active?: boolean;
}) {
  return (
    <div
      className={[
        "bg-card border rounded-lg p-4 flex items-center gap-4 transition-colors",
        onClick ? "cursor-pointer select-none" : "",
        active
          ? "border-primary ring-1 ring-primary bg-primary/5"
          : onClick
            ? "border-border hover:border-primary/50 hover:bg-muted/40"
            : "border-border",
      ].join(" ")}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); } } : undefined}
    >
      <div className="p-2 rounded-lg bg-muted shrink-0">
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-2xl font-bold tabular-nums">
          {loading ? <span className="inline-block w-8 h-6 rounded bg-muted animate-pulse" /> : value}
        </p>
        <p className="text-xs text-muted-foreground mt-0.5 truncate">{label}</p>
      </div>
    </div>
  );
}

function SpendSummaryCard({
  totalSpend,
  spendYtd,
  loading,
}: {
  totalSpend: string | undefined;
  spendYtd: string | undefined;
  loading: boolean;
}) {
  const ytdLabel = formatSpend(spendYtd);
  const allTimeLabel = formatSpend(totalSpend);
  const hasAllTime = parseFloat(totalSpend ?? "0") > 0;
  return (
    <div className="bg-card border border-border rounded-lg p-4 flex items-center gap-4">
      <div className="p-2 rounded-lg bg-muted shrink-0">
        <Receipt size={18} className="text-emerald-500" />
      </div>
      <div className="min-w-0">
        <p className="text-2xl font-bold tabular-nums">
          {loading ? <span className="inline-block w-16 h-6 rounded bg-muted animate-pulse" /> : ytdLabel}
        </p>
        <p className="text-xs text-muted-foreground mt-0.5 truncate">
          YTD Spend
          {!loading && hasAllTime && (
            <span className="ml-1">· {allTimeLabel} all-time</span>
          )}
        </p>
      </div>
    </div>
  );
}

function TopSpendersPanel({
  items,
  loading,
  onNavigate,
}: {
  items: SpendBreakdownItem[];
  loading: boolean;
  onNavigate: (id: number) => void;
}) {
  if (!loading && items.length === 0) return null;

  const maxSpend = items.length > 0 ? parseFloat(items[0].spend_ytd) : 1;

  return (
    <div className="bg-card border border-border rounded-lg p-4">
      <div className="flex items-center gap-2 mb-3">
        <Receipt size={16} className="text-emerald-500 shrink-0" />
        <p className="text-sm font-semibold">Top Spenders — YTD</p>
      </div>
      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3">
              <div className="h-4 w-36 rounded bg-muted animate-pulse" />
              <div className="flex-1 h-2 rounded bg-muted animate-pulse" />
              <div className="h-4 w-16 rounded bg-muted animate-pulse" />
            </div>
          ))}
        </div>
      ) : (
        <ol className="space-y-2">
          {items.map((item, idx) => {
            const ytd = parseFloat(item.spend_ytd);
            const pct = maxSpend > 0 ? Math.round((ytd / maxSpend) * 100) : 0;
            return (
              <li key={item.id} className="flex items-center gap-3 group">
                <span className="text-xs text-muted-foreground tabular-nums w-4 shrink-0 text-right">
                  {idx + 1}
                </span>
                <button
                  className="text-sm font-medium truncate hover:underline text-left min-w-0 max-w-[11rem]"
                  onClick={() => onNavigate(item.id)}
                  title={item.name}
                >
                  {item.name}
                </button>
                <span className="text-xs text-muted-foreground truncate hidden sm:block max-w-[7rem]">
                  {item.category ?? "Uncategorized"}
                </span>
                <div className="flex-1 min-w-[3rem]">
                  <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-full bg-emerald-500"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                </div>
                <span className="text-sm tabular-nums font-medium shrink-0">
                  {formatSpend(item.spend_ytd)}
                </span>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

type StockAlert = {
  base_item_id: number;
  base_item_name: string;
  base_item_code: string;
  location_id: number;
  location_name: string;
  country: string;
  stock: number;
  effective_threshold: number;
  deficit: number;
  dismissed: boolean;
  expires_at: string | null;
};

const SNOOZE_PRESETS: { label: string; hours: number }[] = [
  { label: "24 hours", hours: 24 },
  { label: "3 days", hours: 72 },
  { label: "1 week", hours: 168 },
];

function formatSnoozeExpiry(expiresAt: string): string {
  const exp = new Date(expiresAt);
  const now = new Date();
  const diffMs = exp.getTime() - now.getTime();
  const diffHours = diffMs / (1000 * 60 * 60);
  if (diffHours < 1) return "less than 1 hour";
  if (diffHours < 24) return `${Math.round(diffHours)}h`;
  const diffDays = Math.ceil(diffHours / 24);
  if (diffDays === 1) return "1 day";
  if (diffDays <= 7) return `${diffDays} days`;
  return exp.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function StockAlertsPanel({
  onNavigate,
}: {
  onNavigate: (baseItemId: number) => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [collapsed, setCollapsed] = useState(false);
  const [showDismissed, setShowDismissed] = useState(false);
  const [customSnooze, setCustomSnooze] = useState<{
    open: boolean;
    alert: StockAlert | null;
    date: string;
  }>({ open: false, alert: null, date: "" });
  const [snoozeAllCustom, setSnoozeAllCustom] = useState<{
    open: boolean;
    date: string;
  }>({ open: false, date: "" });

  const { data, isLoading } = useQuery<{ alerts: StockAlert[]; total: number }>({
    queryKey: ["base-items-stock-alerts"],
    queryFn: () => apiFetch("/api/base-items/stock-alerts?include_dismissed=true"),
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
  });

  const alerts = data?.alerts ?? [];

  const dismissMutation = useMutation({
    mutationFn: ({
      base_item_id,
      location_id,
      stock,
      duration_hours,
      expires_at,
    }: {
      base_item_id: number;
      location_id: number;
      stock: number;
      duration_hours?: number;
      expires_at?: string;
    }) =>
      apiFetch("/api/base-items/stock-alerts/dismiss", {
        method: "POST",
        body: JSON.stringify({ base_item_id, location_id, stock, duration_hours, expires_at }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["base-items-stock-alerts"] });
    },
    onError: () => {
      toast({ title: "Failed to snooze alert", variant: "destructive" });
    },
  });

  const undismissMutation = useMutation({
    mutationFn: ({ base_item_id, location_id }: { base_item_id: number; location_id: number }) =>
      apiFetch("/api/base-items/stock-alerts/dismiss", {
        method: "DELETE",
        body: JSON.stringify({ base_item_id, location_id }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["base-items-stock-alerts"] });
    },
    onError: () => {
      toast({ title: "Failed to restore alert", variant: "destructive" });
    },
  });

  const snoozeAllMutation = useMutation({
    mutationFn: ({
      duration_hours,
      expires_at,
    }: {
      duration_hours?: number;
      expires_at?: string;
    }) =>
      apiFetch("/api/base-items/stock-alerts/dismiss-all", {
        method: "POST",
        body: JSON.stringify({ duration_hours, expires_at }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["base-items-stock-alerts"] });
      toast({ title: "All alerts snoozed" });
    },
    onError: () => {
      toast({ title: "Failed to snooze all alerts", variant: "destructive" });
    },
  });

  const restoreAllMutation = useMutation({
    mutationFn: () =>
      apiFetch("/api/base-items/stock-alerts/dismiss-all", { method: "DELETE" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["base-items-stock-alerts"] });
      toast({ title: "All snoozed alerts restored" });
    },
    onError: () => {
      toast({ title: "Failed to restore all alerts", variant: "destructive" });
    },
  });

  function openSnoozeAllCustom() {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    setSnoozeAllCustom({ open: true, date: tomorrow.toISOString().slice(0, 10) });
  }

  function confirmSnoozeAllCustom() {
    if (!snoozeAllCustom.date) return;
    const expiresAt = new Date(snoozeAllCustom.date);
    expiresAt.setHours(23, 59, 59, 0);
    snoozeAllMutation.mutate({ expires_at: expiresAt.toISOString() });
    setSnoozeAllCustom({ open: false, date: "" });
  }

  function openCustomSnooze(alert: StockAlert) {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    setCustomSnooze({
      open: true,
      alert,
      date: tomorrow.toISOString().slice(0, 10),
    });
  }

  function confirmCustomSnooze() {
    if (!customSnooze.alert || !customSnooze.date) return;
    const expiresAt = new Date(customSnooze.date);
    expiresAt.setHours(23, 59, 59, 0);
    dismissMutation.mutate({
      base_item_id: customSnooze.alert.base_item_id,
      location_id: customSnooze.alert.location_id,
      stock: customSnooze.alert.stock,
      expires_at: expiresAt.toISOString(),
    });
    setCustomSnooze((s) => ({ ...s, open: false, alert: null }));
  }

  const activeAlerts = alerts.filter((a) => !a.dismissed);
  const dismissedAlerts = alerts.filter((a) => a.dismissed);

  const outOfStock = activeAlerts.filter((a) => a.stock === 0);
  const lowStock = activeAlerts.filter((a) => a.stock > 0);

  if (!isLoading && alerts.length === 0) return null;

  const today = new Date().toISOString().slice(0, 10);

  return (
    <>
      <div className="bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 rounded-lg overflow-hidden">
        <button
          className="w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-amber-100/60 dark:hover:bg-amber-900/20 transition-colors"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
        >
          <AlertTriangle size={16} className="text-amber-600 dark:text-amber-400 shrink-0" />
          <span className="text-sm font-semibold text-amber-900 dark:text-amber-200 flex-1">
            Stock Alerts
          </span>
          {isLoading ? (
            <span className="inline-block w-12 h-4 rounded bg-amber-200 dark:bg-amber-800 animate-pulse" />
          ) : (
            <div className="flex items-center gap-2">
              {outOfStock.length > 0 && (
                <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300">
                  {outOfStock.length} out of stock
                </span>
              )}
              {lowStock.length > 0 && (
                <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                  {lowStock.length} low stock
                </span>
              )}
              {dismissedAlerts.length > 0 && (
                <span className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                  <Clock size={10} />
                  {dismissedAlerts.length} snoozed
                </span>
              )}
            </div>
          )}
          <ChevronDown
            size={14}
            className={`shrink-0 text-amber-600 dark:text-amber-400 transition-transform ${collapsed ? "-rotate-90" : ""}`}
          />
        </button>

        {!collapsed && (
          <div className="border-t border-amber-200 dark:border-amber-800">
            {isLoading ? (
              <div className="p-4 space-y-2">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-3">
                    <div className="h-4 w-40 rounded bg-amber-200 dark:bg-amber-800 animate-pulse" />
                    <div className="h-4 w-24 rounded bg-amber-200 dark:bg-amber-800 animate-pulse" />
                    <div className="h-4 w-20 rounded bg-amber-200 dark:bg-amber-800 animate-pulse ml-auto" />
                  </div>
                ))}
              </div>
            ) : (
              <>
                <div className="divide-y divide-amber-100 dark:divide-amber-900/30">
                  {alerts.filter((a) => showDismissed || !a.dismissed).map((alert) => {
                    const isOut = alert.stock === 0;
                    const isDismissed = alert.dismissed;
                    const isPending =
                      dismissMutation.isPending &&
                      dismissMutation.variables?.base_item_id === alert.base_item_id &&
                      dismissMutation.variables?.location_id === alert.location_id;
                    const isRestoring =
                      undismissMutation.isPending &&
                      undismissMutation.variables?.base_item_id === alert.base_item_id &&
                      undismissMutation.variables?.location_id === alert.location_id;

                    return (
                      <div
                        key={`${alert.base_item_id}-${alert.location_id}`}
                        className={`flex items-center gap-1 pr-2 group ${isDismissed ? "opacity-50" : ""}`}
                      >
                        <button
                          className="flex-1 flex items-center gap-3 px-4 py-2.5 text-left hover:bg-amber-100/60 dark:hover:bg-amber-900/20 transition-colors min-w-0"
                          onClick={() => onNavigate(alert.base_item_id)}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="text-sm font-medium text-foreground group-hover:underline truncate">
                                {alert.base_item_name}
                              </span>
                              <span className="text-xs text-muted-foreground shrink-0">
                                {alert.base_item_code}
                              </span>
                            </div>
                            <div className="flex items-center gap-1.5 mt-0.5 text-xs text-muted-foreground">
                              {alert.country && <span>{alert.country}</span>}
                              {alert.country && <span>·</span>}
                              <span>{alert.location_name}</span>
                              {isDismissed && showDismissed && alert.expires_at && (
                                <>
                                  <span>·</span>
                                  <span className="inline-flex items-center gap-0.5 text-blue-500 dark:text-blue-400">
                                    <Clock size={10} />
                                    {formatSnoozeExpiry(alert.expires_at)} left
                                  </span>
                                </>
                              )}
                            </div>
                          </div>
                          <div className="shrink-0 text-right">
                            <div className="flex items-center gap-2 justify-end">
                              <span className="text-sm tabular-nums font-semibold text-foreground">
                                {alert.stock} / {alert.effective_threshold}
                              </span>
                              {!isDismissed && (isOut ? (
                                <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300">
                                  Out of stock · need {alert.effective_threshold}
                                </span>
                              ) : (
                                <span className="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                                  Need {alert.deficit} more
                                </span>
                              ))}
                            </div>
                          </div>
                        </button>

                        {isDismissed ? (
                          <button
                            title="Restore alert"
                            disabled={isRestoring}
                            className="shrink-0 p-1.5 rounded hover:bg-amber-100 dark:hover:bg-amber-900/40 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                            onClick={(e) => {
                              e.stopPropagation();
                              undismissMutation.mutate({
                                base_item_id: alert.base_item_id,
                                location_id: alert.location_id,
                              });
                            }}
                          >
                            <RotateCcw size={13} />
                          </button>
                        ) : (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <button
                                title="Snooze alert"
                                disabled={isPending}
                                className="shrink-0 p-1.5 rounded hover:bg-amber-100 dark:hover:bg-amber-900/40 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 opacity-0 group-hover:opacity-100"
                                onClick={(e) => e.stopPropagation()}
                              >
                                <EyeOff size={13} />
                              </button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-44" onClick={(e) => e.stopPropagation()}>
                              <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
                                Snooze for
                              </DropdownMenuLabel>
                              {SNOOZE_PRESETS.map((preset) => (
                                <DropdownMenuItem
                                  key={preset.hours}
                                  onSelect={() => {
                                    dismissMutation.mutate({
                                      base_item_id: alert.base_item_id,
                                      location_id: alert.location_id,
                                      stock: alert.stock,
                                      duration_hours: preset.hours,
                                    });
                                  }}
                                >
                                  <Clock size={13} className="mr-1.5 text-muted-foreground" />
                                  {preset.label}
                                </DropdownMenuItem>
                              ))}
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onSelect={() => openCustomSnooze(alert)}
                              >
                                <CalendarDays size={13} className="mr-1.5 text-muted-foreground" />
                                Custom date…
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </div>
                    );
                  })}
                </div>

                <div className="px-4 py-2 border-t border-amber-200 dark:border-amber-800 flex items-center gap-3">
                  <button
                    className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                    onClick={() => setShowDismissed((v) => !v)}
                  >
                    {showDismissed ? (
                      <>
                        <Eye size={12} />
                        Hide snoozed
                      </>
                    ) : (
                      <>
                        <Clock size={12} />
                        Show snoozed
                      </>
                    )}
                  </button>

                  {dismissedAlerts.length > 0 && (
                    <button
                      disabled={restoreAllMutation.isPending}
                      className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                      onClick={() => restoreAllMutation.mutate()}
                    >
                      {restoreAllMutation.isPending ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <RotateCcw size={12} />
                      )}
                      Restore all
                    </button>
                  )}

                  {activeAlerts.length > 0 && (
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button
                          disabled={snoozeAllMutation.isPending}
                          className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                        >
                          {snoozeAllMutation.isPending ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : (
                            <EyeOff size={12} />
                          )}
                          Snooze all for…
                          <ChevronDown size={11} />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-44">
                        <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
                          Snooze all active alerts
                        </DropdownMenuLabel>
                        {SNOOZE_PRESETS.map((preset) => (
                          <DropdownMenuItem
                            key={preset.hours}
                            onSelect={() => {
                              snoozeAllMutation.mutate({ duration_hours: preset.hours });
                            }}
                          >
                            <Clock size={13} className="mr-1.5 text-muted-foreground" />
                            {preset.label}
                          </DropdownMenuItem>
                        ))}
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={openSnoozeAllCustom}>
                          <CalendarDays size={13} className="mr-1.5 text-muted-foreground" />
                          Custom date…
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      <Dialog
        open={customSnooze.open}
        onOpenChange={(open) => setCustomSnooze((s) => ({ ...s, open }))}
      >
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle>Snooze until…</DialogTitle>
            <DialogDescription>
              Pick a date to snooze this alert until end of that day.
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <input
              type="date"
              min={today}
              value={customSnooze.date}
              onChange={(e) => setCustomSnooze((s) => ({ ...s, date: e.target.value }))}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setCustomSnooze((s) => ({ ...s, open: false }))}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!customSnooze.date || dismissMutation.isPending}
              onClick={confirmCustomSnooze}
            >
              Snooze
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={snoozeAllCustom.open}
        onOpenChange={(open) => setSnoozeAllCustom((s) => ({ ...s, open }))}
      >
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle>Snooze all until…</DialogTitle>
            <DialogDescription>
              Pick a date to snooze all active alerts until end of that day.
            </DialogDescription>
          </DialogHeader>
          <div className="py-2">
            <input
              type="date"
              min={today}
              value={snoozeAllCustom.date}
              onChange={(e) => setSnoozeAllCustom((s) => ({ ...s, date: e.target.value }))}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSnoozeAllCustom({ open: false, date: "" })}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={!snoozeAllCustom.date || snoozeAllMutation.isPending}
              onClick={confirmSnoozeAllCustom}
            >
              Snooze all
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function exportItemsCsv(items: BaseItem[], filename = "base-items.csv") {
  const headers = ["Code", "Name", "Category", "Type", "Has Image", "Created At"];
  const rows = items.map((item) => {
    const cat = item.sub_category_name
      ? `${item.main_category_name} > ${item.sub_category_name}`
      : (item.main_category_name ?? "");
    const type = inferType(item.main_category_name, item.sub_category_name) ?? "";
    return [
      item.code,
      item.name,
      cat,
      type,
      item.image_url ? "yes" : "no",
      item.created_at,
    ];
  });
  const csv = [headers, ...rows]
    .map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(","))
    .join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function formatDeletionDate(iso: string) {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function ImportDialog({ open, onClose, onSuccess }: { open: boolean; onClose: () => void; onSuccess: () => void }) {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<"upload" | "preview" | "result">("upload");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewData, setPreviewData] = useState<ImportBaseItemsResponse | null>(null);
  const [resultData, setResultData] = useState<ImportBaseItemsResponse | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [importLoading, setImportLoading] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [updateMode, setUpdateMode] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    if (open) {
      setStep("upload");
      setSelectedFile(null);
      setPreviewData(null);
      setResultData(null);
      setFileError(null);
      setIsDragging(false);
      setUpdateMode(false);
    }
  }, [open]);

  const validRows = previewData?.preview_rows?.filter((r) => r.status === "valid") ?? [];
  const updateRows = previewData?.preview_rows?.filter((r) => r.status === "update") ?? [];
  const skippedRows = previewData?.preview_rows?.filter((r) => r.status === "skipped") ?? [];
  const actionableCount = validRows.length + updateRows.length;

  async function handleFileChosen(file: File) {
    const name = file.name.toLowerCase();
    if (!name.endsWith(".xlsx") && !name.endsWith(".xls") && !name.endsWith(".csv")) {
      setFileError(t("baseItems.importFileTypeError"));
      return;
    }
    setSelectedFile(file);
    setFileError(null);
    setPreviewLoading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const qs = updateMode ? "?dry_run=true&update_mode=true" : "?dry_run=true";
      const data = await apiFetch<ImportBaseItemsResponse>(`/api/base-items/import${qs}`, {
        method: "POST",
        body: fd,
      });
      setPreviewData(data);
      setStep("preview");
    } catch (err) {
      setFileError(err instanceof Error ? err.message : t("baseItems.importParseError"));
    } finally {
      setPreviewLoading(false);
    }
  }

  async function handleConfirmImport() {
    if (!selectedFile) return;
    setImportLoading(true);
    try {
      const fd = new FormData();
      fd.append("file", selectedFile);
      const qs = updateMode ? "?update_mode=true" : "";
      const data = await apiFetch<ImportBaseItemsResponse>(`/api/base-items/import${qs}`, {
        method: "POST",
        body: fd,
      });
      setResultData(data);
      setStep("result");
      onSuccess();
    } catch (err) {
      toast({
        title: t("baseItems.importFailed"),
        description: err instanceof Error ? err.message : t("baseItems.importFailed"),
        variant: "destructive",
      });
    } finally {
      setImportLoading(false);
    }
  }

  function handleDownloadTemplate() {
    window.open("/api/base-items/import/template", "_blank");
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFileChosen(file);
  }

  const TEMPLATE_COLS = [
    "Name", "Code", "Category", "Alternate Name",
    "Accounting Category", "Type", "Tax Rate", "Tax Category",
    "Stock", "Low Stock Threshold", "Image URL",
  ];

  function skipReasonLabel(reason: string | undefined | null) {
    if (reason === "name_exists") return t("baseItems.importSkipReasonName");
    if (reason === "code_exists") return t("baseItems.importSkipReasonCode");
    return reason ?? t("baseItems.importSkipReasonUnknown");
  }

  function warnMessageLabel(field: string, message: string) {
    if (message.startsWith("category_not_found:")) {
      return t("baseItems.importWarnCategoryNotFound", { name: message.slice("category_not_found:".length) });
    }
    if (message.startsWith("invalid_tax_category:")) {
      return t("baseItems.importWarnInvalidTaxCategory", { value: message.slice("invalid_tax_category:".length) });
    }
    if (message.startsWith("invalid_image_url:")) {
      return `${field}: ${t("baseItems.importWarnInvalidImageUrl")}`;
    }
    if (message === "code_failed") {
      return t("baseItems.importWarnCodeFailed");
    }
    return `${field}: ${message}`;
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-3xl" style={{ gridTemplateRows: "auto minmax(0,1fr) auto" }}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileSpreadsheet size={18} />
            {t("baseItems.importDialogTitle")}
          </DialogTitle>
          <DialogDescription>
            {step === "upload" && t("baseItems.importDialogDesc")}
            {step === "preview" && t("baseItems.importPreviewSubtitle", { count: validRows.length })}
            {step === "result" && t("baseItems.importResultTitle")}
          </DialogDescription>
        </DialogHeader>

        <div className="overflow-y-auto min-h-0">
          {/* ── Upload step ── */}
          {step === "upload" && (
            <div className="space-y-4 p-1">
              <div>
                <p className="text-sm font-medium mb-2">{t("baseItems.importTemplateTitle")}</p>
                <div className="border rounded-md overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="text-xs w-full">
                      <thead className="bg-muted/50">
                        <tr>
                          {TEMPLATE_COLS.map((col) => (
                            <th key={col} className="px-3 py-2 text-left font-medium whitespace-nowrap border-r last:border-r-0">
                              {col}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        <tr className="text-muted-foreground border-t">
                          <td className="px-3 py-1.5 whitespace-nowrap border-r">Widget A</td>
                          <td className="px-3 py-1.5 whitespace-nowrap border-r">WGT-001</td>
                          <td className="px-3 py-1.5 whitespace-nowrap border-r">Electronics</td>
                          <td className="px-3 py-1.5 whitespace-nowrap border-r"></td>
                          <td className="px-3 py-1.5 whitespace-nowrap border-r"></td>
                          <td className="px-3 py-1.5 whitespace-nowrap border-r">product</td>
                          <td className="px-3 py-1.5 whitespace-nowrap border-r">5</td>
                          <td className="px-3 py-1.5 whitespace-nowrap border-r">standard_taxable</td>
                          <td className="px-3 py-1.5 whitespace-nowrap border-r">100</td>
                          <td className="px-3 py-1.5 whitespace-nowrap border-r">10</td>
                          <td className="px-3 py-1.5 whitespace-nowrap"></td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
                <Button variant="outline" size="sm" className="mt-2" onClick={handleDownloadTemplate}>
                  <Download size={14} className="mr-2" />
                  {t("baseItems.importDownloadTemplate")}
                </Button>
              </div>

              <div className="flex items-center gap-3 p-3 border rounded-md bg-muted/30">
                <button
                  type="button"
                  role="switch"
                  aria-checked={updateMode}
                  onClick={() => setUpdateMode((v) => !v)}
                  className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 ${updateMode ? "bg-primary" : "bg-input"}`}
                >
                  <span
                    className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${updateMode ? "translate-x-4" : "translate-x-0"}`}
                  />
                </button>
                <span className="text-sm">
                  {updateMode ? t("baseItems.importModeUpdate") : t("baseItems.importModeSkip")}
                </span>
              </div>

              <div
                className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors cursor-pointer ${isDragging ? "border-primary bg-primary/5" : "border-muted-foreground/25 hover:border-muted-foreground/50"}`}
                onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
                onDragLeave={() => setIsDragging(false)}
                onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
              >
                {previewLoading ? (
                  <div className="flex flex-col items-center gap-2 text-muted-foreground">
                    <Loader2 size={32} className="animate-spin" />
                    <p className="text-sm">{t("baseItems.importParsing")}</p>
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-2 text-muted-foreground">
                    <Upload size={32} />
                    <p className="text-sm font-medium">{t("baseItems.importDropzoneText")}</p>
                    <p className="text-xs">{t("baseItems.importDropzoneHint")}</p>
                  </div>
                )}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void handleFileChosen(f);
                    e.target.value = "";
                  }}
                />
              </div>
              {fileError && (
                <p className="text-sm text-destructive flex items-center gap-1.5">
                  <AlertTriangle size={14} /> {fileError}
                </p>
              )}

            </div>
          )}

          {/* ── Preview step ── */}
          {step === "preview" && previewData && (
            <div className="space-y-3 p-1">
              <div className="flex items-center gap-4 text-sm flex-wrap">
                <span className="flex items-center gap-1.5 text-emerald-600">
                  <CheckCheck size={14} /> {t("baseItems.importPreviewSubtitle", { count: validRows.length })}
                </span>
                {updateRows.length > 0 && (
                  <span className="flex items-center gap-1.5 text-blue-600">
                    <RefreshCw size={14} /> {t("baseItems.importPreviewUpdates", { count: updateRows.length })}
                  </span>
                )}
                {skippedRows.length > 0 && (
                  <span className="flex items-center gap-1.5 text-amber-600">
                    <SkipForward size={14} /> {t("baseItems.importResultSkipped", { count: skippedRows.length })}
                  </span>
                )}
                {previewData.warnings.length > 0 && (
                  <span className="flex items-center gap-1.5 text-yellow-600">
                    <TriangleAlert size={14} /> {t("baseItems.importResultWarnings", { count: previewData.warnings.length })}
                  </span>
                )}
              </div>
              <div className="border rounded-md overflow-hidden">
                <div className="overflow-x-auto max-h-72">
                  <table className="text-xs w-full">
                    <thead className="bg-muted/50 sticky top-0">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium border-r w-12">#</th>
                        <th className="px-3 py-2 text-left font-medium border-r">{t("baseItems.importColName")}</th>
                        <th className="px-3 py-2 text-left font-medium border-r">{t("baseItems.importColCode")}</th>
                        <th className="px-3 py-2 text-left font-medium border-r">{t("baseItems.importColCategory")}</th>
                        <th className="px-3 py-2 text-left font-medium">{t("baseItems.importColStatus")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(previewData.preview_rows ?? []).map((row) => (
                        <tr key={row.row} className="border-t hover:bg-muted/30">
                          <td className="px-3 py-1.5 border-r text-muted-foreground">{row.row}</td>
                          <td className="px-3 py-1.5 border-r font-medium">{row.name}</td>
                          <td className="px-3 py-1.5 border-r text-muted-foreground">{row.code ?? "—"}</td>
                          <td className="px-3 py-1.5 border-r text-muted-foreground">{row.category ?? "—"}</td>
                          <td className="px-3 py-1.5">
                            {row.status === "valid" ? (
                              <Badge variant="outline" className="text-emerald-600 border-emerald-200 bg-emerald-50 text-[10px]">
                                {t("baseItems.importStatusValid")}
                              </Badge>
                            ) : row.status === "update" ? (
                              <Badge variant="outline" className="text-blue-600 border-blue-200 bg-blue-50 text-[10px]">
                                {t("baseItems.importStatusUpdate")}
                              </Badge>
                            ) : row.status === "error" ? (
                              <Badge variant="outline" className="text-destructive border-red-200 bg-red-50 text-[10px]">
                                {row.error_reason === "missing_name" ? t("baseItems.importStatusErrorMissingName") : t("baseItems.importStatusError")}
                              </Badge>
                            ) : (
                              <Badge variant="outline" className="text-amber-600 border-amber-200 bg-amber-50 text-[10px]">
                                {skipReasonLabel(row.skip_reason)}
                              </Badge>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              {previewData.warnings.length > 0 && (
                <div className="text-xs text-muted-foreground space-y-0.5">
                  <p className="font-medium">{t("baseItems.importResultWarningsTitle")}</p>
                  {previewData.warnings.map((w, i) => (
                    <p key={i}>• {t("baseItems.importWarningRowText", { row: w.row, field: w.field, message: warnMessageLabel(w.field, w.message) })}</p>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Result step ── */}
          {step === "result" && resultData && (
            <div className="space-y-4 p-1">
              <div className="grid grid-cols-4 gap-3">
                <div className="border rounded-lg p-4 text-center">
                  <p className="text-2xl font-bold text-emerald-600">{resultData.created}</p>
                  <p className="text-xs text-muted-foreground mt-1">{t("baseItems.importResultCreatedLabel")}</p>
                </div>
                <div className="border rounded-lg p-4 text-center">
                  <p className="text-2xl font-bold text-blue-600">{resultData.updated ?? 0}</p>
                  <p className="text-xs text-muted-foreground mt-1">{t("baseItems.importResultUpdatedLabel")}</p>
                </div>
                <div className="border rounded-lg p-4 text-center">
                  <p className="text-2xl font-bold text-amber-600">{resultData.skipped.length}</p>
                  <p className="text-xs text-muted-foreground mt-1">{t("baseItems.importResultSkippedLabel")}</p>
                </div>
                <div className="border rounded-lg p-4 text-center">
                  <p className="text-2xl font-bold text-yellow-600">{resultData.warnings.length}</p>
                  <p className="text-xs text-muted-foreground mt-1">{t("baseItems.importResultWarningsLabel")}</p>
                </div>
              </div>
              {resultData.skipped.length > 0 && (
                <div className="space-y-1">
                  <p className="text-xs font-medium">{t("baseItems.importResultSkippedTitle")}</p>
                  <div className="border rounded-md max-h-40 overflow-y-auto">
                    <table className="text-xs w-full">
                      <tbody>
                        {resultData.skipped.map((s, i) => (
                          <tr key={i} className="border-t first:border-t-0">
                            <td className="px-3 py-1.5 font-medium">{s.name}</td>
                            <td className="px-3 py-1.5 text-muted-foreground">{skipReasonLabel(s.reason)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
              {resultData.warnings.length > 0 && (
                <div className="text-xs text-muted-foreground space-y-0.5">
                  <p className="font-medium">{t("baseItems.importResultWarningsTitle")}</p>
                  {resultData.warnings.map((w, i) => (
                    <p key={i}>• {t("baseItems.importWarningRowText", { row: w.row, field: w.field, message: warnMessageLabel(w.field, w.message) })}</p>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter className="gap-2">
          {step === "upload" && (
            <Button variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
          )}
          {step === "preview" && (
            <>
              <Button variant="outline" onClick={() => setStep("upload")} disabled={importLoading}>
                {t("common.back")}
              </Button>
              <Button onClick={() => void handleConfirmImport()} disabled={importLoading || actionableCount === 0}>
                {importLoading ? <Loader2 size={14} className="mr-2 animate-spin" /> : <Upload size={14} className="mr-2" />}
                {t("baseItems.importConfirmButton", { count: actionableCount })}
              </Button>
            </>
          )}
          {step === "result" && (
            <Button onClick={onClose}>{t("common.done")}</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeletionHistoryDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const limit = 25;

  useEffect(() => {
    if (open) setPage(1);
  }, [open]);

  const { data, isLoading, isError } = useListBaseItemDeletionHistory(
    { page, limit },
    { query: { enabled: open, queryKey: getListBaseItemDeletionHistoryQueryKey({ page, limit }) } },
  );
  const entries: BaseItemDeletionHistoryEntry[] = data?.entries ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("baseItems.deletionHistoryTitle")}</DialogTitle>
          <DialogDescription>{t("baseItems.deletionHistoryDesc")}</DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-10 justify-center">
            <Loader2 size={14} className="animate-spin" />
            {t("baseItems.deletionHistoryLoading")}
          </div>
        ) : isError ? (
          <div className="py-10 text-center text-sm text-destructive">
            {t("baseItems.deletionHistoryLoadError")}
          </div>
        ) : entries.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            {t("baseItems.deletionHistoryEmpty")}
          </div>
        ) : (
          <div className="rounded-lg border border-border overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("baseItems.deletionHistoryColItem")}</TableHead>
                  <TableHead>{t("baseItems.deletionHistoryColCategory")}</TableHead>
                  <TableHead>{t("baseItems.deletionHistoryColDeletedBy")}</TableHead>
                  <TableHead>{t("baseItems.deletionHistoryColWhen")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {entries.map((entry) => (
                  <TableRow key={entry.id} data-testid={`row-deletion-${entry.id}`}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        {entry.item_image_url ? (
                          <img
                            src={entry.item_image_url}
                            alt=""
                            className="h-9 w-9 rounded object-cover border border-border shrink-0"
                          />
                        ) : (
                          <div className="h-9 w-9 rounded bg-muted border border-border shrink-0" />
                        )}
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">
                            {entry.item_name || t("baseItems.deletionHistoryUnnamedItem")}
                          </p>
                          {entry.item_code && (
                            <p className="text-xs text-muted-foreground truncate">{entry.item_code}</p>
                          )}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {entry.item_category || "—"}
                    </TableCell>
                    <TableCell className="text-sm">
                      {entry.actor_name || t("baseItems.deletionHistoryUnknownActor")}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                      {formatDeletionDate(entry.created_at)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {totalPages > 1 && (
          <div className="flex items-center justify-between pt-2">
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
            >
              <ChevronLeft size={13} />
              {t("baseItems.deletionHistoryPrev")}
            </Button>
            <span className="text-xs text-muted-foreground">
              {page} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
            >
              {t("baseItems.deletionHistoryNext")}
              <ChevronRight size={13} />
            </Button>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("baseItems.deletionHistoryClose")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function BaseItemsPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const { isOwner, allowedPages } = useWorkspaceRole();
  const canManage = isOwner || (allowedPages?.includes("base_items.manage") ?? false);
  const { t } = useTranslation();

  const [searchParams, setSearchParams] = useSearchParams();
  const [searchInput, setSearchInput] = useState(() => searchParams.get("q") ?? "");

  const selectedMainCategoryId = searchParams.get("main_cat") ?? "";
  const selectedSubCategoryId = searchParams.get("sub_cat") ?? "";
  const q = searchParams.get("q") ?? "";
  const imageStatus = searchParams.get("img") ?? "";
  const sort = searchParams.get("sort") ?? "newest";
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10) || 1);
  const typeFilter = searchParams.get("type") ?? "";
  const catFilter = searchParams.get("cat") ?? "";
  const statusFilter = searchParams.get("status") ?? "active";

  function setParam(key: string, value: string) {
    setSearchParams(
      (prev: URLSearchParams) => {
        const next = new URLSearchParams(prev);
        if (value) { next.set(key, value); } else { next.delete(key); }
        return next;
      },
      { replace: true },
    );
  }

  function setSelectedMainCategoryId(value: string) {
    setSearchParams(
      (prev: URLSearchParams) => {
        const next = new URLSearchParams(prev);
        if (value) { next.set("main_cat", value); } else { next.delete("main_cat"); }
        next.delete("sub_cat");
        next.delete("page");
        return next;
      },
      { replace: true },
    );
  }

  function setSelectedSubCategoryId(value: string) {
    setSearchParams(
      (prev: URLSearchParams) => {
        const next = new URLSearchParams(prev);
        if (value) { next.set("sub_cat", value); } else { next.delete("sub_cat"); }
        next.delete("page");
        return next;
      },
      { replace: true },
    );
  }

  useEffect(() => {
    setSearchInput((current) => (current !== q ? q : current));
  }, [q]);

  useEffect(() => {
    const id = setTimeout(() => {
      setSearchParams(
        (prev: URLSearchParams) => {
          const next = new URLSearchParams(prev);
          if (searchInput) { next.set("q", searchInput); } else { next.delete("q"); }
          next.delete("page");
          return next;
        },
        { replace: true },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [searchInput]);

  const { data: categoriesData, isLoading: categoriesLoading } = useQuery<{ categories: MainCategory[] }>({
    queryKey: ["base-item-categories"],
    queryFn: () => apiFetch("/api/base-item-categories?status=active"),
  });
  const categories = useMemo(
    () => (categoriesData?.categories ?? [])
      .filter((main) => main.status === undefined || main.status === "active")
      .map((main) => ({
        ...main,
        subcategories: main.subcategories.filter(
          (sub) => sub.status === undefined || sub.status === "active",
        ),
      })),
    [categoriesData],
  );
  const selectedMain = categories.find((c) => String(c.id) === selectedMainCategoryId) ?? null;
  const subCategories = selectedMain?.subcategories ?? [];

  const { data: summaryData, isLoading: summaryLoading } = useQuery<BaseItemSummary>({
    queryKey: ["base-items-summary"],
    queryFn: () => apiFetch("/api/base-items/summary"),
  });

  const { data: spendSummaryData, isLoading: spendSummaryLoading } = useQuery<BaseItemSpendSummary>({
    queryKey: ["base-items-spend-summary"],
    queryFn: () => apiFetch("/api/base-items/spend-summary"),
  });

  const { data: spendBreakdownData, isLoading: spendBreakdownLoading } = useQuery<{ items: SpendBreakdownItem[] }>({
    queryKey: ["base-items-spend-breakdown"],
    queryFn: () => apiFetch("/api/base-items/spend-breakdown?limit=10"),
  });

  const queryParts: string[] = [];
  if (q) queryParts.push(`q=${encodeURIComponent(q)}`);
  if (catFilter === "none") {
    queryParts.push(`category_id=none`);
  } else if (selectedSubCategoryId) {
    queryParts.push(`category_id=${encodeURIComponent(selectedSubCategoryId)}`);
  } else if (selectedMainCategoryId) {
    queryParts.push(`main_category_id=${encodeURIComponent(selectedMainCategoryId)}`);
  } else if (typeFilter) {
    queryParts.push(`type=${encodeURIComponent(typeFilter)}`);
  }
  if (imageStatus) queryParts.push(`image_status=${encodeURIComponent(imageStatus)}`);
  if (sort && sort !== "newest") queryParts.push(`sort=${encodeURIComponent(sort)}`);
  if (statusFilter && statusFilter !== "active") queryParts.push(`status=${encodeURIComponent(statusFilter)}`);
  queryParts.push(`page=${page}`);
  queryParts.push(`limit=${PAGE_SIZE}`);
  const queryParams = `?${queryParts.join("&")}`;

  const { data, isLoading } = useQuery<{ items: BaseItem[]; total: number; page: number; pageSize: number }>({
    queryKey: ["base-items", q, selectedMainCategoryId, selectedSubCategoryId, page, sort, imageStatus, typeFilter, catFilter, statusFilter],
    queryFn: () => apiFetch(`/api/base-items${queryParams}`),
  });
  const items = data?.items ?? [];
  const total = data?.total ?? items.length;
  const currentPage = data?.page ?? page;
  const pageSize = data?.pageSize ?? PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  const hasActiveFilters = !!(q || selectedMainCategoryId || imageStatus || sort !== "newest" || typeFilter || catFilter || statusFilter !== "active");

  function clearFilters() {
    setSearchInput("");
    setSearchParams(
      (prev: URLSearchParams) => {
        const next = new URLSearchParams(prev);
        next.delete("q");
        next.delete("main_cat");
        next.delete("sub_cat");
        next.delete("img");
        next.delete("sort");
        next.delete("page");
        next.delete("type");
        next.delete("cat");
        next.delete("status");
        return next;
      },
      { replace: true },
    );
  }

  function setSummaryFilter(type: "flower" | "packaging" | "none" | "total") {
    setSearchParams(
      (prev: URLSearchParams) => {
        const next = new URLSearchParams(prev);
        next.delete("main_cat");
        next.delete("sub_cat");
        next.delete("type");
        next.delete("cat");
        next.delete("page");
        if (type === "flower") next.set("type", "flower");
        else if (type === "packaging") next.set("type", "packaging");
        else if (type === "none") next.set("cat", "none");
        return next;
      },
      { replace: true },
    );
  }

  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  function toggleSelect(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); } else { next.add(id); }
      return next;
    });
  }

  function toggleSelectAll() {
    if (selectedIds.size === items.length && items.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(items.map((i) => i.id)));
    }
  }

  const allSelected = items.length > 0 && selectedIds.size === items.length;
  const someSelected = selectedIds.size > 0 && selectedIds.size < items.length;

  useEffect(() => {
    setSelectedIds(new Set());
  }, [q, selectedMainCategoryId, selectedSubCategoryId, page, sort, imageStatus]);

  // Default to hidden; server preference is the source of truth.
  // This ensures that when the server is unavailable the column stays hidden as required.
  const { value: showSpendColumn, set: setShowSpendColumn } = useUserPreference<boolean>("show_spend_column", false);

  function handleToggleSpendColumn() {
    setShowSpendColumn(!showSpendColumn);
  }

  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<BaseItem | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<BaseItem | null>(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [deletionHistoryOpen, setDeletionHistoryOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  // Bulk action modals
  const [mergeOpen, setMergeOpen] = useState(false);
  const [bulkCategoryOpen, setBulkCategoryOpen] = useState(false);
  const [bulkTypeOpen, setBulkTypeOpen] = useState(false);
  const [bulkArchiveOpen, setBulkArchiveOpen] = useState(false);
  const [bulkAddSupplierOpen, setBulkAddSupplierOpen] = useState(false);
  const [bulkRemoveSupplierOpen, setBulkRemoveSupplierOpen] = useState(false);

  // Row-level action modals
  const [usageTarget, setUsageTarget] = useState<BaseItem | null>(null);
  const [rowCategoryTarget, setRowCategoryTarget] = useState<BaseItem | null>(null);
  const [rowTypeTarget, setRowTypeTarget] = useState<BaseItem | null>(null);
  const [rowArchiveTarget, setRowArchiveTarget] = useState<BaseItem | null>(null);

  const duplicateMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ item: { id: number; name: string; code: string } }>(`/api/base-items/${id}/duplicate`, { method: "POST" }),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["base-items"] });
      toast({
        title: "Base item duplicated",
        description: `Created "${data.item.name}" (${data.item.code})`,
        action: (
          <button
            onClick={() => navigate(`/base-items/${data.item.id}`)}
            className="text-xs underline"
          >
            View
          </button>
        ),
      });
    },
    onError: () => {
      toast({ title: "Failed to duplicate", variant: "destructive" });
    },
  });

  const createMutation = useMutation({
    mutationFn: (form: BaseItemFormState) =>
      apiFetch("/api/base-items", {
        method: "POST",
        body: JSON.stringify({
          name: form.name.trim(),
          image_url: form.image_url || null,
          category_id: form.category_id ? parseInt(form.category_id, 10) : null,
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["base-items"] });
      qc.invalidateQueries({ queryKey: ["base-items-summary"] });
      qc.invalidateQueries({ queryKey: ["base-items-spend-summary"] });
      qc.invalidateQueries({ queryKey: ["base-items-spend-breakdown"] });
      setCreateOpen(false);
      toast({ title: "Base item created" });
    },
    onError: () => {
      toast({ title: "Failed to create", description: "Could not create base item. Please try again.", variant: "destructive" });
    },
  });

  const editMutation = useMutation({
    mutationFn: ({ id, form }: { id: number; form: BaseItemFormState }) =>
      apiFetch(`/api/base-items/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: form.name.trim(),
          image_url: form.image_url || null,
          category_id: form.category_id ? parseInt(form.category_id, 10) : null,
          alternate_name: form.alternate_name.trim() || null,
          accounting_category: form.accounting_category.trim() || null,
          tax_rate: form.tax_rate.trim() || null,
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["base-items"] });
      qc.invalidateQueries({ queryKey: ["base-items-summary"] });
      qc.invalidateQueries({ queryKey: ["base-items-spend-summary"] });
      qc.invalidateQueries({ queryKey: ["base-items-spend-breakdown"] });
      setEditTarget(null);
      toast({ title: "Base item updated" });
    },
    onError: () => {
      toast({ title: "Failed to update", description: "Could not update base item. Please try again.", variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/base-items/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["base-items"] });
      qc.invalidateQueries({ queryKey: ["base-items-summary"] });
      qc.invalidateQueries({ queryKey: ["base-items-spend-summary"] });
      qc.invalidateQueries({ queryKey: ["base-items-spend-breakdown"] });
      setDeleteTarget(null);
      setDeleteConfirmText("");
      toast({ title: t("baseItems.deletedToast") });
    },
    onError: () => {
      toast({ title: t("baseItems.deleteFailedTitle"), description: t("baseItems.deleteFailedDesc"), variant: "destructive" });
    },
  });

  function itemToForm(item: BaseItem): BaseItemFormState {
    return {
      name: item.name,
      image_url: item.image_url,
      category_id: item.category_id ? String(item.category_id) : "",
      alternate_name: item.alternate_name ?? "",
      accounting_category: item.accounting_category ?? "",
      tax_rate: item.tax_rate ?? "",
    };
  }

  const fromItem = (page - 1) * pageSize + 1;
  const toItem = Math.min(page * pageSize, total);

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Base Items</h1>
          <p className="text-muted-foreground mt-1">
            Reusable ingredients, packaging, and components used in product recipes.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <StaleDataBadge
            queries={[{ queryKey: ["base-items"], url: "/api/base-items" }]}
            data-testid="base-items-stale-badge"
          />
          <Button
            variant="outline"
            onClick={() => exportItemsCsv(items)}
            disabled={items.length === 0}
          >
            <Download size={15} className="mr-2" />
            Export
          </Button>
          {isOwner && (
            <Button
              variant="outline"
              onClick={() => setImportOpen(true)}
              data-testid="button-import"
            >
              <Upload size={15} className="mr-2" />
              {t("baseItems.importButton")}
            </Button>
          )}
          {isOwner && (
            <Button
              variant="outline"
              onClick={() => setDeletionHistoryOpen(true)}
              data-testid="button-deletion-history"
            >
              <Clock size={15} className="mr-2" />
              {t("baseItems.deletionHistory")}
            </Button>
          )}
          {canManage && (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus size={16} className="mr-2" />
              New Base Item
            </Button>
          )}
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
        <SummaryCard
          label="Total Base Items"
          value={summaryData?.total ?? 0}
          loading={summaryLoading}
          icon={<FlaskConical size={18} className="text-muted-foreground" />}
          active={!typeFilter && !catFilter && !selectedMainCategoryId}
          onClick={() => setSummaryFilter("total")}
        />
        <SummaryCard
          label="Flower Items"
          value={summaryData?.flower ?? 0}
          loading={summaryLoading}
          icon={<Flower2 size={18} className="text-pink-500" />}
          active={typeFilter === "flower"}
          onClick={() => setSummaryFilter(typeFilter === "flower" ? "total" : "flower")}
        />
        <SummaryCard
          label="Packaging Items"
          value={summaryData?.packaging ?? 0}
          loading={summaryLoading}
          icon={<Package size={18} className="text-amber-500" />}
          active={typeFilter === "packaging"}
          onClick={() => setSummaryFilter(typeFilter === "packaging" ? "total" : "packaging")}
        />
        <SummaryCard
          label="Uncategorized"
          value={summaryData?.uncategorized ?? 0}
          loading={summaryLoading}
          icon={<HelpCircle size={18} className="text-muted-foreground" />}
          active={catFilter === "none"}
          onClick={() => setSummaryFilter(catFilter === "none" ? "total" : "none")}
        />
        <SpendSummaryCard
          totalSpend={spendSummaryData?.total_spend}
          spendYtd={spendSummaryData?.spend_ytd}
          loading={spendSummaryLoading}
        />
      </div>

      {/* Top Spenders panel — hidden when there is no spend data */}
      <TopSpendersPanel
        items={spendBreakdownData?.items ?? []}
        loading={spendBreakdownLoading}
        onNavigate={(id) => navigate(`/base-items/${id}`)}
      />

      {/* Stock Alerts panel — hidden when no active alerts */}
      <StockAlertsPanel
        onNavigate={(id) => navigate(`/base-items/${id}?tab=inventory`)}
      />

      {/* Filter bar — category selects come FIRST so combobox[0] = main_cat */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Search by name or code…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="pl-8"
          />
        </div>

        <Select
          value={statusFilter || "active"}
          onValueChange={(v) => { setParam("status", v === "active" ? "" : v); setParam("page", ""); setSelectedIds(new Set()); }}
        >
          <SelectTrigger className="w-36">
            <SelectValue placeholder="Status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="archived">Archived</SelectItem>
            <SelectItem value="merged">Merged</SelectItem>
            <SelectItem value="all">All statuses</SelectItem>
          </SelectContent>
        </Select>

        {categories.length > 0 && (
          <Select
            value={selectedMainCategoryId || "all"}
            onValueChange={(v) => {
              const next = v === "all" ? "" : v;
              setSelectedMainCategoryId(next);
              setSelectedSubCategoryId("");
            }}
          >
            <SelectTrigger className="w-40">
              <SelectValue placeholder="Category" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {categories.map((cat) => (
                <SelectItem key={cat.id} value={String(cat.id)}>
                  {cat.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        {selectedMain && subCategories.length > 0 && (
          <Select
            value={selectedSubCategoryId || "all"}
            onValueChange={(v) => setSelectedSubCategoryId(v === "all" ? "" : v)}
          >
            <SelectTrigger className="w-40">
              <SelectValue placeholder="Subcategory" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All subcategories</SelectItem>
              {subCategories.map((sub) => (
                <SelectItem key={sub.id} value={String(sub.id)}>
                  {sub.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <Select
          value={imageStatus || "all"}
          onValueChange={(v) => setParam("img", v === "all" ? "" : v)}
        >
          <SelectTrigger className="w-36">
            <SelectValue placeholder="Image" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All images</SelectItem>
            <SelectItem value="has">Has image</SelectItem>
            <SelectItem value="missing">Missing image</SelectItem>
          </SelectContent>
        </Select>

        <Select
          value={sort || "newest"}
          onValueChange={(v) => { setParam("sort", v === "newest" ? "" : v); setParam("page", ""); }}
        >
          <SelectTrigger className="w-40">
            <SelectValue placeholder="Sort" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="newest">Newest first</SelectItem>
            <SelectItem value="oldest">Oldest first</SelectItem>
            <SelectItem value="name_asc">Name A–Z</SelectItem>
            <SelectItem value="name_desc">Name Z–A</SelectItem>
            <SelectItem value="category">By category</SelectItem>
            <SelectItem value="updated">Recently updated</SelectItem>
            <SelectItem value="spend_desc">Highest spend</SelectItem>
            <SelectItem value="spend_asc">Lowest spend</SelectItem>
          </SelectContent>
        </Select>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-10 gap-1.5">
              <Columns3 size={14} />
              Columns
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem
              className="flex items-center justify-between cursor-pointer"
              onSelect={(e) => { e.preventDefault(); handleToggleSpendColumn(); }}
            >
              <span className="flex items-center gap-2">
                <Receipt size={14} className="text-muted-foreground" />
                Total Spend
              </span>
              <span className={`text-xs px-1.5 py-0.5 rounded-full ${showSpendColumn ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                {showSpendColumn ? "On" : "Off"}
              </span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {hasActiveFilters && (
          <Button
            variant="ghost"
            size="sm"
            className="h-10 px-3 text-muted-foreground"
            onClick={clearFilters}
          >
            <X size={14} className="mr-1.5" />Clear
          </Button>
        )}
      </div>

      {/* Bulk action bar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-2 flex-wrap px-4 py-2.5 bg-primary/5 border border-primary/20 rounded-lg">
          <span className="text-sm font-medium shrink-0">{selectedIds.size} item{selectedIds.size !== 1 ? "s" : ""} selected</span>
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const selectedItems = items.filter((i) => selectedIds.has(i.id));
                exportItemsCsv(selectedItems, "base-items-selected.csv");
              }}
            >
              <Download size={14} className="mr-1.5" />
              Export Selected
            </Button>
            {canManage && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setMergeOpen(true)}
                  disabled={selectedIds.size < 2}
                >
                  <GitMerge size={14} className="mr-1.5" />
                  Merge Base Items
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setBulkCategoryOpen(true)}
                >
                  Update Category
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" variant="outline">
                      More Actions
                      <ChevronDown size={14} className="ml-1.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => setBulkTypeOpen(true)}>
                      Update Type
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => setBulkAddSupplierOpen(true)}>
                      Add Supplier
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setBulkRemoveSupplierOpen(true)}>
                      Remove Supplier
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="text-destructive focus:text-destructive"
                      onClick={() => setBulkArchiveOpen(true)}
                    >
                      <Archive size={14} className="mr-2" />
                      Archive Items
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </>
            )}
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto text-muted-foreground shrink-0"
            onClick={() => setSelectedIds(new Set())}
          >
            <X size={14} />
          </Button>
        </div>
      )}

      {/* Table or empty states */}
      {isLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
          <Loader2 size={16} className="animate-spin" />
          Loading base items…
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-12 text-center">
          <FlaskConical size={32} className="mx-auto mb-3 text-muted-foreground" />
          {hasActiveFilters ? (
            <>
              <p className="font-medium">No base items match your filters</p>
              <p className="text-sm text-muted-foreground mt-1">Try adjusting your search or filter selection.</p>
              <Button variant="outline" className="mt-4" onClick={clearFilters}>
                Clear filters
              </Button>
            </>
          ) : (
            <>
              <p className="font-medium">No base items yet</p>
              <p className="text-sm text-muted-foreground mt-1">
                Add base items to build your product recipes.
              </p>
              {canManage && (
                <Button className="mt-4" onClick={() => setCreateOpen(true)}>
                  <Plus size={16} className="mr-2" />
                  New Base Item
                </Button>
              )}
            </>
          )}
        </div>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10 pl-4">
                  <Checkbox
                    checked={allSelected}
                    data-state={someSelected ? "indeterminate" : allSelected ? "checked" : "unchecked"}
                    onCheckedChange={toggleSelectAll}
                    aria-label="Select all"
                  />
                </TableHead>
                <TableHead className="w-14">Image</TableHead>
                <TableHead>Name</TableHead>
                <TableHead className="hidden md:table-cell">Category</TableHead>
                <TableHead className="hidden lg:table-cell">Type</TableHead>
                <TableHead className="hidden xl:table-cell">Status</TableHead>
                <TableHead className="hidden xl:table-cell w-28 text-right">Used In</TableHead>
                {showSpendColumn && (
                  <TableHead className="hidden lg:table-cell w-36 text-right">
                    <span className="flex items-center justify-end gap-1">
                      <Receipt size={12} className="text-muted-foreground" />
                      Total Spend
                    </span>
                  </TableHead>
                )}
                <TableHead className="hidden lg:table-cell w-32">Added</TableHead>
                <TableHead className="w-20 text-right pr-4">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => {
                const thumb = imageUrl(item.image_url);
                const categoryLabel = item.sub_category_name
                  ? `${item.main_category_name} › ${item.sub_category_name}`
                  : item.main_category_name;
                const isChecked = selectedIds.has(item.id);

                return (
                  <TableRow
                    key={item.id}
                    data-testid={`base-item-row-${item.id}`}
                    className={isChecked ? "bg-primary/5" : undefined}
                  >
                    <TableCell className="pl-4">
                      <Checkbox
                        checked={isChecked}
                        onCheckedChange={() => toggleSelect(item.id)}
                        aria-label={`Select ${item.name}`}
                        onClick={(e) => e.stopPropagation()}
                      />
                    </TableCell>
                    <TableCell>
                      <div className="cursor-pointer" onClick={() => navigate(`/base-items/${item.id}`)}>
                        <BaseItemImageThumbnail imageUrl={thumb} name={item.name} size={12} />
                      </div>
                    </TableCell>
                    <TableCell>
                      <div
                        className="cursor-pointer"
                        onClick={() => navigate(`/base-items/${item.id}`)}
                      >
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-medium text-sm">{item.name}</span>
                          <span className="font-mono text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded tracking-widest">
                            {item.code}
                          </span>
                        </div>
                        <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                          <StockLevelBadge stock={item.stock} threshold={item.low_stock_threshold} />
                          {categoryLabel && (
                            <span className="text-xs text-muted-foreground md:hidden">{categoryLabel}</span>
                          )}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-sm text-muted-foreground">
                      {categoryLabel ?? <span className="italic">—</span>}
                    </TableCell>
                    <TableCell className="hidden lg:table-cell">
                      <TypeBadge main={item.main_category_name} sub={item.sub_category_name} />
                    </TableCell>
                    <TableCell className="hidden xl:table-cell">
                      <div className="flex flex-col gap-1">
                        <StatusBadge status={item.status} />
                        {item.status === "merged" && item.merged_into_name && (
                          <span className="text-xs text-muted-foreground truncate max-w-[140px]" title={item.merged_into_name}>
                            → {item.merged_into_name}
                          </span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="hidden xl:table-cell text-sm text-right text-muted-foreground tabular-nums">
                      {item.used_in_products != null && item.used_in_products > 0 ? item.used_in_products : "—"}
                    </TableCell>
                    {showSpendColumn && (
                      <TableCell className="hidden lg:table-cell text-sm text-right tabular-nums">
                        <div className="flex flex-col items-end gap-1">
                          <div className="flex flex-col items-end">
                            <span
                              className={parseFloat(item.total_spend ?? "0") > 0 ? "font-medium text-foreground" : "text-muted-foreground"}
                            >
                              {formatSpend(item.total_spend)}
                            </span>
                            <span className="text-[10px] text-muted-foreground leading-none">All-time</span>
                          </div>
                          {parseFloat(item.spend_ytd ?? "0") > 0 && (
                            <div className="flex flex-col items-end border-t border-border pt-1">
                              <span className="text-xs font-medium text-foreground tabular-nums">
                                {formatSpend(item.spend_ytd)}
                              </span>
                              <span className="text-[10px] text-muted-foreground leading-none">YTD</span>
                            </div>
                          )}
                        </div>
                      </TableCell>
                    )}
                    <TableCell className="hidden lg:table-cell text-sm text-muted-foreground">
                      {formatDate(item.created_at)}
                    </TableCell>
                    <TableCell className="text-right pr-4">
                      {canManage && (
                        <div className="flex items-center justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-8 w-8 p-0"
                            title="Edit"
                            data-testid={`button-edit-base-item-${item.id}`}
                            onClick={() => setEditTarget(item)}
                          >
                            <Pencil size={14} />
                          </Button>
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button size="sm" variant="ghost" className="h-8 w-8 p-0">
                                <MoreHorizontal size={14} />
                                <span className="sr-only">More actions</span>
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem
                                onClick={() => duplicateMutation.mutate(item.id)}
                              >
                                <Copy size={14} className="mr-2" />
                                Duplicate
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => setUsageTarget(item)}
                              >
                                <Eye size={14} className="mr-2" />
                                View Usage
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onClick={() => setRowCategoryTarget(item)}
                              >
                                Update Category
                              </DropdownMenuItem>
                              <DropdownMenuItem
                                onClick={() => setRowTypeTarget(item)}
                              >
                                Update Type
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              {item.status !== "archived" && item.status !== "merged" && (
                                <DropdownMenuItem
                                  className="text-amber-600 focus:text-amber-600 dark:text-amber-400"
                                  onClick={() => setRowArchiveTarget(item)}
                                >
                                  <Archive size={14} className="mr-2" />
                                  Archive
                                </DropdownMenuItem>
                              )}
                              {isOwner && (
                                <DropdownMenuItem
                                  className="text-destructive focus:text-destructive"
                                  onClick={() => { setDeleteTarget(item); setDeleteConfirmText(""); }}
                                >
                                  <Trash2 size={14} className="mr-2" />
                                  {t("baseItems.deleteAction")}
                                </DropdownMenuItem>
                              )}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Pagination */}
      {total > 0 && (
        <div className="flex items-center justify-between gap-4 py-1">
          <p className="text-sm text-muted-foreground">
            {total === 0 ? "No items" : `Showing ${fromItem}–${toItem} of ${total} item${total !== 1 ? "s" : ""}`}
          </p>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              className="h-8 w-8 p-0"
              disabled={currentPage <= 1}
              onClick={() => setParam("page", String(currentPage - 1))}
              aria-label="Previous page"
            >
              <ChevronLeft size={14} />
            </Button>
            {Array.from({ length: totalPages }, (_, i) => i + 1)
              .filter((p) => p === 1 || p === totalPages || Math.abs(p - currentPage) <= 1)
              .reduce<(number | "…")[]>((acc, p, i, arr) => {
                if (i > 0 && p - (arr[i - 1] as number) > 1) acc.push("…");
                acc.push(p);
                return acc;
              }, [])
              .map((p, idx) =>
                p === "…" ? (
                  <span key={`ellipsis-${idx}`} className="px-1 text-muted-foreground text-sm">…</span>
                ) : (
                  <Button
                    key={p}
                    variant={p === currentPage ? "default" : "outline"}
                    size="sm"
                    className="h-8 w-8 p-0"
                    onClick={() => setParam("page", String(p))}
                  >
                    {p}
                  </Button>
                )
              )}
            <Button
              variant="outline"
              size="sm"
              className="h-8 w-8 p-0"
              disabled={currentPage >= totalPages}
              onClick={() => setParam("page", String(currentPage + 1))}
              aria-label="Next page"
            >
              <ChevronRight size={14} />
            </Button>
          </div>
        </div>
      )}

      {/* Dialogs */}
      {canManage && (
        <>
          <BaseItemDialog
            open={createOpen}
            onClose={() => setCreateOpen(false)}
            categories={categories}
            categoriesLoading={categoriesLoading}
            onSubmit={(form) => createMutation.mutate(form)}
            isPending={createMutation.isPending}
            title="New Base Item"
            description="Fill in the details for the new base item."
            submitLabel="Create"
          />

          {editTarget && (
            <BaseItemDialog
              open={editTarget !== null}
              onClose={() => setEditTarget(null)}
              initialValues={itemToForm(editTarget)}
              code={editTarget.code}
              categories={categories}
              categoriesLoading={categoriesLoading}
              existingNames={items.filter((i) => i.id !== editTarget.id).map((i) => i.name)}
              onSubmit={(form) => editMutation.mutate({ id: editTarget.id, form })}
              isPending={editMutation.isPending}
              title="Edit Base Item"
              description={`Update the details for "${editTarget.name}".`}
              submitLabel="Save"
            />
          )}
        </>
      )}

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => { if (!o) { setDeleteTarget(null); setDeleteConfirmText(""); } }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("baseItems.deleteTitle", { name: deleteTarget?.name ?? "" })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("baseItems.deleteWarning")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteTarget && (
            <div className="space-y-2">
              <Label htmlFor="delete-confirm-input" className="text-sm font-normal">
                <Trans
                  i18nKey="baseItems.deleteConfirmInstruction"
                  values={{ name: deleteTarget.name }}
                  components={{ strong: <strong className="font-semibold" /> }}
                />
              </Label>
              <Input
                id="delete-confirm-input"
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
                placeholder={t("baseItems.deleteConfirmPlaceholder")}
                autoComplete="off"
                data-testid="input-delete-confirm"
              />
              {deleteConfirmText.length > 0 && deleteConfirmText !== deleteTarget.name && (
                <p className="text-xs text-destructive">{t("baseItems.deleteConfirmMismatch")}</p>
              )}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>{t("baseItems.deleteCancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                if (!deleteTarget || deleteConfirmText !== deleteTarget.name) {
                  e.preventDefault();
                  return;
                }
                deleteMutation.mutate(deleteTarget.id);
              }}
              disabled={deleteMutation.isPending || !deleteTarget || deleteConfirmText !== deleteTarget.name}
              data-testid="button-confirm-delete"
            >
              {deleteMutation.isPending ? t("baseItems.deleting") : t("baseItems.deleteAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {isOwner && (
        <ImportDialog
          open={importOpen}
          onClose={() => setImportOpen(false)}
          onSuccess={() => qc.invalidateQueries({ queryKey: ["base-items"] })}
        />
      )}

      {isOwner && (
        <DeletionHistoryDialog
          open={deletionHistoryOpen}
          onClose={() => setDeletionHistoryOpen(false)}
        />
      )}

      {/* Bulk action modals */}
      {canManage && (
        <>
          <MergeModal
            open={mergeOpen}
            onClose={() => setMergeOpen(false)}
            selectedItems={items.filter((i) => selectedIds.has(i.id))}
            onSuccess={() => setSelectedIds(new Set())}
          />
          <UpdateCategoryModal
            open={bulkCategoryOpen}
            onClose={() => setBulkCategoryOpen(false)}
            ids={Array.from(selectedIds)}
            selectedItems={items.filter((i) => selectedIds.has(i.id))}
            categories={categories}
            onSuccess={() => setSelectedIds(new Set())}
          />
          <UpdateTypeModal
            open={bulkTypeOpen}
            onClose={() => setBulkTypeOpen(false)}
            ids={Array.from(selectedIds)}
            selectedItems={items.filter((i) => selectedIds.has(i.id))}
            onSuccess={() => setSelectedIds(new Set())}
          />
          <ArchiveModal
            open={bulkArchiveOpen}
            onClose={() => setBulkArchiveOpen(false)}
            ids={Array.from(selectedIds)}
            onSuccess={() => setSelectedIds(new Set())}
          />
          <BulkAddSupplierModal
            open={bulkAddSupplierOpen}
            onClose={() => setBulkAddSupplierOpen(false)}
            ids={Array.from(selectedIds)}
            onSuccess={() => setSelectedIds(new Set())}
          />
          <BulkRemoveSupplierModal
            open={bulkRemoveSupplierOpen}
            onClose={() => setBulkRemoveSupplierOpen(false)}
            ids={Array.from(selectedIds)}
            onSuccess={() => setSelectedIds(new Set())}
          />
        </>
      )}

      {/* Row-level action modals */}
      <ViewUsageModal
        open={usageTarget !== null}
        onClose={() => setUsageTarget(null)}
        item={usageTarget}
      />
      {canManage && (
        <>
          <UpdateCategoryModal
            open={rowCategoryTarget !== null}
            onClose={() => setRowCategoryTarget(null)}
            ids={rowCategoryTarget ? [rowCategoryTarget.id] : []}
            selectedItems={rowCategoryTarget ? [rowCategoryTarget] : []}
            categories={categories}
            onSuccess={() => {}}
          />
          <UpdateTypeModal
            open={rowTypeTarget !== null}
            onClose={() => setRowTypeTarget(null)}
            ids={rowTypeTarget ? [rowTypeTarget.id] : []}
            selectedItems={rowTypeTarget ? [rowTypeTarget] : []}
            onSuccess={() => {}}
          />
          <ArchiveModal
            open={rowArchiveTarget !== null}
            onClose={() => setRowArchiveTarget(null)}
            ids={rowArchiveTarget ? [rowArchiveTarget.id] : []}
            onSuccess={() => {}}
          />
        </>
      )}
    </div>
  );
}
