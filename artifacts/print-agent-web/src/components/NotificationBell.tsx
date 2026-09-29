import { useState } from "react";
import { Bell, Check, CheckCheck, CalendarDays, FileEdit, Loader2, PackageOpen, ShoppingCart } from "lucide-react";
import { useLocation } from "wouter";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { TimeOffNotification } from "@/hooks/use-time-off-notifications";
import { getTimeOffNotificationsQueryKey } from "@/hooks/use-time-off-notifications";
import type { AttendanceCorrectionRequest } from "@/hooks/use-attendance-correction-notifications";
import type { LowStockNotification } from "@/hooks/use-low-stock-notifications";
import type { NewOrderNotification } from "@/hooks/use-new-order-notifications";
import type { CashSessionAlertNotification } from "@/hooks/use-cash-session-notifications";
import type { SalaryDecisionNotification } from "@/hooks/use-salary-approval-notifications";
import { orderDetailPath } from "@/lib/orderLink";
import {
  useReviewTimeOffRequest,
  getGetTimeOffBalanceQueryKey,
  getListTimeOffRequestsQueryKey,
} from "@workspace/api-client-react";

type AccessRequest = {
  id: number;
  requester_name: string;
  requester_email: string;
  requested_at: string;
};

const REQUEST_TYPE_LABELS: Record<string, string> = {
  missed_clock_in: "Missed Clock-In",
  missed_clock_out: "Missed Clock-Out",
  edit_clock_in: "Edit Clock-In",
  edit_clock_out: "Edit Clock-Out",
  offsite_clock_in: "Offsite Clock-In",
  offsite_clock_out: "Offsite Clock-Out",
  other: "Other",
};

interface NotificationBellProps {
  requests: AccessRequest[];
  timeOffNotifications?: TimeOffNotification[];
  correctionRequests?: AttendanceCorrectionRequest[];
  correctionSeenIds?: Set<number>;
  onMarkCorrectionSeen?: (ids: number[]) => void;
  lowStockNotifications?: LowStockNotification[];
  lowStockSeenIds?: Set<string>;
  onMarkLowStockSeen?: (ids: string[]) => void;
  onDismissLowStock?: (id: string) => void;
  onDismissAllLowStock?: () => void;
  newOrderNotifications?: NewOrderNotification[];
  newOrderSeenIds?: Set<string>;
  onMarkNewOrderSeen?: (ids: string[]) => void;
  onDismissNewOrder?: (id: string) => void;
  onDismissAllNewOrders?: () => void;
  cashSessionNotifications?: CashSessionAlertNotification[];
  cashSessionSeenIds?: Set<string>;
  onMarkCashSessionSeen?: (ids: string[]) => void;
  onDismissCashSession?: (id: string) => void;
  onDismissAllCashSessions?: () => void;
  /** Approved/declined salary expense decisions for the current requester. */
  salaryDecisionNotifications?: SalaryDecisionNotification[];
  /** Acknowledge (dismiss) salary decision notifications server-side. */
  onAckSalaryDecisions?: (ids: number[]) => void;
  isLoading?: boolean;
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.floor(diffH / 24);
  return `${diffD}d ago`;
}

function formatOrderTotal(
  total: number | null,
  currency: string | null,
  locale: string,
): string | null {
  if (total == null || Number.isNaN(total)) return null;
  if (currency) {
    try {
      return new Intl.NumberFormat(locale, {
        style: "currency",
        currency,
        minimumFractionDigits: 2,
      }).format(total);
    } catch {
      return `${total.toFixed(2)} ${currency}`.trim();
    }
  }
  return total.toFixed(2);
}

const SEEN_IDS_KEY = ["notification-seen-ids"];
const LS_SEEN_KEY = "notification_seen_ids";

function readSeenIdsFromStorage(): Set<number> {
  try {
    const raw = localStorage.getItem(LS_SEEN_KEY);
    if (!raw) return new Set();
    return new Set(JSON.parse(raw) as number[]);
  } catch {
    return new Set();
  }
}

function writeSeenIdsToStorage(ids: Set<number>): void {
  try {
    localStorage.setItem(LS_SEEN_KEY, JSON.stringify([...ids]));
  } catch {}
}

export function NotificationBell({
  requests,
  timeOffNotifications = [],
  correctionRequests = [],
  correctionSeenIds = new Set(),
  onMarkCorrectionSeen,
  lowStockNotifications = [],
  lowStockSeenIds = new Set(),
  onMarkLowStockSeen,
  onDismissLowStock,
  onDismissAllLowStock,
  newOrderNotifications = [],
  newOrderSeenIds = new Set(),
  onMarkNewOrderSeen,
  onDismissNewOrder,
  onDismissAllNewOrders,
  cashSessionNotifications = [],
  cashSessionSeenIds = new Set(),
  onMarkCashSessionSeen,
  onDismissCashSession,
  onDismissAllCashSessions,
  salaryDecisionNotifications = [],
  onAckSalaryDecisions,
  isLoading = false,
}: NotificationBellProps) {
  const { t, i18n } = useTranslation();
  const [, navigate] = useLocation();
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [pendingActionId, setPendingActionId] = useState<number | null>(null);
  const [pendingReview, setPendingReview] = useState<{
    notifId: number;
    status: "APPROVED" | "DECLINED";
    note: string;
  } | null>(null);

  const { mutateAsync: reviewRequest } = useReviewTimeOffRequest();

  const { data: seenData } = useQuery<{ seenIds: number[] }>({
    queryKey: SEEN_IDS_KEY,
    queryFn: () => apiFetch("/api/notifications/seen"),
    staleTime: 60_000,
  });

  const [localSeenIds, setLocalSeenIds] = useState<Set<number>>(readSeenIdsFromStorage);
  const [localSeenTimeOffIds, setLocalSeenTimeOffIds] = useState<Set<number>>(new Set());

  const serverSeenIds = new Set(seenData?.seenIds ?? []);
  const seenIds = new Set([...serverSeenIds, ...localSeenIds]);

  // Seed from server is_read flag so the badge stays clear after navigation.
  const serverReadTimeOffIds = new Set(
    timeOffNotifications.filter((n) => n.is_read).map((n) => n.id),
  );
  const effectiveSeenTimeOffIds = new Set([...serverReadTimeOffIds, ...localSeenTimeOffIds]);

  const markSeenMutation = useMutation({
    mutationFn: (ids: number[]) =>
      apiFetch("/api/notifications/seen", {
        method: "POST",
        body: JSON.stringify({ ids }),
      }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: SEEN_IDS_KEY });
    },
  });

  const markTimeOffSeenMutation = useMutation({
    mutationFn: (ids: number[]) =>
      apiFetch("/api/time-off/notifications/seen", {
        method: "POST",
        body: JSON.stringify({ ids }),
      }),
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: getTimeOffNotificationsQueryKey() });
    },
  });

  const markIds = (ids: number[]) => {
    const unseen = ids.filter((id) => !seenIds.has(id));
    if (unseen.length === 0) return;
    setLocalSeenIds((prev) => {
      const next = new Set(prev);
      for (const id of unseen) next.add(id);
      writeSeenIdsToStorage(next);
      return next;
    });
    markSeenMutation.mutate(unseen);
  };

  const markTimeOffIds = (ids: number[]) => {
    const unseen = ids.filter((id) => !effectiveSeenTimeOffIds.has(id));
    if (unseen.length === 0) return;
    setLocalSeenTimeOffIds((prev) => {
      const next = new Set(prev);
      for (const id of unseen) next.add(id);
      return next;
    });
    markTimeOffSeenMutation.mutate(unseen);
  };

  const markOneAsRead = (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    markIds([id]);
  };

  const markOneTimeOffAsRead = (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    markTimeOffIds([id]);
  };

  // A time-off notification is "actionable" when it represents a pending review
  // request (TIME_OFF_REQUEST with a valid entity_id). These render inline
  // Approve/Deny buttons, so we must NOT auto-mark them read on bell open or via
  // "mark all" — they should only clear after the manager actually acts on them
  // (the PATCH /time-off/requests/:id/status route marks them read on success).
  const isActionableTimeOff = (n: { type: string; entity_id: number | null }) =>
    n.type === "TIME_OFF_REQUEST" && n.entity_id != null;

  const nonActionableTimeOffIds = timeOffNotifications
    .filter((n) => !isActionableTimeOff(n))
    .map((n) => n.id);

  const markAllAsRead = (e: React.MouseEvent) => {
    e.stopPropagation();
    markIds(requests.map((r) => r.id));
    if (nonActionableTimeOffIds.length > 0) markTimeOffIds(nonActionableTimeOffIds);
    if (correctionRequests.length > 0 && onMarkCorrectionSeen) {
      onMarkCorrectionSeen(correctionRequests.map((r) => r.id));
    }
    if (lowStockNotifications.length > 0 && onDismissAllLowStock) {
      onDismissAllLowStock();
    }
    if (newOrderNotifications.length > 0 && onMarkNewOrderSeen) {
      onMarkNewOrderSeen(newOrderNotifications.map((n) => n.id));
    }
    if (cashSessionNotifications.length > 0 && onMarkCashSessionSeen) {
      onMarkCashSessionSeen(cashSessionNotifications.map((n) => n.id));
    }
    if (salaryDecisionNotifications.length > 0 && onAckSalaryDecisions) {
      onAckSalaryDecisions(salaryDecisionNotifications.map((n) => n.id));
    }
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      if (requests.length > 0) markIds(requests.map((r) => r.id));
      if (nonActionableTimeOffIds.length > 0) markTimeOffIds(nonActionableTimeOffIds);
      if (correctionRequests.length > 0 && onMarkCorrectionSeen) {
        onMarkCorrectionSeen(correctionRequests.map((r) => r.id));
      }
      const unseenLowStockIds = lowStockNotifications
        .filter((n) => !lowStockSeenIds.has(n.id))
        .map((n) => n.id);
      if (unseenLowStockIds.length > 0 && onMarkLowStockSeen) {
        onMarkLowStockSeen(unseenLowStockIds);
      }
      const unseenNewOrderIds = newOrderNotifications
        .filter((n) => !newOrderSeenIds.has(n.id))
        .map((n) => n.id);
      if (unseenNewOrderIds.length > 0 && onMarkNewOrderSeen) {
        onMarkNewOrderSeen(unseenNewOrderIds);
      }
      const unseenCashSessionIds = cashSessionNotifications
        .filter((n) => !cashSessionSeenIds.has(n.id))
        .map((n) => n.id);
      if (unseenCashSessionIds.length > 0 && onMarkCashSessionSeen) {
        onMarkCashSessionSeen(unseenCashSessionIds);
      }
    }
    setOpen(nextOpen);
  };

  const handleNavigateToUsers = () => {
    setOpen(false);
    navigate("/users");
  };

  const handleNavigateToTimeOff = () => {
    setOpen(false);
    navigate("/time-off/my");
  };

  const handleNavigateToTimeOffApprovals = () => {
    setOpen(false);
    navigate("/time-off/approvals");
  };

  const handleNavigateToCorrectionRequests = () => {
    setOpen(false);
    navigate("/admin/attendance/requests");
  };

  const handleStartReview = (
    notif: TimeOffNotification,
    status: "APPROVED" | "DECLINED",
    e: React.MouseEvent,
  ) => {
    e.stopPropagation();
    if (notif.entity_id == null || pendingActionId !== null) return;
    setPendingReview({ notifId: notif.id, status, note: "" });
  };

  const handleCancelReview = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (pendingActionId !== null) return;
    setPendingReview(null);
  };

  const handleConfirmReview = async (
    notif: TimeOffNotification,
    e: React.MouseEvent,
  ) => {
    e.stopPropagation();
    if (notif.entity_id == null || pendingActionId !== null) return;
    if (!pendingReview || pendingReview.notifId !== notif.id) return;
    const status = pendingReview.status;
    const trimmed = pendingReview.note.trim();
    const managerNote = trimmed.length > 0 ? trimmed : null;
    setPendingActionId(notif.id);
    try {
      await reviewRequest({
        id: notif.entity_id,
        data: { status, managerNote },
      });
      // The server marks the notification as read; refresh manager bell + balances + history.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getTimeOffNotificationsQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetTimeOffBalanceQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getListTimeOffRequestsQueryKey() }),
      ]);
      toast({
        title: status === "APPROVED" ? t("notifications.timeOffApproved") : t("notifications.timeOffDeclined"),
        description: notif.title,
      });
    } catch (err) {
      const status = (err as Error & { status?: number }).status;
      if (status === 409 || status === 404) {
        toast({
          title: t("notifications.timeOffRequestCancelled"),
          description: t("notifications.timeOffRequestCancelledHint"),
        });
        markTimeOffIds([notif.id]);
        await queryClient.invalidateQueries({ queryKey: getTimeOffNotificationsQueryKey() });
      } else {
        toast({
          title: t("notifications.timeOffActionFailed"),
          description: t("notifications.timeOffActionFailedHint"),
          variant: "destructive",
        });
      }
    } finally {
      setPendingActionId(null);
    }
  };

  const accessUnreadCount = requests.filter((r) => !seenIds.has(r.id)).length;
  const timeOffUnreadCount = timeOffNotifications.filter((n) => !effectiveSeenTimeOffIds.has(n.id)).length;
  const correctionUnreadCount = correctionRequests.filter((r) => !correctionSeenIds.has(r.id)).length;
  const lowStockUnreadCount = lowStockNotifications.filter((n) => !lowStockSeenIds.has(n.id)).length;
  const newOrderUnreadCount = newOrderNotifications.filter((n) => !newOrderSeenIds.has(n.id)).length;
  const cashSessionUnreadCount = cashSessionNotifications.filter((n) => !cashSessionSeenIds.has(n.id)).length;
  // Salary decisions stay until acknowledged, so every one shown is unread.
  const salaryDecisionUnreadCount = salaryDecisionNotifications.length;
  const unreadCount = accessUnreadCount + timeOffUnreadCount + correctionUnreadCount + lowStockUnreadCount + newOrderUnreadCount + cashSessionUnreadCount + salaryDecisionUnreadCount;
  const hasUnread = unreadCount > 0;
  const totalCount = requests.length + timeOffNotifications.length + correctionRequests.length + lowStockNotifications.length + newOrderNotifications.length + cashSessionNotifications.length + salaryDecisionNotifications.length;

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative h-8 w-8 rounded-full"
          aria-label={t("notifications.label")}
          data-testid="notification-bell"
        >
          <Bell size={18} />
          {unreadCount > 0 && (
            <span
              className={cn(
                "absolute -top-0.5 -right-0.5 min-w-[1.1rem] h-[1.1rem] px-0.5",
                "rounded-full bg-destructive text-destructive-foreground",
                "text-[10px] font-semibold flex items-center justify-center leading-none",
              )}
              data-testid="notification-badge"
            >
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="w-80">
        <div className="flex items-center justify-between px-2 py-1.5">
          <DropdownMenuLabel className="font-semibold text-sm p-0">
            {t("notifications.title")}
          </DropdownMenuLabel>
          {hasUnread && (
            <button
              className="text-xs text-primary flex items-center gap-1 hover:underline focus:outline-none"
              onClick={markAllAsRead}
              data-testid="notification-mark-all-read"
            >
              <CheckCheck size={13} />
              {t("notifications.markAllAsRead")}
            </button>
          )}
        </div>
        <DropdownMenuSeparator />

        {isLoading && totalCount === 0 ? (
          <div className="py-2 px-2 space-y-2" data-testid="notification-skeleton">
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-start gap-2 px-1 py-1.5 animate-pulse">
                <div className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-muted" />
                <div className="flex flex-col gap-1.5 flex-1">
                  <div className="h-3 rounded bg-muted w-3/4" />
                  <div className="h-2.5 rounded bg-muted w-1/3" />
                </div>
              </div>
            ))}
          </div>
        ) : totalCount === 0 ? (
          <div className="py-6 text-center text-sm text-muted-foreground">
            {t("notifications.empty")}
          </div>
        ) : (
          <>
            {/* Access request notifications */}
            {requests.map((req) => {
              const isUnread = !seenIds.has(req.id);
              return (
                <DropdownMenuItem
                  key={`ar-${req.id}`}
                  className="flex items-start gap-2 py-2 cursor-pointer group"
                  onClick={handleNavigateToUsers}
                  data-testid="notification-item"
                >
                  {isUnread && (
                    <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" />
                  )}
                  <div
                    className={cn(
                      "flex flex-col gap-0.5 flex-1 min-w-0",
                      !isUnread && "pl-4",
                    )}
                  >
                    <span className="text-sm font-medium leading-snug">
                      {t("notifications.accessRequest", {
                        name: req.requester_name || req.requester_email,
                      })}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {formatRelativeTime(req.requested_at)}
                    </span>
                  </div>
                  {isUnread && (
                    <button
                      className={cn(
                        "shrink-0 rounded p-0.5 text-muted-foreground",
                        "opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity",
                        "hover:text-foreground hover:bg-accent focus:outline-none",
                      )}
                      title={t("notifications.markAsRead")}
                      aria-label={t("notifications.markAsRead")}
                      onClick={(e) => markOneAsRead(req.id, e)}
                      data-testid="notification-mark-read"
                    >
                      <Check size={13} />
                    </button>
                  )}
                </DropdownMenuItem>
              );
            })}

            {/* Time-off notifications (for managers) */}
            {timeOffNotifications.map((notif) => {
              const isUnread = !effectiveSeenTimeOffIds.has(notif.id);
              const isTimeOffRequest =
                notif.type === "TIME_OFF_REQUEST" && notif.entity_id != null;
              const isPending = pendingActionId === notif.id;
              const isAwaitingConfirm =
                pendingReview?.notifId === notif.id;
              return (
                <DropdownMenuItem
                  key={`to-${notif.id}`}
                  className="flex flex-col items-stretch gap-1.5 py-2 cursor-pointer group"
                  onClick={isTimeOffRequest ? handleNavigateToTimeOffApprovals : handleNavigateToTimeOff}
                  onSelect={(e) => {
                    // Prevent the menu from auto-closing when interacting with the action buttons.
                    if (isTimeOffRequest) e.preventDefault();
                  }}
                  data-testid="notification-item-time-off"
                >
                  <div className="flex items-start gap-2">
                    {isUnread && (
                      <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" />
                    )}
                    <div
                      className={cn(
                        "flex flex-col gap-0.5 flex-1 min-w-0",
                        !isUnread && "pl-4",
                      )}
                    >
                      <div className="flex items-center gap-1.5">
                        <CalendarDays size={12} className="text-muted-foreground shrink-0" />
                        <span className="text-sm font-medium leading-snug truncate">{notif.title}</span>
                      </div>
                      <span className="text-xs text-muted-foreground leading-snug">{notif.body}</span>
                      <span className="text-xs text-muted-foreground leading-snug">
                        <span className="font-medium text-foreground">
                          {notif.actor_name || notif.actor_email}
                        </span>
                        {notif.actor_name && (
                          <span className="ml-1">({notif.actor_email})</span>
                        )}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {formatRelativeTime(notif.created_at)}
                      </span>
                    </div>
                    {isUnread && !isTimeOffRequest && (
                      <button
                        className={cn(
                          "shrink-0 rounded p-0.5 text-muted-foreground",
                          "opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity",
                          "hover:text-foreground hover:bg-accent focus:outline-none",
                        )}
                        title={t("notifications.markAsRead")}
                        aria-label={t("notifications.markAsRead")}
                        onClick={(e) => markOneTimeOffAsRead(notif.id, e)}
                        data-testid="notification-mark-read-time-off"
                      >
                        <Check size={13} />
                      </button>
                    )}
                  </div>
                  {isTimeOffRequest && !isAwaitingConfirm && (
                    <div className={cn("flex items-center gap-2", !isUnread ? "pl-4" : "pl-4")}>
                      <Button
                        size="sm"
                        variant="default"
                        className="h-7 px-2.5 text-xs flex-1"
                        disabled={pendingActionId !== null}
                        onClick={(e) => handleStartReview(notif, "APPROVED", e)}
                        data-testid={`notification-approve-${notif.id}`}
                      >
                        {t("notifications.approve")}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2.5 text-xs flex-1 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                        disabled={pendingActionId !== null}
                        onClick={(e) => handleStartReview(notif, "DECLINED", e)}
                        data-testid={`notification-deny-${notif.id}`}
                      >
                        {t("notifications.deny")}
                      </Button>
                    </div>
                  )}
                  {isTimeOffRequest && isAwaitingConfirm && pendingReview && (
                    <div className={cn("flex flex-col gap-1.5 pl-4")}
                      onClick={(e) => e.stopPropagation()}
                    >
                      <textarea
                        rows={2}
                        maxLength={1000}
                        value={pendingReview.note}
                        onChange={(e) =>
                          setPendingReview((prev) =>
                            prev && prev.notifId === notif.id
                              ? { ...prev, note: e.target.value }
                              : prev,
                          )
                        }
                        placeholder={t("notifications.noteOptionalPlaceholder")}
                        disabled={isPending}
                        className="w-full rounded-md border border-input bg-background px-2 py-1 text-xs resize-none focus:outline-none focus:ring-1 focus:ring-ring"
                        data-testid={`notification-note-${notif.id}`}
                      />
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant={
                            pendingReview.status === "APPROVED" ? "default" : "outline"
                          }
                          className={cn(
                            "h-7 px-2.5 text-xs flex-1",
                            pendingReview.status === "DECLINED" &&
                              "border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive",
                          )}
                          disabled={isPending}
                          onClick={(e) => handleConfirmReview(notif, e)}
                          data-testid={`notification-confirm-${notif.id}`}
                        >
                          {isPending ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : (
                            t("notifications.confirm")
                          )}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2.5 text-xs flex-1"
                          disabled={isPending}
                          onClick={handleCancelReview}
                          data-testid={`notification-cancel-${notif.id}`}
                        >
                          {t("notifications.cancel")}
                        </Button>
                      </div>
                    </div>
                  )}
                </DropdownMenuItem>
              );
            })}

            {/* Attendance correction request notifications (for owners/managers) */}
            {correctionRequests.map((req) => {
              const isUnread = !correctionSeenIds.has(req.id);
              return (
                <DropdownMenuItem
                  key={`acr-${req.id}`}
                  className="flex items-start gap-2 py-2 cursor-pointer group"
                  onClick={handleNavigateToCorrectionRequests}
                  data-testid="notification-item-correction"
                >
                  {isUnread && (
                    <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" />
                  )}
                  <div
                    className={cn(
                      "flex flex-col gap-0.5 flex-1 min-w-0",
                      !isUnread && "pl-4",
                    )}
                  >
                    <div className="flex items-center gap-1.5">
                      <FileEdit size={12} className="text-muted-foreground shrink-0" />
                      <span className="text-sm font-medium leading-snug truncate">
                        {req.employee_name ?? `Employee #${req.employee_id}`} — {REQUEST_TYPE_LABELS[req.request_type] ?? req.request_type}
                      </span>
                    </div>
                    {req.reason && (
                      <span className="text-xs text-muted-foreground leading-snug truncate">
                        {req.reason}
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground">
                      {formatRelativeTime(req.created_at)}
                    </span>
                  </div>
                  {isUnread && onMarkCorrectionSeen && (
                    <button
                      className={cn(
                        "shrink-0 rounded p-0.5 text-muted-foreground",
                        "opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity",
                        "hover:text-foreground hover:bg-accent focus:outline-none",
                      )}
                      title={t("notifications.markAsRead")}
                      aria-label={t("notifications.markAsRead")}
                      onClick={(e) => {
                        e.stopPropagation();
                        onMarkCorrectionSeen([req.id]);
                      }}
                      data-testid="notification-mark-read-correction"
                    >
                      <Check size={13} />
                    </button>
                  )}
                </DropdownMenuItem>
              );
            })}

            {/* Low stock notifications */}
            {lowStockNotifications.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <div className="flex items-center justify-between px-3 py-1">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {t("notifications.lowStockTitle")}
                  </span>
                  {onDismissAllLowStock && (
                    <button
                      className="text-[10px] text-primary hover:underline focus:outline-none"
                      onClick={(e) => { e.stopPropagation(); onDismissAllLowStock(); }}
                      data-testid="notification-low-stock-dismiss-all"
                    >
                      {t("notifications.lowStockDismissAll")}
                    </button>
                  )}
                </div>
                {lowStockNotifications.map((notif) => {
                  const units = notif.currentStock === 1
                    ? t("notifications.lowStockUnit")
                    : t("notifications.lowStockUnits");
                  return (
                    <DropdownMenuItem
                      key={notif.id}
                      className="flex items-start gap-2 py-2 cursor-pointer group"
                      onClick={() => { setOpen(false); navigate(`/base-items/${notif.baseItemId}`); }}
                      data-testid="notification-item-low-stock"
                    >
                      <span className="mt-1 text-amber-500 shrink-0">
                        <PackageOpen size={14} />
                      </span>
                      <div className="flex flex-col gap-0.5 flex-1 min-w-0">
                        <span className="text-sm font-medium leading-snug truncate">
                          {notif.itemName}
                        </span>
                        <span className="text-xs text-muted-foreground leading-snug">
                          {t("notifications.lowStockDescription", {
                            location: notif.locationName,
                            count: notif.currentStock,
                            unit: units,
                          })}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {formatRelativeTime(notif.receivedAt)}
                        </span>
                      </div>
                      {onDismissLowStock && (
                        <button
                          className={cn(
                            "shrink-0 rounded p-0.5 text-muted-foreground",
                            "opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity",
                            "hover:text-foreground hover:bg-accent focus:outline-none",
                          )}
                          title={t("notifications.lowStockDismiss")}
                          aria-label={t("notifications.lowStockDismiss")}
                          onClick={(e) => { e.stopPropagation(); onDismissLowStock(notif.id); }}
                          data-testid="notification-low-stock-dismiss"
                        >
                          <Check size={13} />
                        </button>
                      )}
                    </DropdownMenuItem>
                  );
                })}
              </>
            )}

            {/* New order notifications */}
            {newOrderNotifications.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <div className="flex items-center justify-between px-3 py-1">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {t("notifications.newOrderSectionTitle")}
                  </span>
                  {onDismissAllNewOrders && (
                    <button
                      className="text-[10px] text-primary hover:underline focus:outline-none"
                      onClick={(e) => { e.stopPropagation(); onDismissAllNewOrders(); }}
                      data-testid="notification-new-order-dismiss-all"
                    >
                      {t("notifications.newOrderDismissAll")}
                    </button>
                  )}
                </div>
                {newOrderNotifications.map((notif) => {
                  const orderNumber = notif.displayOrderNumber || notif.orderId;
                  const totalText = formatOrderTotal(notif.total, notif.currency, i18n.language);
                  const descParts = [notif.customerName, totalText].filter(Boolean) as string[];
                  const isAssigned = notif.kind === "assigned";
                  return (
                    <DropdownMenuItem
                      key={notif.id}
                      className="flex items-start gap-2 py-2 cursor-pointer group"
                      onClick={() => {
                        setOpen(false);
                        if (isAssigned) {
                          navigate("/florist-orders");
                        } else {
                          navigate(`/orders/${notif.orderId}`);
                        }
                      }}
                      data-testid="notification-item-new-order"
                    >
                      <span className="mt-1 text-emerald-500 shrink-0">
                        <ShoppingCart size={14} />
                      </span>
                      <div className="flex flex-col gap-0.5 flex-1 min-w-0">
                        <span className="text-sm font-medium leading-snug truncate">
                          {isAssigned
                            ? t("notifications.floristAssignedBellTitle", { number: orderNumber })
                            : t("notifications.newOrderBellTitle", { number: orderNumber })}
                        </span>
                        {descParts.length > 0 && (
                          <span className="text-xs text-muted-foreground leading-snug truncate">
                            {descParts.join(" · ")}
                          </span>
                        )}
                        <span className="text-xs text-muted-foreground">
                          {formatRelativeTime(notif.receivedAt)}
                        </span>
                      </div>
                      {onDismissNewOrder && (
                        <button
                          className={cn(
                            "shrink-0 rounded p-0.5 text-muted-foreground",
                            "opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity",
                            "hover:text-foreground hover:bg-accent focus:outline-none",
                          )}
                          title={t("notifications.newOrderDismiss")}
                          aria-label={t("notifications.newOrderDismiss")}
                          onClick={(e) => { e.stopPropagation(); onDismissNewOrder(notif.id); }}
                          data-testid="notification-new-order-dismiss"
                        >
                          <Check size={13} />
                        </button>
                      )}
                    </DropdownMenuItem>
                  );
                })}
              </>
            )}

            {/* Cash session alert notifications */}
            {salaryDecisionNotifications.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
                  {t("notifications.salaryDecisionsSection", "Salary expense requests")}
                </DropdownMenuLabel>
                {salaryDecisionNotifications.map((notif) => {
                  const approved = notif.approval_status === "confirmed";
                  const currency = notif.transaction_currency ?? notif.currency;
                  return (
                    <DropdownMenuItem
                      key={`salary-${notif.id}`}
                      className="group flex items-start gap-2 py-2 cursor-pointer"
                      onClick={() => {
                        setOpen(false);
                        if (notif.cash_session_id != null) navigate(`/cash-sessions/${notif.cash_session_id}`);
                      }}
                      data-testid={`notification-item-salary-decision-${notif.id}`}
                    >
                      <span className={cn("mt-1 shrink-0", approved ? "text-emerald-600" : "text-destructive")}>
                        {approved ? "✅" : "❌"}
                      </span>
                      <div className="flex flex-col gap-0.5 flex-1 min-w-0">
                        <span className="text-sm font-medium leading-snug">
                          {approved
                            ? t("notifications.salaryApprovedBellTitle", "Your salary expense request for {{payee}}, {{amount}} was approved", { payee: notif.payee ?? "—", amount: `${notif.amount} ${currency}` })
                            : t("notifications.salaryDeclinedBellTitle", "Your salary expense request for {{payee}}, {{amount}} was declined", { payee: notif.payee ?? "—", amount: `${notif.amount} ${currency}` })}
                        </span>
                        {!approved && notif.approval_decline_reason && (
                          <span className="text-xs text-muted-foreground truncate">
                            {notif.approval_decline_reason}
                          </span>
                        )}
                        {notif.approval_decided_at && (
                          <span className="text-xs text-muted-foreground">
                            {formatRelativeTime(notif.approval_decided_at)}
                          </span>
                        )}
                      </div>
                      {onAckSalaryDecisions && (
                        <button
                          className={cn(
                            "shrink-0 rounded p-0.5 text-muted-foreground",
                            "opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity",
                            "hover:text-foreground hover:bg-accent focus:outline-none",
                          )}
                          title={t("notifications.salaryDecisionDismiss", "Dismiss")}
                          aria-label={t("notifications.salaryDecisionDismiss", "Dismiss")}
                          onClick={(e) => { e.stopPropagation(); onAckSalaryDecisions([notif.id]); }}
                          data-testid={`notification-salary-decision-dismiss-${notif.id}`}
                        >
                          <Check size={13} />
                        </button>
                      )}
                    </DropdownMenuItem>
                  );
                })}
              </>
            )}

            {cashSessionNotifications.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <div className="flex items-center justify-between px-3 py-1">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {t("notifications.cashSessionSectionTitle")}
                  </span>
                  {onDismissAllCashSessions && (
                    <button
                      className="text-[10px] text-primary hover:underline focus:outline-none"
                      onClick={(e) => { e.stopPropagation(); onDismissAllCashSessions(); }}
                      data-testid="notification-cash-session-dismiss-all"
                    >
                      {t("notifications.cashSessionDismissAll")}
                    </button>
                  )}
                </div>
                {cashSessionNotifications.map((notif) => {
                  const isFlagged = notif.kind === "flagged";
                  const label = notif.drawerName ?? notif.sessionNumber;
                  return (
                    <DropdownMenuItem
                      key={notif.id}
                      className="flex items-start gap-2 py-2 cursor-pointer group"
                      onClick={() => {
                        setOpen(false);
                        navigate("/cash-sessions?status=attention");
                      }}
                      data-testid="notification-item-cash-session"
                    >
                      <span className={cn("mt-1 shrink-0", isFlagged ? "text-destructive" : "text-amber-500")}>
                        {isFlagged ? "🚩" : "⏰"}
                      </span>
                      <div className="flex flex-col gap-0.5 flex-1 min-w-0">
                        <span className="text-sm font-medium leading-snug truncate">
                          {isFlagged
                            ? t("notifications.cashSessionFlaggedBellTitle", { label })
                            : t("notifications.cashSessionLongOpenBellTitle", { label })}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {formatRelativeTime(notif.receivedAt)}
                        </span>
                      </div>
                      {onDismissCashSession && (
                        <button
                          className={cn(
                            "shrink-0 rounded p-0.5 text-muted-foreground",
                            "opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity",
                            "hover:text-foreground hover:bg-accent focus:outline-none",
                          )}
                          title={t("notifications.cashSessionDismiss")}
                          aria-label={t("notifications.cashSessionDismiss")}
                          onClick={(e) => { e.stopPropagation(); onDismissCashSession(notif.id); }}
                          data-testid="notification-cash-session-dismiss"
                        >
                          <Check size={13} />
                        </button>
                      )}
                    </DropdownMenuItem>
                  );
                })}
              </>
            )}

            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="justify-center text-xs text-primary cursor-pointer"
              onClick={handleNavigateToUsers}
              data-testid="notification-view-all"
            >
              {t("notifications.viewAll")}
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
