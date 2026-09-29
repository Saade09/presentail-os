import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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
import { useToast } from "@/hooks/use-toast";
import {
  Webhook,
  Plus,
  Trash2,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Copy,
  Check,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { formatDistanceToNow } from "date-fns";

const EVENT_GROUPS: { label: string; events: string[] }[] = [
  {
    label: "Catalog Attributes",
    events: [
      "catalog_attribute.occasion.created",
      "catalog_attribute.occasion.updated",
      "catalog_attribute.occasion.deleted",
      "catalog_attribute.occasion.city_availability_updated",
      "catalog_attribute.catalog_category.created",
      "catalog_attribute.catalog_category.updated",
      "catalog_attribute.catalog_category.deleted",
      "catalog_attribute.catalog_category.city_availability_updated",
      "catalog_attribute.catalog_brand.created",
      "catalog_attribute.catalog_brand.updated",
      "catalog_attribute.catalog_brand.deleted",
      "catalog_attribute.catalog_brand.city_availability_updated",
      "catalog_attribute.recipient.created",
      "catalog_attribute.recipient.updated",
      "catalog_attribute.recipient.deleted",
      "catalog_attribute.recipient.city_availability_updated",
      "catalog_attributes.changed",
    ],
  },
  {
    label: "Delivery & Pricing",
    events: [
      "delivery_config.updated",
      "delivery.city.updated",
      "delivery.timeslots.updated",
      "exchange_rate.updated",
    ],
  },
  {
    label: "Products",
    events: [
      "product.created",
      "product.updated",
      "product.deleted",
      "catalog.products.changed",
    ],
  },
  {
    label: "Orders & Customers",
    events: [
      "order.created",
      "order.updated",
      "order.status_updated",
      "customer.created",
      "customer.updated",
    ],
  },
  {
    label: "Banners",
    events: [
      "banner.updated",
      "catalog.banners.changed",
    ],
  },
];

const ALL_EVENTS = EVENT_GROUPS.flatMap((g) => g.events);

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

type Delivery = {
  id: number;
  event: string;
  status: string;
  response_status: number | null;
  response_body: string | null;
  attempt_count: number;
  created_at: string;
};

function StatusBadge({ status }: { status: string | null }) {
  if (!status) return <Badge variant="outline">No deliveries</Badge>;
  if (status === "delivered") return <Badge className="bg-green-100 text-green-800 border-green-200">Delivered</Badge>;
  if (status === "failed") return <Badge variant="destructive">Failed</Badge>;
  if (status === "pending") return <Badge variant="outline" className="text-yellow-700 bg-yellow-50 border-yellow-200">Pending</Badge>;
  return <Badge variant="outline">{status}</Badge>;
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="ml-1 text-muted-foreground hover:text-foreground"
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
    </button>
  );
}

function DeliveriesPanel({ endpointId }: { endpointId: number }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { data } = useQuery<{ deliveries: Delivery[] }>({
    queryKey: ["webhook-deliveries", endpointId],
    queryFn: () => apiFetch(`/api/webhook-endpoints/${endpointId}/deliveries?limit=20`),
  });

  const retryMutation = useMutation({
    mutationFn: (deliveryId: number) =>
      apiFetch(`/api/webhook-endpoints/${endpointId}/deliveries/${deliveryId}/retry`, { method: "POST" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["webhook-deliveries", endpointId] });
      void queryClient.invalidateQueries({ queryKey: ["webhook-endpoints"] });
      toast({ title: "Retry queued" });
    },
    onError: () => toast({ title: "Retry failed", variant: "destructive" }),
  });

  const deliveries = data?.deliveries ?? [];
  if (deliveries.length === 0) {
    return <p className="text-sm text-muted-foreground py-2">No deliveries yet.</p>;
  }

  return (
    <div className="mt-2 space-y-1">
      {deliveries.map((d) => (
        <div key={d.id} className="flex items-center gap-2 text-xs p-2 rounded bg-muted/40">
          <span className="flex-1 font-mono truncate">{d.event}</span>
          <StatusBadge status={d.status} />
          {d.response_status && (
            <span className="text-muted-foreground">HTTP {d.response_status}</span>
          )}
          <span className="text-muted-foreground">
            {formatDistanceToNow(new Date(d.created_at), { addSuffix: true })}
          </span>
          {d.status === "failed" && (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-xs"
              onClick={() => retryMutation.mutate(d.id)}
              disabled={retryMutation.isPending}
            >
              <RefreshCw size={12} className="mr-1" /> Retry
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}

function EndpointRow({
  ep,
  onDelete,
}: {
  ep: WebhookEndpoint;
  onDelete: (id: number) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border rounded-lg p-4 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-sm">{ep.name}</span>
            <StatusBadge status={ep.last_delivery_status} />
            {!ep.is_active && <Badge variant="secondary">Inactive</Badge>}
          </div>
          <div className="flex items-center text-xs text-muted-foreground mt-0.5">
            <span className="font-mono truncate max-w-[400px]">{ep.endpoint_url}</span>
            <CopyButton value={ep.endpoint_url} />
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            {ep.subscribed_events.length === ALL_EVENTS.length
              ? "All events"
              : `${ep.subscribed_events.length} event${ep.subscribed_events.length !== 1 ? "s" : ""}`}
            {ep.last_delivery_at && (
              <> · Last delivery {formatDistanceToNow(new Date(ep.last_delivery_at), { addSuffix: true })}</>
            )}
          </p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={() => setExpanded((v) => !v)}
            title="Show deliveries"
          >
            {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0 text-destructive hover:text-destructive"
            onClick={() => onDelete(ep.id)}
            title="Delete endpoint"
          >
            <Trash2 size={16} />
          </Button>
        </div>
      </div>
      {expanded && <DeliveriesPanel endpointId={ep.id} />}
    </div>
  );
}

export default function WebhookEndpointsPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [createOpen, setCreateOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [newSecret, setNewSecret] = useState<string | null>(null);

  const [form, setForm] = useState({
    name: "",
    endpoint_url: "",
    subscribed_events: [] as string[],
    all_events: true,
  });

  const { data, isLoading } = useQuery<{ endpoints: WebhookEndpoint[] }>({
    queryKey: ["webhook-endpoints"],
    queryFn: () => apiFetch("/api/webhook-endpoints"),
  });

  const createMutation = useMutation({
    mutationFn: (body: object) =>
      apiFetch("/api/webhook-endpoints", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }) as Promise<{ endpoint: WebhookEndpoint; signing_secret: string }>,
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ["webhook-endpoints"] });
      setCreateOpen(false);
      setNewSecret(res.signing_secret);
      setForm({ name: "", endpoint_url: "", subscribed_events: [], all_events: true });
    },
    onError: () => toast({ title: "Failed to create webhook endpoint", variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/webhook-endpoints/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["webhook-endpoints"] });
      toast({ title: "Webhook endpoint deleted" });
    },
    onError: () => toast({ title: "Failed to delete webhook endpoint", variant: "destructive" }),
  });

  const endpoints = data?.endpoints ?? [];

  function handleCreate() {
    const events = form.all_events ? [...ALL_EVENTS] : form.subscribed_events;
    createMutation.mutate({ name: form.name.trim(), endpoint_url: form.endpoint_url.trim(), subscribed_events: events });
  }

  function toggleEvent(event: string) {
    setForm((f) => ({
      ...f,
      subscribed_events: f.subscribed_events.includes(event)
        ? f.subscribed_events.filter((e) => e !== event)
        : [...f.subscribed_events, event],
    }));
  }

  return (
    <div className="max-w-3xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Webhook size={22} />
          <div>
            <h1 className="text-xl font-semibold">{t("nav.webhookEndpoints")}</h1>
            <p className="text-sm text-muted-foreground">Receive HTTP notifications when catalog attributes change.</p>
          </div>
        </div>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus size={16} className="mr-1" /> Add endpoint
        </Button>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : endpoints.length === 0 ? (
        <div className="text-center py-12 text-muted-foreground">
          <Webhook size={32} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">No webhook endpoints yet.</p>
          <p className="text-xs mt-1">Add an endpoint to start receiving event notifications.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {endpoints.map((ep) => (
            <EndpointRow key={ep.id} ep={ep} onDelete={setDeleteId} />
          ))}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Add webhook endpoint</DialogTitle>
            <DialogDescription>
              Choose a URL and the events you want to subscribe to. You'll receive the signing secret once on creation.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1">
              <Label>Name</Label>
              <Input
                placeholder="e.g. My integration"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label>Endpoint URL</Label>
              <Input
                placeholder="https://example.com/webhooks/catalog"
                value={form.endpoint_url}
                onChange={(e) => setForm((f) => ({ ...f, endpoint_url: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <Label>Events</Label>
                <button
                  type="button"
                  className="text-xs text-primary underline"
                  onClick={() => setForm((f) => ({ ...f, all_events: !f.all_events, subscribed_events: [] }))}
                >
                  {form.all_events ? "Choose specific events" : "Subscribe to all events"}
                </button>
              </div>
              {form.all_events ? (
                <p className="text-xs text-muted-foreground">All events will be sent to this endpoint.</p>
              ) : (
                <div className="space-y-3 max-h-60 overflow-y-auto pr-1">
                  {EVENT_GROUPS.map((group) => (
                    <div key={group.label}>
                      <p className="text-xs font-semibold text-muted-foreground mb-1">{group.label}</p>
                      <div className="grid grid-cols-1 gap-0.5">
                        {group.events.map((event) => (
                          <label key={event} className="flex items-center gap-2 text-xs cursor-pointer py-0.5">
                            <input
                              type="checkbox"
                              checked={form.subscribed_events.includes(event)}
                              onChange={() => toggleEvent(event)}
                              className="accent-primary"
                            />
                            <span className="font-mono">{event}</span>
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button
              onClick={handleCreate}
              disabled={!form.name.trim() || !form.endpoint_url.trim() || createMutation.isPending}
            >
              {createMutation.isPending ? "Creating…" : "Create endpoint"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteId !== null} onOpenChange={(open) => !open && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete webhook endpoint?</AlertDialogTitle>
            <AlertDialogDescription>
              This will permanently remove the endpoint and all its delivery history. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => { if (deleteId !== null) { deleteMutation.mutate(deleteId); setDeleteId(null); } }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={newSecret !== null} onOpenChange={(open) => !open && setNewSecret(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Webhook endpoint created</DialogTitle>
            <DialogDescription>
              Copy the signing secret below. It will not be shown again.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 bg-muted rounded p-3 font-mono text-sm break-all">
            <span className="flex-1">{newSecret}</span>
            <CopyButton value={newSecret ?? ""} />
          </div>
          <p className="text-xs text-muted-foreground">
            Use this secret to verify the <code>x-presentail-signature</code> header on incoming webhook requests.
          </p>
          <DialogFooter>
            <Button onClick={() => setNewSecret(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
