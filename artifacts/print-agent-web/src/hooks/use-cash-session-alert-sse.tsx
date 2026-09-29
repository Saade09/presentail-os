import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { useAuthedSse } from "@/hooks/use-authed-sse";
import { useLocation } from "wouter";
import type { CashSessionAlertKind } from "@/hooks/use-cash-session-notifications";

interface CashSessionFlaggedPayload {
  id?: number;
  sessionNumber?: string;
  drawerName?: string | null;
  locationName?: string | null;
  flagReason?: string | null;
}

interface CashSessionLongOpenPayload {
  id?: number;
  sessionNumber?: string;
  drawerName?: string | null;
  locationName?: string | null;
  openedAt?: string | null;
}

export interface CashSessionAlertEvent {
  kind: CashSessionAlertKind;
  sessionId: number;
  sessionNumber: string;
  drawerName: string | null;
  locationName: string | null;
}

/**
 * Listens for `cash_session.flagged` and `cash_session.long_open` SSE events
 * and shows a toast with a link to the Cash Sessions attention filter.
 *
 * @param enabled Pass true for owners and members with cash-session approve access.
 * @param onEvent Optional callback invoked for each new event (after dedup). Use
 *   to push the event into the notification bell store.
 */
export function useCashSessionAlertSse(
  enabled: boolean,
  onEvent?: (event: CashSessionAlertEvent) => void,
): void {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();

  useAuthedSse(
    "/api/events",
    enabled,
    {
      "cash_session.flagged": (data: string) => {
        let outer: { data?: CashSessionFlaggedPayload };
        try {
          outer = JSON.parse(data) as { data?: CashSessionFlaggedPayload };
        } catch {
          return;
        }
        const payload = outer.data;
        if (!payload || !payload.id) return;

        const dedupKey = `cash-session-flagged-seen:${payload.id}`;
        if (sessionStorage.getItem(dedupKey)) return;
        sessionStorage.setItem(dedupKey, "1");

        const event: CashSessionAlertEvent = {
          kind: "flagged",
          sessionId: payload.id,
          sessionNumber: payload.sessionNumber ?? String(payload.id),
          drawerName: payload.drawerName ?? null,
          locationName: payload.locationName ?? null,
        };

        onEvent?.(event);
        void queryClient.invalidateQueries({ predicate: (q) =>
          typeof q.queryKey[0] === "string" &&
          (q.queryKey[0] as string).includes("/cash-sessions"),
        });

        const capturedNavigate = navigate;
        const label = event.drawerName ?? event.sessionNumber;
        toast({
          title: `🚩 ${t("notifications.cashSessionFlaggedTitle")}`,
          description: t("notifications.cashSessionFlaggedBody", { label }),
          duration: 10_000,
          action: (
            <ToastAction
              altText={t("notifications.cashSessionView")}
              onClick={() => capturedNavigate("/cash-sessions?status=attention")}
            >
              {t("notifications.cashSessionView")}
            </ToastAction>
          ),
        });
      },

      "cash_session.long_open": (data: string) => {
        let outer: { data?: CashSessionLongOpenPayload };
        try {
          outer = JSON.parse(data) as { data?: CashSessionLongOpenPayload };
        } catch {
          return;
        }
        const payload = outer.data;
        if (!payload || !payload.id) return;

        const dedupKey = `cash-session-long-open-seen:${payload.id}`;
        if (sessionStorage.getItem(dedupKey)) return;
        sessionStorage.setItem(dedupKey, "1");

        const event: CashSessionAlertEvent = {
          kind: "long_open",
          sessionId: payload.id,
          sessionNumber: payload.sessionNumber ?? String(payload.id),
          drawerName: payload.drawerName ?? null,
          locationName: payload.locationName ?? null,
        };

        onEvent?.(event);
        void queryClient.invalidateQueries({ predicate: (q) =>
          typeof q.queryKey[0] === "string" &&
          (q.queryKey[0] as string).includes("/cash-sessions"),
        });

        const capturedNavigate = navigate;
        const label = event.drawerName ?? event.sessionNumber;
        toast({
          title: `⏰ ${t("notifications.cashSessionLongOpenTitle")}`,
          description: t("notifications.cashSessionLongOpenBody", { label }),
          duration: 10_000,
          action: (
            <ToastAction
              altText={t("notifications.cashSessionView")}
              onClick={() => capturedNavigate("/cash-sessions?status=attention")}
            >
              {t("notifications.cashSessionView")}
            </ToastAction>
          ),
        });
      },

      "cash_session.overdue": (data: string) => {
        let outer: { data?: CashSessionLongOpenPayload };
        try {
          outer = JSON.parse(data) as { data?: CashSessionLongOpenPayload };
        } catch {
          return;
        }
        const payload = outer.data;
        if (!payload || !payload.id) return;

        const dedupKey = `cash-session-overdue-seen:${payload.id}`;
        if (sessionStorage.getItem(dedupKey)) return;
        sessionStorage.setItem(dedupKey, "1");

        const event: CashSessionAlertEvent = {
          kind: "overdue",
          sessionId: payload.id,
          sessionNumber: payload.sessionNumber ?? String(payload.id),
          drawerName: payload.drawerName ?? null,
          locationName: payload.locationName ?? null,
        };

        onEvent?.(event);
        void queryClient.invalidateQueries({ predicate: (q) =>
          typeof q.queryKey[0] === "string" &&
          (q.queryKey[0] as string).includes("/cash-sessions"),
        });

        const capturedNavigate = navigate;
        const label = event.drawerName ?? event.sessionNumber;
        toast({
          title: `🔴 ${t("notifications.cashSessionOverdueTitle")}`,
          description: t("notifications.cashSessionOverdueBody", { label }),
          duration: 12_000,
          action: (
            <ToastAction
              altText={t("notifications.cashSessionView")}
              onClick={() => capturedNavigate("/cash-sessions?status=attention")}
            >
              {t("notifications.cashSessionView")}
            </ToastAction>
          ),
        });
      },
    },
    {
      onConnect: (isReconnect) => {
        if (!isReconnect) return;
        void queryClient.invalidateQueries({ predicate: (q) =>
          typeof q.queryKey[0] === "string" &&
          (q.queryKey[0] as string).includes("/cash-sessions"),
        });
      },
    },
  );
}
