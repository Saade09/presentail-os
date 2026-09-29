import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { apiFetch } from "@/lib/queryClient";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardHeader,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Plus, MessageSquare, Settings2, AlertCircle } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

type OmniProvider = "whatsapp" | "instagram" | "messenger" | "tiktok";

type ChannelAccount = {
  id: number;
  provider: OmniProvider;
  name: string;
  status: "disconnected" | "pending" | "connected" | "error";
  token_configured: boolean;
  last_webhook_received_at: string | null;
  last_outbound_send_at: string | null;
  last_error: string | null;
  is_active: boolean;
  created_at: string;
};

const PROVIDER_META: Record<OmniProvider, { label: string; icon: string; description: string; path: string }> = {
  whatsapp: {
    label: "WhatsApp",
    icon: "💬",
    description: "WhatsApp Business API via Meta",
    path: "/settings/channels/whatsapp",
  },
  instagram: {
    label: "Instagram",
    icon: "📷",
    description: "Instagram Direct Messages",
    path: "/settings/channels/instagram",
  },
  messenger: {
    label: "Messenger",
    icon: "💙",
    description: "Facebook Messenger via Meta",
    path: "/settings/channels/messenger",
  },
  tiktok: {
    label: "TikTok",
    icon: "🎵",
    description: "TikTok Business Messaging",
    path: "/settings/channels/tiktok",
  },
};

const PROVIDERS: OmniProvider[] = ["whatsapp", "instagram", "messenger", "tiktok"];

function StatusBadge({ status }: { status: ChannelAccount["status"] }) {
  if (status === "connected") {
    return <Badge className="bg-green-100 text-green-800 border-green-200">Connected</Badge>;
  }
  if (status === "error") {
    return <Badge variant="destructive">Error</Badge>;
  }
  if (status === "pending") {
    return <Badge className="bg-yellow-100 text-yellow-800 border-yellow-200">Pending</Badge>;
  }
  return <Badge variant="outline" className="text-muted-foreground">Disconnected</Badge>;
}

function AddChannelDialog({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState<"pick" | "name">("pick");
  const [provider, setProvider] = useState<OmniProvider | null>(null);
  const [name, setName] = useState("");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const createMutation = useMutation({
    mutationFn: (body: { provider: OmniProvider; name: string }) =>
      apiFetch("/api/omnichannel/channels", {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["omnichannel-channels"] });
      toast({ title: "Channel created", description: "Set up its credentials to connect." });
      onClose();
    },
    onError: () => {
      toast({ title: "Failed to create channel", variant: "destructive" });
    },
  });

  if (step === "pick") {
    return (
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a Channel</DialogTitle>
          <DialogDescription>Choose the messaging platform to connect.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3 py-2">
          {PROVIDERS.map((p) => {
            const meta = PROVIDER_META[p];
            return (
              <button
                key={p}
                type="button"
                className="flex flex-col items-center gap-2 rounded-lg border p-4 hover:bg-muted transition-colors text-left"
                onClick={() => {
                  setProvider(p);
                  setName(meta.label);
                  setStep("name");
                }}
              >
                <span className="text-2xl">{meta.icon}</span>
                <span className="text-sm font-medium">{meta.label}</span>
                <span className="text-xs text-muted-foreground text-center">{meta.description}</span>
              </button>
            );
          })}
        </div>
      </DialogContent>
    );
  }

  return (
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <DialogTitle>
          {provider ? PROVIDER_META[provider].icon : ""} Name your {provider ? PROVIDER_META[provider].label : ""} channel
        </DialogTitle>
        <DialogDescription>Give this channel a display name to distinguish it in your inbox.</DialogDescription>
      </DialogHeader>
      <div className="space-y-3 py-2">
        <div className="space-y-1">
          <Label htmlFor="channel-name">Channel name</Label>
          <Input
            id="channel-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={provider ? `e.g. ${PROVIDER_META[provider].label} — Main` : ""}
          />
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={() => setStep("pick")}>Back</Button>
        <Button
          disabled={!name.trim() || createMutation.isPending}
          onClick={() => {
            if (provider && name.trim()) {
              createMutation.mutate({ provider, name: name.trim() });
            }
          }}
        >
          {createMutation.isPending ? "Creating…" : "Create channel"}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

export default function ChannelsPage() {
  const { realIsOwner, loaded } = useWorkspaceRole();
  const [showAdd, setShowAdd] = useState(false);

  const { data, isLoading } = useQuery<{ channels: ChannelAccount[] }>({
    queryKey: ["omnichannel-channels"],
    queryFn: () => apiFetch("/api/omnichannel/channels") as Promise<{ channels: ChannelAccount[] }>,
    enabled: loaded && realIsOwner,
    refetchInterval: 30_000,
  });

  if (loaded && !realIsOwner) {
    return (
      <div className="flex items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
        <AlertCircle size={16} />
        Only workspace owners can manage channel connections.
      </div>
    );
  }

  const channels = data?.channels ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Messaging Channels</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Connect WhatsApp, Instagram, Messenger, and TikTok to your unified inbox.
          </p>
        </div>
        <Button onClick={() => setShowAdd(true)}>
          <Plus size={16} className="mr-2" />
          Add Channel
        </Button>
      </div>

      {isLoading && (
        <div className="text-sm text-muted-foreground">Loading channels…</div>
      )}

      {!isLoading && channels.length === 0 && (
        <Card className="border-dashed">
          <CardContent className="flex flex-col items-center justify-center py-12 text-center gap-3">
            <MessageSquare size={32} className="text-muted-foreground" />
            <div>
              <p className="font-medium">No channels connected yet</p>
              <p className="text-sm text-muted-foreground">Add a channel to start receiving messages in your inbox.</p>
            </div>
            <Button variant="outline" onClick={() => setShowAdd(true)}>
              <Plus size={16} className="mr-2" />
              Add your first channel
            </Button>
          </CardContent>
        </Card>
      )}

      {channels.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {channels.map((ch) => {
            const meta = PROVIDER_META[ch.provider] ?? {
              label: ch.provider,
              icon: "📡",
              description: "",
              path: `/settings/channels/${ch.provider}`,
            };
            return (
              <Card key={ch.id} className="relative">
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xl">{meta.icon}</span>
                      <div>
                        <p className="font-semibold leading-tight">{ch.name}</p>
                        <p className="text-xs text-muted-foreground">{meta.label}</p>
                      </div>
                    </div>
                    <StatusBadge status={ch.status} />
                  </div>
                </CardHeader>
                <CardContent className="space-y-2 text-xs text-muted-foreground">
                  {ch.last_webhook_received_at && (
                    <p>
                      Last event:{" "}
                      <span className="text-foreground">
                        {formatDistanceToNow(new Date(ch.last_webhook_received_at), { addSuffix: true })}
                      </span>
                    </p>
                  )}
                  {ch.last_outbound_send_at && (
                    <p>
                      Last sent:{" "}
                      <span className="text-foreground">
                        {formatDistanceToNow(new Date(ch.last_outbound_send_at), { addSuffix: true })}
                      </span>
                    </p>
                  )}
                  {ch.status === "error" && ch.last_error && (
                    <p className="text-destructive truncate" title={ch.last_error}>
                      {ch.last_error}
                    </p>
                  )}
                  {!ch.token_configured && (
                    <p className="text-yellow-700">Credentials not configured</p>
                  )}
                  <div className="pt-1">
                    <Link href={`${meta.path}?id=${ch.id}`}>
                      <Button size="sm" variant="outline" className="w-full">
                        <Settings2 size={13} className="mr-1.5" />
                        Manage
                      </Button>
                    </Link>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <AddChannelDialog onClose={() => setShowAdd(false)} />
      </Dialog>
    </div>
  );
}
