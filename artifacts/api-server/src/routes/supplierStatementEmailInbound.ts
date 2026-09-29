/**
 * Dedicated supplier-statement email adapter.
 *
 * This endpoint is intentionally separate from /webhooks/supplier-email/inbound,
 * which remains the purchase-order reply path. It accepts Postmark-compatible
 * inbound JSON only when the destination contains a request UUID.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { db, withTransaction } from "../lib/db";
import { logger } from "../lib/logger";
import { objectStorageClient } from "../lib/objectStorage";
import {
  supplierStatementInboundConfigured,
  markSupplierStatementReceivedById,
} from "../lib/supplierStatementDelivery";

const router = Router();
const MAX_ATTACHMENT_SIZE = 20 * 1024 * 1024;
const REQUEST_ADDRESS_RE = /^supplier-statement\+([0-9a-f-]{36})@/i;

type InboundAttachment = {
  Name?: string;
  Content?: string;
  ContentType?: string;
};

type InboundPayload = {
  MessageID?: string;
  From?: string;
  To?: string | string[];
  ToFull?: Array<{ Email?: string }>;
  Subject?: string;
  TextBody?: string;
  HtmlBody?: string;
  Headers?: Array<{ Name?: string; Value?: string }>;
  Attachments?: InboundAttachment[];
};

function verifySecret(provided: string | undefined): boolean {
  const expected = process.env.SUPPLIER_STATEMENT_INBOUND_SECRET?.trim();
  if (!expected || !provided) return false;
  const left = Buffer.from(expected);
  const right = Buffer.from(provided);
  return left.length === right.length && timingSafeEqual(left, right);
}

function emailAddress(raw: string): string {
  const angle = raw.match(/<([^>]+)>/);
  return (angle?.[1] ?? raw).trim().toLowerCase();
}

function destinationAddresses(payload: InboundPayload): string[] {
  const values: string[] = [];
  for (const entry of payload.ToFull ?? []) {
    if (entry.Email) values.push(entry.Email);
  }
  if (typeof payload.To === "string") values.push(payload.To);
  if (Array.isArray(payload.To)) values.push(...payload.To);
  return values;
}

function requestIdFromDestination(payload: InboundPayload): string | null {
  for (const destination of destinationAddresses(payload)) {
    const match = destination.match(REQUEST_ADDRESS_RE);
    if (match) return match[1];
  }
  return null;
}

function messageId(payload: InboundPayload): string {
  if (payload.MessageID?.trim()) return payload.MessageID.trim();
  const header = payload.Headers?.find((item) => item.Name?.toLowerCase() === "message-id");
  return header?.Value?.trim() || `inbound:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
}

async function storeAttachment(
  buffer: Buffer,
  workspaceOwnerId: string,
  fileName: string,
  contentType: string,
): Promise<string> {
  const privateObjectDir = process.env.PRIVATE_OBJECT_DIR;
  if (!privateObjectDir) throw new Error("PRIVATE_OBJECT_DIR not set");
  const digest = createHash("sha256").update(buffer).digest("hex");
  const safeName = fileName.toLowerCase().endsWith(".pdf") ? `${digest}.pdf` : `${digest}.bin`;
  const fullPath = `${privateObjectDir}/${workspaceOwnerId}/supplier-statement-inbound/${safeName}`;
  const parts = fullPath.replace(/^\/+/, "").split("/");
  const file = objectStorageClient.bucket(parts[0]).file(parts.slice(1).join("/"));
  const [exists] = await file.exists();
  if (!exists) {
    await file.save(buffer, { contentType, resumable: false });
  }
  return `/objects/${workspaceOwnerId}/supplier-statement-inbound/${safeName}`;
}

function exactPeriodEvidence(fileName: string, periodStart: string, periodEnd: string): boolean {
  const name = fileName.toLowerCase();
  return name.includes(periodStart.toLowerCase())
    || name.includes(periodEnd.toLowerCase())
    || name.includes(periodStart.slice(0, 7))
    || name.includes(periodEnd.slice(0, 7));
}

router.post("/webhooks/supplier-statement-email/inbound", async (req: Request, res: Response) => {
  if (!supplierStatementInboundConfigured()) {
    res.status(404).json({ error: "Supplier statement inbound is not configured" });
    return;
  }
  if (!verifySecret(String(req.headers["x-supplier-statement-webhook-secret"] ?? ""))) {
    res.status(401).json({ error: "Invalid or missing webhook secret" });
    return;
  }
  const payload = (req.body ?? {}) as InboundPayload;
  const requestId = requestIdFromDestination(payload);
  if (!requestId) {
    res.status(202).json({ accepted: true, ignored: true, reason: "not_supplier_statement_destination" });
    return;
  }
  const sender = typeof payload.From === "string" ? emailAddress(payload.From) : null;
  const inboundId = messageId(payload);
  if (!sender) {
    res.status(400).json({ error: "sender_missing" });
    return;
  }
  try {
    const matched = await db.query<{
      id: string;
      workspace_owner_id: string;
      supplier_id: number;
      finance_entity_id: number;
      period_start: string;
      period_end: string;
      status: string;
    }>(
      `SELECT r.id, r.workspace_owner_id, r.supplier_id, r.finance_entity_id,
              r.period_start, r.period_end, r.status
         FROM supplier_statement_requests r
        WHERE r.id=$1 AND r.status NOT IN ('received','reconciled','cancelled')
          AND EXISTS (
            SELECT 1 FROM supplier_statement_contacts c
             WHERE c.id=ANY(
               SELECT ((jsonb_array_elements(r.recipients_snapshot)->>'id')::int)
             )
               AND c.supplier_id=r.supplier_id
               AND c.workspace_owner_id=r.workspace_owner_id
               AND c.is_active=true AND c.is_approved=true
               AND lower(c.email)=lower($2)
          )
        LIMIT 1`,
      [requestId, sender],
    );
    const request = matched.rows[0];
    if (!request) {
      res.status(202).json({ accepted: true, ignored: true, reason: "uncorrelated_or_invalid_sender" });
      return;
    }

    const attachments: Array<Record<string, unknown>> = [];
    for (const attachment of payload.Attachments ?? []) {
      if (!attachment.Content) continue;
      const buffer = Buffer.from(attachment.Content, "base64");
      if (!buffer.length || buffer.length > MAX_ATTACHMENT_SIZE) continue;
      const name = attachment.Name?.trim() || "supplier-statement.bin";
      const contentType = attachment.ContentType?.trim() || "application/octet-stream";
      const storagePath = await storeAttachment(buffer, request.workspace_owner_id, name, contentType);
      attachments.push({
        file_name: name,
        content_type: contentType,
        size_bytes: buffer.byteLength,
        sha256: createHash("sha256").update(buffer).digest("hex"),
        storage_path: storagePath,
      });
    }
    const textualEvidence = `${payload.Subject ?? ""} ${payload.TextBody ?? ""} ${payload.HtmlBody ?? ""}`;
    const hasExactEvidence = attachments.some((attachment) =>
      exactPeriodEvidence(String(attachment.file_name), request.period_start, request.period_end))
      || exactPeriodEvidence(textualEvidence, request.period_start, request.period_end);
    const documentStatus = attachments.length === 0 ? null : hasExactEvidence ? "exact_period" : "needs_attention";
    const classification = attachments.length === 0 ? "reply" : documentStatus === "exact_period" ? "statement_document" : "ambiguous_document";
    const client = await db.connect();
    try {
      const inserted = await withTransaction(client, async () => {
        const inserted = await client.query(
          `INSERT INTO supplier_statement_inbound_messages
            (request_id, workspace_owner_id, channel, sender, body, attachment_url, provider_event_id,
             provider_message_id, subject, attachments, metadata, classification,
             document_status, received_at)
           VALUES ($1,$2,'email',$3,$4,$5,$6,$6,$7,$8::jsonb,$9::jsonb,$10,$11,now())
           ON CONFLICT DO NOTHING`,
          [
            request.id,
            request.workspace_owner_id,
            sender,
            payload.TextBody ?? payload.HtmlBody ?? null,
            attachments[0]?.storage_path ?? null,
            `email:${inboundId}`,
            payload.Subject?.trim() ?? null,
            JSON.stringify(attachments),
            JSON.stringify({ destination: destinationAddresses(payload), message_id: inboundId }),
            classification,
            documentStatus,
          ],
        );
        if ((inserted.rowCount ?? 0) === 0) return false;
        await client.query(
          `INSERT INTO supplier_statement_communication_events
            (request_id, workspace_owner_id, event_type, channel, provider_event_id, payload)
           VALUES ($1,$2,$3,'email',$4,$5::jsonb)
           ON CONFLICT DO NOTHING`,
          [
            request.id,
            request.workspace_owner_id,
            attachments.length ? "statement_document" : "replied",
            `email:${inboundId}`,
            JSON.stringify({ sender, subject: payload.Subject ?? null, attachment_count: attachments.length }),
          ],
        );
        return true;
      });
      if (!inserted) {
        res.status(202).json({ accepted: true, duplicate: true, request_id: request.id });
        return;
      }
    } finally {
      client.release();
    }
    if (documentStatus === "exact_period") {
      await markSupplierStatementReceivedById(request.id, request.workspace_owner_id, "resend_inbound", {
        message_id: inboundId,
        classification,
      });
    }
    res.status(202).json({ accepted: true, request_id: request.id, classification, attachment_count: attachments.length });
  } catch (error) {
    logger.error({ error, requestId, inboundId }, "supplier statement email inbound failed");
    res.status(503).json({ error: "temporarily_unavailable" });
  }
});

export default router;