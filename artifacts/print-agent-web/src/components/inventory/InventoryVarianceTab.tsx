import { useTranslation } from "react-i18next";
import { useGetInventoryVariance } from "@workspace/api-client-react";
import type { GetInventoryVarianceParams } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";

function fmt(v: number, d = 1) {
  return v.toLocaleString("en", { minimumFractionDigits: d, maximumFractionDigits: d });
}

function varianceClass(v: number) {
  if (v > 0) return "text-red-600 font-semibold";
  if (v < 0) return "text-green-600 font-semibold";
  return "";
}

interface Props {
  apiParams: GetInventoryVarianceParams;
}

export default function InventoryVarianceTab({ apiParams }: Props) {
  const { t } = useTranslation();
  const { data, isLoading, error } = useGetInventoryVariance(apiParams);

  if (isLoading) return <Skeleton className="h-64 w-full rounded-lg" />;
  if (error || !data) return <p className="text-sm text-destructive">{t("inventory.loadError")}</p>;

  const { kpis, byBaseItem, byLocation } = data;

  const locationChartData = byLocation.map((l) => ({
    name: l.locationName,
    actual: Number(l.actualCost),
    theoretical: Number(l.theoreticalCost),
  }));

  return (
    <div className="flex flex-col gap-6">
      {/* KPI cards */}
      <div className="grid grid-cols-3 gap-3">
        {(
          [
            [t("inventory.variance.actualCogs"), kpis.actualCogs, false],
            [t("inventory.variance.theoreticalCogs"), kpis.theoreticalCogs, false],
            [t("inventory.variance.costVariance"), kpis.costVariance, true],
          ] as [string, number, boolean][]
        ).map(([label, val, isVariance]) => (
          <Card key={label} className={isVariance && val > 0 ? "border-amber-400" : ""}>
            <CardContent className="pt-4 pb-3">
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className={`text-xl font-semibold mt-1 ${isVariance ? varianceClass(val) : ""}`}>
                ${fmt(val)}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* By location chart */}
      {locationChartData.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{t("inventory.variance.byLocation")}</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={locationChartData} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => `$${v}`} />
                <Tooltip formatter={(v: number) => `$${fmt(v)}`} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="theoretical" name={t("inventory.variance.theoretical")} fill="#a855f7" radius={[4, 4, 0, 0]} />
                <Bar dataKey="actual" name={t("inventory.variance.actual")} fill="#0ea5e9" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* By base item table */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">{t("inventory.variance.byBaseItem")}</CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-xs min-w-[700px]">
            <thead>
              <tr className="border-b text-muted-foreground">
                <th className="text-start px-3 py-2 font-medium">{t("inventory.table.baseItem")}</th>
                <th className="text-end px-3 py-2 font-medium">{t("inventory.variance.theoreticalQty")}</th>
                <th className="text-end px-3 py-2 font-medium">{t("inventory.variance.actualQty")}</th>
                <th className="text-end px-3 py-2 font-medium">{t("inventory.variance.qtyVariance")}</th>
                <th className="text-end px-3 py-2 font-medium">{t("inventory.variance.theoreticalCost")}</th>
                <th className="text-end px-3 py-2 font-medium">{t("inventory.variance.actualCost")}</th>
                <th className="text-end px-3 py-2 font-medium">{t("inventory.variance.costVariance")}</th>
                <th className="text-start px-3 py-2 font-medium">{t("inventory.variance.driver")}</th>
              </tr>
            </thead>
            <tbody>
              {byBaseItem.length === 0 && (
                <tr>
                  <td colSpan={8} className="text-center text-muted-foreground py-6">{t("inventory.noData")}</td>
                </tr>
              )}
              {byBaseItem.map((row) => (
                <tr key={row.baseItemId} className="border-b last:border-0 hover:bg-muted/30">
                  <td className="px-3 py-2">{row.baseItemName}</td>
                  <td className="px-3 py-2 text-end font-mono">{fmt(row.recipeQty, 2)}</td>
                  <td className="px-3 py-2 text-end font-mono">{fmt(row.actualQty, 2)}</td>
                  <td className={`px-3 py-2 text-end font-mono ${varianceClass(row.qtyVariance)}`}>
                    {row.qtyVariance > 0 ? "+" : ""}{fmt(row.qtyVariance, 2)}
                  </td>
                  <td className="px-3 py-2 text-end font-mono">${fmt(row.theoreticalCost)}</td>
                  <td className="px-3 py-2 text-end font-mono">${fmt(row.actualCost)}</td>
                  <td className={`px-3 py-2 text-end font-mono ${varianceClass(row.costVariance)}`}>
                    {row.costVariance > 0 ? "+" : ""}${fmt(row.costVariance)}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground capitalize">{row.likelyDriver.replace(/_/g, " ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
