import { randomUUID } from "node:crypto";
import { db, withTransaction } from "../db";
import { logger } from "../logger";
import { normalizePhoneForCountry } from "../respondio";
import type { GeocodeResult } from "../placeAiAssessor";
import type { NominatimReverseResult } from "../placeConflictChecker";
import { isDeliveryAddressMissing } from "./eligibility";

export type IncomingReply = {
  providerMessageId: string;
  rawPhone: string;
  channelId: string | null;
  contactId: string | null;
  inReplyToProviderMessageId: string | null;
  type: "text" | "location";
  text: string | null;
  latitude: number | null;
  longitude: number | null;
};

type ClaimedRequest = {
  id: string;
  workspace_owner_id: string;
  order_id: string | null;
  status: string;
  recipient_phone: string;
  respondio_contact_id: string | null;
  delivery_country_code: string | null;
  delivery_timezone: string;
  window_start: string | null;
  delivery_address: Record<string, unknown> | null;
  delivery_instructions: string | null;
  tookan_job_id: string | null;
  inbound_attempt_count?: number;
  inbound_claim_token?: string;
};

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

/** Preserve recipient text exactly; trimming it would alter the submitted address. */
function messageTextValue(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function numberValue(...values: unknown[]): number | null {
  for (const value of values) {
    const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
    if (Number.isFinite(number)) return number;
  }
  return null;
}

const MAP_REDIRECT_LIMIT = 3;
const MAP_RESPONSE_LIMIT = 64 * 1024;
const MAP_URL_RE = /https?:\/\/[^\s<>"']+/gi;
const ALLOWED_MAP_HOSTS = new Set([
  "google.com",
  "www.google.com",
  "maps.google.com",
  "maps.app.goo.gl",
  "goo.gl",
  "apple.com",
  "www.apple.com",
  "maps.apple.com",
]);

function supportedMapUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase();
    if (
      !ALLOWED_MAP_HOSTS.has(host)
      && !/^maps\.google\.(?:com|[a-z]{2,3}(?:\.[a-z]{2})?)$/i.test(host)
    ) return null;
    return url;
  } catch {
    return null;
  }
}

function validCoordinates(latitude: number, longitude: number): { latitude: number; longitude: number } | null {
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    && latitude >= -90 && latitude <= 90
    && longitude >= -180 && longitude <= 180
    ? { latitude, longitude }
    : null;
}

/** Extract coordinates from direct Google Maps and Apple Maps URL formats. */
export function parseMapUrlCoordinates(value: string): { latitude: number; longitude: number } | null {
  const url = supportedMapUrl(value);
  if (!url) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(url.toString());
  } catch {
    return null;
  }
  const patterns = [
    /@(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)/,
    /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/,
  ];
  for (const pattern of patterns) {
    const match = decoded.match(pattern);
    if (match) {
      const coordinates = validCoordinates(Number(match[1]), Number(match[2]));
      if (coordinates) return coordinates;
    }
  }
  for (const key of ["q", "query", "ll", "sll", "center"]) {
    const valueFromQuery = url.searchParams.get(key);
    if (!valueFromQuery) continue;
    const match = decodeURIComponent(valueFromQuery).match(
      /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/,
    );
    if (match) {
      const coordinates = validCoordinates(Number(match[1]), Number(match[2]));
      if (coordinates) return coordinates;
    }
  }
  return null;
}

function mapUrlsInText(value: string): URL[] {
  return value
    .match(MAP_URL_RE)
    ?.map((raw) => supportedMapUrl(raw.replace(/[),.;!?]+$/, "")))
    .filter((url): url is URL => Boolean(url)) ?? [];
}

function hasUrl(value: string): boolean {
  return /https?:\/\//i.test(value);
}

/**
 * Resolve only allowlisted HTTPS map links. Short links are followed manually
 * so every redirect is checked before the next request; response bodies are
 * bounded and never interpreted as arbitrary addresses.
 */
export async function resolveSupportedMapLink(value: string): Promise<{ latitude: number; longitude: number } | null> {
  const first = value.match(MAP_URL_RE)?.[0]?.replace(/[),.;!?]+$/, "");
  const initial = first ? supportedMapUrl(first) : null;
  if (!initial) return null;
  let current: URL = initial;
  for (let redirect = 0; redirect <= MAP_REDIRECT_LIMIT; redirect += 1) {
    const direct = parseMapUrlCoordinates(current.toString());
    if (direct) return direct;
    if (redirect === MAP_REDIRECT_LIMIT) return null;
    try {
      const response: Response = await fetch(current, {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(4_000),
        headers: { Accept: "text/html,application/xhtml+xml" },
      });
      if (response.status < 300 || response.status >= 400) {
        const length = Number(response.headers.get("content-length") ?? "0");
        if (length > MAP_RESPONSE_LIMIT) return null;
        if (response.body) {
          const reader = response.body.getReader();
          let total = 0;
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            total += chunk.value.byteLength;
            if (total > MAP_RESPONSE_LIMIT) {
              await reader.cancel();
              return null;
            }
          }
        }
        return null;
      }
      const location: string | null = response.headers.get("location");
      const next: URL | null = location ? new URL(location, current) : null;
      if (!next || !supportedMapUrl(next.toString())) return null;
      current = next;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Parse both documented Respond.io New Incoming Message shapes. Respond.io has
 * emitted message fields directly under data and under data.message over time,
 * so the parser deliberately supports both without accepting outbound events.
 */
export type RespondIoIncomingParserClassification =
  | "text"
  | "location"
  | "unsupported_location"
  | "unsupported_payload"
  | "unsupported_event"
  | "unsupported_outbound"
  | "missing_identifier"
  | "missing_channel"
  | "missing_content";

export type RespondIoIncomingParseResult = {
  reply: IncomingReply | null;
  classification: RespondIoIncomingParserClassification;
};

export function parseRespondIoIncomingMessageWithClassification(
  payload: unknown,
): RespondIoIncomingParseResult {
  const root = object(payload);
  if (!root) return { reply: null, classification: "unsupported_payload" };
  const data = object(root.data) ?? root;
  const message = object(data.message) ?? data;
  const messageContent = object(message.message) ?? object(message.content);
  const contact = object(data.contact) ?? object(root.contact);
  const sender = object(message.sender) ?? object(data.sender);
  const channel = object(data.channel) ?? object(root.channel);
  const eventName = stringValue(root.event_type, root.eventType, root.event, root.type)?.toLowerCase() ?? "";
  const direction = stringValue(
    message.traffic,
    message.direction,
    data.direction,
    root.direction,
  )?.toLowerCase();

  if (
    direction && !["incoming", "inbound", "received"].includes(direction)
    || /\b(outgoing|outbound|sent)\b/.test(eventName)
  ) {
    return { reply: null, classification: "unsupported_outbound" };
  }
  if (eventName && !/(incoming|received|message)/.test(eventName)) {
    return { reply: null, classification: "unsupported_event" };
  }

  const providerMessageId = stringValue(
    message.messageId,
    message.message_id,
    message.id,
    data.messageId,
    data.message_id,
  );
  const contactId = stringValue(contact?.id, contact?.contactId, data.contactId);
  const rawPhone = stringValue(
    contact?.phone,
    contact?.phoneNumber,
    contact?.phone_number,
    sender?.phone,
    sender?.phoneNumber,
    data.from,
    message.from,
  );
  if (!providerMessageId || (!rawPhone && !contactId)) {
    return { reply: null, classification: "missing_identifier" };
  }
  const context = object(message.context) ?? object(message.replyTo) ?? object(data.context);
  const inReplyToProviderMessageId = stringValue(
    message.replyToMessageId,
    message.reply_to_message_id,
    context?.messageId,
    context?.message_id,
    context?.id,
  );

  const declaredMessageType = stringValue(messageContent?.type, message.type)?.toLowerCase() ?? "";
  const nativeLocation = object(message.location) ?? object(messageContent?.location);
  const supportedLocationType = ["location", "shared_location", "location_pin"]
    .includes(declaredMessageType);
  const location = nativeLocation ?? (supportedLocationType ? messageContent : null);
  const locationMessage = Boolean(location)
    && (!declaredMessageType || supportedLocationType);
  const latitude = numberValue(
    locationMessage ? location?.latitude : null,
    locationMessage ? location?.lat : null,
    locationMessage ? message.latitude : null,
    locationMessage ? message.lat : null,
  );
  const longitude = numberValue(
    locationMessage ? location?.longitude : null,
    locationMessage ? location?.lng : null,
    locationMessage ? location?.lon : null,
    locationMessage ? message.longitude : null,
    locationMessage ? message.lng : null,
    locationMessage ? message.lon : null,
  );
  const channelId = stringValue(
    channel?.id,
    channel?.channelId,
    message.channelId,
    data.channelId,
    root.channelId,
  );
  if (!channelId) return { reply: null, classification: "missing_channel" };

  if (locationMessage) {
    const hasValidCoordinates =
      latitude !== null && longitude !== null
      && latitude >= -90 && latitude <= 90
      && longitude >= -180 && longitude <= 180;
    return {
      classification: hasValidCoordinates ? "location" : "unsupported_location",
      reply: {
        providerMessageId,
        rawPhone: rawPhone ?? "",
        channelId,
        contactId,
        inReplyToProviderMessageId,
        type: "location",
        text: messageTextValue(location?.name, location?.address),
        latitude: hasValidCoordinates ? latitude : null,
        longitude: hasValidCoordinates ? longitude : null,
      },
    };
  }

  const text = messageTextValue(
    messageContent?.text,
    messageContent?.body,
    message.text,
    message.body,
    data.text,
  );
  if (!text) return { reply: null, classification: "missing_content" };
  return {
    classification: "text",
    reply: {
      providerMessageId,
      rawPhone: rawPhone ?? "",
      channelId,
      contactId,
      inReplyToProviderMessageId,
      type: "text",
      text,
      latitude: null,
      longitude: null,
    },
  };
}

export function parseRespondIoIncomingMessage(payload: unknown): IncomingReply | null {
  return parseRespondIoIncomingMessageWithClassification(payload).reply;
}

export async function registerIncomingReply(reply: IncomingReply): Promise<boolean> {
  const inserted = await db.query(
    `INSERT INTO address_collection_inbound_messages
       (provider_message_id, channel_id, contact_id, reply_to_provider_ref,
        normalized_phone, reply_type, reply_text, latitude, longitude)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (provider_message_id) DO NOTHING
     RETURNING id`,
    [
      reply.providerMessageId,
      reply.channelId,
      reply.contactId,
      reply.inReplyToProviderMessageId,
      normalizePhoneForCountry(reply.rawPhone) ?? reply.rawPhone,
      reply.type,
      reply.text,
      reply.latitude,
      reply.longitude,
    ],
  );
  return inserted.rowCount === 1;
}

const CLAIM_LEASE_MINUTES = 10;
const ACTIVE_REPLY_STATUSES = [
  "awaiting_address",
  "scheduled",
  "whatsapp_queued",
  "whatsapp_sent",
  "whatsapp_delivered",
  "whatsapp_failed",
  "sms_fallback_sent",
  "link_opened",
  "in_progress",
] as const;

async function recordUnmatchedOutcome(
  client: { query: typeof db.query },
  providerMessageId: string,
  outcome: string,
): Promise<void> {
  await client.query(
    `UPDATE address_collection_inbound_messages
        SET outcome = $2, processed_at = now(), processing_started_at = NULL
      WHERE provider_message_id = $1 AND processed_at IS NULL`,
    [providerMessageId, outcome],
  );
}

async function claimRequest(reply: IncomingReply): Promise<ClaimedRequest | null> {
  const client = await db.connect();
  try {
    return await withTransaction(client, async () => {
      const inbound = await client.query<{
        processed_at: string | null;
        processing_started_at: string | null;
        next_attempt_at: string | null;
        request_id: string | null;
      }>(
        `SELECT processed_at, processing_started_at, next_attempt_at, request_id
           FROM address_collection_inbound_messages
          WHERE provider_message_id = $1
          FOR UPDATE`,
        [reply.providerMessageId],
      );
      if (!inbound.rows[0] || inbound.rows[0].processed_at) return null;
      const nextAttempt = inbound.rows[0].next_attempt_at
        ? new Date(inbound.rows[0].next_attempt_at).getTime()
        : 0;
      if (nextAttempt > Date.now()) return null;
      const leaseStarted = inbound.rows[0].processing_started_at
        ? new Date(inbound.rows[0].processing_started_at).getTime()
        : 0;
      if (leaseStarted > Date.now() - CLAIM_LEASE_MINUTES * 60_000) return null;

      const previouslyClaimed = inbound.rows[0].request_id
        ? await client.query<ClaimedRequest>(
        `SELECT r.id, r.workspace_owner_id, r.order_id, r.recipient_phone,
                 r.status, r.respondio_contact_id, r.delivery_country_code, r.delivery_timezone, r.window_start,
                 r.created_at, o.delivery_address, o.delivery_instructions, o.tookan_job_id
           FROM address_collection_inbound_messages m
           JOIN address_collection_requests r ON r.id = m.request_id
           LEFT JOIN orders o ON o.id = r.order_id AND o.workspace_owner_id = r.workspace_owner_id
          WHERE m.provider_message_id = $1 AND m.processed_at IS NULL
            AND r.status = 'processing'
          FOR UPDATE OF r`,
        [reply.providerMessageId],
          )
        : null;

      let workspaceId: string | null = null;
      if (reply.channelId) {
        const channel = await client.query<{ workspace_owner_id: string }>(
          `SELECT workspace_owner_id
             FROM omni_channel_accounts
            WHERE provider = 'respondio' AND external_account_id = $1 AND is_active = true
            LIMIT 2`,
          [reply.channelId],
        );
        workspaceId = channel.rows.length === 1 ? channel.rows[0].workspace_owner_id : null;
      }
      if (!reply.channelId || !workspaceId) {
        await recordUnmatchedOutcome(client, reply.providerMessageId, "unmapped_channel");
        return null;
      }

      const candidates = await client.query<ClaimedRequest>(
        `SELECT r.id, r.workspace_owner_id, r.order_id, r.recipient_phone,
                 r.status, r.respondio_contact_id, r.delivery_country_code, r.delivery_timezone, r.window_start,
                r.created_at, o.delivery_address, o.delivery_instructions, o.tookan_job_id
           FROM address_collection_requests r
           LEFT JOIN orders o ON o.id = r.order_id AND o.workspace_owner_id = r.workspace_owner_id
          WHERE r.status = ANY($2::text[])
            AND ($1::text IS NULL OR r.workspace_owner_id = $1)
            AND (r.respondio_channel_id IS NULL OR r.respondio_channel_id = $3)
          ORDER BY r.created_at DESC, r.id DESC
          FOR UPDATE OF r`,
        [
          workspaceId,
          ACTIVE_REPLY_STATUSES,
          reply.channelId,
        ],
      );

      const eligibleCandidates = candidates.rows.filter((candidate) =>
        candidate.order_id !== null && isDeliveryAddressMissing(candidate.delivery_address));
      const selection = selectUniqueCandidate(eligibleCandidates, reply);
      const chosen =
        previouslyClaimed?.rows[0]
        ?? selection.chosen;
      if (!chosen) {
        await recordUnmatchedOutcome(
          client,
          reply.providerMessageId,
          selection.outcome,
        );
        return null;
      }

      const previousStatus = chosen.status;
      const claimed = previouslyClaimed?.rows[0]
        ? { rowCount: 1 }
        : await client.query(
        `UPDATE address_collection_requests
            SET status = 'processing', processing_started_at = now(), updated_at = now()
          WHERE id = $1 AND status = ANY($2::text[])
          RETURNING id`,
        [
          chosen.id,
          ACTIVE_REPLY_STATUSES,
        ],
      );
      if (claimed.rowCount !== 1) return null;

      const normalizedPhone =
        normalizePhoneForCountry(reply.rawPhone, chosen.delivery_country_code)
        ?? reply.rawPhone;
      const claimToken = randomUUID();
      const messageClaim = await client.query<{ attempt_count: number }>(
        `UPDATE address_collection_inbound_messages
            SET workspace_owner_id = $2, request_id = $3, normalized_phone = $4,
                contact_id = COALESCE(contact_id, $5), processing_started_at = now(),
                 next_attempt_at = NULL, attempt_count = attempt_count + 1,
                 claim_token = $6
          WHERE provider_message_id = $1 AND processed_at IS NULL
          RETURNING attempt_count`,
        [
          reply.providerMessageId,
          chosen.workspace_owner_id,
          chosen.id,
          normalizedPhone,
          reply.contactId,
          claimToken,
        ],
      );
      if (!previouslyClaimed?.rows[0]) await client.query(
        `INSERT INTO address_collection_events
           (request_id, event_type, previous_state, new_state, actor, channel, provider_ref, metadata)
         VALUES ($1,'reply_claimed',$2,'processing','recipient','whatsapp',$3,$4)`,
        [
          chosen.id,
          previousStatus,
          reply.providerMessageId,
          JSON.stringify({
            normalized_phone: normalizedPhone,
            reply_type: reply.type,
            reply_text: reply.type === "text" ? reply.text : null,
            coordinates:
              reply.type === "location"
                ? { latitude: reply.latitude, longitude: reply.longitude }
                : null,
          }),
        ],
      );
      return {
        ...chosen,
        status: previousStatus === "processing" ? "awaiting_address" : previousStatus,
        inbound_attempt_count: messageClaim.rows[0]?.attempt_count ?? 1,
        inbound_claim_token: claimToken,
      };
    });
  } finally {
    client.release();
  }
}

function addressContext(request: ClaimedRequest) {
  const address = object(request.delivery_address) ?? {};
  return {
    city: stringValue(address.city, address.cityName),
    country: request.delivery_country_code ?? stringValue(address.country, address.countryCode),
    area: stringValue(address.area, address.district),
    canonicalAddress: stringValue(address.address),
    phone: request.recipient_phone,
    deliveryInstructions: request.delivery_instructions,
  };
}

function normalizedGeo(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ");
}

/**
 * Automatic order mutation is deliberately fail-closed. The request must
 * carry an ISO delivery country and the same successful reverse-geocode
 * result must confirm it. When a city is known, that result must confirm a
 * compatible locality too. Missing provider data is indeterminate/review,
 * never implicit approval.
 */
function validateReverseGeography(
  reverse: NominatimReverseResult | null,
  request: Pick<ClaimedRequest, "delivery_country_code">,
  city: string | null,
): { valid: boolean; reason: string } {
  const address = reverse?.address;
  if (!address || !reverse?.display_name) {
    return { valid: false, reason: "reverse_geocode_unavailable" };
  }
  const expectedCountry = request.delivery_country_code?.trim().toLowerCase();
  const actualCountry = address.country_code?.trim().toLowerCase();
  if (!expectedCountry || !/^[a-z]{2}$/.test(expectedCountry)) {
    return { valid: false, reason: "delivery_country_missing" };
  }
  if (!actualCountry) return { valid: false, reason: "reverse_country_missing" };
  if (actualCountry !== expectedCountry) {
    return { valid: false, reason: "country_mismatch" };
  }
  if (city) {
    const expectedCity = normalizedGeo(city);
    const beirutAliases = ["beirut", "بيروت", "محافظة بيروت"];
    const expectsBeirut =
      expectedCountry === "lb"
      && beirutAliases.some((alias) => {
        const normalizedAlias = normalizedGeo(alias);
        return expectedCity.includes(normalizedAlias) || normalizedAlias.includes(expectedCity);
      });
    const administrativeCodes = [
      address["ISO3166-2-lvl4"],
      address["ISO3166-2-lvl6"],
    ]
      .filter((value): value is string => Boolean(value))
      .map((value) => value.trim().toUpperCase());
    if (expectsBeirut && administrativeCodes.includes("LB-BA")) {
      return { valid: true, reason: "verified" };
    }
    const localities = [
      address.city,
      address.town,
      address.village,
      address.municipality,
      address.county,
      address.state_district,
      address.suburb,
      address.state,
    ]
      .filter((value): value is string => Boolean(value))
      .map(normalizedGeo);
    if (
      localities.length === 0
      || !localities.some((value) =>
        value.includes(expectedCity)
        || expectedCity.includes(value)
        || (
          expectsBeirut
          && beirutAliases.some((alias) => value.includes(normalizedGeo(alias)))
        ))
    ) {
      return { valid: false, reason: "city_mismatch" };
    }
  }
  return { valid: true, reason: "verified" };
}

function canonicalAddress(opts: {
  fallbackLabel: string;
  canonicalText?: string;
  latitude: number;
  longitude: number;
  reverse: NominatimReverseResult;
  geocode?: GeocodeResult | null;
  source: "text" | "map_link" | "shared_location";
}): Record<string, unknown> {
  const address = object(opts.reverse.address) ?? {};
  const city = stringValue(
    address.city,
    address.town,
    address.village,
    address.municipality,
    address.county,
  );
  const area = stringValue(
    address.suburb,
    address.neighbourhood,
    address.quarter,
    address.state_district,
  );
  const country = stringValue(address.country);
  const countryCode = stringValue(address.country_code)?.toUpperCase() ?? null;
  const formattedAddress = opts.canonicalText?.trim()
    || stringValue(opts.reverse.display_name, opts.fallbackLabel) as string;
  return {
    address: formattedAddress,
    formattedAddress,
    ...(city ? { city, cityName: city } : {}),
    ...(area ? { area, district: area } : {}),
    ...(country ? { country } : {}),
    ...(countryCode ? { countryCode } : {}),
    latitude: opts.latitude,
    longitude: opts.longitude,
    lat: opts.latitude,
    lng: opts.longitude,
    location: { latitude: opts.latitude, longitude: opts.longitude },
    placeMetadata: {
      provider: "nominatim",
      placeIdentity: opts.geocode?.placeIdentity ?? null,
      matchedLocation: opts.geocode?.matchedLocation ?? formattedAddress,
      precision: opts.geocode?.precision ?? "coordinate",
      method: opts.geocode?.method ?? "reverse_geocode",
    },
    geocodeProvider: opts.geocode?.provider ?? "nominatim",
    geocodeMatchType: opts.geocode?.matchType ?? "exact",
    geocodePrecision: opts.geocode?.precision ?? "exact",
    geocodeMethod: opts.geocode?.method ?? "reverse_geocode",
    collection_source: "respondio",
    collection_reply_type: opts.source,
  };
}

const CANONICAL_ADDRESS_KEYS = new Set([
  "address", "formattedAddress", "city", "cityName", "area", "district",
  "country", "countryCode", "latitude", "longitude", "lat", "lng",
  "location", "placeMetadata", "geocodeProvider", "geocodeMatchType",
  "geocodePrecision", "geocodeMethod",
  "collection_source", "collection_reply_type",
  // These fields are used by the order/collector contract to mark that an
  // address still needs to be collected. They must not survive a successful
  // recipient reply, even when the old JSON snapshot contained them.
  "noAddress", "no_address", "address_1", "address1", "streetAddress",
  "street_address", "fullAddress", "full_address",
]);

function replaceCanonicalAddress(
  previous: Record<string, unknown> | null,
  canonical: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...Object.fromEntries(
      Object.entries(previous ?? {}).filter(([key]) => !CANONICAL_ADDRESS_KEYS.has(key)),
    ),
    ...canonical,
  };
}

function selectUniqueCandidate(
  candidates: ClaimedRequest[],
  reply: Pick<IncomingReply, "contactId" | "rawPhone">,
): { chosen: ClaimedRequest | null; outcome: "matched" | "ambiguous_request" | "unknown_phone" } {
  const matching = candidates.filter((candidate) => {
    const incomingPhone = normalizePhoneForCountry(
      reply.rawPhone,
      candidate.delivery_country_code,
    );
    const recipientPhone = normalizePhoneForCountry(
      candidate.recipient_phone,
      candidate.delivery_country_code,
    );
    return incomingPhone !== null
      && recipientPhone !== null
      && incomingPhone === recipientPhone;
  });
  if (matching.length === 0) {
    return { chosen: null, outcome: "unknown_phone" };
  }
  // The recipient may have multiple active orders. The newest order whose
  // address is still missing is the only eligible association; contact IDs and
  // reply-to conversation history are not order identity.
  return {
    chosen: matching[0],
    outcome: "matched",
  };
}

async function retryIncomingReply(
  request: ClaimedRequest,
  reply: IncomingReply,
  error: string,
): Promise<void> {
  if ((request.inbound_attempt_count ?? 1) >= 4) {
    await finishWithoutOrderUpdate({
      request,
      reply,
      status: "needs_review",
      outcome: "transient_retry_exhausted",
      error,
    });
    return;
  }
  const backoffMinutes = Math.min(15, 2 ** Math.max(0, (request.inbound_attempt_count ?? 1) - 1));
  const client = await db.connect();
  try {
    await withTransaction(client, async () => {
      const lease = await client.query(
        `SELECT 1 FROM address_collection_inbound_messages
          WHERE provider_message_id = $1 AND claim_token = $2
            AND processed_at IS NULL
          FOR UPDATE`,
        [reply.providerMessageId, request.inbound_claim_token],
      );
      if (lease.rowCount !== 1) return;
      await client.query(
        `UPDATE address_collection_requests
            SET status = $2, processing_started_at = NULL, inbound_error = $3,
                inbound_outcome = 'retry_scheduled', updated_at = now()
          WHERE id = $1 AND status = 'processing'`,
        [request.id, request.status, error],
      );
      await client.query(
        `UPDATE address_collection_inbound_messages
            SET processing_started_at = NULL, outcome = 'retry_scheduled',
                error_message = $2,
                 next_attempt_at = now() + ($3 || ' minutes')::interval,
                 claim_token = NULL
          WHERE provider_message_id = $1 AND claim_token = $4
            AND processed_at IS NULL`,
        [
          reply.providerMessageId,
          error,
          String(backoffMinutes),
          request.inbound_claim_token,
        ],
      );
      await client.query(
        `INSERT INTO address_collection_events
           (request_id, event_type, previous_state, new_state, actor, channel, provider_ref, metadata)
         VALUES ($1,'reply_retry_scheduled','processing',$2,'system','whatsapp',$3,$4)`,
        [
          request.id,
          request.status,
          reply.providerMessageId,
          JSON.stringify({
            attempt: request.inbound_attempt_count ?? 1,
            retry_in_minutes: backoffMinutes,
            error,
          }),
        ],
      );
    });
  } finally {
    client.release();
  }
}

async function finishWithoutOrderUpdate(opts: {
  request: ClaimedRequest;
  reply: IncomingReply;
  status: "needs_review" | "failed";
  outcome: string;
  classifier?: unknown;
  confidence?: number | null;
  error?: string | null;
}): Promise<void> {
  const client = await db.connect();
  try {
    await withTransaction(client, async () => {
      const lease = await client.query(
        `SELECT 1 FROM address_collection_inbound_messages
          WHERE provider_message_id = $1 AND claim_token = $2
            AND processed_at IS NULL
          FOR UPDATE`,
        [opts.reply.providerMessageId, opts.request.inbound_claim_token],
      );
      if (lease.rowCount !== 1) return;
      const updated = await client.query(
        `UPDATE address_collection_requests
            SET status = $2, inbound_reply_type = $3, inbound_reply_text = $4,
                inbound_lat = $5, inbound_lng = $6, inbound_classifier = $7,
                inbound_confidence = $8, inbound_outcome = $9, inbound_error = $10,
                resolution_outcome = CASE WHEN $2 = 'failed' THEN 'failed' ELSE resolution_outcome END,
                closure_reason = CASE WHEN $2 = 'failed' THEN COALESCE($10, $9) ELSE closure_reason END,
                closure_source = CASE WHEN $2 = 'failed' THEN 'incoming_reply' ELSE closure_source END,
                closed_at = CASE WHEN $2 = 'failed' THEN now() ELSE closed_at END,
                token_expires_at = CASE WHEN $2 = 'failed' THEN LEAST(token_expires_at, now()) ELSE token_expires_at END,
                updated_at = now()
          WHERE id = $1 AND status = 'processing' AND closed_at IS NULL
          RETURNING id`,
        [
          opts.request.id,
          opts.status,
          opts.reply.type,
          opts.reply.text,
          opts.reply.latitude,
          opts.reply.longitude,
          opts.classifier ? JSON.stringify(opts.classifier) : null,
          opts.confidence ?? null,
          opts.outcome,
          opts.error ?? null,
        ],
      );
      if (updated.rowCount !== 1) return;
      if (opts.status === "failed") {
        await client.query(
          `UPDATE address_collection_actions
              SET status = 'cancelled', processing_started_at = NULL,
                  error_message = COALESCE(error_message, $2), updated_at = now()
            WHERE request_id = $1 AND status IN ('pending','processing','blocked')`,
          [opts.request.id, opts.error ?? opts.outcome],
        );
        await client.query(
          `INSERT INTO address_collection_events
             (request_id, event_type, previous_state, new_state, actor, channel, provider_ref, metadata)
           VALUES ($1,'request_closed','processing','expired','system','whatsapp',$2,$3)`,
          [
            opts.request.id,
            opts.reply.providerMessageId,
            JSON.stringify({
              outcome: "failed",
              reason: opts.error ?? opts.outcome,
              source: "incoming_reply",
            }),
          ],
        );
      }
      await client.query(
        `UPDATE address_collection_inbound_messages
            SET classifier_result = $2, confidence = $3, outcome = $4,
                error_message = $5, processed_at = now(),
                 processing_started_at = NULL, next_attempt_at = NULL,
                 claim_token = NULL
          WHERE provider_message_id = $1 AND claim_token = $6
            AND processed_at IS NULL`,
        [
          opts.reply.providerMessageId,
          opts.classifier ? JSON.stringify(opts.classifier) : null,
          opts.confidence ?? null,
          opts.outcome,
          opts.error ?? null,
          opts.request.inbound_claim_token,
        ],
      );
      await client.query(
        `INSERT INTO address_collection_events
           (request_id, event_type, previous_state, new_state, actor, channel, provider_ref, metadata)
         VALUES ($1,'reply_processed','processing',$2,'system','whatsapp',$3,$4)`,
        [
          opts.request.id,
          opts.status,
          opts.reply.providerMessageId,
          JSON.stringify({
            reply_type: opts.reply.type,
            classifier: opts.classifier ?? null,
            confidence: opts.confidence ?? null,
            outcome: opts.outcome,
            error: opts.error ?? null,
          }),
        ],
      );
    });
  } finally {
    client.release();
  }
}

async function resolveOrder(opts: {
  request: ClaimedRequest;
  reply: IncomingReply;
  deliveryAddress: Record<string, unknown>;
  classifier?: unknown;
  confidence?: number | null;
}): Promise<"resolved" | "address_already_present" | "not_resolved"> {
  const client = await db.connect();
  try {
    return await withTransaction(client, async () => {
      if (!opts.request.order_id) return "not_resolved";
      const lease = await client.query(
        `SELECT 1 FROM address_collection_inbound_messages
          WHERE provider_message_id = $1 AND claim_token = $2
            AND processed_at IS NULL
          FOR UPDATE`,
        [opts.reply.providerMessageId, opts.request.inbound_claim_token],
      );
      if (lease.rowCount !== 1) return "not_resolved";
      const order = await client.query<{
        delivery_address: Record<string, unknown> | null;
        tookan_job_id: string | null;
      }>(
        `SELECT delivery_address, tookan_job_id
           FROM orders
          WHERE id = $1 AND workspace_owner_id = $2
          FOR UPDATE`,
        [opts.request.order_id, opts.request.workspace_owner_id],
      );
      if (!order.rows[0]) throw new Error("matching order no longer exists");
      if (!isDeliveryAddressMissing(order.rows[0].delivery_address)) {
        return "address_already_present";
      }
      const previousAddress = object(order.rows[0].delivery_address);
      const storedAddress = replaceCanonicalAddress(previousAddress, opts.deliveryAddress);
      const latitude = numberValue(opts.deliveryAddress.latitude);
      const longitude = numberValue(opts.deliveryAddress.longitude);
      const requestUpdated = await client.query(
        `UPDATE address_collection_requests
            SET status = 'resolved', submitted_address = $2, submitted_lat = $3,
                submitted_lng = $4, address_received_at = now(), resolved_at = now(),
                resolution_outcome = 'automatic_collection',
                closure_reason = 'Address resolved from recipient reply',
                closure_source = 'incoming_reply',
                closed_at = now(),
                token_expires_at = LEAST(token_expires_at, now()),
                inbound_reply_type = $5, inbound_reply_text = $6, inbound_lat = $3,
                inbound_lng = $4, inbound_classifier = $7, inbound_confidence = $8,
                inbound_outcome = 'resolved', inbound_error = NULL, updated_at = now()
          WHERE id = $1 AND status = 'processing' AND closed_at IS NULL
          RETURNING id`,
        [
          opts.request.id,
          JSON.stringify(storedAddress),
          latitude,
          longitude,
          opts.reply.type,
          opts.reply.text,
          JSON.stringify(opts.classifier),
          opts.confidence,
        ],
      );
      if (requestUpdated.rowCount !== 1) return "not_resolved";

      const orderUpdated = await client.query(
        `UPDATE orders
            SET delivery_address = $3::jsonb,
                updated_at = now()
          WHERE id = $1 AND workspace_owner_id = $2
          RETURNING id`,
        [
          opts.request.order_id,
          opts.request.workspace_owner_id,
          JSON.stringify(storedAddress),
        ],
      );
      if (orderUpdated.rowCount !== 1) {
        throw new Error("matching order no longer exists");
      }
      await client.query(
        `UPDATE address_collection_actions
            SET status = 'cancelled', updated_at = now()
          WHERE request_id = $1 AND status IN ('pending','processing')
            AND action_type <> 'tookan_destination_update'`,
        [opts.request.id],
      );
      if (order.rows[0].tookan_job_id) {
        await client.query(
          `INSERT INTO address_collection_actions
             (request_id, action_type, channel, scheduled_at, status,
              idempotency_key, triggering_rule)
           VALUES ($1, 'tookan_destination_update', 'tookan', now(), 'pending', $2,
                   'address resolved from respond.io recipient reply')
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [
            opts.request.id,
            `address-reply:${opts.reply.providerMessageId}:tookan-destination`,
          ],
        );
      }
      await client.query(
        `UPDATE address_collection_inbound_messages
            SET classifier_result = $2, confidence = $3, outcome = 'resolved',
                processed_at = now(), processing_started_at = NULL,
                 next_attempt_at = NULL, claim_token = NULL
          WHERE provider_message_id = $1 AND claim_token = $4
            AND processed_at IS NULL`,
        [
          opts.reply.providerMessageId,
          JSON.stringify(opts.classifier),
          opts.confidence,
          opts.request.inbound_claim_token,
        ],
      );
      await client.query(
        `INSERT INTO address_collection_events
           (request_id, event_type, previous_state, new_state, actor, channel, provider_ref, metadata)
         VALUES ($1,'reply_resolved','processing','resolved','system','whatsapp',$2,$3)`,
        [
          opts.request.id,
          opts.reply.providerMessageId,
          JSON.stringify({
            reply_type: opts.reply.type,
            reply_text: opts.reply.type === "text" ? opts.reply.text : null,
            source: "respondio_recipient_reply",
            previous_address: previousAddress,
            new_address: storedAddress,
            coordinates: { latitude, longitude },
            recipient_phone: opts.request.recipient_phone,
            classifier: opts.classifier,
            confidence: opts.confidence,
            outcome: "resolved",
          }),
        ],
      );
      await client.query(
        `INSERT INTO address_collection_events
           (request_id, event_type, previous_state, new_state, actor, channel, provider_ref, metadata)
         VALUES ($1,'request_closed','processing','resolved','system','whatsapp',$2,$3)`,
        [
          opts.request.id,
          opts.reply.providerMessageId,
          JSON.stringify({
            outcome: "automatic_collection",
            reason: "Address resolved from recipient reply",
            source: "incoming_reply",
          }),
        ],
      );
      await client.query(
        `INSERT INTO order_events
           (workspace_owner_id, order_id, event_type, payload, actor_name)
         VALUES ($1, $2, 'delivery_address_updated', $3::jsonb, 'Respond.io Address Collector')`,
        [
          opts.request.workspace_owner_id,
          opts.request.order_id,
          JSON.stringify({
            source: "respondio_address_collection",
            provider_message_id: opts.reply.providerMessageId,
            previous_address: previousAddress,
            new_address: storedAddress,
            coordinates: { latitude, longitude },
            recipient_phone: opts.request.recipient_phone,
            timestamp: new Date().toISOString(),
          }),
        ],
      );
      return "resolved";
    });
  } finally {
    client.release();
  }
}

/**
 * Recipient replies are deliberately stored as received. This is not the
 * customer-initiated order-edit flow: no address eligibility, AI, geocoding,
 * confidence, ambiguity, or locality decision is made here.
 */
function directRecipientAddress(reply: IncomingReply): Record<string, unknown> {
  if (reply.type === "text") {
    return {
      address: reply.text ?? "",
      source: "respondio_recipient_reply",
      reply_type: "text",
    };
  }
  return {
    ...(reply.text !== null ? { address: reply.text } : {}),
    source: "respondio_recipient_reply",
    reply_type: "location",
    location: {
      latitude: reply.latitude,
      longitude: reply.longitude,
      ...(reply.text !== null ? { label: reply.text } : {}),
    },
    latitude: reply.latitude,
    longitude: reply.longitude,
  };
}

export async function processIncomingReply(reply: IncomingReply): Promise<void> {
  const request = await claimRequest(reply);
  if (!request) return;
  try {
    const resolution = await resolveOrder({
      request,
      reply,
      deliveryAddress: directRecipientAddress(reply),
      classifier: null,
      confidence: null,
    });
    if (resolution === "address_already_present") {
      await finishWithoutOrderUpdate({
        request,
        reply,
        status: "needs_review",
        outcome: "address_already_present",
        confidence: null,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ error, requestId: request.id }, "addressCollector: inbound reply processing failed");
    await retryIncomingReply(request, reply, message);
  }
}

/** Restart-safe worker entry point for webhook rows acknowledged before a crash. */
export async function processPendingIncomingReplies(limit = 10): Promise<number> {
  const pending = await db.query<{
    provider_message_id: string;
    channel_id: string | null;
    contact_id: string | null;
    reply_to_provider_ref: string | null;
    normalized_phone: string;
    reply_type: "text" | "location";
    reply_text: string | null;
    latitude: number | null;
    longitude: number | null;
  }>(
    `SELECT provider_message_id, channel_id, contact_id, reply_to_provider_ref,
            normalized_phone, reply_type,
            reply_text, latitude, longitude
       FROM address_collection_inbound_messages
      WHERE processed_at IS NULL
        AND (
          processing_started_at IS NULL
          OR processing_started_at < now() - interval '10 minutes'
        )
        AND (next_attempt_at IS NULL OR next_attempt_at <= now())
      ORDER BY received_at
      LIMIT $1`,
    [limit],
  );
  for (const row of pending.rows) {
    await processIncomingReply({
      providerMessageId: row.provider_message_id,
      channelId: row.channel_id,
      contactId: row.contact_id,
      inReplyToProviderMessageId: row.reply_to_provider_ref,
      rawPhone: row.normalized_phone,
      type: row.reply_type,
      text: row.reply_text,
      latitude: row.latitude,
      longitude: row.longitude,
    });
  }
  return pending.rows.length;
}

export const __test = {
  validateReverseGeography,
  selectUniqueCandidate,
  directRecipientAddress,
  canonicalAddress,
  replaceCanonicalAddress,
};