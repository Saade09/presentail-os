import { createHash } from "node:crypto";
import { db, withTransaction } from "./db";
import { logger } from "./logger";
import { sendSupplierStatementEmail } from "./email";
import { formatSupplierStatementDate } from "./supplierStatementFormatting";
import { objectStorageClient } from "./objectStorage";
import {
  findOrCreateContactByPhone,
  normalizePhoneForCountry,
  sendWhatsAppTemplateToContact,
  setContactCustomAttributes,
} from "./respondio";

export { sendSupplierStatementEmail } from "./email";

export const SUPPLIER_STATEMENT_WHATSAPP_TEMPLATE = "supplier_statement_request";
const SUPPLIER_STATEMENT_NAMESPACE = "supplier_statement_collection";

function supplierStatementInboundAddress(): string | null {
  const configured = process.env.SUPPLIER_STATEMENT_RESEND_INBOUND_ADDRESS?.trim();
  if (!configured || !/^[a-z0-9._%+-]+@[a-z0-9.-]+$/i.test(configured)) return null;
  return configured.toLowerCase();
}

export function supplierStatementInboundConfigured(): boolean {
  return Boolean(supplierStatementInboundAddress());
}

export function isSupplierStatementReceivingAddress(addresses: string[]): boolean {
  const configured = supplierStatementInboundAddress();
  return Boolean(configured && addresses.some((address) => normalizedEmailAddress(address) === configured));
}

export function isSupplierStatementPayload(payload: unknown, includeContactAttributes = true): boolean {
  const root = object(payload);
  if (!root) return false;
  const data = object(root.data) ?? root;
  const contact = object(data.contact) ?? object(root.contact);
  const message = object(data.message) ?? data;
  const content = object(message.message) ?? object(message.content);
  const tags = Array.isArray(data.tags) ? data.tags : [];
  const tagMap = object(data.tags);
  const taggedNamespace = tags
    .map((tag) => object(tag))
    .find((tag) =>
      String(tag?.name ?? "").toLowerCase() === "namespace"
      && String(tag?.value ?? "").trim() === SUPPLIER_STATEMENT_NAMESPACE,
    );
  const values = [
    root.namespace,
    root.supplier_statement_namespace,
    data.namespace,
    data.supplier_statement_namespace,
    data.collection_namespace,
    ...(includeContactAttributes ? [
      contact?.supplier_statement_namespace,
      contact?.supplierStatementNamespace,
      object(contact?.customAttributes)?.supplier_statement_namespace,
      object(contact?.custom_attributes)?.supplier_statement_namespace,
      object(contact?.customFields)?.supplier_statement_namespace,
    ] : []),
    message.supplier_statement_namespace,
    content?.supplier_statement_namespace,
    tagMap?.namespace,
  ];
  return Boolean(taggedNamespace) || values.some((value) =>
    String(value ?? "").trim() === SUPPLIER_STATEMENT_NAMESPACE);
}

export type SupplierStatementReadiness = {
  email: {
    configured: boolean;
    deliveryWebhook: boolean;
    inbound: boolean;
    replyDomain: string | null;
    missing: string[];
  };
  whatsapp: {
    configured: boolean;
    incomingWebhook: boolean;
    statusWebhook: boolean;
    template: typeof SUPPLIER_STATEMENT_WHATSAPP_TEMPLATE;
    missing: string[];
  };
};

export function supplierStatementProviderReadiness(): SupplierStatementReadiness {
  const replyDomain = supplierStatementInboundAddress();
  const emailMissing: string[] = [];
  if (!process.env.RESEND_API_KEY) emailMissing.push("RESEND_API_KEY");
  if (!process.env.RESEND_WEBHOOK_SECRET) emailMissing.push("RESEND_WEBHOOK_SECRET");
  if (!supplierStatementInboundConfigured()) {
    emailMissing.push("SUPPLIER_STATEMENT_RESEND_INBOUND_ADDRESS");
  }
  const whatsappMissing: string[] = [];
  if (!process.env.RESPONDIO_API_TOKEN) whatsappMissing.push("RESPONDIO_API_TOKEN");
  if (!process.env.RESPONDIO_INCOMING_WEBHOOK_SECRET) {
    whatsappMissing.push("RESPONDIO_INCOMING_WEBHOOK_SECRET");
  }
  if (!process.env.RESPONDIO_STATUS_WEBHOOK_SECRET) {
    whatsappMissing.push("RESPONDIO_STATUS_WEBHOOK_SECRET");
  }
  return {
    email: {
      configured: Boolean(process.env.RESEND_API_KEY),
      deliveryWebhook: Boolean(process.env.RESEND_WEBHOOK_SECRET),
      inbound: Boolean(
        process.env.RESEND_API_KEY
        && process.env.RESEND_WEBHOOK_SECRET
        && supplierStatementInboundConfigured(),
      ),
      replyDomain,
      missing: emailMissing,
    },
    whatsapp: {
      configured: Boolean(process.env.RESPONDIO_API_TOKEN),
      incomingWebhook: Boolean(process.env.RESPONDIO_INCOMING_WEBHOOK_SECRET),
      statusWebhook: Boolean(process.env.RESPONDIO_STATUS_WEBHOOK_SECRET),
      template: SUPPLIER_STATEMENT_WHATSAPP_TEMPLATE,
      missing: whatsappMissing,
    },
  };
}

export type SupplierStatementWhatsAppOptions = {
  requestId: string;
  stepId: string;
  supplierContactId: number;
  contactName: string;
  phone: string;
  entityName: string;
  periodStart: string;
  periodEnd: string;
};

export type SupplierStatementTransportResult =
  | {
      ok: true;
      providerMessageId: string | null;
      providerContactId: string;
      providerChannelId: string | null;
      destination: string;
      renderedVariables: string[];
      providerStatus: "accepted";
    }
  | {
      ok: false;
      retryable: boolean;
      errorCode: string;
      errorMessage: string;
    };

function splitName(name: string): { firstName: string; lastName: string | null } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] ?? name.trim(),
    lastName: parts.length > 1 ? parts.slice(1).join(" ") : null,
  };
}

/** Dedicated supplier/accounting Respond.io transport. */
export async function sendSupplierStatementWhatsApp(
  options: SupplierStatementWhatsAppOptions,
): Promise<SupplierStatementTransportResult> {
  const destination = normalizePhoneForCountry(options.phone);
  if (!destination) {
    return {
      ok: false,
      retryable: false,
      errorCode: "invalid_phone",
      errorMessage: "Supplier contact phone is not a valid E.164 number",
    };
  }
  const name = splitName(options.contactName);
  const providerContactId = await findOrCreateContactByPhone(
    destination,
    name.firstName,
    name.lastName,
  );
  if (!providerContactId || providerContactId === "phone_format_invalid") {
    return {
      ok: false,
      retryable: false,
      errorCode: providerContactId === "phone_format_invalid"
        ? "invalid_phone"
        : "provider_unavailable",
      errorMessage: providerContactId === "phone_format_invalid"
        ? "Supplier contact phone is not a valid E.164 number"
        : "Respond.io contact could not be found or created",
    };
  }

  // This namespace is intentionally separate from customer support, Natasha,
  // and address collection attributes. It gives Workflow callbacks a strong
  // correlation hint without making them eligible for another product flow.
  await setContactCustomAttributes(providerContactId, {
    supplier_statement_namespace: SUPPLIER_STATEMENT_NAMESPACE,
    supplier_statement_request_id: options.requestId,
    supplier_statement_step_id: options.stepId,
    supplier_statement_contact_id: options.supplierContactId,
  });

  const renderedVariables = [
    options.contactName,
    options.entityName,
    formatSupplierStatementDate(options.periodStart),
    formatSupplierStatementDate(options.periodEnd),
  ];
  const rawChannelId = process.env.RESPONDIO_CHANNEL_ID?.trim();
  const channelId = rawChannelId && /^\d+$/.test(rawChannelId) ? Number(rawChannelId) : null;
  const result = await sendWhatsAppTemplateToContact(providerContactId, {
    templateName: SUPPLIER_STATEMENT_WHATSAPP_TEMPLATE,
    languageCode: process.env.SUPPLIER_STATEMENT_WHATSAPP_LANGUAGE?.trim() || "en",
    bodyParameters: renderedVariables,
    channelId,
  });
  if (!result.ok) return result;
  return {
    ok: true,
    providerMessageId: result.providerRef,
    providerContactId,
    providerChannelId: channelId == null ? null : String(channelId),
    destination,
    renderedVariables,
    providerStatus: "accepted",
  };
}

export function supplierStatementReplyAddress(requestId: string): string | null {
  void requestId;
  return supplierStatementInboundAddress();
}

export function renderSupplierStatementMessage(
  template: string | null | undefined,
  values: {
    supplierName: string;
    contactName: string;
    entityName: string;
    periodStart: string;
    periodEnd: string;
    periodLabel: string;
  },
): string {
  const source = template?.trim() || "Hello {{contact_name}}, please send the supplier statement for {{entity_name}} covering {{period_start}} to {{period_end}}.";
  return source.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_match, key: string) => {
    const map: Record<string, string> = {
      supplier_name: values.supplierName,
      contact_name: values.contactName,
      entity_name: values.entityName,
      period_start: values.periodStart,
      period_end: values.periodEnd,
      period_label: values.periodLabel,
    };
    return map[key.toLowerCase()] ?? "";
  });
}

export function supplierStatementEmailIdempotencyHeader(idempotencyKey: string): string {
  return createHash("sha256").update(idempotencyKey).digest("hex");
}

/** Close a request and cancel every remaining step in one transaction. */
export async function markSupplierStatementReceivedById(
  requestId: string,
  workspaceOwnerId: string,
  actorId: string,
  metadata: Record<string, unknown> = {},
): Promise<boolean> {
  const client = await db.connect();
  try {
    return await withTransaction(client, async () => {
      const request = await client.query<{ id: string }>(
        `SELECT id FROM supplier_statement_requests
          WHERE id=$1 AND workspace_owner_id=$2
            AND status NOT IN ('received','reconciled','cancelled')
          FOR UPDATE`,
        [requestId, workspaceOwnerId],
      );
      if (!request.rows[0]) return false;
      await client.query(
        `UPDATE supplier_statement_requests
            SET status='received', next_action='reconcile', next_action_at=NULL,
                received_at=COALESCE(received_at,now()), updated_at=now()
          WHERE id=$1 AND workspace_owner_id=$2`,
        [requestId, workspaceOwnerId],
      );
      await client.query(
        `UPDATE supplier_statement_step_executions
            SET status=CASE WHEN status IN ('pending','processing') THEN 'cancelled' ELSE status END,
                updated_at=now()
          WHERE request_id=$1 AND workspace_owner_id=$2
            AND status IN ('pending','processing')`,
        [requestId, workspaceOwnerId],
      );
      await client.query(
        `INSERT INTO supplier_statement_audit_events
          (workspace_owner_id, entity_type, entity_id, action, actor_id, metadata)
         VALUES ($1,'request',$2,'statement_received',$3,$4::jsonb)`,
        [workspaceOwnerId, requestId, actorId, JSON.stringify(metadata)],
      );
      await client.query(
        `INSERT INTO supplier_statement_communication_events
          (request_id, workspace_owner_id, event_type, payload)
         VALUES ($1,$2,'statement_received',$3::jsonb)`,
        [requestId, workspaceOwnerId, JSON.stringify(metadata)],
      );
      return true;
    });
  } finally {
    client.release();
  }
}

type ProviderPayload = Record<string, unknown>;

function object(value: unknown): ProviderPayload | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as ProviderPayload
    : null;
}

function text(...values: unknown[]): string | null {
  for (const value of values) {
    if ((typeof value === "string" || typeof value === "number") && String(value).trim()) {
      return String(value).trim();
    }
  }
  return null;
}

function providerParts(payload: unknown): {
  root: ProviderPayload;
  data: ProviderPayload;
  message: ProviderPayload;
  content: ProviderPayload | null;
  contact: ProviderPayload | null;
  sender: ProviderPayload | null;
  channel: ProviderPayload | null;
} | null {
  const root = object(payload);
  if (!root) return null;
  const data = object(root.data) ?? root;
  const message = object(data.message) ?? data;
  return {
    root,
    data,
    message,
    content: object(message.message) ?? object(message.content),
    contact: object(data.contact) ?? object(root.contact),
    sender: object(message.sender) ?? object(data.sender),
    channel: object(data.channel) ?? object(root.channel),
  };
}

function providerEventId(parts: ReturnType<typeof providerParts>): string | null {
  if (!parts) return null;
  return text(parts.root.event_id, parts.root.eventId, parts.data.event_id, parts.data.eventId);
}

function providerMessageId(parts: ReturnType<typeof providerParts>): string | null {
  if (!parts) return null;
  return text(
    parts.message.messageId,
    parts.message.message_id,
    parts.message.id,
    parts.data.messageId,
    parts.data.message_id,
  );
}

function providerStatus(payload: unknown): string | null {
  const parts = providerParts(payload);
  if (!parts) return null;
  return text(
    parts.root.status,
    parts.root.message_status,
    parts.data.status,
    parts.data.messageStatus,
    parts.message.status,
  )?.toLowerCase() ?? null;
}

function providerTimestamp(payload: unknown): Date {
  const parts = providerParts(payload);
  const value = parts && text(
    parts.root.timestamp,
    parts.root.created_at,
    parts.data.timestamp,
    parts.message.timestamp,
    parts.message.createdAt,
  );
  const date = value ? new Date(value) : new Date();
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function extractAttachments(parts: NonNullable<ReturnType<typeof providerParts>>): Array<Record<string, unknown>> {
  const candidates: unknown[] = [
    parts.content?.attachments,
    parts.message.attachments,
    parts.data.attachments,
    parts.content,
  ];
  const result: Array<Record<string, unknown>> = [];
  for (const candidate of candidates) {
    const values = Array.isArray(candidate) ? candidate : [candidate];
    for (const value of values) {
      const item = object(value);
      if (!item) continue;
      const url = text(item.url, item.link, item.href, object(item.file)?.url);
      const type = text(item.type, item.mimeType, item.mime_type, object(item.file)?.mimeType);
      const name = text(item.name, item.fileName, item.file_name, object(item.file)?.name);
      if (url || type || name) result.push({ url, type, name });
    }
  }
  return result.slice(0, 20);
}

function parseInboundPayload(payload: unknown): {
  providerMessageId: string | null;
  providerEventId: string | null;
  providerContactId: string | null;
  providerConversationId: string | null;
  providerChannelId: string | null;
  inReplyToProviderMessageId: string | null;
  sender: string | null;
  senderPhone: string | null;
  body: string | null;
  attachments: Array<Record<string, unknown>>;
  occurredAt: Date;
} | null {
  const parts = providerParts(payload);
  if (!parts) return null;
  const context = object(parts.message.context) ?? object(parts.message.replyTo) ?? object(parts.data.context);
  return {
    providerMessageId: providerMessageId(parts),
    providerEventId: providerEventId(parts),
    providerContactId: text(parts.contact?.id, parts.contact?.contactId, parts.data.contactId),
    providerConversationId: text(parts.message.conversationId, parts.data.conversationId, parts.root.conversationId),
    providerChannelId: text(parts.channel?.id, parts.channel?.channelId, parts.message.channelId, parts.data.channelId, parts.root.channelId),
    inReplyToProviderMessageId: text(
      parts.message.replyToMessageId,
      parts.message.reply_to_message_id,
      context?.messageId,
      context?.message_id,
      context?.id,
    ),
    sender: text(parts.contact?.name, parts.sender?.name, parts.message.from, parts.data.from),
    senderPhone: text(
      parts.contact?.phone,
      parts.contact?.phoneNumber,
      parts.sender?.phone,
      parts.sender?.phoneNumber,
      parts.data.from,
      parts.message.from,
    ),
    body: text(parts.content?.text, parts.content?.body, parts.message.text, parts.message.body, parts.data.text),
    attachments: extractAttachments(parts),
    occurredAt: providerTimestamp(payload),
  };
}

type MatchedRequest = {
  request_id: string;
  workspace_owner_id: string;
  supplier_id: number;
  finance_entity_id: number;
  period_start: string;
  period_end: string;
  status: string;
  step_id: number | null;
};

async function matchSupplierStatementRequest(input: {
  providerMessageId: string | null;
  inReplyToProviderMessageId: string | null;
  providerContactId: string | null;
  providerChannelId: string | null;
  allowContactFallback?: boolean;
}): Promise<MatchedRequest | null> {
  const exactRef = input.inReplyToProviderMessageId;
  if (exactRef) {
    const exact = await db.query<MatchedRequest>(
      `SELECT r.id AS request_id, r.workspace_owner_id, r.supplier_id, r.finance_entity_id,
              r.period_start, r.period_end, r.status, e.id AS step_id
         FROM supplier_statement_step_executions e
         JOIN supplier_statement_requests r ON r.id=e.request_id
        WHERE (e.provider_message_id=$1 OR e.correlation_id=$1)
          AND r.status NOT IN ('received','reconciled','cancelled')
        LIMIT 2`,
      [exactRef],
    );
    if (exact.rows.length === 1) return exact.rows[0];
  }
  if (!input.allowContactFallback || !input.providerContactId) return null;
  const candidates = await db.query<MatchedRequest>(
    `SELECT r.id AS request_id, r.workspace_owner_id, r.supplier_id, r.finance_entity_id,
            r.period_start, r.period_end, r.status, e.id AS step_id
       FROM supplier_statement_step_executions e
       JOIN supplier_statement_requests r ON r.id=e.request_id
      WHERE e.provider_contact_id=$1
        AND ($2::text IS NULL OR e.provider_channel_id=$2)
        AND r.status NOT IN ('received','reconciled','cancelled')
      ORDER BY r.created_at DESC
      LIMIT 2`,
    [input.providerContactId, input.providerChannelId],
  );
  return candidates.rows.length === 1 ? candidates.rows[0] : null;
}

export type ResendReceivedEmailAttachment = {
  id: string;
  filename: string | null;
  size: number;
  content_type: string;
  content_disposition: string | null;
  content_id: string | null;
  bytes?: Buffer;
  download_error?: string;
};

export type ResendReceivedEmail = {
  id: string;
  to: string[];
  from: string;
  created_at: string;
  subject: string;
  cc: string[] | null;
  bcc: string[] | null;
  reply_to: string[] | null;
  html: string | null;
  text: string | null;
  headers: Record<string, string> | null;
  message_id: string;
  attachments: ResendReceivedEmailAttachment[];
};

type ResendEmailMatch =
  | { kind: "matched"; request: MatchedRequest; senderApproved: boolean; correlation: string }
  | { kind: "ambiguous"; requestIds: string[] }
  | { kind: "none" };

function normalizedEmailAddress(raw: string): string {
  const angle = raw.match(/<([^>]+)>/);
  return (angle?.[1] ?? raw).trim().toLowerCase();
}

function requestIdFromDestination(raw: string): string | null {
  const match = raw.match(/\+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@/i);
  return match?.[1] ?? null;
}

function headerValue(headers: Record<string, string> | null, name: string): string | null {
  if (!headers) return null;
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  const value = key ? headers[key] : null;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function emailCorrelationRefs(email: ResendReceivedEmail, providerEmailId: string): string[] {
  const references = [
    providerEmailId,
    email.message_id,
    headerValue(email.headers, "in-reply-to"),
    ...(headerValue(email.headers, "references")?.split(/\s+/) ?? []),
  ];
  return [...new Set(references.filter((value): value is string => Boolean(value && value.trim())))];
}

async function matchSupplierStatementEmailRequest(input: {
  email: ResendReceivedEmail;
  providerEmailId: string;
}): Promise<ResendEmailMatch> {
  const sender = normalizedEmailAddress(input.email.from);
  const receivingAddress = supplierStatementInboundAddress();
  // Resend receives mail for other products too. Never infer supplier intent
  // from a sender or subject on an unrelated mailbox.
  if (!receivingAddress || !isSupplierStatementReceivingAddress(input.email.to)) {
    return { kind: "none" };
  }
  const destinationRequestId = input.email.to
    .map(requestIdFromDestination)
    .find((value): value is string => Boolean(value))
    ?? input.email.subject.match(/\[Statement ref: ([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\]/i)?.[1]
    ?? null;

  if (destinationRequestId) {
    const exact = await db.query<MatchedRequest & { sender_approved: boolean }>(
      `SELECT r.id AS request_id, r.workspace_owner_id, r.supplier_id, r.finance_entity_id,
              r.period_start, r.period_end, r.status, NULL::integer AS step_id,
              EXISTS (
                SELECT 1
                  FROM supplier_statement_contacts c
                 WHERE c.workspace_owner_id=r.workspace_owner_id
                   AND c.supplier_id=r.supplier_id
                   AND c.is_active=true AND c.is_approved=true
                   AND lower(c.email)=lower($2)
                   AND c.id = ANY(
                     SELECT (item->>'id')::int
                       FROM jsonb_array_elements(r.recipients_snapshot) item
                   )
              ) AS sender_approved
         FROM supplier_statement_requests r
        WHERE r.id=$1 AND r.status NOT IN ('received','reconciled','cancelled')
        LIMIT 1`,
      [destinationRequestId, sender],
    );
    if (exact.rows[0] && exact.rows[0].sender_approved) {
      return {
        kind: "matched",
        request: exact.rows[0],
        senderApproved: exact.rows[0].sender_approved,
        correlation: "reply_address",
      };
    }
    return { kind: "none" };
  }

  const refs = emailCorrelationRefs(input.email, input.providerEmailId);
  const correlated = await db.query<MatchedRequest>(
    `SELECT DISTINCT ON (r.id) r.id AS request_id, r.workspace_owner_id, r.supplier_id, r.finance_entity_id,
            r.period_start, r.period_end, r.status, e.id AS step_id
       FROM supplier_statement_step_executions e
       JOIN supplier_statement_requests r ON r.id=e.request_id
      WHERE r.status NOT IN ('received','reconciled','cancelled')
        AND e.provider_message_id = ANY($1::text[])
        AND EXISTS (
          SELECT 1 FROM supplier_statement_contacts c
           WHERE c.workspace_owner_id=r.workspace_owner_id AND c.supplier_id=r.supplier_id
             AND c.is_active=true AND c.is_approved=true AND lower(c.email)=lower($2)
             AND c.id = ANY(SELECT (item->>'id')::int FROM jsonb_array_elements(r.recipients_snapshot) item)
        )
      ORDER BY r.id, e.id DESC
      LIMIT 3`,
    [refs, sender],
  );
  if (correlated.rows.length === 1) {
    return { kind: "matched", request: correlated.rows[0], senderApproved: true, correlation: "provider_reference" };
  }
  if (correlated.rows.length > 1) {
    return { kind: "ambiguous", requestIds: correlated.rows.map((row) => row.request_id) };
  }

  const senderCandidates = await db.query<MatchedRequest>(
    `SELECT r.id AS request_id, r.workspace_owner_id, r.supplier_id, r.finance_entity_id,
            r.period_start, r.period_end, r.status, NULL::integer AS step_id
       FROM supplier_statement_requests r
      WHERE r.status NOT IN ('received','reconciled','cancelled')
        AND EXISTS (
          SELECT 1
            FROM supplier_statement_contacts c
           WHERE c.workspace_owner_id=r.workspace_owner_id
             AND c.supplier_id=r.supplier_id
             AND c.is_active=true AND c.is_approved=true
             AND lower(c.email)=lower($1)
             AND c.id = ANY(
               SELECT (item->>'id')::int
                 FROM jsonb_array_elements(r.recipients_snapshot) item
             )
        )
      ORDER BY r.created_at DESC
      LIMIT 3`,
    [sender],
  );
  if (senderCandidates.rows.length === 1) {
    return { kind: "matched", request: senderCandidates.rows[0], senderApproved: true, correlation: "approved_sender" };
  }
  if (senderCandidates.rows.length > 1) {
    return { kind: "ambiguous", requestIds: senderCandidates.rows.map((row) => row.request_id) };
  }
  return { kind: "none" };
}

function exactPeriodEvidence(value: string, periodStart: string, periodEnd: string): boolean {
  const normalized = value.toLowerCase();
  return normalized.includes(periodStart.toLowerCase())
    && normalized.includes(periodEnd.toLowerCase());
}

async function storeResendAttachment(
  bytes: Buffer,
  workspaceOwnerId: string,
  filename: string,
  contentType: string,
): Promise<{ path: string; sha256: string }> {
  const privateObjectDir = process.env.PRIVATE_OBJECT_DIR;
  if (!privateObjectDir) throw new Error("PRIVATE_OBJECT_DIR not set");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const extension = filename.match(/\.[a-z0-9]{1,8}$/i)?.[0].toLowerCase() ?? ".bin";
  const fullPath = `${privateObjectDir}/${workspaceOwnerId}/supplier-statement-inbound/${sha256}${extension}`;
  const parts = fullPath.replace(/^\/+/, "").split("/");
  const file = objectStorageClient.bucket(parts[0]).file(parts.slice(1).join("/"));
  const [exists] = await file.exists();
  if (!exists) {
    await file.save(bytes, { contentType, resumable: false });
  }
  return {
    path: `/objects/${workspaceOwnerId}/supplier-statement-inbound/${sha256}${extension}`,
    sha256,
  };
}

export async function processSupplierStatementResendInbound(input: {
  providerEventId: string;
  providerEmailId: string;
  email: ResendReceivedEmail;
}): Promise<{
  handled: boolean;
  duplicate?: boolean;
  classification?: string;
  documentStatus?: string | null;
  requestId?: string;
  reason?: string;
}> {
  const prior = await db.query<{
    request_id: string;
    workspace_owner_id: string;
    classification: string;
    document_status: string | null;
  }>(
    `SELECT request_id, workspace_owner_id, classification, document_status
       FROM supplier_statement_inbound_messages
      WHERE channel='email' AND provider_message_id=$1
      LIMIT 1`,
    [input.providerEmailId],
  );
  if (prior.rows[0]) {
    if (prior.rows[0].document_status === "exact_period") {
      await markSupplierStatementReceivedById(
        prior.rows[0].request_id, prior.rows[0].workspace_owner_id, "resend_email_received",
        { provider_email_id: input.providerEmailId, classification: prior.rows[0].classification },
      );
    }
    return {
      handled: true, duplicate: true, requestId: prior.rows[0].request_id,
      classification: prior.rows[0].classification,
      documentStatus: prior.rows[0].document_status,
    };
  }
  const match = await matchSupplierStatementEmailRequest(input);
  if (match.kind === "none") return { handled: false, reason: "uncorrelated_supplier_email" };
  if (match.kind === "ambiguous") {
    logger.warn(
      { providerEmailId: input.providerEmailId, requestIds: match.requestIds },
      "supplier statement Resend email matched multiple open requests",
    );
    return { handled: true, classification: "ambiguous_request", reason: "multiple_open_requests" };
  }

  const request = match.request;
  const sender = normalizedEmailAddress(input.email.from);
  const storedAttachments: Array<Record<string, unknown>> = [];
  for (const attachment of input.email.attachments) {
    if (attachment.bytes && attachment.bytes.length > 0) {
      const stored = await storeResendAttachment(
        attachment.bytes,
        request.workspace_owner_id,
        attachment.filename?.trim() || "supplier-statement.bin",
        attachment.content_type || "application/octet-stream",
      );
      storedAttachments.push({
        provider_attachment_id: attachment.id,
        file_name: attachment.filename?.trim() || "supplier-statement.bin",
        content_type: attachment.content_type,
        content_disposition: attachment.content_disposition,
        content_id: attachment.content_id,
        size_bytes: attachment.bytes.length,
        sha256: stored.sha256,
        storage_path: stored.path,
      });
    } else {
      storedAttachments.push({
        provider_attachment_id: attachment.id,
        file_name: attachment.filename?.trim() || "supplier-statement.bin",
        content_type: attachment.content_type,
        size_bytes: attachment.size,
        download_error: attachment.download_error ?? "attachment_content_unavailable",
      });
    }
  }

  const attachmentCount = input.email.attachments.length;
  // Replies often quote our outbound email, which contains the requested
  // dates. Only the document's own filename is period evidence here.
  const attachmentHasExactPeriod = input.email.attachments.some((attachment) =>
    exactPeriodEvidence(attachment.filename ?? "", request.period_start, request.period_end));
  const hasUnavailableAttachment = storedAttachments.some((attachment) => Boolean(attachment.download_error));
  const documentStatus = attachmentCount === 0
    ? (match.senderApproved ? null : "needs_attention")
    : match.senderApproved && !hasUnavailableAttachment && attachmentHasExactPeriod
      ? "exact_period"
      : "needs_attention";
  const classification = attachmentCount === 0
    ? documentStatus === "needs_attention" ? "ambiguous_reply" : "reply"
    : documentStatus === "exact_period" ? "statement_document" : "ambiguous_document";
  const providerEventId = `resend:${input.providerEventId}`;
  const providerMessageId = input.providerEmailId;
  const client = await db.connect();
  let inserted = false;
  try {
    await withTransaction(client, async () => {
      const result = await client.query(
        `INSERT INTO supplier_statement_inbound_messages
          (request_id, workspace_owner_id, channel, sender, body, attachment_url, attachment_file_name,
           provider_event_id, provider_message_id, subject, attachments, metadata, classification,
           document_status, received_at)
         VALUES ($1,$2,'email',$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,COALESCE($14::timestamptz,now()))
         ON CONFLICT DO NOTHING`,
        [
          request.request_id,
          request.workspace_owner_id,
          sender,
          input.email.text ?? input.email.html ?? null,
          storedAttachments[0]?.storage_path ?? null,
          storedAttachments[0]?.file_name ?? null,
          providerEventId,
          providerMessageId,
          input.email.subject?.trim() ?? null,
          JSON.stringify(storedAttachments),
          JSON.stringify({
            message_id: input.email.message_id,
            correlation: match.correlation,
            to: input.email.to,
            cc: input.email.cc ?? [],
            bcc: input.email.bcc ?? [],
          }),
          classification,
          documentStatus,
          input.email.created_at || null,
        ],
      );
      inserted = (result.rowCount ?? 0) > 0;
      if (!inserted) return;
      await client.query(
        `INSERT INTO supplier_statement_communication_events
          (request_id, workspace_owner_id, event_type, channel, provider_event_id, payload, occurred_at)
         VALUES ($1,$2,$3,'email',$4,$5::jsonb,COALESCE($6::timestamptz,now()))
         ON CONFLICT DO NOTHING`,
        [
          request.request_id,
          request.workspace_owner_id,
          documentStatus === "exact_period"
            ? "statement_received"
            : documentStatus === "needs_attention"
              ? "needs_attention"
              : "replied",
          providerEventId,
          JSON.stringify({
            provider_email_id: input.providerEmailId,
            message_id: input.email.message_id,
            sender,
            subject: input.email.subject,
            attachment_count: attachmentCount,
            classification,
          }),
          input.email.created_at || null,
        ],
      );
    });
  } finally {
    client.release();
  }

  if (documentStatus === "exact_period") {
    await markSupplierStatementReceivedById(request.request_id, request.workspace_owner_id, "resend_email_received", {
      provider_email_id: input.providerEmailId,
      message_id: input.email.message_id,
      classification,
    });
  }

  return {
    handled: true,
    duplicate: !inserted,
    classification,
    documentStatus,
    requestId: request.request_id,
  };
}

async function markStatementReceived(
  client: { query: typeof db.query },
  request: MatchedRequest,
  actor: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const updated = await client.query(
    `UPDATE supplier_statement_requests
        SET status='received', next_action='reconcile', next_action_at=NULL,
            received_at=COALESCE(received_at, now()), updated_at=now()
      WHERE id=$1 AND status NOT IN ('received','reconciled','cancelled')`,
    [request.request_id],
  );
  if ((updated.rowCount ?? 0) === 0) return;
  await client.query(
    `UPDATE supplier_statement_step_executions
        SET status=CASE WHEN status IN ('pending','processing') THEN 'cancelled' ELSE status END,
            updated_at=now()
      WHERE request_id=$1 AND status IN ('pending','processing')`,
    [request.request_id],
  );
  await client.query(
    `INSERT INTO supplier_statement_audit_events
      (workspace_owner_id, entity_type, entity_id, action, actor_id, metadata)
     VALUES ($1,'request',$2,'statement_received',$3,$4::jsonb)`,
    [request.workspace_owner_id, request.request_id, actor, JSON.stringify(metadata)],
  );
  await client.query(
    `INSERT INTO supplier_statement_communication_events
      (request_id, step_execution_id, workspace_owner_id, event_type, channel, payload)
     VALUES ($1,$2,$3,'statement_received',NULL,$4::jsonb)`,
    [request.request_id, request.step_id, request.workspace_owner_id, JSON.stringify(metadata)],
  );
}

/**
 * Handles only messages that strongly match an outbound supplier-collection
 * step. Returning false lets the existing address/support parser continue.
 */
export async function processSupplierStatementRespondIoInbound(
  payload: unknown,
  allowContactFallback = false,
): Promise<boolean> {
  const parsed = parseInboundPayload(payload);
  if (!parsed || (!parsed.providerMessageId && !parsed.providerEventId)) return false;
  const request = await matchSupplierStatementRequest({ ...parsed, allowContactFallback });
  if (!request) return false;
  const eventId = parsed.providerEventId
    ? `respondio:${parsed.providerEventId}`
    : parsed.providerMessageId
      ? `respondio-message:${parsed.providerMessageId}`
      : null;
  const messageId = parsed.providerMessageId ?? eventId;
  const documentStatus = parsed.attachments.length === 0
    ? null
    : parsed.attachments.some((attachment) => {
        const name = String(attachment.name ?? "").toLowerCase();
        return exactPeriodEvidence(name, request.period_start, request.period_end);
      })
      ? "exact_period"
      : "needs_attention";
  const classification = parsed.attachments.length > 0
    ? documentStatus === "exact_period" ? "statement_document" : "ambiguous_document"
    : "reply";

  const client = await db.connect();
  try {
    await withTransaction(client, async () => {
      const inserted = await client.query(
        `INSERT INTO supplier_statement_inbound_messages
          (request_id, workspace_owner_id, channel, sender, body, attachment_url, provider_event_id,
           provider_message_id, provider_contact_id, provider_conversation_id,
           provider_channel_id, in_reply_to_provider_message_id, sender_phone,
           attachments, metadata, classification, document_status, received_at)
         VALUES ($1,$2,'whatsapp',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14::jsonb,$15,$16,$17)
         ON CONFLICT DO NOTHING`,
        [
          request.request_id,
          request.workspace_owner_id,
          parsed.sender,
          parsed.body,
          parsed.attachments[0]?.url ?? null,
          eventId,
          messageId,
          parsed.providerContactId,
          parsed.providerConversationId,
          parsed.providerChannelId,
          parsed.inReplyToProviderMessageId,
          parsed.senderPhone,
          JSON.stringify(parsed.attachments),
          JSON.stringify({ namespace: SUPPLIER_STATEMENT_NAMESPACE }),
          classification,
          documentStatus,
          parsed.occurredAt,
        ],
      );
      if ((inserted.rowCount ?? 0) === 0) return;
      await client.query(
        `INSERT INTO supplier_statement_communication_events
          (request_id, step_execution_id, workspace_owner_id, event_type, channel,
           provider_event_id, payload, occurred_at)
         VALUES ($1,$2,$3,$4,'whatsapp',$5,$6::jsonb,$7)
         ON CONFLICT DO NOTHING`,
        [
          request.request_id,
          request.step_id,
          request.workspace_owner_id,
          documentStatus === "exact_period" ? "statement_document"
            : parsed.attachments.length ? "needs_attention" : "replied",
          eventId,
          JSON.stringify({
            provider_message_id: parsed.providerMessageId,
            provider_contact_id: parsed.providerContactId,
            provider_conversation_id: parsed.providerConversationId,
            provider_channel_id: parsed.providerChannelId,
            attachment_count: parsed.attachments.length,
          }),
          parsed.occurredAt,
        ],
      );
      if (request.step_id) {
        await client.query(
          `UPDATE supplier_statement_step_executions
              SET replied_at=COALESCE(replied_at,$2), updated_at=now()
            WHERE id=$1`,
          [request.step_id, parsed.occurredAt],
        );
      }
      if (documentStatus === "exact_period") {
        await markStatementReceived(client, request, "respondio", {
          provider_message_id: parsed.providerMessageId,
          classification,
        });
      }
    });
    return true;
  } finally {
    client.release();
  }
}

export async function processSupplierStatementRespondIoStatus(payload: unknown): Promise<boolean> {
  const parsed = parseInboundPayload(payload);
  const status = providerStatus(payload);
  if (!parsed || !status) return false;
  const providerRef = text(
    providerMessageId(providerParts(payload)),
    object(object(payload)?.data)?.provider_ref,
    object(payload)?.provider_ref,
  );
  if (!providerRef && !parsed.providerContactId) return false;
  const request = await matchSupplierStatementRequest({
    providerMessageId: providerRef,
    inReplyToProviderMessageId: providerRef,
    providerContactId: parsed.providerContactId,
    providerChannelId: parsed.providerChannelId,
    allowContactFallback: true,
  });
  if (!request) return false;
  const normalized = status === "undelivered" ? "failed" : status;
  const eventId = parsed.providerEventId
    ? `respondio-status:${parsed.providerEventId}`
    : `respondio-status:${providerRef ?? `${request.request_id}:${normalized}`}`;
  const client = await db.connect();
  try {
    await withTransaction(client, async () => {
      const inserted = await client.query(
        `INSERT INTO supplier_statement_communication_events
          (request_id, step_execution_id, workspace_owner_id, event_type, channel,
           provider_event_id, payload, occurred_at)
         VALUES ($1,$2,$3,$4,'whatsapp',$5,$6::jsonb,$7)
         ON CONFLICT DO NOTHING`,
        [
          request.request_id,
          request.step_id,
          request.workspace_owner_id,
          normalized,
          eventId,
          JSON.stringify({ provider_ref: providerRef, provider_status: status }),
          parsed.occurredAt,
        ],
      );
      if ((inserted.rowCount ?? 0) === 0) return;
      const timestampColumn =
        normalized === "delivered" ? "delivered_at"
          : normalized === "read" ? "read_at"
            : normalized === "replied" ? "replied_at"
              : null;
      const timestampSql = timestampColumn ? `, ${timestampColumn}=COALESCE(${timestampColumn},$3)` : "";
      await client.query(
        `UPDATE supplier_statement_step_executions
            SET provider_status=$2,
                provider_message_id=COALESCE(provider_message_id,$4),
                updated_at=now()${timestampSql}
          WHERE id=$1`,
        [request.step_id, normalized, parsed.occurredAt, providerRef],
      );
    });
    return true;
  } catch (error) {
    logger.warn({ error, providerRef }, "supplier statement Respond.io status processing failed");
    return false;
  } finally {
    client.release();
  }
}

export async function processSupplierStatementResendStatus(input: {
  providerMessageId: string;
  providerEventId: string;
  status: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
}): Promise<boolean> {
  const stepResult = await db.query<{
    id: number;
    request_id: string;
    workspace_owner_id: string;
    status: string;
  }>(
    `SELECT e.id, e.request_id, e.workspace_owner_id, e.status
       FROM supplier_statement_step_executions e
      WHERE e.provider_message_id=$1
      LIMIT 1`,
    [input.providerMessageId],
  );
  const step = stepResult.rows[0];
  if (!step) return false;
  const eventId = `resend:${input.providerEventId}`;
  const inserted = await db.query(
    `INSERT INTO supplier_statement_communication_events
      (request_id, step_execution_id, workspace_owner_id, event_type, channel,
       provider_event_id, payload, occurred_at)
     VALUES ($1,$2,$3,$4,'email',$5,$6::jsonb,$7)
     ON CONFLICT DO NOTHING`,
    [
      step.request_id,
      step.id,
      step.workspace_owner_id,
      input.status,
      eventId,
      JSON.stringify(input.payload),
      input.occurredAt,
    ],
  );
  if ((inserted.rowCount ?? 0) === 0) return true;
  const timestampColumn =
    input.status === "delivered" ? "delivered_at"
      : input.status === "opened" || input.status === "clicked" ? "read_at"
        : null;
  const timestampSql = timestampColumn ? `, ${timestampColumn}=COALESCE(${timestampColumn},$3)` : "";
  const failureParameter = timestampColumn ? "$4" : "$3";
  await db.query(
    `UPDATE supplier_statement_step_executions
        SET provider_status=$2, updated_at=now()${timestampSql},
            failure_details=CASE WHEN $2 IN ('failed','bounced','dropped','suppressed')
              THEN ${failureParameter}::jsonb ELSE failure_details END
      WHERE id=$1`,
    timestampColumn
      ? [step.id, input.status, input.occurredAt, JSON.stringify(input.payload)]
      : [step.id, input.status, JSON.stringify(input.payload)],
  );
  return true;
}
