import { useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  Rss,
  ExternalLink,
  Globe,
  Eye,
  EyeOff,
  Plus,
  Loader2,
  CheckCircle2,
  Clock,
  XCircle,
  Star,
  ChevronDown,
  ChevronUp,
  RefreshCw,
  AlertCircle,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";

type SyncLog = {
  id: number;
  product_id: number;
  channel_id: number;
  event_type: string;
  status: string;
  message: string | null;
  created_at: string;
};

type Publication = {
  id: number;
  channel_id: number;
  channel_name: string;
  channel_slug: string;
  channel_type: string;
  channel_status: string;
  publication_status: string;
  is_visible: boolean;
  featured: boolean;
  public_slug: string | null;
  public_title: string | null;
  price_override: string | null;
  sale_price_override: string | null;
  published_at: string | null;
  sync_status: string;
  sync_error: string | null;
  last_synced_at: string | null;
};

type Channel = {
  id: number;
  name: string;
  slug: string;
  status: string;
};

function pubStatusBadge(status: string, isVisible: boolean) {
  if (status === "published" && isVisible) {
    return (
      <Badge className="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 border-0 gap-1 text-xs">
        <CheckCircle2 className="h-3 w-3" /> Published
      </Badge>
    );
  }
  if (status === "published" && !isVisible) {
    return (
      <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 border-0 gap-1 text-xs">
        <EyeOff className="h-3 w-3" /> Hidden
      </Badge>
    );
  }
  if (status === "draft") {
    return (
      <Badge variant="secondary" className="gap-1 text-xs">
        <Clock className="h-3 w-3" /> Draft
      </Badge>
    );
  }
  if (status === "archived") {
    return (
      <Badge variant="secondary" className="gap-1 text-xs">
        <XCircle className="h-3 w-3" /> Archived
      </Badge>
    );
  }
  return <Badge variant="outline" className="text-xs">{status}</Badge>;
}

function syncStatusBadge(status: string) {
  if (status === "ok" || status === "synced") {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
        <CheckCircle2 className="h-3 w-3" /> ok
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs text-destructive">
      <XCircle className="h-3 w-3" /> error
    </span>
  );
}

const DEFAULT_PUB_FORM = {
  publication_status: "published",
  is_visible: true,
  featured: false,
  public_slug: "",
  public_title: "",
  price_override: "",
  sale_price_override: "",
};

function SyncLogSection({
  pub,
  logs,
  canManage,
  productId,
}: {
  pub: Publication;
  logs: SyncLog[];
  canManage: boolean;
  productId: number;
}) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const { toast } = useToast();

  const channelLogs = logs
    .filter((l) => l.channel_id === pub.channel_id)
    .slice(0, 5);

  const hasSyncError = pub.sync_status === "error";

  const retryMut = useMutation({
    mutationFn: () =>
      apiFetch(`/api/products/${productId}/publications/${pub.channel_id}/retry-sync`, {
        method: "POST",
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["product-publications", productId] });
      toast({ title: "Sync retried successfully" });
    },
    onError: (e: Error) =>
      toast({ title: "Retry failed", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="border-t pt-2 mt-1">
      {hasSyncError && (
        <div className="flex items-start gap-2 mb-2 p-2.5 rounded-md bg-destructive/10 text-destructive text-xs">
          <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="font-medium">Sync failed</p>
            {pub.sync_error && (
              <p className="mt-0.5 break-all opacity-80">{pub.sync_error}</p>
            )}
          </div>
          {canManage && (
            <Button
              variant="outline"
              size="sm"
              className="h-6 px-2 text-xs shrink-0 border-destructive/40 text-destructive hover:bg-destructive hover:text-destructive-foreground"
              disabled={retryMut.isPending}
              onClick={() => retryMut.mutate()}
            >
              {retryMut.isPending ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3 mr-1" />
              )}
              Retry sync
            </Button>
          )}
        </div>
      )}

      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        {open ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
        Sync history
        {channelLogs.length > 0 && (
          <span className="ml-0.5 text-muted-foreground/60">({channelLogs.length})</span>
        )}
        {!hasSyncError && canManage && (
          <Button
            variant="ghost"
            size="sm"
            className="h-5 px-1.5 ml-2 text-xs gap-1"
            disabled={retryMut.isPending}
            onClick={(e) => {
              e.stopPropagation();
              retryMut.mutate();
            }}
          >
            {retryMut.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            Retry
          </Button>
        )}
      </button>

      {open && (
        <div className="mt-2 space-y-1">
          {channelLogs.length === 0 ? (
            <p className="text-xs text-muted-foreground pl-1">No sync history yet.</p>
          ) : (
            channelLogs.map((log) => (
              <div
                key={log.id}
                className="flex items-start gap-2 text-xs py-1.5 px-2 rounded bg-muted/50"
              >
                <span className="shrink-0 mt-px">{syncStatusBadge(log.status)}</span>
                <span className="shrink-0 text-muted-foreground font-mono whitespace-nowrap">
                  {formatDistanceToNow(new Date(log.created_at), { addSuffix: true })}
                </span>
                <span className="text-muted-foreground font-medium capitalize shrink-0">
                  {log.event_type.replace(/_/g, " ")}
                </span>
                {log.message && (
                  <span className="text-muted-foreground/70 truncate">{log.message}</span>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function ProductPublishingTab({
  productId,
  canManage,
}: {
  productId: number;
  canManage: boolean;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [addOpen, setAddOpen] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [selectedChannelId, setSelectedChannelId] = useState<string>("");
  const [pubForm, setPubForm] = useState({ ...DEFAULT_PUB_FORM });
  const [editForm, setEditForm] = useState({ ...DEFAULT_PUB_FORM });

  const { data, isLoading } = useQuery<{ publications: Publication[]; sync_logs: SyncLog[] }>({
    queryKey: ["product-publications", productId],
    queryFn: () => apiFetch(`/api/products/${productId}/publications`),
  });

  const { data: channelsData } = useQuery<{ channels: Channel[] }>({
    queryKey: ["publishing-channels"],
    queryFn: () => apiFetch("/api/publishing-channels"),
  });

  const publications = data?.publications ?? [];
  const syncLogs = data?.sync_logs ?? [];
  const channels = channelsData?.channels ?? [];
  const publishedChannelIds = new Set(publications.map((p) => p.channel_id));
  const unpublishedChannels = channels.filter(
    (ch) => ch.status === "active" && !publishedChannelIds.has(ch.id),
  );

  const addMut = useMutation({
    mutationFn: (body: typeof pubForm & { channel_id: number }) =>
      apiFetch(`/api/products/${productId}/publications`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["product-publications", productId] });
      qc.invalidateQueries({ queryKey: ["publishing-channel-products"] });
      setAddOpen(false);
      setPubForm({ ...DEFAULT_PUB_FORM });
      setSelectedChannelId("");
      toast({ title: "Product published to channel" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const updateMut = useMutation({
    mutationFn: ({ channelId, body }: { channelId: number; body: Partial<typeof editForm> }) =>
      apiFetch(`/api/products/${productId}/publications/${channelId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["product-publications", productId] });
      qc.invalidateQueries({ queryKey: ["publishing-channel-products"] });
      setEditId(null);
      toast({ title: "Publication updated" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const removeMut = useMutation({
    mutationFn: (channelId: number) =>
      apiFetch(`/api/products/${productId}/publications/${channelId}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["product-publications", productId] });
      qc.invalidateQueries({ queryKey: ["publishing-channel-products"] });
      toast({ title: "Removed from channel" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  function openEdit(pub: Publication) {
    setEditForm({
      publication_status: pub.publication_status,
      is_visible: pub.is_visible,
      featured: pub.featured,
      public_slug: pub.public_slug ?? "",
      public_title: pub.public_title ?? "",
      price_override: pub.price_override ?? "",
      sale_price_override: pub.sale_price_override ?? "",
    });
    setEditId(pub.channel_id);
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-32 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold">Publishing Channels</h3>
          <p className="text-sm text-muted-foreground">
            Control where this product is visible in your catalog API.
          </p>
        </div>
        {canManage && unpublishedChannels.length > 0 && (
          <Button size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="h-4 w-4 mr-1" /> Add to Channel
          </Button>
        )}
      </div>

      {publications.length === 0 ? (
        <div className="border border-dashed rounded-xl p-10 text-center text-muted-foreground">
          <Rss className="h-7 w-7 mx-auto mb-2 opacity-40" />
          <p className="font-medium">Not published to any channel</p>
          <p className="text-sm mt-1">
            Add this product to a publishing channel to make it available in the catalog API.
          </p>
          {channels.length === 0 && (
            <Link href="/publishing-channels">
              <a className="mt-3 inline-flex items-center gap-1 text-sm text-primary underline">
                Create a publishing channel <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </Link>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {publications.map((pub) => (
            <div
              key={pub.id}
              className="rounded-lg border bg-card p-4 space-y-3"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3 min-w-0">
                  <div className="p-2 rounded-lg bg-muted shrink-0 mt-0.5">
                    <Globe className="h-4 w-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium">{pub.channel_name}</span>
                      {pubStatusBadge(pub.publication_status, pub.is_visible)}
                      {pub.featured && (
                        <Badge variant="outline" className="text-xs gap-1">
                          <Star className="h-3 w-3" /> Featured
                        </Badge>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground font-mono mt-0.5">{pub.channel_slug}</p>
                    {pub.published_at && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Published {formatDistanceToNow(new Date(pub.published_at), { addSuffix: true })}
                        {pub.last_synced_at && ` · Synced ${formatDistanceToNow(new Date(pub.last_synced_at), { addSuffix: true })}`}
                      </p>
                    )}
                    {pub.public_slug && (
                      <p className="text-xs text-muted-foreground font-mono mt-0.5">
                        slug: {pub.public_slug}
                      </p>
                    )}
                    {pub.price_override && (
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Price override: {pub.price_override}
                      </p>
                    )}
                  </div>
                </div>
                {canManage && (
                  <div className="flex items-center gap-1 shrink-0">
                    <Button variant="outline" size="sm" onClick={() => openEdit(pub)}>
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={() => removeMut.mutate(pub.channel_id)}
                      disabled={removeMut.isPending}
                    >
                      Remove
                    </Button>
                  </div>
                )}
              </div>

              {/* Quick toggles */}
              {canManage && (
                <div className="flex items-center gap-6 pt-1 border-t">
                  <label className="flex items-center gap-2 cursor-pointer">
                    <Switch
                      checked={pub.is_visible}
                      onCheckedChange={(v) =>
                        updateMut.mutate({ channelId: pub.channel_id, body: { is_visible: v } })
                      }
                    />
                    <span className="text-sm flex items-center gap-1">
                      {pub.is_visible ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                      Visible
                    </span>
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer">
                    <Switch
                      checked={pub.featured}
                      onCheckedChange={(v) =>
                        updateMut.mutate({ channelId: pub.channel_id, body: { featured: v } })
                      }
                    />
                    <span className="text-sm flex items-center gap-1">
                      <Star className="h-3.5 w-3.5" /> Featured
                    </span>
                  </label>
                </div>
              )}

              {/* Sync history */}
              <SyncLogSection
                pub={pub}
                logs={syncLogs}
                canManage={canManage}
                productId={productId}
              />
            </div>
          ))}
        </div>
      )}

      {/* Add to channel dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Publish to Channel</DialogTitle>
            <DialogDescription>
              Make this product available in a publishing channel's catalog API.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Channel</Label>
              <Select value={selectedChannelId} onValueChange={setSelectedChannelId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select a channel…" />
                </SelectTrigger>
                <SelectContent>
                  {unpublishedChannels.map((ch) => (
                    <SelectItem key={ch.id} value={String(ch.id)}>{ch.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Status</Label>
              <Select value={pubForm.publication_status} onValueChange={(v) => setPubForm((p) => ({ ...p, publication_status: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="published">Published</SelectItem>
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="hidden">Hidden</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-6">
              <label className="flex items-center gap-2 cursor-pointer">
                <Switch
                  checked={pubForm.is_visible}
                  onCheckedChange={(v) => setPubForm((p) => ({ ...p, is_visible: v }))}
                />
                <span className="text-sm">Visible in catalog</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <Switch
                  checked={pubForm.featured}
                  onCheckedChange={(v) => setPubForm((p) => ({ ...p, featured: v }))}
                />
                <span className="text-sm">Featured</span>
              </label>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pub-slug">Public Slug (optional)</Label>
              <Input
                id="pub-slug"
                value={pubForm.public_slug}
                onChange={(e) => setPubForm((p) => ({ ...p, public_slug: e.target.value }))}
                placeholder="my-product-slug"
                className="font-mono text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pub-title">Custom Title (optional)</Label>
              <Input
                id="pub-title"
                value={pubForm.public_title}
                onChange={(e) => setPubForm((p) => ({ ...p, public_title: e.target.value }))}
                placeholder="Override product name in this channel"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="price-override">Price Override (optional)</Label>
                <Input
                  id="price-override"
                  value={pubForm.price_override}
                  onChange={(e) => setPubForm((p) => ({ ...p, price_override: e.target.value }))}
                  placeholder="0.00"
                  type="number"
                  min="0"
                  step="0.01"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sale-price-override">Sale Price Override (optional)</Label>
                <Input
                  id="sale-price-override"
                  value={pubForm.sale_price_override}
                  onChange={(e) => setPubForm((p) => ({ ...p, sale_price_override: e.target.value }))}
                  placeholder="0.00"
                  type="number"
                  min="0"
                  step="0.01"
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button
              disabled={addMut.isPending || !selectedChannelId}
              onClick={() => addMut.mutate({ ...pubForm, channel_id: parseInt(selectedChannelId, 10) })}
            >
              {addMut.isPending ? "Publishing…" : "Publish"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit publication dialog */}
      <Dialog open={editId !== null} onOpenChange={(o) => !o && setEditId(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit Publication</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label>Status</Label>
              <Select value={editForm.publication_status} onValueChange={(v) => setEditForm((p) => ({ ...p, publication_status: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="published">Published</SelectItem>
                  <SelectItem value="draft">Draft</SelectItem>
                  <SelectItem value="hidden">Hidden</SelectItem>
                  <SelectItem value="archived">Archived</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-6">
              <label className="flex items-center gap-2 cursor-pointer">
                <Switch
                  checked={editForm.is_visible}
                  onCheckedChange={(v) => setEditForm((p) => ({ ...p, is_visible: v }))}
                />
                <span className="text-sm">Visible</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <Switch
                  checked={editForm.featured}
                  onCheckedChange={(v) => setEditForm((p) => ({ ...p, featured: v }))}
                />
                <span className="text-sm">Featured</span>
              </label>
            </div>
            <div className="space-y-1.5">
              <Label>Public Slug</Label>
              <Input
                value={editForm.public_slug}
                onChange={(e) => setEditForm((p) => ({ ...p, public_slug: e.target.value }))}
                className="font-mono text-sm"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Custom Title</Label>
              <Input
                value={editForm.public_title}
                onChange={(e) => setEditForm((p) => ({ ...p, public_title: e.target.value }))}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Price Override</Label>
                <Input
                  value={editForm.price_override}
                  onChange={(e) => setEditForm((p) => ({ ...p, price_override: e.target.value }))}
                  type="number" min="0" step="0.01"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Sale Price Override</Label>
                <Input
                  value={editForm.sale_price_override}
                  onChange={(e) => setEditForm((p) => ({ ...p, sale_price_override: e.target.value }))}
                  type="number" min="0" step="0.01"
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditId(null)}>Cancel</Button>
            <Button
              disabled={updateMut.isPending}
              onClick={() => editId !== null && updateMut.mutate({ channelId: editId, body: editForm })}
            >
              {updateMut.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
