// ---------------------------------------------------------------------------
// Omnichannel Phase 5 — Automation flow type system
// ---------------------------------------------------------------------------

// --- Trigger types -----------------------------------------------------------

export type TriggerType =
  | "first_inbound_message"
  | "keyword_match"
  | "tag_added"
  | "message_not_responded";

export interface TriggerDefinition {
  type: TriggerType;
  keywordMode?: "exact" | "contains" | "regex";
  keyword?: string;
  tagName?: string;
  minutesThreshold?: number;
}

// --- Condition types ---------------------------------------------------------

export type ConditionType =
  | "channel_is"
  | "channel_is_not"
  | "message_text_contains"
  | "contact_tag_exists"
  | "contact_field_value"
  | "conversation_status"
  | "business_hours"
  | "ab_split";

export interface ConditionDefinition {
  type: ConditionType;
  channelProvider?: string;
  channelAccountId?: number;
  text?: string;
  tagName?: string;
  fieldKey?: string;
  fieldValue?: string;
  operator?: "eq" | "ne" | "contains" | "starts_with" | "is_set" | "is_empty";
  conversationStatus?: string;
  splitPercent?: number;
}

// --- Action node types -------------------------------------------------------

export type ActionNodeType =
  | "send_text"
  | "send_media"
  | "ask_question"
  | "delay"
  | "add_tag"
  | "remove_tag"
  | "update_contact_field"
  | "assign"
  | "add_note"
  | "call_webhook"
  | "trigger_flow"
  | "stop_flow"
  | "handoff"
  | "resolve"
  | "ai_generate_response"
  | "ai_classify_intent";

// --- Flow node (discriminated union) -----------------------------------------

interface BaseNode {
  id: string;
  label?: string;
}

export interface TriggerNode extends BaseNode {
  type: "trigger";
  trigger: TriggerDefinition;
}

export interface ConditionNode extends BaseNode {
  type: "condition";
  condition: ConditionDefinition;
  trueEdge: string;
  falseEdge: string;
}

export interface SendTextNode extends BaseNode {
  type: "send_text";
  text: string;
}

export interface SendMediaNode extends BaseNode {
  type: "send_media";
  mediaUrl: string;
  mediaMimeType?: string;
  caption?: string;
}

export interface AskQuestionNode extends BaseNode {
  type: "ask_question";
  question: string;
  saveToField: string;
}

export interface DelayNode extends BaseNode {
  type: "delay";
  minutes: number;
}

export interface AddTagNode extends BaseNode {
  type: "add_tag";
  tagName: string;
}

export interface RemoveTagNode extends BaseNode {
  type: "remove_tag";
  tagName: string;
}

export interface UpdateContactFieldNode extends BaseNode {
  type: "update_contact_field";
  fieldKey: string;
  fieldValue: string;
}

export interface AssignNode extends BaseNode {
  type: "assign";
  agentId?: string | null;
  teamId?: number | null;
}

export interface AddNoteNode extends BaseNode {
  type: "add_note";
  content: string;
}

export interface CallWebhookNode extends BaseNode {
  type: "call_webhook";
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  bodyTemplate?: string;
}

export interface TriggerFlowNode extends BaseNode {
  type: "trigger_flow";
  targetFlowId: number;
}

export interface StopFlowNode extends BaseNode {
  type: "stop_flow";
}

export interface HandoffNode extends BaseNode {
  type: "handoff";
  note?: string;
}

export interface ResolveNode extends BaseNode {
  type: "resolve";
}

export interface AiGenerateResponseNode extends BaseNode {
  type: "ai_generate_response";
  contextNote?: string;
}

export interface AiClassifyIntentNode extends BaseNode {
  type: "ai_classify_intent";
  storeResultInField?: string;
}

export type FlowNode =
  | TriggerNode
  | ConditionNode
  | SendTextNode
  | SendMediaNode
  | AskQuestionNode
  | DelayNode
  | AddTagNode
  | RemoveTagNode
  | UpdateContactFieldNode
  | AssignNode
  | AddNoteNode
  | CallWebhookNode
  | TriggerFlowNode
  | StopFlowNode
  | HandoffNode
  | ResolveNode
  | AiGenerateResponseNode
  | AiClassifyIntentNode;

// --- Flow edge ---------------------------------------------------------------

export interface FlowEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}

// --- Flow graph --------------------------------------------------------------

export interface FlowGraph {
  nodes: FlowNode[];
  edges: FlowEdge[];
  entryNodeId: string;
}

// --- Validation result -------------------------------------------------------

export interface FlowValidationResult {
  valid: boolean;
  errors: string[];
}

// ---------------------------------------------------------------------------
// validateFlowGraph — checks structural correctness
// ---------------------------------------------------------------------------

export function validateFlowGraph(graph: unknown): FlowValidationResult {
  const errors: string[] = [];

  if (!graph || typeof graph !== "object") {
    return { valid: false, errors: ["Flow graph must be an object"] };
  }

  const g = graph as Record<string, unknown>;

  if (!Array.isArray(g.nodes) || g.nodes.length === 0) {
    errors.push("Flow graph must have at least one node");
  }

  if (!Array.isArray(g.edges)) {
    errors.push("Flow graph must have an edges array");
  }

  if (typeof g.entryNodeId !== "string" || !g.entryNodeId) {
    errors.push("Flow graph must specify entryNodeId");
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const nodes = g.nodes as FlowNode[];
  const edges = g.edges as FlowEdge[];
  const entryNodeId = g.entryNodeId as string;

  const nodeIds = new Set(nodes.map((n) => n.id));
  const edgeTargets = new Set(edges.map((e) => e.target));
  const edgeSources = new Set(edges.map((e) => e.source));

  // Entry node must exist
  if (!nodeIds.has(entryNodeId)) {
    errors.push(`Entry node "${entryNodeId}" not found in nodes`);
  }

  // All edge source/target node IDs must exist
  for (const edge of edges) {
    if (!nodeIds.has(edge.source)) {
      errors.push(`Edge "${edge.id}" source "${edge.source}" not found in nodes`);
    }
    if (!nodeIds.has(edge.target)) {
      errors.push(`Edge "${edge.id}" target "${edge.target}" not found in nodes`);
    }
  }

  // Check for unreachable nodes (simple reachability from entry)
  const reachable = new Set<string>();
  const queue = [entryNodeId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (reachable.has(cur)) continue;
    reachable.add(cur);
    for (const edge of edges) {
      if (edge.source === cur && !reachable.has(edge.target)) {
        queue.push(edge.target);
      }
    }
    // For condition nodes, both true/false edges are used
    const node = nodes.find((n) => n.id === cur);
    if (node?.type === "condition") {
      const cNode = node as ConditionNode;
      if (cNode.trueEdge && !reachable.has(cNode.trueEdge)) queue.push(cNode.trueEdge);
      if (cNode.falseEdge && !reachable.has(cNode.falseEdge)) queue.push(cNode.falseEdge);
    }
  }

  for (const nodeId of nodeIds) {
    if (!reachable.has(nodeId)) {
      errors.push(`Node "${nodeId}" is unreachable from entry node`);
    }
  }

  // Validate required fields on specific node types
  for (const node of nodes) {
    if (node.type === "send_text") {
      if (!node.text) errors.push(`Node "${node.id}" (send_text) is missing text`);
    }
    if (node.type === "ask_question") {
      if (!node.question) errors.push(`Node "${node.id}" (ask_question) is missing question`);
      if (!node.saveToField) errors.push(`Node "${node.id}" (ask_question) is missing saveToField`);
    }
    if (node.type === "delay") {
      if (typeof node.minutes !== "number" || node.minutes < 0) {
        errors.push(`Node "${node.id}" (delay) must have a non-negative minutes value`);
      }
    }
    if (node.type === "call_webhook") {
      if (!node.url) errors.push(`Node "${node.id}" (call_webhook) is missing url`);
    }
    if (node.type === "trigger_flow") {
      if (!node.targetFlowId) errors.push(`Node "${node.id}" (trigger_flow) is missing targetFlowId`);
    }
  }

  // Warn (but don't error) if there are terminal nodes that have outgoing edges
  const terminalTypes = new Set(["stop_flow", "handoff", "resolve"]);
  for (const edge of edges) {
    const src = nodes.find((n) => n.id === edge.source);
    if (src && terminalTypes.has(src.type)) {
      errors.push(`Node "${src.id}" (${src.type}) is a terminal node but has outgoing edges`);
    }
  }

  void edgeTargets;
  void edgeSources;

  return { valid: errors.length === 0, errors };
}
