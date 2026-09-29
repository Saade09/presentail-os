import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation } from "wouter";
import { apiFetch } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import {
  Copy,
  Check,
  RefreshCw,
  Zap,
  ChevronLeft,
  AlertTriangle,
  Wifi,
  WifiOff,
  Clock,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";

export type OmniProvider = "whatsapp" | "instagram" | "messenger" | "tiktok";

export type ChannelAccount = {
  id: number;
  provider: OmniProvider;
  name: string;
  external_account_id: string | null;
  webhook_verify_token: string | null;
  status: "disconnected" | "pending" | "connected" | "error";
  token_configured: boolean;
  refresh_token_configured: boolean;
  last_webhook_received_at: string | null;
  last_outbound_send_at: string | null;
  last_error: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type CredentialField = {
  key: string;
  label: string;
  placeholder: string;
  helpText?: string;
};

export type PermissionItem = {
  label: string;
  required: boolean;
};

export type SetupInstruction = {
  title: string;
  steps: string[];
};

export type LayoutProps = {
  channelId: number;
  provider: OmniProvider;
  providerLabel: string;
  providerIcon: string;
  webhookPath: string;
  credentialFields: CredentialField[];
  permissions: PermissionItem[];
  setupInstructions: SetupInstruction[];
  extraStatusNote?: React.ReactNode;
};

function CopyButton({ value, label }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? <Check size={12} className="text-green-600" /> : <Copy size={12} />}
      {label ?? (copied ? "Copied" : "Copy")}
    </button>
  );
}

function StatusBadge({ status }: { status: ChannelAccount["status"] }) {
  if (status === "connected") {
    return (
      <Badge className="bg-green-100 text-green-800 border-green-200 gap-1">
        <Wifi size={11} /> Connected
      </Badge>
    );
  }
  if (status === "error") {
    return <Badge variant="destructive" className="gap-1"><AlertTriangle size={11} /> Error</Badge>;
  }
  if (status === "pending") {
    return (
      <Badge className="bg-yellow-100 text-yellow-800 border-yellow-200 gap-1">
        <Clock size={11} /> Pending
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-muted-foreground gap-1">
      <WifiOff size={11} /> Disconnected
    </Badge>
  );
}

export default function ChannelSetupLayout({
  channelId,
  provider,
  providerLabel,
  providerIcon,
  webhookPath,
  credentialFields,
  permissions,
  setupInstructions,
  extraStatusNote,
}: LayoutProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [showDisconnect, setShowDisconnect] = useState(false);
  const [, navigate] = useLocation();

  const webhookUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}${webhookPath}`
      : webhookPath;

  const { data, isLoading } = useQuery<{ channel: ChannelAccount }>({
    queryKey: ["omnichannel-channel", channelId],
    queryFn: () =>
      apiFetch(`/api/omnichannel/channels/${channelId}`) as Promise<{ channel: ChannelAccount }>,
  });

  const channel = data?.channel;

  const saveMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch(`/api/omnichannel/channels/${channelId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["omnichannel-channel", channelId] });
      void queryClient.invalidateQueries({ queryKey: ["omnichannel-channels"] });
      setCredentials({});
      toast({ title: "Credentials saved" });
    },
    onError: () => {
      toast({ title: "Failed to save credentials", variant: "destructive" });
    },
  });

  const testMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/omnichannel/channels/${channelId}/test`, { method: "POST" }) as Promise<{
        result: { success: boolean; message: string };
      }>,
    onSuccess: (res) => {
      toast({
        title: res.result.success ? "Test passed" : "Test failed",
        description: res.result.message,
        variant: res.result.success ? "default" : "destructive",
      });
    },
    onError: () => {
      toast({ title: "Test failed", variant: "destructive" });
    },
  });

  const reconnectMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/omnichannel/channels/${channelId}/reconnect`, { method: "POST" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["omnichannel-channel", channelId] });
      void queryClient.invalidateQueries({ queryKey: ["omnichannel-channels"] });
      toast({ title: "Reconnect initiated", description: "Status reset to Pending." });
    },
    onError: () => {
      toast({ title: "Reconnect failed", variant: "destructive" });
    },
  });

  const disconnectMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/omnichannel/channels/${channelId}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["omnichannel-channels"] });
      toast({ title: "Channel disconnected" });
      navigate("/settings/channels");
    },
    onError: () => {
      toast({ title: "Failed to disconnect", variant: "destructive" });
    },
  });

  const handleSave = () => {
    const patch: Record<string, string> = {};
    for (const field of credentialFields) {
      if (credentials[field.key]?.trim()) {
        patch[field.key] = credentials[field.key].trim();
      }
    }
    if (Object.keys(patch).length === 0) {
      toast({ title: "No changes to save", variant: "destructive" });
      return;
    }
    saveMutation.mutate(patch);
  };

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">Loading…</div>;
  }

  if (!channel) {
    return (
      <div className="text-sm text-destructive">
        Channel not found. <Link href="/settings/channels" className="underline">Go back</Link>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center gap-3">
        <Link href="/settings/channels">
          <Button variant="ghost" size="sm" className="gap-1 -ml-2">
            <ChevronLeft size={15} />
            All Channels
          </Button>
        </Link>
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-3xl">{providerIcon}</span>
          <div>
            <h1 className="text-2xl font-bold">{channel.name}</h1>
            <p className="text-muted-foreground text-sm">{providerLabel} channel</p>
          </div>
        </div>
        <StatusBadge status={channel.status} />
      </div>

      {/* Status card */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Connection Status</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Status</p>
              <StatusBadge status={channel.status} />
            </div>
            <div>
              <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Credentials</p>
              <p>{channel.token_configured ? "✅ Configured" : "⚠️ Not set"}</p>
            </div>
            {channel.last_webhook_received_at && (
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Last webhook</p>
                <p>{formatDistanceToNow(new Date(channel.last_webhook_received_at), { addSuffix: true })}</p>
              </div>
            )}
            {channel.last_outbound_send_at && (
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Last outbound</p>
                <p>{formatDistanceToNow(new Date(channel.last_outbound_send_at), { addSuffix: true })}</p>
              </div>
            )}
          </div>
          {extraStatusNote}
          <div className="flex gap-2 pt-1">
            <Button
              size="sm"
              variant="outline"
              onClick={() => reconnectMutation.mutate()}
              disabled={reconnectMutation.isPending}
            >
              <RefreshCw size={13} className="mr-1.5" />
              Reconnect
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => testMutation.mutate()}
              disabled={testMutation.isPending}
            >
              <Zap size={13} className="mr-1.5" />
              {testMutation.isPending ? "Testing…" : "Send Test Webhook"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Error log */}
      {channel.status === "error" && channel.last_error && (
        <Card className="border-destructive/40">
          <CardHeader className="pb-3">
            <CardTitle className="text-base text-destructive flex items-center gap-2">
              <AlertTriangle size={15} />
              Last Error
            </CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="text-xs bg-destructive/5 rounded p-3 whitespace-pre-wrap break-all border border-destructive/20">
              {channel.last_error}
            </pre>
          </CardContent>
        </Card>
      )}

      {/* Webhook URL card */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Webhook URL</CardTitle>
          <CardDescription>Paste this URL into your {providerLabel} app settings as the webhook callback URL.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <code className="flex-1 bg-muted rounded px-3 py-2 text-xs font-mono break-all">
              {webhookUrl}
            </code>
            <CopyButton value={webhookUrl} />
          </div>
          {channel.webhook_verify_token && (
            <div>
              <p className="text-xs text-muted-foreground mb-1">Verify Token (for Meta hub challenge)</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 bg-muted rounded px-3 py-2 text-xs font-mono break-all">
                  {channel.webhook_verify_token}
                </code>
                <CopyButton value={channel.webhook_verify_token} />
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Credentials form */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Credentials</CardTitle>
          <CardDescription>
            These values are encrypted at rest and never returned by the API. Enter new values to update them.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {credentialFields.map((field) => (
            <div key={field.key} className="space-y-1.5">
              <Label htmlFor={field.key}>{field.label}</Label>
              <Input
                id={field.key}
                type="password"
                placeholder={
                  field.key === "access_token" && channel.token_configured
                    ? "••••••••  (already set — enter new value to update)"
                    : field.key === "refresh_token" && channel.refresh_token_configured
                    ? "••••••••  (already set — enter new value to update)"
                    : field.placeholder
                }
                value={credentials[field.key] ?? ""}
                onChange={(e) => setCredentials((prev) => ({ ...prev, [field.key]: e.target.value }))}
                autoComplete="new-password"
              />
              {field.helpText && (
                <p className="text-xs text-muted-foreground">{field.helpText}</p>
              )}
            </div>
          ))}
          <div className="space-y-1.5">
            <Label htmlFor="webhook_verify_token">Webhook Verify Token</Label>
            <Input
              id="webhook_verify_token"
              type="text"
              placeholder={channel.webhook_verify_token ? channel.webhook_verify_token : "Auto-generated"}
              value={credentials["webhook_verify_token"] ?? ""}
              onChange={(e) => setCredentials((prev) => ({ ...prev, webhook_verify_token: e.target.value }))}
            />
            <p className="text-xs text-muted-foreground">Leave blank to keep the current token.</p>
          </div>
          <Button onClick={handleSave} disabled={saveMutation.isPending}>
            {saveMutation.isPending ? "Saving…" : "Save Credentials"}
          </Button>
        </CardContent>
      </Card>

      {/* Permissions checklist */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Required Permissions</CardTitle>
          <CardDescription>Ensure your app has these permissions in the provider dashboard.</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm">
            {permissions.map((p, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className={p.required ? "text-foreground" : "text-muted-foreground"}>
                  {p.required ? "✅" : "⬜"}
                </span>
                <span className={p.required ? "" : "text-muted-foreground"}>{p.label}</span>
                {p.required && <span className="text-xs text-muted-foreground">(required)</span>}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {/* Setup instructions accordion */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Setup Instructions</CardTitle>
        </CardHeader>
        <CardContent>
          <Accordion type="single" collapsible className="w-full">
            {setupInstructions.map((section, i) => (
              <AccordionItem key={i} value={`section-${i}`}>
                <AccordionTrigger className="text-sm font-medium">{section.title}</AccordionTrigger>
                <AccordionContent>
                  <ol className="list-decimal pl-5 space-y-2 text-sm text-muted-foreground">
                    {section.steps.map((step, j) => (
                      <li key={j}>{step}</li>
                    ))}
                  </ol>
                </AccordionContent>
              </AccordionItem>
            ))}
          </Accordion>
        </CardContent>
      </Card>

      {/* Danger zone */}
      <Card className="border-destructive/30">
        <CardHeader className="pb-3">
          <CardTitle className="text-base text-destructive">Danger Zone</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Disconnect channel</p>
              <p className="text-xs text-muted-foreground">
                Deactivates this channel. Existing conversations are preserved.
              </p>
            </div>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setShowDisconnect(true)}
            >
              Disconnect
            </Button>
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={showDisconnect} onOpenChange={setShowDisconnect}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect {channel.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will deactivate the channel. Existing conversations will be preserved but no new messages will be received. You can reconnect later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive hover:bg-destructive/90"
              onClick={() => disconnectMutation.mutate()}
              disabled={disconnectMutation.isPending}
            >
              {disconnectMutation.isPending ? "Disconnecting…" : "Disconnect"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
