import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { apiFetch } from "@/lib/queryClient";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Calendar } from "@/components/ui/calendar";
import { CalendarDays, Info, X } from "lucide-react";
import {
  DATE_PRESETS,
  COMPARE_MODES,
  type CompareMode,
  type UseStoreAnalyticsFilters,
} from "@/hooks/use-store-analytics-filters";
import { COUNTRY_CATALOGUE } from "@/lib/countries";

const ALL = "__all__";

type CityRow = { id: number; name: string; country: string; is_active: boolean };
type BrandRow = { id: number; name: string };
type ChannelRow = { id: number; name: string };

function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function StoreAnalyticsFilterBar({
  filters,
}: {
  filters: UseStoreAnalyticsFilters;
}) {
  const { t } = useTranslation();

  const { data: citiesData } = useQuery({
    queryKey: ["/api/cities"],
    queryFn: () => apiFetch<{ cities: CityRow[] }>("/api/cities"),
  });
  const { data: brandsData } = useQuery({
    queryKey: ["/api/brands"],
    queryFn: () => apiFetch<{ brands: BrandRow[] }>("/api/brands"),
  });
  const { data: channelsData } = useQuery({
    queryKey: ["/api/channels"],
    queryFn: () => apiFetch<{ channels: ChannelRow[] }>("/api/channels"),
  });

  const cities = citiesData?.cities ?? [];
  const brands = brandsData?.brands ?? [];
  const channels = channelsData?.channels ?? [];

  // Country options: distinct countries that have cities, mapped to ISO code.
  const countryOptions = useMemo(() => {
    const names = Array.from(new Set(cities.map((c) => c.country).filter(Boolean)));
    return names
      .map((name) => {
        const entry = COUNTRY_CATALOGUE.find(
          (c) => c.name.toLowerCase() === name.toLowerCase(),
        );
        return entry ? { code: entry.code, name } : null;
      })
      .filter((x): x is { code: string; name: string } => x !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [cities]);

  const customFromDate = filters.customFrom ? new Date(filters.customFrom) : undefined;
  const customToDate = filters.customTo ? new Date(filters.customTo) : undefined;

  const customLabel =
    filters.customFrom && filters.customTo
      ? `${filters.customFrom} → ${filters.customTo}`
      : t("storeAnalytics.presets.custom");

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {/* Date preset */}
        <Select value={filters.preset} onValueChange={(v) => filters.setPreset(v as never)}>
          <SelectTrigger className="w-[150px]" data-testid="select-date-preset">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DATE_PRESETS.map((p) => (
              <SelectItem key={p.value} value={p.value}>
                {t(p.labelKey)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {filters.preset === "custom" && (
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" className="gap-2" data-testid="button-custom-range">
                <CalendarDays size={16} />
                <span className="text-sm">{customLabel}</span>
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <div className="flex flex-col gap-2 p-3 sm:flex-row">
                <div>
                  <p className="mb-1 px-1 text-xs text-muted-foreground">
                    {t("storeAnalytics.from")}
                  </p>
                  <Calendar
                    mode="single"
                    selected={customFromDate}
                    onSelect={(d) =>
                      filters.setCustomRange(
                        d ? toISODate(d) : null,
                        filters.customTo,
                      )
                    }
                  />
                </div>
                <div>
                  <p className="mb-1 px-1 text-xs text-muted-foreground">
                    {t("storeAnalytics.to")}
                  </p>
                  <Calendar
                    mode="single"
                    selected={customToDate}
                    onSelect={(d) =>
                      filters.setCustomRange(
                        filters.customFrom,
                        d ? toISODate(d) : null,
                      )
                    }
                  />
                </div>
              </div>
            </PopoverContent>
          </Popover>
        )}

        {/* Country */}
        <Select
          value={filters.country ?? ALL}
          onValueChange={(v) => filters.setFilter("country", v === ALL ? null : v)}
        >
          <SelectTrigger className="w-[150px]" data-testid="select-country">
            <SelectValue placeholder={t("storeAnalytics.allCountries")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("storeAnalytics.allCountries")}</SelectItem>
            {countryOptions.map((c) => (
              <SelectItem key={c.code} value={c.code}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* City */}
        <Select
          value={filters.city ?? ALL}
          onValueChange={(v) => filters.setFilter("city", v === ALL ? null : v)}
        >
          <SelectTrigger className="w-[150px]" data-testid="select-city">
            <SelectValue placeholder={t("storeAnalytics.allCities")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("storeAnalytics.allCities")}</SelectItem>
            {cities.map((c) => (
              <SelectItem key={c.id} value={String(c.id)}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Brand */}
        <Select
          value={filters.brand ?? ALL}
          onValueChange={(v) => filters.setFilter("brand", v === ALL ? null : v)}
        >
          <SelectTrigger className="w-[150px]" data-testid="select-brand">
            <SelectValue placeholder={t("storeAnalytics.allBrands")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("storeAnalytics.allBrands")}</SelectItem>
            {brands.map((b) => (
              <SelectItem key={b.id} value={b.name}>
                {b.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/* Channel */}
        <Select
          value={filters.channel ?? ALL}
          onValueChange={(v) => filters.setFilter("channel", v === ALL ? null : v)}
        >
          <SelectTrigger className="w-[150px]" data-testid="select-channel">
            <SelectValue placeholder={t("storeAnalytics.allChannels")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t("storeAnalytics.allChannels")}</SelectItem>
            {channels.map((c) => (
              <SelectItem key={c.id} value={c.name}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {filters.hasActiveFilters && (
          <Button
            variant="ghost"
            size="sm"
            className="gap-1"
            onClick={filters.clearAll}
            data-testid="button-clear-filters"
          >
            <X size={14} />
            {t("storeAnalytics.clearFilters")}
          </Button>
        )}

        <div className="ml-auto flex items-center gap-2">
          <span className="text-sm text-muted-foreground">
            {t("storeAnalytics.compare.label")}
          </span>
          <Select
            value={filters.compareMode}
            onValueChange={(v) => filters.setCompareMode(v as CompareMode)}
          >
            <SelectTrigger className="w-[190px]" data-testid="select-compare-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {COMPARE_MODES.map((m) => (
                <SelectItem key={m.value} value={m.value}>
                  {t(m.labelKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {filters.compareMode === "custom" && (
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline" className="gap-2" data-testid="button-compare-range">
                  <CalendarDays size={16} />
                  <span className="text-sm">
                    {filters.compareFrom && filters.compareTo
                      ? `${filters.compareFrom} → ${filters.compareTo}`
                      : t("storeAnalytics.compare.pickRange")}
                  </span>
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="end">
                <div className="flex flex-col gap-2 p-3 sm:flex-row">
                  <div>
                    <p className="mb-1 px-1 text-xs text-muted-foreground">
                      {t("storeAnalytics.from")}
                    </p>
                    <Calendar
                      mode="single"
                      selected={
                        filters.compareFrom ? new Date(filters.compareFrom) : undefined
                      }
                      onSelect={(d) =>
                        filters.setCompareRange(
                          d ? toISODate(d) : null,
                          filters.compareTo,
                        )
                      }
                    />
                  </div>
                  <div>
                    <p className="mb-1 px-1 text-xs text-muted-foreground">
                      {t("storeAnalytics.to")}
                    </p>
                    <Calendar
                      mode="single"
                      selected={
                        filters.compareTo ? new Date(filters.compareTo) : undefined
                      }
                      onSelect={(d) =>
                        filters.setCompareRange(
                          filters.compareFrom,
                          d ? toISODate(d) : null,
                        )
                      }
                    />
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          )}
        </div>
      </div>
    </div>
  );
}

/** Format an ISO date/datetime as a short local date, e.g. "Jul 1, 2026". */
export function formatRangeDate(iso: string, locale: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Comparison line + reporting-basis strip rendered directly under the filter
 * bar. Dates come from the server response so the user sees the exact windows
 * the numbers were computed against.
 */
export function StoreAnalyticsBasisStrip({
  range,
  comparison,
  comparisonMode,
}: {
  range: { from: string; to: string } | null;
  comparison: { from: string; to: string } | null;
  comparisonMode: string | null;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.language === "ar" ? "ar" : "en";

  // The API's `to` bound is exclusive; show the last included day.
  const lastIncluded = (iso: string) => {
    const d = new Date(iso);
    d.setUTCMilliseconds(d.getUTCMilliseconds() - 1);
    return d.toISOString();
  };

  const modeLabel =
    comparisonMode === "previous"
      ? t("storeAnalytics.compare.previous")
      : comparisonMode === "last_year"
        ? t("storeAnalytics.compare.lastYear")
        : comparisonMode === "custom"
          ? t("storeAnalytics.compare.custom")
          : null;

  return (
    <div className="flex flex-col gap-1" data-testid="basis-strip">
      {comparison && range && (
        <p className="text-xs text-muted-foreground" data-testid="text-comparing-dates">
          {t("storeAnalytics.compare.comparing", {
            currentFrom: formatRangeDate(range.from, locale),
            currentTo: formatRangeDate(lastIncluded(range.to), locale),
            baselineFrom: formatRangeDate(comparison.from, locale),
            baselineTo: formatRangeDate(lastIncluded(comparison.to), locale),
            mode: modeLabel ?? "",
          })}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <span data-testid="text-reporting-basis">{t("storeAnalytics.basis.strip")}</span>
        <Dialog>
          <DialogTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center gap-1 underline underline-offset-2 hover:text-foreground"
              data-testid="button-methodology"
            >
              <Info size={12} />
              {t("storeAnalytics.basis.methodology")}
            </button>
          </DialogTrigger>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>{t("storeAnalytics.basis.methodologyTitle")}</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 text-sm text-muted-foreground">
              <p>{t("storeAnalytics.basis.methodologyRevenue")}</p>
              <p>{t("storeAnalytics.basis.methodologyStatuses")}</p>
              <p>{t("storeAnalytics.basis.methodologyFx")}</p>
              <p>{t("storeAnalytics.basis.methodologyCogs")}</p>
              <p>{t("storeAnalytics.basis.methodologyComparison")}</p>
            </div>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
