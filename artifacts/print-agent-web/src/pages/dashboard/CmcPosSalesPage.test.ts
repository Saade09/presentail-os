import { describe, it, expect } from "vitest";
import {
  buildAuditQueryParams,
  buildHistoryFilterUrl,
  resolveInitialRange,
} from "./CmcPosSalesPage";

function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}

describe("resolveInitialRange", () => {
  it("defaults to month-to-date when URL has no from/to", () => {
    const today = new Date();
    const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
    const { from, to } = resolveInitialRange("", "");
    expect(from).toBe(fmt(startOfMonth));
    expect(to).toBe(fmt(today));
  });

  it("keeps an explicit URL range as-is", () => {
    expect(resolveInitialRange("2026-01-05", "2026-01-20")).toEqual({
      from: "2026-01-05",
      to: "2026-01-20",
    });
  });

  it("does not override a partially specified range", () => {
    expect(resolveInitialRange("2026-01-05", "")).toEqual({ from: "2026-01-05", to: "" });
    expect(resolveInitialRange("", "2026-01-20")).toEqual({ from: "", to: "2026-01-20" });
  });
});

describe("CMC History applied filter helpers", () => {
  it("preserves payment method and search while applying a new date range and resets pagination", () => {
    const url = buildHistoryFilterUrl({
      localFrom: "2026-12-20",
      localTo: "2027-01-05",
      paymentMethod: "card",
      search: "CMC-12345",
    });
    expect(url).toBe(
      "/cmc-pos/sales?from=2026-12-20&to=2027-01-05&payment_method=card&search=CMC-12345",
    );
    expect(url).not.toContain("page=");
  });

  it("uses the same inclusive filter scope for list and export queries", () => {
    const filter = {
      from: "2026-08-01",
      to: "2026-08-26",
      paymentMethod: "cash",
      search: "order-42",
    };
    const list = buildAuditQueryParams(filter, { limit: 25, offset: 50 });
    const exported = buildAuditQueryParams(filter);

    for (const key of ["from", "to", "payment_method", "search"]) {
      expect(exported.get(key)).toBe(list.get(key));
    }
    expect(exported.has("limit")).toBe(false);
    expect(exported.has("offset")).toBe(false);
  });
});
