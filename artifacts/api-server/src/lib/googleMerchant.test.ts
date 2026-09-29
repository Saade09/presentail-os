import { describe, it, expect } from "vitest";
import {
  getMerchantOfferId,
  getMerchantPrice,
  getMerchantAvailability,
  getMerchantDescription,
  getMerchantProductUrl,
  validateMerchantProduct,
  buildMerchantProductInput,
  buildShippingEntry,
  slugifyProductName,
  type DeliveryConfig,
} from "./googleMerchant";
import type { Product } from "@workspace/db/schema";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: 1,
    workspaceOwnerId: "ws_test",
    name: "Red Roses Bouquet",
    priceUsd: "50.00",
    priceAed: "185.00",
    discountPriceUsd: null,
    discountPriceAed: null,
    mainImageUrl: "https://cdn.presentail.com/images/roses.jpg",
    additionalImageUrls: [],
    imagePublicPath: null,
    additionalImagePublicPaths: [],
    description: "A beautiful bouquet of red roses.",
    descriptionAr: null,
    status: "available",
    brand: null,
    tags: [],
    createdAt: new Date("2026-01-01T00:00:00Z"),
    sku: null,
    isArchived: false,
    expressDeliveryEnabled: true,
    hasInputField: false,
    letterInputEnabled: false,
    isUpsell: false,
    wooProductId: null,
    merchantSyncStatus: null,
    merchantSyncError: null,
    merchantSyncedAt: null,
    merchantResourceName: null,
    merchantLastResponse: null,
    merchantSyncAttempts: 0,
    merchantSyncDisabled: false,
    googleProductCategory: null,
    targetCountry: null,
    contentLanguage: null,
    ...overrides,
  } as unknown as Product;
}

// ---------------------------------------------------------------------------
// slugifyProductName
// ---------------------------------------------------------------------------

describe("slugifyProductName", () => {
  it("lowercases and replaces spaces with hyphens", () => {
    expect(slugifyProductName("Plum Florals")).toBe("plum-florals");
  });

  it("strips apostrophes", () => {
    expect(slugifyProductName("Mother's Day Bouquet")).toBe("mothers-day-bouquet");
  });

  it("collapses repeated hyphens", () => {
    expect(slugifyProductName("Roses  &  Lilies")).toBe("roses-lilies");
  });

  it("removes leading and trailing hyphens", () => {
    expect(slugifyProductName("  -Roses-  ")).toBe("roses");
  });

  it("returns empty string for symbols-only names", () => {
    expect(slugifyProductName("---")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// getMerchantProductUrl
// ---------------------------------------------------------------------------

describe("getMerchantProductUrl", () => {
  it("builds en-lb/beirut URL for defaults (no targetCountry or contentLanguage)", () => {
    const url = getMerchantProductUrl(makeProduct());
    expect(url).toBe("https://presentail.com/en-lb/beirut/product/red-roses-bouquet");
  });

  it("builds ar-lb/beirut URL when contentLanguage=ar, targetCountry=LB", () => {
    const url = getMerchantProductUrl(makeProduct({ contentLanguage: "ar", targetCountry: "LB" }));
    expect(url).toBe("https://presentail.com/ar-lb/beirut/product/red-roses-bouquet");
  });

  it("builds en-ae/dubai URL when targetCountry=AE", () => {
    const url = getMerchantProductUrl(makeProduct({ targetCountry: "AE" }));
    expect(url).toBe("https://presentail.com/en-ae/dubai/product/red-roses-bouquet");
  });

  it("builds ar-ae/dubai URL when contentLanguage=ar, targetCountry=AE", () => {
    const url = getMerchantProductUrl(
      makeProduct({ contentLanguage: "ar", targetCountry: "AE" }),
    );
    expect(url).toBe("https://presentail.com/ar-ae/dubai/product/red-roses-bouquet");
  });

  it("slugifies the product name in the URL", () => {
    const url = getMerchantProductUrl(makeProduct({ name: "Plum Florals" }));
    expect(url).toBe("https://presentail.com/en-lb/beirut/product/plum-florals");
  });

  it("strips apostrophes when slugifying", () => {
    const url = getMerchantProductUrl(makeProduct({ name: "Mother's Day Bouquet" }));
    expect(url).toBe("https://presentail.com/en-lb/beirut/product/mothers-day-bouquet");
  });

  it("throws when product name produces an empty slug", () => {
    expect(() => getMerchantProductUrl(makeProduct({ name: "---" }))).toThrow(
      /empty slug/,
    );
  });

  // ── Stored publicSlug path ────────────────────────────────────────────────

  it("uses the stored publicSlug instead of slugifying the name when provided", () => {
    const url = getMerchantProductUrl(makeProduct({ name: "Red Roses Bouquet" }), "custom-roses-slug");
    expect(url).toBe("https://presentail.com/en-lb/beirut/product/custom-roses-slug");
  });

  it("stored publicSlug is used verbatim (not re-slugified)", () => {
    const url = getMerchantProductUrl(makeProduct(), "my-custom-slug-2024");
    expect(url).toBe("https://presentail.com/en-lb/beirut/product/my-custom-slug-2024");
  });

  it("trims whitespace from a stored publicSlug", () => {
    const url = getMerchantProductUrl(makeProduct(), "  trimmed-slug  ");
    expect(url).toBe("https://presentail.com/en-lb/beirut/product/trimmed-slug");
  });

  it("falls back to slugifying the name when publicSlug is null", () => {
    const url = getMerchantProductUrl(makeProduct({ name: "Red Roses Bouquet" }), null);
    expect(url).toBe("https://presentail.com/en-lb/beirut/product/red-roses-bouquet");
  });

  it("falls back to slugifying the name when publicSlug is undefined", () => {
    const url = getMerchantProductUrl(makeProduct({ name: "Red Roses Bouquet" }), undefined);
    expect(url).toBe("https://presentail.com/en-lb/beirut/product/red-roses-bouquet");
  });

  it("falls back to slugifying the name when publicSlug is an empty string", () => {
    const url = getMerchantProductUrl(makeProduct({ name: "Red Roses Bouquet" }), "");
    expect(url).toBe("https://presentail.com/en-lb/beirut/product/red-roses-bouquet");
  });

  it("throws even when publicSlug is empty and name also produces an empty slug", () => {
    expect(() => getMerchantProductUrl(makeProduct({ name: "---" }), "")).toThrow(/empty slug/);
  });

  it("stored publicSlug works with non-default locale and city (AE/ar)", () => {
    const url = getMerchantProductUrl(
      makeProduct({ contentLanguage: "ar", targetCountry: "AE" }),
      "ورود-حمراء",
    );
    expect(url).toBe("https://presentail.com/ar-ae/dubai/product/ورود-حمراء");
  });
});

// ---------------------------------------------------------------------------
// Lebanon product (no discount, default country/language)
// ---------------------------------------------------------------------------

describe("Lebanon product (no discount)", () => {
  const product = makeProduct();

  it("builds offerId with fallback PRESENTAIL-{id} prefix and LB suffix", () => {
    expect(getMerchantOfferId(product)).toBe("PRESENTAIL-1-LB");
  });

  it("uses USD price with correct amountMicros", () => {
    const price = getMerchantPrice(product);
    expect(price.currencyCode).toBe("USD");
    expect(price.amount).toBe(50);
    expect(price.amountMicros).toBe("50000000");
  });

  it("is IN_STOCK for an available, non-archived product", () => {
    expect(getMerchantAvailability(product)).toBe("IN_STOCK");
  });

  it("builds a complete Merchant input with feedLabel LB and correct URL", () => {
    const input = buildMerchantProductInput(product);
    expect(input.feedLabel).toBe("LB");
    expect(input.contentLanguage).toBe("en");
    expect(input.offerId).toBe("PRESENTAIL-1-LB");
    expect(input.productAttributes.price.currencyCode).toBe("USD");
    expect(input.productAttributes.link).toBe(
      "https://presentail.com/en-lb/beirut/product/red-roses-bouquet",
    );
    expect(input.productAttributes.identifierExists).toBe(false);
    expect(input.productAttributes.condition).toBe("NEW");
  });
});

// ---------------------------------------------------------------------------
// UAE product (no discount)
// ---------------------------------------------------------------------------

describe("UAE product (no discount)", () => {
  const product = makeProduct({
    targetCountry: "AE",
    sku: "ROSES-RED",
    priceAed: "185.00",
    discountPriceAed: null,
  });

  it("builds offerId using sku and AE suffix", () => {
    expect(getMerchantOfferId(product)).toBe("ROSES-RED-AE");
  });

  it("uses AED price with correct amountMicros", () => {
    const price = getMerchantPrice(product);
    expect(price.currencyCode).toBe("AED");
    expect(price.amount).toBe(185);
    expect(price.amountMicros).toBe("185000000");
  });

  it("builds a complete Merchant input with feedLabel AE and dubai URL", () => {
    const input = buildMerchantProductInput(product);
    expect(input.feedLabel).toBe("AE");
    expect(input.productAttributes.price.currencyCode).toBe("AED");
    expect(input.offerId).toBe("ROSES-RED-AE");
    expect(input.productAttributes.link).toBe(
      "https://presentail.com/en-ae/dubai/product/red-roses-bouquet",
    );
  });
});

// ---------------------------------------------------------------------------
// Discount product (LB with discount_price_usd)
// ---------------------------------------------------------------------------

describe("Discount product (LB)", () => {
  const product = makeProduct({
    priceUsd: "100.00",
    discountPriceUsd: "75.50",
    targetCountry: "LB",
  });

  it("discount price wins over regular price", () => {
    const price = getMerchantPrice(product);
    expect(price.amount).toBe(75.5);
    expect(price.currencyCode).toBe("USD");
    expect(price.amountMicros).toBe("75500000");
  });

  it("passes validation with a valid discount price", () => {
    const result = validateMerchantProduct(product);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Archived product — availability (not a validation error)
// ---------------------------------------------------------------------------

describe("Archived product", () => {
  const product = makeProduct({ isArchived: true, status: "available" });

  it("returns OUT_OF_STOCK when is_archived is true", () => {
    expect(getMerchantAvailability(product)).toBe("OUT_OF_STOCK");
  });

  it("validateMerchantProduct does NOT block archived products", () => {
    const result = validateMerchantProduct(product);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("buildMerchantProductInput succeeds for an archived product", () => {
    const input = buildMerchantProductInput(product);
    expect(input.productAttributes.availability).toBe("OUT_OF_STOCK");
  });
});

// ---------------------------------------------------------------------------
// status = not_available — maps to OUT_OF_STOCK but is not a validation error
// ---------------------------------------------------------------------------

describe("status = not_available", () => {
  const product = makeProduct({ status: "not_available" });

  it("returns OUT_OF_STOCK for status not_available", () => {
    expect(getMerchantAvailability(product)).toBe("OUT_OF_STOCK");
  });

  it("validateMerchantProduct does NOT block not_available status", () => {
    const result = validateMerchantProduct(product);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("buildMerchantProductInput succeeds and sets OUT_OF_STOCK", () => {
    const input = buildMerchantProductInput(product);
    expect(input.productAttributes.availability).toBe("OUT_OF_STOCK");
  });
});

// ---------------------------------------------------------------------------
// main_image_url validation — must be an HTTPS URL
// ---------------------------------------------------------------------------

describe("main_image_url validation", () => {
  const EXPECTED_ERROR = "main_image_url must be a valid HTTPS URL";

  it("reports error when mainImageUrl is null", () => {
    const result = validateMerchantProduct(makeProduct({ mainImageUrl: null }));
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(EXPECTED_ERROR);
  });

  it("reports error when mainImageUrl is an HTTP (non-HTTPS) URL", () => {
    const result = validateMerchantProduct(
      makeProduct({ mainImageUrl: "http://cdn.presentail.com/image.jpg" }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(EXPECTED_ERROR);
  });

  it("passes when mainImageUrl starts with https://", () => {
    const result = validateMerchantProduct(
      makeProduct({ mainImageUrl: "https://cdn.presentail.com/image.jpg" }),
    );
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getMerchantDescription — language selection
// ---------------------------------------------------------------------------

describe("getMerchantDescription", () => {
  it("returns English description by default", () => {
    const product = makeProduct({ description: "English desc", descriptionAr: "وصف عربي" });
    expect(getMerchantDescription(product)).toBe("English desc");
  });

  it("returns Arabic description when content_language is ar and descriptionAr exists", () => {
    const product = makeProduct({
      description: "English desc",
      descriptionAr: "وصف عربي",
      contentLanguage: "ar",
    });
    expect(getMerchantDescription(product)).toBe("وصف عربي");
  });

  it("falls back to name when description is absent", () => {
    const product = makeProduct({ description: null, descriptionAr: null });
    expect(getMerchantDescription(product)).toBe("Red Roses Bouquet");
  });
});

// ---------------------------------------------------------------------------
// buildMerchantProductInput — optional field handling
// ---------------------------------------------------------------------------

describe("buildMerchantProductInput optional fields", () => {
  it("omits additionalImageLinks when empty", () => {
    const input = buildMerchantProductInput(makeProduct({ additionalImageUrls: [] }));
    expect(input.productAttributes.additionalImageLinks).toBeUndefined();
  });

  it("only includes HTTPS URLs in additionalImageLinks", () => {
    const product = makeProduct({
      additionalImageUrls: [
        "https://cdn.presentail.com/img1.jpg",
        "http://insecure.example.com/img2.jpg",
        "https://cdn.presentail.com/img3.jpg",
      ],
    });
    const input = buildMerchantProductInput(product);
    expect(input.productAttributes.additionalImageLinks).toEqual([
      "https://cdn.presentail.com/img1.jpg",
      "https://cdn.presentail.com/img3.jpg",
    ]);
  });

  it("includes brand when present", () => {
    const input = buildMerchantProductInput(makeProduct({ brand: "Fleuriste" }));
    expect(input.productAttributes.brand).toBe("Fleuriste");
  });

  it("omits brand when absent", () => {
    const input = buildMerchantProductInput(makeProduct({ brand: null }));
    expect(input.productAttributes.brand).toBeUndefined();
  });

  it("includes googleProductCategory when present", () => {
    const input = buildMerchantProductInput(makeProduct({ googleProductCategory: "632" }));
    expect(input.productAttributes.googleProductCategory).toBe("632");
  });

  it("omits googleProductCategory when absent", () => {
    const input = buildMerchantProductInput(makeProduct({ googleProductCategory: null }));
    expect(input.productAttributes.googleProductCategory).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// validateMerchantProduct — individual rule coverage
// ---------------------------------------------------------------------------

describe("validateMerchantProduct rules", () => {
  it("is valid for a complete, available product", () => {
    const result = validateMerchantProduct(makeProduct());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("reports error when price is 0", () => {
    const result = validateMerchantProduct(makeProduct({ priceUsd: "0.00" }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("price"))).toBe(true);
  });

  it("reports error for unsupported target_country", () => {
    const result = validateMerchantProduct(makeProduct({ targetCountry: "XX" }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("target_country"))).toBe(true);
  });

  it("reports error for unsupported content_language", () => {
    const result = validateMerchantProduct(makeProduct({ contentLanguage: "fr" }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("content_language"))).toBe(true);
  });

  it("reports error when name produces an empty slug", () => {
    const result = validateMerchantProduct(makeProduct({ name: "---" }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("slug"))).toBe(true);
  });

  // ── Stored publicSlug path ─────────────────────────────────────────────────

  it("is valid when a stored publicSlug is provided even if name would produce an empty slug", () => {
    const result = validateMerchantProduct(makeProduct({ name: "---" }), "valid-custom-slug");
    // name is "---" so name-derived slug is empty, but publicSlug rescues it
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("reports slug error when both publicSlug is empty and name produces an empty slug", () => {
    const result = validateMerchantProduct(makeProduct({ name: "---" }), "");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("slug"))).toBe(true);
  });

  it("reports slug error when publicSlug is null and name produces an empty slug", () => {
    const result = validateMerchantProduct(makeProduct({ name: "---" }), null);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("slug"))).toBe(true);
  });

  it("is valid when publicSlug is null but name produces a valid slug", () => {
    const result = validateMerchantProduct(makeProduct(), null);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// buildMerchantProductInput — stored publicSlug path
// ---------------------------------------------------------------------------

describe("buildMerchantProductInput with stored publicSlug", () => {
  it("uses the stored publicSlug in the product link URL", () => {
    const input = buildMerchantProductInput(makeProduct(), "custom-roses-link");
    expect(input.productAttributes.link).toBe(
      "https://presentail.com/en-lb/beirut/product/custom-roses-link",
    );
  });

  it("falls back to name-derived slug when publicSlug is null", () => {
    const input = buildMerchantProductInput(makeProduct(), null);
    expect(input.productAttributes.link).toBe(
      "https://presentail.com/en-lb/beirut/product/red-roses-bouquet",
    );
  });

  it("falls back to name-derived slug when publicSlug is omitted", () => {
    const input = buildMerchantProductInput(makeProduct());
    expect(input.productAttributes.link).toBe(
      "https://presentail.com/en-lb/beirut/product/red-roses-bouquet",
    );
  });

  it("throws when publicSlug is empty and name also produces an empty slug", () => {
    expect(() =>
      buildMerchantProductInput(makeProduct({ name: "---" }), ""),
    ).toThrow(/slug/);
  });

  it("succeeds (does not throw) when publicSlug is provided but name produces an empty slug", () => {
    const input = buildMerchantProductInput(makeProduct({ name: "---" }), "rescue-slug");
    expect(input.productAttributes.link).toBe(
      "https://presentail.com/en-lb/beirut/product/rescue-slug",
    );
  });
});

// ---------------------------------------------------------------------------
// buildMerchantProductInput — throws on validation failure
// ---------------------------------------------------------------------------

describe("buildMerchantProductInput validation guard", () => {
  it("throws with joined error messages when validation fails", () => {
    expect(() =>
      buildMerchantProductInput(makeProduct({ mainImageUrl: null, priceUsd: "0.00" })),
    ).toThrow(/main_image_url/);
  });
});

// ---------------------------------------------------------------------------
// buildShippingEntry — shipping attribute helper
// ---------------------------------------------------------------------------

describe("buildShippingEntry", () => {
  it("uses globalStandardFee as the shipping price when free delivery threshold is not 0", () => {
    const config: DeliveryConfig = { globalStandardFee: 5.5, globalFreeDeliveryThreshold: 30 };
    const entry = buildShippingEntry("LB", config);
    expect(entry.country).toBe("LB");
    expect(entry.price.currencyCode).toBe("USD");
    expect(entry.price.amountMicros).toBe("5500000");
  });

  it("sets price to 0 when globalFreeDeliveryThreshold is exactly 0 (free delivery globally enabled)", () => {
    const config: DeliveryConfig = { globalStandardFee: 5.5, globalFreeDeliveryThreshold: 0 };
    const entry = buildShippingEntry("LB", config);
    expect(entry.price.amountMicros).toBe("0");
    expect(entry.price.currencyCode).toBe("USD");
  });

  it("uses AED currency for AE target country", () => {
    const config: DeliveryConfig = { globalStandardFee: 10, globalFreeDeliveryThreshold: null };
    const entry = buildShippingEntry("AE", config);
    expect(entry.country).toBe("AE");
    expect(entry.price.currencyCode).toBe("AED");
    expect(entry.price.amountMicros).toBe("10000000");
  });

  it("defaults fee to 0 when globalStandardFee is null and threshold is not 0", () => {
    const config: DeliveryConfig = { globalStandardFee: null, globalFreeDeliveryThreshold: null };
    const entry = buildShippingEntry("LB", config);
    expect(entry.price.amountMicros).toBe("0");
  });
});

// ---------------------------------------------------------------------------
// buildMerchantProductInput — shipping field
// ---------------------------------------------------------------------------

describe("buildMerchantProductInput shipping field", () => {
  it("omits shipping when no deliveryConfig is provided (backward compat)", () => {
    const input = buildMerchantProductInput(makeProduct());
    expect(input.productAttributes.shipping).toBeUndefined();
  });

  it("attaches a shipping entry for LB product with standard fee", () => {
    const config: DeliveryConfig = { globalStandardFee: 5, globalFreeDeliveryThreshold: 30 };
    const input = buildMerchantProductInput(makeProduct(), null, config);
    expect(input.productAttributes.shipping).toBeDefined();
    expect(input.productAttributes.shipping).toHaveLength(1);
    const shipping = input.productAttributes.shipping![0];
    expect(shipping.country).toBe("LB");
    expect(shipping.price.currencyCode).toBe("USD");
    expect(shipping.price.amountMicros).toBe("5000000");
  });

  it("attaches a free shipping entry for LB product when threshold is 0", () => {
    const config: DeliveryConfig = { globalStandardFee: 5, globalFreeDeliveryThreshold: 0 };
    const input = buildMerchantProductInput(makeProduct(), null, config);
    const shipping = input.productAttributes.shipping![0];
    expect(shipping.price.amountMicros).toBe("0");
    expect(shipping.price.currencyCode).toBe("USD");
  });

  it("attaches a shipping entry for AE product with AED currency", () => {
    const config: DeliveryConfig = { globalStandardFee: 15, globalFreeDeliveryThreshold: 100 };
    const input = buildMerchantProductInput(makeProduct({ targetCountry: "AE", sku: "SKU-AE" }), null, config);
    const shipping = input.productAttributes.shipping![0];
    expect(shipping.country).toBe("AE");
    expect(shipping.price.currencyCode).toBe("AED");
    expect(shipping.price.amountMicros).toBe("15000000");
  });
});
