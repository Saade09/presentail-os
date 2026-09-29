// ---------------------------------------------------------------------------
// Omnichannel Phase 5 — Flow executor engine
// ---------------------------------------------------------------------------

import { db } from "../../../lib/db";
import { logger } from "../../../lib/logger";
import type {
  FlowGraph,
  FlowNode,
  ConditionNode,
  FlowEdge,
} from "./flowTypes";
import type { ExecutionContext } from "./actionHandlers";
import * as handlers from "./actionHandlers";

// ---------------------------------------------------------------------------
// Safety guards — configurable per flow
// ---------------------------------------------------------------------------

const DEFAULT_MAX_MESSAGES_PER_HOUR = 10;

async function isOverMessageLimit(
  workspaceOwnerId: string,
  conversationId: number,
  maxPerHour = DEFAULT_MAX_MESSAGES_PER_HOUR,
): Promise<boolean> {
  const result = await db.query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM omni_messages
     WHERE conversation_id = $1
       AND workspace_owner_id = $2
       AND direction = 'outbound'
       AND sender_name = 'Automation'
       AND created_at >= NOW() - INTERVAL '1 hour'`,
    [conversationId, workspaceOwnerId],
  );
  return parseInt(result.rows[0]?.count ?? "0", 10) >= maxPerHour;
}

async function hasActiveExecution(conversationId: number): Promise<boolean> {
  const result = await db.query<{ id: string }>(
    `SELECT id FROM omni_automation_executions
     WHERE conversation_id = $1 AND status IN ('running', 'waiting')
     LIMIT 1`,
    [conversationId],
  );
  return result.rows.length > 0;
}

async function isOptedOut(contactId: number): Promise<boolean> {
  const result = await db.query<{ metadata: Record<string, unknown> | null }>(
    `SELECT metadata FROM omni_contacts WHERE id = $1 LIMIT 1`,
    [contactId],
  );
  const meta = result.rows[0]?.metadata;
  return meta?.consent === "opted_out";
}

function isOptOutKeyword(content: string | null): boolean {
  if (!content) return false;
  const normalized = content.trim().toUpperCase();
  return ["STOP", "UNSUBSCRIBE", "OPTOUT", "OPT OUT", "CANCEL", "END"].includes(normalized);
}

// ---------------------------------------------------------------------------
// startFlow — create execution row and begin processing from entry node
// ---------------------------------------------------------------------------

export async function startFlow(
  flowId: number,
  conversationId: number,
  triggerPayload: Record<string, unknown> = {},
): Promise<string | null> {
  const flowResult = await db.query<{
    id: number;
    flow_graph: FlowGraph;
    workspace_owner_id: string;
    state: string;
  }>(
    `SELECT id, flow_graph, workspace_owner_id, state FROM omni_automation_flows WHERE id = $1`,
    [flowId],
  );

  const flow = flowResult.rows[0];
  if (!flow || flow.state !== "active") {
    logger.warn({ flowId }, "automation: attempted to start inactive/missing flow");
    return null;
  }

  const convResult = await db.query<{
    contact_id: number;
    channel_account_id: number;
    workspace_owner_id: string;
    metadata: Record<string, unknown> | null;
  }>(
    `SELECT contact_id, channel_account_id, workspace_owner_id, metadata
     FROM omni_conversations WHERE id = $1`,
    [conversationId],
  );

  const conv = convResult.rows[0];
  if (!conv) {
    logger.warn({ flowId, conversationId }, "automation: conversation not found");
    return null;
  }

  // Safety: no duplicate active executions
  if (await hasActiveExecution(conversationId)) {
    logger.info({ flowId, conversationId }, "automation: conversation already has active execution — skipping");
    return null;
  }

  // Safety: opted-out contact
  if (await isOptedOut(conv.contact_id)) {
    logger.info({ flowId, conversationId }, "automation: contact opted out — skipping");
    return null;
  }

  // Safety: automation paused on conversation
  const paused = (conv.metadata as Record<string, unknown> | null)?.automation_paused === true;
  if (paused) {
    logger.info({ flowId, conversationId }, "automation: automation paused on conversation — skipping");
    return null;
  }

  // Safety: hourly message limit
  if (await isOverMessageLimit(conv.workspace_owner_id, conversationId)) {
    logger.info({ flowId, conversationId }, "automation: hourly message limit reached — skipping");
    return null;
  }

  // Get recipient external ID
  const identityResult = await db.query<{ external_user_id: string }>(
    `SELECT ci.external_user_id
     FROM omni_contact_identities ci
     WHERE ci.contact_id = $1 AND ci.channel_account_id = $2
     LIMIT 1`,
    [conv.contact_id, conv.channel_account_id],
  );
  const recipientExternalId = identityResult.rows[0]?.external_user_id ?? "";

  // Create execution row
  const execResult = await db.query<{ id: string }>(
    `INSERT INTO omni_automation_executions
       (flow_id, conversation_id, contact_id, status, current_node_id, context, started_at)
     VALUES ($1, $2, $3, 'running', $4, $5, NOW())
     RETURNING id`,
    [
      flowId,
      conversationId,
      conv.contact_id,
      flow.flow_graph.entryNodeId,
      JSON.stringify({ triggerPayload }),
    ],
  );

  const executionId = execResult.rows[0].id;

  // Increment flow execution count
  await db.query(
    `UPDATE omni_automation_flows SET execution_count = execution_count + 1 WHERE id = $1`,
    [flowId],
  );

  const ctx: ExecutionContext = {
    executionId,
    flowId,
    conversationId,
    contactId: conv.contact_id,
    workspaceOwnerId: conv.workspace_owner_id,
    channelAccountId: conv.channel_account_id,
    recipientExternalId,
    variables: {},
  };

  logger.info({ executionId, flowId, conversationId }, "automation: execution started");

  // Start processing asynchronously to avoid blocking the caller
  setImmediate(() => {
    executeNode(executionId, flow.flow_graph.entryNodeId, ctx, flow.flow_graph)
      .catch((err: unknown) => {
        logger.error({ err, executionId }, "automation: unhandled error in executeNode");
      });
  });

  return executionId;
}

// ---------------------------------------------------------------------------
// resumeExecution — called when a new inbound message arrives on a waiting conversation
// ---------------------------------------------------------------------------

export async function resumeExecution(
  executionId: string,
  inboundContent: string | null,
): Promise<void> {
  if (isOptOutKeyword(inboundContent)) {
    // Mark contact opted out and halt
    const execResult = await db.query<{ contact_id: number }>(
      `SELECT contact_id FROM omni_automation_executions WHERE id = $1`,
      [executionId],
    );
    const contactId = execResult.rows[0]?.contact_id;
    if (contactId) {
      await db.query(
        `UPDATE omni_contacts
         SET metadata = COALESCE(metadata, '{}'::jsonb) || '{"consent": "opted_out"}'::jsonb
         WHERE id = $1`,
        [contactId],
      );
    }
    await db.query(
      `UPDATE omni_automation_executions SET status = 'finished', finished_at = NOW() WHERE id = $1`,
      [executionId],
    );
    logger.info({ executionId }, "automation: opt-out detected — execution halted");
    return;
  }

  const execResult = await db.query<{
    id: string;
    flow_id: number;
    conversation_id: number;
    contact_id: number;
    current_node_id: string | null;
    context: Record<string, unknown> | null;
    status: string;
  }>(
    `SELECT id, flow_id, conversation_id, contact_id, current_node_id, context, status
     FROM omni_automation_executions WHERE id = $1`,
    [executionId],
  );

  const exec = execResult.rows[0];
  if (!exec || exec.status !== "waiting") return;

  const flowResult = await db.query<{ flow_graph: FlowGraph; workspace_owner_id: string }>(
    `SELECT flow_graph, workspace_owner_id FROM omni_automation_flows WHERE id = $1`,
    [exec.flow_id],
  );
  const flow = flowResult.rows[0];
  if (!flow) return;

  const convResult = await db.query<{
    channel_account_id: number;
  }>(
    `SELECT channel_account_id FROM omni_conversations WHERE id = $1`,
    [exec.conversation_id],
  );

  const identityResult = await db.query<{ external_user_id: string }>(
    `SELECT ci.external_user_id
     FROM omni_contact_identities ci
     WHERE ci.contact_id = $1 AND ci.channel_account_id = $2
     LIMIT 1`,
    [exec.contact_id, convResult.rows[0]?.channel_account_id ?? 0],
  );

  const ctx: ExecutionContext = {
    executionId,
    flowId: exec.flow_id,
    conversationId: exec.conversation_id,
    contactId: exec.contact_id,
    workspaceOwnerId: flow.workspace_owner_id,
    channelAccountId: convResult.rows[0]?.channel_account_id ?? 0,
    recipientExternalId: identityResult.rows[0]?.external_user_id ?? "",
    variables: { ...(exec.context as Record<string, string> ?? {}) },
  };

  // If waiting for field answer, save it to variables
  const ctxData = exec.context ?? {};
  if (ctxData.waitingForField && inboundContent) {
    ctx.variables[ctxData.waitingForField as string] = inboundContent;
  }

  // Find the next node from the current node's outgoing edge
  const currentNodeId = exec.current_node_id;
  if (!currentNodeId) {
    await finishExecution(executionId, "finished");
    return;
  }

  // Determine next node from context (for delays) or from outgoing edge
  let nextNodeId: string | null = null;
  if (ctxData.delayNextNodeId) {
    nextNodeId = ctxData.delayNextNodeId as string;
  } else {
    const outEdge = flow.flow_graph.edges.find((e: FlowEdge) => e.source === currentNodeId);
    nextNodeId = outEdge?.target ?? null;
  }

  // Mark execution as running again
  await db.query(
    `UPDATE omni_automation_executions SET status = 'running', context = $1 WHERE id = $2`,
    [JSON.stringify({ ...ctxData, waitingForField: undefined, delayNextNodeId: undefined, delayResumeAt: undefined }), executionId],
  );

  if (!nextNodeId) {
    await finishExecution(executionId, "finished");
    return;
  }

  logger.info({ executionId, nextNodeId }, "automation: execution resumed");

  setImmediate(() => {
    executeNode(executionId, nextNodeId!, ctx, flow.flow_graph)
      .catch((err: unknown) => {
        logger.error({ err, executionId }, "automation: unhandled error in executeNode (resume)");
      });
  });
}

// ---------------------------------------------------------------------------
// executeNode — process a single node and advance
// ---------------------------------------------------------------------------

async function executeNode(
  executionId: string,
  nodeId: string,
  ctx: ExecutionContext,
  graph: FlowGraph,
  depth = 0,
): Promise<void> {
  if (depth > 50) {
    logger.error({ executionId, nodeId }, "automation: max depth reached — aborting");
    await finishExecution(executionId, "error");
    return;
  }

  const node = graph.nodes.find((n: FlowNode) => n.id === nodeId);
  if (!node) {
    logger.warn({ executionId, nodeId }, "automation: node not found in graph");
    await finishExecution(executionId, "error");
    return;
  }

  // Update current node on execution
  await db.query(
    `UPDATE omni_automation_executions SET current_node_id = $1 WHERE id = $2`,
    [nodeId, executionId],
  );

  const outEdge = graph.edges.find((e: FlowEdge) => e.source === nodeId);
  const nextNodeId = outEdge?.target ?? null;

  let result: handlers.HandlerResult = { next: nextNodeId };

  const eventStart = Date.now();

  try {
    switch (node.type) {
      case "trigger":
        result = { next: nextNodeId };
        break;

      case "condition": {
        const condNode = node as ConditionNode;
        const passed = await evaluateCondition(condNode, ctx);
        const targetId = passed ? condNode.trueEdge : condNode.falseEdge;
        result = { next: targetId };
        break;
      }

      case "send_text":
        result = await handlers.sendTextAction(node, ctx, nextNodeId);
        break;

      case "send_media":
        result = await handlers.sendMediaAction(node, ctx, nextNodeId);
        break;

      case "ask_question":
        result = await handlers.askQuestionAction(node, ctx);
        break;

      case "delay":
        result = await handlers.delayAction(node, ctx, nextNodeId);
        break;

      case "add_tag":
        result = await handlers.addTagAction(node, ctx, nextNodeId);
        break;

      case "remove_tag":
        result = await handlers.removeTagAction(node, ctx, nextNodeId);
        break;

      case "update_contact_field":
        result = await handlers.updateContactFieldAction(node, ctx, nextNodeId);
        break;

      case "assign":
        result = await handlers.assignAction(node, ctx, nextNodeId);
        break;

      case "add_note":
        result = await handlers.addNoteAction(node, ctx, nextNodeId);
        break;

      case "call_webhook":
        result = await handlers.callWebhookAction(node, ctx, nextNodeId);
        break;

      case "trigger_flow":
        result = await handlers.triggerFlowAction(node, ctx, nextNodeId);
        break;

      case "stop_flow":
        result = await handlers.stopFlowAction(ctx);
        break;

      case "handoff":
        result = await handlers.handoffAction(node, ctx);
        break;

      case "resolve":
        result = await handlers.resolveAction(ctx, nextNodeId);
        break;

      case "ai_generate_response":
        result = await handlers.aiGenerateResponseAction(node as import("./flowTypes").AiGenerateResponseNode, ctx, nextNodeId);
        break;

      case "ai_classify_intent":
        result = await handlers.aiClassifyIntentAction(node as import("./flowTypes").AiClassifyIntentNode, ctx, nextNodeId);
        break;

      default:
        logger.warn({ executionId, nodeType: (node as FlowNode).type }, "automation: unknown node type");
        result = { next: nextNodeId };
    }
  } catch (err) {
    logger.error({ err, executionId, nodeId, nodeType: node.type }, "automation: node execution error");
    await logEvent(executionId, nodeId, node.type, "error", {}, {}, String(err));
    await finishExecution(executionId, "error");
    return;
  }

  const elapsed = Date.now() - eventStart;
  await logEvent(executionId, nodeId, node.type, result.waiting ? "waiting" : "completed", {}, { elapsed_ms: elapsed }, null);

  if (result.waiting || result.next === null) {
    if (!result.waiting) {
      await finishExecution(executionId, "finished");
    }
    return;
  }

  // Continue to next node
  await executeNode(executionId, result.next, ctx, graph, depth + 1);
}

// ---------------------------------------------------------------------------
// evaluateCondition — returns true/false for condition nodes
// ---------------------------------------------------------------------------

async function evaluateCondition(
  node: ConditionNode,
  ctx: ExecutionContext,
): Promise<boolean> {
  const cond = node.condition;

  switch (cond.type) {
    case "channel_is": {
      const result = await db.query<{ provider: string }>(
        `SELECT provider FROM omni_channel_accounts WHERE id = $1`,
        [ctx.channelAccountId],
      );
      const provider = result.rows[0]?.provider ?? "";
      if (cond.channelAccountId) return ctx.channelAccountId === cond.channelAccountId;
      return provider === (cond.channelProvider ?? "");
    }

    case "channel_is_not": {
      const result = await db.query<{ provider: string }>(
        `SELECT provider FROM omni_channel_accounts WHERE id = $1`,
        [ctx.channelAccountId],
      );
      const provider = result.rows[0]?.provider ?? "";
      if (cond.channelAccountId) return ctx.channelAccountId !== cond.channelAccountId;
      return provider !== (cond.channelProvider ?? "");
    }

    case "message_text_contains": {
      const text = ctx.variables._lastInboundContent ?? "";
      return text.toLowerCase().includes((cond.text ?? "").toLowerCase());
    }

    case "contact_tag_exists": {
      const result = await db.query<{ id: number }>(
        `SELECT ct.id FROM omni_contact_tags ct
         JOIN omni_tags t ON t.id = ct.tag_id
         WHERE ct.contact_id = $1 AND t.name = $2
         LIMIT 1`,
        [ctx.contactId, cond.tagName ?? ""],
      );
      return result.rows.length > 0;
    }

    case "contact_field_value": {
      const result = await db.query<{ metadata: Record<string, unknown> | null }>(
        `SELECT metadata FROM omni_contacts WHERE id = $1`,
        [ctx.contactId],
      );
      const meta = result.rows[0]?.metadata ?? {};
      const fieldValue = String(meta[cond.fieldKey ?? ""] ?? "");
      const expected = cond.fieldValue ?? "";
      const op = cond.operator ?? "eq";

      switch (op) {
        case "eq": return fieldValue === expected;
        case "ne": return fieldValue !== expected;
        case "contains": return fieldValue.includes(expected);
        case "starts_with": return fieldValue.startsWith(expected);
        case "is_set": return fieldValue !== "";
        case "is_empty": return fieldValue === "";
        default: return false;
      }
    }

    case "conversation_status": {
      const result = await db.query<{ status: string }>(
        `SELECT status FROM omni_conversations WHERE id = $1`,
        [ctx.conversationId],
      );
      return result.rows[0]?.status === cond.conversationStatus;
    }

    case "business_hours": {
      // Simple implementation: Monday-Friday 9am-6pm UTC
      const now = new Date();
      const day = now.getUTCDay(); // 0 = Sunday, 6 = Saturday
      const hour = now.getUTCHours();
      return day >= 1 && day <= 5 && hour >= 9 && hour < 18;
    }

    case "ab_split": {
      // Random A/B split based on splitPercent (0-100)
      const splitPercent = cond.splitPercent ?? 50;
      return Math.random() * 100 < splitPercent;
    }

    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// logEvent — persist a node execution event
// ---------------------------------------------------------------------------

async function logEvent(
  executionId: string,
  nodeId: string,
  nodeType: string,
  status: string,
  inputData: Record<string, unknown>,
  outputData: Record<string, unknown>,
  errorMessage: string | null,
): Promise<void> {
  try {
    await db.query(
      `INSERT INTO omni_automation_events
         (execution_id, node_id, node_type, status, input_data, output_data, error_message, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [
        executionId,
        nodeId,
        nodeType,
        status,
        JSON.stringify(inputData),
        JSON.stringify(outputData),
        errorMessage,
      ],
    );
  } catch (err) {
    logger.error({ err, executionId, nodeId }, "automation: failed to log event");
  }
}

// ---------------------------------------------------------------------------
// finishExecution
// ---------------------------------------------------------------------------

async function finishExecution(
  executionId: string,
  status: "finished" | "error",
): Promise<void> {
  try {
    await db.query(
      `UPDATE omni_automation_executions
       SET status = $1, finished_at = NOW()
       WHERE id = $2`,
      [status, executionId],
    );
    logger.info({ executionId, status }, "automation: execution finished");
  } catch (err) {
    logger.error({ err, executionId }, "automation: failed to finish execution");
  }
}

// ---------------------------------------------------------------------------
// runMockExecution — used by the test endpoint to simulate a flow
// ---------------------------------------------------------------------------

export async function runMockExecution(
  graph: FlowGraph,
  mockContact: Record<string, string>,
): Promise<Array<{ nodeId: string; nodeType: string; status: string; note?: string }>> {
  const events: Array<{ nodeId: string; nodeType: string; status: string; note?: string }> = [];
  const visited = new Set<string>();

  let currentNodeId: string | null = graph.entryNodeId;

  const mockCtx: ExecutionContext = {
    executionId: "mock",
    flowId: 0,
    conversationId: 0,
    contactId: 0,
    workspaceOwnerId: "mock",
    channelAccountId: 0,
    recipientExternalId: "mock",
    variables: { ...mockContact },
  };

  let depth = 0;
  while (currentNodeId && depth < 50) {
    if (visited.has(currentNodeId)) {
      events.push({ nodeId: currentNodeId, nodeType: "loop", status: "stopped", note: "Loop detected" });
      break;
    }
    visited.add(currentNodeId);
    depth++;

    const node = graph.nodes.find((n) => n.id === currentNodeId);
    if (!node) break;

    const outEdge = graph.edges.find((e) => e.source === currentNodeId);
    const nextNodeId = outEdge?.target ?? null;

    switch (node.type) {
      case "trigger":
        events.push({ nodeId: node.id, nodeType: node.type, status: "triggered" });
        currentNodeId = nextNodeId;
        break;

      case "condition": {
        const cNode = node as ConditionNode;
        // In mock mode, conditions always take the "true" branch
        events.push({ nodeId: node.id, nodeType: node.type, status: "evaluated", note: "Mock: condition assumed true" });
        currentNodeId = cNode.trueEdge ?? nextNodeId;
        break;
      }

      case "send_text":
        events.push({ nodeId: node.id, nodeType: node.type, status: "completed", note: `[Mock] Would send: "${node.text}"` });
        currentNodeId = nextNodeId;
        break;

      case "send_media":
        events.push({ nodeId: node.id, nodeType: node.type, status: "completed", note: `[Mock] Would send media: ${node.mediaUrl}` });
        currentNodeId = nextNodeId;
        break;

      case "ask_question":
        events.push({ nodeId: node.id, nodeType: node.type, status: "waiting", note: `[Mock] Would ask: "${node.question}" → saves to ${node.saveToField}` });
        currentNodeId = null;
        break;

      case "delay":
        events.push({ nodeId: node.id, nodeType: node.type, status: "waiting", note: `[Mock] Would wait ${node.minutes} minutes` });
        currentNodeId = null;
        break;

      case "add_tag":
        events.push({ nodeId: node.id, nodeType: node.type, status: "completed", note: `[Mock] Would add tag: "${node.tagName}"` });
        currentNodeId = nextNodeId;
        break;

      case "remove_tag":
        events.push({ nodeId: node.id, nodeType: node.type, status: "completed", note: `[Mock] Would remove tag: "${node.tagName}"` });
        currentNodeId = nextNodeId;
        break;

      case "update_contact_field":
        events.push({ nodeId: node.id, nodeType: node.type, status: "completed", note: `[Mock] Would set ${node.fieldKey} = "${node.fieldValue}"` });
        currentNodeId = nextNodeId;
        break;

      case "assign":
        events.push({ nodeId: node.id, nodeType: node.type, status: "completed", note: `[Mock] Would assign to agent: ${node.agentId ?? "none"}` });
        currentNodeId = nextNodeId;
        break;

      case "add_note":
        events.push({ nodeId: node.id, nodeType: node.type, status: "completed", note: `[Mock] Would add note: "${node.content}"` });
        currentNodeId = nextNodeId;
        break;

      case "call_webhook":
        events.push({ nodeId: node.id, nodeType: node.type, status: "completed", note: `[Mock] Would call webhook: ${node.url}` });
        currentNodeId = nextNodeId;
        break;

      case "trigger_flow":
        events.push({ nodeId: node.id, nodeType: node.type, status: "completed", note: `[Mock] Would trigger flow: ${node.targetFlowId}` });
        currentNodeId = nextNodeId;
        break;

      case "stop_flow":
        events.push({ nodeId: node.id, nodeType: node.type, status: "stopped" });
        currentNodeId = null;
        break;

      case "handoff":
        events.push({ nodeId: node.id, nodeType: node.type, status: "handed_off", note: `[Mock] Would hand off to human` });
        currentNodeId = null;
        break;

      case "resolve":
        events.push({ nodeId: node.id, nodeType: node.type, status: "resolved", note: `[Mock] Would resolve conversation` });
        currentNodeId = nextNodeId;
        break;

      default:
        events.push({ nodeId: (node as FlowNode).id, nodeType: (node as FlowNode).type, status: "skipped" });
        currentNodeId = nextNodeId;
    }
  }

  return events;
}
