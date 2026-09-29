import { Router, type Request, type Response, type NextFunction } from "express";
import { createHash, timingSafeEqual } from "crypto";
import multer from "multer";
import { db } from "../lib/db";
import { logger } from "../lib/logger";
import { storePdfToObjectStorage, runExtractionAndMatching } from "./marketplaceWebhook";

const router = Router();

const MAX_PDF_SIZE = 20 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PDF_SIZE },
});

function validateSecret(provided: string | undefined): boolean {
  const expected = process.env.MARKETPLACE_WEBHOOK_SECRET;
  if (!expected) {
    logger.warn("MARKETPLACE_WEBHOOK_SECRET not set — rejecting marketplace email inbound webhook");
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

/**
 * Extract the workspace owner ID from an inbound email To address.
 *
 * Supported formats:
 *   marketplace-reports+{ownerId}@<domain>
 *   marketplace+{ownerId}@<domain>
 *
 * Returns null if no workspace ID can be determined.
 */
function extractWorkspaceOwnerIdFromTo(toAddresses: string | string[]): string | null {
  const addresses = Array.isArray(toAddresses) ? toAddresses : [toAddresses];

  for (const addr of addresses) {
    const localPart = addr.replace(/<[^>]+>/, "").match(/([^@<>\s]+)@/);
    if (!localPart) continue;
    const local = localPart[1];

    const plusMatch = local.match(/^marketplace(?:-reports)?\+(.+)$/i);
    if (plusMatch) {
      return plusMatch[1].trim();
    }
  }

  return null;
}

// ── Format-specific payload types ────────────────────────────────────────────

interface PostmarkAttachment {
  Name: string;
  Content: string;
  ContentType: string;
  ContentLength?: number;
}

interface PostmarkInboundPayload {
  MessageID?: string;
  From?: string;
  To?: string | string[];
  ToFull?: Array<{ Email?: string; Name?: string }>;
  Subject?: string;
  Attachments?: PostmarkAttachment[];
  workspace_owner_id?: string;
}

/** Normalised attachment ready for processing */
interface NormalizedAttachment {
  name: string;
  buffer: Buffer;
}

/** Normalised inbound email envelope */
interface NormalizedEmail {
  messageId: string | null;
  workspaceOwnerId: string | null;
  attachments: NormalizedAttachment[];
}

// ── Postmark parser ───────────────────────────────────────────────────────────

function parsePostmark(body: PostmarkInboundPayload): NormalizedEmail {
  const toAddresses: string[] = [];
  if (body.ToFull && Array.isArray(body.ToFull)) {
    for (const entry of body.ToFull) {
      if (entry.Email) toAddresses.push(entry.Email);
    }
  }
  if (typeof body.To === "string") {
    toAddresses.push(body.To);
  } else if (Array.isArray(body.To)) {
    toAddresses.push(...body.To);
  }

  let workspaceOwnerId: string | null =
    typeof body.workspace_owner_id === "string" ? body.workspace_owner_id.trim() : null;
  if (!workspaceOwnerId && toAddresses.length > 0) {
    workspaceOwnerId = extractWorkspaceOwnerIdFromTo(toAddresses);
  }

  const rawAttachments = Array.isArray(body.Attachments) ? body.Attachments : [];
  const pdfAttachments = rawAttachments.filter((a) => {
    const isPdfContentType =
      typeof a.ContentType === "string" && a.ContentType.toLowerCase().includes("pdf");
    const isPdfName = typeof a.Name === "string" && a.Name.toLowerCase().endsWith(".pdf");
    return isPdfContentType || isPdfName;
  });

  const attachments: NormalizedAttachment[] = pdfAttachments.map((a) => ({
    name: a.Name,
    buffer: Buffer.from(a.Content ?? "", "base64"),
  }));

  return {
    messageId: typeof body.MessageID === "string" ? body.MessageID.trim() : null,
    workspaceOwnerId,
    attachments,
  };
}

// ── Mailgun parser ────────────────────────────────────────────────────────────
// Mailgun inbound parse sends multipart/form-data with:
//   recipient   — comma-separated To addresses
//   Message-Id  — RFC message ID
//   attachment-1, attachment-2, … — uploaded file fields

function parseMailgun(
  fields: Record<string, string>,
  files: Express.Multer.File[],
): NormalizedEmail {
  const recipientRaw: string = fields["recipient"] ?? fields["to"] ?? "";
  const recipients = recipientRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const workspaceOwnerId =
    recipients.length > 0 ? extractWorkspaceOwnerIdFromTo(recipients) : null;

  const messageId = fields["Message-Id"] ?? fields["message-id"] ?? null;

  // Mailgun names file fields attachment-1, attachment-2, …
  const pdfFiles = files.filter((f) => {
    const isPdfMime = f.mimetype.toLowerCase().includes("pdf");
    const isPdfName = f.originalname.toLowerCase().endsWith(".pdf");
    return isPdfMime || isPdfName;
  });

  return {
    messageId: messageId ? messageId.trim() : null,
    workspaceOwnerId,
    attachments: pdfFiles.map((f) => ({ name: f.originalname, buffer: f.buffer })),
  };
}

// ── SendGrid parser ───────────────────────────────────────────────────────────
// SendGrid inbound parse sends multipart/form-data with:
//   envelope    — JSON string: { "to": ["addr"], "from": "addr" }
//   headers     — raw headers string (contains Message-ID)
//   attachment1, attachment2, … — uploaded file fields

function parseHeaderMessageId(headersRaw: string): string | null {
  const match = headersRaw.match(/^Message-ID:\s*(.+)$/im);
  return match ? match[1].trim() : null;
}

function parseSendGrid(
  fields: Record<string, string>,
  files: Express.Multer.File[],
): NormalizedEmail {
  let toAddresses: string[] = [];
  let messageId: string | null = null;

  const envelopeRaw = fields["envelope"];
  if (envelopeRaw) {
    try {
      const envelope = JSON.parse(envelopeRaw) as { to?: string[]; from?: string };
      if (Array.isArray(envelope.to)) {
        toAddresses = envelope.to;
      }
    } catch {
      // ignore parse errors; toAddresses stays []
    }
  }

  const headersRaw = fields["headers"] ?? "";
  if (headersRaw) {
    messageId = parseHeaderMessageId(headersRaw);
  }

  const workspaceOwnerId =
    toAddresses.length > 0 ? extractWorkspaceOwnerIdFromTo(toAddresses) : null;

  // SendGrid names file fields attachment1, attachment2, …
  const pdfFiles = files.filter((f) => {
    const isPdfMime = f.mimetype.toLowerCase().includes("pdf");
    const isPdfName = f.originalname.toLowerCase().endsWith(".pdf");
    return isPdfMime || isPdfName;
  });

  return {
    messageId,
    workspaceOwnerId,
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

// ── Shared processing pipeline ────────────────────────────────────────────────

async function processNormalizedEmail(email: NormalizedEmail): Promise<void> {
  const { messageId: emailMessageId, workspaceOwnerId, attachments } = email;

  if (!workspaceOwnerId) return;

  for (const attachment of attachments) {
    try {
      const { name, buffer } = attachment;

      if (buffer.byteLength === 0) {
        logger.warn({ attachmentName: name }, "Marketplace email inbound: empty attachment buffer");
        continue;
      }

      if (buffer.byteLength > MAX_PDF_SIZE) {
        logger.warn(
          { attachmentName: name, size: buffer.byteLength },
          "Marketplace email inbound: PDF attachment exceeds size limit",
        );
        continue;
      }

      const sha256 = createHash("sha256").update(buffer).digest("hex");

      const dupBySha = await db.query<{ id: number }>(
        `SELECT id FROM marketplace_report_imports
          WHERE workspace_owner_id = $1
            AND pdf_sha256 = $2
            AND import_status != 'duplicate'
          LIMIT 1`,
        [workspaceOwnerId, sha256],
      );

      if (dupBySha.rows[0]) {
        logger.info(
          { sha256, existingId: dupBySha.rows[0].id },
          "Marketplace email inbound: duplicate PDF by SHA-256, skipping",
        );
        continue;
      }

      if (emailMessageId) {
        const dupByMsgId = await db.query<{ id: number }>(
          `SELECT id FROM marketplace_report_imports
            WHERE workspace_owner_id = $1
              AND email_message_id = $2
            LIMIT 1`,
          [workspaceOwnerId, emailMessageId],
        );
        if (dupByMsgId.rows[0]) {
          logger.info(
            { emailMessageId, existingId: dupByMsgId.rows[0].id },
            "Marketplace email inbound: duplicate PDF by message ID, skipping",
          );
          continue;
        }
      }

      let pdfStoragePath: string;
      try {
        pdfStoragePath = await storePdfToObjectStorage(buffer, sha256, workspaceOwnerId);
      } catch (err) {
        logger.error(
          { err, attachmentName: name },
          "Marketplace email inbound: failed to store PDF",
        );
        continue;
      }

      const insertResult = await db.query<{ id: number }>(
        `INSERT INTO marketplace_report_imports
           (workspace_owner_id, source_type, marketplace, import_status, pdf_storage_path, pdf_sha256, email_message_id)
         VALUES ($1, 'email_inbound', 'toters', 'pending', $2, $3, $4)
         RETURNING id`,
        [workspaceOwnerId, pdfStoragePath, sha256, emailMessageId],
      );

      const importId = insertResult.rows[0].id;

      logger.info(
        { importId, attachmentName: name, workspaceOwnerId },
        "Marketplace email inbound: created import record",
      );

      void runExtractionAndMatching(importId, buffer, workspaceOwnerId);
    } catch (err) {
      logger.error(
        { err, attachmentName: attachment.name, workspaceOwnerId },
        "Marketplace email inbound: unexpected error processing attachment",
      );
    }
  }
}

// ── Route ─────────────────────────────────────────────────────────────────────

/**
 * POST /webhooks/marketplace-email/inbound
 *
 * Inbound email webhook — auto-detects the payload format:
 *
 *   • application/json → Postmark (base64 attachments in Attachments[])
 *   • multipart/form-data → Mailgun or SendGrid inbound parse
 *       - Mailgun:   attachment-1, attachment-2, … file fields + recipient field
 *       - SendGrid:  attachment1, attachment2, … file fields + envelope JSON field
 *
 * The workspace is identified by parsing the recipient (To) address:
 *   marketplace-reports+{workspaceOwnerId}@<inbound-domain>
 *
 * Each PDF attachment found in the email is stored and queued for extraction
 * through the same pipeline as the direct PDF webhook.
 *
 * Authenticated via x-marketplace-secret (or x-webhook-secret) header.
 *
 * Setup (Postmark):
 *   1. Create an Inbound Domain in Postmark (e.g. inbound.presentail.com).
 *   2. Point the MX record for the domain to Postmark's inbound MX.
 *   3. Set the Inbound Webhook URL to:
 *        https://<your-domain>/api/webhooks/marketplace-email/inbound
 *      and add x-marketplace-secret as a custom header.
 *   4. Give each workspace owner a dedicated inbound address:
 *        marketplace-reports+<workspaceOwnerId>@inbound.presentail.com
 *
 * Setup (Mailgun):
 *   1. Enable Mailgun Inbound Routing or Routes to forward to this endpoint.
 *   2. Add x-marketplace-secret to the forwarded request headers.
 *   3. Mailgun sends multipart/form-data with file fields attachment-1, attachment-2, …
 *      and a recipient field for the To address.
 *
 * Setup (SendGrid):
 *   1. Enable SendGrid Inbound Parse Webhook pointing at this endpoint.
 *   2. Add x-marketplace-secret via a custom header in the route config if supported,
 *      or use an IP allowlist.
 *   3. SendGrid sends multipart/form-data with file fields attachment1, attachment2, …
 *      and an envelope JSON field containing the To/From addresses.
 */
router.post(
  "/webhooks/marketplace-email/inbound",
  conditionalMulter,
  async (req, res) => {
    const secret = (
      req.headers["x-marketplace-secret"] ?? req.headers["x-webhook-secret"]
    ) as string | undefined;

    if (!validateSecret(secret)) {
      res.status(401).json({ success: false, error: "Invalid or missing webhook secret" });
      return;
    }

    const contentType = (req.headers["content-type"] ?? "").toLowerCase();
    const isMultipart = contentType.startsWith("multipart/form-data");

    let email: NormalizedEmail;

    if (isMultipart) {
      // Collect text fields from multer
      const fields: Record<string, string> = {};
      for (const [key, val] of Object.entries(req.body as Record<string, unknown>)) {
        if (typeof val === "string") fields[key] = val;
      }
      const files = Array.isArray(req.files)
        ? (req.files as Express.Multer.File[])
        : Object.values(req.files ?? {}).flat() as Express.Multer.File[];

      // Distinguish Mailgun vs SendGrid by the presence of the `envelope` field
      if ("envelope" in fields) {
        email = parseSendGrid(fields, files);
      } else {
        email = parseMailgun(fields, files);
      }
    } else {
      // Default: Postmark JSON
      email = parsePostmark(req.body as PostmarkInboundPayload);
    }

    if (!email.workspaceOwnerId) {
      res.status(400).json({
        success: false,
        error:
          "Cannot determine workspace — address email to marketplace-reports+{workspaceOwnerId}@<inbound-domain> or include workspace_owner_id in the payload",
      });
      return;
    }

    if (email.attachments.length === 0) {
      logger.info(
        { messageId: email.messageId, workspaceOwnerId: email.workspaceOwnerId },
        "Marketplace email inbound: no PDF attachments found",
      );
      res.status(200).json({ success: true, message: "No PDF attachments found", imports: [] });
      return;
    }

    res.status(202).json({
      success: true,
      message: "Processing started",
      attachment_count: email.attachments.length,
    });

    void processNormalizedEmail(email);
  },
);

export default router;
