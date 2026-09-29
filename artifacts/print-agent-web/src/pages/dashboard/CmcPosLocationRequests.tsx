import { useState, useDeferredValue } from "react";
import { useTranslation } from "react-i18next";
import { Link, useSearch, useLocation } from "wouter";
import {
  Plus, Search, ChevronLeft, ChevronRight, ArrowRight,
  Loader2, AlertCircle, Clock, Package, Truck, MoreHorizontal,
  Filter,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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
import { apiFetch } from "@/lib/queryClient";
import { isPermissionError } from "@/lib/permissionError";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/hooks/use-toast";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";

// ── Types ─────────────────────────────────────────────────────────────────────

type Location = { id: number; name: string };

type LineItem = {
  id: number;
  product_id: number | null;
  name: string | null;
  requested_qty: number;
  unit_price: string | null;
};

type BranchRequest = {
  id: string;
  status: string;
  priority: string;
  purpose: string;
  needed_by: string | null;
  created_at: string;
  destination_location_name: string | null;
  source_location_name: string | null;
  item_count: number;
  total_units: number;
  line_items: LineItem[] | null;
  requested_by_email?: string | null;
};

type RequestsResponse = {
  requests: BranchRequest[];
  total: number;
  limit: number;
  offset: number;
};

type Metrics = {
  open: number;
  urgent: number;
  awaiting_approval: number;
  dispatched_today: number;
};

type Tab = "all" | "needs_attention" | "drafts" | "completed";

// ── Constants ─────────────────────────────────────────────────────────────────

const PAGE_SIZE = 20;

const STATUS_CONFIG: Record<string, { label: string; classes: string }> = {
  draft:       { label: "Draft",       classes: "bg-gray-100 text-gray-600 border-gray-200" },
  submitted:   { label: "Submitted",   classes: "bg-blue-50 text-blue-700 border-blue-200" },
  accepted:    { label: "Approved",    classes: "bg-yellow-50 text-yellow-700 border-yellow-200" },
  dispatched:  { label: "Dispatched",  classes: "bg-orange-50 text-orange-700 border-orange-200" },
  received:    { label: "Delivered",   classes: "bg-emerald-50 text-emerald-700 border-emerald-200" },
  cancelled:   { label: "Cancelled",   classes: "bg-red-50 text-red-600 border-red-200" },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatNeededBy(iso: string | null): { text: string; isOverdue: boolean; isToday: boolean } {
  if (!iso) return { text: "—", isOverdue: false, isToday: false };
  const d = new Date(iso);
  const now = new Date();
  const todayStr = now.toDateString();
  const isToday = d.toDateString() === todayStr;
  const isOverdue = d < now && !isToday;
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const date = isToday ? "Today" : d.toLocaleDateString([], { month: "short", day: "numeric" });
  return { text: `${date}, ${time}`, isOverdue, isToday };
}

function shortId(id: string) {
  return `BR-${id.slice(0, 4).toUpperCase()}`;
}

function itemSummary(items: LineItem[] | null): string {
  if (!items || items.length === 0) return "—";
  const first = items[0].name ?? "Item";
  if (items.length === 1) return first;
  return `${first} + ${items.length - 1} more`;
}

// ── Metric card ───────────────────────────────────────────────────────────────

function MetricCard({ label, value, icon: Icon, color }: {
  label: string; value: number; icon: React.ElementType; color: string;
}) {
  return (
    <div className="rounded-xl border bg-card p-4 flex items-center gap-4">
      <div className={`flex h-10 w-10 items-center justify-center rounded-lg shrink-0 ${color}`}>
        <Icon className="h-5 w-5" />
      </div>
      <div>
        <p className="text-2xl font-bold leading-tight">{value}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
      </div>
    </div>
  );
}

// ── Table row ─────────────────────────────────────────────────────────────────

function RequestRow({
  request,
  onAction,
  onDelete,
  actionPending,
  canAccept,
  canDispatch,
  canCancel,
  canDelete,
}: {
  request: BranchRequest;
  onAction: (id: string, action: string) => void;
  onDelete: (id: string) => void;
  actionPending: boolean;
  canAccept: boolean;
  canDispatch: boolean;
  canCancel: boolean;
  canDelete: boolean;
}) {
  const isUrgent = request.priority === "urgent";
  const { text: neededByText, isOverdue, isToday } = formatNeededBy(request.needed_by);
  const statusConf = STATUS_CONFIG[request.status] ?? { label: request.status, classes: "bg-gray-100 text-gray-600 border-gray-200" };
  const items = request.line_items ?? [];

  const actions: { label: string; action: string; show: boolean; destructive?: boolean }[] = [
    { label: "View details", action: "view", show: true },
    { label: "Approve", action: "accept", show: request.status === "submitted" && canAccept },
    { label: "Dispatch", action: "dispatch", show: request.status === "accepted" && canDispatch },
    { label: "Cancel", action: "cancel", show: ["submitted", "accepted", "draft"].includes(request.status) && canCancel },
    { label: "Delete", action: "delete", show: ["draft", "submitted", "accepted", "cancelled", "received"].includes(request.status) && canDelete, destructive: true },
  ].filter((a) => a.show);

  return (
    <tr
      className={`border-b last:border-0 hover:bg-muted/40 transition-colors ${
        isUrgent && !["received", "cancelled"].includes(request.status)
          ? "border-l-2 border-l-orange-400"
          : ""
      }`}
    >
      {/* Request ID + date */}
      <td className="py-3 px-4">
        <Link href={`/cmc-pos/request/${request.id}`}>
          <span className="font-medium text-teal-700 hover:underline cursor-pointer text-sm">
            {shortId(request.id)}
          </span>
        </Link>
        <p className="text-xs text-muted-foreground mt-0.5">
          {new Date(request.created_at).toLocaleDateString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
        </p>
      </td>

      {/* From → To */}
      <td className="py-3 px-4">
        <div className="flex items-center gap-1.5 text-sm">
          <span className="text-muted-foreground">{request.source_location_name ?? "—"}</span>
          <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
          <span className="font-medium">{request.destination_location_name ?? "—"}</span>
        </div>
      </td>

      {/* Items summary */}
      <td className="py-3 px-4">
        <p className="text-sm">{itemSummary(items)}</p>
        <p className="text-xs text-muted-foreground">{Number(request.item_count)} items</p>
      </td>

      {/* Needed by */}
      <td className="py-3 px-4">
        <span className={`text-sm ${isOverdue ? "text-red-600 font-medium" : isToday ? "text-orange-600 font-medium" : "text-foreground"}`}>
          {neededByText}
        </span>
      </td>

      {/* Priority */}
      <td className="py-3 px-4">
        {isUrgent ? (
          <Badge variant="outline" className="bg-orange-50 text-orange-700 border-orange-300 text-xs font-medium">
            Urgent
          </Badge>
        ) : (
          <span className="text-sm text-muted-foreground">Standard</span>
        )}
      </td>

      {/* Status */}
      <td className="py-3 px-4">
        <Badge variant="outline" className={`text-xs font-medium ${statusConf.classes}`}>
          {statusConf.label}
        </Badge>
      </td>

      {/* Requested by */}
      <td className="py-3 px-4">
        <span className="text-sm text-muted-foreground">{request.requested_by_email ?? "—"}</span>
      </td>

      {/* Actions */}
      <td className="py-3 px-4">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-8 w-8" disabled={actionPending}>
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {actions.map((a) => (
              <DropdownMenuItem
                key={a.action}
                className={a.destructive || a.action === "cancel" ? "text-destructive" : ""}
                onClick={() => {
                  if (a.action === "view") {
                    window.location.href = `/cmc-pos/request/${request.id}`;
                  } else if (a.action === "delete") {
                    onDelete(request.id);
                  } else {
                    onAction(request.id, a.action);
                  }
                }}
              >
                {a.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </td>
    </tr>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function CmcPosLocationRequests() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { allowedPages, isOwner } = useWorkspaceRole();
  const search = useSearch();
  const [, navigate] = useLocation();

  const params = new URLSearchParams(search);
  const tab = (params.get("tab") ?? "all") as Tab;
  const sourceLocParam = params.get("source_location_id") ?? "";
  const statusParam = params.get("status") ?? "";
  const [searchInput, setSearchInput] = useState(params.get("q") ?? "");
  const deferredSearch = useDeferredValue(searchInput);
  const [page, setPage] = useState(0);

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(search);
    if (value) next.set(key, value); else next.delete(key);
    next.delete("tab"); // keep tab separate
    if (key !== "tab") { /* no-op */ }
    setPage(0);
    navigate(`/cmc-pos/location-requests?${next.toString()}`);
  }

  function setTab(t: Tab) {
    const next = new URLSearchParams(search);
    if (t === "all") next.delete("tab"); else next.set("tab", t);
    setPage(0);
    navigate(`/cmc-pos/location-requests?${next.toString()}`);
  }

  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const canAccept = isOwner || (allowedPages?.includes("cmc_pos.accept_request") ?? false);
  const canDispatch = isOwner || (allowedPages?.includes("cmc_pos.dispatch_request") ?? false);
  const canCancel = isOwner || (allowedPages?.includes("cmc_pos.create_request") ?? false);
  const canDelete = isOwner || (allowedPages?.includes("cmc_pos.delete_request") ?? false);

  // Metrics
  const { data: metrics } = useQuery<Metrics>({
    queryKey: ["cmc-pos-request-metrics"],
    queryFn: () => apiFetch<Metrics>("/api/cmc-pos/requests/metrics", {}),
    refetchInterval: 30_000,
  });

  // Locations for filter
  const { data: locationsData } = useQuery<{ locations: Location[] }>({
    queryKey: ["locations"],
    queryFn: () => apiFetch<{ locations: Location[] }>("/api/locations", {}),
  });
  const locations = locationsData?.locations ?? [];

  // Requests list
  const offset = page * PAGE_SIZE;
  const queryParams = new URLSearchParams();
  if (tab !== "all") queryParams.set("tab", tab);
  if (sourceLocParam) queryParams.set("source_location_id", sourceLocParam);
  if (statusParam) queryParams.set("status", statusParam);
  if (deferredSearch) queryParams.set("q", deferredSearch);
  queryParams.set("limit", String(PAGE_SIZE));
  queryParams.set("offset", String(offset));

  const { data, isLoading, isError } = useQuery<RequestsResponse>({
    queryKey: ["cmc-pos-requests", tab, sourceLocParam, statusParam, deferredSearch, offset],
    queryFn: () => apiFetch<RequestsResponse>(`/api/cmc-pos/requests?${queryParams.toString()}`, {}),
  });

  // Tab counts (reuse metrics + separate counts)
  const { data: allData } = useQuery<RequestsResponse>({
    queryKey: ["cmc-pos-requests-count-all"],
    queryFn: () => apiFetch<RequestsResponse>("/api/cmc-pos/requests?limit=1&offset=0", {}),
  });
  const { data: attentionData } = useQuery<RequestsResponse>({
    queryKey: ["cmc-pos-requests-count-attention"],
    queryFn: () => apiFetch<RequestsResponse>("/api/cmc-pos/requests?tab=needs_attention&limit=1&offset=0", {}),
  });
  const { data: draftsData } = useQuery<RequestsResponse>({
    queryKey: ["cmc-pos-requests-count-drafts"],
    queryFn: () => apiFetch<RequestsResponse>("/api/cmc-pos/requests?tab=drafts&limit=1&offset=0", {}),
  });
  const { data: completedData } = useQuery<RequestsResponse>({
    queryKey: ["cmc-pos-requests-count-completed"],
    queryFn: () => apiFetch<RequestsResponse>("/api/cmc-pos/requests?tab=completed&limit=1&offset=0", {}),
  });

  const actionMutation = useMutation({
    mutationFn: ({ id, action }: { id: string; action: string }) =>
      apiFetch(`/api/cmc-pos/requests/${id}/${action}`, { method: "POST" }),
    onSuccess: (_, { action }) => {
      toast({ title: action === "accept" ? "Request approved" : action === "dispatch" ? "Request dispatched" : "Request cancelled" });
      qc.invalidateQueries({ queryKey: ["cmc-pos-requests"] });
      qc.invalidateQueries({ queryKey: ["cmc-pos-request-metrics"] });
    },
    onError: (err) => {
      if (isPermissionError(err)) {
        toast({ title: t("cmcPos.noPermission"), description: t("cmcPos.noPermissionDesc"), variant: "destructive" });
        return;
      }
      toast({ title: "Action failed", description: String(err), variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/cmc-pos/requests/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast({ title: "Request deleted" });
      qc.invalidateQueries({ queryKey: ["cmc-pos-requests"] });
      qc.invalidateQueries({ queryKey: ["cmc-pos-request-metrics"] });
      qc.invalidateQueries({ queryKey: ["cmc-pos-requests-count-all"] });
      qc.invalidateQueries({ queryKey: ["cmc-pos-requests-count-attention"] });
      qc.invalidateQueries({ queryKey: ["cmc-pos-requests-count-drafts"] });
      qc.invalidateQueries({ queryKey: ["cmc-pos-requests-count-completed"] });
    },
    onError: (err) => {
      if (isPermissionError(err)) {
        toast({ title: t("cmcPos.noPermission"), description: t("cmcPos.noPermissionDesc"), variant: "destructive" });
        return;
      }
      toast({ title: "Delete failed", description: String(err), variant: "destructive" });
    },
  });

  const requests = data?.requests ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="flex flex-col min-h-full">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 px-6 pt-6 pb-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Branch Requests</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Create, track, and fulfil stock requests across branches
          </p>
        </div>
        <Button asChild className="bg-teal-700 hover:bg-teal-800 text-white shrink-0">
          <Link href="/cmc-pos/request">
            <Plus className="h-4 w-4 mr-1.5" /> New request
          </Link>
        </Button>
      </div>

      {/* Metric cards */}
      <div className="grid grid-cols-2 gap-3 px-6 lg:grid-cols-4 pb-5">
        <MetricCard
          label="Open"
          value={metrics?.open ?? 0}
          icon={Package}
          color="bg-blue-50 text-blue-600"
        />
        <MetricCard
          label="Urgent"
          value={metrics?.urgent ?? 0}
          icon={AlertCircle}
          color="bg-orange-50 text-orange-600"
        />
        <MetricCard
          label="Awaiting approval"
          value={metrics?.awaiting_approval ?? 0}
          icon={Clock}
          color="bg-yellow-50 text-yellow-600"
        />
        <MetricCard
          label="Dispatched today"
          value={metrics?.dispatched_today ?? 0}
          icon={Truck}
          color="bg-emerald-50 text-emerald-600"
        />
      </div>

      {/* Tabs + Filters */}
      <div className="border-b px-6">
        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
          <TabsList className="h-auto bg-transparent p-0 gap-0 rounded-none">
            {(
              [
                { value: "all", label: "All requests", count: allData?.total },
                { value: "needs_attention", label: "Needs attention", count: attentionData?.total },
                { value: "drafts", label: "Drafts", count: draftsData?.total },
                { value: "completed", label: "Completed", count: completedData?.total },
              ] as { value: Tab; label: string; count?: number }[]
            ).map(({ value, label, count }) => (
              <TabsTrigger
                key={value}
                value={value}
                className="rounded-none border-b-2 border-transparent px-4 py-2.5 text-sm data-[state=active]:border-teal-700 data-[state=active]:text-teal-800 data-[state=active]:bg-transparent data-[state=active]:shadow-none h-auto"
              >
                {label}
                {count !== undefined && (
                  <span className="ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-xs font-medium text-muted-foreground">
                    {count}
                  </span>
                )}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2 px-6 py-3 bg-muted/30 border-b">
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(e) => { setSearchInput(e.target.value); setPage(0); }}
            placeholder="Search request, branch, or product"
            className="h-9 pl-8 text-sm"
          />
        </div>

        <Select value={sourceLocParam} onValueChange={(v) => setParam("source_location_id", v === "_all" ? "" : v)}>
          <SelectTrigger className="h-9 w-[160px] text-sm">
            <SelectValue placeholder="Source location" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="_all">All locations</SelectItem>
            {locations.map((l) => (
              <SelectItem key={l.id} value={String(l.id)}>{l.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={statusParam} onValueChange={(v) => setParam("status", v === "_all" ? "" : v)}>
          <SelectTrigger className="h-9 w-[150px] text-sm">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="_all">All statuses</SelectItem>
            {Object.entries(STATUS_CONFIG).map(([k, v]) => (
              <SelectItem key={k} value={k}>{v.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button variant="outline" size="sm" className="h-9 gap-1.5 text-sm ml-auto" onClick={() => {
          setSearchInput("");
          navigate("/cmc-pos/location-requests");
          setPage(0);
        }}>
          <Filter className="h-3.5 w-3.5" /> Clear filters
        </Button>
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : isError ? (
          <div className="py-12 text-center text-destructive text-sm">
            Failed to load requests
          </div>
        ) : requests.length === 0 ? (
          <div className="py-16 text-center">
            <Package className="h-10 w-10 text-muted-foreground mx-auto mb-3 opacity-40" />
            <p className="text-muted-foreground text-sm">No requests found</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/20">
                <th className="text-left py-2.5 px-4 text-xs font-medium text-muted-foreground">Request</th>
                <th className="text-left py-2.5 px-4 text-xs font-medium text-muted-foreground">From → To</th>
                <th className="text-left py-2.5 px-4 text-xs font-medium text-muted-foreground">Items</th>
                <th className="text-left py-2.5 px-4 text-xs font-medium text-muted-foreground">Needed by</th>
                <th className="text-left py-2.5 px-4 text-xs font-medium text-muted-foreground">Priority</th>
                <th className="text-left py-2.5 px-4 text-xs font-medium text-muted-foreground">Status</th>
                <th className="text-left py-2.5 px-4 text-xs font-medium text-muted-foreground">Requested by</th>
                <th className="py-2.5 px-4 w-10" />
              </tr>
            </thead>
            <tbody>
              {requests.map((r) => (
                <RequestRow
                  key={r.id}
                  request={r}
                  onAction={(id, action) => actionMutation.mutate({ id, action })}
                  onDelete={(id) => setDeleteConfirmId(id)}
                  actionPending={actionMutation.isPending || deleteMutation.isPending}
                  canAccept={canAccept}
                  canDispatch={canDispatch}
                  canCancel={canCancel}
                  canDelete={canDelete}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between px-6 py-3 border-t text-sm text-muted-foreground">
          <span>
            Showing {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total} requests
          </span>
          <div className="flex items-center gap-1">
            {Array.from({ length: Math.min(totalPages, 5) }, (_, i) => i + 1).map((p) => (
              <Button
                key={p}
                variant={p - 1 === page ? "default" : "outline"}
                size="sm"
                className={`h-8 w-8 text-xs ${p - 1 === page ? "bg-teal-700 hover:bg-teal-800" : ""}`}
                onClick={() => setPage(p - 1)}
              >
                {p}
              </Button>
            ))}
            {totalPages > 5 && <span className="px-1">…</span>}
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              disabled={page >= totalPages - 1}
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {total > 0 && total <= PAGE_SIZE && (
        <div className="px-6 py-3 border-t text-sm text-muted-foreground">
          Showing {total} of {total} requests
        </div>
      )}

      {/* Delete confirmation dialog */}
      <AlertDialog open={deleteConfirmId !== null} onOpenChange={(open) => { if (!open) setDeleteConfirmId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete request?</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete this request? This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (deleteConfirmId) {
                  deleteMutation.mutate(deleteConfirmId);
                  setDeleteConfirmId(null);
                }
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
