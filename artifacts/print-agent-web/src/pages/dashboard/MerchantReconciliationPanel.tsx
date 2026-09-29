import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/lib/queryClient";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
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
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Loader2, AlertTriangle, CheckCircle2, Info, RefreshCcw, Play } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ScrollArea } from "@/components/ui/scroll-area";

type RunSummary = {
  CREATE?: number;
  UPDATE?: number;
  DELETE?: number;
  NOOP?: number;
  ACTION_REQUIRED?: number;
  blocked?: boolean | string;
  blockedReason?: string;
};

type Run = {
  id: number;
  country: string;
  content_language: string;
  status: "DRAFT" | "BLOCKED" | "APPROVED" | "APPLYING" | "APPLIED";
  executionEnabled?: boolean;
  summary: RunSummary;
  created_at: string;
  approved_at: string | null;
  applied_at: string | null;
};

type Item = {
  id: number;
  product_id: number | null;
  country: string;
  content_language: string;
  offer_id: string;
  action: string;
  reason: string | null;
  state_identity: Record<string, unknown>;
  delete_approved: boolean;
  last_offer_approved: boolean;
  replacement_approval_status?: "APPROVED" | "PENDING" | "VERIFYING" | "DISAPPROVED" | "ERROR" | "TIMED_OUT";
  replacement_approval_deadline?: string | null;
  replacement_approval_checked_at?: string | null;
  replacement_approval_error?: string | null;
};

type RunDetail = {
  run: Run;
  items: Item[];
  executionEnabled?: boolean;
};

type MerchantAction = "CREATE" | "UPDATE" | "DELETE" | "NOOP" | "ACTION_REQUIRED";
type ActionFilter = "ALL" | MerchantAction;
type MarketCountry = "AE" | "LB";
type TargetSelection = MarketCountry | "BOTH";
type MarketDryRunResult = {
  country: MarketCountry;
  ok: boolean;
  runId?: number;
  summary?: Record<string, number>;
  blocked?: string | null;
  error?: string;
};

const MARKET_LABELS: Record<MarketCountry, string> = {
  AE: "UAE",
  LB: "Lebanon",
};

export function MerchantReconciliationPanel({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [targetSelection, setTargetSelection] = useState<TargetSelection>("LB");
  const [activeCountry, setActiveCountry] = useState<MarketCountry>("LB");
  const [dryRunResults, setDryRunResults] = useState<Partial<Record<MarketCountry, MarketDryRunResult>>>({});
  const [includeGoogle, setIncludeGoogle] = useState(true);
  const [actionFilter, setActionFilter] = useState<ActionFilter>("ALL");
  const [selectedItemIds, setSelectedItemIds] = useState<Set<number>>(new Set());
  const [lastOfferConfirmOpen, setLastOfferConfirmOpen] = useState(false);
  const [deleteBatchSize, setDeleteBatchSize] = useState("25");

  useEffect(() => setSelectedItemIds(new Set()), [actionFilter]);

  const { data: latestData, isLoading: loadingLatest, isError: isErrorLatest } = useQuery({
    queryKey: ["merchant-reconciliation-latest"],
    queryFn: () => apiFetch<{ runs: Partial<Record<MarketCountry, Run>> }>("/api/products/merchant-reconciliation/latest"),
    enabled: open,
  });

  const runId = latestData?.runs?.[activeCountry]?.id;

  const { data: runData, isLoading: loadingRun, isError: isErrorRun } = useQuery({
    queryKey: ["merchant-reconciliation-run", runId],
    queryFn: () => apiFetch<RunDetail>(`/api/products/merchant-reconciliation/${runId}`),
    enabled: open && !!runId,
  });

  const dryRunMutation = useMutation({
    mutationFn: (data: { countries: MarketCountry[]; contentLanguage: "en"; includeGoogle: boolean }) =>
      apiFetch<{ results: MarketDryRunResult[] }>(
        "/api/products/merchant-reconciliation/dry-run",
        { method: "POST", body: JSON.stringify(data) }
      ),
    onSuccess: (data) => {
      setDryRunResults(Object.fromEntries(
        data.results.map((result) => [result.country, result]),
      ) as Partial<Record<MarketCountry, MarketDryRunResult>>);
      queryClient.invalidateQueries({ queryKey: ["merchant-reconciliation-latest"] });
      for (const result of data.results) {
        if (result.runId) {
          queryClient.invalidateQueries({ queryKey: ["merchant-reconciliation-run", result.runId] });
        }
      }
      const succeeded = data.results.filter((result) => result.ok).length;
      const failed = data.results.length - succeeded;
      toast({
        title: failed ? "Merchant dry run completed with issues" : "Merchant dry run complete",
        description: `${succeeded} market${succeeded === 1 ? "" : "s"} ready${failed ? `; ${failed} market failed validation` : ""}.`,
        variant: failed ? "destructive" : undefined,
      });
      const firstSuccess = data.results.find((result) => result.ok);
      if (firstSuccess) setActiveCountry(firstSuccess.country);
      setActionFilter("ALL");
    },
    onError: (err: Error) => {
      toast({ title: "Dry run failed", description: err.message, variant: "destructive" });
    }
  });

  const approveDeletionsMutation = useMutation({
    mutationFn: (data: { runId: number; itemIds: number[]; approveLastOffer: boolean }) =>
      apiFetch<{ approved: number }>(`/api/products/merchant-reconciliation/${data.runId}/approve-deletions`, {
        method: "POST",
        body: JSON.stringify({ itemIds: data.itemIds, approveLastOffer: data.approveLastOffer }),
      }),
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ["merchant-reconciliation-run", vars.runId] });
      toast({ title: "Deletions approved" });
      setSelectedItemIds(new Set());
      setLastOfferConfirmOpen(false);
    },
    onError: (err: Error) => {
      toast({ title: "Failed to approve deletions", description: err.message, variant: "destructive" });
    }
  });

  const approveRunMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ approved: true }>(`/api/products/merchant-reconciliation/${id}/approve`, {
        method: "POST",
      }),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: ["merchant-reconciliation-run", id] });
      queryClient.invalidateQueries({ queryKey: ["merchant-reconciliation-latest"] });
      toast({ title: "Run approved" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to approve run", description: err.message, variant: "destructive" });
    }
  });

  const applyRunMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch<{ queued: number }>(`/api/products/merchant-reconciliation/${id}/apply`, {
        method: "POST",
      }),
    onSuccess: (_, id) => {
      queryClient.invalidateQueries({ queryKey: ["merchant-reconciliation-run", id] });
      queryClient.invalidateQueries({ queryKey: ["merchant-reconciliation-latest"] });
      toast({ title: "Create phase applied", description: "Only creates and updates were queued. Deletes remain gated." });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to apply run", description: err.message, variant: "destructive" });
    }
  });

  const applyDeleteBatchMutation = useMutation({
    mutationFn: (data: { runId: number; batchSize: number }) =>
      apiFetch<{ queued: number }>(`/api/products/merchant-reconciliation/${data.runId}/apply-delete-batch`, {
        method: "POST",
        body: JSON.stringify({ batchSize: data.batchSize }),
      }),
    onSuccess: (data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["merchant-reconciliation-run", vars.runId] });
      toast({ title: "Reviewed delete batch queued", description: `${data.queued} legacy deletes were queued.` });
    },
    onError: (err: Error) => {
      toast({ title: "Delete batch remains blocked", description: err.message, variant: "destructive" });
    },
  });

  const run = runData?.run;
  const blockedReason =
    typeof run?.summary?.blockedReason === "string"
      ? run.summary.blockedReason
      : typeof run?.summary?.blocked === "string"
        ? run.summary.blocked
        : null;
  const items = runData?.items || [];
  const filteredItems = items.filter(i => actionFilter === "ALL" || i.action === actionFilter);
  // The detail endpoint owns this gate. Accepting the run-level form as well
  // keeps the UI compatible with detail payloads during the response rollout.
  const executionEnabled = runData?.executionEnabled ?? run?.executionEnabled;
  const executionDisabled = executionEnabled === false;

  const toggleItem = (id: number) => {
    const next = new Set(selectedItemIds);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelectedItemIds(next);
  };

  const toggleAll = () => {
    const unapprovedIds = filteredItems.filter(i => !i.delete_approved).map(i => i.id);
    if (selectedItemIds.size === unapprovedIds.length && unapprovedIds.length > 0) {
      setSelectedItemIds(new Set());
    } else {
      setSelectedItemIds(new Set(unapprovedIds));
    }
  };

  const handleApproveDeletions = () => {
    if (!run) return;
    const selectedItems = items.filter(i => selectedItemIds.has(i.id));
    const hasLastOffer = selectedItems.some(i => i.state_identity?.isLastOffer);
    if (hasLastOffer) {
      setLastOfferConfirmOpen(true);
    } else {
      approveDeletionsMutation.mutate({ runId: run.id, itemIds: Array.from(selectedItemIds), approveLastOffer: false });
    }
  };

  function getActionColor(action: string) {
    switch (action) {
      case 'CREATE': return 'bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800/50';
      case 'UPDATE': return 'bg-blue-100 text-blue-800 border-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:border-blue-800/50';
      case 'DELETE': return 'bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800/50';
      case 'ACTION_REQUIRED': return 'bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900/30 dark:text-orange-400 dark:border-orange-800/50';
      case 'NOOP': return 'bg-slate-100 text-slate-800 border-slate-200 dark:bg-slate-800/50 dark:text-slate-400 dark:border-slate-700';
      default: return 'bg-muted text-muted-foreground border-border';
    }
  }

  function getReplacementApprovalColor(status: Item["replacement_approval_status"]) {
    switch (status) {
      case "APPROVED":
        return "bg-green-100 text-green-800 border-green-200 dark:bg-green-900/30 dark:text-green-400 dark:border-green-800/50";
      case "PENDING":
        return "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-900/30 dark:text-amber-400 dark:border-amber-800/50";
      case "DISAPPROVED":
        return "bg-red-100 text-red-800 border-red-200 dark:bg-red-900/30 dark:text-red-400 dark:border-red-800/50";
      case "TIMED_OUT":
        return "bg-orange-100 text-orange-800 border-orange-200 dark:bg-orange-900/30 dark:text-orange-400 dark:border-orange-800/50";
      default:
        return "bg-muted text-muted-foreground border-border";
    }
  }

  function formatApprovalTimestamp(timestamp: string) {
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? timestamp : date.toLocaleString();
  }

  function SummaryCard({ label, count, colorClass }: { label: string, count: number, colorClass: string }) {
    return (
      <div className="flex-1 bg-card border border-border rounded-lg p-4 flex flex-col items-center justify-center shadow-sm">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-2">{label}</span>
        <span className={`text-3xl font-bold ${colorClass}`}>{count}</span>
      </div>
    );
  }

  const actions: ActionFilter[] = ["ALL", "CREATE", "UPDATE", "DELETE", "NOOP", "ACTION_REQUIRED"];

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-6xl w-full h-[90vh] flex flex-col p-6 gap-0">
          <DialogHeader className="bg-emerald-900 dark:bg-emerald-950 text-white p-6 -mx-6 -mt-6 rounded-t-lg mb-6 shadow-md z-10 shrink-0">
            <DialogTitle className="text-2xl text-white flex items-center gap-2">
              <RefreshCcw size={24} />
              Merchant Reconciliation
            </DialogTitle>
            <DialogDescription className="text-emerald-100/90 text-base mt-2">
              Review and approve Google Merchant Center offer changes before they are durably queued.
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 overflow-hidden flex flex-col min-h-0">
            <div className="flex flex-wrap items-center gap-6 bg-muted/40 p-5 rounded-lg border border-border mb-6 shrink-0 shadow-sm">
              <div className="space-y-2">
                <Label className="text-xs uppercase tracking-wider text-muted-foreground font-semibold">Sync destination</Label>
                <Select value={targetSelection} onValueChange={(value) => setTargetSelection(value as TargetSelection)}>
                  <SelectTrigger className="w-44 bg-background" data-testid="select-merchant-target"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="AE">UAE</SelectItem>
                    <SelectItem value="LB">Lebanon</SelectItem>
                    <SelectItem value="BOTH">Both markets</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center gap-3 pt-5">
                <Switch id="includeGoogle" checked={includeGoogle} onCheckedChange={setIncludeGoogle} data-testid="switch-include-google" />
                <Label htmlFor="includeGoogle" className="flex items-center gap-1.5 cursor-pointer font-medium">
                  Include Google Check
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger type="button" tabIndex={-1}>
                        <Info size={15} className="text-muted-foreground" />
                      </TooltipTrigger>
                      <TooltipContent side="right">
                        <p className="w-64 text-sm leading-relaxed">Read-only live Merchant existence check. Slower but catches discrepancies between local state and actual Merchant Center offers.</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </Label>
              </div>
              <Button
                className="ml-auto mt-5 bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm"
                onClick={() => dryRunMutation.mutate({
                  countries: targetSelection === "BOTH" ? ["AE", "LB"] : [targetSelection],
                  contentLanguage: "en",
                  includeGoogle,
                })}
                disabled={dryRunMutation.isPending}
                data-testid="btn-run-dry-run"
              >
                {dryRunMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                <Play size={14} className="mr-2 fill-current" />
                Start Dry Run
              </Button>
            </div>

            <div className="grid grid-cols-2 gap-3 mb-4 shrink-0" data-testid="merchant-market-results">
              {(["AE", "LB"] as const).map((market) => {
                const latestRun = latestData?.runs?.[market];
                const result = dryRunResults[market];
                const error = result?.ok === false ? result.error : null;
                return (
                  <button
                    key={market}
                    type="button"
                    onClick={() => setActiveCountry(market)}
                    data-testid={`market-result-${market}`}
                    className={`rounded-lg border p-3 text-left transition-colors ${
                      activeCountry === market
                        ? "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/30"
                        : "border-border bg-card hover:bg-muted/40"
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold">{MARKET_LABELS[market]}</span>
                      {error ? (
                        <Badge variant="destructive">Configuration error</Badge>
                      ) : latestRun ? (
                        <Badge variant="outline">{latestRun.status}</Badge>
                      ) : (
                        <Badge variant="outline">No run</Badge>
                      )}
                    </div>
                    {error ? (
                      <p className="mt-2 text-xs text-destructive break-words">{error}</p>
                    ) : latestRun ? (
                      <p className="mt-2 text-xs text-muted-foreground">
                        Create {latestRun.summary?.CREATE ?? 0} · Update {latestRun.summary?.UPDATE ?? 0} · Delete {latestRun.summary?.DELETE ?? 0} · Action required {latestRun.summary?.ACTION_REQUIRED ?? 0}
                      </p>
                    ) : (
                      <p className="mt-2 text-xs text-muted-foreground">Start a dry run for this market.</p>
                    )}
                  </button>
                );
              })}
            </div>

            {loadingLatest || (!!runId && loadingRun) ? (
              <div className="flex-1 flex justify-center items-center">
                <Loader2 className="animate-spin text-emerald-600" size={40} />
              </div>
            ) : run ? (
              <div className="flex-1 flex flex-col min-h-0">
                {blockedReason && (
                  <div className="bg-destructive/10 border-destructive/20 border-l-4 border-l-destructive p-4 rounded-r-md flex items-start gap-3 text-destructive mb-6 shrink-0" data-testid="run-blocked-alert">
                    <AlertTriangle size={20} className="mt-0.5 shrink-0" />
                    <div>
                      <p className="font-semibold text-sm mb-1 uppercase tracking-wide">Run Blocked</p>
                      <p className="text-sm">{blockedReason}</p>
                    </div>
                  </div>
                )}
                <div className="bg-blue-50/70 dark:bg-blue-950/20 border border-blue-200 dark:border-blue-900/50 p-4 rounded-md mb-4 shrink-0" data-testid="two-phase-migration-gate">
                  <p className="font-semibold text-sm text-blue-900 dark:text-blue-300">Two-phase migration gate</p>
                  <p className="text-sm text-blue-800/90 dark:text-blue-200/90 mt-1">
                    To protect catalog coverage, replacements are created first, their Free Listings and Shopping Ads approval evidence is verified, and only then are legacy offers deleted.
                  </p>
                </div>
                {executionDisabled && (
                  <div className="bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-900/50 p-4 rounded-md flex items-start gap-3 text-amber-900 dark:text-amber-300 mb-6 shrink-0" data-testid="execution-disabled-alert">
                    <AlertTriangle size={20} className="mt-0.5 shrink-0" />
                    <div>
                      <p className="font-semibold text-sm">Execution disabled</p>
                      <p className="text-sm mt-1">The backend migration gate is not open. Review approval evidence below; this run cannot be applied until execution is enabled.</p>
                    </div>
                  </div>
                )}

                <div className="flex flex-wrap gap-4 mb-6 shrink-0">
                  <SummaryCard label="Create" count={run.summary?.CREATE || 0} colorClass="text-green-600 dark:text-green-500" />
                  <SummaryCard label="Update" count={run.summary?.UPDATE || 0} colorClass="text-blue-600 dark:text-blue-500" />
                  <SummaryCard label="Delete" count={run.summary?.DELETE || 0} colorClass="text-red-600 dark:text-red-500" />
                  <SummaryCard label="No-op" count={run.summary?.NOOP || 0} colorClass="text-slate-600 dark:text-slate-400" />
                  <SummaryCard label="Action Req" count={run.summary?.ACTION_REQUIRED || 0} colorClass="text-orange-600 dark:text-orange-500" />
                </div>

                <div className="flex flex-wrap items-center gap-2 mb-4 pb-2 shrink-0">
                  {actions.map(a => (
                    <button
                      key={a}
                      onClick={() => setActionFilter(a)}
                      className={`px-4 py-2 rounded-full text-xs font-bold tracking-wide whitespace-nowrap transition-all ${
                        actionFilter === a
                          ? "bg-emerald-100 text-emerald-900 border border-emerald-200 shadow-sm dark:bg-emerald-900/40 dark:text-emerald-300 dark:border-emerald-800"
                          : "bg-muted text-muted-foreground hover:bg-muted/80 border border-transparent"
                      }`}
                      data-testid={`filter-${a}`}
                    >
                      {a === "ALL" ? "ALL ITEMS" : a.replace("_", " ")}
                      {a !== "ALL" && (
                        <span className={`ml-2 px-2 py-0.5 rounded-full text-[10px] ${
                          actionFilter === a
                            ? "bg-emerald-200/50 dark:bg-emerald-800/50"
                            : "bg-background/50"
                        }`}>
                          {run.summary?.[a] || 0}
                        </span>
                      )}
                    </button>
                  ))}
                </div>

                {actionFilter === "DELETE" && (
                  <div className="mb-4 flex items-center justify-between bg-red-50/50 dark:bg-red-950/20 p-3 rounded-lg border border-red-100 dark:border-red-900/30 shrink-0">
                    <span className="text-sm font-medium text-red-800 dark:text-red-400">
                      {selectedItemIds.size} deletion{selectedItemIds.size !== 1 ? "s" : ""} selected
                    </span>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={selectedItemIds.size === 0 || approveDeletionsMutation.isPending || !!blockedReason || run.status !== 'DRAFT'}
                      onClick={handleApproveDeletions}
                      data-testid="btn-approve-deletions"
                      className="shadow-sm"
                    >
                      {approveDeletionsMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      Approve Selected Deletions
                    </Button>
                  </div>
                )}

                <div className="flex-1 border border-border rounded-lg overflow-hidden bg-card shadow-sm flex flex-col min-h-0">
                  <ScrollArea className="flex-1">
                    <Table>
                      <TableHeader className="bg-muted/50 sticky top-0 z-10 backdrop-blur-sm">
                        <TableRow>
                          {actionFilter === "DELETE" && (
                            <TableHead className="w-12 text-center">
                              <Checkbox
                                checked={selectedItemIds.size === filteredItems.filter(i => !i.delete_approved).length && filteredItems.filter(i => !i.delete_approved).length > 0}
                                onCheckedChange={toggleAll}
                                disabled={filteredItems.filter(i => !i.delete_approved).length === 0}
                                data-testid="select-all-deletions"
                              />
                            </TableHead>
                          )}
                          <TableHead className="font-semibold w-24">Prod ID</TableHead>
                          <TableHead className="font-semibold w-40">Offer ID</TableHead>
                          <TableHead className="font-semibold w-32">Action</TableHead>
                          <TableHead className="font-semibold">Reason</TableHead>
                          <TableHead className="font-semibold w-28 text-center">Risk</TableHead>
                          <TableHead className="font-semibold w-28 text-center">Approved</TableHead>
                           <TableHead className="font-semibold min-w-56">Market offer status</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {filteredItems.map(item => (
                          <TableRow key={item.id} data-testid={`item-row-${item.id}`} className="hover:bg-muted/30 transition-colors">
                            {actionFilter === "DELETE" && (
                              <TableCell className="text-center">
                                <Checkbox
                                  checked={selectedItemIds.has(item.id)}
                                  onCheckedChange={() => toggleItem(item.id)}
                                  disabled={item.delete_approved || !!blockedReason || run.status !== 'DRAFT'}
                                  data-testid={`select-item-${item.id}`}
                                />
                              </TableCell>
                            )}
                            <TableCell className="font-medium">{item.product_id ?? <span className="text-muted-foreground italic">None</span>}</TableCell>
                            <TableCell className="font-mono text-[11px] text-muted-foreground">{item.offer_id}</TableCell>
                            <TableCell>
                              <Badge variant="outline" className={`font-semibold tracking-wide ${getActionColor(item.action)}`}>{item.action}</Badge>
                            </TableCell>
                            <TableCell className="max-w-[300px] truncate text-sm" title={item.reason ?? undefined}>{item.reason}</TableCell>
                            <TableCell className="text-center">
                              {item.state_identity?.isLastOffer ? (
                                <Badge className="bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-400 border-orange-200 dark:border-orange-800/50 hover:bg-orange-100">Last Offer</Badge>
                              ) : <span className="text-muted-foreground text-xs font-medium">—</span>}
                            </TableCell>
                            <TableCell className="text-center">
                              {item.action === 'DELETE' ? (
                                item.delete_approved ? <CheckCircle2 className="mx-auto text-green-600 dark:text-green-500" size={18} /> : <span className="text-muted-foreground text-xs font-medium uppercase tracking-wider">Pending</span>
                              ) : (
                                <span className="text-muted-foreground text-xs font-medium">—</span>
                              )}
                            </TableCell>
                            <TableCell>
                              {item.replacement_approval_status || item.replacement_approval_deadline || item.replacement_approval_checked_at || item.replacement_approval_error ? (
                                <div className="space-y-1.5" data-testid={`replacement-approval-${item.id}`}>
                                  {item.replacement_approval_status && (
                                    <Badge variant="outline" className={`font-semibold tracking-wide ${getReplacementApprovalColor(item.replacement_approval_status)}`}>
                                      {item.replacement_approval_status}
                                    </Badge>
                                  )}
                                  {item.replacement_approval_deadline && (
                                    <p className="text-xs text-muted-foreground" data-testid={`replacement-approval-deadline-${item.id}`}>
                                      Evidence deadline: {formatApprovalTimestamp(item.replacement_approval_deadline)}
                                    </p>
                                  )}
                                  {item.replacement_approval_checked_at && (
                                    <p className="text-xs text-muted-foreground">
                                      Evidence checked: {formatApprovalTimestamp(item.replacement_approval_checked_at)}
                                    </p>
                                  )}
                                  {item.replacement_approval_error && (
                                    <p className="text-xs text-destructive break-words" data-testid={`replacement-approval-error-${item.id}`}>
                                      Approval error: {item.replacement_approval_error}
                                    </p>
                                  )}
                                </div>
                              ) : (
                                <span className="text-muted-foreground text-xs font-medium">—</span>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                        {filteredItems.length === 0 && (
                          <TableRow>
                            <TableCell colSpan={actionFilter === "DELETE" ? 8 : 7} className="h-32 text-center text-muted-foreground">
                              <div className="flex flex-col items-center justify-center gap-2">
                                <RefreshCcw className="text-muted-foreground/30" size={32} />
                                <p>No items found for this filter.</p>
                              </div>
                            </TableCell>
                          </TableRow>
                        )}
                      </TableBody>
                    </Table>
                  </ScrollArea>
                </div>

                <div className="flex items-center justify-between mt-6 pt-5 border-t border-border shrink-0">
                  <div className="text-sm font-medium">
                    Run Status: <Badge variant="outline" className="ml-2 uppercase tracking-widest bg-background">{run.status}</Badge>
                  </div>
                  <div className="flex flex-wrap items-center justify-end gap-4">
                    <Button
                      variant="outline"
                      disabled={run.status !== 'DRAFT' || !!blockedReason || approveRunMutation.isPending}
                      onClick={() => approveRunMutation.mutate(run.id)}
                      data-testid="btn-approve-run"
                      className="w-32 shadow-sm font-semibold border-emerald-200 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-800 dark:text-emerald-400 dark:hover:bg-emerald-950"
                    >
                      {approveRunMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                      Approve Run
                    </Button>
                    <div className="flex flex-col items-end gap-1">
                      <Button
                          disabled={run.status !== 'APPROVED' || !!blockedReason || executionDisabled || applyRunMutation.isPending}
                        onClick={() => applyRunMutation.mutate(run.id)}
                        data-testid="btn-apply-run"
                        className="w-32 shadow-sm font-semibold bg-emerald-600 hover:bg-emerald-700 text-white disabled:bg-emerald-600/50"
                      >
                        {applyRunMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        Apply Run
                      </Button>
                      <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">
                        {executionDisabled ? "Backend execution is disabled" : "Applying queues durable jobs"}
                      </p>
                    </div>
                    <div className="flex items-end gap-2">
                      <div className="space-y-1">
                        <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">Delete batch</Label>
                        <Select value={deleteBatchSize} onValueChange={setDeleteBatchSize}>
                          <SelectTrigger className="w-24" data-testid="select-delete-batch-size"><SelectValue /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="25">25</SelectItem>
                            <SelectItem value="50">50</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <Button
                        variant="destructive"
                        disabled={executionDisabled || run.status !== "APPLIED" || !!blockedReason || applyDeleteBatchMutation.isPending}
                        onClick={() => applyDeleteBatchMutation.mutate({ runId: run.id, batchSize: Number(deleteBatchSize) })}
                        data-testid="btn-apply-delete-batch"
                      >
                        {applyDeleteBatchMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        Queue Delete Batch
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-center p-12 border-2 border-dashed border-border rounded-lg bg-muted/10">
                <RefreshCcw size={48} className="text-muted-foreground/20 mb-4" />
                <h3 className="text-lg font-semibold mb-2">No {MARKET_LABELS[activeCountry]} Reconciliation</h3>
                <p className="text-muted-foreground max-w-sm">
                  Start a dry run above to compare your catalog with Google Merchant Center and review proposed changes.
                </p>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={lastOfferConfirmOpen} onOpenChange={setLastOfferConfirmOpen}>
        <AlertDialogContent className="border-orange-200 dark:border-orange-900/50">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2 text-orange-700 dark:text-orange-500">
              <AlertTriangle size={20} />
              Confirm Last Offer Deletion
            </AlertDialogTitle>
            <AlertDialogDescription className="text-base text-foreground mt-2">
              Some of the items you selected are marked as the <strong>last available offer</strong> for their product.
              Deleting them will remove the product entirely from Google Merchant Center. Are you sure you want to proceed?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="mt-4">
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (run) {
                  approveDeletionsMutation.mutate({ runId: run.id, itemIds: Array.from(selectedItemIds), approveLastOffer: true });
                }
              }}
              data-testid="btn-confirm-last-offer"
              className="bg-orange-600 text-white hover:bg-orange-700 shadow-sm font-semibold"
            >
              Yes, approve deletions
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}