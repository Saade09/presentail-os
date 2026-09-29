import { useState } from "react";
import { Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { apiFetch, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { useTranslation } from "react-i18next";
import { useToast } from "@/hooks/use-toast";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import {
  Copy,
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  Globe,
  Key,
  Rss,
  Terminal,
  ExternalLink,
  BookOpen,
  RefreshCw,
} from "lucide-react";

const OS_BASE = "https://os.presentail.com";

function CopyButton({ text, className }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className={`inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors ${className ?? ""}`}
      onClick={() => {
        void navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <Check className="h-3 w-3 text-green-600" /> : <Copy className="h-3 w-3" />}
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function CodeBlock({ code, lang = "http" }: { code: string; lang?: string }) {
  return (
    <div className="relative group rounded-lg bg-zinc-950 dark:bg-zinc-900 border border-zinc-800">
      <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800">
        <span className="text-xs text-zinc-500 font-mono">{lang}</span>
        <CopyButton text={code} />
      </div>
      <pre className="p-4 text-sm text-zinc-100 overflow-x-auto whitespace-pre-wrap break-all">
        <code>{code}</code>
      </pre>
    </div>
  );
}

type IngestKeyUsageEntry = {
  endpoint: string;
  count: number;
};

type IngestKeyInfo = {
  exists: boolean;
  prefix: string | null;
  created_at: string | null;
  last_used_at: string | null;
  usage_7d: IngestKeyUsageEntry[];
  total_calls_7d: number;
};

function IngestKeyCard({ isOwner }: { isOwner: boolean }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const { data, isLoading } = useQuery<IngestKeyInfo>({
    queryKey: ["ingest-key"],
    queryFn: () => apiFetch("/api/settings/ingest-key"),
  });

  const rotateMutation = useMutation({
    mutationFn: () =>
      apiFetch<{ prefix: string; plaintext: string }>("/api/settings/ingest-key/rotate", {
        method: "POST",
      }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["ingest-key"] });
      setRevealedKey(result.plaintext);
      setCopied(false);
    },
    onError: () => {
      toast({ title: "Failed to generate key", variant: "destructive" });
    },
  });

  const handleGenerate = () => {
    rotateMutation.mutate();
  };

  const handleRotate = () => {
    if (!confirm(t("ingestKey.rotateConfirm"))) return;
    rotateMutation.mutate();
  };

  const isPending = rotateMutation.isPending;

  return (
    <>
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-md bg-secondary flex items-center justify-center shrink-0">
              <Key size={18} />
            </div>
            <div className="min-w-0">
              <CardTitle className="text-base">{t("ingestKey.title")}</CardTitle>
              <CardDescription className="text-xs mt-0.5">
                {t("ingestKey.description")}
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <p className="text-sm text-muted-foreground">{t("common.loading")}</p>
          ) : !data?.exists ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">{t("ingestKey.noKeyDesc")}</p>
              {isOwner && (
                <Button
                  onClick={handleGenerate}
                  disabled={isPending}
                  data-testid="button-generate-ingest-key"
                >
                  <Key size={14} className="mr-2" />
                  {isPending ? t("ingestKey.generating") : t("ingestKey.generateKey")}
                </Button>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              <div className="grid sm:grid-cols-3 gap-3 text-sm">
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-0.5">{t("ingestKey.prefix")}</p>
                  <code className="font-mono text-xs bg-muted px-2 py-1 rounded">{data.prefix}…</code>
                </div>
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-0.5">{t("ingestKey.createdAt")}</p>
                  <p className="text-sm">{data.created_at ? new Date(data.created_at).toLocaleDateString() : "—"}</p>
                </div>
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-0.5">{t("ingestKey.lastUsed")}</p>
                  <p className="text-sm">
                    {data.last_used_at
                      ? new Date(data.last_used_at).toLocaleDateString()
                      : t("ingestKey.lastUsedNever")}
                  </p>
                </div>
              </div>

              {/* Usage breakdown — last 7 days */}
              <div className="rounded-md border bg-muted/30 p-3 space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                    {t("ingestKey.usageLast7Days")}
                  </p>
                  <span className="text-xs font-mono text-muted-foreground">
                    {t("ingestKey.totalCalls", { count: data.total_calls_7d })}
                  </span>
                </div>
                {data.usage_7d.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t("ingestKey.noUsageYet")}</p>
                ) : (
                  <div className="space-y-1">
                    {data.usage_7d.map((u) => (
                      <div key={u.endpoint} className="flex items-center justify-between text-xs">
                        <code className="font-mono text-foreground/80">{u.endpoint}</code>
                        <span className="font-medium tabular-nums">
                          {t("ingestKey.callCount", { count: u.count })}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {isOwner && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleRotate}
                  disabled={isPending}
                  data-testid="button-rotate-ingest-key"
                >
                  <RefreshCw size={14} className="mr-2" />
                  {isPending ? t("ingestKey.rotating") : t("ingestKey.rotateKey")}
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Reveal dialog */}
      <Dialog open={revealedKey !== null} onOpenChange={(open) => !open && setRevealedKey(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("ingestKey.revealTitle")}</DialogTitle>
            <DialogDescription>{t("ingestKey.revealDesc")}</DialogDescription>
          </DialogHeader>
          <div className="bg-secondary border border-border rounded-md p-3 font-mono text-sm break-all">
            {revealedKey}
          </div>
          <DialogFooter>
            <Button
              onClick={() => {
                if (revealedKey) {
                  void navigator.clipboard.writeText(revealedKey);
                  setCopied(true);
                  toast({ title: t("ingestKey.copied") });
                  setTimeout(() => setCopied(false), 2000);
                }
              }}
              className="gap-2"
            >
              {copied ? <Check size={16} /> : <Copy size={16} />}
              {copied ? t("ingestKey.copied") : t("ingestKey.copy")}
            </Button>
            <Button variant="outline" onClick={() => setRevealedKey(null)}>
              {t("ingestKey.done")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

type Section = {
  id: string;
  label: string;
  icon: React.ElementType;
};

const SECTIONS: Section[] = [
  { id: "overview", label: "Overview", icon: Globe },
  { id: "auth", label: "Authentication", icon: Key },
  { id: "products", label: "GET /products", icon: Code2 },
  { id: "product-detail", label: "GET /products/:id", icon: Code2 },
  { id: "product-slug", label: "GET /products/slug/:slug", icon: Code2 },
  { id: "brands", label: "GET /brands", icon: Code2 },
  { id: "categories", label: "GET /categories", icon: Code2 },
  { id: "occasions", label: "GET /occasions", icon: Code2 },
  { id: "recipients", label: "GET /recipients", icon: Code2 },
  { id: "cities", label: "GET /delivery-cities", icon: Code2 },
  { id: "availability", label: "GET /availability", icon: Code2 },
  { id: "webhooks", label: "Product Webhooks", icon: Rss },
  { id: "channels", label: "Channels & Keys", icon: Terminal },
];

const INGEST_SECTIONS: Section[] = [
  { id: "ingest-key", label: "Ingest API Key", icon: Key },
];

function Endpoint({
  method,
  path,
  description,
  params,
  example,
  response,
}: {
  method: string;
  path: string;
  description: string;
  params?: { name: string; type: string; required?: boolean; desc: string }[];
  example: string;
  response: string;
}) {
  const [open, setOpen] = useState(false);
  const methodColor =
    method === "GET" ? "text-green-500" :
    method === "POST" ? "text-blue-500" :
    method === "PATCH" ? "text-amber-500" :
    "text-red-500";

  return (
    <div className="border rounded-lg overflow-hidden">
      <button
        className="w-full flex items-center gap-3 px-4 py-3 bg-muted/40 hover:bg-muted/60 transition-colors text-left"
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`font-mono font-bold text-sm w-14 shrink-0 ${methodColor}`}>{method}</span>
        <span className="font-mono text-sm">{path}</span>
        <span className="text-sm text-muted-foreground ml-2 hidden sm:block">{description}</span>
        <span className="ml-auto">{open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</span>
      </button>
      {open && (
        <div className="p-4 space-y-4 border-t">
          <p className="text-sm text-muted-foreground">{description}</p>
          {params && params.length > 0 && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Query Parameters</p>
              <div className="rounded-lg border divide-y text-sm">
                {params.map((p) => (
                  <div key={p.name} className="flex gap-3 px-3 py-2">
                    <code className="font-mono text-xs shrink-0 w-36">{p.name}</code>
                    <code className="text-xs text-muted-foreground shrink-0 w-16">{p.type}</code>
                    {p.required && <Badge variant="secondary" className="text-xs h-4">required</Badge>}
                    <span className="text-xs text-muted-foreground">{p.desc}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Example Request</p>
            <CodeBlock code={example} />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-2">Example Response</p>
            <CodeBlock code={response} lang="json" />
          </div>
        </div>
      )}
    </div>
  );
}

type CatalogApiKey = {
  id: number;
  name: string;
  key_prefix: string;
  channel_id: number | null;
  channel_name: string | null;
  channel_slug: string | null;
  status: string;
};

type PublishingChannel = {
  id: number;
  name: string;
  slug: string;
  status: string;
};

export function CatalogApiDocsContent({ showDeveloperExtras = false }: { showDeveloperExtras?: boolean }) {
  const [activeSection, setActiveSection] = useState("overview");
  const [tryKey, setTryKey] = useState("");
  const { isOwner } = useWorkspaceRole();

  const { data: keysData } = useQuery<{ api_keys: CatalogApiKey[] }>({
    queryKey: ["catalog-api-keys"],
    queryFn: () => apiFetch("/api/catalog-api-keys"),
  });

  const { data: channelsData } = useQuery<{ channels: PublishingChannel[] }>({
    queryKey: ["publishing-channels"],
    queryFn: () => apiFetch("/api/publishing-channels"),
  });

  const apiKeys = keysData?.api_keys ?? [];
  const channels = channelsData?.channels ?? [];
  const firstChannel = channels[0];

  const exampleChannel = firstChannel?.slug ?? "presentail-website-app";

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <aside className="hidden md:flex flex-col w-52 shrink-0 border-r p-3 gap-0.5 overflow-y-auto">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground px-2 pt-2 pb-1">Catalog API v1</p>
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            className={`flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-left w-full transition-colors ${
              activeSection === s.id ? "bg-primary/10 text-primary font-medium" : "text-muted-foreground hover:text-foreground hover:bg-muted"
            }`}
            onClick={() => setActiveSection(s.id)}
          >
            <s.icon className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{s.label}</span>
          </button>
        ))}
        {showDeveloperExtras && isOwner && (
          <div className="mt-4 border-t pt-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground px-2 pb-1">Ingest API</p>
            {INGEST_SECTIONS.map((s) => (
              <button
                key={s.id}
                className={`flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-left w-full transition-colors ${
                  activeSection === s.id ? "bg-primary/10 text-primary font-medium" : "text-muted-foreground hover:text-foreground hover:bg-muted"
                }`}
                onClick={() => setActiveSection(s.id)}
              >
                <s.icon className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">{s.label}</span>
              </button>
            ))}
          </div>
        )}
        {showDeveloperExtras && (
          <div className="mt-4 border-t pt-3">
            <Link href="/api-docs">
              <a className="flex items-center gap-2 px-2 py-1.5 rounded-md text-sm text-muted-foreground hover:text-foreground hover:bg-muted w-full">
                <BookOpen className="h-3.5 w-3.5" /> Full API Docs
              </a>
            </Link>
          </div>
        )}
      </aside>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-8 space-y-8 max-w-3xl">

        {/* Overview */}
        {activeSection === "overview" && (
          <div className="space-y-6">
            <div>
              <h1 className="text-2xl font-semibold mb-2">Catalog API v1</h1>
              <p className="text-muted-foreground">
                The Catalog API gives your apps read-only access to your published product catalog, filtered by publishing channel.
                Products must be published to a channel before they appear in the API.
              </p>
            </div>
            <div className="grid sm:grid-cols-2 gap-4">
              <div className="rounded-lg border p-4 space-y-1">
                <p className="text-sm font-semibold">Base URL</p>
                <code className="text-xs text-muted-foreground">{OS_BASE}/api/catalog/v1</code>
              </div>
              <div className="rounded-lg border p-4 space-y-1">
                <p className="text-sm font-semibold">Authentication</p>
                <p className="text-xs text-muted-foreground">Bearer token or X-Presentail-Api-Key header</p>
              </div>
            </div>
            <div className="rounded-lg border p-4 space-y-3">
              <p className="text-sm font-semibold">Quick start</p>
              <CodeBlock
                code={`# 1. Get a catalog API key from Publishing Channels
# 2. Make your first request:

curl ${OS_BASE}/api/catalog/v1/products?channel=${exampleChannel} \\
  -H "Authorization: Bearer cat_live_your_key_here"`}
                lang="bash"
              />
            </div>
            <div className="rounded-lg border p-4">
              <p className="text-sm font-semibold mb-2">Your Channels</p>
              {channels.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No channels created yet.{" "}
                  <Link href="/publishing-channels">
                    <a className="text-primary underline">Create one →</a>
                  </Link>
                </p>
              ) : (
                <div className="space-y-1">
                  {channels.map((ch) => (
                    <div key={ch.id} className="flex items-center justify-between text-sm py-1">
                      <span className="font-mono text-xs">{ch.slug}</span>
                      <Badge variant={ch.status === "active" ? "default" : "secondary"} className="text-xs">{ch.status}</Badge>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Auth */}
        {activeSection === "auth" && (
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-semibold mb-2">Authentication</h2>
              <p className="text-muted-foreground text-sm">
                All Catalog API requests require a catalog API key. Keys are scoped to a publishing channel and provide read-only access to that channel's published products.
              </p>
            </div>
            <div className="space-y-3">
              <p className="font-medium text-sm">Option 1 — Authorization header (recommended)</p>
              <CodeBlock code={`Authorization: Bearer cat_live_your_key_here`} />
            </div>
            <div className="space-y-3">
              <p className="font-medium text-sm">Option 2 — Custom header</p>
              <CodeBlock code={`X-Presentail-Api-Key: cat_live_your_key_here`} />
            </div>
            <div className="rounded-lg border p-4 space-y-3">
              <p className="text-sm font-semibold">Your Active Keys</p>
              {apiKeys.filter((k) => k.status === "active").length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No API keys yet.{" "}
                  <Link href="/publishing-channels">
                    <a className="text-primary underline">Create one in a channel →</a>
                  </Link>
                </p>
              ) : (
                <div className="divide-y rounded-lg border">
                  {apiKeys.filter((k) => k.status === "active").map((k) => (
                    <div key={k.id} className="flex items-center justify-between px-3 py-2 text-sm">
                      <div>
                        <p className="font-medium">{k.name}</p>
                        <p className="text-xs text-muted-foreground font-mono">{k.key_prefix}… · {k.channel_name ?? "All channels"}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="space-y-2">
              <p className="font-medium text-sm">Try your key</p>
              <Input
                value={tryKey}
                onChange={(e) => setTryKey(e.target.value)}
                placeholder="cat_live_…"
                className="font-mono text-sm"
              />
              {tryKey && (
                <CodeBlock
                  code={`curl ${OS_BASE}/api/catalog/v1/products?channel=${exampleChannel} \\\n  -H "Authorization: Bearer ${tryKey}"`}
                  lang="bash"
                />
              )}
            </div>
          </div>
        )}

        {/* Products list */}
        {activeSection === "products" && (
          <div className="space-y-4">
            <h2 className="text-xl font-semibold">List Products</h2>
            <Endpoint
              method="GET"
              path="/api/catalog/v1/products"
              description="Returns a paginated list of published, visible products in the specified channel."
              params={[
                { name: "channel", type: "string", required: true, desc: "Channel slug (e.g. presentail-website-app)" },
                { name: "brand", type: "string", desc: "Filter by brand name (partial match)" },
                { name: "category", type: "string", desc: "Filter by category name (partial match)" },
                { name: "occasion", type: "string", desc: "Filter by occasion name (exact, case-insensitive)" },
                { name: "recipient", type: "string", desc: "Filter by recipient name (exact, case-insensitive)" },
                { name: "featured", type: "boolean", desc: "Filter to featured products only" },
                { name: "available", type: "boolean", desc: "Filter by availability (true = in_stock only)" },
                { name: "updated_since", type: "ISO date", desc: "Return products updated after this timestamp" },
                { name: "limit", type: "number", desc: "Page size, 1–100 (default: 20)" },
                { name: "cursor", type: "number", desc: "Product ID cursor for pagination" },
              ]}
              example={`curl "${OS_BASE}/api/catalog/v1/products?channel=${exampleChannel}&limit=20" \\
  -H "Authorization: Bearer cat_live_…"`}
              response={`{
  "success": true,
  "channel": { "id": 1, "slug": "${exampleChannel}", "name": "Presentail Website & App" },
  "products": [
    {
      "id": 123,
      "sku": "PF-001",
      "name": "Elegant Rose Bouquet",
      "slug": "elegant-rose-bouquet",
      "brand": "Presentail Flowers & Gifts",
      "category": "Flowers",
      "tags": ["roses", "romantic"],
      "price": "79.99",
      "currency": "USD",
      "status": "available",
      "availability": "in_stock",
      "images": { "main": "/objects/...", "additional": [] },
      "occasions": ["Valentine's Day"],
      "recipients": ["Partner"],
      "publishing": { "featured": true, "sort_order": 1, "published_at": "2026-06-01T00:00:00Z" }
    }
  ],
  "pagination": { "limit": 20, "has_more": false, "next_cursor": null }
}`}
            />
          </div>
        )}

        {/* Product detail */}
        {activeSection === "product-detail" && (
          <div className="space-y-4">
            <h2 className="text-xl font-semibold">Get Product by ID</h2>
            <Endpoint
              method="GET"
              path="/api/catalog/v1/products/:id"
              description="Get a single published product by its numeric ID."
              params={[{ name: "channel", type: "string", required: true, desc: "Channel slug" }]}
              example={`curl "${OS_BASE}/api/catalog/v1/products/123?channel=${exampleChannel}" \\
  -H "Authorization: Bearer cat_live_…"`}
              response={`{ "success": true, "product": { "id": 123, "name": "Elegant Rose Bouquet", "..." } }`}
            />
          </div>
        )}

        {/* Product by slug */}
        {activeSection === "product-slug" && (
          <div className="space-y-4">
            <h2 className="text-xl font-semibold">Get Product by Slug</h2>
            <Endpoint
              method="GET"
              path="/api/catalog/v1/products/slug/:slug"
              description="Look up a published product by its public slug (set in the Publishing tab)."
              params={[{ name: "channel", type: "string", required: true, desc: "Channel slug" }]}
              example={`curl "${OS_BASE}/api/catalog/v1/products/slug/elegant-rose-bouquet?channel=${exampleChannel}" \\
  -H "Authorization: Bearer cat_live_…"`}
              response={`{ "success": true, "product": { "id": 123, "slug": "elegant-rose-bouquet", "..." } }`}
            />
          </div>
        )}

        {/* Brands */}
        {activeSection === "brands" && (
          <div className="space-y-4">
            <h2 className="text-xl font-semibold">List Brands</h2>
            <Endpoint
              method="GET"
              path="/api/catalog/v1/brands"
              description="Returns all active brands in the workspace."
              example={`curl "${OS_BASE}/api/catalog/v1/brands" \\
  -H "Authorization: Bearer cat_live_…"`}
              response={`{ "success": true, "brands": [{ "id": 1, "name": "Presentail Flowers & Gifts", "slug": null }] }`}
            />
          </div>
        )}

        {/* Categories */}
        {activeSection === "categories" && (
          <div className="space-y-4">
            <h2 className="text-xl font-semibold">List Catalog Categories</h2>
            <Endpoint
              method="GET"
              path="/api/catalog/v1/categories"
              description="Returns all active catalog categories (occasions groups, not product categories)."
              example={`curl "${OS_BASE}/api/catalog/v1/categories" \\
  -H "Authorization: Bearer cat_live_…"`}
              response={`{ "success": true, "categories": [{ "id": 1, "name": "Flowers", "slug": "flowers" }] }`}
            />
          </div>
        )}

        {/* Occasions */}
        {activeSection === "occasions" && (
          <div className="space-y-4">
            <h2 className="text-xl font-semibold">List Occasions</h2>
            <Endpoint
              method="GET"
              path="/api/catalog/v1/occasions"
              description="Returns all active occasions."
              example={`curl "${OS_BASE}/api/catalog/v1/occasions" \\
  -H "Authorization: Bearer cat_live_…"`}
              response={`{ "success": true, "occasions": [{ "id": 1, "name": "Valentine's Day", "slug": "valentines-day" }] }`}
            />
          </div>
        )}

        {/* Recipients */}
        {activeSection === "recipients" && (
          <div className="space-y-4">
            <h2 className="text-xl font-semibold">List Recipients</h2>
            <Endpoint
              method="GET"
              path="/api/catalog/v1/recipients"
              description="Returns all active recipients."
              example={`curl "${OS_BASE}/api/catalog/v1/recipients" \\
  -H "Authorization: Bearer cat_live_…"`}
              response={`{ "success": true, "recipients": [{ "id": 1, "name": "Partner", "slug": "partner" }] }`}
            />
          </div>
        )}

        {/* Delivery Cities */}
        {activeSection === "cities" && (
          <div className="space-y-4">
            <h2 className="text-xl font-semibold">List Delivery Cities</h2>
            <Endpoint
              method="GET"
              path="/api/catalog/v1/delivery-cities"
              description="Returns all active delivery cities."
              example={`curl "${OS_BASE}/api/catalog/v1/delivery-cities" \\
  -H "Authorization: Bearer cat_live_…"`}
              response={`{ "success": true, "delivery_cities": [{ "id": 1, "name": "Dubai", "slug": "dubai", "country": "UAE" }] }`}
            />
          </div>
        )}

        {/* Availability */}
        {activeSection === "availability" && (
          <div className="space-y-4">
            <h2 className="text-xl font-semibold">Check Availability</h2>
            <Endpoint
              method="GET"
              path="/api/catalog/v1/availability"
              description="Check whether a specific product is published and available in a channel."
              params={[
                { name: "channel", type: "string", required: true, desc: "Channel slug" },
                { name: "product_id", type: "number", required: true, desc: "Product ID to check" },
              ]}
              example={`curl "${OS_BASE}/api/catalog/v1/availability?channel=${exampleChannel}&product_id=123" \\
  -H "Authorization: Bearer cat_live_…"`}
              response={`{
  "success": true,
  "product_id": 123,
  "channel_id": 1,
  "is_published": true,
  "is_visible": true,
  "publication_status": "published",
  "availability": "in_stock"
}`}
            />
          </div>
        )}

        {/* Webhooks */}
        {activeSection === "webhooks" && (
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-semibold mb-2">Product Webhooks</h2>
              <p className="text-sm text-muted-foreground">
                Subscribe to real-time events when products in a publishing channel change.
                Configure endpoints in a channel's Webhooks tab.
              </p>
            </div>
            <div className="rounded-lg border p-4 space-y-2">
              <p className="text-sm font-semibold">Available Events</p>
              <div className="grid grid-cols-2 gap-1">
                {[
                  "product.created", "product.updated", "product.price_updated",
                  "product.published", "product.unpublished", "product.hidden",
                  "product.unhidden", "product.availability_updated", "product.images_updated",
                ].map((ev) => (
                  <code key={ev} className="text-xs font-mono bg-muted px-2 py-1 rounded">{ev}</code>
                ))}
              </div>
            </div>
            <div className="space-y-3">
              <p className="font-medium text-sm">Signature Verification</p>
              <p className="text-sm text-muted-foreground">
                Every delivery includes these headers. Use them to verify the payload is from Presentail.
              </p>
              <CodeBlock
                code={`X-Presentail-Event: product.updated
X-Presentail-Delivery: <uuid>
X-Presentail-Timestamp: <iso-timestamp>
X-Presentail-Signature: sha256=<hex-hmac>`}
              />
              <CodeBlock
                code={`// Node.js verification example
import crypto from "crypto";

function verifyWebhook(signingSecret, deliveryId, timestamp, rawBody, signature) {
  const message = deliveryId + "." + timestamp + "." + rawBody;
  const expected = "sha256=" + crypto
    .createHmac("sha256", signingSecret)
    .update(message)
    .digest("hex");
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}`}
                lang="typescript"
              />
            </div>
            <div className="space-y-3">
              <p className="font-medium text-sm">Example Payload</p>
              <CodeBlock
                code={`{
  "id": "evt_1748000000_123",
  "event": "product.updated",
  "created_at": "2026-06-01T12:00:00.000Z",
  "brand_id": 1,
  "channel_id": 1,
  "product_id": 123,
  "product_slug": "elegant-rose-bouquet",
  "changed_fields": ["price_usd", "status"],
  "api_url": "/api/catalog/v1/products/123?channel=presentail-website-app"
}`}
                lang="json"
              />
            </div>
          </div>
        )}

        {/* Channels & Keys */}
        {activeSection === "channels" && (
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-semibold mb-2">Channels & API Keys</h2>
              <p className="text-sm text-muted-foreground">
                A publishing channel represents a consumer of your catalog (website, mobile app, POS, etc.).
                Each channel has its own API keys, webhook endpoints, and product list.
              </p>
            </div>
            <div className="rounded-lg border p-4 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold">Your Channels</p>
                <Link href="/publishing-channels">
                  <a className="text-xs text-primary flex items-center gap-1">
                    Manage <ExternalLink className="h-3 w-3" />
                  </a>
                </Link>
              </div>
              {channels.length === 0 ? (
                <p className="text-sm text-muted-foreground">No channels yet.</p>
              ) : (
                <div className="divide-y rounded-lg border mt-2">
                  {channels.map((ch) => (
                    <div key={ch.id} className="flex items-center justify-between px-3 py-2 text-sm">
                      <div>
                        <p className="font-medium">{ch.name}</p>
                        <p className="text-xs text-muted-foreground font-mono">{ch.slug}</p>
                      </div>
                      <Badge variant={ch.status === "active" ? "default" : "secondary"} className="text-xs">{ch.status}</Badge>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="rounded-lg border p-4 space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold">Your API Keys</p>
              </div>
              {apiKeys.filter((k) => k.status === "active").length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No API keys yet. Create one from a channel's detail page.
                </p>
              ) : (
                <div className="divide-y rounded-lg border mt-2">
                  {apiKeys.filter((k) => k.status === "active").map((k) => (
                    <div key={k.id} className="flex items-center justify-between px-3 py-2 text-sm">
                      <div>
                        <p className="font-medium">{k.name}</p>
                        <p className="text-xs text-muted-foreground font-mono">{k.key_prefix}… · {k.channel_name ?? "All channels"}</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Ingest API Key — owner only */}
        {showDeveloperExtras && activeSection === "ingest-key" && isOwner && (
          <div className="space-y-6">
            <div>
              <h2 className="text-xl font-semibold mb-2">Ingest API Key</h2>
              <p className="text-sm text-muted-foreground">
                The ingest key authenticates server-to-server requests to your <code className="text-xs bg-muted px-1.5 py-0.5 rounded">/api/v1/</code> endpoints, such as <code className="text-xs bg-muted px-1.5 py-0.5 rounded">POST /api/v1/orders</code>.
                Use it in your backend — never expose it to browser clients.
              </p>
            </div>
            <IngestKeyCard isOwner={isOwner} />
            <div className="rounded-lg border p-4 space-y-3">
              <p className="text-sm font-semibold">Usage</p>
              <CodeBlock
                code={`curl https://os.presentail.com/api/v1/orders \\
  -X POST \\
  -H "Authorization: Bearer pik_live_your_key_here" \\
  -H "Content-Type: application/json" \\
  -d '{"workspace_owner_id": "user_…", "…": "…"}'`}
                lang="bash"
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function Developer() {
  return <CatalogApiDocsContent showDeveloperExtras />;
}
