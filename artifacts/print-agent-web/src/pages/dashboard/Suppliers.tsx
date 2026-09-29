import { useState, useEffect } from "react";
import { useQueryClient, useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Plus, Search, MoreHorizontal, Archive, RotateCcw, Eye, Pencil, Store, Upload, Package, Columns3, ArrowUp, ArrowDown, ArrowUpDown, Check, X, Download, AlertCircle, ChevronDown, ChevronUp, Link, Tag, Users, UserCheck, GitMerge } from "lucide-react";
import { getCountries, type Country } from "react-phone-number-input";
import { PhoneInputField } from "@/components/PhoneInputField";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { COUNTRY_CATALOGUE, EXCLUDED_COUNTRY_NAMES, getCountryMetadata, isExcludedCountry } from "@/lib/countries";
import { cn } from "@/lib/utils";
import {
  useListSuppliers,
  useCreateSupplier,
  usePatchSupplier,
  useDeleteSupplier,
  useCheckDuplicateSupplier,
  checkDuplicateSupplier,
  getCheckDuplicateSupplierQueryKey,
  getListSuppliersQueryKey,
} from "@workspace/api-client-react";
import type { Supplier, SupplierMatch, CheckDuplicateSupplierResponse, SupplierAssignment } from "@workspace/api-client-react";
import { apiFetch } from "@/lib/queryClient";

type SupplierArchiveWarning = {
  supplier: Supplier;
  open_po_count: number;
  open_invoice_count: number;
};

type SupplierMergeConflict = {
  type: string;
  source_supplier_id?: number;
  source_value?: string | number | null;
  target_value?: string | number | null;
  detail: string;
};

type SupplierMergeConflictResponse = {
  requires_confirmation?: boolean;
  target_supplier?: Supplier;
  source_suppliers?: Supplier[];
  conflicts?: SupplierMergeConflict[];
  blocking_conflicts?: SupplierMergeConflict[];
};

const SUPPLIER_ALLOWED_COUNTRIES: Country[] = getCountries().filter((c) => !isExcludedCountry(c));
const SUPPLIER_COUNTRY_OPTIONS = COUNTRY_CATALOGUE.filter(
  (c) => !EXCLUDED_COUNTRY_NAMES.includes(c.name),
);

const SUPPLIER_CATEGORIES = [
  "Raw Materials",
  "Packaging Materials",
  "Office Supplies",
  "Equipment & Machinery",
  "Maintenance & Repairs",
  "IT & Technology",
  "Logistics & Freight",
  "Professional Services",
  "Catering & Food Service",
  "Uniforms & Apparel",
  "Marketing & Advertising",
  "Security Services",
  "Cleaning & Facilities",
  "Construction & Real Estate",
  "Utilities & Energy",
  "Other",
] as const;

const PAYMENT_TERMS_OPTIONS = [
  { value: "pay_on_delivery", label: "Pay on delivery" },
  { value: "net_7", label: "Net 7" },
  { value: "net_15", label: "Net 15" },
  { value: "net_30", label: "Net 30" },
  { value: "custom", label: "Custom" },
] as const;

const CURRENCY_OPTIONS = ["USD", "AED", "LBP", "SAR", "EUR", "GBP"] as const;

const SUGGESTED_TAGS = ["Local", "International", "Preferred", "Approved", "Trial", "Seasonal", "Exclusive", "Certified", "Organic", "Bulk"] as const;

const PAGE_SIZE = 10;
const COLUMNS_STORAGE_KEY = "suppliers_hidden_columns";
const SORT_FIELD_KEY = "suppliers_sort_field";
const SORT_DIR_KEY = "suppliers_sort_dir";
const STATUS_FILTER_KEY = "suppliers_status_filter";
const COUNTRY_FILTER_KEY = "suppliers_country_filter";
const CATEGORY_FILTER_KEY = "suppliers_category_filter";
const PAYMENT_TERMS_FILTER_KEY = "suppliers_payment_terms_filter";
const HAS_LINKED_ITEMS_KEY = "suppliers_has_linked_items";
const HAS_INVOICES_KEY = "suppliers_has_invoices";
const HAS_OUTSTANDING_KEY = "suppliers_has_outstanding";
const ASSIGNED_EMPLOYEE_KEY = "suppliers_assigned_employee";

const DEFAULT_STATUS_FILTER = "active" as const;
const DEFAULT_COUNTRY_FILTER = "all";
const DEFAULT_CATEGORY_FILTER = "all";
const DEFAULT_PAYMENT_TERMS_FILTER = "all";
const DEFAULT_SORT_FIELD = null;
const DEFAULT_SORT_DIR = "asc" as const;

// ─── Column definitions ────────────────────────────────────────────────────────

type ColumnKey = "country" | "category" | "tax_number" | "items" | "invoices" | "status" | "last_activity" | "assigned_to";

interface ColumnDef {
  key: ColumnKey;
  label: string;
  defaultVisible: boolean;
  sortable: boolean;
}

const COLUMN_DEFS: ColumnDef[] = [
  { key: "country", label: "Country", defaultVisible: true, sortable: true },
  { key: "category", label: "Category", defaultVisible: true, sortable: true },
  { key: "tax_number", label: "TRN / Tax ID", defaultVisible: false, sortable: true },
  { key: "assigned_to", label: "Assigned To", defaultVisible: true, sortable: false },
  { key: "items", label: "Items", defaultVisible: true, sortable: true },
  { key: "invoices", label: "Invoices", defaultVisible: true, sortable: true },
  { key: "status", label: "Status", defaultVisible: true, sortable: true },
  { key: "last_activity", label: "Last Activity", defaultVisible: true, sortable: true },
];

function loadHiddenColumns(): Set<ColumnKey> {
  try {
    const stored = localStorage.getItem(COLUMNS_STORAGE_KEY);
    if (stored) {
      const arr = JSON.parse(stored);
      if (Array.isArray(arr)) return new Set(arr as ColumnKey[]);
    }
  } catch {
    // ignore
  }
  return new Set();
}

function saveHiddenColumns(hidden: Set<ColumnKey>) {
  try {
    localStorage.setItem(COLUMNS_STORAGE_KEY, JSON.stringify(Array.from(hidden)));
  } catch {
    // ignore
  }
}

function loadSortField(): SortField | null {
  try {
    const v = localStorage.getItem(SORT_FIELD_KEY);
    if (v === "null" || v === null) return DEFAULT_SORT_FIELD;
    return v as SortField;
  } catch {
    return DEFAULT_SORT_FIELD;
  }
}

function loadSortDir(): SortDir {
  try {
    const v = localStorage.getItem(SORT_DIR_KEY);
    if (v === "asc" || v === "desc") return v;
  } catch {
    // ignore
  }
  return DEFAULT_SORT_DIR;
}

function loadStatusFilter(): "active" | "archived" | "all" {
  try {
    const v = localStorage.getItem(STATUS_FILTER_KEY);
    if (v === "active" || v === "archived" || v === "all") return v;
  } catch {
    // ignore
  }
  return DEFAULT_STATUS_FILTER;
}

function loadCountryFilter(): string {
  try {
    const v = localStorage.getItem(COUNTRY_FILTER_KEY);
    if (v !== null) return v;
  } catch {
    // ignore
  }
  return DEFAULT_COUNTRY_FILTER;
}

function loadCategoryFilter(): string {
  try {
    const v = localStorage.getItem(CATEGORY_FILTER_KEY);
    if (v !== null) return v;
  } catch {
    // ignore
  }
  return DEFAULT_CATEGORY_FILTER;
}

function loadPaymentTermsFilter(): string {
  try {
    const v = localStorage.getItem(PAYMENT_TERMS_FILTER_KEY);
    if (v !== null) return v;
  } catch {
    // ignore
  }
  return DEFAULT_PAYMENT_TERMS_FILTER;
}

function loadHasLinkedItems(): boolean {
  try {
    return localStorage.getItem(HAS_LINKED_ITEMS_KEY) === "true";
  } catch {
    return false;
  }
}

function loadHasInvoices(): boolean {
  try {
    return localStorage.getItem(HAS_INVOICES_KEY) === "true";
  } catch {
    return false;
  }
}

function loadHasOutstanding(): boolean {
  try {
    return localStorage.getItem(HAS_OUTSTANDING_KEY) === "true";
  } catch {
    return false;
  }
}

function loadAssignedEmployee(): string {
  try {
    const v = localStorage.getItem(ASSIGNED_EMPLOYEE_KEY);
    return v ?? "all";
  } catch {
    return "all";
  }
}

function saveAssignedEmployee(v: string) {
  try {
    localStorage.setItem(ASSIGNED_EMPLOYEE_KEY, v);
  } catch {
    // ignore
  }
}

function saveFilterState(
  sortField: SortField | null,
  sortDir: SortDir,
  statusFilter: "active" | "archived" | "all",
  countryFilter: string,
  categoryFilter: string,
  paymentTermsFilter: string,
  hasLinkedItems: boolean,
  hasInvoices: boolean,
  hasOutstanding: boolean,
) {
  try {
    localStorage.setItem(SORT_FIELD_KEY, sortField ?? "null");
    localStorage.setItem(SORT_DIR_KEY, sortDir);
    localStorage.setItem(STATUS_FILTER_KEY, statusFilter);
    localStorage.setItem(COUNTRY_FILTER_KEY, countryFilter);
    localStorage.setItem(CATEGORY_FILTER_KEY, categoryFilter);
    localStorage.setItem(PAYMENT_TERMS_FILTER_KEY, paymentTermsFilter);
    localStorage.setItem(HAS_LINKED_ITEMS_KEY, String(hasLinkedItems));
    localStorage.setItem(HAS_INVOICES_KEY, String(hasInvoices));
    localStorage.setItem(HAS_OUTSTANDING_KEY, String(hasOutstanding));
  } catch {
    // ignore
  }
}

function clearFilterState() {
  try {
    localStorage.removeItem(SORT_FIELD_KEY);
    localStorage.removeItem(SORT_DIR_KEY);
    localStorage.removeItem(STATUS_FILTER_KEY);
    localStorage.removeItem(COUNTRY_FILTER_KEY);
    localStorage.removeItem(CATEGORY_FILTER_KEY);
    localStorage.removeItem(PAYMENT_TERMS_FILTER_KEY);
    localStorage.removeItem(HAS_LINKED_ITEMS_KEY);
    localStorage.removeItem(HAS_INVOICES_KEY);
    localStorage.removeItem(HAS_OUTSTANDING_KEY);
    localStorage.removeItem(ASSIGNED_EMPLOYEE_KEY);
  } catch {
    // ignore
  }
}

// ─── Sort helpers ──────────────────────────────────────────────────────────────

type SortField = "supplier" | ColumnKey;
type SortDir = "asc" | "desc";

function sortSuppliers(suppliers: Supplier[], field: SortField | null, dir: SortDir): Supplier[] {
  if (!field) return suppliers;
  return [...suppliers].sort((a, b) => {
    let cmp = 0;
    switch (field) {
      case "supplier": {
        const da = (a.display_name || a.name).toLowerCase();
        const db = (b.display_name || b.name).toLowerCase();
        cmp = da.localeCompare(db);
        break;
      }
      case "country": {
        const ca = (a.country ?? "").toLowerCase();
        const cb = (b.country ?? "").toLowerCase();
        cmp = ca.localeCompare(cb);
        break;
      }
      case "category": {
        const ca = (a.category ?? "").toLowerCase();
        const cb = (b.category ?? "").toLowerCase();
        cmp = ca.localeCompare(cb);
        break;
      }
      case "items": {
        cmp = (a.item_count ?? 0) - (b.item_count ?? 0);
        break;
      }
      case "status": {
        cmp = Number(a.is_archived) - Number(b.is_archived);
        break;
      }
      case "last_activity": {
        const da = new Date(a.updated_at ?? a.created_at ?? 0).getTime();
        const db = new Date(b.updated_at ?? b.created_at ?? 0).getTime();
        cmp = da - db;
        break;
      }
      case "tax_number": {
        const ta = (a.tax_number ?? "").toLowerCase();
        const tb = (b.tax_number ?? "").toLowerCase();
        cmp = ta.localeCompare(tb);
        break;
      }
      case "invoices": {
        const countDiff = (a.invoice_count ?? 0) - (b.invoice_count ?? 0);
        if (countDiff !== 0) { cmp = countDiff; break; }
        cmp = parseFloat(a.spend_ytd ?? "0") - parseFloat(b.spend_ytd ?? "0");
        break;
      }
      default:
        cmp = 0;
    }
    return dir === "asc" ? cmp : -cmp;
  });
}

// ─── SortableHeader ───────────────────────────────────────────────────────────

function SortableHeader({
  field,
  label,
  sortField,
  sortDir,
  onSort,
  className,
}: {
  field: SortField;
  label: string;
  sortField: SortField | null;
  sortDir: SortDir;
  onSort: (f: SortField) => void;
  className?: string;
}) {
  const active = sortField === field;
  return (
    <button
      type="button"
      onClick={() => onSort(field)}
      className={cn(
        "inline-flex items-center gap-1 text-left font-medium text-muted-foreground whitespace-nowrap hover:text-foreground transition-colors group",
        active && "text-foreground",
        className,
      )}
    >
      {label}
      <span className={cn("opacity-40 group-hover:opacity-100 transition-opacity", active && "opacity-100")}>
        {active ? (
          sortDir === "asc" ? <ArrowUp size={12} /> : <ArrowDown size={12} />
        ) : (
          <ArrowUpDown size={12} />
        )}
      </span>
    </button>
  );
}

// ─── Workspace members ────────────────────────────────────────────────────────

type WorkspaceMember = {
  id: number;
  email: string;
  role: string;
  joined: boolean;
  first_name: string | null;
  last_name: string | null;
  image_url: string | null;
  revoked_at: string | null;
};

function memberDisplayName(m: WorkspaceMember): string {
  return [m.first_name, m.last_name].filter(Boolean).join(" ").trim() || m.email;
}

function useWorkspaceMembers(enabled = true) {
  return useQuery<{ members: WorkspaceMember[] }>({
    queryKey: ["users"],
    queryFn: () => apiFetch<{ members: WorkspaceMember[] }>("/api/users"),
    enabled,
    staleTime: 60_000,
  });
}

// ─── AssignmentAvatar ─────────────────────────────────────────────────────────

function AssignmentAvatar({
  assignment,
  size = 24,
}: {
  assignment: SupplierAssignment;
  size?: number;
}) {
  const name = assignment.name ?? assignment.memberEmail;
  const initial = (name[0] ?? "?").toUpperCase();
  if (assignment.imageUrl) {
    return (
      <img
        src={assignment.imageUrl}
        alt={name}
        title={name + (assignment.isLead ? " (Lead)" : "")}
        className="rounded-full object-cover shrink-0 ring-1 ring-background"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <div
      title={name + (assignment.isLead ? " (Lead)" : "")}
      className={cn(
        "rounded-full flex items-center justify-center shrink-0 ring-1 ring-background font-semibold",
        assignment.isLead ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
      )}
      style={{ width: size, height: size, fontSize: Math.max(9, size * 0.38) }}
    >
      {initial}
    </div>
  );
}

// ─── AssignmentAvatarStack ────────────────────────────────────────────────────

function AssignmentAvatarStack({
  assignments,
  max = 3,
}: {
  assignments: SupplierAssignment[];
  max?: number;
}) {
  if (!assignments || assignments.length === 0) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-dashed border-muted-foreground/40 px-2 py-0.5 text-xs text-muted-foreground hover:border-muted-foreground/70 hover:text-foreground transition-colors">
        <Plus size={11} />
        Assign
      </span>
    );
  }
  const visible = assignments.slice(0, max);
  const extra = assignments.length - max;
  return (
    <div className="group/assign flex items-center gap-1.5">
      <div className="flex -space-x-1.5">
        {visible.map((a) => (
          <AssignmentAvatar key={a.memberId} assignment={a} size={24} />
        ))}
        {extra > 0 && (
          <div
            title={`+${extra} more`}
            className="rounded-full bg-muted text-muted-foreground ring-1 ring-background flex items-center justify-center"
            style={{ width: 24, height: 24, fontSize: 9, fontWeight: 600 }}
          >
            +{extra}
          </div>
        )}
      </div>
      <Pencil
        size={11}
        className="text-muted-foreground/50 opacity-0 group-hover/assign:opacity-100 transition-opacity shrink-0"
      />
    </div>
  );
}

// ─── AssignmentPopover ────────────────────────────────────────────────────────

function AssignmentPopover({
  supplier,
  members,
  canEdit,
  onSaved,
}: {
  supplier: Supplier;
  members: WorkspaceMember[];
  canEdit: boolean;
  onSaved?: () => void;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [search, setSearch] = useState("");
  const current = supplier.assignments ?? [];
  const [selected, setSelected] = useState<number[]>(current.map((a) => a.memberId));
  const [leadId, setLeadId] = useState<number | null>(current.find((a) => a.isLead)?.memberId ?? null);

  useEffect(() => {
    if (open) {
      const c = supplier.assignments ?? [];
      setSelected(c.map((a) => a.memberId));
      setLeadId(c.find((a) => a.isLead)?.memberId ?? null);
    } else {
      setSearch("");
    }
  }, [open, supplier.assignments]);

  const activeMemberIds = new Set(members.map((m) => m.id));
  const revokedAssignments = current.filter((a) => !activeMemberIds.has(a.memberId));

  const filteredMembers = search.trim()
    ? members.filter((m) => {
        const q = search.toLowerCase();
        return (
          memberDisplayName(m).toLowerCase().includes(q) ||
          m.email.toLowerCase().includes(q)
        );
      })
    : members;

  function toggleMember(id: number) {
    setSelected((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      if (!next.includes(leadId ?? -1)) setLeadId(null);
      return next;
    });
  }

  async function handleSave(e: React.MouseEvent) {
    e.stopPropagation();
    setSaving(true);
    try {
      const res = await fetch(`/api/suppliers/${supplier.id}/assignments`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ member_ids: selected, lead_member_id: leadId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      toast({ title: "Assignments updated" });
      setOpen(false);
      onSaved?.();
    } catch (err) {
      toast({ title: "Failed to update assignments", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  const hasAssignments = current.length > 0;

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={hasAssignments ? "Edit assignments" : "Assign members"}
          className="cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={(e) => e.stopPropagation()}
        >
          <AssignmentAvatarStack assignments={current} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-64 p-2"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="text-xs font-semibold text-muted-foreground px-1 mb-2">
          Assigned To
        </p>
        <div className="relative mb-2">
          <Search size={12} className="absolute start-2 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search members…"
            className="w-full rounded border border-input bg-background ps-6 pe-2 py-1 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        {members.length === 0 && (
          <p className="text-xs text-muted-foreground px-1 py-1">No workspace members found.</p>
        )}
        <div className="max-h-48 overflow-y-auto space-y-0.5">
          {filteredMembers.map((m) => {
            const isSelected = selected.includes(m.id);
            return (
              <DropdownMenuItem
                key={m.id}
                onSelect={(e) => { e.preventDefault(); if (canEdit) toggleMember(m.id); }}
                className="gap-2 cursor-pointer"
              >
                <span className={cn("flex h-4 w-4 items-center justify-center rounded border border-input shrink-0", isSelected && "bg-primary border-primary")}>
                  {isSelected && <Check size={10} className="text-primary-foreground" />}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm truncate">{memberDisplayName(m)}</p>
                  {m.first_name && <p className="text-xs text-muted-foreground truncate">{m.email}</p>}
                </div>
                {isSelected && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); if (canEdit) setLeadId(leadId === m.id ? null : m.id); }}
                    className={cn(
                      "text-xs rounded px-1 py-0.5 border shrink-0",
                      leadId === m.id
                        ? "bg-primary text-primary-foreground border-primary"
                        : "text-muted-foreground border-border hover:border-foreground/40",
                    )}
                    title="Set as lead"
                  >
                    Lead
                  </button>
                )}
              </DropdownMenuItem>
            );
          })}
          {filteredMembers.length === 0 && members.length > 0 && (
            <p className="text-xs text-muted-foreground px-1 py-2 text-center">No members match.</p>
          )}
          {revokedAssignments.length > 0 && (
            <>
              <p className="text-xs font-semibold text-muted-foreground px-1 pt-2 pb-1">Removed members</p>
              {revokedAssignments.map((a) => (
                <div
                  key={a.memberId}
                  className="flex items-center gap-2 px-2 py-1.5 rounded opacity-50 select-none"
                  title="This member has been removed from the workspace"
                >
                  <span className="flex h-4 w-4 items-center justify-center rounded border border-input shrink-0 bg-muted" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm truncate">{a.name ?? a.memberEmail}</p>
                    {a.name && <p className="text-xs text-muted-foreground truncate">{a.memberEmail}</p>}
                  </div>
                  <span className="text-xs text-muted-foreground border border-border rounded px-1 py-0.5 shrink-0">
                    Removed
                  </span>
                </div>
              ))}
            </>
          )}
        </div>
        {canEdit && (
          <>
            <DropdownMenuSeparator />
            <div className="flex justify-end pt-1">
              <Button size="sm" className="h-7 text-xs" disabled={saving} onClick={handleSave}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ─── BulkAssignDialog ─────────────────────────────────────────────────────────

function BulkAssignDialog({
  open,
  onClose,
  supplierIds,
  members,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  supplierIds: number[];
  members: WorkspaceMember[];
  onSaved?: () => void;
}) {
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<number[]>([]);
  const [leadId, setLeadId] = useState<number | null>(null);

  useEffect(() => {
    if (open) {
      setSelected([]);
      setLeadId(null);
    }
  }, [open]);

  function toggleMember(id: number) {
    setSelected((prev) => {
      const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
      if (!next.includes(leadId ?? -1)) setLeadId(null);
      return next;
    });
  }

  async function handleSave() {
    setSaving(true);
    try {
      const res = await fetch("/api/suppliers/bulk-assign", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ supplier_ids: supplierIds, member_ids: selected, lead_member_id: leadId }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      toast({ title: `Assignments updated for ${supplierIds.length} supplier${supplierIds.length !== 1 ? "s" : ""}` });
      onSaved?.();
      onClose();
    } catch (err) {
      toast({ title: "Failed to update assignments", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-sm p-0 flex flex-col">
        <DialogHeader className="px-5 pt-5 pb-4 border-b border-border">
          <DialogTitle>Bulk Assign ({supplierIds.length} supplier{supplierIds.length !== 1 ? "s" : ""})</DialogTitle>
        </DialogHeader>
        <div className="px-5 py-4 space-y-3">
          <p className="text-sm text-muted-foreground">
            Replaces existing assignments for all selected suppliers.
          </p>
          <div className="space-y-1 max-h-60 overflow-y-auto">
            {members.map((m) => {
              const isSelected = selected.includes(m.id);
              return (
                <label key={m.id} className="flex items-center gap-2.5 cursor-pointer py-1.5 px-1 rounded hover:bg-muted/50">
                  <Checkbox
                    checked={isSelected}
                    onCheckedChange={() => toggleMember(m.id)}
                    className="shrink-0"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm truncate">{memberDisplayName(m)}</p>
                    {m.first_name && <p className="text-xs text-muted-foreground truncate">{m.email}</p>}
                  </div>
                  {isSelected && (
                    <button
                      type="button"
                      onClick={() => setLeadId(leadId === m.id ? null : m.id)}
                      className={cn(
                        "text-xs rounded px-1.5 py-0.5 border shrink-0",
                        leadId === m.id
                          ? "bg-primary text-primary-foreground border-primary"
                          : "text-muted-foreground border-border hover:border-foreground/40",
                      )}
                    >
                      Lead
                    </button>
                  )}
                </label>
              );
            })}
          </div>
        </div>
        <DialogFooter className="px-5 py-4 border-t border-border gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="button" onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : `Assign (${selected.length} selected)`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── ColumnsMenu ──────────────────────────────────────────────────────────────

function ColumnsMenu({
  hiddenColumns,
  onToggle,
}: {
  hiddenColumns: Set<ColumnKey>;
  onToggle: (key: ColumnKey) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-9 gap-1.5 text-sm">
          <Columns3 size={14} />
          Columns
          {hiddenColumns.size > 0 && (
            <span className="ml-0.5 inline-flex items-center justify-center rounded-full bg-primary text-primary-foreground text-[10px] font-semibold w-4 h-4">
              {hiddenColumns.size}
            </span>
          )}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        {COLUMN_DEFS.map((col) => {
          const visible = !hiddenColumns.has(col.key);
          return (
            <DropdownMenuItem
              key={col.key}
              onSelect={(e) => { e.preventDefault(); onToggle(col.key); }}
              className="gap-2 cursor-pointer"
            >
              <span className={cn("flex h-4 w-4 items-center justify-center rounded border border-input", visible && "bg-primary border-primary")}>
                {visible && <Check size={10} className="text-primary-foreground" />}
              </span>
              {col.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ─── Form types ───────────────────────────────────────────────────────────────

export type VatStatus = 'registered' | 'not_registered' | 'unknown';

export type SupplierFormState = {
  name: string;
  display_name: string;
  category: string;
  currency_pref: string;
  country: string;
  contact_name: string;
  contact_email: string;
  contact_phone: string;
  tax_number: string;
  payment_terms: string;
  vat_status: VatStatus;
  vat_not_registered_reason: string;
  default_tax_category: string;
  billing_address: string;
  website: string;
  notes: string;
  tags: string[];
};

function emptySupplierForm(): SupplierFormState {
  return {
    name: "", display_name: "", category: "", currency_pref: "", country: "",
    contact_name: "", contact_email: "", contact_phone: "",
    tax_number: "", payment_terms: "", vat_status: "unknown",
    vat_not_registered_reason: "",
    default_tax_category: "",
    billing_address: "", website: "", notes: "", tags: [],
  };
}

export function supplierToForm(s: Supplier): SupplierFormState {
  const rawStatus = (s as { vat_status?: string | null }).vat_status;
  const vatStatus: VatStatus =
    rawStatus === "registered" || rawStatus === "not_registered" || rawStatus === "unknown"
      ? rawStatus
      : (s.vat_registered ? "registered" : "unknown");
  return {
    name: s.name,
    display_name: s.display_name ?? "",
    category: s.category ?? "",
    currency_pref: s.currency_pref ?? "",
    country: s.country ?? "",
    contact_name: s.contact_name ?? "",
    contact_email: s.contact_email ?? "",
    contact_phone: s.contact_phone ?? "",
    tax_number: s.tax_number ?? "",
    payment_terms: s.payment_terms ?? "",
    vat_status: vatStatus,
    vat_not_registered_reason: (s as { vat_not_registered_reason?: string | null }).vat_not_registered_reason ?? "",
    default_tax_category: (s as { default_tax_category?: string }).default_tax_category ?? "",
    billing_address: s.billing_address ?? "",
    website: s.website ?? "",
    notes: s.notes ?? "",
    tags: Array.isArray(s.tags) ? s.tags : [],
  };
}

export function taxNumberLabel(country: string): string {
  if (country === "Lebanon") return "MOF";
  if (country === "United Arab Emirates") return "TRN";
  return "Tax Number";
}

function supplierInitials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

// ─── SupplierMatchCard ────────────────────────────────────────────────────────

function SupplierMatchCard({ match }: { match: SupplierMatch }) {
  return (
    <div className="rounded border border-border bg-background p-2.5 flex items-start justify-between gap-2 text-sm">
      <div className="space-y-0.5 min-w-0">
        <p className="font-medium truncate">{match.display_name || match.name}</p>
        {match.display_name && <p className="text-xs text-muted-foreground truncate">{match.name}</p>}
        <div className="flex items-center gap-2 flex-wrap">
          {match.category && <span className="text-xs text-muted-foreground">{match.category}</span>}
          {match.country && <span className="text-xs text-muted-foreground">{match.country}</span>}
          <Badge variant={match.status === "archived" ? "secondary" : "outline"} className="text-[10px] h-4 px-1">
            {match.status}
          </Badge>
        </div>
      </div>
      <a
        href={`/suppliers/${match.id}`}
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs text-primary shrink-0 underline-offset-2 hover:underline whitespace-nowrap"
      >
        View existing
      </a>
    </div>
  );
}

// ─── DuplicateWarningBlock ────────────────────────────────────────────────────

function DuplicateWarningBlock({
  result,
  acknowledged,
  onAcknowledge,
}: {
  result: CheckDuplicateSupplierResponse;
  acknowledged: boolean;
  onAcknowledge: (v: boolean) => void;
}) {
  const topMatches = result.similarMatches.slice(0, 3);

  if (result.exactMatch) {
    return (
      <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 space-y-2">
        <div className="flex items-center gap-2 text-sm font-medium text-destructive">
          <AlertCircle size={15} className="shrink-0" />
          A supplier with this name already exists
        </div>
        {topMatches.map((m) => <SupplierMatchCard key={m.id} match={m} />)}
        <p className="text-xs text-muted-foreground">Use a different name or view the existing supplier.</p>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-yellow-500/40 bg-yellow-50/50 dark:bg-yellow-500/5 p-3 space-y-2">
      <div className="flex items-center gap-2 text-sm font-medium text-yellow-700 dark:text-yellow-400">
        <AlertCircle size={15} className="shrink-0" />
        A similar supplier may already exist
      </div>
      {topMatches.map((m) => <SupplierMatchCard key={m.id} match={m} />)}
      <label className="flex items-start gap-2 cursor-pointer mt-1">
        <Checkbox
          checked={acknowledged}
          onCheckedChange={(v) => onAcknowledge(!!v)}
          className="mt-0.5 shrink-0"
        />
        <span className="text-xs text-muted-foreground leading-snug">
          I reviewed the possible duplicate and still want to create this supplier
        </span>
      </label>
    </div>
  );
}

// ─── TagInput ─────────────────────────────────────────────────────────────────

function TagInput({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => void }) {
  const [inputValue, setInputValue] = useState("");

  function commitTag(raw: string) {
    const trimmed = raw.trim().replace(/,+$/, "").trim();
    if (!trimmed || tags.includes(trimmed)) {
      setInputValue("");
      return;
    }
    onChange([...tags, trimmed]);
    setInputValue("");
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commitTag(inputValue);
    } else if (e.key === "Backspace" && inputValue === "" && tags.length > 0) {
      onChange(tags.slice(0, -1));
    }
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const val = e.target.value;
    if (val.includes(",")) {
      commitTag(val.replace(/,/g, ""));
    } else {
      setInputValue(val);
    }
  }

  return (
    <Input
      value={inputValue}
      onChange={handleChange}
      onKeyDown={handleKeyDown}
      onBlur={() => { if (inputValue.trim()) commitTag(inputValue); }}
      placeholder="Type a tag and press Enter…"
      className="text-sm"
    />
  );
}

// ─── SupplierFormModal ────────────────────────────────────────────────────────

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 mb-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground shrink-0">{children}</p>
      <div className="flex-1 border-t border-border" />
    </div>
  );
}

function mergeCheckResults(
  a: CheckDuplicateSupplierResponse | undefined,
  b: CheckDuplicateSupplierResponse | undefined,
): CheckDuplicateSupplierResponse | undefined {
  if (!a && !b) return undefined;
  if (!a) return b;
  if (!b) return a;
  const exactMatch = a.exactMatch || b.exactMatch;
  const seen = new Set<number>();
  const similarMatches: SupplierMatch[] = [];
  for (const m of [...a.similarMatches, ...b.similarMatches]) {
    if (!seen.has(m.id)) {
      seen.add(m.id);
      similarMatches.push(m);
    } else {
      const existing = similarMatches.find((x) => x.id === m.id);
      if (existing && m.score > existing.score) existing.score = m.score;
    }
  }
  similarMatches.sort((x, y) => y.score - x.score);
  return { exactMatch, similarMatches };
}

export function SupplierFormModal({
  open,
  onClose,
  initial,
  onSave,
  onSaveAndAddAnother,
  onForceSave,
  onForceSaveAndAddAnother,
  isPending,
  isForcePending,
  title,
  serverError,
  isCreate = false,
  excludeId,
  resetKey,
}: {
  open: boolean;
  onClose: () => void;
  initial: SupplierFormState;
  onSave: (form: SupplierFormState) => void;
  onSaveAndAddAnother?: (form: SupplierFormState) => void;
  onForceSave?: (form: SupplierFormState) => void;
  onForceSaveAndAddAnother?: (form: SupplierFormState) => void;
  isPending: boolean;
  isForcePending?: boolean;
  title: string;
  serverError?: { error: string; existingId?: number } | null;
  isCreate?: boolean;
  excludeId?: number;
  resetKey?: number;
}) {
  const checkEnabled = isCreate || excludeId != null;
  const [form, setFormState] = useState<SupplierFormState>(initial);
  const [errors, setErrors] = useState<Partial<Record<keyof SupplierFormState, string>>>({});
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [billingOpen, setBillingOpen] = useState(false);
  const [debouncedName, setDebouncedName] = useState("");
  const [debouncedDisplayName, setDebouncedDisplayName] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [displayNameManuallyEdited, setDisplayNameManuallyEdited] = useState(false);
  const [addAnotherChecked, setAddAnotherChecked] = useState(false);

  useEffect(() => {
    if (open) {
      setFormState(initial);
      setErrors({});
      setAdvancedOpen(false);
      setBillingOpen(false);
      setDebouncedName("");
      setDebouncedDisplayName("");
      setAcknowledged(false);
      setIsSubmitting(false);
      setDisplayNameManuallyEdited(!!initial.display_name && initial.display_name !== initial.name);
    }
  }, [open, resetKey]);

  useEffect(() => {
    if (!checkEnabled) return;
    const v = form.name.trim();
    if (!v) { setDebouncedName(""); return; }
    const timer = setTimeout(() => setDebouncedName(v), 400);
    return () => clearTimeout(timer);
  }, [form.name, checkEnabled]);

  useEffect(() => {
    if (!checkEnabled) return;
    const v = form.display_name.trim();
    if (!v) { setDebouncedDisplayName(""); return; }
    const timer = setTimeout(() => setDebouncedDisplayName(v), 400);
    return () => clearTimeout(timer);
  }, [form.display_name, checkEnabled]);

  const nameCheckParams = excludeId != null
    ? { name: debouncedName, exclude_id: excludeId }
    : { name: debouncedName };
  const displayNameCheckParams = excludeId != null
    ? { name: debouncedDisplayName, exclude_id: excludeId }
    : { name: debouncedDisplayName };

  const { data: nameCheckResult } = useCheckDuplicateSupplier(
    nameCheckParams,
    { query: { enabled: checkEnabled && debouncedName.length > 0, queryKey: getCheckDuplicateSupplierQueryKey(nameCheckParams) } },
  );

  const { data: displayNameCheckResult } = useCheckDuplicateSupplier(
    displayNameCheckParams,
    { query: { enabled: checkEnabled && debouncedDisplayName.length > 0, queryKey: getCheckDuplicateSupplierQueryKey(displayNameCheckParams) } },
  );

  const duplicateResult = mergeCheckResults(nameCheckResult, displayNameCheckResult);

  const hasDuplicate = checkEnabled && !!duplicateResult && (duplicateResult.exactMatch || duplicateResult.similarMatches.length > 0);
  const isBlocked =
    checkEnabled && !!duplicateResult && (
      duplicateResult.exactMatch ||
      (duplicateResult.similarMatches.length > 0 && !acknowledged)
    );

  function setField<K extends keyof SupplierFormState>(k: K, v: SupplierFormState[K]) {
    setFormState((f) => {
      const next: SupplierFormState = { ...f, [k]: v };
      // Auto-mirror Legal Name → Display Name until the user manually edits Display Name.
      if (k === "name" && !displayNameManuallyEdited) {
        next.display_name = v as string;
      }
      // Clear reason when status changes away from not_registered.
      if (k === "vat_status" && v !== "not_registered") {
        next.vat_not_registered_reason = "";
      }
      return next;
    });
    setErrors((e) => { const next = { ...e }; delete next[k]; return next; });
    if (k === "name") {
      setAcknowledged(false);
      setDebouncedName("");
    }
    if (k === "display_name") {
      setDisplayNameManuallyEdited(true);
      setAcknowledged(false);
      setDebouncedDisplayName("");
    }
  }

  function validate(): boolean {
    const errs: Partial<Record<keyof SupplierFormState, string>> = {};
    if (!form.name.trim()) errs.name = "Legal Name is required";
    if (!form.category) errs.category = "Category is required";
    if (form.contact_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.contact_email)) {
      errs.contact_email = "Invalid email format";
    }
    if (form.website && !/^https?:\/\/.+/.test(form.website)) {
      errs.website = "URL must start with http:// or https://";
    }
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }

  function buildPayload(): SupplierFormState {
    const out = { ...form };
    if (!out.display_name.trim()) out.display_name = out.name.trim();
    return out;
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!validate()) return;
    if (checkEnabled) {
      setIsSubmitting(true);
      try {
        const baseParams = excludeId != null ? { exclude_id: excludeId } : {};
        const [freshName, freshDisplay] = await Promise.all([
          checkDuplicateSupplier({ name: form.name.trim(), ...baseParams }),
          form.display_name.trim() && form.display_name.trim() !== form.name.trim()
            ? checkDuplicateSupplier({ name: form.display_name.trim(), ...baseParams })
            : Promise.resolve(undefined),
        ]);
        const fresh = mergeCheckResults(freshName, freshDisplay);
        const isExactMatch = fresh?.exactMatch === true;
        const hasSimilar = !isExactMatch && (fresh?.similarMatches?.length ?? 0) > 0;
        if (isExactMatch) {
          setErrors((e) => ({ ...e, name: "A supplier with this name already exists." }));
          setIsSubmitting(false);
          return;
        }
        if (hasSimilar && !acknowledged) {
          setErrors((e) => ({ ...e, name: "Please review the possible duplicate and check the acknowledgement box before saving." }));
          setIsSubmitting(false);
          return;
        }
        if (hasSimilar && acknowledged) {
          setIsSubmitting(false);
          onForceSave?.(buildPayload());
          return;
        }
      } catch {
        // continue with save if check fails
      }
      setIsSubmitting(false);
    }
    onSave(buildPayload());
  }

  async function handleSaveAndAddAnother(e: React.MouseEvent) {
    e.preventDefault();
    if (!validate()) return;
    if (checkEnabled) {
      setIsSubmitting(true);
      try {
        const baseParams = excludeId != null ? { exclude_id: excludeId } : {};
        const [freshName, freshDisplay] = await Promise.all([
          checkDuplicateSupplier({ name: form.name.trim(), ...baseParams }),
          form.display_name.trim() && form.display_name.trim() !== form.name.trim()
            ? checkDuplicateSupplier({ name: form.display_name.trim(), ...baseParams })
            : Promise.resolve(undefined),
        ]);
        const fresh = mergeCheckResults(freshName, freshDisplay);
        const isExactMatch = fresh?.exactMatch === true;
        const hasSimilar = !isExactMatch && (fresh?.similarMatches?.length ?? 0) > 0;
        if (isExactMatch) {
          setErrors((e) => ({ ...e, name: "A supplier with this name already exists." }));
          setIsSubmitting(false);
          return;
        }
        if (hasSimilar && !acknowledged) {
          setErrors((e) => ({ ...e, name: "Please review the possible duplicate and check the acknowledgement box before saving." }));
          setIsSubmitting(false);
          return;
        }
        if (hasSimilar && acknowledged) {
          setIsSubmitting(false);
          onForceSaveAndAddAnother?.(buildPayload());
          return;
        }
      } catch {
        // continue with save if check fails
      }
      setIsSubmitting(false);
    }
    onSaveAndAddAnother?.(buildPayload());
  }

  function handleForceSave(e: React.MouseEvent) {
    e.preventDefault();
    if (!validate()) return;
    onForceSave?.(buildPayload());
  }

  function handleForceSaveAndAddAnother(e: React.MouseEvent) {
    e.preventDefault();
    if (!validate()) return;
    onForceSaveAndAddAnother?.(buildPayload());
  }

  const phoneCountry: Country | undefined = form.country
    ? (SUPPLIER_COUNTRY_OPTIONS.find((c) => c.name === form.country)?.code.toUpperCase() as Country | undefined)
    : undefined;

  function toggleTag(tag: string) {
    setField("tags", form.tags.includes(tag) ? form.tags.filter((t) => t !== tag) : [...form.tags, tag]);
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-[700px] p-0 flex flex-col max-h-[90vh]">
        <DialogHeader className="px-6 pt-6 pb-4 border-b border-border shrink-0">
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <div className="overflow-y-auto flex-1 px-6 py-5 space-y-6">
          {serverError && (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 space-y-1">
              <div className="flex items-center gap-2 text-sm font-medium text-destructive">
                <AlertCircle size={15} className="shrink-0" />
                {serverError.error}
              </div>
              {serverError.existingId && (
                <p className="text-xs text-muted-foreground">
                  <a
                    href={`/suppliers/${serverError.existingId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline underline-offset-2 hover:text-foreground"
                  >
                    View existing supplier
                  </a>
                </p>
              )}
            </div>
          )}
          {hasDuplicate && duplicateResult && (
            <DuplicateWarningBlock
              result={duplicateResult}
              acknowledged={acknowledged}
              onAcknowledge={setAcknowledged}
            />
          )}

          {/* ── Section 1: Supplier Identity ── */}
          <div>
            <SectionHeading>Supplier Identity</SectionHeading>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="sup-name">
                  Legal Name <span className="text-destructive">*</span>
                </Label>
                <Input
                  id="sup-name"
                  value={form.name}
                  onChange={(e) => setField("name", e.target.value)}
                  placeholder="e.g. ABC Suppliers LLC"
                  autoFocus
                  className={errors.name ? "border-destructive" : ""}
                />
                {errors.name && <p className="text-xs text-destructive">{errors.name}</p>}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sup-display-name">Display Name</Label>
                <Input
                  id="sup-display-name"
                  value={form.display_name}
                  onChange={(e) => setField("display_name", e.target.value)}
                  placeholder={form.name || "Same as Legal Name"}
                />
                <p className="text-xs text-muted-foreground">Leave blank to use the Legal Name.</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sup-category">
                  Category <span className="text-destructive">*</span>
                </Label>
                <select
                  id="sup-category"
                  value={form.category}
                  onChange={(e) => setField("category", e.target.value)}
                  className={cn(
                    "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring",
                    errors.category ? "border-destructive" : "",
                  )}
                >
                  <option value="">— Select category —</option>
                  {SUPPLIER_CATEGORIES.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
                {errors.category && <p className="text-xs text-destructive">{errors.category}</p>}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sup-currency">Default Currency</Label>
                <select
                  id="sup-currency"
                  value={form.currency_pref}
                  onChange={(e) => setField("currency_pref", e.target.value)}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  <option value="">— Select currency —</option>
                  {CURRENCY_OPTIONS.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="sup-country">Country</Label>
                <select
                  id="sup-country"
                  value={form.country}
                  onChange={(e) => {
                    const country = e.target.value;
                    setFormState((f) => ({ ...f, country, contact_phone: "" }));
                    setErrors((err) => { const next = { ...err }; delete next.country; return next; });
                  }}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
                >
                  <option value="">— Select country (optional) —</option>
                  {SUPPLIER_COUNTRY_OPTIONS.map((c) => (
                    <option key={c.code} value={c.name}>{c.name}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* ── Section 2: Primary Contact ── */}
          <div>
            <SectionHeading>Primary Contact</SectionHeading>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="sup-contact-name">Contact Name</Label>
                <Input
                  id="sup-contact-name"
                  value={form.contact_name}
                  onChange={(e) => setField("contact_name", e.target.value)}
                  placeholder="Optional"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="sup-email">Contact Email</Label>
                <Input
                  id="sup-email"
                  type="email"
                  value={form.contact_email}
                  onChange={(e) => setField("contact_email", e.target.value)}
                  placeholder="Optional"
                  className={errors.contact_email ? "border-destructive" : ""}
                  aria-invalid={!!errors.contact_email}
                  aria-describedby={errors.contact_email ? "sup-email-err" : undefined}
                />
                {errors.contact_email && <p id="sup-email-err" className="text-xs text-destructive">{errors.contact_email}</p>}
              </div>
              <div className="space-y-1.5 sm:col-span-2">
                <Label htmlFor="sup-phone">Contact Phone</Label>
                <PhoneInputField
                  id="sup-phone"
                  international
                  countryCallingCodeEditable={false}
                  defaultCountry={phoneCountry ?? "LB"}
                  countries={SUPPLIER_ALLOWED_COUNTRIES}
                  value={form.contact_phone || undefined}
                  onChange={(val) => setField("contact_phone", val ?? "")}
                />
              </div>
            </div>
          </div>

          {/* ── Section 3: Billing & payment (collapsible accordion) ── */}
          <Collapsible open={billingOpen} onOpenChange={setBillingOpen}>
            <CollapsibleTrigger asChild>
              <button
                type="button"
                aria-expanded={billingOpen}
                aria-controls="billing-panel"
                className="flex items-center gap-3 w-full text-left group"
              >
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground shrink-0 group-hover:text-foreground transition-colors">
                  Billing &amp; payment
                </p>
                <div className="flex-1 border-t border-border" />
                {billingOpen
                  ? <ChevronUp size={14} className="text-muted-foreground shrink-0" />
                  : <ChevronDown size={14} className="text-muted-foreground shrink-0" />}
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent id="billing-panel">
              <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* VAT Registration Status — 3-state dropdown */}
                <div className="space-y-1.5 sm:col-span-2">
                  <Label htmlFor="sup-vat-status">VAT Registration Status</Label>
                  <select
                    id="sup-vat-status"
                    value={form.vat_status}
                    onChange={(e) => setField("vat_status", e.target.value as VatStatus)}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
                  >
                    <option value="unknown">Unknown</option>
                    <option value="registered">VAT Registered</option>
                    <option value="not_registered">Not VAT Registered</option>
                  </select>
                </div>

                {/* Conditional: VAT Number (only when registered) */}
                {form.vat_status === "registered" && (
                  <div className="space-y-1.5 sm:col-span-2">
                    <Label htmlFor="sup-tax-number">VAT Number / {taxNumberLabel(form.country)}</Label>
                    <Input
                      id="sup-tax-number"
                      value={form.tax_number}
                      onChange={(e) => setField("tax_number", e.target.value)}
                      placeholder="e.g. 100123456700003"
                    />
                  </div>
                )}

                {/* Conditional: Reason + callout (only when not_registered) */}
                {form.vat_status === "not_registered" && (
                  <>
                    <div className="space-y-1.5 sm:col-span-2">
                      <Label htmlFor="sup-vat-reason">Reason</Label>
                      <select
                        id="sup-vat-reason"
                        value={form.vat_not_registered_reason}
                        onChange={(e) => setField("vat_not_registered_reason", e.target.value)}
                        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
                      >
                        <option value="">— Select reason (optional) —</option>
                        <option value="below_threshold">Below registration threshold</option>
                        <option value="exempt">Exempt supplier</option>
                        <option value="foreign">Foreign supplier</option>
                        <option value="other">Other</option>
                      </select>
                    </div>
                    <div className="rounded-md border border-blue-200 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/30 px-3 py-2 text-xs text-blue-700 dark:text-blue-300 sm:col-span-2">
                      VAT will not be applied by default.
                    </div>
                  </>
                )}

                {/* Conditional: callout for unknown */}
                {form.vat_status === "unknown" && (
                  <div className="rounded-md border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30 px-3 py-2 text-xs text-amber-700 dark:text-amber-300 sm:col-span-2">
                    This supplier is pending tax-status verification.
                  </div>
                )}

                <div className="space-y-1.5">
                  <Label htmlFor="sup-payment-terms">Payment Terms</Label>
                  <select
                    id="sup-payment-terms"
                    value={form.payment_terms}
                    onChange={(e) => setField("payment_terms", e.target.value)}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
                  >
                    <option value="">— Select terms —</option>
                    {PAYMENT_TERMS_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="sup-default-tax-category">Default Tax Category</Label>
                  <select
                    id="sup-default-tax-category"
                    value={form.default_tax_category}
                    onChange={(e) => setField("default_tax_category", e.target.value)}
                    className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
                  >
                    <option value="">— None —</option>
                    <option value="standard_taxable">Standard Taxable</option>
                    <option value="zero_rated">Zero Rated</option>
                    <option value="exempt">Exempt</option>
                    <option value="non_taxable">Non-Taxable</option>
                    <option value="food_grocery">Food / Grocery</option>
                    <option value="packaging">Packaging</option>
                    <option value="service">Service</option>
                    <option value="import_related">Import Related</option>
                  </select>
                  <p className="text-xs text-muted-foreground">Pre-fills tax category on new PO lines when no base item is linked</p>
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>

          {/* ── Section 4: Advanced Details (collapsible) ── */}
          <div>
            <button
              type="button"
              onClick={() => setAdvancedOpen((v) => !v)}
              aria-expanded={advancedOpen}
              className="flex items-center gap-3 w-full text-left group"
            >
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground shrink-0 group-hover:text-foreground transition-colors">
                Advanced Details
              </p>
              <div className="flex-1 border-t border-border" />
              {advancedOpen
                ? <ChevronUp size={14} className="text-muted-foreground shrink-0" />
                : <ChevronDown size={14} className="text-muted-foreground shrink-0" />}
            </button>
            {advancedOpen && (
              <div className="mt-4 space-y-4">
                <div className="space-y-1.5">
                  <Label htmlFor="sup-billing-address">Billing Address</Label>
                  <Textarea
                    id="sup-billing-address"
                    value={form.billing_address}
                    onChange={(e) => setField("billing_address", e.target.value)}
                    placeholder="Optional"
                    rows={2}
                    className="resize-none"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="sup-website">
                    <span className="inline-flex items-center gap-1.5"><Link size={12} />Website</span>
                  </Label>
                  <Input
                    id="sup-website"
                    value={form.website}
                    onChange={(e) => setField("website", e.target.value)}
                    placeholder="https://example.com"
                    className={errors.website ? "border-destructive" : ""}
                    aria-invalid={!!errors.website}
                    aria-describedby={errors.website ? "sup-website-err" : undefined}
                  />
                  {errors.website && <p id="sup-website-err" className="text-xs text-destructive">{errors.website}</p>}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="sup-notes">Internal Notes</Label>
                  <Textarea
                    id="sup-notes"
                    value={form.notes}
                    onChange={(e) => setField("notes", e.target.value)}
                    placeholder="Optional internal notes"
                    rows={2}
                    className="resize-none"
                  />
                </div>
                <div className="space-y-2">
                  <Label>
                    <span className="inline-flex items-center gap-1.5"><Tag size={12} />Tags</span>
                  </Label>
                  {form.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {form.tags.map((tag) => (
                        <span key={tag} className="inline-flex items-center gap-1 rounded-full bg-primary/10 border border-primary/20 text-primary px-2.5 py-0.5 text-xs font-medium">
                          {tag}
                          <button
                            type="button"
                            onClick={() => setField("tags", form.tags.filter((t) => t !== tag))}
                            className="ml-0.5 hover:text-destructive transition-colors"
                          >
                            <X size={10} />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  <TagInput tags={form.tags} onChange={(tags) => setField("tags", tags)} />
                  <div className="flex flex-wrap gap-1.5">
                    {SUGGESTED_TAGS.filter((t) => !form.tags.includes(t)).map((tag) => (
                      <button
                        key={tag}
                        type="button"
                        onClick={() => toggleTag(tag)}
                        className="inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium text-muted-foreground border-border hover:border-foreground/30 hover:text-foreground transition-colors"
                      >
                        + {tag}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        <DialogFooter className="px-6 py-4 border-t border-border shrink-0 flex flex-row items-center gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={isPending || isForcePending}>
            Cancel
          </Button>
          {/* "Add another" checkbox — only shown on create flow */}
          {onSaveAndAddAnother && (
            <label className="flex items-center gap-2 ml-auto cursor-pointer select-none">
              <Checkbox
                id="add-another-checkbox"
                checked={addAnotherChecked}
                onCheckedChange={(v) => setAddAnotherChecked(!!v)}
                disabled={isPending || isForcePending}
              />
              <span className="text-sm text-muted-foreground">Add another after saving</span>
            </label>
          )}
          {isBlocked ? (
            <Button
              type="button"
              variant="destructive"
              disabled={isForcePending}
              onClick={addAnotherChecked ? handleForceSaveAndAddAnother : handleForceSave}
            >
              {isForcePending ? "Saving…" : "Save Anyway"}
            </Button>
          ) : (
            <Button
              type="button"
              disabled={isPending || isBlocked}
              onClick={addAnotherChecked ? handleSaveAndAddAnother : handleSave}
              className={onSaveAndAddAnother ? "" : "ml-auto"}
            >
              {isPending ? "Saving…" : isCreate ? "Create supplier" : "Save Supplier"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── TableSkeleton ────────────────────────────────────────────────────────────

function TableSkeleton({ colCount }: { colCount: number }) {
  return (
    <>
      {Array.from({ length: 5 }).map((_, i) => (
        <tr key={i} className="border-b border-border">
          <td className="px-3 py-3 w-8"><Skeleton className="h-4 w-4 rounded" /></td>
          <td className="px-3 py-3">
            <div className="flex items-center gap-2.5">
              <Skeleton className="h-8 w-8 rounded-full shrink-0" />
              <div className="space-y-1">
                <Skeleton className="h-3.5 w-32" />
                <Skeleton className="h-3 w-20" />
              </div>
            </div>
          </td>
          {Array.from({ length: colCount - 1 }).map((__, j) => (
            <td key={j} className="px-3 py-3"><Skeleton className="h-3.5 w-16" /></td>
          ))}
          <td className="px-3 py-3 w-8"><Skeleton className="h-6 w-6 rounded" /></td>
        </tr>
      ))}
    </>
  );
}

function formatDateTime(dateStr: string | null | undefined): string {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// ─── Supplier payload builder ─────────────────────────────────────────────────

export function buildSupplierPayload(form: SupplierFormState) {
  return {
    name: form.name.trim(),
    display_name: form.display_name.trim() || null,
    category: form.category || null,
    currency_pref: form.currency_pref || null,
    country: form.country || null,
    contact_name: form.contact_name.trim() || null,
    contact_email: form.contact_email.trim() || null,
    contact_phone: form.contact_phone.trim() || null,
    tax_number: form.vat_status === "registered" ? (form.tax_number.trim() || null) : null,
    payment_terms: form.payment_terms || null,
    vat_registered: form.vat_status === "registered",
    vat_status: form.vat_status,
    vat_not_registered_reason: form.vat_status === "not_registered" ? (form.vat_not_registered_reason || null) : null,
    default_tax_category: form.default_tax_category || null,
    billing_address: form.billing_address.trim() || null,
    website: form.website.trim() || null,
    notes: form.notes.trim() || null,
    tags: form.tags.length > 0 ? form.tags : null,
  };
}

// ─── CSV Export ───────────────────────────────────────────────────────────────

function escapeCsvField(value: string | number | null | undefined): string {
  const str = value == null ? "" : String(value);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function exportSuppliersCSV(suppliers: Supplier[]) {
  const headers = ["Name", "Display Name", "Category", "Country", "Payment Terms", "TRN / Tax ID", "Contact Name", "Contact Email", "Contact Phone", "VAT Registered", "Website", "Items", "Invoices", "YTD Spend", "Status", "Assigned Employees", "Lead Owner"];
  const rows = suppliers.map((s) => {
    const assignments = s.assignments ?? [];
    const assignedNames = assignments.map((a) => a.name ?? a.memberEmail).join("; ");
    const lead = assignments.find((a) => a.isLead);
    const leadName = lead ? (lead.name ?? lead.memberEmail) : "";
    return [
      escapeCsvField(s.name),
      escapeCsvField(s.display_name),
      escapeCsvField(s.category),
      escapeCsvField(s.country),
      escapeCsvField(s.payment_terms),
      escapeCsvField(s.tax_number),
      escapeCsvField(s.contact_name),
      escapeCsvField(s.contact_email),
      escapeCsvField(s.contact_phone),
      escapeCsvField(s.vat_registered ? "Yes" : "No"),
      escapeCsvField(s.website),
      escapeCsvField(s.item_count ?? 0),
      escapeCsvField(s.invoice_count ?? 0),
      escapeCsvField(s.spend_ytd ?? "0"),
      escapeCsvField(s.is_archived ? "Archived" : "Active"),
      escapeCsvField(assignedNames),
      escapeCsvField(leadName),
    ];
  });
  const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `suppliers-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// ─── SuppliersPage ────────────────────────────────────────────────────────────

export default function SuppliersPage() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, navigate] = useLocation();
  const { isOwner, allowedPages } = useWorkspaceRole();

  const canCreate = isOwner || (allowedPages?.includes("suppliers.create") ?? false);
  const canEdit = isOwner || (allowedPages?.includes("suppliers.edit") ?? false);
  const canArchive = isOwner || (allowedPages?.includes("suppliers.delete") ?? false);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"active" | "archived" | "all">(loadStatusFilter);
  const [countryFilter, setCountryFilter] = useState<string>(loadCountryFilter);
  const [categoryFilter, setCategoryFilter] = useState<string>(loadCategoryFilter);
  const [paymentTermsFilter, setPaymentTermsFilter] = useState<string>(loadPaymentTermsFilter);
  const [hasLinkedItems, setHasLinkedItems] = useState(loadHasLinkedItems);
  const [hasInvoices, setHasInvoices] = useState(loadHasInvoices);
  const [hasOutstanding, setHasOutstanding] = useState(loadHasOutstanding);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const [createInitial, setCreateInitial] = useState<SupplierFormState>(emptySupplierForm);
  const [editTarget, setEditTarget] = useState<Supplier | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<Supplier | null>(null);
  const [archiveWarning, setArchiveWarning] = useState<SupplierArchiveWarning | null>(null);
  const [forceArchivePending, setForceArchivePending] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeTargetId, setMergeTargetId] = useState<number | null>(null);
  const [mergeConfirmation, setMergeConfirmation] = useState("");
  const [mergeConflict, setMergeConflict] = useState<SupplierMergeConflictResponse | null>(null);
  const [mergeConflictsConfirmed, setMergeConflictsConfirmed] = useState(false);
  const [mergePending, setMergePending] = useState(false);
  const [bulkArchiveOpen, setBulkArchiveOpen] = useState(false);
  const [bulkAssignOpen, setBulkAssignOpen] = useState(false);
  const [assignedEmployeeFilter, setAssignedEmployeeFilter] = useState<string>(loadAssignedEmployee);

  // Sorting
  const [sortField, setSortField] = useState<SortField | null>(loadSortField);
  const [sortDir, setSortDir] = useState<SortDir>(loadSortDir);

  const membersQuery = useWorkspaceMembers();
  const members: WorkspaceMember[] = membersQuery.data?.members ?? [];
  const activeMembers = members.filter((m) => !m.revoked_at);

  // Column visibility (persisted)
  const [hiddenColumns, setHiddenColumns] = useState<Set<ColumnKey>>(() => loadHiddenColumns());

  // Auto-open create modal from ?create=1&name=<vendor> query params
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("create") === "1") {
      const name = params.get("name") ?? "";
      if (name) {
        setCreateInitial({ ...emptySupplierForm(), name });
      }
      setCreateOpen(true);
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  function handleSort(field: SortField) {
    setSortField((prev) => {
      if (prev !== field) {
        setSortDir("asc");
        return field;
      }
      // cycle: asc → desc → null
      if (sortDir === "asc") {
        setSortDir("desc");
        return field;
      }
      setSortDir("asc");
      return null;
    });
    setPage(1);
  }

  function toggleColumn(key: ColumnKey) {
    setHiddenColumns((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveHiddenColumns(next);
      return next;
    });
  }

  const isVisible = (key: ColumnKey) => !hiddenColumns.has(key);

  const includeArchived = statusFilter === "archived" || statusFilter === "all";

  const { data, isLoading, isError } = useListSuppliers({
    q: search || undefined,
    include_archived: includeArchived || undefined,
    has_outstanding: hasOutstanding || undefined,
    assigned_employee: assignedEmployeeFilter !== "all" ? assignedEmployeeFilter : undefined,
  });

  const allSuppliers: Supplier[] = data?.suppliers ?? [];

  const filtered = allSuppliers.filter((s) => {
    if (statusFilter === "active" && s.is_archived) return false;
    if (statusFilter === "archived" && !s.is_archived) return false;
    if (countryFilter !== "all" && s.country !== countryFilter) return false;
    if (categoryFilter !== "all" && s.category !== categoryFilter) return false;
    if (paymentTermsFilter !== "all" && s.payment_terms !== paymentTermsFilter) return false;
    if (hasLinkedItems && (s.item_count == null || s.item_count === 0)) return false;
    if (hasInvoices && (s.invoice_count == null || s.invoice_count === 0)) return false;
    return true;
  });

  const sorted = sortSuppliers(filtered, sortField, sortDir);

  const totalCount = sorted.length;
  const pageCount = Math.ceil(totalCount / PAGE_SIZE);
  const paginated = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  useEffect(() => {
    setPage(1);
    setSelectedIds(new Set());
  }, [search, statusFilter, countryFilter, categoryFilter, paymentTermsFilter, hasLinkedItems, hasInvoices, hasOutstanding, assignedEmployeeFilter]);

  // Persist filter + sort state to localStorage whenever it changes
  useEffect(() => {
    saveFilterState(sortField, sortDir, statusFilter, countryFilter, categoryFilter, paymentTermsFilter, hasLinkedItems, hasInvoices, hasOutstanding);
  }, [sortField, sortDir, statusFilter, countryFilter, categoryFilter, paymentTermsFilter, hasLinkedItems, hasInvoices, hasOutstanding]);

  useEffect(() => {
    saveAssignedEmployee(assignedEmployeeFilter);
  }, [assignedEmployeeFilter]);

  const isNonDefaultFilters =
    statusFilter !== DEFAULT_STATUS_FILTER ||
    countryFilter !== DEFAULT_COUNTRY_FILTER ||
    categoryFilter !== DEFAULT_CATEGORY_FILTER ||
    paymentTermsFilter !== DEFAULT_PAYMENT_TERMS_FILTER ||
    hasLinkedItems !== false ||
    hasInvoices !== false ||
    hasOutstanding !== false ||
    assignedEmployeeFilter !== "all" ||
    sortField !== DEFAULT_SORT_FIELD;

  function resetFilters() {
    setSearch("");
    setStatusFilter(DEFAULT_STATUS_FILTER);
    setCountryFilter(DEFAULT_COUNTRY_FILTER);
    setCategoryFilter(DEFAULT_CATEGORY_FILTER);
    setPaymentTermsFilter(DEFAULT_PAYMENT_TERMS_FILTER);
    setHasLinkedItems(false);
    setHasInvoices(false);
    setHasOutstanding(false);
    setAssignedEmployeeFilter("all");
    setSortField(DEFAULT_SORT_FIELD);
    setSortDir(DEFAULT_SORT_DIR);
    setPage(1);
    clearFilterState();
  }

  const distinctCountries = Array.from(new Set(allSuppliers.map((s) => s.country).filter(Boolean) as string[])).sort();

  const [addAnotherPending, setAddAnotherPending] = useState(false);
  const [createFormKey, setCreateFormKey] = useState(0);
  const [createServerError, setCreateServerError] = useState<{ error: string; existingId?: number } | null>(null);
  const [forceCreatePending, setForceCreatePending] = useState(false);
  const [editServerError, setEditServerError] = useState<{ error: string; existingId?: number } | null>(null);
  const [forceEditPending, setForceEditPending] = useState(false);
  const [pendingForceForm, setPendingForceForm] = useState<SupplierFormState | null>(null);
  const [pendingForceAddAnother, setPendingForceAddAnother] = useState(false);
  const [serverSimilarWarning, setServerSimilarWarning] = useState<SupplierMatch[] | null>(null);
  const [editServerSimilarWarning, setEditServerSimilarWarning] = useState<SupplierMatch[] | null>(null);
  const [pendingEditForceForm, setPendingEditForceForm] = useState<SupplierFormState | null>(null);

  const createMutation = useCreateSupplier({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListSuppliersQueryKey() });
        setCreateServerError(null);
        if (addAnotherPending) {
          toast({ title: "Supplier created", description: "Form cleared — add another" });
          setAddAnotherPending(false);
          setCreateFormKey((k) => k + 1);
        } else {
          toast({ title: "Supplier created" });
          setCreateOpen(false);
        }
      },
      onError: (err: unknown) => {
        setAddAnotherPending(false);
        const apiErr = err as { status?: number; data?: { error?: string; existingId?: number; warning?: boolean; similarMatches?: SupplierMatch[] } };
        if (apiErr?.status === 409) {
          setCreateServerError({
            error: apiErr?.data?.error ?? "A supplier with this name already exists.",
            existingId: apiErr?.data?.existingId,
          });
          return;
        }
        if (apiErr?.status === 422 && apiErr?.data?.warning) {
          setServerSimilarWarning(apiErr.data.similarMatches ?? []);
          return;
        }
        toast({ title: "Failed to create supplier", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
      },
    },
  });

  async function handleForceCreate(form: SupplierFormState, addAnother: boolean) {
    setForceCreatePending(true);
    setCreateServerError(null);
    try {
      const res = await fetch("/api/suppliers?force=true", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildSupplierPayload(form)),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      await qc.invalidateQueries({ queryKey: getListSuppliersQueryKey() });
      if (addAnother) {
        toast({ title: "Supplier created", description: "Form cleared — add another" });
        setCreateFormKey((k) => k + 1);
      } else {
        toast({ title: "Supplier created" });
        setCreateOpen(false);
      }
    } catch (err) {
      toast({ title: "Failed to create supplier", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    } finally {
      setForceCreatePending(false);
    }
  }

  const patchMutation = usePatchSupplier({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListSuppliersQueryKey() });
        setEditServerError(null);
        toast({ title: "Supplier updated" });
        setEditTarget(null);
      },
      onError: (err: unknown) => {
        const apiErr = err as { status?: number; data?: { error?: string; existingId?: number; warning?: boolean; similarMatches?: SupplierMatch[] } };
        if (apiErr?.status === 409) {
          setEditServerError({
            error: apiErr?.data?.error ?? "A supplier with this name already exists.",
            existingId: apiErr?.data?.existingId,
          });
          return;
        }
        if (apiErr?.status === 422 && apiErr?.data?.warning) {
          setEditServerSimilarWarning(apiErr.data.similarMatches ?? []);
          return;
        }
        toast({ title: "Failed to update supplier", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
      },
    },
  });

  async function handleForceEdit(form: SupplierFormState) {
    if (!editTarget) return;
    setForceEditPending(true);
    setEditServerError(null);
    try {
      const res = await fetch(`/api/suppliers/${editTarget.id}?force=true`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildSupplierPayload(form)),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      await qc.invalidateQueries({ queryKey: getListSuppliersQueryKey() });
      toast({ title: "Supplier updated" });
      setEditTarget(null);
    } catch (err) {
      toast({ title: "Failed to update supplier", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    } finally {
      setForceEditPending(false);
    }
  }

  const archiveMutation = useDeleteSupplier({
    mutation: {
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: getListSuppliersQueryKey() });
        toast({ title: "Supplier archived" });
        setArchiveTarget(null);
        setBulkArchiveOpen(false);
        setSelectedIds(new Set());
      },
      onError: (err: unknown) => {
        const apiErr = err as { status?: number; data?: { requires_confirmation?: boolean; open_po_count?: number; open_invoice_count?: number } };
        if (apiErr?.status === 409 && apiErr?.data?.requires_confirmation && archiveTarget) {
          setArchiveTarget(null);
          setArchiveWarning({
            supplier: archiveTarget,
            open_po_count: apiErr.data.open_po_count ?? 0,
            open_invoice_count: apiErr.data.open_invoice_count ?? 0,
          });
          return;
        }
        toast({ title: "Failed to archive supplier", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
      },
    },
  });

  async function handleForceArchive(supplier: Supplier) {
    setForceArchivePending(true);
    try {
      const res = await fetch(`/api/suppliers/${supplier.id}?force=true`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      await qc.invalidateQueries({ queryKey: getListSuppliersQueryKey() });
      toast({ title: "Supplier archived" });
      setArchiveWarning(null);
      setSelectedIds(new Set());
    } catch (err) {
      toast({ title: "Failed to archive supplier", description: err instanceof Error ? err.message : undefined, variant: "destructive" });
    } finally {
      setForceArchivePending(false);
    }
  }

  const selectedSuppliers = allSuppliers.filter((supplier) => selectedIds.has(supplier.id));
  const canMergeSelected =
    canEdit &&
    canArchive &&
    selectedSuppliers.length >= 2 &&
    selectedSuppliers.every((supplier) => !supplier.is_archived);

  function openMergeDialog() {
    const suggestedTarget = [...selectedSuppliers].sort(
      (a, b) => (b.invoice_count ?? 0) - (a.invoice_count ?? 0),
    )[0];
    setMergeTargetId(suggestedTarget?.id ?? null);
    setMergeConfirmation("");
    setMergeConflict(null);
    setMergeConflictsConfirmed(false);
    setMergeOpen(true);
  }

  async function handleMerge() {
    if (mergeTargetId == null) return;
    const sourceSupplierIds = selectedSuppliers
      .map((supplier) => supplier.id)
      .filter((id) => id !== mergeTargetId);
    if (sourceSupplierIds.length === 0) return;

    setMergePending(true);
    try {
      await apiFetch("/api/suppliers/merge", {
        method: "POST",
        body: JSON.stringify({
          target_supplier_id: mergeTargetId,
          source_supplier_ids: sourceSupplierIds,
          confirmation_text: mergeConfirmation,
          confirm_conflicts: mergeConflictsConfirmed,
        }),
      });
      await qc.invalidateQueries({ queryKey: getListSuppliersQueryKey() });
      toast({
        title: "Suppliers merged",
        description: `${sourceSupplierIds.length} duplicate supplier${sourceSupplierIds.length === 1 ? "" : "s"} archived and linked records moved.`,
      });
      setMergeOpen(false);
      setSelectedIds(new Set());
      setMergeConflict(null);
      setMergeConflictsConfirmed(false);
    } catch (err) {
      const apiErr = err as { status?: number; body?: SupplierMergeConflictResponse };
      if (apiErr.status === 409 && apiErr.body?.requires_confirmation) {
        setMergeConflict(apiErr.body);
        return;
      }
      toast({
        title: "Failed to merge suppliers",
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    } finally {
      setMergePending(false);
    }
  }

  function toggleRow(id: number, e: React.MouseEvent) {
    e.stopPropagation();
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll(checked: boolean) {
    if (checked) {
      setSelectedIds(new Set(paginated.map((s) => s.id)));
    } else {
      setSelectedIds(new Set());
    }
  }

  const allPageSelected = paginated.length > 0 && paginated.every((s) => selectedIds.has(s.id));
  const somePageSelected = paginated.some((s) => selectedIds.has(s.id));

  const startIdx = totalCount === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const endIdx = Math.min(page * PAGE_SIZE, totalCount);

  // Count of visible data columns (Supplier column + optional columns)
  const visibleColCount = 1 + COLUMN_DEFS.filter((c) => isVisible(c.key)).length;

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight">Suppliers</h1>
            {!isLoading && (
              <span className="inline-flex items-center rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
                {allSuppliers.filter((s) => !s.is_archived).length}
              </span>
            )}
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Manage workspace suppliers, track linked items, and monitor procurement activity.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button variant="outline" size="sm" disabled>
            <Upload size={14} className="mr-1.5" />
            Import
          </Button>
          {canCreate && (
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus size={14} className="mr-1.5" />
              Add Supplier
            </Button>
          )}
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-48">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <Input
            className="pl-8 h-9 text-sm"
            placeholder="Search suppliers, TRN, country…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <Select value={countryFilter} onValueChange={setCountryFilter}>
          <SelectTrigger className="h-9 w-40 text-sm">
            <SelectValue placeholder="All countries" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All countries</SelectItem>
            {distinctCountries.map((c) => {
              const meta = getCountryMetadata(c);
              return (
                <SelectItem key={c} value={c}>
                  {meta ? `${meta.flagEmoji} ${c}` : c}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
        <Select value={categoryFilter} onValueChange={setCategoryFilter}>
          <SelectTrigger className="h-9 w-44 text-sm">
            <SelectValue placeholder="All categories" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All categories</SelectItem>
            {SUPPLIER_CATEGORIES.map((c) => (
              <SelectItem key={c} value={c}>{c}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={paymentTermsFilter} onValueChange={setPaymentTermsFilter}>
          <SelectTrigger className="h-9 w-40 text-sm">
            <SelectValue placeholder="All terms" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All terms</SelectItem>
            {PAYMENT_TERMS_OPTIONS.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <button
          type="button"
          onClick={() => setHasLinkedItems((v) => !v)}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
            hasLinkedItems
              ? "bg-primary text-primary-foreground border-primary"
              : "bg-background text-muted-foreground border-border hover:border-foreground/30 hover:text-foreground",
          )}
        >
          <Package size={12} />
          Has linked items
        </button>
        <button
          type="button"
          onClick={() => setHasInvoices((v) => !v)}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
            hasInvoices
              ? "bg-primary text-primary-foreground border-primary"
              : "bg-background text-muted-foreground border-border hover:border-foreground/30 hover:text-foreground",
          )}
        >
          <Store size={12} />
          Has invoices
        </button>
        <button
          type="button"
          onClick={() => setHasOutstanding((v) => !v)}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
            hasOutstanding
              ? "bg-destructive text-destructive-foreground border-destructive"
              : "bg-background text-muted-foreground border-border hover:border-foreground/30 hover:text-foreground",
          )}
        >
          <AlertCircle size={12} />
          Has outstanding
        </button>
        <div className="inline-flex rounded-md border border-border overflow-hidden shrink-0">
          {(["active", "archived", "all"] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setStatusFilter(v)}
              className={cn(
                "px-3 py-1.5 text-xs font-medium transition-colors",
                statusFilter === v
                  ? "bg-primary text-primary-foreground"
                  : "bg-background text-muted-foreground hover:text-foreground hover:bg-muted/50",
                v !== "active" && "border-l border-border",
              )}
            >
              {v === "active" ? "Active" : v === "archived" ? "Archived" : "All"}
            </button>
          ))}
        </div>
        <Select value={assignedEmployeeFilter} onValueChange={setAssignedEmployeeFilter}>
          <SelectTrigger className="h-9 w-40 text-sm">
            <SelectValue placeholder="Assigned to" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All employees</SelectItem>
            <SelectItem value="me">Assigned to me</SelectItem>
            <SelectItem value="none">Unassigned</SelectItem>
            {members.map((m) => (
              <SelectItem key={m.id} value={String(m.id)}>
                {memberDisplayName(m)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <ColumnsMenu hiddenColumns={hiddenColumns} onToggle={toggleColumn} />
        {isOwner && (
          <Button
            variant="outline"
            size="sm"
            className="h-9 gap-1.5 text-sm"
            onClick={() => exportSuppliersCSV(sorted)}
            disabled={sorted.length === 0}
          >
            <Download size={14} />
            Export CSV
          </Button>
        )}
        {isNonDefaultFilters && (
          <Button
            variant="ghost"
            size="sm"
            className="h-9 gap-1.5 text-sm text-muted-foreground hover:text-foreground"
            onClick={resetFilters}
          >
            <X size={13} />
            Reset filters
          </Button>
        )}
      </div>

      {/* Bulk action bar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/50 px-4 py-2.5">
          <span className="text-sm font-medium">{selectedIds.size} selected</span>
          <div className="flex-1" />
          {canEdit && (
            <Button size="sm" variant="outline" onClick={() => setBulkAssignOpen(true)}>
              <UserCheck size={13} className="mr-1.5" />
              Assign
            </Button>
          )}
          {canArchive && statusFilter !== "archived" && (
            <Button size="sm" variant="outline" onClick={() => setBulkArchiveOpen(true)}>
              <Archive size={13} className="mr-1.5" />
              Archive selected
            </Button>
          )}
          {canMergeSelected && (
            <Button size="sm" variant="outline" onClick={openMergeDialog}>
              <GitMerge size={13} className="mr-1.5" />
              Merge suppliers
            </Button>
          )}
          {canEdit && statusFilter === "archived" && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                const ids = Array.from(selectedIds);
                Promise.all(ids.map((id) => patchMutation.mutateAsync({ id, data: { is_archived: false } }))).then(() => {
                  setSelectedIds(new Set());
                  toast({ title: `${ids.length} supplier${ids.length !== 1 ? "s" : ""} restored` });
                });
              }}
            >
              <RotateCcw size={13} className="mr-1.5" />
              Restore selected
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set())}>
            Clear selection
          </Button>
        </div>
      )}

      {/* Table */}
      <div className="rounded-lg border border-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="px-3 py-2.5 w-8">
                  <Checkbox
                    checked={allPageSelected}
                    data-state={somePageSelected && !allPageSelected ? "indeterminate" : undefined}
                    onCheckedChange={toggleAll}
                    aria-label="Select all"
                  />
                </th>
                {/* Supplier — always visible, always sortable */}
                <th className="text-left px-3 py-2.5 whitespace-nowrap">
                  <SortableHeader
                    field="supplier"
                    label="Supplier"
                    sortField={sortField}
                    sortDir={sortDir}
                    onSort={handleSort}
                  />
                </th>
                {isVisible("country") && (
                  <th className="text-left px-3 py-2.5 whitespace-nowrap">
                    <SortableHeader
                      field="country"
                      label="Country"
                      sortField={sortField}
                      sortDir={sortDir}
                      onSort={handleSort}
                    />
                  </th>
                )}
                {isVisible("category") && (
                  <th className="text-left px-3 py-2.5 whitespace-nowrap">
                    <SortableHeader
                      field="category"
                      label="Category"
                      sortField={sortField}
                      sortDir={sortDir}
                      onSort={handleSort}
                    />
                  </th>
                )}
                {isVisible("tax_number") && (
                  <th className="text-left px-3 py-2.5 whitespace-nowrap">
                    <SortableHeader
                      field="tax_number"
                      label="TRN / Tax ID"
                      sortField={sortField}
                      sortDir={sortDir}
                      onSort={handleSort}
                    />
                  </th>
                )}
                {isVisible("assigned_to") && (
                  <th className="text-left px-3 py-2.5 whitespace-nowrap">
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
                      <Users size={12} />
                      Assigned To
                    </span>
                  </th>
                )}
                {isVisible("items") && (
                  <th className="text-right px-3 py-2.5 whitespace-nowrap">
                    <SortableHeader
                      field="items"
                      label="Items"
                      sortField={sortField}
                      sortDir={sortDir}
                      onSort={handleSort}
                      className="justify-end w-full"
                    />
                  </th>
                )}
                {isVisible("invoices") && (
                  <th className="text-right px-3 py-2.5 whitespace-nowrap">
                    <SortableHeader
                      field="invoices"
                      label="Invoices"
                      sortField={sortField}
                      sortDir={sortDir}
                      onSort={handleSort}
                      className="justify-end w-full"
                    />
                  </th>
                )}
                {isVisible("status") && (
                  <th className="text-left px-3 py-2.5 whitespace-nowrap">
                    <SortableHeader
                      field="status"
                      label="Status"
                      sortField={sortField}
                      sortDir={sortDir}
                      onSort={handleSort}
                    />
                  </th>
                )}
                {isVisible("last_activity") && (
                  <th className="text-left px-3 py-2.5 whitespace-nowrap">
                    <SortableHeader
                      field="last_activity"
                      label="Last Activity"
                      sortField={sortField}
                      sortDir={sortDir}
                      onSort={handleSort}
                    />
                  </th>
                )}
                <th className="px-3 py-2.5 w-8" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {isLoading ? (
                <TableSkeleton colCount={visibleColCount} />
              ) : isError ? (
                <tr>
                  <td colSpan={visibleColCount + 2} className="px-3 py-10 text-center text-sm text-destructive">
                    Failed to load suppliers. Please try refreshing.
                  </td>
                </tr>
              ) : paginated.length === 0 ? (
                <tr>
                  <td colSpan={visibleColCount + 2} className="px-3 py-14 text-center">
                    <div className="flex flex-col items-center gap-3">
                      <Store size={28} className="text-muted-foreground" />
                      {search || countryFilter !== "all" || categoryFilter !== "all" || paymentTermsFilter !== "all" || hasLinkedItems || hasInvoices || hasOutstanding ? (
                        <>
                          <p className="font-medium text-sm">No suppliers match your filters</p>
                          <p className="text-xs text-muted-foreground">Try adjusting your search or filter criteria.</p>
                          <Button size="sm" variant="outline" onClick={resetFilters}>
                            Clear filters
                          </Button>
                        </>
                      ) : statusFilter === "archived" ? (
                        <>
                          <p className="font-medium text-sm">No archived suppliers</p>
                          <p className="text-xs text-muted-foreground">Suppliers you archive will appear here.</p>
                        </>
                      ) : (
                        <>
                          <p className="font-medium text-sm">No suppliers yet</p>
                          <p className="text-xs text-muted-foreground">Add your first supplier to get started.</p>
                          {canCreate && (
                            <Button size="sm" onClick={() => setCreateOpen(true)}>
                              <Plus size={13} className="mr-1.5" />
                              Add Supplier
                            </Button>
                          )}
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ) : (
                paginated.map((s) => {
                  const displayName = s.display_name || s.name;
                  const showLegalName = s.display_name && s.display_name !== s.name;
                  const initials = supplierInitials(displayName);
                  const countryMeta = s.country ? getCountryMetadata(s.country) : null;
                  const taxLabel = s.tax_number ? taxNumberLabel(s.country ?? "") : null;
                  const isSelected = selectedIds.has(s.id);

                  return (
                    <tr
                      key={s.id}
                      className={cn(
                        "cursor-pointer hover:bg-muted/40 transition-colors",
                        isSelected && "bg-primary/5",
                        s.is_archived && "opacity-70",
                      )}
                      onClick={() => navigate(`/suppliers/${s.id}`)}
                    >
                      <td className="px-3 py-3 w-8" onClick={(e) => toggleRow(s.id, e)}>
                        <Checkbox checked={isSelected} aria-label={`Select ${displayName}`} />
                      </td>
                      <td className="px-3 py-3">
                        <div className="flex items-center gap-2.5">
                          <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center text-primary text-xs font-semibold shrink-0">
                            {initials}
                          </div>
                          <div className="min-w-0">
                            <p className="font-medium truncate">{displayName}</p>
                            {showLegalName && (
                              <p className="text-xs text-muted-foreground truncate">{s.name}</p>
                            )}
                          </div>
                        </div>
                      </td>
                      {isVisible("country") && (
                        <td className="px-3 py-3 whitespace-nowrap">
                          {countryMeta ? (
                            <span>{countryMeta.flagEmoji} {countryMeta.name}</span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                      )}
                      {isVisible("category") && (
                        <td className="px-3 py-3 whitespace-nowrap text-sm">
                          {s.category ? (
                            <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium">
                              {s.category}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                      )}
                      {isVisible("tax_number") && (
                        <td className="px-3 py-3 font-mono text-xs">
                          {s.tax_number ? (
                            <span title={taxLabel ?? undefined}>{s.tax_number}</span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                      )}
                      {isVisible("assigned_to") && (
                        <td className="px-3 py-3" onClick={(e) => e.stopPropagation()}>
                          <AssignmentPopover
                            supplier={s}
                            members={activeMembers}
                            canEdit={canEdit}
                            onSaved={() => qc.invalidateQueries({ queryKey: getListSuppliersQueryKey() })}
                          />
                        </td>
                      )}
                      {isVisible("items") && (
                        <td className="px-3 py-3 text-right">
                          <span className={cn("font-medium", (s.item_count ?? 0) === 0 && "text-muted-foreground")}>
                            {s.item_count ?? 0}
                          </span>
                        </td>
                      )}
                      {isVisible("invoices") && (
                        <td className="px-3 py-3 text-right whitespace-nowrap">
                          {(s.invoice_count ?? 0) === 0 ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            <div className="inline-flex flex-col items-end gap-0.5">
                              <span className="font-medium">{s.invoice_count}</span>
                              {s.spend_ytd && Number(s.spend_ytd) > 0 && (
                                <span className="text-xs text-muted-foreground">
                                  {s.spend_ytd_currency ? `${s.spend_ytd_currency} ` : ""}
                                  {Number(s.spend_ytd).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} YTD
                                </span>
                              )}
                              {((s.paid_count ?? 0) > 0 || (s.outstanding_count ?? 0) > 0) && (
                                <span className="text-xs text-muted-foreground">
                                  {s.paid_count ?? 0} paid / {s.outstanding_count ?? 0} outstanding
                                </span>
                              )}
                            </div>
                          )}
                        </td>
                      )}
                      {isVisible("status") && (
                        <td className="px-3 py-3">
                          {s.is_archived ? (
                            <Badge variant="secondary" className="text-xs">Archived</Badge>
                          ) : (
                            <Badge className="bg-green-600 hover:bg-green-700 text-xs">Active</Badge>
                          )}
                        </td>
                      )}
                      {isVisible("last_activity") && (
                        <td className="px-3 py-3 text-muted-foreground whitespace-nowrap text-xs">
                          {formatDateTime(s.updated_at ?? s.created_at)}
                        </td>
                      )}
                      <td className="px-3 py-3 w-8" onClick={(e) => e.stopPropagation()}>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-muted-foreground">
                              <MoreHorizontal size={15} />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-40">
                            <DropdownMenuItem onClick={() => navigate(`/suppliers/${s.id}`)} className="gap-2">
                              <Eye size={13} />
                              View
                            </DropdownMenuItem>
                            {canEdit && (
                              <DropdownMenuItem onClick={() => setEditTarget(s)} className="gap-2">
                                <Pencil size={13} />
                                Edit
                              </DropdownMenuItem>
                            )}
                            <DropdownMenuSeparator />
                            {!s.is_archived && canArchive && (
                              <DropdownMenuItem
                                onClick={() => setArchiveTarget(s)}
                                className="gap-2 text-muted-foreground"
                              >
                                <Archive size={13} />
                                Archive
                              </DropdownMenuItem>
                            )}
                            {s.is_archived && canEdit && (
                              <DropdownMenuItem
                                onClick={() => patchMutation.mutate({ id: s.id, data: { is_archived: false } })}
                                className="gap-2"
                              >
                                <RotateCcw size={13} />
                                Restore
                              </DropdownMenuItem>
                            )}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination footer */}
        {!isLoading && totalCount > 0 && (
          <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-2.5 bg-muted/20">
            <p className="text-xs text-muted-foreground">
              Showing {startIdx} to {endIdx} of {totalCount} supplier{totalCount !== 1 ? "s" : ""}
            </p>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </Button>
              <span className="text-xs text-muted-foreground px-1">
                {page} / {Math.max(pageCount, 1)}
              </span>
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs"
                disabled={page >= pageCount}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Create modal */}
      {canCreate && (
        <SupplierFormModal
          open={createOpen}
          onClose={() => { setCreateOpen(false); setCreateServerError(null); }}
          initial={createInitial}
          onSave={(form) => {
            setAddAnotherPending(false);
            setCreateServerError(null);
            setPendingForceForm(form);
            setPendingForceAddAnother(false);
            createMutation.mutate({ data: buildSupplierPayload(form) });
          }}
          onSaveAndAddAnother={(form) => {
            setAddAnotherPending(true);
            setCreateServerError(null);
            setPendingForceForm(form);
            setPendingForceAddAnother(true);
            createMutation.mutate({ data: buildSupplierPayload(form) });
          }}
          onForceSave={(form) => { setPendingForceForm(form); setPendingForceAddAnother(false); handleForceCreate(form, false); }}
          onForceSaveAndAddAnother={(form) => { setPendingForceForm(form); setPendingForceAddAnother(true); handleForceCreate(form, true); }}
          isPending={createMutation.isPending}
          isForcePending={forceCreatePending}
          title="Add Supplier"
          serverError={createServerError}
          isCreate
          resetKey={createFormKey}
        />
      )}

      {/* Edit modal */}
      {canEdit && editTarget && (
        <SupplierFormModal
          open={editTarget !== null}
          onClose={() => { setEditTarget(null); setEditServerError(null); setEditServerSimilarWarning(null); }}
          initial={supplierToForm(editTarget)}
          onSave={(form) => {
            setEditServerError(null);
            setPendingEditForceForm(form);
            patchMutation.mutate({ id: editTarget.id, data: buildSupplierPayload(form) });
          }}
          onSaveAndAddAnother={(form) => {
            setEditServerError(null);
            setPendingEditForceForm(form);
            patchMutation.mutate({ id: editTarget.id, data: buildSupplierPayload(form) });
          }}
          onForceSave={(form) => handleForceEdit(form)}
          onForceSaveAndAddAnother={(form) => handleForceEdit(form)}
          isPending={patchMutation.isPending}
          isForcePending={forceEditPending}
          title="Edit Supplier"
          serverError={editServerError}
          excludeId={editTarget.id}
        />
      )}

      {/* Server-side similar match confirmation dialog */}
      <AlertDialog open={serverSimilarWarning !== null} onOpenChange={(v) => { if (!v) setServerSimilarWarning(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertCircle size={18} className="text-amber-500 shrink-0" />
              Similar suppliers already exist
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>The following suppliers have similar names. Do you still want to create a new one?</p>
                <div className="space-y-2">
                  {(serverSimilarWarning ?? []).slice(0, 3).map((m) => (
                    <SupplierMatchCard key={m.id} match={m} />
                  ))}
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={forceCreatePending} onClick={() => setServerSimilarWarning(null)}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={forceCreatePending}
              onClick={() => {
                setServerSimilarWarning(null);
                if (pendingForceForm) {
                  handleForceCreate(pendingForceForm, pendingForceAddAnother);
                }
              }}
            >
              {forceCreatePending ? "Creating…" : "Create anyway"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Server-side similar match confirmation dialog (edit) */}
      <AlertDialog open={editServerSimilarWarning !== null} onOpenChange={(v) => { if (!v) setEditServerSimilarWarning(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertCircle size={18} className="text-amber-500 shrink-0" />
              Similar suppliers already exist
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>The following suppliers have similar names. Do you still want to save this rename?</p>
                <div className="space-y-2">
                  {(editServerSimilarWarning ?? []).slice(0, 3).map((m) => (
                    <SupplierMatchCard key={m.id} match={m} />
                  ))}
                </div>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={forceEditPending} onClick={() => setEditServerSimilarWarning(null)}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={forceEditPending}
              onClick={() => {
                setEditServerSimilarWarning(null);
                if (pendingEditForceForm) {
                  handleForceEdit(pendingEditForceForm);
                }
              }}
            >
              {forceEditPending ? "Saving…" : "Save anyway"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Archive single */}
      <AlertDialog open={archiveTarget !== null} onOpenChange={(v) => { if (!v) setArchiveTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive supplier?</AlertDialogTitle>
            <AlertDialogDescription>
              "{archiveTarget?.display_name || archiveTarget?.name}" will be archived and hidden from the supplier dropdown on base items. You can restore it later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={archiveMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={archiveMutation.isPending}
              onClick={() => { if (archiveTarget) archiveMutation.mutate({ id: archiveTarget.id }); }}
            >
              {archiveMutation.isPending ? "Archiving…" : "Archive"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Archive warning — open POs / invoices */}
      <AlertDialog open={archiveWarning !== null} onOpenChange={(v) => { if (!v) setArchiveWarning(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertCircle size={18} className="text-amber-500 shrink-0" />
              Supplier has open records
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>
                  <strong>"{archiveWarning?.supplier.display_name || archiveWarning?.supplier.name}"</strong> has open records that will remain in the system after archiving:
                </p>
                <ul className="list-disc list-inside space-y-1 text-sm">
                  {(archiveWarning?.open_po_count ?? 0) > 0 && (
                    <li>
                      <strong>{archiveWarning!.open_po_count}</strong> open purchase order{archiveWarning!.open_po_count !== 1 ? "s" : ""}
                    </li>
                  )}
                  {(archiveWarning?.open_invoice_count ?? 0) > 0 && (
                    <li>
                      <strong>{archiveWarning!.open_invoice_count}</strong> outstanding invoice{archiveWarning!.open_invoice_count !== 1 ? "s" : ""}
                    </li>
                  )}
                </ul>
                <p className="text-xs text-muted-foreground">
                  These records will not be deleted, but you should resolve them before archiving. You can restore the supplier later.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={forceArchivePending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={forceArchivePending}
              onClick={() => { if (archiveWarning) handleForceArchive(archiveWarning.supplier); }}
            >
              {forceArchivePending ? "Archiving…" : "Archive anyway"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Supplier merge */}
      <Dialog
        open={mergeOpen}
        onOpenChange={(open) => {
          if (!open && !mergePending) {
            setMergeOpen(false);
            setMergeConflict(null);
            setMergeConflictsConfirmed(false);
          }
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <GitMerge size={18} />
              Merge duplicate suppliers
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 text-sm">
            <p className="text-muted-foreground">
              All invoices and other supplier-linked records will be moved to the retained supplier.
              The other suppliers will be archived, not deleted.
            </p>
            <div className="space-y-2">
              <Label htmlFor="merge-retained-supplier">Retained supplier</Label>
              <Select
                value={mergeTargetId == null ? "" : String(mergeTargetId)}
                onValueChange={(value) => {
                  setMergeTargetId(Number(value));
                  setMergeConflict(null);
                  setMergeConflictsConfirmed(false);
                }}
              >
                <SelectTrigger id="merge-retained-supplier">
                  <SelectValue placeholder="Choose the supplier to keep" />
                </SelectTrigger>
                <SelectContent>
                  {selectedSuppliers.map((supplier) => (
                    <SelectItem key={supplier.id} value={String(supplier.id)}>
                      {(supplier.display_name || supplier.name)} · {supplier.invoice_count ?? 0} invoices
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="rounded-md border border-border bg-muted/30 p-3">
              <p className="font-medium mb-2">Will be archived</p>
              <ul className="space-y-1 text-muted-foreground">
                {selectedSuppliers
                  .filter((supplier) => supplier.id !== mergeTargetId)
                  .map((supplier) => (
                    <li key={supplier.id} className="flex justify-between gap-3">
                      <span>{supplier.display_name || supplier.name}</span>
                      <span className="shrink-0">{supplier.invoice_count ?? 0} invoices</span>
                    </li>
                  ))}
              </ul>
            </div>
            {mergeConflict && (
              <div className="space-y-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3">
                <p className="font-medium text-amber-900 dark:text-amber-200">
                  Review conflicts before continuing
                </p>
                {(mergeConflict.blocking_conflicts?.length ?? 0) > 0 && (
                  <p className="text-xs font-medium text-destructive">
                    This merge cannot continue until the blocking record conflicts are resolved.
                  </p>
                )}
                <ul className="list-disc list-inside space-y-1 text-xs text-muted-foreground">
                  {(mergeConflict.conflicts ?? []).slice(0, 8).map((conflict, index) => (
                    <li key={`${conflict.type}-${conflict.source_supplier_id ?? "target"}-${index}`}>
                      {conflict.detail}
                      {conflict.source_value != null ? ` (${String(conflict.source_value)})` : ""}
                    </li>
                  ))}
                </ul>
                <label className="flex items-start gap-2 text-xs">
                  <Checkbox
                    checked={mergeConflictsConfirmed}
                    onCheckedChange={(checked) => setMergeConflictsConfirmed(checked === true)}
                  />
                  <span>
                    I understand that the retained supplier keeps its identity and Odoo partner mapping;
                    conflicting duplicate mappings will no longer be active after archiving.
                  </span>
                </label>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="merge-confirmation">
                Type <span className="font-mono">MERGE</span> to confirm
              </Label>
              <Input
                id="merge-confirmation"
                value={mergeConfirmation}
                onChange={(event) => setMergeConfirmation(event.target.value)}
                placeholder="MERGE"
                autoComplete="off"
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={mergePending}
              onClick={() => setMergeOpen(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={
                mergePending ||
                mergeConfirmation !== "MERGE" ||
                (mergeConflict !== null &&
                  (!mergeConflictsConfirmed ||
                    (mergeConflict.blocking_conflicts?.length ?? 0) > 0))
              }
              onClick={handleMerge}
            >
              {mergePending ? "Merging…" : "Merge and archive duplicates"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk assign */}
      <BulkAssignDialog
        open={bulkAssignOpen}
        onClose={() => setBulkAssignOpen(false)}
        supplierIds={Array.from(selectedIds)}
        members={activeMembers}
        onSaved={() => {
          setSelectedIds(new Set());
          qc.invalidateQueries({ queryKey: getListSuppliersQueryKey() });
        }}
      />

      {/* Bulk archive */}
      <AlertDialog open={bulkArchiveOpen} onOpenChange={(v) => { if (!v) setBulkArchiveOpen(false); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive {selectedIds.size} supplier{selectedIds.size !== 1 ? "s" : ""}?</AlertDialogTitle>
            <AlertDialogDescription>
              The selected suppliers will be archived and hidden from base item supplier dropdowns. You can restore them later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async () => {
                const ids = Array.from(selectedIds);
                for (const id of ids) {
                  await archiveMutation.mutateAsync({ id });
                }
              }}
            >
              Archive {selectedIds.size} supplier{selectedIds.size !== 1 ? "s" : ""}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
