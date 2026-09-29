import { useState, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetBaseItemInventoryOverview,
  useGetBaseItemLocationStatuses,
  usePatchBaseItemLocationStock,
  usePatchBaseItemLocationStatus,
  useListBaseItemAdjustments,
  useCreateBaseItemAdjustment,
  useCreateBaseItemTransfer,
  useUpsertBaseItemCountryThreshold,
  getGetBaseItemInventoryOverviewQueryKey,
  getGetBaseItemQueryKey,
  getGetBaseItemLocationStatusesQueryKey,
  getListBaseItemAdjustmentsQueryKey,
  getListBaseItemCountryThresholdsQueryKey,
  BaseItemAdjustmentCreateReason,
} from "@workspace/api-client-react";
import type {
  BaseItemDetail,
  BaseItemLocationStatus,
  BaseItemStockAdjustment,
  BaseItemInventoryCountrySummary,
  BaseItemCountryThreshold,
  ListBaseItemAdjustmentsParams,
} from "@workspace/api-client-react";
import {
  AlertTriangle,
  ArrowRight,
  ArrowRightLeft,
  ChevronDown,
  ChevronUp,
  ClipboardList,
  Globe,
  Info,
  Loader2,
  MapPin,
  Package,
  Plus,
  Settings,
  TrendingDown,
  TrendingUp,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
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
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { Link } from "wouter";

// ---------------------------------------------------------------------------
// Shared inventory logic helpers (match backend computation)
// ---------------------------------------------------------------------------

function getEffectiveThreshold(
  locationThreshold: number,
  countryDefault: number,
): number {
  return locationThreshold > 0 ? locationThreshold : countryDefault;
}

type InventoryStatus = "in_stock" | "low_stock" | "out_of_stock" | "alert_disabled";

function getInventoryStatus(stock: number, effectiveThreshold: number): InventoryStatus {
  if (effectiveThreshold === 0) return "alert_disabled";
  if (stock === 0) return "out_of_stock";
  if (stock <= effectiveThreshold) return "low_stock";
  return "in_stock";
}

// ---------------------------------------------------------------------------
// Type: direction derived from adjustment reason
// ---------------------------------------------------------------------------

const REASON_DIRECTION: Record<string, "add" | "remove" | "signed"> = {
  receive: "add",
  return: "add",
  remove: "remove",
  damage: "remove",
  correction: "signed",
  other: "signed",
};

const REASON_LABELS: Record<string, string> = {
  receive: "Receive",
  remove: "Remove",
  damage: "Damage",
  correction: "Correction",
  return: "Return",
  other: "Other",
  transfer_in: "Transfer In",
  transfer_out: "Transfer Out",
};

// ---------------------------------------------------------------------------
// Type stub for overview (Orval inlines anonymous response shapes)
// ---------------------------------------------------------------------------

type BaseItemInventoryOverviewResponse = {
  countries: BaseItemInventoryCountrySummary[];
  global_total: number;
  locations: BaseItemLocationStatus[];
  country_thresholds: BaseItemCountryThreshold[];
  suggested_actions: Array<{
    location_id: number;
    location_name: string;
    country: string;
    stock: number;
    effective_threshold: number;
    deficit: number;
  }>;
};

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function formatDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ---------------------------------------------------------------------------
// Country status badge
// ---------------------------------------------------------------------------

function countryStatusBadge(status: BaseItemInventoryCountrySummary["status"]) {
  switch (status) {
    case "out_of_stock":
      return (
        <Badge className="bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-0 text-xs">
          Out of Stock
        </Badge>
      );
    case "low_stock":
      return (
        <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border-0 text-xs">
          Low Stock
        </Badge>
      );
    case "in_stock":
      return (
        <Badge className="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 border-0 text-xs">
          In Stock
        </Badge>
      );
    default:
      return (
        <Badge variant="outline" className="text-xs text-muted-foreground">
          Alerts Off
        </Badge>
      );
  }
}

// ---------------------------------------------------------------------------
// Location stock badge (uses shared helper)
// ---------------------------------------------------------------------------

function locationStockBadge(stock: number, locThreshold: number, countryDefault: number) {
  const effective = getEffectiveThreshold(locThreshold, countryDefault);
  const status = getInventoryStatus(stock, effective);
  switch (status) {
    case "out_of_stock":
      return (
        <Badge className="bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 border-0 text-xs">Out</Badge>
      );
    case "low_stock":
      return (
        <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border-0 text-xs">Low</Badge>
      );
    case "in_stock":
      return (
        <Badge className="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 border-0 text-xs">OK</Badge>
      );
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// LocationStockCard
// ---------------------------------------------------------------------------

function LocationStockCard({
  baseItemId,
  ls,
  countryDefault,
  canManage,
  onSaved,
}: {
  baseItemId: number;
  ls: BaseItemLocationStatus;
  countryDefault: number;
  canManage: boolean;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [stockStr, setStockStr] = useState(String(ls.stock ?? 0));
  const [threshStr, setThreshStr] = useState(String(ls.low_stock_threshold ?? 0));
  const [isDirty, setIsDirty] = useState(false);
  const [actionId, setActionId] = useState(() => crypto.randomUUID());

  const stockVal = parseFloat(stockStr);
  const threshVal = parseFloat(threshStr);
  const stockErr = stockStr.trim() !== "" && (isNaN(stockVal) || stockVal < 0) ? "Non-negative number required" : null;
  const threshErr = threshStr.trim() !== "" && (isNaN(threshVal) || threshVal < 0) ? "Non-negative number required" : null;

  const stockMut = usePatchBaseItemLocationStock({
    mutation: {
      onSuccess: () => {
        toast({ title: `Stock updated for ${ls.location_name}` });
        setIsDirty(false);
        setActionId(crypto.randomUUID());
        onSaved();
      },
      onError: (err) => {
        toast({ title: "Failed to save", description: err instanceof Error ? err.message : "Error", variant: "destructive" });
      },
    },
  });

  const statusMut = usePatchBaseItemLocationStatus({
    mutation: {
      onSuccess: onSaved,
      onError: (err) => {
        toast({ title: "Failed to update", description: err instanceof Error ? err.message : "Error", variant: "destructive" });
      },
    },
  });

  const badge = ls.is_active ? locationStockBadge(ls.stock ?? 0, ls.low_stock_threshold ?? 0, countryDefault) : null;

  return (
    <div className={`border rounded-lg p-4 space-y-3 transition-opacity ${!ls.is_active ? "opacity-50" : ""}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <MapPin size={12} className="text-muted-foreground shrink-0" />
          <span className="text-sm font-medium truncate">{ls.location_name}</span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {badge}
          {canManage && (
            <Switch
              checked={ls.is_active}
              onCheckedChange={(checked) =>
                statusMut.mutate({ id: baseItemId, locationId: ls.location_id, data: { isActive: checked } })
              }
              disabled={statusMut.isPending}
              title={ls.is_active ? "Deactivate" : "Activate"}
            />
          )}
        </div>
      </div>

      {ls.is_active && (
        <>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Stock</Label>
              <Input
                type="number"
                min="0"
                step="any"
                value={stockStr}
                onChange={(e) => {
                  setStockStr(e.target.value);
                  setIsDirty(true);
                  setActionId(crypto.randomUUID());
                }}
                disabled={!canManage || stockMut.isPending}
                className="h-8 text-sm"
              />
              {stockErr && <p className="text-xs text-destructive">{stockErr}</p>}
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Location Threshold</Label>
              <Input
                type="number"
                min="0"
                step="any"
                value={threshStr}
                onChange={(e) => {
                  setThreshStr(e.target.value);
                  setIsDirty(true);
                  setActionId(crypto.randomUUID());
                }}
                disabled={!canManage || stockMut.isPending}
                className="h-8 text-sm"
                placeholder={countryDefault > 0 ? `Default: ${countryDefault}` : "No default"}
              />
              {threshErr && <p className="text-xs text-destructive">{threshErr}</p>}
            </div>
          </div>

          {canManage && isDirty && (
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => stockMut.mutate({
                  id: baseItemId,
                  locationId: ls.location_id,
                  data: {
                    stock: isNaN(stockVal) ? 0 : stockVal,
                    lowStockThreshold: isNaN(threshVal) ? 0 : threshVal,
                    adjustment_action_id: actionId,
                  } as Parameters<typeof stockMut.mutate>[0]["data"],
                })}
                disabled={!!stockErr || !!threshErr || stockMut.isPending}
                className="h-7 text-xs px-3"
              >
                {stockMut.isPending ? <Loader2 size={12} className="animate-spin mr-1" /> : null}
                Save
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setStockStr(String(ls.stock ?? 0));
                  setThreshStr(String(ls.low_stock_threshold ?? 0));
                  setIsDirty(false);
                  setActionId(crypto.randomUUID());
                }}
                disabled={stockMut.isPending}
                className="h-7 text-xs px-3"
              >
                Cancel
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CountryThresholdRow
// ---------------------------------------------------------------------------

function CountryThresholdRow({
  baseItemId,
  country,
  threshold,
  canManage,
  onSaved,
}: {
  baseItemId: number;
  country: string;
  threshold: number;
  canManage: boolean;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const [valStr, setValStr] = useState(String(threshold));
  const [isDirty, setIsDirty] = useState(false);
  const val = parseFloat(valStr);
  const err = valStr.trim() !== "" && (isNaN(val) || val < 0) ? "Non-negative number required" : null;

  const mut = useUpsertBaseItemCountryThreshold({
    mutation: {
      onSuccess: () => {
        toast({ title: `Country threshold updated for ${country}` });
        setIsDirty(false);
        onSaved();
      },
      onError: (e) => {
        toast({ title: "Failed", description: e instanceof Error ? e.message : "Error", variant: "destructive" });
      },
    },
  });

  return (
    <div className="flex items-center gap-3 py-2 border-b border-border last:border-0">
      <Globe size={13} className="text-muted-foreground shrink-0" />
      <span className="text-sm flex-1">{country || "—"}</span>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          min="0"
          step="any"
          value={valStr}
          onChange={(e) => { setValStr(e.target.value); setIsDirty(true); }}
          disabled={!canManage || mut.isPending}
          className="h-8 text-sm w-24"
          placeholder="e.g. 5"
        />
        {canManage && isDirty && (
          <>
            <Button
              size="sm"
              onClick={() => mut.mutate({ id: baseItemId, country, data: { default_low_stock_threshold: isNaN(val) ? 0 : val } })}
              disabled={!!err || mut.isPending}
              className="h-8 px-3 text-xs"
            >
              {mut.isPending ? <Loader2 size={12} className="animate-spin" /> : "Save"}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { setValStr(String(threshold)); setIsDirty(false); }}
              disabled={mut.isPending}
              className="h-8 px-2"
            >
              <X size={12} />
            </Button>
          </>
        )}
      </div>
      {err && <p className="text-xs text-destructive">{err}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// AdjustmentDialog — positive quantity; direction derived from reason type
// ---------------------------------------------------------------------------

function AdjustmentDialog({
  baseItemId,
  activeLocations,
  open,
  onOpenChange,
  onSuccess,
}: {
  baseItemId: number;
  activeLocations: BaseItemLocationStatus[];
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSuccess: () => void;
}) {
  const { toast } = useToast();
  const [country, setCountry] = useState<string>("all");
  const [locationId, setLocationId] = useState("");
  const [locationTouched, setLocationTouched] = useState(false);
  const [qty, setQty] = useState("");
  const [reason, setReason] = useState<string>(BaseItemAdjustmentCreateReason.receive);
  const [signedQty, setSignedQty] = useState<"add" | "remove">("add");
  const [note, setNote] = useState("");
  const [actionId, setActionId] = useState(() => crypto.randomUUID());
  const [serverError, setServerError] = useState<string | null>(null);

  const countries = useMemo(
    () => Array.from(new Set(activeLocations.map((l) => l.country).filter(Boolean))).sort(),
    [activeLocations],
  );

  const filteredLocations = useMemo(
    () => (country === "all" ? activeLocations : activeLocations.filter((l) => l.country === country)),
    [activeLocations, country],
  );

  const direction = REASON_DIRECTION[reason] ?? "signed";
  const absQty = parseFloat(qty);
  const qtyErr = qty.trim() !== "" && (isNaN(absQty) || absQty <= 0) ? "Must be a positive number" : null;

  // Compute signed quantity_change for backend
  const computedChange = useMemo(() => {
    if (isNaN(absQty)) return 0;
    if (direction === "add") return absQty;
    if (direction === "remove") return -absQty;
    return signedQty === "add" ? absQty : -absQty;
  }, [absQty, direction, signedQty]);

  const mut = useCreateBaseItemAdjustment({
    mutation: {
      onSuccess: (data) => {
        toast({ title: "Adjustment recorded", description: `Location stock updated to ${data.stock} units` });
        setCountry("all");
        setLocationId("");
        setLocationTouched(false);
        setQty("");
        setNote("");
        setActionId(crypto.randomUUID());
        setServerError(null);
        onSuccess();
        onOpenChange(false);
      },
      onError: (e) => {
        const apiErr = e as { data?: { error?: string } };
        const message =
          apiErr?.data?.error ??
          (e instanceof Error ? e.message : "Adjustment could not be recorded");
        setServerError(message);
        toast({ title: "Adjustment failed", description: message, variant: "destructive" });
      },
    },
  });

  function handleSubmit() {
    setLocationTouched(true);
    if (!locationId || !qty.trim() || isNaN(absQty) || absQty <= 0) return;
    setServerError(null);
    mut.mutate({
      id: baseItemId,
      data: {
        location_id: parseInt(locationId, 10),
        quantity_change: computedChange,
        reason: reason as (typeof BaseItemAdjustmentCreateReason)[keyof typeof BaseItemAdjustmentCreateReason],
        movement_type: reason,
        note: note.trim() || null,
        adjustment_action_id: actionId,
      } as Parameters<typeof mut.mutate>[0]["data"],
    });
  }

  const directionLabel =
    direction === "add"
      ? "Units to add"
      : direction === "remove"
        ? "Units to remove"
        : "Quantity";

  const directionHint =
    direction === "add"
      ? "Will be added to current stock."
      : direction === "remove"
        ? "Will be deducted from current stock."
        : null;

  return (
    <Dialog open={open} onOpenChange={(v) => {
      if (!v) {
        setServerError(null);
        setActionId(crypto.randomUUID());
      }
      onOpenChange(v);
    }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ClipboardList size={16} />
            Record Adjustment
          </DialogTitle>
        </DialogHeader>

        {serverError && (
          <div
            role="alert"
            className="rounded-md bg-destructive/10 border border-destructive/30 px-3 py-2 flex items-start gap-2 text-sm text-destructive"
          >
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>{serverError}</span>
          </div>
        )}

        <div className="space-y-4 py-2">
          {countries.length > 1 && (
            <div className="space-y-1.5">
              <Label>Country</Label>
              <Select value={country} onValueChange={(v) => { setCountry(v); setLocationId(""); setLocationTouched(false); }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All countries</SelectItem>
                  {countries.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <Label>Location <span className="text-destructive">*</span></Label>
            <Select value={locationId} onValueChange={(v) => { setLocationId(v); setLocationTouched(true); }}>
              <SelectTrigger><SelectValue placeholder="Select a location" /></SelectTrigger>
              <SelectContent>
                {filteredLocations.map((l) => (
                  <SelectItem key={l.location_id} value={String(l.location_id)}>
                    {l.location_name}{countries.length > 1 ? ` (${l.country})` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {locationTouched && !locationId && (
              <p className="text-sm text-destructive">Please select a location.</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Reason <span className="text-destructive">*</span></Label>
            <Select value={reason} onValueChange={(v) => { setReason(v); setSignedQty("add"); }} disabled={mut.isPending}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={BaseItemAdjustmentCreateReason.receive}>Receive — adds to stock</SelectItem>
                <SelectItem value={BaseItemAdjustmentCreateReason.return}>Return — adds to stock</SelectItem>
                <SelectItem value={BaseItemAdjustmentCreateReason.remove}>Remove — deducts from stock</SelectItem>
                <SelectItem value={BaseItemAdjustmentCreateReason.damage}>Damage — deducts from stock</SelectItem>
                <SelectItem value={BaseItemAdjustmentCreateReason.correction}>Correction — choose direction</SelectItem>
                <SelectItem value={BaseItemAdjustmentCreateReason.other}>Other — choose direction</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>
              {directionLabel} <span className="text-destructive">*</span>
            </Label>
            <div className="flex gap-2">
              {direction === "signed" && (
                <Select value={signedQty} onValueChange={(v) => setSignedQty(v as "add" | "remove")} disabled={mut.isPending}>
                  <SelectTrigger className="w-32 shrink-0">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="add">+ Add</SelectItem>
                    <SelectItem value="remove">− Remove</SelectItem>
                  </SelectContent>
                </Select>
              )}
              <div className="flex-1 space-y-1">
                <Input
                  type="number"
                  min="0.001"
                  step="any"
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                  placeholder="e.g. 10"
                  disabled={mut.isPending}
                />
                {qtyErr && <p className="text-sm text-destructive">{qtyErr}</p>}
                {directionHint && !qtyErr && (
                  <p className="text-xs text-muted-foreground">{directionHint}</p>
                )}
              </div>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="flex items-center gap-1">
              Note <span className="text-xs text-muted-foreground font-normal">(optional)</span>
            </Label>
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Supplier delivery #1234"
              disabled={mut.isPending}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={mut.isPending}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={!locationId || !qty.trim() || !!qtyErr || mut.isPending}>
            {mut.isPending ? <><Loader2 size={14} className="animate-spin mr-1.5" />Recording…</> : "Record Adjustment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// TransferDialog — with cross-country transfer notice
// ---------------------------------------------------------------------------

function TransferDialog({
  baseItemId,
  activeLocations,
  open,
  onOpenChange,
  onSuccess,
}: {
  baseItemId: number;
  activeLocations: BaseItemLocationStatus[];
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSuccess: () => void;
}) {
  const { toast } = useToast();
  const [fromId, setFromId] = useState("");
  const [toId, setToId] = useState("");
  const [qty, setQty] = useState("");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [actionId, setActionId] = useState(() => crypto.randomUUID());
  const [serverError, setServerError] = useState<string | null>(null);

  const fromLoc = activeLocations.find((l) => String(l.location_id) === fromId);
  const sameCountryLocs = fromLoc
    ? activeLocations.filter((l) => l.country === fromLoc.country && l.location_id !== fromLoc.location_id)
    : activeLocations.filter((l) => l.location_id !== parseInt(fromId || "0", 10));

  const qtyVal = parseFloat(qty);
  const qtyErr = qty.trim() !== "" && (isNaN(qtyVal) || qtyVal <= 0) ? "Must be a positive number" : null;
  const fromStock = fromLoc ? (fromLoc.stock ?? 0) : null;
  const insufficientErr = fromStock !== null && !isNaN(qtyVal) && qtyVal > fromStock ? `Source only has ${fromStock} units` : null;

  const mut = useCreateBaseItemTransfer({
    mutation: {
      onSuccess: () => {
        toast({ title: "Transfer completed", description: `${qtyVal} units moved successfully` });
        setFromId(""); setToId(""); setQty(""); setReason(""); setNote("");
        setActionId(crypto.randomUUID());
        setServerError(null);
        onSuccess();
        onOpenChange(false);
      },
      onError: (e) => {
        const apiErr = e as { data?: { error?: string } };
        const message =
          apiErr?.data?.error ??
          (e instanceof Error ? e.message : "Transfer could not be completed");
        setServerError(message);
        toast({ title: "Transfer failed", description: message, variant: "destructive" });
      },
    },
  });

  function handleSubmit() {
    if (!fromId || !toId || !qty.trim() || isNaN(qtyVal) || qtyVal <= 0 || !reason.trim()) return;
    setServerError(null);
    mut.mutate({
      id: baseItemId,
      data: {
        transfer_action_id: actionId,
        from_location_id: parseInt(fromId, 10),
        to_location_id: parseInt(toId, 10),
        quantity: qtyVal,
        reason: reason.trim(),
        note: note.trim() || null,
      },
    });
  }

  const canSubmit = !!fromId && !!toId && !!qty.trim() && !qtyErr && !insufficientErr && !!reason.trim() && !mut.isPending;

  return (
    <Dialog open={open} onOpenChange={(v) => {
      if (!v) {
        setServerError(null);
        setActionId(crypto.randomUUID());
      }
      onOpenChange(v);
    }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowRightLeft size={16} />
            Transfer Stock
          </DialogTitle>
        </DialogHeader>

        <div className="rounded-md bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 px-3 py-2 flex items-start gap-2 text-xs text-blue-700 dark:text-blue-300">
          <Info size={12} className="mt-0.5 shrink-0" />
          <span>Transfers are only allowed between locations in the same country. Cross-country transfers are not supported.</span>
        </div>

        {serverError && (
          <div
            role="alert"
            className="rounded-md bg-destructive/10 border border-destructive/30 px-3 py-2 flex items-start gap-2 text-sm text-destructive"
          >
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>{serverError}</span>
          </div>
        )}

        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <Label>From Location <span className="text-destructive">*</span></Label>
            <Select value={fromId} onValueChange={(v) => { setFromId(v); setToId(""); }}>
              <SelectTrigger><SelectValue placeholder="Select source location" /></SelectTrigger>
              <SelectContent>
                {activeLocations.map((l) => (
                  <SelectItem key={l.location_id} value={String(l.location_id)}>
                    {l.location_name} ({l.country}) — {l.stock ?? 0} units
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>To Location <span className="text-destructive">*</span></Label>
            <Select value={toId} onValueChange={setToId} disabled={!fromId}>
              <SelectTrigger><SelectValue placeholder={fromId ? "Select destination (same country)" : "Select source first"} /></SelectTrigger>
              <SelectContent>
                {sameCountryLocs.map((l) => (
                  <SelectItem key={l.location_id} value={String(l.location_id)}>
                    {l.location_name} — {l.stock ?? 0} units
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {fromLoc && sameCountryLocs.length === 0 && (
              <p className="text-xs text-muted-foreground">No other active locations in {fromLoc.country}.</p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Quantity <span className="text-destructive">*</span></Label>
            <Input type="number" min="0.001" step="any" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="e.g. 20" disabled={mut.isPending} />
            {qtyErr && <p className="text-sm text-destructive">{qtyErr}</p>}
            {insufficientErr && <p className="text-sm text-destructive">{insufficientErr}</p>}
            {fromStock !== null && <p className="text-xs text-muted-foreground">Available at source: {fromStock} units</p>}
          </div>

          <div className="space-y-1.5">
            <Label>Reason <span className="text-destructive">*</span></Label>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Rebalancing stock between stores" disabled={mut.isPending} />
          </div>

          <div className="space-y-1.5">
            <Label className="flex items-center gap-1">Note <span className="text-xs text-muted-foreground font-normal">(optional)</span></Label>
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Additional details" disabled={mut.isPending} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={mut.isPending}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {mut.isPending ? <><Loader2 size={14} className="animate-spin mr-1.5" />Transferring…</> : "Transfer"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// MovementHistory — shows stock_before → stock_after
// ---------------------------------------------------------------------------

function MovementHistory({
  baseItemId,
  locations,
}: {
  baseItemId: number;
  locations: BaseItemLocationStatus[];
}) {
  const [filterCountry, setFilterCountry] = useState<string>("all");
  const [filterLocationId, setFilterLocationId] = useState<string>("all");
  const [filterMovementType, setFilterMovementType] = useState<string>("all");
  const [filterDateFrom, setFilterDateFrom] = useState<string>("");
  const [filterDateTo, setFilterDateTo] = useState<string>("");

  const countries = useMemo(
    () => Array.from(new Set(locations.map((l) => l.country).filter(Boolean))).sort(),
    [locations],
  );

  const params: ListBaseItemAdjustmentsParams = {};
  if (filterCountry !== "all") params.country = filterCountry;
  if (filterLocationId !== "all") params.location_id = parseInt(filterLocationId, 10);
  if (filterMovementType !== "all") params.movement_type = filterMovementType;
  if (filterDateFrom) params.date_from = filterDateFrom;
  if (filterDateTo) params.date_to = filterDateTo;

  const hasFilters = filterCountry !== "all" || filterLocationId !== "all" || filterMovementType !== "all" || !!filterDateFrom || !!filterDateTo;

  const { data, isLoading } = useListBaseItemAdjustments(baseItemId, hasFilters ? params : undefined);
  const adjustments: BaseItemStockAdjustment[] = data?.adjustments ?? [];

  const filteredLocationOptions = filterCountry === "all" ? locations : locations.filter((l) => l.country === filterCountry);

  function clearFilters() {
    setFilterCountry("all");
    setFilterLocationId("all");
    setFilterMovementType("all");
    setFilterDateFrom("");
    setFilterDateTo("");
  }

  return (
    <div className="rounded-lg border border-border bg-card">
      <div className="px-5 py-3 border-b border-border">
        <div className="flex items-center justify-between gap-3 mb-3">
          <div className="flex items-center gap-2">
            <ClipboardList size={14} className="text-muted-foreground" />
            <h3 className="text-sm font-semibold">Movement History</h3>
          </div>
          {hasFilters && (
            <Button variant="ghost" size="sm" onClick={clearFilters} className="h-7 text-xs gap-1">
              <X size={11} />
              Clear filters
            </Button>
          )}
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
          {countries.length > 1 && (
            <Select value={filterCountry} onValueChange={(v) => { setFilterCountry(v); setFilterLocationId("all"); }}>
              <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Country" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All countries</SelectItem>
                {countries.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
              </SelectContent>
            </Select>
          )}

          <Select value={filterLocationId} onValueChange={setFilterLocationId}>
            <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Location" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All locations</SelectItem>
              {filteredLocationOptions.map((l) => (
                <SelectItem key={l.location_id} value={String(l.location_id)}>{l.location_name}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={filterMovementType} onValueChange={setFilterMovementType}>
            <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Type" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              {Object.entries(REASON_LABELS).map(([k, v]) => (
                <SelectItem key={k} value={k}>{v}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Input type="date" value={filterDateFrom} onChange={(e) => setFilterDateFrom(e.target.value)} className="h-8 text-xs" />
          <Input type="date" value={filterDateTo} onChange={(e) => setFilterDateTo(e.target.value)} className="h-8 text-xs" />
        </div>
      </div>

      <div className="divide-y divide-border">
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground p-5">
            <Loader2 size={14} className="animate-spin" />Loading history…
          </div>
        ) : adjustments.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No movements found{hasFilters ? " for the selected filters." : "."}
          </div>
        ) : (
          adjustments.map((adj) => {
            const change = Number(adj.quantity_change);
            const isPositive = change > 0;
            const isTransfer = !!adj.transfer_id;
            const label = adj.movement_type
              ? (REASON_LABELS[adj.movement_type] ?? adj.movement_type)
              : (REASON_LABELS[adj.reason] ?? adj.reason);
            const stockBefore = adj.stock_before ?? (Number(adj.stock_after) - change);
            const stockAfter = Number(adj.stock_after);

            const userLabel = adj.created_by_user_id
              ? adj.created_by_user_id.length > 12
                ? `…${adj.created_by_user_id.slice(-8)}`
                : adj.created_by_user_id
              : "System";

            return (
              <div key={adj.id} className="flex items-start gap-3 px-5 py-3">
                <div className={`shrink-0 mt-0.5 ${isTransfer ? "text-blue-500" : isPositive ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}>
                  {isTransfer
                    ? <ArrowRightLeft size={15} />
                    : isPositive
                      ? <TrendingUp size={15} />
                      : <TrendingDown size={15} />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className={`text-sm font-semibold ${isTransfer ? "text-blue-600 dark:text-blue-400" : isPositive ? "text-green-700 dark:text-green-400" : "text-red-700 dark:text-red-400"}`}>
                      {isPositive ? "+" : ""}{change}
                    </span>
                    <Badge variant="secondary" className="text-xs">{label}</Badge>
                    {adj.country && (
                      <Badge variant="outline" className="text-xs text-muted-foreground">{adj.country}</Badge>
                    )}
                    <Badge variant="outline" className="text-xs">{adj.location_name ?? "Unknown"}</Badge>
                    {isTransfer && adj.from_location_name && adj.to_location_name && (
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        {adj.from_location_name} <ArrowRight size={10} /> {adj.to_location_name}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 mt-1 text-xs">
                    <span className="text-muted-foreground">Qty:</span>
                    <span className="tabular-nums text-muted-foreground">{stockBefore}</span>
                    <ArrowRight size={10} className="text-muted-foreground" />
                    <span className="tabular-nums font-semibold text-foreground">{stockAfter}</span>
                    <span className="text-muted-foreground ml-2">User: {userLabel}</span>
                  </div>
                  {adj.purchase_order_id && adj.po_number_label ? (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      <Link href={`/purchase-orders/${adj.purchase_order_id}`} className="underline underline-offset-2 hover:text-foreground transition-colors">
                        {adj.po_number_label}
                      </Link>
                    </p>
                  ) : adj.note ? (
                    <p className="text-xs text-muted-foreground mt-0.5 truncate">{adj.note}</p>
                  ) : null}
                  <p className="text-xs text-muted-foreground mt-0.5">{formatDate(adj.created_at)}</p>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main InventoryTab — country-first layout
// ---------------------------------------------------------------------------

export function InventoryTab({ item }: { item: BaseItemDetail }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const { isOwner, allowedPages } = useWorkspaceRole();
  const canManage = isOwner || (allowedPages?.includes("base_items.manage") ?? false);

  const [adjOpen, setAdjOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [expandedCountries, setExpandedCountries] = useState<Set<string>>(new Set());
  const [showThresholds, setShowThresholds] = useState(false);

  const { data: overviewData, isLoading: overviewLoading } = useGetBaseItemInventoryOverview(item.id);
  const { data: locationData, isLoading: locLoading } = useGetBaseItemLocationStatuses(item.id);

  const overview = overviewData as BaseItemInventoryOverviewResponse | undefined;
  const locations: BaseItemLocationStatus[] = locationData?.locationStatuses ?? [];
  const activeLocations = locations.filter((l) => l.is_active);

  const countries: BaseItemInventoryCountrySummary[] = overview?.countries ?? [];
  const globalTotal = overview?.global_total ?? 0;
  const suggestedActions = overview?.suggested_actions ?? [];
  const countryThresholds: BaseItemCountryThreshold[] = overview?.country_thresholds ?? [];
  const allCountries = useMemo(
    () => Array.from(new Set(locations.map((l) => l.country).filter(Boolean))).sort(),
    [locations],
  );

  function invalidateAll() {
    qc.invalidateQueries({ queryKey: getGetBaseItemQueryKey(item.id) });
    qc.invalidateQueries({ queryKey: getGetBaseItemInventoryOverviewQueryKey(item.id) });
    qc.invalidateQueries({ queryKey: getGetBaseItemLocationStatusesQueryKey(item.id) });
    qc.invalidateQueries({ queryKey: getListBaseItemAdjustmentsQueryKey(item.id) });
  }

  function invalidateThresholds() {
    qc.invalidateQueries({ queryKey: getListBaseItemCountryThresholdsQueryKey(item.id) });
    qc.invalidateQueries({ queryKey: getGetBaseItemInventoryOverviewQueryKey(item.id) });
  }

  function toggleCountry(country: string) {
    setExpandedCountries((prev) => {
      const next = new Set(prev);
      if (next.has(country)) next.delete(country);
      else next.add(country);
      return next;
    });
  }

  const locationsByCountry = useMemo(() => {
    const map = new Map<string, BaseItemLocationStatus[]>();
    for (const l of locations) {
      const c = l.country || "";
      if (!map.has(c)) map.set(c, []);
      map.get(c)!.push(l);
    }
    return map;
  }, [locations]);

  const thresholdByCountry = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of countryThresholds) map.set(t.country, t.default_low_stock_threshold);
    return map;
  }, [countryThresholds]);

  return (
    <div className="space-y-5">
      {/* Action buttons row */}
      {canManage && (
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            Global total: <span className="font-semibold text-foreground tabular-nums">{globalTotal}</span> units across all active locations
          </p>
          <div className="flex gap-2 shrink-0">
            <Button size="sm" variant="outline" onClick={() => setAdjOpen(true)} className="gap-1.5">
              <Plus size={13} />
              Adjust
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setTransferOpen(true)}
              disabled={activeLocations.length < 2}
              className="gap-1.5"
            >
              <ArrowRightLeft size={13} />
              Transfer
            </Button>
          </div>
        </div>
      )}

      {/* Suggested reorder actions */}
      {suggestedActions.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-900/20 dark:border-amber-800 p-4 space-y-3">
          <div className="flex items-center gap-2">
            <AlertTriangle size={14} className="text-amber-600 shrink-0" />
            <h3 className="text-sm font-semibold text-amber-800 dark:text-amber-300">
              {suggestedActions.length} location{suggestedActions.length !== 1 ? "s" : ""} need restocking
            </h3>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {suggestedActions.map((a) => (
              <div key={a.location_id} className="flex items-center gap-2 text-xs text-amber-700 dark:text-amber-300">
                <MapPin size={11} className="shrink-0" />
                <span className="truncate">
                  {a.location_name} ({a.country}): {a.stock} / {a.effective_threshold} — need +{a.deficit}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Country summary cards — PRIMARY view */}
      {overviewLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 size={14} className="animate-spin" />Loading inventory…
        </div>
      ) : countries.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {countries.map((cs) => (
            <div key={cs.country} className="rounded-lg border border-border bg-card p-4 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <Globe size={13} className="text-muted-foreground shrink-0" />
                  <span className="text-sm font-semibold truncate">{cs.country || "—"}</span>
                </div>
                {countryStatusBadge(cs.status)}
              </div>
              <div className="text-2xl font-bold tabular-nums">
                {cs.total_stock} <span className="text-xs font-normal text-muted-foreground">units</span>
              </div>
              <div className="flex gap-3 text-xs text-muted-foreground">
                <span>{cs.active_location_count} active</span>
                {cs.low_stock_location_count > 0 && (
                  <span className="text-amber-600">{cs.low_stock_location_count} low</span>
                )}
                {cs.out_of_stock_location_count > 0 && (
                  <span className="text-red-600">{cs.out_of_stock_location_count} out</span>
                )}
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="w-full h-7 text-xs mt-1"
                onClick={() => toggleCountry(cs.country)}
              >
                {expandedCountries.has(cs.country) ? "Hide locations" : "View locations"}
              </Button>
            </div>
          ))}
        </div>
      ) : locations.length > 0 ? (
        <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          No country groupings found. Configure locations with country settings.
        </div>
      ) : null}

      {/* Country threshold management (owners) */}
      {canManage && allCountries.length > 0 && (
        <div className="rounded-lg border border-border bg-card">
          <button
            className="w-full px-5 py-3 flex items-center justify-between gap-2 text-left"
            onClick={() => setShowThresholds((v) => !v)}
          >
            <div className="flex items-center gap-2">
              <Settings size={14} className="text-muted-foreground" />
              <h3 className="text-sm font-semibold">Country Default Thresholds</h3>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Fallback when a location has no override</span>
              {showThresholds ? <ChevronUp size={14} className="text-muted-foreground" /> : <ChevronDown size={14} className="text-muted-foreground" />}
            </div>
          </button>
          {showThresholds && (
            <div className="px-5 pb-4 border-t border-border pt-3">
              {allCountries.map((c) => (
                <CountryThresholdRow
                  key={c}
                  baseItemId={item.id}
                  country={c}
                  threshold={thresholdByCountry.get(c) ?? 0}
                  canManage={canManage}
                  onSaved={invalidateThresholds}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Locations grouped by country — shown when country card is expanded */}
      {locLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground p-4">
          <Loader2 size={14} className="animate-spin" />Loading locations…
        </div>
      ) : locations.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          <Package size={28} className="mx-auto mb-3 opacity-40" />
          No locations configured. Add locations in Delivery Cities settings to track per-store inventory.
        </div>
      ) : (
        <div className="space-y-3">
          {allCountries.map((country) => {
            const countryLocs = locationsByCountry.get(country) ?? [];
            const isExpanded = expandedCountries.has(country);
            if (!isExpanded) return null;
            const countryDefault = thresholdByCountry.get(country) ?? 0;

            return (
              <div key={country} className="rounded-lg border border-border bg-card">
                <div className="px-5 py-3 border-b border-border flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Globe size={13} className="text-muted-foreground" />
                    <span className="text-sm font-semibold">{country || "—"}</span>
                    <span className="text-xs text-muted-foreground">
                      ({countryLocs.length} location{countryLocs.length !== 1 ? "s" : ""})
                    </span>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => toggleCountry(country)} className="h-7 text-xs gap-1">
                    <ChevronUp size={12} />
                    Hide
                  </Button>
                </div>
                <div className="px-5 pb-5 pt-4">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {countryLocs.map((ls) => (
                      <LocationStockCard
                        key={ls.location_id}
                        baseItemId={item.id}
                        ls={ls}
                        countryDefault={countryDefault}
                        canManage={canManage}
                        onSaved={invalidateAll}
                      />
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Cross-country transfer notice — always visible */}
      {allCountries.length > 1 && (
        <div className="rounded-md bg-muted/50 border border-border px-3 py-2 flex items-start gap-2 text-xs text-muted-foreground">
          <Info size={12} className="mt-0.5 shrink-0" />
          <span>Stock transfers are only supported between locations within the same country. To move stock across countries, record a manual adjustment.</span>
        </div>
      )}

      {/* Movement history */}
      <MovementHistory baseItemId={item.id} locations={locations} />

      {/* Dialogs */}
      <AdjustmentDialog
        baseItemId={item.id}
        activeLocations={activeLocations}
        open={adjOpen}
        onOpenChange={setAdjOpen}
        onSuccess={invalidateAll}
      />
      <TransferDialog
        baseItemId={item.id}
        activeLocations={activeLocations}
        open={transferOpen}
        onOpenChange={setTransferOpen}
        onSuccess={invalidateAll}
      />
    </div>
  );
}
