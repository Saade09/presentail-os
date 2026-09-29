import { describe, it, expect } from "vitest";
import { contactFullName, initialsFor, whatsappHref } from "./ContactProfile";

describe("contactFullName", () => {
  it("prefers display_name", () => {
    expect(
      contactFullName({ display_name: "Zeina K", first_name: "A", last_name: "B" }, "Unnamed"),
    ).toBe("Zeina K");
  });
  it("falls back to first + last name", () => {
    expect(
      contactFullName({ display_name: "  ", first_name: "Rami", last_name: "Salame" }, "Unnamed"),
    ).toBe("Rami Salame");
  });
  it("uses the fallback when nothing is set", () => {
    expect(contactFullName({}, "Unnamed")).toBe("Unnamed");
  });
});

describe("initialsFor", () => {
  it("takes first + last initials", () => {
    expect(initialsFor("Rami Salame")).toBe("RS");
  });
  it("handles single names", () => {
    expect(initialsFor("Zeina")).toBe("Z");
  });
  it("handles middle names by using first and last", () => {
    expect(initialsFor("Anna Maria Kass")).toBe("AK");
  });
  it("returns ? for empty input", () => {
    expect(initialsFor("   ")).toBe("?");
  });
});

describe("whatsappHref", () => {
  it("strips formatting to digits", () => {
    expect(whatsappHref("+961 70 123-456")).toBe("https://wa.me/96170123456");
  });
  it("returns null for missing or too-short phones", () => {
    expect(whatsappHref(null)).toBeNull();
    expect(whatsappHref(undefined)).toBeNull();
    expect(whatsappHref("123")).toBeNull();
  });
});
