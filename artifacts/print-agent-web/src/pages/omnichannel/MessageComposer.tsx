import { useState, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  useSendOmnichannelMessage,
  useAddOmnichannelNote,
  useDraftOmnichannelAiReply,
  getGetOmnichannelSavedRepliesQueryOptions,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { Sparkles, BookOpen, LayoutTemplate, StickyNote, Send } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";

type AiProviderStatus = {
  provider: "live" | "mock";
  source: "workspace_key" | "integration" | "mock";
};

interface Props {
  conversationId: number;
  isResolved: boolean;
}

const MAX_CHARS = 4096;

export default function MessageComposer({ conversationId, isResolved }: Props) {
  const [text, setText] = useState("");
  const [isNoteMode, setIsNoteMode] = useState(false);
  const [savedRepliesOpen, setSavedRepliesOpen] = useState(false);
  const [savedRepliesSearch, setSavedRepliesSearch] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { toast } = useToast();
  const qc = useQueryClient();

  const sendMessage = useSendOmnichannelMessage();
  const addNote = useAddOmnichannelNote();
  const draftAi = useDraftOmnichannelAiReply();

  const { data: aiStatus } = useQuery<AiProviderStatus>({
    queryKey: ["/api/omnichannel/ai/provider-status"],
    queryFn: () => apiFetch<AiProviderStatus>("/api/omnichannel/ai/provider-status"),
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  const { data: savedRepliesData } = useQuery({
    ...getGetOmnichannelSavedRepliesQueryOptions(
      savedRepliesOpen ? { q: savedRepliesSearch } : undefined,
    ),
    enabled: savedRepliesOpen,
  });
  const savedReplies = savedRepliesData?.saved_replies ?? [];

  const handleSend = async () => {
    const content = text.trim();
    if (!content) return;

    try {
      if (isNoteMode) {
        await addNote.mutateAsync({ id: conversationId, data: { content } });
        toast({ title: "Note added" });
      } else {
        await sendMessage.mutateAsync({ id: conversationId, data: { content } });
        toast({ title: "Message sent" });
      }
      setText("");
      qc.invalidateQueries({ queryKey: [`/api/omnichannel/conversations/${conversationId}`] });
      qc.invalidateQueries({ queryKey: ["/api/omnichannel/conversations"] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to send";
      toast({ title: "Error", description: msg, variant: "destructive" });
    }
  };

  const handleAiDraft = async () => {
    try {
      const result = await draftAi.mutateAsync({
        data: { conversation_id: conversationId, context: text || undefined },
      });
      setText(result.draft);
      textareaRef.current?.focus();
    } catch {
      toast({ title: "AI draft failed", variant: "destructive" });
    }
  };

  const handleInsertSavedReply = (content: string) => {
    setText((prev) => (prev ? prev + "\n" + content : content));
    setSavedRepliesOpen(false);
    textareaRef.current?.focus();
  };

  const isSending =
    sendMessage.isPending || addNote.isPending;

  return (
    <div
      className={cn(
        "border-t border-border bg-background",
        isNoteMode && "bg-amber-50/50",
      )}
    >
      <div className="px-4 pt-3 pb-2">
        <Textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder={
            isResolved
              ? "Conversation is resolved. Reopen to reply."
              : isNoteMode
                ? "Add an internal note…"
                : "Type a message… (⌘↩ to send)"
          }
          disabled={isResolved}
          className={cn(
            "resize-none min-h-[80px] max-h-[200px] text-sm border-0 shadow-none focus-visible:ring-0 bg-transparent p-0",
            isNoteMode && "placeholder:text-amber-600",
          )}
          maxLength={MAX_CHARS}
        />
        <div className="flex items-center justify-between mt-1">
          <span className="text-[10px] text-muted-foreground">
            {text.length}/{MAX_CHARS}
          </span>
        </div>
      </div>

      <div className="flex items-center justify-between px-3 pb-3 gap-2">
        <div className="flex items-center gap-1">
          <Popover open={savedRepliesOpen} onOpenChange={setSavedRepliesOpen}>
            <PopoverTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 px-2 gap-1.5 text-xs"
                disabled={isResolved}
              >
                <BookOpen className="w-3.5 h-3.5" />
                Saved replies
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-72 p-0" align="start" side="top">
              <div className="p-2 border-b border-border">
                <Input
                  className="h-7 text-xs"
                  placeholder="Search saved replies…"
                  value={savedRepliesSearch}
                  onChange={(e) => setSavedRepliesSearch(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="max-h-48 overflow-y-auto">
                {savedReplies.length === 0 && (
                  <p className="text-xs text-muted-foreground text-center py-4">
                    No saved replies found
                  </p>
                )}
                {savedReplies.map((reply) => (
                  <button
                    key={reply.id}
                    onClick={() => handleInsertSavedReply(reply.content)}
                    className="w-full text-left px-3 py-2.5 hover:bg-muted transition-colors border-b border-border last:border-0"
                  >
                    <p className="text-xs font-semibold text-foreground">
                      /{reply.shortcut} — {reply.title}
                    </p>
                    <p className="text-[11px] text-muted-foreground truncate mt-0.5">
                      {reply.content}
                    </p>
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>

          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 px-2 gap-1.5 text-xs"
                  onClick={handleAiDraft}
                  disabled={isResolved || draftAi.isPending}
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  {draftAi.isPending ? "Drafting…" : "AI draft"}
                </Button>
                {aiStatus && (
                  <span
                    className={cn(
                      "inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium leading-none",
                      aiStatus.provider === "live"
                        ? "bg-emerald-100 text-emerald-700"
                        : "bg-amber-100 text-amber-700",
                    )}
                  >
                    {aiStatus.provider === "live" ? "Live AI" : "Mock AI"}
                  </span>
                )}
              </div>
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-[200px] text-xs">
              {aiStatus?.provider === "live"
                ? aiStatus.source === "workspace_key"
                  ? "Using your workspace OpenAI API key"
                  : "Using Replit-managed AI integration"
                : "No AI key configured — responses are simulated"}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 px-2 gap-1.5 text-xs opacity-50 cursor-not-allowed"
                disabled
              >
                <LayoutTemplate className="w-3.5 h-3.5" />
                Template
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              Template selector is only available for WhatsApp conversations
            </TooltipContent>
          </Tooltip>

          <Button
            variant={isNoteMode ? "default" : "ghost"}
            size="sm"
            className={cn(
              "h-8 px-2 gap-1.5 text-xs",
              isNoteMode && "bg-amber-500 hover:bg-amber-600 text-white",
            )}
            onClick={() => setIsNoteMode((v) => !v)}
            disabled={isResolved}
          >
            <StickyNote className="w-3.5 h-3.5" />
            {isNoteMode ? "Note mode" : "Add note"}
          </Button>
        </div>

        <Button
          size="sm"
          className="h-8 gap-1.5 text-xs"
          onClick={handleSend}
          disabled={!text.trim() || isSending || isResolved}
        >
          <Send className="w-3.5 h-3.5" />
          {isSending ? "Sending…" : isNoteMode ? "Add Note" : "Send"}
        </Button>
      </div>
    </div>
  );
}
