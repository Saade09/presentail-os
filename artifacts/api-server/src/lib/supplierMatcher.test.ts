import { describe, expect, it } from "vitest";
import { matchSupplierByName, normalizeSupplierName } from "./supplierMatcher";

describe("supplierMatcher", () => {
  it("matches descriptive extracted names to a distinctive legal supplier name", () => {
    const result = matchSupplierByName("Raidan - Flowers and Plants Wholesaler", [
      { id: 301, name: "Raidan Floriculture SARL", display_name: null },
      { id: 302, name: "Cedars Trading SAL", display_name: null },
    ]);

    expect(result).toMatchObject({ id: 301, score: 88, matchedBy: "token" });
  });

  it("uses persisted aliases without requiring literal supplier-name equality", () => {
    const result = matchSupplierByName("Old Extracted Supplier Name", [
      {
        id: 7,
        name: "Current Legal Supplier SAL",
        display_name: null,
        aliases: ["Old Extracted Supplier Name"],
      },
    ]);

    expect(result).toMatchObject({ id: 7, score: 100, matchedBy: "exact" });
  });

  it("fails closed when a distinctive token identifies multiple suppliers", () => {
    const result = matchSupplierByName("Raidan Flowers and Plants Wholesaler", [
      { id: 301, name: "Raidan Floriculture SARL", display_name: null },
      { id: 302, name: "Raidan Trading SAL", display_name: null },
    ]);

    expect(result).toBeNull();
  });

  it("normalizes punctuation, accents, and company suffix variants consistently", () => {
    expect(normalizeSupplierName("Raïdan S.A.R.L.")).toBe("raidan");
    expect(normalizeSupplierName("Raidan - Flowers and Plants Wholesaler")).toBe(
      "raidan flowers and plants wholesaler",
    );
  });
});