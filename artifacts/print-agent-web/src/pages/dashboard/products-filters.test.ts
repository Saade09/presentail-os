import { describe, it, expect } from "vitest";
import {
  parseFilters,
  buildProductsUrl,
  buildFilterParams,
  resolvePageJump,
  type PaginationState,
} from "./Products";

// ---------------------------------------------------------------------------
// parseFilters — reading filter state from a URL search string
// ---------------------------------------------------------------------------

describe("parseFilters — parse URL search params into filter state", () => {
  it("returns all-empty state when the search string is empty", () => {
    const result = parseFilters("");
    expect(result).toEqual({ q: "", status: [], brand: [], category: [], occasion: [], catalogBrand: [], brandSearch: "", cogsMinPct: "", cogsMaxPct: "", tab: "all" });
  });

  it("extracts the q (text search) param", () => {
    const result = parseFilters("?q=mug");
    expect(result.q).toBe("mug");
  });

  it("extracts a single status param as a one-element array", () => {
    const result = parseFilters("?status=available");
    expect(result.status).toEqual(["available"]);
  });

  it("extracts multiple status params into an array", () => {
    const result = parseFilters("?status=available&status=out_of_stock");
    expect(result.status).toEqual(["available", "out_of_stock"]);
  });

  it("extracts a single brand param as a one-element array", () => {
    const result = parseFilters("?brand=Acme");
    expect(result.brand).toEqual(["Acme"]);
  });

  it("extracts multiple brand params as an array", () => {
    const result = parseFilters("?brand=Acme&brand=Nike");
    expect(result.brand).toEqual(["Acme", "Nike"]);
  });

  it("extracts a single category param as a one-element array", () => {
    const result = parseFilters("?category=Packaging");
    expect(result.category).toEqual(["Packaging"]);
  });

  it("extracts multiple category params as an array", () => {
    const result = parseFilters("?category=Packaging&category=Bags");
    expect(result.category).toEqual(["Packaging", "Bags"]);
  });

  it("extracts brandSearch as a string when present", () => {
    const result = parseFilters("?brandSearch=acm");
    expect(result.brandSearch).toBe("acm");
  });

  it("returns empty string for brandSearch when not present", () => {
    const result = parseFilters("?q=widget");
    expect(result.brandSearch).toBe("");
  });

  it("extracts all four params together (single values)", () => {
    const result = parseFilters("?q=box&status=out_of_stock&brand=Globex&category=Bags");
    expect(result).toEqual({
      q: "box",
      status: ["out_of_stock"],
      brand: ["Globex"],
      category: ["Bags"],
      occasion: [],
      catalogBrand: [],
      brandSearch: "",
      cogsMinPct: "",
      cogsMaxPct: "",
      tab: "all",
    });
  });

  it("extracts all five params including brandSearch", () => {
    const result = parseFilters("?q=box&status=out_of_stock&brand=Globex&category=Bags&brandSearch=acm");
    expect(result).toEqual({
      q: "box",
      status: ["out_of_stock"],
      brand: ["Globex"],
      category: ["Bags"],
      occasion: [],
      catalogBrand: [],
      brandSearch: "acm",
      cogsMinPct: "",
      cogsMaxPct: "",
      tab: "all",
    });
  });

  it("returns empty arrays for absent params", () => {
    const result = parseFilters("?q=widget");
    expect(result.status).toEqual([]);
    expect(result.brand).toEqual([]);
    expect(result.category).toEqual([]);
  });

  it("handles search string without the leading '?' character", () => {
    const result = parseFilters("q=pen&status=available");
    expect(result.q).toBe("pen");
    expect(result.status).toEqual(["available"]);
  });

  it("URL-decodes special characters", () => {
    const result = parseFilters("?q=premium%20gift&brand=Bra%C3%A7o");
    expect(result.q).toBe("premium gift");
    expect(result.brand).toEqual(["Braço"]);
  });
});

// ---------------------------------------------------------------------------
// buildProductsUrl — construct the API URL from filter state
// ---------------------------------------------------------------------------

describe("buildProductsUrl — build the API query URL from filter state", () => {
  const empty = { q: "", status: [] as string[], brand: [] as string[], category: [] as string[], occasion: [] as string[], catalogBrand: [] as string[], brandSearch: "" };
  const defaultPagination: PaginationState = { page: 1, pageSize: 25 };

  it("returns /api/products with default page/pageSize when all filters are empty", () => {
    expect(buildProductsUrl(empty, defaultPagination)).toBe("/api/products?page=1&pageSize=25");
  });

  it("appends q as a query param when set, alongside pagination", () => {
    const url = buildProductsUrl({ ...empty, q: "mug" }, defaultPagination);
    expect(url).toBe("/api/products?q=mug&page=1&pageSize=25");
  });

  it("appends a single status as a query param", () => {
    const url = buildProductsUrl({ ...empty, status: ["available"] }, defaultPagination);
    const parsed = new URL(url, "http://localhost");
    expect(parsed.searchParams.getAll("status")).toEqual(["available"]);
    expect(parsed.searchParams.get("page")).toBe("1");
    expect(parsed.searchParams.get("pageSize")).toBe("25");
  });

  it("appends multiple status values as repeated params", () => {
    const url = buildProductsUrl({ ...empty, status: ["available", "out_of_stock"] }, defaultPagination);
    const parsed = new URL(url, "http://localhost");
    expect(parsed.searchParams.getAll("status")).toEqual(["available", "out_of_stock"]);
    expect(parsed.searchParams.get("page")).toBe("1");
    expect(parsed.searchParams.get("pageSize")).toBe("25");
  });

  it("appends a single brand as a query param", () => {
    const url = buildProductsUrl({ ...empty, brand: ["Acme"] }, defaultPagination);
    const parsed = new URL(url, "http://localhost");
    expect(parsed.searchParams.getAll("brand")).toEqual(["Acme"]);
    expect(parsed.searchParams.get("pageSize")).toBe("25");
  });

  it("appends multiple brand values as repeated params", () => {
    const url = buildProductsUrl({ ...empty, brand: ["Acme", "Nike"] }, defaultPagination);
    const parsed = new URL(url, "http://localhost");
    expect(parsed.searchParams.getAll("brand")).toEqual(["Acme", "Nike"]);
    expect(parsed.searchParams.get("page")).toBe("1");
  });

  it("appends a single category as a query param", () => {
    const url = buildProductsUrl({ ...empty, category: ["Packaging"] }, defaultPagination);
    const parsed = new URL(url, "http://localhost");
    expect(parsed.searchParams.getAll("category")).toEqual(["Packaging"]);
    expect(parsed.searchParams.get("page")).toBe("1");
  });

  it("appends multiple category values as repeated params", () => {
    const url = buildProductsUrl({ ...empty, category: ["Packaging", "Bags"] }, defaultPagination);
    const parsed = new URL(url, "http://localhost");
    expect(parsed.searchParams.getAll("category")).toEqual(["Packaging", "Bags"]);
    expect(parsed.searchParams.get("pageSize")).toBe("25");
  });

  it("appends brandSearch as a query param when set", () => {
    const url = buildProductsUrl({ ...empty, brandSearch: "acm" }, defaultPagination);
    const parsed = new URL(url, "http://localhost");
    expect(parsed.searchParams.get("brandSearch")).toBe("acm");
    expect(parsed.searchParams.get("page")).toBe("1");
  });

  it("omits brandSearch from the URL when it is empty", () => {
    const url = buildProductsUrl({ ...empty, brandSearch: "" }, defaultPagination);
    expect(url).not.toContain("brandSearch");
    expect(url).toContain("page=1");
    expect(url).toContain("pageSize=25");
  });

  it("includes all non-empty filters together in the URL", () => {
    const url = buildProductsUrl(
      {
        q: "box",
        status: ["out_of_stock"],
        brand: ["Globex"],
        category: ["Bags"],
        occasion: [],
        catalogBrand: [],
        brandSearch: "",
      },
      { page: 3, pageSize: 50 },
    );
    const parsed = new URL(url, "http://localhost");
    expect(parsed.pathname).toBe("/api/products");
    expect(parsed.searchParams.get("q")).toBe("box");
    expect(parsed.searchParams.getAll("status")).toEqual(["out_of_stock"]);
    expect(parsed.searchParams.getAll("brand")).toEqual(["Globex"]);
    expect(parsed.searchParams.getAll("category")).toEqual(["Bags"]);
    expect(parsed.searchParams.get("page")).toBe("3");
    expect(parsed.searchParams.get("pageSize")).toBe("50");
  });

  it("includes brandSearch alongside other filters", () => {
    const url = buildProductsUrl(
      {
        q: "box",
        status: [],
        brand: [],
        category: [],
        occasion: [],
        catalogBrand: [],
        brandSearch: "acm",
      },
      defaultPagination,
    );
    const parsed = new URL(url, "http://localhost");
    expect(parsed.searchParams.get("q")).toBe("box");
    expect(parsed.searchParams.get("brandSearch")).toBe("acm");
    expect(parsed.searchParams.get("page")).toBe("1");
    expect(parsed.searchParams.get("pageSize")).toBe("25");
  });

  it("omits empty-array filters from the URL but still includes pagination params", () => {
    const url = buildProductsUrl(
      { q: "badge", status: [], brand: [], category: [], occasion: [], catalogBrand: [], brandSearch: "" },
      defaultPagination,
    );
    expect(url).not.toContain("status");
    expect(url).not.toContain("brand=");
    expect(url).not.toContain("category");
    expect(url).not.toContain("brandSearch");
    expect(url).toContain("page=1");
    expect(url).toContain("pageSize=25");
  });

  it("URL-encodes spaces and special characters in filter values", () => {
    const url = buildProductsUrl({ ...empty, q: "premium gift" }, defaultPagination);
    expect(url).toContain("q=premium+gift");
    expect(url).toContain("page=1");
    expect(url).toContain("pageSize=25");
  });

  it("omits page and pageSize when no pagination state is provided", () => {
    const url = buildProductsUrl({ ...empty, q: "mug" });
    expect(url).toBe("/api/products?q=mug");
    expect(url).not.toContain("page");
    expect(url).not.toContain("pageSize");
  });
});

// ---------------------------------------------------------------------------
// buildFilterParams — build a URLSearchParams string from filter state
// ---------------------------------------------------------------------------

describe("buildFilterParams — build query string from filter state", () => {
  const empty = { q: "", status: [] as string[], brand: [] as string[], category: [] as string[], occasion: [] as string[], catalogBrand: [] as string[], brandSearch: "" };

  it("returns an empty string when all filters are empty (clear state)", () => {
    expect(buildFilterParams(empty)).toBe("");
  });

  it("returns a non-empty string when q is set", () => {
    expect(buildFilterParams({ ...empty, q: "notebook" })).not.toBe("");
  });

  it("includes q in the params string when set", () => {
    const qs = buildFilterParams({ ...empty, q: "notebook" });
    const params = new URLSearchParams(qs);
    expect(params.get("q")).toBe("notebook");
  });

  it("includes a single status in the params string", () => {
    const qs = buildFilterParams({ ...empty, status: ["not_available"] });
    const params = new URLSearchParams(qs);
    expect(params.get("status")).toBe("not_available");
  });

  it("includes multiple status values as repeated params", () => {
    const qs = buildFilterParams({ ...empty, status: ["available", "out_of_stock"] });
    const params = new URLSearchParams(qs);
    expect(params.getAll("status")).toEqual(["available", "out_of_stock"]);
  });

  it("includes a single brand in the params string", () => {
    const qs = buildFilterParams({ ...empty, brand: ["TechCorp"] });
    const params = new URLSearchParams(qs);
    expect(params.get("brand")).toBe("TechCorp");
  });

  it("includes multiple brand values as repeated params", () => {
    const qs = buildFilterParams({ ...empty, brand: ["TechCorp", "Acme"] });
    const params = new URLSearchParams(qs);
    expect(params.getAll("brand")).toEqual(["TechCorp", "Acme"]);
  });

  it("includes a single category in the params string", () => {
    const qs = buildFilterParams({ ...empty, category: ["Electronics"] });
    const params = new URLSearchParams(qs);
    expect(params.get("category")).toBe("Electronics");
  });

  it("includes multiple category values as repeated params", () => {
    const qs = buildFilterParams({ ...empty, category: ["Electronics", "Bags"] });
    const params = new URLSearchParams(qs);
    expect(params.getAll("category")).toEqual(["Electronics", "Bags"]);
  });

  it("includes brandSearch in the params string when set", () => {
    const qs = buildFilterParams({ ...empty, brandSearch: "acm" });
    const params = new URLSearchParams(qs);
    expect(params.get("brandSearch")).toBe("acm");
  });

  it("omits brandSearch from the params string when empty", () => {
    const qs = buildFilterParams({ ...empty, brandSearch: "" });
    expect(qs).not.toContain("brandSearch");
  });

  it("includes all four params when all filters are set", () => {
    const qs = buildFilterParams({
      q: "item",
      status: ["available"],
      brand: ["Alpha"],
      category: ["Boxes"],
      occasion: [],
      catalogBrand: [],
      brandSearch: "",
    });
    const params = new URLSearchParams(qs);
    expect(params.get("q")).toBe("item");
    expect(params.getAll("status")).toEqual(["available"]);
    expect(params.getAll("brand")).toEqual(["Alpha"]);
    expect(params.getAll("category")).toEqual(["Boxes"]);
  });

  it("includes all five params when all filters including brandSearch are set", () => {
    const qs = buildFilterParams({
      q: "item",
      status: ["available"],
      brand: ["Alpha"],
      category: ["Boxes"],
      occasion: [],
      catalogBrand: [],
      brandSearch: "acm",
    });
    const params = new URLSearchParams(qs);
    expect(params.get("q")).toBe("item");
    expect(params.getAll("status")).toEqual(["available"]);
    expect(params.getAll("brand")).toEqual(["Alpha"]);
    expect(params.getAll("category")).toEqual(["Boxes"]);
    expect(params.get("brandSearch")).toBe("acm");
  });
});

// ---------------------------------------------------------------------------
// Round-trip: parseFilters ∘ buildFilterParams = identity
// ---------------------------------------------------------------------------

describe("round-trip: buildFilterParams then parseFilters recovers the original state", () => {
  it("recovers all filter values after a round-trip (single values)", () => {
    const original = {
      q: "widget",
      status: ["available"],
      brand: ["Acme"],
      category: ["Packaging"],
      occasion: [],
      catalogBrand: [],
      brandSearch: "",
      cogsMinPct: "",
      cogsMaxPct: "",
      tab: "all",
    };
    const qs = buildFilterParams(original);
    const recovered = parseFilters(qs);
    expect(recovered).toEqual(original);
  });

  it("recovers multi-value filters after a round-trip", () => {
    const original = {
      q: "",
      status: ["available", "out_of_stock"],
      brand: ["Acme", "Nike"],
      category: ["Packaging", "Bags"],
      occasion: [],
      catalogBrand: [],
      brandSearch: "",
      cogsMinPct: "",
      cogsMaxPct: "",
      tab: "all",
    };
    const qs = buildFilterParams(original);
    const recovered = parseFilters(qs);
    expect(recovered).toEqual(original);
  });

  it("recovers empty state when all filters are empty", () => {
    const original = { q: "", status: [] as string[], brand: [] as string[], category: [] as string[], occasion: [] as string[], catalogBrand: [] as string[], brandSearch: "", cogsMinPct: "", cogsMaxPct: "", tab: "all" };
    const qs = buildFilterParams(original);
    const recovered = parseFilters(qs);
    expect(recovered).toEqual(original);
  });

  it("recovers partial state (only q set)", () => {
    const original = { q: "pen", status: [] as string[], brand: [] as string[], category: [] as string[], occasion: [] as string[], catalogBrand: [] as string[], brandSearch: "", cogsMinPct: "", cogsMaxPct: "", tab: "all" };
    const qs = buildFilterParams(original);
    const recovered = parseFilters(qs);
    expect(recovered).toEqual(original);
  });

  it("recovers brandSearch after a round-trip", () => {
    const original = {
      q: "",
      status: [] as string[],
      brand: [] as string[],
      category: [] as string[],
      occasion: [] as string[],
      catalogBrand: [] as string[],
      brandSearch: "acm",
      cogsMinPct: "",
      cogsMaxPct: "",
      tab: "all",
    };
    const qs = buildFilterParams(original);
    const recovered = parseFilters(qs);
    expect(recovered).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// resolvePageJump — page-jump input clamping & validation
// ---------------------------------------------------------------------------

describe("resolvePageJump — clamp/validate page-jump input", () => {
  it("navigates to a valid in-range page", () => {
    expect(resolvePageJump("5", 1, 10)).toEqual({ action: "navigate", page: 5 });
  });

  it("clamps a number above totalPages to the last page", () => {
    expect(resolvePageJump("999", 1, 10)).toEqual({ action: "navigate", page: 10 });
  });

  it("clamps a number below 1 (zero) to page 1", () => {
    expect(resolvePageJump("0", 5, 10)).toEqual({ action: "navigate", page: 1 });
  });

  it("trims surrounding whitespace before parsing", () => {
    expect(resolvePageJump("  3  ", 1, 10)).toEqual({ action: "navigate", page: 3 });
  });

  it("returns reset action when the input matches the current page", () => {
    expect(resolvePageJump("4", 4, 10)).toEqual({ action: "reset" });
  });

  it("returns reset action when input is empty", () => {
    expect(resolvePageJump("", 2, 10)).toEqual({ action: "reset" });
  });

  it("returns reset action when input is non-numeric", () => {
    expect(resolvePageJump("abc", 2, 10)).toEqual({ action: "reset" });
  });

  it("returns reset action when input contains a decimal", () => {
    expect(resolvePageJump("3.5", 2, 10)).toEqual({ action: "reset" });
  });

  it("returns reset action when input contains a negative sign", () => {
    expect(resolvePageJump("-2", 2, 10)).toEqual({ action: "reset" });
  });

  it("treats totalPages of 0 as 1 (clamps to page 1)", () => {
    expect(resolvePageJump("5", 1, 0)).toEqual({ action: "reset" });
    expect(resolvePageJump("5", 2, 0)).toEqual({ action: "navigate", page: 1 });
  });

  it("returns reset when above-range value clamps to the same as current page", () => {
    expect(resolvePageJump("999", 10, 10)).toEqual({ action: "reset" });
  });
});
