import { useMemo, useState } from "react";
import { useLocation, useParams } from "wouter";
import {
  useGetAudience,
  useGetAudienceContacts,
  useGetAudienceFields,
  useRefreshAudience,
  getAudienceContacts,
  type Audience,
  type AudienceMatchedContact,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { getGetAudienceQueryKey, getGetAudienceContactsQueryKey } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import {
  ArrowLeft, Download, Edit2, Megaphone, RefreshCw, Search, Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import AudienceBuilder, { type BuilderState } from "./AudienceBuilder";
import { describeTree } from "./ruleUtils";

type Tab = "overview" | "contacts" | "rules" | "campaigns";

function contactName(c: AudienceMatchedContact): string {
  return (
    (c.displayName ?? "").trim() ||
    `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() ||
    c.email ||
    c.phone ||
    "Unnamed contact"
  );
}

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

function StatusBadge({ audience }: { audience: Audience }) {
  if (audience.status === "archived") return <Badge variant="outline">Archived</Badge>;
  if (audience.status === "draft") return <Badge variant="outline">Draft</Badge>;
  return audience.kind === "dynamic" ? (
    <Badge className="bg-teal-100 text-teal-800 hover:bg-teal-100 gap-1">
      <Zap size={11} /> Dynamic · updates automatically
    </Badge>
  ) : (
    <Badge className="bg-slate-100 text-slate-700 hover:bg-slate-100">Static · fixed list</Badge>
  );
}

function WhyIncludedRow({ contact }: { contact: AudienceMatchedContact }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="text-xs text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "Hide" : "Why included?"}
      </button>
      {open && (
        <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
          {contact.evidence.map((ev, i) => (
            <li key={i}>
              {ev.matched ? "✓" : "•"} {ev.field.replace(/_/g, " ")} {ev.operator.replace(/_/g, " ")}
              {ev.value != null ? ` ${Array.isArray(ev.value) ? ev.value.join(", ") : String(ev.value)}` : ""}
              {ev.actual != null ? ` (actual: ${String(ev.actual)})` : ""}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export default function AudienceDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { realIsOwner, allowedPages } = useWorkspaceRole();
  const canExport = realIsOwner || allowedPages === null || allowedPages.includes("customers");

  const [tab, setTab] = useState<Tab>("overview");
  const [page, setPage] = useState(1);
  const [contactSearch, setContactSearch] = useState("");
  const [builder, setBuilder] = useState<BuilderState | null>(null);
  const limit = 25;

  const { data, isLoading } = useGetAudience(id);
  const audience = data?.audience;
  const { data: fieldsData } = useGetAudienceFields();
  const fields = fieldsData?.fields ?? [];
  const { data: contactsData, isLoading: contactsLoading } = useGetAudienceContacts(
    id,
    { page, limit },
    { query: { enabled: tab === "contacts", queryKey: getGetAudienceContactsQueryKey(id, { page, limit }) } },
  );

  const refreshMutation = useRefreshAudience({
    mutation: {
      onSuccess: () => {
        toast({ title: "Audience refreshed" });
        void qc.invalidateQueries({ queryKey: getGetAudienceQueryKey(id) });
      },
      onError: () => toast({ title: "Refresh failed", variant: "destructive" }),
    },
  });

  const filteredContacts = useMemo(() => {
    const list = contactsData?.contacts ?? [];
    const q = contactSearch.trim().toLowerCase();
    if (!q) return list;
    return list.filter((c) =>
      [contactName(c), c.email ?? "", c.phone ?? ""].some((s) => s.toLowerCase().includes(q)),
    );
  }, [contactsData, contactSearch]);

  async function exportCsv() {
    if (!audience) return;
    try {
      const res = await getAudienceContacts(audience.id, { page: 1, limit: 1000 });
      const rows = [
        ["Name", "Email", "Phone", "Email reachable", "WhatsApp reachable", "Total spent (USD)"],
        ...res.contacts.map((c) => [
          contactName(c),
          c.email ?? "",
          c.phone ?? "",
          c.emailReachable ? "yes" : "no",
          c.whatsappReachable ? "yes" : "no",
          c.totalSpentUsd != null ? String(c.totalSpentUsd) : "",
        ]),
      ];
      const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${audience.name.replace(/[^\w-]+/g, "-").toLowerCase()}-contacts.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast({ title: "Export failed", variant: "destructive" });
    }
  }

  if (isLoading) {
    return (
      <div className="flex justify-center py-20">
        <Spinner className="size-8 text-primary" />
      </div>
    );
  }
  if (!audience) {
    return (
      <div className="text-center py-20 space-y-3">
        <p className="font-medium">Audience not found</p>
        <Button variant="outline" onClick={() => setLocation("/audiences")}>
          <ArrowLeft size={14} className="me-1.5" /> Back to Audiences
        </Button>
      </div>
    );
  }

  const counts = audience.cached_counts;
  const ruleSummary =
    audience.rules_summary ??
    (audience.rules ? describeTree(audience.rules, fields) : "No rules — static member list.");

  const tabs: { key: Tab; label: string }[] = [
    { key: "overview", label: "Overview" },
    { key: "contacts", label: "Contacts" },
    { key: "rules", label: "Rules" },
    { key: "campaigns", label: "Campaigns" },
  ];

  const contactCount =
    audience.kind === "static" ? audience.member_count ?? 0 : counts?.matched ?? null;

  return (
    <div className="space-y-6" data-testid="audience-detail">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1.5">
          <button
            type="button"
            className="text-sm text-muted-foreground hover:text-foreground flex items-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
            onClick={() => setLocation("/audiences")}
          >
            <ArrowLeft size={14} /> Audiences
          </button>
          <h1 className="text-2xl font-bold" data-testid="text-audience-name">{audience.name}</h1>
          <div className="flex items-center gap-2 flex-wrap">
            <StatusBadge audience={audience} />
            {audience.description && (
              <span className="text-sm text-muted-foreground">{audience.description}</span>
            )}
          </div>
        </div>
        <div className="flex gap-2">
          {audience.kind === "dynamic" && audience.status !== "archived" && (
            <>
              <Button
                variant="outline"
                onClick={() => refreshMutation.mutate({ id })}
                disabled={refreshMutation.isPending}
              >
                <RefreshCw size={14} className={cn("me-1.5", refreshMutation.isPending && "animate-spin")} />
                Refresh
              </Button>
              <Button variant="outline" onClick={() => setBuilder({ mode: "edit", audience })} data-testid="button-edit-rules">
                <Edit2 size={14} className="me-1.5" /> Edit rules
              </Button>
            </>
          )}
          {audience.status !== "archived" && (
            <Button
              onClick={() =>
                setLocation(
                  `/occasion-campaigns?tab=plans&create=1&audience_id=${encodeURIComponent(audience.id)}&audience_name=${encodeURIComponent(audience.name)}`,
                )
              }
              data-testid="button-create-campaign"
            >
              <Megaphone size={14} className="me-1.5" /> Create campaign
            </Button>
          )}
        </div>
      </div>

      <div className="border-b">
        <nav className="flex gap-6 -mb-px overflow-x-auto" aria-label="Audience detail sections">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              data-testid={`tab-detail-${t.key}`}
              onClick={() => setTab(t.key)}
              className={`whitespace-nowrap border-b-2 px-1 pb-3 text-sm font-medium transition-colors ${
                tab === t.key
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      </div>

      {tab === "overview" && (
        <div className="space-y-5">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="rounded-lg border bg-card p-4">
              <p className="text-sm text-muted-foreground">Contacts</p>
              <p className="text-2xl font-bold mt-1" data-testid="text-detail-matched">
                {contactCount != null ? contactCount.toLocaleString() : "—"}
              </p>
            </div>
            <div className="rounded-lg border bg-card p-4">
              <p className="text-sm text-muted-foreground">Email reachable</p>
              <p className="text-2xl font-bold mt-1">
                {counts != null ? counts.emailReachable.toLocaleString() : "—"}
              </p>
            </div>
            <div className="rounded-lg border bg-card p-4">
              <p className="text-sm text-muted-foreground">WhatsApp reachable</p>
              <p className="text-2xl font-bold mt-1">
                {counts != null ? counts.whatsappReachable.toLocaleString() : "—"}
              </p>
            </div>
            <div className="rounded-lg border bg-card p-4">
              <p className="text-sm text-muted-foreground">Excluded</p>
              <p className="text-2xl font-bold mt-1">
                {counts != null ? counts.excluded.toLocaleString() : "—"}
              </p>
            </div>
          </div>
          <div className="rounded-lg border bg-card p-4 space-y-2 text-sm">
            <p>
              <span className="text-muted-foreground">Update behavior:</span>{" "}
              {audience.kind === "dynamic"
                ? "Updates automatically as contact data changes."
                : "Fixed list — members only change when edited manually."}
            </p>
            <p>
              <span className="text-muted-foreground">Last evaluated:</span>{" "}
              {formatDateTime(audience.last_evaluated_at)}
            </p>
            <p>
              <span className="text-muted-foreground">Created:</span>{" "}
              {formatDateTime(audience.created_at)}
            </p>
            <p>
              <span className="text-muted-foreground">Updated:</span>{" "}
              {formatDateTime(audience.updated_at)}
            </p>
            {counts?.avgLifetimeSpendUsd != null && (
              <p>
                <span className="text-muted-foreground">Average lifetime spend:</span>{" "}
                ${counts.avgLifetimeSpendUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}
              </p>
            )}
          </div>
          {audience.rules && (
            <div className="rounded-lg bg-muted/50 border p-4">
              <p className="text-xs font-medium text-muted-foreground mb-1">Rules in plain language</p>
              <p className="text-sm">{ruleSummary}</p>
            </div>
          )}
        </div>
      )}

      {tab === "contacts" && (
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="relative max-w-xs flex-1">
              <Search size={14} className="absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="ps-8"
                placeholder="Search this page…"
                value={contactSearch}
                onChange={(e) => setContactSearch(e.target.value)}
                data-testid="input-detail-contact-search"
              />
            </div>
            {canExport && (
              <Button variant="outline" size="sm" onClick={() => void exportCsv()} data-testid="button-export-contacts">
                <Download size={14} className="me-1.5" /> Export CSV
              </Button>
            )}
          </div>
          {contactsLoading ? (
            <div className="flex justify-center py-12"><Spinner className="size-6" /></div>
          ) : filteredContacts.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-12">No contacts on this page.</p>
          ) : (
            <div className="rounded-md border overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Contact</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Phone</TableHead>
                    <TableHead>Reachable</TableHead>
                    <TableHead>Details</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredContacts.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="font-medium">{contactName(c)}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{c.email ?? "—"}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{c.phone ?? "—"}</TableCell>
                      <TableCell className="text-sm">
                        {[c.emailReachable && "Email", c.whatsappReachable && "WhatsApp"]
                          .filter(Boolean)
                          .join(", ") || "—"}
                      </TableCell>
                      <TableCell>
                        <WhyIncludedRow contact={c} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          {(contactsData?.total ?? 0) > limit && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                Page {page} of {Math.max(1, Math.ceil((contactsData?.total ?? 0) / limit))}
              </span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= Math.ceil((contactsData?.total ?? 0) / limit)}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {tab === "rules" && (
        <div className="space-y-4 max-w-2xl">
          <div className="rounded-lg bg-muted/50 border p-4">
            <p className="text-xs font-medium text-muted-foreground mb-1">Rules in plain language</p>
            <p className="text-sm" data-testid="text-detail-rule-summary">{ruleSummary}</p>
          </div>
          {audience.kind === "dynamic" && audience.status !== "archived" && (
            <Button variant="outline" onClick={() => setBuilder({ mode: "edit", audience })}>
              <Edit2 size={14} className="me-1.5" /> Edit rules
            </Button>
          )}
          {audience.kind === "static" && (
            <p className="text-sm text-muted-foreground">
              Static audiences have no rules — their member list is fixed.
            </p>
          )}
        </div>
      )}

      {tab === "campaigns" && (
        <div className="text-center py-12 space-y-3">
          <p className="text-sm text-muted-foreground max-w-md mx-auto">
            Campaigns planned with this audience appear in Occasion Campaigns. Nothing is ever sent
            automatically from here.
          </p>
          {audience.status !== "archived" && (
            <Button
              onClick={() =>
                setLocation(
                  `/occasion-campaigns?tab=plans&create=1&audience_id=${encodeURIComponent(audience.id)}&audience_name=${encodeURIComponent(audience.name)}`,
                )
              }
            >
              <Megaphone size={14} className="me-1.5" /> Create campaign with this audience
            </Button>
          )}
        </div>
      )}

      <AudienceBuilder
        state={builder}
        onClose={() => setBuilder(null)}
        onSaved={() => void qc.invalidateQueries({ queryKey: getGetAudienceQueryKey(id) })}
      />
    </div>
  );
}
