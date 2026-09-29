import { describe, it, expect } from "vitest";
import {
  WORLD_COUNTRIES,
  EXCLUDED_COUNTRY_NAMES,
  EXCLUDED_COUNTRY_CODES,
  isExcludedCountry,
  COUNTRY_CATALOGUE,
  findCountryByName,
  findCountryByCode,
  getDefaultFlagUrl,
} from "./countries";

describe("country catalogue helpers", () => {
  it("excludes Israel from COUNTRY_CATALOGUE", () => {
    expect(COUNTRY_CATALOGUE.find((c) => c.code === "il")).toBeUndefined();
    expect(COUNTRY_CATALOGUE.find((c) => c.name === "Israel")).toBeUndefined();
  });

  it("findCountryByName matches case-insensitively", () => {
    expect(findCountryByName("Lebanon")?.code).toBe("lb");
    expect(findCountryByName("lebanon")?.code).toBe("lb");
    expect(findCountryByName("Atlantis")).toBeUndefined();
  });

  it("findCountryByCode matches case-insensitively", () => {
    expect(findCountryByCode("LB")?.name).toBe("Lebanon");
    expect(findCountryByCode("lb")?.name).toBe("Lebanon");
    expect(findCountryByCode("zz")).toBeUndefined();
  });

  it("getDefaultFlagUrl returns the bundled flag path", () => {
    expect(getDefaultFlagUrl("lb")).toBe("/flags/lb.svg");
    expect(getDefaultFlagUrl("FR")).toBe("/flags/fr.svg");
  });
});

describe("countries — Israel exclusion", () => {
  it("removes Israel from WORLD_COUNTRIES", () => {
    expect(WORLD_COUNTRIES).not.toContain("Israel");
  });

  it("declares Israel in EXCLUDED_COUNTRY_NAMES", () => {
    expect(EXCLUDED_COUNTRY_NAMES).toContain("Israel");
  });

  it("declares IL in EXCLUDED_COUNTRY_CODES", () => {
    expect(EXCLUDED_COUNTRY_CODES).toContain("IL");
  });

  describe("isExcludedCountry", () => {
    it("returns true for the country name 'Israel'", () => {
      expect(isExcludedCountry("Israel")).toBe(true);
    });

    it("returns true for the ISO code 'IL'", () => {
      expect(isExcludedCountry("IL")).toBe(true);
    });

    it("matches case-insensitively for the country name", () => {
      expect(isExcludedCountry("israel")).toBe(true);
      expect(isExcludedCountry("ISRAEL")).toBe(true);
    });

    it("matches case-insensitively for the ISO code", () => {
      expect(isExcludedCountry("il")).toBe(true);
      expect(isExcludedCountry("Il")).toBe(true);
    });

    it("ignores surrounding whitespace", () => {
      expect(isExcludedCountry("  Israel  ")).toBe(true);
      expect(isExcludedCountry("\tIL\n")).toBe(true);
    });

    it("returns false for non-excluded countries", () => {
      expect(isExcludedCountry("Lebanon")).toBe(false);
      expect(isExcludedCountry("LB")).toBe(false);
      expect(isExcludedCountry("United Arab Emirates")).toBe(false);
      expect(isExcludedCountry("AE")).toBe(false);
      expect(isExcludedCountry("France")).toBe(false);
    });

    it("returns false for empty / null / undefined / whitespace-only input", () => {
      expect(isExcludedCountry("")).toBe(false);
      expect(isExcludedCountry("   ")).toBe(false);
      expect(isExcludedCountry(null)).toBe(false);
      expect(isExcludedCountry(undefined)).toBe(false);
    });
  });
});
