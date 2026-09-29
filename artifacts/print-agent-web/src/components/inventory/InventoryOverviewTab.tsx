import { useTranslation } from "react-i18next";
import { useGetInventoryOverview, useGetInventoryCogsTarget, usePutInventoryCogsTarget } from "@workspace/api-client-react";
import type { GetInventoryOverviewParams } from "@workspace/api-client-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useState } from "react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  BarChart,
  Bar,
  Cell,
} from "recharts";
import { format } from "date-fns";

function fmt(v: number, decimals = 1) {
  return v.toLocaleString("en", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtPct(v: number | null | undefined) {
  if (v == null) return "—";
  return `${fmt(v, 1)}%`;
}

interface Props {
  apiParams: GetInventoryOverviewParams;
}

export default function InventoryOverviewTab({ apiParams }: Props) {
  const { t } = useTranslation();
  const { data, isLoading, error } = useGetInventoryOverview(apiParams);
  const { data: targetData } = useGetInventoryCogsTarget();
  const { mutate: saveTarget, isPending: savingTarget } = usePutInventoryCogsTarget();
  const [targetInput, setTargetInput] = useState<string>("");
  const [showTargetEdit, setShowTargetEdit] = useState(false);

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-28 rounded-lg" />
        ))}
      </div>
    );
  }

  if (error || !data) {
    return <p className="text-sm text-destructive">{t("inventory.loadError")}</p>;
  }

  const { kpis, weeklyCogsTrend, cogsByLocation, largestCogsDrivers } = data;
  const target = targetData?.target;

  const kpiCards = [
    {
      label: t("inventory.kpi.netRevenue"),
      value: `$${fmt(kpis.netRevenue)}`,
      hint: null,
    },
    {
      label: t("inventory.kpi.actualCogs"),
      value: `$${fmt(kpis.actualCogs)}`,
      hint: fmtPct(kpis.actualCogsPct),
    },
    {
      label: t("inventory.kpi.theoreticalCogs"),
      value: `$${fmt(kpis.theoreticalCogs)}`,
      hint: fmtPct(kpis.theoreticalCogsPct),
    },
    {
      label: t("inventory.kpi.cogsGap"),
      value: kpis.cogsGap != null ? `$${fmt(kpis.cogsGap)}` : "—",
      hint: null,
      alert: (kpis.cogsGap ?? 0) > 0,
    },
    {
      label: t("inventory.kpi.grossMargin"),
      value: fmtPct(kpis.grossMarginPct),
      hint: null,
    },
    {
      label: t("inventory.kpi.purchaseValue"),
      value: `$${fmt(kpis.purchaseValue)}`,
      hint: null,
    },
    {
      label: t("inventory.kpi.recipeValue"),
      value: `$${fmt(kpis.recipeValue)}`,
      hint: null,
    },
    {
      label: t("inventory.kpi.wasteValue"),
      value: `$${fmt(kpis.wasteValue)}`,
      hint: null,
      alert: kpis.wasteValue > 0,
    },
  ];

  const trendData = weeklyCogsTrend.map((w) => ({
    week: format(new Date(w.weekStart), "dd MMM"),
    actual: Number(w.actualCogs),
    theoretical: Number(w.theoreticalCogs),
    revenue: Number(w.netRevenue),
    target: w.targetCogsPct != null ? (Number(w.netRevenue) * w.targetCogsPct) / 100 : null,
  }));

  return (
    <div className="flex flex-col gap-6">
      {/* KPI cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {kpiCards.map((card, i) => (
          <Card key={i} className={card.alert ? "border-amber-400" : ""}>
            <CardContent className="pt-4 pb-3">
              <p className="text-xs text-muted-foreground">{card.label}</p>
              <p className="text-xl font-semibold mt-1">{card.value}</p>
              {card.hint && <p className="text-xs text-muted-foreground">{card.hint}</p>}
            </CardContent>
          </Card>
        ))}
      </div>

      {/* COGS target */}
      <Card>
        <CardHeader className="pb-2 flex flex-row items-center justify-between">
          <CardTitle className="text-sm">{t("inventory.cogsTarget.title")}</CardTitle>
          <Button variant="ghost" size="sm" className="text-xs h-7" onClick={() => { setShowTargetEdit(e => !e); setTargetInput(String(target?.targetCogsPct ?? "")); }}>
            {showTargetEdit ? t("inventory.cogsTarget.cancel") : t("inventory.cogsTarget.edit")}
          </Button>
        </CardHeader>
        <CardContent>
          {showTargetEdit ? (
            <div className="flex items-end gap-2">
              <div>
                <Label className="text-xs">{t("inventory.cogsTarget.targetPct")}</Label>
                <Input
                  type="number"
                  min={0}
                  max={100}
                  className="h-8 w-28 text-xs mt-1"
                  value={targetInput}
                  onChange={(e) => setTargetInput(e.target.value)}
                />
              </div>
              <Button
                size="sm"
                className="h-8 text-xs"
                disabled={savingTarget}
                onClick={() => {
                  const pct = parseFloat(targetInput);
                  if (Number.isNaN(pct) || pct < 0 || pct > 100) return;
                  saveTarget({ data: { targetCogsPct: pct } }, { onSuccess: () => setShowTargetEdit(false) });
                }}
              >
                {savingTarget ? t("inventory.cogsTarget.saving") : t("inventory.cogsTarget.save")}
              </Button>
            </div>
          ) : (
            <p className="text-sm">
              {target
                ? `${fmt(target.targetCogsPct, 1)}% — ${t("inventory.cogsTarget.effectiveFrom")} ${format(new Date(target.effectiveFrom), "dd MMM yyyy")}`
                : t("inventory.cogsTarget.notSet")}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Weekly trend chart */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">{t("inventory.chart.weeklyTrend")}</CardTitle>
        </CardHeader>
        <CardContent>
          {trendData.length === 0 ? (
            <p className="text-xs text-muted-foreground py-4">{t("inventory.noData")}</p>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={trendData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="actualGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#0ea5e9" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#0ea5e9" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="theoreticalGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#a855f7" stopOpacity={0.2} />
                    <stop offset="95%" stopColor="#a855f7" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                <XAxis dataKey="week" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} width={48} tickFormatter={(v: number) => `$${v}`} />
                <Tooltip formatter={(v: number) => `$${fmt(v)}`} />
                {trendData[0]?.target != null && (
                  <ReferenceLine y={trendData[0].target} stroke="#f59e0b" strokeDasharray="4 4" label={{ value: t("inventory.chart.target"), fontSize: 10 }} />
                )}
                <Area type="monotone" dataKey="theoretical" stroke="#a855f7" strokeDasharray="4 4" fill="url(#theoreticalGrad)" name={t("inventory.chart.theoretical")} />
                <Area type="monotone" dataKey="actual" stroke="#0ea5e9" fill="url(#actualGrad)" name={t("inventory.chart.actual")} />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      {/* COGS by location */}
      {cogsByLocation.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{t("inventory.chart.cogsByLocation")}</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={180}>
              <BarChart data={cogsByLocation} layout="vertical" margin={{ left: 80, right: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 11 }} tickFormatter={(v: number) => `$${v}`} />
                <YAxis type="category" dataKey="locationName" tick={{ fontSize: 11 }} width={80} />
                <Tooltip formatter={(v: number) => `$${fmt(v)}`} />
                <Bar dataKey="actualCogs" fill="#0ea5e9" name={t("inventory.kpi.actualCogs")} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* Largest COGS drivers */}
      {largestCogsDrivers.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">{t("inventory.chart.largestDrivers")}</CardTitle>
          </CardHeader>
          <CardContent>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-muted-foreground border-b">
                  <th className="text-start py-1.5 font-medium">{t("inventory.table.baseItem")}</th>
                  <th className="text-start py-1.5 font-medium">{t("inventory.table.movementType")}</th>
                  <th className="text-end py-1.5 font-medium">{t("inventory.table.costImpact")}</th>
                </tr>
              </thead>
              <tbody>
                {largestCogsDrivers.map((d, i) => (
                  <tr key={i} className="border-b last:border-0">
                    <td className="py-1.5">{d.baseItemName}</td>
                    <td className="py-1.5 capitalize">{d.movementType.replace(/_/g, " ")}</td>
                    <td className="py-1.5 text-end font-mono">${fmt(d.costImpact)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
