import { useState, useCallback } from "react";

export type NewOrderNotification = {
  id: string;
  orderId: string;
  displayOrderNumber: string | null;
  customerName: string | null;
  total: number | null;
  currency: string | null;
  /** "created" (default) = new order; "assigned" = sent to the user's florist location. */
  kind?: "created" | "assigned";
  receivedAt: string;
};

/**
 * Session-scoped store for new-order SSE events.
 * Notifications live in React state — they are cleared on page refresh.
 * Consumers call `addNotification` whenever an order.created SSE event arrives.
 */
export function useNewOrderNotifications() {
  const [notifications, setNotifications] = useState<NewOrderNotification[]>([]);
  const [seenIds, setSeenIds] = useState<Set<string>>(new Set());

  const addNotification = useCallback(
    (payload: {
      orderId: string;
      displayOrderNumber: string | null;
      customerName: string | null;
      total: number | null;
      currency: string | null;
      kind?: "created" | "assigned";
      /** Per-assignment marker (assigned kind) so re-assignments aren't deduped away. */
      assignedAt?: string | null;
    }) => {
      setNotifications((prev) => {
        const kind = payload.kind ?? "created";
        const id =
          kind === "assigned"
            ? `assigned:${payload.orderId}:${payload.assignedAt ?? ""}`
            : payload.orderId;
        const already = prev.some((n) => n.id === id);
        if (already) return prev;
        return [
          { ...payload, id, receivedAt: new Date().toISOString() },
          ...prev,
        ];
      });
    },
    [],
  );

  const markSeen = useCallback((ids: string[]) => {
    setSeenIds((prev) => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
  }, []);

  const dismiss = useCallback((id: string) => {
    setNotifications((prev) => prev.filter((n) => n.id !== id));
  }, []);

  const dismissAll = useCallback(() => {
    setNotifications([]);
    setSeenIds(new Set());
  }, []);

  return { notifications, seenIds, addNotification, markSeen, dismiss, dismissAll };
}
