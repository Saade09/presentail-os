import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { db, withTransaction } from "../lib/db";
import { logger } from "../lib/logger";
import {
  getAddressEligibility,
  linkOrderToAddressBook,
} from "../lib/addressBookAutoLink";
import { assessPlaceValidity, geocodeAddress } from "../lib/placeAiAssessor.js";
import {
  isStrictE164,
  normalizePhoneForCountry,
} from "../lib/respondio";
import { queueGenderInference } from "../lib/genderInference";
import { syncContactToRespondIo } from "../lib/contactUpsert";
import { buildPhoneSearchTokens } from "../lib/contactSearchNormalize";
import { cancelAddressCollectionForOrder } from "../lib/addressCollector/service";
import { isDeliveryAddressMissing } from "../lib/addressCollector/eligibility";
import { lockOrderDestinationInTransaction } from "../lib/orderDestinationLock";
import {
  addOneDay,
  isValidCalendarDate,
  processPendingOrderRescheduleJobs,
  resolveRescheduleContext,
  zonedDateTimeToIso,
  type RescheduleOrderRow,
  type RescheduleQueryable,
} from "./orders";

const router = Router();

type AiRequest = Request & {
  respondioWorkspaceOwnerId?: string;
  respondioWorkflowRequestId?: string;
  respondioWorkflowChannelId?: string;
  respondioWorkflowPayloadFingerprint?: string;
};

const findOrderValueSchema = z.union([
  z.string().trim().max(200),
  z.number().int().safe().nonnegative(),
]);

const findSchema = z.object({
  orderNumber: findOrderValueSchema.optional(),
  phone: z.string().max(100).optional(),
  order_number: findOrderValueSchema.optional(),
  order_id: findOrderValueSchema.optional(),
  order_identifier: findOrderValueSchema.optional(),
  phone_number: z.string().max(100).optional(),
  customer_phone: z.string().max(100).optional(),
  contact_phone: z.string().max(100).optional(),
  contactPhone: z.string().max(100).optional(),
  phoneNumber: z.string().max(100).optional(),
}).strict();

type FindRequest = z.infer<typeof findSchema>;

type FindInputs = {
  orderIdentifier: string | null;
  phone: string | null;
  phoneTokens: string[];
};

const addressSchema = z.union([
  z.string().trim().min(5).max(1000),
  z.object({
    address: z.string().trim().min(5).max(1000),
    district: z.string().trim().max(300).optional(),
    area: z.string().trim().max(300).optional(),
    city: z.string().trim().max(300).optional(),
    cityName: z.string().trim().max(300).optional(),
    cityId: z.union([z.string(), z.number()]).optional(),
    country: z.string().trim().max(100).optional(),
    countryCode: z.string().trim().max(3).optional(),
    instructions: z.string().trim().max(1000).optional(),
  }).strict(),
]);

function optionalRespondIoValue(schema: z.ZodString): z.ZodEffects<z.ZodOptional<z.ZodString>, string | undefined, unknown> {
  return z.preprocess((value) => {
    if (typeof value !== "string") return value;
    const trimmed = value.trim();
    if (
      !trimmed
      || /^(?:null|undefined)$/i.test(trimmed)
      || /^\{\{[^{}]+\}\}$/.test(trimmed)
      || /^\$[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+$/.test(trimmed)
    ) {
      return undefined;
    }
    return trimmed;
  }, schema.optional());
}

const changesSchema = z.object({
  card_message: z.string().trim().max(2000).nullable().optional(),
  delivery_date: z.string().refine(isValidCalendarDate, "A valid delivery date is required").optional(),
  delivery_slot: z.object({
    start_time: z.string().regex(/^\d{2}:\d{2}$/),
    end_time: z.string().regex(/^\d{2}:\d{2}$/),
  }).strict().optional(),
  delivery_address: addressSchema.optional(),
  recipient_phone: z.string().trim().min(1).max(100).optional(),
  recipient_name: z.string().trim().min(1).max(300).optional(),
}).strict();

const mutationPhoneSchema = z.object({
  customer_phone: z.string().min(1).max(100).optional(),
  contact_phone: z.string().min(1).max(100).optional(),
  contactPhone: z.string().min(1).max(100).optional(),
  phone: z.string().min(1).max(100).optional(),
  phone_number: z.string().min(1).max(100).optional(),
  phoneNumber: z.string().min(1).max(100).optional(),
});

const changesUpdateSchema = mutationPhoneSchema.extend({
  changes: changesSchema.refine((value) => Object.keys(value).length > 0, "At least one change is required"),
}).strict();

const singleChangeUpdateSchema = mutationPhoneSchema.extend({
  change_type: z.enum([
    "card_message",
    "card_to",
    "card_from",
    "delivery_date",
    "delivery_time",
    "delivery_slot",
    "delivery_address",
    "recipient_phone",
    "recipient_name",
  ]),
  new_value: z.unknown(),
}).strict();

const updateSchema = z.union([changesUpdateSchema, singleChangeUpdateSchema]);
type EffectiveChanges = z.infer<typeof changesSchema> & {
  card_to?: string | null;
  card_from?: string | null;
};
const addressCollectionFallbackSchema = z.object({
  contact_phone: optionalRespondIoValue(z.string().min(1).max(100)),
  // Respond.io does not consistently project native WhatsApp location fields
  // into this action payload. Strong native-message correlation is evaluated
  // before this value is validated as a text-address correction.
  address: z.unknown().optional(),
  message_id: optionalRespondIoValue(z.string().min(1).max(300)),
  reply_to_provider_ref: optionalRespondIoValue(z.string().min(1).max(300)),
  address_collection_ref: optionalRespondIoValue(z.string().uuid()),
  contact_id: optionalRespondIoValue(z.string().min(1).max(300)),
}).strict();
const workflowAddressCorrectionSchema = z.object({
  order_id: findOrderValueSchema,
  delivery_address: addressSchema,
  channel_id: z.string().trim().min(1).max(300),
  request_id: z.string().trim().min(1).max(300).refine(
    (value) =>
      !/^(?:null|undefined)$/i.test(value)
      && !/^\{\{[^{}]+\}\}$/.test(value)
      && !/^\$[A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)+$/.test(value),
    "request_id must be a resolved Respond.io delivery identifier",
  ),
}).strict();
type SingleChangeType = z.infer<typeof singleChangeUpdateSchema>["change_type"];
type OrderRow = RescheduleOrderRow & {
  display_order_number: string | null;
  external_order_number: string | null;
  ordered_at: string | null;
  created_at: string;
  card_message: string | null;
  card_from: string | null;
  card_to: string | null;
  delivery_instructions: string | null;
  tookan_status: string | null;
  tookan_error: string | null;
  customer_phone: string;
  recipient_contact_id: string | null;
  recipient_name: string | null;
  recipient_phone: string | null;
};

type AddressCollectionFallbackRow = OrderRow & {
  request_id: string;
  request_status: string;
  request_created_at: string;
  request_closed_at: string | null;
  request_token_expires_at: string;
  request_recipient_phone: string;
  request_respondio_contact_id: string | null;
  request_respondio_channel_id: string | null;
};

type NativeFallbackRow = {
  provider_message_id: string;
  request_id: string;
  order_id: string;
  reply_type: string;
  reply_text: string | null;
  received_at: string;
  processed_at: string | null;
  processing_started_at: string | null;
  claim_token: string | null;
  claim_active: boolean;
  outcome: string | null;
  request_status: string;
  request_closed_at: string | null;
  closure_source: string | null;
  resolution_outcome: string | null;
  inbound_outcome: string | null;
  submitted_address: Record<string, unknown> | null;
  display_order_number: string | null;
  external_order_number: string | null;
  external_order_id: string | null;
  delivery_address: Record<string, unknown>;
};

const NATIVE_FALLBACK_WINDOW_MINUTES = 10;

const FALLBACK_RECOVERABLE_REQUEST_STATUSES = [
  "awaiting_address",
  "scheduled",
  "whatsapp_queued",
  "whatsapp_sent",
  "whatsapp_delivered",
  "whatsapp_failed",
  "sms_fallback_sent",
  "link_opened",
  "in_progress",
  "escalated",
  "needs_review",
] as const;

function isFallbackRecoverableRequest(row: AddressCollectionFallbackRow): boolean {
  return row.request_closed_at == null
    && (FALLBACK_RECOVERABLE_REQUEST_STATUSES as readonly string[]).includes(row.request_status);
}

type PublicOrderIdentifiers = {
  orderId: string;
  orderNumber: string;
};

type PreparedAddress = {
  value: Record<string, unknown>;
  text: string;
  latitude: number;
  longitude: number;
};

type ApiError = Error & {
  status?: number;
  code?: string;
  details?: Record<string, unknown>;
};

function apiError(
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): ApiError {
  return Object.assign(new Error(message), { status, code, details });
}

function sendError(res: Response, error: unknown): void {
  const known = error as ApiError;
  res.status(known.status ?? 500).json({
    success: false,
    saved: false,
    processing: false,
    status: known.code === "ADDRESS_REQUIRES_CLARIFICATION"
      ? "clarification"
      : "rejected",
    code: known.code ?? "TEMPORARILY_UNAVAILABLE",
    error: known.status ? known.message : "The request could not be completed",
    ...(known.details ?? {}),
  });
}

function secureEqual(left: string, right: string): boolean {
  const a = createHash("sha256").update(left).digest();
  const b = createHash("sha256").update(right).digest();
  return timingSafeEqual(a, b);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  if (typeof value === "string") {
    return JSON.stringify(
      value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("en"),
    );
  }
  return JSON.stringify(value);
}

function fallbackAddressFingerprint(address: z.infer<typeof addressSchema>): string {
  return createHash("sha256")
    .update(canonicalJson(addressInputRecord(address)))
    .digest("hex");
}

function canonicalAddressText(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? canonicalJson(value)
    : null;
}

function matchesNativeResolvedAddress(
  row: NativeFallbackRow,
  address: z.infer<typeof addressSchema>,
): boolean {
  const input = addressInputRecord(address);
  const submitted = row.submitted_address ?? {};
  const inputText = canonicalAddressText(input.address);
  if (!inputText) return false;

  const replyMatches = canonicalAddressText(row.reply_text) === inputText;
  const submittedTextMatches =
    canonicalAddressText(submitted.address) === inputText;
  if (!replyMatches && !submittedTextMatches) return false;

  if (typeof address === "string") return true;
  return Object.entries(input).every(([key, value]) =>
    canonicalJson(submitted[key]) === canonicalJson(value));
}

function matchesNativePersistedAddress(
  row: NativeFallbackRow,
  address: z.infer<typeof addressSchema>,
): boolean {
  if (!row.submitted_address) return false;
  const input = addressInputRecord(address);
  return Object.entries(input).every(([key, value]) =>
    canonicalJson(row.submitted_address?.[key]) === canonicalJson(value));
}

function nativeFallbackResolved(row: NativeFallbackRow): boolean {
  return row.outcome === "resolved"
    && row.processed_at !== null
    && row.request_status === "resolved"
    && row.request_closed_at !== null
    && row.closure_source === "incoming_reply"
    && row.resolution_outcome === "automatic_collection"
    && row.inbound_outcome === "resolved"
    && row.submitted_address !== null
    && canonicalJson(row.submitted_address) === canonicalJson(row.delivery_address);
}

function validCoordinates(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const nested = record.location && typeof record.location === "object"
    && !Array.isArray(record.location)
    ? record.location as Record<string, unknown>
    : null;
  const latitude = Number(record.latitude ?? record.lat ?? nested?.latitude ?? nested?.lat);
  const longitude = Number(
    record.longitude ?? record.lng ?? record.lon
      ?? nested?.longitude ?? nested?.lng ?? nested?.lon,
  );
  return Number.isFinite(latitude)
    && Number.isFinite(longitude)
    && latitude >= -90
    && latitude <= 90
    && longitude >= -180
    && longitude <= 180
    && (latitude !== 0 || longitude !== 0);
}

function authoritativeNativeLocationResolved(row: NativeFallbackRow): boolean {
  return row.reply_type === "location"
    && nativeFallbackResolved(row)
    && validCoordinates(row.submitted_address)
    && validCoordinates(row.delivery_address);
}

function nativeFallbackProcessing(row: NativeFallbackRow): boolean {
  return row.request_status === "processing"
    && row.processed_at === null
    && row.claim_active;
}

async function findMatchingRecentNativeFallbacks(opts: {
  workspaceOwnerId: string;
  channelId: string;
  contactPhone: string;
  contactId: string | null;
  requestRef: string | null;
  replyToProviderRef: string | null;
  address: z.infer<typeof addressSchema>;
  providerMessageId?: string;
}): Promise<NativeFallbackRow[]> {
  const result = await db.query<NativeFallbackRow>(
    `SELECT m.provider_message_id, m.reply_type, m.reply_text,
            m.received_at, m.processed_at, m.processing_started_at,
            m.claim_token,
            (
              m.processed_at IS NULL
              AND m.processing_started_at >= now() - interval '10 minutes'
            ) AS claim_active,
            m.outcome,
            r.id AS request_id, r.order_id, r.status AS request_status,
            r.closed_at AS request_closed_at, r.closure_source,
            r.resolution_outcome, r.inbound_outcome, r.submitted_address,
            o.display_order_number, o.external_order_number, o.external_order_id,
            o.delivery_address
       FROM address_collection_inbound_messages m
       JOIN address_collection_requests r
         ON r.id = m.request_id
        AND r.workspace_owner_id = m.workspace_owner_id
       JOIN orders o
         ON o.id = r.order_id
        AND o.workspace_owner_id = r.workspace_owner_id
      WHERE m.workspace_owner_id = $1
        AND m.channel_id = $2
        AND (
          (
            m.processed_at IS NULL
            AND (
              m.received_at >= now() - ($3::int * interval '1 minute')
              OR r.status = 'processing'
            )
          )
          OR (
            m.processed_at >= now() - ($3::int * interval '1 minute')
            AND r.status IN ('resolved', 'needs_review')
          )
        )
        AND m.provider_message_id NOT LIKE 'support-fallback:v1:%'
        AND ($4::text IS NULL OR m.provider_message_id = $4)
         AND m.normalized_phone = $7
         AND ($8::text IS NULL OR m.contact_id = $8)
        AND (
          r.respondio_channel_id = $2
          OR (r.respondio_channel_id IS NULL AND m.channel_id = $2)
        )
        AND ($5::uuid IS NULL OR r.id = $5::uuid)
        AND (
          $6::text IS NULL
          OR r.whatsapp_template_provider_ref = $6
          OR m.reply_to_provider_ref = $6
          OR EXISTS (
            SELECT 1
              FROM address_collection_actions exact_action
             WHERE exact_action.request_id = r.id
               AND exact_action.provider_ref = $6
          )
        )
      ORDER BY m.received_at DESC`,
    [
      opts.workspaceOwnerId,
      opts.channelId,
      NATIVE_FALLBACK_WINDOW_MINUTES,
      opts.providerMessageId ?? null,
      opts.requestRef,
      opts.replyToProviderRef,
      opts.contactPhone,
      opts.contactId,
    ],
  );
  return result.rows.filter((row) => matchesNativeResolvedAddress(row, opts.address));
}

async function recoverExpiredNativeFallback(
  row: NativeFallbackRow,
  workspaceOwnerId: string,
  channelId: string,
): Promise<"processing" | "resolved" | "recoverable"> {
  const client = await db.connect();
  try {
    return await withTransaction(client, async () => {
      const current = await client.query<{
        processed_at: string | null;
        processing_started_at: string | null;
        outcome: string | null;
        request_status: string;
        request_closed_at: string | null;
      }>(
        `SELECT m.processed_at, m.processing_started_at, m.outcome,
                r.status AS request_status, r.closed_at AS request_closed_at
           FROM address_collection_inbound_messages m
           JOIN address_collection_requests r
             ON r.id = m.request_id
            AND r.workspace_owner_id = m.workspace_owner_id
           JOIN orders o
             ON o.id = r.order_id
            AND o.workspace_owner_id = r.workspace_owner_id
          WHERE m.provider_message_id = $1
            AND m.workspace_owner_id = $2
            AND m.channel_id = $3
            AND r.id = $4
            AND o.id = $5
          FOR UPDATE OF m, r`,
        [
          row.provider_message_id,
          workspaceOwnerId,
          channelId,
          row.request_id,
          row.order_id,
        ],
      );
      const locked = current.rows[0];
      if (!locked) {
        throw apiError(
          409,
          "ADDRESS_COLLECTION_REQUEST_CHANGED",
          "The correlated Address Collector reply changed before recovery",
        );
      }
      if (
        locked.outcome === "resolved"
        && locked.processed_at !== null
        && locked.request_status === "resolved"
        && locked.request_closed_at !== null
      ) return "resolved";
      if (locked.processed_at !== null || locked.request_status === "needs_review") {
        return "recoverable";
      }
      const leaseStarted = locked.processing_started_at
        ? new Date(locked.processing_started_at).getTime()
        : 0;
      if (leaseStarted > Date.now() - NATIVE_FALLBACK_WINDOW_MINUTES * 60_000) {
        return "processing";
      }

      const released = await client.query(
        `UPDATE address_collection_inbound_messages
            SET outcome = 'superseded_by_support_fallback',
                error_message = 'Expired native processing lease recovered by authenticated support fallback',
                processed_at = now(), processing_started_at = NULL,
                next_attempt_at = NULL, claim_token = NULL
          WHERE provider_message_id = $1
            AND processed_at IS NULL
          RETURNING id`,
        [row.provider_message_id],
      );
      if (released.rowCount !== 1) return "recoverable";
      const requestReleased = await client.query(
        `UPDATE address_collection_requests
            SET status = 'needs_review', processing_started_at = NULL,
                inbound_outcome = 'support_fallback_recovery',
                inbound_error = NULL, updated_at = now()
          WHERE id = $1 AND workspace_owner_id = $2
            AND status = 'processing' AND closed_at IS NULL
          RETURNING id`,
        [row.request_id, workspaceOwnerId],
      );
      if (requestReleased.rowCount !== 1) {
        throw apiError(
          409,
          "ADDRESS_COLLECTION_REQUEST_CHANGED",
          "The Address Collector request changed before recovery",
        );
      }
      await client.query(
        `INSERT INTO address_collection_events
           (request_id, event_type, previous_state, new_state, actor, channel, provider_ref, metadata)
         VALUES ($1, 'reply_recovery_handoff', 'processing', 'needs_review',
                 'respondio_support', 'whatsapp', $2, $3::jsonb)`,
        [
          row.request_id,
          row.provider_message_id,
          JSON.stringify({
            source: "respondio_support_fallback",
            reason: "expired_native_processing_lease",
          }),
        ],
      );
      return "recoverable";
    });
  } finally {
    client.release();
  }
}

function selectMatchingNativeFallback(
  rows: NativeFallbackRow[],
): NativeFallbackRow | null {
  if (rows.length > 1) {
    throw apiError(
      409,
      "AMBIGUOUS_ADDRESS_COLLECTION_REQUEST",
      "More than one recent native Address Collector reply matches this recipient and address",
    );
  }
  return rows[0] ?? null;
}

function syntheticFallbackMessageId(input: {
  workspaceOwnerId: string;
  channelId: string;
  contactPhone: string;
  requestId: string;
  orderId: string;
  addressFingerprint: string;
}): string {
  const digest = createHash("sha256")
    .update([
      "respondio-support-fallback-v1",
      input.workspaceOwnerId,
      input.channelId,
      input.contactPhone,
      input.requestId,
      input.orderId,
      input.addressFingerprint,
    ].join("\0"))
    .digest("hex");
  return `support-fallback:v1:${digest}`;
}

async function requireRespondioAi(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const configured = process.env.RESPONDIO_AI_AGENT_SECRET?.trim();
  if (!configured) {
    res.status(503).json({
      success: false,
      code: "SERVICE_NOT_CONFIGURED",
      error: "Respond.io AI order access is unavailable",
    });
    return;
  }
  const authorization = req.get("authorization") ?? "";
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  if (!match || !secureEqual(match[1], configured)) {
    res.status(401).json({
      success: false,
      code: "UNAUTHORIZED",
      error: "Valid bearer authentication is required",
    });
    return;
  }

  try {
    (req as AiRequest).respondioWorkspaceOwnerId =
      await resolveRespondioWorkspace((req.get("x-respondio-channel-id") ?? "").trim());
    next();
  } catch (error) {
    logger.error({ error }, "respondio AI: workspace mapping failed");
    res.status(503).json({
      success: false,
      code: "WORKSPACE_MAPPING_UNAVAILABLE",
      error: "Respond.io workspace mapping is unavailable",
    });
  }
}

async function resolveRespondioWorkspace(channelId: string): Promise<string> {
  const mappings = await db.query<{ workspace_owner_id: string }>(
      `SELECT DISTINCT workspace_owner_id
         FROM omni_channel_accounts
        WHERE provider = 'respondio'
          AND is_active = true
          AND ($1 = '' OR external_account_id = $1)
        ORDER BY workspace_owner_id
        LIMIT 2`,
      [channelId],
    );
  if (mappings.rows.length !== 1) {
    throw apiError(
      503,
      "WORKSPACE_MAPPING_UNAVAILABLE",
      "Respond.io workspace mapping is unavailable",
    );
  }
  return mappings.rows[0].workspace_owner_id;
}

function verifyRespondioWorkflowSignature(req: Request): boolean {
  const secret = process.env.RESPONDIO_INCOMING_WEBHOOK_SECRET?.trim();
  const signature = (req.get("x-webhook-signature") ?? "").trim();
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!secret || !signature || !rawBody?.length) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest("base64");
  return secureEqual(signature, expected);
}

function normalizedCustomerPhone(raw: string): string {
  const phone = normalizePhoneForCountry(raw);
  if (!phone || !isStrictE164(phone)) {
    throw apiError(
      400,
      "INVALID_CUSTOMER_PHONE",
      "customer_phone must be a valid international phone number",
    );
  }
  return phone;
}

function normalizedFallbackContactPhone(raw: string): string {
  const trimmed = raw.trim();
  let phone = normalizePhoneForCountry(trimmed);
  if (!phone) {
    const harmlessFormattingOnly = /^[0-9\s().-]+$/.test(trimmed);
    const compact = harmlessFormattingOnly ? trimmed.replace(/[\s().-]/g, "") : "";
    const explicitInternationalDigits = compact.startsWith("00")
      ? compact.slice(2)
      : compact;
    if (
      explicitInternationalDigits.length >= 10
      && explicitInternationalDigits.length <= 15
      && /^[1-9]\d+$/.test(explicitInternationalDigits)
    ) {
      phone = normalizePhoneForCountry(`+${explicitInternationalDigits}`);
    }
  }
  if (!phone || !isStrictE164(phone)) {
    throw apiError(
      400,
      "INVALID_CONTACT_PHONE",
      "contact_phone must be a valid international phone number",
    );
  }
  return phone;
}

function phoneDigits(phone: string): string {
  return phone.replace(/\D/g, "");
}

function normalizeFindOrderIdentifier(value: string | number): string | null {
  const raw = String(value).trim();
  if (!raw || UUID_PATTERN.test(raw)) return null;
  const decorated = raw
    .replace(/^order\s*(?:number|no\.?|#)?\s*/i, "")
    .replace(/^#\s*/, "")
    .trim();
  if (!decorated || !/^(?:[A-Za-z0-9]+[-_])*[0-9]+$/.test(decorated)) return null;
  return decorated;
}

function samePublicOrderReference(left: string, right: string): boolean {
  if (left.toLowerCase() === right.toLowerCase()) return true;
  const leftNumeric = /^\d+$/.test(left);
  const rightNumeric = /^\d+$/.test(right);
  if (leftNumeric === rightNumeric) return false;
  const leftId = publicOrderId(left);
  const rightId = publicOrderId(right);
  return leftId !== null && leftId === rightId;
}

function identifierFingerprint(value: string | null): string | null {
  return value
    ? createHash("sha256").update(value).digest("hex").slice(0, 12)
    : null;
}

function maskedPhone(value: string | null): string | null {
  if (!value) return null;
  const digits = phoneDigits(value);
  return digits.length >= 4 ? `***${digits.slice(-4)}` : "***";
}

function normalizeFindPhone(value: string): { phone: string; tokens: string[] } | null {
  const raw = value.trim();
  if (!raw) return null;
  const digits = phoneDigits(raw);
  if (!digits) return null;
  const candidates = new Set<string>([raw]);
  // Respond.io may omit the leading plus from an otherwise complete
  // international number. Do not limit that provider variant to OS markets:
  // customers can contact an LB/AE storefront from any calling country.
  if (!raw.startsWith("+") && /^[1-9]\d{7,14}$/.test(digits)) {
    candidates.add(`+${digits}`);
  }
  const countryHints = raw.startsWith("+")
    ? [undefined]
    : /^[1-9]\d{7,14}$/.test(digits)
      ? [undefined, "AE", "LB"]
      : digits.startsWith("971")
      ? ["AE", undefined]
      : digits.startsWith("961")
        ? ["LB", undefined]
        : ["AE", "LB", undefined];
  const tokens = new Set<string>();
  let canonical: string | null = null;
  for (const candidate of candidates) {
    for (const countryHint of countryHints) {
      const parsed = normalizePhoneForCountry(candidate, countryHint);
      if (parsed) {
        canonical ??= parsed;
        buildPhoneSearchTokens(parsed, countryHint).forEach((token) => tokens.add(token));
      }
    }
  }
  buildPhoneSearchTokens(raw, "AE").forEach((token) => tokens.add(token));
  buildPhoneSearchTokens(raw, "LB").forEach((token) => tokens.add(token));
  if (!canonical || tokens.size === 0) return null;
  return { phone: canonical, tokens: [...tokens] };
}

function resolveFindInputs(value: FindRequest): FindInputs {
  const orderValues = [
    value.orderNumber,
    value.order_number,
    value.order_id,
    value.order_identifier,
  ].filter((candidate): candidate is string | number => candidate !== undefined);
  const orderIdentifiers = orderValues.map(normalizeFindOrderIdentifier);
  if (orderIdentifiers.some((identifier) => identifier === null)) {
    throw apiError(400, "INVALID_REQUEST", "The order number is unusable");
  }
  const normalizedOrders = orderIdentifiers.filter((candidate): candidate is string => candidate !== null);
  if (normalizedOrders.some((candidate) => !samePublicOrderReference(candidate, normalizedOrders[0]))) {
    throw apiError(400, "CONFLICTING_IDENTIFIERS", "Order number fields must refer to the same order");
  }

  const phoneValues = [
    value.phone,
    value.phone_number,
    value.customer_phone,
    value.contact_phone,
    value.contactPhone,
    value.phoneNumber,
  ].filter((candidate): candidate is string => candidate !== undefined && candidate.trim() !== "");
  const phones = phoneValues.map(normalizeFindPhone);
  if (phones.some((phone) => phone === null)) {
    throw apiError(400, "INVALID_REQUEST", "The phone number is unusable");
  }
  const normalizedPhones = phones.filter((phone): phone is NonNullable<typeof phone> => phone !== null);
  const distinctPhones = new Set(normalizedPhones.map((phone) => phone.phone));
  if (distinctPhones.size > 1) {
    throw apiError(400, "CONFLICTING_IDENTIFIERS", "Phone fields must refer to the same phone number");
  }

  return {
    orderIdentifier:
      normalizedOrders.find((candidate) => !/^\d+$/.test(candidate))
      ?? normalizedOrders[0]
      ?? null,
    phone: normalizedPhones[0]?.phone ?? null,
    phoneTokens: normalizedPhones[0]?.tokens ?? [],
  };
}

function mutationPhone(value: z.infer<typeof updateSchema>): string | null {
  const candidates = [
    value.customer_phone,
    value.contact_phone,
    value.contactPhone,
    value.phone,
    value.phone_number,
    value.phoneNumber,
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.trim() !== "");
  if (candidates.length === 0) {
    return null;
  }
  const normalized = candidates.map((candidate) => {
    const parsed = normalizeFindPhone(candidate);
    if (!parsed) {
      throw apiError(
        400,
        "INVALID_CUSTOMER_PHONE",
        "customer_phone must be a valid phone number",
      );
    }
    return parsed.phone;
  });
  if (new Set(normalized).size !== 1) {
    throw apiError(400, "CONFLICTING_IDENTIFIERS", "Phone fields must refer to the same phone number");
  }
  return normalized[0];
}

function normalizedSlotLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d{2}:\d{2})\s*[-–—]\s*(\d{2}:\d{2})$/);
  return match ? `${match[1]}–${match[2]}` : null;
}

function isUnchangedAddressInput(input: z.infer<typeof addressSchema>, order: OrderRow): boolean {
  // Structured input is a replacement document after prepareAddress merges and
  // canonicalizes fulfillment metadata; comparing only submitted keys would
  // incorrectly discard legitimate removals or normalization.
  if (typeof input !== "string") return false;
  const current = order.delivery_address ?? {};
  const existing = typeof current.address === "string"
    ? current.address
    : typeof current.address_1 === "string"
      ? current.address_1
      : null;
  return existing?.trim() === input.trim();
}

function normalizedStatus(status: string): string {
  return status.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

const publicOrderNumberSql = `COALESCE(
  CASE
    WHEN NULLIF(BTRIM(o.display_order_number), '') ~ '[0-9]+$'
    THEN NULLIF(BTRIM(o.display_order_number), '')
  END,
  CASE
    WHEN NULLIF(BTRIM(o.external_order_number), '') ~ '[0-9]+$'
    THEN NULLIF(BTRIM(o.external_order_number), '')
  END,
  CASE
    WHEN NULLIF(BTRIM(o.external_order_id), '') ~ '[0-9]+$'
    THEN NULLIF(BTRIM(o.external_order_id), '')
  END
)`;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function publicOrderNumber(order: OrderRow): string | null {
  for (const value of [
    order.display_order_number,
    order.external_order_number,
    order.external_order_id,
  ]) {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (normalized && publicOrderId(normalized)) return normalized;
  }
  return null;
}

function publicOrderId(orderNumber: string): string | null {
  const match = /([0-9]+)$/.exec(orderNumber);
  return match?.[1] ?? null;
}

function publicOrderIdentifiers(order: OrderRow): PublicOrderIdentifiers | null {
  const orderNumber = publicOrderNumber(order);
  if (!orderNumber) return null;
  const orderId = publicOrderId(orderNumber);
  return orderId ? { orderId, orderNumber } : null;
}

function safeAddress(value: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!value) return null;
  const keys = [
    "address", "district", "area", "city", "cityName", "cityId",
    "country", "countryCode", "latitude", "longitude", "lat", "lng",
  ];
  return Object.fromEntries(keys.filter((key) => value[key] != null).map((key) => [key, value[key]]));
}

function serializeOrder(order: OrderRow) {
  const identifiers = publicOrderIdentifiers(order);
  if (!identifiers) return null;
  const address = order.delivery_address ?? {};
  const isExpress =
    order.delivery_type?.trim().toLowerCase() === "express"
    || address.isExpress === true;
  return {
    order_id: identifiers.orderId,
    order_number: identifiers.orderNumber,
    status: order.status,
    ordered_at: order.ordered_at ?? order.created_at,
    delivery_date:
      typeof address.date === "string"
        ? address.date
        : order.window_start?.slice(0, 10) ?? null,
    delivery_slot:
      typeof address.slot === "string"
        ? address.slot
        : isExpress
          ? "Express"
          : null,
    delivery_address: safeAddress(order.delivery_address),
    delivery_instructions: order.delivery_instructions,
    recipient_name: order.recipient_name,
    recipient_phone: order.recipient_phone,
    card_message: order.card_message,
    card_from: order.card_from,
    card_to: order.card_to,
  };
}

function serializeOrderIdentification(order: OrderRow) {
  const identifiers = publicOrderIdentifiers(order);
  return identifiers
    ? {
        order_id: identifiers.orderId,
        order_number: identifiers.orderNumber,
      }
    : null;
}

function safeMutationResult(order: OrderRow, eventId: string | null) {
  const safeOrder = serializeOrder(order);
  const identifiers = publicOrderIdentifiers(order);
  if (!safeOrder || !identifiers) {
    throw apiError(
      403,
      "ORDER_ACCESS_DENIED",
      "The order could not be accessed for this customer",
    );
  }
  return { order, safeOrder, identifiers, eventId };
}

function selectOrdersSql(extraWhere = "", requireCustomerPhone = true): string {
  return `SELECT o.id, o.status, o.external_order_id, o.external_order_number,
                 o.display_order_number, o.ordered_at, o.created_at,
                 o.delivery_type, o.delivery_address, o.delivery_instructions,
                 o.window_start, o.window_end, o.card_message, o.card_from, o.card_to,
                 o.tookan_job_id, o.tookan_status, o.tookan_error,
                 customer.phone AS customer_phone,
                 recipient.id AS recipient_contact_id,
                 recipient.display_name AS recipient_name,
                 recipient.phone AS recipient_phone
            FROM orders o
            JOIN order_contacts customer_link
              ON customer_link.order_id = o.id AND customer_link.role = 'customer'
            JOIN contacts customer ON customer.id = customer_link.contact_id
       LEFT JOIN LATERAL (
                 SELECT c.id, c.display_name, c.phone
                   FROM order_contacts oc
                   JOIN contacts c ON c.id = oc.contact_id
                   WHERE oc.order_id = o.id
                     AND oc.role = 'recipient'
                     AND c.workspace_owner_id = $1
                  ORDER BY oc.id
                  LIMIT 1
               ) recipient ON true
           WHERE o.workspace_owner_id = $1
             AND customer.workspace_owner_id = $1
               ${requireCustomerPhone
                 ? `AND (
                      regexp_replace(COALESCE(customer.phone, ''), '[^0-9]', '', 'g') = ANY($2::text[])
                      OR EXISTS (
                        SELECT 1
                          FROM order_contacts phone_link
                          JOIN contacts phone_contact ON phone_contact.id = phone_link.contact_id
                         WHERE phone_link.order_id = o.id
                           AND phone_link.role = 'recipient'
                           AND phone_contact.workspace_owner_id = $1
                           AND regexp_replace(COALESCE(phone_contact.phone, ''), '[^0-9]', '', 'g') = ANY($2::text[])
                      )
                    )`
                 : ""}
             ${extraWhere}`;
}

async function getOwnedOrderById(
  queryable: RescheduleQueryable,
  workspaceOwnerId: string,
  orderId: string,
  lock = false,
): Promise<OrderRow | null> {
  const result = await queryable.query<OrderRow>(
    `${selectOrdersSql("AND o.id = $2", false)} LIMIT 1 ${lock ? "FOR UPDATE OF o" : ""}`,
    [workspaceOwnerId, orderId],
  );
  return result.rows[0] ?? null;
}

async function getOwnedOrderByIdentifier(
  queryable: RescheduleQueryable,
  workspaceOwnerId: string,
  identifier: string,
  customerPhoneTokens: string[] | null,
  includeRecentConstraint: boolean,
  lock = false,
): Promise<OrderRow | null> {
  const normalizedIdentifier = identifier.trim();
  if (UUID_PATTERN.test(normalizedIdentifier)) return null;
  const prefixFreeIdentifier = publicOrderId(normalizedIdentifier);
  const recentConstraint = includeRecentConstraint
    ? `AND (
         lower(COALESCE(o.status, '')) NOT IN ('completed', 'cancelled', 'refunded')
         OR COALESCE(o.ordered_at, o.created_at) >= now() - INTERVAL '90 days'
       )`
    : "";
  const identifierParameter = customerPhoneTokens === null ? "$2" : "$3";
  const suffixParameter = customerPhoneTokens === null ? "$3" : "$4";
  const queryParameters = customerPhoneTokens === null
    ? [workspaceOwnerId, normalizedIdentifier, prefixFreeIdentifier]
    : [workspaceOwnerId, customerPhoneTokens, normalizedIdentifier, prefixFreeIdentifier];
  const result = await queryable.query<OrderRow>(
    `${selectOrdersSql(`
       AND ${publicOrderNumberSql} IS NOT NULL
       ${recentConstraint}
       AND (
         lower(${publicOrderNumberSql}) = lower(${identifierParameter})
         OR (
           ${suffixParameter}::text IS NOT NULL
           AND substring(${publicOrderNumberSql} from '([0-9]+)$') = ${suffixParameter}
         )
       )
      `, customerPhoneTokens !== null)}
     ORDER BY
       CASE WHEN lower(${publicOrderNumberSql}) = lower(${identifierParameter}) THEN 0 ELSE 1 END,
       CASE WHEN lower(COALESCE(o.status, '')) IN ('completed', 'cancelled', 'refunded') THEN 1 ELSE 0 END,
       COALESCE(o.ordered_at, o.created_at) DESC,
       o.id DESC
     LIMIT 2 ${lock ? "FOR UPDATE OF o" : ""}`,
      queryParameters,
  );

  // An exact full reference wins over prefix-only matches. If there is no
  // exact reference, a prefix-free identifier must resolve to exactly one
  // customer-owned order; silently choosing between two prefixed numbers
  // would make a support edit unsafe.
  const exactMatches = result.rows.filter(
    (row) => publicOrderNumber(row)?.toLowerCase() === normalizedIdentifier.toLowerCase(),
  );
  if (exactMatches.length === 1) return exactMatches[0];
  if (exactMatches.length > 1) return null;

  const prefixMatches = result.rows.filter(
    (row) => prefixFreeIdentifier != null && publicOrderIdentifiers(row)?.orderId === prefixFreeIdentifier,
  );
  return prefixMatches.length === 1 ? prefixMatches[0] : null;
}

async function findAddressCollectionFallbackCandidates(
  queryable: RescheduleQueryable,
  opts: {
    workspaceOwnerId: string;
    phoneTokens: string[];
    requestRef: string | null;
    replyToProviderRef: string | null;
    contactId: string | null;
    channelId: string | null;
    lock?: boolean;
  },
): Promise<AddressCollectionFallbackRow[]> {
  const result = await queryable.query<AddressCollectionFallbackRow>(
    `SELECT r.id AS request_id, r.status AS request_status,
            r.created_at AS request_created_at,
            r.closed_at AS request_closed_at,
            r.token_expires_at AS request_token_expires_at,
            r.recipient_phone AS request_recipient_phone,
            r.respondio_contact_id AS request_respondio_contact_id,
            r.respondio_channel_id AS request_respondio_channel_id,
            o.id, o.status, o.external_order_id, o.external_order_number,
            o.display_order_number, o.ordered_at, o.created_at,
            o.delivery_type, o.delivery_address, o.delivery_instructions,
            o.window_start, o.window_end, o.card_message, o.card_from, o.card_to,
            o.tookan_job_id, o.tookan_status, o.tookan_error,
            customer.phone AS customer_phone,
            recipient.id AS recipient_contact_id,
            recipient.display_name AS recipient_name,
            recipient.phone AS recipient_phone
       FROM address_collection_requests r
       JOIN orders o
         ON o.id = r.order_id
        AND o.workspace_owner_id = r.workspace_owner_id
       JOIN order_contacts customer_link
         ON customer_link.order_id = o.id
        AND customer_link.role = 'customer'
       JOIN contacts customer
         ON customer.id = customer_link.contact_id
        AND customer.workspace_owner_id = r.workspace_owner_id
  LEFT JOIN LATERAL (
            SELECT c.id, c.display_name, c.phone
              FROM order_contacts oc
              JOIN contacts c ON c.id = oc.contact_id
             WHERE oc.order_id = o.id
               AND oc.role = 'recipient'
               AND c.workspace_owner_id = r.workspace_owner_id
             ORDER BY oc.id
             LIMIT 1
          ) recipient ON true
      WHERE r.workspace_owner_id = $1
        AND r.order_id IS NOT NULL
        AND r.closed_at IS NULL
        AND r.token_expires_at > now()
        AND r.status = ANY($2::text[])
        AND ${publicOrderNumberSql} IS NOT NULL
        AND ($3::uuid IS NULL OR r.id = $3::uuid)
        AND (
          $4::text IS NULL
          OR r.whatsapp_template_provider_ref = $4
          OR EXISTS (
            SELECT 1
              FROM address_collection_actions exact_action
             WHERE exact_action.request_id = r.id
               AND exact_action.provider_ref = $4
          )
        )
        AND (
          r.respondio_channel_id = $5
          OR (
            r.respondio_channel_id IS NULL
            AND (
              (
                $4::text IS NOT NULL
                AND (
                  r.whatsapp_template_provider_ref = $4
                  OR EXISTS (
                    SELECT 1
                      FROM address_collection_actions channel_exact_action
                     WHERE channel_exact_action.request_id = r.id
                       AND channel_exact_action.provider_ref = $4
                  )
                )
              )
              OR EXISTS (
                SELECT 1
                  FROM address_collection_inbound_messages channel_evidence
                 WHERE channel_evidence.request_id = r.id
                   AND channel_evidence.workspace_owner_id = r.workspace_owner_id
                   AND channel_evidence.channel_id = $5
              )
            )
          )
        )
      ORDER BY r.created_at DESC
      ${opts.lock ? "FOR UPDATE OF r, o" : ""}`,
    [
      opts.workspaceOwnerId,
      FALLBACK_RECOVERABLE_REQUEST_STATUSES,
      opts.requestRef,
      opts.replyToProviderRef,
      opts.channelId ?? "",
    ],
  );
  return result.rows.filter((row) => {
    if (!isDeliveryAddressMissing(row.delivery_address)) return false;
    if (
      opts.contactId !== null
      && row.request_respondio_contact_id !== opts.contactId
    ) {
      return false;
    }
    if (opts.phoneTokens.length === 0) return true;
    const candidatePhoneTokens = new Set([
      ...buildPhoneSearchTokens(row.request_recipient_phone),
      ...buildPhoneSearchTokens(row.recipient_phone),
      ...buildPhoneSearchTokens(row.customer_phone),
    ]);
    return opts.phoneTokens.some((token) => candidatePhoneTokens.has(token));
  });
}

type OrphanedAddressCollectionFallbackRow = {
  request_id: string;
  order_id: string;
};

async function findOrphanedAddressCollectionFallbackRequests(
  queryable: RescheduleQueryable,
  opts: {
    workspaceOwnerId: string;
    phoneTokens: string[];
    requestRef: string | null;
    replyToProviderRef: string | null;
    contactId: string | null;
    channelId: string | null;
    lock?: boolean;
  },
): Promise<OrphanedAddressCollectionFallbackRow[]> {
  const result = await queryable.query<OrphanedAddressCollectionFallbackRow>(
    `SELECT r.id AS request_id, r.order_id
       FROM address_collection_requests r
      WHERE r.workspace_owner_id = $1
        AND r.order_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
            FROM orders linked_order
           WHERE linked_order.id = r.order_id
             AND linked_order.workspace_owner_id = r.workspace_owner_id
        )
        AND r.closed_at IS NULL
        AND r.token_expires_at > now()
        AND r.status = ANY($2::text[])
        AND ($3::uuid IS NULL OR r.id = $3::uuid)
        AND (
          $4::text IS NULL
          OR r.whatsapp_template_provider_ref = $4
          OR EXISTS (
            SELECT 1
              FROM address_collection_actions exact_action
             WHERE exact_action.request_id = r.id
               AND exact_action.provider_ref = $4
          )
        )
        AND (
          r.respondio_channel_id = $5
          OR (
            r.respondio_channel_id IS NULL
            AND (
              (
                $4::text IS NOT NULL
                AND (
                  r.whatsapp_template_provider_ref = $4
                  OR EXISTS (
                    SELECT 1
                      FROM address_collection_actions channel_exact_action
                     WHERE channel_exact_action.request_id = r.id
                       AND channel_exact_action.provider_ref = $4
                  )
                )
              )
              OR EXISTS (
                SELECT 1
                  FROM address_collection_inbound_messages channel_evidence
                 WHERE channel_evidence.request_id = r.id
                   AND channel_evidence.workspace_owner_id = r.workspace_owner_id
                   AND channel_evidence.channel_id = $5
              )
            )
          )
        )
      ORDER BY r.created_at DESC
      ${opts.lock ? "FOR UPDATE OF r" : ""}`,
    [
      opts.workspaceOwnerId,
      FALLBACK_RECOVERABLE_REQUEST_STATUSES,
      opts.requestRef,
      opts.replyToProviderRef,
      opts.channelId ?? "",
    ],
  );
  return result.rows;
}

function assertNoOrphanedAddressCollectionFallbackRequest(
  rows: OrphanedAddressCollectionFallbackRow[],
): void {
  if (rows.length === 0) return;
  throw apiError(
    409,
    "ORPHANED_ADDRESS_COLLECTION_REQUEST",
    "The matching Address Collector request is linked to an order that no longer exists",
  );
}

function selectAddressCollectionFallbackCandidate(
  rows: AddressCollectionFallbackRow[],
  exactReferenceSupplied: boolean,
): AddressCollectionFallbackRow {
  const recoverableRows = rows.filter(isFallbackRecoverableRequest);
  if (recoverableRows.length === 0) {
    throw apiError(
      404,
      "ACTIVE_ADDRESS_COLLECTION_NOT_FOUND",
      "No active Address Collector request matches this recipient",
    );
  }
  if (exactReferenceSupplied) {
    if (recoverableRows.length !== 1) {
      throw apiError(
        409,
        "AMBIGUOUS_ADDRESS_COLLECTION_REQUEST",
        "The Address Collector request could not be identified safely",
      );
    }
    return recoverableRows[0];
  }
  if (recoverableRows.length > 1) {
    throw apiError(
      409,
      "AMBIGUOUS_ADDRESS_COLLECTION_REQUEST",
      "More than one unresolved Address Collector request matches this recipient",
    );
  }
  return recoverableRows[0];
}

function assertFallbackOrderEditable(statusValue: string): void {
  const status = normalizedStatus(statusValue);
  if (["out_for_delivery", "completed", "cancelled", "refunded"].includes(status)) {
    throw apiError(409, "ORDER_NOT_EDITABLE", "This order can no longer be edited");
  }
  if (["preparing", "ready_for_delivery"].includes(status)) {
    throw apiError(
      409,
      "MANUAL_APPROVAL_REQUIRED",
      "This order has entered fulfillment and requires manual approval",
    );
  }
}

function addressInputRecord(
  input: z.infer<typeof addressSchema>,
): Record<string, unknown> {
  return typeof input === "string" ? { address: input } : input;
}

const ADDRESS_CONTEXT_KEYS = [
  "date",
  "slot",
  "cityId",
  "city_id",
  "city",
  "cityName",
  "country",
  "countryCode",
] as const;

function cleanReplacementAddress(
  input: z.infer<typeof addressSchema>,
  previous: Record<string, unknown> | null,
): Record<string, unknown> {
  const incoming = addressInputRecord(input);
  const retainedContext = Object.fromEntries(
    ADDRESS_CONTEXT_KEYS
      .filter((key) => previous?.[key] != null)
      .map((key) => [key, previous![key]]),
  );
  return {
    ...retainedContext,
    ...incoming,
    address: incoming.address,
  };
}

function currentDeliveryDate(order: OrderRow): string | null {
  const value = order.delivery_address?.date;
  return typeof value === "string"
    ? value
    : order.window_start?.slice(0, 10) ?? null;
}

function parseSlotValue(value: unknown): { start_time: string; end_time: string } | null {
  if (
    typeof value === "object"
    && value !== null
    && "start_time" in value
    && "end_time" in value
    && typeof value.start_time === "string"
    && typeof value.end_time === "string"
  ) {
    if (/^\d{2}:\d{2}$/.test(value.start_time) && /^\d{2}:\d{2}$/.test(value.end_time)) {
      return { start_time: value.start_time, end_time: value.end_time };
    }
    return null;
  }
  if (typeof value !== "string") return null;
  const match = /^(.+?)\s*(?:-|–|—|\bto\b)\s*(.+?)$/i.exec(value.trim());
  if (!match) return null;

  const parseClock = (clock: string): string | null => {
    const twelveHour = /^(\d{1,2}):(\d{2})\s*([AP]M)$/i.exec(clock.trim());
    if (twelveHour) {
      const hour = Number(twelveHour[1]);
      const minute = Number(twelveHour[2]);
      if (hour < 1 || hour > 12 || minute > 59) return null;
      const canonicalHour = (hour % 12) + (twelveHour[3].toUpperCase() === "PM" ? 12 : 0);
      return `${String(canonicalHour).padStart(2, "0")}:${twelveHour[2]}`;
    }

    const twentyFourHour = /^(\d{2}):(\d{2})$/.exec(clock.trim());
    if (!twentyFourHour) return null;
    const hour = Number(twentyFourHour[1]);
    const minute = Number(twentyFourHour[2]);
    return hour <= 23 && minute <= 59 ? `${twentyFourHour[1]}:${twentyFourHour[2]}` : null;
  };

  const startTime = parseClock(match[1]);
  const endTime = parseClock(match[2]);
  return startTime && endTime
    ? { start_time: startTime, end_time: endTime }
    : null;
}

function currentDeliverySlot(order: OrderRow): { start_time: string; end_time: string } | null {
  return parseSlotValue(order.delivery_address?.slot);
}

function normalizeSingleChange(
  request: z.infer<typeof singleChangeUpdateSchema>,
  order: OrderRow,
): { changes: EffectiveChanges; previousValue: unknown; responseValue: unknown } {
  const { change_type: type, new_value: value } = request;
  if (type === "card_message") {
    if (typeof value !== "string" && value !== null) {
      throw apiError(400, "INVALID_REQUEST", "new_value must be text for card_message");
    }
    const next = typeof value === "string" ? value.trim() : null;
    return {
      changes: { card_message: next },
      previousValue: order.card_message,
      responseValue: next,
    };
  }
  if (type === "card_to") {
    if (typeof value !== "string" && value !== null) {
      throw apiError(400, "INVALID_REQUEST", "new_value must be text for card_to");
    }
    const next = typeof value === "string" ? value.trim() : null;
    return {
      changes: { card_to: next },
      previousValue: order.card_to,
      responseValue: next,
    };
  }
  if (type === "card_from") {
    if (typeof value !== "string" && value !== null) {
      throw apiError(400, "INVALID_REQUEST", "new_value must be text for card_from");
    }
    const next = typeof value === "string" ? value.trim() : null;
    return {
      changes: { card_from: next },
      previousValue: order.card_from,
      responseValue: next,
    };
  }
  if (type === "recipient_name") {
    if (typeof value !== "string" || !value.trim()) {
      throw apiError(400, "INVALID_REQUEST", "new_value must be text for recipient_name");
    }
    return {
      changes: { recipient_name: value.trim() },
      previousValue: order.recipient_name,
      responseValue: value.trim(),
    };
  }
  if (type === "recipient_phone") {
    if (typeof value !== "string" || !value.trim()) {
      throw apiError(400, "INVALID_REQUEST", "new_value must be a phone number for recipient_phone");
    }
    return {
      changes: { recipient_phone: value.trim() },
      previousValue: order.recipient_phone,
      responseValue: value.trim(),
    };
  }
  if (type === "delivery_address") {
    const address = addressSchema.safeParse(value);
    if (!address.success) {
      throw apiError(400, "INVALID_REQUEST", "new_value must be a valid delivery address");
    }
    return {
      changes: { delivery_address: address.data },
      previousValue: safeAddress(order.delivery_address),
      responseValue: address.data,
    };
  }
  const date = currentDeliveryDate(order);
  const existingSlot = currentDeliverySlot(order);
  if (!date || !existingSlot) {
    throw apiError(
      400,
      "INVALID_DELIVERY_SCHEDULE",
      "The order does not have a complete delivery date and slot to update",
    );
  }
  if (type === "delivery_date") {
    if (typeof value !== "string" || !isValidCalendarDate(value)) {
      throw apiError(400, "INVALID_DELIVERY_SCHEDULE", "new_value must be a valid delivery date");
    }
    return {
      changes: { delivery_date: value, delivery_slot: existingSlot },
      previousValue: date,
      responseValue: value,
    };
  }
  let slot = parseSlotValue(value);
  if (!slot && type === "delivery_time" && typeof value === "string" && /^\d{2}:\d{2}$/.test(value.trim())) {
    slot = { start_time: value.trim(), end_time: existingSlot.end_time };
  }
  if (!slot) {
    throw apiError(
      400,
      "INVALID_DELIVERY_SCHEDULE",
      "new_value must contain a valid delivery time or slot",
    );
  }
  return {
    changes: { delivery_date: date, delivery_slot: slot },
    previousValue: order.delivery_address?.slot ?? null,
    responseValue: type === "delivery_time" && typeof value === "string"
      ? value.trim()
      : slot,
  };
}

function singleChangeResultValue(
  type: SingleChangeType,
  order: OrderRow,
): unknown {
  if (type === "card_message") return order.card_message;
  if (type === "card_to") return order.card_to;
  if (type === "card_from") return order.card_from;
  if (type === "recipient_name") return order.recipient_name;
  if (type === "recipient_phone") return order.recipient_phone;
  if (type === "delivery_address") return safeAddress(order.delivery_address);
  if (type === "delivery_date") return currentDeliveryDate(order);
  return order.delivery_address?.slot ?? null;
}

async function prepareAddress(
  input: z.infer<typeof addressSchema>,
  order: OrderRow,
  workspaceOwnerId: string,
): Promise<PreparedAddress> {
  const incoming = addressInputRecord(input);
  const replacement = cleanReplacementAddress(input, order.delivery_address);
  const eligibility = getAddressEligibility(replacement);
  if (!eligibility.eligible || !eligibility.addressText) {
    throw apiError(
      422,
      "ADDRESS_REQUIRES_CLARIFICATION",
      "The delivery address needs more detail before it can be saved",
    );
  }
  const context = {
    workspaceOwnerId,
    orderId: order.id,
    canonicalAddress: eligibility.addressText,
    area: typeof replacement.area === "string"
      ? replacement.area
      : typeof replacement.district === "string" ? replacement.district : null,
    city: typeof replacement.city === "string"
      ? replacement.city
      : typeof replacement.cityName === "string" ? replacement.cityName : null,
    country: typeof replacement.countryCode === "string"
      ? replacement.countryCode
      : typeof replacement.country === "string" ? replacement.country : null,
    phone: order.recipient_phone,
    deliveryInstructions:
      typeof incoming.instructions === "string"
        ? incoming.instructions
        : order.delivery_instructions,
  };
  const assessment = await assessPlaceValidity(
    eligibility.addressText,
    [],
    context,
  );
  if (!assessment.valid) {
    throw apiError(
      422,
      "ADDRESS_REQUIRES_CLARIFICATION",
      "The delivery address could not be safely confirmed",
    );
  }
  const geocode = await geocodeAddress(
    eligibility.addressText,
    context,
    assessment.locationHints,
  );
  if (!geocode) {
    throw apiError(
      422,
      "ADDRESS_REQUIRES_CLARIFICATION",
      "The delivery address could not be safely located",
    );
  }
  return {
    value: {
      ...replacement,
      address: eligibility.addressText,
      latitude: geocode.lat,
      longitude: geocode.lng,
      geocodeProvider: geocode.provider,
      geocodeMatchType: geocode.matchType,
      geocodePrecision: geocode.precision,
      geocodeMethod: geocode.method,
    },
    text: eligibility.addressText,
    latitude: geocode.lat,
    longitude: geocode.lng,
  };
}

async function reconcileAddressCollectionCorrection(
  client: RescheduleQueryable,
  input: {
    workspaceOwnerId: string;
    orderId: string;
    address: Record<string, unknown>;
    latitude: number | null;
    longitude: number | null;
    source: "respondio_ai_agent" | "respondio_workflow_address_correction";
    workflowRequestId: string | null;
  },
): Promise<boolean> {
  await client.query(
    `WITH candidates AS (
       SELECT id, status
         FROM address_collection_requests
        WHERE workspace_owner_id = $1
          AND order_id = $2
          AND status = ANY($7::text[])
        FOR UPDATE
     ), updated AS (
       UPDATE address_collection_requests request
          SET status = 'resolved',
              submitted_address = $3::jsonb,
              submitted_lat = $4,
              submitted_lng = $5,
              address_received_at = COALESCE(address_received_at, now()),
              resolved_at = now(),
              resolution_outcome = 'support_correction',
              closure_reason = 'Superseded by authenticated Respond.io address correction',
              closure_source = $6,
              closed_at = now(),
              token_expires_at = LEAST(token_expires_at, now()),
              updated_at = now()
         FROM candidates
        WHERE request.id = candidates.id
     RETURNING request.id, candidates.status
     )
     INSERT INTO address_collection_events
       (request_id, event_type, previous_state, new_state, actor, channel, metadata)
     SELECT id, 'request_closed', status, 'resolved',
            'respondio_support_agent', 'whatsapp',
            jsonb_build_object(
              'source', $6::text,
              'workflow_request_id', $8::text
            )
       FROM updated`,
    [
      input.workspaceOwnerId,
      input.orderId,
      JSON.stringify(input.address),
      input.latitude,
      input.longitude,
      input.source,
      [...FALLBACK_RECOVERABLE_REQUEST_STATUSES, "processing"],
      input.workflowRequestId,
    ],
  );
  const cancelled = await client.query<{ action_type: string }>(
    `UPDATE address_collection_actions action
        SET status = 'cancelled', updated_at = now()
      WHERE action.request_id IN (
        SELECT id
          FROM address_collection_requests
         WHERE workspace_owner_id = $1 AND order_id = $2
      )
        AND action.status IN ('pending', 'processing')
      RETURNING action.action_type`,
    [input.workspaceOwnerId, input.orderId],
  );
  return cancelled.rows.some(
    (action) => action.action_type === "tookan_destination_update",
  );
}

router.use("/respondio/ai/orders", requireRespondioAi);
router.use("/respondio/ai/address-collection", requireRespondioAi);

router.post("/respondio/ai/address-collection/fallback", async (req: Request, res: Response) => {
  const parsed = addressCollectionFallbackSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      code: "INVALID_REQUEST",
      error: parsed.error.issues.map((issue) => issue.message).join("; "),
    });
    return;
  }

  const workspaceOwnerId = (req as AiRequest).respondioWorkspaceOwnerId!;
  const channelId = (req.get("x-respondio-channel-id") ?? "").trim();
  if (!channelId) {
    res.status(400).json({
      success: false,
      code: "RESPONDIO_CHANNEL_REQUIRED",
      error: "X-Respondio-Channel-Id is required for Address Collector fallback",
    });
    return;
  }
  let contactPhone = "";
  if (parsed.data.contact_phone) {
    try {
      contactPhone = normalizedFallbackContactPhone(parsed.data.contact_phone);
    } catch (error) {
      sendError(res, error);
      return;
    }
  }
  const fallbackAddress = addressSchema.safeParse(parsed.data.address);
  const address = fallbackAddress.success ? fallbackAddress.data : null;
  const addressFingerprint = address
    ? fallbackAddressFingerprint(address)
    : null;
  let nativeRequestRef: string | null = null;
  let recoveringExistingNativeMessage = false;

  if (parsed.data.message_id) {
    try {
      const existing = await db.query<NativeFallbackRow & {
        reply_reference_matches: boolean;
      }>(
        `SELECT m.provider_message_id, m.reply_type, m.reply_text,
                m.received_at, m.processed_at, m.processing_started_at,
                m.claim_token,
                (
                  m.processed_at IS NULL
                  AND m.processing_started_at >= now() - interval '10 minutes'
                ) AS claim_active,
                m.outcome, r.id AS request_id, r.order_id,
                r.status AS request_status, r.closed_at AS request_closed_at,
                r.closure_source, r.resolution_outcome, r.inbound_outcome,
                r.submitted_address,
                o.display_order_number, o.external_order_number, o.external_order_id,
                o.delivery_address,
                (
                  $4::text IS NULL
                  OR r.whatsapp_template_provider_ref = $4
                  OR EXISTS (
                    SELECT 1
                      FROM address_collection_actions exact_action
                     WHERE exact_action.request_id = r.id
                       AND exact_action.provider_ref = $4
                  )
                ) AS reply_reference_matches
           FROM address_collection_inbound_messages m
           JOIN address_collection_requests r
             ON r.id = m.request_id
            AND r.workspace_owner_id = m.workspace_owner_id
           JOIN orders o
             ON o.id = r.order_id
            AND o.workspace_owner_id = r.workspace_owner_id
          WHERE m.provider_message_id = $1
            AND m.workspace_owner_id = $2
            AND m.channel_id = $3
            AND ($5::text = '' OR m.normalized_phone = $5)
            AND ($6::text IS NULL OR m.contact_id = $6)
            AND (
              r.respondio_channel_id = $3
              OR (r.respondio_channel_id IS NULL AND m.channel_id = $3)
            )
          LIMIT 1`,
        [
          parsed.data.message_id,
          workspaceOwnerId,
          channelId,
          parsed.data.reply_to_provider_ref ?? null,
          contactPhone,
          parsed.data.contact_id ?? null,
        ],
      );
      if (existing.rows[0]) {
        const existingNative = existing.rows[0];
        if (
          parsed.data.address_collection_ref
          && parsed.data.address_collection_ref !== existingNative.request_id
        ) {
          throw apiError(
            409,
            "CONFLICTING_ADDRESS_COLLECTION_REFERENCES",
            "The Address Collector reference does not match the persisted fallback",
          );
        }
        if (
          parsed.data.reply_to_provider_ref
          && existingNative.reply_reference_matches !== true
        ) {
          throw apiError(
            409,
            "CONFLICTING_ADDRESS_COLLECTION_REFERENCES",
            "The reply reference does not match the persisted fallback",
          );
        }
        if (nativeFallbackProcessing(existingNative)) {
          const existingIdentifiers = publicOrderIdentifiers({
            display_order_number: existingNative.display_order_number,
            external_order_number: existingNative.external_order_number,
            external_order_id: existingNative.external_order_id,
          } as OrderRow);
          res.status(200).json({
            success: true,
            changed: false,
            processing: true,
            saved: false,
            status: "processing",
            idempotent: true,
            order_id: existingIdentifiers?.orderId ?? null,
            order_number: existingIdentifiers?.orderNumber ?? null,
            address_collection_ref: existingNative.request_id,
            delivery_address: null,
            message: "Address processing is already in progress; the address is not yet confirmed saved",
          });
          return;
        }
        if (authoritativeNativeLocationResolved(existingNative)) {
          const existingIdentifiers = publicOrderIdentifiers({
            display_order_number: existingNative.display_order_number,
            external_order_number: existingNative.external_order_number,
            external_order_id: existingNative.external_order_id,
          } as OrderRow);
          res.status(200).json({
            success: true,
            changed: false,
            processing: false,
            saved: true,
            status: "saved",
            idempotent: true,
            order_id: existingIdentifiers?.orderId ?? null,
            order_number: existingIdentifiers?.orderNumber ?? null,
            address_collection_ref: existingNative.request_id,
            delivery_address: existingNative.delivery_address,
          });
          return;
        }
        const exactAddressMatches = existingNative.request_status === "resolved"
          ? fallbackAddress.success && matchesNativePersistedAddress(
              {
                ...existingNative,
                submitted_address:
                  existingNative.submitted_address ?? existingNative.delivery_address,
              },
              fallbackAddress.data,
            )
          : fallbackAddress.success
            && matchesNativeResolvedAddress(existingNative, fallbackAddress.data);
        if (!exactAddressMatches) {
          throw apiError(
            409,
            "ADDRESS_COLLECTION_ADDRESS_MISMATCH",
            "The submitted address does not match the persisted native reply",
          );
        }
        if (
          existingNative.request_status === "processing"
          && existingNative.processed_at === null
        ) {
          const recovery = await recoverExpiredNativeFallback(
            existingNative,
            workspaceOwnerId,
            channelId,
          );
          if (recovery === "processing") {
            throw apiError(
              409,
              "ADDRESS_COLLECTION_FALLBACK_IN_PROGRESS",
              "This Address Collector fallback is already being processed",
            );
          }
          if (recovery === "resolved") {
            throw apiError(
              409,
              "ADDRESS_COLLECTION_REQUEST_CHANGED",
              "Native address processing completed; retry to read the stored result",
            );
          }
          nativeRequestRef = existingNative.request_id;
          recoveringExistingNativeMessage = true;
        } else if (
          existingNative.processed_at !== null
          && existingNative.request_status === "needs_review"
        ) {
          nativeRequestRef = existingNative.request_id;
          recoveringExistingNativeMessage = true;
        } else if (
          existingNative.outcome !== "resolved"
          && existingNative.request_status !== "resolved"
        ) {
          throw apiError(
            409,
            "ADDRESS_COLLECTION_FALLBACK_IN_PROGRESS",
            "This Address Collector fallback cannot be safely resumed",
          );
        }
        if (recoveringExistingNativeMessage) {
          // Continue through candidate revalidation and the canonical fallback
          // transaction using a separate deterministic replay key. The native
          // provider ID remains an immutable record of its own processing.
        } else {
          const terminalAddressMatches =
            existingNative.request_status === "resolved"
            && existingNative.request_closed_at !== null
            && existingNative.submitted_address !== null
            && canonicalJson(existingNative.submitted_address)
              === canonicalJson(existingNative.delivery_address)
            && fallbackAddress.success
            && matchesNativePersistedAddress(existingNative, fallbackAddress.data);
          if (!terminalAddressMatches) {
            throw apiError(
              409,
              "ADDRESS_COLLECTION_ADDRESS_MISMATCH",
              "The submitted address does not match the stored order address",
            );
          }
          const existingIdentifiers = publicOrderIdentifiers({
            display_order_number: existingNative.display_order_number,
            external_order_number: existingNative.external_order_number,
            external_order_id: existingNative.external_order_id,
          } as OrderRow);
          res.status(200).json({
            success: true,
            changed: false,
            processing: false,
            saved: true,
            status: "saved",
            idempotent: true,
            order_id: existingIdentifiers?.orderId ?? null,
            order_number: existingIdentifiers?.orderNumber ?? null,
            address_collection_ref: existingNative.request_id,
            delivery_address: existingNative.delivery_address,
          });
          return;
        }
      }
    } catch (error) {
      sendError(res, error);
      return;
    }
  } else {
    if (!address || !addressFingerprint) {
      res.status(400).json({
        success: false,
        saved: false,
        processing: false,
        status: "rejected",
        code: "INVALID_REQUEST",
        error: "address must be a valid delivery address when no authoritative native pin result exists",
      });
      return;
    }
    try {
      const retries = await db.query<{
        provider_message_id: string;
        outcome: string | null;
        request_id: string;
        order_id: string;
        display_order_number: string | null;
        external_order_number: string | null;
        external_order_id: string | null;
        delivery_address: Record<string, unknown> | null;
        submitted_address: Record<string, unknown> | null;
        contact_id: string | null;
        normalized_phone: string | null;
      }>(
        `SELECT m.provider_message_id, m.outcome, r.id AS request_id, o.id AS order_id,
                o.display_order_number, o.external_order_number, o.external_order_id,
                o.delivery_address, r.submitted_address,
                m.contact_id, m.normalized_phone
           FROM address_collection_inbound_messages m
           JOIN address_collection_requests r
             ON r.id = m.request_id
            AND r.workspace_owner_id = m.workspace_owner_id
           JOIN orders o
             ON o.id = r.order_id
            AND o.workspace_owner_id = r.workspace_owner_id
          WHERE m.workspace_owner_id = $1
            AND m.channel_id = $2
            AND (
              r.respondio_channel_id = $2
              OR (r.respondio_channel_id IS NULL AND m.channel_id = $2)
            )
            AND m.outcome = 'resolved'
            AND r.status = 'resolved'
            AND r.closed_at IS NOT NULL
            AND r.submitted_address = o.delivery_address
            AND m.provider_message_id LIKE 'support-fallback:v1:%'
            AND m.classifier_result->>'input_fingerprint' = $3
            AND m.processed_at >= now() - interval '24 hours'
            AND ($4::uuid IS NULL OR r.id = $4::uuid)
            AND ($6::text IS NULL OR m.contact_id = $6)
            AND ($7::text = '' OR m.normalized_phone = $7)
            AND (
              $5::text IS NULL
              OR r.whatsapp_template_provider_ref = $5
              OR EXISTS (
                SELECT 1
                  FROM address_collection_actions exact_action
                 WHERE exact_action.request_id = r.id
                   AND exact_action.provider_ref = $5
              )
            )
          ORDER BY m.processed_at DESC
          LIMIT 5`,
        [
          workspaceOwnerId,
          channelId,
          addressFingerprint,
          parsed.data.address_collection_ref ?? null,
          parsed.data.reply_to_provider_ref ?? null,
          parsed.data.contact_id ?? null,
          contactPhone,
        ],
      );
      const matchingRetries = retries.rows.filter((row) => secureEqual(
        row.provider_message_id,
        syntheticFallbackMessageId({
          workspaceOwnerId,
          channelId,
          contactPhone,
          requestId: row.request_id,
          orderId: row.order_id,
          addressFingerprint,
        }),
      ));
      if (matchingRetries.length > 1) {
        throw apiError(
          409,
          "AMBIGUOUS_ADDRESS_COLLECTION_REQUEST",
          "More than one saved Address Collector request matches this retry",
        );
      }
      const retry = matchingRetries[0];
      if (
        retry
        && matchesNativePersistedAddress(
          {
            submitted_address: retry.submitted_address,
          } as NativeFallbackRow,
          address,
        )
      ) {
        const existingIdentifiers = publicOrderIdentifiers({
          display_order_number: retry.display_order_number,
          external_order_number: retry.external_order_number,
          external_order_id: retry.external_order_id,
        } as OrderRow);
        res.status(200).json({
          success: true,
          changed: false,
          processing: false,
          saved: true,
          status: "saved",
          idempotent: true,
          order_id: existingIdentifiers?.orderId ?? null,
          order_number: existingIdentifiers?.orderNumber ?? null,
          address_collection_ref: retry.request_id,
          delivery_address: retry.delivery_address,
        });
        return;
      }

      const nativeMatchOpts = {
        workspaceOwnerId,
        channelId,
        contactPhone,
        contactId: parsed.data.contact_id ?? null,
        requestRef: parsed.data.address_collection_ref ?? null,
        replyToProviderRef: parsed.data.reply_to_provider_ref ?? null,
        address,
      };
      const nativeResolution = selectMatchingNativeFallback(
        await findMatchingRecentNativeFallbacks(nativeMatchOpts),
      );
      if (nativeResolution && nativeFallbackProcessing(nativeResolution)) {
        const existingIdentifiers = publicOrderIdentifiers({
          display_order_number: nativeResolution.display_order_number,
          external_order_number: nativeResolution.external_order_number,
          external_order_id: nativeResolution.external_order_id,
        } as OrderRow);
        res.status(200).json({
          success: true,
          changed: false,
          processing: true,
          saved: false,
          status: "processing",
          idempotent: true,
          order_id: existingIdentifiers?.orderId ?? null,
          order_number: existingIdentifiers?.orderNumber ?? null,
          address_collection_ref: nativeResolution.request_id,
          delivery_address: null,
          message: "Address processing is already in progress; the address is not yet confirmed saved",
        });
        return;
      }
      if (
        nativeResolution
        && nativeResolution.request_status === "processing"
        && nativeResolution.processed_at === null
      ) {
        const recovery = await recoverExpiredNativeFallback(
          nativeResolution,
          workspaceOwnerId,
          channelId,
        );
        if (recovery === "processing") {
          const existingIdentifiers = publicOrderIdentifiers({
            display_order_number: nativeResolution.display_order_number,
            external_order_number: nativeResolution.external_order_number,
            external_order_id: nativeResolution.external_order_id,
          } as OrderRow);
          res.status(200).json({
            success: true,
            changed: false,
            processing: true,
            saved: false,
            status: "processing",
            idempotent: true,
            order_id: existingIdentifiers?.orderId ?? null,
            order_number: existingIdentifiers?.orderNumber ?? null,
            address_collection_ref: nativeResolution.request_id,
            delivery_address: null,
            message: "Address processing is already in progress; the address is not yet confirmed saved",
          });
          return;
        }
        if (recovery === "resolved") {
          const refreshed = selectMatchingNativeFallback(
            await findMatchingRecentNativeFallbacks(nativeMatchOpts),
          );
          if (
            refreshed
            && nativeFallbackResolved(refreshed)
            && matchesNativePersistedAddress(refreshed, address)
          ) {
            const existingIdentifiers = publicOrderIdentifiers({
              display_order_number: refreshed.display_order_number,
              external_order_number: refreshed.external_order_number,
              external_order_id: refreshed.external_order_id,
            } as OrderRow);
            res.status(200).json({
              success: true,
              changed: false,
              processing: false,
              saved: true,
              status: "saved",
              idempotent: true,
              order_id: existingIdentifiers?.orderId ?? null,
              order_number: existingIdentifiers?.orderNumber ?? null,
              address_collection_ref: refreshed.request_id,
              delivery_address: refreshed.delivery_address,
            });
            return;
          }
          throw apiError(
            409,
            "ADDRESS_COLLECTION_REQUEST_CHANGED",
            "Native address processing completed with a different result",
          );
        }
        nativeRequestRef = nativeResolution.request_id;
      }
      if (
        nativeResolution
        && nativeFallbackResolved(nativeResolution)
        && matchesNativePersistedAddress(nativeResolution, address)
      ) {
        const existingIdentifiers = publicOrderIdentifiers({
          display_order_number: nativeResolution.display_order_number,
          external_order_number: nativeResolution.external_order_number,
          external_order_id: nativeResolution.external_order_id,
        } as OrderRow);
        res.status(200).json({
          success: true,
          changed: false,
          processing: false,
          saved: true,
          status: "saved",
          idempotent: true,
          order_id: existingIdentifiers?.orderId ?? null,
          order_number: existingIdentifiers?.orderNumber ?? null,
          address_collection_ref: nativeResolution.request_id,
          delivery_address: nativeResolution.delivery_address,
        });
        return;
      }
      if (
        nativeResolution
        && nativeResolution.processed_at !== null
        && nativeResolution.request_status === "needs_review"
      ) {
        // This route is bearer-authenticated and invoked by the Respond.io agent,
        // not by the native incoming-message webhook. Once the agent supplies a
        // concrete address for one unambiguous collector request, recover the
        // completed review result through the normal validated persistence path.
        nativeRequestRef = nativeResolution.request_id;
      }
      if (nativeResolution && nativeRequestRef === null) {
        nativeRequestRef = nativeResolution.request_id;
      }
    } catch (error) {
      sendError(res, error);
      return;
    }
  }

  if (!address || !addressFingerprint) {
    res.status(400).json({
      success: false,
      saved: false,
      processing: false,
      status: "rejected",
      code: "INVALID_REQUEST",
      error: "address must be a valid delivery address when no authoritative native pin result exists",
    });
    return;
  }

  let candidate: AddressCollectionFallbackRow;
  try {
    const exactReplyRef = recoveringExistingNativeMessage
      ? null
      : parsed.data.reply_to_provider_ref ?? null;
    const exactRequestRef = exactReplyRef
      ? null
      : nativeRequestRef ?? parsed.data.address_collection_ref ?? null;
    const candidates = await findAddressCollectionFallbackCandidates(db, {
      workspaceOwnerId,
      phoneTokens: buildPhoneSearchTokens(contactPhone),
      requestRef: exactRequestRef,
      replyToProviderRef: exactReplyRef,
      contactId: parsed.data.contact_id ?? null,
      channelId: channelId || null,
    });
    if (candidates.length === 0 && exactRequestRef !== null) {
      const completed = await db.query<{
        request_id: string;
        submitted_address: Record<string, unknown> | null;
        display_order_number: string | null;
        external_order_number: string | null;
        external_order_id: string | null;
        delivery_address: Record<string, unknown>;
      }>(
        `SELECT r.id AS request_id, r.submitted_address,
                o.display_order_number, o.external_order_number,
                o.external_order_id, o.delivery_address
           FROM address_collection_requests r
           JOIN orders o
             ON o.id = r.order_id
            AND o.workspace_owner_id = r.workspace_owner_id
          WHERE r.id = $1
            AND r.workspace_owner_id = $2
            AND r.status = 'resolved'
            AND r.closed_at IS NOT NULL
            AND r.submitted_address = o.delivery_address
            AND (
              r.respondio_channel_id = $3
              OR (
                r.respondio_channel_id IS NULL
                AND EXISTS (
                  SELECT 1
                    FROM address_collection_inbound_messages channel_evidence
                   WHERE channel_evidence.request_id = r.id
                     AND channel_evidence.workspace_owner_id = r.workspace_owner_id
                     AND channel_evidence.channel_id = $3
                )
              )
            )
            AND ($4::text IS NULL OR r.respondio_contact_id = $4)
            AND (
              $5::text = ''
              OR EXISTS (
                SELECT 1
                  FROM address_collection_inbound_messages phone_evidence
                 WHERE phone_evidence.request_id = r.id
                   AND phone_evidence.workspace_owner_id = r.workspace_owner_id
                   AND phone_evidence.channel_id = $3
                   AND phone_evidence.normalized_phone = $5
              )
            )
            AND (
              $6::text IS NULL
              OR EXISTS (
                SELECT 1
                  FROM address_collection_inbound_messages message_evidence
                 WHERE message_evidence.request_id = r.id
                   AND message_evidence.workspace_owner_id = r.workspace_owner_id
                   AND message_evidence.channel_id = $3
                   AND message_evidence.provider_message_id = $6
                   AND ($4::text IS NULL OR message_evidence.contact_id = $4)
                   AND ($5::text = '' OR message_evidence.normalized_phone = $5)
              )
            )
          LIMIT 1`,
        [
          exactRequestRef,
          workspaceOwnerId,
          channelId,
          parsed.data.contact_id ?? null,
          contactPhone,
          parsed.data.message_id ?? null,
        ],
      );
      const resolved = completed.rows[0];
      const submitted = resolved?.submitted_address ?? null;
      const input = addressInputRecord(address);
      const addressMatches = submitted !== null
        && Object.entries(input).every(([key, value]) =>
          canonicalJson(submitted[key]) === canonicalJson(value));
      if (resolved && addressMatches) {
        const identifiers = publicOrderIdentifiers({
          display_order_number: resolved.display_order_number,
          external_order_number: resolved.external_order_number,
          external_order_id: resolved.external_order_id,
        } as OrderRow);
        res.status(200).json({
          success: true,
          changed: false,
          processing: false,
          saved: true,
          status: "saved",
          idempotent: true,
          order_id: identifiers?.orderId ?? null,
          order_number: identifiers?.orderNumber ?? null,
          address_collection_ref: resolved.request_id,
          delivery_address: resolved.delivery_address,
        });
        return;
      }
    }
    if (candidates.length === 0 && (exactReplyRef !== null || exactRequestRef !== null)) {
      assertNoOrphanedAddressCollectionFallbackRequest(
        await findOrphanedAddressCollectionFallbackRequests(db, {
          workspaceOwnerId,
          phoneTokens: buildPhoneSearchTokens(contactPhone),
          requestRef: exactRequestRef,
          replyToProviderRef: exactReplyRef,
          contactId: parsed.data.contact_id ?? null,
          channelId: channelId || null,
        }),
      );
    }
    candidate = selectAddressCollectionFallbackCandidate(
      candidates,
      exactReplyRef !== null || exactRequestRef !== null,
    );
    if (
      exactReplyRef
      && parsed.data.address_collection_ref
      && candidate.request_id !== parsed.data.address_collection_ref
    ) {
      throw apiError(
        409,
        "CONFLICTING_ADDRESS_COLLECTION_REFERENCES",
        "The reply and Address Collector references do not identify the same request",
      );
    }
    assertFallbackOrderEditable(candidate.status);
  } catch (error) {
    sendError(res, error);
    return;
  }

  let preparedAddress: PreparedAddress;
  try {
    preparedAddress = await prepareAddress(
      address,
      candidate,
      workspaceOwnerId,
    );
  } catch (error) {
    sendError(res, error);
    return;
  }

  const providerMessageId = parsed.data.message_id && !recoveringExistingNativeMessage
    ? parsed.data.message_id
    : syntheticFallbackMessageId({
    workspaceOwnerId,
    channelId,
    contactPhone,
    requestId: candidate.request_id,
    orderId: candidate.id,
    addressFingerprint,
  });
  const client = await db.connect();
  let idempotent = false;
  let storedAddress: Record<string, unknown> | null = null;
  try {
    await withTransaction(client, async () => {
      const inbound = await client.query(
        `INSERT INTO address_collection_inbound_messages
           (provider_message_id, channel_id, contact_id, reply_to_provider_ref,
            workspace_owner_id, request_id, normalized_phone, reply_type, reply_text)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'text',$8)
         ON CONFLICT (provider_message_id) DO NOTHING
         RETURNING id`,
        [
          providerMessageId,
          channelId || null,
          parsed.data.contact_id ?? null,
          parsed.data.reply_to_provider_ref ?? null,
          workspaceOwnerId,
          candidate.request_id,
          contactPhone,
          typeof address === "string"
            ? address
            : address.address,
        ],
      );
      if (inbound.rowCount !== 1) {
        const existing = await client.query<{
          outcome: string | null;
          workspace_owner_id: string | null;
          request_id: string | null;
          delivery_address: Record<string, unknown> | null;
          submitted_address: Record<string, unknown> | null;
          request_status: string;
          request_closed_at: string | null;
          contact_id: string | null;
          normalized_phone: string | null;
        }>(
          `SELECT m.outcome, m.workspace_owner_id, m.request_id,
                  o.delivery_address, r.submitted_address,
                  r.status AS request_status, r.closed_at AS request_closed_at,
                  m.contact_id, m.normalized_phone
             FROM address_collection_inbound_messages m
             JOIN address_collection_requests r
               ON r.id = m.request_id
              AND r.workspace_owner_id = m.workspace_owner_id
             JOIN orders o
               ON o.id = r.order_id
              AND o.workspace_owner_id = r.workspace_owner_id
            WHERE m.provider_message_id = $1
              AND m.workspace_owner_id = $2
              AND m.channel_id = $3
              AND r.respondio_channel_id = $3
            FOR UPDATE`,
          [
            providerMessageId,
            workspaceOwnerId,
            channelId,
          ],
        );
        if (
          existing.rows[0]?.workspace_owner_id === workspaceOwnerId
          && existing.rows[0]?.outcome === "resolved"
          && existing.rows[0]?.request_id === candidate.request_id
          && existing.rows[0]?.request_status === "resolved"
          && existing.rows[0]?.request_closed_at !== null
          && (
            parsed.data.contact_id === undefined
            || existing.rows[0]?.contact_id === parsed.data.contact_id
          )
          && (
            contactPhone === ""
            || existing.rows[0]?.normalized_phone === contactPhone
          )
          && canonicalJson(existing.rows[0]?.submitted_address)
            === canonicalJson(existing.rows[0]?.delivery_address)
          && matchesNativePersistedAddress(
            {
              submitted_address: existing.rows[0]?.submitted_address,
            } as NativeFallbackRow,
            address,
          )
        ) {
          idempotent = true;
          storedAddress = existing.rows[0].delivery_address;
          return;
        }
        throw apiError(
          409,
          "ADDRESS_COLLECTION_FALLBACK_IN_PROGRESS",
          "This Address Collector fallback is already being processed",
        );
      }

      const lockedRows = await findAddressCollectionFallbackCandidates(client, {
        workspaceOwnerId,
        phoneTokens: buildPhoneSearchTokens(contactPhone),
        requestRef: candidate.request_id,
        replyToProviderRef: null,
        contactId: parsed.data.contact_id ?? null,
        channelId: channelId || null,
        lock: true,
      });
      if (lockedRows.length === 0) {
        assertNoOrphanedAddressCollectionFallbackRequest(
          await findOrphanedAddressCollectionFallbackRequests(client, {
            workspaceOwnerId,
            phoneTokens: buildPhoneSearchTokens(contactPhone),
            requestRef: candidate.request_id,
            replyToProviderRef: null,
            contactId: parsed.data.contact_id ?? null,
            channelId: channelId || null,
            lock: true,
          }),
        );
      }
      if (lockedRows.length !== 1) {
        throw apiError(
          409,
          "ADDRESS_COLLECTION_REQUEST_CHANGED",
          "The active Address Collector request changed before it could be updated",
        );
      }
      const locked = lockedRows[0];
      if (locked.id !== candidate.id) {
        throw apiError(
          409,
          "ADDRESS_COLLECTION_REQUEST_CHANGED",
          "The Address Collector request changed orders before it could be updated",
        );
      }
      assertFallbackOrderEditable(locked.status);
      storedAddress = preparedAddress.value;

      const requestUpdated = await client.query(
        `UPDATE address_collection_requests
            SET status = 'resolved', submitted_address = $2::jsonb,
                submitted_lat = $3, submitted_lng = $4,
                address_received_at = now(), resolved_at = now(),
                resolution_outcome = 'automatic_collection',
                closure_reason = 'Address resolved from Respond.io Support fallback',
                closure_source = 'respondio_support_fallback',
                closed_at = now(),
                token_expires_at = LEAST(token_expires_at, now()),
                respondio_channel_id = COALESCE(respondio_channel_id, $10),
                inbound_reply_type = 'text', inbound_reply_text = $5,
                inbound_lat = $3, inbound_lng = $4,
                inbound_classifier = $6::jsonb, inbound_confidence = $7,
                inbound_outcome = 'resolved', inbound_error = NULL,
                updated_at = now()
          WHERE id = $1
            AND workspace_owner_id = $8
            AND closed_at IS NULL
            AND token_expires_at > now()
            AND status = ANY($9::text[])
          RETURNING id`,
        [
          locked.request_id,
          JSON.stringify(storedAddress),
          preparedAddress.latitude,
          preparedAddress.longitude,
          typeof address === "string"
            ? address
            : address.address,
          JSON.stringify({
            source: "respondio_support_address_collection_fallback",
            match: parsed.data.reply_to_provider_ref
              ? "reply_reference"
              : parsed.data.address_collection_ref
                ? "request_reference"
                : "newest_active_request",
          }),
          1,
          workspaceOwnerId,
          FALLBACK_RECOVERABLE_REQUEST_STATUSES,
          channelId,
        ],
      );
      if (requestUpdated.rowCount !== 1) {
        throw apiError(
          409,
          "ADDRESS_COLLECTION_REQUEST_CHANGED",
          "The active Address Collector request changed before it could be updated",
        );
      }

      const orderUpdated = await client.query(
        `UPDATE orders
            SET delivery_address = $3::jsonb, updated_at = now()
          WHERE id = $1 AND workspace_owner_id = $2
          RETURNING id`,
        [locked.id, workspaceOwnerId, JSON.stringify(storedAddress)],
      );
      if (orderUpdated.rowCount !== 1) {
        throw apiError(404, "ORDER_NOT_FOUND", "The matching order no longer exists");
      }

      await client.query(
        `UPDATE address_collection_actions
            SET status = 'cancelled', updated_at = now()
          WHERE request_id = $1
            AND status IN ('pending','processing')
            AND action_type <> 'tookan_destination_update'`,
        [locked.request_id],
      );
      if (locked.tookan_job_id) {
        await client.query(
          `INSERT INTO address_collection_actions
             (request_id, action_type, channel, scheduled_at, status,
              idempotency_key, triggering_rule)
           VALUES ($1, 'tookan_destination_update', 'tookan', now(), 'pending', $2,
                   'address resolved from respond.io Support fallback')
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [
            locked.request_id,
            `address-support-fallback:${providerMessageId}:tookan-destination`,
          ],
        );
      }
      await client.query(
        `UPDATE address_collection_inbound_messages
            SET classifier_result = $2::jsonb, confidence = $3,
                outcome = 'resolved', processed_at = now()
          WHERE provider_message_id = $1
            AND workspace_owner_id = $4
            AND processed_at IS NULL`,
        [
          providerMessageId,
          JSON.stringify({
            source: "respondio_support_address_collection_fallback",
            input_fingerprint: addressFingerprint,
            synthetic_message_id: parsed.data.message_id == null,
          }),
          1,
          workspaceOwnerId,
        ],
      );
      await client.query(
        `INSERT INTO address_collection_events
           (request_id, event_type, previous_state, new_state, actor, channel, provider_ref, metadata)
         VALUES ($1,'reply_resolved',$2,'resolved','respondio_support_agent','whatsapp',$3,$4::jsonb)`,
        [
          locked.request_id,
          locked.request_status,
          providerMessageId,
          JSON.stringify({
            source: "respondio_support_address_collection_fallback",
            recipient_phone: contactPhone,
            old_address: locked.delivery_address,
            new_address: storedAddress,
          }),
        ],
      );
      await client.query(
        `INSERT INTO order_events
           (workspace_owner_id, order_id, event_type, payload, actor_name)
         VALUES ($1,$2,'delivery_address_updated',$3::jsonb,'Respond.io Address Collector Support')`,
        [
          workspaceOwnerId,
          locked.id,
          JSON.stringify({
            source: "respondio_support_address_collection_fallback",
            request_id: locked.request_id,
            old_address: locked.delivery_address,
            new_address: storedAddress,
            recipient_phone: contactPhone,
          }),
        ],
      );
    });
  } catch (error) {
    sendError(res, error);
    return;
  } finally {
    client.release();
  }

  const identifiers = publicOrderIdentifiers(candidate);
  if (!idempotent && storedAddress) {
    void linkOrderToAddressBook(candidate.id, workspaceOwnerId, storedAddress);
  }
  res.status(200).json({
    success: true,
    changed: !idempotent,
    processing: false,
    saved: true,
    status: "saved",
    idempotent,
    order_id: identifiers?.orderId ?? null,
    order_number: identifiers?.orderNumber ?? null,
    address_collection_ref: candidate.request_id,
    delivery_address: storedAddress ?? preparedAddress.value,
  });
});

router.post("/respondio/ai/orders/find", async (req: Request, res: Response) => {
  const requestId = String((req as Request & { id?: string | number }).id ?? req.get("x-request-id") ?? "unknown");
  const parsed = findSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    logger.info(
      { requestId, orderPresent: false, phonePresent: false, status: 400 },
      "respondio AI order lookup rejected",
    );
    res.status(400).json({
      success: false,
      code: "INVALID_REQUEST",
      error: "Provide orderNumber, phone, or both",
    });
    return;
  }
  try {
    const inputs = resolveFindInputs(parsed.data);
    logger.info(
      {
        requestId,
        orderPresent: inputs.orderIdentifier !== null,
        phonePresent: inputs.phone !== null,
        normalizedOrderFingerprint: identifierFingerprint(inputs.orderIdentifier),
        normalizedPhoneMasked: maskedPhone(inputs.phone),
        normalizedPhoneTokenCount: inputs.phoneTokens.length,
      },
      "respondio AI order lookup received",
    );
    const workspaceOwnerId = (req as AiRequest).respondioWorkspaceOwnerId!;
    if (!inputs.phone && !inputs.orderIdentifier) {
      throw apiError(
        400,
        "INVALID_REQUEST",
        "Provide orderNumber, phone, or both",
      );
    }
    let orders: OrderRow[];
    if (inputs.orderIdentifier) {
      const match = await getOwnedOrderByIdentifier(
        db,
        workspaceOwnerId,
        inputs.orderIdentifier,
        null,
        false,
      );
      orders = match ? [match] : [];
    } else {
      if (!inputs.phone) {
        throw apiError(
          400,
          "INVALID_REQUEST",
          "Provide orderNumber, phone, or both",
        );
      }
      const result = await db.query<OrderRow>(
        `${selectOrdersSql(`
          AND ${publicOrderNumberSql} IS NOT NULL
          AND (
            lower(COALESCE(o.status, '')) NOT IN ('completed', 'cancelled', 'refunded')
            OR COALESCE(o.ordered_at, o.created_at) >= now() - INTERVAL '90 days'
          )`)}
         ORDER BY
           CASE WHEN lower(COALESCE(o.status, '')) IN ('completed', 'cancelled', 'refunded') THEN 1 ELSE 0 END,
           COALESCE(o.ordered_at, o.created_at) DESC,
           o.id DESC
         LIMIT 10`,
        [workspaceOwnerId, inputs.phoneTokens],
      );
      orders = result.rows;
    }
    const trustedIdentifierMatch = inputs.orderIdentifier !== null && orders.length === 1;
    const safeOrders = (trustedIdentifierMatch || inputs.phone !== null)
      ? orders
          .map(serializeOrder)
          .filter((order): order is NonNullable<ReturnType<typeof serializeOrder>> => order !== null)
      : orders
          .map(serializeOrderIdentification)
          .filter(
            (order): order is NonNullable<ReturnType<typeof serializeOrderIdentification>> =>
              order !== null,
          );
    const ambiguousPhoneOnly = inputs.orderIdentifier === null && orders.length > 1;
    const matchedOrder = ambiguousPhoneOnly ? null : orders[0] ?? null;
    const matchedIdentifiers = matchedOrder ? publicOrderIdentifiers(matchedOrder) : null;
    const found = matchedOrder !== null && matchedIdentifiers !== null;
    const verified = found;
    const response = {
      success: true,
      found,
      ...(found
        ? {
            order: {
              orderId: matchedIdentifiers.orderId,
              orderNumber: matchedIdentifiers.orderNumber,
              status: matchedOrder.status,
            },
          }
        : {}),
      verified,
      // Retained only for older Respond.io action mappings. Public-reference
      // lookup no longer has a separate customer-phone verification step.
      verification_required: false,
      ...(found && inputs.phone ? { customer_phone: inputs.phone } : {}),
      count: safeOrders.length,
      orders: safeOrders,
    };
    logger.info(
      {
        requestId,
        found,
        matchCount: safeOrders.length,
        matchedOrderFingerprint: identifierFingerprint(matchedIdentifiers?.orderNumber ?? null),
        status: 200,
      },
      "respondio AI order lookup completed",
    );
    res.status(200).json(response);
  } catch (error) {
    const known = error as ApiError;
    const status = known.status ?? 500;
    logger[status >= 500 ? "error" : "info"](
      {
        requestId,
        status,
        errorClass: error instanceof Error ? error.constructor.name : typeof error,
        errorMessage: error instanceof Error ? error.message : "Unknown error",
        ...(status >= 500 && error instanceof Error ? { stack: error.stack } : {}),
      },
      "respondio AI order lookup failed",
    );
    sendError(res, error);
  }
});

async function updateRespondioOrder(req: Request, res: Response): Promise<void> {
  const parsed = updateSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      code: "INVALID_REQUEST",
      error: parsed.error.issues.map((issue) => issue.message).join("; "),
    });
    return;
  }

  const workspaceOwnerId = (req as AiRequest).respondioWorkspaceOwnerId!;
  let customerPhone: string | null;
  try {
    customerPhone = mutationPhone(parsed.data);
  } catch (error) {
    sendError(res, error);
    return;
  }

  let preflight: OrderRow | null;
  try {
    preflight = await getOwnedOrderByIdentifier(
      db,
      workspaceOwnerId,
      String(req.params.orderId),
      null,
      false,
    );
  } catch (error) {
    sendError(res, error);
    return;
  }
  if (!preflight) {
    res.status(403).json({
      success: false,
      code: "ORDER_ACCESS_DENIED",
      error: "The order could not be accessed for this customer",
    });
    return;
  }

  let effectiveChanges: EffectiveChanges;
  let singleChangeType: SingleChangeType | null = null;
  let singlePreviousValue: unknown = null;
  try {
    if ("changes" in parsed.data) {
      effectiveChanges = parsed.data.changes;
    } else {
      singleChangeType = parsed.data.change_type;
      const normalized = normalizeSingleChange(parsed.data, preflight);
      effectiveChanges = normalized.changes;
      singlePreviousValue = normalized.previousValue;
    }
  } catch (error) {
    sendError(res, error);
    return;
  }

  let preparedAddress: PreparedAddress | null = null;

  const client = await db.connect();
  let changedFields: string[] = [];
  let updatedOrder: OrderRow | null = null;
  let updatedSafeOrder: NonNullable<ReturnType<typeof serializeOrder>> | null = null;
  let updatedIdentifiers: PublicOrderIdentifiers | null = null;
  let recipientContactId: string | null = null;
  let addressChanged = false;
  let scheduleChanged = false;
  let eventId: string | null = null;
  let workflowIdempotent = false;
  let workflowSavedAddress: Record<string, unknown> | null = null;
  try {
    const result = await withTransaction(client, async () => {
      const workflowRequestId = (req as AiRequest).respondioWorkflowRequestId;
      const workflowChannelId = (req as AiRequest).respondioWorkflowChannelId;
      const workflowPayloadFingerprint =
        (req as AiRequest).respondioWorkflowPayloadFingerprint;
      if (effectiveChanges.delivery_address !== undefined) {
        await lockOrderDestinationInTransaction(client, preflight!.id);
      }
      let previousWorkflowPayload: Record<string, unknown> | null = null;
      if (workflowRequestId && workflowChannelId && workflowPayloadFingerprint) {
        await client.query(
          `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
          [`respondio-address-correction:${workspaceOwnerId}:${workflowChannelId}:${workflowRequestId}`],
        );
        const previous = await client.query<{
          order_id: string;
          payload: Record<string, unknown> | null;
        }>(
          `SELECT order_id, payload
             FROM order_events
            WHERE workspace_owner_id = $1
              AND event_type = 'respondio_ai_order_updated'
              AND payload->>'source' = 'respondio_workflow_address_correction'
              AND payload->>'workflow_channel_id' = $2
              AND payload->>'workflow_request_id' = $3
            ORDER BY created_at ASC
            LIMIT 1`,
          [workspaceOwnerId, workflowChannelId, workflowRequestId],
        );
        previousWorkflowPayload = previous.rows[0]?.payload ?? null;
        if (
          previousWorkflowPayload
          && (
            previous.rows[0]?.order_id !== preflight!.id
            || previousWorkflowPayload.payload_fingerprint !== workflowPayloadFingerprint
          )
        ) {
          throw apiError(
            409,
            "IDEMPOTENCY_KEY_REUSED",
            "request_id was already used for a different address correction",
          );
        }
      }
      const order = await getOwnedOrderById(
        client,
        workspaceOwnerId,
        preflight!.id,
        true,
      );
      if (!order) {
        throw apiError(
          403,
          "ORDER_ACCESS_DENIED",
          "The order could not be accessed for this customer",
        );
      }
      if (!publicOrderIdentifiers(order)) {
        throw apiError(
          403,
          "ORDER_ACCESS_DENIED",
          "The order could not be accessed for this customer",
        );
      }
      if (previousWorkflowPayload) {
        workflowIdempotent = true;
        const previousAfter = previousWorkflowPayload.after;
        if (previousAfter && typeof previousAfter === "object") {
          const address = (previousAfter as Record<string, unknown>).delivery_address;
          if (address && typeof address === "object") {
            workflowSavedAddress = address as Record<string, unknown>;
          }
        }
        return safeMutationResult(order, null);
      }
      if (
        effectiveChanges.delivery_address !== undefined
        && !isUnchangedAddressInput(effectiveChanges.delivery_address, order)
      ) {
        preparedAddress = await prepareAddress(
          effectiveChanges.delivery_address,
          order,
          workspaceOwnerId,
        );
      }
      const before: Record<string, unknown> = {};
      const after: Record<string, unknown> = {};
      const changes = effectiveChanges;
      let nextAddress = preparedAddress?.value ?? order.delivery_address ?? {};
      let nextWindowStart = order.window_start;
      let nextWindowEnd = order.window_end;

      if (changes.card_message !== undefined) {
        const next = changes.card_message?.trim() || null;
        if (next !== order.card_message) {
          changedFields.push("card_message");
          before.card_message = order.card_message;
          after.card_message = next;
        }
      }
      if (changes.card_to !== undefined) {
        const next = changes.card_to?.trim() || null;
        if (next !== order.card_to) {
          changedFields.push("card_to");
          before.card_to = order.card_to;
          after.card_to = next;
        }
      }
      if (changes.card_from !== undefined) {
        const next = changes.card_from?.trim() || null;
        if (next !== order.card_from) {
          changedFields.push("card_from");
          before.card_from = order.card_from;
          after.card_from = next;
        }
      }

      if (preparedAddress && JSON.stringify(preparedAddress.value) !== JSON.stringify(order.delivery_address ?? {})) {
        changedFields.push("delivery_address");
        before.delivery_address = safeAddress(order.delivery_address);
        after.delivery_address = safeAddress(preparedAddress.value);
        addressChanged = true;
      }

      const requestedDate = changes.delivery_date;
      const requestedSlot = changes.delivery_slot;
      if ((requestedDate && !requestedSlot) || (!requestedDate && requestedSlot)) {
        throw apiError(
          400,
          "INVALID_DELIVERY_SCHEDULE",
          "delivery_date and delivery_slot must be supplied together",
        );
      }
      if (requestedDate && requestedSlot) {
        const requestedSlotLabel = `${requestedSlot.start_time}–${requestedSlot.end_time}`;
        const existingDate = typeof order.delivery_address?.date === "string"
          ? order.delivery_address.date
          : null;
        const existingSlot = normalizedSlotLabel(order.delivery_address?.slot);
        if (requestedDate !== existingDate || requestedSlotLabel !== existingSlot) {
          const proposed: RescheduleOrderRow = {
            ...order,
            delivery_address: nextAddress,
          };
          const context = await resolveRescheduleContext(
            client,
            workspaceOwnerId,
            proposed,
            requestedDate,
          );
          const selected = context.slots.find(
            (slot) =>
              slot.start_time === requestedSlot.start_time
              && slot.end_time === requestedSlot.end_time,
          );
          if (!selected) {
            throw apiError(
              409,
              "DELIVERY_SLOT_UNAVAILABLE",
              "The requested delivery slot is unavailable",
              { available_options: context.slots },
            );
          }
          const endDate =
            selected.end_time <= selected.start_time
              ? addOneDay(requestedDate)
              : requestedDate;
          const windowStart = zonedDateTimeToIso(
            requestedDate,
            selected.start_time,
            context.timezone,
          );
          const windowEnd = zonedDateTimeToIso(
            endDate,
            selected.end_time,
            context.timezone,
          );
          if (
            !order.window_start
            || !order.window_end
            || new Date(order.window_start).toISOString() !== windowStart
            || new Date(order.window_end).toISOString() !== windowEnd
          ) {
            scheduleChanged = true;
            changedFields.push("delivery_date", "delivery_slot");
            before.delivery_date = order.delivery_address?.date ?? null;
            before.delivery_slot = order.delivery_address?.slot ?? null;
            after.delivery_date = requestedDate;
            after.delivery_slot = requestedSlotLabel;
            nextWindowStart = windowStart;
            nextWindowEnd = windowEnd;
            nextAddress = {
              ...nextAddress,
              date: requestedDate,
              slot: requestedSlotLabel,
            };
          }
        }
      }

      let normalizedRecipientPhone: string | undefined;
      if (changes.recipient_phone !== undefined) {
        const addressCountry = nextAddress.countryCode ?? nextAddress.country;
        normalizedRecipientPhone = normalizePhoneForCountry(
          changes.recipient_phone,
          typeof addressCountry === "string" ? addressCountry : null,
        ) ?? undefined;
        if (!normalizedRecipientPhone || !isStrictE164(normalizedRecipientPhone)) {
          throw apiError(
            400,
            "INVALID_RECIPIENT_PHONE",
            "recipient_phone must be a valid phone number",
          );
        }
        if (normalizedRecipientPhone !== order.recipient_phone) {
          changedFields.push("recipient_phone");
          before.recipient_phone = order.recipient_phone;
          after.recipient_phone = normalizedRecipientPhone;
        }
      }
      if (
        changes.recipient_name !== undefined
        && changes.recipient_name !== order.recipient_name
      ) {
        changedFields.push("recipient_name");
        before.recipient_name = order.recipient_name;
        after.recipient_name = changes.recipient_name;
      }

      changedFields = [...new Set(changedFields)];
      const status = normalizedStatus(order.status);
      if (
        (changes.delivery_address !== undefined || changedFields.length > 0)
        && ["out_for_delivery", "completed", "cancelled", "refunded"].includes(status)
      ) {
        throw apiError(
          409,
          "ORDER_NOT_EDITABLE",
          "This order can no longer be edited",
        );
      }
      if (
        (changes.delivery_address !== undefined || changedFields.length > 0)
        && ["preparing", "ready_for_delivery"].includes(status)
      ) {
        throw apiError(
          409,
          "MANUAL_APPROVAL_REQUIRED",
          "This order has entered fulfillment and requires manual approval",
        );
      }
      if (changedFields.length === 0) {
        let cancelledTookanDestination = false;
        if (changes.delivery_address !== undefined) {
          cancelledTookanDestination = await reconcileAddressCollectionCorrection(client, {
            workspaceOwnerId,
            orderId: order.id,
            address: nextAddress,
            latitude: typeof nextAddress.latitude === "number"
              ? nextAddress.latitude
              : typeof nextAddress.lat === "number" ? nextAddress.lat : null,
            longitude: typeof nextAddress.longitude === "number"
              ? nextAddress.longitude
              : typeof nextAddress.lng === "number" ? nextAddress.lng : null,
            source: workflowRequestId
              ? "respondio_workflow_address_correction"
              : "respondio_ai_agent",
            workflowRequestId: workflowRequestId ?? null,
          });
        }
        if (workflowRequestId || changes.delivery_address !== undefined) {
          const receipt = await client.query<{ id: string }>(
            `INSERT INTO order_events
               (workspace_owner_id, order_id, event_type, payload, actor_name)
             VALUES ($1, $2, 'respondio_ai_order_updated', $3::jsonb,
                     $4)
             RETURNING id`,
            [
              workspaceOwnerId,
              order.id,
              JSON.stringify({
                source: workflowRequestId
                  ? "respondio_workflow_address_correction"
                  : "respondio_ai_agent",
                changed_fields: [],
                before: {},
                after: { delivery_address: safeAddress(order.delivery_address) },
                ...(workflowRequestId
                  ? {
                      workflow_request_id: workflowRequestId,
                      workflow_channel_id: workflowChannelId,
                      payload_fingerprint: workflowPayloadFingerprint,
                    }
                  : {}),
              }),
              workflowRequestId ? "Respond.io Workflow" : "Respond.io AI Agent",
            ],
          );
          const receiptId = receipt.rows[0]?.id ?? null;
          if (cancelledTookanDestination && receiptId) {
            await client.query(
              `INSERT INTO order_reschedule_jobs
                 (event_id, workspace_owner_id, order_id, order_number,
                  tookan_job_id, window_start, window_end,
                  tookan_address_payload, is_reschedule)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, false)
               ON CONFLICT (event_id) DO NOTHING`,
              [
                receiptId,
                workspaceOwnerId,
                order.id,
                publicOrderNumber(order),
                order.tookan_job_id,
                order.window_start,
                order.window_end,
                JSON.stringify(nextAddress),
              ],
            );
          }
          return safeMutationResult(order, receiptId);
        }
        return safeMutationResult(order, null);
      }

      await client.query(
        `UPDATE orders
            SET card_message = CASE WHEN $3::boolean THEN $4 ELSE card_message END,
                delivery_address = CASE WHEN $5::boolean THEN $6::jsonb ELSE delivery_address END,
                delivery_instructions = CASE WHEN $7::boolean THEN $8 ELSE delivery_instructions END,
                window_start = CASE WHEN $9::boolean THEN $10::timestamptz ELSE window_start END,
                window_end = CASE WHEN $9::boolean THEN $11::timestamptz ELSE window_end END,
                delivery_date_review = CASE WHEN $9::boolean THEN NULL ELSE delivery_date_review END,
                 card_to = CASE WHEN $12::boolean THEN $13 ELSE card_to END,
                 card_from = CASE WHEN $14::boolean THEN $15 ELSE card_from END,
                updated_at = now()
          WHERE id = $1 AND workspace_owner_id = $2`,
        [
          order.id,
          workspaceOwnerId,
          changes.card_message !== undefined,
          changes.card_message?.trim() || null,
          addressChanged || scheduleChanged,
          JSON.stringify(nextAddress),
          preparedAddress != null
            && typeof addressInputRecord(changes.delivery_address!).instructions === "string",
          preparedAddress != null
            ? addressInputRecord(changes.delivery_address!).instructions ?? null
            : null,
          scheduleChanged,
          nextWindowStart,
          nextWindowEnd,
          changes.card_to !== undefined,
          changes.card_to?.trim() || null,
          changes.card_from !== undefined,
          changes.card_from?.trim() || null,
        ],
      );

      if (scheduleChanged) {
        await client.query(
          `UPDATE fleet_driver_order_assignments
              SET scheduled_at = $1, updated_at = now()
            WHERE order_id = $2 AND workspace_owner_id = $3`,
          [nextWindowStart, order.id, workspaceOwnerId],
        );
      }

      recipientContactId = order.recipient_contact_id;
      if (
        changedFields.includes("recipient_name")
        || changedFields.includes("recipient_phone")
      ) {
        const existingPhoneContact = normalizedRecipientPhone
          ? await client.query<{ id: string; display_name: string | null }>(
              `SELECT id, display_name
                 FROM contacts
                WHERE workspace_owner_id = $1
                  AND phone = $2
                LIMIT 1
                FOR UPDATE`,
              [workspaceOwnerId, normalizedRecipientPhone],
            )
          : null;
        const reusableContact = existingPhoneContact?.rows[0] ?? null;
        if (reusableContact && reusableContact.id !== recipientContactId) {
          if (
            changes.recipient_name !== undefined
            && changes.recipient_name !== reusableContact.display_name
          ) {
            throw apiError(
              409,
              "MANUAL_APPROVAL_REQUIRED",
              "The existing recipient contact has a different name and requires manual approval",
            );
          }
          const relinked = await client.query(
            `UPDATE order_contacts
                SET contact_id = $1
              WHERE order_id = $2 AND role = 'recipient'`,
            [reusableContact.id, order.id],
          );
          if ((relinked.rowCount ?? 0) === 0) {
            await client.query(
              `INSERT INTO order_contacts (order_id, contact_id, role)
               VALUES ($1, $2, 'recipient')`,
              [order.id, reusableContact.id],
            );
          }
          recipientContactId = reusableContact.id;
        } else {
        let mustCloneRecipient = false;
        if (recipientContactId) {
          const shared = await client.query<{ shared: boolean }>(
            `SELECT EXISTS (
               SELECT 1
                 FROM order_contacts
                WHERE contact_id = $1
                  AND (order_id <> $2 OR role <> 'recipient')
             ) AS shared`,
            [recipientContactId, order.id],
          );
          mustCloneRecipient = shared.rows[0]?.shared === true;
          if (
            mustCloneRecipient
            && !changedFields.includes("recipient_phone")
          ) {
            throw apiError(
              409,
              "MANUAL_APPROVAL_REQUIRED",
              "This recipient contact is shared and requires manual approval",
            );
          }
        }
        if (mustCloneRecipient) {
          const recipientPhoneTokens = normalizedRecipientPhone
            ? buildPhoneSearchTokens(normalizedRecipientPhone)
            : [];
          const inserted = await client.query<{ id: string }>(
            `INSERT INTO contacts
               (workspace_owner_id, source, is_guest, display_name, phone,
                phone_search_tokens, updated_at)
             VALUES ($1, 'respondio_ai_agent', true, $2, $3, $4::text[], now())
             RETURNING id`,
            [
              workspaceOwnerId,
              changes.recipient_name ?? order.recipient_name,
              normalizedRecipientPhone,
              recipientPhoneTokens,
            ],
          );
          recipientContactId = inserted.rows[0]?.id ?? null;
          if (!recipientContactId) {
            throw apiError(500, "TEMPORARILY_UNAVAILABLE", "Recipient update failed");
          }
          await client.query(
            `UPDATE order_contacts
                SET contact_id = $1
              WHERE order_id = $2 AND role = 'recipient'`,
            [recipientContactId, order.id],
          );
        } else if (recipientContactId) {
          const recipientPhoneTokens = normalizedRecipientPhone
            ? buildPhoneSearchTokens(normalizedRecipientPhone)
            : [];
          await client.query(
            `UPDATE contacts
                SET display_name = CASE WHEN $3::boolean THEN $4 ELSE display_name END,
                    phone = CASE WHEN $5::boolean THEN $6 ELSE phone END,
                    phone_search_tokens = CASE WHEN $5::boolean THEN $7::text[] ELSE phone_search_tokens END,
                    updated_at = now()
              WHERE id = $1 AND workspace_owner_id = $2`,
            [
              recipientContactId,
              workspaceOwnerId,
              changes.recipient_name !== undefined,
              changes.recipient_name ?? null,
              normalizedRecipientPhone !== undefined,
              normalizedRecipientPhone ?? null,
              recipientPhoneTokens,
            ],
          );
        } else {
          const recipientPhoneTokens = normalizedRecipientPhone
            ? buildPhoneSearchTokens(normalizedRecipientPhone)
            : [];
          const inserted = await client.query<{ id: string }>(
            `INSERT INTO contacts
               (workspace_owner_id, source, is_guest, display_name, phone,
                phone_search_tokens, updated_at)
             VALUES ($1, 'respondio_ai_agent', true, $2, $3, $4::text[], now())
             RETURNING id`,
            [
              workspaceOwnerId,
              changes.recipient_name ?? null,
              normalizedRecipientPhone ?? null,
              recipientPhoneTokens,
            ],
          );
          recipientContactId = inserted.rows[0]?.id ?? null;
          if (recipientContactId) {
            await client.query(
              `INSERT INTO order_contacts (order_id, contact_id, role)
               VALUES ($1, $2, 'recipient')`,
              [order.id, recipientContactId],
            );
          }
        }
        }
      }

      const event = await client.query<{ id: string }>(
        `INSERT INTO order_events
           (workspace_owner_id, order_id, event_type, payload, actor_name)
         VALUES ($1, $2, 'respondio_ai_order_updated', $3::jsonb, 'Respond.io AI Agent')
         RETURNING id`,
        [
          workspaceOwnerId,
          order.id,
          JSON.stringify({
            source: workflowRequestId
              ? "respondio_workflow_address_correction"
              : "respondio_ai_agent",
            customer_phone: customerPhone,
            changed_fields: changedFields,
            before,
            after,
            ...(workflowRequestId
              ? {
                  workflow_request_id: workflowRequestId,
                  workflow_channel_id: workflowChannelId,
                  payload_fingerprint: workflowPayloadFingerprint,
                }
              : {}),
          }),
        ],
      );
      const newEventId = event.rows[0]?.id ?? null;
      if ((scheduleChanged || addressChanged) && newEventId) {
        await client.query(
          `INSERT INTO order_reschedule_jobs
             (event_id, workspace_owner_id, order_id, order_number, tookan_job_id,
              window_start, window_end, tookan_address_payload, is_reschedule)
           VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8::jsonb, $9)`,
          [
            newEventId,
            workspaceOwnerId,
            order.id,
            publicOrderNumber(order),
            order.tookan_job_id,
            nextWindowStart,
            nextWindowEnd,
            addressChanged && preparedAddress
              ? JSON.stringify({
                  address: preparedAddress.text,
                  latitude: preparedAddress.latitude,
                  longitude: preparedAddress.longitude,
                })
              : null,
            scheduleChanged,
          ],
        );
      }
      const fresh = await getOwnedOrderById(
        client,
        workspaceOwnerId,
        order.id,
      );
      const finalOrder = fresh ?? order;
      if (addressChanged) {
        await reconcileAddressCollectionCorrection(client, {
          workspaceOwnerId,
          orderId: order.id,
          address: nextAddress,
          latitude: preparedAddress?.latitude ?? null,
          longitude: preparedAddress?.longitude ?? null,
          source: workflowRequestId
            ? "respondio_workflow_address_correction"
            : "respondio_ai_agent",
          workflowRequestId: workflowRequestId ?? null,
        });
      }
      return safeMutationResult(finalOrder, newEventId);
    });
    updatedOrder = result.order;
    updatedSafeOrder = result.safeOrder;
    updatedIdentifiers = result.identifiers;
    eventId = result.eventId;
  } catch (error) {
    const pgError = error as { code?: string };
    if (pgError.code === "23505") {
      sendError(
        res,
        apiError(
          409,
          "RECIPIENT_PHONE_CONFLICT",
          "That recipient phone is already linked to another contact",
        ),
      );
    } else {
      sendError(res, error);
    }
    return;
  } finally {
    client.release();
  }

  const committedAddress = preparedAddress as PreparedAddress | null;
  if (eventId) {
    if (recipientContactId && (
      changedFields.includes("recipient_name")
      || changedFields.includes("recipient_phone")
    )) {
      queueGenderInference(recipientContactId);
      void syncContactToRespondIo(recipientContactId).catch((error) => {
        logger.warn({ error, recipientContactId }, "respondio AI: recipient sync failed");
      });
    }
    if (addressChanged && committedAddress) {
      void linkOrderToAddressBook(
        updatedOrder!.id,
        workspaceOwnerId,
        committedAddress.value,
      );
      void cancelAddressCollectionForOrder(
        updatedOrder!.id,
        "delivery address supplied through Respond.io AI order update",
      );
    }
    if (scheduleChanged || addressChanged) {
      void processPendingOrderRescheduleJobs().catch((error) => {
        logger.warn({ error, orderId: updatedOrder?.id }, "respondio AI: reschedule effects queued");
      });
    }
  }

  res.json({
    success: true,
    changed: changedFields.length > 0,
    saved: true,
    processing: false,
    status: "saved",
    changed_fields: changedFields,
    idempotent: workflowIdempotent || changedFields.length === 0,
    order_id: updatedIdentifiers!.orderId,
    order_number: updatedIdentifiers!.orderNumber,
    ...(singleChangeType
      ? {
          change_type: singleChangeType,
          previous_value: singlePreviousValue,
          new_value: singleChangeResultValue(singleChangeType, updatedOrder),
        }
      : {}),
    order: updatedSafeOrder,
    ...(effectiveChanges.delivery_address !== undefined
      ? {
          delivery_address:
            workflowSavedAddress ?? updatedSafeOrder?.delivery_address ?? null,
        }
      : {}),
  });
}

router.patch("/respondio/ai/orders/:orderId", updateRespondioOrder);

router.post("/respondio/workflows/order-address-change", async (req: Request, res: Response) => {
  if (!verifyRespondioWorkflowSignature(req)) {
    res.status(401).json({
      success: false,
      saved: false,
      processing: false,
      status: "rejected",
      code: "UNAUTHORIZED",
      error: "A valid Respond.io webhook signature is required",
    });
    return;
  }
  let payload: unknown = req.body;
  if (Buffer.isBuffer(payload)) {
    try {
      payload = JSON.parse(payload.toString("utf8"));
    } catch {
      payload = null;
    }
  }
  const parsed = workflowAddressCorrectionSchema.safeParse(payload ?? {});
  if (!parsed.success) {
    res.status(400).json({
      success: false,
      saved: false,
      processing: false,
      status: "rejected",
      code: "INVALID_REQUEST",
      error: parsed.error.issues.map((issue) => issue.message).join("; "),
    });
    return;
  }
  const channelId = (req.get("x-respondio-channel-id") ?? "").trim();
  if (!channelId) {
    res.status(400).json({
      success: false,
      saved: false,
      processing: false,
      status: "rejected",
      code: "RESPONDIO_CHANNEL_REQUIRED",
      error: "X-Respondio-Channel-Id is required",
    });
    return;
  }
  if (parsed.data.channel_id !== channelId) {
    res.status(400).json({
      success: false,
      saved: false,
      processing: false,
      status: "rejected",
      code: "RESPONDIO_CHANNEL_MISMATCH",
      error: "The signed channel_id must match X-Respondio-Channel-Id",
    });
    return;
  }
  try {
    (req as AiRequest).respondioWorkspaceOwnerId =
      await resolveRespondioWorkspace(channelId);
  } catch (error) {
    sendError(res, error);
    return;
  }
  req.params.orderId = String(parsed.data.order_id);
  (req as AiRequest).respondioWorkflowRequestId = parsed.data.request_id;
  (req as AiRequest).respondioWorkflowChannelId = channelId;
  (req as AiRequest).respondioWorkflowPayloadFingerprint =
    fallbackAddressFingerprint(parsed.data.delivery_address);
  req.body = {
    changes: { delivery_address: parsed.data.delivery_address },
  };
  await updateRespondioOrder(req, res);
});

export default router;