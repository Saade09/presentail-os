import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { normalizeOrderStatus, orderStatusBadgeClass } from "@/lib/orderStatus";

/**
 * Shared order lifecycle status badge used by the Orders list, Order detail,
 * and other order-history surfaces. Normalizes the raw status before color
 * lookup and falls back to a neutral treatment for unknown statuses.
 *
 * Displays the normalized status with underscores as spaces, capitalized via
 * CSS — identical to the previous per-page implementations.
 */
export function OrderStatusBadge({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  const normalized = normalizeOrderStatus(status);
  const cls = orderStatusBadgeClass(status);
  return (
    <Badge className={cn(cls, "border capitalize font-medium", className)}>
      {normalized.replace(/_/g, " ")}
    </Badge>
  );
}
