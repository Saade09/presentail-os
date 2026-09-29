import Holidays from "date-holidays";
import type { HolidaysTypes } from "date-holidays";

export interface SupportedCountry {
  code: string;
  name: string;
}

export interface SupportedRegion {
  code: string;
  name: string;
}

export type HolidayStatus = "Confirmed" | "Estimated" | "Suggested";

export interface NormalizedHoliday {
  name: string;
  local_name: string | null;
  date: string;
  observed_date: string | null;
  type: string;
  status: HolidayStatus;
  source: "Imported";
  country_code: string;
  region_code: string | null;
  notes: string | null;
}

export function getSupportedCountries(): SupportedCountry[] {
  const hd = new Holidays();
  const countries = hd.getCountries("en") as Record<string, string> | null;
  if (!countries) return [];
  return Object.entries(countries)
    .map(([code, name]) => ({ code, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getSupportedRegions(countryCode: string): SupportedRegion[] {
  const hd = new Holidays();
  const states = hd.getStates(countryCode, "en") as Record<string, string> | null;
  if (!states) return [];
  return Object.entries(states)
    .map(([code, name]) => ({ code, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface GetHolidaysOptions {
  countryCode: string;
  year: number;
  regionCode?: string | null;
  types?: string[];
}

export function getHolidays(opts: GetHolidaysOptions): NormalizedHoliday[] {
  const hd = new Holidays();

  if (opts.regionCode) {
    hd.init(opts.countryCode, opts.regionCode);
  } else {
    hd.init(opts.countryCode);
  }

  const raw = hd.getHolidays(opts.year, "en");
  if (!raw || !Array.isArray(raw)) return [];

  const filtered =
    opts.types && opts.types.length > 0
      ? raw.filter((h) => opts.types!.includes(h.type))
      : raw;

  const seen = new Set<string>();
  const results: NormalizedHoliday[] = [];

  for (const h of filtered) {
    const normalized = normalizeHoliday(h, opts.countryCode, opts.regionCode ?? null);
    const key = `${normalized.date}:${normalized.name}`;
    if (!seen.has(key)) {
      seen.add(key);
      results.push(normalized);
    }
  }

  return results.sort((a, b) => a.date.localeCompare(b.date));
}

export function normalizeHoliday(
  raw: HolidaysTypes.Holiday,
  countryCode: string,
  regionCode: string | null,
): NormalizedHoliday {
  const dateStr = raw.date.slice(0, 10);

  let observedDate: string | null = null;
  if (raw.substitute && raw.start) {
    const startStr = toDateStr(raw.start);
    if (startStr !== dateStr) {
      observedDate = startStr;
    }
  }

  let status: HolidayStatus = "Confirmed";
  const rawType = (raw.type || "").toLowerCase();
  if (rawType === "observance" || rawType === "optional") {
    status = "Suggested";
  } else if (rawType === "school" || rawType === "bank") {
    status = "Estimated";
  }

  return {
    name: raw.name,
    local_name: null,
    date: dateStr,
    observed_date: observedDate,
    type: raw.type || "public",
    status,
    source: "Imported",
    country_code: countryCode,
    region_code: regionCode,
    notes: null,
  };
}

function toDateStr(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function getAvailableTypes(): string[] {
  return ["public", "bank", "school", "optional", "observance"];
}
