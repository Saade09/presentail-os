import { TrendingUp, ShoppingBag, Banknote, Clock } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { formatUsd } from "./cmcPosDashboard.helpers";

export type CmcMetrics = {
  sales: {
    paid_count: string;
    refunded_count: string;
    voided_count: string;
    gross_total: string | null;
    total_discounts: string | null;
    cash_total: string | null;
    cash_count: string;
    cash_refunds_total: string | null;
    payment_issues: string;
  };
  requests: {
    draft_count: string;
    submitted_count: string;
    accepted_count: string;
    dispatched_count: string;
    received_count: string;
    cancelled_count: string;
  };
  delivery_orders: {
    count: string;
    revenue: string;
  };
};

type Props = {
  metrics: CmcMetrics | undefined;
  isLoading: boolean;
  error: Error | null;
};

function KpiCard({
  icon: Icon,
  label,
  primary,
  secondary,
  accent,
  isLoading,
}: {
  icon: React.ElementType;
  label: string;
  primary: string;
  secondary?: string;
  accent?: string;
  isLoading: boolean;
}) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">{label}</p>
        <div className="flex h-8 w-8 items-center justify-center rounded-lg" style={{ background: "rgba(0,65,78,0.07)" }}>
          <Icon className="h-4 w-4" style={{ color: "#00414e" }} />
        </div>
      </div>
      {isLoading ? (
        <>
          <Skeleton className="h-7 w-24 mb-1" />
          <Skeleton className="h-3.5 w-16" />
        </>
      ) : (
        <>
          <p className={`text-2xl font-bold tracking-tight ${accent ?? "text-gray-900"}`}>
            {primary}
          </p>
          {secondary && (
            <p className="mt-0.5 text-xs text-gray-500">{secondary}</p>
          )}
        </>
      )}
    </div>
  );
}

export default function CmcPosKpiCards({ metrics, isLoading, error }: Props) {
  if (error && !metrics) {
    return (
      <div className="col-span-4 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
        Failed to load metrics. Showing last known values.
      </div>
    );
  }

  // Shelf sales are always USD (cmc_sales.total is USD).
  const paidCount = parseInt(metrics?.sales.paid_count ?? "0") || 0;
  const shelfRevenueUsd = Number(metrics?.sales.gross_total ?? 0) || 0;

  // Delivery orders: count only — revenue is excluded from KPIs because it
  // may include mixed currencies and lacks a per-currency breakdown.
  const deliveryCount = parseInt(metrics?.delivery_orders.count ?? "0") || 0;
  const totalOrders = paidCount + deliveryCount;

  // Cash-only shelf sales (USD).
  const cashTotal = Number(metrics?.sales.cash_total ?? 0) || 0;
  const cashCount = parseInt(metrics?.sales.cash_count ?? "0") || 0;

  const pendingReqs =
    (parseInt(metrics?.requests.submitted_count ?? "0") || 0) +
    (parseInt(metrics?.requests.accepted_count ?? "0") || 0) +
    (parseInt(metrics?.requests.dispatched_count ?? "0") || 0);

  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
      <KpiCard
        icon={TrendingUp}
        label="Today's Revenue"
        primary={formatUsd(shelfRevenueUsd)}
        secondary={`${paidCount} shelf sale${paidCount !== 1 ? "s" : ""} · USD`}
        accent="text-[#00414e]"
        isLoading={isLoading}
      />
      <KpiCard
        icon={ShoppingBag}
        label="Orders"
        primary={String(totalOrders)}
        secondary={`${paidCount} shelf · ${deliveryCount} delivery`}
        isLoading={isLoading}
      />
      <KpiCard
        icon={Banknote}
        label="Cash Sales"
        primary={formatUsd(cashTotal)}
        secondary={`${cashCount} cash transaction${cashCount !== 1 ? "s" : ""} · USD`}
        isLoading={isLoading}
      />
      <KpiCard
        icon={Clock}
        label="Pending Requests"
        primary={String(pendingReqs)}
        secondary={pendingReqs === 0 ? "All fulfilled" : "Awaiting action"}
        accent={pendingReqs > 0 ? "text-amber-700" : undefined}
        isLoading={isLoading}
      />
    </div>
  );
}
