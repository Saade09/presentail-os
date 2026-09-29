import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useGetInventoryMovements } from "@workspace/api-client-react";
import type { GetInventoryMovementsParams } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { UseInventoryAnalyticsFilters } from "@/hooks/use-inventory-analytics-filters";
import { format } from "date-fns";

function fmt(v: number, d = 2) {
  return v.toLocaleString("en", { minimumFractionDigits: d, maximumFractionDigits: d });
}

const MOVEMENT_TYPES = [
  "purchase",
  "recipe_consumption",
  "transfer_out",
  "transfer_in",
  "wastage",
  "adjustment",
  "opening_stock",
];

const TYPE_COLORS: Record<string, string> = {
  purchase: "bg-green-100 text-green-800",
  recipe_consumption: "bg-blue-100 text-blue-800",
  transfer_out: "bg-orange-100 text-orange-800",
  transfer_in: "bg-teal-100 text-teal-800",
  wastage: "bg-red-100 text-red-800",
  adjustment: "bg-yellow-100 text-yellow-800",
  opening_stock: "bg-gray-100 text-gray-700",
};

interface Props {
  apiParams: GetInventoryMovementsParams;
  filters: UseInventoryAnalyticsFilters;
}

export default function InventoryMovementsTab({ apiParams, filters }: Props) {
  const { t } = useTranslation();
  const [page, setPage] = useState(1);
  const params = { ...apiParams, page, movementType: filters.movementType ?? undefined };
  const { data, isLoading, error } = useGetInventoryMovements(params);

  if (isLoading) return <Skeleton className="h-64 w-full rounded-lg" />;
  if (error || !data) return <p className="text-sm text-destructive">{t("inventory.loadError")}</p>;

  const { movements, total, pageSize, summary } = data;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="flex flex-col gap-4">
      {/* Summary KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {(
          [
            ["inventory.movements.openingStock", summary.openingStockValue],
            ["inventory.movements.purchases", summary.purchases],
            ["inventory.movements.recipeConsumption", summary.recipeConsumption],
            ["inventory.movements.recordedWaste", summary.recordedWaste],
            ["inventory.movements.stockVariance", summary.stockVariance],
          ] as [string, number][]
        ).map(([key, val]) => (
          <Card key={key}>
            <CardContent className="pt-4 pb-3">
              <p className="text-xs text-muted-foreground">{t(key)}</p>
              <p className="text-lg font-semibold mt-0.5">${fmt(val)}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2">
        <Select
          value={filters.movementType ?? "all"}
          onValueChange={(v) => { filters.setMovementType(v === "all" ? null : v); setPage(1); }}
        >
          <SelectTrigger className="h-8 w-[180px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="text-xs">{t("inventory.movements.allTypes")}</SelectItem>
            {MOVEMENT_TYPES.map((mt) => (
              <SelectItem key={mt} value={mt} className="text-xs capitalize">
                {mt.replace(/_/g, " ")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-xs text-muted-foreground">{total} {t("inventory.movements.records")}</span>
      </div>

      {/* Table */}
      <Card>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-xs min-w-[700px]">
            <thead>
              <tr className="border-b text-muted-foreground">
                <th className="text-start px-3 py-2 font-medium">{t("inventory.table.date")}</th>
                <th className="text-start px-3 py-2 font-medium">{t("inventory.table.baseItem")}</th>
                <th className="text-start px-3 py-2 font-medium">{t("inventory.table.location")}</th>
                <th className="text-start px-3 py-2 font-medium">{t("inventory.table.movementType")}</th>
                <th className="text-end px-3 py-2 font-medium">{t("inventory.table.qty")}</th>
                <th className="text-end px-3 py-2 font-medium">{t("inventory.table.unitCost")}</th>
                <th className="text-end px-3 py-2 font-medium">{t("inventory.table.totalValue")}</th>
                <th className="text-start px-3 py-2 font-medium">{t("inventory.table.source")}</th>
              </tr>
            </thead>
            <tbody>
              {movements.length === 0 && (
                <tr>
                  <td colSpan={8} className="text-center text-muted-foreground py-6">{t("inventory.noData")}</td>
                </tr>
              )}
              {movements.map((m) => (
                <tr key={m.id} className="border-b last:border-0 hover:bg-muted/30">
                  <td className="px-3 py-2 whitespace-nowrap">
                    {format(new Date(m.posted_at), "dd MMM HH:mm")}
                  </td>
                  <td className="px-3 py-2">{m.base_item_name}</td>
                  <td className="px-3 py-2 text-muted-foreground">{m.location_name ?? "—"}</td>
                  <td className="px-3 py-2">
                    <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-medium ${TYPE_COLORS[m.movement_type] ?? "bg-gray-100 text-gray-700"}`}>
                      {m.movement_type.replace(/_/g, " ")}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-end font-mono">
                    {Number(m.quantity_change) > 0 ? "+" : ""}{Number(m.quantity_change).toFixed(2)}
                    {m.unit_of_measure ? ` ${m.unit_of_measure}` : ""}
                  </td>
                  <td className="px-3 py-2 text-end font-mono">
                    {m.unit_cost != null ? `$${fmt(Number(m.unit_cost))}` : "—"}
                  </td>
                  <td className="px-3 py-2 text-end font-mono">
                    {m.total_value != null ? `$${fmt(Number(m.total_value))}` : "—"}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">{m.source_label ?? m.source_type ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {/* Pagination */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {t("inventory.movements.page")} {page} / {totalPages}
        </span>
        <div className="flex gap-1">
          <Button variant="outline" size="icon" className="h-7 w-7" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            <ChevronLeft className="h-3 w-3" />
          </Button>
          <Button variant="outline" size="icon" className="h-7 w-7" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
            <ChevronRight className="h-3 w-3" />
          </Button>
        </div>
      </div>
    </div>
  );
}
