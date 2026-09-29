import { useState, useMemo, useEffect } from "react";
import { Link, useLocation, useSearch } from "wouter";
import {
  Loader2,
  Plus,
  Trash2,
  ShoppingCart,
  Search,
  X,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  ChevronLeft,
  ChevronRight,
  MoreHorizontal,
  AlertTriangle,
  Clock,
  CheckCircle2,
  FileX2,
  Eye,
  Check,
  ChevronsUpDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTranslation } from "react-i18next";
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
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import {
  useListPurchaseOrders,
  useDeletePurchaseOrder,
  useAcceptPurchaseOrder,
  useListSuppliers,
  getListPurchaseOrdersQueryKey,
} from "@workspace/api-client-react";
import type { PurchaseOrder, PurchaseOrderAssignee, ListPurchaseOrdersInvoiceStatus } from "@workspace/api-client-react";
import { cn } from "@/lib/utils";
import { apiFetch } from "@/lib/queryClient";
import {
  PO_STATUS_MAP,
  PoStatusBadge,
  LocationCombobox,
  CreatePoWizard,
} from "@/components/CreatePoWizard";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type SortKey = "po_number" | "created_at" | "updated_at" | "expected_delivery" | "amount" | "status";
type SortDir = "asc" | "desc";

type PurchaseOrderSummary = {
  summary: {
    awaiting_approval: number;
    due_this_week: number;
    overdue: number;
    missing_invoices: number;
  };
  tab_counts: Record<string, number>;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function formatAmount(po: PurchaseOrder): string {
  const amt = po.grand_total_amount ?? po.total_amount ?? po.effective_total;
  if (!amt) return "—";
  const n = parseFloat(amt);
  if (isNaN(n)) return "—";
  return `${po.currency} ${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

// ---------------------------------------------------------------------------
// Delivery Urgency Badge
// ---------------------------------------------------------------------------
function DeliveryBadge({ dateStr, status }: { dateStr: string | null | undefined; status?: string }) {
  if (!dateStr) return <span className="text-xs text-muted-foreground">—</span>;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = new Date(dateStr);
  d.setHours(0, 0, 0, 0);
  const diffDays = Math.round((d.getTime() - today.getTime()) / 86400000);

  const label = formatDate(dateStr);
  // Overdue only applies to POs where supplier has accepted but goods haven't arrived
  const canBeOverdue = !status || status === "supplier_accepted" || status === "partial";

  if (diffDays < 0 && canBeOverdue) {
    return (
      <div className="space-y-0.5">
        <p className="text-xs whitespace-nowrap">{label}</p>
        <Badge variant="destructive" className="text-[10px] px-1.5 py-0 font-normal">
          {Math.abs(diffDays)}d overdue
        </Badge>
      </div>
    );
  }
  if (diffDays === 0) {
    return (
      <div className="space-y-0.5">
        <p className="text-xs whitespace-nowrap">{label}</p>
        <Badge className="text-[10px] px-1.5 py-0 font-normal bg-orange-100 text-orange-700 border-orange-200 hover:bg-orange-100">
          Today
        </Badge>
      </div>
    );
  }
  if (diffDays === 1) {
    return (
      <div className="space-y-0.5">
        <p className="text-xs whitespace-nowrap">{label}</p>
        <Badge className="text-[10px] px-1.5 py-0 font-normal bg-orange-50 text-orange-600 border-orange-200 hover:bg-orange-50">
          Tomorrow
        </Badge>
      </div>
    );
  }
  if (diffDays <= 7) {
    return (
      <div className="space-y-0.5">
        <p className="text-xs whitespace-nowrap">{label}</p>
        <Badge className="text-[10px] px-1.5 py-0 font-normal bg-yellow-50 text-yellow-700 border-yellow-200 hover:bg-yellow-50">
          In {diffDays}d
        </Badge>
      </div>
    );
  }
  return <span className="text-xs whitespace-nowrap">{label}</span>;
}

// ---------------------------------------------------------------------------
// Invoice Status Badge
// ---------------------------------------------------------------------------
function InvoiceStatusBadge({ status }: { status?: string }) {
  if (!status || status === "not_attached") return null;
  if (status === "attached")
    return <Badge variant="outline" className="text-[10px] px-1.5 py-0 font-normal">Attached</Badge>;
  if (status === "missing")
    return <Badge variant="destructive" className="text-[10px] px-1.5 py-0 font-normal">Missing</Badge>;
  if (status === "matched")
    return <Badge className="text-[10px] px-1.5 py-0 font-normal bg-green-100 text-green-700 border-green-200 hover:bg-green-100">Matched</Badge>;
  return null;
}

// ---------------------------------------------------------------------------
// Assignee Avatars
// ---------------------------------------------------------------------------
function AssigneeAvatars({ assignees }: { assignees?: PurchaseOrderAssignee[] }) {
  const visible = (assignees ?? []).slice(0, 3);
  const extra = (assignees ?? []).length - 3;

  if (visible.length === 0) return <span className="text-muted-foreground text-xs">—</span>;

  const allNames = (assignees ?? []).map((a) => a.name).join(", ");

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="flex items-center -space-x-1.5 cursor-default">
            {visible.map((a) => (
              <div
                key={a.member_user_id}
                className="w-6 h-6 rounded-full bg-teal-100 text-teal-700 flex items-center justify-center text-[9px] font-semibold ring-2 ring-white select-none uppercase"
              >
                {initials(a.name)}
              </div>
            ))}
            {extra > 0 && (
              <div className="w-6 h-6 rounded-full bg-muted text-muted-foreground flex items-center justify-center text-[9px] font-semibold ring-2 ring-white">
                +{extra}
              </div>
            )}
          </div>
        </TooltipTrigger>
        <TooltipContent side="top">
          <p className="text-xs">{allNames}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

// ---------------------------------------------------------------------------
// Supplier Combobox
// ---------------------------------------------------------------------------
function SupplierCombobox({
  value,
  onChange,
  ariaLabel,
}: {
  value: number | null;
  onChange: (id: number | null) => void;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const { data } = useListSuppliers({ q: search || undefined });
  const suppliers = data?.suppliers ?? [];
  const selected = suppliers.find((s) => s.id === value) ?? null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          role="combobox"
          aria-label={ariaLabel}
          className={cn("h-8 text-xs justify-between", value != null ? "text-foreground" : "text-muted-foreground")}
        >
          <span className="truncate max-w-[120px]">
            {selected ? (selected.display_name || selected.name) : "Supplier…"}
          </span>
          <ChevronsUpDown className="ml-1.5 size-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder="Search suppliers…" value={search} onValueChange={setSearch} />
          <CommandList>
            <CommandEmpty>No suppliers found.</CommandEmpty>
            <CommandGroup>
              {value != null && (
                <CommandItem value="" onSelect={() => { onChange(null); setOpen(false); setSearch(""); }} className="text-muted-foreground">
                  — Clear —
                </CommandItem>
              )}
              {suppliers.map((s) => (
                <CommandItem key={s.id} value={String(s.id)} onSelect={() => { onChange(s.id); setOpen(false); setSearch(""); }}>
                  <Check className={cn("mr-2 size-4", value === s.id ? "opacity-100" : "opacity-0")} />
                  <span className="truncate">{s.display_name || s.name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Summary Card
// ---------------------------------------------------------------------------
function SummaryCard({
  label,
  value,
  icon: Icon,
  iconClass,
  cardClass,
  active,
  onClick,
  loading,
}: {
  label: string;
  value: number;
  icon: React.ElementType;
  iconClass?: string;
  cardClass?: string;
  active?: boolean;
  onClick: () => void;
  loading?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex flex-col gap-1.5 rounded-xl border p-4 text-left w-full transition-all hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active ? "border-primary bg-primary/5 shadow-sm" : "border-border bg-card hover:border-primary/40",
        cardClass,
      )}
    >
      <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center", iconClass ?? "bg-muted")}>
        <Icon size={16} className={active ? "text-primary" : "text-muted-foreground"} />
      </div>
      <div>
        {loading ? (
          <div className="h-6 w-10 bg-muted animate-pulse rounded" />
        ) : (
          <p className="text-xl font-bold tracking-tight">{value.toLocaleString()}</p>
        )}
        <p className="text-xs text-muted-foreground mt-0.5 leading-tight">{label}</p>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Sort header cell
// ---------------------------------------------------------------------------
function SortTh({
  label,
  colKey,
  currentSort,
  currentDir,
  onSort,
  className,
}: {
  label: string;
  colKey: SortKey;
  currentSort: SortKey;
  currentDir: SortDir;
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  const active = currentSort === colKey;
  return (
    <th
      className={cn("px-3 py-2 text-left font-medium text-muted-foreground whitespace-nowrap select-none cursor-pointer hover:text-foreground", className)}
      onClick={() => onSort(colKey)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {active ? (
          currentDir === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />
        ) : (
          <ArrowUpDown size={12} className="opacity-30" />
        )}
      </span>
    </th>
  );
}

// ---------------------------------------------------------------------------
// PO Actions Menu
// ---------------------------------------------------------------------------
function PoActionsMenu({
  po,
  canEdit,
  isOwner,
  onDelete,
  onSubmit,
  onApprove,
  onCancel,
  onNavigate,
}: {
  po: PurchaseOrder;
  canEdit: boolean;
  isOwner: boolean;
  onDelete: (id: number) => void;
  onSubmit: (id: number) => void;
  onApprove: (id: number) => void;
  onCancel: (id: number) => void;
  onNavigate: (path: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0">
          <MoreHorizontal size={14} />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem onClick={() => onNavigate(`/purchase-orders/${po.id}`)}>
          <Eye size={14} className="mr-2" />
          View PO
        </DropdownMenuItem>
        {canEdit && po.status === "draft" && (
          <DropdownMenuItem onClick={() => onSubmit(po.id)}>
            Submit for Review
          </DropdownMenuItem>
        )}
        {(isOwner) && po.status === "sent" && (
          <DropdownMenuItem onClick={() => onApprove(po.id)}>
            <CheckCircle2 size={14} className="mr-2" />
            Mark Accepted
          </DropdownMenuItem>
        )}
        {canEdit && !["draft", "received", "cancelled"].includes(po.status) && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={() => onCancel(po.id)}
            >
              Cancel PO
            </DropdownMenuItem>
          </>
        )}
        {canEdit && po.status === "draft" && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={() => onDelete(po.id)}
            >
              <Trash2 size={14} className="mr-2" />
              Delete
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ---------------------------------------------------------------------------
// Status Tabs config
// ---------------------------------------------------------------------------
const STATUS_TABS = [
  { key: "", label: "All" },
  { key: "draft", label: "Draft" },
  { key: "created", label: "Created" },
  { key: "sent", label: "Sent to Supplier" },
  { key: "supplier_accepted", label: "Supplier Accepted" },
  { key: "partial", label: "Partially Received" },
  { key: "received", label: "Received" },
  { key: "completed", label: "Completed" },
  { key: "cancelled", label: "Cancelled" },
] as const;

// Card filters map to status / summary field
type CardFilter = "awaiting_approval" | "due_this_week" | "overdue" | "missing_invoices" | null;

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------
export default function PurchaseOrdersPage() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const search = useSearch();
  const { isOwner, allowedPages } = useWorkspaceRole();
  const canEdit = isOwner || (allowedPages?.includes("suppliers.edit") ?? false);

  // ── URL state ─────────────────────────────────────────────────────────────
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const tabStatus = params.get("tab") ?? "";
  const activeCard = (params.get("card") ?? null) as CardFilter;
  const q = params.get("q") ?? "";
  const supplierFilter = params.get("supplier") ? parseInt(params.get("supplier")!, 10) : null;
  const locationFilter = params.get("location") ? parseInt(params.get("location")!, 10) : null;
  const deliveryFrom = params.get("from") ?? "";
  const deliveryTo = params.get("to") ?? "";

  const VALID_INVOICE_STATUSES = ["awaiting_invoice", "partially_invoiced", "fully_invoiced", "matched", "difference_found"] as const;
  const rawInvoiceStatus = params.get("invoice_status");
  const invoiceStatusFilter: string | null =
    rawInvoiceStatus && (VALID_INVOICE_STATUSES as readonly string[]).includes(rawInvoiceStatus)
      ? rawInvoiceStatus
      : null;

  useEffect(() => {
    if (rawInvoiceStatus && !(VALID_INVOICE_STATUSES as readonly string[]).includes(rawInvoiceStatus)) {
      updateParams({ invoice_status: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rawInvoiceStatus]);

  const sortKey = (params.get("sort") as SortKey) ?? "created_at";
  const sortDir = (params.get("dir") as SortDir) ?? "desc";
  const page = Math.max(1, parseInt(params.get("page") ?? "1", 10) || 1);
  const PAGE_LIMIT = 20;

  function updateParams(updates: Record<string, string | null>, resetPage = true) {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(updates)) {
      if (v == null || v === "") next.delete(k);
      else next.set(k, v);
    }
    if (resetPage) next.delete("page");
    const qs = next.toString();
    navigate(`/purchase-orders${qs ? `?${qs}` : ""}`, { replace: true });
  }

  function setTab(key: string) {
    updateParams({ tab: key || null, card: null });
  }

  function setCard(key: CardFilter) {
    if (key === activeCard) {
      updateParams({ card: null, tab: null });
    } else {
      updateParams({ card: key, tab: key === "awaiting_approval" ? "sent" : null });
    }
  }

  function setSort(key: SortKey) {
    if (key === sortKey) {
      updateParams({ dir: sortDir === "asc" ? "desc" : "asc" }, false);
    } else {
      updateParams({ sort: key, dir: "desc" }, false);
    }
  }

  function clearFilters() {
    updateParams({ q: null, supplier: null, location: null, from: null, to: null, card: null, tab: null, invoice_status: null });
  }

  function changeInvoiceStatusFilter(val: string | null) {
    updateParams({ invoice_status: val });
  }

  const hasActiveFilters = q || supplierFilter || locationFilter || deliveryFrom || deliveryTo || invoiceStatusFilter;

  // Effective status param for the list query (card overrides tab)
  const effectiveStatus = useMemo(() => {
    if (activeCard === "awaiting_approval") return "sent";
    if (activeCard === "missing_invoices") return "";
    return tabStatus;
  }, [activeCard, tabStatus]);

  // ── Data: summary ─────────────────────────────────────────────────────────
  const summaryQueryKey = ["purchase-orders-summary", supplierFilter, locationFilter, q, deliveryFrom, deliveryTo];
  const { data: summaryData, isLoading: summaryLoading } = useQuery<PurchaseOrderSummary>({
    queryKey: summaryQueryKey,
    queryFn: async () => {
      const sp = new URLSearchParams();
      sp.set("summary", "1");
      if (supplierFilter) sp.set("supplier_id", String(supplierFilter));
      if (locationFilter) sp.set("location_id", String(locationFilter));
      if (q) sp.set("search", q);
      if (deliveryFrom) sp.set("delivery_from", deliveryFrom);
      if (deliveryTo) sp.set("delivery_to", deliveryTo);
      return apiFetch<PurchaseOrderSummary>(`/api/purchase-orders?${sp.toString()}`);
    },
    staleTime: 30000,
  });
  const summary = summaryData?.summary ?? { awaiting_approval: 0, due_this_week: 0, overdue: 0, missing_invoices: 0 };
  const tabCounts = summaryData?.tab_counts ?? {};

  // ── Data: list ────────────────────────────────────────────────────────────
  const listParams = {
    ...(supplierFilter != null ? { supplier_id: supplierFilter } : {}),
    ...(locationFilter != null ? { location_id: locationFilter } : {}),
    ...(q ? { search: q } : {}),
    ...(effectiveStatus ? { status: effectiveStatus } : {}),
    ...(activeCard === "missing_invoices" ? {} : {}),
    ...(deliveryFrom ? { delivery_from: deliveryFrom } : {}),
    ...(deliveryTo ? { delivery_to: deliveryTo } : {}),
    ...(invoiceStatusFilter ? { invoice_status: invoiceStatusFilter as ListPurchaseOrdersInvoiceStatus } : {}),
    sort: sortKey,
    dir: sortDir,
    page,
    limit: PAGE_LIMIT,
  };

  const { data: listData, isLoading: listLoading } = useListPurchaseOrders(listParams);

  // Filter client-side for missing_invoices card (API returns invoice_status in each row)
  const allOrders: PurchaseOrder[] = listData?.purchase_orders ?? [];
  const orders = useMemo(() => {
    if (activeCard === "missing_invoices") {
      return allOrders.filter((o) => (o as unknown as { invoice_status?: string }).invoice_status === "missing");
    }
    return allOrders;
  }, [allOrders, activeCard]);

  const totalOrders = listData?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalOrders / PAGE_LIMIT));

  // ── Suppliers data (for the has-suppliers check) ──────────────────────────
  const { data: suppliersData } = useListSuppliers({});
  const hasSuppliers = (suppliersData?.suppliers?.length ?? 0) > 0;

  // ── Dialogs ───────────────────────────────────────────────────────────────
  const [createOpen, setCreateOpen] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [confirmCancelId, setConfirmCancelId] = useState<number | null>(null);

  // ── Mutations ─────────────────────────────────────────────────────────────
  function invalidateAll() {
    qc.invalidateQueries({ queryKey: getListPurchaseOrdersQueryKey() });
    qc.invalidateQueries({ queryKey: summaryQueryKey });
  }

  const deleteMutation = useDeletePurchaseOrder({
    mutation: {
      onSuccess: () => {
        invalidateAll();
        setConfirmDeleteId(null);
        toast({ title: "Purchase order deleted" });
      },
      onError: (err) => {
        toast({ title: "Failed to delete", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
      },
    },
  });

  const acceptMutation = useAcceptPurchaseOrder({
    mutation: {
      onSuccess: () => {
        invalidateAll();
        toast({ title: "Purchase order accepted by supplier" });
      },
      onError: (err) => {
        toast({ title: "Failed to record acceptance", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
      },
    },
  });

  async function handleSubmitForApproval(id: number) {
    try {
      await apiFetch(`/api/purchase-orders/${id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ action: "submit" }),
      });
      invalidateAll();
      toast({ title: "Submitted for review" });
    } catch (err) {
      toast({ title: "Failed to submit", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    }
  }

  async function handleCancel(id: number) {
    try {
      await apiFetch(`/api/purchase-orders/${id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ action: "cancel" }),
      });
      invalidateAll();
      setConfirmCancelId(null);
      toast({ title: "Purchase order cancelled" });
    } catch (err) {
      toast({ title: "Failed to cancel", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
      setConfirmCancelId(null);
    }
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Purchase Orders</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Manage procurement across all suppliers.</p>
        </div>
        {canEdit && (
          <Button size="sm" onClick={() => setCreateOpen(true)} disabled={!hasSuppliers}>
            <Plus size={14} className="mr-1.5" />
            New PO
          </Button>
        )}
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <SummaryCard
          label="Awaiting Acceptance"
          value={summary.awaiting_approval}
          icon={Clock}
          iconClass="bg-amber-100"
          active={activeCard === "awaiting_approval"}
          onClick={() => setCard("awaiting_approval")}
          loading={summaryLoading}
        />
        <SummaryCard
          label="Due This Week"
          value={summary.due_this_week}
          icon={AlertTriangle}
          iconClass="bg-orange-100"
          active={activeCard === "due_this_week"}
          onClick={() => setCard("due_this_week")}
          loading={summaryLoading}
        />
        <SummaryCard
          label="Overdue"
          value={summary.overdue}
          icon={AlertTriangle}
          iconClass="bg-red-100"
          active={activeCard === "overdue"}
          onClick={() => setCard("overdue")}
          loading={summaryLoading}
        />
        <SummaryCard
          label="Missing Invoices"
          value={summary.missing_invoices}
          icon={FileX2}
          iconClass="bg-purple-100"
          active={activeCard === "missing_invoices"}
          onClick={() => setCard("missing_invoices")}
          loading={summaryLoading}
        />
      </div>

      {/* Status Tabs */}
      <div className="flex gap-0.5 overflow-x-auto border-b border-border">
        {STATUS_TABS.map((tab) => {
          const count = tab.key === "" ? tabCounts.all : tabCounts[tab.key];
          const isActive = tabStatus === tab.key && activeCard == null;
          return (
            <button
              key={tab.key}
              onClick={() => setTab(tab.key)}
              className={cn(
                "px-3 py-2 text-xs font-medium whitespace-nowrap border-b-2 -mb-px transition-colors",
                isActive
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {tab.label}
              {count != null && count > 0 && (
                <span className={cn("ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold", isActive ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground")}>
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {/* Filter Bar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Search PO # or supplier…"
            className="h-8 pl-8 text-xs"
            value={q}
            onChange={(e) => updateParams({ q: e.target.value || null })}
          />
          {q && (
            <button
              onClick={() => updateParams({ q: null })}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X size={12} />
            </button>
          )}
        </div>
        <SupplierCombobox
          value={supplierFilter}
          onChange={(id) => updateParams({ supplier: id != null ? String(id) : null })}
          ariaLabel="Filter by supplier"
        />
        <div className="w-44">
          <LocationCombobox
            value={locationFilter}
            onChange={(id) => updateParams({ location: id != null ? String(id) : null })}
            ariaLabel="Filter by location"
          />
        </div>
        {/* Delivery date range */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground whitespace-nowrap">Delivery</span>
          <input
            type="date"
            className="h-8 rounded-md border border-input px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring bg-background"
            value={deliveryFrom}
            onChange={(e) => updateParams({ from: e.target.value || null })}
          />
          <span className="text-xs text-muted-foreground">—</span>
          <input
            type="date"
            className="h-8 rounded-md border border-input px-2 text-xs focus:outline-none focus:ring-1 focus:ring-ring bg-background"
            value={deliveryTo}
            onChange={(e) => updateParams({ to: e.target.value || null })}
          />
        </div>
        {hasActiveFilters && (
          <Button variant="ghost" size="sm" className="h-8 px-2 text-xs text-muted-foreground" onClick={clearFilters}>
            <X size={12} className="mr-1" />
            Clear
          </Button>
        )}
        <span className="text-xs text-muted-foreground whitespace-nowrap">{t("po.invoiceStatus")}</span>
        <div className="w-44">
          <Select
            value={invoiceStatusFilter ?? "all"}
            onValueChange={(val) => changeInvoiceStatusFilter(val === "all" ? null : val)}
          >
            <SelectTrigger className="h-9 text-sm">
              <SelectValue placeholder={t("po.allInvoiceStatuses")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t("po.allInvoiceStatuses")}</SelectItem>
              <SelectItem value="awaiting_invoice">{t("po.coverageStatusAwaitingInvoice")}</SelectItem>
              <SelectItem value="partially_invoiced">{t("po.coverageStatusPartiallyInvoiced")}</SelectItem>
              <SelectItem value="fully_invoiced">{t("po.coverageStatusFullyInvoiced")}</SelectItem>
              <SelectItem value="matched">{t("po.coverageStatusMatched")}</SelectItem>
              <SelectItem value="difference_found">{t("po.coverageStatusDifference")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {invoiceStatusFilter != null && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs px-2"
            onClick={() => changeInvoiceStatusFilter(null)}
          >
            Clear
          </Button>
        )}
      </div>

      {/* Table */}
      {listLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-8">
          <Loader2 size={16} className="animate-spin" />
          Loading purchase orders…
        </div>
      ) : orders.length === 0 ? (
        <EmptyState
          hasFilters={!!hasActiveFilters || !!tabStatus || !!activeCard}
          hasSuppliers={hasSuppliers}
          canEdit={canEdit}
          onClearFilters={clearFilters}
          onCreatePo={() => setCreateOpen(true)}
          onGoToSuppliers={() => navigate("/suppliers")}
        />
      ) : (
        <div className="rounded-xl border border-border overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <SortTh label="PO #" colKey="po_number" currentSort={sortKey} currentDir={sortDir} onSort={setSort} className="text-xs" />
                <th className="px-3 py-2 text-left font-medium text-muted-foreground whitespace-nowrap text-xs">Supplier</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground whitespace-nowrap text-xs">Location</th>
                <th className="px-3 py-2 text-left font-medium text-muted-foreground whitespace-nowrap text-xs">Assigned To</th>
                <SortTh label="Status" colKey="status" currentSort={sortKey} currentDir={sortDir} onSort={setSort} className="text-xs" />
                <SortTh label="Amount" colKey="amount" currentSort={sortKey} currentDir={sortDir} onSort={setSort} className="text-xs text-right" />
                <SortTh label="Delivery" colKey="expected_delivery" currentSort={sortKey} currentDir={sortDir} onSort={setSort} className="text-xs" />
                <th className="px-3 py-2 text-left font-medium text-muted-foreground whitespace-nowrap text-xs">Invoice</th>
                <th className="w-10 px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {orders.map((po) => {
                const poAny = po as unknown as { invoice_status?: string; received_at?: string; assignees?: PurchaseOrderAssignee[] };
                return (
                  <tr key={po.id} className="hover:bg-muted/30 transition-colors">
                    <td className="px-3 py-2.5 font-mono text-xs font-medium whitespace-nowrap">
                      <Link href={`/purchase-orders/${po.id}`} className="hover:underline text-primary">
                        {po.po_number_label}
                      </Link>
                    </td>
                    <td className="px-3 py-2.5 max-w-[140px]">
                      {po.supplier_id ? (
                        <Link href={`/suppliers/${po.supplier_id}`} className="hover:underline text-xs truncate block">
                          {po.supplier_name ?? `Supplier #${po.supplier_id}`}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground text-xs">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground whitespace-nowrap">
                      {po.location_name ?? "—"}
                    </td>
                    <td className="px-3 py-2.5">
                      <AssigneeAvatars assignees={poAny.assignees} />
                    </td>
                    <td className="px-3 py-2.5">
                      <PoStatusBadge status={po.status} />
                      {(po.status === "partial" || po.status === "received") && po.line_items_count > 0 && (
                        <div className="mt-1 flex items-center gap-1.5">
                          <div className="w-16 h-1 rounded-full bg-muted overflow-hidden">
                            <div
                              className={cn("h-full rounded-full", po.received_items_count >= po.line_items_count ? "bg-green-500" : "bg-yellow-400")}
                              style={{ width: `${Math.min(100, Math.round((po.received_items_count / po.line_items_count) * 100))}%` }}
                            />
                          </div>
                          <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                            {po.received_items_count}/{po.line_items_count}
                          </span>
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap text-xs">
                      {formatAmount(po)}
                    </td>
                    <td className="px-3 py-2.5">
                      {["received", "cancelled"].includes(po.status) ? (
                        <span className="text-xs text-muted-foreground">{formatDate(po.expected_delivery_date)}</span>
                      ) : (
                        <DeliveryBadge dateStr={po.expected_delivery_date} status={po.status} />
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <InvoiceStatusBadge status={poAny.invoice_status} />
                    </td>
                    <td className="px-3 py-2.5">
                      <PoActionsMenu
                        po={po}
                        canEdit={canEdit}
                        isOwner={isOwner}
                        onDelete={(id) => setConfirmDeleteId(id)}
                        onSubmit={handleSubmitForApproval}
                        onApprove={(id) => acceptMutation.mutate({ id })}
                        onCancel={(id) => setConfirmCancelId(id)}
                        onNavigate={navigate}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            Page {page} of {totalPages} · {totalOrders} total
          </span>
          <div className="flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="h-7 w-7 p-0"
              disabled={page <= 1}
              onClick={() => updateParams({ page: String(page - 1) }, false)}
            >
              <ChevronLeft size={13} />
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 w-7 p-0"
              disabled={page >= totalPages}
              onClick={() => updateParams({ page: String(page + 1) }, false)}
            >
              <ChevronRight size={13} />
            </Button>
          </div>
        </div>
      )}

      {/* Create PO Wizard */}
      <CreatePoWizard
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => invalidateAll()}
      />

      {/* Delete Confirm */}
      <AlertDialog open={confirmDeleteId !== null} onOpenChange={(v) => { if (!v) setConfirmDeleteId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete purchase order?</AlertDialogTitle>
            <AlertDialogDescription>
              This purchase order will be permanently removed. Any invoices linked to it will lose their link. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteMutation.isPending}
              onClick={() => { if (confirmDeleteId != null) deleteMutation.mutate({ id: confirmDeleteId }); }}
            >
              {deleteMutation.isPending ? <><Loader2 size={13} className="mr-1.5 animate-spin" />Deleting…</> : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Cancel Confirm */}
      <AlertDialog open={confirmCancelId !== null} onOpenChange={(v) => { if (!v) setConfirmCancelId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel purchase order?</AlertDialogTitle>
            <AlertDialogDescription>
              This will mark the purchase order as cancelled. You can still view it but it will no longer be active.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep active</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => { if (confirmCancelId != null) handleCancel(confirmCancelId); }}
            >
              Cancel PO
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty State
// ---------------------------------------------------------------------------
function EmptyState({
  hasFilters,
  hasSuppliers,
  canEdit,
  onClearFilters,
  onCreatePo,
  onGoToSuppliers,
}: {
  hasFilters: boolean;
  hasSuppliers: boolean;
  canEdit: boolean;
  onClearFilters: () => void;
  onCreatePo: () => void;
  onGoToSuppliers: () => void;
}) {
  return (
    <div className="rounded-xl border border-dashed border-border p-12 text-center space-y-3">
      <ShoppingCart size={28} className="mx-auto text-muted-foreground" />
      <div>
        <p className="font-medium text-sm">
          {hasFilters ? "No purchase orders match these filters" : "No purchase orders yet"}
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          {hasFilters
            ? "Try adjusting or clearing the filters."
            : "Create purchase orders to track supplier orders."}
        </p>
      </div>
      {hasFilters ? (
        <Button size="sm" variant="outline" onClick={onClearFilters}>
          Clear filters
        </Button>
      ) : canEdit ? (
        <div className="flex flex-col items-center gap-2">
          {hasSuppliers ? (
            <Button size="sm" variant="outline" onClick={onCreatePo}>
              <Plus size={13} className="mr-1.5" />
              New Purchase Order
            </Button>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">You need a supplier before creating a purchase order.</p>
              <Button size="sm" variant="outline" onClick={onGoToSuppliers}>
                <Plus size={13} className="mr-1.5" />
                Add a supplier
              </Button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
