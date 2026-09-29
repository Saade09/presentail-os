import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Loader2, MapPin, RefreshCw, ShoppingCart } from "lucide-react";
import { apiFetch } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  formatDeliverySchedule,
  resolveDeliverySchedule,
} from "@/lib/deliveryDate";
import { normalizeOrderStatus, ORDER_STATUS_LABEL_KEYS, type OrderStatus } from "@/lib/orderStatus";
import { orderDetailPath } from "@/lib/orderLink";
import {
  type OrderRow,
  type OrdersResponse,
  driverFullName,
  driverInitials,
  hasDriver,
  isPaymentException,
  OrderThumbnail,
} from "./orderRowHelpers";
import {
  BOARD_COLUMNS,
  BOARD_COLUMN_KEYS,
  COLUMN_TARGET_STATUS,
  bucketOrdersByColumn,
  sortColumnOrders,
  classifyTransition,
  requiresConfirmation,
  isElevatedTransition,
  isAtRiskOrder,
  boardPunctuality,
  boardAreaLabel,
  getBoardColumnKey,
  type BoardColumnKey,
  type TransitionKind,
} from "./orderBoardLogic";

// The orders API caps `limit` at 200 per request, so a single fetch cannot
// reliably populate the board's live counts/work queues once a filtered set
// exceeds that. BOARD_FETCH_MAX_PAGES paginates through the full result
// (200 * 10 = 2,000 orders) before giving up and surfacing a partial-data
// banner instead of silently under-counting a column.
const BOARD_FETCH_PAGE_SIZE = 200;
const BOARD_FETCH_MAX_PAGES = 10;
const COMPLETED_INITIAL_VISIBLE = 15;
const COMPLETED_LOAD_MORE_STEP = 15;

const COLUMN_LABEL_KEYS: Record<BoardColumnKey, string> = {
  processing: "orders.boardColProcessing",
  preparing: "orders.boardColPreparing",
  ready_for_delivery: "orders.boardColReadyForDelivery",
  out_for_delivery: "orders.boardColOutForDelivery",
  completed: "orders.boardColCompleted",
};

/** Restrained per-column accent — a top border + count dot, not a full background. */
const COLUMN_ACCENTS: Record<BoardColumnKey, { border: string; dot: string }> = {
  processing: { border: "border-t-violet-400", dot: "bg-violet-400" },
  preparing: { border: "border-t-pink-400", dot: "bg-pink-400" },
  ready_for_delivery: { border: "border-t-amber-400", dot: "bg-amber-400" },
  out_for_delivery: { border: "border-t-blue-400", dot: "bg-blue-400" },
  completed: { border: "border-t-green-400", dot: "bg-green-400" },
};

const PUNCTUALITY_STYLES: Record<string, { labelKey: string; cls: string }> = {
  on_time: { labelKey: "orders.boardOnTime", cls: "bg-green-100 text-green-800 border-green-200" },
  early: { labelKey: "orders.boardEarly", cls: "bg-teal-100 text-teal-800 border-teal-200" },
  late: { labelKey: "orders.boardLate", cls: "bg-red-100 text-red-800 border-red-200" },
  unavailable: { labelKey: "orders.boardTimingUnavailable", cls: "bg-secondary text-muted-foreground border-border" },
};

export type OrdersBoardQueryDeps = {
  q: string;
  status: string;
  source: string;
  country: string;
  attribution: string;
  deliveryDateKeys: string[];
  tz: string;
  slots: string[];
};

type OrdersBoardProps = {
  canEditOrders: boolean;
  isOwner: boolean;
  nowMs: number;
  queryDeps: OrdersBoardQueryDeps;
  matchesDriver: (o: OrderRow) => boolean;
  matchesChip: (o: OrderRow) => boolean;
  hasActiveFilters: boolean;
};

type PendingMove = {
  order: OrderRow;
  toColumn: BoardColumnKey;
  toStatus: string;
  kind: TransitionKind;
};

export function OrdersBoard({
  canEditOrders,
  isOwner,
  nowMs,
  queryDeps,
  matchesDriver,
  matchesChip,
  hasActiveFilters,
}: OrdersBoardProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, navigate] = useLocation();

  const slotsKey = [...queryDeps.slots].sort().join(",");
  const deliveryDateKey = queryDeps.deliveryDateKeys.join(",");

  function buildParams(offset: number) {
    const p = new URLSearchParams({ limit: String(BOARD_FETCH_PAGE_SIZE), offset: String(offset) });
    if (queryDeps.q) p.set("q", queryDeps.q);
    if (queryDeps.status && queryDeps.status !== "all") p.set("status", queryDeps.status);
    if (queryDeps.source && queryDeps.source !== "all") p.set("source", queryDeps.source);
    if (queryDeps.country && queryDeps.country !== "all") p.set("country", queryDeps.country);
    if (queryDeps.attribution) p.set("attribution", queryDeps.attribution);
    if (queryDeps.deliveryDateKeys.length > 0) {
      p.set("deliveryDates", deliveryDateKey);
      p.set("tz", queryDeps.tz);
    }
    if (queryDeps.slots.length > 0) p.set("slots", queryDeps.slots.join(","));
    return p;
  }

  /**
   * Fetches every page of the currently-filtered order set (not just the
   * first 200) so column counts and work queues are complete, up to a
   * generous safety cap. `truncated` is set only if that cap is hit, so the
   * board can show an explicit partial-data banner instead of silently
   * under-counting.
   */
  async function fetchAllBoardOrders(): Promise<OrdersResponse & { truncated: boolean }> {
    const first = await apiFetch<OrdersResponse>(`/api/orders?${buildParams(0).toString()}`);
    const orders = [...first.orders];
    let page = 1;
    while (orders.length < first.total && page < BOARD_FETCH_MAX_PAGES) {
      const next = await apiFetch<OrdersResponse>(
        `/api/orders?${buildParams(orders.length).toString()}`,
      );
      if (next.orders.length === 0) break;
      orders.push(...next.orders);
      page += 1;
    }
    return {
      orders,
      total: first.total,
      limit: orders.length,
      offset: 0,
      truncated: orders.length < first.total,
    };
  }

  const { data, isLoading, isError, refetch, isFetching } = useQuery<
    OrdersResponse & { truncated: boolean }
  >({
    queryKey: [
      "orders-board",
      queryDeps.q,
      queryDeps.status,
      queryDeps.source,
      queryDeps.country,
      queryDeps.attribution,
      deliveryDateKey,
      slotsKey,
    ],
    queryFn: fetchAllBoardOrders,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });

  const filteredOrders = useMemo(
    () => (data?.orders ?? []).filter((o) => matchesDriver(o) && matchesChip(o)),
    [data?.orders, matchesDriver, matchesChip],
  );
  const ordersById = useMemo(() => new Map(filteredOrders.map((o) => [o.id, o])), [filteredOrders]);

  // Optimistic status overrides while a drag-triggered mutation is in flight,
  // keyed by order id. Cleared on both success (the refetch supplies the real
  // status) and failure (rollback to the server-known status).
  const [overrideStatus, setOverrideStatus] = useState<Map<string, string>>(new Map());
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  const [pendingMove, setPendingMove] = useState<PendingMove | null>(null);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [completedVisible, setCompletedVisible] = useState(COMPLETED_INITIAL_VISIBLE);

  const filterKey = [
    queryDeps.q,
    queryDeps.status,
    queryDeps.source,
    queryDeps.country,
    queryDeps.attribution,
    deliveryDateKey,
    slotsKey,
  ].join("|");
  useEffect(() => {
    setCompletedVisible(COMPLETED_INITIAL_VISIBLE);
  }, [filterKey]);

  const buckets = useMemo(
    () => bucketOrdersByColumn(filteredOrders, overrideStatus),
    [filteredOrders, overrideStatus],
  );
  const sortedBuckets = useMemo(() => {
    const out = {} as Record<BoardColumnKey, OrderRow[]>;
    for (const col of BOARD_COLUMN_KEYS) out[col] = sortColumnOrders(col, buckets[col], nowMs);
    return out;
  }, [buckets, nowMs]);

  const totalVisible = BOARD_COLUMN_KEYS.reduce((sum, col) => sum + sortedBuckets[col].length, 0);

  const statusMutation = useMutation({
    mutationFn: ({ orderId, status }: { orderId: string; status: string }) =>
      apiFetch(`/api/orders/${orderId}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      }),
    onSuccess: (_res, variables) => {
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
      void queryClient.invalidateQueries({ queryKey: ["orders-board"] });
      const normalized = normalizeOrderStatus(variables.status) as OrderStatus;
      const labelKey = ORDER_STATUS_LABEL_KEYS[normalized] ?? variables.status;
      toast({ title: t("orders.boardMoved", { status: t(labelKey) }) });
      setSavingIds((prev) => {
        const next = new Set(prev);
        next.delete(variables.orderId);
        return next;
      });
      setOverrideStatus((prev) => {
        const next = new Map(prev);
        next.delete(variables.orderId);
        return next;
      });
    },
    onError: (err, variables) => {
      setSavingIds((prev) => {
        const next = new Set(prev);
        next.delete(variables.orderId);
        return next;
      });
      setOverrideStatus((prev) => {
        const next = new Map(prev);
        next.delete(variables.orderId);
        return next;
      });
      const code = (err as { code?: string } | null)?.code;
      toast({
        title: t("orders.boardMoveFailed"),
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

  function performMove(order: OrderRow, toStatus: string) {
    setOverrideStatus((prev) => new Map(prev).set(order.id, toStatus));
    setSavingIds((prev) => new Set(prev).add(order.id));
    statusMutation.mutate({ orderId: order.id, status: toStatus });
  }

  /**
   * Pending and processing orders share the Processing column (one drop
   * target), so there is no column-to-column drag that can invoke the
   * pending -> processing transition. This mirrors handleDragEnd's
   * validation (permission, elevation, confirmation) for that one
   * within-column move, exposed as an explicit card action instead.
   */
  function advanceToProcessing(order: OrderRow) {
    if (!canEditOrders) {
      toast({ title: t("orders.boardMoveBlockedPermission"), variant: "destructive" });
      return;
    }
    const currentStatus = overrideStatus.get(order.id) ?? order.status;
    const toStatus = "processing";
    const kind = classifyTransition(currentStatus, toStatus);
    if (kind === "none") return;

    if (isElevatedTransition(kind) && !isOwner) {
      toast({
        title:
          kind === "backward"
            ? t("orders.boardMoveBlockedBackward")
            : t("orders.boardMoveBlockedSkip"),
        variant: "destructive",
      });
      return;
    }

    if (requiresConfirmation(toStatus, kind)) {
      setPendingMove({ order, toColumn: "processing", toStatus, kind });
      return;
    }
    performMove(order, toStatus);
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );

  function handleDragStart(event: DragStartEvent) {
    setActiveDragId(String(event.active.id));
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveDragId(null);
    const { active, over } = event;
    if (!over) return;
    const order = ordersById.get(String(active.id));
    if (!order) return;
    const toColumn = over.id as BoardColumnKey;
    const currentStatus = overrideStatus.get(order.id) ?? order.status;
    const fromColumn = getBoardColumnKey(currentStatus);
    if (fromColumn === toColumn) return;

    if (!canEditOrders) {
      toast({ title: t("orders.boardMoveBlockedPermission"), variant: "destructive" });
      return;
    }

    const toStatus = COLUMN_TARGET_STATUS[toColumn];
    const kind = classifyTransition(currentStatus, toStatus);
    if (kind === "none") return;

    if (isElevatedTransition(kind) && !isOwner) {
      toast({
        title:
          kind === "backward"
            ? t("orders.boardMoveBlockedBackward")
            : t("orders.boardMoveBlockedSkip"),
        variant: "destructive",
      });
      return;
    }

    if (requiresConfirmation(toStatus, kind)) {
      setPendingMove({ order, toColumn, toStatus, kind });
      return;
    }
    performMove(order, toStatus);
  }

  const activeDragOrder = activeDragId ? (ordersById.get(activeDragId) ?? null) : null;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="animate-spin text-muted-foreground" size={24} />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <AlertTriangle size={32} className="text-red-500" />
        <div>
          <p className="font-medium">{t("orders.boardLoadErrorTitle")}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t("orders.boardLoadErrorDescription")}</p>
        </div>
        <Button variant="outline" size="sm" onClick={() => refetch()}>
          <RefreshCw size={14} className="mr-1.5" />
          {t("orders.tryAgain")}
        </Button>
      </div>
    );
  }

  if (totalVisible === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-16 text-center" data-testid="board-empty-state">
        <ShoppingCart size={40} className="text-muted-foreground opacity-40" />
        <div>
          <p className="font-medium">
            {hasActiveFilters ? t("orders.emptyFiltered") : t("orders.empty")}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {hasActiveFilters ? t("orders.emptyFilteredHint") : t("orders.emptyHint")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div data-testid="orders-board">
      {data?.truncated && (
        <div
          className="mb-3 flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800"
          data-testid="board-partial-data-banner"
        >
          <AlertTriangle size={14} className="shrink-0" />
          {t("orders.boardPartialData", { shown: filteredOrders.length, total: data.total })}
        </div>
      )}
      <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        <div className="flex gap-4 overflow-x-auto pb-2" data-testid="board-columns">
          {BOARD_COLUMNS.map((col) => {
            const key = col.key;
            const rows = sortedBuckets[key];
            const visibleRows = key === "completed" ? rows.slice(0, completedVisible) : rows;
            const accent = COLUMN_ACCENTS[key];
            return (
              <BoardColumn
                key={key}
                columnKey={key}
                accent={accent}
                labelKey={COLUMN_LABEL_KEYS[key]}
                count={rows.length}
              >
                {visibleRows.length === 0 ? (
                  <p className="px-2 py-6 text-center text-xs text-muted-foreground">
                    {t("orders.boardColumnEmpty")}
                  </p>
                ) : (
                  <>
                    {visibleRows.map((order) => (
                      <BoardCard
                        key={order.id}
                        order={order}
                        columnKey={key}
                        nowMs={nowMs}
                        saving={savingIds.has(order.id)}
                        disabled={!canEditOrders}
                        onOpen={() => navigate(orderDetailPath(order))}
                        onAdvanceToProcessing={
                          key === "processing" && normalizeOrderStatus(order.status) === "pending"
                            ? () => advanceToProcessing(order)
                            : undefined
                        }
                      />
                    ))}
                    {key === "completed" && rows.length > completedVisible && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="w-full text-teal-700 hover:bg-teal-50 hover:text-teal-800"
                        onClick={() => setCompletedVisible((v) => v + COMPLETED_LOAD_MORE_STEP)}
                        data-testid="button-board-load-more-completed"
                      >
                        {t("orders.boardLoadMore", {
                          count: Math.min(COMPLETED_LOAD_MORE_STEP, rows.length - completedVisible),
                        })}
                      </Button>
                    )}
                    {key === "completed" && rows.length > COMPLETED_INITIAL_VISIBLE && (
                      <p className="px-1 text-center text-[11px] text-muted-foreground">
                        {t("orders.boardShowingCount", { shown: visibleRows.length, total: rows.length })}
                      </p>
                    )}
                  </>
                )}
              </BoardColumn>
            );
          })}
        </div>
        <DragOverlay>
          {activeDragOrder ? (
            <div className="w-72 rotate-1 opacity-95 shadow-lg">
              <BoardCardBody order={activeDragOrder} columnKey={getBoardColumnKey(activeDragOrder.status) ?? "processing"} nowMs={nowMs} saving={false} />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>

      {pendingMove && (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setPendingMove(null);
          }}
        >
          <DialogContent data-testid="dialog-board-confirm-move">
            <DialogHeader>
              <DialogTitle>
                {t("orders.boardConfirmMoveTitle", {
                  status: t(ORDER_STATUS_LABEL_KEYS[normalizeOrderStatus(pendingMove.toStatus) as OrderStatus]),
                })}
              </DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              {pendingMove.kind === "backward"
                ? t("orders.boardConfirmMoveBackwardBody", {
                    status: t(ORDER_STATUS_LABEL_KEYS[normalizeOrderStatus(pendingMove.toStatus) as OrderStatus]),
                  })
                : t("orders.boardConfirmMoveBody", {
                    status: t(ORDER_STATUS_LABEL_KEYS[normalizeOrderStatus(pendingMove.toStatus) as OrderStatus]),
                  })}
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setPendingMove(null)}>
                {t("common.cancel")}
              </Button>
              <Button
                className="bg-teal-700 text-white hover:bg-teal-800"
                onClick={() => {
                  performMove(pendingMove.order, pendingMove.toStatus);
                  setPendingMove(null);
                }}
                data-testid="button-confirm-board-move"
              >
                {t("common.confirm")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function BoardColumn({
  columnKey,
  accent,
  labelKey,
  count,
  children,
}: {
  columnKey: BoardColumnKey;
  accent: { border: string; dot: string };
  labelKey: string;
  count: number;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const { setNodeRef, isOver } = useDroppable({ id: columnKey });
  return (
    <div className="flex w-72 shrink-0 flex-col" data-testid={`board-column-${columnKey}`}>
      <div
        className={cn(
          "sticky top-0 z-10 flex items-center gap-2 rounded-t-md border border-b-0 border-t-4 bg-secondary/60 px-3 py-2",
          accent.border,
        )}
      >
        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", accent.dot)} />
        <span className="text-sm font-semibold">{t(labelKey)}</span>
        <Badge variant="secondary" className="ml-auto" data-testid={`board-column-count-${columnKey}`}>
          {count}
        </Badge>
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          "flex min-h-[240px] flex-1 flex-col gap-2 rounded-b-md border border-border bg-background/60 p-2 transition-colors",
          isOver && "bg-teal-50/60 ring-2 ring-inset ring-teal-400",
        )}
      >
        {children}
      </div>
    </div>
  );
}

/** Delivery day/date, time window, and district/city — same source data as the list's Delivery column. */
function useBoardDeliveryInfo(order: OrderRow, nowMs: number) {
  const { t } = useTranslation();
  const addr = order.delivery_address ?? {};
  const schedule = resolveDeliverySchedule({
    windowStart: order.window_start,
    windowEnd: order.window_end,
    legacyDate: addr["date"],
    legacySlot: addr["slot"],
  });
  const presentation = formatDeliverySchedule(
    schedule,
    order.delivery_timezone || "UTC",
    new Date(nowMs),
  );
  const area = boardAreaLabel(order);

  if (!presentation) {
    return { dayLabel: "—", slot: "", area };
  }
  const dayLabel =
    presentation.relativeLabel === "Today"
      ? t("orders.relToday")
      : presentation.relativeLabel === "Tomorrow"
        ? t("orders.relTomorrow")
        : presentation.dateLabel;
  return { dayLabel, slot: presentation.timeLabel, area };
}

function TruncatedText({ text, className }: { text: string; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("truncate", className)}>{text}</span>
      </TooltipTrigger>
      <TooltipContent side="top">{text}</TooltipContent>
    </Tooltip>
  );
}

function BoardCard({
  order,
  columnKey,
  nowMs,
  saving,
  disabled,
  onOpen,
  onAdvanceToProcessing,
}: {
  order: OrderRow;
  columnKey: BoardColumnKey;
  nowMs: number;
  saving: boolean;
  disabled: boolean;
  onOpen: () => void;
  onAdvanceToProcessing?: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: order.id,
    disabled,
  });
  const style = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...listeners}
      {...attributes}
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") onOpen();
      }}
      className={cn(
        "touch-none",
        isDragging && "opacity-40",
      )}
      data-testid={`board-card-${order.id}`}
    >
      <BoardCardBody
        order={order}
        columnKey={columnKey}
        nowMs={nowMs}
        saving={saving}
        disabled={disabled}
        onAdvanceToProcessing={onAdvanceToProcessing}
      />
    </div>
  );
}

function BoardCardBody({
  order,
  columnKey,
  nowMs,
  saving,
  disabled = false,
  onAdvanceToProcessing,
}: {
  order: OrderRow;
  columnKey: BoardColumnKey;
  nowMs: number;
  saving: boolean;
  disabled?: boolean;
  onAdvanceToProcessing?: () => void;
}) {
  const { t } = useTranslation();
  const { dayLabel, slot, area } = useBoardDeliveryInfo(order, nowMs);
  const atRisk = columnKey !== "completed" && isAtRiskOrder(order, nowMs);
  const paymentException = columnKey !== "completed" && isPaymentException(order);
  const punctuality = columnKey === "completed" ? boardPunctuality(order) : null;
  const punctualityStyle = punctuality ? PUNCTUALITY_STYLES[punctuality.verdict] : null;

  return (
    <div
      className={cn(
        "cursor-pointer select-none rounded-md border border-border bg-card p-2.5 shadow-sm transition-shadow hover:shadow-md",
        saving && "opacity-60",
      )}
    >
      <div className="flex items-start gap-2">
        <OrderThumbnail src={order.thumbnail_url} />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate text-sm font-semibold">
              {`#${order.display_order_number || order.external_order_id || "—"}`}
            </span>
            {saving && <Loader2 size={12} className="shrink-0 animate-spin text-muted-foreground" />}
          </div>
          <div className="text-xs font-medium leading-tight">{dayLabel}</div>
          {slot && <div className="text-xs leading-tight text-muted-foreground">{slot}</div>}
          {area && (
            <div className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
              <MapPin size={11} className="shrink-0" />
              <TruncatedText text={area} className="max-w-[160px]" />
            </div>
          )}
        </div>
      </div>

      {(atRisk || paymentException) && (
        <div className="mt-2 flex flex-wrap gap-1">
          {atRisk && (
            <Badge
              variant="outline"
              className="border-red-200 bg-red-100 text-[10px] font-semibold uppercase tracking-wide text-red-800"
              data-testid={`badge-board-at-risk-${order.id}`}
            >
              {t("orders.boardAtRisk")}
            </Badge>
          )}
          {paymentException && (
            <Badge
              variant="outline"
              className="border-amber-200 bg-amber-100 text-[10px] font-medium text-amber-800"
              data-testid={`badge-board-payment-${order.id}`}
            >
              {t("orders.boardPaymentPending")}
            </Badge>
          )}
        </div>
      )}

      <div className="mt-2 border-t border-border/60 pt-2">
        {onAdvanceToProcessing ? (
          <div className="flex items-center justify-between gap-2">
            <TruncatedText
              text={order.workshop?.location_name || t("orders.boardWorkshopUnassigned")}
              className={cn("max-w-[120px] text-xs", !order.workshop && "italic text-muted-foreground")}
            />
            <Button
              size="sm"
              variant="outline"
              className="h-6 shrink-0 px-2 text-[11px]"
              disabled={disabled || saving}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                onAdvanceToProcessing();
              }}
              data-testid={`button-board-start-processing-${order.id}`}
            >
              {t("orders.boardStartProcessing")}
            </Button>
          </div>
        ) : columnKey === "out_for_delivery" ? (
          hasDriver(order) ? (
            <div className="flex items-center gap-1.5">
              <Avatar className="h-5 w-5 shrink-0">
                <AvatarFallback className="bg-teal-100 text-[9px] font-semibold text-teal-800">
                  {driverInitials(order)}
                </AvatarFallback>
              </Avatar>
              <TruncatedText text={driverFullName(order)} className="max-w-[160px] text-xs" />
            </div>
          ) : (
            <span className="text-xs italic text-muted-foreground">{t("orders.boardDriverUnassigned")}</span>
          )
        ) : columnKey === "completed" && punctualityStyle ? (
          <Badge
            variant="outline"
            className={cn("text-[10px] font-semibold uppercase tracking-wide", punctualityStyle.cls)}
            data-testid={`badge-board-punctuality-${order.id}`}
          >
            {t(punctualityStyle.labelKey)}
          </Badge>
        ) : (
          <TruncatedText
            text={order.workshop?.location_name || t("orders.boardWorkshopUnassigned")}
            className={cn(
              "max-w-[220px] text-xs",
              !order.workshop && "italic text-muted-foreground",
            )}
          />
        )}
      </div>
    </div>
  );
}
