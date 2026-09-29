import { createHmac, timingSafeEqual } from "crypto";
import { Router, type Request, type Response } from "express";
import { logger } from "../lib/logger";
import { db } from "../lib/db";
import { addressTemplateName } from "../lib/addressCollector/config";
import { ingestRespondIoTemplateSend } from "../lib/addressCollector/service";
import {
  parseRespondIoIncomingMessage,
  parseRespondIoIncomingMessageWithClassification,
  processIncomingReply,
  registerIncomingReply,
  type RespondIoIncomingParserClassification,
} from "../lib/addressCollector/incomingReplyHandler";
import {
  isSupplierStatementPayload,
  processSupplierStatementRespondIoInbound,
} from "../lib/supplierStatementDelivery";

const router = Router();

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
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

function boundedMetadata(
  value: unknown,
  allowed: RegExp,
  maxLength = 128,
): string | null {
  const valueText = text(value);
  if (!valueText) return null;
  return valueText.length <= maxLength && allowed.test(valueText) ? valueText : "<invalid>";
}

export type RespondIoOutboundTemplate = {
  providerMessageId: string;
  contactId: string;
  channelId: string;
  recipientPhone: string;
  recipientName: string;
  templateName: string;
  languageCode: string;
  sentAt: Date;
};

/** Parse only one-to-one outbound WhatsApp template events. */
export function parseRespondIoOutboundTemplate(payload: unknown): RespondIoOutboundTemplate | null {
  const root = object(payload);
  if (!root) return null;
  const data = object(root.data) ?? root;
  const message = object(data.message) ?? data;
  const contact = object(data.contact) ?? object(root.contact);
  const channel = object(data.channel) ?? object(root.channel);
  const template = object(message.template) ?? object(object(message.content)?.template);
  const event = text(root.event_type, root.eventType, root.event, root.type)?.toLowerCase() ?? "";
  const direction = text(message.direction, data.direction, root.direction)?.toLowerCase();
  const messageType = text(message.type, object(message.content)?.type)?.toLowerCase();
  if (
    (direction && !["outgoing", "outbound", "sent"].includes(direction))
    || (event && !/(outgoing|outbound|sent|message)/.test(event))
    || (messageType && !["whatsapp_template", "template"].includes(messageType))
  ) return null;

  const providerMessageId = text(message.messageId, message.message_id, message.id, data.messageId);
  const contactId = text(contact?.id, contact?.contactId, data.contactId);
  const channelId = text(channel?.id, channel?.channelId, data.channelId, root.channelId);
  const recipientPhone = text(contact?.phone, contact?.phoneNumber, contact?.phone_number, message.to, data.to);
  const templateName = text(template?.name, template?.templateName, message.templateName, data.templateName);
  if (!providerMessageId || !contactId || !channelId || !recipientPhone || !templateName) return null;

  const firstName = text(contact?.firstName, contact?.first_name);
  const lastName = text(contact?.lastName, contact?.last_name);
  const recipientName = text(contact?.name, [firstName, lastName].filter(Boolean).join(" "), recipientPhone) as string;
  const timestamp = text(message.sentAt, message.createdAt, message.timestamp, data.sentAt, data.createdAt);
  const sentAt = timestamp ? new Date(timestamp) : new Date();
  return {
    providerMessageId,
    contactId,
    channelId,
    recipientPhone,
    recipientName,
    templateName,
    languageCode: text(template?.languageCode, template?.language, message.languageCode) ?? "en",
    sentAt: Number.isNaN(sentAt.getTime()) ? new Date() : sentAt,
  };
}

function verifyRawBodySignature(rawBody: Buffer, supplied: string, secret: string): boolean {
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const normalized = supplied.trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(normalized)) return false;
  const received = Buffer.from(normalized, "base64");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function verifyRespondIoPayloadSignature(
  payload: unknown,
  supplied: string,
  signingKey: string,
): boolean {
  const normalized = supplied.trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(normalized)) return false;
  const received = Buffer.from(normalized, "base64");
  const expected = createHmac("sha256", signingKey)
    .update(JSON.stringify(payload))
    .digest();
  return received.length === expected.length && timingSafeEqual(received, expected);
}

type IncomingWebhookContext = {
  eventType: string | null;
  contactId: string | null;
  phonePresent: boolean;
  providerMessageId: string | null;
  channelId: string | null;
};

function incomingWebhookContext(payload: unknown): IncomingWebhookContext {
  const root = object(payload);
  const data = object(root?.data) ?? root;
  const message = object(data?.message) ?? data;
  const messageContent = object(message?.message) ?? object(message?.content);
  const contact = object(data?.contact) ?? object(root?.contact);
  const sender = object(message?.sender) ?? object(data?.sender);
  const channel = object(data?.channel) ?? object(root?.channel);
  const phone = text(
    contact?.phone,
    contact?.phoneNumber,
    contact?.phone_number,
    sender?.phone,
    sender?.phoneNumber,
    data?.from,
    message?.from,
  );
  return {
    eventType: boundedMetadata(
      text(root?.event_type, root?.eventType, root?.event, root?.type),
      /^[A-Za-z0-9._:-]+$/,
    ),
    contactId: boundedMetadata(
      text(contact?.id, contact?.contactId, data?.contactId),
      /^[A-Za-z0-9._:@/+=-]+$/,
    ),
    phonePresent: Boolean(phone),
    providerMessageId: boundedMetadata(text(
      message?.messageId,
      message?.message_id,
      message?.id,
      messageContent?.messageId,
      data?.messageId,
      data?.message_id,
    ), /^[A-Za-z0-9._:@/+=-]+$/),
    channelId: boundedMetadata(
      text(
        channel?.id,
        channel?.channelId,
        message?.channelId,
        data?.channelId,
        root?.channelId,
      ),
      /^[A-Za-z0-9._:@/+=-]+$/,
    ),
  };
}

type IncomingParserClassification =
  | RespondIoIncomingParserClassification
  | "invalid_body"
  | "body_too_large"
  | "invalid_json"
  | "invalid_signature";

type LocationCoordinate = {
  path: string;
  value: number;
};

type IncomingDiagnosticProjection = {
  payloadKind: "object" | "array" | "null" | "primitive" | "unavailable" | "invalid_json";
  topLevelJsonKeys: string[];
  eventType: string | null;
  payloadType: string | null;
  messageType: string | null;
  providerMessageId: string | null;
  channelId: string | null;
  contactId: string | null;
  phonePresent: boolean;
  textPresent: boolean;
  latitudePresent: boolean;
  longitudePresent: boolean;
  replyReferencePresent: boolean;
  locationCoordinates: LocationCoordinate[];
  parserClassification: IncomingParserClassification | null;
};

type IncomingDiagnosticReceipt = IncomingDiagnosticProjection & {
  timestamp: string;
  method: string;
  contentType: "application/json" | "other" | "missing";
  signatureHeaderPresent: boolean;
  rawBodyBytes: number;
};

const MAX_DIAGNOSTIC_KEYS = 32;
const MAX_DIAGNOSTIC_COORDINATES = 8;
const DIAGNOSTIC_TOP_LEVEL_KEYS = new Set([
  "event_type",
  "eventType",
  "event",
  "type",
  "event_id",
  "data",
  "contact",
  "message",
  "sender",
  "channel",
  "channelId",
  "direction",
]);

function emptyDiagnosticProjection(
  payloadKind: IncomingDiagnosticProjection["payloadKind"],
): IncomingDiagnosticProjection {
  return {
    payloadKind,
    topLevelJsonKeys: [],
    eventType: null,
    payloadType: null,
    messageType: null,
    providerMessageId: null,
    channelId: null,
    contactId: null,
    phonePresent: false,
    textPresent: false,
    latitudePresent: false,
    longitudePresent: false,
    replyReferencePresent: false,
    locationCoordinates: [],
    parserClassification: null,
  };
}

function valuePresent(value: unknown): boolean {
  return value !== undefined && value !== null && String(value).trim().length > 0;
}

function finiteCoordinate(value: unknown, kind: "latitude" | "longitude"): number | null {
  const numericValue =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : NaN;
  const max = kind === "latitude" ? 90 : 180;
  return Number.isFinite(numericValue) && numericValue >= -max && numericValue <= max
    ? numericValue
    : null;
}

function diagnosticProjection(payload: unknown): IncomingDiagnosticProjection {
  if (payload === null) return emptyDiagnosticProjection("null");
  if (Array.isArray(payload)) return emptyDiagnosticProjection("array");
  const root = object(payload);
  if (!root) return emptyDiagnosticProjection("primitive");

  const data = object(root.data) ?? root;
  const messagePath = object(root.data) ? "data.message" : "message";
  const nestedMessage = object(data.message);
  const message = nestedMessage ?? data;
  const content = object(message.message) ?? object(message.content);
  const contentPath = object(message.message)
    ? `${messagePath}.message`
    : `${messagePath}.content`;
  const contact = object(data.contact) ?? object(root.contact);
  const sender = object(message.sender) ?? object(data.sender);
  const channel = object(data.channel) ?? object(root.channel);
  const messageLocation = object(message.location);
  const contentLocation = object(content?.location);
  const context = object(message.context) ?? object(message.replyTo) ?? object(data.context);
  const eventType = boundedMetadata(
    text(root.event_type, root.eventType, root.event, root.type),
    /^[A-Za-z0-9._:-]+$/,
  );
  const payloadType = boundedMetadata(text(root.type), /^[A-Za-z0-9._:-]+$/);
  const messageType = boundedMetadata(
    text(content?.type, message.type)?.toLowerCase(),
    /^[a-z0-9._:-]+$/,
  );
  const providerMessageId = boundedMetadata(text(
    message.messageId,
    message.message_id,
    message.id,
    data.messageId,
    data.message_id,
  ), /^[A-Za-z0-9._:@/+=-]+$/);
  const contactId = boundedMetadata(
    text(contact?.id, contact?.contactId, data.contactId),
    /^[A-Za-z0-9._:@/+=-]+$/,
  );
  const channelId = boundedMetadata(
    text(
      channel?.id,
      channel?.channelId,
      message.channelId,
      data.channelId,
      root.channelId,
    ),
    /^[A-Za-z0-9._:@/+=-]+$/,
  );
  const phonePresent = valuePresent(text(
    contact?.phone,
    contact?.phoneNumber,
    contact?.phone_number,
    sender?.phone,
    sender?.phoneNumber,
    data.from,
    message.from,
  ));
  const textPresent = valuePresent(text(
    content?.text,
    content?.body,
    message.text,
    message.body,
    data.text,
  ));
  const latitudeCandidates: Array<{ path: string; value: unknown }> = [
    { path: `${messagePath}.location.latitude`, value: messageLocation?.latitude },
    { path: `${messagePath}.location.lat`, value: messageLocation?.lat },
    { path: `${contentPath}.location.latitude`, value: contentLocation?.latitude },
    { path: `${contentPath}.location.lat`, value: contentLocation?.lat },
    { path: `${contentPath}.latitude`, value: content?.latitude },
    { path: `${contentPath}.lat`, value: content?.lat },
    { path: `${messagePath}.latitude`, value: message.latitude },
    { path: `${messagePath}.lat`, value: message.lat },
  ];
  const longitudeCandidates: Array<{ path: string; value: unknown }> = [
    { path: `${messagePath}.location.longitude`, value: messageLocation?.longitude },
    { path: `${messagePath}.location.lng`, value: messageLocation?.lng },
    { path: `${messagePath}.location.lon`, value: messageLocation?.lon },
    { path: `${contentPath}.location.longitude`, value: contentLocation?.longitude },
    { path: `${contentPath}.location.lng`, value: contentLocation?.lng },
    { path: `${contentPath}.location.lon`, value: contentLocation?.lon },
    { path: `${contentPath}.longitude`, value: content?.longitude },
    { path: `${contentPath}.lng`, value: content?.lng },
    { path: `${contentPath}.lon`, value: content?.lon },
    { path: `${messagePath}.longitude`, value: message.longitude },
    { path: `${messagePath}.lng`, value: message.lng },
    { path: `${messagePath}.lon`, value: message.lon },
  ];
  const locationCoordinates = [
    ...latitudeCandidates.flatMap(({ path, value }) => {
      const coordinate = finiteCoordinate(value, "latitude");
      return coordinate === null ? [] : [{ path, value: coordinate }];
    }),
    ...longitudeCandidates.flatMap(({ path, value }) => {
      const coordinate = finiteCoordinate(value, "longitude");
      return coordinate === null ? [] : [{ path, value: coordinate }];
    }),
  ].slice(0, MAX_DIAGNOSTIC_COORDINATES);

  return {
    payloadKind: "object",
    topLevelJsonKeys: Object.keys(root)
      .filter((key) => DIAGNOSTIC_TOP_LEVEL_KEYS.has(key))
      .slice(0, MAX_DIAGNOSTIC_KEYS)
      .map((key) => key.slice(0, 64)),
    eventType,
    payloadType,
    messageType,
    providerMessageId,
    channelId,
    contactId,
    phonePresent,
    textPresent,
    latitudePresent: latitudeCandidates.some(({ value }) => valuePresent(value)),
    longitudePresent: longitudeCandidates.some(({ value }) => valuePresent(value)),
    replyReferencePresent: valuePresent(text(
      message.replyToMessageId,
      message.reply_to_message_id,
      context?.messageId,
      context?.message_id,
      context?.id,
    )),
    locationCoordinates,
    parserClassification: null,
  };
}

function parseDiagnosticBody(rawBody: Buffer | undefined): IncomingDiagnosticProjection {
  if (!rawBody) return emptyDiagnosticProjection("unavailable");
  try {
    return diagnosticProjection(JSON.parse(rawBody.toString("utf8")));
  } catch {
    return {
      ...emptyDiagnosticProjection("invalid_json"),
      parserClassification: "invalid_json",
    };
  }
}

function logIncomingOutcome(
  receipt: IncomingDiagnosticReceipt,
  outcome: {
    httpStatus: number;
    accepted: boolean;
    ignored: boolean;
    parserClassification: IncomingParserClassification;
    rejectionReason?: string;
    errorCode?: string;
  },
): void {
  logger.info(
    {
      timestamp: receipt.timestamp,
      method: receipt.method,
      signatureHeaderPresent: receipt.signatureHeaderPresent,
      httpStatus: outcome.httpStatus,
      accepted: outcome.accepted,
      ignored: outcome.ignored,
      parserClassification: outcome.parserClassification,
      ...(outcome.rejectionReason ? { rejectionReason: outcome.rejectionReason } : {}),
      ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
    },
    "respondio incoming webhook outcome",
  );
}

function canonicalContentType(req: Request): IncomingDiagnosticReceipt["contentType"] {
  const contentType = req.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  return contentType === "application/json"
    ? "application/json"
    : contentType
      ? "other"
      : "missing";
}

export function respondIoRawBodyErrorResponse(
  req: Request,
  res: Response,
  errorCode: "body_too_large" | "invalid_body",
): void {
  const receipt: IncomingDiagnosticReceipt = {
    ...emptyDiagnosticProjection("unavailable"),
    timestamp: new Date().toISOString(),
    method: req.method,
    contentType: canonicalContentType(req),
    signatureHeaderPresent: req.header("X-Webhook-Signature") !== undefined,
    rawBodyBytes: 0,
  };
  logger.info(receipt, "respondio incoming webhook diagnostic receipt");
  const httpStatus = errorCode === "body_too_large" ? 413 : 400;
  res.status(httpStatus).json({ error: errorCode });
  logIncomingOutcome(receipt, {
    httpStatus,
    accepted: false,
    ignored: false,
    parserClassification: errorCode,
    rejectionReason: errorCode,
    errorCode,
  });
}

async function registerAndProcessIncoming(
  reply: NonNullable<ReturnType<typeof parseRespondIoIncomingMessage>>,
  context: IncomingWebhookContext,
): Promise<void> {
  try {
    const registered = await registerIncomingReply(reply);
    logger.info(
      {
        ...context,
        signatureValid: true,
        acknowledgementStatus: 200,
        duplicate: !registered,
        asynchronousResult: registered ? "registered" : "duplicate_resume",
      },
      "respondio incoming webhook registered",
    );
    await processIncomingReply(reply);
    logger.info(
      {
        ...context,
        signatureValid: true,
        acknowledgementStatus: 200,
        duplicate: !registered,
        asynchronousResult: "completed",
      },
      "respondio incoming webhook processing completed",
    );
  } catch {
    logger.error(
      {
        ...context,
        signatureValid: true,
        acknowledgementStatus: 200,
        asynchronousResult: "failed",
        errorCode: "asynchronous_processing_failed",
      },
      "respondio incoming webhook asynchronous processing failed",
    );
  }
}

async function incomingMessageHandler(req: Request, res: Response): Promise<void> {
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  const receipt: IncomingDiagnosticReceipt = {
    ...parseDiagnosticBody(rawBody),
    timestamp: new Date().toISOString(),
    method: req.method,
    contentType: canonicalContentType(req),
    signatureHeaderPresent: req.header("X-Webhook-Signature") !== undefined,
    rawBodyBytes: rawBody?.length ?? 0,
  };
  logger.info(receipt, "respondio incoming webhook diagnostic receipt");

  const secret = process.env.RESPONDIO_INCOMING_WEBHOOK_SECRET?.trim();
  const signature = req.get("X-Webhook-Signature") ?? "";
  if (!secret || !rawBody || !signature) {
    logger.warn(
      {
        signatureValid: false,
        acknowledgementStatus: 401,
        hasConfiguredSigningKey: Boolean(secret),
        signatureHeaderPresent: Boolean(signature),
        rawBodyBytes: rawBody?.length ?? 0,
      },
      "respondio incoming webhook rejected",
    );
    res.status(401).json({ error: "invalid_signature" });
    logIncomingOutcome(receipt, {
      httpStatus: 401,
      accepted: false,
      ignored: false,
      parserClassification: "invalid_signature",
      rejectionReason: "invalid_signature",
      errorCode: "invalid_signature",
    });
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody!.toString("utf8"));
  } catch {
    logger.warn(
      {
        signatureValid: false,
        acknowledgementStatus: 400,
        rawBodyBytes: rawBody!.length,
      },
      "respondio incoming webhook invalid JSON",
    );
    res.status(400).json({ error: "invalid_json" });
    logIncomingOutcome(receipt, {
      httpStatus: 400,
      accepted: false,
      ignored: false,
      parserClassification: "invalid_json",
      rejectionReason: "invalid_json",
      errorCode: "invalid_json",
    });
    return;
  }
  if (!verifyRespondIoPayloadSignature(payload, signature, secret)) {
    logger.warn(
      {
        signatureValid: false,
        acknowledgementStatus: 401,
        hasConfiguredSigningKey: true,
        signatureHeaderPresent: true,
        rawBodyBytes: rawBody.length,
      },
      "respondio incoming webhook rejected",
    );
    res.status(401).json({ error: "invalid_signature" });
    logIncomingOutcome(receipt, {
      httpStatus: 401,
      accepted: false,
      ignored: false,
      parserClassification: "invalid_signature",
      rejectionReason: "invalid_signature",
      errorCode: "invalid_signature",
    });
    return;
  }
  // A supplier-only message namespace may use the contact/channel fallback.
  // Contact attributes persist on shared contacts; by themselves they are
  // never sufficient to divert subsequent customer/support messages.
  if (isSupplierStatementPayload(payload)) {
    const explicitSupplierNamespace = isSupplierStatementPayload(payload, false);
    try {
      const matched = await processSupplierStatementRespondIoInbound(payload, explicitSupplierNamespace);
      if (matched || explicitSupplierNamespace) {
        res.status(200).json({
          accepted: true,
          ...(matched ? { namespace: "supplier_statement_collection" } : { ignored: true }),
        });
        logIncomingOutcome(receipt, {
          httpStatus: 200,
          accepted: true,
          ignored: !matched,
          parserClassification: matched ? "text" : "unsupported_event",
        });
        return;
      }
    } catch (error) {
      logger.warn({ error }, "supplier statement Respond.io inbound processing failed");
      res.status(503).json({ error: "supplier_statement_processing_unavailable" });
      return;
    }
  }
  const context = incomingWebhookContext(payload);
  const parsedIncoming = parseRespondIoIncomingMessageWithClassification(payload);
  const reply = parsedIncoming.reply;
  const parserClassification = parsedIncoming.classification;
  logger.info(
    {
      ...context,
      signatureValid: true,
      acknowledgementStatus: 200,
      supportedEvent: Boolean(reply),
    },
    "respondio incoming webhook received",
  );
  if (!reply) {
    res.status(200).json({ accepted: true, ignored: true });
    logger.info(
      {
        ...context,
        signatureValid: true,
        acknowledgementStatus: 200,
        asynchronousResult: "ignored",
      },
      "respondio incoming webhook acknowledged",
    );
    logIncomingOutcome(receipt, {
      httpStatus: 200,
      accepted: true,
      ignored: true,
      parserClassification,
      rejectionReason: parserClassification,
    });
    return;
  }
  res.status(200).json({ accepted: true });
  logger.info(
    {
      ...context,
      signatureValid: true,
      acknowledgementStatus: 200,
      asynchronousResult: "scheduled",
    },
    "respondio incoming webhook acknowledged",
  );
  logIncomingOutcome(receipt, {
    httpStatus: 200,
    accepted: true,
    ignored: false,
    parserClassification,
  });
  // res.json() ends the HTTP response before this durable handoff starts. Do
  // not defer another event-loop turn: inserting immediately minimizes the
  // unavoidable post-ack/pre-persistence crash window, while the DB unique key
  // and worker lease make every persisted delivery restart-safe.
  void registerAndProcessIncoming(reply, context);
}

router.post("/respondio/incoming-message", incomingMessageHandler);
// This obsolete path was once used as an incoming-message alias. It must never
// share the canonical Developer Webhook authenticator because its name collides
// with the separate Workflow delivery-status contract.
router.post("/webhooks/respondio/status", (_req: Request, res: Response) => {
  res.status(410).json({ error: "deprecated_endpoint" });
});

router.post("/respondio/outbound-template", async (req: Request, res: Response) => {
  const secret =
    process.env.RESPONDIO_OUTBOUND_WEBHOOK_SECRET?.trim()
    || process.env.RESPONDIO_STATUS_WEBHOOK_SECRET?.trim();
  const signature = req.get("X-Webhook-Signature") ?? "";
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!secret || !rawBody || !signature || !verifyRawBodySignature(rawBody, signature, secret)) {
    res.status(401).json({ error: "invalid_signature" });
    return;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    res.status(400).json({ error: "invalid_json" });
    return;
  }
  const outbound = parseRespondIoOutboundTemplate(payload);
  if (!outbound || outbound.templateName !== addressTemplateName()) {
    res.status(202).json({ accepted: false });
    return;
  }
  try {
    const mapping = await db.query<{ workspace_owner_id: string }>(
      `SELECT workspace_owner_id
         FROM omni_channel_accounts
        WHERE provider = 'respondio'
          AND external_account_id = $1
          AND is_active = true
        LIMIT 2`,
      [outbound.channelId],
    );
    if (mapping.rows.length !== 1) {
      res.status(422).json({ error: "channel_not_mapped" });
      return;
    }
    const result = await ingestRespondIoTemplateSend({
      ...outbound,
      workspaceOwnerId: mapping.rows[0].workspace_owner_id,
    });
    res.status(202).json({ accepted: true, duplicate: result.duplicate, requestId: result.requestId });
  } catch (error) {
    logger.error({ error, providerMessageId: outbound.providerMessageId }, "addressCollector: outbound template ingest failed");
    res.status(503).json({ error: "temporarily_unavailable" });
  }
});

export default router;