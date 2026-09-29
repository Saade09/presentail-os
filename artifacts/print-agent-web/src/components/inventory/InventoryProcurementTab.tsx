import { useTranslation } from "react-i18next";
import { useGetInventoryProcurement } from "@workspace/api-client-react";
import type { GetInventoryProcurementParams } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import { format } from "date-fns";
import type { UseInventoryAnalyticsFilters } from "@/hooks/use-inventory-analytics-filters";

function fmt(v: number, d = 1) {
  return v.toLocaleString("en", { minimumFractionDigits: d, maximumFractionDigits: d });
}

interface Props {
  apiParams: GetInventoryProcurementParams;
  filters: UseInventoryAnalyticsFilters;
}

export default function InventoryProcurementTab({ apiParams }: Props) {
  const { t } = useTranslation();
  const { data, isLoading, error } = useGetInventoryProcurement(apiParams);

  if (isLoading) return <Skeleton className="h-64 w-full rounded-lg" />;
  if (error || !data) return <p className="text-sm text-destructive">{t("inventory.loadError")}</p>;

  const { kpis, bySupplier, byCategory, byLocation, costTrend } = data;

  const trendChartData = costTrend.map((c) => ({
    week: format(new Date(c.weekStart), "dd MMM"),
    purchase: Number(c.purchaseValue),
    avgUnit: Number(c.avgUnitCost),
  }));

  return (
    <div className="flex flex-col gap-6">
      {/* KPI cards */}
      <div className="grid grid-cols-3 gap-3">
        {(
          [
            [t("inventory.procurement.purchaseValue"), kpis.purchaseValue],
            [t("inventory.procurement.received"), kpis.receivedValue],
            [t("inventory.procurement.pending"), kpis.pendingValue],
          ] as [string, number][]
        ).map(([label, val]) => (
          <Card key={label}>
            <CardContent className="pt-4 pb-3">
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className="text-xl font-semibold mt-1">${fmt(val)}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Cost trend */}
      {trendChartData.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{t("inventory.procurement.costTrend")}</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={trendChartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="purchaseGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#0ea5e9" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#0ea5e9" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="week" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => `$${v}`} />
                <Tooltip formatter={(v: number) => `$${fmt(v)}`} />
                <Area type="monotone" dataKey="purchase" stroke="#0ea5e9" fill="url(#purchaseGrad)" name={t("inventory.procurement.purchaseValue")} />
              </AreaChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* By supplier + by category side by side */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{t("inventory.procurement.bySupplier")}</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th className="text-start px-3 py-2 font-medium">{t("inventory.procurement.supplier")}</th>
                  <th className="text-end px-3 py-2 font-medium">{t("inventory.procurement.orders")}</th>
                  <th className="text-end px-3 py-2 font-medium">{t("inventory.procurement.value")}</th>
                </tr>
              </thead>
              <tbody>
                {bySupplier.length === 0 && (
                  <tr>
                    <td colSpan={3} className="text-center text-muted-foreground py-6">{t("inventory.noData")}</td>
                  </tr>
                )}
                {bySupplier.map((s, i) => (
                  <tr key={i} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="px-3 py-1.5">{s.supplierLabel}</td>
                    <td className="px-3 py-1.5 text-end font-mono">{s.orderCount}</td>
                    <td className="px-3 py-1.5 text-end font-mono">${fmt(s.purchaseValue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{t("inventory.procurement.byCategory")}</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th className="text-start px-3 py-2 font-medium">{t("inventory.procurement.category")}</th>
                  <th className="text-end px-3 py-2 font-medium">{t("inventory.procurement.value")}</th>
                </tr>
              </thead>
              <tbody>
                {byCategory.length === 0 && (
                  <tr>
                    <td colSpan={2} className="text-center text-muted-foreground py-6">{t("inventory.noData")}</td>
                  </tr>
                )}
                {byCategory.map((c, i) => (
                  <tr key={i} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="px-3 py-1.5">{c.categoryName}</td>
                    <td className="px-3 py-1.5 text-end font-mono">${fmt(c.purchaseValue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>

      {/* By location */}
      {byLocation.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{t("inventory.procurement.byLocation")}</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={byLocation} layout="vertical" margin={{ left: 80, right: 8 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f0f0f0" />
                <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={(v: number) => `$${v}`} />
                <YAxis type="category" dataKey="locationName" tick={{ fontSize: 11 }} width={80} />
                <Tooltip formatter={(v: number) => `$${fmt(v)}`} />
                <Bar dataKey="purchaseValue" fill="#0ea5e9" name={t("inventory.procurement.value")} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
