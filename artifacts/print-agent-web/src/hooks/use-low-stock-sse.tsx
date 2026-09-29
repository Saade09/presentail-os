import { useLocation } from "wouter";
import { useToast } from "@/hooks/use-toast";
import { ToastAction } from "@/components/ui/toast";
import { useAuthedSse } from "@/hooks/use-authed-sse";

interface LowStockPayload {
  itemName: string;
  locationName: string;
  currentStock: number;
  baseItemId: number;
}

/**
 * Opens a token-authenticated SSE connection to /api/base-items/low-stock-events
 * and displays a toast whenever the server reports a location crossing into
 * low-stock territory.
 * Deduplication is session-scoped: the same (itemName, locationName) pair will
 * not trigger a second toast within the same browser session.
 *
 * @param enabled Pass true for owners and members with base_items.manage permission.
 * @param onEvent Optional callback invoked for each new event (after dedup). Use to
 *   push the event into the persistent notification bell list.
 */
export function useLowStockSse(
  enabled: boolean,
  onEvent?: (payload: LowStockPayload) => void,
): void {
  const { toast } = useToast();
  const [, navigate] = useLocation();

  useAuthedSse("/api/base-items/low-stock-events", enabled, {
    low_stock: (data: string) => {
      let payload: LowStockPayload;
      try {
        payload = JSON.parse(data) as LowStockPayload;
      } catch {
        return;
      }

      const dedupKey = `low-stock-seen:${payload.itemName}::${payload.locationName}`;
      if (sessionStorage.getItem(dedupKey)) return;
      sessionStorage.setItem(dedupKey, "1");

      onEvent?.(payload);

      const units = payload.currentStock === 1 ? "unit" : "units";
      const capturedNavigate = navigate;

      toast({
        title: `⚠️ Low stock: ${payload.itemName}`,
        description: `Low at ${payload.locationName} — ${payload.currentStock} ${units} remaining`,
        duration: 10_000,
        action: (
          <ToastAction
            altText="View Base Items"
            onClick={() => capturedNavigate("/base-items")}
          >
            View
          </ToastAction>
        ),
      });
    },
  });
}
