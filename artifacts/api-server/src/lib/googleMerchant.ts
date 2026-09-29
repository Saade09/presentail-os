import type { Product } from "@workspace/db/schema";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TARGET_COUNTRY = "LB";
const DEFAULT_CONTENT_LANGUAGE = "en";
const PRESENTAIL_BASE_URL = "https://presentail.com/";

// Supported target countries and their corresponding price fields / currencies.
const COUNTRY_CURRENCY: Record<string, { currency: string; priceField: "priceUsd" | "priceAed"; discountField: "discountPriceUsd" | "discountPriceAed" }> = {
  LB: { currency: "USD", priceField: "priceUsd", discountField: "discountPriceUsd" },
  AE: { currency: "AED", priceField: "priceAed", discountField: "discountPriceAed" },
};

// Default city per target country used in the product URL path.
const COUNTRY_CITY: Record<string, string> = {
  LB: "beirut",
  AE: "dubai",
};

const SUPPORTED_COUNTRIES = Object.keys(COUNTRY_CURRENCY);
const SUPPORTED_LANGUAGES = ["en", "ar"];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MerchantPrice {
  amount: number;
  currencyCode: string;
  amountMicros: string;
}

export interface MerchantShipping {
  country: string;
  price: {
    amountMicros: string;
    currencyCode: string;
  };
}

/**
 * Delivery configuration from delivery_settings that drives the GMC shipping
 * attribute. Only the two global fields are needed.
 */
export interface DeliveryConfig {
  /** Global standard delivery fee in the workspace's currency (USD for LB, AED for AE). */
  globalStandardFee: number | null;
  /**
   * When 0, free delivery is globally enabled and the shipping price is 0.
   * When null or > 0, globalStandardFee is used as the shipping price.
   */
  globalFreeDeliveryThreshold: number | null;
}

export interface MerchantValidationResult {
  valid: boolean;
  errors: string[];
}

export interface MerchantProductAttributes {
  title: string;
  description: string;
  link: string;
  imageLink: string;
  additionalImageLinks?: string[];
  availability: string;
  price: MerchantPrice;
  brand?: string;
  googleProductCategory?: string;
  identifierExists: false;
  condition: "NEW";
  shipping?: MerchantShipping[];
}

export interface MerchantProductInput {
  offerId: string;
  contentLanguage: string;
  feedLabel: string;
  productAttributes: MerchantProductAttributes;
}
export interface ExplicitMerchantProduct {
  id: number; name: string; sku: string | null; priceUsd: string | null; priceAed: string | null;
  discountPriceUsd?: string | null; discountPriceAed?: string | null; mainImageUrl: string | null;
  additionalImageUrls: string[]; description: string | null; descriptionAr?: string | null; status: string;
  isArchived: boolean; brand?: string | null; googleProductCategory?: string | null;
}
export interface MerchantMarket { country: "LB" | "AE"; contentLanguage: "en"; city: "beirut" | "dubai"; }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveTargetCountry(product: Product): string {
  return (product.targetCountry ?? DEFAULT_TARGET_COUNTRY).toUpperCase();
}

function resolveContentLanguage(product: Product): string {
  return (product.contentLanguage ?? DEFAULT_CONTENT_LANGUAGE).toLowerCase();
}

function parseNumeric(value: string | null | undefined): number {
  if (value == null) return 0;
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Convert a product name into a URL-safe slug.
 * - Lowercase and trim
 * - Strip apostrophes
 * - Replace any non-alphanumeric character with a hyphen
 * - Collapse repeated hyphens
 * - Remove leading/trailing hyphens
 */
export function slugifyProductName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/'/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * Build a GMC-compatible shipping entry for a given target country and
 * workspace delivery configuration.
 *
 * - When `globalFreeDeliveryThreshold` is 0, free delivery is globally active
 *   and the shipping price is sent as 0.
 * - Otherwise `globalStandardFee` (defaulting to 0 when absent) is used.
 * - Currency is resolved from COUNTRY_CURRENCY (USD for LB, AED for AE).
 */
export function buildShippingEntry(country: string, config: DeliveryConfig): MerchantShipping {
  const currencyCode = COUNTRY_CURRENCY[country]?.currency ?? "USD";
  const isFree = config.globalFreeDeliveryThreshold === 0;
  const fee = isFree ? 0 : (config.globalStandardFee ?? 0);
  const amountMicros = String(Math.round(fee * 1_000_000));
  return {
    country,
    price: { amountMicros, currencyCode },
  };
}

/**
 * Build the Google Merchant Center offerId for a product.
 * Format: `{sku|PRESENTAIL-{id}}-{targetCountry}`
 */
export function getMerchantOfferId(product: Product): string {
  const country = resolveTargetCountry(product);
  const trimmedSku = product.sku?.trim();
  const base = trimmedSku ? trimmedSku : `PRESENTAIL-${product.id}`;
  return `${base}-${country}`;
}

/**
 * Resolve the price to submit to Google Merchant Center.
 * - AE feed: uses AED prices (priceAed / discountPriceAed)
 * - LB feed (default): uses USD prices (priceUsd / discountPriceUsd)
 * - A discount price wins when it is greater than 0.
 * - amountMicros is the amount expressed as an integer string in micros
 *   (1 unit = 1,000,000 micros).
 */
export function getMerchantPrice(product: Product): MerchantPrice {
  const country = resolveTargetCountry(product);
  const config = COUNTRY_CURRENCY[country] ?? COUNTRY_CURRENCY[DEFAULT_TARGET_COUNTRY];

  const regularAmount = parseNumeric(product[config.priceField] as string | null);
  const discountAmount = parseNumeric(product[config.discountField] as string | null);

  const amount = discountAmount > 0 ? discountAmount : regularAmount;
  const amountMicros = String(Math.round(amount * 1_000_000));

  return {
    amount,
    currencyCode: config.currency,
    amountMicros,
  };
}

/**
 * Resolve the Google Merchant Center availability string.
 * - Archived products → OUT_OF_STOCK
 * - status = "available" → IN_STOCK
 * - Any other status → OUT_OF_STOCK
 */
export function getMerchantAvailability(product: Product): "IN_STOCK" | "OUT_OF_STOCK" {
  if (product.isArchived) return "OUT_OF_STOCK";
  if (product.status === "available") return "IN_STOCK";
  return "OUT_OF_STOCK";
}

/**
 * Resolve the product description for the Merchant feed entry.
 * - When content_language is "ar" and an Arabic description exists → use it.
 * - Otherwise use the English description if present.
 * - Fallback to the product name.
 */
export function getMerchantDescription(product: Product): string {
  const lang = resolveContentLanguage(product);
  if (lang === "ar" && product.descriptionAr) {
    return product.descriptionAr;
  }
  if (product.description) {
    return product.description;
  }
  return product.name;
}

/**
 * Build the canonical product URL on presentail.com.
 *
 * Format: https://presentail.com/{locale}/{city}/product/{slug}
 *
 * Locale is derived from content_language + target_country:
 *   en + LB → en-lb,  ar + LB → ar-lb
 *   en + AE → en-ae,  ar + AE → ar-ae
 *   (defaults: content_language=en, target_country=LB → en-lb)
 *
 * City defaults: LB → beirut, AE → dubai.
 *
 * Slug resolution (in priority order):
 *   1. `publicSlug` when provided and non-empty (the stored `product_publications.public_slug`)
 *   2. `slugifyProductName(product.name)` as a fallback
 *
 * Throws when the resulting slug would be empty (name is blank/symbols-only and
 * no stored slug is provided).
 */
export function getMerchantProductUrl(product: Product, publicSlug?: string | null): string {
  const country = resolveTargetCountry(product);
  const lang = resolveContentLanguage(product);

  const localePath = `${lang}-${country.toLowerCase()}`;
  const city = COUNTRY_CITY[country] ?? "beirut";
  const slug = (publicSlug && publicSlug.trim()) ? publicSlug.trim() : slugifyProductName(product.name ?? "");

  if (!slug) {
    throw new Error("Cannot build product URL: product name produces an empty slug");
  }

  return `${PRESENTAIL_BASE_URL}${localePath}/${city}/product/${slug}`;
}

/**
 * Validate a product against the rules required before it can be synced
 * to Google Merchant Center. Defaults target_country to LB and content_language
 * to en when those fields are absent.
 *
 * Pass `publicSlug` (from `product_publications.public_slug`) to validate against
 * the stored slug instead of the name-derived one. When absent, the slug is
 * computed from the product name as before.
 *
 * Returns { valid, errors } — valid is true only when errors is empty.
 */
export function validateMerchantProduct(product: Product, publicSlug?: string | null): MerchantValidationResult {
  const errors: string[] = [];

  const country = resolveTargetCountry(product);
  const lang = resolveContentLanguage(product);

  // 1. target_country must be a supported value
  if (!SUPPORTED_COUNTRIES.includes(country)) {
    errors.push(`target_country "${country}" is not supported; must be one of: ${SUPPORTED_COUNTRIES.join(", ")}`);
  }

  // 2. content_language must be a supported value
  if (!SUPPORTED_LANGUAGES.includes(lang)) {
    errors.push(`content_language "${lang}" is not supported; must be one of: ${SUPPORTED_LANGUAGES.join(", ")}`);
  }

  // 3. main_image_url must be present and start with https://
  if (!product.mainImageUrl || !product.mainImageUrl.startsWith("https://")) {
    errors.push("main_image_url must be a valid HTTPS URL");
  }

  // 4. Product name must be non-empty (also required to generate the URL slug)
  if (!product.name || product.name.trim() === "") {
    errors.push("name must not be empty");
  }

  // 5. Effective slug must not be empty.
  //    Priority: stored publicSlug (non-empty) > slugified product name.
  const effectiveSlug = (publicSlug && publicSlug.trim())
    ? publicSlug.trim()
    : slugifyProductName(product.name ?? "");
  if (!effectiveSlug) {
    errors.push("product name produces an empty slug; add letters or numbers to the name");
  }

  // 6. Generated product URL must start with https://
  if (effectiveSlug) {
    try {
      const url = getMerchantProductUrl(product, publicSlug);
      if (!url.startsWith("https://")) {
        errors.push("generated product URL must start with https://");
      }
    } catch {
      errors.push("generated product URL must start with https://");
    }
  }

  // 7. Resolved merchant description must be non-empty
  const description = getMerchantDescription(product);
  if (!description || description.trim() === "") {
    errors.push("description must not be empty");
  }

  // 8. Price must be greater than zero for the target country
  const price = getMerchantPrice(product);
  if (price.amount <= 0) {
    errors.push(`price for target country "${country}" must be greater than 0`);
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Assemble the full Merchant product input shape ready to be sent to
 * the Google Merchant API.
 *
 * Validates the product first and throws if any validation rule fails.
 *
 * - `publicSlug` (from `product_publications.public_slug`): when non-empty,
 *   used as the product URL slug instead of the name-derived fallback.
 * - `deliveryConfig`: when provided, attaches a `shipping` array entry for
 *   the product's target country. Omitted gracefully when absent.
 * - Omits optional fields (additionalImageLinks, brand, googleProductCategory,
 *   shipping) when absent.
 * - Only includes HTTPS URLs in additionalImageLinks.
 * - Always sets identifierExists: false and condition: "NEW".
 *
 * Throws if validation fails.
 */
export function buildMerchantProductInput(product: Product, publicSlug?: string | null, deliveryConfig?: DeliveryConfig): MerchantProductInput {
  const validation = validateMerchantProduct(product, publicSlug);
  if (!validation.valid) {
    throw new Error(validation.errors.join("; "));
  }

  const country = resolveTargetCountry(product);
  const lang = resolveContentLanguage(product);

  const httpsAdditionalImages = (product.additionalImageUrls ?? []).filter(
    (url) => typeof url === "string" && url.startsWith("https://"),
  );

  const attributes: MerchantProductAttributes = {
    title: product.name,
    description: getMerchantDescription(product),
    link: getMerchantProductUrl(product, publicSlug),
    imageLink: product.mainImageUrl ?? "",
    availability: getMerchantAvailability(product),
    price: getMerchantPrice(product),
    identifierExists: false,
    condition: "NEW",
  };

  if (httpsAdditionalImages.length > 0) {
    attributes.additionalImageLinks = httpsAdditionalImages;
  }

  const trimmedBrand = product.brand?.trim();
  if (trimmedBrand) {
    attributes.brand = trimmedBrand;
  }

  const trimmedCategory = product.googleProductCategory?.trim();
  if (trimmedCategory) {
    attributes.googleProductCategory = trimmedCategory;
  }

  if (deliveryConfig) {
    attributes.shipping = [buildShippingEntry(country, deliveryConfig)];
  }

  return {
    offerId: getMerchantOfferId(product),
    contentLanguage: lang,
    feedLabel: country,
    productAttributes: attributes,
  };
}

/** New offer-scoped builder. Its market is required; it never reads legacy product columns. */
export function buildMerchantProductInputForMarket(product: ExplicitMerchantProduct, market: MerchantMarket, publicSlug: string): MerchantProductInput {
  const errors: string[] = [];
  if (!product.name?.trim()) errors.push("name must not be empty");
  if (!publicSlug?.trim()) errors.push("active publication requires public_slug");
  const mainImageUrl = product.mainImageUrl;
  if (!mainImageUrl?.startsWith("https://")) errors.push("main_image_url must be a valid HTTPS URL");
  const raw = market.country === "AE" ? (product.discountPriceAed ?? product.priceAed) : (product.discountPriceUsd ?? product.priceUsd);
  const amount = parseNumeric(raw);
  if (amount <= 0) errors.push(`price for ${market.country} must be greater than 0`);
  const description = market.contentLanguage === "en" ? (product.description ?? product.name) : product.name;
  if (!description.trim()) errors.push("description must not be empty");
  if (errors.length) throw new Error(errors.join("; "));
  if (!mainImageUrl) {
    throw new Error("main_image_url must be a valid HTTPS URL");
  }
  const priceConfig = COUNTRY_CURRENCY[market.country];
  const base = product.sku?.trim() || `PRESENTAIL-${product.id}`;
  return {
    offerId: `${base}-${market.country}`, contentLanguage: market.contentLanguage, feedLabel: market.country,
    productAttributes: {
      title: product.name, description, link: `${PRESENTAIL_BASE_URL}${market.contentLanguage}-${market.country.toLowerCase()}/${market.city}/product/${publicSlug.trim()}`,
      imageLink: mainImageUrl, availability: product.isArchived || product.status !== "available" ? "OUT_OF_STOCK" : "IN_STOCK",
      price: { amount, currencyCode: priceConfig.currency, amountMicros: String(Math.round(amount * 1_000_000)) },
      identifierExists: false, condition: "NEW",
      ...(product.additionalImageUrls.filter((x) => x.startsWith("https://")).length ? { additionalImageLinks: product.additionalImageUrls.filter((x) => x.startsWith("https://")) } : {}),
      ...(product.brand?.trim() ? { brand: product.brand.trim() } : {}),
      ...(product.googleProductCategory?.trim() ? { googleProductCategory: product.googleProductCategory.trim() } : {}),
    },
  };
}
