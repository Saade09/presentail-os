import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { CalendarIcon } from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import {
  useInventoryAnalyticsFilters,
  INVENTORY_DATE_PRESETS,
} from "@/hooks/use-inventory-analytics-filters";
import InventoryOverviewTab from "@/components/inventory/InventoryOverviewTab";
import InventoryMovementsTab from "@/components/inventory/InventoryMovementsTab";
import InventoryVarianceTab from "@/components/inventory/InventoryVarianceTab";
import InventoryWastageTab from "@/components/inventory/InventoryWastageTab";
import InventoryProcurementTab from "@/components/inventory/InventoryProcurementTab";
import InventoryTransfersTab from "@/components/inventory/InventoryTransfersTab";
import InventoryTheoreticalCostTab from "@/components/inventory/InventoryTheoreticalCostTab";
import InventoryActualCostTab from "@/components/inventory/InventoryActualCostTab";

type Tab =
  | "overview"
  | "movements"
  | "variance"
  | "wastage"
  | "procurement"
  | "transfers"
  | "theoretical"
  | "actual";

const TABS: Tab[] = [
  "overview",
  "movements",
  "variance",
  "wastage",
  "procurement",
  "transfers",
  "theoretical",
  "actual",
];

export default function InventoryCogsAnalytics() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("overview");
  const filters = useInventoryAnalyticsFilters();
  const { preset, customFrom, customTo, resolvedRange, setPreset, setCustomFrom, setCustomTo, apiParams } =
    filters;

  return (
    <div className="flex flex-col gap-4 p-4 md:p-6">
      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold">{t("inventory.title")}</h1>
        <p className="text-sm text-muted-foreground mt-0.5">{t("inventory.subtitle")}</p>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={preset} onValueChange={(v) => setPreset(v as typeof preset)}>
          <SelectTrigger className="h-8 w-[148px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {INVENTORY_DATE_PRESETS.map((p) => (
              <SelectItem key={p.value} value={p.value} className="text-xs">
                {t(p.labelKey)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {preset === "custom" && (
          <>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className={cn("h-8 text-xs gap-1", !customFrom && "text-muted-foreground")}
                >
                  <CalendarIcon className="h-3 w-3" />
                  {customFrom
                    ? format(new Date(customFrom), "dd MMM yyyy")
                    : t("inventory.filters.from")}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={customFrom ? new Date(customFrom) : undefined}
                  onSelect={(d) => setCustomFrom(d ? format(d, "yyyy-MM-dd") : null)}
                />
              </PopoverContent>
            </Popover>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className={cn("h-8 text-xs gap-1", !customTo && "text-muted-foreground")}
                >
                  <CalendarIcon className="h-3 w-3" />
                  {customTo
                    ? format(new Date(customTo), "dd MMM yyyy")
                    : t("inventory.filters.to")}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={customTo ? new Date(customTo) : undefined}
                  onSelect={(d) => setCustomTo(d ? format(d, "yyyy-MM-dd") : null)}
                />
              </PopoverContent>
            </Popover>
          </>
        )}

        <span className="text-xs text-muted-foreground hidden sm:block">
          {format(resolvedRange.from, "dd MMM yyyy")} – {format(resolvedRange.to, "dd MMM yyyy")}
        </span>
      </div>

      {/* Tabs */}
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="w-full">
        <TabsList className="flex flex-wrap h-auto gap-1 justify-start bg-transparent p-0 border-b rounded-none pb-2 overflow-x-auto">
          {TABS.map((t_) => (
            <TabsTrigger
              key={t_}
              value={t_}
              className="rounded-md data-[state=active]:bg-primary data-[state=active]:text-primary-foreground text-xs px-3 py-1.5 shrink-0"
            >
              {t(`inventory.tabs.${t_}`)}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="overview" className="mt-4">
          <InventoryOverviewTab apiParams={apiParams} />
        </TabsContent>
        <TabsContent value="movements" className="mt-4">
          <InventoryMovementsTab apiParams={apiParams} filters={filters} />
        </TabsContent>
        <TabsContent value="variance" className="mt-4">
          <InventoryVarianceTab apiParams={apiParams} />
        </TabsContent>
        <TabsContent value="wastage" className="mt-4">
          <InventoryWastageTab apiParams={apiParams} />
        </TabsContent>
        <TabsContent value="procurement" className="mt-4">
          <InventoryProcurementTab apiParams={apiParams} filters={filters} />
        </TabsContent>
        <TabsContent value="transfers" className="mt-4">
          <InventoryTransfersTab apiParams={apiParams} />
        </TabsContent>
        <TabsContent value="theoretical" className="mt-4">
          <InventoryTheoreticalCostTab apiParams={apiParams} />
        </TabsContent>
        <TabsContent value="actual" className="mt-4">
          <InventoryActualCostTab apiParams={apiParams} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
