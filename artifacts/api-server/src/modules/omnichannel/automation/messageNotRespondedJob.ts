// ---------------------------------------------------------------------------
// Omnichannel — "message_not_responded" scheduled job
//
// Runs every minute.  For each active automation flow whose trigger is
// "message_not_responded", scans open conversations that:
//   1. Have an inbound message older than `minutesThreshold` minutes.
//   2. Have not received an outbound message since that inbound message.
//   3. Have no currently running/waiting automation execution.
// Then starts the matching flow for each qualifying conversation.
// ---------------------------------------------------------------------------

import { db } from "../../../lib/db";
import { logger } from "../../../lib/logger";
import { startFlow } from "./flowExecutor";
import type { TriggerDefinition, FlowGraph } from "./flowTypes";

const POLL_INTERVAL_MS = 60_000;

let pollerHandle: ReturnType<typeof setInterval> | null = null;

interface FlowRow {
  id: number;
  trigger_conditions: TriggerDefinition | null;
  flow_graph: FlowGraph;
  workspace_owner_id: string;
}

interface ConversationRow {
  id: number;
}

async function scanOnce(): Promise<void> {
  const flowsResult = await db.query<FlowRow>(
    `SELECT id, trigger_conditions, flow_graph, workspace_owner_id
     FROM omni_automation_flows
     WHERE state = 'active' AND trigger_type = 'message_not_responded'`,
  );

  if (flowsResult.rows.length === 0) return;

  for (const flow of flowsResult.rows) {
    const minutesThreshold = flow.trigger_conditions?.minutesThreshold ?? 60;

    const convsResult = await db.query<ConversationRow>(
      `SELECT c.id
       FROM omni_conversations c
       WHERE c.workspace_owner_id = $1
         AND c.status = 'open'
         AND c.last_inbound_at IS NOT NULL
         AND c.last_inbound_at <= NOW() - ($2 || ' minutes')::interval
         AND (
           c.last_message_at IS NULL
           OR c.last_message_at <= c.last_inbound_at
         )
         AND NOT EXISTS (
           SELECT 1 FROM omni_messages m
           WHERE m.conversation_id = c.id
             AND m.direction = 'outbound'
             AND m.created_at >= c.last_inbound_at
         )
         AND NOT EXISTS (
           SELECT 1 FROM omni_automation_executions ae
           WHERE ae.conversation_id = c.id
             AND ae.status IN ('running', 'waiting')
         )`,
      [flow.workspace_owner_id, String(minutesThreshold)],
    );

    for (const conv of convsResult.rows) {
      try {
        await startFlow(flow.id, conv.id, { trigger: "message_not_responded" });
        logger.info(
          { flowId: flow.id, conversationId: conv.id, minutesThreshold },
          "omnichannel: message_not_responded flow started",
        );
      } catch (err) {
        logger.error(
          { err, flowId: flow.id, conversationId: conv.id },
          "omnichannel: failed to start message_not_responded flow",
        );
      }
    }
  }
}

export function startMessageNotRespondedJob(): void {
  if (pollerHandle !== null) return;

  pollerHandle = setInterval(() => {
    scanOnce().catch((err: unknown) => {
      logger.error({ err }, "omnichannel: messageNotRespondedJob scan threw unexpected error");
    });
  }, POLL_INTERVAL_MS);

  logger.info(
    { intervalMs: POLL_INTERVAL_MS },
    "omnichannel: message_not_responded job started",
  );
}

export function stopMessageNotRespondedJob(): void {
  if (pollerHandle !== null) {
    clearInterval(pollerHandle);
    pollerHandle = null;
  }
}
