import { Router } from "express";
import type { Request, Response } from "express";
import { db } from "../../../lib/db";
import { requireOmnichannelRole } from "../omnichannelAuth";
import type { WorkspaceRequest } from "../../../lib/workspace";

const router = Router();

const agentAuth = requireOmnichannelRole("omnichannel:agent");

function getDaysParam(req: Request): number {
  const d = parseInt((req.query["days"] as string) ?? "30", 10);
  if (isNaN(d) || d < 1) return 30;
  if (d > 365) return 365;
  return d;
}

// ---------------------------------------------------------------------------
// GET /omnichannel/analytics/overview
// ---------------------------------------------------------------------------
router.get(
  "/omnichannel/analytics/overview",
  ...agentAuth,
  async (req: Request, res: Response): Promise<void> => {
    const { workspaceOwnerId } = req as WorkspaceRequest;
    const days = getDaysParam(req);

    const [
      convResult,
      msgResult,
      responseTimeResult,
      resolutionTimeResult,
      automationResult,
      handoffResult,
      failedOutboundResult,
      topTagsResult,
      webhookFailureResult,
    ] = await Promise.all([
      // Total conversations in window
      db.query<{ total: string }>(
        `SELECT COUNT(*) AS total
         FROM omni_conversations
         WHERE workspace_owner_id = $1
           AND created_at >= NOW() - ($2 || ' days')::interval`,
        [workspaceOwnerId, days],
      ),
      // Inbound + outbound message counts by day
      db.query<{ date: string; inbound: string; outbound: string }>(
        `SELECT date_trunc('day', created_at)::date::text AS date,
                SUM(CASE WHEN direction = 'inbound'  THEN 1 ELSE 0 END) AS inbound,
                SUM(CASE WHEN direction = 'outbound' THEN 1 ELSE 0 END) AS outbound
         FROM omni_messages
         WHERE workspace_owner_id = $1
           AND created_at >= NOW() - ($2 || ' days')::interval
         GROUP BY 1
         ORDER BY 1`,
        [workspaceOwnerId, days],
      ),
      // Avg first response time (seconds): time from conversation creation to first outbound agent message
      db.query<{ avg_seconds: string | null }>(
        `WITH first_response AS (
           SELECT c.id,
                  EXTRACT(EPOCH FROM (MIN(m.created_at) - c.created_at)) AS secs
           FROM omni_conversations c
           JOIN omni_messages m ON m.conversation_id = c.id
             AND m.direction = 'outbound'
             AND m.sender_agent_id IS NOT NULL
           WHERE c.workspace_owner_id = $1
             AND c.created_at >= NOW() - ($2 || ' days')::interval
           GROUP BY c.id
         )
         SELECT AVG(secs) AS avg_seconds FROM first_response`,
        [workspaceOwnerId, days],
      ),
      // Avg resolution time (seconds): from created_at to resolved_at
      db.query<{ avg_seconds: string | null }>(
        `SELECT AVG(EXTRACT(EPOCH FROM (resolved_at - created_at))) AS avg_seconds
         FROM omni_conversations
         WHERE workspace_owner_id = $1
           AND resolved_at IS NOT NULL
           AND created_at >= NOW() - ($2 || ' days')::interval`,
        [workspaceOwnerId, days],
      ),
      // Automation resolution rate: executions that finished with status=completed + conversation resolved
      db.query<{ automation_resolved: string; total_resolved: string }>(
        `SELECT
           (SELECT COUNT(*) FROM omni_automation_executions ae
            JOIN omni_conversations c ON c.id = ae.conversation_id
            WHERE c.workspace_owner_id = $1
              AND ae.status = 'completed'
              AND c.status = 'resolved'
              AND ae.started_at >= NOW() - ($2 || ' days')::interval) AS automation_resolved,
           (SELECT COUNT(*) FROM omni_conversations
            WHERE workspace_owner_id = $1
              AND status = 'resolved'
              AND resolved_at >= NOW() - ($2 || ' days')::interval) AS total_resolved`,
        [workspaceOwnerId, days],
      ),
      // Human handoff rate: conversations that were assigned to an agent after automation
      db.query<{ handoff_count: string; total_conv: string }>(
        `SELECT
           (SELECT COUNT(DISTINCT conversation_id) FROM omni_automation_executions ae
            JOIN omni_conversations c ON c.id = ae.conversation_id
            WHERE c.workspace_owner_id = $1
              AND c.assigned_agent_id IS NOT NULL
              AND ae.started_at >= NOW() - ($2 || ' days')::interval) AS handoff_count,
           (SELECT COUNT(*) FROM omni_conversations
            WHERE workspace_owner_id = $1
              AND created_at >= NOW() - ($2 || ' days')::interval) AS total_conv`,
        [workspaceOwnerId, days],
      ),
      // Failed outbound messages
      db.query<{ failed_count: string }>(
        `SELECT COUNT(*) AS failed_count
         FROM omni_messages
         WHERE workspace_owner_id = $1
           AND direction = 'outbound'
           AND status = 'failed'
           AND created_at >= NOW() - ($2 || ' days')::interval`,
        [workspaceOwnerId, days],
      ),
      // Top 5 tags by usage in conversations
      db.query<{ tag_name: string; usage_count: string }>(
        `SELECT t.name AS tag_name, COUNT(*) AS usage_count
         FROM omni_conversation_tags ct
         JOIN omni_tags t ON t.id = ct.tag_id
         JOIN omni_conversations c ON c.id = ct.conversation_id
         WHERE c.workspace_owner_id = $1
           AND c.created_at >= NOW() - ($2 || ' days')::interval
         GROUP BY t.name
         ORDER BY usage_count DESC
         LIMIT 5`,
        [workspaceOwnerId, days],
      ),
      // Webhook failure count (raw events that had processing errors)
      db.query<{ failure_count: string }>(
        `SELECT COUNT(*) AS failure_count
         FROM omni_webhook_raw_events wre
         JOIN omni_channel_accounts ca ON ca.id = wre.channel_account_id
         WHERE ca.workspace_owner_id = $1
           AND wre.processing_error IS NOT NULL
           AND wre.created_at >= NOW() - ($2 || ' days')::interval`,
        [workspaceOwnerId, days],
      ),
    ]);

    const totalResolved = parseInt(automationResult.rows[0]?.total_resolved ?? "0", 10);
    const automationResolved = parseInt(automationResult.rows[0]?.automation_resolved ?? "0", 10);
    const totalConv = parseInt(handoffResult.rows[0]?.total_conv ?? "0", 10);
    const handoffCount = parseInt(handoffResult.rows[0]?.handoff_count ?? "0", 10);

    res.json({
      success: true,
      days,
      total_conversations: parseInt(convResult.rows[0]?.total ?? "0", 10),
      messages_by_day: msgResult.rows.map((r) => ({
        date: r.date,
        inbound: parseInt(r.inbound, 10),
        outbound: parseInt(r.outbound, 10),
      })),
      avg_first_response_seconds: responseTimeResult.rows[0]?.avg_seconds
        ? parseFloat(responseTimeResult.rows[0].avg_seconds)
        : null,
      avg_resolution_seconds: resolutionTimeResult.rows[0]?.avg_seconds
        ? parseFloat(resolutionTimeResult.rows[0].avg_seconds)
        : null,
      automation_resolution_rate:
        totalResolved > 0 ? automationResolved / totalResolved : null,
      human_handoff_rate: totalConv > 0 ? handoffCount / totalConv : null,
      failed_outbound_count: parseInt(failedOutboundResult.rows[0]?.failed_count ?? "0", 10),
      top_tags: topTagsResult.rows.map((r) => ({
        name: r.tag_name,
        count: parseInt(r.usage_count, 10),
      })),
      webhook_failure_count: parseInt(webhookFailureResult.rows[0]?.failure_count ?? "0", 10),
    });
  },
);

// ---------------------------------------------------------------------------
// GET /omnichannel/analytics/channels
// ---------------------------------------------------------------------------
router.get(
  "/omnichannel/analytics/channels",
  ...agentAuth,
  async (req: Request, res: Response): Promise<void> => {
    const { workspaceOwnerId } = req as WorkspaceRequest;
    const days = getDaysParam(req);

    const result = await db.query<{
      id: number;
      provider: string;
      name: string;
      status: string;
      last_webhook_received_at: Date | null;
      last_error: string | null;
      conversation_count: string;
      message_count: string;
      failed_webhook_count: string;
    }>(
      `SELECT ca.id, ca.provider, ca.name, ca.status,
              ca.last_webhook_received_at, ca.last_error,
              COUNT(DISTINCT c.id) AS conversation_count,
              COUNT(DISTINCT m.id) AS message_count,
              (SELECT COUNT(*) FROM omni_webhook_raw_events wre
               WHERE wre.channel_account_id = ca.id
                 AND wre.processing_error IS NOT NULL
                 AND wre.created_at >= NOW() - ($2 || ' days')::interval) AS failed_webhook_count
       FROM omni_channel_accounts ca
       LEFT JOIN omni_conversations c ON c.channel_account_id = ca.id
         AND c.created_at >= NOW() - ($2 || ' days')::interval
       LEFT JOIN omni_messages m ON m.channel_account_id = ca.id
         AND m.created_at >= NOW() - ($2 || ' days')::interval
       WHERE ca.workspace_owner_id = $1 AND ca.is_active = true
       GROUP BY ca.id
       ORDER BY ca.name`,
      [workspaceOwnerId, days],
    );

    res.json({
      success: true,
      days,
      channels: result.rows.map((r) => ({
        id: r.id,
        provider: r.provider,
        name: r.name,
        status: r.status,
        last_webhook_received_at: r.last_webhook_received_at,
        last_error: r.last_error,
        conversation_count: parseInt(r.conversation_count, 10),
        message_count: parseInt(r.message_count, 10),
        failed_webhook_count: parseInt(r.failed_webhook_count, 10),
      })),
    });
  },
);

// ---------------------------------------------------------------------------
// GET /omnichannel/analytics/flows
// ---------------------------------------------------------------------------
router.get(
  "/omnichannel/analytics/flows",
  ...agentAuth,
  async (req: Request, res: Response): Promise<void> => {
    const { workspaceOwnerId } = req as WorkspaceRequest;
    const days = getDaysParam(req);

    const result = await db.query<{
      flow_id: number;
      flow_name: string;
      state: string;
      total_executions: string;
      completed_executions: string;
      failed_executions: string;
      avg_duration_seconds: string | null;
    }>(
      `SELECT af.id AS flow_id, af.name AS flow_name, af.state,
              COUNT(ae.id) AS total_executions,
              SUM(CASE WHEN ae.status = 'completed' THEN 1 ELSE 0 END) AS completed_executions,
              SUM(CASE WHEN ae.status = 'failed'    THEN 1 ELSE 0 END) AS failed_executions,
              AVG(EXTRACT(EPOCH FROM (ae.finished_at - ae.started_at))) AS avg_duration_seconds
       FROM omni_automation_flows af
       LEFT JOIN omni_automation_executions ae ON ae.flow_id = af.id
         AND ae.started_at >= NOW() - ($2 || ' days')::interval
       WHERE af.workspace_owner_id = $1
       GROUP BY af.id
       ORDER BY total_executions DESC`,
      [workspaceOwnerId, days],
    );

    res.json({
      success: true,
      days,
      flows: result.rows.map((r) => ({
        flow_id: r.flow_id,
        flow_name: r.flow_name,
        state: r.state,
        total_executions: parseInt(r.total_executions, 10),
        completed_executions: parseInt(r.completed_executions, 10),
        failed_executions: parseInt(r.failed_executions, 10),
        avg_duration_seconds: r.avg_duration_seconds
          ? parseFloat(r.avg_duration_seconds)
          : null,
      })),
    });
  },
);

// ---------------------------------------------------------------------------
// GET /omnichannel/analytics/agents
// ---------------------------------------------------------------------------
router.get(
  "/omnichannel/analytics/agents",
  ...agentAuth,
  async (req: Request, res: Response): Promise<void> => {
    const { workspaceOwnerId } = req as WorkspaceRequest;
    const days = getDaysParam(req);

    const result = await db.query<{
      agent_id: string;
      conversations_assigned: string;
      conversations_resolved: string;
      messages_sent: string;
      avg_resolution_seconds: string | null;
    }>(
      `SELECT c.assigned_agent_id AS agent_id,
              COUNT(DISTINCT c.id) AS conversations_assigned,
              COUNT(DISTINCT CASE WHEN c.status = 'resolved' THEN c.id END) AS conversations_resolved,
              COUNT(DISTINCT m.id) AS messages_sent,
              AVG(CASE WHEN c.resolved_at IS NOT NULL
                  THEN EXTRACT(EPOCH FROM (c.resolved_at - c.created_at)) END) AS avg_resolution_seconds
       FROM omni_conversations c
       LEFT JOIN omni_messages m ON m.conversation_id = c.id
         AND m.direction = 'outbound'
         AND m.sender_agent_id = c.assigned_agent_id
       WHERE c.workspace_owner_id = $1
         AND c.assigned_agent_id IS NOT NULL
         AND c.created_at >= NOW() - ($2 || ' days')::interval
       GROUP BY c.assigned_agent_id
       ORDER BY conversations_assigned DESC`,
      [workspaceOwnerId, days],
    );

    res.json({
      success: true,
      days,
      agents: result.rows.map((r) => ({
        agent_id: r.agent_id,
        conversations_assigned: parseInt(r.conversations_assigned, 10),
        conversations_resolved: parseInt(r.conversations_resolved, 10),
        messages_sent: parseInt(r.messages_sent, 10),
        avg_resolution_seconds: r.avg_resolution_seconds
          ? parseFloat(r.avg_resolution_seconds)
          : null,
      })),
    });
  },
);

export default router;
