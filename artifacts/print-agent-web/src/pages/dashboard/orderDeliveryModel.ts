export type DeliveryAddress = Record<string, unknown> | null | undefined;

export type AddressCollectorRequest = {
  id: string;
  status: string;
  risk_level?: string | null;
  submitted_address?: Record<string, unknown> | string | null;
  address_received_at?: string | null;
  resolution_outcome?: string | null;
  closure_reason?: string | null;
  closure_source?: string | null;
  closed_at?: string | null;
};

export type DeliveryPresentationModel = {
  /** The original customer-entered text, kept untouched for disclosure. */
  originalAddress: string | null;
  /** A safe-to-display destination from explicit address fields only. */
  destination: string | null;
  locality: string | null;
  country: string | null;
  instructions: string | null;
  mapUrl: string | null;
  copiedAddress: string | null;
  isIncomplete: boolean;
  usesCollectedAddress: boolean;
};

export function needsAddressCollectorAttention(
  request: Pick<AddressCollectorRequest, "status" | "risk_level" | "closed_at"> | null | undefined,
): boolean {
  return !!request && !request.closed_at && (
    request.risk_level === "at_risk" ||
    ["needs_review", "escalated", "whatsapp_failed"].includes(request.status)
  );
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function firstText(source: DeliveryAddress, keys: string[]): string | null {
  if (!source || typeof source !== "object") return null;
  for (const key of keys) {
    const value = text(source[key]);
    if (value) return value;
  }
  return null;
}

function joinUnique(parts: Array<string | null>): string | null {
  const values = parts.filter((part): part is string => !!part);
  const unique = [...new Set(values)];
  return unique.length ? unique.join(", ") : null;
}

function objectAddress(value: Record<string, unknown> | string | null | undefined): DeliveryAddress {
  if (typeof value === "string") return { address: value };
  return value ?? null;
}

function withoutUrls(value: string): string | null {
  const cleaned = value
    .replace(/\bhttps?:\/\/[^\s,;]+/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/(?:,\s*){2,}/g, ", ")
    .replace(/^[,\s;]+|[,\s;]+$/g, "")
    .trim();
  return cleaned || null;
}

function supportedMapUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    const host = url.hostname.toLowerCase();
    const isSupported =
      host === "maps.google.com" ||
      host.endsWith(".google.com") ||
      host === "maps.app.goo.gl" ||
      host === "goo.gl" ||
      host === "maps.apple.com";
    return isSupported ? url.toString() : null;
  } catch {
    return null;
  }
}

function sourceMapUrl(source: DeliveryAddress): string | null {
  const explicit = firstText(source, [
    "map_link",
    "maps_link",
    "maps_url",
    "google_maps_url",
    "google_maps_link",
    "location_url",
  ]);
  return supportedMapUrl(explicit);
}

/**
 * Creates a non-mutating model over legacy free-text delivery data. It only
 * uses explicit address fields, never derives a locality from prose, and keeps
 * the original raw address available for staff to inspect.
 */
export function buildDeliveryPresentationModel(input: {
  deliveryAddress: DeliveryAddress;
  deliveryInstructions?: string | null;
  addressCollectorRequest?: AddressCollectorRequest | null;
}): DeliveryPresentationModel {
  const original = input.deliveryAddress;
  const collected = objectAddress(input.addressCollectorRequest?.submitted_address);
  const source = collected ?? original;
  const originalAddress =
    firstText(original, [
      "address",
      "address_1",
      "full_address",
      "formatted_address",
      "delivery_address",
      "raw_address",
      "street",
    ]) ??
    joinUnique([
      firstText(original, ["street"]),
      firstText(original, ["building"]),
      firstText(original, ["floor"]),
      firstText(original, ["apartment"]),
      firstText(original, ["city"]),
      firstText(original, ["country"]),
    ]);
  const destination = withoutUrls(
    firstText(source, [
      "address",
      "address_1",
      "full_address",
      "formatted_address",
      "delivery_address",
      "street",
    ]) ?? "",
  );
  const locality = joinUnique([
    firstText(source, ["area", "city", "locality", "neighborhood"]),
    firstText(source, ["state", "province"]),
  ]);
  const country = firstText(source, ["country", "country_code"]);
  const instructions = joinUnique([
    text(input.deliveryInstructions),
    firstText(source, ["instructions", "delivery_instructions", "notes", "landmark"]),
  ]);
  const mapUrl = sourceMapUrl(source) ?? sourceMapUrl(original);
  const copiedAddress = joinUnique([destination, locality, country]);

  return {
    originalAddress,
    destination,
    locality,
    country,
    instructions,
    mapUrl,
    copiedAddress,
    isIncomplete: !destination,
    usesCollectedAddress: !!collected && !!destination,
  };
}