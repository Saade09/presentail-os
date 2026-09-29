// ---------------------------------------------------------------------------
// Omnichannel Phase 5 — Action handlers
// Each handler receives an ExecutionContext and returns { next: nodeId | null }
// ---------------------------------------------------------------------------

import { db } from "../../../lib/db";
import { logger } from "../../../lib/logger";
import type {
  SendTextNode,
  SendMediaNode,
  AskQuestionNode,
  DelayNode,
  AddTagNode,
  RemoveTagNode,
  UpdateContactFieldNode,
  AssignNode,
  AddNoteNode,
  CallWebhookNode,
  TriggerFlowNode,
  HandoffNode,
} from "./flowTypes";

export interface ExecutionContext {
  executionId: string;
  flowId: number;
  conversationId: number;
  contactId: number;
  workspaceOwnerId: string;
  channelAccountId: number;
  recipientExternalId: string;
  variables: Record<string, string>;
}

export interface HandlerResult {
  next: string | null;
  waiting?: boolean;
  waitReason?: string;
}

// ---------------------------------------------------------------------------
// Helper — interpolate {{variable}} placeholders
// ---------------------------------------------------------------------------

function interpolate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? "");
}

// ---------------------------------------------------------------------------
// Helper — get or create a tag by name within the workspace
// ---------------------------------------------------------------------------

async function ensureTag(workspaceOwnerId: string, tagName: string): Promise<number> {
  const existing = await db.query<{ id: number }>(
    `SELECT id FROM omni_tags WHERE workspace_owner_id = $1 AND name = $2 LIMIT 1`,
    [workspaceOwnerId, tagName],
  );
  if (existing.rows.length > 0) return existing.rows[0].id;

  const created = await db.query<{ id: number }>(
    `INSERT INTO omni_tags (workspace_owner_id, name) VALUES ($1, $2)
     ON CONFLICT (workspace_owner_id, name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [workspaceOwnerId, tagName],
  );
  return created.rows[0].id;
}

// ---------------------------------------------------------------------------
// sendTextAction
// ---------------------------------------------------------------------------

export async function sendTextAction(
  node: SendTextNode,
  ctx: ExecutionContext,
  nextNodeId: string | null,
): Promise<HandlerResult> {
  const text = interpolate(node.text, ctx.variables);

  try {
    const accountResult = await db.query<{ provider: string }>(
      `SELECT provider FROM omni_channel_accounts WHERE id = $1`,
      [ctx.channelAccountId],
    );
    const provider = accountResult.rows[0]?.provider as OmniProvider | undefined;

    const msgResult = await db.query<{ id: string }>(
      `INSERT INTO omni_messages
         (conversation_id, workspace_owner_id, channel_account_id, direction,
          message_type, content, sender_name, sender_id, status)
       VALUES ($1, $2, $3, 'outbound', 'text', $4, 'Automation', 'system', 'queued')
       RETURNING id`,
      [ctx.conversationId, ctx.workspaceOwnerId, ctx.channelAccountId, text],
    );
    const messageId = msgResult.rows[0]?.id;

    await db.query(
      `UPDATE omni_conversations SET last_message_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [ctx.conversationId],
    );

    if (messageId && provider && ctx.recipientExternalId) {
      await outboundQueue.enqueue({
        channelAccountId: ctx.channelAccountId,
        conversationId: ctx.conversationId,
        messageId,
        recipientExternalId: ctx.recipientExternalId,
        payload: { messageType: "text", content: text },
        provider,
      });
    }
  } catch (err) {
    logger.error({ err, executionId: ctx.executionId }, "automation: sendTextAction failed");
  }

  return { next: nextNodeId };
}

// ---------------------------------------------------------------------------
// sendMediaAction
// ---------------------------------------------------------------------------

export async function sendMediaAction(
  node: SendMediaNode,
  ctx: ExecutionContext,
  nextNodeId: string | null,
): Promise<HandlerResult> {
  try {
    const accountResult = await db.query<{ provider: string }>(
      `SELECT provider FROM omni_channel_accounts WHERE id = $1`,
      [ctx.channelAccountId],
    );
    const provider = accountResult.rows[0]?.provider as OmniProvider | undefined;

    const mimeType = node.mediaMimeType ?? null;
    let messageType: "image" | "video" | "audio" | "document" = "image";
    if (mimeType) {
      if (mimeType.startsWith("video/")) messageType = "video";
      else if (mimeType.startsWith("audio/")) messageType = "audio";
      else if (
        mimeType === "application/pdf" ||
        mimeType.startsWith("application/") ||
        mimeType.startsWith("text/")
      ) {
        messageType = "document";
      }
    }

    const msgResult = await db.query<{ id: string }>(
      `INSERT INTO omni_messages
         (conversation_id, workspace_owner_id, channel_account_id, direction,
          message_type, media_url, media_mime_type, content,
          sender_name, sender_id, status)
       VALUES ($1, $2, $3, 'outbound', $4, $5, $6, $7, 'Automation', 'system', 'queued')
       RETURNING id`,
      [
        ctx.conversationId,
        ctx.workspaceOwnerId,
        ctx.channelAccountId,
        messageType,
        node.mediaUrl,
        mimeType,
        node.caption ?? null,
      ],
    );
    const messageId = msgResult.rows[0]?.id;

    await db.query(
      `UPDATE omni_conversations SET last_message_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [ctx.conversationId],
    );

    if (messageId && provider && ctx.recipientExternalId) {
      await outboundQueue.enqueue({
        channelAccountId: ctx.channelAccountId,
        conversationId: ctx.conversationId,
        messageId,
        recipientExternalId: ctx.recipientExternalId,
        payload: {
          messageType,
          mediaUrl: node.mediaUrl,
          mediaMimeType: mimeType ?? undefined,
          content: node.caption ?? undefined,
        },
        provider,
      });
    }
  } catch (err) {
    logger.error({ err, executionId: ctx.executionId }, "automation: sendMediaAction failed");
  }

  return { next: nextNodeId };
}

// ---------------------------------------------------------------------------
// askQuestionAction — suspends execution until next inbound message
// ---------------------------------------------------------------------------

export async function askQuestionAction(
  node: AskQuestionNode,
  ctx: ExecutionContext,
): Promise<HandlerResult> {
  const question = interpolate(node.question, ctx.variables);

  try {
    const accountResult = await db.query<{ provider: string }>(
      `SELECT provider FROM omni_channel_accounts WHERE id = $1`,
      [ctx.channelAccountId],
    );
    const provider = accountResult.rows[0]?.provider as OmniProvider | undefined;

    const msgResult = await db.query<{ id: string }>(
      `INSERT INTO omni_messages
         (conversation_id, workspace_owner_id, channel_account_id, direction,
          message_type, content, sender_name, sender_id, status)
       VALUES ($1, $2, $3, 'outbound', 'text', $4, 'Automation', 'system', 'queued')
       RETURNING id`,
      [ctx.conversationId, ctx.workspaceOwnerId, ctx.channelAccountId, question],
    );
    const messageId = msgResult.rows[0]?.id;

    await db.query(
      `UPDATE omni_conversations SET last_message_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [ctx.conversationId],
    );

    if (messageId && provider && ctx.recipientExternalId) {
      await outboundQueue.enqueue({
        channelAccountId: ctx.channelAccountId,
        conversationId: ctx.conversationId,
        messageId,
        recipientExternalId: ctx.recipientExternalId,
        payload: { messageType: "text", content: question },
        provider,
      });
    }

    await db.query(
      `UPDATE omni_automation_executions
       SET status = 'waiting', current_node_id = $1,
           context = COALESCE(context, '{}'::jsonb) || $2::jsonb
       WHERE id = $3`,
      [
        node.id,
        JSON.stringify({ waitingForField: node.saveToField }),
        ctx.executionId,
      ],
    );
  } catch (err) {
    logger.error({ err, executionId: ctx.executionId }, "automation: askQuestionAction failed");
  }

  return { next: null, waiting: true, waitReason: `Waiting for answer to "${question}"` };
}

// ---------------------------------------------------------------------------
// delayAction — marks execution as waiting, stores resume time
// ---------------------------------------------------------------------------

export async function delayAction(
  node: DelayNode,
  ctx: ExecutionContext,
  nextNodeId: string | null,
): Promise<HandlerResult> {
  const resumeAt = new Date(Date.now() + node.minutes * 60 * 1000).toISOString();

  try {
    await db.query(
      `UPDATE omni_automation_executions
       SET status = 'waiting', current_node_id = $1,
           context = COALESCE(context, '{}'::jsonb) || $2::jsonb
       WHERE id = $3`,
      [
        node.id,
        JSON.stringify({ delayResumeAt: resumeAt, delayNextNodeId: nextNodeId }),
        ctx.executionId,
      ],
    );
  } catch (err) {
    logger.error({ err, executionId: ctx.executionId }, "automation: delayAction failed");
  }

  return { next: null, waiting: true, waitReason: `Delayed ${node.minutes}m` };
}

// ---------------------------------------------------------------------------
// addTagAction
// ---------------------------------------------------------------------------

export async function addTagAction(
  node: AddTagNode,
  ctx: ExecutionContext,
  nextNodeId: string | null,
): Promise<HandlerResult> {
  try {
    const tagId = await ensureTag(ctx.workspaceOwnerId, node.tagName);

    await db.query(
      `INSERT INTO omni_conversation_tags (conversation_id, tag_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [ctx.conversationId, tagId],
    );

    const contactTagResult = await db.query<{ id: number }>(
      `SELECT id FROM omni_contacts WHERE id = $1 LIMIT 1`,
      [ctx.contactId],
    );
    if (contactTagResult.rows.length > 0) {
      await db.query(
        `INSERT INTO omni_contact_tags (contact_id, tag_id)
         VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [ctx.contactId, tagId],
      );
    }
  } catch (err) {
    logger.error({ err, executionId: ctx.executionId }, "automation: addTagAction failed");
  }

  return { next: nextNodeId };
}

// ---------------------------------------------------------------------------
// removeTagAction
// ---------------------------------------------------------------------------

export async function removeTagAction(
  node: RemoveTagNode,
  ctx: ExecutionContext,
  nextNodeId: string | null,
): Promise<HandlerResult> {
  try {
    const tagResult = await db.query<{ id: number }>(
      `SELECT id FROM omni_tags WHERE workspace_owner_id = $1 AND name = $2 LIMIT 1`,
      [ctx.workspaceOwnerId, node.tagName],
    );
    if (tagResult.rows.length > 0) {
      const tagId = tagResult.rows[0].id;
      await db.query(`DELETE FROM omni_conversation_tags WHERE conversation_id = $1 AND tag_id = $2`, [
        ctx.conversationId,
        tagId,
      ]);
      await db.query(`DELETE FROM omni_contact_tags WHERE contact_id = $1 AND tag_id = $2`, [
        ctx.contactId,
        tagId,
      ]);
    }
  } catch (err) {
    logger.error({ err, executionId: ctx.executionId }, "automation: removeTagAction failed");
  }

  return { next: nextNodeId };
}

// ---------------------------------------------------------------------------
// updateContactFieldAction — stores in omni_contacts.metadata
// ---------------------------------------------------------------------------

export async function updateContactFieldAction(
  node: UpdateContactFieldNode,
  ctx: ExecutionContext,
  nextNodeId: string | null,
): Promise<HandlerResult> {
  try {
    const value = interpolate(node.fieldValue, ctx.variables);
    await db.query(
      `UPDATE omni_contacts
       SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb, updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify({ [node.fieldKey]: value }), ctx.contactId],
    );
    ctx.variables[node.fieldKey] = value;
  } catch (err) {
    logger.error({ err, executionId: ctx.executionId }, "automation: updateContactFieldAction failed");
  }

  return { next: nextNodeId };
}

// ---------------------------------------------------------------------------
// assignAction
// ---------------------------------------------------------------------------

export async function assignAction(
  node: AssignNode,
  ctx: ExecutionContext,
  nextNodeId: string | null,
): Promise<HandlerResult> {
  try {
    await db.query(
      `UPDATE omni_conversations
       SET assigned_agent_id = $1, assigned_team_id = $2, updated_at = NOW()
       WHERE id = $3`,
      [node.agentId ?? null, node.teamId ?? null, ctx.conversationId],
    );
  } catch (err) {
    logger.error({ err, executionId: ctx.executionId }, "automation: assignAction failed");
  }

  return { next: nextNodeId };
}

// ---------------------------------------------------------------------------
// addNoteAction
// ---------------------------------------------------------------------------

export async function addNoteAction(
  node: AddNoteNode,
  ctx: ExecutionContext,
  nextNodeId: string | null,
): Promise<HandlerResult> {
  const content = interpolate(node.content, ctx.variables);

  try {
    await db.query(
      `INSERT INTO omni_internal_notes (conversation_id, author_id, author_name, content)
       VALUES ($1, 'automation', 'Automation', $2)`,
      [ctx.conversationId, content],
    );
  } catch (err) {
    logger.error({ err, executionId: ctx.executionId }, "automation: addNoteAction failed");
  }

  return { next: nextNodeId };
}

// ---------------------------------------------------------------------------
// callWebhookAction
// ---------------------------------------------------------------------------

export async function callWebhookAction(
  node: CallWebhookNode,
  ctx: ExecutionContext,
  nextNodeId: string | null,
): Promise<HandlerResult> {
  try {
    const body = node.bodyTemplate ? interpolate(node.bodyTemplate, ctx.variables) : null;
    const method = node.method ?? "POST";

    const fetchOptions: RequestInit = {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(node.headers ?? {}),
      },
    };

    if (body && method !== "GET") {
      fetchOptions.body = body;
    }

    const resp = await fetch(node.url, fetchOptions);
    if (!resp.ok) {
      logger.warn(
        { executionId: ctx.executionId, url: node.url, status: resp.status },
        "automation: callWebhookAction received non-2xx",
      );
    }
  } catch (err) {
    logger.error({ err, executionId: ctx.executionId }, "automation: callWebhookAction failed");
  }

  return { next: nextNodeId };
}

// ---------------------------------------------------------------------------
// triggerFlowAction — starts another flow for the same conversation
// ---------------------------------------------------------------------------

export async function triggerFlowAction(
  node: TriggerFlowNode,
  ctx: ExecutionContext,
  nextNodeId: string | null,
): Promise<HandlerResult> {
  try {
    const { startFlow } = await import("./flowExecutor");
    await startFlow(node.targetFlowId, ctx.conversationId, { triggeredBy: ctx.executionId });
  } catch (err) {
    logger.error({ err, executionId: ctx.executionId }, "automation: triggerFlowAction failed");
  }

  return { next: nextNodeId };
}

// ---------------------------------------------------------------------------
// stopFlowAction — marks execution finished
// ---------------------------------------------------------------------------

export async function stopFlowAction(
  _ctx: ExecutionContext,
): Promise<HandlerResult> {
  return { next: null };
}

// ---------------------------------------------------------------------------
// handoffAction — sets automationState and pauses execution
// ---------------------------------------------------------------------------

export async function handoffAction(
  node: HandoffNode,
  ctx: ExecutionContext,
): Promise<HandlerResult> {
  try {
    await db.query(
      `UPDATE omni_conversations
       SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"automationState": "handed_to_human"}'::jsonb,
           updated_at = NOW()
       WHERE id = $1`,
      [ctx.conversationId],
    );

    if (node.note) {
      const noteContent = interpolate(node.note, ctx.variables);
      await db.query(
        `INSERT INTO omni_internal_notes (conversation_id, author_id, author_name, content)
         VALUES ($1, 'automation', 'Automation', $2)`,
        [ctx.conversationId, noteContent],
      );
    }

    await db.query(
      `UPDATE omni_automation_executions
       SET status = 'waiting', current_node_id = $1
       WHERE id = $2`,
      [node.id, ctx.executionId],
    );
  } catch (err) {
    logger.error({ err, executionId: ctx.executionId }, "automation: handoffAction failed");
  }

  return { next: null, waiting: true, waitReason: "Handed off to human" };
}

// ---------------------------------------------------------------------------
// resolveAction — marks conversation resolved
// ---------------------------------------------------------------------------

export async function resolveAction(
  ctx: ExecutionContext,
  nextNodeId: string | null,
): Promise<HandlerResult> {
  try {
    await db.query(
      `UPDATE omni_conversations
       SET status = 'resolved', resolved_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [ctx.conversationId],
    );
  } catch (err) {
    logger.error({ err, executionId: ctx.executionId }, "automation: resolveAction failed");
  }

  return { next: nextNodeId };
}

// ---------------------------------------------------------------------------
// aiGenerateResponseAction — calls AI provider and enqueues result as message
// ---------------------------------------------------------------------------

import type { AiGenerateResponseNode } from "./flowTypes";
import { getAIProvider, AI_CONFIDENCE_THRESHOLD } from "../ai";
import type { AIMessage, KnowledgeBaseSnippet } from "../ai";
import * as outboundQueue from "../queue/outboundQueue";
import type { OmniProvider } from "../types";

async function fetchConversationHistory(
  conversationId: number,
  workspaceOwnerId: string,
  limit = 20,
): Promise<AIMessage[]> {
  const result = await db.query<{
    content: string | null;
    direction: string;
    created_at: Date;
  }>(
    `SELECT content, direction, created_at
     FROM omni_messages
     WHERE conversation_id = $1
       AND workspace_owner_id = $2
       AND message_type = 'text'
       AND content IS NOT NULL
     ORDER BY created_at DESC
     LIMIT $3`,
    [conversationId, workspaceOwnerId, limit],
  );
  return result.rows.reverse().map((row) => ({
    role: row.direction === "inbound" ? "user" : "assistant",
    content: row.content ?? "",
    timestamp: row.created_at,
  }));
}

async function fetchKnowledgeBase(workspaceOwnerId: string): Promise<KnowledgeBaseSnippet[]> {
  const result = await db.query<{
    id: number;
    title: string;
    content: string;
    category: string | null;
  }>(
    `SELECT id, title, content, category FROM omni_knowledge_base
     WHERE workspace_owner_id = $1 AND is_published = true
     ORDER BY updated_at DESC`,
    [workspaceOwnerId],
  );
  return result.rows;
}

export async function aiGenerateResponseAction(
  node: AiGenerateResponseNode,
  ctx: ExecutionContext,
  nextNodeId: string | null,
): Promise<HandlerResult> {
  try {
    const history = await fetchConversationHistory(ctx.conversationId, ctx.workspaceOwnerId);
    const kb = await fetchKnowledgeBase(ctx.workspaceOwnerId);

    const provider = getAIProvider();
    const result = await provider.draftReply(history, kb, node.contextNote);

    if (result.escalate || result.confidence < AI_CONFIDENCE_THRESHOLD) {
      logger.info(
        { executionId: ctx.executionId, confidence: result.confidence },
        "automation: aiGenerateResponse — confidence too low, skipping auto-send",
      );
      return { next: nextNodeId };
    }

    const convResult = await db.query<{
      channel_account_id: number;
      channel_provider: string;
    }>(
      `SELECT c.channel_account_id, ca.provider AS channel_provider
       FROM omni_conversations c
       JOIN omni_channel_accounts ca ON ca.id = c.channel_account_id
       WHERE c.id = $1`,
      [ctx.conversationId],
    );

    const conv = convResult.rows[0];
    if (!conv) return { next: nextNodeId };

    const msgInsert = await db.query<{ id: string }>(
      `INSERT INTO omni_messages
         (conversation_id, workspace_owner_id, channel_account_id, direction,
          message_type, content, sender_name, sender_id, status)
       VALUES ($1, $2, $3, 'outbound', 'text', $4, 'AI', 'system', 'queued')
       RETURNING id`,
      [ctx.conversationId, ctx.workspaceOwnerId, conv.channel_account_id, result.draft],
    );

    await outboundQueue.enqueue({
      channelAccountId: conv.channel_account_id,
      conversationId: ctx.conversationId,
      messageId: msgInsert.rows[0].id,
      recipientExternalId: ctx.recipientExternalId,
      payload: { messageType: "text", content: result.draft },
      provider: conv.channel_provider as OmniProvider,
    });

    await db.query(
      `UPDATE omni_conversations SET last_message_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [ctx.conversationId],
    );

    await db.query(
      `INSERT INTO omni_audit_logs (workspace_owner_id, actor_id, actor_type, action, resource_type, resource_id, metadata)
       VALUES ($1, 'automation', 'system', 'ai_auto_reply_sent', 'conversation', $2, $3)`,
      [
        ctx.workspaceOwnerId,
        String(ctx.conversationId),
        JSON.stringify({ confidence: result.confidence, execution_id: ctx.executionId }),
      ],
    );
  } catch (err) {
    logger.error({ err, executionId: ctx.executionId }, "automation: aiGenerateResponseAction failed");
  }

  return { next: nextNodeId };
}

// ---------------------------------------------------------------------------
// aiClassifyIntentAction — classifies intent and stores in execution context
// ---------------------------------------------------------------------------

import type { AiClassifyIntentNode } from "./flowTypes";

export async function aiClassifyIntentAction(
  node: AiClassifyIntentNode,
  ctx: ExecutionContext,
  nextNodeId: string | null,
): Promise<HandlerResult> {
  try {
    const history = await fetchConversationHistory(ctx.conversationId, ctx.workspaceOwnerId);
    const provider = getAIProvider();
    const result = await provider.classifyIntent(history);

    const fieldKey = node.storeResultInField ?? "ai_intent";
    ctx.variables[fieldKey] = result.intent;
    ctx.variables[`${fieldKey}_confidence`] = String(result.confidence);

    await db.query(
      `UPDATE omni_automation_executions SET context = context || $1::jsonb WHERE id = $2`,
      [JSON.stringify({ [fieldKey]: result.intent, [`${fieldKey}_confidence`]: String(result.confidence) }), ctx.executionId],
    );

    await db.query(
      `INSERT INTO omni_audit_logs (workspace_owner_id, actor_id, actor_type, action, resource_type, resource_id, metadata)
       VALUES ($1, 'automation', 'system', 'ai_classify_intent', 'conversation', $2, $3)`,
      [
        ctx.workspaceOwnerId,
        String(ctx.conversationId),
        JSON.stringify({ intent: result.intent, confidence: result.confidence, execution_id: ctx.executionId }),
      ],
    );
  } catch (err) {
    logger.error({ err, executionId: ctx.executionId }, "automation: aiClassifyIntentAction failed");
  }

  return { next: nextNodeId };
}
