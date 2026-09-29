import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";
import { useParams, Link } from "wouter";
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import {
  ArrowLeft,
  MessageSquare,
  Tag,
  Trash2,
  AlertTriangle,
  Clock,
  Check,
  CheckCheck,
} from "lucide-react";
import { formatDistanceToNow, format } from "date-fns";
import { cn } from "@/lib/utils";

interface ContactProfile {
  success: boolean;
  contact: {
    id: number;
    display_name: string;
    email: string | null;
    phone: string | null;
    avatar_url: string | null;
    language: string | null;
    timezone: string | null;
    metadata: Record<string, unknown> | null;
    is_blocked: boolean;
    created_at: string;
    updated_at: string;
  };
  identities: {
    id: number;
    provider: string;
    external_user_id: string;
    display_name: string | null;
    avatar_url: string | null;
    channel_account_id: number;
    channel_name: string;
    created_at: string;
  }[];
  tags: { id: number; name: string; color: string | null }[];
  timeline: {
    id: string;
    conversation_id: number;
    direction: string;
    message_type: string;
    content: string | null;
    status: string;
    sender_name: string | null;
    created_at: string;
    channel_name: string | null;
    provider: string | null;
  }[];
}

function getInitials(name: string): string {
  return name
    .split(" ")
    .map((w) => w[0] ?? "")
    .join("")
    .toUpperCase()
    .slice(0, 2);
}

const STATUS_ICONS: Record<string, React.ReactNode> = {
  sent: <Check className="w-3 h-3 text-muted-foreground" />,
  delivered: <CheckCheck className="w-3 h-3 text-muted-foreground" />,
  read: <CheckCheck className="w-3 h-3 text-blue-500" />,
  queued: <Clock className="w-3 h-3 text-muted-foreground" />,
  failed: <AlertTriangle className="w-3 h-3 text-destructive" />,
};

function ProviderBadge({ provider }: { provider: string | null }) {
  if (!provider) return null;
  const colors: Record<string, string> = {
    whatsapp: "bg-green-100 text-green-800",
    instagram: "bg-pink-100 text-pink-800",
    messenger: "bg-blue-100 text-blue-800",
    tiktok: "bg-gray-100 text-gray-800",
    mock: "bg-yellow-100 text-yellow-800",
  };
  return (
    <span
      className={cn(
        "text-[10px] px-1.5 py-0.5 rounded font-medium capitalize",
        colors[provider] ?? "bg-muted text-muted-foreground",
      )}
    >
      {provider}
    </span>
  );
}

export default function ContactProfilePage() {
  const params = useParams();
  const contactId = params["id"];
  const qc = useQueryClient();
  const { toast } = useToast();
  const { isOwner } = useWorkspaceRole();
  const [anonymizeOpen, setAnonymizeOpen] = useState(false);
  const [removingTagId, setRemovingTagId] = useState<number | null>(null);

  const { data, isLoading, isError } = useQuery<ContactProfile>({
    queryKey: ["omnichannel-contact", contactId],
    queryFn: () => apiFetch(`/api/omnichannel/contacts/${contactId}`),
    enabled: !!contactId,
  });

  const anonymizeMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/omnichannel/contacts/${contactId}/anonymize`, { method: "POST" }),
    onSuccess: () => {
      toast({ title: "Contact anonymized", description: "All PII has been redacted." });
      void qc.invalidateQueries({ queryKey: ["omnichannel-contact", contactId] });
      void qc.invalidateQueries({ queryKey: ["omnichannel-contacts"] });
      setAnonymizeOpen(false);
    },
    onError: () => {
      toast({
        title: "Anonymization failed",
        description: "Please try again.",
        variant: "destructive",
      });
    },
  });

  const removeTagMutation = useMutation({
    mutationFn: (tagId: number) =>
      apiFetch(`/api/omnichannel/contacts/${contactId}/tags/${tagId}`, { method: "DELETE" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["omnichannel-contact", contactId] });
      setRemovingTagId(null);
    },
    onError: () => {
      toast({ title: "Failed to remove tag", variant: "destructive" });
      setRemovingTagId(null);
    },
  });

  if (isLoading) {
    return (
      <div className="flex min-h-[50vh] items-center justify-center">
        <Spinner className="size-8 text-primary" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="p-6">
        <Link href="/omnichannel/contacts">
          <Button variant="ghost" size="sm" className="mb-4">
            <ArrowLeft className="w-4 h-4 mr-1" />
            Back to Contacts
          </Button>
        </Link>
        <p className="text-muted-foreground">Contact not found.</p>
      </div>
    );
  }

  const { contact, identities, tags, timeline } = data;

  // Group timeline messages by conversation
  const byConv = timeline.reduce<Record<number, typeof timeline>>((acc, msg) => {
    if (!acc[msg.conversation_id]) acc[msg.conversation_id] = [];
    acc[msg.conversation_id]!.push(msg);
    return acc;
  }, {});

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-5">
      <Link href="/omnichannel/contacts">
        <Button variant="ghost" size="sm">
          <ArrowLeft className="w-4 h-4 mr-1" />
          Back to Contacts
        </Button>
      </Link>

      {/* Header */}
      <div className="flex items-start gap-4">
        <Avatar className="w-14 h-14 shrink-0">
          <AvatarImage src={contact.avatar_url ?? undefined} />
          <AvatarFallback>{getInitials(contact.display_name)}</AvatarFallback>
        </Avatar>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-xl font-bold">{contact.display_name}</h1>
            {contact.is_blocked && <Badge variant="destructive">Blocked</Badge>}
          </div>
          <div className="text-sm text-muted-foreground mt-0.5 flex flex-wrap gap-x-3">
            {contact.email && <span>{contact.email}</span>}
            {contact.phone && <span>{contact.phone}</span>}
            {contact.language && <span>Lang: {contact.language}</span>}
            {contact.timezone && <span>TZ: {contact.timezone}</span>}
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Contact since {format(new Date(contact.created_at), "MMM d, yyyy")}
          </p>
        </div>
        {isOwner && (
          <Button
            variant="destructive"
            size="sm"
            onClick={() => setAnonymizeOpen(true)}
          >
            <Trash2 className="w-4 h-4 mr-1" />
            Anonymize
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Left column: identities + tags */}
        <div className="space-y-4">
          {/* Channel Identities */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Channel Identities</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {identities.length === 0 && (
                <p className="text-xs text-muted-foreground">No channel identities</p>
              )}
              {identities.map((identity) => (
                <div key={identity.id} className="flex items-center gap-2">
                  <ProviderBadge provider={identity.provider} />
                  <div className="min-w-0">
                    <p className="text-xs font-medium truncate">
                      {identity.display_name ?? identity.external_user_id}
                    </p>
                    <p className="text-[10px] text-muted-foreground truncate">
                      {identity.channel_name}
                    </p>
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>

          {/* Tags */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center gap-1.5">
                <Tag className="w-4 h-4" />
                Tags
              </CardTitle>
            </CardHeader>
            <CardContent>
              {tags.length === 0 && (
                <p className="text-xs text-muted-foreground">No tags</p>
              )}
              <div className="flex flex-wrap gap-1.5">
                {tags.map((tag) => (
                  <div
                    key={tag.id}
                    className="flex items-center gap-1 bg-muted rounded-full px-2 py-0.5"
                  >
                    {tag.color && (
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: tag.color }}
                      />
                    )}
                    <span className="text-xs">{tag.name}</span>
                    <button
                      className="text-muted-foreground hover:text-destructive transition-colors ml-0.5"
                      onClick={() => {
                        setRemovingTagId(tag.id);
                        removeTagMutation.mutate(tag.id);
                      }}
                      disabled={removingTagId === tag.id}
                      title="Remove tag"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>

          {/* Metadata */}
          {contact.metadata && Object.keys(contact.metadata).length > 0 && (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm">Custom Fields</CardTitle>
              </CardHeader>
              <CardContent className="space-y-1.5">
                {Object.entries(contact.metadata).map(([k, v]) => (
                  <div key={k} className="flex items-start gap-2 text-xs">
                    <span className="text-muted-foreground font-medium shrink-0">{k}:</span>
                    <span className="break-all">{String(v)}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>

        {/* Right column: message timeline */}
        <div className="lg:col-span-2 space-y-4">
          <h2 className="text-sm font-semibold flex items-center gap-1.5">
            <MessageSquare className="w-4 h-4" />
            Message Timeline ({timeline.length})
          </h2>
          {Object.entries(byConv).length === 0 && (
            <Card>
              <CardContent className="py-10 text-center text-muted-foreground text-sm">
                No messages yet
              </CardContent>
            </Card>
          )}
          {Object.entries(byConv).map(([convId, messages]) => (
            <Card key={convId}>
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-xs text-muted-foreground">
                    Conversation #{convId}
                  </CardTitle>
                  {messages[0] && (
                    <ProviderBadge provider={messages[0].provider} />
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-2 max-h-64 overflow-y-auto">
                {messages.map((msg) => {
                  const isOutbound = msg.direction === "outbound";
                  return (
                    <div
                      key={msg.id}
                      className={cn(
                        "flex gap-2",
                        isOutbound ? "justify-end" : "justify-start",
                      )}
                    >
                      <div
                        className={cn(
                          "max-w-[80%] rounded-xl px-3 py-2 text-xs",
                          isOutbound
                            ? "bg-primary text-primary-foreground"
                            : "bg-muted text-foreground",
                        )}
                      >
                        {msg.sender_name && !isOutbound && (
                          <p className="text-[10px] font-semibold mb-0.5 opacity-70">
                            {msg.sender_name}
                          </p>
                        )}
                        <p className="whitespace-pre-wrap break-words">
                          {msg.content ?? "(media)"}
                        </p>
                        <div
                          className={cn(
                            "flex items-center gap-1 mt-0.5",
                            isOutbound ? "justify-end" : "justify-start",
                          )}
                        >
                          <span className="text-[10px] opacity-60">
                            {formatDistanceToNow(new Date(msg.created_at), { addSuffix: true })}
                          </span>
                          {isOutbound && msg.status && STATUS_ICONS[msg.status]}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {/* Anonymize Dialog */}
      <Dialog open={anonymizeOpen} onOpenChange={setAnonymizeOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Anonymize Contact</DialogTitle>
          </DialogHeader>
          <div className="py-2 space-y-2 text-sm text-muted-foreground">
            <p>
              This will permanently replace all PII (name, email, phone, avatar) with
              redacted placeholders and erase all message content for this contact.
            </p>
            <p className="font-medium text-foreground">This action cannot be undone.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAnonymizeOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => anonymizeMutation.mutate()}
              disabled={anonymizeMutation.isPending}
            >
              {anonymizeMutation.isPending ? "Anonymizing…" : "Anonymize Contact"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
