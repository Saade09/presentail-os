import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import {
  getGetOmnichannelConversationQueryOptions,
  getGetOmnichannelConversationsQueryOptions,
  useAssignOmnichannelConversation,
  usePatchOmnichannelConversation,
  usePauseOmnichannelAutomation,
  useResumeOmnichannelAutomation,
} from "@workspace/api-client-react";
import type { OmniConversationPatchPriority } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import {
  User,
  Tag,
  ChevronDown,
  ChevronUp,
  Pause,
  Play,
  AlertCircle,
  CheckCircle2,
  X,
  Plus,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { apiFetch } from "@/lib/queryClient";

interface Props {
  conversationId: number;
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

const PRIORITY_OPTIONS = [
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "urgent", label: "Urgent" },
];

const PRIORITY_COLORS: Record<string, string> = {
  urgent: "text-red-600",
  high: "text-orange-600",
  medium: "text-yellow-600",
  low: "text-gray-500",
};

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground mb-2">
      {children}
    </p>
  );
}

function ConversationStatusBadge({ status }: { status: string }) {
  const variants: Record<string, string> = {
    open: "bg-green-100 text-green-700",
    pending: "bg-yellow-100 text-yellow-700",
    resolved: "bg-gray-100 text-gray-600",
  };
  return (
    <span
      className={cn(
        "text-xs px-2 py-0.5 rounded-full font-medium",
        variants[status] ?? "bg-gray-100 text-gray-600",
      )}
    >
      {status}
    </span>
  );
}

export default function ContactDetailsPanel({ conversationId }: Props) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [prevConvsOpen, setPrevConvsOpen] = useState(false);
  const [priorityValue, setPriorityValue] = useState<string>("");
  const [tagInput, setTagInput] = useState("");

  const { data, isLoading } = useQuery({
    ...getGetOmnichannelConversationQueryOptions(conversationId),
  });

  const assignMutation = useAssignOmnichannelConversation();
  const patchMutation = usePatchOmnichannelConversation();
  const pauseMutation = usePauseOmnichannelAutomation();
  const resumeMutation = useResumeOmnichannelAutomation();

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

  const tagMutation = useMutation({
    mutationFn: (tags: string[]) =>
      apiFetch<{ ok: boolean; tags: string[] }>(
        `/api/omnichannel/conversations/${conversationId}/tags`,
        { method: "PUT", body: JSON.stringify({ tags }) },
      ),
    onSuccess: () => {
      invalidate();
    },
    onError: () => {
      toast({ title: "Failed to update tags", variant: "destructive" });
    },
  });

  const prevConvsQuery = useQuery({
    ...getGetOmnichannelConversationsQueryOptions(
      prevConvsOpen && data ? { limit: 5, status: "resolved" } : undefined,
    ),
    enabled: prevConvsOpen && !!data,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: [`/api/omnichannel/conversations/${conversationId}`] });
    qc.invalidateQueries({ queryKey: ["/api/omnichannel/conversations"] });
  };

  if (isLoading) {
    return (
      <div className="w-64 flex-shrink-0 flex items-center justify-center border-l border-border">
        <Spinner className="size-5 text-muted-foreground" />
      </div>
    );
  }

  if (!data) return null;

  const { conversation, contact_identities } = data;

  const handleAssign = async (agentId: string) => {
    const value = agentId === "__unassign__" ? null : agentId || null;
    try {
      await assignMutation.mutateAsync({
        id: conversationId,
        data: { assigned_agent_id: value },
      });
      toast({ title: value ? "Assigned" : "Unassigned" });
      invalidate();
    } catch {
      toast({ title: "Failed to assign", variant: "destructive" });
    }
  };

  const handlePriorityChange = async (value: string) => {
    setPriorityValue(value);
    try {
      await patchMutation.mutateAsync({
        id: conversationId,
        data: {
          priority: value as OmniConversationPatchPriority,
        },
      });
      invalidate();
    } catch {
      toast({ title: "Failed to update priority", variant: "destructive" });
    }
  };

  const handleToggleAutomation = async () => {
    try {
      if (conversation.automation_paused) {
        await resumeMutation.mutateAsync({ id: conversationId });
        toast({ title: "Automation resumed" });
      } else {
        await pauseMutation.mutateAsync({ id: conversationId });
        toast({ title: "Automation paused" });
      }
      invalidate();
    } catch {
      toast({ title: "Failed to toggle automation", variant: "destructive" });
    }
  };

  const handleAddTag = () => {
    const trimmed = tagInput.trim();
    if (!trimmed) return;
    if (conversation.tags.includes(trimmed)) {
      setTagInput("");
      return;
    }
    tagMutation.mutate([...conversation.tags, trimmed]);
    setTagInput("");
  };

  const handleRemoveTag = (tag: string) => {
    tagMutation.mutate(conversation.tags.filter((t) => t !== tag));
  };

  const currentPriority = priorityValue || conversation.priority || "";
  const allTags = tagsQuery.data?.tags ?? [];
  const members = membersQuery.data?.members ?? [];

  const memberLabel = (m: WorkspaceMember) =>
    m.display_name ?? ([m.first_name, m.last_name].filter(Boolean).join(" ") || m.email);

  const currentAgentId = conversation.assigned_agent_id ?? "";
  const currentAgentMember = members.find((m) => m.id === currentAgentId);
  const currentAgentLabel = currentAgentMember
    ? memberLabel(currentAgentMember)
    : currentAgentId || null;

  return (
    <div className="w-64 flex-shrink-0 border-l border-border flex flex-col bg-background overflow-y-auto h-full">
      <div className="px-4 pt-4 pb-3 border-b border-border">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center flex-shrink-0">
            {conversation.contact_avatar_url ? (
              <img
                src={conversation.contact_avatar_url}
                alt=""
                className="w-10 h-10 rounded-full object-cover"
              />
            ) : (
              <User className="w-5 h-5 text-muted-foreground" />
            )}
          </div>
          <div className="min-w-0">
            <p className="font-semibold text-sm truncate">
              {conversation.contact_display_name}
            </p>
            <ConversationStatusBadge status={conversation.status} />
          </div>
        </div>
      </div>

      <div className="px-4 py-4 space-y-5 flex-1">
        <div>
          <SectionLabel>Channel identities</SectionLabel>
          <div className="space-y-1.5">
            {contact_identities.map((identity) => (
              <div key={`${identity.provider}-${identity.external_user_id}`} className="flex items-center gap-2 text-xs">
                <span className="font-medium capitalize text-muted-foreground w-20 flex-shrink-0">
                  {identity.provider}
                </span>
                <span className="truncate text-foreground">
                  {identity.display_name ?? identity.external_user_id}
                </span>
              </div>
            ))}
            {contact_identities.length === 0 && (
              <p className="text-xs text-muted-foreground">No identities</p>
            )}
          </div>
        </div>

        <div>
          <SectionLabel>Tags</SectionLabel>
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1 min-h-[1.25rem]">
              {conversation.tags.length === 0 && !tagMutation.isPending && (
                <p className="text-xs text-muted-foreground">No tags</p>
              )}
              {tagMutation.isPending && <Spinner className="size-3.5 text-muted-foreground" />}
              {!tagMutation.isPending && conversation.tags.map((tag) => (
                <Badge key={tag} variant="secondary" className="text-xs gap-1 pr-1">
                  <Tag className="w-2.5 h-2.5" />
                  {tag}
                  <button
                    onClick={() => handleRemoveTag(tag)}
                    className="ml-0.5 text-muted-foreground hover:text-destructive transition-colors"
                    aria-label={`Remove tag ${tag}`}
                  >
                    <X className="w-2.5 h-2.5" />
                  </button>
                </Badge>
              ))}
            </div>
            <div className="flex gap-1">
              <div className="relative flex-1">
                <Input
                  className="h-7 text-xs pr-1"
                  placeholder="Add tag…"
                  value={tagInput}
                  list={`tag-suggestions-${conversationId}`}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") { e.preventDefault(); handleAddTag(); }
                  }}
                />
                <datalist id={`tag-suggestions-${conversationId}`}>
                  {allTags
                    .filter((t) => !conversation.tags.includes(t.name))
                    .map((t) => (
                      <option key={t.id} value={t.name} />
                    ))}
                </datalist>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-7 w-7 p-0 flex-shrink-0"
                onClick={handleAddTag}
                disabled={tagMutation.isPending || !tagInput.trim()}
                title="Add tag"
              >
                <Plus className="w-3 h-3" />
              </Button>
            </div>
          </div>
        </div>

        <div>
          <SectionLabel>Assigned agent</SectionLabel>
          <div className="space-y-1.5">
            {currentAgentLabel ? (
              <p className="text-xs text-foreground font-medium truncate">{currentAgentLabel}</p>
            ) : (
              <p className="text-xs text-muted-foreground">Unassigned</p>
            )}
            <Select
              value={currentAgentId}
              onValueChange={handleAssign}
              disabled={assignMutation.isPending}
            >
              <SelectTrigger className="h-7 text-xs">
                <SelectValue placeholder="Assign to…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__unassign__" className="text-xs text-muted-foreground">
                  Unassign
                </SelectItem>
                {members.map((m) => (
                  <SelectItem key={m.id} value={m.id} className="text-xs">
                    {memberLabel(m)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div>
          <SectionLabel>Priority</SectionLabel>
          <Select value={currentPriority} onValueChange={handlePriorityChange}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue placeholder="Set priority">
                {currentPriority ? (
                  <span className={PRIORITY_COLORS[currentPriority]}>
                    {PRIORITY_OPTIONS.find((p) => p.value === currentPriority)?.label}
                  </span>
                ) : (
                  "Set priority"
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {PRIORITY_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value} className="text-xs">
                  <span className={PRIORITY_COLORS[opt.value]}>{opt.label}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div>
          <SectionLabel>Automation</SectionLabel>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 text-xs text-foreground">
              {conversation.automation_paused ? (
                <AlertCircle className="w-3.5 h-3.5 text-yellow-500" />
              ) : (
                <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
              )}
              <span>
                {conversation.automation_paused ? "Paused" : "Active"}
              </span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs gap-1 ml-auto"
              onClick={handleToggleAutomation}
              disabled={pauseMutation.isPending || resumeMutation.isPending}
            >
              {conversation.automation_paused ? (
                <>
                  <Play className="w-3 h-3" />
                  Resume
                </>
              ) : (
                <>
                  <Pause className="w-3 h-3" />
                  Pause
                </>
              )}
            </Button>
          </div>
        </div>

        <Collapsible open={prevConvsOpen} onOpenChange={setPrevConvsOpen}>
          <CollapsibleTrigger asChild>
            <button className="flex items-center justify-between w-full">
              <SectionLabel>Previous conversations</SectionLabel>
              {prevConvsOpen ? (
                <ChevronUp className="w-3.5 h-3.5 text-muted-foreground mb-2" />
              ) : (
                <ChevronDown className="w-3.5 h-3.5 text-muted-foreground mb-2" />
              )}
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            {prevConvsQuery.isLoading && (
              <Spinner className="size-4 text-muted-foreground" />
            )}
            {!prevConvsQuery.isLoading &&
              (prevConvsQuery.data?.conversations ?? []).length === 0 && (
                <p className="text-xs text-muted-foreground">No previous conversations</p>
              )}
            <div className="space-y-2">
              {(prevConvsQuery.data?.conversations ?? []).map((c) => (
                <div
                  key={c.id}
                  className="text-xs border border-border rounded p-2 space-y-0.5"
                >
                  <p className="font-medium truncate">{c.subject ?? c.channel_name}</p>
                  <p className="text-muted-foreground">
                    {c.last_message_at
                      ? formatDistanceToNow(new Date(c.last_message_at), {
                          addSuffix: true,
                        })
                      : "No messages"}
                  </p>
                </div>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </div>
  );
}
