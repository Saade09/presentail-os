import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod/v4";
import { db } from "../../../lib/db";
import { logger } from "../../../lib/logger";
import { requireOmnichannelRole } from "../omnichannelAuth";
import { workspace } from "../../../lib/workspace";
import * as outboundQueue from "../queue/outboundQueue";
import { ProviderMessageWindowError } from "../errors";
import type { OmniProvider, OmniMessageType } from "../types";
import { sseBus } from "../sseBus";

const router = Router();

const agentAuth = requireOmnichannelRole("omnichannel:agent");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getConversationRow(id: number, workspaceOwnerId: string) {
  const result = await db.query<{
    id: number;
    workspace_owner_id: string;
    channel_account_id: number;
    channel_provider: string;
    channel_name: string;
    contact_id: number;
    contact_display_name: string;
    contact_avatar_url: string | null;
    assigned_agent_id: string | null;
    assigned_team_id: number | null;
    status: string;
    subject: string | null;
    last_message_at: Date | null;
    resolved_at: Date | null;
    snoozed_until: Date | null;
    metadata: Record<string, unknown> | null;
    created_at: Date;
    updated_at: Date;
  }>(
    `SELECT c.*,
            ca.provider AS channel_provider,
            ca.name AS channel_name,
            ct.display_name AS contact_display_name,
            ct.avatar_url AS contact_avatar_url
     FROM omni_conversations c
     JOIN omni_channel_accounts ca ON ca.id = c.channel_account_id
     JOIN omni_contacts ct ON ct.id = c.contact_id
     WHERE c.id = $1 AND c.workspace_owner_id = $2`,
    [id, workspaceOwnerId],
  );
  return result.rows[0] ?? null;
}

function metadataBool(
  meta: Record<string, unknown> | null,
  key: string,
): boolean {
  if (!meta) return false;
  return meta[key] === true;
}

async function enrichConversation(row: Awaited<ReturnType<typeof getConversationRow>>) {
  if (!row) return null;

  const tagsResult = await db.query<{ name: string }>(
    `SELECT t.name FROM omni_conversation_tags ct
     JOIN omni_tags t ON t.id = ct.tag_id
     WHERE ct.conversation_id = $1`,
    [row.id],
  );

  const snippet = await db.query<{ content: string | null; direction: string }>(
    `SELECT content, direction FROM omni_messages
     WHERE conversation_id = $1
     ORDER BY created_at DESC LIMIT 1`,
    [row.id],
  );

  const unreadResult = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM omni_messages
     WHERE conversation_id = $1 AND direction = 'inbound' AND read_at IS NULL`,
    [row.id],
  );

  const lastMsg = snippet.rows[0];

  return {
    id: row.id,
    workspace_owner_id: row.workspace_owner_id,
    channel_account_id: row.channel_account_id,
    channel_provider: row.channel_provider,
    channel_name: row.channel_name,
    contact_id: row.contact_id,
    contact_display_name: row.contact_display_name,
    contact_avatar_url: row.contact_avatar_url,
    assigned_agent_id: row.assigned_agent_id,
    assigned_team_id: row.assigned_team_id,
    status: row.status,
    priority: (row.metadata as Record<string, unknown> | null)?.priority as string | null ?? null,
    subject: row.subject,
    last_message_at: row.last_message_at?.toISOString() ?? null,
    last_message_snippet: lastMsg?.content
      ? lastMsg.content.slice(0, 120)
      : null,
    unread_count: parseInt(unreadResult.rows[0]?.count ?? "0", 10),
    tags: tagsResult.rows.map((t) => t.name),
    automation_paused: metadataBool(row.metadata as Record<string, unknown> | null, "automation_paused"),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// GET /omnichannel/conversations
// ---------------------------------------------------------------------------
router.get("/omnichannel/conversations", agentAuth, async (req: Request, res: Response) => {
  try {
    const wreq = workspace(req);
    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10));
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? "25"), 10)));
    const offset = (page - 1) * limit;

    const conditions: string[] = ["c.workspace_owner_id = $1"];
    const params: unknown[] = [wreq.workspaceOwnerId];
    let pIdx = 2;

    if (req.query.status) {
      conditions.push(`c.status = $${pIdx++}`);
      params.push(req.query.status);
    }
    if (req.query.channel_account_id) {
      conditions.push(`c.channel_account_id = $${pIdx++}`);
      params.push(Number(req.query.channel_account_id));
    }
    if (req.query.assigned_agent_id) {
      conditions.push(`c.assigned_agent_id = $${pIdx++}`);
      params.push(req.query.assigned_agent_id);
    }
    if (req.query.priority) {
      conditions.push(`c.metadata->>'priority' = $${pIdx++}`);
      params.push(req.query.priority);
    }
    if (req.query.tag) {
      conditions.push(
        `EXISTS (SELECT 1 FROM omni_conversation_tags ct2 JOIN omni_tags tg ON tg.id = ct2.tag_id WHERE ct2.conversation_id = c.id AND tg.name = $${pIdx++})`,
      );
      params.push(req.query.tag);
    }

    const where = conditions.join(" AND ");

    const countResult = await db.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM omni_conversations c WHERE ${where}`,
      params,
    );
    const total = parseInt(countResult.rows[0]?.count ?? "0", 10);

    const rowsResult = await db.query<{ id: number }>(
      `SELECT c.id FROM omni_conversations c
       WHERE ${where}
       ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC
       LIMIT $${pIdx++} OFFSET $${pIdx++}`,
      [...params, limit, offset],
    );

    const conversations = await Promise.all(
      rowsResult.rows.map(async (r) => {
        const row = await getConversationRow(r.id, wreq.workspaceOwnerId);
        return enrichConversation(row);
      }),
    );

    res.json({ conversations: conversations.filter(Boolean), total, page, limit });
  } catch (err) {
    logger.error({ err }, "Failed to list omnichannel conversations");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /omnichannel/conversations/:id
// ---------------------------------------------------------------------------
router.get("/omnichannel/conversations/:id", agentAuth, async (req: Request, res: Response) => {
  try {
    const wreq = workspace(req);
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid conversation id" }); return; }

    const row = await getConversationRow(id, wreq.workspaceOwnerId);
    if (!row) { res.status(404).json({ error: "Conversation not found" }); return; }

    const conversation = await enrichConversation(row);

    const messagesResult = await db.query(
      `SELECT id, conversation_id, direction, message_type, content, media_url, media_mime_type,
              sender_name, sender_agent_id, status, error_code, error_message,
              template_name, template_params,
              sent_at, delivered_at, read_at, created_at
       FROM omni_messages
       WHERE conversation_id = $1
       ORDER BY created_at ASC`,
      [id],
    );

    const notesResult = await db.query(
      `SELECT id, conversation_id, author_id, author_name, content, created_at
       FROM omni_internal_notes
       WHERE conversation_id = $1
       ORDER BY created_at ASC`,
      [id],
    );

    const identitiesResult = await db.query(
      `SELECT ci.provider, ci.external_user_id, ci.display_name
       FROM omni_contact_identities ci
       JOIN omni_conversations c ON c.contact_id = ci.contact_id
       WHERE c.id = $1`,
      [id],
    );

    res.json({
      conversation,
      messages: messagesResult.rows,
      notes: notesResult.rows,
      contact_identities: identitiesResult.rows,
    });
  } catch (err) {
    logger.error({ err }, "Failed to get omnichannel conversation");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// PATCH /omnichannel/conversations/:id
// ---------------------------------------------------------------------------
const PatchSchema = z.object({
  subject: z.string().nullable().optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).nullable().optional(),
  snoozed_until: z.string().nullable().optional(),
});

router.patch("/omnichannel/conversations/:id", agentAuth, async (req: Request, res: Response) => {
  try {
    const wreq = workspace(req);
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid conversation id" }); return; }

    const parsed = PatchSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Validation error", issues: parsed.error.issues }); return; }

    const row = await getConversationRow(id, wreq.workspaceOwnerId);
    if (!row) { res.status(404).json({ error: "Conversation not found" }); return; }

    const updates: string[] = [];
    const params: unknown[] = [];
    let pIdx = 1;

    if (parsed.data.subject !== undefined) {
      updates.push(`subject = $${pIdx++}`);
      params.push(parsed.data.subject);
    }
    if (parsed.data.snoozed_until !== undefined) {
      updates.push(`snoozed_until = $${pIdx++}`);
      params.push(parsed.data.snoozed_until);
    }
    if (parsed.data.priority !== undefined) {
      updates.push(`metadata = COALESCE(metadata, '{}'::jsonb) || $${pIdx++}::jsonb`);
      params.push(JSON.stringify({ priority: parsed.data.priority }));
    }

    if (updates.length > 0) {
      updates.push(`updated_at = NOW()`);
      params.push(wreq.workspaceOwnerId, id);
      await db.query(
        `UPDATE omni_conversations SET ${updates.join(", ")} WHERE workspace_owner_id = $${pIdx++} AND id = $${pIdx++}`,
        params,
      );
    }

    const updatedRow = await getConversationRow(id, wreq.workspaceOwnerId);
    const conversation = await enrichConversation(updatedRow);
    const messagesResult = await db.query(`SELECT * FROM omni_messages WHERE conversation_id = $1 ORDER BY created_at ASC`, [id]);
    const notesResult = await db.query(`SELECT * FROM omni_internal_notes WHERE conversation_id = $1 ORDER BY created_at ASC`, [id]);
    const identitiesResult = await db.query(
      `SELECT ci.provider, ci.external_user_id, ci.display_name FROM omni_contact_identities ci JOIN omni_conversations c ON c.contact_id = ci.contact_id WHERE c.id = $1`,
      [id],
    );

    sseBus.push({
      type: "conversation_updated",
      conversation_id: id,
      workspace_owner_id: wreq.workspaceOwnerId,
    });

    res.json({ conversation, messages: messagesResult.rows, notes: notesResult.rows, contact_identities: identitiesResult.rows });
  } catch (err) {
    logger.error({ err }, "Failed to patch omnichannel conversation");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /omnichannel/conversations/:id/messages
// ---------------------------------------------------------------------------
const SendMessageSchema = z.object({
  content: z.string().min(1),
  message_type: z.string().default("text"),
});

router.post("/omnichannel/conversations/:id/messages", agentAuth, async (req: Request, res: Response) => {
  try {
    const wreq = workspace(req);
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid conversation id" }); return; }

    const parsed = SendMessageSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Validation error", issues: parsed.error.issues }); return; }

    const row = await getConversationRow(id, wreq.workspaceOwnerId);
    if (!row) { res.status(404).json({ error: "Conversation not found" }); return; }

    const identityResult = await db.query<{ external_user_id: string }>(
      `SELECT ci.external_user_id FROM omni_contact_identities ci
       WHERE ci.contact_id = $1 AND ci.channel_account_id = $2
       LIMIT 1`,
      [row.contact_id, row.channel_account_id],
    );
    const recipientExternalId = identityResult.rows[0]?.external_user_id;
    if (!recipientExternalId) {
      res.status(400).json({ error: "No known external identity for this contact on this channel" });
      return;
    }

    const msgInsert = await db.query<{ id: string }>(
      `INSERT INTO omni_messages
         (conversation_id, workspace_owner_id, direction, message_type, content, sender_agent_id, sender_name, status, created_at)
       VALUES ($1, $2, 'outbound', $3, $4, $5, $6, 'queued', NOW())
       RETURNING id`,
      [
        id,
        wreq.workspaceOwnerId,
        parsed.data.message_type,
        parsed.data.content,
        wreq.userId,
        wreq.userId,
      ],
    );
    const messageId = msgInsert.rows[0].id;

    try {
      await outboundQueue.enqueue({
        channelAccountId: row.channel_account_id,
        conversationId: id,
        messageId,
        recipientExternalId,
        payload: {
          messageType: "text" as OmniMessageType,
          content: parsed.data.content,
        },
        provider: row.channel_provider as OmniProvider,
      });
    } catch (queueErr) {
      if (queueErr instanceof ProviderMessageWindowError) {
        res.status(400).json({ error: queueErr.message });
        return;
      }
      throw queueErr;
    }

    await db.query(
      `UPDATE omni_conversations SET last_message_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [id],
    );

    await db.query(
      `INSERT INTO omni_audit_logs (workspace_owner_id, actor_id, actor_type, action, resource_type, resource_id)
       VALUES ($1, $2, 'agent', 'message_sent', 'conversation', $3)`,
      [wreq.workspaceOwnerId, wreq.userId, String(id)],
    );

    const msgResult = await db.query(
      `SELECT * FROM omni_messages WHERE id = $1`,
      [messageId],
    );

    sseBus.push({
      type: "conversation_updated",
      conversation_id: id,
      workspace_owner_id: wreq.workspaceOwnerId,
    });

    res.status(201).json({ message: msgResult.rows[0] });
  } catch (err) {
    logger.error({ err }, "Failed to send omnichannel message");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /omnichannel/conversations/:id/notes
// ---------------------------------------------------------------------------
const NoteSchema = z.object({
  content: z.string().min(1),
});

router.post("/omnichannel/conversations/:id/notes", agentAuth, async (req: Request, res: Response) => {
  try {
    const wreq = workspace(req);
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid conversation id" }); return; }

    const parsed = NoteSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Validation error", issues: parsed.error.issues }); return; }

    const row = await getConversationRow(id, wreq.workspaceOwnerId);
    if (!row) { res.status(404).json({ error: "Conversation not found" }); return; }

    const noteResult = await db.query<{ id: number }>(
      `INSERT INTO omni_internal_notes (conversation_id, author_id, author_name, content)
       VALUES ($1, $2, $2, $3)
       RETURNING id, conversation_id, author_id, author_name, content, created_at`,
      [id, wreq.userId, parsed.data.content],
    );

    sseBus.push({
      type: "conversation_updated",
      conversation_id: id,
      workspace_owner_id: wreq.workspaceOwnerId,
    });

    res.status(201).json({ note: noteResult.rows[0] });
  } catch (err) {
    logger.error({ err }, "Failed to add omnichannel note");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /omnichannel/conversations/:id/assign
// ---------------------------------------------------------------------------
const AssignSchema = z.object({
  assigned_agent_id: z.string().nullable().optional(),
  assigned_team_id: z.number().nullable().optional(),
});

router.post("/omnichannel/conversations/:id/assign", agentAuth, async (req: Request, res: Response) => {
  try {
    const wreq = workspace(req);
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid conversation id" }); return; }

    const parsed = AssignSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Validation error", issues: parsed.error.issues }); return; }

    const row = await getConversationRow(id, wreq.workspaceOwnerId);
    if (!row) { res.status(404).json({ error: "Conversation not found" }); return; }

    await db.query(
      `UPDATE omni_conversations
       SET assigned_agent_id = $1, assigned_team_id = $2, updated_at = NOW()
       WHERE id = $3 AND workspace_owner_id = $4`,
      [
        parsed.data.assigned_agent_id ?? null,
        parsed.data.assigned_team_id ?? null,
        id,
        wreq.workspaceOwnerId,
      ],
    );

    await db.query(
      `INSERT INTO omni_audit_logs (workspace_owner_id, actor_id, actor_type, action, resource_type, resource_id, metadata)
       VALUES ($1, $2, 'agent', 'conversation_assigned', 'conversation', $3, $4)`,
      [
        wreq.workspaceOwnerId,
        wreq.userId,
        String(id),
        JSON.stringify({ assigned_agent_id: parsed.data.assigned_agent_id ?? null }),
      ],
    );

    sseBus.push({
      type: "conversation_updated",
      conversation_id: id,
      workspace_owner_id: wreq.workspaceOwnerId,
    });

    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Failed to assign omnichannel conversation");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /omnichannel/conversations/:id/resolve
// ---------------------------------------------------------------------------
router.post("/omnichannel/conversations/:id/resolve", agentAuth, async (req: Request, res: Response) => {
  try {
    const wreq = workspace(req);
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid conversation id" }); return; }

    const row = await getConversationRow(id, wreq.workspaceOwnerId);
    if (!row) { res.status(404).json({ error: "Conversation not found" }); return; }

    await db.query(
      `UPDATE omni_conversations SET status = 'resolved', resolved_at = NOW(), updated_at = NOW() WHERE id = $1 AND workspace_owner_id = $2`,
      [id, wreq.workspaceOwnerId],
    );

    await db.query(
      `INSERT INTO omni_audit_logs (workspace_owner_id, actor_id, actor_type, action, resource_type, resource_id)
       VALUES ($1, $2, 'agent', 'conversation_resolved', 'conversation', $3)`,
      [wreq.workspaceOwnerId, wreq.userId, String(id)],
    );

    sseBus.push({
      type: "conversation_updated",
      conversation_id: id,
      workspace_owner_id: wreq.workspaceOwnerId,
    });

    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Failed to resolve conversation");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /omnichannel/conversations/:id/reopen
// ---------------------------------------------------------------------------
router.post("/omnichannel/conversations/:id/reopen", agentAuth, async (req: Request, res: Response) => {
  try {
    const wreq = workspace(req);
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid conversation id" }); return; }

    const row = await getConversationRow(id, wreq.workspaceOwnerId);
    if (!row) { res.status(404).json({ error: "Conversation not found" }); return; }

    await db.query(
      `UPDATE omni_conversations SET status = 'open', resolved_at = NULL, updated_at = NOW() WHERE id = $1 AND workspace_owner_id = $2`,
      [id, wreq.workspaceOwnerId],
    );

    await db.query(
      `INSERT INTO omni_audit_logs (workspace_owner_id, actor_id, actor_type, action, resource_type, resource_id)
       VALUES ($1, $2, 'agent', 'conversation_reopened', 'conversation', $3)`,
      [wreq.workspaceOwnerId, wreq.userId, String(id)],
    );

    sseBus.push({
      type: "conversation_updated",
      conversation_id: id,
      workspace_owner_id: wreq.workspaceOwnerId,
    });

    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Failed to reopen conversation");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /omnichannel/conversations/:id/pause-automation
// ---------------------------------------------------------------------------
router.post("/omnichannel/conversations/:id/pause-automation", agentAuth, async (req: Request, res: Response) => {
  try {
    const wreq = workspace(req);
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid conversation id" }); return; }

    const row = await getConversationRow(id, wreq.workspaceOwnerId);
    if (!row) { res.status(404).json({ error: "Conversation not found" }); return; }

    await db.query(
      `UPDATE omni_conversations
       SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"automation_paused": true}'::jsonb, updated_at = NOW()
       WHERE id = $1 AND workspace_owner_id = $2`,
      [id, wreq.workspaceOwnerId],
    );

    await db.query(
      `INSERT INTO omni_audit_logs (workspace_owner_id, actor_id, actor_type, action, resource_type, resource_id)
       VALUES ($1, $2, 'agent', 'automation_paused', 'conversation', $3)`,
      [wreq.workspaceOwnerId, wreq.userId, String(id)],
    );

    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Failed to pause automation");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /omnichannel/conversations/:id/resume-automation
// ---------------------------------------------------------------------------
router.post("/omnichannel/conversations/:id/resume-automation", agentAuth, async (req: Request, res: Response) => {
  try {
    const wreq = workspace(req);
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid conversation id" }); return; }

    const row = await getConversationRow(id, wreq.workspaceOwnerId);
    if (!row) { res.status(404).json({ error: "Conversation not found" }); return; }

    await db.query(
      `UPDATE omni_conversations
       SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"automation_paused": false}'::jsonb, updated_at = NOW()
       WHERE id = $1 AND workspace_owner_id = $2`,
      [id, wreq.workspaceOwnerId],
    );

    await db.query(
      `INSERT INTO omni_audit_logs (workspace_owner_id, actor_id, actor_type, action, resource_type, resource_id)
       VALUES ($1, $2, 'agent', 'automation_resumed', 'conversation', $3)`,
      [wreq.workspaceOwnerId, wreq.userId, String(id)],
    );

    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Failed to resume automation");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /omnichannel/tags
// ---------------------------------------------------------------------------
router.get("/omnichannel/tags", agentAuth, async (req: Request, res: Response) => {
  try {
    const wreq = workspace(req);
    const result = await db.query<{ id: number; name: string; color: string | null }>(
      `SELECT id, name, color FROM omni_tags WHERE workspace_owner_id = $1 ORDER BY name ASC`,
      [wreq.workspaceOwnerId],
    );
    res.json({ tags: result.rows });
  } catch (err) {
    logger.error({ err }, "Failed to list omnichannel tags");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /omnichannel/tags
// ---------------------------------------------------------------------------
const ownerAuth = requireOmnichannelRole("omnichannel:owner");

const CreateTagSchema = z.object({
  name: z.string().min(1).max(50),
  color: z.string().max(20).nullable().optional(),
});

router.post("/omnichannel/tags", ownerAuth, async (req: Request, res: Response) => {
  try {
    const wreq = workspace(req);
    const parsed = CreateTagSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation error", issues: parsed.error.issues });
      return;
    }
    const { name, color } = parsed.data;
    const result = await db.query<{ id: number; name: string; color: string | null }>(
      `INSERT INTO omni_tags (workspace_owner_id, name, color)
       VALUES ($1, $2, $3)
       ON CONFLICT (workspace_owner_id, name) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, name, color`,
      [wreq.workspaceOwnerId, name.trim(), color ?? null],
    );
    res.status(201).json({ tag: result.rows[0] });
  } catch (err) {
    logger.error({ err }, "Failed to create omnichannel tag");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// PATCH /omnichannel/tags/:id
// ---------------------------------------------------------------------------
const UpdateTagSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  color: z.string().max(20).nullable().optional(),
});

router.patch("/omnichannel/tags/:id", ownerAuth, async (req: Request, res: Response) => {
  try {
    const wreq = workspace(req);
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid tag id" }); return; }

    const parsed = UpdateTagSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Validation error", issues: parsed.error.issues });
      return;
    }

    const { name, color } = parsed.data;
    if (name === undefined && color === undefined) {
      res.status(400).json({ error: "Nothing to update" });
      return;
    }

    const setClauses: string[] = [];
    const values: (string | null | number)[] = [wreq.workspaceOwnerId, id];
    let idx = 3;

    if (name !== undefined) {
      setClauses.push(`name = $${idx++}`);
      values.push(name.trim());
    }
    if (color !== undefined) {
      setClauses.push(`color = $${idx++}`);
      values.push(color);
    }

    const result = await db.query<{ id: number; name: string; color: string | null }>(
      `UPDATE omni_tags SET ${setClauses.join(", ")}
       WHERE workspace_owner_id = $1 AND id = $2
       RETURNING id, name, color`,
      values,
    );
    if (result.rowCount === 0) { res.status(404).json({ error: "Tag not found" }); return; }
    res.json({ tag: result.rows[0] });
  } catch (err) {
    logger.error({ err }, "Failed to update omnichannel tag");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// DELETE /omnichannel/tags/:id
// ---------------------------------------------------------------------------
router.delete("/omnichannel/tags/:id", ownerAuth, async (req: Request, res: Response) => {
  try {
    const wreq = workspace(req);
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid tag id" }); return; }

    const result = await db.query(
      `DELETE FROM omni_tags WHERE workspace_owner_id = $1 AND id = $2`,
      [wreq.workspaceOwnerId, id],
    );
    if (result.rowCount === 0) { res.status(404).json({ error: "Tag not found" }); return; }
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, "Failed to delete omnichannel tag");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// PUT /omnichannel/conversations/:id/tags
// ---------------------------------------------------------------------------
const SetTagsSchema = z.object({
  tags: z.array(z.string().min(1).max(50)).max(20),
});

router.put("/omnichannel/conversations/:id/tags", agentAuth, async (req: Request, res: Response) => {
  try {
    const wreq = workspace(req);
    const id = parseInt(String(req.params.id), 10);
    if (isNaN(id)) { res.status(400).json({ error: "Invalid conversation id" }); return; }

    const parsed = SetTagsSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Validation error", issues: parsed.error.issues }); return; }

    const row = await getConversationRow(id, wreq.workspaceOwnerId);
    if (!row) { res.status(404).json({ error: "Conversation not found" }); return; }

    const tagIds: number[] = [];
    for (const name of parsed.data.tags) {
      const upsert = await db.query<{ id: number }>(
        `INSERT INTO omni_tags (workspace_owner_id, name)
         VALUES ($1, $2)
         ON CONFLICT (workspace_owner_id, name) DO UPDATE SET name = EXCLUDED.name
         RETURNING id`,
        [wreq.workspaceOwnerId, name.trim()],
      );
      tagIds.push(upsert.rows[0].id);
    }

    await db.query(`DELETE FROM omni_conversation_tags WHERE conversation_id = $1`, [id]);
    for (const tagId of tagIds) {
      await db.query(
        `INSERT INTO omni_conversation_tags (conversation_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [id, tagId],
      );
    }

    await db.query(`UPDATE omni_conversations SET updated_at = NOW() WHERE id = $1`, [id]);

    res.json({ ok: true, tags: parsed.data.tags });
  } catch (err) {
    logger.error({ err }, "Failed to set conversation tags");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /omnichannel/conversations/bulk-action
// ---------------------------------------------------------------------------
const BulkActionSchema = z.object({
  conversation_ids: z.array(z.number().int().positive()).min(1).max(100),
  action: z.enum(["resolve", "assign"]),
  assigned_agent_id: z.string().nullable().optional(),
});

router.post("/omnichannel/conversations/bulk-action", agentAuth, async (req: Request, res: Response) => {
  try {
    const wreq = workspace(req);

    const parsed = BulkActionSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Validation error", issues: parsed.error.issues }); return; }

    const { conversation_ids, action, assigned_agent_id } = parsed.data;

    const ownedResult = await db.query<{ id: number }>(
      `SELECT id FROM omni_conversations WHERE id = ANY($1::int[]) AND workspace_owner_id = $2`,
      [conversation_ids, wreq.workspaceOwnerId],
    );
    const ownedIds = ownedResult.rows.map((r) => r.id);
    if (ownedIds.length === 0) {
      res.status(404).json({ error: "No matching conversations found" });
      return;
    }

    if (action === "resolve") {
      await db.query(
        `UPDATE omni_conversations SET status = 'resolved', resolved_at = NOW(), updated_at = NOW() WHERE id = ANY($1::int[]) AND workspace_owner_id = $2`,
        [ownedIds, wreq.workspaceOwnerId],
      );
      for (const cid of ownedIds) {
        await db.query(
          `INSERT INTO omni_audit_logs (workspace_owner_id, actor_id, actor_type, action, resource_type, resource_id)
           VALUES ($1, $2, 'agent', 'conversation_resolved', 'conversation', $3)`,
          [wreq.workspaceOwnerId, wreq.userId, String(cid)],
        );
      }
    } else {
      await db.query(
        `UPDATE omni_conversations SET assigned_agent_id = $1, updated_at = NOW() WHERE id = ANY($2::int[]) AND workspace_owner_id = $3`,
        [assigned_agent_id ?? null, ownedIds, wreq.workspaceOwnerId],
      );
      for (const cid of ownedIds) {
        await db.query(
          `INSERT INTO omni_audit_logs (workspace_owner_id, actor_id, actor_type, action, resource_type, resource_id, metadata)
           VALUES ($1, $2, 'agent', 'conversation_assigned', 'conversation', $3, $4)`,
          [wreq.workspaceOwnerId, wreq.userId, String(cid), JSON.stringify({ assigned_agent_id: assigned_agent_id ?? null })],
        );
      }
    }

    res.json({ ok: true, affected: ownedIds.length });
  } catch (err) {
    logger.error({ err }, "Failed to bulk action conversations");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /omnichannel/saved-replies
// ---------------------------------------------------------------------------
router.get("/omnichannel/saved-replies", agentAuth, async (req: Request, res: Response) => {
  try {
    const wreq = workspace(req);
    const q = req.query.q ? String(req.query.q) : null;

    const result = await db.query(
      `SELECT id, shortcut, title, content, is_global, created_at
       FROM omni_saved_replies
       WHERE workspace_owner_id = $1 ${q ? "AND (title ILIKE $2 OR shortcut ILIKE $2 OR content ILIKE $2)" : ""}
       ORDER BY shortcut ASC`,
      q ? [wreq.workspaceOwnerId, `%${q}%`] : [wreq.workspaceOwnerId],
    );

    res.json({ saved_replies: result.rows });
  } catch (err) {
    logger.error({ err }, "Failed to list saved replies");
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// POST /omnichannel/messages/:messageId/retry
// Re-enqueue a failed outbound message.
// ---------------------------------------------------------------------------
router.post(
  "/omnichannel/messages/:messageId/retry",
  agentAuth,
  async (req: Request, res: Response) => {
    const wreq = workspace(req);
    const { messageId } = req.params;

    // Look up the queue row for this message, scoped to this workspace
    const queueResult = await db.query<{
      id: string;
      channel_account_id: number;
      conversation_id: number;
      recipient_external_id: string;
      payload: string;
      status: string;
    }>(
      `SELECT q.id, q.channel_account_id, q.conversation_id,
              q.recipient_external_id, q.payload, q.status
       FROM omni_outbound_queue q
       JOIN omni_conversations c ON c.id = q.conversation_id
       WHERE q.message_id = $1
         AND c.workspace_owner_id = $2
       ORDER BY q.created_at DESC
       LIMIT 1`,
      [messageId, wreq.workspaceOwnerId],
    );

    if (queueResult.rows.length === 0) {
      res.status(404).json({ error: "Message queue entry not found" });
      return;
    }

    const qrow = queueResult.rows[0];

    if (qrow.status !== "failed") {
      res.status(400).json({ error: "Only failed messages can be retried" });
      return;
    }

    // Reset the queue item: status → queued, attempts → 0, next_attempt_at → NOW
    await db.query(
      `UPDATE omni_outbound_queue
       SET status = 'queued', attempts = 0, next_attempt_at = NOW(),
           last_error = NULL, updated_at = NOW()
       WHERE id = $1`,
      [qrow.id],
    );

    // Reset the message status
    await db.query(
      `UPDATE omni_messages SET status = 'queued', error_code = NULL, error_message = NULL
       WHERE id = $1`,
      [messageId],
    );

    logger.info(
      { queueId: qrow.id, messageId, conversationId: qrow.conversation_id },
      "omnichannel: message retry requested",
    );

    res.json({ success: true, queue_id: qrow.id });
  },
);

// ---------------------------------------------------------------------------
// POST /omnichannel/ai/draft-reply (stub)
// ---------------------------------------------------------------------------
router.post("/omnichannel/ai/draft-reply", agentAuth, async (req: Request, res: Response) => {
  const { conversation_id, context } = req.body as { conversation_id?: number; context?: string };
  if (!conversation_id) {
    res.status(400).json({ error: "conversation_id is required" });
    return;
  }

  const draft = context
    ? `Thank you for reaching out. ${context ? "Regarding your message: " + context.slice(0, 80) + "..." : ""} How can I assist you further?`
    : "Thank you for reaching out! How can I help you today?";

  res.json({ draft });
});

export default router;
