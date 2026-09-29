import { useState, useEffect, useRef, createContext, useContext, useCallback } from "react";
import { useUser } from "@clerk/react";
import { Copy, Check, ChevronDown, ChevronUp, Play, Loader2, Trash2, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTranslation } from "react-i18next";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiReferenceReact } from "@scalar/api-reference-react";
import "@scalar/api-reference-react/style.css";
import { PageGuard } from "@/App";
import { CatalogApiDocsContent } from "./Developer";

const PRINT_AGENT_BASE = "https://print.presentail.com";
const OS_API_BASE = "https://os.presentail.com";
const COPY_FEEDBACK_MS = 1500;

const SECTIONS: { id: string; title: string }[] = [
  { id: "base-urls", title: "Base URLs" },
  { id: "auth", title: "Authentication" },
  { id: "submit", title: "Submit a Print Job" },
  { id: "status", title: "Check Job Status" },
  { id: "devices", title: "List Devices" },
  { id: "statuses", title: "Job Status Reference" },
  { id: "public", title: "Public Endpoints" },
  { id: "catalog-attributes", title: "Catalog Attributes" },
  { id: "admin-cities", title: "Delivery Cities" },
  { id: "fleet", title: "Fleet API" },
  { id: "coupons", title: "Coupons" },
  { id: "website-events", title: "Website Events" },
  { id: "currency-rates", title: "Currencies & Exchange Rates" },
  { id: "errors", title: "Error Responses" },
];

// ---------------------------------------------------------------------------
// Try It context — shared token state across all panels
// ---------------------------------------------------------------------------

interface TryItCtx {
  apiKey: string;
  setApiKey: (v: string) => void;
  driverToken: string;
  setDriverToken: (v: string) => void;
}

const TryItContext = createContext<TryItCtx>({
  apiKey: "",
  setApiKey: () => {},
  driverToken: "",
  setDriverToken: () => {},
});

// ---------------------------------------------------------------------------
// TryIt config types
// ---------------------------------------------------------------------------

interface ParamDef {
  name: string;
  placeholder: string;
  required?: boolean;
}

interface BodyFieldDef {
  name: string;
  type: "text" | "number" | "select";
  placeholder?: string;
  options?: string[];
}

interface TryItConfig {
  method: string;
  baseUrl: string;
  path: string; // may contain {param} placeholders, e.g. /api/jobs/{id}
  authType: "api-key" | "driver-token" | "none";
  pathParams?: ParamDef[];
  queryParams?: ParamDef[];
  defaultQueryValues?: Record<string, string>;
  bodyFields?: BodyFieldDef[];
  note?: string;
}

// ---------------------------------------------------------------------------
// Lightweight JSON syntax highlighter
// ---------------------------------------------------------------------------

function highlightJson(json: string): string {
  return json
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(
      /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g,
      (match) => {
        let cls = "color:#79c0ff"; // number
        if (/^"/.test(match)) {
          if (/:$/.test(match)) {
            cls = "color:#ff7b72"; // key
          } else {
            cls = "color:#a5d6ff"; // string value
          }
        } else if (/true|false/.test(match)) {
          cls = "color:#56d364"; // boolean
        } else if (/null/.test(match)) {
          cls = "color:#8b949e"; // null
        }
        return `<span style="${cls}">${match}</span>`;
      },
    );
}

// ---------------------------------------------------------------------------
// TryItPanel
// ---------------------------------------------------------------------------

function TryItPanel({ config }: { config: TryItConfig }) {
  const { apiKey, driverToken } = useContext(TryItContext);

  const [open, setOpen] = useState(false);
  const [pathValues, setPathValues] = useState<Record<string, string>>({});
  const [queryValues, setQueryValues] = useState<Record<string, string>>({});
  const [bodyValues, setBodyValues] = useState<Record<string, string>>({});

  const defaultQVKey = JSON.stringify(config.defaultQueryValues ?? {});
  useEffect(() => {
    const defaults = config.defaultQueryValues;
    if (!defaults) return;
    setQueryValues((prev) => {
      const next = { ...prev };
      let changed = false;
      for (const [key, val] of Object.entries(defaults)) {
        if (val && !prev[key]) {
          next[key] = val;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultQVKey]);
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<{
    status: number;
    ok: boolean;
    body: string;
  } | null>(null);

  const buildUrl = useCallback(() => {
    let path = config.path;
    for (const [key, val] of Object.entries(pathValues)) {
      path = path.replace(`{${key}}`, encodeURIComponent(val));
    }
    const base = config.baseUrl.replace(/\/$/, "");
    const url = new URL(base + path);
    for (const qp of config.queryParams ?? []) {
      const val = queryValues[qp.name];
      if (val) url.searchParams.set(qp.name, val);
    }
    return url.toString();
  }, [config, pathValues, queryValues]);

  const send = useCallback(async () => {
    setLoading(true);
    setResponse(null);
    try {
      const token = config.authType === "api-key" ? apiKey : config.authType === "driver-token" ? driverToken : "";
      const headers: Record<string, string> = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;

      let body: BodyInit | undefined;
      if (config.bodyFields && config.bodyFields.length > 0) {
        headers["Content-Type"] = "application/json";
        const obj: Record<string, unknown> = {};
        for (const f of config.bodyFields) {
          const val = bodyValues[f.name];
          if (val !== undefined && val !== "") {
            obj[f.name] = f.type === "number" ? Number(val) : val;
          }
        }
        body = JSON.stringify(obj);
      }

      const res = await fetch(buildUrl(), {
        method: config.method,
        headers,
        body,
      });

      let text: string;
      try {
        const json = await res.json();
        text = JSON.stringify(json, null, 2);
      } catch {
        text = await res.text();
      }

      setResponse({ status: res.status, ok: res.ok, body: text });
    } catch (err) {
      setResponse({ status: 0, ok: false, body: String(err) });
    } finally {
      setLoading(false);
    }
  }, [config, apiKey, driverToken, pathValues, queryValues, bodyValues, buildUrl]);

  const tokenMissing =
    (config.authType === "api-key" && !apiKey) ||
    (config.authType === "driver-token" && !driverToken);

  return (
    <div className="mt-3 border border-dashed border-border rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-secondary/40 transition-colors"
      >
        <span className="flex items-center gap-1.5">
          <Play size={11} />
          Try it
        </span>
        {open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-3 border-t border-border bg-secondary/20">
          {tokenMissing && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5 mt-2">
              {config.authType === "api-key"
                ? "Enter your API key in the token bar above to send this request."
                : "Enter your driver token in the token bar above to send this request."}
            </p>
          )}

          {(config.pathParams ?? []).length > 0 && (
            <div className="space-y-1.5 mt-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Path parameters
              </p>
              {(config.pathParams ?? []).map((p) => (
                <div key={p.name} className="flex items-center gap-2">
                  <code className="text-xs font-mono w-24 shrink-0 text-muted-foreground">
                    {p.name}
                  </code>
                  <input
                    type="text"
                    placeholder={p.placeholder}
                    value={pathValues[p.name] ?? ""}
                    onChange={(e) =>
                      setPathValues((v) => ({ ...v, [p.name]: e.target.value }))
                    }
                    className="flex-1 text-xs font-mono border border-border rounded px-2 py-1 bg-background focus:outline-none focus:ring-1 focus:ring-primary/30"
                  />
                </div>
              ))}
            </div>
          )}

          {(config.queryParams ?? []).length > 0 && (
            <div className="space-y-1.5 mt-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Query parameters
              </p>
              {(config.queryParams ?? []).map((p) => (
                <div key={p.name} className="flex items-center gap-2">
                  <code className="text-xs font-mono w-24 shrink-0 text-muted-foreground">
                    {p.name}
                  </code>
                  <input
                    type="text"
                    placeholder={p.placeholder}
                    value={queryValues[p.name] ?? ""}
                    onChange={(e) =>
                      setQueryValues((v) => ({ ...v, [p.name]: e.target.value }))
                    }
                    className="flex-1 text-xs font-mono border border-border rounded px-2 py-1 bg-background focus:outline-none focus:ring-1 focus:ring-primary/30"
                  />
                </div>
              ))}
            </div>
          )}

          {(config.bodyFields ?? []).length > 0 && (
            <div className="space-y-1.5 mt-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Request body
              </p>
              {(config.bodyFields ?? []).map((f) => (
                <div key={f.name} className="flex items-center gap-2">
                  <code className="text-xs font-mono w-24 shrink-0 text-muted-foreground">
                    {f.name}
                  </code>
                  {f.type === "select" ? (
                    <select
                      value={bodyValues[f.name] ?? ""}
                      onChange={(e) =>
                        setBodyValues((v) => ({ ...v, [f.name]: e.target.value }))
                      }
                      className="flex-1 text-xs font-mono border border-border rounded px-2 py-1 bg-background focus:outline-none focus:ring-1 focus:ring-primary/30"
                    >
                      <option value="">— select —</option>
                      {(f.options ?? []).map((o) => (
                        <option key={o} value={o}>
                          {o}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type={f.type === "number" ? "number" : "text"}
                      placeholder={f.placeholder}
                      value={bodyValues[f.name] ?? ""}
                      onChange={(e) =>
                        setBodyValues((v) => ({ ...v, [f.name]: e.target.value }))
                      }
                      className="flex-1 text-xs font-mono border border-border rounded px-2 py-1 bg-background focus:outline-none focus:ring-1 focus:ring-primary/30"
                    />
                  )}
                </div>
              ))}
            </div>
          )}

          {config.note && (
            <p className="text-xs text-muted-foreground italic">{config.note}</p>
          )}

          <div className="flex items-center gap-2 mt-2">
            <button
              onClick={send}
              disabled={loading || tokenMissing}
              className="flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? <Loader2 size={11} className="animate-spin" /> : <Play size={11} />}
              Send
            </button>
            <code className="text-xs text-muted-foreground font-mono truncate max-w-xs">
              {buildUrl()}
            </code>
          </div>

          {response !== null && (
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    "text-xs font-bold font-mono px-1.5 py-0.5 rounded",
                    response.ok
                      ? "bg-green-100 text-green-800"
                      : "bg-red-100 text-red-800",
                  )}
                >
                  {response.status || "ERR"}
                </span>
                <span className="text-xs text-muted-foreground">
                  {response.ok ? "OK" : "Error"}
                </span>
              </div>
              <div
                className="bg-[#0d1117] rounded-lg p-3 overflow-x-auto max-h-64 font-mono text-xs leading-relaxed"
                dangerouslySetInnerHTML={{
                  __html: highlightJson(response.body),
                }}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared token input bar
// ---------------------------------------------------------------------------

function TokenBar() {
  const { apiKey, setApiKey, driverToken, setDriverToken } = useContext(TryItContext);

  function clearTokens() {
    setApiKey("");
    setDriverToken("");
    try { localStorage.removeItem(LS_API_KEY); } catch { /* ignore */ }
    try { localStorage.removeItem(LS_DRIVER_TOKEN); } catch { /* ignore */ }
  }

  const hasTokens = apiKey.length > 0 || driverToken.length > 0;

  return (
    <div className="border border-border rounded-xl bg-secondary/30 px-4 py-3 space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Tokens — reused by all Try It panels below
        </p>
        {hasTokens && (
          <button
            type="button"
            onClick={clearTokens}
            title="Clear saved tokens"
            className="flex items-center gap-1 text-xs text-muted-foreground/60 hover:text-destructive transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Clear
          </button>
        )}
      </div>
      <div className="grid sm:grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">
            Print Agent API key
          </label>
          <input
            type="password"
            placeholder="pk_live_…"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className="w-full text-xs font-mono border border-border rounded px-2 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary/30"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">
            Fleet driver token
          </label>
          <input
            type="password"
            placeholder="fdt_live_…"
            value={driverToken}
            onChange={(e) => setDriverToken(e.target.value)}
            className="w-full text-xs font-mono border border-border rounded px-2 py-1.5 bg-background focus:outline-none focus:ring-1 focus:ring-primary/30"
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground/70">
        Values are saved in this browser's localStorage only and never sent to our servers.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Existing helpers
// ---------------------------------------------------------------------------

function CodeBlock({ code, lang = "bash" }: { code: string; lang?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(code.trim());
    setCopied(true);
    setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
  };
  return (
    <div className="relative group">
      <pre
        className={cn(
          "bg-[#0d1117] text-[#e6edf3] text-xs leading-relaxed rounded-lg p-4 overflow-x-auto font-mono",
          `language-${lang}`,
        )}
      >
        <code>{code.trim()}</code>
      </pre>
      <button
        onClick={copy}
        className="absolute top-2.5 right-2.5 p-1.5 rounded-md bg-white/10 hover:bg-white/20 text-white/70 hover:text-white transition-all opacity-0 group-hover:opacity-100"
        title="Copy"
      >
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
    </div>
  );
}

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section id={id} className="space-y-4 scroll-mt-6">
      <h2 className="text-xl font-semibold border-b border-border pb-2">{title}</h2>
      {children}
    </section>
  );
}

function Endpoint({
  method,
  path,
  description,
  children,
  tryIt,
}: {
  method: string;
  path: string;
  description: string;
  children?: React.ReactNode;
  tryIt?: TryItConfig;
}) {
  const color =
    method === "GET"
      ? "bg-blue-100 text-blue-800"
      : method === "POST"
        ? "bg-green-100 text-green-800"
        : method === "DELETE"
          ? "bg-red-100 text-red-800"
          : method === "PATCH"
            ? "bg-orange-100 text-orange-800"
            : "bg-yellow-100 text-yellow-800";

  return (
    <div className="border border-border rounded-xl overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3 bg-secondary/50">
        <span className={cn("text-xs font-bold px-2 py-0.5 rounded font-mono", color)}>
          {method}
        </span>
        <code className="text-sm font-mono font-medium">{path}</code>
      </div>
      <div className="px-4 py-3 space-y-3">
        <p className="text-sm text-muted-foreground">{description}</p>
        {children}
        {tryIt && <TryItPanel config={tryIt} />}
      </div>
    </div>
  );
}

function Field({
  name,
  type,
  required,
  desc,
}: {
  name: string;
  type: string;
  required?: boolean;
  desc: string;
}) {
  return (
    <tr className="border-b border-border last:border-0">
      <td className="py-2 pr-4 font-mono text-xs font-medium">{name}</td>
      <td className="py-2 pr-4 text-xs text-muted-foreground">{type}</td>
      <td className="py-2 pr-4 text-xs">
        {required ? (
          <span className="text-red-600 font-medium">required</span>
        ) : (
          <span className="text-muted-foreground">optional</span>
        )}
      </td>
      <td className="py-2 text-xs text-muted-foreground">{desc}</td>
    </tr>
  );
}

function QuickStartSidebar({ activeId }: { activeId: string }) {
  return (
    <nav className="hidden lg:block sticky top-6 self-start w-48 shrink-0">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
        On this page
      </p>
      <ul className="space-y-1">
        {SECTIONS.map((s) => (
          <li key={s.id}>
            <a
              href={`#${s.id}`}
              className={cn(
                "block text-sm py-1 px-2 rounded transition-colors hover:text-foreground hover:bg-secondary/60",
                activeId === s.id
                  ? "text-foreground font-medium bg-secondary/60"
                  : "text-muted-foreground",
              )}
            >
              {s.title}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function useActiveSection(ids: string[]): string {
  const [activeId, setActiveId] = useState(ids[0] ?? "");
  const observerRef = useRef<IntersectionObserver | null>(null);

  useEffect(() => {
    observerRef.current?.disconnect();
    const visible = new Set<string>();

    observerRef.current = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) visible.add(e.target.id);
          else visible.delete(e.target.id);
        });
        const first = ids.find((id) => visible.has(id));
        if (first) setActiveId(first);
      },
      { rootMargin: "0px 0px -60% 0px", threshold: 0 },
    );

    ids.forEach((id) => {
      const el = document.getElementById(id);
      if (el) observerRef.current!.observe(el);
    });

    return () => observerRef.current?.disconnect();
  }, [ids]);

  return activeId;
}

const LS_API_KEY = "tryit_api_key";
const LS_DRIVER_TOKEN = "tryit_driver_token";

// ---------------------------------------------------------------------------
// WorkspaceSlugBanner — shows the workspace slug with a one-click copy button
// ---------------------------------------------------------------------------

interface WorkspaceSettings {
  workspace_slug?: string | null;
}

function WorkspaceSlugBanner() {
  const [copied, setCopied] = useState(false);
  const { data, isLoading } = useQuery<WorkspaceSettings>({
    queryKey: ["workspace-settings"],
    queryFn: () => apiFetch<WorkspaceSettings>("/api/settings"),
  });

  const slug = data?.workspace_slug ?? null;
  const paramValue = slug ? `?workspace=${slug}` : null;

  const copyParam = () => {
    if (!paramValue) return;
    navigator.clipboard.writeText(paramValue);
    setCopied(true);
    setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
  };

  if (isLoading) return null;

  if (!slug) {
    return (
      <div className="flex items-center gap-3 border border-amber-200 bg-amber-50 rounded-xl px-4 py-3">
        <div className="flex-1 min-w-0">
          <p className="text-xs font-semibold text-amber-800 mb-0.5">Workspace slug not set</p>
          <p className="text-xs text-amber-700">
            Set a workspace slug in Settings so integrators can identify your workspace in public API calls.
          </p>
        </div>
        <Link
          to="/dashboard/settings"
          className="flex items-center gap-1.5 shrink-0 text-xs font-medium text-amber-800 hover:text-amber-900 border border-amber-300 hover:border-amber-400 bg-amber-100 hover:bg-amber-200 px-3 py-1.5 rounded-lg transition-colors"
        >
          <Settings size={12} />
          Settings
        </Link>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 border border-border bg-secondary/30 rounded-xl px-4 py-3">
      <div className="flex-1 min-w-0">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-1">
          Your workspace slug
        </p>
        <code className="text-sm font-mono font-medium">{slug}</code>
        <p className="text-xs text-muted-foreground mt-1">
          Append <code className="font-mono bg-secondary px-1 py-0.5 rounded">{paramValue}</code> to public catalog endpoints to scope results to your workspace.
        </p>
      </div>
      <button
        onClick={copyParam}
        title={`Copy ${paramValue}`}
        className="flex items-center gap-1.5 shrink-0 text-xs font-medium px-3 py-1.5 rounded-lg border border-border bg-background hover:bg-secondary/60 transition-colors"
      >
        {copied ? <Check size={13} className="text-green-600" /> : <Copy size={13} />}
        {copied ? "Copied!" : "Copy param"}
      </button>
    </div>
  );
}

function QuickStartContent() {
  const activeId = useActiveSection(SECTIONS.map((s) => s.id));
  const [apiKey, setApiKey] = useState(() => {
    try { return localStorage.getItem(LS_API_KEY) ?? ""; } catch { return ""; }
  });
  const [driverToken, setDriverToken] = useState(() => {
    try { return localStorage.getItem(LS_DRIVER_TOKEN) ?? ""; } catch { return ""; }
  });

  const { user: clerkUser } = useUser();
  const workspaceOwnerId = clerkUser?.id ?? null;

  const { data: workspaceSettings } = useQuery<WorkspaceSettings>({
    queryKey: ["workspace-settings"],
    queryFn: () => apiFetch<WorkspaceSettings>("/api/settings"),
  });
  const workspaceSlug = workspaceSettings?.workspace_slug?.trim() || null;
  const wsParam = workspaceSlug ?? "user_xyz";

  useEffect(() => {
    const t = setTimeout(() => {
      try { localStorage.setItem(LS_API_KEY, apiKey); } catch { /* ignore */ }
    }, 400);
    return () => clearTimeout(t);
  }, [apiKey]);

  useEffect(() => {
    const t = setTimeout(() => {
      try { localStorage.setItem(LS_DRIVER_TOKEN, driverToken); } catch { /* ignore */ }
    }, 400);
    return () => clearTimeout(t);
  }, [driverToken]);

  return (
    <TryItContext.Provider value={{ apiKey, setApiKey, driverToken, setDriverToken }}>
      <div className="space-y-6">
        <WorkspaceSlugBanner />
        <TokenBar />

        <div className="flex gap-10">
          <QuickStartSidebar activeId={activeId} />

          <div className="min-w-0 flex-1 space-y-10">
            <Section id="base-urls" title="Base URLs">
              <p className="text-sm text-muted-foreground">
                Presentail exposes two separate API hosts. Make sure you target the right one for the
                endpoint group you are integrating with.
              </p>
              <div className="grid sm:grid-cols-2 gap-4">
                <div className="border border-border rounded-xl p-4 space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Print Agent Service
                  </p>
                  <code className="block text-sm font-mono font-medium break-all">
                    {PRINT_AGENT_BASE}
                  </code>
                  <p className="text-xs text-muted-foreground">
                    Used for submitting and polling print jobs and listing registered devices. Requires
                    an API key (<code className="font-mono bg-secondary px-1 rounded">pk_live_…</code>
                    ).
                  </p>
                </div>
                <div className="border border-border rounded-xl p-4 space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Presentail OS API
                  </p>
                  <code className="block text-sm font-mono font-medium break-all">{OS_API_BASE}</code>
                  <p className="text-xs text-muted-foreground">
                    Used for public catalog data, delivery locations, the Fleet driver API, and admin
                    delivery-city management. Auth requirements vary per endpoint group.
                  </p>
                </div>
              </div>
            </Section>

            <Section id="auth" title="Authentication">
              <p className="text-sm text-muted-foreground">
                Every request to the Print Agent Service must include your API key as a Bearer token in
                the{" "}
                <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">
                  Authorization
                </code>{" "}
                header. Generate keys on the{" "}
                <a href="/api-keys" className="underline text-primary">
                  API Keys
                </a>{" "}
                page.
              </p>
              <CodeBlock code={`Authorization: Bearer pk_live_YOUR_KEY_HERE`} />
              <div className="text-sm text-muted-foreground rounded-lg border border-amber-200 bg-amber-50 px-4 py-3">
                Keep your API key secret. It authorises print jobs on your behalf and should never be
                committed to source control.
              </div>
              <div className="text-sm text-muted-foreground rounded-lg border border-border bg-secondary/40 px-4 py-3 space-y-1">
                <p className="font-medium text-foreground">Read access to the Presentail OS API</p>
                <p>
                  The same API key also grants{" "}
                  <span className="font-medium text-foreground">read-only</span> access to every
                  workspace endpoint of the Presentail OS API, scoped to your workspace with
                  owner-level visibility. Send it as{" "}
                  <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">
                    Authorization: Bearer pk_live_…
                  </code>{" "}
                  (also accepted via the{" "}
                  <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">x-api-key</code>{" "}
                  header or{" "}
                  <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">?apiKey=</code>{" "}
                  query parameter). The workspace is derived from the key, so no{" "}
                  <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">owner</code>/
                  <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">workspace</code>{" "}
                  parameter is needed.
                </p>
                <p>
                  API-key access is limited to{" "}
                  <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">GET</code>/
                  <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">HEAD</code>{" "}
                  requests. Writes (<code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">POST</code>/
                  <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">PUT</code>/
                  <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">PATCH</code>/
                  <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">DELETE</code>)
                  always require a signed-in session — an API key can never modify data.
                </p>
              </div>
            </Section>

            <Section id="submit" title="Submit a Print Job">
              <Endpoint
                method="POST"
                path={`${PRINT_AGENT_BASE}/api/jobs`}
                description="Upload a PDF and queue it for printing on a registered device. The agent polls for new jobs every 10 seconds and prints them automatically."
              >
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Request — multipart/form-data
                </p>
                <table className="w-full text-sm">
                  <tbody>
                    <Field name="file" type="binary (PDF)" required desc="The PDF file to print." />
                    <Field
                      name="device_id"
                      type="string"
                      required
                      desc="ID of the target device (from /api/devices or the Devices page)."
                    />
                    <Field
                      name="printer"
                      type="string"
                      desc="Printer name on the device. Omit to use the system default."
                    />
                    <Field
                      name="copies"
                      type="integer"
                      desc="Number of copies (default: 1, max: 99)."
                    />
                    <Field
                      name="title"
                      type="string"
                      desc="Job title shown in the print queue (default: filename)."
                    />
                  </tbody>
                </table>

                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mt-2">
                  Response
                </p>
                <CodeBlock
                  lang="json"
                  code={`{
  "id": 42,
  "status": "pending",
  "created_at": "2025-04-26T12:00:00.000Z"
}`}
                />

                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mt-2">
                  curl example
                </p>
                <CodeBlock
                  code={`curl -X POST ${PRINT_AGENT_BASE}/api/jobs \\
  -H "Authorization: Bearer pk_live_YOUR_KEY" \\
  -F "file=@/path/to/document.pdf" \\
  -F "device_id=123" \\
  -F "printer=My_Printer" \\
  -F "copies=1" \\
  -F "title=My Document"`}
                />

                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mt-2">
                  Python example
                </p>
                <CodeBlock
                  lang="python"
                  code={`import requests

API_KEY = "pk_live_YOUR_KEY"
DEVICE_ID = "123"

with open("document.pdf", "rb") as f:
    resp = requests.post(
        "${PRINT_AGENT_BASE}/api/jobs",
        headers={"Authorization": f"Bearer {API_KEY}"},
        files={"file": ("document.pdf", f, "application/pdf")},
        data={
            "device_id": DEVICE_ID,
            "printer": "My_Printer",   # optional
            "copies": "1",
            "title": "My Document",
        },
    )

job = resp.json()
print(f"Job #{job['id']} → {job['status']}")`}
                />
              </Endpoint>
            </Section>

            <Section id="status" title="Check Job Status">
              <Endpoint
                method="GET"
                path={`${PRINT_AGENT_BASE}/api/jobs/:id`}
                description="Poll for the current status of a job. Status transitions: pending → claimed → done / failed."
                tryIt={{
                  method: "GET",
                  baseUrl: PRINT_AGENT_BASE,
                  path: "/api/jobs/{id}",
                  authType: "api-key",
                  pathParams: [{ name: "id", placeholder: "42", required: true }],
                }}
              >
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Response
                </p>
                <CodeBlock
                  lang="json"
                  code={`{
  "job": {
    "id": 42,
    "status": "done",
    "printer_name": "My_Printer",
    "file_name": "My Document",
    "copies": 1,
    "error": null,
    "created_at": "2025-04-26T12:00:00.000Z",
    "claimed_at": "2025-04-26T12:00:10.000Z",
    "completed_at": "2025-04-26T12:00:11.000Z"
  }
}`}
                />
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mt-2">
                  curl example
                </p>
                <CodeBlock
                  code={`curl ${PRINT_AGENT_BASE}/api/jobs/42 \\
  -H "Authorization: Bearer pk_live_YOUR_KEY"`}
                />
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mt-2">
                  Python polling example
                </p>
                <CodeBlock
                  lang="python"
                  code={`import time, requests

API_KEY = "pk_live_YOUR_KEY"
JOB_ID = 42

while True:
    resp = requests.get(
        f"${PRINT_AGENT_BASE}/api/jobs/{JOB_ID}",
        headers={"Authorization": f"Bearer {API_KEY}"},
    )
    job = resp.json()["job"]
    print(f"Status: {job['status']}")
    if job["status"] in ("done", "failed"):
        break
    time.sleep(5)`}
                />
              </Endpoint>
            </Section>

            <Section id="devices" title="List Devices">
              <Endpoint
                method="GET"
                path={`${PRINT_AGENT_BASE}/api/devices`}
                description="List all registered devices (agents) on your account. Use the returned id as device_id when submitting jobs."
                tryIt={{
                  method: "GET",
                  baseUrl: PRINT_AGENT_BASE,
                  path: "/api/devices",
                  authType: "api-key",
                  note: "This endpoint requires a Clerk session token on the production server; the API key is sent here for reference.",
                }}
              >
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  curl example
                </p>
                <CodeBlock
                  code={`curl ${PRINT_AGENT_BASE}/api/devices \\
  -H "Authorization: Bearer pk_live_YOUR_KEY"`}
                />
                <p className="text-xs text-muted-foreground">
                  Note: This endpoint requires a Clerk session token, not an API key. Use the dashboard
                  to look up your device IDs.
                </p>
              </Endpoint>
            </Section>

            <Section id="statuses" title="Job Status Reference">
              <div className="border border-border rounded-xl overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-secondary/50 text-left">
                      <th className="px-4 py-2 font-semibold text-xs">Status</th>
                      <th className="px-4 py-2 font-semibold text-xs">Meaning</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      ["pending", "Job received — waiting for the agent to pick it up."],
                      ["claimed", "Agent has downloaded the PDF and is printing."],
                      ["done", "Printed successfully."],
                      ["failed", "Print failed. Check the error field for details."],
                    ].map(([status, meaning]) => (
                      <tr key={status} className="border-t border-border">
                        <td className="px-4 py-2">
                          <code className="font-mono text-xs bg-secondary px-1.5 py-0.5 rounded">
                            {status}
                          </code>
                        </td>
                        <td className="px-4 py-2 text-muted-foreground text-xs">{meaning}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>

            <Section id="public" title="Public (Unauthenticated) Endpoints">
              <p className="text-sm text-muted-foreground">
                These read-only endpoints do not require an API key. They are intended for storefronts
                and public catalog surfaces that need to know which countries, cities, and products are
                available in your workspace. The target workspace is selected via the{" "}
                <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">workspace</code>{" "}
                query parameter (your workspace owner id). Base URL:{" "}
                <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">
                  {OS_API_BASE}
                </code>
              </p>

              <Endpoint
                method="GET"
                path="/api/delivery-locations?workspace={ownerId}"
                description="Returns the list of active delivery countries for the workspace, each with their active delivery cities. Only countries and cities with delivery_active = true are included. Requires the workspace query parameter (your workspace owner ID). Errors: 400 if workspace is missing."
                tryIt={{
                  method: "GET",
                  baseUrl: OS_API_BASE,
                  path: "/api/delivery-locations",
                  authType: "none",
                  queryParams: [
                    { name: "workspace", placeholder: "user_xyz…", required: true },
                  ],
                  defaultQueryValues: workspaceSlug ? { workspace: workspaceSlug } : undefined,
                }}
              >
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Query parameters
                </p>
                <table className="w-full text-sm">
                  <tbody>
                    <Field
                      name="workspace"
                      type="string"
                      required
                      desc="Your workspace owner ID (Clerk user ID). Found on the Settings page."
                    />
                  </tbody>
                </table>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mt-2">
                  curl example
                </p>
                <CodeBlock
                  code={`curl "${OS_API_BASE}/api/delivery-locations?workspace=${wsParam}"`}
                />
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mt-2">
                  Response
                </p>
                <CodeBlock
                  lang="json"
                  code={`{
  "countries": [
    {
      "name": "Lebanon",
      "code": "LB",
      "flagImageUrl": "https://os.presentail.com/api/storage/objects/...",
      "cities": [
        { "id": 1, "name": "Beirut", "slug": "beirut" },
        { "id": 2, "name": "Tripoli", "slug": "tripoli" }
      ]
    }
  ]
}`}
                />
                <p className="text-xs text-muted-foreground">
                  Only countries and cities that are marked as delivery-active in your workspace settings
                  are returned. No authentication is required.
                </p>
              </Endpoint>

              <Endpoint
                method="GET"
                path="/api/public/locations?workspace={ownerId}"
                description="⚠️ Deprecated — use GET /api/delivery-locations instead. Returns active countries with their active cities from the legacy cities table. This endpoint does not check the delivery_active flag and has no stability guarantee. It will be removed in a future release."
                tryIt={{
                  method: "GET",
                  baseUrl: OS_API_BASE,
                  path: "/api/public/locations",
                  authType: "none",
                  queryParams: [
                    { name: "workspace", placeholder: "user_xyz…", required: true },
                  ],
                  defaultQueryValues: workspaceSlug ? { workspace: workspaceSlug } : undefined,
                }}
              >
                <CodeBlock
                  code={`curl "${OS_API_BASE}/api/public/locations?workspace=${wsParam}"`}
                />
                <CodeBlock
                  lang="json"
                  code={`{
  "countries": [
    {
      "country": "Lebanon",
      "cities": [
        { "id": 1, "name": "Beirut", "slug": "beirut" },
        { "id": 2, "name": "Tripoli", "slug": "tripoli" }
      ]
    }
  ]
}`}
                />
              </Endpoint>

              <Endpoint
                method="GET"
                path="/api/public/products/{productId}/availability?workspace={ownerId}"
                description="Returns the active cities a product is available in, restricted to the workspace's currently active countries. Errors: 400 if workspace is missing or the product id is invalid; 404 if the product does not belong to the workspace."
                tryIt={{
                  method: "GET",
                  baseUrl: OS_API_BASE,
                  path: "/api/public/products/{productId}/availability",
                  authType: "none",
                  pathParams: [{ name: "productId", placeholder: "42", required: true }],
                  queryParams: [
                    { name: "workspace", placeholder: "user_xyz…", required: true },
                  ],
                  defaultQueryValues: workspaceSlug ? { workspace: workspaceSlug } : undefined,
                }}
              >
                <CodeBlock
                  code={`curl "${OS_API_BASE}/api/public/products/42/availability?workspace=${wsParam}"`}
                />
                <CodeBlock
                  lang="json"
                  code={`{
  "product_id": 42,
  "cities": [
    { "id": 1, "name": "Beirut", "slug": "beirut", "country": "Lebanon" }
  ]
}`}
                />
              </Endpoint>

              <Endpoint
                method="GET"
                path="/api/public/catalog/products?workspace={ownerId}"
                description="Returns a paginated list of available products for the workspace. Filter by brand, category, city, or a search query. No authentication required."
                tryIt={{
                  method: "GET",
                  baseUrl: OS_API_BASE,
                  path: "/api/public/catalog/products",
                  authType: "none",
                  queryParams: [
                    { name: "workspace", placeholder: "user_xyz…", required: true },
                    { name: "city_slug", placeholder: "beirut" },
                    { name: "brand", placeholder: "Rose & Co" },
                    { name: "category", placeholder: "flowers" },
                    { name: "q", placeholder: "birthday" },
                    { name: "page", placeholder: "1" },
                    { name: "pageSize", placeholder: "25" },
                    { name: "include_unavailable", placeholder: "false" },
                  ],
                  defaultQueryValues: workspaceSlug ? { workspace: workspaceSlug } : undefined,
                }}
              >
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Query parameters
                </p>
                <table className="w-full text-sm">
                  <tbody>
                    <Field
                      name="workspace"
                      type="string"
                      required
                      desc="Your workspace owner ID (Clerk user ID or workspace slug). Found on the Settings page."
                    />
                    <Field
                      name="city_slug"
                      type="string"
                      desc="Optional. Restrict results to products available in the given city slug (e.g. beirut)."
                    />
                    <Field
                      name="brand"
                      type="string"
                      desc="Optional. Filter by brand name (case-insensitive partial match)."
                    />
                    <Field
                      name="category"
                      type="string"
                      desc="Optional. Filter by category name (case-insensitive partial match)."
                    />
                    <Field
                      name="q"
                      type="string"
                      desc="Optional. Search by product name or SKU."
                    />
                    <Field
                      name="page"
                      type="number"
                      desc="Optional. Page number (1-based). Defaults to 1."
                    />
                    <Field
                      name="pageSize"
                      type="number"
                      desc="Optional. Items per page. Allowed values: 10, 25, 50, 100. Defaults to 25."
                    />
                    <Field
                      name="include_unavailable"
                      type="boolean"
                      desc='Optional. Set to "true" to include out-of-stock and unavailable products. Defaults to false.'
                    />
                  </tbody>
                </table>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mt-2">
                  curl example
                </p>
                <CodeBlock
                  code={`curl "${OS_API_BASE}/api/public/catalog/products?workspace=${wsParam}"`}
                />
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mt-2">
                  Response
                </p>
                <CodeBlock
                  lang="json"
                  code={`{
  "products": [
    {
      "id": 42,
      "name": "Rose Bouquet",
      "price_usd": "49.99",
      "price_aed": "183.50",
      "main_image_url": "https://os.presentail.com/api/storage/objects/...",
      "additional_image_urls": [],
      "description": "A beautiful arrangement of red roses.",
      "status": "available",
      "brand": "Rose & Co",
      "tags": ["roses", "romantic"],
      "category": "Flowers",
      "sku": "RC-001",
      "updated_at": "2026-01-15T10:00:00.000Z",
      "express_delivery_enabled": true,
      "occasions": [{ "id": 1, "name": "Birthday", "slug": "birthday" }],
      "recipients": [{ "id": 2, "name": "Her", "slug": "her" }]
    }
  ],
  "total": 1,
  "page": 1,
  "pageSize": 25,
  "totalPages": 1
}`}
                />
              </Endpoint>

              <Endpoint
                method="GET"
                path="/api/public/catalog/products/:id?workspace={ownerId}"
                description="Returns the full detail of a single available product by its numeric ID. No authentication required."
                tryIt={{
                  method: "GET",
                  baseUrl: OS_API_BASE,
                  path: "/api/public/catalog/products/:productId",
                  authType: "none",
                  pathParams: [{ name: "productId", placeholder: "42", required: true }],
                  queryParams: [
                    { name: "workspace", placeholder: "user_xyz…", required: true },
                  ],
                  defaultQueryValues: workspaceSlug ? { workspace: workspaceSlug } : undefined,
                }}
              >
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Path parameters
                </p>
                <table className="w-full text-sm">
                  <tbody>
                    <Field
                      name="productId"
                      type="number"
                      required
                      desc="Numeric product ID."
                    />
                  </tbody>
                </table>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mt-2">
                  Query parameters
                </p>
                <table className="w-full text-sm">
                  <tbody>
                    <Field
                      name="workspace"
                      type="string"
                      required
                      desc="Your workspace owner ID (Clerk user ID or workspace slug). Found on the Settings page."
                    />
                  </tbody>
                </table>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mt-2">
                  curl example
                </p>
                <CodeBlock
                  code={`curl "${OS_API_BASE}/api/public/catalog/products/42?workspace=${wsParam}"`}
                />
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mt-2">
                  Response
                </p>
                <CodeBlock
                  lang="json"
                  code={`{
  "product": {
    "id": 42,
    "name": "Rose Bouquet",
    "price_usd": "49.99",
    "price_aed": "183.50",
    "main_image_url": "https://os.presentail.com/api/storage/objects/...",
    "additional_image_urls": [],
    "description": "A beautiful arrangement of red roses.",
    "status": "available",
    "brand": "Rose & Co",
    "tags": ["roses", "romantic"],
    "category": "Flowers",
    "sku": "RC-001",
    "updated_at": "2026-01-15T10:00:00.000Z",
    "express_delivery_enabled": true,
    "occasions": [{ "id": 1, "name": "Birthday", "slug": "birthday" }],
    "recipients": [{ "id": 2, "name": "Her", "slug": "her" }]
  }
}`}
                />
              </Endpoint>

              <Endpoint
                method="GET"
                path="/api/public/catalog/base-items?workspace={ownerId}"
                description="Returns a paginated list of base items (raw catalog components) with their packaging definitions. Filter by category or a search query. No authentication required."
                tryIt={{
                  method: "GET",
                  baseUrl: OS_API_BASE,
                  path: "/api/public/catalog/base-items",
                  authType: "none",
                  queryParams: [
                    { name: "workspace", placeholder: "user_xyz…", required: true },
                    { name: "category_id", placeholder: "3" },
                    { name: "q", placeholder: "rose" },
                    { name: "page", placeholder: "1" },
                    { name: "pageSize", placeholder: "25" },
                    { name: "include_inactive", placeholder: "false" },
                  ],
                  defaultQueryValues: workspaceSlug ? { workspace: workspaceSlug } : undefined,
                }}
              >
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Query parameters
                </p>
                <table className="w-full text-sm">
                  <tbody>
                    <Field
                      name="workspace"
                      type="string"
                      required
                      desc="Your workspace owner ID (Clerk user ID or workspace slug). Found on the Settings page."
                    />
                    <Field
                      name="category_id"
                      type="number"
                      desc="Optional. Filter by base-item category ID."
                    />
                    <Field
                      name="q"
                      type="string"
                      desc="Optional. Search by base-item name or code."
                    />
                    <Field
                      name="page"
                      type="number"
                      desc="Optional. Page number (1-based). Defaults to 1."
                    />
                    <Field
                      name="pageSize"
                      type="number"
                      desc="Optional. Items per page. Allowed values: 10, 25, 50, 100. Defaults to 25."
                    />
                    <Field
                      name="include_inactive"
                      type="boolean"
                      desc='Optional. Set to "true" to include non-active base items. Defaults to false.'
                    />
                  </tbody>
                </table>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mt-2">
                  curl example
                </p>
                <CodeBlock
                  code={`curl "${OS_API_BASE}/api/public/catalog/base-items?workspace=${wsParam}"`}
                />
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mt-2">
                  Response
                </p>
                <CodeBlock
                  lang="json"
                  code={`{
  "base_items": [
    {
      "id": 1,
      "name": "Red Roses",
      "code": "RR-01",
      "image_url": "https://os.presentail.com/api/storage/objects/...",
      "category_id": 3,
      "main_category_name": "Flowers",
      "sub_category_name": "Roses",
      "status": "active",
      "type": "flower",
      "updated_at": "2026-01-15T10:00:00.000Z",
      "packages": [
        { "id": 11, "name": "Bunch", "unit": "stems", "quantity": 10, "is_default": true }
      ]
    }
  ],
  "total": 1,
  "page": 1,
  "pageSize": 25,
  "totalPages": 1
}`}
                />
              </Endpoint>

              <Endpoint
                method="GET"
                path="/api/public/catalog/base-items/:id?workspace={ownerId}"
                description="Returns the full detail of a single base item, including its packaging definitions, by numeric ID. No authentication required."
                tryIt={{
                  method: "GET",
                  baseUrl: OS_API_BASE,
                  path: "/api/public/catalog/base-items/:baseItemId",
                  authType: "none",
                  pathParams: [{ name: "baseItemId", placeholder: "1", required: true }],
                  queryParams: [
                    { name: "workspace", placeholder: "user_xyz…", required: true },
                  ],
                  defaultQueryValues: workspaceSlug ? { workspace: workspaceSlug } : undefined,
                }}
              >
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Path parameters
                </p>
                <table className="w-full text-sm">
                  <tbody>
                    <Field
                      name="baseItemId"
                      type="number"
                      required
                      desc="Numeric base-item ID."
                    />
                  </tbody>
                </table>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mt-2">
                  Query parameters
                </p>
                <table className="w-full text-sm">
                  <tbody>
                    <Field
                      name="workspace"
                      type="string"
                      required
                      desc="Your workspace owner ID (Clerk user ID or workspace slug). Found on the Settings page."
                    />
                  </tbody>
                </table>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mt-2">
                  curl example
                </p>
                <CodeBlock
                  code={`curl "${OS_API_BASE}/api/public/catalog/base-items/1?workspace=${wsParam}"`}
                />
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mt-2">
                  Response
                </p>
                <CodeBlock
                  lang="json"
                  code={`{
  "base_item": {
    "id": 1,
    "name": "Red Roses",
    "code": "RR-01",
    "image_url": "https://os.presentail.com/api/storage/objects/...",
    "category_id": 3,
    "main_category_name": "Flowers",
    "sub_category_name": "Roses",
    "status": "active",
    "type": "flower",
    "updated_at": "2026-01-15T10:00:00.000Z",
    "packages": [
      { "id": 11, "name": "Bunch", "unit": "stems", "quantity": 10, "is_default": true }
    ]
  }
}`}
                />
              </Endpoint>

              <Endpoint
                method="GET"
                path="/api/public/catalog/banners?workspace={ownerId}"
                description="Returns the list of active homepage banners for the workspace, ordered by sort_order and priority. No authentication required."
                tryIt={{
                  method: "GET",
                  baseUrl: OS_API_BASE,
                  path: "/api/public/catalog/banners",
                  authType: "none",
                  queryParams: [
                    { name: "workspace", placeholder: "user_xyz…", required: true },
                  ],
                  defaultQueryValues: workspaceSlug ? { workspace: workspaceSlug } : undefined,
                }}
              >
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Query parameters
                </p>
                <table className="w-full text-sm">
                  <tbody>
                    <Field
                      name="workspace"
                      type="string"
                      required
                      desc="Your workspace owner ID (Clerk user ID or workspace slug). Found on the Settings page."
                    />
                  </tbody>
                </table>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mt-2">
                  curl example
                </p>
                <CodeBlock
                  code={`curl "${OS_API_BASE}/api/public/catalog/banners?workspace=${wsParam}"`}
                />
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mt-2">
                  Response
                </p>
                <CodeBlock
                  lang="json"
                  code={`{
  "banners": [
    {
      "id": 1,
      "internal_name": "Summer Sale",
      "title": "Summer Collection",
      "headline": "Up to 40% off",
      "subtitle": "Shop now and save",
      "cta_text": "Shop Now",
      "country_codes": ["LB"],
      "city_ids": [1, 2],
      "is_global_for_country": false,
      "desktop": {
        "enabled": true,
        "media_type": "image",
        "media_url": "https://os.presentail.com/api/storage/objects/...",
        "fallback_image_url": null,
        "link_url": "https://example.com/summer"
      },
      "mobile": {
        "enabled": true,
        "media_type": "image",
        "media_url": "https://os.presentail.com/api/storage/objects/...",
        "fallback_image_url": null,
        "link_url": "https://example.com/summer"
      },
      "start_at": "2026-06-01T00:00:00.000Z",
      "end_at": "2026-08-31T23:59:59.000Z",
      "sort_order": 0,
      "priority": 1
    }
  ]
}`}
                />
              </Endpoint>

              <Endpoint
                method="GET"
                path="/api/public/catalog/occasions?workspace={ownerId}"
                description="Returns the list of active occasions for the workspace. Pass an optional city_slug to restrict results to occasions available in that city. No authentication required."
                tryIt={{
                  method: "GET",
                  baseUrl: OS_API_BASE,
                  path: "/api/public/catalog/occasions",
                  authType: "none",
                  queryParams: [
                    { name: "workspace", placeholder: "user_xyz…", required: true },
                    { name: "city_slug", placeholder: "beirut" },
                  ],
                  defaultQueryValues: workspaceSlug ? { workspace: workspaceSlug } : undefined,
                }}
              >
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Query parameters
                </p>
                <table className="w-full text-sm">
                  <tbody>
                    <Field
                      name="workspace"
                      type="string"
                      required
                      desc="Your workspace owner ID (Clerk user ID or workspace slug). Found on the Settings page."
                    />
                    <Field
                      name="city_slug"
                      type="string"
                      desc="Optional. Filter to occasions available in the given city slug (e.g. beirut)."
                    />
                  </tbody>
                </table>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mt-2">
                  curl example
                </p>
                <CodeBlock
                  code={`curl "${OS_API_BASE}/api/public/catalog/occasions?workspace=${wsParam}"`}
                />
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mt-2">
                  Response
                </p>
                <CodeBlock
                  lang="json"
                  code={`{
  "occasions": [
    {
      "id": 1,
      "name": "Birthday",
      "slug": "birthday",
      "description": null,
      "image_url": "https://os.presentail.com/api/storage/objects/...",
      "image_public_url": "https://os.presentail.com/api/storage/public-objects/occasions/1.jpg",
      "sort_order": 0,
      "updated_at": "2026-01-15T10:00:00.000Z"
    }
  ]
}`}
                />
              </Endpoint>

              <Endpoint
                method="GET"
                path="/api/public/catalog/categories?workspace={ownerId}"
                description="Returns the list of active catalog categories for the workspace. Pass an optional city_slug to restrict results to categories available in that city. No authentication required."
                tryIt={{
                  method: "GET",
                  baseUrl: OS_API_BASE,
                  path: "/api/public/catalog/categories",
                  authType: "none",
                  queryParams: [
                    { name: "workspace", placeholder: "user_xyz…", required: true },
                    { name: "city_slug", placeholder: "beirut" },
                  ],
                  defaultQueryValues: workspaceSlug ? { workspace: workspaceSlug } : undefined,
                }}
              >
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Query parameters
                </p>
                <table className="w-full text-sm">
                  <tbody>
                    <Field
                      name="workspace"
                      type="string"
                      required
                      desc="Your workspace owner ID (Clerk user ID or workspace slug). Found on the Settings page."
                    />
                    <Field
                      name="city_slug"
                      type="string"
                      desc="Optional. Filter to categories available in the given city slug (e.g. beirut)."
                    />
                  </tbody>
                </table>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mt-2">
                  curl example
                </p>
                <CodeBlock
                  code={`curl "${OS_API_BASE}/api/public/catalog/categories?workspace=${wsParam}"`}
                />
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mt-2">
                  Response
                </p>
                <CodeBlock
                  lang="json"
                  code={`{
  "categories": [
    {
      "id": 1,
      "name": "Flowers",
      "slug": "flowers",
      "description": null,
      "image_url": "https://os.presentail.com/api/storage/objects/...",
      "sort_order": 0,
      "updated_at": "2026-01-15T10:00:00.000Z"
    }
  ]
}`}
                />
              </Endpoint>

              <Endpoint
                method="GET"
                path="/api/public/catalog/brands?workspace={ownerId}"
                description="Returns the list of catalog brands for the workspace, including public logo and cover photo URLs. No authentication required."
                tryIt={{
                  method: "GET",
                  baseUrl: OS_API_BASE,
                  path: "/api/public/catalog/brands",
                  authType: "none",
                  queryParams: [
                    { name: "workspace", placeholder: "user_xyz…", required: true },
                  ],
                  defaultQueryValues: workspaceSlug ? { workspace: workspaceSlug } : undefined,
                }}
              >
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Query parameters
                </p>
                <table className="w-full text-sm">
                  <tbody>
                    <Field
                      name="workspace"
                      type="string"
                      required
                      desc="Your workspace owner ID (Clerk user ID or workspace slug). Found on the Settings page."
                    />
                  </tbody>
                </table>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mt-2">
                  curl example
                </p>
                <CodeBlock
                  code={`curl "${OS_API_BASE}/api/public/catalog/brands?workspace=${wsParam}"`}
                />
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mt-2">
                  Response
                </p>
                <CodeBlock
                  lang="json"
                  code={`{
  "brands": [
    {
      "id": 5,
      "name": "Bloom & Co",
      "description": "Fresh floral arrangements",
      "logo_url": "https://os.presentail.com/api/public/catalog/brands/5/logo",
      "cover_photo_urls": [
        "https://os.presentail.com/api/public/catalog/brands/5/cover-photos/12"
      ],
      "updated_at": "2026-01-15T10:00:00.000Z",
      "created_at": "2025-11-01T08:00:00.000Z"
    }
  ]
}`}
                />
              </Endpoint>
            </Section>

            <Section id="catalog-attributes" title="Catalog Attributes">
              <p className="text-sm text-muted-foreground">
                Public read-only endpoints that return active catalog attributes (occasions, categories,
                brands, recipients) for a workspace. No authentication is required. The workspace is
                identified via the{" "}
                <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">
                  workspace_owner_id
                </code>{" "}
                query parameter (your Clerk user ID — visible in the Settings page URL or returned by
                the Clerk session), or via a{" "}
                <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">city_slug</code>{" "}
                / <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">city_id</code>{" "}
                to automatically resolve the workspace from a delivery city. Base URL:{" "}
                <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">
                  {OS_API_BASE}
                </code>
              </p>

              <Endpoint
                method="GET"
                path="/api/catalog-attributes?workspace_owner_id={ownerId}"
                description="Returns all four catalog attribute types (occasions, categories, brands, recipients) in a single request for the workspace. No authentication required."
                tryIt={{
                  method: "GET",
                  baseUrl: OS_API_BASE,
                  path: "/api/catalog-attributes",
                  authType: "none",
                  queryParams: [
                    { name: "workspace_owner_id", placeholder: "user_xyz…", required: true },
                    { name: "city_slug", placeholder: "beirut (optional)" },
                  ],
                  defaultQueryValues: workspaceOwnerId ? { workspace_owner_id: workspaceOwnerId } : undefined,
                }}
              >
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Query parameters
                </p>
                <table className="w-full text-sm">
                  <tbody>
                    <Field
                      name="workspace_owner_id"
                      type="string"
                      required
                      desc="Your Clerk user ID (starts with user_). Found in the Settings page URL. Omit if you supply city_slug or city_id instead."
                    />
                    <Field
                      name="city_slug"
                      type="string"
                      desc="Delivery city slug (e.g. beirut). When provided, the workspace is resolved from the city and only attributes enabled for that city are returned."
                    />
                    <Field
                      name="city_id"
                      type="integer"
                      desc="Delivery city numeric ID. Alternative to city_slug."
                    />
                  </tbody>
                </table>
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mt-2">
                  curl example
                </p>
                <CodeBlock
                  code={`curl "${OS_API_BASE}/api/catalog-attributes?workspace_owner_id=${workspaceOwnerId ?? "user_xyz"}"`}
                />
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mt-2">
                  Response
                </p>
                <CodeBlock
                  lang="json"
                  code={`{
  "occasions": [{ "id": 1, "name": "Birthday", "slug": "birthday", "description": null, "image_url": null, "sort_order": 0 }],
  "categories": [{ "id": 2, "name": "Flowers", "slug": "flowers", "description": null, "image_url": null, "sort_order": 0 }],
  "brands": [{ "id": 3, "name": "Bloom & Co", "slug": "bloom-and-co", "description": null, "image_url": null, "sort_order": 0 }],
  "recipients": [{ "id": 4, "name": "Mom", "slug": "mom", "description": null, "image_url": null, "sort_order": 0 }]
}`}
                />
              </Endpoint>

              <Endpoint
                method="GET"
                path="/api/catalog-attributes/occasions?workspace_owner_id={ownerId}"
                description="Returns active occasions for the workspace. Optionally filter to a city's enabled occasions via city_slug or city_id. No authentication required."
                tryIt={{
                  method: "GET",
                  baseUrl: OS_API_BASE,
                  path: "/api/catalog-attributes/occasions",
                  authType: "none",
                  queryParams: [
                    { name: "workspace_owner_id", placeholder: "user_xyz…", required: true },
                    { name: "city_slug", placeholder: "beirut (optional)" },
                  ],
                  defaultQueryValues: workspaceOwnerId ? { workspace_owner_id: workspaceOwnerId } : undefined,
                }}
              >
                <CodeBlock
                  code={`curl "${OS_API_BASE}/api/catalog-attributes/occasions?workspace_owner_id=${workspaceOwnerId ?? "user_xyz"}"`}
                />
                <CodeBlock
                  lang="json"
                  code={`{
  "occasions": [
    { "id": 1, "name": "Birthday", "slug": "birthday", "description": null, "image_url": null, "sort_order": 0 }
  ]
}`}
                />
              </Endpoint>

              <Endpoint
                method="GET"
                path="/api/catalog-attributes/categories?workspace_owner_id={ownerId}"
                description="Returns active catalog categories for the workspace. Optionally filter to a city's enabled categories via city_slug or city_id. No authentication required."
                tryIt={{
                  method: "GET",
                  baseUrl: OS_API_BASE,
                  path: "/api/catalog-attributes/categories",
                  authType: "none",
                  queryParams: [
                    { name: "workspace_owner_id", placeholder: "user_xyz…", required: true },
                    { name: "city_slug", placeholder: "beirut (optional)" },
                  ],
                  defaultQueryValues: workspaceOwnerId ? { workspace_owner_id: workspaceOwnerId } : undefined,
                }}
              >
                <CodeBlock
                  code={`curl "${OS_API_BASE}/api/catalog-attributes/categories?workspace_owner_id=${workspaceOwnerId ?? "user_xyz"}"`}
                />
                <CodeBlock
                  lang="json"
                  code={`{
  "categories": [
    { "id": 2, "name": "Flowers", "slug": "flowers", "description": null, "image_url": null, "sort_order": 0 }
  ]
}`}
                />
              </Endpoint>

              <Endpoint
                method="GET"
                path="/api/catalog-attributes/brands?workspace_owner_id={ownerId}"
                description="Returns active catalog brands for the workspace. Optionally filter to a city's enabled brands via city_slug or city_id. No authentication required."
                tryIt={{
                  method: "GET",
                  baseUrl: OS_API_BASE,
                  path: "/api/catalog-attributes/brands",
                  authType: "none",
                  queryParams: [
                    { name: "workspace_owner_id", placeholder: "user_xyz…", required: true },
                    { name: "city_slug", placeholder: "beirut (optional)" },
                  ],
                  defaultQueryValues: workspaceOwnerId ? { workspace_owner_id: workspaceOwnerId } : undefined,
                }}
              >
                <CodeBlock
                  code={`curl "${OS_API_BASE}/api/catalog-attributes/brands?workspace_owner_id=${workspaceOwnerId ?? "user_xyz"}"`}
                />
                <CodeBlock
                  lang="json"
                  code={`{
  "brands": [
    { "id": 3, "name": "Bloom & Co", "slug": "bloom-and-co", "description": null, "image_url": null, "sort_order": 0 }
  ]
}`}
                />
              </Endpoint>

              <Endpoint
                method="GET"
                path="/api/catalog-attributes/recipients?workspace_owner_id={ownerId}"
                description="Returns active recipients for the workspace. Optionally filter to a city's enabled recipients via city_slug or city_id. No authentication required."
                tryIt={{
                  method: "GET",
                  baseUrl: OS_API_BASE,
                  path: "/api/catalog-attributes/recipients",
                  authType: "none",
                  queryParams: [
                    { name: "workspace_owner_id", placeholder: "user_xyz…", required: true },
                    { name: "city_slug", placeholder: "beirut (optional)" },
                  ],
                  defaultQueryValues: workspaceOwnerId ? { workspace_owner_id: workspaceOwnerId } : undefined,
                }}
              >
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  City availability filter
                </p>
                <p className="text-sm text-muted-foreground">
                  Pass <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">city_slug</code> to
                  restrict results to recipients that have been enabled for that delivery city. This is the
                  city-availability filter — only recipients with an active city-availability entry for the
                  given city are returned.
                </p>
                <CodeBlock
                  code={`# All active recipients
curl "${OS_API_BASE}/api/catalog-attributes/recipients?workspace_owner_id=${workspaceOwnerId ?? "user_xyz"}"

# Recipients available in Beirut only
curl "${OS_API_BASE}/api/catalog-attributes/recipients?workspace_owner_id=${workspaceOwnerId ?? "user_xyz"}&city_slug=beirut"`}
                />
                <CodeBlock
                  lang="json"
                  code={`{
  "recipients": [
    { "id": 4, "name": "Mom", "slug": "mom", "description": null, "image_url": null, "sort_order": 0 },
    { "id": 5, "name": "Wife", "slug": "wife", "description": null, "image_url": null, "sort_order": 1 }
  ]
}`}
                />
              </Endpoint>
            </Section>

            <Section id="admin-cities" title="Delivery Cities">
              <p className="text-sm text-muted-foreground">
                These endpoints let workspace owners manage which countries and cities are available for
                delivery. Each endpoint accepts either a Clerk session token (the caller must be the
                workspace owner) or an API key (workspace context is derived from the key; no Clerk
                session required). Base URL:{" "}
                <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">
                  {OS_API_BASE}
                </code>
              </p>
              <CodeBlock
                code={`# Option 1 — Clerk session (caller must be workspace owner)
Authorization: Bearer <clerk-session-token>

# Option 2 — API key (workspace derived from key)
Authorization: Bearer <api-key>`}
              />

              <Endpoint
                method="GET"
                path="/api/admin/settings/countries"
                description="List all countries available to the workspace, including their delivery_active flag and city count. Returns countries in sort_order, falling back to the global default country list."
              >
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  curl example
                </p>
                <CodeBlock
                  code={`# Option 1 — Clerk session
curl "${OS_API_BASE}/api/admin/settings/countries" \\
  -H "Authorization: Bearer <clerk-session-token>"

# Option 2 — API key
curl "${OS_API_BASE}/api/admin/settings/countries" \\
  -H "Authorization: Bearer <api-key>"`}
                />
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mt-2">
                  Response
                </p>
                <CodeBlock
                  lang="json"
                  code={`{
  "countries": [
    {
      "code": "LB",
      "name": "Lebanon",
      "delivery_active": true,
      "sort_order": 0,
      "city_count": 5
    }
  ]
}`}
                />
              </Endpoint>

              <Endpoint
                method="PATCH"
                path="/api/admin/settings/countries/{code}/delivery"
                description="Toggle the delivery_active flag for a single country. Pass { delivery_active: true } to enable or { delivery_active: false } to disable delivery to that country."
              >
                <table className="w-full text-sm">
                  <tbody>
                    <Field
                      name="delivery_active"
                      type="boolean"
                      required
                      desc="Whether to enable (true) or disable (false) delivery for this country."
                    />
                  </tbody>
                </table>
                <CodeBlock
                  code={`# Option 1 — Clerk session
curl -X PATCH "${OS_API_BASE}/api/admin/settings/countries/LB/delivery" \\
  -H "Authorization: Bearer <clerk-session-token>" \\
  -H "Content-Type: application/json" \\
  -d '{"delivery_active":true}'

# Option 2 — API key
curl -X PATCH "${OS_API_BASE}/api/admin/settings/countries/LB/delivery" \\
  -H "Authorization: Bearer <api-key>" \\
  -H "Content-Type: application/json" \\
  -d '{"delivery_active":true}'`}
                />
              </Endpoint>

              <Endpoint
                method="GET"
                path="/api/admin/settings/countries/{code}/cities"
                description="List all cities for a country in the workspace, ordered by sort_order. Returns both active and inactive cities."
              >
                <CodeBlock
                  code={`# Option 1 — Clerk session
curl "${OS_API_BASE}/api/admin/settings/countries/LB/cities" \\
  -H "Authorization: Bearer <clerk-session-token>"

# Option 2 — API key
curl "${OS_API_BASE}/api/admin/settings/countries/LB/cities" \\
  -H "Authorization: Bearer <api-key>"`}
                />
                <CodeBlock
                  lang="json"
                  code={`{
  "cities": [
    { "id": 1, "name": "Beirut", "slug": "beirut", "is_active": true, "sort_order": 0 },
    { "id": 2, "name": "Tripoli", "slug": "tripoli", "is_active": true, "sort_order": 1 }
  ]
}`}
                />
              </Endpoint>

              <Endpoint
                method="POST"
                path="/api/admin/settings/countries/{code}/cities"
                description="Add a new delivery city to a country. The slug is auto-generated from the name. Errors: 409 if a city with the same name already exists for this workspace and country."
              >
                <table className="w-full text-sm">
                  <tbody>
                    <Field name="name" type="string" required desc="City display name (max 100 chars)." />
                  </tbody>
                </table>
                <CodeBlock
                  code={`# Option 1 — Clerk session
curl -X POST "${OS_API_BASE}/api/admin/settings/countries/LB/cities" \\
  -H "Authorization: Bearer <clerk-session-token>" \\
  -H "Content-Type: application/json" \\
  -d '{"name":"Sidon"}'

# Option 2 — API key
curl -X POST "${OS_API_BASE}/api/admin/settings/countries/LB/cities" \\
  -H "Authorization: Bearer <api-key>" \\
  -H "Content-Type: application/json" \\
  -d '{"name":"Sidon"}'`}
                />
                <CodeBlock
                  lang="json"
                  code={`{
  "city": { "id": 3, "name": "Sidon", "slug": "sidon", "is_active": true, "sort_order": 2 }
}`}
                />
              </Endpoint>

              <Endpoint
                method="PATCH"
                path="/api/admin/settings/cities/{id}"
                description="Update a city's name and/or active status. All fields are optional; only supplied fields are updated. Errors: 404 if the city does not belong to the workspace."
              >
                <table className="w-full text-sm">
                  <tbody>
                    <Field name="name" type="string" desc="New display name for the city." />
                    <Field
                      name="is_active"
                      type="boolean"
                      desc="Pass false to hide the city from public delivery-location responses."
                    />
                  </tbody>
                </table>
                <CodeBlock
                  code={`# Option 1 — Clerk session
curl -X PATCH "${OS_API_BASE}/api/admin/settings/cities/3" \\
  -H "Authorization: Bearer <clerk-session-token>" \\
  -H "Content-Type: application/json" \\
  -d '{"is_active":false}'

# Option 2 — API key
curl -X PATCH "${OS_API_BASE}/api/admin/settings/cities/3" \\
  -H "Authorization: Bearer <api-key>" \\
  -H "Content-Type: application/json" \\
  -d '{"is_active":false}'`}
                />
              </Endpoint>

              <Endpoint
                method="DELETE"
                path="/api/admin/settings/cities/{id}"
                description="Permanently delete a city from the workspace. This cannot be undone. Errors: 404 if the city does not belong to the workspace."
              >
                <CodeBlock
                  code={`# Option 1 — Clerk session
curl -X DELETE "${OS_API_BASE}/api/admin/settings/cities/3" \\
  -H "Authorization: Bearer <clerk-session-token>"

# Option 2 — API key
curl -X DELETE "${OS_API_BASE}/api/admin/settings/cities/3" \\
  -H "Authorization: Bearer <api-key>"`}
                />
                <CodeBlock lang="json" code={`{ "ok": true }`} />
              </Endpoint>
            </Section>

            <Section id="fleet" title="Fleet API">
              <p className="text-sm text-muted-foreground">
                Endpoints powering the Presentail Fleet App. Drivers authenticate with a per-driver
                bearer token (issued on approval via the Fleet admin page). All Fleet endpoints return
                the envelope{" "}
                <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">{`{ success, error?, ... }`}</code>
                . Base URL:{" "}
                <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">
                  {OS_API_BASE}
                </code>
              </p>
              <CodeBlock code={`Authorization: Bearer fdt_live_YOUR_DRIVER_TOKEN`} />

              <Endpoint
                method="GET"
                path={`${OS_API_BASE}/api/fleet/me`}
                description="Returns the authenticated driver's profile, onboarding status and current availability."
                tryIt={{
                  method: "GET",
                  baseUrl: OS_API_BASE,
                  path: "/api/fleet/me",
                  authType: "driver-token",
                }}
              >
                <CodeBlock
                  code={`curl ${OS_API_BASE}/api/fleet/me \\
  -H "Authorization: Bearer fdt_live_YOUR_TOKEN"`}
                />
                <CodeBlock
                  lang="json"
                  code={`{
  "success": true,
  "driver": {
    "id": 12,
    "first_name": "Ahmed",
    "last_name": "Hassan",
    "phone": "+96170123456",
    "country_code": "+961",
    "vehicle_type": "Motorcycle",
    "onboarding_status": "approved",
    "availability_status": "online",
    "status": "active"
  }
}`}
                />
              </Endpoint>

              <Endpoint
                method="PATCH"
                path={`${OS_API_BASE}/api/fleet/me/availability`}
                description={`Update the driver's own availability. Allowed values: "online", "offline", "busy".`}
                tryIt={{
                  method: "PATCH",
                  baseUrl: OS_API_BASE,
                  path: "/api/fleet/me/availability",
                  authType: "driver-token",
                  bodyFields: [
                    {
                      name: "availability_status",
                      type: "select",
                      options: ["online", "offline", "busy"],
                    },
                  ],
                }}
              >
                <CodeBlock
                  code={`curl -X PATCH ${OS_API_BASE}/api/fleet/me/availability \\
  -H "Authorization: Bearer fdt_live_YOUR_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"availability_status":"online"}'`}
                />
              </Endpoint>

              <Endpoint
                method="GET"
                path={`${OS_API_BASE}/api/fleet/me/orders`}
                description="List the driver's currently-assigned, in-progress orders (excludes delivered/cancelled/returned). Each entry joins native order details."
                tryIt={{
                  method: "GET",
                  baseUrl: OS_API_BASE,
                  path: "/api/fleet/me/orders",
                  authType: "driver-token",
                }}
              >
                <CodeBlock
                  code={`curl ${OS_API_BASE}/api/fleet/me/orders \\
  -H "Authorization: Bearer fdt_live_YOUR_TOKEN"`}
                />
              </Endpoint>

              <Endpoint
                method="PATCH"
                path={`${OS_API_BASE}/api/fleet/me/orders/:id/status`}
                description={`Move an assignment through the delivery lifecycle. Allowed values: "assigned", "accepted", "picked_up", "out_for_delivery", "delivered", "failed_delivery", "returned", "cancelled". Status transitions automatically stamp accepted_at / picked_up_at / delivered_at.`}
                tryIt={{
                  method: "PATCH",
                  baseUrl: OS_API_BASE,
                  path: "/api/fleet/me/orders/{id}/status",
                  authType: "driver-token",
                  pathParams: [{ name: "id", placeholder: "42", required: true }],
                  bodyFields: [
                    {
                      name: "status",
                      type: "select",
                      options: [
                        "assigned",
                        "accepted",
                        "picked_up",
                        "out_for_delivery",
                        "delivered",
                        "failed_delivery",
                        "returned",
                        "cancelled",
                      ],
                    },
                  ],
                }}
              >
                <CodeBlock
                  code={`curl -X PATCH ${OS_API_BASE}/api/fleet/me/orders/42/status \\
  -H "Authorization: Bearer fdt_live_YOUR_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"status":"picked_up"}'`}
                />
              </Endpoint>

              <Endpoint
                method="POST"
                path={`${OS_API_BASE}/api/fleet/me/orders/:id/proof-of-delivery`}
                description="Submit proof of delivery. The assignment is automatically marked delivered. All fields below are optional."
                tryIt={{
                  method: "POST",
                  baseUrl: OS_API_BASE,
                  path: "/api/fleet/me/orders/{id}/proof-of-delivery",
                  authType: "driver-token",
                  pathParams: [{ name: "id", placeholder: "42", required: true }],
                  bodyFields: [
                    { name: "recipient_name", type: "text", placeholder: "e.g. Jane Doe" },
                    { name: "notes", type: "text", placeholder: "Free-form notes" },
                    { name: "latitude", type: "number", placeholder: "33.8938" },
                    { name: "longitude", type: "number", placeholder: "35.5018" },
                  ],
                }}
              >
                <table className="w-full text-sm">
                  <tbody>
                    <Field
                      name="recipient_name"
                      type="string"
                      desc="Person who received the parcel."
                    />
                    <Field
                      name="signature_data"
                      type="string"
                      desc="Base64-encoded signature, if collected."
                    />
                    <Field
                      name="image_url"
                      type="string (URL)"
                      desc="Photo of the delivered parcel."
                    />
                    <Field name="latitude" type="number" desc="Delivery latitude (-90..90)." />
                    <Field name="longitude" type="number" desc="Delivery longitude (-180..180)." />
                    <Field name="notes" type="string" desc="Free-form notes (max 2000 chars)." />
                  </tbody>
                </table>
              </Endpoint>

              <Endpoint
                method="GET"
                path={`${OS_API_BASE}/api/fleet/orders`}
                description="Admin endpoint (Clerk session). Lists workspace native orders enriched with driver assignment status. Supports ?status=… and ?driver_id=… filters."
              />

              <Endpoint
                method="POST"
                path={`${OS_API_BASE}/api/fleet/orders/:id/assign-driver`}
                description="Admin endpoint. Assigns (or reassigns) a workspace native order to a driver. Requires the driver to be approved."
              >
                <CodeBlock
                  lang="json"
                  code={`{
  "driver_id": 12,
  "scheduled_at": "2026-05-04T09:00:00Z",
  "notes": "Call on arrival"
}`}
                />
              </Endpoint>
            </Section>

            <Section id="coupons" title="Coupons">
              <p className="text-sm text-muted-foreground">
                Fetch coupon rules and validate discount/promo codes against a storefront cart.
                Authenticate with your workspace API key (header{" "}
                <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">x-api-key</code>{" "}
                or{" "}
                <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">
                  Authorization: Bearer pk_live_…
                </code>
                ).
              </p>

              <Endpoint
                method="GET"
                path={`${OS_API_BASE}/api/coupons`}
                description="List the workspace's currently usable coupons with full rule data (discount, validity window, scope restrictions, usage limits) so the storefront can match entered codes and apply discounts. Inactive and expired coupons are excluded."
                tryIt={{
                  method: "GET",
                  baseUrl: OS_API_BASE,
                  path: "/api/coupons",
                  authType: "api-key",
                }}
              >
                <CodeBlock
                  code={`curl ${OS_API_BASE}/api/coupons \\
  -H "x-api-key: pk_live_YOUR_KEY"`}
                />
                <CodeBlock
                  lang="json"
                  code={`{
  "coupons": [
    {
      "id": "b3f1c2a4-...",
      "code": "WELCOME10",
      "description": "10% off your first order",
      "discountType": "percentage",
      "discountValue": 10,
      "minOrderUsd": 50,
      "scope": "restricted",
      "startsAt": null,
      "expiresAt": "2026-12-31T00:00:00.000Z",
      "isActive": true,
      "perUserLimit": 1,
      "globalLimit": 100,
      "usedCount": 12,
      "restrictions": {
        "products": [{ "id": 42, "slug": "red-roses-bouquet" }],
        "occasions": [{ "id": 3, "slug": "birthday", "name": "Birthday" }],
        "categories": [],
        "brands": [],
        "recipients": []
      }
    }
  ]
}`}
                />
                <p className="text-sm text-muted-foreground">
                  <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">scope</code>{" "}
                  is <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">all</code>{" "}
                  (applies to every product,{" "}
                  <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">restrictions</code>{" "}
                  is <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">null</code>) or{" "}
                  <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">restricted</code>{" "}
                  (the cart must contain at least one product matching the allowed product ids/slugs
                  or catalog attributes). A coupon whose{" "}
                  <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">usedCount</code>{" "}
                  has reached{" "}
                  <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">globalLimit</code>{" "}
                  is exhausted. Coupons with a future{" "}
                  <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">startsAt</code>{" "}
                  are included — check the window before applying.
                </p>
                <p className="text-sm text-muted-foreground">
                  <strong>Recommended flow:</strong> fetch the rules above for display and
                  client-side application, then call{" "}
                  <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">
                    POST /api/coupons/validate
                  </code>{" "}
                  before checkout as the authoritative check, and finally pass{" "}
                  <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">couponId</code>{" "}
                  +{" "}
                  <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">
                    couponDiscountUsd
                  </code>{" "}
                  on{" "}
                  <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">
                    POST /api/orders
                  </code>
                  .
                </p>
              </Endpoint>

              <p className="text-sm text-muted-foreground">
                The validate endpoint below{" "}
                <strong>always returns HTTP 200</strong> — inspect the{" "}
                <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">valid</code>{" "}
                field to decide whether to apply the discount.
              </p>

              <Endpoint
                method="POST"
                path={`${OS_API_BASE}/api/coupons/validate`}
                description="Validate a coupon code against a cart. Returns the computed USD discount when valid, or a typed error code when not."
                tryIt={{
                  method: "POST",
                  baseUrl: OS_API_BASE,
                  path: "/api/coupons/validate",
                  authType: "api-key",
                  bodyFields: [
                    { name: "code", type: "text", placeholder: "WELCOME10" },
                    { name: "cartTotalUsd", type: "text", placeholder: "120" },
                    { name: "customerEmail", type: "text", placeholder: "buyer@example.com" },
                  ],
                }}
              >
                <CodeBlock
                  code={`curl -X POST ${OS_API_BASE}/api/coupons/validate \\
  -H "x-api-key: pk_live_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "code": "WELCOME10",
    "cartTotalUsd": 120,
    "customerEmail": "buyer@example.com",
    "items": [
      { "productId": 42, "quantity": 1, "lineTotalUsd": 120 }
    ]
  }'`}
                />
                <CodeBlock
                  lang="json"
                  code={`{
  "valid": true,
  "discountAmountUsd": 12,
  "couponId": "b3f1c2a4-...",
  "description": "10% off your first order"
}`}
                />
                <CodeBlock
                  lang="json"
                  code={`{
  "valid": false,
  "error": "below_minimum",
  "message": "Your order does not meet the minimum amount for this coupon."
}`}
                />
                <p className="text-sm text-muted-foreground">
                  Possible <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">error</code>{" "}
                  codes:{" "}
                  <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">not_found</code>,{" "}
                  <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">inactive</code>,{" "}
                  <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">expired</code>,{" "}
                  <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">not_started_yet</code>,{" "}
                  <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">below_minimum</code>,{" "}
                  <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">no_eligible_items</code>,{" "}
                  <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">usage_limit_reached</code>,{" "}
                  <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">usage_limit_per_user_reached</code>.
                </p>
              </Endpoint>
            </Section>

            <Section id="website-events" title="Website Events">
              <p className="text-sm text-muted-foreground">
                Push storefront behavioral events (searches, category/occasion clicks, filters,
                sorting…) so the <strong>Search &amp; Discovery Analytics</strong> dashboard section
                populates. Authenticate with your workspace API key (header{" "}
                <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">x-api-key</code>{" "}
                or{" "}
                <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">
                  Authorization: Bearer pk_live_…
                </code>
                ).
              </p>

              <p className="text-sm text-muted-foreground">
                <strong>Easiest integration:</strong> include the hosted tracker script once on the
                website and call the helpers on user interactions. It manages session/visitor ids,
                UTM parameters, device type, URL and referrer automatically, and batches events.
              </p>

              <CodeBlock
                lang="html"
                code={`<script
  src="${OS_API_BASE}/api/web-events/tracker.js"
  data-api-key="pk_live_YOUR_KEY"
  defer
></script>`}
              />
              <CodeBlock
                lang="js"
                code={`// After a search executes (pass the number of results — 0 auto-tracks a no-result search):
PresentailAnalytics.trackSearch("red roses", 12);

// When a customer clicks a search result:
PresentailAnalytics.trackSearchResultClick("red roses", "red-roses-bouquet");

// Browsing & merchandising signals:
PresentailAnalytics.trackCategoryClick("Flowers");
PresentailAnalytics.trackOccasionClick("Birthday");
PresentailAnalytics.trackFilterSelected("color", "red");
PresentailAnalytics.trackSortSelected("price_asc");
PresentailAnalytics.trackRecipientSelected("Mom");
PresentailAnalytics.trackBrandSelected("Presentail");
PresentailAnalytics.trackPriceRangeSelected(20, 50);

// Anything else (generic):
PresentailAnalytics.track("page_view", { path: location.pathname });`}
              />

              <Endpoint
                method="POST"
                path={`${OS_API_BASE}/api/web-events`}
                description="Raw ingestion endpoint the tracker uses under the hood. Accepts a single event object or { events: [...] } (up to 500). Use this directly if you prefer server-side or custom tracking."
              >
                <CodeBlock
                  code={`curl -X POST ${OS_API_BASE}/api/web-events \\
  -H "x-api-key: pk_live_YOUR_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "events": [
      {
        "type": "search",
        "sessionId": "sess-123",
        "searchQuery": "red roses",
        "resultCount": 12
      },
      {
        "type": "search_result_click",
        "sessionId": "sess-123",
        "searchQuery": "red roses",
        "productRef": "red-roses-bouquet"
      }
    ]
  }'`}
                />
                <table className="w-full text-sm">
                  <tbody>
                    <Field
                      name="type"
                      type="string (required)"
                      desc="Event type. Search & Discovery reads: search, search_no_result, search_result_click, category_click, occasion_click, filter_selected, sort_selected, recipient_selected, brand_selected, price_range_selected. Conversion linking also reads: order_created / purchase / payment_completed / checkout_completed."
                    />
                    <Field
                      name="sessionId"
                      type="string"
                      desc="Browser session id — required for session metrics like search conversion."
                    />
                    <Field
                      name="searchQuery"
                      type="string"
                      desc="The typed search term (search / no-result / result-click events)."
                    />
                    <Field
                      name="resultCount"
                      type="number"
                      desc="Number of results the search returned. 0 marks a no-result search."
                    />
                    <Field
                      name="category / occasion / brand"
                      type="string"
                      desc="Clicked category, occasion, or brand name for the respective click events."
                    />
                    <Field
                      name="properties"
                      type="object"
                      desc="Extra context. filter_selected reads properties.filterType; sort_selected reads properties.sortOption. Unknown top-level keys are preserved here automatically."
                    />
                  </tbody>
                </table>
                <p className="text-sm text-muted-foreground">
                  Returns{" "}
                  <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">
                    201 {"{ \"received\": N }"}
                  </code>
                  . Once events arrive, the Search &amp; Discovery Analytics page replaces its
                  "waiting for website events" state with live charts.
                </p>
              </Endpoint>
            </Section>

            <Section id="currency-rates" title="Currencies & Exchange Rates">
              <p className="text-sm text-muted-foreground">
                Read your workspace's live exchange rates and currency settings without a Clerk session
                or API key. Designed for storefronts and external apps (such as presentail.com) that
                need to display prices in multiple currencies. Base URL:{" "}
                <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">
                  {OS_API_BASE}
                </code>
              </p>

              <Endpoint
                method="GET"
                path="/api/public/currency-rates?workspace={ownerId}"
                description="Returns the workspace's base currency, markup percentage, rounding rule, last-updated timestamp, and the full list of stored exchange rates. No authentication is required."
                tryIt={{
                  method: "GET",
                  baseUrl: OS_API_BASE,
                  path: "/api/public/currency-rates",
                  authType: "none",
                  queryParams: [
                    { name: "workspace", placeholder: "user_xyz…", required: true },
                  ],
                  defaultQueryValues: workspaceSlug ? { workspace: workspaceSlug } : undefined,
                }}
              >
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Auth
                </p>
                <p className="text-sm text-muted-foreground">
                  No Clerk session or API key required — this endpoint is fully public. Provide your
                  workspace owner ID via the{" "}
                  <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">workspace</code>{" "}
                  query parameter (the same value used by all other public endpoints).
                </p>

                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mt-2">
                  Query parameters
                </p>
                <table className="w-full text-sm">
                  <tbody>
                    <Field
                      name="workspace"
                      type="string"
                      required
                      desc="Your workspace owner ID (Clerk user ID). Found on the Settings page."
                    />
                  </tbody>
                </table>

                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mt-2">
                  curl example
                </p>
                <CodeBlock
                  code={`curl "${OS_API_BASE}/api/public/currency-rates?workspace=${wsParam}"`}
                />

                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mt-2">
                  Response
                </p>
                <CodeBlock
                  lang="json"
                  code={`{
  "base_currency": "AED",
  "default_markup_percentage": 2.5,
  "rounding_rule": "round_up_whole",
  "last_updated_at": "2026-05-26T06:00:12.345Z",
  "available_currencies": ["EUR", "GBP", "SAR", "USD"],
  "rates": [
    { "currency": "EUR", "rate": 0.24821, "fetched_at": "2026-05-26T06:00:12.345Z" },
    { "currency": "GBP", "rate": 0.21034, "fetched_at": "2026-05-26T06:00:12.345Z" },
    { "currency": "SAR", "rate": 1.02241, "fetched_at": "2026-05-26T06:00:12.345Z" },
    { "currency": "USD", "rate": 0.27226, "fetched_at": "2026-05-26T06:00:12.345Z" }
  ]
}`}
                />

                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mt-2">
                  Response fields
                </p>
                <table className="w-full text-sm">
                  <tbody>
                    <Field name="base_currency" type="string" desc="The workspace's configured base currency code (e.g. AED, USD)." />
                    <Field name="default_markup_percentage" type="number" desc="Markup percentage applied on top of mid-market rates when converting prices (0–100)." />
                    <Field name="rounding_rule" type="string" desc='One of "round_up_whole", "round_nearest_whole", or "none".' />
                    <Field name="last_updated_at" type="ISO 8601" desc="Timestamp of the most recent rate fetch." />
                    <Field name="available_currencies" type="string[]" desc="Sorted list of target currency codes that have stored rates." />
                    <Field name="rates" type="object[]" desc="Array of rate objects. Each contains currency (target code), rate (float), and fetched_at (ISO 8601)." />
                  </tbody>
                </table>

                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mt-2">
                  Currency conversion formula
                </p>
                <CodeBlock
                  lang="javascript"
                  code={`// Given the API response above:
const { base_currency, default_markup_percentage, rounding_rule, rates } = response;

// 1. Look up the raw mid-market rate for your target currency
const entry = rates.find(r => r.currency === "USD");
const officialRate = entry.rate; // e.g. 0.27226

// 2. Apply the workspace markup
const markupMultiplier = 1 + default_markup_percentage / 100; // 1.025
const effectiveRate = officialRate * markupMultiplier; // 0.27907

// 3. Convert the amount in the base currency
const amountInBase = 250; // e.g. 250 AED
const convertedExact = amountInBase * effectiveRate; // 69.768 USD

// 4. Apply rounding rule
function applyRounding(amount, rule) {
  if (rule === "round_up_whole")     return Math.ceil(amount);
  if (rule === "round_nearest_whole") return Math.round(amount);
  return amount; // "none"
}
const finalAmount = applyRounding(convertedExact, rounding_rule); // 70 USD`}
                />

                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mt-2">
                  Error responses
                </p>
                <div className="border border-border rounded-xl overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="bg-secondary/50 text-left">
                        <th className="px-4 py-2 font-semibold text-xs">Code</th>
                        <th className="px-4 py-2 font-semibold text-xs">Condition</th>
                        <th className="px-4 py-2 font-semibold text-xs">Error message</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[
                        ["400", "workspace query parameter is missing", '"workspace query parameter is required"'],
                        ["404", "No workspace owner found for the given ID", '"workspace not found"'],
                        ["503", "Rates have never been fetched for this workspace", '"exchange rates have not been configured yet"'],
                      ].map(([code, condition, message]) => (
                        <tr key={code} className="border-t border-border">
                          <td className="px-4 py-2">
                            <code className="font-mono text-xs bg-secondary px-1.5 py-0.5 rounded">
                              {code}
                            </code>
                          </td>
                          <td className="px-4 py-2 text-muted-foreground text-xs">{condition}</td>
                          <td className="px-4 py-2 font-mono text-xs text-muted-foreground">{message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mt-2">
                  Webhook: <code className="font-mono bg-secondary px-1 py-0.5 rounded">currency_rates.updated</code>
                </p>
                <p className="text-sm text-muted-foreground">
                  Your registered webhook endpoints receive a{" "}
                  <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">
                    currency_rates.updated
                  </code>{" "}
                  event whenever exchange rates are refreshed (automatically at 06:00 UTC daily, or
                  manually via the OS dashboard), or when exchange-rate settings (base currency,
                  markup, rounding rule) are changed. The same change also fires the legacy{" "}
                  <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">
                    exchange_rate.updated
                  </code>{" "}
                  alias and the newer{" "}
                  <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">
                    fx.rates.updated
                  </code>{" "}
                  event — all three carry the same payload, so subscribe to whichever name your
                  integration prefers. Subscribe to these events in the{" "}
                  <a href="/webhook-endpoints" className="underline text-primary">
                    Webhook Endpoints
                  </a>{" "}
                  page.
                </p>
                <CodeBlock
                  lang="json"
                  code={`{
  "event": "currency_rates.updated",
  "workspace": "user_xyz",
  "timestamp": "2026-05-26T06:00:15.123Z",
  "data": {
    "base_currency": "AED",
    "last_updated_at": "2026-05-26T06:00:12.345Z",
    "updated_fields": ["rates"]
  }
}`}
                />
                <p className="text-sm text-muted-foreground">
                  The{" "}
                  <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">
                    updated_fields
                  </code>{" "}
                  array lists which settings changed:{" "}
                  <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">rates</code> for
                  a rate fetch,{" "}
                  <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">
                    base_currency
                  </code>
                  ,{" "}
                  <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">
                    default_markup_percentage
                  </code>
                  , or{" "}
                  <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">
                    rounding_rule
                  </code>{" "}
                  when those settings are updated. Webhook deliveries use the same HMAC-SHA256 signing
                  as all other Presentail webhook events — verify with the{" "}
                  <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">
                    x-presentail-signature
                  </code>{" "}
                  header.
                </p>
              </Endpoint>
            </Section>

            <Section id="errors" title="Error Responses">
              <p className="text-sm text-muted-foreground">
                All errors return a JSON body with an{" "}
                <code className="font-mono text-xs bg-secondary px-1 py-0.5 rounded">error</code>{" "}
                field and an appropriate HTTP status code.
              </p>
              <div className="border border-border rounded-xl overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-secondary/50 text-left">
                      <th className="px-4 py-2 font-semibold text-xs">Code</th>
                      <th className="px-4 py-2 font-semibold text-xs">Meaning</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      ["400", "Bad request — missing or invalid fields."],
                      ["401", "Missing or invalid API key."],
                      ["404", "Resource not found or doesn't belong to your account."],
                      ["413", "PDF too large (max 50 MB)."],
                      ["500", "Server error — try again shortly."],
                    ].map(([code, meaning]) => (
                      <tr key={code} className="border-t border-border">
                        <td className="px-4 py-2">
                          <code className="font-mono text-xs bg-secondary px-1.5 py-0.5 rounded">
                            {code}
                          </code>
                        </td>
                        <td className="px-4 py-2 text-muted-foreground text-xs">{meaning}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Section>
          </div>
        </div>
      </div>
    </TryItContext.Provider>
  );
}

export default function ApiDocsPage() {
  const { t } = useTranslation();
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight mb-2">{t("apiDocs.title")}</h1>
        <p className="text-muted-foreground">{t("apiDocs.description")}</p>
      </div>

      <Tabs defaultValue="quick-start">
        <TabsList>
          <TabsTrigger value="quick-start">Quick Start</TabsTrigger>
          <TabsTrigger value="full-reference">Full Reference</TabsTrigger>
          <TabsTrigger value="catalog-api">Catalog API</TabsTrigger>
        </TabsList>

        <TabsContent value="quick-start" className="mt-6">
          <QuickStartContent />
        </TabsContent>

        <TabsContent value="full-reference" className="mt-0 -mx-6 sm:-mx-8">
          <ApiReferenceReact
            configuration={{
              url: "/api/openapi.yaml",
              hideModels: false,
              hideDownloadButton: false,
              theme: "default",
              customCss: `
                .scalar-app { font-family: inherit; }
                .dark-mode .scalar-app { color-scheme: dark; }
              `,
            }}
          />
        </TabsContent>

        <TabsContent value="catalog-api" className="mt-6 -mx-6 sm:-mx-8">
          <PageGuard page="publishing-channels">
            <CatalogApiDocsContent />
          </PageGuard>
        </TabsContent>
      </Tabs>
    </div>
  );
}
