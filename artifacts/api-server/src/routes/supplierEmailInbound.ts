/**
 * POST /webhooks/supplier-email/inbound
 *
 * Inbound email webhook for supplier replies to Purchase Orders.
 *
 * When a supplier replies to a PO email (with PDF attachments), this endpoint:
 *   1. Identifies the workspace from the To address (po-reply+{workspaceOwnerId}@<domain>)
 *   2. Extracts the PO number from the email subject
 *   3. Matches the sender's email to a workspace supplier (contact_email)
 *   4. Finds the matching open Purchase Order
 *   5. Uploads each PDF attachment to object storage
 *   6. Appends the attachment URLs to purchase_orders.attachment_urls
 *   7. Logs a purchase_order_activity entry for each attached document
 *
 * Supports Postmark (JSON), Mailgun (multipart/form-data), and SendGrid (multipart/form-data).
 *
 * Authenticated via x-supplier-webhook-secret header.
 *
 * Setup (Postmark):
 *   1. Create an Inbound Domain (e.g. inbound.presentail.com).
 *   2. Set the Inbound Webhook URL to:
 *        https://<your-domain>/api/webhooks/supplier-email/inbound
 *      with x-supplier-webhook-secret custom header.
 *   3. Give each workspace owner a dedicated inbound address:
 *        po-reply+<workspaceOwnerId>@inbound.presentail.com
 *   4. Configure outbound PO emails to use Reply-To pointing at this address.
 */

import { Router, type Request, type Response, type NextFunction } from "express";
import { timingSafeEqual, createHash } from "crypto";
import multer from "multer";
import { db } from "../lib/db";
import { logger } from "../lib/logger";
import { objectStorageClient } from "../lib/objectStorage";

const router = Router();

const MAX_PDF_SIZE = 20 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PDF_SIZE },
});

// ── Auth ──────────────────────────────────────────────────────────────────────

function validateSecret(provided: string | undefined): boolean {
  const expected = process.env.SUPPLIER_WEBHOOK_SECRET;
  if (!expected) {
    logger.warn(
      "SUPPLIER_WEBHOOK_SECRET not set — rejecting supplier email inbound webhook",
    );
    return false;
  }
  if (!provided) return false;
  try {
    const expBuf = Buffer.from(expected, "utf8");
    const provBuf = Buffer.from(provided, "utf8");
    if (expBuf.length !== provBuf.length) return false;
    return timingSafeEqual(expBuf, provBuf);
  } catch {
    return false;
  }
}

// ── Workspace extraction from To address ─────────────────────────────────────

/**
 * Extract workspace owner ID from a To address.
 * Supported formats:
 *   po-reply+{ownerId}@<domain>
 *   po+{ownerId}@<domain>
 */
function extractWorkspaceOwnerIdFromTo(toAddresses: string | string[]): string | null {
  const addresses = Array.isArray(toAddresses) ? toAddresses : [toAddresses];
  for (const addr of addresses) {
    const localPart = addr.replace(/<[^>]+>/, "").match(/([^@<>\s]+)@/);
    if (!localPart) continue;
    const local = localPart[1];
    const match = local.match(/^po(?:-reply)?\+(.+)$/i);
    if (match) return match[1].trim();
  }
  return null;
}

// ── PO number extraction from subject ────────────────────────────────────────

/**
 * Extract a PO reference token and its numeric ID from an email subject.
 * Looks for patterns like:
 *   "Re: PO-0042 order confirmation"
 *   "Purchase Order PO0042"
 *   "PO 42 - Invoice"
 *
 * Returns { token: "PO-0042", numericId: 42 } or null if not found.
 */
function extractPoRefFromSubject(
  subject: string,
): { token: string; numericId: number } | null {
  const match = subject.match(/\bPO[-\s]?(\d+)\b/i);
  if (!match) return null;
  const numericId = parseInt(match[1], 10);
  if (isNaN(numericId)) return null;
  return { token: match[0].replace(/\s+/g, "-").toUpperCase(), numericId };
}

/**
 * Normalise a raw "From" header value to a plain lowercase email address.
 * Handles "Name <email@example.com>" and bare "email@example.com" forms.
 */
function extractEmailAddress(raw: string): string {
  const angleMatch = raw.match(/<([^>]+)>/);
  const addr = angleMatch ? angleMatch[1] : raw;
  return addr.trim().toLowerCase();
}

// ── Payload types ─────────────────────────────────────────────────────────────

interface PostmarkAttachment {
  Name: string;
  Content: string;
  ContentType: string;
}

interface PostmarkPayload {
  MessageID?: string;
  From?: string;
  To?: string | string[];
  ToFull?: Array<{ Email?: string; Name?: string }>;
  Subject?: string;
  Attachments?: PostmarkAttachment[];
  workspace_owner_id?: string;
}

interface NormalizedAttachment {
  name: string;
  buffer: Buffer;
}

interface NormalizedEmail {
  messageId: string | null;
  workspaceOwnerId: string | null;
  from: string | null;
  subject: string | null;
  attachments: NormalizedAttachment[];
}

// ── Postmark parser ───────────────────────────────────────────────────────────

function parsePostmark(body: PostmarkPayload): NormalizedEmail {
  const toAddresses: string[] = [];
  if (Array.isArray(body.ToFull)) {
    for (const entry of body.ToFull) {
      if (entry.Email) toAddresses.push(entry.Email);
    }
  }
  if (typeof body.To === "string") toAddresses.push(body.To);
  else if (Array.isArray(body.To)) toAddresses.push(...body.To);

  let workspaceOwnerId: string | null =
    typeof body.workspace_owner_id === "string" ? body.workspace_owner_id.trim() : null;
  if (!workspaceOwnerId && toAddresses.length > 0) {
    workspaceOwnerId = extractWorkspaceOwnerIdFromTo(toAddresses);
  }

  const from =
    typeof body.From === "string" ? extractEmailAddress(body.From) : null;
  const subject = typeof body.Subject === "string" ? body.Subject.trim() : null;

  const rawAttachments = Array.isArray(body.Attachments) ? body.Attachments : [];
  const pdfAttachments = rawAttachments.filter((a) => {
    const isPdfContentType =
      typeof a.ContentType === "string" && a.ContentType.toLowerCase().includes("pdf");
    const isPdfName = typeof a.Name === "string" && a.Name.toLowerCase().endsWith(".pdf");
    return isPdfContentType || isPdfName;
  });

  return {
    messageId: typeof body.MessageID === "string" ? body.MessageID.trim() : null,
    workspaceOwnerId,
    from,
    subject,
    attachments: pdfAttachments.map((a) => ({
      name: a.Name,
      buffer: Buffer.from(a.Content ?? "", "base64"),
    })),
  };
}

// ── Mailgun parser ────────────────────────────────────────────────────────────

function parseMailgun(
  fields: Record<string, string>,
  files: Express.Multer.File[],
): NormalizedEmail {
  const recipientRaw = fields["recipient"] ?? fields["to"] ?? "";
  const recipients = recipientRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const workspaceOwnerId =
    recipients.length > 0 ? extractWorkspaceOwnerIdFromTo(recipients) : null;

  const messageId = fields["Message-Id"] ?? fields["message-id"] ?? null;

  const fromRaw = fields["sender"] ?? fields["from"] ?? null;
  const from = fromRaw ? extractEmailAddress(fromRaw) : null;
  const subject = fields["subject"] ?? null;

  const pdfFiles = files.filter((f) => {
    const isPdfMime = f.mimetype.toLowerCase().includes("pdf");
    const isPdfName = f.originalname.toLowerCase().endsWith(".pdf");
    return isPdfMime || isPdfName;
  });

  return {
    messageId: messageId ? messageId.trim() : null,
    workspaceOwnerId,
    from,
    subject: subject ? subject.trim() : null,
    attachments: pdfFiles.map((f) => ({ name: f.originalname, buffer: f.buffer })),
  };
}

// ── SendGrid parser ───────────────────────────────────────────────────────────

function parseHeaderMessageId(headersRaw: string): string | null {
  const match = headersRaw.match(/^Message-ID:\s*(.+)$/im);
  return match ? match[1].trim() : null;
}

function parseSendGrid(
  fields: Record<string, string>,
  files: Express.Multer.File[],
): NormalizedEmail {
  let toAddresses: string[] = [];
  let from: string | null = null;
  let messageId: string | null = null;

  const envelopeRaw = fields["envelope"];
  if (envelopeRaw) {
    try {
      const envelope = JSON.parse(envelopeRaw) as { to?: string[]; from?: string };
      if (Array.isArray(envelope.to)) toAddresses = envelope.to;
      if (typeof envelope.from === "string") from = extractEmailAddress(envelope.from);
    } catch {
      // ignore parse errors
    }
  }

  const headersRaw = fields["headers"] ?? "";
  if (headersRaw) messageId = parseHeaderMessageId(headersRaw);

  const subject = fields["subject"] ?? null;
  const workspaceOwnerId =
    toAddresses.length > 0 ? extractWorkspaceOwnerIdFromTo(toAddresses) : null;

  const pdfFiles = files.filter((f) => {
    const isPdfMime = f.mimetype.toLowerCase().includes("pdf");
    const isPdfName = f.originalname.toLowerCase().endsWith(".pdf");
    return isPdfMime || isPdfName;
  });

  return {
    messageId,
    workspaceOwnerId,
    from,
    subject: subject ? subject.trim() : null,
    attachments: pdfFiles.map((f) => ({ name: f.originalname, buffer: f.buffer })),
  };
}

// ── Conditional multer middleware ─────────────────────────────────────────────

function conditionalMulter(req: Request, res: Response, next: NextFunction): void {
  const ct = (req.headers["content-type"] ?? "").toLowerCase();
  if (ct.startsWith("multipart/form-data")) {
    upload.any()(req, res, next);
  } else {
    next();
  }
}

// ── PDF storage ───────────────────────────────────────────────────────────────

async function storePdfAttachment(
  buffer: Buffer,
  sha256: string,
  workspaceOwnerId: string,
): Promise<string> {
  const privateObjectDir = process.env.PRIVATE_OBJECT_DIR;
  if (!privateObjectDir) throw new Error("PRIVATE_OBJECT_DIR not set");

  const fullPath = `${privateObjectDir}/${workspaceOwnerId}/po-attachments/${sha256}.pdf`;
  const parts = fullPath.startsWith("/") ? fullPath.slice(1).split("/") : fullPath.split("/");
  if (parts.length < 2) throw new Error("Invalid PRIVATE_OBJECT_DIR path");

  const bucketName = parts[0];
  const objectName = parts.slice(1).join("/");
  const bucket = objectStorageClient.bucket(bucketName);
  const file = bucket.file(objectName);

  const [exists] = await file.exists();
  if (!exists) {
    await file.save(buffer, { contentType: "application/pdf", resumable: false });
  }

  return `/objects/${workspaceOwnerId}/po-attachments/${sha256}.pdf`;
}

// ── Core processing pipeline ──────────────────────────────────────────────────

async function processSupplierEmail(email: NormalizedEmail): Promise<void> {
  const { workspaceOwnerId, from, subject, attachments } = email;

  if (!workspaceOwnerId) return;

  if (!from) {
    logger.info(
      { workspaceOwnerId },
      "Supplier email inbound: no sender address, skipping",
    );
    return;
  }

  if (!subject) {
    logger.info(
      { workspaceOwnerId, from },
      "Supplier email inbound: no subject, cannot match PO, skipping",
    );
    return;
  }

  const poRef = extractPoRefFromSubject(subject);
  if (!poRef) {
    logger.info(
      { workspaceOwnerId, from, subject },
      "Supplier email inbound: no PO reference found in subject, skipping",
    );
    return;
  }

  // Match supplier by contact_email (case-insensitive)
  const supplierResult = await db.query<{ id: number; name: string }>(
    `SELECT id, name
       FROM suppliers
      WHERE workspace_owner_id = $1
        AND LOWER(contact_email) = $2
        AND is_archived = false
      LIMIT 1`,
    [workspaceOwnerId, from],
  );

  if (!supplierResult.rows[0]) {
    logger.info(
      { workspaceOwnerId, from, subject },
      "Supplier email inbound: no active supplier matched sender address, skipping",
    );
    return;
  }

  const supplier = supplierResult.rows[0];

  // Find the matching open PO.
  // Match by po_number (freeform user-set value) or by system-generated label (PO-NNNN).
  const poResult = await db.query<{ id: number; po_number: string | null; attachment_urls: string | null }>(
    `SELECT id, po_number, attachment_urls
       FROM purchase_orders
      WHERE workspace_owner_id = $1
        AND supplier_id = $2
        AND status NOT IN ('cancelled', 'rejected')
        AND (
          LOWER(po_number) = LOWER($3)
          OR id = $4
        )
      ORDER BY created_at DESC
      LIMIT 1`,
    [workspaceOwnerId, supplier.id, poRef.token, poRef.numericId],
  );

  if (!poResult.rows[0]) {
    logger.info(
      { workspaceOwnerId, from, subject, poRef, supplierId: supplier.id },
      "Supplier email inbound: no matching open PO found, skipping",
    );
    return;
  }

  const po = poResult.rows[0];
  const poId = po.id;

  logger.info(
    { workspaceOwnerId, poId, supplierId: supplier.id, attachmentCount: attachments.length },
    "Supplier email inbound: matched PO, processing attachments",
  );

  for (const attachment of attachments) {
    try {
      const { name, buffer } = attachment;

      if (buffer.byteLength === 0) {
        logger.warn(
          { attachmentName: name, poId },
          "Supplier email inbound: empty attachment buffer, skipping",
        );
        continue;
      }

      if (buffer.byteLength > MAX_PDF_SIZE) {
        logger.warn(
          { attachmentName: name, size: buffer.byteLength, poId },
          "Supplier email inbound: attachment exceeds size limit, skipping",
        );
        continue;
      }

      const sha256 = createHash("sha256").update(buffer).digest("hex");

      let storagePath: string;
      try {
        storagePath = await storePdfAttachment(buffer, sha256, workspaceOwnerId);
      } catch (err) {
        logger.error(
          { err, attachmentName: name, poId },
          "Supplier email inbound: failed to store PDF attachment",
        );
        continue;
      }

      // Append URL to purchase_orders.attachment_urls (stored as JSON array string)
      const existingUrls: string[] = (() => {
        if (!po.attachment_urls) return [];
        try {
          const parsed = JSON.parse(po.attachment_urls);
          return Array.isArray(parsed) ? parsed : [];
        } catch {
          return [];
        }
      })();

      if (!existingUrls.includes(storagePath)) {
        existingUrls.push(storagePath);
      }

      await db.query(
        `UPDATE purchase_orders
            SET attachment_urls = $1,
                updated_at      = now()
          WHERE id = $2`,
        [JSON.stringify(existingUrls), poId],
      );

      // Refresh local copy of attachment_urls for subsequent attachments in this email
      po.attachment_urls = JSON.stringify(existingUrls);

      // Insert activity log entry
      await db.query(
        `INSERT INTO purchase_order_activity
           (purchase_order_id, workspace_owner_id, event_type, description, metadata)
         VALUES ($1, $2, 'supplier_document_attached', $3, $4)`,
        [
          poId,
          workspaceOwnerId,
          `Document "${name}" received from ${supplier.name} and attached to PO.`,
          JSON.stringify({
            file_name: name,
            storage_path: storagePath,
            sender_email: from,
            supplier_id: supplier.id,
            supplier_name: supplier.name,
          }),
        ],
      );

      logger.info(
        { poId, attachmentName: name, storagePath, workspaceOwnerId },
        "Supplier email inbound: attachment stored and PO updated",
      );
    } catch (err) {
      logger.error(
        { err, attachmentName: attachment.name, poId, workspaceOwnerId },
        "Supplier email inbound: unexpected error processing attachment",
      );
    }
  }
}

// ── Route ─────────────────────────────────────────────────────────────────────

router.post(
  "/webhooks/supplier-email/inbound",
  conditionalMulter,
  async (req, res) => {
    const secret = (
      req.headers["x-supplier-webhook-secret"] ?? req.headers["x-webhook-secret"]
    ) as string | undefined;

    if (!validateSecret(secret)) {
      res.status(401).json({ success: false, error: "Invalid or missing webhook secret" });
      return;
    }

    const contentType = (req.headers["content-type"] ?? "").toLowerCase();
    const isMultipart = contentType.startsWith("multipart/form-data");

    let email: NormalizedEmail;

    if (isMultipart) {
      const fields: Record<string, string> = {};
      for (const [key, val] of Object.entries(req.body as Record<string, unknown>)) {
        if (typeof val === "string") fields[key] = val;
      }
      const files = Array.isArray(req.files)
        ? (req.files as Express.Multer.File[])
        : Object.values(req.files ?? {}).flat() as Express.Multer.File[];

      if ("envelope" in fields) {
        email = parseSendGrid(fields, files);
      } else {
        email = parseMailgun(fields, files);
      }
    } else {
      email = parsePostmark(req.body as PostmarkPayload);
    }

    if (!email.workspaceOwnerId) {
      res.status(400).json({
        success: false,
        error:
          "Cannot determine workspace — address email to po-reply+{workspaceOwnerId}@<inbound-domain> or include workspace_owner_id in the payload",
      });
      return;
    }

    if (email.attachments.length === 0) {
      logger.info(
        { messageId: email.messageId, workspaceOwnerId: email.workspaceOwnerId },
        "Supplier email inbound: no PDF attachments found",
      );
      res.status(200).json({ success: true, message: "No PDF attachments found" });
      return;
    }

    res.status(202).json({
      success: true,
      message: "Processing started",
      attachment_count: email.attachments.length,
    });

    void processSupplierEmail(email);
  },
);

export default router;
