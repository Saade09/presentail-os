/**
 * Decide whether an order needs the Address Collector.
 *
 * This deliberately checks only delivery-address values. Recipient identity
 * and phone validation remain the responsibility of the collector service.
 */

const ADDRESS_VALUE_KEYS = [
  "address",
  "address_1",
  "address1",
  "street",
  "streetAddress",
  "street_address",
  "formatted_address",
  "fullAddress",
  "full_address",
] as const;

const PLACEHOLDER_ADDRESS_VALUES = new Set([
  "ask recipient",
  "ask the recipient",
  "confirm with recipient",
  "confirmed later",
  "provided later",
  "recipient to confirm",
  "to be confirmed",
  "to confirm",
  "tbc",
  "tbd",
  "n a",
  "na",
  "n/a",
  "none",
  "no address",
  "not provided",
  "unknown",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedAddressText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[.,:;!?()[\]{}"'`/\\_–—-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isPlaceholderDeliveryAddress(value: string): boolean {
  const normalized = normalizedAddressText(value);
  if (!normalized) return true;
  if (PLACEHOLDER_ADDRESS_VALUES.has(normalized)) return true;
  if (/^(?:to be|to)\s+confirmed(?:\s+by)?(?:\s+recipient)?(?:\s+ask(?:\s+the)?\s+recipient(?:\s+for)?(?:\s+address)?)?$/.test(normalized)
    || /^ask(?:\s+the)?\s+recipient(?:\s+for)?(?:\s+address)?$/.test(normalized)) {
    return true;
  }

  // Checkout clients sometimes concatenate several placeholder labels, e.g.
  // "To be confirmed — ask recipient for address — To be confirmed".
  // Remove only complete known phrases; any remaining text means this may be a
  // legitimate address and must be preserved.
  const withoutPlaceholderPhrases = normalized
    .replace(/\b(?:to be|to)\s+confirmed(?:\s+by)?(?:\s+recipient)?\b/g, " ")
    .replace(/\bask(?:\s+the)?\s+recipient(?:\s+for)?\s+address\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return withoutPlaceholderPhrases.length === 0;
}

/**
 * Returns true when a payload contains a non-empty, non-placeholder address.
 * City, district, and country-only objects intentionally do not count as a
 * usable delivery address.
 */
export function hasUsableDeliveryAddress(value: unknown): boolean {
  if (typeof value === "string") {
    return !isPlaceholderDeliveryAddress(value);
  }
  if (Array.isArray(value)) {
    return value.some((candidate) => hasUsableDeliveryAddress(candidate));
  }
  if (!isRecord(value)) return false;
  if (hasExplicitNoAddressMarker(value)) return false;

  for (const key of ADDRESS_VALUE_KEYS) {
    const candidate = value[key];
    if (typeof candidate === "string" && !isPlaceholderDeliveryAddress(candidate)) {
      return true;
    }
    if (isRecord(candidate) && hasUsableDeliveryAddress(candidate)) {
      return true;
    }
  }

  const latitude = Number(value.latitude ?? value.lat);
  const longitude = Number(value.longitude ?? value.lng);
  return Number.isFinite(latitude)
    && Number.isFinite(longitude)
    && (latitude !== 0 || longitude !== 0);
}

/**
 * Canonical missing-address decision shared by request creation and worker
 * revalidation. Keep every placeholder/no-address rule behind this boundary so
 * an accepted request cannot later be rejected by a different address test.
 */
export function isDeliveryAddressMissing(value: unknown): boolean {
  const addresses = Array.isArray(value) ? value : [value];
  if (addresses.some((address) => hasExplicitNoAddressMarker(address))) {
    return true;
  }
  return !hasUsableDeliveryAddress(value);
}

export type AddressCollectionEligibilityInput = {
  /** One address payload, or several legacy/current payloads to reconcile. */
  deliveryAddress?: unknown;
  /** The caller explicitly asked the collector to contact the recipient. */
  explicitRequest?: boolean | null;
};

/**
 * Explicit collection always wins. Otherwise, a missing/placeholder address
 * (including an explicit noAddress marker) is eligible for collection.
 */
export function shouldCollectAddressCollection(
  input: AddressCollectionEligibilityInput,
): boolean {
  if (input.explicitRequest === true) return true;
  return isDeliveryAddressMissing(input.deliveryAddress);
}

function hasExplicitNoAddressMarker(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasExplicitNoAddressMarker);
  if (!isRecord(value)) return false;
  if (value.noAddress === true || value.no_address === true) return true;
  return false;
}