import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useGetInventoryWastage, usePostBaseItemWastage } from "@workspace/api-client-react";
import type { GetInventoryWastageParams } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Plus } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";
import { format } from "date-fns";

function fmt(v: number, d = 1) {
  return v.toLocaleString("en", { minimumFractionDigits: d, maximumFractionDigits: d });
}

const WASTAGE_REASONS = [
  "damaged_on_receipt",
  "expired",
  "production_damage",
  "quality_issue",
  "over_preparation",
  "cancelled_prepared_order",
  "missing_unexplained",
  "other",
];

interface Props {
  apiParams: GetInventoryWastageParams;
}

export default function InventoryWastageTab({ apiParams }: Props) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { data, isLoading, error } = useGetInventoryWastage(apiParams);
  const { mutate: recordWastage, isPending } = usePostBaseItemWastage();

  const [open, setOpen] = useState(false);
  const [actionId, setActionId] = useState(() => crypto.randomUUID());
  const [form, setForm] = useState({
    baseItemId: "",
    locationId: "",
    quantity: "",
    unitOfMeasure: "unit",
    reason: "damaged_on_receipt",
    notes: "",
    unitCost: "",
  });

  function handleSubmit() {
    const id = parseInt(form.baseItemId, 10);
    const locationId = parseInt(form.locationId, 10);
    const qty = parseFloat(form.quantity);
    if (Number.isNaN(id) || Number.isNaN(locationId) || Number.isNaN(qty) || qty <= 0) return;
    recordWastage(
      {
        data: {
          actionId,
          baseItemId: id,
          locationId,
          quantity: qty,
          unitOfMeasure: form.unitOfMeasure,
          reason: form.reason,
          notes: form.notes || undefined,
          unitCost: form.unitCost ? parseFloat(form.unitCost) : undefined,
        },
      },
      {
        onSuccess: () => {
          setOpen(false);
          setActionId(crypto.randomUUID());
          setForm({ baseItemId: "", locationId: "", quantity: "", unitOfMeasure: "unit", reason: "damaged_on_receipt", notes: "", unitCost: "" });
          qc.invalidateQueries({ queryKey: ["getInventoryWastage"] });
        },
      },
    );
  }

  if (isLoading) return <Skeleton className="h-64 w-full rounded-lg" />;
  if (error || !data) return <p className="text-sm text-destructive">{t("inventory.loadError")}</p>;

  const { kpis, byBaseItem, byReason, byWeek, records } = data;

  const weekData = byWeek.map((w) => ({
    week: format(new Date(w.weekStart), "dd MMM"),
    value: Number(w.wasteValue),
    qty: Number(w.wasteQty),
  }));

  return (
    <div className="flex flex-col gap-6">
      {/* KPI strip + record button */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 flex-1">
          <Card>
            <CardContent className="pt-4 pb-3">
              <p className="text-xs text-muted-foreground">{t("inventory.wastage.totalValue")}</p>
              <p className="text-xl font-semibold mt-1">${fmt(kpis.wasteValue)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-3">
              <p className="text-xs text-muted-foreground">{t("inventory.wastage.totalQty")}</p>
              <p className="text-xl font-semibold mt-1">{fmt(kpis.wasteQty, 2)}</p>
            </CardContent>
          </Card>
          {kpis.wasteAsPctOfPurchases != null && (
            <Card>
              <CardContent className="pt-4 pb-3">
                <p className="text-xs text-muted-foreground">{t("inventory.wastage.pctOfPurchases")}</p>
                <p className="text-xl font-semibold mt-1">{fmt(kpis.wasteAsPctOfPurchases)}%</p>
              </CardContent>
            </Card>
          )}
        </div>
        <Button size="sm" className="gap-1 h-8 text-xs" onClick={() => setOpen(true)}>
          <Plus className="h-3 w-3" />
          {t("inventory.wastage.record")}
        </Button>
      </div>

      {/* By week chart */}
      {weekData.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{t("inventory.wastage.byWeek")}</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={weekData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="week" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(v: number) => `$${v}`} />
                <Tooltip formatter={(v: number) => `$${fmt(v)}`} />
                <Bar dataKey="value" fill="#ef4444" name={t("inventory.wastage.value")} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* By item + by reason side by side */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{t("inventory.wastage.byItem")}</CardTitle>
          </CardHeader>
          <CardContent className="p-0 overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th className="text-start px-3 py-2 font-medium">{t("inventory.table.baseItem")}</th>
                  <th className="text-end px-3 py-2 font-medium">{t("inventory.wastage.qty")}</th>
                  <th className="text-end px-3 py-2 font-medium">{t("inventory.wastage.value")}</th>
                </tr>
              </thead>
              <tbody>
                {byBaseItem.map((b) => (
                  <tr key={b.baseItemId} className="border-b last:border-0">
                    <td className="px-3 py-1.5">{b.baseItemName}</td>
                    <td className="px-3 py-1.5 text-end font-mono">{fmt(b.wasteQty, 2)}</td>
                    <td className="px-3 py-1.5 text-end font-mono">${fmt(b.wasteValue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{t("inventory.wastage.byReason")}</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th className="text-start px-3 py-2 font-medium">{t("inventory.wastage.reason")}</th>
                  <th className="text-end px-3 py-2 font-medium">{t("inventory.wastage.qty")}</th>
                  <th className="text-end px-3 py-2 font-medium">{t("inventory.wastage.value")}</th>
                </tr>
              </thead>
              <tbody>
                {byReason.map((r) => (
                  <tr key={r.reason} className="border-b last:border-0">
                    <td className="px-3 py-1.5 capitalize">{r.reason.replace(/_/g, " ")}</td>
                    <td className="px-3 py-1.5 text-end font-mono">{fmt(r.wasteQty, 2)}</td>
                    <td className="px-3 py-1.5 text-end font-mono">${fmt(r.wasteValue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>

      {/* Recent records */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">{t("inventory.wastage.recentRecords")}</CardTitle>
        </CardHeader>
        <CardContent className="p-0 overflow-x-auto">
          <table className="w-full text-xs min-w-[600px]">
            <thead>
              <tr className="border-b text-muted-foreground">
                <th className="text-start px-3 py-2 font-medium">{t("inventory.table.date")}</th>
                <th className="text-start px-3 py-2 font-medium">{t("inventory.table.baseItem")}</th>
                <th className="text-start px-3 py-2 font-medium">{t("inventory.table.location")}</th>
                <th className="text-end px-3 py-2 font-medium">{t("inventory.wastage.qty")}</th>
                <th className="text-start px-3 py-2 font-medium">{t("inventory.wastage.reason")}</th>
                <th className="text-end px-3 py-2 font-medium">{t("inventory.wastage.value")}</th>
              </tr>
            </thead>
            <tbody>
              {records.length === 0 && (
                <tr>
                  <td colSpan={6} className="text-center text-muted-foreground py-6">{t("inventory.noData")}</td>
                </tr>
              )}
              {records.map((r) => (
                <tr key={r.id} className="border-b last:border-0 hover:bg-muted/30">
                  <td className="px-3 py-1.5">{format(new Date(r.createdAt), "dd MMM HH:mm")}</td>
                  <td className="px-3 py-1.5">{r.baseItemName}</td>
                  <td className="px-3 py-1.5 text-muted-foreground">{r.locationName || "—"}</td>
                  <td className="px-3 py-1.5 text-end font-mono">{fmt(r.quantity, 2)} {r.unitOfMeasure ?? ""}</td>
                  <td className="px-3 py-1.5 capitalize">{r.reason.replace(/_/g, " ")}</td>
                  <td className="px-3 py-1.5 text-end font-mono text-red-600">${fmt(r.wasteValue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {/* Record wastage dialog */}
      <Dialog open={open} onOpenChange={(value) => {
        if (!value) setActionId(crypto.randomUUID());
        setOpen(value);
      }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("inventory.wastage.dialogTitle")}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 py-2">
            <div>
              <Label className="text-xs">{t("inventory.wastage.baseItemId")}</Label>
              <Input className="h-8 mt-1 text-xs" value={form.baseItemId} onChange={(e) => setForm((f) => ({ ...f, baseItemId: e.target.value }))} placeholder="ID" />
            </div>
            <div>
              <Label className="text-xs">Location ID</Label>
              <Input className="h-8 mt-1 text-xs" value={form.locationId} onChange={(e) => setForm((f) => ({ ...f, locationId: e.target.value }))} placeholder="ID" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-xs">{t("inventory.wastage.qty")}</Label>
                <Input className="h-8 mt-1 text-xs" type="number" min={0} value={form.quantity} onChange={(e) => setForm((f) => ({ ...f, quantity: e.target.value }))} />
              </div>
              <div>
                <Label className="text-xs">{t("inventory.wastage.unit")}</Label>
                <Input className="h-8 mt-1 text-xs" value={form.unitOfMeasure} onChange={(e) => setForm((f) => ({ ...f, unitOfMeasure: e.target.value }))} />
              </div>
            </div>
            <div>
              <Label className="text-xs">{t("inventory.wastage.reason")}</Label>
              <Select value={form.reason} onValueChange={(v) => setForm((f) => ({ ...f, reason: v }))}>
                <SelectTrigger className="h-8 mt-1 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {WASTAGE_REASONS.map((r) => (
                    <SelectItem key={r} value={r} className="text-xs capitalize">{r.replace(/_/g, " ")}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">{t("inventory.wastage.unitCost")}</Label>
              <Input className="h-8 mt-1 text-xs" type="number" min={0} value={form.unitCost} onChange={(e) => setForm((f) => ({ ...f, unitCost: e.target.value }))} placeholder="Optional" />
            </div>
            <div>
              <Label className="text-xs">{t("inventory.wastage.notes")}</Label>
              <Textarea className="mt-1 text-xs" rows={2} value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setOpen(false)}>{t("inventory.wastage.cancel")}</Button>
            <Button size="sm" disabled={isPending} onClick={handleSubmit}>
              {isPending ? t("inventory.wastage.saving") : t("inventory.wastage.save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
