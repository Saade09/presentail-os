import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  Flower2,
  Loader2,
  Play,
  Pause,
  CheckCircle2,
  Printer,
  Package,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogClose,
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
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { apiFetch } from "@/lib/queryClient";
import { imageUrl } from "@/lib/imageUrl";
import { FloristPhotoVerification } from "@/components/FloristPhotoVerification";
import { OrderStatusBadge } from "@/components/OrderStatusBadge";
import {
  useListFloristOrders,
  getListFloristOrdersQueryKey,
  useStartFloristOrder,
  usePauseFloristOrder,
  useCompleteFloristOrder,
  useListFloristManualReviews,
  getListFloristManualReviewsQueryKey,
  getGetFloristManualReviewCountQueryKey,
  useApproveFloristManualReview,
  useRemoveOrderFloristAssignment,
  getGetOrderFloristAssignmentQueryKey,
  getListOrderActivityQueryKey,
} from "@workspace/api-client-react";
import type {
  FloristOrderCard,
  FloristOrderItem,
  FloristManualReview,
  FloristVerificationState,
} from "@workspace/api-client-react";

const STATUS_BADGE: Record<string, string> = {
  pending: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30",
  in_progress: "bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30",
  paused: "bg-slate-500/15 text-slate-700 dark:text-slate-400 border-slate-500/30",
  completed: "bg-green-500/15 text-green-700 dark:text-green-400 border-green-500/30",
};

const PRINT_CARD_SHOP = "Presentail Flowers and Gifts";

type BranchConfig = {
  id: number;
  name: string;
};

function formatTime(value: string | null | undefined): string {
  if (!value) return "";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

function parseValidDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isSameLocalDate(first: Date, second: Date): boolean {
  return (
    first.getFullYear() === second.getFullYear() &&
    first.getMonth() === second.getMonth() &&
    first.getDate() === second.getDate()
  );
}

function formatDeliveryWindow(
  windowStart: string | null | undefined,
  windowEnd: string | null | undefined,
  locale: string,
): string {
  const start = parseValidDate(windowStart);
  const end = parseValidDate(windowEnd);
  const first = start ?? end;
  if (!first) return "";

  const dateFormatter = new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const timeFormatter = new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
  });
  const firstDate = dateFormatter.format(first);
  const firstTime = timeFormatter.format(first);

  if (!start || !end) {
    return `${firstDate} · ${firstTime}`;
  }

  const second = isSameLocalDate(start, end)
    ? timeFormatter.format(end)
    : `${dateFormatter.format(end)} · ${timeFormatter.format(end)}`;

  return `${firstDate} · ${firstTime} – ${second}`;
}

/** Format a numeric-string quantity ("12", "1.5") without trailing zeros. */
function formatQuantity(value: string): string {
  const n = Number(value);
  if (Number.isNaN(n)) return value;
  return String(n);
}

export default function FloristOrdersPage() {
  const { t, i18n } = useTranslation();
  const isArabic = i18n.language === "ar";
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { isOwner, floristLocationId, allowedPages } = useWorkspaceRole();
  const canReview = isOwner || (allowedPages ?? []).includes("orders");
  const canUseFloristWorkflow =
    isOwner || (allowedPages ?? []).includes("florist_orders");

  const [locationFilter, setLocationFilter] = useState<string>("all");
  const [printingId, setPrintingId] = useState<number | null>(null);
  const [printingCakeId, setPrintingCakeId] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState<string>("new");
  const [productView, setProductView] = useState<FloristOrderItem | null>(null);
  const [unassignTarget, setUnassignTarget] = useState<FloristOrderCard | null>(
    null,
  );
  const [activePane, setActivePane] = useState(0);
  const pagerRef = useRef<HTMLDivElement>(null);

  // Track which orders have had their card printed in this session
  const [printedOrderIds, setPrintedOrderIds] = useState<Set<number>>(new Set());

  // Print card dialog state (for owners who need to pick a branch)
  const [printCardDialogOpen, setPrintCardDialogOpen] = useState(false);
  const [printCardBranch, setPrintCardBranch] = useState<string>("");
  const [printCardPending, setPrintCardPending] = useState(false);
  const [printCardDialogOrder, setPrintCardDialogOrder] = useState<FloristOrderCard | null>(null);

  const openProductView = (item: FloristOrderItem) => {
    setActivePane(0);
    setProductView(item);
  };

  const goToPane = (index: number) => {
    const pane = pagerRef.current?.children[index];
    if (pane instanceof HTMLElement) {
      pane.scrollIntoView({
        behavior: "smooth",
        inline: "start",
        block: "nearest",
      });
    }
    setActivePane(index);
  };

  const handlePagerScroll = () => {
    const el = pagerRef.current;
    if (!el || el.clientWidth === 0) return;
    // Math.abs handles RTL, where scrollLeft goes negative.
    const idx = Math.round(Math.abs(el.scrollLeft) / el.clientWidth);
    setActivePane(idx);
  };

  const { data: locationsData } = useQuery({
    queryKey: ["locations"],
    queryFn: () =>
      apiFetch<{ locations: { id: number; name: string }[] }>("/api/locations"),
    enabled: isOwner,
  });
  const locations = locationsData?.locations ?? [];

  // Branch configs for the card print feature (owners need the dialog; members
  // use the config to auto-select their branch by location name).
  const { data: branchConfigsData } = useQuery({
    queryKey: ["branch-configs"],
    queryFn: () =>
      apiFetch<{ configs: BranchConfig[] }>("/api/card-message/branch-configs"),
    enabled: canUseFloristWorkflow,
  });
  const branchConfigs = branchConfigsData?.configs ?? [];

  const listParams =
    isOwner && locationFilter !== "all"
      ? { location_id: parseInt(locationFilter, 10) }
      : undefined;

  const {
    data: manualReviewsData,
    isLoading: manualReviewsLoading,
    isError: manualReviewsError,
    error: manualReviewsErrorDetail,
  } = useListFloristManualReviews({
      query: {
        refetchInterval: 30_000,
        queryKey: getListFloristManualReviewsQueryKey(),
        enabled: canReview,
      },
    });
  const manualReviews = manualReviewsData?.manual_reviews ?? [];
  const { data, isLoading, isError, error } = useListFloristOrders(listParams, {
    query: {
      refetchInterval: 30_000,
      queryKey: getListFloristOrdersQueryKey(listParams),
      enabled: canUseFloristWorkflow,
    },
  });
  const floristOrders = data?.florist_orders ?? [];

  const newOrders = useMemo(
    () => floristOrders.filter((fo) => fo.status === "pending"),
    [floristOrders],
  );
  const inProgressOrders = useMemo(
    () =>
      floristOrders.filter(
        (fo) => fo.status === "in_progress" || fo.status === "paused",
      ),
    [floristOrders],
  );
  const completedOrders = useMemo(
    () => floristOrders.filter((fo) => fo.status === "completed"),
    [floristOrders],
  );

  const startMut = useStartFloristOrder();
  const pauseMut = usePauseFloristOrder();
  const completeMut = useCompleteFloristOrder();
  const approveMut = useApproveFloristManualReview();
  const unassignMut = useRemoveOrderFloristAssignment();

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: getListFloristOrdersQueryKey() });
    queryClient.invalidateQueries({ queryKey: getListFloristManualReviewsQueryKey() });
    queryClient.invalidateQueries({
      queryKey: getGetFloristManualReviewCountQueryKey(),
    });
  };

  const applyVerificationState = (
    floristOrderId: number,
    verification: FloristVerificationState,
  ) => {
    queryClient.setQueriesData(
      { queryKey: getListFloristOrdersQueryKey() },
      (old: unknown) => {
        const cached = old as { florist_orders: FloristOrderCard[] } | undefined;
        if (!cached?.florist_orders) return old;
        return {
          ...cached,
          florist_orders: cached.florist_orders.map((item) =>
            item.id === floristOrderId ? { ...item, ...verification } : item,
          ),
        };
      },
    );
  };

  const onError = (e: unknown) =>
    toast({
      title: t("floristOrders.actionFailed"),
      description: e instanceof Error ? e.message : undefined,
      variant: "destructive",
    });

  const handleApproveReview = (review: FloristManualReview) => {
    approveMut.mutate(
      { id: review.id, data: { photo_set_rev: review.photo_set_rev } },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: t("floristOrders.reviewApproved", { order: review.order_number }) });
        },
        onError,
      }
    );
  };

  const handleStart = (fo: FloristOrderCard) =>
    startMut.mutate(
      { id: fo.id },
      { onSuccess: invalidate, onError },
    );
  const handlePause = (fo: FloristOrderCard) =>
    pauseMut.mutate(
      { id: fo.id },
      { onSuccess: invalidate, onError },
    );
  const handleUnassign = () => {
    if (!unassignTarget) return;
    const target = unassignTarget;
    unassignMut.mutate(
      { id: target.order_id },
      {
        onSuccess: () => {
          queryClient.setQueriesData(
            { queryKey: getListFloristOrdersQueryKey() },
            (old: unknown) => {
              const cached = old as
                | { florist_orders: FloristOrderCard[] }
                | undefined;
              if (!cached?.florist_orders) return old;
              return {
                ...cached,
                florist_orders: cached.florist_orders.filter(
                  (item) => item.id !== target.id,
                ),
              };
            },
          );
          setUnassignTarget(null);
          invalidate();
          void queryClient.invalidateQueries({ queryKey: ["orders"] });
          void queryClient.invalidateQueries({
            queryKey: ["order", target.order_id],
          });
          void queryClient.invalidateQueries({
            queryKey: getGetOrderFloristAssignmentQueryKey(target.order_id),
          });
          void queryClient.invalidateQueries({
            queryKey: getListOrderActivityQueryKey(target.order_id),
          });
          toast({
            title: t("floristOrders.unassignedToast", {
              order: target.order_number,
            }),
          });
        },
        onError: (error: unknown) =>
          toast({
            title: t("floristOrders.unassignFailed"),
            description:
              error instanceof Error ? error.message : String(error),
            variant: "destructive",
          }),
      },
    );
  };
  /** Card-printed unlock: durable server state, plus this session's prints. */
  const isPrinted = (fo: FloristOrderCard) =>
    !fo.has_card || !!fo.card_printed_at || printedOrderIds.has(fo.id);

  /** Complete is available only when the verification is approved. */
  const isReadyToComplete = (fo: FloristOrderCard) =>
    isPrinted(fo) &&
    !!fo.photo_items_path &&
    (!fo.has_card || !!fo.photo_card_path) &&
    (!fo.has_cake || !fo.has_card || !!fo.photo_card_on_box_path) &&
    fo.verification_status === "approved";

  const handleComplete = (fo: FloristOrderCard) => {
    if (fo.has_card && !isPrinted(fo)) {
      toast({
        title: t("floristOrders.mustPrintCardFirst"),
        variant: "destructive",
      });
      return;
    }
    return completeMut.mutate(
      { id: fo.id },
      {
        onSuccess: () => {
          invalidate();
          toast({ title: t("floristOrders.completedToast", { order: fo.order_number }) });
        },
        onError,
      },
    );
  };

  async function doPrintCard(fo: FloristOrderCard, branchName: string) {
    await apiFetch("/api/card-message/print", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        location: branchName,
        shopName: PRINT_CARD_SHOP,
        orderId: fo.order_number,
        cardMessage: fo.card_message?.trim() || " ",
        toName: fo.card_to ?? undefined,
        fromName: fo.card_from ?? undefined,
        realOrderId: fo.order_id,
      }),
    });
  }

  async function handlePrintCard(fo: FloristOrderCard) {
    // Florist member: auto-resolve the branch by matching their location name
    // to the branch config name. No dialog required.
    if (!isOwner && floristLocationId != null) {
      const matchingConfig = branchConfigs.find((c) => c.name === fo.location_name);
      if (!matchingConfig) {
        toast({
          title: t("floristOrders.printCardNoPrinter"),
          variant: "destructive",
        });
        return;
      }
      setPrintingId(fo.id);
      try {
        await doPrintCard(fo, matchingConfig.name);
        setPrintedOrderIds((prev) => new Set(prev).add(fo.id));
        invalidate();
        toast({ title: t("floristOrders.printCardSuccess") });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "";
        if (msg.includes("no_printer_configured")) {
          toast({ title: t("floristOrders.printCardNoPrinter"), variant: "destructive" });
        } else {
          toast({ title: t("floristOrders.printCardFailed"), variant: "destructive" });
        }
      } finally {
        setPrintingId(null);
      }
      return;
    }

    // Owner: open the branch-selector dialog
    setPrintCardDialogOrder(fo);
    setPrintCardBranch("");
    setPrintCardDialogOpen(true);
  }

  async function handlePrintCardSubmit() {
    const fo = printCardDialogOrder;
    if (!fo || !printCardBranch) return;
    setPrintCardPending(true);
    try {
      await doPrintCard(fo, printCardBranch);
      setPrintedOrderIds((prev) => new Set(prev).add(fo.id));
      invalidate();
      setPrintCardDialogOpen(false);
      toast({ title: t("floristOrders.printCardSuccess") });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "";
      if (msg.includes("no_printer_configured")) {
        toast({ title: t("floristOrders.printCardNoPrinter"), variant: "destructive" });
      } else {
        toast({ title: t("floristOrders.printCardFailed"), variant: "destructive" });
      }
    } finally {
      setPrintCardPending(false);
    }
  }

  async function handlePrintCake(fo: FloristOrderCard) {
    const cakeMessage = fo.items.find((item) => /cake/i.test(item.name) && item.custom_input?.trim())?.custom_input?.trim();
    if (!cakeMessage) return;
    if (fo.location_name !== "Achrafieh" && fo.location_name !== "Jdeideh") {
      toast({ title: t("cardMessage.cakeInvalidLocation"), variant: "destructive" });
      return;
    }
    setPrintingCakeId(fo.id);
    try {
      await apiFetch("/api/card-message/print-cake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ location: fo.location_name, cakeMessage, floristOrderId: fo.order_id }),
      });
      toast({ title: t("cardMessage.cakeSuccessMessage") });
    } catch {
      toast({ title: t("cardMessage.cakeErrorMessage"), variant: "destructive" });
    } finally {
      setPrintingCakeId(null);
    }
  }

  const busy =
    startMut.isPending ||
    pauseMut.isPending ||
    completeMut.isPending ||
    unassignMut.isPending;

  const renderCard = (fo: FloristOrderCard) => (
    <Card key={fo.id} data-testid={`florist-order-${fo.id}`}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">
            #{fo.order_number}
          </CardTitle>
          <div className="flex items-center gap-1.5">
            {fo.parent_order_status && (
              <span data-testid={`parent-order-status-${fo.id}`}>
                <OrderStatusBadge status={fo.parent_order_status} />
              </span>
            )}
            <Badge
              variant="outline"
              className={STATUS_BADGE[fo.status] ?? ""}
              data-testid={`status-${fo.id}`}
            >
              {t(`floristOrders.status.${fo.status}`)}
            </Badge>
          </div>
        </div>
        {isOwner && (
          <p className="text-xs text-muted-foreground">{fo.location_name}</p>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        <ul className="space-y-3">
          {fo.items.map((item, idx) => (
            <li key={idx} className="flex items-center gap-3 text-sm">
              <button
                type="button"
                onClick={() => openProductView(item)}
                className="shrink-0 rounded-lg overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={t("floristOrders.viewProduct", { name: item.name })}
                data-testid={`button-view-product-${fo.id}-${idx}`}
              >
                {item.image_url ? (
                  <img
                    src={imageUrl(item.image_url) ?? undefined}
                    alt={item.name}
                    className="w-20 h-20 rounded-lg object-cover"
                    loading="lazy"
                  />
                ) : (
                  <span className="w-20 h-20 rounded-lg bg-secondary flex items-center justify-center">
                    <Package size={24} className="text-muted-foreground" />
                  </span>
                )}
              </button>
              <button
                type="button"
                onClick={() => openProductView(item)}
                className="flex-1 min-w-0 text-start font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                data-testid={`button-view-product-name-${fo.id}-${idx}`}
              >
                <span className="line-clamp-2">{item.name}</span>
                {item.custom_input && (
                  <span className="block text-xs text-muted-foreground font-normal truncate">
                    {item.custom_input}
                  </span>
                )}
              </button>
              <span className="text-muted-foreground shrink-0">
                ×{item.quantity}
              </span>
            </li>
          ))}
        </ul>
        {formatDeliveryWindow(
          fo.window_start,
          fo.window_end,
          i18n.resolvedLanguage ?? i18n.language,
        ) && (
          <p
            className="text-xs text-muted-foreground"
            data-testid={`delivery-window-${fo.id}`}
          >
            {t("floristOrders.deliveryWindow")}:{" "}
            {formatDeliveryWindow(
              fo.window_start,
              fo.window_end,
              i18n.resolvedLanguage ?? i18n.language,
            )}
          </p>
        )}
        {fo.status === "in_progress" &&
          (isPrinted(fo) ? (
            <FloristPhotoVerification
              fo={fo}
              onChanged={invalidate}
              onVerificationChanged={(verification) =>
                applyVerificationState(fo.id, verification)
              }
              onOrderStatusUpdated={() => {
                queryClient.setQueriesData(
                  { queryKey: ["/api/florist-orders"] },
                  (old: unknown) => {
                    const data = old as { florist_orders: FloristOrderCard[] } | undefined;
                    if (!data?.florist_orders) return old;
                    return {
                      ...data,
                      florist_orders: data.florist_orders.map((item) =>
                        item.order_id === fo.order_id
                          ? { ...item, parent_order_status: "ready_for_delivery" }
                          : item,
                      ),
                    };
                  },
                );
              }}
            />
          ) : (
            <p className="text-xs text-muted-foreground">
              {t("floristOrders.printCardBeforePhotos")}
            </p>
          ))}
        <div className="flex flex-wrap gap-2 pt-1">
          {(fo.status === "pending" || fo.status === "paused") && (
            <Button
              size="sm"
              className="gap-1.5"
              disabled={busy}
              onClick={() => handleStart(fo)}
              data-testid={`button-start-${fo.id}`}
            >
              <Play size={14} />
              {fo.status === "paused"
                ? t("floristOrders.resume")
                : t("floristOrders.start")}
            </Button>
          )}
          {fo.status === "in_progress" && (
            <>
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                disabled={busy}
                onClick={() => handlePause(fo)}
                data-testid={`button-pause-${fo.id}`}
              >
                <Pause size={14} />
                {t("floristOrders.pause")}
              </Button>
              {isReadyToComplete(fo) && (
                <Button
                  size="sm"
                  className="gap-1.5"
                  disabled={busy}
                  onClick={() => handleComplete(fo)}
                  data-testid={`button-complete-${fo.id}`}
                >
                  <CheckCircle2 size={14} />
                  {t("floristOrders.complete")}
                </Button>
              )}
            </>
          )}
          {fo.has_card && fo.status === "in_progress" && (
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5"
              disabled={printingId === fo.id || printCardPending}
              onClick={() => handlePrintCard(fo)}
              data-testid={`button-print-card-${fo.id}`}
            >
              {printingId === fo.id ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Printer size={14} />
              )}
              {t("floristOrders.printCard")}
            </Button>
          )}
          {fo.status === "in_progress" &&
            fo.items.some((item) => /cake/i.test(item.name) && item.custom_input?.trim()) && (
            <Button size="sm" variant="outline" className="gap-1.5"
              disabled={printingCakeId === fo.id}
              onClick={() => handlePrintCake(fo)}
              data-testid={`button-print-cake-${fo.id}`}>
              {printingCakeId === fo.id ? <Loader2 size={14} className="animate-spin" /> : <Printer size={14} />}
              {t("cardMessage.printCake")}
            </Button>
          )}
          {canReview && fo.status !== "completed" && (
            <Button
              size="sm"
              variant="outline"
              className="gap-1.5 text-destructive hover:text-destructive"
              disabled={busy}
              onClick={() => setUnassignTarget(fo)}
              data-testid={`button-unassign-${fo.id}`}
            >
              <Trash2 size={14} />
              {t("floristOrders.unassign")}
            </Button>
          )}
        </div>
        {fo.completed_at && (
          <p className="text-xs text-muted-foreground">
            {t("floristOrders.completedAt")}: {formatTime(fo.completed_at)}
          </p>
        )}
      </CardContent>
    </Card>
  );

  const renderReviewCard = (review: FloristManualReview) => (
    <Card key={review.id} data-testid={`manual-review-${review.id}`}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">
            #{review.order_number}
          </CardTitle>
          <Badge
            variant="outline"
            className="bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30"
          >
            {t("floristOrders.tabReview")}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">{review.location_name}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="bg-destructive/5 border border-destructive/20 rounded-lg p-3 text-sm">
          <span className="font-semibold text-foreground me-1">
            {t("floristOrders.aiRejectedReason")}:
          </span>
          <span className="text-muted-foreground" data-testid={`review-reason-${review.id}`}>
            {review.verification_reason ||
              (review.verification_reason_code
                ? t(
                    `floristOrders.rejectionReason.${review.verification_reason_code}`,
                    review.verification_reason_code,
                  )
                : t("floristOrders.rejectionReason.other"))}
          </span>
        </div>
        <div className={`grid gap-3 ${review.photo_card_path ? "grid-cols-2" : "grid-cols-1"}`}>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">{t("floristOrders.photoItems")}</Label>
            <div className="aspect-square bg-secondary rounded-lg overflow-hidden relative">
              <img
                src={imageUrl(review.photo_items_path) ?? undefined}
                alt={t("floristOrders.photoItems")}
                className="absolute inset-0 w-full h-full object-cover"
                loading="lazy"
                data-testid={`review-items-img-${review.id}`}
              />
            </div>
          </div>
          {review.photo_card_path && (
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">{t("floristOrders.photoCard")}</Label>
              <div className="aspect-square bg-secondary rounded-lg overflow-hidden relative">
                <img
                  src={imageUrl(review.photo_card_path) ?? undefined}
                  alt={t("floristOrders.photoCard")}
                  className="absolute inset-0 w-full h-full object-cover"
                  loading="lazy"
                  data-testid={`review-card-img-${review.id}`}
                />
              </div>
            </div>
          )}
        </div>
        {review.photo_card_on_box_path && (
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">{t("floristOrders.photoCardOnBoxLabel")}</Label>
            <div className="aspect-video bg-secondary rounded-lg overflow-hidden relative">
              <img
                src={imageUrl(review.photo_card_on_box_path) ?? undefined}
                alt={t("floristOrders.photoCardOnBoxLabel")}
                className="absolute inset-0 w-full h-full object-cover"
                loading="lazy"
                data-testid={`review-card-on-box-img-${review.id}`}
              />
            </div>
          </div>
        )}
        <div className="flex justify-end pt-2">
          <Dialog>
            <DialogTrigger asChild>
              <Button size="sm" className="gap-1.5" disabled={approveMut.isPending} data-testid={`button-approve-review-${review.id}`}>
                <CheckCircle2 size={14} />
                {t("floristOrders.approve")}
              </Button>
            </DialogTrigger>
            <DialogContent data-testid={`dialog-approve-review-${review.id}`}>
              <DialogHeader>
                <DialogTitle>{t("floristOrders.confirmApprove")}</DialogTitle>
                <DialogDescription>
                  {t("floristOrders.approveDesc")}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose asChild>
                  <Button variant="outline" data-testid="button-cancel-approve">
                    {t("deleteCancel", "Cancel")}
                  </Button>
                </DialogClose>
                <Button onClick={() => handleApproveReview(review)} disabled={approveMut.isPending} data-testid="button-confirm-approve">
                  {approveMut.isPending && <Loader2 size={14} className="me-1 animate-spin" />}
                  {t("floristOrders.approve")}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </CardContent>
    </Card>
  );

  const renderReviewList = (reviews: FloristManualReview[]) =>
    reviews.length === 0 ? (
      <div className="flex flex-col items-center justify-center py-24 gap-2 text-center">
        <Flower2 size={40} className="text-muted-foreground opacity-40" />
        <p className="font-medium">{t("floristOrders.emptyReviewTitle")}</p>
        <p className="text-sm text-muted-foreground">
          {t("floristOrders.emptyReviewBody")}
        </p>
      </div>
    ) : (
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {reviews.map(renderReviewCard)}
      </div>
    );


  const renderList = (orders: FloristOrderCard[], emptyKey: string) =>
    orders.length === 0 ? (
      <div className="flex flex-col items-center justify-center py-24 gap-2 text-center">
        <Flower2 size={40} className="text-muted-foreground opacity-40" />
        <p className="font-medium">{t(`floristOrders.${emptyKey}Title`)}</p>
        <p className="text-sm text-muted-foreground">
          {t(`floristOrders.${emptyKey}Body`)}
        </p>
      </div>
    ) : (
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {orders.map(renderCard)}
      </div>
    );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
            <Flower2 size={22} className="text-muted-foreground" />
            {t("floristOrders.title")}
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {t("floristOrders.subtitle")}
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <div
            className="inline-flex rounded-md border p-0.5"
            role="group"
            aria-label={t("floristOrders.languageToggle")}
            data-testid="language-toggle"
          >
            <Button
              size="sm"
              variant={!isArabic ? "default" : "ghost"}
              className="h-7 px-3"
              onClick={() => i18n.changeLanguage("en")}
              data-testid="button-lang-en"
            >
              EN
            </Button>
            <Button
              size="sm"
              variant={isArabic ? "default" : "ghost"}
              className="h-7 px-3"
              onClick={() => i18n.changeLanguage("ar")}
              data-testid="button-lang-ar"
            >
              عربي
            </Button>
          </div>
          {isOwner && locations.length > 0 && (
          <Select value={locationFilter} onValueChange={setLocationFilter}>
            <SelectTrigger className="w-56" data-testid="select-location-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("floristOrders.allLocations")}</SelectItem>
              {locations.map((loc) => (
                <SelectItem key={loc.id} value={String(loc.id)}>
                  {loc.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          )}
        </div>
      </div>

      {canReview && (
        <section
          className="rounded-xl border border-destructive/20 bg-destructive/[0.025] p-4 sm:p-5 space-y-4"
          data-testid="manual-review-section"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold">
                {t("floristOrders.manualReviewTitle")}
              </h2>
              <p className="text-sm text-muted-foreground mt-1">
                {t("floristOrders.manualReviewSubtitle")}
              </p>
            </div>
            {manualReviews.length > 0 && (
              <Badge
                className="bg-destructive text-destructive-foreground"
                data-testid="badge-review-count"
              >
                {manualReviews.length}
              </Badge>
            )}
          </div>
          {manualReviewsLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="animate-spin text-muted-foreground" size={24} />
            </div>
          ) : manualReviewsError ? (
            <div className="rounded-lg border border-destructive/20 bg-background p-4 text-sm">
              <p className="font-medium">{t("floristOrders.manualReviewLoadFailed")}</p>
              <p className="text-muted-foreground mt-1">
                {manualReviewsErrorDetail instanceof Error
                  ? manualReviewsErrorDetail.message
                  : null}
              </p>
            </div>
          ) : (
            renderReviewList(manualReviews)
          )}
        </section>
      )}


      {canUseFloristWorkflow && (isLoading ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="animate-spin text-muted-foreground" size={28} />
        </div>
      ) : isError ? (
        <div className="flex flex-col items-center justify-center py-24 gap-2 text-center">
          <Flower2 size={40} className="text-muted-foreground opacity-40" />
          <p className="font-medium">{t("floristOrders.loadFailed")}</p>
          <p className="text-sm text-muted-foreground">
            {error instanceof Error ? error.message : null}
          </p>
        </div>
      ) : (
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <TabsList className="w-full sm:w-auto">
            <TabsTrigger
              value="new"
              className="flex-1 sm:flex-none gap-2"
              data-testid="tab-new"
            >
              {t("floristOrders.tabNew")}
              <Badge
                variant="secondary"
                className="px-1.5 min-w-5 justify-center"
                data-testid="badge-new-count"
              >
                {newOrders.length}
              </Badge>
            </TabsTrigger>
            <TabsTrigger
              value="in_progress"
              className="flex-1 sm:flex-none gap-2"
              data-testid="tab-in-progress"
            >
              {t("floristOrders.tabInProgress")}
              <Badge
                variant="secondary"
                className="px-1.5 min-w-5 justify-center"
                data-testid="badge-in-progress-count"
              >
                {inProgressOrders.length}
              </Badge>
            </TabsTrigger>
            <TabsTrigger
              value="completed"
              className="flex-1 sm:flex-none gap-2"
              data-testid="tab-completed"
            >
              {t("floristOrders.tabCompleted")}
              <Badge
                variant="secondary"
                className="px-1.5 min-w-5 justify-center"
                data-testid="badge-completed-count"
              >
                {completedOrders.length}
              </Badge>
            </TabsTrigger>
          </TabsList>
          <TabsContent value="new" className="mt-4">
            {renderList(newOrders, "emptyNew")}
          </TabsContent>
          <TabsContent value="in_progress" className="mt-4">
            {renderList(inProgressOrders, "emptyInProgress")}
          </TabsContent>
          <TabsContent value="completed" className="mt-4">
            {renderList(completedOrders, "emptyCompleted")}
          </TabsContent>
        </Tabs>
      ))}

      {/* Print Card dialog — shown to owners who need to pick a branch */}
      <Dialog
        open={printCardDialogOpen}
        onOpenChange={(open) => {
          if (!printCardPending) setPrintCardDialogOpen(open);
        }}
      >
        <DialogContent className="max-w-md" data-testid="dialog-print-card">
          <DialogHeader>
            <DialogTitle>{t("floristOrders.printCardDialogTitle")}</DialogTitle>
            <DialogDescription>
              {printCardDialogOrder
                ? t("floristOrders.printCardDialogDesc", { order: printCardDialogOrder.order_number })
                : null}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>{t("floristOrders.printCardBranch")}</Label>
              <Select value={printCardBranch} onValueChange={setPrintCardBranch}>
                <SelectTrigger className="w-full" data-testid="select-print-card-branch">
                  <SelectValue placeholder={t("floristOrders.printCardBranchPlaceholder")} />
                </SelectTrigger>
                <SelectContent>
                  {branchConfigs.length === 0 ? (
                    <SelectItem value="__none" disabled>
                      {t("floristOrders.printCardNoBranches")}
                    </SelectItem>
                  ) : (
                    branchConfigs.map((b) => (
                      <SelectItem key={b.id} value={b.name}>
                        {b.name}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPrintCardDialogOpen(false)}
              disabled={printCardPending}
            >
              {t("orders.editHistoryClose")}
            </Button>
            <Button
              onClick={handlePrintCardSubmit}
              disabled={!printCardBranch || printCardPending}
              data-testid="button-print-card-submit"
            >
              {printCardPending && (
                <Loader2 size={14} className="me-1 animate-spin" />
              )}
              <Printer size={14} className="me-1" />
              {t("floristOrders.printCardSubmit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={unassignTarget !== null}
        onOpenChange={(open) => {
          if (!open && !unassignMut.isPending) setUnassignTarget(null);
        }}
      >
        <AlertDialogContent data-testid="dialog-unassign-florist-order">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("floristOrders.unassignTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("floristOrders.unassignBody", {
                order: unassignTarget?.order_number ?? "",
                location: unassignTarget?.location_name ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={unassignMut.isPending}>
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={(event) => {
                event.preventDefault();
                handleUnassign();
              }}
              disabled={unassignMut.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-unassign-florist-order"
            >
              {unassignMut.isPending && (
                <Loader2 size={14} className="me-1 animate-spin" />
              )}
              {t("floristOrders.unassign")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog
        open={productView !== null}
        onOpenChange={(open) => {
          if (!open) setProductView(null);
        }}
      >
        <DialogContent
          className="max-w-full sm:max-w-lg w-full h-full sm:h-auto sm:max-h-[90vh] p-0 gap-0 rounded-none sm:rounded-lg"
          style={{ gridTemplateRows: "auto minmax(0,1fr)" }}
          data-testid="dialog-product-view"
        >
          <DialogHeader className="p-4 pb-2 pe-12 text-start">
            <DialogTitle className="text-lg leading-snug">
              {productView?.name}
            </DialogTitle>
          </DialogHeader>
          <div className="overflow-y-auto px-4 pb-6 space-y-5">
            {productView?.image_url ? (
              <img
                src={imageUrl(productView.image_url) ?? undefined}
                alt={productView.name}
                className="w-full max-h-[60vh] rounded-lg object-contain bg-secondary"
                data-testid="img-product-full"
              />
            ) : (
              <div className="w-full aspect-square rounded-lg bg-secondary flex items-center justify-center">
                <Package size={48} className="text-muted-foreground opacity-50" />
              </div>
            )}
            {productView &&
              (productView.description ||
                productView.custom_input ||
                productView.recipe.length > 0) && (
                <div className="space-y-2">
                  {productView.recipe.length > 0 && (
                    <div
                      className="flex items-center justify-between gap-2"
                      data-testid="pane-indicator"
                    >
                      <div className="flex items-center gap-1.5">
                        {[0, 1].map((i) => (
                          <button
                            key={i}
                            type="button"
                            onClick={() => goToPane(i)}
                            aria-label={
                              i === 0
                                ? t("floristOrders.paneDescription")
                                : t("floristOrders.recipeTitle")
                            }
                            aria-current={activePane === i}
                            className={`h-2 rounded-full transition-all ${
                              activePane === i
                                ? "w-5 bg-primary"
                                : "w-2 bg-muted-foreground/30"
                            }`}
                            data-testid={`button-pane-dot-${i}`}
                          />
                        ))}
                      </div>
                      <button
                        type="button"
                        onClick={() => goToPane(activePane === 0 ? 1 : 0)}
                        className="text-xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                        data-testid="button-pane-toggle"
                      >
                        {activePane === 0
                          ? t("floristOrders.swipeForBaseItems")
                          : t("floristOrders.swipeForDescription")}
                      </button>
                    </div>
                  )}
                  <div
                    ref={pagerRef}
                    onScroll={handlePagerScroll}
                    className="flex overflow-x-auto snap-x snap-mandatory scroll-smooth [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                    data-testid="product-pager"
                  >
                    <div
                      className="w-full shrink-0 snap-start space-y-3 pe-1"
                      data-testid="pane-description"
                    >
                      {productView.description ? (
                        <p
                          className="text-sm text-muted-foreground whitespace-pre-wrap"
                          data-testid="text-product-description"
                        >
                          {isArabic && productView.description_ar
                            ? productView.description_ar
                            : productView.description}
                        </p>
                      ) : null}
                      {productView.custom_input && (
                        <p className="text-sm text-muted-foreground">
                          {productView.custom_input}
                        </p>
                      )}
                    </div>
                    {productView.recipe.length > 0 && (
                      <div
                        className="w-full shrink-0 snap-start space-y-3 pe-1"
                        data-testid="pane-recipe"
                      >
                        <h3 className="font-semibold text-sm uppercase tracking-wide text-muted-foreground">
                          {t("floristOrders.recipeTitle")}
                        </h3>
                        <ul className="space-y-2" data-testid="list-recipe">
                          {productView.recipe.map((entry, idx) => (
                            <li
                              key={idx}
                              className="flex items-center gap-3 rounded-lg border p-2"
                              data-testid={`recipe-entry-${idx}`}
                            >
                              {entry.base_item_image_url ? (
                                <img
                                  src={
                                    imageUrl(entry.base_item_image_url) ??
                                    undefined
                                  }
                                  alt={entry.base_item_name}
                                  className="w-12 h-12 rounded object-cover shrink-0"
                                  loading="lazy"
                                />
                              ) : (
                                <span className="w-12 h-12 rounded bg-secondary flex items-center justify-center shrink-0">
                                  <Package
                                    size={16}
                                    className="text-muted-foreground"
                                  />
                                </span>
                              )}
                              <span className="flex-1 min-w-0 text-sm font-medium truncate">
                                {entry.base_item_name}
                              </span>
                              <span className="text-sm text-muted-foreground shrink-0">
                                ×{formatQuantity(entry.quantity)}
                              </span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                </div>
              )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
