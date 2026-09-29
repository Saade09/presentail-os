import { useTranslation } from "react-i18next";
import { useGetInventoryTransfers } from "@workspace/api-client-react";
import type { GetInventoryTransfersParams } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { format } from "date-fns";

function fmt(v: number, d = 1) {
  return v.toLocaleString("en", { minimumFractionDigits: d, maximumFractionDigits: d });
}

const STATUS_COLORS: Record<string, string> = {
  matched: "bg-green-100 text-green-800",
  partial: "bg-yellow-100 text-yellow-800",
  unmatched: "bg-red-100 text-red-800",
  pending: "bg-gray-100 text-gray-700",
};

interface Props {
  apiParams: GetInventoryTransfersParams;
}

export default function InventoryTransfersTab({ apiParams }: Props) {
  const { t } = useTranslation();
  const { data, isLoading, error } = useGetInventoryTransfers(apiParams);

  if (isLoading) return <Skeleton className="h-64 w-full rounded-lg" />;
  if (error || !data) return <p className="text-sm text-destructive">{t("inventory.loadError")}</p>;

  const { kpis, transfers } = data;

  return (
    <div className="flex flex-col gap-6">
      {/* KPI strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {(
          [
            [t("inventory.transfers.inValue"), kpis.transferInValue],
            [t("inventory.transfers.outValue"), kpis.transferOutValue],
            [t("inventory.transfers.inQty"), kpis.transferInQty],
            [t("inventory.transfers.outQty"), kpis.transferOutQty],
          ] as [string, number][]
        ).map(([label, val]) => (
          <Card key={label}>
            <CardContent className="pt-4 pb-3">
              <p className="text-xs text-muted-foreground">{label}</p>
              <p className="text-xl font-semibold mt-1">{typeof val === "number" && val > 1000 ? `$${fmt(val)}` : fmt(val, 2)}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Transfers table */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">{t("inventory.transfers.table")}</CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-xs min-w-[800px]">
            <thead>
              <tr className="border-b text-muted-foreground">
                <th className="text-start px-3 py-2 font-medium">{t("inventory.table.baseItem")}</th>
                <th className="text-start px-3 py-2 font-medium">{t("inventory.transfers.source")}</th>
                <th className="text-end px-3 py-2 font-medium">{t("inventory.transfers.dispatched")}</th>
                <th className="text-end px-3 py-2 font-medium">{t("inventory.transfers.received")}</th>
                <th className="text-end px-3 py-2 font-medium">{t("inventory.transfers.variance")}</th>
                <th className="text-end px-3 py-2 font-medium">{t("inventory.transfers.dispatchedVal")}</th>
                <th className="text-end px-3 py-2 font-medium">{t("inventory.transfers.receivedVal")}</th>
                <th className="text-start px-3 py-2 font-medium">{t("inventory.transfers.dispatchedAt")}</th>
                <th className="text-start px-3 py-2 font-medium">{t("inventory.transfers.status")}</th>
              </tr>
            </thead>
            <tbody>
              {transfers.length === 0 && (
                <tr>
                  <td colSpan={9} className="text-center text-muted-foreground py-6">{t("inventory.noData")}</td>
                </tr>
              )}
              {transfers.map((tr, i) => (
                <tr key={i} className="border-b last:border-0 hover:bg-muted/30">
                  <td className="px-3 py-1.5">{tr.baseItemName}</td>
                  <td className="px-3 py-1.5 text-muted-foreground">{tr.sourceLabel ?? "—"}</td>
                  <td className="px-3 py-1.5 text-end font-mono">{fmt(tr.dispatchedQty, 2)}</td>
                  <td className="px-3 py-1.5 text-end font-mono">{fmt(tr.receivedQty, 2)}</td>
                  <td className={`px-3 py-1.5 text-end font-mono ${tr.qtyVariance !== 0 ? "text-amber-600 font-semibold" : ""}`}>
                    {tr.qtyVariance > 0 ? "+" : ""}{fmt(tr.qtyVariance, 2)}
                  </td>
                  <td className="px-3 py-1.5 text-end font-mono">${fmt(tr.dispatchedValue)}</td>
                  <td className="px-3 py-1.5 text-end font-mono">${fmt(tr.receivedValue)}</td>
                  <td className="px-3 py-1.5 text-muted-foreground whitespace-nowrap">
                    {tr.dispatchedAt ? format(new Date(tr.dispatchedAt), "dd MMM HH:mm") : "—"}
                  </td>
                  <td className="px-3 py-1.5">
                    <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-medium capitalize ${STATUS_COLORS[tr.status] ?? "bg-gray-100 text-gray-700"}`}>
                      {tr.status}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
