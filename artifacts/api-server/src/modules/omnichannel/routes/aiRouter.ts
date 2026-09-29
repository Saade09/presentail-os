// ---------------------------------------------------------------------------
// Omnichannel Phase 6 — AI inference routes
// ---------------------------------------------------------------------------

import { Router } from "express";
import type { Request, Response } from "express";
import { z } from "zod/v4";
import { db } from "../../../lib/db";
import { logger } from "../../../lib/logger";
import { requireOmnichannelRole } from "../omnichannelAuth";
import { workspace } from "../../../lib/workspace";
import { getAIProvider, ENABLE_AI_AUTO_REPLY, AI_CONFIDENCE_THRESHOLD } from "../ai";
import type { AIMessage, KnowledgeBaseSnippet } from "../ai";
import * as outboundQueue from "../queue/outboundQueue";
import type { OmniProvider } from "../types";
import { encrypt, decryptCredential } from "../../../lib/credentialEncryption";

const router = Router();

const agentAuth = requireOmnichannelRole("omnichannel:agent");
const ownerAuth = requireOmnichannelRole("omnichannel:owner");

// ---------------------------------------------------------------------------
// Helper: load workspace AI settings from DB
// ---------------------------------------------------------------------------

async function getWorkspaceAiSettings(workspaceOwnerId: string): Promise<{
  openai_api_key: string | null;
  auto_reply_enabled: boolean;
  confidence_threshold: number;
}> {
  const result = await db.query<{
    openai_api_key: string | null;
    auto_reply_enabled: boolean;
    confidence_threshold: string;
  }>(
    `SELECT openai_api_key, auto_reply_enabled, confidence_threshold
     FROM omni_ai_settings
     WHERE workspace_owner_id = $1`,
    [workspaceOwnerId],
  );
  if (result.rows.length === 0) {
    return { openai_api_key: null, auto_reply_enabled: false, confidence_threshold: 0.75 };
  }
  const row = result.rows[0];

  let decryptedKey: string | null = null;
  if (row.openai_api_key) {
    decryptedKey = await decryptCredential(row.openai_api_key, async (encryptedKey) => {
      await db.query(
        `UPDATE omni_ai_settings SET openai_api_key = $1, updated_at = NOW()
         WHERE workspace_owner_id = $2`,
        [encryptedKey, workspaceOwnerId],
      );
    });
  }

  return {
    openai_api_key: decryptedKey,
    auto_reply_enabled: row.auto_reply_enabled,
    confidence_threshold: parseFloat(row.confidence_threshold),
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getConversationMessages(
  conversationId: number,
  workspaceOwnerId: string,
  limit = 20,
): Promise<AIMessage[]> {
  const result = await db.query<{
    content: string | null;
    direction: string;
    sender_name: string | null;
    created_at: Date;
  }>(
    `SELECT content, direction, sender_name, created_at
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

async function getWorkspaceKnowledgeBase(
  workspaceOwnerId: string,
): Promise<KnowledgeBaseSnippet[]> {
  const result = await db.query<{
    id: number;
    title: string;
    content: string;
    category: string | null;
  }>(
    `SELECT id, title, content, category
     FROM omni_knowledge_base
     WHERE workspace_owner_id = $1 AND is_published = true
     ORDER BY updated_at DESC`,
    [workspaceOwnerId],
  );
  return result.rows;
}

async function writeAuditLog(
  workspaceOwnerId: string,
  actorId: string,
  action: string,
  resourceId: string,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `INSERT INTO omni_audit_logs (workspace_owner_id, actor_id, actor_type, action, resource_type, resource_id, metadata)
     VALUES ($1, $2, 'agent', $3, 'conversation', $4, $5)`,
    [workspaceOwnerId, actorId, action, resourceId, metadata ? JSON.stringify(metadata) : null],
  );
}

// ---------------------------------------------------------------------------
// Helper: determine active AI provider type
// ---------------------------------------------------------------------------

function resolveProviderInfo(workspaceApiKey: string | null): {
  provider: "live" | "mock";
  source: "workspace_key" | "integration" | "mock";
} {
  if (workspaceApiKey) {
    return { provider: "live", source: "workspace_key" };
  }
  const hasIntegration =
    process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || process.env.OPENAI_API_KEY;
  if (hasIntegration) {
    return { provider: "live", source: "integration" };
  }
  return { provider: "mock", source: "mock" };
}

// ---------------------------------------------------------------------------
// GET /omnichannel/ai/settings  (owner only)
// ---------------------------------------------------------------------------

router.get(
  "/omnichannel/ai/settings",
  ownerAuth,
  async (req: Request, res: Response) => {
    try {
      const wreq = await workspace(req);
      const settings = await getWorkspaceAiSettings(wreq.workspaceOwnerId);
      const providerInfo = resolveProviderInfo(settings.openai_api_key);
      res.json({
        has_api_key: Boolean(settings.openai_api_key),
        is_integration_active: Boolean(
          process.env.AI_INTEGRATIONS_OPENAI_BASE_URL || process.env.OPENAI_API_KEY,
        ),
        provider: providerInfo.provider,
        provider_source: providerInfo.source,
        auto_reply_enabled: settings.auto_reply_enabled,
        confidence_threshold: settings.confidence_threshold,
      });
    } catch (err) {
      logger.error({ err }, "omnichannel ai: get settings failed");
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// ---------------------------------------------------------------------------
// GET /omnichannel/ai/provider-status  (agent+)
// Returns lightweight provider status without exposing secrets
// ---------------------------------------------------------------------------

router.get(
  "/omnichannel/ai/provider-status",
  agentAuth,
  async (req: Request, res: Response) => {
    try {
      const wreq = await workspace(req);
      const settings = await getWorkspaceAiSettings(wreq.workspaceOwnerId);
      const providerInfo = resolveProviderInfo(settings.openai_api_key);
      res.json(providerInfo);
    } catch (err) {
      logger.error({ err }, "omnichannel ai: get provider-status failed");
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// ---------------------------------------------------------------------------
// PUT /omnichannel/ai/settings  (owner only)
// ---------------------------------------------------------------------------

const aiSettingsSchema = z.object({
  openai_api_key: z.string().optional(),
  clear_api_key: z.boolean().optional(),
  auto_reply_enabled: z.boolean(),
  confidence_threshold: z.number().min(0).max(1),
});

router.put(
  "/omnichannel/ai/settings",
  ownerAuth,
  async (req: Request, res: Response) => {
    try {
      const wreq = await workspace(req);
      const parsed = aiSettingsSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.message });
        return;
      }

      const { openai_api_key, clear_api_key, auto_reply_enabled, confidence_threshold } = parsed.data;

      const existing = await getWorkspaceAiSettings(wreq.workspaceOwnerId);
      let newKey: string | null = existing.openai_api_key;
      if (clear_api_key) {
        newKey = null;
      } else if (openai_api_key && openai_api_key.trim().length > 0) {
        newKey = openai_api_key.trim();
      }

      const keyToStore = newKey !== null ? encrypt(newKey) : null;

      await db.query(
        `INSERT INTO omni_ai_settings (workspace_owner_id, openai_api_key, auto_reply_enabled, confidence_threshold, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (workspace_owner_id) DO UPDATE SET
           openai_api_key = $2,
           auto_reply_enabled = $3,
           confidence_threshold = $4,
           updated_at = NOW()`,
        [wreq.workspaceOwnerId, keyToStore, auto_reply_enabled, String(confidence_threshold)],
      );

      res.json({
        has_api_key: Boolean(newKey),
        auto_reply_enabled,
        confidence_threshold,
      });
    } catch (err) {
      logger.error({ err }, "omnichannel ai: put settings failed");
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /omnichannel/ai/draft-reply
// ---------------------------------------------------------------------------

const draftReplySchema = z.object({
  conversation_id: z.number(),
  context: z.string().max(2000).optional(),
});

router.post(
  "/omnichannel/ai/draft-reply",
  agentAuth,
  async (req: Request, res: Response) => {
    try {
      const wreq = await workspace(req);
      const parsed = draftReplySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.message });
        return;
      }

      const { conversation_id, context } = parsed.data;

      // Verify conversation belongs to workspace
      const convResult = await db.query<{
        id: number;
        channel_account_id: number;
        channel_provider: string;
        contact_id: number;
        metadata: Record<string, unknown> | null;
      }>(
        `SELECT c.id, c.channel_account_id, ca.provider AS channel_provider, c.contact_id, c.metadata
         FROM omni_conversations c
         JOIN omni_channel_accounts ca ON ca.id = c.channel_account_id
         WHERE c.id = $1 AND c.workspace_owner_id = $2`,
        [conversation_id, wreq.workspaceOwnerId],
      );

      if (convResult.rows.length === 0) {
        res.status(404).json({ error: "Conversation not found" });
        return;
      }

      const conv = convResult.rows[0];
      const history = await getConversationMessages(conversation_id, wreq.workspaceOwnerId);
      const kb = await getWorkspaceKnowledgeBase(wreq.workspaceOwnerId);

      const aiSettings = await getWorkspaceAiSettings(wreq.workspaceOwnerId);
      const provider = getAIProvider(aiSettings.openai_api_key, `omni:${conversation_id}`);
      const result = await provider.draftReply(history, kb, context);

      await writeAuditLog(
        wreq.workspaceOwnerId,
        wreq.userId,
        "ai_draft_reply",
        String(conversation_id),
        { confidence: result.confidence, escalate: result.escalate, sources: result.sources },
      );

      // Auto-reply mode: only if configured and confidence is high enough
      const autoReplyEnabled = aiSettings.auto_reply_enabled || ENABLE_AI_AUTO_REPLY;
      const confidenceThreshold = aiSettings.confidence_threshold ?? AI_CONFIDENCE_THRESHOLD;
      if (
        autoReplyEnabled &&
        !result.escalate &&
        result.confidence >= confidenceThreshold
      ) {
        const convMeta = conv.metadata as Record<string, unknown> | null;
        const aiSetting = convMeta?.aiSetting ?? "";
        if (aiSetting === "auto_send_above_threshold") {
          const identityResult = await db.query<{ external_user_id: string }>(
            `SELECT ci.external_user_id
             FROM omni_contact_identities ci
             WHERE ci.contact_id = $1 AND ci.channel_account_id = $2
             LIMIT 1`,
            [conv.contact_id, conv.channel_account_id],
          );
          const recipientExternalId = identityResult.rows[0]?.external_user_id ?? "";

          if (recipientExternalId) {
            const msgInsert = await db.query<{ id: string }>(
              `INSERT INTO omni_messages
                 (conversation_id, workspace_owner_id, channel_account_id, direction,
                  message_type, content, sender_name, sender_id, status)
               VALUES ($1, $2, $3, 'outbound', 'text', $4, 'AI', 'system', 'queued')
               RETURNING id`,
              [conversation_id, wreq.workspaceOwnerId, conv.channel_account_id, result.draft],
            );

            await outboundQueue.enqueue({
              channelAccountId: conv.channel_account_id,
              conversationId: conversation_id,
              messageId: msgInsert.rows[0].id,
              recipientExternalId,
              payload: { messageType: "text", content: result.draft },
              provider: conv.channel_provider as OmniProvider,
            });

            await db.query(
              `UPDATE omni_conversations SET last_message_at = NOW(), updated_at = NOW() WHERE id = $1`,
              [conversation_id],
            );

            await writeAuditLog(
              wreq.workspaceOwnerId,
              wreq.userId,
              "ai_auto_reply_sent",
              String(conversation_id),
              { confidence: result.confidence, message_id: msgInsert.rows[0].id },
            );

            res.json({ ...result, auto_sent: true });
            return;
          }
        }
      }

      res.json({ ...result, auto_sent: false });
    } catch (err) {
      logger.error({ err }, "omnichannel ai: draft-reply failed");
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /omnichannel/ai/summarize
// ---------------------------------------------------------------------------

const summarizeSchema = z.object({
  conversation_id: z.number(),
});

router.post(
  "/omnichannel/ai/summarize",
  agentAuth,
  async (req: Request, res: Response) => {
    try {
      const wreq = await workspace(req);
      const parsed = summarizeSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.message });
        return;
      }

      const { conversation_id } = parsed.data;

      const convCheck = await db.query<{ id: number }>(
        `SELECT id FROM omni_conversations WHERE id = $1 AND workspace_owner_id = $2`,
        [conversation_id, wreq.workspaceOwnerId],
      );
      if (convCheck.rows.length === 0) {
        res.status(404).json({ error: "Conversation not found" });
        return;
      }

      const history = await getConversationMessages(conversation_id, wreq.workspaceOwnerId, 50);
      const aiSettings = await getWorkspaceAiSettings(wreq.workspaceOwnerId);
      const provider = getAIProvider(aiSettings.openai_api_key, `omni:${conversation_id}`);
      const result = await provider.summarize(history);

      await writeAuditLog(
        wreq.workspaceOwnerId,
        wreq.userId,
        "ai_summarize",
        String(conversation_id),
      );

      res.json(result);
    } catch (err) {
      logger.error({ err }, "omnichannel ai: summarize failed");
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// ---------------------------------------------------------------------------
// POST /omnichannel/ai/classify
// ---------------------------------------------------------------------------

const classifySchema = z.object({
  conversation_id: z.number(),
});

router.post(
  "/omnichannel/ai/classify",
  agentAuth,
  async (req: Request, res: Response) => {
    try {
      const wreq = await workspace(req);
      const parsed = classifySchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.message });
        return;
      }

      const { conversation_id } = parsed.data;

      const convCheck = await db.query<{ id: number }>(
        `SELECT id FROM omni_conversations WHERE id = $1 AND workspace_owner_id = $2`,
        [conversation_id, wreq.workspaceOwnerId],
      );
      if (convCheck.rows.length === 0) {
        res.status(404).json({ error: "Conversation not found" });
        return;
      }

      const history = await getConversationMessages(conversation_id, wreq.workspaceOwnerId);
      const aiSettings = await getWorkspaceAiSettings(wreq.workspaceOwnerId);
      const provider = getAIProvider(aiSettings.openai_api_key, `omni:${conversation_id}`);
      const result = await provider.classifyIntent(history);

      await writeAuditLog(
        wreq.workspaceOwnerId,
        wreq.userId,
        "ai_classify_intent",
        String(conversation_id),
        { intent: result.intent, confidence: result.confidence },
      );

      res.json(result);
    } catch (err) {
      logger.error({ err }, "omnichannel ai: classify failed");
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// ai_usage_log intentionally has no workspace column. These owner reports only
// include records that can be attributed safely through an existing order,
// omnichannel conversation, or workspace session marker; unattributed
// operational usage is excluded rather than exposed across workspaces.
const usageReportQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});

const workspaceUsagePredicate = `
  (
    EXISTS (
      SELECT 1 FROM orders o
      WHERE o.id::text = l.order_id AND o.workspace_owner_id = $1
    )
    OR EXISTS (
      SELECT 1 FROM omni_conversations c
      WHERE ('omni:' || c.id::text) = l.session_id
        AND c.workspace_owner_id = $1
    )
    OR l.session_id = ('workspace:' || $1)
  )`;

router.get(
  "/omnichannel/ai/usage-summary",
  ownerAuth,
  async (req: Request, res: Response) => {
    try {
      const wreq = await workspace(req);
      const parsed = usageReportQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.message });
        return;
      }
      const { days } = parsed.data;
      const result = await db.query<{
        action_key: string; provider: string; model_id: string;
        calls: string;
        successful_calls: string;
        input_tokens: string;
        output_tokens: string;
        cached_tokens: string; reasoning_tokens: string; cost_usd: string | null;
        provider_billed_cost_usd: string | null; estimated_cost_usd: string | null;
        unclassified_cost_usd: string | null;
        provider_billed_calls: string; estimated_calls: string;
        unclassified_cost_calls: string;
        priced_calls: string; unpriced_calls: string; fallback_calls: string;
        average_latency_ms: string | null;
      }>(
        `SELECT l.action_key, l.provider, l.model_id,
                COUNT(*)::text AS calls,
                COUNT(*) FILTER (WHERE l.success)::text AS successful_calls,
                COALESCE(SUM(l.input_tokens), 0)::text AS input_tokens,
                COALESCE(SUM(l.output_tokens), 0)::text AS output_tokens,
                COALESCE(SUM(l.cached_tokens), 0)::text AS cached_tokens,
                COALESCE(SUM(l.reasoning_tokens), 0)::text AS reasoning_tokens,
                SUM(l.cost_usd)::text AS cost_usd,
                SUM(l.cost_usd) FILTER (WHERE l.cost_source = 'provider_billed')::text AS provider_billed_cost_usd,
                SUM(l.cost_usd) FILTER (WHERE l.cost_source = 'estimated')::text AS estimated_cost_usd,
                SUM(l.cost_usd) FILTER (WHERE l.cost_source IS NULL)::text AS unclassified_cost_usd,
                COUNT(*) FILTER (WHERE l.success AND l.cost_source = 'provider_billed')::text AS provider_billed_calls,
                COUNT(*) FILTER (WHERE l.success AND l.cost_source = 'estimated')::text AS estimated_calls,
                COUNT(*) FILTER (WHERE l.success AND l.cost_usd IS NOT NULL AND l.cost_source IS NULL)::text AS unclassified_cost_calls,
                COUNT(*) FILTER (WHERE l.success AND l.cost_usd IS NOT NULL)::text AS priced_calls,
                COUNT(*) FILTER (WHERE l.success AND l.cost_usd IS NULL)::text AS unpriced_calls,
                COUNT(*) FILTER (WHERE l.was_fallback)::text AS fallback_calls,
                ROUND(AVG(l.latency_ms))::text AS average_latency_ms
           FROM ai_usage_log l
          WHERE l.created_at >= NOW() - ($2::text || ' days')::interval
            AND ${workspaceUsagePredicate}
          GROUP BY l.action_key, l.provider, l.model_id
          ORDER BY COUNT(*) DESC, l.action_key, l.provider, l.model_id`,
        [wreq.workspaceOwnerId, days],
      );
      const actions = result.rows.map((row) => ({
        action_key: row.action_key,
        provider: row.provider,
        model_id: row.model_id,
        calls: Number(row.calls),
        successful_calls: Number(row.successful_calls),
        failed_calls: Number(row.calls) - Number(row.successful_calls),
        input_tokens: Number(row.input_tokens),
        output_tokens: Number(row.output_tokens),
        cached_tokens: Number(row.cached_tokens ?? 0),
        reasoning_tokens: Number(row.reasoning_tokens ?? 0),
        cost_usd: row.cost_usd == null ? null : Number(row.cost_usd),
        provider_billed_cost_usd: row.provider_billed_cost_usd == null ? null : Number(row.provider_billed_cost_usd),
        estimated_cost_usd: row.estimated_cost_usd == null ? null : Number(row.estimated_cost_usd),
        unclassified_cost_usd: row.unclassified_cost_usd == null ? null : Number(row.unclassified_cost_usd),
        provider_billed_calls: Number(row.provider_billed_calls ?? 0),
        estimated_calls: Number(row.estimated_calls ?? 0),
        unclassified_cost_calls: Number(row.unclassified_cost_calls ?? 0),
        priced_calls: Number(row.priced_calls ?? 0),
        unpriced_calls: Number(row.unpriced_calls ?? 0),
        fallback_calls: Number(row.fallback_calls ?? 0),
        average_latency_ms: row.average_latency_ms == null
          ? null
          : Number(row.average_latency_ms),
      }));
      const totals = actions.reduce(
        (total, row) => ({
          calls: total.calls + row.calls, successful_calls: total.successful_calls + row.successful_calls,
          failed_calls: total.failed_calls + row.failed_calls, input_tokens: total.input_tokens + row.input_tokens,
          output_tokens: total.output_tokens + row.output_tokens, cached_tokens: total.cached_tokens + row.cached_tokens,
          reasoning_tokens: total.reasoning_tokens + row.reasoning_tokens, priced_calls: total.priced_calls + row.priced_calls,
          unpriced_calls: total.unpriced_calls + row.unpriced_calls, fallback_calls: total.fallback_calls + row.fallback_calls,
          cost_usd: total.cost_usd + (row.cost_usd ?? 0),
          provider_billed_cost_usd: total.provider_billed_cost_usd + (row.provider_billed_cost_usd ?? 0),
          estimated_cost_usd: total.estimated_cost_usd + (row.estimated_cost_usd ?? 0),
          unclassified_cost_usd: total.unclassified_cost_usd + (row.unclassified_cost_usd ?? 0),
          provider_billed_calls: total.provider_billed_calls + row.provider_billed_calls,
          estimated_calls: total.estimated_calls + row.estimated_calls,
          unclassified_cost_calls: total.unclassified_cost_calls + row.unclassified_cost_calls,
        }),
        { calls: 0, successful_calls: 0, failed_calls: 0, input_tokens: 0, output_tokens: 0,
           cached_tokens: 0, reasoning_tokens: 0, priced_calls: 0, unpriced_calls: 0, fallback_calls: 0, cost_usd: 0,
           provider_billed_cost_usd: 0, estimated_cost_usd: 0, unclassified_cost_usd: 0,
           provider_billed_calls: 0, estimated_calls: 0, unclassified_cost_calls: 0 },
      );
      res.json({
        scope: "workspace_attributed_records_only",
        scope_note:
          "Includes usage linked to this workspace through an order, omnichannel conversation, or workspace session; unattributed usage is excluded.",
        days,
        cost_note: "provider_billed_cost_usd is returned by the provider; estimated_cost_usd uses the model pricing registry; unclassified_cost_usd is legacy cost recorded before provenance tracking. cost_usd combines all three and is partial when unpriced_calls is nonzero.",
        totals: {
          ...totals,
          cost_usd: totals.priced_calls > 0 ? totals.cost_usd : null,
          provider_billed_cost_usd: totals.provider_billed_calls > 0 ? totals.provider_billed_cost_usd : null,
          estimated_cost_usd: totals.estimated_calls > 0 ? totals.estimated_cost_usd : null,
          unclassified_cost_usd: totals.unclassified_cost_calls > 0 ? totals.unclassified_cost_usd : null,
        },
        actions,
      });
    } catch (err) {
      logger.error({ err }, "omnichannel ai: usage summary failed");
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

function csvCell(value: unknown): string {
  let text = value == null ? "" : String(value);
  if (/^\s*[=+@-]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

router.get(
  "/omnichannel/ai/usage.csv",
  ownerAuth,
  async (req: Request, res: Response) => {
    try {
      const wreq = await workspace(req);
      const parsed = usageReportQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.message });
        return;
      }
      const result = await db.query<Record<string, unknown>>(
        `SELECT l.created_at, l.action_key, l.surface, l.provider, l.model_id,
                l.key_source, l.was_fallback, l.input_tokens, l.output_tokens,
                 l.cached_tokens, l.reasoning_tokens, l.cost_usd, l.cost_source, l.latency_ms,
                l.success, l.error_code, l.order_id, l.session_id, l.country,
                l.image_size, l.image_quality
           FROM ai_usage_log l
          WHERE l.created_at >= NOW() - ($2::text || ' days')::interval
            AND ${workspaceUsagePredicate}
          ORDER BY l.created_at DESC
          LIMIT 10000`,
        [wreq.workspaceOwnerId, parsed.data.days],
      );
      const columns = [
        "created_at", "action_key", "surface", "provider", "model_id",
        "key_source", "was_fallback", "input_tokens", "output_tokens",
         "cached_tokens", "reasoning_tokens", "cost_usd", "cost_source", "latency_ms",
         "success", "error_code", "order_id", "session_id", "country",
         "image_size", "image_quality",
      ];
      const csv = [
        columns.join(","),
        ...result.rows.map((row) => columns.map((column) => csvCell(row[column])).join(",")),
      ].join("\r\n");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="ai-usage-workspace-attributed.csv"',
      );
      res.send(csv);
    } catch (err) {
      logger.error({ err }, "omnichannel ai: usage CSV failed");
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

export default router;
