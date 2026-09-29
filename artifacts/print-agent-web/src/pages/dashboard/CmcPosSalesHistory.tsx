import { useState, useRef, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearch, useLocation } from "wouter";
import { ArrowLeft, History, Pencil, RotateCcw, Ban, Loader2, Download, ChevronDown, ChevronRight, Trash2, Upload, X, ZoomIn, CalendarDays } from "lucide-react";
import { imageUrl } from "@/lib/imageUrl";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch, getClerkToken } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
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
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "@/hooks/use-toast";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";

const PAYMENT_METHODS = ["cash", "card", "bank_transfer", "whish", "other"];
const PAGE_SIZE = 20;

type LineItem = {
  product_id: number | null;
  name: string;
  qty: number;
  unit_price: number;
  discount?: number;
  image_url?: string | null;
  description?: string | null;
  item_type?: "shelf" | "custom";
};

type CmcSale = {
  id: string;
  created_at: string;
  location_id: number;
  shift_id: number | null;
  line_items: LineItem[];
  subtotal: string;
  discount_amount: string;
  discount_type?: "percent" | "amount" | null;
  discount_value?: string | null;
  discount_description?: string | null;
  total: string;
  payment_method: string | null;
  payment_reference: string | null;
  notes: string | null;
  status: string;
  fulfilment_date?: string | null;
};

type SalesResponse = { sales: CmcSale[]; total: number; limit: number; offset: number };

function getSaleNumber(id: string) {
  return id.replace(/-/g, "").slice(-5).toUpperCase();
}

function formatDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDateOnly(dateStr: string) {
  const bare = dateStr.split("T")[0];
  const [year, month, day] = bare.split("-").map(Number);
  if (!year || !month || !day) return dateStr;
  const d = new Date(year, month - 1, day);
  return d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function StatusBadge({ status }: { status: string }) {
  const { t } = useTranslation();
  const variantMap: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
    paid: "default",
    voided: "destructive",
    refunded: "secondary",
  };
  return (
    <Badge variant={variantMap[status] ?? "outline"}>
      {t(`cmcPos.salesHistory.status.${status}`, { defaultValue: status })}
    </Badge>
  );
}

function ImageLightbox({ src, onClose }: { src: string; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-3xl p-2 bg-black/90 border-0">
        <img
          src={src}
          alt=""
          className="max-h-[80vh] w-full object-contain rounded"
        />
      </DialogContent>
    </Dialog>
  );
}

type SaleRowsProps = {
  sale: CmcSale;
  canEdit: boolean;
  canRefund: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onRefund: () => void;
  onVoid: () => void;
  refundPending: boolean;
  voidPending: boolean;
};

function SaleRows({ sale, canEdit, canRefund, onEdit, onRefund, onVoid, onDelete, refundPending, voidPending }: SaleRowsProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);

  const primaryDate = sale.fulfilment_date ? formatDateOnly(sale.fulfilment_date) : formatDate(sale.created_at);
  const secondaryDate = sale.fulfilment_date ? formatDate(sale.created_at) : null;

  return (
    <>
      {lightboxSrc && <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
      <TableRow className="cursor-pointer hover:bg-muted/30" onClick={() => setExpanded((e) => !e)}>
        <TableCell className="text-sm whitespace-nowrap">
          <div className="flex items-center gap-1">
            {expanded ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
            <div>
              <div>{primaryDate}</div>
              {secondaryDate && (
                <div className="text-xs text-muted-foreground mt-0.5">
                  {t("cmcPos.salesHistory.createdAt")}: {secondaryDate}
                </div>
              )}
            </div>
          </div>
        </TableCell>
        <TableCell className="font-mono text-xs">{getSaleNumber(sale.id)}</TableCell>
        <TableCell className="text-sm max-w-72">
          <div className="flex flex-wrap gap-1 items-center">
            {sale.line_items.slice(0, 3).map((li, idx) => {
              const imgSrc = li.image_url ? imageUrl(li.image_url) : null;
              return (
                <span key={idx} className="flex items-center gap-1">
                  {imgSrc && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setLightboxSrc(imgSrc); }}
                      className="shrink-0 group relative"
                    >
                      <img src={imgSrc} alt="" className="h-8 w-8 rounded object-cover border group-hover:opacity-80 transition-opacity" />
                      <ZoomIn className="absolute inset-0 m-auto h-3 w-3 text-white opacity-0 group-hover:opacity-100 drop-shadow transition-opacity" />
                    </button>
                  )}
                  <span className="truncate max-w-24 capitalize">{li.name} ×{li.qty}</span>
                  {idx < Math.min(sale.line_items.length, 3) - 1 && <span className="text-muted-foreground">,</span>}
                </span>
              );
            })}
            {sale.line_items.length > 3 && (
              <span className="text-muted-foreground text-xs">+{sale.line_items.length - 3}</span>
            )}
          </div>
        </TableCell>
        <TableCell className="text-end text-sm">${parseFloat(sale.subtotal).toFixed(2)}</TableCell>
        <TableCell className="text-end text-sm">
          {parseFloat(sale.discount_amount) > 0 ? (
            <div>
              <div>-${parseFloat(sale.discount_amount).toFixed(2)}</div>
              {sale.discount_type === "percent" && sale.discount_value != null && (
                <div className="text-xs text-muted-foreground">{parseFloat(sale.discount_value)}%</div>
              )}
            </div>
          ) : (
            "—"
          )}
        </TableCell>
        <TableCell className="text-end font-semibold text-teal-700">
          ${parseFloat(sale.total).toFixed(2)}
        </TableCell>
        <TableCell className="text-sm">
          {sale.payment_method
            ? t(`cmcPos.sale.pm.${sale.payment_method}`, { defaultValue: sale.payment_method })
            : "—"}
        </TableCell>
        <TableCell><StatusBadge status={sale.status} /></TableCell>
        <TableCell onClick={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-1">
            {canEdit && (
              <>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7"
                  title={t("cmcPos.salesHistory.edit")}
                  onClick={onEdit}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 text-destructive hover:text-destructive"
                  title={t("cmcPos.salesHistory.deleteAction")}
                  onClick={onDelete}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </>
            )}
            {canRefund && sale.status === "paid" && (
              <>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 text-amber-600 hover:text-amber-700"
                  title={t("cmcPos.salesHistory.refund")}
                  disabled={refundPending || voidPending}
                  onClick={onRefund}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-7 w-7 text-destructive hover:text-destructive"
                  title={t("cmcPos.salesHistory.void")}
                  disabled={voidPending || refundPending}
                  onClick={onVoid}
                >
                  <Ban className="h-3.5 w-3.5" />
                </Button>
              </>
            )}
          </div>
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow className="bg-muted/20 hover:bg-muted/20">
          <TableCell colSpan={9} className="py-3 px-6">
            <div className="space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{t("cmcPos.salesHistory.lineItemsDetail")}</p>
              <p className="text-xs text-muted-foreground">{t("cmcPos.salesHistory.colLocation", { defaultValue: "Location" })}: {sale.location_id}</p>
              {sale.line_items.map((li, idx) => {
                const lineTotal = (li.unit_price * li.qty).toFixed(2);
                const isCustom = li.item_type === "custom";
                const imgSrc = li.image_url ? imageUrl(li.image_url) : null;
                return (
                  <div key={idx} className="flex items-start gap-3">
                    {imgSrc && (
                      <button
                        type="button"
                        onClick={() => setLightboxSrc(imgSrc)}
                        className="shrink-0 group relative"
                      >
                        <img src={imgSrc} alt="" className="h-14 w-14 rounded object-cover border group-hover:opacity-80 transition-opacity" />
                        <ZoomIn className="absolute inset-0 m-auto h-4 w-4 text-white opacity-0 group-hover:opacity-100 drop-shadow transition-opacity" />
                      </button>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-sm font-medium capitalize">{li.name}</span>
                        <Badge
                          variant="outline"
                          className={`text-[10px] px-1.5 py-0 shrink-0 ${isCustom ? "border-amber-300 text-amber-700 bg-amber-50" : "border-teal-300 text-teal-700 bg-teal-50"}`}
                        >
                          {isCustom ? t("cmcPos.sale.badge.custom") : t("cmcPos.sale.badge.shelf")}
                        </Badge>
                      </div>
                      {li.description && (
                        <p className="text-xs text-muted-foreground">{li.description}</p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        ${li.unit_price.toFixed(2)} × {li.qty} = <span className="font-medium text-foreground">${lineTotal}</span>
                      </p>
                    </div>
                  </div>
                );
              })}
              {parseFloat(sale.discount_amount) > 0 && (
                <p className="text-xs text-muted-foreground">
                  {t("cmcPos.salesHistory.discountDetail", "Discount")}:{" "}
                  <span className="font-medium text-foreground">
                    -${parseFloat(sale.discount_amount).toFixed(2)}
                    {sale.discount_type === "percent" && sale.discount_value != null
                      ? ` (${parseFloat(sale.discount_value)}%)`
                      : ""}
                  </span>
                  {sale.discount_description ? ` — ${sale.discount_description}` : ""}
                </p>
              )}
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

type EditLineItem = LineItem & { _uploading?: boolean };

type EditDialogProps = {
  sale: CmcSale;
  open: boolean;
  onClose: () => void;
};

function EditDialog({ sale, open, onClose }: EditDialogProps) {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const [notes, setNotes] = useState(sale.notes ?? "");
  const [paymentMethod, setPaymentMethod] = useState(sale.payment_method ?? "");
  const [paymentReference, setPaymentReference] = useState(sale.payment_reference ?? "");
  const [fulfilmentDate, setFulfilmentDate] = useState(
    sale.fulfilment_date ? sale.fulfilment_date.split("T")[0] : "",
  );
  // Sales created with the new total-level discount carry discount_type;
  // legacy sales keep the amount-only shelf-subtotal discount unless the user
  // explicitly opts into the total-level mode.
  const isTotalDiscount = sale.discount_type === "percent" || sale.discount_type === "amount";
  const [totalMode, setTotalMode] = useState(isTotalDiscount);
  const [discountType, setDiscountType] = useState<"percent" | "amount">(
    sale.discount_type === "percent" ? "percent" : "amount",
  );
  const [discountValue, setDiscountValue] = useState(
    isTotalDiscount && sale.discount_value != null
      ? parseFloat(sale.discount_value) || 0
      : parseFloat(sale.discount_amount) || 0,
  );
  const [discountDescription, setDiscountDescription] = useState(sale.discount_description ?? "");
  const [lineItems, setLineItems] = useState<EditLineItem[]>(
    sale.line_items.map((li) => ({ ...li }))
  );
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  const fileInputRefs = useRef<(HTMLInputElement | null)[]>([]);

  async function uploadItemImage(idx: number, file: File) {
    setLineItems((prev) => prev.map((li, i) => i === idx ? { ...li, _uploading: true } : li));
    try {
      const token = await getClerkToken();
      const fd = new FormData();
      fd.append("image", file);
      const resp = await fetch("/api/cmc-pos/upload-image", {
        method: "POST",
        credentials: "include",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: fd,
      });
      if (!resp.ok) throw new Error("Upload failed");
      const { url } = await resp.json() as { url: string };
      setLineItems((prev) => prev.map((li, i) => i === idx ? { ...li, image_url: url, _uploading: false } : li));
    } catch {
      toast({ title: t("cmcPos.salesHistory.imageUploadError"), variant: "destructive" });
      setLineItems((prev) => prev.map((li, i) => i === idx ? { ...li, _uploading: false } : li));
    }
  }

  function updateItem(idx: number, field: keyof LineItem, value: string | number | null) {
    setLineItems((prev) => prev.map((li, i) => i === idx ? { ...li, [field]: value } : li));
  }

  const update = useMutation({
    mutationFn: () =>
      apiFetch<{ sale: CmcSale }>(`/api/cmc-pos/sales/${sale.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          notes: notes || null,
          payment_method: paymentMethod || null,
          payment_reference: paymentReference || null,
          fulfilment_date: fulfilmentDate || null,
          ...(totalMode
            ? discountValue > 0
              ? {
                  discount_type: discountType,
                  discount_value: discountValue,
                  discount_description: discountDescription.trim() || null,
                }
              : { discount_type: null, discount_amount: 0, discount_description: null }
            : {
                // Legacy sale staying in legacy mode: shelf-subtotal amount, as today.
                discount_amount: discountValue,
                discount_description: discountDescription.trim() || null,
              }),
          line_items: lineItems.map(({ _uploading: _, ...rest }) => rest),
        }),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cmc-pos-sales"] });
      toast({ title: t("cmcPos.salesHistory.editSuccess") });
      onClose();
    },
    onError: () => {
      toast({
        title: t("cmcPos.salesHistory.editError"),
        variant: "destructive",
      });
    },
  });

  return (
    <>
      {lightboxSrc && <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />}
      <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("cmcPos.salesHistory.editTitle")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-5 py-2">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label>{t("cmcPos.salesHistory.editPaymentMethod")}</Label>
                <Select value={paymentMethod || "__none"} onValueChange={(v) => setPaymentMethod(v === "__none" ? "" : v)}>
                  <SelectTrigger>
                    <SelectValue placeholder={t("cmcPos.salesHistory.editPaymentMethodPlaceholder")} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none">{t("cmcPos.salesHistory.editPaymentMethodNone")}</SelectItem>
                    {PAYMENT_METHODS.map((m) => (
                      <SelectItem key={m} value={m}>{t(`cmcPos.sale.pm.${m}`)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>{t("cmcPos.salesHistory.editReference")}</Label>
                <Input
                  value={paymentReference}
                  onChange={(e) => setPaymentReference(e.target.value)}
                  placeholder={t("cmcPos.salesHistory.editReferencePlaceholder")}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <Label className="flex items-center gap-1.5">
                  <CalendarDays className="h-3.5 w-3.5 text-teal-600" />
                  {t("cmcPos.salesHistory.editFulfilmentDate")}
                </Label>
                <Input
                  type="date"
                  value={fulfilmentDate}
                  onChange={(e) => setFulfilmentDate(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label>{t("cmcPos.salesHistory.editDiscountAmount")}</Label>
                <div className="flex items-center gap-2">
                  {totalMode && (
                    <div className="flex rounded-md border overflow-hidden shrink-0">
                      <button
                        type="button"
                        onClick={() => setDiscountType("percent")}
                        className={`px-2.5 h-9 text-sm font-medium transition ${
                          discountType === "percent" ? "bg-teal-600 text-white" : "bg-card text-muted-foreground hover:bg-muted"
                        }`}
                      >
                        %
                      </button>
                      <button
                        type="button"
                        onClick={() => setDiscountType("amount")}
                        className={`px-2.5 h-9 text-sm font-medium border-s transition ${
                          discountType === "amount" ? "bg-teal-600 text-white" : "bg-card text-muted-foreground hover:bg-muted"
                        }`}
                      >
                        $
                      </button>
                    </div>
                  )}
                  <Input
                    type="number"
                    min={0}
                    max={totalMode && discountType === "percent" ? 100 : undefined}
                    step="0.01"
                    value={discountValue}
                    onChange={(e) => setDiscountValue(parseFloat(e.target.value) || 0)}
                  />
                </div>
                {!totalMode && (
                  <button
                    type="button"
                    onClick={() => { setTotalMode(true); setDiscountType("amount"); }}
                    className="text-xs text-teal-700 hover:underline"
                  >
                    {t("cmcPos.salesHistory.editDiscountConvert", "Apply to whole total (incl. custom items)")}
                  </button>
                )}
              </div>
            </div>
            <div className="space-y-1">
              <Label>{t("cmcPos.salesHistory.editDiscountDescription", "Discount reason")}</Label>
              <Input
                value={discountDescription}
                onChange={(e) => setDiscountDescription(e.target.value)}
                maxLength={500}
                placeholder={t("cmcPos.sale.discountDescriptionPlaceholder", "Reason (optional)")}
              />
            </div>
            <div className="space-y-1">
              <Label>{t("cmcPos.salesHistory.editNotes")}</Label>
              <Input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={t("cmcPos.salesHistory.editNotesPlaceholder")}
              />
            </div>

            <div className="space-y-2">
              <p className="text-sm font-semibold">{t("cmcPos.salesHistory.editItemsTitle")}</p>
              {lineItems.map((li, idx) => {
                const imgSrc = li.image_url ? imageUrl(li.image_url) : null;
                return (
                  <div key={idx} className="rounded-lg border p-3 space-y-3 bg-muted/20">
                    <div className="flex items-start gap-3">
                      <div className="shrink-0">
                        {imgSrc ? (
                          <div className="relative group">
                            <button
                              type="button"
                              onClick={() => setLightboxSrc(imgSrc)}
                              className="block"
                            >
                              <img src={imgSrc} alt="" className="h-14 w-14 rounded object-cover border group-hover:opacity-70 transition-opacity" />
                            </button>
                            <button
                              type="button"
                              onClick={() => { fileInputRefs.current[idx]?.click(); }}
                              className="absolute bottom-0 end-0 bg-white rounded-full p-0.5 shadow border"
                              title={t("cmcPos.salesHistory.editItemImageUpload")}
                            >
                              <Upload className="h-3 w-3 text-muted-foreground" />
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => { fileInputRefs.current[idx]?.click(); }}
                            className="h-14 w-14 rounded border-2 border-dashed flex items-center justify-center text-muted-foreground hover:border-teal-400 hover:text-teal-600 transition-colors"
                            title={t("cmcPos.salesHistory.editItemImageUpload")}
                          >
                            {li._uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                          </button>
                        )}
                        <input
                          type="file"
                          accept="image/jpeg,image/png,image/webp"
                          className="hidden"
                          ref={(el) => { fileInputRefs.current[idx] = el; }}
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) void uploadItemImage(idx, file);
                            e.target.value = "";
                          }}
                        />
                      </div>
                      <div className="flex-1 grid grid-cols-2 gap-2">
                        <div className="space-y-1">
                          <Label className="text-xs">{t("cmcPos.salesHistory.editItemName")}</Label>
                          <Input
                            value={li.name}
                            onChange={(e) => updateItem(idx, "name", e.target.value)}
                            className="h-8 text-sm"
                          />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">{t("cmcPos.salesHistory.editItemDesc")}</Label>
                          <Input
                            value={li.description ?? ""}
                            onChange={(e) => updateItem(idx, "description", e.target.value || null)}
                            className="h-8 text-sm"
                            placeholder={t("cmcPos.salesHistory.editItemDescPlaceholder")}
                          />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">{t("cmcPos.salesHistory.editItemQty")}</Label>
                          <Input
                            type="number"
                            min={1}
                            value={li.qty}
                            onChange={(e) => updateItem(idx, "qty", parseInt(e.target.value) || 1)}
                            className="h-8 text-sm"
                          />
                        </div>
                        <div className="space-y-1">
                          <Label className="text-xs">{t("cmcPos.salesHistory.editItemPrice")}</Label>
                          <Input
                            type="number"
                            min={0}
                            step="0.01"
                            value={li.unit_price}
                            onChange={(e) => updateItem(idx, "unit_price", parseFloat(e.target.value) || 0)}
                            className="h-8 text-sm"
                          />
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={onClose} disabled={update.isPending}>
              {t("cmcPos.salesHistory.cancel")}
            </Button>
            <Button onClick={() => update.mutate()} disabled={update.isPending || lineItems.some((li) => li._uploading)}>
              {update.isPending && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
              {t("cmcPos.salesHistory.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

type DeleteDialogProps = {
  saleId: string;
  open: boolean;
  onClose: () => void;
};

function DeleteDialog({ saleId, open, onClose }: DeleteDialogProps) {
  const { t } = useTranslation();
  const qc = useQueryClient();

  const deleteMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ ok: boolean }>(`/api/cmc-pos/sales/${saleId}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cmc-pos-sales"] });
      qc.invalidateQueries({ queryKey: ["cmc-pos-metrics"] });
      toast({ title: t("cmcPos.salesHistory.deleteSuccess") });
      onClose();
    },
    onError: () => {
      toast({ title: t("cmcPos.salesHistory.deleteError"), variant: "destructive" });
      onClose();
    },
  });

  return (
    <AlertDialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("cmcPos.salesHistory.deleteTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{t("cmcPos.salesHistory.deleteBody")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onClose}>{t("cmcPos.salesHistory.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => deleteMutation.mutate()}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={deleteMutation.isPending}
          >
            {deleteMutation.isPending && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
            {t("cmcPos.salesHistory.deleteAction")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ── Pagination helpers ────────────────────────────────────────────────────────

function buildPageNums(current: number, total: number): (number | "…")[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages: (number | "…")[] = [];
  const delta = 2;
  const rangeStart = Math.max(2, current - delta);
  const rangeEnd = Math.min(total - 1, current + delta);
  pages.push(1);
  if (rangeStart > 2) pages.push("…");
  for (let i = rangeStart; i <= rangeEnd; i++) pages.push(i);
  if (rangeEnd < total - 1) pages.push("…");
  pages.push(total);
  return pages;
}

export default function CmcPosSalesHistory() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { role, allowedPages } = useWorkspaceRole();

  const isOwner = role === "owner";
  const canEdit = isOwner || !!allowedPages?.includes("cmc_pos.edit");
  const canRefund = isOwner || !!allowedPages?.includes("cmc_pos.refund");

  const search = useSearch();
  const [, navigate] = useLocation();
  const searchParams = new URLSearchParams(search);

  // All filter/page state lives in the URL — derive directly from params
  const urlPage = Math.max(1, parseInt(searchParams.get("page") ?? "1"));
  const urlFrom  = searchParams.get("from")   ?? "";
  const urlTo    = searchParams.get("to")     ?? "";
  const urlStatus = searchParams.get("status") ?? "";
  const urlShift  = searchParams.get("shift")  ?? "";
  const pageSize  = Math.min(Math.max(10, parseInt(searchParams.get("size") ?? String(PAGE_SIZE))), 200);

  // Local controlled state only for date inputs (user can type before hitting Apply)
  const [localFrom, setLocalFrom]   = useState(urlFrom);
  const [localTo,   setLocalTo]     = useState(urlTo);

  // Keep local date inputs in sync when URL changes externally (e.g. browser Back)
  useEffect(() => { setLocalFrom(urlFrom); }, [urlFrom]);
  useEffect(() => { setLocalTo(urlTo); },   [urlTo]);

  const [editingSale, setEditingSale] = useState<CmcSale | null>(null);
  const [deletingSaleId, setDeletingSaleId] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);

  // Navigate helper — merges a patch into the current search params
  function navTo(patch: Record<string, string | number | null>) {
    const next = new URLSearchParams(search);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "" || v === 0) next.delete(k);
      else next.set(k, String(v));
    }
    navigate(`/cmc-pos/sales?${next.toString()}`);
  }

  const offset = (urlPage - 1) * pageSize;

  const buildApiQs = () => {
    const p = new URLSearchParams();
    if (urlFrom)   p.set("from", new Date(urlFrom).toISOString());
    if (urlTo)     { const d = new Date(urlTo); d.setHours(23, 59, 59, 999); p.set("to", d.toISOString()); }
    if (urlStatus) p.set("status", urlStatus);
    if (urlShift)  p.set("shift_id", urlShift);
    p.set("limit",  String(pageSize));
    p.set("offset", String(offset));
    return p.toString();
  };

  const { data, isLoading, isError } = useQuery<SalesResponse>({
    queryKey: ["cmc-pos-sales", urlFrom, urlTo, urlStatus, urlShift, urlPage, pageSize],
    queryFn: () => apiFetch<SalesResponse>(`/api/cmc-pos/sales?${buildApiQs()}`),
    placeholderData: (prev) => prev,
  });

  const sales  = data?.sales ?? [];
  const total  = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // If the loaded page exceeds available pages, redirect to last page
  useEffect(() => {
    if (!isLoading && !isError && data && urlPage > totalPages) {
      navTo({ page: totalPages });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, isError, totalPages, urlPage]);

  const voidSale = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ sale: CmcSale }>(`/api/cmc-pos/sales/${id}/void`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cmc-pos-sales"] });
      qc.invalidateQueries({ queryKey: ["cmc-pos-metrics"] });
      toast({ title: t("cmcPos.salesHistory.voidSuccess") });
    },
    onError: () => {
      toast({ title: t("cmcPos.salesHistory.voidError"), variant: "destructive" });
    },
  });

  const refundSale = useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ sale: CmcSale }>(`/api/cmc-pos/sales/${id}/refund`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cmc-pos-sales"] });
      qc.invalidateQueries({ queryKey: ["cmc-pos-metrics"] });
      toast({ title: t("cmcPos.salesHistory.refundSuccess") });
    },
    onError: () => {
      toast({ title: t("cmcPos.salesHistory.refundError"), variant: "destructive" });
    },
  });

  function handleApplyFilters() {
    // Push local date inputs + reset to page 1
    navTo({ from: localFrom || null, to: localTo || null, page: null });
  }

  function handleClearFilters() {
    setLocalFrom("");
    setLocalTo("");
    navigate("/cmc-pos/sales");
  }

  async function handleExportCsv() {
    if (isExporting) return;
    setIsExporting(true);
    try {
      const p = new URLSearchParams();
      if (urlFrom) p.set("from", new Date(urlFrom).toISOString());
      if (urlTo) { const d = new Date(urlTo); d.setHours(23, 59, 59, 999); p.set("to", d.toISOString()); }
      if (urlStatus) p.set("status", urlStatus);
      if (urlShift) p.set("shift_id", urlShift);
      const url = `/api/cmc-pos/sales/export?${p.toString()}`;
      const token = await getClerkToken();
      const response = await fetch(url, {
        credentials: "include",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!response.ok) throw new Error(`Export failed: ${response.statusText}`);
      const blob = await response.blob();
      const disposition = response.headers.get("Content-Disposition") ?? "";
      const filenameMatch = disposition.match(/filename="([^"]+)"/);
      const filename = filenameMatch ? filenameMatch[1] : "cmc-sales.csv";
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
    } catch {
      toast({ title: t("cmcPos.salesHistory.exportCsvError"), variant: "destructive" });
    } finally {
      setIsExporting(false);
    }
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" asChild>
          <Link href="/cmc-pos"><ArrowLeft className="h-4 w-4" /></Link>
        </Button>
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-teal-100">
          <History className="h-5 w-5 text-teal-700" />
        </div>
        <div>
          <h1 className="text-2xl font-semibold">{t("cmcPos.salesHistory.title")}</h1>
          <p className="text-sm text-muted-foreground">{t("cmcPos.salesHistory.subtitle")}</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-4">
        <div className="space-y-1">
          <Label className="text-xs">{t("cmcPos.salesHistory.filterFrom")}</Label>
          <Input
            type="date"
            value={localFrom}
            onChange={(e) => setLocalFrom(e.target.value)}
            className="h-8 text-sm w-36"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t("cmcPos.salesHistory.filterTo")}</Label>
          <Input
            type="date"
            value={localTo}
            onChange={(e) => setLocalTo(e.target.value)}
            className="h-8 text-sm w-36"
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t("cmcPos.salesHistory.filterStatus")}</Label>
          <Select
            value={urlStatus || "__all"}
            onValueChange={(v) => navTo({ status: v === "__all" ? null : v, page: null })}
          >
            <SelectTrigger className="h-8 text-sm w-32">
              <SelectValue placeholder={t("cmcPos.salesHistory.filterAllStatuses")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all">{t("cmcPos.salesHistory.filterAllStatuses")}</SelectItem>
              <SelectItem value="paid">{t("cmcPos.salesHistory.status.paid")}</SelectItem>
              <SelectItem value="voided">{t("cmcPos.salesHistory.status.voided")}</SelectItem>
              <SelectItem value="refunded">{t("cmcPos.salesHistory.status.refunded")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t("cmcPos.salesHistory.filterShift")}</Label>
          <Input
            type="number"
            value={urlShift}
            onChange={(e) => navTo({ shift: e.target.value || null, page: null })}
            placeholder={t("cmcPos.salesHistory.filterShiftPlaceholder")}
            className="h-8 text-sm w-28"
          />
        </div>
        <Button size="sm" onClick={handleApplyFilters}>{t("cmcPos.salesHistory.apply")}</Button>
        <Button size="sm" variant="outline" onClick={handleClearFilters}>{t("cmcPos.salesHistory.clear")}</Button>
        <Button
          size="sm"
          variant="outline"
          onClick={handleExportCsv}
          disabled={isExporting}
        >
          {isExporting ? (
            <Loader2 className="me-2 h-4 w-4 animate-spin" />
          ) : (
            <Download className="me-2 h-4 w-4" />
          )}
          {t("cmcPos.salesHistory.exportCsv")}
        </Button>
      </div>

      {/* Table */}
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("cmcPos.salesHistory.colDateTime")}</TableHead>
              <TableHead>{t("cmcPos.salesHistory.colSaleNumber", { defaultValue: "Sale #" })}</TableHead>
              <TableHead>{t("cmcPos.salesHistory.colItems")}</TableHead>
              <TableHead className="text-end">{t("cmcPos.salesHistory.colSubtotal")}</TableHead>
              <TableHead className="text-end">{t("cmcPos.salesHistory.colDiscount")}</TableHead>
              <TableHead className="text-end">{t("cmcPos.salesHistory.colTotal")}</TableHead>
              <TableHead>{t("cmcPos.salesHistory.colPayment")}</TableHead>
              <TableHead>{t("cmcPos.salesHistory.colStatus")}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <TableRow>
                <TableCell colSpan={9} className="py-12 text-center text-muted-foreground">
                  <Loader2 className="mx-auto h-6 w-6 animate-spin" />
                </TableCell>
              </TableRow>
            )}
            {isError && (
              <TableRow>
                <TableCell colSpan={9} className="py-12 text-center text-destructive">
                  {t("cmcPos.salesHistory.loadError")}
                </TableCell>
              </TableRow>
            )}
            {!isLoading && !isError && sales.length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="py-12 text-center text-muted-foreground">
                  {t("cmcPos.salesHistory.empty")}
                </TableCell>
              </TableRow>
            )}
            {sales.map((sale) => (
              <SaleRows
                key={sale.id}
                sale={sale}
                canEdit={canEdit}
                canRefund={canRefund}
                onEdit={() => setEditingSale(sale)}
                onDelete={() => setDeletingSaleId(sale.id)}
                onRefund={() => refundSale.mutate(sale.id)}
                onVoid={() => voidSale.mutate(sale.id)}
                refundPending={refundSale.isPending}
                voidPending={voidSale.isPending}
              />
            ))}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Range label */}
        <span className="text-sm text-muted-foreground">
          {total === 0
            ? "No sales"
            : `${offset + 1}–${Math.min(offset + pageSize, total)} of ${total} sales`}
        </span>

        {/* Page buttons */}
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="sm"
            className="h-8 px-3"
            disabled={urlPage <= 1}
            onClick={() => navTo({ page: urlPage - 1 })}
          >
            {t("cmcPos.salesHistory.prev")}
          </Button>

          {buildPageNums(urlPage, totalPages).map((p, i) =>
            p === "…" ? (
              <span key={`ellipsis-${i}`} className="px-1 text-sm text-muted-foreground select-none">…</span>
            ) : (
              <Button
                key={p}
                variant={p === urlPage ? "default" : "outline"}
                size="sm"
                className={`h-8 w-8 text-xs ${p === urlPage ? "bg-teal-700 hover:bg-teal-800 border-teal-700" : ""}`}
                onClick={() => navTo({ page: p })}
              >
                {p}
              </Button>
            )
          )}

          <Button
            variant="outline"
            size="sm"
            className="h-8 px-3"
            disabled={urlPage >= totalPages}
            onClick={() => navTo({ page: urlPage + 1 })}
          >
            {t("cmcPos.salesHistory.next")}
          </Button>
        </div>

        {/* Page size picker */}
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span>Rows per page</span>
          <Select
            value={String(pageSize)}
            onValueChange={(v) => navTo({ size: v === String(PAGE_SIZE) ? null : v, page: null })}
          >
            <SelectTrigger className="h-8 w-20 text-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[10, 20, 25, 50, 100].map((n) => (
                <SelectItem key={n} value={String(n)}>{n}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {editingSale && (
        <EditDialog
          sale={editingSale}
          open={true}
          onClose={() => setEditingSale(null)}
        />
      )}

      {deletingSaleId !== null && (
        <DeleteDialog
          saleId={deletingSaleId}
          open={true}
          onClose={() => setDeletingSaleId(null)}
        />
      )}
    </div>
  );
}
