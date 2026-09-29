import { useState, useMemo, useCallback, useEffect } from "react";
import {
  useQuery,
  useMutation,
  useQueryClient,
  keepPreviousData,
} from "@tanstack/react-query";
import { Link, useSearch, useLocation } from "wouter";
import {
  ShoppingCart,
  Search,
  Loader2,
  ChevronRight,
  ChevronLeft,
  CalendarClock,
  CalendarIcon,
  Plus,
  Clock,
  Truck,
  AlertTriangle,
  MoreHorizontal,
  Eye,
  Phone,
  Link2,
  X,
  ArrowUp,
  ArrowDown,
  ArrowUpDown,
} from "lucide-react";
import { format } from "date-fns";
import { apiFetch, isAccessRequestError } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
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
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useTranslation } from "react-i18next";
import { useToast } from "@/hooks/use-toast";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { useRoles } from "@/hooks/use-roles";
import { useDocumentVisibility } from "@/hooks/use-document-visibility";
import {
  ORDER_STATUSES,
  ORDER_STATUS_LABEL_KEYS,
  normalizeOrderStatus,
  orderStatusBadgeClass,
} from "@/lib/orderStatus";
import { OrderStatusBadge } from "@/components/OrderStatusBadge";
import {
  marketDateKey,
  rescheduleErrorMessage,
  type RescheduleOptionsResponse,
} from "@/lib/deliveryDate";
import { orderDetailPath } from "@/lib/orderLink";
import { useRecentNewOrderIds } from "@/lib/new-order-highlight";
import { CreateOrderWizard } from "@/components/CreateOrderWizard";
import { formatSourceLabel } from "@/components/analytics/BreakdownCard";
import {
  type OrderRow,
  type DriverOption,
  type OrdersResponse,
  PAGE_SIZE,
  TERMINAL_STATUSES,
  FINISHED_STATUSES,
  hasDriver,
  driverFullName,
  driverInitials,
  isUnassigned,
  isCod,
  paymentBadge,
  isFinished,
  isAtRiskOrder,
  BUSINESS_TZ,
  getUrgency,
  OrderThumbnail,
} from "./orderRowHelpers";
import { OrdersBoard } from "./OrdersBoard";
import { DeliveryCell } from "./OrderDeliveryCell";

const DASHBOARD_SOURCE_LABELS: Record<string, string> = {
  manual: "Manual",
  whatsapp: "WhatsApp",
  instagram: "Instagram",
  phone: "Phone",
  walkin: "Walk-in",
  website: "Website",
  other: "Other",
};

function formatTotal(totals: Record<string, unknown> | null): string {
  if (!totals) return "—";
  // Prefer the amount actually paid (paid-currency pair stored at ingest, e.g.
  // CHF 70.00); USD/legacy orders fall back to the stored USD total as before.
  const paidTotal = totals.paid_total;
  const paidCurrency =
    typeof totals.paid_currency === "string" && totals.paid_currency.trim() !== ""
      ? totals.paid_currency
      : "";
  const hasPaid = paidTotal != null && paidCurrency && !Number.isNaN(Number(paidTotal));
  const total = hasPaid ? paidTotal : (totals.total ?? totals.grand_total ?? totals.order_total);
  const currency = hasPaid ? paidCurrency : ((totals.currency as string) ?? "");
  if (total == null) return "—";
  const num = Number(total);
  if (Number.isNaN(num)) return String(total);
  try {
    if (currency) {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency,
        minimumFractionDigits: 2,
      }).format(num);
    }
    return num.toFixed(2);
  } catch {
    return `${num.toFixed(2)} ${currency}`.trim();
  }
}

function timeInMarket(value: string | null, timeZone: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("hour")}:${get("minute")}`;
}

/**
 * Inline per-row status control. Persists via the existing
 * `PATCH /api/orders/:id/status` endpoint and refreshes the orders cache so the
 * badge/colour updates immediately. Only rendered for users with orders access;
 * falls back to a read-only badge for statuses outside the canonical set.
 */
function InlineStatusSelect({
  order,
  canChangeRefundedStatus,
}: {
  order: OrderRow;
  canChangeRefundedStatus: boolean;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (status: string) =>
      apiFetch(`/api/orders/${order.id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
      toast({ title: t("orders.statusUpdated") });
    },
    onError: (err) => {
      const code = (err as { code?: string } | null)?.code;
      toast({
        title: t("orders.statusUpdateFailed"),
        description:
          code === "payment_not_paid"
            ? t("orders.markPaidBeforeProcessing")
            : err instanceof Error
              ? err.message
              : String(err),
        variant: "destructive",
      });
    },
  });

  if (!(ORDER_STATUSES as readonly string[]).includes(order.status)) {
    return <OrderStatusBadge status={order.status} className="text-xs" />;
  }
  if (order.status === "refunded" && !canChangeRefundedStatus) {
    return <OrderStatusBadge status={order.status} className="text-xs" />;
  }

  const cls = orderStatusBadgeClass(order.status);

  return (
    <Select
      value={order.status}
      onValueChange={(v) => mutation.mutate(v)}
      disabled={mutation.isPending}
    >
      <SelectTrigger
        className={`h-7 w-auto gap-1 border px-2.5 py-0 text-xs font-medium capitalize ${cls}`}
        aria-label={t("orders.fieldStatus")}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {ORDER_STATUSES.map((s) => (
          <SelectItem key={s} value={s}>
            {t(ORDER_STATUS_LABEL_KEYS[s])}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * Per-row reschedule dialog. The list uses the same authoritative slot options
 * and save operation as Order Detail, so capacity, cutoff, market-timezone,
 * and delivery-method rules cannot be bypassed.
 */
function RescheduleDialog({
  order,
  open,
  onOpenChange,
}: {
  order: OrderRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  // A delivery happens on a single day, so the window is modelled as one chosen
  // day plus a start time and an end time on that day (derived from the existing
  // window_start / window_end timestamps).
  const marketTimeZone = order.delivery_timezone || "UTC";
  const initialDateKey = order.window_start
    ? marketDateKey(new Date(order.window_start), marketTimeZone)
    : typeof order.delivery_address?.date === "string"
      ? order.delivery_address.date.slice(0, 10)
      : "";
  const initialDate = /^\d{4}-\d{2}-\d{2}$/.test(initialDateKey)
    ? new Date(`${initialDateKey}T00:00:00`)
    : undefined;
  const [day, setDay] = useState<Date | undefined>(
    initialDate,
  );
  const [deliveryType, setDeliveryType] = useState<"standard" | "express">(
    order.delivery_type?.trim().toLowerCase() === "express" ? "express" : "standard",
  );
  const [selectedSlotId, setSelectedSlotId] = useState("");
  const [dayOpen, setDayOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [autoSelectCurrent, setAutoSelectCurrent] = useState(true);
  const date = day ? format(day, "yyyy-MM-dd") : "";
  const optionsQuery = useQuery<RescheduleOptionsResponse>({
    queryKey: ["order-reschedule-options", order.id, date, deliveryType],
    queryFn: () =>
      apiFetch<RescheduleOptionsResponse>(
        `/api/orders/${order.id}/reschedule-options?date=${encodeURIComponent(date)}&delivery_type=${deliveryType}`,
      ),
    enabled: open && Boolean(date),
    retry: false,
  });
  // React Query may retain the previous key's successful data while a new
  // date is loading. Never render or submit slots that belong to another day.
  const slots =
    optionsQuery.data?.date === date ? optionsQuery.data.slots : [];

  useEffect(() => {
    if (!open || !autoSelectCurrent || selectedSlotId || slots.length === 0) return;
    const currentStart = timeInMarket(order.window_start, marketTimeZone);
    const currentEnd = timeInMarket(order.window_end, marketTimeZone);
    const current = slots.find(
      (slot) => slot.start_time === currentStart && slot.end_time === currentEnd,
    );
    if (current) setSelectedSlotId(current.id);
  }, [
    marketTimeZone,
    autoSelectCurrent,
    open,
    order.window_end,
    order.window_start,
    selectedSlotId,
    slots,
  ]);

  async function handleSave() {
    const selected = slots.find((slot) => slot.id === selectedSlotId);
    if (!day || !selected) return;

    setSaving(true);
    setError(null);
    try {
      await apiFetch(`/api/orders/${order.id}/reschedule`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date,
          slot_id: selected.id,
          start_time: selected.start_time,
          end_time: selected.end_time,
          delivery_type: deliveryType,
        }),
      });

      await queryClient.invalidateQueries({ queryKey: ["orders"] });
      await queryClient.invalidateQueries({ queryKey: ["order", order.id] });
      await queryClient.invalidateQueries({ queryKey: ["order-reschedule-options", order.id] });
      toast({ title: t("orders.rescheduleSaved") });
      onOpenChange(false);
    } catch (err) {
      setAutoSelectCurrent(false);
      setSelectedSlotId("");
      setError(rescheduleErrorMessage(err, t("orders.rescheduleUnexpected")));
      await optionsQuery.refetch();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("orders.rescheduleTitle")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="orders-reschedule-delivery-type">
              {t("orders.rescheduleDeliveryType")}
            </Label>
            <Select
              value={deliveryType}
              onValueChange={(value) => {
                setDeliveryType(value as "standard" | "express");
                setAutoSelectCurrent(false);
                setSelectedSlotId("");
                setError(null);
              }}
            >
              <SelectTrigger
                id="orders-reschedule-delivery-type"
                data-testid="reschedule-delivery-type"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="standard">{t("orders.standardDelivery")}</SelectItem>
                <SelectItem value="express">{t("orders.expressDelivery")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>{t("orders.deliveryDay")}</Label>
            <Popover open={dayOpen} onOpenChange={setDayOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className={cn(
                    "w-full justify-start gap-2 text-left font-normal",
                    !day && "text-muted-foreground",
                  )}
                  data-testid="reschedule-day"
                >
                  <CalendarIcon size={15} className="shrink-0 text-muted-foreground" />
                  <span className="truncate">
                    {day ? format(day, "EEE, MMM d, yyyy") : t("orders.datePlaceholder")}
                  </span>
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={day}
                  onSelect={(d) => {
                    setDay(d);
                    setAutoSelectCurrent(false);
                    setSelectedSlotId("");
                    setError(null);
                    setDayOpen(false);
                  }}
                  defaultMonth={day ?? new Date()}
                />
              </PopoverContent>
            </Popover>
          </div>

          {day ? (
            <div className="space-y-1.5">
              <Label htmlFor="orders-reschedule-slot">
                {t("orders.availableDeliverySlot")}
              </Label>
              {optionsQuery.isLoading || optionsQuery.isFetching ? (
                <div className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm text-muted-foreground">
                  <Loader2 size={14} className="animate-spin" />
                  {t("orders.loadingDeliverySlots")}
                </div>
              ) : optionsQuery.isError ? (
                <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive">
                  {rescheduleErrorMessage(
                    optionsQuery.error,
                    t("orders.rescheduleUnexpected"),
                  )}
                </p>
              ) : slots.length === 0 ? (
                <p className="rounded-md border px-3 py-2 text-sm text-muted-foreground">
                  {t("orders.noDeliverySlotsAvailable")}
                </p>
              ) : (
                <Select value={selectedSlotId} onValueChange={setSelectedSlotId}>
                  <SelectTrigger
                    id="orders-reschedule-slot"
                    data-testid="reschedule-delivery-slot"
                  >
                    <SelectValue placeholder={t("orders.selectDeliverySlot")} />
                  </SelectTrigger>
                  <SelectContent>
                    {slots.map((slot) => (
                      <SelectItem key={slot.id} value={slot.id}>
                        {slot.label
                          ? `${slot.label} · ${slot.start_time}–${slot.end_time}`
                          : `${slot.start_time}–${slot.end_time}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("orders.pickDayFirst")}
            </p>
          )}
          {error && (
            <p
              role="alert"
              className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            {t("orders.editCancel")}
          </Button>
          <Button
            onClick={handleSave}
            disabled={saving || !day || !selectedSlotId || optionsQuery.isFetching}
          >
            {saving && <Loader2 className="animate-spin mr-1.5" size={14} />}
            {t("orders.editSave")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A single operational summary card (icon + count + label). */
function SummaryCard({
  icon,
  count,
  label,
  iconClass,
}: {
  icon: React.ReactNode;
  count: number;
  label: string;
  iconClass: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-4 shadow-sm">
      <div
        className={cn(
          "flex h-11 w-11 shrink-0 items-center justify-center rounded-lg",
          iconClass,
        )}
      >
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-2xl font-bold leading-none tabular-nums">{count}</div>
        <div className="mt-1 truncate text-xs text-muted-foreground">{label}</div>
      </div>
    </div>
  );
}

/**
 * Driver cell. An assigned driver gets the avatar + name; unassigned renders a
 * small "Taxi / Butler" quick-assign dropdown that POSTs directly to Tookan
 * without leaving the page.
 */
function DriverCell({ order }: { order: OrderRow }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const assignMutation = useMutation({
    mutationFn: (agent_type: "taxi" | "butler") =>
      apiFetch(`/api/orders/${order.id}/assign-tookan-agent`, {
        method: "POST",
        body: JSON.stringify({ agent_type }),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
      toast({ title: "Driver assigned successfully" });
    },
    onError: async (err) => {
      let message = "Assignment failed";
      if (err instanceof Error) {
        if ((err as { code?: string }).code === "no_tookan_job") {
          message = "Order has no Tookan job";
        } else {
          message = err.message || message;
        }
      }
      toast({ title: message, variant: "destructive" });
    },
  });

  if (!hasDriver(order)) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="text-xs text-muted-foreground/60 italic hover:text-primary hover:underline flex items-center gap-1 disabled:opacity-50"
            disabled={assignMutation.isPending}
            data-testid={`link-assign-driver-${order.id}`}
          >
            {assignMutation.isPending ? (
              <Loader2 size={11} className="animate-spin" />
            ) : null}
            + {t("orders.assignDriverShort")}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-28">
          <DropdownMenuItem
            onSelect={() => assignMutation.mutate("taxi")}
            disabled={assignMutation.isPending}
          >
            Taxi
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => assignMutation.mutate("butler")}
            disabled={assignMutation.isPending}
          >
            Butler
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }
  return (
    <div className="flex items-center gap-1.5">
      <Avatar className="h-6 w-6">
        <AvatarFallback className="bg-teal-100 text-[10px] font-semibold text-teal-800">
          {driverInitials(order)}
        </AvatarFallback>
      </Avatar>
      <span className="truncate text-sm">{driverFullName(order)}</span>
    </div>
  );
}

/**
 * Total cell with payment state folded in: paid orders show the bare amount;
 * unpaid/COD orders carry a small amber dot (meaning on hover); refunded shows
 * a muted marker. Replaces the old standalone Payment column.
 */
function TotalCell({ order }: { order: OrderRow }) {
  const { t } = useTranslation();
  const badge = paymentBadge(order);
  const needsAttention =
    badge != null && badge.labelKey !== "orders.paymentPaid" && badge.labelKey !== "orders.paymentRefunded";
  const refunded = badge?.labelKey === "orders.paymentRefunded";
  return (
    <div className="flex items-center gap-1.5">
      <span className={cn("font-medium tabular-nums", refunded && "text-muted-foreground line-through")}>
        {formatTotal(order.totals)}
      </span>
      {order.payment_summary && order.payment_summary.linked_count > 0 && (
        <span
          className="text-xs text-muted-foreground"
          title={`Paid ${Number(order.payment_summary.paid).toFixed(2)}, pending ${Number(order.payment_summary.pending).toFixed(2)}`}
        >
          {order.payment_summary.currency_mismatch
            ? "Payment currency differs"
            : `${Number(order.payment_summary.paid).toFixed(2)} paid`}
        </span>
      )}
      {needsAttention && (
        <span
          className="h-2 w-2 shrink-0 rounded-full bg-amber-500"
          title={t(badge!.labelKey)}
          aria-label={t(badge!.labelKey)}
          data-testid={`dot-unpaid-${order.id}`}
        />
      )}
      {refunded && (
        <span className="text-[10px] uppercase tracking-wide text-purple-600" title={t("orders.paymentRefunded")}>
          {t("orders.paymentRefunded")}
        </span>
      )}
    </div>
  );
}

/** Colour dot standing in for the removed Source text; meaning on hover. */
const SOURCE_DOT_COLORS: Record<string, string> = {
  manual: "bg-teal-500",
  dashboard: "bg-teal-500",
  toters: "bg-orange-500",
  website: "bg-blue-500",
  whatsapp: "bg-green-500",
  instagram: "bg-pink-500",
  phone: "bg-sky-500",
  walkin: "bg-lime-600",
};

function SourceDot({ source }: { source: string | null }) {
  if (!source) return null;
  const label =
    source === "toters" ? "Toters" : DASHBOARD_SOURCE_LABELS[source] ?? source;
  return (
    <span
      className={cn(
        "inline-block h-1.5 w-1.5 shrink-0 rounded-full",
        SOURCE_DOT_COLORS[source] ?? "bg-muted-foreground/50",
      )}
      title={label}
      aria-label={label}
    />
  );
}

export default function OrdersPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const {
    isOwner,
    role,
    allowedPages,
    customRoleIds = [],
  } = useWorkspaceRole();
  const { data: workspaceRolesData } = useRoles();
  const canChangeRefundedStatus =
    isOwner ||
    role === "admin" ||
    customRoleIds.some(
      (roleId) =>
        workspaceRolesData?.roles.some(
          (workspaceRole) =>
            workspaceRole.id === roleId && workspaceRole.name === "Ops 2",
        ) === true,
    );
  const canEditOrders = isOwner || !!allowedPages?.includes("orders");
  const search = useSearch();
  const [, navigate] = useLocation();
  const initialSearchParams = useMemo(() => new URLSearchParams(search), [search]);
  const attribution = initialSearchParams.get("attribution") ?? "";

  // List/Board view toggle. Persisted so returning to Orders remembers the
  // last-chosen view; falls back to List on first visit or storage failure.
  const [view, setView] = useState<"list" | "board">(() => {
    try {
      const stored = localStorage.getItem("orders-view");
      return stored === "board" ? "board" : "list";
    } catch {
      return "list";
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("orders-view", view);
    } catch {
      // Ignore storage errors (private browsing, quota) — view still works
      // for the current session.
    }
  }, [view]);

  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [statusFilter, setStatusFilter] = useState(
    () => initialSearchParams.get("status") || "all",
  );
  const [sourceFilter, setSourceFilter] = useState("all");
  const [countryFilter, setCountryFilter] = useState("all");
  const [driverFilter, setDriverFilter] = useState("all");
  const [activeChip, setActiveChip] = useState<string | null>(null);
  const [deliveryDates, setDeliveryDates] = useState<Date[]>(() =>
    (initialSearchParams.get("deliveryDates") ?? "")
      .split(",")
      .filter((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))
      .map((value) => new Date(`${value}T00:00:00`))
      .filter((value) => !Number.isNaN(value.getTime())),
  );
  const [slotFilter, setSlotFilter] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const [rescheduleOrder, setRescheduleOrder] = useState<OrderRow | null>(null);
  const [createOrderOpen, setCreateOrderOpen] = useState(false);
  const debounceRef = useState<ReturnType<typeof setTimeout> | null>(null);

  // Live clock for the countdowns and the Today/Tomorrow grouping. Ticks once
  // a minute so labels stay honest without a refresh, and the grouping
  // re-evaluates automatically when the business day rolls over.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);

  // Manual column sort. "urgency" (window-end ascending, grouped by day) is
  // the default and is restored whenever the page loads or filters change.
  type SortColumn = "order" | "customer" | "delivery" | "status" | "driver" | "total";
  const [manualSort, setManualSort] = useState<{ col: SortColumn; dir: "asc" | "desc" } | null>(null);

  function handleHeaderSort(col: SortColumn) {
    setManualSort((prev) =>
      prev?.col === col
        ? prev.dir === "asc"
          ? { col, dir: "desc" }
          : null // third click returns to the urgency default
        : { col, dir: "asc" },
    );
  }

  function handleSearch(value: string) {
    setQ(value);
    if (debounceRef[0]) clearTimeout(debounceRef[0]);
    debounceRef[1](
      setTimeout(() => {
        setDebouncedQ(value);
        setPage(0);
      }, 350),
    );
  }

  // Sorted YYYY-MM-DD strings for the selected delivery dates, used both for
  // the request param and the react-query key (so changing the selection
  // refetches). The browser's IANA timezone is sent alongside so the server
  // compares the same calendar date the Delivery column renders locally.
  const deliveryDateKeys = deliveryDates
    .map((d) => format(d, "yyyy-MM-dd"))
    .sort();
  const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  function handleDeliveryDatesChange(dates: Date[] | undefined) {
    setDeliveryDates(dates ?? []);
    setPage(0);
  }

  // Toggle a delivery time slot in the multi-select Time slot filter. Any
  // change resets pagination, mirroring the other server-side filters.
  function toggleSlot(slot: string) {
    setSlotFilter((prev) =>
      prev.includes(slot) ? prev.filter((s) => s !== slot) : [...prev, slot],
    );
    setPage(0);
  }

  const slotFilterKey = [...slotFilter].sort().join(",");

  // Default ordering is newest order first (server-side created_at DESC);
  // manual column sorts re-order the fetched page client-side.
  const queryParams = new URLSearchParams({
    limit: String(PAGE_SIZE),
    offset: String(page * PAGE_SIZE),
  });
  const todayOnly = activeChip === "today";
  if (debouncedQ) queryParams.set("q", debouncedQ);
  if (statusFilter && statusFilter !== "all") queryParams.set("status", statusFilter);
  if (sourceFilter && sourceFilter !== "all") queryParams.set("source", sourceFilter);
  if (countryFilter && countryFilter !== "all") queryParams.set("country", countryFilter);
  if (attribution) queryParams.set("attribution", attribution);
  if (todayOnly) queryParams.set("today", "true");
  if (deliveryDateKeys.length > 0) {
    queryParams.set("deliveryDates", deliveryDateKeys.join(","));
    queryParams.set("tz", browserTimeZone);
  }
  if (slotFilter.length > 0) {
    queryParams.set("slots", slotFilter.join(","));
  }

  const isVisible = useDocumentVisibility();
  const recentNewOrderIds = useRecentNewOrderIds();

  const {
    data,
    isLoading,
    isError,
    error,
    refetch: refetchOrders,
  } = useQuery<OrdersResponse>({
    queryKey: [
      "orders",
      debouncedQ,
      statusFilter,
      sourceFilter,
      countryFilter,
      attribution,
      todayOnly,
      deliveryDateKeys.join(","),
      slotFilterKey,
      page,
    ],
    queryFn: () => apiFetch<OrdersResponse>(`/api/orders?${queryParams.toString()}`),
    refetchInterval: isVisible ? 30_000 : false,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  });

  // Distinct delivery time slots present on this workspace's orders, used to
  // populate the Time slot filter dropdown.
  const { data: slotsData } = useQuery<{ slots: string[] }>({
    queryKey: ["orders-delivery-slots"],
    queryFn: () => apiFetch(`/api/orders/delivery-slots`),
  });
  const availableSlots = slotsData?.slots ?? [];

  // Approved fleet drivers, used to populate the Driver filter dropdown.
  const { data: driversData } = useQuery<{ drivers: DriverOption[] }>({
    queryKey: ["fleet-drivers", "orders-filter"],
    queryFn: () => apiFetch(`/api/fleet/drivers`),
  });
  const drivers = useMemo(
    () =>
      (driversData?.drivers ?? []).filter(
        (d) => (d.onboarding_status ?? "approved") === "approved",
      ),
    [driversData?.drivers],
  );
  const driverNameById = useMemo(
    () =>
      new Map<string, string>(
        drivers.map((d) => [
          String(d.id),
          `${d.first_name ?? ""} ${d.last_name ?? ""}`.trim().toLowerCase(),
        ]),
      ),
    [drivers],
  );

  const orders = data?.orders ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  // Operational summary counts, computed from the loaded page of orders. There
  // is no dedicated aggregate endpoint, so these reflect the current page.
  const summary = useMemo(
    () =>
      orders.reduce(
        (acc, o) => {
          if (o.status === "pending") acc.pending += 1;
          if (getUrgency(o, nowMs).group === "today") acc.today += 1;
          if (isAtRiskOrder(o, nowMs)) acc.atRisk += 1;
          return acc;
        },
        { pending: 0, today: 0, atRisk: 0 },
      ),
    [orders, nowMs],
  );

  const CHIPS: { key: string; labelKey: string }[] = [
    { key: "today", labelKey: "orders.chipToday" },
    { key: "tomorrow", labelKey: "orders.chipTomorrow" },
    { key: "pending", labelKey: "orders.chipPending" },
    { key: "preparing", labelKey: "orders.chipBeingPrepared" },
    { key: "unassigned", labelKey: "orders.chipUnassigned" },
    { key: "out_for_delivery", labelKey: "orders.chipOutForDelivery" },
  ];

  const matchesChip = useCallback(
    (o: OrderRow): boolean => {
      if (!activeChip) return true;
      const urgencyGroup = getUrgency(o, nowMs).group;
      switch (activeChip) {
        case "today":
          // Today is filtered before server pagination so every page and the
          // server total describe the complete matching set.
          return true;
        case "tomorrow":
          return urgencyGroup === "tomorrow";
        case "pending":
          return o.status === "pending";
        case "preparing":
          return o.status === "preparing";
        case "unassigned":
          return isUnassigned(o);
        case "out_for_delivery":
          return o.status === "out_for_delivery";
        default:
          return true;
      }
    },
    [activeChip, nowMs],
  );

  const matchesDriver = useCallback(
    (o: OrderRow): boolean => {
      if (driverFilter === "all") return true;
      if (driverFilter === "unassigned") return !hasDriver(o);
      const wanted = driverNameById.get(driverFilter);
      if (!wanted) return false;
      return driverFullName(o).toLowerCase() === wanted;
    },
    [driverFilter, driverNameById],
  );

  // Driver and non-Today quick chips remain client-side over the loaded page.
  // Today is server-filtered so its pagination and total cover every match.
  const clientFiltered =
    driverFilter !== "all" || (activeChip !== null && activeChip !== "today");
  const visibleOrders = useMemo(
    () => orders.filter((o) => matchesDriver(o) && matchesChip(o)),
    [orders, matchesDriver, matchesChip],
  );

  // Any filter change snaps the ordering back to the urgency default.
  const filterKey = [
    debouncedQ,
    statusFilter,
    sourceFilter,
    countryFilter,
    driverFilter,
    activeChip ?? "",
    attribution,
    deliveryDateKeys.join(","),
    slotFilterKey,
  ].join("|");
  useEffect(() => {
    setManualSort(null);
  }, [filterKey]);

  /** Flat manually-sorted rows; null while the newest-first default is active. */
  const manuallySorted = useMemo(() => {
    if (!manualSort) return null;
    const { col, dir } = manualSort;
    const val = (o: OrderRow): string | number => {
      switch (col) {
        case "order": {
          const n = Number(o.display_order_number);
          return Number.isFinite(n) ? n : o.display_order_number ?? o.external_order_id ?? "";
        }
        case "customer":
          return (o.contact_name ?? "").toLowerCase();
        case "delivery":
          return getUrgency(o, nowMs).endMs ?? Number.MAX_SAFE_INTEGER;
        case "status":
          return normalizeOrderStatus(o.status);
        case "driver":
          return driverFullName(o).toLowerCase();
        case "total": {
          const t = o.totals ?? {};
          const n = Number(t.paid_total ?? t.total ?? t.grand_total ?? t.order_total);
          return Number.isFinite(n) ? n : -1;
        }
      }
    };
    const sign = dir === "asc" ? 1 : -1;
    return [...visibleOrders].sort((a, b) => {
      const va = val(a);
      const vb = val(b);
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * sign;
      return String(va).localeCompare(String(vb)) * sign;
    });
  }, [manualSort, visibleOrders, nowMs]);

  const SORT_LABEL_KEYS: Record<SortColumn, string> = {
    order: "orders.colOrder",
    customer: "orders.colCustomer",
    delivery: "orders.colDelivery",
    status: "orders.colStatus",
    driver: "orders.colDriver",
    total: "orders.colTotal",
  };

  /**
   * When a delivery-date filter or the "Today" chip is active and no manual
   * column sort overrides, sink finished orders (completed/cancelled/refunded/
   * delivered) to the bottom of the list while keeping each group's existing
   * relative order stable.
   * Without a date filter or Today chip the default newest-first server order
   * is preserved.
   */
  const displayedOrders = useMemo(() => {
    if (manuallySorted) return manuallySorted;
    if (deliveryDateKeys.length > 0 || activeChip === "today") {
      const active: OrderRow[] = [];
      const finished: OrderRow[] = [];
      for (const o of visibleOrders) {
        (isFinished(o) ? finished : active).push(o);
      }
      return [...active, ...finished];
    }
    return visibleOrders;
  }, [manuallySorted, visibleOrders, deliveryDateKeys.length, activeChip]);

  const hasActiveFilters =
    !!debouncedQ ||
    statusFilter !== "all" ||
    sourceFilter !== "all" ||
    countryFilter !== "all" ||
    !!attribution ||
    deliveryDateKeys.length > 0 ||
    slotFilter.length > 0 ||
    clientFiltered;

  // Footer "Showing X to Y of Z": when a client-side filter is active the counts
  // describe the filtered page; otherwise they describe the server pagination.
  const footerTotal = clientFiltered ? visibleOrders.length : total;
  const footerFrom =
    visibleOrders.length === 0 ? 0 : clientFiltered ? 1 : page * PAGE_SIZE + 1;
  const footerTo = clientFiltered
    ? visibleOrders.length
    : page * PAGE_SIZE + orders.length;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t("orders.title")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("orders.description")}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {canEditOrders && (
            <Button
              className="bg-teal-700 text-white hover:bg-teal-800"
              onClick={() => setCreateOrderOpen(true)}
              data-testid="button-open-create-order"
            >
              <Plus size={16} className="mr-1.5" />
              {t("orders.createOrder")}
            </Button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <SummaryCard
          icon={<Clock size={20} />}
          count={summary.pending}
          label={t("orders.cardPending")}
          iconClass="bg-amber-100 text-amber-700"
        />
        <SummaryCard
          icon={<Truck size={20} />}
          count={summary.today}
          label={t("orders.cardTodayDeliveries")}
          iconClass="bg-teal-100 text-teal-700"
        />
        <SummaryCard
          icon={<AlertTriangle size={20} />}
          count={summary.atRisk}
          label={t("orders.cardAtRisk")}
          iconClass="bg-red-100 text-red-700"
        />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[240px] flex-1">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={t("orders.searchPlaceholder")}
            value={q}
            onChange={(e) => handleSearch(e.target.value)}
            className="h-10 pl-9"
          />
        </div>
        <Select
          value={statusFilter}
          onValueChange={(v) => {
            setStatusFilter(v);
            setPage(0);
          }}
        >
          <SelectTrigger className="h-10 w-[160px]">
            <SelectValue placeholder={t("orders.filterStatus")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("orders.allStatuses")}</SelectItem>
            {ORDER_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {t(ORDER_STATUS_LABEL_KEYS[s])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={sourceFilter}
          onValueChange={(v) => {
            setSourceFilter(v);
            setPage(0);
          }}
        >
          <SelectTrigger className="h-10 w-[160px]">
            <SelectValue placeholder={t("orders.filterSource")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("orders.allSources")}</SelectItem>
            <SelectItem value="native">Native</SelectItem>
            <SelectItem value="toters">{t("orders.sourceToters")}</SelectItem>
            <SelectItem value="dashboard">{t("orders.sourceDashboard")}</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={countryFilter}
          onValueChange={(v) => {
            setCountryFilter(v);
            setPage(0);
          }}
        >
          <SelectTrigger className="h-10 w-[160px]" data-testid="filter-country">
            <SelectValue placeholder={t("orders.filterCountry")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("orders.allCountries")}</SelectItem>
            <SelectItem value="lb">🇱🇧 Lebanon</SelectItem>
            <SelectItem value="ae">🇦🇪 UAE</SelectItem>
            <SelectItem value="cy">🇨🇾 Cyprus</SelectItem>
          </SelectContent>
        </Select>
        <Select value={driverFilter} onValueChange={setDriverFilter}>
          <SelectTrigger className="h-10 w-[180px]">
            <SelectValue placeholder={t("orders.filterDriver")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("orders.allDrivers")}</SelectItem>
            <SelectItem value="unassigned">{t("orders.driverUnassigned")}</SelectItem>
            {drivers.map((d) => (
              <SelectItem key={d.id} value={String(d.id)}>
                {`${d.first_name ?? ""} ${d.last_name ?? ""}`.trim() ||
                  `#${d.id}`}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              className={cn(
                "h-10 min-w-[180px] justify-start font-normal",
                deliveryDates.length === 0 && "text-muted-foreground",
              )}
              data-testid="filter-delivery-date"
            >
              <CalendarIcon size={15} className="mr-2 shrink-0" />
              {deliveryDates.length > 0
                ? t("orders.filterDeliveryDateCount", { count: deliveryDates.length })
                : t("orders.filterDeliveryDate")}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <Calendar
              mode="multiple"
              selected={deliveryDates}
              onSelect={handleDeliveryDatesChange}
              className={cn(
                "p-4 [--cell-size:2.4rem]",
                // Comfortable rounded-full selection highlight on chosen days.
                "[&_button[data-selected-single=true]]:rounded-full",
                "[&_button[data-selected-single=true]]:bg-teal-600",
                "[&_button[data-selected-single=true]]:font-semibold",
                "[&_button[data-selected-single=true]]:text-white",
                "[&_button[data-selected-single=true]]:shadow-sm",
                "[&_button[data-selected-single=true]:hover]:bg-teal-700",
                // Softer hover on unselected days.
                "[&_button:not([data-selected-single=true])]:rounded-full",
              )}
              classNames={{
                caption_label: "select-none text-sm font-semibold",
                weekdays: "flex gap-1",
                weekday:
                  "flex-1 select-none text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground",
                week: "mt-1.5 flex w-full gap-1",
                button_previous:
                  "inline-flex h-[--cell-size] w-[--cell-size] select-none items-center justify-center rounded-full p-0 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground aria-disabled:opacity-50",
                button_next:
                  "inline-flex h-[--cell-size] w-[--cell-size] select-none items-center justify-center rounded-full p-0 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground aria-disabled:opacity-50",
                today:
                  "rounded-full font-semibold text-teal-700 [&>button]:rounded-full [&>button]:ring-1 [&>button]:ring-inset [&>button]:ring-teal-600/50 data-[selected=true]:text-white",
              }}
            />
            <div className="flex items-center justify-between gap-3 rounded-b-md border-t border-border bg-secondary/40 px-4 py-2.5">
              <span
                className={cn(
                  "text-xs",
                  deliveryDates.length > 0
                    ? "font-medium text-foreground"
                    : "text-muted-foreground",
                )}
              >
                {t("orders.deliveryDateSelected", { count: deliveryDates.length })}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-teal-700 hover:bg-teal-50 hover:text-teal-800"
                disabled={deliveryDates.length === 0}
                onClick={() => handleDeliveryDatesChange([])}
              >
                {t("orders.clearDeliveryDates")}
              </Button>
            </div>
          </PopoverContent>
        </Popover>
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              className={cn(
                "h-10 min-w-[160px] justify-start font-normal",
                slotFilter.length === 0 && "text-muted-foreground",
              )}
              data-testid="filter-time-slot"
            >
              <Clock size={15} className="mr-2 shrink-0" />
              {slotFilter.length > 0
                ? t("orders.filterTimeSlotCount", { count: slotFilter.length })
                : t("orders.filterTimeSlot")}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-64 p-0" align="start">
            {availableSlots.length === 0 ? (
              <p className="px-4 py-6 text-center text-sm text-muted-foreground">
                {t("orders.timeSlotEmpty")}
              </p>
            ) : (
              <div className="max-h-72 overflow-y-auto p-1.5">
                {availableSlots.map((slot) => {
                  const checked = slotFilter.includes(slot);
                  return (
                    <button
                      key={slot}
                      type="button"
                      onClick={() => toggleSlot(slot)}
                      className={cn(
                        "flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-start text-sm transition-colors hover:bg-secondary",
                        checked && "font-medium",
                      )}
                      data-testid={`time-slot-option-${slot}`}
                    >
                      <Checkbox
                        checked={checked}
                        tabIndex={-1}
                        className="pointer-events-none"
                      />
                      <span className="truncate">{slot}</span>
                    </button>
                  );
                })}
              </div>
            )}
            <div className="flex items-center justify-between gap-3 rounded-b-md border-t border-border bg-secondary/40 px-3 py-2">
              <span className="text-xs text-muted-foreground">
                {t("orders.timeSlotSelected", { count: slotFilter.length })}
              </span>
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-teal-700 hover:bg-teal-50 hover:text-teal-800"
                disabled={slotFilter.length === 0}
                onClick={() => {
                  setSlotFilter([]);
                  setPage(0);
                }}
              >
                {t("orders.clearTimeSlots")}
              </Button>
            </div>
          </PopoverContent>
        </Popover>
        {attribution && (
          <div
            className="flex h-10 items-center gap-1.5 rounded-md border border-teal-200 bg-teal-50 px-2.5 text-sm text-teal-800"
            data-testid="filter-attribution-badge"
          >
            <span className="truncate max-w-[180px]">
              {t("orders.filterAttribution", { label: formatSourceLabel(attribution) })}
            </span>
            <button
              type="button"
              aria-label={t("orders.clearAttributionFilter")}
              className="shrink-0 rounded p-0.5 hover:bg-teal-100"
              onClick={() => navigate("/orders")}
            >
              <X size={13} />
            </button>
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        {CHIPS.map((c) => {
          const active = activeChip === c.key;
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => {
                setActiveChip(active ? null : c.key);
                if (c.key === "today" || activeChip === "today") setPage(0);
              }}
              className={cn(
                "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                active
                  ? "border-teal-600 bg-teal-600 text-white"
                  : "border-border bg-background text-muted-foreground hover:bg-secondary",
              )}
            >
              {t(c.labelKey)}
            </button>
          );
        })}
      </div>

      <div className="inline-flex w-fit rounded-md border border-border bg-secondary/40 p-0.5" data-testid="orders-view-toggle">
        {(["list", "board"] as const).map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setView(v)}
            className={cn(
              "rounded-[5px] px-3.5 py-1.5 text-sm font-medium transition-colors",
              view === v
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
            data-testid={`button-view-${v}`}
            aria-pressed={view === v}
          >
            {v === "list" ? t("orders.viewList") : t("orders.viewBoard")}
          </button>
        ))}
      </div>

      {isError ? (
        <div
          className="flex flex-col items-center justify-center gap-3 py-16 text-center"
          role="alert"
          data-testid="orders-load-error"
        >
          <AlertTriangle size={40} className="text-destructive opacity-70" />
          <div>
            <p className="font-medium">
              {isAccessRequestError(error)
                ? t("orders.accessError")
                : t("orders.loadError")}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {isAccessRequestError(error)
                ? t("orders.accessErrorHint")
                : t("orders.loadErrorHint")}
            </p>
          </div>
          <Button variant="outline" onClick={() => void refetchOrders()}>
            {t("orders.retry")}
          </Button>
        </div>
      ) : view === "board" ? (
        <OrdersBoard
          canEditOrders={canEditOrders}
          isOwner={isOwner}
          nowMs={nowMs}
          queryDeps={{
            q: debouncedQ,
            status: statusFilter,
            source: sourceFilter,
            country: countryFilter,
            attribution,
            deliveryDateKeys,
            tz: browserTimeZone,
            slots: slotFilter,
          }}
          matchesDriver={matchesDriver}
          matchesChip={matchesChip}
          hasActiveFilters={hasActiveFilters}
        />
      ) : isLoading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="animate-spin text-muted-foreground" size={24} />
        </div>
      ) : visibleOrders.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center gap-3">
          <ShoppingCart size={40} className="text-muted-foreground opacity-40" />
          <div>
            <p className="font-medium">
              {hasActiveFilters ? t("orders.emptyFiltered") : t("orders.empty")}
            </p>
            <p className="text-sm text-muted-foreground mt-1">
              {hasActiveFilters ? t("orders.emptyFilteredHint") : t("orders.emptyHint")}
            </p>
          </div>
        </div>
      ) : (
        <>
          {manualSort && (
            <div
              className="flex items-center gap-2 text-xs text-muted-foreground"
              data-testid="sort-indicator"
            >
              <span>
                {t("orders.sortedBy", { column: t(SORT_LABEL_KEYS[manualSort.col]) })}
              </span>
              <button
                type="button"
                className="font-medium text-teal-700 hover:underline"
                onClick={() => setManualSort(null)}
                data-testid="button-reset-sort"
              >
                {t("orders.resetToUrgency")}
              </button>
            </div>
          )}
          <div className="border border-border rounded-lg overflow-auto max-h-[75vh]">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  {(
                    [
                      { col: "order" as const, labelKey: "orders.colOrder", cls: "" },
                      { col: "customer" as const, labelKey: "orders.colCustomer", cls: "" },
                      { col: "delivery" as const, labelKey: "orders.colDelivery", cls: "hidden md:table-cell" },
                      { col: "status" as const, labelKey: "orders.colStatus", cls: "" },
                      { col: "driver" as const, labelKey: "orders.colDriver", cls: "hidden lg:table-cell" },
                      { col: "total" as const, labelKey: "orders.colTotal", cls: "hidden lg:table-cell" },
                    ]
                  ).map(({ col, labelKey, cls }) => {
                    const active = manualSort?.col === col;
                    return (
                      <th
                        key={col}
                        className={cn(
                          "sticky top-0 z-20 bg-secondary text-left px-3 py-2 font-medium text-muted-foreground",
                          cls,
                        )}
                      >
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 hover:text-foreground"
                          onClick={() => handleHeaderSort(col)}
                          data-testid={`sort-header-${col}`}
                        >
                          {t(labelKey)}
                          {active ? (
                            manualSort!.dir === "asc" ? (
                              <ArrowUp size={12} />
                            ) : (
                              <ArrowDown size={12} />
                            )
                          ) : (
                            <ArrowUpDown size={12} className="opacity-30" />
                          )}
                        </button>
                      </th>
                    );
                  })}
                  <th className="sticky top-0 z-20 bg-secondary text-right px-3 py-2 font-medium text-muted-foreground">
                    {t("orders.colActions")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {displayedOrders.map((order) => {
                      const finished = isFinished(order);
                      return (
                        <tr
                          key={order.id}
                          className={cn(
                            "border-b border-border last:border-0 hover:bg-secondary/20 transition-colors",
                            finished && "opacity-75",
                            recentNewOrderIds.has(order.id) && "new-order-row-highlight",
                          )}
                          data-testid={`order-row-${order.id}`}
                        >
                          <td className="px-3 py-1.5">
                            <div className="flex items-center gap-2">
                              <OrderThumbnail src={order.thumbnail_url} />
                              <div className="flex items-center gap-1.5 min-w-0">
                                {order.display_order_number || order.external_order_id ? (
                                  <Link
                                    href={orderDetailPath(order)}
                                    className="font-medium hover:underline hover:text-primary transition-colors whitespace-nowrap"
                                  >
                                    {`#${order.display_order_number || order.external_order_id}`}
                                  </Link>
                                ) : (
                                  <span className="text-muted-foreground/50 italic text-xs">
                                    {t("orders.noOrderNumber")}
                                  </span>
                                )}
                                <SourceDot source={order.source} />
                                {order.qr_link && (
                                  <span
                                    title={t("orders.hasQrLink")}
                                    className="inline-flex items-center text-teal-600"
                                  >
                                    <Link2 size={11} />
                                  </span>
                                )}
                                {order.delivery_date_review && (
                                  <span
                                    className="inline-flex items-center text-amber-600"
                                    title={`${t("orders.deliveryDateReviewBadge")}: ${order.delivery_date_review}`}
                                  >
                                    <AlertTriangle size={12} />
                                  </span>
                                )}
                              </div>
                            </div>
                          </td>
                          <td className="px-3 py-1.5">
                            {order.is_anonymous ? (
                              <span className="font-medium text-muted-foreground italic">
                                {t("orders.anonymousCustomer")}
                              </span>
                            ) : order.contact_name || order.contact_phone || order.contact_email ? (
                              <div className="flex flex-wrap items-baseline gap-x-2 min-w-0">
                                {order.contact_name && (
                                  <span className="font-medium truncate max-w-[160px]">
                                    {order.contact_name}
                                  </span>
                                )}
                                {order.contact_phone ? (
                                  <span className="flex items-center gap-1 text-xs text-muted-foreground whitespace-nowrap">
                                    <Phone size={10} className="shrink-0" />
                                    {order.contact_phone}
                                  </span>
                                ) : (
                                  order.contact_email && (
                                    <span className="text-xs text-muted-foreground truncate max-w-[160px]">
                                      {order.contact_email}
                                    </span>
                                  )
                                )}
                              </div>
                            ) : (
                              <span className="text-muted-foreground/50">—</span>
                            )}
                          </td>
                          <td className="px-3 py-1.5 hidden md:table-cell">
                            <DeliveryCell order={order} nowMs={nowMs} />
                          </td>
                          <td className="px-3 py-1.5">
                            {canEditOrders ||
                            (order.status === "refunded" && canChangeRefundedStatus) ? (
                              <InlineStatusSelect
                                order={order}
                                canChangeRefundedStatus={canChangeRefundedStatus}
                              />
                            ) : (
                              <OrderStatusBadge status={order.status} className="text-xs" />
                            )}
                          </td>
                          <td className="px-3 py-1.5 hidden lg:table-cell">
                            <DriverCell order={order} />
                          </td>
                          <td className="px-3 py-1.5 hidden lg:table-cell">
                            <TotalCell order={order} />
                          </td>
                          <td className="px-3 py-1.5">
                            <div className="flex items-center justify-end">
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 w-7 p-0"
                                    aria-label={t("orders.actionsLabel")}
                                  >
                                    <MoreHorizontal size={15} />
                                  </Button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end">
                                  <Link href={orderDetailPath(order)}>
                                    <DropdownMenuItem>
                                      <Eye size={14} className="mr-2" />
                                      {t("orders.viewOrder")}
                                    </DropdownMenuItem>
                                  </Link>
                                  {canEditOrders && (
                                    <>
                                      <DropdownMenuSeparator />
                                      <DropdownMenuItem
                                        onSelect={(e) => {
                                          e.preventDefault();
                                          setRescheduleOrder(order);
                                        }}
                                      >
                                        <CalendarClock size={14} className="mr-2" />
                                        {t("orders.reschedule")}
                                      </DropdownMenuItem>
                                    </>
                                  )}
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between gap-4 flex-wrap">
            <p className="text-sm text-muted-foreground">
              {t("orders.paginationSummary", {
                from: footerFrom,
                to: footerTo,
                total: footerTotal,
              })}
            </p>
            {!clientFiltered && totalPages > 1 && (
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page === 0}
                  onClick={() => setPage((p) => p - 1)}
                >
                  <ChevronLeft size={14} />
                  {t("common.previous")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages - 1}
                  onClick={() => setPage((p) => p + 1)}
                >
                  {t("common.next")}
                  <ChevronRight size={14} />
                </Button>
              </div>
            )}
          </div>
        </>
      )}

      {canEditOrders && rescheduleOrder && (
        <RescheduleDialog
          key={rescheduleOrder.id}
          order={rescheduleOrder}
          open={true}
          onOpenChange={(o) => {
            if (!o) setRescheduleOrder(null);
          }}
        />
      )}

      {canEditOrders && (
        <CreateOrderWizard
          open={createOrderOpen}
          onOpenChange={setCreateOrderOpen}
          onCreated={() => {
            queryClient.invalidateQueries({ queryKey: ["orders"] });
          }}
        />
      )}
    </div>
  );
}
