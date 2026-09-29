import { useState } from "react";
import { Link } from "wouter";
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
  Rss,
  Plus,
  Globe,
  Smartphone,
  Monitor,
  ShoppingBag,
  Plug,
  ChevronRight,
  Radio,
  CheckCircle2,
  XCircle,
  Package,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";

type Channel = {
  id: number;
  name: string;
  slug: string;
  type: string;
  brand_id: number | null;
  status: string;
  default_currency: string;
  auto_publish_new_products: boolean;
  published_product_count: number;
  active_webhook_count: number;
  active_api_key_count: number;
  created_at: string;
};

const CHANNEL_TYPES = [
  { value: "website", label: "Website", icon: Globe },
  { value: "mobile_app", label: "Mobile App", icon: Smartphone },
  { value: "pos", label: "Point of Sale", icon: Monitor },
  { value: "marketplace", label: "Marketplace", icon: ShoppingBag },
  { value: "api_consumer", label: "API Consumer", icon: Plug },
  { value: "other", label: "Other", icon: Radio },
];

const CURRENCIES = ["USD", "AED", "EUR", "GBP", "SAR"];

function channelTypeLabel(type: string): string {
  return CHANNEL_TYPES.find((t) => t.value === type)?.label ?? type;
}

function channelTypeIcon(type: string) {
  const T = CHANNEL_TYPES.find((t) => t.value === type);
  if (!T) return <Radio className="h-4 w-4" />;
  return <T.icon className="h-4 w-4" />;
}

function statusBadge(status: string) {
  if (status === "active") {
    return (
      <Badge className="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 border-0 gap-1">
        <CheckCircle2 className="h-3 w-3" /> Active
      </Badge>
    );
  }
  return (
    <Badge className="bg-muted text-muted-foreground border-0 gap-1">
      <XCircle className="h-3 w-3" /> Inactive
    </Badge>
  );
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 80);
}

const DEFAULT_FORM = {
  name: "",
  slug: "",
  type: "website",
  default_currency: "USD",
  auto_publish_new_products: false,
  status: "active",
};

export default function PublishingChannels() {
  const { realIsOwner } = useWorkspaceRole();
  const qc = useQueryClient();
  const { toast } = useToast();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [form, setForm] = useState({ ...DEFAULT_FORM });
  const [slugDirty, setSlugDirty] = useState(false);

  const { data, isLoading } = useQuery<{ channels: Channel[] }>({
    queryKey: ["publishing-channels"],
    queryFn: () => apiFetch("/api/publishing-channels"),
  });

  const createMut = useMutation({
    mutationFn: (body: typeof form) =>
      apiFetch("/api/publishing-channels", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["publishing-channels"] });
      setDialogOpen(false);
      setForm({ ...DEFAULT_FORM });
      setSlugDirty(false);
      toast({ title: "Channel created" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/api/publishing-channels/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["publishing-channels"] });
      setDeleteId(null);
      toast({ title: "Channel deactivated" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  function handleNameChange(name: string) {
    setForm((prev) => ({
      ...prev,
      name,
      slug: slugDirty ? prev.slug : slugify(name),
    }));
  }

  const channels = data?.channels ?? [];

  return (
    <div className="max-w-4xl mx-auto py-8 px-4 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-primary/10">
            <Rss className="h-5 w-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold">Publishing Channels</h1>
            <p className="text-sm text-muted-foreground">
              Manage where your products are published and distributed.
            </p>
          </div>
        </div>
        {realIsOwner && (
          <Button onClick={() => { setForm({ ...DEFAULT_FORM }); setSlugDirty(false); setDialogOpen(true); }}>
            <Plus className="h-4 w-4 mr-1" /> New Channel
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center h-40 text-muted-foreground">Loading…</div>
      ) : channels.length === 0 ? (
        <div className="border border-dashed rounded-xl p-12 text-center text-muted-foreground">
          <Rss className="h-8 w-8 mx-auto mb-3 opacity-40" />
          <p className="font-medium">No publishing channels yet</p>
          <p className="text-sm mt-1">Create a channel to start distributing your product catalog.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {channels.map((ch) => (
            <Link key={ch.id} href={`/publishing-channels/${ch.id}`}>
              <a className="block group rounded-xl border bg-card hover:border-primary/40 hover:shadow-sm transition-all cursor-pointer p-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3 min-w-0">
                    <div className="p-2 rounded-lg bg-muted shrink-0 mt-0.5">
                      {channelTypeIcon(ch.type)}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold truncate">{ch.name}</span>
                        {statusBadge(ch.status)}
                        <Badge variant="secondary" className="text-xs">
                          {channelTypeLabel(ch.type)}
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5 font-mono">{ch.slug}</p>
                      <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                        <span className="flex items-center gap-1">
                          <Package className="h-3 w-3" />
                          {ch.published_product_count} products
                        </span>
                        <span>{ch.default_currency}</span>
                        {ch.auto_publish_new_products && (
                          <Badge variant="outline" className="text-xs py-0">Auto-publish</Badge>
                        )}
                      </div>
                    </div>
                  </div>
                  <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0 group-hover:text-foreground transition-colors" />
                </div>
              </a>
            </Link>
          ))}
        </div>
      )}

      {/* Create dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>New Publishing Channel</DialogTitle>
            <DialogDescription>
              Create a new channel to publish your product catalog to a website, mobile app, or other consumer.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="ch-name">Name</Label>
              <Input
                id="ch-name"
                value={form.name}
                onChange={(e) => handleNameChange(e.target.value)}
                placeholder="Presentail Website & App"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="ch-slug">Slug</Label>
              <Input
                id="ch-slug"
                value={form.slug}
                onChange={(e) => { setForm((p) => ({ ...p, slug: e.target.value })); setSlugDirty(true); }}
                placeholder="presentail-website-app"
                className="font-mono text-sm"
              />
              <p className="text-xs text-muted-foreground">Used in API queries (?channel=slug). Lowercase letters, numbers and dashes only.</p>
            </div>
            <div className="space-y-1.5">
              <Label>Type</Label>
              <Select value={form.type} onValueChange={(v) => setForm((p) => ({ ...p, type: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CHANNEL_TYPES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      <div className="flex items-center gap-2">
                        <t.icon className="h-4 w-4" /> {t.label}
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Default Currency</Label>
              <Select value={form.default_currency} onValueChange={(v) => setForm((p) => ({ ...p, default_currency: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CURRENCIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between py-1">
              <div>
                <p className="text-sm font-medium">Auto-publish new products</p>
                <p className="text-xs text-muted-foreground">Automatically publish newly created products to this channel.</p>
              </div>
              <Switch
                checked={form.auto_publish_new_products}
                onCheckedChange={(v) => setForm((p) => ({ ...p, auto_publish_new_products: v }))}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button
              disabled={createMut.isPending || !form.name.trim() || !form.slug.trim()}
              onClick={() => createMut.mutate(form)}
            >
              {createMut.isPending ? "Creating…" : "Create Channel"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <AlertDialog open={deleteId !== null} onOpenChange={(o) => !o && setDeleteId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Deactivate Channel?</AlertDialogTitle>
            <AlertDialogDescription>
              This will set the channel to inactive. Published products will no longer be served via the catalog API. This action can be reversed by editing the channel status.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => deleteId !== null && deleteMut.mutate(deleteId)}
            >
              Deactivate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
