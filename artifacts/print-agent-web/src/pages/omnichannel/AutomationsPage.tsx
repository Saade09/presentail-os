import { useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/hooks/use-toast";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Plus,
  MoreVertical,
  Play,
  Pause,
  Copy,
  Archive,
  Zap,
  Clock,
  Tag,
  MessageSquare,
} from "lucide-react";

interface AutomationFlow {
  id: number;
  name: string;
  description: string | null;
  trigger_type: string;
  state: string;
  execution_count: number;
  created_at: string;
  updated_at: string;
}

const TRIGGER_LABELS: Record<string, string> = {
  first_inbound_message: "First inbound message",
  keyword_match: "Keyword match",
  tag_added: "Tag added",
  message_not_responded: "Message not responded",
};

const TRIGGER_ICONS: Record<string, React.ElementType> = {
  first_inbound_message: MessageSquare,
  keyword_match: Zap,
  tag_added: Tag,
  message_not_responded: Clock,
};

const STATE_BADGE: Record<string, { label: string; variant: "default" | "secondary" | "outline" | "destructive" }> = {
  active: { label: "Active", variant: "default" },
  draft: { label: "Draft", variant: "secondary" },
  paused: { label: "Paused", variant: "outline" },
  archived: { label: "Archived", variant: "destructive" },
};

export default function AutomationsPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [newFlowName, setNewFlowName] = useState("");
  const [newFlowTrigger, setNewFlowTrigger] = useState("keyword_match");
  const [filterState, setFilterState] = useState<string>("all");

  const { data, isLoading, error } = useQuery({
    queryKey: ["omnichannel-flows", filterState],
    queryFn: () =>
      apiFetch(
        filterState === "all"
          ? "/api/omnichannel/flows"
          : `/api/omnichannel/flows?state=${filterState}`,
      ) as Promise<{ flows: AutomationFlow[] }>,
  });

  const createMutation = useMutation({
    mutationFn: (body: { name: string; trigger_type: string; flow_graph: unknown }) =>
      apiFetch("/api/omnichannel/flows", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: (result: { flow: AutomationFlow }) => {
      queryClient.invalidateQueries({ queryKey: ["omnichannel-flows"] });
      setShowCreateDialog(false);
      setNewFlowName("");
      toast({ title: "Flow created", description: `"${result.flow.name}" is ready to edit.` });
    },
    onError: () => toast({ title: "Error", description: "Failed to create flow.", variant: "destructive" }),
  });

  const publishMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/api/omnichannel/flows/${id}/publish`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["omnichannel-flows"] });
      toast({ title: "Flow published" });
    },
    onError: (err: Error) =>
      toast({ title: "Publish failed", description: err.message, variant: "destructive" }),
  });

  const pauseMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/api/omnichannel/flows/${id}/pause`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["omnichannel-flows"] });
      toast({ title: "Flow paused" });
    },
    onError: () => toast({ title: "Error", description: "Failed to pause flow.", variant: "destructive" }),
  });

  const duplicateMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/api/omnichannel/flows/${id}/duplicate`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["omnichannel-flows"] });
      toast({ title: "Flow duplicated" });
    },
    onError: () => toast({ title: "Error", description: "Failed to duplicate flow.", variant: "destructive" }),
  });

  const archiveMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/api/omnichannel/flows/${id}/archive`, { method: "POST" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["omnichannel-flows"] });
      toast({ title: "Flow archived" });
    },
    onError: () => toast({ title: "Error", description: "Failed to archive flow.", variant: "destructive" }),
  });

  function handleCreate() {
    if (!newFlowName.trim()) return;
    const emptyGraph = {
      entryNodeId: "trigger-1",
      nodes: [{ id: "trigger-1", type: "trigger", label: "Trigger", trigger: { type: newFlowTrigger } }],
      edges: [],
    };
    createMutation.mutate({ name: newFlowName, trigger_type: newFlowTrigger, flow_graph: emptyGraph });
  }

  const flows = data?.flows ?? [];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Automations</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Build flows that automatically respond to messages and manage conversations.
          </p>
        </div>
        <Button onClick={() => setShowCreateDialog(true)}>
          <Plus className="size-4 mr-2" />
          New flow
        </Button>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-2">
        {["all", "active", "draft", "paused", "archived"].map((s) => (
          <button
            key={s}
            onClick={() => setFilterState(s)}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              filterState === s
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground hover:bg-muted"
            }`}
          >
            {s.charAt(0).toUpperCase() + s.slice(1)}
          </button>
        ))}
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="flex items-center justify-center py-20">
          <Spinner className="size-8 text-primary" />
        </div>
      ) : error ? (
        <div className="text-center py-20 text-muted-foreground text-sm">
          Failed to load flows.
        </div>
      ) : flows.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 text-center gap-4">
          <div className="w-14 h-14 rounded-2xl bg-muted flex items-center justify-center">
            <Zap className="size-6 text-muted-foreground" />
          </div>
          <div>
            <p className="font-medium">No automation flows yet</p>
            <p className="text-sm text-muted-foreground mt-1">
              Create a flow to start automating conversations.
            </p>
          </div>
          <Button onClick={() => setShowCreateDialog(true)}>
            <Plus className="size-4 mr-2" />
            Create your first flow
          </Button>
        </div>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 border-b">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Name</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Trigger</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Status</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Executions</th>
                <th className="text-left px-4 py-3 font-medium text-muted-foreground">Last updated</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody className="divide-y">
              {flows.map((flow) => {
                const TriggerIcon = TRIGGER_ICONS[flow.trigger_type] ?? Zap;
                const badge = STATE_BADGE[flow.state] ?? { label: flow.state, variant: "secondary" as const };

                return (
                  <tr key={flow.id} className="hover:bg-muted/30 transition-colors">
                    <td className="px-4 py-3">
                      <Link
                        href={`/omnichannel/automations/${flow.id}`}
                        className="font-medium hover:underline underline-offset-2"
                      >
                        {flow.name}
                      </Link>
                      {flow.description && (
                        <p className="text-xs text-muted-foreground mt-0.5 truncate max-w-xs">
                          {flow.description}
                        </p>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className="flex items-center gap-1.5 text-muted-foreground">
                        <TriggerIcon className="size-3.5 shrink-0" />
                        {TRIGGER_LABELS[flow.trigger_type] ?? flow.trigger_type}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={badge.variant}>{badge.label}</Badge>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {flow.execution_count.toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {new Date(flow.updated_at).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" className="size-8">
                            <MoreVertical className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem asChild>
                            <Link href={`/omnichannel/automations/${flow.id}`}>
                              Edit flow
                            </Link>
                          </DropdownMenuItem>
                          {flow.state === "active" ? (
                            <DropdownMenuItem onClick={() => pauseMutation.mutate(flow.id)}>
                              <Pause className="size-4 mr-2" />
                              Pause
                            </DropdownMenuItem>
                          ) : flow.state !== "archived" ? (
                            <DropdownMenuItem onClick={() => publishMutation.mutate(flow.id)}>
                              <Play className="size-4 mr-2" />
                              Publish
                            </DropdownMenuItem>
                          ) : null}
                          <DropdownMenuItem onClick={() => duplicateMutation.mutate(flow.id)}>
                            <Copy className="size-4 mr-2" />
                            Duplicate
                          </DropdownMenuItem>
                          {flow.state !== "archived" && (
                            <DropdownMenuItem
                              className="text-destructive"
                              onClick={() => archiveMutation.mutate(flow.id)}
                            >
                              <Archive className="size-4 mr-2" />
                              Archive
                            </DropdownMenuItem>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Create dialog */}
      <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>New automation flow</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Flow name</Label>
              <Input
                placeholder="e.g. New Lead Qualification"
                value={newFlowName}
                onChange={(e) => setNewFlowName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") handleCreate(); }}
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label>Trigger</Label>
              <Select value={newFlowTrigger} onValueChange={setNewFlowTrigger}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="first_inbound_message">First inbound message</SelectItem>
                  <SelectItem value="keyword_match">Keyword match</SelectItem>
                  <SelectItem value="tag_added">Tag added</SelectItem>
                  <SelectItem value="message_not_responded">Message not responded after X minutes</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCreateDialog(false)}>
              Cancel
            </Button>
            <Button
              onClick={handleCreate}
              disabled={!newFlowName.trim() || createMutation.isPending}
            >
              {createMutation.isPending ? "Creating…" : "Create flow"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
