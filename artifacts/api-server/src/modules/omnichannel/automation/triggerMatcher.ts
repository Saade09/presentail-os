// ---------------------------------------------------------------------------
// Omnichannel Phase 5 — Trigger matcher
// Matches inbound messages against active automation flow triggers
// ---------------------------------------------------------------------------

import { db } from "../../../lib/db";
import { logger } from "../../../lib/logger";
import type { TriggerDefinition, FlowGraph } from "./flowTypes";

interface InboundMessageContext {
  content: string | null;
  conversationId: number;
  contactId: number;
  workspaceOwnerId: string;
  channelAccountId: number;
  isFirstMessage: boolean;
}

interface FlowRow {
  id: number;
  trigger_type: string;
  trigger_conditions: TriggerDefinition | null;
  flow_graph: FlowGraph;
  state: string;
  name: string;
}

/**
 * matchTriggers — called for each inbound message.
 * Returns a list of flow IDs whose triggers match the event.
 */
export async function matchTriggers(ctx: InboundMessageContext): Promise<number[]> {
  const { workspaceOwnerId, content, isFirstMessage, conversationId, contactId } = ctx;

  const flowsResult = await db.query<FlowRow>(
    `SELECT id, trigger_type, trigger_conditions, flow_graph, state, name
     FROM omni_automation_flows
     WHERE workspace_owner_id = $1 AND state = 'active'`,
    [workspaceOwnerId],
  );

  const matchedFlowIds: number[] = [];

  for (const flow of flowsResult.rows) {
    const trigger = flow.trigger_conditions;
    const triggerType = flow.trigger_type as TriggerDefinition["type"];

    try {
      if (triggerType === "first_inbound_message") {
        if (isFirstMessage) {
          matchedFlowIds.push(flow.id);
        }
        continue;
      }

      if (triggerType === "keyword_match") {
        if (!trigger || !trigger.keyword || !content) continue;

        const keyword = trigger.keyword.toLowerCase();
        const text = content.toLowerCase();
        const mode = trigger.keywordMode ?? "contains";

        let matched = false;
        if (mode === "exact") {
          matched = text.trim() === keyword.trim();
        } else if (mode === "contains") {
          matched = text.includes(keyword);
        } else if (mode === "regex") {
          try {
            matched = new RegExp(trigger.keyword, "i").test(content);
          } catch {
            matched = false;
          }
        }

        if (matched) matchedFlowIds.push(flow.id);
        continue;
      }

      if (triggerType === "tag_added") {
        // tag_added triggers are fired separately by the tag-addition event handler
        continue;
      }

      if (triggerType === "message_not_responded") {
        // This trigger is time-based and handled by a separate scheduled check
        continue;
      }
    } catch (err) {
      logger.warn(
        { err, flowId: flow.id, conversationId, contactId },
        "automation: trigger match error — skipping flow",
      );
    }
  }

  return matchedFlowIds;
}

/**
 * matchTagAddedTriggers — called when a tag is added to a conversation.
 * Returns flow IDs whose trigger is "tag_added" and matches the tag name.
 */
export async function matchTagAddedTriggers(
  workspaceOwnerId: string,
  tagName: string,
): Promise<number[]> {
  const flowsResult = await db.query<FlowRow>(
    `SELECT id, trigger_type, trigger_conditions, flow_graph, state, name
     FROM omni_automation_flows
     WHERE workspace_owner_id = $1 AND state = 'active' AND trigger_type = 'tag_added'`,
    [workspaceOwnerId],
  );

  const matchedFlowIds: number[] = [];

  for (const flow of flowsResult.rows) {
    const trigger = flow.trigger_conditions;
    if (trigger?.tagName && trigger.tagName.toLowerCase() === tagName.toLowerCase()) {
      matchedFlowIds.push(flow.id);
    }
  }

  return matchedFlowIds;
}

/**
 * resumeWaitingExecution — resumes a 'waiting' execution when a new inbound
 * message arrives on the conversation.  If the execution was waiting for an
 * ask_question answer, stores the answer in the contact custom field.
 */
export async function resumeWaitingExecution(
  conversationId: number,
  inboundContent: string | null,
): Promise<void> {
  const execResult = await db.query<{
    id: string;
    flow_id: number;
    context: Record<string, unknown> | null;
    current_node_id: string | null;
  }>(
    `SELECT id, flow_id, context, current_node_id
     FROM omni_automation_executions
     WHERE conversation_id = $1 AND status = 'waiting'
     ORDER BY started_at DESC LIMIT 1`,
    [conversationId],
  );

  if (execResult.rows.length === 0) return;

  const exec = execResult.rows[0];
  const ctx = exec.context ?? {};

  // If it was waiting for a field answer, save the answer
  if (ctx.waitingForField && inboundContent) {
    const fieldKey = ctx.waitingForField as string;

    const convResult = await db.query<{ contact_id: number }>(
      `SELECT contact_id FROM omni_conversations WHERE id = $1 LIMIT 1`,
      [conversationId],
    );
    const contactId = convResult.rows[0]?.contact_id;

    if (contactId) {
      await db.query(
        `UPDATE omni_contacts
         SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb, updated_at = NOW()
         WHERE id = $2`,
        [JSON.stringify({ [fieldKey]: inboundContent }), contactId],
      );
    }
  }

  // If it was delayed, check if the delay has passed
  if (ctx.delayResumeAt) {
    const resumeAt = new Date(ctx.delayResumeAt as string);
    if (Date.now() < resumeAt.getTime()) {
      return;
    }
  }

  // Resume execution from the current node's next node
  const { resumeExecution } = await import("./flowExecutor");
  await resumeExecution(exec.id, inboundContent);
}
