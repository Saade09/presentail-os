import { useState, useCallback } from "react";
import { useParams, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  ArrowLeft,
  Plus,
  Play,
  Pause,
  FlaskConical,
  ChevronRight,
  Trash2,
  Settings,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type NodeType =
  | "trigger"
  | "condition"
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
  | "resolve";

interface FlowNode {
  id: string;
  type: NodeType;
  label?: string;
  [key: string]: unknown;
}

interface FlowEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
}

interface FlowGraph {
  entryNodeId: string;
  nodes: FlowNode[];
  edges: FlowEdge[];
}

interface AutomationFlow {
  id: number;
  name: string;
  description: string | null;
  trigger_type: string;
  trigger_conditions: Record<string, unknown> | null;
  flow_graph: FlowGraph;
  state: string;
  execution_count: number;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NODE_TYPE_LABELS: Record<string, string> = {
  trigger: "Trigger",
  condition: "Condition / Branch",
  send_text: "Send message",
  send_media: "Send image/media",
  ask_question: "Ask a question",
  delay: "Wait / Delay",
  add_tag: "Add tag",
  remove_tag: "Remove tag",
  update_contact_field: "Update contact field",
  assign: "Assign to agent/team",
  add_note: "Add internal note",
  call_webhook: "Call external webhook",
  trigger_flow: "Trigger another flow",
  stop_flow: "Stop flow",
  handoff: "Hand off to human",
  resolve: "Mark as resolved",
};

const NODE_TYPE_COLORS: Record<string, string> = {
  trigger: "bg-blue-50 border-blue-200 text-blue-800",
  condition: "bg-amber-50 border-amber-200 text-amber-800",
  send_text: "bg-green-50 border-green-200 text-green-800",
  send_media: "bg-green-50 border-green-200 text-green-800",
  ask_question: "bg-purple-50 border-purple-200 text-purple-800",
  delay: "bg-slate-50 border-slate-200 text-slate-700",
  add_tag: "bg-orange-50 border-orange-200 text-orange-800",
  remove_tag: "bg-orange-50 border-orange-200 text-orange-800",
  update_contact_field: "bg-cyan-50 border-cyan-200 text-cyan-800",
  assign: "bg-indigo-50 border-indigo-200 text-indigo-800",
  add_note: "bg-yellow-50 border-yellow-200 text-yellow-800",
  call_webhook: "bg-rose-50 border-rose-200 text-rose-800",
  trigger_flow: "bg-violet-50 border-violet-200 text-violet-800",
  stop_flow: "bg-red-50 border-red-200 text-red-800",
  handoff: "bg-pink-50 border-pink-200 text-pink-800",
  resolve: "bg-teal-50 border-teal-200 text-teal-800",
};

const ACTION_NODE_TYPES: NodeType[] = [
  "send_text", "send_media", "ask_question", "delay",
  "add_tag", "remove_tag", "update_contact_field", "assign",
  "add_note", "call_webhook", "trigger_flow", "stop_flow",
  "handoff", "resolve",
];

const TERMINAL_TYPES = new Set(["stop_flow", "handoff", "resolve"]);

// ---------------------------------------------------------------------------
// Node default factory
// ---------------------------------------------------------------------------

function makeDefaultNode(type: NodeType, id: string): FlowNode {
  const base: FlowNode = { id, type, label: NODE_TYPE_LABELS[type] };
  switch (type) {
    case "send_text": return { ...base, text: "" };
    case "send_media": return { ...base, mediaUrl: "", caption: "" };
    case "ask_question": return { ...base, question: "", saveToField: "" };
    case "delay": return { ...base, minutes: 5 };
    case "add_tag": return { ...base, tagName: "" };
    case "remove_tag": return { ...base, tagName: "" };
    case "update_contact_field": return { ...base, fieldKey: "", fieldValue: "" };
    case "assign": return { ...base, agentId: null, teamId: null };
    case "add_note": return { ...base, content: "" };
    case "call_webhook": return { ...base, url: "", method: "POST" };
    case "trigger_flow": return { ...base, targetFlowId: null };
    case "condition": return { ...base, condition: { type: "message_text_contains", text: "" }, trueEdge: "", falseEdge: "" };
    default: return base;
  }
}

// ---------------------------------------------------------------------------
// Node property panel
// ---------------------------------------------------------------------------

function NodePropertyPanel({
  node,
  onUpdate,
  onDelete,
}: {
  node: FlowNode;
  onUpdate: (updated: FlowNode) => void;
  onDelete: () => void;
}) {
  const set = (key: string, value: unknown) => onUpdate({ ...node, [key]: value });

  return (
    <div className="w-80 border-l bg-background flex flex-col h-full overflow-y-auto">
      <div className="p-4 border-b flex items-center justify-between">
        <h3 className="font-semibold text-sm">{NODE_TYPE_LABELS[node.type] ?? node.type}</h3>
        <Button variant="ghost" size="icon" className="size-7 text-destructive" onClick={onDelete}>
          <Trash2 className="size-4" />
        </Button>
      </div>
      <div className="p-4 space-y-4 flex-1">
        <div className="space-y-1.5">
          <Label className="text-xs">Node label</Label>
          <Input
            value={String(node.label ?? "")}
            onChange={(e) => set("label", e.target.value)}
            placeholder={NODE_TYPE_LABELS[node.type]}
            className="h-8 text-sm"
          />
        </div>

        {node.type === "trigger" && (
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">
              Trigger is configured on the flow level.
            </Label>
          </div>
        )}

        {node.type === "send_text" && (
          <div className="space-y-1.5">
            <Label className="text-xs">Message text</Label>
            <Textarea
              value={String(node.text ?? "")}
              onChange={(e) => set("text", e.target.value)}
              placeholder="Type your message… Use {{variable}} for personalization."
              className="text-sm resize-none"
              rows={4}
            />
            <p className="text-xs text-muted-foreground">Use {"{{variable}}"} to insert contact fields.</p>
          </div>
        )}

        {node.type === "send_media" && (
          <>
            <div className="space-y-1.5">
              <Label className="text-xs">Media URL</Label>
              <Input
                value={String(node.mediaUrl ?? "")}
                onChange={(e) => set("mediaUrl", e.target.value)}
                placeholder="https://…"
                className="h-8 text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Caption (optional)</Label>
              <Input
                value={String(node.caption ?? "")}
                onChange={(e) => set("caption", e.target.value)}
                className="h-8 text-sm"
              />
            </div>
          </>
        )}

        {node.type === "ask_question" && (
          <>
            <div className="space-y-1.5">
              <Label className="text-xs">Question</Label>
              <Textarea
                value={String(node.question ?? "")}
                onChange={(e) => set("question", e.target.value)}
                placeholder="What is your name?"
                className="text-sm resize-none"
                rows={3}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Save answer to field</Label>
              <Input
                value={String(node.saveToField ?? "")}
                onChange={(e) => set("saveToField", e.target.value)}
                placeholder="e.g. customerName"
                className="h-8 text-sm"
              />
            </div>
          </>
        )}

        {node.type === "delay" && (
          <div className="space-y-1.5">
            <Label className="text-xs">Wait (minutes)</Label>
            <Input
              type="number"
              min={0}
              value={String(node.minutes ?? 5)}
              onChange={(e) => set("minutes", parseInt(e.target.value, 10) || 0)}
              className="h-8 text-sm"
            />
          </div>
        )}

        {(node.type === "add_tag" || node.type === "remove_tag") && (
          <div className="space-y-1.5">
            <Label className="text-xs">Tag name</Label>
            <Input
              value={String(node.tagName ?? "")}
              onChange={(e) => set("tagName", e.target.value)}
              placeholder="e.g. Lead"
              className="h-8 text-sm"
            />
          </div>
        )}

        {node.type === "update_contact_field" && (
          <>
            <div className="space-y-1.5">
              <Label className="text-xs">Field key</Label>
              <Input
                value={String(node.fieldKey ?? "")}
                onChange={(e) => set("fieldKey", e.target.value)}
                placeholder="e.g. interest"
                className="h-8 text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Field value</Label>
              <Input
                value={String(node.fieldValue ?? "")}
                onChange={(e) => set("fieldValue", e.target.value)}
                placeholder="e.g. pricing"
                className="h-8 text-sm"
              />
            </div>
          </>
        )}

        {node.type === "assign" && (
          <>
            <div className="space-y-1.5">
              <Label className="text-xs">Agent ID (optional)</Label>
              <Input
                value={String(node.agentId ?? "")}
                onChange={(e) => set("agentId", e.target.value || null)}
                placeholder="Leave blank to unassign"
                className="h-8 text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Team ID (optional)</Label>
              <Input
                type="number"
                value={String(node.teamId ?? "")}
                onChange={(e) => set("teamId", e.target.value ? parseInt(e.target.value, 10) : null)}
                placeholder="Leave blank to unassign"
                className="h-8 text-sm"
              />
            </div>
          </>
        )}

        {node.type === "add_note" && (
          <div className="space-y-1.5">
            <Label className="text-xs">Note content</Label>
            <Textarea
              value={String(node.content ?? "")}
              onChange={(e) => set("content", e.target.value)}
              placeholder="Internal note text…"
              className="text-sm resize-none"
              rows={3}
            />
          </div>
        )}

        {node.type === "call_webhook" && (
          <>
            <div className="space-y-1.5">
              <Label className="text-xs">URL</Label>
              <Input
                value={String(node.url ?? "")}
                onChange={(e) => set("url", e.target.value)}
                placeholder="https://…"
                className="h-8 text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Method</Label>
              <Select value={String(node.method ?? "POST")} onValueChange={(v) => set("method", v)}>
                <SelectTrigger className="h-8 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="POST">POST</SelectItem>
                  <SelectItem value="GET">GET</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </>
        )}

        {node.type === "trigger_flow" && (
          <div className="space-y-1.5">
            <Label className="text-xs">Target flow ID</Label>
            <Input
              type="number"
              value={String(node.targetFlowId ?? "")}
              onChange={(e) => set("targetFlowId", e.target.value ? parseInt(e.target.value, 10) : null)}
              placeholder="Flow ID"
              className="h-8 text-sm"
            />
          </div>
        )}

        {node.type === "handoff" && (
          <div className="space-y-1.5">
            <Label className="text-xs">Handoff note (optional)</Label>
            <Textarea
              value={String(node.note ?? "")}
              onChange={(e) => set("note", e.target.value)}
              placeholder="Reason for handoff…"
              className="text-sm resize-none"
              rows={3}
            />
          </div>
        )}

        {node.type === "condition" && (
          <ConditionNodeEditor node={node} onUpdate={onUpdate} />
        )}
      </div>
    </div>
  );
}

function ConditionNodeEditor({ node, onUpdate }: { node: FlowNode; onUpdate: (n: FlowNode) => void }) {
  const cond = (node.condition as Record<string, unknown>) ?? {};
  const setField = (key: string, value: unknown) => {
    onUpdate({ ...node, condition: { ...cond, [key]: value } });
  };

  const condType = String(cond.type ?? "message_text_contains");

  return (
    <>
      <div className="space-y-1.5">
        <Label className="text-xs">Condition type</Label>
        <Select value={condType} onValueChange={(v) => setField("type", v)}>
          <SelectTrigger className="h-8 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="message_text_contains">Message text contains</SelectItem>
            <SelectItem value="contact_tag_exists">Contact has tag</SelectItem>
            <SelectItem value="contact_field_value">Contact field value</SelectItem>
            <SelectItem value="conversation_status">Conversation status</SelectItem>
            <SelectItem value="business_hours">Business hours check</SelectItem>
            <SelectItem value="channel_is">Channel is</SelectItem>
            <SelectItem value="ab_split">A/B split</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {condType === "message_text_contains" && (
        <div className="space-y-1.5">
          <Label className="text-xs">Text to match</Label>
          <Input
            value={String(cond.text ?? "")}
            onChange={(e) => setField("text", e.target.value)}
            placeholder="e.g. price"
            className="h-8 text-sm"
          />
        </div>
      )}

      {condType === "contact_tag_exists" && (
        <div className="space-y-1.5">
          <Label className="text-xs">Tag name</Label>
          <Input
            value={String(cond.tagName ?? "")}
            onChange={(e) => setField("tagName", e.target.value)}
            placeholder="e.g. Lead"
            className="h-8 text-sm"
          />
        </div>
      )}

      {condType === "ab_split" && (
        <div className="space-y-1.5">
          <Label className="text-xs">Route A percentage (0–100)</Label>
          <Input
            type="number"
            min={0}
            max={100}
            value={String(cond.splitPercent ?? 50)}
            onChange={(e) => setField("splitPercent", parseInt(e.target.value, 10))}
            className="h-8 text-sm"
          />
          <p className="text-xs text-muted-foreground">Contacts in Route A take the "true" branch.</p>
        </div>
      )}

      <div className="rounded-md bg-amber-50 border border-amber-200 p-3 text-xs text-amber-800 space-y-1">
        <p className="font-medium">Branch routing</p>
        <p>Connect the "true" (Yes) output and the "false" (No) output below to other nodes using the True/False edge IDs.</p>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">True branch → node ID</Label>
        <Input
          value={String(node.trueEdge ?? "")}
          onChange={(e) => onUpdate({ ...node, trueEdge: e.target.value })}
          placeholder="e.g. node-3"
          className="h-8 text-sm"
        />
      </div>
      <div className="space-y-1.5">
        <Label className="text-xs">False branch → node ID</Label>
        <Input
          value={String(node.falseEdge ?? "")}
          onChange={(e) => onUpdate({ ...node, falseEdge: e.target.value })}
          placeholder="e.g. node-4"
          className="h-8 text-sm"
        />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Test dialog
// ---------------------------------------------------------------------------

interface TestEvent {
  nodeId: string;
  nodeType: string;
  status: string;
  note?: string;
}

function TestDialog({
  open,
  onClose,
  events,
  validationErrors,
}: {
  open: boolean;
  onClose: () => void;
  events: TestEvent[];
  validationErrors: string[];
}) {
  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-lg max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Test execution log</DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-y-auto space-y-2 py-2">
          {validationErrors.length > 0 && (
            <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 space-y-1">
              <p className="text-sm font-medium text-destructive">Validation errors:</p>
              {validationErrors.map((e, i) => (
                <p key={i} className="text-xs text-destructive">{e}</p>
              ))}
            </div>
          )}
          {events.map((ev, i) => (
            <div
              key={i}
              className="flex items-start gap-3 rounded-md border p-2.5 text-sm"
            >
              {ev.status === "error" ? (
                <AlertCircle className="size-4 text-destructive mt-0.5 shrink-0" />
              ) : ev.status === "waiting" ? (
                <div className="size-4 rounded-full border-2 border-amber-400 mt-0.5 shrink-0" />
              ) : (
                <CheckCircle2 className="size-4 text-green-500 mt-0.5 shrink-0" />
              )}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{NODE_TYPE_LABELS[ev.nodeType] ?? ev.nodeType}</span>
                  <Badge variant="outline" className="text-xs py-0">{ev.status}</Badge>
                </div>
                {ev.note && <p className="text-xs text-muted-foreground mt-0.5">{ev.note}</p>}
                <p className="text-xs text-muted-foreground">Node: {ev.nodeId}</p>
              </div>
            </div>
          ))}
          {events.length === 0 && validationErrors.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">No events.</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Add node panel
// ---------------------------------------------------------------------------

function AddNodePanel({ onAdd }: { onAdd: (type: NodeType) => void }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(!open)}
        className="w-full"
      >
        <Plus className="size-4 mr-2" />
        Add step
      </Button>
      {open && (
        <div className="absolute top-full left-0 mt-1 w-64 rounded-lg border bg-popover shadow-lg z-10 overflow-hidden">
          <div className="px-3 py-2 text-xs font-medium text-muted-foreground border-b">Choose step type</div>
          <div className="max-h-72 overflow-y-auto py-1">
            <div className="px-3 py-1 text-xs font-medium text-muted-foreground">Logic</div>
            <button
              className="w-full text-left px-3 py-2 text-sm hover:bg-muted transition-colors"
              onClick={() => { onAdd("condition"); setOpen(false); }}
            >
              {NODE_TYPE_LABELS["condition"]}
            </button>
            <div className="px-3 py-1 text-xs font-medium text-muted-foreground mt-1">Messaging</div>
            {(["send_text", "send_media", "ask_question"] as NodeType[]).map((t) => (
              <button
                key={t}
                className="w-full text-left px-3 py-2 text-sm hover:bg-muted transition-colors"
                onClick={() => { onAdd(t); setOpen(false); }}
              >
                {NODE_TYPE_LABELS[t]}
              </button>
            ))}
            <div className="px-3 py-1 text-xs font-medium text-muted-foreground mt-1">Actions</div>
            {ACTION_NODE_TYPES.filter(t => !["send_text", "send_media", "ask_question"].includes(t)).map((t) => (
              <button
                key={t}
                className="w-full text-left px-3 py-2 text-sm hover:bg-muted transition-colors"
                onClick={() => { onAdd(t); setOpen(false); }}
              >
                {NODE_TYPE_LABELS[t]}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main flow builder
// ---------------------------------------------------------------------------

export default function FlowBuilderPage() {
  const { flowId } = useParams<{ flowId: string }>();
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [showTestDialog, setShowTestDialog] = useState(false);
  const [testEvents, setTestEvents] = useState<TestEvent[]>([]);
  const [testValidationErrors, setTestValidationErrors] = useState<string[]>([]);
  const [localGraph, setLocalGraph] = useState<FlowGraph | null>(null);
  const [localName, setLocalName] = useState<string>("");

  const { data, isLoading, error } = useQuery({
    queryKey: ["omnichannel-flow", flowId],
    queryFn: () =>
      apiFetch(`/api/omnichannel/flows/${flowId}`) as Promise<{
        flow: AutomationFlow;
        recent_executions: unknown[];
      }>,
    enabled: !!flowId,
  });

  const flow = data?.flow;

  // Initialize local state from fetched data
  const effectiveGraph = localGraph ?? flow?.flow_graph ?? { entryNodeId: "", nodes: [], edges: [] };
  const effectiveName = localName || flow?.name || "";

  const saveMutation = useMutation({
    mutationFn: (updates: { name?: string; flow_graph?: FlowGraph }) =>
      apiFetch(`/api/omnichannel/flows/${flowId}`, {
        method: "PATCH",
        body: JSON.stringify(updates),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["omnichannel-flow", flowId] });
      queryClient.invalidateQueries({ queryKey: ["omnichannel-flows"] });
      setIsDirty(false);
      toast({ title: "Saved" });
    },
    onError: () => toast({ title: "Save failed", variant: "destructive" }),
  });

  const publishMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/omnichannel/flows/${flowId}/publish`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["omnichannel-flow", flowId] });
      queryClient.invalidateQueries({ queryKey: ["omnichannel-flows"] });
      toast({ title: "Flow published and active" });
    },
    onError: async (err: Error) => {
      const msg = err.message;
      toast({ title: "Publish failed", description: msg, variant: "destructive" });
    },
  });

  const pauseMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/omnichannel/flows/${flowId}/pause`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["omnichannel-flow", flowId] });
      queryClient.invalidateQueries({ queryKey: ["omnichannel-flows"] });
      toast({ title: "Flow paused" });
    },
    onError: () => toast({ title: "Pause failed", variant: "destructive" }),
  });

  const testMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/omnichannel/flows/${flowId}/test`, { method: "POST" }) as Promise<{
        events: TestEvent[];
        validation: { valid: boolean; errors: string[] };
      }>,
    onSuccess: (result) => {
      setTestEvents(result.events ?? []);
      setTestValidationErrors(result.validation?.errors ?? []);
      setShowTestDialog(true);
    },
    onError: () => toast({ title: "Test failed", variant: "destructive" }),
  });

  const updateGraph = useCallback((g: FlowGraph) => {
    setLocalGraph(g);
    setIsDirty(true);
  }, []);

  const addNode = useCallback(
    (type: NodeType) => {
      const id = `node-${Date.now()}`;
      const node = makeDefaultNode(type, id);
      const g = effectiveGraph;
      const newNodes = [...g.nodes, node];

      // Auto-link: connect the last non-terminal node to the new one
      const newEdges = [...g.edges];
      const lastNode = newNodes[newNodes.length - 2];
      if (lastNode && !TERMINAL_TYPES.has(lastNode.type) && lastNode.type !== "condition") {
        const edgeExists = newEdges.some(
          (e) => e.source === lastNode.id,
        );
        if (!edgeExists) {
          newEdges.push({ id: `edge-${Date.now()}`, source: lastNode.id, target: id });
        }
      }

      updateGraph({ ...g, nodes: newNodes, edges: newEdges });
      setSelectedNodeId(id);
    },
    [effectiveGraph, updateGraph],
  );

  const updateNode = useCallback(
    (updated: FlowNode) => {
      const g = effectiveGraph;
      updateGraph({
        ...g,
        nodes: g.nodes.map((n) => (n.id === updated.id ? updated : n)),
      });
    },
    [effectiveGraph, updateGraph],
  );

  const deleteNode = useCallback(
    (nodeId: string) => {
      const g = effectiveGraph;
      updateGraph({
        ...g,
        nodes: g.nodes.filter((n) => n.id !== nodeId),
        edges: g.edges.filter((e) => e.source !== nodeId && e.target !== nodeId),
      });
      setSelectedNodeId(null);
    },
    [effectiveGraph, updateGraph],
  );

  const handleSave = () => {
    if (!isDirty) return;
    saveMutation.mutate({ name: effectiveName, flow_graph: effectiveGraph });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Spinner className="size-8 text-primary" />
      </div>
    );
  }

  if (error || !flow) {
    return (
      <div className="text-center py-20 text-muted-foreground text-sm">
        Flow not found.
      </div>
    );
  }

  const selectedNode = effectiveGraph.nodes.find((n) => n.id === selectedNodeId) ?? null;
  const stateColor =
    flow.state === "active"
      ? "bg-green-100 text-green-700"
      : flow.state === "paused"
      ? "bg-amber-100 text-amber-700"
      : flow.state === "archived"
      ? "bg-red-100 text-red-700"
      : "bg-muted text-muted-foreground";

  return (
    <div className="flex flex-col h-[calc(100dvh-4rem)] -mx-6 -mt-6 overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-3 px-4 py-3 border-b bg-background z-10">
        <Button variant="ghost" size="icon" className="size-8" onClick={() => setLocation("/omnichannel/automations")}>
          <ArrowLeft className="size-4" />
        </Button>

        <input
          className="font-semibold text-base bg-transparent border-none outline-none flex-1 min-w-0"
          value={effectiveName}
          onChange={(e) => {
            setLocalName(e.target.value);
            setIsDirty(true);
          }}
          placeholder="Flow name"
        />

        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${stateColor}`}>
          {flow.state}
        </span>

        <div className="flex items-center gap-2 ml-auto">
          <Button
            variant="outline"
            size="sm"
            onClick={() => testMutation.mutate()}
            disabled={testMutation.isPending}
          >
            <FlaskConical className="size-4 mr-1.5" />
            {testMutation.isPending ? "Testing…" : "Test"}
          </Button>

          {isDirty && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleSave}
              disabled={saveMutation.isPending}
            >
              {saveMutation.isPending ? "Saving…" : "Save draft"}
            </Button>
          )}

          {flow.state === "active" ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => pauseMutation.mutate()}
              disabled={pauseMutation.isPending}
            >
              <Pause className="size-4 mr-1.5" />
              Pause
            </Button>
          ) : (
            <Button
              size="sm"
              onClick={() => {
                if (isDirty) {
                  saveMutation.mutate({ name: effectiveName, flow_graph: effectiveGraph });
                }
                publishMutation.mutate();
              }}
              disabled={publishMutation.isPending || saveMutation.isPending}
            >
              <Play className="size-4 mr-1.5" />
              {publishMutation.isPending ? "Publishing…" : "Publish"}
            </Button>
          )}
        </div>
      </div>

      {/* Canvas + Property panel */}
      <div className="flex flex-1 overflow-hidden">
        {/* Node list canvas */}
        <div className="flex-1 overflow-y-auto p-6 bg-muted/20">
          <div className="max-w-xl mx-auto space-y-2">
            {effectiveGraph.nodes.length === 0 ? (
              <div className="text-center py-16 text-muted-foreground text-sm">
                <Settings className="size-10 mx-auto mb-3 opacity-30" />
                <p>No steps yet — add your first step below.</p>
              </div>
            ) : (
              effectiveGraph.nodes.map((node, idx) => {
                const colorClass = NODE_TYPE_COLORS[node.type] ?? "bg-muted border-border text-foreground";
                const isSelected = selectedNodeId === node.id;
                const isEntry = node.id === effectiveGraph.entryNodeId;
                const outEdge = effectiveGraph.edges.find((e) => e.source === node.id);
                const isTerminal = TERMINAL_TYPES.has(node.type);

                return (
                  <div key={node.id}>
                    <button
                      className={`w-full text-left rounded-lg border-2 px-4 py-3 transition-all ${colorClass} ${
                        isSelected ? "ring-2 ring-primary ring-offset-1" : "hover:opacity-80"
                      }`}
                      onClick={() => setSelectedNodeId(isSelected ? null : node.id)}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="text-xs font-mono opacity-60">{idx + 1}</span>
                          <span className="font-medium text-sm">
                            {String(node.label || NODE_TYPE_LABELS[node.type] || node.type)}
                          </span>
                          {isEntry && (
                            <span className="text-xs bg-white/60 border rounded px-1.5 py-0.5">Entry</span>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="text-xs opacity-60">{node.id}</span>
                          <ChevronRight className="size-4 opacity-40" />
                        </div>
                      </div>
                      {node.type === "send_text" && node.text != null && (
                        <p className="text-xs mt-1 opacity-70 truncate">"{String(node.text)}"</p>
                      )}
                      {node.type === "ask_question" && node.question != null && (
                        <p className="text-xs mt-1 opacity-70 truncate">"{String(node.question)}"</p>
                      )}
                      {(node.type === "add_tag" || node.type === "remove_tag") && node.tagName != null && (
                        <p className="text-xs mt-1 opacity-70">Tag: {String(node.tagName)}</p>
                      )}
                      {node.type === "delay" && (
                        <p className="text-xs mt-1 opacity-70">Wait {String(node.minutes)} minutes</p>
                      )}
                      {node.type === "condition" && (
                        <p className="text-xs mt-1 opacity-70">
                          → true: {String((node as FlowNode).trueEdge || "—")} / false: {String((node as FlowNode).falseEdge || "—")}
                        </p>
                      )}
                    </button>

                    {/* Edge connector */}
                    {!isTerminal && outEdge && idx < effectiveGraph.nodes.length - 1 && (
                      <div className="flex flex-col items-center py-1">
                        <div className="w-px h-5 bg-border" />
                        <div className="w-2 h-2 rounded-full bg-border" />
                      </div>
                    )}
                    {!isTerminal && !outEdge && idx < effectiveGraph.nodes.length - 1 && (
                      <div className="flex flex-col items-center py-1">
                        <div className="w-px h-5 bg-border border-dashed border-l border-amber-400" />
                        <div className="w-2 h-2 rounded-full bg-amber-300" />
                      </div>
                    )}
                  </div>
                );
              })
            )}

            <div className="pt-2">
              <AddNodePanel onAdd={addNode} />
            </div>
          </div>
        </div>

        {/* Node property panel */}
        {selectedNode && (
          <NodePropertyPanel
            node={selectedNode}
            onUpdate={updateNode}
            onDelete={() => deleteNode(selectedNode.id)}
          />
        )}
      </div>

      {/* Test dialog */}
      <TestDialog
        open={showTestDialog}
        onClose={() => setShowTestDialog(false)}
        events={testEvents}
        validationErrors={testValidationErrors}
      />
    </div>
  );
}
