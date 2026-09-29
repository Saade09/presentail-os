import { useLocation } from "wouter";
import { useTranslation } from "react-i18next";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { useAuthedSse } from "@/hooks/use-authed-sse";
import { playNewOrderChime } from "@/hooks/use-new-order-sse";

interface CmcSalePayload {
  id: string;
  locationId?: number | null;
  total?: number | null;
  paymentMethod?: string | null;
}

export interface CmcSaleEvent {
  saleId: string;
  locationId: number | null;
  total: number | null;
  paymentMethod: string | null;
}

function formatTotal(
  total: number | null,
  locale: string,
): string | null {
  if (total == null || Number.isNaN(total)) return null;
  return total.toFixed(2);
}

/**
 * Opens a token-authenticated SSE connection and listens for `cmc_sale.created`
 * events. On each new sale:
 *  - deduplicates per sale ID via sessionStorage (refresh-safe)
 *  - plays the new-order chime
 *  - shows a 10-second toast with the sale total and a "View" link to /cmc-pos/sales
 *  - invokes the optional `onNewSale` callback (e.g. to push into the alert queue
 *    and notification bell in Layout)
 *
 * Only activate when the current user has the `cmc_pos` permission.
 */
export function useNewCmcSaleSse(
  enabled: boolean,
  onNewSale?: (event: CmcSaleEvent) => void,
): void {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const [, navigate] = useLocation();

  useAuthedSse("/api/events", enabled, {
    "cmc_sale.created": (data: string) => {
      let outer: { data?: CmcSalePayload };
      try {
        outer = JSON.parse(data) as { data?: CmcSalePayload };
      } catch {
        return;
      }
      const payload = outer.data;
      if (!payload || !payload.id) return;

      const dedupKey = `cmc-sale-seen:${payload.id}`;
      if (sessionStorage.getItem(dedupKey)) return;
      sessionStorage.setItem(dedupKey, "1");

      const event: CmcSaleEvent = {
        saleId: payload.id,
        locationId: payload.locationId ?? null,
        total: payload.total ?? null,
        paymentMethod: payload.paymentMethod ?? null,
      };

      onNewSale?.(event);

      playNewOrderChime();

      const totalText = formatTotal(event.total, i18n.language);
      const capturedNavigate = navigate;

      toast({
        title: `🛒 ${t("notifications.newCmcSaleTitle", "New Shelf Sale")}`,
        description: totalText ? `${t("notifications.total", "Total")}: ${totalText}` : undefined,
        duration: 10_000,
        action: (
          <ToastAction
            altText={t("notifications.newOrderView", "View")}
            onClick={() => capturedNavigate("/cmc-pos/sales")}
          >
            {t("notifications.newOrderView", "View")}
          </ToastAction>
        ),
      });
    },
  });
}
