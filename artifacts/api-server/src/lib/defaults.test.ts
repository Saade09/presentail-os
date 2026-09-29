import { describe, it, expect } from "vitest";
import {
  DEFAULT_COUNTRIES,
  EXCLUDED_COUNTRY_NAMES,
  EXCLUDED_COUNTRY_CODES,
  isExcludedCountry,
  normalizePhoneForDialCode,
  findCountryByPhone,
  phoneCountrySql,
} from "./defaults";

describe("defaults — Israel exclusion", () => {
  it("does not include Israel in DEFAULT_COUNTRIES", () => {
    expect(DEFAULT_COUNTRIES).not.toContain("Israel");
  });

  it("declares Israel in EXCLUDED_COUNTRY_NAMES", () => {
    expect(EXCLUDED_COUNTRY_NAMES).toContain("Israel");
  });

  it("declares IL in EXCLUDED_COUNTRY_CODES", () => {
    expect(EXCLUDED_COUNTRY_CODES).toContain("IL");
  });

  describe("isExcludedCountry", () => {
    it("returns true for 'Israel' (case-insensitive)", () => {
      expect(isExcludedCountry("Israel")).toBe(true);
      expect(isExcludedCountry("israel")).toBe(true);
      expect(isExcludedCountry("ISRAEL")).toBe(true);
    });

    it("returns true for 'IL' (case-insensitive)", () => {
      expect(isExcludedCountry("IL")).toBe(true);
      expect(isExcludedCountry("il")).toBe(true);
    });

    it("ignores surrounding whitespace", () => {
      expect(isExcludedCountry("  Israel  ")).toBe(true);
      expect(isExcludedCountry("\tIL\n")).toBe(true);
    });

    it("returns false for allowed countries", () => {
      expect(isExcludedCountry("Lebanon")).toBe(false);
      expect(isExcludedCountry("LB")).toBe(false);
      expect(isExcludedCountry("United Arab Emirates")).toBe(false);
      expect(isExcludedCountry("AE")).toBe(false);
      expect(isExcludedCountry("France")).toBe(false);
    });

    it("returns false for empty / null / undefined input", () => {
      expect(isExcludedCountry("")).toBe(false);
      expect(isExcludedCountry("   ")).toBe(false);
      expect(isExcludedCountry(null)).toBe(false);
      expect(isExcludedCountry(undefined)).toBe(false);
    });
  });
});

describe("normalizePhoneForDialCode", () => {
  it("strips formatting and detects '+' international format", () => {
    expect(normalizePhoneForDialCode("+966 50-123 4567")).toEqual({
      digits: "966501234567",
      international: true,
    });
  });

  it("strips a leading 00 IDD prefix and flags international", () => {
    expect(normalizePhoneForDialCode("00961 3 123456")).toEqual({
      digits: "9613123456",
      international: true,
    });
  });

  it("keeps bare digits as non-international", () => {
    expect(normalizePhoneForDialCode("961 3 123456")).toEqual({
      digits: "9613123456",
      international: false,
    });
  });

  it("handles null/empty", () => {
    expect(normalizePhoneForDialCode(null)).toEqual({ digits: "", international: false });
    expect(normalizePhoneForDialCode("")).toEqual({ digits: "", international: false });
  });
});

describe("findCountryByPhone", () => {
  it("classifies common Gulf/Levant dial codes", () => {
    expect(findCountryByPhone("+966501234567")?.code).toBe("sa");
    expect(findCountryByPhone("+971501234567")?.code).toBe("ae");
    expect(findCountryByPhone("+9613123456")?.code).toBe("lb");
  });

  it("prefers the longest matching prefix over a shared shorter one", () => {
    // +1242 (Bahamas) must beat the generic +1 (US)...
    expect(findCountryByPhone("+12425551234")?.code).toBe("bs");
    // ...while plain +1 numbers stay US.
    expect(findCountryByPhone("+12025551234")?.code).toBe("us");
    // +77 (Kazakhstan) beats the generic +7 (Russia).
    expect(findCountryByPhone("+77011234567")?.code).toBe("kz");
    expect(findCountryByPhone("+74951234567")?.code).toBe("ru");
  });

  it("accepts 00-prefixed international numbers", () => {
    expect(findCountryByPhone("0096650 1234567")?.code).toBe("sa");
  });

  it("classifies bare digits only when long enough to include a dial code", () => {
    expect(findCountryByPhone("966501234567")?.code).toBe("sa");
    // Short local-format number: no classification, callers fall back.
    expect(findCountryByPhone("03123456")).toBeUndefined();
    expect(findCountryByPhone("501234567")).toBeUndefined();
  });

  it("returns undefined for unknown prefixes and junk", () => {
    expect(findCountryByPhone("+999123456789")).toBeUndefined();
    expect(findCountryByPhone("abc")).toBeUndefined();
    expect(findCountryByPhone(null)).toBeUndefined();
    expect(findCountryByPhone(undefined)).toBeUndefined();
  });

  it("requires enough national digits after the prefix", () => {
    expect(findCountryByPhone("+9661")).toBeUndefined();
  });
});

describe("phoneCountrySql", () => {
  const sql = phoneCountrySql("c.phone");

  it("embeds the raw expression and produces a CASE classifier", () => {
    expect(sql).toContain("c.phone");
    expect(sql).toContain("CASE");
    expect(sql).toMatch(/LIKE '966%'.*THEN 'sa'/);
  });

  it("orders longer prefixes before shorter shared ones", () => {
    // 1242 (Bahamas) must appear before the bare 1 (US) branch.
    const bs = sql.indexOf("LIKE '1242%'");
    const us = sql.indexOf("LIKE '1%'");
    expect(bs).toBeGreaterThan(-1);
    expect(us).toBeGreaterThan(-1);
    expect(bs).toBeLessThan(us);
    // 77 (Kazakhstan) before 7 (Russia).
    expect(sql.indexOf("LIKE '77%'")).toBeLessThan(sql.indexOf("LIKE '7%'"));
  });

  it("rejects short non-international numbers in SQL like the JS helper", () => {
    expect(sql).toContain("WHEN NOT d.intl AND length(d.digits) < 10 THEN NULL");
  });
});
