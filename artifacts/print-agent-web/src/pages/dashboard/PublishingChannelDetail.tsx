import { useState } from "react";
import { Link, useParams } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import {
  ArrowLeft,
  Rss,
  Key,
  Webhook,
  Package,
  Copy,
  Check,
  Plus,
  Trash2,
  Eye,
  EyeOff,
  Globe,
  Loader2,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  History,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { formatDistanceToNow } from "date-fns";

type Channel = {
  id: number;
  name: string;
  slug: string;
  type: string;
  brand_id: number | null;
  status: string;
  default_currency: string;
  auto_publish_new_products: boolean;
  allowed_origins: string | null;
  created_at: string;
  updated_at: string;
};

type ApiKey = {
  id: number;
  name: string;
  key_prefix: string;
  channel_id: number;
  status: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
};

type WebhookEndpoint = {
  id: number;
  name: string;
  endpoint_url: string;
  subscribed_events: string[];
  is_active: boolean;
  last_delivery_status: string | null;
  last_delivery_at: string | null;
  created_at: string;
};

type WebhookDelivery = {
  id: string;
  event: string;
  payload: unknown;
  status: string;
  response_status: number | null;
  response_body: string | null;
  attempt_count: number;
  next_retry_at: string | null;
  duration_ms: number | null;
  created_at: string;
};

type ChannelProduct = {
  id: number;
  product_id: number;
  name: string;
  brand: string | null;
  product_status: string;
  publication_status: string;
  is_visible: boolean;
  featured: boolean;
  published_at: string | null;
};

const PRODUCT_EVENTS = [
  "product.created",
  "product.updated",
  "product.price_updated",
  "product.hidden",
  "product.unhidden",
  "product.published",
  "product.unpublished",
  "product.availability_updated",
  "product.images_updated",
];

const CURRENCIES = ["USD", "AED", "EUR", "GBP", "SAR"];

function deliveryStatusBadge(status: string) {
  if (status === "delivered") return <Badge variant="default" className="text-xs bg-green-600">delivered</Badge>;
  if (status === "failed") return <Badge variant="destructive" className="text-xs">failed</Badge>;
  if (status === "pending_retry") return <Badge variant="secondary" className="text-xs">retrying</Badge>;
  return <Badge variant="secondary" className="text-xs">{status}</Badge>;
}

function WebhookDeliveryHistory({
  channelId,
  endpointId,
  isOwner,
}: {
  channelId: number;
  endpointId: number;
  isOwner: boolean;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [expandedDeliveryId, setExpandedDeliveryId] = useState<string | null>(null);

  const { data, isLoading, isFetching } = useQuery<{ deliveries: WebhookDelivery[] }>({
    queryKey: ["webhook-deliveries", channelId, endpointId],
    queryFn: () => apiFetch(`/api/publishing-channels/${channelId}/webhook-endpoints/${endpointId}/deliveries`),
  });

  const retryMut = useMutation({
    mutationFn: (deliveryId: string) =>
      apiFetch(`/api/publishing-channels/${channelId}/webhook-endpoints/${endpointId}/deliveries/${deliveryId}/retry`, {
        method: "POST",
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["webhook-deliveries", channelId, endpointId] });
      void qc.invalidateQueries({ queryKey: ["publishing-channel-webhooks", channelId] });
      toast({ title: "Retry queued" });
    },
  });

  const deliveries = data?.deliveries ?? [];

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-4 px-3 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading delivery history…
      </div>
    );
  }

  if (deliveries.length === 0) {
    return (
      <div className="py-4 px-3 text-sm text-muted-foreground text-center">
        No deliveries yet for this endpoint.
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between px-3 py-1.5">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Last {deliveries.length} deliveries</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0"
          disabled={isFetching}
          onClick={() => void qc.invalidateQueries({ queryKey: ["webhook-deliveries", channelId, endpointId] })}
        >
          <RefreshCw className={`h-3 w-3 ${isFetching ? "animate-spin" : ""}`} />
        </Button>
      </div>
      <div className="divide-y">
        {deliveries.map((d) => {
          const isExpanded = expandedDeliveryId === d.id;
          return (
            <div key={d.id}>
              <div
                role="button"
                tabIndex={0}
                className="w-full flex items-center gap-3 px-3 py-2 text-sm text-left hover:bg-muted/40 transition-colors cursor-pointer"
                onClick={() => setExpandedDeliveryId(isExpanded ? null : d.id)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setExpandedDeliveryId(isExpanded ? null : d.id); } }}
              >
                <span className="font-mono text-xs text-muted-foreground shrink-0 w-28">
                  {formatDistanceToNow(new Date(d.created_at), { addSuffix: true })}
                </span>
                <span className="font-mono text-xs truncate flex-1">{d.event}</span>
                {d.response_status !== null && (
                  <span className={`text-xs font-mono shrink-0 ${d.response_status >= 200 && d.response_status < 300 ? "text-green-600" : "text-destructive"}`}>
                    {d.response_status}
                  </span>
                )}
                {d.duration_ms !== null && (
                  <span className="text-xs text-muted-foreground shrink-0 tabular-nums">
                    {d.duration_ms < 1000 ? `${d.duration_ms}ms` : `${(d.duration_ms / 1000).toFixed(1)}s`}
                  </span>
                )}
                {deliveryStatusBadge(d.status)}
                {isOwner && d.status === "failed" && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 px-2 text-xs shrink-0"
                    disabled={retryMut.isPending}
                    onClick={(e) => { e.stopPropagation(); retryMut.mutate(d.id); }}
                  >
                    <RefreshCw className="h-3 w-3 mr-1" /> Retry
                  </Button>
                )}
                {isExpanded ? (
                  <ChevronUp className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                )}
              </div>
              {isExpanded && (
                <div className="px-3 pb-3 pt-1 bg-muted/20 space-y-3">
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-1.5">Request payload</p>
                    {d.payload != null ? (
                      (() => {
                        let display: string;
                        try {
                          display = JSON.stringify(d.payload, null, 2);
                        } catch {
                          display = String(d.payload);
                        }
                        return (
                          <div className="relative group">
                            <pre className="text-xs font-mono bg-muted rounded p-2.5 overflow-x-auto whitespace-pre-wrap break-all max-h-48">
                              {display}
                            </pre>
                            <div className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                              <CopyButton text={display} />
                            </div>
                          </div>
                        );
                      })()
                    ) : (
                      <p className="text-xs text-muted-foreground italic">No payload recorded</p>
                    )}
                  </div>
                  <div>
                    <p className="text-xs font-medium text-muted-foreground mb-1.5">Response body</p>
                    {d.response_body ? (
                      (() => {
                        let display = d.response_body;
                        try {
                          display = JSON.stringify(JSON.parse(d.response_body), null, 2);
                        } catch {
                          // not JSON — render verbatim
                        }
                        return (
                          <div className="relative group">
                            <pre className="text-xs font-mono bg-muted rounded p-2.5 overflow-x-auto whitespace-pre-wrap break-all max-h-48">
                              {display}
                            </pre>
                            <div className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                              <CopyButton text={display} />
                            </div>
                          </div>
                        );
                      })()
                    ) : (
                      <p className="text-xs text-muted-foreground italic">No response captured</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      variant="ghost"
      size="sm"
      className="h-6 w-6 p-0"
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check className="h-3 w-3 text-green-600" /> : <Copy className="h-3 w-3" />}
    </Button>
  );
}

export default function PublishingChannelDetail() {
  const { id } = useParams<{ id: string }>();
  const channelId = parseInt(id ?? "", 10);
  const qc = useQueryClient();
  const { toast } = useToast();
  const { realIsOwner } = useWorkspaceRole();

  const [editOpen, setEditOpen] = useState(false);
  const [newKeyOpen, setNewKeyOpen] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [revealedKeyId, setRevealedKeyId] = useState<number | null>(null);
  const [revokeKeyId, setRevokeKeyId] = useState<number | null>(null);
  const [newWebhookOpen, setNewWebhookOpen] = useState(false);
  const [webhookForm, setWebhookForm] = useState({ name: "", endpoint_url: "", subscribed_events: [] as string[], is_active: true });
  const [deleteWebhookId, setDeleteWebhookId] = useState<number | null>(null);
  const [expandedWebhookId, setExpandedWebhookId] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<Partial<Channel>>({});

  const { data: channelData, isLoading } = useQuery<{ channel: Channel }>({
    queryKey: ["publishing-channel", channelId],
    queryFn: () => apiFetch(`/api/publishing-channels/${channelId}`),
    enabled: !isNaN(channelId),
  });

  const { data: keysData } = useQuery<{ api_keys: ApiKey[] }>({
    queryKey: ["publishing-channel-api-keys", channelId],
    queryFn: () => apiFetch(`/api/publishing-channels/${channelId}/api-keys`),
    enabled: !isNaN(channelId),
  });

  const { data: webhooksData } = useQuery<{ endpoints: WebhookEndpoint[] }>({
    queryKey: ["publishing-channel-webhooks", channelId],
    queryFn: () => apiFetch(`/api/publishing-channels/${channelId}/webhook-endpoints`),
    enabled: !isNaN(channelId),
  });

  const { data: productsData } = useQuery<{ products: ChannelProduct[] }>({
    queryKey: ["publishing-channel-products", channelId],
    queryFn: () => apiFetch(`/api/publishing-channels/${channelId}/products`),
    enabled: !isNaN(channelId),
  });

  const updateMut = useMutation({
    mutationFn: (body: Partial<Channel>) =>
      apiFetch(`/api/publishing-channels/${channelId}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["publishing-channel", channelId] });
      qc.invalidateQueries({ queryKey: ["publishing-channels"] });
      setEditOpen(false);
      toast({ title: "Channel updated" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const createKeyMut = useMutation({
    mutationFn: () =>
      apiFetch(`/api/publishing-channels/${channelId}/api-keys`, { method: "POST", body: JSON.stringify({ name: newKeyName }) }),
    onSuccess: (data: { api_key: ApiKey; plaintext_key: string }) => {
      qc.invalidateQueries({ queryKey: ["publishing-channel-api-keys", channelId] });
      setNewKeyOpen(false);
      setNewKeyName("");
      setRevealedKey(data.plaintext_key);
      setRevealedKeyId(data.api_key.id);
      toast({ title: "API key created — copy it now!" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const revokeKeyMut = useMutation({
    mutationFn: (kid: number) =>
      apiFetch(`/api/publishing-channels/${channelId}/api-keys/${kid}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["publishing-channel-api-keys", channelId] });
      setRevokeKeyId(null);
      toast({ title: "API key revoked" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const createWebhookMut = useMutation({
    mutationFn: () =>
      apiFetch(`/api/publishing-channels/${channelId}/webhook-endpoints`, {
        method: "POST",
        body: JSON.stringify(webhookForm),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["publishing-channel-webhooks", channelId] });
      setNewWebhookOpen(false);
      setWebhookForm({ name: "", endpoint_url: "", subscribed_events: [], is_active: true });
      toast({ title: "Webhook endpoint created" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const deleteWebhookMut = useMutation({
    mutationFn: (wid: number) =>
      apiFetch(`/api/publishing-channels/${channelId}/webhook-endpoints/${wid}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["publishing-channel-webhooks", channelId] });
      setDeleteWebhookId(null);
      toast({ title: "Webhook endpoint removed" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  if (isLoading) return <div className="flex items-center justify-center h-64 text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  const channel = channelData?.channel;
  if (!channel) return <div className="p-8 text-muted-foreground">Channel not found.</div>;

  const apiKeys = keysData?.api_keys ?? [];
  const webhooks = webhooksData?.endpoints ?? [];
  const products = productsData?.products ?? [];

  const activeKeys = apiKeys.filter((k) => k.status === "active");
  const revokedKeys = apiKeys.filter((k) => k.status !== "active");

  return (
    <div className="max-w-4xl mx-auto py-8 px-4 space-y-6">
      <div className="flex items-center gap-2">
        <Link href="/publishing-channels">
          <a className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-4 w-4" /> Channels
          </a>
        </Link>
      </div>

      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-3">
          <div className="p-2 rounded-lg bg-primary/10 mt-0.5">
            <Rss className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold">{channel.name}</h1>
            <div className="flex items-center gap-2 mt-1 text-sm text-muted-foreground">
              <span className="font-mono">{channel.slug}</span>
              <span>·</span>
              <span>{channel.type}</span>
              <span>·</span>
              <span className={channel.status === "active" ? "text-green-600 font-medium" : "text-muted-foreground"}>
                {channel.status}
              </span>
            </div>
          </div>
        </div>
        {realIsOwner && (
          <Button variant="outline" onClick={() => {
            setEditForm({
              name: channel.name,
              status: channel.status,
              default_currency: channel.default_currency,
              auto_publish_new_products: channel.auto_publish_new_products,
              allowed_origins: channel.allowed_origins ?? "",
            });
            setEditOpen(true);
          }}>Edit</Button>
        )}
      </div>

      <Tabs defaultValue="products">
        <TabsList>
          <TabsTrigger value="products" className="gap-1.5">
            <Package className="h-4 w-4" /> Products <Badge variant="secondary" className="text-xs">{products.length}</Badge>
          </TabsTrigger>
          <TabsTrigger value="api-keys" className="gap-1.5">
            <Key className="h-4 w-4" /> API Keys <Badge variant="secondary" className="text-xs">{activeKeys.length}</Badge>
          </TabsTrigger>
          <TabsTrigger value="webhooks" className="gap-1.5">
            <Webhook className="h-4 w-4" /> Webhooks <Badge variant="secondary" className="text-xs">{webhooks.length}</Badge>
          </TabsTrigger>
        </TabsList>

        {/* Products Tab */}
        <TabsContent value="products" className="mt-4">
          <div className="space-y-2">
            {products.length === 0 ? (
              <div className="border border-dashed rounded-xl p-10 text-center text-muted-foreground">
                <Package className="h-8 w-8 mx-auto mb-2 opacity-40" />
                <p>No products published to this channel yet.</p>
                <p className="text-sm mt-1">Use the Publishing tab on a product's detail page to publish it here.</p>
              </div>
            ) : (
              <div className="rounded-lg border divide-y">
                {products.map((p) => (
                  <Link key={p.id} href={`/products/${p.product_id}`}>
                    <a className="flex items-center justify-between px-4 py-3 hover:bg-muted/50 transition-colors">
                      <div>
                        <p className="font-medium text-sm">{p.name}</p>
                        <p className="text-xs text-muted-foreground">{p.brand ?? "—"} · {p.product_status}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <Badge
                          variant={p.publication_status === "published" ? "default" : "secondary"}
                          className="text-xs"
                        >
                          {p.publication_status}
                        </Badge>
                        {!p.is_visible && (
                          <Badge variant="outline" className="text-xs gap-1">
                            <EyeOff className="h-3 w-3" /> hidden
                          </Badge>
                        )}
                      </div>
                    </a>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </TabsContent>

        {/* API Keys Tab */}
        <TabsContent value="api-keys" className="mt-4 space-y-4">
          {realIsOwner && (
            <div className="flex justify-end">
              <Button size="sm" onClick={() => { setNewKeyName(""); setNewKeyOpen(true); }}>
                <Plus className="h-4 w-4 mr-1" /> Create API Key
              </Button>
            </div>
          )}

          {revealedKey && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 dark:bg-amber-950/20 p-4 space-y-2">
              <p className="text-sm font-semibold text-amber-800 dark:text-amber-400">
                Copy your API key — it will not be shown again.
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-xs bg-white dark:bg-black rounded px-3 py-2 border font-mono break-all">
                  {revealedKey}
                </code>
                <CopyButton text={revealedKey} />
              </div>
              <Button size="sm" variant="outline" onClick={() => { setRevealedKey(null); setRevealedKeyId(null); }}>
                I've saved it
              </Button>
            </div>
          )}

          {activeKeys.length === 0 && !revealedKey ? (
            <div className="border border-dashed rounded-xl p-8 text-center text-muted-foreground">
              <Key className="h-7 w-7 mx-auto mb-2 opacity-40" />
              <p>No active API keys.</p>
            </div>
          ) : (
            <div className="rounded-lg border divide-y">
              {activeKeys.map((k) => (
                <div key={k.id} className="flex items-center justify-between px-4 py-3">
                  <div>
                    <p className="font-medium text-sm">{k.name}</p>
                    <p className="text-xs text-muted-foreground font-mono">{k.key_prefix}…</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Created {formatDistanceToNow(new Date(k.created_at), { addSuffix: true })}
                      {k.last_used_at && ` · Last used ${formatDistanceToNow(new Date(k.last_used_at), { addSuffix: true })}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {k.id === revealedKeyId && revealedKey && <CopyButton text={revealedKey} />}
                    {realIsOwner && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:text-destructive"
                        onClick={() => setRevokeKeyId(k.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {revokedKeys.length > 0 && (
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                {revokedKeys.length} revoked key{revokedKeys.length !== 1 ? "s" : ""}
              </summary>
              <div className="rounded-lg border divide-y mt-2 opacity-60">
                {revokedKeys.map((k) => (
                  <div key={k.id} className="flex items-center justify-between px-4 py-3">
                    <div>
                      <p className="font-medium text-sm line-through">{k.name}</p>
                      <p className="text-xs text-muted-foreground font-mono">{k.key_prefix}…</p>
                    </div>
                    <Badge variant="secondary" className="text-xs">Revoked</Badge>
                  </div>
                ))}
              </div>
            </details>
          )}
        </TabsContent>

        {/* Webhooks Tab */}
        <TabsContent value="webhooks" className="mt-4 space-y-4">
          {realIsOwner && (
            <div className="flex justify-end">
              <Button size="sm" onClick={() => setNewWebhookOpen(true)}>
                <Plus className="h-4 w-4 mr-1" /> Add Endpoint
              </Button>
            </div>
          )}
          {webhooks.length === 0 ? (
            <div className="border border-dashed rounded-xl p-8 text-center text-muted-foreground">
              <Webhook className="h-7 w-7 mx-auto mb-2 opacity-40" />
              <p>No webhook endpoints configured.</p>
            </div>
          ) : (
            <div className="rounded-lg border divide-y">
              {webhooks.map((w) => (
                <div key={w.id}>
                  <div className="flex items-start justify-between gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium text-sm">{w.name}</span>
                        <Badge variant={w.is_active ? "default" : "secondary"} className="text-xs">
                          {w.is_active ? "Active" : "Inactive"}
                        </Badge>
                        {w.last_delivery_status && (
                          <span>{deliveryStatusBadge(w.last_delivery_status)}</span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground font-mono truncate mt-0.5">{w.endpoint_url}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {w.subscribed_events.length} event{w.subscribed_events.length !== 1 ? "s" : ""}
                        {w.last_delivery_at && ` · Last delivery ${formatDistanceToNow(new Date(w.last_delivery_at), { addSuffix: true })}`}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-8 px-2 text-xs gap-1"
                        onClick={() => setExpandedWebhookId(expandedWebhookId === w.id ? null : w.id)}
                      >
                        <History className="h-3.5 w-3.5" />
                        {expandedWebhookId === w.id ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                      </Button>
                      {realIsOwner && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-destructive hover:text-destructive h-8 w-8 p-0"
                          onClick={() => setDeleteWebhookId(w.id)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </div>
                  </div>
                  {expandedWebhookId === w.id && (
                    <div className="border-t bg-muted/30">
                      <WebhookDeliveryHistory
                        channelId={channelId}
                        endpointId={w.id}
                        isOwner={realIsOwner}
                      />
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* Edit Channel Dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Channel</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input
                value={editForm.name ?? ""}
                onChange={(e) => setEditForm((p) => ({ ...p, name: e.target.value }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Status</Label>
              <Select value={editForm.status} onValueChange={(v) => setEditForm((p) => ({ ...p, status: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">Active</SelectItem>
                  <SelectItem value="inactive">Inactive</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Default Currency</Label>
              <Select value={editForm.default_currency} onValueChange={(v) => setEditForm((p) => ({ ...p, default_currency: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CURRENCIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between py-1">
              <div>
                <p className="text-sm font-medium">Auto-publish new products</p>
              </div>
              <Switch
                checked={editForm.auto_publish_new_products ?? false}
                onCheckedChange={(v) => setEditForm((p) => ({ ...p, auto_publish_new_products: v }))}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="allowed-origins">Allowed Origins (CORS)</Label>
              <Input
                id="allowed-origins"
                value={editForm.allowed_origins ?? ""}
                onChange={(e) => setEditForm((p) => ({ ...p, allowed_origins: e.target.value }))}
                placeholder="https://example.com,https://shop.example.com"
              />
              <p className="text-xs text-muted-foreground">Comma-separated list of allowed origins.</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>Cancel</Button>
            <Button
              disabled={updateMut.isPending}
              onClick={() => updateMut.mutate(editForm)}
            >
              {updateMut.isPending ? "Saving…" : "Save Changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create API Key Dialog */}
      <Dialog open={newKeyOpen} onOpenChange={setNewKeyOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create API Key</DialogTitle>
            <DialogDescription>
              This key will provide read-only access to this channel's catalog via the public API.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label>Key Name</Label>
              <Input
                value={newKeyName}
                onChange={(e) => setNewKeyName(e.target.value)}
                placeholder="e.g. Production Website"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewKeyOpen(false)}>Cancel</Button>
            <Button
              disabled={createKeyMut.isPending || !newKeyName.trim()}
              onClick={() => createKeyMut.mutate()}
            >
              {createKeyMut.isPending ? "Creating…" : "Create Key"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revoke Key Confirm */}
      <AlertDialog open={revokeKeyId !== null} onOpenChange={(o) => !o && setRevokeKeyId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke API Key?</AlertDialogTitle>
            <AlertDialogDescription>
              Any requests using this key will immediately stop working. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground"
              onClick={() => revokeKeyId !== null && revokeKeyMut.mutate(revokeKeyId)}
            >
              Revoke
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Add Webhook Dialog */}
      <Dialog open={newWebhookOpen} onOpenChange={setNewWebhookOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Add Webhook Endpoint</DialogTitle>
            <DialogDescription>Receive HTTP POST events when products in this channel change.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Name</Label>
              <Input
                value={webhookForm.name}
                onChange={(e) => setWebhookForm((p) => ({ ...p, name: e.target.value }))}
                placeholder="My webhook"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Endpoint URL</Label>
              <Input
                value={webhookForm.endpoint_url}
                onChange={(e) => setWebhookForm((p) => ({ ...p, endpoint_url: e.target.value }))}
                placeholder="https://your-server.com/webhook"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Events to subscribe</Label>
              <div className="rounded-lg border divide-y max-h-48 overflow-y-auto">
                {PRODUCT_EVENTS.map((ev) => (
                  <label key={ev} className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-muted/50">
                    <input
                      type="checkbox"
                      checked={webhookForm.subscribed_events.includes(ev)}
                      onChange={(e) => setWebhookForm((p) => ({
                        ...p,
                        subscribed_events: e.target.checked
                          ? [...p.subscribed_events, ev]
                          : p.subscribed_events.filter((x) => x !== ev),
                      }))}
                      className="h-4 w-4 rounded border"
                    />
                    <span className="text-sm font-mono">{ev}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewWebhookOpen(false)}>Cancel</Button>
            <Button
              disabled={createWebhookMut.isPending || !webhookForm.name.trim() || !webhookForm.endpoint_url.trim()}
              onClick={() => createWebhookMut.mutate()}
            >
              {createWebhookMut.isPending ? "Adding…" : "Add Endpoint"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Webhook Confirm */}
      <AlertDialog open={deleteWebhookId !== null} onOpenChange={(o) => !o && setDeleteWebhookId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove Webhook?</AlertDialogTitle>
            <AlertDialogDescription>The endpoint will no longer receive product events.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground"
              onClick={() => deleteWebhookId !== null && deleteWebhookMut.mutate(deleteWebhookId)}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
