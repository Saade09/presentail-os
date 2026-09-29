import { useState, useEffect, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiFetch, queryClient } from "@/lib/queryClient";
import {
  Plus, Trash2, Pencil, Copy, Clock, Zap, CalendarRange, Calendar,
  ChevronDown, ChevronUp, AlertTriangle, DollarSign, CheckCircle2,
} from "lucide-react";

// ── Types ────────────────────────────────────────────────────────────────────

export type CityForDrawer = {
  id: number;
  name: string;
  delivery_fee: string | null;
  free_delivery_enabled: boolean;
  free_delivery_threshold: string | null;
  express_delivery_enabled: boolean;
  express_delivery_fee: string | null;
  express_delivery_cutoff_time: string | null;
  standard_delivery_available: boolean;
  express_delivery_available: boolean;
  express_free_delivery_threshold: string | null;
  cutoff_time: string | null;
  max_standard_orders_per_slot: number | null;
  max_express_orders_per_slot: number | null;
};

type WeeklySlot = {
  id: number;
  city_id: number;
  day_of_week: number;
  label: string;
  start_time: string;
  end_time: string;
  is_enabled: boolean;
  fee_override: number | null;
  cutoff_time: string | null;
  capacity: number | null;
  internal_note: string | null;
  sort_order: number;
  delivery_type: string;
  same_day_available: boolean;
  next_day_available: boolean;
  created_at: string;
  updated_at: string;
};

type ExpressSettings = {
  city_id: number;
  express_enabled: boolean;
  express_start_time: string | null;
  express_end_time: string | null;
  express_min_prep_minutes: number | null;
  express_daily_capacity: number | null;
  express_fee: string | null;
  express_cutoff_time: string | null;
};

type SpecialDateOverride = {
  id: number;
  workspace_owner_id: string;
  city_id: number | null;
  country_code: string | null;
  name: string;
  start_date: string;
  end_date: string;
  override_type: "replace_regular_schedule" | "add_to_regular_schedule";
  express_enabled: boolean;
  express_start_time: string | null;
  express_end_time: string | null;
  express_cutoff_time: string | null;
  express_fee: number | null;
  express_min_prep_minutes: number | null;
  express_daily_capacity: number | null;
  internal_note: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

type OverrideSlot = {
  id: number;
  override_id: number;
  label: string;
  start_time: string;
  end_time: string;
  is_enabled: boolean;
  fee_override: number | null;
  cutoff_time: string | null;
  capacity: number | null;
  internal_note: string | null;
  sort_order: number;
  delivery_type: string;
  same_day_available: boolean;
  next_day_available: boolean;
  created_at: string;
};

type ScheduleSummary = {
  enabled_weekly_slots: number;
  sunday_enabled_slots: number;
  active_overrides: number;
  express_window_configured: boolean;
};

// ── Constants ─────────────────────────────────────────────────────────────────

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// ── Shared slot form ─────────────────────────────────────────────────────────

function SlotFormFields({
  label, setLabel,
  startTime, setStartTime,
  endTime, setEndTime,
  feeOverride, setFeeOverride,
  cutoffTime, setCutoffTime,
  capacity, setCapacity,
  note, setNote,
  isEnabled, setIsEnabled,
  deliveryType, setDeliveryType,
  sameDayAvailable, setSameDayAvailable,
  nextDayAvailable, setNextDayAvailable,
}: {
  label: string; setLabel: (v: string) => void;
  startTime: string; setStartTime: (v: string) => void;
  endTime: string; setEndTime: (v: string) => void;
  feeOverride: string; setFeeOverride: (v: string) => void;
  cutoffTime: string; setCutoffTime: (v: string) => void;
  capacity: string; setCapacity: (v: string) => void;
  note: string; setNote: (v: string) => void;
  isEnabled: boolean; setIsEnabled: (v: boolean) => void;
  deliveryType: string; setDeliveryType: (v: string) => void;
  sameDayAvailable: boolean; setSameDayAvailable: (v: boolean) => void;
  nextDayAvailable: boolean; setNextDayAvailable: (v: boolean) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label>Label</Label>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Morning" />
        </div>
        <div className="flex items-end gap-2">
          <Switch checked={isEnabled} onCheckedChange={setIsEnabled} id="slot-enabled" />
          <Label htmlFor="slot-enabled">Enabled</Label>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label>Start time</Label>
          <Input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label>End time</Label>
          <Input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <div className="space-y-1">
          <Label>Fee override ($)</Label>
          <Input type="number" min="0" step="0.01" value={feeOverride} onChange={(e) => setFeeOverride(e.target.value)} placeholder="—" />
        </div>
        <div className="space-y-1">
          <Label>Cutoff time</Label>
          <Input type="time" value={cutoffTime} onChange={(e) => setCutoffTime(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label>Max orders</Label>
          <Input type="number" min="1" step="1" value={capacity} onChange={(e) => setCapacity(e.target.value)} placeholder="—" />
        </div>
      </div>
      <div className="space-y-1">
        <Label>Delivery type</Label>
        <div className="flex gap-2">
          {(["standard", "express"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setDeliveryType(t)}
              className={`flex-1 text-xs px-3 py-1.5 rounded-md border transition-colors ${
                deliveryType === t ? "bg-primary text-primary-foreground border-primary" : "bg-card hover:bg-muted border-border"
              }`}
            >
              {t === "standard" ? "Standard" : "Express"}
            </button>
          ))}
        </div>
      </div>
      <div className="flex gap-4">
        <div className="flex items-center gap-2">
          <Switch checked={sameDayAvailable} onCheckedChange={setSameDayAvailable} id="slot-same-day" />
          <Label htmlFor="slot-same-day" className="text-xs">Same-day orders</Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch checked={nextDayAvailable} onCheckedChange={setNextDayAvailable} id="slot-next-day" />
          <Label htmlFor="slot-next-day" className="text-xs">Next-day orders</Label>
        </div>
      </div>
      <div className="space-y-1">
        <Label>Internal note</Label>
        <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Optional" />
      </div>
    </div>
  );
}

// ── Warning banner ─────────────────────────────────────────────────────────────

function WarningBanner({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30 px-3 py-2.5 text-xs text-amber-800 dark:text-amber-300">
      <AlertTriangle size={13} className="shrink-0 mt-0.5" />
      <span>{message}</span>
    </div>
  );
}

// ── Tab: Pricing ───────────────────────────────────────────────────────────────

function PricingTab({ city, canManage }: { city: CityForDrawer; canManage: boolean }) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [deliveryFee, setDeliveryFee] = useState("");
  const [freeEnabled, setFreeEnabled] = useState(false);
  const [freeThreshold, setFreeThreshold] = useState("");
  const [expressEnabled, setExpressEnabled] = useState(false);
  const [expressFee, setExpressFee] = useState("");
  const [expressCutoff, setExpressCutoff] = useState("");
  const [standardAvail, setStandardAvail] = useState(true);
  const [expressAvail, setExpressAvail] = useState(false);
  const [expressFreeThresh, setExpressFreeThresh] = useState("");
  const [stdCutoff, setStdCutoff] = useState("");
  const [maxStdPerSlot, setMaxStdPerSlot] = useState("");
  const [maxExpPerSlot, setMaxExpPerSlot] = useState("");

  function startEditing() {
    setDeliveryFee(city.delivery_fee != null ? String(parseFloat(city.delivery_fee)) : "");
    setFreeEnabled(city.free_delivery_enabled);
    setFreeThreshold(city.free_delivery_threshold != null ? String(parseFloat(city.free_delivery_threshold)) : "");
    setExpressEnabled(city.express_delivery_enabled);
    setExpressFee(city.express_delivery_fee != null ? String(parseFloat(city.express_delivery_fee)) : "");
    setExpressCutoff(city.express_delivery_cutoff_time ?? "");
    setStandardAvail(city.standard_delivery_available);
    setExpressAvail(city.express_delivery_available);
    setExpressFreeThresh(city.express_free_delivery_threshold != null ? String(parseFloat(city.express_free_delivery_threshold)) : "");
    setStdCutoff(city.cutoff_time ?? "");
    setMaxStdPerSlot(city.max_standard_orders_per_slot != null ? String(city.max_standard_orders_per_slot) : "");
    setMaxExpPerSlot(city.max_express_orders_per_slot != null ? String(city.max_express_orders_per_slot) : "");
    setEditing(true);
  }

  const patchMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch(`/api/cities/${city.id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cities"] });
      toast({ title: "Pricing settings saved" });
      setEditing(false);
    },
    onError: (err: unknown) => {
      toast({ title: "Save failed", description: err instanceof Error ? err.message : "Error", variant: "destructive" });
    },
  });

  function handleSave() {
    const body: Record<string, unknown> = {
      delivery_fee: deliveryFee !== "" ? parseFloat(deliveryFee) : 0,
      free_delivery_enabled: freeEnabled,
      free_delivery_threshold: freeThreshold !== "" ? parseFloat(freeThreshold) : null,
      express_delivery_enabled: expressEnabled,
      express_delivery_fee: expressFee !== "" ? parseFloat(expressFee) : null,
      express_delivery_cutoff_time: expressCutoff || null,
      standard_delivery_available: standardAvail,
      express_delivery_available: expressAvail,
      express_free_delivery_threshold: expressFreeThresh !== "" ? parseFloat(expressFreeThresh) : null,
      cutoff_time: stdCutoff || null,
      max_standard_orders_per_slot: maxStdPerSlot !== "" ? parseInt(maxStdPerSlot, 10) : null,
      max_express_orders_per_slot: maxExpPerSlot !== "" ? parseInt(maxExpPerSlot, 10) : null,
    };
    patchMutation.mutate(body);
  }

  const expressEnabled_city = city.express_delivery_enabled;
  const expressHasCutoff = !!city.express_delivery_cutoff_time;

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-semibold mb-1">Delivery Pricing</h3>
        <p className="text-xs text-muted-foreground">
          Configure standard delivery fees, free delivery threshold, and express delivery pricing for this district.
        </p>
      </div>

      {expressEnabled_city && !expressHasCutoff && (
        <WarningBanner message="Express delivery is enabled but no order cutoff time is set. Customers may place express orders at any time." />
      )}

      <div className="rounded-lg border bg-card p-4 space-y-4">
        {!editing ? (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
              <div>
                <p className="text-xs text-muted-foreground mb-0.5">Delivery fee</p>
                <p className="font-medium text-sm">
                  {city.delivery_fee != null ? `$${parseFloat(city.delivery_fee).toFixed(2)}` : "—"}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-0.5">Free delivery</p>
                <div className="flex items-center gap-1.5">
                  {city.free_delivery_enabled ? (
                    <CheckCircle2 size={13} className="text-green-500" />
                  ) : null}
                  <p className="font-medium text-sm">
                    {city.free_delivery_enabled
                      ? city.free_delivery_threshold
                        ? `Over $${parseFloat(city.free_delivery_threshold).toFixed(2)}`
                        : "Always free"
                      : "Disabled"}
                  </p>
                </div>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-0.5">Express</p>
                <div className="flex items-center gap-1.5">
                  {city.express_delivery_enabled ? (
                    <CheckCircle2 size={13} className="text-green-500" />
                  ) : null}
                  <p className="font-medium text-sm">
                    {city.express_delivery_enabled
                      ? city.express_delivery_fee
                        ? `$${parseFloat(city.express_delivery_fee).toFixed(2)}`
                        : "Enabled (no fee)"
                      : "Disabled"}
                  </p>
                </div>
              </div>
              {city.express_delivery_enabled && city.express_delivery_cutoff_time && (
                <div>
                  <p className="text-xs text-muted-foreground mb-0.5">Express cutoff</p>
                  <p className="font-medium text-sm">{city.express_delivery_cutoff_time}</p>
                </div>
              )}
            </div>
            <div className="border-t pt-3">
              <p className="text-xs font-medium text-muted-foreground mb-2">Capacity &amp; Availability</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                <div>
                  <p className="text-xs text-muted-foreground mb-0.5">Standard available</p>
                  <div className="flex items-center gap-1.5">
                    {city.standard_delivery_available
                      ? <CheckCircle2 size={13} className="text-green-500" />
                      : <span className="text-[11px] text-muted-foreground">No</span>}
                    <p className="font-medium text-sm">{city.standard_delivery_available ? "Yes" : "No"}</p>
                  </div>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-0.5">Express available</p>
                  <div className="flex items-center gap-1.5">
                    {city.express_delivery_available
                      ? <CheckCircle2 size={13} className="text-green-500" />
                      : null}
                    <p className="font-medium text-sm">{city.express_delivery_available ? "Yes" : "No"}</p>
                  </div>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-0.5">Standard cutoff</p>
                  <p className="font-medium text-sm">{city.cutoff_time ?? "—"}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-0.5">Express free above ($)</p>
                  <p className="font-medium text-sm">
                    {city.express_free_delivery_threshold != null
                      ? `$${parseFloat(city.express_free_delivery_threshold).toFixed(2)}`
                      : "—"}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-0.5">Max std. orders/slot</p>
                  <p className="font-medium text-sm">{city.max_standard_orders_per_slot ?? "—"}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-0.5">Max exp. orders/slot</p>
                  <p className="font-medium text-sm">{city.max_express_orders_per_slot ?? "—"}</p>
                </div>
              </div>
            </div>
            {canManage && (
              <Button variant="outline" size="sm" onClick={startEditing} className="gap-1.5">
                <Pencil size={13} /> Edit pricing
              </Button>
            )}
          </>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Standard delivery fee ($)</Label>
                <Input type="number" min="0" step="0.01" value={deliveryFee} onChange={(e) => setDeliveryFee(e.target.value)} placeholder="e.g. 5.00" />
              </div>
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Switch checked={freeEnabled} onCheckedChange={setFreeEnabled} id="pricing-free" />
                <Label htmlFor="pricing-free">Free delivery</Label>
              </div>
              {freeEnabled && (
                <div className="space-y-1.5 ml-9">
                  <Label>Free above order amount ($)</Label>
                  <Input type="number" min="0" step="0.01" value={freeThreshold} onChange={(e) => setFreeThreshold(e.target.value)} placeholder="Leave blank for always free" />
                </div>
              )}
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Switch checked={expressEnabled} onCheckedChange={setExpressEnabled} id="pricing-express" />
                <Label htmlFor="pricing-express">Express delivery</Label>
              </div>
              {expressEnabled && (
                <div className="grid grid-cols-2 gap-3 ml-9">
                  <div className="space-y-1.5">
                    <Label>Express fee ($)</Label>
                    <Input type="number" min="0" step="0.01" value={expressFee} onChange={(e) => setExpressFee(e.target.value)} placeholder="e.g. 10.00" />
                  </div>
                  <div className="space-y-1.5">
                    <Label>Order cutoff time</Label>
                    <Input type="time" value={expressCutoff} onChange={(e) => setExpressCutoff(e.target.value)} />
                  </div>
                </div>
              )}
            </div>
            <div className="border-t pt-3 space-y-3">
              <p className="text-xs font-medium text-muted-foreground">Capacity &amp; Availability</p>
              <div className="flex gap-4 flex-wrap">
                <div className="flex items-center gap-2">
                  <Switch checked={standardAvail} onCheckedChange={setStandardAvail} id="pricing-std-avail" />
                  <Label htmlFor="pricing-std-avail" className="text-sm">Standard available</Label>
                </div>
                <div className="flex items-center gap-2">
                  <Switch checked={expressAvail} onCheckedChange={setExpressAvail} id="pricing-exp-avail" />
                  <Label htmlFor="pricing-exp-avail" className="text-sm">Express available</Label>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Standard order cutoff</Label>
                  <Input type="time" value={stdCutoff} onChange={(e) => setStdCutoff(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label>Express free above ($)</Label>
                  <Input type="number" min="0" step="0.01" value={expressFreeThresh} onChange={(e) => setExpressFreeThresh(e.target.value)} placeholder="—" />
                </div>
                <div className="space-y-1.5">
                  <Label>Max standard orders/slot</Label>
                  <Input type="number" min="1" step="1" value={maxStdPerSlot} onChange={(e) => setMaxStdPerSlot(e.target.value)} placeholder="Unlimited" />
                </div>
                <div className="space-y-1.5">
                  <Label>Max express orders/slot</Label>
                  <Input type="number" min="1" step="1" value={maxExpPerSlot} onChange={(e) => setMaxExpPerSlot(e.target.value)} placeholder="Unlimited" />
                </div>
              </div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={handleSave} disabled={patchMutation.isPending}>
                {patchMutation.isPending ? "Saving…" : "Save pricing"}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setEditing(false)}>Cancel</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Tab: Weekly Slots ──────────────────────────────────────────────────────────

type SlotDialogMode = "create" | "edit";

function WeeklySlotsTab({ cityId, canManage }: { cityId: number; canManage: boolean }) {
  const { toast } = useToast();
  const [selectedDay, setSelectedDay] = useState(1);
  const [dialog, setDialog] = useState<{ mode: SlotDialogMode; slot?: WeeklySlot } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WeeklySlot | null>(null);
  const [copyDialogOpen, setCopyDialogOpen] = useState(false);
  const [copyToDays, setCopyToDays] = useState<number[]>([]);
  const [copyToCityIds, setCopyToCityIds] = useState<number[]>([]);

  const [label, setLabel] = useState("");
  const [startTime, setStartTime] = useState("10:00");
  const [endTime, setEndTime] = useState("14:00");
  const [feeOverride, setFeeOverride] = useState("");
  const [cutoffTime, setCutoffTime] = useState("");
  const [capacity, setCapacity] = useState("");
  const [note, setNote] = useState("");
  const [isEnabled, setIsEnabled] = useState(true);
  const [deliveryType, setDeliveryType] = useState("standard");
  const [sameDayAvailable, setSameDayAvailable] = useState(false);
  const [nextDayAvailable, setNextDayAvailable] = useState(true);

  const { data, isLoading } = useQuery<{ slots: WeeklySlot[] }>({
    queryKey: ["city-weekly-slots", cityId],
    queryFn: () => apiFetch(`/api/cities/${cityId}/weekly-slots`),
  });
  const allSlots = data?.slots ?? [];

  const { data: citiesData } = useQuery<{ cities: { id: number; name: string }[] }>({
    queryKey: ["cities"],
    queryFn: () => apiFetch(`/api/cities`),
    enabled: copyDialogOpen,
  });
  const otherCities = (citiesData?.cities ?? []).filter((c) => c.id !== cityId);
  const daySlots = allSlots.filter((s) => s.day_of_week === selectedDay);

  const sundaySlots = allSlots.filter((s) => s.day_of_week === 0 && s.is_enabled);
  const hasSundayWarning = !isLoading && sundaySlots.length === 0;
  const dayHasNoEnabledSlots = !isLoading && daySlots.length > 0 && daySlots.every((s) => !s.is_enabled);

  function openCreate() {
    setLabel(""); setStartTime("10:00"); setEndTime("14:00");
    setFeeOverride(""); setCutoffTime(""); setCapacity(""); setNote("");
    setIsEnabled(true); setDeliveryType("standard");
    setSameDayAvailable(false); setNextDayAvailable(true);
    setDialog({ mode: "create" });
  }

  function openEdit(slot: WeeklySlot) {
    setLabel(slot.label);
    setStartTime(slot.start_time);
    setEndTime(slot.end_time);
    setFeeOverride(slot.fee_override != null ? String(slot.fee_override) : "");
    setCutoffTime(slot.cutoff_time ?? "");
    setCapacity(slot.capacity != null ? String(slot.capacity) : "");
    setNote(slot.internal_note ?? "");
    setIsEnabled(slot.is_enabled);
    setDeliveryType(slot.delivery_type ?? "standard");
    setSameDayAvailable(slot.same_day_available ?? false);
    setNextDayAvailable(slot.next_day_available ?? true);
    setDialog({ mode: "edit", slot });
  }

  const createMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch(`/api/cities/${cityId}/weekly-slots`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["city-weekly-slots", cityId] });
      queryClient.invalidateQueries({ queryKey: ["city-schedule-summary", cityId] });
      setDialog(null);
      toast({ title: "Slot added" });
    },
    onError: (err: unknown) => toast({ title: "Failed", description: err instanceof Error ? err.message : "Error", variant: "destructive" }),
  });

  const patchMutation = useMutation({
    mutationFn: ({ slotId, ...body }: { slotId: number } & Record<string, unknown>) =>
      apiFetch(`/api/cities/${cityId}/weekly-slots/${slotId}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["city-weekly-slots", cityId] });
      queryClient.invalidateQueries({ queryKey: ["city-schedule-summary", cityId] });
      setDialog(null);
      toast({ title: "Slot updated" });
    },
    onError: (err: unknown) => toast({ title: "Failed", description: err instanceof Error ? err.message : "Error", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (slotId: number) =>
      apiFetch(`/api/cities/${cityId}/weekly-slots/${slotId}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["city-weekly-slots", cityId] });
      queryClient.invalidateQueries({ queryKey: ["city-schedule-summary", cityId] });
      setDeleteTarget(null);
      toast({ title: "Slot deleted" });
    },
    onError: (err: unknown) => toast({ title: "Failed", description: err instanceof Error ? err.message : "Error", variant: "destructive" }),
  });

  const copyMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch(`/api/cities/${cityId}/weekly-slots/copy`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["city-weekly-slots", cityId] });
      queryClient.invalidateQueries({ queryKey: ["city-schedule-summary"] });
      setCopyDialogOpen(false);
      setCopyToDays([]);
      setCopyToCityIds([]);
      toast({ title: "Slots copied" });
    },
    onError: (err: unknown) => toast({ title: "Failed", description: err instanceof Error ? err.message : "Error", variant: "destructive" }),
  });

  function buildSlotBody() {
    return {
      label, start_time: startTime, end_time: endTime, is_enabled: isEnabled,
      fee_override: feeOverride !== "" ? parseFloat(feeOverride) : null,
      cutoff_time: cutoffTime || null,
      capacity: capacity !== "" ? parseInt(capacity, 10) : null,
      internal_note: note || null,
      delivery_type: deliveryType,
      same_day_available: sameDayAvailable,
      next_day_available: nextDayAvailable,
    };
  }

  function handleSave() {
    if (dialog?.mode === "create") {
      createMutation.mutate({ ...buildSlotBody(), day_of_week: selectedDay });
    } else if (dialog?.mode === "edit" && dialog.slot) {
      patchMutation.mutate({ slotId: dialog.slot.id, ...buildSlotBody() });
    }
  }

  const toggleSlot = useCallback((slot: WeeklySlot) => {
    patchMutation.mutate({ slotId: slot.id, is_enabled: !slot.is_enabled });
  }, [patchMutation]);

  const slotsPerDay = (dow: number) => allSlots.filter((s) => s.day_of_week === dow).length;
  const enabledPerDay = (dow: number) => allSlots.filter((s) => s.day_of_week === dow && s.is_enabled).length;

  return (
    <div className="space-y-4">
      {hasSundayWarning && (
        <WarningBanner message="Sunday has no enabled delivery slots. Customers will not be able to schedule deliveries on Sunday." />
      )}

      <div className="flex flex-wrap gap-1">
        {[1, 2, 3, 4, 5, 6, 0].map((dow) => {
          const total = slotsPerDay(dow);
          const enabled = enabledPerDay(dow);
          const hasWarning = total > 0 && enabled === 0;
          return (
            <button
              key={dow}
              onClick={() => setSelectedDay(dow)}
              className={`relative px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors ${
                selectedDay === dow
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted/80"
              }`}
            >
              {DAY_SHORT[dow]}
              {total > 0 && (
                <span className="ml-1 text-[10px] opacity-70">{enabled}/{total}</span>
              )}
              {hasWarning && (
                <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-amber-400" />
              )}
            </button>
          );
        })}
      </div>

      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{DAY_NAMES[selectedDay]} slots</h3>
        {canManage && (
          <div className="flex gap-2">
            {daySlots.length > 0 && (
              <Button variant="outline" size="sm" className="gap-1.5 text-xs"
                onClick={() => { setCopyToDays([]); setCopyToCityIds([]); setCopyDialogOpen(true); }}>
                <Copy size={12} /> Copy to…
              </Button>
            )}
            <Button size="sm" className="gap-1.5 text-xs" onClick={openCreate}>
              <Plus size={13} /> Add slot
            </Button>
          </div>
        )}
      </div>

      {dayHasNoEnabledSlots && (
        <WarningBanner message={`All slots for ${DAY_NAMES[selectedDay]} are disabled. No deliveries will be available on this day.`} />
      )}

      {isLoading ? (
        <div className="space-y-2">{[1, 2].map((i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
      ) : daySlots.length === 0 ? (
        <div className="rounded-lg border border-dashed px-4 py-8 text-center">
          <Clock size={28} className="mx-auto text-muted-foreground/40 mb-2" />
          <p className="text-sm text-muted-foreground">No slots for {DAY_NAMES[selectedDay]}</p>
          {canManage && (
            <Button size="sm" variant="outline" className="mt-3 gap-1.5 text-xs" onClick={openCreate}>
              <Plus size={13} /> Add first slot
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {daySlots.map((slot) => (
            <div
              key={slot.id}
              className={`rounded-lg border px-4 py-3 flex items-center gap-3 ${!slot.is_enabled ? "opacity-55 bg-muted/30" : "bg-card"}`}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-medium text-sm">{slot.label || "Slot"}</span>
                  <Badge variant="outline" className="text-[10px] px-1.5 font-mono">
                    {slot.start_time}–{slot.end_time}
                  </Badge>
                  {!slot.is_enabled && <Badge variant="secondary" className="text-[10px] px-1.5">Disabled</Badge>}
                  {slot.delivery_type === "express" && (
                    <Badge className="text-[10px] px-1.5 bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">Express</Badge>
                  )}
                </div>
                <div className="flex gap-3 mt-0.5 text-[11px] text-muted-foreground">
                  {slot.fee_override != null && <span>${Number(slot.fee_override).toFixed(2)} fee</span>}
                  {slot.cutoff_time && <span>Cutoff: {slot.cutoff_time}</span>}
                  {slot.capacity != null && <span>Cap: {slot.capacity}</span>}
                  {slot.same_day_available && <span>Same-day</span>}
                  {slot.next_day_available && <span>Next-day</span>}
                </div>
              </div>
              {canManage && (
                <div className="flex items-center gap-1 shrink-0">
                  <Switch
                    checked={slot.is_enabled}
                    onCheckedChange={() => toggleSlot(slot)}
                    className="scale-75"
                  />
                  <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => openEdit(slot)}>
                    <Pencil size={12} />
                  </Button>
                  <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setDeleteTarget(slot)}>
                    <Trash2 size={12} className="text-destructive" />
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <Dialog open={dialog !== null} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{dialog?.mode === "create" ? "Add slot" : "Edit slot"} — {DAY_NAMES[selectedDay]}</DialogTitle>
            <DialogDescription>Configure the delivery time window and capacity for this slot.</DialogDescription>
          </DialogHeader>
          <SlotFormFields
            label={label} setLabel={setLabel} startTime={startTime} setStartTime={setStartTime}
            endTime={endTime} setEndTime={setEndTime} feeOverride={feeOverride} setFeeOverride={setFeeOverride}
            cutoffTime={cutoffTime} setCutoffTime={setCutoffTime} capacity={capacity} setCapacity={setCapacity}
            note={note} setNote={setNote} isEnabled={isEnabled} setIsEnabled={setIsEnabled}
            deliveryType={deliveryType} setDeliveryType={setDeliveryType}
            sameDayAvailable={sameDayAvailable} setSameDayAvailable={setSameDayAvailable}
            nextDayAvailable={nextDayAvailable} setNextDayAvailable={setNextDayAvailable}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)}>Cancel</Button>
            <Button onClick={handleSave} disabled={(createMutation.isPending || patchMutation.isPending) || !startTime || !endTime}>
              {(createMutation.isPending || patchMutation.isPending) ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete slot?</DialogTitle>
            <DialogDescription>
              This will remove the <strong>{deleteTarget?.label || "slot"}</strong> ({deleteTarget?.start_time}–{deleteTarget?.end_time}) slot. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)} disabled={deleteMutation.isPending}>
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={copyDialogOpen} onOpenChange={setCopyDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Copy {DAY_NAMES[selectedDay]} slots to…</DialogTitle>
            <DialogDescription>Copy these {daySlots.length} slot(s) to other days in this city, or to {DAY_NAMES[selectedDay]} in other cities. Existing slots in the selected targets will be replaced.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-2">Other days (this city)</p>
              <div className="grid grid-cols-4 gap-2">
                {[1, 2, 3, 4, 5, 6, 0].filter((d) => d !== selectedDay).map((dow) => (
                  <button
                    key={dow}
                    onClick={() => setCopyToDays((prev) => prev.includes(dow) ? prev.filter((d) => d !== dow) : [...prev, dow])}
                    className={`px-2 py-2 rounded-md text-xs font-medium border transition-colors ${
                      copyToDays.includes(dow) ? "bg-primary text-primary-foreground border-primary" : "bg-card border-border hover:bg-muted"
                    }`}
                  >
                    {DAY_SHORT[dow]}
                  </button>
                ))}
              </div>
            </div>
            {otherCities.length > 0 && (
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2">Other cities (same {DAY_NAMES[selectedDay]})</p>
                <div className="grid grid-cols-2 gap-2 max-h-48 overflow-y-auto">
                  {otherCities.map((c) => (
                    <button
                      key={c.id}
                      onClick={() => setCopyToCityIds((prev) => prev.includes(c.id) ? prev.filter((id) => id !== c.id) : [...prev, c.id])}
                      className={`px-2.5 py-2 rounded-md text-xs font-medium border transition-colors text-left truncate ${
                        copyToCityIds.includes(c.id) ? "bg-primary text-primary-foreground border-primary" : "bg-card border-border hover:bg-muted"
                      }`}
                      title={c.name}
                    >
                      {c.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCopyDialogOpen(false)}>Cancel</Button>
            <Button
              onClick={() => copyMutation.mutate({ from_day: selectedDay, to_days: copyToDays, to_city_ids: copyToCityIds })}
              disabled={(copyToDays.length + copyToCityIds.length) === 0 || copyMutation.isPending}
            >
              {copyMutation.isPending
                ? "Copying…"
                : `Copy to ${copyToDays.length + copyToCityIds.length} target${(copyToDays.length + copyToCityIds.length) !== 1 ? "s" : ""}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Tab: Express Delivery ──────────────────────────────────────────────────────

function ExpressTab({ city, canManage }: { city: CityForDrawer; canManage: boolean }) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [expressEnabled, setExpressEnabled] = useState(true);
  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [minPrep, setMinPrep] = useState("");
  const [dailyCap, setDailyCap] = useState("");
  const [expressFee, setExpressFee] = useState("");
  const [expressCutoff, setExpressCutoff] = useState("");

  const { data, isLoading } = useQuery<{ express_settings: ExpressSettings }>({
    queryKey: ["city-express-settings", city.id],
    queryFn: () => apiFetch(`/api/cities/${city.id}/express-settings`),
  });

  const settings = data?.express_settings;

  function startEditing() {
    setExpressEnabled(settings?.express_enabled ?? true);
    setStartTime(settings?.express_start_time ?? "");
    setEndTime(settings?.express_end_time ?? "");
    setMinPrep(settings?.express_min_prep_minutes != null ? String(settings.express_min_prep_minutes) : "");
    setDailyCap(settings?.express_daily_capacity != null ? String(settings.express_daily_capacity) : "");
    setExpressFee(settings?.express_fee != null ? String(parseFloat(settings.express_fee)) : "");
    setExpressCutoff(settings?.express_cutoff_time ?? "");
    setEditing(true);
  }

  const patchMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch(`/api/cities/${city.id}/express-settings`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["city-express-settings", city.id] });
      queryClient.invalidateQueries({ queryKey: ["city-schedule-summary", city.id] });
      toast({ title: "Express settings saved" });
      setEditing(false);
    },
    onError: (err: unknown) => {
      toast({ title: "Save failed", description: err instanceof Error ? err.message : "Error", variant: "destructive" });
    },
  });

  function handleSave() {
    const body: Record<string, unknown> = { express_enabled: expressEnabled };
    if (startTime) body.express_start_time = startTime;
    if (endTime) body.express_end_time = endTime;
    if (minPrep !== "") body.express_min_prep_minutes = parseInt(minPrep, 10);
    if (dailyCap !== "") body.express_daily_capacity = parseInt(dailyCap, 10);
    if (expressFee !== "") body.express_fee = parseFloat(expressFee);
    if (expressCutoff) body.express_cutoff_time = expressCutoff;
    patchMutation.mutate(body);
  }

  const windowConfigured = !!(settings?.express_start_time && settings?.express_end_time);
  const showWindowWarning = !isLoading && settings?.express_enabled && !windowConfigured;
  const showCutoffWarning = !isLoading && settings?.express_enabled && windowConfigured && !settings?.express_cutoff_time;

  if (isLoading) return (
    <div className="space-y-3">
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-24 w-full" />
    </div>
  );

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-semibold mb-1">District Express Delivery Window</h3>
        <p className="text-xs text-muted-foreground">
          Configure the daily express window and optional district-level fee/cutoff override. These settings extend the city-level express configuration set in the Pricing tab.
        </p>
      </div>

      {showWindowWarning && (
        <WarningBanner message="Express delivery is enabled but the district window (start/end time) is not configured. Set a start and end time below." />
      )}
      {showCutoffWarning && (
        <WarningBanner message="Express window is configured but no cutoff time is set. Consider adding a cutoff to stop same-day express orders before the window opens." />
      )}

      <div className="rounded-lg border bg-card p-4 space-y-4">
        {!editing ? (
          <>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-xs font-medium">Express enabled</span>
              {settings?.express_enabled
                ? <Badge className="text-[10px] px-1.5 bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">Yes</Badge>
                : <Badge variant="secondary" className="text-[10px] px-1.5">No</Badge>}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <div>
                <p className="text-xs text-muted-foreground mb-0.5">Window start</p>
                <p className="font-medium text-sm">{settings?.express_start_time ?? "—"}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-0.5">Window end</p>
                <p className="font-medium text-sm">{settings?.express_end_time ?? "—"}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-0.5">Min prep (min)</p>
                <p className="font-medium text-sm">{settings?.express_min_prep_minutes ?? "—"}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-0.5">Daily capacity</p>
                <p className="font-medium text-sm">{settings?.express_daily_capacity ?? "—"}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-0.5">District fee override</p>
                <p className="font-medium text-sm">
                  {settings?.express_fee != null ? `$${parseFloat(settings.express_fee).toFixed(2)}` : "—"}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground mb-0.5">District cutoff</p>
                <p className="font-medium text-sm">{settings?.express_cutoff_time ?? "—"}</p>
              </div>
            </div>
            {canManage && (
              <Button variant="outline" size="sm" onClick={startEditing} className="gap-1.5">
                <Pencil size={13} /> Edit express settings
              </Button>
            )}
          </>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <Switch checked={expressEnabled} onCheckedChange={setExpressEnabled} id="district-express-enabled" />
              <Label htmlFor="district-express-enabled">District express enabled</Label>
            </div>
            {expressEnabled && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>Window start time</Label>
                  <Input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label>Window end time</Label>
                  <Input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label>Min prep (minutes)</Label>
                  <Input type="number" min="0" step="1" value={minPrep} onChange={(e) => setMinPrep(e.target.value)} placeholder="e.g. 30" />
                </div>
                <div className="space-y-1">
                  <Label>Daily capacity</Label>
                  <Input type="number" min="1" step="1" value={dailyCap} onChange={(e) => setDailyCap(e.target.value)} placeholder="e.g. 50" />
                </div>
                <div className="space-y-1">
                  <Label>District fee override ($)</Label>
                  <Input type="number" min="0" step="0.01" value={expressFee} onChange={(e) => setExpressFee(e.target.value)} placeholder="Inherit from city" />
                </div>
                <div className="space-y-1">
                  <Label>District cutoff time</Label>
                  <Input type="time" value={expressCutoff} onChange={(e) => setExpressCutoff(e.target.value)} />
                </div>
              </div>
            )}
            <div className="flex gap-2">
              <Button size="sm" onClick={handleSave} disabled={patchMutation.isPending}>
                {patchMutation.isPending ? "Saving…" : "Save"}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setEditing(false)}>Cancel</Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Override Slot List ─────────────────────────────────────────────────────────

function OverrideSlotList({ overrideId, canManage }: { overrideId: number; canManage: boolean }) {
  const { toast } = useToast();
  const [dialog, setDialog] = useState<{ mode: "create" | "edit"; slot?: OverrideSlot } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<OverrideSlot | null>(null);
  const [label, setLabel] = useState("");
  const [startTime, setStartTime] = useState("10:00");
  const [endTime, setEndTime] = useState("14:00");
  const [feeOverride, setFeeOverride] = useState("");
  const [cutoffTime, setCutoffTime] = useState("");
  const [capacity, setCapacity] = useState("");
  const [note, setNote] = useState("");
  const [isEnabled, setIsEnabled] = useState(true);
  const [deliveryType, setDeliveryType] = useState("standard");
  const [sameDayAvailable, setSameDayAvailable] = useState(false);
  const [nextDayAvailable, setNextDayAvailable] = useState(true);

  const { data } = useQuery<{ slots: OverrideSlot[] }>({
    queryKey: ["override-slots", overrideId],
    queryFn: () => apiFetch(`/api/delivery-overrides/${overrideId}/slots`),
  });
  const slots = data?.slots ?? [];

  function openCreate() {
    setLabel(""); setStartTime("10:00"); setEndTime("14:00");
    setFeeOverride(""); setCutoffTime(""); setCapacity(""); setNote("");
    setIsEnabled(true); setDeliveryType("standard");
    setSameDayAvailable(false); setNextDayAvailable(true);
    setDialog({ mode: "create" });
  }

  function openEdit(slot: OverrideSlot) {
    setLabel(slot.label); setStartTime(slot.start_time); setEndTime(slot.end_time);
    setFeeOverride(slot.fee_override != null ? String(slot.fee_override) : "");
    setCutoffTime(slot.cutoff_time ?? ""); setCapacity(slot.capacity != null ? String(slot.capacity) : "");
    setNote(slot.internal_note ?? ""); setIsEnabled(slot.is_enabled);
    setDeliveryType(slot.delivery_type ?? "standard");
    setSameDayAvailable(slot.same_day_available ?? false);
    setNextDayAvailable(slot.next_day_available ?? true);
    setDialog({ mode: "edit", slot });
  }

  const createMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch(`/api/delivery-overrides/${overrideId}/slots`, { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["override-slots", overrideId] }); setDialog(null); toast({ title: "Slot added" }); },
    onError: (err: unknown) => toast({ title: "Failed", description: err instanceof Error ? err.message : "Error", variant: "destructive" }),
  });

  const patchMutation = useMutation({
    mutationFn: ({ slotId, ...body }: { slotId: number } & Record<string, unknown>) =>
      apiFetch(`/api/delivery-overrides/${overrideId}/slots/${slotId}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["override-slots", overrideId] }); setDialog(null); toast({ title: "Slot updated" }); },
    onError: (err: unknown) => toast({ title: "Failed", description: err instanceof Error ? err.message : "Error", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (slotId: number) =>
      apiFetch(`/api/delivery-overrides/${overrideId}/slots/${slotId}`, { method: "DELETE" }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ["override-slots", overrideId] }); setDeleteTarget(null); toast({ title: "Slot deleted" }); },
    onError: (err: unknown) => toast({ title: "Failed", description: err instanceof Error ? err.message : "Error", variant: "destructive" }),
  });

  function buildBody() {
    return {
      label, start_time: startTime, end_time: endTime, is_enabled: isEnabled,
      fee_override: feeOverride !== "" ? parseFloat(feeOverride) : null,
      cutoff_time: cutoffTime || null,
      capacity: capacity !== "" ? parseInt(capacity, 10) : null,
      internal_note: note || null,
      delivery_type: deliveryType,
      same_day_available: sameDayAvailable,
      next_day_available: nextDayAvailable,
    };
  }

  return (
    <div className="pl-4 border-l mt-2 space-y-2">
      {slots.length === 0 ? (
        <p className="text-xs text-muted-foreground italic">No time slots yet for this override.</p>
      ) : (
        slots.map((slot) => (
          <div key={slot.id} className={`rounded border px-3 py-2 flex items-center gap-2 ${!slot.is_enabled ? "opacity-55" : ""}`}>
            <div className="flex-1 text-xs">
              <span className="font-medium">{slot.label || "Slot"}</span>{" "}
              <span className="font-mono text-muted-foreground">{slot.start_time}–{slot.end_time}</span>
              {slot.fee_override != null && <span className="ml-2 text-muted-foreground">${Number(slot.fee_override).toFixed(2)}</span>}
            </div>
            {canManage && (
              <div className="flex gap-1">
                <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => openEdit(slot)}>
                  <Pencil size={11} />
                </Button>
                <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => setDeleteTarget(slot)}>
                  <Trash2 size={11} className="text-destructive" />
                </Button>
              </div>
            )}
          </div>
        ))
      )}
      {canManage && (
        <Button size="sm" variant="outline" className="gap-1 text-xs h-7" onClick={openCreate}>
          <Plus size={11} /> Add slot
        </Button>
      )}

      <Dialog open={dialog !== null} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{dialog?.mode === "create" ? "Add override slot" : "Edit override slot"}</DialogTitle>
          </DialogHeader>
          <SlotFormFields
            label={label} setLabel={setLabel} startTime={startTime} setStartTime={setStartTime}
            endTime={endTime} setEndTime={setEndTime} feeOverride={feeOverride} setFeeOverride={setFeeOverride}
            cutoffTime={cutoffTime} setCutoffTime={setCutoffTime} capacity={capacity} setCapacity={setCapacity}
            note={note} setNote={setNote} isEnabled={isEnabled} setIsEnabled={setIsEnabled}
            deliveryType={deliveryType} setDeliveryType={setDeliveryType}
            sameDayAvailable={sameDayAvailable} setSameDayAvailable={setSameDayAvailable}
            nextDayAvailable={nextDayAvailable} setNextDayAvailable={setNextDayAvailable}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialog(null)}>Cancel</Button>
            <Button
              onClick={() => {
                if (dialog?.mode === "create") createMutation.mutate(buildBody());
                else if (dialog?.slot) patchMutation.mutate({ slotId: dialog.slot.id, ...buildBody() });
              }}
              disabled={createMutation.isPending || patchMutation.isPending || !startTime || !endTime}
            >
              {(createMutation.isPending || patchMutation.isPending) ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Delete slot?</DialogTitle></DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)} disabled={deleteMutation.isPending}>
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Tab: Special Date Overrides ───────────────────────────────────────────────

function SpecialDatesTab({ cityId, canManage }: { cityId: number; canManage: boolean }) {
  const { toast } = useToast();
  const [createOpen, setCreateOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<SpecialDateOverride | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SpecialDateOverride | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const [name, setName] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [overrideType, setOverrideType] = useState<"replace_regular_schedule" | "add_to_regular_schedule">("replace_regular_schedule");
  const [expressEnabled, setExpressEnabled] = useState(false);
  const [expressStart, setExpressStart] = useState("");
  const [expressEnd, setExpressEnd] = useState("");
  const [internalNote, setInternalNote] = useState("");
  const [isActive, setIsActive] = useState(true);

  const { data, isLoading } = useQuery<{ overrides: SpecialDateOverride[] }>({
    queryKey: ["delivery-overrides", cityId],
    queryFn: () => apiFetch(`/api/delivery-overrides?city_id=${cityId}`),
  });
  const overrides = data?.overrides ?? [];

  function openCreate() {
    setName(""); setStartDate(""); setEndDate("");
    setOverrideType("replace_regular_schedule");
    setExpressEnabled(false); setExpressStart(""); setExpressEnd("");
    setInternalNote(""); setIsActive(true);
    setCreateOpen(true);
  }

  function openEdit(ov: SpecialDateOverride) {
    setName(ov.name); setStartDate(ov.start_date); setEndDate(ov.end_date);
    setOverrideType(ov.override_type); setExpressEnabled(ov.express_enabled);
    setExpressStart(ov.express_start_time ?? ""); setExpressEnd(ov.express_end_time ?? "");
    setInternalNote(ov.internal_note ?? ""); setIsActive(ov.is_active);
    setEditTarget(ov);
  }

  const createMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch("/api/delivery-overrides", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["delivery-overrides", cityId] });
      queryClient.invalidateQueries({ queryKey: ["city-schedule-summary", cityId] });
      setCreateOpen(false);
      toast({ title: "Override created" });
    },
    onError: (err: unknown) => toast({ title: "Failed", description: err instanceof Error ? err.message : "Error", variant: "destructive" }),
  });

  const patchMutation = useMutation({
    mutationFn: ({ id, ...body }: { id: number } & Record<string, unknown>) =>
      apiFetch(`/api/delivery-overrides/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["delivery-overrides", cityId] });
      queryClient.invalidateQueries({ queryKey: ["city-schedule-summary", cityId] });
      setEditTarget(null);
      toast({ title: "Override updated" });
    },
    onError: (err: unknown) => toast({ title: "Failed", description: err instanceof Error ? err.message : "Error", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/delivery-overrides/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["delivery-overrides", cityId] });
      queryClient.invalidateQueries({ queryKey: ["city-schedule-summary", cityId] });
      setDeleteTarget(null);
      toast({ title: "Override deleted" });
    },
    onError: (err: unknown) => toast({ title: "Failed", description: err instanceof Error ? err.message : "Error", variant: "destructive" }),
  });

  function buildBody() {
    return {
      name, start_date: startDate, end_date: endDate,
      city_id: cityId, override_type: overrideType,
      express_enabled: expressEnabled,
      express_start_time: expressStart || null,
      express_end_time: expressEnd || null,
      internal_note: internalNote || null,
      is_active: isActive,
    };
  }

  function OverrideFormBody() {
    return (
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label>Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Eid Al-Adha" autoFocus />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label>Start date</Label>
            <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label>End date</Label>
            <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label>Schedule behavior</Label>
          {overrideType === "replace_regular_schedule" && (
            <div className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded px-2.5 py-1.5 mb-1">
              <AlertTriangle size={12} className="shrink-0 mt-0.5" />
              <span>Replace mode will hide all regular weekly slots for the date range — only override slots will be shown.</span>
            </div>
          )}
          <div className="flex gap-2">
            {(["replace_regular_schedule", "add_to_regular_schedule"] as const).map((type) => (
              <button
                key={type}
                onClick={() => setOverrideType(type)}
                className={`flex-1 text-xs px-3 py-2 rounded-md border transition-colors ${
                  overrideType === type ? "bg-primary text-primary-foreground border-primary" : "bg-card hover:bg-muted border-border"
                }`}
              >
                {type === "replace_regular_schedule" ? "Replace schedule" : "Add to schedule"}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Switch checked={expressEnabled} onCheckedChange={setExpressEnabled} id="ov-express" />
          <Label htmlFor="ov-express">Custom express window</Label>
        </div>
        {expressEnabled && (
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Express start</Label>
              <Input type="time" value={expressStart} onChange={(e) => setExpressStart(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Express end</Label>
              <Input type="time" value={expressEnd} onChange={(e) => setExpressEnd(e.target.value)} />
            </div>
          </div>
        )}
        <div className="space-y-1.5">
          <Label>Internal note</Label>
          <Input value={internalNote} onChange={(e) => setInternalNote(e.target.value)} placeholder="Optional" />
        </div>
        <div className="flex items-center gap-2">
          <Switch checked={isActive} onCheckedChange={setIsActive} id="ov-active" />
          <Label htmlFor="ov-active">Active</Label>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">Special Date Overrides</h3>
          <p className="text-xs text-muted-foreground mt-0.5">Override or extend the regular schedule for holidays, special events, or blackout periods.</p>
        </div>
        {canManage && (
          <Button size="sm" className="gap-1.5 text-xs shrink-0" onClick={openCreate}>
            <Plus size={13} /> New override
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-2">{[1, 2].map((i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
      ) : overrides.length === 0 ? (
        <div className="rounded-lg border border-dashed px-4 py-8 text-center">
          <CalendarRange size={28} className="mx-auto text-muted-foreground/40 mb-2" />
          <p className="text-sm text-muted-foreground">No special date overrides yet</p>
          {canManage && (
            <Button size="sm" variant="outline" className="mt-3 gap-1.5 text-xs" onClick={openCreate}>
              <Plus size={13} /> Add override
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {overrides.map((ov) => (
            <div key={ov.id} className={`rounded-lg border bg-card overflow-hidden ${!ov.is_active ? "opacity-60" : ""}`}>
              <div className="flex items-center gap-3 px-4 py-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm">{ov.name}</span>
                    {!ov.is_active && <Badge variant="secondary" className="text-[10px] px-1.5">Inactive</Badge>}
                    <Badge variant="outline" className="text-[10px] px-1.5">
                      {ov.override_type === "replace_regular_schedule" ? "Replace" : "Append"}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    <Calendar size={10} className="inline mr-1" />
                    {ov.start_date === ov.end_date ? ov.start_date : `${ov.start_date} → ${ov.end_date}`}
                  </p>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button onClick={() => setExpandedId(expandedId === ov.id ? null : ov.id)} className="text-muted-foreground hover:text-foreground p-1">
                    {expandedId === ov.id ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
                  </button>
                  {canManage && (
                    <>
                      <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => openEdit(ov)}>
                        <Pencil size={12} />
                      </Button>
                      <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setDeleteTarget(ov)}>
                        <Trash2 size={12} className="text-destructive" />
                      </Button>
                    </>
                  )}
                </div>
              </div>
              {expandedId === ov.id && (
                <div className="px-4 pb-3 border-t pt-2">
                  <p className="text-xs text-muted-foreground mb-2">Time slots for this override:</p>
                  <OverrideSlotList overrideId={ov.id} canManage={canManage} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New date override</DialogTitle>
            <DialogDescription>Create a special schedule for a date or date range.</DialogDescription>
          </DialogHeader>
          <OverrideFormBody />
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button onClick={() => createMutation.mutate(buildBody())} disabled={createMutation.isPending || !name || !startDate || !endDate}>
              {createMutation.isPending ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={editTarget !== null} onOpenChange={(open) => !open && setEditTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Edit override</DialogTitle></DialogHeader>
          <OverrideFormBody />
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditTarget(null)}>Cancel</Button>
            <Button onClick={() => editTarget && patchMutation.mutate({ id: editTarget.id, ...buildBody() })} disabled={patchMutation.isPending || !name || !startDate || !endDate}>
              {patchMutation.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete override?</DialogTitle>
            <DialogDescription>
              Deleting <strong>{deleteTarget?.name}</strong> will also remove all its time slots. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => deleteTarget && deleteMutation.mutate(deleteTarget.id)} disabled={deleteMutation.isPending}>
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Main Drawer ────────────────────────────────────────────────────────────────

type DrawerTab = "pricing" | "weekly-slots" | "express" | "special-dates";

interface DistrictDeliveryRulesDrawerProps {
  city: CityForDrawer | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canManage: boolean;
  initialTab?: DrawerTab;
}

export function DistrictDeliveryRulesDrawer({
  city, open, onOpenChange, canManage, initialTab = "pricing",
}: DistrictDeliveryRulesDrawerProps) {
  const [tab, setTab] = useState<DrawerTab>(initialTab);

  useEffect(() => {
    if (open) setTab(initialTab);
  }, [open, initialTab]);

  const { data: summary } = useQuery<ScheduleSummary>({
    queryKey: ["city-schedule-summary", city?.id],
    queryFn: () => apiFetch(`/api/cities/${city!.id}/schedule-summary`),
    enabled: open && city != null,
  });

  if (!city) return null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto flex flex-col gap-0 p-0">
        <SheetHeader className="px-6 pt-6 pb-4 border-b">
          <SheetTitle className="text-xl">{city.name}</SheetTitle>
          <SheetDescription>
            Delivery scheduling — pricing, time slots, express settings, and date overrides.
          </SheetDescription>

          {summary && (
            <div className="flex flex-wrap gap-2 pt-1">
              <Badge variant="outline" className="text-xs gap-1 font-normal">
                <Clock size={11} />
                {summary.enabled_weekly_slots} weekly slots
              </Badge>
              <Badge
                variant={summary.sunday_enabled_slots === 0 ? "destructive" : "outline"}
                className="text-xs gap-1 font-normal"
              >
                <CalendarRange size={11} />
                {summary.sunday_enabled_slots} Sunday
                {summary.sunday_enabled_slots === 0 && " ⚠"}
              </Badge>
              <Badge variant="outline" className="text-xs gap-1 font-normal">
                <CalendarRange size={11} />
                {summary.active_overrides} override{summary.active_overrides !== 1 ? "s" : ""}
              </Badge>
              {summary.express_window_configured ? (
                <Badge className="text-xs gap-1 font-normal bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 border-green-200">
                  <Zap size={11} />
                  Express configured
                </Badge>
              ) : city.express_delivery_enabled ? (
                <Badge className="text-xs gap-1 font-normal bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border-amber-200">
                  <AlertTriangle size={11} />
                  Express window missing
                </Badge>
              ) : null}
            </div>
          )}
        </SheetHeader>

        <div className="flex-1 px-6 py-5">
          <Tabs value={tab} onValueChange={(v) => setTab(v as DrawerTab)}>
            <TabsList className="w-full mb-5 grid grid-cols-4">
              <TabsTrigger value="pricing" className="gap-1 text-xs">
                <DollarSign size={13} />
                <span className="hidden sm:inline">Pricing</span>
              </TabsTrigger>
              <TabsTrigger value="weekly-slots" className="gap-1 text-xs">
                <Clock size={13} />
                <span className="hidden sm:inline">Weekly</span>
              </TabsTrigger>
              <TabsTrigger value="express" className="gap-1 text-xs">
                <Zap size={13} />
                <span className="hidden sm:inline">Express</span>
              </TabsTrigger>
              <TabsTrigger value="special-dates" className="gap-1 text-xs">
                <CalendarRange size={13} />
                <span className="hidden sm:inline">Overrides</span>
              </TabsTrigger>
            </TabsList>

            <TabsContent value="pricing" className="mt-0">
              <PricingTab city={city} canManage={canManage} />
            </TabsContent>

            <TabsContent value="weekly-slots" className="mt-0">
              <WeeklySlotsTab cityId={city.id} canManage={canManage} />
            </TabsContent>

            <TabsContent value="express" className="mt-0">
              <ExpressTab city={city} canManage={canManage} />
            </TabsContent>

            <TabsContent value="special-dates" className="mt-0">
              <SpecialDatesTab cityId={city.id} canManage={canManage} />
            </TabsContent>
          </Tabs>
        </div>
      </SheetContent>
    </Sheet>
  );
}
