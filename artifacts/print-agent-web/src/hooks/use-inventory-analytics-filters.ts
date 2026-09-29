import { useCallback, useMemo } from "react";
import { useSearch, useLocation } from "wouter";

export type InventoryDatePreset =
  | "today"
  | "yesterday"
  | "this_week"
  | "last_week"
  | "this_month"
  | "custom";

export const INVENTORY_DATE_PRESETS: { value: InventoryDatePreset; labelKey: string }[] = [
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

function startOfWeek(d: Date): Date {
  const x = startOfDay(d);
  const dow = (x.getDay() + 6) % 7;
  return addDays(x, -dow);
}

function startOfMonth(d: Date): Date {
  const x = startOfDay(d);
  x.setDate(1);
  return x;
}

export function resolveInventoryPresetRange(
  preset: InventoryDatePreset,
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
      const from = addDays(startOfWeek(now), -7);
      return { from, to: startOfWeek(now) };
    }
    case "this_month": {
      const from = startOfMonth(now);
      return { from, to: addDays(startOfDay(now), 1) };
    }
    case "custom": {
      const f = customFrom ? new Date(customFrom) : addDays(startOfDay(now), -29);
      const t = customTo ? addDays(new Date(customTo), 1) : addDays(startOfDay(now), 1);
      return {
        from: Number.isNaN(f.getTime()) ? addDays(startOfDay(now), -29) : f,
        to: Number.isNaN(t.getTime()) ? addDays(startOfDay(now), 1) : t,
      };
    }
  }
}

function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export interface UseInventoryAnalyticsFilters {
  preset: InventoryDatePreset;
  customFrom: string | null;
  customTo: string | null;
  locationId: string | null;
  categoryId: string | null;
  supplierId: string | null;
  baseItemId: string | null;
  movementType: string | null;
  setPreset: (p: InventoryDatePreset) => void;
  setCustomFrom: (v: string | null) => void;
  setCustomTo: (v: string | null) => void;
  setLocationId: (v: string | null) => void;
  setCategoryId: (v: string | null) => void;
  setSupplierId: (v: string | null) => void;
  setBaseItemId: (v: string | null) => void;
  setMovementType: (v: string | null) => void;
  resolvedRange: { from: Date; to: Date };
  apiParams: {
    from: string;
    to: string;
    locationId?: number;
    supplierId?: number;
    baseItemId?: number;
    movementType?: string;
  };
}

export function useInventoryAnalyticsFilters(): UseInventoryAnalyticsFilters {
  const search = useSearch();
  const [, setLocation] = useLocation();

  const params = useMemo(() => new URLSearchParams(search), [search]);

  const get = (key: string) => params.get(key);

  const preset = (get("preset") as InventoryDatePreset) || "this_month";
  const customFrom = get("from");
  const customTo = get("to");
  const locationId = get("locationId");
  const categoryId = get("categoryId");
  const supplierId = get("supplierId");
  const baseItemId = get("baseItemId");
  const movementType = get("movementType");

  const resolvedRange = useMemo(
    () => resolveInventoryPresetRange(preset, customFrom, customTo),
    [preset, customFrom, customTo],
  );

  const updateParam = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(search);
      if (value == null || value === "") {
        next.delete(key);
      } else {
        next.set(key, value);
      }
      const qs = next.toString();
      setLocation(`?${qs}`, { replace: true });
    },
    [search, setLocation],
  );

  const setPreset = useCallback(
    (p: InventoryDatePreset) => updateParam("preset", p),
    [updateParam],
  );
  const setCustomFrom = useCallback(
    (v: string | null) => updateParam("from", v),
    [updateParam],
  );
  const setCustomTo = useCallback(
    (v: string | null) => updateParam("to", v),
    [updateParam],
  );
  const setLocationId = useCallback(
    (v: string | null) => updateParam("locationId", v),
    [updateParam],
  );
  const setCategoryId = useCallback(
    (v: string | null) => updateParam("categoryId", v),
    [updateParam],
  );
  const setSupplierId = useCallback(
    (v: string | null) => updateParam("supplierId", v),
    [updateParam],
  );
  const setBaseItemId = useCallback(
    (v: string | null) => updateParam("baseItemId", v),
    [updateParam],
  );
  const setMovementType = useCallback(
    (v: string | null) => updateParam("movementType", v),
    [updateParam],
  );

  const apiParams = useMemo(() => {
    const p: UseInventoryAnalyticsFilters["apiParams"] = {
      from: toISODate(resolvedRange.from),
      to: toISODate(resolvedRange.to),
    };
    if (locationId) p.locationId = Number(locationId);
    if (supplierId) p.supplierId = Number(supplierId);
    if (baseItemId) p.baseItemId = Number(baseItemId);
    if (movementType) p.movementType = movementType;
    return p;
  }, [resolvedRange, locationId, categoryId, supplierId, baseItemId, movementType]);

  return {
    preset,
    customFrom,
    customTo,
    locationId,
    categoryId,
    supplierId,
    baseItemId,
    movementType,
    setPreset,
    setCustomFrom,
    setCustomTo,
    setLocationId,
    setCategoryId,
    setSupplierId,
    setBaseItemId,
    setMovementType,
    resolvedRange,
    apiParams,
  };
}
