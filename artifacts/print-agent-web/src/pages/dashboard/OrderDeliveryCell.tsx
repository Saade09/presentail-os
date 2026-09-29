import { MapPin } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import {
  formatDeliverySchedule,
  resolveDeliverySchedule,
} from "@/lib/deliveryDate";
import { getUrgency, type OrderRow } from "./orderRowHelpers";

/**
 * Shows the resolved delivery day and slot, plus the express and area markers.
 * Canonical windows and retained legacy schedules share the same resolver.
 */
export function DeliveryCell({ order, nowMs }: { order: OrderRow; nowMs: number }) {
  const { t } = useTranslation();
  const addr = order.delivery_address ?? {};
  const schedule = resolveDeliverySchedule({
    windowStart: order.window_start,
    windowEnd: order.window_end,
    legacyDate: addr["date"],
    legacySlot: addr["slot"],
  });
  const presentation = formatDeliverySchedule(
    schedule,
    order.delivery_timezone || "UTC",
    new Date(nowMs),
  );
  const area =
    typeof addr["district"] === "string" && addr["district"].trim()
      ? addr["district"].trim()
      : "";

  if (!presentation) {
    return <span className="text-muted-foreground/40">—</span>;
  }

  const dayLabel =
    presentation.relativeLabel === "Today"
      ? t("orders.relToday")
      : presentation.relativeLabel === "Tomorrow"
        ? t("orders.relTomorrow")
        : presentation.dateLabel;
  const urgency = getUrgency(order, nowMs);

  return (
    <div className="space-y-0">
      <div
        className={cn(
          "text-sm font-medium leading-tight",
          urgency.finished && "text-muted-foreground",
        )}
      >
        {dayLabel}
      </div>
      {presentation.timeLabel && (
        <div className="text-xs text-muted-foreground leading-tight truncate">
          {presentation.timeLabel}
        </div>
      )}
      <div className="flex items-center gap-2 text-xs text-muted-foreground leading-tight">
        {order.delivery_type?.trim().toLowerCase() === "express" && (
          <span className="font-medium text-red-600">{t("orders.expressDelivery")}</span>
        )}
        {area && (
          <span className="flex min-w-0 items-center gap-1">
            <MapPin size={11} className="shrink-0" />
            <span className="truncate">{area}</span>
          </span>
        )}
      </div>
    </div>
  );
}