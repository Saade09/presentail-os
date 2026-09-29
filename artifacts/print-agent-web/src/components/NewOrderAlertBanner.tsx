import { useTranslation } from "react-i18next";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import type { NewOrderAlert } from "@/hooks/use-new-order-alert-queue";
import { Bell, BellOff, Volume2, VolumeX, X } from "lucide-react";

const MAX_VISIBLE = 3;

interface NewOrderAlertBannerProps {
  alerts: NewOrderAlert[];
  muted: boolean;
  soundBlocked: boolean;
  onAcknowledge: (orderId: string) => void;
  onAcknowledgeAll: () => void;
  onToggleMute: () => void;
}

function formatTotal(total: number | null, currency: string | null, locale: string): string | null {
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
 * Persistent stacking banner shown while there are unacknowledged new orders.
 * Stays visible (and the ringtone keeps repeating) until each order is either
 * dismissed or opened.
 */
export function NewOrderAlertBanner({
  alerts,
  muted,
  soundBlocked,
  onAcknowledge,
  onAcknowledgeAll,
  onToggleMute,
}: NewOrderAlertBannerProps) {
  const { t, i18n } = useTranslation();
  const [, navigate] = useLocation();

  if (alerts.length === 0) return null;

  const visible = alerts.slice(0, MAX_VISIBLE);
  const hiddenCount = alerts.length - visible.length;

  return (
    <div
      className="border-b border-amber-300 bg-amber-50 dark:bg-amber-950/40 dark:border-amber-800"
      role="alert"
      data-testid="new-order-alert-banner"
    >
      <div className="px-4 py-2 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2 text-amber-900 dark:text-amber-200 font-semibold text-sm">
          <Bell size={16} className="animate-pulse" />
          {alerts.length === 1
            ? t("newOrderAlerts.bannerTitleOne")
            : t("newOrderAlerts.bannerTitleMany", { count: alerts.length })}
          {soundBlocked && !muted && (
            <span className="font-normal text-xs text-amber-800 dark:text-amber-300 flex items-center gap-1">
              <BellOff size={12} />
              {t("newOrderAlerts.soundBlockedHint")}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-amber-900 dark:text-amber-200"
            onClick={onToggleMute}
            data-testid="new-order-alert-mute-toggle"
            title={muted ? t("newOrderAlerts.unmute") : t("newOrderAlerts.mute")}
          >
            {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
            <span className="ms-1 text-xs">
              {muted ? t("newOrderAlerts.unmute") : t("newOrderAlerts.mute")}
            </span>
          </Button>
          {alerts.length > 1 && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={onAcknowledgeAll}
              data-testid="new-order-alert-dismiss-all"
            >
              {t("newOrderAlerts.dismissAll")}
            </Button>
          )}
        </div>
      </div>
      <div className="px-4 pb-2 space-y-1.5">
        {visible.map((alert) => {
          const orderNumber = alert.displayOrderNumber || alert.orderId.slice(0, 8);
          const totalText = formatTotal(alert.total, alert.currency, i18n.language);
          const detail = [alert.customerName, totalText].filter(Boolean).join(" · ");
          return (
            <div
              key={alert.orderId}
              className="flex items-center justify-between gap-3 rounded-md bg-white/70 dark:bg-black/20 border border-amber-200 dark:border-amber-800 px-3 py-1.5"
              data-testid={`new-order-alert-item-${alert.orderId}`}
            >
              <div className="min-w-0 text-sm text-amber-950 dark:text-amber-100 truncate">
                <span className="font-semibold">#{orderNumber}</span>
                {detail && <span className="text-amber-800 dark:text-amber-300"> — {detail}</span>}
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <Button
                  size="sm"
                  className="h-7 px-2.5 text-xs"
                  onClick={() => {
                    onAcknowledge(alert.orderId);
                    navigate(`/orders/${alert.orderId}`);
                  }}
                  data-testid={`new-order-alert-view-${alert.orderId}`}
                >
                  {t("newOrderAlerts.view")}
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 text-amber-900 dark:text-amber-200"
                  onClick={() => onAcknowledge(alert.orderId)}
                  aria-label={t("newOrderAlerts.dismiss")}
                  data-testid={`new-order-alert-dismiss-${alert.orderId}`}
                >
                  <X size={14} />
                </Button>
              </div>
            </div>
          );
        })}
        {hiddenCount > 0 && (
          <p className="text-xs text-amber-800 dark:text-amber-300">
            {t("newOrderAlerts.moreHidden", { count: hiddenCount })}
          </p>
        )}
      </div>
    </div>
  );
}
