import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useAuthedSse } from "@/hooks/use-authed-sse";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  Upload,
  FileText,
  CheckCircle2,
  AlertTriangle,
  Clock,
  XCircle,
  ChevronRight,
  ChevronDown,
  Plus,
  Settings,
  Download,
  RefreshCw,
  RotateCw,
  Building2,
  Trash2,
  ExternalLink,
  Check,
  Send,
  Loader2,
  Pencil,
  X,
  Save,
  BadgeCheck,
  History,
  Eye,
  FileSearch,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from "@/components/ui/collapsible";
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
import { ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { useWorkspaceRole } from "@/hooks/use-workspace-role";
import { CountryCombobox } from "@/components/CountryCombobox";
import {
  COUNTRY_CATALOGUE,
  EXCLUDED_COUNTRY_NAMES,
  getCountryMetadataByCode,
  type CountryEntry,
} from "@/lib/countries";
import { apiFetch } from "@/lib/queryClient";
import { useLocation } from "wouter";

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

const SUPPORTED_UPLOAD_EXTS = new Set([".pdf", ".jpg", ".jpeg", ".png", ".webp"]);
const SUPPORTED_UPLOAD_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

type FinanceEntity = {
  id: number;
  legal_name: string;
  display_name: string | null;
  country: string | null;
  tax_registration_number: string | null;
  accounting_system: string;
  odoo_base_url: string | null;
  odoo_company_name: string | null;
  odoo_company_id: number | null;
  odoo_database: string | null;
  default_currency: string;
  odoo_default_expense_account_id: number | null;
  is_active: boolean;
  odoo_integration_configured: boolean;
  invoice_review_enabled?: boolean;
};

type InvoiceImport = {
  id: number;
  entity_id: number;
  status: string;
  original_filename: string | null;
  vendor_name: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  currency: string | null;
  total_amount: string | null;
  subtotal: string | null;
  tax_amount: string | null;
  confidence: string | null;
  company_validation_status: string | null;
  company_validation_notes: string | null;
  odoo_bill_url: string | null;
  odoo_bill_id: string | null;
  error_message: string | null;
  created_at: string;
  entity_legal_name: string;
  entity_accounting_system: string;
  line_items: LineItem[];
  vendor_address: string | null;
  vendor_tax_number: string | null;
  manually_entered_at: string | null;
  manual_accounting_reference: string | null;
  is_reviewed: boolean;
  reviewed_at: string | null;
  processing_step: string;
  review_version?: number;
  supplier_id: number | null;
  supplier_name: string | null;
  sync_status?: string;
  supplier_confirmation?: {
    vendor_name?: string | null;
    candidates?: OdooSupplierCandidate[];
  } | null;
  billing_country: string | null;
  source?: string | null;
  scanner_station_id?: number | null;
  scanner_station_name?: string | null;
  captured_at?: string | null;
  uploaded_at?: string | null;
  review_status?: string;
  issue_count?: number;
  blocking_issue_count?: number;
  warning_issue_count?: number;
  blocking_issue_messages?: string[];
  issue_fields?: string[];
  issue_label?: string | null;
  display_state?: "processing" | "needs_review" | "ready_to_sync" | "sync_failed" | "succeeded" | "rejected";
  raw_status?: string;
  accounting_destination?: string | null;
  provider_sync_error?: string | null;
  entity_display_name?: string | null;
  source_document?: {
    available: boolean;
    url: string | null;
  };
  invoice_review_enabled?: boolean;
};

type OdooSupplierCandidate = {
  id: number;
  name: string;
  display_name?: string | null;
  tax_number?: string | null;
  score: number;
};

type OdooBulkResult = {
  success: boolean;
  selected: number;
  synced: number;
  failed: number;
  skipped: number;
  blocked?: number;
  needs_supplier_confirmation?: number;
  confirmations?: BulkSupplierConfirmation[];
  created?: number;
  recovered?: number;
  verified_existing?: number;
  stale_repaired?: number;
  reason_breakdown?: Record<string, number>;
  has_more: boolean;
  next_after_id: number;
  results?: Array<{
    invoice_id: number;
    status: "succeeded" | "failed" | "skipped" | "blocked" | "needs_supplier_confirmation";
    external_reference?: string;
    error?: string;
    reason_code?: string;
    outcome?: string;
    stale_local_state?: boolean;
  }>;
};

type BulkSupplierConfirmation = {
  invoice_id: number;
  invoice_number: string | null;
  vendor_name: string | null;
  suggested_supplier: OdooSupplierCandidate | null;
  candidates: OdooSupplierCandidate[];
};

type BulkConfirmationResult = {
  success: boolean;
  processed: number;
  synced: number;
  recovered: number;
  needs_supplier_confirmation: number;
  blocked: number;
  failed: number;
  results: Array<{
    invoice_id: number;
    status: "succeeded" | "blocked" | "failed" | "needs_supplier_confirmation";
    outcome?: string;
    error?: string;
  }>;
};

type OdooIssue = {
  id: number;
  entity_id: number;
  entity_legal_name: string;
  entity_display_name: string | null;
  review_status: string;
  review_version: number;
  effective_sync_status: "failed" | "blocked" | "needs_supplier_confirmation";
  invoice_number: string | null;
  invoice_date: string | null;
  vendor_name: string | null;
  vendor_tax_number: string | null;
  vendor_address: string | null;
  currency: string | null;
  subtotal: string | null;
  tax_amount: string | null;
  total_amount: string | null;
  supplier_id: number | null;
  provider_bill_id: string | null;
  provider_bill_url: string | null;
  provider_sync_error: string | null;
  error_message: string | null;
  issue_message: string;
  issue_type: string;
  suggested_action: string;
  supplier_confirmation?: {
    vendor_name?: string | null;
    candidates?: OdooSupplierCandidate[];
  } | null;
  os_supplier_name: string | null;
  os_supplier_display_name: string | null;
  os_supplier_tax_number: string | null;
  os_odoo_partner_id: number | null;
};

type LineItem = {
  description: string;
  quantity: number;
  unit_price: number;
  total: number;
  tax_rate?: number;
};

type ApprovalWarning = {
  invoiceId: number;
  invoiceLabel: string;
  issueKey: string;
  message: string;
  version: number;
};

type ApprovalDetail = {
  invoice?: { review_version?: number };
  import?: { review_version?: number };
  validation?: { issues?: Array<{ issue_key?: string; message?: string; blocking?: boolean; severity?: string }> };
  acknowledgements?: Array<{ issue_key: string; version?: number }>;
};

function getEntityNameByCountry(billingCountry: string | null | undefined, fallback: string): string {
  switch (billingCountry) {
    case "LB": return "Presentail SAL";
    case "CY": return "Presentail LTD";
    case "AE": return "Presentail Flowers Trading";
    default: return fallback;
  }
}

type InvoiceImportEdit = {
  id: number;
  import_id: number;
  changed_by: string;
  changed_by_name: string;
  changed_at: string;
  before_values: Record<string, unknown>;
  after_values: Record<string, unknown>;
};

const STATUS_CONFIG: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" | "warning" | "success"; icon: React.ElementType; className?: string }> = {
  uploaded: { label: "Uploaded", variant: "secondary", icon: Clock },
  processing: { label: "Processing", variant: "secondary", icon: RefreshCw },
  extracted: { label: "Extracted", variant: "default", icon: CheckCircle2 },
  sent_to_odoo: { label: "Sent to Odoo", variant: "default", icon: CheckCircle2 },
  ready_for_manual_entry: { label: "Ready for Entry", variant: "outline", icon: FileText },
  manually_entered: { label: "Entered", variant: "default", icon: Check },
  not_reviewed: { label: "Not reviewed", variant: "secondary", icon: Clock },
  needs_review: { label: "Needs review", variant: "warning", icon: AlertTriangle },
  ready_to_sync: { label: "Ready to sync", variant: "success", icon: CheckCircle2 },
  approved: { label: "Approved", variant: "success", icon: CheckCircle2 },
  rejected: { label: "Rejected", variant: "destructive", icon: XCircle },
};

const SYNCED_BADGE_CLASS_NAME = "border-green-200 bg-green-50 text-green-800 dark:border-green-800 dark:bg-green-950 dark:text-green-200";

const SYNC_STATUS_CONFIG: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" | "warning" | "success"; className?: string }> = {
  not_requested: { label: "Not synced", variant: "secondary" },
  pending: { label: "Syncing", variant: "secondary" },
  in_progress: { label: "Syncing", variant: "secondary" },
  succeeded: {
    label: "Synced",
    variant: "success",
    className: SYNCED_BADGE_CLASS_NAME,
  },
  failed: { label: "Failed", variant: "destructive" },
  blocked: { label: "Blocked", variant: "warning" },
  needs_supplier_confirmation: { label: "Confirm supplier", variant: "warning" },
};

function StatusBadge({ status, config = STATUS_CONFIG }: { status: string; config?: Record<string, { label: string; variant: string; icon?: React.ElementType; className?: string }> }) {
  const cfg = config[status] ?? { label: status, variant: "secondary" as const, icon: Clock };
  const Icon = cfg.icon;
  return (
    <Badge variant={cfg.variant as "default" | "secondary" | "destructive" | "outline"} className={cn("gap-1 text-xs whitespace-nowrap", cfg.className)}>
      {Icon && <Icon className="h-3 w-3" />}
      {cfg.label}
    </Badge>
  );
}

function formatCurrency(amount: string | null, currency: string | null) {
  if (!amount) return "—";
  const n = parseFloat(amount);
  if (isNaN(n)) return amount;
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currency ?? "USD",
    minimumFractionDigits: 2,
  }).format(n);
}

export function formatApprovedCurrency(currency: string | null | undefined): string {
  const normalized = String(currency ?? "").trim().toUpperCase();
  return normalized === "LBP" || normalized === "LEBANESE POUND" || currency?.trim() === "ل.ل"
    ? "Lebanese Pound / ل.ل"
    : currency ?? "";
}

function parseOptionalPositiveInteger(value: string): number | null | undefined {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export type InvoiceQueueFilter = "all" | "ready_to_sync" | "succeeded" | "failed" | "blocked" | "needs_supplier_confirmation" | "not_requested" | "pending" | "in_progress";

export type InvoiceQueueTab = "all" | "needs_review" | "ready_to_sync" | "sync_failed" | "succeeded";
export function buildInvoiceQueueQuery({
  entityId,
  reviewStatus,
  syncStatus,
  dateFrom,
  dateTo,
  search,
  page,
  pageSize = 50,
  tab = "all",
  order = "created_at_desc",
}: {
  entityId?: number | null;
  reviewStatus?: string;
  syncStatus: InvoiceQueueFilter;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
  page: number;
  pageSize?: number;
  tab?: InvoiceQueueTab;
  order?: "created_at_desc" | "invoice_date_asc" | "invoice_date_desc" | "attention_first";
}): URLSearchParams {
  const query = new URLSearchParams({ limit: String(pageSize), offset: String(page * pageSize) });
  if (entityId) query.set("entity_id", String(entityId));
  if (syncStatus === "ready_to_sync") {
    query.set("review_status", "approved");
    query.set("sync_status", "not_requested");
  } else {
    if (reviewStatus && reviewStatus !== "all") query.set("review_status", reviewStatus);
    if (syncStatus !== "all") query.set("sync_status", syncStatus);
  }
  if (dateFrom) query.set("date_from", dateFrom);
  if (dateTo) query.set("date_to", dateTo);
  if (search?.trim()) query.set("search", search.trim());
  if (tab !== "all") query.set("tab", tab);
  if (order !== "created_at_desc") query.set("order", order);
  return query;
}

function formatDate(d: string | null) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString(undefined, { dateStyle: "medium" });
}

function ConfidenceBadge({ confidence }: { confidence: string | null }) {
  if (!confidence) return null;
  const pct = Math.round(parseFloat(confidence) * 100);
  const color = pct >= 85 ? "text-green-600" : pct >= 60 ? "text-yellow-600" : "text-red-600";
  return <span className={`text-xs font-medium ${color}`}>{pct}% confidence</span>;
}

const DEFAULT_COUNTRY_OPTIONS: readonly CountryEntry[] = COUNTRY_CATALOGUE.filter(
  (c) => !EXCLUDED_COUNTRY_NAMES.includes(c.name),
);

const EMPTY_ENTITY_FORM = {
  legal_name: "",
  display_name: "",
  country: "",
  tax_registration_number: "",
  accounting_system: "none",
  default_currency: "USD",
  odoo_base_url: "",
  odoo_database: "",
  odoo_company_name: "",
  odoo_company_id: "",
  odoo_integration_token: "",
  odoo_default_expense_account_id: "",
};

function NewEntityDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (e: FinanceEntity) => void }) {
  const { toast } = useToast();

  const settingsQuery = useQuery<{ available_countries?: string[] }>({
    queryKey: ["workspace-settings"],
    queryFn: () => apiFetch<{ available_countries?: string[] }>("/api/settings"),
    staleTime: 60_000,
  });

  const filteredCountries = useMemo<readonly CountryEntry[]>(() => {
    const available = settingsQuery.data?.available_countries;
    if (!available || available.length === 0) return DEFAULT_COUNTRY_OPTIONS;
    const nameSet = new Set(available.map((n) => n.toLowerCase()));
    return DEFAULT_COUNTRY_OPTIONS.filter((c) => nameSet.has(c.name.toLowerCase()));
  }, [settingsQuery.data]);

  const [form, setForm] = useState(EMPTY_ENTITY_FORM);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) {
      setForm(EMPTY_ENTITY_FORM);
    }
  }, [open]);

  const handleSave = async () => {
    if (!form.legal_name.trim()) {
      toast({ title: "Legal name is required", variant: "destructive" });
      return;
    }
    if (form.accounting_system === "odoo" && parseOptionalPositiveInteger(form.odoo_default_expense_account_id) === undefined) {
      toast({ title: "Invalid default expense account", description: "Enter a positive whole-number Odoo account ID.", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        legal_name: form.legal_name,
        display_name: form.display_name || undefined,
        country: form.country || undefined,
        tax_registration_number: form.tax_registration_number || undefined,
        accounting_system: form.accounting_system,
        default_currency: form.default_currency,
      };
      if (form.accounting_system === "odoo") {
        payload.odoo_base_url = form.odoo_base_url || undefined;
        payload.odoo_database = form.odoo_database || undefined;
        payload.odoo_company_name = form.odoo_company_name || undefined;
        payload.odoo_company_id = form.odoo_company_id ? Number(form.odoo_company_id) : undefined;
        payload.odoo_integration_token = form.odoo_integration_token || undefined;
        payload.odoo_default_expense_account_id = parseOptionalPositiveInteger(form.odoo_default_expense_account_id);
      }
      const result = await apiFetch<{ entity: FinanceEntity }>("/api/finance/entities", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      onCreated(result.entity);
      onClose();
      setForm(EMPTY_ENTITY_FORM);
    } catch (err) {
      toast({ title: "Failed to create entity", description: String(err instanceof Error ? err.message : err), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add Legal Entity</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <Label>Legal Name *</Label>
              <Input value={form.legal_name} onChange={(e) => setForm({ ...form, legal_name: e.target.value })} placeholder="Company LLC" />
            </div>
            <div>
              <Label>Display Name</Label>
              <Input value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} placeholder="Optional" />
            </div>
            <div>
              <Label>Country</Label>
              <CountryCombobox value={form.country} onChange={(code) => setForm({ ...form, country: code })} countries={filteredCountries} />
            </div>
            <div>
              <Label>Tax / TRN Number</Label>
              <Input value={form.tax_registration_number} onChange={(e) => setForm({ ...form, tax_registration_number: e.target.value })} placeholder="100XXXXXXXXXXXXX3" />
            </div>
            <div>
              <Label>Default Currency</Label>
              <Select value={form.default_currency} onValueChange={(v) => setForm({ ...form, default_currency: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["USD", "AED", "EUR", "GBP", "SAR"].map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="col-span-2">
              <Label>Accounting System</Label>
              <Select value={form.accounting_system} onValueChange={(v) => setForm({ ...form, accounting_system: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">None (store only)</SelectItem>
                  <SelectItem value="manual">Manual entry</SelectItem>
                  <SelectItem value="odoo">Odoo</SelectItem>
                  <SelectItem value="wafeq">Wafeq</SelectItem>
                  <SelectItem value="quickbooks">QuickBooks</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {form.accounting_system === "odoo" && (
              <>
                <div className="col-span-2">
                  <Label>Odoo Base URL</Label>
                  <Input value={form.odoo_base_url} onChange={(e) => setForm({ ...form, odoo_base_url: e.target.value })} placeholder="https://mycompany.odoo.com" />
                </div>
                <div>
                  <Label>Odoo Database</Label>
                  <Input value={form.odoo_database} onChange={(e) => setForm({ ...form, odoo_database: e.target.value })} placeholder="mycompany" />
                </div>
                <div>
                  <Label>Company ID</Label>
                  <Input type="number" value={form.odoo_company_id} onChange={(e) => setForm({ ...form, odoo_company_id: e.target.value })} placeholder="1" />
                </div>
                <div>
                  <Label>Odoo Company Name</Label>
                  <Input value={form.odoo_company_name} onChange={(e) => setForm({ ...form, odoo_company_name: e.target.value })} />
                </div>
                <div>
                  <Label>Integration Token</Label>
                  <Input type="password" value={form.odoo_integration_token} onChange={(e) => setForm({ ...form, odoo_integration_token: e.target.value })} placeholder="Enter token" />
                </div>
                <div className="col-span-2">
                  <Label htmlFor="new-entity-odoo-default-expense-account">Default Expense Account ID</Label>
                  <Input
                    id="new-entity-odoo-default-expense-account"
                    data-testid="input-new-entity-odoo-default-expense-account"
                    type="text"
                    inputMode="numeric"
                    value={form.odoo_default_expense_account_id}
                    onChange={(e) => setForm({ ...form, odoo_default_expense_account_id: e.target.value })}
                    placeholder="e.g. 383"
                  />
                  <p className="mt-1 text-xs text-muted-foreground">Optional Odoo account ID used as the fallback for approved invoice expense lines.</p>
                </div>
              </>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>{saving ? "Saving…" : "Create Entity"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ManualEntryDialog({ importId, open, onClose, onDone }: { importId: number; open: boolean; onClose: () => void; onDone: () => void }) {
  const { toast } = useToast();
  const [notes, setNotes] = useState("");
  const [ref, setRef] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await apiFetch(`/api/finance/ai-invoice-import/imports/${importId}/mark-manually-entered`, {
        method: "POST",
        body: JSON.stringify({ manual_notes: notes, manual_accounting_reference: ref }),
      });
      toast({ title: "Marked as manually entered" });
      onDone();
      onClose();
    } catch (err) {
      toast({ title: "Failed", description: String(err instanceof Error ? err.message : err), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Mark as Manually Entered</DialogTitle></DialogHeader>
        <div className="space-y-4 py-2">
          <div>
            <Label>Accounting Reference (optional)</Label>
            <Input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="Bill #, journal entry ID…" />
          </div>
          <div>
            <Label>Notes (optional)</Label>
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="Any notes…" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving}>{saving ? "Saving…" : "Confirm"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function WafeqConnectionManager({ open }: { open: boolean }) {
  const { isOwner } = useWorkspaceRole();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!open) {
      setApiKey("");
    }
  }, [open]);

  const { data: connection, isLoading, isError, refetch } = useQuery({
    queryKey: ["wafeq-connection"],
    queryFn: async () => {
      const res = await apiFetch<{ connection: { configured: boolean; status: string; organization_id?: string; organization_name?: string; last_verified_at?: string; last_error?: string; last_error_at?: string } }>("/api/finance/wafeq/connection");
      return res.connection;
    },
    enabled: isOwner && open,
    staleTime: 0,
    refetchOnMount: "always",
  });

  const handleConnect = async () => {
    if (!apiKey.trim()) {
      toast({ title: "API key required", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      await apiFetch("/api/finance/wafeq/connection", {
        method: "POST",
        body: JSON.stringify({ api_key: apiKey.trim() }),
      });
      toast({ title: "Connected to Wafeq" });
      setApiKey("");
      qc.invalidateQueries({ queryKey: ["wafeq-connection"] });
    } catch (err) {
      toast({ title: "Failed to connect", description: String(err instanceof Error ? err.message : err), variant: "destructive" });
    } finally {
      setApiKey("");
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    try {
      await apiFetch("/api/finance/wafeq/connection/test", { method: "POST" });
      toast({ title: "Connection verified" });
      qc.invalidateQueries({ queryKey: ["wafeq-connection"] });
    } catch (err) {
      toast({ title: "Test failed", description: String(err instanceof Error ? err.message : err), variant: "destructive" });
      qc.invalidateQueries({ queryKey: ["wafeq-connection"] });
    } finally {
      setTesting(false);
    }
  };

  const handleDisconnect = async () => {
    if (!confirm("Are you sure you want to disconnect from Wafeq?")) return;
    setDeleting(true);
    try {
      await apiFetch("/api/finance/wafeq/connection", { method: "DELETE" });
      toast({ title: "Disconnected from Wafeq" });
      qc.invalidateQueries({ queryKey: ["wafeq-connection"] });
    } catch (err) {
      toast({ title: "Failed to disconnect", description: String(err instanceof Error ? err.message : err), variant: "destructive" });
    } finally {
      setDeleting(false);
    }
  };

  if (!isOwner) {
    return (
      <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-900 mt-4" data-testid="wafeq-unauthorized">
        Only workspace owners can configure the Wafeq connection.
      </div>
    );
  }

  if (isLoading) {
    return <div className="p-4 border rounded-md flex justify-center mt-4" role="status" aria-label="Loading Wafeq connection" data-testid="wafeq-loading"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  }

  if (isError) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm mt-4" role="alert" data-testid="wafeq-load-error">
        <p className="font-medium text-destructive">Could not load the Wafeq connection</p>
        <p className="mt-1 text-muted-foreground">Check your connection and try again.</p>
        <Button variant="outline" size="sm" className="mt-3" onClick={() => void refetch()}>Try again</Button>
      </div>
    );
  }

  const isConfigured = connection?.configured === true;
  const hasStoredConnection = Boolean(connection && connection.status !== "not_configured");
  const hasConnectionError = connection?.status === "invalid" || connection?.status === "rate_limit" || connection?.status === "unavailable";
  const statusLabel = connection?.status === "rate_limit"
    ? "Rate limited"
    : connection?.status === "unavailable"
      ? "Temporarily unavailable"
    : connection?.status === "invalid"
      ? "Needs attention"
      : isConfigured
        ? "Connected"
        : "Not connected";

  return (
    <div className="space-y-4 border rounded-md p-4 bg-muted/20 mt-4" data-testid="wafeq-connection-manager">
      <div className="flex items-center gap-2">
        <h3 className="font-semibold text-sm">Wafeq Connection</h3>
        <Badge
          variant={hasConnectionError ? "destructive" : isConfigured ? "default" : "secondary"}
          className="text-[10px]"
          data-testid="wafeq-status-badge"
        >
          {statusLabel}
        </Badge>
      </div>

      {connection && hasStoredConnection && (
        <div className="text-xs text-muted-foreground space-y-1 bg-background p-3 rounded border">
          <div className="grid grid-cols-[100px_1fr] gap-2">
            <span className="font-medium text-foreground">Organization:</span>
            <span data-testid="wafeq-org-name">{connection.organization_name || "—"} <span className="text-muted-foreground/60 ml-1">({connection.organization_id})</span></span>
          </div>
          <div className="grid grid-cols-[100px_1fr] gap-2">
            <span className="font-medium text-foreground">Last verified:</span>
            <span data-testid="wafeq-last-verified">{connection.last_verified_at ? new Date(connection.last_verified_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "—"}</span>
          </div>
          {hasConnectionError && connection.last_error && (
            <div className="grid grid-cols-[100px_1fr] gap-2 mt-2 pt-2 border-t border-destructive/20 text-destructive">
              <span className="font-medium">Error:</span>
              <span data-testid="wafeq-last-error">{connection.last_error}</span>
            </div>
          )}
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="wafeq-api-key">{hasStoredConnection ? "Replace API Key" : "Wafeq API Key"}</Label>
        <div className="flex gap-2">
          <Input
            type="password"
            id="wafeq-api-key"
            placeholder={hasStoredConnection ? "Enter new API key to replace..." : "Enter Wafeq API key"}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !saving && apiKey.trim()) handleConnect(); }}
            data-testid="wafeq-api-key-input"
          />
          <Button onClick={handleConnect} disabled={saving || !apiKey.trim()} data-testid="wafeq-connect-button">
            {saving ? <><Loader2 className="h-4 w-4 animate-spin" /><span className="sr-only">Saving Wafeq connection</span></> : (hasStoredConnection ? "Replace" : "Connect")}
          </Button>
        </div>
      </div>

      {hasStoredConnection && (
        <div className="flex items-center gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={handleTest} disabled={testing || saving || deleting} data-testid="wafeq-test-button">
            {testing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RefreshCw className="h-4 w-4 mr-2" />}
            Test Connection
          </Button>
          <Button variant="destructive" size="sm" onClick={handleDisconnect} disabled={testing || saving || deleting} data-testid="wafeq-disconnect-button">
            {deleting ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Trash2 className="h-4 w-4 mr-2" />}
            Disconnect
          </Button>
        </div>
      )}
    </div>
  );
}

export function EntitySettingsDialog({ entity, open, onClose }: { entity: FinanceEntity; open: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [form, setForm] = useState({
    odoo_base_url: entity.odoo_base_url ?? "",
    odoo_database: entity.odoo_database ?? "",
    odoo_company_name: entity.odoo_company_name ?? "",
    odoo_company_id: entity.odoo_company_id != null ? String(entity.odoo_company_id) : "",
    accounting_system: entity.accounting_system,
    default_currency: entity.default_currency,
    odoo_integration_token: "",
    odoo_default_expense_account_id: entity.odoo_default_expense_account_id != null ? String(entity.odoo_default_expense_account_id) : "",
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setForm({
        odoo_base_url: entity.odoo_base_url ?? "",
        odoo_database: entity.odoo_database ?? "",
        odoo_company_name: entity.odoo_company_name ?? "",
        odoo_company_id: entity.odoo_company_id != null ? String(entity.odoo_company_id) : "",
        accounting_system: entity.accounting_system,
        default_currency: entity.default_currency,
        odoo_integration_token: "",
        odoo_default_expense_account_id: entity.odoo_default_expense_account_id != null ? String(entity.odoo_default_expense_account_id) : "",
      });
    }
  }, [entity, open]);

  const handleSave = async () => {
    if (form.accounting_system === "odoo" && parseOptionalPositiveInteger(form.odoo_default_expense_account_id) === undefined) {
      toast({ title: "Invalid default expense account", description: "Enter a positive whole-number Odoo account ID.", variant: "destructive" });
      return;
    }
    setSaving(true);
    try {
      await apiFetch(`/api/finance/entities/${entity.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          accounting_system: form.accounting_system,
          default_currency: form.default_currency,
          odoo_base_url: form.odoo_base_url || null,
          odoo_database: form.odoo_database || null,
          odoo_company_name: form.odoo_company_name || null,
          odoo_company_id: form.odoo_company_id ? Number(form.odoo_company_id) : null,
          odoo_integration_token: form.odoo_integration_token || undefined,
          odoo_default_expense_account_id: parseOptionalPositiveInteger(form.odoo_default_expense_account_id),
        }),
      });
      toast({ title: "Entity updated" });
      qc.invalidateQueries({ queryKey: ["finance-entities"] });
      onClose();
    } catch (err) {
      toast({ title: "Failed", description: String(err instanceof Error ? err.message : err), variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Entity Settings — {entity.legal_name}</DialogTitle></DialogHeader>
        <div className="space-y-4 py-2">
          <div>
            <Label>Accounting System</Label>
            <Select value={form.accounting_system} onValueChange={(v) => setForm({ ...form, accounting_system: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None (store only)</SelectItem>
                <SelectItem value="manual">Manual entry</SelectItem>
                <SelectItem value="odoo">Odoo</SelectItem>
                <SelectItem value="wafeq">Wafeq</SelectItem>
                <SelectItem value="quickbooks">QuickBooks</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {form.accounting_system === "odoo" && (
            <>
              <div>
                <Label>Odoo Base URL</Label>
                <Input value={form.odoo_base_url} onChange={(e) => setForm({ ...form, odoo_base_url: e.target.value })} placeholder="https://mycompany.odoo.com" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Database Name</Label>
                  <Input value={form.odoo_database} onChange={(e) => setForm({ ...form, odoo_database: e.target.value })} placeholder="mycompany" />
                </div>
                <div>
                  <Label>Company ID</Label>
                  <Input type="number" value={form.odoo_company_id} onChange={(e) => setForm({ ...form, odoo_company_id: e.target.value })} placeholder="1" />
                </div>
              </div>
              <div>
                <Label>Odoo Company Name</Label>
                <Input value={form.odoo_company_name} onChange={(e) => setForm({ ...form, odoo_company_name: e.target.value })} />
              </div>
              <div>
                <Label htmlFor="entity-odoo-default-expense-account">Default Expense Account ID</Label>
                <Input
                  id="entity-odoo-default-expense-account"
                  data-testid="input-entity-odoo-default-expense-account"
                  type="text"
                  inputMode="numeric"
                  value={form.odoo_default_expense_account_id}
                  onChange={(e) => setForm({ ...form, odoo_default_expense_account_id: e.target.value })}
                  placeholder="e.g. 383"
                />
                <p className="mt-1 text-xs text-muted-foreground">Optional Odoo account ID used when an approved invoice line has no more specific account mapping.</p>
              </div>
              <div>
                <Label>Integration Token {entity.odoo_integration_configured && <span className="text-xs text-muted-foreground ml-1">(configured — leave blank to keep)</span>}</Label>
                <Input type="password" value={form.odoo_integration_token} onChange={(e) => setForm({ ...form, odoo_integration_token: e.target.value })} placeholder={entity.odoo_integration_configured ? "••••••••" : "Enter token"} />
              </div>
            </>
          )}
          {form.accounting_system === "wafeq" && (
            <WafeqConnectionManager open={open} />
          )}
          <div>
            <Label>Default Currency</Label>
            <Select value={form.default_currency} onValueChange={(v) => setForm({ ...form, default_currency: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {["USD", "AED", "EUR", "GBP", "SAR"].map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-950">
            <span className="block font-medium">Full-screen invoice review is active</span>
            <span className="block text-emerald-800">Every invoice requires review and approval before accounting sync.</span>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} disabled={saving} data-testid="button-save-entity-settings">{saving ? "Saving…" : "Save Changes"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const PROCESSING_STEPS = [
  { key: "queued", label: "Queued — preparing upload…", minMs: 0 },
  { key: "converting", label: "Converting PDF to image…", minMs: 3000 },
  { key: "reading", label: "Reading with AI…", minMs: 8000 },
  { key: "extracting", label: "Extracting invoice data…", minMs: 18000 },
];

function ProcessingProgressIndicator({ invoice, allDone = false }: { invoice: InvoiceImport; allDone?: boolean }) {
  const activeStepIndex = PROCESSING_STEPS.findIndex((step) => step.key === invoice.processing_step);
  const resolvedIndex = activeStepIndex === -1 ? 0 : activeStepIndex;

  return (
    <div className="flex flex-col gap-4 py-2">
      <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
        {allDone ? (
          <CheckCircle2 className="h-4 w-4 text-green-600" />
        ) : (
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
        )}
        <span>{allDone ? "AI extraction complete!" : "AI is processing this invoice…"}</span>
      </div>

      <div className="flex flex-col gap-3">
        {PROCESSING_STEPS.map((step, i) => {
          const isDone = allDone || i < resolvedIndex;
          const isActive = !allDone && i === resolvedIndex;
          const isPending = !allDone && i > resolvedIndex;
          return (
            <div key={step.key} className="flex items-center gap-3">
              <div className="shrink-0 h-5 w-5 flex items-center justify-center">
                {isDone ? (
                  <CheckCircle2 className="h-4 w-4 text-green-600" />
                ) : isActive ? (
                  <Loader2 className="h-4 w-4 animate-spin text-primary" />
                ) : (
                  <Clock className="h-4 w-4 text-muted-foreground/40" />
                )}
              </div>
              <span
                className={`text-sm ${
                  isDone
                    ? "text-green-600 line-through decoration-green-400"
                    : isActive
                    ? "text-foreground font-medium"
                    : isPending
                    ? "text-muted-foreground/50"
                    : ""
                }`}
              >
                {step.label}
              </span>
            </div>
          );
        })}
      </div>

      {!allDone && (
        <p className="text-xs text-muted-foreground">
          This usually takes 10–30 seconds. The page updates automatically.
        </p>
      )}
    </div>
  );
}

type EditForm = {
  vendor_name: string;
  vendor_tax_number: string;
  vendor_address: string;
  invoice_number: string;
  invoice_date: string;
  due_date: string;
  currency: string;
  subtotal: string;
  tax_amount: string;
  total_amount: string;
  line_items: LineItem[];
};

function buildEditForm(invoice: InvoiceImport): EditForm {
  return {
    vendor_name: invoice.vendor_name ?? "",
    vendor_tax_number: invoice.vendor_tax_number ?? "",
    vendor_address: invoice.vendor_address ?? "",
    invoice_number: invoice.invoice_number ?? "",
    invoice_date: invoice.invoice_date ? invoice.invoice_date.slice(0, 10) : "",
    due_date: invoice.due_date ? invoice.due_date.slice(0, 10) : "",
    currency: invoice.currency ?? "",
    subtotal: invoice.subtotal ?? "",
    tax_amount: invoice.tax_amount ?? "",
    total_amount: invoice.total_amount ?? "",
    line_items: Array.isArray(invoice.line_items) ? invoice.line_items.map((li) => ({ ...li })) : [],
  };
}

const FIELD_LABELS: Record<string, string> = {
  vendor_name: "Vendor Name",
  vendor_tax_number: "Vendor TRN",
  vendor_address: "Vendor Address",
  invoice_number: "Invoice #",
  invoice_date: "Invoice Date",
  due_date: "Due Date",
  currency: "Currency",
  subtotal: "Subtotal",
  tax_amount: "Tax Amount",
  total_amount: "Total Amount",
  line_items: "Line Items",
};

function EditHistorySection({ invoiceId }: { invoiceId: number }) {
  const [open, setOpen] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ["finance-invoice-edits", invoiceId],
    queryFn: async () => {
      const result = await apiFetch<{ edits: InvoiceImportEdit[] }>(`/api/finance/ai-invoice-import/imports/${invoiceId}/edits`);
      return result.edits;
    },
    enabled: open,
  });

  const edits = data ?? [];

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button className="flex items-center gap-2 w-full text-left text-xs font-semibold text-muted-foreground uppercase tracking-wide hover:text-foreground transition-colors pt-1">
          <History className="h-3.5 w-3.5" />
          Edit History
          {open ? <ChevronDown className="h-3.5 w-3.5 ml-auto" /> : <ChevronRight className="h-3.5 w-3.5 ml-auto" />}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2 flex flex-col gap-3">
          {isLoading && (
            <p className="text-xs text-muted-foreground italic">Loading history…</p>
          )}
          {!isLoading && edits.length === 0 && (
            <p className="text-xs text-muted-foreground italic">No edits recorded yet.</p>
          )}
          {edits.map((edit) => {
            const changedKeys = Object.keys(edit.before_values);
            return (
              <div key={edit.id} className="border rounded-md p-2.5 text-xs bg-muted/30">
                <div className="flex items-center justify-between gap-2 mb-2">
                  <span className="font-medium">{edit.changed_by_name}</span>
                  <span className="text-muted-foreground">{new Date(edit.changed_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</span>
                </div>
                <div className="flex flex-col gap-1">
                  {changedKeys.map((key) => {
                    const label = FIELD_LABELS[key] ?? key;
                    const before = edit.before_values[key];
                    const after = edit.after_values[key];
                    const beforeStr = key === "line_items"
                      ? `${Array.isArray(before) ? before.length : 0} item(s)`
                      : (before != null ? String(before) : "—");
                    const afterStr = key === "line_items"
                      ? `${Array.isArray(after) ? after.length : 0} item(s)`
                      : (after != null ? String(after) : "—");
                    return (
                      <div key={key} className="grid grid-cols-[auto_1fr_auto_1fr] gap-1 items-start">
                        <span className="text-muted-foreground font-medium w-20 shrink-0">{label}</span>
                        <span className="text-red-600 line-through truncate">{beforeStr}</span>
                        <span className="text-muted-foreground mx-1">→</span>
                        <span className="text-green-700 font-medium truncate">{afterStr}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

type SupplierOption = {
  id: number;
  name: string;
  display_name: string | null;
  tax_number: string | null;
  billing_address: string | null;
};

function supplierLabel(s: SupplierOption): string {
  return s.display_name || s.name;
}

function VendorNameCombobox({
  value,
  onChangeText,
  onSelectSupplier,
}: {
  value: string;
  onChangeText: (v: string) => void;
  onSelectSupplier: (s: SupplierOption) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const { data, isFetching } = useQuery({
    queryKey: ["suppliers-combobox", search],
    queryFn: () =>
      apiFetch<{ suppliers: SupplierOption[] }>(
        `/api/suppliers${search.trim() ? `?q=${encodeURIComponent(search.trim())}` : ""}`,
      ),
    enabled: open,
  });
  const suppliers = data?.suppliers ?? [];
  const trimmed = search.trim();
  const hasExactMatch = suppliers.some(
    (s) => supplierLabel(s).toLowerCase() === trimmed.toLowerCase(),
  );

  const commitTyped = (text: string) => {
    onChangeText(text);
    setOpen(false);
    setSearch("");
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label="Vendor Name"
          className="h-8 w-full justify-between px-3 text-sm font-normal"
          type="button"
        >
          <span className={cn("truncate", value ? "text-foreground" : "text-muted-foreground")}>
            {value || "Select or type vendor…"}
          </span>
          <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search or type a vendor…"
            value={search}
            onValueChange={setSearch}
            onKeyDown={(e) => {
              if (e.key === "Enter" && trimmed && !hasExactMatch) {
                e.preventDefault();
                commitTyped(trimmed);
              }
            }}
          />
          <CommandList>
            {isFetching ? (
              <div className="flex items-center gap-2 px-3 py-4 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Loading suppliers…
              </div>
            ) : (
              <CommandEmpty>No suppliers found.</CommandEmpty>
            )}
            {trimmed && !hasExactMatch && (
              <CommandGroup>
                <CommandItem value={`__use__${trimmed}`} onSelect={() => commitTyped(trimmed)}>
                  <Plus className="mr-2 size-4" />
                  Use “{trimmed}”
                </CommandItem>
              </CommandGroup>
            )}
            {suppliers.length > 0 && (
              <CommandGroup heading="Suppliers">
                {suppliers.map((s) => (
                  <CommandItem
                    key={s.id}
                    value={String(s.id)}
                    onSelect={() => {
                      onSelectSupplier(s);
                      setOpen(false);
                      setSearch("");
                    }}
                  >
                    <Check
                      className={cn(
                        "mr-2 size-4",
                        value === supplierLabel(s) ? "opacity-100" : "opacity-0",
                      )}
                    />
                    <span className="truncate">{supplierLabel(s)}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

type SupplierSuggestion = {
  id: number;
  name: string;
  display_name: string | null;
  score: number;
};

function SupplierMatchCard({
  invoice,
  onLinked,
}: {
  invoice: InvoiceImport;
  onLinked: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [linking, setLinking] = useState(false);
  const [supplierSearchOpen, setSupplierSearchOpen] = useState(false);
  const [supplierSearch, setSupplierSearch] = useState("");

  const { data: suggestionsData, isLoading: suggestionsLoading } = useQuery({
    queryKey: ["invoice-supplier-suggestions", invoice.id],
    queryFn: () =>
      apiFetch<{ suggestions: SupplierSuggestion[]; vendor_name: string }>(
        `/api/finance/ai-invoice-import/imports/${invoice.id}/supplier-suggestions`,
      ),
    staleTime: 30_000,
  });

  const { data: suppliersData, isFetching: suppliersFetching } = useQuery({
    queryKey: ["suppliers-combobox", supplierSearch],
    queryFn: () =>
      apiFetch<{ suppliers: SupplierOption[] }>(
        `/api/suppliers${supplierSearch.trim() ? `?q=${encodeURIComponent(supplierSearch.trim())}` : ""}`,
      ),
    enabled: supplierSearchOpen,
  });

  const suggestions = suggestionsData?.suggestions ?? [];
  const suppliers = suppliersData?.suppliers ?? [];
  const topSuggestion = suggestions[0] ?? null;

  const patchSupplier = async (supplierId: number | null) => {
    setLinking(true);
    try {
      await apiFetch(`/api/finance/ai-invoice-import/imports/${invoice.id}`, {
        method: "PATCH",
        body: JSON.stringify({ supplier_id: supplierId }),
      });
      qc.invalidateQueries({ queryKey: ["finance-imports"] });
      qc.invalidateQueries({ queryKey: ["invoice-supplier-suggestions", invoice.id] });
      toast({ title: supplierId ? "Supplier linked" : "Supplier unlinked" });
      onLinked();
    } catch (err) {
      toast({ title: "Failed", description: String(err instanceof Error ? err.message : err), variant: "destructive" });
    } finally {
      setLinking(false);
    }
  };

  // Already linked — show chip with unlink button.
  if (invoice.supplier_id !== null) {
    return (
      <div className="flex items-center gap-2 p-2 rounded-md bg-green-50 border border-green-200">
        <Building2 className="h-3.5 w-3.5 text-green-700 shrink-0" />
        <span className="text-xs font-medium text-green-800 flex-1">
          Linked: {invoice.supplier_name ?? `Supplier #${invoice.supplier_id}`}
        </span>
        <button
          className="text-muted-foreground hover:text-destructive"
          onClick={() => void patchSupplier(null)}
          disabled={linking}
          title="Unlink supplier"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  // Not yet linked — show matching UI.
  return (
    <div className="p-3 rounded-md border border-amber-200 bg-amber-50 flex flex-col gap-2">
      <p className="text-xs font-semibold text-amber-800 flex items-center gap-1">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        Could not identify supplier
      </p>

      {suggestionsLoading && (
        <p className="text-xs text-muted-foreground italic">Searching suppliers…</p>
      )}

      {!suggestionsLoading && topSuggestion && topSuggestion.score >= 70 && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground flex-1 truncate">
            Suggested: <span className="font-medium text-foreground">{topSuggestion.display_name ?? topSuggestion.name}</span>
            <span className="ml-1 text-muted-foreground">({topSuggestion.score}% match)</span>
          </span>
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-xs shrink-0"
            onClick={() => void patchSupplier(topSuggestion.id)}
            disabled={linking}
          >
            Link
          </Button>
        </div>
      )}

      <Popover open={supplierSearchOpen} onOpenChange={setSupplierSearchOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="w-full justify-between h-7 text-xs font-normal">
            <span className="text-muted-foreground">Choose a different supplier…</span>
            <ChevronsUpDown className="ml-2 h-3.5 w-3.5 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput
              placeholder="Search suppliers…"
              value={supplierSearch}
              onValueChange={setSupplierSearch}
            />
            <CommandList>
              {suppliersFetching ? (
                <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Loading…
                </div>
              ) : (
                <CommandEmpty>No suppliers found.</CommandEmpty>
              )}
              {suppliers.length > 0 && (
                <CommandGroup>
                  {suppliers.map((s) => (
                    <CommandItem
                      key={s.id}
                      value={String(s.id)}
                      onSelect={() => {
                        setSupplierSearchOpen(false);
                        void patchSupplier(s.id);
                      }}
                    >
                      <span className="truncate">{s.display_name ?? s.name}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      <a
        href={`/suppliers?create=1&name=${encodeURIComponent(invoice.vendor_name ?? "")}`}
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs text-primary hover:underline flex items-center gap-1"
      >
        <Plus className="h-3 w-3" />
        Create new supplier
      </a>
    </div>
  );
}

function SupplierConfirmationCard({
  invoice,
  onConfirmed,
}: {
  invoice: InvoiceImport;
  onConfirmed: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [confirmingId, setConfirmingId] = useState<number | null>(null);
  const candidates = invoice.supplier_confirmation?.candidates ?? [];
  if (invoice.sync_status !== "needs_supplier_confirmation" && candidates.length === 0) return null;

  const confirmSupplier = async (candidate: OdooSupplierCandidate) => {
    setConfirmingId(candidate.id);
    try {
      const result = await apiFetch<{
        success: boolean;
        needs_supplier_confirmation?: boolean;
        supplier_candidates?: OdooSupplierCandidate[];
      }>(`/api/finance/invoice-review/${invoice.id}/confirm-supplier`, {
        method: "POST",
        body: JSON.stringify({ provider_supplier_id: candidate.id }),
      });
      qc.invalidateQueries({ queryKey: ["finance-imports"] });
      qc.invalidateQueries({ queryKey: ["invoice-supplier-suggestions", invoice.id] });
      if (result.needs_supplier_confirmation) {
        toast({ title: "More supplier confirmation is needed", variant: "destructive" });
      } else {
        toast({ title: "Supplier confirmed", description: "The invoice was sent to Odoo." });
      }
      onConfirmed();
    } catch (err) {
      toast({
        title: "Could not confirm supplier",
        description: String(err instanceof Error ? err.message : err),
        variant: "destructive",
      });
    } finally {
      setConfirmingId(null);
    }
  };

  return (
    <div className="p-3 rounded-md border border-amber-300 bg-amber-50 flex flex-col gap-2" data-testid="supplier-confirmation-card">
      <p className="text-xs font-semibold text-amber-900 flex items-center gap-1">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        Confirm supplier before sending to Odoo
      </p>
      <p className="text-xs text-amber-800">
        Odoo found more than one possible supplier for “{invoice.supplier_confirmation?.vendor_name ?? invoice.vendor_name ?? "this invoice"}”.
        Choose the correct supplier. This choice will be saved for future invoices.
      </p>
      {candidates.length === 0 ? (
        <p className="text-xs text-muted-foreground">No close Odoo candidates were returned. Check the supplier name or tax number.</p>
      ) : (
        <div className="space-y-1" role="listbox" aria-label="Odoo supplier candidates">
          {candidates.map((candidate) => (
            <button
              key={candidate.id}
              type="button"
              role="option"
              className="w-full flex items-center justify-between gap-3 rounded border bg-background px-2.5 py-2 text-left text-xs hover:border-primary hover:bg-primary/5 disabled:opacity-60"
              onClick={() => void confirmSupplier(candidate)}
              disabled={confirmingId !== null}
              data-testid={`supplier-confirm-option-${candidate.id}`}
            >
              <span className="min-w-0">
                <span className="block font-medium truncate">{candidate.display_name ?? candidate.name}</span>
                {candidate.display_name && candidate.display_name !== candidate.name && (
                  <span className="block text-muted-foreground truncate">{candidate.name}</span>
                )}
                {candidate.tax_number && <span className="block text-muted-foreground">TRN: {candidate.tax_number}</span>}
              </span>
              <span className="shrink-0 text-muted-foreground">
                {confirmingId === candidate.id ? "Saving…" : `${candidate.score}% match`}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function BulkSupplierConfirmationReview({
  confirmations,
  onCompleted,
}: {
  confirmations: BulkSupplierConfirmation[];
  onCompleted: (result: BulkConfirmationResult) => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [selections, setSelections] = useState<Record<number, string>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    setSelections((current) => {
      const next = { ...current };
      for (const confirmation of confirmations) {
        if (!next[confirmation.invoice_id] && confirmation.suggested_supplier) {
          next[confirmation.invoice_id] = String(confirmation.suggested_supplier.id);
        }
      }
      return next;
    });
  }, [confirmations]);

  if (confirmations.length === 0) return null;

  const selectedCount = confirmations.filter((confirmation) => selections[confirmation.invoice_id]).length;
  const submit = async () => {
    const payload = confirmations
      .map((confirmation) => ({
        invoice_id: confirmation.invoice_id,
        provider_supplier_id: Number(selections[confirmation.invoice_id]),
      }))
      .filter((selection) => Number.isInteger(selection.provider_supplier_id) && selection.provider_supplier_id > 0);
    if (payload.length !== confirmations.length) {
      toast({ title: "Choose a supplier for every invoice", variant: "destructive" });
      return;
    }
    setIsSubmitting(true);
    try {
      const result = await apiFetch<BulkConfirmationResult>("/api/finance/invoice-review/confirm-suppliers", {
        method: "POST",
        body: JSON.stringify({ confirmations: payload }),
      });
      qc.invalidateQueries({ queryKey: ["finance-imports"] });
      onCompleted(result);
      toast({
        title: result.failed || result.blocked ? "Supplier confirmations completed with issues" : "Supplier confirmations completed",
        description: `${result.synced} synced, ${result.recovered} recovered/already in Odoo, ${result.blocked} blocked, ${result.failed} failed.`,
        variant: result.failed || result.blocked ? "destructive" : "default",
      });
    } catch (error) {
      toast({
        title: "Could not continue supplier confirmations",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Card data-testid="bulk-supplier-confirmation-review">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-600" />
          Supplier confirmations needed ({confirmations.length})
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Review all ambiguous invoices together. Saved supplier mappings will be reused on future invoices.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Invoice number</th>
                <th className="px-3 py-2 font-medium">Extracted supplier</th>
                <th className="px-3 py-2 font-medium">Suggested Odoo supplier</th>
                <th className="px-3 py-2 font-medium">Confirm supplier</th>
              </tr>
            </thead>
            <tbody>
              {confirmations.map((confirmation) => (
                <tr key={confirmation.invoice_id} className="border-t align-top">
                  <td className="px-3 py-2 font-medium whitespace-nowrap">{confirmation.invoice_number ?? `#${confirmation.invoice_id}`}</td>
                  <td className="px-3 py-2">{confirmation.vendor_name ?? "—"}</td>
                  <td className="px-3 py-2">
                    {confirmation.suggested_supplier
                      ? <span>{confirmation.suggested_supplier.display_name ?? confirmation.suggested_supplier.name}</span>
                      : <span className="text-muted-foreground">No suggestion</span>}
                  </td>
                  <td className="px-3 py-2 min-w-64">
                    <select
                      className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                      value={selections[confirmation.invoice_id] ?? ""}
                      onChange={(event) => setSelections((current) => ({
                        ...current,
                        [confirmation.invoice_id]: event.target.value,
                      }))}
                      disabled={isSubmitting}
                      data-testid={`bulk-supplier-select-${confirmation.invoice_id}`}
                    >
                      <option value="" disabled>Choose a supplier</option>
                      {confirmation.candidates.map((candidate) => (
                        <option key={candidate.id} value={candidate.id}>
                          {candidate.display_name ?? candidate.name}{candidate.tax_number ? ` · TRN ${candidate.tax_number}` : ""} · {candidate.score}% match
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">{selectedCount} of {confirmations.length} suppliers selected</p>
          <Button
            type="button"
            onClick={() => void submit()}
            disabled={isSubmitting || selectedCount !== confirmations.length}
            data-testid="button-confirm-continue-sync"
          >
            {isSubmitting ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Check className="h-4 w-4 mr-1" />}
            {isSubmitting ? "Continuing sync…" : "Confirm & Continue Sync"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function OdooIssueQueue({
  entityId,
  onReview,
}: {
  entityId: number | null;
  onReview: (issue: OdooIssue) => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Record<number, boolean>>({});
  const [supplierSelections, setSupplierSelections] = useState<Record<number, string>>({});
  const [workingId, setWorkingId] = useState<number | null>(null);

  const query = useQuery({
    queryKey: ["odoo-issue-queue", entityId],
    queryFn: () => apiFetch<{ issues: OdooIssue[]; total: number }>(
      `/api/finance/invoice-review/odoo-issues${entityId ? `?entity_id=${entityId}` : ""}`,
    ),
  });
  const issues = query.data?.issues ?? [];
  const actionable = issues.filter((issue) => issue.effective_sync_status !== "needs_supplier_confirmation");
  const selectedRetryable = actionable.filter((issue) => selected[issue.id]);
  const confirmations = issues
    .map((issue) => ({
      invoice_id: issue.id,
      provider_supplier_id: Number(supplierSelections[issue.id]),
    }))
    .filter((selection) => Number.isInteger(selection.provider_supplier_id) && selection.provider_supplier_id > 0);

  if (query.isLoading || issues.length === 0) return null;

  const refresh = () => {
    void query.refetch();
    qc.invalidateQueries({ queryKey: ["finance-imports"] });
    qc.invalidateQueries({ queryKey: ["invoice-review"] });
  };

  const retrySelected = async () => {
    if (!selectedRetryable.length) return;
    setWorkingId(-1);
    const results = await Promise.allSettled(selectedRetryable.map((issue) =>
      apiFetch(`/api/finance/invoice-review/${issue.id}/retry-sync`, {
        method: "POST",
        body: JSON.stringify({
          version: issue.review_version,
          idempotency_key: `issue-queue:${issue.id}:${issue.review_version}:${crypto.randomUUID()}`,
        }),
      }),
    ));
    const failed = results.filter((result) => result.status === "rejected").length;
    toast({
      title: failed ? "Some Odoo retries need attention" : "Odoo retries started",
      description: failed ? `${failed} invoice(s) still need review.` : `${selectedRetryable.length} invoice(s) were sent through Odoo verification.`,
      variant: failed ? "destructive" : "default",
    });
    setSelected({});
    refresh();
    setWorkingId(null);
  };

  const confirmSelected = async () => {
    if (confirmations.length === 0) {
      toast({ title: "Choose an Odoo supplier first", variant: "destructive" });
      return;
    }
    setWorkingId(-1);
    try {
      await apiFetch("/api/finance/invoice-review/confirm-suppliers", {
        method: "POST",
        body: JSON.stringify({ confirmations }),
      });
      toast({ title: "Supplier confirmations submitted" });
      setSupplierSelections({});
      refresh();
    } catch (error) {
      toast({ title: "Could not confirm suppliers", description: error instanceof Error ? error.message : String(error), variant: "destructive" });
    } finally {
      setWorkingId(null);
    }
  };

  const createSupplier = async (issue: OdooIssue) => {
    if (!window.confirm(`Create or reuse “${issue.vendor_name ?? "this supplier"}” in Odoo and retry this invoice?`)) return;
    setWorkingId(issue.id);
    try {
      await apiFetch(`/api/finance/invoice-review/${issue.id}/create-odoo-supplier`, {
        method: "POST",
        body: JSON.stringify({
          confirm: true,
          supplier_id: issue.supplier_id,
          name: issue.os_supplier_display_name ?? issue.os_supplier_name ?? issue.vendor_name,
          address: issue.vendor_address,
          tax_number: issue.os_supplier_tax_number ?? issue.vendor_tax_number,
        }),
      });
      toast({ title: "Odoo supplier created or reused", description: "The invoice was sent through the normal Odoo verification path." });
      refresh();
    } catch (error) {
      toast({ title: "Could not create Odoo supplier", description: error instanceof Error ? error.message : String(error), variant: "destructive" });
    } finally {
      setWorkingId(null);
    }
  };

  return (
    <Card data-testid="odoo-issue-queue">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600" />
              Odoo sync issues
            </CardTitle>
            <p className="text-sm text-muted-foreground mt-1">
              Failed, blocked, and supplier-confirmation invoices. Synced invoices are never included.
            </p>
          </div>
          <Badge variant="secondary">{query.data?.total ?? issues.length}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 w-8" />
                <th className="px-3 py-2">Invoice / entity</th>
                <th className="px-3 py-2">OS supplier</th>
                <th className="px-3 py-2">Odoo supplier / issue</th>
                <th className="px-3 py-2 text-right">Total</th>
                <th className="px-3 py-2">Action</th>
              </tr>
            </thead>
            <tbody>
              {issues.map((issue) => {
                const candidates = issue.supplier_confirmation?.candidates ?? [];
                const isConfirmation = issue.effective_sync_status === "needs_supplier_confirmation";
                return (
                  <tr key={issue.id} className="border-t align-top">
                    <td className="px-3 py-2">
                      {!isConfirmation && (
                        <input
                          type="checkbox"
                          checked={!!selected[issue.id]}
                          onChange={(event) => setSelected((current) => ({ ...current, [issue.id]: event.target.checked }))}
                          aria-label={`Select invoice ${issue.invoice_number ?? issue.id} for retry`}
                        />
                      )}
                    </td>
                    <td className="px-3 py-2 min-w-44">
                      <button type="button" className="font-medium text-left hover:text-primary hover:underline" onClick={() => onReview(issue)}>
                        {issue.invoice_number ?? `#${issue.id}`}
                      </button>
                      <p className="text-xs text-muted-foreground truncate max-w-48">{issue.entity_display_name ?? issue.entity_legal_name}</p>
                      <Badge variant={issue.effective_sync_status === "blocked" ? "outline" : "destructive"} className="mt-1 text-[10px]">
                        {issue.effective_sync_status.replaceAll("_", " ")}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 min-w-40">
                      <p className="font-medium">{issue.os_supplier_display_name ?? issue.os_supplier_name ?? issue.vendor_name ?? "Unknown"}</p>
                      {(issue.os_supplier_tax_number ?? issue.vendor_tax_number) && (
                        <p className="text-xs text-muted-foreground">TRN: {issue.os_supplier_tax_number ?? issue.vendor_tax_number}</p>
                      )}
                      {issue.os_odoo_partner_id && <p className="text-xs text-muted-foreground">Mapped Odoo ID {issue.os_odoo_partner_id}</p>}
                    </td>
                    <td className="px-3 py-2 min-w-64">
                      {candidates.length > 0 && (
                        <select
                          className="h-8 w-full rounded-md border border-input bg-background px-2 text-xs mb-1"
                          value={supplierSelections[issue.id] ?? ""}
                          onChange={(event) => setSupplierSelections((current) => ({ ...current, [issue.id]: event.target.value }))}
                          disabled={workingId !== null}
                          aria-label={`Choose Odoo supplier for invoice ${issue.id}`}
                        >
                          <option value="">Choose Odoo supplier…</option>
                          {candidates.map((candidate) => (
                            <option key={candidate.id} value={candidate.id}>
                              {candidate.display_name ?? candidate.name}{candidate.tax_number ? ` · TRN ${candidate.tax_number}` : ""}
                            </option>
                          ))}
                        </select>
                      )}
                      <p className="text-xs text-muted-foreground break-words">{issue.issue_message}</p>
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums">
                      {formatCurrency(issue.total_amount, issue.currency)}
                    </td>
                    <td className="px-3 py-2 min-w-40">
                      <div className="flex flex-col items-start gap-1.5">
                        <Button size="sm" variant="outline" onClick={() => onReview(issue)}>
                          <Eye className="h-3.5 w-3.5 mr-1" /> Review
                        </Button>
                        {isConfirmation && candidates.length > 0 && (
                          <Button size="sm" onClick={() => void confirmSelected()} disabled={workingId !== null || !supplierSelections[issue.id]}>
                            <Check className="h-3.5 w-3.5 mr-1" /> Confirm selected
                          </Button>
                        )}
                        {isConfirmation && candidates.length === 0 && (
                          <Button size="sm" onClick={() => void createSupplier(issue)} disabled={workingId !== null}>
                            <Plus className="h-3.5 w-3.5 mr-1" /> Create & retry
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {selectedRetryable.length} retryable issue(s) selected
          </p>
          <div className="flex gap-2">
            {confirmations.length > 0 && (
              <Button variant="outline" size="sm" onClick={() => void confirmSelected()} disabled={workingId !== null}>
                {workingId === -1 ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Check className="h-4 w-4 mr-1" />}
                Confirm selected suppliers
              </Button>
            )}
            <Button size="sm" onClick={() => void retrySelected()} disabled={workingId !== null || selectedRetryable.length === 0}>
              {workingId === -1 ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <RefreshCw className="h-4 w-4 mr-1" />}
              Retry selected
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ConfirmButton({ invoiceId, onConfirmed }: { invoiceId: number; onConfirmed: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: () =>
      apiFetch(`/api/finance/ai-invoice-import/imports/${invoiceId}/confirm`, { method: "POST" }),
    onSuccess: () => {
      toast({ title: "Invoice confirmed" });
      qc.invalidateQueries({ queryKey: ["finance-imports"] });
      onConfirmed();
    },
    onError: (err) => {
      toast({ title: "Confirm failed", description: String(err instanceof Error ? err.message : err), variant: "destructive" });
    },
  });
  return (
    <Button size="sm" variant="default" onClick={() => mutation.mutate()} disabled={mutation.isPending}>
      <BadgeCheck className="h-3.5 w-3.5 mr-1" />
      {mutation.isPending ? "Confirming…" : "Confirm"}
    </Button>
  );
}

function InvoiceDetailPanel({ invoice, entity, onRefresh, onDelete, isOwner }: { invoice: InvoiceImport; entity: FinanceEntity | null; onRefresh: () => void; onDelete: () => void; isOwner: boolean }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [manualEntryOpen, setManualEntryOpen] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editForm, setEditForm] = useState<EditForm>(() => buildEditForm(invoice));

  const sendToOdooMutation = useMutation({
    mutationFn: async () => {
      return apiFetch<{ success: boolean; bill_id?: string; bill_url?: string; needs_supplier_confirmation?: boolean }>(`/api/finance/ai-invoice-import/imports/${invoice.id}/send-to-odoo`, { method: "POST" });
    },
    onSuccess: (data) => {
      toast(data.needs_supplier_confirmation
        ? { title: "Confirm supplier", description: "Choose the correct Odoo supplier before this invoice is sent." }
        : { title: "Sent to Odoo", description: data.bill_url ? "Draft vendor bill created" : "Draft vendor bill created in Odoo" });
      qc.invalidateQueries({ queryKey: ["finance-imports"] });
      onRefresh();
    },
    onError: (err) => {
      toast({ title: "Failed to send to Odoo", description: String(err instanceof Error ? err.message : err), variant: "destructive" });
      qc.invalidateQueries({ queryKey: ["finance-imports"] });
    },
  });

  const saveMutation = useMutation({
    mutationFn: async () => {
      return apiFetch(`/api/finance/ai-invoice-import/imports/${invoice.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          vendor_name: editForm.vendor_name || null,
          vendor_tax_number: editForm.vendor_tax_number || null,
          vendor_address: editForm.vendor_address || null,
          invoice_number: editForm.invoice_number || null,
          invoice_date: editForm.invoice_date || null,
          due_date: editForm.due_date || null,
          currency: editForm.currency || null,
          subtotal: editForm.subtotal !== "" ? editForm.subtotal : null,
          tax_amount: editForm.tax_amount !== "" ? editForm.tax_amount : null,
          total_amount: editForm.total_amount !== "" ? editForm.total_amount : null,
          line_items: editForm.line_items,
        }),
      }) as Promise<{ import: InvoiceImport }>;
    },
    onSuccess: () => {
      toast({ title: "Invoice fields saved", description: "Marked as reviewed" });
      setEditMode(false);
      qc.invalidateQueries({ queryKey: ["finance-imports"] });
      qc.invalidateQueries({ queryKey: ["finance-invoice-edits", invoice.id] });
      onRefresh();
    },
    onError: (err) => {
      toast({ title: "Save failed", description: String(err instanceof Error ? err.message : err), variant: "destructive" });
    },
  });

  const handleEditToggle = () => {
    if (!editMode) {
      setEditForm(buildEditForm(invoice));
    }
    setEditMode((v) => !v);
  };

  const handleLineItemChange = (idx: number, field: keyof LineItem, value: string) => {
    setEditForm((prev) => {
      const items = prev.line_items.map((li, i) =>
        i === idx ? { ...li, [field]: field === "description" ? value : parseFloat(value) || 0 } : li,
      );
      return { ...prev, line_items: items };
    });
  };

  const handleAddLineItem = () => {
    setEditForm((prev) => ({
      ...prev,
      line_items: [...prev.line_items, { description: "", quantity: 1, unit_price: 0, total: 0 }],
    }));
  };

  const handleRemoveLineItem = (idx: number) => {
    setEditForm((prev) => ({ ...prev, line_items: prev.line_items.filter((_, i) => i !== idx) }));
  };

  const handleExport = (format: "csv" | "json") => {
    window.open(`${BASE}/api/finance/ai-invoice-import/imports/${invoice.id}/export.${format}`, "_blank");
  };

  const handleBundle = () => {
    window.open(`${BASE}/api/finance/ai-invoice-import/imports/${invoice.id}/download-pdf-bundle`, "_blank");
  };

  const handleDelete = async () => {
    if (!confirm("Delete this import permanently?")) return;
    try {
      await apiFetch(`/api/finance/ai-invoice-import/imports/${invoice.id}`, { method: "DELETE" });
      toast({ title: "Import deleted" });
      onDelete();
    } catch (err) {
      toast({ title: "Delete failed", description: String(err instanceof Error ? err.message : err), variant: "destructive" });
    }
  };

  const canSendToOdoo =
    invoice.entity_accounting_system === "odoo" &&
    entity?.odoo_integration_configured === true &&
    invoice.status !== "sent_to_odoo" &&
    invoice.status !== "uploaded" &&
    invoice.status !== "processing";

  const canResendToOdoo =
    isOwner &&
    invoice.is_reviewed === true &&
    invoice.status === "sent_to_odoo" &&
    invoice.entity_accounting_system === "odoo" &&
    entity?.odoo_integration_configured === true;

  const lineItems = Array.isArray(invoice.line_items) ? invoice.line_items : [];
  const isProcessing = invoice.status === "uploaded" || invoice.status === "processing";

  // Hold an "all steps done" state briefly when AI finishes so the progress
  // indicator doesn't vanish abruptly the moment the status changes.
  const [showAllDone, setShowAllDone] = useState(false);
  const prevStatusRef = useRef(invoice.status);
  const doneShownRef = useRef(false);

  useEffect(() => {
    // Reset per-invoice tracking when a different invoice is selected.
    doneShownRef.current = false;
    setShowAllDone(false);
    prevStatusRef.current = invoice.status;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoice.id]);

  useEffect(() => {
    const prevStatus = prevStatusRef.current;
    prevStatusRef.current = invoice.status;

    const wasProcessing = prevStatus === "uploaded" || prevStatus === "processing";
    const isTerminalSuccess =
      invoice.status === "extracted" ||
      invoice.status === "needs_review" ||
      invoice.status === "ready_for_manual_entry";

    if (wasProcessing && isTerminalSuccess && !doneShownRef.current) {
      doneShownRef.current = true;
      setShowAllDone(true);
      const timer = setTimeout(() => setShowAllDone(false), 1500);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [invoice.status]);

  // Fade-in state for the detail content body.
  // Resets to invisible whenever the content needs to re-enter (new invoice
  // selected, or showAllDone just cleared), then triggers opacity-100 on the
  // next animation frame so the CSS transition runs.
  const [contentVisible, setContentVisible] = useState(false);
  useEffect(() => {
    setContentVisible(false);
    if (!isProcessing && !showAllDone) {
      const raf = requestAnimationFrame(() => setContentVisible(true));
      return () => cancelAnimationFrame(raf);
    }
    return undefined;
  }, [invoice.id, showAllDone, isProcessing]);

  return (
    <div className="flex flex-col gap-4 h-full overflow-y-auto">
      <ManualEntryDialog
        importId={invoice.id}
        open={manualEntryOpen}
        onClose={() => setManualEntryOpen(false)}
        onDone={onRefresh}
      />

      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold text-base truncate">{invoice.vendor_name ?? "Unknown vendor"}</h3>
          <p className="text-xs text-muted-foreground">{invoice.original_filename}</p>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {invoice.is_reviewed && (
            <Badge variant="outline" className="gap-1 text-xs text-green-700 border-green-300 bg-green-50">
              <BadgeCheck className="h-3 w-3" />
              Reviewed
            </Badge>
          )}
          <StatusBadge status={invoice.status} />
        </div>
      </div>

      {invoice.source_document?.available && invoice.source_document.url && (
        <Button asChild variant="outline" size="sm" className="w-full">
          <a
            href={invoice.source_document.url}
            target="_blank"
            rel="noopener noreferrer"
            data-testid={`link-view-invoice-${invoice.id}`}
          >
            <ExternalLink className="mr-1.5 h-3.5 w-3.5" />
            View invoice
          </a>
        </Button>
      )}

      {(isProcessing || showAllDone) && (
        <ProcessingProgressIndicator invoice={invoice} allDone={showAllDone} />
      )}

      {invoice.status === "failed" && invoice.error_message && (
        <div className="flex items-start gap-2 p-3 rounded-md bg-red-50 border border-red-200 text-red-800 text-xs">
          <XCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <div>
            <p className="font-medium mb-0.5">Extraction failed</p>
            <p>{invoice.error_message}</p>
          </div>
        </div>
      )}

      {invoice.error_message && invoice.status !== "failed" && (
        <div className="flex items-start gap-2 p-3 rounded-md bg-red-50 border border-red-200 text-red-800 text-xs">
          <XCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          <span>{invoice.error_message}</span>
        </div>
      )}

      <div
        className={`transition-opacity duration-300 ${contentVisible ? "opacity-100" : "opacity-0"}`}
      >
      {showAllDone ? null : editMode ? (
        <div className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="col-span-2">
              <Label className="text-xs">Vendor Name</Label>
              <VendorNameCombobox
                value={editForm.vendor_name}
                onChangeText={(v) => setEditForm((f) => ({ ...f, vendor_name: v }))}
                onSelectSupplier={(s) =>
                  setEditForm((f) => ({
                    ...f,
                    vendor_name: supplierLabel(s),
                    vendor_tax_number: s.tax_number || f.vendor_tax_number,
                    vendor_address: s.billing_address || f.vendor_address,
                  }))
                }
              />
            </div>
            <div className="col-span-2">
              <Label className="text-xs">Vendor TRN</Label>
              <Input
                className="h-8 text-sm font-mono"
                value={editForm.vendor_tax_number}
                onChange={(e) => setEditForm((f) => ({ ...f, vendor_tax_number: e.target.value }))}
              />
            </div>
            <div className="col-span-2">
              <Label className="text-xs">Vendor Address</Label>
              <Textarea
                className="text-sm resize-none"
                rows={2}
                value={editForm.vendor_address}
                onChange={(e) => setEditForm((f) => ({ ...f, vendor_address: e.target.value }))}
              />
            </div>
            <div>
              <Label className="text-xs">Invoice #</Label>
              <Input
                className="h-8 text-sm"
                value={editForm.invoice_number}
                onChange={(e) => setEditForm((f) => ({ ...f, invoice_number: e.target.value }))}
              />
            </div>
            <div>
              <Label className="text-xs">Currency</Label>
              <Select
                value={editForm.currency || "USD"}
                onValueChange={(v) => setEditForm((f) => ({ ...f, currency: v }))}
              >
                <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {["USD", "AED", "EUR", "GBP", "SAR"].map((c) => (
                    <SelectItem key={c} value={c}>{c}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Invoice Date</Label>
              <Input
                type="date"
                className="h-8 text-sm"
                value={editForm.invoice_date}
                onChange={(e) => setEditForm((f) => ({ ...f, invoice_date: e.target.value }))}
              />
            </div>
            <div>
              <Label className="text-xs">Due Date</Label>
              <Input
                type="date"
                className="h-8 text-sm"
                value={editForm.due_date}
                onChange={(e) => setEditForm((f) => ({ ...f, due_date: e.target.value }))}
              />
            </div>
            <div>
              <Label className="text-xs">Subtotal</Label>
              <Input
                type="number"
                step="0.01"
                className="h-8 text-sm"
                value={editForm.subtotal}
                onChange={(e) => setEditForm((f) => ({ ...f, subtotal: e.target.value }))}
              />
            </div>
            <div>
              <Label className="text-xs">Tax Amount</Label>
              <Input
                type="number"
                step="0.01"
                className="h-8 text-sm"
                value={editForm.tax_amount}
                onChange={(e) => setEditForm((f) => ({ ...f, tax_amount: e.target.value }))}
              />
            </div>
            <div className="col-span-2">
              <Label className="text-xs">Total Amount</Label>
              <Input
                type="number"
                step="0.01"
                className="h-8 text-sm font-semibold"
                value={editForm.total_amount}
                onChange={(e) => setEditForm((f) => ({ ...f, total_amount: e.target.value }))}
              />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                Line Items ({editForm.line_items.length})
              </p>
              <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={handleAddLineItem}>
                <Plus className="h-3 w-3 mr-1" />
                Add
              </Button>
            </div>
            <div className="border rounded-md overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-muted/50">
                  <tr>
                    <th className="text-left p-1.5 w-[45%]">Description</th>
                    <th className="text-right p-1.5 w-[12%]">Qty</th>
                    <th className="text-right p-1.5 w-[18%]">Unit</th>
                    <th className="text-right p-1.5 w-[18%]">Total</th>
                    <th className="p-1.5 w-[7%]"></th>
                  </tr>
                </thead>
                <tbody>
                  {editForm.line_items.map((li, i) => (
                    <tr key={i} className="border-t">
                      <td className="p-1">
                        <Input
                          className="h-6 text-xs px-1"
                          value={li.description}
                          onChange={(e) => handleLineItemChange(i, "description", e.target.value)}
                        />
                      </td>
                      <td className="p-1">
                        <Input
                          type="number"
                          className="h-6 text-xs px-1 text-right"
                          value={li.quantity}
                          onChange={(e) => handleLineItemChange(i, "quantity", e.target.value)}
                        />
                      </td>
                      <td className="p-1">
                        <Input
                          type="number"
                          step="0.01"
                          className="h-6 text-xs px-1 text-right"
                          value={li.unit_price}
                          onChange={(e) => handleLineItemChange(i, "unit_price", e.target.value)}
                        />
                      </td>
                      <td className="p-1">
                        <Input
                          type="number"
                          step="0.01"
                          className="h-6 text-xs px-1 text-right"
                          value={li.total}
                          onChange={(e) => handleLineItemChange(i, "total", e.target.value)}
                        />
                      </td>
                      <td className="p-1 text-center">
                        <button
                          type="button"
                          className="text-muted-foreground hover:text-destructive"
                          onClick={() => handleRemoveLineItem(i)}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </td>
                    </tr>
                  ))}
                  {editForm.line_items.length === 0 && (
                    <tr>
                      <td colSpan={5} className="p-2 text-center text-muted-foreground italic">No line items</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div className="flex gap-2 pt-1">
            <Button
              size="sm"
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending}
              className="flex-1"
            >
              <Save className="h-3.5 w-3.5 mr-1" />
              {saveMutation.isPending ? "Saving…" : "Save Changes"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setEditMode(false)}
              disabled={saveMutation.isPending}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <>
           <SupplierConfirmationCard invoice={invoice} onConfirmed={onRefresh} />
           <SupplierMatchCard invoice={invoice} onLinked={onRefresh} />

          <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <div className="text-muted-foreground">Invoice #</div>
            <div className="font-medium">{invoice.invoice_number ?? "—"}</div>
            <div className="text-muted-foreground">Invoice Date</div>
            <div>{formatDate(invoice.invoice_date)}</div>
            <div className="text-muted-foreground">Due Date</div>
            <div>{formatDate(invoice.due_date)}</div>
            <div className="text-muted-foreground">Vendor TRN</div>
            <div className="font-mono text-xs">{invoice.vendor_tax_number ?? "—"}</div>
            <div className="text-muted-foreground">Subtotal</div>
            <div>{formatCurrency(invoice.subtotal, invoice.currency)}</div>
            <div className="text-muted-foreground">Tax</div>
            <div>{formatCurrency(invoice.tax_amount, invoice.currency)}</div>
            <div className="text-muted-foreground">Total</div>
            <div className="font-semibold text-base">{formatCurrency(invoice.total_amount, invoice.currency)}</div>
            {invoice.billing_country && (
              <>
                <div className="text-muted-foreground">Billing Country</div>
                <div className="flex items-center gap-1.5">
                  {(() => {
                    const meta = getCountryMetadataByCode(invoice.billing_country);
                    return meta ? (
                      <>
                        <span>{meta.flagEmoji}</span>
                        <span className="text-sm">{meta.name}</span>
                      </>
                    ) : (
                      <span className="font-mono text-xs">{invoice.billing_country}</span>
                    );
                  })()}
                </div>
              </>
            )}
            <div className="text-muted-foreground">AI Confidence</div>
            <div><ConfidenceBadge confidence={invoice.confidence} /></div>
            {invoice.odoo_bill_id && (
              <>
                <div className="text-muted-foreground">Odoo Bill</div>
                <div>
                  {invoice.odoo_bill_url ? (
                    <a href={invoice.odoo_bill_url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline flex items-center gap-1 text-xs">
                      #{invoice.odoo_bill_id} <ExternalLink className="h-3 w-3" />
                    </a>
                  ) : (
                    <span className="text-xs">#{invoice.odoo_bill_id}</span>
                  )}
                </div>
              </>
            )}
            {invoice.is_reviewed && invoice.reviewed_at && (
              <>
                <div className="text-muted-foreground">Reviewed</div>
                <div className="text-xs text-green-700">{formatDate(invoice.reviewed_at)}</div>
              </>
            )}
            {invoice.manually_entered_at && (
              <>
                <div className="text-muted-foreground">Entered At</div>
                <div className="text-xs">{formatDate(invoice.manually_entered_at)}</div>
                {invoice.manual_accounting_reference && (
                  <>
                    <div className="text-muted-foreground">Ref</div>
                    <div className="text-xs font-mono">{invoice.manual_accounting_reference}</div>
                  </>
                )}
              </>
            )}
          </div>

          {lineItems.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Line Items ({lineItems.length})</p>
              <div className="border rounded-md overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="text-left p-2">Description</th>
                      <th className="text-right p-2">Qty</th>
                      <th className="text-right p-2">Unit</th>
                      <th className="text-right p-2">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lineItems.map((li, i) => (
                      <tr key={i} className="border-t">
                        <td className="p-2 max-w-[140px] truncate">{li.description}</td>
                        <td className="p-2 text-right">{li.quantity}</td>
                        <td className="p-2 text-right">{li.unit_price?.toFixed(2)}</td>
                        <td className="p-2 text-right font-medium">{li.total?.toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {invoice.source === "scanner" && (
            <div className="border-t pt-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Source</p>
              <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                <div className="text-muted-foreground">Source</div>
                <div className="font-medium">Scanner</div>
                {invoice.scanner_station_name && (
                  <>
                    <div className="text-muted-foreground">Station</div>
                    <div>{invoice.scanner_station_name}</div>
                  </>
                )}
                {invoice.captured_at && (
                  <>
                    <div className="text-muted-foreground">Captured At</div>
                    <div className="text-xs">{new Date(invoice.captured_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</div>
                  </>
                )}
                {invoice.uploaded_at && (
                  <>
                    <div className="text-muted-foreground">Uploaded At</div>
                    <div className="text-xs">{new Date(invoice.uploaded_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}</div>
                  </>
                )}
              </div>
            </div>
          )}

          <div className="border-t pt-2">
            <EditHistorySection invoiceId={invoice.id} />
          </div>

          {invoice.is_reviewed && canSendToOdoo && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-green-50 border border-green-200 text-green-800 text-xs">
              <BadgeCheck className="h-3.5 w-3.5 shrink-0" />
              <span>Corrected data will be sent to Odoo</span>
            </div>
          )}

          {canResendToOdoo && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-md bg-amber-50 border border-amber-200 text-amber-800 text-xs">
              <BadgeCheck className="h-3.5 w-3.5 shrink-0" />
              <span>This invoice was already sent. Resending will overwrite the existing Odoo draft bill.</span>
            </div>
          )}

          <div className="flex flex-wrap gap-2 pt-2 border-t">
            {!isProcessing && (
              <Button size="sm" variant="outline" onClick={handleEditToggle}>
                <Pencil className="h-3.5 w-3.5 mr-1" />
                Edit Fields
              </Button>
            )}
            {canSendToOdoo && (
              <Button
                size="sm"
                variant="default"
                onClick={() => sendToOdooMutation.mutate()}
                disabled={sendToOdooMutation.isPending}
              >
                <Send className="h-3.5 w-3.5 mr-1" />
                {sendToOdooMutation.isPending ? "Sending…" : invoice.status === "failed" ? "Retry in Odoo" : "Send to Odoo"}
              </Button>
            )}
            {canResendToOdoo && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => sendToOdooMutation.mutate()}
                disabled={sendToOdooMutation.isPending}
              >
                <Send className="h-3.5 w-3.5 mr-1" />
                {sendToOdooMutation.isPending ? "Resending…" : "Resend to Odoo"}
              </Button>
            )}
            {invoice.status === "sent_to_odoo" && invoice.odoo_bill_url && (
              <Button size="sm" variant="outline" asChild>
                <a href={invoice.odoo_bill_url} target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-3.5 w-3.5 mr-1" />
                  View in Odoo
                </a>
              </Button>
            )}
            {(invoice.status === "ready_for_manual_entry" || invoice.status === "extracted" || invoice.status === "needs_review") && (
              <>
                <Button size="sm" variant="outline" onClick={() => setManualEntryOpen(true)}>
                  <Check className="h-3.5 w-3.5 mr-1" />
                  Mark Entered
                </Button>
                <ConfirmButton invoiceId={invoice.id} onConfirmed={onRefresh} />
              </>
            )}
            <Button size="sm" variant="outline" onClick={() => handleExport("csv")}>
              <Download className="h-3.5 w-3.5 mr-1" />
              CSV
            </Button>
            <Button size="sm" variant="outline" onClick={() => handleExport("json")}>
              <Download className="h-3.5 w-3.5 mr-1" />
              JSON
            </Button>
            <Button size="sm" variant="outline" onClick={handleBundle}>
              <Download className="h-3.5 w-3.5 mr-1" />
              Bundle
            </Button>
            <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={handleDelete}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </>
      )}
      </div>
    </div>
  );
}

export default function AiInvoiceImportPage() {
  const { t } = useTranslation();
  const { isOwner } = useWorkspaceRole();
  const { toast } = useToast();
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [location, setLocation] = useLocation();
  const initialQueueContext = useMemo(
    () => new URLSearchParams(location.includes("?") ? location.slice(location.indexOf("?") + 1) : ""),
    // Queue context is intentionally restored only when this page mounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const [selectedEntityId, setSelectedEntityId] = useState<number | null>(() => {
    const value = Number(initialQueueContext.get("entity_id"));
    return Number.isInteger(value) && value > 0 ? value : null;
  });
  const [newEntityOpen, setNewEntityOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadFailures, setUploadFailures] = useState<Array<{ filename: string; import_id: number; error: string }>>([]);
  const [dragOver, setDragOver] = useState(false);
  const [refreshInterval, setRefreshInterval] = useState<number | false>(false);
  const [entityPickerOpen, setEntityPickerOpen] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [pickerEntityId, setPickerEntityId] = useState<number | null>(null);
  const [historicalReport, setHistoricalReport] = useState<OdooBulkResult | null>(null);
  const [odooAuditReport, setOdooAuditReport] = useState<{
    audited: number;
    counts: Record<string, number>;
    audit_complete: boolean;
    next_after_id: number;
  } | null>(null);
  const initialReviewStatus = initialQueueContext.get("review_status") ?? "all";
  const initialSyncStatus = initialQueueContext.get("sync_status") ?? "all";
  const initialTab = initialQueueContext.get("tab") as InvoiceQueueTab | null;
  const [reviewFilter, setReviewFilter] = useState(initialReviewStatus);
  const [syncFilter, setSyncFilter] = useState<InvoiceQueueFilter>(
    initialReviewStatus === "approved" && initialSyncStatus === "not_requested"
      ? "ready_to_sync"
      : initialSyncStatus as InvoiceQueueFilter,
  );
  const [dateFrom, setDateFrom] = useState(() => initialQueueContext.get("date_from") ?? "");
  const [dateTo, setDateTo] = useState(() => initialQueueContext.get("date_to") ?? "");
  const [search, setSearch] = useState(() => initialQueueContext.get("search") ?? "");
  const initialPageSize = Number(initialQueueContext.get("limit"));
  const [pageSize, setPageSize] = useState(
    Number.isInteger(initialPageSize) && [10, 25, 50].includes(initialPageSize) ? initialPageSize : 10,
  );
  const [page, setPage] = useState(() => Math.floor(Math.max(Number(initialQueueContext.get("offset")) || 0, 0) / pageSize));
  const [queueTab, setQueueTab] = useState<InvoiceQueueTab>(
    initialTab && ["all", "needs_review", "ready_to_sync", "sync_failed", "succeeded"].includes(initialTab)
      ? initialTab
      : "all",
  );
  const [sortOrder, setSortOrder] = useState<"created_at_desc" | "invoice_date_asc" | "invoice_date_desc" | "attention_first">(
    (initialQueueContext.get("order") as "created_at_desc" | "invoice_date_asc" | "invoice_date_desc" | "attention_first") ?? "created_at_desc",
  );
  const [showMoreFilters, setShowMoreFilters] = useState(false);
  const [selectedInvoiceIds, setSelectedInvoiceIds] = useState<Record<number, boolean>>({});
  const [approvalWorkingId, setApprovalWorkingId] = useState<number | null>(null);
  const [pendingApprovalWarnings, setPendingApprovalWarnings] = useState<{
    mode: "single" | "bulk";
    invoiceIds: number[];
    warnings: ApprovalWarning[];
  } | null>(null);
  const [bulkWorking, setBulkWorking] = useState(false);
  const [bulkResults, setBulkResults] = useState<Array<{ invoice_id: number; status: "succeeded" | "failed"; message?: string }>>([]);
  const { data: entitiesData, isLoading: entitiesLoading } = useQuery({
    queryKey: ["finance-entities"],
    queryFn: async () => {
      const result = await apiFetch<{ entities: FinanceEntity[] }>("/api/finance/entities");
      return result.entities;
    },
  });

  const entities = entitiesData ?? [];
  const selectedEntity = entities.find((e) => e.id === selectedEntityId) ?? null;

  const { data: importsData, isLoading: importsLoading, isError: importsError, error: importsQueryError, refetch: refetchImports } = useQuery({
    queryKey: ["finance-imports", selectedEntityId, reviewFilter, syncFilter, queueTab, dateFrom, dateTo, search, sortOrder, pageSize, page],
    queryFn: async () => {
      const query = buildInvoiceQueueQuery({
        entityId: selectedEntityId,
        reviewStatus: reviewFilter,
        syncStatus: syncFilter,
        dateFrom,
        dateTo,
        search,
        page,
        pageSize,
        tab: queueTab,
        order: sortOrder,
      });
      return apiFetch<{
        imports: InvoiceImport[];
        canonicalized_ids?: Record<string, number>;
        total: number;
        filtered_total?: number;
        counts?: Record<InvoiceQueueTab, number>;
      }>(`/api/finance/invoice-review/queue?${query}`);
    },
    refetchInterval: refreshInterval,
    enabled: true,
  });
  useEffect(() => {
    if (!importsData) return;
    const canonicalized = importsData.canonicalized_ids ?? {};
    const visibleIds = new Set(importsData.imports.map((invoice) => invoice.id));
    setSelectedInvoiceIds((current) => {
      const next: Record<number, boolean> = {};
      for (const [rawId, selected] of Object.entries(current)) {
        if (!selected) continue;
        const oldId = Number(rawId);
        const canonicalId = canonicalized[rawId] ?? oldId;
        if (visibleIds.has(canonicalId)) next[canonicalId] = true;
      }
      const before = Object.keys(current).filter((key) => current[Number(key)]).sort().join(",");
      const after = Object.keys(next).sort().join(",");
      return before === after ? current : next;
    });
  }, [importsData]);

  const historicalOdooSyncMutation = useMutation({
    mutationFn: async () => {
      let afterId = 0;
      const aggregate: OdooBulkResult = {
        success: true,
        selected: 0,
        synced: 0,
        failed: 0,
        skipped: 0,
        created: 0,
        recovered: 0,
        verified_existing: 0,
        stale_repaired: 0,
        has_more: false,
        next_after_id: 0,
        reason_breakdown: {},
        confirmations: [],
        results: [],
      };
      do {
        const pageResult = await apiFetch<OdooBulkResult>("/api/finance/invoice-review/sync-approved-to-odoo", {
          method: "POST",
          body: JSON.stringify({ entity_id: selectedEntityId, after_id: afterId }),
        });
        aggregate.success = aggregate.success && pageResult.success;
        aggregate.selected += pageResult.selected;
        aggregate.synced += pageResult.synced;
        aggregate.failed += pageResult.failed;
        aggregate.skipped += pageResult.skipped;
        aggregate.created = (aggregate.created ?? 0) + (pageResult.created ?? 0);
        aggregate.recovered = (aggregate.recovered ?? 0) + (pageResult.recovered ?? 0);
        aggregate.verified_existing = (aggregate.verified_existing ?? 0) + (pageResult.verified_existing ?? 0);
        aggregate.stale_repaired = (aggregate.stale_repaired ?? 0) + (pageResult.stale_repaired ?? 0);
        aggregate.blocked = (aggregate.blocked ?? 0) + (pageResult.blocked ?? 0);
        aggregate.needs_supplier_confirmation = (aggregate.needs_supplier_confirmation ?? 0) + (pageResult.needs_supplier_confirmation ?? 0);
        aggregate.confirmations?.push(...(pageResult.confirmations ?? []));
        aggregate.results?.push(...(pageResult.results ?? []));
        for (const [key, value] of Object.entries(pageResult.reason_breakdown ?? {})) {
          aggregate.reason_breakdown![key] = (aggregate.reason_breakdown![key] ?? 0) + value;
        }
        aggregate.has_more = pageResult.has_more;
        aggregate.next_after_id = pageResult.next_after_id;
        if (!pageResult.has_more) break;
        if (pageResult.next_after_id <= afterId) throw new Error("Historical Odoo sync cursor did not advance");
        afterId = pageResult.next_after_id;
      } while (aggregate.has_more);
      return aggregate;
    },
    onSuccess: (result) => {
      setHistoricalReport(result);
      qc.invalidateQueries({ queryKey: ["finance-imports"] });
      toast({
        title: result.failed || result.blocked || result.needs_supplier_confirmation ? "Bulk Odoo sync completed with review items" : "Bulk Odoo sync completed",
        description: `Synced: ${(result.created ?? 0)} · Recovered/already in Odoo: ${(result.recovered ?? 0) + (result.verified_existing ?? 0)} · Needs confirmation: ${result.needs_supplier_confirmation ?? 0} · Blocked: ${result.blocked ?? 0} · Failed: ${result.failed}`,
        variant: result.failed ? "destructive" : "default",
      });
    },
    onError: (error) => {
      toast({
        title: "Historical Odoo sync could not start",
        description: error instanceof Error ? error.message : String(error),
        variant: "destructive",
      });
    },
  });

  const odooAuditMutation = useMutation({
    mutationFn: async () => {
      let afterId = 0;
      const aggregate = { audited: 0, counts: {} as Record<string, number>, audit_complete: false, next_after_id: 0 };
      do {
        const page = await apiFetch<typeof aggregate>("/api/finance/invoice-review/audit-approved-to-odoo?" + new URLSearchParams({
          entity_id: String(selectedEntityId),
          after_id: String(afterId),
        }));
        aggregate.audited += page.audited;
        aggregate.next_after_id = page.next_after_id;
        aggregate.audit_complete = page.audit_complete;
        for (const [key, value] of Object.entries(page.counts ?? {})) aggregate.counts[key] = (aggregate.counts[key] ?? 0) + value;
        if (page.audit_complete) break;
        if (page.next_after_id <= afterId) throw new Error("Odoo audit cursor did not advance");
        afterId = page.next_after_id;
      } while (!aggregate.audit_complete);
      return aggregate;
    },
    onSuccess: (result) => {
      setOdooAuditReport(result);
      toast({ title: "Read-only Odoo audit complete", description: `${result.audited} approved records classified. No bills were created.` });
    },
    onError: (error) => {
      toast({ title: "Odoo audit failed", description: error instanceof Error ? error.message : String(error), variant: "destructive" });
    },
  });

  // Live-update when a scanner station uploads a new import.
  useAuthedSse(`${BASE}/api/events`, true, {
    "finance.scanner_import.created": () => {
      qc.invalidateQueries({ queryKey: ["finance-imports"] });
    },
  });

  const imports = importsData?.imports ?? [];
  const total = importsData?.total ?? 0;
  const queueCounts: Record<InvoiceQueueTab, number> = importsData?.counts ?? {
    all: 0,
    needs_review: 0,
    ready_to_sync: 0,
    sync_failed: 0,
    succeeded: 0,
  };
  const selectableImports = imports.filter((imp) => imp.review_status === "needs_review"
    && Number(imp.blocking_issue_count ?? 0) === 0
    && ["not_requested", "failed"].includes(imp.sync_status ?? "not_requested"));
  const retryableImports = imports.filter((imp) => getInvoiceDisplayState(imp) === "sync_failed");
  const selectedImports = selectableImports.filter((imp) => selectedInvoiceIds[imp.id]);
  const selectedRetryImports = retryableImports.filter((imp) => selectedInvoiceIds[imp.id]);
  const selectedRows = imports.filter((imp) => selectedInvoiceIds[imp.id]);
  const selectedSyncImports = selectedRows.filter((imp) => getInvoiceDisplayState(imp) === "ready_to_sync" && imp.review_status === "approved" && Number(imp.blocking_issue_count ?? 0) === 0);
  const selectedEligible = [...selectedSyncImports, ...selectedRetryImports];
  const selectedIneligible = selectedRows.filter((imp) => !["ready_to_sync", "sync_failed"].includes(getInvoiceDisplayState(imp)));

  const updateImportInQueue = (id: number, patch: Partial<InvoiceImport>) => {
    qc.setQueryData(
      ["finance-imports", selectedEntityId, reviewFilter, syncFilter, queueTab, dateFrom, dateTo, search, sortOrder, pageSize, page],
      (current: { imports: InvoiceImport[]; total: number } | undefined) => current
        ? { ...current, imports: current.imports.map((imp) => imp.id === id ? { ...imp, ...patch } : imp) }
        : current,
    );
  };

  const approveWithoutSync = async (imp: InvoiceImport) => {
    const version = Number(imp.review_version);
    if (!Number.isInteger(version) || version <= 0) throw new Error("This invoice is missing a valid review version");
    const result = await apiFetch<{ invoice?: InvoiceImport }>(`/api/finance/invoice-review/${imp.id}/approve`, {
      method: "POST",
      body: JSON.stringify({ version, sync: false }),
    });
    updateImportInQueue(imp.id, {
      review_status: "approved",
      sync_status: "not_requested",
      review_version: Number(result.invoice?.review_version ?? version + 1),
      blocking_issue_count: 0,
    });
    return result;
  };

  const fetchApprovalWarnings = async (imp: InvoiceImport): Promise<ApprovalWarning[]> => {
    if (Number(imp.warning_issue_count ?? 0) === 0) return [];
    const detail = await apiFetch<ApprovalDetail>(`/api/finance/invoice-review/${imp.id}`);
    const invoice = detail.invoice ?? detail.import;
    const version = Number(invoice?.review_version ?? imp.review_version);
    const acknowledged = new Set(
      (detail.acknowledgements ?? [])
        .filter((ack) => !ack.version || Number(ack.version) === version)
        .map((ack) => ack.issue_key),
    );
    return (detail.validation?.issues ?? [])
      .filter((issue) => !issue.blocking && issue.severity !== "error" && issue.issue_key && !acknowledged.has(issue.issue_key))
      .map((issue) => ({
        invoiceId: imp.id,
        invoiceLabel: imp.invoice_number ?? `#${imp.id}`,
        issueKey: issue.issue_key!,
        message: issue.message ?? "Review warning",
        version,
      }));
  };

  const approveSelected = async (invoiceIds: number[]) => {
    const versions = Object.fromEntries(
      invoiceIds.map((id) => {
        const imp = imports.find((item) => item.id === id);
        return [String(id), Number(imp?.review_version)];
      }),
    );
    const result = await apiFetch<{
      approved: number;
      blocked: number;
      skipped: number;
      results: Array<{
        invoice_id: number;
        status: string;
        reason?: string;
        canonical_invoice_id?: number;
        review_version?: number;
      }>;
    }>("/api/finance/invoice-review/approve-selected", {
      method: "POST",
      body: JSON.stringify({ invoice_ids: invoiceIds, versions }),
    });
    const resultByRequestedId = new Map(result.results.map((item) => [item.invoice_id, item]));
    qc.setQueryData(
      ["finance-imports", selectedEntityId, reviewFilter, syncFilter, queueTab, dateFrom, dateTo, search, sortOrder, pageSize, page],
      (current: { imports: InvoiceImport[]; total: number } | undefined) => {
        if (!current) return current;
        const removedIds = new Set(
          result.results
            .filter((item) => item.canonical_invoice_id && item.canonical_invoice_id !== item.invoice_id)
            .map((item) => item.invoice_id),
        );
        return {
          ...current,
          total: Math.max(0, current.total - removedIds.size),
          imports: current.imports
            .filter((imp) => !removedIds.has(imp.id))
            .map((imp) => {
              const direct = resultByRequestedId.get(imp.id);
              const canonical = result.results.find((item) => item.canonical_invoice_id === imp.id && item.status === "approved");
              const approved = direct?.status === "approved" ? direct : canonical;
              return approved
                ? {
                    ...imp,
                    review_status: "approved",
                    sync_status: "not_requested",
                    review_version: approved.review_version ?? imp.review_version,
                    blocking_issue_count: 0,
                  }
                : imp;
            }),
        };
      },
    );
    setSelectedInvoiceIds({});
    qc.invalidateQueries({ queryKey: ["finance-imports"] });
    const attention = result.blocked + result.skipped;
    toast({
      title: attention ? "Approval completed with review items" : "Invoices approved",
      description: `${result.approved} approved${attention ? ` · ${result.blocked} blocked · ${result.skipped} skipped` : ""}. Approved invoices are ready for Bulk Sync.`,
      variant: attention ? "destructive" : "default",
    });
    return result;
  };

  const prepareSingleApproval = async (imp: InvoiceImport) => {
    setApprovalWorkingId(imp.id);
    try {
      const warnings = await fetchApprovalWarnings(imp);
      if (warnings.length > 0) {
        setPendingApprovalWarnings({ mode: "single", invoiceIds: [imp.id], warnings });
        return;
      }
      await approveWithoutSync(imp);
      setSelectedInvoiceIds((current) => ({ ...current, [imp.id]: false }));
      qc.invalidateQueries({ queryKey: ["finance-imports"] });
      toast({ title: "Invoice approved", description: "It is ready for Bulk Sync." });
    } catch (error) {
      toast({ title: "Invoice could not be approved", description: error instanceof Error ? error.message : String(error), variant: "destructive" });
    } finally {
      setApprovalWorkingId(null);
    }
  };

  const prepareBulkApproval = async () => {
    const invoiceIds = selectedImports.map((imp) => imp.id);
    if (invoiceIds.length === 0) return;
    setApprovalWorkingId(-1);
    try {
      await approveSelected(invoiceIds);
    } catch (error) {
      toast({ title: "Selected invoices could not be approved", description: error instanceof Error ? error.message : String(error), variant: "destructive" });
    } finally {
      setApprovalWorkingId(null);
    }
  };

  const acknowledgeAndApprove = async () => {
    if (!pendingApprovalWarnings) return;
    const pending = pendingApprovalWarnings;
    setApprovalWorkingId(pending.mode === "bulk" ? -1 : pending.invoiceIds[0]);
    try {
      for (const warning of pending.warnings) {
        await apiFetch(`/api/finance/invoice-review/${warning.invoiceId}/acknowledge`, {
          method: "POST",
          body: JSON.stringify({ issue_key: warning.issueKey, version: warning.version }),
        });
      }
      setPendingApprovalWarnings(null);
      if (pending.mode === "bulk") {
        await approveSelected(pending.invoiceIds);
      } else {
        const imp = imports.find((item) => item.id === pending.invoiceIds[0]);
        if (!imp) throw new Error("Invoice is no longer in this queue");
        await approveWithoutSync(imp);
        setSelectedInvoiceIds((current) => ({ ...current, [imp.id]: false }));
        qc.invalidateQueries({ queryKey: ["finance-imports"] });
        toast({ title: "Warning acknowledged and invoice approved", description: "It is ready for Bulk Sync." });
      }
    } catch (error) {
      toast({ title: "Approval could not be completed", description: error instanceof Error ? error.message : String(error), variant: "destructive" });
    } finally {
      setApprovalWorkingId(null);
    }
  };

  const kpis = {
    total,
    processing: imports.filter((i) => i.status === "uploaded" || i.status === "processing").length,
    ready: imports.filter((i) => i.status === "ready_for_manual_entry" || i.status === "extracted").length,
    failed: imports.filter((i) => i.status === "failed").length,
    entered: imports.filter((i) => i.status === "manually_entered" || i.status === "sent_to_odoo").length,
  };

  const hasProcessing = kpis.processing > 0;
  if (hasProcessing && !refreshInterval) setRefreshInterval(3000);
  if (!hasProcessing && refreshInterval) setRefreshInterval(false);

  const uploadFiles = useCallback(async (files: File[], overrideEntityId?: number) => {
    const entityId = overrideEntityId ?? selectedEntityId;
    if (!entityId) {
      setPendingFiles(files);
      setPickerEntityId(null);
      setEntityPickerOpen(true);
      return;
    }
    const supported = files.filter((f) => {
      const ext = f.name.toLowerCase().match(/\.[^.]+$/)?.[0] ?? "";
      return SUPPORTED_UPLOAD_TYPES.has(f.type) || SUPPORTED_UPLOAD_EXTS.has(ext);
    });
    if (supported.length === 0) {
      toast({ title: "Only PDF, JPG, PNG, or WEBP files are supported", variant: "destructive" });
      return;
    }
    const oversized = supported.filter((file) => file.size > MAX_UPLOAD_BYTES);
    for (const file of oversized) {
      toast({ title: `${file.name} is too large`, description: "Invoice files must be 20 MB or smaller.", variant: "destructive" });
    }
    const accepted = supported.filter((file) => file.size <= MAX_UPLOAD_BYTES);
    if (accepted.length === 0) return;
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("entity_id", String(entityId));
      for (const f of accepted) formData.append("files", f);
      const result = await apiFetch<{ import_ids: number[]; failures?: Array<{ filename: string; import_id: number; error: string }> }>("/api/finance/ai-invoice-import/upload", {
        method: "POST",
        body: formData,
      });
      if (result.import_ids.length) toast({ title: `${result.import_ids.length} invoice(s) uploaded — AI extraction started` });
      setUploadFailures(result.failures ?? []);
      for (const failure of result.failures ?? []) {
        toast({ title: `${failure.filename} was not stored`, description: `${failure.error}. The invoice record was kept; select it to replace the attachment.`, variant: "destructive" });
      }
      qc.invalidateQueries({ queryKey: ["finance-imports"] });
      setRefreshInterval(3000);
    } catch (err) {
      setUploadFailures([{ filename: "Upload", import_id: 0, error: String(err instanceof Error ? err.message : err) }]);
      toast({ title: "Upload failed", description: String(err instanceof Error ? err.message : err), variant: "destructive" });
    } finally {
      setUploading(false);
    }
  }, [selectedEntityId, toast, qc]);

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    void uploadFiles(files);
  }, [uploadFiles]);

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) void uploadFiles(files);
    e.target.value = "";
  };

  const runBulkSync = async (rows: InvoiceImport[]) => {
    if (rows.length === 0 || bulkWorking) return;
    setBulkWorking(true);
    setBulkResults([]);
    const retrying = rows.every((imp) => getInvoiceDisplayState(imp) === "sync_failed");
    const versions = Object.fromEntries(rows.map((imp) => [String(imp.id), Number(imp.review_version)]));
    const idempotency_keys = Object.fromEntries(rows.map((imp) => [String(imp.id), `queue:${imp.id}:${imp.review_version}:${Date.now()}`]));
    let results: Array<{ invoice_id: number; status: "succeeded" | "failed"; message?: string }>;
    try {
      const response = await apiFetch<{
        results?: Array<{ invoice_id: number; status: "succeeded" | "failed" | "ineligible"; message?: string }>;
      }>("/api/finance/invoice-review/bulk-sync", {
        method: "POST",
        body: JSON.stringify({
          action: retrying ? "retry" : "sync",
          invoice_ids: rows.map((imp) => imp.id),
          versions,
          idempotency_keys,
        }),
      });
      results = (response.results ?? []).map((result) => ({
        invoice_id: result.invoice_id,
        // Canonical duplicates and already-completed rows are successful bulk
        // outcomes, not user-facing failures. Only an explicit failed result
        // should make the batch appear unsuccessful.
        status: result.status === "failed" ? "failed" : "succeeded",
        message: result.message,
      }));
    } catch (error) {
      results = rows.map((imp) => ({
        invoice_id: imp.id,
        status: "failed" as const,
        message: error instanceof Error ? error.message : String(error),
      }));
    }
    setBulkResults(results);
    setBulkWorking(false);
    setSelectedInvoiceIds({});
    await qc.invalidateQueries({ queryKey: ["finance-imports"] });
    const failed = results.filter((item) => item.status === "failed").length;
    toast({
      title: failed ? "Bulk action completed with failures" : "Bulk action completed",
      description: `${results.length - failed} completed · ${failed} failed`,
      variant: failed ? "destructive" : "default",
    });
  };

  const handleImportClick = (imp: InvoiceImport, focus?: string) => {
    const context = new URLSearchParams({
      limit: String(pageSize),
      offset: String(page * pageSize),
      order: sortOrder,
    });
    if (selectedEntityId) context.set("entity_id", String(selectedEntityId));
    if (queueTab !== "all") {
      context.set("tab", queueTab);
    } else if (syncFilter === "ready_to_sync") {
      context.set("review_status", "approved");
      context.set("sync_status", "not_requested");
    } else {
      if (reviewFilter !== "all") context.set("review_status", reviewFilter);
      if (syncFilter !== "all") context.set("sync_status", syncFilter);
    }
    if (dateFrom) context.set("date_from", dateFrom);
    if (dateTo) context.set("date_to", dateTo);
    if (search.trim()) context.set("search", search.trim());
    if (focus) context.set("focus", focus);
    setLocation(`/ai-invoice-import/${imp.id}/review?${context}`);
  };

  if (entitiesLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (entities.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4">
        <Building2 className="h-12 w-12 text-muted-foreground/40" />
        <div className="text-center">
          <h3 className="text-lg font-semibold">No legal entities configured</h3>
          <p className="text-sm text-muted-foreground mt-1">Add a legal entity to start importing invoices</p>
        </div>
        {isOwner && (
          <>
            <Button onClick={() => setNewEntityOpen(true)}>
              <Plus className="h-4 w-4 mr-2" />
              Add Entity
            </Button>
            <NewEntityDialog
              open={newEntityOpen}
              onClose={() => setNewEntityOpen(false)}
              onCreated={(e) => { setSelectedEntityId(e.id); qc.invalidateQueries({ queryKey: ["finance-entities"] }); }}
            />
          </>
        )}
      </div>
    );
  }

  return (
    <div
      className="flex flex-col gap-6 pb-8"
      onDragOver={(event) => { event.preventDefault(); if (!uploading) setDragOver(true); }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragOver(false);
      }}
    >
      <NewEntityDialog
        open={newEntityOpen}
        onClose={() => setNewEntityOpen(false)}
        onCreated={(e) => { setSelectedEntityId(e.id); qc.invalidateQueries({ queryKey: ["finance-entities"] }); }}
      />
      {selectedEntity && (
        <EntitySettingsDialog entity={selectedEntity} open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      )}

      <Dialog open={entityPickerOpen} onOpenChange={(open) => { if (!open) { setEntityPickerOpen(false); setPendingFiles([]); } }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Select an entity to upload to</DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <Label className="text-sm text-muted-foreground mb-2 block">
              Choose which legal entity these invoices belong to before uploading.
            </Label>
            <Select
              value={pickerEntityId ? String(pickerEntityId) : ""}
              onValueChange={(v) => setPickerEntityId(parseInt(v, 10))}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select entity…" />
              </SelectTrigger>
              <SelectContent>
                {entities.map((e) => {
                  const countryMeta = e.country ? getCountryMetadataByCode(e.country) : null;
                  return (
                    <SelectItem key={e.id} value={String(e.id)}>
                      <span className="flex items-center gap-1.5">
                        {e.display_name ?? e.legal_name}
                        {countryMeta && (
                          <span className="text-muted-foreground text-xs flex items-center gap-1">
                            <span>{countryMeta.flagEmoji}</span>
                            <span>{countryMeta.name}</span>
                          </span>
                        )}
                      </span>
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setEntityPickerOpen(false); setPendingFiles([]); }}>
              Cancel
            </Button>
            <Button
              disabled={!pickerEntityId}
              onClick={() => {
                if (!pickerEntityId) return;
                setEntityPickerOpen(false);
                setSelectedEntityId(pickerEntityId);
                const files = pendingFiles;
                setPendingFiles([]);
                void uploadFiles(files, pickerEntityId);
              }}
            >
              Upload
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(pendingApprovalWarnings)}
        onOpenChange={(open) => { if (!open && approvalWorkingId === null) setPendingApprovalWarnings(null); }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Acknowledge warnings before approval</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            These warnings are non-blocking. Acknowledge them to approve the invoice(s). Approval will not start accounting sync.
          </p>
          <div className="max-h-64 overflow-y-auto space-y-3 rounded-md border p-3">
            {pendingApprovalWarnings?.warnings.map((warning, index) => (
              <div key={`${warning.invoiceId}-${warning.issueKey}-${index}`} className="text-sm">
                <p className="font-medium">{warning.invoiceLabel}</p>
                <p className="text-muted-foreground">{warning.message}</p>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingApprovalWarnings(null)} disabled={approvalWorkingId !== null}>Cancel</Button>
            <Button data-testid="button-acknowledge-and-approve" onClick={() => void acknowledgeAndApprove()} disabled={approvalWorkingId !== null}>
              {approvalWorkingId !== null && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Acknowledge & approve
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="flex items-start justify-between gap-6 flex-wrap">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Supplier bills</h1>
          <p className="mt-1 text-sm text-muted-foreground">Review, approve and sync supplier bills.</p>
        </div>
        <div className="flex items-start gap-2 flex-wrap">
          <div className="text-right">
            <Button
              data-testid="button-upload-bills"
              className="gap-2"
              disabled={uploading}
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload className="h-4 w-4" />
              <span>Upload bills</span>
            </Button>
            <p className="mt-1 text-xs text-muted-foreground">PDFs or images</p>
          </div>
          <div className={showMoreFilters ? "flex items-center gap-2 flex-wrap" : "hidden"}>
          {selectedEntity && (
            <div className="flex items-center gap-1">
              {selectedEntity.accounting_system === "odoo" && (
                <Badge variant={selectedEntity.odoo_integration_configured ? "default" : "outline"} className="text-xs">
                  {selectedEntity.odoo_integration_configured ? "Odoo connected" : "Odoo not configured"}
                </Badge>
              )}
              {selectedEntity.accounting_system === "odoo" && selectedEntity.odoo_default_expense_account_id == null && (
                <div
                  data-testid="odoo-expense-account-warning"
                  className="flex items-center gap-1 text-xs text-amber-700"
                  role="alert"
                >
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                  <span id="odoo-expense-account-warning-text">Default expense account not configured; syncing is unavailable until it is set.</span>
                  {isOwner && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-1.5 text-xs text-amber-800"
                      onClick={() => setSettingsOpen(true)}
                    >
                      Entity Settings
                    </Button>
                  )}
                </div>
              )}
              {selectedEntity.accounting_system === "manual" && (
                <Badge variant="outline" className="text-xs">Manual entry</Badge>
              )}
              {selectedEntity.accounting_system === "wafeq" && (
                <Badge variant="outline" className="text-xs">Wafeq</Badge>
              )}
              {selectedEntity.accounting_system === "quickbooks" && (
                <Badge variant="outline" className="text-xs">QuickBooks</Badge>
              )}
               <Badge data-testid="badge-invoice-workflow" variant="default" className="text-xs">
                 Review required
               </Badge>
             </div>
           )}
           {selectedEntity?.accounting_system === "odoo" && selectedEntity.odoo_integration_configured && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="button-audit-historical-odoo"
                  disabled={odooAuditMutation.isPending}
                  onClick={() => odooAuditMutation.mutate()}
                >
                  <FileSearch className="h-3.5 w-3.5 mr-1" />
                  {odooAuditMutation.isPending ? "Auditing…" : "Audit Odoo backlog"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  data-testid="button-sync-historical-odoo"
                  disabled={historicalOdooSyncMutation.isPending || selectedEntity.odoo_default_expense_account_id == null}
                  aria-disabled={selectedEntity.odoo_default_expense_account_id == null || undefined}
                  aria-describedby={selectedEntity.odoo_default_expense_account_id == null ? "odoo-expense-account-warning-text" : undefined}
                  onClick={() => {
                    if (!window.confirm("Sync all approved invoices for this Odoo entity? Existing Odoo bills are live-verified and will not be duplicated.")) return;
                    historicalOdooSyncMutation.mutate();
                  }}
                >
                  <Send className="h-3.5 w-3.5 mr-1" />
                  {historicalOdooSyncMutation.isPending ? "Syncing historical…" : "Sync approved invoices to Odoo"}
                </Button>
              </>
           )}
           {isOwner && (
            <>
              <Button variant="outline" size="sm" onClick={() => setNewEntityOpen(true)}>
                <Plus className="h-4 w-4" />
              </Button>
              {selectedEntity && (
                <Button variant="outline" size="sm" data-testid="button-invoice-entity-settings" onClick={() => setSettingsOpen(true)}>
                  <Settings className="h-4 w-4" />
                </Button>
              )}
            </>
          )}
          </div>
        </div>
      </div>

      {(odooAuditReport || historicalReport) && (
        <Card data-testid="odoo-sync-report">
          <CardContent className="pt-4 space-y-3">
            {odooAuditReport && (
              <div>
                <div className="flex items-center justify-between gap-2">
                  <p className="font-medium text-sm">Read-only Odoo audit</p>
                  <Badge variant="outline">{odooAuditReport.audited} records</Badge>
                </div>
                <div className="flex flex-wrap gap-2 mt-2">
                  {Object.entries(odooAuditReport.counts).map(([reason, count]) => (
                    <Badge key={reason} variant="secondary">{reason.replaceAll("_", " ")}: {count}</Badge>
                  ))}
                </div>
              </div>
            )}
            {historicalReport && (
              <div className={odooAuditReport ? "border-t pt-3" : ""}>
                <div className="flex items-center justify-between gap-2">
                  <p className="font-medium text-sm">Latest bulk sync</p>
                  <span className="text-xs text-muted-foreground">
                    Synced: {historicalReport.created ?? 0} · Recovered/already in Odoo: {(historicalReport.recovered ?? 0) + (historicalReport.verified_existing ?? 0)} · Needs supplier confirmation: {historicalReport.needs_supplier_confirmation ?? 0} · Blocked: {historicalReport.blocked ?? 0} · Failed: {historicalReport.failed}
                  </span>
                </div>
                <div className="flex flex-wrap gap-2 mt-2">
                  <Badge variant="secondary" className="border-green-200 bg-green-50 text-green-800">Synced: {historicalReport.created ?? 0}</Badge>
                  <Badge variant="secondary">Recovered/already in Odoo: {(historicalReport.recovered ?? 0) + (historicalReport.verified_existing ?? 0)}</Badge>
                  <Badge variant="secondary" className="border-amber-200 bg-amber-50 text-amber-800">Needs supplier confirmation: {historicalReport.needs_supplier_confirmation ?? 0}</Badge>
                  <Badge variant="secondary" className="border-amber-200 bg-amber-50 text-amber-800">Blocked: {historicalReport.blocked ?? 0}</Badge>
                  <Badge variant={historicalReport.failed ? "destructive" : "outline"}>Failed: {historicalReport.failed}</Badge>
                  <Badge variant="outline">created: {historicalReport.created ?? 0}</Badge>
                  <Badge variant="outline">recovered: {historicalReport.recovered ?? 0}</Badge>
                  <Badge variant="outline">verified: {historicalReport.verified_existing ?? 0}</Badge>
                  <Badge variant="secondary">stale repaired: {historicalReport.stale_repaired ?? 0}</Badge>
                  {Object.entries(historicalReport.reason_breakdown ?? {}).map(([reason, count]) => (
                    <Badge key={reason} variant={reason === "provider_failed" ? "destructive" : "outline"}>
                      {reason.replaceAll("_", " ")}: {count}
                    </Badge>
                  ))}
                </div>
                {!!historicalReport.results?.some((result) => result.status === "failed") && (
                  <div className="mt-3 max-h-32 overflow-y-auto text-xs space-y-1">
                    {historicalReport.results.filter((result) => result.status === "failed").map((result) => (
                      <div key={result.invoice_id} className="text-destructive">
                        Invoice #{result.invoice_id}: {result.error ?? "Provider sync failed"}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}
      {historicalReport?.confirmations && historicalReport.confirmations.length > 0 && (
        <BulkSupplierConfirmationReview
          confirmations={historicalReport.confirmations}
          onCompleted={(result) => {
            setHistoricalReport((current) => {
              if (!current) return current;
              const completedIds = new Set(
                result.results
                  .filter((item) => item.status === "succeeded")
                  .map((item) => item.invoice_id),
              );
              return {
                ...current,
                synced: current.synced + result.synced,
                created: (current.created ?? 0) + result.synced,
                recovered: (current.recovered ?? 0) + result.recovered,
                blocked: (current.blocked ?? 0) + result.blocked,
                failed: current.failed + result.failed,
                needs_supplier_confirmation: result.needs_supplier_confirmation,
                confirmations: current.confirmations?.filter((item) => !completedIds.has(item.invoice_id)),
              };
            });
          }}
        />
      )}
      <OdooIssueQueue
        entityId={selectedEntityId}
        onReview={(issue) => {
          const context = new URLSearchParams();
          context.set("entity_id", String(issue.entity_id));
          setLocation(`/ai-invoice-import/${issue.id}/review?${context.toString()}`);
        }}
      />

      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf,.pdf,image/jpeg,.jpg,.jpeg,image/png,.png,image/webp,.webp"
        multiple
        className="hidden"
        onChange={handleFileInput}
      />
      {(uploading || refreshInterval) && (
        <div className="rounded-lg border bg-muted/20 px-4 py-3 flex items-center gap-3" role="status" data-testid="invoice-processing-panel">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          <div>
            <p className="text-sm font-medium">{uploading ? "Uploading bills…" : "Extracting invoice data…"}</p>
            <p className="text-xs text-muted-foreground">{uploading ? "Files are being secured before processing." : "The queue will refresh as extraction steps complete."}</p>
          </div>
        </div>
      )}
      {uploadFailures.length > 0 && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3" role="alert" data-testid="invoice-upload-failures">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-medium text-destructive">Some bills need attention</p>
              <p className="text-xs text-muted-foreground mt-1">Retry the upload or replace the source from the bill review page.</p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => setUploadFailures([])}>Dismiss</Button>
          </div>
          <ul className="mt-2 space-y-1 text-xs">
            {uploadFailures.map((failure) => (
              <li key={`${failure.filename}-${failure.import_id}`} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{failure.filename}</span>
                <span className="text-muted-foreground">{failure.error}</span>
                {failure.import_id > 0 && <Button variant="link" className="h-auto p-0 text-xs" onClick={() => {
                  const imp = imports.find((item) => item.id === failure.import_id);
                  if (imp) handleImportClick(imp);
                }}>Review / replace</Button>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {dragOver && (
        <div
          className="fixed inset-4 z-40 rounded-xl border-2 border-dashed border-primary bg-background/95 shadow-xl flex items-center justify-center pointer-events-auto"
          onDragOver={(event) => { event.preventDefault(); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
          role="dialog"
          aria-label="Drop supplier bills to upload"
        >
          <div className="text-center">
            <Upload className="h-8 w-8 mx-auto mb-2 text-primary" />
            <p className="font-medium">Drop supplier bills to upload</p>
            <p className="text-sm text-muted-foreground mt-1">PDF, JPG, JPEG, PNG, or WEBP</p>
          </div>
        </div>
      )}

       <div className="flex flex-col gap-3" data-testid="invoice-queue-filters">
         <div className="flex flex-wrap gap-2" role="tablist" aria-label="Supplier bill status">
           {([
             ["all", "All"],
             ["needs_review", "Needs review"],
             ["ready_to_sync", "Ready to sync"],
             ["sync_failed", "Sync failed"],
             ["succeeded", "Synced"],
           ] as const).map(([value, label]) => (
             <Button
               key={value}
               role="tab"
               aria-selected={queueTab === value}
               variant="outline"
               size="sm"
               className={cn(
                 "h-8 rounded-md px-3 font-medium shadow-none",
                 queueTab === value && "border-primary/20 bg-primary/10 text-primary hover:bg-primary/15",
               )}
               data-testid={`tab-invoice-${value}`}
               onClick={() => { setQueueTab(value); setReviewFilter("all"); setSyncFilter("all"); setPage(0); setSelectedInvoiceIds({}); }}
             >
               {label}
               <span className={cn(
                 "ml-1.5 rounded-full bg-muted px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground",
                 queueTab === value && "bg-background/80 text-primary",
               )}>{queueCounts[value] ?? 0}</span>
             </Button>
           ))}
         </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-64 flex-1">
              <FileSearch className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input className="pl-9" id="invoice-search" aria-label="Search invoices" data-testid="input-invoice-search" value={search} placeholder="Search supplier or invoice number" onChange={(event) => { setSearch(event.target.value); setPage(0); }} />
           </div>
            <Select value={selectedEntityId ? String(selectedEntityId) : "all"} onValueChange={(v) => { setSelectedEntityId(v === "all" ? null : parseInt(v, 10)); setPage(0); }}>
              <SelectTrigger className="w-52" data-testid="select-queue-entity"><Building2 className="mr-2 size-4 text-muted-foreground" /><SelectValue placeholder="All entities" /></SelectTrigger>
              <SelectContent><SelectItem value="all">All entities</SelectItem>{entities.map((entity) => <SelectItem key={entity.id} value={String(entity.id)}>{entity.display_name ?? entity.legal_name}</SelectItem>)}</SelectContent>
            </Select>
            <Popover>
              <PopoverTrigger asChild><Button variant="outline" className="w-52 justify-start font-normal"><Clock className="mr-2 size-4 text-muted-foreground" />{dateFrom || dateTo ? `${dateFrom || "Any"} – ${dateTo || "Any"}` : "Invoice date: All dates"}</Button></PopoverTrigger>
              <PopoverContent className="w-72 space-y-3" align="start">
                <div><Label htmlFor="invoice-date-from">From</Label><Input id="invoice-date-from" data-testid="input-invoice-date-from" type="date" value={dateFrom} onChange={(event) => { setDateFrom(event.target.value); setPage(0); }} /></div>
                <div><Label htmlFor="invoice-date-to">To</Label><Input id="invoice-date-to" data-testid="input-invoice-date-to" type="date" value={dateTo} onChange={(event) => { setDateTo(event.target.value); setPage(0); }} /></div>
              </PopoverContent>
            </Popover>
            <Button variant="outline" data-testid="button-more-filters" aria-expanded={showMoreFilters} onClick={() => setShowMoreFilters((open) => !open)}>
             <ChevronDown className={`h-3.5 w-3.5 mr-1 transition-transform ${showMoreFilters ? "rotate-180" : ""}`} />
             More filters
           </Button>
           {(search || dateFrom || dateTo || reviewFilter !== "all" || syncFilter !== "all" || sortOrder !== "created_at_desc") && (
             <Button variant="ghost" size="sm" onClick={() => { setSearch(""); setDateFrom(""); setDateTo(""); setReviewFilter("all"); setSyncFilter("all"); setSortOrder("created_at_desc"); setQueueTab("all"); setPage(0); setSelectedInvoiceIds({}); }}>
               <X className="h-3.5 w-3.5 mr-1" /> Clear
             </Button>
           )}
            <Button variant="outline" size="icon" aria-label="Refresh supplier bills" data-testid="button-refresh-invoice-queue" onClick={() => void refetchImports()} disabled={importsLoading}>
              <RefreshCw className={`h-4 w-4 ${importsLoading ? "animate-spin" : ""}`} />
           </Button>
         </div>
         {showMoreFilters && (
            <div className="flex flex-wrap items-end gap-2 rounded-md border bg-muted/20 p-3">
             <div><Label>Review status</Label><Select value={reviewFilter} onValueChange={(value) => { setReviewFilter(value); setQueueTab("all"); setPage(0); }}><SelectTrigger data-testid="select-review-status" className="w-40"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All reviews</SelectItem><SelectItem value="not_reviewed">Not reviewed</SelectItem><SelectItem value="needs_review">Needs review</SelectItem><SelectItem value="approved">Approved</SelectItem><SelectItem value="rejected">Rejected</SelectItem></SelectContent></Select></div>
             <div><Label>Sync status</Label><Select value={syncFilter} onValueChange={(value) => { setSyncFilter(value as InvoiceQueueFilter); setQueueTab("all"); setPage(0); }}><SelectTrigger data-testid="select-sync-status" className="w-48"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">All sync states</SelectItem><SelectItem value="succeeded">Synced</SelectItem><SelectItem value="failed">Failed</SelectItem><SelectItem value="blocked">Blocked</SelectItem><SelectItem value="needs_supplier_confirmation">Needs supplier confirmation</SelectItem><SelectItem value="not_requested">Not synced</SelectItem><SelectItem value="pending">Syncing</SelectItem><SelectItem value="in_progress">In progress</SelectItem></SelectContent></Select></div>
           </div>
         )}
       </div>
       <div className="grid grid-cols-1 gap-6 rounded-lg border bg-card shadow-sm overflow-hidden" data-testid="supplier-bills-table-card">
        <div>
           <div className="flex min-h-12 items-center justify-between gap-3 border-b px-3">
             <h2 className="text-sm font-semibold" data-testid="text-filtered-total">{total} bill{total === 1 ? "" : "s"}</h2>
            <div className="flex items-center gap-2">
               <Select value={sortOrder} onValueChange={(value) => { setSortOrder(value as typeof sortOrder); setPage(0); }}>
                 <SelectTrigger className="h-8 w-40 border-0 shadow-none" aria-label="Sort supplier bills"><SelectValue /></SelectTrigger>
                 <SelectContent><SelectItem value="created_at_desc">Newest added</SelectItem><SelectItem value="attention_first">Attention first</SelectItem><SelectItem value="invoice_date_desc">Invoice date (newest)</SelectItem><SelectItem value="invoice_date_asc">Invoice date (oldest)</SelectItem></SelectContent>
               </Select>
               {selectedRows.length > 0 && (
                 <div className="text-xs text-muted-foreground hidden sm:block" data-testid="text-selection-summary">
                   {selectedRows.length} selected · {selectedEligible.length} eligible · {selectedIneligible.length} ineligible
                 </div>
               )}
               {selectedImports.length > 0 && (
                 <Button
                   size="sm"
                   data-testid="button-approve-selected"
                   onClick={() => void prepareBulkApproval()}
                   disabled={approvalWorkingId !== null || bulkWorking}
                 >
                   {approvalWorkingId === -1 ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Check className="h-3.5 w-3.5 mr-1" />}
                   Approve selected ({selectedImports.length})
                 </Button>
               )}
               {selectedEligible.length > 0 && (
                <Button
                  size="sm"
                   data-testid="button-sync-selected"
                   onClick={() => void runBulkSync(selectedEligible)}
                   disabled={bulkWorking || approvalWorkingId !== null}
                >
                   {bulkWorking ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Send className="h-3.5 w-3.5 mr-1" />}
                   Sync selected ({selectedEligible.length})
                </Button>
              )}
               {selectedRetryImports.length > 0 && (
                 <Button variant="outline" size="sm" data-testid="button-retry-failed-selected" onClick={() => void runBulkSync(selectedRetryImports)} disabled={bulkWorking}>
                   <RotateCw className="h-3.5 w-3.5 mr-1" /> Retry failed ({selectedRetryImports.length})
                 </Button>
               )}
               <Button variant="ghost" size="sm" onClick={() => { setSelectedInvoiceIds({}); }} disabled={selectedRows.length === 0}>
                 Clear selection
              </Button>
            </div>
          </div>
           {bulkResults.length > 0 && (
             <div className="mb-3 rounded-md border px-3 py-2 text-xs" role="status" data-testid="bulk-results">
               <p className="font-medium mb-1">Latest bulk results</p>
               <div className="flex flex-wrap gap-x-3 gap-y-1">
                 {bulkResults.map((result) => <span key={result.invoice_id} className={result.status === "failed" ? "text-destructive" : "text-emerald-700"}>#{result.invoice_id}: {result.status === "failed" ? result.message : "completed"}</span>)}
               </div>
             </div>
           )}
          {importsLoading ? (
            <div className="flex justify-center py-12">
              <RefreshCw className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : importsError ? (
            <div className="flex flex-col items-center justify-center gap-3 py-12 text-center" role="alert" data-testid="invoice-queue-error">
              <AlertTriangle className="h-8 w-8 text-destructive" />
              <p className="font-medium">Unable to load the invoice queue</p>
              <p className="text-sm text-muted-foreground">{importsQueryError instanceof Error ? importsQueryError.message : "Please try again."}</p>
              <Button variant="outline" onClick={() => refetchImports()}>Retry</Button>
            </div>
          ) : imports.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-center gap-3">
              <FileText className="h-10 w-10 text-muted-foreground/30" />
              {search.trim() ? (
                <p className="text-sm text-muted-foreground" data-testid="invoice-search-empty">No invoices match “{search.trim()}”. Try a different vendor, invoice number, or amount.</p>
              ) : (
                <p className="text-sm text-muted-foreground">No invoices imported yet. Drop a PDF above to get started.</p>
              )}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-muted/50 text-xs text-muted-foreground">
                  <tr>
                    <th className="p-3 w-8">
                      <input
                        type="checkbox"
                        aria-label="Select all supplier bills on this page"
                        checked={imports.length > 0 && imports.every((imp) => selectedInvoiceIds[imp.id] || imp.status === "processing")}
                        onChange={(event) => {
                          const checked = event.target.checked;
                          setSelectedInvoiceIds((current) => ({
                            ...current,
                            ...Object.fromEntries(imports.filter((imp) => imp.status !== "processing").map((imp) => [imp.id, checked])),
                          }));
                        }}
                      />
                    </th>
                    <th className="text-left p-3">Supplier</th>
                    <th className="text-left p-3 hidden sm:table-cell">Invoice #</th>
                    <th className="text-left p-3 hidden md:table-cell">Invoice date</th>
                    <th className="text-right p-3">Amount</th>
                    <th className="text-left p-3">Status</th>
                    <th className="text-left p-3">Issue</th>
                    <th className="text-right p-3">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {imports.map((imp) => {
                    const blockingCount = Number(imp.blocking_issue_count ?? 0);
                    const issueCount = Number(imp.issue_count ?? 0);
                    const displayState = getInvoiceDisplayState(imp);
                    const canSync = displayState === "ready_to_sync" && imp.review_status === "approved" && blockingCount === 0;
                    const canRetry = displayState === "sync_failed" && imp.review_status === "approved";
                    const blockingReason = imp.blocking_issue_messages?.[0] ?? imp.error_message;
                    return (
                    <tr
                      key={imp.id}
                      className="border-t cursor-pointer transition-colors hover:bg-muted/30"
                      onClick={() => handleImportClick(imp)}
                    >
                      <td className="p-3" onClick={(event) => event.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label={`Select invoice ${imp.invoice_number ?? imp.id}`}
                          checked={!!selectedInvoiceIds[imp.id]}
                          disabled={imp.status === "processing" || bulkWorking || approvalWorkingId !== null}
                          onChange={(event) => setSelectedInvoiceIds((current) => ({ ...current, [imp.id]: event.target.checked }))}
                        />
                      </td>
                      <td className="p-3">
                        <p className="font-medium truncate max-w-[220px]" title={imp.supplier_name ?? imp.vendor_name ?? "Unknown"}>{imp.supplier_name ?? imp.vendor_name ?? <span className="text-muted-foreground italic">Unknown</span>}</p>
                        <p className="text-xs text-muted-foreground truncate max-w-[220px]">{imp.entity_display_name ?? getEntityNameByCountry(imp.billing_country, imp.entity_legal_name)}</p>
                      </td>
                      <td className="p-3 hidden sm:table-cell text-muted-foreground max-w-[180px] truncate" title={imp.invoice_number ?? "—"}>{imp.invoice_number ?? "—"}</td>
                      <td className="p-3 hidden md:table-cell text-muted-foreground">{formatDate(imp.invoice_date)}</td>
                      <td className="p-3 text-right font-semibold tabular-nums">
                        {formatCurrency(imp.total_amount, imp.currency)}
                        <span className="block text-[10px] font-normal text-muted-foreground">{imp.currency ?? "—"}</span>
                      </td>
                      <td className="p-3"><StatusBadge status={displayState} config={{
                        processing: { label: "Processing", variant: "secondary", icon: RefreshCw },
                        needs_review: { label: "Needs review", variant: "warning", icon: AlertTriangle },
                        ready_to_sync: { label: "Ready to sync", variant: "success", icon: CheckCircle2 },
                        sync_failed: { label: "Sync failed", variant: "destructive", icon: XCircle },
                        succeeded: { label: "Synced", variant: "success", icon: CheckCircle2, className: SYNCED_BADGE_CLASS_NAME },
                        rejected: { label: "Rejected", variant: "destructive", icon: XCircle },
                      }} />
                      </td>
                      <td className="p-3 text-xs max-w-[220px]">
                        {issueCount > 0 || imp.issue_label ? (
                          <button
                            type="button"
                            className="text-left text-amber-700 hover:underline"
                            title={blockingReason ?? imp.provider_sync_error ?? imp.issue_label ?? "Review issue"}
                            data-testid={`button-invoice-issue-${imp.id}`}
                            onClick={(event) => { event.stopPropagation(); handleImportClick(imp, imp.issue_fields?.[0]); }}
                          >
                            <AlertTriangle className="size-3.5 inline mr-1" />{issueCount > 0 ? `${issueCount} issue${issueCount === 1 ? "" : "s"}` : imp.issue_label}
                          </button>
                        ) : <span className="text-muted-foreground">—</span>}
                        {blockingCount > 0 && <p className="max-w-48 text-[11px] text-destructive truncate" data-testid={`text-blocked-reason-${imp.id}`}>{blockingReason ?? "Resolve blocking issues before approval"}</p>}
                      </td>
                      <td className="p-3 whitespace-nowrap text-right">
                        <div className="flex items-center justify-end gap-2">
                          {displayState === "needs_review" && imp.review_status === "needs_review" && blockingCount === 0 && (
                            <Button
                              size="sm"
                              data-testid={`button-approve-invoice-${imp.id}`}
                              disabled={approvalWorkingId !== null || bulkWorking}
                              onClick={(event) => { event.stopPropagation(); void prepareSingleApproval(imp); }}
                            >
                              {approvalWorkingId === imp.id ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <Check className="h-3.5 w-3.5 mr-1" />}
                              Approve
                            </Button>
                          )}
                          {canSync && (
                            <Button
                              size="sm"
                              data-testid={`button-sync-invoice-${imp.id}`}
                              disabled={bulkWorking || approvalWorkingId !== null}
                              onClick={(event) => {
                                event.stopPropagation();
                                void runBulkSync([imp]);
                              }}
                            >
                              <Send className="h-3.5 w-3.5 mr-1" /> Sync
                            </Button>
                          )}
                          {canRetry && (
                            <Button variant="outline" size="sm" data-testid={`button-retry-invoice-${imp.id}`} disabled={bulkWorking} onClick={(event) => { event.stopPropagation(); void runBulkSync([imp]); }}>
                              <RotateCw className="h-3.5 w-3.5 mr-1" /> Retry
                            </Button>
                          )}
                          <Button
                            variant={displayState === "needs_review" ? "default" : "outline"}
                            size="sm"
                            data-testid={`button-review-invoice-${imp.id}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              handleImportClick(imp);
                            }}
                            >
                            {displayState === "succeeded" && imp.odoo_bill_url ? "View bill" : displayState === "processing" ? "View" : "Review"}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  )})}
                </tbody>
              </table>
            </div>
          )}
           <div className="flex flex-wrap items-center justify-between gap-3 border-t px-3 py-2.5 text-sm">
             <span className="text-muted-foreground" data-testid="text-invoice-result-range">
               {total === 0 ? "Showing 0 of 0" : `Showing ${page * pageSize + 1}–${Math.min((page + 1) * pageSize, total)} of ${total}`}
             </span>
             <div className="flex flex-wrap items-center gap-2">
               <span className="text-muted-foreground">Rows per page</span>
               <Select value={String(pageSize)} onValueChange={(value) => { setPageSize(Number(value)); setPage(0); setSelectedInvoiceIds({}); }}>
                 <SelectTrigger className="h-8 w-20" data-testid="select-invoice-page-size" aria-label="Rows per page"><SelectValue /></SelectTrigger>
                 <SelectContent><SelectItem value="10">10</SelectItem><SelectItem value="25">25</SelectItem><SelectItem value="50">50</SelectItem></SelectContent>
               </Select>
               <Button variant="outline" size="sm" data-testid="button-previous-invoice-page" disabled={page === 0} onClick={() => setPage((current) => Math.max(0, current - 1))}>Previous</Button>
               <Button size="sm" data-testid="button-next-invoice-page" disabled={(page + 1) * pageSize >= total} onClick={() => setPage((current) => current + 1)}>Next <ChevronRight className="ml-1 size-4" /></Button>
             </div>
           </div>
        </div>

      </div>
    </div>
  );
}

export function getInvoiceDisplayState(invoice: Pick<InvoiceImport, "display_state" | "status" | "processing_step" | "review_status" | "sync_status" | "blocking_issue_count">): InvoiceQueueTab | "processing" | "rejected" {
  if (invoice.display_state) return invoice.display_state;
  if (invoice.status === "uploaded" || invoice.status === "processing" || ["source_storage", "converting", "reading", "extracting"].includes(invoice.processing_step ?? "")) return "processing";
  if (invoice.review_status === "rejected") return "rejected";
  if (Number(invoice.blocking_issue_count ?? 0) > 0 || invoice.review_status === "needs_review" || invoice.review_status === "not_reviewed") return "needs_review";
  if (invoice.sync_status === "failed") return "sync_failed";
  if (invoice.review_status === "approved" && ["pending", "in_progress"].includes(invoice.sync_status ?? "")) return "processing";
  if (invoice.review_status === "approved" && invoice.sync_status === "succeeded") return "succeeded";
  if (invoice.review_status === "approved" && (invoice.sync_status ?? "not_requested") === "not_requested") return "ready_to_sync";
  return "needs_review";
}
