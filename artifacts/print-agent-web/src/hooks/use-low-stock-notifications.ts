import { useState, useCallback } from "react";

export type LowStockNotification = {
  id: string;
  itemName: string;
  locationName: string;
  currentStock: number;
  baseItemId: number;
  receivedAt: string;
};

let _counter = 0;
function nextId(): string {
  return `ls-${Date.now()}-${++_counter}`;
}

/**
 * Session-scoped store for low-stock SSE events.
 * Notifications live in React state — they are cleared on page refresh.
 * Consumers call `addNotification` whenever a low_stock SSE event arrives.
 */
export function useLowStockNotifications() {
  const [notifications, setNotifications] = useState<LowStockNotification[]>([]);
  const [seenIds, setSeenIds] = useState<Set<string>>(new Set());

  const addNotification = useCallback(
    (payload: { itemName: string; locationName: string; currentStock: number; baseItemId: number }) => {
      setNotifications((prev) => {
        const already = prev.some(
          (n) => n.itemName === payload.itemName && n.locationName === payload.locationName,
        );
        if (already) return prev;
        return [
          { ...payload, id: nextId(), receivedAt: new Date().toISOString() },
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
