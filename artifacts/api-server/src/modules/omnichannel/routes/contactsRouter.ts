import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod/v4";
import { db } from "../../../lib/db";
import { logger } from "../../../lib/logger";
import { requireOmnichannelRole } from "../omnichannelAuth";
import type { WorkspaceRequest } from "../../../lib/workspace";

const router = Router();

const agentAuth = requireOmnichannelRole("omnichannel:agent");
const ownerAuth = requireOmnichannelRole("omnichannel:owner");

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const patchContactSchema = z.object({
  display_name: z.string().min(1).optional(),
  email: z.string().email().nullable().optional(),
  phone: z.string().nullable().optional(),
  language: z.string().nullable().optional(),
  timezone: z.string().nullable().optional(),
  is_blocked: z.boolean().optional(),
});

const addTagSchema = z.object({
  tag_id: z.number().int().positive(),
});

// ---------------------------------------------------------------------------
// GET /omnichannel/contacts
// ---------------------------------------------------------------------------
router.get(
  "/omnichannel/contacts",
  ...agentAuth,
  async (req: Request, res: Response): Promise<void> => {
    const { workspaceOwnerId } = req as WorkspaceRequest;

    const q = (req.query["q"] as string | undefined)?.trim() ?? "";
    const channelId = req.query["channel_id"]
      ? parseInt(req.query["channel_id"] as string, 10)
      : null;
    const tagId = req.query["tag_id"]
      ? parseInt(req.query["tag_id"] as string, 10)
      : null;
    const isBlocked = req.query["is_blocked"] === "true"
      ? true
      : req.query["is_blocked"] === "false"
        ? false
        : null;
    const limit = Math.min(parseInt((req.query["limit"] as string) ?? "50", 10), 200);
    const offset = Math.max(parseInt((req.query["offset"] as string) ?? "0", 10), 0);

    const conditions: string[] = ["ct.workspace_owner_id = $1"];
    const params: unknown[] = [workspaceOwnerId];
    let paramIdx = 2;

    if (q) {
      conditions.push(
        `(ct.display_name ILIKE $${paramIdx} OR ct.email ILIKE $${paramIdx} OR ct.phone ILIKE $${paramIdx})`,
      );
      params.push(`%${q}%`);
      paramIdx++;
    }

    if (channelId !== null && !isNaN(channelId)) {
      conditions.push(
        `EXISTS (SELECT 1 FROM omni_contact_identities ci WHERE ci.contact_id = ct.id AND ci.channel_account_id = $${paramIdx})`,
      );
      params.push(channelId);
      paramIdx++;
    }

    if (tagId !== null && !isNaN(tagId)) {
      conditions.push(
        `EXISTS (SELECT 1 FROM omni_contact_tags ctg WHERE ctg.contact_id = ct.id AND ctg.tag_id = $${paramIdx})`,
      );
      params.push(tagId);
      paramIdx++;
    }

    if (isBlocked !== null) {
      conditions.push(`ct.is_blocked = $${paramIdx}`);
      params.push(isBlocked);
      paramIdx++;
    }

    const where = conditions.join(" AND ");

    const [rowsResult, countResult] = await Promise.all([
      db.query<{
        id: number;
        display_name: string;
        email: string | null;
        phone: string | null;
        avatar_url: string | null;
        is_blocked: boolean;
        last_seen_at: Date | null;
        conversation_count: string;
        created_at: Date;
      }>(
        `SELECT ct.id, ct.display_name, ct.email, ct.phone, ct.avatar_url, ct.is_blocked,
                ct.updated_at AS last_seen_at,
                (SELECT COUNT(*) FROM omni_conversations c WHERE c.contact_id = ct.id) AS conversation_count,
                ct.created_at
         FROM omni_contacts ct
         WHERE ${where}
         ORDER BY ct.updated_at DESC NULLS LAST
         LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`,
        [...params, limit, offset],
      ),
      db.query<{ total: string }>(
        `SELECT COUNT(*) AS total FROM omni_contacts ct WHERE ${where}`,
        params,
      ),
    ]);

    res.json({
      success: true,
      contacts: rowsResult.rows.map((r) => ({
        ...r,
        conversation_count: parseInt(r.conversation_count, 10),
      })),
      total: parseInt(countResult.rows[0]?.total ?? "0", 10),
      limit,
      offset,
    });
  },
);

// ---------------------------------------------------------------------------
// GET /omnichannel/contacts/:id
// ---------------------------------------------------------------------------
router.get(
  "/omnichannel/contacts/:id",
  ...agentAuth,
  async (req: Request, res: Response): Promise<void> => {
    const { workspaceOwnerId } = req as WorkspaceRequest;
    const contactId = parseInt(String(req.params["id"] ?? ""), 10);

    if (isNaN(contactId)) {
      res.status(400).json({ error: "Invalid contact id" });
      return;
    }

    const [contactResult, identitiesResult, tagsResult, messagesResult] = await Promise.all([
      db.query<{
        id: number;
        display_name: string;
        email: string | null;
        phone: string | null;
        avatar_url: string | null;
        language: string | null;
        timezone: string | null;
        metadata: Record<string, unknown> | null;
        is_blocked: boolean;
        created_at: Date;
        updated_at: Date;
      }>(
        `SELECT id, display_name, email, phone, avatar_url, language, timezone,
                metadata, is_blocked, created_at, updated_at
         FROM omni_contacts
         WHERE id = $1 AND workspace_owner_id = $2`,
        [contactId, workspaceOwnerId],
      ),
      db.query<{
        id: number;
        provider: string;
        external_user_id: string;
        display_name: string | null;
        avatar_url: string | null;
        channel_account_id: number;
        channel_name: string;
        created_at: Date;
      }>(
        `SELECT ci.id, ci.provider, ci.external_user_id, ci.display_name, ci.avatar_url,
                ci.channel_account_id, ca.name AS channel_name, ci.created_at
         FROM omni_contact_identities ci
         JOIN omni_channel_accounts ca ON ca.id = ci.channel_account_id
         WHERE ci.contact_id = $1`,
        [contactId],
      ),
      db.query<{ id: number; name: string; color: string | null }>(
        `SELECT t.id, t.name, t.color
         FROM omni_contact_tags ctg
         JOIN omni_tags t ON t.id = ctg.tag_id
         WHERE ctg.contact_id = $1`,
        [contactId],
      ),
      db.query<{
        id: string;
        conversation_id: number;
        direction: string;
        message_type: string;
        content: string | null;
        status: string;
        sender_name: string | null;
        created_at: Date;
        channel_name: string | null;
        provider: string | null;
      }>(
        `SELECT m.id, m.conversation_id, m.direction, m.message_type,
                m.content, m.status, m.sender_name, m.created_at,
                ca.name AS channel_name, ca.provider
         FROM omni_messages m
         JOIN omni_conversations c ON c.id = m.conversation_id
         LEFT JOIN omni_channel_accounts ca ON ca.id = m.channel_account_id
         WHERE c.contact_id = $1
         ORDER BY m.created_at DESC
         LIMIT 200`,
        [contactId],
      ),
    ]);

    if (!contactResult.rows[0]) {
      res.status(404).json({ error: "Contact not found" });
      return;
    }

    res.json({
      success: true,
      contact: contactResult.rows[0],
      identities: identitiesResult.rows,
      tags: tagsResult.rows,
      timeline: messagesResult.rows,
    });
  },
);

// ---------------------------------------------------------------------------
// PATCH /omnichannel/contacts/:id
// ---------------------------------------------------------------------------
router.patch(
  "/omnichannel/contacts/:id",
  ...agentAuth,
  async (req: Request, res: Response): Promise<void> => {
    const { workspaceOwnerId } = req as WorkspaceRequest;
    const contactId = parseInt(String(req.params["id"] ?? ""), 10);

    if (isNaN(contactId)) {
      res.status(400).json({ error: "Invalid contact id" });
      return;
    }

    const parsed = patchContactSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
      return;
    }

    const data = parsed.data;
    const sets: string[] = [];
    const params: unknown[] = [contactId, workspaceOwnerId];
    let idx = 3;

    if (data.display_name !== undefined) { sets.push(`display_name = $${idx++}`); params.push(data.display_name); }
    if (data.email !== undefined) { sets.push(`email = $${idx++}`); params.push(data.email); }
    if (data.phone !== undefined) { sets.push(`phone = $${idx++}`); params.push(data.phone); }
    if (data.language !== undefined) { sets.push(`language = $${idx++}`); params.push(data.language); }
    if (data.timezone !== undefined) { sets.push(`timezone = $${idx++}`); params.push(data.timezone); }
    if (data.is_blocked !== undefined) { sets.push(`is_blocked = $${idx++}`); params.push(data.is_blocked); }

    if (sets.length === 0) {
      res.status(400).json({ error: "No fields to update" });
      return;
    }

    sets.push(`updated_at = NOW()`);

    const result = await db.query(
      `UPDATE omni_contacts SET ${sets.join(", ")}
       WHERE id = $1 AND workspace_owner_id = $2
       RETURNING id`,
      params,
    );

    if (result.rowCount === 0) {
      res.status(404).json({ error: "Contact not found" });
      return;
    }

    res.json({ success: true });
  },
);

// ---------------------------------------------------------------------------
// POST /omnichannel/contacts/:id/tags
// ---------------------------------------------------------------------------
router.post(
  "/omnichannel/contacts/:id/tags",
  ...agentAuth,
  async (req: Request, res: Response): Promise<void> => {
    const { workspaceOwnerId } = req as WorkspaceRequest;
    const contactId = parseInt(String(req.params["id"] ?? ""), 10);

    if (isNaN(contactId)) {
      res.status(400).json({ error: "Invalid contact id" });
      return;
    }

    const parsed = addTagSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
      return;
    }

    const { tag_id } = parsed.data;

    // Verify contact belongs to workspace
    const contactCheck = await db.query(
      `SELECT id FROM omni_contacts WHERE id = $1 AND workspace_owner_id = $2`,
      [contactId, workspaceOwnerId],
    );
    if (contactCheck.rowCount === 0) {
      res.status(404).json({ error: "Contact not found" });
      return;
    }

    // Verify tag belongs to workspace
    const tagCheck = await db.query(
      `SELECT id FROM omni_tags WHERE id = $1 AND workspace_owner_id = $2`,
      [tag_id, workspaceOwnerId],
    );
    if (tagCheck.rowCount === 0) {
      res.status(404).json({ error: "Tag not found" });
      return;
    }

    await db.query(
      `INSERT INTO omni_contact_tags (contact_id, tag_id)
       VALUES ($1, $2)
       ON CONFLICT (contact_id, tag_id) DO NOTHING`,
      [contactId, tag_id],
    );

    res.json({ success: true });
  },
);

// ---------------------------------------------------------------------------
// DELETE /omnichannel/contacts/:id/tags/:tagId
// ---------------------------------------------------------------------------
router.delete(
  "/omnichannel/contacts/:id/tags/:tagId",
  ...agentAuth,
  async (req: Request, res: Response): Promise<void> => {
    const { workspaceOwnerId } = req as WorkspaceRequest;
    const contactId = parseInt(String(req.params["id"] ?? ""), 10);
    const tagId = parseInt(String(req.params["tagId"] ?? ""), 10);

    if (isNaN(contactId) || isNaN(tagId)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    const contactCheck = await db.query(
      `SELECT id FROM omni_contacts WHERE id = $1 AND workspace_owner_id = $2`,
      [contactId, workspaceOwnerId],
    );
    if (contactCheck.rowCount === 0) {
      res.status(404).json({ error: "Contact not found" });
      return;
    }

    await db.query(
      `DELETE FROM omni_contact_tags WHERE contact_id = $1 AND tag_id = $2`,
      [contactId, tagId],
    );

    res.json({ success: true });
  },
);

// ---------------------------------------------------------------------------
// POST /omnichannel/contacts/:id/anonymize
// Owner-only: replaces PII fields with redacted placeholders (GDPR)
// ---------------------------------------------------------------------------
router.post(
  "/omnichannel/contacts/:id/anonymize",
  ...ownerAuth,
  async (req: Request, res: Response): Promise<void> => {
    const { workspaceOwnerId } = req as WorkspaceRequest;
    const contactId = parseInt(String(req.params["id"] ?? ""), 10);

    if (isNaN(contactId)) {
      res.status(400).json({ error: "Invalid contact id" });
      return;
    }

    const contactCheck = await db.query(
      `SELECT id FROM omni_contacts WHERE id = $1 AND workspace_owner_id = $2`,
      [contactId, workspaceOwnerId],
    );
    if (contactCheck.rowCount === 0) {
      res.status(404).json({ error: "Contact not found" });
      return;
    }

    // Anonymize contact PII
    await db.query(
      `UPDATE omni_contacts
       SET display_name = '[Anonymized]',
           email = NULL,
           phone = NULL,
           avatar_url = NULL,
           metadata = NULL,
           updated_at = NOW()
       WHERE id = $1`,
      [contactId],
    );

    // Redact message content for this contact's conversations
    await db.query(
      `UPDATE omni_messages
       SET content = '[Redacted]', media_url = NULL, metadata = NULL
       WHERE conversation_id IN (
         SELECT id FROM omni_conversations WHERE contact_id = $1
       )`,
      [contactId],
    );

    // Redact contact identity display names
    await db.query(
      `UPDATE omni_contact_identities
       SET display_name = '[Anonymized]', avatar_url = NULL, metadata = NULL
       WHERE contact_id = $1`,
      [contactId],
    );

    logger.info({ contactId, workspaceOwnerId }, "omnichannel: contact anonymized");

    res.json({ success: true });
  },
);

export default router;
