import { useState, useDeferredValue } from "react";
import { Link } from "wouter";
import {
  Search,
  RotateCcw,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Package,
  ArrowLeft,
  X,
  AlertTriangle,
  Truck,
  Clock,
  Send,
  User,
  ImageIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { toast } from "@/hooks/use-toast";
import {
  useCmcReturnsList,
  useCmcReturnDetail,
  useCancelCmcReturn,
  RETURN_REASONS,
  COLLECTION_METHODS,
} from "@/hooks/useCmcReturns";
import type { ReturnStatus, CmcReturnSummary, CmcReturn } from "@/hooks/useCmcReturns";

// ── Constants ──────────────────────────────────────────────────────────────────

const PAGE_SIZE = 20;

const STATUS_CONFIG: Record<
  ReturnStatus,
  { label: string; classes: string }
> = {
  draft: {
    label: "Draft",
    classes: "bg-gray-100 text-gray-600 border-gray-200",
  },
  submitted: {
    label: "Submitted",
    classes: "bg-blue-50 text-blue-700 border-blue-200",
  },
  awaiting_pickup: {
    label: "Awaiting pickup",
    classes: "bg-amber-50 text-amber-700 border-amber-200",
  },
  picked_up: {
    label: "Picked up",
    classes: "bg-orange-50 text-orange-700 border-orange-200",
  },
  received: {
    label: "Received by CMC",
    classes: "bg-emerald-50 text-emerald-700 border-emerald-200",
  },
  cancelled: {
    label: "Cancelled",
    classes: "bg-red-50 text-red-600 border-red-200",
  },
};

const CANCELLABLE_STATUSES: ReturnStatus[] = [
  "draft",
  "submitted",
  "awaiting_pickup",
];

const COLLECTION_ICONS: Record<string, React.ElementType> = {
  next_delivery: Truck,
  asap: Clock,
  self_send: Send,
};

function collectionLabel(m: string): string {
  return COLLECTION_METHODS.find((x) => x.value === m)?.label ?? m;
}

function reasonLabel(r: string): string {
  return RETURN_REASONS.find((x) => x.value === r)?.label ?? r;
}

function fmtTs(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// ── Status badge ───────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: ReturnStatus }) {
  const conf = STATUS_CONFIG[status] ?? {
    label: status,
    classes: "bg-gray-100 text-gray-600 border-gray-200",
  };
  return (
    <Badge variant="outline" className={`text-xs font-medium ${conf.classes}`}>
      {conf.label}
    </Badge>
  );
}

// ── Detail sheet ───────────────────────────────────────────────────────────────

function ReturnDetailSheet({
  id,
  open,
  onClose,
}: {
  id: string | number | null;
  open: boolean;
  onClose: () => void;
}) {
  const { data, isLoading, isError } = useCmcReturnDetail(id);
  const [cancelOpen, setCancelOpen] = useState(false);
  const cancelMutation = useCancelCmcReturn(id ?? "");

  const ret = data?.return;

  const handleCancel = async () => {
    try {
      await cancelMutation.mutateAsync();
      toast({ title: "Return cancelled" });
      setCancelOpen(false);
      onClose();
    } catch {
      toast({
        title: "Failed to cancel return",
        variant: "destructive",
      });
    }
  };

  const canCancel =
    ret && CANCELLABLE_STATUSES.includes(ret.status as ReturnStatus);

  return (
    <>
      <Sheet open={open} onOpenChange={(v) => !v && onClose()}>
        <SheetContent className="w-full sm:max-w-[560px] overflow-y-auto">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <RotateCcw className="h-4 w-4 text-teal-700" />
              {ret?.reference ?? "Return detail"}
              {ret && <StatusBadge status={ret.status as ReturnStatus} />}
            </SheetTitle>
          </SheetHeader>

          {isLoading && (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          )}

          {isError && (
            <div className="py-10 text-center text-sm text-destructive">
              Failed to load return details
            </div>
          )}

          {ret && (
            <div className="mt-4 space-y-5">
              {/* Summary */}
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div>
                  <p className="text-xs text-muted-foreground">Reference</p>
                  <p className="font-mono font-semibold mt-0.5">{ret.reference}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Submitted</p>
                  <p className="mt-0.5">
                    {ret.submitted_at ? fmtTs(ret.submitted_at) : "—"}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Collection method</p>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    {(() => {
                      const Icon =
                        COLLECTION_ICONS[ret.collection_method] ?? Truck;
                      return <Icon className="h-3.5 w-3.5 text-muted-foreground" />;
                    })()}
                    <p>{collectionLabel(ret.collection_method)}</p>
                  </div>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Operator</p>
                  <p className="mt-0.5">
                    {ret.operator_name ?? ret.operator_email ?? "—"}
                  </p>
                </div>
                {ret.notes && (
                  <div className="col-span-2">
                    <p className="text-xs text-muted-foreground">Condition notes</p>
                    <p className="mt-0.5">{ret.notes}</p>
                  </div>
                )}
              </div>

              {/* Items */}
              <div>
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                  Items
                </p>
                <div className="rounded-lg border divide-y">
                  {ret.line_items.map((li, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-2.5 px-3 py-2.5 text-sm"
                    >
                      {li.image_url ? (
                        <img
                          src={li.image_url}
                          alt=""
                          className="h-8 w-8 rounded border object-cover shrink-0"
                        />
                      ) : (
                        <div className="h-8 w-8 rounded border bg-muted shrink-0 flex items-center justify-center">
                          <Package className="h-4 w-4 text-muted-foreground opacity-40" />
                        </div>
                      )}
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">{li.name_snapshot}</p>
                        {li.sku_snapshot && (
                          <p className="text-xs text-muted-foreground">
                            {li.sku_snapshot}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        <span className="font-medium">×{li.quantity}</span>
                        <Badge
                          variant="outline"
                          className="text-xs bg-muted text-muted-foreground"
                        >
                          {reasonLabel(li.reason)}
                        </Badge>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Photos */}
              {(ret.photo_urls ?? []).length > 0 && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                    Photos ({(ret.photo_urls ?? []).length})
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {(ret.photo_urls ?? []).map((url, i) => (
                      <a
                        key={i}
                        href={url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block"
                      >
                        <img
                          src={url}
                          alt={`Return photo ${i + 1}`}
                          className="h-16 w-16 rounded-lg border object-cover hover:opacity-90"
                        />
                      </a>
                    ))}
                  </div>
                </div>
              )}

              {/* Audit trail */}
              {(ret.events ?? []).length > 0 && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">
                    Activity
                  </p>
                  <div className="space-y-2">
                    {[...(ret.events ?? [])].reverse().map((e) => (
                      <div key={e.id} className="flex gap-2.5">
                        <div className="h-7 w-7 rounded-full bg-muted flex items-center justify-center shrink-0 mt-0.5">
                          <User className="h-3.5 w-3.5 text-muted-foreground" />
                        </div>
                        <div>
                          <p className="text-sm font-medium">
                            {e.from_status
                              ? `Status changed to ${STATUS_CONFIG[e.to_status as ReturnStatus]?.label ?? e.to_status}`
                              : `Return created`}
                          </p>
                          {e.notes && (
                            <p className="text-xs text-muted-foreground">
                              {e.notes}
                            </p>
                          )}
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {fmtTs(e.created_at)}
                            {e.actor_email ? ` · ${e.actor_email}` : ""}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Cancel */}
              {canCancel && (
                <div className="pt-2">
                  <Button
                    variant="outline"
                    className="text-destructive border-destructive/30 hover:bg-red-50"
                    onClick={() => setCancelOpen(true)}
                  >
                    Cancel return
                  </Button>
                </div>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>

      {/* Cancel confirmation dialog */}
      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Cancel return?</DialogTitle>
          </DialogHeader>
          <div className="flex items-start gap-2 text-sm text-muted-foreground py-2">
            <AlertTriangle className="h-4 w-4 mt-0.5 text-amber-600 shrink-0" />
            <span>
              This will cancel return{" "}
              <strong className="font-mono">{ret?.reference}</strong>. Any
              reserved stock will be restored. This cannot be undone.
            </span>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCancelOpen(false)}
              disabled={cancelMutation.isPending}
            >
              Keep return
            </Button>
            <Button
              variant="destructive"
              onClick={handleCancel}
              disabled={cancelMutation.isPending}
            >
              {cancelMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : null}
              Cancel return
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function CmcPosReturnsHistory() {
  const [searchInput, setSearchInput] = useState("");
  const deferredSearch = useDeferredValue(searchInput);
  const [statusFilter, setStatusFilter] = useState<ReturnStatus | "">("");
  const [page, setPage] = useState(0);
  const [selectedId, setSelectedId] = useState<string | number | null>(null);

  const { data, isLoading, isError } = useCmcReturnsList({
    q: deferredSearch,
    status: statusFilter,
    offset: page * PAGE_SIZE,
    limit: PAGE_SIZE,
  });

  const returns = data?.returns ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="flex flex-col min-h-full">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 px-6 pt-6 pb-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
              <Link href="/cmc-pos/returns">
                <ArrowLeft className="h-4 w-4" />
              </Link>
            </Button>
            <h1 className="text-xl font-semibold tracking-tight">
              Return History
            </h1>
          </div>
          <p className="text-sm text-muted-foreground ml-10">
            All CMC returns for your branch
          </p>
        </div>
        <Button
          asChild
          className="bg-teal-700 hover:bg-teal-800 text-white shrink-0"
        >
          <Link href="/cmc-pos/returns">
            <RotateCcw className="h-4 w-4 mr-1.5" />
            New return
          </Link>
        </Button>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2 px-6 py-3 bg-muted/30 border-b border-t">
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            value={searchInput}
            onChange={(e) => {
              setSearchInput(e.target.value);
              setPage(0);
            }}
            placeholder="Search reference or product…"
            className="h-9 pl-8 text-sm"
            aria-label="Search returns"
          />
        </div>

        <Select
          value={statusFilter || "_all"}
          onValueChange={(v) => {
            setStatusFilter(v === "_all" ? "" : (v as ReturnStatus));
            setPage(0);
          }}
        >
          <SelectTrigger className="h-9 w-[170px] text-sm" aria-label="Filter by status">
            <SelectValue placeholder="All statuses" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="_all">All statuses</SelectItem>
            {(Object.keys(STATUS_CONFIG) as ReturnStatus[]).map((s) => (
              <SelectItem key={s} value={s}>
                {STATUS_CONFIG[s].label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {(searchInput || statusFilter) && (
          <Button
            variant="ghost"
            size="sm"
            className="h-9 gap-1 text-sm text-muted-foreground"
            onClick={() => {
              setSearchInput("");
              setStatusFilter("");
              setPage(0);
            }}
          >
            <X className="h-3.5 w-3.5" />
            Clear
          </Button>
        )}
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : isError ? (
          <div className="py-12 text-center text-destructive text-sm">
            Failed to load returns
          </div>
        ) : returns.length === 0 ? (
          <div className="py-16 text-center">
            <RotateCcw className="h-10 w-10 text-muted-foreground mx-auto mb-3 opacity-30" />
            <p className="text-muted-foreground text-sm">No returns found</p>
            {!searchInput && !statusFilter && (
              <p className="text-xs text-muted-foreground mt-1">
                Create your first return to get started
              </p>
            )}
          </div>
        ) : (
          <table className="w-full text-sm" aria-label="Returns history">
            <thead>
              <tr className="border-b bg-muted/20">
                <th className="text-left py-2.5 px-4 text-xs font-medium text-muted-foreground">
                  Reference
                </th>
                <th className="text-left py-2.5 px-4 text-xs font-medium text-muted-foreground">
                  Date
                </th>
                <th className="text-center py-2.5 px-4 text-xs font-medium text-muted-foreground">
                  Products
                </th>
                <th className="text-center py-2.5 px-4 text-xs font-medium text-muted-foreground">
                  Units
                </th>
                <th className="text-left py-2.5 px-4 text-xs font-medium text-muted-foreground">
                  Operator
                </th>
                <th className="text-left py-2.5 px-4 text-xs font-medium text-muted-foreground">
                  Collection
                </th>
                <th className="text-left py-2.5 px-4 text-xs font-medium text-muted-foreground">
                  Status
                </th>
              </tr>
            </thead>
            <tbody>
              {returns.map((r) => {
                const CollectionIcon =
                  COLLECTION_ICONS[r.collection_method] ?? Truck;
                return (
                  <tr
                    key={r.id}
                    className="border-b last:border-0 hover:bg-muted/30 cursor-pointer transition-colors"
                    onClick={() => setSelectedId(r.id)}
                    role="button"
                    tabIndex={0}
                    aria-label={`Open return ${r.reference}`}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") setSelectedId(r.id);
                    }}
                  >
                    <td className="py-3 px-4">
                      <span className="font-mono font-semibold text-teal-700">
                        {r.reference}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-muted-foreground">
                      {r.submitted_at ? fmtTs(r.submitted_at) : fmtDate(r.created_at)}
                    </td>
                    <td className="py-3 px-4 text-center">{r.product_count}</td>
                    <td className="py-3 px-4 text-center">{r.unit_count}</td>
                    <td className="py-3 px-4 text-muted-foreground truncate max-w-[140px]">
                      {r.operator_name ?? r.operator_email ?? "—"}
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-1.5">
                        <CollectionIcon className="h-3.5 w-3.5 text-muted-foreground" />
                        <span>{collectionLabel(r.collection_method)}</span>
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <StatusBadge status={r.status as ReturnStatus} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between px-6 py-3 border-t bg-muted/10">
          <p className="text-xs text-muted-foreground">
            {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, total)} of{" "}
            {total}
          </p>
          <div className="flex gap-1">
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              disabled={page === 0}
              onClick={() => setPage((p) => p - 1)}
              aria-label="Previous page"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              disabled={page >= totalPages - 1}
              onClick={() => setPage((p) => p + 1)}
              aria-label="Next page"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Detail sheet */}
      <ReturnDetailSheet
        id={selectedId}
        open={selectedId !== null}
        onClose={() => setSelectedId(null)}
      />
    </div>
  );
}
