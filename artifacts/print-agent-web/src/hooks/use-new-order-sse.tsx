import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { useAuthedSse } from "@/hooks/use-authed-sse";
import { markNewOrder } from "@/lib/new-order-highlight";

interface NewOrderPayload {
  id: string;
  source?: string;
  displayOrderNumber?: string | null;
  customerName?: string | null;
  total?: number | null;
  currency?: string | null;
}

export interface NewOrderEvent {
  orderId: string;
  displayOrderNumber: string | null;
  customerName: string | null;
  total: number | null;
  currency: string | null;
}

interface FloristAssignmentPayload {
  id: string;
  displayOrderNumber?: string | null;
  locationId?: number | null;
  assignedAt?: string | null;
}

export interface FloristAssignmentEvent {
  orderId: string;
  displayOrderNumber: string | null;
  locationId: number;
  assignedAt: string | null;
}

/**
 * Plays a short, subtle two-tone chime using the Web Audio API so no audio
 * asset has to be bundled. Best-effort: if the browser blocks autoplay (no prior
 * user gesture) or Web Audio is unavailable, the failure is swallowed silently.
 */
export function playNewOrderChime(): void {
  try {
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const now = ctx.currentTime;
    const notes = [
      { freq: 880, start: 0 },
      { freq: 1174.66, start: 0.12 },
    ];
    for (const { freq, start } of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const t0 = now + start;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.08, t0 + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + 0.24);
    }
    window.setTimeout(() => {
      void ctx.close().catch(() => {});
    }, 600);
  } catch {
    // Autoplay blocked or Web Audio unavailable — ignore.
  }
}

function formatTotal(
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

/**
 * Opens a token-authenticated SSE connection to /api/events and displays a
 * toast whenever the server broadcasts an `order.created` event. Also plays a
 * short chime, refreshes the orders list + pending-count queries, and feeds
 * the event into the notification bell list via the optional callback.
 *
 * Deduplication is session-scoped: the same order id will not trigger a second
 * toast within the same browser session (survives the stream reconnecting).
 *
 * @param enabled Pass true for users who can access the Orders page.
 * @param onEvent Optional callback invoked for each new event (after dedup). Use
 *   to push the event into the persistent notification bell list.
 */
export function useNewOrderSse(
  enabled: boolean,
  onEvent?: (payload: NewOrderEvent) => void,
): void {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();

  useAuthedSse("/api/events", enabled, {
    "order.created": (data: string) => {
      let outer: { data?: NewOrderPayload };
      try {
        outer = JSON.parse(data) as { data?: NewOrderPayload };
      } catch {
        return;
      }
      const payload = outer.data;
      if (!payload || !payload.id) return;

      const dedupKey = `new-order-seen:${payload.id}`;
      if (sessionStorage.getItem(dedupKey)) return;
      sessionStorage.setItem(dedupKey, "1");

      const event: NewOrderEvent = {
        orderId: payload.id,
        displayOrderNumber: payload.displayOrderNumber ?? null,
        customerName: payload.customerName ?? null,
        total: payload.total ?? null,
        currency: payload.currency ?? null,
      };

      onEvent?.(event);

      // Flag the order id so the Orders page briefly highlights its row once
      // the refetched list contains it.
      markNewOrder(payload.id);

      // Refresh the orders list and pending-orders count so the badge updates.
      void queryClient.invalidateQueries({ queryKey: ["orders"] });

      playNewOrderChime();

      const orderNumber = event.displayOrderNumber || event.orderId;
      const totalText = formatTotal(event.total, event.currency, i18n.language);
      const descParts = [
        `#${orderNumber}`,
        event.customerName,
        totalText,
      ].filter(Boolean) as string[];
      const capturedNavigate = navigate;
      const detailPath = `/orders/${event.orderId}`;

      toast({
        title: `🛒 ${t("notifications.newOrderTitle")}`,
        description: descParts.join(" · "),
        duration: 10_000,
        action: (
          <ToastAction
            altText={t("notifications.newOrderView")}
            onClick={() => capturedNavigate(detailPath)}
          >
            {t("notifications.newOrderView")}
          </ToastAction>
        ),
      });
    },
  },
  {
    // Catch-up refetch after a reconnect (network blip, laptop sleep, server
    // restart): events broadcast while disconnected were lost, so refetch the
    // orders list to pick up anything missed. Skipped on the first connect —
    // the page's own initial query already covers that.
    onConnect: (isReconnect) => {
      if (!isReconnect) return;
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
    },
  });
}

/**
 * Listens for `order.assigned_to_florist` SSE events and alerts the signed-in
 * florist when an order is assigned to THEIR florist location: toast with a
 * "View" action (opens the florist queue), chime, order highlight, and an
 * optional callback to feed the notification bell.
 *
 * Events for other locations are ignored client-side; users with no florist
 * location (owners included) never get this alert — pass enabled=false or a
 * null floristLocationId.
 */
export function useFloristAssignmentSse(
  enabled: boolean,
  floristLocationId: number | null,
  onEvent?: (payload: FloristAssignmentEvent) => void,
): void {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const queryClient = useQueryClient();

  useAuthedSse(
    "/api/events",
    enabled && floristLocationId != null,
    {
      "order.assigned_to_florist": (data: string) => {
        let outer: { data?: FloristAssignmentPayload };
        try {
          outer = JSON.parse(data) as { data?: FloristAssignmentPayload };
        } catch {
          return;
        }
        const payload = outer.data;
        if (!payload || !payload.id || payload.locationId == null) return;
        if (floristLocationId == null || payload.locationId !== floristLocationId)
          return;

        // Keyed per assignment (assignedAt) so a later legitimate
        // re-assignment back to this location still alerts; the key only
        // suppresses duplicate deliveries of the SAME assignment event
        // (e.g. reconnect replays).
        const dedupKey = `florist-assigned-seen:${payload.id}:${payload.locationId}:${payload.assignedAt ?? ""}`;
        if (sessionStorage.getItem(dedupKey)) return;
        sessionStorage.setItem(dedupKey, "1");

        const event: FloristAssignmentEvent = {
          orderId: payload.id,
          displayOrderNumber: payload.displayOrderNumber ?? null,
          locationId: payload.locationId,
          assignedAt: payload.assignedAt ?? null,
        };

        onEvent?.(event);
        markNewOrder(payload.id);

        // Refresh the florist queue so the newly assigned order appears.
        void queryClient.invalidateQueries({
          predicate: (q) =>
            typeof q.queryKey[0] === "string" &&
            (q.queryKey[0] as string).includes("/florist-orders"),
        });

        playNewOrderChime();

        const orderNumber = event.displayOrderNumber || event.orderId;
        const capturedNavigate = navigate;

        toast({
          title: `💐 ${t("notifications.floristAssignedTitle")}`,
          description: `#${orderNumber}`,
          duration: 10_000,
          action: (
            <ToastAction
              altText={t("notifications.newOrderView")}
              onClick={() => capturedNavigate("/florist-orders")}
            >
              {t("notifications.newOrderView")}
            </ToastAction>
          ),
        });
      },
    },
    {
      // Catch up after reconnect: refetch the florist queue for anything missed.
      onConnect: (isReconnect) => {
        if (!isReconnect) return;
        void queryClient.invalidateQueries({
          predicate: (q) =>
            typeof q.queryKey[0] === "string" &&
            (q.queryKey[0] as string).includes("/florist-orders"),
        });
      },
    },
  );
}
