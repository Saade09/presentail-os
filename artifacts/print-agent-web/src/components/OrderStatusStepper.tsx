import React from "react";
import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Card, CardContent } from "@/components/ui/card";
import {
  normalizeOrderStatus,
  ORDER_STATUS_LABEL_KEYS,
} from "@/lib/orderStatus";
import { formatStepTimestamp } from "@/lib/orderPunctuality";

/**
 * The main fulfilment flow shown in the stepper. Off-flow statuses
 * (cancelled / on_hold / refunded) don't appear here — they show as a pill
 * only and hide the advance button.
 */
export const STEPPER_FLOW = [
  "pending",
  "processing",
  "preparing",
  "ready_for_delivery",
  "out_for_delivery",
  "completed",
] as const;

export type StepperFlowStatus = (typeof STEPPER_FLOW)[number];

/** Returns the next status in the fulfilment flow, or null at the terminal step. */
export function nextFlowStatus(status: string): string | null {
  const idx = (STEPPER_FLOW as readonly string[]).indexOf(
    normalizeOrderStatus(status),
  );
  if (idx === -1 || idx === STEPPER_FLOW.length - 1) return null;
  return STEPPER_FLOW[idx + 1];
}

interface OrderStatusStepperProps {
  /** Current order status (raw from API — will be normalized internally). */
  status: string;
  /**
   * Map of status → ISO timestamp for each status the order has entered.
   * Only the most-recent entry time per status is expected (as returned by
   * the API's `status_timestamps` field).
   */
  statusTimestamps?: Record<string, string>;
  /**
   * IANA timezone to format timestamps in, e.g. "Asia/Beirut".
   * Defaults to "UTC".
   */
  timezone?: string;
  /** ISO timestamp of when the order was placed — used for same-day formatting. */
  orderedAt?: string | null;
}

export function OrderStatusStepper({
  status,
  statusTimestamps = {},
  timezone = "UTC",
  orderedAt,
}: OrderStatusStepperProps) {
  const { t } = useTranslation();
  const activeIdx = (STEPPER_FLOW as readonly string[]).indexOf(
    normalizeOrderStatus(status),
  );

  return (
    <Card>
      <CardContent className="py-4 px-4 sm:px-6 overflow-x-auto">
        <div
          className="flex items-start min-w-[560px]"
          data-testid="order-status-stepper"
        >
          {STEPPER_FLOW.map((step, i) => {
            const done = activeIdx > i;
            const current = activeIdx === i;
            const reached = done || current;
            const rawTs = statusTimestamps[step];
            const tsLabel =
              reached && rawTs
                ? formatStepTimestamp(rawTs, orderedAt ?? null, timezone)
                : "";

            return (
              <React.Fragment key={step}>
                {i > 0 && (
                  <div
                    className={`h-px flex-1 mx-2 mt-3 ${
                      activeIdx >= i ? "bg-primary" : "bg-border"
                    }`}
                  />
                )}
                <div className="flex flex-col shrink-0">
                  <div className="flex items-center gap-2">
                    <span
                      className={`flex items-center justify-center w-6 h-6 rounded-full border text-[11px] font-semibold ${
                        current
                          ? "bg-primary text-primary-foreground border-primary"
                          : done
                            ? "bg-primary/10 text-primary border-primary/40"
                            : "bg-background text-muted-foreground border-border"
                      }`}
                    >
                      {done ? <Check size={13} /> : i + 1}
                    </span>
                    <span
                      className={`text-xs whitespace-nowrap ${
                        current
                          ? "font-semibold text-foreground"
                          : done
                            ? "text-foreground"
                            : "text-muted-foreground"
                      }`}
                    >
                      {t(
                        ORDER_STATUS_LABEL_KEYS[
                          step as keyof typeof ORDER_STATUS_LABEL_KEYS
                        ],
                      )}
                    </span>
                  </div>
                  {tsLabel && (
                    <span
                      className="text-[10px] text-muted-foreground font-normal leading-tight mt-0.5 pl-8"
                      data-testid={`step-timestamp-${step}`}
                    >
                      {tsLabel}
                    </span>
                  )}
                </div>
              </React.Fragment>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
