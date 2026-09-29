import { useState, useCallback, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getGetOmnichannelConversationsQueryOptions } from "@workspace/api-client-react";
import type { GetOmnichannelConversationsParams, OmniConversation } from "@workspace/api-client-react";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { Search, CheckSquare, X, UserCheck } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { apiFetch } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface Props {
  selectedId: number | null;
  onSelect: (id: number) => void;
}

interface WorkspaceMember {
  id: string;
  email: string;
  display_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
}

interface OmniTagItem {
  id: number;
  name: string;
  color?: string | null;
}

const STATUS_TABS = [
  { value: "open", label: "Open" },
  { value: "pending", label: "Pending" },
  { value: "resolved", label: "Resolved" },
] as const;

type StatusTab = (typeof STATUS_TABS)[number]["value"];

const CHANNEL_COLORS: Record<string, string> = {
  whatsapp: "bg-green-500",
  instagram: "bg-purple-500",
  messenger: "bg-blue-500",
  tiktok: "bg-black",
  test_provider: "bg-gray-400",
};

const PRIORITY_COLORS: Record<string, string> = {
  urgent: "bg-red-100 text-red-700 border-red-200",
  high: "bg-orange-100 text-orange-700 border-orange-200",
  medium: "bg-yellow-100 text-yellow-700 border-yellow-200",
  low: "bg-gray-100 text-gray-600 border-gray-200",
};

function ChannelBadge({ provider }: { provider: string }) {
  const color = CHANNEL_COLORS[provider] ?? "bg-gray-400";
  return (
    <span
      className={cn("inline-block w-2 h-2 rounded-full flex-shrink-0", color)}
      title={provider}
    />
  );
}

function ConversationItem({
  conversation,
  isSelected,
  isChecked,
  onToggleCheck,
  onClick,
  tagColorMap,
}: {
  conversation: OmniConversation;
  isSelected: boolean;
  isChecked: boolean;
  onToggleCheck: () => void;
  onClick: () => void;
  tagColorMap: Map<string, string>;
}) {
  const ts = conversation.last_message_at
    ? formatDistanceToNow(new Date(conversation.last_message_at), { addSuffix: true })
    : "";

  return (
    <div
      className={cn(
        "w-full text-left border-b border-border hover:bg-muted/50 transition-colors flex items-start gap-0",
        isSelected && "bg-primary/5 border-l-2 border-l-primary",
      )}
    >
      <div
        className="flex-shrink-0 flex items-center justify-center pl-3 pt-3.5"
        onClick={(e) => { e.stopPropagation(); onToggleCheck(); }}
      >
        <input
          type="checkbox"
          checked={isChecked}
          onChange={() => {}}
          className="h-3.5 w-3.5 rounded border-border cursor-pointer accent-primary"
          aria-label="Select conversation"
        />
      </div>
      <button
        onClick={onClick}
        className="flex-1 min-w-0 px-3 py-3 flex flex-col gap-1 text-left"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <ChannelBadge provider={conversation.channel_provider} />
            <span className="font-medium text-sm truncate">
              {conversation.contact_display_name}
            </span>
            {conversation.unread_count > 0 && (
              <span className="flex-shrink-0 inline-flex items-center justify-center w-4 h-4 rounded-full bg-primary text-primary-foreground text-[10px] font-bold">
                {conversation.unread_count > 9 ? "9+" : conversation.unread_count}
              </span>
            )}
          </div>
          <span className="text-xs text-muted-foreground flex-shrink-0">{ts}</span>
        </div>

        {conversation.last_message_snippet && (
          <p className="text-xs text-muted-foreground truncate">
            {conversation.last_message_snippet}
          </p>
        )}

        <div className="flex items-center gap-1.5 flex-wrap">
          {conversation.priority && (
            <span
              className={cn(
                "text-[10px] px-1.5 py-0.5 rounded border font-medium",
                PRIORITY_COLORS[conversation.priority] ?? "bg-gray-100 text-gray-600",
              )}
            >
              {conversation.priority}
            </span>
          )}
          {conversation.tags.slice(0, 2).map((tag) => {
            const color = tagColorMap.get(tag);
            return (
              <Badge key={tag} variant="secondary" className="text-[10px] py-0 px-1.5 h-4 gap-1 flex items-center">
                {color && (
                  <span
                    className="inline-block w-2 h-2 rounded-full flex-shrink-0"
                    style={{ backgroundColor: color }}
                  />
                )}
                {tag}
              </Badge>
            );
          })}
          {conversation.tags.length > 2 && (
            <span className="text-[10px] text-muted-foreground">
              +{conversation.tags.length - 2}
            </span>
          )}
        </div>
      </button>
    </div>
  );
}

export default function ConversationListPanel({ selectedId, onSelect }: Props) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const [status, setStatus] = useState<StatusTab>("open");
  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState<string>("all");
  const [agentFilter, setAgentFilter] = useState<string>("all");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [showBulkAssign, setShowBulkAssign] = useState(false);
  const [bulkAssignAgent, setBulkAssignAgent] = useState<string>("none");

  const params: GetOmnichannelConversationsParams = {
    status,
    ...(search ? { q: search } : {}),
    ...(tagFilter && tagFilter !== "all" ? { tag: tagFilter } : {}),
    ...(agentFilter && agentFilter !== "all" && agentFilter !== "__unassigned__" ? { assigned_agent_id: agentFilter } : {}),
    ...(agentFilter === "__unassigned__" ? { assigned_agent_id: "" } : {}),
    limit: 50,
  };

  const { data, isLoading, isError } = useQuery({
    ...getGetOmnichannelConversationsQueryOptions(params),
  });

  const tagsQuery = useQuery<{ tags: OmniTagItem[] }>({
    queryKey: ["/api/omnichannel/tags"],
    queryFn: () => apiFetch<{ tags: OmniTagItem[] }>("/api/omnichannel/tags"),
    staleTime: 60_000,
  });

  const membersQuery = useQuery<{ members: WorkspaceMember[] }>({
    queryKey: ["users"],
    queryFn: () => apiFetch<{ members: WorkspaceMember[] }>("/api/users"),
    staleTime: 60_000,
  });

  const bulkMutation = useMutation({
    mutationFn: (body: { conversation_ids: number[]; action: "resolve" | "assign"; assigned_agent_id?: string | null }) =>
      apiFetch<{ ok: boolean; affected: number }>("/api/omnichannel/conversations/bulk-action", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: (data, vars) => {
      toast({ title: `${data.affected} conversation${data.affected === 1 ? "" : "s"} ${vars.action === "resolve" ? "resolved" : "assigned"}` });
      setSelectedIds(new Set());
      setShowBulkAssign(false);
      setBulkAssignAgent("none");
      qc.invalidateQueries({ queryKey: ["/api/omnichannel/conversations"] });
    },
    onError: () => {
      toast({ title: "Bulk action failed", variant: "destructive" });
    },
  });

  const conversations = data?.conversations ?? [];
  const allTags = tagsQuery.data?.tags ?? [];
  const members = membersQuery.data?.members ?? [];

  const tagColorMap = useMemo(
    () => new Map(allTags.filter((t) => t.color).map((t) => [t.name, t.color as string])),
    [allTags],
  );

  const toggleSelect = useCallback((id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleBulkResolve = () => {
    bulkMutation.mutate({ conversation_ids: Array.from(selectedIds), action: "resolve" });
  };

  const handleBulkAssign = () => {
    bulkMutation.mutate({
      conversation_ids: Array.from(selectedIds),
      action: "assign",
      assigned_agent_id: bulkAssignAgent === "none" ? null : bulkAssignAgent || null,
    });
  };

  const memberLabel = (m: WorkspaceMember) =>
    m.display_name ?? ([m.first_name, m.last_name].filter(Boolean).join(" ") || m.email);

  const hasFilters = (tagFilter && tagFilter !== "all") || (agentFilter && agentFilter !== "all");

  return (
    <div className="w-80 flex-shrink-0 border-r border-border flex flex-col bg-background h-full">
      <div className="px-4 pt-4 pb-2 space-y-2 border-b border-border">
        <h2 className="font-semibold text-base">Inbox</h2>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
          <Input
            className="pl-8 h-8 text-sm"
            placeholder="Search conversations…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="flex gap-1.5">
          <Select value={tagFilter} onValueChange={setTagFilter}>
            <SelectTrigger
              className={cn("h-7 text-xs flex-1", hasFilters && tagFilter ? "border-primary/60 text-primary" : "")}
            >
              <SelectValue placeholder="All tags" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="text-xs">All tags</SelectItem>
              {allTags.map((t) => (
                <SelectItem key={t.id} value={t.name} className="text-xs">
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={agentFilter} onValueChange={setAgentFilter}>
            <SelectTrigger
              className={cn("h-7 text-xs flex-1", hasFilters && agentFilter ? "border-primary/60 text-primary" : "")}
            >
              <SelectValue placeholder="All agents" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all" className="text-xs">All agents</SelectItem>
              <SelectItem value="__unassigned__" className="text-xs text-muted-foreground">Unassigned</SelectItem>
              {members.map((m) => (
                <SelectItem key={m.id} value={m.id} className="text-xs">
                  {memberLabel(m)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          {hasFilters && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-7 p-0 flex-shrink-0"
              onClick={() => { setTagFilter("all"); setAgentFilter("all"); }}
              title="Clear filters"
            >
              <X className="w-3.5 h-3.5" />
            </Button>
          )}
        </div>
      </div>

      <div className="flex border-b border-border">
        {STATUS_TABS.map((tab) => (
          <button
            key={tab.value}
            onClick={() => setStatus(tab.value)}
            className={cn(
              "flex-1 text-xs py-2 font-medium transition-colors",
              status === tab.value
                ? "text-primary border-b-2 border-primary"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {isLoading && (
          <div className="flex justify-center py-8">
            <Spinner className="size-5 text-muted-foreground" />
          </div>
        )}
        {isError && (
          <p className="text-sm text-destructive text-center py-6 px-4">
            Failed to load conversations
          </p>
        )}
        {!isLoading && !isError && conversations.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-8 px-4">
            No {status} conversations
          </p>
        )}
        {conversations.map((conv) => (
          <ConversationItem
            key={conv.id}
            conversation={conv}
            isSelected={selectedId === conv.id}
            isChecked={selectedIds.has(conv.id)}
            onToggleCheck={() => toggleSelect(conv.id)}
            onClick={() => onSelect(conv.id)}
            tagColorMap={tagColorMap}
          />
        ))}
      </div>

      {selectedIds.size > 0 && (
        <div className="border-t border-border bg-muted/30 px-3 py-2.5 space-y-2 flex-shrink-0">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium flex items-center gap-1.5">
              <CheckSquare className="w-3.5 h-3.5 text-primary" />
              {selectedIds.size} selected
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
              onClick={() => { setSelectedIds(new Set()); setShowBulkAssign(false); }}
              title="Clear selection"
            >
              <X className="w-3.5 h-3.5" />
            </Button>
          </div>
          <div className="flex gap-1.5">
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs flex-1"
              onClick={handleBulkResolve}
              disabled={bulkMutation.isPending}
            >
              Resolve all
            </Button>
            <Button
              size="sm"
              variant="outline"
              className={cn("h-7 text-xs flex-1", showBulkAssign && "bg-muted")}
              onClick={() => setShowBulkAssign((v) => !v)}
              disabled={bulkMutation.isPending}
            >
              <UserCheck className="w-3 h-3 mr-1" />
              Assign
            </Button>
          </div>
          {showBulkAssign && (
            <div className="flex gap-1.5">
              <Select value={bulkAssignAgent} onValueChange={setBulkAssignAgent}>
                <SelectTrigger className="h-7 text-xs flex-1">
                  <SelectValue placeholder="Pick agent…" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none" className="text-xs text-muted-foreground">Unassign</SelectItem>
                  {members.map((m) => (
                    <SelectItem key={m.id} value={m.id} className="text-xs">
                      {memberLabel(m)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                size="sm"
                className="h-7 text-xs px-3"
                onClick={handleBulkAssign}
                disabled={bulkMutation.isPending}
              >
                Go
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
