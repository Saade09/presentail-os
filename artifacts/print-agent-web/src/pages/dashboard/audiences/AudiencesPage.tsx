import { useEffect, useMemo, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  useListAudiences,
  useGetAudiencesSummary,
  useGetAudienceTemplates,
  useArchiveAudience,
  useDuplicateAudience,
  getListAudiencesQueryKey,
  getGetAudiencesSummaryQueryKey,
  getAudienceContacts,
  type Audience,
  type AudienceTemplate,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import {
  Archive, Copy, Download, Edit2, Eye, Gift, Mail, Megaphone,
  MessageCircle, MoreHorizontal, Plus, Search, Users, Zap,
} from "lucide-react";
import AudienceBuilder, { type BuilderState } from "./AudienceBuilder";
import StaticAudienceDialog from "./StaticAudienceDialog";
import { vipRules } from "./ruleUtils";
import { useDebounced } from "./useDebounced";

type TypeTab = "all" | "dynamic" | "static" | "drafts";

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString();
}

function SummaryCard({
  label, value, icon, iconClass, testId,
}: {
  label: string;
  value: number | undefined;
  icon: React.ReactNode;
  iconClass: string;
  testId: string;
}) {
  return (
    <div className="rounded-lg border bg-card p-4" data-testid={testId}>
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className="text-2xl font-bold mt-1">{value != null ? value.toLocaleString() : "—"}</p>
        </div>
        <div className={`rounded-full p-2.5 ${iconClass}`}>{icon}</div>
      </div>
    </div>
  );
}

function KindBadge({ audience }: { audience: Audience }) {
  if (audience.status === "draft") {
    return <Badge variant="outline" className="text-xs">Draft</Badge>;
  }
  return audience.kind === "dynamic" ? (
    <Badge className="bg-teal-100 text-teal-800 hover:bg-teal-100 text-xs gap-1">
      <Zap size={10} /> Dynamic
    </Badge>
  ) : (
    <Badge className="bg-slate-100 text-slate-700 hover:bg-slate-100 text-xs">Static</Badge>
  );
}

function exportAudienceCsv(audience: Audience) {
  return getAudienceContacts(audience.id, { page: 1, limit: 1000 }).then((res) => {
    const rows = [
      ["Name", "Email", "Phone", "Email reachable", "WhatsApp reachable", "Total spent (USD)"],
      ...res.contacts.map((c) => [
        (c.displayName ?? `${c.firstName ?? ""} ${c.lastName ?? ""}`).trim(),
        c.email ?? "",
        c.phone ?? "",
        c.emailReachable ? "yes" : "no",
        c.whatsappReachable ? "yes" : "no",
        c.totalSpentUsd != null ? String(c.totalSpentUsd) : "",
      ]),
    ];
    const csv = rows
      .map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${audience.name.replace(/[^\w-]+/g, "-").toLowerCase()}-contacts.csv`;
    a.click();
    URL.revokeObjectURL(url);
  });
}

export default function AudiencesPage() {
  const [, setLocation] = useLocation();
  const searchString = useSearch();
  const { toast } = useToast();
  const qc = useQueryClient();
  const { realIsOwner, allowedPages } = useWorkspaceRole();
  const canExport = realIsOwner || allowedPages === null || allowedPages.includes("customers");

  const [tab, setTab] = useState<TypeTab>("all");
  const [searchInput, setSearchInput] = useState("");
  const search = useDebounced(searchInput, 300);
  const [page, setPage] = useState(1);
  const limit = 25;
  const [builder, setBuilder] = useState<BuilderState | null>(null);
  const [staticOpen, setStaticOpen] = useState(false);
  const [archiveTarget, setArchiveTarget] = useState<Audience | null>(null);

  // Prefill support (?prefill=vip from the Contacts page)
  useEffect(() => {
    const params = new URLSearchParams(searchString);
    if (params.get("prefill") === "vip") {
      setBuilder({
        mode: "create",
        prefill: {
          name: "VIP customers",
          description: "Contacts tagged VIP who have placed or received at least one order.",
          rules: vipRules(),
        },
      });
      setLocation("/audiences", { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchString]);

  const listParams = useMemo(
    () => ({
      page,
      limit,
      ...(search ? { search } : {}),
      ...(tab === "dynamic" ? { kind: "dynamic" as const } : {}),
      ...(tab === "static" ? { kind: "static" as const } : {}),
      ...(tab === "drafts" ? { status: "draft" as const } : {}),
    }),
    [page, search, tab],
  );

  const { data, isLoading } = useListAudiences(listParams);
  const { data: summary } = useGetAudiencesSummary();
  const { data: templatesData } = useGetAudienceTemplates();

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: [getListAudiencesQueryKey()[0]] });
    void qc.invalidateQueries({ queryKey: getGetAudiencesSummaryQueryKey() });
  };

  const archiveMutation = useArchiveAudience({
    mutation: {
      onSuccess: () => {
        toast({ title: "Audience archived" });
        setArchiveTarget(null);
        invalidate();
      },
      onError: (e) => {
        toast({ title: e instanceof Error ? e.message : "Failed to archive", variant: "destructive" });
        setArchiveTarget(null);
      },
    },
  });

  const duplicateMutation = useDuplicateAudience({
    mutation: {
      onSuccess: () => {
        toast({ title: "Audience duplicated as draft" });
        invalidate();
      },
      onError: (e) =>
        toast({ title: e instanceof Error ? e.message : "Failed to duplicate", variant: "destructive" }),
    },
  });

  const audiences = data?.audiences ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / limit));

  const openBuilderFromTemplate = (tpl: AudienceTemplate) => {
    setBuilder({
      mode: "create",
      prefill: { name: tpl.name, description: tpl.description, rules: tpl.rules },
    });
  };

  const createCampaignWith = (a: Audience) => {
    setLocation(
      `/occasion-campaigns?tab=plans&create=1&audience_id=${encodeURIComponent(a.id)}&audience_name=${encodeURIComponent(a.name)}`,
    );
  };

  const tabs: { key: TypeTab; label: string }[] = [
    { key: "all", label: "All" },
    { key: "dynamic", label: "Dynamic" },
    { key: "static", label: "Static" },
    { key: "drafts", label: "Drafts" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">Audiences</h1>
          <p className="text-muted-foreground mt-1">
            Build and reuse trusted customer segments for campaigns.
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setStaticOpen(true)} data-testid="button-new-static-audience">
            <Plus size={14} className="me-1.5" /> Static audience
          </Button>
          <Button onClick={() => setBuilder({ mode: "create" })} data-testid="button-new-dynamic-audience">
            <Plus size={14} className="me-1.5" /> Dynamic audience
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <SummaryCard
          label="Marketable contacts"
          value={summary?.marketable_contacts}
          icon={<Users size={18} className="text-teal-600" />}
          iconClass="bg-teal-50"
          testId="card-marketable-contacts"
        />
        <SummaryCard
          label="Email reachable"
          value={summary?.email_reachable}
          icon={<Mail size={18} className="text-blue-600" />}
          iconClass="bg-blue-50"
          testId="card-email-reachable"
        />
        <SummaryCard
          label="WhatsApp reachable"
          value={summary?.whatsapp_reachable}
          icon={<MessageCircle size={18} className="text-emerald-600" />}
          iconClass="bg-emerald-50"
          testId="card-whatsapp-reachable"
        />
        <SummaryCard
          label="Recipients not yet converted"
          value={summary?.recipients_not_converted}
          icon={<Gift size={18} className="text-purple-600" />}
          iconClass="bg-purple-50"
          testId="card-recipients-not-converted"
        />
      </div>

      {(templatesData?.templates ?? []).length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold">Recommended opportunities</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {(templatesData?.templates ?? []).map((tpl) => (
              <div
                key={tpl.key}
                className="rounded-lg border bg-card p-4 flex flex-col gap-2"
                data-testid={`opportunity-${tpl.key}`}
              >
                <p className="font-medium text-sm">{tpl.name}</p>
                <p className="text-xs text-muted-foreground flex-1">{tpl.description}</p>
                <p className="text-sm">
                  <span className="font-semibold">{tpl.metrics.matched.toLocaleString()}</span>{" "}
                  <span className="text-muted-foreground text-xs">matching contacts (estimate)</span>
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={() => openBuilderFromTemplate(tpl)}
                  data-testid={`button-review-${tpl.key}`}
                >
                  Review audience
                </Button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="border-b">
        <nav className="flex gap-6 -mb-px overflow-x-auto" aria-label="Audience type">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              data-testid={`tab-audiences-${t.key}`}
              onClick={() => {
                setTab(t.key);
                setPage(1);
              }}
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

      <div className="relative max-w-xs">
        <Search size={14} className="absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <Input
          data-testid="input-audiences-search"
          placeholder="Search audiences…"
          value={searchInput}
          onChange={(e) => {
            setSearchInput(e.target.value);
            setPage(1);
          }}
          className="ps-8"
        />
      </div>

      {isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner className="size-8 text-primary" />
        </div>
      ) : audiences.length === 0 ? (
        <div className="text-center py-16 space-y-3" data-testid="audiences-empty-state">
          <p className="font-medium">No audiences yet</p>
          <p className="text-sm text-muted-foreground max-w-md mx-auto">
            <span className="font-medium text-foreground">Dynamic</span> audiences update
            automatically from rules (e.g. “VIP customers in Lebanon”).{" "}
            <span className="font-medium text-foreground">Static</span> audiences are fixed lists
            you pick by hand or snapshot from a dynamic audience.
          </p>
          <Button onClick={() => setBuilder({ mode: "create" })}>
            <Plus size={14} className="me-1.5" /> Create your first audience
          </Button>
        </div>
      ) : (
        <>
          <div className="rounded-md border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Audience</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead className="text-right">Contacts</TableHead>
                  <TableHead className="text-right">Reachable</TableHead>
                  <TableHead>Last updated</TableHead>
                  <TableHead>Last campaign</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {audiences.map((a) => {
                  const counts = a.cached_counts;
                  const reachable =
                    counts != null
                      ? Math.max(counts.emailReachable, counts.whatsappReachable)
                      : null;
                  return (
                    <TableRow key={a.id} data-testid={`row-audience-${a.id}`}>
                      <TableCell>
                        <button
                          type="button"
                          className="text-left font-medium hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
                          onClick={() => setLocation(`/audiences/${a.id}`)}
                          data-testid={`link-audience-${a.id}`}
                        >
                          {a.name}
                        </button>
                        {a.description && (
                          <p className="text-xs text-muted-foreground truncate max-w-xs">{a.description}</p>
                        )}
                      </TableCell>
                      <TableCell><KindBadge audience={a} /></TableCell>
                      <TableCell className="text-right">
                        {a.kind === "static"
                          ? (a.member_count ?? 0).toLocaleString()
                          : counts != null
                            ? counts.matched.toLocaleString()
                            : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        {reachable != null ? reachable.toLocaleString() : "—"}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {formatDate(a.last_evaluated_at ?? a.updated_at)}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">—</TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={`Actions for ${a.name}`} data-testid={`button-audience-actions-${a.id}`}>
                              <MoreHorizontal size={14} />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => setLocation(`/audiences/${a.id}`)}>
                              <Eye size={14} className="me-2" /> Open
                            </DropdownMenuItem>
                            {a.status !== "archived" && (
                              <DropdownMenuItem onClick={() => createCampaignWith(a)} data-testid={`action-create-campaign-${a.id}`}>
                                <Megaphone size={14} className="me-2" /> Create campaign
                              </DropdownMenuItem>
                            )}
                            {a.kind === "dynamic" && (
                              <DropdownMenuItem onClick={() => setBuilder({ mode: "edit", audience: a })}>
                                <Edit2 size={14} className="me-2" /> Edit rules
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuItem onClick={() => duplicateMutation.mutate({ id: a.id })}>
                              <Copy size={14} className="me-2" /> Duplicate
                            </DropdownMenuItem>
                            {canExport && (
                              <DropdownMenuItem
                                onClick={() =>
                                  void exportAudienceCsv(a).catch(() =>
                                    toast({ title: "Export failed", variant: "destructive" }),
                                  )
                                }
                              >
                                <Download size={14} className="me-2" /> Export CSV
                              </DropdownMenuItem>
                            )}
                            {a.status !== "archived" && (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem
                                  className="text-destructive"
                                  onClick={() => setArchiveTarget(a)}
                                  data-testid={`action-archive-${a.id}`}
                                >
                                  <Archive size={14} className="me-2" /> Archive
                                </DropdownMenuItem>
                              </>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
          {totalPages > 1 && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                Page {page} of {totalPages} · {total.toLocaleString()} audiences
              </span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  Previous
                </Button>
                <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                  Next
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      <AudienceBuilder state={builder} onClose={() => setBuilder(null)} onSaved={invalidate} />
      <StaticAudienceDialog open={staticOpen} onClose={() => setStaticOpen(false)} onCreated={invalidate} />

      <AlertDialog open={!!archiveTarget} onOpenChange={(v) => !v && setArchiveTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive audience</AlertDialogTitle>
            <AlertDialogDescription>
              Archive “{archiveTarget?.name}”? Archived audiences stop updating and can no longer be
              selected for campaigns. Nothing is deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-confirm-archive"
              onClick={() => archiveTarget && archiveMutation.mutate({ id: archiveTarget.id })}
              disabled={archiveMutation.isPending}
            >
              {archiveMutation.isPending ? "Archiving…" : "Archive"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
