import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useRoute } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Check, ChevronLeft, ChevronRight, ChevronsUpDown, Download, ExternalLink, Loader2, Minus, Plus, RotateCw, Save, Trash2, Upload, X, MoreVertical, History, AlertCircle, ChevronDown, Maximize, Minimize, ChevronUp, Search } from "lucide-react";
import { apiFetch, getClerkToken } from "@/lib/queryClient";
import { trackEvent } from "@/lib/analytics";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";

type Region = { page?: number; x: number; y: number; width: number; height: number; field?: string; line_index?: number };
type Line = { description: string; quantity: number; unit_price: number; total: number; account_code?: string; account_name?: string | null; wafeq_account_id?: string | null; source_region?: Region };
type Invoice = {
  id: number; version?: number; review_version?: number; entity_id: number; entity_legal_name: string; original_filename?: string | null;
  vendor_name?: string | null; vendor_tax_number?: string | null; supplier_id?: number | null; wafeq_supplier_id?: string | null; wafeq_account_id?: string | null; wafeq_tax_id?: string | null; invoice_number?: string | null; invoice_date?: string | null;
  due_date?: string | null; currency?: string | null; manual_accounting_reference?: string | null; billing_country?: string | null; subtotal?: string | number | null; tax_amount?: string | number | null;
  total_amount?: string | number | null; line_items?: Line[]; accounting_destination?: string | null; resolved_accounting_destination?: string | null; review_status?: string; sync_status?: string; status?: string; error_message?: string | null;
  source_document?: { available?: boolean; url?: string; content_type?: string; page_count?: number; filename?: string; coordinates_available?: boolean };
  extraction_provenance?: { coordinates_available?: boolean; regions?: Record<string, Region>; fields?: Record<string, Region>; lines?: Record<string, Region> | Array<Region | null> };
};
type Issue = { id?: string | number; issue_key?: string; field?: string; message: string; severity?: "blocking" | "warning" | string; blocking?: boolean };

/**
 * These Odoo checks are useful in audit/details, but do not require reviewer
 * action: Odoo derives supplier/accounting representation during sync. Keep
 * this predicate narrow so provider-specific and genuinely blocking issues
 * remain visible on the review surface.
 */
export function isNonActionableOdooReviewWarning(issue: Issue, destination: string | null | undefined): boolean {
  if (destination !== "odoo") return false;
  if (issue.blocking || issue.severity === "blocking" || issue.severity === "error") return false;
  const key = String(issue.issue_key ?? "").toLowerCase();
  const message = String(issue.message ?? "").toLowerCase();
  const supplierTaxWarning = (
    key.includes("vat") || key.includes("trn")
  ) && (
    issue.field === "vendor_tax_number"
    || issue.field === "supplier_id"
    || message.includes("supplier")
    || message.includes("vat")
    || message.includes("trn")
  );
  if (supplierTaxWarning) return true;

  const lineSubtotalWarning = key === "subtotal_mismatch"
    || key.includes("totals.lines")
    || (message.includes("line item") && message.includes("subtotal"))
    || (message.includes("line items") && message.includes("reconcil"));
  return lineSubtotalWarning;
}

type SupplierOption = { id: number; name: string; display_name?: string | null; tax_number?: string | null; country?: string | null };
type WafeqSupplier = { id: string | number; external_id?: string; name: string; tax_registration_number?: string; country?: string; relationship?: string; };
type WafeqAccount = { id: string | number; external_id?: string; account_code: string; name_en: string; classification?: string; is_locked?: boolean; is_posting?: boolean; };
type WafeqTaxRate = { id: string | number; external_id?: string; name: string; friendly_name?: string; rate: number | string; tax_type?: string; };

type ReviewResponse = { requested_invoice_id?: number; canonical_invoice_id?: number; invoice?: Invoice; import?: Invoice; entity?: { id?: number; legal_name?: string; display_name?: string; country?: string | null; accounting_system?: string }; destination?: { accounting_system?: string | null }; resolved_accounting_destination?: string | null; validation?: { issues?: Issue[] }; issues?: Issue[]; reconciliation?: { status: "match" | "mismatch" | "pending"; source_total: number | null; calculated_total: number | null; difference: number | null; tolerance: number }; acknowledgements?: { issue_key: string; version?: number; review_version?: number }[]; source_document?: Invoice["source_document"]; extraction_provenance?: Invoice["extraction_provenance"]; permissions?: { can_edit?: boolean; can_approve?: boolean; can_sync?: boolean; can_reject?: boolean; can_delete?: boolean; can_upload_source?: boolean }; resolved_supplier?: SupplierOption | null; supplier_candidates?: SupplierOption[]; candidates?: SupplierOption[]; audit?: { id: number; event_type: string; actor_id: string; created_at: string }[]; audit_summary?: { id: number; event_type: string; actor_id: string; created_at: string }[] };
type ReviewNavigation = { previous_id?: number | null; next_id?: number | null; position?: number | null; total: number };
type SourceReplacementResponse = { source_document: NonNullable<Invoice["source_document"]>; review_version: number };

const money = (value: string | number | null | undefined) => Number(value ?? 0).toFixed(2);
const number = (value: string | number | null | undefined) => Number(value ?? 0) || 0;
const normalizeDateOnly = (value: string | null | undefined) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|T|\s)/.exec(value?.trim() ?? "");
  if (!match) return "";
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? `${match[1]}-${match[2]}-${match[3]}`
    : "";
};
const normalizeInvoiceDates = (invoice: Invoice): Invoice => ({
  ...invoice,
  invoice_date: normalizeDateOnly(invoice.invoice_date),
  due_date: normalizeDateOnly(invoice.due_date),
});

export const normalizeApprovedCurrency = (currency: string | null | undefined): string => {
  const value = String(currency ?? "").trim();
  return /^(lbp|lebanese pound|ل\.ل)$/iu.test(value) ? "LBP" : value;
};

export const displayApprovedCurrency = (currency: string | null | undefined): string => {
  return normalizeApprovedCurrency(currency) === "LBP" ? "Lebanese Pound / ل.ل" : String(currency ?? "");
};

const supplierLabel = (supplier: SupplierOption) => supplier.display_name || supplier.name;
const normalizeSupplierName = (name: string) => name
  .toLowerCase()
  .replace(/[^\w\s]/g, " ")
  .replace(/\b(llc|sal|sarl|ltd|limited|inc|co|company|trading|est|establishment)\b/g, " ")
  .replace(/\s+/g, " ")
  .trim();
const findAutomaticSupplier = (vendorName: string | null | undefined, candidates: SupplierOption[]) => {
  const normalizedVendor = normalizeSupplierName(vendorName ?? "");
  if (!normalizedVendor) return null;
  const matches = candidates.flatMap((candidate) =>
    [candidate.name, candidate.display_name]
      .filter((name): name is string => Boolean(name))
      .map(normalizeSupplierName)
      .filter((name) =>
        name.length >= 5 &&
        (name === normalizedVendor || ` ${normalizedVendor} `.includes(` ${name} `)),
      )
      .map((name) => ({ candidate, matchLength: name.length })),
  );
  matches.sort((a, b) => b.matchLength - a.matchLength);
  return matches[0]?.candidate ?? null;
};

// --- Wafeq Lookup Hooks ---
const useWafeqSuppliers = (q: string, enabled: boolean) => {
  return useQuery({
    queryKey: ["wafeq-suppliers", q],
    queryFn: () => apiFetch<{ suppliers?: WafeqSupplier[] }>(`/api/finance/invoice-review/wafeq/suppliers?q=${encodeURIComponent(q)}`),
    enabled,
  });
};

const useWafeqAccounts = (q: string, enabled: boolean) => {
  return useQuery({
    queryKey: ["wafeq-accounts", q],
    queryFn: () => apiFetch<{ accounts?: WafeqAccount[] }>(`/api/finance/invoice-review/wafeq/accounts?q=${encodeURIComponent(q)}`),
    enabled,
  });
};

const useWafeqTaxRates = (enabled: boolean) => {
  return useQuery({
    queryKey: ["wafeq-tax-rates"],
    queryFn: () => apiFetch<{ tax_rates?: WafeqTaxRate[] }>(`/api/finance/invoice-review/wafeq/tax-rates`),
    enabled,
  });
};

const useLocalSupplierSearch = (q: string, entityId: number | undefined, enabled: boolean) => {
  return useQuery({
    queryKey: ["invoice-review-suppliers", entityId, q],
    queryFn: () => apiFetch<{ suppliers?: SupplierOption[] }>(
      `/api/finance/suppliers/search?q=${encodeURIComponent(q)}&entity_id=${encodeURIComponent(String(entityId))}`,
    ),
    enabled: enabled && Boolean(entityId) && q.trim().length > 0,
  });
};

// --- Lookup Components ---
function WafeqSupplierSelect({
  wafeqValue,
  onChange,
  disabled,
  enabled = true,
}: {
  wafeqValue: string | null;
  onChange: (wafeqId: string | null) => void;
  disabled: boolean;
  enabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { data: searchResults, isFetching } = useWafeqSuppliers(query, enabled);

  const displayOptions = (searchResults?.suppliers ?? []).map(s => ({
    wafeqId: String(s.id),
    name: s.name,
    trn: s.tax_registration_number,
    country: s.country
  }));

  const selectedName = displayOptions.find(o => o.wafeqId === wafeqValue)?.name
    ?? (wafeqValue ? `Supplier ID: ${wafeqValue}` : "");

  return (
    <div className="flex flex-col gap-1.5">
       <Label className="text-sm font-medium">Accounting supplier</Label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id="review-wafeq_supplier_id"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className={cn("w-full justify-between font-normal bg-background shadow-sm border-transparent hover:border-input focus:border-ring transition-colors", !wafeqValue && "text-muted-foreground")}
            disabled={disabled}
            data-testid="input-resolve-supplier"
          >
            <span className="flex min-w-0 items-center gap-2">
              <Search className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{selectedName || "Search Wafeq supplier..."}</span>
            </span>
            <span className="ml-2 flex shrink-0 items-center gap-2">
              {wafeqValue && <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">Matched</Badge>}
              <ChevronsUpDown className="size-4 opacity-50" />
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[350px] p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput placeholder="Search Wafeq suppliers..." value={query} onValueChange={setQuery} />
            <CommandList>
              <CommandEmpty>{isFetching ? "Searching..." : "No suppliers found."}</CommandEmpty>
              <CommandGroup heading="Wafeq Results">
                {displayOptions.map(o => (
                  <CommandItem
                    key={o.wafeqId}
                    value={o.wafeqId}
                    onSelect={() => { onChange(o.wafeqId); setOpen(false); }}
                    data-testid={`button-supplier-candidate-${o.wafeqId}`}
                  >
                    <Check className={cn("mr-2 size-4 text-emerald-700", wafeqValue === o.wafeqId ? "opacity-100" : "opacity-0")} />
                    <div className="flex flex-col">
                      <span>{o.name}</span>
                      {(o.trn || o.country) && (
                        <span className="text-[10px] text-muted-foreground mt-0.5">
                          {o.trn && `TRN: ${o.trn} `} {o.country}
                        </span>
                      )}
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}


function WafeqAccountSelect({
  value,
  code,
  name,
  onChange,
  disabled,
  enabled = true,
  testId,
}: {
  value?: string | null;
  code?: string | null;
  name?: string | null;
  onChange: (id: string, code: string, name: string) => void;
  disabled?: boolean;
  enabled?: boolean;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { data, isFetching } = useWafeqAccounts(query, enabled);

  const accounts = data?.accounts ?? [];
  const selected = accounts.find(a => String(a.id) === value);
  const selectedName = selected
    ? `${selected.account_code} - ${selected.name_en}`
    : value
      ? `${code || `Account ID: ${value}`}${name ? ` - ${name}` : ""}`
      : "";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
         <Button id={testId ? `input-${testId}` : undefined} variant="outline" role="combobox" aria-label="Accounting account" data-testid={testId} className={cn("w-full justify-between font-normal h-8 px-2 bg-background shadow-none transition-colors text-sm", !value && "text-muted-foreground italic")} disabled={disabled}>
          <span className="truncate">{selectedName || "Select account..."}</span>
          <ChevronsUpDown className="ml-1 size-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[300px] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder="Search accounts..." value={query} onValueChange={setQuery} />
          <CommandList>
            <CommandEmpty>{isFetching ? "Searching..." : "No accounts found."}</CommandEmpty>
            <CommandGroup>
              {accounts.map(a => (
                 <CommandItem key={String(a.id)} value={String(a.id)} onSelect={() => { onChange(String(a.id), a.account_code, a.name_en); setOpen(false); }}>
                  <Check className={cn("mr-2 size-4 text-emerald-700", value === String(a.id) ? "opacity-100" : "opacity-0")} />
                  {a.account_code} - {a.name_en}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

function LocalSupplierSelect({
  value,
  onChange,
  disabled,
  candidates,
  entityId,
}: {
  value: number | null;
  onChange: (id: number | null) => void;
  disabled: boolean;
  candidates: SupplierOption[];
  entityId?: number;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { data: searchResults, isFetching } = useLocalSupplierSearch(query, entityId, open);

  const filteredCandidates = query
    ? (searchResults?.suppliers ?? candidates.filter(c => supplierLabel(c).toLowerCase().includes(query.toLowerCase())))
    : candidates;
  const options = [...candidates, ...filteredCandidates].filter((candidate, index, all) =>
    all.findIndex(other => other.id === candidate.id) === index,
  );

  const selected = options.find(c => c.id === value);
  const selectedName = selected
    ? supplierLabel(selected)
    : (value ? `Supplier ID: ${value}` : "");

  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-sm font-medium">Accounting supplier</Label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id="review-supplier_id"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className={cn("w-full justify-between font-normal bg-background shadow-sm border-transparent hover:border-input focus:border-ring transition-colors", !value && "text-muted-foreground")}
            disabled={disabled}
            data-testid="input-resolve-supplier"
          >
            <span className="flex min-w-0 items-center gap-2">
              <Search className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{selectedName || "Search supplier..."}</span>
            </span>
            <span className="ml-2 flex shrink-0 items-center gap-2">
              {value && <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">Matched</Badge>}
              <ChevronsUpDown className="size-4 opacity-50" />
            </span>
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[350px] p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput placeholder="Search suppliers..." value={query} onValueChange={setQuery} />
            <CommandList>
              <CommandEmpty>{isFetching ? "Searching..." : "No suppliers found."}</CommandEmpty>
              <CommandGroup heading="Candidates">
                {options.map(c => (
                  <CommandItem
                    key={c.id}
                    value={String(c.id)}
                    onSelect={() => { onChange(c.id); setOpen(false); }}
                    data-testid={`button-supplier-candidate-${c.id}`}
                  >
                    <Check className={cn("mr-2 size-4 text-emerald-700", value === c.id ? "opacity-100" : "opacity-0")} />
                      <span className="flex flex-col">
                        <span>{supplierLabel(c)}</span>
                        {(c.tax_number || c.country) && (
                          <span className="text-[10px] text-muted-foreground">
                            {c.tax_number && `TRN: ${c.tax_number} `}
                            {c.country}
                          </span>
                        )}
                      </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}

function TaxRateSelect({ value, onChange, disabled, taxRates, isLoading }: { value: string | null; onChange: (v: string | null) => void; disabled: boolean; taxRates: WafeqTaxRate[]; isLoading: boolean }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="review-wafeq_tax_id" className="text-muted-foreground uppercase tracking-widest text-[10px] font-semibold">VAT (bill level)</Label>
      <Select value={value ?? undefined} onValueChange={(v) => onChange(v)} disabled={disabled || isLoading}>
        <SelectTrigger id="review-wafeq_tax_id" aria-label="VAT / Tax treatment" data-testid="input-review-wafeq_tax_id" className="bg-background shadow-sm border-transparent hover:border-input focus:border-ring transition-colors">
          <SelectValue placeholder="Select tax rate..." />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="no_vat">No VAT (0%)</SelectItem>
          {taxRates.map(t => (
            <SelectItem key={String(t.id)} value={String(t.id)}>
              {t.name} ({t.rate}%)
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">Applies to the entire bill.</p>
    </div>
  )
}

// --- Main Page Component ---
export default function AiInvoiceReviewPage() {
  const [, params] = useRoute("/ai-invoice-import/:id/review");
  const [location, setLocation] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const id = Number(params?.id);
  const [split, setSplit] = useState(50);
  const [activeField, setActiveField] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(100);
  const [rotation, setRotation] = useState(0);
  const [fit, setFit] = useState(true);
  const [draft, setDraft] = useState<Invoice | null>(null);
  const [acknowledgedIssueKeys, setAcknowledgedIssueKeys] = useState<Set<string>>(new Set());
  const acknowledgedVersionRef = useRef<number | undefined>(undefined);
  const hasInitializedAcknowledgementsRef = useRef(false);
  const [dirty, setDirty] = useState(false);
  const [replacingSource, setReplacingSource] = useState(false);
  const [sourceRenderFailed, setSourceRenderFailed] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [addSupplierOpen, setAddSupplierOpen] = useState(false);
  const [billDetailsOpen, setBillDetailsOpen] = useState(true);
  const [accountingDetailsOpen, setAccountingDetailsOpen] = useState(false);
  const [lineItemsOpen, setLineItemsOpen] = useState(true);
  const [bulkAccount, setBulkAccount] = useState<{ id: string; code: string; name: string } | null>(null);
  const [bulkAccountDialogOpen, setBulkAccountDialogOpen] = useState(false);
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});
  const [newSupplier, setNewSupplier] = useState({
    name: "",
    tax_number: "",
    country: "",
    billing_address: "",
    contact_phone: "",
    contact_email: "",
  });
  const [createdSupplierOption, setCreatedSupplierOption] = useState<SupplierOption | null>(null);
  const sourceInputRef = useRef<HTMLInputElement>(null);
  const validId = Number.isInteger(id) && id > 0;

  const detail = useQuery({
    queryKey: ["invoice-review", id],
    queryFn: () => apiFetch<ReviewResponse>(`/api/finance/invoice-review/${id}`, { timeoutMs: 15_000 }),
    enabled: validId,
    retry: 1,
  });
  const invoice = detail.data?.invoice ?? detail.data?.import;
  const issues = detail.data?.validation?.issues ?? detail.data?.issues ?? [];
  const sourceBeforeRender = detail.data?.source_document ?? invoice?.source_document;
  const sourceKnownAvailable = sourceBeforeRender?.available ?? Boolean(sourceBeforeRender?.url);

  const sourceBlob = useQuery({
    queryKey: ["invoice-review-source", id, sourceBeforeRender?.url],
    queryFn: async () => {
      const token = await getClerkToken();
      const response = await fetch(sourceBeforeRender?.url ?? `/api/finance/invoice-review/${id}/source`, {
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Source document could not be loaded");
      return response.blob();
    },
    enabled: sourceKnownAvailable,
    staleTime: Infinity,
    refetchOnMount: "always",
  });

  const sourceObjectUrl = useMemo(
    () => sourceBlob.data ? URL.createObjectURL(sourceBlob.data) : null,
    [sourceBlob.data],
  );
  useEffect(() => () => {
    if (sourceObjectUrl) URL.revokeObjectURL(sourceObjectUrl);
  }, [sourceObjectUrl]);
  useEffect(() => {
    setSourceRenderFailed(false);
  }, [sourceBlob.data]);

  const queueContext = useMemo(() => {
    const query = location.includes("?") ? location.slice(location.indexOf("?") + 1) : "";
    return new URLSearchParams(query).toString();
  }, [location]);
  useEffect(() => {
    const canonicalId = detail.data?.canonical_invoice_id ?? invoice?.id;
    if (!Number.isInteger(canonicalId) || canonicalId === id) return;
    const canonicalResponse = detail.data;
    qc.setQueryData<ReviewResponse>(["invoice-review", canonicalId], canonicalResponse);
    qc.removeQueries({ queryKey: ["invoice-review", id], exact: true });
    qc.removeQueries({ queryKey: ["invoice-review-source", id] });
    qc.removeQueries({ queryKey: ["invoice-review-neighbors", id] });
    const query = location.includes("?") ? location.slice(location.indexOf("?")) : "";
    setLocation(`/ai-invoice-import/${canonicalId}/review${query}`, { replace: true });
  }, [detail.data, id, invoice?.id, location, qc, setLocation]);
  const neighbors = useQuery({
    queryKey: ["invoice-review-neighbors", id, queueContext],
    queryFn: () => apiFetch<ReviewNavigation>(`/api/finance/invoice-review/${id}/neighbors${queueContext ? `?${queueContext}` : ""}`),
    enabled: !!invoice,
  });

  const selectedDestination = draft?.accounting_destination ?? detail.data?.resolved_accounting_destination ?? detail.data?.destination?.accounting_system ?? detail.data?.entity?.accounting_system ?? null;
  const isWafeq = selectedDestination === "wafeq";
  const isExternalDestination = selectedDestination === "odoo" || selectedDestination === "wafeq";

  const taxRatesQuery = useWafeqTaxRates(isWafeq ?? false);
  const taxRates = taxRatesQuery.data?.tax_rates ?? [];

  useEffect(() => {
    if (!invoice) return;
    const normalizedInvoice = normalizeInvoiceDates(invoice);

    setDraft({
      ...normalizedInvoice,
      line_items: [...(normalizedInvoice.line_items ?? [])],
    });
    const reviewVersion = normalizedInvoice.review_version ?? normalizedInvoice.version;
    if (!hasInitializedAcknowledgementsRef.current || acknowledgedVersionRef.current !== reviewVersion) {
      hasInitializedAcknowledgementsRef.current = true;
      acknowledgedVersionRef.current = reviewVersion;
      setAcknowledgedIssueKeys(new Set(
        (detail.data?.acknowledgements ?? [])
          .filter(ack => {
            const acknowledgedVersion = ack.review_version ?? ack.version;
            return acknowledgedVersion == null || acknowledgedVersion === reviewVersion;
          })
          .map(ack => ack.issue_key),
      ));
    }
    setDirty(false);
    trackEvent("invoice_review_opened", { review_status: invoice.review_status ?? "unknown", sync_status: invoice.sync_status ?? "unknown" });
  }, [invoice]);

  useEffect(() => {
    setCreatedSupplierOption(null);
    setNewSupplier({
      name: "",
      tax_number: "",
      country: "",
      billing_address: "",
      contact_phone: "",
      contact_email: "",
    });
  }, [id]);

  useEffect(() => {
    const warning = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ""; } };
    window.addEventListener("beforeunload", warning); return () => window.removeEventListener("beforeunload", warning);
  }, [dirty]);

  useEffect(() => {
    const keys = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") { event.preventDefault(); save(); }
      if (event.key === "Escape") setActiveField(null);
    };
    window.addEventListener("keydown", keys); return () => window.removeEventListener("keydown", keys);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, draft]);

  const update = (key: keyof Invoice, value: unknown) => {
    setDraft((current) => current ? { ...current, [key]: value } : current);
    setDirty(true); setActiveField(String(key));
    trackEvent("invoice_review_edited", { field: String(key) });
  };

  const changeDestination = (value: string) => {
    const destination = value === "automatic" ? null : value;
    setDraft((current) => {
      if (!current) return current;
      const next = { ...current, accounting_destination: destination };
      if (destination !== "wafeq") {
        next.wafeq_supplier_id = null;
        next.wafeq_tax_id = null;
        next.wafeq_account_id = null;
        next.line_items = (current.line_items ?? []).map((line) => ({
          ...line,
          wafeq_account_id: null,
        }));
      }
      if (destination === "wafeq") {
        next.supplier_id = null;
        next.line_items = (current.line_items ?? []).map((line) => ({
          ...line,
          account_code: undefined,
          account_name: null,
        }));
      }
      return next;
    });
    setBulkAccount(null);
    setDirty(true);
    setActiveField("accounting_destination");
    trackEvent("invoice_review_destination_changed", { destination: destination ?? "automatic" });
  };

  const reconcileLines = (lines: Line[]) => {
    const subtotal = lines.reduce((sum, line) => sum + number(line.total), 0);
    const isWafeqLocal = isWafeq;

    if (isWafeqLocal) {
      const selectedTax = taxRates.find(t => String(t.id) === draft?.wafeq_tax_id);
      const rawRate = selectedTax ? Number(selectedTax.rate) : 0;
      const rate = (draft?.wafeq_tax_id === "no_vat" || !Number.isFinite(rawRate) || rawRate < 0)
        ? 0
        : rawRate > 1 ? rawRate / 100 : rawRate;
      const tax = subtotal * rate;
      setDraft((current) => current ? {
        ...current,
        line_items: lines,
        subtotal: Math.round(subtotal * 100) / 100,
        tax_amount: Math.round(tax * 100) / 100,
        total_amount: Math.round((subtotal + tax) * 100) / 100
      } : current);
    } else {
      const currentTax = number(draft?.tax_amount);
      setDraft((current) => current ? {
        ...current,
        line_items: lines,
        subtotal: Math.round(subtotal * 100) / 100,
        tax_amount: currentTax,
        total_amount: Math.round((subtotal + currentTax) * 100) / 100
      } : current);
    }
    setDirty(true);
  };

  const updateTaxRate = (taxRateId: string | null) => {
    const selectedTax = taxRates.find(t => String(t.id) === taxRateId);
    const rawRate = selectedTax ? Number(selectedTax.rate) : 0;
    const rate = taxRateId === "no_vat" || !Number.isFinite(rawRate) || rawRate < 0
      ? 0
      : rawRate > 1 ? rawRate / 100 : rawRate;
    const subtotal = number(draft?.subtotal);
    const tax = subtotal * rate;

    setDraft(current => current ? {
      ...current,
      wafeq_tax_id: taxRateId === "no_vat" ? "no_vat" : taxRateId,
      tax_amount: Math.round(tax * 100) / 100,
      total_amount: Math.round((subtotal + tax) * 100) / 100
    } : current);
    setDirty(true);
  };

  const updateLine = (index: number, updates: Partial<Line>) => {
    const lines = [...(draft?.line_items ?? [])];
    const next = { ...lines[index], ...updates };

    if ('quantity' in updates || 'unit_price' in updates) {
      next.quantity = number(next.quantity);
      next.unit_price = number(next.unit_price);
      next.total = Math.round(next.quantity * next.unit_price * 10000) / 10000;
    }

    lines[index] = next;
    reconcileLines(lines);

    setDirty(true);
    setActiveField(`line_items.${index}`);
    const updatedKey = Object.keys(updates)[0];
    trackEvent("invoice_review_edited", { field: `line_items.${index}.${updatedKey}` });
  };

  const applyBulkAccount = () => {
    if (!bulkAccount) return;
    setDraft((current) => current ? {
      ...current,
      wafeq_account_id: isWafeq ? bulkAccount.id : current.wafeq_account_id,
      line_items: (current.line_items ?? []).map((line) => ({
        ...line,
        ...(isWafeq
          ? { wafeq_account_id: bulkAccount.id, account_code: bulkAccount.code, account_name: bulkAccount.name }
          : { account_code: bulkAccount.code, account_name: bulkAccount.name }),
      })),
    } : current);
    setBulkAccountDialogOpen(false);
    setDirty(true);
    setActiveField("line_items");
    trackEvent("invoice_review_bulk_account_applied", { line_count: draft?.line_items?.length ?? 0 });
  };

  const saveMutation = useMutation({
    mutationFn: (values: Invoice) => apiFetch<{ invoice?: Invoice; validation?: ReviewResponse["validation"] }>(`/api/finance/invoice-review/${id}/draft`, {
      method: "PATCH",
      body: JSON.stringify({
        ...values,
        invoice_date: normalizeDateOnly(values.invoice_date),
        due_date: normalizeDateOnly(values.due_date),
        version: values.review_version ?? values.version,
      }),
    }),
    onSuccess: (result) => {
      if (result.invoice) {
        const savedInvoice = normalizeInvoiceDates(result.invoice);
        setDraft(savedInvoice);
        qc.setQueryData<ReviewResponse>(["invoice-review", id], (current) => current ? {
          ...current,
          invoice: savedInvoice,
          ...(result.validation ? { validation: result.validation } : {}),
        } : { invoice: savedInvoice, validation: result.validation });
      }
      setDirty(false);
      trackEvent("invoice_review_saved");
      qc.invalidateQueries({ queryKey: ["invoice-review", id] });
      qc.invalidateQueries({ queryKey: ["finance-imports"] });
      toast({ title: "Review draft saved" });
    },
    onError: (error) => toast({ title: "Could not save draft", description: error instanceof Error ? error.message : String(error), variant: "destructive" }),
  });

  const save = useCallback(() => { if (draft) saveMutation.mutate(draft); }, [draft, saveMutation]);

  const createSupplierMutation = useMutation({
    mutationFn: async (values: typeof newSupplier) => {
      try {
        const result = await apiFetch<{ supplier?: SupplierOption & Record<string, unknown> }>("/api/suppliers", {
          method: "POST",
          body: JSON.stringify({
            name: values.name.trim(),
            tax_number: values.tax_number.trim() || undefined,
            country: values.country.trim() || undefined,
            billing_address: values.billing_address.trim() || undefined,
            contact_phone: values.contact_phone.trim() || undefined,
            contact_email: values.contact_email.trim() || undefined,
          }),
        });
        return { supplier: result.supplier, reused: false };
      } catch (error) {
        const apiError = error as Error & { status?: number; body?: { existingId?: number } };
        if (apiError.status === 409 && apiError.body?.existingId) {
          return {
            supplier: { id: Number(apiError.body.existingId), name: values.name.trim(), display_name: values.name.trim() },
            reused: true,
          };
        }
        throw error;
      }
    },
    onSuccess: async ({ supplier, reused }) => {
      if (!supplier?.id || !draft) return;
      const option: SupplierOption = {
        id: Number(supplier.id),
        name: supplier.name || newSupplier.name.trim(),
        display_name: supplier.display_name ?? null,
      };
      setCreatedSupplierOption(option);
      qc.setQueryData<ReviewResponse>(["invoice-review", id], (current) => current ? {
        ...current,
        supplier_candidates: [
          option,
          ...(current.supplier_candidates ?? current.candidates ?? []).filter(candidate => candidate.id !== option.id),
        ],
      } : current);
      setDraft(current => current ? { ...current, supplier_id: option.id } : current);
      setDirty(true);
      setAddSupplierOpen(false);
      const saved = await saveMutation.mutateAsync({ ...draft, supplier_id: option.id });
      if (saved.invoice) {
        setDraft(normalizeInvoiceDates(saved.invoice));
      }
      qc.invalidateQueries({ queryKey: ["invoice-review-suppliers", draft.entity_id] });
      toast({ title: reused ? "Existing supplier linked" : "Supplier created and linked" });
    },
    onError: (error) => toast({
      title: "Could not create supplier",
      description: error instanceof Error ? error.message : String(error),
      variant: "destructive",
    }),
  });

  const action = useMutation({
    mutationFn: ({ action: name, version, reason, syncStatus }: { action: "approve" | "reject" | "sync"; version: number; reason?: string; syncStatus?: string }) => {
      const retrying = name === "sync" && syncStatus === "failed";
      const endpoint = name === "sync" ? (retrying ? "retry-sync" : "sync") : name;
      const idempotencyKey = retrying
        ? `retry:${id}:${version}:${crypto.randomUUID()}`
        : `approved-sync:${id}:${version}`;
      return apiFetch(`/api/finance/invoice-review/${id}/${endpoint}`, {
        method: "POST",
        body: JSON.stringify({
          version,
          ...(name === "sync" ? { idempotency_key: idempotencyKey } : name === "reject" ? { reason } : {}),
        }),
      });
    },
    onSuccess: async (data: any, variables) => {
      const nextStatus = data?.sync?.status;
      setDraft((current) => current ? {
        ...current,
        ...(data?.invoice ?? {}),
        ...(nextStatus ? { review_status: "approved", sync_status: nextStatus, error_message: data?.sync?.error ?? null } : {}),
      } : current);
      setDirty(false);
      trackEvent("invoice_review_action", { action: variables.action });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["invoice-review", id] }),
        qc.invalidateQueries({ queryKey: ["finance-imports"] }),
      ]);
      const refreshed = await detail.refetch();
      const refreshedInvoice = refreshed.data?.invoice;
      if (refreshedInvoice) {
        setDraft((current) => current
          ? { ...current, ...refreshedInvoice }
          : refreshedInvoice);
      }
      const syncedDestination = typeof data?.sync?.destination === "string"
        ? data.sync.destination
        : typeof data?.destination === "string"
          ? data.destination
          : null;
      const providerName = syncedDestination === "odoo" ? "Odoo" : syncedDestination === "wafeq" ? "Wafeq" : null;
      toast({ title: nextStatus === "succeeded" && providerName ? `Invoice synced with ${providerName}` : "Invoice updated" });
    },
    onError: (error) => {
      void detail.refetch();
      toast({ title: "Action could not be completed", description: error instanceof Error ? error.message : String(error), variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => apiFetch(`/api/finance/ai-invoice-import/imports/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      trackEvent("invoice_review_deleted");
      qc.removeQueries({ queryKey: ["invoice-review", id] });
      qc.invalidateQueries({ queryKey: ["finance-imports"] });
      toast({ title: "Invoice entry deleted" });
      setLocation("/ai-invoice-import");
    },
    onError: (error) => toast({ title: "Could not delete invoice", description: error instanceof Error ? error.message : String(error), variant: "destructive" }),
  });

  const navigate = (target?: number) => {
    if (!target) return;
    if (dirty && !window.confirm("You have unsaved changes. Leave this invoice?")) return;
    setLocation(`/ai-invoice-import/${target}/review${queueContext ? `?${queueContext}` : ""}`);
  };
  useEffect(() => {
    const handleBillNavigation = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest("input, textarea, select, [contenteditable=true], [role=combobox], [role=listbox]")) return;
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key === "ArrowLeft" && neighbors.data?.previous_id) {
        event.preventDefault();
        navigate(neighbors.data.previous_id);
      } else if (event.key === "ArrowRight" && neighbors.data?.next_id) {
        event.preventDefault();
        navigate(neighbors.data.next_id);
      }
    };
    window.addEventListener("keydown", handleBillNavigation);
    return () => window.removeEventListener("keydown", handleBillNavigation);
  });

  if (!validId) return <div className="min-h-[100dvh] grid place-items-center gap-3 bg-background"><p role="alert">This invoice review link is invalid.</p><Button onClick={() => setLocation("/ai-invoice-import")}>Return to invoice queue</Button></div>;
  if (detail.isError) return <div className="min-h-[100dvh] grid place-items-center gap-3 bg-background"><p role="alert">Unable to load this invoice.</p><Button data-testid="button-retry-review" onClick={() => detail.refetch()}>Retry</Button></div>;
  if (detail.isSuccess && !invoice) return <div className="min-h-[100dvh] grid place-items-center gap-3 bg-background"><p role="alert">The invoice review response was incomplete.</p><Button data-testid="button-retry-review" onClick={() => detail.refetch()}>Retry</Button></div>;
  if (detail.isLoading || !draft) return <div className="min-h-[100dvh] grid place-items-center bg-background text-muted-foreground" data-testid="status-review-loading"><Loader2 className="size-6 animate-spin mb-4" /> Loading invoice review…</div>;

  const source = detail.data?.source_document ?? draft.source_document;
  const provenance = detail.data?.extraction_provenance ?? draft.extraction_provenance;
  const sourceUrl = source?.url ?? `/api/finance/invoice-review/${id}/source`;
  const viewerUrl = sourceObjectUrl;
  const isPdf = source?.content_type
    ? source.content_type === "application/pdf"
    : draft.original_filename?.toLowerCase().endsWith(".pdf");
  const isImage = source?.content_type
    ? source.content_type.startsWith("image/")
    : /\.(jpe?g|png|webp)$/i.test(draft.original_filename ?? "");
  const sourceAvailable = source?.available ?? Boolean(source?.url);
  const coordinates = source?.coordinates_available ?? provenance?.coordinates_available ?? false;
  const lineEvidence: Record<string, Region> = Array.isArray(provenance?.lines)
    ? Object.fromEntries(provenance.lines.flatMap((value, index) =>
        value !== null && typeof value === "object"
          ? [[`line_items.${value.line_index ?? index}`, value] as const]
          : [],
      ))
    : provenance?.lines ?? {};
  const evidence = {
    ...(provenance?.regions ?? {}),
    ...(provenance?.fields ?? {}),
    ...lineEvidence,
  };
  const canEdit = detail.data?.permissions?.can_edit !== false;
  const canUploadSource = detail.data?.permissions?.can_upload_source === true;

  const isApprovedAwaitingSync = draft.review_status === "approved" && draft.sync_status === "not_requested";
  const isApprovedFailedSync = draft.review_status === "approved" && draft.sync_status === "failed";
  const syncInProgressOrDone = ["pending", "in_progress", "succeeded"].includes(draft.sync_status ?? "");
  const sourceUploadUnavailableReason = !canUploadSource
    ? "You do not have access to upload invoice source documents."
    : syncInProgressOrDone
      ? "The source cannot be replaced after accounting sync has started."
      : null;
  const destinationName = detail.data?.entity?.display_name ?? detail.data?.entity?.legal_name ?? draft.entity_legal_name;
  const openAddSupplier = () => {
    setNewSupplier({
      name: draft.vendor_name ?? "",
      tax_number: draft.vendor_tax_number ?? "",
      country: draft.billing_country ?? detail.data?.entity?.country ?? "",
      billing_address: "",
      contact_phone: "",
      contact_email: "",
    });
    setAddSupplierOpen(true);
  };

  const originalSubtotal = invoice?.subtotal != null ? number(invoice.subtotal) : null;
  const originalTax = invoice?.tax_amount != null ? number(invoice.tax_amount) : null;
  const originalTotal = invoice?.total_amount != null ? number(invoice.total_amount) : null;
  const reconciliationEvidence = detail.data?.reconciliation ?? {
    status: "pending" as const,
    source_total: null,
    calculated_total: number(draft.total_amount),
    difference: null,
    tolerance: 0.01,
  };
  const calculatedTotal = draft.total_amount == null || String(draft.total_amount).trim() === "" ? null : Number(draft.total_amount);
  const liveReconciliation = reconciliationEvidence.source_total == null || calculatedTotal == null || !Number.isFinite(calculatedTotal)
    ? { ...reconciliationEvidence, status: "pending" as const, calculated_total: calculatedTotal != null && Number.isFinite(calculatedTotal) ? calculatedTotal : null, difference: null }
    : (() => {
      const difference = Math.round((calculatedTotal - reconciliationEvidence.source_total) * 10000) / 10000;
      return {
        ...reconciliationEvidence,
        status: Math.abs(difference) <= reconciliationEvidence.tolerance ? "match" as const : "mismatch" as const,
        calculated_total: calculatedTotal,
        difference,
      };
    })();

  const liveIssues: Issue[] = [];
  if (isWafeq) {
    if (!draft.wafeq_supplier_id) liveIssues.push({ issue_key: "wafeq_supplier_id", field: "wafeq_supplier_id", message: "Wafeq supplier mapping is required", severity: "blocking", blocking: true });
    if (taxRates.length > 0 && !draft.wafeq_tax_id) liveIssues.push({ issue_key: "wafeq_tax_id", field: "wafeq_tax_id", message: "Bill tax mapping is required", severity: "blocking", blocking: true });

    if (draft.wafeq_tax_id && taxRates.length > 0) {
      const selectedTax = taxRates.find(t => String(t.id) === draft.wafeq_tax_id);
      if (selectedTax) {
        const rawRate = Number(selectedTax.rate);
        if (!Number.isFinite(rawRate) || rawRate < 0) {
          liveIssues.push({ issue_key: "invalid_tax_rate", field: "wafeq_tax_id", message: "Selected tax rate configuration is invalid", severity: "blocking", blocking: true });
        }
      }
    }
  }

  if (!draft.invoice_number) liveIssues.push({ issue_key: "invoice_number", field: "invoice_number", message: "Invoice number is required", severity: "blocking", blocking: true });
  if (!draft.invoice_date) liveIssues.push({ issue_key: "invoice_date", field: "invoice_date", message: "Invoice date is required", severity: "blocking", blocking: true });
  if (!draft.currency) liveIssues.push({ issue_key: "currency", field: "currency", message: "Currency is required", severity: "blocking", blocking: true });
  if (liveReconciliation.status === "mismatch") {
    liveIssues.push({
      issue_key: "source.total_mismatch",
      field: "total_amount",
      message: `Invoice total differs from the extracted source by ${money(Math.abs(liveReconciliation.difference ?? 0))}`,
      severity: "blocking",
      blocking: true,
    });
  }

  const draftSubtotal = (draft.line_items ?? []).reduce((sum, line) => sum + number(line.total), 0);
  if (Math.abs(draftSubtotal - number(draft.subtotal)) > 0.01) {
    const arithmeticIsWarning = selectedDestination === "odoo";
    liveIssues.push({
      issue_key: "subtotal_mismatch",
      field: "subtotal",
      message: "Line items total does not match bill subtotal",
      severity: arithmeticIsWarning ? "warning" : "blocking",
      blocking: !arithmeticIsWarning,
    });
  }

  (draft.line_items ?? []).forEach((line, i) => {
    if (!line.description) liveIssues.push({ issue_key: `line_${i}_desc`, field: `line_items.${i}.description`, message: `Line ${i+1} description is required`, severity: "blocking", blocking: true });
    if (isWafeq && !line.wafeq_account_id && !draft.wafeq_account_id) liveIssues.push({ issue_key: `line_${i}_account`, field: `line_items.${i}.wafeq_account_id`, message: `Line ${i+1} account mapping is required`, severity: "blocking", blocking: true });
  });

  const activeServerIssues = issues.filter(serverIssue => {
    const issueKey = serverIssue.issue_key ?? String(serverIssue.id ?? "");
    // Odoo resolves line-level accounting internally. Wafeq line mapping
    // remains a real provider-specific reviewer requirement.
    if (!isWafeq && (/^line_items\.\d+\.account_code$/.test(serverIssue.field ?? "") || /^account\.(unmapped|mapping)/i.test(issueKey))) return false;
    const isBlocking = serverIssue.blocking || serverIssue.severity === "blocking" || serverIssue.severity === "error";
    if (!isBlocking && acknowledgedIssueKeys.has(issueKey)) return false;
    if (liveIssues.some(live => live.field === serverIssue.field)) return false;

    // A provider account selector writes both the stable external id and the
    // human-readable account code. Treat either representation as resolving
    // the same stale server issue so readiness updates before a refetch.
    if (serverIssue.issue_key?.startsWith("account.unmapped.")
      || serverIssue.issue_key?.startsWith("wafeq.account.unmapped.")
      || serverIssue.field?.includes("account")) {
      const match = serverIssue.field?.match(/^line_items\.(\d+)\./)
        ?? serverIssue.issue_key?.match(/(?:unmapped\.)(\d+)$/);
      const line = match ? draft.line_items?.[Number(match[1])] : null;
      if (line && (line.wafeq_account_id || line.account_code)) return false;
      if (!match && draft.wafeq_account_id) return false;
    }

    const isRequiredIssue = serverIssue.issue_key?.includes('required') || serverIssue.issue_key?.includes('missing') || serverIssue.message?.toLowerCase().includes('required');

    if (isRequiredIssue) {
      if (serverIssue.field === "vendor_name" || serverIssue.field === "supplier_id" || serverIssue.field === "wafeq_supplier_id") {
         if (isWafeq && draft.wafeq_supplier_id) return false;
         if (!isWafeq && (draft.supplier_id || draft.vendor_name)) return false;
      }
      if (serverIssue.field && serverIssue.field.startsWith("line_items.")) {
        const match = serverIssue.field.match(/^line_items\.(\d+)\.(.+)$/);
        if (match) {
          const idx = Number(match[1]);
          const key = match[2];
          const line = draft.line_items?.[idx];
          if (line && line[key as keyof Line]) return false;
        }
      }
      if (serverIssue.field && draft[serverIssue.field as keyof Invoice]) return false;
    }

    if (serverIssue.field === "subtotal" && (serverIssue.issue_key?.includes('mismatch') || serverIssue.message?.toLowerCase().includes('match'))) {
      const draftSubtotalVal = (draft.line_items ?? []).reduce((sum, line) => sum + number(line.total), 0);
      if (Math.abs(draftSubtotalVal - number(draft.subtotal)) <= 0.01) return false;
    }

    if (isWafeq && draft.wafeq_tax_id) {
      if (serverIssue.issue_key === "wafeq.tax.amount_mismatch" || (serverIssue.field === "tax_amount" && serverIssue.issue_key?.includes('mismatch'))) {
        const selectedTax = taxRates.find(t => String(t.id) === draft.wafeq_tax_id);
        const rawRate = selectedTax ? Number(selectedTax.rate) : 0;
        const rate = (Number.isFinite(rawRate) && rawRate >= 0) ? rawRate : 0;
        const expectedTax = number(draft.subtotal) * (rate > 1 ? rate / 100 : rate);
        if (Math.abs(expectedTax - number(draft.tax_amount)) <= 0.01) return false;
      }
      if (serverIssue.issue_key === "wafeq.total.amount_mismatch" || (serverIssue.field === "total_amount" && serverIssue.issue_key?.includes('mismatch'))) {
        const expectedTotal = number(draft.subtotal) + number(draft.tax_amount);
        if (Math.abs(expectedTotal - number(draft.total_amount)) <= 0.01) return false;
      }
    }

    return true;
  });

  const normalizedServerIssues = activeServerIssues.map((issue) => {
    const message = issue.message.toLowerCase();
    const isApprovedSupplierVatMismatch = draft.review_status === "approved" && (
      (issue.issue_key ?? "").toLowerCase().includes("vat")
      || (issue.issue_key ?? "").toLowerCase().includes("trn")
      || message.includes("vat/trn")
      || message.includes("vat or trn")
    ) && (issue.field === "vendor_tax_number" || issue.field === "supplier_id" || message.includes("supplier"));
    return isApprovedSupplierVatMismatch
      ? { ...issue, severity: "warning" as const, blocking: false }
      : issue;
  });
  const presentationServerIssues = normalizedServerIssues.filter(
    issue => !isNonActionableOdooReviewWarning(issue, selectedDestination),
  );
  const presentationLiveIssues = liveIssues.filter(
    issue => !isNonActionableOdooReviewWarning(issue, selectedDestination),
  );
  const informationalIssues = [...liveIssues, ...normalizedServerIssues].filter(
    issue => isNonActionableOdooReviewWarning(issue, selectedDestination),
  );
  const allIssues = [...presentationLiveIssues, ...presentationServerIssues];
  const blockingIssues = allIssues.filter(i => i.blocking || i.severity === 'blocking' || i.severity === 'error');
  const warningIssues = allIssues.filter(i => !i.blocking && i.severity !== 'blocking' && i.severity !== 'error');
  const hasBlockingIssues = blockingIssues.length > 0;
  const effectiveReviewStatus = draft.review_status ?? "needs_review";
  const lifecycle = action.isPending && (action.variables?.action === "approve" || action.variables?.action === "sync")
    ? "syncing"
    : draft.sync_status === "succeeded"
    ? "synced"
    : draft.sync_status === "failed" && effectiveReviewStatus === "approved"
      ? "sync_failed"
      : ["pending", "in_progress"].includes(draft.sync_status ?? "")
        ? "syncing"
        : effectiveReviewStatus === "approved" && draft.sync_status === "not_requested"
          ? "approved"
        : !hasBlockingIssues && effectiveReviewStatus === "needs_review"
          ? "ready"
          : "needs_review";
  const lifecycleLabel = {
    needs_review: "Needs review",
    ready: "Ready to sync",
    syncing: "Syncing",
    synced: "Synced",
    sync_failed: "Sync failed",
    approved: isExternalDestination ? "Approved — sync pending" : "Approved",
  }[lifecycle];

  const groupedIssues = {
    "Supplier": allIssues.filter(i => i.field?.includes('supplier') || i.field === 'vendor_name' || i.field === 'vendor_tax_number'),
    "Bill Details": allIssues.filter(i => ['invoice_number', 'invoice_date', 'due_date', 'currency', 'subtotal', 'tax_amount', 'total_amount', 'wafeq_tax_id'].includes(i.field ?? '')),
    "Line Items": allIssues.filter(i => i.field?.startsWith('line_items') || i.field === 'subtotal_mismatch'),
    "Other": allIssues.filter(i => !i.field?.includes('supplier') && !['vendor_name', 'vendor_tax_number', 'invoice_number', 'invoice_date', 'due_date', 'currency', 'subtotal', 'tax_amount', 'total_amount', 'wafeq_tax_id'].includes(i.field ?? '') && !i.field?.startsWith('line_items') && i.field !== 'subtotal_mismatch')
  };
  const groupedIssuesList = Object.entries(groupedIssues).filter(([_, issuesList]) => issuesList.length > 0);
  const missingAccountIssues = allIssues.filter((issue) =>
    issue.issue_key?.includes("account.unmapped")
    || issue.issue_key?.includes("account_missing")
    || issue.field?.includes("account"),
  );

  const focusIssue = (issue: Issue) => {
    const field = issue.field ?? "";
    const lineMatch = field.match(/^line_items\.(\d+)\.(.+)$/);
    const targetId = lineMatch
      ? lineMatch[2].includes("account")
        ? `input-select-line-account-${lineMatch[1]}`
        : `input-review-line_items.${lineMatch[1]}.${lineMatch[2]}`
      : field
        ? `review-${field}`
        : null;
    if (field.startsWith("line_items")) {
      setLineItemsOpen(true);
      sectionRefs.current.lineItems?.scrollIntoView({ behavior: "smooth", block: "center" });
    } else if (field.includes("supplier")) {
      setBillDetailsOpen(true);
      sectionRefs.current.billDetails?.scrollIntoView({ behavior: "smooth", block: "center" });
    } else if (field.includes("tax") || field.includes("accounting")) {
      setAccountingDetailsOpen(true);
      setBillDetailsOpen(true);
      sectionRefs.current.billDetails?.scrollIntoView({ behavior: "smooth", block: "center" });
    } else {
      setBillDetailsOpen(true);
      sectionRefs.current.billDetails?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    setActiveField(field || null);
    window.setTimeout(() => {
      const target = targetId ? document.getElementById(targetId) : null;
      if (target instanceof HTMLElement) {
        target.focus();
        target.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }, 100);
    trackEvent("invoice_issue_focused", { severity: issue.severity ?? (issue.blocking ? "blocking" : "warning"), field });
  };

  const replaceSource = async (file: File, successTitle: string, failureTitle: string) => {
    setReplacingSource(true);
    try {
      const body = new FormData();
      body.append("file", file);
      body.append("version", String(draft.review_version ?? draft.version));
      const result = await apiFetch<SourceReplacementResponse>(`/api/finance/invoice-review/${id}/source`, { method: "PUT", body });
      const applySuccessfulSource = (current: ReviewResponse | undefined) => {
        if (!current) return current;
        const currentInvoice = current.invoice ?? current.import;
        const updatedInvoice = currentInvoice
          ? { ...currentInvoice, review_version: result.review_version, source_document: result.source_document }
          : currentInvoice;
        return {
          ...current,
          source_document: result.source_document,
          ...(current.invoice ? { invoice: updatedInvoice } : { import: updatedInvoice }),
        };
      };
      qc.setQueryData<ReviewResponse>(["invoice-review", id], applySuccessfulSource);
      await qc.invalidateQueries({ queryKey: ["invoice-review-source", id] });
      setDraft((current) => current ? { ...current, review_version: result.review_version, source_document: result.source_document } : current);
      toast({ title: successTitle });
      try {
        await detail.refetch();
      } finally {
        qc.setQueryData<ReviewResponse>(["invoice-review", id], applySuccessfulSource);
      }
    } catch (error) {
      toast({ title: failureTitle, description: error instanceof Error ? error.message : String(error), variant: "destructive" });
    } finally {
      setReplacingSource(false);
    }
  };

  const chooseSource = () => {
    if (sourceUploadUnavailableReason || replacingSource) return;
    sourceInputRef.current?.click();
  };

  const sourceInput = (successTitle: string, failureTitle: string) => (
    <input
      ref={sourceInputRef}
      type="file"
      className="sr-only"
      data-testid="input-upload-source"
      tabIndex={-1}
      aria-hidden="true"
      accept=".pdf,.jpg,.jpeg,.png,.webp,application/pdf,image/jpeg,image/png,image/webp"
      disabled={Boolean(sourceUploadUnavailableReason) || replacingSource}
      onChange={async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        await replaceSource(file, successTitle, failureTitle);
        event.target.value = "";
      }}
    />
  );

  const field = (key: keyof Invoice, label: string, type = "text") => {
    const isError = allIssues.some((issue) => issue.field === key);
    const isActive = activeField === String(key);

    return (
      <div className="space-y-1.5">
        <Label htmlFor={`review-${key}`} className={cn("text-muted-foreground uppercase tracking-widest text-[10px] font-semibold", isError && "text-destructive")}>{label}</Label>
         <Input
          id={`review-${key}`}
          data-testid={`input-review-${key}`}
          type={type}
          disabled={!canEdit}
           value={key === "currency" ? displayApprovedCurrency(draft[key] as string | null | undefined) : String(draft[key] ?? "")}
          onFocus={() => setActiveField(String(key))}
           onChange={(event) => update(key, key === "currency" ? normalizeApprovedCurrency(event.target.value) : event.target.value)}
          className={cn(
            "bg-background shadow-sm border-transparent hover:border-input focus:border-ring transition-colors",
            isActive && "ring-1 ring-emerald-700 border-emerald-700",
            isError && "border-destructive focus:border-destructive ring-destructive"
          )}
        />
      </div>
    );
  };

  const audit = detail.data?.audit ?? detail.data?.audit_summary ?? [];

  return (
    <main
      className="fixed inset-0 z-50 flex flex-col"
      data-testid="invoice-review-workspace"
      style={{
        '--background': '160 15% 97%',
        '--foreground': '160 40% 15%',
        '--border': '160 15% 85%',
        '--card': '0 0% 100%',
        '--card-foreground': '160 40% 15%',
        '--muted': '160 15% 92%',
        '--muted-foreground': '160 15% 45%',
        '--primary': '160 70% 28%',
        '--primary-foreground': '0 0% 100%',
        '--ring': '160 70% 28%',
        '--radius': '0.5rem',
        backgroundColor: 'hsl(var(--background))',
        color: 'hsl(var(--foreground))'
      } as React.CSSProperties}
    >
      <header data-testid="review-header" className="flex flex-wrap items-center justify-between gap-4 px-6 py-4 bg-card border-b shrink-0 z-10 sticky top-0 shadow-[0_1px_3px_rgba(0,0,0,0.02)]">
        <div className="flex flex-wrap items-center gap-4 min-w-0">
          <Button variant="ghost" size="sm" onClick={() => { if (!dirty || window.confirm("Discard unsaved changes?")) setLocation(`/ai-invoice-import${queueContext ? `?${queueContext}` : ""}`); }} data-testid="button-back-invoice-queue" className="shrink-0 hover:bg-muted/50">
            <ChevronLeft className="size-4 mr-1.5" />
            Queue
          </Button>
          <div className="hidden sm:block h-4 w-px bg-border"></div>
          <div className="min-w-0 flex-1">
            <h1 className="text-base font-semibold leading-none truncate">{draft.vendor_name || "Unknown Supplier"}</h1>
            <p className="text-xs text-muted-foreground mt-1 truncate">Invoice: {draft.invoice_number || draft.original_filename} <Badge data-testid="badge-invoice-lifecycle" variant={lifecycle === "sync_failed" ? "destructive" : lifecycle === "synced" || lifecycle === "ready" ? "default" : "outline"} className={cn("ml-2", (lifecycle === "synced" || lifecycle === "ready") && "bg-emerald-700")}>{lifecycleLabel}</Badge> <span className="opacity-50 mx-1">·</span> {destinationName}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <div className="flex items-center gap-1 border-r pr-4 mr-2">
            <Button variant="ghost" size="icon" className="hover:bg-muted/50" disabled={!neighbors.data?.previous_id} onClick={() => navigate(neighbors.data?.previous_id ?? undefined)} data-testid="button-previous-invoice" title={neighbors.data?.previous_id ? "Previous bill" : "This is the first bill in this queue"} aria-label="Previous bill"><ChevronLeft className="size-4" /></Button>
            <span className="min-w-20 text-center text-xs font-medium" data-testid="text-bill-position">Bill {neighbors.data?.position ?? "—"} of {neighbors.data?.total ?? "—"}</span>
            <Button variant="ghost" size="icon" className="hover:bg-muted/50" disabled={!neighbors.data?.next_id} onClick={() => navigate(neighbors.data?.next_id ?? undefined)} data-testid="button-next-invoice" title={neighbors.data?.next_id ? "Next bill" : "This is the last bill in this queue"} aria-label="Next bill"><ChevronRight className="size-4" /></Button>
          </div>
          <Button size="sm" variant="outline" data-testid="button-save-review" onClick={save} disabled={!canEdit || !dirty || saveMutation.isPending}><Save className="mr-1.5 size-4" />Save</Button>
          <Button size="sm" variant="outline" data-testid="button-reject-invoice" disabled={detail.data?.permissions?.can_reject === false || action.isPending} onClick={() => { const reason = window.prompt("Why are you rejecting this invoice?")?.trim(); if (reason) action.mutate({ action: "reject", version: Number(draft.review_version ?? draft.version), reason }); }}><X className="mr-1.5 size-4" />Reject</Button>
          <div className="relative group">
            <Button size="sm" data-testid="button-approve-invoice" disabled={lifecycle !== "ready" || detail.data?.permissions?.can_approve === false || action.isPending} onClick={async () => {
              let version = Number(draft.review_version ?? draft.version);
              let currentInvoice = draft;
              if (dirty) {
                const saved = await saveMutation.mutateAsync(draft) as { invoice?: Invoice };
                version = Number(saved.invoice?.review_version ?? version + 1);
                currentInvoice = saved.invoice ?? draft;
              }
              const destinationLabel = selectedDestination === "odoo" ? "Odoo" : selectedDestination === "wafeq" ? "Wafeq" : selectedDestination === "manual" ? "manual entry" : "no accounting system";
              if (window.confirm(isExternalDestination
                ? `Approve this invoice for ${destinationLabel} and start accounting sync?`
                : `Approve this invoice with ${destinationLabel}? It will not sync automatically.`)) {
                action.mutate({ action: "approve", version, syncStatus: currentInvoice.sync_status });
              }
            }}>
              <Check className="mr-1.5 size-4 hidden sm:inline" />{isExternalDestination ? "Approve & sync" : "Approve without sync"}
            </Button>
            {lifecycle === "sync_failed" && <Button size="sm" variant="destructive" data-testid="button-retry-sync" disabled={action.isPending || detail.data?.permissions?.can_sync === false} onClick={() => action.mutate({ action: "sync", version: Number(draft.review_version ?? draft.version), syncStatus: "failed" })}><RotateCw className="mr-1.5 size-4" />Retry</Button>}
            {isApprovedAwaitingSync && isExternalDestination && <Button size="sm" data-testid="button-sync-now" disabled={action.isPending || detail.data?.permissions?.can_sync === false} onClick={() => action.mutate({ action: "sync", version: Number(draft.review_version ?? draft.version), syncStatus: "not_requested" })}><RotateCw className="mr-1.5 size-4" />Sync now</Button>}
          </div>
          <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" data-testid="button-options" className="hover:bg-muted/50"><MoreVertical className="size-4" /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {detail.data?.permissions?.can_delete && (
                  <AlertDialogTrigger asChild>
                    <DropdownMenuItem className="text-destructive focus:bg-destructive/10 focus:text-destructive cursor-pointer" data-testid="menu-item-delete">
                      <Trash2 className="size-4 mr-2" /> Delete Invoice
                    </DropdownMenuItem>
                  </AlertDialogTrigger>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete Invoice?</AlertDialogTitle>
                <AlertDialogDescription>
                  {dirty ? "This invoice has unsaved changes. " : ""}
                  This action cannot be undone. This will permanently delete the invoice entry.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" data-testid="button-delete-invoice-confirm" disabled={deleteMutation.isPending} onClick={() => deleteMutation.mutate()}>
                  {deleteMutation.isPending ? "Deleting..." : "Delete"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </header>
      {lifecycle === "ready" && (
        <div className="border-b bg-emerald-50 px-6 py-2 text-sm text-emerald-900" data-testid="banner-ready-to-sync">
           All required checks passed. This bill is ready to sync with {selectedDestination === "odoo" ? "Odoo" : selectedDestination === "wafeq" ? "Wafeq" : "the selected destination"}.
        </div>
      )}
      {lifecycle === "sync_failed" && (
        <div className="flex items-center justify-between gap-4 border-b bg-destructive/10 px-6 py-2 text-sm text-destructive" role="alert" data-testid="banner-sync-failed">
           <span><strong>{selectedDestination === "odoo" ? "Odoo" : "Wafeq"} sync failed.</strong>{draft.error_message ? ` ${draft.error_message}` : " Review the error and retry."}</span>
        </div>
      )}
      {informationalIssues.length > 0 && (
        <Collapsible className="border-b bg-muted/20" data-testid="informational-review-checks">
          <CollapsibleTrigger className="flex w-full items-center gap-2 px-6 py-2 text-xs text-muted-foreground hover:bg-muted/40">
            <ChevronDown className="size-3.5" />
            {informationalIssues.length} informational check{informationalIssues.length === 1 ? "" : "s"}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="space-y-1 px-10 pb-3 text-xs text-muted-foreground">
              {informationalIssues.map((issue, index) => (
                <p key={issue.issue_key ?? String(issue.id ?? index)}>{issue.message}</p>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      <div className="flex flex-col lg:flex-row flex-1 min-h-0 relative">
        <section className="min-h-0 flex flex-col bg-background relative z-10 w-full lg:w-[var(--split)]" style={{ "--split": `${split}%` } as React.CSSProperties}>
          <div data-testid="editor-scroller" className="flex-1 overflow-y-auto pb-32">
            {allIssues.length > 0 && (
              <Collapsible defaultOpen className="shrink-0">
                <div className="bg-amber-50/80 border-b border-amber-200/60 text-amber-900" data-testid="banner-review-exceptions">
                  <CollapsibleTrigger className="flex items-center w-full px-6 py-3 hover:bg-amber-100/50 transition-colors">
                    <AlertTriangle className="size-4 text-amber-600 mr-2" />
                    <span className="font-medium text-sm">
                      {blockingIssues.length} blocking issues, {warningIssues.length} warnings
                    </span>
                    {missingAccountIssues.length > 0 && (
                      <Badge variant="destructive" className="ml-2 gap-1" data-testid="text-missing-account-count">
                        <AlertCircle className="size-3" /> {missingAccountIssues.length} missing account{missingAccountIssues.length === 1 ? "" : "s"}
                      </Badge>
                    )}
                    <span className="ml-2 text-xs text-amber-700/70">
                      {hasBlockingIssues ? "Review unresolved errors before approval." : "Acknowledge warnings before approval."}
                    </span>
                    <ChevronDown className="size-4 ml-auto text-amber-600/50" />
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                     <div className="px-6 pb-4 pt-2 space-y-4">
                       {groupedIssuesList.map(([groupName, groupIssues]) => (
                         <div key={groupName}>
                           <h4 className="text-[10px] font-bold text-amber-800/60 uppercase tracking-wider mb-2">{groupName}</h4>
                           <div className="space-y-2">
                             {groupIssues.map((issue, index) => (
                              <div key={issue.issue_key ?? index} className="flex items-start gap-3 text-sm bg-white border border-amber-100 p-3 rounded-md shadow-[0_1px_2px_rgba(0,0,0,0.02)] transition-colors hover:border-amber-300">
                                 <AlertTriangle className={cn("size-4 mt-0.5 shrink-0", issue.blocking || issue.severity === 'blocking' || issue.severity === 'error' ? "text-red-500" : "text-amber-500")} aria-hidden="true" />
                                  <div className="flex-1">
                                    <p className="font-medium leading-relaxed">{issue.message}</p>
                                   <span className={cn("text-[11px] font-medium", issue.blocking || issue.severity === "blocking" || issue.severity === "error" ? "text-red-700" : "text-amber-700")}>
                                     {issue.blocking || issue.severity === "blocking" || issue.severity === "error" ? "Blocking" : "Warning"}
                                   </span>
                                  </div>
                                 <Button size="sm" variant="outline" className="h-8 shrink-0" data-testid={`button-resolve-issue-${issue.issue_key ?? String(issue.id ?? index)}`} onClick={() => focusIssue(issue)}>
                                   Resolve
                                 </Button>
                                  {!issue.blocking && issue.severity !== "blocking" && issue.severity !== "error" && (
                                     <Button size="sm" variant="ghost" className="h-8 text-amber-700 hover:text-amber-900 hover:bg-amber-100" data-testid={`button-acknowledge-issue-${issue.issue_key ?? String(issue.id ?? index)}`} onClick={(e) => {
                                       e.stopPropagation();
                                       const issueKey = issue.issue_key ?? String(issue.id ?? index);
                                       setAcknowledgedIssueKeys(current => new Set(current).add(issueKey));
                                       apiFetch(`/api/finance/invoice-review/${id}/acknowledge`, { method: "POST", body: JSON.stringify({ issue_key: issueKey, version: draft.review_version }) })
                                         .then(() => { trackEvent("invoice_warning_acknowledged"); return detail.refetch(); })
                                         .catch(() => setAcknowledgedIssueKeys(current => {
                                           const next = new Set(current);
                                           next.delete(issueKey);
                                           return next;
                                         }));
                                     }}>
                                      Acknowledge
                                    </Button>
                                  )}
                               </div>
                             ))}
                           </div>
                         </div>
                       ))}
                     </div>
                  </CollapsibleContent>
                </div>
              </Collapsible>
            )}

           <div className="p-6 max-w-4xl mx-auto space-y-6">
              <div ref={(node) => { sectionRefs.current.billDetails = node; }}>
              <Collapsible open={billDetailsOpen} onOpenChange={setBillDetailsOpen} className="border rounded-xl bg-card shadow-[0_1px_2px_rgba(0,0,0,0.02)] overflow-hidden">
                <CollapsibleTrigger className="flex w-full items-center justify-between p-4 font-semibold hover:bg-muted/30 transition-colors">
                  Bill Details
                  <ChevronDown className="size-4 text-muted-foreground" />
                </CollapsibleTrigger>
                  <CollapsibleContent className="border-t p-5 pt-5">
                    <div data-testid="bill-details-fields" className="space-y-5">
                      <div className="space-y-1.5" data-testid="bill-accounting-supplier">
                        {isWafeq ? (
                      <WafeqSupplierSelect
                        wafeqValue={draft.wafeq_supplier_id ?? null}
                        onChange={(wafeqId) => {
                          setDraft(d => d ? { ...d, wafeq_supplier_id: wafeqId } : d);
                          setDirty(true);
                          setActiveField("wafeq_supplier_id");
                        }}
                        disabled={!canEdit}
                        enabled={isWafeq}
                      />
                        ) : (
                           <LocalSupplierSelect
                             value={draft.supplier_id ?? null}
                             onChange={(supplierId) => {
                               setDraft(d => d ? { ...d, supplier_id: supplierId } : d);
                               setDirty(true);
                               setActiveField("supplier_id");
                             }}
                             disabled={!canEdit}
                             candidates={[
                               ...(createdSupplierOption ? [createdSupplierOption] : []),
                               ...(detail.data?.supplier_candidates ?? detail.data?.candidates ?? []),
                             ]}
                             entityId={draft.entity_id}
                           />
                        )}
                        <div className="flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-center">
                          <p className="text-[11px] text-muted-foreground" data-testid="text-detected-supplier">
                            Detected on invoice: <span className="font-medium text-foreground">{draft.vendor_name || "Not detected"}</span>
                            {draft.vendor_tax_number && <span> · TRN: {draft.vendor_tax_number}</span>}
                            {draft.billing_country && <span> · {draft.billing_country}</span>}
                          </p>
                          {!isWafeq && (
                         <Button
                           type="button"
                           variant="outline"
                           size="sm"
                           className="mb-0.5 shrink-0"
                           disabled={!canEdit || createSupplierMutation.isPending}
                           onClick={openAddSupplier}
                           data-testid="button-add-supplier"
                         >
                           <Plus className="mr-1 size-3.5" /> Add supplier
                         </Button>
                          )}
                        </div>
                      </div>

                      <div data-testid="bill-metadata-row" className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        {field("invoice_number", "Invoice Number")}
                        {field("invoice_date", "Invoice Date", "date")}
                        {field("due_date", "Due Date", "date")}
                      </div>
                      <div data-testid="bill-currency-vat-row" className={cn("grid grid-cols-1 gap-4 sm:grid-cols-2", !isWafeq && "sm:grid-cols-1")}>
                        {field("currency", "Currency")}
                        {isWafeq && (
                          <TaxRateSelect
                         value={draft.wafeq_tax_id ?? null}
                         onChange={updateTaxRate}
                         disabled={!canEdit}
                         taxRates={taxRates}
                         isLoading={taxRatesQuery.isLoading}
                          />
                        )}
                      </div>
                      <div data-testid="bill-reference-row" className="border-t pt-4">
                        {field("manual_accounting_reference", "Reference (optional)")}
                      </div>
                    </div>
                </CollapsibleContent>
              </Collapsible>
              </div>

              <div ref={(node) => { sectionRefs.current.accountingDetails = node; }}>
              <Collapsible open={accountingDetailsOpen} onOpenChange={setAccountingDetailsOpen} className="border rounded-xl bg-card shadow-[0_1px_2px_rgba(0,0,0,0.02)] overflow-hidden">
                <CollapsibleTrigger className="flex w-full items-center justify-between p-4 font-semibold hover:bg-muted/30 transition-colors">
                  Accounting setup
                  <ChevronDown className="size-4 text-muted-foreground" />
                </CollapsibleTrigger>
                <CollapsibleContent className="p-5 pt-0 border-t">
                   <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-5 pt-5">
                     <div className="space-y-1.5">
                       <Label htmlFor="review-accounting-destination" className="text-muted-foreground uppercase tracking-widest text-[10px] font-semibold">Sync destination</Label>
                       <Select value={draft.accounting_destination ?? "automatic"} onValueChange={changeDestination} disabled={!canEdit || syncInProgressOrDone}>
                         <SelectTrigger id="review-accounting-destination" data-testid="select-accounting-destination" className="bg-background">
                           <SelectValue />
                         </SelectTrigger>
                         <SelectContent>
                           <SelectItem value="automatic">Use configured system</SelectItem>
                           <SelectItem value="odoo">Odoo</SelectItem>
                           <SelectItem value="wafeq">Wafeq</SelectItem>
                           <SelectItem value="manual">Manual entry</SelectItem>
                           <SelectItem value="none">No sync</SelectItem>
                           <SelectItem value="undecided">Decide later</SelectItem>
                         </SelectContent>
                       </Select>
                       <p className="text-xs text-muted-foreground">{destinationName}</p>
                       {selectedDestination === "undecided" && <p className="text-xs text-amber-800">This invoice can be approved without syncing. Choose Odoo or Wafeq later, save, and sync it from this review.</p>}
                     </div>
                    {isWafeq && (
                      <div className="space-y-1.5">
                        <Label className="text-muted-foreground uppercase tracking-widest text-[10px] font-semibold">Bill Default Account</Label>
                        <WafeqAccountSelect
                          value={draft.wafeq_account_id ?? null}
                          onChange={(id) => update("wafeq_account_id", id)}
                          disabled={!canEdit}
                          enabled={isWafeq}
                        />
                      </div>
                    )}
                  </div>
                </CollapsibleContent>
              </Collapsible>
              </div>

              <div ref={(node) => { sectionRefs.current.lineItems = node; }} className="space-y-3 pt-2">
                <div className="flex flex-wrap items-center justify-between gap-2 px-1">
                  <h3 className="font-semibold">Line Items</h3>
                  {isWafeq && canEdit && (
                    <div className="flex items-center gap-2">
                      <WafeqAccountSelect
                        value={bulkAccount?.id}
                        code={bulkAccount?.code}
                        name={bulkAccount?.name}
                        onChange={(id, code, name) => setBulkAccount({ id, code, name })}
                        disabled={!canEdit}
                        enabled={isWafeq}
                        testId="select-bulk-account"
                      />
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={!bulkAccount || (draft.line_items ?? []).length === 0}
                        onClick={() => setBulkAccountDialogOpen(true)}
                        data-testid="button-apply-account-all"
                      >
                        Apply to all lines
                      </Button>
                    </div>
                  )}
                </div>
                <div className="border rounded-xl overflow-hidden bg-card shadow-[0_1px_2px_rgba(0,0,0,0.02)] overflow-x-auto">
                  <table className="w-full text-sm min-w-[600px]">
                    <thead className="bg-muted/40 border-b">
                      <tr>
                        <th className="px-3 py-2.5 text-left font-semibold uppercase tracking-wider text-[10px] text-muted-foreground">Description</th>
                        <th className="px-3 py-2.5 text-right font-semibold uppercase tracking-wider text-[10px] text-muted-foreground w-20">Qty</th>
                        <th className="px-3 py-2.5 text-right font-semibold uppercase tracking-wider text-[10px] text-muted-foreground w-24">Price</th>
                        <th className="px-3 py-2.5 text-right font-semibold uppercase tracking-wider text-[10px] text-muted-foreground w-24">Total</th>
                        {isWafeq && <th className="px-3 py-2.5 text-left font-semibold uppercase tracking-wider text-[10px] text-muted-foreground w-56">Wafeq Account</th>}
                        <th className="px-3 py-2.5 w-10"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-border/50">
                      {(draft.line_items ?? []).map((line, index) => (
                        <tr key={index} className="focus-within:bg-muted/20 transition-colors group" onClick={() => setActiveField(`line_items.${index}`)}>
                          <td className="p-1">
                            <Input data-testid={`input-review-line_items.${index}.description`} className={cn("h-8 border-transparent hover:border-input focus:border-ring shadow-none rounded-md bg-transparent", !line.description && "border-destructive/30")} value={line.description} onChange={(e) => updateLine(index, { description: e.target.value })} disabled={!canEdit} placeholder="Description" />
                          </td>
                          <td className="p-1">
                            <Input type="number" className="h-8 text-right border-transparent hover:border-input focus:border-ring shadow-none rounded-md bg-transparent px-2" value={line.quantity} onChange={(e) => updateLine(index, { quantity: e.target.value as any })} disabled={!canEdit} />
                          </td>
                          <td className="p-1">
                            <Input type="number" className="h-8 text-right border-transparent hover:border-input focus:border-ring shadow-none rounded-md bg-transparent px-2" value={line.unit_price} onChange={(e) => updateLine(index, { unit_price: e.target.value as any })} disabled={!canEdit} />
                          </td>
                          <td className="p-1 px-3 text-right text-muted-foreground font-medium">
                            {money(line.total)}
                          </td>
                          {isWafeq && (
                            <td className="p-1 relative">
                              <WafeqAccountSelect value={line.wafeq_account_id} code={line.account_code} name={line.account_name} onChange={(id, code, name) => updateLine(index, { wafeq_account_id: id, account_code: code, account_name: name })} disabled={!canEdit} enabled={isWafeq} testId={`select-line-account-${index}`} />
                              {!line.wafeq_account_id && !draft.wafeq_account_id && (
                                <span className="absolute right-8 top-1/2 -translate-y-1/2 pointer-events-none flex items-center gap-1 text-[10px] text-destructive font-medium" title="Account mapping required">
                                  <AlertCircle className="size-3.5 text-destructive" aria-hidden="true" />
                                  <span className="sr-only">Missing account mapping</span>
                                </span>
                              )}
                            </td>
                          )}
                          <td className="p-1 text-center">
                            <Button variant="ghost" size="icon" className="size-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10" onClick={(e) => { e.stopPropagation(); reconcileLines((draft.line_items ?? []).filter((_, i) => i !== index)); }} disabled={!canEdit} data-testid={`button-remove-line-${index}`}>
                              <Trash2 className="size-3.5" />
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="p-1.5 border-t bg-muted/10">
                    <Button variant="ghost" size="sm" className="h-8 text-emerald-700 hover:text-emerald-800 hover:bg-emerald-700/10 font-medium" onClick={() => reconcileLines([...(draft.line_items ?? []), { description: "", quantity: 1, unit_price: 0, total: 0 }])} disabled={!canEdit} data-testid="button-add-line">
                      <Plus className="size-3.5 mr-1.5" /> Add Line Item
                    </Button>
                  </div>
                </div>
              </div>

              {audit.length > 0 && (
                <Collapsible className="mt-8 border-t pt-6">
                  <CollapsibleTrigger className="flex items-center text-sm font-medium text-muted-foreground hover:text-foreground">
                    <History className="size-4 mr-2" />
                    Activity History
                    <ChevronDown className="size-4 ml-2 opacity-50" />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="mt-4 space-y-4 px-2">
                    {audit.map(a => (
                      <div key={a.id} className="text-sm flex gap-3 text-muted-foreground items-start">
                         <div className="w-1.5 h-1.5 rounded-full bg-border mt-1.5 shrink-0" />
                         <div>
                           <span className="text-foreground font-medium">{a.actor_id}</span> {a.event_type.replace(/_/g, ' ')}
                           <div className="text-[11px] opacity-70 mt-0.5">{new Date(a.created_at).toLocaleString()}</div>
                         </div>
                      </div>
                    ))}
                  </CollapsibleContent>
                </Collapsible>
              )}
            </div>
          </div>

          <div data-testid="reconciliation-surface" className="sticky bottom-0 lg:absolute left-0 right-0 bg-card/95 backdrop-blur-md border-t p-4 sm:p-5 shadow-[0_-10px_30px_rgba(0,0,0,0.05)] z-20 flex flex-col sm:flex-row justify-between items-end sm:items-center gap-4">
            <div className="text-sm text-muted-foreground max-w-sm leading-relaxed">
               <p className="hidden xl:block">Review line items and verify the bill-level tax treatment before approving.</p>
                 <div className={cn("mt-1 flex items-center gap-1.5 text-xs font-medium", liveReconciliation.status === "match" ? "text-emerald-700" : liveReconciliation.status === "mismatch" ? "text-destructive" : "text-amber-700")} data-testid="text-source-reconciliation">
                 {liveReconciliation.status === "match" ? <Check className="size-3.5" aria-hidden="true" /> : <AlertCircle className="size-3.5" aria-hidden="true" />}
                 {liveReconciliation.status === "match"
                   ? `Source total matches (${money(liveReconciliation.source_total)})`
                   : liveReconciliation.status === "mismatch"
                     ? `Source total mismatch by ${money(Math.abs(liveReconciliation.difference ?? 0))}`
                     : "Source total pending verification"}
               </div>
            </div>
            <div className="flex flex-wrap items-center gap-6 sm:gap-8 ml-auto">
              <div className="flex flex-col gap-1.5 items-end">
                 <Label className="text-[10px] text-muted-foreground uppercase tracking-widest font-semibold">Subtotal</Label>
                 <div className="flex items-center gap-2">
                    {originalSubtotal != null && number(draft.subtotal) !== originalSubtotal && (
                      <span className="text-xs text-muted-foreground line-through decoration-destructive/50" title="Extracted original">
                        {money(originalSubtotal)}
                      </span>
                    )}
                    <Input type="number" data-testid="input-review-subtotal" className="w-24 sm:w-28 h-8 text-right bg-transparent border-transparent hover:border-input focus:border-ring shadow-none font-medium text-base px-2" value={draft.subtotal ?? ""} onChange={e => update("subtotal", e.target.value)} disabled={!canEdit} onFocus={() => setActiveField("subtotal")} />
                 </div>
              </div>
              <div className="flex flex-col gap-1.5 items-end">
                 <Label className="text-[10px] text-muted-foreground uppercase tracking-widest font-semibold">Tax Amount</Label>
                 <div className="flex items-center gap-2">
                    {originalTax != null && number(draft.tax_amount) !== originalTax && (
                      <span className="text-xs text-muted-foreground line-through decoration-destructive/50" title="Extracted original">
                        {money(originalTax)}
                      </span>
                    )}
                    <Input type="number" data-testid="input-review-tax_amount" className={cn("w-24 sm:w-28 h-8 text-right bg-transparent border-transparent hover:border-input focus:border-ring shadow-none font-medium text-base px-2", isWafeq && "opacity-80 pointer-events-none hover:border-transparent")} value={draft.tax_amount ?? ""} onChange={e => !isWafeq && update("tax_amount", e.target.value)} disabled={!canEdit} readOnly={isWafeq} onFocus={() => setActiveField("tax_amount")} />
                 </div>
              </div>
              <div className="flex flex-col gap-1.5 items-end pl-4 sm:pl-6 border-l">
                 <Label className="text-[10px] text-foreground uppercase tracking-widest font-semibold">Total Amount</Label>
                 <div className="flex items-center gap-2">
                    {originalTotal != null && number(draft.total_amount) !== originalTotal && (
                      <span className="text-xs text-muted-foreground line-through decoration-destructive/50 mr-1" title="Extracted original">
                        {money(originalTotal)}
                      </span>
                    )}
                    <Input type="number" data-testid="input-review-total_amount" className={cn("w-28 sm:w-32 h-9 text-right font-bold text-lg bg-emerald-700/10 text-emerald-900 border-transparent shadow-inner rounded-md px-2", isWafeq && "opacity-90 pointer-events-none focus:outline-none")} value={draft.total_amount ?? ""} onChange={e => !isWafeq && update("total_amount", e.target.value)} disabled={!canEdit} readOnly={isWafeq} onFocus={() => setActiveField("total_amount")} />
                 </div>
              </div>
            </div>
          </div>
        </section>

        <div
          className="hidden lg:flex w-1.5 cursor-col-resize bg-border/50 hover:bg-emerald-700/50 transition-colors flex-shrink-0 z-20"
          onPointerDown={(e) => {
            const startX = e.clientX;
            const startSplit = split;
            const onPointerMove = (ev: PointerEvent) => {
              const delta = ev.clientX - startX;
              const newSplit = Math.max(20, Math.min(80, startSplit + (delta / window.innerWidth) * 100));
              setSplit(newSplit);
            };
            const onPointerUp = () => {
              window.removeEventListener("pointermove", onPointerMove);
              window.removeEventListener("pointerup", onPointerUp);
              document.body.style.userSelect = '';
            };
            document.body.style.userSelect = 'none';
            window.addEventListener("pointermove", onPointerMove);
            window.addEventListener("pointerup", onPointerUp);
          }}
        />

        <section data-testid="source-panel" className="min-h-[50vh] lg:min-h-0 flex-1 flex flex-col relative bg-muted/20 min-w-full lg:min-w-[300px] border-t lg:border-t-0" style={{ width: `var(--viewer-width)` } as React.CSSProperties}>
          <style>{`@media (min-width: 1024px) { section { --viewer-width: ${100 - split}%; } } @media (max-width: 1023px) { section { --viewer-width: 100%; } }`}</style>

          <div className="absolute right-4 top-4 z-10 flex max-w-[calc(100%-2rem)] flex-wrap items-center justify-end gap-2 rounded-lg bg-background/90 p-1 shadow-sm backdrop-blur" role="toolbar" aria-label="Source document controls" data-testid="source-document-toolbar">
            {source?.page_count && source.page_count > 1 ? (
              <div className="flex items-center bg-background rounded-md shadow-sm opacity-80 hover:opacity-100 mr-2 border">
                <Button size="icon" variant="ghost" className="size-8" disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))} title="Previous page" data-testid="button-previous-source-page"><ChevronUp className="size-4" /></Button>
                <span className="text-[11px] px-1 min-w-[3rem] text-center font-medium">{page} / {source.page_count}</span>
                <Button size="icon" variant="ghost" className="size-8" disabled={page >= source.page_count} onClick={() => setPage(p => Math.min(source.page_count!, p + 1))} title="Next page" data-testid="button-next-source-page"><ChevronDown className="size-4" /></Button>
              </div>
            ) : null}

            {(isImage || isPdf) && (
              <>
                <Button size="icon" variant="secondary" className="shadow-sm opacity-80 hover:opacity-100 bg-background" onClick={() => setZoom((z) => Math.max(50, z - 25))} data-testid="button-zoom-out" title="Zoom out"><Minus className="size-4" /><span className="sr-only">Zoom out</span></Button>
                <Button size="icon" variant="secondary" className="shadow-sm opacity-80 hover:opacity-100 bg-background" onClick={() => setZoom((z) => Math.min(200, z + 25))} data-testid="button-zoom-in" title="Zoom in"><Plus className="size-4" /><span className="sr-only">Zoom in</span></Button>
                <Button size="icon" variant="secondary" className="shadow-sm opacity-80 hover:opacity-100 bg-background" onClick={() => { setFit(!fit); setZoom(100); }} data-testid="button-fit-document" title={fit ? "Original size" : "Fit to width"}>{fit ? <span className="text-[10px] font-bold">1:1</span> : <span className="text-[10px] font-bold">FIT</span>}</Button>
                <Button size="icon" variant="secondary" className="shadow-sm opacity-80 hover:opacity-100 bg-background" onClick={() => setRotation((r) => (r + 90) % 360)} data-testid="button-rotate-document" title="Rotate"><RotateCw className="size-4" /><span className="sr-only">Rotate</span></Button>
              </>
            )}
            {sourceKnownAvailable && sourceInput("Source attachment replaced", "Could not replace source attachment")}
            <Button size="icon" variant="secondary" className="shadow-sm opacity-80 hover:opacity-100 bg-background" data-testid="button-replace-source" disabled={Boolean(sourceUploadUnavailableReason) || replacingSource} onClick={chooseSource} title={sourceUploadUnavailableReason ?? "Replace source"}><Upload className="size-4" /><span className="sr-only">Replace source</span></Button>
            {viewerUrl && (
              <>
                <Button size="icon" variant="secondary" className="shadow-sm opacity-80 hover:opacity-100 bg-background" asChild title="Download"><a data-testid="link-download-source" href={viewerUrl} download={draft.original_filename ?? "invoice"}><Download className="size-4" /><span className="sr-only">Download</span></a></Button>
                <Button size="icon" variant="secondary" className="shadow-sm opacity-80 hover:opacity-100 bg-background" asChild title="Open in new tab"><a data-testid="link-open-source" href={viewerUrl} target="_blank" rel="noreferrer"><ExternalLink className="size-4" /><span className="sr-only">Open in new tab</span></a></Button>
              </>
            )}
          </div>

          <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-muted/10">
            {sourceBlob.isError ? (
              <div className="flex flex-1 flex-col items-center justify-center p-8 text-center text-muted-foreground" data-testid="source-load-error">
                <AlertTriangle className="mb-3 size-10 opacity-20" />
                <p className="mb-5">Source document could not be loaded.</p>
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <Button variant="outline" size="sm" data-testid="button-retry-source" onClick={() => sourceBlob.refetch()}>Retry</Button>
                </div>
              </div>
            ) : (sourceBlob.isPending && sourceKnownAvailable) ? (
              <div className="flex flex-1 flex-col items-center justify-center p-8 text-center text-muted-foreground" data-testid="source-loading">
                <Loader2 className="mb-3 size-10 animate-spin opacity-20" />
                <p className="mb-5">Loading source document...</p>
              </div>
            ) : sourceRenderFailed ? (
              <div className="flex flex-1 flex-col items-center justify-center p-8 text-center text-muted-foreground" data-testid="source-render-error">
                <AlertTriangle className="mb-3 size-10 opacity-20" />
                <p className="mb-5">Unable to render source document.</p>
                <div className="flex flex-wrap items-center justify-center gap-2">
                  <Button variant="outline" size="sm" data-testid="button-retry-source-render" onClick={() => setSourceRenderFailed(false)}>Retry</Button>
                </div>
              </div>
            ) : (!sourceKnownAvailable && !sourceObjectUrl) ? (
              <div className="flex flex-1 flex-col items-center justify-center p-8 text-center text-muted-foreground" data-testid="source-unavailable">
                <AlertTriangle className="mb-3 size-10 opacity-20" />
                <p className="mb-5">{sourceUploadUnavailableReason ?? "Source document not available."}</p>
                {!sourceKnownAvailable && sourceInput("Source attachment restored", "Could not store source attachment")}
                <Button data-testid="button-upload-source" disabled={Boolean(sourceUploadUnavailableReason) || replacingSource} onClick={chooseSource}><Upload className="mr-2 size-4" />Upload source</Button>
              </div>
            ) : (
              <>
                <div className="flex-1 overflow-auto p-4" onClick={() => setActiveField(null)}>
                  <div className="relative mx-auto transition-transform" style={{ width: fit ? "100%" : `${zoom}%`, transform: `rotate(${rotation}deg)` }}>
                    {isPdf ? (
                      <object data={`${viewerUrl ?? ""}#page=${page}`} type="application/pdf" className="aspect-[1/1.4] w-full rounded-sm shadow bg-white" data-testid="viewer-pdf" onError={() => setSourceRenderFailed(true)}>
                        <div className="flex flex-col items-center justify-center p-8 text-center text-muted-foreground bg-white w-full h-full">
                           <AlertTriangle className="mb-3 size-10 opacity-20" />
                           <p className="mb-2">Unable to display PDF.</p>
                           <a href={viewerUrl ?? "#"} download className="underline text-emerald-700">Download it instead</a>
                        </div>
                      </object>
                    ) : isImage ? (
                      <img src={viewerUrl ?? ""} alt="Source document" className="w-full rounded-sm shadow bg-white" data-testid="viewer-image" onError={() => setSourceRenderFailed(true)} />
                    ) : (
                      <div className="flex aspect-[1/1.4] w-full flex-col items-center justify-center rounded-sm bg-white shadow text-muted-foreground" data-testid="source-unsupported">
                        <AlertTriangle className="mb-3 size-10 opacity-20" />
                        <p>Document format not supported for preview.</p>
                        <a href={viewerUrl ?? "#"} download className="mt-2 underline text-emerald-700">Download</a>
                      </div>
                    )}
                    {coordinates && Object.entries(evidence).map(([key, region]) => region && (!region.page || region.page === page) ? <button key={key} type="button" data-testid={`overlay-region-${key}`} onClick={(event) => { event.stopPropagation(); setActiveField(key); }} className={cn("absolute rounded border-2 transition-colors", activeField === key ? "border-emerald-500 bg-emerald-500/20 z-20" : "border-emerald-500/40 bg-emerald-500/10 hover:border-emerald-500/60 z-10")} style={{ left: `${region.x * 100}%`, top: `${region.y * 100}%`, width: `${region.width * 100}%`, height: `${region.height * 100}%` }} title={`Extraction region for ${key}`} /> : null)}
                  </div>
                </div>
                {!coordinates && <div className="border-t bg-muted/50 p-2 text-center text-xs text-muted-foreground" data-testid="text-no-coordinates">Source coordinates are not available for this extraction.</div>}
              </>
            )}
            {sourceUploadUnavailableReason && <div className="border-t bg-amber-50 p-2 text-center text-xs text-amber-800" data-testid="text-source-upload-unavailable">{sourceUploadUnavailableReason}</div>}
          </div>
        </section>
      </div>
      <AlertDialog open={bulkAccountDialogOpen} onOpenChange={setBulkAccountDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apply account to every line?</AlertDialogTitle>
            <AlertDialogDescription>
              This will overwrite the account mapping on all {draft.line_items?.length ?? 0} line items with {bulkAccount?.code} — {bulkAccount?.name}. You can still change individual lines afterward.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={applyBulkAccount} data-testid="button-confirm-apply-account-all">
              Apply to all lines
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
       <Dialog open={addSupplierOpen} onOpenChange={setAddSupplierOpen}>
         <DialogContent className="max-w-md">
           <DialogHeader>
             <DialogTitle>Add local supplier</DialogTitle>
             <DialogDescription>
               Create a workspace supplier from the extracted invoice details. It will be linked to this invoice after saving.
             </DialogDescription>
           </DialogHeader>
           <div className="grid gap-3 py-2">
             {([
               ["name", "Supplier name", "text"],
               ["tax_number", "VAT / TRN", "text"],
               ["country", "Country", "text"],
               ["contact_phone", "Phone", "tel"],
               ["contact_email", "Email", "email"],
             ] as const).map(([key, label, type]) => (
               <div key={key} className="grid gap-1.5">
                 <Label htmlFor={`new-supplier-${key}`}>{label}{key === "name" ? " *" : ""}</Label>
                 <Input
                   id={`new-supplier-${key}`}
                   type={type}
                   value={newSupplier[key]}
                   onChange={(event) => setNewSupplier(current => ({ ...current, [key]: event.target.value }))}
                   data-testid={`input-new-supplier-${key}`}
                 />
               </div>
             ))}
             <div className="grid gap-1.5">
               <Label htmlFor="new-supplier-billing-address">Address</Label>
               <Textarea
                 id="new-supplier-billing-address"
                 value={newSupplier.billing_address}
                 onChange={(event) => setNewSupplier(current => ({ ...current, billing_address: event.target.value }))}
                 rows={2}
                 data-testid="input-new-supplier-billing_address"
               />
             </div>
           </div>
           <DialogFooter>
             <Button type="button" variant="outline" onClick={() => setAddSupplierOpen(false)} disabled={createSupplierMutation.isPending}>Cancel</Button>
             <Button
               type="button"
               onClick={() => createSupplierMutation.mutate(newSupplier)}
               disabled={!newSupplier.name.trim() || createSupplierMutation.isPending}
               data-testid="button-create-supplier"
             >
               {createSupplierMutation.isPending ? <><Loader2 className="mr-2 size-4 animate-spin" />Saving...</> : "Create and link"}
             </Button>
           </DialogFooter>
         </DialogContent>
       </Dialog>
    </main>
  );
}