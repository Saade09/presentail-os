import React, { useRef, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  ChevronDown,
  MessageCircle,
  ExternalLink,
  Loader2,
  Send,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { formatDistanceToNow } from "date-fns";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type OmniMessage = {
  id: string;
  conversation_id: number;
  direction: "inbound" | "outbound";
  message_type: string;
  content: string | null;
  sender_name: string | null;
  status: string | null;
  template_name: string | null;
  template_params: Record<string, unknown> | null;
  created_at: string;
};

type OmniConversation = {
  id: number;
  status: string;
  channel_provider: string;
  channel_name: string;
};

type OmniContact = {
  id: number;
  display_name: string | null;
};

type ConversationResponse = {
  conversation: OmniConversation | null;
  messages: OmniMessage[];
  contact: OmniContact | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusBadgeClass(status: string): string {
  if (status === "open") return "bg-blue-100 text-blue-800 border-blue-200";
  if (status === "resolved") return "bg-green-100 text-green-800 border-green-200";
  if (status === "pending") return "bg-amber-100 text-amber-800 border-amber-200";
  return "bg-secondary text-secondary-foreground border-transparent";
}

// ---------------------------------------------------------------------------
// MessageBubble — mirrors ConversationThreadPanel styling
// ---------------------------------------------------------------------------

function MessageBubble({ message }: { message: OmniMessage }) {
  const isOutbound = message.direction === "outbound";
  const ts = formatDistanceToNow(new Date(message.created_at), {
    addSuffix: true,
  });

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
          isOutbound
            ? "bg-primary text-primary-foreground rounded-br-sm"
            : "bg-muted text-foreground rounded-bl-sm",
        )}
      >
        {/* Template label */}
        {message.template_name && (
          <span className="inline-block text-[10px] font-semibold bg-black/10 rounded px-1.5 py-0.5 mb-1.5 uppercase tracking-wide">
            {message.template_name}
          </span>
        )}
        {/* Inbound sender */}
        {message.sender_name && !isOutbound && (
          <p className="text-[11px] font-semibold mb-0.5 opacity-70">
            {message.sender_name}
          </p>
        )}
        <p className="whitespace-pre-wrap break-words">
          {message.content ?? "(media)"}
        </p>
        <div
          className={cn(
            "flex items-center gap-1 mt-1",
            isOutbound ? "justify-end" : "justify-start",
          )}
        >
          <span className="text-[10px] opacity-60">{ts}</span>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// RespondioConversationCard
// ---------------------------------------------------------------------------

interface Props {
  orderId: string;
}

export default function RespondioConversationCard({ orderId }: Props) {
  const [open, setOpen] = React.useState(false);
  const [text, setText] = React.useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery<ConversationResponse>({
    queryKey: [`/api/orders/${orderId}/omnichannel-conversation`],
    queryFn: () =>
      apiFetch<ConversationResponse>(
        `/api/orders/${orderId}/omnichannel-conversation`,
      ),
  });

  const sendMutation = useMutation({
    mutationFn: ({
      conversationId,
      content,
    }: {
      conversationId: number;
      content: string;
    }) =>
      apiFetch(`/api/omnichannel/conversations/${conversationId}/messages`, {
        method: "POST",
        body: JSON.stringify({ content }),
      }),
    onSuccess: () => {
      setText("");
      toast({ title: "Message sent" });
      void qc.invalidateQueries({
        queryKey: [`/api/orders/${orderId}/omnichannel-conversation`],
      });
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : "Failed to send";
      toast({ title: "Error", description: msg, variant: "destructive" });
    },
  });

  // Scroll to bottom whenever messages change or the card opens.
  useEffect(() => {
    if (open) {
      setTimeout(() => {
        bottomRef.current?.scrollIntoView({ behavior: "smooth" });
      }, 50);
    }
  }, [data?.messages?.length, open]);

  const conversation = data?.conversation ?? null;
  const messages = data?.messages ?? [];
  const conversationStatus = conversation?.status ?? "none";

  function handleSend() {
    const content = text.trim();
    if (!content || !conversation) return;
    sendMutation.mutate({ conversationId: conversation.id, content });
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <Card data-testid="card-respondio">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="w-full text-left"
            data-testid="button-respondio-toggle"
          >
            <CardHeader className="py-3">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <MessageCircle size={15} className="text-violet-500" />
                  Respond.io
                  {conversation && (
                    <Badge
                      className={cn(
                        "border text-xs font-medium capitalize",
                        statusBadgeClass(conversationStatus),
                      )}
                    >
                      {conversationStatus}
                    </Badge>
                  )}
                </CardTitle>
                <ChevronDown
                  size={16}
                  className={cn(
                    "shrink-0 text-muted-foreground transition-transform",
                    open && "rotate-180",
                  )}
                />
              </div>
            </CardHeader>
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <CardContent className="pt-0 pb-3 text-sm">
            {isLoading ? (
              <div className="flex items-center gap-2 text-muted-foreground py-4">
                <Loader2 size={14} className="animate-spin" />
                Loading conversation…
              </div>
            ) : !conversation ? (
              <p
                className="text-muted-foreground italic py-2"
                data-testid="respondio-empty"
              >
                No respond.io conversations found for this customer.
              </p>
            ) : (
              <>
                {/* Message thread */}
                <div className="max-h-72 overflow-y-auto space-y-3 py-2 px-1">
                  {messages.length === 0 ? (
                    <p className="text-muted-foreground text-center py-4 text-xs">
                      No messages yet
                    </p>
                  ) : (
                    messages.map((msg) => (
                      <MessageBubble key={msg.id} message={msg} />
                    ))
                  )}
                  <div ref={bottomRef} />
                </div>

                {/* View all link */}
                <div className="pt-2 pb-1">
                  <a
                    href={`/omnichannel/conversations/${conversation.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 text-xs text-blue-600 hover:text-blue-700 hover:underline underline-offset-2"
                    data-testid="respondio-view-all"
                  >
                    <ExternalLink size={11} />
                    View all in inbox
                  </a>
                </div>

                {/* Composer */}
                <div className="border-t border-border pt-3 mt-1 space-y-2">
                  <Textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => {
                      if (
                        e.key === "Enter" &&
                        (e.metaKey || e.ctrlKey) &&
                        text.trim()
                      ) {
                        e.preventDefault();
                        handleSend();
                      }
                    }}
                    placeholder="Type a reply… (⌘↩ to send)"
                    className="resize-none min-h-[64px] max-h-[120px] text-sm"
                    disabled={sendMutation.isPending}
                    data-testid="respondio-composer"
                  />
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      className="h-8 gap-1.5 text-xs"
                      disabled={!text.trim() || sendMutation.isPending}
                      onClick={handleSend}
                      data-testid="respondio-send-button"
                    >
                      {sendMutation.isPending ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <Send size={12} />
                      )}
                      {sendMutation.isPending ? "Sending…" : "Send"}
                    </Button>
                  </div>
                </div>
              </>
            )}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}
