import { useState, useCallback } from "react";

export type CashSessionAlertKind = "flagged" | "long_open" | "overdue";

export type CashSessionAlertNotification = {
  id: string;
  kind: CashSessionAlertKind;
  sessionId: number;
  sessionNumber: string;
  drawerName: string | null;
  locationName: string | null;
  receivedAt: string;
};

/**
 * Session-scoped store for cash-session alert SSE events.
 * Notifications live in React state — cleared on page refresh.
 */
export function useCashSessionNotifications() {
  const [notifications, setNotifications] = useState<CashSessionAlertNotification[]>([]);
  const [seenIds, setSeenIds] = useState<Set<string>>(new Set());

  const addNotification = useCallback(
    (payload: {
      kind: CashSessionAlertKind;
      sessionId: number;
      sessionNumber: string;
      drawerName: string | null;
      locationName?: string | null;
    }) => {
      const id = `${payload.kind}:${payload.sessionId}`;
      setNotifications((prev) => {
        if (prev.some((n) => n.id === id)) return prev;
        return [
          {
            id,
            kind: payload.kind,
            sessionId: payload.sessionId,
            sessionNumber: payload.sessionNumber,
            drawerName: payload.drawerName,
            locationName: payload.locationName ?? null,
            receivedAt: new Date().toISOString(),
          },
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
