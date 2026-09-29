import { useRef, useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getGetOmnichannelConversationQueryOptions,
  useResolveOmnichannelConversation,
  useReopenOmnichannelConversation,
} from "@workspace/api-client-react";
import type { OmniMessage, OmniNote } from "@workspace/api-client-react";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CheckCheck, Check, Clock, AlertCircle, RotateCcw, AlertTriangle } from "lucide-react";
import { formatDistanceToNow, format } from "date-fns";
import { apiFetch } from "@/lib/queryClient";
import MessageComposer from "./MessageComposer";

interface Props {
  conversationId: number;
}

const STATUS_ICONS: Record<string, React.ReactNode> = {
  sent: <Check className="w-3 h-3 text-muted-foreground" />,
  delivered: <CheckCheck className="w-3 h-3 text-muted-foreground" />,
  read: <CheckCheck className="w-3 h-3 text-blue-500" />,
  queued: <Clock className="w-3 h-3 text-muted-foreground" />,
  failed: <AlertCircle className="w-3 h-3 text-destructive" />,
};

function MessageBubble({
  message,
  onRetry,
  retrying,
}: {
  message: OmniMessage;
  onRetry?: () => void;
  retrying?: boolean;
}) {
  const isOutbound = message.direction === "outbound";
  const isFailed = message.status === "failed";
  const ts = formatDistanceToNow(new Date(message.created_at), { addSuffix: true });

  return (
    <div
      className={cn(
        "flex gap-2",
        isOutbound ? "justify-end" : "justify-start",
      )}
    >
      <div
        className={cn(
          "max-w-[75%] rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed",
          isOutbound && !isFailed
            ? "bg-primary text-primary-foreground rounded-br-sm"
            : isOutbound && isFailed
              ? "bg-destructive/10 border border-destructive/30 text-foreground rounded-br-sm"
              : "bg-muted text-foreground rounded-bl-sm",
        )}
      >
        {message.sender_name && !isOutbound && (
          <p className="text-[11px] font-semibold mb-0.5 opacity-70">{message.sender_name}</p>
        )}
        <p className="whitespace-pre-wrap break-words">{message.content ?? "(media)"}</p>
        <div
          className={cn(
            "flex items-center gap-1 mt-1",
            isOutbound ? "justify-end" : "justify-start",
          )}
        >
          <span className="text-[10px] opacity-60">{ts}</span>
          {isOutbound && message.status && STATUS_ICONS[message.status]}
        </div>
        {isFailed && (
          <div className="mt-1.5 space-y-1">
            {message.error_message && (
              <p
                className="text-[10px] text-destructive leading-snug"
                title={message.error_message}
              >
                {message.error_message.length > 80
                  ? message.error_message.slice(0, 80) + "…"
                  : message.error_message}
              </p>
            )}
            {onRetry && (
              <button
                className="flex items-center gap-1 text-[10px] text-destructive hover:text-destructive/80 font-medium transition-colors disabled:opacity-50"
                onClick={onRetry}
                disabled={retrying}
              >
                <RotateCcw className={cn("w-2.5 h-2.5", retrying && "animate-spin")} />
                {retrying ? "Retrying…" : "Retry send"}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function NoteItem({ note }: { note: OmniNote }) {
  const ts = formatDistanceToNow(new Date(note.created_at), { addSuffix: true });
  return (
    <div className="flex justify-center">
      <div className="bg-amber-50 border border-amber-200 rounded-lg px-3.5 py-2.5 max-w-[85%] text-sm">
        <div className="flex items-center gap-1.5 mb-1">
          <span className="text-[10px] font-semibold text-amber-700 uppercase tracking-wide">
            Internal note
          </span>
          <span className="text-[10px] text-amber-600 opacity-70">
            {note.author_name ?? note.author_id}
          </span>
        </div>
        <p className="text-amber-900 whitespace-pre-wrap break-words">{note.content}</p>
        <p className="text-[10px] text-amber-600 mt-1 opacity-70">{ts}</p>
      </div>
    </div>
  );
}

function DateSeparator({ date }: { date: string }) {
  return (
    <div className="flex items-center gap-3 my-2">
      <div className="flex-1 h-px bg-border" />
      <span className="text-[10px] text-muted-foreground">
        {format(new Date(date), "MMM d, yyyy")}
      </span>
      <div className="flex-1 h-px bg-border" />
    </div>
  );
}

export default function ConversationThreadPanel({ conversationId }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();
  const [retryingId, setRetryingId] = useState<string | null>(null);

  const { data, isLoading, isError } = useQuery({
    ...getGetOmnichannelConversationQueryOptions(conversationId),
  });

  const resolveMutation = useResolveOmnichannelConversation();
  const reopenMutation = useReopenOmnichannelConversation();

  const retryMutation = useMutation({
    mutationFn: (messageId: string) =>
      apiFetch(`/api/omnichannel/messages/${messageId}/retry`, { method: "POST" }),
    onSettled: (_data, _err, messageId) => {
      setRetryingId(null);
      void qc.invalidateQueries({
        queryKey: [`/api/omnichannel/conversations/${conversationId}`],
      });
    },
  });

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [data?.messages?.length]);

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center border-r border-border">
        <Spinner className="size-6 text-muted-foreground" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center border-r border-border text-sm gap-2">
        <AlertTriangle className="w-5 h-5 text-destructive" />
        <p className="text-destructive">Failed to load conversation</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            qc.invalidateQueries({
              queryKey: [`/api/omnichannel/conversations/${conversationId}`],
            })
          }
        >
          Retry
        </Button>
      </div>
    );
  }

  const { conversation, messages, notes } = data;

  type ThreadItem =
    | { type: "message"; data: OmniMessage; key: string; sortKey: string }
    | { type: "note"; data: OmniNote; key: string; sortKey: string };

  const threadItems: ThreadItem[] = [
    ...messages.map((m) => ({
      type: "message" as const,
      data: m,
      key: `msg-${m.id}`,
      sortKey: m.created_at,
    })),
    ...notes.map((n) => ({
      type: "note" as const,
      data: n,
      key: `note-${n.id}`,
      sortKey: n.created_at,
    })),
  ].sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  const isResolved = conversation.status === "resolved";

  // Check for failed outbound messages to show warning banner
  const hasFailedMessages = messages.some(
    (m) => m.direction === "outbound" && m.status === "failed",
  );

  const handleResolve = async () => {
    await resolveMutation.mutateAsync({ id: conversationId });
    void qc.invalidateQueries({ queryKey: ["/api/omnichannel/conversations"] });
    void qc.invalidateQueries({ queryKey: [`/api/omnichannel/conversations/${conversationId}`] });
  };

  const handleReopen = async () => {
    await reopenMutation.mutateAsync({ id: conversationId });
    void qc.invalidateQueries({ queryKey: ["/api/omnichannel/conversations"] });
    void qc.invalidateQueries({ queryKey: [`/api/omnichannel/conversations/${conversationId}`] });
  };

  const handleRetry = (messageId: string) => {
    setRetryingId(messageId);
    retryMutation.mutate(messageId);
  };

  return (
    <div className="flex-1 flex flex-col border-r border-border min-w-0 h-full">
      <div className="px-4 py-3 border-b border-border flex items-center justify-between gap-3 bg-background">
        <div className="flex items-center gap-2 min-w-0">
          <div className="min-w-0">
            <p className="font-semibold text-sm truncate">{conversation.contact_display_name}</p>
            <p className="text-xs text-muted-foreground">
              {conversation.channel_name} · {conversation.channel_provider}
              {conversation.subject ? ` · ${conversation.subject}` : ""}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {isResolved ? (
            <Button
              variant="outline"
              size="sm"
              onClick={handleReopen}
              disabled={reopenMutation.isPending}
            >
              Reopen
            </Button>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={handleResolve}
              disabled={resolveMutation.isPending}
            >
              Resolve
            </Button>
          )}
        </div>
      </div>

      {/* Failed messages warning banner */}
      {hasFailedMessages && (
        <div className="px-4 py-2 bg-destructive/10 border-b border-destructive/20 flex items-center gap-2 text-xs text-destructive">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
          <span>Some outbound messages failed to send. Use the Retry button below each failed message.</span>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {threadItems.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-8">
            No messages yet
          </p>
        )}
        {threadItems.map((item, idx) => {
          const prevItem = threadItems[idx - 1];
          const showDate =
            !prevItem ||
            new Date(item.sortKey).toDateString() !==
              new Date(prevItem.sortKey).toDateString();

          return (
            <div key={item.key}>
              {showDate && <DateSeparator date={item.sortKey} />}
              {item.type === "message" ? (
                <MessageBubble
                  message={item.data}
                  onRetry={
                    item.data.status === "failed" && item.data.direction === "outbound"
                      ? () => handleRetry(item.data.id)
                      : undefined
                  }
                  retrying={retryingId === item.data.id}
                />
              ) : (
                <NoteItem note={item.data} />
              )}
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <MessageComposer conversationId={conversationId} isResolved={isResolved} />
    </div>
  );
}
