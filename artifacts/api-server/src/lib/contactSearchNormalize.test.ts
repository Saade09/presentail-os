import { describe, it, expect } from "vitest";
import {
  normalizePhoneDigits,
  normalizeEmailQuery,
  collapseName,
  escapeLike,
  buildSearchTerms,
} from "./contactSearchNormalize";

describe("normalizePhoneDigits", () => {
  it("strips all formatting to digits only", () => {
    expect(normalizePhoneDigits("+961 70-123 456")).toBe("96170123456");
    expect(normalizePhoneDigits("(04) 123.456")).toBe("04123456");
  });
  it("handles null/undefined/empty", () => {
    expect(normalizePhoneDigits(null)).toBe("");
    expect(normalizePhoneDigits(undefined)).toBe("");
    expect(normalizePhoneDigits("")).toBe("");
  });
  it("preserves country-code digits (different codes stay distinct)", () => {
    expect(normalizePhoneDigits("+96170123456")).not.toBe(normalizePhoneDigits("+97170123456"));
  });
});

describe("normalizeEmailQuery", () => {
  it("trims and lowercases", () => {
    expect(normalizeEmailQuery("  Jane@Example.COM ")).toBe("jane@example.com");
  });
  it("handles null", () => {
    expect(normalizeEmailQuery(null)).toBe("");
  });
});

describe("collapseName", () => {
  it("trims and collapses internal whitespace", () => {
    expect(collapseName("  Jane   Al  Doe ")).toBe("Jane Al Doe");
  });
});

describe("escapeLike", () => {
  it("escapes %, _ and backslash", () => {
    expect(escapeLike("50%_a\\b")).toBe("50\\%\\_a\\\\b");
  });
});

describe("buildSearchTerms", () => {
  it("classifies a phone-like query", () => {
    const t = buildSearchTerms(" +961 70 123 ");
    expect(t.phoneDigits).toBe("96170123");
    expect(t.emailQuery).toBe("");
    expect(t.nameQuery).toBe("");
  });
  it("requires at least 4 digits for phone matching", () => {
    expect(buildSearchTerms("70").phoneDigits).toBe("");
    expect(buildSearchTerms("701").phoneDigits).toBe("");
    expect(buildSearchTerms("7012").phoneDigits).toBe("7012");
  });
  it("classifies an email-like query", () => {
    const t = buildSearchTerms("Jane@Example.com");
    expect(t.emailQuery).toBe("jane@example.com");
    expect(t.nameQuery).toBe("");
  });
  it("classifies a name query", () => {
    const t = buildSearchTerms("  Jane   Doe ");
    expect(t.nameQuery).toBe("Jane Doe");
    expect(t.phoneDigits).toBe("");
    expect(t.emailQuery).toBe("");
  });
  it("a name containing digits matches both name and phone axes", () => {
    const t = buildSearchTerms("Shop 961234");
    expect(t.nameQuery).toBe("Shop 961234");
    expect(t.phoneDigits).toBe("961234");
  });
  it("blank query produces no terms", () => {
    const t = buildSearchTerms("   ");
    expect(t.phoneDigits).toBe("");
    expect(t.emailQuery).toBe("");
    expect(t.nameQuery).toBe("");
  });
});
