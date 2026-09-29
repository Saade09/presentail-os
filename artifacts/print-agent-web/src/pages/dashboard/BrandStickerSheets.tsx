import { useState, useRef, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Upload,
  FileText,
  CheckCircle,
  Clock,
  AlertCircle,
  Archive,
  Trash2,
  Eye,
  RotateCcw,
  ChevronDown,
  ChevronRight,
  Download,
  History,
  Search,
  X,
  Loader2,
  Filter,
  RefreshCw,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { apiFetch, getClerkToken } from "@/lib/queryClient";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { WorkspaceImage } from "@/components/WorkspaceImage";

// ── Types ─────────────────────────────────────────────────────────────────────

type StickerSheet = {
  id: number;
  workspace_owner_id: string;
  brand_id: number;
  brand_name: string;
  file_url: string;
  file_name: string;
  file_size: number;
  thumbnail_url: string | null;
  sheet_size: string;
  custom_width: string | null;
  custom_height: string | null;
  sticker_count: number;
  status: "pending_review" | "print_ready" | "needs_changes" | "archived";
  version_number: number;
  version_notes: string | null;
  is_active: boolean;
  uploaded_by_user_id: string;
  uploaded_at: string;
  reviewed_by_user_id: string | null;
  reviewed_at: string | null;
  approved_by_user_id: string | null;
  approved_at: string | null;
  change_request_notes: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

type BrandRow = {
  brand_id: number;
  brand_name: string;
  primary_logo_id: number | null;
  sheet: StickerSheet | null;
};

type Summary = {
  total_brands: number;
  active_sheets: number;
  pending_review: number;
  missing_sheets: number;
  needs_changes: number;
};

type ListResponse = {
  brands: BrandRow[];
  summary: Summary;
};

type Brand = {
  id: number;
  name: string;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

const SHEET_SIZE_LABELS: Record<string, string> = {
  a4: "A4",
  a3: "A3",
  letter: "Letter",
  custom: "Custom",
};

const STATUS_CONFIG: Record<
  string,
  { label: string; variant: "default" | "secondary" | "destructive" | "outline"; icon: React.ReactNode }
> = {
  print_ready: {
    label: "Print Ready",
    variant: "default",
    icon: <CheckCircle size={12} />,
  },
  pending_review: {
    label: "Pending Review",
    variant: "secondary",
    icon: <Clock size={12} />,
  },
  needs_changes: {
    label: "Needs Changes",
    variant: "destructive",
    icon: <AlertCircle size={12} />,
  },
  archived: {
    label: "Archived",
    variant: "outline",
    icon: <Archive size={12} />,
  },
};

function formatFileSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

// ── Sheet Status Badge ────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const config = STATUS_CONFIG[status] ?? STATUS_CONFIG.archived;
  return (
    <Badge variant={config.variant} className="gap-1 text-xs">
      {config.icon}
      {config.label}
    </Badge>
  );
}

// ── Summary KPI Cards ─────────────────────────────────────────────────────────

function SummaryCards({ summary, activeFilter, onFilter }: {
  summary: Summary;
  activeFilter: string;
  onFilter: (f: string) => void;
}) {
  const cards = [
    { key: "", label: "All Brands", value: summary.total_brands, color: "bg-card" },
    { key: "print_ready", label: "Print Ready", value: summary.active_sheets, color: "bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-800" },
    { key: "pending_review", label: "Pending Review", value: summary.pending_review, color: "bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800" },
    { key: "missing", label: "Missing Sheet", value: summary.missing_sheets, color: "bg-slate-50 dark:bg-slate-900 border-slate-200 dark:border-slate-700" },
    { key: "needs_changes", label: "Needs Changes", value: summary.needs_changes, color: "bg-red-50 dark:bg-red-950/30 border-red-200 dark:border-red-800" },
  ];

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
      {cards.map((c) => (
        <button
          key={c.key}
          onClick={() => onFilter(c.key === activeFilter ? "" : c.key)}
          className={`rounded-lg border p-3 text-left transition-all hover:shadow-sm ${c.color} ${activeFilter === c.key ? "ring-2 ring-primary" : ""}`}
        >
          <p className="text-2xl font-bold tabular-nums">{c.value}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{c.label}</p>
        </button>
      ))}
    </div>
  );
}

// ── Upload Dialog ─────────────────────────────────────────────────────────────

function UploadDialog({
  open,
  onClose,
  preselectedBrandId,
  brands,
  onSuccess,
  isOwner,
  allowedPages,
}: {
  open: boolean;
  onClose: () => void;
  preselectedBrandId: number | null;
  brands: Brand[];
  onSuccess: () => void;
  isOwner: boolean;
  allowedPages: string[] | null;
}) {
  const { toast } = useToast();
  const [brandId, setBrandId] = useState<string>(preselectedBrandId ? String(preselectedBrandId) : "");
  const [sheetSize, setSheetSize] = useState("a4");
  const [stickerCount, setStickerCount] = useState("1");
  const [versionNotes, setVersionNotes] = useState("");
  const [markAsReady, setMarkAsReady] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const reset = useCallback(() => {
    setBrandId(preselectedBrandId ? String(preselectedBrandId) : "");
    setSheetSize("a4");
    setStickerCount("1");
    setVersionNotes("");
    setMarkAsReady(false);
    setFile(null);
    setDragOver(false);
  }, [preselectedBrandId]);

  const handleClose = () => {
    if (!uploading) {
      reset();
      onClose();
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files[0];
    if (f && f.type === "application/pdf") setFile(f);
    else toast({ title: "Please drop a PDF file", variant: "destructive" });
  };

  const handleSubmit = async () => {
    if (!brandId) { toast({ title: "Select a brand", variant: "destructive" }); return; }
    if (!file) { toast({ title: "Select a PDF file", variant: "destructive" }); return; }
    const count = parseInt(stickerCount, 10);
    if (isNaN(count) || count < 1) { toast({ title: "Sticker count must be at least 1", variant: "destructive" }); return; }

    setUploading(true);
    try {
      const token = await getClerkToken();
      const form = new FormData();
      form.append("pdf", file);
      form.append("brand_id", brandId);
      form.append("sheet_size", sheetSize);
      form.append("sticker_count", stickerCount);
      if (versionNotes.trim()) form.append("version_notes", versionNotes.trim());
      if (isOwner && markAsReady) form.append("mark_as_ready", "true");

      const res = await fetch("/api/brand-sticker-sheets", {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: form,
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Upload failed");
      toast({ title: "Sticker sheet uploaded successfully" });
      reset();
      onClose();
      onSuccess();
    } catch (err) {
      toast({ title: err instanceof Error ? err.message : "Upload failed", variant: "destructive" });
    } finally {
      setUploading(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Upload Sticker Sheet</DialogTitle>
          <DialogDescription>
            Upload a print-ready PDF sticker sheet for a brand. It will enter the review queue.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <label className="text-sm font-medium mb-1.5 block">Brand *</label>
            <Select value={brandId} onValueChange={setBrandId} disabled={!!preselectedBrandId}>
              <SelectTrigger>
                <SelectValue placeholder="Select brand…" />
              </SelectTrigger>
              <SelectContent>
                {brands.map((b) => (
                  <SelectItem key={b.id} value={String(b.id)}>{b.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div>
            <label className="text-sm font-medium mb-1.5 block">PDF File *</label>
            <div
              className={`border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors ${
                dragOver ? "border-primary bg-primary/5" : "border-border hover:border-primary/50"
              }`}
              onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
              onDragLeave={() => setDragOver(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
            >
              {file ? (
                <div className="flex items-center justify-center gap-2">
                  <FileText size={18} className="text-primary shrink-0" />
                  <div className="text-left">
                    <p className="text-sm font-medium truncate max-w-[220px]">{file.name}</p>
                    <p className="text-xs text-muted-foreground">{formatFileSize(file.size)}</p>
                  </div>
                  <button
                    type="button"
                    className="ml-2 text-muted-foreground hover:text-destructive"
                    onClick={(e) => { e.stopPropagation(); setFile(null); }}
                  >
                    <X size={14} />
                  </button>
                </div>
              ) : (
                <>
                  <Upload size={24} className="mx-auto text-muted-foreground mb-2" />
                  <p className="text-sm text-muted-foreground">
                    Drag & drop PDF here or <span className="text-primary font-medium">browse</span>
                  </p>
                  <p className="text-xs text-muted-foreground mt-1">Max 100 MB</p>
                </>
              )}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,application/pdf"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) setFile(f);
                e.target.value = "";
              }}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium mb-1.5 block">Sheet Size</label>
              <Select value={sheetSize} onValueChange={setSheetSize}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="a4">A4</SelectItem>
                  <SelectItem value="a3">A3</SelectItem>
                  <SelectItem value="letter">Letter</SelectItem>
                  <SelectItem value="custom">Custom</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-medium mb-1.5 block">Sticker Count</label>
              <Input
                type="number"
                min="1"
                value={stickerCount}
                onChange={(e) => setStickerCount(e.target.value)}
                placeholder="1"
              />
            </div>
          </div>

          <div>
            <label className="text-sm font-medium mb-1.5 block">Version Notes (optional)</label>
            <Textarea
              value={versionNotes}
              onChange={(e) => setVersionNotes(e.target.value)}
              placeholder="What changed in this version?"
              rows={2}
              className="resize-none"
            />
          </div>

          {isOwner && (
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                className="rounded"
                checked={markAsReady}
                onChange={(e) => setMarkAsReady(e.target.checked)}
              />
              <span className="text-sm">Approve immediately (mark as print-ready)</span>
            </label>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={uploading}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={uploading || !brandId || !file}>
            {uploading ? <Loader2 size={14} className="animate-spin mr-1.5" /> : <Upload size={14} className="mr-1.5" />}
            {uploading ? "Uploading…" : "Upload Sheet"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Request Changes Dialog ────────────────────────────────────────────────────

function RequestChangesDialog({
  open,
  sheetId,
  brandName,
  onClose,
  onSuccess,
}: {
  open: boolean;
  sheetId: number | null;
  brandName: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { toast } = useToast();
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handleClose = () => {
    if (!submitting) {
      setNotes("");
      onClose();
    }
  };

  const handleSubmit = async () => {
    if (!sheetId || !notes.trim()) return;
    setSubmitting(true);
    try {
      await apiFetch(`/api/brand-sticker-sheets/${sheetId}/request-changes`, {
        method: "PATCH",
        body: JSON.stringify({ notes: notes.trim() }),
        headers: { "Content-Type": "application/json" },
      });
      toast({ title: "Changes requested" });
      setNotes("");
      onClose();
      onSuccess();
    } catch (err) {
      toast({ title: err instanceof Error ? err.message : "Failed to request changes", variant: "destructive" });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Request Changes</DialogTitle>
          <DialogDescription>
            Describe what needs to be changed for the <strong>{brandName}</strong> sticker sheet.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Describe the required changes…"
          rows={4}
          className="resize-none"
        />
        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={submitting}>Cancel</Button>
          <Button variant="destructive" onClick={handleSubmit} disabled={submitting || !notes.trim()}>
            {submitting ? <Loader2 size={14} className="animate-spin mr-1.5" /> : <AlertCircle size={14} className="mr-1.5" />}
            {submitting ? "Sending…" : "Request Changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Version History Dialog ────────────────────────────────────────────────────

function VersionHistoryDialog({
  open,
  brandId,
  brandName,
  onClose,
  canApprove,
  canDelete,
  onActionSuccess,
}: {
  open: boolean;
  brandId: number | null;
  brandName: string;
  onClose: () => void;
  canApprove: boolean;
  canDelete: boolean;
  onActionSuccess: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ["brand-sticker-sheets", "history", brandId],
    queryFn: () =>
      apiFetch<{ sheets: StickerSheet[] }>(
        `/api/brand-sticker-sheets?brand_id=${brandId}&include_all_versions=true`,
      ),
    enabled: open && brandId !== null,
  });

  const sheets = data?.sheets ?? [];

  const restoreMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/api/brand-sticker-sheets/${id}/restore`, { method: "PATCH" }),
    onSuccess: () => {
      toast({ title: "Version restored as active" });
      void queryClient.invalidateQueries({ queryKey: ["brand-sticker-sheets"] });
      onActionSuccess();
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/api/brand-sticker-sheets/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast({ title: "Version deleted" });
      void queryClient.invalidateQueries({ queryKey: ["brand-sticker-sheets"] });
      onActionSuccess();
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  const handleDownload = async (sheet: StickerSheet) => {
    const token = await getClerkToken();
    const res = await fetch(`/api/brand-sticker-sheets/${sheet.id}/file`, {
      credentials: "include",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) { toast({ title: "Download failed", variant: "destructive" }); return; }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = sheet.file_name;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History size={16} />
            Version History — {brandName}
          </DialogTitle>
          <DialogDescription>All uploaded sticker sheet versions for this brand.</DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={24} className="animate-spin text-muted-foreground" />
          </div>
        ) : sheets.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">No versions found.</p>
        ) : (
          <div className="space-y-3">
            {sheets.map((sheet) => (
              <div key={sheet.id} className={`rounded-lg border p-3 space-y-2 ${sheet.is_active ? "border-primary/50 bg-primary/5" : ""}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold">v{sheet.version_number}</span>
                    <StatusBadge status={sheet.status} />
                    {sheet.is_active && (
                      <Badge variant="outline" className="text-xs border-primary text-primary">Active</Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-1 shrink-0">
                    <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => handleDownload(sheet)}>
                      <Download size={13} />
                    </Button>
                    {canApprove && !sheet.is_active && sheet.status !== "archived" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2"
                        onClick={() => restoreMutation.mutate(sheet.id)}
                        disabled={restoreMutation.isPending}
                        title="Restore this version"
                      >
                        <RotateCcw size={13} />
                      </Button>
                    )}
                    {canDelete && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-destructive hover:text-destructive"
                        onClick={() => deleteMutation.mutate(sheet.id)}
                        disabled={deleteMutation.isPending}
                      >
                        <Trash2 size={13} />
                      </Button>
                    )}
                  </div>
                </div>

                <div className="text-xs text-muted-foreground space-y-0.5">
                  <p className="truncate">{sheet.file_name}</p>
                  <p>
                    {SHEET_SIZE_LABELS[sheet.sheet_size] ?? sheet.sheet_size} &middot;{" "}
                    {sheet.sticker_count} sticker{sheet.sticker_count !== 1 ? "s" : ""} &middot;{" "}
                    {formatFileSize(sheet.file_size)}
                  </p>
                  <p>Uploaded {formatDate(sheet.uploaded_at)}</p>
                  {sheet.approved_at && (
                    <p>Approved {formatDate(sheet.approved_at)}</p>
                  )}
                </div>

                {sheet.version_notes && (
                  <p className="text-xs bg-muted rounded p-2">{sheet.version_notes}</p>
                )}
                {sheet.change_request_notes && (
                  <p className="text-xs bg-destructive/10 text-destructive rounded p-2">
                    Changes requested: {sheet.change_request_notes}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Brand Sticker Sheet Card ───────────────────────────────────────────────────

function BrandSheetCard({
  row,
  canUpload,
  canApprove,
  canRequestChanges,
  canArchive,
  canDelete,
  brands,
  onUploadClick,
  onApprove,
  onRequestChanges,
  onArchive,
  onHistoryClick,
  isOwner,
  allowedPages,
}: {
  row: BrandRow;
  canUpload: boolean;
  canApprove: boolean;
  canRequestChanges: boolean;
  canArchive: boolean;
  canDelete: boolean;
  brands: Brand[];
  onUploadClick: (brandId: number) => void;
  onApprove: (sheetId: number) => void;
  onRequestChanges: (sheetId: number, brandName: string) => void;
  onArchive: (sheetId: number) => void;
  onHistoryClick: (brandId: number, brandName: string) => void;
  isOwner: boolean;
  allowedPages: string[] | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const sheet = row.sheet;

  return (
    <Card className="overflow-hidden">
      <CardContent className="p-0">
        <div className="flex items-start gap-3 p-4">
          {/* Brand logo */}
          <div className="w-10 h-10 rounded-lg border border-border bg-muted flex items-center justify-center shrink-0 overflow-hidden">
            {row.primary_logo_id ? (
              <WorkspaceImage
                src={`/api/brands/${row.brand_id}/logos/${row.primary_logo_id}/image`}
                alt={row.brand_name}
                className="w-full h-full object-contain"
              />
            ) : (
              <span className="text-xs font-bold text-muted-foreground uppercase">
                {row.brand_name.charAt(0)}
              </span>
            )}
          </div>

          {/* Brand info + sheet status */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <p className="text-sm font-semibold truncate">{row.brand_name}</p>
              {sheet ? (
                <div className="flex items-center gap-1.5 flex-wrap">
                  <StatusBadge status={sheet.status} />
                  {sheet.is_active && (
                    <Badge variant="outline" className="text-xs border-primary/50 text-primary">Active</Badge>
                  )}
                </div>
              ) : (
                <Badge variant="outline" className="text-xs text-muted-foreground">No sheet</Badge>
              )}
            </div>

            {sheet && (
              <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground flex-wrap">
                <span className="truncate max-w-[180px]">{sheet.file_name}</span>
                <span>&middot;</span>
                <span>{SHEET_SIZE_LABELS[sheet.sheet_size] ?? sheet.sheet_size}</span>
                <span>&middot;</span>
                <span>v{sheet.version_number}</span>
                <span>&middot;</span>
                <span>{sheet.sticker_count} sticker{sheet.sticker_count !== 1 ? "s" : ""}</span>
              </div>
            )}

            {sheet?.change_request_notes && (
              <p className="mt-1.5 text-xs text-destructive bg-destructive/10 rounded px-2 py-1 line-clamp-2">
                {sheet.change_request_notes}
              </p>
            )}
          </div>

          {/* Expand toggle */}
          <button
            onClick={() => setExpanded((p) => !p)}
            className="text-muted-foreground hover:text-foreground p-1 shrink-0"
          >
            {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </button>
        </div>

        {/* Expanded actions */}
        {expanded && (
          <div className="border-t border-border px-4 py-3 bg-muted/30 flex items-center gap-2 flex-wrap">
            {/* Thumbnail */}
            {sheet?.thumbnail_url && (
              <div className="w-16 h-16 rounded border border-border overflow-hidden bg-white shrink-0 mr-2">
                <WorkspaceImage
                  src={`/api/brand-sticker-sheets/${sheet.id}/thumbnail`}
                  alt="Thumbnail"
                  className="w-full h-full object-contain"
                />
              </div>
            )}

            {sheet && (
              <a
                href={`/api/brand-sticker-sheets/${sheet.id}/file`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
              >
                <Eye size={12} /> Preview PDF
              </a>
            )}

            <div className="flex items-center gap-2 flex-wrap ml-auto">
              {canUpload && (
                <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => onUploadClick(row.brand_id)}>
                  <Upload size={12} />
                  {sheet ? "Upload New Version" : "Upload Sheet"}
                </Button>
              )}

              {sheet && canApprove && sheet.status !== "print_ready" && sheet.status !== "archived" && (
                <Button size="sm" variant="outline" className="h-7 text-xs gap-1 text-green-700 border-green-300 hover:bg-green-50" onClick={() => onApprove(sheet.id)}>
                  <CheckCircle size={12} />
                  Approve
                </Button>
              )}

              {sheet && canRequestChanges && sheet.status === "pending_review" && (
                <Button size="sm" variant="outline" className="h-7 text-xs gap-1 text-amber-700 border-amber-300 hover:bg-amber-50" onClick={() => onRequestChanges(sheet.id, row.brand_name)}>
                  <AlertCircle size={12} />
                  Request Changes
                </Button>
              )}

              {sheet && canArchive && sheet.status !== "archived" && (
                <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={() => onArchive(sheet.id)}>
                  <Archive size={12} />
                  Archive
                </Button>
              )}

              <Button size="sm" variant="ghost" className="h-7 text-xs gap-1" onClick={() => onHistoryClick(row.brand_id, row.brand_name)}>
                <History size={12} />
                History
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function BrandStickerSheetsPage() {
  const { t } = useTranslation();
  const { isOwner, allowedPages } = useWorkspaceRole();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const canUpload =
    isOwner ||
    (allowedPages?.includes("sticker-sheets.upload") ?? false) ||
    (allowedPages?.includes("stickers.upload") ?? false);
  const canApprove =
    isOwner || (allowedPages?.includes("sticker-sheets.approve") ?? false);
  const canRequestChanges =
    isOwner || (allowedPages?.includes("sticker-sheets.request-changes") ?? false);
  const canArchive =
    isOwner || (allowedPages?.includes("sticker-sheets.archive") ?? false);
  const canDelete =
    isOwner || (allowedPages?.includes("sticker-sheets.delete") ?? false);

  // Filter state
  const [statusFilter, setStatusFilter] = useState("");
  const [sheetSizeFilter, setSheetSizeFilter] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  // Dialog state
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadBrandId, setUploadBrandId] = useState<number | null>(null);
  const [requestChangesSheetId, setRequestChangesSheetId] = useState<number | null>(null);
  const [requestChangesBrandName, setRequestChangesBrandName] = useState("");
  const [historyBrandId, setHistoryBrandId] = useState<number | null>(null);
  const [historyBrandName, setHistoryBrandName] = useState("");
  const [archiveConfirmId, setArchiveConfirmId] = useState<number | null>(null);

  // Data fetching
  const queryParams = new URLSearchParams();
  if (statusFilter) queryParams.set("status", statusFilter);
  if (sheetSizeFilter) queryParams.set("sheet_size", sheetSizeFilter);
  if (searchQuery.trim()) queryParams.set("q", searchQuery.trim());

  const { data, isLoading, isRefetching, refetch } = useQuery({
    queryKey: ["brand-sticker-sheets", statusFilter, sheetSizeFilter, searchQuery],
    queryFn: () =>
      apiFetch<ListResponse>(`/api/brand-sticker-sheets?${queryParams.toString()}`),
    staleTime: 30_000,
  });

  const { data: brandsData } = useQuery({
    queryKey: ["brands"],
    queryFn: () => apiFetch<{ brands: Brand[] }>("/api/brands"),
    staleTime: 60_000,
  });

  const brands = brandsData?.brands ?? [];
  const rows = data?.brands ?? [];
  const summary = data?.summary ?? { total_brands: 0, active_sheets: 0, pending_review: 0, missing_sheets: 0, needs_changes: 0 };

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["brand-sticker-sheets"] });
  }, [queryClient]);

  const approveMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/api/brand-sticker-sheets/${id}/approve`, { method: "PATCH" }),
    onSuccess: () => {
      toast({ title: "Sheet approved and set as active" });
      invalidate();
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  const archiveMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/api/brand-sticker-sheets/${id}/archive`, { method: "PATCH" }),
    onSuccess: () => {
      toast({ title: "Sheet archived" });
      setArchiveConfirmId(null);
      invalidate();
    },
    onError: (err: Error) => toast({ title: err.message, variant: "destructive" }),
  });

  const handleUploadClick = (brandId: number) => {
    setUploadBrandId(brandId);
    setUploadOpen(true);
  };

  const hasFilters = !!(statusFilter || sheetSizeFilter || searchQuery);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-semibold">{t("nav.brandStickerSheets")}</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Manage print-ready sticker sheet PDFs for each brand.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void refetch()}
            disabled={isRefetching}
          >
            <RefreshCw size={14} className={isRefetching ? "animate-spin" : ""} />
          </Button>
          {canUpload && (
            <Button size="sm" onClick={() => { setUploadBrandId(null); setUploadOpen(true); }}>
              <Upload size={14} className="mr-1.5" />
              Upload Sheet
            </Button>
          )}
        </div>
      </div>

      {/* Summary KPI cards */}
      {!isLoading && (
        <SummaryCards
          summary={summary}
          activeFilter={statusFilter}
          onFilter={setStatusFilter}
        />
      )}

      {/* Filter bar */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search brands or file names…"
            className="pl-8 h-8"
          />
        </div>

        <Select value={sheetSizeFilter || "all"} onValueChange={(v) => setSheetSizeFilter(v === "all" ? "" : v)}>
          <SelectTrigger className="h-8 w-32 text-xs">
            <Filter size={12} className="mr-1 shrink-0" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All sizes</SelectItem>
            <SelectItem value="a4">A4</SelectItem>
            <SelectItem value="a3">A3</SelectItem>
            <SelectItem value="letter">Letter</SelectItem>
            <SelectItem value="custom">Custom</SelectItem>
          </SelectContent>
        </Select>

        {hasFilters && (
          <Button
            size="sm"
            variant="ghost"
            className="h-8 gap-1 text-xs"
            onClick={() => { setStatusFilter(""); setSheetSizeFilter(""); setSearchQuery(""); }}
          >
            <X size={12} />
            Clear
          </Button>
        )}
      </div>

      {/* Brand list */}
      {isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 size={28} className="animate-spin text-muted-foreground" />
        </div>
      ) : rows.length === 0 ? (
        <div className="text-center py-16 border border-dashed rounded-xl">
          <FileText size={36} className="mx-auto text-muted-foreground mb-3" />
          <p className="text-sm font-medium">
            {hasFilters ? "No brands match the current filters" : "No brands found"}
          </p>
          {hasFilters && (
            <Button
              size="sm"
              variant="ghost"
              className="mt-2"
              onClick={() => { setStatusFilter(""); setSheetSizeFilter(""); setSearchQuery(""); }}
            >
              Clear filters
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => (
            <BrandSheetCard
              key={row.brand_id}
              row={row}
              canUpload={canUpload}
              canApprove={canApprove}
              canRequestChanges={canRequestChanges}
              canArchive={canArchive}
              canDelete={canDelete}
              brands={brands}
              isOwner={isOwner}
              allowedPages={allowedPages}
              onUploadClick={handleUploadClick}
              onApprove={(sheetId) => approveMutation.mutate(sheetId)}
              onRequestChanges={(sheetId, brandName) => {
                setRequestChangesSheetId(sheetId);
                setRequestChangesBrandName(brandName);
              }}
              onArchive={(sheetId) => setArchiveConfirmId(sheetId)}
              onHistoryClick={(brandId, brandName) => {
                setHistoryBrandId(brandId);
                setHistoryBrandName(brandName);
              }}
            />
          ))}
        </div>
      )}

      {/* Upload dialog */}
      <UploadDialog
        open={uploadOpen}
        onClose={() => { setUploadOpen(false); setUploadBrandId(null); }}
        preselectedBrandId={uploadBrandId}
        brands={brands}
        onSuccess={invalidate}
        isOwner={isOwner}
        allowedPages={allowedPages}
      />

      {/* Request changes dialog */}
      <RequestChangesDialog
        open={requestChangesSheetId !== null}
        sheetId={requestChangesSheetId}
        brandName={requestChangesBrandName}
        onClose={() => { setRequestChangesSheetId(null); setRequestChangesBrandName(""); }}
        onSuccess={invalidate}
      />

      {/* Version history dialog */}
      <VersionHistoryDialog
        open={historyBrandId !== null}
        brandId={historyBrandId}
        brandName={historyBrandName}
        onClose={() => { setHistoryBrandId(null); setHistoryBrandName(""); }}
        canApprove={canApprove}
        canDelete={canDelete}
        onActionSuccess={invalidate}
      />

      {/* Archive confirmation */}
      <AlertDialog open={archiveConfirmId !== null} onOpenChange={(o) => !o && setArchiveConfirmId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive this sheet?</AlertDialogTitle>
            <AlertDialogDescription>
              The sheet will be archived and marked as inactive. You can restore it later from the version history.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={archiveMutation.isPending}
              onClick={() => {
                if (archiveConfirmId !== null) archiveMutation.mutate(archiveConfirmId);
              }}
            >
              {archiveMutation.isPending ? "Archiving…" : "Archive"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
