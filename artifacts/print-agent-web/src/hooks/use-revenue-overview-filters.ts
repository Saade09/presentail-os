import { useCallback, useMemo } from "react";
import { useSearch, useLocation } from "wouter";
import type { GetRevenueOverviewParams } from "@workspace/api-client-react";
import {
  DATE_PRESETS,
  COMPARE_MODES,
  resolvePresetRange,
  type DatePreset,
  type CompareMode,
} from "@/hooks/use-store-analytics-filters";

export { DATE_PRESETS, COMPARE_MODES };
export type { DatePreset, CompareMode };

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

export type UseRevenueOverviewFilters = {
  preset: DatePreset;
  customFrom: string | null;
  customTo: string | null;
  compareMode: CompareMode;
  compareFrom: string | null;
  compareTo: string | null;
  apiParams: GetRevenueOverviewParams;
  resolvedRange: { from: Date; to: Date };
  setPreset: (preset: DatePreset) => void;
  setCustomRange: (from: string | null, to: string | null) => void;
  setCompareMode: (mode: CompareMode) => void;
  setCompareRange: (from: string | null, to: string | null) => void;
};

/**
 * URL-persisted date-range + comparison state for the Revenue Overview page.
 * Mirrors the store-analytics filter conventions (presets, compareMode,
 * custom windows) without the country/city/brand/channel dimensions.
 */
export function useRevenueOverviewFilters(): UseRevenueOverviewFilters {
  const search = useSearch();
  const [location, setLocation] = useLocation();

  const params = useMemo(() => new URLSearchParams(search), [search]);

  const presetRaw = params.get("preset");
  const preset: DatePreset = isPreset(presetRaw) ? presetRaw : "this_month";
  const customFrom = params.get("from");
  const customTo = params.get("to");
  const compareModeRaw = params.get("compareMode");
  const compareMode: CompareMode = isCompareMode(compareModeRaw) ? compareModeRaw : "none";
  const compareFrom = params.get("compareFrom");
  const compareTo = params.get("compareTo");

  const update = useCallback(
    (mutate: (p: URLSearchParams) => void) => {
      const next = new URLSearchParams(search);
      mutate(next);
      const qs = next.toString();
      const base = location.split("?")[0];
      setLocation(qs ? `${base}?${qs}` : base, { replace: true });
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
        next.set("compareMode", "custom");
        if (from) next.set("compareFrom", from);
        else next.delete("compareFrom");
        if (to) next.set("compareTo", to);
        else next.delete("compareTo");
      });
    },
    [update],
  );

  const resolvedRange = useMemo(
    () => resolvePresetRange(preset, customFrom, customTo),
    [preset, customFrom, customTo],
  );

  const apiParams = useMemo<GetRevenueOverviewParams>(() => {
    const p: GetRevenueOverviewParams = {
      from: resolvedRange.from.toISOString(),
      to: resolvedRange.to.toISOString(),
    };
    if (compareMode !== "none") {
      p.compareMode = compareMode;
      if (compareMode === "custom") {
        if (compareFrom) p.compareFrom = new Date(compareFrom + "T00:00:00").toISOString();
        if (compareTo) {
          // Inclusive end-of-day, mirroring resolvePresetRange.
          p.compareTo = addDays(startOfDay(new Date(compareTo + "T00:00:00")), 1).toISOString();
        }
      }
    }
    return p;
  }, [resolvedRange, compareMode, compareFrom, compareTo]);

  return {
    preset,
    customFrom,
    customTo,
    compareMode,
    compareFrom,
    compareTo,
    apiParams,
    resolvedRange,
    setPreset,
    setCustomRange,
    setCompareMode,
    setCompareRange,
  };
}
