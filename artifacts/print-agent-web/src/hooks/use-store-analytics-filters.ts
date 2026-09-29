import { useCallback, useMemo } from "react";
import { useSearch, useLocation } from "wouter";
import type { GetStoreExecutiveOverviewParams } from "@workspace/api-client-react";

export type DatePreset =
  | "today"
  | "yesterday"
  | "this_week"
  | "last_week"
  | "this_month"
  | "custom";

export type CompareMode = "none" | "previous" | "last_year" | "custom";

export const COMPARE_MODES: { value: CompareMode; labelKey: string }[] = [
  { value: "none", labelKey: "storeAnalytics.compare.none" },
  { value: "previous", labelKey: "storeAnalytics.compare.previous" },
  { value: "last_year", labelKey: "storeAnalytics.compare.lastYear" },
  { value: "custom", labelKey: "storeAnalytics.compare.custom" },
];

export const DATE_PRESETS: { value: DatePreset; labelKey: string }[] = [
  { value: "today", labelKey: "storeAnalytics.presets.today" },
  { value: "yesterday", labelKey: "storeAnalytics.presets.yesterday" },
  { value: "this_week", labelKey: "storeAnalytics.presets.thisWeek" },
  { value: "last_week", labelKey: "storeAnalytics.presets.lastWeek" },
  { value: "this_month", labelKey: "storeAnalytics.presets.thisMonth" },
  { value: "custom", labelKey: "storeAnalytics.presets.custom" },
];

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** Monday-based start of the week containing `d`. */
function startOfWeek(d: Date): Date {
  const x = startOfDay(d);
  const dow = (x.getDay() + 6) % 7; // 0 = Monday
  return addDays(x, -dow);
}

function startOfMonth(d: Date): Date {
  const x = startOfDay(d);
  x.setDate(1);
  return x;
}

/**
 * Resolve a preset (or a custom range) to an inclusive-start / exclusive-end
 * pair. The backend compares `ordered_at < to`, so `to` is the start of the
 * day *after* the last included day.
 */
export function resolvePresetRange(
  preset: DatePreset,
  customFrom: string | null,
  customTo: string | null,
): { from: Date; to: Date } {
  const now = new Date();
  switch (preset) {
    case "today": {
      const from = startOfDay(now);
      return { from, to: addDays(from, 1) };
    }
    case "yesterday": {
      const from = addDays(startOfDay(now), -1);
      return { from, to: addDays(from, 1) };
    }
    case "this_week": {
      const from = startOfWeek(now);
      return { from, to: addDays(startOfDay(now), 1) };
    }
    case "last_week": {
      const thisWeek = startOfWeek(now);
      return { from: addDays(thisWeek, -7), to: thisWeek };
    }
    case "this_month": {
      const from = startOfMonth(now);
      return { from, to: addDays(startOfDay(now), 1) };
    }
    case "custom": {
      const f = customFrom ? startOfDay(new Date(customFrom)) : addDays(startOfDay(now), -6);
      const t = customTo ? addDays(startOfDay(new Date(customTo)), 1) : addDays(startOfDay(now), 1);
      return { from: f, to: t };
    }
  }
}

export type StoreAnalyticsFilterState = {
  preset: DatePreset;
  customFrom: string | null;
  customTo: string | null;
  /** Legacy boolean kept for existing sections; true when compareMode !== "none". */
  compare: boolean;
  compareMode: CompareMode;
  compareFrom: string | null;
  compareTo: string | null;
  country: string | null;
  city: string | null;
  brand: string | null;
  channel: string | null;
};

export type UseStoreAnalyticsFilters = StoreAnalyticsFilterState & {
  /** Resolved params ready for useGetStoreExecutiveOverview. */
  apiParams: GetStoreExecutiveOverviewParams;
  resolvedRange: { from: Date; to: Date };
  setPreset: (preset: DatePreset) => void;
  setCustomRange: (from: string | null, to: string | null) => void;
  setCompare: (compare: boolean) => void;
  setCompareMode: (mode: CompareMode) => void;
  setCompareRange: (from: string | null, to: string | null) => void;
  setFilter: (key: "country" | "city" | "brand" | "channel", value: string | null) => void;
  clearAll: () => void;
  hasActiveFilters: boolean;
};

function isPreset(v: string | null): v is DatePreset {
  return (
    v === "today" ||
    v === "yesterday" ||
    v === "this_week" ||
    v === "last_week" ||
    v === "this_month" ||
    v === "custom"
  );
}

function isCompareMode(v: string | null): v is CompareMode {
  return v === "none" || v === "previous" || v === "last_year" || v === "custom";
}

export function useStoreAnalyticsFilters(): UseStoreAnalyticsFilters {
  const search = useSearch();
  const [location, setLocation] = useLocation();

  const params = useMemo(() => new URLSearchParams(search), [search]);

  const presetRaw = params.get("preset");
  const preset: DatePreset = isPreset(presetRaw) ? presetRaw : "this_month";
  const customFrom = params.get("from");
  const customTo = params.get("to");
  const compareModeRaw = params.get("compareMode");
  // Legacy URLs used compare=1 for previous-period comparison.
  const compareMode: CompareMode = isCompareMode(compareModeRaw)
    ? compareModeRaw
    : params.get("compare") === "1"
      ? "previous"
      : "none";
  const compareFrom = params.get("compareFrom");
  const compareTo = params.get("compareTo");
  const country = params.get("country");
  const city = params.get("city");
  const brand = params.get("brand");
  const channel = params.get("channel");

  const update = useCallback(
    (mutate: (p: URLSearchParams) => void) => {
      const next = new URLSearchParams(search);
      mutate(next);
      const qs = next.toString();
      setLocation(qs ? `${location}?${qs}` : location, { replace: true });
    },
    [search, location, setLocation],
  );

  const setPreset = useCallback(
    (p: DatePreset) => {
      update((next) => {
        next.set("preset", p);
        if (p !== "custom") {
          next.delete("from");
          next.delete("to");
        }
      });
    },
    [update],
  );

  const setCustomRange = useCallback(
    (from: string | null, to: string | null) => {
      update((next) => {
        next.set("preset", "custom");
        if (from) next.set("from", from);
        else next.delete("from");
        if (to) next.set("to", to);
        else next.delete("to");
      });
    },
    [update],
  );

  const setCompareMode = useCallback(
    (mode: CompareMode) => {
      update((next) => {
        next.delete("compare");
        if (mode === "none") next.delete("compareMode");
        else next.set("compareMode", mode);
        if (mode !== "custom") {
          next.delete("compareFrom");
          next.delete("compareTo");
        }
      });
    },
    [update],
  );

  const setCompareRange = useCallback(
    (from: string | null, to: string | null) => {
      update((next) => {
        next.delete("compare");
        next.set("compareMode", "custom");
        if (from) next.set("compareFrom", from);
        else next.delete("compareFrom");
        if (to) next.set("compareTo", to);
        else next.delete("compareTo");
      });
    },
    [update],
  );

  const setCompare = useCallback(
    (c: boolean) => setCompareMode(c ? "previous" : "none"),
    [setCompareMode],
  );

  const setFilter = useCallback(
    (key: "country" | "city" | "brand" | "channel", value: string | null) => {
      update((next) => {
        if (value) next.set(key, value);
        else next.delete(key);
      });
    },
    [update],
  );

  const clearAll = useCallback(() => {
    update((next) => {
      next.delete("country");
      next.delete("city");
      next.delete("brand");
      next.delete("channel");
    });
  }, [update]);

  const resolvedRange = useMemo(
    () => resolvePresetRange(preset, customFrom, customTo),
    [preset, customFrom, customTo],
  );

  const apiParams = useMemo<GetStoreExecutiveOverviewParams>(() => {
    const p: GetStoreExecutiveOverviewParams = {
      from: resolvedRange.from.toISOString(),
      to: resolvedRange.to.toISOString(),
    };
    if (compareMode !== "none") {
      // Legacy flag keeps older sections (which read previousKpis) working.
      p.compare = true;
      p.compareMode = compareMode;
      if (compareMode === "custom") {
        if (compareFrom) {
          p.compareFrom = new Date(compareFrom + "T00:00:00").toISOString();
        }
        if (compareTo) {
          // Inclusive end-of-day, mirroring resolvePresetRange.
          const t = addDays(startOfDay(new Date(compareTo + "T00:00:00")), 1);
          p.compareTo = t.toISOString();
        }
      }
    }
    if (country) p.country = country;
    if (city) p.city = city;
    if (brand) p.brand = brand;
    if (channel) p.channel = channel;
    return p;
  }, [resolvedRange, compareMode, compareFrom, compareTo, country, city, brand, channel]);

  return {
    preset,
    customFrom,
    customTo,
    compare: compareMode !== "none",
    compareMode,
    compareFrom,
    compareTo,
    country,
    city,
    brand,
    channel,
    apiParams,
    resolvedRange,
    setPreset,
    setCustomRange,
    setCompare,
    setCompareMode,
    setCompareRange,
    setFilter,
    clearAll,
    hasActiveFilters: Boolean(country || city || brand || channel),
  };
}
