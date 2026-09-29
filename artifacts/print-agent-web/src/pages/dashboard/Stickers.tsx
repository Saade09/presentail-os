import { useState, useRef } from "react";
import { useSearch, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Printer, Upload, Pencil, Trash2, X, Check, Download, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { apiFetch, getClerkToken } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { StaleDataBadge } from "@/components/StaleDataBadge";
import { WorkspaceImage } from "@/components/WorkspaceImage";

type Device = {
  id: number;
  name: string;
  machine_id: string;
  printers: string[];
};

type ApiSticker = {
  id: number;
  name: string;
  file_name: string;
  created_at: string;
  brand_id: number | null;
  brand_name: string | null;
};

type Brand = {
  id: number;
  name: string;
  sticker_count: string;
  primary_logo_id: number | null;
};

type BuiltInSticker = {
  kind: "builtin";
  id: string;
  name: string;
  emoji: string;
  description: string;
};

type CustomSticker = {
  kind: "custom";
  id: number;
  name: string;
  file_name: string;
  brand_id: number | null;
  brand_name: string | null;
};

type Sticker = BuiltInSticker | CustomSticker;

const BUILT_IN: BuiltInSticker[] = [
  { kind: "builtin", id: "thank-you",  name: "Thank You",    emoji: "🙏",  description: "Thank you sticker" },
  { kind: "builtin", id: "fragile",    name: "Fragile",      emoji: "⚠️",  description: "Handle with care" },
  { kind: "builtin", id: "rush",       name: "Rush",         emoji: "🚀",  description: "Priority shipping" },
  { kind: "builtin", id: "gift",       name: "Gift",         emoji: "🎁",  description: "Gift wrap label" },
  { kind: "builtin", id: "return",     name: "Return Label", emoji: "↩️",  description: "Return address sticker" },
  { kind: "builtin", id: "qr-code",    name: "QR Code",      emoji: "▦",   description: "Scannable QR sticker" },
  { kind: "builtin", id: "sale",       name: "Sale",         emoji: "🏷️",  description: "Discount / sale badge" },
  { kind: "builtin", id: "new",        name: "New Arrival",  emoji: "✨",  description: "New product label" },
];

export default function StickersPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const search = useSearch();
  const [location, navigate] = useLocation();

  // ─── role ───────────────────────────────────────────────────────────────────
  const { isOwner, allowedPages } = useWorkspaceRole();
  const canUpload = isOwner || (allowedPages?.includes("stickers.upload") ?? false);
  const canManage = isOwner || (allowedPages?.includes("brands.manage") ?? false);

  // ─── brands (for filter + upload) ───────────────────────────────────────────
  const { data: brandsData } = useQuery({
    queryKey: ["brands"],
    queryFn: () => apiFetch<{ brands: Brand[] }>("/api/brands"),
  });
  const brands = brandsData?.brands ?? [];

  // ─── brand filter (URL-persisted) ────────────────────────────────────────────
  const filterBrandId = new URLSearchParams(search).get("brand") ?? "all";

  function setFilterBrandId(value: string) {
    const base = location.split("?")[0];
    const params = new URLSearchParams(search);
    if (value === "all") {
      params.delete("brand");
    } else {
      params.set("brand", value);
    }
    const qs = params.toString();
    navigate(qs ? `${base}?${qs}` : base, { replace: true });
  }

  // ─── custom stickers ────────────────────────────────────────────────────────
  const { data: stickersData } = useQuery({
    queryKey: ["stickers"],
    queryFn: () => apiFetch<{ stickers: ApiSticker[] }>("/api/stickers"),
  });
  const customStickers: CustomSticker[] = (stickersData?.stickers ?? []).map(
    (s) => ({
      kind: "custom",
      id: s.id,
      name: s.name,
      file_name: s.file_name,
      brand_id: s.brand_id,
      brand_name: s.brand_name,
    }),
  );

  // ─── filtered stickers ───────────────────────────────────────────────────────
  const filteredCustom = filterBrandId === "all"
    ? customStickers
    : customStickers.filter((s) => String(s.brand_id) === filterBrandId);

  const allStickers: Sticker[] = [...filteredCustom, ...BUILT_IN];

  // ─── devices (loaded on demand when print dialog opens) ─────────────────────
  const [printTarget, setPrintTarget] = useState<Sticker | null>(null);
  const [selectedDeviceId, setSelectedDeviceId] = useState("");
  const [selectedPrinter, setSelectedPrinter] = useState("");

  const { data: devicesData, isLoading: devicesLoading } = useQuery({
    queryKey: ["devices"],
    queryFn: () => apiFetch<{ devices: Device[] }>("/api/devices"),
    enabled: printTarget !== null,
  });
  const devices = devicesData?.devices ?? [];
  const selectedDevice = devices.find((d) => String(d.id) === selectedDeviceId);
  const availablePrinters = selectedDevice?.printers ?? [];

  // ─── print mutation ──────────────────────────────────────────────────────────
  const printMutation = useMutation({
    mutationFn: async () => {
      if (!selectedDevice || !selectedPrinter || !printTarget) throw new Error("Missing fields");
      const fileId =
        printTarget.kind === "builtin" ? printTarget.id : String(printTarget.id);
      await apiFetch("/api/print-jobs", {
        method: "POST",
        body: JSON.stringify({
          device_id: selectedDevice.id,
          printer_name: selectedPrinter,
          file_name: `sticker-${fileId}.pdf`,
          pages: 1,
        }),
      });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["print-jobs"] });
      toast({ title: "Print job sent", description: `"${printTarget?.name}" sent to ${selectedPrinter}.` });
      closePrintDialog();
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", title: "Print failed", description: err.message });
    },
  });

  function openPrintDialog(s: Sticker) {
    setPrintTarget(s);
    setSelectedDeviceId("");
    setSelectedPrinter("");
  }
  function closePrintDialog() {
    setPrintTarget(null);
    setSelectedDeviceId("");
    setSelectedPrinter("");
  }

  // ─── upload dialog ───────────────────────────────────────────────────────────
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadName, setUploadName] = useState("");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadBrandId, setUploadBrandId] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const uploadMutation = useMutation({
    mutationFn: async () => {
      if (!uploadFile || !uploadName.trim()) throw new Error("Name and file are required");
      if (!uploadBrandId) throw new Error("Please select a brand");
      const fd = new FormData();
      fd.append("pdf", uploadFile);
      fd.append("name", uploadName.trim());
      fd.append("brand_id", uploadBrandId);
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
      qc.invalidateQueries({ queryKey: ["stickers"] });
      qc.invalidateQueries({ queryKey: ["brands"] });
      toast({ title: "Sticker uploaded" });
      setUploadOpen(false);
      setUploadName("");
      setUploadFile(null);
      setUploadBrandId("");
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", title: "Upload failed", description: err.message });
    },
  });

  function closeUploadDialog() {
    setUploadOpen(false);
    setUploadName("");
    setUploadFile(null);
    setUploadBrandId("");
  }

  // ─── rename ──────────────────────────────────────────────────────────────────
  const [renamingId, setRenamingId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const renameMutation = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) =>
      apiFetch(`/api/stickers/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ name }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["stickers"] });
      setRenamingId(null);
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", title: "Rename failed", description: err.message });
    },
  });

  // ─── delete ──────────────────────────────────────────────────────────────────
  const [deleteTarget, setDeleteTarget] = useState<CustomSticker | null>(null);

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/api/stickers/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["stickers"] });
      qc.invalidateQueries({ queryKey: ["brands"] });
      setDeleteTarget(null);
      toast({ title: "Sticker deleted" });
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", title: "Delete failed", description: err.message });
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t("stickers.title")}</h1>
          <p className="text-muted-foreground mt-2">
            {t("stickers.description")}
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <StaleDataBadge
            queries={[{ queryKey: ["stickers"], url: "/api/stickers" }]}
            data-testid="stickers-stale-badge"
          />
          {canUpload && (
            <Button onClick={() => setUploadOpen(true)}>
              <Upload size={16} className="mr-2" />
              {t("stickers.uploadSticker")}
            </Button>
          )}
        </div>
      </div>

      {/* ── Brand filter ── */}
      {brands.length > 0 && (
        <div className="flex items-center gap-3">
          <span className="text-sm font-medium text-muted-foreground shrink-0">{t("stickers.filterByBrand")}:</span>
          <Select value={filterBrandId} onValueChange={setFilterBrandId}>
            <SelectTrigger className="w-52">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("stickers.allBrands")}</SelectItem>
              {brands.map((b) => (
                <SelectItem key={b.id} value={String(b.id)}>
                  <span className="flex items-center gap-2">
                    {b.primary_logo_id != null && (
                      <WorkspaceImage
                        src={`/api/brands/${b.id}/logos/${b.primary_logo_id}/image`}
                        alt=""
                        className="w-4 h-4 rounded-sm object-contain shrink-0"
                      />
                    )}
                    {b.name}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
        {allStickers.map((sticker) => (
          <StickerCard
            key={sticker.kind === "builtin" ? `b-${sticker.id}` : `c-${sticker.id}`}
            sticker={sticker}
            canManage={canManage}
            renamingId={renamingId}
            renameValue={renameValue}
            setRenameValue={setRenameValue}
            onPrint={() => openPrintDialog(sticker)}
            onStartRename={(id, name) => { setRenamingId(id); setRenameValue(name); }}
            onCancelRename={() => setRenamingId(null)}
            onConfirmRename={(id) => renameMutation.mutate({ id, name: renameValue })}
            onDelete={(s) => setDeleteTarget(s)}
            renameLoading={renameMutation.isPending}
          />
        ))}
      </div>

      {/* ── Upload dialog ── */}
      <Dialog open={uploadOpen} onOpenChange={(o) => { if (!o) closeUploadDialog(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Upload Sticker</DialogTitle>
            <DialogDescription>
              Upload a PDF file to add it as a custom sticker your team can print.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Name</label>
              <Input
                placeholder="e.g. Birthday Special"
                value={uploadName}
                onChange={(e) => setUploadName(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Brand <span className="text-destructive">*</span></label>
              {brands.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No brands found. <a href="/brands" className="underline text-primary">Create a brand</a> first.
                </p>
              ) : (
                <Select value={uploadBrandId} onValueChange={setUploadBrandId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a brand" />
                  </SelectTrigger>
                  <SelectContent>
                    {brands.map((b) => (
                      <SelectItem key={b.id} value={String(b.id)}>
                        {b.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Sticker File</label>
              <div
                className="border-2 border-dashed rounded-lg p-6 text-center cursor-pointer hover:border-primary/50 transition-colors"
                onClick={() => fileInputRef.current?.click()}
              >
                {uploadFile ? (
                  <p className="text-sm font-medium">{uploadFile.name}</p>
                ) : (
                  <p className="text-sm text-muted-foreground">Click to select a PDF or image file</p>
                )}
              </div>
              <input
                ref={fileInputRef}
                type="file"
                accept=".pdf,application/pdf,image/png,image/jpeg,image/webp,image/gif"
                className="hidden"
                onChange={(e) => setUploadFile(e.target.files?.[0] ?? null)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeUploadDialog}>
              Cancel
            </Button>
            <Button
              onClick={() => uploadMutation.mutate()}
              disabled={!uploadFile || !uploadName.trim() || !uploadBrandId || uploadMutation.isPending}
            >
              {uploadMutation.isPending ? "Uploading…" : "Upload"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Print dialog ── */}
      <Dialog open={printTarget !== null} onOpenChange={(o) => !o && closePrintDialog()}>
        <DialogContent data-testid="dialog-print-sticker">
          <DialogHeader>
            <DialogTitle>Print "{printTarget?.name}"</DialogTitle>
            <DialogDescription>Choose a computer and printer.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Computer</label>
              <Select value={selectedDeviceId} onValueChange={(v) => { setSelectedDeviceId(v); setSelectedPrinter(""); }} disabled={devicesLoading}>
                <SelectTrigger data-testid="select-computer">
                  <SelectValue placeholder={devicesLoading ? "Loading…" : devices.length === 0 ? "No devices" : "Select a computer"} />
                </SelectTrigger>
                <SelectContent>
                  {devices.map((d) => (
                    <SelectItem key={d.id} value={String(d.id)}>{d.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium">Printer</label>
              <Select value={selectedPrinter} onValueChange={setSelectedPrinter} disabled={!selectedDeviceId || availablePrinters.length === 0}>
                <SelectTrigger data-testid="select-printer">
                  <SelectValue placeholder={!selectedDeviceId ? "Select a computer first" : availablePrinters.length === 0 ? "No printers on this device" : "Select a printer"} />
                </SelectTrigger>
                <SelectContent>
                  {availablePrinters.map((p) => (
                    <SelectItem key={p} value={p}>{p}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closePrintDialog} data-testid="button-cancel-print">Cancel</Button>
            <Button onClick={() => printMutation.mutate()} disabled={!selectedDeviceId || !selectedPrinter || printMutation.isPending} data-testid="button-confirm-print">
              {printMutation.isPending ? "Sending…" : "Print"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Delete confirmation ── */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent data-testid="dialog-delete-sticker">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{deleteTarget?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This sticker will be permanently removed and can't be recovered.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-delete">Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)}
              data-testid="button-confirm-delete"
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ─── StickerCard ─────────────────────────────────────────────────────────────

type StickerCardProps = {
  sticker: Sticker;
  canManage: boolean;
  renamingId: number | null;
  renameValue: string;
  setRenameValue: (v: string) => void;
  onPrint: () => void;
  onStartRename: (id: number, name: string) => void;
  onCancelRename: () => void;
  onConfirmRename: (id: number) => void;
  onDelete: (s: CustomSticker) => void;
  renameLoading: boolean;
};

function StickerCard({
  sticker,
  canManage,
  renamingId,
  renameValue,
  setRenameValue,
  onPrint,
  onStartRename,
  onCancelRename,
  onConfirmRename,
  onDelete,
  renameLoading,
}: StickerCardProps) {
  const { toast } = useToast();
  const isCustom = sticker.kind === "custom";
  const isRenaming = isCustom && renamingId === sticker.id;
  const [thumbError, setThumbError] = useState(false);
  const [thumbnailKey, setThumbnailKey] = useState(0);

  const regenMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ ok: boolean; thumbnail_generated: boolean }>(
        `/api/stickers/${(sticker as CustomSticker).id}/thumbnail`,
        { method: "POST" },
      ),
    onSuccess: (data) => {
      if (data.thumbnail_generated) {
        setThumbError(false);
        setThumbnailKey((k) => k + 1);
        toast({ title: "Thumbnail regenerated" });
      } else {
        toast({ title: "No thumbnail available", description: "Extraction returned no result for this file." });
      }
    },
    onError: (err: Error) => {
      toast({ variant: "destructive", title: "Regeneration failed", description: err.message });
    },
  });

  return (
    <Card className="group hover:shadow-md transition-shadow">
      <CardContent className="flex flex-col items-center gap-3 p-6">
        <div className="text-5xl leading-none flex items-center justify-center w-16 h-16">
          {isCustom && !thumbError ? (
            <WorkspaceImage
              src={`/api/stickers/${(sticker as CustomSticker).id}/thumbnail?v=${thumbnailKey}`}
              alt={sticker.name}
              className="w-16 h-16 object-contain rounded"
              onError={() => setThumbError(true)}
            />
          ) : isCustom ? (
            "📄"
          ) : (
            (sticker as BuiltInSticker).emoji
          )}
        </div>

        <div className="text-center space-y-0.5 w-full">
          {isRenaming ? (
            <div className="flex items-center gap-1">
              <Input
                className="h-7 text-sm px-2"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onConfirmRename((sticker as CustomSticker).id);
                  if (e.key === "Escape") onCancelRename();
                }}
                autoFocus
              />
              <button
                className="shrink-0 text-green-600 hover:text-green-700"
                onClick={() => onConfirmRename((sticker as CustomSticker).id)}
                disabled={renameLoading}
              >
                <Check size={14} />
              </button>
              <button
                className="shrink-0 text-muted-foreground hover:text-foreground"
                onClick={onCancelRename}
              >
                <X size={14} />
              </button>
            </div>
          ) : (
            <p className="font-semibold text-sm leading-tight">{sticker.name}</p>
          )}
          {!isCustom && !isRenaming && (
            <p className="text-xs text-muted-foreground">
              {(sticker as BuiltInSticker).description}
            </p>
          )}
          {isCustom && !isRenaming && (sticker as CustomSticker).brand_name && (
            <p className="text-xs text-muted-foreground">
              {(sticker as CustomSticker).brand_name}
            </p>
          )}
        </div>

        <div className="w-full space-y-1.5 mt-1">
          <Button size="sm" className="w-full" onClick={onPrint}>
            <Printer size={14} className="mr-1.5" />
            Print
          </Button>
          {isCustom && (
            <a
              href={`/api/stickers/${(sticker as CustomSticker).id}/file`}
              download
              className="block w-full"
            >
              <Button size="sm" variant="outline" className="w-full">
                <Download size={14} className="mr-1.5" />
                Download
              </Button>
            </a>
          )}
          {canManage && isCustom && thumbError && (
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              onClick={() => regenMutation.mutate()}
              disabled={regenMutation.isPending}
              data-testid="button-regen-thumbnail"
            >
              <RefreshCw size={13} className={`mr-1.5${regenMutation.isPending ? " animate-spin" : ""}`} />
              {regenMutation.isPending ? "Regenerating…" : "Regenerate thumbnail"}
            </Button>
          )}
          {canManage && isCustom && (
            <div className="flex gap-1">
              <Button
                size="sm"
                variant="outline"
                className="flex-1"
                onClick={() => onStartRename((sticker as CustomSticker).id, sticker.name)}
              >
                <Pencil size={13} className="mr-1" />
                Rename
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="flex-1 text-destructive hover:text-destructive"
                onClick={() => onDelete(sticker as CustomSticker)}
                data-testid="button-delete-sticker"
              >
                <Trash2 size={13} className="mr-1" />
                Delete
              </Button>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
