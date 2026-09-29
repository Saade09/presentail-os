import { useTranslation } from "react-i18next";
import { useGetInventoryTheoreticalCost } from "@workspace/api-client-react";
import type { GetInventoryTheoreticalCostParams } from "@workspace/api-client-react";
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
  Cell,
} from "recharts";

function fmt(v: number, d = 2) {
  return v.toLocaleString("en", { minimumFractionDigits: d, maximumFractionDigits: d });
}

const PALETTE = ["#0ea5e9", "#a855f7", "#f59e0b", "#10b981", "#ef4444", "#6366f1", "#ec4899"];

interface Props {
  apiParams: GetInventoryTheoreticalCostParams;
}

export default function InventoryTheoreticalCostTab({ apiParams }: Props) {
  const { t } = useTranslation();
  const { data, isLoading, error } = useGetInventoryTheoreticalCost(apiParams);

  if (isLoading) return <Skeleton className="h-64 w-full rounded-lg" />;
  if (error || !data) return <p className="text-sm text-destructive">{t("inventory.loadError")}</p>;

  const { items } = data;
  const total = items.reduce((s, it) => s + it.theoreticalTotalCost, 0);

  const chartData = items.slice(0, 12).map((it) => ({
    name: it.baseItemName.length > 16 ? it.baseItemName.slice(0, 16) + "…" : it.baseItemName,
    cost: it.theoreticalTotalCost,
  }));

  return (
    <div className="flex flex-col gap-6">
      {/* Total */}
      <Card className="border-purple-200">
        <CardContent className="pt-4 pb-3">
          <p className="text-xs text-muted-foreground">{t("inventory.theoretical.totalCost")}</p>
          <p className="text-2xl font-semibold mt-1">${fmt(total)}</p>
        </CardContent>
      </Card>

      {/* Chart */}
      {chartData.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{t("inventory.theoretical.byItem")}</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={chartData} layout="vertical" margin={{ left: 120, right: 16 }}>
                <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f0f0f0" />
                <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={(v: number) => `$${v}`} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={120} />
                <Tooltip formatter={(v: number) => `$${fmt(v)}`} />
                <Bar dataKey="cost" radius={[0, 4, 4, 0]}>
                  {chartData.map((_, i) => (
                    <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* Table */}
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b text-muted-foreground">
                <th className="text-start px-3 py-2 font-medium">{t("inventory.table.baseItem")}</th>
                <th className="text-end px-3 py-2 font-medium">{t("inventory.theoretical.qty")}</th>
                <th className="text-end px-3 py-2 font-medium">{t("inventory.theoretical.unitCost")}</th>
                <th className="text-end px-3 py-2 font-medium">{t("inventory.theoretical.totalCost")}</th>
                <th className="text-end px-3 py-2 font-medium">{t("inventory.theoretical.share")}</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-center text-muted-foreground py-6">{t("inventory.noData")}</td>
                </tr>
              )}
              {items.map((it) => (
                <tr key={it.baseItemId} className="border-b last:border-0 hover:bg-muted/30">
                  <td className="px-3 py-1.5">{it.baseItemName}</td>
                  <td className="px-3 py-1.5 text-end font-mono">{fmt(it.theoreticalQty, 3)}</td>
                  <td className="px-3 py-1.5 text-end font-mono">${fmt(it.theoreticalUnitCost)}</td>
                  <td className="px-3 py-1.5 text-end font-mono">${fmt(it.theoreticalTotalCost)}</td>
                  <td className="px-3 py-1.5 text-end text-muted-foreground">{fmt(it.sharePct, 1)}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
